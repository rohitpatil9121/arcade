# PROJECTION ARCADE

A web portal for the Projection Lab games: a home page of game tiles with genre filters and search, and a page per game that plays it in an iframe with a full-screen button. It is all static files, so GitHub Pages or any other static host can serve it. There are no accounts: saved games and recent plays are kept in the browser's localStorage.

## Run it

```bash
node tools/build.mjs
```

```bash
npm start
```

Then open http://localhost:5198/.

`tools/build.mjs` writes everything to `dist/`: the site from `site/`, each game's static build under `dist/play/<id>/`, the thumbnails under `dist/thumbs/`, and a `catalog.json` the page reads.

- `node tools/build.mjs --rebuild` runs each game's own `tools/build-itch.mjs` first (FAULTLINE, ROPE TEAM and HEXHAUL have one). Without it, a game is only rebuilt when its build folder is missing.
- `node tools/build.mjs faultline` copies just that game again. The site and the catalog are always rewritten.

## Adding a game

Add an entry to `catalog.json`:

| Field | What it is |
|---|---|
| `id` | Folder name under `play/` and the address `#/game/<id>` |
| `title`, `tagline`, `description` | Shown on the tile and the game page |
| `genres` | The first one or two become the category chips |
| `players` | A short line such as `Solo` or `1–4, bots` |
| `controls` | `[action, keys]` pairs for the game page |
| `touch` | `true` if it plays on a phone |
| `online` | Set when online play needs the game's Node server; the portal says so |
| `wip` | `true` puts an "In progress" badge on the tile |
| `source.dir` | The static build to copy, relative to this folder |
| `source.build` | Optional: `{ cwd, cmd }` that makes `source.dir` |
| `thumb`, `thumbAlt` | 16:9 images; the second one shows when a tile is hovered |

`featured` at the top lists the games in the carousel on the home page.

Where the games come from now: FAULTLINE, ROPE TEAM and HEXHAUL from their own `dist/itch`, and the other nine from the `games` repository next to this one, which already holds Pages-ready copies and the card shots in `games/shots/`.

## Publishing

Push the contents of `dist/` to whatever the host serves, for example a `gh-pages` branch. All links are relative, so it works from a subfolder such as `username.github.io/arcade/`. Multiplayer games run their Practice or bot modes here; online rooms still need each game's own server.
