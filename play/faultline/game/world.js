import { Entity, Mesh, InstancedMesh, StandardMaterial, BasicMaterial, ParticleSystem, Geometry, ShadowMap, primitives, quat, loadGLTF } from "../engine/index.js";
import { part, vehicleGeometry, driverGeometry, wheelGeometry, coinGeometry, fuelGeometry, chargeGeometry, postGeometry, rockGeometry, tuftGeometry, landmarkGeometry, skyMaterial } from "./gfx.js";
import { WARN, MOVE, noise } from "./terrain.js";

/**
 * FAULTLINE: everything drawn. Reads a Run, never changes it.
 *
 * The ground is one strip of geometry rebuilt every frame from h(x, t): a top surface with depth and a
 * front face cut into strata. The strata are placed relative to the top, so when a heave lifts the ground
 * the layers lift with it. Behind it, three parallax layers of real geometry (near rocks, mid hills, far
 * peaks) sink into the fog. World axes: x along the track, z up, y into the screen.
 * @module game/world
 */

const COLS = 330, DX = 0.5, BACK = 55;
const TOP_Y = [-3, -1.2, 1.2, 3.2, 6.5, 14];
const TOP_LIFT = [0, 0, 0, 0, 0.35, 1.6];
/** strata on the front face: [depth below the top where the band ends, which colour, how light] */
const BANDS = [[0.22, "top", 0.78], [0.8, "soil", 1.05], [1.5, "soil", 0.86], [2.6, "soil", 1], [3.6, "rock", 1.1], [5.2, "rock", 0.85], [7.5, "rock", 1], [11, "deep", 1.1], [18, "deep", 0.85], [45, "deep", 0.7]];
const PER = TOP_Y.length + BANDS.length * 2;
const LANE = { player: -0.75, rival: 1.6 };
const hash = (i) => { const s = Math.sin(i * 12.9898) * 43758.5453; return s - Math.floor(s); };

/** a strip of quads drawn every frame from a height function */
class GroundStrip {
    constructor() {
        const n = COLS * PER;
        this.positions = new Float32Array(n * 3);
        this.normals = new Float32Array(n * 3);
        this.colors = new Float32Array(n * 4);
        const idx = [];
        for (let i = 0; i < COLS - 1; i++) {
            const a = i * PER, b = (i + 1) * PER;
            for (let k = 0; k < TOP_Y.length - 1; k++) idx.push(a + k, b + k, b + k + 1, a + k, b + k + 1, a + k + 1);
            // each band has its own two vertices per column, so its colour stops at a hard line
            for (let r = 0; r < BANDS.length; r++) { const u = TOP_Y.length + r * 2; idx.push(a + u, b + u + 1, b + u, a + u, a + u + 1, b + u + 1); }
        }
        this.geometry = new Geometry({ positions: this.positions, normals: this.normals, colors: this.colors, indices: new Uint32Array(idx), dynamic: true, name: "ground" });
        this.entity = new Entity({ name: "ground", mesh: new Mesh(this.geometry, new StandardMaterial({ vertexColors: true, specular: 0.04, cull: "none" })), frustumCulled: false });
        this.heights = new Float32Array(COLS);
    }

    /** rebuild for the view starting at x0 */
    build(T, t, x0, pal) {
        const H = this.heights, P = this.positions, N = this.normals, Cc = this.colors;
        for (let i = 0; i < COLS; i++) H[i] = T.h(x0 + i * DX, t);
        for (let i = 0; i < COLS; i++) {
            const x = x0 + i * DX, h = H[i];
            const hl = H[Math.max(0, i - 1)], hr = H[Math.min(COLS - 1, i + 1)];
            let nx = -(hr - hl) / (2 * DX), nz = 1;
            const nl = Math.hypot(nx, nz); nx /= nl; nz /= nl;
            const world = Math.round(x / DX), v = 0.9 + 0.12 * hash(world), surf = T.surface(x);
            let o = i * PER;
            for (let k = 0; k < TOP_Y.length; k++, o++) {
                const lift = TOP_LIFT[k] * (0.6 + 0.8 * hash(world * 0.37 + k));
                P[o * 3] = x; P[o * 3 + 1] = TOP_Y[k]; P[o * 3 + 2] = h + lift;
                N[o * 3] = nx; N[o * 3 + 1] = 0; N[o * 3 + 2] = nz;
                let c = pal.top;
                if (surf === "ice") c = pal.ice || c; else if (surf === "mud") c = pal.mud || c;
                const edge = k === 0 ? 0.92 : 1;
                Cc[o * 4] = c[0] * v * edge; Cc[o * 4 + 1] = c[1] * v * edge; Cc[o * 4 + 2] = c[2] * v * edge; Cc[o * 4 + 3] = 1;
            }
            // strata hang from the top, so a heave lifts them; their edges wave along x
            let above = 0;
            for (let r = 0; r < BANDS.length; r++) {
                const [depth, name, light] = BANDS[r];
                const below = r === BANDS.length - 1 ? depth : depth + 0.35 * noise(x / 7 + r * 5.3, 91) * Math.min(1, depth / 2);
                const c = pal[name], k = light * (0.94 + 0.08 * noise(x / 3 + r, 77));
                for (const d of [above, below]) {
                    P[o * 3] = x; P[o * 3 + 1] = TOP_Y[0]; P[o * 3 + 2] = h - d;
                    N[o * 3] = 0; N[o * 3 + 1] = -1; N[o * 3 + 2] = 0.15;
                    Cc[o * 4] = c[0] * k; Cc[o * 4 + 1] = c[1] * k; Cc[o * 4 + 2] = c[2] * k; Cc[o * 4 + 3] = 1;
                    o++;
                }
                above = below;
            }
        }
        this.geometry.markDirty();
        this.x0 = x0;
    }

    /** ground height at x from the last build (for props), or NaN off the strip */
    at(x) {
        const i = Math.round((x - this.x0) / DX);
        return i >= 0 && i < COLS ? this.heights[i] : NaN;
    }
}

/** a far silhouette of hills, real geometry so perspective gives the parallax */
class Layer {
    constructor(y, half, cols, amp, base, wave, seed) {
        Object.assign(this, { y, half, cols, amp, base, wave, seed });
        this.positions = new Float32Array(cols * 2 * 3);
        this.normals = new Float32Array(cols * 2 * 3);
        this.colors = new Float32Array(cols * 2 * 4);
        const idx = [];
        for (let i = 0; i < cols - 1; i++) { const a = i * 2; idx.push(a, a + 3, a + 2, a, a + 1, a + 3); }
        this.geometry = new Geometry({ positions: this.positions, normals: this.normals, colors: this.colors, indices: new Uint16Array(idx), dynamic: true, name: "layer" });
        this.entity = new Entity({ name: "layer", mesh: new Mesh(this.geometry, new StandardMaterial({ vertexColors: true, cull: "none" })), frustumCulled: false, castShadow: false });
    }
    build(cx, color) {
        const step = (this.half * 2) / (this.cols - 1), x0 = Math.floor((cx - this.half) / step) * step;
        for (let i = 0; i < this.cols; i++) {
            const x = x0 + i * step;
            let h = 0;
            for (let k = 0; k < 3; k++) h += noise(x / (this.wave / (k + 1) ** 1.6), this.seed + k * 13) * (k === 0 ? 1 : 0.45 / k);
            const top = this.base + (h * 0.5 + 0.55) * this.amp, shade = 0.9 + 0.1 * noise(x / 9, this.seed + 5);
            const p = i * 2;
            this.positions.set([x, this.y, top, x, this.y, this.base - 140], p * 3);
            this.normals.set([0, -0.6, 0.8, 0, -1, 0], p * 3);
            this.colors.set([color[0] * shade, color[1] * shade, color[2] * shade, 1, color[0] * 0.7, color[1] * 0.7, color[2] * 0.7, 1], p * 4);
        }
        this.geometry.markDirty();
    }
}

/**
 * Vehicles with a model file (built by tools/models/). Each file has a `body` node (origin at the physics
 * body centre), `wheel_rear` and `wheel_front` (both tyres of an axle, origin at the hub) and a `paint`
 * material. A vehicle without a file, or whose file fails to load, keeps the shape built in gfx.js.
 * Pip has a file of their own: one `pip` node with its origin at the helmet centre and a `helmet` material,
 * put on each vehicle's physics head. Without it, Pip is built in gfx.js too.
 */
const MODEL_FILES = {
    buggy: "assets/models/buggy.glb", van: "assets/models/van.glb", tractor: "assets/models/tractor.glb",
    kite: "assets/models/kite.glb", pip: "assets/models/pip.glb",
};
const MODEL_PARTS = { pip: ["pip"], default: ["body", "wheel_rear", "wheel_front"] };
const BODY_LOOK = { specular: 0.35, shininess: 30, rim: [0.18, 0.18, 0.2] };
// glTF stores linear colour; this engine lights and shows colours as they are (sRGB)
const toDisplay = (c) => c.map((v) => Math.pow(Math.max(0, v), 1 / 2.2));

function loadVehicleModels() {
    const material = (info) => new StandardMaterial({
        color: toDisplay(info.color), emissive: toDisplay(info.emissive), specular: 0.5 * (1 - info.roughness), shininess: 30,
    });
    return Promise.all(Object.entries(MODEL_FILES).map(([id, url]) => loadGLTF(url, { material }).then((asset) => {
        const names = new Set(asset.nodes.map((n) => n.name));
        const missing = (MODEL_PARTS[id] || MODEL_PARTS.default).filter((p) => !names.has(p));
        if (missing.length) throw new Error(`no ${missing.join(", ")} node`);
        return [id, asset];
    }).catch((err) => {
        console.warn(`FAULTLINE: ${url} not used, keeping the built-in shape.`, err);
        return null;
    }))).then((list) => Object.fromEntries(list.filter(Boolean)));
}

/**
 * Props from model files (built from the reference sheets in models-src/): the pickups, the cache crate, and a
 * rock set, tuft and landmark per biome. They are drawn instanced or merged, so each node is baked into one
 * vertex-coloured geometry. Anything missing keeps the shape built in gfx.js.
 */
const BIOMES = ["mesa", "glacier", "ash", "delta"];
const PROP_FILES = {
    pickups: "assets/models/pickups.glb", cache: "assets/models/cache.glb",
    ...Object.fromEntries(BIOMES.flatMap((b) => [[`rocks_${b}`, `assets/models/rocks_${b}.glb`], [`landmark_${b}`, `assets/models/landmark_${b}.glb`]])),
};

function loadProps() {
    const material = (info) => new StandardMaterial({ color: toDisplay(info.color), emissive: toDisplay(info.emissive), map: info.map });
    return Promise.all(Object.entries(PROP_FILES).map(([id, url]) => loadGLTF(url, { material }).then((asset) => [id, asset])
        .catch((err) => { console.warn(`FAULTLINE: ${url} not used, keeping the built-in shape.`, err); return null; })))
        .then((list) => Object.fromEntries(list.filter(Boolean)));
}

/** give a mesh new geometry; its vertex arrays are cached per geometry version, so they must be rebuilt */
function setGeometry(mesh, geo) {
    mesh.geometry = geo;
    mesh._vaos = new WeakMap();
}

/**
 * One mesh of a model as a single upright geometry, or null if the file has no such mesh. Colours come from the
 * materials (as vertex colours) or from COLOR_0; a textured mesh (the scenery) keeps its UVs and hands its
 * texture over as `geo.map`.
 */
function bakeNode(asset, name) {
    const mesh = asset && asset.meshes.find((m) => m.name === name);
    if (!mesh) return null;
    const parts = mesh.primitives.map((p) => {
        const g = p.geometry;
        if (g.colors && !g.displayColors) {
            // COLOR_0 is linear (and may arrive as normalised integers); the engine shows colours as they are
            let max = 0;
            for (let i = 0; i < g.colors.length; i++) max = Math.max(max, g.colors[i]);
            const k = max > 255 ? 1 / 65535 : max > 1.001 ? 1 / 255 : 1;
            for (let i = 0; i < g.colors.length; i++) g.colors[i] = i % 4 === 3 ? g.colors[i] * k : Math.pow(Math.max(0, g.colors[i] * k), 1 / 2.2);
            g.displayColors = true;
        }
        return part(g, [0, 0, 0], [Math.PI / 2, 0, 0], [1, 1, 1], g.colors ? null : p.material.color);
    });
    const geo = Geometry.merge(parts, { name });
    geo.computeBounds();
    geo.map = mesh.primitives[0].material.map || null;
    return geo;
}

/** a material for baked scenery: its projected texture, or its vertex colours when it has none */
function sceneryMaterial(geo, opts = {}) {
    return new StandardMaterial(geo.map ? { map: geo.map, specular: 0.05, ...opts } : { vertexColors: true, specular: 0.05, ...opts });
}

/** one named node of a model, stood upright, with the materials named in `swap` replaced (paint, helmet) */
function modelPart(asset, name, swap) {
    let node = null;
    const find = (e) => { if (e.name === name) node = e; else e.children.forEach(find); };
    find(asset.instantiate());
    node.parent.remove(node);
    node.setPosition(0, 0, 0);
    const fix = (e) => {
        e.frustumCulled = false;
        const mat = e.mesh && swap[e.mesh.material.name];
        if (mat) e.mesh = new Mesh(e.mesh.geometry, mat);
        e.children.forEach(fix);
    };
    fix(node);
    const holder = new Entity({ name, frustumCulled: false });
    quat.copy(holder.rotation, asset.upright);
    holder.add(node);
    return holder;
}

/** a vehicle on screen: chassis and driver, wheels apart (they turn and travel) */
class VehicleView {
    constructor(scene, v, paint, helmet, lane, model = null, pip = null) {
        this.v = v;
        this.lane = lane;
        const [cx, cy] = v.spec.com;
        if (model) {
            // the file's body is centred on the body box; the physics origin is the centre of mass
            const paintMat = new StandardMaterial({ color: paint, ...BODY_LOOK });
            this.body = scene.add(new Entity({ name: v.name, frustumCulled: false, mesh: pip ? null
                : new Mesh(driverGeometry(v.spec, helmet), new StandardMaterial({ vertexColors: true, ...BODY_LOOK })) }));
            const shell = modelPart(model, "body", { paint: paintMat });
            shell.setPosition(-cx, 0, -cy);
            this.body.add(shell);
            this.wheels = v.wheels.map((w) => {
                const e = scene.add(new Entity({ name: "wheel", frustumCulled: false }));
                e.add(modelPart(model, w.lx < 0 ? "wheel_rear" : "wheel_front", { paint: paintMat }));
                return e;
            });
            this.struts = [];      // the model has its own springs and arms
        } else {
            this.body = scene.add(new Entity({ name: v.name, mesh: new Mesh(vehicleGeometry(v.spec, paint, helmet, !pip), new StandardMaterial({ vertexColors: true, ...BODY_LOOK })), frustumCulled: false }));
            const mat = new StandardMaterial({ vertexColors: true, specular: 0.2 });
            this.wheels = v.wheels.map((w) => scene.add(new Entity({ name: "wheel", mesh: new Mesh(wheelGeometry(w.r), mat), frustumCulled: false })));
            const strut = new StandardMaterial({ color: [0.55, 0.57, 0.6], specular: 0.5 });
            this.struts = v.wheels.map(() => scene.add(new Entity({ name: "strut", mesh: new Mesh(primitives.cylinder(0.06, 0.06, 1, 6), strut), frustumCulled: false, castShadow: false })));
        }
        if (pip) {
            // Pip's helmet centre sits on the physics head, so the run ends where the helmet visibly lands
            const driver = modelPart(pip, "pip", { helmet: new StandardMaterial({ color: helmet, specular: 0.5, shininess: 40 }) });
            driver.setPosition(v.spec.head[0] - cx, 0, v.spec.head[1] - cy);
            this.body.add(driver);
        }
        this.q = quat.create();
        this.place(true);
    }
    place(teleport = false) {
        const v = this.v, y = this.lane;
        this.body.position[0] = v.x; this.body.position[1] = y; this.body.position[2] = v.y;
        quat.setAxisAngle(this.body.rotation, [0, 1, 0], -v.a);
        v.wheels.forEach((w, i) => {
            const e = this.wheels[i];
            e.position[0] = w.x; e.position[1] = y; e.position[2] = w.y;
            quat.setAxisAngle(e.rotation, [0, 1, 0], -w.angle);
            if (teleport) e.teleport();
            // a strut from the mount to the wheel, on the near side
            const st = this.struts[i];
            if (!st) return;
            const c = Math.cos(v.a), s = Math.sin(v.a);
            const mx = v.x + w.lx * c - w.ly * s, my = v.y + w.lx * s + w.ly * c;
            st.position[0] = (mx + w.x) / 2; st.position[1] = y - 0.55; st.position[2] = (my + w.y) / 2;
            quat.setAxisAngle(st.rotation, [0, 1, 0], -v.a);
            st.scale[2] = Math.max(0.05, Math.hypot(mx - w.x, my - w.y));
            if (teleport) st.teleport();
        });
        if (teleport) this.body.teleport();
    }
    remove(scene) { scene.remove(this.body); for (const e of [...this.wheels, ...this.struts]) scene.remove(e); }
}

export class World {
    /** @param {import("../engine/index.js").Game} game */
    constructor(game) {
        this.game = game;
        const scene = game.scene;
        this.scene = scene;
        const sun = [-0.35, -0.6, 0.72], l = Math.hypot(...sun);
        scene.sunDirection.set(sun.map((v) => v / l));
        scene.sunColor.set([1.08, 0.97, 0.85]);
        this.highShadow = new ShadowMap({ cascades: 2, distance: 60, size: 2048, strength: 0.6 });
        this.mediumShadow = null;
        scene.shadow = this.highShadow;

        this.sky = scene.add(new Entity({ name: "sky", castShadow: false, frustumCulled: false, mesh: new Mesh(primitives.sphere(600, 24, 16), skyMaterial()) }));
        this.strip = new GroundStrip();
        scene.add(this.strip.entity);
        this.layers = [
            new Layer(24, 70, 90, 9, -6, 40, 11),
            new Layer(80, 150, 90, 18, -10, 120, 23),
            new Layer(280, 420, 90, 58, -18, 360, 37),
        ];
        for (const L of this.layers) scene.add(L.entity);
        this.landmark = scene.add(new Entity({ name: "landmark", castShadow: false, frustumCulled: false }));

        // water for the tide: a sheet over the flats and out to the hills
        this.waterMat = new StandardMaterial({ color: [0.3, 0.56, 0.55], opacity: 0.78, transparent: true, specular: 0.9, shininess: 80, depthWrite: false });
        this.water = scene.add(new Entity({ name: "water", castShadow: false, frustumCulled: false, mesh: new Mesh(primitives.plane(260, 160, 1, 1), this.waterMat), visible: false }));

        // pickups, posts, props
        this.coins = this.instanced(coinGeometry(), 140, { specular: 0.9, shininess: 60, emissive: [0.25, 0.17, 0.02] });
        this.cans = this.instanced(fuelGeometry(), 8, { specular: 0.4 });
        this.charges = this.instanced(chargeGeometry(), 8, { emissive: [0.35, 0.1, 0.6], specular: 0.6 });
        this.posts = this.instanced(postGeometry(), 4, { specular: 0.2 });
        this.rocks = [0, 1, 2].map((s) => this.instanced(rockGeometry(s), 14, { specular: 0.05 }, true));
        this.tufts = this.instanced(tuftGeometry(), 90, { specular: 0.05 }, false, true);
        this.vents = this.instanced(primitives.cone(1.4, 0.9, 10), 6, { color: [0.22, 0.18, 0.18] });
        this.best = scene.add(new Entity({ name: "best", frustumCulled: false, mesh: new Mesh(Geometry.merge([
            { geometry: primitives.cylinder(0.08, 0.08, 4, 6), matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 2, 1], color: [0.95, 0.95, 0.95] },
            { geometry: primitives.box(1.2, 0.05, 0.75), matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.62, 0, 3.55, 1], color: [1, 0.78, 0.15] },
        ]), new StandardMaterial({ vertexColors: true, emissive: [0.2, 0.15, 0] })) }));

        // the warning glow and the charge marker
        this.glowCap = 3200;
        this.glowPos = new Float32Array(this.glowCap * 3);
        this.glowCol = new Float32Array(this.glowCap * 4);
        const gIdx = new Uint16Array((this.glowCap / 4) * 6);
        for (let q = 0; q < this.glowCap / 4; q++) gIdx.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
        this.glowGeo = new Geometry({ positions: this.glowPos, colors: this.glowCol, indices: gIdx, dynamic: true, name: "glow" });
        scene.add(new Entity({ name: "glow", castShadow: false, frustumCulled: false, mesh: new Mesh(this.glowGeo, new BasicMaterial({ vertexColors: true, lit: false, transparent: true, depthWrite: false, cull: "none" })) }));
        this.aim = scene.add(new Entity({ name: "aim", castShadow: false, frustumCulled: false, visible: false, mesh: new Mesh(primitives.cylinder(0.5, 0.5, 18, 16, false), new BasicMaterial({ color: [0.7, 0.35, 1.4], lit: false, transparent: true, opacity: 0.45, blending: "additive", depthWrite: false, cull: "none" })) }));

        // particles
        this.dust = new ParticleSystem({ capacity: 2500, gravity: [0, 0, -2.5], drag: 1.4, blending: "normal", name: "dust" });
        this.sparks = new ParticleSystem({ capacity: 1500, gravity: [0, 0, -12], drag: 0.6, blending: "additive", name: "sparks" });
        scene.add(this.dust); scene.add(this.sparks);

        this.views = [];
        // vehicles start with their built-in shapes and switch to the model files once those have loaded
        this.models = {};
        this.modelsReady = loadVehicleModels().then((models) => {
            this.models = models;
            if (this.run) this.showVehicles();
        });
        this.props = {};
        this.biomeProps = {};
        this.propsReady = loadProps().then((props) => {
            this.props = props;
            this.applyProps();
        });
        this.camX = 0; this.camZ = 0; this.camDist = 18; this.lean = 0;
        this.reducedMotion = false;
        this.particleScale = 1;
        this.time = 0;
    }

    instanced(geo, n, opts, rock = false, tuft = false) {
        const mesh = new InstancedMesh(geo, new StandardMaterial({ vertexColors: !!geo.colors, ...opts }), n);
        for (let i = 0; i < n; i++) mesh.setTransform(i, 0, 0, -500, 0.001);
        this.scene.add(new Entity({ mesh, frustumCulled: false, castShadow: !tuft }));
        mesh.n = n; mesh.rock = rock;
        return mesh;
    }

    setQuality(name) {
        const r = this.game.renderer;
        r.setQuality(name === "high" ? "high" : name);
        if (r.postfx) { r.postfx.settings.ao.enabled = name === "high"; r.postfx.settings.bloom.enabled = name !== "low"; }
        this.scene.shadow = name === "low" ? null : name === "medium" ? (this.mediumShadow ||= new ShadowMap({ cascades: 1, distance: 45, size: 1024, strength: 0.6 })) : this.highShadow;
        this.particleScale = name === "low" ? 0.4 : name === "medium" ? 0.7 : 1;
    }

    /** colours, sky and props for a biome */
    setBiome(biome) {
        this.biome = biome;
        const c = biome.colors, s = this.scene;
        this.pal = { ...c, ice: [0.78, 0.92, 1.0], mud: [0.36, 0.3, 0.2] };
        const sky = this.sky.mesh.material.values;
        sky.u_zenith.set(biome.sky.zenith); sky.u_horizon.set(biome.sky.horizon);
        s.fogColor.set(biome.sky.fog); s.fogDensity = 0.0048;
        s.clearColor.set([...biome.sky.horizon, 1]);
        s.skyColor.set(biome.sky.zenith.map((v) => v * 0.9 + 0.12));
        s.groundColor.set(c.soil.map((v) => v * 0.45));
        this.landmark.mesh = new Mesh(landmarkGeometry(biome.landmark), new StandardMaterial({ vertexColors: true, emissive: biome.landmark === "cone" ? [0.25, 0.05, 0] : [0, 0, 0] }));
        this.water.visible = !!biome.tide;
        const tuft = { mesa: [0.85, 0.72, 0.38], glacier: [0.85, 0.95, 1.1], ash: [0.4, 0.25, 0.2], delta: [0.45, 0.62, 0.3] }[biome.id];
        this.tufts.material.color.set(tuft);
        for (const r of this.rocks) r.material.color.set(c.rock.map((v) => v * 1.5));
        this.vents.material.color.set(c.rock);
        this.applyBiomeProps(biome);
    }

    /** swap the pickups and the cache crate to their model files, once those have loaded */
    applyProps() {
        const p = this.props.pickups;
        for (const [mesh, name] of [[this.coins, "coin"], [this.cans, "fuel"], [this.charges, "charge"], [this.posts, "post"]]) {
            const geo = bakeNode(p, name);
            if (geo) setGeometry(mesh, geo);
        }
        const crate = bakeNode(this.props.cache, "cache");
        if (crate) this.crates = this.instanced(crate, 2, { specular: 0.2 });
        if (this.biome) this.applyBiomeProps(this.biome);
    }

    /** this biome's rocks, tuft and landmark from their model files (they carry their own colours) */
    applyBiomeProps(biome) {
        const id = biome.id;
        if (!this.biomeProps[id]) {
            const rocks = this.props[`rocks_${id}`], lm = this.props[`landmark_${id}`];
            if (!rocks && !lm) return;
            this.biomeProps[id] = {
                rocks: ["rock_round", "rock_tall", "rock_flat"].map((n) => bakeNode(rocks, n)),
                tuft: bakeNode(rocks, "tuft"),
                landmark: bakeNode(lm, `landmark_${id}`),
            };
        }
        const b = this.biomeProps[id];
        // the built-in rocks and tufts were tinted per biome; these carry their own colours
        b.rocks.forEach((geo, i) => {
            if (!geo) return;
            setGeometry(this.rocks[i], geo);
            this.rocks[i].material = sceneryMaterial(geo);
        });
        if (b.tuft) { setGeometry(this.tufts, b.tuft); this.tufts.material = sceneryMaterial(b.tuft); }
        if (b.landmark) this.landmark.mesh = new Mesh(b.landmark, sceneryMaterial(b.landmark, { emissive: id === "ash" ? [0.12, 0.03, 0] : [0, 0, 0] }));
    }

    /** show a run's vehicles */
    attach(run, paints) {
        this.run = run;
        this.paints = paints;
        this.showVehicles();
        this.dust.clear(); this.sparks.clear();
        this.camX = run.player.x + 6; this.camZ = run.player.y + 2;
        this.prev = { x: run.player.x, y: run.player.y };
    }

    /** (re)build the views of the attached run's vehicles, from model files where they have loaded */
    showVehicles() {
        const run = this.run, paints = this.paints;
        for (const v of this.views) v.remove(this.scene);
        this.views = run.vehicles.map((v, i) => new VehicleView(this.scene, v, v.isPlayer ? paints.paint : v.color, v.isPlayer ? paints.helmet : [0.95, 0.95, 0.95], v.isPlayer ? LANE.player : LANE.rival + (i - 1) * 0.02, this.models[v.spec.id] || null, this.models.pip || null));
    }

    /** after each fixed step: move the vehicles (the engine blends between steps) */
    fixedUpdate() {
        for (const view of this.views) view.place();
    }

    /** interpolated player position */
    playerPos(alpha) {
        const b = this.views[0]?.body;
        if (!b) return [0, 0];
        return [b.prevPosition[0] + (b.position[0] - b.prevPosition[0]) * alpha, b.prevPosition[2] + (b.position[2] - b.prevPosition[2]) * alpha];
    }

    /** every rendered frame */
    render(run, alpha, dt, opts = {}) {
        this.time += dt;
        const T = run.terrain, t = Math.max(0, run.t - (1 - alpha) / 60), p = run.player;
        const [px, py] = this.playerPos(alpha);

        // camera: side view, ahead of the vehicle, out with speed and air, leaning toward what's coming
        const cam = this.game.camera;
        const speed = Math.max(0, p.vx);
        let lean = 0;
        for (const e of run.warnings()) {
            const d = e.center - px;
            if (d > 0 && d < 55) { lean = Math.max(lean, Math.min(5, d * 0.18)); }
        }
        if (this.reducedMotion) lean = 0;
        const k = 1 - Math.exp(-dt * 3);
        this.lean += (lean - this.lean) * (1 - Math.exp(-dt * 1.5));
        // in the garage the vehicle sits centred, above the panel
        const wantX = opts.close ? px + 0.3 : px + 2 + Math.min(5, speed * 0.22) + this.lean;
        this.camX += (wantX - this.camX) * k;
        this.camZ += ((opts.close ? py - 2.6 : py + 2.6) - this.camZ) * (1 - Math.exp(-dt * 4));
        const wantDist = (opts.close ? 12 : 17) + Math.min(9, speed * 0.38) + Math.min(6, p.air * 3);
        // a narrow screen sees less road ahead at the same distance, so it stands further back
        const aspect = this.game.canvas.clientWidth / Math.max(1, this.game.canvas.clientHeight);
        const narrow = aspect < 1.3 ? Math.pow(1.3 / aspect, 0.75) : 1;
        this.camDist += (wantDist * narrow - this.camDist) * (1 - Math.exp(-dt * 1.6));
        cam.mode = "orbit";
        cam.yaw = -Math.PI / 2;
        cam.pitch = opts.close ? 0.16 : 0.1;
        cam.distance = this.camDist;
        cam.target[0] = this.camX; cam.target[1] = LANE.player; cam.target[2] = this.camZ;

        // ground and scenery around the camera
        const x0 = Math.floor((this.camX - BACK - this.camDist * 0.6) / DX) * DX;
        this.strip.build(T, t, x0, this.pal);
        const layerColors = [this.pal.near, this.pal.mid, this.pal.far];
        this.layers.forEach((L, i) => L.build(this.camX, layerColors[i]));
        const lm = Math.round((this.camX - 500) / 1000) * 1000 + 500;
        this.landmark.position.set([lm, 120, -8]);
        this.sky.position.set([this.camX, 0, 0]);
        const water = T.water(t);
        if (this.water.visible) this.water.position.set([this.camX + 30, 72, water.level]);

        this.drawPickups(run, t);
        this.drawProps(run);
        this.drawGlow(run, t);
        if (run.aim !== null && run.aim !== undefined) {
            this.aim.visible = true;
            this.aim.position.set([run.aim, LANE.player, T.h(run.aim, t) + 9]);
            this.aim.scale[0] = this.aim.scale[1] = 1 + 0.15 * Math.sin(this.time * 10);
        } else this.aim.visible = false;
        this.ambient(run, t, dt);
    }

    drawPickups(run, t) {
        const T = run.terrain, lo = this.camX - 50, hi = this.camX + 110;
        let c = 0, f = 0, g = 0, cr = 0, lastCache = -Infinity;
        const spin = this.time * 3;
        for (const k of run.pickups) {
            if (k.x < lo || k.x > hi) continue;
            const z = T.h(k.x, t) + k.off;
            // the crate stands on the ground under the start of a hidden cache's coins, marking where they are
            if (k.cache && k.x - lastCache > 3 && this.crates && cr < this.crates.n) this.crates.setTransform(cr++, k.x - 1.1, LANE.player + 0.6, T.h(k.x - 1.1, t), 1.2, 1.2, 1.2, 0);
            if (k.cache) lastCache = k.x;
            if (k.taken) continue;
            if (k.kind === "coin" && c < this.coins.n) this.coins.setTransform(c++, k.x, LANE.player, z, 1, 1, 1, spin + k.x * 0.3);
            else if (k.kind === "fuel" && f < this.cans.n) this.cans.setTransform(f++, k.x, LANE.player, z + Math.sin(this.time * 2) * 0.1, 1.2, 1.2, 1.2, 0.3);
            else if (k.kind === "charge" && g < this.charges.n) this.charges.setTransform(g++, k.x, LANE.player, z + Math.sin(this.time * 3) * 0.15, 1.1, 1.1, 1.1, this.time);
        }
        for (const [m, n] of [[this.coins, c], [this.cans, f], [this.charges, g], [this.crates, cr]]) if (m) for (let i = n; i < m.n; i++) m.setTransform(i, 0, 0, -500, 0.001);
    }

    drawProps(run) {
        const S = this.strip, x0 = S.x0, x1 = x0 + COLS * DX;
        // posts every 100 m, the best distance flag
        let n = 0;
        for (let x = Math.ceil(x0 / 100) * 100; x < x1 && n < this.posts.n; x += 100) {
            if (x <= 0) continue;
            const big = x % 500 === 0 ? 1.4 : 1;
            this.posts.setTransform(n++, x, 3.1, S.at(x), big, big, big);
        }
        for (let i = n; i < this.posts.n; i++) this.posts.setTransform(i, 0, 0, -500, 0.001);
        const best = this.bestX || 0;
        this.best.visible = best > 30 && best > x0 && best < x1;
        if (this.best.visible) this.best.position.set([best, 2.6, S.at(best)]);
        // rocks and tufts behind the road, fixed to world positions
        let r = 0;
        for (let x = Math.ceil(x0 / 9) * 9; x < x1; x += 9) {
            const id = Math.round(x / 9), m = this.rocks[((id % 3) + 3) % 3];
            if (hash(id) < 0.55) continue;
            const s = 0.5 + hash(id + 0.5) * 1.6, y = 4.5 + hash(id + 0.7) * 8, z = S.at(x) + (y > 6.5 ? 0.6 : 0);
            if (r < 40) m.setTransform(Math.floor(r++ / 3) % m.n, x, y, z, s, s, s, hash(id) * 6);
        }
        let tf = 0;
        for (let x = Math.ceil(x0 / 1.7) * 1.7; x < x1 && tf < this.tufts.n; x += 1.7) {
            const id = Math.round(x / 1.7);
            if (hash(id * 1.3) < 0.45) continue;
            const y = 3.4 + hash(id * 0.71) * 3, s = 0.7 + hash(id * 0.3) * 0.8;
            this.tufts.setTransform(tf++, x, y, S.at(x), s, s, s, hash(id) * 3);
        }
        for (let i = tf; i < this.tufts.n; i++) this.tufts.setTransform(i, 0, 0, -500, 0.001);
        let vn = 0;
        for (const v of run.terrain.vents) {
            if (v.x < x0 || v.x > x1 || vn >= this.vents.n) continue;
            this.vents.setTransform(vn++, v.x, 1.1, S.at(v.x) - 0.15, 1, 1, 1);
        }
        for (let i = vn; i < this.vents.n; i++) this.vents.setTransform(i, 0, 0, -500, 0.001);
    }

    /** orange light over every ground change that is warning or moving */
    drawGlow(run, t) {
        const T = run.terrain, P = this.glowPos, Cc = this.glowCol;
        let v = 0;
        // a quad with its own colour and an opacity at the first edge (a1) and the second (a2)
        const quad = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, col, a1, a2 = a1) => {
            if (v + 4 > this.glowCap) return;
            P.set([ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz], v * 3);
            for (let i = 0; i < 4; i++) Cc.set([col[0], col[1], col[2], Math.min(1, i < 2 ? a1 : a2)], (v + i) * 4);
            v += 4;
        };
        const contrast = this.contrast ? 1.5 : 1;
        for (const e of run.warnings()) {
            if (e.x1 < this.strip.x0 || e.x0 > this.strip.x0 + COLS * DX) continue;
            const warn = e.state === WARN;
            const left = warn ? Math.max(0, e.tMove - t) : 0;
            // the pulse quickens as the moment comes; once moving it fades out
            const pulse = warn ? (0.6 + 0.4 * Math.sin(t * (8 + 16 * (1 - left / 3)))) : Math.max(0, 1 - (t - e.tMove) / (e.tEnd - e.tMove + 0.6));
            const col = e.charge ? [1.1, 0.55, 1.6] : [1.35, 0.42, 0.18];
            const k = pulse * contrast;
            const step = 0.5;
            for (let x = e.x0; x < e.x1; x += step) {
                const x2 = Math.min(e.x1, x + step);
                const h1 = T.h(x, t) + 0.04, h2 = T.h(x2, t) + 0.04;
                // stronger where the ground will move most
                const mid = (x + x2) / 2;
                let s = 1;
                if (e.type !== "crack" && e.type !== "fault") s = Math.sin(Math.PI * Math.min(1, Math.max(0, (mid - e.x0) / (e.x1 - e.x0))));
                const a = k * (0.3 + 0.7 * s);
                quad(x, -3.04, h1, x2, -3.04, h2, x2, 3.2, h2, x, 3.2, h1, col, a * 0.55, a * 0.15);
                quad(x, -3.06, h1, x2, -3.06, h2, x2, -3.06, h2 - 2.2, x, -3.06, h1 - 2.2, col, a * 0.8, 0);
            }
            // a bright edge line on the front, so even a thin change reads at a glance
            const edge = e.type === "crack" ? [(e.x0 + e.x1) / 2 - 0.15, (e.x0 + e.x1) / 2 + 0.15] : [e.x0, e.x1];
            for (let x = edge[0]; x < edge[1]; x += step) {
                const x2 = Math.min(edge[1], x + step), h1 = T.rim(x, t), h2 = T.rim(x2, t);
                quad(x, -3.07, h1 + 0.12, x2, -3.07, h2 + 0.12, x2, -3.07, h2 - 0.08, x, -3.07, h1 - 0.08, [1.8, 0.8, 0.4], k);
            }
            if (e.type === "crack" && !warn) {
                // inside an open crack: deep red heat in Ash Fields, a cold blue dark elsewhere
                const c = (e.x0 + e.x1) / 2, h = T.rim(c, t), w = (e.x1 - e.x0) / 2;
                const heat = this.biome.id === "ash" ? [1.8, 0.6, 0.15] : [0.25, 0.35, 0.55];
                quad(c - w, -3.1, h - 14, c + w, -3.1, h - 14, c + w, -3.1, h - 1, c - w, -3.1, h - 1, heat, 0.9, 0.2);
            }
        }
        this.glowGeo.drawCount = (v / 4) * 6;
        this.glowGeo.markDirty();
    }

    /** dust over moving ground, steam from vents, spray in water */
    ambient(run, t, dt) {
        const T = run.terrain, q = this.particleScale;
        for (const e of run.warnings()) {
            if (e.x1 < this.camX - 40 || e.x0 > this.camX + 60) continue;
            const moving = e.state === MOVE;
            const rate = (moving ? 90 : 14) * q * dt * ((e.x1 - e.x0) / 20);
            for (let i = 0; i < rate; i++) {
                const x = e.x0 + Math.random() * (e.x1 - e.x0);
                this.dust.emit(1, { position: [x, -3 + Math.random() * 6, T.h(x, t)], spread: 0.3, velocity: [0, 0, moving ? 2.5 : 1], speed: moving ? 2 : 0.6, life: [0.6, 1.6], size: [0.5, 1.6], color: [...this.pal.soil.map((v) => v * 1.25), 0.55], colorEnd: [...this.pal.top, 0] });
                if (moving && e.type !== "crack" && Math.random() < 0.15) this.sparks.emit(1, { position: [x, -3, T.h(x, t)], velocity: [0, -2, 5], speed: 3, life: [0.6, 1.1], size: [0.22, 0.1], color: [...this.pal.rock, 1], colorEnd: [...this.pal.rock, 0] });
            }
        }
        for (const v of T.vents) {
            if (v.x < this.camX - 40 || v.x > this.camX + 60) continue;
            const s = T.vent(v.x, t);
            const n = (s.push ? 40 : s.warn ? 6 : 0.8) * q * dt * 10;
            for (let i = 0; i < n; i++) this.dust.emit(1, { position: [v.x, 1.1, T.h(v.x, t) + 0.6], spread: 0.4, velocity: [0, 0, s.push ? 9 : 2.5], speed: 1, life: [0.8, 1.8], size: [0.6, 2.4], color: [0.9, 0.88, 0.86, 0.5], colorEnd: [0.8, 0.8, 0.8, 0] });
        }
        const p = run.player, lvl = T.water(t).level;
        if (lvl > p.y - 0.8 && Math.abs(p.vx) > 2 && Math.random() < 0.6 * q) this.dust.emit(3, { position: [p.x, LANE.player, lvl], spread: 0.6, velocity: [-p.vx * 0.2, 0, 3], speed: 1.5, life: [0.3, 0.7], size: [0.3, 0.6], color: [0.85, 0.95, 1, 0.7], colorEnd: [0.85, 0.95, 1, 0] });
        // wheel dust when driving hard on the ground
        for (const view of this.views) {
            const v = view.v;
            for (const w of v.wheels) {
                if (!w.touching) continue;
                const slip = Math.abs(-w.spin * w.r - v.vx);
                if ((slip > 2.5 || (v.gas > 0.5 && Math.abs(v.vx) > 6)) && Math.random() < 0.35 * q) this.dust.emit(1, { position: [w.x - w.r * 0.6, view.lane, w.y - w.r * 0.8], spread: 0.25, velocity: [-Math.sign(v.vx || 1) * 2, -0.5, 1.2], speed: 0.8, life: [0.4, 0.9], size: [0.3, 1.1], color: [...this.pal.top.map((c) => c * 1.1), 0.5], colorEnd: [...this.pal.top, 0] });
            }
        }
    }

    /** effects for what happened this step */
    effects(events, juice, run) {
        const T = run.terrain, q = this.particleScale;
        for (const e of events) {
            if (e.type === "land" && e.speed > 6) {
                this.dust.emit(Math.round(14 * q), { position: [e.x, LANE.player, T.h(e.x) + 0.1], spread: 1, velocity: [0, 0, 1.5], speed: 3, flat: false, life: [0.4, 1.0], size: [0.5, 1.6], color: [...this.pal.top, 0.6], colorEnd: [...this.pal.top, 0] });
                if (e.speed > 9) juice.shake(Math.min(0.35, (e.speed - 9) * 0.05));
            } else if (e.type === "crash" && e.player) {
                juice.freeze(80); juice.shake(0.55);
                this.sparks.emit(Math.round(40 * q), { position: [e.x, LANE.player, e.y + 0.5], speed: 6, life: [0.3, 0.8], size: [0.25, 0], color: [1.6, 1.2, 0.5, 1], colorEnd: [1, 0.3, 0.1, 0] });
                this.dust.emit(Math.round(30 * q), { position: [e.x, LANE.player, e.y], spread: 1.2, speed: 3, life: [0.6, 1.4], size: [0.8, 2.2], color: [...this.pal.soil, 0.6], colorEnd: [...this.pal.top, 0] });
                if (e.why === "water") this.dust.emit(Math.round(40 * q), { position: [e.x, LANE.player, T.water().level], spread: 1, velocity: [0, 0, 4], speed: 3, life: [0.5, 1.2], size: [0.4, 0.9], color: [0.85, 0.95, 1, 0.8], colorEnd: [0.85, 0.95, 1, 0] });
            } else if (e.type === "pickup") {
                const col = e.kind === "coin" ? [1.6, 1.2, 0.3, 1] : e.kind === "fuel" ? [0.4, 1.6, 0.5, 1] : [1.1, 0.5, 1.8, 1];
                this.sparks.emit(Math.round((e.kind === "coin" ? 6 : 26) * q), { position: [e.x, LANE.player, e.y], speed: e.kind === "coin" ? 2.5 : 4, life: [0.25, 0.6], size: [0.18, 0], color: col, colorEnd: [col[0], col[1], col[2], 0] });
            } else if (e.type === "charge") {
                this.sparks.emit(Math.round(30 * q), { position: [e.x, LANE.player, T.h(e.x) + 0.5], speed: 5, life: [0.3, 0.9], size: [0.3, 0], color: [1.2, 0.6, 2, 1], colorEnd: [0.6, 0.2, 1, 0] });
            }
        }
        // the start of every change's movement thumps the camera a little
        for (const e of T.moved) {
            if (e.state === MOVE && Math.abs(e.center - run.player.x) < 60) juice.shake(e.type === "crack" ? 0.3 : 0.18);
        }
    }

    /** screen position of a world point on the track (for labels and edge arrows) */
    toScreen(x, z, w, h) { return this.game.camera.project([x, LANE.player, z], w, h); }
}

export { LANE };
