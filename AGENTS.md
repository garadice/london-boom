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
Jack on its roof mast; destroying either structure cascades into the other.
Fireworks celebrate victory; KEEP PLAYING continues in the ruins with live
traffic, fireworks and a 🔄 NEW GAME button (or N key) that starts fresh.

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
- Kid-safe: no realistic gore, no scary audio spikes.

## Current state (v3, Oct 2026)
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
- Win → fireworks → KEEP PLAYING (traffic + periodic fireworks + 🔄 NEW GAME
  button / N key = full fresh world) or PLAY AGAIN (exact restore, verified).
- v3 arsenal: 13 weapons via full-screen picker (pauses sim + audio), keys
  1-9/0/S/V/F, scroll-wheel cycle; per-weapon caps; per-weapon synth sounds.
- Westminster annex wing (271 blocks) flush right of the tower + waving Union
  Jack mast on its roof; collapse cascades both ways; annex excluded from win
  math (tower + Eye integrity only). Windows are PAINTED (real voids
  destabilise Matter stacks — same decision as the tower).
- Verified twice by independent real-browser gates (t_8d12d97c, t_faf21ab6,
  t_42d8868b): 0 console errors, 0 external requests, offline proven, clock
  exact to the second.

## Known debt / caveats (honest, non-blocking)
- FPS only measured headless (SwiftShader): v2 chaos ≈ v1 baseline (no
  regression); real-GPU number unmeasured. If choppy on a real device → tune
  particle caps down.
- `bellSeq.played` counter increments while muted (silencing itself is correct;
  counter semantics only).
- Flung vehicles drawn in both render passes (harmless overdraw).
- `game.js` is a ~3k-line single file. If a v3 gets big, split it (render /
  world / weapons / traffic / audio modules) — keep no-build rule.

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
4. Deploy is MANUAL by design (`vercel deploy --prod` from repo dir) — it stays
   behind the verifier gate. (Vercel↔GitHub auto-deploy not connected; to add:
  GitHub → Settings → Applications → Vercel → repo access for `london-boom`.)
5. Update this file's "Current state" after every shipped change.

## Session continuity
- This file is the source of truth. Hermes skill `project-londonboom` points here.
- Session history lives in Hermes; Hindsight holds project facts.
- Fresh session? Read this file + `git log --oneline -10` + check the live URL,
  then ask Martin what's next.
