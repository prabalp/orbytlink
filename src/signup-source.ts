// Remembers where a visitor came from until they sign up, so the account can record it. The landing
// site links here as app.orbytlink.com/?lp=/blog/some-post/&ref=google.com&utm_source=...; only those
// five values are kept, in sessionStorage (cleared when the tab closes), and they leave the URL at once.
const KEY = "ol_src";
const PARAMS: [param: string, field: string][] = [
  ["lp", "lp"],
  ["ref", "ref"],
  ["utm_source", "source"],
  ["utm_medium", "medium"],
  ["utm_campaign", "campaign"],
];

export type Source = Record<string, string>;

export function captureSignupSource(): void {
  try {
    const url = new URL(location.href);
    const found: Source = {};
    for (const [param, field] of PARAMS) {
      const v = url.searchParams.get(param);
      if (v) found[field] = v.slice(0, 120);
      url.searchParams.delete(param);
    }
    // A visit with no marked link still has a referrer worth keeping (someone who found the app directly).
    if (!found.ref && document.referrer) {
      try {
        const host = new URL(document.referrer).hostname;
        if (host && host !== location.hostname) found.ref = host;
      } catch {
        // no usable referrer
      }
    }
    // First visit wins: later pages inside the app don't overwrite where they arrived from.
    if (Object.keys(found).length && !sessionStorage.getItem(KEY)) sessionStorage.setItem(KEY, JSON.stringify(found));
    if (url.href !== location.href) history.replaceState(null, "", url.pathname + url.search + url.hash);
  } catch {
    // storage or URL access blocked: signup works without a source
  }
}

export function signupSource(): Source | undefined {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Source) : undefined;
  } catch {
    return undefined;
  }
}

// The Google button is a plain link, so the source travels in its query string.
export const googleSignInUrl = () => {
  const s = signupSource();
  return s ? `/api/auth/google?src=${encodeURIComponent(JSON.stringify(s))}` : "/api/auth/google";
};
