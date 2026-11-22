import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { readFileSync } from "node:fs";
import { Store } from "./store.js";
import {
  createAccount,
  initializeAuthTables,
  resetAccountPassword,
} from "./auth.js";
import { grantCredits, usd } from "./ai.js";
import { initializeLibrary, setBlocked } from "./library.js";
const [command, email, name = "prabalp"] = process.argv.slice(2);
// Pull a bad skill from the shared library everywhere, or put it back:
//   npm run account -- skills block <skill id> | skills unblock <skill id>
if (command === "skills") {
  const [, action, id] = process.argv.slice(2);
  if (!["block", "unblock"].includes(action) || !id) {
    console.error("Usage: npm run account -- skills block <skill id> | skills unblock <skill id>");
    process.exit(1);
  }
  const store = new Store();
  initializeLibrary(store);
  const ok = setBlocked(store, id, action === "block");
  store.db.close();
  console.log(ok ? `${id} is ${action === "block" ? "blocked: hidden from search and no longer loadable" : "back in the library"}.` : `No library skill with id ${id}.`);
  process.exit(ok ? 0 : 1);
}
// Instant tools (operator only; sources and margins never reach a workspace):
//   npm run account -- instant status
//   npm run account -- instant sync
//   npm run account -- instant wallet <a|b|c|d|e> <usd>      a source without a balance API
//   npm run account -- instant price <tool id> <usd>          one tool's quote
//   npm run account -- instant prices > prices.csv            the whole list, to review or edit
//   npm run account -- instant prices-import prices.csv       set quotes from tool,price_usd rows
if (command === "instant") {
  const [, action, a, b] = process.argv.slice(2);
  const instant = await import("./instant.js");
  const store = new Store();
  try {
    if (action === "status") {
      for (const w of instant.walletReport(store))
        console.log(`${w.source}  ${w.configured ? "on " : "off"}  ${w.wallet ? `$${(w.wallet.micro / 1_000_000).toFixed(4)} (${w.wallet.from}, ${w.wallet.checkedAt})` : "balance unknown"}${w.down ? "  resting after failures" : ""}`);
      const c = instant.instantPlatforms(store);
      console.log(`catalog: ${c.platforms.reduce((n: number, p: { tools: number }) => n + p.tools, 0)} tools in ${c.platforms.length} groups, synced ${c.syncedAt ?? "never"}`);
    } else if (action === "sync") {
      console.log(JSON.stringify(await instant.syncCatalog(store), null, 1));
    } else if (action === "wallet" && a && Number.isFinite(Number(b))) {
      instant.setWallet(store, a, Number(b));
      console.log(`Source ${a} wallet set to $${Number(b).toFixed(2)}.`);
    } else if (action === "price" && a && Number.isFinite(Number(b))) {
      instant.setQuote(store, a, Number(b), "operator");
      console.log(`${a} now costs $${Number(b)} per call.`);
    } else if (action === "prices") {
      console.log("tool,price_usd,cheapest_cost_usd,routes,set_by");
      for (const r of instant.priceList(store)) console.log([r.tool, r.priceUsd ?? "", r.cheapestCostUsd ?? "", r.routes, r.setBy].join(","));
    } else if (action === "prices-import" && a) {
      let n = 0;
      for (const line of readFileSync(a, "utf8").split(/\r?\n/).slice(1)) {
        const [tool, price] = line.split(",");
        if (!tool || price === undefined || price === "" || !Number.isFinite(Number(price))) continue;
        instant.setQuote(store, tool.trim(), Number(price), "operator");
        n++;
      }
      console.log(`Set ${n} prices.`);
    } else {
      console.error("Usage: npm run account -- instant status | sync | wallet <a|b|c|d|e> <usd> | price <tool> <usd> | prices | prices-import <file.csv>");
      process.exitCode = 1;
    }
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  } finally {
    store.db.close();
  }
  process.exit();
}
// Who may open the admin portal (app.orbytlink.com/admin). Only from here, never from the web:
//   npm run account -- operator grant <email> | revoke <email> | list
if (command === "operator") {
  const [, action, who] = process.argv.slice(2);
  const admin = await import("./admin.js");
  const store = new Store();
  try {
    if (action === "grant" && who) {
      admin.grantOperator(store, who);
      console.log(`${who} can open /admin once signed in with that email.`);
    } else if (action === "revoke" && who) console.log(admin.revokeOperator(store, who) ? `${who} is no longer an operator.` : `${who} wasn't an operator.`);
    else if (action === "list") for (const o of admin.listOperators(store)) console.log(`${o.email}\tsince ${o.granted_at}`);
    else {
      console.error("Usage: npm run account -- operator grant <email> | revoke <email> | list");
      process.exitCode = 1;
    }
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  } finally {
    store.db.close();
  }
  process.exit();
}
// The catalog tables and the ledger (operator only; workspaces see names and prices, nothing else):
//   npm run account -- catalog list [search]           every item: price, rule, routes, which are live
//   npm run account -- catalog show <item>             one item in full: each route's endpoint, model id,
//                                                      key variable (set or not) and cost
//   npm run account -- catalog item <id> --kind chat|decision|listed|service [--name N] [--provider P]
//                                       [--category C] [--context N] [--info <model card link>]
//                                       [--list-in <usd>] [--list-out <usd>]   list price per unit (before markup)
//   npm run account -- catalog route <item> <source> --endpoint <link> --key <ENV_VAR> --in <usd> [--out <usd>]
//                                       [--ref <model id there>] [--protocol openai-chat|openai-decisions]
//                                       [--priority N] [--off | --on] [--auth <header for the key, default Bearer>]
//   npm run account -- catalog route-remove <item> <source>
//   npm run account -- catalog remove <item>
//   npm run account -- catalog price <item> markup <percent> | fixed <in usd> [out usd] | default
//   npm run account -- catalog decision [id …]          the browser's decision models, in order
//   npm run account -- catalog sync vercel [--kind decision|chat|all] [--dry-run]
//                                                      add new models from AI Gateway's public list and
//                                                      refresh their costs (default: decision models)
//   npm run account -- catalog plan <item>               which provider a call would go to, and why: credit,
//                                                      then manual priority, cost, speed, reliability
//   npm run account -- catalog providers                 each provider's balance (re-reads api balances)
//   npm run account -- catalog balance <provider> <amount> [--inr]   record a top-up / current balance
//   npm run account -- catalog provider <id> --mode api|manual|postpaid [--url U --key ENV --field F]
//   npm run account -- catalog sync google               add a google route to every catalog model the
//                                                      GEMINI_API_KEY can call (Google AI Studio)
//   npm run account -- catalog export > catalog.json    the whole catalog as JSON
//   npm run account -- catalog import catalog.json      add or update items, routes and prices from JSON
//   npm run account -- report [--days 30] [--by item|source|workspace|day|kind]   cost, charged, margin
if (command === "catalog" || command === "report") {
  const args = process.argv.slice(3);
  const flags: Record<string, string | true> = {};
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) flags[args[i].slice(2)] = true;
      else flags[args[i].slice(2)] = args[++i];
    } else words.push(args[i]);
  }
  const flag = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);
  const catalog = await import("./catalog.js");
  const routing = await import("./routing.js");
  const ledger = await import("./ledger.js");
  const store = new Store();
  const usdOf = (micro: number | null) => (micro === null ? "?" : `$${(micro / 1_000_000).toFixed(6)}`);
  try {
    catalog.ensureCatalog(store);
    const [action, a, b, ...rest] = command === "report" ? ["report", ...words] : words;
    if (action === "report") {
      const by = (flag("by") || "item") as "item" | "source" | "workspace" | "day" | "kind";
      const rows = ledger.report(store, { days: Number(flag("days") || 30), by });
      console.log([by, "calls", "failed", "units_in", "units_out", "cost", "charged", "margin", "cost_unknown"].join("\t"));
      for (const r of rows) console.log([r.key, r.calls, r.failed, r.units_in, r.units_out, usdOf(r.cost_micro), usdOf(r.charged_micro), usdOf(r.margin_micro), r.cost_unknown].join("\t"));
    } else if (action === "list") {
      console.log(["item", "kind", "price_in", "price_out", "rule", "routes (source:cost_in/cost_out, * = live)"].join("\t"));
      for (const d of catalog.describe(store, a || ""))
        console.log([d.item.id, d.item.kind, d.price.input ?? "", d.price.output ?? "", d.price.rule, d.routes.map((r) => `${r.live ? "*" : ""}${r.source}:${r.cost_in ?? "?"}/${r.cost_out ?? "-"}`).join(" ")].join("\t"));
    } else if (action === "show" && a) {
      const d = catalog.describe(store, a).find((x) => x.item.id === a);
      if (!d) throw new Error(`No item ${a}`);
      console.log(JSON.stringify({ ...d.item, price: d.price, routes: d.routes.map(({ id: _id, item_id: _item, ...r }) => r) }, null, 2));
    } else if (action === "item" && a) {
      const i = catalog.upsertItem(store, { id: a, kind: flag("kind") as any, name: flag("name"), provider: flag("provider"), category: flag("category"), context: flag("context") ? Number(flag("context")) : undefined, info_url: flag("info"), list_in: flag("list-in"), list_out: flag("list-out") });
      console.log(`${i.id}: ${i.kind} "${i.name}". Add a way to call it with: catalog route ${i.id} <source> --endpoint … --key … --in …`);
    } else if (action === "route" && a && b) {
      const r = catalog.upsertRoute(store, { item: a, source: b, protocol: flag("protocol") as any, endpoint: flag("endpoint"), ref: flag("ref"), key_env: flag("key"), auth_header: flag("auth"), cost_in: flag("in"), cost_out: flag("out"), priority: flag("priority") ? Number(flag("priority")) : undefined, enabled: flags.off ? false : flags.on ? true : undefined });
      console.log(`${a} via ${r.source}: ${r.protocol} ${r.endpoint ?? "(internal)"} model ${r.ref}, key in ${r.key_env ?? "-"} (${r.key_env && process.env[r.key_env] ? "set" : "NOT set"}), cost ${r.cost_in}/${r.cost_out ?? "-"}. Now sold at ${JSON.stringify(catalog.priceOf(store, a))}.`);
    } else if (action === "route-remove" && a && b) {
      catalog.removeRoute(store, a, b);
      console.log(`Removed the ${b} route of ${a}.`);
    } else if (action === "remove" && a) {
      catalog.removeItem(store, a);
      console.log(`Removed ${a} and its routes. Its past calls stay in the ledger.`);
    } else if (action === "price" && a && b) {
      catalog.setPrice(store, a, b === "default" ? "default" : b === "markup" ? { markup: Number(rest[0]) } : b === "fixed" ? { input: rest[0], output: rest[1] } : (() => { throw new Error("price <item> markup <percent> | fixed <in> [out] | default"); })());
      console.log(`${a} now sells at ${JSON.stringify(catalog.priceOf(store, a))}.`);
    } else if (action === "decision") {
      const ids = [a, b, ...rest].filter(Boolean);
      if (ids.length) catalog.setDecision(store, ids);
      const live = new Set(catalog.decisionModels(store).map((m) => m.id));
      for (const id of catalog.listOf(store, catalog.DECISION_LIST)) console.log(`${id}${live.has(id) ? "" : "  (no live route: skipped)"}`);
    } else if (action === "sync" && a === "vercel") {
      const kind = flag("kind") || "decision";
      const kinds = (kind === "all" ? ["decision", "chat"] : [kind]) as ("decision" | "chat")[];
      if (!kinds.every((k) => k === "decision" || k === "chat")) throw new Error("--kind decision, chat or all");
      const out = await (await import("./provider-sync.js")).syncVercelLive(store, kinds, !!flags["dry-run"]);
      console.log(out.lines.join("\n"));
    } else if (action === "plan" && a) {
      await routing.refreshBalances(store, true);
      const p = routing.plan(store, a);
      if (!catalog.getItem(store, a)) throw new Error(`No item ${a}`);
      console.log(`${a}: sold at ${p.price.input}/${p.price.output} (${p.price.rule}); a typical call is ${Math.round(p.typical.inTokens)} tokens in, ${Math.round(p.typical.outTokens)} out.`);
      console.log(["#", "provider", "manual", "cost/typical call", "speed", "reliability", "credit"].join("\t"));
      p.ranked.forEach((c, n) => console.log([n + 1, c.source, c.priority, usdOf(c.expectedMicro), c.latencyMs === null ? "not measured" : `${c.latencyMs} ms`, `${Math.round(c.reliability * 100)}%`, c.balanceMicro === null ? "postpaid / not tracked" : usdOf(c.balanceMicro)].join("\t")));
      for (const c of p.excluded) console.log(["-", c.source, "", "", "", "", `not used: ${c.excluded}`].join("\t"));
    } else if (action === "providers") {
      await routing.refreshBalances(store, true);
      console.log(["provider", "name", "balance", "mode", "checked"].join("\t"));
      for (const s of routing.sources(store)) console.log([s.id, s.name, s.balance_mode === "postpaid" ? "postpaid" : s.balance_micro === null ? "not recorded" : usdOf(s.balance_micro), s.balance_mode, s.balance_checked_at ?? "-"].join("\t"));
    } else if (action === "balance" && a && b) {
      const rate = Number(process.env.USD_INR_RATE) > 0 ? Number(process.env.USD_INR_RATE) : 90;
      const usd = flags.inr ? Number(b) / rate : Number(b);
      const s = routing.setSource(store, a, { balanceUsd: usd, mode: routing.sources(store).find((x) => x.id === a)?.balance_mode === "postpaid" ? "manual" : undefined });
      console.log(`${s.name}: balance ${usdOf(s.balance_micro)} (${s.balance_mode}). Each call's cost comes off it.`);
    } else if (action === "provider" && a) {
      const s = routing.setSource(store, a, { mode: flag("mode") as any, name: flag("name"), url: flag("url"), keyEnv: flag("key") ? catalog.checkKeyEnv(flag("key")!) : undefined, field: flag("field") });
      console.log(`${s.id}: ${s.balance_mode}${s.balance_url ? ` from ${s.balance_url}` : ""}.`);
    } else if (action === "sync" && a === "google") {
      console.log((await (await import("./provider-sync.js")).syncGoogleLive(store)).lines.join("\n"));
    } else if (action === "export") {
      console.log(JSON.stringify(catalog.exportCatalog(store), null, 1));
    } else if (action === "import" && a) {
      console.log(`Saved ${catalog.importCatalog(store, JSON.parse(readFileSync(a, "utf8")))} items.`);
    } else {
      console.error("Usage: npm run account -- catalog list|show|item|route|route-remove|remove|price|decision|export|import …   (see server/account.ts)  ·  npm run account -- report [--days N] [--by item|source|workspace|day|kind]");
      process.exitCode = 1;
    }
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  } finally {
    store.db.close();
  }
  process.exit();
}
// AI credit, added by the operator until payments exist:
//   npm run account -- credits <email or workspace id> <usd> [note]
// An email adds to that person's own workspace; an organization takes its workspace id.
if (command === "credits") {
  const [, target, amount, ...note] = process.argv.slice(2);
  const dollars = Number(amount);
  if (!target || !Number.isFinite(dollars) || dollars === 0) {
    console.error("Usage: npm run account -- credits <email or workspace id> <usd> [note]   (negative to remove)");
    process.exit(1);
  }
  const store = new Store();
  initializeAuthTables(store);
  try {
    const account = target.includes("@")
      ? (store.db.prepare("SELECT workspace FROM accounts WHERE email=?").get(target.toLowerCase()) as { workspace: string } | undefined)
      : { workspace: target };
    if (!account) throw new Error("No account with that email.");
    const s = grantCredits(store, account.workspace, Math.round(dollars * 1_000_000), "operator", note.join(" "));
    console.log(`Done. Workspace ${account.workspace} now has $${usd(s.balance).toFixed(2)} of AI credit.`);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  } finally {
    store.db.close();
  }
  process.exit();
}
if (!["create", "reset-password"].includes(command) || !email) {
  console.error(
    "Usage: npm run account -- create <email> [name] | reset-password <email> | credits <email or workspace id> <usd> | skills block|unblock <id>",
  );
  process.exit(1);
}
let password: string;
if (process.stdin.isTTY) {
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const prompt = createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });
  process.stdout.write("Password (12–128 characters, hidden): ");
  password = await prompt.question("");
  process.stdout.write("\nConfirm password: ");
  const confirm = await prompt.question("");
  process.stdout.write("\n");
  prompt.close();
  if (password !== confirm) {
    console.error("Passwords did not match. No changes made.");
    process.exit(1);
  }
} else password = readFileSync(0, "utf8").replace(/\r?\n$/, "");
const store = new Store();
initializeAuthTables(store);
try {
  if (command === "create")
    await createAccount(store, { email, name, password });
  else await resetAccountPassword(store, email, password);
  console.log(
    command === "create"
      ? "Account created. Sign in with your email and password."
      : "Password reset. Existing sessions and access tokens were revoked.",
  );
} catch {
  console.error(
    "Account operation failed. Check the email, password length, and whether the account exists.",
  );
  process.exitCode = 1;
} finally {
  store.db.close();
}
