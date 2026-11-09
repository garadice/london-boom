/* Trace probe: first ~40 fall steps of a stone — x, y, vy, demand window math.
   Answers: does the ride-guard window see healthy descent right after spawn?
   Run: node tools/probe_fall_trace.js */
'use strict';
const fs = require('fs');
const path = require('path');
const REPO = require('path').join(__dirname, '..');

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
global.Matter = matterMod.exports;

const gameSrc = fs.readFileSync(path.join(REPO, 'game.js'), 'utf8');
const gameFn = new Function('window', 'document', 'navigator', 'performance', 'requestAnimationFrame', 'Matter', 'location', 'setTimeout', 'clearTimeout', gameSrc + '\nreturn { LB: window.LB, T: window.__TEST__ };');
const G = gameFn(windowObj, documentObj, windowObj.navigator, performance, windowObj.requestAnimationFrame, global.Matter, windowObj.location, setTimeout, clearTimeout);
windowObj.LB = G.LB;
const T = G.T;
const LB = G.LB;

const tapX = Number(process.argv[2] || 300);
T.reset();
for (let i = 0; i < 30; i++) T.step();
LB.weaponFired.stone = 0;
T.fire('stone', tapX, 700);
console.log('tap', tapX, '-> spawn x=' + T.stones()[0].x, 'y=' + T.stones()[0].y, 'state=' + T.stones()[0].state);

let prevX = null, prevY = null;
for (let i = 0; i < 46; i++) {
  const before = T.stones()[0];
  T.step();
  const s = T.stones()[0];
  if (!s) { console.log(i + ': GONE'); break; }
  const dx = prevX === null ? 0 : s.x - prevX;
  const dy = prevY === null ? 0 : s.y - prevY;
  console.log(
    'step ' + String(i).padStart(2) +
    ' x=' + String(s.x).padStart(6) + ' y=' + String(s.y).padStart(6) +
    ' vx=' + String(s.vx).padStart(6) +
    ' state=' + s.state +
    ' dx=' + dx.toFixed(1) + ' dy=' + dy.toFixed(1)
  );
  prevX = s.x; prevY = s.y;
  if (s.state !== 'fall') { console.log('SLAMMED at x=' + s.x + ' dist-from-tap=' + Math.abs(s.x - tapX)); break; }
}
/* pump silently to the real slam + exit, then report */
let slamX = null;
for (let i = 0; i < 600; i++) {
  T.step();
  const s = T.stones()[0];
  if (!s) break;
  if (slamX === null && s.state !== 'fall') { slamX = s.x; console.log('REAL SLAM x=' + s.x + ' dist-from-tap=' + Math.abs(s.x - tapX) + ' steps=' + i); break; }
}
