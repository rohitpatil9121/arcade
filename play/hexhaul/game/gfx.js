import { ShaderMaterial, Texture, Geometry, projectionChunk, lightingChunk } from "../engine/index.js";

/**
 * HEXHAUL: the look (stage 3). Materials and geometry built in code, after TIDEFALL's sea (game/gfx.js
 * there) and the art direction in the GDD: chunky, toy-like, bright, easy to read.
 *
 * waterMaterial  a subdivided plane. Travelling waves in the vertex shader; in the fragment, turquoise near
 *                the island fading to deep blue, fresnel against the sky, a sun glint, and foam that hugs
 *                every tile. Where the tiles are comes from a small distance texture (foamField) stamped on
 *                the CPU from the tiles' hex shapes, so a sinking tile leaves a ring of foam as it goes.
 * skyMaterial    a dome: horizon-to-zenith gradient, soft sun, far sea below the horizon.
 * hexTile        a bevelled hex prism: a flat top, a rounded lip, darker sides (vertex colour, multiplied
 *                by each tile's instance colour, so one InstancedMesh draws every kind of tile).
 * crackGeometry  jagged lines on a tile's top, faded in by instance alpha while the tile warns.
 * @module game/gfx
 */

const noise = /* glsl */ `
float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), u.x), mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

const waves = /* glsl */ `
// a few travelling waves; returns the height and its slope
vec3 waves(vec2 p, float t) {
    vec3 r = vec3(0.0);
    vec4 dirs[4];
    dirs[0] = vec4(0.8, 0.6, 0.55, 1.3); dirs[1] = vec4(-0.4, 0.92, 0.8, 1.1); dirs[2] = vec4(0.95, -0.3, 1.2, 1.7); dirs[3] = vec4(-0.7, -0.7, 1.9, 2.2);
    for (int i = 0; i < 4; i++) {
        vec2 d = dirs[i].xy; float k = dirs[i].z, sp = dirs[i].w, amp = 0.06 / (1.0 + float(i) * 0.7);
        float ph = dot(d, p) * k + t * sp;
        r.x += sin(ph) * amp;
        r.yz += d * cos(ph) * amp * k;
    }
    return r;
}
`;

const waterVertex = /* glsl */ `
${projectionChunk}
attribute vec3 a_position;
uniform mat4 u_model;
uniform float u_time;
varying vec3 v_world;
varying vec2 v_slope;
${waves}
void main() {
    vec4 world = u_model * vec4(a_position, 1.0);
    vec3 w = waves(world.xy, u_time);
    world.z += w.x;
    v_slope = w.yz;
    v_world = world.xyz;
    gl_Position = projectLab(world.xyz);
}
`;

const waterFragment = /* glsl */ `
${lightingChunk}
${noise}
uniform float u_time;
uniform sampler2D u_foam;      // r: distance to the nearest tile edge, 0..FOAM_RANGE m
uniform vec4 u_foamMap;        // x0, y0, size in metres, range in metres
varying vec3 v_world;
varying vec2 v_slope;
float edgeDistance(vec2 xy) {
    vec2 uv = (xy - u_foamMap.xy) / u_foamMap.z;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return u_foamMap.w;
    return texture2D(u_foam, uv).r * u_foamMap.w;
}
void main() {
    vec3 w = v_world;
    vec3 n = normalize(vec3(-v_slope.x, -v_slope.y, 1.0) + vec3(vnoise(w.xy * 1.6 + u_time * 0.7) - 0.5, vnoise(w.yx * 1.8 - u_time * 0.6) - 0.5, 0.0) * 0.14);
    vec3 view = normalize(u_camPos - w);
    float d = edgeDistance(w.xy);
    // turquoise around the island, the palette's deep blue further out
    float far = smoothstep(0.0, 9.0, length(w.xy) - 7.0);
    vec3 shallow = vec3(0.18, 0.66, 0.85), deep = vec3(0.06, 0.3, 0.52);
    vec3 body = mix(mix(vec3(0.3, 0.8, 0.86), shallow, smoothstep(0.0, 1.6, d)), deep, far);
    body *= 0.55 + 0.45 * max(dot(n, u_sunDirection), 0.0);
    float fres = 0.03 + 0.97 * pow(1.0 - max(dot(n, view), 0.0), 5.0);
    vec3 color = mix(body, u_skyColor * 1.35 + 0.08, fres * 0.7);
    vec3 r = reflect(-u_sunDirection, n);
    float glint = pow(max(dot(r, view), 0.0), 260.0) * 5.0 + pow(max(dot(r, view), 0.0), 24.0) * 0.15;
    color += u_sunColor * glint * labShadow(w, vec3(0.0, 0.0, 1.0));
    // foam: a solid band hugging each tile, broken lace beyond it that breathes in and out
    float lace = vnoise(w.xy * 3.3 + vec2(u_time * 0.35, -u_time * 0.25)) * 0.6 + vnoise(w.xy * 7.0 - u_time * 0.4) * 0.4;
    float band = 1.0 - smoothstep(0.08, 0.22 + 0.05 * sin(u_time * 2.0 + w.x + w.y), d);
    float outer = (1.0 - smoothstep(0.25, 0.9, d)) * smoothstep(0.52, 0.72, lace) * (0.65 + 0.35 * sin(u_time * 1.4 - d * 6.0));
    float foam = clamp(max(band, outer), 0.0, 1.0);
    color = mix(color, vec3(0.957, 0.984, 1.0) * (0.75 + 0.3 * u_sunDirection.z), foam * 0.92);
    gl_FragColor = vec4(labFog(color, w), 1.0);
}
`;

const skyVertex = /* glsl */ `
${projectionChunk}
attribute vec3 a_position;
uniform mat4 u_model;
varying vec3 v_dir;
void main() {
    v_dir = a_position;
    gl_Position = projectLab((u_model * vec4(a_position, 1.0)).xyz);
}
`;
const skyFragment = /* glsl */ `
uniform vec3 u_sunDirection;
uniform vec3 u_sunColor;
varying vec3 v_dir;
void main() {
    vec3 d = normalize(v_dir);
    float h = max(d.z, 0.0);
    vec3 zenith = vec3(0.26, 0.55, 0.9), horizon = vec3(0.78, 0.9, 0.97);
    vec3 color = mix(horizon, zenith, pow(h, 0.5));
    float toward = max(dot(d, u_sunDirection), 0.0);
    color += u_sunColor * (pow(toward, 800.0) * 12.0 + pow(toward, 10.0) * 0.25);
    if (d.z < 0.0) color = mix(horizon * vec3(0.5, 0.78, 0.9), vec3(0.08, 0.34, 0.55), min(1.0, -d.z * 5.0));
    gl_FragColor = vec4(color, 1.0);
}
`;

export function skyMaterial() {
    return new ShaderMaterial({ name: "hex-sky", vertex: skyVertex, fragment: skyFragment, uniforms: {}, cull: "none", depthWrite: false });
}

// ------------------------------------------------------------------ foam field

/** how far from a tile's edge the field measures, metres */
const FOAM_RANGE = 1.5;

/**
 * Distance from each point of the sea to the nearest tile edge, as a texture the water reads. Tiles are
 * stamped one at a time into a small window around each, so a full rebuild is a few tens of thousands of
 * operations: cheap enough to redo several times a second.
 */
export class FoamField {
    /** @param {number} half metres from the centre to the field's edge */
    constructor(half, n = 128) {
        this.n = n; this.half = half; this.cell = (half * 2) / n;
        this.dist = new Float32Array(n * n);
        this.data = new Uint8Array(n * n * 4);
        this.texture = new Texture({ data: this.data, width: n, height: n, wrap: "clamp", filter: "linear", mipmaps: false, name: "foam" });
        this.values = new Float32Array([-half, -half, half * 2, FOAM_RANGE]);
    }

    /**
     * @param {Iterable<{ x: number, y: number, r: number, z: number }>} hexes centre, outer radius (corner), top height
     */
    build(hexes) {
        const { n, cell, half, dist, data } = this;
        dist.fill(FOAM_RANGE);
        const win = Math.ceil((1 + FOAM_RANGE) / cell);
        const c30 = Math.cos(Math.PI / 6);
        for (const h of hexes) {
            // a tile under the surface makes less foam the deeper it goes
            if (h.z < -0.9) continue;
            const fade = h.z < -0.25 ? (-0.25 - h.z) * 1.6 : 0;
            const apothem = h.r * c30;
            const cx = Math.floor((h.x + half) / cell), cy = Math.floor((h.y + half) / cell);
            for (let j = Math.max(0, cy - win); j <= Math.min(n - 1, cy + win); j++) {
                const py = -half + (j + 0.5) * cell - h.y;
                for (let i = Math.max(0, cx - win); i <= Math.min(n - 1, cx + win); i++) {
                    const px = -half + (i + 0.5) * cell - h.x;
                    // flat-topped hex (corners on the x axis): distance to the nearest of the three edge pairs
                    const ax = Math.abs(px), ay = Math.abs(py);
                    const e = Math.max(ay, ax * c30 + ay * 0.5) - apothem;
                    const v = Math.max(0, e) + fade;
                    const k = j * n + i;
                    if (v < dist[k]) dist[k] = v;
                }
            }
        }
        for (let k = 0; k < n * n; k++) { data[k * 4] = Math.round((dist[k] / FOAM_RANGE) * 255); data[k * 4 + 3] = 255; }
        this.texture.update();
    }
}

export function waterMaterial(foam) {
    return new ShaderMaterial({ name: "hex-water", vertex: waterVertex, fragment: waterFragment,
        uniforms: { u_foam: foam.texture, u_foamMap: foam.values }, cull: "none" });
}

// ------------------------------------------------------------------ geometry

/** Build a Geometry from flat lists, computing flat normals per triangle (each triangle has its own vertices). */
function flat(tris) {
    const count = tris.length / 3;
    const positions = new Float32Array(count * 9), normals = new Float32Array(count * 9), colors = new Float32Array(count * 12);
    for (let t = 0; t < count; t++) {
        const [a, b, c] = [tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]];
        const ux = b.p[0] - a.p[0], uy = b.p[1] - a.p[1], uz = b.p[2] - a.p[2];
        const vx = c.p[0] - a.p[0], vy = c.p[1] - a.p[1], vz = c.p[2] - a.p[2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
        [a, b, c].forEach((v, k) => {
            positions.set(v.p, (t * 3 + k) * 3);
            normals.set(v.n || [nx, ny, nz], (t * 3 + k) * 3);
            colors.set([v.c, v.c, v.c, 1], (t * 3 + k) * 4);
        });
    }
    return new Geometry({ positions, normals, colors });
}

/**
 * A bevelled flat-topped hex prism: top at z = 0, `depth` down. The top is a little lighter in the middle,
 * the lip catches the light, the sides are darker and get darker toward the bottom (toy-like, and it makes
 * the top face read at a glance).
 * @param {number} r corner radius
 */
export function hexTile(r, depth = 0.5, bevel = 0.09) {
    const ring = (rad, z) => Array.from({ length: 6 }, (_, i) => [Math.cos((i * Math.PI) / 3) * rad, Math.sin((i * Math.PI) / 3) * rad, z]);
    const top = ring(r - bevel, 0), lip = ring(r, -bevel), base = ring(r * 0.96, -depth);
    const tris = [];
    const up = [0, 0, 1];
    for (let i = 0; i < 6; i++) {
        const j = (i + 1) % 6;
        tris.push({ p: [0, 0, 0], n: up, c: 1.04 }, { p: top[i], n: up, c: 0.97 }, { p: top[j], n: up, c: 0.97 });
        // the bevel: smooth-ish normals halfway between up and out
        const mid = (k) => { const a = (k * Math.PI) / 3; return [Math.cos(a) * 0.7, Math.sin(a) * 0.7, 0.7]; };
        tris.push({ p: top[i], n: mid(i), c: 1.0 }, { p: lip[i], n: mid(i), c: 0.92 }, { p: lip[j], n: mid(j), c: 0.92 });
        tris.push({ p: top[i], n: mid(i), c: 1.0 }, { p: lip[j], n: mid(j), c: 0.92 }, { p: top[j], n: mid(j), c: 1.0 });
        // sides, darker going down
        tris.push({ p: lip[i], c: 0.72 }, { p: base[i], c: 0.42 }, { p: base[j], c: 0.42 });
        tris.push({ p: lip[i], c: 0.72 }, { p: base[j], c: 0.42 }, { p: lip[j], c: 0.72 });
    }
    return flat(tris);
}

/** Jagged crack lines on a hex top, as thin flat strips just above z = 0. */
export function crackGeometry(r, seed = 3) {
    let s = seed;
    const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const tris = [];
    const strip = (pts, w) => {
        for (let i = 0; i < pts.length - 1; i++) {
            const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
            const dx = by - ay, dy = -(bx - ax), l = Math.hypot(dx, dy) || 1, ox = (dx / l) * w, oy = (dy / l) * w;
            const z = 0.012, up = [0, 0, 1];
            tris.push({ p: [ax - ox, ay - oy, z], n: up, c: 1 }, { p: [bx - ox, by - oy, z], n: up, c: 1 }, { p: [bx + ox, by + oy, z], n: up, c: 1 });
            tris.push({ p: [ax - ox, ay - oy, z], n: up, c: 1 }, { p: [bx + ox, by + oy, z], n: up, c: 1 }, { p: [ax + ox, ay + oy, z], n: up, c: 1 });
        }
    };
    for (let k = 0; k < 4; k++) {
        const a0 = (k / 4) * Math.PI * 2 + rand() * 0.8;
        const pts = [[(rand() - 0.5) * 0.15, (rand() - 0.5) * 0.15]];
        let a = a0;
        for (let step = 1; step <= 4; step++) {
            a += (rand() - 0.5) * 0.9;
            const d = (step / 4) * r * 0.8;
            pts.push([Math.cos(a) * d, Math.sin(a) * d]);
        }
        strip(pts, 0.03 - k * 0.003);
        if (k % 2 === 0) { const p = pts[2], b = a + 0.9; strip([p, [p[0] + Math.cos(b) * 0.25, p[1] + Math.sin(b) * 0.25]], 0.018); }
    }
    return flat(tris);
}

/** A little tuft of grass blades: three flattened cones in a cluster, coloured lighter at the tips. */
export function tuftGeometry() {
    const tris = [];
    const blade = (x, y, h, a) => {
        const w = 0.035, cx = Math.cos(a) * w, cy = Math.sin(a) * w;
        const tip = [x + Math.cos(a + 1.57) * 0.03, y + Math.sin(a + 1.57) * 0.03, h];
        tris.push({ p: [x - cx, y - cy, 0], c: 0.75 }, { p: [x + cx, y + cy, 0], c: 0.75 }, { p: tip, c: 1.15 });
        tris.push({ p: [x + cx, y + cy, 0], c: 0.75 }, { p: [x - cx, y - cy, 0], c: 0.75 }, { p: tip, c: 1.15 });
    };
    blade(0, 0, 0.2, 0); blade(0.05, 0.03, 0.15, 1.1); blade(-0.04, 0.04, 0.17, 2.2); blade(0.01, -0.05, 0.13, 2.9);
    return flat(tris);
}
