import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import type { Store, Row } from "./store.js";
import { isPublicAddress } from "./adapters.js";

// Social accounts, connected the way schedulers such as Postiz do it: the operator registers one
// app per platform (its client ID and secret in the server's .env), and people click Connect,
// sign in on the platform's own page and approve. Each account becomes a stored API (kind "apis")
// whose key is the account's access token, so agents reach it with orbytlink__api_docs and
// orbytlink__api_request like any other API, and the gateway refreshes the token before it lapses.

export type Account = { id: string; name: string; handle?: string; token?: string; expiresAt?: number | null; note: string };
type Tokens = { access: string; refresh?: string; expiresAt: number | null; scope?: string; extra: Record<string, unknown> };
type Endpoint = { method: string; path: string; summary: string };
export type Provider = {
  id: string;
  name: string;
  // .env names: <ENV>_CLIENT_ID and <ENV>_CLIENT_SECRET.
  env: string;
  // Keys to fall back on when this platform's own aren't set (Instagram signs in with the Facebook app).
  envFallback?: string;
  authorizeUrl: string;
  tokenUrl: string;
  tokenMethod?: "POST" | "GET";
  tokenAuth: "body" | "basic";
  clientIdParam?: string;
  scopes: string[];
  scopeSep: " " | ",";
  pkce: boolean;
  authParams?: Record<string, string>;
  // Hosts the sign-in and API calls go to; allowed whatever OUTBOUND_HOSTS says.
  hosts: string[];
  api: { baseUrl: string; auth: "bearer" | "query"; authName?: string; headers?: () => Record<string, string>; bodyFormat: "json" | "form" };
  // A short-lived token traded for a long-lived one, where the platform has that step.
  longLived?: (t: Tokens, p: Provider) => Promise<Tokens>;
  refresh: "standard" | "instagram" | "threads" | "none";
  accounts: (t: Tokens) => Promise<Account[]>;
  docsUrl: string;
  guide: string;
  endpoints: Endpoint[];
  note: string;
};

const UA = () => process.env.SOCIAL_USER_AGENT || "web:orbytlink:1.0";
const graph = "v23.0";
// LinkedIn's versioned API wants a YYYYMM version it still supports: two months back is safe.
const linkedinVersion = () => {
  if (process.env.LINKEDIN_API_VERSION) return process.env.LINKEDIN_API_VERSION;
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 2);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

export const clientId = (p: Provider) => process.env[`${p.env}_CLIENT_ID`] || (p.envFallback ? process.env[`${p.envFallback}_CLIENT_ID`] : "") || "";
const clientSecret = (p: Provider) => process.env[`${p.env}_CLIENT_SECRET`] || (p.envFallback ? process.env[`${p.envFallback}_CLIENT_SECRET`] : "") || "";
export const providerConfigured = (p: Provider) => !!clientId(p) && !!clientSecret(p);

const fail = (message: string, status = 409) => Object.assign(new Error(message), { status });

// Every request goes only to the platform's own hosts, over HTTPS, to public addresses.
async function guard(url: string, p: Provider) {
  const u = new URL(url);
  if (u.protocol !== "https:" || u.username || u.password || !p.hosts.includes(u.hostname)) throw fail(`${p.name}: unexpected address ${u.hostname}.`);
  const literal = u.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(literal) ? [{ address: literal }] : await lookup(u.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw fail("Private and reserved destinations are blocked");
}
export async function send(p: Provider, url: string, init: RequestInit = {}) {
  await guard(url, p);
  try {
    const r = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: { Accept: "application/json", "User-Agent": UA(), ...(init.headers as Record<string, string>) },
    });
    const text = (await r.text()).slice(0, 500_000);
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { ok: r.ok, status: r.status, json };
  } catch {
    throw fail(`${p.name} could not be reached.`);
  }
}
const getJson = async (p: Provider, url: string, token?: string, headers: Record<string, string> = {}) => {
  const r = await send(p, url, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } });
  if (!r.ok) throw Object.assign(fail(`${p.name} answered HTTP ${r.status}.`), { oauthError: String(r.json?.error?.message || r.json?.error || r.status) });
  return r.json;
};

function readTokens(j: any): Tokens {
  // Instagram wraps the first answer in data[]; Slack-style nesting doesn't occur here.
  const d = Array.isArray(j?.data) ? j.data[0] : j;
  const access = d?.access_token;
  if (typeof access !== "string" || !access) throw Object.assign(fail("Token request failed"), { oauthError: String(j?.error_description || j?.error?.message || j?.error || "no_token") });
  const life = Number(d.expires_in);
  return {
    access,
    refresh: typeof d.refresh_token === "string" && d.refresh_token ? d.refresh_token : undefined,
    expiresAt: Number.isFinite(life) && life > 0 ? Date.now() + life * 1000 : null,
    scope: typeof d.scope === "string" ? d.scope : Array.isArray(d.permissions) ? d.permissions.join(",") : undefined,
    extra: d,
  };
}
async function tokenRequest(p: Provider, params: Record<string, string>): Promise<Tokens> {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = {};
  if (p.tokenAuth === "basic") headers.Authorization = `Basic ${Buffer.from(`${clientId(p)}:${clientSecret(p)}`).toString("base64")}`;
  else {
    body.set(p.clientIdParam || "client_id", clientId(p));
    body.set("client_secret", clientSecret(p));
  }
  const r =
    p.tokenMethod === "GET"
      ? await send(p, `${p.tokenUrl}?${body}`, { headers })
      : await send(p, p.tokenUrl, { method: "POST", headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
  if (!r.ok) throw Object.assign(fail("Token request failed"), { oauthError: String(r.json?.error?.message || r.json?.error || r.status) });
  return readTokens(r.json);
}

// ── The platforms ────────────────────────────────────────────────────────────
const linkedinApi = { baseUrl: "https://api.linkedin.com", auth: "bearer" as const, headers: () => ({ "LinkedIn-Version": linkedinVersion(), "X-Restli-Protocol-Version": "2.0.0" }), bodyFormat: "json" as const };
const linkedinMe = async (t: Tokens, p: Provider) => {
  const me = await getJson(p, "https://api.linkedin.com/v2/userinfo", t.access);
  return { id: String(me.sub), name: String(me.name || me.given_name || "LinkedIn member"), email: me.email as string | undefined };
};

export const providers: Provider[] = [
  {
    id: "linkedin",
    name: "LinkedIn",
    env: "LINKEDIN",
    authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    tokenAuth: "body",
    scopes: ["openid", "profile", "email", "w_member_social"],
    scopeSep: " ",
    pkce: false,
    hosts: ["www.linkedin.com", "api.linkedin.com"],
    api: linkedinApi,
    refresh: "standard",
    async accounts(t) {
      const me = await linkedinMe(t, this);
      return [{ id: me.id, name: me.name, handle: me.email, note: `Your LinkedIn member URN is urn:li:person:${me.id}; use it as the author of posts.` }];
    },
    docsUrl: "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api",
    note: "Post as yourself. Reading other people's profiles, feeds or messages isn't offered by LinkedIn.",
    endpoints: [
      { method: "GET", path: "/v2/userinfo", summary: "Your member id (sub), name, email and photo" },
      { method: "POST", path: "/rest/posts", summary: "Publish a post (text, link or article) as you" },
      { method: "DELETE", path: "/rest/posts/{postUrn}", summary: "Delete one of your posts (URL-encode the URN)" },
      { method: "POST", path: "/rest/socialActions/{postUrn}/comments", summary: "Comment on a post" },
    ],
    guide: `Post text as yourself: POST /rest/posts with JSON
{"author":"urn:li:person:<id>","commentary":"Your text","visibility":"PUBLIC","distribution":{"feedDistribution":"MAIN_FEED","targetEntities":[],"thirdPartyDistributionChannels":[]},"lifecycleState":"PUBLISHED","isReshareDisabledByAuthor":false}
A 201 reply means it is live; the new post's URN is in LinkedIn's x-restli-id header.
Share a link: add "content":{"article":{"source":"https://example.com/page","title":"Title","description":"Optional"}}.
Comment: POST /rest/socialActions/<url-encoded post URN>/comments with {"actor":"urn:li:person:<id>","object":"<post URN>","message":{"text":"..."}}.
Images and video need a binary upload, which this connection can't do; post text and links.
LinkedIn doesn't let apps read other members' profiles, feeds, connections or messages.`,
  },
  {
    id: "linkedin-page",
    name: "LinkedIn Page",
    env: "LINKEDIN",
    authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    tokenAuth: "body",
    scopes: ["openid", "profile", "w_organization_social", "r_organization_social", "rw_organization_admin"],
    scopeSep: " ",
    pkce: false,
    hosts: ["www.linkedin.com", "api.linkedin.com"],
    api: linkedinApi,
    refresh: "standard",
    async accounts(t) {
      const me = await linkedinMe(t, this);
      const acl = await getJson(this, "https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED", t.access, linkedinApi.headers()).catch(() => ({ elements: [] }));
      const orgs = (acl.elements || []).map((e: any) => String(e.organization || "")).filter(Boolean);
      return [{ id: me.id, name: me.name, note: `Pages you administer: ${orgs.length ? orgs.join(", ") : "none found yet"}. Post with a page's URN (urn:li:organization:<id>) as the author.` }];
    },
    docsUrl: "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations",
    note: "Post to company pages you administer. Needs LinkedIn's approval for the Community Management API.",
    endpoints: [
      { method: "GET", path: "/rest/organizationAcls", summary: "Pages you administer (q=roleAssignee, role=ADMINISTRATOR, state=APPROVED)" },
      { method: "GET", path: "/rest/organizations/{id}", summary: "A page's details" },
      { method: "POST", path: "/rest/posts", summary: "Publish a post as a page" },
      { method: "GET", path: "/rest/organizationalEntityShareStatistics", summary: "A page's post statistics (q=organizationalEntity)" },
      { method: "GET", path: "/rest/networkSizes/{organizationUrn}", summary: "Follower count (edgeType=COMPANY_FOLLOWED_BY_MEMBER)" },
    ],
    guide: `Post as a page: POST /rest/posts with JSON
{"author":"urn:li:organization:<id>","commentary":"Your text","visibility":"PUBLIC","distribution":{"feedDistribution":"MAIN_FEED","targetEntities":[],"thirdPartyDistributionChannels":[]},"lifecycleState":"PUBLISHED","isReshareDisabledByAuthor":false}
Find your pages: GET /rest/organizationAcls with query q=roleAssignee, role=ADMINISTRATOR, state=APPROVED.
Statistics: GET /rest/organizationalEntityShareStatistics with q=organizationalEntity and organizationalEntity=urn:li:organization:<id>.
Followers: GET /rest/networkSizes/urn%3Ali%3Aorganization%3A<id> with edgeType=COMPANY_FOLLOWED_BY_MEMBER.`,
  },
  {
    id: "facebook",
    name: "Facebook Pages",
    env: "FACEBOOK",
    authorizeUrl: `https://www.facebook.com/${graph}/dialog/oauth`,
    tokenUrl: `https://graph.facebook.com/${graph}/oauth/access_token`,
    tokenMethod: "GET",
    tokenAuth: "body",
    scopes: ["pages_show_list", "business_management", "pages_manage_posts", "pages_manage_engagement", "pages_read_engagement", "read_insights"],
    scopeSep: ",",
    pkce: false,
    hosts: ["www.facebook.com", "graph.facebook.com"],
    api: { baseUrl: `https://graph.facebook.com/${graph}`, auth: "query", authName: "access_token", bodyFormat: "form" },
    // A long-lived user token; the page tokens taken from it don't expire.
    async longLived(t, p) {
      return tokenRequest(p, { grant_type: "fb_exchange_token", fb_exchange_token: t.access });
    },
    refresh: "none",
    async accounts(t) {
      const r = await getJson(this, `https://graph.facebook.com/${graph}/me/accounts?fields=id,name,access_token,category&limit=100&access_token=${encodeURIComponent(t.access)}`);
      return (r.data || [])
        .filter((pg: any) => pg?.id && pg?.access_token)
        .map((pg: any) => ({ id: String(pg.id), name: String(pg.name || pg.id), token: String(pg.access_token), expiresAt: null, note: `Page id ${pg.id}; use it in paths such as /${pg.id}/feed.` }));
    },
    docsUrl: "https://developers.facebook.com/docs/pages-api/posts",
    note: "Post, reply to comments and read insights for Pages you manage. Each Page connects as its own account.",
    endpoints: [
      { method: "GET", path: "/{page-id}", summary: "Page details (fields=name,fan_count,followers_count)" },
      { method: "POST", path: "/{page-id}/feed", summary: "Publish a post (message, optional link)" },
      { method: "POST", path: "/{page-id}/photos", summary: "Publish a photo from a public URL (url, message)" },
      { method: "GET", path: "/{page-id}/posts", summary: "The Page's posts (fields=id,message,created_time,permalink_url)" },
      { method: "GET", path: "/{post-id}/comments", summary: "Comments on a post" },
      { method: "POST", path: "/{comment-or-post-id}/comments", summary: "Reply (message)" },
      { method: "GET", path: "/{page-id}/insights", summary: "Page insights (metric, period)" },
      { method: "DELETE", path: "/{post-id}", summary: "Delete a post" },
    ],
    guide: `Bodies are form fields. Post text: POST /<page-id>/feed with {"message":"Hello"}; add "link" to share a URL. Schedule: add "published":false and "scheduled_publish_time":<unix time 10 min to 30 days ahead>.
Photo: POST /<page-id>/photos with {"url":"https://public.example/image.jpg","message":"Caption"}.
List posts: GET /<page-id>/posts with fields=id,message,created_time,permalink_url.
Comments: GET /<post-id>/comments; reply with POST /<post-id or comment-id>/comments {"message":"..."}.
Insights: GET /<page-id>/insights with metric (e.g. page_post_engagements) and period=day.`,
  },
  {
    // Instagram through Facebook Login (Meta's "Instagram API with Facebook Login"): one Facebook
    // sign-in, with the Facebook app's keys, reaches every Instagram professional account linked to a
    // Page the person manages. Each linked account connects on its own and is called with its Page's
    // token, which doesn't expire.
    id: "instagram",
    name: "Instagram",
    env: "INSTAGRAM",
    envFallback: "FACEBOOK",
    authorizeUrl: `https://www.facebook.com/${graph}/dialog/oauth`,
    tokenUrl: `https://graph.facebook.com/${graph}/oauth/access_token`,
    tokenMethod: "GET",
    tokenAuth: "body",
    scopes: ["instagram_basic", "instagram_content_publish", "instagram_manage_comments", "instagram_manage_insights", "pages_show_list", "pages_read_engagement", "business_management"],
    scopeSep: ",",
    pkce: false,
    hosts: ["www.facebook.com", "graph.facebook.com"],
    api: { baseUrl: `https://graph.facebook.com/${graph}`, auth: "query", authName: "access_token", bodyFormat: "form" },
    async longLived(t, p) {
      return tokenRequest(p, { grant_type: "fb_exchange_token", fb_exchange_token: t.access });
    },
    refresh: "none",
    async accounts(t) {
      const r = await getJson(this, `https://graph.facebook.com/${graph}/me/accounts?fields=id,name,access_token,instagram_business_account%7Bid,username,name%7D&limit=100&access_token=${encodeURIComponent(t.access)}`);
      return (r.data || [])
        .filter((pg: any) => pg?.access_token && pg?.instagram_business_account?.id)
        .map((pg: any) => {
          const ig = pg.instagram_business_account;
          return { id: String(ig.id), name: String(ig.name || ig.username || "Instagram account"), handle: ig.username ? `@${ig.username}` : undefined, token: String(pg.access_token), expiresAt: null, note: `Instagram user id ${ig.id}, linked to the Page "${pg.name}"; use it in paths such as /${ig.id}/media.` };
        });
    },
    docsUrl: "https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/content-publishing",
    note: "A professional (business or creator) account linked to a Facebook Page you manage. Publish photos, reels and carousels, reply to comments and read insights.",
    endpoints: [
      { method: "GET", path: "/{ig-user-id}", summary: "Your account (fields=username,name,followers_count,media_count)" },
      { method: "POST", path: "/{ig-user-id}/media", summary: "Create a media container (image_url or video_url, caption)" },
      { method: "POST", path: "/{ig-user-id}/media_publish", summary: "Publish a container (creation_id)" },
      { method: "GET", path: "/{container-id}", summary: "Container status (fields=status_code)" },
      { method: "GET", path: "/{ig-user-id}/media", summary: "Your posts (fields=id,caption,media_type,permalink,timestamp,like_count,comments_count)" },
      { method: "GET", path: "/{media-id}/comments", summary: "Comments on a post" },
      { method: "POST", path: "/{comment-id}/replies", summary: "Reply to a comment (message)" },
      { method: "GET", path: "/{media-id}/insights", summary: "Post insights (metric=reach,likes,comments,saved,shares)" },
    ],
    guide: `Publishing is two calls. Bodies are form fields; media must be at a public URL. Use your Instagram user id (in this account's description), not /me.
1. POST /<ig-user-id>/media with {"image_url":"https://public.example/photo.jpg","caption":"Text #tags"}. For a reel: {"media_type":"REELS","video_url":"https://...mp4","caption":"..."}.
2. For video, poll GET /<container-id> with fields=status_code until FINISHED.
3. POST /<ig-user-id>/media_publish with {"creation_id":"<container id>"}.
Carousel: create each item with "is_carousel_item":true, then a container with {"media_type":"CAROUSEL","children":"<id1>,<id2>","caption":"..."}, then publish it.
Limit: 100 published posts per 24 hours.`,
  },
  {
    id: "threads",
    name: "Threads",
    env: "THREADS",
    authorizeUrl: "https://threads.net/oauth/authorize",
    tokenUrl: "https://graph.threads.net/oauth/access_token",
    tokenAuth: "body",
    scopes: ["threads_basic", "threads_content_publish", "threads_manage_replies", "threads_read_replies", "threads_manage_insights"],
    scopeSep: ",",
    pkce: false,
    hosts: ["threads.net", "www.threads.net", "graph.threads.net"],
    api: { baseUrl: "https://graph.threads.net/v1.0", auth: "query", authName: "access_token", bodyFormat: "form" },
    async longLived(t, p) {
      const j = await getJson(p, `https://graph.threads.net/access_token?grant_type=th_exchange_token&client_secret=${encodeURIComponent(clientSecret(p))}&access_token=${encodeURIComponent(t.access)}`);
      return { ...readTokens(j), extra: t.extra };
    },
    refresh: "threads",
    async accounts(t) {
      const me = await getJson(this, `https://graph.threads.net/v1.0/me?fields=id,username,name&access_token=${encodeURIComponent(t.access)}`);
      return [{ id: String(me.id), name: String(me.name || me.username || "Threads account"), handle: me.username ? `@${me.username}` : undefined, note: "Use /me in paths for your own account." }];
    },
    docsUrl: "https://developers.facebook.com/docs/threads/posts",
    note: "Publish posts and replies, and read replies and insights.",
    endpoints: [
      { method: "GET", path: "/me", summary: "Your profile (fields=id,username,name,threads_biography)" },
      { method: "POST", path: "/me/threads", summary: "Create a post container (media_type, text, image_url, reply_to_id)" },
      { method: "POST", path: "/me/threads_publish", summary: "Publish a container (creation_id)" },
      { method: "GET", path: "/me/threads", summary: "Your posts (fields=id,text,permalink,timestamp)" },
      { method: "GET", path: "/{media-id}/replies", summary: "Replies to a post" },
      { method: "GET", path: "/{media-id}/insights", summary: "Post insights (metric=views,likes,replies,reposts,quotes)" },
    ],
    guide: `Publishing is two calls; bodies are form fields.
1. POST /me/threads with {"media_type":"TEXT","text":"Hello"} (or "IMAGE" with "image_url", "VIDEO" with "video_url"). To reply, add "reply_to_id":"<post id>".
2. POST /me/threads_publish with {"creation_id":"<container id>"}. For images and video wait about 30 seconds between the two.
Limit: 250 posts per 24 hours.`,
  },
  {
    id: "youtube",
    name: "YouTube",
    env: "YOUTUBE",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    tokenAuth: "body",
    scopes: ["https://www.googleapis.com/auth/youtube.force-ssl"],
    scopeSep: " ",
    pkce: true,
    authParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    hosts: ["accounts.google.com", "oauth2.googleapis.com", "www.googleapis.com"],
    api: { baseUrl: "https://www.googleapis.com/youtube/v3", auth: "bearer", bodyFormat: "json" },
    refresh: "standard",
    async accounts(t) {
      const r = await getJson(this, "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", t.access);
      const c = r.items?.[0];
      if (!c) throw fail("This Google account has no YouTube channel.");
      return [{ id: String(c.id), name: String(c.snippet?.title || "YouTube channel"), handle: c.snippet?.customUrl, note: `Your channel id is ${c.id}.` }];
    },
    docsUrl: "https://developers.google.com/youtube/v3/docs",
    note: "Manage your channel's videos, playlists and comments. Uploading video files isn't supported.",
    endpoints: [
      { method: "GET", path: "/channels", summary: "Your channel (part=snippet,statistics, mine=true)" },
      { method: "GET", path: "/search", summary: "Your videos (part=snippet, forMine=true, type=video)" },
      { method: "GET", path: "/videos", summary: "Video details (part=snippet,statistics, id)" },
      { method: "PUT", path: "/videos", summary: "Update a video's title, description or tags (part=snippet)" },
      { method: "GET", path: "/commentThreads", summary: "Comments on a video (part=snippet, videoId)" },
      { method: "POST", path: "/comments", summary: "Reply to a comment (part=snippet)" },
      { method: "GET", path: "/playlists", summary: "Your playlists (part=snippet, mine=true)" },
      { method: "POST", path: "/playlistItems", summary: "Add a video to a playlist (part=snippet)" },
    ],
    guide: `Every call takes part= (e.g. part=snippet,statistics).
Update a video: PUT /videos with part=snippet and {"id":"<video id>","snippet":{"title":"...","description":"...","categoryId":"22"}} (categoryId is required).
Reply to a comment: POST /comments with part=snippet and {"snippet":{"parentId":"<comment id>","textOriginal":"..."}}.
New top-level comment: POST /commentThreads with part=snippet and {"snippet":{"videoId":"<id>","topLevelComment":{"snippet":{"textOriginal":"..."}}}}.
Uploading video files needs a binary upload, which this connection can't do.`,
  },
  {
    // Google ships no Search Console MCP server, but the API is official, so it connects like
    // YouTube does: the same Google OAuth client, a different scope.
    id: "google-search-console",
    name: "Google Search Console",
    env: "GOOGLE_SEARCH_CONSOLE",
    envFallback: "YOUTUBE",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    tokenAuth: "body",
    scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
    scopeSep: " ",
    pkce: true,
    authParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    hosts: ["accounts.google.com", "oauth2.googleapis.com", "www.googleapis.com"],
    api: { baseUrl: "https://www.googleapis.com/webmasters/v3", auth: "bearer", bodyFormat: "json" },
    refresh: "standard",
    async accounts(t) {
      const r = await getJson(this, "https://www.googleapis.com/webmasters/v3/sites", t.access);
      const sites: { siteUrl?: string; permissionLevel?: string }[] = Array.isArray(r.siteEntry) ? r.siteEntry : [];
      if (!sites.length) throw fail("This Google account has no Search Console properties.");
      return sites.map((s) => ({
        id: String(s.siteUrl),
        name: String(s.siteUrl),
        note: `Permission: ${s.permissionLevel || "unknown"}. Put ${encodeURIComponent(String(s.siteUrl))} in the path where {siteUrl} appears.`,
      }));
    },
    docsUrl: "https://developers.google.com/webmaster-tools/v1/searchanalytics/query",
    note: "Read your site's search performance: queries, pages, clicks, impressions and average position. Read-only.",
    endpoints: [
      { method: "GET", path: "/sites", summary: "Properties this account can read" },
      { method: "POST", path: "/sites/{siteUrl}/searchAnalytics/query", summary: "Search performance rows (startDate, endDate, dimensions, rowLimit)" },
      { method: "GET", path: "/sites/{siteUrl}/sitemaps", summary: "Submitted sitemaps and their status" },
    ],
    guide: `{siteUrl} is URL-encoded: a Domain property is sc-domain%3Aexample.com, a URL-prefix property is https%3A%2F%2Fexample.com%2F.
Search performance: POST /sites/{siteUrl}/searchAnalytics/query with {"startDate":"2026-10-01","endDate":"2026-11-20","dimensions":["query","page"],"rowLimit":1000}.
Dimensions: query, page, country, device, date. Rows carry clicks, impressions, ctr and position.
Data lags 2-3 days and reaches back about 16 months; a request returns at most 25,000 rows (page with startRow).`,
  },
  {
    id: "tiktok",
    name: "TikTok",
    env: "TIKTOK",
    authorizeUrl: "https://www.tiktok.com/v2/auth/authorize/",
    tokenUrl: "https://open.tiktokapis.com/v2/oauth/token/",
    tokenAuth: "body",
    clientIdParam: "client_key",
    scopes: ["user.info.basic", "user.info.profile", "user.info.stats", "video.list", "video.publish", "video.upload"],
    scopeSep: ",",
    pkce: false,
    hosts: ["www.tiktok.com", "open.tiktokapis.com"],
    api: { baseUrl: "https://open.tiktokapis.com/v2", auth: "bearer", bodyFormat: "json" },
    refresh: "standard",
    async accounts(t) {
      const r = await getJson(this, "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,username", t.access);
      const u = r.data?.user || {};
      return [{ id: String(u.open_id || t.extra.open_id || ""), name: String(u.display_name || u.username || "TikTok account"), handle: u.username ? `@${u.username}` : undefined, note: "Until TikTok audits the app, posts can only be private (SELF_ONLY)." }];
    },
    docsUrl: "https://developers.tiktok.com/doc/content-posting-api-reference-direct-post",
    note: "Post videos and photos from public URLs and read your stats. Posts stay private until TikTok audits the app.",
    endpoints: [
      { method: "GET", path: "/user/info/", summary: "Your profile and stats (fields=open_id,display_name,follower_count,likes_count,video_count)" },
      { method: "POST", path: "/post/publish/creator_info/query/", summary: "Allowed privacy levels and limits; call before posting" },
      { method: "POST", path: "/post/publish/video/init/", summary: "Post a video from a public URL" },
      { method: "POST", path: "/post/publish/content/init/", summary: "Post photos from public URLs" },
      { method: "POST", path: "/post/publish/status/fetch/", summary: "Status of a post (publish_id)" },
      { method: "POST", path: "/video/list/", summary: "Your videos (fields in the query, max_count in the body)" },
    ],
    guide: `Before posting, POST /post/publish/creator_info/query/ and use one of the privacy levels it returns.
Video: POST /post/publish/video/init/ with {"post_info":{"title":"Caption #tags","privacy_level":"SELF_ONLY"},"source_info":{"source":"PULL_FROM_URL","video_url":"https://verified-domain.example/video.mp4"}}. The URL's domain must be verified in the TikTok app settings.
Photos: POST /post/publish/content/init/ with {"post_info":{"title":"...","privacy_level":"SELF_ONLY"},"source_info":{"source":"PULL_FROM_URL","photo_images":["https://..."],"photo_cover_index":0},"post_mode":"DIRECT_POST","media_type":"PHOTO"}.
Then check POST /post/publish/status/fetch/ with {"publish_id":"..."}.
Until TikTok audits the app, only SELF_ONLY (private) works.`,
  },
  {
    id: "reddit",
    name: "Reddit",
    env: "REDDIT",
    authorizeUrl: "https://www.reddit.com/api/v1/authorize",
    tokenUrl: "https://www.reddit.com/api/v1/access_token",
    tokenAuth: "basic",
    scopes: ["identity", "read", "submit", "edit", "history", "mysubreddits", "vote"],
    scopeSep: " ",
    pkce: false,
    authParams: { duration: "permanent" },
    hosts: ["www.reddit.com", "oauth.reddit.com"],
    api: { baseUrl: "https://oauth.reddit.com", auth: "bearer", headers: () => ({ "User-Agent": UA() }), bodyFormat: "form" },
    refresh: "standard",
    async accounts(t) {
      const me = await getJson(this, "https://oauth.reddit.com/api/v1/me", t.access);
      return [{ id: String(me.id), name: String(me.name), handle: `u/${me.name}`, note: "Read subreddits, post and comment as this account." }];
    },
    docsUrl: "https://www.reddit.com/dev/api/",
    note: "Read subreddits, post and comment. Commercial use needs Reddit's approval.",
    endpoints: [
      { method: "GET", path: "/api/v1/me", summary: "Your account" },
      { method: "GET", path: "/r/{subreddit}/hot", summary: "Hot posts (limit)" },
      { method: "GET", path: "/r/{subreddit}/new", summary: "New posts (limit)" },
      { method: "GET", path: "/r/{subreddit}/about/rules", summary: "A subreddit's rules" },
      { method: "GET", path: "/search", summary: "Search posts (q, sort, t, limit)" },
      { method: "GET", path: "/comments/{post-id}", summary: "A post and its comments" },
      { method: "POST", path: "/api/submit", summary: "Submit a post (sr, kind, title, text or url)" },
      { method: "POST", path: "/api/comment", summary: "Comment or reply (thing_id, text)" },
    ],
    guide: `Bodies are form fields; add "api_type":"json" to get JSON errors.
Post: POST /api/submit with {"sr":"subreddit","kind":"self","title":"...","text":"...","api_type":"json"}; for a link use "kind":"link" and "url".
Comment: POST /api/comment with {"thing_id":"t3_<post id>","text":"...","api_type":"json"} (t1_ for a comment).
Read a subreddit's rules before posting there: GET /r/<name>/about/rules.`,
  },
  {
    id: "pinterest",
    name: "Pinterest",
    env: "PINTEREST",
    authorizeUrl: "https://www.pinterest.com/oauth/",
    tokenUrl: "https://api.pinterest.com/v5/oauth/token",
    tokenAuth: "basic",
    scopes: ["boards:read", "boards:write", "pins:read", "pins:write", "user_accounts:read"],
    scopeSep: ",",
    pkce: false,
    hosts: ["www.pinterest.com", "api.pinterest.com"],
    api: { baseUrl: "https://api.pinterest.com/v5", auth: "bearer", bodyFormat: "json" },
    refresh: "standard",
    async accounts(t) {
      const me = await getJson(this, "https://api.pinterest.com/v5/user_account", t.access);
      return [{ id: String(me.id || me.username), name: String(me.business_name || me.username || "Pinterest account"), handle: me.username, note: "Create pins on your boards and read their analytics." }];
    },
    docsUrl: "https://developers.pinterest.com/docs/api/v5/",
    note: "Create pins and boards and read analytics. Pins stay visible only to you until Pinterest grants standard access.",
    endpoints: [
      { method: "GET", path: "/user_account", summary: "Your account" },
      { method: "GET", path: "/boards", summary: "Your boards" },
      { method: "POST", path: "/boards", summary: "Create a board (name, description, privacy)" },
      { method: "POST", path: "/pins", summary: "Create a pin from a public image URL" },
      { method: "GET", path: "/boards/{board_id}/pins", summary: "Pins on a board" },
      { method: "GET", path: "/pins/{pin_id}", summary: "A pin (pin_metrics=true for stats)" },
      { method: "GET", path: "/user_account/analytics", summary: "Account analytics (start_date, end_date)" },
    ],
    guide: `Create a pin: POST /pins with {"board_id":"<id>","title":"...","description":"...","link":"https://destination.example","media_source":{"source_type":"image_url","url":"https://public.example/image.jpg"}}.
Find board ids with GET /boards.`,
  },
  {
    id: "x",
    name: "X",
    env: "X",
    authorizeUrl: "https://x.com/i/oauth2/authorize",
    tokenUrl: "https://api.x.com/2/oauth2/token",
    tokenAuth: "basic",
    scopes: ["tweet.read", "tweet.write", "users.read", "offline.access", "media.write"],
    scopeSep: " ",
    pkce: true,
    hosts: ["x.com", "api.x.com"],
    api: { baseUrl: "https://api.x.com/2", auth: "bearer", bodyFormat: "json" },
    refresh: "standard",
    async accounts(t) {
      const me = await getJson(this, "https://api.x.com/2/users/me", t.access);
      const u = me.data || {};
      return [{ id: String(u.id), name: String(u.name || u.username), handle: u.username ? `@${u.username}` : undefined, note: `Your X user id is ${u.id}.` }];
    },
    docsUrl: "https://docs.x.com/x-api/introduction",
    note: "Post, reply and read. X bills API use to the operator's developer account.",
    endpoints: [
      { method: "GET", path: "/users/me", summary: "Your account (user.fields=public_metrics,description)" },
      { method: "POST", path: "/tweets", summary: "Post (text; reply.in_reply_to_tweet_id to reply)" },
      { method: "DELETE", path: "/tweets/{id}", summary: "Delete a post" },
      { method: "GET", path: "/users/{id}/tweets", summary: "A user's posts (max_results, tweet.fields)" },
      { method: "GET", path: "/tweets/search/recent", summary: "Search the last 7 days (query)" },
    ],
    guide: `Post: POST /tweets with {"text":"Hello"}. Reply: {"text":"...","reply":{"in_reply_to_tweet_id":"<id>"}}.
Each call is billed to the X developer account, so avoid needless reads.`,
  },
];
export const providerById = (id: string) => providers.find((p) => p.id === id);
const hostOf = (url: string) => new URL(url).hostname;
// The hosts a stored social account may call: its platform's API host only.
export const channelHosts = (api: Row): string[] => {
  const p = api.channel && providerById(api.channel.provider);
  return p ? [hostOf(p.api.baseUrl)] : [];
};

// ── The sign-in ──────────────────────────────────────────────────────────────
export function authorizeUrl(p: Provider, redirect: string, state: string, challenge: string) {
  const u = new URL(p.authorizeUrl);
  const params: Record<string, string> = {
    ...(p.authParams || {}),
    response_type: "code",
    [p.clientIdParam || "client_id"]: clientId(p),
    redirect_uri: redirect,
    state,
    scope: p.scopes.join(p.scopeSep),
  };
  if (p.pkce) Object.assign(params, { code_challenge: challenge, code_challenge_method: "S256" });
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

// The code becomes tokens, then one stored API per account (a Facebook login brings each Page).
export async function finishChannel(store: Store, w: string, providerId: string, code: string, redirect: string, verifier: string) {
  const p = providerById(providerId);
  if (!p || !providerConfigured(p)) throw fail("This platform isn't set up on this server.");
  let t = await tokenRequest(p, { grant_type: "authorization_code", code, redirect_uri: redirect, ...(p.pkce ? { code_verifier: verifier } : {}) });
  if (p.longLived) t = await p.longLived(t, p);
  const accounts = await p.accounts.call(p, t);
  if (!accounts.length)
    throw fail(
      p.id === "facebook"
        ? "No Facebook Pages were shared. Reconnect and choose at least one Page."
        : p.id === "instagram"
          ? "No Instagram account linked to a Facebook Page was shared. Link the Instagram account to a Page you manage, then reconnect and choose that Page."
          : `${p.name} returned no account.`,
    );
  return accounts.map((a) => saveChannel(store, w, p, a, t));
}

function saveChannel(store: Store, w: string, p: Provider, a: Account, t: Tokens) {
  // Reconnecting the same account updates it in place instead of adding a second one.
  const existing = store.list(w, "apis").find((r) => r.channel?.provider === p.id && r.channel?.accountId === a.id);
  const name = `${p.name} · ${a.name}`.slice(0, 80);
  const now = new Date().toISOString();
  const row = store.put(w, "apis", {
    ...(existing || {}),
    name,
    description: `${p.name} account${a.handle ? ` ${a.handle}` : ""}. ${a.note}`.slice(0, 300),
    baseUrl: p.api.baseUrl,
    docsUrl: p.docsUrl,
    auth: p.api.auth,
    authName: p.api.authName || "access_token",
    access: existing?.access || "write",
    headers: p.api.headers?.() || {},
    bodyFormat: p.api.bodyFormat,
    enabled: existing?.enabled ?? true,
    docs: `${name}. ${a.note}\n\n${p.guide}`,
    docsFormat: "Guide",
    endpoints: p.endpoints,
    docsSource: "built-in",
    docsFetchedAt: now,
    docsError: null,
    logo: existing?.logo ?? null,
    hasKey: true,
    keyHint: null,
    keyUpdatedAt: now,
    channel: {
      provider: p.id,
      accountId: a.id,
      account: a.name,
      handle: a.handle || null,
      expiresAt: a.token ? (a.expiresAt ?? null) : t.expiresAt,
      scope: t.scope || null,
      connectedAt: existing?.channel?.connectedAt || now,
      refreshedAt: now,
      error: null,
    },
    createdAt: existing?.createdAt || now,
  });
  store.secret(w, row.id, a.token || t.access);
  if (!a.token && t.refresh) store.secret(w, `${row.id}:oauth-refresh`, t.refresh);
  return row;
}

// ── Keeping the token fresh ──────────────────────────────────────────────────
const inflight = new Map<string, Promise<void>>();
// Short-lived tokens are renewed in their last 5 minutes; 60-day ones (Instagram, Threads) in their last week.
const due = (c: Row) => c.expiresAt && c.expiresAt - Date.now() < (["instagram", "threads"].includes(c.provider) ? 7 * 86_400_000 : 300_000);
export async function freshChannel(store: Store, w: string, api: Row) {
  const c = api.channel;
  if (!c) return;
  if (c.error) throw fail(`${api.name} needs to be reconnected. An admin can reconnect it from Connections.`);
  if (!due(c)) return;
  const key = `${w}:${api.id}`;
  let pending = inflight.get(key);
  if (!pending) {
    pending = renew(store, w, api).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}
async function renew(store: Store, w: string, api: Row) {
  const p = providerById(api.channel.provider)!;
  const access = store.secret(w, api.id) || "";
  try {
    let t: Tokens;
    if (p.refresh === "instagram" || p.refresh === "threads") {
      const host = p.refresh === "instagram" ? "graph.instagram.com" : "graph.threads.net";
      const grant = p.refresh === "instagram" ? "ig_refresh_token" : "th_refresh_token";
      t = readTokens(await getJson(p, `https://${host}/refresh_access_token?grant_type=${grant}&access_token=${encodeURIComponent(access)}`));
    } else {
      const refresh = store.secret(w, `${api.id}:oauth-refresh`);
      if (p.refresh === "none" || !refresh) {
        // No way to renew it (LinkedIn without refresh tokens): usable until it lapses.
        if (api.channel.expiresAt > Date.now()) return;
        throw Object.assign(fail("expired"), { oauthError: "invalid_grant" });
      }
      t = await tokenRequest(p, { grant_type: "refresh_token", refresh_token: refresh });
    }
    store.secret(w, api.id, t.access);
    if (t.refresh) store.secret(w, `${api.id}:oauth-refresh`, t.refresh);
    const fresh = store.get(w, "apis", api.id);
    store.put(w, "apis", { ...fresh, channel: { ...fresh.channel, expiresAt: t.expiresAt, refreshedAt: new Date().toISOString() } });
  } catch (error) {
    const code = String((error as any).oauthError || "");
    // A revoked or expired grant needs the person to sign in again; a network blip doesn't.
    if (/invalid_grant|invalid_token|expired|unauthorized|^40[01]$|OAuthException|Error validating access token/i.test(code)) {
      const fresh = store.get(w, "apis", api.id);
      store.put(w, "apis", { ...fresh, hasKey: false, channel: { ...fresh.channel, error: "Reconnect this account." } });
      throw fail(`${api.name} needs to be reconnected. An admin can reconnect it from Connections.`);
    }
    // Still valid for now: use it, and try again next call.
    if (api.channel.expiresAt > Date.now()) return;
    throw fail(`${api.name}: its sign-in could not be renewed. Try again shortly.`);
  }
}

// What the console lists: the platforms, whether each is set up, and how many accounts are connected.
export const channelSummary = (store: Store, w: string) => {
  const rows = store.list(w, "apis").filter((r) => r.channel);
  return providers.map((p) => ({ id: p.id, name: p.name, note: p.note, configured: providerConfigured(p), accounts: rows.filter((r) => r.channel.provider === p.id).length }));
};
