# Maplewood Mayhem

A cartoon open-world driving game in the spirit of *The Simpsons: Hit & Run*.
`docs/index.html` is the built game — one self-contained file with three.js inlined,
so it runs from a web server or straight off `file://`, online or not.

## Running it

```bash
npm install
npm run dev      # http://localhost:5173 — hot reload
npm run build    # -> docs/index.html, one self-contained file
npm run deploy   # build, then push to GitHub Pages *and* the Netlify hub
```

The source is `src/main.js` (the whole game) plus `index.html` (the DOM shell: HUD
markup and CSS). three.js comes from npm, pinned to **0.161.0** — the exact version
the old CDN importmap used, so behaviour is unchanged.

**The build deliberately emits one self-contained file.** three is inlined, which
costs ~700 KB (200 KB gzipped) but keeps deployment to "copy one file" — the game
ships to two hosts and also has to run from `file://`. A normal chunked build would
mean getting asset base paths right in two places for no gain here.

**Press `G` for the tuning panel** (`lil-gui`). Top speed, acceleration, armour, ramp
height and run-up, traffic density, fog, sun, ambient and interior lamp intensity,
camera distance, ink-outline weight/tolerance/fade (with an on-off A/B and a raw
buffer view), plus coins/heat/repair cheats — all live, while you drive. Almost
every constant in this game was originally landed by editing a number, reloading,
waiting for the town to generate and driving back to look at it; these are the dials
that cost the most round trips.

## Controls
| Key | Action |
|-----|--------|
| W A S D | drive / walk |
| Mouse | look around (click for pointer lock, or drag) |
| Shift | run (on foot) |
| Space | handbrake / jump |
| Left click | punch — right hand (on foot) |
| Right click | kick — left leg (on foot) |
| F | enter a building at its door · otherwise get in / out of a car — near stopped traffic it borrows theirs |
| C | cycle camera distance |
| R | reset (also clears heat) |
| N | mute / unmute (or the 🔊 button, top right) |
| P | pause — overlay with controls, the active job and your stats |
| M | map view — pull back over the whole town |
| H | air horn (once bought from the garage) |
| 1-4 | buy, while standing on Gus's forecourt |

## The game
Wreck things. Every pedestrian, car and bit of street furniture you hit feeds a **combo**:
every third hit raises the multiplier (up to x8), and the run banks into your **chaos
score** four seconds after you stop.

Chaos also builds **heat**, and heat brings **police** — up to five cars, one per star.
While you're wanted the combo stops ticking down and is **held**: shake them off and it
banks at **1.6x**, let them box you in for three seconds and you're **busted** and it's
gone. Wrecking your own car loses it too. So the loop is: cause trouble, get chased,
decide how long to keep pushing before you run for it.

The crowd is a real mix: mostly the classic yellow with tan and brown townsfolk
among them, nine hairstyles (ball caps, afros, mohawks, long hair beside the
originals), a wide wardrobe, and varied heights and builds — **width and depth vary
independently**, because a town where everyone is the same thickness reads as clones
however much the heights differ, and the side-on silhouette is what gives that away. On foot the crowd has
substance: people shove past each other rather than overlapping,
and you can't walk through them — you shoulder past. **Barge someone and they square up**
and chase you for a few seconds, swinging; a punch knocks you down. **It has to be your
fault, though.** The crowd walks its own lanes and blunders into a standing player all
day; anger used to fire on any overlap, so a townsperson could walk into you, take
offence, and put you on the floor for the crime of standing still. The contact is now
judged by whether *you* were closing — your own movement that frame projected onto the
line between you, over 1.2 m/s against a walking pace of about 4. Shove someone and they
fight. Get shoved and they apologise. **There are two attacks, and they do different jobs.**
**Left click throws a right hand**: fast, short, aimed at one person, and it does *not*
put them down — it rocks them back and **starts a fight**, because they square up and
swing back. **Right click swings the left boot**: slower and more committed, but it
reaches further, sweeps everyone in front of you rather than one target, and actually
launches them — they get up and run away. So the light attack opens an exchange and the
heavy one ends it. Two punches on the same person inside two and a half seconds also
drops them (`KO!`), so a flurry still pays. Both feed the combo; only the boot counts
for chickens, which is what keeps Feather Frenzy about the boot.

Left-for-fast and right-for-heavy is the convention everywhere else, and it happens to
map straight onto hand-is-light, boot-is-heavy. Right-drag to look already popped the
browser context menu over the game; now that right click is the kick, that is
suppressed.
Townsfolk knocked down by your car get up scared and run too.

Police are ordinary traffic agents with a chase flag. They use the same road graph as
everyone else, so they route through town properly rather than homing at you through
walls; inside 36 m they leave the graph and just come at you. They ignore signals, and
they still run people over. They wear the part: navy paint, a flashing light bar on the
roof, POLICE on both doors, and a quick **double chirp** when one is close on your tail —
more insistent the closer they get, rather than a constant wail. Coins chime when
collected. All audio is short scheduled tones on one shared AudioContext (`tone()`),
built lazily on the first key/mouse input, since browsers refuse audio before a gesture.
The one exception is the **engine**: a single persistent oscillator whose
pitch rides the speed and whose gain gates on driving (`updateEngine`) — and
**each car body has its own voice** (`ENGINE_VOICE`): a truck idles at 29 Hz
square, a compact at 60 Hz, triangle wagons get a gain lift, so a NEW RIDE from
Gus's sounds different, not just looks it. Under everything sits a **town hum**
(`ensureHum`): two barely-detuned 50 Hz sines beating over ~8 s plus a whisper
of harmonic — felt more than heard, it mostly registers when you mute and the
town goes dead. **Rides make their own noise while you're in the seat**
(`updateRideAudio`): a music-box waltz on the carousel, a track rattle on the
coaster that goes quiet in the station, a motor buzz in the bumper car — all
scheduled one-shots through the master gain, so mute needs nothing special. On top of the
tones: **crash thumps** against buildings, **metal clangs** on car-on-car hits, **dings**
when street furniture pings off the bumper, **door creaks** on open and close, bomb
beeps and booms at the prison — and the townsfolk **speak**: kicks, car
hits and barges trigger a speech-synthesis line (`sayOuch`, rate-limited, zero
assets — degrades to silence where `speechSynthesis` is unavailable). **What they
say depends on what you did to them**: three banks of ~21 lines for being
shouldered past, booted, and put on the tarmac. One shared list meant someone you
had just run over complained about your manners, which is funny exactly once. The
banks are long on purpose — the rate limiter lets maybe one line every second and
a half through, so a short list is audibly a short list inside a minute of play —
and a guard stops the same line landing twice in a row, which is the one thing
that makes a big list sound small. The banner someone yells as they **square up**
is its own list, weighted to the ones with a threat in them rather than the merely
affronted ones.

**Mute** is the 🔊 button top right, or **N**. Everything audible routes through one
master gain rather than straight to the destination, which makes mute a single number
instead of a flag every sound site has to remember to check — and killing the gain
leaves the scheduled notes and the engine oscillator running, so unmuting is instant
rather than a rebuild. The one thing that gain cannot reach is `speechSynthesis`: it is
its own pipe, so `sayOuch` checks the flag directly and the toggle cancels anything
mid-word. The choice is remembered in `localStorage` — someone who plays with the sound
off wants it off next time too. The HUD is `pointer-events:none` so clicks fall through
to the canvas (look, kick); the button is the one element that opts back in, and it
stops the event so pressing it doesn't also throw a kick.

**The arrest is made on foot.** Ramming damages your car but never busts you. When a
pursuer closes on a slow or stopped target it parks, an officer steps out ("PULL OVER!")
and walks to your door — reach you and it's BUSTED. Speed away (over ~20 mph) or get 30 m
clear and the officer gives up and the car chase resumes. So a chase ends one of three
ways: you outlast the heat, your car dies, or you stop long enough to be arrested.

**Altitude matters.** The river is a real drop. Drive off a bank and the car falls,
splashes, sinks and the run resets. The countryside hills are drivable — the car and the
player on foot both ride the surface.

## The town
**Fixed layout** — the generator is seeded (`__seed` near the top of the module), so it's
the same Maplewood every load. Change the seed for a different town; everything below
is derived from it. **There is no grid.** A junction lattice is laid out with
non-uniform spacing (tight downtown, loose on the outskirts), then every junction is
nudged off true, so no street runs dead straight and no two blocks match.

- **Varied blocks** — some cells are merged into super-blocks by deleting the street
  between them, which leaves T-junctions. Stubs left behind by that (and by dropping all
  but three river crossings) are pruned: every junction has at least two ways out, so no
  street stops in the middle of nowhere
- **Diagonal avenues** cut across the grain
- Job givers are placed by `clearSpot`, which rings outward to 30 m looking for
  ground that is clear of buildings, clear of the carriageway **and dry**. All
  three matter: an 11 m ceiling silently dropped anyone anchored near a big
  junction, and without the water test a giver anchored by a bridge stands in
  the river — walking up to them drowned you before they could say hello
- **A river** winds the full width of the map and genuinely divides the town: only
  **three bridges** cross it, each with a deck, piers and railings, and the banks
  slope down to the water. A **white fence runs along both banks** (broken at the
  bridges) so nobody wanders in — the fence chunks are real colliders
- **Riverside parks** line both banks — trees, benches, no buildings
- **A ring highway** loops the whole town on long curves, with four spurs into it (one
  from each corner of town, so the perimeter is reachable from every quarter) and a
  **tunnel** bored through a mountain — a real one: an open, lamp-lit vault you can see
  down from mouth to mouth, with portal facades standing at the rock face. The hill is
  built on **one straight axis while the bore follows the ring's bend**, so mass that
  clears the middle can still lean over a mouth at the ends — which is what left one
  portal half-buried. Cap, brim, flanks and shoulders are all pulled shorter along the
  bore and wider across it, carving both mouths open; the object count and colour are
  unchanged, so the seeded stream is untouched. It is a closed loop on purpose — an arc has two
  ends out in open country, which is the most obvious road-to-nowhere on a map.
  **Metal guardrails line both sides** of every highway segment, with gaps only where
  the spurs join, so the ring is the playable world's hard perimeter. Rails — highway
  guardrails and bridge railings both — stand a metre outside the old line (`st.w+3.1`
  and `st.w+3`), because with the collider inflation plus the car's probe radius the
  original offsets pinched the drivable width to less than the carriageway
- **Rolling countryside** — the ground is a heightfield that stays dead flat across the
  town and out past the ring highway, then swells into hills, so every carriageway is
  level while the horizon rolls
- Houses follow the street they front, so a bent street has a bent row of houses. They
  are set back **inside** their own block. Setting them back on the outside puts every
  house across the road in the neighbour's block — mostly invisible, because the block
  opposite does the same thing back, but where a residential block met the shops you got
  houses interleaved with the storefronts, facing away from the high street

### Landmarks
742 Maple Drive (salmon walls, orange roof, house number on the front) and the tidy
green house next door · the Nuclear Power Plant · Ravenwood Manor · the Penitentiary —
now with a gated opening in its north wall (the wall is withdrawn in the deferred
pass and rebuilt gated from existing bucket colours inside `rngNeutral`; its collider
swaps for the shorter runs only after `cityAudit()`, past the scatter filters, so the
opening cost zero canary movement — and it freed the coins that used to spawn sealed
inside the yard). The opening is barred by a **portcullis** of prison bars — a
runtime Group whose collider (`gateBlock`) toggles like a shop door's, raised and
lowered with F from the gate button ·
First Church · Town Hall and the Police Station · Victory Stadium · Golden Brewery ·
the Retirement Castle — now with a gated, drivable great hall and a flock of
chickens that scatter from the car and burst into feathers under it · Victory
Stadium's south gate is open too: drive between the pillars onto the infield ·
Maplewood Elementary · the eternal tire fire · water tower ·
MAPLEWOOD on the hillside · the brewery blimp · the giant donut · the Burger Baron
head.

Landmarks are **placed by direction rather than by fixed coordinates**, so they land on
sensible blocks whatever the layout comes out as.

The **monorail was removed**: an elevated beam over a street with no way to reach it just
read as a highway floating above the houses.

**Commerce is scattered, not pooled** — one high-street block stays downtown by the
plaza, and five more shop quarters are pushed out toward the map's far corners and
edges (the zoning places them *after* the landmarks so the set pieces keep their
priority spots). Directional picks alone were not enough: when the far corners are
already taken by landmarks, two "diagonal" picks fall back to neighbouring edge
blocks and the businesses pool again — so every shop quarter must also stand at
least **260 m** from every other one (downtown included). That hard separation is
what actually spreads commerce to every quarter of the town, out by the spur mouths.
Jobs therefore send you across the whole map — and often across the river. The names cycle across all four quarters: Speedy Mart,
The Rusty Mug, Comic Castle, Burger Baron, Strike City Lanes, Bargain Barn, Army
Surplus, Tony's Pizza, Captain's Catch, Pixel Palace, Grand Theater, Lefty's, City
Mall, Action News, Starlight Studios, Putt Paradise, Curl Up & Dye, Golden Koi Sushi,
Town Museum, Order of the Owl, Club Inferno. (Formerly Simpsons parody names — the
locations and their fit-outs are unchanged, only the branding.) Which name lands in
which quarter is grid luck, so anything the code must *find* by name (Big Donut's
giver, The Rusty Mug's bar) resolves its position at runtime.

**Neighbourhood detail** — pitched roofs, porches, chimneys, driveways, hedges, mailboxes
and lawns out front; sheds, pools, trampolines, swing sets, barbecues and hedgerows out back.

### Keeping the map clean
A second build-time sweep, **`solids on the carriageway`, must print 0**. `cityAudit`'s
blockade test only samples street *centrelines* against a car's width, so anything
sitting near a kerb slips past it and shows up in-game as a bump or a rail lying
across a crossing. This one walks every collider instead and asks whether its centre
is on tarmac. It is what caught the riverside fence: that fence tested `onRoad` at
each chunk's **midpoint only**, so a 5 m chunk could sit centred on the grass with
one end out across the zebra. It now tests both ends and the middle — and, so the
fix costs nothing, it still *builds* every chunk's geometry and discards the bad
ones afterwards, because skipping the `baked()` calls outright would shift the
seeded stream and re-roll the whole town.

`cityAudit()` runs at build time and **must print all zeros**. It checks, over the finished
town: buildings overlapping each other, scenery inside buildings, coins sealed inside
buildings, dead-end streets, houses crowding the shop frontages, and — by driving every
carriageway centreline against the collider list — whether a car's width is ever inside
something solid. That last one is the blockade test, and it catches things
`footprintOnRoad` cannot.

Two things make it pass rather than just measure:
- `placeClear()` requires a footprint to clear **both** the road and everything already
  standing. If the whole frontage is taken the caller gets `null` and doesn't build. A gap
  in a terrace reads as a gap; a shop with a house through it reads as broken.
- `addBox` takes a `group`, because a landmark is many abutting boxes — a stadium ring, a
  prison perimeter — and those touching each other is the design. Same-group pairs are
  ignored. Without it the audit drowns in false positives and hides the real ones.

### Going inside
**Shop windows are real glass.** The glazing is a transparent material on its own
bucket (surface kind `glass`, `depthWrite` off so it neither occludes the room nor
collects an ink outline), and — the part that actually matters — the window is a *hole*.
A transparent pane in front of a solid wall shows you the wall, which is all the first
attempt achieved. `cutWall` punches the band's opening through everything standing in
the way: the shell's front wall, the room's own lining, and the dark band the glass sits
in, which was a solid slab and is now a frame. Walk down the high street and you can see
the diners, the shelves and the staff inside without opening a door. The wall colliders
are untouched, so the window is glass, not a doorway.

**Every storefront in town is enterable** (35 rooms across the six scattered
quarters — a few candidates whose interiors can't be cleared stay solid), plus
**742 Evergreen Terrace**. Walk up to the door on foot,
press **F** to swing it open, and **walk in**. There is no transition: no fade, no
teleport, no separate mode. You can see the lit interior through the open doorway from
the street, and the room is simply part of the town. **F** again closes the door behind
you (a shut door is a real collider). **Every room is furnished for what it is**: aisles
and a slushie machine in the Speedy Mart, the Rusty Mug's bar with taps and bottle
shelves, donut cases at Big Donut, bowling lanes and pins at Strike City, arcade
cabinets back-to-back at Pixel Palace, seat rows facing a screen in the Grand Theater,
a checkerboard dance floor and mirror ball at Club Inferno, the couch and TV at 742 — twenty-two briefs, dispatched on the
shop's name (`furnishRoom`), with the old counter-and-crates as the fallback. Both
copies of a repeated name get the same treatment, adapted to each room's trimmed size.
Big furniture is solid (colliders registered in the room's `walls`, so the interiors
audit knows it belongs); small props are visual only; the walk from the door stays open
(`inLane`). **Floors are tiled or boarded**, picked by the room's own coordinates — a
checkerboard shop floor and a boarded one next door is most of what makes two rooms of
the same size read as two different places.

**Every room gets dressed as well as furnished.** The briefs above say what a shop
*is*; a second pass, run for all 43 rooms including the plain fit-out, adds what every
shop *has*: ceiling strip lights down the long axis, a clock high on the back wall,
framed pictures at eye height on both side walls, a stocked shelf above head height, a
doormat where you come in, a plant in the far corner and a bin by the counter. A room
with good furniture and bare walls still reads as a diorama — it is the lights and the
junk in the corners that make it read as somewhere people work. All of it is either
wall- or ceiling-mounted, so it cannot land on top of anything a brief placed, or goes
through the same `ok()`/`solid()` overlap test as the rest.

**Every room gets dressed as well as furnished.** The briefs above say what a shop
*is*; a second pass, run for all 43 rooms including the plain fit-out, adds what every
shop *has*: ceiling strip lights down the long axis, a clock high on the back wall,
framed pictures at eye height on both side walls, a stocked shelf above head height, a
doormat where you come in, a plant in the far corner and a bin by the door side. A room
with good furniture and bare walls still reads as a diorama — it is the lights and the
junk in the corners that make it read as somewhere people work. All of it is either
wall- or ceiling-mounted, so it cannot land on top of anything a brief placed, or goes
through the same `ok()`/`solid()` overlap test as the rest.

**Rooms have people in them** — a cashier behind the Speedy Mart counter, a barman
behind the Rusty Mug's bar, seated diners, dancers at the disco. They are *staff*: static figures with a fixed
spot, a fixed yaw and an idle sway (seated ones fold at the hip), drawn through the same
instanced crowd meshes as the street crowd (`renderCrowd` iterates `staff` after `peds`),
so a hundred of them cost no extra draw calls. They never join `peds`, so the kick,
anger and separation systems ignore them. Their bodies are built after the ped spawn
(pickLook's palettes don't exist when the interiors pass runs), inside `rngNeutral`.

Doors are **two InstancedMeshes** (leaf, knob), not a hinge Group each —
at forty-plus doors that's the difference between 2 draw calls and ~90. A swinging door
is just its instance matrix recomputed. And since `SHOP_NAMES` cycles, shop names repeat:
a door must hold a **direct reference to its room** — looking the room up by name binds
every duplicate to the first copy.

### Jobs
Six townsfolk stand under a red **"!"** on a **gold** glow disc (blue-glow folk are
just flavor chat): walk into the glow and the job starts. One at a time; the giver
re-arms a few seconds after the job ends, so everything is replayable. All job
plumbing is shared: a **guide arrow** floating over your head, a **pillar-of-light
beacon** ringed at its trigger radius on the destination, a gold blip **clamped to
the radar rim** as a compass, a countdown **measured over the road graph**
(Dijkstra — crow-flies pars would make cross-river jobs impossible), and a center
banner for start/win/fail. **Rewards scale ×(1 + stars/2) with the heat you carry
when you deliver** — causing trouble en route is the optimal strategy, and it is
the thing that welds the job loop onto the chaos loop instead of competing with it.

- **DONUT RUN** (Glazed Dan, outside Big Donut) — timed delivery to the Power
  Plant; leftover seconds pay out.
- **FARE GAME** (Rita, on the plaza) — taxi her to a random far-off storefront,
  in the car, and *stop* to drop her; she heckles en route.
- **COLD ONE** (Thirsty Lou, by Town Hall) — on foot: walk into The Rusty Mug,
  grab a pint at the bar, walk it back. Makes the interiors matter.
- **FEATHER FRENZY** (Nurse Mabel, at the **farm pen's gate**) — on foot only:
  walk into the pen and **kick** 7 chickens in 60 s. Kicks connect with
  chickens (feather burst, respawn timer, chaos) and the round counts the
  dedicated `chickenKicked` counter, so running birds over with the car doesn't
  score — the boot is the whole game. The flock **moved out of the Retirement
  Castle** (kicking birds while being shoved off interior walls was the
  complaint) and into a purpose-built **farm pen** (`PEN`, sited by `findGreen`):
  a 36×28 m green with a low white rail fence in collider chunks, a 6 m gate
  gap, a little red barn, hay bales and a MAPLE FARM board. The chicken AI is
  unchanged — `flockHome()` returns the pen, with the castle hall as fallback
  if the pen ever fails to find a site. The castle stands empty (its gate and
  hall remain).
- **YARD SOAKER — SHELVED.** The prison-break minigame (orange-jumpsuit runners
  planting wall charges, blown breaches, the super soaker with reticule, water
  jet and depleting tank bar) is fully built but **spiked by design decision**:
  its giver, Warden Norris, is commented out in the markers block, which makes
  the mission unreachable while every piece of machinery (`soak` def,
  `spawnSoaker`/`updateSoak`/`blowWall`, the gun, reticule, tank bar, round
  lockdown/eject) sits dormant behind it. Un-comment the marker to revive it.
  The Penitentiary's **portcullis gate stays live** in free roam, and it is a
  one-way door with a joke attached: **F at the button outside** raises the bars
  for free, but the gate drops behind you, and from *inside* the yard the button
  does nothing — a **guard** leans on the bars and wants **25 coins** to let you
  out ("GUARD: THAT'LL BE 25 COINS" if you're short). Easy to get into, costs you
  to get out of.
- **DEMOLITION DERBY** (Crusher, at Victory Stadium) — 3 AI rigs (`t.derby`
  traffic entries, off the graph, no rejoin) chase and ram you on the infield;
  ram them back — damage ∝ impact speed, one full-speed hit wrecks one — until
  all three are smoking hulks. Derby hits build no heat and your car takes
  reduced self-damage against rigs, or attrition loses the bout for you.
- **BACK ALLEY DASH** (Tire-Iron Tess, beside the grid) — a ten-checkpoint lap
  of the town streets against **three named AI rivals** (Duke, Mavis, Spanner),
  who line up alongside you on the grid and drive the same course. The circuit
  is stitched out of the road graph itself: checkpoints are graph *nodes* and
  every leg is a real edge between two of them, so an AI that simply steers at
  its next checkpoint is driving down a street rather than through the front
  rooms. A greedy walk picks long legs heading away from the start, then curls
  back to close the loop. Rivals scrape walls (losing speed, and nudging their
  aim past the corner if they hang there), run people over, and can be rammed
  like any traffic. Your **place is live in the HUD** — 1st through 4th, counted
  from how many rivals are further round the lap. Win 400, podium 140/100;
  leaving the car or letting all three finish first fails it.
- **RING RUSH** (Axel, near the spawn street) — 8 checkpoints around the ring
  highway (highway nodes filtered to the outer loop, sorted by angle), one lap
  through the tunnel vs a par from the octagon perimeter; session best tracked.
- **THE GETAWAY** (Lefty Louie, outside the prison walls) — drive a bag across
  town on an instant three stars, and the heat is *pinned* to at least one star
  until you arrive, so there is no lying low. The wanted bonus means delivering
  hot is the whole payday — a clean three-star drop pays 2.5x.
- **SCRAP RUN** (Scrappy, at the stunt park) — launch six traffic cars in 80 s,
  counted at the same >14 mph threshold that lifts a corner (`lift > 0` in the
  ram code), so taps don't score. Cops, derby rigs and race rivals are excluded.
  Runs the big round clock like Feather Frenzy.
- **RIDE INSPECTOR** (Inspector Pru, at the fair gate) — on foot: sit six
  seconds on each of the three rides. The coaster runs its own schedule, so
  catching it in the station is part of the job. The guide arrow walks the
  inspection, aiming at the nearest ride still unridden.

The stunt park and the fair pick their sites with `findGreen`, which runs after
the marker block — so their givers (Scrappy, Pru) can't be placed with the rest.
The marker builder escapes through the `addJobMarker` hook instead of hoisting
its dozen block-local helpers.

Jobs that are about driving carry `needsCar` and **refuse to start while you are on
foot** ("YOU NEED TO BE IN A CAR") rather than handing you a timed delivery you have
no way of making. **Which means their giver has to stand somewhere a car can get to.**
`clearSpot` on its own only promises the giver is standing somewhere *legal* — and the
middle of a back garden, walled in by houses, is legal. For a job that will not start
unless you are behind a wheel that is a dead end: you can walk up and talk to them, and
never once arrive in the thing they are asking for. Car jobs now also require
`drivable()` — a town street within 26 m, and a clear straight run from the kerb to the
spot, sampled every 1.5 m against the collider list. **Axel (RING RUSH) was the one this
caught**: he stood at 112,-207 with a house between him and the road, and now stands
10.5 m away with a clean approach. If nowhere drivable exists at all the search falls
back to the plain one, because a giver standing slightly oddly beats a mission nobody
can reach.

`CAR_JOB` duplicates the `needsCar` flags because markers are placed long before
`MISSION_DEFS` exists; a startup assertion cross-checks the two, so a drift shows up in
the console rather than as a giver you can never get to. **Which means their giver has to be somewhere a car can get to.**
`clearSpot` on its own only promises the giver is standing somewhere *legal* — and the
middle of a back garden, walled in by houses, is legal. For a job that will not start
unless you are behind a wheel that is a dead end: you can walk up and talk to them and
never once arrive in the thing they are asking for. Car jobs now also require
`drivable()` — a town street within 26 m, and a clear straight run from the kerb to the
spot, sampled every 1.5 m against the collider list. Axel (RING RUSH) was the one this
caught: he stood at 112,-207 with a house between him and the road, and now stands 10.5 m
away with a clean approach. If nothing drivable exists at all the search falls back to
the plain one, because a giver standing slightly oddly beats a mission you cannot reach.

`CAR_JOB` duplicates the `needsCar` flags because markers are placed long before
`MISSION_DEFS` exists; a startup assertion cross-checks the two, so a drift shows up in
the console rather than as a giver nobody can get to. Failure is wired through `missionEvent()`: wrecking your car, getting busted, or
R/reset all fail the active job cleanly — and then the **retry guide** takes over:
the giver re-arms in 2.5 s and the arrow, beacon, objective line ("TRY AGAIN ·
back to …") and radar blip all lead back to them until you're close or you start
something else. **Finding jobs on the radar**: available givers are red dots in
range, and when you're idle the nearest out-of-range giver clamps to the rim as
a lead; the gold pulsing blip is always the active target (or the retry point).
Unbroken **? crates are little wooden diamonds**, each fair ride is a **purple
dot**, and when the whole fairground is off-radar its site clamps to the rim as
a standing lead — the one landmark worth a permanent signpost.
All mission code runs **after the tree stage**, so none of it touches the seeded
stream — the audits are byte-identical.

**The run opens on foot outside a storefront door**, prompt already showing, with the
car parked on the street behind you — otherwise there is nothing telling you the interiors
exist. `OPENING_DOOR` picks the enterable door **nearest the plaza** (with commerce
scattered, a specific shop's copies can land anywhere; this seed opens at Tony's Pizza),
so the run always starts downtown. The spawn point is then the nearest clear carriageway
to that door. Point it elsewhere, or delete the `if (OPENING_DOOR)` block just above the
camera section, to go back to starting in the car.

Interiors are **modelled in place**. `makeShop` and `fillEvergreen` build those buildings
as shells with a doorway cut in the front wall, instead of the usual solid box. Three
things make that safe:

- **Walls you can't run through.** `collideCircle` has no swept test and `RUN * dt` is
  0.6 m in a single frame. The wall colliders are `WALL_T` thick which, with the 0.75 m
  probe radius, gives a 2.3 m overlap band — a run can't step over it. All four walls of
  every room are tested at run speed; each stops the player exactly one radius short.
- **Rooms trimmed to the clear part of the footprint.** Buildings in this town overlap.
  Harmless while both are solid, *fatal* once one is hollow: the neighbour's collider ends
  up inside the room, and `collideCircle` resolves to its nearest face — which shoves you
  out through your own wall. That is exactly how the first version leaked. So the deferred
  pass trims each room back off anything already standing inside it (never off the door
  wall) and puts a partition there. The far side of that partition is dead space nobody
  can reach.
- **A doorway chosen last.** Some of these facades have a neighbour's wall a metre off
  them. The doorway slides along the frontage until it has open ground outside, dodging
  windows on the way. If no spot works, or the trimmed room would be under 5 m, the
  building just stays solid — nothing half-built ships.

Both of those need to know what the rest of the town built, so shells are constructed
**after** the block loop, wrapped in `rngNeutral` (see the gotcha below).

The chase camera inside a room walks the **sight line** from the player toward where it
wants to be and stops at the room boundary — an axis-by-axis clamp would slide it sideways
behind a partition. A doorway is treated as a hole, not a wall, so standing just inside a
shallow shop the camera sits out in the street and looks in through the door, which is
what it should do. `roomT` ramps the camera distance in across the threshold.

### Minigames in the shops: putt & bowl
The fit-out pass records real play sites as it builds the rooms, and two shops
became playable (`PUTTS`/`BOWLS`, the MINIGAMES section). Free play paid in
coins, like Gus's garage — not missions.

- **Putt Paradise has real holes.** The black cups the fit-out was already
  drawing are recorded in world space, and a ball waits at a tee by the door.
  **R-click (the kick) putts it** along your facing; it rolls with friction,
  bounces off the room and the furniture (axis-aligned reflect off the same
  `walls` boxes the audit uses), and **drops when it dies near a cup** — HOLE!
  +8, COURSE CLEAR when you've sunk them all, ball respawns at the tee.
- **Strike City's first lane is live.** That lane skips its baked pins and gets
  a real rack of six (meshes that tip over, not vanish), a tee where the staff
  bowler used to stand, and a ball. **F at the tee bowls**; your facing leans
  the shot off the centreline (blended, not rotated — a blend cannot get a
  sign wrong), so squaring up matters: STRIKE! pays 40, pins pay 4 each, and a
  wild aim is a GUTTER…. Pins reset after a couple of seconds.

Both copies of each shop get the treatment (SHOP_NAMES cycles), so there are
two courses and two lanes in town.

### Coins in shapes
The block loop drops a handful of coins into every landmark and yard, which is fine but
reads as confetti — nothing about where a coin sits tells you anything. Two structured
sets now sit on top of that: a **ring of eight around a tree**, on ten trees spread at
least 150 m apart so they read as landmarks rather than a clump, and **a run of seven
straight down the middle of a street**, which you take in one pass at speed. The road
rows are deliberately *not* filtered against `onRoad` — being on the carriageway is the
entire point. Total went 129 → 288.

The scattered ones are untouched, and deliberately so: they are placed during the block
loop, and changing how many randoms that loop draws would re-roll the whole town. The
structured pass runs after the tree stage — so `treeSpots` is already filtered down to
the trees that actually exist — and after every canary is computed, which is why it can
draw from the seeded stream freely.

### ? crates
A wooden crate with a question mark on every side sits in the back garden of about
half the houses — 66 of them. Boot it, punch it or drive through it and it bursts, and
what comes out is the point:

| | | |
|---|---|---|
| **60%** | coins | six, popped out on an arc |
| **10%** | jackpot | sixteen, and a banner |
| **25%** | bomb | a short fuse, then it puts you on the floor |
| **2.5%** | a cat | wants nothing to do with you and leaves |
| **2.5%** | a dog | decides you are its person and will not be talked out of it |

The brief specified 60 / 25 / 2.5 / 2.5, which leaves ten points unspoken; a jackpot is
the most useful thing to do with them, because *sometimes a lot* is what makes opening
the next one worth doing.

The bomb hurts whoever is standing nearby as well as you, which is the reason to lure
someone next to one. The dog holds a couple of metres back so it isn't inside you, and
gives up trying to keep pace with a car — it just watches you go. Both animals are
Groups rather than instances: at 2.5% you will meet a handful in a playthrough, and a
draw call each is the right price for that.

**Loose coins** are the same mesh and the same collect loop as the placed ones, but they
arrive with a velocity and land. The pool is a fixed ninety on the end of the coin array,
recycled round-robin, so the instance count never changes — the alternative is growing a
buffer mid-game. Knocking over a **bin** spills two or three of them too, which is the
small reason to clip every one you pass.

### Coins are for spending
**Gus's Garage** is a real building just up the street from the spawn: a
**pull-through service bay** — a 22 m canopy on four posts with an office and
windows along the back, a concrete apron and the name on the front fascia. Only
the posts and the office are solid, so you drive in one side and out the other.
Its site is found by a footprint search (the whole 22×13 rectangle sampled against
roads, buildings and the river), not by `clearSpot`'s 2 m probe, which would happily
drop a building on a carriageway. It is *not* a mission: walk into the bay and a
keyboard menu opens, number keys buy, walking off closes it, and it never blocks
or shares state with an active job.

| # | Buy | Effect |
|---|-----|--------|
| 1 | **ENGINE** ×3 — 150 / 400 / 900 | top speed 42 → 63, acceleration 32 → 50 (`MAX_SPEED`/`ACCEL` are `let` for this; everything reading them is written as a fraction of `MAX_SPEED`, so steering authority, the FOV stretch and the camera pull-back all scale for free) |
| 2 | **ARMOR** ×3 — 120 / 320 / 700 | damage taken ×0.72 / ×0.5 / ×0.32 (`armorMul` in `damageCar`) |
| 3 | **AIR HORN** — 200 | **H** blasts a chord; every pedestrian within 30 m bolts and the castle flock scatters. Feeds the combo |
| 4 | **NEW RIDE** — 250 | cycles your car through all five body types in a fresh colour |

**Thirty-five trophies, one hidden in every walk-in room.** The furnished interiors
were beautiful and pointless; now each holds a gold trophy tucked in the corner
*furthest from its own doorway*, skipping any spot the fit-out registered as solid.
They only count **on foot** — a trophy is a reward for going inside, not for driving
past — and pay 40 coins each, with a 1000-coin bonus for clearing all thirty-five.
The HUD keeps a 🏆 count under the chaos score. One InstancedMesh, like the coins,
built well after the tree stage so it costs nothing seeded.

### The fair
Three rides — striped-canopy **carousel** with eight bobbing horses (clockwise;
and note the group-rotation trap below) and a walled **bumper car** arena under
the MAPLEWOOD FAIR board, plus **THE MAPLE MOUSE**, which outgrew the fairground
and stands on its own ground nearby.

**THE MAPLE MOUSE is a real coaster now** (its own block, after the fair): a
~480 m closed CatmullRom track on a ~124×86 m footprint with a **traditional
profile** — a flat station run, a slow chain lift all the way to a 26 m crest,
then gravity owns it: the big drop, a slalom of twists, a **full circle that
passes under its own way in**, two more hills, and a braked run home. The cart
runs three regimes (`phase` in `updateRides`): the chain hauls at 3.6 m/s,
coast speed comes from energy (√(2g·(top−y)), floored so it can't stall), and
brakes bleed it to walking pace into the platform. **The site is chosen by
validating the track's own plan path, not by clearing a rectangle**
(`pathOK`): the loop's interior keeps its trees — the track flies over — but
every sample under 14 m must clear roads (5 m margin), water, buildings and
colliders. That is what actually got it off the carriageway that the old
reserved-rectangle siting let it clip. Candidates spiral out from the fair, so
it lands as close as the town allows. This seed parks it around First Church,
which is zoning nobody planned and nobody is going to fix.

**The bumper arena is 44×32 m** (doubled) with **eight cars, and every cart but
one has a rider in it** — a seated passenger merged into ~4 meshes per colour
(thighs folded, arms on the wheel), built from `pickLook`'s palettes. Boarding
always puts you in the free cart (`freeSeat`), never in somebody's lap.

**The coaster rails are continuous tubes** — a closed CatmullRom through offset
samples of the track curve, swept as `TubeGeometry`. They used to be chains of
straight boxes, which from the front seat read as exactly that. Ties and posts
are still boxes; only the rails needed to be seamless. And **the station has
stairs now**: the platform used to be a solid collider nobody could climb. It
is a walking surface instead — a `DECKS` entry raises `surfaceY` over the
boards, a rising wedge does the stairs (same philosophy as the ramps: part of
the ground, never a collider), with treads and handrails as visuals.

**The coaster runs a schedule.** A platform with a canopy stands beside the track at
t=0 — both hill terms are zero there on purpose, so the train arrives at platform
level — and the cart starts docked, waits ten seconds, runs its lap (~20 s), and pulls
in again. **You can only board in the station**: the ride point sits on the platform,
`tryRide` refuses while the cart is out, and the prompt says "The MAPLE MOUSE is out on
the track…" instead of offering an F that would do nothing. The clock runs whether
anyone is aboard or not — it is a fairground ride on a schedule, not a taxi. Riding, you
stay in the seat through the dwell, so staying on for another lap is just not pressing F.

**The two wall reflections are not the same formula** (this is what made the bumper
cars read as broken): a side (±x) wall negates the x of the heading, yaw → −yaw; an end
(±z) wall negates the z, yaw → π − yaw. The first version used π − yaw for both, so a
car angling into a side wall kept its x-motion pinned into the wall and ground along
it, jittering, for ever. And the **ridden car never gets its yaw flipped at all** — in
first person a forced 180° on every wall kiss or collision reads as the camera
breaking. Your car just loses most of its speed and takes the thump; the AI cars still
bounce and spin.

**The group-rotation trap** (this bit ate the first carousel): a Group's `rotation.y`
of θ carries a child at local angle *a* to **world angle a − θ, not a + θ**. The seat
camera added, so it orbited against the platform and the horses paraded around the
rider instead of carrying him. If you ever attach a camera to something on a spinning
Group, derive the world angle by *subtracting* the group's rotation. Walk up to any of them and **F** puts you
**in the seat, first person**: the camera rides the horse, the cart or the car, the
mouse still looks around on top of wherever the ride is pointing, and F gets you off.
(The brief said click, but left click is the punch and right click is the kick — F is
already the game's one interact verb.) On the bumper cars you steer yours with WASD
while the other five wander and ram you; wall hits turn you round rather than stopping
you, and car-on-car hits ding and kick both shells. While riding, the player's position
rides the seat too, so the radar and everything else that reads `sub` follows you round
the track. Punch and kick are disabled mid-ride.

**Finding the ground was the actual work.** The fair wanted "the biggest unused green",
and the obvious tool — the zoning — turned out to be a lie: this seed has **no `park`
block at all** and its one `plaza` is 286 m². Which surfaced something worse: the stunt
park had been filtering for the same zones, and had been silently building **nothing**
since the seed re-roll. Four ramps the README described did not exist in the game.
`findGreen(w, d)` fixes both: a coarse occupancy grid of every building footprint and
every planted tree, plus the road and river tests, scanned for the most central
rectangle that is genuinely empty; whatever it hands out is reserved so two set pieces
cannot land on the same green. The stunt park is back (4 ramps) and the fair sits on
the next-best open ground.

### The stunt park
The biggest open green in town has four orange kickers in it. They are **not
colliders** — a ramp is a wedge that raises `surfaceY` over its footprint (see
`RAMPS`/`rampY`), so the existing altitude code does all the work: the car rides up
the slope, and the instant it runs off the lip `surfaceY` drops away, `carVY` takes
over and it is genuinely airborne, landing on the heightfield like any other drop.
Making them colliders instead would just give you four walls to crash into.

**The lip throws you now.** The slope the car was just climbing, times its
speed, becomes its vertical velocity the moment the ground drops away
(`groundSlope`/`lastGy` in the altitude block, capped at 24 m/s). Before this,
`carVY` started at 0 off every lip, so "air" was just falling from ramp height
— the reason ramps never felt like they gave any.

**Air pays now.** While the car is off the ground a stunt clock runs (`airT`/
`airPeak`/`airSpin` in `updateCar`, banked by `landStunt`): air time and peak
height pay flat points into the combo — flat, not multiplied, the multiplier is
for wrecking things — and winding the wheel mid-air pays a spin bonus per
quarter turn (steering deliberately has no ground check; that *is* the trick
system). Tiers toast as NICE/BIG/HUGE AIR, 360s get named, and a rising
arpeggio plays. Kerb hops (under half a second or under knee height) are free,
so ordinary driving never toasts. A landing draws a fraction of the heat a
wreck of the same worth would. The nose follows the arc mid-air — which needed
the car's Euler order switched to YXZ, because with the default XYZ the pitch
axis is the world's and a car heading along x rolls instead (with pitch 0 the
two orders compose identically, so nothing else moved).

### Day and night — SHELVED
**Off by default** (`DAY_CYCLE = false`): the town reads better in permanent
daylight, so the clock is frozen at its construction-time noon and `nightAmt`
stays 0, which switches the headlights off with it. Flip the flag to revive it.
One clock (`updateSky`, five real minutes per day) drives the sun's elevation and
colour, the hemisphere fill, the fog colour *and* its near plane, and the tint on
the sky dome — so dusk reads across the whole town at once instead of as a filter
laid over it. Three colour keys (day / dusk / night) are blended by two ramps taken
from the sun's elevation, which is what keeps the warm horizon band from appearing
at midnight. Fog closes in after dark, so the town gets smaller and more claustrophobic
at night. The interiors were already lit by their own lamp, and they now glow properly
through open doorways once it's dark — the best free scenery in the game.

**Headlights** come on with `nightAmt`: two soft beam cones plus a single spotlight
(one, not two — a second shadow-casting spot doubles the cost for a symmetry nobody
looks at). The cones are what actually sell it; in flat toon shading, volumetric-looking
light reads better than a brighter patch of ground.

**To do** — lit windows and Club Inferno coming alive after dark; wanted
escalation (roadblocks, spike strips); reviving the shelved prison minigame in
some better form. On the graphics side: authored GLTF props (sparingly — the
code-built box aesthetic is a genuine strength), LOD. (Stunt scoring, the
river's water shader and rim lighting all shipped 2026-07-22.)

## How it's drawn
Everything is `MeshToonMaterial` on a 3-step ramp. **The ink outlines are a
post-process**, not geometry.

**The river is the one custom shader in the game** (`riverWater`, in the river
block): four summed sines drifting downstream over world xz, a finite-difference
normal quantized to three hard toon bands, stepped sun glints and a fresnel lift
toward the sky. The normals are deliberately over-steep — a physically-sized
ripple quantizes to a single toon band and the river reads as paint again, which
is exactly how the first version failed. Transparent with `depthWrite` off, so
the ink pass ignores it like the material it replaced. Its `uSun` uniform holds
the `sunDir` vector by reference, so it would track the shelved day cycle for
free. `uTime` is fed in `animate`.

**Characters and cars carry a rim light** — a thin bright edge where the surface
curls away from the camera, injected into the toon shader via `onBeforeCompile`
(`addRim`): one smoothstep on the view angle, tinted mostly by the surface's own
instance colour so a pink car rims pink. The scoping is the real work: the crowd
gets its own shared white material (`crowdToon`) instead of the `toon()` cache's
white, and the vehicle dark/chrome materials left the cache too, so the rim
lands on people and cars and never on buildings or street furniture, where it
reads as frost. Patched materials share one program via `customProgramCacheKey`.

**The ink pass.** Outlines used to be a back-face shell mesh per object — a second
copy of the geometry pushed out along its normals and drawn in flat ink. It looked
right, but it duplicated the draw of the 1,400-person crowd, all the traffic and all
~1,650 trees, and it could only ever draw a *silhouette*: a box seen face-on had no
lines on it at all. It is now a screen-space edge detect over the depth buffer the
scene render already produced (`InkPass`, in the POST section).

The test is the **second difference** of view depth across a pixel, not the first. A
first difference lights up any receding surface — the whole road ahead of you. The
second difference is zero across a flat plane *however steeply it leans away*, and
spikes only where the surface genuinely breaks. That is what separates a silhouette
from a floor. It also draws interior lines, because a crease between two flat faces
is a break in the depth **gradient**: kerbs, window reveals, roof ridges, the corner
where two walls of a room meet — detail the shells could never see.

Measured at the spawn, per frame: **489 draw calls / 22.9M vertices, down from
553 / 32.0M** with the shells. A depth *and* view-normal version was built first and
thrown away: the extra full-scene render into a normal buffer cost 917 calls / 46.6M
vertices — far more than the shells it was meant to replace — for a marginally
cleaner crease on shallow angles. The depth buffer this reads is free.

Two things the pass depends on:
- **Nothing transparent may write depth.** Every transparent thing in this game —
  glow discs, beacons, headlight cones, billboard signs, the sky dome, car glass —
  stands in for light rather than for mass, and a free-standing billboard that stamps
  its quad into depth comes back as an ink rectangle floating in mid-air. `tagNoInk`
  walks the finished scene once and sets `depthWrite = false` on all of them (it is
  called again for a new car rig from the garage). Transparent materials have no
  business writing depth anyway.
- **`composer.setSize` takes CSS pixels** and applies the pixel ratio itself, so a
  pass's own `setSize` receives drawing-buffer pixels. Multiplying by the ratio at
  the call site makes every sample offset sub-texel and the lines simply never
  appear — which looks exactly like a broken shader.

Lines fade out between 150 m and 340 m: a one-pixel line on a townsperson 300 m away
is a crawling speck, and the fog has taken them anyway. The map view (near plane 250)
therefore has no ink, which is what it wants. `thickness` is in **CSS** pixels, scaled
by the device ratio, so a line is the same weight on a retina display as on a plain
one. The whole thing is live under **Ink outlines** in the G panel, including an
on/off toggle for A/B and a `show buffer` view that dumps linearised depth or the raw
edge mask to the screen — how the sub-texel bug above was found.

**Surfaces.** Flat colour was the house style, but a whole town of it read as plastic:
standing in the street, nothing told you a wall was brick rather than painted board.
Walls, roofs and floors now carry small **procedural canvas textures** — mortar courses,
shingle tabs, lap siding, render speckle, checkerboard tile, floorboards — drawn
near-white so the bucket's own colour tints them, and hung as `map` on the same toon
material. No assets, nothing to download, and the flat-shaded look survives intact.

Two things make it work:

- **The UVs are generated at flush time, not taken from the geometry.** A BoxGeometry's
  UVs run 0..1 per face, so brick would stretch to fit each surface — eight courses on a
  3 m wall and eight on a 30 m one, which is the thing that reads as fake fastest.
  `projectUV` instead projects every triangle onto the world plane its normal points at.
  Merged town geometry is already in world space, so this is a straight read of position:
  no shader, no per-face bookkeeping, and the brick is the same size everywhere in town.
- **Buckets key on colour *and* surface.** A brick wall and a painted one can share a
  colour but not a material, and merging them would put mortar courses on the smooth one.
  An untextured `put` keeps its plain colour key, so nothing that doesn't ask for a
  surface pays for one.

**Which house gets which surface is a hash of its own coordinates** (`vary`), never a
draw from `prng()` — one extra random in the generator and the whole town re-rolls. Same
house, same brick, every load, for free. Brick houses also override the pastel wall
colour they were dealt with a brick palette, which costs nothing for the same reason:
`rpick(WALL_COLS)` still happens, brick just ignores the result.

**The characters.** The crowd is ~20 InstancedMeshes, one per body part, so the cheap
place to add detail is *inside the existing geometry* — a merge costs vertices once at
build time and nothing per frame, while a new part costs a draw call across up to 1,400
people. So: the skull gained ears and a **neck**, and the neck is the one that does the
work — without it the head visibly floated above the collar. The torso gained a collar
band, a shoulder shelf and a shirt hem overhanging the trousers; all three are boxes,
because the torso is scaled on X per person and anything round in it squashes into an
ellipse. Two parts were worth their own draw call: **eyebrows** (hair-coloured — two
small wedges are the cheapest expression in the game; without them a face is two eyes
and a mouth and the whole crowd reads blank) and **hands**, which used to be merged into
the sleeve and were therefore the colour of their owner's shirt. Both hands share one
mesh at twice the capacity — a left and a right hand are the same object with different
matrices, so two draw calls would buy nothing — and they are drawn with the arm's own
matrix, so they swing for free. The **pupils wander**: same mesh, parked a few
millimetres off centre on each person's own phase, which costs nothing and stops
fourteen hundred people staring dead ahead in unison. The hero is built from the same
geometry, so he doesn't look like a visitor from another game standing next to a
townsperson.

*(One trap: the skull must stay a true sphere at r 0.28. Egg-shaping it by 6% in Y
pushed the crown through all nine hairstyles, which are cut to fit that radius.)*

**Wardrobe.** On top of the nine hairstyles: **beanies, fedoras and hard hats**, each
with its own palette (knitwear, felt and hi-vis do not share one), and each with a
silhouette that reads at fifty metres — a roll, a brim, a peak — because at that range
the colour is all you get. A hat *replaces* the hairstyle mesh rather than sitting on
top of it: one instanced mesh per head is the whole design, and a fedora over an afro is
a clipping fight nobody wins. About a sixth of the town wears **glasses** (their own
mesh, sitting on the front of the eyeballs, which bulge proud of the face — a ring at
z 0.33 clears a 0.175 eye centred at 0.185 with millimetres to spare). And a third wear
**striped shirts**: the same torso geometry under a stripe texture, tinted by the same
instance colour, so it is a whole second wardrobe for one draw call.

All of it rolls on `Math.random`, not `prng()` — crowd looks were always deliberate
runtime variety (the `female` roll has been on `Math.random` from the start), and the
seeded stream must never see them.

**The detail pass.** Every primitive that was meant to be round now is: cylinders and
spheres swept up to 16-28 segments, cones to 16 — *except* cones with four or fewer
sides, which are deliberate pyramids (the church steeple, the prison gate caps, the
guide arrow) and were left alone. On top of that, the things the camera spends its
time on got real geometry: car wheels have 28-segment tyres, rims, three spokes and
an arch lip so the body no longer hovers over them; trees went from three lobes to
five plus a flared root and a branch stub; the crowd gained hands, rounded shoe toes
and a 22x16 head. Roughly 70 primitives rounded out.

**Buildings** got the same treatment, and they are the cheapest place in the game to
spend detail: houses and shops are merged into colour buckets, so trim costs vertices
once at build time and nothing per frame. Houses gained a plinth course, eaves fascia,
a recessed door frame with a visible knob, and — the change that does the most work —
window **sills and mullion crosses**, which is what stops a window reading as a flat
blue rectangle. Shops gained a cornice under the parapet, a sloped awning on brackets
in place of the old flat lip, mullions dividing the glazing band, a kick plate, and
rooftop plant boxes and a vent so the skyline has something to bite on.

All of it is derived from each building's own `w`/`d`/`h` with **no `rnd()` anywhere**,
which is why the town stays byte-identical through the whole pass.

This pass is only cheap because of the private-PRNG work: geometry no longer draws
from the town's stream, so poly counts can change freely and the build stays
byte-identical (`spawn 145,-197`, `trees 1641/176`, 43 rooms — verified before and
after). Under the old scheme every one of these edits would have re-rolled the town.
The same is true of *deleting* geometry: ripping out ~14 outline wrappers, the door
ink InstancedMesh and every per-mesh shell moved no canary at all.

Crowds, traffic, trees, props, coins and signals are all `InstancedMesh`. Buildings
are bucketed by colour and merged, so the whole town is a few dozen draw calls.

## Simulation
- **Ram a car and it goes flying.** Above about 14 mph of impact the hit stops being a
  shove and starts lifting a corner: vertical velocity, pitch and roll tumble, one
  bounce on landing, then the tyres bite and the body rights itself. All of it scales
  from nothing at that threshold, so a nudge in traffic still just slides the car and
  only a real ram sends it barrel-rolling. Gravity is the same 26 the player's car falls
  under, so a launched traffic car and a launched player car read as the same world. A
  car is never handed back to the road graph while it is still airborne or mid-flip —
  the knock extends itself until it is down and level — because a car righting itself in
  mid-air, then snapping to a lane, is worse than no physics at all. Traffic has no
  wreck state, so a car resting on its roof would block a lane for ever; that is why it
  levels out rather than staying inverted.
- **Traffic has a jam breaker.** Gap-following on its own deadlocks: a queue that
  backs through a junction blocks the cross traffic that would have cleared it, and
  anything parked in a lane — a wreck, or your own car — stops that lane for good,
  because an AI car is pinned to its edge and cannot steer around. So a car at a
  crawl for 5 s gives up on whatever is in front and *commits* to pushing through
  for 3 s. The commit is the point: without it one frame of movement resets the
  timer and the car drops straight back into the queue, stuttering instead of
  clearing. Signal patience also dropped from 26 s to 14 s. Measured with the
  player's car parked in a live lane: stopped cars peak around 24 of 165 and then
  recede, and no cluster within 60 m ever exceeds two cars
- Traffic drives a road graph built from the grid, obeys the signals, queues, and
  **yields to pedestrians** (judged by lateral offset, not an angular cone) — and
  that includes **you on foot**. The player isn't in `pedGrid`, so for a long time
  cars simply shoved you down the road instead of braking; stepping out in front of
  one is now a carjack rather than a mugging
- **Nobody walks the ring highway.** `pickNext` is shared with the cars and happily
  turns a walker onto a spur, so peds route through `pedNext`, which refuses highway
  edges and turns around at a highway-only junction. `attachPed` falls back to the
  town street list rather than whatever edge is nearest
- Pedestrians walk sidewalk lanes, round corners, and cross at the painted zebras
  when the signal holds the traffic they'd step in front of. **Nobody walks single
  file**: each person owns a lateral lane across the pavement width (`p.lat`, derived
  from their walk phase so it costs no seeded randoms), and crossings start and end
  at that same offset. **Some head for the park**: a once-a-frame lottery peels a
  pedestrian near a park, riverside green or the plaza off the pavement into a
  *stroll* — free movement toward a clear patch of grass, a couple of legs, then
  `attachPed` back onto the nearest lane (capped at ~130 strolling at once).
  Kicks, cars and scares interrupt a stroll exactly like lane walking; `attachPed`
  clears the state. Strollers may jaywalk, but cars yield to anyone in their lane, so
  one ambling *along* a carriageway is a rolling roadblock — a stroller on tarmac for
  more than ~4.5 s gives up and rejoins the pavement
- **Nobody walks through a car or a lamp post any more.** The crowd separated from
  *itself* but never from the *things*: lane walkers are re-placed from the road graph
  every frame and were never tested against traffic, the parked player car or street
  furniture, so people strolled clean through a queue of cars. `pedsVsSolids` pushes
  them out — oriented-box for cars (same frame maths as `collideTraffic`), circles for
  bins, hydrants and lamps — and writes the push into `p.ox/p.oz` so `pedPlace` doesn't
  wipe it next frame, the same rule every other shove follows. Scoped to a bubble round
  the camera (120 m for cars, 90 m for props): an overlap nobody can see costs nothing
  and fixes nothing, and it resolves the moment you approach. Verified by parking the
  player's car dead on a walker (pushed out to exactly half-width + shoulder) and a
  town-wide sweep: 0 car overlaps anywhere, 0 prop overlaps inside the bubble
- Spatial grids for pedestrians and props keep collision checks local

## Gotchas for future work
- **The town seed is a private stream — three.js can no longer touch it.** This used
  to be the single biggest tax on the project: `Math.random` itself was overwritten and
  seeded, but three.js draws four randoms from it for every geometry, material and
  Object3D UUID, so *object count was part of the town's seed* and adding a building
  moved the trees. Now the generator draws from `prng()` and three.js keeps the real
  `Math.random`. **Create as many objects as you like, wherever you like — the town does
  not move.** Verified by building 18 spare geometries/materials/meshes immediately
  before the tree stage: the build logs came out byte-identical.
  `rnd`/`rpick` and every generator call site route through `prng()`; anything still on
  `Math.random` is deliberate runtime variety (traffic spawns, ped decisions, crowd
  looks) where a fixed sequence would be worse. If you add generator code, use `rnd`,
  `rpick` or `prng` — a bare `Math.random()` there is a non-deterministic town.
  `rngNeutral` survives for the few places that deliberately rewind the stream, but it
  is no longer load-bearing, and the old `lastPut`/`withdraw` and build-then-discard
  dances are now belt-and-braces rather than necessities.

  *(Historical note, kept because the scars are all over this file: under the old
  scheme, deleting one `put(BOX(...))` moved the tree audit from `1765/48` to
  `1767/51`.)* Deleting one
  `put(BOX(...))` moved the tree audit from `1765/48` to `1767/51`. If you must change a
  building part in the generator, change it in place — keep the object count and the set
  of bucket colours identical — and check the three build logs still read
  `spawn 145,-197`, `trees: 1641 planted, 176 removed` (planted+removed = **1817** — that
  total moving is the true stream-shift alarm; planted/removed alone redistribute when
  colliders or road layout legitimately change), `structures overlapping roads: {}`.
  (Baseline re-recorded 2026-07-22 for the private-PRNG switch — the last re-roll
  this project should ever need, since object creation can no longer move the town.
  This roll is also the cleanest yet: the city audit prints **all zeros**, including
  `housesCrowdingShops`, which had been a known accepted deviation for weeks. 43
  walk-in rooms, up from 35.)
  Anything built after the tree stage (doors, room fit-out) is free of this.
  Two tools make this workable when you *must* change generator geometry:
  `rngNeutral(fn)` snapshots and restores `__seed` around anything you build, and
  `lastPut`/`withdraw` let you build a solid part exactly as before — paying its RNG cost —
  then quietly withdraw it from its colour bucket. That pair is how the walk-in shells
  replaced five solid buildings without moving a single tree.
- **The BUCKETS flush itself burns randoms, and it runs before the trees.** Each
  non-empty colour costs a merged geometry, a mesh and (for a colour never seen by
  `toon()`) a cached material — so introducing a *new colour* via `put()`, or emptying
  a bucket, shifts the stream even from inside `rngNeutral`. This is why the room
  furnishings have their own `FURN` buckets, flushed at the very end of the build
  inside `rngNeutral`, where any colour and any object count is free. If you add
  furniture, use `fput()`, not `put()`.
- `mergeGeometries` returns **null** unless every input agrees on indexing *and*
  attribute set. `put()` and `merge()` normalise for this — a non-indexed roof prism
  without UVs silently broke the whole build once.
- Ground quads must be wound counter-clockwise seen from above or
  `computeVertexNormals` points them down and they vanish.
- The river is cut **below** ground and bridge decks stay at y=0, so crossings work
  without the car ever leaving the ground plane. The same trick inverted makes the
  tunnel: a hill raised over a flat road. **Nothing organic may cross the tunnel's
  bore corridor**: an ellipsoid lobe that straddles the road inevitably dips its
  tapering tail inside the tube near the mouths, which reads as a green wall while
  driving through — so the mass over the road is angular (a prism cap whose base sits
  above the vault crown, on flank walls that stop outside the tube) and the soft
  lobes are outboard shoulders only. The bore itself is two overlapping open-ended
  half-cylinder vaults (DoubleSide, one per road segment, following the ring's bend)
  with lamps down the crown, and the woodland belt is filtered out of the tunnel zone
  (`nearTunnel` in the tree filter) — the mountain has no colliders, so trees
  otherwise grow through it and dangle canopies inside the bore. The tunnel block is
  deterministic (no rnd), so reworking it never reshuffles the town. Bridge piers
  keep their tops at y=0, just under the deck: centred higher they poke through the
  tarmac, which the meander-clip decks made obvious as grey bumps on dry streets. Because of this the ground is built as
  strips with a gap along the channel — a single ground plane just covers the water.
- Junction pads are **discs**, not squares: streets meet at arbitrary angles now.
- **Traffic braked for signals at every node**, but signals only exist at junctions with
  three or more ways out. On the town grid that was masked; on the ring highway every
  node is a plain deg-2 joint, so cars on wrong-axis segments parked for up to 26 s at
  each one and the highway looked frozen. Stopping now requires `!edge.hw` and
  `node.e.length >= 3`. Town queues still form; the highway never stops.
- **A bridge is any stretch of carriageway with water beneath it** — not "a street
  whose ends are on opposite banks". The endpoint-sign test missed every segment that
  clips a river meander and comes back out on the same side: the ring highway did it
  twice, two town streets did it near junctions, and two junction *pads* stood partly
  over open water. Now: classic crossings (ends on opposite banks) are built exactly
  as before — that code precedes the trees, so its RNG burns are load-bearing — while
  meander clips get their decks inside `rngNeutral`, with the rails/piers normalised
  to non-indexed at creation (otherwise `merge()`'s per-entry `toNonIndexed()` burns
  randoms *outside* the snapshot at flush time — that one cost two trees). Wet
  junctions get a zero-length BRIDGES capsule (`onBridge` clamps `t`, so it reads as
  a disc) wide enough to cover the junction's 16.5 m walk disc. New capsules carry
  `soft: true` so the bank-fence gap pattern — whose colliders the tree filter feels —
  stays byte-identical. Rails are built in short runs that skip road crossings (and,
  on clip decks, building footprints), and **railings are real colliders** — they used
  to be decoration, and walking through one off the deck was a genuine way to drown.
  Rail colliders are collected during the river pass but pushed only after
  `cityAudit()`, past every scatter filter, for the same baseline reasons. They are
  ~0.9 m sub-chunks inflated only to the rail's own half-width (0.25): the collider
  list is axis-aligned AABBs and every street is slightly diagonal, so longer chunks
  bulge past the rail and you hit an invisible wall a metre before the leaf.
- **The ragdoll get-up was unreachable for the game's whole life.** `updateRag`'s ground
  clamp sets `y = 0.35` on contact every frame, while the recovery lerp pulls `y` toward 0
  — the clamp always won, so the `y < 0.06` get-up condition never fired and nobody
  knocked down ever stood up again. Invisible for months because you drive away from your
  victims. Found the moment "they get up and run away" became a feature. The fix: once
  `settle > 1.6`, recovery owns the body and the physics (gravity, clamp, bounce) stops.
- `attachPed` rejoins a townsperson to the road graph **at the nearest point on the
  chosen street**, not at the junction node. Traffic's `rejoin` learned the same
  lesson: a knocked car used to snap to `dist 0` at the nearest node when its physics
  settled, teleporting every wreck you'd just rammed to the nearest corner — which
  read as cars vanishing. The other half of that bug: knocked cars ignored colliders
  and sailed straight through building walls into the interiors; knock physics now runs
  `collideCircle` with a small bounce, and the shove is strictly proportional to the
  impact speed. Snapping to the node teleported anyone who
  got up after a knockdown — they looked like they vanished. Related: knockdown victims
  ease to **flat** (`rag.flatX`) once down, face-down or on their back depending on which
  side the hit came from, instead of wherever their random spin left them.
- Lane-walking townsfolk are **re-placed from the road graph every frame** (`pedPlace`),
  so any push you apply to them must persist as an offset (`p.ox/p.oz`) or it is silently
  wiped next frame. The crowd-separation pass and the player shove both write it.
- **Traffic has exactly the same problem, and had exactly the same bug.** A car's
  position *and yaw* are recomputed from `(from, ei, dist)` every frame, so the instant
  a knock expired, whatever the physics had done was wiped: a car you had just rammed
  ten metres down the road blinked back into its lane, mid-frame. That reads in-game as
  "the car disappeared and reappeared somewhere else" — the same illusion the `rejoin`
  fix was meant to kill, one layer further up. `rejoin` now records the gap between
  where the physics left the car and where the lane wants it (`rox/roz/royaw`, plus the
  height and tilt) and the graph path adds that back, smoothstepped to zero over about
  0.6 s. The car visibly drives itself back into line instead of teleporting.
- Steering authority falls off with speed (`authority` in `updateCar`). Set too aggressively
  it made the car undriveable in town: at MAX_SPEED the turning circle was ~54 m, wider than
  a junction. It is ~29 m now. Measure it by sampling heading and position over a few frames
  rather than guessing — `radius = arcLength / deltaHeading`.
- The river fence must skip **building footprints (`mapBoxes`), not colliders** — a
  hollow shop has no collider in its middle, so `pointBlocked` happily let the fence run
  straight through the room. And the *whole chunk* has to clear the footprint, not just
  its midpoint: a 5 m chunk can straddle a corner. The `interiors` audit caught both.
- Barrier colliders are **short chunks (3.5–5 m)**, because the collider list is
  axis-aligned AABBs: a long box on a diagonal highway segment would have a bounding box
  bulging metres onto the carriageway. Short chunks hug the rail; the
  `carriagewayBlocked` audit is the proof it worked. They are pushed to `colliders`
  directly, not through `addBox`, so the radar and the overlap audit ignore them.
- **Every part of a shopfront that spans the frontage has to be dropped when the shop
  becomes a walk-in**, not just the body and the glazing. The mullions and the kick
  plate were left behind by the storefront-trim pass, and since the centre mullion sits
  at the middle of the frontage — where the doorway usually ends up — most walk-in shops
  had a dark bar standing in the open doorway and a sill across its foot, visible from
  inside and out. They join `drop` now and are rebuilt in the deferred pass around the
  opening: mullions skipped where `|x - q| <= dw/2`, the kick plate cut into two runs
  like the glazing band above it. The rule for anything added to `makeShop` in future:
  if it crosses the full width of the front face, it needs a `drop` entry and a
  door-aware rebuild.
- **Building variety must come from a coordinate hash, never from `prng()`.** Which
  surface a house gets, which brick colour, whether a room is tiled or boarded — all of
  it goes through `vary(x, z, n)`, a pure hash. It is the same discipline as the trim
  geometry (derived from `w`/`d`/`h`, no randoms): a single extra draw from the seeded
  stream in the generator re-rolls the entire town. The whole texture pass landed with
  all five canaries unmoved because of this.
- **A transparent material must not write depth.** The ink pass is an edge detect
  over the scene's depth buffer, so anything that stamps itself into depth gets an
  outline — including the quad of a free-standing billboard sign, which comes back as
  an ink rectangle in mid-air. `tagNoInk` forces `depthWrite = false` across the
  finished scene; anything transparent built *after* that (a new car rig from the
  garage) has to be passed through it too.
- Two **visible coplanar faces** z-fight into a dithered mess. The church door's front face
  sat at exactly the steeple base's front face (`cz-20.5`); the fix is to stand one proud.
  Note it is only a problem when *both* faces are visible — a door's back face flush with a
  wall is fine, because it is culled.
- **The convertible's "seat back" was a beam through the driver's spine.** Its width
  and depth were swapped — 0.16 of the roof *width* by 0.9 of its *length* — which made
  it a 2 m spar down the centreline of the car instead of a panel across the back of
  the seats. One line; visible in every convertible from the day it was built.
- Vehicle collision is an **oriented** box sized to each car type. It used to be a fixed
  4.2 m axis-aligned square regardless of heading, which is what made cars feel like they
  had an invisible wall around them.
- Bridges keep the road at y=0 while the channel is cut below, so `surfaceY()` returns 0
  over a deck and the riverbed elsewhere. `onBridge()` is what stops a crossing counting
  as water.
- The ground heightfield must be subdivided in **both** axes. Strips spanning the full
  depth with one pair of triangles turn the terrain into a giant ramp from the distant
  hills down to the river, which silently buries the town under grass — the roads are
  still there, just underground.
- The two riverbanks need opposite winding. Emit them with the same vertex order and
  one faces down, which shows up as a black stripe the length of the river.
- **Nothing sits on a carriageway.** Every scattered item (trees, hedges, furniture) is
  filtered against `onRoad()`, and every structure goes through `footprintOnRoad()`:
  houses and shops slide back off the kerb and along the frontage via `placeClear()`,
  landmarks scale to their block via `fitScale()`, and each block's buildable rect is
  shrunk until its whole perimeter is clear. A build-time audit logs
  `structures overlapping roads:` — **it should always print `{}`.** Trees were landing on the country highway because the woodland belt
  was drawn at a radius the highway loops through.
- A module-level throw prints on the loading screen (see the inline `error` handler).
  The dev console does not surface module errors in every preview environment.
- **Map view needs its own near plane.** At 1180 m up, the default 0.4 near plane
  leaves no depth precision for surfaces 6–20 mm apart (road paint over tarmac,
  pads over lawns) and the whole town z-fights into scribbles. `updateCamera`
  sets `camera.near = 250` while the map is up and restores 0.4 on the way out.
- Buildings no longer overlap, but any building you hollow out is still trimmed back off
  its neighbours — see "Going inside". Don't assume a clear room *centre* means a clear room.
- **The driver has to fit under the roof.** The rider in the player's car was parked at
  one fixed height that suited the convertible, so in anything with a roof his head went
  through the headlining — the sedan's roof is at 2.29 and his crown was at 2.46. He is
  seated now (folded at the hip, hands on the wheel) and `seatRider` drops the seat per
  car type until the crown clears. Note the ordering trap: `setPlayerCar` runs before the
  rider exists, so it calls through a `riderSeat` hook that is null until then — calling
  the hoisted `seatRider` directly would hit the temporal dead zone on `rider`.
- **A rotated footprint is not its bounding box.** Houses on a jittered block frontage face
  any angle. `addBox` takes the axis-aligned box for collision (so a diagonal house is
  actually solid) and separately the true `{w, d, yaw}` footprint for the road audit —
  auditing the bounding box flags corners that never touch the tarmac, and using the naive
  `|fx|>0.5 ? d : w` swap gives a diagonal house a collider that doesn't contain it.
- Scenery is filtered against **buildings as well as roads**. Trees and hedges used to be
  tested only with `onRoad`, which is why they grew through people's front rooms.
- `sun.position` tracks the subject in **y** as well as x/z. Shadows degrade on the hills
  and in the river channel without it.

## Previous direction
`backup/v1-realistic-dallas/` holds the earlier build on real OpenStreetMap geometry
for downtown Dallas. See its README to revert.
