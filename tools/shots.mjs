/**
 * Thumbnails from play, for games whose own screenshots only show a menu. Serves dist/, opens each game in
 * headless Chrome with the GPU, starts a round the way a player would, lets the bots play, and saves
 * shots/<id>.jpg. Point a catalog entry's `thumb` at the file to use it. Run tools/build.mjs first.
 *
 *   node tools/shots.mjs                 # every game listed below
 *   node tools/shots.mjs breach decoy    # just these
 */
import { writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launch } from "./chrome.mjs";

// the button that starts a round, and seconds to let it run (DECOY: past the seekers' blindfold)
const GAMES = {
    "breach": { start: "#practice", play: 9 },
    "decoy": { start: "#practice", play: 34 },
};

const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(GAMES);
const unknown = ids.filter((id) => !GAMES[id]);
if (unknown.length) { console.error(`No capture recipe for: ${unknown.join(", ")}`); process.exit(1); }

const out = new URL("../shots/", import.meta.url);
await mkdir(out, { recursive: true });
const port = 8700 + Math.floor(Math.random() * 90);
const server = spawn(process.execPath, [fileURLToPath(new URL("./serve.mjs", import.meta.url)), String(port)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 500));
const browser = await launch({ gpu: true });
let failed = 0;
try {
    for (const id of ids) {
        const { start, play } = GAMES[id];
        const page = await browser.page(`http://localhost:${port}/play/${id}/`, { width: 1280, height: 720 });
        try {
            await page.waitFor(`!!document.querySelector(${JSON.stringify(start)})?.offsetParent`, 30000);
            await page.evaluate(`document.querySelector(${JSON.stringify(start)}).click()`);
            await new Promise((r) => setTimeout(r, play * 1000));
            await writeFile(new URL(`${id}.jpg`, out), await page.screenshot("jpeg", 82));
            console.log(`${id}: shots/${id}.jpg`);
        } catch (e) {
            console.error(`${id}: ${e.message}`);
            failed++;
        }
    }
} finally {
    await browser.close();
    server.kill();
}
if (failed) process.exit(1);
