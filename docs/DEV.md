# LONDON BOOM! — developer notes

Dev-facing detail that does not belong in the public README. Protocol
(who/why/how we work, gates, deploy rules): see [AGENTS.md](../AGENTS.md).

## Project layout

```
index.html            minimal shell: canvas, HUD, title overlay (all CSS inline)
game.js               the game core (custom Canvas2D renderer, fixed-timestep loop,
                      weapons, traffic, landmark world, __TEST__ hooks, boot)
sky.js                v4 day/night cycle: palette interpolation, sun/moon arcs,
                      stars, weather-aware clouds, world tint, night windows
weather.js            v4 weather state machine (clear/cloudy/rain/storm/mist),
                      rain + lightning + fog rendering, synthesized rain/wind
                      loops + thunder + bird chirps
plane.js              v4 the little plane: readable side-view silhouette
                      (level-cruise angle pin), kinematic cruise, crash
                      staging, multi-stage impact explosion entity
quake.js              v4.1 the EARTHQUAKE: travelling seismic wavefronts,
                      fatigue/joint-failure physics, fissures, slosh,
                      synthesized rumble (see "v4.1 earthquake" below)
fire.js               v4.2 WILDFIRE: the living fire — per-block burn state
                      machine, heat climb, firebrands, vehicle panic,
                      weather counterplay, firestorm (see "v4.2 wildfire")
sw.js                 service worker: cache-first local shell (offline + installable)
manifest.json         PWA manifest (name, icons, standalone display, dusk colors)
icons/                generated PNG icons (192/512 + maskable variants)
vendor/matter.min.js  Matter.js 0.20.0 (MIT, vendored — the only library)
tools/gen_icons.py    regenerates the icons (Pillow, build-time only)
tools/fullboot_repro.js  Node harness: headless boot repro + variant checks
tools/quake_test.js   Node harness: full headless quake suite (27 checks)
tools/fire_test.js    Node harness: full headless WILDFIRE suite (39 checks)
```

## v4.1 earthquake (quake.js)

- **Load order matters**: `sky.js` → `weather.js` → `plane.js` →
  `quake.js` → `game.js`. quake.js is wired like the v4 modules: one
  `LB_DEPS` bundle (extended with `flingVehicle` + `integrityOf`).
- **The event (~10 s, one at a time)**: BUILDUP 3.4 s (local tremble +
  dust trickles + first cracks) → MAIN SHOCK 3 s → AFTERSHOCKS 3.6 s
  (3 pulses at +0.5/+1.6/+2.6 s). Epicenter = tap x clamped to the
  ground line (ground-bound; the plane is skipped by design).
- **Travelling-front model**: every shock is its own front radiating at
  540 px/s (`localStrength(t, d)`), so each structure shakes on
  ARRIVAL — distance-delayed, never all at once — and the aftershock
  pulses re-ring fresh fronts that physically finish shaken survivors.
  Intensity falls off with distance (`FALLOFF_R` 950, floor 0.05).
- **Real structural failure, no scripted deletion**: blocks accrue
  `qFat` while locally shaken above `FAT_GATE` 0.45; at FAT_T 0.5 their
  friction decays (joints weaken), at 1.0 they turn crumbly; fatigued
  blocks also take amplified force (up to 2.5×). The Eye softens joint
  stiffness progressively while strongly shaken and fatigued pins then
  FAIL for real (hangers snap, ring sections let go — budget 4/step,
  per-body cooldown 15 steps) so pods drop and the wheel sags. All
  collapse comes out of the physics; `integrityOf` drops only via the
  normal 55 px origin rule, so quake destruction counts in the win math
  (destroy tower + Eye with quakes → the finale fires).
- **Wake gate**: bodies feeling < 0.4 g-equivalent force are never
  woken — a Matter stack kept awake while nearly unloaded slowly
  CREEPS apart (solver micro-corrections accumulate), so the far field
  must sleep through a distant quake. This is also the main perf tool.
- **Visuals**: fissure polylines grow from the epicenter (dark core +
  lit edge + fracture ticks; they persist as ground scars until NEW
  GAME), a soft wavefront band + dust kick rides each live front, the
  Thames sloshes (3 sine crest lines + splashes), collapse zones billow
  dust/smoke. Ground pass draws right after the road, under vehicles.
- **Audio (kid-safe)**: sub sine 23–37 Hz + noise low-passed 55–175 Hz
  through one smoothed envelope gain (builds to peak, ducks between
  aftershocks); debris thuds reuse the gentle low-passed `thunk()`.
  No snap/bandpass/crackle anywhere in the quake paths. Mute + the
  picker's ctx.suspend silence it like every other sound.
- **Counters**: `LB.events.quakesFired`, `vehiclesWreckedByQuake`
  (increment at the wave hit, like v4 wreck-start semantics),
  `blocksLostByQuake` (per-quake max integrity delta, summed).
- **Perf (headless measurements, t_26579f08)**: node physics-only cost
  1.15–1.41× the destroyAll-chaos baseline across runs (verifier-measured
  medians 1.23–1.30×;
  absolute ≈1.0 ms/step of the 16.6 ms budget). Browser render on the
  SwiftShader box: collapse-state frames ~2–2.5× idle render (37 ms vs
  15 ms single-tab; noisy box, multiple tabs inflate it) — dominated by
  the debris field, not the quake layer (drawGround ≈ 0.63 ms). The
  verifier's foreground FPS comparison is the real gate.
- **Debug switches**: `QUAKE_NO_FORCE=1` (node env) disables force
  application for bisecting; `LBQuake._drawGround` / `_fisCount` are
  test-only exposures.

## v4 systems (sky / weather / plane)

- **Load order matters**: `sky.js` → `weather.js` → `plane.js` → `game.js`.
  The three v4 files are plain scripts that expose `window.LBSky` /
  `window.LBWeather` / `window.LBPlane`; game.js passes every closure
  internal they need through one deps bundle (`LB_DEPS` at BOOT) — getters
  for values that mutate (canvas size, viewport), direct references for
  stable ones (M, world, P, SPR, tag, removeBody, …).
- **Ambient world state**: the day/night cycle and the weather deliberately
  survive NEW GAME (`resetWorld` touches neither; the HUD clock stays real
  local time). The plane does NOT survive — `LBPlane.reset()` clears the
  sky. Counters `planeCrashes` / `lightningStrikes` reset with LB.events.
- **The plane is a real Matter body** (`plugin.lb.set = 'plane'`,
  CAT_VEHICLE, masked against landmarks+traffic while flying) so every
  existing weapon scan can special-case it: explodeMeteor, radialBlast,
  black hole, tornado (funnel reach extended to y≥70 for planes), nuke
  wave, laser, and any hard collision via collisionStart. On hit:
  CAT_DEFAULT + full mask, tumble, smoke+fire trail; on impact
  `planeImpactDamage()` (meteor-like: core 55 / push 300) + a staged
  3-stage boom (t=0 / 0.15 s / 0.4 s) inside LBPlane. Water impacts
  splash + steam instead.
- **Vehicle deaths are STAGED now** (v4 crash juice): `explodeVehicle()`
  flips the wreck into `state='wrecked'` (tumble, wheels pop off as new
  `'wheel'` particles, fire trail) and `explodeVehicleFinal()` fires
  ~0.75–1.15 s later with the SAME block-damage radii as the old instant
  explosion (core 46 / push 170 / chain 130). Counters
  (`vehiclesExploded`, `traffic.counts.exploded`) increment at wreck
  START — tests may read them immediately; `vehiclesOnScreen` drops only
  after the final boom.
- **Weather audio**: rain/wind are looping filtered-noise nodes through
  LB.audio.master (mute via master gain), created lazily after the audio
  unlock; the weapon picker ducks them (and suspends the whole
  AudioContext, as before). Thunder = low-passed noise burst + slow sine
  sweep, delayed 0.5–1.5 s, volume 0.4 — kid-safe rumble, never a bang.
- **Perf (SwiftShader, headless, CPU-contended box)**: fixed-step cost is
  unchanged (≈4.4–4.5 ms/step baseline vs worst case). Persistent worst
  case (deep night + storm + 300 rain drops + fog + tint) renders at
  ~1.09× the noon-clear baseline (tint overlays pre-mixed into one
  full-screen fill). The plane crash adds a transient particle burst of
  the same magnitude as an ordinary meteor blast (~1–2 s).

## v4.2 wildfire (fire.js)

- **Load order matters**: `sky.js` → `weather.js` → `plane.js` →
  `quake.js` → `fire.js` → `game.js`. fire.js is wired like the other
  modules: one `LB_DEPS` bundle (uses `removeBody`, `vehicleByBody`,
  `explodeVehicle`), stepped from `stepWorld` (before `Engine.update`)
  and drawn from the old `drawFires` slot.
- **Tap → comet → bloom**: tap anywhere → a flame-trailing comet streaks
  from the sky to the tap point (~0.5 s) → fire-flower bloom (petal
  flames + ember ring + `ring` pulse) → everything flammable within
  70 px ignites instantly, vehicles within 90 px catch fire. Max 3
  comets in the sky (`LBFire.canLaunch`).
- **Per-block state machine** (lives on `lb.fire`; timers run even while
  Matter bodies sleep — burning never depends on physics wake state):
  `ignited` (0.6–1.0 s small licking flame) → `burning` (2.5–4.0 s from
  ignite: full flames, warm glow, char overlay darkens the block) →
  `consumed` → the block DETACHES (friction 0.04, woken, small impulse)
  and FALLS WHILE BURNING = `firebrand`. A firebrand trails flames,
  ignites what it passes, and where it lands becomes a gen-1 burning
  block (1.6–2.6 s, then burns out via `removeBody`). Gen-0 blocks
  re-brand once; gen-1 never — every block's burn is finite.
- **Heat climb (the spectacle)**: every 3rd step each burning block
  heats neighbours through a coarse spatial grid (64 px cells). Heat is
  directional — UP 1.9/s, SIDE 1.0/s, DOWN 0.45/s (heat rises), so the
  fire walks UP Big Ben ~1 row per 0.5–1 s. Two helpers keep the climb
  alive under the 110-cap: (a) `drainQueue` priority-drains the MOST
  pre-heated waiting body (strided scan over the whole queue — hot
  climb candidates win over base churn), and (b) a consumed block
  gifts +0.6 heat to the ceiling directly above it (the floor vanishes,
  the ceiling catches). Dry heat also cools 1.5%/tick so stale heat
  never lingers.
- **Ignition queue + cap**: `MAX_BURNING` 110 concurrent burning bodies.
  Extra ignitions WAIT in the queue (never dropped — a saturated front
  must not starve); 3 drain per spread tick when slots free up.
- **Weather counterplay**: spread multiplier clear/cloudy 1.0, mist 0.7,
  rain 0.5, storm 0.45. Rain/storm add a per-burning-block extinguish
  chance `0.10 + 0.35·rain` per second (steam puff + `hiss`), and every
  extinguished block gets a WET TIMER (4–8 s, cannot relight) plus a
  50%/s cooling of stored heat — so a wet firefront genuinely dies
  (measured: an Eye-ring fire dies at ~6–9 s with ~11 parts burned in
  rain vs ~40 s / 128 parts in clear). Water weapons: tsunami band +
  vortex contact call `LBFire.extinguishBody` (steam + hiss + count).
  A body floating in the Thames (`plugin.wet`) hisses out.
- **Vehicles**: a burning-block-heated car catches (`lb.fireV`, speed
  ×1.7), panic-drives 1.2 s (weave via `LBFire.drivePanic`, called by
  `stepTraffic` after its pose pin), then `explodeVehicle` → the staged
  wreck's final boom calls `LBFire.vehicleBoom` = a fireball that
  ignites flammables within 120 px. Wrecks stay wrecks (existing path).
- **Firestorm**: at ≥80 blocks burning, a 3 s beat — ember rain from
  above the burn zone, 1.55× taller flames, brighter glow, one soft
  rising `swell` tone. Re-arms only after the count drops below 55
  (hysteresis). Also forced via `__TEST__.forceFirestorm()`.
- **Audio** (all synthesized, kid-safe): layered crackle scaling with
  burning count (2–12 pops / 260 ms), soft `whoosh` at comet launch,
  low `boomDeep(0.32)` + crackle on bloom, gentle `snap` pops on
  burst/burnout, `hiss` on extinguish, `swell` on firestorm. No roar.
- **Rendering** (one `LBFire.draw` from the old `drawFires` slot):
  char overlays = one dark polygon per burning body (alpha = char
  × 0.72, source-over), then an additive pass: warm glow sprite per
  burning body scaled by night factor, comet heads, and a flame-light
  gradient tinting the Thames under the burn cluster. All particles
  come from the existing P pools; flame spawns are budget-capped
  (10/step, fair round-robin) and comets/storm have their own budgets.
- **Win math untouched**: fire removes/moves landmark bodies through
  the normal rules, so fire-only destruction drops
  `integrityOf('tower'/'eye')` below 0.45 and fires the fireworks
  finale (proven headless: finale at ~25–45 s with fire alone).
- **Old path removed**: crate/wave fire (spawnFire/FIRE_SPREAD/stepFires,
  the `firecrate` set) is fully gone — grep returns 0 hits.
- **Perf (measured, headless Node)**: LBFire.step ≈ 1.6 µs idle,
  ~150–190 µs/step at ~100 burning (~5–7 % of a burning step); the rest
  of a burning step is Matter on the awake collapsing pile (the same
  physics class the quake gate measured for destroyAll chaos). Idle
  FPS is untouched: with no fire active the module costs ~0.
- **Hooks**: `__TEST__.fireIgnite(x,y,r?)`, `fires()`, `fireAt(x,y,r?)`,
  `forceFirestorm()` — see below. Headless suite: `node tools/fire_test.js`.

## v4.3 rolling doom (game.js stone) + plane fire (plane.js)

- **ROLLING DOOM — the stone, fully redone** (replaces the old
  fixed-105px left-spawned roller and its HP-300 armor system; the old
  `spawnStone`/`breakStone`/`stoneHp` path is gone, 0 grep hits):
  - **Tap-directed entry**: tap x < W/2 → the boulder enters from the sky
    off the LEFT side and rolls right through the tap point; mirror for the
    right. Spawn point = tap ± `STONE_FALL_RUN` 490 px (the exact fall run),
    y −290. Fall is a controlled plunge (vx pinned `STONE_FALL_VX` 9.2,
    vy ramps 8 → capped 21) — a clean ~26–28° fall line that lands ON the
    tap x (verified ±3 px). Anything under the sky line gets intercepted
    for real: the boulder grinds through Eye arcs / rooftops on its way
    down (emergent, physics — not an aim miss).
  - **Slam trigger surface-ride guard (fix)**: the fall branch fired the
    slam on the POST-solve y (`y + R >= GROUND_Y − 4`), but the SAME engine
    step's collision can eject the boulder onto a ground-level support
    (vehicle cab, Eye slab) whose top sits above that line — the trigger
    window was skipped and the pinned drive ground the boulder along the
    surface, slamming up to ~700 px past the tap (intermittent, ~20–40% of
    right taps). The guard: over a short window in `stepStones`' fall
    branch, if the actual descent delivers under ~1/3 of what the pinned vy
    demanded AND the boulder's bottom is within 40 px of the ground plane
    (tallest lane vehicle roof is 29 px), slam right there. Mid-air plows
    are safe: Eye rim segments die on contact but their pinned chains bleed
    descent, so the stall test alone is NOT enough — the ground-adjacency
    gate keeps through-the-wheel falls punching through to the tap (tap
    1100 keeps its pre-existing deterministic rim-arc slide, slam ~840-880).
    `stoneSlam` is single-fire guarded. Re-gate: `tools/verify_v43.js`
    section B asserts the slam x within ±145 px of the tap on clear
    corridors (8 runs per side, 2 x positions per side) + ground-level slam
    y; tap 1100 asserts the arc-slide band (±320 px) per its baseline.
  - **Sky entrance**: rising whistle + soft rush (sine 340→1350 Hz + band
    noise, kid-safe), dust/pebble trail while falling (soft-capped at
    P.active ≥ 2600), then the SLAM: shake +34, flash, `boomDeep(1.35)` +
    low noise, crater flash rings + decal, and a radial shockwave via
    `radialBlast(x, y−26, { core: 0, push: 360, vehCore: 0, fling: 13,
    lift: 7, cutR: 96 })` — shove/sever only, nothing deleted (kid-safe);
    vehicles within 330 px are FLUNG by `launchVehicleByStone` (fling +
    spin, bigger arc than `flingVehicle`, explode on landing per the
    existing flung-vehicle rules).
  - **Colossal + unstoppable**: r 140 (was 105), density 0.055 (was 0.02,
    mass ≈ 10,000× a masonry block). While rolling, vx is pinned toward the
    far edge at `STONE_SPEED` 13 every step and angular velocity matches
    (vx/R), so it never stalls; it self-rights over rubble ramps (position
    clamp) and hops if ever pinned. Contact crush: normal masonry dies
    instantly, `STONE_TOUGH` courses crack-shove first (`string`/`cornice`
    2 hits, `louvre` 3), Eye rim parts snap, pods drop, vehicles launch.
  - **Wear, not HP**: no armor/death while rolling — `st.wear` 0..1 grows
    (+0.3 slam, +0.02/kill, +0.03/launch) and drives the painter: 3 crack
    stages (≥0.25 / ≥0.5 / ≥0.75) + a darkening wash. Pebbles shed
    continuously behind the roll (soft-capped).
  - **Exit**: off the far edge (±W+200) or into the Thames → mega splash
    (2×26/18 drops + rings + steam, `splash()` + `waterRush`), clean
    despawn — no body left behind. Guard: NaN/removed body despawns
    silently. Per-weapon cap unchanged (max 2 alive).
  - **Win math untouched**: kills go through `removeBody`, so a
    doom-stone-only run fires the finale normally (headless-proven: one
    stone at the tower base → tower 0.04, Eye 0.33 → finale in ~2.5 s —
    the roll under the Eye mauls its bottom rim by design).
- **FIRE ignites the plane** (user instruction): any BURNING body that
  reaches the flying plane sets it on fire; so does the comet bloom if the
  plane is within the bloom radius (~70–90 px). Module boundaries stay
  clean: fire.js only calls two deps hooks game.js provides —
  `planeIgniteIfNear(x, y, r)` (forwarded to `LBPlane.igniteIfNear`) and
  `planeOnFire()` (for `fires().planesOnFire`); it never touches LBPlane
  directly.
  - plane.js owns the staging: `LBPlane.ignite()` sets `lb.onFire
    { t, dur 1.5–2.0 s }`; the plane keeps flying with a small flame trail
    + smoke + a flickering additive glow on the fuselage, then goes down
    through the EXISTING crash path (`hit()`: tumble, `planeCrashes++`,
    staged impact boom + `planeImpactDamage`). Kid-safe: no mid-air
    explosion. Contact radius: per-step burning-body↔fuselage check at
    `PLANE_CONTACT_R` 46 px (the plane's mask excludes landmarks, so a
    physics collision never fires — the proximity test IS the contact).
  - The per-step check runs in fire.js over burning blocks AND burning
    (fireV) vehicles; `igniteAround` special-cases the plane so blooms,
    firebrand landings and vehicle fireballs all can catch it.
- **Perf**: headless idle step cost unchanged vs main (0.94 vs 0.97
  ms/step median, same harness); live plow window ≥ 30 fps on the
  SwiftShader-class box (gate ≥ 24), idle 60 fps; particle shed soft-caps
  at P.active 2600.
- **Hooks** (below): `stoneSpawn(x, y)` (forced spawn, ignores the cap),
  `stones()` → per-boulder `{ x, y, r, vx, heading, tilt, wear, kills,
  state }` (`state` = fall | roll), `forceFirePlane()` (spawn if needed +
  ignite now), `fires().planesOnFire`, `plane().onFire / burnT`.

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
__TEST__.tnt()               // live TNT blocks (entries carry a ben flag for TNT BEN — one 34×152 tower body, see spawnTntBen/drawTntBenTower)
__TEST__.fire(weapon, x, y)  // programmatic fire in world coords (1600x900)
__TEST__.selectWeapon(w)     // switch weapon programmatically
__TEST__.openPicker() / closePicker()
__TEST__.newGame()           // same as the 🔄 NEW GAME button
__TEST__.screenToWorld(cx, cy)
__TEST__.destroyAll()        // test shortcut: wreck the landmarks
__TEST__.reset()             // full world reset (the old PLAY AGAIN semantics)
__TEST__.state()             // { phase, fps, particles, vehiclesOnScreen, planesOnScreen, weather, continueMode, weapon, pickerOpen, ... }
__TEST__.step(n)             // headless helper: pump n exact fixed physics steps
__TEST__.renderFrame()       // headless helper: paint one frame on demand
__TEST__.errors              // collected console/page errors (should stay [])
/* ---- v4: day/night + weather + plane ---- */
__TEST__.timeOfDay()         // { t (0..1 cycle), phase, light, night, sunUp, moonUp }
__TEST__.setTimeOfDay(t)     // set the cycle position (0 = sunrise, 0.25 = noon, 0.75 = deep night); ambient, survives NEW GAME
__TEST__.weather()           // { state, target, blend, rainDrops, fog, dim, lightningStrikes }
__TEST__.setWeather(s)       // force a state: 'clear'|'cloudy'|'rain'|'storm'|'mist' (fast 0.8 s blend)
__TEST__.advanceWeather()    // same as tapping ⛅ — next state in order
__TEST__.spawnPlane()        // force a plane into the sky (max 1)
__TEST__.plane()             // { onScreen, state, crashes, planeCrashes, x, y, dir, speed, angle, nextSpawnIn }
__TEST__.lightning()         // { strikes, boltOnScreen }
__TEST__.counters()          // { planeCrashes, vehicleCrashes, lightningStrikes, quakesFired, vehiclesWreckedByQuake, blocksLostByQuake }
/* ---- v4.1: earthquake ---- */
__TEST__.quake()             // { isQuaking, phase, elapsed, epicenter {x,y}, intensity, waveR, fissureSegs, towerLost, eyeLost, annexLost, quakesFired, vehiclesWreckedByQuake, blocksLostByQuake, scars }
__TEST__.forceQuake(x, y)    // deterministic quake (ends any active one); epicenter x clamped, y snaps to the ground line
/* ---- v4.2: wildfire ---- */
__TEST__.fireIgnite(x, y, r?) // ignite flammables around a point NOW (no comet); default r 70; returns { ignited, info }
__TEST__.fires()             // { burning, ignited, firebrands, extinguished, queued, comets, vehiclesOnFire, planesOnFire, stats { ignited, brandLandings, brandLandingIgnites, vehiclesIgnited, vehicleFireballs }, firestorm, weather, spreadMult, rainKillRate }
__TEST__.fireAt(x, y, r?)    // count burning bodies within r of a point (default r 60)
__TEST__.forceFirestorm()    // trigger the 3 s firestorm beat immediately
/* ---- v4.3: ROLLING DOOM + plane fire ---- */
__TEST__.stoneSpawn(x, y)    // forced doom boulder at tap x (ignores the 2-alive cap); enters from the nearest side
__TEST__.stones()            // per-boulder { x, y, r, vx, heading, tilt (fall-line deg), wear 0..1, kills, state: 'fall'|'roll' }
__TEST__.forceFirePlane()    // force a plane (if none) + set it on fire NOW; returns plane info
__TEST__.plane()             // v4.3 adds onFire + burnT to the plane info
```

Fire weapons via real pointer events on the canvas for the full path (the
game converts client → world coordinates itself).

## Deploy (Vercel)

Static site — no config:

```bash
vercel deploy --prod   # from the repo root
```

When redeploying: bump the `CACHE` name in `sw.js` whenever a cached shell
file changed (index.html, game.js, sky.js, weather.js, plane.js, vendor/,
manifest, icons) — that cache-name change is what makes clients pick up
the new build. (Coder branches do NOT bump CACHE; main bumps at release.)
