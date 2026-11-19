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
