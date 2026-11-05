/* ============================================================
   LONDON BOOM! — quake.js (v4.1)
   EARTHQUAKE 🌋 — weapon #14: a ~10 s multi-stage seismic
   spectacle radiating from a tapped epicenter.

   THE EVENT (one at a time, no stacking):
     1. BUILDUP ~3.4 s — deep rumble fades in, ground trembles,
        dust trickles off structures, first cracks spread.
     2. MAIN SHOCK ~3 s — a seismic wavefront rolls outward at
        540 px/s (structures shake when it ARRIVES — distance
        delay, never all at once); fissures propagate along the
        ground; sustained oscillating shear + fatigue weakening
        (friction decays, joints soften) makes weakened masonry
        sections slide, topple and pancake for real — no scripted
        body deletion, collapses come out of the physics.
     3. AFTERSHOCKS ~3.6 s — three smaller pulses spaced ~1 s;
        amplified shaking on already-fatigued blocks FINISHES
        wobbly survivors (delayed collapses).

   Win-math: quake is a weapon like any other — blocks it moves
   past the 55 px origin tolerance drop landmark integrity
   through the normal rules, so tower/Eye destruction by quake
   counts toward the fireworks finale. Vehicles caught by the
   wavefront are staged wrecks (fling → burn → boom), counted in
   vehiclesWreckedByQuake. Ground-bound by design: the plane is
   never targeted (it dies only via existing collision rules).

   AUDIO: all synthesized through LB.audio's master (mute + the
   picker's ctx.suspend both silence it). Deep rumble only —
   sub-bass sine (23–37 Hz) + low-passed noise (≤ ~175 Hz) with
   a smooth envelope; gentle low-passed thuds for debris. No
   sharp transients, ever (kid-safe).

   Plain script, no build step, no network. Loaded before game.js
   and wired through the LB_DEPS bundle like sky/weather/plane.
   ============================================================ */
window.LBQuake = (function () {
  'use strict';

  var D = null;                    // deps from game.js

  /* ---- tuning (seconds / px / Matter force-per-mass units) ---- */
  var BUILDUP = 3.4, MAIN = 3.0, AFT = 3.6;
  var DUR = BUILDUP + MAIN + AFT;            // ~10 s total
  var WAVE_SPEED = 540;                      // px/s — the visible rolling wavefront
  var MAX_R = 1650;                          // influence radius from the epicenter
  var PEAK = 0.00105;                        // peak lateral force/mass at the epicenter
  var FREQ = 3.2;                            // Hz — building shake frequency
  var FALLOFF_R = 950;                       // intensity fades with distance
  var FLOOR = 0.05;                          // far-field floor (a distant rattle, not a collapse)
  var VEH_R = 760;                           // vehicles inside this radius get wrecked by the wave
                                             // (≈ the effective strong-shake radius at the wake gate)
  var FAT_T = 0.5;                           // sustained shake → joints weaken (friction decays)
  var FAT_T2 = 1.0;                          // sustained shake × 2 → crumbly (dust billows)
  var FAT_GATE = 0.45;                       // min local intensity before fatigue accrues
  var EYE_SOFT_FLOOR = 0.3;                  // joint-softening floor (the wheel sags, never instantly drops)
  var EYE_BREAK_T = 0.45;                    // wheel-joint fatigue → pins start failing (bottom-out)
  var POD_BREAK_T = 0.3;                     // pod-hanger fatigue → hanger snaps (pod swings down)
  var BREAK_BUDGET = 4;                      // max joint failures per step (CPU + pacing cap)
  var FAT_RATE = 2.0;                        // fatigue accrual multiplier (strong shake ≈ 0.9/s)
  var AFTERS = [                             // aftershock pulses (time, strength)
    { at: BUILDUP + MAIN + 0.5, s: 0.60 },
    { at: BUILDUP + MAIN + 1.6, s: 0.72 },
    { at: BUILDUP + MAIN + 2.6, s: 0.62 }
  ];
  var FIS_MAX = 26, FIS_PTS = 42, FIS_TOTAL = 700, SCAR_TOTAL = 1100;

  var SKIP = { meteor: 1, tnt: 1, bomb: 1, nuke: 1, nova: 1, stone: 1, firecrate: 1, plane: 1 };

  function rand2(a, b) { return a + Math.random() * (b - a); }

  var quake = null;                // the single active event (or null)
  var scars = [];                  // fissure polylines that outlive the quake
  var lastInfo = null;             // info snapshot after the quake ends (for tests)

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* ---- global envelope 0..1: buildup ramp → main peak → aftershock
         pulses with ducks between them ---- */
  function envelope(t) {
    if (t >= DUR) return 0;
    if (t < BUILDUP) {
      var u = t / BUILDUP;
      return 0.10 + 0.24 * u + Math.sin(t * 9.3) * 0.03 * u;
    }
    if (t < BUILDUP + MAIN) {
      return 1.02 - 0.18 * ((t - BUILDUP) / MAIN) + Math.sin(t * 2.1) * 0.06;
    }
    var v = 0.10;                                  // ducked floor between shocks
    for (var i = 0; i < AFTERS.length; i++) {
      var dt2 = t - AFTERS[i].at;
      if (dt2 > -0.1 && dt2 < 1.4) {
        var g = Math.exp(-(dt2 * dt2) * 7.5) * AFTERS[i].s;
        if (g > v - 0.10) v = Math.max(v, g + 0.10);
      }
    }
    var tail = (DUR - t) / 0.5;
    if (tail < 1) v *= Math.max(0, tail);
    return v;
  }

  function phaseOf(t) {
    if (t < BUILDUP) return 'buildup';
    if (t < BUILDUP + MAIN) return 'main';
    return 'aftershocks';
  }

  /* Local shaking strength at distance d and time t — the travelling-front
     model. Every shock is its own front radiating from the epicenter at
     WAVE_SPEED: the main shock, then each aftershock re-rings a smaller
     front, so structures shake on ARRIVAL (distance-delayed, never all at
     once) and the aftershocks physically finish weakened survivors.
     Returns ~0..1. */
  function localStrength(t, d) {
    var best = 0;
    if (t < BUILDUP) {
      // buildup: a local tremble around the epicenter, growing
      var vb = envelope(t) * Math.max(0, 1 - d / 420);
      if (vb > best) best = vb;
    }
    var arr = BUILDUP + d / WAVE_SPEED;
    if (t >= arr && t < BUILDUP + MAIN + 0.4) {
      var since = t - arr;
      var win = Math.min(1, since * 5) * Math.max(0, 1 - since / 1.7);
      var v = win * envelope(Math.min(t, BUILDUP + MAIN - 0.01));
      if (v > best) best = v;
    }
    for (var i = 0; i < AFTERS.length; i++) {
      var pa = AFTERS[i].at + d / WAVE_SPEED;
      var s2 = t - pa;
      if (s2 >= 0 && s2 < 1.3) {
        var w2 = Math.min(1, s2 * 6) * Math.max(0, 1 - s2 / 1.3);
        var v2 = w2 * (AFTERS[i].s + 0.28);
        if (v2 > best) best = v2;
      }
    }
    return best;
  }

  /* active wavefront radii for drawing + dust kicks (max 4) */
  function activeFronts(t) {
    var out = [];
    if (t >= BUILDUP && t < BUILDUP + MAIN + 0.4) {
      var r = (t - BUILDUP) * WAVE_SPEED;
      if (r < MAX_R) out.push({ r: r, str: envelope(t) });
    }
    for (var i = 0; i < AFTERS.length; i++) {
      var s2 = t - AFTERS[i].at;
      if (s2 >= 0 && s2 < 1.3) {
        var r2 = s2 * WAVE_SPEED;
        if (r2 < MAX_R) out.push({ r: r2, str: AFTERS[i].s + 0.28 });
      }
    }
    return out;
  }

  /* ============================================================
     AUDIO — deep rumble: sub sine + low-passed noise, envelope-
     driven. Envelope updates every 3rd step (~20 Hz) through
     setTargetAtTime so the level glides, never steps.
     ============================================================ */
  function startAudio(q) {
    var A = D.LB.audio, c = A.ctx;
    if (!c || A.muted || !A.ok() || q.audio) return;
    try {
      var src = c.createBufferSource(); src.buffer = A.noiseBuf; src.loop = true;
      var fl = c.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = 60; fl.Q.value = 0.8;
      var gN = c.createGain(); gN.gain.value = 0.0001;
      var sub = c.createOscillator(); sub.type = 'sine'; sub.frequency.value = 31;
      var lfo = c.createOscillator(); lfo.frequency.value = 0.8;
      var lfoG = c.createGain(); lfoG.gain.value = 6;
      lfo.connect(lfoG); lfoG.connect(sub.frequency);
      var gS = c.createGain(); gS.gain.value = 0.0001;
      src.connect(fl); fl.connect(gN); gN.connect(A.master);
      sub.connect(gS); gS.connect(A.master);
      src.start(); sub.start(); lfo.start();
      q.audio = { src: src, fl: fl, gN: gN, sub: sub, lfo: lfo, gS: gS };
      A.voices += 2;
      src.onended = function () { A.voices--; };
      sub.onended = function () { A.voices--; };
    } catch (e) { q.audio = null; }
  }
  function setAudio(q, v) {
    var a = q.audio, c = D.LB.audio.ctx;
    if (!a || !c) return;
    try {
      var t = c.currentTime;
      a.gN.gain.setTargetAtTime(Math.max(0.0001, 0.34 * v), t, 0.09);
      a.gS.gain.setTargetAtTime(Math.max(0.0001, 0.44 * v), t, 0.09);
      a.fl.frequency.setTargetAtTime(55 + 120 * v, t, 0.12);
    } catch (e) {}
  }
  function stopAudio(q) {
    var a = q.audio, c = D.LB.audio.ctx;
    q.audio = null;
    if (!a || !c) return;
    try {
      var t = c.currentTime;
      a.gN.gain.cancelScheduledValues(t); a.gS.gain.cancelScheduledValues(t);
      a.gN.gain.setTargetAtTime(0.0001, t, 0.14);
      a.gS.gain.setTargetAtTime(0.0001, t, 0.14);
      a.src.stop(t + 0.6); a.sub.stop(t + 0.6); a.lfo.stop(t + 0.6);
    } catch (e) {}
  }
  function thud() {
    // gentle debris knock — low-passed, throttled (kid-safe, no snaps)
    if (D.LB.audio.throttle('qthud', 170)) D.LB.audio.thunk();
  }

  /* ============================================================
     FISSURES — jagged ground cracks propagating from the epicenter
     ============================================================ */
  function seedFissures(q) {
    for (var i = 0; i < 3; i++) {
      q.fis.push({
        pts: [{ x: q.x + (Math.random() - 0.5) * 10, y: D.GROUND_Y + 4 + Math.random() * 10 }],
        dir: i === 0 ? -1 : 1,
        wall: false,                       // false = road/bank band, true = far embankment wall
        next: 0
      });
    }
  }
  function totalFisPts(q) {
    var n = 0;
    for (var i = 0; i < q.fis.length; i++) n += q.fis[i].pts.length;
    return n;
  }
  function growFissures(q, fast) {
    var total = totalFisPts(q);
    for (var i = 0; i < q.fis.length; i++) {
      var f = q.fis[i];
      if (q.t < f.next || f.pts.length >= FIS_PTS || total >= FIS_TOTAL) continue;
      var tip = f.pts[f.pts.length - 1];
      var yMin = f.wall ? D.HORIZON_Y + 4 : D.GROUND_Y + 3;
      var yMax = f.wall ? D.GROUND_Y - 2 : D.WATER_Y - 5;
      var nx = tip.x + f.dir * (fast ? 12 + Math.random() * 18 : 9 + Math.random() * 14) + (Math.random() - 0.5) * 4;
      var ny = clamp(tip.y + (Math.random() - 0.5) * 8, yMin, yMax);
      f.pts.push({ x: nx, y: ny });
      total++;
      f.next = q.t + (fast ? 0.09 : 0.16) * (0.7 + Math.random() * 0.6);
      if (Math.random() < 0.3) thud();
      if (Math.random() < 0.4) {
        D.P.dustPuff(nx, ny, f.dir * 0.5, -0.4, 9, 0.26);
      }
      // occasional branch: mostly CONTINUES the frontier in the same
      // direction (splitting the flow) so cracks reach across the city
      if (q.fis.length < FIS_MAX && Math.random() < 0.12 && total < FIS_TOTAL) {
        q.fis.push({
          pts: [{ x: tip.x, y: tip.y }],
          dir: Math.random() < 0.7 ? f.dir : -f.dir,
          wall: !f.wall && Math.random() < 0.45,
          next: q.t + 0.15
        });
      }
    }
  }

  /* ============================================================
     INTEGRITY ATTRIBUTION — the quake snapshots landmark
     integrity when it starts; blocks pushed past the 55 px
     origin tolerance (the game's own win-math rule) count as
     lost BY THE QUAKE. No body is ever scripted away.
     ============================================================ */
  function snapshotIntegrity(q) {
    q.base = {
      tower: D.integrityOf('tower') * D.LB.tower.total,
      eye: D.integrityOf('eye') * D.LB.eye.total,
      annex: D.integrityOf('annex') * D.LB.annex.total
    };
    q.lost = { tower: 0, eye: 0, annex: 0 };
  }
  function trackIntegrity(q) {
    var sets = ['tower', 'eye', 'annex'];
    for (var i = 0; i < sets.length; i++) {
      var s = sets[i];
      var total = s === 'tower' ? D.LB.tower.total : (s === 'annex' ? D.LB.annex.total : D.LB.eye.total);
      if (!total) continue;
      var lost = Math.round((q.base[s] - D.integrityOf(s) * total));
      if (lost > q.lost[s]) q.lost[s] = lost;
    }
  }

  /* ============================================================
     EYE JOINT WEAKENING — when the wavefront reaches a pod or a
     spoke, that joint softens once (stiffness decays) so the
     wheel visibly stretches, sags and the pods swing on.
     ============================================================ */
  function breakConstraint(q, c, x, y) {
    // a fatigued joint fails for real — the constraint is gone, the physics
    // does the rest (same failure idiom the vortex/blast shredders use)
    D.M.Composite.remove(D.world, c);
    var idx = D.LB.constraints.indexOf(c);
    if (idx >= 0) D.LB.constraints.splice(idx, 1);
    D.LB.events.brokenConstraints++;
    D.P.sparkle(x, y, 4);
  }
  function failingPins(o, maxStiff) {
    // constraints touching o that have already been softened enough to fail
    var out = [];
    var cs = D.LB.constraints;
    for (var i = 0; i < cs.length; i++) {
      var c = cs[i];
      if ((c.bodyA === o || c.bodyB === o) && c.stiffness <= maxStiff) out.push(c);
    }
    return out;
  }
  function weakenEyeJoints(o, factor) {
    // one softening tick for every joint touching this wheel part —
    // progressive, so a glancing quake rattles and a direct one sags the ring
    var cs = D.LB.constraints;
    for (var i = 0; i < cs.length; i++) {
      var c = cs[i];
      if (c.bodyA === o || c.bodyB === o) {
        c.stiffness = Math.max(EYE_SOFT_FLOOR, c.stiffness * factor);
      }
    }
  }

  /* ============================================================
     STEP — called from stepWorld with the fixed physics dt (ms).
     Order matters: forces are applied BEFORE M.Engine.update.
     ============================================================ */
  function step(dt) {
    var q = quake;
    if (!q) return;
    var dts = dt / 1000;
    q.t += dts;

    if (q.t >= DUR) { finish(); return; }

    q.phase = phaseOf(q.t);
    q.env = envelope(q.t);
    q.waveR = Math.max(0, q.t - BUILDUP) * WAVE_SPEED;

    setAudio(q, q.env);

    if (q.env < 0.02) return;                    // dead tail: freeze everything cheaply

    q.breakBudget = BREAK_BUDGET;                // joint failures paced per step

    // camera shake rides the envelope (LB.shake decays 0.9/step)
    if (q.env > 0.02) {
      D.LB.shake = Math.min(D.LB.shake + q.env * 3.3, 55);
    }

    var sc = D.step();

    /* ---- fissures: slow crawl in the buildup, fast spread in the main shock ---- */
    if (q.t > 0.45 && q.t < BUILDUP + MAIN - 0.4) {
      if (q.fis.length === 0) seedFissures(q);
      if (sc % 2 === 0) growFissures(q, q.phase === 'main');
    }

    /* ---- forces: travelling wavefronts (main + aftershock re-rings) ---- */
    var bodies = D.LB.bodies;
    var M = D.M;
    var nearLandmarks = [];
    var fronts = activeFronts(q.t);
    q.fronts = fronts;                           // for the draw pass
    for (var k = 0; k < bodies.length; k++) {
      var o = bodies[k], lb = o.plugin.lb;
      if (o.isStatic || !lb || lb.removed || SKIP[lb.set]) continue;
      var dx = o.position.x - q.x;
      var dy = o.position.y - D.GROUND_Y;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d > MAX_R) continue;

      if (lb.set === 'vehicle') {
        // treat the wave as a weapon hit: near-field vehicles are staged
        // wrecks. The quake toss is a HOP (velocity damped after the
        // fling) — cars bounce and flip near the epicenter instead of
        // being hurled across the map into far landmarks.
        if (lb.state === 'drive' && d < VEH_R && localStrength(q.t, d) > 0.3) {
          var veh = D.vehicleByBody(o);
          if (veh) {
            D.flingVehicle(veh, q.x);
            M.Body.setVelocity(o, { x: o.velocity.x * 0.4, y: o.velocity.y * 0.55 });
            M.Body.setAngularVelocity(o, rand2(0.3, 0.75) * (Math.random() < 0.5 ? -1 : 1));
            D.LB.events.vehiclesWreckedByQuake++;
          }
        }
        continue;
      }

      var Ls = localStrength(q.t, d);
      if (Ls <= 0.004) continue;                   // no front has arrived here yet
      var fall = Math.max(FLOOR, 1.12 - d / FALLOFF_R);
      var fat = lb.qFat || 0;
      var fatAmp = 1 + Math.min(fat / 1.0, 1) * 1.5;     // fatigue: shaken-loose blocks get hit harder
      var a = PEAK * fall * Ls * fatAmp;
      // WAKE GATE: only bodies that feel real shaking (≈0.4 g, enough to
      // bounce blocks against friction) are woken. A Matter stack kept
      // awake while nearly unloaded slowly CREEPS itself apart, so anything
      // weaker must keep sleeping through a distant quake. Also keeps the
      // solver cheap: the far field never wakes up.
      if (a < 0.0004) continue;

      var ph = (q.t - BUILDUP - d / WAVE_SPEED) * FREQ * 6.2832;
      var fx = Math.sin(ph + d * 0.011) * a * o.mass;
      var fy = Math.sin(ph * 1.73 + d * 0.013) * a * 0.34 * o.mass;
      M.Sleeping.set(o, false);
      // force applied slightly above the centre → an alternating shear torque
      if (typeof process === 'undefined' || !process.env || !process.env.QUAKE_NO_FORCE) {
        M.Body.applyForce(o, { x: o.position.x, y: o.position.y - 5 }, { x: fx, y: fy });
      }

      // fatigue accrues on landmark masonry while it is being shaken hard
      if ((lb.set === 'tower' || lb.set === 'annex')) {
        var L = fall * Ls;
        if (L > FAT_GATE) {
          lb.qFat = fat + (L - FAT_GATE) * FAT_RATE * dts;
          if (d < 560) nearLandmarks.push(o);
          var f2 = lb.qFat;
          if (f2 >= FAT_T && !lb.qWeakened) {           // stage 1: joints weaken
            lb.qWeakened = true;
            o.friction = Math.max(0.18, o.friction * 0.45);
            o.frictionStatic = Math.max(0.3, o.frictionStatic * 0.5);
            if (sc % 4 === 0) D.P.dustPuff(o.position.x, o.position.y, 0, -0.5, 10, 0.25);
            thud();
          }
          if (f2 >= FAT_T2 && !lb.qCrumbly) {           // stage 2: crumbly — dust billows
            lb.qCrumbly = true;
            o.friction = Math.max(0.12, o.friction * 0.6);
            D.P.dustPuff(o.position.x, o.position.y, 0, -0.7, 16, 0.32);
            D.P.smoke(o.position.x, o.position.y, 2, false);
            thud();
          }
        }
      } else if (lb.set === 'eye') {
        // the wheel: joints soften PROGRESSIVELY while the shaking is strong,
        // then fatigue makes them FAIL for real — hangers snap (pods swing
        // down), ring pins let go section by section, the physics does the
        // collapse. A glancing quake only rattles; a direct one takes the
        // wheel apart over the whole event (buildup → aftershock pacing).
        var Le = fall * Ls;
        if (Le > FAT_GATE) {
          lb.qFat = fat + (Le - FAT_GATE) * FAT_RATE * dts;
          var f3 = lb.qFat;
          var thr = lb.kind === 'pod' ? POD_BREAK_T : EYE_BREAK_T;
          // pace: at most one joint per body per 15 steps, one pick from
          // the already-softened pins, plus a global per-step budget
          if (f3 > thr && q.breakBudget > 0 && a > 0.0004 && sc - (lb.qBreakAt || -99) >= 15) {
            var pins = failingPins(o, 0.85);
            if (pins.length > 0) {
              var c3 = pins[(Math.random() * pins.length) | 0];
              var ax = c3.bodyA ? c3.bodyA.position.x : o.position.x;
              var ay = c3.bodyA ? c3.bodyA.position.y : o.position.y;
              breakConstraint(q, c3, ax, ay);
              q.breakBudget--;
              lb.qBreakAt = sc;
              thud();
            }
          }
        }
        if ((lb.kind === 'rim' || lb.kind === 'rimIn' || lb.kind === 'pod') && a > 0.0004 && sc % 6 === 0) {
          weakenEyeJoints(o, 0.97);
        }
      }

      // dust trickle in the buildup off shaken structures near the epicenter
      if (q.phase === 'buildup' && sc % 3 === 0 && nearLandmarks.length > 0 && Math.random() < 0.6) {
        var dl = nearLandmarks[(Math.random() * nearLandmarks.length) | 0];
        D.P.dustPuff(dl.position.x + (Math.random() - 0.5) * 12, dl.position.y - 8, 0, -0.5, 11, 0.3);
      }
    }

    /* ---- wavefront dust kick: the roll you can SEE (each shock's front) ---- */
    if (sc % 3 === 0 && fronts.length > 0) {
      for (var fi = 0; fi < fronts.length; fi++) {
        var fr = fronts[fi];
        if (fr.str < 0.25) continue;
        for (var s2 = -1; s2 <= 1; s2 += 2) {
          var xw = q.x + s2 * fr.r;
          if (xw > -80 && xw < D.W + 80) {
            D.P.dustPuff(xw, D.GROUND_Y - 4 - Math.random() * 8, s2 * 1.1, -1.6, 14 + Math.random() * 12, 0.26);
          }
        }
      }
    }

    /* ---- the Thames sloshes ---- */
    if (q.env > 0.45 && sc % 6 === 0) {
      var sx = q.x + (Math.random() - 0.5) * 620;
      if (sx > -100 && sx < D.W + 100) D.P.splash(sx, D.WATER_Y, 2);
    }

    /* ---- integrity attribution + a visible puff when a block is lost ---- */
    if (sc % 4 === 0) trackIntegrity(q);

    /* ---- collapse dust: billowing clouds from falling sections ---- */
    if (sc % 2 === 0 && q.env > 0.5) {
      for (var k3 = 0; k3 < bodies.length; k3 += 7) {
        var o3 = bodies[k3], lb3 = o3.plugin.lb;
        if (!o3.isStatic && lb3 && !lb3.removed && (lb3.set === 'tower' || lb3.set === 'annex') && !lb3.qLostPuffed) {
          var ox = lb3.ox, oy = lb3.oy;
          if (ox !== undefined) {
            var ddx = o3.position.x - ox, ddy = o3.position.y - oy;
            if (ddx * ddx + ddy * ddy > 55 * 55) {
              lb3.qLostPuffed = true;
              D.P.dustPuff(o3.position.x, o3.position.y, 0, -0.6, 20, 0.34);
              if (Math.random() < 0.5) D.P.smoke(o3.position.x, o3.position.y, 2, false);
            }
          }
        }
      }
    }
  }

  /* ============================================================
     SPAWN / FINISH / STOP
     ============================================================ */
  function spawn(x, y) {
    if (quake) return false;
    var q = {
      x: clamp(x, 70, D.W - 70),
      y: D.GROUND_Y,                 // ground-bound: the epicenter always sits on the ground line
      t: 0, phase: 'buildup', env: 0, waveR: 0,
      fis: [], audio: null, breakBudget: 0,
      lost: { tower: 0, eye: 0, annex: 0 }, base: null,
      tappedY: y
    };
    snapshotIntegrity(q);
    quake = q;
    D.LB.quakes.push(q);
    D.LB.events.quakesFired++;
    startAudio(q);
    D.P.ring(q.x, D.GROUND_Y - 6, 7, 2, 'rgba(215,195,170,0.75)');
    D.P.dustPuff(q.x, D.GROUND_Y - 2, 0, -0.6, 14, 0.3);
    return true;
  }
  function finish() {
    var q = quake;
    if (!q) return;
    trackIntegrity(q);                       // final delta
    lastInfo = info();
    D.LB.events.blocksLostByQuake += (q.lost.tower + q.lost.eye + q.lost.annex);
    // cracks stay as ground scars until NEW GAME
    for (var i = 0; i < q.fis.length; i++) {
      scars.push(q.fis[i].pts);
      var n = 0;
      for (var s2 = scars.length; s2 > 0; s2--) { n += scars[s2 - 1].length; }
      while (n > SCAR_TOTAL && scars.length > 1) { n -= scars[0].length; scars.shift(); }
    }
    stopAudio(q);
    var idx = D.LB.quakes.indexOf(q);
    if (idx >= 0) D.LB.quakes.splice(idx, 1);
    quake = null;
  }
  function stopAll() {
    // NEW GAME / nuke wipe: kill the sound, drop everything
    if (quake) { stopAudio(quake); var idx = D.LB.quakes.indexOf(quake); if (idx >= 0) D.LB.quakes.splice(idx, 1); quake = null; }
    scars.length = 0;
    lastInfo = null;
  }

  /* ============================================================
     DRAW — ground-level pass, right after the road, UNDER
     vehicles and bodies: fissures, the wavefront band, the slosh.
     ============================================================ */
  function strokeFis(ctx, pts, w, col, dy) {
    ctx.strokeStyle = col;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y + (dy || 0));
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y + (dy || 0));
    ctx.stroke();
  }
  function drawGround(t) {
    var ctx = D.ctx;
    var q = quake;

    /* fissures + scars: jagged ground cracks — dark core with a LIT upper
       edge so they read against the dark road at any time of day */
    var all = scars;
    if (q) {
      all = scars.concat(q.fis.map(function (f) { return f.pts; }));
    }
    if (all.length) {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (var i = 0; i < all.length; i++) {
        var pts = all[i];
        if (pts.length < 2) continue;
        var live = q && i >= scars.length;
        strokeFis(ctx, pts, 3.2, 'rgba(4,6,16,0.92)');
        strokeFis(ctx, pts, 1.5, live ? 'rgba(240,208,158,0.6)' : 'rgba(240,208,158,0.26)', -1.3);
        // short fracture ticks off the main line (cracked-earth texture)
        if (live) {
          ctx.strokeStyle = 'rgba(4,6,16,0.55)';
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          for (var p2 = 2; p2 < pts.length; p2 += 3) {
            var pt = pts[p2], pp = pts[p2 - 1];
            var ang = Math.atan2(pt.y - pp.y, pt.x - pp.x) + (p2 % 2 ? 1.1 : -1.1);
            ctx.moveTo(pt.x, pt.y);
            ctx.lineTo(pt.x + Math.cos(ang) * 5, pt.y + Math.sin(ang) * 5);
          }
          ctx.stroke();
        }
      }
    }

    if (!q || q.env <= 0.02) return;
    var envF = Math.min(1, q.env);

    /* travelling wavefronts: soft dust-coloured bands rolling outward
       (main shock front + any live aftershock fronts) */
    if (q.fronts && q.fronts.length > 0 && q.env > 0.22) {
      for (var fi = 0; fi < q.fronts.length; fi++) {
        var fr = q.fronts[fi];
        if (fr.str < 0.25) continue;
        var envF = Math.min(1, fr.str);
        for (var s2 = -1; s2 <= 1; s2 += 2) {
          var xw = q.x + s2 * fr.r;
          if (xw < -140 || xw > D.W + 140) continue;
          var g = ctx.createLinearGradient(xw - 100, 0, xw + 100, 0);
          var a = 0.16 * envF;
          g.addColorStop(0, 'rgba(240,225,200,0)');
          g.addColorStop(0.5, 'rgba(240,225,200,' + a.toFixed(3) + ')');
          g.addColorStop(1, 'rgba(240,225,200,0)');
          ctx.fillStyle = g;
          ctx.fillRect(xw - 100, D.HORIZON_Y, 200, D.WATER_Y - D.HORIZON_Y);
        }
      }
    }

    /* the Thames sloshes: wavy crest lines across the water */
    if (q.env > 0.22) {
      var amp = 1.2 + envF * 4.2;
      for (var b2 = 0; b2 < 3; b2++) {
        ctx.strokeStyle = 'rgba(150,170,235,' + (0.05 + 0.10 * envF).toFixed(3) + ')';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        for (var x = -1400; x <= D.W + 300; x += 26) {
          var y = D.WATER_Y + 2 + b2 * 6 +
            Math.sin(x * 0.021 + t * (5.2 + b2 * 1.6) + q.x * 0.013) * (amp - b2 * amp * 0.3);
          if (x === -1400) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }
  }

  /* ============================================================
     INFO (tests + hooks)
     ============================================================ */
  function fisSegs(q) {
    var n = 0;
    for (var i = 0; i < q.fis.length; i++) n += Math.max(0, q.fis[i].pts.length - 1);
    return n;
  }
  function info() {
    var q = quake;
    var E = D.LB.events;
    var base = {
      quakesFired: E.quakesFired,
      vehiclesWreckedByQuake: E.vehiclesWreckedByQuake,
      blocksLostByQuake: E.blocksLostByQuake,
      scars: scars.length
    };
    if (!q) {
      var r = { isQuaking: false, phase: null, elapsed: 0, epicenter: null, intensity: 0, waveR: 0, fissureSegs: 0, towerLost: 0, eyeLost: 0, annexLost: 0 };
      var src = lastInfo || {};
      for (var k2 in base) r[k2] = base[k2];
      ['towerLost', 'eyeLost', 'annexLost'].forEach(function (f2) { r[f2] = src[f2] || 0; });
      return r;
    }
    return {
      isQuaking: true,
      phase: q.phase,
      elapsed: Math.round(q.t * 100) / 100,
      epicenter: { x: Math.round(q.x), y: q.y },
      intensity: Math.round(q.env * 1000) / 1000,
      waveR: Math.round(q.waveR),
      fissureSegs: fisSegs(q),
      towerLost: q.lost.tower,
      eyeLost: q.lost.eye,
      annexLost: q.lost.annex,
      quakesFired: base.quakesFired,
      vehiclesWreckedByQuake: base.vehiclesWreckedByQuake,
      blocksLostByQuake: base.blocksLostByQuake,
      scars: base.scars
    };
  }

  function init(deps) {
    D = deps;
  }

  return {
    init: init,
    step: step,
    drawGround: drawGround,
    spawn: spawn,
    force: function (x, y) {
      if (quake) finish();          // tests: one deterministic event at a time
      spawn(x, y);
      return info();
    },
    stopAll: stopAll,
    info: info,
    _fisCount: function () { return quake ? quake.fis.length : scars.length; },
    _drawGround: drawGround                      // perf profiling (test-only)
  };
})();
