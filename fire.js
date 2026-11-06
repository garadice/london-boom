/* ============================================================
   LONDON BOOM! — fire.js (v4.2 WILDFIRE)
   FIRE 🔥 — the living fire: a comet streaks down from the sky
   to wherever the kid tapped, blooms into a fire-flower, and
   the flames CLIMB Big Ben block by block until the whole tower
   burns like a giant candle.

   THE LIVING FIRE (per-block state machine, stored on lb.fire):
     ignited  (0.6–1.0 s)  small licking flame
     burning  (2.5–4.0 s from ignite)  full flames, block chars
              progressively darker, warm glow, spreads HEAT
     consumed (at t >= dur)  the block detaches: friction drops,
              it wakes and FALLS WHILE STILL BURNING = firebrand
     firebrand (in the air)  trails flames, ignites whatever it
              passes; where it lands it starts a brand-new fire
     (a firebrand that lands converts back to a shorter burning
      block — emergent spot fires far from the origin)

   SPREAD (heat model): every burning block heats its neighbours
   every 4th step. Direction matters — heat rises: the block
   ABOVE catches ~1.6× faster than sideways; the block BELOW
   catches slowest (0.45×). That bias is what makes fire CLIMB
   the tower. Spread runs across the flush tower↔annex joint and
   reaches the London Eye when flames get close (pods burn and
   drop). Vehicles catch fire too → panic-drive → explode → the
   fireball ignites the surroundings.

   WEATHER FIGHTS BACK: rain/storm halve the spread rate and put
   out burning blocks (steam puff + hiss); mist slows spread;
   clear = full speed. Water weapons (tsunami splash, vortex
   contact) extinguish burning blocks on contact. A burning body
   that ends up floating in the Thames simply hisses out.

   FIRESTORM: at ≥80 blocks burning at once the fire takes a 3 s
   victory lap — ember rain from above, taller flames, a soft
   rising audio swell — then everything goes back to normal.

   KID-SAFE AUDIO: warm crackle whose layers scale with how much
   is burning, a soft whoosh when the comet drops, gentle pops
   when blocks burst. No roar, no sharp spikes. All synthesized
   through LB.audio (mute + picker suspend silence everything).

   PERFORMANCE RAILS: max 110 concurrent burning blocks (extra
   ignitions queue silently and drain as slots free up); flame
   spawns are budget-capped per step; all particles come from the
   existing P pools (no new particle system); char + glow are one
   polygon + one sprite per burning block. Idle cost ≈ 0 when no
   fire is active.

   Plain script, no build step, no network. Loaded after quake.js
   and wired through the LB_DEPS bundle like sky/weather/plane.
   ============================================================ */
window.LBFire = (function () {
  'use strict';

  var D = null;                    // deps from game.js

  /* ---- tuning ---- */
  var MAX_BURNING = 110;           // hard cap on concurrent burning bodies
  var QUEUE_DRAIN = 3;             // queued ignitions promoted per spread tick
  var IGNITE_R = 70;               // comet bloom ignition radius (px)
  var VEHICLE_R = 90;              // comet bloom vehicle ignition radius
  var HEAT_TICK = 3;               // spread check every N steps (~20 Hz)
  var HEAT_THRESHOLD = 1.0;        // accumulated heat needed to ignite
  var HEAT_UP = 1.9;               // per-second heat at 1.0 → block above catches in ~0.53 s
  var HEAT_SIDE = 1.0;             // sideways neighbour ~1.0 s
  var HEAT_DOWN = 0.45;            // block below ~2.2 s (slowest)
  var R_UP = 52, R_SIDE = 46, R_DOWN = 44;   // spread radii per band
  var BRAND_R = 34;                // firebrand landing ignition radius
  var IGNITED_MIN = 0.6, IGNITED_MAX = 1.0;  // licking-flame phase (s)
  var BURN_MIN = 2.5, BURN_MAX = 4.0;        // consumed after this (s, from ignite)
  var BRAND_REST_MIN = 1.6, BRAND_REST_MAX = 2.6; // landed firebrand burns out in
  var BRAND_MAX_AIR = 1.4;         // a firebrand lands after at most this long
  var WET_T_MIN = 4, WET_T_MAX = 8; // a doused block stays too wet to relight
  var VEH_PANIC = 1.2;             // vehicle panic-drive duration (s)
  var FLAME_BUDGET = 10;           // max flame particles spawned per step by fire
  var STORM_AT = 80;               // firestorm trigger (burning blocks)
  var STORM_REARM_BELOW = 55;      // hysteresis before the next firestorm can arm
  var STORM_DUR = 3.0;             // the signature beat (s)

  /* weather: spread multiplier + per-second extinguish chance (rain) */
  var SPREAD_MULT = { clear: 1.0, cloudy: 1.0, mist: 0.7, rain: 0.5, storm: 0.45 };

  var burning = [];                // every body with live lb.fire (all states)
  var queue = [];                  // ignitions waiting for a cap slot
  var stats = { ignited: 0, extinguished: 0, firebrands: 0, brandLandings: 0, brandLandingIgnites: 0, vehiclesIgnited: 0, vehicleFireballs: 0 };
  var firestorm = null;            // { t, dur } while the beat plays
  var fsArmed = true;              // firestorm trigger armed?
  var flameCursor = 0;             // round-robin cursor so flames spread fairly
  var crackleT = 0;                // layered crackle cadence

  function rand2(a, b) { return a + Math.random() * (b - a); }
  function clamp2(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function weatherState() {
    return (D.LB.weather && D.LB.weather.state) ? D.LB.weather.state() : 'clear';
  }
  function rainIntensity() {
    return (D.LB.weather && D.LB.weather.cur) ? D.LB.weather.cur.rain : 0;
  }
  function spreadMult() {
    var w = weatherState();
    return SPREAD_MULT[w] === undefined ? 1.0 : SPREAD_MULT[w];
  }
  function rainKillRate() {
    // per-second extinguish chance for a burning block; 0 when dry
    var rain = rainIntensity();
    return rain > 0.05 ? 0.10 + 0.35 * rain : 0;
  }
  function nightK() {
    return D.LB.sky ? 0.75 + 0.55 * D.LB.sky.night : 1.0;
  }

  /* ---------------- ignition ---------------- */
  function flammable(o) {
    var lb = o.plugin.lb;
    if (!lb || lb.removed || o.isStatic) return false;
    if (lb.set === 'tower' || lb.set === 'annex' || lb.set === 'eye') {
      return lb.kind !== 'mast';          // the Union Jack survives (it would be rude)
    }
    return false;
  }

  function startBurn(o) {
    var lb = o.plugin.lb;
    lb.fire = {
      state: 'ignited', t: 0,
      dur: rand2(BURN_MIN, BURN_MAX),
      ignT: rand2(IGNITED_MIN, IGNITED_MAX),
      char: 0, brandT: 0, rest: 0,
      gen: 0                          // 0 = original block, 1 = landed firebrand
    };
    if (burning.indexOf(o) < 0) burning.push(o);
    // NOTE: no wake here — burning runs on its own timers while the body
    // sleeps, so the pile stays calm (perf rail). Detach wakes it.
    stats.ignited++;
  }

  /* ignite one body (through the cap queue when full) */
  function igniteBody(o) {
    var lb = o.plugin.lb;
    if (!lb || lb.removed) return false;
    if (lb.fire) return false;
    if (lb.wetT > 0) return false;             // too soaked to light
    if (lb.set === 'vehicle') return igniteVehicle(o);
    if (!flammable(o)) return false;
    if (burning.length >= MAX_BURNING) {
      if (queue.indexOf(o) < 0) queue.push(o);
      return false;
    }
    startBurn(o);
    return true;
  }

  function igniteVehicle(o) {
    var lb = o.plugin.lb;
    if (!lb || lb.removed || lb.fireV) return false;
    if (lb.state !== 'drive') return false;     // only driving traffic panics
    var v = D.vehicleByBody(o);
    if (!v) return false;
    lb.fireV = { t: 0, dur: VEH_PANIC };
    lb.speed = lb.speed * 1.7;                  // panic: full throttle
    stats.vehiclesIgnited++;
    D.M.Sleeping.set(o, false);
    return true;
  }

  /* ignite everything flammable within r of (x, y) — the comet bloom,
     fireball aftermath, firebrand landing burst */
  function igniteAround(x, y, r, vehicleR) {
    var n = 0;
    var vr = vehicleR === undefined ? r + 20 : vehicleR;
    for (var k = 0; k < D.LB.bodies.length; k++) {
      var o = D.LB.bodies[k];
      var lb = o.plugin.lb;
      if (!lb || lb.removed) continue;
      var dx = o.position.x - x, dy = o.position.y - y;
      var rr = lb.set === 'vehicle' ? vr : r;
      if (dx * dx + dy * dy > rr * rr) continue;
      if (igniteBody(o)) n++;
    }
    return n;
  }

  /* the weapon: a fire comet streaks from the sky to the tap point */
  function launch(tx, ty) {
    var comets = D.LB.fires;
    if (comets.length >= 3) return false;
    comets.push({
      sx: tx + rand2(-170, 170), sy: -70,
      tx: tx, ty: ty,
      x: tx + rand2(-170, 170), y: -70,
      t: 0, dur: rand2(0.42, 0.52)
    });
    D.LB.audio.whoosh();
    return true;
  }

  function canLaunch() { return D.LB.fires.length < 3; }

  /* comet arrival: fire-flower burst + instant ignition */
  function bloom(c) {
    var P = D.P;
    P.ring(c.tx, c.ty, 13, 5, 'rgba(255,200,120,0.9)');
    P.embers(c.tx, c.ty, 22);
    P.sparks(c.tx, c.ty, 16, D.SPR.glow.gold, 7);
    // petal flames: a fire-flower
    var petals = 10;
    for (var i = 0; i < petals; i++) {
      var a = (i / petals) * Math.PI * 2 + rand2(-0.2, 0.2);
      var d = rand2(10, 30);
      P.spawn('flame', c.tx + Math.cos(a) * d, c.ty + Math.sin(a) * d, {
        vx: Math.cos(a) * rand2(0.4, 1.6), vy: Math.sin(a) * rand2(0.4, 1.6) - rand2(1.4, 2.6),
        life: rand2(0.35, 0.7), size: rand2(12, 22), drag: 0.93,
        spr: Math.random() < 0.6 ? D.SPR.glow.orange : D.SPR.glow.gold
      });
    }
    igniteAround(c.tx, c.ty, IGNITE_R, VEHICLE_R);
    if (D.LB.audio.throttle('fireBloom', 120)) {
      D.LB.audio.boomDeep(0.32);
      D.LB.audio.crackle(8);
    }
  }

  /* ---------------- extinguishing ---------------- */
  function extinguishBody(o, wet) {
    var lb = o.plugin.lb;
    var had = lb && (lb.fire || lb.fireV);
    if (!had) return false;
    var x = o.position.x, y = o.position.y;
    lb.fire = null;
    lb.fireV = null;
    lb.fireHeat = 0;                       // a doused block is soaked: heat gone
    lb.wetT = rand2(WET_T_MIN, WET_T_MAX); // and it stays too wet to relight for a while
    var i = burning.indexOf(o);
    if (i >= 0) burning.splice(i, 1);
    stats.extinguished++;
    // steam puff + splash
    for (var s = 0; s < 2; s++) {
      D.P.spawn('smoke', x + rand2(-6, 6), y - rand2(0, 8), {
        vx: rand2(-0.5, 0.5), vy: rand2(-1.4, -0.5),
        life: rand2(0.7, 1.3), size: rand2(8, 14), grow: 12, a: 0.42
      });
    }
    D.P.splash(x, y + 4, 3);
    if (D.LB.audio.throttle('fireHiss', 140)) D.LB.audio.hiss();
    return true;
  }

  /* ---------------- consumption: block → firebrand ---------------- */
  function consume(o) {
    var lb = o.plugin.lb, f = lb.fire;
    f.state = 'firebrand';
    f.brandT = 0;
    f.rest = 0;
    stats.firebrands++;
    // detach: slick charred masonry slips out of the stack and falls
    o.friction = 0.04;
    o.frictionStatic = 0.1;
    D.M.Sleeping.set(o, false);
    D.M.Body.setAngularVelocity(o, rand2(-0.22, 0.22));
    D.M.Body.setVelocity(o, { x: o.velocity.x + rand2(-1.6, 1.6), y: o.velocity.y - rand2(0.4, 1.4) });
    // the ceiling above catches as the floor vanishes — this is what makes
    // the fire CLIMB instead of flickering out at the first collapse
    var up = blockDirectlyAbove(o);
    if (up) {
      if (up.plugin.lb.fireHeat === undefined) up.plugin.lb.fireHeat = 0;
      up.plugin.lb.fireHeat += 0.6;
    }
    // a gentle pop as it bursts free
    if (Math.random() < 0.5 && D.LB.audio.throttle('firePop', 90)) D.LB.audio.snap();
  }

  /* nearest flammable neighbour straight up (the ceiling the block just lost) */
  function blockDirectlyAbove(o) {
    var best = null, bestD = 1e9;
    var bodies = D.LB.bodies;
    var ox = o.position.x, oy = o.position.y;
    for (var k = 0; k < bodies.length; k++) {
      var b = bodies[k];
      var lb = b.plugin.lb;
      if (!lb || lb.removed || b.isStatic || lb.fire) continue;
      if (lb.set !== 'tower' && lb.set !== 'annex' && lb.set !== 'eye') continue;
      var dx = b.position.x - ox, dy = b.position.y - oy;
      if (dy > -6 || dy < -40 || dx < -16 || dx > 16) continue;
      var d = -dy + Math.abs(dx) * 2;
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  /* a landed firebrand starts a brand-new fire where it fell */
  function landBrand(o, f) {
    f.state = 'burning';
    f.t = 0;
    f.dur = rand2(BRAND_REST_MIN, BRAND_REST_MAX);
    f.char = Math.max(f.char, 0.55);
    f.gen = 1;                        // a brand burns out where it landed; it never re-brands
    // settle: it grips the ground again while it burns
    o.friction = 0.6;
    o.frictionStatic = 1;
    stats.brandLandings++;
    var n = igniteAround(o.position.x, o.position.y, BRAND_R, BRAND_R + 16);
    if (n > 0) stats.brandLandingIgnites += n;
    D.P.embers(o.position.x, o.position.y, 7);
  }

  /* second-generation burn ends: the charred husk crumbles away */
  function burnOut(o) {
    D.P.embers(o.position.x, o.position.y, 6);
    if (Math.random() < 0.5 && D.LB.audio.throttle('firePop', 90)) D.LB.audio.snap();
    D.removeBody(o, { silent: true });
  }

  /* ---------------- per-step ---------------- */
  function step(dt) {
    if (!D) return;
    var dts = dt / 1000;
    var P = D.P, M = D.M;

    /* comets: streak + trail */
    var comets = D.LB.fires;
    for (var ci = comets.length - 1; ci >= 0; ci--) {
      var c = comets[ci];
      c.t += dts;
      var u = clamp2(c.t / c.dur, 0, 1);
      var e = u * u;                              // gravity-ish acceleration
      c.x = c.sx + (c.tx - c.sx) * e;
      c.y = c.sy + (c.ty - c.sy) * e;
      if (D.step() % 1 === 0) {
        P.flame(c.x + rand2(-4, 4), c.y + rand2(-4, 4), rand2(-0.6, 0.6), rand2(-1.4, -0.4));
        if (Math.random() < 0.5) P.spawn('spark', c.x, c.y, {
          vx: rand2(-1, 1), vy: rand2(-1, 0), life: rand2(0.2, 0.45),
          size: rand2(2.5, 5), drag: 0.94, grav: 0.05, spr: D.SPR.glow.gold
        });
      }
      if (c.t >= c.dur) {
        comets.splice(ci, 1);
        bloom(c);
      }
    }

    /* burning state machine (timers run even while bodies sleep) */
    for (var i = burning.length - 1; i >= 0; i--) {
      var o = burning[i];
      var lb = o.plugin.lb;
      if (!lb || lb.removed) { burning.splice(i, 1); continue; }
      if (!isFinite(o.position.x) || !isFinite(o.position.y)) { burning.splice(i, 1); lb.fire = null; continue; }
      var f = lb.fire;
      if (!f) { burning.splice(i, 1); continue; }
      f.t += dts;

      // the Thames and the rain both put fire out
      if (o.plugin.wet) { extinguishBody(o, true); continue; }
      var rk = rainKillRate();
      if (rk > 0 && f.state !== 'firebrand' && Math.random() < rk * dts) { extinguishBody(o); continue; }
      if (f.state === 'ignited' && f.t >= f.ignT) f.state = 'burning';

      if (f.state === 'firebrand') {
        f.brandT += dts;
        var sp = Math.sqrt(o.velocity.x * o.velocity.x + o.velocity.y * o.velocity.y);
        var grounded = sp < 0.9;
        if (grounded) f.rest += dts; else f.rest = 0;
        if (f.rest > 0.12 || f.brandT > BRAND_MAX_AIR) landBrand(o, f);
      } else if (f.t >= f.dur) {
        if (f.gen >= 1) burnOut(o); else consume(o);
      }
      f.char = clamp2(Math.max(f.char, f.t / f.dur), 0, 1);
    }

    /* vehicle panic-drive countdown lives here too (drive wobble is
       applied by game.js calling drivePanic after its pose pin) */
    for (var vi = 0; vi < D.LB.traffic.vehicles.length; vi++) {
      var vb = D.LB.traffic.vehicles[vi].body;
      if (vb.plugin.lb && vb.plugin.lb.fireV) {
        vb.plugin.lb.fireV.t += dts;
        if (D.step() % 3 === 0) {
          P.flame(vb.position.x + rand2(-12, 12), vb.position.y - 4, rand2(-0.5, 0.5), -rand2(1.6, 3));
        }
      }
    }

    /* spread + queue + audio + firestorm on the throttled tick */
    if (D.step() % HEAT_TICK === 0) {
      coolHeat(rainKillRate());
      spreadHeat();
      drainQueue();
      layerAudio(dts);
      firestormCheck();
    }

    /* flame trail round-robin, budget-capped */
    spawnFlames();

    if (firestorm) {
      firestorm.t += dts;
      emberRain();
      if (firestorm.t >= firestorm.dur) firestorm = null;
    }
  }

  /* heat from every burning block to its neighbours — this is the CLIMB.
     A coarse spatial grid keeps the inner work tiny: bodies are bucketed
     once per tick; each burning body only visits its 3×3 cell patch. */
  var CELL = 64, GRID_OFF = 64, GRID_W = 128;
  function spreadHeat() {
    if (!burning.length) return;
    var wmult = spreadMult();
    var bodies = D.LB.bodies;
    var tick = HEAT_TICK / 60;
    /* bucket every body into the grid (cheap: one pass, array pushes) */
    var grid = {};
    for (var g = 0; g < bodies.length; g++) {
      var gb = bodies[g];
      if (gb.isStatic || !gb.plugin.lb || gb.plugin.lb.removed) continue;
      var cx = ((gb.position.x / CELL) | 0) + GRID_OFF;
      var cy = ((gb.position.y / CELL) | 0) + GRID_OFF;
      if (cx < 0 || cx >= GRID_W || cy < 0 || cy >= GRID_W) continue;
      var key = cx * GRID_W + cy;
      (grid[key] || (grid[key] = [])).push(gb);
    }
    var sweep = Math.ceil(R_UP / CELL + 1);    // cells to visit around a source (integer!)
    for (var b = 0; b < burning.length; b++) {
      var src = burning[b];
      var slb = src.plugin.lb;
      if (!slb || slb.removed || !slb.fire || slb.fire.state === 'ignited') continue;
      var smult = slb.fire.state === 'firebrand' ? 0.6 : 1.0;
      var scx = ((src.position.x / CELL) | 0) + GRID_OFF;
      var scy = ((src.position.y / CELL) | 0) + GRID_OFF;
      for (var ix = scx - sweep; ix <= scx + sweep; ix++) {
        if (ix < 0 || ix >= GRID_W) continue;
        for (var iy = scy - sweep; iy <= scy + sweep; iy++) {
          if (iy < 0 || iy >= GRID_W) continue;
          var bucket = grid[ix * GRID_W + iy];
          if (!bucket) continue;
          for (var m = 0; m < bucket.length; m++) {
            var o = bucket[m];
            var lb = o.plugin.lb;
            if (lb.fire) continue;                   // already burning
            var dx = o.position.x - src.position.x, dy = o.position.y - src.position.y;
            var rate;
            if (dy <= -8) { if (dx * dx + dy * dy > R_UP * R_UP) continue; rate = HEAT_UP; }
            else if (dy >= 8) { if (dx * dx + dy * dy > R_DOWN * R_DOWN) continue; rate = HEAT_DOWN; }
            else { if (dx * dx + dy * dy > R_SIDE * R_SIDE) continue; rate = HEAT_SIDE; }
            if (lb.set === 'vehicle') {
              if (lb.state === 'drive' && !lb.fireV) {
                if (!lb.fireVH) lb.fireVH = 0;
                lb.fireVH += rate * smult * wmult * tick;
                if (lb.fireVH >= HEAT_THRESHOLD) { lb.fireVH = 0; igniteVehicle(o); }
              }
              continue;
            }
            if (!flammable(o)) continue;
            if (lb.fireHeat === undefined) lb.fireHeat = 0;
            lb.fireHeat += rate * smult * wmult * tick;
            if (lb.fireHeat >= HEAT_THRESHOLD) {
              lb.fireHeat = undefined;
              igniteBody(o);
            }
          }
        }
      }
    }
  }

  /* rain cools pre-heated blocks: the heat backlog melts away, so a wet
     firefront can genuinely die instead of lingering on stored heat.
     Also runs down the wet timers set by extinguishing. */
  function coolHeat(rk) {
    var bodies = D.LB.bodies;
    var decay = rk > 0
      ? Math.max(0, 1 - 3 * rk * HEAT_TICK / 60)                    // ~50%/s in rain
      : 0.985;                                                      // gentle dry-air cooling
    for (var i = 0; i < bodies.length; i++) {
      var lb = bodies[i].plugin.lb;
      if (!lb) continue;
      if (lb.fireHeat) lb.fireHeat *= decay;
      if (lb.wetT > 0) lb.wetT -= HEAT_TICK / 60;
    }
  }

  function drainQueue() {
    var n = 0;
    while (queue.length && burning.length < MAX_BURNING && n < QUEUE_DRAIN) {
      // priority drain: the most-heated waiting body ignites first, sampled
      // across the WHOLE queue (a hot climb candidate buried deep still wins).
      // Heat keeps accumulating while a body waits, and upward neighbours
      // heat fastest — so the fire CLIMBS instead of starving behind churn.
      var bestI = -1, bestH = 0;
      var len = queue.length;
      var stride = Math.max(1, Math.floor(len / 12));
      for (var qi = 0; qi < len; qi += stride) {
        var qb = queue[qi];
        var qlb = qb.plugin.lb;
        if (!qlb || qlb.removed || qlb.fire || (qlb.wetT > 0)) { continue; }
        var qh = qlb.fireHeat || 0;
        if (qh > bestH) { bestH = qh; bestI = qi; }
      }
      if (bestI < 0) { queue.shift(); continue; }        // scanned slice all dead: drop one
      var o = queue.splice(bestI, 1)[0];
      var lb = o.plugin.lb;
      if (lb && !lb.removed && !lb.fire && !(lb.wetT > 0) && !o.plugin.wet) { startBurn(o); n++; }
      else { lb.fireHeat = 0; }
    }
    // NOTE: at the cap the queue KEEPS its backlog (draining pauses, never
    // clears) — clearing it would let a saturated front die out locally.
  }

  function layerAudio() {
    var n = burning.length;
    if (n > 0 && D.LB.audio.throttle('fireCrackle', 260)) {
      D.LB.audio.crackle(clamp2(2 + Math.floor(n / 10), 2, 12));
    }
  }

  /* flame trails: fair round-robin over burning blocks, capped per step */
  function spawnFlames() {
    if (!burning.length) return;
    var budget = FLAME_BUDGET;
    var storming = !!firestorm;
    for (var n = 0; n < burning.length && budget > 0; n++) {
      var o = burning[(flameCursor + n) % burning.length];
      var lb = o.plugin.lb;
      if (!lb || !lb.fire || lb.removed) continue;
      var f = lb.fire;
      var big = f.state !== 'ignited';
      if ((D.step() + (flameCursor + n)) % (big ? 2 : 3) !== 0) continue;
      var stretch = storming ? 1.55 : 1;
      if (f.state === 'firebrand' && f.rest === 0) {
        // falling brand: trail under it
        D.P.flame(o.position.x + rand2(-6, 6), o.position.y + rand2(-4, 6), rand2(-0.4, 0.4), rand2(-1, 0.4));
      } else {
        D.P.flame(o.position.x + rand2(-8, 8), o.position.y - rand2(0, 6), rand2(-0.35, 0.35),
          -rand2(1.4, 2.6) * stretch);
        if (big && Math.random() < 0.18) {
          D.P.spawn('ember', o.position.x + rand2(-6, 6), o.position.y - 8, {
            vx: rand2(-0.8, 0.8), vy: -rand2(1.5, 3.2), life: rand2(0.8, 1.8),
            size: rand2(3, 6), drag: 0.97, spr: Math.random() < 0.5 ? D.SPR.glow.orange : D.SPR.glow.gold
          });
        }
      }
      budget--;
    }
    flameCursor = (flameCursor + 7) % Math.max(1, burning.length);
  }

  /* ---------------- firestorm ---------------- */
  function firestormCheck() {
    var n = burning.length;
    if (firestorm) return;
    if (fsArmed && n >= STORM_AT) {
      firestorm = { t: 0, dur: STORM_DUR };
      fsArmed = false;
      D.LB.audio.swell();
    } else if (!fsArmed && n < STORM_REARM_BELOW) {
      fsArmed = true;
    }
  }

  function emberRain() {
    if (burning.length < 4) return;
    var minX = Infinity, maxX = -Infinity;
    for (var i = 0; i < burning.length; i++) {
      var x = burning[i].position.x;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
    var span = clamp2(maxX - minX, 120, 1500);
    var cx = (minX + maxX) / 2;
    for (var e = 0; e < 6; e++) {
      var x = cx + rand2(-span / 2, span / 2);
      D.P.spawn('ember', x, -rand2(10, 110), {
        vx: rand2(-0.5, 0.5), vy: rand2(2.2, 4.4), life: rand2(1.6, 3.0),
        size: rand2(4, 9), drag: 0.995, grav: 0.02,
        spr: Math.random() < 0.6 ? D.SPR.glow.orange : D.SPR.glow.gold
      });
    }
  }

  /* ---------------- vehicle panic wobble (called by game.js after its pose pin) ---------------- */
  function drivePanic(v) {
    var b = v.body, lb = b.plugin.lb;
    if (!lb || !lb.fireV) return;
    // the fire makes the driver weave
    D.M.Body.setAngle(b, Math.sin(D.LB.time * 26 + v.id * 2.1) * 0.085);
    D.M.Body.setVelocity(b, { x: lb.dir * lb.speed * 1.35, y: 0 });
    if (lb.fireV.t >= lb.fireV.dur) {
      lb.fireV.done = true;
      D.explodeVehicle(v);          // staged death: wreck → boom (boom ignites surroundings)
    }
  }

  /* the vehicle's final boom ignites its surroundings (called from explodeVehicleFinal) */
  function vehicleBoom(x, y) {
    stats.vehicleFireballs++;
    D.P.flame(x + rand2(-16, 16), y - 6, rand2(-1, 1), -rand2(2, 4));
    igniteAround(x, y, 120, 130);
  }

  /* ---------------- draw ---------------- */
  function draw(t) {
    var ctx = D.ctx, P = D.P;
    var night = D.LB.sky ? D.LB.sky.night : 0;

    /* charring: a darkening overlay on every burning body (source-over) */
    ctx.globalCompositeOperation = 'source-over';
    for (var i = 0; i < burning.length; i++) {
      var o = burning[i], lb = o.plugin.lb;
      if (!lb || lb.removed || !lb.fire) continue;
      var ch = lb.fire.char;
      if (ch <= 0.02) continue;
      var a = 0.25 + ch * 0.68;                     // visible from early char, near-black late
      var v = o.vertices;
      ctx.globalAlpha = Math.min(1, a);
      ctx.fillStyle = '#170f09';
      ctx.beginPath();
      ctx.moveTo(v[0].x, v[0].y);
      for (var k = 1; k < v.length; k++) ctx.lineTo(v[k].x, v[k].y);
      ctx.closePath();
      ctx.fill();
    }

    /* warm additive glow: the burning tower is a lantern at night */
    ctx.globalCompositeOperation = 'lighter';
    var nk = nightK();
    var boost = firestorm ? 1.3 : 1;
    for (var g = 0; g < burning.length; g++) {
      var ob = burning[g], lb2 = ob.plugin.lb;
      if (!lb2 || lb2.removed || !lb2.fire) continue;
      var w = Math.max(ob.bounds.max.x - ob.bounds.min.x, 12);
      var flick = 0.85 + 0.15 * Math.sin(t * 9 + g * 2.4);
      var sizeK = lb2.fire.state === 'ignited' ? 1.5 : 2.3;
      ctx.globalAlpha = clamp2((lb2.fire.state === 'ignited' ? 0.14 : 0.24) * flick * nk * boost, 0, 0.8);
      ctx.drawImage(D.SPR.glow.orange, ob.position.x - w * sizeK, ob.position.y - w * sizeK, w * sizeK * 2, w * sizeK * 2);
    }

    /* comet heads */
    var comets = D.LB.fires;
    for (var c = 0; c < comets.length; c++) {
      var cm = comets[c];
      ctx.globalAlpha = 0.85;
      ctx.drawImage(D.SPR.glow.gold, cm.x - 16, cm.y - 16, 32, 32);
      ctx.globalAlpha = 0.4;
      ctx.drawImage(D.SPR.glow.orange, cm.x - 30, cm.y - 30, 60, 60);
    }

    /* bonus: flame light tints the Thames below the burning cluster */
    if (burning.length >= 4) {
      var sx = 0, sy = 0;
      for (var s = 0; s < burning.length; s++) { sx += burning[s].position.x; sy += burning[s].position.y; }
      sx /= burning.length;
      var a = clamp2(burning.length * 0.004, 0, 0.3) * (0.5 + 0.5 * night) * boost;
      var grad = ctx.createLinearGradient(0, D.WATER_Y - 10, 0, D.WATER_Y + 55);
      grad.addColorStop(0, 'rgba(255,140,50,' + (a * 0.8).toFixed(3) + ')');
      grad.addColorStop(1, 'rgba(255,110,30,0)');
      ctx.globalAlpha = 1;
      ctx.fillStyle = grad;
      ctx.fillRect(sx - 340, D.WATER_Y - 10, 680, 65);
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /* ---------------- info / lifecycle ---------------- */
  function counts() {
    var burningN = 0, ignitedN = 0, brandN = 0;
    for (var i = 0; i < burning.length; i++) {
      var lb = burning[i].plugin.lb;
      if (!lb || !lb.fire || lb.removed) continue;
      if (lb.fire.state === 'firebrand') brandN++;
      else if (lb.fire.state === 'ignited') ignitedN++;
      else burningN++;
    }
    return { burning: burningN, ignited: ignitedN, firebrands: brandN };
  }

  function info() {
    var c = counts();
    return {
      burning: c.burning, ignited: c.ignited, firebrands: c.firebrands,
      extinguished: stats.extinguished,
      queued: queue.length,
      comets: D.LB.fires.length,
      vehiclesOnFire: vehicleFireCount(),
      stats: {
        ignited: stats.ignited,
        brandLandings: stats.brandLandings,
        brandLandingIgnites: stats.brandLandingIgnites,
        vehiclesIgnited: stats.vehiclesIgnited,
        vehicleFireballs: stats.vehicleFireballs
      },
      firestorm: !!firestorm,
      weather: weatherState(),
      spreadMult: spreadMult(),
      rainKillRate: Math.round(rainKillRate() * 1000) / 1000
    };
  }

  function vehicleFireCount() {
    var n = 0;
    for (var i = 0; i < D.LB.traffic.vehicles.length; i++) {
      var lb = D.LB.traffic.vehicles[i].body.plugin.lb;
      if (lb && lb.fireV) n++;
    }
    return n;
  }

  function fireAt(x, y, r) {
    var n = 0, r2 = r * r;
    for (var i = 0; i < burning.length; i++) {
      var o = burning[i], lb = o.plugin.lb;
      if (!lb || !lb.fire || lb.removed) continue;
      var dx = o.position.x - x, dy = o.position.y - y;
      if (dx * dx + dy * dy <= r2) n++;
    }
    return n;
  }

  /* test hook / curiosity: ignite at a point right now (no comet) */
  function igniteAt(x, y, r) {
    var n = igniteAround(x, y, r === undefined ? IGNITE_R : r);
    return { ignited: n, info: info() };
  }

  function forceFirestorm() {
    if (firestorm) return info();
    firestorm = { t: 0, dur: STORM_DUR };
    fsArmed = false;
    D.LB.audio.swell();
    return info();
  }

  function stopAll() {
    for (var i = 0; i < burning.length; i++) {
      var lb = burning[i].plugin.lb;
      if (lb) { lb.fire = null; }
    }
    burning.length = 0;
    queue.length = 0;
    D.LB.fires.length = 0;
    firestorm = null;
    fsArmed = true;
  }

  function reset() {
    burning.length = 0;
    queue.length = 0;
    firestorm = null;
    fsArmed = true;
    flameCursor = 0;
    stats.ignited = 0; stats.extinguished = 0; stats.firebrands = 0;
    stats.brandLandings = 0; stats.brandLandingIgnites = 0;
    stats.vehiclesIgnited = 0; stats.vehicleFireballs = 0;
  }

  function init(deps) { D = deps; }

  return {
    init: init,
    step: step,
    draw: draw,
    launch: launch,
    canLaunch: canLaunch,
    igniteAt: igniteAt,
    igniteAround: igniteAround,
    extinguishBody: extinguishBody,
    drivePanic: drivePanic,
    vehicleBoom: vehicleBoom,
    fireAt: fireAt,
    forceFirestorm: forceFirestorm,
    info: info,
    stopAll: stopAll,
    reset: reset
  };
})();
