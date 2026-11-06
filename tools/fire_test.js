/* Headless WILDFIRE harness (v4.2, t_c74cfc69).
   Boots the REAL game (matter + sky + weather + plane + quake + fire + game.js)
   in Node with DOM stubs, then drives the fire via __TEST__ hooks:

     - boot cleanliness (errors[])
     - weapon identity: tap → comet → bloom ignition (LB.weaponFired.fire)
     - CLIMB: time-to-spire on a clear day; char progression
     - tower ↔ annex joint spread; London Eye catch
     - FIREBRANDS: detach while burning, land, spawn new fires
     - cap: never more than MAX_BURNING concurrently
     - RAIN vs CLEAR: burning-count slopes (weather counterplay)
     - TSUNAMI / VORTEX: contact extinguish (steam, count drop)
     - VEHICLES: ignite → panic → explode → fireball ignites
     - FINALE: fire-only destruction still fires the win
     - FIRESTORM beat (forced) + auto-end
     - NEW GAME mid-fire safety
     - CPU: idle vs full-tower-burning per-step cost

   Run: node tools/fire_test.js
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
loadModule('fire.js');
global.LBSky = windowObj.LBSky;
global.LBWeather = windowObj.LBWeather;
global.LBPlane = windowObj.LBPlane;
global.LBQuake = windowObj.LBQuake;
global.LBFire = windowObj.LBFire;

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
let passes = 0;
function check(name, cond, detail) {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (detail !== undefined ? ' :: ' + detail : ''));
  if (cond) passes++; else failures++;
}
function run(seconds) { const n = Math.round(seconds * 60); for (let i = 0; i < n; i++) T.step(); }
function runUntil(secondsMax, fn) {
  const n = Math.round(secondsMax * 60);
  for (let i = 0; i < n; i++) {
    T.step();
    if (fn(i / 60)) return i / 60;
  }
  return -1;
}

console.log('boot errors:', JSON.stringify(T.errors));
check('boots with 0 errors', T.errors.length === 0, JSON.stringify(T.errors.slice(0, 3)));

// ---------- 1. title-phase guard ----------
const t0 = T.fire('fire', 400, 700);
check('fire is a no-op on the title screen', t0 === false);
LB.phase = 'play';

// ---------- 2. idle stability + idle CPU ----------
function timedSteps(n) {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) T.step();
  return Number(process.hrtime.bigint() - t0) / 1e6; // ms
}
timedSteps(120); // settle
const idleMs = timedSteps(600);
const idle = T.landmarkIntegrity();
check('idle world stays stable (tower > 0.98)', idle.tower > 0.98, 'tower=' + idle.tower.toFixed(4));
check('idle world stays stable (eye > 0.98)', idle.eye > 0.98, 'eye=' + idle.eye.toFixed(4));
check('idle errors stay clean', T.errors.length === 0, JSON.stringify(T.errors.slice(0, 3)));

// ---------- 3. weapon identity: tap → comet → bloom ----------
const fired0 = T.weaponFired.fire;
const fOK = T.fire('fire', 400, 700);
check('FIRE tap accepted (key F / picker slot unchanged)', fOK === true);
check('LB.weaponFired.fire increments', T.weaponFired.fire === fired0 + 1, String(T.weaponFired.fire));
let fInfo = T.fires();
check('a comet is in flight after the tap', fInfo.comets === 1, JSON.stringify(fInfo));
run(0.55); // comet flight ~0.5 s
fInfo = T.fires();
check('comet bloomed into real fire (burning > 0)', fInfo.burning + fInfo.ignited > 0, JSON.stringify(fInfo));
check('comet consumed after bloom (comets == 0)', fInfo.comets === 0, JSON.stringify(fInfo));
check('3-comet cap enforced', (function () {
  T.fires(); let ok = true;
  for (let i = 0; i < 5; i++) { if (T.fire('fire', 400 + i, 700) && T.fires().comets > 3) ok = false; }
  return ok;
})(), 'max comets=' + T.fires().comets);

// ---------- 4. THE CLIMB (clear weather, no traffic noise) ----------
T.reset(); LB.phase = 'play';
LB.traffic.spawnTimer = 1e9;                   // probe the fire mechanics, not bus roulette
run(3.5);                                      // boot vehicles drive offscreen
T.setWeather('clear'); run(1.0); // settle blend
const ig = T.fireIgnite(400, 775);
check('fireIgnite at tower base ignites blocks', ig.info.burning + ig.info.ignited > 0, JSON.stringify(ig.info));

let spireT = -1, annexT = -1, maxSeen = 0, capOK = true, charSeen = 0, brandSeen = false, naturalStormSeen = false;
const climbSamples = [];
let climbMinY = 1e9, climbTopMax = 0;
let lastPin = -99;
const climbT = runUntil(60, function (t) {
  if (t - lastPin >= 3.0) { lastPin = t; T.setWeather('clear'); }  // pin clear: weather auto-advances every 20-40 s
  const f = T.fires();
  const tot = f.burning + f.ignited + f.firebrands;
  if (tot > maxSeen) maxSeen = tot;
  if (tot > 110) capOK = false;
  if (f.firestorm) naturalStormSeen = true;
  const near = towerBurningNearOrigin(340);
  if (near > climbTopMax) climbTopMax = near;
  if (spireT < 0 && near > 0) { spireT = t; climbSamples.push({ t: Math.round(t * 10) / 10, burning: f.burning, note: 'SPIRE' }); }
  if (annexT < 0 && annexBurning() > 0) { annexT = t; climbSamples.push({ t: Math.round(t * 10) / 10, burning: f.burning, note: 'ANNEX' }); }
  for (const b of LB.bodies) { const lb = b.plugin.lb; if (lb && lb.fire && lb.fire.char > charSeen) charSeen = lb.fire.char; }
  if (t - Math.floor(t) < 1 / 60 && Math.abs(t - Math.round(t)) < 1 / 60 && Math.round(t) % 4 === 0) {
    let n = 0, minY = 1e9;
    for (const b of LB.bodies) { const lb = b.plugin.lb; if (lb && lb.fire && !lb.removed) { n++; if (b.position.y < minY) minY = b.position.y; } }
    climbMinY = Math.min(climbMinY, minY === 1e9 ? 1e9 : minY);
    climbSamples.push({ t: Math.round(t), burning: f.burning, firebrands: f.firebrands, minY: minY === 1e9 ? -1 : Math.round(minY) });
  }
  if (f.stats.brandLandings >= 2) brandSeen = true;
  return false;
});
function towerBurningNearOrigin(maxOy) {
  let n = 0;
  for (const b of LB.bodies) {
    const lb = b.plugin.lb;
    if (!lb || lb.set !== 'tower' || !lb.fire || lb.removed) continue;
    if (lb.oy <= maxOy && Math.abs(b.position.y - lb.oy) < 55 && Math.abs(b.position.x - lb.ox) < 55) n++;
  }
  return n;
}
function annexBurning() {
  let n = 0;
  for (const b of LB.bodies) {
    const lb = b.plugin.lb;
    if (!lb || lb.set !== 'annex' || !lb.fire || lb.removed) continue;
    n++;
  }
  return n;
}
console.log('climb samples:', JSON.stringify(climbSamples));
console.log('final fire info:', JSON.stringify(T.fires()));
check('fire CLIMBS to the spire', spireT > 0, 'time-to-spire=' + spireT.toFixed(1) + ' s (highest burning y=' + (climbMinY === 1e9 ? '-' : Math.round(climbMinY)) + ', max top-zone pieces=' + climbTopMax + ')');
check('fire spreads across the tower↔annex joint', annexT > 0, 'time-to-annex=' + annexT.toFixed(1) + ' s');
check('burning cap 110 never exceeded', capOK, 'peak concurrent=' + maxSeen);
check('natural firestorm triggered during the blaze (>= 80 burning)', naturalStormSeen, 'peak=' + maxSeen + ' stormSeen=' + naturalStormSeen);
check('blocks char progressively (char >= 0.5 observed)', charSeen >= 0.5, 'max char=' + charSeen.toFixed(2));
const fstat = T.fires().stats;
check('firebrands detach while burning (>= 1)', fstat.brandLandings >= 1 ? true : T.fires().firebrands >= 1 || T.fires().stats.brandLandings >= 1, JSON.stringify(fstat));
check('>= 2 firebrand landings', fstat.brandLandings >= 2, 'landings=' + fstat.brandLandings);
check('firebrand landings spawn new fires', fstat.brandLandingIgnites >= 2, 'ignites-from-landings=' + fstat.brandLandingIgnites);
check('climb-test errors stay clean', T.errors.length === 0, JSON.stringify(T.errors.slice(0, 3)));

// ---------- 5. rain fights fire: isolated-fuel decay probe ----------
// The London Eye is a finite fuel island (a constraint ring ~125 flammable
// parts, nothing flammable below it). A tip fire there shows the decay
// clearly: rain's extinguish chance + wet timers break the ring chain and
// the fire dies small and soon; in clear it burns through most of the wheel.
const lastPin2 = [-9];
function burnoutProbeImpl(weather) {
  T.reset(); LB.phase = 'play';
  LB.traffic.spawnTimer = 1e9;                 // deterministic: no traffic during the probe
  run(3.5);                                    // let the boot vehicles drive offscreen
  T.setWeather(weather); run(1.2);
  T.fireIgnite(1160, 655, 40);                // Eye rim, bottom arc
  const peak = [0];
  const outAt = runUntil(60, function (t) {
    if (t - lastPin2[0] >= 2.0) { lastPin2[0] = t; T.setWeather(weather); }   // pin the weather
    const f = T.fires();
    const tot = f.burning + f.ignited + f.firebrands;
    if (tot > peak[0]) peak[0] = tot;
    return tot === 0 && t > 1.5;
  });
  return { weather, peak: peak[0], outAt, ignitedTotal: T.fires().stats.ignited, extinguished: T.fires().extinguished };
}
const rainB = burnoutProbeImpl('rain');
const clearB = burnoutProbeImpl('clear');
console.log('burnout rain :', JSON.stringify(rainB));
console.log('burnout clear:', JSON.stringify(clearB));
const multSeen = (function () {
  T.setWeather('rain'); run(1.2);
  const m = T.fires().spreadMult;
  T.setWeather('clear'); run(1.2);
  return m;
})();
check('rain halves the spread multiplier', multSeen === 0.5, 'spreadMult under rain=' + multSeen);
const killSeen = (function () {
  T.setWeather('rain'); run(1.2);
  const k = T.fires().rainKillRate;
  T.setWeather('clear'); run(1.2);
  return k;
})();
check('rain actively extinguishes (kill rate > 0 under rain)', killSeen > 0, 'kill/s=' + killSeen);
check('rain kills the Eye fire; clear burns the wheel', rainB.outAt > 0 && (clearB.outAt < 0 || rainB.outAt < clearB.outAt * 0.9),
  'rain: died at ' + rainB.outAt.toFixed(1) + ' s, peak ' + rainB.peak + ', ignited ' + rainB.ignitedTotal + ' | clear: ' + (clearB.outAt < 0 ? 'still burning at 60 s' : 'died at ' + clearB.outAt.toFixed(1) + ' s') + ', peak ' + clearB.peak + ', ignited ' + clearB.ignitedTotal);
check('rain leaves most of the Eye unburned', rainB.ignitedTotal < clearB.ignitedTotal * 0.7,
  'rain ignited ' + rainB.ignitedTotal + ' vs clear ' + clearB.ignitedTotal);

// ---------- 6. tsunami douses fire ----------
T.reset(); LB.phase = 'play';
T.fireIgnite(400, 775); run(2.0);
const ts0 = T.fires();
const before = ts0.burning + ts0.ignited;
const ext0 = ts0.extinguished;
T.fire('tsunami', 100, 700);
let tsMin = before, sawWave = false;
runUntil(6, function (t) {
  const w = T.state();
  const f = T.fires();
  const cur = f.burning + f.ignited;
  if (cur < tsMin) tsMin = cur;
  return false;
});
const ts1 = T.fires();
console.log('tsunami: before=' + before + ' min=' + tsMin + ' after=' + (ts1.burning + ts1.ignited) + ' extinguished=' + (ts1.extinguished - ext0));
check('tsunami extinguishes burning blocks (steam + count drop)', (ts1.extinguished - ext0) >= 3, 'doused=' + (ts1.extinguished - ext0));

// ---------- 7. vortex douses fire ----------
T.reset(); LB.phase = 'play';
T.fireIgnite(1160, 640); run(1.5);          // Eye rim on fire
const vx0 = T.fires();
const vext0 = vx0.extinguished;
T.fire('vortex', 1160, 700);
run(3.0);
const vx1 = T.fires();
console.log('vortex: extinguished=' + (vx1.extinguished - vext0) + ' burning ' + (vx0.burning + vx0.ignited) + ' -> ' + (vx1.burning + vx1.ignited));
check('vortex extinguishes burning blocks on contact', (vx1.extinguished - vext0) >= 1, 'doused=' + (vx1.extinguished - vext0));

// ---------- 8. vehicles: ignite → panic → explode → fireball ----------
T.reset(); LB.phase = 'play';
const vehExpl0 = LB.events.vehiclesExploded;
T.fireIgnite(400, 775);
runUntil(25, function (t) { return T.fires().stats.vehicleFireballs >= 1; });
const vf = T.fires().stats;
console.log('vehicle stats:', JSON.stringify(vf), 'vehiclesExploded delta=' + (LB.events.vehiclesExploded - vehExpl0));
check('vehicle caught fire from the blaze', vf.vehiclesIgnited >= 1, 'ignited=' + vf.vehiclesIgnited);
check('burning vehicle exploded (panic → boom)', LB.events.vehiclesExploded > vehExpl0, 'delta=' + (LB.events.vehiclesExploded - vehExpl0));
check('vehicle fireball ignited surroundings', vf.vehicleFireballs >= 1, 'fireballs=' + vf.vehicleFireballs);

// ---------- 9. fire-only destruction fires the finale ----------
T.reset(); LB.phase = 'play';
const wf0 = JSON.parse(JSON.stringify(T.weaponFired));
T.fireIgnite(400, 775);       // tower base
T.fireIgnite(1160, 655);      // Eye rim, bottom arc
T.fireIgnite(1050, 420);      // Eye rim, left arc (two spots = two kid taps)
let finaleAt = -1;
let lastPin3 = -9;
runUntil(110, function (t) {
  if (t - lastPin3 >= 3.0) { lastPin3 = t; T.setWeather('clear'); }   // rain would fight the blaze
  if (LB.phase === 'finale') { finaleAt = t; return true; }
  return false;
});
const wf1 = T.weaponFired;
let otherWeaponsUsed = 0;
for (const k of Object.keys(wf1)) { if (k !== 'fire' && wf1[k] > wf0[k]) otherWeaponsUsed++; }
const finInt = T.landmarkIntegrity();
console.log('finale: at=' + finaleAt.toFixed(1) + ' s integrity=' + JSON.stringify(finInt) + ' otherWeaponsUsed=' + otherWeaponsUsed);
check('finale fired on fire-only destruction', finaleAt > 0, 't=' + (finaleAt < 0 ? 'never' : finaleAt.toFixed(1) + ' s'));
check('no other weapon was used in the finale run', otherWeaponsUsed === 0);

// ---------- 10. firestorm beat (forced) ----------
T.reset(); LB.phase = 'play';
T.fireIgnite(400, 775);
run(1.0);
runUntil(8, function (t) { return T.fires().firestorm === false; });  // let any natural storm finish
const preStorm = T.fires().firestorm;
check('no natural storm active before forcing', preStorm === false);
const fsNow = T.forceFirestorm();
check('forceFirestorm triggers the beat', fsNow.firestorm === true, JSON.stringify({ firestorm: fsNow.firestorm }));
let stormDur = runUntil(5, function (t) { return T.fires().firestorm === false; });
check('firestorm ends after ~3 s', stormDur > 2.4 && stormDur < 4.2, 'ran=' + stormDur.toFixed(2) + ' s');

// ---------- 11. NEW GAME mid-fire ----------
T.reset(); LB.phase = 'play';
T.fireIgnite(400, 775); run(2.0);
T.reset(); LB.phase = 'play'; run(1.0);
const afterReset = T.fires();
const rInt = T.landmarkIntegrity();
check('NEW GAME clears the fire cleanly', afterReset.burning === 0 && afterReset.ignited === 0 && afterReset.firebrands === 0 && afterReset.comets === 0, JSON.stringify(afterReset));
check('world stable after mid-fire reset', rInt.tower > 0.98 && rInt.eye > 0.98, JSON.stringify(rInt));
check('errors[] clean at the end', T.errors.length === 0, JSON.stringify(T.errors.slice(0, 5)));

// ---------- 12. CPU: idle vs fire (module share vs physics) ----------
// The fire module's own overhead is measured by wrapping LBFire.step; the
// rest of a burning step is Matter physics on the collapsing, awake pile —
// the same class of cost the quake gate measured for destroyAll chaos.
T.reset(); LB.phase = 'play';
const origFireStep = LBFire.step;
let fireUs = 0, fireCalls = 0;
LBFire.step = function (dt) {
  const t0 = process.hrtime.bigint();
  origFireStep.call(LBFire, dt);
  fireUs += Number(process.hrtime.bigint() - t0) / 1000;
  fireCalls++;
};
T.fireIgnite(400, 775);
run(2.5);
const earlyMs = timedSteps(300);
const earlyFire = T.fires();
const fireShare = (fireUs / Math.max(1, fireCalls)) / (earlyMs / 300 * 1000);
run(27.5);
const lateMs = timedSteps(300);
const lateFire = T.fires();
LBFire.step = origFireStep;
console.log('CPU: idle=' + (idleMs / 600 * 1000).toFixed(0) + ' us/step, early-fire=' + (earlyMs / 300 * 1000).toFixed(0) + ' us/step (burning=' + (earlyFire.burning + earlyFire.ignited) + ', LBFire=' + (fireUs / Math.max(1, fireCalls)).toFixed(0) + ' us = ' + (fireShare * 100).toFixed(0) + '%), rubble-fire=' + (lateMs / 300 * 1000).toFixed(0) + ' us/step (burning=' + (lateFire.burning + lateFire.ignited + lateFire.firebrands) + ')');
check('fire module overhead stays a minority of the step (< 25%)', fireShare < 0.25, 'LBFire share=' + (fireShare * 100).toFixed(0) + '% of burning step');

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures > 0 ? 1 : 0);
