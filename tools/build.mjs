/**
 * PROJECTION ARCADE: put the site, every game's static build and the thumbnails together in dist/, ready for
 * GitHub Pages (or any static host). Each game is copied from the folder its catalog entry names; a game with
 * a `build` step has it run first when its folder is missing, or for every game with --rebuild.
 *
 *   node tools/build.mjs              # copy what is there
 *   node tools/build.mjs --rebuild    # run each game's own build-itch.mjs first
 *   node tools/build.mjs faultline    # only these games (the site and catalog are always rewritten)
 */
import { cpSync, rmSync, mkdirSync, readdirSync, statSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve, extname } from "node:path";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUT = join(ROOT, "dist");
const args = process.argv.slice(2);
const rebuild = args.includes("--rebuild");
const only = args.filter((a) => !a.startsWith("--"));
const catalog = JSON.parse(readFileSync(join(ROOT, "catalog.json"), "utf8"));
const unknown = only.filter((id) => !catalog.games.some((g) => g.id === id));
if (unknown.length) { console.error(`Not in catalog.json: ${unknown.join(", ")}`); process.exit(1); }

// what a game folder may hold that its page never loads
const SKIP = /[\\/](node_modules|\.git|tools|screenshots|artifacts|marketing|notes|scratch|models-src|dist)([\\/]|$)|[\\/](README|GDD|NOTES|QA|MODEL-PROMPTS)\.md$|[\\/]package(-lock)?\.json$/;
const size = (p) => statSync(p).isDirectory() ? readdirSync(p).reduce((n, f) => n + size(join(p, f)), 0) : statSync(p).size;
const mb = (n) => (n / 1e6).toFixed(1);

mkdirSync(OUT, { recursive: true });
cpSync(join(ROOT, "site"), OUT, { recursive: true });
mkdirSync(join(OUT, "play"), { recursive: true });
mkdirSync(join(OUT, "thumbs"), { recursive: true });

let failed = 0;
const listed = [];
for (const game of catalog.games) {
    const { source, thumb, thumbAlt, ...entry } = game;
    const from = resolve(ROOT, source.dir), to = join(OUT, "play", game.id);
    if (game.hold) {
        rmSync(to, { recursive: true, force: true });
        console.log(`${game.id.padEnd(14)}  held back: ${game.hold}`);
        continue;
    }
    if (!only.length || only.includes(game.id)) {
        if (source.build && (rebuild || !existsSync(from))) {
            console.log(`${game.id}: ${source.build.cmd}`);
            const r = spawnSync(source.build.cmd, { cwd: resolve(ROOT, source.build.cwd), shell: true, stdio: "inherit" });
            if (r.status !== 0) { console.error(`${game.id}: its build failed, skipped`); failed++; continue; }
        }
        if (!existsSync(join(from, "index.html"))) { console.error(`${game.id}: no index.html in ${from}, skipped`); failed++; continue; }
        rmSync(to, { recursive: true, force: true });
        cpSync(from, to, { recursive: true, filter: (src) => !SKIP.test(src.slice(from.length)) });
        // the licences travel with the game, even when its own build leaves them out
        const licence = [from, source.build && resolve(ROOT, source.build.cwd)].filter(Boolean).map((d) => join(d, "THIRD_PARTY.md")).find(existsSync);
        if (licence && !existsSync(join(to, "THIRD_PARTY.md"))) cpSync(licence, join(to, "THIRD_PARTY.md"));
        for (const [key, file] of [["thumb", thumb], ["thumbAlt", thumbAlt]]) {
            if (!file) continue;
            const path = resolve(ROOT, file);
            if (existsSync(path)) cpSync(path, join(OUT, "thumbs", `${game.id}${key === "thumbAlt" ? "-alt" : ""}${extname(path)}`));
            else console.error(`${game.id}: no ${key} at ${path}`);
        }
        console.log(`${game.id.padEnd(14)} ${mb(size(to)).padStart(5)} MB  from ${source.dir}`);
    }
    if (!existsSync(join(to, "index.html"))) continue;
    const ext = (f) => (f ? extname(f) : ".jpg");
    listed.push({
        ...entry,
        play: `play/${game.id}/`,
        thumb: thumb && existsSync(join(OUT, "thumbs", game.id + ext(thumb))) ? `thumbs/${game.id}${ext(thumb)}` : null,
        thumbAlt: thumbAlt && existsSync(join(OUT, "thumbs", `${game.id}-alt${ext(thumbAlt)}`)) ? `thumbs/${game.id}-alt${ext(thumbAlt)}` : null,
        mb: Number(mb(size(to))),
        credits: existsSync(join(to, "THIRD_PARTY.md")) ? `play/${game.id}/THIRD_PARTY.md` : null,
    });
}
// games removed from catalog.json leave no folder behind
for (const dir of readdirSync(join(OUT, "play"))) if (!catalog.games.some((g) => g.id === dir)) rmSync(join(OUT, "play", dir), { recursive: true, force: true });
// and no thumbnail of a game that is held back or gone
const thumbs = new Set(listed.flatMap((g) => [g.thumb, g.thumbAlt]).filter(Boolean).map((t) => t.slice("thumbs/".length)));
for (const file of readdirSync(join(OUT, "thumbs"))) if (!thumbs.has(file)) rmSync(join(OUT, "thumbs", file));

const featured = catalog.featured.filter((id) => listed.some((g) => g.id === id));
writeFileSync(join(OUT, "catalog.json"), JSON.stringify({ featured, games: listed }, null, 2) + "\n");
console.log(`dist: ${listed.length} games, ${mb(size(OUT))} MB${failed ? `, ${failed} failed` : ""}`);
if (failed) process.exit(1);
