// Online SQLite backup, safe while the server runs. Keeps the newest BACKUP_KEEP copies.
// Backups hold encrypted credentials: they are useless without SECRET_KEY, so store that key
// separately (a password manager), never next to the backups.
//   docker compose exec api node scripts/backup.mjs
import { DatabaseSync, backup } from "node:sqlite";
import { chmodSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const data = process.env.DATA_DIR || ".data";
const dir = process.env.BACKUP_DIR || (process.env.NODE_ENV === "production" ? "/app/backups" : "backups");
const keep = Number(process.env.BACKUP_KEEP) || 14;
mkdirSync(dir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const target = join(dir, `orbytlink-${stamp}.sqlite`);
const db = new DatabaseSync(join(data, "orbytlink.sqlite"), { readOnly: true });
await backup(db, target);
db.close();
// Holds password hashes and encrypted credentials: owner-only.
chmodSync(target, 0o600);
const old = readdirSync(dir).filter((f) => /^orbytlink-\d{8}-\d{6}\.sqlite$/.test(f)).sort().slice(0, -keep);
for (const f of old) rmSync(join(dir, f));
console.log(`Backed up to ${target}${old.length ? `; removed ${old.length} older` : ""}`);
