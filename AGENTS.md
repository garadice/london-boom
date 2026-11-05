# AGENTS.md — LONDON BOOM! project charter

Working guide for any AI worker (or future session) touching this project.
Read this FIRST. It answers: who is this for, what we build, why, and how.

## Who & why
- **Owner:** Martin Mogis (Bacimo). Personal fun project — no business goals.
- **Player:** his 6-year-old son. Every design decision is judged by
  "can a 6yo operate it alone and is it FUN?" Big buttons, emoji, instant action,
  no reading required, touch-first. No dark patterns, no ads, no network.
- Also serves as Martin's "normal project" template: clean git, verifier gates,
  public GitHub, docs.

## What
Browser physics-destruction game: Elizabeth Tower (Big Ben) + London Eye +
London traffic by the Thames at dusk. **13 weapons** (meteor, black hole,
tornado, TNT, bomb, TNT BEN, nova, nuke, tsunami, laser, rolling stone,
water vortex, fire) selected through a full-screen weapon picker that pauses
the game; all audio synthesized per weapon. A Westminster-style palace annex
(271 blocks) is attached flush to the tower's right side with a waving Union
Jack mast on its roof; destroying either structure cascades into the other.
Win = fireworks, then you simply keep playing in the ruins; a 🔄 NEW GAME
button (or N key) is always on screen to start fresh.

Live: https://london-boom.vercel.app
Repo: https://github.com/garadice/london-boom (public, MIT, © 2026 Martin Mogis)

## Hard constraints (never break)
- **Zero build step** — plain HTML + JS, vendored Matter.js 0.20.0 in `vendor/`.
- **Zero runtime network** — no fetch/XHR/CDN/eval. All audio synthesized.
- **file:// must boot** with zero console errors (service worker skips
  silently on file:// — protocol guard, keep it).
- PWA: `manifest.json` + `sw.js` offline shell. Works offline after first load.
- **Deploy rule (CRITICAL):** whenever a cached shell file changes, bump the
  `CACHE` name in `sw.js` — that bump is what makes clients pick up the new
  build. Forgetting it = players stuck on the old version.
  **Convention (clarified 2026-10-30):** coder branches do NOT bump CACHE;
  main applies the bump when merging/deploying (one bump per release covers
  all merged changes). Gates: treat an unbumped coder branch as CORRECT;
  verify only that the deployed CACHE differs from the previously deployed
  one.
- Kid-safe: no realistic gore, no scary audio spikes.

## Current state (v4.1, Nov 2026)
- **v4.1 EARTHQUAKE (quake.js)**: 14th weapon (key `E`, 14-slot picker). Tap
  the ground → ~10 s event radiating from the epicenter: BUILDUP 3.4 s
  (tremble + dust trickle + first cracks) → MAIN SHOCK 3 s (wavefront
  540 px/s, distance-delayed shaking, fissures, sloshing Thames, staged
  vehicle wrecks) → 3 AFTERSHOCKS (~1 s apart, fresh fronts finish
  weakened survivors). Collapse is REAL physics: friction decay + joint
  softening + genuine Eye-pin failures under a fatigue model; no scripted
  body deletion. Win math normal — quakes alone can fire the finale
  (proven). One quake at a time; ground-bound (never hits the plane).
  Kid-safe audio: sub sine 23–37 Hz + noise low-passed ≤175 Hz, smoothed
  envelope, gentle thuds. Perf guard: wake-gate (bodies under ~0.4
  g-equivalent never wake — a woken-but-unloaded Matter stack creeps
  apart). Module order: sky.js → weather.js → plane.js → quake.js →
  game.js. sw.js precache includes quake.js. Hooks: `__TEST__.quake()` /
  `forceQuake(x,y)`, counters {quakesFired, vehiclesWreckedByQuake,
  blocksLostByQuake}, `state().quakes`. Tests: tools/quake_test.js (27
  headless checks). Gates: coder t_26579f08 + verifier t_879c7dd7
  APPROVE (fc76ae1; perf gate exceeded: quake holds idle FPS 1.00× while
  destroyAll chaos drops to 7 fps).
- Elizabeth Tower: **462 blocks, 14 block types**, sections researched against
  real references (parliament.uk, Wikipedia, photo analysis): plinth → shaft →
  string courses → clock stage → belfry louvres → lantern → spire → gilded tip.
- London Eye: 157 constraint-linked parts, rotating rim, hanging pods.
- Traffic: two-lane embankment road, ≤3 vehicles on screen (red double-decker
  buses, black cabs, mixed cars), both directions. Kinematic until hit;
  meteor/TNT = instant blast; tornado/black hole = flung, explodes on ground
  contact; blasts also damage landmark blocks.
- Clock: real local time, animated hands, front + foreshortened side face.
- Bells: 🔔 button = full 12:00 (Westminster Quarters G♯4/F♯4/E4/B3 + 12× E3
  strikes); broken/cracked bell once when tower top collapses (rearms on reset).
- Win → fireworks + fanfare → **seamless auto-continue** in the ruins (traffic
  + periodic fireworks, no overlay, no click; input stays live during the
  show) — victory screen REMOVED (Martin, v3.1). 🔄 NEW GAME button (or N key)
  is visible from PLAY onward, works mid-play/during finale → full fresh world.
- v3.1 nuke: detonation = expanding vaporization wave (~1080 px/s) that
  vaporizes EVERY tower/annex/Eye block (~1 s, debris flying outward) +
  8.6 s animated mushroom cloud (fireball → churning stem → rolling ~590px
  cap → dissipation) + redesigned armed crate (trefoil, hazard stripes, LED)
  + layered sub-boom/rumble audio. Gates: t_c7f174e0 (9/9 DoD PASS; merged
  after its required CACHE bump), t_f7fb31e9 (PASS).
- v3 arsenal: 13 weapons via full-screen picker (pauses sim + audio), keys
  1-9/0/S/V/F, scroll-wheel cycle; per-weapon caps; per-weapon synth sounds.
- Westminster annex wing (271 blocks) flush right of the tower + waving Union
  Jack mast on its roof; collapse cascades both ways; annex excluded from win
  math (tower + Eye integrity only). Windows are PAINTED (real voids
  destabilise Matter stacks — same decision as the tower).
- Verified twice by independent real-browser gates (t_8d12d97c, t_faf21ab6,
  t_42d8868b): 0 console errors, 0 external requests, offline proven, clock
  exact to the second.
- v4 sky (sky.js): 2-minute day/night cycle (60 s + 60 s) — interpolated
  sky palettes (sunrise → day → sunset → night), arcing sun + moon (peaks
  y≈200, clear of the HUD), twinkling stars, warm night windows on
  tower/annex (additive pass), Eye LEDs + skyline windows scale with
  darkness, moon/sun drag their reflection across the Thames, world tint
  pre-mixed into one full-screen fill (SwiftShader worst case ≈1.09× noon
  baseline). Ambient world time: NOT reset by NEW GAME; HUD clock stays
  real local time.
- v4 weather (weather.js): CLEAR / CLOUDY / RAIN / STORM / MIST,
  auto-advance 20–40 s with a 4 s cross-fade; ⛅ button (top right) +
  `__TEST__.setWeather` jump with a 0.8 s blend. Rain ≤300 drops +
  splashes; storm = jagged bolt + scene flash + kid-safe low rumble thunder
  delayed 0.5–1.5 s (ambient strikes every 2.5–7 s); mist = drifting fog
  bands (far layer behind landmarks); clear-day bird chirps (quiet).
  Rain/wind are synthesized noise loops through LB.audio (mute via master;
  picker ducks + suspends). Weather is ambient — survives NEW GAME.
- v4 plane (plane.js): one plane at a time (spawn 10–20 s, either
  direction, y 80–165, kinematic cruise with a pinned level attitude ±3°,
  prop blur + contrail + steady nav beacon with a brighter pulse).
  Recognizable side-view silhouette at gameplay scale in day AND night:
  dark fills that lift toward a moonlit steel tone as night rises,
  light-outlined fin/stabiliser/wing, non-collapsing prop disc + blade
  streak. ANY weapon/blast/tornado/black hole/nuke wave/laser/hard
  collision sends it down: tumble + smoke/fire trail, real-physics fall,
  impact = 3-stage boom + scorch + meteor-like block damage (core 55 /
  push 300 via `planeImpactDamage`); water impact = splash + steam.
  Counter: `planeCrashes`. `__TEST__.plane()` also reports `angle`.
- v4 vehicle crashes: staged death — hit → `wrecked` (tumble, wheels pop
  off as bounce/roll particles, fire trail, 0.75–1.15 s) → final boom with
  the SAME block-damage radii as before (46/170/130). Counters increment
  at wreck START; `vehiclesOnScreen` drops after the final boom.
- v4 verified by native review round 2 (execution lens) + independent
  verifier gate t_f2d0457c (PASS_WITH_CAVEATS / APPROVE, final tip
  e11ae18): 10/10 DoD, plane silhouette day+night vision-proven, 13/13
  weapons, regression sweep, PWA precache incl. the 3 new modules.

## Known debt / caveats (honest, non-blocking)
- FPS only measured headless (SwiftShader): v2 chaos ≈ v1 baseline (no
  regression); real-GPU number unmeasured. If choppy on a real device → tune
  particle caps down.
- `bellSeq.played` counter increments while muted (silencing itself is correct;
  counter semantics only).
- Flung vehicles drawn in both render passes (harmless overdraw).
- FPS numbers are headless SwiftShader on a CPU-contended box; the
  plane-crash boom adds a transient particle burst of the same class as a
  meteor blast (~1–2 s). Tsunami/vortex/fire/stone cannot reach the plane
  (ground/water-bound) — by design.
- v4 mist is technically present but faint (fog=1, ~7% contrast change —
  vision-invisible); accepted polish debt. Plane legibility dips slightly
  when crossing the moon's glare at night (verifier t_f2d0457c caveats).
- v4.1 quake fissures are hard to see at night (vision found none on dark
  peak frames; daytime clearly reads); accepted polish debt. DEV.md perf
  figures are SwiftShader-box noise bands, not guarantees.
- `game.js` is a ~3.2k-line single file; v4 extracted the first modules
  (sky.js / weather.js / plane.js). A deeper split (render / world /
  weapons / traffic / audio) remains future work — keep no-build rule.

## Roadmap / open offers (awaiting Martin's word)
- **TNT chain reactions**: blasts currently push but never ignite other TNT
  (every fuse runs its full 3 s). Real Minecraft ignites — small change if wanted.
- FPS tuning knob (particle budget) if real-device testing shows choppiness.
- More landmarks (Tower Bridge?), sounds, vehicle types — ask Martin first;
  he owns the feature list.

## How we work (protocol)
1. Martin asks main (Telegram). Work is dispatched as **Kanban cards**:
   coder builds on a branch (`coder/<task>-...`), local commits only.
2. **Independent verifier card** gates every change in a REAL browser against
   the card's DoD (counters via `__TEST__` hooks, synthetic pointer events,
   screenshots/vision, regression sweep of all weapons + win path, 0 console
   errors, 0 external requests, file:// boot, FPS-vs-baseline).
3. Main merges to `main`, fixes trivial docs nits, deploys, verifies live
   (page 200 + served game.js contains new markers + manifest/sw/icons 200),
   reports with evidence receipt, pushes to GitHub.
4. **README is the public face — actualize it with EVERY push.** Before any
   push to GitHub, README.md must match the shipped user-visible state
   (weapons, landmarks, controls, screenshots). Keep it short and
   user-friendly; dev detail lives in `docs/DEV.md`, process in AGENTS.md.
   A push that ships a code change without its README update is not done.
5. Deploy is MANUAL by design (`vercel deploy --prod` from repo dir) — it stays
   behind the verifier gate. (Vercel↔GitHub auto-deploy not connected; to add:
   GitHub → Settings → Applications → Vercel → repo access for `london-boom`.)
6. Update this file's "Current state" after every shipped change.

## Session continuity
- This file is the source of truth. Hermes skill `project-londonboom` points here.
- Session history lives in Hermes; Hindsight holds project facts.
- Fresh session? Read this file + `git log --oneline -10` + check the live URL,
  then ask Martin what's next.
