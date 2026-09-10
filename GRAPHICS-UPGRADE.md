# Graphics upgrade — September 10, 2026

Saved in driver-upgraded; the original driver project is unchanged.

## Delivered
- Shared rounded character models for the player, riders, police, mission characters and instanced pedestrians.
- Six natural skin tones, 12 hairstyles/hats, detailed eyes, blinking, facial features, clothing trim and rounded shoes.
- Standard materials, environment lighting, filmic tone mapping, softer outlines, revised ground/tree palettes and rounded car bodies.
- Meet Maplewood character viewer on title and pause screens with next character, rotation and face/body views.
- Existing driving, dispatch, missions and save systems retained.

## Files
- src/upgrade/characters.js: shared character geometry and materials.
- src/main.js: rendering, crowd integration and character viewer.
- src/main.before-character-upgrade.js: source backup from before this pass.
- docs/index.html: self-contained production build.

## Validation
Production build and three driving tests passed. Character geometry attributes checked for finite values across all 12 hairstyles. Browser inspected at full-body and face zoom, then gameplay on foot; no browser warnings or errors observed. All missions and performance benchmarks have not been exhaustively tested.

## Preview
Serve docs with python3 -m http.server 8946 --bind 127.0.0.1 --directory docs, then open http://127.0.0.1:8946/.
