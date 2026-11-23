// Builds the blog on orbytlink.com from Markdown: landing/blog-src/*.md -> landing/blog/.
// Usage: node scripts/build-blog.mjs      (see docs/BLOG-DESIGN.md)
//
// The generated landing/blog/ is committed, so Cloudflare Pages needs no build step. Never edit it
// by hand: change the source or this script and run it again. The page shell (styles, logo, footer)
// is read from landing/about.html so the blog always matches the rest of the site.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LANDING = join(ROOT, "landing");
const SRC = join(LANDING, "blog-src");
const OUT = join(LANDING, "blog");
const SITE = "https://orbytlink.com";
const today = new Date().toISOString().slice(0, 10);

const errors = [];
const fail = (where, message) => errors.push(`${where}: ${message}`);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const slugOf = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const longDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

// ── Markdown (the subset the blog allows) ───────────────────────────────────
const stash = [];
function inline(text) {
  let s = text.replace(/`([^`]+)`/g, (_, c) => `\u0000${stash.push(`<code>${esc(c)}</code>`) - 1}\u0000`);
  s = esc(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => {
    if (!alt.trim()) fail("image", `${src} has no alt text`);
    return `<img src="${src}" alt="${alt}" loading="lazy">`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    links.push(href.replace(/&amp;/g, "&"));
    const external = /^https?:\/\//.test(href) && !href.startsWith(SITE);
    return `<a href="${href}"${external ? ' rel="noopener"' : ""}>${label}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
}
let links = [];
function render(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  const headings = [];
  let i = 0;
  let first = true;
  const para = [];
  const flush = () => {
    if (!para.length) return;
    html.push(`<p${first ? ' class="intro"' : ""}>${inline(para.join(" "))}</p>`);
    first = false;
    para.length = 0;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      flush();
      i++;
    } else if (/^```/.test(line)) {
      flush();
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      html.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
    } else if (/^#{2,3} /.test(line)) {
      flush();
      const level = line.startsWith("###") ? 3 : 2;
      const text = line.replace(/^#{2,3} /, "").trim();
      const id = slugOf(text);
      if (level === 2) headings.push({ id, text });
      html.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      i++;
    } else if (/^#\s/.test(line)) {
      fail("markdown", "use ## for sections; the title comes from front matter");
      i++;
    } else if (/^>/.test(line)) {
      flush();
      const quote = [];
      while (i < lines.length && /^>/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ""));
      html.push(`<div class="note">${inline(quote.join(" "))}</div>`);
    } else if (/^\s*([-*]|\d+\.)\s/.test(line)) {
      flush();
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ""));
      html.push(`<${ordered ? "ol" : "ul"}>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
    } else if (/^\|/.test(line) && /^\|[\s:|-]+\|?\s*$/.test(lines[i + 1] || "")) {
      flush();
      const cells = (row) => row.replace(/^\||\|\s*$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(cells(lines[i++]));
      html.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
    } else if (/<[a-z!/]/i.test(line) && /^\s*</.test(line)) {
      fail("markdown", "raw HTML isn't allowed in posts");
      i++;
    } else {
      para.push(line.trim());
      i++;
    }
  }
  flush();
  return { html: html.join("\n        "), headings };
}

// ── The shell, taken from about.html ────────────────────────────────────────
const about = readFileSync(join(LANDING, "about.html"), "utf8");
const grab = (re, what) => {
  const m = about.match(re);
  if (!m) throw new Error(`landing/about.html no longer has its ${what}; update scripts/build-blog.mjs`);
  return m[0];
};
const baseStyle = grab(/<style>[\s\S]*?<\/style>/, "style block");
const favicon = grab(/<link rel="icon"[^>]*>/, "favicon");
const fonts = grab(/<link rel="preconnect" href="https:\/\/fonts.googleapis.com">\s*<link rel="preconnect"[^>]*>\s*<link href="https:\/\/fonts.googleapis.com[^>]*>/, "font links");
const themeScript = grab(/<script>document.documentElement.dataset.theme[^<]*<\/script>/, "theme script");
const sprite = grab(/<svg width="0"[\s\S]*?<\/svg>/, "logo sprite");
const header = grab(/<header class="site-header">[\s\S]*?<\/header>/, "header");
let footer = grab(/<footer class="site-footer">[\s\S]*?<\/footer>/, "footer").replace(' aria-current="page"', "");
if (!footer.includes('href="/blog/"')) footer = footer.replace('<a href="/pricing.html">', '<a href="/blog/">Blog</a><a href="/pricing.html">');
const blogStyle = `<style>
.body { max-width: 704px; }
.body p, .body li { font-size: 17px; line-height: 28px; }
.body .intro { font-size: 18px; line-height: 28px; }
.body ol { margin: 12px 0 0; padding: 0 0 0 22px; display: grid; gap: 8px; }
.body ol li { padding-left: 4px; color: var(--text-2); }
.body ol li::before { content: none; }
.body code { font: 14px/22px ui-monospace, "SF Mono", Menlo, monospace; background: var(--raised); box-shadow: inset 0 0 0 1px var(--border); border-radius: 6px; padding: 1px 6px; }
.body pre { margin: 16px 0 0; padding: 16px; overflow-x: auto; border-radius: 12px; background: var(--raised); box-shadow: inset 0 0 0 1px var(--border); }
.body pre code { background: none; box-shadow: none; padding: 0; color: var(--text-2); }
.body .note { margin-top: 16px; }
.body h2 { scroll-margin-top: 88px; }
.body img { max-width: 100%; height: auto; border-radius: 12px; box-shadow: 0 0 0 1px var(--border); }
.lead { margin: 12px 0 0; max-width: 560px; color: var(--text-2); font-size: 18px; line-height: 28px; }
.posts { margin-top: 48px; border-top: 1px solid var(--border); }
.post-row { display: block; padding: 24px 0; border-bottom: 1px solid var(--border); }
.post-row h2 { margin: 0; font-size: 18px; line-height: 28px; font-weight: 500; }
.post-row:hover h2 { text-decoration: underline; }
.post-row p { margin: 4px 0 0; max-width: 704px; color: var(--text-2); }
.post-row .meta { margin-top: 8px; }
.end { max-width: 704px; margin-top: 48px; }
.end .btn { margin-left: 8px; }
.related { margin-top: 32px; border-top: 1px solid var(--border); }
.related h2 { margin: 24px 0 0; font-size: 14px; line-height: 20px; font-weight: 500; color: var(--muted); }
.related .post-row { padding: 16px 0; }
.empty { margin-top: 48px; color: var(--muted); }
</style>`;

function page({ title, description, path, type = "website", body, extraHead = "", crumbs }) {
  const url = `${SITE}${path}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="theme-color" content="#000000">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="${type}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE}/og-image.png?v=2">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${SITE}/og-image.png?v=2">
<link rel="canonical" href="${url}">
<link rel="alternate" type="application/rss+xml" title="OrbytLink Blog" href="${SITE}/blog/rss.xml">
${favicon}
${fonts}
${themeScript}
${baseStyle}
${blogStyle}
${extraHead}
</head>
<body>
<div class="guides" aria-hidden="true"></div>
${sprite}
${header}
<main class="doc">
  <div class="wrap">
    <div class="crumbs">${crumbs}</div>
${body}
  </div>
</main>
${footer}
</body>
</html>
`;
}

// ── Read the posts ──────────────────────────────────────────────────────────
const posts = [];
const seen = new Set();
if (existsSync(SRC)) {
  for (const file of readdirSync(SRC).filter((f) => f.endsWith(".md")).sort()) {
    const raw = readFileSync(join(SRC, file), "utf8");
    const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!m) {
      fail(file, "starts with front matter between --- lines");
      continue;
    }
    let meta;
    try {
      meta = load(m[1]) || {};
    } catch (e) {
      fail(file, `front matter isn't valid YAML (${e.message})`);
      continue;
    }
    for (const k of ["title", "slug", "date", "summary", "tags"]) if (meta[k] === undefined || meta[k] === "") fail(file, `front matter needs ${k}`);
    meta.date = meta.date instanceof Date ? meta.date.toISOString().slice(0, 10) : String(meta.date || "");
    if (meta.updated !== undefined) meta.updated = meta.updated instanceof Date ? meta.updated.toISOString().slice(0, 10) : String(meta.updated);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(String(meta.slug || ""))) fail(file, "slug: lower-case words joined by hyphens");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.date)) fail(file, "date: YYYY-MM-DD");
    if (String(meta.summary || "").length > 160) fail(file, `summary is ${meta.summary.length} characters; keep it to 160 or fewer`);
    if (!Array.isArray(meta.tags) || meta.tags.length < 1 || meta.tags.length > 3) fail(file, "tags: one to three");
    if (seen.has(meta.slug)) fail(file, `slug "${meta.slug}" is used twice`);
    seen.add(meta.slug);
    if (meta.draft !== false) continue; // drafts are never emitted
    if (meta.date > today) continue; // queued for a later day
    links = [];
    stash.length = 0;
    const { html, headings } = render(m[2].trim());
    const text = m[2].replace(/```[\s\S]*?```/g, " ");
    const words = (text.match(/[\p{L}\p{N}'-]+/gu) || []).length;
    posts.push({ ...meta, html, headings, links: [...links], minutes: Math.max(1, Math.round(words / 220)), file });
  }
}
posts.sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));

// Internal links must point at something that exists.
const landingHas = (p) => {
  const clean = p.split("#")[0].split("?")[0].replace(/^\/+/, "");
  return [clean, `${clean}.html`, join(clean, "index.html")].some((c) => c && existsSync(join(LANDING, c)));
};
for (const post of posts) {
  for (const href of post.links) {
    if (href.startsWith("#") || /^(mailto:|https?:\/\/(?!orbytlink\.com))/.test(href)) continue;
    const path = href.replace(/^https:\/\/orbytlink\.com/, "") || "/";
    if (path === "/" || path.startsWith("/blog/")) continue;
    if (!landingHas(path)) fail(post.file, `broken internal link ${href}`);
  }
}
if (errors.length) {
  console.error(`Blog not built:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}

// ── Write the pages ─────────────────────────────────────────────────────────
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const row = (p, tag = "h2") => `      <a class="post-row" href="/blog/${p.slug}/"><${tag}>${esc(p.title)}</${tag}><p>${esc(p.summary)}</p><div class="meta">${longDate(p.date)} · ${p.minutes} min read</div></a>`;

writeFileSync(
  join(OUT, "index.html"),
  page({
    title: "Blog · OrbytLink",
    description: "Guides on connecting AI agents to your apps through one MCP endpoint, from the team behind OrbytLink.",
    path: "/blog/",
    crumbs: '<a href="/">Home</a> / Blog',
    extraHead: `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Blog", name: "OrbytLink Blog", url: `${SITE}/blog/`, publisher: { "@type": "Organization", name: "Orbytlabs" } })}</script>`,
    body: `    <h1>Blog</h1>
    <p class="lead">Practical guides on connecting AI agents to your apps through one endpoint.</p>
${posts.length ? `    <div class="posts">\n${posts.map((p) => row(p)).join("\n")}\n    </div>` : '    <p class="empty">The first posts are on their way.</p>'}`,
  }),
);

for (const p of posts) {
  const related = posts.filter((x) => x.slug !== p.slug).slice(0, 3);
  const toc = p.headings.length >= 3;
  const published = p.date;
  const modified = p.updated && p.updated !== p.date ? p.updated : p.date;
  mkdirSync(join(OUT, p.slug), { recursive: true });
  writeFileSync(
    join(OUT, p.slug, "index.html"),
    page({
      title: `${p.title} · OrbytLink Blog`,
      description: p.summary,
      path: `/blog/${p.slug}/`,
      type: "article",
      crumbs: `<a href="/">Home</a> / <a href="/blog/">Blog</a> / ${esc(p.title)}`,
      extraHead: `<meta property="article:published_time" content="${published}">
<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "BlogPosting", headline: p.title, description: p.summary, datePublished: published, dateModified: modified, mainEntityOfPage: `${SITE}/blog/${p.slug}/`, author: { "@type": "Organization", name: "Orbytlabs" }, publisher: { "@type": "Organization", name: "Orbytlabs" } })}</script>
${toc ? "" : "<style>.layout { grid-template-columns: minmax(0, 704px); }</style>"}`,
      body: `    <h1>${esc(p.title)}</h1>
    <div class="meta">${longDate(published)}${modified !== published ? ` · Updated ${longDate(modified)}` : ""} · ${p.minutes} min read</div>
    <div class="layout">
${toc ? `      <nav class="toc" aria-label="On this page">${p.headings.map((h) => `<a href="#${h.id}">${esc(h.text)}</a>`).join("")}</nav>\n` : ""}      <div>
      <article class="body">
        ${p.html}
      </article>
      <div class="end note">Want to try it? <a href="https://app.orbytlink.com/">Sign in</a> or <a href="/#access">get started</a>.</div>
${related.length ? `      <div class="related"><h2>More from the blog</h2>\n${related.map((r) => row(r, "h3")).join("\n")}\n      </div>\n` : ""}      </div>
    </div>`,
    }),
  );
}

// RSS: the latest 20 posts.
const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>OrbytLink Blog</title><link>${SITE}/blog/</link><description>Guides on connecting AI agents to your apps through one MCP endpoint.</description><language>en</language>
${posts.slice(0, 20).map((p) => `<item><title>${esc(p.title)}</title><link>${SITE}/blog/${p.slug}/</link><guid>${SITE}/blog/${p.slug}/</guid><pubDate>${new Date(`${p.date}T09:00:00Z`).toUTCString()}</pubDate><description>${esc(p.summary)}</description></item>`).join("\n")}
</channel></rss>
`;
writeFileSync(join(OUT, "rss.xml"), rss);

// sitemap.xml and llms.txt: only the region between the blog markers is ever rewritten.
function region(file, start, end, content, anchor) {
  const path = join(LANDING, file);
  let text = readFileSync(path, "utf8");
  const block = `${start}\n${content}\n${end}`;
  const re = new RegExp(`${start.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  text = re.test(text) ? text.replace(re, () => block) : anchor(text, block);
  writeFileSync(path, text);
}
const urls = [{ loc: `${SITE}/blog/`, lastmod: posts[0]?.updated || posts[0]?.date || today }, ...posts.map((p) => ({ loc: `${SITE}/blog/${p.slug}/`, lastmod: p.updated || p.date }))];
region("sitemap.xml", "  <!-- blog:start -->", "  <!-- blog:end -->", urls.map((u) => `  <url><loc>${u.loc}</loc><lastmod>${u.lastmod}</lastmod></url>`).join("\n"), (t, b) => t.replace("</urlset>", `${b}\n</urlset>`));
region(
  "llms.txt",
  "<!-- blog:start -->",
  "<!-- blog:end -->",
  `## Blog\n\n${posts.map((p) => `- [${p.title}](${SITE}/blog/${p.slug}/): ${p.summary}`).join("\n")}\n`,
  (t, b) => (t.includes("\n## Optional") ? t.replace("\n## Optional", `\n${b}\n\n## Optional`) : `${t.trimEnd()}\n\n${b}\n`),
);

console.log(`Blog built: ${posts.length} post${posts.length === 1 ? "" : "s"} → landing/blog/`);
