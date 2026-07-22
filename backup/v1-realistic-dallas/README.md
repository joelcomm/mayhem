# Carjacker v1 — Realistic Downtown Dallas

Snapshot taken before forking to the cartoon "Springfield" direction.

## What this is
A 3D open-world driving game built on **real OpenStreetMap geometry** for downtown
Dallas: 339 building footprints, 1,431 road segments, 211 traffic signals.

## To run / revert
Copy `index.html`, `dallas.data.js` and `process_osm.js` back into the project root
and open `index.html`. Needs an internet connection on first load (three.js via CDN).

## Files
- `index.html`      — the whole game, self contained
- `dallas.data.js`  — window.DALLAS_DATA, projected + auto-rotated OSM geometry
- `process_osm.js`  — Node script that regenerates dallas.data.js from Overpass

## State at snapshot
- 2,600 instanced pedestrians, 600 instanced cars, ~9,000 instanced trees
- 296 draw calls (down from 7,181 before instancing)
- Buildings clipped off the streets with angled corners; collision matches the visuals
- Pedestrians walk sidewalks and cross at 251 painted crossings, obeying signals
- Traffic obeys 161 real signals, queues, and yields to pedestrians
- 0 streetlamps / 0 props on the roadway (verified by window.__audit())

## Dev helpers left in
- `window.__audit()` — re-runs the street/sidewalk/traffic audit, returns counts
- on-screen error trap — a module-level throw prints on the loading screen instead
  of hanging silently (the console reader does not surface module errors here)

## Known caveats
- Frame rate was never measurable in the harness preview (rAF clamped to 10Hz)
- Rooftop AC units read as "floating" on very distant towers that haze into the sky
