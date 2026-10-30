# LONDON BOOM! — developer notes

Dev-facing detail that does not belong in the public README. Protocol
(who/why/how we work, gates, deploy rules): see [AGENTS.md](../AGENTS.md).

## Project layout

```
index.html            minimal shell: canvas, HUD, title overlay (all CSS inline)
game.js               the whole game (custom Canvas2D renderer, fixed-timestep loop)
sw.js                 service worker: cache-first local shell (offline + installable)
manifest.json         PWA manifest (name, icons, standalone display, dusk colors)
icons/                generated PNG icons (192/512 + maskable variants)
vendor/matter.min.js  Matter.js 0.20.0 (MIT, vendored — the only library)
tools/gen_icons.py    regenerates the icons (Pillow, build-time only)
tools/fullboot_repro.js  Node harness: headless boot repro + variant checks
```

## Engineering notes

- Fixed-timestep physics (60 Hz accumulator, max 4 steps/frame), body
  sleeping, pooled particles (cap ~3400), devicePixelRatio-aware canvas
  (capped at 2), NaN/velocity/out-of-bounds guards every step, full
  window-resize support, touch/pointer events throughout.
- World runs at 0.6 g — tower + Eye stay put until hurt, debris falls
  naturally. Tower courses stack on one shared column grid (centred
  subsets only). Annex windows are PAINTED, not real voids — real holes
  destabilise Matter stacks (measured; same decision as the tower).
- World design space is fixed 1600×900; the renderer letterboxes/scales
  to any window.
- Audio: all synthesized (WebAudio), per-weapon sounds, throttle + voice
  budget, mute architecture central.

## Test hooks (harmless, for automated verification)

```js
__TEST__.bodyCounts()        // { tower, eye, annex, dynamic, static, total, towerKinds }
__TEST__.landmarkIntegrity() // { tower, eye, towerTop } 0..1 (1 = intact)
__TEST__.vehicles()          // { counts: { onScreen, exploded, flung }, list: [...] }
__TEST__.clock()             // { h, m, s, ms } — real local time shown on the dials
__TEST__.bell()              // { scheduled, played, strikes, active, brokenPlayed, brokenEvents }
__TEST__.playTwelve()        // fires the full 12:00 sequence programmatically
__TEST__.keepPlaying()       // jumps straight to keep-playing (auto-runs at finale end; no button)
__TEST__.weaponFired         // live counters for all 13 weapons
__TEST__.events              // { explosions, consumed, fireworks, vehiclesExploded, vehiclesFlung, brokenBell, ... }
__TEST__.tnt()               // live TNT blocks (entries carry a ben flag for TNT BEN)
__TEST__.fire(weapon, x, y)  // programmatic fire in world coords (1600x900)
__TEST__.selectWeapon(w)     // switch weapon programmatically
__TEST__.openPicker() / closePicker()
__TEST__.newGame()           // same as the 🔄 NEW GAME button
__TEST__.screenToWorld(cx, cy)
__TEST__.destroyAll()        // test shortcut: wreck the landmarks
__TEST__.reset()             // full world reset (the old PLAY AGAIN semantics)
__TEST__.state()             // { phase, fps, particles, vehiclesOnScreen, continueMode, weapon, pickerOpen, ... }
__TEST__.step(n)             // headless helper: pump n exact fixed physics steps
__TEST__.renderFrame()       // headless helper: paint one frame on demand
__TEST__.errors              // collected console/page errors (should stay [])
```

Fire weapons via real pointer events on the canvas for the full path (the
game converts client → world coordinates itself).

## Deploy (Vercel)

Static site — no config:

```bash
vercel deploy --prod   # from the repo root
```

When redeploying: bump the `CACHE` name in `sw.js` whenever a cached shell
file changed (index.html, game.js, vendor/, manifest, icons) — that
cache-name change is what makes clients pick up the new build.
