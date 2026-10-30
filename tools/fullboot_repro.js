/* Full-boot reproduction: run the REAL game.js in Node with DOM stubs.
   Deterministic V8 + identical code => browser collapse must reproduce here.
   Then bisect by toggling world pieces via env flags. */
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(REPO, 'game.js'), 'utf8');

// ---- minimal DOM stubs ----------------------------------------------------
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
    classList: { add: function () {}, remove: function () {}, toggle: function () {} },
    addEventListener: function () {}, getAttribute: function () { return null; },
    setAttribute: function () {}, appendChild: function () {},
    querySelectorAll: function () { return []; }, querySelector: function () { return null; }
  };
}
const els = {};
['game', 'hud', 'curWeapon', 'picker', 'pickerGrid', 'pickerClose', 'muteBtn', 'bellBtn', 'hint', 'title', 'win', 'playBtn', 'againBtn', 'keepBtn'].forEach(id => els[id] = makeEl(id));
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
    // sprites want a canvas; picker cards want element methods — give both
    const c = makeCanvas();
    c.textContent = ''; c.type = ''; c.className = '';
    c.setAttribute = function () {};
    c.appendChild = function () {};
    return c;
  },
  addEventListener: function () {}
};

// load vendored matter into this context
const matterSrc = fs.readFileSync(path.join(REPO, 'vendor', 'matter.min.js'), 'utf8');
const matterMod = { exports: {} };
(new Function('module', 'exports', matterSrc))(matterMod, matterMod.exports);
const Matter = matterMod.exports;
global.Matter = Matter;

// evaluate the real game.js with our stubs
const gameFn = new Function('window', 'document', 'navigator', 'performance', 'requestAnimationFrame', 'Matter', 'location', 'setTimeout', 'clearTimeout', src + '\nreturn window.LB;');
const LB = gameFn(windowObj, documentObj, windowObj.navigator, performance, windowObj.requestAnimationFrame, Matter, windowObj.location, setTimeout, clearTimeout);
windowObj.LB = LB;

const TEST = windowObj.__TEST__;
console.log('boot errors:', JSON.stringify(TEST.errors));
console.log('boot integrity:', JSON.stringify(TEST.landmarkIntegrity()));

// bisect flags via env: ROAD=0 EYE=0 CATS=0 rebuild variants by re-eval with patched src
function variant(name, patch) {
  let s = src;
  if (patch === 'noroad') s = s.replace('  addRoad();\n', '');
  if (patch === 'nocats') s = s.replace('landmarkFilter(M.Bodies.rectangle', 'M.Bodies.rectangle').replace(/const b = landmarkFilter\(([\s\S]*?)\)\);/g, 'const b = $1;');
  if (patch === 'noeye') s = s.replace('buildEye();\nwarmup(300);\nspawnVehicle();\nspawnVehicle();', 'warmup(300);');
  if (patch === 'nowarm') s = s.replace('warmup(300);\nspawnVehicle();', 'warmup(0);spawnVehicle();');
  const fn = new Function('window', 'document', 'navigator', 'performance', 'requestAnimationFrame', 'Matter', 'location', 'setTimeout', 'clearTimeout', s + '\nreturn window.LB;');
  try {
    fn(windowObj, documentObj, windowObj.navigator, performance, windowObj.requestAnimationFrame, Matter, windowObj.location, setTimeout, clearTimeout);
    const T = windowObj.__TEST__;
    const li = T.landmarkIntegrity();
    console.log(`variant ${name}: tower=${Math.round(li.tower * 1000) / 1000} top=${Math.round(li.towerTop * 1000) / 1000} errors=${T.errors.length}`);
  } catch (e) {
    console.log(`variant ${name}: THREW ${e.message}`);
  }
}

// note: variants re-eval into the same windowObj — __TEST__ gets replaced each time
variant('noroad', 'noroad');
variant('noeye', 'noeye');
variant('nowarm', 'nowarm');

// finer bisect: strip pieces inside the boot sequence
function variant2(name, transforms) {
  let s = src;
  for (const [from, to] of transforms) s = s.split(from).join(to);
  const fn = new Function('window', 'document', 'navigator', 'performance', 'requestAnimationFrame', 'Matter', 'location', 'setTimeout', 'clearTimeout', s + '\nreturn window.LB;');
  try {
    fn(windowObj, documentObj, windowObj.navigator, performance, windowObj.requestAnimationFrame, Matter, windowObj.location, setTimeout, clearTimeout);
    const T = windowObj.__TEST__;
    const li = T.landmarkIntegrity();
    const bc = T.bodyCounts();
    console.log(`variant2 ${name}: tower=${Math.round(li.tower * 1000) / 1000} top=${Math.round(li.towerTop * 1000) / 1000} towerN=${bc.tower} errors=${T.errors.length}`);
  } catch (e) {
    console.log(`variant2 ${name}: THREW ${e.message}`);
  }
}
const NO_ROAD = ['  addRoad();\n', ''];
const NO_EYE = ['buildEye();\nwarmup(300);\nspawnVehicle();\nspawnVehicle();', 'warmup(300);'];
const NO_CATS = ['const b = landmarkFilter(M.Bodies.rectangle(x, cy, BW - 0.35, sec.h, {\n          friction: 0.8, frictionStatic: 1.0, restitution: 0.01, density: 0.0012,\n          frictionAir: 0.02, sleepThreshold: 50\n        }));', 'const b = M.Bodies.rectangle(x, cy, BW - 0.35, sec.h, {\n          friction: 0.8, frictionStatic: 1.0, restitution: 0.01, density: 0.0012,\n          frictionAir: 0.02, sleepThreshold: 50\n        });'];
variant2('tower-only (road+eye stripped, cats kept)', [NO_ROAD, NO_EYE]);
variant2('tower-only NO cats', [NO_ROAD, NO_EYE, NO_CATS]);
variant2('full world NO cats', [NO_CATS]);
