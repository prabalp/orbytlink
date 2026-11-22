import type { Store } from "./store.js";
import { dropSourceRoutes, getItem, GOOGLE, syncGoogle, syncVercel, VERCEL_MODELS_URL } from "./catalog.js";

// Syncing providers' own model lists into the catalog. Used by the command line
// (npm run account -- catalog sync …) and the admin portal, so both do exactly the same thing.
// Each returns plain lines to show the operator.

export async function syncVercelLive(store: Store, kinds: ("decision" | "chat")[], dryRun = false) {
  const r = await fetch(VERCEL_MODELS_URL, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`AI Gateway's model list answered HTTP ${r.status}`);
  const out = syncVercel(store, ((await r.json()) as any).data || [], kinds, dryRun);
  const lines = [
    `${dryRun ? "Would add" : "Added"} ${out.added.length}: ${out.added.join(", ") || "-"}`,
    `Cost changed ${out.costChanged.length}:${out.costChanged.map((c) => `\n  ${c}`).join("") || " -"}`,
    `Unchanged ${out.unchanged}. Kept as the operator set them: ${out.operatorKept.join(", ") || "-"}`,
  ];
  if (out.notListed.length) lines.push(`No longer listed by AI Gateway (left in place): ${out.notListed.join(", ")}`);
  return { ...out, lines };
}

// Google lists models a key can't use (retired for new users, or beyond a free-tier quota), so each
// model the catalog sells is tried with a tiny call first; only those that answer get a route. A model
// that is only busy right now (503) counts as working. A "free-tier" key must really be free: if it can
// call a model Google sells on no free tier, its project is billed, and it isn't used as free.
export async function syncGoogleLive(store: Store) {
  const tiers = ([["paid", GOOGLE.keyEnv], ["free", GOOGLE.free.keyEnv]] as const).filter(([, env]) => process.env[env]);
  if (!tiers.length) throw new Error(`Put a Google AI Studio key in ${GOOGLE.keyEnv} (paid) or ${GOOGLE.free.keyEnv} (free tier) first.`);
  const lines: string[] = [];
  const tryModel = (key: string, model: string) =>
    fetch(GOOGLE.chat, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "Say OK." }], max_tokens: 5 }), signal: AbortSignal.timeout(30_000) }).catch(() => null);
  for (const [tier, env] of tiers) {
    const key = process.env[env]!;
    lines.push(`${tier === "free" ? "Free-tier key" : "Paid key"} (${env})`);
    if (tier === "free") {
      const probe = await tryModel(key, GOOGLE.paidOnlyModel);
      if (probe?.ok) {
        const dropped = dropSourceRoutes(store, GOOGLE.free.source);
        lines.push(`  Not used as free tier: it could call ${GOOGLE.paidOnlyModel}, which has no free tier, so its project is billed. Create the free key in a project without billing. (${dropped} free routes removed.)`);
        continue;
      }
      if (probe?.status === 404) lines.push(`  Couldn't confirm the key is free: ${GOOGLE.paidOnlyModel} no longer exists.`);
    }
    const r = await fetch(GOOGLE.models, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) {
      lines.push(`  Google's model list answered HTTP ${r.status}: check ${env}.`);
      continue;
    }
    const listed = (((await r.json()) as any).data || []) as { id: string }[];
    const sold = listed.filter((m) => getItem(store, `google/${String(m.id).replace(/^models\//, "")}`)?.kind === "chat");
    const usable: { id: string }[] = [];
    const refused: string[] = [];
    for (const m of sold) {
      const model = String(m.id).replace(/^models\//, "");
      const t = await tryModel(key, model);
      if (t && (t.ok || t.status === 503)) usable.push(m);
      else refused.push(`${model} (${t ? `HTTP ${t.status}${t.status === 429 ? ": over this key's quota" : t.status === 404 ? ": not available to this key" : ""}` : "unreachable"})`);
    }
    const out = syncGoogle(store, usable, tier);
    lines.push(`  Routes added ${out.added.length}: ${out.added.join(", ") || "-"}; updated ${out.updated.length}.`);
    if (refused.length) lines.push(`  Not added, Google refused them for this key: ${refused.join(", ")}`);
  }
  return { lines };
}
