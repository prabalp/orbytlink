// Publishes the blog in one command: build, commit, push, deploy the landing site.
//   npm run blog:publish              build, commit, push, deploy
//   npm run blog:publish -- --dry-run build and show what would happen; change nothing in git or on the site
//   npm run blog:publish -- --no-deploy   build, commit and push only
//
// It only ever commits the blog's own files, refuses to run from the wrong branch, a work email,
// or a checkout that is behind GitHub, and never uploads landing/blog-src (drafts and queued posts).
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const dry = args.has("--dry-run");
const deploy = !args.has("--no-deploy");
const PROJECT = "orbytlink-landing";
const BLOG_PATHS = ["landing/blog", "landing/blog-src", "landing/sitemap.xml", "landing/llms.txt"];
const NEVER_UPLOAD = new Set(["blog-src", "index-old.html", "index-v1.html"]);

const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { cwd: ROOT, encoding: "utf8", stdio: opts.show ? "inherit" : ["ignore", "pipe", "pipe"], ...opts });
const git = (...argv) => run("git", argv).trim();
const stop = (message) => {
  console.error(`Not published: ${message}`);
  process.exit(1);
};

// 1. Safe to run here?
if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") stop("run this from the main branch.");
const email = git("config", "user.email");
if (/redenvelope\.co$/i.test(email)) stop(`git is set to the work email (${email}). This repository's commits use the personal one.`);
try {
  run("git", ["fetch", "-q", "origin", "main"]);
} catch (e) {
  stop(`couldn't reach GitHub (${String(e.stderr || e.message).trim()}).`);
}
if (Number(git("rev-list", "--count", "HEAD..origin/main")) > 0) stop("GitHub has newer commits. Run git pull first.");

// 2. Build.
console.log("Building the blog…");
run("node", ["scripts/build-blog.mjs"], { show: true });

// 3. Commit only the blog's files.
const changed = git("status", "--porcelain", "--", ...BLOG_PATHS);
if (!changed) console.log("Nothing new to commit.");
else {
  console.log(`Changes:\n${changed}`);
  if (dry) console.log("(dry run: nothing committed)");
  else {
    git("add", "--", ...BLOG_PATHS);
    const posts = git("diff", "--cached", "--name-only", "--", "landing/blog-src").split("\n").filter(Boolean).map((f) => f.replace(/^landing\/blog-src\//, "").replace(/\.md$/, ""));
    git("commit", "-m", posts.length ? `Blog: ${posts.join(", ")}` : "Blog: rebuild");
  }
}
const unpushed = Number(git("rev-list", "--count", "origin/main..HEAD"));
if (unpushed > 0 && !dry) {
  console.log(`Pushing ${unpushed} commit${unpushed === 1 ? "" : "s"}…`);
  run("git", ["push", "origin", "main"], { show: true });
}

// 4. Deploy the landing site (everything except drafts and old files).
if (!deploy) process.exit(0);
if (dry) {
  console.log(`(dry run: would deploy landing/ to Cloudflare Pages project ${PROJECT}, leaving out ${[...NEVER_UPLOAD].join(", ")})`);
  process.exit(0);
}
const dir = mkdtempSync(join(tmpdir(), "orbytlink-landing-"));
try {
  cpSync(join(ROOT, "landing"), dir, { recursive: true, filter: (src) => !NEVER_UPLOAD.has(src.slice(join(ROOT, "landing").length + 1)) });
  console.log("Deploying to Cloudflare Pages…");
  run("npx", ["wrangler@4", "pages", "deploy", dir, "--project-name", PROJECT, "--branch", "main", "--commit-dirty=true"], { show: true });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("Live at https://orbytlink.com/blog/");
