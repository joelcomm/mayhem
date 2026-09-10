# Public Nuisance: After Hours

Independent upgraded edition. The original driver project is unchanged.

## Play
Open docs/index.html directly, or run npm install followed by npm run dev.
The production build is self-contained and works offline.

WASD drive; Space drift; Shift boost; F enter/exit; E accept nearby job;
J dispatch; M overhead map; P pause; X abandon job. On foot, Shift runs.
Dispatch and pause also have clickable buttons. Touch controls include boost.

## Added
- Warm afternoon lighting, updated sky, cream/mint visual identity, full title screen,
  compact objective HUD, mission board with illustrated road map and filtering.
- Independent traction/momentum, five handling profiles, rechargeable boost,
  pooled skid marks, drift rewards, close-call bonuses, vehicle stripes and rear wings.
- Cyan road-graph routes in the world and minimap; explicit mission acceptance.
- Saved coins, chaos, upgrades, collected trophies, owned cars, mission records,
  medals, reputation progress and graphics preference. Autosave every four seconds,
  on mission completion and when leaving. Save key: public-nuisance-after-hours-v1.
- Garage vehicle selection; owned cars can be selected without buying them again.
- High, balanced and performance graphics options; pause on window blur.
- Basic gamepad driving: triggers accelerate/brake, left stick steers, A handbrake,
  X boost, Y interact/accept, Start dispatch. Hardware gamepad testing pending.

## Verification
npm run build
node --test tests/driving.test.js

Unit coverage: traction frame-rate independence, controlled slip, boost bounds,
shortest connected road routes, unreachable destinations.
Browser smoke checks cover title, mission board, selecting navigation and pause UI.
All original 13 missions remain; a complete mission-by-mission playthrough is pending.

## Source notes
src/upgrade/driving.js contains the new independently testable driving/navigation math.
The integration is appended to src/main.js after world construction.
The edition stylesheet is src/upgrade/style.css, mirrored into the second style block
in index.html to ensure the original inline styles cannot override it. Keep them in sync.
Progress resumes at the safe spawn; an active mission/chase is not resumed after reload.
Original world layout and mission content are retained. District names are location
labels; this edition does not rebuild the town into new architectural districts.
