/* ============================================================
   LONDON BOOM! — plane.js (v4)
   A little plane crossing the sky (MAX 1 on screen, spawn every
   ~10-20 s, either direction, above the tower). Kinematic like
   road traffic until hit: ANY weapon contact / blast / tornado /
   black hole / nuke wave / laser sends it into a crash — it
   tumbles with a smoke + fire trail, falls under real physics,
   and detonates on impact (ground, structure or water) with a
   multi-stage boom, debris, screen shake and meteor-like local
   block damage. The headline moment.

   The plane is a REAL Matter body (set 'plane'), so every
   existing weapon scan in game.js can special-case it; game.js
   owns the damage application (planeImpactDamage) and the
   collisionStart wiring, this file owns the entity + staging.

   Plain script, no build step, no network. Loaded before game.js.
   ============================================================ */
window.LBPlane = (function () {
  'use strict';

  var D = null;              // deps from game.js
  var plane = null;          // { body, state: 'flying'|'crashing', dir, alt, speed, t, spin, bob }
  var nextSpawn = 7;         // s until the first plane (then 10-20 s)
  var crashes = [];          // staged impact explosions: { x, y, t, water }
  var propSpin = 0;

  function rand(a, b) { return a + Math.random() * (b - a); }

  function body() { return plane ? plane.body : null; }

  function spawn() {
    if (plane || !D) return false;
    var dir = Math.random() < 0.5 ? 1 : -1;
    var alt = rand(80, 165);                       // above tower tip (~y 276) + Eye top (~y 185)
    var x = dir > 0 ? -rand(80, 200) : D.W + rand(80, 200);
    var def = { w: 58, h: 17 };
    var b = D.M.Bodies.rectangle(x, alt, def.w - 8, def.h - 3, {
      friction: 0.2, frictionStatic: 0.4, restitution: 0.25, density: 0.002,
      frictionAir: 0.006, sleepThreshold: Infinity, label: 'plane'
    });
    b.collisionFilter.category = D.CAT_VEHICLE;
    // while flying: never collide with the landmarks or traffic (passes behind/in
    // front of them like road traffic does); DOES collide with weapons + debris
    b.collisionFilter.mask = 0xFFFF & ~(D.CAT_LANDMARK | D.CAT_VEHICLE);
    D.tag(b, 'plane', 'plane');
    M_set(b, { state: 'flying', dir: dir, alt: alt, speed: rand(2.2, 3.1), t: 0, color: pickColor() });
    D.M.Composite.add(D.world, b);
    plane = { body: b, state: 'flying', t: 0 };
    return true;
  }

  function pickColor() {
    var cols = ['#e8ecf2', '#d84838', '#3f7fc4', '#e8c93a'];
    return cols[(Math.random() * cols.length) | 0];
  }
  function M_set(b, fields) { for (var k in fields) b.plugin.lb[k] = fields[k]; }

  function despawn(silent) {
    if (!plane) return;
    D.removeBody(plane.body, { silent: silent !== false });
    plane = null;
    nextSpawn = rand(10, 20);
  }

  /* ANY weapon / blast / tornado / black hole / nuke wave / laser calls this */
  function hit(plBody) {
    if (!plane || plane.state !== 'flying') return false;
    if (plBody && plBody !== plane.body) return false;
    var b = plane.body, lb = b.plugin.lb;
    plane.state = 'crashing';
    lb.state = 'crashing';
    D.LB.events.planeCrashes++;
    // the pilot is done: full collisions (it can now smash into the tower, ground, water)
    b.collisionFilter.category = D.CAT_DEFAULT;
    b.collisionFilter.mask = 0xFFFFFFFF;
    D.M.Sleeping.set(b, false);
    D.M.Body.setVelocity(b, { x: lb.dir * lb.speed * 0.45, y: rand(-1.5, 1.5) });
    D.M.Body.setAngularVelocity(b, (Math.random() < 0.5 ? -1 : 1) * rand(0.22, 0.4));
    plane.t = 0;
    // sputter + small flash — the fall itself is the drama, no harsh sounds
    D.LB.audio.tone('sawtooth', 260, 55, 0.55, 0.11);
    D.LB.audio.noise(0.5, 0.14, 'lowpass', 900, 200, 1);
    D.LB.flash = Math.min(D.LB.flash + 0.12, 1);
    D.P.sparks(b.position.x, b.position.y, 14, D.SPR.glow.orange, 7);
    D.P.smoke(b.position.x, b.position.y, 6, false);
    return true;
  }

  /* ---------------- v4.3: fire ignition — burning debris can bring the plane down ----------------
     fire.js detects a burning body reaching the fuselage and calls the deps
     hook (game.js forwards igniteIfNear). The plane keeps flying while it
     burns for ~1.5–2 s with a small flame trail, then goes down through the
     EXISTING crash path (hit(): tumble, planeCrashes counter, staged impact
     boom + planeImpactDamage). Kid-safe: no mid-air explosion. */
  var BURN_MIN = 1.5, BURN_MAX = 2.0;

  function ignite() {
    if (!plane || plane.state !== 'flying') return false;
    var b = plane.body, lb = b.plugin.lb;
    if (lb.onFire) return false;
    lb.onFire = { t: 0, dur: rand(BURN_MIN, BURN_MAX) };
    D.LB.audio.hiss();
    D.P.sparks(b.position.x, b.position.y, 8, D.SPR.glow.orange, 5);
    for (var k = 0; k < 3; k++) {
      D.P.flame(b.position.x + rand(-10, 10), b.position.y + rand(-5, 5), rand(-0.5, 0.5), -rand(1, 2));
    }
    return true;
  }

  /* true when a point is within r px of the flying plane's fuselage */
  function igniteIfNear(x, y, r) {
    if (!plane || plane.state !== 'flying') return false;
    if (plane.body.plugin.lb.onFire) return false;
    var dx = plane.body.position.x - x, dy = plane.body.position.y - y;
    if (dx * dx + dy * dy > r * r) return false;
    return ignite();
  }

  function burning() {
    return !!(plane && plane.state === 'flying' && plane.body.plugin.lb.onFire);
  }

  /* the plane body hit something (or reached the ground/water) */
  function impact() {
    if (!plane || plane.state !== 'crashing') return;
    var b = plane.body;
    var x = b.position.x, y = b.position.y;
    var water = y > D.WATER_Y - 6;
    crashes.push({ x: x, y: Math.min(y, water ? D.WATER_Y : D.GROUND_Y), t: 0, water: water });
    D.removeBody(b, { silent: true });
    plane = null;
    nextSpawn = rand(10, 20);
  }

  function stepCrashes(dts) {
    for (var i = crashes.length - 1; i >= 0; i--) {
      var c = crashes[i];
      var was = c.t;
      c.t += dts;
      if (c.water) {
        if (was === 0) {
          D.P.splash(c.x, D.WATER_Y, 26);
          D.P.ring(c.x, D.WATER_Y, 9, 3, 'rgba(170,210,255,0.8)');
          D.P.spawn('smoke', c.x, D.WATER_Y - 10, { vx: rand(-0.4, 0.4), vy: rand(-1.2, -0.6), life: rand(1.5, 2.6), size: rand(16, 26), grow: 12, a: 0.4 }); // steam
          D.LB.audio.splash();
          D.LB.audio.noise(0.8, 0.2, 'lowpass', 700, 140, 1);
          D.LB.shake = Math.min(D.LB.shake + 8, 55);
          D.LB.events.shakes++;
        }
        if (c.t > 1.2) crashes.splice(i, 1);
        continue;
      }
      // --- staged land explosion ---
      if (was === 0) {
        // stage A: the main blast
        D.LB.flash = Math.min(D.LB.flash + 0.55, 1);
        D.LB.shake = Math.min(D.LB.shake + 22, 55);
        D.LB.events.shakes++;
        D.LB.events.explosions++;
        D.LB.audio.boom(1.1);
        D.P.ring(c.x, c.y, 13, 5);
        D.P.ring(c.x, c.y, 8, 3, 'rgba(255,180,90,0.7)');
        D.P.embers(c.x, c.y, 34);
        D.P.sparks(c.x, c.y, 30, D.SPR.glow.gold, 9);
        D.P.smoke(c.x, c.y, 12, true);
        D.P.debrisBurst(c.x, c.y, '#c8ccd8', 12);
        D.planeImpactDamage(c.x, c.y);          // meteor-like local damage (game.js owns block math)
      }
      if (was < 0.15 && c.t >= 0.15) {
        // stage B: secondary pop + fuel flare
        D.LB.audio.boomDeep(0.65);
        D.P.embers(c.x + rand(-18, 18), c.y + rand(-10, 6), 18);
        D.P.flame(c.x + rand(-12, 12), c.y - 4, rand(-1, 1), rand(-2.4, -1));
        D.P.debrisBurst(c.x, c.y - 6, '#8a8f9e', 8);
      }
      if (was < 0.4 && c.t >= 0.4) {
        // stage C: churning smoke column + crackle
        for (var k = 0; k < 7; k++) {
          D.P.spawn('smoke', c.x + rand(-20, 20), c.y - rand(4, 26), { vx: rand(-0.6, 0.6), vy: rand(-1.8, -0.8), life: rand(1.8, 3.4), size: rand(18, 30), grow: 13, a: 0.45 });
        }
        D.LB.audio.crackle(6);
      }
      if (c.t > 2.6) crashes.splice(i, 1);
    }
  }

  /* ---------------- painting (world space) ---------------- */
  function draw(time) {
    // finished crashes keep smoking via the shared particle system
    if (!plane) return;
    var ctx = D.ctx;
    var b = plane.body, lb = b.plugin.lb;
    var crashing = plane.state === 'crashing';
    ctx.save();
    ctx.translate(b.position.x, b.position.y);
    ctx.rotate(b.angle);
    var dir = lb.dir;
    // shadow on the water/ground far below (only reads while high up)
    if (!crashing) {
      ctx.globalAlpha = 0.10;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(0, D.GROUND_Y - b.position.y, 20, 3, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.scale(dir, 1);
    ctx.scale(1.35, 1.35);      // v4: bigger sprite so it reads as a plane even on phones
    // far wing (pokes above the fuselage — classic side-view plane cue)
    ctx.fillStyle = '#2c3350';
    ctx.beginPath();
    ctx.moveTo(-2, -4);
    ctx.lineTo(6, -11);
    ctx.lineTo(12, -11);
    ctx.lineTo(7, -4);
    ctx.closePath();
    ctx.fill();
    // fuselage
    ctx.fillStyle = lb.color;
    ctx.beginPath();
    ctx.moveTo(-20, 0);
    ctx.quadraticCurveTo(-20, -5, -14, -5);
    ctx.lineTo(10, -5);
    ctx.quadraticCurveTo(19, -4.5, 21, 0);
    ctx.quadraticCurveTo(19, 4.5, 10, 5);
    ctx.lineTo(-14, 5);
    ctx.quadraticCurveTo(-20, 5, -20, 0);
    ctx.fill();
    // light rim so the shape reads against the night sky too
    var night = D.LB.sky ? D.LB.sky.night : 0;
    ctx.strokeStyle = 'rgba(255,255,255,' + (0.28 + 0.34 * night).toFixed(3) + ')';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    // tail fin + stabiliser + main wing: dark navy fills by day (glare-proof
    // against sun disc, clouds, pale sky) that LIFT toward a moonlit steel
    // tone as night rises, so the silhouette does not sink into the dark sky.
    // Light outline ties the shapes together in both regimes.
    var moonFill = 'rgb(' + Math.round(44 + 80 * night) + ',' + Math.round(51 + 85 * night) + ',' + Math.round(80 + 86 * night) + ')';
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = 'rgba(238,242,252,' + (0.5 + 0.42 * night).toFixed(3) + ')';
    // tail fin (vertical, swept back, rises well clear of the body)
    ctx.fillStyle = moonFill;
    ctx.beginPath();
    ctx.moveTo(-8, -4);
    ctx.lineTo(-12, -17);
    ctx.lineTo(-20, -17);
    ctx.lineTo(-19, -4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // horizontal stabiliser (little rear wing)
    ctx.beginPath();
    ctx.moveTo(-9, 1);
    ctx.lineTo(-19, 7);
    ctx.lineTo(-25, 7);
    ctx.lineTo(-22, 1);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // main wing (sweeps down-back, well clear of the fuselage)
    ctx.beginPath();
    ctx.moveTo(2, 2);
    ctx.lineTo(-5, 14);
    ctx.lineTo(-16, 14);
    ctx.lineTo(-10, 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // cockpit + cabin windows (bright, readable day and night)
    ctx.fillStyle = '#b9d9f7';
    ctx.fillRect(12, -3.6, 5, 3);
    for (var i = 0; i < 4; i++) ctx.fillRect(-6 + i * 4.4, -2.8, 2.4, 2.6);
    // propeller: full translucent disc + a blade streak that NEVER collapses
    // to a dot (the old ellipse's vertical extent went to zero whenever
    // cos() crossed zero and it read as a nose cone). Dark blades by day
    // (visible against the sun disc and pale sky) flip to moonlit light
    // blades at night so the prop never goes dark-on-dark.
    propSpin += 0.9;
    ctx.fillStyle = 'rgba(210,220,240,' + (0.20 + 0.16 * night).toFixed(3) + ')';
    ctx.beginPath();
    ctx.ellipse(22, 0, 2.6, 9, 0, 0, Math.PI * 2);
    ctx.fill();
    var blade = 5.5 + 3.5 * Math.abs(Math.sin(propSpin));
    ctx.strokeStyle = 'rgba(' + Math.round(31 + 183 * night) + ',' + Math.round(37 + 185 * night) + ',' + Math.round(64 + 180 * night) + ',' + (0.72 + 0.16 * night).toFixed(3) + ')';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(22, -blade);
    ctx.lineTo(22, blade);
    ctx.stroke();
    ctx.lineCap = 'butt';
    ctx.fillStyle = '#39405a';
    ctx.beginPath(); ctx.arc(22, 0, 1.8, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // v4.3: burning fuselage — flickering warm glow so the flames read by day
    if (lb.onFire) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.42 + 0.2 * Math.sin(time * 21);
      ctx.drawImage(D.SPR.glow.orange, b.position.x - 32, b.position.y - 26, 64, 52);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
    // soft glow halo at night so the little plane pops against the dark
    if (night > 0.2) {
      ctx.globalAlpha = 0.24 * night;
      ctx.drawImage(D.SPR.glow.white, b.position.x - 34, b.position.y - 34, 68, 68);
      ctx.globalAlpha = 1;
    }
    // nav beacon: steady dot (always legible at night) + a brighter pulse
    var pulse = Math.sin(time * 6) > 0.4;
    ctx.globalAlpha = 0.6 + 0.25 * night;
    ctx.fillStyle = crashing ? '#ff7060' : '#ff5a4e';
    ctx.beginPath();
    ctx.arc(b.position.x - dir * 13, b.position.y - 12, pulse ? 2.2 : 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    if (pulse && night > 0.2) {
      ctx.globalAlpha = 0.5 * night;
      ctx.drawImage(D.SPR.glow.red, b.position.x - dir * 13 - 6, b.position.y - 18, 12, 12);
      ctx.globalAlpha = 1;
    }
  }

  /* ---------------- API for game.js ---------------- */
  function info() {
    return {
      onScreen: !!plane,
      state: plane ? plane.state : null,
      crashes: crashes.length,
      planeCrashes: D.LB.events.planeCrashes,
      nextSpawnIn: plane ? null : Math.round(nextSpawn * 10) / 10,
      x: plane ? Math.round(plane.body.position.x) : null,
      y: plane ? Math.round(plane.body.position.y) : null,
      dir: plane ? plane.body.plugin.lb.dir : null,
      speed: plane ? Math.round(plane.body.plugin.lb.speed * 100) / 100 : null,
      angle: plane ? Math.round(plane.body.angle * 1000) / 1000 : null,
      onFire: burning(),                                                  // v4.3
      burnT: (plane && plane.body.plugin.lb.onFire) ? Math.round(plane.body.plugin.lb.onFire.t * 100) / 100 : 0  // v4.3
    };
  }

  return {
    init: function (deps) { D = deps; },

    /* dt in ms; runs in stepWorld (pauses with the weapon picker) */
    step: function (dt) {
      var dts = dt / 1000;
      stepCrashes(dts);

      if (!plane) {
        nextSpawn -= dts;
        if (nextSpawn <= 0) spawn();
        return;
      }
      var b = plane.body, lb = b.plugin.lb;
      if (!b || b.plugin.lb.removed) { plane = null; nextSpawn = rand(10, 20); return; }
      plane.t += dts;

      if (plane.state === 'flying') {
        // v4.3: burning — small flame trail while it keeps flying, then the
        // EXISTING crash path takes over (hit() = tumble + planeCrashes++)
        if (lb.onFire) {
          lb.onFire.t += dts;
          if ((D.step() % 2) === 0) {
            D.P.flame(b.position.x + rand(-12, 12), b.position.y + rand(-4, 6), -lb.dir * rand(0.2, 0.9), rand(-1.8, -0.6));
            if (Math.random() < 0.5) {
              D.P.spawn('smoke', b.position.x - lb.dir * 10, b.position.y, {
                vx: -lb.dir * 0.4, vy: rand(-1, -0.3), life: rand(0.7, 1.4),
                size: rand(6, 11), grow: 8, a: 0.3
              });
            }
          }
          if (lb.onFire.t >= lb.onFire.dur) { hit(b); return; }
        }
        // offscreen: gone (keeps the sky tidy + the spawn cadence honest)
        if (b.position.x < -320 || b.position.x > D.W + 320) { despawn(); return; }
        // kinematic cruise: pin pose + velocity every step (like road traffic).
        // The angle is PINNED too: the old approach set an angular VELOCITY
        // (cos wobble) which Matter integrated into a ±23° pitch oscillation
        // — at silhouette scale that read as constant stalling.
        var bob = Math.sin(plane.t * 1.7) * 4;
        D.M.Body.setPosition(b, { x: b.position.x, y: lb.alt + bob });
        D.M.Body.setVelocity(b, { x: lb.dir * lb.speed, y: 0 });
        D.M.Body.setAngle(b, 0.05 * Math.sin(plane.t * 1.7));   // gentle ±3° pitch: descending = nose down
        // soft contrail
        if ((D.step() % 3) === 0) {
          D.P.spawn('smoke', b.position.x - lb.dir * 22, b.position.y + 2, {
            vx: -lb.dir * 0.3, vy: rand(-0.15, 0.15), life: rand(0.8, 1.6),
            size: rand(4, 7), grow: 5, a: 0.16
          });
        }
      } else {
        // crashing: smoke + fire trail, falls with physics
        if ((D.step() % 2) === 0) {
          D.P.flame(b.position.x + rand(-8, 8), b.position.y + rand(-5, 5), rand(-0.8, 0.8), rand(-1.6, -0.4));
          D.P.spawn('smoke', b.position.x, b.position.y, {
            vx: rand(-0.4, 0.4), vy: rand(-0.8, -0.2), life: rand(1.0, 2.0),
            size: rand(9, 15), grow: 11, a: 0.4
          });
        }
        if (Math.random() < 0.3) D.P.sparks(b.position.x, b.position.y, 2, D.SPR.glow.orange, 4);
        // reached the world floor / water without hitting anything
        if (b.position.y > D.GROUND_Y - 8 || b.position.y > D.WATER_Y + 6 || plane.t > 7) impact();
      }
    },

    /* ---------------- API for game.js ---------------- */
    hit: hit,
    impact: impact,
    spawn: spawn,
    draw: draw,
    ignite: ignite,              // v4.3: fire ignition entry (game.js hook)
    igniteIfNear: igniteIfNear,  // v4.3: radius test + ignite (fire.js via deps)
    burning: burning,            // v4.3: planesOnFire counter source
    reset: function () {
      crashes.length = 0;
      if (plane) despawn();
      nextSpawn = rand(8, 16);
    },
    info: function () { return info(); },
    forceSpawn: function () {
      if (plane) return info();
      nextSpawn = 0;
      spawn();
      return info();
    },
    body: body
  };
})();
