// Maplewood Mayhem — the whole game. Imported by index.html as a module.
// three comes from npm (pinned to the same 0.161.0 the CDN importmap used), so
// behaviour is identical to the pre-Vite build.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import * as BGU from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import GUI from 'lil-gui';

// =================================================================
//  RENDERER / SCENE
// =================================================================
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const townFog = new THREE.Fog(0xbfe6f7, 520, 1900);
scene.fog = townFog;

const camera = new THREE.PerspectiveCamera(60, innerWidth/innerHeight, 0.4, 4000);

// One town, every load — from a PRIVATE stream.
//
// This used to overwrite Math.random itself, which caught every generator for free
// but shared the stream with three.js: every geometry, material and Object3D pulls a
// UUID from Math.random, burning four draws. That made object *count* part of the
// town's seed, so adding a building moved the trees, and the whole codebase grew
// defences against it — rngNeutral, lastPut/withdraw, build-then-discard.
//
// Now the generator draws from prng() and three.js keeps the real Math.random. The
// two can no longer interfere: create as many objects as you like, wherever you like,
// and the town does not move. `rnd`/`rpick` and every seeded call site below route
// through here; anything left on Math.random is deliberate runtime variety (traffic
// spawns, ped decisions) where a fixed sequence would be worse, not better.
let __seed = 20260721;
function prng() {
  __seed = (__seed + 0x6D2B79F5) | 0;
  let t = Math.imul(__seed ^ (__seed >>> 15), 1 | __seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Kept for the few places that deliberately rewind the stream. It is no longer
// load-bearing for object creation — that problem is gone — but it still lets a
// block draw randoms without shifting what comes after it.
function rngNeutral(fn) { const s = __seed; const r = fn(); __seed = s; return r; }

const dummy = new THREE.Object3D();
function instanced(geo, mat, count, shadow) {
  const m = new THREE.InstancedMesh(geo, mat, count);
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.castShadow = shadow !== false; m.receiveShadow = shadow !== false;
  m.frustumCulled = false;
  return m;
}
function baked(geo, x, y, z, rx, ry, rz) {
  const g = geo.clone();
  dummy.position.set(x||0, y||0, z||0); dummy.rotation.set(rx||0, ry||0, rz||0);
  dummy.scale.set(1,1,1); dummy.updateMatrix();
  g.applyMatrix4(dummy.matrix); return g;
}
const merge = list => {
  if (!list.length) return null;
  const norm = list.map(g => g.index ? g.toNonIndexed() : g);
  const out = BGU.mergeGeometries(norm);
  if (!out) console.warn('merge failed — mismatched attributes', norm.map(g => Object.keys(g.attributes).join('+')));
  return out;
};
const rpick = a => a[(prng()*a.length)|0];
const rnd = (a, b) => a + prng()*(b-a);

// =================================================================
//  CARTOON SHADING
//  Toon ramp for the flat colour; the ink lines are a post-process
//  (see POST, at the bottom) rather than a back-face shell per mesh.
//  The shells doubled the vertex work on exactly the heaviest objects
//  in the game — 1,400 townsfolk, all traffic, ~1,650 trees — and only
//  ever drew silhouettes. The edge-detect pass draws interior lines too,
//  at a constant screen-space weight, for one extra full-screen quad.
// =================================================================
function toonRamp(steps) {
  const c = document.createElement('canvas'); c.width = steps; c.height = 1;
  const g = c.getContext('2d');
  const stops = [0.55, 0.78, 1.0, 1.0];
  for (let i = 0; i < steps; i++) {
    const v = Math.round(255 * stops[Math.min(i, stops.length-1)]);
    g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(i, 0, 1, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = false;
  return t;
}
const RAMP = toonRamp(3);
const matCache = new Map();
function toon(color) {                       // shared per colour, so merging stays cheap
  if (!matCache.has(color)) matCache.set(color, new THREE.MeshToonMaterial({ color, gradientMap: RAMP }));
  return matCache.get(color);
}
function toonMapped(map) { return new THREE.MeshToonMaterial({ map, gradientMap: RAMP }); }
// A thin bright edge where the surface curls away from the camera — the classic
// animated-film rim. Injected into the toon shader rather than a second pass: one
// smoothstep on the view angle, tinted mostly by the surface's own (instance)
// colour so a pink car rims pink, not white. Only characters and cars get it —
// on buildings it reads as frost.
function addRim(mat) {
  mat.onBeforeCompile = sh => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>',
      `{
        float rimNV = 1.0 - saturate(dot(normalize(vViewPosition), normal));
        outgoingLight += (diffuseColor.rgb * 0.7 + 0.3) * smoothstep(0.55, 0.75, rimNV) * 0.35;
      }
      #include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => 'rim1';
  return mat;
}
const INK_COLOR = 0x14192e;
// The ink pass reads the scene's depth buffer, so anything that writes depth gets
// outlined. Every transparent thing in this game — glow discs, beacons, headlight
// cones, billboard signs, the sky dome, car glass — stands in for light rather than
// for mass, and a free-standing billboard that stamps its quad into depth comes back
// as an ink rectangle floating in mid-air. Transparent materials have no business
// writing depth anyway (they are drawn back-to-front after the opaque pass), so this
// just makes that explicit.
function tagNoInk(root) {
  root.traverse(o => {
    const m = o.material;
    if (m && !Array.isArray(m) && (m.transparent || o.isSprite)) m.depthWrite = false;
  });
}

// =================================================================
//  SKY · SUN · CLOUDS
// =================================================================
{
  const c = document.createElement('canvas'); c.width = 8; c.height = 256;
  const g = c.getContext('2d'), grd = g.createLinearGradient(0,0,0,256);
  grd.addColorStop(0.00, '#2a86d8'); grd.addColorStop(0.45, '#63b8ec');
  grd.addColorStop(0.78, '#a9dcf6'); grd.addColorStop(1.00, '#dff2fc');
  g.fillStyle = grd; g.fillRect(0,0,8,256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const dome = new THREE.Mesh(new THREE.SphereGeometry(3400, 24, 12),
    new THREE.MeshBasicMaterial({ map: t, side: THREE.BackSide, fog: false, depthWrite: false }));
  dome.renderOrder = -10; scene.add(dome);
  var skyDome = dome;                      // tinted through the day by updateSky()
}
const hemi = new THREE.HemisphereLight(0xcdeaff, 0x6f8a52, 2.1);
scene.add(hemi);
const sunDir = new THREE.Vector3(0.42, 0.78, 0.32).normalize();
let riverWater = null;                        // the river's ShaderMaterial — uTime fed per frame
const sun = new THREE.DirectionalLight(0xfff6e2, 2.5);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
const SH = 120;
sun.shadow.camera.left = -SH; sun.shadow.camera.right = SH;
sun.shadow.camera.top = SH;   sun.shadow.camera.bottom = -SH;
sun.shadow.camera.near = 1;   sun.shadow.camera.far = 620;
sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.06;
scene.add(sun, sun.target);

// =================================================================
//  TIME OF DAY
//  One clock drives the sun's elevation and colour, the hemisphere fill, the fog
//  and the sky tint, so dusk reads across the whole town at once rather than as a
//  filter over it. `dayT` is 0..1 with 0.5 at noon; a full day is DAY_LEN seconds.
//  Nothing here is seeded — it all runs per frame, long after the town is built.
// =================================================================
// Night is SHELVED for now: the cycle is built and works (sun, fog, sky, headlights)
// but the game reads better in permanent daylight. Flip DAY_CYCLE back on to revive
// it — everything downstream keys off nightAmt, which stays 0 while this is false.
const DAY_CYCLE = false;
const DAY_LEN = 300;                       // five minutes of game world per day
let dayT = 0.30;                           // open mid-morning
const NIGHT_KEYS = {                       // sun colour by elevation, warm at the horizon
  day:   new THREE.Color(0xfff6e2), dusk: new THREE.Color(0xff9b4d), night: new THREE.Color(0x3a4c86),
};
const SKY_KEYS = {
  day:   new THREE.Color(0xffffff), dusk: new THREE.Color(0xff9a5c), night: new THREE.Color(0x1b2545),
};
const FOG_KEYS = {
  day:   new THREE.Color(0xbfe6f7), dusk: new THREE.Color(0xe8996b), night: new THREE.Color(0x17203c),
};
const _c1 = new THREE.Color(), _c2 = new THREE.Color();
let nightAmt = 0;                          // 0 broad daylight … 1 fully dark
function updateSky(dt) {
  if (!DAY_CYCLE) return;                  // frozen at the construction-time daylight
  dayT = (dayT + dt/DAY_LEN) % 1;
  // elevation: a sine that peaks at noon and dips below the horizon overnight
  const elev = Math.sin(dayT * Math.PI * 2 - Math.PI/2);
  sunDir.set(Math.cos(dayT * Math.PI * 2) * 0.55, Math.max(0.06, elev * 0.9), 0.32).normalize();
  const day = THREE.MathUtils.clamp((elev - 0.06) / 0.34, 0, 1);   // 1 well up, 0 at the horizon
  const dusk = THREE.MathUtils.clamp((elev + 0.28) / 0.34, 0, 1);  // 1 at the horizon, 0 deep night
  nightAmt = 1 - dusk;
  const mix = (keys, out) => {                                     // night → dusk → day
    out.copy(keys.night).lerp(keys.dusk, dusk);
    return out.lerp(keys.day, day);
  };
  sun.color.copy(mix(NIGHT_KEYS, _c1));
  sun.intensity = 0.25 + day * 2.25;
  hemi.intensity = 0.34 + day * 1.76;
  hemi.color.copy(mix(SKY_KEYS, _c2)).lerp(new THREE.Color(0xcdeaff), 0.4);
  if (skyDome) skyDome.material.color.copy(mix(SKY_KEYS, _c1));
  townFog.color.copy(mix(FOG_KEYS, _c2));
  townFog.near = 520 - nightAmt * 240;                              // night closes the world in
  renderer.setClearColor(townFog.color);
}

// fat storybook clouds — clusters of flattened spheres
{
  const cloudMat = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: RAMP, fog: false });
  const lobes = [];
  for (let i = 0; i < 7; i++)
    lobes.push(baked(new THREE.SphereGeometry(rnd(9,17), 7, 5), rnd(-26,26), rnd(-3,4), rnd(-9,9)));
  const puff = merge(lobes);
  const clouds = instanced(puff, cloudMat, 26, false);
  for (let i = 0; i < 26; i++) {
    const a = prng()*Math.PI*2, r = rnd(220, 1150);
    dummy.position.set(Math.cos(a)*r, rnd(150, 250), Math.sin(a)*r);
    dummy.rotation.set(0, prng()*6.28, 0);
    dummy.scale.setScalar(rnd(0.9, 2.1)); dummy.updateMatrix();
    clouds.setMatrixAt(i, dummy.matrix);
  }
  clouds.instanceMatrix.needsUpdate = true; scene.add(clouds);
}

// =================================================================
//  TOWN PLAN
//  A hand-laid grid instead of imported survey data: blocks get a zone,
//  and every generator below reads that zone.
// =================================================================
const ROAD_HW = 7;            // carriageway half width
const WALK_HW = 11.5;         // outer edge of the sidewalk
const GN = 8;                 // junction grid is GN x GN

// ---- street spacing: tight downtown, loose out on the edges ----
function axisSpacing(n) {
  const out = [0];
  for (let i = 0; i < n-1; i++) {
    const t = Math.abs((i - (n-2)/2) / ((n-2)/2 || 1));      // 0 middle .. 1 edge
    out.push(out[out.length-1] + 84 + t*82 + rnd(-12, 12));
  }
  const mid = out[out.length-1]/2;
  return out.map(v => v - mid);
}
const colX = axisSpacing(GN), rowZ = axisSpacing(GN);
const TOWN = Math.max(colX[GN-1], rowZ[GN-1]) + 90;

// ---- junctions, nudged off true so nothing runs dead straight ----
const JIT = 16;
const CORNER = [];
for (let i = 0; i < GN; i++) {
  CORNER[i] = [];
  for (let j = 0; j < GN; j++) {
    const edge = (i === 0 || i === GN-1 || j === 0 || j === GN-1) ? 0.45 : 1;
    CORNER[i][j] = { x: colX[i] + rnd(-JIT, JIT)*edge, z: rowZ[j] + rnd(-JIT, JIT)*edge, deg: 0 };
  }
}

// ---- the river: a wandering channel across the middle of the map ----
// It sits between two junction rows, so the row of cells it runs through becomes
// parkland and only a few streets get a bridge across.
const RIVER_ROW = 2 + (prng() < 0.5 ? 0 : 3);
const RIVER_MID = (rowZ[RIVER_ROW] + rowZ[RIVER_ROW+1]) / 2;
const RIVER_HW = 27;
const riverZ = x => RIVER_MID + Math.sin(x*0.0052)*44 + Math.sin(x*0.0131 + 1.7)*15;
const overRiver = (x, z, m) => Math.abs(z - riverZ(x)) < RIVER_HW + (m||0);

// ---- street network -------------------------------------------------------
// H edges run west-east between neighbouring junctions, V edges north-south.
// Some are dropped to merge cells into larger blocks and leave T-junctions;
// across the river only a couple survive, and those become bridges.
const HKEEP = [], VKEEP = [];
for (let i = 0; i < GN-1; i++) { HKEEP[i] = []; for (let j = 0; j < GN; j++) HKEEP[i][j] = true; }
for (let i = 0; i < GN; i++) { VKEEP[i] = []; for (let j = 0; j < GN-1; j++) VKEEP[i][j] = true; }

// the street that would run straight down the river is replaced by the water
for (let i = 0; i < GN-1; i++) HKEEP[i][RIVER_ROW+1] = false;
// keep three crossings; everything else stops at the bank
const BRIDGE_COLS = [1, 3, 6].map(c => Math.min(GN-1, c));
for (let i = 0; i < GN; i++) VKEEP[i][RIVER_ROW] = BRIDGE_COLS.includes(i);

// merge a scattering of cells into bigger blocks by deleting the shared street
const merged = [];
for (let k = 0; k < 9; k++) {
  const i = 1 + (prng()*(GN-3)|0), j = 1 + (prng()*(GN-3)|0);
  if (j === RIVER_ROW || j === RIVER_ROW+1) continue;
  if (prng() < 0.5) { if (VKEEP[i+1] && VKEEP[i+1][j]) { VKEEP[i+1][j] = false; merged.push([i, j, 'h']); } }
  else                     { if (HKEEP[i] && HKEEP[i][j+1])  { HKEEP[i][j+1]  = false; merged.push([i, j, 'v']); } }
}

const STREETS = [];   // {ax,az,bx,bz,kind,w}
function street(a, b, kind) {
  const w = kind === 'avenue' ? ROAD_HW*1.32 : kind === 'highway' ? ROAD_HW*1.5 : ROAD_HW;
  STREETS.push({ ax:a.x, az:a.z, bx:b.x, bz:b.z, kind, w });
  a.deg++; b.deg++;
}
{
  const cand = [];
  const add = (a, b, kind) => cand.push({ a, b, kind, live: true });
  for (let i = 0; i < GN-1; i++) for (let j = 0; j < GN; j++)
    if (HKEEP[i][j]) add(CORNER[i][j], CORNER[i+1][j], j === 3 ? 'avenue' : 'street');
  for (let i = 0; i < GN; i++) for (let j = 0; j < GN-1; j++)
    if (VKEEP[i][j]) add(CORNER[i][j], CORNER[i][j+1], j === RIVER_ROW ? 'bridge' : (i === 3 ? 'avenue' : 'street'));
  // a diagonal avenue slicing across the grain of the grid
  for (let k = 1; k < GN-2; k++) {
    const a = CORNER[k][k], b = CORNER[k+1][k+1];
    if (Math.abs(a.z - riverZ(a.x)) < RIVER_HW+8 || Math.abs(b.z - riverZ(b.x)) < RIVER_HW+8) continue;
    add(a, b, 'avenue');
  }
  // Deleting streets to make super-blocks, and dropping all but three river crossings,
  // leaves stubs that stop in the middle of nowhere. Eat them back until every junction
  // has at least two ways out, so every street you can drive down actually goes somewhere.
  for (;;) {
    const deg = new Map();
    for (const c of cand) if (c.live) { deg.set(c.a, (deg.get(c.a)||0)+1); deg.set(c.b, (deg.get(c.b)||0)+1); }
    let cut = 0;
    for (const c of cand) if (c.live && (deg.get(c.a) === 1 || deg.get(c.b) === 1)) { c.live = false; cut++; }
    if (!cut) break;
  }
  for (const c of cand) if (c.live) street(c.a, c.b, c.kind);
}

// ---- cells become blocks (some merged, some drowned by the river) ----
const BLOCKS = [], BLOCK_SHRINK = [];
{
  const owner = [];
  for (let i = 0; i < GN-1; i++) { owner[i] = []; for (let j = 0; j < GN-1; j++) owner[i][j] = null; }
  const groupOf = (i, j) => { let g = owner[i][j]; if (!g) owner[i][j] = g = { cells: [[i,j]] }; return g; };
  for (const [i, j, dir] of merged) {
    const a = groupOf(i, j);
    const [ni, nj] = dir === 'h' ? [i+1, j] : [i, j+1];
    if (ni >= GN-1 || nj >= GN-1) continue;
    const b = groupOf(ni, nj);
    if (a === b) continue;
    for (const c of b.cells) { a.cells.push(c); owner[c[0]][c[1]] = a; }
  }
  const seen = new Set();
  for (let i = 0; i < GN-1; i++) for (let j = 0; j < GN-1; j++) {
    const g = groupOf(i, j);
    if (seen.has(g)) continue; seen.add(g);
    let i0=1e9, i1=-1e9, j0=1e9, j1=-1e9;
    for (const [ci, cj] of g.cells) { i0=Math.min(i0,ci); i1=Math.max(i1,ci); j0=Math.min(j0,cj); j1=Math.max(j1,cj); }
    // walk the outline so houses can follow the streets that actually bound it
    const poly = [];
    for (let a = i0; a <= i1+1; a++) poly.push(CORNER[a][j0]);
    for (let b = j0+1; b <= j1+1; b++) poly.push(CORNER[i1+1][b]);
    for (let a = i1; a >= i0; a--) poly.push(CORNER[a][j1+1]);
    for (let b = j1; b >= j0+1; b--) poly.push(CORNER[i0][b]);
    let x0=1e9, x1=-1e9, z0=1e9, z1=-1e9;
    for (const p of poly) { x0=Math.min(x0,p.x); x1=Math.max(x1,p.x); z0=Math.min(z0,p.z); z1=Math.max(z1,p.z); }
    const B = {
      poly, cells: g.cells, zone: 'house',
      r: { x0:x0+WALK_HW, x1:x1-WALK_HW, z0:z0+WALK_HW, z1:z1-WALK_HW },
      cx: (x0+x1)/2, cz: (z0+z1)/2, i: i0, j: j0, w: x1-x0, d: z1-z0,
    };
    BLOCK_SHRINK.push(B);   // pulled in off the roads once the network exists
    B.riverside = overRiver(B.cx, B.cz, 34);
    BLOCKS.push(B);
  }
}

const SPAWN = { x: 0, z: 0, heading: Math.PI/2 };
let HOME_BLOCK = null;

// ---- zoning: a dense core, landmarks pinned to sensible spots, houses elsewhere ----
{
  const byDist = BLOCKS.slice().sort((a,b) => Math.hypot(a.cx,a.cz) - Math.hypot(b.cx,b.cz));
  const free = byDist.filter(b => !b.riverside);
  const take = z => { const b = free.shift(); if (b) b.zone = z; return b; };
  // Commerce is spread, not pooled: one high-street core stays downtown, and the
  // other three shop blocks are pushed out to distant quarters (below, after the
  // landmarks pick their spots) so jobs send you across the whole town.
  take('plaza'); take('civic'); take('shops');
  // the rest of the named places go to whichever free block is nearest a chosen direction
  const pick = (dx, dz) => {
    let best = null, bd = -1e9;
    for (const b of free) { const s = b.cx*dx + b.cz*dz - Math.hypot(b.cx,b.cz)*0.15;
      if (s > bd) { bd = s; best = b; } }
    if (best) free.splice(free.indexOf(best), 1);
    return best;
  };
  const place = (z, dx, dz) => { const b = pick(dx, dz); if (b) b.zone = z; return b; };
  place('plant', -1, -1); place('plant', -0.9, -1);
  place('burns',  1, -1);   place('prison', -1,  0.2);
  place('church', 0.9, 0.8); place('school', 1, -0.2);
  place('stadium', 0.2, 1);  place('duff', -1, 0.9);
  place('retire', 0.4, -1);  place('tirefire', -1, -0.2);
  const ever = place('evergreen', -0.4, 0.6);
  // The scattered shop quarters, placed after the landmarks so the set pieces keep
  // their priority spots. Directional picks alone cluster: when the far corners are
  // already taken by landmarks, two "diagonal" picks fall back to neighbouring edge
  // blocks and the businesses pool again. So every shop quarter must also stand at
  // least 260 m from every other one (downtown included) — that hard separation is
  // what actually spreads commerce to the map's far quarters, out by the spur mouths.
  const shopPick = (dx, dz) => {
    let best = null, bd = -1e9;
    for (const b of free) {
      if (BLOCKS.some(o => o.zone === 'shops' && Math.hypot(o.cx - b.cx, o.cz - b.cz) < 260)) continue;
      const s = b.cx*dx + b.cz*dz - Math.hypot(b.cx, b.cz)*0.15;
      if (s > bd) { bd = s; best = b; }
    }
    if (best) { free.splice(free.indexOf(best), 1); best.zone = 'shops'; }
    return best;
  };
  shopPick(0.85, -0.85); shopPick(-0.85, 0.85);
  shopPick(0.85, 0.85);  shopPick(-0.85, -0.85);
  shopPick(0.05, 0.95);
  for (const b of BLOCKS) if (b.zone === 'house' && b.riverside) b.zone = 'riverpark';
  for (const b of free) if (b.zone === 'house' && prng() < 0.16) b.zone = 'park';
  HOME_BLOCK = ever || BLOCKS[0];

}

// ---- rolling countryside -------------------------------------------------
// Height is zero across the town and out past the ring highway, then swells into
// hills. Because the roads all sit at y=0 this keeps every carriageway flat.
const HILL_R0 = TOWN + 250;
function groundH(x, z) {
  const d = Math.hypot(x, z);
  if (d < HILL_R0) return 0;
  const fade = Math.min(1, (d - HILL_R0) / 260);
  // damped near the river too, so the banks still meet the water cleanly
  const rv = Math.min(1, Math.max(0, (Math.abs(z - riverZ(x)) - (RIVER_HW + 34)) / 90));
  const roll = Math.sin(x*0.0041)*Math.cos(z*0.0036)*30
             + Math.sin(x*0.0089 + 1.3)*Math.cos(z*0.0081 - 0.7)*14
             + Math.sin((x + z*0.6)*0.0025)*20;
  return fade * rv * (roll + 26);
}

// =================================================================
//  GROUND · ROADS · SIDEWALKS
// =================================================================
function noiseCanvas(size, base, amt) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = base; g.fillRect(0,0,size,size);
  const img = g.getImageData(0,0,size,size), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const n = (prng()-0.5)*amt; d[i]+=n; d[i+1]+=n; d[i+2]+=n; }
  g.putImageData(img,0,0);
  return { c, g };
}
function tex(c, rep, aniso) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso || 8; if (rep) t.repeat.set(rep, rep);
  return t;
}

// grass everywhere, then paved surfaces laid on top
{
  const { c, g } = noiseCanvas(128, '#77c157', 16);
  for (let i = 0; i < 240; i++) {                       // tufts
    g.fillStyle = prng()<0.5 ? 'rgba(112,186,80,.55)' : 'rgba(134,206,98,.55)';
    g.fillRect(prng()*128, prng()*128, 3, 6);
  }
  // Built as strips with a gap where the river runs — a single plane would simply
  // cover the water, since the channel is cut below ground level.
  const pos = [], uv = [], S = 26, FAR = 2400, STEP = 44, GAP = RIVER_HW + 11;
  const quadTZ = (xa, za0, za1, xb, zb0, zb1) => {
    const A=[xa,za0], B=[xb,zb0], C=[xb,zb1], D=[xa,za1];
    for (const [p,q,r2] of [[A,C,B],[A,D,C]]) {
      pos.push(p[0], groundH(p[0],p[1])-0.04, p[1],
               q[0], groundH(q[0],q[1])-0.04, q[1],
               r2[0], groundH(r2[0],r2[1])-0.04, r2[1]);
      uv.push(p[0]/S,p[1]/S, q[0]/S,q[1]/S, r2[0]/S,r2[1]/S);
    }
  };
  // Subdivided in *both* axes. Spanning the full depth with one pair of triangles
  // made the terrain a giant ramp from the distant hills down to the river, which
  // buried the whole town under grass.
  for (let x = -FAR; x < FAR; x += STEP) {
    const xa = x, xb = x + STEP, ra = riverZ(xa), rb = riverZ(xb);
    const nEdge = Math.min(ra, rb) - GAP, sEdge = Math.max(ra, rb) + GAP;
    let z = -FAR;
    while (z + STEP < nEdge) { quadTZ(xa, z, z+STEP, xb, z, z+STEP); z += STEP; }
    quadTZ(xa, z, ra-GAP, xb, z, rb-GAP);          // meets the bank exactly
    z = sEdge;
    quadTZ(xa, ra+GAP, z, xb, rb+GAP, z);
    while (z + STEP < FAR) { quadTZ(xa, z, z+STEP, xb, z, z+STEP); z += STEP; }
    quadTZ(xa, z, FAR, xb, z, FAR);
  }
  const gg = new THREE.BufferGeometry();
  gg.setAttribute('position', new THREE.Float32BufferAttribute(pos,3));
  gg.setAttribute('uv', new THREE.Float32BufferAttribute(uv,2));
  gg.computeVertexNormals();
  const ground = new THREE.Mesh(gg, toonMapped(tex(c, null, 16)));
  ground.receiveShadow = true; scene.add(ground);
}

const roadPos = [], roadUV = [], walkPos = [], walkUV = [], dashPos = [], zebraPos = [], lotPos = [], lotUV = [];
// Wound counter-clockwise seen from above, so computeVertexNormals points these up.
// Get it backwards and the whole road system faces the underside of the world.
function quad(arr, ax, az, bx, bz, w, y, uv, uS, vS, v0) {
  const dx=bx-ax, dz=bz-az, len=Math.hypot(dx,dz)||1, nx=-dz/len*w/2, nz=dx/len*w/2;
  arr.push(ax+nx,y,az+nz, bx-nx,y,bz-nz, ax-nx,y,az-nz,  ax+nx,y,az+nz, bx+nx,y,bz+nz, bx-nx,y,bz-nz);
  if (uv) { const u = w/uS, v1 = v0 + len/vS; uv.push(0,v0, u,v1, u,v0,  0,v0, 0,v1, u,v1); }
}
function disc(arr, cx, cz, r, y, uv, s) {
  const SEG = 14;
  for (let k = 0; k < SEG; k++) {
    const a0 = k/SEG*Math.PI*2, a1 = (k+1)/SEG*Math.PI*2;
    arr.push(cx, y, cz,
             cx+Math.cos(a1)*r, y, cz+Math.sin(a1)*r,
             cx+Math.cos(a0)*r, y, cz+Math.sin(a0)*r);
    if (uv) uv.push(cx/s, cz/s,
                    (cx+Math.cos(a1)*r)/s, (cz+Math.sin(a1)*r)/s,
                    (cx+Math.cos(a0)*r)/s, (cz+Math.sin(a0)*r)/s);
  }
}
function rect(arr, x0, z0, x1, z1, y, uv, s) {
  arr.push(x0,y,z0, x1,y,z1, x1,y,z0,  x0,y,z0, x0,y,z1, x1,y,z1);
  if (uv) { const u=(x1-x0)/s, v=(z1-z0)/s; uv.push(0,0, u,v, u,0,  0,0, 0,v, u,v); }
}
// The ground, lots, roads, kerbs, lane paint and crosswalks are all near-flat layers
// stacked a couple of centimetres apart. Seen from a car that reads fine, but from the
// air or the map the camera is hundreds of metres off and the depth buffer can no longer
// tell 2 cm apart — so the layers z-fight and the roads flicker on and off. A polygon
// offset biases each layer's depth by a fixed amount, so the paint always wins over the
// road and the road always wins over the grass no matter how far away the camera is.
function surface(pos, uv, mat, offset) {
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos,3));
  if (uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(uv,2));
  g.computeVertexNormals();
  if (offset) { mat = mat.clone(); mat.polygonOffset = true; mat.polygonOffsetFactor = offset; mat.polygonOffsetUnits = offset; }
  const m = new THREE.Mesh(g, mat); m.receiveShadow = true; scene.add(m); return m;
}

// ---- country highway: sweeps in from the south-west, crosses the river on a
// viaduct and disappears through a tunnel in the hills to the north-east ----
const HIGHWAY = [];
{
  // A closed ring, not an arc: an arc has two ends out in open country, which is the
  // most obvious "road to nowhere" on the map. The wobble is a function of the angle so
  // it is periodic and the loop closes without a seam.
  const R = TOWN + 150, N = 96;
  for (let k = 0; k < N; k++) {
    const a = k/N*Math.PI*2;
    HIGHWAY.push({
      x: Math.cos(a)*R + Math.sin(a*3)*40,
      z: Math.sin(a)*R + Math.cos(a*5)*46,
    });
  }
  for (let k = 0; k < N; k++) {
    const n = HIGHWAY[(k+1) % N];
    STREETS.push({ ax:HIGHWAY[k].x, az:HIGHWAY[k].z, bx:n.x, bz:n.z, kind:'highway', w: ROAD_HW*1.5 });
  }
  // spurs joining the ring to all four corners of town, each from its nearest point,
  // so the perimeter is reachable from every quarter rather than one lucky exit
  const nearestHwy = p => HIGHWAY.reduce((best, h) =>
    (h.x-p.x)**2 + (h.z-p.z)**2 < (best.x-p.x)**2 + (best.z-p.z)**2 ? h : best, HIGHWAY[0]);
  for (const corner of [CORNER[0][GN-1], CORNER[GN-1][0], CORNER[0][0], CORNER[GN-1][GN-1]]) {
    const h = nearestHwy(corner);
    STREETS.push({ ax:h.x, az:h.z, bx:corner.x, bz:corner.z, kind:'highway', w: ROAD_HW*1.4 });
  }
}

// ---- "is this spot on tarmac?" ------------------------------------------
// Street segments bucketed into a coarse grid, so scenery can be tested exactly
// instead of hoping it missed. Trees kept landing on the country highway, which
// loops straight through the belt of woodland around the town.
const SEGQ = 60, segGrid = new Map();
for (const st of STREETS) {
  const L = Math.hypot(st.bx-st.ax, st.bz-st.az) || 1;
  const n = Math.max(1, Math.ceil(L/SEGQ));
  for (let k = 0; k <= n; k++) {
    const x = st.ax + (st.bx-st.ax)*k/n, z = st.az + (st.bz-st.az)*k/n;
    const key = Math.floor(x/SEGQ) + ',' + Math.floor(z/SEGQ);
    let b = segGrid.get(key); if (!b) segGrid.set(key, b = []);
    if (!b.includes(st)) b.push(st);
  }
}
function onRoad(x, z, margin) {
  const gx = Math.floor(x/SEGQ), gz = Math.floor(z/SEGQ);
  for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
    const b = segGrid.get((gx+ox) + ',' + (gz+oz)); if (!b) continue;
    for (const st of b) {
      const dx = st.bx-st.ax, dz = st.bz-st.az, L2 = dx*dx + dz*dz || 1;
      let t = ((x-st.ax)*dx + (z-st.az)*dz) / L2;
      t = Math.max(0, Math.min(1, t));
      const cx = st.ax + dx*t, cz = st.az + dz*t;
      if (Math.hypot(x-cx, z-cz) < st.w + (margin||0)) return true;
    }
  }
  return false;
}

// A block's buildable rect starts as the polygon's bounding box, which for a jittered
// or merged block includes ground that is actually roadway. Pull each rect in until
// its whole perimeter is clear, so anything placed inside it is clear too.
for (const B of BLOCK_SHRINK) {
  const clear = r => {
    for (let t = 0; t <= 1.0001; t += 0.125) {
      const x = r.x0 + (r.x1-r.x0)*t, z = r.z0 + (r.z1-r.z0)*t;
      if (onRoad(x, r.z0, 0.5) || onRoad(x, r.z1, 0.5)) return false;
      if (onRoad(r.x0, z, 0.5) || onRoad(r.x1, z, 0.5)) return false;
    }
    return true;
  };
  for (let k = 0; k < 14 && !clear(B.r); k++) {
    B.r.x0 += 2.5; B.r.x1 -= 2.5; B.r.z0 += 2.5; B.r.z1 -= 2.5;
    if (B.r.x1 - B.r.x0 < 12 || B.r.z1 - B.r.z0 < 12) break;
  }
  B.cx = (B.r.x0 + B.r.x1)/2; B.cz = (B.r.z0 + B.r.z1)/2;
}

// ---- lay every street down: sidewalk, carriageway, centre line ----
const CROSS_AT = ROAD_HW + 2.4;
for (const s of STREETS) {
  const L = Math.hypot(s.bx-s.ax, s.bz-s.az) || 1;
  const ux = (s.bx-s.ax)/L, uz = (s.bz-s.az)/L;
  // highways run through open country, so no sidewalk on those
  if (s.kind !== 'highway')
    quad(walkPos, s.ax, s.az, s.bx, s.bz, s.w + 9, 0.02, walkUV, 4, 4, 0);
  const over = s.w*0.8;                                // overlap so junctions have no seams
  quad(roadPos, s.ax-ux*over, s.az-uz*over, s.bx+ux*over, s.bz+uz*over, s.w*2, 0.05, roadUV, 8, 8, 0);
  // dashes down the middle, stopping short of each junction
  const skip = s.w + 7;
  for (let d = skip; d < L - skip - 3; d += 12) {
    const e = Math.min(d + 6, L - skip);
    quad(dashPos, s.ax+ux*d, s.az+uz*d, s.ax+ux*e, s.az+uz*e, s.kind === 'highway' ? 0.7 : 0.55, 0.075);
  }
}

// junction pads and their zebra crossings
for (let i = 0; i < GN; i++) for (let j = 0; j < GN; j++) {
  const c = CORNER[i][j];
  if (!c.deg) continue;
  disc(walkPos, c.x, c.z, ROAD_HW + 9.5, 0.021, walkUV, 4);
  disc(roadPos, c.x, c.z, ROAD_HW + 1.5, 0.055, roadUV, 8);
  if (c.deg < 3) continue;
  for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const bx = c.x + dx*CROSS_AT, bz = c.z + dz*CROSS_AT;
    const px = -dz, pz = dx;
    for (let k = -4; k <= 4; k++) {
      const ox = bx + px*k*1.5, oz = bz + pz*k*1.5;
      quad(zebraPos, ox - dx*1.6, oz - dz*1.6, ox + dx*1.6, oz + dz*1.6, 0.75, 0.08);
    }
  }
}
{
  const { c: rc, g: rg } = noiseCanvas(256, '#5b5570', 20);
  rg.strokeStyle = 'rgba(40,36,54,.35)'; rg.lineWidth = 3;
  for (let i = 0; i < 4; i++) { rg.beginPath(); const y = prng()*256; rg.moveTo(0,y); rg.lineTo(256, y+rnd(-18,18)); rg.stroke(); }
  surface(roadPos, roadUV, toonMapped(tex(rc, null, 16)), -2);   // road sits above the grass

  const { c: wc, g: wg } = noiseCanvas(256, '#cfd3d8', 12);
  wg.strokeStyle = 'rgba(120,126,136,.65)'; wg.lineWidth = 4;
  for (let i = 0; i <= 4; i++) { const p = Math.round(i*64);
    wg.beginPath(); wg.moveTo(p,0); wg.lineTo(p,256); wg.stroke();
    wg.beginPath(); wg.moveTo(0,p); wg.lineTo(256,p); wg.stroke(); }
  surface(walkPos, walkUV, toonMapped(tex(wc, null, 16)), -2);   // sidewalk above the grass

  surface(dashPos, null, toon(0xf2c73c), -5);                    // lane paint above the road
  surface(zebraPos, null, toon(0xf2f2ee), -5);                   // crosswalks above the road
}

// kerbs: a thin lip along both sides of every street, so sidewalks read as raised
{
  const kerb = [];
  const strip = (ax, az, bx, bz) => {
    const dx=bx-ax, dz=bz-az, L=Math.hypot(dx,dz), ux=dx/L, uz=dz/L, nx=-uz, nz=ux;
    for (const s of [1,-1]) {
      const ox = nx*ROAD_HW*s, oz = nz*ROAD_HW*s;
      kerb.push(baked(new THREE.BoxGeometry(0.5, 0.22, L), ax+dx/2+ox, 0.11, az+dz/2+oz, 0, Math.atan2(ux, uz)));
    }
  };
  for (const st of STREETS) if (st.kind !== 'highway') strip(st.ax, st.az, st.bx, st.bz);
  const m = new THREE.Mesh(merge(kerb), toon(0xe4e7ea)); m.receiveShadow = true; scene.add(m);
}

// =================================================================
//  COLLIDERS
// =================================================================
const colliders = [], mapBoxes = [];
// Does an oriented footprint touch any carriageway? Samples corners, edge midpoints
// and centre — enough for the rectangles everything here is built from.
function footprintOnRoad(cx, cz, w, d, yaw, m) {
  const c = Math.cos(yaw || 0), s = Math.sin(yaw || 0);
  const hw = w/2 + (m||0), hd = d/2 + (m||0);
  for (const [lx, lz] of [[-hw,-hd],[hw,-hd],[hw,hd],[-hw,hd],[0,0],[0,-hd],[0,hd],[-hw,0],[hw,0]]) {
    if (onRoad(cx + lx*c + lz*s, cz - lx*s + lz*c, 0.4)) return true;
  }
  return false;
}
const roadClash = {};   // regression check: should stay empty
// footprint w x d turned by yaw, as an axis-aligned box
const aabbW = (w, d, yaw) => Math.abs(w*Math.cos(yaw)) + Math.abs(d*Math.sin(yaw));
const aabbD = (w, d, yaw) => Math.abs(w*Math.sin(yaw)) + Math.abs(d*Math.cos(yaw));
// Nudge a footprint until it clears every carriageway: first back it off the kerb it
// fronts, then slide it along the frontage. Returns null if it simply doesn't fit.
// Would this footprint sit inside something already built? Footprints here are all
// axis-aligned, so the world box is just w/d swapped by the facing.
function footprintClash(x, z, w, d, yaw, gap) {
  const W = aabbW(w, d, yaw), D = aabbD(w, d, yaw);
  const m = gap === undefined ? 1.0 : gap;
  const x0 = x - W/2 - m, x1 = x + W/2 + m, z0 = z - D/2 - m, z1 = z + D/2 + m;
  for (const c of colliders)
    if (c.maxX > x0 && c.minX < x1 && c.maxZ > z0 && c.minZ < z1) return true;
  return false;
}
function placeClear(cx, cz, fx, fz, w, d, yaw) {
  const sx = -fz, sz = fx;                       // along the frontage
  // Must clear the road *and* everything already standing. If the whole frontage is
  // taken the caller gets null and simply doesn't build: a gap in a terrace reads as a
  // gap, whereas a shop with a house through it reads as broken.
  for (const back of [0, 2, 4, 6, 9, 12, 16]) {
    for (const side of [0, 5, -5, 10, -10, 16, -16, 22, -22]) {
      const x = cx - fx*back + sx*side, z = cz - fz*back + sz*side;
      if (footprintOnRoad(x, z, w, d, yaw, 0.8)) continue;
      if (footprintClash(x, z, w, d, yaw)) continue;
      return { x, z };
    }
  }
  return null;
}
// `group` names the structure a box belongs to. Landmarks are built from many abutting
// boxes — a stadium ring, a prison perimeter — and those touching each other is the
// design, not a defect, so the audit ignores pairs from the same group.
// w/d are the axis-aligned collider. `foot` optionally gives the true rotated footprint
// {w, d, yaw} for the road audit — a house on a jittered frontage is not axis-aligned,
// and auditing its bounding box flags corners that never touch the tarmac.
function addBox(x, z, w, d, kind, group, foot) {
  colliders.push({ minX:x-w/2, maxX:x+w/2, minZ:z-d/2, maxZ:z+d/2 });
  mapBoxes.push({ x, z, w, d, kind: kind || 'house', group });
  const f = foot || { w, d, yaw: 0 };
  if (footprintOnRoad(x, z, f.w, f.d, f.yaw, 0)) {
    const k = kind || 'house';
    (roadClash[k] = roadClash[k] || []).push([Math.round(x), Math.round(z), Math.round(w), Math.round(d)]);
  }
}
function pointBlocked(x, z, m) {
  for (const c of colliders) if (x > c.minX-m && x < c.maxX+m && z > c.minZ-m && z < c.maxZ+m) return true;
  return false;
}
function collideCircle(px, pz, r, list, overY) {
  let x = px, z = pz, hit = false;
  for (const b of list) {
    // low barriers (guardrails, fences, bridge rails) carry a `jump` top height; once
    // the player's feet clear it, they pass straight over — that is what makes a jump
    // over a rail land on the far side instead of bouncing off it.
    if (b.jump !== undefined && overY !== undefined && overY >= b.jump) continue;
    if (x + r > b.minX && x - r < b.maxX && z + r > b.minZ && z - r < b.maxZ) {
      const oL=(x+r)-b.minX, oR=b.maxX-(x-r), oT=(z+r)-b.minZ, oB=b.maxZ-(z-r);
      const m = Math.min(oL,oR,oT,oB);
      if (m===oL) x=b.minX-r; else if (m===oR) x=b.maxX+r; else if (m===oT) z=b.minZ-r; else z=b.maxZ+r;
      hit = true;
    }
  }
  return { x, z, hit };
}

// =================================================================
//  SURFACES
//  Flat colour is the house style, but a whole town of it reads as plastic:
//  standing in the street, nothing tells you a wall is brick rather than
//  painted board. These are small procedural canvases — mortar courses,
//  shingle tabs, lap siding, grout — drawn near-white so the bucket's own
//  colour tints them, and hung as `map` on the same toon material. No assets,
//  nothing to download, and the flat-shaded look survives intact.
//
//  The UVs are generated at flush time (see projectUV), not taken from the
//  geometry. A BoxGeometry's UVs run 0..1 per face, so a brick texture would
//  stretch to fit each surface — eight courses on a 3 m wall and eight on a
//  30 m one, which is the single thing that reads as fake fastest. Projecting
//  each triangle onto the world axis its normal points down instead keeps the
//  brick the same size everywhere in town.
// =================================================================
function surfCanvas(px, draw) {
  const c = document.createElement('canvas'); c.width = c.height = px;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, px, px);
  draw(g, px);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}
// A tiny local generator for the speckled surfaces. Deliberately not prng() (the town's
// stream must not see the artwork) and deliberately not Math.random() either, so the
// stucco is the same stucco on every load.
function texRnd(seed) { let x = seed; return () => (x = Math.imul(x ^ (x >>> 15), 0x2545f491) >>> 0) / 4294967296; }

const texBrick = surfCanvas(256, (g, P) => {
  const rows = 10, hR = P/rows, bw = P/4;
  g.fillStyle = '#c6c6c6'; g.fillRect(0, 0, P, P);              // mortar behind everything
  for (let r = 0; r < rows; r++) {
    const off = (r % 2) * bw/2;
    for (let b = -1; b <= 4; b++) {
      const v = 250 - ((r*7 + b*13) % 5) * 8;                   // course-to-course variation
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(b*bw + off + 1.6, r*hR + 1.6, bw - 3.2, hR - 3.2);
    }
  }
});
const texShingle = surfCanvas(256, (g, P) => {
  const rows = 9, hR = P/rows, tw = P/6;
  g.fillStyle = '#b9b9b9'; g.fillRect(0, 0, P, P);
  for (let r = 0; r < rows; r++) {
    const off = (r % 2) * tw/2;
    for (let b = -1; b <= 6; b++) {
      const v = 252 - ((r*5 + b*11) % 4) * 11;
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(b*tw + off + 1, r*hR, tw - 2, hR - 2.6);       // gap only along the butt edge
    }
  }
});
const texSiding = surfCanvas(128, (g, P) => {
  const rows = 7, hR = P/rows;
  for (let r = 0; r < rows; r++) {
    g.fillStyle = 'rgb(253,253,253)'; g.fillRect(0, r*hR, P, hR - 1.6);
    g.fillStyle = 'rgba(0,0,0,0.16)'; g.fillRect(0, r*hR + hR - 2.2, P, 2.2);   // the lap shadow
  }
});
const texStucco = surfCanvas(128, (g, P) => {
  const R = texRnd(0x5eed01);
  for (let i = 0; i < 3000; i++) {
    g.fillStyle = `rgba(0,0,0,${0.04 + R()*0.07})`;
    g.fillRect((R()*P)|0, (R()*P)|0, 2, 2);
  }
});
const texTile = surfCanvas(128, (g, P) => {                      // the classic checker floor
  const n = 4, sz = P/n;
  g.fillStyle = '#b4b4b4'; g.fillRect(0, 0, P, P);               // grout
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const v = (x + y) % 2 ? 214 : 253;
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(x*sz + 1.6, y*sz + 1.6, sz - 3.2, sz - 3.2);
  }
});
const texPlank = surfCanvas(128, (g, P) => {
  const R = texRnd(0xb0a2d), rows = 5, hR = P/rows;
  for (let r = 0; r < rows; r++) {
    const v = 252 - ((r*7) % 3) * 10;
    g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(0, r*hR, P, hR - 1.2);
    g.fillStyle = 'rgba(0,0,0,0.18)';   g.fillRect(0, r*hR + hR - 1.6, P, 1.6);
    for (let k = 0; k < 5; k++) {                                // grain
      g.fillStyle = `rgba(0,0,0,${0.05 + R()*0.05})`;
      g.fillRect(R()*P, r*hR + 2 + R()*(hR - 6), 10 + R()*30, 1);
    }
    g.fillStyle = 'rgba(0,0,0,0.2)';                             // one butt joint per course
    g.fillRect(((r*47) % P), r*hR, 1.4, hR - 1.6);
  }
});

// scale is texture tiles per metre — the only dial that matters for how big the
// brick looks, and the one worth putting on the G panel
const SURFACES = {
  brick:   { tex: texBrick,   scale: 0.62 },
  shingle: { tex: texShingle, scale: 0.55 },
  siding:  { tex: texSiding,  scale: 0.42 },
  stucco:  { tex: texStucco,  scale: 0.3  },
  tile:    { tex: texTile,    scale: 0.42 },
  plank:   { tex: texPlank,   scale: 0.34 },
  // Not a texture at all — a surface kind with no map, riding the same bucket split so
  // shop glazing can be its own material without inventing a second mechanism.
  glass:   { tex: null, scale: 1, see: true },
};
const surfCache = new Map();
function surfMat(color, kind) {
  const k = color + ':' + kind;
  if (!surfCache.has(k)) {
    const S = SURFACES[kind];
    // depthWrite off, or the pane occludes the room behind it and you are back to
    // looking at a blue rectangle. It also keeps the ink pass off the glass, so the
    // outlines you see through a window are the shelves' own.
    surfCache.set(k, S.see
      ? new THREE.MeshToonMaterial({ color, gradientMap: RAMP, transparent: true,
                                     opacity: 0.3, depthWrite: false })
      : new THREE.MeshToonMaterial({ color, gradientMap: RAMP, map: S.tex }));
  }
  return surfCache.get(k);
}
// Project every triangle onto the world plane its normal points at. Merged town geometry
// is already in world space, so this is a straight read of position — no per-face bookkeeping
// and no shader. Works on the cylinders and prisms too, near enough for a cartoon.
function projectUV(geo, scale) {
  const p = geo.attributes.position, n = geo.attributes.normal;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i += 3) {
    const nx = Math.abs(n.getX(i)), ny = Math.abs(n.getY(i)), nz = Math.abs(n.getZ(i));
    const axis = (ny >= nx && ny >= nz) ? 1 : (nx >= nz ? 0 : 2);
    for (let k = 0; k < 3; k++) {
      const j = i + k;
      const x = p.getX(j), y = p.getY(j), z = p.getZ(j);
      uv[j*2]     = (axis === 0 ? z : x) * scale;
      uv[j*2 + 1] = (axis === 1 ? z : y) * scale;
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}
// Which surface a given building gets. Hashed from its own coordinates rather than
// drawn from prng(), for the same reason all the trim geometry is: a single extra draw
// from the seeded stream here would re-roll the entire town. Same house, same brick,
// every load — and it costs nothing.
function vary(x, z, n) {
  let h = Math.imul((Math.round(x*13) * 73856093) ^ (Math.round(z*13) * 19349663), 0x45d9f3b);
  h ^= h >>> 15; h = Math.imul(h, 0x27d4eb2d); h ^= h >>> 13;
  return (h >>> 0) % n;
}
// Brick wants its own palette — pastel-mint brick is not a thing.
const BRICK_COLS = [0xb5654a, 0xa8534a, 0xc47c5c, 0x8f5a4a, 0xcfa88a];

// =================================================================
//  BUILDINGS
//  Parts are bucketed by colour and merged, so the whole town is a
//  handful of draw calls while every house still looks individual.
// =================================================================
// Buckets are keyed on colour *and* surface, not colour alone: a brick wall and a
// painted one can share a colour but not a material, and merging them would put mortar
// courses on the smooth one. An untextured put keeps its plain colour key, so nothing
// that doesn't ask for a surface pays for one.
const BUCKETS = new Map();
const bkey = (color, kind) => kind ? color + ':' + kind : String(color);
function put(color, geo, kind) {
  // mergeGeometries returns null unless every input agrees on indexing and attributes,
  // and the roof prisms below are built non-indexed — normalise here.
  if (geo.index) geo = geo.toNonIndexed();
  const k = bkey(color, kind);
  let b = BUCKETS.get(k); if (!b) BUCKETS.set(k, b = { color, kind, list: [] });
  b.list.push(geo);
}
const BOX = (w,h,d) => new THREE.BoxGeometry(w,h,d);
// Remember the geometry put() just bucketed, so it can be withdrawn later if the building
// turns out to be one we hollow out. Everything is still *built* either way, which is what
// keeps the seeded stream — and therefore the town — identical.
const lastPut = (color, kind) => {
  const k = bkey(color, kind), b = BUCKETS.get(k);
  return [k, b.list[b.list.length-1]];
};
const withdraw = drop => {
  for (const [k, g] of drop) {
    const b = BUCKETS.get(k); if (!b) continue;
    const i = b.list.indexOf(g); if (i >= 0) b.list.splice(i, 1);
  }
};

// =================================================================
//  ROOMS YOU CAN WALK INTO
//  Modelled in place rather than teleported to: the building's body is built as a
//  shell with a doorway cut in the front wall, so the interior is simply part of the
//  town and walking in needs no transition at all.
// =================================================================
const DOOR_W = 2.2, DOOR_H = 3.6;      // shop doorway; 742 has its own, narrower
const WALL_T = 0.8;                    // visible wall thickness, and the collider's
const CEIL_H = 4.6;
const ROOMS = [];
// Playable minigame sites, recorded by the fit-out pass as it builds the rooms:
// PUTTS gets each Putt Paradise's real cup positions and a tee; BOWLS gets each
// Strike City's first lane; RUSHES gets Bargain Barn's clear aisle spots; WHACKS
// gets Pixel Palace's cabinets; DANCES gets Club Inferno's lit floor tiles;
// PINTS gets the Rusty Mug's bar line. The runtime systems live in the
// MINIGAMES section.
const PUTTS = [], BOWLS = [], RUSHES = [], WHACKS = [], DANCES = [], PINTS = [];
const HEISTS = [], KOIS = [], OWLS = [];   // museum heist, sushi conveyor, owl initiation

// The glazing band's opening, in building-local Y. Everything that stands in front of a
// shop window — the shell wall, the room's own lining, the dark band the glass sits in —
// has to have this hole cut in it, or a transparent pane just shows you the wall behind.
const WIN0 = 0.62, WIN1 = 3.52;
// Emit a wall run with that hole punched through it. Anything outside the glazing's own
// x-span stays solid, as does the sill below the band and the spandrel above it. If the
// run doesn't overlap the glazing at all it comes out as one box, exactly as before.
// `emit(cx, cy, width, height)` builds the piece.
function cutWall(emit, x0, x1, yBot, yTop, gLo, gHi) {
  if (x1 - x0 < 0.02 || yTop - yBot < 0.02) return;
  const a = Math.max(x0, gLo), b = Math.min(x1, gHi);
  const w0 = Math.max(yBot, WIN0), w1 = Math.min(yTop, WIN1);
  if (b - a < 0.3 || w1 - w0 < 0.1) { emit((x0+x1)/2, (yBot+yTop)/2, x1-x0, yTop-yBot); return; }
  if (a - x0 > 0.02) emit((x0+a)/2, (yBot+yTop)/2, a-x0, yTop-yBot);      // jamb, left
  if (x1 - b > 0.02) emit((b+x1)/2, (yBot+yTop)/2, x1-b, yTop-yBot);      // jamb, right
  const cw = b - a, cx = (a + b)/2;
  if (w0 - yBot > 0.02) emit(cx, (yBot+w0)/2, cw, w0-yBot);               // sill
  if (yTop - w1 > 0.02) emit(cx, (w1+yTop)/2, cw, yTop-w1);               // spandrel
}

// The building's outer walls, with a gap cut for the doorway. `L` maps building-local
// geometry into the world; `q` slides the doorway along the facade in local x, so the
// opening can dodge whatever ended up parked outside. `gz` is the glazing's half-width
// when the front is a shopfront — the front wall gets a window hole to match.
function buildShell(L, w, d, h, wallCol, dw, dh, q, skin, gz) {
  const T = WALL_T, hw = w/2, hd = d/2;
  put(wallCol, L(baked(BOX(w, h, T), 0, h/2, -hd + T/2)), skin);                // back
  put(wallCol, L(baked(BOX(T, h, d - T*2), -hw + T/2, h/2, 0)), skin);          // left
  put(wallCol, L(baked(BOX(T, h, d - T*2),  hw - T/2, h/2, 0)), skin);          // right
  const face = (cx, cy, pw, ph) => put(wallCol, L(baked(BOX(pw, ph, T), cx, cy, hd - T/2)), skin);
  const g = gz || 0;
  cutWall(face, -hw, q - dw/2, 0, h, -g, g);                                   // front, door-left
  cutWall(face, q + dw/2, hw,  0, h, -g, g);                                   // front, door-right
  face(q, dh + (h - dh)/2, dw, h - dh);                                        // header over the door
}

// The habitable room inside the shell. `ir` is its local rect, which is the shell's
// interior trimmed back off anything the town had already built inside this footprint —
// so the far side of a partition may be a dead space nobody can reach. `ir.z1` is always
// the door wall and never moves.
function buildRoomBox(L, ir, dw, dh, q, floor, gz) {
  const rw = ir.x1 - ir.x0, rd = ir.z1 - ir.z0, cxl = (ir.x0 + ir.x1)/2, czl = (ir.z0 + ir.z1)/2;
  const LIN = 0xf2e4c8, SK = 0x8c6a44, P = 0.3;
  put(0xf0efe6, L(baked(BOX(rw, 0.3, rd), cxl, CEIL_H + 0.15, czl)));           // ceiling
  // tiled or boarded, by the room's own coordinates — a checkerboard shop floor and a
  // boarded one next door is most of what makes two identical rooms read as two places
  put(floor === 'tile' ? 0xe6e2d8 : 0x9a6b3f,
      L(baked(BOX(rw, 0.14, rd), cxl, 0.02, czl)), floor || 'plank');
  put(LIN, L(baked(BOX(rw, CEIL_H, P), cxl, CEIL_H/2, ir.z0 + P/2)));           // back
  put(LIN, L(baked(BOX(P, CEIL_H, rd), ir.x0 + P/2, CEIL_H/2, czl)));           // left
  put(LIN, L(baked(BOX(P, CEIL_H, rd), ir.x1 - P/2, CEIL_H/2, czl)));           // right
  // the door wall, split around the doorway — and around the shop window, so the lining
  // isn't the thing you end up looking at through the glass
  const face = (cx, cy, pw, ph) => put(LIN, L(baked(BOX(pw, ph, P), cx, cy, ir.z1 - P/2)));
  const g = gz || 0;
  const lw = (q - dw/2) - ir.x0, rr = ir.x1 - (q + dw/2);      // skirting runs, below the window
  cutWall(face, ir.x0, q - dw/2, 0, CEIL_H, -g, g);
  cutWall(face, q + dw/2, ir.x1, 0, CEIL_H, -g, g);
  face(q, dh + (CEIL_H - dh)/2, dw, CEIL_H - dh);
  put(SK, L(baked(BOX(rw, 0.34, 0.14), cxl, 0.17, ir.z0 + P + 0.07)));
  put(SK, L(baked(BOX(0.14, 0.34, rd), ir.x0 + P + 0.07, 0.17, czl)));
  put(SK, L(baked(BOX(0.14, 0.34, rd), ir.x1 - P - 0.07, 0.17, czl)));
  if (lw > 0.02) put(SK, L(baked(BOX(lw, 0.34, 0.14), ir.x0 + lw/2, 0.17, ir.z1 - P - 0.07)));
  if (rr > 0.02) put(SK, L(baked(BOX(rr, 0.34, 0.14), ir.x1 - rr/2, 0.17, ir.z1 - P - 0.07)));
}

// Four wall colliders with a gap where the doorway is. Thickness is WALL_T, which with
// collideCircle's 0.75 m probe gives a 2.3 m overlap band — RUN*dt is 0.6 m in a single
// frame, so a run cannot step over it. That band is what replaces the old void-room clamp.
// `r` is the room's walkable rect in world space. Walls are laid just outside it, WALL_T
// thick, with a gap on the door face. That thickness plus collideCircle's 0.75 m probe
// gives a 2.3 m overlap band, against a worst-case 0.6 m step (RUN * the 0.05 s dt clamp).
function shellColliders(r, fx, fz, dw, dcx, dcz) {
  const t = WALL_T, mine = [];
  const add = (ax, az, bx, bz) => {
    const b = { minX:ax, maxX:bx, minZ:az, maxZ:bz }; colliders.push(b); mine.push(b);
  };
  for (const f of [{ n:[0,-1], box:[r.x0-t, r.z0-t, r.x1+t, r.z0], axis:'x' },
                   { n:[0, 1], box:[r.x0-t, r.z1, r.x1+t, r.z1+t], axis:'x' },
                   { n:[-1,0], box:[r.x0-t, r.z0-t, r.x0, r.z1+t], axis:'z' },
                   { n:[ 1,0], box:[r.x1, r.z0-t, r.x1+t, r.z1+t], axis:'z' }]) {
    const [ax, az, bx, bz] = f.box;
    if (Math.abs(f.n[0]-fx) > 0.01 || Math.abs(f.n[1]-fz) > 0.01) { add(ax, az, bx, bz); continue; }
    if (f.axis === 'x') { add(ax, az, dcx - dw/2, bz); add(dcx + dw/2, az, bx, bz); }
    else                { add(ax, az, bx, dcz - dw/2); add(ax, dcz + dw/2, bx, bz); }
  }
  return mine;
}

function addRoom(name, r, cx, cz, fx, fz, dw, walls) {
  const R = { name, cx: (r.x0+r.x1)/2, cz: (r.z0+r.z1)/2, fx, fz, dw,
              walls: walls || [], inner: r, ceil: CEIL_H };
  ROOMS.push(R); return R;
}

// Buildings whose shell is deferred until every block is filled — a doorway has to know
// what ended up standing outside it before it can pick a spot on the facade.
const WALKIN = [];
// Two more drive-in conversions handled in the same deferred way: the Retirement
// Castle gets a gate and a hollow great hall, the stadium loses two segments to an
// open gateway. Their parts are built solid first (identical RNG burns), then dropped.
const CASTLE = { drop: [], col: null, cx: 0, cz: 0, w: 0, d: 0 };
let TIREFIRE = null;
const STADIUM = { gate: [], cx: 0, cz: 0, rx: 0, rz: 0 };
const PRISON = { drop: [], col: null, gate: null, newCols: [] };

const WALL_COLS = [0xf2d9b0, 0xf6c9c1, 0xcfe6c8, 0xc9dcef, 0xe6d4ea, 0xfbe7a8, 0xf0efe6, 0xd9c7a8];
const ROOF_COLS = [0xa8493f, 0x4f7d8c, 0x7b5ea7, 0x9a6b3f, 0x3f7a55, 0x8c3f5e, 0x4a5a7d];
const DOOR_COLS = [0x8c4a2f, 0x3f5f8c, 0x6a3f6a, 0x2f6a52, 0xa03f3f];
const TRIM = 0xfdfcf7, GLASS = 0x8fd3ef;

// a pitched roof as a triangular prism
function roofPrism(w, h, d) {
  const hw = w/2, hd = d/2, pos = [], nrm = [];
  const tri = (ax,ay,az, bx,by,bz, cx,cy,cz) => {
    const ux=bx-ax, uy=by-ay, uz=bz-az, vx=cx-ax, vy=cy-ay, vz=cz-az;
    let nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx;
    const L=Math.hypot(nx,ny,nz)||1; nx/=L; ny/=L; nz/=L;
    pos.push(ax,ay,az, bx,by,bz, cx,cy,cz);
    for (let i=0;i<3;i++) nrm.push(nx,ny,nz);
  };
  tri(-hw,0,-hd,  hw,0,-hd,  hw,0,hd); tri(-hw,0,-hd,  hw,0,hd, -hw,0,hd);      // underside
  tri(-hw,0,-hd, -hw,0,hd,   0,h,hd);  tri(-hw,0,-hd,  0,h,hd,   0,h,-hd);      // left slope
  tri( hw,0,hd,   hw,0,-hd,  0,h,-hd); tri( hw,0,hd,   0,h,-hd,  0,h,hd);       // right slope
  tri(-hw,0,-hd,  0,h,-hd,   hw,0,-hd);                                          // gables
  tri( hw,0,hd,   0,h,hd,   -hw,0,hd);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos,3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm,3));
  const uv = []; for (let i = 0; i < pos.length/3; i++) uv.push(0, 0);
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv,2));
  return g;
}

// one suburban house, facing +face (a unit vector toward its street)
function makeHouse(cx, cz, fx, fz, w, d) {
  const yaw = Math.atan2(fx, fz);
  const spot = placeClear(cx, cz, fx, fz, w, d, yaw);
  if (!spot) return null;                        // nowhere clear of the road for it
  cx = spot.x; cz = spot.z;
  let wall = rpick(WALL_COLS);
  const roof = rpick(ROOF_COLS), door = rpick(DOOR_COLS);
  const storeys = prng() < 0.35 ? 2 : 1;
  const h = storeys === 2 ? rnd(8.5, 10) : rnd(5.4, 6.4);
  const L = (g) => baked(g, cx, 0, cz, 0, yaw, 0);   // place in the house's own frame

  // Wall surface, and for a brick house its colour too. Both come from vary() — the
  // coordinate hash — so a street is a genuine mix of brick, board and render without
  // the generator drawing a single extra random. rpick(WALL_COLS) above still happens
  // either way; brick just overrides what came out, so the stream is untouched.
  const skin = ['brick', 'siding', 'siding', 'stucco', 'brick', 'siding'][vary(cx, cz, 6)];
  if (skin === 'brick') wall = BRICK_COLS[vary(cz, cx, BRICK_COLS.length)];

  put(wall, L(baked(BOX(w, h, d), 0, h/2, 0)), skin);
  put(roof, L(baked(roofPrism(w+1.4, rnd(2.6,3.8), d+1.4), 0, h, 0)), 'shingle');

  const front = d/2 + 0.06;
  // Trim detail. All of it is derived from w/d/h — no rnd() anywhere in here, so the
  // seeded stream never sees it and the town stays byte-identical. (Adding new bucket
  // colours is free now too: three.js takes its UUIDs from the real Math.random.)
  put(0x9a8f7a, L(baked(BOX(w+0.5, 0.65, d+0.5), 0, 0.32, 0)));      // plinth course
  put(TRIM, L(baked(BOX(w+1.5, 0.34, d+1.5), 0, h - 0.17, 0)));      // eaves fascia
  // door: recessed frame, panel, step, and a knob you can actually see
  put(TRIM, L(baked(BOX(2.4, 3.5, 0.14), 0, 1.72, front - 0.02)));
  put(door, L(baked(BOX(1.9, 3.1, 0.25), 0, 1.55, front)));
  put(0xc9a24b, L(baked(new THREE.SphereGeometry(0.1, 10, 8), 0.68, 1.62, front + 0.15)));
  put(TRIM, L(baked(BOX(2.5, 0.22, 0.9), 0, 0.11, front+0.4)));
  // windows either side, and upstairs — each gets a sill and a mullion cross, which
  // is what stops a window reading as a flat blue rectangle
  const winY = [1.9], colsX = [-w*0.28, w*0.28];
  if (storeys === 2) winY.push(h - 2.3);
  for (const wy of winY) for (const wx of colsX) {
    put(TRIM, L(baked(BOX(2.3, 2.1, 0.18), wx, wy, front)));
    put(GLASS, L(baked(BOX(1.8, 1.6, 0.24), wx, wy, front+0.04)));
    put(TRIM, L(baked(BOX(2.6, 0.16, 0.44), wx, wy - 1.12, front + 0.16)));   // sill
    put(TRIM, L(baked(BOX(0.12, 1.6, 0.3), wx, wy, front + 0.06)));           // mullion
    put(TRIM, L(baked(BOX(1.8, 0.12, 0.3), wx, wy, front + 0.06)));
  }
  // side windows
  for (const s of [1,-1]) {
    put(TRIM, L(baked(BOX(0.18, 1.9, 2.1), s*(w/2+0.05), h*0.55, 0)));
    put(GLASS, L(baked(BOX(0.24, 1.4, 1.6), s*(w/2+0.09), h*0.55, 0)));
    put(TRIM, L(baked(BOX(0.3, 0.14, 2.4), s*(w/2+0.14), h*0.55 - 1.0, 0)));  // sill
    put(TRIM, L(baked(BOX(0.3, 1.4, 0.11), s*(w/2+0.12), h*0.55, 0)));        // mullion
  }
  if (prng() < 0.55) {                                    // chimney
    const bx = rnd(-w*0.3, w*0.3);
    put(0x9a5c4a, L(baked(BOX(1.5, 3.4, 1.5), bx, h+1.7, rnd(-d*0.2, d*0.2))), 'brick');
  }
  if (prng() < 0.4) {                                     // porch roof on posts
    put(roof, L(baked(BOX(w*0.62, 0.35, 2.6), 0, 3.5, front+1.2)), 'shingle');
    for (const s of [-1,1]) put(TRIM, L(baked(BOX(0.3, 3.5, 0.3), s*w*0.26, 1.75, front+2.2)));
  }
  addBox(cx, cz, aabbW(w, d, yaw), aabbD(w, d, yaw), 'house', undefined, { w, d, yaw });
  return { yaw, h, x: cx, z: cz };
}

// a downtown storefront with a big signboard
function makeShop(cx, cz, fx, fz, w, d, name, bodyCol, signCol) {   // bodyCol is reassigned for brick
  const yaw = Math.atan2(fx, fz), h = rnd(7.5, 11);
  const spot = placeClear(cx, cz, fx, fz, w, d, yaw);
  if (!spot) return 0;
  cx = spot.x; cz = spot.z;
  const L = (g) => baked(g, cx, 0, cz, 0, yaw, 0);
  // Every storefront is a walk-in candidate — including repeat namings, since
  // SHOP_NAMES cycles. Any copy whose interior can't be cleared just stays solid.
  const walkIn = true;
  const drop = [];
  // Same trick as the houses: the surface, and for brick the colour, come from the
  // coordinate hash rather than the seeded stream. `skin` has to travel with the
  // WALKIN entry so the shell that replaces this body is the same material.
  const skin = ['brick', 'stucco', 'stucco', 'brick'][vary(cx, cz, 4)];
  if (skin === 'brick') bodyCol = BRICK_COLS[vary(cz, cx, BRICK_COLS.length)];
  put(bodyCol, L(baked(BOX(w, h, d), 0, h/2, 0)), skin);
  if (walkIn) drop.push(lastPut(bodyCol, skin));
  put(0x6f6a58, L(baked(BOX(w+1.2, 0.7, d+1.2), 0, h+0.35, 0)));     // parapet, doubles as the roof
  const front = d/2 + 0.06;
  put(0x2f3550, L(baked(BOX(w*0.86, 3.4, 0.2), 0, 2.0, front)));      // glazing band
  if (walkIn) drop.push(lastPut(0x2f3550));
  put(GLASS,   L(baked(BOX(w*0.8, 2.9, 0.26), 0, 2.05, front+0.05)), 'glass');
  if (walkIn) drop.push(lastPut(GLASS, 'glass'));
  put(signCol, L(baked(BOX(w*0.94, 2.4, 0.5), 0, h-1.6, front+0.1))); // signboard
  // Storefront trim. Deterministic throughout — see the note in makeHouse. This is the
  // cheapest detail in the game: shops are merged into colour buckets, so all of it
  // costs vertices once at build and nothing per frame.
  put(0x6f6a58, L(baked(BOX(w+1.5, 0.5, d+1.5), 0, h - 0.25, 0)));    // cornice under the parapet
  put(TRIM,     L(baked(BOX(w*0.99, 0.34, 0.34), 0, h - 2.95, front + 0.2)));  // sign ledge
  // a sloped awning on brackets instead of a flat lip
  put(signCol,  L(baked(BOX(w*0.9, 0.28, 2.0), 0, 4.25, front + 0.95, -0.22)));
  put(TRIM,     L(baked(BOX(w*0.92, 0.34, 0.28), 0, 3.88, front + 1.85)));     // valance
  for (const s of [-1, 1])
    put(TRIM, L(baked(BOX(0.16, 1.5, 0.16), s*w*0.42, 3.6, front + 1.7, 0.5)));  // brackets
  // Mullions across the glazing band, so the shopfront isn't one blue slab, and a kick
  // plate along the bottom. Both are dropped for a walk-in and rebuilt around the
  // doorway in the deferred pass: they run the full width of the frontage, and the
  // centre mullion in particular stands dead in the middle of the opening.
  for (let k = -1; k <= 1; k++) {
    put(0x2f3550, L(baked(BOX(0.16, 3.0, 0.3), k*w*0.22, 2.05, front + 0.1)));
    if (walkIn) drop.push(lastPut(0x2f3550));
  }
  put(0x5a5346, L(baked(BOX(w*0.88, 0.4, 0.34), 0, 0.2, front + 0.08)));       // kick plate
  if (walkIn) drop.push(lastPut(0x5a5346));
  // rooftop clutter: plant boxes and a vent give the skyline something to bite on
  put(0x8b929a, L(baked(BOX(w*0.24, 1.1, d*0.3), -w*0.22, h + 1.2, -d*0.1)));
  put(0x6f7178, L(baked(new THREE.CylinderGeometry(0.42, 0.42, 1.5, 14), w*0.26, h + 1.4, d*0.12)));
  put(0x8b929a, L(baked(new THREE.CylinderGeometry(0.55, 0.55, 0.24, 14), w*0.26, h + 2.2, d*0.12)));
  const W = Math.abs(fx)>0.5 ? d : w, D = Math.abs(fx)>0.5 ? w : d;
  signs.push({ text: name, x: cx + fx*(front+0.45), z: cz + fz*(front+0.45), y: h-1.6, yaw, w: w*0.9 });
  shopSpots.push({ name, cx, cz, fx, fz, w, d, h, yaw });
  addBox(cx, cz, W, D, 'shop');            // keeps the road audit and the radar honest
  if (walkIn) WALKIN.push({ name, cx, cz, yaw, w, d, h, W, D, fx, fz, front, bodyCol, skin, drop,
                            foot: colliders[colliders.length-1],
                            dw: DOOR_W, dh: DOOR_H, glazed: true, avoid: [], reach: 9 });
  return h;
}
const signs = [], shopSpots = [];
// Buildings you can walk into. Filled once the blocks are built; each entry keeps the
// world position and outward normal of its doorway, which is all the interior needs.
const ENTERABLE = [];

// text painted onto a board, used for shopfronts and billboards
function signTexture(text, bg, fg, wpx, hpx) {
  const c = document.createElement('canvas'); c.width = wpx || 512; c.height = hpx || 128;
  const g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0,0,c.width,c.height);
  g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 8; g.strokeRect(4,4,c.width-8,c.height-8);
  let size = Math.floor(c.height*0.52);
  g.textAlign='center'; g.textBaseline='middle';
  do { g.font = `900 ${size}px "Trebuchet MS", Arial, sans-serif`; size -= 4; }
  while (g.measureText(text).width > c.width*0.86 && size > 12);
  g.lineWidth = Math.max(6, size*0.17); g.strokeStyle = '#20264a'; g.lineJoin = 'round';
  g.strokeText(text, c.width/2, c.height/2 + 2);
  g.fillStyle = fg; g.fillText(text, c.width/2, c.height/2 + 2);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
// A sign as a thin SOLID panel rather than a bare plane: the art sits on the front face
// only, with a plain dark board on the back and edges. A double-sided plane shows the
// mirror-image of the text from behind — this reads forwards from the front and is just a
// solid board from the back. Front is the +z face, so an existing sign's rotation.y still
// aims it the same way.
function signPanel(w, h, tex, back = 0x20242c, depth = 0.3) {
  const solid = new THREE.MeshBasicMaterial({ color: back });
  const front = new THREE.MeshBasicMaterial({ map: tex });
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, depth), [solid, solid, solid, solid, front, solid]);
}

// =================================================================
//  BLOCK CONTENTS
// =================================================================
const SHOP_NAMES = [
  ['SPEEDY MART', 0xf0b429, 0xd0392b],     ['BIG DONUT', 0xe8e3d3, 0x2f6fc4],
  ["THE RUSTY MUG", 0x7d5a3c, 0x2f8f4f],    ['COMIC CASTLE', 0x8f6fbf, 0xf0b429],
  ['BURGER BARON', 0xd0392b, 0xf0b429],   ['STRIKE CITY LANES', 0x4f7d8c, 0xe8e3d3],
  ['BARGAIN BARN', 0xcfe6c8, 0xd0392b],      ['ARMY SURPLUS', 0x9a8f6a, 0x2f3550],
  ["TONY'S PIZZA", 0xe8e3d3, 0x2f8f4f],   ['CAPTAIN’S CATCH', 0x3fa9d8, 0xe8e3d3],
  ['PIXEL PALACE', 0x2f3550, 0xe87ab0],['GRAND THEATER', 0xc9a24b, 0xd0392b],
  ['LEFTY’S', 0x59c9a5, 0x2f3550],   ['CITY MALL', 0xd8dde4, 0x7b4fa7],
  ['ACTION NEWS', 0x2f6fc4, 0xf0b429],       ['STARLIGHT STUDIOS', 0x8f6fbf, 0xe8e3d3],
  ['PUTT PARADISE', 0x8ad14f, 0xd0392b],['CURL UP & DYE', 0xe87ab0, 0xffffff],
  ['GOLDEN KOI SUSHI', 0xd0392b, 0xffffff],  ['TOWN MUSEUM', 0xe6e0cf, 0x8c3f5e],
  ['ORDER OF THE OWL', 0x4a4f58, 0xc9a24b],    ['CLUB INFERNO', 0xf0b429, 0x7b4fa7],
];
let shopIdx = 0;
const lawnPos = [], drivePos = [], drivewayUV = [];
const hedges = [], fences = [], coinsSpots = [], treeSpots = [], propSpots = [];

function fillHouseBlock(B) {
  const r = B.r;
  lawnPoly(B.poly);
  // Walk the block outline. Its edges run along street centrelines, so each edge is a
  // frontage: houses sit back *inside* the block and face out onto the street.
  //
  // They used to be set back on the *outside*, which put every house across the road in
  // the neighbouring block — mostly invisible, because the block opposite did the same
  // thing back. It stopped being invisible where a residential block bordered the shops:
  // you got houses interleaved with the storefronts, facing away from the high street.
  const P = B.poly, n = P.length;
  let cx = 0, cz = 0; for (const p of P) { cx += p.x; cz += p.z; }
  cx /= n; cz /= n;
  for (let k = 0; k < n; k++) {
    const a = P[k], b = P[(k+1)%n];
    const dx = b.x-a.x, dz = b.z-a.z, L = Math.hypot(dx,dz);
    if (L < 34) continue;
    const ux = dx/L, uz = dz/L;
    let nx = -uz, nz = ux;                                  // outward: the way they face
    if ((a.x + dx/2 - cx)*nx + (a.z + dz/2 - cz)*nz < 0) { nx = -nx; nz = -nz; }
    const setback = WALK_HW + 6;
    const count = Math.max(1, Math.floor((L - 26) / 23));
    for (let q = 0; q < count; q++) {
      const t = 16 + (L - 32) * (count === 1 ? 0.5 : q/(count-1));
      const hx = a.x + ux*t - nx*setback, hz = a.z + uz*t - nz*setback;
      if (overRiver(hx, hz, 12)) continue;
      const w = rnd(13, 16), d = rnd(10, 12);
      const built = makeHouse(hx, hz, nx, nz, w, d);
      if (!built) continue;
      const hx2 = built.x, hz2 = built.z;
      // front garden, driveway and mailbox now run toward the street, i.e. +n
      const dvx = hx2 + nx*(d/2 + 7), dvz = hz2 + nz*(d/2 + 7);
      quad(drivePos, hx2 + nx*(d/2), hz2 + nz*(d/2), dvx, dvz, 4.6, 0.03, drivewayUV, 6, 6, 0);
      propSpots.push({ x: hx2 + nx*(d/2+8) + ux*5, z: hz2 + nz*(d/2+8) + uz*5, kind:'mailbox' });
      for (const sd of [-1, 1])
        hedges.push({ x: hx2 + nx*(d/2+1.4) + ux*sd*4.6, z: hz2 + nz*(d/2+1.4) + uz*sd*4.6, r: rnd(1.0,1.6) });
      if (prng() < 0.5)
        treeSpots.push({ x: hx2 + nx*(d/2+1.5) + ux*rnd(-8,8), z: hz2 + nz*(d/2+1.5) + uz*rnd(-8,8), s: rnd(1.0,1.5) });
    }
  }
  fillBackyards(r);
  for (let k = 0; k < 3; k++) coinsSpots.push({ x: rnd(r.x0+4, r.x1-4), z: rnd(r.z0+4, r.z1-4) });
}

// grass laid to the block's real outline rather than a rectangle
function lawnPoly(P) {
  for (let k = 1; k < P.length-1; k++)
    lawnPos.push(P[0].x, 0.012, P[0].z, P[k+1].x, 0.012, P[k+1].z, P[k].x, 0.012, P[k].z);
}

// the strip either side of the water: grass, trees, benches, no buildings
function fillRiverPark(B) {
  const r = B.r;
  // no block lawn here — it would cover the channel. The ground strips already run
  // right up to the top of the bank.

  for (let k = 0; k < 26; k++) {
    const x = rnd(r.x0, r.x1), z = rnd(r.z0, r.z1);
    if (overRiver(x, z, 8)) continue;
    treeSpots.push({ x, z, s: rnd(1.2, 2.1) });
  }
  for (let k = 0; k < 5; k++) {
    const x = rnd(r.x0+8, r.x1-8), z = rnd(r.z0+6, r.z1-6);
    if (overRiver(x, z, 12)) continue;
    propSpots.push({ x, z, kind: 'bench' });
  }
  for (let k = 0; k < 5; k++) {
    const x = rnd(r.x0+4, r.x1-4), z = rnd(r.z0+4, r.z1-4);
    if (!overRiver(x, z, 6)) coinsSpots.push({ x, z });
  }
}

// The middle of a residential block is everyone's back garden. Without this the
// blocks read as a ring of houses around an empty green.
function fillBackyards(r) {
  const ix0 = r.x0 + 24, ix1 = r.x1 - 24, iz0 = r.z0 + 24, iz1 = r.z1 - 24;
  if (ix1 - ix0 < 16 || iz1 - iz0 < 16) return;
  const spot = () => [rnd(ix0, ix1), rnd(iz0, iz1)];
  const kinds = ['shed','pool','tramp','swing','bbq','hedgerow'];
  const n = 5 + (prng()*4|0);
  for (let k = 0; k < n; k++) {
    const [x, z] = spot(), yaw = prng()*6.28;
    if (footprintOnRoad(x, z, 9, 9, 0, 0)) continue;   // merged blocks can span a street
    if (footprintClash(x, z, 9, 9, 0, 0.5)) continue;  // and gardens back onto houses 
    switch (rpick(kinds)) {
      case 'shed': {
        const c = rpick([0x8c5a34, 0x7d8a92, 0x9a6b3f]);
        put(c, baked(BOX(5, 3.2, 4), x, 1.6, z, 0, yaw));
        put(0x5a4a42, baked(roofPrism(5.6, 1.4, 4.6), x, 3.2, z, 0, yaw));
        addBox(x, z, 5, 5, 'shed');
        break;
      }
      case 'pool': {
        put(0xd8dde4, baked(new THREE.CylinderGeometry(4.2, 4.2, 1.5, 20), x, 0.75, z));
        put(0x3fb8e0, baked(new THREE.CylinderGeometry(3.9, 3.9, 0.2, 20), x, 1.5, z));
        addBox(x, z, 8, 8, 'pool');
        break;
      }
      case 'tramp': {
        put(0x2f3550, baked(new THREE.CylinderGeometry(3.2, 3.2, 0.3, 20), x, 1.3, z));
        for (let q = 0; q < 6; q++) {
          const a = q/6*Math.PI*2;
          put(0x8b929a, baked(BOX(0.22, 1.3, 0.22), x + Math.cos(a)*2.9, 0.65, z + Math.sin(a)*2.9));
        }
        break;
      }
      case 'swing': {
        for (const s2 of [-1, 1]) {
          put(0xe8532f, baked(BOX(0.3, 4.2, 0.3), x + s2*2.4, 2.1, z - 1.2, 0, 0, s2*0.28));
          put(0xe8532f, baked(BOX(0.3, 4.2, 0.3), x + s2*2.4, 2.1, z + 1.2, 0, 0, s2*0.28));
        }
        put(0xe8532f, baked(BOX(5.4, 0.3, 0.3), x, 4.1, z));
        for (const ox of [-1.3, 1.3]) put(0x2f3550, baked(BOX(1.1, 0.16, 0.5), x+ox, 1.5, z));
        break;
      }
      case 'bbq': {
        put(0x2b2f38, baked(new THREE.CylinderGeometry(0.9, 0.7, 0.9, 20), x, 1.3, z));
        put(0x8b929a, baked(BOX(0.16, 1.0, 0.16), x, 0.5, z));
        break;
      }
      case 'hedgerow': {
        const len = 4 + (prng()*5|0);
        for (let q = 0; q < len; q++)
          hedges.push({ x: x + Math.sin(yaw)*q*2.4, z: z + Math.cos(yaw)*q*2.4, r: rnd(1.1, 1.5) });
        break;
      }
    }
  }
  for (let k = 0; k < 4; k++) { const [x, z] = spot(); if (!onRoad(x, z, 2.5)) treeSpots.push({ x, z, s: rnd(1.0, 1.7) }); }
}

function fillShopBlock(B) {
  const r = B.r;
  rect(lotPos, r.x0, r.z0, r.x1, r.z1, 0.014, lotUV, 9);
  const edges = [
    { fx:0, fz:-1, along:'x', fixed:r.z0 + 11 },
    { fx:0, fz: 1, along:'x', fixed:r.z1 - 11 },
    { fx:-1, fz:0, along:'z', fixed:r.x0 + 11 },
    { fx: 1, fz:0, along:'z', fixed:r.x1 - 11 },
  ];
  for (const e of edges) {
    const lo = e.along==='x' ? r.x0+16 : r.z0+16, hi = e.along==='x' ? r.x1-16 : r.z1-16;
    const span = hi - lo, count = Math.max(1, Math.round(span/40));
    for (let k = 0; k < count; k++) {
      const t = lo + (span/count)*(k+0.5);
      const sx = e.along==='x' ? t : e.fixed, sz = e.along==='x' ? e.fixed : t;
      const [name, body, sign] = SHOP_NAMES[shopIdx++ % SHOP_NAMES.length];
      makeShop(sx, sz, e.fx, e.fz, rnd(24, 30), rnd(14, 17), name, body, sign);
      propSpots.push({ x: sx - e.fz*11, z: sz + e.fx*11, kind:'bin' });
    }
  }
  for (let k = 0; k < 6; k++) coinsSpots.push({ x: rnd(r.x0+4, r.x1-4), z: rnd(r.z0+4, r.z1-4) });
}

function fillPark(B, statue) {
  const r = B.r;
  const cx = (r.x0+r.x1)/2, cz = (r.z0+r.z1)/2;
  rect(lawnPos, r.x0, r.z0, r.x1, r.z1, 0.012, null);
  // a paved path crossing the green
  rect(lotPos, cx-4, r.z0, cx+4, r.z1, 0.02, lotUV, 9);
  rect(lotPos, r.x0, cz-4, r.x1, cz+4, 0.02, lotUV, 9);
  for (let k = 0; k < 26; k++) {
    const x = rnd(r.x0+3, r.x1-3), z = rnd(r.z0+3, r.z1-3);
    if (Math.abs(x-cx) < 6 || Math.abs(z-cz) < 6) continue;
    treeSpots.push({ x, z, s: rnd(1.2, 2.0) });
  }
  for (const [ox, oz] of [[-14,-14],[14,-14],[-14,14],[14,14]])
    propSpots.push({ x: cx+ox, z: cz+oz, kind:'bench' });
  if (statue && !footprintOnRoad(cx, cz, 9, 9, 0, 0)) {
    put(0x8f9aa6, baked(new THREE.CylinderGeometry(3.2, 3.8, 1.6, 20), cx, 0.8, cz));
    put(0x8f9aa6, baked(BOX(2.6, 3.4, 2.6), cx, 3.3, cz));
    put(0xc9b458, baked(BOX(1.5, 3.0, 0.9), cx, 6.5, cz));            // torso
    put(0xc9b458, baked(new THREE.SphereGeometry(0.85, 16, 12), cx, 8.6, cz));
    put(0xc9b458, baked(BOX(0.45, 2.2, 0.45), cx-1.1, 6.7, cz, 0,0, 0.5));
    addBox(cx, cz, 7, 7, 'statue');
  }
  for (let k = 0; k < 5; k++) coinsSpots.push({ x: rnd(r.x0+4, r.x1-4), z: rnd(r.z0+4, r.z1-4) });
}

function fillPlant(B) {
  const r = B.r;
  const cx = (r.x0+r.x1)/2, cz = (r.z0+r.z1)/2;
  rect(lotPos, r.x0, r.z0, r.x1, r.z1, 0.014, lotUV, 9);
  // scale the plant to whatever this block can actually hold, then verify it clears
  const pw = Math.min(34, (r.x1-r.x0) - 10), pd = Math.min(22, (r.z1-r.z0) - 26);
  if (!footprintOnRoad(cx, cz+14, pw, pd, 0, 0)) {
    put(0xbfc4c9, baked(BOX(pw, 13, pd), cx, 6.5, cz+14));
    put(0x6f6a58, baked(BOX(pw+2, 1.0, pd+2), cx, 13.4, cz+14));
    addBox(cx, cz+14, pw, pd, 'plant');
  }
  const tSep = Math.min(16, (r.x1-r.x0)/2 - 14);
  for (const ox of [-tSep, tSep]) {                                   // cooling towers
    if (footprintOnRoad(cx+ox, cz-16, 26, 26, 0, 0)) continue;
    put(0xe8e6df, baked(new THREE.CylinderGeometry(11, 14, 34, 16, 1, true), cx+ox, 17, cz-16));
    put(0xd6d3ca, baked(new THREE.CylinderGeometry(11.2, 11.2, 1.2, 16), cx+ox, 34, cz-16));
    addBox(cx+ox, cz-16, 26, 26, 'plant');
    smokeStacks.push({ x: cx+ox, y: 34, z: cz-16 });
  }
  for (let k = 0; k < 4; k++) coinsSpots.push({ x: rnd(r.x0+6, r.x1-6), z: rnd(r.z0+6, r.z1-6) });
}
const smokeStacks = [];

function fillSchool(B) {
  const r = B.r;
  const F = fitScale(r, 56, 30);
  const cx = (r.x0+r.x1)/2, cz = (r.z0+r.z1)/2;
  rect(lawnPos, r.x0, r.z0, r.x1, r.z1, 0.012, null);
  rect(lotPos, r.x0+6, r.z1-26, r.x1-6, r.z1-6, 0.02, lotUV, 9);
  put(0xe3c07a, baked(BOX(52*F, 11, 20*F), cx, 5.5, cz-6));
  put(0xa8493f, baked(roofPrism(54*F, 3.4, 22*F), cx, 11, cz-6));
  for (let k = -3; k <= 3; k++) {
    put(TRIM,  baked(BOX(3.0, 3.0, 0.2), cx + k*7, 6, cz+4.1));
    put(GLASS, baked(BOX(2.5, 2.5, 0.26), cx + k*7, 6, cz+4.2));
  }
  put(0x8c4a2f, baked(BOX(3.4, 4.2, 0.3), cx, 2.1, cz+4.15));
  addBox(cx, cz-6, 52*F, 20*F, 'school', 'school');
  signs.push({ text: 'MAPLEWOOD ELEMENTARY', x: cx, z: cz+4.4, y: 9.4, yaw: 0, w: 26 });
  for (let k = 0; k < 5; k++) coinsSpots.push({ x: rnd(r.x0+4, r.x1-4), z: rnd(r.z0+4, r.z1-4) });
}

// =================================================================
//  LANDMARKS
// =================================================================
const fireSpots = [];

// Landmarks are authored at a fixed size but blocks vary, so shrink to fit rather
// than letting a 56 m manor spill onto the street of a 60 m block.
function fitScale(r, needW, needD) {
  return Math.min(1, (r.x1-r.x0 - 6)/needW, (r.z1-r.z0 - 6)/needD);
}

// a labelled board on two posts, for anything that needs naming
function nameBoard(x, z, y, yaw, w, text, bg, fg) {
  signs.push({ text, x, z, y, yaw, w, bg, fg });
}

// 742 Evergreen Terrace, and the neighbourinos next door
function fillEvergreen(B) {
  const r = B.r;
  rect(lawnPos, r.x0, r.z0, r.x1, r.z1, 0.012, null);
  const zFront = r.z0 + 10;                       // all face the southern street
  const face = { fx: 0, fz: -1 };

  // --- the Simpson house: salmon walls, orange roof, garage on the left ---
  const hSpot = placeClear((r.x0 + r.x1)/2 - 12, zFront, face.fx, face.fz, 17, 12, 0);
  if (!hSpot) { fillHouseBlock(B); return; }        // block can't take the set piece
  const hx = hSpot.x, hz = hSpot.z;
  const SALMON = 0xffb59b, ORANGE = 0xe08133;
  // built solid so the seeded stream is consumed as before; withdrawn later if 742
  // turns out to be hollowable
  const everDrop = [];
  put(SALMON, baked(BOX(17, 9.5, 12), hx, 4.75, hz));
  everDrop.push(lastPut(SALMON));
  put(ORANGE, baked(roofPrism(18.6, 4.2, 13.6), hx, 9.5, hz));
  const garageOK = !footprintOnRoad(hx - 12, hz + 1.6, 8, 7, 0, 0.8);
  if (garageOK) {
    put(SALMON, baked(BOX(8, 5.4, 7), hx - 12, 2.7, hz + 1.6));         // garage wing
    put(ORANGE, baked(roofPrism(9.2, 2.4, 8.2), hx - 12, 5.4, hz + 1.6));
    put(0xe8e4da, baked(BOX(6.4, 4.2, 0.3), hx - 12, 2.1, hz - 2.0));   // garage door
  }
  // The old solid front door is dropped — the shell above already left an opening there.
  // It is still built so the seeded stream is consumed exactly as it always was.
  put(0x2f3550, baked(BOX(2.0, 3.4, 0.3), hx + 1, 1.7, hz - 6.1));
  everDrop.push(lastPut(0x2f3550));
  for (const [wx, wy] of [[-5,2.4],[5,2.4],[-5,7.0],[0,7.0],[5,7.0]]) {
    put(TRIM,  baked(BOX(2.8, 2.4, 0.2), hx + wx, wy, hz - 6.1));
    put(GLASS, baked(BOX(2.2, 1.9, 0.26), hx + wx, wy, hz - 6.2));
  }
  put(0x9a5c4a, baked(BOX(2.0, 4.4, 2.0), hx + 6, 11.4, hz + 2));       // chimney
  addBox(hx, hz, 17, 12, 'house', 'evergreen');   // keeps the road audit and the radar honest
  WALKIN.push({ name: '742 MAPLE DRIVE', cx: hx, cz: hz, yaw: Math.PI, w: 17, d: 12, h: 9.5,
                W: 17, D: 12, fx: 0, fz: -1, front: 6.0, bodyCol: SALMON,
                drop: everDrop, foot: colliders[colliders.length-1],
                dw: 2.0, dh: 3.4, glazed: false, avoid: [-5, 5], reach: 3.5 });
  if (garageOK) addBox(hx - 12, hz + 1.6, 8, 7, 'house', 'evergreen');
  rect(drivePos, hx-16, hz-6, hx-8, r.z0-WALK_HW, 0.03, drivewayUV, 6);
  nameBoard(hx, hz - 6.6, 5.6, Math.PI, 7, '742', '#f6a58c', '#2f3550');
  propSpots.push({ x: hx + 12, z: hz - 9, kind: 'mailbox' });

  // --- the Flanders house next door, green and immaculate ---
  // No fallback position: it used to drop the house at the requested spot when placeClear
  // failed, which is exactly how a building ends up straddling a road.
  const fSpot = placeClear((r.x0 + r.x1)/2 + 22, hz, face.fx, face.fz, 16, 12, 0);
  if (fSpot) {
    const fx2 = fSpot.x, fz2 = fSpot.z;
    put(0xbfe0a8, baked(BOX(16, 9.0, 12), fx2, 4.5, fz2));
    put(0x4f7d8c, baked(roofPrism(17.6, 4.0, 13.6), fx2, 9.0, fz2));
    put(0x6a4a2f, baked(BOX(2.0, 3.4, 0.3), fx2, 1.7, fz2 - 6.1));
    for (const [wx, wy] of [[-5,2.4],[5,2.4],[-4,6.6],[4,6.6]]) {
      put(TRIM,  baked(BOX(2.6, 2.3, 0.2), fx2 + wx, wy, fz2 - 6.1));
      put(GLASS, baked(BOX(2.0, 1.8, 0.26), fx2 + wx, wy, fz2 - 6.2));
    }
    addBox(fx2, fz2, 16, 12);
    for (let k = -3; k <= 3; k++) hedges.push({ x: fx2 + k*2.6, z: fz2 - 8.4, r: 1.3 });
    rect(drivePos, fx2+5, fz2-6, fx2+11, r.z0-WALK_HW, 0.03, drivewayUV, 6);
    treeSpots.push({ x: fx2 + 12, z: fz2 - 10, s: 1.4 });
  }

  // ordinary neighbours filling out the rest of the street
  for (const e of [{fx:0,fz:1,along:'x',fixed:r.z1-9.5}, {fx:-1,fz:0,along:'z',fixed:r.x0+9.5}]) {
    const lo = e.along==='x' ? r.x0+13 : r.z0+13, hi = e.along==='x' ? r.x1-13 : r.z1-13;
    const span = hi-lo, count = Math.max(2, Math.round(span/26));
    for (let k = 0; k < count; k++) {
      const t = lo + (span/count)*(k+0.5);
      makeHouse(e.along==='x'?t:e.fixed, e.along==='x'?e.fixed:t, e.fx, e.fz, rnd(13,16), rnd(10,12));
    }
  }
  treeSpots.push({ x: hx - 20, z: hz - 10, s: 1.5 });
  for (let k = 0; k < 5; k++) coinsSpots.push({ x: rnd(r.x0+4, r.x1-4), z: rnd(r.z0+4, r.z1-4) });
}

// Mr Burns' estate: long dark manor behind iron gates
function fillBurns(B) {
  const r = B.r;
  const F = fitScale(r, 56, 30);
  const cx = (r.x0+r.x1)/2, cz = (r.z0+r.z1)/2;
  rect(lawnPos, r.x0, r.z0, r.x1, r.z1, 0.012, null);
  rect(lotPos, cx-5, r.z0, cx+5, cz-14, 0.02, lotUV, 9);              // gravel drive
  const DARK = 0x6d6472, ROOFC = 0x3c3550;
  put(DARK, baked(BOX(56*F, 16, 22*F), cx, 8, cz+4));
  put(ROOFC, baked(roofPrism(58*F, 5.5, 24*F), cx, 16, cz+4));
  for (const ox of [-22*F, 22*F]) {                                       // corner towers
    put(DARK, baked(new THREE.CylinderGeometry(5, 5, 26, 20), cx+ox, 13, cz-6));
    put(ROOFC, baked(new THREE.ConeGeometry(6.2, 8, 16), cx+ox, 30, cz-6));
    addBox(cx+ox, cz-6, 10, 10, 'burns', 'burns');
  }
  for (let k = -4; k <= 4; k++) {
    put(TRIM,  baked(BOX(2.6, 4.0, 0.2), cx + k*6, 5, cz-7.1));
    put(GLASS, baked(BOX(2.0, 3.4, 0.26), cx + k*6, 5, cz-7.2));
  }
  put(0x2f2a3a, baked(BOX(4.5, 6.5, 0.4), cx, 3.25, cz-7.2));
  addBox(cx, cz+4, 56*F, 22*F, 'burns', 'burns');
  // wrought iron fence and gate pillars
  for (const s of [-1, 1]) {
    put(0x2f3038, baked(BOX(Math.abs(r.x1-r.x0)/2 - 8, 3.4, 0.5), cx + s*(Math.abs(r.x1-r.x0)/4 + 4), 1.7, r.z0+2));
    put(0x8f9aa6, baked(BOX(2.4, 6, 2.4), cx + s*6, 3, r.z0+5));
    addBox(cx + s*6, r.z0+5, 2.4, 2.4, 'burns', 'burns');
  }
  nameBoard(cx, r.z0+0.6, 7.4, Math.PI, 15, 'RAVENWOOD MANOR', '#3c3550', '#e0d48f');
  for (let k = 0; k < 14; k++) hedges.push({ x: rnd(r.x0+4, r.x1-4), z: rnd(r.z0+6, cz-16), r: rnd(1.4,2.2) });
  for (let k = 0; k < 5; k++) coinsSpots.push({ x: rnd(r.x0+4, r.x1-4), z: rnd(r.z0+4, r.z1-4) });
}

// Maplewood Penitentiary
function fillPrison(B) {
  const r = B.r;
  const F = fitScale(r, 40, 26);
  const cx = (r.x0+r.x1)/2, cz = (r.z0+r.z1)/2;
  rect(lotPos, r.x0, r.z0, r.x1, r.z1, 0.014, lotUV, 9);
  const W = 0x9aa0a8;
  [[cx, r.z0+2, r.x1-r.x0, 2], [cx, r.z1-2, r.x1-r.x0, 2],
   [r.x0+2, cz, 2, r.z1-r.z0], [r.x1-2, cz, 2, r.z1-r.z0]].forEach(([ax, az, w, d], wi) => {
    put(W, baked(BOX(w, 9, d), ax, 4.5, az));
    // remember the north wall — the deferred pass swaps it for a gated one
    if (wi === 0) PRISON.drop.push(lastPut(W));
    addBox(ax, az, w, d, 'prison', 'prison');
    if (wi === 0) { PRISON.col = colliders[colliders.length-1]; PRISON.gate = { x: ax, z: az, w, d }; }
  });
  // the Yard Soaker round needs to know where the yard and the cell block are
  PRISON.yard = { x0: r.x0+3.4, x1: r.x1-3.4, z0: r.z0+3.4, z1: r.z1-3.4, cx, cz };
  PRISON.block = { w: 34*F, d: 18*F };
  for (const [ox, oz] of [[-1,-1],[1,-1],[-1,1],[1,1]]) {             // guard towers
    const tx = cx + ox*(r.x1-r.x0)/2*0.92, tz = cz + oz*(r.z1-r.z0)/2*0.92;
    put(W, baked(new THREE.CylinderGeometry(3, 3.4, 15, 16), tx, 7.5, tz));
    put(0x3c4048, baked(new THREE.ConeGeometry(4.4, 4, 16), tx, 17, tz));
    addBox(tx, tz, 6, 6, 'prison', 'prison');
  }
  put(0x8b929a, baked(BOX(34*F, 12, 18*F), cx, 6, cz));
  put(0x6f6a58, baked(BOX(36*F, 1, 20*F), cx, 12.4, cz));
  addBox(cx, cz, 34*F, 18*F, 'prison', 'prison');
  nameBoard(cx, cz-9.4, 9, Math.PI, 20, 'MAPLEWOOD PENITENTIARY', '#7c828a', '#20264a');
  for (let k = 0; k < 4; k++) coinsSpots.push({ x: rnd(r.x0+8, r.x1-8), z: rnd(r.z0+8, r.z1-8) });
}

// First Church of Maplewood
function fillChurch(B) {
  const r = B.r;
  const F = fitScale(r, 22, 40);
  const cx = (r.x0+r.x1)/2, cz = (r.z0+r.z1)/2;
  rect(lawnPos, r.x0, r.z0, r.x1, r.z1, 0.012, null);
  rect(lotPos, cx-16, r.z0, cx+16, cz-14, 0.02, lotUV, 9);
  const WHITE = 0xf4f1e8;
  put(WHITE, baked(BOX(20*F, 13, 34*F), cx, 6.5, cz+3));
  put(0x8c5a44, baked(roofPrism(21.5*F, 5, 35.5*F), cx, 13, cz+3));
  put(WHITE, baked(BOX(9, 22, 9), cx, 11, cz-16));                    // steeple base
  put(0x8c5a44, baked(new THREE.ConeGeometry(6.6, 13, 4), cx, 28.5, cz-16, 0, Math.PI/4));
  put(0xc9b458, baked(BOX(0.7, 4.4, 0.7), cx, 37, cz-16));            // cross
  put(0xc9b458, baked(BOX(2.6, 0.7, 0.7), cx, 37.6, cz-16));
  put(0x6a4a2f, baked(BOX(3.6, 6, 0.4), cx, 3, cz-20.72));   // proud of the steeple face at cz-20.5
  for (const s of [-1, 1]) for (let k = 0; k < 4; k++) {
    put(TRIM,  baked(BOX(0.24, 5, 2.6), cx + s*10.1, 7, cz - 6 + k*8));
    put(0x7fb8d8, baked(BOX(0.3, 4.4, 2.0), cx + s*10.25, 7, cz - 6 + k*8));
  }
  addBox(cx, cz+3, 20*F, 34*F, 'church', 'church'); addBox(cx, cz-16, 9, 9, 'church', 'church');
  nameBoard(cx, cz-20.6, 8.6, Math.PI, 14, 'FIRST CHURCH', '#f4f1e8', '#8c3f5e');
  for (let k = 0; k < 5; k++) coinsSpots.push({ x: rnd(r.x0+4, r.x1-4), z: rnd(r.z0+4, r.z1-4) });
}

// Town Hall plus the police station sharing a civic block
function fillCivic(B) {
  const r = B.r;
  const F = fitScale(r, 46, 60);
  const cx = (r.x0+r.x1)/2, cz = (r.z0+r.z1)/2;
  rect(lotPos, r.x0, r.z0, r.x1, r.z1, 0.014, lotUV, 9);
  // town hall: portico, columns, dome
  const hz = cz - 16, STONE = 0xe6e0cf;
  put(STONE, baked(BOX(44*F, 15, 22*F), cx, 7.5, hz));
  put(0x6f6a58, baked(BOX(46*F, 1.2, 24*F), cx, 15.6, hz));
  put(STONE, baked(BOX(26, 1.4, 5), cx, 15.4, hz-13));
  for (let k = -3; k <= 3; k++) {
    put(STONE, baked(new THREE.CylinderGeometry(1.1, 1.1, 14, 20), cx + k*4, 7, hz-13));
  }
  put(0xd8d3c2, baked(new THREE.SphereGeometry(9, 16, 12, 0, Math.PI*2, 0, Math.PI/2), cx, 16.2, hz));
  put(0xc9b458, baked(new THREE.ConeGeometry(1.4, 4, 16), cx, 26.5, hz));
  put(0x8c4a2f, baked(BOX(4.5, 7, 0.4), cx, 3.5, hz-11.2));
  addBox(cx, hz, 44*F, 22*F, 'civic', 'civic');
  nameBoard(cx, hz-15.8, 12.5, Math.PI, 16, 'TOWN HALL', '#e6e0cf', '#2f3550');
  // police station
  const pz = cz + 18;
  put(0x7fa8c9, baked(BOX(30*F, 10, 16*F), cx, 5, pz));
  put(0x3c4048, baked(BOX(31*F, 1, 17*F), cx, 10.4, pz));
  put(0x2f3550, baked(BOX(3.4, 5, 0.3), cx, 2.5, pz-8.2));
  for (const wx of [-9, 9]) {
    put(TRIM,  baked(BOX(4.4, 3, 0.2), cx+wx, 5.6, pz-8.1));
    put(GLASS, baked(BOX(3.8, 2.4, 0.26), cx+wx, 5.6, pz-8.2));
  }
  addBox(cx, pz, 30*F, 16*F, 'civic', 'civic');
  nameBoard(cx, pz-8.5, 8.4, Math.PI, 13, 'POLICE', '#2f5fb0', '#ffffff');
  for (let k = 0; k < 5; k++) coinsSpots.push({ x: rnd(r.x0+4, r.x1-4), z: rnd(r.z0+4, r.z1-4) });
}

// Duff Stadium — an open bowl of banked seating
function fillStadium(B) {
  const r = B.r;
  const cx = (r.x0+r.x1)/2, cz = (r.z0+r.z1)/2;
  rect(lawnPos, r.x0, r.z0, r.x1, r.z1, 0.012, null);
  const seg = 24;
  // The ring is closed, so a segment can't just be skipped when it fouls a neighbour —
  // that would leave a hole in the stands. Shrink the whole bowl instead, uniformly,
  // until every segment is clear.
  const segAt = (k, RX, RZ) => {
    const a0 = (k/seg)*Math.PI*2, a1 = ((k+1)/seg)*Math.PI*2, am = (a0+a1)/2;
    return { px: cx + Math.cos(am)*RX*0.92, pz: cz + Math.sin(am)*RZ*0.92, yaw: -am + Math.PI/2,
             len: Math.hypot(Math.cos(a1)*RX - Math.cos(a0)*RX, Math.sin(a1)*RZ - Math.sin(a0)*RZ) + 2 };
  };
  let RX = (r.x1-r.x0)/2 - 11, RZ = (r.z1-r.z0)/2 - 11;
  for (const sc of [1, 0.94, 0.88, 0.82, 0.76, 0.7]) {
    const tx = ((r.x1-r.x0)/2 - 11)*sc, tz = ((r.z1-r.z0)/2 - 11)*sc;
    let ok = true;
    for (let k = 0; k < seg && ok; k++) {
      const g = segAt(k, tx, tz);
      if (footprintClash(g.px, g.pz, g.len, 12, g.yaw, 0.3)) ok = false;
    }
    RX = tx; RZ = tz;
    if (ok) break;
  }
  for (let k = 0; k < seg; k++) {
    const g = segAt(k, RX, RZ);
    put(0xc9ccd2, baked(BOX(g.len, 13, 12), g.px, 6.5, g.pz, 0, g.yaw));
    const dropSeat = lastPut(0xc9ccd2);
    put(0xe8532f, baked(BOX(g.len, 2.0, 13), g.px, 13.6, g.pz, 0, g.yaw));
    const dropRim = lastPut(0xe8532f);
    // the real turned footprint, not a blanket 11x11 that reached into the next block
    addBox(g.px, g.pz, aabbW(g.len, 12, g.yaw), aabbD(g.len, 12, g.yaw),
           'stadium', 'stadium', { w: g.len, d: 12, yaw: g.yaw });
    // the two south-facing segments become the gate: built as ever (their RNG cost is
    // part of the seeded stream) and withdrawn in the deferred pass, like the walk-ins
    if (k === 17 || k === 18) STADIUM.gate.push({ drop: [dropSeat, dropRim],
      col: colliders[colliders.length-1], box: mapBoxes[mapBoxes.length-1], g });
  }
  STADIUM.cx = cx; STADIUM.cz = cz; STADIUM.rx = RX; STADIUM.rz = RZ;
  rect(lotPos, cx-RX*0.6, cz-RZ*0.6, cx+RX*0.6, cz+RZ*0.6, 0.03, lotUV, 9);
  for (const s of [-1, 1]) {                                          // floodlight pylons
    put(0x6b6f76, baked(BOX(1.2, 26, 1.2), cx + s*RX*0.75, 13, cz - RZ*0.75));
    put(0xfff0b8, baked(BOX(5, 2.4, 1.2), cx + s*RX*0.75, 26.5, cz - RZ*0.75));
  }
  nameBoard(cx, cz - RZ - 3, 10, Math.PI, 20, 'VICTORY STADIUM', '#e8b53f', '#c0392b');
  for (let k = 0; k < 6; k++) coinsSpots.push({ x: rnd(cx-RX*0.5, cx+RX*0.5), z: rnd(cz-RZ*0.5, cz+RZ*0.5) });
}

// Maplewood Retirement Castle
function fillRetire(B) {
  const r = B.r;
  const F = fitScale(r, 50, 30);
  const cx = (r.x0+r.x1)/2, cz = (r.z0+r.z1)/2;
  rect(lawnPos, r.x0, r.z0, r.x1, r.z1, 0.012, null);
  rect(lotPos, cx-18, r.z0, cx+18, cz-13, 0.02, lotUV, 9);
  const BEIGE = 0xe0cfa8;
  put(BEIGE, baked(BOX(46*F, 13, 20*F), cx, 6.5, cz+2));
  CASTLE.drop.push(lastPut(BEIGE));               // hollowed out in the deferred pass
  put(0x8c3f5e, baked(roofPrism(47.5*F, 4.2, 21.5*F), cx, 13, cz+2));
  for (const s of [-1, 1]) {                                          // crenellated turrets
    put(BEIGE, baked(new THREE.CylinderGeometry(4.2, 4.2, 17, 20), cx + s*20*F, 8.5, cz-9));
    for (let k = 0; k < 8; k++) {
      const a = k/8*Math.PI*2;
      put(BEIGE, baked(BOX(1.4, 1.8, 1.4), cx + s*20 + Math.cos(a)*3.6, 17.6, cz-9 + Math.sin(a)*3.6));
    }
    addBox(cx + s*20*F, cz-9, 8, 8, 'retire', 'retire');   // the castle's own turrets
  }
  for (let k = -4; k <= 4; k++) {
    put(TRIM,  baked(BOX(2.6, 2.6, 0.2), cx + k*5, 6, cz-8.1));
    if (k === 0) CASTLE.drop.push(lastPut(TRIM)); // the gate replaces the centre window
    put(GLASS, baked(BOX(2.0, 2.0, 0.26), cx + k*5, 6, cz-8.2));
    if (k === 0) CASTLE.drop.push(lastPut(GLASS));
  }
  put(0x6a4a2f, baked(BOX(3.6, 5, 0.35), cx, 2.5, cz-8.2));
  CASTLE.drop.push(lastPut(0x6a4a2f));            // and the old front door
  addBox(cx, cz+2, 46*F, 20*F, 'retire', 'retire');
  CASTLE.cx = cx; CASTLE.cz = cz + 2; CASTLE.w = 46*F; CASTLE.d = 20*F;
  CASTLE.col = colliders[colliders.length-1];
  nameBoard(cx, cz-8.6, 10.4, Math.PI, 17, 'RETIREMENT CASTLE', '#e0cfa8', '#8c3f5e');
  for (const [ox, oz] of [[-14,-16],[14,-16]]) propSpots.push({ x: cx+ox, z: cz+oz, kind:'bench' });
  for (let k = 0; k < 4; k++) coinsSpots.push({ x: rnd(r.x0+4, r.x1-4), z: rnd(r.z0+4, r.z1-4) });
}

// the tyre yard that has been burning since anyone can remember
function fillTireFire(B) {
  const r = B.r;
  const cx = (r.x0+r.x1)/2, cz = (r.z0+r.z1)/2;
  rect(lotPos, r.x0, r.z0, r.x1, r.z1, 0.014, lotUV, 9);
  const heap = [];
  for (let k = 0; k < 90; k++) {                                      // heaped tyres
    const a = prng()*Math.PI*2, rad = prng()*22;
    const h = Math.max(0, 9 - rad*0.34) * prng();
    const tx = cx + Math.cos(a)*rad, tz = cz + Math.sin(a)*rad, cy = 0.6 + h;
    put(0x2b2f38, baked(new THREE.TorusGeometry(1.5, 0.62, 6, 10), tx, cy, tz, Math.PI/2, 0, prng()*3));
    heap.push({ x: tx, z: tz, top: cy + 0.62 });                     // top of the tube — where you stand
  }
  addBox(cx, cz, 30, 30, 'fire');
  TIREFIRE = { cx, cz, x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z1,
               col: colliders[colliders.length-1], heap };
  for (let k = 0; k < 5; k++) {
    const a = prng()*Math.PI*2, rad = prng()*12;
    fireSpots.push({ x: cx + Math.cos(a)*rad, y: 6, z: cz + Math.sin(a)*rad });
  }
  nameBoard(cx, r.z0 + 6, 6, Math.PI, 15, 'TIRE FIRE', '#3c3550', '#ff7a2b');
  for (let k = 0; k < 4; k++) coinsSpots.push({ x: rnd(r.x0+6, r.x1-6), z: rnd(r.z0+6, r.z1-6) });
}

// Duff Brewery — brick hall, a rank of fermentation tanks, and the big sign
function fillDuff(B) {
  const r = B.r;
  const F = fitScale(r, 50, 50);
  const cx = (r.x0+r.x1)/2, cz = (r.z0+r.z1)/2;
  rect(lotPos, r.x0, r.z0, r.x1, r.z1, 0.014, lotUV, 9);
  // keep the hall and the tank row inside the block's buildable rect
  const hallD = 24*F, hallZ = Math.min(cz + 8, r.z1 - hallD/2 - 1);
  if (!footprintOnRoad(cx, hallZ, 48*F, hallD, 0, 0.5)) {
    put(0xa8543f, baked(BOX(48*F, 17, hallD), cx, 8.5, hallZ));
    put(0x6f6a58, baked(BOX(50*F, 1.2, hallD+2), cx, 17.6, hallZ));
    addBox(cx, hallZ, 48*F, hallD, 'duff', 'duff');
  }
  const tankZ = Math.max(cz - 16, r.z0 + 6);
  for (let k = -2; k <= 2; k++) {                       // fermentation tanks out front
    const tx = cx + k*11*F;
    if (footprintOnRoad(tx, tankZ, 9, 9, 0, 0.5)) continue;
    put(0xd8dde4, baked(new THREE.CylinderGeometry(4.6, 4.6, 18, 20), tx, 9, tankZ));
    put(0xb9bfc7, baked(new THREE.SphereGeometry(4.6, 16, 12, 0, Math.PI*2, 0, Math.PI/2), tx, 18, tankZ));
    addBox(tx, tankZ, 9, 9, 'duff', 'duff');
  }
  put(0x8b929a, baked(new THREE.CylinderGeometry(2.2, 2.6, 26, 20), cx + 20, 13, cz + 20));
  smokeStacks.push({ x: cx + 20, y: 26, z: cz + 20 });
  nameBoard(cx, cz-4.2, 21, Math.PI, 24, 'GOLDEN BREWERY', '#e8b53f', '#c0392b');
  for (let k = 0; k < 5; k++) coinsSpots.push({ x: rnd(r.x0+6, r.x1-6), z: rnd(r.z0+6, r.z1-6) });
}

for (const B of BLOCKS) {
  if (B.r.x1 - B.r.x0 < 26 || B.r.z1 - B.r.z0 < 26) continue;   // too slim to build on
  switch (B.zone) {
    case 'duff':      fillDuff(B); break;
    case 'house':     fillHouseBlock(B); break;
    case 'shops':     fillShopBlock(B); break;
    case 'plaza':     fillPark(B, true); break;
    case 'park':      fillPark(B, false); break;
    case 'riverpark': fillRiverPark(B); break;
    case 'plant':     fillPlant(B); break;
    case 'school':    fillSchool(B); break;
    case 'evergreen': fillEvergreen(B); break;
    case 'burns':     fillBurns(B); break;
    case 'prison':    fillPrison(B); break;
    case 'church':    fillChurch(B); break;
    case 'civic':     fillCivic(B); break;
    case 'stadium':   fillStadium(B); break;
    case 'retire':    fillRetire(B); break;
    case 'tirefire':  fillTireFire(B); break;
  }
}

console.log('structures overlapping roads:', JSON.stringify(roadClash));

// =================================================================
//  ROOM FURNISHINGS
//  Every walk-in room gets a fit-out matched to its name, plus staff drawn through
//  the instanced crowd. Visuals go into FURN — separate buckets from the buildings,
//  flushed inside rngNeutral at the very end of the build, because the building
//  bucket flush happens *before* the trees are planted: a new colour there (one
//  extra merged mesh, one extra cached material) would shift the seeded stream and
//  reshuffle the town. Colliders are pushed to both `colliders` and the room's
//  `walls`, which is what keeps the interiors audit treating them as the room's
//  own furniture rather than an intruder.
// =================================================================
const FURN = new Map();
function fput(color, geo) {
  if (geo.index) geo = geo.toNonIndexed();
  let b = FURN.get(color); if (!b) FURN.set(color, b = []);
  b.push(geo);
}
// Static townsfolk inside the rooms: fixed spot, fixed yaw, an idle phase. They are
// rendered by renderCrowd through the same InstancedMeshes as the street crowd but
// never join `peds`, so walking, kicking, anger and separation all ignore them.
// Only the spec is stored here — bodies are built later, because pickLook's palettes
// don't exist yet when the interiors pass runs.
const staff = [];

function furnishRoom(R, b, r, dx, dz, walls) {
  const fz = b.fz, fx = b.fx;
  const ix = -fx, iz = -fz, lx = fz, lz = -fx;         // inward normal, along-facade
  const cx = R.cx, cz = R.cz;
  const hu = (fz ? r.x1 - r.x0 : r.z1 - r.z0) / 2;     // half span along the facade
  const hv = (fz ? r.z1 - r.z0 : r.x1 - r.x0) / 2;     // half depth; door wall at v=-hv
  const ud = (dx - cx)*lx + (dz - cz)*lz;              // the doorway's u position
  const P = (u, v) => [cx + u*lx + v*ix, cz + u*lz + v*iz];
  const clamp = THREE.MathUtils.clamp;
  const s = ud >= 0 ? -1 : 1;                          // the side away from the door
  // Keep-off from the walkable rect's edge: the room lining is 0.3 thick inside it,
  // and a face flush with the lining z-fights (see the church door in the README).
  const M = 0.55;
  // The walk from the door into the room stays open: a strip 2.8 wide, ~4.5 deep.
  const inLane = (u, v, a, c) =>
    Math.abs(u - ud) < a/2 + 1.4 && v - c/2 < Math.min(0, -hv + 4.5);
  const placed = [];                                   // solid pieces don't overlap
  const ok = (u, v, a, c) =>
    Math.abs(u) + a/2 <= hu - M && Math.abs(v) + c/2 <= hv - M && !inLane(u, v, a, c) &&
    !placed.some(p => Math.abs(u - p.u) < (a + p.a)/2 + 0.25 &&
                      Math.abs(v - p.v) < (c + p.c)/2 + 0.25);
  const vis = (color, u, v, a, c, h, y) => {            // a box: a along u, c along v, y is its base
    const [x, z] = P(u, v);
    fput(color, baked(BOX(fz ? a : c, h, fz ? c : a), x, (y || 0) + h/2, z));
  };
  const cyl = (color, u, v, rad, h, y, rTop) => {       // y is the base; rTop 0 makes a cone
    const [x, z] = P(u, v);
    fput(color, baked(new THREE.CylinderGeometry(rTop === undefined ? rad : rTop, rad, h, 20), x, (y || 0) + h/2, z));
  };
  const sph = (color, u, v, rad, y, sy) => {            // y is the centre
    const [x, z] = P(u, v);
    fput(color, baked(new THREE.SphereGeometry(rad, 16, 12).scale(1, sy || 1, 1), x, y, z));
  };
  const torus = (color, u, v, RR, rr, y, upright) => {  // flat like a donut, or upright on a wall
    const [x, z] = P(u, v);
    fput(color, baked(new THREE.TorusGeometry(RR, rr, 8, 16), x, y, z,
      upright ? 0 : Math.PI/2, upright ? Math.atan2(ix, iz) : 0));
  };
  const solid = (u, v, a, c) => {
    const [x, z] = P(u, v);
    const w = fz ? a : c, d = fz ? c : a;
    const box = { minX: x - w/2, maxX: x + w/2, minZ: z - d/2, maxZ: z + d/2 };
    colliders.push(box); walls.push(box);
    placed.push({ u, v, a, c });
  };
  const guy = (u, v, fu, fv, look, pose) => {           // a person facing local (fu,fv)
    const [x, z] = P(u, v);
    staff.push({ x, z, yaw: Math.atan2(fu*lx + fv*ix, fu*lz + fv*iz), look, pose: pose || 'idle' });
  };
  // panels hung proud of the wall lining — never coplanar with it. y is the centre.
  const backPanel = (color, u, a, h, y, off) => {
    const [x, z] = P(u, hv - 0.42 - (off || 0));
    fput(color, baked(BOX(fz ? a : 0.12, h, fz ? 0.12 : a), x, y, z));
  };
  const sidePanel = (color, s2, v, c, h, y, off) => {
    const [x, z] = P(s2*(hu - 0.42 - (off || 0)), v);
    fput(color, baked(BOX(fz ? 0.12 : c, h, fz ? c : 0.12), x, y, z));
  };
  const counter = (u, v, a, c, bodyCol, topCol) => {
    if (!ok(u, v, a, c)) return false;
    vis(bodyCol || 0x8c6a44, u, v, a, c, 0.95, 0);
    vis(topCol || 0xd8dde4, u, v, a + 0.2, c + 0.2, 0.1, 0.95);
    solid(u, v, a, c);
    return true;
  };
  const crates = (u, v) => {
    if (!ok(u, v, 1.6, 1.6)) return false;
    vis(0x9a6b3f, u, v, 0.9, 0.9, 0.9, 0);
    vis(0x9a6b3f, u + 0.15, v + 0.1, 0.8, 0.8, 0.8, 0.9);
    solid(u, v, 1.4, 1.4);
    return true;
  };
  // a shelving island with colourful merchandise on three levels
  const gondola = (u, v, len, alongV, cols) => {
    const a = alongV ? 1.0 : len, c = alongV ? len : 1.0;
    if (!ok(u, v, a, c)) return false;
    vis(0xcfd3d8, u, v, a, c, 0.3, 0);
    vis(0xe4e7ea, u, v, a, c, 0.08, 0.72);
    vis(0xe4e7ea, u, v, a, c, 0.08, 1.18);
    vis(0xcfd3d8, u, v, alongV ? 0.26 : len, alongV ? len : 0.26, 1.5, 0);
    const pu = alongV ? 0 : 1, pv = alongV ? 1 : 0;
    const n = Math.max(2, Math.round(len / 0.8));
    for (let i = 0; i < n; i++) {
      const off = -len/2 + 0.55 + (len - 1.1) * (n === 1 ? 0.5 : i/(n - 1));
      vis(cols[i % cols.length],       u + off*pu, v + off*pv, 0.5, 0.5, 0.36, 0.36);
      vis(cols[(i + 1) % cols.length], u + off*pu, v + off*pv, 0.5, 0.5, 0.36, 0.82);
      vis(cols[(i + 2) % cols.length], u + off*pu, v + off*pv, 0.5, 0.5, 0.36, 1.28);
    }
    solid(u, v, a, c);
    return true;
  };
  // a round table with four stools; the first `sit` stools get a seated townsperson
  const table = (u, v, topCol, seatCol, sit) => {
    if (!ok(u, v, 2.7, 2.7)) return false;
    cyl(0x6b4a30, u, v, 0.13, 0.72, 0);
    cyl(topCol, u, v, 0.82, 0.09, 0.72);
    let seated = 0;
    for (const [ou, ov] of [[1.08, 0], [-1.08, 0], [0, 1.08], [0, -1.08]]) {
      cyl(seatCol, u + ou, v + ov, 0.3, 0.52, 0);
      if (seated < sit) { guy(u + ou, v + ov, -ou, -ov, null, 'sit'); seated++; }
    }
    solid(u, v, 1.7, 1.7);
    return true;
  };
  // split a u-span into the pieces either side of the door lane
  const dodgeLane = (u0, u1, gap, minLen) => {
    const out = [], g0 = ud - gap, g1 = ud + gap;
    if (g1 < u0 || g0 > u1) { if (u1 - u0 >= minLen) out.push([u0, u1]); return out; }
    if (g0 - u0 >= minLen) out.push([u0, g0]);
    if (u1 - g1 >= minLen) out.push([g1, u1]);
    return out;
  };

  // ---- the grouped briefs ----
  const furnStore = (cols, deskCol) => {               // Try-N-Save and its cousins
    if (counter(ud + s*3.0, -hv + 1.8, 2.4, 1.0, deskCol, 0xe8e3d3))
      guy(ud + s*3.0, -hv + 2.8, 0, -1, { shirt: cols[0], pants: 0x2f3550 });
    const rl = clamp(hu*0.7, 2, 4.5);
    for (const ur of [-s*(hu*0.48), s*(hu*0.48)]) {    // clothing racks: a bar on posts
      if (!ok(ur, hv*0.1, rl, 0.7)) continue;
      for (const e of [-1, 1]) vis(0x8b929a, ur + e*rl/2, hv*0.1, 0.09, 0.09, 1.55, 0);
      vis(0x8b929a, ur, hv*0.1, rl, 0.07, 0.07, 1.5);
      const n = Math.max(3, Math.round(rl/0.55));
      for (let i = 0; i < n; i++) {
        const off = -rl/2 + 0.35 + (rl - 0.7)*i/(n - 1);
        vis(cols[i % cols.length], ur + off, hv*0.1, 0.42, 0.14, 0.8, 0.68);
      }
      solid(ur, hv*0.1, rl, 0.5);
    }
    gondola(0, hv - M - 0.55, clamp(2*hu - 4.5, 2, 6.5), false, cols);
  };
  const furnDiner = (topCol, seatCol, chef) => {       // Luigi's and The Frying Dutchman
    if (counter(0, hv - 1.6, clamp(2*hu - 3.5, 2.4, 7), 1.1, 0x8c5a34, 0xe8e3d3))
      guy(0.8, hv - 0.75, 0, -1, chef);                // the kitchen pass, chef behind it
    let sat = 2;
    for (const [ut, vt] of [[-hu*0.5, -hv*0.25], [hu*0.5, -hv*0.25],
                            [-hu*0.45, hv*0.25], [hu*0.45, hv*0.25], [0, -hv*0.05]]) {
      if (table(ut, vt, topCol, seatCol, sat)) sat = sat === 2 ? 1 : 2;
    }
  };
  const furnStudio = (bg, accent, host) => {           // Channel 6 and Krustylu
    backPanel(bg, 0, clamp(2*hu - 2.5, 3, 8), 3.4, 2.0);
    backPanel(accent, 0, clamp(2*hu - 2.5, 3, 8) - 0.6, 0.7, 3.1, 0.14);
    if (counter(0, hv*0.45, 3.0, 1.2, 0x2f3550, accent))
      guy(0, hv*0.45 + 1.05, 0, -1, host, 'sit');      // the anchor desk
    for (const uc of [-hu*0.4, hu*0.4]) {              // cameras aimed at the desk
      if (!ok(uc, -hv*0.25, 0.8, 0.8)) continue;
      vis(0x4a4f58, uc, -hv*0.25, 0.12, 0.12, 1.25, 0);
      vis(0x2b2f38, uc, -hv*0.25, 0.55, 0.42, 0.4, 1.25);
      vis(0x9aa0a8, uc, -hv*0.25 + 0.3, 0.2, 0.18, 0.2, 1.35);
      solid(uc, -hv*0.25, 0.7, 0.7);
    }
    guy(-hu*0.4, -hv*0.25 - 1.0, 0, 1, { shirt: 0x4a4f58 });
    for (const s2 of [-1, 1]) {                        // studio lights on stands
      const uo = s2*(hu - M - 0.55);
      vis(0x8b929a, uo, hv*0.1, 0.1, 0.1, 2.7, 0);
      vis(0x4a4f58, uo, hv*0.1, 0.5, 0.45, 0.5, 2.65);
      vis(0xfff0b8, uo, hv*0.1 - 0.28, 0.4, 0.06, 0.4, 2.7);
    }
  };

  switch (b.name) {
    case 'SPEEDY MART': {
      if (counter(ud + s*3.0, -hv + 1.8, 2.6, 1.0))
        guy(ud + s*3.0, -hv + 2.9, 0, -1, { shirt: 0x2f8f4f, pants: 0x7b5ea7 });
      const uq = ud - s*2.6;                           // squishee machine by the window
      if (ok(uq, -hv + 1.2, 1.1, 0.9)) {
        vis(0xe8e3d3, uq, -hv + 1.2, 1.0, 0.8, 1.7, 0);
        vis(0xd0392b, uq, -hv + 1.2, 1.05, 0.85, 0.5, 1.1);
        vis(0x7fe0ff, uq, -hv + 0.72, 0.6, 0.06, 0.6, 0.35);
        solid(uq, -hv + 1.2, 1.0, 0.8);
      }
      const AC = [0xd0392b, 0x2f6fc4, 0xf0b429, 0x8ad14f, 0xe87ab0];
      const len = clamp(2*hv - 6.2, 2.2, 7.5);
      const va = hv - M - 0.3 - len/2;                 // aisles hug the back
      for (const ua of [-hu*0.55, 0, hu*0.55]) gondola(ua, va, len, true, AC);
      break;
    }
    case "THE RUSTY MUG": {
      const len = clamp(2*hv - 4.5, 2.5, 9);
      const vb = hv - M - 0.2 - len/2;
      if (counter(s*(hu - 2.4), vb, 1.1, len, 0x5a4632, 0x8c5a34)) {
        for (let k = -1; k <= 1; k++) cyl(0xc9a24b, s*(hu - 2.4), vb + k*len*0.28, 0.05, 0.4, 1.05);
        guy(s*(hu - 1.15), vb, -s, 0, { shirt: 0xffffff, pants: 0x4a4f58, style: 'bald', hair: 0x2a1e16 });
        sidePanel(0x8c5a34, s, vb, len, 0.08, 1.7);    // bottle shelves behind the bar
        sidePanel(0x8c5a34, s, vb, len, 0.08, 2.3);
        const BC = [0x2f8f4f, 0x8c5a34, 0x3fa9d8, 0xc9a24b];
        const nb = Math.max(3, Math.round(len/0.55));
        for (let i = 0; i < nb; i++) {
          const off = -len/2 + 0.4 + (len - 0.8)*i/(nb - 1);
          vis(BC[i % 4], s*(hu - 0.42), vb + off, 0.18, 0.18, 0.45, 1.74);
          vis(BC[(i + 2) % 4], s*(hu - 0.42), vb + off + 0.1, 0.18, 0.18, 0.45, 2.34);
        }
        for (let k = -1; k <= 1; k++) cyl(0x8c3f5e, s*(hu - 3.4), vb + k*len*0.3, 0.3, 0.55, 0);
        guy(s*(hu - 3.4), vb, s, 0, null, 'sit');      // a regular at the bar
        // LAST ORDERS: the bar top is a shuffleboard — record its line, tap end first
        { const [ax2, az2] = P(s*(hu - 2.4), vb - len/2 + 0.35);
          const [bx2, bz2] = P(s*(hu - 2.4), vb + len/2 - 0.35);
          PINTS.push({ A: { x: ax2, z: az2 }, B: { x: bx2, z: bz2 },
                       len: Math.hypot(bx2 - ax2, bz2 - az2) }); }
      }
      table(-s*(hu*0.42), hv*0.42, 0x7d5a3c, 0x8c3f5e, 2);
      table(-s*(hu*0.48), -hv*0.3, 0x7d5a3c, 0x8c3f5e, 1);
      table(0, -hv*0.05, 0x7d5a3c, 0x8c3f5e, 1);
      break;
    }
    case 'BIG DONUT': {
      const a = clamp(hu*0.85, 2.2, 5.5);
      const uc = s*(hu - M - a/2 - 0.2);
      if (counter(uc, -hv*0.1, a, 1.2, 0xe8e3d3, 0xbfe4f2)) {
        guy(uc, -hv*0.1 + 1.15, 0, -1, { shirt: 0xe87ab0, pants: 0x2f3550 });
        const nd = Math.max(2, Math.floor(a/0.7));     // trays of donuts on the glass
        for (let i = 0; i < nd; i++) {
          const off = -a/2 + 0.5 + (a - 1.0)*i/(nd - 1 || 1);
          torus(i % 2 ? 0x6b4423 : 0xe87ab0, uc + off, -hv*0.1 - 0.25, 0.22, 0.1, 1.15);
          torus(i % 2 ? 0xe87ab0 : 0x6b4423, uc + off, -hv*0.1 + 0.25, 0.22, 0.1, 1.15);
        }
      }
      torus(0xe87ab0, 0, hv - 0.75, 1.0, 0.3, 3.1, true);   // the hero donut on the wall
      table(-s*(hu*0.45), hv*0.45, 0xf6f3ea, 0xe87ab0, 1);
      table(-s*(hu*0.45), -hv*0.25, 0xf6f3ea, 0xe87ab0, 1);
      break;
    }
    case 'BURGER BARON': {
      for (const [a0, a1] of dodgeLane(-hu + M + 0.2, hu - M - 0.2, 2.1, 1.6))
        counter((a0 + a1)/2, 0.3, a1 - a0 - 0.3, 1.1, 0xd0392b, 0xf0b429);
      guy(ud + s*2.8, 1.4, 0, -1, { shirt: 0xf0b429, pants: 0xd0392b });
      const mw = clamp(2*hu - 3, 2, 6.5);              // menu board over the kitchen
      backPanel(0xd0392b, 0, mw, 2.0, 2.5);
      backPanel(0xf6f3ea, 0, mw - 0.4, 1.6, 2.5, 0.14);
      for (const uo of [-hu*0.35, hu*0.35]) {          // fry stations
        if (!ok(uo, hv - M - 0.75, 1.2, 1.0)) continue;
        vis(0x9aa0a8, uo, hv - M - 0.75, 1.1, 0.9, 1.15, 0);
        vis(0x2f3550, uo, hv - M - 0.75, 0.7, 0.5, 0.18, 1.15);
        solid(uo, hv - M - 0.75, 1.1, 0.9);
      }
      table(-s*(hu*0.5), -hv*0.55, 0xf6f3ea, 0xd0392b, 1);
      table(s*(hu*0.5), -hv*0.55, 0xf6f3ea, 0xd0392b, 2);
      break;
    }
    case 'COMIC CASTLE': {
      const a = clamp(hu*0.8, 2, 5);
      const uc = s*(hu - M - a/2 - 0.2);
      if (counter(uc, -hv*0.15, a, 1.1, 0x7b5ea7, 0xbfe4f2))
        guy(uc, -hv*0.15 + 1.1, 0, -1,
            { shirt: 0xf6f3ea, pants: 0x3f5f8c, style: 'bun', hair: 0x6b4423, shoulder: 0.72 });
      const CC = [0xd0392b, 0xf0b429, 0x2f6fc4, 0x8ad14f, 0xe87ab0, 0x7fe0ff];
      const rl = clamp(2*hu - 4.5, 2, 6);
      for (const vr of [hv*0.25, hv*0.7]) {            // comic racks in rows
        if (!ok(0, vr, rl, 0.7)) continue;
        vis(0x8c5a34, 0, vr, rl, 0.55, 0.85, 0);
        vis(0x5a4632, 0, vr, rl, 0.14, 1.5, 0);
        const n = Math.max(2, Math.round(rl/0.6));
        for (let i = 0; i < n; i++) {
          const off = -rl/2 + 0.4 + (rl - 0.8)*i/(n - 1);
          vis(CC[i % 6], off, vr - 0.18, 0.42, 0.06, 0.6, 0.95);
          vis(CC[(i + 3) % 6], off, vr + 0.18, 0.42, 0.06, 0.6, 0.95);
        }
        solid(0, vr, rl, 0.6);
      }
      break;
    }
    case 'STRIKE CITY LANES': {
      const lanes = clamp(Math.floor((2*hu - 4.5)/2.1), 1, 3);
      const vTop = hv - M - 1.4;
      const lLen = clamp(2*hv - 4.8, 3, 10);
      for (let i = 0; i < lanes; i++) {
        const uL = s*(hu - M - 1.1) - s*i*2.1;
        if (Math.abs(uL) + 0.95 > hu - M) continue;
        vis(0xe8d8a8, uL, vTop - lLen/2, 1.5, lLen, 0.06, 0.09);
        for (const g of [-0.85, 0.85]) vis(0x4a4f58, uL + g, vTop - lLen/2, 0.18, lLen, 0.12, 0.09);
        if (i === 0) {
          // the first lane is PLAYABLE: no baked pins — the minigame owns a live
          // rack there instead. Record the tee, the roll direction and the pins.
          const [tx, tz] = P(uL, vTop - lLen - 0.7);
          const [ex, ez] = P(uL, vTop);
          const dl = Math.hypot(ex - tx, ez - tz) || 1;
          BOWLS.push({ tee: { x: tx, z: tz }, dx: (ex - tx)/dl, dz: (ez - tz)/dl, len: dl,
            pins: [[0, 0], [-0.2, 0.28], [0.2, 0.28], [-0.4, 0.56], [0, 0.56], [0.4, 0.56]]
              .map(([pu, pv]) => { const [px, pz] = P(uL + pu, vTop + 0.55 + pv); return { x: px, z: pz }; }) });
          continue;
        }
        for (const [pu, pv] of [[0, 0], [-0.2, 0.28], [0.2, 0.28], [-0.4, 0.56], [0, 0.56], [0.4, 0.56]])
          cyl(0xf6f3ea, uL + pu, vTop + 0.55 + pv, 0.08, 0.4, 0.15);
      }
      const ub = s*(hu - M - 2.1), vb = Math.max(-hv + M + 1.0, vTop - lLen - 1.2);
      if (ok(ub, vb, 0.8, 1.7)) {                      // the ball return
        vis(0x2f3550, ub, vb, 0.75, 1.6, 0.5, 0);
        sph(0xd0392b, ub, vb - 0.3, 0.22, 0.62);
        sph(0x2f6fc4, ub, vb + 0.25, 0.22, 0.62);
        solid(ub, vb, 0.75, 1.6);
      }
      if (counter(ud - s*3.0, -hv + 1.8, 2.2, 1.0, 0x4f7d8c, 0xe8e3d3) ||
          counter(ud + s*3.0, -hv + 1.8, 2.2, 1.0, 0x4f7d8c, 0xe8e3d3))
        guy(ud - s*3.0, -hv + 2.8, 0, -1, { shirt: 0xd0392b, pants: 0x4a4f58 });
      // (no staff bowler on lane 0 any more — that tee is the player's)
      break;
    }
    case 'BARGAIN BARN': {
      furnStore([0xd0392b, 0x2f6fc4, 0xf0b429, 0x8ad14f], 0xcfe6c8);
      // CRATE RUSH: record up to six clear aisle spots (post-furniture, so ok()
      // knows what's standing) and a tee by the door
      const spots = [];
      for (const vv of [-hv*0.55, -hv*0.1, hv*0.35, hv*0.65])
        for (const uu of [-hu*0.6, -hu*0.15, hu*0.3, hu*0.65]) {
          if (spots.length >= 6 || !ok(uu, vv, 1.2, 1.2)) continue;
          const [sx2, sz2] = P(uu, vv); spots.push({ x: sx2, z: sz2 });
        }
      if (spots.length >= 4) {
        // the tee stands past the doorway's F-reach, or the door eats the keypress
        const [tx2, tz2] = P(ud, Math.min(0, -hv + 5.2));
        RUSHES.push({ spots, tee: { x: tx2, z: tz2 } });
      }
      break;
    }
    case 'LEFTY’S':     furnStore([0x59c9a5, 0x2f6fc4, 0xe87ab0, 0xf0b429], 0x59c9a5); break;
    case 'ARMY SURPLUS': furnStore([0x2f6a52, 0x9a8f6a, 0x4a4f58, 0x6b5b45], 0x9a8f6a); break;
    case "TONY'S PIZZA":
      furnDiner(0xf6f3ea, 0xd0392b, { shirt: 0xffffff, pants: 0x2f3550, hair: 0x2a1e16 });
      break;
    case 'CAPTAIN’S CATCH': {
      furnDiner(0x7d5a3c, 0x2f6fc4, { shirt: 0x3fa9d8, pants: 0x2f3550, style: 'bald', hair: 0x8a8a8a });
      torus(0x8c5a34, 0, hv - 0.8, 0.7, 0.09, 2.6, true);   // a ship's wheel on the wall
      backPanel(0x8c5a34, 0.9, 0.16, 1.6, 2.6, 0.1);
      backPanel(0x8c5a34, -0.9, 0.16, 1.6, 2.6, 0.1);
      break;
    }
    case 'GOLDEN KOI SUSHI': {
      const a = clamp(2*hu - 3.5, 2.4, 7);
      if (counter(0, hv - 1.6, a, 1.1, 0x2b2f38, 0xd0392b)) {   // the sushi bar
        guy(0.4, hv - 0.75, 0, -1, { shirt: 0xf6f3ea, pants: 0xd0392b, style: 'bald', hair: 0x101010 });
        for (let i = 0; i < Math.floor(a/0.9); i++) {
          const off = -a/2 + 0.5 + i*0.9;
          cyl(0xf6f3ea, off, hv - 1.6, 0.16, 0.05, 1.06);
          cyl(i % 2 ? 0xe87ab0 : 0xd0392b, off, hv - 1.6, 0.09, 0.08, 1.11);
        }
        for (const uo of [-1.2, 0, 1.2]) cyl(0x2b2f38, uo, hv - 2.75, 0.3, 0.52, 0);
        guy(-1.2, hv - 2.75, 0, 1, null, 'sit');
        guy(1.2, hv - 2.75, 0, 1, null, 'sit');
        // CONVEYOR CATCH: plates ride this counter — record the line, left to right
        { const [ax2, az2] = P(-a/2 + 0.3, hv - 1.6);
          const [bx2, bz2] = P(a/2 - 0.3, hv - 1.6);
          KOIS.push({ A: { x: ax2, z: az2 }, B: { x: bx2, z: bz2 },
                      len: Math.hypot(bx2 - ax2, bz2 - az2) }); }
      }
      for (const uo of [-hu*0.5, 0, hu*0.5]) {         // paper lanterns
        vis(0x8b929a, uo, 0, 0.05, 0.05, 0.5, CEIL_H - 0.55);
        cyl(0xd0392b, uo, 0, 0.26, 0.5, CEIL_H - 1.05);
        cyl(0xf0b429, uo, 0, 0.27, 0.1, CEIL_H - 0.85);
      }
      table(-hu*0.5, -hv*0.4, 0x2b2f38, 0xd0392b, 1);
      table(hu*0.5, -hv*0.4, 0x2b2f38, 0xd0392b, 2);
      break;
    }
    case 'PIXEL PALACE': {
      const n = clamp(Math.floor((2*hu - 3.5)/1.05), 2, 6);
      const rowLen = n*1.05, vI = hv*0.3;
      const SC = [0x7fe0ff, 0xe87ab0, 0x8ad14f, 0xf0b429];
      if (ok(0, vI, rowLen, 2.0)) {                    // back-to-back cabinet island
        for (let i = 0; i < n; i++) {
          const uo = -rowLen/2 + 0.5 + i*1.05;
          for (const r2 of [-1, 1]) {
            vis(0x2f3550, uo, vI + r2*0.5, 0.9, 0.85, 1.85, 0);
            vis(SC[(i + (r2 > 0 ? 2 : 0)) % 4], uo, vI + r2*1.0, 0.6, 0.08, 0.55, 1.15);
            vis(SC[(i + (r2 > 0 ? 3 : 1)) % 4], uo, vI + r2*0.97, 0.8, 0.1, 0.25, 1.9);
          }
        }
        solid(0, vI, rowLen, 2.0);
        guy(-rowLen/2 + 0.5, vI - 1.6, 0, 1, { style: 'spiky', shirt: 0x8ad14f });
        guy(rowLen/2 - 0.5, vI + 1.6, 0, -1, { shirt: 0xe87ab0 });
        // WHACK-A-CABINET: every cabinet on the island is a target
        const cabs = [];
        for (let i = 0; i < n; i++) for (const r2 of [-1, 1]) {
          const [wx2, wz2] = P(-rowLen/2 + 0.5 + i*1.05, vI + r2*0.5);
          cabs.push({ x: wx2, z: wz2 });
        }
        const [tx2, tz2] = P(ud, Math.min(0, -hv + 5.2));   // past the door's F-reach
        WHACKS.push({ cabs, tee: { x: tx2, z: tz2 } });
      }
      const um = ud - s*3.0;                           // change machine
      if (ok(um, -hv + 1.1, 0.9, 0.7)) {
        vis(0x2f6fc4, um, -hv + 1.1, 0.8, 0.6, 1.6, 0);
        vis(0xf0b429, um, -hv + 1.46, 0.5, 0.06, 0.5, 0.6);
        solid(um, -hv + 1.1, 0.8, 0.6);
      }
      for (const vw of [hv*0.75, -hv*0.1]) {           // a couple more against the wall
        const uw = -s*(hu - M - 0.5);
        if (!ok(uw, vw, 0.9, 0.9)) continue;
        vis(0x2f3550, uw, vw, 0.85, 0.9, 1.85, 0);
        vis(SC[(vw > 0 ? 1 : 3)], uw + s*0.47, vw, 0.08, 0.6, 0.55, 1.15);
        solid(uw, vw, 0.85, 0.9);
      }
      break;
    }
    case 'GRAND THEATER': {
      const sw = clamp(2*hu - 3, 3, 9);
      backPanel(0x4a4f58, 0, sw, 3.2, 2.35);           // the silver screen
      backPanel(0xf6f3ea, 0, sw - 0.5, 2.6, 2.3, 0.14);
      if (ok(0, hv - M - 1.2, sw*0.8, 1.6)) vis(0x8c3f5e, 0, hv - M - 1.2, sw*0.8, 1.6, 0.2, 0);
      let sat = 0;
      for (let row = 0; row < 3; row++) {              // seating faces the screen
        const vr = -hv*0.55 + row*1.4;
        if (vr > hv - M - 3.2) break;
        for (const [a0, a1] of dodgeLane(-hu + M + 0.3, hu - M - 0.3, 2.0, 1.1)) {
          const nSeat = Math.floor((a1 - a0)/0.62);
          if (nSeat < 2) continue;
          for (let i = 0; i < nSeat; i++) {
            const uS = a0 + 0.31 + i*0.62;
            vis(0x8c1f2f, uS, vr, 0.52, 0.5, 0.5, 0);
            vis(0x8c1f2f, uS, vr - 0.26, 0.52, 0.14, 1.0, 0);
            if (sat < 2 && i === (row + 1) % nSeat) { guy(uS, vr + 0.05, 0, 1, null, 'sit'); sat++; }
          }
          solid((a0 + a1)/2, vr, a1 - a0, 0.75);
        }
      }
      break;
    }
    case 'CITY MALL': {
      if (counter(0, hv*0.4, 2.8, 1.1, 0x7b4fa7, 0xd8dde4))    // a kiosk
        guy(0, hv*0.4 + 1.05, 0, -1, { shirt: 0x7b4fa7 });
      for (const [up, vp] of [[-hu*0.55, -hv*0.15], [hu*0.55, -hv*0.15]]) {
        if (!ok(up, vp, 1.4, 1.4)) continue;           // planters with hedges
        vis(0xc9ccd2, up, vp, 1.3, 1.3, 0.5, 0);
        sph(0x3f8f4a, up, vp, 0.72, 0.85, 0.8);
        solid(up, vp, 1.3, 1.3);
      }
      for (const ub of [-hu*0.5, hu*0.5]) {            // benches
        if (!ok(ub, hv*0.62, 1.9, 0.8)) continue;
        vis(0x8c5a34, ub, hv*0.62, 1.8, 0.55, 0.14, 0.42);
        vis(0x8c5a34, ub, hv*0.62 + 0.3, 1.8, 0.12, 0.55, 0.42);
        for (const e of [-0.7, 0.7]) vis(0x4a4f58, ub + e, hv*0.62, 0.14, 0.5, 0.42, 0);
        solid(ub, hv*0.62, 1.8, 0.7);
        if (ub < 0) guy(ub - 0.3, hv*0.62 - 0.05, 0, -1, null, 'sit');
      }
      const udir = ud - s*3.2;                         // the directory board
      if (ok(udir, -hv + 1.3, 1.3, 0.5)) {
        vis(0x4a4f58, udir, -hv + 1.3, 1.2, 0.18, 2.1, 0);
        vis(0x9ad8ff, udir, -hv + 1.17, 1.0, 0.05, 1.3, 0.6);
        solid(udir, -hv + 1.3, 1.2, 0.3);
      }
      break;
    }
    case 'ACTION NEWS':
      furnStudio(0x2f6fc4, 0xf0b429, { shirt: 0x2f3550, pants: 0x4a4f58, hair: 0x8a8a8a });
      break;
    case 'STARLIGHT STUDIOS':
      furnStudio(0x8f6fbf, 0xd0392b,
                 { skin: 0xf6f3ea, hair: 0x2f8f4f, shirt: 0x59c9a5, pants: 0xd0392b, style: 'spiky' });
      break;
    case 'PUTT PARADISE': {
      const gw = clamp(hu*0.75, 1.8, 4), gd = clamp(hv*0.7, 1.8, 4.5);
      // the cups are REAL: their positions are recorded and the minigame drops a
      // ball you can actually putt into them (see the MINIGAMES section)
      const putt = { holes: [], tee: null, rect: r, walls, sunk: 0 };
      const g1u = -s*(hu*0.45), g1v = hv*0.4;
      if (ok(g1u, g1v, gw, gd)) {                      // the windmill green
        vis(0x3f9f3a, g1u, g1v, gw, gd, 0.06, 0.09);
        const wv = g1v + gd/2 - 0.7;
        vis(0xd0392b, g1u, wv, 0.85, 0.85, 1.6, 0.15);
        cyl(0x8c3f5e, g1u, wv, 0.62, 0.75, 1.75, 0);
        vis(0xf6f3ea, g1u, wv - 0.5, 1.6, 0.08, 0.18, 1.35);
        vis(0xf6f3ea, g1u, wv - 0.5, 0.18, 0.08, 1.6, 0.65);
        solid(g1u, wv, 0.85, 0.85);
        cyl(0x2b2f38, g1u, g1v - gd/2 + 0.5, 0.11, 0.03, 0.15);
        vis(0x8b929a, g1u + 0.15, g1v - gd/2 + 0.5, 0.05, 0.05, 0.9, 0.15);
        vis(0xd0392b, g1u + 0.35, g1v - gd/2 + 0.5, 0.4, 0.04, 0.22, 0.85);
        { const [hx, hz] = P(g1u, g1v - gd/2 + 0.5); putt.holes.push({ x: hx, z: hz }); }
      }
      const g2u = s*(hu*0.45), g2v = -hv*0.15;
      if (ok(g2u, g2v, gw, gd*0.8)) {                  // a mound to putt over
        vis(0x3f9f3a, g2u, g2v, gw, gd*0.8, 0.06, 0.09);
        sph(0x3f9f3a, g2u - gw*0.2, g2v, 0.5, 0.12, 0.35);
        cyl(0x2b2f38, g2u + gw*0.25, g2v, 0.11, 0.03, 0.15);
        vis(0x8b929a, g2u + gw*0.25 + 0.15, g2v, 0.05, 0.05, 0.9, 0.15);
        vis(0x2f6fc4, g2u + gw*0.25 + 0.35, g2v, 0.4, 0.04, 0.22, 0.85);
        { const [hx, hz] = P(g2u + gw*0.25, g2v); putt.holes.push({ x: hx, z: hz }); }
      }
      if (putt.holes.length) {
        const [tx, tz] = P(ud, Math.min(0, -hv + 2.6));
        putt.tee = { x: tx, z: tz };
        PUTTS.push(putt);
      }
      if (counter(ud - s*2.9, -hv + 1.7, 2.2, 1.0, 0x8ad14f, 0xe8e3d3)) {
        guy(ud - s*2.9, -hv + 2.7, 0, -1, { shirt: 0x8ad14f, pants: 0x6b5b45 });
        for (let i = 0; i < 4; i++)
          sph([0xd0392b, 0x2f6fc4, 0xf0b429, 0xe87ab0][i], ud - s*2.9 - 0.75 + i*0.5, -hv + 1.7, 0.09, 1.14);
      }
      break;
    }
    case 'CURL UP & DYE': {
      const nCh = hv > 4.5 ? 2 : 1;
      for (let i = 0; i < nCh; i++) {
        const vc = hv*0.15 + (i - (nCh - 1)/2)*2.4;
        sidePanel(0xdff2fc, s, vc, 1.4, 1.6, 2.0);     // mirrors on the wall
        sidePanel(0x8b929a, s, vc, 1.7, 0.12, 1.1);
        if (!ok(s*(hu - 1.7), vc, 1.0, 1.0)) continue;
        cyl(0x8b929a, s*(hu - 1.7), vc, 0.09, 0.4, 0); // barber chairs facing them
        vis(0xd0392b, s*(hu - 1.7), vc, 0.8, 0.7, 0.2, 0.4);
        vis(0xd0392b, s*(hu - 1.7) - s*0.35, vc, 0.16, 0.7, 0.75, 0.4);
        solid(s*(hu - 1.7), vc, 0.9, 0.9);
        if (i === 0) {
          guy(s*(hu - 1.7), vc, s, 0, null, 'sit');
          guy(s*(hu - 2.9), vc + 0.75, s, 0, { shirt: 0xe87ab0, pants: 0x2f3550, style: 'tall', hair: 0x4a6fd8 });
        }
      }
      counter(ud - s*2.9, -hv + 1.7, 2.2, 1.0, 0xe87ab0, 0xf6f3ea);
      break;
    }
    case 'TOWN MUSEUM': {
      if (ok(0, hv*0.55, 1.6, 1.6)) {                  // the marquee exhibit
        vis(0xe6e0cf, 0, hv*0.55, 1.5, 1.5, 1.1, 0);
        vis(0xc9b458, 0, hv*0.55, 0.55, 0.35, 0.9, 1.1);
        sph(0xc9b458, 0, hv*0.55, 0.28, 2.3);
        solid(0, hv*0.55, 1.5, 1.5);
        for (const uo of [-1.5, 0, 1.5]) cyl(0xc9a24b, uo, hv*0.55 - 1.7, 0.06, 0.9, 0);
        for (const uo of [-0.75, 0.75]) vis(0x8c3f5e, uo, hv*0.55 - 1.7, 1.4, 0.06, 0.07, 0.78);
        // THE HEIST: sweeping alarm beams guard this exhibit after you take the job on
        { const [ex2, ez2] = P(0, hv*0.55 - 1.2);
          const [tx2, tz2] = P(ud, Math.min(0, -hv + 5.2));
          HEISTS.push({ ex: { x: ex2, z: ez2 }, tee: { x: tx2, z: tz2 },
                        cx: R.cx, cz: R.cz, arm: Math.max(2.2, Math.min(hu, hv) - 1.2) }); }
      }
      for (const [up, vp, kind] of [[-hu*0.5, -hv*0.1, 0], [hu*0.5, -hv*0.1, 1]]) {
        if (!ok(up, vp, 1.1, 1.1)) continue;           // side plinths
        vis(0xe6e0cf, up, vp, 1.0, 1.0, 1.2, 0);
        if (kind) sph(0x2f6fc4, up, vp, 0.34, 1.6);
        else cyl(0xc9a24b, up, vp, 0.34, 0.6, 1.2, 0);
        solid(up, vp, 1.0, 1.0);
      }
      if (counter(ud + s*2.9, -hv + 1.7, 2.2, 1.0, 0xe6e0cf, 0x8c3f5e))
        guy(ud + s*2.9, -hv + 2.7, 0, -1, { shirt: 0x4f7d8c, pants: 0x2f3550, style: 'bun' });
      break;
    }
    case 'ORDER OF THE OWL': {
      const len = clamp(2*hv - 5.5, 2.5, 7.5);
      const vt = hv*0.05;
      // the table spans most of the room's depth, so a mid-facade door lane can veto
      // the centre line — slide sideways until it fits
      const uT = [0, -2.2, 2.2, -3.2, 3.2].find(u2 => ok(u2, vt, 1.6, len));
      if (uT !== undefined) {                          // the ceremonial table
        vis(0x5a4632, uT, vt, 1.5, len, 0.9, 0);
        vis(0x6b4a30, uT, vt, 1.7, len + 0.2, 0.1, 0.9);
        solid(uT, vt, 1.5, len);
        const nc = Math.max(2, Math.floor(len/1.2));
        let sat = 0;
        for (let i = 0; i < nc; i++) {
          const off = -len/2 + 0.7 + (len - 1.4)*i/(nc - 1 || 1);
          for (const s2 of [-1, 1]) {
            if (Math.abs(uT + s2*1.6) > hu - M - 0.2) continue;
            vis(0x2b2f38, uT + s2*1.25, vt + off, 0.55, 0.55, 0.55, 0);
            vis(0x2b2f38, uT + s2*1.5, vt + off, 0.14, 0.55, 1.15, 0);
            if (sat < 3 && (i + (s2 > 0 ? 1 : 0)) % 2) {
              guy(uT + s2*1.22, vt + off, -s2, 0, { shirt: 0x8c3f5e, pants: 0x8c3f5e, style: 'bald' }, 'sit');
              sat++;
            }
          }
        }
        for (const e of [-1, 1]) {                     // candles at the ends
          cyl(0xc9a24b, uT, vt + e*(len/2 - 0.4), 0.07, 1.1, 1.0);
          sph(0xf0b429, uT, vt + e*(len/2 - 0.4), 0.09, 2.2);
        }
        // THE INITIATION: stand beside the table and prove yourself. The table's
        // foot is inside the doorway's F-reach, so the tee goes to the side.
        { const su = [uT + 2.6, uT - 2.6, uT + 3.2, uT - 3.2].find(u2 => ok(u2, vt, 0.8, 0.8));
          const [tx2, tz2] = P(su !== undefined ? su : uT, su !== undefined ? vt : vt + len/2 + 1.2);
          OWLS.push({ tee: { x: tx2, z: tz2 } }); }
      }
      backPanel(0x8f9aa6, 0, 2.6, 3.0, 2.2);           // the sacred tablet
      for (let gy = 0; gy < 3; gy++) for (let gx = -1; gx <= 1; gx++)
        backPanel(0x4a4f58, gx*0.7, 0.4, 0.4, 1.3 + gy*0.75, 0.16);
      break;
    }
    case 'CLUB INFERNO': {
      const n = clamp(Math.floor(Math.min(2*hu - 3, 2*hv - 5)/1.1), 2, 4);
      const f0 = -(n*1.1)/2 + 0.55, fv = -hv*0.05;
      const tiles = [];
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { // the lit floor
        vis((i + j) % 2 ? 0xe87ab0 : 0x7fe0ff, f0 + i*1.1, fv + f0 + j*1.1, 1.06, 1.06, 0.08, 0.09);
        const [dx2, dz2] = P(f0 + i*1.1, fv + f0 + j*1.1);
        tiles.push({ x: dx2, z: dz2 });                        // DANCE FLOOR targets
      }
      { const [tx2, tz2] = P(0, fv - (n*1.1)/2 - 1.3);
        DANCES.push({ tiles, tee: { x: tx2, z: tz2 } }); }
      sph(0xd8dde4, 0, fv, 0.5, CEIL_H - 1.15);        // mirror ball
      vis(0x8b929a, 0, fv, 0.05, 0.05, 0.55, CEIL_H - 0.6);
      if (counter(0, hv - 1.5, 2.8, 1.1, 0x7b4fa7, 0xf0b429)) {
        guy(0, hv - 0.7, 0, -1, { style: 'spiky', shirt: 0xf0b429, hair: 0x7b4fa7 });
        cyl(0x2b2f38, -0.5, hv - 1.5, 0.22, 0.06, 1.06);
        cyl(0x2b2f38, 0.5, hv - 1.5, 0.22, 0.06, 1.06);
      }
      for (const s2 of [-1, 1]) {                      // speaker stacks
        const uo = s2*(hu*0.62), vo = hv - M - 0.6;
        if (!ok(uo, vo, 0.9, 0.8)) continue;
        vis(0x2b2f38, uo, vo, 0.85, 0.7, 1.5, 0);
        vis(0x4a4f58, uo, vo - 0.38, 0.55, 0.06, 0.55, 0.7);
        solid(uo, vo, 0.85, 0.7);
      }
      guy(-1.0, fv + 0.4, 1, 0, { shirt: 0xf0b429, pants: 0xffffff }, 'dance');
      guy(1.0, fv - 0.3, -1, 0, { shirt: 0xe87ab0, style: 'tall', hair: 0x4a6fd8 }, 'dance');
      break;
    }
    case '742 MAPLE DRIVE': {
      let done = false;
      for (const u of [0, -1.7, 1.7]) {                // TV against the back, couch facing it
        const vT = hv - M - 0.45, vS = vT - 2.9;
        if (!ok(u, vT, 1.6, 0.8) || !ok(u, vS, 3.2, 1.3)) continue;
        vis(0x8c5a34, u, vT, 1.5, 0.6, 0.45, 0);
        vis(0x4a4f58, u, vT, 1.3, 0.5, 0.95, 0.45);
        vis(0x9ad8ff, u, vT - 0.29, 1.0, 0.05, 0.7, 0.58);
        solid(u, vT, 1.5, 0.6);
        vis(0xe08133, u, vS, 2.9, 1.1, 0.55, 0);       // the family couch
        vis(0xe08133, u, vS - 0.42, 2.9, 0.3, 1.15, 0);
        for (const e of [-1, 1]) vis(0xe08133, u + e*1.32, vS, 0.3, 1.1, 0.8, 0);
        solid(u, vS, 3.0, 1.2);
        vis(0x7b4fa7, u, vS + 1.55, 3.2, 1.6, 0.04, 0.09);      // rug
        if (ok(u, vS + 1.55, 1.5, 0.8)) {
          vis(0x8c5a34, u, vS + 1.55, 1.4, 0.7, 0.42, 0.13);    // coffee table
          solid(u, vS + 1.55, 1.4, 0.7);
        }
        if (Math.abs(u + 2.0) < hu - M - 0.3) {        // a lamp beside the couch
          vis(0x8b929a, u + 2.0, vS, 0.08, 0.08, 1.5, 0);
          cyl(0xfbe7a8, u + 2.0, vS, 0.32, 0.4, 1.5, 0.2);
        }
        for (let i = 0; i < 3; i++)                    // family photos
          backPanel([0x2f6fc4, 0xd0392b, 0x2f8f4f][i], u - 1.2 + i*1.2, 0.55, 0.7, 3.0);
        done = true; break;
      }
      if (!done) crates(s*(hu - 1.45), -hv + 1.45);
      break;
    }
    default: {                                         // the original modest fit-out
      counter(0, hv - M - 0.6, clamp(2*hu*0.55, 1.8, 6), 1.1);
      crates(s*(hu - 1.45), -hv + 1.45);
    }
  }

  // ---- house dressing ------------------------------------------------
  // Every brief above furnishes what a shop *is*. This is what every shop *has*, and it
  // runs for all of them including the plain fit-out. A room with good furniture and
  // bare walls still reads as a diorama: it is the ceiling lights, the clock, the
  // pictures and the junk in the corners that make it read as somewhere people work.
  // Everything here is wall- or ceiling-mounted (so it cannot land on top of anything a
  // brief placed) or goes through ok()/solid() like the rest.
  {
    const nL = clamp(Math.round(hu / 2.2), 1, 4);      // strip lights down the long axis
    for (let i = 0; i < nL; i++) {
      const u = nL === 1 ? 0 : -hu*0.62 + (hu*1.24)*(i/(nL - 1));
      vis(0xc9ccd2, u, 0, 1.9, 0.62, 0.07, CEIL_H - 0.1);
      vis(0xfff6e2, u, 0, 1.6, 0.44, 0.05, CEIL_H - 0.15);
    }
    const uc = -s*hu*0.45;                             // a clock, high on the back wall
    backPanel(0xf6f3ea, uc, 0.62, 0.62, 3.35);
    torus(0x2f3550, uc, hv - 0.36, 0.33, 0.045, 3.35, true);
    backPanel(0x2f3550, uc, 0.05, 0.3, 3.44, 0.1);
    backPanel(0x2f3550, uc + 0.11, 0.22, 0.05, 3.35, 0.1);
    const FRAME = [0x8c5a34, 0x4a4f58, 0xc9a24b];      // framed pictures at eye height
    const ART   = [0x59c9a5, 0xe8952f, 0x7b4fa7, 0x3fa9d8, 0xd0392b];
    for (const s2 of [-1, 1]) {
      const n = clamp(Math.round(hv / 2.6), 1, 3);
      for (let i = 0; i < n; i++) {
        const v = n === 1 ? 0 : -hv*0.5 + hv*(i/(n - 1));
        sidePanel(FRAME[i % 3], s2, v, 1.15, 0.85, 2.5);
        sidePanel(ART[(i + (s2 > 0 ? 2 : 0)) % 5], s2, v, 0.95, 0.65, 2.5, 0.1);
      }
    }
    for (let i = 0; i < 4; i++) {                      // stock, above head height
      const v = -hv*0.55 + (hv*1.1)*(i/3);
      sidePanel(0x8c6a44, -s, v, 0.9, 0.08, 1.95, 0.22);
      sidePanel([0xd0392b, 0x2f6fc4, 0xf0b429, 0x2f8f4f][i], -s, v, 0.5, 0.34, 2.16, 0.24);
    }
    vis(0x6b5b45, ud, -hv + 1.05, 1.7, 1.0, 0.035, 0.02);   // a doormat, flat enough to
    vis(0x8c6a44, ud, -hv + 1.05, 1.4, 0.75, 0.03, 0.055);  // never be in the way
    const up = s*(hu - 0.95), vp = hv - 0.95;          // a plant in the far corner
    if (ok(up, vp, 1.0, 1.0)) {
      cyl(0xa8543f, up, vp, 0.34, 0.5, 0, 0.28);
      cyl(0x5a4632, up, vp, 0.07, 0.5, 0.5);
      for (const [du, dv, h] of [[0, 0, 1.0], [0.22, 0.1, 0.78], [-0.2, -0.12, 0.72]])
        sph(0x3f8f4a, up + du, vp + dv, 0.38, h + 0.28, 0.85);
      solid(up, vp, 0.9, 0.9);
    }
    const ub = -s*(hu - 0.7), vb = -hv + 0.85;         // and a bin by the door side
    if (ok(ub, vb, 0.7, 0.7)) {
      cyl(0x4a4f58, ub, vb, 0.28, 0.62, 0, 0.24);
      torus(0x2b2f38, ub, vb, 0.27, 0.045, 0.62);
      solid(ub, vb, 0.6, 0.6);
    }
  }
}

// Now that every block is built, each walk-in building can work out where its doorway
// goes and how much of its footprint is actually habitable. Both need to know what the
// rest of the town put here, which is why this waits until the block loop is done.
// Geometry is rngNeutral, so the town downstream — trees, props, coins — is unmoved.
rngNeutral(() => {
  for (const b of WALKIN) {
    // local +x along the facade maps to world (fz, -fx); local +z is the outward normal
    const sx = b.fz, sz = -b.fx;
    const toLocal = (ux, uz) => [ux*b.fz - uz*b.fx, ux*b.fx + uz*b.fz];

    // Buildings overlap in this town. Harmless while both are solid boxes, fatal once one
    // is hollow: the neighbour's collider sits inside the room and collideCircle resolves
    // it to its *nearest face*, which shoves you out through your own wall. So trim the
    // room back off anything already standing in here — never off the door wall.
    const r = { x0: b.cx - b.W/2 + WALL_T, x1: b.cx + b.W/2 - WALL_T,
                z0: b.cz - b.D/2 + WALL_T, z1: b.cz + b.D/2 - WALL_T };
    const doorSide = b.fz < 0 ? 'z0' : b.fz > 0 ? 'z1' : b.fx < 0 ? 'x0' : 'x1';
    let ok = true;
    for (let pass = 0; pass < 12; pass++) {
      const c = colliders.find(c => c !== b.foot &&
        c.maxX > r.x0 && c.minX < r.x1 && c.maxZ > r.z0 && c.minZ < r.z1);
      if (!c) break;
      // four ways to exclude it; take the cheapest that isn't the door wall
      const cuts = [['x0', c.maxX - r.x0], ['x1', r.x1 - c.minX],
                    ['z0', c.maxZ - r.z0], ['z1', r.z1 - c.minZ]]
        .filter(([k]) => k !== doorSide).sort((a, b2) => a[1] - b2[1]);
      const [side, amt] = cuts[0];
      if (side[0] === 'x') r[side] += (side === 'x0' ? amt : -amt);
      else                 r[side] += (side === 'z0' ? amt : -amt);
      if (r.x1 - r.x0 < 5 || r.z1 - r.z0 < 5) { ok = false; break; }
    }
    if (!ok || r.x1 - r.x0 < 5 || r.z1 - r.z0 < 5) continue;   // left solid, as built

    // where on the frontage the doorway goes: it must clear the trimmed room *and* have
    // open ground in front of it, since neighbours crowd some of these facades
    const [lx0, lz0] = toLocal(r.x0 - b.cx, r.z0 - b.cz);
    const [lx1, lz1] = toLocal(r.x1 - b.cx, r.z1 - b.cz);
    const ir = { x0: Math.min(lx0, lx1), x1: Math.max(lx0, lx1),
                 z0: Math.min(lz0, lz1), z1: Math.max(lz0, lz1) };
    const clear = q => {
      if (q - b.dw/2 < ir.x0 + 0.3 || q + b.dw/2 > ir.x1 - 0.3) return false;
      if (b.avoid.some(a => Math.abs(a - q) < b.dw/2 + 1.0)) return false;   // windows
      const dx = b.cx + b.fx*b.front + sx*q, dz = b.cz + b.fz*b.front + sz*q;
      for (let out = 1.4; out <= b.reach; out += 1.4)
        if (pointBlocked(dx + b.fx*out, dz + b.fz*out, 0.5)) return false;
      return true;
    };
    let q = 0;
    if (!clear(0)) {
      const opts = [];
      for (let t = 1; t <= 32; t++) opts.push(t*0.45, -t*0.45);
      q = opts.find(clear);
      if (q === undefined) continue;                      // nowhere on this frontage works
    }

    // Committed. Withdraw the solid body, glazing and footprint collider that were built
    // for the seeded stream's benefit, and put a shell and a room in their place.
    withdraw(b.drop);
    const fi = colliders.indexOf(b.foot); if (fi >= 0) colliders.splice(fi, 1);
    const L = g => baked(g, b.cx, 0, b.cz, 0, b.yaw, 0);
    const dx = b.cx + b.fx*b.front + sx*q, dz = b.cz + b.fz*b.front + sz*q;
    const gz = b.glazed ? b.w*0.40 : 0;
    buildShell(L, b.w, b.d, b.h, b.bodyCol, b.dw, b.dh, q, b.skin, gz);
    buildRoomBox(L, ir, b.dw, b.dh, q, vary(b.cx, b.cz, 3) ? 'tile' : 'plank', gz);
    if (b.glazed) {                 // glazing either side, replacing the band across the front
      const gl = (q - b.dw/2) + b.w*0.40, gr = b.w*0.40 - (q + b.dw/2);
      // The band is the frame the glass sits in, so it gets the window cut out of it too
      // — left solid it is a dark panel behind the pane, which is exactly what you saw
      // before: a transparent window onto a wall.
      const band = (cx, cy, pw, ph) => put(0x2f3550, L(baked(BOX(pw, ph, 0.2), cx, cy, b.front)));
      cutWall(band, -b.w*0.43, q - b.dw/2, 0.3, 3.7, -gz, gz);
      cutWall(band, q + b.dw/2,  b.w*0.43, 0.3, 3.7, -gz, gz);
      if (gl > 0.3) put(GLASS, L(baked(BOX(gl, 2.9, 0.26), -b.w*0.40 + gl/2, 2.05, b.front+0.05)), 'glass');
      if (gr > 0.3) put(GLASS, L(baked(BOX(gr, 2.9, 0.26),  b.w*0.40 - gr/2, 2.05, b.front+0.05)), 'glass');
      // mullions, minus any that would stand in the opening — the centre one is at the
      // middle of the frontage and the doorway usually is too
      for (let k = -1; k <= 1; k++) {
        const mx = k*b.w*0.22;
        if (Math.abs(mx - q) > b.dw/2 + 0.1)
          put(0x2f3550, L(baked(BOX(0.16, 3.0, 0.3), mx, 2.05, b.front + 0.1)));
      }
      // and the kick plate in two runs, like the band above it
      const kl = (q - b.dw/2) + b.w*0.44, kr = b.w*0.44 - (q + b.dw/2);
      if (kl > 0.3) put(0x5a5346, L(baked(BOX(kl, 0.4, 0.34), -b.w*0.44 + kl/2, 0.2, b.front + 0.08)));
      if (kr > 0.3) put(0x5a5346, L(baked(BOX(kr, 0.4, 0.34),  b.w*0.44 - kr/2, 0.2, b.front + 0.08)));
    }
    const walls = shellColliders(r, b.fx, b.fz, b.dw, dx, dz);
    const R = addRoom(b.name, r, b.cx, b.cz, b.fx, b.fz, b.dw, walls);
    // the fit-out: contextual furniture and staff, dispatched on the shop's name,
    // with the old counter-and-crates as the fallback for anything unbriefed
    furnishRoom(R, b, r, dx, dz, walls);
    ENTERABLE.push({ name: b.name, x: dx, z: dz, fx: b.fx, fz: b.fz, room: R,
                     w: b.dw - 0.15, h: b.dh - 0.1, off: b.glazed ? 0.30 : 0.12 });
  }
});

// Drive-in landmarks, converted now that every block is settled. rngNeutral for the
// same reason as the walk-ins: the shells' geometry is created before the trees.
rngNeutral(() => {
  // --- the Retirement Castle: withdraw the solid hall, build a shell with a gate ---
  if (CASTLE.col) {
    withdraw(CASTLE.drop);
    const ci = colliders.indexOf(CASTLE.col); if (ci >= 0) colliders.splice(ci, 1);
    const { cx, cz, w, d } = CASTLE;
    const L = g => baked(g, cx, 0, cz, 0, Math.PI);       // front faces -z, like the door did
    buildShell(L, w, d, 13, 0xe0cfa8, 7, 6.5, 0);         // a gate a car fits through
    put(0xc9ccd2, L(baked(BOX(w - 1.6, 0.14, d - 1.6), 0, 0.03, 0)));   // flagstone floor
    const inner = { x0: cx - w/2 + WALL_T, x1: cx + w/2 - WALL_T,
                    z0: cz - d/2 + WALL_T, z1: cz + d/2 - WALL_T };
    CASTLE.inner = inner;
    CASTLE.walls = shellColliders(inner, 0, -1, 7, cx, cz - d/2);
  }
  // --- the stadium: two south segments withdrawn, gate pillars in their place ---
  for (const s of STADIUM.gate) {
    withdraw(s.drop);
    const ci = colliders.indexOf(s.col); if (ci >= 0) colliders.splice(ci, 1);
    const mi = mapBoxes.indexOf(s.box); if (mi >= 0) mapBoxes.splice(mi, 1);
  }
  if (STADIUM.gate.length) {
    for (const sd of [-1, 1]) {
      const g0 = STADIUM.gate[sd < 0 ? 0 : STADIUM.gate.length - 1].g;
      const px = g0.px + Math.sin(g0.yaw + Math.PI/2)*sd*g0.len/2;
      const pz = g0.pz + Math.cos(g0.yaw + Math.PI/2)*sd*g0.len/2;
      put(0xe8e3d3, baked(BOX(2, 15, 2), px, 7.5, pz));
      put(0xe8532f, baked(BOX(2.6, 1.4, 2.6), px, 15.4, pz));
    }
  }
  // --- the Penitentiary: the north wall makes way for a drive-through gate ---
  // Rebuilt only with colours already in the buckets (a new colour would cost a
  // merged mesh at flush, outside this snapshot). The collider swap waits until
  // after cityAudit, past the scatter filters, so the tree baseline can't move.
  if (PRISON.col) {
    withdraw(PRISON.drop);
    const g = PRISON.gate, GATE_W = 13, side = (g.w - GATE_W) / 2;
    const lx = g.x - GATE_W/2 - side/2, rx = g.x + GATE_W/2 + side/2;
    put(0x9aa0a8, baked(BOX(side, 9, g.d), lx, 4.5, g.z));
    put(0x9aa0a8, baked(BOX(side, 9, g.d), rx, 4.5, g.z));
    for (const s of [-1, 1]) {                       // gate pillars with tower-roof caps
      put(0x8b929a, baked(BOX(1.6, 10.5, 3), g.x + s*(GATE_W/2 + 0.8), 5.25, g.z));
      put(0x3c4048, baked(new THREE.ConeGeometry(1.9, 2.4, 4), g.x + s*(GATE_W/2 + 0.8), 11.7, g.z, 0, Math.PI/4));
    }
    put(0x8b929a, baked(BOX(GATE_W + 4.8, 1.4, 1.8), g.x, 10.4, g.z));   // lintel, high over the drive
    PRISON.newCols = [
      { minX: lx - side/2, maxX: lx + side/2, minZ: g.z - g.d/2, maxZ: g.z + g.d/2 },
      { minX: rx - side/2, maxX: rx + side/2, minZ: g.z - g.d/2, maxZ: g.z + g.d/2 },
    ];
    for (const s of [-1, 1]) PRISON.newCols.push({
      minX: g.x + s*(GATE_W/2 + 0.8) - 0.8, maxX: g.x + s*(GATE_W/2 + 0.8) + 0.8,
      minZ: g.z - 1.5, maxZ: g.z + 1.5 });
  }
});

// The door the run opens on. Everything below aims the spawn at it, and the player
// starts on foot in front of it so the interiors aren't something you have to go hunting
// for. Nothing here consumes Math.random, so the seeded town is unaffected.
// With commerce scattered across town, any given shop can land anywhere — open on
// whichever enterable door sits nearest the plaza, so the run still starts downtown
// with a walk-in storefront in front of you.
const OPENING_DOOR = (() => {
  if (!ENTERABLE.length) return null;
  const pz = BLOCKS.find(b => b.zone === 'plaza');
  if (!pz) return ENTERABLE[0];
  return ENTERABLE.reduce((a, b) =>
    Math.hypot(a.x - pz.cx, a.z - pz.cz) <= Math.hypot(b.x - pz.cx, b.z - pz.cz) ? a : b);
})();

// Pick the spawn now that the buildings are up: the nearest clear point on a real
// carriageway to the opening door. Choosing before the blocks were filled meant it could land
// inside a house and get shoved onto a lawn.
{
  const fallback = HOME_BLOCK || BLOCKS[0];
  const home = OPENING_DOOR ? { cx: OPENING_DOOR.x, cz: OPENING_DOOR.z } : fallback;
  const cands = [];
  for (const st of STREETS) {
    if (st.kind === 'highway') continue;
    const L = Math.hypot(st.bx-st.ax, st.bz-st.az);
    if (L < 40) continue;
    for (const t of [0.5, 0.35, 0.65]) {
      const x = st.ax + (st.bx-st.ax)*t, z = st.az + (st.bz-st.az)*t;
      if (overRiver(x, z, 46)) continue;          // the banks are cut below road level
      cands.push({ x, z, st, d: (x-home.cx)**2 + (z-home.cz)**2 });
    }
  }
  cands.sort((a,b) => a.d - b.d);
  let chosen = null;
  for (const c of cands) {
    if (pointBlocked(c.x, c.z, 3)) continue;
    chosen = c; break;
  }
  if (!chosen) {                                  // fall back to the longest street in town
    let bl = -1;
    for (const st of STREETS) {
      if (st.kind === 'highway') continue;
      const L = Math.hypot(st.bx-st.ax, st.bz-st.az);
      if (L > bl) { bl = L; chosen = { x:(st.ax+st.bx)/2, z:(st.az+st.bz)/2, st }; }
    }
  }
  if (chosen) {
    SPAWN.x = chosen.x; SPAWN.z = chosen.z;
    SPAWN.heading = Math.atan2(chosen.st.bx-chosen.st.ax, chosen.st.bz-chosen.st.az);
  }
  console.log(`spawn ${SPAWN.x.toFixed(0)},${SPAWN.z.toFixed(0)} onRoad=${onRoad(SPAWN.x, SPAWN.z, 0)} cands=${cands.length}`);
}

// lawns, driveways and parking aprons
{
  const { c } = noiseCanvas(128, '#7fc95d', 14);
  surface(lawnPos, null, toon(0x74c05a));
  const { c: dc } = noiseCanvas(128, '#b9b2a4', 14);
  surface(drivePos, drivewayUV, toonMapped(tex(dc, null, 8)), -2);
  const { c: lc, g: lg } = noiseCanvas(256, '#6d6880', 16);
  lg.strokeStyle = 'rgba(240,240,230,.55)'; lg.lineWidth = 3;
  for (let i = 0; i < 256; i += 32) { lg.beginPath(); lg.moveTo(i, 30); lg.lineTo(i, 110); lg.stroke(); }
  surface(lotPos, lotUV, toonMapped(tex(lc, null, 8)), -2);
}

// shop signs and billboards
{
  for (const s of signs) {
    const t = signTexture(s.text, s.bg || '#ffffff', s.fg || '#e8532f', 512, 128);
    const p = signPanel(s.w, s.w*0.25, t);
    p.position.set(s.x, s.y, s.z); p.rotation.y = s.yaw; scene.add(p);
  }
  const BILL = [['GOLDEN BREW','#e8b53f','#c0392b'], ['FIZZ COLA','#e8532f','#ffffff'],
                ['DON’T EAT BEEF','#9ec96a','#2f3550'], ['CLOWN SHOW!','#7b4fa7','#ffd23b']];
  let bi = 0;
  for (const B of BLOCKS.filter(b => b.zone === 'house').slice(0, 4)) {
    const u = B.cx;
    const [txt, bg, fg] = BILL[bi++ % BILL.length];
    const bx = u, v0 = B.r.z0 - WALK_HW - 6;
    if (pointBlocked(bx, v0, 4)) continue;      // the original veto, unchanged
    // The fixed offset lands in the street reserve, and on a jittered street that
    // can be the carriageway itself — a billboard in the middle of the road. Roads
    // have no colliders, so pointBlocked never saw it. Test the board and both
    // posts against onRoad and slide inward onto the block edge until all clear.
    let bz = null;
    for (const v of [v0, v0 + 3, B.r.z0 + 1, B.r.z0 + 4]) {
      if (pointBlocked(bx, v, 4)) continue;
      if (onRoad(bx, v, 2.5) || onRoad(bx - 8, v, 1.5) || onRoad(bx + 8, v, 1.5)) continue;
      bz = v; break;
    }
    if (bz === null) continue;                  // rather no billboard than one in the road
    // The art faces the street to the south (-z), and the backing board sits *behind* it.
    // It used to be built at bz+0.4 — on the visible side of the plane — so every
    // billboard in town was a blank grey panel from the front and invisible from the back.
    const board = new THREE.Mesh(new THREE.PlaneGeometry(20, 10),
      new THREE.MeshBasicMaterial({ map: signTexture(txt, bg, fg, 512, 256) }));
    board.position.set(bx, 12, bz - 0.35); board.rotation.y = Math.PI; scene.add(board);
    put(0x6b6f76, baked(BOX(21, 11, 0.6), bx, 12, bz));
    for (const s of [-1,1]) put(0x6b6f76, baked(BOX(0.9, 12, 0.9), bx+s*8, 6, bz+0.1));
  }
}

const BRIDGES = [];
const railCols = [];   // bridge-rail colliders, deferred past the scatter filters
// =================================================================
//  THE RIVER, ITS BRIDGES, AND THE TUNNEL
//  The channel is cut *below* ground and the decks stay at road level, so a
//  bridge is a real crossing without the car ever leaving y=0. The tunnel is
//  the same trick upside down: a hill raised over a flat road.
// =================================================================
{
  const water = [], bank = [];
  const STEP = 14;
  const x0 = -TOWN - 700, x1 = TOWN + 700;
  for (let x = x0; x < x1; x += STEP) {
    const xa = x, xb = x + STEP;
    const za = riverZ(xa), zb = riverZ(xb);
    // water surface, sunk into the ground
    water.push(xa, -5.2, za-RIVER_HW,  xb, -5.2, zb+RIVER_HW,  xb, -5.2, zb-RIVER_HW);
    water.push(xa, -5.2, za-RIVER_HW,  xa, -5.2, za+RIVER_HW,  xb, -5.2, zb+RIVER_HW);
    // sloped banks down to it
    for (const sd of [-1, 1]) {
      const o = RIVER_HW*sd, o2 = (RIVER_HW+11)*sd;
      const A=[xa, -6.0, za+o], B=[xb, -6.0, zb+o], C=[xb, 0.02, zb+o2], D=[xa, 0.02, za+o2];
      const tri = (p,q,r2) => bank.push(p[0],p[1],p[2], q[0],q[1],q[2], r2[0],r2[1],r2[2]);
      if (sd > 0) { tri(A,C,B); tri(A,D,C); } else { tri(A,B,C); tri(A,C,D); }
    }
  }
  const wg = new THREE.BufferGeometry();
  wg.setAttribute('position', new THREE.Float32BufferAttribute(water,3));
  wg.computeVertexNormals();
  // The water is the one custom shader in the game. Ripples are four summed sines
  // over world xz (drifting along +x, the way the river runs); the normal is a
  // finite difference of that height field, lit in three hard toon bands with a
  // stepped sun glint and a fresnel lift toward the sky at grazing angles — so it
  // reads as the same cartoon world, just alive. Transparent + depthWrite:false
  // keeps it invisible to the ink pass, exactly like the toon material it replaced.
  riverWater = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uSun: { value: sunDir },                 // by reference: tracks the day cycle for free
      uDeep: { value: new THREE.Color(0x2e6cb0) },
      uShallow: { value: new THREE.Color(0x58a4e0) },
      uSky: { value: new THREE.Color(0xcfe9ff) },
    },
    vertexShader: `
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform float uTime;
      uniform vec3 uSun, uDeep, uShallow, uSky;
      varying vec3 vWorld;
      float wave(vec2 p) {
        p.x -= uTime * 2.0;                    // the whole field drifts downstream
        return sin(p.x*0.23 + uTime*0.9) * 1.4
             + sin(p.x*0.11 - p.y*0.19 + uTime*0.6) * 1.8
             + sin(p.y*0.31 + uTime*1.4) * 1.0
             + sin((p.x+p.y)*0.53 - uTime*1.9) * 0.7;
      }
      void main() {
        vec2 p = vWorld.xz * 1.4;              // a touch finer than world scale — big
        float e = 0.7;                          // blobs read as a lake, not a river
        float h0 = wave(p);
        // deliberately over-steep normals: a physically-sized ripple quantizes to one
        // flat toon band and the river reads as paint again
        vec3 n = normalize(vec3(h0 - wave(p + vec2(e, 0.0)), 1.6, h0 - wave(p + vec2(0.0, e))));
        float d = max(dot(n, normalize(uSun)), 0.0);
        float band = floor(clamp((d - 0.35) * 1.6, 0.0, 0.999) * 3.0) / 2.0;
        vec3 col = mix(uDeep, uShallow, band);
        vec3 view = normalize(cameraPosition - vWorld);
        float fres = pow(1.0 - max(view.y, 0.0), 2.0);
        col = mix(col, uSky, fres * 0.5);
        float spec = pow(max(dot(n, normalize(normalize(uSun) + view)), 0.0), 30.0);
        col = mix(col, vec3(1.0), step(0.6, spec) * 0.7);   // hard-edged cartoon glints
        gl_FragColor = vec4(col, 0.88);
      }`,
  });
  const wm = new THREE.Mesh(wg, riverWater);
  wm.renderOrder = 1; scene.add(wm);
  const bg = new THREE.BufferGeometry();
  bg.setAttribute('position', new THREE.Float32BufferAttribute(bank,3));
  bg.computeVertexNormals();
  scene.add(new THREE.Mesh(bg, toon(0x6f8a52)));

  // decks, piers and railings wherever a street crosses the water
  const deck = [], rail = [], pier = [];
  for (const st of STREETS) {
    const L = Math.hypot(st.bx-st.ax, st.bz-st.az) || 1;
    const ux = (st.bx-st.ax)/L, uz = (st.bz-st.az)/L, nx = -uz, nz = ux;
    const distAt = (d, o) =>
      Math.abs((st.az + uz*d + nz*o) - riverZ(st.ax + ux*d + nx*o));
    // Two kinds of bridge. The classic — ends on opposite banks — is built EXACTLY as
    // it always was: this block runs BEFORE the trees are planted, so its geometry has
    // to burn the seeded stream identically (see README). The meander clips — segments
    // that dip over the water and come back out on the same side, which the old test
    // missed entirely, leaving real water under real tarmac — are new geometry, built
    // inside rngNeutral so the town downstream is unmoved.
    const orig = (st.az - riverZ(st.ax)) * (st.bz - riverZ(st.bx)) < 0;
    let needs = orig;
    for (let d = 0; d <= L && !needs; d += 2)
      needs = distAt(d, 0) < RIVER_HW + 1.5 || distAt(d, st.w + 2.9) < RIVER_HW + 1.5 ||
              distAt(d, -st.w - 2.9) < RIVER_HW + 1.5;
    if (!needs) continue;
    // The generous span: the road *edge* over water counts too, so oblique clips are
    // covered. This feeds onBridge for every bridge; only the visuals stay per-kind.
    let glo = -1, ghi = -1;
    for (let d = 0; d <= L; d += 2) {
      const near = distAt(d, 0) < RIVER_HW + 13 || distAt(d, st.w + 3.8) < RIVER_HW + 13 ||
                   distAt(d, -st.w - 3.8) < RIVER_HW + 13;
      if (near) { if (glo < 0) glo = d; ghi = d; }
    }
    if (glo < 0) continue;
    const gl = Math.max(0, glo - 6), gh = Math.min(L, ghi + 6);
    // `soft` capsules carry onBridge coverage but leave the bank fence alone — a gap
    // there would change the fence collider pattern, which the tree filter feels,
    // and the audit baselines with it
    BRIDGES.push({ ax: st.ax+ux*gl, az: st.az+uz*gl, bx: st.ax+ux*gh, bz: st.az+uz*gh,
                   w: st.w + 3.8, soft: !orig });
    // footprints, not colliders — a hollow shop has no collider in its middle, but a
    // rail must still not run through the room (the fence learned this the hard way)
    const inFoot = (x, z) => {
      for (const mb of mapBoxes)
        if (Math.abs(x - mb.x) < mb.w/2 + 0.5 && Math.abs(z - mb.z) < mb.d/2 + 0.5) return true;
      return false;
    };
    const build = (lo, hi, dodge) => {
      const ax = st.ax+ux*lo, az = st.az+uz*lo, bx = st.ax+ux*hi, bz = st.az+uz*hi;
      // New-path geometry is normalised to non-indexed HERE, inside rngNeutral: merge()
      // calls toNonIndexed() per indexed entry at flush time, outside any snapshot, so
      // an indexed rail bar from a new bridge would burn randoms before the trees.
      const N = g => dodge ? g.toNonIndexed() : g;
      quad(deck, ax, az, bx, bz, st.w*2 + 7, 0.045);
      // Railings in short runs that skip anywhere another carriageway crosses — and on
      // the clip decks, buildings too. Highways get theirs from the guardrail pass.
      for (const sd of st.kind === 'highway' ? [] : [-1, 1]) {
        const rx = nx*(st.w+3)*sd, rz = nz*(st.w+3)*sd;   // a metre of shoulder before the rail
        const seg = 2.75;
        let runA = -1;
        for (let d = lo; d <= hi + seg; d += seg) {
          const px = st.ax+ux*d+rx, pz = st.az+uz*d+rz;
          const open2 = d > hi || onRoad(px, pz, 0.4) || (dodge && inFoot(px, pz));
          if (!open2 && runA < 0) runA = d;
          if (open2 && runA >= 0) {
            const runB = d - seg;
            if (runB > runA) {
              rail.push(N(baked(BOX(0.5, 1.5, runB-runA),
                st.ax+ux*(runA+runB)/2+rx, 0.9, st.az+uz*(runA+runB)/2+rz, 0, Math.atan2(ux, uz))));
              // the railing is a real barrier: without colliders a walker (or a glancing
              // car) passed straight through the leaf and off the deck. Collected here,
              // pushed to `colliders` after the scatter filters — this block precedes
              // the trees, and new colliders here would move the tree audit.
              // Sub-chunks much shorter than the visual runs: the collider list is
              // axis-aligned AABBs and every street here is slightly diagonal, so a
              // long chunk's box bulges past the rail and you hit an invisible wall
              // a metre before the leaf. ~0.9 m chunks inflated to the rail's own
              // half-width keep the stopping face on the railing itself.
              for (let q = runA; q < runB; q += 0.92) {
                const e2 = Math.min(q + 0.92, runB);
                const qx = st.ax+ux*q+rx, qz = st.az+uz*q+rz;
                const ex = st.ax+ux*e2+rx, ez = st.az+uz*e2+rz;
                railCols.push({ jump: 1.3, minX: Math.min(qx,ex)-0.25, maxX: Math.max(qx,ex)+0.25,
                                minZ: Math.min(qz,ez)-0.25, maxZ: Math.max(qz,ez)+0.25 });
              }
            }
            runA = -1;
          }
        }
        for (let d = lo; d <= hi; d += 5.5) {
          const px = st.ax+ux*d+rx, pz = st.az+uz*d+rz;
          if (!onRoad(px, pz, 0.4) && !(dodge && inFoot(px, pz)))
            rail.push(N(baked(BOX(0.5, 0.5, 0.5), px, 1.75, pz)));
        }
      }
      for (const t of [0.32, 0.68]) {
        const px = ax + (bx-ax)*t, pz = az + (bz-az)*t;
        if (dodge && inFoot(px, pz)) continue;
        // top at y=0, just under the road (0.05) and deck (0.045). Centred at -5.5 the
        // tops poked 0.5 above the tarmac — fine mid-river where nobody looked closely,
        // but the meander-clip decks run over dry streets, where they read as square
        // bumps sitting on the carriageway.
        pier.push(N(baked(BOX(4, 12, 5), px, -6.0, pz, 0, Math.atan2(ux, uz))));
      }
    };
    if (orig) {
      // the original centreline-only trim, so the classic bridges are burn-identical
      let lo = -1, hi = -1;
      for (let d = 0; d <= L; d += 2)
        if (overRiver(st.ax+ux*d, st.az+uz*d, 13)) { if (lo < 0) lo = d; hi = d; }
      if (lo < 0) continue;
      build(Math.max(0, lo - 6), Math.min(L, hi + 6), false);
    } else {
      rngNeutral(() => build(gl, gh, true));
    }
  }
  // A meander can reach a junction, leaving a pad with water beneath the wedges the
  // street decks don't cover. Give any wet junction a deck disc of its own — a
  // zero-length BRIDGES entry, which onBridge's clamped-t capsule treats as a circle.
  for (let i = 0; i < GN; i++) for (let j = 0; j < GN; j++) {
    const c = CORNER[i][j]; if (!c.deg) continue;
    let wet = Math.abs(c.z - riverZ(c.x)) < RIVER_HW + 1.5;
    for (let a = 0; a < 6.28 && !wet; a += 0.4)
      wet = Math.abs((c.z + Math.sin(a)*(ROAD_HW + 2)) - riverZ(c.x + Math.cos(a)*(ROAD_HW + 2))) < RIVER_HW + 1.5;
    if (!wet) continue;
    disc(deck, c.x, c.z, ROAD_HW + 4.8, 0.045);
    // the walk disc every junction draws is 16.5 across — here it overhangs the water,
    // so the capsule must reach past it or the visible pavement is a trapdoor
    BRIDGES.push({ ax: c.x, az: c.z, bx: c.x + 0.01, bz: c.z, w: ROAD_HW + 10.5, soft: true });
  }
  surface(deck, null, toon(0x6a6478));
  if (rail.length) { const m = new THREE.Mesh(merge(rail), toon(0xe4e7ea)); m.castShadow = true; scene.add(m); }
  if (pier.length) scene.add(new THREE.Mesh(merge(pier), toon(0x8b929a)));
}

// =================================================================
//  BARRIERS
//  Nothing wanders into the water by accident and nothing drives off the
//  highway: a white park fence runs along both banks (broken at the bridges),
//  and metal guardrails line both sides of every highway — which, since the
//  highway is a closed ring, makes it the playable world's perimeter.
//  All rngNeutral, so the seeded town is untouched.
// =================================================================
rngNeutral(() => {
  // ---- riverside fence: at the top of the bank, both sides ----
  const fence = [], fpost = [];
  const FLIM = TOWN + 260, FSTEP = 5, FOFF = RIVER_HW + 11.8;
  const nearBridge = (x, z) => {
    for (const b of BRIDGES) {
      if (b.soft) continue;            // new coverage capsules don't re-shape the fence
      const dx = b.bx-b.ax, dz = b.bz-b.az, L2 = dx*dx + dz*dz || 1;
      let t = ((x-b.ax)*dx + (z-b.az)*dz) / L2; t = Math.max(0, Math.min(1, t));
      if (Math.hypot(x-(b.ax+dx*t), z-(b.az+dz*t)) < b.w + 3.2) return true;
    }
    return false;
  };
  for (const sd of [-1, 1]) {
    for (let x = -FLIM; x < FLIM; x += FSTEP) {
      const x2 = x + FSTEP;
      const za = riverZ(x) + sd*FOFF, zb = riverZ(x2) + sd*FOFF;
      const mx = (x+x2)/2, mz = (za+zb)/2;
      // gaps where a bridge carries a road through, and never on a carriageway
      // gaps at bridges, on carriageways, and through buildings — a shop standing on
      // the bank IS the barrier there. Footprints, not colliders: a hollow shop has no
      // collider in its middle, but the fence must still not run through the room.
      if (nearBridge(mx, mz) || onRoad(mx, mz, 0.6)) continue;
      let inBuilding = false;
      for (const mb of mapBoxes) {
        const hw2 = mb.w/2 + 0.5, hd2 = mb.d/2 + 0.5;
        // the whole chunk must clear the footprint, not just its midpoint
        if ((Math.abs(mx - mb.x) < hw2 && Math.abs(mz - mb.z) < hd2) ||
            (Math.abs(x  - mb.x) < hw2 && Math.abs(za - mb.z) < hd2) ||
            (Math.abs(x2 - mb.x) < hw2 && Math.abs(zb - mb.z) < hd2)) { inBuilding = true; break; }
      }
      if (inBuilding) continue;
      const len = Math.hypot(FSTEP, zb-za) + 0.2, yaw = Math.atan2(FSTEP, zb-za);
      // Build first, discard after: the geometry has to be created either way or the
      // seeded stream shifts and the whole town re-rolls (same lesson as lastPut).
      const g1 = baked(BOX(0.13, 0.13, len), mx, 0.52, mz, 0, yaw);
      const g2 = baked(BOX(0.13, 0.13, len), mx, 0.96, mz, 0, yaw);
      const g3 = baked(BOX(0.2, 1.08, 0.2), x, 0.54, za);
      // The midpoint test above is not enough: a 5 m chunk can straddle a kerb with
      // its centre on the grass, which laid rails straight across the crossings. The
      // WHOLE chunk has to clear the carriageway — same lesson the building test learned.
      if (onRoad(x, za, 1.4) || onRoad(x2, zb, 1.4) || onRoad(mx, mz, 1.4)) continue;
      fence.push(g1, g2);
      fpost.push(g3);
      colliders.push({ minX: x - 0.3, maxX: x2 + 0.3,
                       minZ: Math.min(za, zb) - 0.3, maxZ: Math.max(za, zb) + 0.3, jump: 1.3 });
    }
  }
  if (fence.length) {
    const m = new THREE.Mesh(merge(fence.concat(fpost)), toon(0xf2f2ee));
    m.castShadow = true; m.receiveShadow = true; scene.add(m);
  }

  // ---- highway guardrails: an Armco band down both sides of every segment ----
  const band = [], gpost = [];
  for (const st of STREETS) {
    if (st.kind !== 'highway') continue;
    const L = Math.hypot(st.bx-st.ax, st.bz-st.az) || 1;
    const ux = (st.bx-st.ax)/L, uz = (st.bz-st.az)/L, nx = -uz, nz = ux;
    const off = st.w + 3.1, yaw = Math.atan2(ux, uz);   // a metre of shoulder before the rail
    // short chunks so the axis-aligned colliders hug the rail even on diagonals
    for (let d = 0; d < L; d += 3.5) {
      const e = Math.min(d + 3.5, L), mid = (d+e)/2;
      for (const sd of [-1, 1]) {
        const px = st.ax + ux*mid + nx*off*sd, pz = st.az + uz*mid + nz*off*sd;
        if (onRoad(px, pz, 0.5)) continue;         // gaps where the spurs and streets join
        band.push(baked(BOX(0.26, 0.36, e-d+0.3), px, 0.58, pz, 0, yaw));
        if (((d/3.5)|0) % 2 === 0)
          gpost.push(baked(BOX(0.16, 0.6, 0.16), st.ax+ux*d + nx*off*sd, 0.3, st.az+uz*d + nz*off*sd));
        const ax = st.ax+ux*d + nx*off*sd, az = st.az+uz*d + nz*off*sd;
        const bx = st.ax+ux*e + nx*off*sd, bz = st.az+uz*e + nz*off*sd;
        colliders.push({ minX: Math.min(ax,bx)-0.35, maxX: Math.max(ax,bx)+0.35,
                         minZ: Math.min(az,bz)-0.35, maxZ: Math.max(az,bz)+0.35, jump: 1.0 });
      }
    }
  }
  if (band.length) {
    const m = new THREE.Mesh(merge(band), toon(0xc9ccd2));
    m.castShadow = true; m.receiveShadow = true; scene.add(m);
    const p = new THREE.Mesh(merge(gpost), toon(0x8b929a));
    p.castShadow = true; scene.add(p);
  }
});

// the hill the highway tunnels through, out past the north-east edge
const TUNNEL = { x: 0, z: 0, ux: 1, uz: 0, len: 120 };
{
  // put the bore on the stretch furthest from the water, so the hill never lands on a
  // viaduct now that the highway is a closed ring crossing the river twice
  let bi = 0, bd = -1;
  HIGHWAY.forEach((h, i) => { const d = Math.abs(h.z - riverZ(h.x)); if (d > bd) { bd = d; bi = i; } });
  const N = HIGHWAY.length;
  const mid = HIGHWAY[bi];
  const nxt = HIGHWAY[(bi+1) % N], nxt2 = HIGHWAY[(bi+2) % N];
  const prev = HIGHWAY[(bi-1+N) % N], prev2 = HIGHWAY[(bi-2+N) % N];
  const L = Math.hypot(nxt.x-mid.x, nxt.z-mid.z) || 1;
  TUNNEL.x = mid.x; TUNNEL.z = mid.z; TUNNEL.ux = (nxt.x-mid.x)/L; TUNNEL.uz = (nxt.z-mid.z)/L;
  // The mountain is a deterministic ridge of ellipsoid lobes flanking and capping the
  // road — no rnd, so the tunnel never reshuffles anything downstream again. The bore
  // through it is REAL: a lit, open-ended vault you can see down from mouth to mouth,
  // not a black box. Lobes may dip into the corridor, but the vault walls occlude them.
  const lat = { x: TUNNEL.uz, z: -TUNNEL.ux };          // perpendicular to the bore
  // NOTHING organic may cross the bore corridor: an ellipsoid that straddles the road
  // inevitably dips its tapering tail inside the tube near the mouths, which reads as
  // a green wall while driving through. So the mass OVER the road is angular with a
  // guaranteed-clear underside (a prism cap whose base sits above the vault crown, on
  // flank walls that stop outside the tube); the soft lobes are only outboard shoulders.
  const yawR = Math.atan2(TUNNEL.ux, TUNNEL.uz);
  const loS = -55, hiS = 55;
  const hill = [];
  // The hill is built on ONE straight axis while the bore follows the ring's bend,
  // so the mass that clears the middle can still lean over a mouth at the ends —
  // which is exactly what left one portal half-buried. Everything is pulled shorter
  // along the bore and wider across it, carving both mouths open. Object count and
  // colour are unchanged, so the seeded stream is untouched.
  hill.push(baked(roofPrism(58, 24, 92), mid.x, 14, mid.z, 0, yawR));        // summit cap
  hill.push(baked(roofPrism(92, 12, 78), mid.x, 14, mid.z, 0, yawR));        // wide brim
  for (const sd of [-1, 1]) {                                                // flank walls
    hill.push(baked(BOX(30, 14.6, 88), mid.x + lat.x*sd*35, 7.2, mid.z + lat.z*sd*35, 0, yawR));
    hill.push(baked(new THREE.SphereGeometry(24, 16, 12).scale(1, 0.62, 1),   // soft shoulders
      mid.x + TUNNEL.ux*sd*10 + lat.x*sd*48, -2, mid.z + TUNNEL.uz*sd*10 + lat.z*sd*48));
    hill.push(baked(new THREE.SphereGeometry(19, 16, 12).scale(1, 0.55, 1),
      mid.x - TUNNEL.ux*sd*34 + lat.x*sd*42, -2, mid.z - TUNNEL.uz*sd*34 + lat.z*sd*42));
  }
  const hm = new THREE.Mesh(merge(hill),
    new THREE.MeshToonMaterial({ color: 0x5f9a4a, gradientMap: RAMP, side: THREE.DoubleSide }));
  hm.castShadow = true; hm.receiveShadow = true; scene.add(hm);
  TUNNEL.len = hiS - loS;
  // walk the road polyline to a station (mid=0, positive toward nxt), because the
  // ring bends: a point measured along the straight axis drifts off the carriageway
  const Lp = Math.hypot(mid.x-prev.x, mid.z-prev.z) || 1;
  const station = s => {
    let a = mid, b = nxt, d = s;
    if (s < 0) { a = mid; b = prev; d = -s; }
    let l = Math.hypot(b.x-a.x, b.z-a.z) || 1;
    if (d > l) { const c = s < 0 ? prev2 : nxt2; d -= l; a = b; b = c; l = Math.hypot(b.x-a.x, b.z-a.z) || 1; }
    const ux2 = (b.x-a.x)/l, uz2 = (b.z-a.z)/l;
    return { x: a.x + ux2*d, z: a.z + uz2*d,
             yaw: Math.atan2(s < 0 ? -ux2 : ux2, s < 0 ? -uz2 : uz2) };
  };
  // the vault: two open-ended half-cylinder shells, one per road segment, overlapping
  // under the summit so the curving carriageway never leaves the tube. BackSide, so
  // the walls are what you see from inside — and daylight shows at the far mouth.
  const vaultMat = new THREE.MeshToonMaterial({ color: 0x8b8378, gradientMap: RAMP, side: THREE.DoubleSide });
  const dirA = { x: (prev.x-mid.x)/Lp, z: (prev.z-mid.z)/Lp };
  const lenA = 6 - loS, cA = (-loS + 2)/2 - 2;           // covers stations loS-2 .. 4
  const lenB = hiS + 6, cB = (hiS - 2)/2;                // covers stations -4 .. hiS+2
  for (const [dx2, dz2, len, c] of [[dirA.x, dirA.z, lenA, -((loS + 2)/2) * 1 + 0], [TUNNEL.ux, TUNNEL.uz, lenB, cB]]) {
    const cx2 = mid.x + dx2*Math.abs(c), cz2 = mid.z + dz2*Math.abs(c);
    const v = new THREE.Mesh(
      // yaw goes in the rz slot: after rx tips the cylinder's length axis horizontal,
      // rz is what swings it around to follow the road (same trick as the arch rings)
      baked(new THREE.CylinderGeometry(13.5, 13.5, len, 16, 1, true, Math.PI/2, Math.PI), 0, 0, 0, Math.PI/2, 0, Math.atan2(dx2, dz2)),
      vaultMat);
    v.position.set(cx2, 0, cz2);
    scene.add(v);
  }
  // lamps down the crown, so the inside reads as a lit road tunnel
  const lampGeo = [];
  for (let s = Math.ceil((loS + 6)/13)*13; s <= hiS - 4; s += 13) {
    const p = station(s);
    lampGeo.push(baked(BOX(1.4, 0.3, 0.7), p.x, 12.1, p.z, 0, p.yaw));
  }
  if (lampGeo.length) scene.add(new THREE.Mesh(merge(lampGeo), new THREE.MeshBasicMaterial({ color: 0xfff0b8 })));
  // a portal at each end: arch ring plus a rock facade with the opening punched out,
  // so the mouth is a wall with a hole — not a road vanishing into a hillside
  const mouths = [station(loS - 3), station(hiS + 3)];
  const bore = [];
  for (const m of mouths) {
    const mx = { x: Math.cos(m.yaw), z: -Math.sin(m.yaw) };          // facade's lateral
    // a RING around the opening, not a capped half-cylinder: the caps of the old
    // arch were solid half-discs that plugged both mouths from the outside
    bore.push(baked(new THREE.TorusGeometry(13.8, 2.4, 8, 14, Math.PI), m.x, 0, m.z, 0, m.yaw));
    for (const sd of [-1, 1])
      bore.push(baked(BOX(14, 24, 2.2), m.x + mx.x*19*sd, 12, m.z + mx.z*19*sd, 0, m.yaw));
    bore.push(baked(BOX(52, 10, 2.2), m.x, 19, m.z, 0, m.yaw));
  }
  const pm = new THREE.Mesh(merge(bore), toon(0x8b8378));
  pm.castShadow = true; pm.receiveShadow = true; scene.add(pm);
}


// =================================================================
//  SET PIECES
//  The things you navigate by: a giant donut, a water tower, the
//  hillside sign, and a blimp that never lands.
// =================================================================
const blimps = [];
{
  const shopAt = n => shopSpots.find(s => s.name === n);

  // ---- Lard Lad's colossal donut, up on its pole ----
  const lard = shopAt('BIG DONUT');
  if (lard) {
    const px = lard.cx + lard.fx*(lard.d/2 + 11), pz = lard.cz + lard.fz*(lard.d/2 + 11);
    if (!footprintClash(px, pz, 3, 3, 0, 0.5) && !footprintOnRoad(px, pz, 3, 3, 0, 1.0)) {
    put(0x6b6f76, baked(BOX(1.6, 20, 1.6), px, 10, pz));
    put(0xe8c07a, baked(new THREE.TorusGeometry(6.4, 3.0, 12, 22), px, 24, pz, 0, lard.yaw));
    put(0xf07ab0, baked(new THREE.TorusGeometry(6.5, 2.75, 12, 22), px, 24.8, pz, 0, lard.yaw));
    for (let k = 0; k < 26; k++) {                            // sprinkles
      const a = prng()*Math.PI*2, rr = 6.5 + rnd(-1.6, 1.6);
      put(rpick([0xffffff, 0x8ad14f, 0x3fa9d8, 0xffd23b]),
        baked(BOX(0.85, 0.28, 0.28), px + Math.cos(a)*rr, 27.4, pz + Math.sin(a)*rr, 0, prng()*3));
    }
    addBox(px, pz, 3, 3, 'sign');
    }
  }

  // ---- the Krusty Burger head sign ----
  const krusty = shopAt('BURGER BARON');
  if (krusty) {
    const px = krusty.cx + krusty.fx*(krusty.d/2 + 9), pz = krusty.cz + krusty.fz*(krusty.d/2 + 9);
    if (!footprintClash(px, pz, 3, 3, 0, 0.5) && !footprintOnRoad(px, pz, 3, 3, 0, 1.0)) {
    put(0x6b6f76, baked(BOX(1.4, 16, 1.4), px, 8, pz));
    put(0xf7f1e0, baked(new THREE.SphereGeometry(4.6, 16, 12), px, 20, pz));            // white face
    for (const s2 of [-1, 1])                                                            // green hair
      put(0x3fbf6f, baked(new THREE.SphereGeometry(2.6, 16, 12), px + s2*4.2, 22.4, pz));
    put(0xe8402f, baked(new THREE.SphereGeometry(1.5, 16, 12), px, 19.4, pz + krusty.fz*4.2 + krusty.fx*4.2));
    addBox(px, pz, 3, 3, 'sign');
    }
  }

  // ---- water tower ----
  {
    // It used to drop on the first park block's centre with no clearance test at all,
    // which holds up only until a neighbour's footprint reaches into that block — the
    // Nuclear Plant's cooling towers sit 16 m off its own centre and do exactly that.
    // Search the greens for a spot that actually clears. No prng() draws and the same
    // number of put() calls either way, so the seeded stream is untouched.
    const parks = BLOCKS.filter(b => b.zone === 'park' || b.zone === 'plaza');
    let wx = 0, wz = 0, placed = false;
    for (const b of parks.length ? parks : BLOCKS) {
      for (const [ox, oz] of [[0,0],[-14,0],[14,0],[0,-14],[0,14],[-16,-16],[16,16],[-16,16],[16,-16]]) {
        const x = b.cx + ox, z = b.cz + oz;
        if (footprintClash(x, z, 14, 14, 0, 1) || footprintOnRoad(x, z, 14, 14, 0, 1.5)) continue;
        wx = x; wz = z; placed = true; break;
      }
      if (placed) break;
    }
    if (!placed) { const b = parks[0] || BLOCKS[0]; wx = b.cx; wz = b.cz; }
    for (const [ox, oz] of [[-5,-5],[5,-5],[-5,5],[5,5]])
      put(0x8b929a, baked(BOX(1.0, 20, 1.0), wx+ox, 10, wz+oz, ox*0.012, 0, -oz*0.012));
    put(0xd8dde4, baked(new THREE.CylinderGeometry(8.5, 8.5, 11, 16), wx, 25, wz));
    put(0xd8dde4, baked(new THREE.ConeGeometry(9, 5, 16), wx, 33, wz));
    put(0xb9bfc7, baked(new THREE.ConeGeometry(9, 4, 16), wx, 17.5, wz, Math.PI));
    addBox(wx, wz, 12, 12, 'tower');
    nameBoard(wx, wz - 8.7, 25, Math.PI, 15, 'MAPLEWOOD', '#d8dde4', '#2f5fb0');
  }


  // ---- MAPLEWOOD spelled out on the hillside ----
  {
    const hx = -TOWN*0.35, hz = -TOWN - 300;
    const t = signTexture('MAPLEWOOD', 'rgba(0,0,0,0)', '#f2f2ee', 1024, 200);
    const board = new THREE.Mesh(new THREE.PlaneGeometry(220, 43),
      new THREE.MeshBasicMaterial({ map: t, transparent: true, side: THREE.FrontSide }));
    board.position.set(hx, 46, hz); board.rotation.x = -0.18; scene.add(board);
  }

  // ---- Duff blimp, drifting forever ----
  {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(9, 18, 12), toon(0xe8e3d3));
    body.scale.set(2.4, 1, 1); g.add(body);
    for (const s2 of [-1, 1]) {
      const fin = new THREE.Mesh(BOX(5, 0.6, 7), toon(0xc0392b));
      fin.position.set(-18, 0, s2*3.4); fin.rotation.y = s2*0.35; g.add(fin);
    }
    const fin2 = new THREE.Mesh(BOX(5, 7, 0.6), toon(0xc0392b));
    fin2.position.set(-18, 4, 0); g.add(fin2);
    const gondola = new THREE.Mesh(BOX(7, 3, 3.6), toon(0x2f3550));
    gondola.position.set(0, -9, 0); g.add(gondola);
    for (const s2 of [-1, 1]) {
      const label = new THREE.Mesh(new THREE.PlaneGeometry(22, 9),
        new THREE.MeshBasicMaterial({ map: signTexture('BREW', '#e8b53f', '#c0392b', 256, 128), transparent: true, side: THREE.DoubleSide }));
      label.position.set(0, 0.5, s2*9.1); label.rotation.y = s2 > 0 ? 0 : Math.PI; g.add(label);
    }
    g.position.set(0, 120, 0); scene.add(g);
    blimps.push({ g, t: 0, r: TOWN*0.75, h: 120, spd: 0.055 });
  }
}

// Every building part is now generated, so flush each colour bucket into a single mesh.
// This has to happen after the billboards, which also contribute geometry.
for (const [, b] of BUCKETS) {
  if (!b.list.length) continue;
  const geo = merge(b.list);
  if (b.kind && SURFACES[b.kind].tex) projectUV(geo, SURFACES[b.kind].scale);
  const m = new THREE.Mesh(geo, b.kind ? surfMat(b.color, b.kind) : toon(b.color));
  m.castShadow = true; m.receiveShadow = true; scene.add(m);
}

// =================================================================
//  TREES · HEDGES · PROPS · COINS
// =================================================================
// perimeter woodland so the town sits in a valley
for (let i = 0; i < 1600; i++) {
  const a = prng()*Math.PI*2, r = rnd(TOWN + 30, TOWN + 950);
  const x = Math.cos(a)*r, z = Math.sin(a)*r;
  if (Math.abs(z - riverZ(x)) < RIVER_HW + 14) continue;      // not in the water
  treeSpots.push({ x, z, s: rnd(1.1, 2.2) });
}
// rolling hills on the horizon
{
  const hills = [];
  for (let i = 0; i < 30; i++) {
    const a = prng()*Math.PI*2, r = rnd(TOWN+1450, TOWN+2050), rad = rnd(140, 290);
    const hx = Math.cos(a)*r, hz = Math.sin(a)*r;
    hills.push(baked(new THREE.SphereGeometry(rad, 16, 12), hx, groundH(hx,hz) - rad*0.42, hz));
  }
  const m = new THREE.Mesh(merge(hills), toon(0x69a955)); m.receiveShadow = true; scene.add(m);
}
{
  // ~1,650 of these, and they cover more screen than anything else in the game, so
  // this is where detail pays best — but also where it costs most, and the canopy is
  // ink-outlined, which doubles it. Five lobes at 14x10 reads as a full crown from the
  // car without the vertex bill of a sphere-per-branch. A couple of roots flare the
  // trunk so it grows out of the ground rather than being stuck into it.
  const trunk = merge([
    baked(new THREE.CylinderGeometry(0.3, 0.46, 3.2, 14), 0, 1.6, 0),
    baked(new THREE.CylinderGeometry(0.5, 0.72, 0.5, 14), 0, 0.2, 0),
    baked(new THREE.CylinderGeometry(0.2, 0.3, 1.5, 8), 0.5, 3.0, 0.2, 0, 0, -0.5),
  ]);
  const leaf = merge([
    baked(new THREE.SphereGeometry(2.65, 14, 10), 0, 5.3, 0),
    baked(new THREE.SphereGeometry(1.95, 14, 10), 1.75, 4.3, 0.6),
    baked(new THREE.SphereGeometry(1.75, 14, 10), -1.55, 4.45, -0.85),
    baked(new THREE.SphereGeometry(1.5, 12, 9), 0.35, 6.5, -1.15),
    baked(new THREE.SphereGeometry(1.35, 12, 9), -0.9, 5.6, 1.4),
  ]);
  const LEAFC = [0x3f8f3a, 0x4aa044, 0x357f33, 0x56aa4a];
  // nothing scattered may sit on a carriageway, whatever placed it
  {
    // no trees on or in the tunnel mountain: it has no colliders, so the woodland
    // belt otherwise plants straight through it — trunks buried in the lobes, canopies
    // dangling inside the bore
    const nearTunnel = (x, z) => {
      const hx = TUNNEL.ux*(TUNNEL.len/2 + 12), hz = TUNNEL.uz*(TUNNEL.len/2 + 12);
      const ax = TUNNEL.x - hx, az = TUNNEL.z - hz, dx = 2*hx, dz = 2*hz;
      const L2 = dx*dx + dz*dz || 1;
      const tt = Math.max(0, Math.min(1, ((x - ax)*dx + (z - az)*dz) / L2));
      return Math.hypot(x - (ax + dx*tt), z - (az + dz*tt)) < 62;
    };
    const keep = treeSpots.filter(t => !onRoad(t.x, t.z, 2.5) && !pointBlocked(t.x, t.z, 1.2) && !nearTunnel(t.x, t.z));
    console.log(`trees: ${keep.length} planted, ${treeSpots.length - keep.length} removed from roads and buildings`);
    treeSpots.length = 0; treeSpots.push(...keep);
  }
  const tr = instanced(trunk, toon(0x7a5230), treeSpots.length);
  const lv = instanced(leaf, new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: RAMP }), treeSpots.length);
  const col = new THREE.Color();
  treeSpots.forEach((t, i) => {
    dummy.position.set(t.x, groundH(t.x, t.z), t.z); dummy.rotation.set(0, prng()*6.28, 0);
    dummy.scale.setScalar(t.s); dummy.updateMatrix();
    tr.setMatrixAt(i, dummy.matrix); lv.setMatrixAt(i, dummy.matrix);
    lv.setColorAt(i, col.setHex(rpick(LEAFC)));
  });
  tr.instanceMatrix.needsUpdate = true; lv.instanceMatrix.needsUpdate = true;
  scene.add(tr, lv);
}
{
  const hk = hedges.filter(h => !onRoad(h.x, h.z, 1.6) && !pointBlocked(h.x, h.z, 0.6));
  hedges.length = 0; hedges.push(...hk);
}
if (hedges.length) {
  const hg = instanced(new THREE.SphereGeometry(1, 16, 12).translate(0, 0.6, 0), toon(0x3f8f4a), hedges.length);
  hedges.forEach((h, i) => {
    dummy.position.set(h.x, 0, h.z); dummy.rotation.set(0, prng()*6.28, 0);
    dummy.scale.set(h.r*1.5, h.r, h.r*1.5); dummy.updateMatrix();
    hg.setMatrixAt(i, dummy.matrix);
  });
  hg.instanceMatrix.needsUpdate = true; scene.add(hg);
}

// street furniture along the sidewalks
for (const st of STREETS) {
  if (st.kind === 'highway') continue;
  const L = Math.hypot(st.bx-st.ax, st.bz-st.az);
  const ux = (st.bx-st.ax)/L, uz = (st.bz-st.az)/L, nx = -uz, nz = ux;
  for (let d = 20; d < L-20; d += 25) {
    for (const side of [1,-1]) {
      const off = st.w + 2.6;
      propSpots.push({
        x: st.ax + ux*d + nx*side*off, z: st.az + uz*d + nz*side*off,
        kind: prng()<0.4 ? 'lamp' : (prng()<0.5 ? 'hydrant' : 'bin'),
      });
    }
  }
}
const PROP_DEFS = {
  lamp:    { parts:[[0x6b6f76, BOX(0.35,7,0.35), 0,3.5,0], [0x6b6f76, BOX(2.4,0.3,0.3), 1.0,6.9,0],
                    [0xfff0b8, BOX(1.1,0.4,0.6), 1.9,6.6,0]], mass:6, radius:0.4 },
  hydrant: { parts:[[0xd0392b, new THREE.CylinderGeometry(0.34, 0.42, 1.15, 16), 0,0.58,0],
                    [0xd0392b, new THREE.SphereGeometry(0.36, 16, 12), 0,1.2,0],
                    [0xd0392b, new THREE.CylinderGeometry(0.16, 0.16, 1.0, 16), 0,0.75,0, 0,0,Math.PI/2]], mass:2.4, radius:0.5 },
  bin:     { parts:[[0x3f6b4a, new THREE.CylinderGeometry(0.55, 0.48, 1.5, 20), 0,0.75,0],
                    [0x2f5238, new THREE.CylinderGeometry(0.62, 0.62, 0.18, 20), 0,1.6,0]], mass:1.5, radius:0.6 },
  mailbox: { parts:[[0x2f6fc4, BOX(0.8,0.75,1.1), 0,1.6,0],
                    [0x2f6fc4, new THREE.CylinderGeometry(0.4, 0.4, 1.1, 20, 1, false, 0, Math.PI), 0,1.98,0, 0,0,Math.PI/2],
                    [0x4a4f58, BOX(0.18,1.3,0.18), 0,0.65,0]], mass:2, radius:0.6 },
  bench:   { parts:[[0x8c5a34, BOX(3.0,0.22,0.9), 0,0.85,0], [0x8c5a34, BOX(3.0,0.9,0.2), 0,1.4,-0.35],
                    [0x4a4f58, BOX(0.2,0.85,0.8), -1.3,0.42,0], [0x4a4f58, BOX(0.2,0.85,0.8), 1.3,0.42,0]], mass:4, radius:1.2 },
};
const props = [], propMeshes = [];
const PROP_Q = 14, propGrid = new Map();
const propKey = p => Math.floor(p.x/PROP_Q) + ',' + Math.floor(p.z/PROP_Q);
function propGridAdd(p) { p.cell = propKey(p); let b = propGrid.get(p.cell); if (!b) propGrid.set(p.cell, b=[]); b.push(p); }
function propGridRemove(p) { const b = propGrid.get(p.cell); if (!b) return; const i = b.indexOf(p); if (i>=0) b.splice(i,1); }
function writeProp(p) {
  dummy.position.set(p.x, p.y, p.z); dummy.rotation.set(p.rx, p.ry, p.rz);
  dummy.scale.set(1,1,1); dummy.updateMatrix();
  for (const m of p.meshes) m.setMatrixAt(p.i, dummy.matrix);
}
{
  const placed = propSpots.filter(s => !pointBlocked(s.x, s.z, 0.8) && !onRoad(s.x, s.z, 0.8));
  propSpots.length = 0; propSpots.push(...placed);
  const byKind = {};
  for (const s of propSpots) (byKind[s.kind] = byKind[s.kind] || []).push(s);
  for (const kind in byKind) {
    const def = PROP_DEFS[kind], list = byKind[kind];
    const byCol = new Map();
    for (const [col, geo, x, y, z, rx, ry, rz] of def.parts) {
      const g = baked(geo, x, y, z, rx, ry, rz);
      let b = byCol.get(col); if (!b) byCol.set(col, b=[]); b.push(g);
    }
    const meshes = [];
    for (const [col, geos] of byCol) {
      const m = instanced(merge(geos), toon(col), list.length);
      m.count = list.length; scene.add(m); meshes.push(m); propMeshes.push(m);
    }
    list.forEach((s, i) => {
      const p = { meshes, i, kind, x:s.x, y:0, z:s.z, rx:0, ry:prng()*6.28, rz:0,
        vx:0, vy:0, vz:0, spin:new THREE.Vector3(), static:true,
        mass:def.mass, radius:def.radius, rest:0.3 };
      writeProp(p); propGridAdd(p); props.push(p);
    });
    for (const m of meshes) m.instanceMatrix.needsUpdate = true;
  }
}
function updateProps(dt) {
  let dirty = false;
  for (const p of props) {
    if (p.static) continue;
    p.vy -= 30*dt;
    p.x += p.vx*dt; p.y += p.vy*dt; p.z += p.vz*dt;
    p.rx += p.spin.x*dt; p.ry += p.spin.y*dt; p.rz += p.spin.z*dt;
    if (p.y <= p.rest) {
      p.y = p.rest; if (p.vy < 0) p.vy *= -0.3;
      p.vx *= 0.7; p.vz *= 0.7; p.spin.multiplyScalar(0.6);
      if (Math.hypot(p.vx, p.vz) < 0.5 && Math.abs(p.vy) < 0.6) { p.static = true; propGridAdd(p); }
    }
    writeProp(p); dirty = true;
  }
  if (dirty) for (const m of propMeshes) m.instanceMatrix.needsUpdate = true;
}
function hitPropsAt(x, z, dx, dz, speed, radius, maxMass) {
  const s = Math.min(Math.abs(speed), 45);
  const gx = Math.floor(x/PROP_Q), gz = Math.floor(z/PROP_Q);
  for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
    const b = propGrid.get((gx+ox)+','+(gz+oz)); if (!b) continue;
    for (let n = b.length-1; n >= 0; n--) {
      const p = b[n];
      if (!p.static || (maxMass && p.mass > maxMass)) continue;
      const ex = p.x-x, ez = p.z-z, rr = radius + p.radius;
      if (ex*ex + ez*ez > rr*rr) continue;
      const power = (s - p.mass*0.8) / p.mass;
      if (power < 0.4) continue;
      const len = Math.hypot(dx,dz)||1, k = Math.min(power, 9);
      p.static = false; propGridRemove(p);
      p.vx = dx/len*k*1.6 + rnd(-1,1); p.vz = dz/len*k*1.6 + rnd(-1,1); p.vy = 2.5 + k;
      p.spin.set(rnd(-4,4), rnd(-4,4), rnd(-4,4));
      burst(p.x, 0.8, p.z, 0xffe27a, 5);
      addCoins(1); shake = Math.min(1.2, shake + 0.2); chaosHit(4);
      // a knocked bin spills its change — the small reason to clip every one you pass
      if (p.kind === 'bin') burstCoins(p.x, p.z, 2 + ((Math.random()*3)|0));
      dingSfx();
    }
  }
}

// Coins in shapes, not just scatter.
//
// The block loop drops a handful into every landmark and yard, which is fine but reads
// as confetti: nothing about where a coin sits tells you anything. These are the ones
// that do — a ring round a tree you can circle, and a run down the middle of a street
// you can take at speed in one pass. The scattered ones stay exactly as they were, and
// deliberately so: they are placed during the block loop, and changing how many randoms
// that loop draws would re-roll the whole town.
//
// This runs after the tree stage, so treeSpots is already filtered down to the trees
// that actually exist, and after every canary is computed — which is why it can draw
// from the seeded stream freely.
{
  // RINGS — a wide spread of trees rather than a clump, so they read as landmarks
  const ringed = [];
  for (const t of treeSpots) {
    if (ringed.length >= 10) break;
    if (ringed.some(o => (o.x-t.x)**2 + (o.z-t.z)**2 < 150*150)) continue;
    ringed.push(t);
  }
  for (const t of ringed) {
    const n = 8, r = 3.6, off = rnd(0, 6.28);
    for (let k = 0; k < n; k++) {
      const a = off + k*Math.PI*2/n;
      coinsSpots.push({ x: t.x + Math.cos(a)*r, z: t.z + Math.sin(a)*r });
    }
  }
  // ROWS — straight down the carriageway. Not filtered against onRoad on purpose: the
  // whole point is that you collect the run in one pass without leaving the road.
  const town = STREETS.filter(st => st.kind !== 'highway');
  for (let i = 0; i < town.length; i += Math.max(1, (town.length/12)|0)) {
    const st = town[i];
    const L = Math.hypot(st.bx-st.ax, st.bz-st.az);
    if (L < 60) continue;
    const ux = (st.bx-st.ax)/L, uz = (st.bz-st.az)/L;
    const n = 7, gap = 3.6, d0 = (L - (n-1)*gap)/2;      // centred on the street
    for (let k = 0; k < n; k++) {
      const d = d0 + k*gap;
      coinsSpots.push({ x: st.ax + ux*d, z: st.az + uz*d });
    }
  }
}

// spinning collectible coins
const coins = [], LOOSE_MAX = 90;
let PLACED = 0, looseNext = 0;
{
  const reachable = coinsSpots.filter(c => !pointBlocked(c.x, c.z, 0.8));
  coinsSpots.length = 0; coinsSpots.push(...reachable);
  const geo = new THREE.CylinderGeometry(0.62, 0.62, 0.14, 20).rotateX(Math.PI/2);
  // Placed coins first, then a fixed pool of loose ones on the end. Loose coins are the
  // ones that burst out of a crate or a bin: same mesh, same collect loop, but they
  // arrive with a velocity and land. The pool is fixed and recycled round-robin so the
  // instance count never changes — the alternative is growing the buffer mid-game.
  const mesh = instanced(geo, toon(0xffd23b), coinsSpots.length + LOOSE_MAX, false);
  coinsSpots.forEach((c, i) => coins.push({ x:c.x, z:c.z, got:false, i }));
  PLACED = coins.length;
  for (let k = 0; k < LOOSE_MAX; k++)
    coins.push({ x:0, y:0, z:0, got:true, loose:true, vx:0, vy:0, vz:0, life:0, i: coins.length });
  mesh.count = coins.length;
  scene.add(mesh);
  var coinMesh = mesh;
}
// Pop a coin out of something, with a bit of upward and a bit of sideways.
function spawnCoin(x, y, z, vx, vy, vz) {
  const c = coins[PLACED + (looseNext++ % LOOSE_MAX)];
  c.x = x; c.y = y; c.z = z; c.vx = vx; c.vy = vy; c.vz = vz;
  c.life = 14; c.got = false;
}
function burstCoins(x, z, n) {
  for (let k = 0; k < n; k++) {
    const a = Math.random()*6.28, sp = 1.6 + Math.random()*2.6;
    spawnCoin(x, 1.0, z, Math.cos(a)*sp, 5.5 + Math.random()*3.2, Math.sin(a)*sp);
  }
}
let coinSpin = 0;
function updateCoins(dt, sub) {
  coinSpin += dt*2.4;
  for (const c of coins) {
    if (c.got) { dummy.scale.setScalar(0); dummy.position.set(c.x, -20, c.z); dummy.rotation.set(0,0,0); }
    else {
      let y;
      if (c.loose) {
        c.life -= dt;
        if (c.life <= 0) { c.got = true; continue; }
        const g = surfaceY(c.x, c.z);
        c.vy -= 20*dt; c.y += c.vy*dt; c.x += c.vx*dt; c.z += c.vz*dt;
        if (c.y <= g + 1.0) {                       // settle at the same height as a placed one
          c.y = g + 1.0;
          if (c.vy < -1.4) c.vy *= -0.42; else { c.vy = 0; c.vx *= 0.82; c.vz *= 0.82; }
        }
        y = c.y;
      } else {
        y = 1.15 + Math.sin(coinSpin + c.i)*0.18;
      }
      dummy.position.set(c.x, y, c.z);
      dummy.rotation.set(0, coinSpin*1.6, 0); dummy.scale.setScalar(1);
      const dx = c.x - sub.x, dz = c.z - sub.z;
      if (dx*dx + dz*dz < 9) { c.got = true; addCoins(5); coinSfx(); burst(c.x, 1.2, c.z, 0xffe27a, 8); }
    }
    dummy.updateMatrix(); coinMesh.setMatrixAt(c.i, dummy.matrix);
  }
  coinMesh.instanceMatrix.needsUpdate = true;
}

// =================================================================
//  PARTICLES
// =================================================================
const particles = []; const PMAX = 140; let pIdx = 0;
{
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const ctx = c.getContext('2d'), grd = ctx.createRadialGradient(32,32,0,32,32,32);
  grd.addColorStop(0,'rgba(255,255,255,1)'); grd.addColorStop(1,'rgba(255,255,255,0)');
  ctx.fillStyle = grd; ctx.fillRect(0,0,64,64);
  const soft = new THREE.CanvasTexture(c);
  for (let i = 0; i < PMAX; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: soft, transparent:true, opacity:0, depthWrite:false }));
    s.visible = false; scene.add(s);
    particles.push({ s, life:0, max:1, vel:new THREE.Vector3(), grow:1 });
  }
}
function emit(pos, vel, color, size, life, grow) {
  const p = particles[pIdx]; pIdx = (pIdx+1)%PMAX;
  p.s.position.copy(pos); p.s.material.color.setHex(color); p.s.scale.setScalar(size);
  p.vel.copy(vel); p.life = life; p.max = life; p.grow = grow; p.s.visible = true;
}
const tmpV = new THREE.Vector3();
function burst(x, y, z, color, n) {
  for (let i = 0; i < n; i++)
    emit(tmpV.set(x,y,z), new THREE.Vector3(rnd(-5,5), rnd(2,6), rnd(-5,5)), color, rnd(0.4,0.9), 0.6, 1.2);
}
function updateParticles(dt) {
  for (const p of particles) {
    if (p.life <= 0) continue;
    p.life -= dt;
    if (p.life <= 0) { p.s.visible = false; continue; }
    p.s.position.addScaledVector(p.vel, dt);
    p.vel.multiplyScalar(1 - dt*1.6);
    p.s.scale.setScalar(p.s.scale.x + p.grow*dt);
    p.s.material.opacity = Math.max(0, p.life/p.max) * 0.75;
  }
}
let stackT = 0;

// =================================================================
//  ROAD NETWORK  (built straight from the grid)
// =================================================================
const NET = { nodes: [], edges: [] };
{
  const key = new Map();
  const nodeAt = (x, z) => {
    const k = Math.round(x) + ',' + Math.round(z);
    let i = key.get(k);
    if (i === undefined) { i = NET.nodes.length; NET.nodes.push({ x, z, e: [] }); key.set(k, i); }
    return i;
  };
  const addEdge = (ax, az, bx, bz, sw, hw) => {
    const len = Math.hypot(bx-ax, bz-az);
    if (len < 4) return;
    const a = nodeAt(ax, az), b = nodeAt(bx, bz);
    if (a === b) return;
    const i = NET.edges.length;
    NET.edges.push({ a, b, len, sw, hw, axis: Math.abs(bx-ax) >= Math.abs(bz-az) ? 'EW' : 'NS' });
    NET.nodes[a].e.push(i); NET.nodes[b].e.push(i);
  };
  for (const st of STREETS) addEdge(st.ax, st.az, st.bx, st.bz, st.w + 4.5, st.kind === 'highway');
}
function edgeDir(e, from) {
  const a = NET.nodes[from], to = e.a === from ? e.b : e.a, b = NET.nodes[to];
  const dx = b.x-a.x, dz = b.z-a.z, l = Math.hypot(dx,dz)||1;
  return { dx: dx/l, dz: dz/l, to };
}
function pickNext(node, cur, dx, dz) {
  const cand = []; let sum = 0;
  for (const ei of NET.nodes[node].e) {
    if (ei === cur) continue;
    const d = edgeDir(NET.edges[ei], node);
    const dot = d.dx*dx + d.dz*dz;
    if (dot < -0.5) continue;
    const w = Math.pow(dot + 1.05, 4);
    cand.push({ ei, w }); sum += w;
  }
  if (!cand.length) return cur;
  let r = Math.random()*sum;
  for (const c of cand) { r -= c.w; if (r <= 0) return c.ei; }
  return cand[cand.length-1].ei;
}
const NODEQ = 120, nodeGrid = new Map();
NET.nodes.forEach((n, i) => {
  const k = Math.floor(n.x/NODEQ)+','+Math.floor(n.z/NODEQ);
  let b = nodeGrid.get(k); if (!b) nodeGrid.set(k, b=[]); b.push(i);
});
function nearestNode(x, z) {
  let best = -1, bd = Infinity;
  for (let ring = 1; ring <= 4 && best < 0; ring++) {
    const gx = Math.floor(x/NODEQ), gz = Math.floor(z/NODEQ);
    for (let ox = -ring; ox <= ring; ox++) for (let oz = -ring; oz <= ring; oz++) {
      const b = nodeGrid.get((gx+ox)+','+(gz+oz)); if (!b) continue;
      for (const i of b) { const d = (NET.nodes[i].x-x)**2 + (NET.nodes[i].z-z)**2; if (d < bd) { bd = d; best = i; } }
    }
  }
  return best;
}

// =================================================================
//  CITY AUDIT
//  One pass over the finished town looking for the things that read as broken:
//  buildings inside each other, scenery inside buildings, furniture on the road,
//  and streets that stop in the middle of nowhere. Should print all zeros.
// =================================================================
function cityAudit(tag) {
  const overlap = (a, b, m) =>
    Math.min(a.x+a.w/2, b.x+b.w/2) - Math.max(a.x-a.w/2, b.x-b.w/2) > m &&
    Math.min(a.z+a.d/2, b.z+b.d/2) - Math.max(a.z-a.d/2, b.z-b.d/2) > m;
  let clashes = 0, worst = 0;
  const byPair = {};
  for (let i = 0; i < mapBoxes.length; i++) for (let j = i+1; j < mapBoxes.length; j++) {
    const a = mapBoxes[i], b = mapBoxes[j];
    if (a.group && a.group === b.group) continue;           // one structure, many boxes
    if (!overlap(a, b, 0.5)) continue;
    clashes++;
    const k = [a.kind, b.kind].sort().join('+');
    byPair[k] = (byPair[k]||0) + 1;
    worst = Math.max(worst, Math.min(
      Math.min(a.x+a.w/2, b.x+b.w/2) - Math.max(a.x-a.w/2, b.x-b.w/2),
      Math.min(a.z+a.d/2, b.z+b.d/2) - Math.max(a.z-a.d/2, b.z-b.d/2)));
  }
  // Drive every carriageway centreline and see whether a car's width is ever inside
  // something solid. This is the blockade test — a structure that footprintOnRoad let
  // through, or one that arrived after the road did, shows up here and nowhere else.
  let blocked = 0;
  const blockedAt = [];
  for (const st of STREETS) {
    const L = Math.hypot(st.bx-st.ax, st.bz-st.az) || 1;
    for (let d = 0; d <= L; d += 3) {
      const x = st.ax + (st.bx-st.ax)*d/L, z = st.az + (st.bz-st.az)*d/L;
      if (!pointBlocked(x, z, 1.8)) continue;
      blocked++;
      if (blockedAt.length < 6) blockedAt.push([Math.round(x), Math.round(z)]);
    }
  }
  // gap between each house and the nearest shopfront
  const houses = mapBoxes.filter(b => b.kind === 'house'), shops = mapBoxes.filter(b => b.kind === 'shop');
  const near = [];
  for (const h of houses) {
    let bd = 1e9, bs = null;
    for (const sh of shops) {
      const gx = Math.max(0, Math.max(h.x-h.w/2, sh.x-sh.w/2) - Math.min(h.x+h.w/2, sh.x+sh.w/2));
      const gz = Math.max(0, Math.max(h.z-h.d/2, sh.z-sh.d/2) - Math.min(h.z+h.d/2, sh.z+sh.d/2));
      const g = Math.hypot(gx, gz);
      if (g < bd) { bd = g; bs = sh; }
    }
    if (bs && bd < 14) near.push({ gap:+bd.toFixed(1), h:[Math.round(h.x),Math.round(h.z)], s:[Math.round(bs.x),Math.round(bs.z)] });
  }
  near.sort((a, b) => a.gap - b.gap);
  const inBuilding = (p, m) => pointBlocked(p.x, p.z, m);
  const r = {
    buildingsOverlapping: clashes,
    worstOverlap: +worst.toFixed(1),
    carriagewayBlocked: blocked,
    treesInBuildings: treeSpots.filter(t => inBuilding(t, 0.4)).length,
    hedgesInBuildings: hedges.filter(h => inBuilding(h, 0.2)).length,
    propsInBuildings: propSpots.filter(p => inBuilding(p, 0.3)).length,
    coinsInBuildings: coinsSpots.filter(c => inBuilding(c, 0.3)).length,
    deadEnds: NET.nodes.filter(n => n.e.length === 1).length,
    housesCrowdingShops: near.length,   // residential wedged into the high street
  };
  if (blocked) r.blockedAt = blockedAt;
  if (clashes) r.overlapKinds = byPair;
  if (Object.keys(roadClash).length) r.structuresOnRoad = roadClash;
  if (near.length) r.crowdedAt = near.slice(0, 5);
  console.log('city audit' + (tag ? ' ' + tag : '') + ':', JSON.stringify(r));
  return r;
}
cityAudit();

// Road-surface sweep. carriagewayBlocked only samples the centreline against a car's
// width, so anything parked near the kerb — a fence chunk straddling a crossing, a
// stray post — slips past it and reads in-game as a bump or a rail lying on the tarmac.
// This walks every solid box instead and asks whether its centre is on a carriageway.
{
  const bad = [];
  for (const c of colliders) {
    const cx = (c.minX + c.maxX)/2, cz = (c.minZ + c.maxZ)/2;
    if (cx > 1e8) continue;                       // parked-away door blocks
    if (onRoad(cx, cz, -0.6)) bad.push([Math.round(cx), Math.round(cz)]);
  }
  console.log('solids on the carriageway:', bad.length, JSON.stringify(bad.slice(0, 8)));
}

// Only now do the bridge railings become solid. Their chunks were collected during
// the river pass, which runs before the trees, hedges, props and coins are filtered —
// pushing the colliders up there would have re-counted every scatter filter and moved
// the audit baselines for a change that has nothing to do with them.
for (const b of railCols) {
  // corner-clipped chunks the sampling missed must never stand inside a room —
  // the interiors audit (rightly) treats that as an intruder
  if (ROOMS.some(R => b.maxX > R.inner.x0 - 0.2 && b.minX < R.inner.x1 + 0.2 &&
                      b.maxZ > R.inner.z0 - 0.2 && b.minZ < R.inner.z1 + 0.2)) continue;
  colliders.push(b);
}

// The Penitentiary's north-wall collider swaps for the gate's shorter runs only now,
// past every scatter filter — same reasoning as the bridge rails above. The visual
// swap happened in the deferred pass; until here the yard stayed "sealed" to every
// build-time filter, so the tree and audit baselines are untouched by the gate.
if (PRISON.col) {
  const ci = colliders.indexOf(PRISON.col); if (ci >= 0) colliders.splice(ci, 1);
  for (const b of PRISON.newCols) colliders.push(b);
}

// =================================================================
//  TRAFFIC SIGNALS
// =================================================================
let lightGreen = 'NS', lightTimer = 0;
const nsLens = new THREE.MeshBasicMaterial({ color: 0x2fd45f });
const ewLens = new THREE.MeshBasicMaterial({ color: 0xe8402f });
{
  const spots = [];
  for (let i = 0; i < GN; i++) for (let j = 0; j < GN; j++) {
    const c = CORNER[i][j];
    if (c.deg >= 3) spots.push([c.x, c.z]);
  }
  const rig = merge([
    baked(new THREE.CylinderGeometry(0.28, 0.36, 8, 16), 0, 4, 0),
    baked(BOX(0.28, 0.28, ROAD_HW), 0, 7.6, ROAD_HW/2),
  ]);
  const post = instanced(rig, toon(0x3c4048), spots.length);
  const hsg  = instanced(BOX(0.9, 2.1, 0.9), toon(0x22262f), spots.length);
  const lensGeo = new THREE.SphereGeometry(0.34, 16, 12);
  const ns = instanced(lensGeo, nsLens, spots.length, false);
  const ew = instanced(lensGeo, ewLens, spots.length, false);
  spots.forEach(([cx, cz], i) => {
    const px = cx + ROAD_HW + 3, pz = cz + ROAD_HW + 3;
    dummy.scale.set(1,1,1);
    dummy.position.set(px, 0, pz); dummy.rotation.set(0, Math.atan2(-1, -1), 0); dummy.updateMatrix();
    post.setMatrixAt(i, dummy.matrix);
    const hx = px - ROAD_HW*0.707, hz = pz - ROAD_HW*0.707;
    dummy.rotation.set(0,0,0);
    dummy.position.set(hx, 6.7, hz); dummy.updateMatrix(); hsg.setMatrixAt(i, dummy.matrix);
    dummy.position.set(hx, 6.7, hz+0.5); dummy.updateMatrix(); ns.setMatrixAt(i, dummy.matrix);
    dummy.position.set(hx+0.5, 6.7, hz); dummy.updateMatrix(); ew.setMatrixAt(i, dummy.matrix);
  });
  for (const m of [post, hsg, ns, ew]) { m.instanceMatrix.needsUpdate = true; scene.add(m); }
}
function updateLights(dt) {
  lightTimer += dt;
  const G = 9, Y = 2, cycle = (G+Y)*2, t = lightTimer % cycle;
  lightGreen = t < G ? 'NS' : t < G+Y ? 'none' : t < G+Y+G ? 'EW' : 'none';
  const col = s => s==='go' ? 0x2fd45f : s==='slow' ? 0xf0b429 : 0xe8402f;
  nsLens.color.setHex(col(lightGreen==='NS' ? 'go' : lightGreen==='none' ? 'slow' : 'stop'));
  ewLens.color.setHex(col(lightGreen==='EW' ? 'go' : lightGreen==='none' ? 'slow' : 'stop'));
}

// =================================================================
//  ALTITUDE
//  Everything that moves samples the surface below it. The river is a real
//  drop: drive off the bank and you fall in.
// =================================================================
function onBridge(x, z) {
  for (const b of BRIDGES) {
    const dx = b.bx-b.ax, dz = b.bz-b.az, L2 = dx*dx + dz*dz || 1;
    // clamped, not rejected: the deck is a capsule, so bridge mouths get an end cap
    // and a zero-length entry (a wet junction's disc) reads as a circle
    let t = ((x-b.ax)*dx + (z-b.az)*dz) / L2;
    t = Math.max(0, Math.min(1, t));
    const cx = b.ax + dx*t, cz = b.az + dz*t;
    if (Math.hypot(x-cx, z-cz) < b.w) return true;
  }
  return false;
}
const WATER_Y = -5.2;
// Jump ramps are part of the *ground*, not obstacles: they raise surfaceY over their
// footprint, so the existing altitude code does all the work — the car rides up the
// wedge, and the instant it runs off the lip surfaceY drops away, carVY takes over and
// it is genuinely airborne. That also means a ramp must never be a collider, or you
// would hit it as a wall instead of driving up it.
const RAMPS = [];
function rampY(x, z) {
  let best = 0;
  for (const r of RAMPS) {
    const dx = x - r.x, dz = z - r.z;
    const a = dx*r.ux + dz*r.uz;                  // distance up the ramp
    if (a < 0 || a > r.len) continue;
    if (Math.abs(-dx*r.uz + dz*r.ux) > r.w/2) continue;
    const h = (a / r.len) * r.h;
    if (h > best) best = h;
  }
  return best;
}
// Raised walking surfaces — the coaster's station platform and its stairs. Same
// philosophy as the ramps: part of the ground, never a collider, so you walk up
// the stairs and onto the deck with the ordinary altitude code. A `rise` axis
// makes an entry a wedge (stairs); without one it is a flat deck.
const DECKS = [];
function deckY(x, z) {
  let best = 0;
  for (const d of DECKS) {
    if (x < d.x0 || x > d.x1 || z < d.z0 || z > d.z1) continue;
    let h = d.h;
    if (d.rise) {
      const t = d.rise === 'x+' ? (x - d.x0) / (d.x1 - d.x0)
              : d.rise === 'x-' ? (d.x1 - x) / (d.x1 - d.x0)
              : d.rise === 'z+' ? (z - d.z0) / (d.z1 - d.z0)
              :                   (d.z1 - z) / (d.z1 - d.z0);
      h *= t;
    }
    if (h > best) best = h;
  }
  return best;
}
// Standing pads — the tire-fire climb. Each is a flat disc top at height h; step onto
// its footprint and the altitude code lifts you there, same as a deck. Footprints never
// overlap, so the single-valued surface stays well-defined: miss a pad and you are over
// bare ground (or a lower pad) and you fall.
const PADS = [];
// Tyre columns of the fire climb, as real solids (see collideTires). Kept apart
// from `colliders` because the spiral packs them diagonally ~1.85 m apart at the
// top, where the square AABBs collideCircle uses would overlap and eject you off
// an adjacent pad — a circle push is gentle enough to sit between them.
const TIRECOLS = [];
const PAD_STEP = 0.4;   // how far above your feet a pad top may be and still lift you
// The pad you rest on is the highest disc whose top is at or below your feet (plus a
// small step-up), NOT the tallest overlapping disc: on a tight spiral the columns'
// footprints overlap, so a global max would yank you off a low tier up to a taller
// one you are standing beside. `fromY` is the player's current height; cars and peds
// call without it and keep the old max behaviour (they never climb).
function padY(x, z, fromY) {
  let best = 0;
  for (const p of PADS) {
    const dx = x - p.x, dz = z - p.z;
    if (dx*dx + dz*dz > p.r*p.r) continue;
    if (fromY !== undefined && p.h > fromY + PAD_STEP) continue;
    if (p.h > best) best = p.h;
  }
  return best;
}
// Push the player out of any tyre column taller than their feet — a solid side you
// cannot walk through, so a jump that lands short slides off instead of dropping
// through the rubber. Once your feet reach the top (minus a lip tolerance) the column
// stops blocking and padY lifts you onto it. Circle-vs-circle, player only.
function collideTires(px, pz, r, feetY) {
  let x = px, z = pz;
  for (const t of TIRECOLS) {
    if (feetY >= t.top - 0.15) continue;          // at/above the top: land on it, don't wall off
    const dx = x - t.x, dz = z - t.z, rr = t.r + r, d2 = dx*dx + dz*dz;
    if (d2 >= rr*rr || d2 === 0) continue;
    const d = Math.sqrt(d2), push = rr - d;
    x += dx/d * push; z += dz/d * push;
  }
  return { x, z };
}
function surfaceY(x, z, fromY) {
  const d = Math.abs(z - riverZ(x));
  if (d < RIVER_HW + 11) {
    if (onBridge(x, z)) return 0;                 // the deck carries you across
    if (d <= RIVER_HW) return -6.4;               // riverbed
    return -6.4 + ((d - RIVER_HW) / 11) * 6.4;    // sloping bank
  }
  return groundH(x, z) + (RAMPS.length ? rampY(x, z) : 0) + (DECKS.length ? deckY(x, z) : 0)
       + (PADS.length ? padY(x, z, fromY) : 0);
}
const inWater = (x, z) => Math.abs(z - riverZ(x)) < RIVER_HW && !onBridge(x, z);

// =================================================================
//  CARS  (chunky cartoon proportions, instanced)
// =================================================================
const CAR_TYPES = {
  sedan:   { W:2.5, L:5.2, wr:0.62, ww:0.5, track:1.15, fA:1.6, rA:-1.6, clr:0.34, bodyH:1.0, roofH:0.95, roofL:2.3, roofW:2.1, roofZ:-0.25 },
  convert: { W:2.6, L:5.6, wr:0.64, ww:0.52, track:1.2, fA:1.8, rA:-1.8, clr:0.32, bodyH:1.05, roofH:0.0, roofL:2.2, roofW:2.1, roofZ:-0.3 },
  wagon:   { W:2.6, L:5.4, wr:0.66, ww:0.54, track:1.2, fA:1.7, rA:-1.7, clr:0.40, bodyH:1.1, roofH:1.25, roofL:3.1, roofW:2.2, roofZ:-0.5 },
  compact: { W:2.3, L:4.2, wr:0.58, ww:0.46, track:1.05, fA:1.3, rA:-1.3, clr:0.34, bodyH:1.0, roofH:1.0, roofL:1.9, roofW:1.95, roofZ:-0.1 },
  truck:   { W:2.8, L:6.0, wr:0.8, ww:0.62, track:1.3, fA:1.9, rA:-1.9, clr:0.62, bodyH:1.1, roofH:1.2, roofL:2.0, roofW:2.3, roofZ:0.7 },
};
const CAR_COLS = [0xf07ab0, 0x8ad14f, 0x7b4fa7, 0x3fa9d8, 0xf0b429, 0xe8532f, 0xe8e3d3, 0x4f7d8c, 0xd0392b, 0x59c9a5];
const VEH_CAP = 140, VEH_PARTS = ['paint','dark','chrome','glass','lamp'];

function carGeo(type) {
  const s = CAR_TYPES[type];
  const paint = [], dark = [], chrome = [], glass = [], lamp = [];
  const bodyY = s.clr + s.bodyH/2;
  paint.push(baked(BOX(s.W, s.bodyH, s.L), 0, bodyY, 0));
  // rounded nose and tail
  paint.push(baked(new THREE.CylinderGeometry(s.bodyH/2, s.bodyH/2, s.W, 20, 1, false, 0, Math.PI), 0, bodyY, s.L/2, 0, 0, Math.PI/2));
  paint.push(baked(new THREE.CylinderGeometry(s.bodyH/2, s.bodyH/2, s.W, 20, 1, false, 0, Math.PI), 0, bodyY, -s.L/2, 0, Math.PI, Math.PI/2));
  if (s.roofH > 0) {
    const cy = s.clr + s.bodyH + s.roofH/2;
    paint.push(baked(BOX(s.roofW, s.roofH, s.roofL), 0, cy, s.roofZ));
    paint.push(baked(new THREE.CylinderGeometry(s.roofH/2, s.roofH/2, s.roofW, 20, 1, false, 0, Math.PI), 0, cy, s.roofZ + s.roofL/2, 0, 0, Math.PI/2));
    glass.push(baked(BOX(s.roofW*1.02, s.roofH*0.62, s.roofL*0.92), 0, cy+0.06, s.roofZ));
  } else {
    dark.push(baked(BOX(s.roofW*0.9, 0.5, s.roofL*0.9), 0, s.clr + s.bodyH - 0.15, s.roofZ));   // seats well
    // The seat back. Its width and depth were the wrong way round — 0.16 of the roof
    // *width* and 0.9 of its *length* — which made it a 2 m beam running down the
    // centreline of the car and straight through the driver's back instead of a panel
    // across the back of the seats.
    paint.push(baked(BOX(s.roofW*0.9, 0.7, s.roofL*0.16), 0, s.clr + s.bodyH + 0.2, s.roofZ - s.roofL*0.5));
  }
  if (type === 'truck') {
    dark.push(baked(BOX(s.W*0.95, 0.9, 2.4), 0, s.clr + s.bodyH + 0.4, -1.6));
    chrome.push(baked(BOX(s.W*1.15, 1.1, 0.4), 0, s.clr + 0.4, s.L/2 + 0.35));
  }
  chrome.push(baked(BOX(s.W*1.04, 0.34, 0.5), 0, s.clr + 0.3, s.L/2 + 0.1));
  chrome.push(baked(BOX(s.W*1.04, 0.34, 0.5), 0, s.clr + 0.3, -s.L/2 - 0.1));
  for (const hx of [-1,1]) lamp.push(baked(new THREE.CylinderGeometry(0.26, 0.26, 0.16, 20), hx*s.W*0.32, s.clr+s.bodyH*0.75, s.L/2+0.2, Math.PI/2));
  for (const tx of [-1,1]) dark.push(baked(BOX(0.5,0.24,0.14), tx*s.W*0.3, s.clr+s.bodyH*0.7, -s.L/2-0.22));
  // Wheels carry more of the read than anything else on a car: they are round, always
  // in frame, and a facet count you can count by eye is the first thing that says
  // "low poly". 28 segments is smooth at any distance the camera actually reaches.
  const tyre  = new THREE.CylinderGeometry(s.wr, s.wr, s.ww, 28).rotateZ(Math.PI/2);
  const rim   = new THREE.CylinderGeometry(s.wr*0.62, s.wr*0.62, s.ww + 0.06, 24).rotateZ(Math.PI/2);
  const cap   = new THREE.CylinderGeometry(s.wr*0.2, s.wr*0.2, s.ww + 0.14, 12).rotateZ(Math.PI/2);
  const spoke = BOX(s.wr*0.15, s.wr*1.0, s.ww*0.5);
  for (const [wx, wz] of [[-s.track,s.fA],[s.track,s.fA],[-s.track,s.rA],[s.track,s.rA]]) {
    dark.push(baked(tyre, wx, s.wr, wz));
    chrome.push(baked(rim, wx, s.wr, wz));
    chrome.push(baked(cap, wx, s.wr, wz));
    for (let k = 0; k < 3; k++)                     // a suggestion of spokes, not a wire wheel
      dark.push(baked(spoke, wx, s.wr, wz, 0, 0, k * Math.PI / 3));
  }
  // wheel arches: without them the body hovers over the wheels
  for (const [wx, wz] of [[-s.track,s.fA],[s.track,s.fA],[-s.track,s.rA],[s.track,s.rA]])
    paint.push(baked(new THREE.TorusGeometry(s.wr*1.12, 0.09, 6, 14, Math.PI),
      wx, s.wr, wz, 0, Math.PI/2));
  return { paint: merge(paint), dark: merge(dark), chrome: merge(chrome), glass: merge(glass), lamp: merge(lamp) };
}
const VEH_MATS = {
  paint:  addRim(new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: RAMP })),
  // dark and chrome get their own materials rather than the toon() cache: the cached
  // ones are shared with street furniture, which must not pick up the rim
  dark:   addRim(new THREE.MeshToonMaterial({ color: 0x2b2f38, gradientMap: RAMP })),
  chrome: addRim(new THREE.MeshToonMaterial({ color: 0xd8dde4, gradientMap: RAMP })),
  glass:  new THREE.MeshToonMaterial({ color: 0x9fdcf2, gradientMap: RAMP, transparent: true, opacity: 0.75 }),
  lamp:   new THREE.MeshBasicMaterial({ color: 0xfff3c4 }),
};
const VEH_INST = {};
for (const type in CAR_TYPES) {
  const geo = carGeo(type), set = {};
  for (const p of VEH_PARTS) {
    if (!geo[p]) continue;
    set[p] = instanced(geo[p], VEH_MATS[p], VEH_CAP, p !== 'glass');
    set[p].count = 0; scene.add(set[p]);
  }
  set.paint.setColorAt(0, new THREE.Color(0xffffff));
  set.paint.instanceColor.array.fill(1);
  VEH_INST[type] = set;
}

const TRAFFIC_TYPES = ['sedan','convert','wagon','compact','truck','sedan','wagon','compact'];
const traffic = [];
const SIG_STOP = 9;
const approach = d => d <= 0 ? 0 : Math.sqrt(11*d);
function spawnTraffic() {
  const ei = (Math.random()*NET.edges.length)|0, e = NET.edges[ei];
  const type = rpick(TRAFFIC_TYPES), color = rpick(CAR_COLS);
  traffic.push({ type, color, col: new THREE.Color(color), x:0, z:0, yaw:0,
    ei, from: Math.random()<0.5 ? e.a : e.b, dist: Math.random()*e.len,
    baseSpeed: rnd(10, 17), cur: 6, gap: 99, fx:0, fz:1, stopping:false, waitT:0,
    vx:0, vz:0, spin:0, knock:0, hitCooldown:0,
    y: 0, vy: 0, pitch: 0, roll: 0, pitchV: 0, rollV: 0, rec: 0, });
}
for (let i = 0; i < 165; i++) spawnTraffic();

const GAP_Q = 16, gapGrid = new Map(), pedGrid = new Map();
function rebuildPedGrid() {
  pedGrid.clear();
  for (const p of peds) {
    if (p.rag.active) continue;
    const k = Math.floor(p.g.position.x/GAP_Q)+','+Math.floor(p.g.position.z/GAP_Q);
    let b = pedGrid.get(k); if (!b) pedGrid.set(k, b=[]); b.push(p);
  }
}
function updateGaps() {
  gapGrid.clear();
  for (const t of traffic) {
    t.gap = 99;
    const k = Math.floor(t.x/GAP_Q)+','+Math.floor(t.z/GAP_Q);
    let b = gapGrid.get(k); if (!b) gapGrid.set(k, b=[]); b.push(t);
  }
  for (const a of traffic) {
    if (a.knock > 0) continue;
    const gx = Math.floor(a.x/GAP_Q), gz = Math.floor(a.z/GAP_Q);
    const look = (bx, bz) => {
      const dx = bx-a.x, dz = bz-a.z, d2 = dx*dx+dz*dz;
      if (d2 > 225 || d2 < 0.01) return;
      const d = Math.sqrt(d2);
      if ((dx/d)*a.fx + (dz/d)*a.fz > 0.86) a.gap = Math.min(a.gap, d);
    };
    for (let ox=-1; ox<=1; ox++) for (let oz=-1; oz<=1; oz++) {
      const b = gapGrid.get((gx+ox)+','+(gz+oz)); if (!b) continue;
      for (const o of b) if (o !== a) look(o.x, o.z);
    }
    if (mode === 'car') look(car.position.x, car.position.z);
    const rx = -a.fz, rz = a.fx;
    // The player on foot is not in pedGrid, so traffic used to shove you down the
    // road instead of braking. Give yourself the same yield every townsperson gets —
    // that is what makes stepping out in front of a car a carjack rather than a mugging.
    if (mode === 'foot' && !playerRag.active) {
      const dx = player.position.x - a.x, dz = player.position.z - a.z;
      const fwd = dx*a.fx + dz*a.fz;
      if (fwd > 0 && fwd < 17 && Math.abs(dx*rx + dz*rz) < 2.4) a.gap = Math.min(a.gap, fwd + 3.2);
    }
    for (let ox=-1; ox<=1; ox++) for (let oz=-1; oz<=1; oz++) {
      const b = pedGrid.get((gx+ox)+','+(gz+oz)); if (!b) continue;
      for (const p of b) {
        const dx = p.g.position.x-a.x, dz = p.g.position.z-a.z;
        const fwd = dx*a.fx + dz*a.fz; if (fwd <= 0 || fwd > 15) continue;
        if (Math.abs(dx*rx + dz*rz) > 1.9) continue;
        a.gap = Math.min(a.gap, fwd + 3.2);
      }
    }
  }
}
function trafficNear(x, z, r) {
  const gx = Math.floor(x/GAP_Q), gz = Math.floor(z/GAP_Q), r2 = r*r;
  for (let ox=-1; ox<=1; ox++) for (let oz=-1; oz<=1; oz++) {
    const b = gapGrid.get((gx+ox)+','+(gz+oz)); if (!b) continue;
    for (const t of b) { if (t.cur < 1.5) continue;
      const dx=t.x-x, dz=t.z-z; if (dx*dx+dz*dz < r2) return true; }
  }
  return false;
}
const LANE = 3.4;
const tagCol = new THREE.Color();
function renderTraffic() {
  const cnt = {};
  for (const k in VEH_INST) cnt[k] = 0;
  let rc = 0;                                     // rival chevrons drawn this frame
  const bob = Math.sin(performance.now()*0.005)*0.14;
  for (const t of traffic) {
    // a wrecked rival waiting to respawn is hidden once it has finished tumbling
    if (t.rival && t.rival.respawn > 0 && t.knock <= 0) continue;
    const inst = VEH_INST[t.type]; const i = cnt[t.type];
    if (i >= VEH_CAP) continue;
    dummy.position.set(t.x, t.y, t.z);
    // YXZ so pitch and roll are applied in the car's own frame rather than the world's —
    // with the default XYZ a rolling car also swings its nose around. `dummy` is shared
    // with the crowd and props, so the order is put back before anyone else uses it.
    dummy.rotation.set(t.pitch, t.yaw, t.roll, 'YXZ');
    dummy.scale.set(1,1,1);
    dummy.updateMatrix();
    for (const p of VEH_PARTS) if (inst[p]) inst[p].setMatrixAt(i, dummy.matrix);
    inst.paint.setColorAt(i, t.col);
    cnt[t.type] = i+1;
    if (t.rival && rc < RIVAL_CAP) {              // the marker chevron over the roof
      dummy.position.set(t.x, t.y + 3.3 + bob, t.z);
      dummy.rotation.set(0, performance.now()*0.002, 0);
      dummy.scale.set(1,1,1); dummy.updateMatrix();
      rivalTag.setMatrixAt(rc, dummy.matrix);
      rivalTag.setColorAt(rc, tagCol.setHex(t.rival.mood === 'hunt' ? 0xff2a1e : 0xffb020));
      rc++;
    }
  }
  dummy.rotation.order = 'XYZ';
  for (const k in VEH_INST) {
    const inst = VEH_INST[k];
    for (const p of VEH_PARTS) if (inst[p]) { inst[p].count = cnt[k]; inst[p].instanceMatrix.needsUpdate = true; }
    if (inst.paint.instanceColor) inst.paint.instanceColor.needsUpdate = true;
  }
  rivalTag.count = rc;
  rivalTag.instanceMatrix.needsUpdate = true;
  if (rivalTag.instanceColor) rivalTag.instanceColor.needsUpdate = true;
}
function rejoin(t) {
  const ni = nearestNode(t.x, t.z); if (ni < 0) return;
  // Rejoin the graph at the point nearest where the car actually lies — snapping to
  // the junction node (dist 0) teleported every wreck you'd just rammed to the nearest
  // corner, which read as cars vanishing. Same lesson attachPed learned for townsfolk.
  let bei = NET.nodes[ni].e[0], bDist = 0, best = 1e9;
  for (const ei of NET.nodes[ni].e) {
    const e = NET.edges[ei], d = edgeDir(e, ni), A = NET.nodes[ni];
    const proj = THREE.MathUtils.clamp((t.x - A.x)*d.dx + (t.z - A.z)*d.dz, 0, e.len);
    const px = A.x + d.dx*proj - d.dz*LANE, pz = A.z + d.dz*proj + d.dx*LANE;
    const dd = (px - t.x)*(px - t.x) + (pz - t.z)*(pz - t.z);
    if (dd < best) { best = dd; bei = ei; bDist = proj; }
  }
  t.ei = bei; t.from = ni; t.dist = bDist; t.cur = 0; t.stopping = false; t.waitT = 0;
  // Hand the car back to the graph *without teleporting it*. From here on its position
  // and yaw are recomputed from (from, ei, dist) every frame, so whatever the physics
  // did is wiped the instant the knock ends — a car you rammed ten metres down the road
  // blinked back into its lane, which is exactly what read as "it disappeared". Keep the
  // gap and let it decay: the car visibly drives itself back into line. Same lesson
  // attachPed learned for townsfolk, and the same fix as their p.ox/p.oz offsets.
  const e = NET.edges[t.ei], d = edgeDir(e, t.from), A = NET.nodes[t.from];
  const lx = A.x + d.dx*t.dist - d.dz*LANE, lz = A.z + d.dz*t.dist + d.dx*LANE;
  let dy = (t.yaw - Math.atan2(d.dx, d.dz)) % (Math.PI*2);
  if (dy >  Math.PI) dy -= Math.PI*2;
  if (dy < -Math.PI) dy += Math.PI*2;
  t.rox = t.x - lx; t.roz = t.z - lz; t.royaw = dy;
  t.rpitch = t.pitch; t.rroll = t.roll; t.ry = t.y;
  t.rec = 1;
}
// Keep at least one civilian car in view. 165 cars spread over the whole graph leave
// some junctions empty, which reads as a ghost town — so if none is within sight of the
// player, the farthest one is quietly relocated onto a road near them (preferring the
// way they are looking), where it rejoins traffic and drives in. Cheap: one scan a
// second, and it only fires when the coast is genuinely clear.
let sightT = 0;
const SIGHT_R = 78;
function ensureCarInSight(dt) {
  sightT -= dt; if (sightT > 0) return;
  sightT = 1.1;
  const sub = mode === 'car' ? car.position : player.position;
  for (const t of traffic) {
    if (t.cop || t.derby || t.racer || t.rival || t.knock > 0) continue;
    const dx = t.x - sub.x, dz = t.z - sub.z;
    if (dx*dx + dz*dz < SIGHT_R*SIGHT_R) return;   // already one nearby — done
  }
  // None in sight. The road graph is sparse — its nodes sit tens of metres apart, so a
  // junction can have no *node* inside the sight ring even though a road plainly runs
  // through it. So we scan the *edges*, sampling lane points along each town street, and
  // pick the one that lands inside the ring and most nearly ahead of the camera. That is
  // guaranteed to find a spot on real tarmac in view whenever any road passes nearby.
  const fx = Math.sin(camYaw), fz = Math.cos(camYaw);
  const R0 = 34, R1 = SIGHT_R - 5;
  let best = null, bs = -1e9, fb = null, fbd = 1e9;
  for (let i = 0; i < NET.edges.length; i++) {
    const e = NET.edges[i];
    if (e.hw) continue;                               // town streets only
    const A = NET.nodes[e.a], d = edgeDir(e, e.a);
    const step = Math.max(6, e.len / Math.ceil(e.len / 10));
    for (let s = 0; s <= e.len + 0.01; s += step) {
      const ss = Math.min(s, e.len);
      const px = A.x + d.dx*ss - d.dz*LANE, pz = A.z + d.dz*ss + d.dx*LANE;
      const ex = px - sub.x, ez = pz - sub.z, dist = Math.hypot(ex, ez);
      if (dist < R0) continue;
      const cand = { ei: i, from: e.a, dist: ss, x: px, z: pz, yaw: Math.atan2(d.dx, d.dz) };
      if (dist <= R1) {
        const score = (ex*fx + ez*fz)/dist;           // +1 dead ahead, -1 behind
        if (score > bs) { bs = score; best = cand; }
      } else if (dist < fbd) { fbd = dist; fb = cand; }  // ring empty: nearest road beyond it
    }
  }
  const spot = best || fb;
  if (!spot) return;
  // Move the farthest civilian car onto that spot and hand it back to the graph, so it
  // drives in naturally from there rather than blinking into existence.
  let far = null, fd = -1;
  for (const t of traffic) {
    if (t.cop || t.derby || t.racer || t.rival || t.knock > 0) continue;
    const dx = t.x - sub.x, dz = t.z - sub.z, d = dx*dx + dz*dz;
    if (d > fd) { fd = d; far = t; }
  }
  if (!far) return;
  far.from = spot.from; far.ei = spot.ei; far.dist = spot.dist; far.cur = far.baseSpeed*0.6;
  far.x = spot.x; far.z = spot.z; far.yaw = spot.yaw;
  far.knock = 0; far.rec = 0; far.y = 0; far.pitch = 0; far.roll = 0;
  far.stopping = false; far.waitT = 0; far.jam = 0; far.push = 0;
}
function updateTraffic(dt) {
  updateGaps();
  if (tauntT > 0) tauntT -= dt;
  for (const t of traffic) {
    if (t.hitCooldown > 0) t.hitCooldown -= dt;
    if (t.knock > 0) {
      t.knock -= dt;
      // knocked cars collide like everything else — they used to sail straight through
      // building walls and "disappear" inside, which is where rammed cars kept going
      const kres = collideCircle(t.x + t.vx*dt, t.z + t.vz*dt, 1.6, colliders);
      if (kres.hit) { t.vx *= -0.3; t.vz *= -0.3; t.spin *= 0.5; t.rollV *= 0.6; }
      t.x = THREE.MathUtils.clamp(kres.x, -TOWN-60, TOWN+60);
      t.z = THREE.MathUtils.clamp(kres.z, -TOWN-60, TOWN+60);
      // A hard enough hit lifts the car off the road, and once it is in the air it
      // tumbles. Gravity is the same 26 the player's car falls under, so a launched
      // traffic car and a launched player car read as the same world.
      const gy = surfaceY(t.x, t.z);
      t.vy -= 26*dt; t.y += t.vy*dt;
      const flying = t.y > gy + 0.06;
      if (flying) {
        t.vx *= (1-0.5*dt); t.vz *= (1-0.5*dt);             // barely any drag in the air
        t.pitch += t.pitchV*dt; t.roll += t.rollV*dt;
      } else {
        if (t.y < gy) t.y = gy;
        if (t.vy < -5) { t.vy *= -0.3; t.spin *= 0.7; crashSfx(-t.vy*1.6); }   // it bounces once
        else t.vy = 0;
        t.vx *= (1-3.2*dt); t.vz *= (1-3.2*dt);             // tyres bite
        t.pitchV *= (1-8*dt); t.rollV *= (1-8*dt);
        // and it rights itself. A car resting on its roof is a wreck state this game
        // does not have for traffic — it would sit there blocking a lane for ever.
        t.pitch += (0 - t.pitch) * Math.min(1, dt*4.5);
        t.roll  += (0 - t.roll)  * Math.min(1, dt*4.5);
      }
      t.yaw += t.spin*dt; t.spin *= (1-1.6*dt);
      const s2 = Math.hypot(t.vx, t.vz);
      if (s2 > 3 && !flying) hitPeopleAt(t.x, t.z, t.vx, t.vz, s2, 2.2);
      // never hand a car back to the lane while it is still in the air, or mid-flip
      if (t.knock <= 0 && (flying || Math.abs(t.roll) > 0.25 || Math.abs(t.pitch) > 0.25)) t.knock = 0.06;
      if (t.knock <= 0 && !t.derby && !t.racer) rejoin(t);   // derby and race cars live off the graph
      continue;
    }
    if (t.rival) { if (updateRival(t, dt)) continue; }
    if (t.derby) { updateDerbyCar(t, dt); continue; }
    if (t.racer) { updateRacerCar(t, dt); continue; }
    if (t.cop) {
      const sub = mode === 'car' ? car.position : player.position;
      const dx = sub.x - t.x, dz = sub.z - t.z, d = Math.hypot(dx, dz) || 1;
      if (d < PURSUE_R) {
        // close enough to leave the road graph and just come at you
        t.chase = true;
        // caught up with a stopped (or slow) target: park and make the arrest on foot
        const targetSlow = mode !== 'car' || Math.abs(speed) < 3.5;
        if (t.arrest || (d < 8.5 && targetSlow)) {
          t.cur += (0 - t.cur) * Math.min(1, dt*6);
          if (!officer && d < 8.5 && targetSlow) deployOfficer(t);
          t.fx = Math.sin(t.yaw); t.fz = Math.cos(t.yaw);
          continue;
        }
        t.yaw = lerpAngle(t.yaw, Math.atan2(dx, dz), 1 - Math.exp(-dt*3.2));
        t.cur += (COP_SPEED - t.cur) * Math.min(1, dt*2.4);
        const res = collideCircle(t.x + Math.sin(t.yaw)*t.cur*dt,
                                  t.z + Math.cos(t.yaw)*t.cur*dt, 1.9, colliders);
        t.x = res.x; t.z = res.z;
        t.fx = Math.sin(t.yaw); t.fz = Math.cos(t.yaw);
        if (t.cur > 1.5) hitPeopleAt(t.x, t.z, t.fx, t.fz, t.cur, 1.9);
        continue;
      }
      if (t.chase) { t.chase = false; rejoin(t); }   // back onto the graph to close in
    }
    let e = NET.edges[t.ei], dir = edgeDir(e, t.from);
    const toEnd = e.len - t.dist;
    let target = t.baseSpeed;
    const ahead = NET.nodes[dir.to];
    // signals only exist at 3-way-or-better junctions, and never on the highway —
    // braking for imaginary lights at plain deg-2 nodes is what parked the ring road
    const signalled = !e.hw && ahead.e.length >= 3;
    if (t.cop || !signalled) { t.stopping = false; t.waitT = 0; }
    else if (lightGreen === e.axis) { t.stopping = false; t.waitT = 0; }
    else if (toEnd > SIG_STOP) t.stopping = true;
    if (t.stopping) {
      t.waitT += dt;
      if (t.waitT > 14) t.stopping = false;
      else target = Math.min(target, approach(toEnd - SIG_STOP));
    }
    if (t.gap < 28) target = Math.min(target, approach(t.gap - 7));
    // ---- jam breaker ----
    // Gap-following on its own deadlocks. A queue that backs through a junction
    // blocks the cross traffic that would have cleared it, and anything parked in a
    // lane — a wreck, or the player's own car — stops that lane for good, because an
    // AI car is pinned to its edge and cannot steer around. So a car that has been at
    // a crawl for several seconds gives up on whatever is in front and commits to
    // pushing through for a few seconds, which unties the knot from the inside.
    // The commit matters: without it, one frame of movement resets the timer and the
    // car falls straight back into the queue, stuttering instead of clearing.
    if (t.cur < 0.6) t.jam = (t.jam || 0) + dt;
    else t.jam = Math.max(0, (t.jam || 0) - dt*0.5);
    if (t.jam > 5) { t.push = 3; t.jam = 0; }
    if (t.push > 0) { t.push -= dt; target = Math.max(target, 7); }
    t.cur += (target - t.cur) * Math.min(1, dt*(target < t.cur ? 4 : 1.7));
    if (t.cur < 0.06) t.cur = 0;
    t.dist += t.cur*dt;
    let guard = 0;
    while (t.dist >= NET.edges[t.ei].len && guard++ < 6) {
      const ce = NET.edges[t.ei], d = edgeDir(ce, t.from);
      t.dist -= ce.len;
      let bx = d.dx, bz = d.dz;
      if (t.cop) {                                  // steer the search toward the player
        const sub = mode === 'car' ? car.position : player.position;
        const n2 = NET.nodes[d.to], ax = sub.x - n2.x, az = sub.z - n2.z;
        const al = Math.hypot(ax, az) || 1; bx = ax/al; bz = az/al;
      }
      const next = pickNext(d.to, t.ei, bx, bz);
      t.from = d.to; t.ei = next; t.stopping = false; t.waitT = 0;
    }
    e = NET.edges[t.ei]; dir = edgeDir(e, t.from);
    const A = NET.nodes[t.from];
    t.x = A.x + dir.dx*t.dist - dir.dz*LANE;
    t.z = A.z + dir.dz*t.dist + dir.dx*LANE;
    t.yaw = Math.atan2(dir.dx, dir.dz);
    t.fx = dir.dx; t.fz = dir.dz;
    if (t.rec > 0) {                       // ease out of wherever the shove left it
      t.rec = Math.max(0, t.rec - dt*1.7);
      const k = t.rec*t.rec*(3 - 2*t.rec);  // smoothstep, so it arrives without a kink
      t.x += t.rox*k; t.z += t.roz*k; t.yaw += t.royaw*k;
      t.y = t.ry*k; t.pitch = t.rpitch*k; t.roll = t.rroll*k;
    }
    if (t.cur > 1.5) hitPeopleAt(t.x, t.z, dir.dx, dir.dz, t.cur, 1.8);
  }
  renderTraffic();
}
// Collide against the car's actual oriented body. The old test used a 4.2 m axis-aligned
// square whatever way the car was pointing, which is where the invisible wall came from.
function collideTraffic(px, pz, r) {
  let x = px, z = pz, hit = false, who = -1;
  for (let i = 0; i < traffic.length; i++) {
    const t = traffic[i];
    const dx = x - t.x, dz = z - t.z;
    if (dx*dx + dz*dz > 64) continue;                       // cheap reject
    const c = Math.cos(t.yaw), sn = Math.sin(t.yaw);
    const S = CAR_TYPES[t.type] || CAR_TYPES.sedan;
    const hx = S.W/2 + 0.1, hz = S.L/2 + 0.15;
    let lx = dx*c - dz*sn;                                  // into the car's own frame
    let lz = dx*sn + dz*c;
    const ox = (hx + r) - Math.abs(lx), oz = (hz + r) - Math.abs(lz);
    if (ox <= 0 || oz <= 0) continue;
    if (ox < oz) lx += Math.sign(lx || 1) * ox;             // slide out the near face
    else         lz += Math.sign(lz || 1) * oz;
    x = t.x + lx*c + lz*sn;
    z = t.z - lx*sn + lz*c;
    hit = true; who = i;
  }
  return { x, z, hit, who };
}

// =================================================================
//  TOWNSFOLK  (yellow, big eyes, instanced with outlines)
// =================================================================
// Mostly the classic yellow, with a scattering of tan and brown townsfolk, a wider
// wardrobe, and twelve hairstyle rolls across eight styles — crowds read as a mix
// of individuals rather than eight clones on rotation.
const SKIN = [0xffd90f, 0xfdd835, 0xffe14d, 0xffd90f, 0xfdd835, 0xd7a55f, 0xa5673f];
const HAIR = [0x2a1e16, 0x101010, 0x6b4423, 0x2f5fd0, 0x8a8a8a, 0xc9a24b, 0xa8493f,
              0xd35d2b, 0xe8d06a, 0xe8e3d3, 0x7b4fa7];
const SHIRT = [0xffffff, 0x2f6fc4, 0x8ad14f, 0xe8532f, 0xf0b429, 0x7b4fa7, 0x59c9a5,
               0xe87ab0, 0xd0392b, 0x4f7d8c, 0x2b2f38, 0xc9863f, 0x9ad8ff, 0x2f6a52];
const PANTS = [0x2f3550, 0x3f5f8c, 0x5a4632, 0x4a4f58, 0x2f6a52, 0x6b5b45,
               0x8c3f5e, 0x1f2430, 0xc9ccd2];

const HAIR_STYLES = ['short','short','bald','tall','spiky','bun','bun',
                     'cap','cap','afro','long','mohawk'];
const BLUE_HAIR = 0x4a6fd8;
const CAP_COLS = [0xd0392b, 0x2f6fc4, 0x2f8f4f, 0xf0b429, 0x4a4f58];
// A hat replaces the hairstyle mesh rather than sitting on top of it: one instanced
// mesh per head is the whole design, and a fedora over an afro is a clipping fight
// nobody wins. Each gets its own palette — knitwear, felt and hi-vis do not share one.
const HATS = ['beanie', 'beanie', 'fedora', 'hardhat', 'cap'];
const BEANIE_COLS = [0xd0392b, 0x2f6a52, 0x7b4fa7, 0xf0b429, 0x4f7d8c, 0xe87ab0, 0xe8e3d3];
const FELT_COLS   = [0x5a4632, 0x2b2f38, 0x6b5b45, 0x8a8a8a, 0x3a3226];
const HIVIS_COLS  = [0xf0b429, 0xffffff, 0xe8532f, 0x2f6fc4];
const SPEC_COLS   = [0x2b2f38, 0x1f2430, 0xc9a24b, 0x8c1f1f, 0x4f7d8c];
// Everything below rolls on Math.random, not prng(): crowd looks are deliberate runtime
// variety (the `female` roll always was), and the seeded stream must never see them —
// one extra draw here and the whole town re-rolls.
const mpick = a => a[(Math.random()*a.length)|0];
function pickLook() {
  const female = Math.random() < 0.5;
  let style = rpick(HAIR_STYLES);
  if (!female && style === 'tall') style = 'short';
  if (!female && style === 'bun') style = Math.random() < 0.5 ? 'bald' : 'short';
  if (Math.random() < 0.24) style = mpick(HATS);
  const hair = style === 'tall'    ? BLUE_HAIR
             : style === 'cap'     ? rpick(CAP_COLS)
             : style === 'beanie'  ? mpick(BEANIE_COLS)
             : style === 'fedora'  ? mpick(FELT_COLS)
             : style === 'hardhat' ? mpick(HIVIS_COLS)
             : rpick(HAIR);
  return {
    shoulder: female ? rnd(0.44, 0.55) : rnd(0.56, 0.68),
    // depth, independent of width: a town of one build reads as clones however much
    // the heights vary, because the silhouette from the side never changes
    build: rnd(0.86, 1.28),
    tall: rnd(0.85, 1.15), style,
    // a striped shirt is the same torso mesh under a stripe texture, tinted by the same
    // instance colour — a whole second wardrobe for one draw call
    striped: Math.random() < 0.3,
    specs: Math.random() < 0.17 ? new THREE.Color(mpick(SPEC_COLS)) : null,
    skin:new THREE.Color(rpick(SKIN)), hair:new THREE.Color(hair),
    shirt:new THREE.Color(rpick(SHIRT)), pants:new THREE.Color(rpick(PANTS)),
    shoe:new THREE.Color(rpick([0x2b2f38, 0x1f2430, 0x5a3a2a, 0x8c1f1f, 0xe8e3d3])),
  };
}
function makeAvatar() {
  return {
    position:{x:0,y:0,z:0}, rotation:{x:0,y:0,z:0},
    userData:{ legL:{rotation:{x:0,z:0}}, legR:{rotation:{x:0,z:0}},
               armL:{rotation:{x:0,z:0}}, armR:{rotation:{x:0,z:0}}, phase: Math.random()*6.28 },
    look: pickLook(),
  };
}
const CROWD_MAX = 1400, CROWD_FAR = 190;
// Big overlapping eyeballs that sit proud of the head, and an overbite muzzle —
// the two features that read as "Simpsons" more than anything else.
const eyePair = merge([
  baked(new THREE.SphereGeometry(0.175, 16, 12), -0.125, 0, 0),
  baked(new THREE.SphereGeometry(0.175, 16, 12),  0.125, 0, 0),
]);
const pupilPair = merge([
  baked(new THREE.SphereGeometry(0.062, 16, 12), -0.125, 0, 0.13),
  baked(new THREE.SphereGeometry(0.062, 16, 12),  0.125, 0, 0.13),
]);
const muzzleGeo = new THREE.SphereGeometry(0.17, 16, 12).scale(1.45, 0.95, 1.15).translate(0, 1.585, 0.165);
const mouthGeo  = BOX(0.27, 0.055, 0.06).translate(0, 1.495, 0.315);
// hairstyles, one instanced mesh each; every townsperson writes to exactly one
// Hemispheres, not spheres: a full sphere hangs below the crown and reads as a beard.
const dome = (r, sy, y) => new THREE.SphereGeometry(r, 16, 12, 0, Math.PI*2, 0, Math.PI*0.52)
  .scale(1, sy, 1).translate(0, y, -0.01);
const hairShort = dome(0.295, 0.95, 1.72);
const hairTall  = merge([
  baked(new THREE.SphereGeometry(0.25, 16, 12).scale(1, 2.5, 1), 0, 2.6, -0.02),
  dome(0.285, 0.5, 1.74),
]);
const hairSpiky = merge(
  [[-0.21,0.08],[-0.08,0.15],[0.08,0.15],[0.21,0.08],[-0.13,-0.11],[0.13,-0.11]].map(([sx, sz]) =>
    baked(new THREE.ConeGeometry(0.1, 0.34, 16), sx, 2.05, sz, 0.22*sz, 0, -0.5*sx))
);
const hairBun   = merge([
  dome(0.29, 0.85, 1.72),
  baked(new THREE.SphereGeometry(0.17, 16, 12), 0, 2.06, -0.08),
]);
const hairBald  = merge([                       // just a ring round the sides
  baked(new THREE.TorusGeometry(0.26, 0.05, 6, 14), 0, 1.74, -0.02, Math.PI/2),
]);
const hairCap   = merge([                       // a ball cap: crown plus a brim
  dome(0.295, 0.75, 1.73),
  baked(BOX(0.4, 0.06, 0.3), 0, 1.8, 0.34),
]);
const hairAfro  = baked(new THREE.SphereGeometry(0.4, 16, 12), 0, 1.88, -0.02);
const hairLong  = merge([                       // crown with a curtain down the back
  dome(0.295, 0.95, 1.72),
  baked(BOX(0.5, 0.72, 0.16), 0, 1.42, -0.27),
]);
const hairMohawk = merge(
  [[-0.18, 0.22], [-0.06, 0.3], [0.06, 0.3], [0.18, 0.22]].map(([sz, h]) =>
    baked(BOX(0.09, h, 0.15), 0, 1.95 + h/2 - 0.1, sz - 0.02))
);
// Hats. Each has to clear the r 0.28 skull the way the hairstyles do, and each needs a
// silhouette that reads at fifty metres — a brim, a roll, a peak — because at that range
// the colour is all you get otherwise.
const hairBeanie = merge([
  dome(0.305, 0.92, 1.72),
  baked(new THREE.TorusGeometry(0.288, 0.055, 8, 18), 0, 1.75, -0.01, Math.PI/2),   // turned-up roll
  baked(new THREE.SphereGeometry(0.07, 10, 8), 0, 2.06, -0.01),                     // bobble
]);
const hairFedora = merge([
  dome(0.275, 0.66, 1.75),
  baked(new THREE.CylinderGeometry(0.47, 0.5, 0.05, 20), 0, 1.79, -0.01),           // brim
  baked(new THREE.CylinderGeometry(0.285, 0.285, 0.07, 18), 0, 1.83, -0.01),        // band
]);
const hairHardhat = merge([
  dome(0.3, 0.82, 1.71),
  baked(BOX(0.07, 0.1, 0.5), 0, 1.95, -0.01),                                       // centre ridge
  baked(new THREE.CylinderGeometry(0.34, 0.34, 0.05, 18, 1, false, -0.9, 1.8), 0, 1.74, 0.02),  // front peak
]);
// Glasses sit on the front of the eyeballs, which bulge proud of the face — a ring at
// z 0.33 clears a 0.175 eye centred at 0.185 with a couple of millimetres to spare.
const glassesGeo = merge([
  baked(new THREE.TorusGeometry(0.132, 0.021, 6, 16), -0.125, 1.85, 0.325),
  baked(new THREE.TorusGeometry(0.132, 0.021, 6, 16),  0.125, 1.85, 0.325),
  baked(BOX(0.1, 0.03, 0.028), 0, 1.85, 0.325),                                     // bridge
  baked(BOX(0.028, 0.028, 0.2), -0.252, 1.86, 0.23),                                // arms back to the ears
  baked(BOX(0.028, 0.028, 0.2),  0.252, 1.86, 0.23),
]);
const texShirtStripe = surfCanvas(64, (g, P) => {
  for (let i = 0; i < 10; i += 2) { g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(0, i*P/10, P, P/10); }
});
// a rounded toe on the shoe: a small merge that stops the crowd reading as a pile of
// rectangles once you are close enough to see them
const shoeGeo = merge([
  BOX(0.25, 0.13, 0.36).translate(0, -0.87, 0.07),
  baked(new THREE.SphereGeometry(0.125, 12, 8).scale(1, 0.62, 1), 0, -0.87, 0.24),
]);
// The arm is sleeve only. The hand used to be merged into it, which meant every hand
// in town was the colour of its owner's shirt — invisible at a distance, glaring the
// moment you shoulder past someone. It is its own mesh now, drawn with the arm's
// matrix (so it swings for free) but coloured skin.
const armGeo = BOX(0.16, 0.58, 0.16).translate(0, -0.29, 0);
const handGeo = baked(new THREE.SphereGeometry(0.105, 12, 9).scale(1, 0.92, 0.8), 0, -0.62, 0);
// The head is what every camera angle puts front and centre, so it carries the most
// detail: an egg rather than a ball, ears, and a neck. The neck is the one that does
// the work — without it the head visibly floats a centimetre above the collar.
// (The skull stays a true sphere at r 0.28. Egg-shaping it by 6% in Y pushed the crown
// through every one of the nine hairstyles, which are all cut to fit this radius.)
const headGeo = merge([
  baked(new THREE.SphereGeometry(0.28, 22, 16), 0, 1.72, 0),
  baked(new THREE.SphereGeometry(0.085, 12, 9).scale(0.5, 1.05, 0.85), -0.272, 1.70, -0.015),
  baked(new THREE.SphereGeometry(0.085, 12, 9).scale(0.5, 1.05, 0.85),  0.272, 1.70, -0.015),
  baked(new THREE.CylinderGeometry(0.115, 0.14, 0.18, 14), 0, 1.43, -0.01),
]);
// Eyebrows, hair-coloured, sitting on the upper curve of the eyeballs. Two small
// wedges are the cheapest expression in the game: without them a face is two eyes and
// a mouth, and the whole crowd reads blank.
const browGeo = merge([
  baked(BOX(0.17, 0.042, 0.085), -0.128, 2.008, 0.185, -0.2, 0,  0.11),
  baked(BOX(0.17, 0.042, 0.085),  0.128, 2.008, 0.185, -0.2, 0, -0.11),
]);
// The torso is scaled on X per person (shoulder width), so everything merged into it
// has to squash gracefully — which rules out anything round. A collar band, a shoulder
// shelf and a shirt hem overhanging the trousers are all boxes, and all scale right.
const torsoGeo = merge([
  BOX(1, 0.62, 0.3).translate(0, 1.16, 0),
  BOX(0.88, 0.09, 0.315).translate(0, 1.5, 0),        // shoulder shelf
  BOX(0.44, 0.075, 0.335).translate(0, 1.525, 0.005), // collar band
  BOX(1.05, 0.07, 0.335).translate(0, 0.875, 0),      // hem, sitting proud of the waist
]);
// One shared white toon material for every crowd part — its own object, not the
// toon() cache's white, so the rim lands on people and never on white buildings.
const crowdToon = addRim(new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: RAMP }));
const CI = {
  legL:  instanced(BOX(0.2, 0.85, 0.2).translate(0,-0.425,0), crowdToon, CROWD_MAX),
  legR:  instanced(BOX(0.2, 0.85, 0.2).translate(0,-0.425,0), crowdToon, CROWD_MAX),
  shoeL: instanced(shoeGeo, crowdToon, CROWD_MAX),
  shoeR: instanced(shoeGeo, crowdToon, CROWD_MAX),
  torso: instanced(torsoGeo, crowdToon, CROWD_MAX),
  torsoS:instanced(torsoGeo, addRim(new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: RAMP, map: texShirtStripe })), CROWD_MAX),
  armL:  instanced(armGeo, crowdToon, CROWD_MAX),
  armR:  instanced(armGeo, crowdToon, CROWD_MAX),
  // both hands share one mesh at twice the capacity — a left and a right hand are the
  // same object with different matrices, so two draw calls would buy nothing
  hands: instanced(handGeo, crowdToon, CROWD_MAX*2),
  head:  instanced(headGeo, crowdToon, CROWD_MAX),
  muzzle:instanced(muzzleGeo, crowdToon, CROWD_MAX),
  brow:  instanced(browGeo, crowdToon, CROWD_MAX),
  mouth: instanced(mouthGeo, new THREE.MeshBasicMaterial({ color:0x7a3b34 }), CROWD_MAX, false),
  eyes:  instanced(baked(eyePair, 0, 1.85, 0.185), new THREE.MeshToonMaterial({ color:0xffffff, gradientMap:RAMP }), CROWD_MAX),
  pupil: instanced(baked(pupilPair, 0, 1.85, 0.185), new THREE.MeshBasicMaterial({ color:0x14192e }), CROWD_MAX, false),
  hairShort: instanced(hairShort, crowdToon, CROWD_MAX),
  hairTall:  instanced(hairTall,  crowdToon, CROWD_MAX),
  hairSpiky: instanced(hairSpiky, crowdToon, CROWD_MAX),
  hairBun:   instanced(hairBun,   crowdToon, CROWD_MAX),
  hairBald:  instanced(hairBald,  crowdToon, CROWD_MAX),
  hairCap:   instanced(hairCap,   crowdToon, CROWD_MAX),
  hairAfro:  instanced(hairAfro,  crowdToon, CROWD_MAX),
  hairLong:  instanced(hairLong,  crowdToon, CROWD_MAX),
  hairMohawk:instanced(hairMohawk,crowdToon, CROWD_MAX),
  hairBeanie: instanced(hairBeanie,  crowdToon, CROWD_MAX),
  hairFedora: instanced(hairFedora,  crowdToon, CROWD_MAX),
  hairHardhat:instanced(hairHardhat, crowdToon, CROWD_MAX),
  glasses:   instanced(glassesGeo, crowdToon, CROWD_MAX, false),
};
const HAIR_MESH = { short:'hairShort', tall:'hairTall', spiky:'hairSpiky', bun:'hairBun', bald:'hairBald',
                    cap:'hairCap', afro:'hairAfro', long:'hairLong', mohawk:'hairMohawk',
                    beanie:'hairBeanie', fedora:'hairFedora', hardhat:'hairHardhat' };
for (const k in CI) {
  CI[k].count = 0;
  // setColorAt allocates a zero-filled buffer, i.e. every instance starts BLACK.
  // Parts that never get an explicit colour (eyes) came out as dark masks.
  CI[k].setColorAt(0, new THREE.Color(0xffffff));
  CI[k].instanceColor.array.fill(1);
  CI[k].instanceColor.needsUpdate = true;
  scene.add(CI[k]);
}
const rootM = new THREE.Matrix4(), partM = new THREE.Matrix4(), cCnt = {};
function renderCrowd(sub) {
  for (const k in CI) cCnt[k] = 0;
  const gazeT = performance.now() * 0.001;
  const put2 = (key, col, px, py, pz, rx, rz, sx, sz) => {
    const mesh = CI[key], i = cCnt[key];
    if (i >= mesh.instanceMatrix.count) return;      // hands hold two per person
    dummy.position.set(px, py, pz); dummy.rotation.set(rx||0, 0, rz||0);
    dummy.scale.set(sx||1, 1, sz||1); dummy.updateMatrix();
    mesh.setMatrixAt(i, partM.multiplyMatrices(rootM, dummy.matrix));
    if (col) mesh.setColorAt(i, col);
    cCnt[key] = i+1;
  };
  const drawFig = g => {
    const L = g.look, u = g.userData, sh = L.shoulder;
    dummy.position.set(g.position.x, g.position.y, g.position.z);
    dummy.rotation.set(g.rotation.x, g.rotation.y, g.rotation.z);
    dummy.scale.set(1, L.tall, 1); dummy.updateMatrix(); rootM.copy(dummy.matrix);
    put2(L.striped ? 'torsoS' : 'torso', L.shirt, 0,0,0, 0,0, sh, L.build);
    put2('head',  L.skin,  0,0,0);
    put2('muzzle',L.skin,  0,0,0);
    put2('mouth', null,    0,0,0);
    put2('eyes',  null,    0,0,0);
    // The pupils are the same mesh every frame, just parked a few millimetres off
    // centre — so a slow wander costs nothing and stops fourteen hundred people
    // staring dead ahead in unison. Everyone drifts on their own phase.
    const gx = Math.sin(gazeT * 0.53 + u.phase) * 0.035;
    const gy = Math.sin(gazeT * 0.37 + u.phase * 1.7) * 0.018;
    put2('pupil', null, gx, gy, 0);
    put2('brow', L.hair, 0,0,0);
    put2(HAIR_MESH[L.style], L.hair, 0,0,0);
    if (L.specs) put2('glasses', L.specs, 0,0,0);
    put2('legL', L.pants, -0.14, 0.86, 0, u.legL.rotation.x);
    put2('legR', L.pants,  0.14, 0.86, 0, u.legR.rotation.x);
    put2('shoeL', L.shoe, -0.14, 0.86, 0, u.legL.rotation.x);
    put2('shoeR', L.shoe,  0.14, 0.86, 0, u.legR.rotation.x);
    put2('armL', L.shirt, -sh/2-0.06, 1.42, 0, u.armL.rotation.x, u.armL.rotation.z);
    put2('armR', L.shirt,  sh/2+0.06, 1.42, 0, u.armR.rotation.x, u.armR.rotation.z);
    // hands ride the arms' own matrices, so they swing without any extra maths
    put2('hands', L.skin, -sh/2-0.06, 1.42, 0, u.armL.rotation.x, u.armL.rotation.z);
    put2('hands', L.skin,  sh/2+0.06, 1.42, 0, u.armR.rotation.x, u.armR.rotation.z);
  };
  for (const p of peds) {
    const g = p.g, dx = g.position.x - sub.x, dz = g.position.z - sub.z;
    if (dx*dx + dz*dz > CROWD_FAR*CROWD_FAR) continue;
    drawFig(g);
  }
  // room staff: static figures with a small idle sway; seated ones fold at the hip,
  // dancers get the full disco arms. Culled tight — they only matter indoors.
  const tS = performance.now() * 0.001;
  for (const s of staff) {
    const g = s.g; if (!g) continue;
    const dx = g.position.x - sub.x, dz = g.position.z - sub.z;
    if (dx*dx + dz*dz > 70*70) continue;
    const u = g.userData, sway = Math.sin(tS*1.7 + u.phase) * 0.07;
    u.armL.rotation.z = u.armR.rotation.z = 0;
    if (s.pose === 'sit') {
      u.legL.rotation.x = u.legR.rotation.x = -1.5;
      u.armL.rotation.x = u.armR.rotation.x = -0.85 + sway;
    } else if (s.pose === 'dance') {
      const beat = Math.sin(tS*5.2 + u.phase);
      u.legL.rotation.x = u.legR.rotation.x = 0;
      u.armL.rotation.x = u.armR.rotation.x = -2.6;
      u.armL.rotation.z = 0.5 + beat*0.4; u.armR.rotation.z = -0.5 - beat*0.4;
      g.rotation.y = s.yaw + beat*0.35;
      g.position.y = Math.abs(beat)*0.12;
    } else {
      u.legL.rotation.x = u.legR.rotation.x = 0;
      u.armL.rotation.x = sway; u.armR.rotation.x = -sway;
    }
    drawFig(g);
  }
  for (const k in CI) {
    CI[k].count = cCnt[k];
    CI[k].instanceMatrix.needsUpdate = true;
    if (CI[k].instanceColor) CI[k].instanceColor.needsUpdate = true;
  }
}

const peds = [];
const makeRag = () => ({ active:false, down:false, settle:0, vel:new THREE.Vector3(), spin:new THREE.Vector3() });
const SIDEWALK = ROAD_HW + 3.2;
function pedPlace(p) {
  const e = NET.edges[p.ei], d = edgeDir(e, p.from), A = NET.nodes[p.from];
  const lat = p.lat || SIDEWALK;         // everyone owns a lane across the pavement width
  p.g.position.x = A.x + d.dx*p.dist - d.dz*p.side*lat + (p.ox || 0);
  p.g.position.z = A.z + d.dz*p.dist + d.dx*p.side*lat + (p.oz || 0);
  p.g.position.y = 0;
  p.g.rotation.y = Math.atan2(d.dx, d.dz);
}
// Nobody walks the ring highway: it has no pavement, and a pedestrian on the hard
// shoulder of a 40 m/s road is both a hazard to the traffic sim and plainly absurd.
// pickNext is shared with cars and happily turns onto a spur, which is how walkers
// were ending up out there.
function pedNext(node, cur, dx, dz) {
  const n = pickNext(node, cur, dx, dz);
  if (!NET.edges[n].hw) return n;
  const town = NET.nodes[node].e.filter(ei => !NET.edges[ei].hw && ei !== cur);
  if (town.length) return town[(Math.random()*town.length)|0];
  return cur;                                    // highway-only junction: about-face
}
function attachPed(p) {
  if (p.stroll) { p.stroll = null; strollers--; }
  const ni = nearestNode(p.g.position.x, p.g.position.z); if (ni < 0) return;
  let opts = NET.nodes[ni].e.filter(ei => !NET.edges[ei].hw);
  if (!opts.length) opts = WALKABLE;              // stranded on the ring — rejoin the town
  p.ei = opts[(Math.random()*opts.length)|0];
  p.from = ni;
  // rejoin the lane at the point nearest where they are, not at the junction — snapping
  // to the node made anyone who got up after a knockdown look like they vanished
  const e = NET.edges[p.ei], d = edgeDir(e, p.from), A = NET.nodes[p.from];
  const proj = (p.g.position.x - A.x)*d.dx + (p.g.position.z - A.z)*d.dz;
  p.dist = THREE.MathUtils.clamp(proj, 0, e.len);
  const lat = -(p.g.position.x - A.x)*d.dz + (p.g.position.z - A.z)*d.dx;
  p.side = lat >= 0 ? 1 : -1;
  p.ox = 0; p.oz = 0;
  p.cross = null; p.g.rotation.x = 0; p.g.rotation.z = 0;
  pedPlace(p);
}
const WALKABLE = [];
for (let i = 0; i < NET.edges.length; i++) if (!NET.edges[i].hw) WALKABLE.push(i);
for (let i = 0; i < 1600; i++) {
  const ei = WALKABLE[(Math.random()*WALKABLE.length)|0], e = NET.edges[ei];
  const p = { g: makeAvatar(), ei, from: Math.random()<0.5?e.a:e.b, side: Math.random()<0.5?1:-1,
    dist: Math.random()*e.len, speed: rnd(1.1, 2.0), cross:null, rag:makeRag(), flee:null,
    angry: 0, swing: 0, ox: 0, oz: 0, spooked: null };
  // Spread across the pavement instead of walking single file. Derived from the walk
  // phase makeAvatar already rolled, so no extra seeded randoms are drawn here.
  p.lat = SIDEWALK - 1.2 + (p.g.userData.phase / 6.283) * 2.4;
  pedPlace(p); peds.push(p);
}
// Places worth wandering to on foot: the parks, the riverside greens, the plaza.
const STROLL_RECTS = BLOCKS.filter(b => ['park', 'riverpark', 'plaza'].includes(b.zone)).map(b => b.r);
let strollers = 0;
function strollTarget(s) {              // a clear patch of grass inside the chosen block
  for (let k = 0; k < 8; k++) {
    const x = rnd(s.r.x0 + 3, s.r.x1 - 3), z = rnd(s.r.z0 + 3, s.r.z1 - 3);
    if (onRoad(x, z, 2.5) || pointBlocked(x, z, 1) || overRiver(x, z, 10)) continue;
    s.tx = x; s.tz = z; return true;
  }
  return false;
}
// The room staff get their bodies here rather than in the interiors pass — pickLook's
// palettes aren't initialised that early in the file — and rngNeutral keeps their
// random looks from moving the seeded stream everything after this is built from.
rngNeutral(() => {
  for (const s of staff) {
    const g = makeAvatar();
    g.position.x = s.x; g.position.z = s.z;
    g.position.y = s.pose === 'sit' ? -0.34 : 0;   // fold at the hip onto the seat
    g.rotation.y = s.yaw;
    const L = g.look, o = s.look || {};
    if (o.style) L.style = o.style;
    if (o.shoulder) L.shoulder = o.shoulder;
    for (const k of ['skin', 'hair', 'shirt', 'pants', 'shoe'])
      if (o[k] !== undefined) L[k] = new THREE.Color(o[k]);
    s.g = g;
  }
});
function walkAnim(g, dt, rate, amp) {
  const u = g.userData; u.phase += dt*rate;
  const sw = Math.sin(u.phase)*amp;
  u.legL.rotation.x = sw; u.legR.rotation.x = -sw;
  u.armL.rotation.x = -sw; u.armR.rotation.x = sw;
}
function setFlee(p, fx, fz) {
  const dx = p.g.position.x-fx, dz = p.g.position.z-fz, L = Math.hypot(dx,dz)||1;
  p.flee = { t: rnd(3.5, 6), dx: dx/L, dz: dz/L };
}
function updatePeds(dt) {
  for (const p of peds) {
    if (p.rag.active) {
      if (updateRag(p.g, p.rag, dt)) {
        if (p.spooked) { setFlee(p, p.spooked.x, p.spooked.z); p.spooked = null; }
        else attachPed(p);
      }
      continue;
    }
    if (p.angry > 0 && updateAngry(p, dt)) continue;
    if (p.flee && p.flee.t > 0) {
      p.flee.t -= dt;
      const res = collideCircle(p.g.position.x + p.flee.dx*11*dt, p.g.position.z + p.flee.dz*11*dt, 0.6, colliders);
      if (res.hit) { const a = Math.atan2(p.flee.dx, p.flee.dz) + (Math.random()<0.5?1:-1)*1.1; p.flee.dx = Math.sin(a); p.flee.dz = Math.cos(a); }
      p.g.position.x = res.x; p.g.position.z = res.z;
      p.g.rotation.y = Math.atan2(p.flee.dx, p.flee.dz);
      walkAnim(p.g, dt, 16, 0.95);
      if (p.flee.t <= 0) { p.flee = null; attachPed(p); }
      continue;
    }
    if (p.stroll) {
      // off the pavement, ambling toward a spot in a park. Free movement like a flee,
      // but at walking pace; a bump steers them around whatever they hit.
      const s = p.stroll;
      s.t -= dt;
      const dx = s.tx - p.g.position.x, dz = s.tz - p.g.position.z, d = Math.hypot(dx, dz);
      if (d < 1.2 || s.t <= 0) {
        if (s.t > 0 && s.legs > 0 && strollTarget(s)) s.legs--;
        else { attachPed(p); continue; }
      }
      const a = Math.atan2(dx, dz) + (s.veer || 0);
      const sp = p.speed * 0.9;
      const res = collideCircle(p.g.position.x + Math.sin(a)*sp*dt, p.g.position.z + Math.cos(a)*sp*dt, 0.6, colliders);
      if (res.hit) s.veer = THREE.MathUtils.clamp((s.veer || 0) + (Math.random() < 0.5 ? 1.1 : -1.1), -2.4, 2.4);
      else s.veer = (s.veer || 0) * (1 - Math.min(1, dt*2));
      p.g.position.x = res.x; p.g.position.z = res.z;
      p.g.rotation.y = a;
      walkAnim(p.g, dt, 7.5, 0.55);
      // Cars yield to anyone in their lane, so a stroller ambling *along* a carriageway
      // is a rolling roadblock. Crossing is fine; loitering on the tarmac is not —
      // more than a few seconds on it and they give up and rejoin the pavement.
      if (onRoad(res.x, res.z, 0.5)) {
        s.roadT = (s.roadT || 0) + dt;
        if (s.roadT > 4.5) { attachPed(p); continue; }
      } else s.roadT = 0;
      continue;
    }
    if (p.cross) {
      const c = p.cross;
      c.t = Math.min(1, c.t + dt/c.dur);
      p.g.position.x = c.x0 + (c.x1-c.x0)*c.t;
      p.g.position.z = c.z0 + (c.z1-c.z0)*c.t;
      p.g.rotation.y = c.yaw;
      walkAnim(p.g, dt, 10, 0.65);
      if (c.t >= 1) { p.side = -p.side; p.cross = null; }
      continue;
    }
    let e = NET.edges[p.ei];
    p.dist += p.speed*dt;
    if (p.dist >= e.len) {
      const d = edgeDir(e, p.from), n = NET.nodes[d.to];
      // walking on past the junction means crossing the other street: wait for the green
      // that runs along your own direction, which is when the cross traffic is stopped
      if (lightGreen !== e.axis && trafficNear(n.x, n.z, 16)) {
        p.dist = Math.max(0, e.len - CROSS_AT);
        pedPlace(p); walkAnim(p.g, dt, 2.5, 0.05);
        continue;
      }
      p.dist -= e.len;
      const next = pedNext(d.to, p.ei, d.dx, d.dz);
      p.from = d.to; p.ei = next; e = NET.edges[next];
      if (p.dist >= e.len) p.dist = 0;
      // step out onto the zebra?
      const nd = edgeDir(e, p.from), A = NET.nodes[p.from];
      const at = Math.min(CROSS_AT, e.len*0.5);
      const bx = A.x + nd.dx*at, bz = A.z + nd.dz*at;
      if (Math.random() < 0.5 && lightGreen !== e.axis && !trafficNear(bx, bz, 9)) {
        p.dist = at;
        const lat = p.lat || SIDEWALK;   // cross from and to their own pavement lane
        p.cross = { t:0, dur:(2*lat)/2.5, yaw: Math.atan2(nd.dz*p.side, -nd.dx*p.side),
          x0: bx - nd.dz*p.side*lat, z0: bz + nd.dx*p.side*lat,
          x1: bx + nd.dz*p.side*lat, z1: bz - nd.dx*p.side*lat };
        continue;
      }
    }
    pedPlace(p);
    walkAnim(p.g, dt, 7.5, 0.55);
  }
  // Now and then somebody peels off the pavement and heads into a park. One lottery
  // ticket a frame keeps the cost flat; the cap keeps the lawns busy, not mobbed.
  if (STROLL_RECTS.length && strollers < 130) {
    const c = peds[(Math.random()*peds.length)|0];
    if (!c.rag.active && !c.angry && !c.flee && !c.cross && !c.stroll) {
      const px = c.g.position.x, pz = c.g.position.z;
      for (const r of STROLL_RECTS) {
        const cx = (r.x0 + r.x1)/2, cz = (r.z0 + r.z1)/2;
        if ((px-cx)**2 + (pz-cz)**2 > 60*60) continue;
        const s = { r, legs: 1 + (Math.random()*2|0), t: rnd(25, 45), veer: 0 };
        if (strollTarget(s)) { c.stroll = s; strollers++; }
        break;
      }
    }
  }
  rebuildPedGrid();
  separatePeds(mode === 'car' ? car.position : player.position);
  pedsVsSolids(mode === 'car' ? car.position : player.position);
  if (angerToast > 0) angerToast -= dt;
}

// ragdolls
const playerRag = makeRag();
function applyRagdoll(g, rag, dx, dz, speed) {
  if (rag.active) return;
  rag.active = true; rag.down = false; rag.settle = 0;
  // which way they end up flat: shoved from behind → face-down, from the front → on the back
  const fdot = Math.sin(g.rotation.y)*dx + Math.cos(g.rotation.y)*dz;
  rag.flatX = (fdot >= 0 ? 1 : -1) * 1.45;
  const s = Math.min(Math.abs(speed), 45);
  const horiz = 0.4 + s*0.14, vert = 1.4 + s*0.15, L = Math.hypot(dx,dz)||1;
  rag.vel.set(dx/L*horiz + rnd(-0.6,0.6), vert, dz/L*horiz + rnd(-0.6,0.6));
  rag.spin.set(rnd(-1,1)*(1+s*0.24), rnd(-1,1)*(0.6+s*0.12), rnd(-1,1)*(1+s*0.24));
}
function updateRag(g, rag, dt) {
  // Once settled, recovery gets the body to itself. The physics below clamps y to 0.35
  // on ground contact, and the recovery lerp pulls y toward 0 — run both and the clamp
  // wins every frame, y never reaches the get-up threshold, and nobody knocked down
  // ever stood up again. (A pre-existing bug: it was invisible until people needed to
  // get up and run away.)
  if (rag.settle > 1.6) {
    const k = Math.min(1, dt*3);
    const u = g.userData;
    g.rotation.x += -g.rotation.x*k; g.rotation.z += -g.rotation.z*k; g.position.y += -g.position.y*k;
    u.legL.rotation.x *= 0.8; u.legR.rotation.x *= 0.8;
    u.armL.rotation.x *= 0.8; u.armR.rotation.x *= 0.8;
    u.armL.rotation.z *= 0.8; u.armR.rotation.z *= 0.8;
    if (Math.abs(g.rotation.x) < 0.06 && Math.abs(g.rotation.z) < 0.06 && g.position.y < 0.06) {
      rag.active = false; g.rotation.x = 0; g.rotation.z = 0; g.position.y = 0;
      u.armL.rotation.x = 0; u.armL.rotation.z = 0; u.armR.rotation.x = 0; u.armR.rotation.z = 0;
      return true;
    }
    return false;
  }
  rag.vel.y -= 26*dt;
  g.position.x += rag.vel.x*dt; g.position.y += rag.vel.y*dt; g.position.z += rag.vel.z*dt;
  g.rotation.x += rag.spin.x*dt; g.rotation.y += rag.spin.y*dt; g.rotation.z += rag.spin.z*dt;
  if (g.position.y <= 0.35) {
    g.position.y = 0.35;
    if (rag.vel.y < 0) rag.vel.y *= -0.35;
    rag.vel.x *= 0.7; rag.vel.z *= 0.7; rag.spin.multiplyScalar(0.55); rag.down = true;
    // settle flat on the ground rather than wherever the spin happened to leave them
    g.rotation.x += ((rag.flatX || 1.45) - g.rotation.x) * Math.min(1, dt*6);
    g.rotation.z += -g.rotation.z * Math.min(1, dt*4);
    if (rag.vel.lengthSq() < 1.6 && (Math.abs(rag.spin.x)+Math.abs(rag.spin.z)) < 0.7) rag.settle += dt;
  }
  const u = g.userData, fl = Math.min(1.4, rag.vel.length()*0.35);
  u.legL.rotation.x = Math.sin(g.position.x*4)*fl; u.legR.rotation.x = -Math.sin(g.position.z*4)*fl;
  u.armL.rotation.x = -1.1*fl; u.armR.rotation.x = 1.0*fl;
  u.armL.rotation.z = 0.5*fl;  u.armR.rotation.z = -0.5*fl;
  return false;
}
function hitPeopleAt(x, z, dx, dz, speed, radius, byPlayer) {
  const r2 = radius*radius;
  const gx = Math.floor(x/GAP_Q), gz = Math.floor(z/GAP_Q);
  for (let ox=-1; ox<=1; ox++) for (let oz=-1; oz<=1; oz++) {
    const b = pedGrid.get((gx+ox)+','+(gz+oz)); if (!b) continue;
    for (const p of b) {
      if (p.rag.active) continue;
      const ex = p.g.position.x-x, ez = p.g.position.z-z;
      if (ex*ex + ez*ez < r2) {
        applyRagdoll(p.g, p.rag, dx, dz, speed);
        if (byPlayer) { addCoins(2); shake = Math.min(1.4, shake + 0.3); chaosHit(10);
          p.spooked = { x, z }; sayOuch('car'); }
      }
    }
  }
  if (mode === 'foot' && !playerRag.active) {
    const ex = player.position.x-x, ez = player.position.z-z;
    if (ex*ex + ez*ez < r2) applyRagdoll(player, playerRag, dx, dz, speed);
  }
}

// =================================================================
//  PLAYER
// =================================================================
function buildPlayerCar(type, color) {
  const g = carGeo(type), grp = new THREE.Group();
  const mk = (geo, mat) => {
    if (!geo) return null;
    const m = new THREE.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true; grp.add(m);
    return m;
  };
  mk(g.paint, addRim(new THREE.MeshToonMaterial({ color, gradientMap: RAMP })));
  mk(g.dark, VEH_MATS.dark);
  mk(g.chrome, VEH_MATS.chrome);
  mk(g.glass, VEH_MATS.glass);
  mk(g.lamp, VEH_MATS.lamp);
  tagNoInk(grp);                     // the glass, so the windscreen isn't outlined
  return grp;
}
const car = new THREE.Group(); scene.add(car);
// YXZ so mid-air pitch (rotation.x) tips the nose whatever the heading — with the
// default XYZ order the pitch axis is the world's, and a car heading along X rolls
// instead. With x=0 the two orders compose identically, so nothing else moves.
car.rotation.order = 'YXZ';
let carRig = null, carType = 'convert';
let riderSeat = null;                    // set once the rider is built (see seatRider)
function setPlayerCar(type, color) {
  if (carRig) car.remove(carRig);
  carType = type; carRig = buildPlayerCar(type, color); car.add(carRig);
  if (riderSeat) riderSeat(type);        // null until the rider exists, below
}
setPlayerCar('convert', 0xf07ab0);

// the visible driver, a full mesh rather than an instance
function buildPerson(look) {
  const g = new THREE.Group();
  const put3 = (geo, color) => {
    const m = new THREE.Mesh(geo, addRim(new THREE.MeshToonMaterial({ color, gradientMap: RAMP })));
    m.castShadow = true; g.add(m);
    return m;
  };
  // the hero is built from the same geometry as the crowd, so he doesn't look like a
  // visitor from a different game the moment he stands next to somebody
  put3(torsoGeo.clone().scale(0.62, 1, 1), look.shirt);
  put3(headGeo.clone(), look.skin);
  put3(muzzleGeo.clone(), look.skin);
  const style = look.style || 'short';
  const HG = { short:hairShort, tall:hairTall, spiky:hairSpiky, bun:hairBun, bald:hairBald };
  put3((HG[style] || hairShort).clone(), look.hair);
  put3(browGeo.clone(), look.hair);
  g.add(new THREE.Mesh(mouthGeo.clone(), new THREE.MeshBasicMaterial({ color:0x7a3b34 })));
  g.add(new THREE.Mesh(baked(eyePair, 0, 1.85, 0.185), new THREE.MeshToonMaterial({ color:0xffffff, gradientMap:RAMP })));
  g.add(new THREE.Mesh(baked(pupilPair, 0, 1.85, 0.185), new THREE.MeshBasicMaterial({ color:0x14192e })));
  const limb = (px, color, w, len, top, hand) => {
    const j = new THREE.Group(); j.position.set(px, top, 0);
    const geo = BOX(w, len, w).translate(0, -len/2, 0);
    const m = new THREE.Mesh(geo, addRim(new THREE.MeshToonMaterial({ color, gradientMap: RAMP })));
    m.castShadow = true; j.add(m);
    if (hand) {                       // skin, not sleeve — same split as the crowd
      const h = new THREE.Mesh(handGeo.clone().translate(0, 0.62 - len - 0.04, 0),
        addRim(new THREE.MeshToonMaterial({ color: look.skin, gradientMap: RAMP })));
      h.castShadow = true; j.add(h);
    }
    g.add(j); return j;
  };
  const legL = limb(-0.14, look.pants, 0.2, 0.85, 0.86);
  const legR = limb( 0.14, look.pants, 0.2, 0.85, 0.86);
  for (const lg of [legL, legR]) {
    const sh2 = new THREE.Mesh(shoeGeo.clone(), addRim(new THREE.MeshToonMaterial({ color: look.shoe || 0x2b2f38, gradientMap: RAMP })));
    sh2.castShadow = true; lg.add(sh2);
  }
  const armL = limb(-0.37, look.shirt, 0.16, 0.58, 1.42, true);
  const armR = limb( 0.37, look.shirt, 0.16, 0.58, 1.42, true);
  g.userData = { legL, legR, armL, armR, phase: 0 };
  return g;
}
const HERO_LOOK = { skin:0xffd90f, hair:0x2a1e16, shirt:0xffffff, pants:0x2f6fc4, shoe:0x2b2f38, style:'short' };
const player = buildPerson(HERO_LOOK);
player.visible = false; scene.add(player);
const playerVel = new THREE.Vector3();
let playerOnGround = true, canDouble = false;
let chuteReady = false, chuteOpen = false;      // bail out of the plane, then pull the chute
const CHUTE_FALL = 4.5;                          // terminal descent under the open canopy (m/s)

// The rider sitting in the player's car. He used to be parked at one fixed height that
// suited the convertible, so in anything with a roof his head went straight through the
// headlining — the sedan's roof is at 2.29 and his crown was at 2.46. He is now *seated*
// (folded at the hip, hands up on the wheel, which is what he should always have been)
// and the seat drops per car type until the crown clears the roof.
const rider = buildPerson(HERO_LOOK);
rider.scale.setScalar(0.92); car.add(rider);
{
  const u = rider.userData;
  u.legL.rotation.x = u.legR.rotation.x = -1.45;      // knees up, into the footwell
  u.armL.rotation.x = u.armR.rotation.x = -1.15;      // hands on the wheel
  u.armL.rotation.z = 0.18; u.armR.rotation.z = -0.18;
}
const RIDER_CROWN = 2.02 * 0.92;                      // head top in car-local units
function seatRider(type) {
  const s = CAR_TYPES[type] || CAR_TYPES.sedan;
  const roof = s.clr + s.bodyH + s.roofH;
  // open-top cars keep him sitting high and proud; roofed ones drop him until he fits
  const y = s.roofH > 0.05 ? Math.min(0.62, roof - 0.14 - RIDER_CROWN) : 0.62;
  rider.position.set(0, y, -0.35);
}
riderSeat = seatRider;
seatRider(carType);                      // the opening car was built before the rider existed

// blob shadows under the hero objects
function blobShadow(size) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), grd = g.createRadialGradient(32,32,0,32,32,32);
  grd.addColorStop(0,'rgba(0,0,0,.5)'); grd.addColorStop(1,'rgba(0,0,0,0)');
  g.fillStyle = grd; g.fillRect(0,0,64,64);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({ map:new THREE.CanvasTexture(c), transparent:true, depthWrite:false }));
  m.rotation.x = -Math.PI/2; scene.add(m); return m;
}
const carShadow = blobShadow(8), playerShadow = blobShadow(2.6);

// the eject parachute — a canopy dome with a cone of shroud lines, floated above the
// player while it's open and hidden the rest of the time
const chute = new THREE.Group();
{
  const canopy = new THREE.Mesh(
    new THREE.SphereGeometry(2.7, 18, 10, 0, Math.PI*2, 0, Math.PI*0.52),
    new THREE.MeshToonMaterial({ color: 0xe8532f, gradientMap: RAMP, side: THREE.DoubleSide }));
  canopy.position.y = 3.4; chute.add(canopy);
  const shroud = new THREE.Mesh(new THREE.ConeGeometry(2.5, 2.5, 12, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x2b2f38, wireframe: true }));
  shroud.position.y = 2.05; shroud.rotation.x = Math.PI;   // base up at the canopy, apex at the pilot
  chute.add(shroud);
}
chute.visible = false; scene.add(chute);

// =================================================================
//  INPUT
// =================================================================
const keys = {};
let mode = 'car';
// Pause: the sim runs on dt, so a paused game is just dt forced to 0 — everything
// keeps rendering exactly where it stands, and there is no resume bookkeeping.
let paused = false;
const helpEl = document.getElementById('help');
function togglePause() {
  paused = !paused;
  helpEl.classList.toggle('show', paused);
  if (paused) {
    const tr = document.getElementById('trophies').textContent;
    helpEl.querySelector('.obj').innerHTML =
      (missionHUD() || 'No job on — walk into a red <b>!</b> to take one') +
      '<br>' + coinCount + ' coins · ' + chaosScore.toLocaleString() + ' chaos · ' + tr;
  }
}
addEventListener('keydown', e => {
  sirenInit();
  keys[e.code] = true;
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault();
  // flying uses Ctrl (nose down) and Q/E (roll); swallow them so the page doesn't act on them
  if (mode === 'plane' && ['ControlLeft','ControlRight','KeyQ','KeyE'].includes(e.code)) e.preventDefault();
  if (e.code === 'KeyP') togglePause();
  if (e.code === 'Space' && mode === 'foot' && !playerRag.active && !riding && !paused) {
    if (playerOnGround) { playerVel.y = JUMP; playerOnGround = false; canDouble = true; }
    else if (canDouble) {                            // a second tap in the air: jump again, higher
      playerVel.y = JUMP*0.92; canDouble = false;
      burst(player.position.x, player.position.y + 0.2, player.position.z, 0xdfeffb, 8);
    }
  }
  if (e.code === 'KeyC') camIdx = (camIdx+1) % 3;
  if (e.code === 'KeyM') mapView = !mapView;
  if (e.code === 'KeyR') {
    if (mode === 'plane') ejectPlane();                                  // bail out of the cockpit
    else if (mode === 'foot' && !playerOnGround && chuteReady && !chuteOpen) deployChute();
    else resetAll();
  }
  // ride, gate, doorway, then the shop games, then car — F is the one interact key
  if (e.code === 'KeyF' && !tryRide() && !tryGate() && !tryDoor() && !tryBowl() &&
      !tryRush() && !tryWhack() && !tryDance() && !tryPint() &&
      !tryHeist() && !tryKoi() && !tryOwl() && !tryPlane()) toggleVehicle();
  if (e.code === 'KeyH') honk();
  if (e.code === 'KeyN') setMuted(!muted);
  if (e.code.startsWith('Digit')) shopBuy(+e.code.slice(5) - 1);        // the garage menu
});
addEventListener('keyup', e => { keys[e.code] = false; });

let camYaw = 0, camPitch = -0.22, dragging = false, lastMX = 0, lastMY = 0, lastMouse = 0;
const canvas = renderer.domElement;
canvas.addEventListener('mousedown', e => { dragging = true; lastMX = e.clientX; lastMY = e.clientY;
  sirenInit();
  // Left is the fast one and right is the heavy one, which is the convention everywhere
  // else and happens to map straight onto hand-is-light, boot-is-heavy.
  if (e.button === 0 && !soakArm()) punch();    // the soaker round claims the left click
  if (e.button === 2) kick();
  if (document.pointerLockElement !== canvas) canvas.requestPointerLock?.(); });
// Right-drag to look already popped the browser menu over the game; now that right is
// also the kick, suppressing it is not optional.
canvas.addEventListener('contextmenu', e => e.preventDefault());
addEventListener('mouseup', () => { dragging = false; spraying = false; });
addEventListener('mousemove', e => {
  let dx = 0, dy = 0;
  if (document.pointerLockElement === canvas) { dx = e.movementX; dy = e.movementY; }
  else if (dragging) { dx = e.clientX-lastMX; dy = e.clientY-lastMY; lastMX = e.clientX; lastMY = e.clientY; }
  else return;
  camYaw -= dx*0.0032; camPitch -= dy*0.0026;
  camPitch = THREE.MathUtils.clamp(camPitch, -1.2, 0.42);
  lastMouse = performance.now();
});

let camIdx = 0, mapView = false, camSettled = false;
const carDists = [11, 15, 6.5], footDists = [5.5, 8, 3.6];

// =================================================================
//  CAR PHYSICS
// =================================================================
car.position.set(SPAWN.x, 0, SPAWN.z);
let heading = SPAWN.heading, speed = 0, steerSmooth = 0, drift = 0;
camYaw = SPAWN.heading;
car.rotation.y = heading;
// Top speed and acceleration are raised by garage upgrades, so they are bindings
// rather than constants; everything that reads them (steering authority, the FOV
// stretch, the camera pull-back) is written as a fraction of MAX_SPEED and scales
// with it for free.
let MAX_SPEED = 42, ACCEL = 32;
const MAX_REV = -14, BRAKE = 66, DRAG = 12;
let armorMul = 1, hasHorn = false;
let carHealth = 100, shake = 0, coinCount = 0, smokeT = 0, exhaustT = 0, carVY = 0, drowning = 0;
// stunt state: accumulated while the car is off the ground, banked on landing
let airT = 0, airPeak = 0, airSpin = 0, airPrevHead = 0;
// the ground's rise per metre under the car, remembered frame to frame — leaving
// the ground turns it into launch velocity (see the altitude block)
let lastGy = 0, groundSlope = 0;

const coinEl = document.getElementById('coins');
function addCoins(n) {
  coinCount += n;
  coinEl.innerHTML = coinCount + ' <small>COINS</small>';
  coinEl.style.transform = 'scale(1.18)';
  setTimeout(() => coinEl.style.transform = 'scale(1)', 90);
}
const toastEl = document.getElementById('toast');
let toastT = 0;
function toast(msg) { toastEl.textContent = msg; toastEl.classList.add('show'); toastT = 1.4; }

function damageCar(n) { carHealth = Math.max(0, carHealth - n*armorMul); if (carHealth <= 0) explode(); }
function explode() {
  missionEvent('carWrecked');
  burst(car.position.x, 1.2, car.position.z, 0xff8a2b, 16);
  burst(car.position.x, 1.6, car.position.z, 0x40424a, 10);
  shake = 2.0; carHealth = 100; toast('OW! MY CAR!');
  clearHeat();
  car.position.set(SPAWN.x, surfaceY(SPAWN.x, SPAWN.z), SPAWN.z);
  heading = SPAWN.heading; speed = 0; carVY = 0; drowning = 0; airT = 0; airPeak = 0;
  car.rotation.set(0, heading, 0); camYaw = heading;
}
function resetAll() {
  missionEvent('reset');
  setPlayerCar('convert', 0xf07ab0);
  car.position.set(SPAWN.x, surfaceY(SPAWN.x, SPAWN.z), SPAWN.z);
  heading = SPAWN.heading; speed = 0; carVY = 0; drowning = 0; airT = 0; airPeak = 0;
  car.rotation.set(0, heading, 0); camYaw = heading;
  mode = 'car'; player.visible = false; rider.visible = true;
  playerRag.active = false; player.rotation.set(0,0,0); player.position.y = 0;
  carHealth = 100;
  if (typeof planeHome === 'function') planeHome();     // park the plane back on the apron
}
function updateCar(dt) {
  const driving = mode === 'car' && drowning <= 0;
  const thr = driving && (keys.KeyW||keys.ArrowUp) ? 1 : 0;
  const brk = driving && (keys.KeyS||keys.ArrowDown) ? 1 : 0;
  const left = driving && (keys.KeyA||keys.ArrowLeft) ? 1 : 0;
  const right = driving && (keys.KeyD||keys.ArrowRight) ? 1 : 0;
  const hand = driving && keys.Space ? 1 : 0;

  if (thr) speed += ACCEL*dt;
  else if (brk) { if (speed > 0) speed -= BRAKE*dt; else speed -= ACCEL*0.6*dt; }
  else { if (speed > 0) speed = Math.max(0, speed-DRAG*dt); else if (speed < 0) speed = Math.min(0, speed+DRAG*dt); }
  speed = THREE.MathUtils.clamp(speed, MAX_REV, MAX_SPEED);
  if (hand) speed *= (1 - 1.7*dt);

  const steerIn = right - left;
  steerSmooth += (steerIn - steerSmooth) * Math.min(1, dt*10);   // input bites sooner
  const frac = Math.abs(speed)/MAX_SPEED;
  // More bite overall, and less of it taken away by speed. At MAX_SPEED this is ~1.2 rad/s,
  // a ~35 m turning circle — it used to be 0.6 rad/s and ~70 m, wider than a whole block.
  const authority = 2.2 * (1 - frac*0.45);
  const dir = speed >= 0 ? 1 : -1;
  heading -= steerSmooth * authority * (Math.min(Math.abs(speed),16)/16) * dir * dt;
  drift += (((hand && Math.abs(speed) > 14 && steerIn) ? 1 : 0) - drift) * Math.min(1, dt*5);

  const fx = Math.sin(heading), fz = Math.cos(heading);
  const res = collideCircle(car.position.x + fx*speed*dt, car.position.z + fz*speed*dt, 1.8, colliders);
  if (res.hit) {
    if (Math.abs(speed) > 6) crashSfx(Math.abs(speed));
    if (Math.abs(speed) > 11) { damageCar(Math.abs(speed)*0.32); shake = Math.min(1.2, shake+0.25); }
    speed *= 0.34;
  }
  if (Math.abs(speed) > 5) hitCratesAt(res.x, res.z, 2.4);    // and a car goes straight through
  const rt = collideTraffic(res.x, res.z, 1.7);
  if (rt.hit && rt.who >= 0) {
    const other = traffic[rt.who], impact = Math.abs(speed);
    if (impact > 3) {
      // shove strictly proportional to impact speed: a tap nudges the car a metre or
      // two, a full-speed ram sends it sliding — and with knock collision above it
      // stays in sight instead of phasing into a building
      const px = fz, pz = -fx, side = Math.random()-0.5;
      other.vx = fx*impact*0.8 + px*side*impact*0.45;
      other.vz = fz*impact*0.8 + pz*side*impact*0.45;
      other.spin = (Math.random()-0.5)*impact*0.12;
      // Above about 14 mph the hit stops being a shove and starts lifting a corner.
      // Everything below scales from nothing at that threshold, so a nudge in traffic
      // still just slides the car and only a real ram sends it barrel-rolling.
      const lift = Math.max(0, impact - 14) * 0.44;
      // SCRAP RUN counts launches, not taps — the same threshold that lifts a corner
      if (lift > 0 && MI && MI.id === 'rampage' && !other.cop && !other.derby && !other.racer) {
        MI.data.n++;
        if (MI.data.n < 6) toast(MI.data.n + ' / 6 — KEEP SWINGING');
      }
      other.vy = lift;
      other.pitchV = (Math.random()-0.5) * lift * 0.55;
      other.rollV  = (side >= 0 ? 1 : -1) * lift * 0.6;
      other.knock = Math.min(2.6, 0.3 + impact*0.06);
      speed *= impact > 26 ? 0.22 : 0.52;
      clangSfx(impact);
      if (other.hitCooldown <= 0) { addCoins(3); other.hitCooldown = 1.2; if (!other.derby) chaosHit(other.cop ? 45 : 25); }
      // derby rivals are the one thing you're *meant* to ram: no heat, and your own
      // car shrugs most of it off so a bout isn't lost to attrition
      if (other.derby) derbyHit(other, impact);
      else if (other.rival) rivalHit(other, impact);
      damageCar(impact*(other.derby ? 0.16 : 0.45));
      shake = Math.min(1.6, shake + 0.4 + impact*0.02);
      burst(other.x, 1.2, other.z, 0xffe27a, 6);
    } else { speed *= 0.62; }
  }
  car.position.x = THREE.MathUtils.clamp(rt.x, -TOWN-900, TOWN+900);
  car.position.z = THREE.MathUtils.clamp(rt.z, -TOWN-900, TOWN+900);

  // altitude: ride the surface, and fall when there isn't one under you
  const gy = surfaceY(car.position.x, car.position.z);
  if (car.position.y > gy + 0.06) {
    // airborne: the stunt clock runs. Spin is heading wound on mid-air — steering
    // deliberately has no ground check, which is the whole trick system.
    if (airT === 0) {
      airSpin = 0; airPrevHead = heading; airPeak = 0;
      // The lip throws you now: the slope the car was just climbing, times its
      // speed, is its vertical velocity at the moment the ground drops away.
      // Before this, carVY started at 0 and "air" was falling from lip height.
      if (groundSlope > 0.04) carVY = Math.min(24, Math.abs(speed) * groundSlope);
      groundSlope = 0;
    }
    airT += dt;
    airPeak = Math.max(airPeak, car.position.y - gy);
    airSpin += Math.abs(heading - airPrevHead); airPrevHead = heading;
    // nose follows the arc — up on the launch, down into the landing
    car.rotation.x += (THREE.MathUtils.clamp(-carVY*0.026, -0.42, 0.3) - car.rotation.x) * Math.min(1, dt*5);
    carVY -= 30*dt;
    car.position.y += carVY*dt;
    if (car.position.y < gy) { car.position.y = gy; carVY = 0; landStunt(); }
  } else {
    const run = Math.abs(speed) * dt;                              // rise per metre travelled
    if (run > 0.01) groundSlope = THREE.MathUtils.clamp((gy - lastGy) / run, -1, 1);
    car.position.y += (gy - car.position.y) * Math.min(1, dt*11);   // hug slopes
    carVY = 0;
    if (airT > 0) landStunt();
    if (car.rotation.x) car.rotation.x *= Math.max(0, 1 - dt*8);
  }
  lastGy = gy;
  if (drowning <= 0 && inWater(car.position.x, car.position.z) && car.position.y < WATER_Y + 1.2) {
    drowning = 1.5;
    for (let k = 0; k < 26; k++)
      emit(tmpV.set(car.position.x + rnd(-2.5,2.5), WATER_Y + 0.4, car.position.z + rnd(-2.5,2.5)),
        new THREE.Vector3(rnd(-4,4), rnd(6,15), rnd(-4,4)), 0xcfeaff, rnd(0.7,1.6), 1.1, 2.2);
    shake = 1.6; toast('SPLASH!'); speed = 0;
  }
  if (drowning > 0) {
    drowning -= dt;
    car.position.y -= 5*dt;                                   // sink
    if (drowning <= 0) { resetAll(); }
  }

  const sgn = speed >= 0 ? 1 : -1;
  for (const off of [2.2, 0.4, -1.8]) {
    const hx = car.position.x + fx*off, hz = car.position.z + fz*off;
    if (Math.abs(speed) > 1) hitPeopleAt(hx, hz, fx*sgn, fz*sgn, speed, 2.0, true);
    if (Math.abs(speed) > 2) hitPropsAt(hx, hz, fx*sgn, fz*sgn, speed, 2.0);
  }

  car.rotation.y = heading + drift*0.45*steerIn;
  car.rotation.z += ((-steerIn*frac*0.07) - car.rotation.z) * Math.min(1, dt*6);
  carShadow.position.set(car.position.x, surfaceY(car.position.x, car.position.z) + 0.09, car.position.z);
  carShadow.rotation.z = -heading;

  if (carHealth < 55) {
    smokeT -= dt;
    if (smokeT <= 0) {
      smokeT = carHealth < 25 ? 0.06 : 0.14;
      const crit = carHealth < 25;
      emit(tmpV.set(car.position.x + fx*1.8, 1.1, car.position.z + fz*1.8),
        new THREE.Vector3(rnd(-1,1), rnd(2,4), rnd(-1,1)), crit ? 0xff7a2b : 0x9aa0a8, 0.9, 1.1, 2.4);
    }
  }
  exhaustT -= dt;
  if (exhaustT <= 0 && Math.abs(speed) > 3) {
    exhaustT = 0.09;
    emit(tmpV.set(car.position.x - fx*2.6, 0.5, car.position.z - fz*2.6),
      new THREE.Vector3(rnd(-.6,.6), 0.7, rnd(-.6,.6)), 0xc8ccd2, 0.5, 0.5, 1.4);
  }
}

// =================================================================
//  ON FOOT
// =================================================================
const GRAV = 26, WALK = 7, RUN = 12, JUMP = 9.5;
let playerIFrames = 0;
function updatePlayer(dt) {
  if (mode !== 'foot') return;
  if (riding) {
    // You are a passenger. Ride the seat rather than walking — keeping the player's
    // position under the seat is what makes the radar, the coins and everything else
    // that reads `sub` follow you round the track instead of standing at the gate.
    const s2 = rideSeat(riding);
    player.position.set(s2.x, 0, s2.z);
    playerShadow.position.set(s2.x, surfaceY(s2.x, s2.z) + 0.09, s2.z);
    return;
  }
  if (playerRag.active) {
    // a moment of mercy on getting up, or a crowd re-decks you the frame you stand
    if (updateRag(player, playerRag, dt)) playerIFrames = 2.0;
    playerShadow.position.set(player.position.x, 0.09, player.position.z); return;
  }
  if (playerIFrames > 0) playerIFrames -= dt;
  const fwd = (keys.KeyW||keys.ArrowUp)?1:0, back = (keys.KeyS||keys.ArrowDown)?1:0;
  const tl = (keys.KeyA||keys.ArrowLeft)?1:0, tr = (keys.KeyD||keys.ArrowRight)?1:0;
  const sprint = keys.ShiftLeft || keys.ShiftRight;
  player.rotation.y += (tl - tr) * 2.9 * dt;
  const drive = fwd - back, spd = sprint ? RUN : WALK;
  const fx = Math.sin(player.rotation.y), fz = Math.cos(player.rotation.y);
  const res = collideCircle(player.position.x + fx*drive*spd*dt, player.position.z + fz*drive*spd*dt, 0.75, colliders, player.position.y);
  const rt = collideTraffic(res.x, res.z, 0.75);
  const rc = TIRECOLS.length ? collideTires(rt.x, rt.z, 0.75, player.position.y) : rt;
  player.position.x = THREE.MathUtils.clamp(rc.x, -TOWN-40, TOWN+40);
  player.position.z = THREE.MathUtils.clamp(rc.z, -TOWN-40, TOWN+40);
  const pgy = surfaceY(player.position.x, player.position.z, player.position.y);
  playerVel.y -= GRAV*dt;
  if (chuteOpen && !playerOnGround && playerVel.y < -CHUTE_FALL) playerVel.y = -CHUTE_FALL;   // canopy drag
  player.position.y += playerVel.y*dt;
  if (player.position.y <= pgy) {
    const hard = chuteReady && !chuteOpen && playerVel.y < -18;
    player.position.y = pgy; playerVel.y = 0; playerOnGround = true; canDouble = false;
    if (chuteReady || chuteOpen) {                 // touched down from a bail-out
      if (chuteOpen) toast('SAFE LANDING');
      else if (hard) { shake = Math.max(shake, 1.5); toast('OOF — no chute!'); }
      chuteReady = false; chuteOpen = false; chute.visible = false;
    }
  }
  // float the open canopy above the pilot while he's still in the air
  if (chuteOpen && !playerOnGround) { chute.visible = true; chute.position.set(player.position.x, player.position.y + 1.05, player.position.z); }
  else if (chute.visible) chute.visible = false;
  if (inWater(player.position.x, player.position.z) && player.position.y < WATER_Y + 1.4) {
    for (let k = 0; k < 20; k++)
      emit(tmpV.set(player.position.x + rnd(-1.6,1.6), WATER_Y + 0.4, player.position.z + rnd(-1.6,1.6)),
        new THREE.Vector3(rnd(-3,3), rnd(5,11), rnd(-3,3)), 0xcfeaff, rnd(0.5,1.1), 0.9, 1.8);
    toast('SPLASH!'); shake = 1.2; resetAll();
  }
  playerVsPeds(dt);
  const moving = drive !== 0 || tl || tr;
  const u = player.userData; u.phase += dt*(sprint?13:9)*(moving?1:0);
  const sw = Math.sin(u.phase)*(moving?0.62:0);
  u.legL.rotation.x = sw; u.legR.rotation.x = -sw; u.armL.rotation.x = -sw; u.armR.rotation.x = sw;
  if (kickCd > 0) kickCd -= dt;
  if (punchCd > 0) punchCd -= dt;
  if (kickT > 0) {                                   // left boot swings through and back
    kickT -= dt;
    const k = Math.sin(Math.max(0, Math.min(1, (0.3 - kickT)/0.3)) * Math.PI);
    u.legL.rotation.x = -1.7*k; u.legR.rotation.x = 0.35*k;   // plant the other foot
    u.armR.rotation.x = -0.7*k; u.armL.rotation.x = 0.5*k;    // arms counter the swing
  }
  if (punchT > 0) {                                  // right hand jabs out and back
    punchT -= dt;
    const k = Math.sin(Math.max(0, Math.min(1, (0.22 - punchT)/0.22)) * Math.PI);
    u.armR.rotation.x = -2.05*k; u.armL.rotation.x = 0.75*k;
  }
  playerShadow.position.set(player.position.x, surfaceY(player.position.x, player.position.z, player.position.y) + 0.09, player.position.z);
  if (drive !== 0) hitPropsAt(player.position.x, player.position.z, fx*drive, fz*drive, spd*0.6, 1.0, 2.5);
}
function nearestJackable() {
  let best = null, bd = 5.5*5.5;
  for (const t of traffic) {
    if (t.cur > 3.5) continue;
    const dx = t.x-player.position.x, dz = t.z-player.position.z, d = dx*dx+dz*dz;
    if (d < bd) { bd = d; best = t; }
  }
  return best;
}
function toggleVehicle() {
  if (mode === 'foot' && playerRag.active) return;
  if (mode === 'car') {
    mode = 'foot';
    const sx = Math.cos(car.rotation.y), sz = -Math.sin(car.rotation.y);
    player.position.set(car.position.x + sx*3.0, 0, car.position.z + sz*3.0);
    player.rotation.set(0, car.rotation.y, 0);
    playerVel.set(0,0,0); playerOnGround = true; player.visible = true; rider.visible = false;
  } else {
    const jack = nearestJackable();
    if (jack) {
      const g = makeAvatar(); g.position.x = jack.x + 2.6; g.position.z = jack.z;
      const p = { g, ei:0, from:0, side:1, dist:0, speed:rnd(1.1,1.8), cross:null, rag:makeRag(), flee:null };
      attachPed(p); g.position.x = jack.x + 2.6; g.position.z = jack.z;
      peds.push(p); setFlee(p, jack.x, jack.z);
      for (const o of peds) {
        if (o === p || o.rag.active || (o.flee && o.flee.t > 0)) continue;
        const dx = o.g.position.x-jack.x, dz = o.g.position.z-jack.z;
        if (dx*dx + dz*dz < 260 && Math.random() < 0.7) setFlee(o, jack.x, jack.z);
      }
      setPlayerCar(jack.type, jack.color);
      car.position.set(jack.x, 0, jack.z); heading = jack.yaw;
      car.rotation.set(0, heading, 0); speed = 0;
      traffic.splice(traffic.indexOf(jack), 1);
      addCoins(10); toast('NICE RIDE!');
      mode = 'car'; player.visible = false; rider.visible = true;
      return;
    }
    if (car.position.distanceTo(player.position) > 7) return;
    mode = 'car'; player.visible = false; rider.visible = true;
  }
}

// =================================================================
//  CROWD CONTACT
//  Townsfolk take up space: they shove past each other, they won't let you
//  walk through them, and if you barge one they square up and swing at you.
//  Kick them (left click on foot) and they go down, get up, and run.
// =================================================================
const PED_R = 0.62;                 // townsperson radius
const SEP_FAR = 110;                // only separate the crowd you can actually see
const ANGER_R = 26;                 // give up the chase past this
const PUNCH_R = 1.9, PUNCH_GAP = 1.4;

// Shove overlapping people apart. Lane walkers keep the push as an offset (pedPlace
// re-derives their position from the road graph every frame and would otherwise wipe it);
// anyone moving freely just takes the displacement directly.
function separatePeds(sub) {
  const D = PED_R*2, D2 = D*D, far2 = SEP_FAR*SEP_FAR;
  for (const p of peds) {
    if (p.rag.active) continue;
    const px = p.g.position.x, pz = p.g.position.z;
    if ((px-sub.x)**2 + (pz-sub.z)**2 > far2) continue;
    const gx = Math.floor(px/GAP_Q), gz = Math.floor(pz/GAP_Q);
    for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
      const b = pedGrid.get((gx+ox)+','+(gz+oz)); if (!b) continue;
      for (const q of b) {
        if (q === p || q.rag.active) continue;
        const dx = q.g.position.x - p.g.position.x, dz = q.g.position.z - p.g.position.z;
        const d2 = dx*dx + dz*dz;
        if (d2 >= D2 || d2 < 1e-5) continue;
        const d = Math.sqrt(d2), push = (D - d) * 0.5, nx = dx/d, nz = dz/d;
        p.g.position.x -= nx*push; p.g.position.z -= nz*push;
        q.g.position.x += nx*push; q.g.position.z += nz*push;
        p.ox = THREE.MathUtils.clamp((p.ox||0) - nx*push, -1.1, 1.1);
        p.oz = THREE.MathUtils.clamp((p.oz||0) - nz*push, -1.1, 1.1);
        q.ox = THREE.MathUtils.clamp((q.ox||0) + nx*push, -1.1, 1.1);
        q.oz = THREE.MathUtils.clamp((q.oz||0) + nz*push, -1.1, 1.1);
      }
    }
    // offsets bleed away so the pavement tidies itself up again
    if (p.ox) p.ox *= 1 - Math.min(1, 1.2*(1/60));
    if (p.oz) p.oz *= 1 - Math.min(1, 1.2*(1/60));
  }
}

// The crowd separates from itself, but nothing ever separated it from the *things*:
// lane walkers are re-placed from the road graph every frame and never tested against
// cars or street furniture, so people strolled straight through a queue of traffic and
// out the other side. Same fix as every push on a lane walker — write the offset into
// p.ox/p.oz so pedPlace doesn't wipe it next frame. Clamps are wider than the crowd
// separation's ±1.1 because half a car's width plus a shoulder is nearly 2 m.
function pedsVsSolids(sub) {
  // an oriented car body, same frame maths as collideTraffic
  const pushCar = (cx, cz, yaw, type) => {
    const S = CAR_TYPES[type] || CAR_TYPES.sedan;
    const hx = S.W/2 + PED_R*0.7, hz = S.L/2 + PED_R*0.7;
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    const gx = Math.floor(cx/GAP_Q), gz = Math.floor(cz/GAP_Q);
    for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
      const b = pedGrid.get((gx+ox)+','+(gz+oz)); if (!b) continue;
      for (const p of b) {
        if (p.rag.active) continue;
        const dx = p.g.position.x - cx, dz = p.g.position.z - cz;
        let lx = dx*c - dz*sn, lz = dx*sn + dz*c;
        const pex = hx - Math.abs(lx), pez = hz - Math.abs(lz);
        if (pex <= 0 || pez <= 0) continue;
        if (pex < pez) lx += Math.sign(lx || 1)*pex;      // out the nearest face
        else           lz += Math.sign(lz || 1)*pez;
        const nx2 = cx + lx*c + lz*sn, nz2 = cz - lx*sn + lz*c;
        p.ox = THREE.MathUtils.clamp((p.ox||0) + nx2 - p.g.position.x, -2.6, 2.6);
        p.oz = THREE.MathUtils.clamp((p.oz||0) + nz2 - p.g.position.z, -2.6, 2.6);
        p.g.position.x = nx2; p.g.position.z = nz2;
      }
    }
  };
  // Scoped to the bubble around the camera: an overlap nobody can see costs nothing
  // and fixes nothing. 120 m for cars (big, readable at range)…
  for (const t of traffic) {
    const dx = t.x - sub.x, dz = t.z - sub.z;
    if (dx*dx + dz*dz > 120*120) continue;
    pushCar(t.x, t.z, t.yaw, t.type);
  }
  if (mode === 'foot') pushCar(car.position.x, car.position.z, heading, carType);
  // …and 90 m for the bins, hydrants and lamp posts, which are small.
  for (const pr of props) {
    if (!pr.static) continue;
    const ddx = pr.x - sub.x, ddz = pr.z - sub.z;
    if (ddx*ddx + ddz*ddz > 90*90) continue;
    const rr = pr.radius + PED_R*0.7, rr2 = rr*rr;
    const gx = Math.floor(pr.x/GAP_Q), gz = Math.floor(pr.z/GAP_Q);
    for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
      const b = pedGrid.get((gx+ox)+','+(gz+oz)); if (!b) continue;
      for (const p of b) {
        if (p.rag.active) continue;
        const dx = p.g.position.x - pr.x, dz = p.g.position.z - pr.z;
        const d2 = dx*dx + dz*dz;
        if (d2 >= rr2 || d2 < 1e-5) continue;
        const d = Math.sqrt(d2), push = rr - d, nx = dx/d, nz = dz/d;
        p.ox = THREE.MathUtils.clamp((p.ox||0) + nx*push, -1.6, 1.6);
        p.oz = THREE.MathUtils.clamp((p.oz||0) + nz*push, -1.6, 1.6);
        p.g.position.x += nx*push; p.g.position.z += nz*push;
      }
    }
  }
}

let angerToast = 0;
function angerPed(p) {
  if (p.rag.active || (p.flee && p.flee.t > 0) || p.angry > 0) return;
  p.angry = 7; p.swing = 0.5;
  // The banner is what they yell as they square up, so it wants the ones with a threat
  // in them, not just the affronted ones. ('WHY YOU LITTLE—' was a straight lift from
  // the show; everything else in this game got de-branded, and it was overdue.)
  if (angerToast <= 0) {
    toast(mpick(['HEY!', 'WATCH IT!', 'RUDE!', 'EXCUSE YOU!', "I'M WALKING HERE!",
                 'DO YOU MIND?', 'MANNERS!', 'BACK OFF!', 'NOT TODAY!',
                 "THAT'S IT!", "OH, IT'S ON!", 'RIGHT, THAT DOES IT!', 'COME HERE!']));
    angerToast = 3; sayOuch('barge');
  }
}
// Returns true when it has taken charge of this person for the frame.
function updateAngry(p, dt) {
  if (mode !== 'foot' || playerRag.active) {
    // nothing to square up to — a driver is not a fair fight
    if (mode !== 'foot') { p.angry = 0; attachPed(p); return false; }
  }
  p.angry -= dt;
  if (playerRag.active) {                          // you're down — honor is satisfied
    p.angry = Math.min(p.angry, 1.0);
    walkAnim(p.g, dt, 3, 0.12);
    return true;
  }
  const dx = player.position.x - p.g.position.x, dz = player.position.z - p.g.position.z;
  const d = Math.hypot(dx, dz) || 1;
  if (p.angry <= 0 || d > ANGER_R) { p.angry = 0; attachPed(p); return false; }
  const nx = dx/d, nz = dz/d;
  const res = collideCircle(p.g.position.x + nx*3.6*dt, p.g.position.z + nz*3.6*dt, 0.6, colliders);
  p.g.position.x = res.x; p.g.position.z = res.z; p.g.position.y = 0;
  p.g.rotation.y = Math.atan2(nx, nz);
  walkAnim(p.g, dt, 14, 0.85);
  p.swing = Math.max(0, (p.swing || 0) - dt);
  if (d < PUNCH_R && p.swing <= 0 && !playerRag.active && playerIFrames <= 0) {
    p.swing = PUNCH_GAP;
    p.angry = Math.min(p.angry, 1.6);            // one landed punch mostly settles the score
    applyRagdoll(player, playerRag, nx, nz, 7);
    shake = Math.min(1.2, shake + 0.35);
    burst(player.position.x, 1.5, player.position.z, 0xffe27a, 6);
    toast('OOF!');
  }
  return true;
}

// Walking into someone is a shove, not a pass-through — and they take it personally,
// but only if it was *your* doing. The crowd walks its own lanes and blunders into a
// standing player all day long; anger used to fire on any overlap, so a townsperson
// could walk into you, square up about it, and put you on the floor for the crime of
// standing still. Now the contact is judged by whether you were closing on them: your
// own movement this frame, projected onto the line between you. Bump them and they
// fight; get bumped and they apologise.
let lastFootX = 0, lastFootZ = 0;
function playerVsPeds(dt) {
  const px = player.position.x, pz = player.position.z;
  const mvx = px - lastFootX, mvz = pz - lastFootZ;   // measured before the give-way below
  lastFootX = px; lastFootZ = pz;
  if (mode !== 'foot' || playerRag.active) return;
  const R = 0.75 + PED_R, R2 = R*R;
  const gx = Math.floor(px/GAP_Q), gz = Math.floor(pz/GAP_Q);
  for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
    const b = pedGrid.get((gx+ox)+','+(gz+oz)); if (!b) continue;
    for (const p of b) {
      if (p.rag.active) continue;
      const dx = p.g.position.x - px, dz = p.g.position.z - pz, d2 = dx*dx + dz*dz;
      if (d2 >= R2 || d2 < 1e-5) continue;
      const d = Math.sqrt(d2), push = R - d, nx = dx/d, nz = dz/d;
      player.position.x -= nx*push*0.45;              // you give way a little
      player.position.z -= nz*push*0.45;
      p.g.position.x += nx*push*0.55;                 // they give way a little more
      p.g.position.z += nz*push*0.55;
      p.ox = THREE.MathUtils.clamp((p.ox||0) + nx*push*0.55, -1.1, 1.1);
      p.oz = THREE.MathUtils.clamp((p.oz||0) + nz*push*0.55, -1.1, 1.1);
      // n runs from you to them, so this is how fast you were closing. Walking pace is
      // about 4 m/s and running about 6, so 1.2 clears incidental drift while still
      // catching a deliberate shoulder — and standing still can never trip it.
      const closing = (mvx*nx + mvz*nz) / Math.max(dt, 1e-4);
      if (closing > 1.2) angerPed(p);
      else if (Math.random() < 0.3) sayOuch('bump');   // their fault, and they know it
                                                      // (not every time — standing in a
                                                      // crowd should not be a wall of apology)
    }
  }
}

// ---- the punch: right hand ----
// Fast, short, aimed at one person, and it does not put them down — it staggers them
// and starts a fight. That is the whole point of having two attacks: the light one
// opens an exchange (they square up and swing back), the heavy one ends it. Two on the
// chin inside two and a half seconds does drop them, so a flurry still pays off.
let punchCd = 0, punchT = 0;
const PUNCH_REACH = 1.75;
function punch() {
  if (mode !== 'foot' || playerRag.active || punchCd > 0 || riding) return;
  punchCd = 0.34; punchT = 0.22;
  const fx = Math.sin(player.rotation.y), fz = Math.cos(player.rotation.y);
  const px = player.position.x, pz = player.position.z;
  const gx = Math.floor(px/GAP_Q), gz = Math.floor(pz/GAP_Q);
  // one target, the nearest in front — a punch is aimed, where the boot is a sweep
  let best = null, bd = 1e9, bnx = 0, bnz = 0;
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) {
    const b = pedGrid.get((gx+cx)+','+(gz+cz)); if (!b) continue;
    for (const p of b) {
      if (p.rag.active) continue;
      const dx = p.g.position.x - px, dz = p.g.position.z - pz, d = Math.hypot(dx, dz);
      if (d > PUNCH_REACH || d < 1e-4 || d >= bd) continue;
      if ((dx/d)*fx + (dz/d)*fz < 0.4) continue;       // and squarely in front
      best = p; bd = d; bnx = dx/d; bnz = dz/d;
    }
  }
  hitCratesAt(px + fx*1.3, pz + fz*1.3, 1.5);        // a fist opens one too
  whackTry();                                        // and scores at the arcade
  initiationInput('P');                              // and counts before the Order
  if (!best) return;
  const now = performance.now();
  best.combo = (now - (best.hitAt || 0) < 2500) ? (best.combo || 0) + 1 : 1;
  best.hitAt = now;
  burst(px + fx*1.1, 1.45, pz + fz*1.1, 0xffe27a, 6);
  chaosHit(8);
  if (best.combo >= 2) {                               // the second one lands clean
    applyRagdoll(best.g, best.rag, bnx, bnz, 9);
    best.angry = 0;
    best.spooked = { x: px, z: pz };                   // gets up and wants no more of it
    shake = Math.min(1.0, shake + 0.2);
    toast('KO!');
  } else {
    // shoved back on their heels. The offset is what survives pedPlace, same as a barge.
    best.g.position.x += bnx*0.55; best.g.position.z += bnz*0.55;
    best.ox = THREE.MathUtils.clamp((best.ox||0) + bnx*0.55, -1.1, 1.1);
    best.oz = THREE.MathUtils.clamp((best.oz||0) + bnz*0.55, -1.1, 1.1);
    best.swing = 0.45;                                 // rocked: their own swing resets
    angerPed(best);                                    // and now it is a fight
    shake = Math.min(1.0, shake + 0.1);
  }
  sayOuch('punch');
}

// ---- the kick: left leg ----
// Slower and more committed than the punch, but it reaches further, sweeps everyone in
// front of you rather than one target, and actually launches them. It is also the only
// thing chickens care about — Feather Frenzy runs on this counter.
let kickCd = 0, kickT = 0;
function kick() {
  if (mode !== 'foot' || playerRag.active || kickCd > 0 || riding) return;
  kickCd = 0.55; kickT = 0.3;
  const fx = Math.sin(player.rotation.y), fz = Math.cos(player.rotation.y);
  const ox = player.position.x + fx*1.0, oz = player.position.z + fz*1.0;
  const gx = Math.floor(ox/GAP_Q), gz = Math.floor(oz/GAP_Q);
  let got = 0;
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) {
    const b = pedGrid.get((gx+cx)+','+(gz+cz)); if (!b) continue;
    for (const p of b) {
      if (p.rag.active) continue;
      const dx = p.g.position.x - player.position.x, dz = p.g.position.z - player.position.z;
      const d = Math.hypot(dx, dz);
      if (d > 2.3 || d < 1e-4) continue;
      if ((dx/d)*fx + (dz/d)*fz < 0.25) continue;      // has to be in front of you
      applyRagdoll(p.g, p.rag, dx/d, dz/d, 13);
      p.angry = 0;
      p.spooked = { x: player.position.x, z: player.position.z };   // gets up and runs
      got++;
    }
  }
  hitCratesAt(ox, oz, 2.0);                          // the boot busts a crate open
  puttKick(fx, fz);                                  // and putts the mini-golf ball
  whackTry();                                        // and counts at the arcade
  initiationInput('K');                              // and counts before the Order
  // chickens are fair game for the boot — Feather Frenzy runs on this counter
  for (const c of chickens) {
    if (c.dead > 0) continue;
    const dx = c.x - player.position.x, dz = c.z - player.position.z;
    const d = Math.hypot(dx, dz);
    if (d > 2.6 || d < 1e-4) continue;
    if ((dx/d)*fx + (dz/d)*fz < 0.2) continue;
    burst(c.x, 0.8, c.z, 0xffffff, 10);
    burst(c.x, 1.2, c.z, c.hue, 7);
    c.dead = rnd(6, 11);
    chickenKicked++; chickensDowned++;
    chaosHit(8);
    shake = Math.min(1.0, shake + 0.15);
  }
  if (got) {
    chaosHit(12*got);
    burst(ox, 1.1, oz, 0xffe27a, 5 + got*2);
    shake = Math.min(1.0, shake + 0.22);
    sayOuch('kick');
  }
}

// =================================================================
//  CHAOS
//  The loop: wreck things to build a combo, which heats you up; heat brings
//  police; outrun them and the combo banks with a bonus, get caught and it's
//  gone. Police are ordinary traffic agents with a chase flag — they use the
//  same road graph, so they route through town properly instead of homing.
// =================================================================
const COMBO_HOLD = 4.0;                       // seconds of calm before a run banks
const STAR_AT = [0, 14, 36, 66, 104, 150];    // heat needed for 1..5 stars
const COP_PAINT = 0x1b2f6b, COP_SPEED = 30, COP_MAX = 5;
const PURSUE_R = 36;                          // inside this they leave the graph and come at you

// ---- FREE-ROAM RIVALS -------------------------------------------------------
// A handful of named menaces who live in the traffic. They cruise the road graph
// like anyone else until you are in a car within RIVAL_NOTICE, then they leave the
// graph, hunt you and ram — no heat, no arrest, just aggravation. Ram one back hard
// enough and it wrecks (bonus coins + chaos) and a new one rolls in a while later, so
// they read as recurring rivals rather than disposable traffic.
const RIVAL_NOTICE = 74, RIVAL_LOSE = 130, RIVAL_SPEED = 34, RIVAL_HP = 62, RIVAL_CAP = 4;
const RIVAL_DEFS = [
  { name: 'SPIKE',  type: 'truck',   color: 0xe8532f,
    taunts: [['Found you!', "You're mine now.", 'Nowhere to run!'],
             ['Gotcha!', 'Feel that?', 'Ha! Again!'],
             ['Coward!', 'Come back and fight!', 'Chicken!']] },
  { name: 'NITRO',  type: 'convert', color: 0xb026ff,
    taunts: [['Race you? No. Wreck you.', 'Hello, roadkill.', 'Eyes on you.'],
             ['Boom!', 'Paint trade!', 'Dented ya!'],
             ['Weak!', 'Slow poke!', 'See ya, loser.']] },
  { name: 'MAULER', type: 'wagon',   color: 0x1a1c22,
    taunts: [['Fresh meat.', 'I smell fear.', 'This road is mine.'],
             ['Crunch.', 'Nighty night.', 'Off you go.'],
             ['Pathetic.', 'Run then.', 'Next time.']] },
];
const rivals = [];
let tauntT = 0;
function rivalTaunt(t, kind) {
  if (tauntT > 0) return;
  tauntT = 2.6;
  const lines = t.rival.taunts[kind] || t.rival.taunts[0];
  toast(t.rival.name + ': ' + lines[(Math.random()*lines.length)|0]);
}

let chaosScore = 0, comboPts = 0, comboMult = 1, comboT = 0, comboHits = 0;
let heat = 0, stars = 0, cleanT = 99, bustT = 0;

function chaosHit(pts) {
  comboHits++;
  if (comboHits % 3 === 0) comboMult = Math.min(8, comboMult + 1);
  comboPts += pts * comboMult;
  comboT = COMBO_HOLD;
  heat = Math.min(heat + pts * 0.55, STAR_AT[5] * 1.25);
  cleanT = 0;
}
function bankCombo(bonus) {
  comboT = 0;
  if (comboPts > 0) {
    const total = Math.round(comboPts * (bonus || 1));
    chaosScore += total;
    addCoins(Math.max(1, Math.round(total/12)));
    toast('+' + total + ' CHAOS');
  }
  comboPts = 0; comboMult = 1; comboHits = 0;
}

// A landing banks a stunt. Air time and peak height pay flat points into the combo
// (flat, not multiplied — the multiplier is for wrecking things); winding the wheel
// mid-air pays a spin bonus per quarter turn. Kerb hops (under half a second, or
// under knee height) are free, so ordinary driving never toasts.
function landStunt() {
  const t = airT, peak = airPeak, deg = airSpin * 180 / Math.PI;
  airT = 0; airPeak = 0; airSpin = 0;
  if (mode !== 'car' || drowning > 0) return;
  if (t < 0.5 || peak < 0.8) return;
  const spinB = Math.floor(deg / 90) * 45;
  const pts = Math.round(t * 80 + peak * 14) + spinB;
  let label = t >= 2.2 ? 'HUGE AIR!' : t >= 1.2 ? 'BIG AIR!' : 'NICE AIR';
  if (deg >= 315) label = '360 ' + label;
  else if (deg >= 150) label = 'SPIN + ' + label;
  comboHits++;
  if (comboHits % 3 === 0) comboMult = Math.min(8, comboMult + 1);
  comboPts += pts;
  comboT = COMBO_HOLD;
  // a fraction of the heat a wreck of the same worth would draw — stunts are showing
  // off, not crime, but the cops still notice a car doing 360s over the park
  heat = Math.min(heat + Math.min(pts * 0.06, 8), STAR_AT[5] * 1.25);
  cleanT = 0;
  toast(label + '  +' + pts);
  stuntSfx(t);
}
function stuntSfx(t) {
  if (!sirenCtx) return;
  const at = sirenCtx.currentTime, big = t >= 1.2;
  tone(523, at, 0.06, 0.09, 'triangle');
  tone(784, at + 0.07, 0.06, 0.09, 'triangle');
  tone(1047, at + 0.14, big ? 0.16 : 0.09, 0.1, 'triangle');
  if (big) tone(1568, at + 0.24, 0.18, 0.09, 'triangle');
}

// ---- police ----
const cops = [];
const copLight = instanced(BOX(1.7, 0.3, 0.55), new THREE.MeshBasicMaterial({ color: 0xffffff }), COP_MAX, false);
copLight.setColorAt(0, new THREE.Color(0xffffff));
copLight.instanceColor.array.fill(1);          // setColorAt allocates black — see README
copLight.count = 0; scene.add(copLight);
const COP_RED = new THREE.Color(0xff2b2b), COP_BLUE = new THREE.Color(0x3f7bff);
// POLICE on the doors: one instanced plate per side per car
const copDecal = instanced(new THREE.PlaneGeometry(2.3, 0.62),
  new THREE.MeshBasicMaterial({ map: signTexture('POLICE', '#e8eaf0', '#1b2f6b', 256, 64) }), COP_MAX*2, false);
copDecal.count = 0; scene.add(copDecal);

// --- siren: a two-tone wail that follows the nearest pursuer ---
// The officer who steps out to make the arrest. One at a time.
const COP_LOOK = { skin: 0xffd90f, hair: 0x14192e, shirt: 0x1b2f6b, pants: 0x14192e, shoe: 0x14192e, style: 'bald' };
let officer = null;                              // { g, cop }
function deployOfficer(t) {
  const g = buildPerson(COP_LOOK);
  g.position.set(t.x + Math.cos(t.yaw)*1.6, 0, t.z - Math.sin(t.yaw)*1.6);
  g.rotation.y = t.yaw;
  scene.add(g);
  officer = { g, cop: t };
  t.arrest = true;                               // the car parks while the officer is out
  toast('PULL OVER!');
}
function dismissOfficer() {
  if (!officer) return;
  scene.remove(officer.g);
  if (officer.cop) officer.cop.arrest = false;
  officer = null;
}
function updateOfficer(dt, sub) {
  if (!officer) return;
  const g = officer.g, t = officer.cop;
  const dx = sub.x - g.position.x, dz = sub.z - g.position.z;
  const d = Math.hypot(dx, dz) || 1;
  // the mark bolted — back in the car, chase resumes
  const fleeing = (mode === 'car' && Math.abs(speed) > 9) || d > 30 || !cops.includes(t);
  if (fleeing) { dismissOfficer(); return; }
  const nx = dx/d, nz = dz/d;
  const res = collideCircle(g.position.x + nx*3.6*dt, g.position.z + nz*3.6*dt, 0.6, colliders);
  g.position.x = res.x; g.position.z = res.z;
  g.rotation.y = Math.atan2(nx, nz);
  walkAnim(g, dt, 11, 0.7);
  if (d < 2.4) busted();
}

let sirenCtx = null, sirenOut = null;

// Mute. Remembered across sessions, because someone who plays with the sound off
// wants it off next time too — and it has to be readable before sirenInit runs, since
// the button is clickable (and audio therefore creatable) at any moment.
let muted = false;
try { muted = localStorage.getItem('mm_mute') === '1'; } catch (e) {}
const muteBtn = document.getElementById('mute');
function setMuted(v) {
  muted = v;
  try { localStorage.setItem('mm_mute', v ? '1' : '0'); } catch (e) {}
  if (sirenOut) sirenOut.gain.setTargetAtTime(v ? 0 : 1, sirenCtx.currentTime, 0.02);
  if (v) { try { speechSynthesis.cancel(); } catch (e) {} }
  if (muteBtn) {
    muteBtn.textContent = v ? '🔇' : '🔊';
    muteBtn.classList.toggle('off', v);
    muteBtn.setAttribute('aria-label', v ? 'Unmute sound' : 'Mute sound');
    muteBtn.setAttribute('aria-pressed', String(v));
  }
}
if (muteBtn) muteBtn.addEventListener('click', e => {
  e.stopPropagation();
  sirenInit();                       // the click is a gesture, so it may as well count
  setMuted(!muted);
  muteBtn.blur();                    // else Space/Enter re-triggers it while driving
});
setMuted(muted);                     // paint the remembered state onto the button
// Everything that makes a noise goes through one master gain instead of straight to
// the destination, so mute is a single number rather than a flag every sound site has
// to remember to check — and killing the gain leaves the scheduled notes and the
// engine oscillator running, so unmuting is instant rather than a rebuild.
function sirenInit() {                          // must happen inside a user gesture
  if (sirenCtx) return;
  try { sirenCtx = new (window.AudioContext || window.webkitAudioContext)(); }
  catch (e) { sirenCtx = null; return; }
  sirenOut = sirenCtx.createGain();
  sirenOut.gain.value = muted ? 0 : 1;
  sirenOut.connect(sirenCtx.destination);
}
// a short note, scheduled on the shared context
function tone(freq, at, dur, vol, type) {
  if (!sirenCtx) return;
  const o = sirenCtx.createOscillator(), g = sirenCtx.createGain();
  o.type = type || 'square'; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.linearRampToValueAtTime(vol, at + 0.012);
  g.gain.setTargetAtTime(0.0001, at + dur, 0.03);
  o.connect(g); g.connect(sirenOut);
  o.start(at); o.stop(at + dur + 0.2);
}
// the quick double chirp a patrol car gives when it's right on your tail
function sirenBleep(vol) {
  if (!sirenCtx) return;
  const t = sirenCtx.currentTime;
  tone(880, t, 0.07, vol);
  tone(1175, t + 0.13, 0.09, vol);
}
function coinSfx() {
  if (!sirenCtx) return;
  const t = sirenCtx.currentTime;
  tone(1047, t, 0.055, 0.11, 'triangle');
  tone(1568, t + 0.065, 0.1, 0.09, 'triangle');
}
let bleepT = 0;

// ---- the rest of the town's noises ----
// A low bed under everything: two barely-detuned sines that beat against each
// other over ~8 s plus a whisper of third harmonic. Felt more than heard — it
// mostly registers when you mute and the town goes dead. Routed through the
// master gain like everything else, so mute still costs one number.
let humBuilt = false;
function ensureHum() {
  if (!sirenCtx || humBuilt) return;
  humBuilt = true;
  for (const [f, g0, type] of [[50, 0.009, 'sine'], [50.12, 0.009, 'sine'], [150, 0.0025, 'triangle']]) {
    const o = sirenCtx.createOscillator(), g = sirenCtx.createGain();
    o.type = type; o.frequency.value = f; g.gain.value = g0;
    o.connect(g); g.connect(sirenOut); o.start();
  }
}
// The engine is the one sound that can't be a scheduled one-shot: a persistent
// oscillator whose pitch rides the speed, with its gain gated by whether you
// drive. Each body type has its own voice — a truck idles lower and squarer
// than a compact — so a NEW RIDE from Gus's sounds different, not just looks it.
const ENGINE_VOICE = {
  convert: { type: 'sawtooth', base: 44, mul: 2.7, g: 1.0 },
  sedan:   { type: 'sawtooth', base: 52, mul: 2.9, g: 1.0 },
  wagon:   { type: 'triangle', base: 38, mul: 2.4, g: 1.7 },
  compact: { type: 'square',   base: 60, mul: 3.4, g: 0.7 },
  truck:   { type: 'square',   base: 29, mul: 1.9, g: 0.9 },
};
let engineOsc = null, engineGain = null;
function updateEngine() {
  if (!sirenCtx) return;
  ensureHum();
  if (!engineOsc) {
    engineOsc = sirenCtx.createOscillator(); engineOsc.type = 'sawtooth';
    engineGain = sirenCtx.createGain(); engineGain.gain.value = 0;
    engineOsc.connect(engineGain); engineGain.connect(sirenOut);
    engineOsc.start();
  }
  const v = ENGINE_VOICE[carType] || ENGINE_VOICE.convert;
  if (engineOsc.type !== v.type) engineOsc.type = v.type;
  const driving = mode === 'car' && drowning <= 0 && !paused;
  const f = v.base + Math.abs(speed) * v.mul + Math.sin(performance.now() * 0.02) * 1.5;
  engineOsc.frequency.setTargetAtTime(f, sirenCtx.currentTime, 0.05);
  const g = driving ? (0.012 + (Math.abs(speed) / MAX_SPEED) * 0.022) * v.g : 0;
  engineGain.gain.setTargetAtTime(g, sirenCtx.currentTime, 0.08);
}
// Ride sounds, while you're in the seat: a music-box waltz on the carousel, a
// track rattle on the coaster (silent in the station), a motor buzz in the
// bumper car. All scheduled one-shots, so mute needs nothing special.
const CAROUSEL_TUNE = [523, 659, 784, 659, 698, 587, 784, 523, 659, 784, 880, 784, 698, 659, 587, 523];
let rideBeat = 0, rideSndT = 0;
function updateRideAudio(dt) {
  if (!sirenCtx || !riding) { rideBeat = 0; rideSndT = 0; return; }
  if (paused) return;                 // dt is 0 — without this the due beat fires every frame
  rideSndT -= dt;
  if (rideSndT > 0) return;
  const t = sirenCtx.currentTime;
  if (riding.kind === 'carousel') {
    rideSndT = 0.3;
    tone(CAROUSEL_TUNE[rideBeat % CAROUSEL_TUNE.length], t, 0.22, 0.045, 'triangle');
    if (rideBeat % 4 === 0) tone(262, t, 0.28, 0.028, 'triangle');
    rideBeat++;
  } else if (riding.kind === 'coaster') {
    rideSndT = 0.09;
    if (riding.wait <= 0) tone(70 + rnd(-8, 8), t, 0.03, 0.03, 'square');
  } else {
    rideSndT = 0.13;
    tone(96 + rnd(-6, 6), t, 0.08, 0.02, 'sawtooth');
  }
}
let crashT = 0, dingT = 0, sayT = 0;
function crashSfx(impact) {                        // wall and building thumps
  if (!sirenCtx || crashT > 0) return;
  crashT = 0.18;
  const t = sirenCtx.currentTime, v = Math.min(0.2, 0.06 + impact * 0.004);
  tone(52, t, 0.16, v, 'square');
  tone(38, t + 0.02, 0.22, v * 0.8, 'square');
  tone(rnd(170, 240), t, 0.06, v * 0.5, 'sawtooth');
}
function clangSfx(impact) {                        // car-on-car metal
  if (!sirenCtx || crashT > 0) return;
  crashT = 0.15;
  const t = sirenCtx.currentTime, v = Math.min(0.16, 0.05 + impact * 0.003);
  tone(rnd(280, 340), t, 0.05, v, 'square');
  tone(rnd(150, 190), t + 0.03, 0.1, v * 0.7, 'square');
}
function dingSfx() {                               // street furniture pinging off the bumper
  if (!sirenCtx || dingT > 0) return;
  dingT = 0.08;
  tone(rnd(620, 900), sirenCtx.currentTime, 0.05, 0.05, 'triangle');
}
function doorSfx(open) {
  if (!sirenCtx) return;
  const t = sirenCtx.currentTime;
  if (open) { tone(170, t, 0.07, 0.06, 'square'); tone(260, t + 0.08, 0.09, 0.05, 'square'); }
  else { tone(240, t, 0.06, 0.05, 'square'); tone(120, t + 0.07, 0.12, 0.08, 'square'); }
}
function boomSfx() {                               // a wall charge going off
  if (!sirenCtx) return;
  const t = sirenCtx.currentTime;
  tone(46, t, 0.34, 0.22, 'square');
  tone(64, t + 0.03, 0.26, 0.16, 'square');
  tone(rnd(110, 150), t + 0.01, 0.12, 0.1, 'sawtooth');
}
// The townsfolk have opinions, and which opinion depends on what you just did to them.
// One shared list meant a person you had just run over complained about your manners,
// which is funny once. Three banks: shouldered past, booted, and put on the tarmac.
// Deliberately long — the rate limiter lets maybe one line every second and a half
// through, so a short list is audibly a short list within about a minute of play.
const OUCH = {
  barge: ['Hey!', 'Watch it!', 'Rude!', 'Excuse you!', 'Do you mind?', "I'm walking here!",
    'Manners!', 'Personal space!', 'Wait your turn!', 'Unbelievable!', "That's my elbow!",
    'Some of us are in a hurry!', 'Oh, sure, just barge right through!', 'Hands!',
    'You got a licence for those elbows?', 'I was in the middle of a thought!',
    'Well, I never!', 'Somebody raised you wrong.', 'Was that necessary?',
    "I'll have you know I'm a taxpayer!", 'Careful!', 'Steady on!'],
  kick: ['Ouch!', 'My shin!', 'Not the face!', 'Cut it out!', 'Stop it!', 'Owww!',
    'Why?!', 'What did I do?', 'That is assault!', 'My good leg!', 'You kicked me!',
    'I felt that in my teeth!', 'Right in the dignity!', 'I have a bad ankle!',
    'Ohh, that smarts!', 'I just had these pressed!', 'Somebody hold my bag!',
    'Not the shins, anything but the shins!', "That's coming out of someone's wages!",
    'My knee does not bend that way!', 'Rude and painful!'],
  punch: ['My nose!', 'Ow, my eye!', 'Right in the face!', 'That was my jaw!', 'Hey!',
    'You punched me!', 'Oh, it is ON!', 'That is a lawsuit!', 'My glasses!',
    'I felt that one!', 'Right, hold my coat.', 'You want some?', 'Big mistake!',
    'I box, you know!', 'Ouch! Rude and painful!', 'My good side!', 'Say that again!',
    'I have a very good dentist!'],
  // they walked into you, not the other way round
  bump: ['Sorry!', 'Oh — sorry!', 'My fault!', 'Beg your pardon.', 'Whoops!',
    'Excuse me!', "Didn't see you there!", 'Pardon me!', 'Oh! Hello.', 'Sorry about that!',
    'Coming through — sorry!', 'Miles away, sorry.'],
  car:  ['My groceries!', 'Look out!', 'Whoaaa!', 'Not again!', 'My back!', 'Aaargh!',
    'Learn to drive!', 'Oh come on!', 'My casserole!', 'I was nearly home!',
    'I only came out for milk!', "There's a pavement for that!", 'My hip!',
    'Somebody get the number plate!', 'That was a green light for me!',
    'This is a residential street!', 'Tell my cat I love her!', 'Slow down!',
    'I have insurance for this... I think.', 'Every single time!', 'Twenty is plenty!'],
};
// A whole town in one squeaky register sounded like one very unlucky person, so
// each shout picks a register: gruff, ordinary, or high. Where the browser exposes
// named voices we pick a matching one; otherwise pitch alone carries it.
const VOICE_REGISTERS = [
  { pitch: [0.55, 0.75], rate: 0.95, want: /david|alex|daniel|fred|male|george|james|rishi|thomas/i },
  { pitch: [0.85, 1.05], rate: 1.05, want: /google uk english male|male|mark|aaron/i },
  { pitch: [1.55, 1.85], rate: 1.2,  want: /samantha|victoria|karen|zira|female|susan|fiona/i },
];
let voiceCache = null;
function pickVoice(re) {
  if (!voiceCache) {
    try { voiceCache = speechSynthesis.getVoices() || []; } catch (e) { voiceCache = []; }
  }
  if (!voiceCache.length) return null;
  const hits = voiceCache.filter(v => re.test(v.name));
  return hits.length ? rpick(hits) : null;
}
let lastSaid = '';
function sayOuch(kind) {
  if (sayT > 0 || muted) return;      // speech is its own pipe — the master gain can't reach it
  sayT = 1.15;
  try {
    if (!window.speechSynthesis || speechSynthesis.speaking) return;
    const bank = OUCH[kind] || OUCH.barge;
    // never the same line twice running: with a rate limit this slow, an immediate
    // repeat is the one thing that makes a big list sound small
    let line = mpick(bank);
    for (let i = 0; i < 3 && line === lastSaid; i++) line = mpick(bank);
    lastSaid = line;
    const u = new SpeechSynthesisUtterance(line);
    const r = rpick(VOICE_REGISTERS);
    const v = pickVoice(r.want);
    if (v) u.voice = v;
    u.pitch = rnd(r.pitch[0], r.pitch[1]);
    u.rate = r.rate; u.volume = 0.62;
    speechSynthesis.speak(u);
  } catch (e) {}
}

function spawnCop() {
  const sub = mode === 'car' ? car.position : player.position;
  // arrive from off-screen rather than appearing next to you
  let best = -1, bd = 0;
  for (let k = 0; k < 30; k++) {
    const i = (Math.random()*NET.nodes.length)|0, n = NET.nodes[i];
    if (!n.e.length) continue;
    const d = Math.hypot(n.x-sub.x, n.z-sub.z);
    if (d > 90 && d < 260 && d > bd) { bd = d; best = i; }
  }
  if (best < 0) return false;
  const n = NET.nodes[best];
  const t = { type:'sedan', color: COP_PAINT, col: new THREE.Color(COP_PAINT),
    x: n.x, z: n.z, yaw: 0, ei: n.e[0], from: best, dist: 0,
    baseSpeed: COP_SPEED, cur: 14, gap: 99, fx: 0, fz: 1,
    stopping: false, waitT: 0, vx: 0, vz: 0, spin: 0, knock: 0, hitCooldown: 0,
    y: 0, vy: 0, pitch: 0, roll: 0, pitchV: 0, rollV: 0, rec: 0, 
    cop: true, chase: false, arrest: false };
  traffic.push(t); cops.push(t);
  return true;
}

// a bright downward chevron over each rival so you can pick them out of traffic
const rivalTag = instanced(new THREE.ConeGeometry(0.55, 1.0, 4).rotateX(Math.PI),
  new THREE.MeshBasicMaterial({ color: 0xffffff }), RIVAL_CAP, false);
rivalTag.count = 0; scene.add(rivalTag);
function rivalHome(t) {                          // a far town node to (re)enter from
  const sub = mode === 'car' ? car.position : player.position;
  let best = -1, bd = 0;
  for (let k = 0; k < 40; k++) {
    const i = (Math.random()*NET.nodes.length)|0, n = NET.nodes[i];
    if (!n.e.length || NET.edges[n.e[0]].hw) continue;      // start on a town street
    const d = Math.hypot(n.x - sub.x, n.z - sub.z);
    if (d > 120 && d > bd) { bd = d; best = i; }
  }
  return best < 0 ? (Math.random()*NET.nodes.length)|0 : best;
}
function spawnRival(def) {
  const from = rivalHome(def), n = NET.nodes[from];
  const t = { type: def.type, color: def.color, col: new THREE.Color(def.color),
    x: n.x, z: n.z, yaw: 0, ei: n.e[0], from, dist: 0,
    baseSpeed: rnd(13, 17), cur: 8, gap: 99, fx: 0, fz: 1,
    stopping: false, waitT: 0, vx: 0, vz: 0, spin: 0, knock: 0, hitCooldown: 0,
    y: 0, vy: 0, pitch: 0, roll: 0, pitchV: 0, rollV: 0, rec: 0,
    rival: { name: def.name, taunts: def.taunts, mood: 'cruise', huntT: 0, cd: 0,
             hp: RIVAL_HP, respawn: 0, def } };
  traffic.push(t); rivals.push(t);
}
// returns true when the rival is driving itself (hunting or down); false while it
// cruises the graph like ordinary traffic and should fall through to that code.
function updateRival(t, dt) {
  const r = t.rival;
  if (r.respawn > 0) {
    r.respawn -= dt;
    if (r.respawn <= 0) {                        // revive far away, good as new
      const from = rivalHome(r.def), n = NET.nodes[from];
      t.from = from; t.ei = n.e[0]; t.dist = 0; t.x = n.x; t.z = n.z;
      t.y = 0; t.pitch = 0; t.roll = 0; t.knock = 0; r.hp = RIVAL_HP; r.mood = 'cruise';
    }
    return true;
  }
  const dx = car.position.x - t.x, dz = car.position.z - t.z, d = Math.hypot(dx, dz) || 1;
  r.cd = Math.max(0, r.cd - dt);
  if (r.mood === 'cruise') {
    if (mode === 'car' && d < RIVAL_NOTICE) { r.mood = 'hunt'; r.huntT = 16; rivalTaunt(t, 0); }
    return false;
  }
  r.huntT -= dt;
  if (r.huntT <= 0 || mode !== 'car' || d > RIVAL_LOSE) {
    if (d <= RIVAL_LOSE && r.huntT <= 0) rivalTaunt(t, 2);
    r.mood = 'cruise'; rejoin(t); return false;
  }
  t.yaw = lerpAngle(t.yaw, Math.atan2(dx, dz), 1 - Math.exp(-dt*3.4));
  t.cur += (RIVAL_SPEED - t.cur) * Math.min(1, dt*2.6);
  const res = collideCircle(t.x + Math.sin(t.yaw)*t.cur*dt, t.z + Math.cos(t.yaw)*t.cur*dt, 1.9, colliders);
  t.x = res.x; t.z = res.z; t.fx = Math.sin(t.yaw); t.fz = Math.cos(t.yaw);
  if (t.cur > 1.5) hitPeopleAt(t.x, t.z, t.fx, t.fz, t.cur, 1.9);
  if (d < 4.7 && r.cd <= 0) {                     // rammed you
    r.cd = 1.2;
    damageCar(6 + Math.min(9, t.cur*0.35));
    speed *= 0.72; shake = Math.min(1.7, shake + 0.5);
    burst((t.x + car.position.x)/2, 1.2, (t.z + car.position.z)/2, 0xff6a3d, 9);
    clangSfx(t.cur);
    t.vx = -t.fx*8; t.vz = -t.fz*8; t.spin = rnd(-1.2, 1.2); t.knock = 0.45;
    rivalTaunt(t, 1);
  }
  return true;
}
// you rammed a rival: chip its health, and wreck it on a hard enough hit
function rivalHit(t, impact) {
  const r = t.rival;
  if (r.respawn > 0) return;
  r.hp -= impact;
  if (r.hp <= 0) {
    r.respawn = 8; r.mood = 'cruise';
    addCoins(70); chaosHit(45);
    burst(t.x, 1.4, t.z, 0xff8a3d, 22); burst(t.x, 1.0, t.z, 0x33343c, 12);
    toast('WRECKED ' + r.name + '!');
    const a = Math.random()*6.28;                 // fling it, big
    t.vx = Math.cos(a)*impact*0.9; t.vz = Math.sin(a)*impact*0.9;
    t.vy = 6 + impact*0.2; t.spin = rnd(-3, 3); t.pitchV = rnd(-4, 4); t.rollV = rnd(-4, 4);
    t.knock = 1.6;
  }
}
for (const def of RIVAL_DEFS) spawnRival(def);
function despawnCop(t) {
  const i = traffic.indexOf(t); if (i >= 0) traffic.splice(i, 1);
  const j = cops.indexOf(t);    if (j >= 0) cops.splice(j, 1);
}
function clearHeat() {
  dismissOfficer();
  heat = 0; stars = 0; bustT = 0;
  comboPts = 0; comboMult = 1; comboHits = 0; comboT = 0;
  while (cops.length) despawnCop(cops[0]);
}
function busted() {
  missionEvent('busted');
  toast('BUSTED!');
  burst(car.position.x, 1.4, car.position.z, 0x3f7bff, 16);
  clearHeat();
  shake = 1.8; carHealth = 100;
  car.position.set(SPAWN.x, surfaceY(SPAWN.x, SPAWN.z), SPAWN.z);
  heading = SPAWN.heading; speed = 0; carVY = 0; drowning = 0; airT = 0; airPeak = 0;
  car.rotation.set(0, heading, 0); camYaw = heading;
  // wherever they caught you, you restart in the car
  mode = 'car'; player.visible = false; rider.visible = true;
  playerRag.active = false; player.rotation.set(0, 0, 0); player.position.y = 0;
}

function updateChaos(dt) {
  const sub = mode === 'car' ? car.position : player.position;
  if (crashT > 0) crashT -= dt;
  if (dingT > 0) dingT -= dt;
  if (sayT > 0) sayT -= dt;
  updateEngine();
  updateRideAudio(dt);

  // While you're wanted the combo is held, not ticking down: it banks at a bonus when
  // you shake them off, and is lost entirely if they take you. Without this the run
  // always lapsed at 1x long before a chase ended, so the escape bonus never paid.
  if (comboT > 0 && stars === 0) { comboT -= dt; if (comboT <= 0) bankCombo(1); }
  cleanT += dt;
  // heat bleeds off once you stop causing trouble, and faster the longer you behave
  if (cleanT > 2.5) heat = Math.max(0, heat - dt * (3 + Math.min(cleanT, 12) * 0.9));

  const was = stars;
  stars = 0;
  for (let i = STAR_AT.length - 1; i >= 1; i--) if (heat >= STAR_AT[i]) { stars = i; break; }
  if (stars > was) toast(was === 0 ? 'HEAT!' : stars + '-STAR WANTED');
  if (stars === 0 && was > 0) { toast("LOST 'EM!"); bankCombo(1.6); }

  // keep the right number of cars on you, and recycle any that fall too far behind
  for (let i = cops.length - 1; i >= 0; i--) {
    const t = cops[i];
    if (Math.hypot(t.x - sub.x, t.z - sub.z) > 420) despawnCop(t);
  }
  let guard = 0;
  while (cops.length > stars) despawnCop(cops[cops.length - 1]);
  while (cops.length < stars && guard++ < 4) if (!spawnCop()) break;

  // being leaned on by a police car wears your car down, but only the officer busts you
  if (stars > 0 && mode === 'car' && drowning <= 0 && Math.abs(speed) > 3.5) {
    for (const t of cops) if (!t.arrest && Math.hypot(t.x - car.position.x, t.z - car.position.z) < 4.4) {
      damageCar(dt * 9);
      shake = Math.min(1.1, shake + dt*1.6);
    }
  }
  updateOfficer(dt, sub);

  // light bars on the roof, POLICE plates on the doors
  const flash = (performance.now() * 0.007) | 0;
  let ci = 0, di = 0, nearest = Infinity;
  for (const t of cops) {
    if (ci >= COP_MAX) break;
    dummy.position.set(t.x, 2.42, t.z); dummy.rotation.set(0, t.yaw, 0);
    dummy.scale.set(1,1,1); dummy.updateMatrix();
    copLight.setMatrixAt(ci, dummy.matrix);
    copLight.setColorAt(ci, ((flash + ci) & 1) ? COP_RED : COP_BLUE);
    ci++;
    for (const sd of [1, -1]) {                 // door plates face outward
      dummy.position.set(t.x + Math.cos(t.yaw)*1.27*sd, 0.88, t.z - Math.sin(t.yaw)*1.27*sd);
      dummy.rotation.set(0, t.yaw + (sd > 0 ? Math.PI/2 : -Math.PI/2), 0);
      dummy.updateMatrix();
      copDecal.setMatrixAt(di++, dummy.matrix);
    }
    nearest = Math.min(nearest, Math.hypot(t.x - sub.x, t.z - sub.z));
  }
  copLight.count = ci;
  copLight.instanceMatrix.needsUpdate = true;
  if (copLight.instanceColor) copLight.instanceColor.needsUpdate = true;
  copDecal.count = di;
  copDecal.instanceMatrix.needsUpdate = true;

  // a couple of fast bleeps when a pursuer is close behind — not a constant wail
  bleepT -= dt;
  if (cops.length && nearest < 85 && bleepT <= 0) {
    let onTail = mode !== 'car';
    if (!onTail) {                              // behind you, roughly
      const fx = Math.sin(heading), fz = Math.cos(heading);
      for (const t of cops) {
        const dx = car.position.x - t.x, dz = car.position.z - t.z;
        const d = Math.hypot(dx, dz) || 1;
        if (d < 85 && (dx*fx + dz*fz)/d > 0.25) { onTail = true; break; }
      }
    }
    if (onTail) {
      sirenBleep(Math.min(0.13, 0.04 + 0.1 * Math.max(0, 1 - nearest/85)));
      bleepT = nearest < 30 ? 1.7 : 3.0;        // more insistent the closer they are
    }
  }
}

// =================================================================
//  CASTLE CHICKENS
//  A flock loose in the Retirement Castle's great hall. They peck about, scatter from
//  anything that comes near, and burst into feathers under the car. One instanced
//  mesh for the tintable body, a second riding the same matrices for beak and comb.
// =================================================================
const chickens = [];
{
  const bodyGeo = merge([
    baked(new THREE.SphereGeometry(0.34, 16, 12).scale(1, 0.85, 1.2), 0, 0.38, 0),
    baked(new THREE.SphereGeometry(0.17, 16, 12), 0, 0.72, 0.3),
    baked(new THREE.ConeGeometry(0.12, 0.32, 16), 0, 0.52, -0.38, -1.9),
    baked(BOX(0.05, 0.3, 0.05), -0.09, 0.15, 0),
    baked(BOX(0.05, 0.3, 0.05), 0.09, 0.15, 0),
  ]);
  const trimGeo = merge([
    baked(new THREE.ConeGeometry(0.06, 0.18, 16), 0, 0.71, 0.45, Math.PI/2),
    baked(BOX(0.07, 0.13, 0.15), 0, 0.87, 0.27),
  ]);
  const N = 12;
  const cBody = instanced(bodyGeo, new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: RAMP }), N);
  const cTrim = instanced(trimGeo, toon(0xe8952f), N, false);
  cTrim.instanceMatrix = cBody.instanceMatrix;         // shared: written once, drawn twice
  scene.add(cBody, cTrim);
  const FEATHER = [0xffffff, 0xf3e6c8, 0xc9863f, 0xe8e3d3];
  const col = new THREE.Color();
  for (let i = 0; i < N; i++) {
    chickens.push({ x: 0, z: 0, yaw: rnd(0, 6.28), speed: 0, t: rnd(0.5, 2),
                    phase: rnd(0, 6.28), dead: 0, fled: 0, hue: rpick(FEATHER) });
    cBody.setColorAt(i, col.setHex(chickens[i].hue));
  }
  if (cBody.instanceColor) cBody.instanceColor.needsUpdate = true;
  chickens.mesh = cBody; chickens.trim = cTrim;
}
// The flock lives in the farm pen now (open ground, low fence); the castle hall
// is only the fallback if the pen found no site, so the mission always works.
const flockHome = () => PEN.inner || CASTLE.inner;
function chickenSpot(c) {
  const r = flockHome();
  c.x = rnd(r.x0 + 2.4, r.x1 - 2.4); c.z = rnd(r.z0 + 2.4, r.z1 - 2.4);
}
let chickensPlaced = false, chickensDowned = 0, chickenKicked = 0;
function updateChickens(dt) {
  if (!flockHome()) return;
  if (!chickensPlaced) { for (const c of chickens) chickenSpot(c); chickensPlaced = true; }
  const sub = mode === 'car' ? car.position : player.position;
  const r = flockHome();
  let i = 0;
  for (const c of chickens) {
    if (c.dead > 0) {
      c.dead -= dt;
      if (c.dead <= 0) { chickenSpot(c); c.fled = 0; }
      else continue;
    }
    const dx = c.x - sub.x, dz = c.z - sub.z, d2 = dx*dx + dz*dz;
    // run one down and the feathers fly
    if (mode === 'car' && d2 < 5.5 && Math.abs(speed) > 5) {
      burst(c.x, 0.8, c.z, 0xffffff, 12);
      burst(c.x, 1.3, c.z, c.hue, 8);
      chaosHit(10); shake = Math.min(1.2, shake + 0.15);
      chickensDowned++;                                 // Feather Frenzy keeps score off this
      c.dead = rnd(6, 11); continue;
    }
    if (d2 < 100) {                                     // scatter from whatever's coming
      c.fled = 0.6;
      c.yaw = Math.atan2(dx, dz) + rnd(-0.5, 0.5);
      c.speed = 6.8;
    } else if (c.fled > 0) { c.fled -= dt; }
    else {
      c.t -= dt;
      if (c.t <= 0) { c.t = rnd(0.7, 2.4); c.yaw += rnd(-1.6, 1.6); c.speed = Math.random() < 0.4 ? 0 : rnd(0.5, 1.3); }
    }
    // keep the flock in the hall
    const mx = (r.x0 + r.x1)/2, mz = (r.z0 + r.z1)/2;
    if (c.x < r.x0 + 2.0 || c.x > r.x1 - 2.0 || c.z < r.z0 + 2.0 || c.z > r.z1 - 2.0)
      c.yaw = Math.atan2(mx - c.x, mz - c.z) + rnd(-0.3, 0.3);
    const sp = c.fled > 0 ? c.speed : Math.min(c.speed, 1.4);
    if (sp > 0) {
      const res = collideCircle(c.x + Math.sin(c.yaw)*sp*dt, c.z + Math.cos(c.yaw)*sp*dt, 0.3,
        PEN.inner ? PEN.walls : (CASTLE.walls || colliders));
      if (res.hit) c.yaw += 1.4;
      c.x = res.x; c.z = res.z;
      c.phase += dt * (c.fled > 0 ? 26 : 10);
    }
    dummy.position.set(c.x, Math.abs(Math.sin(c.phase)) * (c.fled > 0 ? 0.16 : 0.05), c.z);
    dummy.rotation.set(0, c.yaw, 0); dummy.scale.setScalar(1);
    dummy.updateMatrix();
    chickens.mesh.setMatrixAt(i, dummy.matrix);
    i++;
  }
  chickens.mesh.count = chickens.trim.count = i;
  chickens.mesh.instanceMatrix.needsUpdate = true;
}

// Which jobs will not start unless you are behind a wheel. This duplicates the
// `needsCar` flags in MISSION_DEFS because the markers are placed long before that
// object exists — so the two are cross-checked at startup and a drift shows up in the
// console rather than as a giver you can never reach.
const CAR_JOB = { donut: 1, taxi: 1, derby: 1, race: 1, street: 1, getaway: 1, rampage: 1 };

// =================================================================
//  ? CRATES
//  A crate in a yard with a question mark on every side. Boot it (or drive into
//  it) and it bursts, and what comes out is the point: mostly coins, often a
//  bomb, and once in a long while an animal that changes what the next minute of
//  the game is about. The odds are 60 coins / 10 jackpot / 25 bomb / 2.5 cat /
//  2.5 dog — the brief left ten points unspoken, and a jackpot is the most
//  useful thing to do with them, because "sometimes a *lot* of coins" is what
//  makes opening the next one worth doing.
//
//  Placement is the same post-tree pass the coin rings use, so it is free of the
//  seeded stream: house footprints, a few metres off the back of the building,
//  filtered against roads and anything already standing.
// =================================================================
const crates = [];
{
  const qTex = surfCanvas(128, (g, P) => {
    g.fillStyle = '#e8dcc0'; g.fillRect(0, 0, P, P);
    g.fillStyle = '#b98d55'; g.fillRect(0, 0, P, 9); g.fillRect(0, P-9, P, 9);
    g.fillRect(0, 0, 9, P); g.fillRect(P-9, 0, 9, P);
    g.fillStyle = '#6b4a24';
    g.font = 'bold 82px "Trebuchet MS", sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('?', P/2, P/2 + 4);
  });
  qTex.wrapS = qTex.wrapT = THREE.ClampToEdgeWrapping;
  const CR = 1.25;
  const mesh = instanced(BOX(CR, CR, CR).translate(0, CR/2, 0),
    new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: RAMP, map: qTex }), 90, true);
  for (const b of mapBoxes) {
    if (crates.length >= 90 || b.kind !== 'house') continue;
    if (vary(b.x, b.z, 100) >= 46) continue;              // roughly half the houses
    // out the back: the house faces its street, so the far side is the garden
    const a = vary(b.z, b.x, 4) * Math.PI/2;
    const x = b.x + Math.cos(a)*(b.w/2 + 3.4), z = b.z + Math.sin(a)*(b.d/2 + 3.4);
    if (onRoad(x, z, 2.2) || pointBlocked(x, z, 1.4) || overRiver(x, z, 4)) continue;
    crates.push({ x, z, y: groundH(x, z), gone: false, i: crates.length });
  }
  crates.forEach(c => {
    dummy.position.set(c.x, c.y, c.z);
    dummy.rotation.set(0, vary(c.x, c.z, 8)*0.19, 0);
    dummy.scale.setScalar(1); dummy.updateMatrix();
    mesh.setMatrixAt(c.i, dummy.matrix);
    // solid until it is broken, so you can't walk through one
    c.box = { minX: c.x-0.7, maxX: c.x+0.7, minZ: c.z-0.7, maxZ: c.z+0.7 };
    colliders.push(c.box);
  });
  mesh.count = crates.length;
  mesh.instanceMatrix.needsUpdate = true;
  scene.add(mesh);
  var crateMesh = mesh;
  console.log(`crates: ${crates.length} in yards`);
}
const crateGrid = new Map();
for (const c of crates) {
  const k = Math.floor(c.x/GAP_Q)+','+Math.floor(c.z/GAP_Q);
  let b = crateGrid.get(k); if (!b) crateGrid.set(k, b=[]); b.push(c);
}

// --- bombs -------------------------------------------------------
// A short fuse, a flash, then a shove. On foot it puts you down; in the car it
// damages you and kicks the back out. It hurts whoever is standing nearby too,
// which is the reason to lure someone next to one.
const bombs = [];
function spawnBomb(x, z) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 12), toon(0x23262e)));
  const fuse = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.34, 8).translate(0, 0.17, 0), toon(0xb9a06a));
  fuse.position.set(0, 0.38, 0); fuse.rotation.z = -0.4; g.add(fuse);
  const spark = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xffd23b }));
  spark.position.set(-0.14, 0.7, 0); g.add(spark);
  g.position.set(x, surfaceY(x, z) + 0.42, z);
  scene.add(g);
  bombs.push({ g, spark, t: 1.5, x, z });
  toast('UH OH');
}
function updateBombs(dt) {
  for (let i = bombs.length - 1; i >= 0; i--) {
    const b = bombs[i];
    b.t -= dt;
    const fast = b.t < 0.6;
    b.spark.visible = Math.sin(performance.now() * (fast ? 0.05 : 0.02)) > 0;
    b.g.scale.setScalar(1 + Math.max(0, 0.35 - b.t) * 0.8);      // swells just before it goes
    if (b.t > 0) { if (b.t < 1.48 && b.t > 1.42) tone(760, sirenCtx ? sirenCtx.currentTime : 0, 0.05, 0.05); continue; }
    scene.remove(b.g); bombs.splice(i, 1);
    boomSfx();
    burst(b.x, 1.0, b.z, 0xffb347, 22);
    burst(b.x, 1.6, b.z, 0x8a8a8a, 14);
    shake = Math.min(1.8, shake + 0.9);
    chaosHit(30);
    const sub = mode === 'car' ? car.position : player.position;
    const dx = sub.x - b.x, dz = sub.z - b.z, d = Math.hypot(dx, dz) || 1;
    if (d < 9) {
      const nx = dx/d, nz = dz/d, force = (1 - d/9);
      if (mode === 'car') { damageCar(26*force); speed *= 0.4; }
      else if (!playerRag.active) applyRagdoll(player, playerRag, nx, nz, 8 + 9*force);
    }
    hitPeopleAt(b.x, b.z, 1, 0, 16, 6.5, false);                 // everyone nearby goes over
  }
}

// --- the cat and the dog ------------------------------------------
// Two very rare crate drops, and the only things in town that are neither traffic
// nor townsfolk. The cat wants nothing to do with you and leaves; the dog decides
// you are its person and will not be talked out of it.
const pets = [];
function petGeo(cat) {
  const fur = cat ? 0x6b6f78 : 0xc9863f, pale = cat ? 0xe8e3d3 : 0xe8d06a;
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.34, 16, 12).scale(1, 0.82, 1.6), toon(fur));
  body.position.y = cat ? 0.42 : 0.46; body.castShadow = true; g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(cat ? 0.21 : 0.25, 16, 12), toon(fur));
  head.position.set(0, cat ? 0.58 : 0.62, cat ? 0.46 : 0.5); g.add(head);
  const muz = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 9).scale(1, 0.8, 1.3), toon(pale));
  muz.position.set(0, cat ? 0.53 : 0.56, cat ? 0.62 : 0.72); g.add(muz);
  // Ears OUTSIDE the skull — the first version parked the boxes at x ±0.13 on a
  // 0.25-radius head, which buried them almost entirely and read as no ears at all.
  for (const sx of [-1, 1]) {
    const ear = cat
      ? new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.22, 4), toon(fur))          // pricked
      : new THREE.Mesh(BOX(0.1, 0.28, 0.06), toon(fur));                           // floppy, draped
    ear.position.set(sx*(cat ? 0.14 : 0.24), cat ? 0.78 : 0.7, cat ? 0.42 : 0.44);
    if (!cat) { ear.rotation.z = sx*0.55; ear.position.y = 0.7; }
    g.add(ear);
  }
  // and a face: bulging crowd-style eyes with pupils, and a nose on the muzzle tip
  const eyeMat = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: RAMP });
  const pupilMat = new THREE.MeshBasicMaterial({ color: 0x14192e });
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(cat ? 0.06 : 0.075, 12, 9), eyeMat);
    eye.position.set(sx*(cat ? 0.08 : 0.09), cat ? 0.64 : 0.7, cat ? 0.61 : 0.66);
    g.add(eye);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(cat ? 0.028 : 0.032, 8, 6), pupilMat);
    pupil.position.set(eye.position.x, eye.position.y, eye.position.z + (cat ? 0.045 : 0.055));
    g.add(pupil);
  }
  const nose = new THREE.Mesh(new THREE.SphereGeometry(cat ? 0.035 : 0.05, 8, 6),
    cat ? toon(0xe87ab0) : new THREE.MeshBasicMaterial({ color: 0x14192e }));
  nose.position.set(0, cat ? 0.56 : 0.6, cat ? 0.75 : 0.86); g.add(nose);
  const tail = new THREE.Mesh(BOX(0.08, 0.08, cat ? 0.7 : 0.36).translate(0, 0, cat ? -0.35 : -0.18), toon(fur));
  tail.position.set(0, cat ? 0.52 : 0.5, cat ? -0.42 : -0.46);
  tail.rotation.x = cat ? -0.9 : -0.5; g.add(tail);
  const legs = [];
  for (const sx of [-1, 1]) for (const sz of [1, -1]) {
    const l = new THREE.Mesh(BOX(0.1, 0.42, 0.1).translate(0, -0.21, 0), toon(fur));
    l.position.set(sx*0.17, 0.42, sz*0.3); g.add(l); legs.push(l);
  }
  return { g, tail, legs };
}
function spawnPet(x, z, cat) {
  if (pets.length >= 6) { const old = pets.shift(); scene.remove(old.g); }
  const p = petGeo(cat);
  p.g.position.set(x, surfaceY(x, z), z);
  scene.add(p.g);
  pets.push({ ...p, cat, x, z, yaw: Math.random()*6.28, phase: Math.random()*6.28, life: cat ? 22 : 999 });
  toast(cat ? 'A CAT!' : 'A DOG!');
}
function updatePets(dt) {
  const sub = mode === 'car' ? car.position : player.position;
  for (let i = pets.length - 1; i >= 0; i--) {
    const p = pets[i];
    p.life -= dt;
    if (p.life <= 0) { scene.remove(p.g); pets.splice(i, 1); continue; }
    const dx = sub.x - p.x, dz = sub.z - p.z, d = Math.hypot(dx, dz) || 1;
    let tx, tz, spd;
    if (p.cat) { tx = -dx/d; tz = -dz/d; spd = d < 16 ? 7.5 : 0; }      // straight off
    else {
      // the dog holds a couple of metres back so it isn't inside you, and gives up
      // trying to keep pace with a car — it just watches you go
      const want = 2.4;
      spd = d > want ? Math.min(6.5, 1.6 + (d - want)*1.4) : 0;
      tx = dx/d; tz = dz/d;
      if (d > 60) { p.x = sub.x - dx/d*8; p.z = sub.z - dz/d*8; }       // teleport back in
    }
    if (spd > 0) {
      const r = collideCircle(p.x + tx*spd*dt, p.z + tz*spd*dt, 0.45, colliders);
      p.x = r.x; p.z = r.z;
      p.yaw = Math.atan2(tx, tz);
      p.phase += dt * spd * 2.2;
    } else p.phase += dt*1.5;
    p.g.position.set(p.x, surfaceY(p.x, p.z) + Math.abs(Math.sin(p.phase))*0.06, p.z);
    p.g.rotation.y = p.yaw;
    const sw = Math.sin(p.phase) * (spd > 0 ? 0.75 : 0.05);
    p.legs[0].rotation.x = sw;  p.legs[1].rotation.x = -sw;
    p.legs[2].rotation.x = -sw; p.legs[3].rotation.x = sw;
    // the dog wags when it has caught up with you; the cat's tail just sways
    p.tail.rotation.y = Math.sin(p.phase * (p.cat ? 0.8 : 2.4)) * (p.cat ? 0.25 : 0.7);
  }
}

// --- breaking one open --------------------------------------------
function breakCrate(c, fromX, fromZ) {
  if (c.gone) return;
  c.gone = true;
  c.box.minX = c.box.maxX = 1e9; c.box.minZ = c.box.maxZ = 1e9;   // parked, like a shut door
  dummy.position.set(c.x, -50, c.z); dummy.scale.setScalar(0); dummy.updateMatrix();
  crateMesh.setMatrixAt(c.i, dummy.matrix); crateMesh.instanceMatrix.needsUpdate = true;
  burst(c.x, 0.9, c.z, 0xd8bd8a, 16);
  crashSfx(14); shake = Math.min(1.2, shake + 0.25);
  const roll = Math.random();
  if (roll < 0.60)      { burstCoins(c.x, c.z, 6); chaosHit(10); }
  else if (roll < 0.70) { burstCoins(c.x, c.z, 16); chaosHit(20); toast('JACKPOT!'); }
  else if (roll < 0.95) spawnBomb(c.x, c.z);
  else if (roll < 0.975) spawnPet(c.x, c.z, true);
  else                  spawnPet(c.x, c.z, false);
}
function hitCratesAt(x, z, r) {
  const gx = Math.floor(x/GAP_Q), gz = Math.floor(z/GAP_Q);
  for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
    const b = crateGrid.get((gx+ox)+','+(gz+oz)); if (!b) continue;
    for (const c of b) {
      if (c.gone) continue;
      const dx = c.x - x, dz = c.z - z;
      if (dx*dx + dz*dz < r*r) breakCrate(c, x, z);
    }
  }
}

// =================================================================
//  TOWNSFOLK WITH SOMETHING TO SAY
//  (GARAGE is declared here rather than with the shop below: the markers block
//  runs at module-evaluation time and plants Gus on his forecourt, so the object
//  has to exist before it — a later `const` would be in the temporal dead zone.)
//  The floating "!" over a character, straight off the show's game — walk
//  into the glow and they'll chat.
// =================================================================
const GARAGE = { x: 0, z: 0, open: false, ride: 0 };
let TOWN_CPS = null;              // hoisted for the same reason: the markers block
                                  // calls townCircuit() to stand Tess on the grid
const MARKERS = [];
// The stunt park and the fair pick their sites with findGreen, which runs after
// this block — so their givers can't be placed here. The marker builder escapes
// through this hook instead of being hoisted with its dozen block-local helpers.
let addJobMarker = null;
{
  const c = document.createElement('canvas'); c.width = 128; c.height = 160;
  const g = c.getContext('2d');
  g.font = '900 150px "Trebuchet MS", Arial, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 18; g.lineJoin = 'round'; g.strokeStyle = '#3a0d16';
  g.strokeText('!', 64, 82); g.fillStyle = '#e8302f'; g.fillText('!', 64, 82);
  const bang = new THREE.CanvasTexture(c); bang.colorSpace = THREE.SRGBColorSpace;

  const glowMat = new THREE.MeshBasicMaterial({ color: 0x9ad8ff, transparent: true, opacity: 0.7, depthWrite: false });
  const discGeo = new THREE.CircleGeometry(2.3, 26).rotateX(-Math.PI/2);

  const LINES_OF_DIALOGUE = [
    ['NEIGHBOR', 'See a red "!" over somebody? They have a job for you.'],
    ['CLERK', 'Come back soon!'],
    ['KID', 'I like your car!'],
    ['COMIC GUY', 'Nice parking. Truly.'],
  ];
  // A job giver must land somewhere: try the anchor, then a widening ring around it.
  // Clear means clear of buildings, clear of the carriageway *and* on dry land:
  // an anchor near a bridge or a riverside junction otherwise stands its giver in
  // the water, and walking up to them drowns you before they can say hello.
  const spotOK = (x, z) => !pointBlocked(x, z, 2) && !onRoad(x, z, 1.5) && !overRiver(x, z, 8);
  // Can you get a CAR to this spot? clearSpot on its own only promises the giver is
  // standing somewhere legal — and the middle of a back garden, walled in by houses, is
  // legal. For a job that refuses to start unless you are in a car that is a dead end:
  // you can walk up and talk to them, and never once arrive in the thing they are asking
  // for. So a car job's giver also needs a street nearby with a clear run to it.
  function drivable(x, z) {
    let bx = 0, bz = 0, bd = 1e9;
    for (const st of STREETS) {
      if (st.kind === 'highway') continue;              // you cannot stop on the ring
      const dx = st.bx - st.ax, dz = st.bz - st.az, L2 = dx*dx + dz*dz || 1;
      const t = THREE.MathUtils.clamp(((x - st.ax)*dx + (z - st.az)*dz) / L2, 0, 1);
      const px = st.ax + dx*t, pz = st.az + dz*t;
      const d2 = (px-x)*(px-x) + (pz-z)*(pz-z);
      if (d2 < bd) { bd = d2; bx = px; bz = pz; }
    }
    const d = Math.sqrt(bd);
    if (d > 26) return false;                           // nothing to drive up from
    const steps = Math.max(1, Math.ceil(d / 1.5));      // and nothing solid on the way in
    for (let i = 1; i <= steps; i++) {
      const t = i/steps;
      if (pointBlocked(x + (bx-x)*t, z + (bz-z)*t, 1.7)) return false;
    }
    return true;
  }
  function clearSpot(x, z, needsCar) {
    const good = (px, pz) => spotOK(px, pz) && (!needsCar || drivable(px, pz));
    if (good(x, z)) return { x, z };
    // Ring search out to 30 m: a junction pad is ~16 m across and a wide street's
    // reserve can reach past 25, so an 11 m ceiling silently dropped any giver
    // anchored near a big intersection.
    for (let r = 3; r <= 30; r += 2.5) for (let a = 0.3; a < 6.4; a += Math.PI/6) {
      const nx = x + Math.cos(a)*r, nz = z + Math.sin(a)*r;
      if (good(nx, nz)) return { x: nx, z: nz };
    }
    // A giver standing slightly oddly beats a mission nobody can reach, so if there is
    // nowhere drivable at all, fall back to the plain search.
    return needsCar ? clearSpot(x, z, false) : null;
  }
  function marker(x, z, name, line, mission) {
    const s = mission ? clearSpot(x, z, !!CAR_JOB[mission])
                      : (pointBlocked(x, z, 2) ? null : { x, z });
    if (!s) return;
    x = s.x; z = s.z;
    const lk = pickLook();
    const g2 = buildPerson({ skin: lk.skin.getHex(), hair: lk.hair.getHex(),
      shirt: lk.shirt.getHex(), pants: lk.pants.getHex(), shoe: lk.shoe.getHex(), style: lk.style });
    g2.position.set(x, 0, z); g2.rotation.y = Math.random()*6.28; scene.add(g2);
    const disc = new THREE.Mesh(discGeo, mission ? jobMat : glowMat);
    disc.position.set(x, 0.07, z); scene.add(disc);
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: bang, transparent: true, depthWrite: false }));
    spr.scale.set(3.2, 4.0, 1); spr.position.set(x, 5.6, z); scene.add(spr);
    MARKERS.push({ x, z, g: g2, spr, disc, name, line, mission: mission || null, done: false, cool: 0 });
  }
  const jobMat = new THREE.MeshBasicMaterial({ color: 0xffd23b, transparent: true, opacity: 0.7, depthWrite: false });
  let mi = 0;
  marker(SPAWN.x + 26, SPAWN.z - (ROAD_HW + 3.5), ...LINES_OF_DIALOGUE[mi++]);  // greeter on the opening street
  for (const s2 of signs) { if (mi >= 3) break; marker(s2.x + rnd(-6,6), s2.z + rnd(5,9), ...LINES_OF_DIALOGUE[mi++]); }
  { const b2 = BLOCKS.find(x2 => x2.zone === 'shops');
    if (b2) marker(b2.cx, b2.r.z0 - WALK_HW - 5, ...LINES_OF_DIALOGUE[3]); }

  // ---- the job givers ----
  { const e = ENTERABLE.find(d => d.name === 'BIG DONUT');
    if (e) marker(e.x + e.fx*5 - e.fz*4, e.z + e.fz*5 + e.fx*4,
      'GLAZED DAN', 'A dozen glazed for the Power Plant. Go before they go cold!', 'donut'); }
  { const b = BLOCKS.find(b2 => b2.zone === 'plaza');
    if (b) marker(b.cx - 12, b.cz - 10,
      'RITA', "You a taxi? You are now. Let's go!", 'taxi'); }
  { const b = BLOCKS.find(b2 => b2.zone === 'civic');
    if (b) marker(b.cx + 10, b.cz + 8,
      'THIRSTY LOU', "I'm barred from the Rusty Mug. Fetch me a cold one?", 'mug'); }
  // Nurse Mabel moved to the farm pen with the flock — her marker is placed from
  // the pen block via addJobMarker, since the pen picks its site with findGreen.
  marker(STADIUM.cx, STADIUM.cz + STADIUM.rz + 9,
    'CRUSHER', 'Three rigs. One arena. Last one rolling wins.', 'derby');
  // Warden Norris, on the far side of the gate from Lefty Louie (who is at gate.x+8).
  // The two prison-gate givers keep well clear of each other.
  if (PRISON.gate) marker(PRISON.gate.x - 10, PRISON.gate.z - 12,
    'WARDEN NORRIS', "They're going over the walls! Grab the soaker and hose 'em down.", 'soak');
  marker(SPAWN.x - 32, SPAWN.z - (ROAD_HW + 3.5),
    'AXEL', 'One lap of the ring, through the mountain. Beat the clock.', 'race');
  // Tess stands beside the grid, not on it: a junction pad is ~16 m across, so an
  // offset small enough to read as "at the start line" lands in the road. Push out
  // along the first leg and then sideways off the carriageway.
  { const c = townCircuit(), a = c[0], b = c[1];
    const hx = b.x - a.x, hz = b.z - a.z, hl = Math.hypot(hx, hz) || 1;
    marker(a.x + hx/hl*18, a.z + hz/hl*18,
      'TIRE-IRON TESS', 'Three of us race these streets. Care to make it four?', 'street'); }
  // Louie stands outside the prison walls, which is exactly where you'd expect to
  // pick up a bag nobody should ask about
  if (PRISON.gate) marker(PRISON.gate.x + 8, PRISON.gate.z - 12,
    'LEFTY LOUIE', "This bag needs to cross town, and the law knows it's moving. Drive.", 'getaway');
  addJobMarker = marker;

  // ---- Gus, on his forecourt: not a job giver, a shop ----
  {
    // A 22x13 canopy needs far more room than clearSpot's 2 m probe guarantees, so
    // search outward from the spawn for a whole footprint that clears the road, the
    // buildings and the river — sampling the perimeter, not just the middle.
    const footprintFree = (x, z) => {
      for (let u = -13; u <= 13; u += 4.3) for (let v = -8; v <= 8; v += 4) {
        if (onRoad(x + u, z + v, 2) || pointBlocked(x + u, z + v, 2) || overRiver(x + u, z + v, 8))
          return false;
      }
      return true;
    };
    let s = null;
    for (let r = 16; r <= 150 && !s; r += 9)
      for (let a = 0; a < 6.28 && !s; a += Math.PI/9) {
        const x = SPAWN.x + Math.cos(a)*r, z = SPAWN.z + Math.sin(a)*r;
        if (footprintFree(x, z)) s = { x, z };
      }
    if (s) {
      GARAGE.x = s.x; GARAGE.z = s.z;
      const g3 = buildPerson({ skin: 0xffd90f, hair: 0x6b4a2f, shirt: 0x2f5fb0,
        pants: 0x3a3f4a, shoe: 0x14192e, style: 'cap' });
      g3.position.set(s.x, 0, s.z); scene.add(g3);
      GARAGE.fig = g3;
      const disc = new THREE.Mesh(discGeo, new THREE.MeshBasicMaterial(
        { color: 0x5ed85e, transparent: true, opacity: 0.65, depthWrite: false }));
      disc.position.set(s.x, 0.07, s.z); disc.scale.setScalar(1.5); scene.add(disc);
      const bd = signTexture('GUS\'S GARAGE', '#2f3550', '#ffd23b', 512, 128);
      const brd = signPanel(9, 2.25, bd);
      // faces -z, the way the forecourt is approached from the street; a solid back so it
      // never shows the name mirrored, on the front fascia where the roof doesn't hide it
      brd.position.set(s.x, 6.5, s.z - 13/2 - 0.55); brd.rotation.y = Math.PI; scene.add(brd);
      GARAGE.board = brd;

      // ---- the building: a pull-through service bay ----
      // Open at both ends along x so you can drive in one side and out the other.
      // Only the four posts and the back office are solid; the deck overhead and the
      // open ends are not, so the bay is a real thoroughfare rather than a dead end.
      const GW = 22, GD = 13, GH = 5.6;                 // span, depth, clearance
      const cxg = s.x, czg = s.z;
      const gmat = toon(0xe6e0cf), tmat = toon(0x8c3f5e), pmat = toon(0x6b6f76);
      const addSolid = (m, w, d) => {
        scene.add(m);
        colliders.push({ minX: m.position.x - w/2, maxX: m.position.x + w/2,
                         minZ: m.position.z - d/2, maxZ: m.position.z + d/2 });
      };
      { const roof = new THREE.Mesh(BOX(GW, 0.7, GD), gmat);
        roof.position.set(cxg, GH + 0.35, czg); roof.castShadow = true; scene.add(roof);
        const fascia = new THREE.Mesh(BOX(GW + 1.2, 1.1, 0.5), tmat);
        fascia.position.set(cxg, GH + 0.9, czg - GD/2 - 0.2); scene.add(fascia);
        const fascia2 = new THREE.Mesh(BOX(GW + 1.2, 1.1, 0.5), tmat);
        fascia2.position.set(cxg, GH + 0.9, czg + GD/2 + 0.2); scene.add(fascia2);
        for (const px of [-GW/2 + 1.1, GW/2 - 1.1]) for (const pz of [-GD/2 + 1.1, GD/2 - 1.1]) {
          const p = new THREE.Mesh(BOX(1.1, GH, 1.1), pmat);
          p.position.set(cxg + px, GH/2, czg + pz); p.castShadow = true;
          addSolid(p, 1.1, 1.1);
        }
        // the office along the back, with Gus's counter under the canopy
        const off = new THREE.Mesh(BOX(GW - 3, GH - 0.4, 3.4), gmat);
        off.position.set(cxg, (GH - 0.4)/2, czg + GD/2 - 1.7); off.castShadow = true;
        addSolid(off, GW - 3, 3.4);
        for (const wx of [-5.5, 0, 5.5]) {
          const win = new THREE.Mesh(BOX(3.2, 1.9, 0.2), toon(0x7fb8d8));
          win.position.set(cxg + wx, 3.1, czg + GD/2 - 3.45); scene.add(win);
        }
        // oil-stained apron so the bay reads as a floor, not grass
        const apron = new THREE.Mesh(new THREE.PlaneGeometry(GW + 3, GD + 2).rotateX(-Math.PI/2),
          toon(0x6f7178));
        apron.position.set(cxg, 0.03, czg); apron.receiveShadow = true; scene.add(apron);
      }
      // stand Gus clear of the office wall, under his own roof
      g3.position.set(cxg - 3, 0, czg + 2.2); g3.rotation.y = Math.PI;
      disc.position.set(cxg, 0.07, czg);
      GARAGE.x = cxg; GARAGE.z = czg;
    }
  }
}
let markerBob = 0;
function updateMarkers(dt, sub) {
  markerBob += dt*2.6;
  for (const m of MARKERS) {
    if (m.cool > 0) {                       // giver re-arms a moment after the job ends
      m.cool -= dt;
      if (m.cool <= 0) { m.spr.visible = true; m.disc.visible = true; }
      else continue;
    }
    if (m.done || !m.spr.visible) continue;
    m.spr.position.y = 5.5 + Math.sin(markerBob + m.x)*0.3;
    m.disc.scale.setScalar(1 + Math.sin(markerBob*1.4 + m.z)*0.07);
    m.g.rotation.y += dt*0.4;
    const dx = m.x - sub.x, dz = m.z - sub.z;
    if (dx*dx + dz*dz < 16) {
      if (m.mission) {
        // jobs that are all about driving refuse to start while you are on foot,
        // rather than handing you a delivery you cannot possibly make
        const def = MISSION_DEFS[m.mission];
        if (def && def.needsCar && mode !== 'car') {
          if (mode === 'foot') { m.nagT = (m.nagT || 0) - dt;
            if (m.nagT <= 0) { toast('YOU NEED TO BE IN A CAR'); m.nagT = 3; } }
        } else if (def && def.needsPlane && mode !== 'plane') {
          if (mode === 'foot') { m.nagT = (m.nagT || 0) - dt;
            if (m.nagT <= 0) { toast('GET IN THE PLANE FIRST'); m.nagT = 3; } }
        } else if (!MI) startMission(m.mission, m);
      } else {
        m.done = true;
        m.spr.visible = false; m.disc.visible = false;
        toast(m.name + ': ' + m.line);
        addCoins(15);
        burst(m.x, 1.6, m.z, 0x9ad8ff, 10);
      }
    }
  }
}

// =================================================================
//  FINDING OPEN GROUND
//  Zones turned out to be the wrong tool for "put this on the biggest green".
//  This seed has no `park` block at all and its one `plaza` is 286 m2, so the
//  stunt park had been quietly building nothing at all since the seed re-roll —
//  four ramps the README describes that were not in the game. This looks at the
//  ground instead of the zoning: a coarse occupancy set of every building
//  footprint and every planted tree, plus the road and river tests, scanned for
//  the most central rectangle that is genuinely empty. Whatever it hands out is
//  reserved, so two set pieces can never land on top of each other.
// =================================================================
const OCC = new Set();
{
  const CELL = 6, key = (x, z) => Math.floor(x/CELL) + ',' + Math.floor(z/CELL);
  for (const b of mapBoxes)
    for (let x = b.x - b.w/2 - 4; x <= b.x + b.w/2 + 4; x += CELL)
      for (let z = b.z - b.d/2 - 4; z <= b.z + b.d/2 + 4; z += CELL) OCC.add(key(x, z));
  for (const t of treeSpots)
    for (let x = t.x - 3; x <= t.x + 3; x += CELL)
      for (let z = t.z - 3; z <= t.z + 3; z += CELL) OCC.add(key(x, z));
  var occKey = key;
}
const TAKEN = [];
function findGreen(w, d) {
  const hw = w/2, hd = d/2;
  const clear = (cx, cz) => {
    for (const t of TAKEN)
      if (Math.abs(cx - t.x) < (w + t.w)/2 && Math.abs(cz - t.z) < (d + t.d)/2) return false;
    for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) {
      const x = cx + i*hw/3, z = cz + j*hd/3;
      if (onRoad(x, z, 3) || overRiver(x, z, 12) || OCC.has(occKey(x, z))) return false;
    }
    return true;
  };
  let best = null, bestD = Infinity;
  for (let cx = -TOWN; cx <= TOWN; cx += 12) for (let cz = -TOWN; cz <= TOWN; cz += 12) {
    const dd = cx*cx + cz*cz;
    if (dd >= bestD || !clear(cx, cz)) continue;         // prefer the middle of town
    bestD = dd; best = { x: cx, z: cz };
  }
  if (best) TAKEN.push({ x: best.x, z: best.z, w, d });
  return best;
}

// Like findGreen, but for the airfield: it wants the wide-open country out in the belt
// between the last blocks and the ring highway, so it prefers the clear parcel FARTHEST
// from the middle (hugging the loop) and searches past TOWN to reach it. Every corner of
// the strip must sit a comfortable margin inside the ring, and the whole footprint clears
// roads (the highway included), the river and anything already taken.
function findAirfield(w, d) {
  const hw = w/2, hd = d/2;
  const RINGR = TOWN + 150;                              // the highway ring radius (see HIGHWAY)
  const insideRing = (x, z) => x*x + z*z < (RINGR - 30)*(RINGR - 30);
  const clear = (cx, cz) => {
    // keep the whole strip inside the loop, tested at the four corners
    if (!insideRing(cx-hw, cz-hd) || !insideRing(cx+hw, cz-hd) ||
        !insideRing(cx-hw, cz+hd) || !insideRing(cx+hw, cz+hd)) return false;
    for (const t of TAKEN)
      if (Math.abs(cx - t.x) < (w + t.w)/2 && Math.abs(cz - t.z) < (d + t.d)/2) return false;
    for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) {
      const x = cx + i*hw/4, z = cz + j*hd/4;
      if (onRoad(x, z, 4) || overRiver(x, z, 14) || OCC.has(occKey(x, z))) return false;
    }
    return true;
  };
  let best = null, bestD = -Infinity;
  const LIM = TOWN + 120;
  for (let cx = -LIM; cx <= LIM; cx += 12) for (let cz = -LIM; cz <= LIM; cz += 12) {
    const dd = cx*cx + cz*cz;
    if (dd <= bestD || !clear(cx, cz)) continue;         // prefer the far edge, out by the loop
    bestD = dd; best = { x: cx, z: cz };
  }
  if (best) TAKEN.push({ x: best.x, z: best.z, w, d });
  return best;
}

// =================================================================
//  THE STUNT PARK
//  A green with four kickers in it. The ramps are wedges that raise surfaceY (see
//  RAMPS) rather than colliders, so you drive up and fly off the lip for real, and
//  land on the heightfield like any other drop. Built here, long after the tree
//  stage, so the geometry costs nothing seeded.
// =================================================================
{
  const wedge = (w, len, h) => {                  // back-bottom at the origin, rising along +z
    const A = [-w/2,0,0], B = [w/2,0,0], C = [-w/2,h,len], D = [w/2,h,len],
          E = [-w/2,0,len], F = [w/2,0,len];
    const v = [];
    const tri = (p,q,r) => v.push(...p, ...q, ...r);
    tri(A,B,D); tri(A,D,C);                       // the run
    tri(E,F,D); tri(E,D,C);                       // the lip face
    tri(A,C,E); tri(B,F,D);                       // cheeks
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    g.computeVertexNormals();
    return g;
  };
  // the biggest open green that isn't cut by the river
  const site = findGreen(58, 58);
  if (site) {
    const cx = site.x, cz = site.z;
    const mat = new THREE.MeshToonMaterial({ color: 0xe8792b, gradientMap: RAMP, side: THREE.DoubleSide });
    // steeper than they look sensible: a shallow wedge just lifts the car, a ~22-25°
    // kicker throws it. Length is short relative to height for exactly that reason.
    const specs = [                               // yaw, distance out, width, length, height
      [0,          20, 9, 11, 4.4], [Math.PI,   20, 9, 11, 4.4],
      [Math.PI/2,  20, 8, 12, 5.6], [-Math.PI/2, 20, 8, 10, 3.8],
    ];
    for (const [yaw, off, w, len, h] of specs) {
      const ux = Math.sin(yaw), uz = Math.cos(yaw);
      // start back from centre and aim inward, so every ramp launches over the middle
      const rx = cx - ux*off, rz = cz - uz*off;
      if (onRoad(rx, rz, 3) || onRoad(rx + ux*len, rz + uz*len, 3)) continue;
      const g = wedge(w, len, h);
      const m = new THREE.Mesh(g, mat);
      m.position.set(rx, 0.02, rz); m.rotation.y = yaw;
      m.castShadow = true; m.receiveShadow = true;
      scene.add(m);
      RAMPS.push({ x: rx, z: rz, ux, uz, w, len, h });
    }
    if (RAMPS.length) {
      const t = signTexture('STUNT PARK', '#2f3550', '#ffd23b', 512, 128);
      const brd = signPanel(14, 3.5, t);
      brd.position.set(cx, 6.5, cz - 27); brd.rotation.y = Math.PI; scene.add(brd);
      for (const sx of [-6.4, 6.4]) {
        const p = new THREE.Mesh(BOX(0.7, 6.5, 0.7), toon(0x6b6f76));
        p.position.set(cx + sx, 3.25, cz - 27); scene.add(p);
      }
      if (addJobMarker) addJobMarker(cx - 34, cz - 24,
        'SCRAPPY', 'Fill my yard: send six of their cars flying. Big hits only.', 'rampage');
    }
  }
}

// =================================================================
//  THE FAIR
//  Three attractions on the biggest green the stunt park didn't take. All three
//  are *rides*: walk up, press F, and the camera leaves your shoulder and sits in
//  the seat. The brief asked for a click, but left click is the punch and right
//  click is the kick — F is already the game's one interact key (get in, get out,
//  open a door, work the portcullis) and a ride is exactly that verb again.
//
//  Everything here is built after every audit and every flush, so it is entirely
//  free of the seeded stream: geometry goes straight into meshes rather than the
//  colour buckets, and the only randoms are runtime ones.
// =================================================================
const FAIR = [];
let riding = null, rideExitCd = 0;
{
  const FW = 136, FD = 58;
  const site = findGreen(FW, FD);
  console.log('stunt park ramps:', RAMPS.length);
  if (site) {
    const cx = site.x, cz = site.z;
    // carousel and bumper cars stacked on the west side, the doubled coaster loop
    // taking the whole east two-thirds. The carousel sits further north than it
    // used to — the doubled bumper arena needed the room.
    const at = k => k < 0 ? [cx - 51, cz - 19] : [cx + 22, cz];
    const mesh = (geo, col, x, y, z) => {
      const m = new THREE.Mesh(geo, typeof col === 'number' ? toon(col) : col);
      m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
      scene.add(m); return m;
    };

    // ---- the carousel -------------------------------------------------
    {
      const [mx, mz] = at(-1);
      const base = new THREE.Group(); base.position.set(mx, 0, mz); scene.add(base);
      mesh(new THREE.CylinderGeometry(7.4, 7.8, 0.5, 32), 0xc9ccd2, mx, 0.25, mz);
      const spin = new THREE.Group(); spin.position.set(mx, 0.5, mz); scene.add(spin);
      const deck = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 0.35, 32), toon(0xe8d06a));
      deck.position.y = 0.17; deck.castShadow = deck.receiveShadow = true; spin.add(deck);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 6.2, 16), toon(0xd8dde4));
      pole.position.y = 3.3; spin.add(pole);
      // a canopy in fairground stripes: alternating cone wedges, which is cheaper and
      // reads better than trying to get a radial texture onto a cone's UVs
      for (let k = 0; k < 12; k++) {
        const seg = new THREE.Mesh(
          new THREE.ConeGeometry(8.2, 2.4, 8, 1, true, k*Math.PI/6, Math.PI/6),
          new THREE.MeshToonMaterial({ color: k % 2 ? 0xd0392b : 0xf6f3ea,
                                       gradientMap: RAMP, side: THREE.DoubleSide }));
        seg.position.y = 7.4; spin.add(seg);
      }
      const SEATS = 8;
      const horses = [];
      for (let k = 0; k < SEATS; k++) {
        const a = k*Math.PI*2/SEATS, hx = Math.cos(a)*4.9, hz = Math.sin(a)*4.9;
        const h = new THREE.Group(); h.position.set(hx, 0.35, hz); h.rotation.y = -a;
        const col = [0xf07ab0, 0x8ad14f, 0x3fa9d8, 0xf0b429][k % 4];
        const body = new THREE.Mesh(new THREE.SphereGeometry(0.52, 16, 12).scale(0.7, 0.78, 1.5), toon(col));
        body.position.y = 1.5; h.add(body);
        const neck = new THREE.Mesh(BOX(0.34, 0.9, 0.42), toon(col));
        neck.position.set(0, 2.0, 0.5); neck.rotation.x = -0.4; h.add(neck);
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 14, 10).scale(0.8, 0.8, 1.3), toon(col));
        head.position.set(0, 2.42, 0.78); h.add(head);
        for (const sx of [-1, 1]) for (const sz of [0.5, -0.5]) {
          const leg = new THREE.Mesh(BOX(0.16, 1.1, 0.16), toon(col));
          leg.position.set(sx*0.26, 0.9, sz); h.add(leg);
        }
        const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 3.4, 10), toon(0xd8dde4));
        bar.position.y = 2.6; h.add(bar);
        spin.add(h); horses.push({ g: h, a });
      }
      FAIR.push({ kind: 'carousel', label: 'CAROUSEL', x: mx, z: mz, r: 9.5,
                   spin, horses, t: 0, seat: 0, cx: mx, cz: mz });
      FAIR.carousel = [mx, mz];        // the coaster sites itself across the street from here
      // the deck is solid so you cannot stand inside the machinery
      colliders.push({ minX: mx-7.2, maxX: mx+7.2, minZ: mz-7.2, maxZ: mz+7.2 });
    }

    // ---- the bumper cars ----------------------------------------------
    {
      // Twice the arena it was — 44x32 m — with eight cars, and every cart but
      // yours has a rider in it. The free cart is index 0; boarding always puts
      // you there rather than cycling through occupied seats.
      const [bx, bz] = [cx - 44, cz + 12];
      const HW = 22, HD = 16;
      mesh(BOX(HW*2, 0.16, HD*2), 0x4a4f58, bx, 0.08, bz);            // the steel floor
      // A low wall all the way round with one gap to walk in by. The wall segments are
      // real colliders, which is what keeps the cars — and you — inside.
      const WALLH = 1.1, GAP = 3.4;
      const wall = (wx, wz, w, d) => {
        mesh(BOX(w, WALLH, d), 0xd0392b, bx + wx, WALLH/2 + 0.16, bz + wz);
        colliders.push({ minX: bx+wx-w/2, maxX: bx+wx+w/2, minZ: bz+wz-d/2, maxZ: bz+wz+d/2 });
      };
      wall(0,  HD, HW*2 + 0.6, 0.5);                                   // back
      wall(-HW, 0, 0.5, HD*2);  wall(HW, 0, 0.5, HD*2);                // sides
      const half = (HW*2 + 0.6 - GAP)/2;                               // front, split for the way in
      wall(-(GAP/2 + half/2), -HD, half, 0.5);
      wall( (GAP/2 + half/2), -HD, half, 0.5);
      // a seated passenger, merged into one mesh per colour so seven riders cost
      // ~4 draw calls each instead of a full buildPerson's dozen
      const rider = (g) => {
        const lk = pickLook();
        const mk = (col, geos) => { const m = new THREE.Mesh(merge(geos), toon(col.getHex ? col.getHex() : col));
          m.castShadow = true; g.add(m); return m; };
        mk(lk.pants, [ baked(BOX(0.24, 0.5, 0.24), -0.16, 0.62, 0.22, -1.35),   // thighs, folded
                       baked(BOX(0.24, 0.5, 0.24),  0.16, 0.62, 0.22, -1.35),
                       baked(BOX(0.2, 0.4, 0.2), -0.16, 0.42, 0.48),            // shins down
                       baked(BOX(0.2, 0.4, 0.2),  0.16, 0.42, 0.48) ]);
        mk(lk.shirt, [ baked(BOX(0.62, 0.72, 0.4), 0, 1.02, 0),                 // torso
                       baked(BOX(0.16, 0.5, 0.16), -0.42, 1.08, 0.18, -0.9),    // arms reaching the wheel
                       baked(BOX(0.16, 0.5, 0.16),  0.42, 1.08, 0.18, -0.9) ]);
        mk(lk.skin,  [ baked(new THREE.SphereGeometry(0.26, 14, 10), 0, 1.62, 0),
                       baked(BOX(0.12, 0.12, 0.12), -0.42, 1.3, 0.42),
                       baked(BOX(0.12, 0.12, 0.12),  0.42, 1.3, 0.42) ]);
        mk(lk.hair,  [ baked(BOX(0.4, 0.14, 0.4), 0, 1.84, -0.02) ]);
      };
      const CARS = 8, cars = [];
      for (let k = 0; k < CARS; k++) {
        const g = new THREE.Group();
        const col = [0xd0392b, 0x2f6fc4, 0x8ad14f, 0xf0b429, 0x7b4fa7, 0x59c9a5, 0xe87ab0, 0x3fa9d8][k];
        const shell = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 0.95, 0.75, 16), toon(col));
        shell.position.y = 0.5; shell.castShadow = true; g.add(shell);
        const rim = new THREE.Mesh(new THREE.TorusGeometry(1.08, 0.16, 8, 18).rotateX(Math.PI/2), toon(0x2b2f38));
        rim.position.y = 0.42; g.add(rim);
        const seat = new THREE.Mesh(BOX(0.7, 0.5, 0.22), toon(0x2b2f38));
        seat.position.set(0, 1.1, -0.45); g.add(seat);
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.2, 8), toon(0x8b929a));
        mast.position.set(0, 1.95, -0.6); g.add(mast);
        if (k > 0) rider(g);                          // cart 0 stays free — that one's yours
        scene.add(g);
        const a = k*Math.PI*2/CARS;
        cars.push({ g, x: bx + Math.cos(a)*12, z: bz + Math.sin(a)*9,
                    yaw: a, spd: 3 + Math.random()*2, turn: 0, bump: 0 });
      }
      FAIR.push({ kind: 'bumper', label: 'BUMPER CARS', x: bx, z: bz - HD - 2.5, r: 6,
                   cars, HW, HD, bx, bz, seat: 0, freeSeat: 0, cx: bx, cz: bz });
    }

    // one board on the way in — nudged off the carriageway if the plot edge lands on it
    let sx0 = cx - 20, sz0 = cz - FD/2 + 2;
    if (onRoad(sx0, sz0, 4)) {
      let placed = false;
      for (let dz = 0; dz <= 14 && !placed; dz += 2)
        for (const s2 of [1, -1]) {                    // walk inward off the road
          if (!onRoad(sx0, sz0 + s2*dz, 4)) { sz0 = sz0 + s2*dz; placed = true; break; }
        }
    }
    const brd = signPanel(16, 4, signTexture('MAPLEWOOD FAIR', '#7b4fa7', '#ffd23b', 512, 128));
    brd.position.set(sx0, 7, sz0); brd.rotation.y = Math.PI; scene.add(brd);   // faces the way in
    for (const dxp of [-7.4, 7.4]) {
      const p = new THREE.Mesh(BOX(0.6, 7, 0.6), toon(0x6b6f76));
      p.position.set(sx0 + dxp, 3.5, sz0); scene.add(p);
    }
    if (addJobMarker) addJobMarker(sx0 - 8, sz0 - 8,
      'INSPECTOR PRU', 'Safety inspection day. Ride all three and tell me they hold.', 'fairjob');
    FAIR.at0 = [cx, cz];               // the coaster block logs the ride count once it's in
  }
}

// =================================================================
//  THE MAPLE MOUSE, REBUILT
//  Twice the coaster, on its own ground, with a traditional profile: a flat
//  station run, a slow chain lift all the way up, then gravity owns it — the
//  big drop, a slalom of twists, a full circle that passes under its own way
//  in, two more hills, and a braked run back into the station.
//
//  The track is an authored closed CatmullRom rather than an analytic ellipse,
//  and the SITE is chosen by validating the track's own plan path rather than
//  clearing a whole rectangle: the loop's interior may keep its trees — the
//  track flies over — but every low stretch (under 14 m) must be clear of
//  roads, water, buildings and colliders. That is what actually gets it off
//  the carriageway the old reserved-rectangle siting let it clip.
// =================================================================
{
  const B = 2.6, TOP = 40;
  const CTRL = [
    [-22, B, -40], [2, B, -40], [26, B, -40],          // the flat station run (board here)
    [48, B + 8, -33], [60, B + 22, -14],               // the chain lift, slow and steady
    [66, TOP - 5, 6], [58, TOP, 26],                   // ... up to a tall crest, pulled over the top
    [50, TOP - 8, 36],                                 // the lip
    [43, 6, 41],                                       // THE DROP — a steep near-vertical plunge
    [33, 21, 36],                                      // straight into a big airtime hill
    [22, 5, 30],                                       // valley floor
    [10, 18, 40], [-3, 6, 31], [-15, 17, 41],          // a run of camelbacks and S-bends
    [-30, 8, 40],
    [-47, 12, 36], [-60, 9, 22], [-56, 7, 7],          // into the circle, coming in high
    [-43, 6, 4], [-31, 6.5, 16], [-35, 6, 31],         // round and round, closing under the way in
    [-49, 7, 40],                                      // breaking out along the top
    [-62, 14, 24], [-60, 19, 4], [-47, 5, -10],        // up and over a hill
    [-54, 16, -24], [-40, 5, -33],                     // one more hill
    [-30, B, -40],                                     // brake run, flatten home
  ];
  // The known-good layout: a flowing sequence of hills, camelbacks and a circle that closes
  // under its own way in — smooth, logically continuous, and the cross-ties space evenly on
  // it. Bigger than the original with a taller lift and a steeper drop, scaled so the whole
  // loop still validates on the fair's green beside the carousel. Uniform scale about the
  // station height keeps every slope identical, just larger.
  const S = 0.56;
  const curve = new THREE.CatmullRomCurve3(
    CTRL.map(c => new THREE.Vector3(c[0]*S, B + (c[1]-B)*S, c[2]*S)), true);
  const SAMPLES = curve.getSpacedPoints(260);
  // site: candidates spiral out from the CAROUSEL — the user wants the coaster right
  // across the street from it, not off on its own ground.
  const fairAt = FAIR.carousel || FAIR.at0 || [0, 0];
  const plot = FAIR.at0 || fairAt;              // the fair plot centre (its own reservation)
  const pathOK = (sx, sz) => {
    for (const p of SAMPLES) {
      const px = sx + p.x, pz = sz + p.z;
      if (onRoad(px, pz, 5) || overRiver(px, pz, 10)) return false;
      if (p.y < 14) {
        if (OCC.has(occKey(px, pz)) || pointBlocked(px, pz, 2.5)) return false;
        for (const tk of TAKEN) {
          // the fair's own plot reservation is where we WANT the coaster — skip it
          if (Math.hypot(tk.x - plot[0], tk.z - plot[1]) < 6) continue;
          if (Math.abs(px - tk.x) < tk.w/2 + 3 && Math.abs(pz - tk.z) < tk.d/2 + 3) return false;
        }
      }
    }
    return true;
  };
  // Scan the fair plot interior on a fine grid and take the clear spot nearest the
  // carousel. A polar spiral's angular steps skip the narrow valid window (the plot has
  // a road clipping one edge that findGreen's coarse grid missed), so a direct scan is
  // what actually finds the room that is there.
  let site = null, bestD = Infinity;
  for (let sx = plot[0] - 58; sx <= plot[0] + 58; sx += 4)
    for (let sz = plot[1] - 22; sz <= plot[1] + 22; sz += 4) {
      const d = (sx - fairAt[0])**2 + (sz - fairAt[1])**2;
      if (d >= bestD) continue;
      if (pathOK(sx, sz)) { bestD = d; site = { x: sx, z: sz }; }
    }
  if (!site) {                                      // fallback: spiral out across town
    outer:
    for (let r = 12; r <= 360; r += 12) {
      const steps = Math.max(16, Math.round(r));
      for (let k = 0; k < steps; k++) {
        const a = k/steps*Math.PI*2;
        const sx = fairAt[0] + Math.cos(a)*r, sz = fairAt[1] + Math.sin(a)*r;
        if (Math.abs(sx) > TOWN - 80 || Math.abs(sz) > TOWN - 80) continue;
        if (pathOK(sx, sz)) { site = { x: sx, z: sz }; break outer; }
      }
    }
  }
  if (site) {
    const cx = site.x, cz = site.z;
    TAKEN.push({ x: cx, z: cz, w: 140*S, d: 100*S });
    const mesh2 = (geo, col, x, y, z) => {
      const m = new THREE.Mesh(geo, toon(col));
      m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
      scene.add(m); return m;
    };
    const world = u => { const p = curve.getPointAt(((u % 1) + 1) % 1); return [cx + p.x, p.y, cz + p.z]; };
    const LEN = curve.getLength();
    const uNear = (lx, lz) => {                        // arc param of the sample nearest a plan point
      let bi = 0, bd = Infinity;
      SAMPLES.forEach((p, i) => { const d = (p.x - lx)**2 + (p.z - lz)**2; if (d < bd) { bd = d; bi = i; } });
      return bi / (SAMPLES.length - 1);
    };
    let crestU = 0, crestY = 0;
    SAMPLES.forEach((p, i) => { if (p.y > crestY) { crestY = p.y; crestU = i / (SAMPLES.length - 1); } });
    const stopU = uNear(2*S, -40*S), brakeU = uNear(-40*S, -34*S);
    // rails: two offset tubes, ties, posts down to the ground
    const up = new THREE.Vector3(0, 1, 0);
    const railCurve = (sgn) => {
      const pts = [];
      for (let i = 0; i < 220; i++) {
        const t = i / 220;
        const p = curve.getPointAt(t), q = curve.getPointAt((t + 0.002) % 1);
        const dir = q.clone().sub(p).normalize();
        const side = new THREE.Vector3().crossVectors(dir, up).normalize();
        pts.push(new THREE.Vector3(cx + p.x + side.x*sgn*0.52, p.y + 0.16, cz + p.z + side.z*sgn*0.52));
      }
      return new THREE.CatmullRomCurve3(pts, true);
    };
    for (const sgn of [-1, 1])
      mesh2(new THREE.TubeGeometry(railCurve(sgn), 640, 0.09, 10, true), 0xd0392b, 0, 0, 0);
    const ties = [], posts = [];
    const NT = Math.round(LEN / 3);
    for (let i = 0; i < NT; i++) {
      const t = i / NT;
      const p = curve.getPointAt(t), q = curve.getPointAt((t + 0.002) % 1);
      const dir = q.clone().sub(p).normalize();
      const yaw = Math.atan2(dir.x, dir.z), pitch = -Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
      ties.push(baked(BOX(1.5, 0.09, 0.28), cx + p.x, p.y + 0.05, cz + p.z, pitch, yaw, 0));
      if (i % 4 === 0 && p.y > 1.2)
        posts.push(baked(BOX(0.34, p.y, 0.34), cx + p.x, p.y/2, cz + p.z));
    }
    mesh2(merge(ties), 0x8c6a44, 0, 0, 0);
    mesh2(merge(posts), 0x6b6f76, 0, 0, 0);
    const cart = new THREE.Group();
    const cb = new THREE.Mesh(BOX(1.3, 0.7, 2.0), toon(0xf0b429));
    cb.position.y = 0.55; cb.castShadow = true; cart.add(cb);
    const cn = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.9, 12), toon(0xd0392b));
    cn.position.set(0, 0.55, 1.4); cn.rotation.x = Math.PI/2; cart.add(cn);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.14, 12).rotateZ(Math.PI/2), toon(0x2b2f38));
      w.position.set(sx*0.6, 0.22, sz*0.7); cart.add(w);
    }
    scene.add(cart);
    // the station: platform beside the flat run, stairs up, all walking surface. The flat
    // run is the local z=-40 straight (centre x=2); the platform sits just outside it.
    const stx = cx + 2*S, stz = cz - 40*S - 2.6, deckH = B - 0.3, deckTop = deckH + 0.22;
    mesh2(BOX(9.5, deckH, 5.4), 0x8c6a44, stx, deckH/2, stz);
    mesh2(BOX(9.9, 0.22, 5.8), 0xa8845c, stx, deckH + 0.11, stz);
    for (const sxp of [-4, 4]) mesh2(BOX(0.3, 3.4, 0.3), 0x6b6f76, stx + sxp, deckH + 1.7, stz);
    mesh2(BOX(10.6, 0.26, 6.4), 0xd0392b, stx, deckH + 3.5, stz);
    DECKS.push({ x0: stx - 4.75, x1: stx + 4.75, z0: stz - 2.7, z1: stz + 2.7, h: deckTop });
    {
      const sz0 = stz - 2.7, sx0 = stx - 8.4, sx1 = stx - 4.75;   // stairs off the west end
      const z0 = stz - 1.2, z1 = stz + 1.2, STEPS = 6;
      // Each step's height must match the walkable ramp (rise 'x+', low at sx0, full at
      // the platform edge sx1): the tallest step sits AGAINST the platform, the shortest
      // at the ground. Previously the visual steps ran the other way — a wall at the
      // bottom and a lip you stepped down onto the deck — so they never lined up for entry.
      for (let k = 0; k < STEPS; k++) {
        const h = deckTop * (k + 1) / STEPS;                       // rises toward the platform
        const x = sx0 + (k + 0.5) * (sx1 - sx0) / STEPS;           // k=0 at the ground, last at the deck
        mesh2(BOX((sx1 - sx0)/STEPS, h, z1 - z0), 0x8c6a44, x, h/2, (z0 + z1)/2);
      }
      DECKS.push({ x0: sx0, x1: sx1, z0, z1, h: deckTop, rise: 'x+' });
      for (const rz of [z0 + 0.1, z1 - 0.1]) {
        const rail = new THREE.Mesh(BOX(Math.hypot(sx1 - sx0, deckTop) + 0.4, 0.08, 0.08), toon(0xf6f3ea));
        rail.position.set((sx0 + sx1)/2, deckTop/2 + 0.95, rz);
        rail.rotation.z = -Math.atan2(deckTop, sx1 - sx0);
        scene.add(rail);
      }
    }
    const sign = signPanel(12, 3, signTexture('THE MAPLE MOUSE', '#2f3550', '#ffd23b', 512, 128));
    sign.position.set(stx, 7, stz - 3.6); sign.rotation.y = Math.PI; scene.add(sign);   // faces the way in
    FAIR.push({ kind: 'coaster', label: 'MAPLE MOUSE', x: stx, z: stz, r: 8,
                P: world, cart, t: stopU, wait: 10, phase: 'lift', wrapped: false,
                stopU, crestU, brakeU, topY: crestY, len: LEN, cx, cz });
    console.log(`fair: ${FAIR.length} rides at ${FAIR.at0 ? FAIR.at0[0]|0 : 0},${FAIR.at0 ? FAIR.at0[1]|0 : 0} · coaster at ${cx|0},${cz|0} (${LEN|0} m of track)`);
  } else {
    console.warn('coaster: no clear site found');
    console.log(`fair: ${FAIR.length} rides`);
  }
}

// =================================================================
//  THE TIRE-FIRE CLIMB
//  The eternal tire fire is now a vertical platforming puzzle: a spiral of
//  tyre-stack platforms winding up out of a burning core, with flame jets to
//  dodge and a trophy at the summit. Built here, after every audit and flush, so
//  it is entirely free of the seeded stream — the pads, columns, flames and
//  trophy are plain runtime objects.
//
//  The platforms are PADS, not colliders: each is a flat disc top the altitude
//  code lifts you onto, so the ordinary on-foot jump does all the work. Miss one
//  and you fall to the lot floor and climb again. Footprints never overlap, which
//  is what keeps surfaceY single-valued.
// =================================================================
const flames = [];
let summitTrophy = null;
if (TIREFIRE) {
  const { cx, cz } = TIREFIRE;
  // open the lot: the 30x30 fire box kept you out. Swapped for nothing here (post-audit,
  // post-tree, like the prison gate) so trees never grew inside and the audit stays clean.
  const fi = colliders.indexOf(TIREFIRE.col); if (fi >= 0) colliders.splice(fi, 1);

  // the climbing route — a spiral that tightens and rises. Radius shrinks monotonically
  // so the helix never returns to the same (x,z); the angle step is small enough that
  // consecutive pads are a running-jump apart, not a chasm.
  const N = 13, PR = 1.7;
  const tori = [], caps = [];
  const torus = new THREE.TorusGeometry(1.3, 0.5, 6, 12);
  for (let i = 0; i < N; i++) {
    const th = i * 0.5, R = 7.6 - i * 0.34;
    const px = cx + Math.cos(th) * R, pz = cz + Math.sin(th) * R;
    const h = 1.2 + i * 1.05;
    PADS.push({ x: px, z: pz, r: PR, h });
    // the column is a real solid: sides you cannot pass, top you land on. Radius 0.9 so
    // the push-out (0.9 + 0.75 player = 1.65) stays comfortably inside the pad top you're
    // aiming for (PR = 1.7) — no thin dead ring where you're held off the column but not
    // yet on the pad — and well under the ~1.85 m gap to the next pad, so neighbours never
    // eject you off the tier you stand on.
    TIRECOLS.push({ x: px, z: pz, r: 0.9, top: h });
    // the tyre column beneath it, and a worn cap you stand on
    for (let y = 0.5; y < h - 0.2; y += 0.85)
      tori.push(baked(torus, px, y, pz, Math.PI/2, 0, (i*13 + y*7) % 3));
    caps.push(baked(new THREE.CylinderGeometry(PR, PR*0.92, 0.28, 16), px, h - 0.14, pz));
  }
  scene.add(new THREE.Mesh(merge(tori), toon(0x23252c)));
  scene.add(new THREE.Mesh(merge(caps), toon(0x33353d)));

  // The burning heart: the spiral winds *around* it (pads stay >3 m out) and it only
  // reaches h 9, so the upper pads and the summit clear it — it is the centrepiece you
  // climb past, roaring smoke, not a wall. Flames are always on: pure spatial avoidance,
  // no timing. Touch one and it flings you off to tumble down and climb again.
  const padAt = i => { const th = i*0.5, R = 7.6 - i*0.34;
    return { x: cx + Math.cos(th)*R, z: cz + Math.sin(th)*R, h: 1.2 + i*1.05 }; };
  flames.push({ x: cx, z: cz, y0: 0, h: 9, r: 3.0, big: true });
  // jets in the gaps between certain pads, nudged outward — a jump that goes wide hits
  // one, so you learn to hop tight along the inner line. Each still leaves the pad
  // itself a safe place to stand and aim.
  for (const i of [1, 4, 6, 9]) {
    const a = padAt(i), b = padAt(i + 1);
    const mx = (a.x + b.x)/2, mz = (a.z + b.z)/2;
    const outx = mx - cx, outz = mz - cz, ol = Math.hypot(outx, outz) || 1;
    flames.push({ x: mx + outx/ol*1.5, z: mz + outz/ol*1.5,
                  y0: Math.min(a.h, b.h) - 0.4, h: 2.6, r: 1.35 });
  }
  for (const f of flames) fireSpots.push({ x: f.x, y: f.y0 + (f.big ? 5 : 1.5), z: f.z });

  // the summit: a wider platform over the top pad, and a trophy on it
  const top = PADS[N - 1];
  scene.add(new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.4, 0.4, 20).translate(top.x, top.h - 0.2, top.z), toon(0x3a3d47)));
  PADS[N - 1] = { x: top.x, z: top.z, r: 2.6, h: top.h };
  const tg = merge([
    baked(new THREE.CylinderGeometry(0.5, 0.56, 0.16, 16), 0, 0.08, 0),
    baked(new THREE.CylinderGeometry(0.12, 0.12, 0.4, 16), 0, 0.34, 0),
    baked(new THREE.SphereGeometry(0.42, 16, 12).scale(1, 0.9, 1), 0, 0.9, 0),
    baked(new THREE.TorusGeometry(0.4, 0.07, 8, 14).rotateY(Math.PI/2), -0.5, 0.86, 0),
    baked(new THREE.TorusGeometry(0.4, 0.07, 8, 14).rotateY(Math.PI/2),  0.5, 0.86, 0),
  ]);
  const trophyM = new THREE.Mesh(tg, new THREE.MeshToonMaterial({ color: 0xffd23b, gradientMap: RAMP }));
  trophyM.position.set(top.x, top.h + 0.1, top.z); scene.add(trophyM);
  summitTrophy = { g: trophyM, x: top.x, z: top.z, y: top.h, got: false, spin: 0 };

  const t = signTexture('TIRE FIRE CLIMB', '#2b2f38', '#ff7a2b', 512, 128);
  const brd = signPanel(14, 3.5, t);
  brd.position.set(cx, 5.5, TIREFIRE.z0 + 3); brd.rotation.y = Math.PI; scene.add(brd);
  for (const sx of [-6.4, 6.4]) {
    const p = new THREE.Mesh(BOX(0.7, 5.5, 0.7), toon(0x6b6f76));
    p.position.set(cx + sx, 2.75, TIREFIRE.z0 + 3); scene.add(p);
  }
  console.log(`tire climb: ${PADS.length} pads, summit at h ${top.h.toFixed(1)}`);

  // Every heaped tyre in the yard is climbable too — not just the spiral. Each gets a
  // generous pad on its top face so you stand on it instead of clipping in. Pads ONLY,
  // no side columns: the heap is packed tight and overlapping, and a forest of column
  // push-outs would shove you sideways off one tyre into the gap beside the next. With
  // pads alone, padY simply lifts you onto the highest tyre within a step of your feet,
  // and the big 1.9 m radius means the footprints overlap enough that there's always a
  // pad underfoot — you can never be ejected into a hole and fall through the pile.
  let heapTyres = 0;
  if (TIREFIRE.heap) for (const t of TIREFIRE.heap) {
    PADS.push({ x: t.x, z: t.z, r: 1.9, h: t.top });
    heapTyres++;
  }
  console.log(`tire heap: ${heapTyres} climbable tyres`);
}
// A flame throws you off if you touch its column. Non-lethal — you tumble down and
// climb again — because instant death on a platformer is just rage.
function updateTireClimb(dt) {
  if (summitTrophy && !summitTrophy.got) {
    summitTrophy.spin += dt * 1.6;
    summitTrophy.g.rotation.y = summitTrophy.spin;
    summitTrophy.g.position.y = summitTrophy.y + 0.1 + Math.sin(summitTrophy.spin) * 0.08;
    if (mode === 'foot' && !playerRag.active) {
      const dx = summitTrophy.x - player.position.x, dz = summitTrophy.z - player.position.z;
      if (dx*dx + dz*dz < 6 && Math.abs(player.position.y - summitTrophy.y) < 2.5) {
        summitTrophy.got = true; summitTrophy.g.visible = false;
        addCoins(300); coinSfx();
        burst(summitTrophy.x, summitTrophy.y + 1, summitTrophy.z, 0xffd23b, 22);
        banner('KING OF THE HILL', '+300 coins · you conquered the tyre fire');
      }
    }
  }
  if (mode !== 'foot' || playerRag.active || playerIFrames > 0) return;
  for (const f of flames) {
    const dx = player.position.x - f.x, dz = player.position.z - f.z;
    if (dx*dx + dz*dz > f.r*f.r) continue;
    if (player.position.y < f.y0 - 0.6 || player.position.y > f.y0 + f.h) continue;
    // fling: outward from the flame, and up, so you clear the pad and drop
    const d = Math.hypot(dx, dz) || 1;
    applyRagdoll(player, playerRag, dx/d, dz/d, 11);
    shake = Math.min(1.4, shake + 0.4);
    burst(player.position.x, player.position.y + 0.5, player.position.z, 0xff7a2b, 10);
    toast('OW! HOT!');
    return;
  }
}

// =================================================================
//  THE FARM PEN
//  Feather Frenzy's new home. The flock used to live in the Retirement Castle's
//  great hall, which meant kicking chickens while being shoved off interior
//  walls; a pen on open ground has a low rail fence, a wide gate, and room to
//  swing a boot. The castle keeps its gate and stands empty.
// =================================================================
const PEN = { inner: null, walls: [] };
{
  const site = findGreen(42, 34);
  if (site) {
    const cx = site.x, cz = site.z, W = 36, D = 28, GATE = 6;
    PEN.inner = { x0: cx - W/2, x1: cx + W/2, z0: cz - D/2, z1: cz + D/2, cx, cz };
    // white rail fence in short chunks — posts plus two rails, gate gap mid-south.
    // Chunks are colliders (for the player and the flock both), pen is axis-aligned
    // so the AABBs are exact.
    const parts = [];
    const post = (x, z) => parts.push(baked(BOX(0.18, 1.0, 0.18), x, 0.5, z));
    const rail = (x, z, w, d) => {
      for (const h of [0.42, 0.86]) parts.push(baked(BOX(w || 0.1, 0.09, d || 0.1), x, h, z));
      const b = { minX: x - (w || 0.1)/2, maxX: x + (w || 0.1)/2,
                  minZ: z - (d || 0.1)/2, maxZ: z + (d || 0.1)/2 };
      colliders.push(b); PEN.walls.push(b);
    };
    for (let x = -W/2; x <= W/2; x += 3.6) { post(cx + x, cz - D/2); post(cx + x, cz + D/2); }
    for (let z = -D/2; z <= D/2; z += 3.5) { post(cx - W/2, cz + z); post(cx + W/2, cz + z); }
    for (let x = -W/2 + 1.8; x <= W/2 - 1.8; x += 3.6) {
      if (Math.abs(x) < GATE/2 + 1.2) { rail(cx + x, cz + D/2, 3.6, 0.12); continue; } // gate side stays open
      rail(cx + x, cz - D/2, 3.6, 0.12); rail(cx + x, cz + D/2, 3.6, 0.12);
    }
    for (let z = -D/2 + 1.75; z <= D/2 - 1.75; z += 3.5) {
      rail(cx - W/2, cz + z, 0.12, 3.5); rail(cx + W/2, cz + z, 0.12, 3.5);
    }
    const fence = new THREE.Mesh(merge(parts), toon(0xf6f3ea));
    fence.castShadow = true; scene.add(fence);
    // a little red barn in the north-east corner, solid
    {
      const bxp = cx + W/2 - 5.4, bzp = cz + D/2 - 4.6, BW = 7, BD = 5.4, BH = 3.4;
      const body = new THREE.Mesh(BOX(BW, BH, BD), toon(0xb03a2e));
      body.position.set(bxp, BH/2, bzp); body.castShadow = true; scene.add(body);
      // a 4-sided cone rotated 45° is an axis-aligned pyramid; stretch it to the plan
      const roof = new THREE.Mesh(
        new THREE.ConeGeometry(BD * 0.75, 2.2, 4).rotateY(Math.PI/4).scale(BW / (BD * 1.06), 1, 1),
        toon(0x6a4a2f));
      roof.position.set(bxp, BH + 1.1, bzp); roof.castShadow = true; scene.add(roof);
      const doorm = new THREE.Mesh(BOX(2.2, 2.6, 0.15), toon(0x5a3d1e));
      doorm.position.set(bxp, 1.3, bzp - BD/2 - 0.05); scene.add(doorm);
      const b = { minX: bxp - BW/2, maxX: bxp + BW/2, minZ: bzp - BD/2, maxZ: bzp + BD/2 };
      colliders.push(b); PEN.walls.push(b);
    }
    // hay bales, visual only
    for (const [hx, hz] of [[cx - W/2 + 4, cz + D/2 - 3.4], [cx - W/2 + 6.6, cz + D/2 - 4.2]]) {
      const bale = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.0, 1.7, 14).rotateZ(Math.PI/2), toon(0xd8b44a));
      bale.position.set(hx, 1.0, hz); bale.castShadow = true; scene.add(bale);
    }
    // the sign over the gate, facing the way in (+z)
    const brd = signPanel(9, 2.3, signTexture('MAPLE FARM', '#6a4a2f', '#ffd23b', 512, 128));
    brd.position.set(cx, 4.6, cz + D/2 + 0.4); scene.add(brd);
    for (const sx of [-4.2, 4.2]) {
      const p = new THREE.Mesh(BOX(0.5, 4.6, 0.5), toon(0x6b6f76));
      p.position.set(cx + sx, 2.3, cz + D/2 + 0.4); scene.add(p);
    }
    // The gate itself — a swing section across the south gap, on Nurse Mabel's side.
    // Closed until Feather Frenzy is accepted (so the flock can't wander out and you
    // can't wander in early); the mission opens it and shuts it again on the way out.
    {
      // two rails plus end posts spanning the gap
      const gm = [];
      gm.push(baked(BOX(0.18, 1.0, 0.18), -GATE/2 + 0.09, 0.5, 0));
      gm.push(baked(BOX(0.18, 1.0, 0.18),  GATE/2 - 0.09, 0.5, 0));
      for (const h of [0.42, 0.86]) gm.push(baked(BOX(GATE, 0.1, 0.1), 0, h, 0));
      const gate = new THREE.Mesh(merge(gm), toon(0xf6f3ea));
      gate.position.set(cx, 0, cz + D/2); gate.castShadow = true; scene.add(gate);
      const block = { minX: cx - GATE/2, maxX: cx + GATE/2, minZ: cz + D/2 - 0.2, maxZ: cz + D/2 + 0.2 };
      colliders.push(block); PEN.walls.push(block);
      PEN.gate = { mesh: gate, block, closed: true, cz: cz + D/2 };
    }
    if (addJobMarker) addJobMarker(cx, cz + D/2 + 9,
      'NURSE MABEL', "The flock's gone feral down at the farm. Boot me seven of them!", 'feather');
    console.log(`farm pen at ${cx|0},${cz|0}`);
  }
}
// open/close the pen gate: hide the swing section and park its collider far away
function setPenGate(open) {
  const g = PEN.gate; if (!g) return;
  g.closed = !open;
  g.mesh.visible = !open;
  if (open) { g.block.minX = g.block.maxX = g.block.minZ = g.block.maxZ = 1e9; }
  else {
    g.block.minX = PEN.inner.cx - 3; g.block.maxX = PEN.inner.cx + 3;
    g.block.minZ = g.cz - 0.2; g.block.maxZ = g.cz + 0.2;
  }
}

// =================================================================
//  MAPLEWOOD REGIONAL AIRPORT  +  FLYING
//  An open-ground airfield sited by findGreen (so it lands on the biggest clear
//  parcel out past the blocks but well inside the ring road), with a real runway
//  you take off from in a cartoon prop plane. Built here, long after every audit,
//  tree pass and flush, so it is free of the seeded stream: plain runtime meshes,
//  colliders pushed straight in, no prng() draws. Runway and apron are flat tarmac
//  (never colliders — you taxi on them like any flat ground); only the terminal,
//  tower and hangar are solid. Flight itself is the car's airborne block made
//  permanent and pilot-controlled — throttle, pitch, bank-to-turn, lift above a
//  takeoff speed, gravity when you stall.
// =================================================================
const RAMP_GLASS = new THREE.MeshToonMaterial({ color: 0x243049, gradientMap: RAMP });
let planeSpeed = 0, planePitch = 0, planeRoll = 0, planeHeading = 0;
const PLANE_SPAWN = { x: 0, z: 0, heading: 0 };
const plane = new THREE.Group(); plane.rotation.order = 'YXZ'; plane.visible = false; scene.add(plane);
let planeShadow = null;
// flight tuning
const PLANE_MAX = 58, PLANE_ACCEL = 20, PLANE_DECEL = 24, PLANE_DRAG = 5, PLANE_BRAKE = 40,
      PLANE_TAKEOFF = 24, PITCH_RATE = 1.0, PITCH_MAX = 0.55, ROLL_MAX = 0.8, ROLL_RATE = 1.9,
      YAW_RATE = 0.75, GROUND_STEER = 1.5, STALL_FALL = 15, CRASH_VY = 18;

function buildPlane() {
  const g = new THREE.Group();
  const body = toon(0xe8532f), white = toon(0xf2efe7), dark = toon(0x2b2f38);
  // fuselage + tail boom, one merged shell
  const shell = new THREE.Mesh(merge([ baked(BOX(1.5, 1.4, 6.2), 0, 1.3, 0),
                                       baked(BOX(0.95, 0.95, 2.4), 0, 1.55, -3.7) ]), body);
  shell.castShadow = true; g.add(shell);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.75, 1.2, 16).rotateX(Math.PI/2), body);
  nose.position.set(0, 1.3, 3.5); nose.castShadow = true; g.add(nose);
  const wing = new THREE.Mesh(BOX(10, 0.28, 1.9), white); wing.position.set(0, 1.02, 0.4); wing.castShadow = true; g.add(wing);
  const tail = new THREE.Mesh(BOX(3.8, 0.24, 1.1), white); tail.position.set(0, 1.85, -4.3); g.add(tail);
  const fin  = new THREE.Mesh(BOX(0.26, 1.6, 1.5), white); fin.position.set(0, 2.55, -4.3); g.add(fin);
  const cock = new THREE.Mesh(BOX(1.15, 0.85, 1.7), RAMP_GLASS); cock.position.set(0, 2.02, 0.9); g.add(cock);
  for (const wx of [-2.7, 2.7]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.3, 12).rotateZ(Math.PI/2), dark);
    w.position.set(wx, 0.4, 0.6); g.add(w);
  }
  const tw = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.24, 10).rotateZ(Math.PI/2), dark);
  tw.position.set(0, 0.3, -3.5); g.add(tw);
  const prop = new THREE.Group();
  prop.add(new THREE.Mesh(BOX(0.18, 3.1, 0.12), dark));
  prop.add(new THREE.Mesh(BOX(3.1, 0.18, 0.12), dark));
  prop.position.set(0, 1.3, 4.15); g.add(prop);
  g.userData.prop = prop;
  return g;
}

// Sited out in the open country of the green belt, hard by the ring highway, on a
// parcel big enough for a proper long runway (findAirfield prefers the far edge).
const AIRPORT = findAirfield(504, 90);
if (AIRPORT) {
  const ax = AIRPORT.x, az = AIRPORT.z;
  const RWL = 464, RWW = 20;                    // four times the old strip — a real runway
  // `inward` points from the runway toward the middle of town: the apron, terminal,
  // tower and hangar all sit on that side, so nothing spills out across the ring road.
  const inward = az >= 0 ? -1 : 1;
  // runway tarmac + markings (flat, not colliders — you taxi and take off on it)
  const rw = new THREE.Mesh(BOX(RWL, 0.12, RWW), toon(0x33353d)); rw.position.set(ax, 0.06, az); scene.add(rw);
  for (let x = -RWL/2 + 10; x <= RWL/2 - 10; x += 12) {
    const d = new THREE.Mesh(BOX(5, 0.02, 0.6), toon(0xf0ede6)); d.position.set(ax + x, 0.14, az); scene.add(d);
  }
  for (const end of [-1, 1]) for (let k = -3; k <= 3; k++) {
    const s = new THREE.Mesh(BOX(3.5, 0.02, 1.2), toon(0xf0ede6));
    s.position.set(ax + end*(RWL/2 - 5), 0.14, az + k*2.4); scene.add(s);
  }
  // apron on the town-facing side, near one end of the long runway
  const apZ = az + inward*(RWW/2 + 16), apx = ax - RWL/2 + 60;
  const ap = new THREE.Mesh(BOX(48, 0.12, 26), toon(0x3a3d47)); ap.position.set(apx, 0.06, apZ); scene.add(ap);
  // taxiway linking apron to runway
  const tx = new THREE.Mesh(BOX(8, 0.12, 20), toon(0x3a3d47)); tx.position.set(apx, 0.05, az + inward*(RWW/2 + 3)); scene.add(tx);

  const solid = (cx, cz, w, d) => colliders.push({ minX: cx - w/2, maxX: cx + w/2, minZ: cz - d/2, maxZ: cz + d/2 });
  // terminal (further from the runway than the apron, i.e. another step inward)
  {
    const tz = apZ + inward*10;
    const m = new THREE.Mesh(merge([ baked(BOX(26, 7, 12), 0, 3.5, 0), baked(BOX(28, 1, 14), 0, 7.3, 0) ]), toon(0xcdd6de));
    m.castShadow = true; m.position.set(apx, 0, tz); scene.add(m);
    const glz = new THREE.Mesh(BOX(24, 3, 0.3), RAMP_GLASS); glz.position.set(apx, 3, tz - inward*6.1); scene.add(glz);
    solid(apx, tz, 26, 12);
  }
  // control tower
  {
    const twx = apx + 22, twz = apZ + inward*9;
    const shaft = new THREE.Mesh(BOX(4.4, 15, 4.4), toon(0xb9c2cb)); shaft.castShadow = true; shaft.position.set(twx, 7.5, twz); scene.add(shaft);
    const cab = new THREE.Mesh(BOX(6.4, 3.4, 6.4), RAMP_GLASS); cab.position.set(twx, 16.5, twz); scene.add(cab);
    const cap = new THREE.Mesh(BOX(7, 0.6, 7), toon(0x2b2f38)); cap.position.set(twx, 18.4, twz); scene.add(cap);
    solid(twx, twz, 4.4, 4.4);
  }
  // hangar — a rounded shed, open toward the apron
  {
    const hx = apx - 22, hz = apZ + inward*9;
    const walls = new THREE.Mesh(merge([ baked(BOX(1, 9, 18), -10, 4.5, 0), baked(BOX(1, 9, 18), 10, 4.5, 0),
                                         baked(BOX(21, 1, 18), 0, 9, 0) ]), toon(0x9aa6b0));
    walls.castShadow = true; walls.position.set(hx, 0, hz); scene.add(walls);
    const roof = new THREE.Mesh(new THREE.CylinderGeometry(10.5, 10.5, 18, 20, 1, false, 0, Math.PI).rotateZ(-Math.PI/2), toon(0x7d8892));
    roof.rotation.y = Math.PI/2; roof.position.set(hx, 9, hz); scene.add(roof);
    solid(hx - 10, hz, 2, 18); solid(hx + 10, hz, 2, 18); solid(hx, hz + inward*9, 21, 2);
  }
  // windsock, out at the far runway end on the open side
  {
    const wsx = ax + RWL/2 - 14, wsz = az - inward*(RWW/2 + 5);
    const pole = new THREE.Mesh(BOX(0.3, 6, 0.3), toon(0xd7dbe0)); pole.position.set(wsx, 3, wsz); scene.add(pole);
    const sock = new THREE.Mesh(new THREE.ConeGeometry(0.7, 2.4, 12).rotateZ(-Math.PI/2), toon(0xff7a2b));
    sock.position.set(wsx + 1.6, 5.6, wsz); scene.add(sock);
  }
  // entrance billboard, on the town side so you spot it driving out from the blocks
  {
    const t = signTexture('MAPLEWOOD REGIONAL', '#20242c', '#63b8ec', 512, 96);
    const bz = apZ + inward*16;
    const brd = signPanel(20, 3.75, t);
    brd.position.set(apx, 6.5, bz); brd.rotation.y = inward < 0 ? Math.PI : 0; scene.add(brd);   // face the town side
    for (const sx of [-9, 9]) { const p = new THREE.Mesh(BOX(0.6, 6.5, 0.6), toon(0x6b6f76)); p.position.set(apx + sx, 3.25, bz); scene.add(p); }
  }

  // park the plane at the taxiway mouth, nose pointed at the runway: throttle up and it
  // rolls forward onto the strip like a car, then you swing onto the centreline to take off
  const pRig = buildPlane(); plane.add(pRig);
  PLANE_SPAWN.x = apx; PLANE_SPAWN.z = az + inward*(RWW/2 + 9);
  PLANE_SPAWN.heading = inward < 0 ? 0 : Math.PI;         // face the runway
  plane.position.set(PLANE_SPAWN.x, 0, PLANE_SPAWN.z);
  planeHeading = PLANE_SPAWN.heading; plane.rotation.set(0, planeHeading, 0);
  plane.visible = true;
  planeShadow = blobShadow(9);

  // (The sky-ring BARNSTORMER course is removed for now — the plane is free-flight only.
  //  Walk up and press F to fly.)
  console.log(`airport at ${ax|0},${az|0} · runway ${RWL}m · free-flight`);
} else {
  plane.position.set(1e6, 0, 1e6);   // no room found — keep it off-world, unboardable
  console.log('airport: no clear parcel found');
}

function nearPlane() {
  return mode === 'foot' && !playerRag.active && AIRPORT &&
    (plane.position.x - player.position.x)**2 + (plane.position.z - player.position.z)**2 < 49;
}
function planeHome() {
  if (!AIRPORT) return;
  plane.position.set(PLANE_SPAWN.x, surfaceY(PLANE_SPAWN.x, PLANE_SPAWN.z), PLANE_SPAWN.z);
  planeHeading = PLANE_SPAWN.heading; planeSpeed = 0; planePitch = 0; planeRoll = 0;
  plane.rotation.set(0, planeHeading, 0);
}
function planeCrash() {
  const px = plane.position.x, py = plane.position.y + 0.6, pz = plane.position.z;
  burst(px, py, pz, 0xff7a2b, 34);             // fireball
  burst(px, py, pz, 0xffd23b, 22);             // sparks
  burst(px, py, pz, 0x40424a, 20);             // smoke
  for (let k = 0; k < 12; k++)                 // flung debris
    emit(tmpV.set(px, py, pz),
      new THREE.Vector3(rnd(-9, 9), rnd(4, 14), rnd(-9, 9)), 0x2b2f38, rnd(0.3, 0.6), 0.7, 1.6);
  shake = 2.6; crashSfx(60); toast('CRASH! back to the apron');
  missionEvent('reset');
  planeHome();
  mode = 'foot'; player.visible = true; rider.visible = false;
  player.position.set(PLANE_SPAWN.x + 4, 0, PLANE_SPAWN.z);
  player.rotation.set(0, PLANE_SPAWN.heading, 0);
  playerVel.set(0, 0, 0); playerOnGround = true;
}
function tryPlane() {
  if (mode === 'plane') {
    const gy = surfaceY(plane.position.x, plane.position.z);
    if (plane.position.y > gy + 1.2 || planeSpeed > 8) { toast('LAND FIRST — ease off the throttle'); return true; }
    mode = 'foot'; player.visible = true; rider.visible = false;
    const sx = Math.cos(planeHeading), sz = -Math.sin(planeHeading);   // step off a wing
    player.position.set(plane.position.x + sx*4, gy, plane.position.z + sz*4);
    player.rotation.set(0, planeHeading, 0);
    playerVel.set(0, 0, 0); playerOnGround = true; planeSpeed = 0;
    return true;
  }
  if (!nearPlane()) return false;
  mode = 'plane'; player.visible = false; rider.visible = false;
  planeSpeed = 0; planePitch = 0; planeRoll = 0; camYaw = planeHeading;
  toast('W/S throttle · A/D turn · Q/E roll · Space up · Ctrl down · R eject');
  return true;
}
// bail out: leave the plane in mid-air and fall. The plane flies itself home to the apron;
// hit R again to pull the chute before you meet the ground.
function ejectPlane() {
  if (mode !== 'plane') return false;
  const fx = Math.sin(planeHeading), fz = Math.cos(planeHeading);
  const horiz = planeSpeed * Math.cos(planePitch);
  const gy = surfaceY(plane.position.x, plane.position.z);
  mode = 'foot'; player.visible = true; rider.visible = false;
  player.position.set(plane.position.x, Math.max(plane.position.y, gy + 1) + 1.4, plane.position.z);
  player.rotation.set(0, planeHeading, 0);
  playerVel.set(fx*horiz*0.35, 6.5, fz*horiz*0.35);      // flung up and forward out of the cockpit
  playerOnGround = false; canDouble = false;
  chuteReady = true; chuteOpen = false;
  planeHome();                                            // the empty plane returns to its stand
  shake = 0.8;
  toast('EJECT!  press R again to pull the chute');
  return true;
}
function deployChute() {
  if (mode !== 'foot' || playerOnGround || !chuteReady || chuteOpen) return false;
  chuteOpen = true;
  if (playerVel.y < -CHUTE_FALL) playerVel.y = -CHUTE_FALL;   // the canopy bites at once
  toast('CHUTE OPEN — glide her down');
  return true;
}
function updatePlane(dt) {
  if (mode !== 'plane' || !AIRPORT) return;
  // Controls: W/S throttle, A/D flat turn (yaw, no bank needed), Q/E roll the wings,
  // Space = nose up, Ctrl = nose down. On the ground below takeoff speed the plane
  // handles like a car — throttle to roll, steer with A/D — so you taxi to the runway.
  const on = !paused;
  const K = c => on && !!keys[c];
  const gy = surfaceY(plane.position.x, plane.position.z);
  const grounded = plane.position.y <= gy + 0.06;
  // once you're rolling fast enough to fly (or already airborne) the flight controls
  // take over; below that on the tarmac you're taxiing.
  const flying = !grounded || planeSpeed >= PLANE_TAKEOFF;

  // throttle: W up, S down — S bites hard on the ground so it doubles as a brake
  if (K('KeyW')) planeSpeed += PLANE_ACCEL*dt;
  else if (K('KeyS')) planeSpeed -= (grounded ? PLANE_BRAKE : PLANE_DECEL)*dt;
  else planeSpeed -= PLANE_DRAG*dt;
  planeSpeed = THREE.MathUtils.clamp(planeSpeed, 0, PLANE_MAX);

  // yaw: A = turn left, D = turn right. Car-like on the ground (steering scales with
  // speed, none when stopped); a steady flat turn once flying.
  const yawIn = (K('KeyD') ? 1 : 0) - (K('KeyA') ? 1 : 0);
  if (flying) planeHeading -= yawIn * YAW_RATE * dt;
  else planeHeading -= yawIn * GROUND_STEER * THREE.MathUtils.clamp(planeSpeed/12, 0, 1) * dt;

  // pitch: Space = nose up, Ctrl = nose down. Flat while taxiing. In the air, hands-off,
  // the nose SAGS — gently under power (holds near level) but hard toward a dive with the
  // throttle closed. So idling never hovers: cut the power and you descend, and you'll fly
  // it into the ground unless you throttle up and pull the nose back level.
  const pIn = (K('Space') ? 1 : 0) - (K('ControlLeft') || K('ControlRight') ? 1 : 0);
  if (!flying) {
    planePitch += (0 - planePitch) * Math.min(1, dt*6);
  } else if (pIn) {
    planePitch += pIn * PITCH_RATE * dt;
  } else {
    const powered = K('KeyW');
    const sag = powered ? 0 : -PITCH_MAX*0.85;               // throttle closed -> nose drops
    planePitch += (sag - planePitch) * Math.min(1, dt*(powered ? 0.9 : 1.6));
  }
  planePitch = THREE.MathUtils.clamp(planePitch, -PITCH_MAX, PITCH_MAX);

  // roll: Q = bank left, E = bank right — and the bank now matches the way it turns, a
  // banked wing slipping the nose round the same direction it dips (Q left, E right).
  const rIn = (K('KeyQ') ? 1 : 0) - (K('KeyE') ? 1 : 0);
  if (flying) { planeRoll += rIn * ROLL_RATE * dt; if (!rIn) planeRoll += (0 - planeRoll) * Math.min(1, dt*1.5); planeHeading += planeRoll * 0.5 * dt; }
  else planeRoll += (0 - planeRoll) * Math.min(1, dt*6);
  planeRoll = THREE.MathUtils.clamp(planeRoll, -ROLL_MAX, ROLL_MAX);

  const lift = THREE.MathUtils.clamp(planeSpeed / PLANE_TAKEOFF, 0, 1);
  // vertical: airspeed on the wing turns the nose angle into climb or dive; too slow and
  // the wing stops flying and you simply fall. No hover — level cruise only holds because
  // the nose stays level under power.
  let vy;
  if (!flying) vy = 0;
  else vy = planeSpeed * Math.sin(planePitch) * lift - STALL_FALL * (1 - lift);

  const fx = Math.sin(planeHeading), fz = Math.cos(planeHeading);
  const horiz = planeSpeed * Math.cos(planePitch);
  let nx = plane.position.x + fx*horiz*dt, nz = plane.position.z + fz*horiz*dt;
  const ny = plane.position.y + vy*dt;
  // buildings are solid only down low (taxi / low pass); up high you fly clean over town
  if (ny < gy + 5) {
    const rc = collideCircle(nx, nz, 2.6, colliders);
    if (rc.hit) { if (planeSpeed > 8) { shake = Math.min(1.2, shake + 0.2); crashSfx(planeSpeed); } planeSpeed *= 0.5; }
    nx = rc.x; nz = rc.z;
  }
  nx = THREE.MathUtils.clamp(nx, -TOWN-900, TOWN+900);
  nz = THREE.MathUtils.clamp(nz, -TOWN-900, TOWN+900);
  const gy2 = surfaceY(nx, nz);
  plane.position.x = nx; plane.position.z = nz;
  if (ny <= gy2) {                                   // touching down
    // a safe landing is flat and slow: nose near level, wings level. Come in nose-down
    // (a dive) or dropping fast and you pile in.
    const steep = Math.abs(planePitch) > 0.3 || Math.abs(planeRoll) > 0.5;
    if ((-vy > CRASH_VY || steep) && planeSpeed > 8) { planeCrash(); return; }
    plane.position.y = gy2; planePitch = 0;
  } else plane.position.y = ny;
  if (inWater(plane.position.x, plane.position.z) && plane.position.y < WATER_Y + 2.2) { planeCrash(); return; }

  plane.rotation.set(-planePitch, planeHeading, -planeRoll);
  if (plane.userData) { const pr = plane.children[0] && plane.children[0].userData.prop; if (pr) pr.rotation.z += (6 + planeSpeed*0.6)*dt; }
  planeShadow.position.set(plane.position.x, gy2 + 0.09, plane.position.z);
  planeShadow.rotation.z = -planeHeading;
  player.position.set(plane.position.x, 0, plane.position.z);   // keep radar/coins/traffic on us
}

// =================================================================
//  MINIGAMES: PUTT & BOWL
//  The fit-out pass recorded real cup positions in every Putt Paradise and the
//  first lane of every Strike City. Here they become playable: a ball at the
//  putt tee you kick toward the cups, and a bowling ball you send down the lane
//  with F to scatter a live pin rack. Free play, paid in coins — like Gus's
//  garage, not like a mission.
// =================================================================
{
  const geo = new THREE.SphereGeometry(0.14, 12, 10);
  for (const p of PUTTS) {
    p.ball = new THREE.Mesh(geo, toon(0xf6f3ea));
    p.ball.castShadow = true;
    p.ball.position.set(p.tee.x, 0.2, p.tee.z);
    scene.add(p.ball);
    p.vx = 0; p.vz = 0; p.respawn = 0;
  }
  const pinGeo = new THREE.CylinderGeometry(0.09, 0.075, 0.42, 10);
  const ballGeo = new THREE.SphereGeometry(0.17, 14, 12);
  for (const bl of BOWLS) {
    bl.pinMs = bl.pins.map(pp => {
      const m = new THREE.Mesh(pinGeo, toon(0xf6f3ea));
      m.position.set(pp.x, 0.36, pp.z); m.castShadow = true; scene.add(m);
      return m;
    });
    bl.down = bl.pins.map(() => 0);
    bl.ball = new THREE.Mesh(ballGeo, toon(0xb03a2e));
    bl.ball.visible = false; scene.add(bl.ball);
    bl.rolling = false; bl.resetT = 0; bl.travel = 0;
    bl.bx = 0; bl.bz = 0; bl.bvx = 0; bl.bvz = 0;
  }
}
function nearPuttBall() {
  if (mode !== 'foot' || playerRag.active) return null;
  for (const p of PUTTS) {
    if (!p.ball || p.respawn > 0) continue;
    if (Math.hypot(p.ball.position.x - player.position.x, p.ball.position.z - player.position.z) < 2.2)
      return p;
  }
  return null;
}
function puttKick(fx, fz) {                       // called from kick()
  const p = nearPuttBall(); if (!p) return false;
  p.vx = fx * 9; p.vz = fz * 9;
  dingSfx();
  return true;
}
function updatePutt(dt) {
  for (const p of PUTTS) {
    const b = p.ball; if (!b) continue;
    if (p.respawn > 0) {
      p.respawn -= dt;
      if (p.respawn <= 0) { b.visible = true; b.position.set(p.tee.x, 0.2, p.tee.z); p.vx = p.vz = 0; }
      continue;
    }
    if (!p.vx && !p.vz) continue;
    let nx = b.position.x + p.vx*dt, nz = b.position.z + p.vz*dt;
    const r = p.rect, R2 = 0.14;
    if (nx < r.x0 + R2) { nx = r.x0 + R2; p.vx = Math.abs(p.vx)*0.7; }
    if (nx > r.x1 - R2) { nx = r.x1 - R2; p.vx = -Math.abs(p.vx)*0.7; }
    if (nz < r.z0 + R2) { nz = r.z0 + R2; p.vz = Math.abs(p.vz)*0.7; }
    if (nz > r.z1 - R2) { nz = r.z1 - R2; p.vz = -Math.abs(p.vz)*0.7; }
    for (const w of p.walls) {                    // the furniture bounces it back
      if (nx > w.minX - R2 && nx < w.maxX + R2 && nz > w.minZ - R2 && nz < w.maxZ + R2) {
        const pl = nx - (w.minX - R2), pr = (w.maxX + R2) - nx;
        const pt = nz - (w.minZ - R2), pb = (w.maxZ + R2) - nz;
        const m = Math.min(pl, pr, pt, pb);
        if (m === pl) { nx = w.minX - R2; p.vx = -Math.abs(p.vx)*0.7; }
        else if (m === pr) { nx = w.maxX + R2; p.vx = Math.abs(p.vx)*0.7; }
        else if (m === pt) { nz = w.minZ - R2; p.vz = -Math.abs(p.vz)*0.7; }
        else { nz = w.maxZ + R2; p.vz = Math.abs(p.vz)*0.7; }
      }
    }
    b.position.x = nx; b.position.z = nz;
    const f = 1 - Math.min(1, dt*0.9);
    p.vx *= f; p.vz *= f;
    if (Math.hypot(p.vx, p.vz) < 0.08) { p.vx = p.vz = 0; }
    for (const h of p.holes) {                    // close and slow drops in
      if (Math.hypot(nx - h.x, nz - h.z) < 0.32 && Math.hypot(p.vx, p.vz) < 7) {
        b.visible = false; p.respawn = 1.6; p.vx = p.vz = 0;
        p.sunk++;
        coinSfx(); addCoins(8);
        if (p.sunk >= p.holes.length) { toast('COURSE CLEAR! +8'); p.sunk = 0; }
        else toast('HOLE! +8');
        break;
      }
    }
  }
}
function nearBowlTee() {
  if (mode !== 'foot' || playerRag.active) return null;
  for (const bl of BOWLS) {
    if (bl.rolling || bl.resetT > 0) continue;
    if (Math.hypot(bl.tee.x - player.position.x, bl.tee.z - player.position.z) < 2.0) return bl;
  }
  return null;
}
function tryBowl() {
  const bl = nearBowlTee(); if (!bl) return false;
  // your facing leans the shot off the lane's centreline, so aim matters —
  // blended rather than rotated, which cannot get a sign wrong
  const fx = Math.sin(player.rotation.y), fz = Math.cos(player.rotation.y);
  let ax = bl.dx + fx*0.35, az = bl.dz + fz*0.35;
  const al = Math.hypot(ax, az) || 1; ax /= al; az /= al;
  bl.rolling = true; bl.travel = 0;
  bl.bx = bl.tee.x + ax*0.4; bl.bz = bl.tee.z + az*0.4;
  bl.bvx = ax*10.5; bl.bvz = az*10.5;
  bl.ball.visible = true;
  dingSfx();
  return true;
}
function updateBowl(dt) {
  for (const bl of BOWLS) {
    bl.down.forEach((v, i) => {                   // pins tip over, don't vanish
      if (v > 0 && v < 1) {
        bl.down[i] = Math.min(1, v + dt*3.5);
        const m = bl.pinMs[i];
        m.rotation.z = bl.down[i] * 1.5;
        m.position.y = 0.36 - bl.down[i]*0.22;
      }
    });
    if (bl.resetT > 0) {
      bl.resetT -= dt;
      if (bl.resetT <= 0) {
        bl.down.fill(0);
        bl.pinMs.forEach((m, i) => { m.rotation.z = 0; m.position.set(bl.pins[i].x, 0.36, bl.pins[i].z); });
      }
      continue;
    }
    if (!bl.rolling) continue;
    bl.bx += bl.bvx*dt; bl.bz += bl.bvz*dt;
    bl.travel += Math.hypot(bl.bvx, bl.bvz)*dt;
    bl.ball.position.set(bl.bx, 0.32, bl.bz);
    bl.pins.forEach((pp, i) => {
      if (bl.down[i]) return;
      if (Math.hypot(bl.bx - pp.x, bl.bz - pp.z) < 0.42) {
        bl.down[i] = 0.01; dingSfx();
        bl.pins.forEach((qq, j) => {              // a falling pin can take a neighbour
          if (!bl.down[j] && Math.hypot(pp.x - qq.x, pp.z - qq.z) < 0.5 && Math.random() < 0.5)
            bl.down[j] = 0.01;
        });
      }
    });
    if (bl.travel > bl.len + 2.2) {
      bl.rolling = false; bl.ball.visible = false;
      const n = bl.down.filter(v => v > 0).length;
      const strike = n >= bl.pins.length;
      toast(strike ? 'STRIKE! +40' : n ? n + ' PINS +' + n*4 : 'GUTTER…');
      if (strike) { addCoins(40); coinSfx(); chaosHit(6); }
      else if (n) { addCoins(n*4); coinSfx(); }
      bl.resetT = 2.0;
    }
  }
}

// ---- the four shop games: crate rush, whack-a-cabinet, dance floor, last orders ----
{
  const crateGeo = merge([BOX(0.85, 0.8, 0.85).translate(0, 0.4, 0),
                          BOX(0.95, 0.12, 0.95).translate(0, 0.86, 0)]);
  for (const r of RUSHES) {
    r.crates = r.spots.map(sp => {
      const m = new THREE.Mesh(crateGeo, toon(0x9a6b3f));
      m.position.set(sp.x, 0.1, sp.z); m.castShadow = true; m.visible = false; scene.add(m);
      return m;
    });
    r.active = false; r.t = 0; r.got = 0;
  }
  for (const w of WHACKS) {
    w.lamp = new THREE.Mesh(BOX(1.0, 0.5, 1.0),
      new THREE.MeshBasicMaterial({ color: 0xffd23b, transparent: true, opacity: 0.85, depthWrite: false }));
    w.lamp.visible = false; scene.add(w.lamp);
    w.active = false; w.t = 0; w.lit = -1; w.litT = 0; w.hits = 0;
  }
  for (const d of DANCES) {
    d.lamp = new THREE.Mesh(new THREE.PlaneGeometry(1.06, 1.06).rotateX(-Math.PI/2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }));
    d.lamp.visible = false; scene.add(d.lamp);
    d.active = false; d.lit = -1; d.w = 0; d.streak = 0;
  }
  for (const p of PINTS) {
    p.glass = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.08, 0.22, 10), toon(0xd8891f));
    body.position.y = 0.11; p.glass.add(body);
    const foam = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.095, 0.05, 10), toon(0xf6f3ea));
    foam.position.y = 0.25; p.glass.add(foam);
    p.glass.visible = false; scene.add(p.glass);
    p.mat = new THREE.Mesh(new THREE.CircleGeometry(0.55, 20).rotateX(-Math.PI/2),
      new THREE.MeshBasicMaterial({ color: 0xffd23b, transparent: true, opacity: 0.75, depthWrite: false }));
    p.mat.visible = false; scene.add(p.mat);
    p.state = 'idle'; p.pos = 0; p.target = 0; p.doneT = 0;
  }
}
// ---- the heist, the conveyor, the initiation ----
{
  for (const h of HEISTS) {
    h.beams = [0, 1].map(k => {
      const m = new THREE.Mesh(BOX(h.arm*2, 0.06, 0.28),
        new THREE.MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: 0.6, depthWrite: false }));
      m.position.set(h.cx, 0.55, h.cz); m.visible = false; scene.add(m);
      return m;
    });
    h.active = false; h.a = 0;
  }
  for (const K of KOIS) {
    // the conveyor runs whether anyone plays or not — it is scenery that happens
    // to be a game. Five plates, one gold, one wasabi.
    const kinds = ['gold', 'norm', 'wasabi', 'norm', 'norm'];
    K.plates = kinds.map((kind, i) => {
      const g = new THREE.Group();
      const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.14, 0.05, 12),
        toon(kind === 'gold' ? 0xc9a24b : 0xf6f3ea));
      g.add(plate);
      const top = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8),
        toon(kind === 'gold' ? 0xffd23b : kind === 'wasabi' ? 0x7fbf3f : 0xe87ab0));
      top.position.y = 0.1; g.add(top);
      scene.add(g);
      return { g, kind, t: i * K.len / kinds.length };
    });
  }
  for (const o of OWLS) { o.active = false; o.seq = []; o.idx = 0; }
}
const OWL_MOVES = { P: '👊 PUNCH', K: '🦶 KICK' };
function owlShow(o) {
  banner('THE ORDER SHOWS', o.seq.map(k => OWL_MOVES[k]).join(' · ') + ' — repeat it');
}
function tryOwl() {
  const o = nearGameTee(OWLS); if (!o) return false;
  o.active = true;
  o.seq = [Math.random() < 0.5 ? 'P' : 'K']; o.idx = 0;
  owlShow(o);
  return true;
}
function initiationInput(k) {
  for (const o of OWLS) {
    if (!o.active) continue;
    if (k === o.seq[o.idx]) {
      o.idx++;
      if (sirenCtx) tone(523 + o.idx*80, sirenCtx.currentTime, 0.07, 0.07, 'triangle');
      if (o.idx >= o.seq.length) {
        if (o.seq.length >= 7) {
          o.active = false; addCoins(80); coinSfx();
          banner('INITIATED', 'the Order accepts you · +80 coins');
        } else {
          o.seq.push(Math.random() < 0.5 ? 'P' : 'K'); o.idx = 0;
          owlShow(o);
        }
      }
    } else {
      const pay = (o.seq.length - 1) * 8;
      o.active = false;
      toast(pay ? 'THE OWL FROWNS · +' + pay : 'THE OWL FROWNS');
      if (pay) { addCoins(pay); coinSfx(); }
    }
    return;
  }
}
function tryHeist() {
  const h = nearGameTee(HEISTS); if (!h) return false;
  h.active = true; h.a = 0;
  h.beams.forEach(b => b.visible = true);
  banner('THE HEIST', 'reach the gold bust — the red beams are alarms (you can jump them)');
  return true;
}
function tryKoi() {
  if (mode !== 'foot' || playerRag.active) return false;
  for (const K of KOIS) {
    // grab whatever plate is passing in front of you
    let best = null, bd = 1.2;
    for (const p of K.plates) {
      const d = Math.hypot(p.g.position.x - player.position.x, p.g.position.z - player.position.z);
      if (d < bd) { bd = d; best = p; }
    }
    const nearBar = Math.hypot((K.A.x + K.B.x)/2 - player.position.x, (K.A.z + K.B.z)/2 - player.position.z) < K.len/2 + 1.6;
    if (!nearBar) continue;
    if (!best) { toast('time it…'); return true; }
    if (best.kind === 'gold') { addCoins(8); coinSfx(); toast('OMAKASE! +8'); }
    else if (best.kind === 'wasabi') { shake = Math.min(1.4, shake + 0.7); toast('WASABI!!'); sayOuch && sayOuch('kick'); }
    else { addCoins(2); coinSfx(); toast('tasty +2'); }
    best.t = 0;                                    // the plate goes back to the kitchen
    return true;
  }
  return false;
}
// one shared "stand here, press F" test for the round-based games
function nearGameTee(list) {
  if (mode !== 'foot' || playerRag.active) return null;
  for (const r of list) {
    if (r.active) continue;
    if (Math.hypot(r.tee.x - player.position.x, r.tee.z - player.position.z) < 2.0) return r;
  }
  return null;
}
function tryRush() {
  const r = nearGameTee(RUSHES); if (!r) return false;
  r.active = true; r.t = 25; r.got = 0;
  r.crates.forEach((m, i) => { m.visible = true; m.position.set(r.spots[i].x, 0.1, r.spots[i].z); });
  banner('CRATE RUSH', 'run through all ' + r.crates.length + ' crates before the clock');
  return true;
}
function whackNext(w) {
  let i; do { i = (Math.random()*w.cabs.length)|0; } while (i === w.lit && w.cabs.length > 1);
  w.lit = i; w.litT = 2.6;
  w.lamp.visible = true;
  w.lamp.position.set(w.cabs[i].x, 2.15, w.cabs[i].z);
}
function tryWhack() {
  const w = nearGameTee(WHACKS); if (!w) return false;
  w.active = true; w.t = 30; w.hits = 0; whackNext(w);
  banner('WHACK-A-CABINET', 'punch the glowing cabinet — 30 seconds');
  return true;
}
function whackTry() {                              // called from punch() and kick()
  for (const w of WHACKS) {
    if (!w.active || w.lit < 0) continue;
    const c = w.cabs[w.lit];
    if (Math.hypot(c.x - player.position.x, c.z - player.position.z) < 2.0) {
      w.hits++; addCoins(2); coinSfx();
      burst(c.x, 1.6, c.z, 0x7fe0ff, 6);
      whackNext(w);
      return true;
    }
  }
  return false;
}
function danceNext(d, wMax) {
  let i; do { i = (Math.random()*d.tiles.length)|0; } while (i === d.lit && d.tiles.length > 1);
  d.lit = i; d.w = wMax;
  d.lamp.visible = true;
  d.lamp.position.set(d.tiles[i].x, 0.22, d.tiles[i].z);
}
function tryDance() {
  const d = nearGameTee(DANCES); if (!d) return false;
  d.active = true; d.streak = 0; danceNext(d, 3.0);
  banner('DANCE FLOOR', 'step on the lit tile — keep the streak alive');
  return true;
}
function tryPint() {
  if (mode !== 'foot' || playerRag.active) return false;
  for (const p of PINTS) {
    if (p.state === 'slide') {                     // the second F is the whole skill
      p.state = 'stopped'; p.doneT = 1.2;
      if (Math.abs(p.pos - p.target) < 0.6) { addCoins(10); coinSfx(); toast('RIGHT ON THE MAT! +10'); }
      else if (p.pos > p.target) toast('PAST THEM…');
      else toast('SHORT…');
      return true;
    }
    if (p.state !== 'idle') continue;
    if (Math.hypot(p.A.x - player.position.x, p.A.z - player.position.z) > 2.2) continue;
    p.state = 'slide'; p.pos = 0;
    p.target = p.len * (0.4 + Math.random()*0.5);
    p.glass.visible = true; p.mat.visible = true;
    dingSfx();
    return true;
  }
  return false;
}
function updateShopGames(dt) {
  for (const r of RUSHES) {
    if (!r.active) continue;
    r.t -= dt;
    for (const m of r.crates) {
      if (!m.visible) continue;
      if (Math.hypot(m.position.x - player.position.x, m.position.z - player.position.z) < 1.05) {
        m.visible = false; r.got++;
        burst(m.position.x, 0.8, m.position.z, 0xc98a3d, 10);
        addCoins(3); coinSfx();
        if (r.got >= r.crates.length) { addCoins(30); toast('CLEAN SWEEP! +30'); r.active = false; }
      }
    }
    if (r.active && r.t <= 0) {
      toast('TIME! ' + r.got + '/' + r.crates.length);
      r.crates.forEach(m => m.visible = false); r.active = false;
    }
  }
  for (const w of WHACKS) {
    if (!w.active) continue;
    w.t -= dt; w.litT -= dt;
    w.lamp.material.opacity = 0.5 + 0.35*Math.sin(markerBob*6);
    if (w.litT <= 0) whackNext(w);                 // too slow — it moves on
    if (w.t <= 0) {
      w.active = false; w.lamp.visible = false; w.lit = -1;
      const pay = w.hits*3;
      toast(w.hits ? w.hits + ' HITS +' + pay : 'NOT ONE…');
      if (pay) { addCoins(pay); coinSfx(); }
    }
  }
  for (const d of DANCES) {
    if (!d.active) continue;
    d.w -= dt;
    d.lamp.material.opacity = 0.55 + 0.35*Math.sin(markerBob*7);
    const t2 = d.tiles[d.lit];
    if (mode === 'foot' && Math.hypot(t2.x - player.position.x, t2.z - player.position.z) < 0.8) {
      d.streak++; addCoins(2);
      if (sirenCtx) tone(392 + (d.streak % 8)*66, sirenCtx.currentTime, 0.08, 0.06, 'triangle');
      danceNext(d, Math.max(1.2, 3.0 - d.streak*0.12));   // the floor speeds up
    } else if (d.w <= 0) {
      d.active = false; d.lamp.visible = false; d.lit = -1;
      const pay = d.streak*4 + (d.streak >= 10 ? 20 : 0);
      toast(d.streak ? d.streak + ' STEPS +' + pay : 'THE FLOOR WINS…');
      if (pay) { addCoins(pay); coinSfx(); }
    }
  }
  for (const h of HEISTS) {
    if (!h.active) continue;
    h.a += dt * 0.9;
    h.beams[0].rotation.y = h.a;
    h.beams[1].rotation.y = -h.a * 1.35 + 1.2;
    h.beams.forEach(b => b.material.opacity = 0.45 + 0.2*Math.sin(markerBob*5));
    const px2 = player.position.x - h.cx, pz2 = player.position.z - h.cz;
    const rr = Math.hypot(px2, pz2);
    if (mode !== 'foot' || rr > 30) {                 // walked out on the job
      h.active = false; h.beams.forEach(b => b.visible = false); continue;
    }
    if (Math.hypot(h.ex.x - player.position.x, h.ex.z - player.position.z) < 1.5) {
      h.active = false; h.beams.forEach(b => b.visible = false);
      addCoins(25); coinSfx(); chaosHit(6);
      banner('GOT THE GOODS', '+25 coins · walk out like you own it');
      continue;
    }
    if (player.position.y < 0.9 && rr < h.arm && !playerRag.active) {
      // distance from the player to each sweeping bar
      for (const b of h.beams) {
        const ca = Math.cos(b.rotation.y), sa = Math.sin(b.rotation.y);
        // bar runs along (ca, -sa) in xz (rotation.y spins the +x axis that way)
        const perp = Math.abs(px2*sa + pz2*ca);
        if (perp < 0.45) {
          h.active = false; h.beams.forEach(bb => bb.visible = false);
          heat = Math.min(heat + 22, STAR_AT[5] * 1.25);
          toast('ALARM!'); shake = Math.min(1.4, shake + 0.6);
          if (sirenCtx) { const t2 = sirenCtx.currentTime;
            tone(1200, t2, 0.12, 0.1); tone(900, t2 + 0.15, 0.12, 0.1); }
          break;
        }
      }
    }
  }
  for (const K of KOIS) {
    const ux = (K.B.x - K.A.x)/K.len, uz = (K.B.z - K.A.z)/K.len;
    for (const p of K.plates) {
      p.t += 1.2*dt;
      if (p.t > K.len) p.t -= K.len;
      p.g.position.set(K.A.x + ux*p.t, 1.1, K.A.z + uz*p.t);
    }
  }
  for (const p of PINTS) {
    if (p.state === 'idle') continue;
    const ux = (p.B.x - p.A.x)/p.len, uz = (p.B.z - p.A.z)/p.len;
    if (p.state === 'slide') {
      p.pos += 4.2*dt;
      if (p.pos >= p.len) {                        // off the end of the bar
        p.state = 'stopped'; p.doneT = 1.2; p.pos = p.len;
        burst(p.B.x, 1.3, p.B.z, 0xf6f3ea, 8);
        dingSfx(); toast('OFF THE END…');
      }
    } else {
      p.doneT -= dt;
      if (p.doneT <= 0) { p.state = 'idle'; p.glass.visible = false; p.mat.visible = false; continue; }
    }
    p.glass.position.set(p.A.x + ux*p.pos, 1.06, p.A.z + uz*p.pos);
    p.mat.position.set(p.A.x + ux*p.target, 1.08, p.A.z + uz*p.target);
  }
}

// The seat, in world space, for whichever ride you are on. Returns a position and the
// direction you are facing — the camera is placed from this every frame, so a ride only
// has to move its own geometry and the view follows for free.
const rideSeat = (R) => {
  if (R.kind === 'carousel') {
    // A group's rotation.y of θ carries a horse at local angle a to WORLD angle a − θ,
    // not a + θ. The first version added, so the camera orbited against the platform
    // and the horses paraded round the rider instead of carrying him. The bob phase
    // has to be the horse's own (h.a*2, matching updateRides) for the same reason.
    const h = R.horses[R.seat], a = h.a - R.spin.rotation.y;
    const bob = Math.sin(R.t*3 + h.a*2)*0.28;
    return { x: R.cx + Math.cos(a)*4.9, y: 2.6 + bob, z: R.cz + Math.sin(a)*4.9,
             yaw: -a };                                   // tangent: the way round you go
  }
  if (R.kind === 'coaster') {
    const [x, y, z] = R.P(R.t), [x2, , z2] = R.P(R.t + 0.0025);
    const yaw = Math.atan2(x2 - x, z2 - z);
    // Sat BEHIND the cart's centre and up, looking forward — so you see the cart you are
    // riding in: its body and the red nose cone dip away ahead of you over each crest,
    // and the rails run out in front. (Ahead of the cart, as it was, the body is off
    // screen behind you and there is nothing to tell you what you are in.)
    return { x: x - Math.sin(yaw)*1.5, y: y + 1.9, z: z - Math.cos(yaw)*1.5, yaw };
  }
  const c = R.cars[R.seat];
  return { x: c.x, y: 1.66, z: c.z, yaw: c.yaw };
};
function updateRides(dt) {
  if (rideExitCd > 0) rideExitCd -= dt;
  for (const R of FAIR) {
    if (R.kind === 'carousel') {
      R.t += dt; R.spin.rotation.y -= dt*0.45;        // negative: clockwise from above
      for (const h of R.horses) h.g.position.y = 0.35 + Math.sin(R.t*3 + h.a*2)*0.28;
    } else if (R.kind === 'coaster') {
      if (R.wait > 0) {
        // in the station. The clock runs whether anyone is aboard or not — it is a
        // fairground ride on a schedule, not a taxi waiting for you.
        R.wait -= dt; R.t = R.stopU; R.phase = 'lift'; R.wrapped = false;
      } else {
        // Three regimes, like a real coaster: the chain hauls you up at walking
        // pace, gravity owns everything from the crest (quick in the dips,
        // laboured over the hills, a floor so it can never stall), and brakes
        // bring it home to the platform.
        let v;
        if (R.phase === 'lift') {
          v = 3.6;
          if (R.t >= R.crestU) R.phase = 'coast';
        } else if (R.phase === 'coast') {
          const y = R.P(R.t)[1];
          v = Math.sqrt(Math.max(40, 2*9.8*(R.topY + 1.5 - y)));
          if (R.t >= R.brakeU) { R.phase = 'brake'; R.v = v; }
        } else {
          R.v = Math.max(3.4, R.v - 14*dt);            // the brake run bleeds it off
          v = R.v;
        }
        let t2 = R.t + (v / R.len) * dt;
        if (t2 >= 1) { t2 -= 1; R.wrapped = true; }
        if (R.phase === 'brake' && R.wrapped && t2 >= R.stopU) { R.t = R.stopU; R.wait = 10; }
        else R.t = t2;
      }
      const [x, cy, z] = R.P(R.t), [x2, y2, z2] = R.P(R.t + 0.0025);
      R.cart.position.set(x, cy + 0.32, z);
      R.cart.rotation.set(-Math.asin(THREE.MathUtils.clamp((y2 - cy)/Math.max(0.001, Math.hypot(x2-x, y2-cy, z2-z)), -1, 1)),
                          Math.atan2(x2 - x, z2 - z), 0, 'YXZ');
    } else {
      for (const c of R.cars) {
        const ridden = riding === R && R.cars[R.seat] === c;
        if (ridden) {                                    // you get to steer yours
          const t = (keys.KeyA||keys.ArrowLeft?1:0) - (keys.KeyD||keys.ArrowRight?1:0);
          const g = (keys.KeyW||keys.ArrowUp?1:0) - (keys.KeyS||keys.ArrowDown?1:0);
          c.yaw += t*2.6*dt; c.spd += ((g > 0 ? 7 : g*4) - c.spd)*Math.min(1, dt*2.4);
          if (!g) c.spd *= 1 - Math.min(1, dt*1.8);
        } else {
          c.turn += (Math.random()-0.5)*dt*6;
          c.turn = THREE.MathUtils.clamp(c.turn, -1.6, 1.6);
          c.yaw += c.turn*dt;
          c.spd += (4.2 - c.spd)*Math.min(1, dt);
        }
        let nx = c.x + Math.sin(c.yaw)*c.spd*dt, nz = c.z + Math.cos(c.yaw)*c.spd*dt;
        // The wall turns an AI car round rather than stopping it dead — and the two
        // reflections are NOT the same formula. A side (±x) wall negates the x of the
        // heading (yaw → −yaw); an end (±z) wall negates the z (yaw → π − yaw). The
        // first version used π − yaw for both, so a car angling into a side wall kept
        // its x-motion pinned into the wall and ground along it, jittering, for ever.
        // The RIDDEN car never gets its yaw flipped at all: in first person a forced
        // 180° on every wall kiss reads as the camera breaking. It just loses most of
        // its speed and takes the thump.
        const wall = (ax) => { c.bump = 0.2;
          if (ridden) { c.spd *= -0.35; }
          else c.yaw = ax ? -c.yaw : Math.PI - c.yaw; };
        if (nx < R.bx - R.HW + 1.2) { nx = R.bx - R.HW + 1.2; wall(true); }
        if (nx > R.bx + R.HW - 1.2) { nx = R.bx + R.HW - 1.2; wall(true); }
        if (nz < R.bz - R.HD + 1.2) { nz = R.bz - R.HD + 1.2; wall(false); }
        if (nz > R.bz + R.HD - 1.2) { nz = R.bz + R.HD - 1.2; wall(false); }
        c.x = nx; c.z = nz;
        for (const o of R.cars) {                        // and each other, which is the point
          if (o === c) continue;
          const dx = c.x - o.x, dz = c.z - o.z, d = Math.hypot(dx, dz);
          if (d > 2.1 || d < 1e-4) continue;
          const push = (2.1 - d)/2;
          c.x += dx/d*push; c.z += dz/d*push; o.x -= dx/d*push; o.z -= dz/d*push;
          // the spin from a hit stays off the ridden car too — the shove and the
          // bounce animation carry the impact without wrenching the view round
          const rid = riding === R && R.cars[R.seat];
          if (c !== rid) c.yaw += 0.7;
          if (o !== rid) o.yaw -= 0.7;
          c.bump = o.bump = 0.25;
          if (!c.hitT || performance.now() - c.hitT > 400) { c.hitT = performance.now(); dingSfx(); }
        }
        c.bump = Math.max(0, c.bump - dt);
        c.g.position.set(c.x, 0.16 + c.bump*0.12, c.z);  // ON the steel floor, not in it
        c.g.rotation.set(0, c.yaw, c.bump*0.18, 'YXZ');
      }
    }
  }
}
// F on a ride: get on, or get off. Returns true when it has taken the keypress.
function tryRide() {
  if (riding) {
    const s = rideSeat(riding);
    riding = null; rideExitCd = 0.4;
    camYaw = s.yaw + camYaw; camPitch = -0.15;   // carry the look angle back out with you
    player.visible = true;
    player.position.set(s.x + Math.sin(s.yaw + Math.PI/2)*3.5, 0, s.z + Math.cos(s.yaw + Math.PI/2)*3.5);
    playerVel.set(0,0,0);
    return true;
  }
  if (mode !== 'foot' || playerRag.active || rideExitCd > 0) return false;
  for (const R of FAIR) {
    const dx = R.x - player.position.x, dz = R.z - player.position.z;
    if (dx*dx + dz*dz > R.r*R.r) continue;
    if (R.kind === 'coaster' && R.wait <= 0) continue;   // the cart is out on the track
    if (R.kind === 'bumper') R.seat = R.freeSeat || 0;   // the one cart without a rider
    else if (R.kind === 'carousel') R.seat = (R.seat + 1) % R.horses.length;
    riding = R; player.visible = false; camYaw = 0; camPitch = 0;   // look starts dead ahead
    toast('ENJOY THE RIDE');
    return true;
  }
  return false;
}
function nearRide() {
  if (mode !== 'foot' || playerRag.active) return null;
  for (const R of FAIR) {
    const dx = R.x - player.position.x, dz = R.z - player.position.z;
    if (dx*dx + dz*dz <= R.r*R.r)
      return (R.kind === 'coaster' && R.wait <= 0) ? { waitFor: R } : R;
  }
  return null;
}

// =================================================================
//  HEADLIGHTS
//  Two soft beam cones and a single spotlight, faded in by nightAmt. One light,
//  not two: a second shadow-casting spot doubles the cost for a symmetry nobody
//  looks at. The cones are what actually sell it — they read as light in a world
//  drawn with flat toon shading.
// =================================================================
const beamMat = new THREE.MeshBasicMaterial({ color: 0xfff3c4, transparent: true,
  opacity: 0, depthWrite: false, side: THREE.DoubleSide, fog: false });
const headBeams = [];
{
  const cone = new THREE.ConeGeometry(2.6, 15, 16, 1, true).rotateX(Math.PI/2).translate(0, 0, 7.5);
  for (const sx of [-0.72, 0.72]) {
    const m = new THREE.Mesh(cone, beamMat);
    m.position.set(sx, 0.72, 2.1); m.renderOrder = 4;
    car.add(m); headBeams.push(m);
  }
}
const headSpot = new THREE.SpotLight(0xfff3c4, 0, 46, 0.62, 0.55, 1.2);
headSpot.position.set(0, 1.0, 2.2);
car.add(headSpot); car.add(headSpot.target);
headSpot.target.position.set(0, 0.2, 22);
function updateHeadlights() {
  const on = nightAmt > 0.12 && mode === 'car' && drowning <= 0;
  const k = on ? Math.min(1, (nightAmt - 0.12) / 0.4) : 0;
  beamMat.opacity = k * 0.16;
  headSpot.intensity = k * 130;
  for (const b of headBeams) b.visible = k > 0.01;
}

// =================================================================
//  LOST PROPERTY
//  One hidden trophy in every walk-in room. Thirty-five rooms were furnished and
//  staffed and then had no reason to exist; a trophy each turns the whole high
//  street into a collection. Built here, well after the tree stage, as a single
//  InstancedMesh like the coins — so it costs one draw call and no seeded randoms.
// =================================================================
const trophies = [];
{
  const geo = merge([
    baked(new THREE.CylinderGeometry(0.30, 0.34, 0.10, 16), 0, 0.05, 0),   // plinth
    baked(new THREE.CylinderGeometry(0.07, 0.07, 0.22, 16), 0, 0.20, 0),   // stem
    baked(new THREE.SphereGeometry(0.23, 16, 12).scale(1, 0.85, 1), 0, 0.48, 0),
  ]);
  const mesh = instanced(geo, toon(0xffd23b), Math.max(1, ROOMS.length), false);
  for (const R of ROOMS) {
    const I = R.inner;
    // tuck it away from the doorway, and off anything solid the fit-out registered
    const spots = [];
    for (const fx of [0.16, 0.5, 0.84]) for (const fz of [0.16, 0.5, 0.84])
      spots.push({ x: I.x0 + (I.x1 - I.x0)*fx, z: I.z0 + (I.z1 - I.z0)*fz });
    const door = R.door;
    let best = null, bd = -1;
    for (const s of spots) {
      const solid = (R.walls || []).some(c =>
        s.x > c.minX - 0.5 && s.x < c.maxX + 0.5 && s.z > c.minZ - 0.5 && s.z < c.maxZ + 0.5);
      if (solid) continue;
      const d = door ? Math.hypot(s.x - door.x, s.z - door.z) : 1;   // the far corner reads as "hidden"
      if (d > bd) { bd = d; best = s; }
    }
    if (best) trophies.push({ x: best.x, z: best.z, got: false, i: trophies.length, room: R.name });
  }
  mesh.count = trophies.length;
  scene.add(mesh);
  var trophyMesh = mesh;
}
let trophyCount = 0, trophySpin = 0;
const trophyEl = document.getElementById('trophies');
function updateTrophies(dt, sub) {
  if (!trophies.length) return;
  trophySpin += dt*1.8;
  for (const t of trophies) {
    if (t.got) { dummy.position.set(t.x, -20, t.z); dummy.scale.setScalar(0); }
    else {
      dummy.position.set(t.x, 0.95 + Math.sin(trophySpin + t.i)*0.12, t.z);
      dummy.rotation.set(0, trophySpin*1.2, 0); dummy.scale.setScalar(1);
      // on foot only: a trophy is a reward for walking in, not for driving past
      if (mode === 'foot') {
        const dx = t.x - player.position.x, dz = t.z - player.position.z;
        if (dx*dx + dz*dz < 2.6) {
          t.got = true; trophyCount++;
          addCoins(40); coinSfx();
          burst(t.x, 1.2, t.z, 0xffd23b, 14);
          const left = trophies.length - trophyCount;
          banner('TROPHY ' + trophyCount + '/' + trophies.length,
            left ? '+40 coins · ' + left + ' still out there' : 'every room cleared!');
          if (!left) { addCoins(1000); toast('COMPLETIONIST! +1000'); }
        }
      }
    }
    dummy.updateMatrix(); trophyMesh.setMatrixAt(t.i, dummy.matrix);
  }
  trophyMesh.instanceMatrix.needsUpdate = true;
  trophyEl.textContent = '🏆 ' + trophyCount + '/' + trophies.length;
}

// =================================================================
//  GUS'S GARAGE
//  Somewhere to spend the coins. Walk into the forecourt and a keyboard menu
//  opens: number keys buy, and every purchase changes how the car actually
//  drives. Deliberately not a mission — the shop is always open, never blocks
//  a job, and shares no state with MI.
// =================================================================
const RIDES = ['convert', 'sedan', 'wagon', 'compact', 'truck'];
const RIDE_NAMES = ['the ragtop', 'a saloon', 'the estate', 'a runabout', 'the pickup'];
const SHOP = [
  { key: 'engine', name: 'ENGINE', lvl: 0, max: 3, cost: [150, 400, 900],
    blurb: ['stock', 'tuned', 'blown', 'insane'],
    apply() { MAX_SPEED = 42 + this.lvl*7; ACCEL = 32 + this.lvl*6; } },
  { key: 'armor', name: 'ARMOR', lvl: 0, max: 3, cost: [120, 320, 700],
    blurb: ['paper', 'plated', 'reinforced', 'tank'],
    apply() { armorMul = [1, 0.72, 0.5, 0.32][this.lvl]; } },
  { key: 'horn', name: 'AIR HORN', lvl: 0, max: 1, cost: [200],
    blurb: ['none', 'fitted — press H'],
    apply() { hasHorn = this.lvl > 0; } },
  { key: 'ride', name: 'NEW RIDE', lvl: 0, max: 99, cost: [250],
    blurb: ['—'],
    apply() { GARAGE.ride = (GARAGE.ride + 1) % RIDES.length;
              setPlayerCar(RIDES[GARAGE.ride], rpick(CAR_COLS)); } },
];
const shopEl = document.getElementById('shop');
const priceOf = it => it.key === 'ride' ? 250 : it.cost[it.lvl];
function shopBuy(n) {
  if (!GARAGE.open) return false;
  const it = SHOP[n]; if (!it) return false;
  if (it.lvl >= it.max) { toast('MAXED OUT'); return true; }
  const p = priceOf(it);
  if (coinCount < p) { toast('NOT ENOUGH COINS'); return true; }
  addCoins(-p);
  if (it.key !== 'ride') it.lvl++;
  it.apply();
  coinSfx();
  toast(it.key === 'ride' ? 'NICE — ' + RIDE_NAMES[GARAGE.ride].toUpperCase() : it.name + ' UP!');
  burst(player.position.x, 1.4, player.position.z, 0xffd23b, 12);
  drawShop();
  return true;
}
function drawShop() {
  let h = '<b>GUS\'S GARAGE</b><small>' + coinCount + ' coins</small><table>';
  SHOP.forEach((it, i) => {
    const maxed = it.lvl >= it.max;
    const p = priceOf(it);
    const state = it.key === 'ride' ? RIDE_NAMES[GARAGE.ride]
                : maxed ? it.blurb[it.lvl] : it.blurb[it.lvl] + ' → ' + it.blurb[it.lvl+1];
    const afford = !maxed && coinCount >= p;
    h += '<tr class="' + (maxed ? 'max' : afford ? 'ok' : 'no') + '"><td>' + (i+1) +
      '</td><td>' + it.name + '</td><td>' + state + '</td><td>' +
      (maxed ? 'MAX' : p) + '</td></tr>';
  });
  shopEl.innerHTML = h + '</table>';
}
function updateGarage() {
  const near = mode === 'foot' && !playerRag.active &&
    (player.position.x - GARAGE.x)**2 + (player.position.z - GARAGE.z)**2 < 90;
  if (near !== GARAGE.open) { GARAGE.open = near; shopEl.style.display = near ? 'block' : 'none'; }
  if (near) drawShop();
}
// the horn: everyone in earshot bolts, and the flock loses its mind
let hornCd = 0;
function honk() {
  if (!hasHorn || hornCd > 0) return;
  hornCd = 1.2;
  const sub = mode === 'car' ? car.position : player.position;
  if (sirenCtx) { const t = sirenCtx.currentTime;
    tone(196, t, 0.34, 0.16, 'square'); tone(262, t + 0.02, 0.32, 0.12, 'square');
    tone(392, t + 0.05, 0.26, 0.07, 'square'); }
  for (const p of peds) {
    if (p.rag.active) continue;
    const dx = p.g.position.x - sub.x, dz = p.g.position.z - sub.z;
    if (dx*dx + dz*dz < 900) setFlee(p, sub.x, sub.z);
  }
  for (const c of chickens) {
    if (c.dead > 0) continue;
    const dx = c.x - sub.x, dz = c.z - sub.z;
    if (dx*dx + dz*dz < 900) { c.fled = 1.4; c.speed = 8; c.yaw = Math.atan2(dx, dz) + rnd(-0.4, 0.4); }
  }
  burst(sub.x, 1.6, sub.z, 0xe8eaf0, 8);
  chaosHit(3);
}

// =================================================================
//  MISSIONS
//  One job at a time, taken from a gold-glow townsperson. The plumbing all jobs
//  share: a target (guide arrow over your head, light-pillar beacon on the spot,
//  a blip clamped to the radar rim), a countdown measured over the road graph —
//  a crow-flies par would make every cross-river job impossible — and a banner
//  for the big moments. Rewards scale with the heat you're carrying when you
//  deliver, so causing trouble en route is the optimal strategy, not a mistake.
// =================================================================
const bannerEl = document.getElementById('banner');
const bannerTitle = bannerEl.querySelector('.t'), bannerSub = bannerEl.querySelector('.s');
let bannerT = 0;
function banner(title, sub) {
  bannerTitle.textContent = title; bannerSub.textContent = sub || '';
  bannerEl.classList.add('show'); bannerT = 3.0;
}

// shortest drive between two points, over the road graph
function roadDist(x0, z0, x1, z1) {
  const a = nearestNode(x0, z0), b = nearestNode(x1, z1);
  if (a < 0 || b < 0) return Math.hypot(x1 - x0, z1 - z0) * 1.4;
  const N = NET.nodes.length;
  const dist = new Float64Array(N).fill(Infinity), done = new Uint8Array(N);
  dist[a] = 0;
  for (;;) {
    let u = -1, bd = Infinity;
    for (let i = 0; i < N; i++) if (!done[i] && dist[i] < bd) { bd = dist[i]; u = i; }
    if (u < 0 || u === b) break;
    done[u] = 1;
    for (const ei of NET.nodes[u].e) {
      const e = NET.edges[ei], v = e.a === u ? e.b : e.a;
      if (bd + e.len < dist[v]) dist[v] = bd + e.len;
    }
  }
  return dist[b] === Infinity ? Math.hypot(x1 - x0, z1 - z0) * 1.4 : dist[b];
}
const driveTime = (x0, z0, x1, z1, mps) => roadDist(x0, z0, x1, z1) / mps + 8;

// the guide arrow that floats over whatever you're driving/walking
const arrowGeo = merge([
  baked(new THREE.ConeGeometry(0.62, 1.5, 4), 0, 0, 0.85, Math.PI/2),
  baked(BOX(0.52, 0.3, 1.4), 0, 0, -0.6),
]);
const guideArrow = new THREE.Mesh(arrowGeo, new THREE.MeshBasicMaterial({ color: 0xffd23b }));
guideArrow.visible = false; scene.add(guideArrow);
// and the pillar of light on the destination, ringed at its trigger radius
const beaconMat = new THREE.MeshBasicMaterial({ color: 0xffd23b, transparent: true, opacity: 0.2,
  side: THREE.DoubleSide, depthWrite: false });
const beacon = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 34, 18, 1, true), beaconMat);
beacon.renderOrder = 5; beacon.visible = false; scene.add(beacon);
const beaconRing = new THREE.Mesh(new THREE.TorusGeometry(1, 0.09, 8, 36).rotateX(Math.PI/2),
  new THREE.MeshBasicMaterial({ color: 0xffd23b, transparent: true, opacity: 0.85, depthWrite: false }));
beaconRing.visible = false; scene.add(beaconRing);

let MI = null;                                   // the active mission, or null
let retryGiver = null;                           // failed a job? the guide walks you back
const fmtT = s => { const t = Math.max(0, Math.ceil(s)); return (t/60|0) + ':' + String(t%60).padStart(2, '0'); };
function setTarget(x, z, r, label) { if (MI) MI.target = { x, z, r, label }; }
const atTarget = (p, tg) => tg && (p.x - tg.x)**2 + (p.z - tg.z)**2 < tg.r*tg.r;

function startMission(id, giver) {
  const def = MISSION_DEFS[id]; if (!def) return;
  retryGiver = null;
  MI = { id, def, giver, stage: 0, t: 0, timed: false, target: null, data: {} };
  giver.spr.visible = false; giver.disc.visible = false;
  banner(def.title, giver.name + ': ' + giver.line);
  def.start(MI);
}
function finishMission(won) {
  const m = MI; MI = null;
  if (m.def.cleanup) m.def.cleanup(m, won);
  m.giver.cool = won ? 8 : 2.5;                  // a failed job re-arms fast for the retry
}
function winMission(base, flavor) {
  const mult = 1 + stars*0.5, total = Math.round(base * mult);
  addCoins(total); coinSfx();
  banner('+' + total + ' COINS', (flavor || 'job done') + (stars ? ' · wanted bonus x' + mult.toFixed(1) : ''));
  finishMission(true);
}
function failMission(why) {
  banner('JOB FAILED', why + ' · head back to try again');
  const g = MI.giver;
  finishMission(false);
  retryGiver = g;                                // arrow, beacon and radar lead back
}
function missionEvent(ev) {
  if (!MI) return;
  if (ev === 'carWrecked') failMission('your ride is wrecked');
  else if (ev === 'busted') failMission('the law got you first');
  else if (ev === 'reset') failMission('that run is over');
}
function missionTarget() {
  if (MI && MI.target) return MI.target;
  if (!MI && retryGiver) return { x: retryGiver.x, z: retryGiver.z, r: 4 };
  return null;
}
function missionHUD() {
  const sub = mode === 'car' ? car.position : player.position;
  if (!MI) {
    if (retryGiver) return '<b>TRY AGAIN</b> · back to ' + retryGiver.name + ' · ' +
      Math.round(Math.hypot(retryGiver.x - sub.x, retryGiver.z - sub.z)) + 'm';
    return null;
  }
  let s = '<b>' + MI.def.title + '</b>';
  const extra = MI.def.hud && MI.def.hud(MI);
  const tg = MI.target;
  if (extra) s += ' · ' + extra;
  else if (tg) s += ' · ' + (tg.label || 'get there') + ' · ' +
    Math.round(Math.hypot(tg.x - sub.x, tg.z - sub.z)) + 'm';
  if (MI.timed) s += ' · <b style="color:' + (MI.t < 10 ? '#ff5340' : 'var(--sun)') + '">' + fmtT(MI.t) + '</b>';
  return s;
}
function updateMissions(dt, sub) {
  if (bannerT > 0) { bannerT -= dt; if (bannerT <= 0) bannerEl.classList.remove('show'); }
  if (MI) {
    if (MI.timed) {
      MI.t -= dt;
      if (MI.t <= 0) { MI.t = 0; failMission(MI.def.late || 'out of time'); }
    }
    if (MI) MI.def.update(MI, dt, sub);
  }
  updateGate(dt);
  updateSpray(dt);
  updateRoundHUD();
  let tg = MI && MI.target;
  if (!MI && retryGiver) {                       // failed: guide back to the giver
    const dx = retryGiver.x - sub.x, dz = retryGiver.z - sub.z;
    if (dx*dx + dz*dz < 144) retryGiver = null;  // close enough — the "!" takes over
    else tg = { x: retryGiver.x, z: retryGiver.z, r: 4 };
  }
  guideArrow.visible = beacon.visible = beaconRing.visible = !!tg;
  if (tg) {
    guideArrow.position.set(sub.x, (mode === 'car' ? 4.8 : 3.8) + Math.sin(markerBob*1.6)*0.22, sub.z);
    guideArrow.rotation.y = Math.atan2(tg.x - sub.x, tg.z - sub.z);
    beacon.position.set(tg.x, 17, tg.z);
    beaconMat.opacity = 0.16 + 0.08*Math.sin(markerBob*2.2);
    beaconRing.position.set(tg.x, 0.18, tg.z);
    beaconRing.scale.setScalar(tg.r * (1 + 0.06*Math.sin(markerBob*2.2)));
  }
}

// ---- the demolition crew ----
const DERBY_DOWN = ['ONE DOWN!', 'SCRAP METAL!', 'ROLLED IT!'];
function spawnDerby(m) {
  m.data.cars = [];
  const specs = [
    { type: 'truck', color: 0xd0392b, sp: 16.5 },
    { type: 'sedan', color: 0x8f4fbf, sp: 20 },
    { type: 'wagon', color: 0x2f8f4f, sp: 18 },
  ];
  specs.forEach((s, i) => {
    const a = i*2.09 + 0.8;
    const t = { type: s.type, color: s.color, col: new THREE.Color(s.color),
      x: STADIUM.cx + Math.cos(a)*STADIUM.rx*0.45, z: STADIUM.cz + Math.sin(a)*STADIUM.rz*0.45,
      yaw: rnd(0, 6.28), ei: 0, from: 0, dist: 0, baseSpeed: s.sp, cur: 0, gap: 99,
      fx: 0, fz: 1, stopping: false, waitT: 0, vx: 0, vz: 0, spin: 0, knock: 0,
    y: 0, vy: 0, pitch: 0, roll: 0, pitchV: 0, rollV: 0, rec: 0, 
      hitCooldown: 0, derby: true, dHp: 100, wrecked: false, smk: 0 };
    traffic.push(t); m.data.cars.push(t);
  });
}
function updateDerbyCar(t, dt) {
  if (t.wrecked) {                               // a smoking hulk where it died
    t.smk -= dt;
    if (t.smk <= 0) {
      t.smk = 0.16;
      emit(tmpV.set(t.x + rnd(-1, 1), 1.4, t.z + rnd(-1, 1)),
        new THREE.Vector3(rnd(-0.5, 0.5), rnd(2, 3.5), rnd(-0.5, 0.5)), 0x40424a, 1.3, 1.4, 2.6);
    }
    return;
  }
  const sub = mode === 'car' ? car.position : player.position;
  const dx = sub.x - t.x, dz = sub.z - t.z, d = Math.hypot(dx, dz) || 1;
  t.yaw = lerpAngle(t.yaw, Math.atan2(dx, dz), 1 - Math.exp(-dt*2.4));
  t.cur += (t.baseSpeed - t.cur) * Math.min(1, dt*1.7);
  const res = collideCircle(t.x + Math.sin(t.yaw)*t.cur*dt, t.z + Math.cos(t.yaw)*t.cur*dt, 1.9, colliders);
  t.x = res.x; t.z = res.z;
  t.fx = Math.sin(t.yaw); t.fz = Math.cos(t.yaw);
  if (d < 4.3 && t.cur > 6 && t.hitCooldown <= 0) {
    t.hitCooldown = 1.1;
    burst((t.x + sub.x)/2, 1.2, (t.z + sub.z)/2, 0xffe27a, 8);
    if (mode === 'car') { damageCar(7); shake = Math.min(1.6, shake + 0.5); speed *= 0.72; }
    else if (!playerRag.active) applyRagdoll(player, playerRag, dx/d, dz/d, 9);
    t.vx = -Math.sin(t.yaw)*8; t.vz = -Math.cos(t.yaw)*8;   // bounce off to wind up another pass
    t.spin = rnd(-1.5, 1.5); t.knock = 0.55;
  }
}
function derbyHit(t, impact) {
  if (t.wrecked || impact < 7) return;
  t.dHp -= impact*3.4;
  if (t.dHp <= 0) {
    t.wrecked = true; t.cur = 0;
    t.col.setHex(0x2c2e36);
    burst(t.x, 1.4, t.z, 0xff8a2b, 18); burst(t.x, 1.8, t.z, 0x40424a, 12);
    addCoins(25);
    toast(rpick(DERBY_DOWN));
    shake = Math.min(1.8, shake + 0.6);
  } else burst(t.x, 1.3, t.z, 0xffb43b, 6);
}

// ---- the yard break: orange jumpsuits with wall charges ----
// Nobody floats up a wall any more: a runner picks a wall, kneels, plants a beeping
// charge (4.5 s — a stationary, very soakable target), and if it detonates the wall
// gets a breach: a dark hole with rubble, an open exit for everyone after. Several
// walls can be blown in one round. Soak a planter and the charge is defused with them.
function spawnSoaker(m) {
  const y = PRISON.yard, lk = pickLook();
  const g = buildPerson({ skin: lk.skin.getHex(), hair: 0x2b2016, shirt: 0xe8792b,
    pants: 0xe8792b, shoe: 0x14192e, style: lk.style });
  // spawn on a ring just outside the cell block, so paths never cross the block
  const a = rnd(0, 6.28), R0 = Math.max(PRISON.block.w, PRISON.block.d)/2 + 3;
  const sx = THREE.MathUtils.clamp(y.cx + Math.cos(a)*R0, y.x0 + 2, y.x1 - 2);
  const sz = THREE.MathUtils.clamp(y.cz + Math.sin(a)*R0, y.z0 + 2, y.z1 - 2);
  g.position.set(sx, 0, sz);
  scene.add(g);
  const c = { g, state: 'run', soakT: 0, sp: rnd(4.2, 6), beepT: 0, plantT: 0, bomb: null };
  if (m.data.holes.length && Math.random() < 0.75) {
    // an existing breach is a free exit — most runners take it over planting anew
    let best = m.data.holes[0], bd = 1e9;
    for (const h of m.data.holes) {
      const hd = (h.x - sx)**2 + (h.z - sz)**2;
      if (hd < bd) { bd = hd; best = h; }
    }
    c.tx = best.x; c.tz = best.z; c.nx = best.nx; c.nz = best.nz; c.viaHole = true;
  } else {
    // radially outward to the nearest wall, dodging the gate span
    const walls = [
      { x: sx, z: y.z0, d: Math.abs(sz - y.z0), nx: 0, nz: -1 },
      { x: sx, z: y.z1, d: Math.abs(y.z1 - sz), nx: 0, nz: 1 },
      { x: y.x0, z: sz, d: Math.abs(sx - y.x0), nx: -1, nz: 0 },
      { x: y.x1, z: sz, d: Math.abs(y.x1 - sx), nx: 1, nz: 0 },
    ].sort((p, q) => p.d - q.d);
    let w = walls[0];
    if (Math.abs(w.z - y.z0) < 0.1 && Math.abs(w.x - PRISON.gate.x) < 10)
      w = { ...w, x: PRISON.gate.x + (w.x >= PRISON.gate.x ? 11 : -11) };
    c.tx = w.x; c.tz = w.z; c.nx = w.nx; c.nz = w.nz;
  }
  m.data.crew.push(c);
}
function makeBomb(x, z) {
  const b = new THREE.Group();
  const box = new THREE.Mesh(BOX(0.55, 0.4, 0.3), toon(0x2b2f38));
  box.position.y = 0.2;
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xff2b2b }));
  bulb.position.set(0, 0.48, 0);
  b.add(box, bulb); b.bulb = bulb;
  b.position.set(x, 0, z);
  scene.add(b);
  return b;
}
function blowWall(m, c) {
  boomSfx();
  burst(c.tx, 1.5, c.tz, 0xff8a2b, 22);
  burst(c.tx, 2.5, c.tz, 0x40424a, 16);
  const d2p = (player.position.x - c.tx)**2 + (player.position.z - c.tz)**2;
  shake = Math.min(2, shake + (d2p < 900 ? 1.2 : 0.5));
  // the breach: a dark hole punched through the wall line, rubble at its feet
  const grp = new THREE.Group();
  const alongX = Math.abs(c.nz) > 0.5;               // wall runs along x when the normal is z
  const breach = new THREE.Mesh(BOX(alongX ? 3.8 : 2.7, 3.4, alongX ? 2.7 : 3.8), toon(0x14192e));
  breach.position.set(0, 1.7, 0);
  grp.add(breach);
  for (let k = 0; k < 5; k++) {
    const r = new THREE.Mesh(BOX(rnd(0.4, 0.9), rnd(0.3, 0.7), rnd(0.4, 0.9)), toon(0x9aa0a8));
    r.position.set(rnd(-2, 2) + c.nx * rnd(0.5, 2), 0.25, rnd(-2, 2) + c.nz * rnd(0.5, 2));
    r.rotation.y = rnd(0, 6.28);
    grp.add(r);
  }
  grp.position.set(c.tx, 0, c.tz);
  scene.add(grp);
  m.data.holes.push({ x: c.tx, z: c.tz, nx: c.nx, nz: c.nz, grp });
  toast('THEY BLEW THE WALL!');
}
function updateSoak(m, dt) {
  const d = m.data;
  d.t -= dt;
  d.spawnT -= dt;
  if (d.spawnT <= 0 && d.crew.filter(c => c.state !== 'gone').length < 9) {
    d.spawnT = Math.max(1.2, 2.4 - (60 - d.t)*0.018);   // the break gathers pace
    spawnSoaker(m);
  }
  for (const c of d.crew) {
    if (c.state === 'gone') continue;
    const g = c.g;
    if (c.state === 'soaked') {
      c.soakT -= dt;
      g.rotation.y += dt*9;                             // soggy pirouette
      if (c.soakT <= 0) {
        if (c.bomb) { scene.remove(c.bomb); c.bomb = null; }
        scene.remove(g); c.state = 'gone';
      }
      continue;
    }
    if (c.state === 'run') {
      const dx = c.tx - g.position.x, dz = c.tz - g.position.z, dd = Math.hypot(dx, dz) || 1;
      g.position.x += dx/dd * c.sp * dt; g.position.z += dz/dd * c.sp * dt;
      g.rotation.y = Math.atan2(dx, dz);
      walkAnim(g, dt, 12, 0.8);
      if (dd < 0.9) {
        if (c.viaHole) c.state = 'escape';
        else {
          c.state = 'plant'; c.plantT = 4.5; c.beepT = 0;
          c.bomb = makeBomb(c.tx + c.nx*0.6, c.tz + c.nz*0.6);
          g.rotation.y = Math.atan2(c.nx, c.nz);        // kneels at the charge
        }
      }
    } else if (c.state === 'plant') {
      c.plantT -= dt;
      c.beepT -= dt;
      if (c.beepT <= 0) {                               // the fuse beeps faster and faster
        c.beepT = Math.max(0.12, c.plantT * 0.16);
        if (sirenCtx) tone(1250, sirenCtx.currentTime, 0.04, 0.05, 'square');
        if (c.bomb) c.bomb.bulb.material.color.setHex(
          c.bomb.bulb.material.color.getHex() === 0xff2b2b ? 0x5a1010 : 0xff2b2b);
      }
      walkAnim(g, dt, 5, 0.25);                         // fiddling with the wires
      if (c.plantT <= 0) {
        if (c.bomb) { scene.remove(c.bomb); c.bomb = null; }
        blowWall(m, c);
        c.state = 'escape';
      }
    } else {                                            // escape: out through the breach
      g.position.x += c.nx * 5 * dt; g.position.z += c.nz * 5 * dt;
      g.rotation.y = Math.atan2(c.nx, c.nz);
      walkAnim(g, dt, 13, 0.85);
      const past = (g.position.x - c.tx) * c.nx + (g.position.z - c.tz) * c.nz;
      if (past > 5) { scene.remove(g); c.state = 'gone'; d.esc++; }
    }
  }
  // Let too many through and the breakout succeeds — real stakes, not just a tally.
  if (d.esc >= 12) { failMission('the breakout succeeded'); return; }
  if (d.t <= 0) {
    d.t = 0;
    if (d.soaked >= 5) winMission(d.soaked * 22 + (d.soaked >= 12 ? 200 : d.soaked >= 8 ? 80 : 0),
      d.soaked + ' soaked · only ' + d.esc + ' got away');
    else failMission('not enough of them soaked');
  }
}
// ---- the portcullis: prison bars over the gate, raised by a button outside ----
const gateGrp = new THREE.Group();
let gateT = 0, gateOpenTgt = 0, gateHold = 0;          // 0 closed … 1 raised
const gateBlock = { minX: 1e9, maxX: 1e9, minZ: 1e9, maxZ: 1e9 };
if (PRISON.gate) {
  const W = 13;
  const barMat = toon(0x3c4048);
  const barGeo = new THREE.CylinderGeometry(0.09, 0.09, 8.4, 16);
  for (let k = 0; k <= 11; k++) {
    const b = new THREE.Mesh(barGeo, barMat);
    b.position.set(-W/2 + (W/11)*k, 4.2, 0);
    gateGrp.add(b);
  }
  for (const ry of [0.5, 8.2]) {
    const rail = new THREE.Mesh(BOX(W + 0.6, 0.44, 0.3), barMat);
    rail.position.set(0, ry, 0); gateGrp.add(rail);
  }
  gateGrp.position.set(PRISON.gate.x, 0, PRISON.gate.z);
  scene.add(gateGrp);
  // the guard who wants paying, posted just inside the bars
  { const gd = buildPerson({ skin: 0xffd90f, hair: 0x3a3f4a, shirt: 0x2f4a6b,
      pants: 0x2b3140, shoe: 0x14192e, style: 'cap' });
    gd.position.set(PRISON.gate.x + 5.5, 0, PRISON.gate.z + 3.2);
    gd.rotation.y = Math.PI * 0.85;
    scene.add(gd); PRISON.guard = gd; }
  colliders.push(gateBlock);                           // pushed at runtime — audits already ran
  setGate(0);
}
function setGate(t) {
  gateT = t;
  const g = PRISON.gate; if (!g) return;
  gateGrp.position.y = t * 7.4;                        // portcullis rises into the lintel
  if (t > 0.6) { gateBlock.minX = gateBlock.maxX = gateBlock.minZ = gateBlock.maxZ = 1e9; }
  else { gateBlock.minX = g.x - 6.6; gateBlock.maxX = g.x + 6.6;
         gateBlock.minZ = g.z - 0.9; gateBlock.maxZ = g.z + 0.9; }
}
function updateGate(dt) {
  if (!PRISON.gate) return;
  if (gateHold > 0) {
    gateHold -= dt;
    if (gateHold <= 0 && !(MI && MI.id === 'soak')) gateOpenTgt = 0;   // free roam: it closes itself
  }
  if (Math.abs(gateT - gateOpenTgt) > 0.002)
    setGate(gateT + (gateOpenTgt - gateT) * Math.min(1, dt*2.6));
}
// Inside the wall, the button does nothing — a guard leans on the bars and wants
// paying. The button outside still works, so the yard is easy to get into and
// costs you to get out of, which is the joke.
const GUARD_FEE = 25;
const inYard = (x, z) => PRISON.yard && x > PRISON.yard.x0 && x < PRISON.yard.x1 &&
                         z > PRISON.yard.z0 && z < PRISON.yard.z1;
function tryGate() {
  if (mode !== 'foot' || !PRISON.gate || playerRag.active) return false;
  const g = PRISON.gate;
  const dx = player.position.x - g.x, dz = player.position.z - g.z;
  if (dx*dx + dz*dz > 64) return false;
  if (MI && MI.id === 'soak' && MI.stage === 1) { toast('LOCKDOWN!'); return true; }
  if (inYard(player.position.x, player.position.z)) {         // the wrong side of the bars
    if (gateOpenTgt > 0.5) { gateOpenTgt = 0; gateHold = 0; return true; }
    if (coinCount < GUARD_FEE) { toast("GUARD: THAT'LL BE " + GUARD_FEE + " COINS"); return true; }
    addCoins(-GUARD_FEE); coinSfx();
    gateOpenTgt = 1; gateHold = 14;
    toast('GUARD: MUCH OBLIGED');
    return true;
  }
  if (gateOpenTgt < 0.5) { gateOpenTgt = 1; gateHold = 12; toast('THE GATE RUMBLES UP'); }
  else { gateOpenTgt = 0; gateHold = 0; }
  return true;
}

// ---- the super soaker: in hand for the round, sprays at the reticule ----
const soaker = new THREE.Group();
{
  const body = new THREE.Mesh(BOX(0.16, 0.22, 1.1), toon(0x35b24a));
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.52, 20).rotateX(Math.PI/2), toon(0xe8792b));
  tank.position.set(0, 0.25, -0.12);
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.5, 16).rotateX(Math.PI/2), toon(0xffd23b));
  nozzle.position.set(0, 0.02, 0.76);
  const grip = new THREE.Mesh(BOX(0.14, 0.32, 0.16), toon(0x2b2f38));
  grip.position.set(0, -0.25, -0.26);
  soaker.add(body, tank, nozzle, grip);
  soaker.position.set(0.42, 1.04, 0.34);               // held at the hip, pointing forward
  soaker.visible = false;
  player.add(soaker);
}
let spraying = false, sprayTick = 0, tank = 1;
function soakArm() {                                   // mousedown during the round claims the click
  if (!MI || MI.id !== 'soak' || MI.stage !== 1 || mode !== 'foot') return false;
  spraying = true;
  return true;
}
const reticleEl = document.getElementById('reticle');
const tankEl = document.getElementById('tank'), tankFill = tankEl.querySelector('i');
function updateSpray(dt) {
  const inRound = MI && MI.id === 'soak' && MI.stage === 1 && mode === 'foot';
  soaker.visible = !!inRound;
  reticleEl.style.display = inRound ? 'block' : 'none';
  tankEl.style.display = inRound ? 'block' : 'none';
  if (!inRound) { tank = 1; return; }
  // the tank: ~3.5 s of water held down, refills itself only once you let go
  const firing = spraying && !playerRag.active && tank > 0;
  if (firing) tank = Math.max(0, tank - dt/3.5);
  else if (!spraying) tank = Math.min(1, tank + dt/2.2);
  tankFill.style.width = (tank*100) + '%';
  tankFill.style.background = tank < 0.25 ? '#f0503c' : '#3fa9e8';
  if (!firing) return;
  // the stream chases the reticule: aim with the camera, the avatar turns to match
  player.rotation.y = camYaw;
  const cp = Math.cos(camPitch), sp = Math.sin(camPitch);
  const dx = Math.sin(camYaw)*cp, dy = sp, dz = Math.cos(camYaw)*cp;
  const ox = player.position.x + dx*1.2, oy = player.position.y + 1.35, oz = player.position.z + dz*1.2;
  // a long blue jet: beads sampled along a real arc — fast off the nozzle, drooping
  // with gravity toward the end of its reach
  for (let i = 0; i < 9; i++) {
    const t = rnd(0.02, 0.85);
    emit(tmpV.set(ox + dx*26*t, oy + dy*26*t - 4.9*t*t, oz + dz*26*t),
      new THREE.Vector3(dx*6 + rnd(-0.6, 0.6), dy*6 - 9.8*t + rnd(-0.4, 0.4), dz*6 + rnd(-0.6, 0.6)),
      0x4fb6f0, 0.42, 0.14, 0.4);
  }
  { // splashdown at the end of the arc
    const t = 0.85;
    emit(tmpV.set(ox + dx*26*t, Math.max(0.3, oy + dy*26*t - 4.9*t*t), oz + dz*26*t),
      new THREE.Vector3(rnd(-2, 2), rnd(1, 3), rnd(-2, 2)), 0xcfeaff, 0.5, 0.3, 1.6);
  }
  sprayTick -= dt;
  if (sprayTick > 0) return;
  sprayTick = 0.22;
  if (sirenCtx) tone(1650 + rnd(-180, 180), sirenCtx.currentTime, 0.05, 0.035, 'sine');
  const d = MI.data;
  let best = null, bd = 1e9;
  for (const c of d.crew) {
    if (c.state !== 'run' && c.state !== 'plant' && c.state !== 'escape') continue;
    const px = c.g.position.x - ox, py = (c.g.position.y + 1.1) - oy, pz = c.g.position.z - oz;
    const dist = Math.hypot(px, py, pz);
    if (dist > 22 || dist < 0.3) continue;
    if ((px*dx + py*dy + pz*dz)/dist < 0.9) continue;  // generous cone around the reticule
    if (dist < bd) { bd = dist; best = c; }
  }
  if (best) {
    if (best.bomb) { scene.remove(best.bomb); best.bomb = null; toast('DEFUSED!'); }
    best.state = 'soaked'; best.soakT = 0.55;
    burst(best.g.position.x, best.g.position.y + 1.4, best.g.position.z, 0x9adcff, 12);
    d.soaked++;
    coinSfx(); addCoins(4); chaosHit(6);
    if (d.soaked === 8) toast('KEEP IT UP!');
  }
}
// the big round clock and score, shown for the timed arena rounds
const roundEl = document.getElementById('round');
const roundClk = roundEl.querySelector('.clk'), roundSc = roundEl.querySelector('.sc');
function updateRoundHUD() {
  let t = null, s = '';
  if (MI && MI.stage === 1 && MI.id === 'feather') { t = MI.t; s = (MI.data.n || 0) + ' / 7 birds'; }
  if (MI && MI.stage === 1 && MI.id === 'soak') { t = MI.data.t; s = MI.data.soaked + ' soaked · ' + MI.data.esc + ' away'; }
  if (MI && MI.id === 'rampage') { t = MI.t; s = MI.data.n + ' / 6 launched'; }
  for (const r of RUSHES) if (r.active) { t = r.t; s = r.got + ' / ' + r.crates.length + ' crates'; }
  for (const w of WHACKS) if (w.active) { t = w.t; s = w.hits + ' hits'; }
  for (const d of DANCES) if (d.active) { t = d.w; s = d.streak + ' steps'; }
  roundEl.style.display = t === null ? 'none' : 'block';
  if (t === null) return;
  roundClk.textContent = fmtT(t);
  roundClk.classList.toggle('hot', t < 10);
  roundSc.textContent = s;
}

// ---- the ring-road circuit ----
let RING_CPS = null;
// ---- the street circuit: a lap stitched from real streets ----
// Checkpoints are graph nodes and every leg is an actual edge between two of them,
// so an AI that just steers at its next checkpoint is driving down a street rather
// than through the houses. Walk the graph greedily away from where we came, then
// close the loop back to the start.
function townCircuit() {
  if (TOWN_CPS) return TOWN_CPS;
  const ok = i => NET.nodes[i].e.some(ei => !NET.edges[ei].hw);
  let start = -1;
  for (let k = 0; k < 400 && start < 0; k++) {         // a well-connected downtown node
    const i = (prng()*NET.nodes.length)|0;
    if (NET.nodes[i].e.length >= 3 && ok(i) && Math.hypot(NET.nodes[i].x, NET.nodes[i].z) < TOWN*0.62) start = i;
  }
  if (start < 0) start = 0;
  const path = [start], seen = new Set([start]);
  let cur = start, prev = -1;
  for (let step = 0; step < 9; step++) {
    let best = -1, bs = -1e9;
    for (const ei of NET.nodes[cur].e) {
      const e = NET.edges[ei];
      if (e.hw) continue;                              // town streets only, no highway
      const to = e.a === cur ? e.b : e.a;
      if (to === prev || seen.has(to)) continue;
      const n = NET.nodes[to];
      // prefer long legs that keep turning the same way, so the lap is a loop not a line
      let s = e.len * 0.5 + Math.hypot(n.x - NET.nodes[start].x, n.z - NET.nodes[start].z) * (step < 5 ? 0.7 : -1.1);
      if (s > bs) { bs = s; best = to; }
    }
    if (best < 0) break;
    path.push(best); seen.add(best); prev = cur; cur = best;
  }
  TOWN_CPS = path.map(i => NET.nodes[i]);
  return TOWN_CPS;
}
const RACER_NAMES = ['DUKE', 'MAVIS', 'SPANNER'];
function spawnRacers(m) {
  const cps = townCircuit(), a = cps[0], b = cps[1 % cps.length];
  const hx = b.x - a.x, hz = b.z - a.z, hl = Math.hypot(hx, hz) || 1;
  const px = -hz/hl, pz = hx/hl;                       // across the start line
  m.data.racers = [];
  [[0xd0392b, 25.5], [0x7b4fa7, 24.5], [0x2f8f4f, 26]].forEach((spec, i) => {
    const off = (i - 1) * 3.4;
    const t = { type: TRAFFIC_TYPES[i+1], color: spec[0], col: new THREE.Color(spec[0]),
      x: a.x + px*off - hx/hl*4, z: a.z + pz*off - hz/hl*4, yaw: Math.atan2(hx, hz),
      ei: 0, from: 0, dist: 0, baseSpeed: spec[1], cur: 0, gap: 99, fx: 0, fz: 1,
      stopping: false, waitT: 0, vx: 0, vz: 0, spin: 0, knock: 0, hitCooldown: 0,
    y: 0, vy: 0, pitch: 0, roll: 0, pitchV: 0, rollV: 0, rec: 0, 
      racer: true, name: RACER_NAMES[i], cp: 1, lapDone: false, stuck: 0 };
    traffic.push(t); m.data.racers.push(t);
  });
}
function updateRacerCar(t, dt) {
  const cps = townCircuit();
  if (t.lapDone) { t.cur *= (1 - dt); return; }
  const tgt = cps[t.cp % cps.length];
  const dx = tgt.x - t.x, dz = tgt.z - t.z, d = Math.hypot(dx, dz) || 1;
  t.yaw = lerpAngle(t.yaw, Math.atan2(dx, dz), 1 - Math.exp(-dt*3.4));
  t.cur += (t.baseSpeed - t.cur) * Math.min(1, dt*2.2);
  const nx = t.x + Math.sin(t.yaw)*t.cur*dt, nz = t.z + Math.cos(t.yaw)*t.cur*dt;
  const res = collideCircle(nx, nz, 1.9, colliders);
  // scraping a wall bleeds speed and, if it lasts, nudges the aim past the corner
  if (res.hit) { t.cur *= 0.86; t.stuck += dt; if (t.stuck > 0.8) { t.yaw += 0.9*dt; } }
  else t.stuck = 0;
  t.x = res.x; t.z = res.z;
  t.fx = Math.sin(t.yaw); t.fz = Math.cos(t.yaw);
  if (t.cur > 1.5) hitPeopleAt(t.x, t.z, t.fx, t.fz, t.cur, 1.9);
  if (d < 16) {                                        // checkpoint reached
    t.cp++;
    if (t.cp > cps.length) t.lapDone = true;
  }
}

function ringCheckpoints() {
  if (RING_CPS) return RING_CPS;
  const ids = new Set();
  NET.edges.forEach(e => { if (e.hw) { ids.add(e.a); ids.add(e.b); } });
  let ns = [...ids].map(i => NET.nodes[i]);
  const rmax = Math.max(...ns.map(n => Math.hypot(n.x, n.z)));
  ns = ns.filter(n => Math.hypot(n.x, n.z) > rmax*0.72);   // the ring, not the spurs
  ns.sort((a, b) => Math.atan2(a.z, a.x) - Math.atan2(b.z, b.x));
  const step = ns.length / 8;
  RING_CPS = [];
  for (let k = 0; k < 8 && (k*step|0) < ns.length; k++) RING_CPS.push(ns[(k*step)|0]);
  return RING_CPS;
}

const TAXI_CHAT = ["RITA: Faster! I'm late!", 'RITA: My ex owns this street. Floor it.',
  'RITA: You always drive like this?', 'RITA: I would have walked quicker.',
  'RITA: Ooh, green light. GO GO GO.'];

const MISSION_DEFS = {
  donut: {
    needsCar: true,
    title: 'DONUT RUN', late: 'the donuts went cold',
    start(m) {
      const b = BLOCKS.find(b2 => b2.zone === 'plant');
      const n = NET.nodes[nearestNode(b.cx, b.cz)];
      m.timed = true; m.t = driveTime(m.giver.x, m.giver.z, n.x, n.z, 15);
      setTarget(n.x, n.z, 12, 'deliver to the Power Plant');
    },
    update(m, dt, sub) {
      if (atTarget(sub, m.target)) winMission(90 + Math.round(m.t*4), 'donuts still warm');
    },
  },
  taxi: {
    needsCar: true,
    title: 'FARE GAME', late: 'Rita got out and walked',
    start(m) {
      const g = m.giver;
      const cands = ENTERABLE.filter(e => {
        const d = Math.hypot(e.x - g.x, e.z - g.z);
        return d > 180 && d < 700;          // commerce is scattered now — long hauls welcome
      });
      const e = cands.length ? cands[(Math.random()*cands.length)|0] : ENTERABLE[0];
      m.data.chat = 7;
      g.g.visible = false;                       // she's in the back seat
      m.timed = true; m.t = driveTime(g.x, g.z, e.x, e.z, 12) + 6;
      setTarget(e.x + e.fx*7, e.z + e.fz*7, 10, 'drop RITA at ' + e.name + ', then stop');
    },
    update(m, dt, sub) {
      m.data.chat -= dt;
      if (m.data.chat <= 0) { m.data.chat = 9; if (mode === 'car') toast(rpick(TAXI_CHAT)); }
      if (mode === 'car' && Math.abs(speed) < 1.5 && atTarget(sub, m.target))
        winMission(60 + Math.round(m.t*3), 'five stars, probably');
    },
    cleanup(m) { m.giver.g.visible = true; },
  },
  mug: {
    title: 'COLD ONE', late: 'Lou gave up and went home',
    start(m) {
      const R = ROOMS.find(r => r.name === 'THE RUSTY MUG') || ROOMS[0];
      m.data.R = R;
      m.timed = true; m.t = driveTime(m.giver.x, m.giver.z, R.cx, R.cz, 11) + 30;
      setTarget(R.cx, R.cz, 2.8, 'walk into THE RUSTY MUG and grab a pint');
    },
    update(m, dt, sub) {
      if (m.stage === 0) {
        if (mode === 'foot' && roomHere === m.data.R && atTarget(player.position, m.target)) {
          m.stage = 1; m.t += 8;
          toast('GOT ONE! Back to Lou.'); coinSfx();
          setTarget(m.giver.x, m.giver.z, 3.6, 'get the pint back to Lou on foot');
        }
      } else if (mode === 'foot' && atTarget(player.position, m.target)) {
        winMission(110, 'still cold, somehow');
      }
    },
  },
  feather: {
    title: 'FEATHER FRENZY', late: 'the flock outlasted you',
    start(m) {
      const r = PEN.inner || CASTLE.inner;
      setPenGate(true);                                  // Mabel swings the gate open for you
      m.timed = true; m.t = driveTime(m.giver.x, m.giver.z, r.cx || (r.x0+r.x1)/2, r.cz || (r.z0+r.z1)/2, 13) + 30;
      setTarget((r.x0 + r.x1)/2, (r.z0 + r.z1)/2, 10, 'the gate is open — get into the pen on foot');
    },
    cleanup() { setPenGate(false); },                    // and shuts it again after
    update(m, dt, sub) {
      if (m.stage === 0) {
        // on foot only — this one's about the boot, not the bumper
        if (mode === 'foot' && atTarget(player.position, m.target)) {
          m.stage = 1; m.t = 60; m.data.base = chickenKicked; m.target = null;
          banner('GO!', 'kick 7 birds in 60 seconds — no car, just the boot');
        }
      } else {
        m.data.n = chickenKicked - m.data.base;
        if (m.data.n >= 7) winMission(150, 'the pen is yours');
      }
    },
    hud(m) { return m.stage ? 'kick the flock · <b>' + (m.data.n || 0) + '/7</b>' : null; },
  },
  derby: {
    needsCar: true,
    title: 'DEMOLITION DERBY', late: 'the crowd went home',
    start(m) {
      m.timed = true; m.t = driveTime(m.giver.x, m.giver.z, STADIUM.cx, STADIUM.cz, 13) + 25;
      setTarget(STADIUM.cx, STADIUM.cz, 13, 'get your car onto the infield');
    },
    update(m, dt, sub) {
      if (m.stage === 0) {
        if (mode === 'car' && atTarget(sub, m.target)) {
          m.stage = 1; m.t = 120; m.target = null;
          spawnDerby(m);
          banner('FIGHT!', 'wreck all three rigs before they wreck you');
        }
      } else {
        m.data.n = m.data.cars.filter(c => c.wrecked).length;
        if (Math.hypot(sub.x - STADIUM.cx, sub.z - STADIUM.cz) > Math.max(STADIUM.rx, STADIUM.rz) + 50)
          { failMission('you fled the arena'); return; }
        if (m.data.n >= 3) winMission(320, 'last one rolling');
      }
    },
    hud(m) { return m.stage ? 'wreck the crew · <b>' + (m.data.n || 0) + '/3</b>' : null; },
    cleanup(m) {
      if (m.data.cars) for (const t of m.data.cars) {
        const i = traffic.indexOf(t); if (i >= 0) traffic.splice(i, 1);
      }
    },
  },
  soak: {
    title: 'YARD SOAKER', late: 'the warden gave up on you',
    start(m) {
      const g = PRISON.gate;
      m.timed = true;
      m.t = driveTime(m.giver.x, m.giver.z, g.x, g.z, 13) + 30;
      setTarget(g.x, g.z - 6, 7, 'raise the gate (F) and step into the yard');
      m.data.crew = []; m.data.soaked = 0; m.data.esc = 0; m.data.holes = [];
    },
    update(m, dt, sub) {
      if (m.stage === 0) {
        // crossing into the yard on foot starts the round — and the gate drops
        const y = PRISON.yard;
        if (mode === 'foot' && player.position.x > y.x0 && player.position.x < y.x1 &&
            player.position.z > y.z0 && player.position.z < y.z1) {
          m.stage = 1; m.timed = false; m.target = null;
          m.data.t = 60; m.data.spawnT = 0.4;
          gateOpenTgt = 0; gateHold = 0;
          banner('GO!', 'hold left click to spray · soak 5+ · lose if 12 escape');
        }
      } else updateSoak(m, dt);
    },
    hud(m) { return m.stage ? 'soaked <b>' + m.data.soaked + '</b> · escaped ' + m.data.esc : null; },
    cleanup(m, won) {
      if (m.data.crew) for (const c of m.data.crew) {
        if (c.bomb) scene.remove(c.bomb);
        if (c.state !== 'gone') scene.remove(c.g);
      }
      if (m.data.holes) for (const h of m.data.holes) scene.remove(h.grp);   // walls repaired between rounds
      spraying = false;
      if (m.stage === 1) {                       // the warden walks you out; bars come down
        const g = PRISON.gate;
        player.position.set(g.x, 0, g.z - 7);
        player.rotation.y = Math.PI; camYaw = Math.PI;
        gateOpenTgt = 0; gateHold = 0; setGate(0);
      }
    },
  },
  street: {
    needsCar: true,
    title: 'BACK ALLEY DASH', late: 'the grid left without you',
    start(m) {
      const cps = townCircuit();
      m.timed = true; m.t = driveTime(m.giver.x, m.giver.z, cps[0].x, cps[0].z, 13) + 20;
      m.data.cp = 0; m.data.place = 1;
      setTarget(cps[0].x, cps[0].z, 15, 'get to the start line');
    },
    update(m, dt, sub) {
      const cps = townCircuit();
      if (m.stage === 0) {
        if (mode === 'car' && atTarget(sub, m.target)) {
          m.stage = 1; m.timed = false;
          m.data.cp = 1;
          spawnRacers(m);
          setTarget(cps[1 % cps.length].x, cps[1 % cps.length].z, 15, null);
          banner('GREEN LIGHT!', 'three rivals · ' + cps.length + ' checkpoints · first one home wins');
        }
        return;
      }
      if (mode !== 'car') { failMission('you left the car'); return; }
      // your place is however many rivals are further round the lap than you
      let ahead = 0;
      for (const r of m.data.racers) if (r.lapDone || r.cp > m.data.cp) ahead++;
      m.data.place = ahead + 1;
      if (atTarget(sub, m.target)) {
        m.data.cp++;
        coinSfx();
        if (m.data.cp > cps.length) {
          const p = m.data.place;
          if (p === 1) winMission(400, 'FIRST — you beat the lot of them');
          else winMission(140 - (p-1)*40, p === 2 ? 'second by a nose' : 'third · at least you finished');
          return;
        }
        const n = cps[m.data.cp % cps.length];
        setTarget(n.x, n.z, 15, null);
      }
      // everyone home before you and the race is over
      if (m.data.racers.every(r => r.lapDone)) { failMission('all three beat you home'); return; }
    },
    hud(m) {
      if (!m.stage) return null;
      const cps = townCircuit(), sub = car.position, tg = m.target;
      const ord = ['1st', '2nd', '3rd', '4th'][m.data.place - 1] || '4th';
      return '<b>' + ord + '</b> · checkpoint <b>' + Math.min(m.data.cp, cps.length) + '/' + cps.length +
        '</b> · ' + Math.round(Math.hypot(tg.x - sub.x, tg.z - sub.z)) + 'm';
    },
    cleanup(m) {
      if (m.data.racers) for (const t of m.data.racers) {
        const i = traffic.indexOf(t); if (i >= 0) traffic.splice(i, 1);
      }
    },
  },
  race: {
    needsCar: true,
    title: 'RING RUSH',
    start(m) {
      const cps = ringCheckpoints();
      let bi = 0, bd = Infinity;
      cps.forEach((c, i) => { const d = Math.hypot(c.x - m.giver.x, c.z - m.giver.z);
        if (d < bd) { bd = d; bi = i; } });
      let per = 0;
      for (let k = 0; k < cps.length; k++) {
        const a = cps[k], b = cps[(k + 1) % cps.length];
        per += Math.hypot(b.x - a.x, b.z - a.z);
      }
      m.data.i = bi; m.data.count = 0; m.data.lapT = 0;
      m.data.par = per/22 + 5;
      setTarget(cps[bi].x, cps[bi].z, 20, 'get to the ring road');
    },
    update(m, dt, sub) {
      const cps = ringCheckpoints();
      if (m.stage === 1) m.data.lapT += dt;
      if (!atTarget(sub, m.target)) return;
      if (m.stage === 0) {
        m.stage = 1;
        banner('GO!', 'one lap · beat ' + fmtT(m.data.par));
      } else {
        m.data.count++;
        coinSfx();
        if (m.data.count >= cps.length) {         // back where the lap began
          const t = m.data.lapT, par = m.data.par, best = m.def.best;
          m.def.best = best ? Math.min(best, t) : t;
          const nb = !best || t < best ? ' · NEW BEST' : '';
          if (t <= par) winMission(200 + Math.min(400, Math.round((par - t)*6)), 'lap ' + fmtT(t) + nb);
          else winMission(50, 'lap ' + fmtT(t) + ' · over par' + nb);
          return;
        }
      }
      m.data.i = (m.data.i + 1) % cps.length;
      setTarget(cps[m.data.i].x, cps[m.data.i].z, 20, null);
    },
    hud(m) {
      if (!m.stage) return null;
      const sub = mode === 'car' ? car.position : player.position;
      const tg = m.target;
      return 'checkpoint <b>' + (m.data.count + 1) + '/' + ringCheckpoints().length + '</b> · ' +
        Math.round(Math.hypot(tg.x - sub.x, tg.z - sub.z)) + 'm · lap ' + fmtT(m.data.lapT);
    },
  },
  getaway: {
    needsCar: true,
    title: 'THE GETAWAY', late: 'the buyer walked',
    start(m) {
      const g = m.giver;
      const cands = ENTERABLE.filter(e => Math.hypot(e.x - g.x, e.z - g.z) > 260);
      const e = cands.length ? cands[(Math.random()*cands.length)|0] : ENTERABLE[0];
      // the law already knows the bag is moving: three stars on the spot, and the
      // wanted bonus means delivering hot is the whole payday
      heat = Math.max(heat, STAR_AT[3] * 1.05);
      m.timed = true; m.t = driveTime(g.x, g.z, e.x, e.z, 13) + 8;
      setTarget(e.x + e.fx*7, e.z + e.fz*7, 11, 'drop the bag at ' + e.name);
    },
    update(m, dt, sub) {
      heat = Math.max(heat, STAR_AT[1] + 2);   // no lying low — the chase runs to the door
      if (atTarget(sub, m.target)) winMission(150, 'the bag is theirs');
    },
  },
  rampage: {
    needsCar: true,
    title: 'SCRAP RUN', late: 'the yard stays empty',
    start(m) {
      m.data.n = 0;
      m.timed = true; m.t = 80;
      banner('SCRAP RUN', 'send 6 cars flying — real hits, over 14 mph');
    },
    hud: m => '<b>' + m.data.n + ' / 6</b> cars launched',
    update(m) {
      if (m.data.n >= 6) winMission(280, 'a yard full of scrap');
    },
  },
  fairjob: {
    title: 'RIDE INSPECTOR', late: 'report overdue',
    start(m) {
      m.data.rode = { carousel: 0, coaster: 0, bumper: 0 };
      m.timed = true; m.t = 210;
    },
    hud(m) {
      const r = m.data.rode, mk = k => r[k] >= 6 ? '✓' : '…';
      return 'carousel ' + mk('carousel') + ' · coaster ' + mk('coaster') + ' · bumpers ' + mk('bumper');
    },
    update(m, dt, sub) {
      const r = m.data.rode;
      if (riding) r[riding.kind] = (r[riding.kind] || 0) + dt;
      if (r.carousel >= 6 && r.coaster >= 6 && r.bumper >= 6) {
        winMission(240, 'all three rides pass'); return;
      }
      // the arrow walks the inspection: aim at the nearest ride still unridden
      const need = FAIR.find(R => (r[R.kind] || 0) < 6);
      if (need && (!m.target || m.target.x !== need.x || m.target.z !== need.z))
        setTarget(need.x, need.z, 9, 'ride the ' + need.label + ' (6 s aboard)');
    },
  },
};

// =================================================================
//  INTERIORS
//  Rooms are modelled in place: makeShop and fillEvergreen build those buildings as
//  shells with a doorway cut in the front wall, so an interior is just part of the
//  town. Walking in is walking — there is no mode, no teleport and no transition.
//  What stops you leaving through a wall is the shell's own colliders: WALL_T thick,
//  which with collideCircle's 0.75 m probe gives a 2.3 m overlap band against a
//  worst-case 0.6 m step (RUN * the 0.05 s dt clamp), so a run cannot skip it.
// =================================================================
const DOOR_OPEN = -1.55;                                 // swings outward, away from the building

// Mid-room height and modest intensity: hung just under the ceiling at 62 it blew
// the whole top half of every room out to white (and the bloom pass hazed it).
const roomLight = new THREE.PointLight(0xfff2d0, 26, 34, 1.8);
roomLight.visible = false; scene.add(roomLight);

// Exterior doors. With every shop enterable there are dozens of leaves, so they are
// two InstancedMeshes (leaf, knob) rather than a hinge Group each — a swinging
// door is just its instance matrix recomputed. The unit leaf has its hinge
// edge at the origin; per-door width/height ride in the instance scale.
const DOOR_MAT = new THREE.MeshToonMaterial({ color: 0x8c4a2f, gradientMap: RAMP });
const doorLeafG = BOX(1, 1, 0.16).translate(0.5, 0.5, 0);
const doorLeaf = instanced(doorLeafG, DOOR_MAT, ENTERABLE.length);
const doorKnob = instanced(new THREE.SphereGeometry(0.1, 16, 12), toon(0xc9a24b), ENTERABLE.length, false);
scene.add(doorLeaf, doorKnob);
const hingeM = new THREE.Matrix4(), knobLocal = new THREE.Matrix4();
function setDoorMatrix(i) {
  const e = ENTERABLE[i];
  dummy.position.set(e.hx, 0, e.hz);
  dummy.rotation.set(0, e.yaw + e.open*DOOR_OPEN, 0);
  dummy.scale.set(1, 1, 1); dummy.updateMatrix();
  hingeM.copy(dummy.matrix);
  dummy.scale.set(e.w, e.h, 1); dummy.updateMatrix();
  doorLeaf.setMatrixAt(i, dummy.matrix);
  knobLocal.makeTranslation(e.w - 0.28, e.h*0.5, 0.16);
  doorKnob.setMatrixAt(i, partM.multiplyMatrices(hingeM, knobLocal));
}
ENTERABLE.forEach((e, i) => {
  e.yaw = Math.atan2(e.fx, e.fz);
  if (!e.room) e.room = ROOMS.find(r => r.name === e.name) || null;
  if (e.room) e.room.door = e;                  // the camera needs to know where the hole is
  e.hx = e.x - Math.cos(e.yaw)*e.w/2 + e.fx*e.off;   // hinge: the leaf's left edge
  e.hz = e.z + Math.sin(e.yaw)*e.w/2 + e.fz*e.off;
  e.open = 0; e.swing = 0;
  setDoorMatrix(i);
  // A shut leaf plugs the doorway gap. Parked far away rather than removed, so the
  // collider list stays a fixed set of boxes.
  e.block = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  colliders.push(e.block);
});
doorLeaf.count = doorKnob.count = ENTERABLE.length;
doorLeaf.instanceMatrix.needsUpdate = true;
doorKnob.instanceMatrix.needsUpdate = true;
function setDoorBlock(e) {
  if (e.open > 0.35 || !e.room) { e.block.minX = e.block.maxX = 1e9; e.block.minZ = e.block.maxZ = 1e9; return; }
  const half = e.w/2 + 0.1, t = 0.5;
  e.block.minX = e.x - (e.fz ? half : t); e.block.maxX = e.x + (e.fz ? half : t);
  e.block.minZ = e.z - (e.fz ? t : half); e.block.maxZ = e.z + (e.fz ? t : half);
}
for (const e of ENTERABLE) setDoorBlock(e);

// Self-check, in the spirit of the road audit. A doorway that doesn't line up with its
// room, or a room with no way in, is the failure mode that matters here. Must print {}.
{
  const bad = {};
  let who = '';
  const flag = k => bad[k] = (bad[k] || []).concat(who);
  for (const e of ENTERABLE) {
    const R = e.room;
    who = e.name;
    if (!R) { flag('door with no room'); continue; }
    const I = R.inner;
    if (I.x1 - I.x0 < 3 || I.z1 - I.z0 < 3) flag('room too small to stand in');
    // the doorway must sit on the room's own door face, centred within its span
    const onFace = R.fz ? Math.abs(e.z - (R.fz < 0 ? I.z0 : I.z1)) < WALL_T + 0.6
                        : Math.abs(e.x - (R.fx < 0 ? I.x0 : I.x1)) < WALL_T + 0.6;
    if (!onFace) flag('door not on the room wall');
    // the doorway is slid along the frontage to dodge neighbours, so it need not be
    // centred — but it must still fit entirely within that wall
    const lateral = R.fz ? Math.abs(e.x - R.cx) : Math.abs(e.z - R.cz);
    const halfFace = R.fz ? (I.x1 - I.x0)/2 : (I.z1 - I.z0)/2;
    if (lateral + R.dw/2 > halfFace) flag('doorway runs off the wall');
    if (R.dw < 1.6 + 0.1) flag('doorway too narrow to walk through');
    // and the gap must actually reach open ground outside, not another collider
    const ox = e.x + e.fx*2.2, oz = e.z + e.fz*2.2;
    if (pointBlocked(ox, oz, 0.4)) flag('doorway blocked from outside');
    // and nothing foreign may stand inside the room. A neighbour's collider in here
    // doesn't just block you — collideCircle resolves to its nearest face and shoves
    // you out through your own wall.
    const own = new Set(R.walls); own.add(e.block);
    if (colliders.some(c => !own.has(c) && c.maxX > I.x0 && c.minX < I.x1 &&
                                          c.maxZ > I.z0 && c.minZ < I.z1))
      flag('something standing inside the room');
  }
  console.log(`interiors: ${ROOMS.length} rooms, ${ENTERABLE.length} doors ·`, JSON.stringify(bad));
}

function updateDoors(dt) {
  let moved = false;
  for (let i = 0; i < ENTERABLE.length; i++) {
    const e = ENTERABLE[i];
    if (e.open === e.swing) continue;
    e.open += (e.swing - e.open) * Math.min(1, dt*7);
    if (Math.abs(e.swing - e.open) < 0.004) e.open = e.swing;
    setDoorMatrix(i); setDoorBlock(e); moved = true;
  }
  if (moved) {
    doorLeaf.instanceMatrix.needsUpdate = true;
    doorKnob.instanceMatrix.needsUpdate = true;
  }
}
// the door you're standing at, from either side
function nearestDoor() {
  if (mode !== 'foot' || playerRag.active) return null;
  let best = null, bd = 4.6*4.6;
  for (const e of ENTERABLE) {
    const dx = player.position.x - e.x, dz = player.position.z - e.z, d2 = dx*dx + dz*dz;
    if (d2 > bd) continue;
    bd = d2; best = e;
  }
  return best;
}
// F now only works the door. Walking through it is just walking.
function tryDoor() {
  const e = nearestDoor();
  if (!e) return false;
  e.swing = e.swing > 0.5 ? 0 : 1;
  doorSfx(e.swing > 0.5);
  return true;
}
const roomOf = (x, z) => {
  for (const R of ROOMS)
    if (x > R.inner.x0 && x < R.inner.x1 && z > R.inner.z0 && z < R.inner.z1) return R;
  return null;
};
// How far past the threshold you are, 0 outside to 1 a couple of metres in. The camera
// rides this so the pull-in is a move rather than a cut.
let roomHere = null, roomT = 0, roomCross = 0;
function updateRoomState(dt) {
  const R = roomOf(player.position.x, player.position.z);
  if (R) roomHere = R;
  let target = 0;
  if (roomHere) {
    // depth measured inward along the door normal, so standing in the doorway reads as 0
    const face = roomHere.fz ? (roomHere.fz < 0 ? roomHere.inner.z0 : roomHere.inner.z1)
                             : (roomHere.fx < 0 ? roomHere.inner.x0 : roomHere.inner.x1);
    const p = roomHere.fz ? player.position.z : player.position.x;
    const depth = (p - face) * (roomHere.fz || roomHere.fx) * -1;
    target = R ? THREE.MathUtils.clamp(depth / 2.6, 0, 1) : 0;
  }
  roomCross = Math.min(1, Math.abs(target - roomT) * 3);
  roomT += (target - roomT) * Math.min(1, dt*6);
  if (roomT < 0.002 && !R) { roomT = 0; roomHere = null; }

  // one lamp, lit for whichever room you are in or near, so an interior reads as lit
  // from outside through the open door
  let near = null, nd = 26*26;
  for (const Rm of ROOMS) {
    const dx = Rm.cx - player.position.x, dz = Rm.cz - player.position.z, d2 = dx*dx + dz*dz;
    if (d2 < nd) { nd = d2; near = Rm; }
  }
  roomLight.visible = !!near;
  if (near) roomLight.position.set(near.cx, CEIL_H * 0.52, near.cz);
}
// Inside, the room is a known box, so instead of clamping each axis independently — which
// can slide the camera sideways behind a wall — walk the sight line from the player out
// toward where the chase camera wants to be and stop at the boundary. The camera therefore
// stays inside the room *and* stays on an unobstructed line to the player.
function clampCameraToRoom(desired) {
  if (!roomHere || roomT <= 0.001) return;
  const R = roomHere, I = R.inner, m = 0.4;
  const ox = player.position.x, oy = player.position.y + 1.7, oz = player.position.z;
  const dx = desired.x - ox, dy = desired.y - oy, dz = desired.z - oz;
  const door = R.door;
  const onZ = !!R.fz;                                    // which wall the doorway is in
  const face = onZ ? (R.fz < 0 ? I.z0 + m : I.z1 - m) : (R.fx < 0 ? I.x0 + m : I.x1 - m);
  // A doorway is a hole, not a wall: if the sight line leaves through it, let the camera
  // sit outside and look in — which is what a chase camera should do in a shallow room.
  const throughDoor = a => {
    if (!door || oy + dy*a > door.h - 0.15) return false;
    const lat = onZ ? ox + dx*a : oz + dz*a;
    return Math.abs(lat - (onZ ? door.x : door.z)) < R.dw/2 - 0.25;
  };
  let t = 1;
  const lim = (o, d, lo, hi, isDoorAxis) => {
    if (Math.abs(d) < 1e-6) return;
    const bound = d > 0 ? hi : lo;
    const a = (bound - o) / d;
    if (a < 0 || a >= t) return;
    if (isDoorAxis && Math.abs(bound - face) < 1e-6 && throughDoor(a)) return;
    t = a;
  };
  lim(ox, dx, I.x0 + m, I.x1 - m, !onZ);
  lim(oz, dz, I.z0 + m, I.z1 - m, onZ);
  lim(oy, dy, 0.9, CEIL_H - 0.4);
  desired.set(ox + dx*t, oy + dy*t, oz + dz*t);
}

// Open the run in the car, parked on the street by a store — behind the wheel and ready
// to drive, rather than on foot at the storefront. The spawn is still chosen next to the
// opening door (see SPAWN), so you start right outside a shop, just already in the car.
{
  car.position.set(SPAWN.x, surfaceY(SPAWN.x, SPAWN.z), SPAWN.z);
  heading = SPAWN.heading; car.rotation.set(0, heading, 0);
  mode = 'car'; player.visible = false; rider.visible = true;
  camYaw = SPAWN.heading; camPitch = -0.14; camSettled = false;
}

// =================================================================
//  CAMERA
// =================================================================
function lerpAngle(a, b, t) { let d = ((b-a+Math.PI) % (Math.PI*2)) - Math.PI; if (d < -Math.PI) d += Math.PI*2; return a + d*t; }
const camTarget = new THREE.Vector3(), desired = new THREE.Vector3();
function updateCamera(dt, now) {
  if (mapView) {                                  // pull way back and look straight down
    const s2 = mode === 'car' ? car.position : player.position;
    scene.fog = null;                             // distance fog would grey the whole town out
    // a 0.4 near plane leaves no depth precision at 1200 m: the road paint, pads and
    // lawns (6–20 mm apart) z-fight into scribbles. Pull the near plane way in — the
    // whole town is 500+ m from the camera up here, so nothing is lost.
    camera.near = 250;
    camera.position.lerp(desired.set(s2.x, 1180, s2.z + 400), Math.min(1, dt*3));
    camera.lookAt(camTarget.set(s2.x, 0, s2.z));
    camera.fov += (58 - camera.fov) * Math.min(1, dt*4);
    camera.updateProjectionMatrix();
    return;
  }
  // Up in the plane the camera is high and looking at ground hundreds of metres off, so
  // (like the map) pull the near plane in with altitude for better depth precision — the
  // chase cam sits ~17 m back, so there's no risk of clipping the plane. On foot/in a car
  // the default 0.4 stays.
  const wantNear = mode === 'plane'
    ? THREE.MathUtils.clamp(plane.position.y * 0.06, 0.4, 12)
    : 0.4;
  if (camera.near !== wantNear) { camera.near = wantNear; camera.updateProjectionMatrix(); }
  scene.fog = townFog;
  if (riding) {
    // First person, straight from the seat. The mouse still looks around, added on top
    // of whichever way the ride is pointing, so you can watch the fair go past.
    const s2 = rideSeat(riding);
    camera.position.set(s2.x, s2.y, s2.z);
    camera.fov += (72 - camera.fov) * Math.min(1, dt*4);   // a touch wide, for the speed
    camera.updateProjectionMatrix();
    const yaw = s2.yaw + camYaw, pitch = THREE.MathUtils.clamp(camPitch, -0.9, 0.7);
    camera.lookAt(camTarget.set(s2.x + Math.sin(yaw)*Math.cos(pitch)*10,
                                s2.y + Math.sin(pitch)*10,
                                s2.z + Math.cos(yaw)*Math.cos(pitch)*10));
    return;
  }
  const inCar = mode === 'car';
  const inPlane = mode === 'plane';
  const subject = inPlane ? plane.position : inCar ? car.position : player.position;
  const eye = inPlane ? 3.0 : inCar ? 2.0 : 1.7;
  // pull in as you step inside, so a room doesn't put the camera out in the street
  const planeDists = [17, 26, 11];
  // a plane flying over town keeps its own position on the player (for the radar/coins),
  // which would otherwise trip the "you walked into a shop" room camera every time you
  // passed a signed building. Ignore rooms entirely while flying — the view stays put.
  const rt = inPlane ? 0 : roomT, rc = inPlane ? 0 : roomCross;
  let dist = THREE.MathUtils.lerp((inPlane ? planeDists : inCar ? carDists : footDists)[camIdx], 3.2, rt);
  dist += inPlane ? planeSpeed/PLANE_MAX * 4 : Math.abs(speed)/MAX_SPEED * 2.4 * (inCar ? 1 : 0);
  // swing back behind whatever you're piloting when you stop steering the camera
  if (inCar && Math.abs(speed) > 3 && now - lastMouse > 1100)
    camYaw = lerpAngle(camYaw, heading, 1 - Math.exp(-dt*2.4));
  if (inPlane && now - lastMouse > 900)
    camYaw = lerpAngle(camYaw, planeHeading, 1 - Math.exp(-dt*2.0));
  const cp = Math.cos(camPitch), sp = Math.sin(camPitch);
  const dx = Math.sin(camYaw)*cp, dy = sp, dz = Math.cos(camYaw)*cp;
  desired.set(subject.x - dx*dist, subject.y + eye - dy*dist, subject.z - dz*dist);
  if (!inPlane) clampCameraToRoom(desired);
  if (desired.y < 1.0) desired.y = 1.0;
  camera.position.lerp(desired, camSettled ? Math.min(1, dt*(9 + 30*rc)) : 1);
  camSettled = true;
  if (shake > 0) {
    shake = Math.max(0, shake - dt*2.6);
    const s = shake*0.55;
    camera.position.x += rnd(-s,s); camera.position.y += rnd(-s,s); camera.position.z += rnd(-s,s);
  }
  camTarget.set(subject.x + dx*2, subject.y + eye + dy*2, subject.z + dz*2);
  camera.lookAt(camTarget);
  const targetFov = 60 + (inPlane ? planeSpeed/PLANE_MAX*13 : inCar ? Math.abs(speed)/MAX_SPEED*11 : 0);
  camera.fov += (targetFov - camera.fov) * Math.min(1, dt*4);
  camera.updateProjectionMatrix();
}

// =================================================================
//  HUD
// =================================================================
{ // portrait: a little cartoon face
  const g = document.querySelector('#portrait canvas').getContext('2d');
  g.fillStyle = '#63b8ec'; g.fillRect(0,0,128,128);
  g.fillStyle = '#ffd90f'; g.beginPath(); g.arc(64,74,42,0,7); g.fill();
  g.strokeStyle = '#14192e'; g.lineWidth = 5; g.stroke();
  for (const ex of [50, 78]) {
    g.fillStyle = '#fff'; g.beginPath(); g.arc(ex,58,15,0,7); g.fill();
    g.lineWidth = 4; g.strokeStyle = '#14192e'; g.stroke();
    g.fillStyle = '#14192e'; g.beginPath(); g.arc(ex+2,60,5.5,0,7); g.fill();
  }
  g.strokeStyle = '#14192e'; g.lineWidth = 5; g.lineCap = 'round';
  g.beginPath(); g.arc(64, 88, 16, 0.25, Math.PI-0.25); g.stroke();
  g.beginPath(); g.arc(52, 26, 12, Math.PI, 0); g.stroke();
  g.beginPath(); g.arc(76, 26, 12, Math.PI, 0); g.stroke();
}
const speedEl = document.querySelector('#speedo .val');
const healthEl = document.querySelector('#health i');
const promptEl = document.getElementById('prompt');
const chaosEl = document.getElementById('chaos');
const starsEl = document.getElementById('stars');
const comboEl = document.getElementById('combo');
const comboM = comboEl.querySelector('.m'), comboP = comboEl.querySelector('.p');
const comboBar = comboEl.querySelector('.bar i');
let shownScore = -1, shownStars = -1;
const objEl = document.getElementById('objective');
const rd = document.querySelector('#radar canvas').getContext('2d');
function updateHUD(dt) {
  speedEl.textContent = mode === 'car' ? Math.round(Math.abs(speed)*1.7)
                      : mode === 'plane' ? Math.round(planeSpeed*1.7) : '—';
  healthEl.style.width = carHealth + '%';
  healthEl.style.background = carHealth > 50 ? '#5ed85e' : carHealth > 20 ? '#ffd23b' : '#f0503c';

  if (mode === 'foot' && !playerRag.active) {
    const gp = PRISON.gate;
    const nearGate = gp && (player.position.x - gp.x)**2 + (player.position.z - gp.z)**2 < 64;
    const door = nearestDoor();
    if (nearGate && !(MI && MI.id === 'soak' && MI.stage === 1)) {
      promptEl.style.display = 'block';
      promptEl.innerHTML = gateT > 0.5 ? 'Press <b>F</b> to lower the gate'
        : inYard(player.position.x, player.position.z)
          ? `Press <b>F</b> to pay the guard <b>${GUARD_FEE}</b> coins`
          : 'Press <b>F</b> to raise the gate';
    }
    else if (door) { promptEl.style.display='block';
      promptEl.innerHTML = door.swing > 0.5 ? 'Press <b>F</b> to close the door'
                                            : `Press <b>F</b> to open ${door.name}`; }
    else if (riding) { promptEl.style.display='block'; promptEl.innerHTML = 'Press <b>F</b> to get off'; }
    else if (nearRide()) { const nr = nearRide(); promptEl.style.display='block';
      promptEl.innerHTML = nr.waitFor
        ? 'The <b>MAPLE MOUSE</b> is out on the track\u2026'
        : 'Press <b>F</b> to ride the <b>' + nr.label + '</b>'; }
    else if (PINTS.some(p => p.state === 'slide')) { promptEl.style.display='block'; promptEl.innerHTML = '<b>F</b>! stop it on the gold mat'; }
    else if (nearBowlTee()) { promptEl.style.display='block'; promptEl.innerHTML = 'Press <b>F</b> to bowl'; }
    else if (nearPuttBall()) { promptEl.style.display='block'; promptEl.innerHTML = '<b>R-click</b> to putt'; }
    else if (nearGameTee(RUSHES)) { promptEl.style.display='block'; promptEl.innerHTML = 'Press <b>F</b> to start CRATE RUSH'; }
    else if (nearGameTee(WHACKS)) { promptEl.style.display='block'; promptEl.innerHTML = 'Press <b>F</b> for WHACK-A-CABINET'; }
    else if (nearGameTee(DANCES)) { promptEl.style.display='block'; promptEl.innerHTML = 'Press <b>F</b> to hit the dance floor'; }
    else if (nearGameTee(HEISTS)) { promptEl.style.display='block'; promptEl.innerHTML = 'Press <b>F</b> to case the museum'; }
    else if (nearGameTee(OWLS)) { promptEl.style.display='block'; promptEl.innerHTML = 'Press <b>F</b> to seek initiation'; }
    else if (KOIS.some(K => Math.hypot((K.A.x + K.B.x)/2 - player.position.x, (K.A.z + K.B.z)/2 - player.position.z) < K.len/2 + 1.6))
      { promptEl.style.display='block'; promptEl.innerHTML = 'Press <b>F</b> to grab a plate — gold pays best'; }
    else if (PINTS.some(p => p.state === 'idle' && Math.hypot(p.A.x - player.position.x, p.A.z - player.position.z) < 2.2))
      { promptEl.style.display='block'; promptEl.innerHTML = 'Press <b>F</b> to slide a pint'; }
    else if (nearPlane()) { promptEl.style.display='block'; promptEl.innerHTML = 'Press <b>F</b> to fly the plane'; }
    else if (nearestJackable()) { promptEl.style.display='block'; promptEl.innerHTML = 'Press <b>F</b> to borrow this car'; }
    else if (car.position.distanceTo(player.position) < 7) { promptEl.style.display='block'; promptEl.innerHTML = 'Press <b>F</b> to get in'; }
    else promptEl.style.display = 'none';
  } else if (mode === 'plane') {
    promptEl.style.display = 'block';
    const alt = Math.max(0, Math.round(plane.position.y));
    promptEl.innerHTML = 'ALT <b>' + alt + 'm</b> · land &amp; slow, then <b>F</b> to hop out';
  } else promptEl.style.display = 'none';

  if (shownScore !== chaosScore) {
    shownScore = chaosScore;
    chaosEl.innerHTML = chaosScore.toLocaleString() + ' <small>CHAOS</small>';
  }
  if (shownStars !== stars) {
    shownStars = stars;
    starsEl.textContent = '\u2605'.repeat(stars);
    starsEl.style.opacity = stars ? '1' : '0';
  }
  if (comboT > 0) {
    comboEl.style.opacity = '1';
    comboM.textContent = 'x' + comboMult;
    comboP.textContent = Math.round(comboPts);
    comboBar.style.width = (stars ? 1 : comboT / COMBO_HOLD) * 100 + '%';
    comboBar.style.background = stars ? '#ff3b3b' : 'var(--sun)';
  } else comboEl.style.opacity = '0';

  if (toastT > 0) { toastT -= dt; if (toastT <= 0) toastEl.classList.remove('show'); }

  const left = coins.filter(c => !c.got).length;
  objEl.innerHTML = missionHUD() || (stars
    ? `<b>WANTED</b> · lose them to bank your combo`
    : (comboT > 0 ? 'Keep it going · <b>x' + comboMult + '</b>'
                  : `Cause chaos · <b>${coins.length-left}/${coins.length}</b> coins`));

  // radar
  const W = 154, R = W/2, view = 190, sc = R/view;
  const px = mode==='car' ? car.position.x : player.position.x;
  const pz = mode==='car' ? car.position.z : player.position.z;
  const hd = mode==='car' ? heading : player.rotation.y;
  rd.clearRect(0,0,W,W);
  rd.save(); rd.beginPath(); rd.arc(R,R,R,0,7); rd.clip();
  rd.fillStyle = '#79c46a'; rd.fillRect(0,0,W,W);
  rd.translate(R,R); rd.rotate(-hd);
  rd.strokeStyle = '#5b5570'; rd.lineCap = 'round';
  for (const st of STREETS) {
    const ax=(st.ax-px)*sc, az=(st.az-pz)*sc, bx=(st.bx-px)*sc, bz=(st.bz-pz)*sc;
    if (Math.min(ax,bx) > R || Math.max(ax,bx) < -R || Math.min(az,bz) > R || Math.max(az,bz) < -R) continue;
    rd.lineWidth = st.w*2*sc;
    rd.beginPath(); rd.moveTo(ax, az); rd.lineTo(bx, bz); rd.stroke();
  }
  rd.strokeStyle = '#3f7fc4'; rd.lineWidth = RIVER_HW*2*sc;   // the river
  rd.beginPath();
  for (let k = 0; k <= 24; k++) { const wx = px - 260 + k*22;
    const p = ((wx-px)*sc); const q = ((riverZ(wx)-pz)*sc);
    k ? rd.lineTo(p, q) : rd.moveTo(p, q); }
  rd.stroke();
  rd.fillStyle = 'rgba(70,80,110,.65)';
  for (const b of mapBoxes) {
    const bx = (b.x-px)*sc, bz = (b.z-pz)*sc;
    if (Math.abs(bx) > R+20 || Math.abs(bz) > R+20) continue;
    rd.fillRect(bx-b.w*sc/2, bz-b.d*sc/2, Math.max(2,b.w*sc), Math.max(2,b.d*sc));
  }
  rd.fillStyle = '#ffd23b';
  for (const c of coins) { if (c.got) continue;
    const bx=(c.x-px)*sc, bz=(c.z-pz)*sc;
    if (bx*bx+bz*bz < R*R) { rd.beginPath(); rd.arc(bx,bz,2.2,0,7); rd.fill(); } }
  rd.fillStyle = '#3fa9d8';
  for (const t of traffic) { const bx=(t.x-px)*sc, bz=(t.z-pz)*sc;
    if (bx*bx+bz*bz < R*R) rd.fillRect(bx-1.5, bz-1.5, 3, 3); }
  // ? crates: little wooden diamonds, only the unbroken ones
  rd.fillStyle = '#c98a3d'; rd.strokeStyle = '#5a3d1e'; rd.lineWidth = 1;
  for (const c of crates) { if (c.gone) continue;
    const bx=(c.x-px)*sc, bz=(c.z-pz)*sc;
    if (bx*bx+bz*bz < R*R) {
      rd.beginPath(); rd.moveTo(bx, bz-3); rd.lineTo(bx+3, bz); rd.lineTo(bx, bz+3); rd.lineTo(bx-3, bz);
      rd.closePath(); rd.fill(); rd.stroke();
    } }
  // the fair: a purple dot per ride in range, and the site clamped to the rim as a
  // lead when it's off the radar — the one landmark worth a standing signpost
  rd.fillStyle = '#a55fd6'; rd.strokeStyle = '#3a1d52'; rd.lineWidth = 1.5;
  if (FAIR.length) {
    let seen = false;
    for (const Rr of FAIR) {
      const bx=(Rr.x-px)*sc, bz=(Rr.z-pz)*sc;
      if (bx*bx+bz*bz < (R*0.92)**2) { seen = true;
        rd.beginPath(); rd.arc(bx, bz, 3, 0, 7); rd.fill(); rd.stroke(); }
    }
    if (!seen) {
      const fx=(FAIR[0].x-px)*sc, fz=(FAIR[0].z-pz)*sc, fd = Math.hypot(fx, fz) || 1;
      rd.beginPath(); rd.arc(fx/fd*R*0.94, fz/fd*R*0.94, 2.4, 0, 7); rd.fill(); rd.stroke();
    }
  }
  // job givers: red dots in range; when idle, the nearest one clamps to the rim as a lead
  rd.fillStyle = '#e8302f'; rd.strokeStyle = '#14192e'; rd.lineWidth = 1.5;
  let lead = null, ld = Infinity;
  for (const mk of MARKERS) {
    if (!mk.mission || !mk.spr.visible) continue;
    const bx = (mk.x-px)*sc, bz = (mk.z-pz)*sc, dd = Math.hypot(bx, bz);
    if (dd < R*0.92) { rd.beginPath(); rd.arc(bx, bz, 3, 0, 7); rd.fill(); rd.stroke(); }
    else if (dd < ld) { ld = dd; lead = [bx/dd, bz/dd]; }
  }
  const mt = missionTarget();                   // job target, clamped to the rim as a compass
  if (lead && !mt) {
    rd.beginPath(); rd.arc(lead[0]*R*0.9, lead[1]*R*0.9, 3.4, 0, 7); rd.fill(); rd.stroke();
  }
  if (mt) {
    let bx = (mt.x-px)*sc, bz = (mt.z-pz)*sc;
    const dd = Math.hypot(bx, bz);
    if (dd > R*0.88) { bx *= R*0.88/dd; bz *= R*0.88/dd; }
    rd.fillStyle = '#ffd23b'; rd.strokeStyle = '#14192e'; rd.lineWidth = 2;
    rd.beginPath(); rd.arc(bx, bz, 4 + Math.sin(markerBob*3)*1.2, 0, 7); rd.fill(); rd.stroke();
  }
  rd.restore();
  // heading wedge
  rd.save(); rd.translate(R,R);
  rd.fillStyle = 'rgba(255,255,255,.22)';
  rd.beginPath(); rd.moveTo(0,0); rd.arc(0,0,R*0.85,-Math.PI/2-0.45,-Math.PI/2+0.45); rd.closePath(); rd.fill();
  rd.fillStyle = '#fff'; rd.strokeStyle = '#14192e'; rd.lineWidth = 2;
  rd.beginPath(); rd.moveTo(0,-8); rd.lineTo(6,7); rd.lineTo(0,4); rd.lineTo(-6,7); rd.closePath();
  rd.fill(); rd.stroke();
  rd.restore();
}
setTimeout(() => document.getElementById('controls').style.opacity = '0.35', 12000);

// =================================================================
//  POST — the ink pass
//
//  The outlines used to be a back-face shell mesh per object: a second copy of
//  the geometry, pushed out along its normals, drawn in flat ink. It cost a
//  duplicate draw of the crowd, the traffic and every tree, and it could only
//  ever draw a silhouette — a box seen face-on had no lines on it at all.
//
//  This finds the edges in screen space instead, out of the depth buffer the
//  scene render already produced. The test is the *second* difference across a
//  pixel, not the first: a first difference lights up any receding surface (the
//  whole road ahead of you), while the second difference is zero across a flat
//  plane however steeply it leans away, and spikes wherever the surface breaks.
//  That is what separates a silhouette from a floor — and, because a crease
//  between two flat faces is a break in the depth *gradient*, it draws the
//  interior lines (kerbs, window reveals, roof ridges) the shells never could.
//
//  Depth alone was a deliberate choice. Rendering the scene a second time into a
//  view-normal buffer gives a slightly cleaner crease, but measured here it cost
//  +364 draw calls and +14.6M vertices a frame — far more than the shells it was
//  meant to replace. The buffer this reads is free.
//
//  Lines fade out with distance (fadeNear/fadeFar): a one-pixel line on a
//  townsperson 300 m away is a crawling speck, and the fog has taken them anyway.
// =================================================================

// The composer's two ping-pong buffers need depth *textures*, not just depth
// buffers, or there is nothing to sample. Both get one, because which of the two
// holds the scene render when this pass runs depends on how many passes have
// swapped ahead of it.
const composer = new EffectComposer(renderer);
for (const rt of [composer.renderTarget1, composer.renderTarget2]) {
  rt.depthTexture = new THREE.DepthTexture(rt.width, rt.height, THREE.UnsignedIntType);
  rt.depthTexture.minFilter = rt.depthTexture.magFilter = THREE.NearestFilter;
}

// `thickness` is in CSS pixels; the shader works in drawing-buffer pixels, so it is
// scaled by the device ratio at setSize time. Otherwise a line is half as heavy on a
// retina display as on a plain one — the one thing a screen-space outline must not do.
const inkParams = {
  on: true, thickness: 1.0, depthSense: 0.9,
  fadeNear: 150, fadeFar: 340, strength: 1.0, debug: 'off',
};
const INK_DEBUG = { off: 0, depth: 1, edges: 2 };

const InkShader = {
  uniforms: {
    tDiffuse: { value: null }, tDepth: { value: null },
    resolution: { value: new THREE.Vector2(1, 1) },
    cameraNear: { value: 0.4 }, cameraFar: { value: 4000 },
    thickness: { value: inkParams.thickness },
    depthSense: { value: inkParams.depthSense },
    fadeNear: { value: inkParams.fadeNear }, fadeFar: { value: inkParams.fadeFar },
    strength: { value: inkParams.strength },
    debugMode: { value: 0 },
    inkColor: { value: new THREE.Color(INK_COLOR) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    #include <packing>
    uniform sampler2D tDiffuse, tDepth;
    uniform vec2  resolution;
    uniform float cameraNear, cameraFar, thickness, depthSense;
    uniform float fadeNear, fadeFar, strength;
    uniform int   debugMode;
    uniform vec3  inkColor;
    varying vec2 vUv;

    float dist(vec2 uv) {
      float d = texture2D(tDepth, uv).x;
      return -perspectiveDepthToViewZ(d, cameraNear, cameraFar);   // metres, positive
    }

    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      vec2 t = thickness / resolution;
      vec2 dx = vec2(t.x, 0.0), dy = vec2(0.0, t.y);

      float d0 = dist(vUv);
      float dl = dist(vUv - dx), dr = dist(vUv + dx);
      float du = dist(vUv - dy), dd = dist(vUv + dy);

      float curve = abs(dl + dr - 2.0*d0) + abs(du + dd - 2.0*d0);
      // a plane's *projected* curvature still grows with distance, so the tolerance
      // has to grow with it or the far pavement fills up with lines
      float tol = depthSense * (0.05 + d0*0.004 + d0*d0*0.0009);
      float edge = smoothstep(0.9, 1.8, curve / tol);

      float fade = 1.0 - smoothstep(fadeNear, fadeFar, d0);
      float e = clamp(edge * fade * strength, 0.0, 1.0);
      if (debugMode == 1) { gl_FragColor = vec4(vec3(fract(d0*0.1)), 1.0); return; }
      if (debugMode == 2) { gl_FragColor = vec4(vec3(e), 1.0); return; }
      gl_FragColor = vec4(mix(base.rgb, inkColor, e), base.a);
    }
  `,
};

const COPY_SHADER = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: InkShader.vertexShader,
  fragmentShader: 'uniform sampler2D tDiffuse; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tDiffuse, vUv); }',
};

class InkPass extends Pass {
  constructor() {
    super();
    this.material = new THREE.ShaderMaterial(InkShader);
    this.copy = new THREE.ShaderMaterial(COPY_SHADER);
    this.fsq = new FullScreenQuad(this.material);
    this.needsSwap = true;
  }
  setSize(w, h) {                       // w/h are drawing-buffer pixels
    this.material.uniforms.resolution.value.set(w, h);
    this.retune();
  }
  retune() { this.material.uniforms.thickness.value = inkParams.thickness * renderer.getPixelRatio(); }
  render(renderer, writeBuffer, readBuffer) {
    const off = !inkParams.on;          // straight passthrough, for A/B in the panel
    const mat = off ? this.copy : this.material;
    const u = mat.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    if (!off) {
      u.tDepth.value = readBuffer.depthTexture;
      u.cameraNear.value = camera.near; u.cameraFar.value = camera.far;
    }
    this.fsq.material = mat;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.fsq.render(renderer);
  }
}

composer.addPass(new RenderPass(scene, camera));
const inkPass = new InkPass();
composer.addPass(inkPass);            // before bloom: ink lines are not a light source
composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.16, 0.7, 0.85));
composer.addPass(new OutputPass());
// composer.setSize takes CSS pixels and applies the pixel ratio itself — a pass's own
// setSize then receives drawing-buffer pixels, which is what the ink offsets want.
// (Multiplying by the ratio here instead makes every offset sub-texel and the lines
// simply never appear.)
addEventListener('resize', () => {
  camera.aspect = innerWidth/innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight);
});

// =================================================================
//  LOOP
// =================================================================
// Flush the furnishing buckets, merged per colour like the buildings. This runs here —
// after every seeded build stage — and inside rngNeutral, because each new colour costs
// a merged geometry, a mesh and a cached toon material, all of which burn randoms. The
// main bucket flush pays those costs *before* the trees are planted, which is why the
// furniture can't just ride along in BUCKETS with new colours (see README).
rngNeutral(() => {
  for (const [color, list] of FURN) {
    if (!list.length) continue;
    const m = new THREE.Mesh(merge(list), toon(color));
    m.castShadow = true; m.receiveShadow = true; scene.add(m);
  }
});

// =================================================================
//  TUNING PANEL  (press G)
//  Almost every number in this game was landed by editing a constant, reloading,
//  waiting for the town to generate, driving back to the thing, and looking. These
//  are the dials that took the most round trips — now they move live, while you
//  drive. Nothing here is game state: it only writes the same variables the code
//  already reads, so closing the panel leaves no trace.
// =================================================================
{
  const gui = new GUI({ title: 'MAPLEWOOD TUNING', width: 300 });
  gui.close();
  gui.domElement.style.zIndex = '30';

  const car$ = gui.addFolder('Car');
  const carP = { topSpeed: MAX_SPEED, accel: ACCEL, grip: 2.2, armour: armorMul };
  car$.add(carP, 'topSpeed', 20, 110, 1).onChange(v => MAX_SPEED = v);
  car$.add(carP, 'accel', 10, 90, 1).onChange(v => ACCEL = v);
  car$.add(carP, 'armour', 0.1, 1, 0.02).name('damage taken').onChange(v => armorMul = v);

  const ramps$ = gui.addFolder('Stunt ramps');
  const rampP = { height: RAMPS.length ? RAMPS[0].h : 4.4, length: RAMPS.length ? RAMPS[0].len : 11 };
  const reshape = () => {
    // the mesh is baked geometry, so the visual updates on reload — but surfaceY is
    // read live, which is what you actually feel when you hit the lip
    for (const r of RAMPS) { r.h = rampP.height; r.len = rampP.length; }
  };
  ramps$.add(rampP, 'height', 1, 12, 0.2).name('height (feel)').onChange(reshape);
  ramps$.add(rampP, 'length', 5, 24, 0.5).name('run-up (feel)').onChange(reshape);

  const traffic$ = gui.addFolder('Traffic');
  const trafP = { density: traffic.filter(t => !t.cop && !t.derby && !t.racer && !t.rival).length };
  traffic$.add(trafP, 'density', 0, 260, 5).name('cars in town').onChange(v => {
    const civil = traffic.filter(t => !t.cop && !t.derby && !t.racer && !t.rival);
    if (v > civil.length) for (let i = civil.length; i < v; i++) spawnTraffic();
    else for (let i = civil.length - 1; i >= v; i--) {
      const k = traffic.indexOf(civil[i]); if (k >= 0) traffic.splice(k, 1);
    }
  });

  const world$ = gui.addFolder('World');
  const worldP = { fogNear: townFog.near, fogFar: townFog.far, sun: sun.intensity, fill: hemi.intensity,
                   room: roomLight.intensity, bloom: 0.16 };
  world$.add(worldP, 'fogNear', 60, 1200, 10).onChange(v => townFog.near = v);
  world$.add(worldP, 'fogFar', 400, 3000, 20).onChange(v => townFog.far = v);
  world$.add(worldP, 'sun', 0, 5, 0.05).onChange(v => sun.intensity = v);
  world$.add(worldP, 'fill', 0, 5, 0.05).name('ambient').onChange(v => hemi.intensity = v);
  world$.add(worldP, 'room', 0, 120, 1).name('interior lamp').onChange(v => roomLight.intensity = v);

  const cam$ = gui.addFolder('Camera');
  const camP = { distance: carDists[0], height: 0, fov: 60 };
  cam$.add(camP, 'distance', 4, 30, 0.5).onChange(v => carDists[0] = v);

  // The ink pass has no "reload and look" shortcut — a line weight is only judgeable
  // against the actual town, moving. `on` is the A/B: flick it and the lines vanish.
  const ink$ = gui.addFolder('Ink outlines');
  const iu = inkPass.material.uniforms;
  ink$.add(inkParams, 'on').name('outlines');
  ink$.add(inkParams, 'thickness', 0.25, 3, 0.05).name('thickness (px)').onChange(() => inkPass.retune());
  ink$.add(inkParams, 'debug', Object.keys(INK_DEBUG)).name('show buffer').onChange(v => iu.debugMode.value = INK_DEBUG[v]);
  ink$.add(inkParams, 'strength', 0, 1, 0.02).onChange(v => iu.strength.value = v);
  ink$.add(inkParams, 'depthSense', 0.1, 4, 0.05).name('tolerance').onChange(v => iu.depthSense.value = v);
  ink$.add(inkParams, 'fadeNear', 20, 600, 5).name('fade from').onChange(v => iu.fadeNear.value = v);
  ink$.add(inkParams, 'fadeFar', 40, 1200, 10).name('fade to').onChange(v => iu.fadeFar.value = v);

  const cheats$ = gui.addFolder('Cheats');
  cheats$.add({ coins: () => addCoins(1000) }, 'coins').name('+1000 coins');
  cheats$.add({ heat: () => clearHeat() }, 'heat').name('clear heat');
  cheats$.add({ fix: () => { carHealth = 100; } }, 'fix').name('repair car');

  addEventListener('keydown', e => { if (e.code === 'KeyG') gui.show(gui._hidden); });
  gui.hide();                                   // out of the way until G is pressed
}

// Every glow disc, beacon, billboard and sprite in the finished scene, kept out of the
// depth buffer the ink pass reads.
tagNoInk(scene);


// CAR_JOB is a hand-kept copy of the needsCar flags (the markers are placed before
// MISSION_DEFS exists). Catch a drift here, not as a giver stuck in a back garden.
{
  const drift = Object.keys(MISSION_DEFS).filter(k => !!MISSION_DEFS[k].needsCar !== !!CAR_JOB[k]);
  if (drift.length) console.warn('CAR_JOB out of step with MISSION_DEFS:', drift);
}

const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = paused ? 0 : Math.min(clock.getDelta(), 0.05);
  const now = performance.now();
  const sub = mode === 'car' ? car.position : mode === 'plane' ? plane.position : player.position;

  updateLights(dt);
  updateSky(dt);
  if (riverWater) riverWater.uniforms.uTime.value += dt;
  updateHeadlights();
  updateCar(dt);
  updatePlane(dt);
  updatePlayer(dt);
  updateRoomState(dt);
  updateDoors(dt);
  updateChaos(dt);
  ensureCarInSight(dt);
  updateTraffic(dt);
  updatePeds(dt);
  updateChickens(dt);
  updateTireClimb(dt);
  updateBombs(dt);
  updateRides(dt);
  updatePutt(dt);
  updateBowl(dt);
  updateShopGames(dt);
  updatePets(dt);
  updateProps(dt);
  updateCoins(dt, sub);
  updateTrophies(dt, sub);
  updateMarkers(dt, sub);
  updateGarage();
  if (hornCd > 0) hornCd -= dt;
  updateMissions(dt, sub);
  updateParticles(dt);
  renderCrowd(sub);
  updateCamera(dt, now);
  updateHUD(dt);

  // follow the subject in y as well: the shadow camera's far plane is 620, so a room
  // volume at y=-400 would otherwise fall outside it entirely
  sun.position.set(sub.x + sunDir.x*260, sub.y + sunDir.y*260, sub.z + sunDir.z*260);
  sun.target.position.copy(sub);

  stackT -= dt;
  if (stackT <= 0) {
    stackT = 0.3;
    for (const s of smokeStacks)
      emit(tmpV.set(s.x + rnd(-2,2), s.y, s.z + rnd(-2,2)), new THREE.Vector3(rnd(-1,1), 5, rnd(-1,1)), 0xe8eaf0, 5, 3.6, 4);
    for (const f of fireSpots) {
      emit(tmpV.set(f.x + rnd(-2,2), f.y, f.z + rnd(-2,2)), new THREE.Vector3(rnd(-1,1), 7, rnd(-1,1)), 0x33343c, 6, 4.5, 5);
      emit(tmpV.set(f.x + rnd(-1.5,1.5), 2.5, f.z + rnd(-1.5,1.5)), new THREE.Vector3(rnd(-.6,.6), 5, rnd(-.6,.6)), 0xff7a2b, 2.6, 0.85, 1.6);
    }
  }
  for (const b of blimps) {                       // slow lap of the town, nose into the turn
    b.t += dt*b.spd;
    b.g.position.set(Math.cos(b.t)*b.r, b.h + Math.sin(b.t*2.1)*5, Math.sin(b.t)*b.r);
    b.g.rotation.y = -b.t + Math.PI/2;
  }
  composer.render();
}

const loader = document.getElementById('loader');
const bar = loader.querySelector('.bar i');
// The title / instructions screen: once the town is built we hold the sim paused behind it
// and wait for the player to press any key (or tap) before the game runs.
const startScreen = document.getElementById('start');
let gameStarted = false;
function beginGame() {
  if (gameStarted) return;
  gameStarted = true;
  startScreen.classList.remove('show');
  paused = false;
  sirenInit();                                       // the tap/keypress is the audio gesture too
}
// Capture phase so the first key just dismisses the splash instead of also driving/jumping.
addEventListener('keydown', e => { if (!gameStarted) { e.preventDefault(); e.stopPropagation(); beginGame(); } }, true);
startScreen.addEventListener('pointerdown', e => { e.preventDefault(); beginGame(); });
let prog = 0;
const li = setInterval(() => {
  prog = Math.min(100, prog + 25); bar.style.width = prog + '%';
  if (prog >= 100) {
    clearInterval(li);
    setTimeout(() => { loader.style.opacity = '0'; setTimeout(() => loader.remove(), 700); }, 220);
    paused = true;                                   // freeze the town under the splash
    startScreen.classList.add('show');
    animate();
  }
}, 110);
