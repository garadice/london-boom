/* ============================================================
   LONDON BOOM! — weather.js (v4)
   Weather system: CLEAR, CLOUDY, RAIN, STORM (rain + lightning +
   thunder), MIST. Auto-advances every ~20-40 s with a smooth
   cross-fade; the ⛅ weather button (and __TEST__.setWeather)
   jumps to the next state with a fast blend — kid-first.

   All sound is WebAudio-synthesized through the existing LB.audio
   engine (master gain honours mute; loops duck when the weapon
   picker pauses the world). Thunder is a LOW RUMBLE — noise burst
   + slow sine sweep, low-passed, delayed 0.5-1.5 s. No sharp
   bangs, ever (kid-safe).

   Plain script, no build step, no network. Loaded before game.js.
   ============================================================ */
window.LBWeather = (function () {
  'use strict';

  var D = null;                    // deps from game.js
  var ORDER = ['clear', 'cloudy', 'rain', 'storm', 'mist'];
  var BTN_EMO = { clear: '☀️', cloudy: '⛅', rain: '🌧️', storm: '⛈️', mist: '🌫️' };

  /* per-state visual/audible targets */
  var TARGETS = {
    clear:  { rain: 0.0, cloud: 0.35, fog: 0.0, dim: 0.00, wind: 0.10 },
    cloudy: { rain: 0.0, cloud: 1.00, fog: 0.0, dim: 0.10, wind: 0.35 },
    rain:   { rain: 0.7, cloud: 0.85, fog: 0.10, dim: 0.16, wind: 0.50 },
    storm:  { rain: 1.0, cloud: 1.00, fog: 0.05, dim: 0.22, wind: 0.80 },
    mist:   { rain: 0.0, cloud: 0.30, fog: 1.0, dim: 0.07, wind: 0.15 }
  };
  var RAIN_CAP = 300;

  var state = 'clear';
  var target = 'clear';
  var from = copyOf(TARGETS.clear);
  var cur = copyOf(TARGETS.clear);
  var blend = 1, blendDur = 1;
  var timer = 18;                  // first auto change comes reasonably soon
  var drops = [];
  var bolt = null;                 // { segs, branches, t, life }
  var nextStrike = 3;
  var birdTimer = 8;
  var ducked = false;

  function copyOf(o) { return { rain: o.rain, cloud: o.cloud, fog: o.fog, dim: o.dim, wind: o.wind }; }
  function lerp(a, b, u) { return a + (b - a) * u; }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  function buildDrops() {
    drops.length = 0;
    for (var i = 0; i < RAIN_CAP; i++) {
      drops.push({
        x: Math.random() * (D.W + 400) - 200,
        y: Math.random() * D.H,
        v: rand(560, 760),           // px/s
        drift: rand(-60, -20),       // wind blows left-ish like the clouds
        len: rand(11, 19)
      });
    }
  }
  function rand(a, b) { return a + Math.random() * (b - a); }

  function setBtn() {
    var el = document.getElementById('weatherBtn');
    if (el) el.textContent = BTN_EMO[target] || '⛅';
  }

  /* ---------------- audio loops (lazy, mute/pause-aware) ---------------- */
  var loops = { rain: null, wind: null };   // { src, g, lfo? }

  function makeLoop(kind, filterType, freq, q) {
    var A = D.LB.audio;
    if (!A.ctx || loops[kind]) return;
    try {
      var c = A.ctx;
      var src = c.createBufferSource(); src.buffer = A.noiseBuf; src.loop = true;
      var fl = c.createBiquadFilter(); fl.type = filterType; fl.frequency.value = freq; fl.Q.value = q || 0.8;
      var g = c.createGain(); g.gain.value = 0.0001;
      src.connect(fl); fl.connect(g); g.connect(A.master);
      src.start();
      loops[kind] = { src: src, g: g };
    } catch (e) { loops[kind] = null; }
  }

  function stepLoops() {
    var A = D.LB.audio;
    if (!A.ctx || A.muted) return;         // master gain also silences us; skip churn while muted
    if (cur.rain > 0.02) {
      makeLoop('rain', 'lowpass', 1500, 0.6);
      var rg = cur.rain * 0.12 * (state === 'storm' ? 1.15 : 1);
      if (loops.rain && !ducked) loops.rain.g.gain.setTargetAtTime(rg, A.ctx.currentTime, 0.4);
    } else if (loops.rain) {
      loops.rain.g.gain.setTargetAtTime(0.0001, A.ctx.currentTime, 0.5);
    }
    if (cur.wind > 0.02) {
      makeLoop('wind', 'lowpass', 260, 1.2);
      var wg = cur.wind * 0.085;
      if (loops.wind && !ducked) loops.wind.g.gain.setTargetAtTime(wg, A.ctx.currentTime, 0.6);
    } else if (loops.wind) {
      loops.wind.g.gain.setTargetAtTime(0.0001, A.ctx.currentTime, 0.6);
    }
  }

  /* picker opened: the whole world holds its breath — loops duck to silence.
     (The picker also suspends the AudioContext; this keeps the loops honest
     even if that ever changes. stepLoops() ramps levels back on unduck.) */
  function duck(on) {
    ducked = on;
    var A = D.LB.audio;
    if (!A.ctx) return;
    for (var k in loops) {
      if (loops[k]) loops[k].g.gain.setTargetAtTime(0.0001, A.ctx.currentTime, 0.15);
    }
    if (!on) stepLoops();                  // restore the weather targets
  }

  /* ---------------- lightning ---------------- */
  function strike() {
    var ctx = D.ctx;
    var x0 = rand(D.W * 0.08, D.W * 0.92);
    var y1 = rand(D.HORIZON_Y - 150, D.HORIZON_Y - 20);
    var segs = [[x0, -20]];
    var x = x0, y = -20, steps = 7 + (Math.random() * 4 | 0);
    for (var i = 1; i <= steps; i++) {
      y = -20 + (y1 + 20) * (i / steps);
      x += rand(-34, 34);
      segs.push([x, y]);
    }
    var branches = [];
    if (Math.random() < 0.7) {
      var bi = 1 + (Math.random() * (segs.length - 3) | 0);
      var b = [[segs[bi][0], segs[bi][1]]];
      var bx = segs[bi][0], by = segs[bi][1];
      for (var j = 0; j < 3; j++) { bx += rand(-50, 10); by += rand(18, 42); b.push([bx, by]); }
      branches.push(b);
    }
    bolt = { segs: segs, branches: branches, t: 0, life: 0.24 };
    D.LB.flash = Math.min(D.LB.flash + 0.5, 1);
    D.LB.events.lightningStrikes++;
    // kid-safe thunder: low rumble = low-passed noise + slow sine sweep, delayed
    var delay = rand(0.5, 1.5);
    D.LB.audio.noise(1.8, 0.34, 'lowpass', 320, 48, 0.7, false, delay);
    D.LB.audio.tone('sine', 82, 26, 1.6, 0.4, delay);
    D.LB.audio.noise(2.6, 0.16, 'lowpass', 180, 40, 0.8, false, delay + 0.35);
  }

  /* ---------------- birds (clear day, quiet + cute) ---------------- */
  function chirp() {
    var A = D.LB.audio;
    if (!A.ok()) return;
    var f = rand(2300, 3200);
    var n = 2 + (Math.random() * 2 | 0);
    for (var i = 0; i < n; i++) {
      A.tone('sine', f + rand(-150, 220), f * 1.18, 0.07, 0.04, i * 0.11);
    }
  }

  /* ============================================================ */
  return {
    init: function (deps) {
      D = deps;
      buildDrops();
      D.LB.weather = {
        state: function () { return state; },
        cur: cur
      };
      setBtn();
    },

    /* dt in ms; runs in stepWorld (pauses with the weapon picker) */
    step: function (dt) {
      var dts = dt / 1000;

      // cross-fade toward the target profile
      if (blend < 1) {
        blend = Math.min(1, blend + dts / blendDur);
        var u = smooth(blend);
        var T = TARGETS[target];
        cur.rain = lerp(from.rain, T.rain, u);
        cur.cloud = lerp(from.cloud, T.cloud, u);
        cur.fog = lerp(from.fog, T.fog, u);
        cur.dim = lerp(from.dim, T.dim, u);
        cur.wind = lerp(from.wind, T.wind, u);
      }

      // auto-advance with random durations (~20-40 s)
      timer -= dts;
      if (timer <= 0) { next(); }

      // rain particles
      if (cur.rain > 0.01) {
        var active = Math.round(RAIN_CAP * cur.rain);
        var splashBudget = 2;                     // bounded splashes per step
        for (var i = 0; i < active; i++) {
          var p = drops[i];
          p.y += p.v * dts;
          p.x += p.drift * dts;
          if (p.y > D.GROUND_Y + rand(0, 36)) {
            if (splashBudget > 0 && Math.random() < 0.05) {
              splashBudget--;
              D.P.splash(p.x, D.GROUND_Y + rand(2, 30), 1);
            }
            p.y = rand(-80, -10);
            p.x = Math.random() * (D.W + 400) - 200;
          }
        }
      }

      // lightning scheduler (only once the storm has blended in a little)
      if (target === 'storm' && blend > 0.5) {
        nextStrike -= dts;
        if (nextStrike <= 0) {
          strike();
          nextStrike = rand(2.5, 7);
        }
      }
      if (bolt) {
        bolt.t += dts;
        if (bolt.t > bolt.life) bolt = null;
      }

      // birds on clear days
      if (target === 'clear' && D.LB.sky && D.LB.sky.light > 0.75 && blend >= 1) {
        birdTimer -= dts;
        if (birdTimer <= 0) { chirp(); birdTimer = rand(7, 16); }
      }

      stepLoops();
    },

    /* ---------------- state changes ---------------- */
    /* auto transition: gentle 4 s cross-fade */
    next: function () { return next(); },

    /* forced change (button / tests): near-instant 0.8 s blend, kid-first */
    force: function (name) {
      if (TARGETS[name] === undefined) return info();
      begin(name, 0.8);
      timer = rand(20, 40);
      setBtn();
      return info();
    },

    cycle: function () { return next(); },

    duck: duck,

    lightningInfo: function () {
      return { strikes: D.LB.events.lightningStrikes, boltOnScreen: !!bolt };
    },

    info: function () { return info(); },

    /* ---------------- painting ---------------- */

    /* world space, right after the skyline: distant haze that eats the far buildings */
    drawFarMist: function (time) {
      if (cur.fog < 0.02) return;
      var ctx = D.ctx;
      var a = cur.fog;
      band(ctx, time, D.HORIZON_Y - 150, 90, 0.16 * a, 24);
      band(ctx, time, D.HORIZON_Y - 60, 80, 0.22 * a, -30);
    },

    /* world space, in front of everything: rain streaks, near fog, bolt */
    drawRain: function (time) {
      var ctx = D.ctx;
      if (cur.rain > 0.01) {
        var active = Math.round(RAIN_CAP * cur.rain);
        ctx.strokeStyle = 'rgba(175,198,255,0.42)';
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        for (var i = 0; i < active; i++) {
          var p = drops[i];
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x + p.drift * 0.028 * p.len, p.y + p.len);
        }
        ctx.stroke();
      }
      if (cur.fog > 0.02) {
        band(ctx, time, D.GROUND_Y - 90, 110, 0.13 * cur.fog, 40);
        band(ctx, time, D.HORIZON_Y - 20, 70, 0.10 * cur.fog, -18);
      }
    },

    drawBolt: function () {
      if (!bolt) return;
      var ctx = D.ctx;
      var k = bolt.t / bolt.life;
      var flick = bolt.t < 0.07 ? 1 : (1 - k) * (0.55 + 0.45 * Math.sin(bolt.t * 90));
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      strokeBolt(ctx, bolt.segs, 'rgba(190,160,255,' + (0.5 * flick).toFixed(3) + ')', 7);
      strokeBolt(ctx, bolt.segs, 'rgba(255,255,255,' + (0.95 * flick).toFixed(3) + ')', 2.4);
      for (var i = 0; i < bolt.branches.length; i++) {
        strokeBolt(ctx, bolt.branches[i], 'rgba(255,255,255,' + (0.6 * flick).toFixed(3) + ')', 1.4);
      }
      ctx.globalCompositeOperation = 'source-over';
    },

    /* for __TEST__ */
    STATE_ORDER: ORDER
  };

  /* ---------------- helpers shared with the exposed object ---------------- */
  function smooth(u) { return u * u * (3 - 2 * u); }

  function info() {
    var active = Math.round(RAIN_CAP * cur.rain);
    return {
      state: state, target: target, blend: Math.round(blend * 1000) / 1000,
      rainDrops: cur.rain > 0.01 ? active : 0,
      fog: Math.round(cur.fog * 100) / 100, dim: Math.round(cur.dim * 100) / 100,
      lightningStrikes: D.LB.events.lightningStrikes
    };
  }

  function begin(name, dur) {
    from = copyOf(cur);
    state = name;                 // the weather IS what it is becoming (blend carries the visuals)
    target = name;
    blendDur = dur;
    blend = 0;
  }

  function next() {
    var i = ORDER.indexOf(target);
    var n = ORDER[(i + 1) % ORDER.length];
    begin(n, 4);
    timer = rand(20, 40);
    setBtn();
    return info();
  }

  function band(ctx, time, y, h, a, drift) {
    var x = (time * drift) % 300;
    var g = ctx.createLinearGradient(0, y - h / 2, 0, y + h / 2);
    g.addColorStop(0, 'rgba(210,220,240,0)');
    g.addColorStop(0.5, 'rgba(210,220,240,' + a.toFixed(3) + ')');
    g.addColorStop(1, 'rgba(210,220,240,0)');
    ctx.fillStyle = g;
    ctx.save();
    ctx.translate(x - 150, 0);
    ctx.fillRect(-200, y - h / 2, D.W + 900, h);
    ctx.restore();
  }

  function strokeBolt(ctx, segs, col, w) {
    ctx.strokeStyle = col;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(segs[0][0], segs[0][1]);
    for (var i = 1; i < segs.length; i++) ctx.lineTo(segs[i][0], segs[i][1]);
    ctx.stroke();
  }
})();
