# LONDON BOOM! 💥

A browser physics-destruction game for kids (built for a 6-year-old London-wrecker).
Big Ben (Elizabeth Tower) and the London Eye stand by the Thames at dusk — smash
them with meteors, black holes and tornadoes until the fireworks celebrate you.

- **Zero build step** — plain HTML + JS + vendored Matter.js. No bundler, no npm.
- **Zero runtime network** — everything (physics, rendering, sound) is local and
  synthesized. Works from `file://` and as static hosting.

## Run it

**Option 1 — just open it**

Double-click `index.html` (any modern browser: Chrome, Edge, Firefox, Safari).

**Option 2 — serve it**

```bash
cd london-boom
python3 -m http.server 8080
# open http://localhost:8080
```

## Play

| Action | How |
| --- | --- |
| Fire selected weapon | click / tap anywhere on the scene |
| Switch weapon | keys `1` `2` `3`, mouse wheel, or the three big emoji buttons |
| Mute | 🔊 button (top right) or key `M` |
| Play again | big button after the fireworks finale |

- ☄️ **METEOR** — a dense fireball streaks in from the top of the screen toward your
  click and detonates: radial blast, white flash, shockwave ring, screen shake,
  embers, smoke, vaporized masonry.
- 🕳️ **BLACK HOLE** — a singularity spawns for ~3.5 s, pulls everything in a wide
  radius inward (1/r², clamped) with a spiralling swirl, swallows bodies and even
  the Eye's cables that cross its core, then releases with a small blast. The feed
  counter (`×N`) grows as it eats.
- 🌪️ **TORNADO** — a wandering vortex spins for ~5 s: tangential suction + upward
  lift that widens with height, shreds the wheel's light constraints, flings bodies
  in arcs; they rain down (and bob in the Thames).

Destroy both landmarks (integrity below 45%) → fireworks finale + 🎉 YOU DID IT!

## Project layout

```
index.html          minimal shell: canvas, HUD, title/win overlays (all CSS inline)
game.js             the whole game (custom Canvas2D renderer, fixed-timestep loop)
vendor/matter.min.js  Matter.js 0.20.0 (MIT, vendored — the only library)
```

Engineering notes: fixed-timestep physics (60 Hz accumulator, max 4 steps/frame),
body sleeping enabled, pooled particles (cap 3400), devicePixelRatio-aware canvas
(capped at 2), NaN/velocity/out-of-bounds guards every step, full window-resize
support, all audio synthesized with WebAudio (no files), touch/pointer events
throughout.

The world runs at 0.6 g — the sweet spot where the 296-block tower and the
157-part Eye stay put until you hurt them, but debris still falls naturally.
The Eye idle-rotates gently (wheel-speed-gated motor) with LED rim glow until
damaged; the glowing clock face keeps real time and keeps drawing wherever the
clock blocks end up.

## Test hook (harmless, for automated verification)

```js
__TEST__.bodyCounts()        // { tower, eye, dynamic, static, total }
__TEST__.landmarkIntegrity() // { tower, eye } 0..1 (1 = intact)
__TEST__.weaponFired         // { meteor, blackhole, tornado } live counters
__TEST__.events              // { explosions, consumed, fireworks, brokenConstraints, ... }
__TEST__.fire(weapon, x, y)  // programmatic fire in world coords (1600x900)
__TEST__.screenToWorld(cx, cy)
__TEST__.destroyAll()        // test shortcut: wreck both landmarks
__TEST__.reset()             // full world reset (same as PLAY AGAIN)
__TEST__.state()             // { phase, fps, particles, shake, ... }
__TEST__.errors              // collected console/page errors (should stay [])
```

World design space is a fixed 1600×900; the renderer letterboxes/scales to any
window. Fire weapons via real pointer events on the canvas for the full path
(the game converts client → world coordinates itself).

## Deploy (Vercel)

It's a static site — no config needed:

```bash
vercel deploy --prod   # from this directory
```

(or import the directory/repo in the Vercel dashboard; framework preset:
"Other", no build command, output directory: `.`)

## Credits

- Physics: [Matter.js](https://brm.io/matter-js/) 0.20.0 by @liabru (MIT) — vendored in `vendor/`.
- Everything else: hand-rolled Canvas2D + WebAudio, made with 💥 for a small destroyer of cities.
