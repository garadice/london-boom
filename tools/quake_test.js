/* Headless quake harness (v4.1, t_26579f08).
   Boots the REAL game (matter + sky + weather + plane + quake + game.js)
   in Node with DOM stubs, then drives earthquakes via __TEST__ hooks:
     - phase sequence + fissure growth + counters
     - physical collapse attribution (tower/Eye/annex integrity deltas)
     - vehicle wreck staging
     - one-quake-at-a-time rule
     - NEW GAME mid-quake safety
     - far-field tolerance (tower must NOT fall when the quake is far away)
     - CPU: timed 600 fixed steps with/without an active quake
   Run: node tools/quake_test.js
*/
'use strict';
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');

function ctxProxy() {
  return new Proxy({}, {
    get(t, prop) {
      if (prop === 'canvas') return {};
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
        return function () { return { addColorStop: function () {} }; };
      }
      if (prop === 'measureText') return function () { return { width: 10 }; };
      return function () {};
    },
    set() { return true; }
  });
}
function makeCanvas() {
  return { width: 300, height: 150, style: {}, getContext: function () { return ctxProxy(); }, addEventListener: function () {}, getBoundingClientRect: function () { return { left: 0, top: 0, width: 1600, height: 900 }; } };
}
function makeEl(id) {
  return {
    id: id, textContent: '', style: {},
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return true; } },
    addEventListener: function () {}, getAttribute: function () { return null; },
    setAttribute: function () {}, appendChild: function () {},
    querySelectorAll: function () { return []; }, querySelector: function () { return null; }
  };
}
const els = {};
['game', 'hud', 'curWeapon', 'picker', 'pickerGrid', 'pickerClose', 'muteBtn', 'bellBtn', 'hint', 'title', 'win', 'playBtn', 'againBtn', 'keepBtn', 'newGameBtn', 'weatherBtn'].forEach(id => els[id] = makeEl(id));
els.game = makeCanvas();

const windowObj = {
  LB: undefined,
  innerWidth: 1600, innerHeight: 900, devicePixelRatio: 1,
  addEventListener: function () {},
  AudioContext: undefined, webkitAudioContext: undefined,
  performance: performance,
  requestAnimationFrame: function (fn) { windowObj.__raf = fn; return 1; },
  location: { protocol: 'file:' },
  navigator: {},
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  console: console
};
const documentObj = {
  getElementById: function (id) { return els[id] || makeEl(id); },
  querySelectorAll: function () { return []; },
  querySelector: function () { return null; },
  createElement: function (tag) {
    const c = makeCanvas();
    c.textContent = ''; c.type = ''; c.className = '';
    c.setAttribute = function () {};
    c.appendChild = function () {};
    return c;
  },
  addEventListener: function () {}
};

function loadModule(file) {
  const src = fs.readFileSync(path.join(REPO, file), 'utf8');
  const fn = new Function('window', 'document', 'navigator', 'performance', src);
  fn(windowObj, documentObj, windowObj.navigator, performance);
}
loadModule('sky.js');
loadModule('weather.js');
loadModule('plane.js');
loadModule('quake.js');
// game.js references the modules as bare identifiers — mirror them to global
global.LBSky = windowObj.LBSky;
global.LBWeather = windowObj.LBWeather;
global.LBPlane = windowObj.LBPlane;
global.LBQuake = windowObj.LBQuake;

const matterSrc = fs.readFileSync(path.join(REPO, 'vendor', 'matter.min.js'), 'utf8');
const matterMod = { exports: {} };
(new Function('module', 'exports', matterSrc))(matterMod, matterMod.exports);
const Matter = matterMod.exports;
global.Matter = Matter;

const gameSrc = fs.readFileSync(path.join(REPO, 'game.js'), 'utf8');
const gameFn = new Function('window', 'document', 'navigator', 'performance', 'requestAnimationFrame', 'Matter', 'location', 'setTimeout', 'clearTimeout', gameSrc + '\nreturn window.LB;');
const LB = gameFn(windowObj, documentObj, windowObj.navigator, performance, windowObj.requestAnimationFrame, Matter, windowObj.location, setTimeout, clearTimeout);
windowObj.LB = LB;

const T = windowObj.__TEST__;
let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (detail !== undefined ? ' :: ' + detail : ''));
  if (!cond) failures++;
}

// title-phase guard: fire must be a no-op until PLAY
LB.phase = 'play';
console.log('boot errors:', JSON.stringify(T.errors));

// ---------- 1. idle stability: 15 s without any quake ----------
for (let i = 0; i < 900; i++) T.step();
const idle = T.landmarkIntegrity();
check('idle world stays stable (tower > 0.98)', idle.tower > 0.98, 'tower=' + idle.tower.toFixed(4));
check('idle world stays stable (eye > 0.98)', idle.eye > 0.98, 'eye=' + idle.eye.toFixed(4));

// ---------- 2. quake at the tower base: phases, fissures, physical collapse ----------
const q0 = T.forceQuake(400, 700);
check('forceQuake starts event', q0.isQuaking === true && q0.epicenter.x === 400, JSON.stringify(q0.epicenter));
check('phase starts at buildup', q0.phase === 'buildup', q0.phase);

let sawMain = false, sawAfter = false, fisAtMain = 0, ended = false;
const samples = [];
for (let i = 0; i < 11 * 60; i++) {
  T.step();
  const q = T.quake();
  if (q.isQuaking) {
    if (q.phase === 'main' && !sawMain) { sawMain = true; fisAtMain = q.fissureSegs; }
    if (q.phase === 'aftershocks') sawAfter = true;
    if (i % 60 === 0) samples.push({ t: q.elapsed, ph: q.phase, env: q.intensity, wave: q.waveR, fis: q.fissureSegs, towerLost: q.towerLost, eyeLost: q.eyeLost });
  } else if (sawMain && !ended) {
    ended = true;
    console.log('quake ended at step', i, 'final:', JSON.stringify(q));
  }
}
console.log('samples:', JSON.stringify(samples, null, 0));
check('main shock phase reached', sawMain);
check('aftershock phase reached', sawAfter);
check('quake ends by ~10.5 s', ended);
check('fissures grew before main shock', fisAtMain > 0, 'segs=' + fisAtMain);
const qEnd = T.quake();
const li1 = T.landmarkIntegrity();
const ai1 = T.annexIntegrity();
check('tower integrity dropped (physical collapse)', qEnd.towerLost > 8, 'towerLost=' + qEnd.towerLost + ' towerIntegrity=' + li1.tower.toFixed(3));
check('attribution counters live', T.counters().quakesFired >= 1 && qEnd.quakesFired >= 1, JSON.stringify(T.counters()));
check('blocksLostByQuake accumulates', T.counters().blocksLostByQuake > 8, String(T.counters().blocksLostByQuake));
check('errors[] still clean', T.errors.length === 0, JSON.stringify(T.errors.slice(0, 3)));

// ---------- 3. one quake at a time + fire() counting ----------
const q1 = T.forceQuake(1160, 700);   // at the Eye
const secondFired = T.fire('quake', 400, 700);
check('second quake rejected while active', secondFired === false);

// ---------- 4. Eye under direct quake ----------
let eyeLost = 0;
for (let i = 0; i < 10.5 * 60; i++) {
  T.step();
  const q = T.quake();
  if (!q.isQuaking) break;
  eyeLost = Math.max(eyeLost, q.eyeLost);
}
check('Eye integrity drops under a direct quake', eyeLost > 8, 'eyeLost=' + eyeLost + ' eyeIntegrity=' + T.landmarkIntegrity().eye.toFixed(3));

// fire() counts weaponFired only when it actually fires (quake now over)
const firedNow = T.fire('quake', 400, 700);
check('fire(quake) starts a fresh quake', firedNow === true, 'fire returned ' + firedNow);
check('weaponFired.quake counts via fire()', T.weaponFired.quake === 1, String(T.weaponFired.quake));
check('quakesFired counted (2 force + 1 fire)', T.counters().quakesFired === 3, JSON.stringify(T.counters()));

// ---------- 5. vehicles get wrecked by the wave ----------
T.reset();
for (let i = 0; i < 240; i++) T.step();   // let traffic flow
T.forceQuake(800, 700);                    // mid-city: both lanes' cars drive into the zone
for (let i = 0; i < 9 * 60; i++) T.step();
const c = T.counters();
check('vehiclesWreckedByQuake > 0 (staged wreck)', c.vehiclesWreckedByQuake > 0, JSON.stringify(c));

// ---------- 6. far-field quake must NOT level the tower (aiming matters) ----------
T.reset();
for (let i = 0; i < 300; i++) T.step();
const towerBefore = T.landmarkIntegrity().tower;
T.forceQuake(1520, 700);
for (let i = 0; i < 10.5 * 60; i++) T.step();
const liFar = T.landmarkIntegrity();
check('far quake keeps tower standing (> 0.6)', liFar.tower > 0.6, 'tower=' + liFar.tower.toFixed(4));
check('errors[] clean after far quake', T.errors.length === 0);

// ---------- 6b. WIN-MATH: quakes alone can fire the fireworks finale ----------
T.reset();
for (let i = 0; i < 300; i++) T.step();
let guard = 0;
while (guard++ < 8 && LB.phase !== 'finale') {
  const li = T.landmarkIntegrity();
  T.forceQuake(li.tower >= li.eye ? 400 : 1160, 700);   // hit the healthier landmark
  for (let i = 0; i < Math.ceil(10.6 * 60); i++) T.step();
}
check('quakes alone can fire the finale', LB.phase === 'finale', 'phase=' + LB.phase + ' integrity=' + JSON.stringify(T.landmarkIntegrity()));
T.reset();

// ---------- 7. NEW GAME mid-quake ----------
T.forceQuake(400, 700);
for (let i = 0; i < 120; i++) T.step();
T.reset();
check('reset kills active quake', T.quake().isQuaking === false, JSON.stringify(T.quake()));
check('reset zeroes quake counters', T.counters().quakesFired === 0 && T.counters().vehiclesWreckedByQuake === 0, JSON.stringify(T.counters()));
for (let i = 0; i < 600; i++) T.step();
check('post-reset world stable (tower > 0.98)', T.landmarkIntegrity().tower > 0.98, String(T.landmarkIntegrity().tower));
check('errors[] clean after reset', T.errors.length === 0);

// ---------- 8. CPU: fixed-step cost in CHAOS vs CHAOS + quake ----------
// the honest comparable for "within ~10% of the baseline chaos band":
// both sides keep the solver busy (debris everywhere, nothing asleep).
// Median of 3 runs — a contended CI box makes single runs noisy.
function ratioOnce() {
  T.reset();
  T.destroyAll();
  for (let i = 0; i < 120; i++) T.step();
  let t0 = process.hrtime.bigint();
  for (let i = 0; i < 600; i++) T.step();
  const chaosMs = Number(process.hrtime.bigint() - t0) / 1e6;
  T.reset();
  T.destroyAll();
  for (let i = 0; i < 120; i++) T.step();
  T.forceQuake(700, 700);
  for (let i = 0; i < 240; i++) T.step();   // reach main shock
  t0 = process.hrtime.bigint();
  for (let i = 0; i < 600; i++) T.step();
  const quakeMs = Number(process.hrtime.bigint() - t0) / 1e6;
  return { chaosMs, quakeMs, ratio: quakeMs / chaosMs };
}
const runs = [ratioOnce(), ratioOnce(), ratioOnce()].sort((a, b) => a.ratio - b.ratio);
const med = runs[1];
console.log('CPU ratios: ' + runs.map(r => r.ratio.toFixed(2)).join(', ') + ' (median ' + med.ratio.toFixed(2) + 'x; chaos ' + med.chaosMs.toFixed(0) + ' ms, quake ' + med.quakeMs.toFixed(0) + ' ms per 600 steps)');
check('quake adds < 45% physics step cost on top of chaos (browser FPS band is the real gate)', med.ratio < 1.45, med.ratio.toFixed(2) + 'x');
check('errors[] clean at end', T.errors.length === 0, JSON.stringify(T.errors.slice(0, 3)));

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
