# Handoff prompt — Springfield Rush

Paste everything below into a new conversation.

---

I'm continuing work on **Springfield Rush**, a cartoon open-world driving game in the
spirit of *The Simpsons: Hit & Run*. Please read `index.html` and `README.md` in
`/Users/joelcomm/driver/` before changing anything.

## Where things are

- `/Users/joelcomm/driver/index.html` — the entire game, one self-contained file
  (~3,100 lines). three.js r0.161 + EffectComposer/UnrealBloom/OutputPass/BufferGeometryUtils
  via unpkg importmap, so first load needs internet.
- `/Users/joelcomm/driver/README.md` — architecture, controls, landmark list, gotchas.
- `/Users/joelcomm/driver/backup/v1-realistic-dallas/` — the earlier, completely different
  game (real OpenStreetMap downtown Dallas). Has its own README for reverting. Don't
  touch unless I ask.
- `dallas.data.js`, `dallas_osm.json`, `process_osm.js` in the root belong to that old
  version and are unused by the current game.

**To run:** a static server is usually already up — `python3 -m http.server 8000` from the
project root, then <http://localhost:8000/>. Kill with `lsof -ti:8000 | xargs kill`.
Opening `index.html` directly also works.

## Controls

W A S D drive/walk · Mouse look (click for pointer lock) · Shift run · Space handbrake/jump ·
**F** get in/out (near stopped traffic it carjacks) · **C** camera distance · **R** reset ·
**M** map view (pulls back over the whole town, disables fog).

## What the game is now

A **fixed, seeded** town (`__seed` near the top of the module — change it for a different
town, but I've settled on this one). Deliberately **not a grid**: junction lattice with
non-uniform spacing, every junction nudged off true, some cells merged into super-blocks
leaving T-junctions and dead ends, plus diagonal avenues.

- A **river** crosses the whole map with exactly **three bridges**; riverside parkland
  both banks. **Altitude matters** — drive off a bank and you fall in, splash, and reset.
- A **country highway** on long curves with spurs into town, through a **tunnel** in a hill.
- **Rolling countryside** heightfield outside the ring road; flat across town so roads stay level.
- **Landmarks**: 742 Evergreen Terrace (+ Flanders house), nuclear plant, Burns Manor,
  penitentiary, First Church, Town Hall + police, Duff Stadium, Duff Brewery, Retirement
  Castle, Springfield Elementary, tire fire, monorail with station and train, water tower,
  SPRINGFIELD hillside sign, Duff blimp, Lard Lad's giant donut, Krusty Burger head.
- **22 named shopfronts** (Kwik-E-Mart, Moe's, Android Dungeon, Luigi's, Noiseland, etc.).
- ~1,600 townsfolk, ~165 cars, ~1,800 trees, 145 coins, and a few characters with a
  floating red "!" who say a line when you reach them.

## How it's built (the parts that matter)

- **Toon look**: `MeshToonMaterial` on a 3-step ramp + black back-face shells for ink
  outlines. Outline meshes **share the `instanceMatrix`** of the mesh they wrap, so an
  outlined crowd costs no extra matrix maths.
- **Everything crowd-scale is `InstancedMesh`** — people (one mesh per body part),
  vehicles (per type: paint/dark/chrome/glass/lamp), trees, props, coins, signals.
  Buildings are bucketed by colour and merged, so the town is a few dozen draw calls.
- **Traffic** drives a road graph built from the street list, obeys signals, queues, and
  yields to pedestrians. **Pedestrians** walk sidewalk lanes, round corners, and cross at
  painted zebras when the signal holds the traffic they'd step into.
- Spatial grids for pedestrians, props and street segments keep per-frame checks local.

## Hard-won gotchas — please read before editing geometry

1. `BGU.mergeGeometries` returns **null**, silently, unless every input agrees on
   indexing *and* attribute set. `put()` and `merge()` normalise for this.
2. Ground/road quads must be wound **counter-clockwise seen from above**, or
   `computeVertexNormals` points them down and they vanish. `quad()`/`rect()`/`disc()`
   are already correct — copy their vertex order.
3. The ground heightfield must be subdivided in **both** axes. Strips spanning the full
   depth with one triangle pair turn the terrain into a giant ramp that silently buries
   the town — the roads are still there, just underground.
4. The two riverbanks need **opposite winding**, or one renders as a black stripe.
5. `InstancedMesh.setColorAt()` allocates a **zero-filled** buffer — every instance starts
   **black**. Fill `instanceColor.array` with 1 after allocating, or parts that never get
   an explicit colour render black.
6. Bridges keep the road at y=0 while the channel is cut below. `surfaceY()` returns 0
   over a deck, riverbed elsewhere; `onBridge()` stops a crossing counting as water.
7. **Nothing may sit on a carriageway.** Scattered items filter through `onRoad()`;
   structures go through `footprintOnRoad()`, houses/shops slide via `placeClear()`,
   landmarks scale via `fitScale()`, and block build-rects are shrunk until clear.
   A build-time audit logs `structures overlapping roads:` — **it must print `{}`.**
8. Vehicle collision is an **oriented** box per car type. Don't revert it to an AABB —
   that's what made cars feel like they had an invisible wall.
9. A module-level throw prints on the **loading screen** (inline `error` handler). The
   dev console does not surface module errors in every preview environment — trust the
   loader, and always take a settled frame before diagnosing (the camera snaps on frame
   one now, but early screenshots have fooled me before).

## Verification habits that worked

Measure, don't eyeball. The build logs three self-checks on load:
`trees: N planted, M removed from roads`, `structures overlapping roads: {}`, and
`spawn x,z onRoad=true`. Add a temporary `window.__probe` when diagnosing and remove it
after. `M` (map view) is the fastest way to sanity-check world generation.

## Next steps

**1. Characters' eyes.** I just fixed the instance-colour bug (gotcha 5) that made eyes
render as black masks, and pedestrians now have white eyeballs with pupils. Please
double-check this across the crowd, the player, the rider in the car, and the "!"
characters — and at distance, where the outline shell may still be swallowing the
whites. If any still look like they're wearing black masks, that's the thing to chase.

**2. Building interiors — the big one.** I want to be able to walk up to a door, tap
**F**, have the door swing open, and walk inside. Before writing code, please assess and
tell me:

- How hard is this given the current architecture? Buildings are currently **merged into
  colour-bucket meshes** with no per-building identity, and collision is a flat list of
  AABBs / convex prism colliders. Interiors imply per-building entities, doorways cut in
  walls, interior floors/walls, and collision that lets you through a door but not a wall.
- What's the cleanest approach — genuinely modelled interiors, or an interior "room"
  volume you teleport into (like the original game's shops)? I don't mind either as long
  as **borders and geometry hold up** — no falling through floors, no walking out through
  walls, no camera clipping outside.
- How does it interact with the chase camera, which already clips through houses on
  narrow streets (a known unfixed issue — a collision-aware camera that pulls in when
  something is between you and the car is still outstanding).
- Roughly how many buildings should be enterable? I'd start with the named shops
  (Kwik-E-Mart, Moe's, Lard Lad, Android Dungeon) and 742 Evergreen Terrace.

**Give me your assessment and a plan before building it.** Once we can get inside and the
geometry holds, we'll talk about what's in the rooms.

## Known outstanding issues

- Chase camera clips through buildings on narrow streets.
- Frame rate has never been measurable in my preview environment (rAF clamped) — if
  performance matters, the population constants (~1,600 peds, ~165 cars) are the knobs.
- Skipping structures that can't fit clear of a road slightly thinned some blocks;
  coins dropped 161 → 145. Widening blocks is an alternative if density matters.
