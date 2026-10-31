import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { readFileSync } from "node:fs";
import { Store } from "./store.js";
import {
  createAccount,
  initializeAuthTables,
  resetAccountPassword,
} from "./auth.js";
const [command, email, name = "prabalp"] = process.argv.slice(2);
if (!["create", "reset-password"].includes(command) || !email) {
  console.error(
    "Usage: npm run account -- create <email> [name] | reset-password <email>",
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
