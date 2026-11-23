// Where a new account came from, kept with the account so the operator can see which page or
// campaign produced signups. The landing site and the app only ever send a page path (no query
// string), a referring hostname, and utm_source/medium/campaign. Everything is cut down to a short,
// plain, printable string here, because it arrives from the browser and is shown in the admin portal.
export type SignupSource = { lp?: string; ref?: string; source?: string; medium?: string; campaign?: string };

const plain = (value: unknown, max: number, pattern: RegExp) => {
  if (typeof value !== "string") return undefined;
  const v = value.trim().slice(0, max);
  return v && pattern.test(v) ? v : undefined;
};

export function cleanSource(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const out: SignupSource = {
    // A path on orbytlink.com such as /blog/some-post/ or /pricing; never a URL, never a query.
    lp: plain(raw.lp, 120, /^\/[A-Za-z0-9._~/-]*$/),
    ref: plain(raw.ref, 100, /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i)?.toLowerCase(),
    source: plain(raw.source, 60, /^[A-Za-z0-9 _.-]+$/),
    medium: plain(raw.medium, 60, /^[A-Za-z0-9 _.-]+$/),
    campaign: plain(raw.campaign, 80, /^[A-Za-z0-9 _.-]+$/),
  };
  const kept = Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
  return Object.keys(kept).length ? JSON.stringify(kept) : null;
}
