/**
 * Build the site and publish dist/ to the gh-pages branch on GitHub, which Pages serves at
 * https://rohitpatil9121.github.io/arcade/. The games come from folders next to this repository, so this runs
 * here rather than in GitHub Actions. The build branch is never touched: gh-pages is written in a temporary
 * worktree and holds nothing but the built site.
 *
 *   node tools/publish.mjs              # build, commit to gh-pages, push
 *   node tools/publish.mjs --dry-run    # build and commit, but don't push
 */
import { spawnSync } from "node:child_process";
import { cpSync, rmSync, readdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const BRANCH = "gh-pages";
const dry = process.argv.includes("--dry-run");

function run(cmd, args, opts = {}) {
    const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: opts.quiet ? "pipe" : ["ignore", "inherit", "inherit"], ...opts });
    if (r.status !== 0 && !opts.allowFail) { console.error(`${cmd} ${args.join(" ")} failed`); process.exit(1); }
    return r;
}
const git = (args, opts) => run("git", args, opts);

if (git(["status", "--porcelain"], { quiet: true }).stdout.trim()) {
    console.error("Commit or stash the portal's changes first, so the published site matches a commit.");
    process.exit(1);
}
run(process.execPath, ["tools/build.mjs"]);
const source = git(["rev-parse", "--short", "HEAD"], { quiet: true }).stdout.trim();

const work = mkdtempSync(join(tmpdir(), "arcade-pages-"));
git(["fetch", "origin", BRANCH], { quiet: true, allowFail: true });
const remote = git(["rev-parse", "--verify", "--quiet", `origin/${BRANCH}`], { quiet: true, allowFail: true }).status === 0;
const local = git(["rev-parse", "--verify", "--quiet", BRANCH], { quiet: true, allowFail: true }).status === 0;
if (remote) git(["worktree", "add", "-B", BRANCH, work, `origin/${BRANCH}`], { quiet: true });
else if (local) git(["worktree", "add", work, BRANCH], { quiet: true });
else git(["worktree", "add", "--orphan", "-b", BRANCH, work], { quiet: true });

try {
    for (const f of readdirSync(work)) if (f !== ".git") rmSync(join(work, f), { recursive: true, force: true });
    cpSync(join(ROOT, "dist"), work, { recursive: true });
    writeFileSync(join(work, ".nojekyll"), ""); // serve files as they are; no Jekyll pass
    const g = (args, opts) => run("git", args, { cwd: work, ...opts });
    g(["add", "-A"], { quiet: true });
    if (!g(["status", "--porcelain"], { quiet: true }).stdout.trim()) console.log("The site hasn't changed since the last publish.");
    else {
        g(["commit", "-q", "-m", `Publish the site built from ${source}`]);
        if (dry) console.log(`Committed to ${BRANCH}; not pushed (--dry-run).`);
        else {
            g(["push", "-q", "origin", BRANCH]);
            console.log("Published: https://rohitpatil9121.github.io/arcade/ (Pages takes a minute or two to update)");
        }
    }
} finally {
    git(["worktree", "remove", "--force", work], { quiet: true, allowFail: true });
}
