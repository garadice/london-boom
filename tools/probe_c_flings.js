/* Standalone section-C probe: fire at a driving vehicle, measure fling/shake/tilt outcomes.
   Run: node tools/probe_c_flings.js N   (N runs, default 6) */
'use strict';
const fs = require('fs');
const path = require('path');
const REPO = require('path').join(__dirname, '..');

function ctxProxy() {
  return new Proxy({}, {
    get(t, prop) {
      if (prop === 'canvas') return {};
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return function () { return { addColorStop: function () {} }; };
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
  LB: undefined, innerWidth: 1600, innerHeight: 900, devicePixelRatio: 1,
  addEventListener: function () {}, AudioContext: undefined, webkitAudioContext: undefined,
  performance: performance,
  requestAnimationFrame: function (fn) { windowObj.__raf = fn; return 1; },
  location: { protocol: 'file:' }, navigator: {},
  setTimeout: setTimeout, clearTimeout: clearTimeout, console: console
};
const documentObj = {
  getElementById: function (id) { return els[id] || makeEl(id); },
  querySelectorAll: function () { return []; }, querySelector: function () { return null; },
  createElement: function (tag) {
    const c = makeCanvas(); c.textContent = ''; c.type = ''; c.className = '';
    c.setAttribute = function () {}; c.appendChild = function () {}; return c;
  },
  addEventListener: function () {}
};
function loadModule(file) {
  const src = fs.readFileSync(path.join(REPO, file), 'utf8');
  const fn = new Function('window', 'document', 'navigator', 'performance', src);
  fn(windowObj, documentObj, windowObj.navigator, performance);
}
loadModule('sky.js'); loadModule('weather.js'); loadModule('plane.js'); loadModule('quake.js'); loadModule('fire.js');
global.LBSky = windowObj.LBSky; global.LBWeather = windowObj.LBWeather; global.LBPlane = windowObj.LBPlane;
global.LBQuake = windowObj.LBQuake; global.LBFire = windowObj.LBFire;
const matterSrc = fs.readFileSync(path.join(REPO, 'vendor', 'matter.min.js'), 'utf8');
const matterMod = { exports: {} };
(new Function('module', 'exports', matterSrc))(matterMod, matterMod.exports);
global.Matter = matterMod.exports;
const gameSrc = fs.readFileSync(path.join(REPO, 'game.js'), 'utf8');
const gameFn = new Function('window', 'document', 'navigator', 'performance', 'requestAnimationFrame', 'Matter', 'location', 'setTimeout', 'clearTimeout', gameSrc + '\nreturn window.LB;');
const LB = gameFn(windowObj, documentObj, windowObj.navigator, performance, windowObj.requestAnimationFrame, global.Matter, windowObj.location, setTimeout, clearTimeout);
windowObj.LB = LB;
const T = windowObj.__TEST__;

const N = Number(process.argv[2] || 6);
let flingFails = 0, tiltFails = 0, shakeFails = 0;
for (let run = 0; run < N; run++) {
  T.reset();
  for (let i = 0; i < 30; i++) T.step();
  for (let i = 0; i < 900; i++) T.step();
  const vs = T.vehicles().list.filter(v => v.state === 'drive' && v.x >= 80 && v.x <= 300);
  const target = vs.length ? vs[0] : null;
  const tapX = target ? Math.max(60, target.x) : 200;
  const before = { flung: LB.events.vehiclesFlung, exploded: LB.events.vehiclesExploded };
  T.fire('stone', tapX, 700);
  let tiltMid = null, shakeAtSlam = 0, prevY = 1e9, slamX = null;
  for (let i = 0; i < 400; i++) {
    T.step();
    const list = T.stones();
    if (!list.length) break;
    const s = list[0];
    if (s.state === 'fall' && tiltMid === null && s.y >= 250) tiltMid = s.tilt;
    if (slamX === null && s.state !== 'fall') slamX = s.x;
    if (prevY < 700 && s.state === 'roll') { shakeAtSlam = T.state().shake; break; }
    prevY = s.y;
  }
  for (let i = 0; i < 60; i++) T.step();
  const flungDelta = LB.events.vehiclesFlung - before.flung;
  const tiltOK = tiltMid !== null && tiltMid >= 18 && tiltMid <= 38;
  const shakeOK = shakeAtSlam > 5;
  const flingOK = flungDelta >= 1;
  if (!tiltOK) tiltFails++;
  if (!shakeOK) shakeFails++;
  if (!flingOK) flingFails++;
  console.log('run ' + (run + 1) + ': tap=' + tapX + ' slamX=' + slamX + ' tiltMid=' + tiltMid + ' shake=' + shakeAtSlam + ' flung=+' + flungDelta +
    (tiltOK ? '' : '  << TILT-FAIL') + (shakeOK ? '' : '  << SHAKE-FAIL') + (flingOK ? '' : '  << FLING-FAIL'));
}
console.log('TOTALS: fling fails ' + flingFails + '/' + N + ', tilt fails ' + tiltFails + '/' + N + ', shake fails ' + shakeFails + '/' + N);
