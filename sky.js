/* ============================================================
   LONDON BOOM! — sky.js (v4)
   Day/night cycle: 60 s day + 60 s night, continuous loop from
   page load. Smooth palette interpolation (sunrise -> day ->
   sunset -> night), arcing sun + moon (canvas-drawn, soft glow),
   twinkling stars, and an ambient-light model the rest of the
   game reads (LB.sky) to tint the world and light the windows.

   Ambient WORLD time: deliberately NOT reset by NEW GAME, and
   NOT touched here — the HUD clock keeps real local time.

   Plain script, no build step, no network. Loaded before game.js;
   game.js calls LBSky.init(deps) once at boot.
   ============================================================ */
window.LBSky = (function () {
  'use strict';

  var D = null;                 // deps from game.js
  var CYCLE = 120;              // seconds: 60 day + 60 night
  var t = 0.30;                 // cycle position 0..1 (start mid-morning: kid sees day first)
  var S = null;                 // computed state (see compute())

  /* ---- palette keyframes: 6 gradient stops top -> horizon ---- */
  function K(name, t, sky, light, star, warm) {
    return { name: name, t: t, sky: sky, light: light, star: star, warm: warm };
  }
  var KEYS = [
    K('sunrise', 0.00, [[42, 58, 110], [90, 74, 126], [168, 90, 106], [224, 122, 74], [245, 160, 85], [255, 202, 112]], 0.45, 0.15, 1.0),
    K('morning', 0.06, [[63, 143, 216], [90, 168, 232], [127, 192, 242], [168, 216, 248], [200, 232, 252], [255, 232, 192]], 0.92, 0.0, 0.2),
    K('noon', 0.25, [[63, 151, 224], [95, 176, 236], [130, 200, 244], [168, 220, 250], [200, 236, 255], [232, 246, 255]], 1.0, 0.0, 0.0),
    K('golden', 0.44, [[58, 111, 184], [90, 134, 204], [143, 168, 220], [222, 166, 106], [245, 192, 112], [255, 216, 144]], 0.75, 0.0, 0.75),
    K('sunset', 0.50, [[26, 42, 94], [58, 42, 98], [122, 58, 94], [200, 90, 58], [240, 138, 69], [255, 190, 96]], 0.42, 0.10, 1.0),
    K('dusk', 0.565, [[10, 14, 46], [20, 26, 68], [38, 38, 90], [74, 42, 88], [122, 64, 80], [176, 96, 72]], 0.20, 0.50, 0.45),
    K('night', 0.62, [[5, 8, 31], [10, 15, 48], [19, 26, 68], [29, 33, 72], [42, 40, 80], [58, 50, 82]], 0.07, 1.0, 0.0),
    K('deepnight', 0.86, [[5, 8, 31], [10, 15, 48], [19, 26, 68], [29, 33, 72], [42, 40, 80], [58, 50, 82]], 0.07, 1.0, 0.0),
    K('predawn', 0.93, [[7, 11, 38], [16, 22, 64], [28, 34, 78], [48, 42, 86], [80, 58, 88], [138, 90, 80]], 0.16, 0.5, 0.4)
    // t=1.0 wraps to KEYS[0] (sunrise again)
  ];

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function lerp(a, b, u) { return a + (b - a) * u; }
  function smooth(u) { return u * u * (3 - 2 * u); }

  function keyAt(tt) {
    var i = 0;
    while (i < KEYS.length - 1 && KEYS[i + 1].t <= tt) i++;
    return i;
  }

  function compute() {
    var tt = t - Math.floor(t);
    var i0 = keyAt(tt);
    var k0 = KEYS[i0];
    var k1 = KEYS[(i0 + 1) % KEYS.length];
    var span = (k1.t > k0.t ? k1.t - k0.t : 1 - k0.t + k1.t);
    var frac = tt - k0.t;
    if (frac < 0) frac += 1;
    var u = smooth(clamp01(frac / span));
    var sky = [];
    for (var s = 0; s < 6; s++) {
      var c = [];
      for (var ch = 0; ch < 3; ch++) c.push(Math.round(lerp(k0.sky[s][ch], k1.sky[s][ch], u)));
      sky.push(c);
    }
    var light = lerp(k0.light, k1.light, u);
    var star = lerp(k0.star, k1.star, u);
    var warm = lerp(k0.warm, k1.warm, u);
    var night = clamp01((0.55 - light) / 0.49);

    // sun arcs the day half, moon the night half; both rise one horizon, set the other
    var sun = { x: 0, y: 0, up: false, prog: 0 };
    var moon = { x: 0, y: 0, up: false, prog: 0 };
    if (tt < 0.5) {
      sun.prog = clamp01(tt / 0.5);
      sun.x = -140 + sun.prog * (D.W + 280);
      // arc peak stays at y≈200: above the tower tip, clear of the HUD buttons
      sun.y = (D.HORIZON_Y + 30) - Math.sin(sun.prog * Math.PI) * (D.HORIZON_Y - 170);
      sun.up = sun.y < D.HORIZON_Y + 40;
    } else {
      moon.prog = clamp01((tt - 0.5) / 0.5);
      moon.x = -140 + moon.prog * (D.W + 280);
      moon.y = (D.HORIZON_Y + 30) - Math.sin(moon.prog * Math.PI) * (D.HORIZON_Y - 170);
      moon.up = moon.y < D.HORIZON_Y + 40;
    }
    var name = u < 0.5 ? k0.name : k1.name;
    S = { t: tt, phase: name, light: light, night: night, star: star, warm: warm, sky: sky, sun: sun, moon: moon };
    D.LB.sky = S;              // the rest of the game reads plain fields
  }

  /* ---- stars + clouds (deterministic like the rest of the scene) ---- */
  function prng(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var z = Math.imul(a ^ (a >>> 15), 1 | a);
      z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;
      return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
    };
  }
  var stars = [];
  var clouds = [];

  /* ============================================================ */

  return {
    init: function (deps) {
      D = deps;
      var r = prng(20261029);
      var i;
      for (i = 0; i < 150; i++) {
        stars.push({ x: -1300 + r() * 4300, y: r() * 520, s: 0.5 + r() * 1.4, ph: r() * 10, sp: 0.5 + r() * 2 });
      }
      for (i = 0; i < 7; i++) {
        clouds.push({ x: -1200 + r() * 4200, y: 50 + r() * 260, sp: 2 + r() * 6, sc: 0.7 + r() * 1.1, seed: r() * 10 });
      }
      compute();
    },

    /* ambient world clock — runs in stepWorld (pauses with the weapon picker) */
    step: function (dtMs) {
      t = (t + dtMs / 1000 / CYCLE) % 1;
      compute();
    },

    get: function () { return S; },
    setT: function (v) { t = ((v % 1) + 1) % 1; compute(); return S; },

    /* ---------------- painting ---------------- */

    /* screen space: the sky gradient + horizon glow (called before the world transform) */
    drawSky: function () {
      var ctx = D.ctx, hy = D.HORIZON_Y * D.vs() + D.offY();
      var g = ctx.createLinearGradient(0, 0, 0, Math.max(hy + 70, 10));
      var stops = [0, 0.38, 0.62, 0.8, 0.91, 1];
      for (var s = 0; s < 6; s++) {
        var c = S.sky[s];
        g.addColorStop(stops[s], 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')');
      }
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, D.cw(), Math.max(hy + 70, D.ch()));
      var dark = S.sky[0];
      ctx.fillStyle = 'rgb(' + Math.round(dark[0] * 0.8) + ',' + Math.round(dark[1] * 0.8) + ',' + Math.round(dark[2] * 0.9) + ')';
      ctx.fillRect(0, hy + 60, D.cw(), D.ch());
      // warm glow hugging the horizon near the sun (sunrise/sunset only)
      if (S.warm > 0.05) {
        var sunK = clamp01(S.sun.x / D.W);
        var gx = D.cw() * (0.12 + 0.76 * sunK);
        var rg = ctx.createRadialGradient(gx, hy, 10, gx, hy, D.cw() * 0.55);
        rg.addColorStop(0, 'rgba(255,150,70,' + (0.30 * S.warm).toFixed(3) + ')');
        rg.addColorStop(0.5, 'rgba(255,120,60,' + (0.12 * S.warm).toFixed(3) + ')');
        rg.addColorStop(1, 'rgba(255,120,60,0)');
        ctx.fillStyle = rg;
        ctx.fillRect(0, 0, D.cw(), hy + 60);
      }
    },

    /* world space: stars + sun/moon + clouds, behind weather layers */
    drawStars: function (time) {
      if (S.star <= 0.02) return;
      var ctx = D.ctx;
      ctx.fillStyle = '#fff';
      for (var i = 0; i < stars.length; i++) {
        var s = stars[i];
        var tw = 0.4 + 0.6 * Math.abs(Math.sin(time * s.sp + s.ph));
        ctx.globalAlpha = tw * 0.85 * S.star * (1 - s.y / 600);
        ctx.fillRect(s.x, s.y, s.s, s.s);
      }
      ctx.globalAlpha = 1;
    },

    drawSunMoon: function () {
      var ctx = D.ctx;
      if (S.sun.up) {
        var sx = S.sun.x, sy = S.sun.y;
        var near = 1 - clamp01(sy / (D.HORIZON_Y * 0.9));   // bigger/warmer when low
        ctx.globalAlpha = 0.85;
        ctx.drawImage(D.SPR.glow.gold, sx - 130, sy - 130, 260, 260);
        ctx.globalAlpha = 0.35;
        ctx.drawImage(D.SPR.glow.orange, sx - 190, sy - 190, 380, 380);
        ctx.globalAlpha = 1;
        ctx.fillStyle = near > 0.6 ? '#fff0c0' : '#fff8e0';
        ctx.beginPath(); ctx.arc(sx, sy, 30 + near * 8, 0, Math.PI * 2); ctx.fill();
      }
      if (S.moon.up) {
        var mx = S.moon.x, my = S.moon.y;
        ctx.globalAlpha = 0.9;
        ctx.drawImage(D.SPR.glow.white, mx - 110, my - 110, 220, 220);
        ctx.globalAlpha = 0.25;
        ctx.drawImage(D.SPR.glow.gold, mx - 150, my - 150, 300, 300);
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#e9edf5';
        ctx.beginPath(); ctx.arc(mx, my, 33, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(180,190,210,0.5)';
        ctx.beginPath(); ctx.arc(mx - 10, my - 8, 7, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(mx + 9, my + 10, 5, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(mx + 13, my - 12, 4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(9,12,32,0.25)';
        ctx.beginPath(); ctx.arc(mx - 14, my - 14, 32, 0, Math.PI * 2); ctx.fill();
      }
    },

    /* clouds react to weather (coverage/alpha via LB.weather) and to daylight */
    drawClouds: function (time) {
      var ctx = D.ctx;
      var w = D.LB.weather;
      var cover = w ? w.cur.cloud : 0.35;
      var n = Math.max(1, Math.round(clouds.length * clamp01(cover / 0.85 + 0.15)));
      var dayK = clamp01((S.light - 0.35) / 0.55);
      var cr = Math.round(lerp(40, 235, dayK));
      var cg = Math.round(lerp(47, 240, dayK));
      var cb = Math.round(lerp(92, 248, dayK));
      var baseA = 0.5 + 0.28 * clamp01(cover - 0.3);
      for (var i = 0; i < n; i++) {
        var c = clouds[i];
        var x = ((c.x + time * c.sp) % 4200) - 1300;
        ctx.save();
        ctx.translate(x, c.y + Math.sin(time * 0.1 + c.seed) * 6);
        ctx.scale(c.sc, c.sc);
        ctx.fillStyle = 'rgba(' + cr + ',' + cg + ',' + cb + ',' + baseA.toFixed(3) + ')';
        ctx.beginPath();
        ctx.ellipse(0, 0, 90, 26, 0, 0, Math.PI * 2);
        ctx.ellipse(-60, 8, 55, 18, 0, 0, Math.PI * 2);
        ctx.ellipse(58, 6, 60, 20, 0, 0, Math.PI * 2);
        ctx.ellipse(10, -14, 50, 18, 0, 0, Math.PI * 2);
        ctx.fill();
        if (S.warm > 0.2 && S.night < 0.6) {
          ctx.fillStyle = 'rgba(255,150,90,' + (0.10 * S.warm).toFixed(3) + ')';
          ctx.beginPath();
          ctx.ellipse(6, 14, 80, 10, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    },

    /* screen space ambience: world tint + sunshine lift (before flash/vignette).
       Perf: the dark/warm/dim overlays are pre-mixed into ONE full-screen fill
       (SwiftShader full-screen passes are not free); only the additive daylight
       lift is a second pass. */
    drawTint: function () {
      var ctx = D.ctx;
      var w = D.LB.weather;
      var sunK = clamp01((S.light - 0.5) / 0.5);
      if (sunK > 0.02) {
        // daylight: a warm additive lift — the dusk-tuned scene reads as sunshine
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = 'rgba(255,244,214,' + (0.12 * sunK).toFixed(3) + ')';
        ctx.fillRect(0, 0, D.cw(), D.ch());
        ctx.globalCompositeOperation = 'source-over';
      }
      // pre-mix night (8,12,40) + sunset warm (255,140,60) + weather dim (10,14,32)
      var layers = [];
      if (S.night > 0.01) layers.push({ c: [8, 12, 40], a: 0.32 * S.night });
      if (S.warm > 0.05 && S.night < 0.8) layers.push({ c: [255, 140, 60], a: 0.09 * S.warm * (1 - S.night) });
      if (w && w.cur.dim > 0.01) layers.push({ c: [10, 14, 32], a: w.cur.dim });
      if (layers.length) {
        // exact "over" compositing of the stack, bottom-up, into one fill
        var r = 0, g = 0, b = 0, aOut = 0;
        for (var i = layers.length - 1; i >= 0; i--) {
          var L = layers[i];
          aOut = L.a + aOut * (1 - L.a);
          r = L.c[0] * L.a + r * (1 - L.a);
          g = L.c[1] * L.a + g * (1 - L.a);
          b = L.c[2] * L.a + b * (1 - L.a);
        }
        if (aOut > 0.004) {
          ctx.fillStyle = 'rgba(' + Math.round(r) + ',' + Math.round(g) + ',' + Math.round(b) + ',' + aOut.toFixed(3) + ')';
          ctx.fillRect(0, 0, D.cw(), D.ch());
        }
      }
    },

    /* world space: warm window glow on the standing city at night.
       Windows are PAINTED on the block sprites, so the night pass is a
       separate additive layer — no physics, no sprite rebuilds. */
    drawNightWindows: function () {
      if (S.night <= 0.03) return;
      var ctx = D.ctx, LB = D.LB;
      var bodies = LB.bodies;
      ctx.globalCompositeOperation = 'lighter';
      var a = S.night;
      for (var i = 0; i < bodies.length; i++) {
        var b = bodies[i], lb = b.plugin.lb;
        if (!lb || lb.removed) continue;
        var standing = b.angle > -0.05 && b.angle < 0.05;
        if (lb.kind === 'shaftWin') {
          ctx.globalAlpha = 0.42 * a;
          var w = lb.w || 10.65;
          if (standing) {
            ctx.drawImage(D.SPR.glow.gold, b.position.x - w * 0.2 - 5, b.position.y - 5, 10, 10);
            ctx.drawImage(D.SPR.glow.gold, b.position.x + w * 0.2 - 5, b.position.y - 5, 10, 10);
          } else {
            ctx.drawImage(D.SPR.glow.gold, b.position.x - 5, b.position.y - 5, 10, 10);
          }
        } else if (lb.kind === 'annexWin') {
          ctx.globalAlpha = 0.5 * a;
          ctx.drawImage(D.SPR.glow.gold, b.position.x - 7, b.position.y - 6, 14, 12);
        } else if (lb.kind === 'louvre') {
          // the belfry glows from inside — the bells are up there
          ctx.globalAlpha = 0.22 * a;
          ctx.drawImage(D.SPR.glow.gold, b.position.x - 8, b.position.y - 8, 16, 16);
        }
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
  };
})();
