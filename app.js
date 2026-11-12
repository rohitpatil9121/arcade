/**
 * PROJECTION ARCADE: the whole site in one page. Routes live in the hash so any static host works:
 *   #/                 home: featured games, recently played, every game
 *   #/c/<genre>        one genre      #/saved   saved games      (the search box filters any list)
 *   #/game/<id>        a game's page; Play loads it in an iframe
 * catalog.json is written by tools/build.mjs. Saved and recent games stay in this browser's localStorage.
 */
const $ = (sel, root = document) => root.querySelector(sel);
const main = $("#main"), chips = $("#chips"), search = $("#q");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

const store = {
    get(key) { try { return JSON.parse(localStorage.getItem("arcade." + key)) || []; } catch { return []; } },
    set(key, list) { try { localStorage.setItem("arcade." + key, JSON.stringify(list)); } catch { /* private mode: keep it for this visit only */ } },
};
let saved = store.get("saved"), recent = store.get("recent");

let catalog = { featured: [], games: [] };
try {
    catalog = await (await fetch("catalog.json", { cache: "no-store" })).json();
} catch {
    main.innerHTML = `<section class="empty"><h1>The game list didn't load</h1><p>catalog.json is missing. Run <code>node tools/build.mjs</code> and reload.</p></section>`;
    throw new Error("catalog.json did not load");
}
const games = catalog.games, byId = new Map(games.map((g) => [g.id, g]));
const genres = [...new Set(games.flatMap((g) => g.genres))].sort();

const ICONS = {
    play: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5Z"/></svg>`,
    heart: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.5s-7.5-4.6-7.5-10.3A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.6c0 5.7-7.5 10.3-7.5 10.3Z"/></svg>`,
    full: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>`,
    exit: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>`,
    reload: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4.2h-4.2"/></svg>`,
    touch: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 18h2"/></svg>`,
    back: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>`,
};

function updateFavCount() { $("#fav-count").textContent = saved.length; }
function toggleSaved(id) {
    saved = saved.includes(id) ? saved.filter((x) => x !== id) : [id, ...saved];
    store.set("saved", saved);
    updateFavCount();
    for (const b of document.querySelectorAll(`[data-save="${id}"]`)) setSaveButton(b, id);
}
function setSaveButton(button, id) {
    const on = saved.includes(id);
    button.classList.toggle("on", on);
    button.setAttribute("aria-pressed", on);
    button.setAttribute("aria-label", on ? `Remove ${byId.get(id).title} from saved` : `Save ${byId.get(id).title}`);
    const label = button.querySelector(".label");
    if (label) label.textContent = on ? "Saved" : "Save";
}
function remember(id) {
    recent = [id, ...recent.filter((x) => x !== id)].slice(0, 8);
    store.set("recent", recent);
}

/** An image that fades in once loaded; `crop` [zoom, x%, y%] in the catalog pushes a game's HUD out of frame. */
function art(g, src, { cls = "", lazy = true, crop = true } = {}) {
    const [z, x, y] = (crop && g.crop) || [1, 50, 50];
    return `<img class="art ${cls}" src="${src}" alt="" width="1280" height="720"${lazy ? ` loading="lazy"` : ""} style="--z:${z};--fx:${x}%;--fy:${y}%" onload="this.classList.add('ready')">`;
}

function tile(g) {
    const cover = g.thumb
        ? art(g, g.thumb) + (g.thumbAlt ? art(g, g.thumbAlt, { cls: "alt", crop: false }) : "")
        : `<div class="nothumb">${esc(g.title)}</div>`;
    return `<li class="tile">
        <a href="#/game/${g.id}" class="tile-link">
            <div class="cover">${cover}${g.wip ? `<span class="badge">In progress</span>` : ""}<span class="hover-play">${ICONS.play}</span></div>
            <div class="tile-body">
                <h3>${esc(g.title)}</h3>
                <p class="meta">${g.genres.map(esc).join(" · ")}${g.touch ? `<span class="touch" title="Works on phones">${ICONS.touch}</span>` : ""}</p>
            </div>
        </a>
        <button class="save" data-save="${g.id}" type="button">${ICONS.heart}</button>
    </li>`;
}
function grid(list) {
    return `<ul class="grid">${list.map(tile).join("")}</ul>`;
}

function renderChips(active) {
    const link = (href, label, on) => `<a href="${href}"${on ? ` aria-current="page"` : ""}>${label}</a>`;
    chips.innerHTML = link("#/", "All games", active === "all")
        + genres.map((g) => link(`#/c/${slug(g)}`, esc(g), active === slug(g))).join("")
        + link("#/saved", `${ICONS.heart}Saved`, active === "saved");
    chips.querySelector("[aria-current]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function matches(g, q) {
    if (!q) return true;
    const text = [g.title, g.tagline, g.players, ...g.genres].join(" ").toLowerCase();
    return q.toLowerCase().split(/\s+/).every((word) => text.includes(word));
}

let heroTimer = 0;
function hero() {
    const list = catalog.featured.map((id) => byId.get(id)).filter(Boolean);
    if (!list.length) return "";
    const slides = list.map((g, i) => `
        <a class="slide${i === 0 ? " on" : ""}" href="#/game/${g.id}" tabindex="${i === 0 ? 0 : -1}" aria-hidden="${i !== 0}">
            ${g.thumb ? art(g, g.thumb, { lazy: i > 0 }) : ""}
            <div class="slide-text">
                <p class="kicker">Featured · ${g.genres.map(esc).join(" · ")}</p>
                <h2>${esc(g.title)}</h2>
                <p>${esc(g.tagline)}</p>
                <span class="btn primary">${ICONS.play}Play now</span>
            </div>
        </a>`).join("");
    // beside the slides on wide screens, dots below them on narrow ones; the bar fills while a slide is up
    const picks = list.map((g, i) => `
        <button type="button" class="pick${i === 0 ? " on" : ""}" data-slide="${i}" aria-label="Show ${esc(g.title)}">
            ${g.thumb ? `<span class="pick-art">${art(g, g.thumb, { lazy: false })}</span>` : ""}
            <span class="pick-text"><b>${esc(g.title)}</b><small>${g.genres.map(esc).join(" · ")}</small></span>
            <span class="pick-bar"></span>
        </button>`).join("");
    return `<section class="hero" aria-label="Featured games"><div class="stage-slides">${slides}</div><div class="picks">${picks}</div></section>`;
}
function startHero() {
    const root = $(".hero");
    if (!root) return;
    const slides = [...root.querySelectorAll(".slide")], picks = [...root.querySelectorAll(".pick")];
    let at = 0;
    const show = (i) => {
        at = (i + slides.length) % slides.length;
        slides.forEach((s, j) => { s.classList.toggle("on", j === at); s.tabIndex = j === at ? 0 : -1; s.setAttribute("aria-hidden", j !== at); });
        // re-adding the class restarts the fill animation on the picked bar
        picks.forEach((p, j) => p.classList.remove("on"));
        void root.offsetWidth;
        picks[at].classList.add("on");
    };
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const restart = () => { clearInterval(heroTimer); root.classList.remove("paused"); show(at); if (!still) heroTimer = setInterval(() => show(at + 1), 6000); };
    const pause = () => { clearInterval(heroTimer); root.classList.add("paused"); };
    picks.forEach((p, i) => p.addEventListener("click", () => { show(i); restart(); }));
    root.addEventListener("mouseenter", pause);
    root.addEventListener("mouseleave", restart);
    root.addEventListener("focusin", pause);
    if (still) root.classList.add("paused");
    restart();
}

function listPage(title, list, { showHero = false, emptyText } = {}) {
    const q = search.value.trim();
    const found = list.filter((g) => matches(g, q));
    const recentGames = recent.map((id) => byId.get(id)).filter(Boolean);
    let html = "";
    if (showHero && !q) {
        html += hero();
        if (recentGames.length) html += `<section class="row"><div class="row-head"><h2>Jump back in</h2></div>${grid(recentGames.slice(0, 4))}</section>`;
    }
    const heading = q ? `Results for “${esc(q)}”` : title;
    html += `<section class="row"><div class="row-head"><h1>${heading}</h1><span class="count">${found.length} ${found.length === 1 ? "game" : "games"}</span></div>`;
    html += found.length ? grid(found) : `<div class="empty"><p>${q ? `Nothing matches “${esc(q)}”. Try a genre, like <i>puzzle</i> or <i>co-op</i>.` : emptyText}</p></div>`;
    html += `</section>`;
    main.innerHTML = html;
    if (showHero && !q) startHero();
}

let stage = null;
function gamePage(g) {
    document.title = `${g.title} · PROJECTION ARCADE`;
    const more = games.filter((x) => x.id !== g.id)
        .sort((a, b) => b.genres.filter((t) => g.genres.includes(t)).length - a.genres.filter((t) => g.genres.includes(t)).length)
        .slice(0, 4);
    main.innerHTML = `
        <article class="game">
            <a class="crumb" href="#/">${ICONS.back}All games</a>
            <div class="stage" id="stage">
                <div class="loading" aria-hidden="true"><span class="spinner"></span><span>Loading ${esc(g.title)}…</span></div>
                <div class="poster">
                    ${g.thumb ? art(g, g.thumb, { lazy: false }) : ""}
                    <button class="big-play" id="start" type="button">${ICONS.play}<span>Play ${esc(g.title)}</span></button>
                    <p class="size">${g.mb} MB · runs in your browser, nothing to install</p>
                </div>
                <button class="stage-exit" id="exit" type="button" aria-label="Leave full screen">${ICONS.exit}</button>
            </div>
            <div class="bar">
                <div class="bar-title">
                    <h1>${esc(g.title)}</h1>
                    <p>${g.genres.map((t) => `<a class="tag" href="#/c/${slug(t)}">${esc(t)}</a>`).join("")}<span class="players">${esc(g.players)}</span></p>
                </div>
                <div class="bar-actions">
                    <button class="btn icon" id="reload" type="button" aria-label="Restart the game" disabled>${ICONS.reload}</button>
                    <button class="btn save-btn" data-save="${g.id}" type="button">${ICONS.heart}<span class="label">Save</span></button>
                    <button class="btn primary" id="full" type="button">${ICONS.full}<span>Full screen</span></button>
                </div>
            </div>
            <div class="about">
                <section>
                    <h2>About</h2>
                    <p class="lead">${esc(g.tagline)}</p>
                    <p>${esc(g.description)}</p>
                    ${g.online ? `<p class="note">${esc(g.online)}. Everything else plays right here.</p>` : ""}
                    ${g.wip ? `<p class="note">Still being built: expect rough edges.</p>` : ""}
                    ${g.credits ? `<p class="hint"><a href="${g.credits}" target="_blank" rel="noopener">Credits and licences</a></p>` : ""}
                </section>
                <section>
                    <h2>Controls</h2>
                    <table class="keys"><tbody>${g.controls.map(([what, key]) => `<tr><th scope="row">${esc(what)}</th><td>${esc(key)}</td></tr>`).join("")}</tbody></table>
                    <p class="hint">${g.touch ? "Touch controls show up on phones and tablets." : "Best with a keyboard and mouse."}</p>
                </section>
            </div>
            <section class="row"><div class="row-head"><h2>More to play</h2></div>${grid(more)}</section>
        </article>`;

    stage = $("#stage");
    const start = () => {
        if ($("iframe", stage)) return;
        const frame = document.createElement("iframe");
        frame.src = g.play;
        frame.title = g.title;
        frame.allow = "autoplay; fullscreen; gamepad; pointer-lock";
        frame.allowFullscreen = true;
        frame.addEventListener("load", () => { stage?.classList.remove("booting"); frame.contentWindow?.focus(); });
        stage.prepend(frame);
        stage.classList.add("playing", "booting");
        $("#reload").disabled = false;
        remember(g.id);
        // phones get the whole screen straight away; the page around the game is too cramped to play in
        if (matchMedia("(pointer: coarse) and (max-width: 900px)").matches) enterFull();
    };
    $("#start").addEventListener("click", start);
    $("#reload").addEventListener("click", () => { const f = $("iframe", stage); if (f) { stage.classList.add("booting"); f.src = g.play; f.focus(); } });
    $("#full").addEventListener("click", () => { start(); isFull() ? leaveFull() : enterFull(); });
    $("#exit").addEventListener("click", leaveFull);
}

// Full screen: the real Fullscreen API where there is one, otherwise (iPhone Safari) the stage covers the window
const isFull = () => !!document.fullscreenElement || !!stage?.classList.contains("theater");
function enterFull() {
    if (!stage) return;
    const real = stage.requestFullscreen || stage.webkitRequestFullscreen;
    const fallback = () => { stage.classList.add("theater"); document.body.classList.add("locked"); syncFull(); };
    if (real) Promise.resolve(real.call(stage, { navigationUI: "hide" })).then(() => screen.orientation?.lock?.("landscape").catch(() => {}), fallback);
    else fallback();
    $("iframe", stage)?.focus();
}
function leaveFull() {
    if (document.fullscreenElement) document.exitFullscreen();
    stage?.classList.remove("theater");
    document.body.classList.remove("locked");
    syncFull();
}
function syncFull() {
    const b = $("#full");
    if (!b) return;
    const on = isFull();
    b.innerHTML = on ? `${ICONS.exit}<span>Exit full screen</span>` : `${ICONS.full}<span>Full screen</span>`;
    stage.classList.toggle("is-full", on);
}
document.addEventListener("fullscreenchange", syncFull);
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && stage?.classList.contains("theater")) leaveFull();
    if (e.key === "/" && document.activeElement !== search && !/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)) { e.preventDefault(); search.focus(); }
});

function route() {
    clearInterval(heroTimer);
    leaveFull();
    stage = null;
    const parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
    document.title = "PROJECTION ARCADE";
    if (parts[0] === "game" && byId.has(parts[1])) {
        renderChips(null);
        gamePage(byId.get(parts[1]));
    } else if (parts[0] === "c" && genres.some((g) => slug(g) === parts[1])) {
        const genre = genres.find((g) => slug(g) === parts[1]);
        document.title = `${genre} games · PROJECTION ARCADE`;
        renderChips(parts[1]);
        listPage(`${genre} games`, games.filter((g) => g.genres.includes(genre)));
    } else if (parts[0] === "saved") {
        document.title = "Saved games · PROJECTION ARCADE";
        renderChips("saved");
        listPage("Saved games", saved.map((id) => byId.get(id)).filter(Boolean), { emptyText: "Nothing saved yet. Tap the heart on any game to keep it here." });
    } else {
        renderChips("all");
        listPage("All games", games, { showHero: true });
    }
    for (const b of document.querySelectorAll("[data-save]")) setSaveButton(b, b.dataset.save);
    window.scrollTo(0, 0);
}

main.addEventListener("click", (e) => {
    const b = e.target.closest("[data-save]");
    if (b) { e.preventDefault(); toggleSaved(b.dataset.save); }
});
// typing on a game's page goes back to the list; on a list, it filters in place
search.addEventListener("input", () => {
    if (location.hash.startsWith("#/game/")) location.hash = "#/";
    else {
        const y = window.scrollY;
        route();
        window.scrollTo(0, Math.min(y, $(".hero")?.offsetHeight ?? 0));
        search.focus();
    }
});
search.addEventListener("keydown", (e) => { if (e.key === "Escape") { search.value = ""; search.dispatchEvent(new Event("input")); } });
addEventListener("hashchange", route);
updateFavCount();
route();
