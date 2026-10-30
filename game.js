/* ============================================================
   LONDON BOOM! 💥 — physics destruction toy for a 6-year-old.
   Elizabeth Tower + London Eye vs meteors, black holes, tornadoes.

   Zero build step. Zero runtime network. Matter.js is vendored.
   Custom Canvas2D renderer (no Matter.Render). Fixed timestep.
   ============================================================ */
'use strict';
(function () {

const M = Matter;
const LB = window.LB = {};

/* ---------------- config ---------------- */
const W = 1600, H = 900;          // world design size
const GROUND_Y = 790;             // physics ground top (bank = far traffic lane)
const WATER_Y = 832;              // water surface
const HORIZON_Y = 768;            // skyline base
const ROAD_NEAR_Y = 806;          // near-lane road surface (physics road body top)
const ROAD_BOTTOM = 830;          // road strip bottom edge (kerb; water starts at WATER_Y)
const VEHICLE_MAX = 3;            // hard cap: vehicles on screen at once
const TOWER_X = 400;
const EYE_X = 1160, EYE_Y = 420, EYE_R_OUT = 235, EYE_R_IN = 196;
const STEP = 1000 / 60;

LB.W = W; LB.H = H; LB.GROUND_Y = GROUND_Y; LB.WATER_Y = WATER_Y;

/* ---------------- utils ---------------- */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R = mulberry32(20261028);           // deterministic scene rng
function rand(a, b) { return a + Math.random() * (b - a); }
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function dist(ax, ay, bx, by) { const dx = bx - ax, dy = by - ay; return Math.sqrt(dx * dx + dy * dy); }
function hsl(h, s, l) { return 'hsl(' + (h | 0) + ',' + (s | 0) + '%,' + (l | 0) + '%)'; }
let __groupSeq = -2; // negative groups = "never collide with each other" sets
function BodyGroup() { return __groupSeq--; }

/* ---------------- sprite cache (pre-rendered glow blobs; no shadowBlur in hot paths) ---------------- */
const SPR = { glow: {}, smoke: null, scorch: null };
function makeGlow(rgb) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 1, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,0.95)');
  gr.addColorStop(0.22, 'rgba(' + rgb + ',0.9)');
  gr.addColorStop(0.55, 'rgba(' + rgb + ',0.34)');
  gr.addColorStop(1, 'rgba(' + rgb + ',0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return c;
}
function makeSoft(rgbInner, rgbOuter) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  gr.addColorStop(0, 'rgba(' + rgbInner + ',0.5)');
  gr.addColorStop(0.6, 'rgba(' + rgbOuter + ',0.22)');
  gr.addColorStop(1, 'rgba(' + rgbOuter + ',0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return c;
}
SPR.glow.gold = makeGlow('255,200,90');
SPR.glow.orange = makeGlow('255,130,50');
SPR.glow.red = makeGlow('255,80,70');
SPR.glow.purple = makeGlow('150,100,255');
SPR.glow.violet = makeGlow('120,90,255');
SPR.glow.cyan = makeGlow('100,220,255');
SPR.glow.white = makeGlow('255,255,255');
SPR.glow.green = makeGlow('120,255,150');
SPR.glow.pink = makeGlow('255,120,210');
SPR.glow.blue = makeGlow('110,150,255');
SPR.smoke = makeSoft('70,72,86', '40,42,56');
SPR.dust = makeSoft('120,110,140', '70,64,96');
SPR.scorch = makeSoft('12,10,14', '6,5,8');

/* ============================================================
   AUDIO — everything synthesized with WebAudio. No files, no CDN.
   ============================================================ */
LB.audio = {
  ctx: null, master: null, muted: false, noiseBuf: null, voices: 0, last: {},
  init() {
    if (this.ctx) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.9;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 2;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    } catch (e) { this.ctx = null; }
  },
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(function () {}); },
  ok() { return this.ctx && !this.muted && this.voices < 26; },
  okBell() { return this.ctx && !this.muted && this.voices < 90; },
  throttle(key, ms) {
    const n = performance.now();
    if (this.last[key] && n - this.last[key] < ms) return false;
    this.last[key] = n; return true;
  },
  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.9;
  },
  noise(dur, vol, filterType, f0, f1, q, force, delay) {
    if (!(force ? this.okBell() : this.ok())) return;
    const c = this.ctx, t = c.currentTime + (delay || 0);
    const src = c.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const fl = c.createBiquadFilter(); fl.type = filterType; fl.Q.value = q || 1;
    fl.frequency.setValueAtTime(f0, t);
    if (f1) fl.frequency.exponentialRampToValueAtTime(Math.max(f1, 20), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(fl); fl.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + dur + 0.05);
    this.voices++; src.onended = () => { this.voices--; };
  },
  tone(type, f0, f1, dur, vol, delay, force) {
    if (!(force ? this.okBell() : this.ok())) return;
    const c = this.ctx, t = c.currentTime + (delay || 0);
    const o = c.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1) o.frequency.exponentialRampToValueAtTime(Math.max(f1, 20), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + Math.min(0.03, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.05);
    this.voices++; o.onended = () => { this.voices--; };
  },
  boom(p) {
    p = p || 1;
    if (!this.throttle('boom', 70)) return;
    this.noise(0.75 * p + 0.15, 0.85 * p, 'lowpass', 900, 70, 0.7);
    this.tone('sine', 95, 30, 0.5 + 0.2 * p, 0.8 * p);
  },
  whoosh() { this.noise(0.6, 0.26, 'bandpass', 260, 1900, 1.4); },
  thunk() {
    if (!this.throttle('thunk', 60)) return;
    this.noise(0.12, 0.16, 'lowpass', 500, 150, 1);
  },
  snap() {
    if (!this.throttle('snap', 45)) return;
    this.noise(0.06, 0.14, 'bandpass', 3200, 2400, 2);
  },
  eerie() {
    if (!this.throttle('eerie', 200)) return;
    this.tone('sine', 540, 62, 2.6, 0.2);
    this.tone('sine', 548, 66, 2.6, 0.12);
    this.noise(2.2, 0.05, 'lowpass', 400, 90, 0.6);
  },
  consume() {
    if (!this.throttle('consume', 90)) return;
    this.tone('triangle', 900, 1700, 0.1, 0.1);
  },
  release() { this.boom(0.45); this.tone('sine', 60, 220, 0.4, 0.3); },
  splash() {
    if (!this.throttle('splash', 120)) return;
    this.noise(0.25, 0.13, 'bandpass', 950, 500, 1);
  },
  launch() {
    if (!this.throttle('launch', 60)) return;
    this.noise(0.4, 0.1, 'highpass', 1200, 2400, 1);
    this.tone('sine', 800, 1500, 0.35, 0.09);
  },
  burst() {
    if (!this.throttle('burst', 80)) return;
    this.noise(0.5, 0.4, 'lowpass', 1400, 200, 0.8);
    this.tone('sine', 140, 60, 0.3, 0.25);
    this.crackle(10 + (Math.random() * 8 | 0));
  },
  crackle(n) {
    for (let i = 0; i < n; i++) {
      const d = Math.random() * 0.55;
      setTimeout(() => this.noise(0.03, 0.05 + Math.random() * 0.06,
        'bandpass', 2200 + Math.random() * 2200, 1800, 3), d * 1000);
    }
  },
  /* ---- v3 arsenal sounds (all synthesized; every loop honours mute via master) ---- */
  boomDeep(p) {
    // round bombs: a fatter, lower boom than TNT
    p = p || 1;
    if (!this.throttle('boom', 70)) return;
    this.noise(0.9 * p + 0.2, 0.9 * p, 'lowpass', 520, 45, 0.7);
    this.tone('sine', 68, 22, 0.7 + 0.25 * p, 0.85 * p);
  },
  tripleBoom() {
    // TNT BEN: three staggered detonations, rising intensity
    const self = this;
    this.boomDeep(0.8);
    setTimeout(function () { self.boomDeep(1.05); }, 130);
    setTimeout(function () { self.boomDeep(1.3); self.crackle(14); }, 270);
  },
  novaCharge(dur) {
    // rising shimmer while the star gathers (one shot, ~3 s)
    const c = this.ctx;
    if (!c || this.muted) return;
    const t = c.currentTime;
    for (let i = 0; i < 2; i++) {
      const o = c.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(300 + i * 26, t);
      o.frequency.exponentialRampToValueAtTime(1500 + i * 90, t + dur);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12 - i * 0.04, t + dur * 0.75);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g); g.connect(this.master);
      o.start(t); o.stop(t + dur + 0.05);
      this.voices++; o.onended = () => { this.voices--; };
    }
    this.noise(dur, 0.05, 'highpass', 2000, 5200, 1);
  },
  novaBoom() {
    // BIG warm boom + sparkle crackle tail
    if (!this.throttle('novaBoom', 120)) return;
    this.noise(1.3, 0.95, 'lowpass', 1100, 55, 0.7);
    this.tone('sine', 120, 28, 0.9, 0.9);
    this.tone('triangle', 520, 90, 0.5, 0.22, 0.02);
    this.crackle(26);
  },
  sirenWail(dur) {
    // classic rising-falling siren, kept kid-soft
    const c = this.ctx;
    if (!c || this.muted) return;
    const t = c.currentTime;
    const o = c.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(420, t);
    o.frequency.linearRampToValueAtTime(880, t + dur * 0.32);
    o.frequency.linearRampToValueAtTime(430, t + dur * 0.64);
    o.frequency.linearRampToValueAtTime(760, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.15, t + 0.25);
    g.gain.setValueAtTime(0.15, t + dur - 0.2);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.05);
    this.voices++; o.onended = () => { this.voices--; };
  },
  nukeBoom() {
    // the big one: deep sub punch + huge boom + long low rumble decay (forced past the voice cap)
    if (!this.throttle('nukeBoom', 200)) return;
    this.noise(2.6, 1.0, 'lowpass', 700, 32, 0.6, true);
    this.tone('sine', 58, 16, 1.6, 1.0, 0, true);
    this.tone('sine', 40, 13, 2.6, 0.85, 0.04, true);          // deeper sub layer
    this.noise(3.4, 0.24, 'lowpass', 260, 60, 0.8, true, 0.35);
    this.noise(5.6, 0.28, 'lowpass', 190, 36, 0.7, true, 0.7); // long rumble decay ~5 s
    this.crackle(9);                                           // faint crackle as it roars
  },
  waterRush(dur) {
    // band-passed noise swell — the wall of water arriving
    const c = this.ctx;
    if (!c || this.muted) return;
    const t = c.currentTime;
    const src = c.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const fl = c.createBiquadFilter(); fl.type = 'bandpass'; fl.Q.value = 0.8;
    fl.frequency.setValueAtTime(320, t);
    fl.frequency.linearRampToValueAtTime(1350, t + dur * 0.5);
    fl.frequency.linearRampToValueAtTime(520, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.4, t + dur * 0.35);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    src.connect(fl); fl.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + dur + 0.05);
    this.voices++; src.onended = () => { this.voices--; };
  },
  laserHumStart(ent) {
    if (!this.ok() || ent.audio) return;
    try {
      const c = this.ctx;
      const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 92;
      const lfo = c.createOscillator(); lfo.frequency.value = 13;
      const lfoG = c.createGain(); lfoG.gain.value = 26;
      lfo.connect(lfoG); lfoG.connect(o.frequency);
      const fl = c.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = 2400;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.1, c.currentTime + 0.09);
      o.connect(fl); fl.connect(g); g.connect(this.master);
      o.start(); lfo.start();
      ent.audio = { src: o, lfo: lfo, g: g };
    } catch (e) { ent.audio = null; }
  },
  laserHumStop(ent) {
    if (!ent.audio || !this.ctx) return;
    try {
      const a = ent.audio, c = this.ctx;
      a.g.gain.cancelScheduledValues(c.currentTime);
      a.g.gain.setValueAtTime(Math.max(a.g.gain.value, 0.001), c.currentTime);
      a.g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.12);
      a.src.stop(c.currentTime + 0.16); a.lfo.stop(c.currentTime + 0.16);
    } catch (e) {}
    ent.audio = null;
  },
  sizzle() {
    if (!this.throttle('sizzle', 70)) return;
    this.noise(0.08, 0.12, 'bandpass', 3400, 2600, 2.5);
  },
  swirlStart(ent) {
    // swirling water: band-passed noise with a wobbly centre frequency
    if (!this.ok() || ent.audio) return;
    try {
      const c = this.ctx;
      const src = c.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
      const fl = c.createBiquadFilter(); fl.type = 'bandpass'; fl.frequency.value = 640; fl.Q.value = 2.2;
      const lfo = c.createOscillator(); lfo.frequency.value = 2.6;
      const lfoG = c.createGain(); lfoG.gain.value = 320;
      lfo.connect(lfoG); lfoG.connect(fl.frequency);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.22, c.currentTime + 0.5);
      src.connect(fl); fl.connect(g); g.connect(this.master);
      src.start(); lfo.start();
      ent.audio = { src: src, lfo: lfo, g: g };
    } catch (e) { ent.audio = null; }
  },
  swirlStop(ent) { this.rumbleStop(ent); },
  pop() { if (this.ok()) this.tone('sine', 480, 900, 0.09, 0.16); },
  click() { if (this.ok()) this.tone('triangle', 820, 1250, 0.06, 0.14); },

  rumbleStart(ent) {
    if (!this.ok() || ent.audio) return;
    try {
      const c = this.ctx;
      const src = c.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
      const fl = c.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = 170; fl.Q.value = 1.1;
      const lfo = c.createOscillator(); lfo.frequency.value = 0.7;
      const lfoG = c.createGain(); lfoG.gain.value = 60;
      lfo.connect(lfoG); lfoG.connect(fl.frequency);
      const g = c.createGain(); g.gain.setValueAtTime(0.0001, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.34, c.currentTime + 0.5);
      src.connect(fl); fl.connect(g); g.connect(this.master);
      src.start(); lfo.start();
      ent.audio = { src, lfo, g };
    } catch (e) { ent.audio = null; }
  },
  rumbleStop(ent) {
    if (!ent.audio || !this.ctx) return;
    try {
      const a = ent.audio, c = this.ctx;
      a.g.gain.cancelScheduledValues(c.currentTime);
      a.g.gain.setValueAtTime(a.g.gain.value, c.currentTime);
      a.g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.4);
      a.src.stop(c.currentTime + 0.5); a.lfo.stop(c.currentTime + 0.5);
    } catch (e) {}
    ent.audio = null;
  },
  fuseStart(ent) {
    if (!this.ok() || ent.audio) return;
    try {
      const c = this.ctx;
      const src = c.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
      const fl = c.createBiquadFilter(); fl.type = 'highpass'; fl.frequency.value = 3600; fl.Q.value = 0.7;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.09, c.currentTime + 0.08);
      src.connect(fl); fl.connect(g); g.connect(this.master);
      src.start();
      ent.audio = { src, g };
    } catch (e) { ent.audio = null; }
  },
  fuseStop(ent) {
    if (!ent.audio || !this.ctx) return;
    try {
      const a = ent.audio, c = this.ctx;
      a.g.gain.cancelScheduledValues(c.currentTime);
      a.g.gain.setValueAtTime(a.g.gain.value, c.currentTime);
      a.g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.06);
      a.src.stop(c.currentTime + 0.08);
    } catch (e) {}
    ent.audio = null;
  },
  fanfare() {
    const notes = [523, 659, 784, 1047];
    for (let i = 0; i < notes.length; i++) this.tone('triangle', notes[i], notes[i], 0.22, 0.2, i * 0.14);
    this.tone('triangle', 1319, 1319, 0.5, 0.18, notes.length * 0.14);
  },

  /* ---- Big Ben bells (F5) ----
     The real Great Bell: 13.5 t, nominal note E3, cracked in September 1859,
     rotated ~1/8 turn with a lighter hammer + a square cut out of the rim —
     it has sung with a slight twang ever since (parliament.uk; The Conversation).
     Synthesis: inharmonic bell partials (hum, prime, tierce, quint, nominal,
     upper modes), each with its own decay; broken variant detunes every
     partial and adds a crack-noise burst + a rattly low buzz. */
  bellTimers: [],
  bellSeq: { scheduled: 0, played: 0, strikes: 0, active: false },
  brokenPlayed: false,
  bellReset() {
    for (let i = 0; i < this.bellTimers.length; i++) clearTimeout(this.bellTimers[i]);
    this.bellTimers = [];
    this.bellSeq = { scheduled: 0, played: 0, strikes: 0, active: false };
  },
  bellStrike(f0, vol, dur, broken) {
    if (!this.okBell()) return;
    const c = this.ctx, t = c.currentTime;
    const ratios = [0.5, 1.0, 1.188, 1.53, 2.0, 2.514, 2.662, 3.011];
    const amps = [0.55, 1.0, 0.62, 0.38, 0.55, 0.22, 0.18, 0.13];
    const taus = [1.0, 0.62, 0.45, 0.4, 0.3, 0.22, 0.18, 0.13];
    for (let i = 0; i < ratios.length; i++) {
      let f = f0 * ratios[i];
      if (broken) f *= 1 + (Math.random() - 0.5) * 0.07; // crack detune
      const o = c.createOscillator(); o.type = 'sine';
      o.frequency.value = f;
      const g = c.createGain();
      const tau = Math.max(dur * taus[i] * (broken ? 0.55 : 1), 0.08);
      const a = vol * amps[i];
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(a, 0.0002), t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + tau);
      o.connect(g); g.connect(this.master);
      o.start(t); o.stop(t + tau + 0.05);
      this.voices++; o.onended = () => { this.voices--; };
    }
    this.noise(0.03, 0.3 * vol, 'bandpass', f0 * 8, f0 * 4, 2, true); // strike click
    if (broken) {
      this.noise(0.28, 0.22 * vol, 'bandpass', 3200, 700, 3, true);   // crack burst
      this.tone('triangle', f0 * 0.5, f0 * 0.42, 0.9, 0.12, 0, true); // rattle buzz
    }
  },
  bellNote(f0, vol, dur, atMs, broken, isStrike) {
    const self = this;
    const timer = setTimeout(function () {
      self.bellStrike(f0, vol, dur, broken);
      self.bellSeq.played++;
      if (isStrike) self.bellSeq.strikes++;
    }, atMs);
    this.bellTimers.push(timer);
  },
  /* Full 12:00 sequence: Westminster Quarters changes 2,3,4,5 (the real full-hour
     set; quarter bells G♯4/F♯4/E4/B3) then 12 strikes on the Great Bell (E3). */
  playTwelve() {
    if (this.bellSeq.active) return false;
    this.bellReset();
    const G_SHARP = 415.30, F_SHARP = 369.99, E4 = 329.63, B3 = 246.94, E3 = 164.81;
    const changes = [
      [G_SHARP, F_SHARP, E4, B3], // change 2
      [E4, F_SHARP, G_SHARP, E4], // change 3
      [G_SHARP, E4, F_SHARP, B3], // change 4
      [B3, F_SHARP, G_SHARP, E4]  // change 5
    ];
    const CROTCHET = 420, MINIM = 840, PAUSE = 320;
    let t = 250;
    for (let ch = 0; ch < changes.length; ch++) {
      const notes = changes[ch];
      for (let n = 0; n < notes.length; n++) {
        this.bellNote(notes[n], 0.3, 3.2, t, false, false);
        t += (n === 3 ? MINIM + PAUSE : CROTCHET);
      }
    }
    t += 1100; // the breath before Big Ben speaks
    for (let s = 0; s < 12; s++) {
      this.bellNote(E3, 0.5, 6.0, t, false, true);
      t += 1050;
    }
    this.bellSeq.scheduled = this.bellTimers.length;
    this.bellSeq.active = true;
    const self = this;
    this.bellTimers.push(setTimeout(function () { self.bellSeq.active = false; }, t + 400));
    return true;
  },
  brokenBell() {
    this.brokenPlayed = true;
    this.bellStrike(166.9, 0.5, 3.4, true); // the cracked bell: just sharp of E3, with a twang
    const self = this;
    this.bellTimers.push(setTimeout(function () { self.bellStrike(155.56, 0.38, 2.6, true); }, 420));
  }
};

/* ============================================================
   PARTICLES — pooled, typed, two render passes (normal + additive).
   ============================================================ */
const P = { cap: 3400, list: [], cursor: 0, active: 0 };
for (let i = 0; i < P.cap; i++) P.list.push({ on: false, type: 'spark', x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, size: 6, grow: 0, rot: 0, vr: 0, drag: 1, grav: 0, spr: null, col: '#888', seed: 0, hole: null, a: 1 });
LB.particles = P;

P.spawn = function (type, x, y, o) {
  const p = P.list[P.cursor]; P.cursor = (P.cursor + 1) % P.cap;
  p.on = true; p.type = type; p.x = x; p.y = y;
  p.vx = o.vx || 0; p.vy = o.vy || 0;
  p.max = p.life = o.life || 1;
  p.size = o.size || 6; p.grow = o.grow || 0;
  p.rot = o.rot || 0; p.vr = o.vr || 0;
  p.drag = o.drag === undefined ? 0.98 : o.drag;
  p.grav = o.grav || 0;
  p.spr = o.spr || null; p.col = o.col || '#999';
  p.seed = Math.random() * 100; p.hole = o.hole || null; p.a = o.a === undefined ? 1 : o.a;
  return p;
};

P.sparks = function (x, y, n, spr, speed) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, v = rand(0.5, speed || 7);
    P.spawn('spark', x, y, { vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rand(0.35, 1.0), size: rand(3, 8), drag: 0.94, grav: 0.07, spr });
  }
};
P.embers = function (x, y, n) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, v = rand(1, 9);
    P.spawn('ember', x, y, { vx: Math.cos(a) * v, vy: Math.sin(a) * v - 2, life: rand(1.0, 2.5), size: rand(4, 10), drag: 0.965, spr: Math.random() < 0.5 ? SPR.glow.orange : SPR.glow.gold });
  }
};
P.smoke = function (x, y, n, big) {
  for (let i = 0; i < n; i++) {
    P.spawn('smoke', x + rand(-14, 14), y + rand(-10, 6), { vx: rand(-1.2, 1.2), vy: rand(-1.6, -0.4), life: rand(2.2, 4.2), size: rand(18, 34) * (big ? 1.6 : 1), grow: rand(9, 20), drag: 0.985, a: rand(0.4, 0.65) });
  }
};
P.debrisBurst = function (x, y, col, n) {
  for (let i = 0; i < (n || 6); i++) {
    const a = Math.random() * Math.PI * 2, v = rand(1.5, 8);
    P.spawn('debris', x, y, { vx: Math.cos(a) * v, vy: Math.sin(a) * v - 2.5, life: rand(0.9, 1.9), size: rand(2.5, 6), grav: 0.14, drag: 0.995, vr: rand(-0.3, 0.3), col });
  }
};
P.sparkle = function (x, y, n) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, v = rand(0.6, 5);
    P.spawn('spark', x, y, { vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rand(0.3, 0.8), size: rand(2.5, 6), drag: 0.92, grav: 0.02, spr: Math.random() < 0.5 ? SPR.glow.purple : SPR.glow.white });
  }
};
P.flame = function (x, y, vx, vy) {
  P.spawn('flame', x, y, { vx, vy, life: rand(0.25, 0.55), size: rand(10, 22), drag: 0.94, spr: Math.random() < 0.6 ? SPR.glow.orange : SPR.glow.gold });
};
P.ring = function (x, y, speed, width, col) {
  P.spawn('ring', x, y, { life: 0.7, size: 8, grow: speed || 11, col: col || 'rgba(255,235,200,0.8)', a: 0.9 });
};
P.dustPuff = function (x, y, vx, vy, size, a) {
  P.spawn('dust', x, y, { vx, vy, life: rand(0.8, 1.6), size: size || rand(16, 30), drag: 0.96, spr: SPR.dust, a: a || 0.3 });
};
P.splash = function (x, y, n) {
  for (let i = 0; i < n; i++) {
    P.spawn('splash', x + rand(-8, 8), y, { vx: rand(-2.2, 2.2), vy: rand(-6.5, -2), life: rand(0.4, 0.9), size: rand(2.5, 5.5), grav: 0.16, drag: 0.99, spr: SPR.glow.cyan, a: 0.7 });
  }
};
P.crackleSpark = function (x, y, spr) {
  const a = Math.random() * Math.PI * 2, v = rand(0.4, 4);
  P.spawn('crackle', x, y, { vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rand(0.25, 0.7), size: rand(2, 5), drag: 0.9, grav: 0.03, spr });
};

P.update = function (dt) {
  let alive = 0;
  for (let i = 0; i < P.cap; i++) {
    const p = P.list[i]; if (!p.on) continue;
    p.life -= dt;
    if (p.life <= 0) { p.on = false; continue; }
    alive++;
    switch (p.type) {
      case 'ring':
        p.size += p.grow; p.grow *= 0.985;
        break;
      case 'dust':
        if (p.hole && p.hole.on) {
          const dx = p.hole.x - p.x, dy = p.hole.y - p.y;
          const d = Math.max(dist(0, 0, dx, dy), 20);
          p.vx += (dx / d) * 0.5 + (-dy / d) * 0.9;
          p.vy += (dy / d) * 0.5 + (dx / d) * 0.9;
          if (d < 40) p.life = Math.min(p.life, 0.2);
        }
        p.vx *= p.drag; p.vy *= p.drag;
        break;
      case 'ember':
        p.vx += Math.sin(p.seed + p.life * 9) * 0.05;
        p.vx *= p.drag; p.vy = p.vy * p.drag + p.grav * 0.4;
        break;
      case 'smoke':
        p.size += p.grow;
        p.vy -= 0.004;
        p.vx *= p.drag; p.vy *= p.drag;
        break;
      case 'debris':
        p.vy += p.grav; p.rot += p.vr;
        if (p.y > WATER_Y + 2) { p.on = false; }
        break;
      case 'flame':
        p.size *= 0.965;
        p.vx *= p.drag; p.vy = (p.vy - 0.06) * p.drag;
        break;
      case 'splash':
        p.vy += p.grav;
        if (p.vy > 0 && p.y > WATER_Y) p.on = false;
        break;
      case 'crackle':
        p.vx *= p.drag; p.vy = p.vy * p.drag + p.grav;
        break;
      default: // spark
        p.vx *= p.drag; p.vy = p.vy * p.drag + p.grav;
    }
    p.x += p.vx; p.y += p.vy;
  }
  P.active = alive;
};

P.render = function (ctx, pass) {
  for (let i = 0; i < P.cap; i++) {
    const p = P.list[i]; if (!p.on) continue;
    const k = p.life / p.max;
    if (pass === 'under') {
      if (p.type === 'smoke') {
        ctx.globalAlpha = p.a * k * 0.85;
        const s = p.size;
        ctx.drawImage(SPR.smoke, p.x - s / 2, p.y - s / 2, s, s);
      } else if (p.type === 'debris') {
        ctx.globalAlpha = Math.min(1, k * 2);
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.fillStyle = p.col;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.75);
        ctx.restore();
      }
    } else {
      if (p.type === 'ring') {
        ctx.globalAlpha = k * p.a;
        ctx.strokeStyle = p.col;
        ctx.lineWidth = 1 + 4 * k;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.stroke();
      } else if (p.type === 'spark' || p.type === 'ember' || p.type === 'flame' || p.type === 'splash' || p.type === 'crackle' || p.type === 'dust') {
        let a = k * p.a;
        if (p.type === 'crackle') a *= (Math.sin(p.seed * 37 + p.life * 55) > 0.2 ? 1 : 0.1);
        if (p.type === 'ember') a *= 0.7 + 0.3 * Math.sin(p.seed + p.life * 22);
        ctx.globalAlpha = Math.max(0, Math.min(1, a));
        const spr = p.spr || SPR.glow.gold;
        const s = p.type === 'flame' ? p.size : p.size * (0.5 + 0.5 * k);
        ctx.drawImage(spr, p.x - s, p.y - s, s * 2, s * 2);
      }
    }
  }
  ctx.globalAlpha = 1;
};
P.clear = function () { for (let i = 0; i < P.cap; i++) P.list[i].on = false; P.active = 0; };

/* ============================================================
   PHYSICS WORLD
   ============================================================ */
const engine = M.Engine.create({ enableSleeping: true });
engine.gravity.y = 0.6; // the sweet spot: stacks hold, debris still falls naturally
engine.positionIterations = 12;
engine.velocityIterations = 6;
engine.constraintIterations = 3;
const world = engine.world;
LB.engine = engine; LB.world = world;

LB.bodies = [];                 // refreshed each step
LB.constraints = [];            // landmark constraints (for cleanup + stress)
LB.meteors = [];
LB.holes = [];
LB.tornados = [];
LB.tnts = [];                    // lit TNT blocks (each on its own fuse; TNT BEN rides the same list)
LB.bombs = [];                   // v3: classic bombs (2 s auto-fuse)
LB.novas = [];                   // v3: charging stars (3 s)
LB.novaRings = [];               // v3: decorative expanding nova shockwaves
LB.nukes = [];                   // v3: the big one (siren, then the wipe)
LB.nukeWaves = [];               // v3.1: the expanding vaporization front after detonation
LB.mushrooms = [];               // v3: nuke cloud visuals (v3.1: multi-stage blob system)
LB.tsunamis = [];                // v3: walls of water from the left edge
LB.lasers = [];                  // v3: cutting beams
LB.stones = [];                  // v3: rolling boulders
LB.vortices = [];                // v3: water whirlpools
LB.fires = [];                   // v3: pyre crates -> spreading fire waves
LB.paused = false;               // weapon picker open = the whole sim holds its breath
LB.rockets = [];
LB.decals = [];                 // scorch marks
LB.time = 0;
LB.shake = 0;
LB.flash = 0;
LB.phase = 'title';             // title | play | finale
LB.weapon = 'meteor';
LB.weaponFired = { meteor: 0, blackhole: 0, tornado: 0, tnt: 0, bomb: 0, tnt_ben: 0, nova: 0, nuke: 0, tsunami: 0, laser: 0, stone: 0, vortex: 0, fire: 0 };
LB.events = { explosions: 0, consumed: 0, fireworks: 0, brokenConstraints: 0, shakes: 0, splashes: 0, destroyedAll: 0, resets: 0, tntPlaced: 0, tntExploded: 0, vehiclesExploded: 0, vehiclesFlung: 0, brokenBell: 0 };
LB.tower = { bodies: [], clockBodies: [], lanternBodies: [], topBodies: [], total: 0 };
LB.annex = { bodies: [], total: 0 };   // v3 wave 2: Westminster wing (NOT part of the win math)
LB.flag = null;                        // v3 wave 2: { body: mast pole } on the annex roof
LB.traffic = { vehicles: [], counts: { onScreen: 0, exploded: 0, flung: 0 }, spawnTimer: 1.2, nextId: 1 };
LB.continueMode = false;
LB.eye = { rim: [], rimIn: [], pods: [], hub: null, drive: true, spin: 0, led: 1 };

function tag(b, set, kind) {
  b.plugin.lb = { set: set, kind: kind || 'block', ox: b.position.x, oy: b.position.y, removed: false };
}
function aliveOf(set) {
  let n = 0;
  for (let i = 0; i < LB.bodies.length; i++) {
    const lb = LB.bodies[i].plugin.lb;
    if (lb && lb.set === set && !lb.removed) n++;
  }
  return n;
}
function integrityOf(set) {
  const total = set === 'tower' ? LB.tower.total : (set === 'annex' ? LB.annex.total : LB.eye.total);
  if (!total) return 1;
  let n = 0;
  for (let i = 0; i < LB.bodies.length; i++) {
    const b = LB.bodies[i], lb = b.plugin.lb;
    if (!lb || lb.set !== set || lb.removed) continue;
    if (set === 'tower' || set === 'annex') {
      // static landmark: rotation-invariant position check (rim orbits the hub)
      if (dist(b.position.x, b.position.y, lb.ox, lb.oy) < 55) n++;
    } else {
      // eye: a body counts as intact while it keeps its nominal radius from the hub
      if (b.isStatic || lb.kind === 'hub') { n++; continue; }
      const hub = LB.eye.hub ? LB.eye.hub.position : { x: EYE_X, y: EYE_Y };
      const r = dist(b.position.x, b.position.y, hub.x, hub.y);
      if (lb.kind === 'rim' && Math.abs(r - EYE_R_OUT) < 45) n++;
      else if (lb.kind === 'rimIn' && Math.abs(r - EYE_R_IN) < 45) n++;
      else if (lb.kind === 'pod' && r > EYE_R_IN && r < EYE_R_OUT + 80) n++;
      else if (lb.kind === 'found' || lb.kind === 'leg') n++;
    }
  }
  return n / total;
}
function removeBody(b, opts) {
  opts = opts || {};
  const lb = b.plugin.lb;
  if (lb) {
    if (lb.removed) return;
    lb.removed = true;
  }
  for (let i = LB.constraints.length - 1; i >= 0; i--) {
    const c = LB.constraints[i];
    if (c.bodyA === b || c.bodyB === b) {
      M.Composite.remove(world, c);
      LB.constraints.splice(i, 1);
      LB.events.brokenConstraints++;
    }
  }
  M.Composite.remove(world, b);
  if (!opts.silent && lb && lb.set !== 'meteor') {
    P.debrisBurst(b.position.x, b.position.y, lb.color || '#b9975a', opts.consume ? 5 : 6);
    if (opts.consume) P.sparkle(b.position.x, b.position.y, 8);
  }
}

function addGround() {
  const ground = M.Bodies.rectangle(800, 811, 2900, 42, {
    isStatic: true, friction: 0.95, frictionStatic: 1, restitution: 0,
    label: 'ground'
  });
  ground.plugin.lb = { set: 'ground', kind: 'ground', removed: false };
  M.Composite.add(world, ground);
  addRoad();
}

// landmark masonry never collides with driving vehicles (they pass on the road)
function landmarkFilter(b) {
  b.collisionFilter.category = CAT_LANDMARK;
  b.collisionFilter.mask = 0xFFFF & ~CAT_VEHICLE;
  return b;
}

/* ============================================================
   ELIZABETH TOWER (~450 blocks, stacked masonry, no glue)

   Modelled on the real tower (researched 2026-10-29: parliament.uk
   "Facts and figures", Wikipedia "Big Ben", vision analysis of a
   north-front photo): 96m tall on a 12m square base — very slender;
   sand-coloured Anston limestone. Bottom→top: rusticated plinth,
   plain shaft with paired lancet windows, ornate string course, the
   clock stage (dials ≈ 57% of tower width, opal glass in cast-iron
   frames), belfry with big louvred pointed arches, the Ayrton Light
   lantern, a tiered openwork iron crown, gilded finial.
   ============================================================ */
const TOWER_PLAN = [
  { kind: 'plinth',      rows: 4,  cols: 14, h: 14 }, // rusticated base
  { kind: 'plinthCap',   rows: 1,  cols: 14, h: 10 }, // step to the shaft
  { kind: 'shaft',       rows: 18, cols: 12, h: 13 }, // golden sandstone shaft
  { kind: 'string',      rows: 1,  cols: 12, h: 7 },  // ornate string course
  { kind: 'clockBand',   rows: 1,  cols: 12, h: 8 },  // blind arcading
  { kind: 'clock',       rows: 2,  cols: 12, h: 15 }, // clock stage; middle 4 cols = dial
  { kind: 'clockBand',   rows: 1,  cols: 12, h: 8 },  // hood-mould canopy
  { kind: 'cornice',     rows: 1,  cols: 12, h: 7 },  // cornice under the belfry
  { kind: 'louvre',      rows: 4,  cols: 10, h: 13 }, // belfry: louvred pointed arches
  { kind: 'cornice',     rows: 1,  cols: 10, h: 7 },  // belfry cornice
  { kind: 'lantern',     rows: 1,  cols: 8,  h: 10 }, // Ayrton Light
  { kind: 'lanternRoof', rows: 1,  cols: 6,  h: 9 },  // pyramidal lantern roof
  { kind: 'spire',       rows: 2,  cols: 6,  h: 9 },  // openwork iron crown, tier 1
  { kind: 'spire',       rows: 2,  cols: 6,  h: 9 },  // tier 2
  { kind: 'spire',       rows: 1,  cols: 6,  h: 9 },  // tier 3
  { kind: 'spire',       rows: 2,  cols: 4,  h: 10 }, // tier 4
  { kind: 'gold',        rows: 1,  cols: 2,  h: 11 }  // gilded finial
];
const TOP_KINDS = { clock: 1, clockFrame: 1, clockBand: 1, cornice: 1, louvre: 1, lantern: 1, lanternRoof: 1, spire: 1, gold: 1 };

function towerBlockColor(kind, rng) {
  switch (kind) {
    case 'plinth': return hsl(35, 15, 26 + rng() * 7);
    case 'plinthCap': return hsl(36, 19, 32 + rng() * 6);
    case 'shaft': return hsl(43, 40 + rng() * 12, 53 + rng() * 9);
    case 'shaftWin': return hsl(43, 40 + rng() * 12, 53 + rng() * 9);
    case 'string': return hsl(38, 26, 38 + rng() * 5);
    case 'clockBand': return hsl(42, 34, 46 + rng() * 5);
    case 'clock': return 'hsl(47,' + (44 + (rng() * 10 | 0)) + '%,' + (84 + (rng() * 6 | 0)) + '%)';
    case 'clockFrame': return hsl(44, 38, 50 + rng() * 6);
    case 'cornice': return hsl(36, 24, 34 + rng() * 5);
    case 'louvre': return hsl(222, 11, 17 + rng() * 5);
    case 'lantern': return hsl(31, 28, 36 + rng() * 6);
    case 'lanternRoof': return hsl(210, 12, 22 + rng() * 4);
    case 'spire': return hsl(205, 13, 25 + rng() * 5);
    case 'gold': return hsl(46, 74, 55 + rng() * 8);
  }
  return hsl(43, 45, 55);
}

function buildTower() {
  const rng = mulberry32(777);
  const bodies = LB.tower.bodies;
  LB.tower.clockBodies = [];
  LB.tower.lanternBodies = [];
  LB.tower.topBodies = [];

  // One shared 14-column grid; every course uses a centred SUBSET of it, so every
  // block stacks in perfect columns (no joint-straddling, no cantilevers) — the
  // solver keeps such stacks standing; anything else slowly buckles and pancakes.
  // Base width 154px / height ~525px stays inside the solver-proven envelope
  // (the old 296-block tower: 132px base, ~495px tall, same block contact width).
  const COLS = 14, BW = 11, X0 = TOWER_X - (COLS * BW) / 2;
  let topY = GROUND_Y;
  let shaftRow = 0;

  for (let s = 0; s < TOWER_PLAN.length; s++) {
    const sec = TOWER_PLAN[s];
    const start = Math.floor((COLS - sec.cols) / 2);
    for (let r = 0; r < sec.rows; r++) {
      const cy = topY - sec.h / 2;
      for (let c = start; c < start + sec.cols; c++) {
        const x = X0 + (c + 0.5) * BW;
        let kind = sec.kind;
        if (kind === 'clock' && (c < 5 || c > 8)) kind = 'clockFrame';
        if (kind === 'shaft' && shaftRow % 3 === 1 && c >= 5 && c <= 8) kind = 'shaftWin';
        const b = landmarkFilter(M.Bodies.rectangle(x, cy, BW - 0.35, sec.h, {
          friction: 0.8, frictionStatic: 1.0, restitution: 0.01, density: 0.0012,
          frictionAir: 0.02, sleepThreshold: 50
        }));
        tag(b, 'tower', kind);
        b.plugin.lb.color = towerBlockColor(kind, rng);
        b.plugin.lb.w = BW - 0.35;
        b.plugin.lb.h = sec.h;
        if (kind === 'clock') LB.tower.clockBodies.push(b);
        else if (kind === 'lantern') LB.tower.lanternBodies.push(b);
        if (TOP_KINDS[kind]) LB.tower.topBodies.push(b);
        M.Composite.add(world, b);
        bodies.push(b);
      }
      topY -= sec.h;
      if (sec.kind === 'shaft') shaftRow++;
    }
  }

  LB.tower.total = bodies.length;
}

/* ============================================================
   WESTMINSTER ANNEX (v3 wave 2) — the Palace of Westminster side
   wing to the RIGHT of Elizabeth Tower (Martin's idea: the real
   Speaker's/Gardener's wing hugging the tower). Adapted from the
   old game's _build_palace_annex rhythm: golden limestone in three
   shade bands (darkest at the base), pilaster bays, tall lancet
   windows under stone lintels, thin string courses, dark parapet
   roof — and a breakable-glue bond to the tower wall so the two
   buildings topple together.

   Same solver discipline as buildTower(): one perfect column grid,
   flush stacking, zero cantilevers (every window void is spanned
   by a full-width lintel block that bears one column on each side).

   Win math is UNTOUCHED: these blocks carry set 'annex' (not
   'tower'/'eye'), so wrecking the wing alone can never end the
   game — but every weapon hurts it through the existing paths.
   ============================================================ */
const ANNEX_COLS = 15, ANNEX_BW = 16;
// flush against the tower's right wall: tower blocks are BW(11) - 0.35 wide,
// rightmost edge lands at TOWER_X + 77 - 0.175
const ANNEX_X0 = TOWER_X + 76.825;
const ANNEX_PLAN = [              // listed top -> bottom, built bottom-up
  { kind: 'annexRoof',    rows: 1, h: 16 },                      // dark parapet band
  { kind: 'annexTop',     rows: 3, h: 16, winRows: { 1: 1 } },   // upper windows (drawn)
  { kind: 'annexString',  rows: 1, h: 9  },                      // string course
  { kind: 'annexMid',     rows: 4, h: 16, winRows: { 1: 1, 2: 1 } }, // window band 2
  { kind: 'annexString',  rows: 1, h: 9  },
  { kind: 'annexMid',     rows: 5, h: 16, winRows: { 1: 1, 2: 1 } }, // window band 1
  { kind: 'annexString',  rows: 1, h: 9  },
  { kind: 'annexBase',    rows: 2, h: 16, doorRow: 1 }          // rusticated base + doorway
];
// 2 window columns per bay (lancets are PAINTED on the blocks — the wall stays
// one solid solver-proven stack, exactly how buildTower does its own windows;
// measured in Matter 0.20: real 2-col voids destabilise the stack even under
// stone lintels, a solid 15x18 wall settles < 8px in 300 warmup steps)
const ANNEX_WIN_COLS = { 2: 1, 3: 1, 7: 1, 8: 1, 11: 1, 12: 1 };
const ANNEX_PILASTERS = { 0: 1, 1: 1, 4: 1, 10: 1, 13: 1, 14: 1 }; // quoins + bay pilasters

function annexBlockColor(kind, rng, darker) {
  switch (kind) {
    case 'annexBase':    return hsl(35, 22, (darker ? 37 : 44) + rng() * 7);
    case 'annexMid':     return hsl(36, 24, (darker ? 43 : 50) + rng() * 7);
    case 'annexTop':     return hsl(38, 26, (darker ? 49 : 56) + rng() * 7);
    case 'annexString':  return hsl(35, 20, 36 + rng() * 5);
    case 'annexRoof':    return hsl(28, 25, 27 + rng() * 5);
  }
  return hsl(36, 24, 50);
}

function buildAnnex() {
  const rng = mulberry32(4242);            // seeded like buildTower -> PLAY AGAIN restores exactly
  const bodies = LB.annex.bodies;
  LB.annex.total = 0;

  for (let s = 0; s < ANNEX_PLAN.length; s++) {
    const sec = ANNEX_PLAN[ANNEX_PLAN.length - 1 - s]; // bottom-up walk
    for (let r = 0; r < sec.rows; r++) {
      // rows flow bottom-up: this section row index from the bottom
      const secRow = r;
      const cy = topAnnexRowY(sec, secRow);
      for (let c = 0; c < ANNEX_COLS; c++) {
        let kind = sec.kind;
        if (sec.winRows && sec.winRows[secRow] && ANNEX_WIN_COLS[c]) kind = 'annexWin';
        if (sec.doorRow === secRow && (c === 7 || c === 8)) kind = 'annexDoor';
        const x = ANNEX_X0 + (c + 0.5) * ANNEX_BW;
        const b = landmarkFilter(M.Bodies.rectangle(x, cy, ANNEX_BW - 0.35, sec.h, {
          friction: 0.8, frictionStatic: 1.0, restitution: 0.01, density: 0.0012,
          frictionAir: 0.02, sleepThreshold: 50
        }));
        tag(b, 'annex', kind);
        b.plugin.lb.color = annexBlockColor(sec.kind, rng, !!ANNEX_PILASTERS[c]);
        b.plugin.lb.w = ANNEX_BW - 0.35;
        b.plugin.lb.h = sec.h;
        M.Composite.add(world, b);
        bodies.push(b);
      }
    }
  }

  // NOTE: no glue constraints. Measured in Matter 0.20: both stacks settle a few
  // px under gravity, and stiff struts turn that differential settling into
  // large forces that wreck the bond AND the tower wall. The card allows plain
  // flush abutment — the coupling is emergent instead: a tower-side blast that
  // eats the lower right wall drops the tower mass onto/into the wing, and any
  // annex-side blast shoves the shared wall directly (radialBlast hits both).
  LB.annex.total = bodies.length;
  buildFlag();

  // helpers (hoisted per call — keep the row math next to the loop)
  function topAnnexRowY(sec, secRow) {
    // section rows stack flush; secRow counted from the section's bottom edge
    let bottom = GROUND_Y;
    for (let i = ANNEX_PLAN.length - 1; ANNEX_PLAN[i] !== sec; i--) {
      bottom -= ANNEX_PLAN[i].rows * ANNEX_PLAN[i].h;
    }
    bottom -= secRow * sec.h;
    return bottom - sec.h / 2;
  }
}

/* ---------------- UNION FLAG 🇬🇧 on the annex roof ----------------
   The mast is one real physics body welded (2 pins) to the roof block
   under it: destroy that block (or blast nearby — blasts sever pins)
   and the mast topples with the flag flapping faster as it falls. */
function buildFlag() {
  const mx = ANNEX_X0 + 7.5 * ANNEX_BW;    // centre-ish column of the roof
  let roof = null;
  for (let i = 0; i < LB.annex.bodies.length; i++) {
    const b = LB.annex.bodies[i];
    if (b.plugin.lb.kind !== 'annexRoof') continue;
    if (!roof || Math.abs(b.position.x - mx) < Math.abs(roof.position.x - mx)) roof = b;
  }
  if (!roof) return;
  const roofTop = roof.position.y - roof.plugin.lb.h / 2;
  const POLE_H = 66;
  const pole = landmarkFilter(M.Bodies.rectangle(roof.position.x, roofTop - POLE_H / 2, 3.4, POLE_H, {
    friction: 0.8, frictionStatic: 1.0, restitution: 0.01, density: 0.0009,
    frictionAir: 0.02, sleepThreshold: Infinity   // never sleeps: when the roof under it
  }));                                            // dies it must fall, not sleep mid-air
  tag(pole, 'annex', 'mast');
  pole.plugin.lb.color = '#2a2f3f';
  pole.plugin.lb.w = 3.4;
  pole.plugin.lb.h = POLE_H;
  M.Composite.add(world, pole);
  LB.annex.bodies.push(pole);
  // No constraints: a stiff weld fights the roof block's settling (same failure
  // the wall glue had). The pole stands free on the parapet — friction holds it
  // while the world is calm; destroying the roof under it (or any blast shove)
  // topples it, and it tumbles with the cloth flapping faster once fallen.
  LB.annex.total = LB.annex.bodies.length;
  LB.flag = { body: pole };
}

// exact Union Jack (Flag Institute construction, 2:1): white saltire 1/5 of the
// height, red counterchanged diagonals offset via the four centre-quarter clips,
// white cross 1/3, red cross 1/5 — prerendered once, waved per-frame in slices.
function makeUnionJackCanvas() {
  const c = document.createElement('canvas');
  c.width = 48; c.height = 24;
  const g = c.getContext('2d');
  const fw = 48, fh = 24, cx2 = fw / 2, cy2 = fh / 2;
  g.fillStyle = '#012169';
  g.fillRect(0, 0, fw, fh);
  g.strokeStyle = '#ffffff';
  g.lineWidth = fh / 5;
  g.beginPath(); g.moveTo(0, 0); g.lineTo(fw, fh); g.moveTo(fw, 0); g.lineTo(0, fh); g.stroke();
  g.save();
  g.beginPath();
  g.moveTo(cx2, cy2); g.lineTo(fw, cy2); g.lineTo(fw, fh); g.closePath();
  g.moveTo(cx2, cy2); g.lineTo(cx2, fh); g.lineTo(0, fh); g.closePath();
  g.moveTo(cx2, cy2); g.lineTo(0, cy2); g.lineTo(0, 0); g.closePath();
  g.moveTo(cx2, cy2); g.lineTo(cx2, 0); g.lineTo(fw, 0); g.closePath();
  g.clip();
  g.strokeStyle = '#C8102E';
  g.lineWidth = fh * 0.12;
  g.beginPath(); g.moveTo(0, 0); g.lineTo(fw, fh); g.moveTo(fw, 0); g.lineTo(0, fh); g.stroke();
  g.restore();
  g.strokeStyle = '#ffffff';
  g.lineWidth = fh / 3;
  g.beginPath(); g.moveTo(cx2, 0); g.lineTo(cx2, fh); g.moveTo(0, cy2); g.lineTo(fw, cy2); g.stroke();
  g.strokeStyle = '#C8102E';
  g.lineWidth = fh / 5;
  g.beginPath(); g.moveTo(cx2, 0); g.lineTo(cx2, fh); g.moveTo(0, cy2); g.lineTo(fw, cy2); g.stroke();
  return c;
}

function drawFlag(t) {
  const F = LB.flag;
  if (!F || !F.body) return;
  const b = F.body;
  if (b.plugin.lb.removed) return;
  if (!LB.flagCanvas) LB.flagCanvas = makeUnionJackCanvas();
  const POLE_H = b.plugin.lb.h;
  const fallen = Math.abs(b.angle) > 0.5;
  const sway = fallen ? 0 : Math.sin(t * 1.4) * 0.012;
  const ang = b.angle + sway;
  const topX = b.position.x + Math.sin(ang) * POLE_H / 2;
  const topY = b.position.y - Math.cos(ang) * POLE_H / 2;
  // pole + gold finial
  ctx.save();
  ctx.translate(b.position.x, b.position.y);
  ctx.rotate(ang);
  ctx.fillStyle = '#2a2f3f';
  ctx.fillRect(-1.7, -POLE_H / 2, 3.4, POLE_H);
  ctx.fillStyle = '#ffd76b';
  ctx.beginPath(); ctx.arc(0, -POLE_H / 2 - 3, 3.2, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  // cloth: vertical slices of the prerendered jack, sin-rippled (faster when fallen)
  const FH = 24, FW = 48;
  const speed = fallen ? 9 : 4.2;
  ctx.save();
  ctx.translate(topX, topY + 2);
  ctx.rotate(ang * 0.6);
  for (let sx = 0; sx < FW; sx += 3) {
    const k = sx / FW;
    const wob = Math.sin(t * speed + sx * 0.55) * 0.5 + Math.sin(t * speed * 1.47 + sx * 1.3) * 0.5;
    const dy = wob * 2.6 * (0.15 + 0.85 * k);
    const sq = 1 + wob * 0.06 * k;
    ctx.drawImage(LB.flagCanvas, sx, 0, 3, FH, sx + 1, dy + FH / 2 - (FH * sq) / 2, 3.4, FH * sq);
  }
  ctx.restore();
}

/* ============================================================
   LONDON EYE (~155 bodies: 60 outer rim + 36 inner + 32 pods + hub + statics)
   ============================================================ */
function pin(A, B, ax, ay, bx, by, stiff, len) {
  const c = M.Constraint.create({
    bodyA: A, pointA: { x: ax, y: ay },
    bodyB: B, pointB: { x: bx, y: by },
    stiffness: stiff, damping: 0.1, length: len || 0
  });
  M.Composite.add(world, c);
  LB.constraints.push(c);
  return c;
}

function buildEye() {
  const E = LB.eye;
  E.rim = []; E.rimIn = []; E.pods = []; E.drive = true; E.spin = 0; E.led = 1;

  // Wheel parts + support statics share a negative collision group: they never
  // collide with each other. Physically the legs must reach the hub "through"
  // the wheel plane (real Eye: A-frame is beside the wheel) — without this the
  // static legs jam the rotating rim solid. Everything else (meteor, tower
  // blocks, debris) still collides with the wheel normally.
  const EYE_GROUP = BodyGroup();
  const wheelFilter = { collisionFilter: { group: EYE_GROUP, category: CAT_LANDMARK, mask: 0xFFFF & ~CAT_VEHICLE } };

  // hub (static bearing)
  const hub = M.Bodies.circle(EYE_X, EYE_Y, 16, Object.assign({ isStatic: true, label: 'hub' }, wheelFilter));
  tag(hub, 'eye', 'hub'); hub.plugin.lb.color = '#2a3152';
  E.hub = hub;
  M.Composite.add(world, hub);

  const rimOpts = Object.assign({ friction: 0.4, frictionStatic: 0.6, restitution: 0.1, density: 0.002, frictionAir: 0.002, sleepThreshold: 80 }, wheelFilter);

  // outer rim: 60 trapezoid segments pinned at both edges
  const N = 60, RL = (2 * Math.PI * EYE_R_OUT) / N - 0.4;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const x = EYE_X + Math.cos(a) * EYE_R_OUT, y = EYE_Y + Math.sin(a) * EYE_R_OUT;
    const b = M.Bodies.trapezoid(x, y, RL, 9, 0.3, Object.assign({ angle: a + Math.PI / 2 }, rimOpts));
    tag(b, 'eye', 'rim'); b.plugin.lb.color = '#4a5570';
    E.rim.push(b); M.Composite.add(world, b);
  }
  for (let i = 0; i < N; i++) {
    const A = E.rim[i], B = E.rim[(i + 1) % N];
    pin(A, B, RL / 2 - 1, -4.5, -RL / 2 + 1, -4.5, 0.92);
    pin(A, B, RL / 2 - 1, 4.5, -RL / 2 + 1, 4.5, 0.92);
  }

  // inner rim: 36 segments
  const N2 = 36, RL2 = (2 * Math.PI * EYE_R_IN) / N2 - 0.4;
  for (let i = 0; i < N2; i++) {
    const a = (i / N2) * Math.PI * 2;
    const x = EYE_X + Math.cos(a) * EYE_R_IN, y = EYE_Y + Math.sin(a) * EYE_R_IN;
    const b = M.Bodies.trapezoid(x, y, RL2, 7, 0.25, Object.assign({ angle: a + Math.PI / 2 }, rimOpts));
    tag(b, 'eye', 'rimIn'); b.plugin.lb.color = '#3a4360';
    E.rimIn.push(b); M.Composite.add(world, b);
  }
  for (let i = 0; i < N2; i++) {
    const A = E.rimIn[i], B = E.rimIn[(i + 1) % N2];
    pin(A, B, RL2 / 2 - 1, -3.5, -RL2 / 2 + 1, -3.5, 0.85);
    pin(A, B, RL2 / 2 - 1, 3.5, -RL2 / 2 + 1, 3.5, 0.85);
  }

  // spokes: 14 radial "ropes" hub -> outer rim segment centres
  for (let i = 0; i < 14; i++) {
    const idx = Math.round((i * N) / 14) % N;
    pin(hub, E.rim[idx], 0, 0, 0, 0, 0.95, EYE_R_OUT);
  }
  // webs: outer rim inner edge -> inner rim outer edge (radial links)
  for (let k = 0; k < 12; k++) {
    const oi = Math.round(k * 5) % N, ii = Math.round(k * 3) % N2;
    pin(E.rim[oi], E.rimIn[ii], 0, 4.5, 0, -3.5, 0.8, EYE_R_OUT - EYE_R_IN - 4.5 - 3.5);
  }

  // 32 pods hanging from the rim
  for (let i = 0; i < 32; i++) {
    const segIdx = Math.floor((i * N) / 32);
    const seg = E.rim[segIdx];
    const a = ((segIdx + 0.5) / N) * Math.PI * 2;
    const ax = EYE_X + Math.cos(a) * (EYE_R_OUT + 6.5);
    const ay = EYE_Y + Math.sin(a) * (EYE_R_OUT + 6.5);
    const pod = M.Bodies.rectangle(ax, ay + 14, 13, 20, Object.assign({
      chamfer: { radius: 5 }, friction: 0.3, density: 0.0009, frictionAir: 0.03,
      restitution: 0.2, sleepThreshold: 80
    }, wheelFilter));
    tag(pod, 'eye', 'pod'); pod.plugin.lb.color = '#16203a';
    E.pods.push(pod); M.Composite.add(world, pod);
    pin(seg, pod, 0, -6.5, 0, -11, 0.92, 3);
  }

  // static A-frame legs + back-stays + pier + platform
  function staticBar(x1, y1, x2, y2, w, kind) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy), ang = Math.atan2(dy, dx);
    const b = M.Bodies.rectangle((x1 + x2) / 2, (y1 + y2) / 2, len, w, Object.assign({ isStatic: true, angle: ang, label: 'eyeLeg' }, wheelFilter));
    tag(b, 'eye', kind || 'leg'); b.plugin.lb.color = '#2b3350';
    M.Composite.add(world, b);
    return b;
  }
  staticBar(EYE_X - 148, 778, EYE_X - 6, EYE_Y + 14, 13);
  staticBar(EYE_X + 108, 778, EYE_X + 8, EYE_Y + 12, 13);
  staticBar(EYE_X - 6, EYE_Y + 14, EYE_X - 148, 778, 9); // visual twin (front leg pair)
  staticBar(EYE_X + 8, EYE_Y + 12, EYE_X + 108, 778, 9);
  staticBar(EYE_X - 4, EYE_Y + 18, EYE_X - 190, 782, 8); // back-stays lean left
  staticBar(EYE_X + 6, EYE_Y + 18, EYE_X + 205, 782, 8);

  // pier foundations: two stacks of static masonry
  const fr = mulberry32(4242);
  [[EYE_X - 148, EYE_X - 190], [EYE_X + 108, EYE_X + 205]].forEach(function (pair) {
    pair.forEach(function (bx) {
      for (let r2 = 0; r2 < 4; r2++) {
        const b = M.Bodies.rectangle(bx + (fr() - 0.5) * 4, 783 - r2 * 12, 22, 12, Object.assign({ isStatic: true, label: 'pier' }, wheelFilter));
        tag(b, 'eye', 'found');
        b.plugin.lb.color = hsl(38, 26, 30 + fr() * 8);
        M.Composite.add(world, b);
      }
    });
  });
  // boarding platform
  for (let i = 0; i < 6; i++) {
    const b = M.Bodies.rectangle(EYE_X - 60 + i * 24, 784, 24, 11, Object.assign({ isStatic: true, label: 'plat' }, wheelFilter));
    tag(b, 'eye', 'found'); b.plugin.lb.color = '#232a48';
    M.Composite.add(world, b);
  }

  LB.eye.total = 60 + 36 + 32 + 1 + 6 + 16 + 6;
}

/* ============================================================
   ROAD + TRAFFIC (F2) — the Embankment road at the river's edge.
   Far lane rests on the bank top (GROUND_Y), near lane on a road
   body (ROAD_NEAR_Y). Vehicles are real physics bodies driving
   kinematically (pose + velocity pinned each step) until a weapon
   hits them: METEOR/TNT blast → instant explosion; TORNADO/BLACK
   HOLE → flung as a free body, explodes on hard landing.
   ============================================================ */
function addRoad() {
  const road = M.Bodies.rectangle(800, ROAD_NEAR_Y + 12, 2900, 24, {
    isStatic: true, friction: 0.95, frictionStatic: 1, restitution: 0,
    label: 'road'
  });
  road.plugin.lb = { set: 'ground', kind: 'road', removed: false };
  M.Composite.add(world, road);
}

// collision categories: 1 = default (debris/weapons), 2 = landmarks, 4 = driving vehicles
const CAT_DEFAULT = 0x0001, CAT_LANDMARK = 0x0002, CAT_VEHICLE = 0x0004;

const VEHICLE_DEFS = {
  car: { w: 46, h: 17, speed: [2.1, 3.0] },
  cab: { w: 48, h: 20, speed: [2.3, 2.9] },
  bus: { w: 80, h: 29, speed: [1.7, 2.1] }
};
const CAR_COLORS = ['#c8433c', '#3f7fc4', '#3fae8c', '#d8a53a', '#d8dce4', '#7c56c9', '#e8ecf2', '#5b8f3f'];

function laneSurfaceY(lane) { return lane === 0 ? GROUND_Y : ROAD_NEAR_Y; }

function vehicleByBody(b) {
  for (let i = 0; i < LB.traffic.vehicles.length; i++) {
    if (LB.traffic.vehicles[i].body === b) return LB.traffic.vehicles[i];
  }
  return null;
}

function spawnVehicle() {
  const r = Math.random();
  const type = r < 0.52 ? 'car' : (r < 0.78 ? 'cab' : 'bus');
  const def = VEHICLE_DEFS[type];
  const lane = Math.random() < 0.5 ? 0 : 1;      // 0 = far, 1 = near
  const dir = lane === 0 ? 1 : -1;                // far lane heads L→R, near lane R→L
  // spawn just offscreen but INSIDE the despawn bounds (±260) — a car that
  // spawns beyond the bound would be culled on its first stepTraffic tick
  const x = dir > 0 ? -rand(80, 220) : W + rand(80, 220);
  const y = laneSurfaceY(lane) - def.h / 2 - 1;
  const b = M.Bodies.rectangle(x, y, def.w - 6, def.h, {
    friction: 0.4, frictionStatic: 0.6, restitution: 0.12, density: 0.003,
    frictionAir: 0.008, sleepThreshold: 90,
    label: 'vehicle'
  });
  // Driving vehicles never collide with each other or with the landmarks
  // (they pass behind / in front of them); they DO collide with ground,
  // road, debris and weapons. Flung vehicles rejoin full collisions.
  b.collisionFilter.category = CAT_VEHICLE;
  b.collisionFilter.mask = 0xFFFF & ~(CAT_LANDMARK | CAT_VEHICLE);
  tag(b, 'vehicle', type);
  b.plugin.lb.dir = dir;
  b.plugin.lb.lane = lane;
  b.plugin.lb.state = 'drive';
  b.plugin.lb.speed = rand(def.speed[0], def.speed[1]);
  b.plugin.lb.color = type === 'cab' ? '#1a1a22' : type === 'bus' ? '#c81f2e' : CAR_COLORS[(Math.random() * CAR_COLORS.length) | 0];
  M.Composite.add(world, b);
  const v = { id: LB.traffic.nextId++, body: b, type: type, def: def };
  LB.traffic.vehicles.push(v);
  LB.traffic.counts.onScreen = LB.traffic.vehicles.length;
  return v;
}

function explodeVehicle(v) {
  const b = v.body, lb = b.plugin.lb;
  if (lb.removed || lb.state === 'dead') return;
  lb.state = 'dead';
  const x = b.position.x, y = b.position.y;
  const i = LB.traffic.vehicles.indexOf(v);
  if (i >= 0) LB.traffic.vehicles.splice(i, 1);
  LB.traffic.counts.onScreen = LB.traffic.vehicles.length;
  LB.traffic.counts.exploded++;
  LB.events.vehiclesExploded++;
  removeBody(b, { silent: true });

  LB.flash = Math.min(LB.flash + 0.3, 1);
  LB.shake = Math.min(LB.shake + 10, 55);
  LB.events.shakes++;
  LB.audio.boom(0.8);
  P.ring(x, y, 11, 4);
  P.embers(x, y, 26);
  P.sparks(x, y, 22, SPR.glow.gold, 8);
  P.smoke(x, y, 10, true);
  for (let k = 0; k < 5; k++) P.flame(x + rand(-14, 14), y + rand(-8, 8), rand(-1.5, 1.5), rand(-3, -0.8));
  P.debrisBurst(x, y, lb.color, 8);

  // the blast chips nearby landmark blocks and shoves everything else
  for (let k = 0; k < LB.bodies.length; k++) {
    const o = LB.bodies[k];
    if (o.isStatic || !o.plugin.lb) continue;
    const olb = o.plugin.lb;
    if (olb.removed || olb.set === 'vehicle') continue;
    const d = dist(o.position.x, o.position.y, x, y);
    if (d < 46 && olb.set !== 'meteor' && olb.set !== 'tnt') {
      removeBody(o, {});
    } else if (d < 170) {
      const f = 1 - d / 170;
      M.Sleeping.set(o, false);
      const ux = (o.position.x - x) / (d || 1), uy = (o.position.y - y) / (d || 1);
      M.Body.setVelocity(o, { x: o.velocity.x + ux * f * 13, y: o.velocity.y + uy * f * 13 - f * 5 });
    }
  }
  // chain reaction: very close vehicles get flung too
  for (let k = LB.traffic.vehicles.length - 1; k >= 0; k--) {
    const other = LB.traffic.vehicles[k];
    if (dist(other.body.position.x, other.body.position.y, x, y) < 130) flingVehicle(other, x);
  }
  if (y > WATER_Y - 14) P.splash(x, WATER_Y, 8);
}

function flingVehicle(v, fromX) {
  const b = v.body, lb = b.plugin.lb;
  if (lb.removed || lb.state !== 'drive') return;
  lb.state = 'flung';
  lb.restT = 0;
  LB.traffic.counts.flung++;
  LB.events.vehiclesFlung++;
  // the engine dies; the body rejoins the world and collides with everything
  b.collisionFilter.category = CAT_DEFAULT;
  b.collisionFilter.mask = 0xFFFFFFFF;
  M.Sleeping.set(b, false);
  const side = b.position.x >= fromX ? 1 : -1;
  M.Body.setVelocity(b, { x: side * rand(4.5, 8.5), y: rand(-13, -8) });
  M.Body.setAngularVelocity(b, rand(-0.28, 0.28));
  LB.audio.thunk();
  P.sparks(b.position.x, b.position.y, 8, SPR.glow.gold, 5);
}

function stepTraffic(dt) {
  const dts = dt / 1000;
  const V = LB.traffic;

  // keep the road alive: max VEHICLE_MAX at once, spawned on a stagger
  V.spawnTimer -= dts;
  if (V.spawnTimer <= 0 && V.vehicles.length < VEHICLE_MAX) {
    spawnVehicle();
    V.spawnTimer = rand(0.9, 2.4);
  }

  for (let i = V.vehicles.length - 1; i >= 0; i--) {
    const v = V.vehicles[i], b = v.body, lb = b.plugin.lb;
    if (lb.removed || !isFinite(b.position.x) || !isFinite(b.position.y)) {
      V.vehicles.splice(i, 1);
      V.counts.onScreen = V.vehicles.length;
      continue;
    }
    if (lb.state === 'drive') {
      if (b.position.x < -260 || b.position.x > W + 260) {
        removeBody(b, { silent: true });
        V.vehicles.splice(i, 1);
        V.counts.onScreen = V.vehicles.length;
        continue;
      }
      // kinematic drive: pin pose + velocity every step
      M.Body.setPosition(b, { x: b.position.x, y: laneSurfaceY(lb.lane) - v.def.h / 2 - 1 });
      M.Body.setVelocity(b, { x: lb.dir * lb.speed, y: 0 });
      M.Body.setAngularVelocity(b, 0);
      M.Body.setAngle(b, 0);
    } else if (lb.state === 'flung') {
      const sp = Math.sqrt(b.velocity.x * b.velocity.x + b.velocity.y * b.velocity.y);
      const grounded = b.position.y > ROAD_NEAR_Y - v.def.h / 2 - 6;
      if ((sp > 7 && grounded) || b.position.y > WATER_Y + 6) { explodeVehicle(v); continue; }
      lb.restT = (sp < 1.2 && grounded) ? (lb.restT || 0) + dts : 0;
      if (lb.restT > 2.2) explodeVehicle(v); // leaking wreck finally goes up
    }
  }
}

/* ---------------- road + vehicle painting ---------------- */
function drawRoad() {
  const g = ctx.createLinearGradient(0, GROUND_Y, 0, ROAD_BOTTOM);
  g.addColorStop(0, '#23243c');
  g.addColorStop(0.5, '#1a1b30');
  g.addColorStop(1, '#141528');
  ctx.fillStyle = g;
  ctx.fillRect(-1500, GROUND_Y, 4600, ROAD_BOTTOM - GROUND_Y);
  // kerb strip at the water
  ctx.fillStyle = '#2c2f4c';
  ctx.fillRect(-1500, ROAD_BOTTOM, 4600, WATER_Y - ROAD_BOTTOM);
  ctx.fillStyle = 'rgba(160,170,220,0.18)';
  ctx.fillRect(-1500, ROAD_BOTTOM, 4600, 2);
  // lane edge lines
  ctx.fillStyle = 'rgba(228,232,248,0.62)';
  ctx.fillRect(-1500, GROUND_Y + 3, 4600, 2.4);
  ctx.fillRect(-1500, ROAD_BOTTOM - 5, 4600, 2.4);
  // centre dashes between the lanes
  ctx.fillStyle = 'rgba(240,230,150,0.6)';
  const y = (GROUND_Y + ROAD_NEAR_Y) / 2 + 1;
  for (let x = -1500; x < 3100; x += 46) ctx.fillRect(x, y, 26, 3);
}

function vehicleShadow(def) {
  ctx.fillStyle = 'rgba(0,0,12,0.35)';
  ctx.beginPath();
  ctx.ellipse(0, def.h / 2 + 1.5, def.w / 2, 3.5, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawWheel(wx, wy, r) {
  ctx.fillStyle = '#0c0c12';
  ctx.beginPath(); ctx.arc(wx, wy, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#3a3f52';
  ctx.beginPath(); ctx.arc(wx, wy, r * 0.45, 0, Math.PI * 2); ctx.fill();
}

function drawLights(dir, frontX, y, w) {
  // headlight (warm, with a small dusk glow) + taillight (red)
  const hx = frontX * dir;
  ctx.fillStyle = '#ffe9b0';
  ctx.fillRect(hx - (dir > 0 ? 0 : 2.5), y, 2.5, 2.5);
  ctx.globalAlpha = 0.5;
  ctx.drawImage(SPR.glow.gold, hx + (dir > 0 ? -6 : -2), y - 8, 12, 12);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#ff5a4e';
  ctx.fillRect(-dir * w - (dir > 0 ? 0 : 2), y, 2, 2);
}

function drawCarBody(dir, col) {
  // lower body
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.moveTo(-20, 6.5);
  ctx.lineTo(-21, 1);
  ctx.quadraticCurveTo(-20, -1, -16, -1);
  ctx.lineTo(-9, -1);
  ctx.lineTo(-7, -6.5);
  ctx.quadraticCurveTo(-6, -8, -3, -8);
  ctx.lineTo(6, -8);
  ctx.quadraticCurveTo(9, -8, 10, -6);
  ctx.lineTo(13, -1);
  ctx.lineTo(18, -1);
  ctx.quadraticCurveTo(22, -1, 22, 2);
  ctx.lineTo(21, 6.5);
  ctx.closePath();
  ctx.fill();
  // windows
  ctx.fillStyle = '#a8bdd8';
  ctx.fillRect(-6, -6.5, 6.5, 5);
  ctx.fillRect(1.5, -6.5, 5, 5);
  // trim
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.fillRect(-18, -0.5, 37, 1.2);
  drawWheel(-12, 6.5, 4.4);
  drawWheel(12, 6.5, 4.4);
  drawLights(dir, 21, -0.5, 20);
}

function drawCabBody(dir, col) {
  // classic London TX cab: boxy, high roof
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.moveTo(-21, 8);
  ctx.lineTo(-22, -3);
  ctx.lineTo(-17, -3);
  ctx.lineTo(-15, -8.5);
  ctx.quadraticCurveTo(-14, -10, -11, -10);
  ctx.lineTo(11, -10);
  ctx.quadraticCurveTo(14, -10, 15, -8);
  ctx.lineTo(17, -3);
  ctx.lineTo(22, -2.5);
  ctx.quadraticCurveTo(23, 2, 22, 5);
  ctx.lineTo(21, 8);
  ctx.closePath();
  ctx.fill();
  // windows + yellow roof light
  ctx.fillStyle = '#9fb4d0';
  ctx.fillRect(-12, -8, 9, 5.5);
  ctx.fillRect(-1.5, -8, 9, 5.5);
  ctx.fillStyle = '#ffcf5e';
  ctx.fillRect(-2.5, -12, 5, 2);
  ctx.globalAlpha = 0.4;
  ctx.drawImage(SPR.glow.gold, -6, -16, 12, 8);
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(255,255,255,0.14)';
  ctx.fillRect(-19, -1.5, 39, 1.2);
  drawWheel(-13, 8, 4.6);
  drawWheel(13, 8, 4.6);
  drawLights(dir, 22, 0, 21);
}

function drawBusBody(dir, col) {
  // red double-decker
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.moveTo(-35, 12.5);
  ctx.lineTo(-36, -12);
  ctx.quadraticCurveTo(-36, -14, -33, -14);
  ctx.lineTo(33, -14);
  ctx.quadraticCurveTo(37, -14, 37, -10);
  ctx.lineTo(37, 8);
  ctx.quadraticCurveTo(37, 12.5, 33, 12.5);
  ctx.closePath();
  ctx.fill();
  // white roof band
  ctx.fillStyle = 'rgba(240,240,245,0.75)';
  ctx.fillRect(-35, -13.5, 71, 2.4);
  // windows: two decks of four
  ctx.fillStyle = '#b7c6de';
  for (let r = 0; r < 2; r++) {
    const wy = r === 0 ? -9.5 : -0.5;
    for (let k = 0; k < 4; k++) ctx.fillRect(-30 + k * 15, wy, 10.5, 6.5);
  }
  // destination board + open back platform hint
  ctx.fillStyle = '#ffe9b0';
  ctx.fillRect(dir > 0 ? 32 : -36, -12.5, 4, 3);
  ctx.fillStyle = 'rgba(20,10,10,0.5)';
  ctx.fillRect(dir > 0 ? -36 : 33, 0, 3, 12);
  // trim
  ctx.fillStyle = 'rgba(255,255,255,0.2)';
  ctx.fillRect(-35, 6.5, 71, 1.4);
  drawWheel(-23, 12.5, 5.6);
  drawWheel(23, 12.5, 5.6);
  drawLights(dir, 36, 2, 35);
}

function drawVehicle(v) {
  const b = v.body, lb = b.plugin.lb;
  ctx.save();
  ctx.translate(b.position.x, b.position.y);
  ctx.rotate(b.angle);
  vehicleShadow(v.def);
  if (v.type === 'bus') drawBusBody(lb.dir, lb.color);
  else if (v.type === 'cab') drawCabBody(lb.dir, lb.color);
  else drawCarBody(lb.dir, lb.color);
  ctx.restore();
}

function drawVehicles(laneFilter) {
  for (let i = 0; i < LB.traffic.vehicles.length; i++) {
    const v = LB.traffic.vehicles[i], lb = v.body.plugin.lb;
    if (lb.removed) continue;
    if (laneFilter === 0 && lb.lane !== 0 && lb.state === 'drive') continue;
    if (laneFilter === 1 && lb.lane === 0 && lb.state === 'drive') continue;
    drawVehicle(v);
  }
}

/* ============================================================
   WEAPONS
   ============================================================ */
function fire(weapon, wx, wy) {
  if (LB.phase === 'title' || LB.paused) return false;
  if (weapon === 'meteor') {
    if (LB.meteors.length >= 4) return false;
    spawnMeteor(wx, wy);
    LB.weaponFired.meteor++;
    LB.audio.whoosh();
    return true;
  }
  if (weapon === 'blackhole') {
    if (LB.holes.length >= 2) return false;
    const y = Math.min(wy, GROUND_Y - 90);
    LB.holes.push({ x: clamp(wx, 80, W - 80), y: y, t: 0, dur: 3.6, consumed: 0, on: true });
    LB.weaponFired.blackhole++;
    LB.audio.eerie();
    P.ring(wx, y, 6, 2, 'rgba(160,110,255,0.8)');
    return true;
  }
  if (weapon === 'tornado') {
    if (LB.tornados.length >= 2) return false;
    const t = { x: clamp(wx, 120, W - 120), y: GROUND_Y, t: 0, dur: 5.2, phase: Math.random() * 10, on: true, audio: null };
    LB.tornados.push(t);
    LB.weaponFired.tornado++;
    LB.audio.rumbleStart(t);
    return true;
  }
  if (weapon === 'tnt') {
    if (LB.tnts.length >= 8) return false;
    if (!isFinite(wx) || !isFinite(wy)) return false;
    spawnTNT(clamp(wx, 40, W - 40), clamp(wy, 40, H - 40));
    LB.weaponFired.tnt++;
    LB.events.tntPlaced++;
    return true;
  }
  if (weapon === 'bomb') {
    if (LB.bombs.length >= 6) return false;
    if (!isFinite(wx) || !isFinite(wy)) return false;
    spawnBomb(clamp(wx, 40, W - 40), clamp(wy, 40, GROUND_Y - 10));
    LB.weaponFired.bomb++;
    return true;
  }
  if (weapon === 'tnt_ben') {
    if (LB.tnts.length >= 8) return false;
    if (!isFinite(wx) || !isFinite(wy)) return false;
    spawnTntBen(clamp(wx, 60, W - 60), clamp(wy, 130, GROUND_Y - 60));
    LB.weaponFired.tnt_ben++;
    return true;
  }
  if (weapon === 'nova') {
    if (LB.novas.length >= 3) return false;
    if (!isFinite(wx) || !isFinite(wy)) return false;
    spawnNova(clamp(wx, 80, W - 80), clamp(wy, 60, GROUND_Y - 34));
    LB.weaponFired.nova++;
    return true;
  }
  if (weapon === 'nuke') {
    if (LB.nukes.length >= 1) return false;
    if (!isFinite(wx) || !isFinite(wy)) return false;
    spawnNuke(clamp(wx, 90, W - 90), clamp(wy, 60, GROUND_Y - 30));
    LB.weaponFired.nuke++;
    return true;
  }
  if (weapon === 'tsunami') {
    if (LB.tsunamis.length >= 1) return false;
    spawnTsunami();
    LB.weaponFired.tsunami++;
    return true;
  }
  if (weapon === 'laser') {
    if (LB.lasers.length >= 1) return false;
    spawnLaser(wx, wy);
    LB.weaponFired.laser++;
    return true;
  }
  if (weapon === 'stone') {
    if (LB.stones.length >= 2) return false;
    spawnStone();
    LB.weaponFired.stone++;
    return true;
  }
  if (weapon === 'vortex') {
    if (LB.vortices.length >= 2) return false;
    if (!isFinite(wx)) return false;
    spawnVortex(wx);
    LB.weaponFired.vortex++;
    return true;
  }
  if (weapon === 'fire') {
    if (LB.fires.length >= 3) return false;
    if (!isFinite(wx)) return false;
    spawnFire(clamp(wx, 60, W - 60));
    LB.weaponFired.fire++;
    return true;
  }
  return false;
}

function spawnMeteor(tx, ty) {
  const sx = clamp(tx + rand(-280, 280), 40, W - 40), sy = -130;
  let dx = tx - sx, dy = ty - sy;
  const d = Math.max(dist(0, 0, dx, dy), 1);
  dx /= d; dy /= d;
  const b = M.Bodies.circle(sx, sy, 24, {
    density: 0.012, friction: 0.1, frictionAir: 0, restitution: 0.35,
    label: 'meteor'
  });
  tag(b, 'meteor', 'meteor');
  b.plugin.lb.color = '#ff9440';
  b.plugin.lb.exploded = false;
  b.plugin.lb.steps = 0;
  M.Body.setVelocity(b, { x: dx * 32, y: dy * 32 });
  M.Composite.add(world, b);
  LB.meteors.push(b);
}

function explodeMeteor(b) {
  const lb = b.plugin.lb;
  if (lb.exploded) return;
  lb.exploded = true;
  const x = b.position.x, y = b.position.y;
  const i = LB.meteors.indexOf(b);
  if (i >= 0) LB.meteors.splice(i, 1);
  removeBody(b, { silent: true });

  LB.flash = Math.min(LB.flash + 0.85, 1);
  LB.shake = Math.min(LB.shake + 26, 55);
  LB.events.explosions++;
  LB.events.shakes++;
  LB.audio.boom(1);
  P.ring(x, y, 13, 5);
  P.ring(x, y, 8, 3, 'rgba(255,180,90,0.7)');
  P.embers(x, y, 44);
  P.sparks(x, y, 34, SPR.glow.gold, 9);
  P.smoke(x, y, 16, true);

  // vaporize core + radial impulse
  for (let k = 0; k < LB.bodies.length; k++) {
    const o = LB.bodies[k];
    if (o.isStatic || !o.plugin.lb) continue;
    const olb = o.plugin.lb;
    if (olb.removed) continue;
    const d = dist(o.position.x, o.position.y, x, y);
    if (olb.set === 'vehicle') {
      // METEOR rule: traffic caught in the blast explodes immediately
      if (d < 100) { const veh = vehicleByBody(o); if (veh) explodeVehicle(veh); }
      continue;
    }
    if (d < 62 && olb.set !== 'meteor') {
      removeBody(o, {});
    } else if (d < 340) {
      const f = 1 - d / 340;
      let ux = (o.position.x - x) / (d || 1), uy = (o.position.y - y) / (d || 1);
      M.Sleeping.set(o, false);
      M.Body.setVelocity(o, {
        x: o.velocity.x + ux * f * 26,
        y: o.velocity.y + uy * f * 26 - f * 9
      });
      M.Body.setAngularVelocity(o, o.angularVelocity + (Math.random() - 0.5) * 0.25 * f);
    }
  }
  // scorch decal
  if (y > GROUND_Y - 90) {
    LB.decals.push({ x: x, y: Math.min(y, GROUND_Y + 8), size: rand(70, 110), alpha: 0.55 });
    if (LB.decals.length > 14) LB.decals.shift();
  }
}

/* ---------------- TNT (Minecraft-style: real body, 3 s flashing fuse) ---------------- */
const TNT_SIZE = 34;
const TNT_FUSE = 3.0;
let tntSeq = 0;

function tntBlinkOn(elapsed, dur) {
  // Minecraft flash: white blink whose period shortens toward detonation.
  // Pure function of elapsed time (deterministic, testable). ON fraction is 35%
  // so the iconic red block dominates still frames mid-fuse.
  const fuse = dur || TNT_FUSE;
  const f = clamp(elapsed / fuse, 0, 1);
  const period = Math.max(0.55 - 0.47 * f, 0.08);
  return (elapsed % period) < period * 0.35;
}

function spawnTNT(x, y) {
  const b = M.Bodies.rectangle(x, y, TNT_SIZE, TNT_SIZE, {
    friction: 0.6, frictionStatic: 0.9, restitution: 0.05,
    density: 0.004, frictionAir: 0.01, sleepThreshold: 60,
    label: 'tnt'
  });
  tag(b, 'tnt', 'tnt');
  b.plugin.lb.color = '#d5442c';
  // deterministic mottle pattern (stable across frames — no per-frame flicker)
  const rng = mulberry32(90001 + ((++tntSeq) * 7919) % 65536);
  const h = TNT_SIZE / 2, speck = [];
  for (let k = 0; k < 7; k++) {
    speck.push([-h + 3 + rng() * (TNT_SIZE - 6), -h + 2 + rng() * 7, rng() < 0.5]);
    speck.push([-h + 3 + rng() * (TNT_SIZE - 6), h - 2 - rng() * 7, rng() < 0.5]);
  }
  b.plugin.lb.speck = speck;
  M.Composite.add(world, b);
  const t = { id: tntSeq, body: b, t: 0, dur: TNT_FUSE, on: true, audio: null };
  LB.tnts.push(t);
  LB.audio.fuseStart(t);
  // instant placement feedback
  P.dustPuff(x, y, 0, -0.4, 26, 0.35);
  P.sparks(x, y - TNT_SIZE / 2, 6, SPR.glow.gold, 4);
  return t;
}

function explodeTNT(t) {
  LB.audio.fuseStop(t);
  t.on = false;
  const b = t.body;
  if (!b.plugin.lb || b.plugin.lb.removed) return;
  const x = b.position.x, y = b.position.y;
  // TNT BEN 🧱 detonates ~3x stronger than plain TNT; plain params untouched.
  const ben = !!t.ben;
  const CORE = ben ? 112 : 74;        // vaporize core radius (px)
  const PUSH = ben ? 520 : 360;       // radial push radius (px)
  const FLING = ben ? 90 : 30;        // push force (~3x for ben)
  const LIFT = ben ? 26 : 10;         // upward bias of the push
  const VEH_CORE = ben ? 160 : 110;   // traffic caught in the blast
  const CUT_R = ben ? 130 : 78;       // Eye cable sever radius
  removeBody(b, { silent: true });

  LB.flash = Math.min(LB.flash + (ben ? 1.0 : 0.9), 1);
  LB.shake = Math.min(LB.shake + (ben ? 48 : 30), 55);
  LB.events.explosions++;
  LB.events.shakes++;
  LB.events.tntExploded++;
  if (ben) {
    LB.audio.tripleBoom();
    P.ring(x, y, 24, 9);
    P.ring(x, y, 16, 6, 'rgba(255,190,110,0.9)');
    P.ring(x, y, 10, 4, 'rgba(255,120,70,0.8)');
    P.embers(x, y, 110);
    P.sparks(x, y, 84, SPR.glow.gold, 14);
    P.smoke(x, y, 40, true);
    for (let k = 0; k < 18; k++) {
      P.flame(x + rand(-48, 48), y + rand(-48, 48), rand(-3, 3), rand(-5, -1));
    }
  } else {
    LB.audio.boom(1.15);
    P.ring(x, y, 15, 6);
    P.ring(x, y, 9, 3, 'rgba(255,190,110,0.8)');
    P.embers(x, y, 52);
    P.sparks(x, y, 40, SPR.glow.gold, 10);
    P.smoke(x, y, 20, true);
    for (let k = 0; k < 8; k++) {
      P.flame(x + rand(-26, 26), y + rand(-26, 26), rand(-2, 2), rand(-3.4, -0.6));
    }
  }

  // vaporize core + radial impulse (other TNT blocks are flung, never vaporized:
  // every fuse runs its own full schedule — no chain detonation)
  for (let k = 0; k < LB.bodies.length; k++) {
    const o = LB.bodies[k];
    if (o.isStatic || !o.plugin.lb) continue;
    const olb = o.plugin.lb;
    if (olb.removed) continue;
    const d = dist(o.position.x, o.position.y, x, y);
    if (olb.set === 'vehicle') {
      // TNT rule: traffic caught in the blast explodes immediately
      if (d < VEH_CORE) { const veh = vehicleByBody(o); if (veh) explodeVehicle(veh); }
      continue;
    }
    if (d < CORE && olb.set !== 'meteor' && olb.set !== 'tnt') {
      removeBody(o, {});
    } else if (d < PUSH) {
      const f = 1 - d / PUSH;
      const ux = (o.position.x - x) / (d || 1), uy = (o.position.y - y) / (d || 1);
      M.Sleeping.set(o, false);
      M.Body.setVelocity(o, {
        x: o.velocity.x + ux * f * FLING,
        y: o.velocity.y + uy * f * FLING - f * LIFT
      });
      M.Body.setAngularVelocity(o, o.angularVelocity + (Math.random() - 0.5) * 0.3 * f);
    }
  }
  // the blast severs nearby Eye cables, like the other weapons do
  for (let ci = LB.constraints.length - 1; ci >= 0; ci--) {
    const c = LB.constraints[ci];
    const ax = c.bodyA ? c.bodyA.position.x + c.pointA.x : c.pointA.x;
    const ay = c.bodyA ? c.bodyA.position.y + c.pointA.y : c.pointA.y;
    const bx = c.bodyB ? c.bodyB.position.x + c.pointB.x : c.pointB.x;
    const by = c.bodyB ? c.bodyB.position.y + c.pointB.y : c.pointB.y;
    if (dist((ax + bx) / 2, (ay + by) / 2, x, y) < CUT_R) {
      M.Composite.remove(world, c);
      LB.constraints.splice(ci, 1);
      LB.events.brokenConstraints++;
      P.sparkle((ax + bx) / 2, (ay + by) / 2, 5);
    }
  }
  // scorch decal
  if (y > GROUND_Y - 110) {
    LB.decals.push({ x: x, y: Math.min(y, GROUND_Y + 8), size: ben ? rand(140, 190) : rand(80, 120), alpha: 0.55 });
    if (LB.decals.length > 14) LB.decals.shift();
  }
}

/* ============================================================
   V3 ARSENAL — 9 new weapons ported from the old Big Ben game.
   All auto-ignite (kid-first: no right-click anywhere). New weapons
   share the radialBlast helper below; meteor/TNT keep their own
   hand-tuned loops untouched.
   ============================================================ */
const WEAPON_SETS = { meteor: 1, tnt: 1, bomb: 1, nuke: 1, nova: 1, stone: 1, firecrate: 1 };

// Shared radial blast for the v3 weapons. Skips other weapons' bodies
// (no chain detonations — matches the TNT roadmap decision), applies
// the blast => instant vehicle explosion rule and severs nearby Eye
// cables like every other blast does.
function radialBlast(x, y, o) {
  for (let k = 0; k < LB.bodies.length; k++) {
    const b = LB.bodies[k];
    if (b.isStatic || !b.plugin.lb) continue;
    const lb = b.plugin.lb;
    if (lb.removed || WEAPON_SETS[lb.set]) continue;
    const d = dist(b.position.x, b.position.y, x, y);
    if (lb.set === 'vehicle') {
      if (d < o.vehCore) { const veh = vehicleByBody(b); if (veh) explodeVehicle(veh); }
      continue;
    }
    if (d < o.core) {
      removeBody(b, {});
    } else if (d < o.push) {
      const f = 1 - d / o.push;
      const ux = (b.position.x - x) / (d || 1), uy = (b.position.y - y) / (d || 1);
      M.Sleeping.set(b, false);
      M.Body.setVelocity(b, {
        x: b.velocity.x + ux * f * o.fling,
        y: b.velocity.y + uy * f * o.fling - f * o.lift
      });
      M.Body.setAngularVelocity(b, b.angularVelocity + (Math.random() - 0.5) * 0.25 * f);
    }
  }
  if (o.cutR) {
    for (let ci = LB.constraints.length - 1; ci >= 0; ci--) {
      const c = LB.constraints[ci];
      const ax = c.bodyA ? c.bodyA.position.x + c.pointA.x : c.pointA.x;
      const ay = c.bodyA ? c.bodyA.position.y + c.pointA.y : c.pointA.y;
      const bx = c.bodyB ? c.bodyB.position.x + c.pointB.x : c.pointB.x;
      const by = c.bodyB ? c.bodyB.position.y + c.pointB.y : c.pointB.y;
      if (dist((ax + bx) / 2, (ay + by) / 2, x, y) < o.cutR) {
        M.Composite.remove(world, c);
        LB.constraints.splice(ci, 1);
        LB.events.brokenConstraints++;
        P.sparkle((ax + bx) / 2, (ay + by) / 2, 5);
      }
    }
  }
}

/* The nuke's wipe: every active effect ends right now (the old game's
   _detonate_nuclear_bomb cleared each effect list; audio loops stop). */
function clearAllEffects() {
  let i;
  for (i = LB.tornados.length - 1; i >= 0; i--) LB.audio.rumbleStop(LB.tornados[i]);
  LB.tornados.length = 0;
  for (i = LB.tnts.length - 1; i >= 0; i--) LB.audio.fuseStop(LB.tnts[i]);
  LB.tnts.length = 0;
  for (i = LB.bombs.length - 1; i >= 0; i--) LB.audio.fuseStop(LB.bombs[i]);
  LB.bombs.length = 0;
  LB.holes.length = 0;
  for (i = LB.lasers.length - 1; i >= 0; i--) LB.audio.laserHumStop(LB.lasers[i]);
  LB.lasers.length = 0;
  LB.tsunamis.length = 0;
  for (i = LB.vortices.length - 1; i >= 0; i--) LB.audio.swirlStop(LB.vortices[i]);
  LB.vortices.length = 0;
  for (i = LB.stones.length - 1; i >= 0; i--) LB.audio.rumbleStop(LB.stones[i]);
  LB.stones.length = 0;
  LB.fires.length = 0;
  LB.novas.length = 0;
  LB.novaRings.length = 0;
  LB.meteors.length = 0;
  LB.rockets.length = 0;
}

/* ---------------- BOMB 💣 — round black bomb, 2 s auto-fuse ---------------- */
const BOMB_R = 22, BOMB_FUSE = 2.0;
function spawnBomb(x, y) {
  const b = M.Bodies.circle(x, y, BOMB_R, {
    friction: 0.5, frictionStatic: 0.8, restitution: 0.18,
    density: 0.006, frictionAir: 0.008, sleepThreshold: 60, label: 'bomb'
  });
  tag(b, 'bomb', 'bomb');
  b.plugin.lb.color = '#17171d';
  M.Composite.add(world, b);
  const t = { body: b, t: 0, dur: BOMB_FUSE, on: true, audio: null };
  LB.bombs.push(t);
  LB.audio.fuseStart(t);
  P.dustPuff(x, y, 0, -0.4, 22, 0.3);
  return t;
}
function explodeBomb(t) {
  LB.audio.fuseStop(t);
  t.on = false;
  const b = t.body;
  if (!b.plugin.lb || b.plugin.lb.removed) return;
  const x = b.position.x, y = b.position.y;
  removeBody(b, { silent: true });
  LB.flash = Math.min(LB.flash + 0.6, 1);
  LB.shake = Math.min(LB.shake + 20, 55);
  LB.events.explosions++;
  LB.events.shakes++;
  LB.audio.boomDeep(1);
  P.ring(x, y, 12, 4);
  P.ring(x, y, 7, 2, 'rgba(255,190,110,0.7)');
  P.embers(x, y, 34);
  P.sparks(x, y, 26, SPR.glow.gold, 8);
  P.smoke(x, y, 12, true);
  radialBlast(x, y, { core: 60, push: 310, vehCore: 95, fling: 15, lift: 5, cutR: 66 });
  if (y > GROUND_Y - 100) {
    LB.decals.push({ x: x, y: Math.min(y, GROUND_Y + 8), size: rand(60, 90), alpha: 0.5 });
    if (LB.decals.length > 14) LB.decals.shift();
  }
}

/* ---------------- TNT BEN 🧱 — 3-block TNT tower, 1.5 s fuse, 3x strength ---------------- */
function spawnTntBen(x, y) {
  const partOpts = {
    friction: 0.6, frictionStatic: 0.9, restitution: 0.05,
    density: 0.004, frictionAir: 0.01, sleepThreshold: 60, label: 'tnt'
  };
  const parts = [];
  for (let i = 0; i < 3; i++) {
    parts.push(M.Bodies.rectangle(x, y + TNT_SIZE - i * TNT_SIZE, TNT_SIZE, TNT_SIZE, partOpts));
  }
  const b = M.Body.create({ parts: parts });
  tag(b, 'tnt', 'tnt_ben');
  b.plugin.lb.color = '#d5442c';
  const rng = mulberry32(90100 + ((++tntSeq) * 7919) % 65536);
  const specks = [];
  for (let p = 0; p < 3; p++) {
    const hh = TNT_SIZE / 2, speck = [];
    for (let k = 0; k < 7; k++) {
      speck.push([-hh + 3 + rng() * (TNT_SIZE - 6), -hh + 2 + rng() * 7, rng() < 0.5]);
      speck.push([-hh + 3 + rng() * (TNT_SIZE - 6), hh - 2 - rng() * 7, rng() < 0.5]);
    }
    specks.push(speck);
  }
  b.plugin.lb.specks = specks;
  M.Composite.add(world, b);
  const t = { id: tntSeq, body: b, t: 0, dur: 1.5, ben: true, on: true, audio: null };
  LB.tnts.push(t);
  LB.events.tntPlaced++;
  LB.audio.fuseStart(t);
  P.dustPuff(x, y, 0, -0.5, 30, 0.35);
  P.sparks(x, y - TNT_SIZE * 1.5, 8, SPR.glow.gold, 4);
  return t;
}

/* ---------------- NOVA 🌟 — 3 s charge, then a huge colorful blast ---------------- */
const NOVA_R = 30, NOVA_FUSE = 3.0;
const NOVA_COLS = ['red', 'orange', 'gold', 'green', 'blue', 'purple'];
function spawnNova(x, y) {
  const b = M.Bodies.circle(x, y, NOVA_R, {
    friction: 0.9, frictionStatic: 1, restitution: 0.04,
    density: 0.009, frictionAir: 0.01, sleepThreshold: 60, label: 'nova'
  });
  tag(b, 'nova', 'nova');
  b.plugin.lb.color = '#ffd76b';
  M.Composite.add(world, b);
  const t = { body: b, t: 0, dur: NOVA_FUSE, on: true };
  LB.novas.push(t);
  LB.audio.novaCharge(NOVA_FUSE);
  return t;
}
function explodeNova(t) {
  t.on = false;
  const b = t.body;
  if (!b.plugin.lb || b.plugin.lb.removed) return;
  const x = b.position.x, y = b.position.y;
  removeBody(b, { silent: true });
  LB.flash = Math.min(LB.flash + 0.95, 1);
  LB.shake = Math.min(LB.shake + 34, 55);
  LB.events.explosions++;
  LB.events.shakes++;
  LB.audio.novaBoom();
  // two-stage impact like the old nova: full force, then an echo at ~0.62 r / 0.78 d
  radialBlast(x, y, { core: 190, push: 830, vehCore: 210, fling: 34, lift: 12, cutR: 150 });
  radialBlast(x, y, { core: 118, push: 515, vehCore: 130, fling: 26, lift: 9, cutR: 0 });
  // 90+ colorful particles (palette red/orange/gold/green/blue/purple)
  for (let k = 0; k < 96; k++) {
    const a = Math.random() * Math.PI * 2, v = rand(3, 17);
    P.spawn('spark', x, y, {
      vx: Math.cos(a) * v, vy: Math.sin(a) * v - 2,
      life: rand(0.6, 1.7), size: rand(4, 9), drag: 0.955, grav: 0.05,
      spr: SPR.glow[NOVA_COLS[k % NOVA_COLS.length]]
    });
  }
  P.ring(x, y, 20, 6);
  P.ring(x, y, 13, 4, 'rgba(255,220,150,0.8)');
  LB.novaRings.push({ x: x, y: y, t: 0, dur: 1.9, hue: Math.random() * 360 });
  if (y > GROUND_Y - 120) {
    LB.decals.push({ x: x, y: Math.min(y, GROUND_Y + 8), size: rand(120, 170), alpha: 0.55 });
    if (LB.decals.length > 14) LB.decals.shift();
  }
}

/* ---------------- NUKE ☢️ — siren ~2.5 s, then the wipe ---------------- */
const NUKE_SIZE = 56, NUKE_FUSE = 2.5;
function spawnNuke(x, y) {
  const b = M.Bodies.rectangle(x, y, NUKE_SIZE, NUKE_SIZE, {
    friction: 0.6, frictionStatic: 0.9, restitution: 0.03,
    density: 0.006, frictionAir: 0.01, sleepThreshold: 60, label: 'nuke'
  });
  tag(b, 'nuke', 'nuke');
  b.plugin.lb.color = '#8a8f98';
  M.Composite.add(world, b);
  const t = { body: b, t: 0, dur: NUKE_FUSE, on: true };
  LB.nukes.push(t);
  LB.audio.sirenWail(NUKE_FUSE);
  P.dustPuff(x, y, 0, -0.5, 34, 0.35);
  return t;
}
function explodeNuke(t) {
  t.on = false;
  const b = t.body;
  if (!b.plugin.lb || b.plugin.lb.removed) return;
  const x = b.position.x, y = Math.min(b.position.y, GROUND_Y);
  removeBody(b, { silent: true });
  clearAllEffects();          // the wipe: no meteor / tornado / laser / ... survives it
  LB.flash = 1;               // full-screen white
  LB.shake = 55;
  LB.events.explosions++;
  LB.events.shakes++;
  LB.audio.nukeBoom();
  // v3.1: no instant radialBlast — an expanding vaporization front eats the skyline
  LB.nukeWaves.push({ x: x, y: y, r: 0, speed: NUKE_WAVE_SPEED, popT: 0, crackleT: 0.3, maxR: 0 });
  P.ring(x, y, 46, 12);
  P.ring(x, y, 26, 7, 'rgba(255,200,120,0.85)');
  P.ring(x, y, 14, 4, 'rgba(255,240,200,0.9)');
  P.smoke(x, y, 26, true);
  spawnMushroom(x, y);
  LB.decals.push({ x: x, y: GROUND_Y + 8, size: 260, alpha: 0.7 });
  if (LB.decals.length > 14) LB.decals.shift();
}

/* ---------------- the vaporization wave ----------------
   An expanding destruction front (NUKE_WAVE_SPEED px/s) from the epicentre.
   Landmark bodies it passes are REMOVED (vaporized) with debris/embers flying
   radially OUT from the epicentre — harder the closer they were. Effects are
   batched per ~64px cluster so ~900 blocks don't explode the particle budget.
   Vehicles in the front are flung violently outward (existing flung path then
   explodes them on landing, feeding the traffic counters). */
const NUKE_WAVE_SPEED = 1080;   // px/s — whole 1600px world in ~1.5 s
function stepNukeWaves(dts) {
  for (let i = LB.nukeWaves.length - 1; i >= 0; i--) {
    const w = LB.nukeWaves[i];
    w.r += w.speed * dts;
    w.popT -= dts;
    w.crackleT -= dts;
    // 1) landmark vaporization (tower / annex / all Eye parts incl. hub statics)
    const clusters = {};        // spatial hash: one pop flash per cluster
    let vaporized = 0;
    for (let k = 0; k < LB.bodies.length; k++) {
      const o = LB.bodies[k], lb = o.plugin.lb;
      if (!lb || lb.removed) continue;
      if (lb.set !== 'tower' && lb.set !== 'eye' && lb.set !== 'annex') continue;
      const d = dist(o.position.x, o.position.y, w.x, w.y);
      if (d > w.r) continue;
      const col = lb.color || '#b9975a';
      removeBody(o, { silent: true });   // constraints cleaned exactly like destroyAll()
      vaporized++;
      const cx = (o.position.x + 32) >> 6, cy = (o.position.y + 32) >> 6;
      const key = cx * 4096 + cy;
      if (!clusters[key]) clusters[key] = { x: o.position.x, y: o.position.y, n: 0, col: col, dSum: 0 };
      const c = clusters[key];
      c.n++;
      c.x = (c.x * c.n + o.position.x) / (c.n + 1);
      c.y = (c.y * c.n + o.position.y) / (c.n + 1);
      c.dSum += d;
    }
    // 2) per-cluster vapor burst: radial debris + embers, tiny pop flash
    let rings = 0;
    for (const key in clusters) {
      const c = clusters[key];
      const dAvg = c.dSum / c.n;
      const pow = 1 - clamp(dAvg / NUKE_WAVE_SPEED * 1.15, 0, 1); // closer to epicentre = harder
      const spd = 9 + pow * 22;
      const nDeb = 3 + (c.n > 2 ? 3 : 1);
      for (let k = 0; k < nDeb; k++) {
        const a = Math.atan2(c.y - w.y, c.x - w.x) + rand(-0.75, 0.75);
        const v = spd * rand(0.55, 1.3);
        P.spawn('debris', c.x, c.y, {
          vx: Math.cos(a) * v, vy: Math.sin(a) * v - rand(1, 4),
          life: rand(0.7, 1.6), size: rand(2.5, 6.5), grav: 0.14, drag: 0.99,
          vr: rand(-0.4, 0.4), col: c.col
        });
      }
      for (let k = 0; k < 3; k++) {
        const a = Math.atan2(c.y - w.y, c.x - w.x) + rand(-1.0, 1.0);
        const v = spd * rand(0.6, 1.2);
        P.spawn('ember', c.x, c.y, {
          vx: Math.cos(a) * v, vy: Math.sin(a) * v - rand(1.5, 4.5),
          life: rand(0.6, 1.5), size: rand(4, 9), drag: 0.96,
          spr: Math.random() < 0.5 ? SPR.glow.orange : SPR.glow.gold
        });
      }
      if (rings < 2 && w.popT <= 0) {
        P.ring(c.x, c.y, 9, 3, 'rgba(255,244,220,0.75)');
        P.sparks(c.x, c.y, 4, SPR.glow.white, 5);
        rings++;
      }
    }
    if (rings) w.popT = 0.06;
    // 3) faint crackle while the front is eating structures
    if (vaporized > 0 && w.crackleT <= 0) {
      LB.audio.crackle(2);
      w.crackleT = 0.4;
    }
    // 4) vehicles in the front: flung violently outward (+ explodes on landing)
    for (let k = LB.traffic.vehicles.length - 1; k >= 0; k--) {
      const v = LB.traffic.vehicles[k], vb = v.body, vlb = vb.plugin.lb;
      if (!vlb || vlb.removed || vlb.state === 'dead') continue;
      const d = dist(vb.position.x, vb.position.y, w.x, w.y);
      if (d > w.r) continue;
      if (vlb.state === 'drive') flingVehicle(v, w.x);
      if (vlb.state !== 'flung') continue;
      const ux = (vb.position.x - w.x) / (d || 1), uy = (vb.position.y - w.y) / (d || 1);
      M.Sleeping.set(vb, false);
      M.Body.setVelocity(vb, { x: ux * rand(11, 17), y: uy * rand(4, 8) - rand(9, 14) });
      M.Body.setAngularVelocity(vb, rand(-0.5, 0.5));
    }
    // done: the front has crossed every corner of the world
    if (w.r > 2350) LB.nukeWaves.splice(i, 1);
  }
}

/* ---------------- the mushroom cloud (hero effect) ----------------
   Layered translucent blobs + additive glow, pure canvas. Stages:
   fireball (0-0.8 s) -> stem churn (0.8 s+) -> rolling cap (~1.2 s+) ->
   slow dissipate (~6.4 s+). Everything animates; never a static sprite. */
const MUSH_DUR = 8.6;
function spawnMushroom(x, y) {
  const m = {
    x: x, y: GROUND_Y, t: 0, dur: MUSH_DUR,
    blobs: [],                    // { kind, t, life, x, y, vx, vy, size, grow, seed, ang, w, rho, dir }
    ringsT: [1.35, 2.05, 2.9],    // smoke-ring puff times
    rings: [],                    // expanding ellipse strokes
    spawnAcc: 0, capAcc: 0, skirtAcc: 0, emberAcc: 0, ringIdx: 0,
    drift: rand(-7, 7),
    seed: Math.random() * 100
  };
  LB.mushrooms.push(m);
  return m;
}
function mushCapParams(m) {
  // cap centre height + radii over time (bloom out to ~500-700px wide)
  const rise = 1 - Math.pow(1 - Math.min(1, m.t / 4.6), 3);
  const capY = m.y - 46 - 386 * rise;
  const bloom = 1 - Math.pow(1 - Math.min(1, Math.max(0, m.t - 1.0) / 3.4), 2.2);
  const capA = 70 + 225 * bloom;   // semi-major (~500-700 px wide when fully bloomed)
  const capB = 26 + 82 * bloom;    // semi-minor
  return { capY: capY, capA: capA, capB: capB };
}
function mushStage(m) {
  if (m.t < 0.8) return 'fireball';
  if (m.t < 1.2) return 'stem';
  if (m.t < 6.4) return 'cap';
  return 'dissipate';
}
function stepMushroom(m, dts) {
  m.t += dts;
  m.x += m.drift * dts;                       // slow sideways drift
  const cp = mushCapParams(m);
  const sway = Math.sin(m.t * 1.25 + m.seed) * 10;

  // stem churn: blobs spawn at the base, rise, expand, fade (until dissipate)
  if (m.t > 0.55 && m.t < 6.4) {
    const rate = m.t < 1.6 ? 34 : 24 - (m.t - 1.6) * 2.4;
    m.spawnAcc += rate * dts;
    while (m.spawnAcc >= 1) {
      m.spawnAcc--;
      const life = Math.min(rand(2.6, 4.1), m.dur - m.t - 0.15);
      m.blobs.push({
        kind: 'stem', t: 0, life: life,
        x: m.x + rand(-24, 24), y: m.y - rand(-2, 16),
        vx: rand(-5, 5), vy: -rand(105, 165),
        size: rand(30, 50), grow: rand(15, 27),
        seed: Math.random() * 100
      });
    }
  }
  // cap circulation: blobs rise through the centre, curl outward over the edges
  if (m.t > 1.05 && m.t < 6.2) {
    const rate = m.t < 2.2 ? 22 : 15;
    m.capAcc += rate * dts;
    while (m.capAcc >= 1) {
      m.capAcc--;
      const life = Math.min(rand(2.8, 4.3), m.dur - m.t - 0.15);
      m.blobs.push({
        kind: 'cap', t: 0, life: life,
        x: m.x, y: cp.capY, vx: 0, vy: 0,
        size: rand(30, 52), grow: rand(10, 20),
        seed: Math.random() * 100,
        ang: rand(0, Math.PI * 2),
        w: rand(0.5, 0.9),                         // angular speed (rolling)
        rho: rand(0.2, 0.55),                      // 0 = centre, 1 = rim
        dir: rand(0.75, 1.25)                      // outward bloom speed
      });
    }
  }
  // skirt / base surge: ground-hugging ring curling outward (Wilson vibe)
  if (m.t > 0.45 && m.t < 2.7) {
    m.skirtAcc += 15 * dts;
    while (m.skirtAcc >= 1) {
      m.skirtAcc--;
      const side = Math.random() < 0.5 ? -1 : 1;
      const life = Math.min(rand(1.7, 2.7), m.dur - m.t - 0.15);
      m.blobs.push({
        kind: 'skirt', t: 0, life: life,
        x: m.x + side * rand(8, 42), y: m.y - rand(0, 16),
        vx: side * rand(55, 125), vy: -rand(3, 10),
        size: rand(24, 42), grow: rand(20, 34),
        seed: Math.random() * 100
      });
    }
  }
  // ember sparks riding up the stem
  if (m.t < 5.6) {
    m.emberAcc += 7 * dts;
    while (m.emberAcc >= 1) {
      m.emberAcc--;
      m.blobs.push({
        kind: 'ember', t: 0, life: rand(0.9, 1.5),
        x: m.x + rand(-16, 16), y: m.y - rand(0, 10),
        vx: rand(-6, 6), vy: -rand(150, 210),
        size: rand(3, 6), grow: 0,
        seed: Math.random() * 100
      });
    }
  }
  // early smoke rings puffing outward
  while (m.ringIdx < m.ringsT.length && m.t >= m.ringsT[m.ringIdx]) {
    m.rings.push({ t: 0, dur: 1.7, y: cp.capY + 14, a: 0.42, seed: Math.random() * 10 });
    m.ringIdx++;
  }
  for (let i = m.rings.length - 1; i >= 0; i--) {
    m.rings[i].t += dts;
    if (m.rings[i].t > m.rings[i].dur) m.rings.splice(i, 1);
  }

  // advance blobs
  for (let i = m.blobs.length - 1; i >= 0; i--) {
    const b = m.blobs[i];
    b.t += dts;
    if (b.t >= b.life) { m.blobs.splice(i, 1); continue; }
    if (b.kind === 'stem') {
      // slight sway + gentle pull back to the (drifting) centreline
      const homeX = m.x + sway * Math.sin(b.seed + m.t * 0.8) * 0.5;
      b.vx += (homeX - b.x) * 0.9 * dts * 4;
      b.vx += Math.sin(b.seed + m.t * 5.2) * 6 * dts;
      b.vy *= 1 - 0.22 * dts;                    // slows as it climbs
      // fade out approaching the cap (the cap "feeds" from the stem)
      const head = (m.y - b.y) / Math.max(1, m.y - cp.capY);
      if (head > 0.92) b.t += dts * 2.2;
    } else if (b.kind === 'cap') {
      b.ang += b.w * dts;                        // rolling read
      b.rho = Math.min(1.22, b.rho + b.dir * 0.2 * dts * (1 + b.rho));
      b.x = m.x + Math.cos(b.ang) * cp.capA * b.rho;
      b.y = cp.capY + Math.sin(b.ang) * cp.capB * b.rho;
    } else if (b.kind === 'skirt') {
      b.vx *= 1 - 0.55 * dts;
      b.vy -= 8 * dts;                           // curls upward at the end
    } else if (b.kind === 'ember') {
      b.vy *= 1 - 0.3 * dts;
    }
    b.x += b.vx * dts;
    b.y += b.vy * dts;
    b.size += b.grow * dts;
  }
}
function drawMushrooms() {
  for (let mi = 0; mi < LB.mushrooms.length; mi++) {
    const m = LB.mushrooms[mi];
    const cp = mushCapParams(m);
    const globFade = m.t > m.dur - 1.2 ? Math.max(0, (m.dur - m.t) / 1.2) : 1;

    /* --- pass 1 (source-over): cool smoke bodies, oldest first --- */
    ctx.globalCompositeOperation = 'source-over';
    for (let pass = 0; pass < 2; pass++) {
      // pass 0: ash-gray mass; pass 1: cool top highlights
      for (let i = 0; i < m.blobs.length; i++) {
        const b = m.blobs[i];
        if (b.kind === 'ember') continue;
        const k = b.t / b.life;
        const alpha = Math.sin(Math.min(1, k) * Math.PI) * 0.62 * globFade;
        if (alpha <= 0.01) continue;
        const hot = clamp(1 - b.t / 1.4, 0, 1);
        if (pass === 0) {
          // cooling ash: light enough to read against the night sky, darkening with age
          const g = 128 + 62 * (1 - k);
          ctx.globalAlpha = Math.min(1, alpha * (1 - hot * 0.5));
          ctx.fillStyle = 'rgb(' + Math.round(g + hot * 110) + ',' + Math.round(g * 0.94 + hot * 52) + ',' + Math.round(g * 0.92 + hot * 18) + ')';
          ctx.beginPath();
          ctx.arc(b.x, b.y, b.size, 0, Math.PI * 2);
          ctx.fill();
        } else {
          // cool gray highlight rim on the upper edge (light from the dying core)
          ctx.globalAlpha = Math.min(1, alpha * 0.6);
          ctx.fillStyle = 'rgb(206,211,224)';
          ctx.beginPath();
          ctx.arc(b.x - b.size * 0.22, b.y - b.size * 0.26, b.size * 0.62, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    // smoke rings puffing outward (ellipse strokes)
    for (let i = 0; i < m.rings.length; i++) {
      const r = m.rings[i], k = r.t / r.dur;
      ctx.globalAlpha = (1 - k) * r.a * globFade;
      ctx.strokeStyle = 'rgb(214,218,228)';
      ctx.lineWidth = 5 + 9 * (1 - k);
      ctx.beginPath();
      ctx.ellipse(m.x, r.y, 40 + 300 * k, (40 + 300 * k) * 0.32, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    /* --- pass 2 (lighter): fireball, hot cores, embers --- */
    ctx.globalCompositeOperation = 'lighter';
    // the detonation keeps the whole screen lit for a beat (flash decay alone is ~0.1 s)
    if (m.t < 0.55) {
      ctx.globalAlpha = (1 - m.t / 0.55) * 0.85 * globFade;
      ctx.fillStyle = 'rgb(255,247,235)';
      ctx.fillRect(-2000, -1200, 6000, 3600);
    }
    // stage 1: the fireball — blinding white -> orange, flickering
    if (m.t < 1.7) {
      const fk = Math.min(1, m.t / 0.8);
      const fr = 30 + 150 * (1 - Math.pow(1 - fk, 2));
      const sink = m.t > 0.8 ? 1 - (m.t - 0.8) / 0.9 : 1;   // collapses into the stem
      const flick = 0.86 + 0.14 * Math.sin(m.t * 63 + m.seed * 7);
      const ga = globFade * (0.5 + 0.5 * sink);
      ctx.globalAlpha = ga * flick;
      ctx.drawImage(SPR.glow.orange, m.x - fr * 2.1, m.y - fr * 2.1, fr * 4.2, fr * 4.2);
      ctx.globalAlpha = ga * flick;
      ctx.drawImage(SPR.glow.white, m.x - fr * 1.15, m.y - fr * 1.15 - fr * 0.3, fr * 2.3, fr * 2.3);
      ctx.globalAlpha = ga * flick * 0.9;
      ctx.drawImage(SPR.glow.white, m.x - fr * 0.62, m.y - fr * 0.62 - fr * 0.18, fr * 1.24, fr * 1.24);
      ctx.globalAlpha = 1;
    }
    // hot cores of young blobs (incandescent orange -> red)
    for (let i = 0; i < m.blobs.length; i++) {
      const b = m.blobs[i];
      const hot = clamp(1 - b.t / 1.4, 0, 1);
      if (hot <= 0.02) continue;
      const k = b.t / b.life;
      const flick = 0.8 + 0.2 * Math.sin(b.seed * 13 + m.t * 31);
      if (b.kind === 'ember') {
        ctx.globalAlpha = Math.min(1, (1 - k) * 0.9) * globFade;
        ctx.drawImage(SPR.glow.gold, b.x - b.size * 2, b.y - b.size * 2, b.size * 4, b.size * 4);
      } else {
        const s = b.size * (0.9 + hot * 0.7);
        ctx.globalAlpha = clamp(hot * 0.55, 0, 1) * flick * (1 - k * 0.4) * globFade;
        ctx.drawImage(hot > 0.55 ? SPR.glow.orange : SPR.glow.red, b.x - s, b.y - s, s * 2, s * 2);
      }
    }
    // stem hot core column (tapered glow between base and cap while churning)
    if (m.t > 0.55 && m.t < 6.4) {
      const sh = m.y - cp.capY;
      const sg = ctx.createLinearGradient(0, m.y, 0, cp.capY);
      let sa = (m.t < 1.6 ? 0.34 : 0.3 - (m.t - 1.6) * 0.045) * globFade;
      if (m.t > 3) sa *= Math.max(0.35, 1 - (m.t - 3) * 0.28);
      sg.addColorStop(0, 'rgba(255,170,70,' + Math.max(0, sa).toFixed(3) + ')');
      sg.addColorStop(0.75, 'rgba(255,105,45,' + Math.max(0, sa * 0.5).toFixed(3) + ')');
      sg.addColorStop(1, 'rgba(255,70,35,0)');
      ctx.globalAlpha = 1;
      ctx.fillStyle = sg;
      const swB = (78 + 46 * Math.min(1, m.t / 2)) * (1 + 0.06 * Math.sin(m.t * 9 + m.seed));
      const swT = swB * 0.5;
      ctx.beginPath();
      ctx.moveTo(m.x - swB / 2, m.y);
      ctx.lineTo(m.x - swT / 2, cp.capY);
      ctx.lineTo(m.x + swT / 2, cp.capY);
      ctx.lineTo(m.x + swB / 2, m.y);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

/* ---------------- TSUNAMI 🌊 — wall of water from the left edge ---------------- */
function tsunamiSurfaceY(w, x) {
  const k = clamp((w.front - x) / w.width, 0, 1); // 0 at the crest, 1 at the tail
  const env = k < 0.3 ? 1 : 1 - ((k - 0.3) / 0.7) * 0.6;
  return GROUND_Y - w.height * env;
}
function spawnTsunami() {
  const w = { front: -240, width: 480, height: 500, speed: 450, t: 0, phase: Math.random() * 10, on: true };
  LB.tsunamis.push(w);
  LB.audio.splash();
  LB.audio.waterRush(4.2);
  return w;
}
function stepTsunamis(dts) {
  for (let i = LB.tsunamis.length - 1; i >= 0; i--) {
    const w = LB.tsunamis[i];
    w.t += dts;
    w.front += w.speed * dts;
    const left = w.front - w.width;
    if (left > W + 160) { w.on = false; LB.tsunamis.splice(i, 1); continue; }
    const frontBand = Math.max(60, w.width * 0.18);
    let grind = 2; // blocks the wave face may smash per step (FPS + drama cap)
    for (let k = 0; k < LB.bodies.length; k++) {
      const o = LB.bodies[k];
      if (o.isStatic || !o.plugin.lb || o.plugin.lb.removed) continue;
      const lb = o.plugin.lb;
      const bx = o.position.x;
      if (bx < left - 40 || bx > w.front + 40) continue;
      if (o.position.y < tsunamiSurfaceY(w, bx) - 12) continue;
      if (lb.set === 'vehicle') {
        if (lb.state === 'drive') {
          const veh = vehicleByBody(o);
          if (veh) flingVehicle(veh, w.front - 200);
          LB.audio.splash();
        }
        continue;
      }
      if (WEAPON_SETS[lb.set]) continue;
      const depth = Math.min(1, (o.position.y - tsunamiSurfaceY(w, bx)) / w.height + 0.4);
      const frontF = bx >= w.front - frontBand ? 1 : 0.55;
      M.Sleeping.set(o, false);
      M.Body.setVelocity(o, {
        x: Math.min(o.velocity.x + 0.55 * depth * frontF, 12),
        y: o.velocity.y - 0.26 * depth
      });
      // the wave face grinds whatever it hits near the ground
      if (bx >= w.front - frontBand && o.position.y > GROUND_Y - 90 && grind > 0 && Math.random() < 0.22) {
        grind--;
        P.splash(bx, GROUND_Y - 8, 8);
        removeBody(o, {});
      }
    }
    // foam + spray on the crest
    if (stepCounter % 2 === 0) {
      for (let s = 0; s < 3; s++) {
        const fx = w.front - rand(0, w.width * 0.4);
        P.splash(fx, tsunamiSurfaceY(w, fx), 3);
      }
      P.dustPuff(w.front - 30, GROUND_Y - w.height * 0.55, 4, -2, rand(30, 55), 0.25);
    }
    if (LB.audio.throttle('tsun', 240)) LB.audio.splash();
  }
}

/* ---------------- LASER ⚡ — horizontal cutting beam across the screen ---------------- */
const LASER_DUR = 1.5, LASER_SPEED = 1350, LASER_HALF = 7;
function spawnLaser(wx, wy) {
  const fromLeft = !isFinite(wx) || wx < W / 2;
  const y = clamp(isFinite(wy) ? wy : H * 0.45, 40, GROUND_Y - 14);
  const beam = { y: y, dir: fromLeft ? 1 : -1, head: fromLeft ? 0 : W, t: 0, dur: LASER_DUR, on: true, audio: null };
  LB.lasers.push(beam);
  LB.audio.laserHumStart(beam);
  return beam;
}
function stepLasers(dts) {
  for (let i = LB.lasers.length - 1; i >= 0; i--) {
    const bm = LB.lasers[i];
    bm.t += dts;
    bm.head += bm.dir * LASER_SPEED * dts;
    if (bm.t >= bm.dur || (bm.dir > 0 ? bm.head > W + 60 : bm.head < -60)) {
      bm.on = false;
      LB.audio.laserHumStop(bm);
      LB.lasers.splice(i, 1);
      continue;
    }
    const x0 = bm.dir > 0 ? 0 : bm.head;
    const x1 = bm.dir > 0 ? bm.head : W;
    for (let k = 0; k < LB.bodies.length; k++) {
      const o = LB.bodies[k];
      if (o.isStatic || !o.plugin.lb || o.plugin.lb.removed) continue;
      const lb = o.plugin.lb;
      if (WEAPON_SETS[lb.set]) continue;
      const bb = o.bounds;
      if (bb.max.y < bm.y - LASER_HALF || bb.min.y > bm.y + LASER_HALF) continue;
      if (bb.max.x < x0 || bb.min.x > x1) continue;
      M.Sleeping.set(o, false);
      const hx = clamp(o.position.x, x0, x1);
      if (lb.set === 'vehicle') {
        lb.laserDmg = (lb.laserDmg || 0) + 160 * dts;
        if (stepCounter % 2 === 0) P.sparks(hx, bm.y, 3, SPR.glow.cyan, 6);
        if (lb.laserDmg > 60) { const veh = vehicleByBody(o); if (veh) explodeVehicle(veh); }
        continue;
      }
      lb.laserDmg = (lb.laserDmg || 0) + 95 * dts;
      // the beam shoves the cut lightly along its direction
      M.Body.setVelocity(o, { x: o.velocity.x + bm.dir * 0.35, y: o.velocity.y });
      if (stepCounter % 3 === 0) P.sparks(hx, bm.y, 2, SPR.glow.cyan, 5);
      if (lb.laserDmg > 42) {
        removeBody(o, {});
        P.sparks(hx, bm.y, 8, SPR.glow.white, 7);
        LB.audio.sizzle();
      }
    }
    LB.audio.sizzle();
    if (stepCounter % 4 === 0) {
      // travelling tip flare
      P.spawn('spark', bm.head, bm.y, { vx: bm.dir * 2, vy: rand(-1, 1), life: 0.3, size: rand(4, 8), drag: 0.9, spr: SPR.glow.cyan });
    }
  }
}

/* ---------------- ROLLING STONE 🪨 — boulder from the left, crushes traffic ---------------- */
const STONE_R = 105, STONE_SPEED = 14.5, STONE_HP = 300;
function stoneByBody(b) {
  for (let i = 0; i < LB.stones.length; i++) {
    if (LB.stones[i].body === b) return LB.stones[i];
  }
  return null;
}
function spawnStone() {
  const b = M.Bodies.circle(-STONE_R - 40, GROUND_Y - STONE_R - 2, STONE_R, {
    friction: 1.0, frictionStatic: 1, restitution: 0.02,
    density: 0.02, frictionAir: 0.001, sleepThreshold: 400, label: 'stone'
  });
  tag(b, 'stone', 'stone');
  b.plugin.lb.color = '#8d8797';
  b.plugin.lb.stoneHp = STONE_HP;
  // fixed speckle pattern for the painter (stable across frames — no flicker)
  const rng = mulberry32(5150 + LB.stones.length * 977);
  const spots = [];
  for (let k = 0; k < 14; k++) {
    const a = rng() * Math.PI * 2, rr = rng() * STONE_R * 0.72;
    spots.push([Math.cos(a) * rr, Math.sin(a) * rr, 4 + rng() * 9, rng() < 0.5]);
  }
  b.plugin.lb.spots = spots;
  M.Composite.add(world, b);
  const st = { body: b, t: 0, stuck: 0, on: true, audio: null };
  LB.stones.push(st);
  M.Sleeping.set(b, false);
  M.Body.setVelocity(b, { x: STONE_SPEED, y: 0 });
  M.Body.setAngularVelocity(b, STONE_SPEED / STONE_R);
  LB.audio.rumbleStart(st);
  P.dustPuff(30, GROUND_Y - 16, 4, -2, 44, 0.35);
  return st;
}
function breakStone(st) {
  LB.audio.rumbleStop(st);
  st.on = false;
  const i = LB.stones.indexOf(st);
  if (i >= 0) LB.stones.splice(i, 1);
  const b = st.body;
  if (!b.plugin.lb || b.plugin.lb.removed) return;
  const x = b.position.x, y = b.position.y;
  removeBody(b, { silent: true });
  LB.shake = Math.min(LB.shake + 22, 55);
  LB.events.explosions++;
  LB.audio.burst();
  LB.audio.boom(0.7);
  P.debrisBurst(x, y, '#9a94a4', 26);
  P.debrisBurst(x, y - 34, '#7d7787', 18);
  P.smoke(x, y, 14, true);
  for (let k = 0; k < 5; k++) {
    P.dustPuff(x + rand(-60, 60), GROUND_Y - rand(0, 30), rand(-3, 3), -rand(1, 3), rand(30, 60), 0.35);
  }
  P.sparks(x, y, 20, SPR.glow.gold, 6);
}
function stepStones(dts) {
  for (let i = LB.stones.length - 1; i >= 0; i--) {
    const st = LB.stones[i], b = st.body;
    st.t += dts;
    if (!b.plugin.lb || b.plugin.lb.removed ||
        !isFinite(b.position.x) || !isFinite(b.position.y)) {
      breakStone(st);
      continue;
    }
    const sp = Math.abs(b.velocity.x);
    // initial charge: hold the launch speed until it meets real resistance
    if (st.t < 1.6 && sp > 0.5 && sp < STONE_SPEED) {
      M.Body.setVelocity(b, { x: Math.min(sp + 0.3, STONE_SPEED), y: b.velocity.y });
      M.Body.setAngularVelocity(b, b.velocity.x / STONE_R);
    }
    if (sp < 0.6) st.stuck += dts; else st.stuck = 0;
    if (st.stuck > 1.4 || b.position.x > W + 220 || b.position.y > WATER_Y + 30) {
      breakStone(st);
      continue;
    }
    // rumble volume rides the speed
    if (st.audio && st.audio.g) {
      try { st.audio.g.gain.value = clamp(0.08 + sp * 0.02, 0.08, 0.34); } catch (e) {}
    }
    // dust kicked up behind the roll
    if (stepCounter % 2 === 0 && sp > 2) {
      P.dustPuff(b.position.x - sp * 2.2, GROUND_Y - rand(2, 18), -sp * 0.12, -rand(0.5, 2.5), rand(14, 32), 0.3);
    }
  }
}

/* ---------------- VORTEX 🌀 — water whirlpool on the spot, 5 s ---------------- */
const VORTEX_DUR = 5.0;
function spawnVortex(wx) {
  const t = {
    x: clamp(isFinite(wx) ? wx : W / 2, 140, W - 140),
    y: GROUND_Y, t: 0, dur: VORTEX_DUR, phase: Math.random() * 10, on: true, audio: null
  };
  LB.vortices.push(t);
  LB.audio.swirlStart(t);
  LB.audio.splash();
  return t;
}
function stepVortices(dts) {
  for (let i = LB.vortices.length - 1; i >= 0; i--) {
    const v = LB.vortices[i];
    v.t += dts;
    if (v.t > v.dur) {
      v.on = false;
      LB.audio.swirlStop(v);
      LB.vortices.splice(i, 1);
      continue;
    }
    const fade = Math.min(1, v.t * 2.5, (v.dur - v.t) * 1.5);
    for (let k = 0; k < LB.bodies.length; k++) {
      const o = LB.bodies[k];
      if (o.isStatic || !o.plugin.lb || o.plugin.lb.removed) continue;
      const lb = o.plugin.lb;
      const dx = v.x - o.position.x, dy = v.y - o.position.y;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (r > 430 || o.position.y < GROUND_Y - 360) continue;
      if (lb.set === 'vehicle') {
        if (lb.state === 'drive') {
          if (r < 180) { const veh = vehicleByBody(o); if (veh) flingVehicle(veh, v.x); }
          continue;
        }
        // flung vehicles are dragged like free debris (fall through)
      } else if (WEAPON_SETS[lb.set]) continue;
      const d = Math.max(r, 42);
      let acc = 105 / (d * d);
      if (acc > 0.010) acc = 0.010;
      const ux = dx / (r || 1), uy = dy / (r || 1);
      M.Sleeping.set(o, false);
      // pull to the centre + a strong swirl — down it goes
      M.Body.applyForce(o, o.position, {
        x: (ux + -uy * 0.95) * acc * fade * o.mass,
        y: (uy * 0.6 + ux * 0.95) * acc * fade * o.mass
      });
      const bs = Math.max(o.bounds.max.x - o.bounds.min.x, o.bounds.max.y - o.bounds.min.y) * 0.3;
      if (r < 44 + bs) {
        if (lb.set === 'vehicle') {
          const veh = vehicleByBody(o);
          if (veh) explodeVehicle(veh);
        } else {
          removeBody(o, { consume: false });
          P.splash(o.position.x, GROUND_Y - 8, 8);
          LB.events.consumed++;
          LB.audio.consume();
        }
      }
    }
    // spray: water flung up the spiral walls
    if (stepCounter % 2 === 0) {
      const a = Math.random() * Math.PI * 2, rr = rand(40, 150);
      P.spawn('splash', v.x + Math.cos(a) * rr, GROUND_Y - rand(0, 20), {
        vx: -Math.sin(a) * rand(2, 6), vy: -rand(2, 8),
        life: rand(0.4, 0.9), size: rand(2.5, 5), grav: 0.18, drag: 0.97, spr: SPR.glow.cyan, a: 0.8
      });
    }
  }
}

/* ---------------- FIRE 🔥 (old TRIANGEL) — pyre crate -> spreading fire wave ---------------- */
const FIRE_SPREAD = 400, FIRE_DUR = 4.2;
function spawnFire(x) {
  const b = M.Bodies.polygon(x, GROUND_Y - 15, 3, 17, {
    friction: 0.7, frictionStatic: 1, restitution: 0.05,
    density: 0.004, frictionAir: 0.01, sleepThreshold: 60, label: 'firecrate'
  });
  tag(b, 'firecrate', 'firecrate');
  b.plugin.lb.color = '#c2402f';
  M.Composite.add(world, b);
  const f = { x: x, frontL: x, frontR: x, t: 0, dur: FIRE_DUR, state: 'crate', crate: b, on: true };
  LB.fires.push(f);
  return f;
}
function stepFires(dts) {
  for (let i = LB.fires.length - 1; i >= 0; i--) {
    const f = LB.fires[i];
    f.t += dts;
    if (f.state === 'crate') {
      if (stepCounter % 2 === 0 && f.crate && !f.crate.plugin.lb.removed) {
        P.flame(f.crate.position.x + rand(-7, 7), f.crate.position.y - 8, rand(-0.4, 0.4), -rand(1.2, 2.6));
      }
      if (f.t >= 0.45 || !f.crate || f.crate.plugin.lb.removed) {
        f.state = 'wave';
        f.t = 0;
        if (f.crate && !f.crate.plugin.lb.removed) {
          P.embers(f.crate.position.x, f.crate.position.y, 14);
          removeBody(f.crate, { silent: true });
        }
        f.crate = null;
        LB.audio.boomDeep(0.35);
        LB.audio.crackle(10);
      }
      continue;
    }
    f.frontL -= FIRE_SPREAD * dts;
    f.frontR += FIRE_SPREAD * dts;
    if (f.t > f.dur || (f.frontL < -180 && f.frontR > W + 180)) {
      f.on = false;
      LB.fires.splice(i, 1);
      continue;
    }
    for (let k = 0; k < LB.bodies.length; k++) {
      const o = LB.bodies[k];
      if (o.isStatic || !o.plugin.lb || o.plugin.lb.removed) continue;
      const lb = o.plugin.lb;
      if (o.position.y < GROUND_Y - 95) continue;
      if (o.position.x < f.frontL - 30 || o.position.x > f.frontR + 30) continue;
      if (WEAPON_SETS[lb.set]) continue;
      if (lb.set === 'vehicle') {
        if (lb.state !== 'drive') continue;
        lb.fireDmg = (lb.fireDmg || 0) + 110 * dts;
        if (stepCounter % 4 === 0) P.flame(o.position.x + rand(-14, 14), o.position.y - 6, rand(-0.5, 0.5), -rand(1.5, 3));
        if (lb.fireDmg > 55) { const veh = vehicleByBody(o); if (veh) explodeVehicle(veh); }
        continue;
      }
      const wasCold = !lb.fireDmg;
      lb.fireDmg = (lb.fireDmg || 0) + 70 * dts;
      if (wasCold) M.Sleeping.set(o, false); // burned blocks start to sway
      if (stepCounter % 6 === 0) P.flame(o.position.x + rand(-8, 8), o.position.y, rand(-0.3, 0.3), -rand(1, 2.4));
      if (lb.fireDmg > 48) {
        removeBody(o, {});
        P.embers(o.position.x, o.position.y, 8);
      }
    }
    // travelling flame fronts
    if (stepCounter % 2 === 0) {
      P.flame(f.frontL + rand(-12, 12), GROUND_Y - rand(0, 18), rand(-0.7, 0.2), -rand(1.2, 3));
      P.flame(f.frontR + rand(-12, 12), GROUND_Y - rand(0, 18), rand(-0.2, 0.7), -rand(1.2, 3));
      if (Math.random() < 0.6) P.flame(rand(f.frontL, f.frontR), GROUND_Y - rand(0, 14), rand(-0.3, 0.3), -rand(1, 2.2));
    }
    if (LB.audio.throttle('fire', 300)) LB.audio.crackle(2);
  }
}

/* ---------------- per-step weapon forces ---------------- */
function stepWeapons(dt) {
  const dts = dt / 1000;

  // TNT fuses: per-block timers, independent of physics (blocks may sleep)
  for (let i = LB.tnts.length - 1; i >= 0; i--) {
    const t = LB.tnts[i];
    const b = t.body;
    if (!b.plugin.lb || b.plugin.lb.removed ||
        !isFinite(b.position.x) || !isFinite(b.position.y)) {
      // flung out of bounds / swallowed by a black hole / NaN — fuse dies with it
      LB.audio.fuseStop(t);
      LB.tnts.splice(i, 1);
      continue;
    }
    t.t += dts;
    // fuse sparks from the block's (rotated) top centre
    if (stepCounter % 2 === 0) {
      const topOff = t.ben ? TNT_SIZE * 1.5 : TNT_SIZE / 2;
      const px = b.position.x + topOff * Math.sin(b.angle);
      const py = b.position.y - topOff * Math.cos(b.angle);
      P.spawn('spark', px + rand(-3, 3), py, {
        vx: rand(-0.8, 0.8), vy: rand(-2.2, -0.6), life: rand(0.2, 0.5),
        size: rand(2, 4.5), drag: 0.94, grav: 0.06,
        spr: Math.random() < 0.7 ? SPR.glow.gold : SPR.glow.white
      });
    }
    if (t.t >= t.dur) {
      LB.tnts.splice(i, 1);
      explodeTNT(t);
    }
  }

  // meteors: trail + fuse
  for (let i = LB.meteors.length - 1; i >= 0; i--) {
    const b = LB.meteors[i], lb = b.plugin.lb;
    lb.steps++;
    const v = b.velocity;
    for (let k = 0; k < 4; k++) {
      P.flame(b.position.x + rand(-8, 8) - v.x * 0.1, b.position.y + rand(-8, 8) - v.y * 0.1,
        -v.x * 0.06 + rand(-0.4, 0.4), -v.y * 0.06 + rand(-0.4, 0.4));
    }
    if (lb.steps % 2 === 0) P.spawn('smoke', b.position.x, b.position.y, { vx: rand(-0.3, 0.3), vy: rand(-0.5, 0), life: rand(0.8, 1.6), size: rand(10, 18), grow: 12, a: 0.3 });
    if (lb.steps > 140 || b.position.y > WATER_Y + 10) explodeMeteor(b);
  }

  // black holes
  for (let i = LB.holes.length - 1; i >= 0; i--) {
    const h = LB.holes[i];
    h.t += dts;
    if (h.t > h.dur) {
      h.on = false;
      // release blast
      LB.flash = Math.min(LB.flash + 0.25, 1);
      P.ring(h.x, h.y, 9, 3, 'rgba(170,120,255,0.8)');
      LB.audio.release();
      for (let k = 0; k < LB.bodies.length; k++) {
        const o = LB.bodies[k];
        if (o.isStatic || !o.plugin.lb || o.plugin.lb.removed) continue;
        const d = dist(o.position.x, o.position.y, h.x, h.y);
        if (d < 260) {
          const f = (1 - d / 260) * 14;
          const ux = (o.position.x - h.x) / (d || 1), uy = (o.position.y - h.y) / (d || 1);
          M.Sleeping.set(o, false);
          M.Body.setVelocity(o, { x: o.velocity.x + ux * f, y: o.velocity.y + uy * f });
        }
      }
      LB.holes.splice(i, 1);
      continue;
    }
    // purple dust spiral
    if (Math.random() < 0.7) {
      const a = Math.random() * Math.PI * 2, r = rand(90, 240);
      const p = P.spawn('dust', h.x + Math.cos(a) * r, h.y + Math.sin(a) * r, {
        vx: 0, vy: 0, life: rand(0.6, 1.4), size: rand(6, 14), spr: SPR.glow.purple, a: 0.5
      });
      p.hole = h;
    }
    for (let k = 0; k < LB.bodies.length; k++) {
      const o = LB.bodies[k];
      if (o.isStatic || !o.plugin.lb || o.plugin.lb.removed) continue;
      const dx = h.x - o.position.x, dy = h.y - o.position.y;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (r > 640) continue;
      if (o.plugin.lb.set === 'vehicle') {
        // BLACK HOLE rule: traffic is flung free (engine dies), never eaten
        if (r < 130) { const veh = vehicleByBody(o); if (veh) flingVehicle(veh, h.x); }
        continue;
      }
      const d = Math.max(r, 46);
      let acc = 90 / (d * d);
      if (acc > 0.008) acc = 0.008;
      const ux = dx / (r || 1), uy = dy / (r || 1);
      M.Sleeping.set(o, false);
      M.Body.applyForce(o, o.position, {
        x: (ux + -uy * 0.8) * acc * o.mass,
        y: (uy + ux * 0.8) * acc * o.mass
      });
      const bs = Math.max(o.bounds.max.x - o.bounds.min.x, o.bounds.max.y - o.bounds.min.y) * 0.3;
      if (r < 44 + bs) {
        removeBody(o, { consume: true });
        h.consumed++;
        LB.events.consumed++;
        LB.audio.consume();
      }
    }
    // the singularity swallows any constraint whose cable crosses its core
    for (let ci = LB.constraints.length - 1; ci >= 0; ci--) {
      const c = LB.constraints[ci];
      const ax = c.bodyA ? c.bodyA.position.x + c.pointA.x : c.pointA.x;
      const ay = c.bodyA ? c.bodyA.position.y + c.pointA.y : c.pointA.y;
      const bx = c.bodyB ? c.bodyB.position.x + c.pointB.x : c.pointB.x;
      const by = c.bodyB ? c.bodyB.position.y + c.pointB.y : c.pointB.y;
      if (dist((ax + bx) / 2, (ay + by) / 2, h.x, h.y) < 62) {
        M.Composite.remove(world, c);
        LB.constraints.splice(ci, 1);
        LB.events.brokenConstraints++;
        P.sparkle((ax + bx) / 2, (ay + by) / 2, 4);
      }
    }
  }

  // tornadoes
  for (let i = LB.tornados.length - 1; i >= 0; i--) {
    const t = LB.tornados[i];
    t.t += dts;
    t.x += Math.sin(t.t * 0.55 + t.phase) * 1.5;
    if (t.t > t.dur) {
      t.on = false;
      LB.audio.rumbleStop(t);
      LB.tornados.splice(i, 1);
      continue;
    }
    for (let k = 0; k < LB.bodies.length; k++) {
      const o = LB.bodies[k];
      if (o.isStatic || !o.plugin.lb || o.plugin.lb.removed) continue;
      const dx = o.position.x - t.x;
      const hgt = clamp(GROUND_Y - o.position.y, 0, 540);
      const R = 55 + hgt * 0.52;
      const ad = Math.abs(dx);
      if (ad > R * 1.9 || o.position.y < GROUND_Y - 560) continue;
      if (o.plugin.lb.set === 'vehicle') {
        // TORNADO rule: traffic caught in the funnel is flung free (engine dies)
        if (ad < R * 0.95) { const veh = vehicleByBody(o); if (veh) flingVehicle(veh, t.x); }
        continue;
      }
      const fall = 1 - ad / (R * 1.9);
      const sgn = dx >= 0 ? 1 : -1;
      M.Sleeping.set(o, false);
      const wob = Math.sin(o.position.y * 0.05 + t.t * 4) * 0.0009;
      M.Body.applyForce(o, o.position, {
        x: (-sgn * 0.0008 + wob) * fall * o.mass,
        y: -0.0032 * fall * o.mass
      });
    }
    // the vortex shreds light constraints (pod hangers, rim pins) inside the funnel
    for (let ci = LB.constraints.length - 1; ci >= 0; ci--) {
      const c = LB.constraints[ci];
      const mx = ((c.bodyA ? c.bodyA.position.x + c.pointA.x : c.pointA.x) +
                  (c.bodyB ? c.bodyB.position.x + c.pointB.x : c.pointB.x)) / 2;
      const my = ((c.bodyA ? c.bodyA.position.y + c.pointA.y : c.pointA.y) +
                  (c.bodyB ? c.bodyB.position.y + c.pointB.y : c.pointB.y)) / 2;
      if (my > GROUND_Y + 10 || my < GROUND_Y - 560) continue;
      const hgt = clamp(GROUND_Y - my, 0, 540);
      const Rf = (55 + hgt * 0.52) * 0.95;
      if (Math.abs(mx - t.x) < Rf && Math.random() < 0.12) {
        M.Composite.remove(world, c);
        LB.constraints.splice(ci, 1);
        LB.events.brokenConstraints++;
        P.sparks(mx, my, 4, SPR.glow.cyan, 4);
        LB.audio.snap();
      }
    }
    // ground dust
    if (Math.random() < 0.6) {
      const a = Math.random() * Math.PI * 2, r = rand(10, 60);
      P.dustPuff(t.x + Math.cos(a) * r, GROUND_Y - rand(0, 30), Math.cos(a) * 1.5, -rand(2, 6), rand(20, 40), 0.25);
    }
  }

  /* ---------------- v3 arsenal ---------------- */
  // bombs: fuse + sizzle sparks at the (rotated) fuse tip
  for (let i = LB.bombs.length - 1; i >= 0; i--) {
    const t = LB.bombs[i], b = t.body;
    if (!b.plugin.lb || b.plugin.lb.removed ||
        !isFinite(b.position.x) || !isFinite(b.position.y)) {
      LB.audio.fuseStop(t);
      LB.bombs.splice(i, 1);
      continue;
    }
    t.t += dts;
    if (stepCounter % 2 === 0) {
      const tipX = 12, tipY = -BOMB_R - 10;
      const px = b.position.x + tipX * Math.cos(b.angle) - tipY * Math.sin(b.angle);
      const py = b.position.y + tipX * Math.sin(b.angle) + tipY * Math.cos(b.angle);
      P.spawn('spark', px, py, {
        vx: rand(-0.8, 0.8), vy: rand(-2.4, -0.8), life: rand(0.2, 0.5),
        size: rand(2, 4.5), drag: 0.94, grav: 0.06,
        spr: Math.random() < 0.7 ? SPR.glow.gold : SPR.glow.white
      });
    }
    if (t.t >= t.dur) {
      LB.bombs.splice(i, 1);
      explodeBomb(t);
    }
  }
  // novas charging: gathering smoke + sparkles
  for (let i = LB.novas.length - 1; i >= 0; i--) {
    const t = LB.novas[i], b = t.body;
    if (!b.plugin.lb || b.plugin.lb.removed || !isFinite(b.position.x)) {
      t.on = false;
      LB.novas.splice(i, 1);
      continue;
    }
    t.t += dts;
    if (stepCounter % 3 === 0) {
      P.spawn('smoke', b.position.x + rand(-16, 16), b.position.y + rand(-12, 10), {
        vx: rand(-0.4, 0.4), vy: rand(-1.2, -0.3), life: rand(1.2, 2.4), size: rand(10, 20), grow: 10, a: 0.3
      });
    }
    if (stepCounter % 2 === 0) {
      P.crackleSpark(b.position.x + rand(-30, 30), b.position.y + rand(-30, 30),
        Math.random() < 0.5 ? SPR.glow.gold : SPR.glow.white);
    }
    if (t.t >= t.dur) {
      LB.novas.splice(i, 1);
      explodeNova(t);
    }
  }
  // nova shockwave rings (visual only)
  for (let i = LB.novaRings.length - 1; i >= 0; i--) {
    const r = LB.novaRings[i];
    r.t += dts;
    if (r.t > r.dur) LB.novaRings.splice(i, 1);
  }
  // nukes: siren fuse
  for (let i = LB.nukes.length - 1; i >= 0; i--) {
    const t = LB.nukes[i], b = t.body;
    if (!b.plugin.lb || b.plugin.lb.removed ||
        !isFinite(b.position.x) || !isFinite(b.position.y)) {
      t.on = false;
      LB.nukes.splice(i, 1);
      continue;
    }
    t.t += dts;
    if (stepCounter % 4 === 0) P.sparks(b.position.x, b.position.y - NUKE_SIZE / 2, 1, SPR.glow.red, 3);
    if (t.t >= t.dur) {
      LB.nukes.splice(i, 1);
      explodeNuke(t);
    }
  }
  // v3.1: the vaporization front eats the skyline
  stepNukeWaves(dts);
  // mushroom visuals: multi-stage animated cloud (v3.1)
  for (let i = LB.mushrooms.length - 1; i >= 0; i--) {
    const m = LB.mushrooms[i];
    stepMushroom(m, dts);
    if (m.t > m.dur) LB.mushrooms.splice(i, 1);
  }
  stepTsunamis(dts);
  stepLasers(dts);
  stepStones(dts);
  stepVortices(dts);
  stepFires(dts);
}

/* ---------------- Eye idle rotation + constraint stress ---------------- */
function stepEye(dt) {
  const E = LB.eye;
  if (!E.hub) return;
  const hub = E.hub.position;

  // spin tracking (degrees turned by rim, for __TEST__)
  if (E.rim.length && !E.rim[0].plugin.lb.removed) {
    const s0 = E.rim[0];
    const ang = Math.atan2(s0.position.y - hub.y, s0.position.x - hub.x);
    if (E.prevAng !== undefined) {
      let d = ang - E.prevAng;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      E.spin += (d * 180) / Math.PI;
    }
    E.prevAng = ang;
  }

  if (E.drive && integrityOf('eye') > 0.9) {
    // wheel-speed-gated motor: average tangential speed of the rim caps rotation
    // (per-segment gating let constraint jitter pump the wheel up to 6x target)
    let sumSp = 0, cnt = 0;
    for (let i = 0; i < E.rim.length; i++) {
      const s = E.rim[i];
      if (s.plugin.lb.removed) continue;
      const rx = s.position.x - hub.x, ry = s.position.y - hub.y;
      const rlen = Math.max(Math.sqrt(rx * rx + ry * ry), 1);
      sumSp += (s.velocity.x * (-ry / rlen)) + (s.velocity.y * (rx / rlen));
      cnt++;
    }
    if (cnt && sumSp / cnt < 0.36) {
      for (let i = 0; i < E.rim.length; i++) {
        const s = E.rim[i];
        if (s.plugin.lb.removed) continue;
        const rx = s.position.x - hub.x, ry = s.position.y - hub.y;
        const rlen = Math.max(Math.sqrt(rx * rx + ry * ry), 1);
        const tx = -ry / rlen, ty = rx / rlen;
        // sleeping bodies ignore forces — wake the wheel so the motor can turn it
        M.Sleeping.set(s, false);
        M.Body.applyForce(s, s.position, { x: tx * s.mass * 3.4e-5, y: ty * s.mass * 3.4e-5 });
      }
      for (let i = 0; i < E.pods.length; i++) {
        const p = E.pods[i];
        if (!p.plugin.lb.removed && p.isSleeping) M.Sleeping.set(p, false);
      }
    }
  }

  // constraint stress breakage
  for (let i = LB.constraints.length - 1; i >= 0; i--) {
    const c = LB.constraints[i];
    const ax = c.bodyA ? c.bodyA.position.x + c.pointA.x : c.pointA.x;
    const ay = c.bodyA ? c.bodyA.position.y + c.pointA.y : c.pointA.y;
    const bx = c.bodyB ? c.bodyB.position.x + c.pointB.x : c.pointB.x;
    const by = c.bodyB ? c.bodyB.position.y + c.pointB.y : c.pointB.y;
    const d = dist(ax, ay, bx, by);
    const over = d - c.length;
    // break only on real overstretch — pin networks live under mild compression
    if (over > Math.max(35, c.length * 0.35)) {
      M.Composite.remove(world, c);
      LB.constraints.splice(i, 1);
      LB.events.brokenConstraints++;
      P.sparks((ax + bx) / 2, (ay + by) / 2, 5, SPR.glow.cyan, 5);
      LB.audio.snap();
    }
  }
}

/* ---------------- water, bounds, NaN guards ---------------- */
function stepGuards() {
  for (let k = LB.bodies.length - 1; k >= 0; k--) {
    const o = LB.bodies[k];
    const lb = o.plugin.lb;
    if (!isFinite(o.position.x) || !isFinite(o.position.y) || !isFinite(o.velocity.x) || !isFinite(o.velocity.y)) {
      removeBody(o, { silent: true });
      continue;
    }
    if (lb && lb.removed) continue;
    if (!o.isStatic) {
      const sp = Math.sqrt(o.velocity.x * o.velocity.x + o.velocity.y * o.velocity.y);
      if (sp > 90) M.Body.setVelocity(o, { x: o.velocity.x * (90 / sp), y: o.velocity.y * (90 / sp) });
      // despawn far gone debris
      if (o.position.y > H + 260 || o.position.x < -800 || o.position.x > W + 800) {
        removeBody(o, { silent: true });
        continue;
      }
      // Thames buoyancy
      if (o.position.y > WATER_Y + 4) {
        if (!o.plugin.wet) {
          o.plugin.wet = true;
          if (o.plugin.lb && o.plugin.lb.set !== 'meteor') {
            P.splash(o.position.x, WATER_Y, 10);
            LB.audio.splash();
            LB.events.splashes++;
          }
        }
        M.Body.applyForce(o, o.position, { x: 0, y: -0.00075 * o.mass });
        M.Body.setVelocity(o, { x: o.velocity.x * 0.94, y: o.velocity.y * 0.9 });
        M.Body.setAngularVelocity(o, o.angularVelocity * 0.95);
      } else if (o.plugin.wet && o.position.y < WATER_Y - 12) {
        o.plugin.wet = false;
      }
    }
  }
  // flag mast: upright with nothing solid under its base -> give it the initial
  // tip real asymmetry would provide; physics tumbles it from there. (A pole
  // this thin falls straight through a neat hole otherwise and stays upright.)
  if (LB.flag && LB.flag.body && stepCounter % 4 === 0) {
    const pb = LB.flag.body, plb = pb.plugin.lb;
    if (!plb.removed && Math.abs(pb.angle) < 0.5) {
      let supported = false;
      for (let i = 0; i < LB.bodies.length; i++) {
        const rb = LB.bodies[i], rlb = rb.plugin.lb;
        if (!rlb || rlb.removed || rb === pb) continue;
        const dy = rb.position.y - pb.position.y;
        if (dy > 4 && dy < 45 && Math.abs(rb.position.x - pb.position.x) < 8) { supported = true; break; }
      }
      if (!supported) {
        M.Sleeping.set(pb, false);
        M.Body.setAngularVelocity(pb, (Math.random() < 0.5 ? -1 : 1) * rand(0.18, 0.3));
        M.Body.setVelocity(pb, { x: pb.velocity.x + rand(-0.6, 0.6), y: pb.velocity.y });
      }
    }
  }
  // meteors falling into water explode
  for (let i = LB.meteors.length - 1; i >= 0; i--) {
    if (LB.meteors[i].position.y > WATER_Y) explodeMeteor(LB.meteors[i]);
  }
}

/* ---------------- collision juice ---------------- */
M.Events.on(engine, 'collisionStart', function (ev) {
  for (let i = 0; i < ev.pairs.length; i++) {
    const pr = ev.pairs[i];
    const A = pr.bodyA, B = pr.bodyB;
    const la = A.plugin.lb, lbb = B.plugin.lb;
    if ((la && la.set === 'meteor')) { explodeMeteor(A); continue; }
    if ((lbb && lbb.set === 'meteor')) { explodeMeteor(B); continue; }
    // flung vehicles explode when they slam into anything hard
    const vLb = (la && la.set === 'vehicle') ? la : (lbb && lbb.set === 'vehicle' ? lbb : null);
    if (vLb && vLb.state === 'flung') {
      const rvv = Math.sqrt((A.velocity.x - B.velocity.x) ** 2 + (A.velocity.y - B.velocity.y) ** 2);
      if (rvv > 6.5) {
        const veh = vehicleByBody(vLb === la ? A : B);
        if (veh) { explodeVehicle(veh); continue; }
      }
    }
    // ROLLING STONE: crushes any vehicle it touches, loses armor grinding masonry
    const stLb = (la && la.set === 'stone') ? la : (lbb && lbb.set === 'stone' ? lbb : null);
    if (stLb) {
      const stBody = stLb === la ? A : B;
      const other = stLb === la ? B : A;
      const st = stoneByBody(stBody);
      if (st) {
        const oLb = other.plugin.lb;
        if (oLb && oLb.set === 'vehicle') {
          const veh = vehicleByBody(other);
          if (veh) explodeVehicle(veh);
          stBody.plugin.lb.stoneHp -= 8;
          LB.shake = Math.min(LB.shake + 6, 55);
        } else if (oLb && (oLb.set === 'tower' || oLb.set === 'annex' || oLb.set === 'eye')) {
          stBody.plugin.lb.stoneHp -= 3;
        } else {
          stBody.plugin.lb.stoneHp -= 1;
        }
        if (stBody.plugin.lb.stoneHp <= 0) breakStone(st);
      }
    }
    const rv = Math.sqrt((A.velocity.x - B.velocity.x) ** 2 + (A.velocity.y - B.velocity.y) ** 2);
    if (rv > 8 && ((la && la.set !== 'ground') || (lbb && lbb.set !== 'ground'))) {
      const cx = (A.position.x + B.position.x) / 2, cy = (A.position.y + B.position.y) / 2;
      P.dustPuff(cx, cy, 0, -0.5, 16, 0.22);
      if (rv > 14) P.sparks(cx, cy, 4, SPR.glow.gold, 4);
      LB.audio.thunk();
    }
  }
});

/* ============================================================
   INTEGRITY + FINALE + FIREWORKS
   ============================================================ */
LB.finale = null;
LB.fireworksTimer = 0;
let finaleCheck = 0;

function topIntegrity() {
  // the "bells zone": clock stage + everything above it
  const T = LB.tower.topBodies;
  if (!T.length) return 1;
  let n = 0;
  for (let i = 0; i < T.length; i++) {
    const lb = T[i].plugin.lb;
    if (!lb.removed && dist(T[i].position.x, T[i].position.y, lb.ox, lb.oy) < 55) n++;
  }
  return n / T.length;
}

function launchRocket() {
  const left = Math.random() < 0.5;
  LB.rockets.push({
    x: left ? rand(60, 340) : rand(1260, 1540),
    y: 796,
    vx: rand(-0.8, 0.8),
    vy: -rand(7.5, 10.5),
    spr: [SPR.glow.gold, SPR.glow.pink, SPR.glow.cyan, SPR.glow.green, SPR.glow.violet, SPR.glow.red][(Math.random() * 6) | 0],
    t: 0
  });
  LB.audio.launch();
}

function stepFinale(dt) {
  const dts = dt / 1000;

  // periodic integrity check
  finaleCheck += dt;
  if (finaleCheck > 330) {
    finaleCheck = 0;
    if (LB.phase === 'play') {
      const tI = integrityOf('tower'), eI = integrityOf('eye');
      // F3: after KEEP PLAYING the world stays broken — no new finale
      if (!LB.continueMode && tI < 0.45 && eI < 0.45) startFinale();
      else if (LB.eye.drive && eI < 0.9) { LB.eye.drive = false; }
      // F5: the bells break when the clock stage / belfry is destroyed (once per collapse)
      if (!LB.audio.brokenPlayed && topIntegrity() < 0.5) {
        LB.events.brokenBell++;
        LB.audio.brokenBell();
      }
    }
  }

  // F3: celebratory fireworks every few seconds while keep-playing
  if (LB.continueMode && LB.phase === 'play') {
    LB.fireworksTimer -= dts;
    if (LB.fireworksTimer <= 0) {
      LB.fireworksTimer = rand(3.2, 6.5);
      const n = 1 + (Math.random() * 3 | 0);
      for (let i = 0; i < n; i++) launchRocket();
    }
  }

  // rocket flight + burst — runs in the finale AND in keep-playing mode
  for (let i = LB.rockets.length - 1; i >= 0; i--) {
    const rk = LB.rockets[i];
    rk.t += dts;
    rk.vy += 0.09;
    rk.x += rk.vx; rk.y += rk.vy;
    P.spawn('spark', rk.x, rk.y, { vx: rand(-0.5, 0.5), vy: rand(0.5, 1.5), life: rand(0.25, 0.55), size: rand(2.5, 5), drag: 0.95, spr: rk.spr });
    if (rk.vy > -1.4) {
      // BURST
      const n = 70 + (Math.random() * 45 | 0);
      for (let k2 = 0; k2 < n; k2++) {
        const a = Math.random() * Math.PI * 2, v = rand(0.8, 6.8);
        P.spawn('spark', rk.x, rk.y, { vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rand(0.9, 1.9), size: rand(3, 7), drag: 0.955, grav: 0.045, spr: rk.spr });
      }
      for (let k2 = 0; k2 < 16; k2++) P.crackleSpark(rk.x, rk.y, rk.spr);
      P.ring(rk.x, rk.y, 7, 2, 'rgba(255,255,255,0.5)');
      LB.flash = Math.min(LB.flash + 0.12, 1);
      LB.shake = Math.min(LB.shake + 3, 30);
      LB.audio.burst();
      LB.events.fireworks++;
      LB.rockets.splice(i, 1);
    }
  }

  const F = LB.finale;
  if (!F) return;
  F.t += dts;
  if (F.t > 2.4 && !F.shown) {
    F.shown = true;
    const winEl = document.getElementById('win');
    if (winEl) winEl.classList.remove('hidden');
  }
  if (F.t > F.next && F.rockets < 34) {
    F.next = F.t + rand(0.14, 0.34);
    launchRocket();
    F.rockets++;
  }
}

function startFinale() {
  if (LB.phase === 'finale') return;
  LB.phase = 'finale';
  LB.finale = { t: 0, next: 0.2, shown: false, rockets: 0 };
  LB.audio.fanfare();
  LB.audio.crackle(24);
  syncNewGameBtn();
}

/* F3: KEEP PLAYING — back to the broken world, traffic + fireworks keep going */
function keepPlaying() {
  if (LB.phase !== 'finale') return;
  LB.continueMode = true;
  LB.finale = null;
  LB.phase = 'play';
  LB.fireworksTimer = 1.2;
  const winEl = document.getElementById('win');
  if (winEl) winEl.classList.add('hidden');
  syncNewGameBtn();
}

/* v3 wave 2: 🔄 NEW GAME — full fresh world from inside KEEP PLAYING mode.
   Identical end-state to PLAY AGAIN: resetWorld() rebuilds everything,
   re-arms the finale, zeroes every counter and clears continueMode. */
function newGame() {
  if (!LB.continueMode) return false;
  LB.audio.init(); LB.audio.resume();
  LB.audio.click();
  resetWorld();
  return true;
}

function syncNewGameBtn() {
  const el = document.getElementById('newGameBtn');
  if (!el) return;
  // visible ONLY while keep-playing is live: hidden on title, in normal play,
  // during the finale, while the weapon picker is open, and after any reset
  const show = LB.continueMode && LB.phase === 'play' && !LB.paused;
  el.classList.toggle('hidden', !show);
}

function destroyAll() {
  LB.events.destroyedAll++;
  const sets = ['tower', 'eye', 'annex'];   // annex joins the wreck (win math unchanged)
  for (let s = 0; s < sets.length; s++) {
    const victims = [];
    for (let k = 0; k < LB.bodies.length; k++) {
      const lb = LB.bodies[k].plugin.lb;
      if (lb && lb.set === sets[s] && !lb.removed) victims.push(LB.bodies[k]);
    }
    // shuffle
    for (let k = victims.length - 1; k > 0; k--) {
      const j = (Math.random() * (k + 1)) | 0;
      const tmp = victims[k]; victims[k] = victims[j]; victims[j] = tmp;
    }
    const kill = Math.floor(victims.length * 0.72);
    for (let k = 0; k < kill; k++) removeBody(victims[k], { silent: k % 3 !== 0 });
    for (let k = kill; k < victims.length; k++) {
      const o = victims[k];
      M.Sleeping.set(o, false);
      M.Body.setVelocity(o, { x: rand(-22, 22), y: rand(-26, -4) });
      M.Body.setAngularVelocity(o, rand(-0.4, 0.4));
    }
  }
  LB.shake = Math.min(LB.shake + 30, 55);
  LB.audio.boom(1);
}

function resetWorld() {
  clearAllEffects();   // stops every weapon loop (fuses, rumbles, hums, swirls)
  M.Composite.clear(world, false, true);
  LB.constraints = [];
  LB.meteors = []; LB.holes = []; LB.tornados = []; LB.rockets = [];
  LB.tnts = [];
  LB.bombs = []; LB.novas = []; LB.novaRings = []; LB.nukes = []; LB.nukeWaves = []; LB.mushrooms = [];
  LB.tsunamis = []; LB.lasers = []; LB.stones = []; LB.vortices = []; LB.fires = [];
  LB.decals = [];
  LB.tower.bodies = []; LB.tower.clockBodies = []; LB.tower.lanternBodies = [];
  LB.tower.topBodies = []; LB.tower.total = 0;
  LB.annex.bodies = []; LB.annex.total = 0; LB.flag = null; LB.flagCanvas = null;
  LB.eye.rim = []; LB.eye.rimIn = []; LB.eye.pods = []; LB.eye.hub = null;
  LB.eye.drive = true; LB.eye.led = 1; LB.eye.prevAng = undefined;
  LB.finale = null;
  LB.continueMode = false;               // F3: fresh world, finale armed again
  LB.fireworksTimer = 0;
  LB.traffic.vehicles = [];              // F2: traffic rebuilt below
  LB.traffic.counts = { onScreen: 0, exploded: 0, flung: 0 };
  LB.traffic.spawnTimer = 1.0;
  LB.audio.bellReset();                  // F5: bells rearmed
  LB.audio.brokenPlayed = false;
  LB.shake = 0; LB.flash = 0;
  LB.weaponFired.meteor = 0; LB.weaponFired.blackhole = 0; LB.weaponFired.tornado = 0;
  LB.weaponFired.tnt = 0; LB.weaponFired.bomb = 0; LB.weaponFired.tnt_ben = 0;
  LB.weaponFired.nova = 0; LB.weaponFired.nuke = 0; LB.weaponFired.tsunami = 0;
  LB.weaponFired.laser = 0; LB.weaponFired.stone = 0; LB.weaponFired.vortex = 0;
  LB.weaponFired.fire = 0;
  LB.events.explosions = 0; LB.events.consumed = 0; LB.events.fireworks = 0;
  LB.events.brokenConstraints = 0; LB.events.shakes = 0; LB.events.splashes = 0;
  LB.events.tntPlaced = 0; LB.events.tntExploded = 0;
  LB.events.vehiclesExploded = 0; LB.events.vehiclesFlung = 0; LB.events.brokenBell = 0;
  P.clear();
  const winEl = document.getElementById('win');
  if (winEl) winEl.classList.add('hidden');
  addGround();
  buildTower();
  buildAnnex();
  buildEye();
  warmup(300);
  P.clear(); // drop any dust spawned by warm-up collisions
  spawnVehicle();
  spawnVehicle();
  LB.bodies = M.Composite.allBodies(world);
  LB.events.resets++;
  LB.phase = 'play';
  syncNewGameBtn();                        // v3 wave 2: NEW GAME button only lives in continueMode
}

function warmup(n) {
  // full fixed steps — matches the live loop timestep exactly (no delta-change jolt)
  const savedPhase = LB.phase;
  for (let i = 0; i < n; i++) M.Engine.update(engine, STEP);
  LB.phase = savedPhase;
}

/* ============================================================
   INPUT + UI
   ============================================================ */
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let cw = 0, ch = 0, dpr = 1, vs = 1, offX = 0, offY = 0, vignette = null;
LB.pointer = { x: W / 2, y: H / 2, active: false, type: 'mouse' };

function resize() {
  cw = window.innerWidth; ch = window.innerHeight;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
  canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
  vs = Math.min(cw / W, ch / H);
  offX = (cw - W * vs) / 2; offY = (ch - H * vs) / 2;
  vignette = null;
}
window.addEventListener('resize', resize);
resize();

function screenToWorld(cx2, cy2) { return { x: (cx2 - offX) / vs, y: (cy2 - offY) / vs }; }
LB.screenToWorld = screenToWorld;

canvas.addEventListener('pointerdown', function (e) {
  e.preventDefault();
  LB.audio.init(); LB.audio.resume();
  LB.pointer.x = e.clientX; LB.pointer.y = e.clientY; LB.pointer.active = true; LB.pointer.type = e.pointerType;
  if (LB.phase === 'title') return;
  const w = screenToWorld(e.clientX, e.clientY);
  const fired = fire(LB.weapon, w.x, w.y);
  if (fired) hideHintSoon();
});
canvas.addEventListener('pointermove', function (e) {
  LB.pointer.x = e.clientX; LB.pointer.y = e.clientY; LB.pointer.active = true; LB.pointer.type = e.pointerType;
});
canvas.addEventListener('pointerleave', function () { LB.pointer.active = false; });
canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

let hintHidden = false, hintShots = 0;
function hideHintSoon() {
  if (hintHidden) return;
  if (++hintShots >= 5) {
    hintHidden = true;
    const el = document.getElementById('hint');
    if (el) el.classList.add('fade');
  }
}

const WEAPONS = ['meteor', 'blackhole', 'tornado', 'tnt', 'bomb', 'tnt_ben', 'nova', 'nuke', 'tsunami', 'laser', 'stone', 'vortex', 'fire'];
const WEAPON_META = {
  meteor: { emo: '☄️', label: 'METEOR', col: 'rgba(255,170,80,0.95)' },
  blackhole: { emo: '🕳️', label: 'BLACK HOLE', col: 'rgba(180,130,255,0.95)' },
  tornado: { emo: '🌪️', label: 'TORNADO', col: 'rgba(120,220,255,0.95)' },
  tnt: { emo: '🧨', label: 'TNT', col: 'rgba(255,110,80,0.95)' },
  bomb: { emo: '💣', label: 'BOMB', col: 'rgba(210,210,225,0.95)' },
  tnt_ben: { emo: '🧱', label: 'TNT BEN', col: 'rgba(255,120,90,0.95)' },
  nova: { emo: '🌟', label: 'NOVA', col: 'rgba(255,230,120,0.95)' },
  nuke: { emo: '☢️', label: 'NUKE', col: 'rgba(255,220,60,0.95)' },
  tsunami: { emo: '🌊', label: 'TSUNAMI', col: 'rgba(90,190,255,0.95)' },
  laser: { emo: '⚡', label: 'LASER', col: 'rgba(120,255,220,0.95)' },
  stone: { emo: '🪨', label: 'STONE', col: 'rgba(190,180,200,0.95)' },
  vortex: { emo: '🌀', label: 'VORTEX', col: 'rgba(110,220,255,0.95)' },
  fire: { emo: '🔥', label: 'FIRE', col: 'rgba(255,150,70,0.95)' }
};
function selectWeapon(w) {
  if (WEAPON_META[w]) LB.weapon = w;
  const btns = document.querySelectorAll('.wbtn');
  for (let i = 0; i < btns.length; i++) {
    btns[i].classList.toggle('active', btns[i].getAttribute('data-w') === LB.weapon);
  }
  const meta = WEAPON_META[LB.weapon];
  const emo = document.querySelector('#curWeapon .emo');
  const lbl = document.querySelector('#curWeapon .lbl');
  if (meta && emo) emo.textContent = meta.emo;
  if (meta && lbl) lbl.textContent = meta.label;
}

/* ---- weapon picker: full-screen grid; the whole sim (and its audio)
   pauses while it is open, so the kid can choose calmly ---- */
const pickerEl = document.getElementById('picker');
function openPicker() {
  if (LB.phase !== 'play' || LB.paused) return false;
  selectWeapon(LB.weapon); // sync active-card highlight even before the first selection
  LB.paused = true;
  if (pickerEl) pickerEl.classList.remove('hidden');
  if (LB.audio.ctx && LB.audio.ctx.state === 'running') {
    LB.audio.ctx.suspend().catch(function () {});
  }
  LB.audio.pop();
  syncNewGameBtn();
  return true;
}
function closePicker() {
  if (!LB.paused) return false;
  LB.paused = false;
  if (pickerEl) pickerEl.classList.add('hidden');
  if (LB.audio.ctx && LB.audio.ctx.state === 'suspended') {
    LB.audio.ctx.resume().catch(function () {});
  }
  LB.audio.click();
  syncNewGameBtn();
  return true;
}
function buildPicker() {
  const grid = document.getElementById('pickerGrid');
  if (!grid) return;
  for (let i = 0; i < WEAPONS.length; i++) {
    (function (w) {
      const meta = WEAPON_META[w];
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'wbtn wcard';
      card.setAttribute('data-w', w);
      const emo = document.createElement('span'); emo.className = 'emo'; emo.textContent = meta.emo;
      const lbl = document.createElement('span'); lbl.className = 'lbl'; lbl.textContent = meta.label;
      card.appendChild(emo); card.appendChild(lbl);
      card.addEventListener('pointerdown', function (e) {
        e.stopPropagation();
        LB.audio.init(); LB.audio.resume();
        selectWeapon(w);
        closePicker();
      });
      grid.appendChild(card);
    })(WEAPONS[i]);
  }
  const close = document.getElementById('pickerClose');
  if (close) close.addEventListener('pointerdown', function (e) {
    e.stopPropagation();
    LB.audio.init(); LB.audio.resume();
    closePicker();
  });
}
buildPicker();
document.getElementById('curWeapon').addEventListener('pointerdown', function (e) {
  e.stopPropagation();
  LB.audio.init(); LB.audio.resume();
  if (LB.paused) { closePicker(); return; }
  openPicker();
});
window.addEventListener('keydown', function (e) {
  if (LB.paused) {
    if (e.key === 'Escape' || e.key === 'Esc') closePicker();
    else if (e.key === 'm' || e.key === 'M') toggleMute(); // M works with the picker open too
    return;
  }
  const k = e.key;
  if (k === '1') selectWeapon('meteor');
  else if (k === '2') selectWeapon('blackhole');
  else if (k === '3') selectWeapon('tornado');
  else if (k === '4') selectWeapon('tnt');
  else if (k === '5') selectWeapon('bomb');
  else if (k === '6') selectWeapon('tnt_ben');
  else if (k === '7') selectWeapon('nova');
  else if (k === '8') selectWeapon('nuke');
  else if (k === '9') selectWeapon('tsunami');
  else if (k === '0') selectWeapon('laser');
  else if (k === 's' || k === 'S') selectWeapon('stone');
  else if (k === 'v' || k === 'V') selectWeapon('vortex');
  else if (k === 'f' || k === 'F') selectWeapon('fire');
  else if (k === 'm' || k === 'M') toggleMute();
  else if (k === 'n' || k === 'N') newGame(); // v3 wave 2: fresh game from keep-playing
});
window.addEventListener('wheel', function (e) {
  if (LB.paused) return; // picker open: the wheel must not change weapons behind it
  const idx = WEAPONS.indexOf(LB.weapon);
  const next = (idx + (e.deltaY > 0 ? 1 : WEAPONS.length - 1)) % WEAPONS.length;
  selectWeapon(WEAPONS[next]);
}, { passive: true });

function toggleMute() {
  LB.audio.init();
  LB.audio.setMuted(!LB.audio.muted);
  const el = document.getElementById('muteBtn');
  if (el) el.textContent = LB.audio.muted ? '🔇' : '🔊';
}
document.getElementById('muteBtn').addEventListener('pointerdown', function (e) {
  e.stopPropagation(); toggleMute();
});

document.getElementById('playBtn').addEventListener('click', function () {
  LB.audio.init(); LB.audio.resume();
  document.getElementById('title').classList.add('hidden');
  LB.phase = 'play';
});
document.getElementById('againBtn').addEventListener('click', function () {
  LB.audio.init(); LB.audio.resume();
  resetWorld();
});
document.getElementById('keepBtn').addEventListener('click', function () {
  LB.audio.init(); LB.audio.resume();
  keepPlaying();
});
document.getElementById('bellBtn').addEventListener('pointerdown', function (e) {
  e.stopPropagation();
  LB.audio.init(); LB.audio.resume();
  LB.audio.playTwelve(); // the full 12:00: quarters + 12 strikes (mute-aware)
});
document.getElementById('newGameBtn').addEventListener('pointerdown', function (e) {
  e.stopPropagation();
  newGame();
});

/* ============================================================
   SCENE PAINTING (background)
   ============================================================ */
const stars = [];
for (let i = 0; i < 150; i++) {
  stars.push({ x: -1300 + R() * 4300, y: R() * 520, s: 0.5 + R() * 1.4, ph: R() * 10, sp: 0.5 + R() * 2 });
}
const clouds = [];
for (let i = 0; i < 7; i++) {
  clouds.push({ x: -1200 + R() * 4200, y: 50 + R() * 260, sp: 2 + R() * 6, sc: 0.7 + R() * 1.1, seed: R() * 10 });
}
// skyline buildings: polygon + windows
const skyline = [];
function bld(pts, winDensity, warm) {
  const wins = [];
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  pts.forEach(function (p) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); });
  for (let x = minX + 6; x < maxX - 4; x += 9) {
    for (let y = minY + 7; y < maxY - 5; y += 11) {
      if (R() < (winDensity || 0.3)) wins.push([x, y, R() < 0.12 ? '#9fdcff' : (warm === false ? '#ffd9a0' : '#ffb45e')]);
    }
  }
  skyline.push({ pts: pts, wins: wins });
}
// far generic blocks (spread wide for ultrawide screens)
bld([[-1250, 768], [-1250, 700], [-1180, 672], [-1110, 700], [-1110, 768]], 0.22);
bld([[-950, 768], [-950, 668], [-860, 640], [-770, 668], [-770, 768]], 0.26);
bld([[-560, 768], [-560, 690], [-470, 690], [-470, 768]], 0.2);
bld([[-220, 768], [-220, 650], [-130, 610], [-40, 650], [-40, 768]], 0.24);
bld([[40, 768], [40, 678], [100, 678], [100, 768]], 0.3);
bld([[240, 768], [240, 638], [275, 600], [310, 638], [310, 768]], 0.28);
// the Shard
bld([[560, 768], [578, 620], [592, 556], [606, 620], [624, 768]], 0.2);
// Gherkin
bld([[660, 768], [664, 706], [684, 656], [704, 706], [708, 768]], 0.3);
bld([[760, 768], [760, 668], [814, 668], [814, 768]], 0.26);
bld([[870, 768], [870, 648], [950, 648], [950, 768]], 0.24);
// Tower Bridge (behind the Eye)
bld([[975, 768], [975, 660], [985, 634], [995, 660], [995, 768]], 0.34);
bld([[1105, 768], [1105, 660], [1115, 634], [1125, 660], [1125, 768]], 0.34);
skyline.push({ pts: [[975, 690], [1125, 690], [1125, 698], [975, 698]], wins: [[1010, 692, '#ffb45e'], [1070, 692, '#ffb45e'], [1045, 692, '#9fdcff']] });
bld([[1440, 768], [1440, 658], [1510, 658], [1510, 768]], 0.28);
bld([[1560, 768], [1560, 688], [1650, 668], [1740, 688], [1740, 768]], 0.22);
bld([[1850, 768], [1850, 678], [1930, 640], [2010, 678], [2010, 768]], 0.24);
bld([[2200, 768], [2200, 690], [2300, 660], [2400, 690], [2400, 768]], 0.2);
bld([[2500, 768], [2500, 700], [2600, 672], [2700, 700], [2700, 768]], 0.2);

function drawSky() {
  const hy = HORIZON_Y * vs + offY;
  const g = ctx.createLinearGradient(0, 0, 0, Math.max(hy + 70, 10));
  g.addColorStop(0, '#05081f');
  g.addColorStop(0.38, '#131a4a');
  g.addColorStop(0.62, '#292a67');
  g.addColorStop(0.8, '#5c3160');
  g.addColorStop(0.91, '#a34a44');
  g.addColorStop(1, '#e8874a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, cw, Math.max(hy + 70, ch));
  ctx.fillStyle = '#05081f';
  ctx.fillRect(0, hy + 60, cw, ch);
  // warm sunset glow behind skyline (right of centre)
  const rg = ctx.createRadialGradient(cw * 0.68, hy, 10, cw * 0.68, hy, cw * 0.55);
  rg.addColorStop(0, 'rgba(255,150,70,0.30)');
  rg.addColorStop(0.5, 'rgba(255,120,60,0.12)');
  rg.addColorStop(1, 'rgba(255,120,60,0)');
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, cw, hy + 60);
}

function drawStars(t) {
  ctx.fillStyle = '#fff';
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i];
    const tw = 0.4 + 0.6 * Math.abs(Math.sin(t * s.sp + s.ph));
    ctx.globalAlpha = tw * 0.85 * (1 - s.y / 600);
    ctx.fillRect(s.x, s.y, s.s, s.s);
  }
  ctx.globalAlpha = 1;
}

function drawMoon() {
  const mx = 1290, my = 128;
  ctx.globalAlpha = 0.9;
  ctx.drawImage(SPR.glow.white, mx - 110, my - 110, 220, 220);
  ctx.globalAlpha = 0.25;
  ctx.drawImage(SPR.glow.gold, mx - 150, my - 150, 300, 300);
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

function drawClouds(t) {
  for (let i = 0; i < clouds.length; i++) {
    const c = clouds[i];
    const x = ((c.x + t * c.sp) % 4200) - 1300;
    ctx.save();
    ctx.translate(x, c.y + Math.sin(t * 0.1 + c.seed) * 6);
    ctx.scale(c.sc, c.sc);
    ctx.fillStyle = 'rgba(44,52,98,0.5)';
    ctx.beginPath();
    ctx.ellipse(0, 0, 90, 26, 0, 0, Math.PI * 2);
    ctx.ellipse(-60, 8, 55, 18, 0, 0, Math.PI * 2);
    ctx.ellipse(58, 6, 60, 20, 0, 0, Math.PI * 2);
    ctx.ellipse(10, -14, 50, 18, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,150,90,0.10)';
    ctx.beginPath();
    ctx.ellipse(6, 14, 80, 10, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawSkyline() {
  ctx.fillStyle = '#0c1226';
  for (let i = 0; i < skyline.length; i++) {
    const b = skyline[i];
    ctx.beginPath();
    ctx.moveTo(b.pts[0][0], b.pts[0][1]);
    for (let k = 1; k < b.pts.length; k++) ctx.lineTo(b.pts[k][0], b.pts[k][1]);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 0.8;
  for (let i = 0; i < skyline.length; i++) {
    const wins = skyline[i].wins;
    for (let k = 0; k < wins.length; k++) {
      ctx.fillStyle = wins[k][2];
      ctx.fillRect(wins[k][0], wins[k][1], 3, 4);
    }
  }
  ctx.globalAlpha = 1;
  // Shard antenna
  ctx.strokeStyle = '#0c1226'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(592, 556); ctx.lineTo(592, 522); ctx.stroke();
  ctx.fillStyle = '#ff5a4e';
  ctx.beginPath(); ctx.arc(592, 522, 2.6, 0, Math.PI * 2); ctx.fill();
}

function drawGroundAndWaterBase() {
  // far embankment wall
  ctx.fillStyle = '#191d3a';
  ctx.fillRect(-1500, HORIZON_Y, 4600, GROUND_Y - HORIZON_Y);
  // bank
  const g = ctx.createLinearGradient(0, GROUND_Y, 0, WATER_Y);
  g.addColorStop(0, '#232a4a');
  g.addColorStop(1, '#171c38');
  ctx.fillStyle = g;
  ctx.fillRect(-1500, GROUND_Y, 4600, WATER_Y - GROUND_Y);
  ctx.fillStyle = 'rgba(120,130,180,0.14)';
  ctx.fillRect(-1500, GROUND_Y, 4600, 3);
  // water
  const wg = ctx.createLinearGradient(0, WATER_Y, 0, H + 60);
  wg.addColorStop(0, '#101a3e');
  wg.addColorStop(0.25, '#0a1230');
  wg.addColorStop(1, '#050a1e');
  ctx.fillStyle = wg;
  ctx.fillRect(-1500, WATER_Y, 4600, 400);
  ctx.fillStyle = 'rgba(140,160,230,0.10)';
  ctx.fillRect(-1500, WATER_Y, 4600, 2.5);
}

function gatherLightSources() {
  const srcs = [
    { x: 1290, col: 'rgba(190,205,255,', a: 0.4, w: 46 },
  ];
  // clock glow
  let cx = 0, cy = 0, cn = 0;
  for (let i = 0; i < LB.tower.clockBodies.length; i++) {
    const cb = LB.tower.clockBodies[i];
    if (!cb.plugin.lb.removed) { cx += cb.position.x; cy += cb.position.y; cn++; }
  }
  if (cn > 0) srcs.push({ x: cx / cn, col: 'rgba(255,205,120,', a: 0.5, w: 60 });
  // Ayrton Light (the lantern glows when Parliament sits — it always sits here)
  let lx = 0, ln = 0;
  for (let i = 0; i < LB.tower.lanternBodies.length; i++) {
    const ob = LB.tower.lanternBodies[i];
    if (!ob.plugin.lb.removed) { lx += ob.position.x; ln++; }
  }
  if (ln > 0) srcs.push({ x: lx / ln, col: 'rgba(255,190,110,', a: 0.42, w: 46 });
  // eye LED
  if (LB.eye.hub && !LB.eye.hub.plugin.lb.removed) srcs.push({ x: LB.eye.hub.position.x, col: 'rgba(140,120,255,', a: 0.35 * LB.eye.led, w: 130 });
  // meteors
  for (let i = 0; i < LB.meteors.length; i++) srcs.push({ x: LB.meteors[i].position.x, col: 'rgba(255,150,60,', a: 0.55, w: 44 });
  // lit TNT blocks (brighter while flashing)
  for (let i = 0; i < LB.tnts.length; i++) {
    srcs.push({ x: LB.tnts[i].body.position.x, col: 'rgba(255,90,60,', a: tntBlinkOn(LB.tnts[i].t, LB.tnts[i].dur) ? 0.6 : 0.35, w: 40 });
  }
  // holes
  for (let i = 0; i < LB.holes.length; i++) srcs.push({ x: LB.holes[i].x, col: 'rgba(170,120,255,', a: 0.5, w: 62 });
  // fireworks rockets
  for (let i = 0; i < LB.rockets.length; i++) srcs.push({ x: LB.rockets[i].x, col: 'rgba(255,220,150,', a: 0.6, w: 40 });
  // v3 weapons reflect in the Thames too
  for (let i = 0; i < LB.novas.length; i++) srcs.push({ x: LB.novas[i].body.position.x, col: 'rgba(255,220,120,', a: 0.65, w: 90 });
  for (let i = 0; i < LB.nukes.length; i++) srcs.push({ x: LB.nukes[i].body.position.x, col: 'rgba(255,120,60,', a: 0.5, w: 60 });
  for (let i = 0; i < LB.fires.length; i++) {
    if (LB.fires[i].state === 'wave') srcs.push({ x: (LB.fires[i].frontL + LB.fires[i].frontR) / 2, col: 'rgba(255,140,60,', a: 0.4, w: 120 });
  }
  for (let i = 0; i < LB.lasers.length; i++) srcs.push({ x: LB.lasers[i].head, col: 'rgba(120,235,255,', a: 0.5, w: 70 });
  for (let i = 0; i < LB.vortices.length; i++) srcs.push({ x: LB.vortices[i].x, col: 'rgba(110,200,255,', a: 0.4, w: 60 });
  for (let i = 0; i < LB.mushrooms.length; i++) srcs.push({ x: LB.mushrooms[i].x, col: 'rgba(255,150,60,', a: 0.6, w: 160 });
  // vehicle headlights (only when driving)
  for (let i = 0; i < LB.traffic.vehicles.length; i++) {
    const v = LB.traffic.vehicles[i];
    if (v.body.plugin.lb.state === 'drive') srcs.push({ x: v.body.position.x + v.body.plugin.lb.dir * 20, col: 'rgba(255,225,160,', a: 0.3, w: 30 });
  }
  return srcs;
}

function drawReflections(t) {
  const srcs = gatherLightSources();
  ctx.globalCompositeOperation = 'lighter';
  for (let s = 0; s < srcs.length; s++) {
    const S = srcs[s];
    for (let k = 0; k < 14; k++) {
      const y = WATER_Y + 4 + k * 4.6;
      if (y > H + 40) break;
      const wob = Math.sin(t * 1.9 + k * 1.6 + s * 2.4) * 8 * (0.3 + k / 14);
      const w2 = S.w * (1 - k / 17);
      const a = S.a * (1 - k / 15) * (0.55 + 0.45 * Math.sin(t * 2.2 + k * 1.3 + s));
      if (a <= 0.02) continue;
      ctx.fillStyle = S.col + a.toFixed(3) + ')';
      ctx.fillRect(S.x - w2 / 2 + wob, y, w2, 2.6);
    }
  }
  ctx.globalCompositeOperation = 'source-over';
  // slow ripple highlights
  ctx.strokeStyle = 'rgba(150,170,240,0.07)';
  ctx.lineWidth = 1.5;
  for (let k = 0; k < 3; k++) {
    const y = WATER_Y + 12 + k * 18 + Math.sin(t * 0.7 + k) * 3;
    ctx.beginPath();
    for (let x = -200; x < W + 200; x += 60) {
      ctx.lineTo(x, y + Math.sin(x * 0.02 + t * 1.2 + k * 2) * 2.5);
    }
    ctx.stroke();
  }
}

function drawDecals() {
  for (let i = 0; i < LB.decals.length; i++) {
    const d = LB.decals[i];
    ctx.globalAlpha = d.alpha;
    ctx.drawImage(SPR.scorch, d.x - d.size / 2, d.y - d.size / 4, d.size, d.size / 2);
  }
  ctx.globalAlpha = 1;
}
function stepDecals(dt) {
  for (let i = LB.decals.length - 1; i >= 0; i--) {
    LB.decals[i].alpha -= dt * 0.06;
    if (LB.decals[i].alpha <= 0) LB.decals.splice(i, 1);
  }
}

/* ============================================================
   BODY PAINTING
   ============================================================ */
function topEdge(b) {
  const v = b.vertices;
  let i0 = 0, i1 = 1, best = 1e9;
  for (let i = 0; i < v.length; i++) {
    const j = (i + 1) % v.length;
    const yy = v[i].y + v[j].y;
    if (yy < best) { best = yy; i0 = i; i1 = j; }
  }
  return [v[i0], v[i1]];
}

/* per-section masonry details, drawn in the block's own (rotated) frame.
   Performance: each (kind,w,h) detail is pre-rendered ONCE into a tiny sprite;
   upright blocks (angle ≈ 0 — the standing tower) blit it with a single
   drawImage and no canvas transforms; only tumbling blocks take the
   save/rotate path. Keeps 462 detailed blocks cheap. */
const DETAIL_SPRITES = {};
function drawKindDetail(g, kind, w, h, color) {
  switch (kind) {
    case 'plinth':
      g.strokeStyle = 'rgba(10,8,6,0.4)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(-w / 2 + 1, -h / 6); g.lineTo(w / 2 - 1, -h / 6);
      g.moveTo(-w / 2 + 1, h / 6); g.lineTo(w / 2 - 1, h / 6);
      g.stroke();
      break;
    case 'plinthCap':
      g.strokeStyle = 'rgba(10,8,6,0.35)';
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(-w / 2 + 1, 0); g.lineTo(w / 2 - 1, 0); g.stroke();
      break;
    case 'shaftWin': {
      // paired lancet windows (the real shaft's rhythm)
      const ww = w * 0.26, gap = w * 0.14;
      g.fillStyle = '#241d10';
      for (let s = -1; s <= 1; s += 2) {
        const wx = s * (gap / 2 + ww / 2) - ww / 2;
        g.beginPath();
        g.moveTo(wx, h * 0.18);
        g.lineTo(wx, -h * 0.18);
        g.quadraticCurveTo(wx + ww / 2, -h * 0.42, wx + ww, -h * 0.18);
        g.lineTo(wx + ww, h * 0.18);
        g.closePath();
        g.fill();
      }
      // faint warm light inside one pane now and then
      g.fillStyle = 'rgba(255,190,110,0.35)';
      g.fillRect(-gap / 2 - ww * 0.75, -h * 0.1, ww * 0.5, h * 0.24);
      break;
    }
    case 'string':
      // dentil course
      g.fillStyle = 'rgba(12,9,5,0.45)';
      for (let dx = -w / 2 + 1.5; dx < w / 2 - 1; dx += 3.4) g.fillRect(dx, h / 2 - 2.6, 1.6, 2);
      break;
    case 'clockBand': {
      // blind arcading: three little arches
      g.strokeStyle = 'rgba(30,22,8,0.55)';
      g.lineWidth = 1;
      for (let s = -1; s <= 1; s++) {
        const ax = s * w * 0.28;
        g.beginPath();
        g.moveTo(ax - 2.2, h * 0.28);
        g.lineTo(ax - 2.2, -h * 0.05);
        g.quadraticCurveTo(ax, -h * 0.34, ax + 2.2, -h * 0.05);
        g.lineTo(ax + 2.2, h * 0.28);
        g.stroke();
      }
      break;
    }
    case 'clockFrame':
      // stone relief around the dial
      g.strokeStyle = 'rgba(35,26,9,0.5)';
      g.lineWidth = 1.2;
      g.strokeRect(-w / 2 + 1.2, -h / 2 + 1.2, w - 2.4, h - 2.4);
      break;
    case 'cornice':
      // protruding course: dark underside
      g.fillStyle = 'rgba(8,6,3,0.5)';
      g.fillRect(-w / 2, h / 2 - 2, w, 2);
      break;
    case 'annexWin': {
      // tall lancet window on the Westminster wing (dusk glass + one warm pane)
      const ww = w * 0.52;
      g.fillStyle = '#1a1626';
      g.beginPath();
      g.moveTo(-ww / 2, h * 0.30);
      g.lineTo(-ww / 2, -h * 0.08);
      g.quadraticCurveTo(0, -h * 0.42, ww / 2, -h * 0.08);
      g.lineTo(ww / 2, h * 0.30);
      g.closePath();
      g.fill();
      g.fillStyle = 'rgba(255,190,110,0.30)';
      g.fillRect(-ww * 0.2, -h * 0.02, ww * 0.4, h * 0.22);
      break;
    }
    case 'annexDoor': {
      // pointed arch doorway in the rusticated base
      const dw = w * 0.6;
      g.fillStyle = '#171320';
      g.beginPath();
      g.moveTo(-dw / 2, h / 2);
      g.lineTo(-dw / 2, -h * 0.02);
      g.quadraticCurveTo(0, -h * 0.55, dw / 2, -h * 0.02);
      g.lineTo(dw / 2, h / 2);
      g.closePath();
      g.fill();
      break;
    }
    case 'annexString':
      // dentil course
      g.fillStyle = 'rgba(12,9,5,0.4)';
      for (let dx = -w / 2 + 2; dx < w / 2 - 2; dx += 4.5) g.fillRect(dx, h / 2 - 2.4, 2, 1.8);
      break;
    case 'annexRoof':
      // parapet band: faint slate joints
      g.strokeStyle = 'rgba(0,0,0,0.3)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(-w / 2 + 1, 0); g.lineTo(w / 2 - 1, 0);
      g.stroke();
      break;
    case 'annexBase':
      // rusticated base: one heavy bed joint
      g.strokeStyle = 'rgba(10,8,6,0.35)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(-w / 2 + 1, 0); g.lineTo(w / 2 - 1, 0);
      g.stroke();
      break;
    case 'louvre': {
      // slatted bell-chamber opening + pointed arch head
      g.strokeStyle = 'rgba(70,78,104,0.6)';
      g.lineWidth = 1.1;
      for (let i2 = -1; i2 <= 1; i2++) {
        g.beginPath();
        g.moveTo(-w / 2 + 2, i2 * h * 0.26);
        g.lineTo(w / 2 - 2, i2 * h * 0.26);
        g.stroke();
      }
      g.strokeStyle = 'rgba(130,140,175,0.35)';
      g.beginPath();
      g.moveTo(-w / 2 + 1.5, h / 2 - 1);
      g.lineTo(-w / 2 + 1.5, -h * 0.1);
      g.quadraticCurveTo(0, -h / 2 - 2, w / 2 - 1.5, -h * 0.1);
      g.lineTo(w / 2 - 1.5, h / 2 - 1);
      g.stroke();
      break;
    }
    case 'lantern': {
      // the Ayrton Light — a glowing lantern window
      g.fillStyle = '#ffd489';
      g.fillRect(-w * 0.3, -h * 0.32, w * 0.6, h * 0.64);
      g.strokeStyle = 'rgba(60,40,15,0.8)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, -h * 0.32); g.lineTo(0, h * 0.32);
      g.moveTo(-w * 0.3, 0); g.lineTo(w * 0.3, 0);
      g.stroke();
      break;
    }
    case 'lanternRoof': {
      // little pyramidal cap
      g.fillStyle = color;
      g.beginPath();
      g.moveTo(-w / 2 - 1.5, h / 2);
      g.lineTo(0, -h / 2 - 4);
      g.lineTo(w / 2 + 1.5, h / 2);
      g.closePath();
      g.fill();
      g.strokeStyle = 'rgba(200,215,255,0.25)';
      g.lineWidth = 1;
      g.stroke();
      break;
    }
    case 'spire': {
      // openwork cast-iron tracery
      g.strokeStyle = 'rgba(150,170,205,0.3)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(-w / 2 + 1, -h / 2 + 1); g.lineTo(w / 2 - 1, h / 2 - 1);
      g.moveTo(w / 2 - 1, -h / 2 + 1); g.lineTo(-w / 2 + 1, h / 2 - 1);
      g.stroke();
      break;
    }
    case 'gold':
      // gilded finial shine
      g.fillStyle = 'rgba(255,245,200,0.75)';
      g.fillRect(-w / 2 + 1, -h * 0.18, w - 2, 2);
      g.globalAlpha = 0.7;
      g.drawImage(SPR.glow.gold, -w, -h, w * 2, h * 2);
      g.globalAlpha = 1;
      break;
  }
}

function detailSprite(kind, w, h, color) {
  const key = kind + '|' + Math.round(w * 10) + '|' + Math.round(h * 10) + '|' + color;
  let s = DETAIL_SPRITES[key];
  if (!s) {
    const c = document.createElement('canvas');
    const W2 = Math.ceil(w) + 8, H2 = Math.ceil(h) + 16;
    c.width = W2; c.height = H2;
    const g = c.getContext('2d');
    g.translate(W2 / 2, H2 / 2);
    drawKindDetail(g, kind, w, h, color);
    s = DETAIL_SPRITES[key] = c;
  }
  return s;
}

function drawBlockDetail(b) {
  const lb = b.plugin.lb;
  if (lb.w === undefined || lb.h === undefined) return; // Eye parts etc. have no masonry detail
  const spr = detailSprite(lb.kind, lb.w, lb.h, lb.color);
  if (b.angle > -0.02 && b.angle < 0.02) {
    // standing block: straight blit, no canvas transforms
    ctx.drawImage(spr, b.position.x - spr.width / 2, b.position.y - spr.height / 2);
  } else {
    ctx.save();
    ctx.translate(b.position.x, b.position.y);
    ctx.rotate(b.angle);
    ctx.drawImage(spr, -spr.width / 2, -spr.height / 2);
    ctx.restore();
  }
}

function drawBodies() {
  const bodies = LB.bodies;
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    const lb = b.plugin.lb;
    if (!lb) continue;
    if (lb.removed) continue;
    if (lb.set === 'meteor') continue; // drawn separately
    if (lb.set === 'tnt') continue;    // drawn separately (Minecraft block)
    if (lb.set === 'ground') continue;
    if (lb.kind === 'mast') continue;  // flag mast: drawn by drawFlag (pole + cloth)
    if (lb.set === 'bomb' || lb.set === 'nuke' || lb.set === 'nova' || lb.set === 'stone') continue; // v3: drawn separately
    const v = b.vertices;
    if (lb.kind === 'pod') {
      ctx.beginPath();
      ctx.moveTo(v[0].x, v[0].y);
      for (let k = 1; k < v.length; k++) ctx.lineTo(v[k].x, v[k].y);
      ctx.closePath();
      ctx.fillStyle = '#141d33';
      ctx.fill();
      ctx.strokeStyle = '#33427a'; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = '#ffd9a0';
      ctx.fillRect(b.position.x - 2.5, b.position.y - 2, 5, 5);
      continue;
    }
    if (lb.kind === 'hub') {
      ctx.beginPath(); ctx.arc(b.position.x, b.position.y, 16, 0, Math.PI * 2);
      ctx.fillStyle = '#232a48'; ctx.fill();
      ctx.strokeStyle = '#4a5580'; ctx.lineWidth = 2; ctx.stroke();
      continue;
    }
    // generic polygon body
    ctx.beginPath();
    ctx.moveTo(v[0].x, v[0].y);
    for (let k = 1; k < v.length; k++) ctx.lineTo(v[k].x, v[k].y);
    ctx.closePath();
    ctx.fillStyle = lb.color || '#b9975a';
    ctx.fill();
    ctx.strokeStyle = 'rgba(15,10,5,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
    drawBlockDetail(b);
    if (lb.kind !== 'gold' && lb.kind !== 'lanternRoof') {
      const e = topEdge(b);
      ctx.strokeStyle = 'rgba(255,225,170,0.26)';
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(e[0].x, e[0].y); ctx.lineTo(e[1].x, e[1].y); ctx.stroke();
    }
  }
}

function drawEyeLEDs() {
  const E = LB.eye;
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.8 * E.led;
  for (let i = 0; i < E.rim.length; i++) {
    const s = E.rim[i];
    if (s.plugin.lb.removed) continue;
    const c = Math.cos(s.angle), sn = Math.sin(s.angle);
    const px = s.position.x + -sn * -7.5, py = s.position.y + c * -7.5;
    ctx.drawImage(SPR.glow.violet, px - 7, py - 7, 14, 14);
  }
  ctx.globalAlpha = 0.55 * E.led;
  for (let i = 0; i < E.pods.length; i++) {
    const p = E.pods[i];
    if (p.plugin.lb.removed) continue;
    ctx.drawImage(SPR.glow.cyan, p.position.x - 5, p.position.y - 12, 10, 10);
  }
  if (E.hub && !E.hub.plugin.lb.removed) {
    ctx.globalAlpha = 0.5 * E.led;
    ctx.drawImage(SPR.glow.violet, E.hub.position.x - 26, E.hub.position.y - 26, 52, 52);
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

function drawClockFace(t) {
  const cbs = LB.tower.clockBodies;
  let cx = 0, cy = 0, cn = 0;
  for (let i = 0; i < cbs.length; i++) {
    if (!cbs[i].plugin.lb.removed) { cx += cbs[i].position.x; cy += cbs[i].position.y; cn++; }
  }
  if (cn === 0) return;
  cx /= cn; cy /= cn;

  // F4: real local time (both faces show the same, like the real four dials)
  const now = new Date();
  const hh = now.getHours() % 12, mm = now.getMinutes(), ss = now.getSeconds() + now.getMilliseconds() / 1000;
  LB.clock = { h: now.getHours(), m: mm, s: now.getSeconds(), ms: now.getMilliseconds() };
  const secA = (ss / 60) * Math.PI * 2 - Math.PI / 2;
  const minA = ((mm + ss / 60) / 60) * Math.PI * 2 - Math.PI / 2;
  const hourA = ((hh + (mm + ss / 60) / 60) / 12) * Math.PI * 2 - Math.PI / 2;

  const R = 24;
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.55 + 0.12 * Math.sin(t * 2);
  ctx.drawImage(SPR.glow.gold, cx - R - 28, cy - R - 28, (R + 28) * 2, (R + 28) * 2);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;

  function face(x, y, rx, ry) {
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#f6e9c4';
    ctx.fill();
    ctx.strokeStyle = '#4d3a14';
    ctx.lineWidth = 2.4;
    ctx.stroke();
    // inner ring + ticks (12 bold cardinals, others minor)
    ctx.strokeStyle = 'rgba(90,69,23,0.9)';
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.ellipse(x, y, rx * 0.82, ry * 0.82, 0, 0, Math.PI * 2); ctx.stroke();
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const big = i % 3 === 0;
      const r1 = big ? 0.66 : 0.72;
      ctx.strokeStyle = big ? '#3a2c0c' : 'rgba(90,69,23,0.75)';
      ctx.lineWidth = big ? 2.6 : 1.3;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * rx * r1, y + Math.sin(a) * ry * r1);
      ctx.lineTo(x + Math.cos(a) * rx * 0.78, y + Math.sin(a) * ry * 0.78);
      ctx.stroke();
    }
    // hands (projected onto the face ellipse so the side dial foreshortens)
    function hand(a, len, wid, col) {
      ctx.strokeStyle = col;
      ctx.lineWidth = wid;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * rx * len, y + Math.sin(a) * ry * len);
      ctx.stroke();
    }
    hand(hourA, 0.5, 4.2, '#2c2109');
    hand(minA, 0.76, 3, '#2c2109');
    hand(secA, 0.85, 1.4, '#b3342c');
    ctx.fillStyle = '#2c2109';
    ctx.beginPath(); ctx.arc(x, y, 2.6, 0, Math.PI * 2); ctx.fill();
  }

  face(cx, cy, R, R);
  // side dial on the right edge of the clock stage (squashed perspective)
  face(cx + 66, cy, 9, R);
}

function drawTNTs() {
  const h = TNT_SIZE / 2, band = TNT_SIZE * 0.21;
  for (let i = 0; i < LB.tnts.length; i++) {
    const t = LB.tnts[i], b = t.body;
    const blink = tntBlinkOn(t.t, t.dur);
    // warm halo so the block reads against the night scene (brighter on flash)
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = blink ? 0.75 : 0.4;
    ctx.drawImage(SPR.glow.red,
      b.position.x - TNT_SIZE * 1.05,
      b.position.y - TNT_SIZE * (t.ben ? 3.1 : 1.05),
      TNT_SIZE * 2.1,
      TNT_SIZE * (t.ben ? 6.2 : 2.1));
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    // a plain TNT is one block; TNT BEN paints all three compound parts
    const parts = t.ben ? b.parts.slice(1) : [b];
    for (let pi = 0; pi < parts.length; pi++) {
      const pb = parts[pi];
      const speck = t.ben ? ((b.plugin.lb.specks || [])[pi] || []) : (b.plugin.lb.speck || []);
      ctx.save();
      ctx.translate(pb.position.x, pb.position.y);
      ctx.rotate(pb.angle);
      // body — mottled red
      ctx.fillStyle = '#c93a22';
      ctx.fillRect(-h, -h, TNT_SIZE, TNT_SIZE);
      for (let k = 0; k < speck.length; k++) {
        ctx.fillStyle = speck[k][2] ? '#e05a35' : '#a02c15';
        ctx.fillRect(speck[k][0] - 1.5, speck[k][1] - 1.5, 3, 3);
      }
      // darker frame edges
      ctx.fillStyle = 'rgba(70,15,5,0.55)';
      ctx.fillRect(-h, -h, TNT_SIZE, 2.5);
      ctx.fillRect(-h, h - 2.5, TNT_SIZE, 2.5);
      ctx.fillStyle = 'rgba(60,12,4,0.35)';
      ctx.fillRect(-h, -h, 2, TNT_SIZE);
      ctx.fillRect(h - 2, -h, 2, TNT_SIZE);
      // white lettering band
      ctx.fillStyle = '#ece7dd';
      ctx.fillRect(-h + 1.5, -band, TNT_SIZE - 3, band * 2);
      ctx.fillStyle = 'rgba(40,8,2,0.5)';
      ctx.fillRect(-h + 1.5, -band - 1, TNT_SIZE - 3, 1);
      ctx.fillRect(-h + 1.5, band, TNT_SIZE - 3, 1);
      ctx.fillStyle = '#22160f';
      ctx.font = '900 ' + (TNT_SIZE * 0.30).toFixed(1) + 'px "Trebuchet MS", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('TNT', 0, 0.5);
      // fuse nub on top
      ctx.fillStyle = '#3a2a1a';
      ctx.fillRect(-1.5, -h - 3, 3, 3.5);
      // Minecraft blink: whole texture flashes white, accelerating toward the boom
      if (blink) {
        ctx.fillStyle = 'rgba(255,255,255,0.88)';
        ctx.fillRect(-h, -h, TNT_SIZE, TNT_SIZE);
      }
      ctx.restore();
    }
  }
  ctx.globalAlpha = 1;
}

function drawMeteors() {
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < LB.meteors.length; i++) {
    const b = LB.meteors[i];
    const v = b.velocity;
    ctx.drawImage(SPR.glow.orange, b.position.x - 60 - v.x, b.position.y - 60 - v.y, 120, 120);
    ctx.drawImage(SPR.glow.gold, b.position.x - 34, b.position.y - 34, 68, 68);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#fff3d6';
    ctx.beginPath(); ctx.arc(b.position.x, b.position.y, 13, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = 'lighter';
  }
  ctx.globalCompositeOperation = 'source-over';
}

function drawHoles(t) {
  for (let i = 0; i < LB.holes.length; i++) {
    const h = LB.holes[i];
    const fade = Math.min(1, h.t * 3, (h.dur - h.t) * 2);
    ctx.save();
    ctx.translate(h.x, h.y);
    ctx.rotate(h.t * 1.4);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.5 * fade;
    ctx.drawImage(SPR.glow.violet, -95, -34, 190, 68);
    ctx.rotate(1.1);
    ctx.globalAlpha = 0.35 * fade;
    ctx.drawImage(SPR.glow.purple, -70, -26, 140, 52);
    ctx.restore();
    // distortion rings
    ctx.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 2; k++) {
      const rr = ((h.t * 110 + k * 120) % 240) + 30;
      ctx.globalAlpha = 0.25 * fade * (1 - rr / 270);
      ctx.strokeStyle = 'rgba(170,130,255,1)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(h.x, h.y, rr, 0, Math.PI * 2); ctx.stroke();
    }
    // core
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.arc(h.x, h.y, 26, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(190,150,255,0.9)';
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(h.x, h.y, 27, t * 2, t * 2 + Math.PI * 1.5); ctx.stroke();
    // feed counter
    if (h.consumed > 0) {
      ctx.font = '700 30px "Trebuchet MS", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#e6d6ff';
      ctx.strokeStyle = 'rgba(60,20,120,0.8)'; ctx.lineWidth = 4;
      ctx.strokeText('×' + h.consumed, h.x, h.y - 44);
      ctx.fillText('×' + h.consumed, h.x, h.y - 44);
    }
    ctx.globalAlpha = 1;
  }
}

function drawTornados(t) {
  for (let i = 0; i < LB.tornados.length; i++) {
    const to = LB.tornados[i];
    const fade = Math.min(1, to.t * 2.5, (to.dur - to.t) * 1.5);
    const TOP = 540;
    const sway = function (h) { return Math.sin(t * 2.2 + h * 0.012 + to.phase) * (8 + h * 0.10); };
    const wAt = function (h) { return 36 + h * 0.30; }; // narrow base, wide top (matches force field)
    // storm collar where the funnel meets the sky
    ctx.fillStyle = 'rgba(70,62,98,0.55)';
    for (let c = 0; c < 3; c++) {
      ctx.beginPath();
      ctx.ellipse(to.x + sway(TOP) + (c - 1) * 90, GROUND_Y - TOP - 6 + Math.sin(t * 1.3 + c) * 6, 150 - c * 18, 26, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // funnel body (dense dust)
    const grad = ctx.createLinearGradient(0, GROUND_Y, 0, GROUND_Y - TOP);
    grad.addColorStop(0, 'rgba(150,132,158,0.82)');
    grad.addColorStop(0.45, 'rgba(128,112,145,0.64)');
    grad.addColorStop(1, 'rgba(112,102,142,0.50)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(to.x - wAt(0) + sway(0), GROUND_Y + 6);
    for (let h = 0; h <= TOP; h += 27) ctx.lineTo(to.x - wAt(h) + sway(h), GROUND_Y - h);
    for (let h = TOP; h >= 0; h -= 27) ctx.lineTo(to.x + wAt(h) + sway(h), GROUND_Y - h);
    ctx.closePath();
    ctx.globalAlpha = fade;
    ctx.fill();
    // darker inner core for depth
    ctx.fillStyle = 'rgba(78,68,105,0.55)';
    ctx.beginPath();
    ctx.moveTo(to.x - wAt(0) * 0.55 + sway(0), GROUND_Y);
    for (let h = 0; h <= TOP; h += 27) ctx.lineTo(to.x - wAt(h) * 0.55 + sway(h), GROUND_Y - h);
    for (let h = TOP; h >= 0; h -= 27) ctx.lineTo(to.x + wAt(h) * 0.55 + sway(h), GROUND_Y - h);
    ctx.closePath();
    ctx.fill();
    // rotating streak lines up the funnel
    ctx.strokeStyle = 'rgba(220,210,240,0.38)';
    ctx.lineWidth = 3;
    for (let s2 = 0; s2 < 5; s2++) {
      ctx.beginPath();
      for (let h = 0; h <= TOP; h += 18) {
        const ph = t * 5 + s2 * 1.25 + h * 0.02;
        const off = Math.sin(ph) * wAt(h) * 0.65;
        const px = to.x + sway(h) + off;
        if (h === 0) ctx.moveTo(px, GROUND_Y - h); else ctx.lineTo(px, GROUND_Y - h);
      }
      ctx.stroke();
    }
    // ground dust skirt
    ctx.fillStyle = 'rgba(115,100,130,0.30)';
    ctx.beginPath();
    ctx.ellipse(to.x + sway(0), GROUND_Y + 2, 150, 26, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    // orbiting puff layers
    for (let L = 0; L < 3; L++) {
      const spin = 4.6 - L * 1.1;
      const scaleR = 1 - L * 0.16;
      for (let k = 0; k < 24; k++) {
        const hgt = k * 22;
        const rr = (24 + hgt * 0.5) * scaleR;
        const ang = -t * spin + k * 0.55 + L * 2.1;
        const px = to.x + sway(hgt) + Math.cos(ang) * rr * (0.55 + 0.45 * Math.sin(k * 0.9 + t * 2 + L));
        const py = GROUND_Y - hgt * (0.96 + L * 0.02) - L * 8;
        ctx.globalAlpha = (0.30 + L * 0.08) * fade;
        const s = 30 + hgt * 0.09;
        ctx.drawImage(SPR.dust, px - s / 2, py - s / 2, s, s);
      }
    }
    // base dust ring
    for (let k = 0; k < 6; k++) {
      const ang = t * 5 + k * Math.PI / 3;
      ctx.globalAlpha = 0.3 * fade;
      ctx.drawImage(SPR.dust, to.x + Math.cos(ang) * 55 - 16, GROUND_Y - 14 + Math.sin(ang) * 8, 32, 22);
    }
  }
  ctx.globalAlpha = 1;
}

function drawBombs() {
  for (let i = 0; i < LB.bombs.length; i++) {
    const b = LB.bombs[i].body;
    ctx.save();
    ctx.translate(b.position.x, b.position.y);
    ctx.rotate(b.angle);
    // faint shine so it reads against the night
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.22;
    ctx.drawImage(SPR.glow.blue, -BOMB_R * 1.6, -BOMB_R * 1.6, BOMB_R * 3.2, BOMB_R * 3.2);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    // body + highlight
    ctx.fillStyle = '#1c1c24';
    ctx.beginPath(); ctx.arc(0, 3, BOMB_R, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.beginPath(); ctx.ellipse(-7, -5, 6.5, 4.5, -0.6, 0, Math.PI * 2); ctx.fill();
    // screw cap + fuse
    ctx.fillStyle = '#3d414e';
    ctx.fillRect(-6, -BOMB_R - 2, 12, 6);
    ctx.strokeStyle = '#c9a06b';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, -BOMB_R - 2);
    ctx.quadraticCurveTo(5, -BOMB_R - 12, 12, -BOMB_R - 10);
    ctx.stroke();
    ctx.restore();
  }
}

function drawNovas(t) {
  for (let i = 0; i < LB.novas.length; i++) {
    const nv = LB.novas[i], b = nv.body;
    const k = clamp(nv.t / nv.dur, 0, 1);
    const pul = 1 + 0.09 * Math.sin(t * 9 + i * 2);
    const R2 = (NOVA_R + 6 + 30 * k) * pul;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.5 + 0.4 * k;
    ctx.drawImage(SPR.glow.gold, b.position.x - R2 * 1.9, b.position.y - R2 * 1.9, R2 * 3.8, R2 * 3.8);
    ctx.globalAlpha = 0.35 + 0.45 * k;
    ctx.drawImage(SPR.glow.white, b.position.x - R2, b.position.y - R2, R2 * 2, R2 * 2);
    if (k > 0.55) {
      // running hot: the star turns blue-white before it blows
      ctx.globalAlpha = (k - 0.55) * 1.6;
      ctx.drawImage(SPR.glow.cyan, b.position.x - R2 * 1.3, b.position.y - R2 * 1.3, R2 * 2.6, R2 * 2.6);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#fff4d0';
    ctx.beginPath(); ctx.arc(b.position.x, b.position.y, NOVA_R * (0.7 + 0.3 * pul), 0, Math.PI * 2); ctx.fill();
  }
}

function drawNovaRings() {
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < LB.novaRings.length; i++) {
    const r = LB.novaRings[i];
    const k = r.t / r.dur;
    const rx = 830 * (1 - Math.pow(1 - k, 2.1));
    const ry = rx * 0.32;
    ctx.globalAlpha = (1 - k) * 0.85;
    ctx.strokeStyle = hsl(r.hue + k * 100, 95, 66);
    ctx.lineWidth = 11 * (1 - k) + 1.5;
    ctx.beginPath(); ctx.ellipse(r.x, r.y, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = (1 - k) * 0.5;
    ctx.strokeStyle = hsl(r.hue + 40 + k * 100, 95, 74);
    ctx.lineWidth = 5 * (1 - k) + 1;
    ctx.beginPath(); ctx.ellipse(r.x, r.y, rx * 0.62, ry * 0.62, 0, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

function drawNukes() {
  const h = NUKE_SIZE / 2;
  for (let i = 0; i < LB.nukes.length; i++) {
    const t = LB.nukes[i], b = t.body;
    const armed = t.t / t.dur;
    const blink = armed > 0.12 && (t.t % Math.max(0.1, 0.6 - armed * 0.5)) < 0.05 + armed * 0.07;
    // placement pop: quick settle-scale on spawn (subtle hover/settle read)
    const pop = Math.min(1, t.t / 0.28);
    const scale = 0.55 + 0.45 * (1 - Math.pow(1 - pop, 3));
    ctx.save();
    ctx.translate(b.position.x, b.position.y);
    ctx.rotate(b.angle);
    ctx.scale(scale, scale);
    // ground shadow
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(0, h + 4, h * 0.82, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    // dark matte casing
    ctx.fillStyle = '#262a32';
    ctx.fillRect(-h, -h, NUKE_SIZE, NUKE_SIZE);
    ctx.fillStyle = 'rgba(255,255,255,0.07)';           // top bevel light
    ctx.fillRect(-h + 3, -h + 3, NUKE_SIZE - 6, 5);
    ctx.fillStyle = 'rgba(0,0,0,0.42)';                 // bottom shade
    ctx.fillRect(-h + 3, h - 8, NUKE_SIZE - 6, 5);
    ctx.strokeStyle = '#0e1015';
    ctx.lineWidth = 3;
    ctx.strokeRect(-h + 1.5, -h + 1.5, NUKE_SIZE - 3, NUKE_SIZE - 3);
    // hazard stripes: diagonal yellow/black bands top + bottom
    ctx.save();
    ctx.beginPath();
    ctx.rect(-h + 3, -h + 3, NUKE_SIZE - 6, 8);
    ctx.rect(-h + 3, h - 11, NUKE_SIZE - 6, 8);
    ctx.clip();
    ctx.fillStyle = '#15171d';
    ctx.fillRect(-h, -h, NUKE_SIZE, NUKE_SIZE);
    ctx.fillStyle = '#e0a90c';
    for (let sx = -h - 12; sx < h + 12; sx += 14) {
      ctx.beginPath();
      ctx.moveTo(sx, h);
      ctx.lineTo(sx + 7, h);
      ctx.lineTo(sx + 7 + 16, -h);
      ctx.lineTo(sx + 16, -h);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    // trefoil on a dark disc
    ctx.fillStyle = '#15181e';
    ctx.beginPath(); ctx.arc(0, 0, h * 0.56, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = blink ? '#ffe9a8' : '#e0a90c';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, h * 0.56, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = blink ? '#fff3b0' : '#ffd23e';
    for (let s = 0; s < 3; s++) {
      const a0 = -Math.PI / 2 + s * (Math.PI * 2 / 3) - 0.5;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, h * 0.5, a0, a0 + 1.0);
      ctx.closePath();
      ctx.fill();
    }
    ctx.beginPath(); ctx.arc(0, 0, h * 0.13, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#23252e';
    ctx.beginPath(); ctx.arc(0, 0, h * 0.08, 0, Math.PI * 2); ctx.fill();
    // armed red LED (top-right corner)
    if (blink) {
      ctx.fillStyle = '#ff2d2d';
      ctx.beginPath(); ctx.arc(h - 11, -h + 15, 3.4, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.fillStyle = '#57181b';
      ctx.beginPath(); ctx.arc(h - 11, -h + 15, 3.4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    // armed glow: sweeping warning light + red pulse, brighter as the fuse burns
    ctx.globalCompositeOperation = 'lighter';
    const sweepA = 0.1 + 0.16 * armed;
    const swp = b.position.x + Math.cos(LB.time * 2.8) * h * 1.15;
    const swy = b.position.y + Math.sin(LB.time * 2.8) * h * 1.15;
    ctx.globalAlpha = sweepA * (blink ? 1.6 : 1);
    ctx.drawImage(SPR.glow.red, swp - 46, swy - 46, 92, 92);
    ctx.globalAlpha = 0.16 + 0.22 * armed + (blink ? 0.14 : 0);
    ctx.drawImage(SPR.glow.red, b.position.x - 64, b.position.y - 64, 128, 128);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }
}

function drawStones() {
  for (let i = 0; i < LB.stones.length; i++) {
    const st = LB.stones[i], b = st.body;
    const lb = b.plugin.lb;
    ctx.save();
    ctx.translate(b.position.x, b.position.y);
    ctx.rotate(b.angle);
    ctx.fillStyle = '#7f7a8a';
    ctx.beginPath(); ctx.arc(0, 0, STONE_R, 0, Math.PI * 2); ctx.fill();
    const spots = lb.spots || [];
    for (let k = 0; k < spots.length; k++) {
      ctx.fillStyle = spots[k][3] ? 'rgba(60,56,70,0.7)' : 'rgba(170,165,180,0.5)';
      ctx.beginPath(); ctx.arc(spots[k][0], spots[k][1], spots[k][2], 0, Math.PI * 2); ctx.fill();
    }
    // cracks appear as the armor wears
    const hpF = clamp(lb.stoneHp / STONE_HP, 0, 1);
    ctx.strokeStyle = 'rgba(30,28,38,0.8)';
    ctx.lineWidth = 3;
    if (hpF < 0.75) {
      ctx.beginPath();
      ctx.moveTo(-STONE_R * 0.7, -STONE_R * 0.2);
      ctx.lineTo(-STONE_R * 0.1, 0);
      ctx.lineTo(STONE_R * 0.4, -STONE_R * 0.35);
      ctx.stroke();
    }
    if (hpF < 0.4) {
      ctx.beginPath();
      ctx.moveTo(-STONE_R * 0.3, STONE_R * 0.6);
      ctx.lineTo(0, STONE_R * 0.1);
      ctx.lineTo(STONE_R * 0.55, STONE_R * 0.3);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function drawTsunamis(t) {
  for (let i = 0; i < LB.tsunamis.length; i++) {
    const w = LB.tsunamis[i];
    const x0 = Math.max(w.front - w.width, -W * 0.5);
    ctx.beginPath();
    ctx.moveTo(w.front, GROUND_Y + 8);
    // steep face up to the crest
    ctx.quadraticCurveTo(w.front - w.width * 0.06, GROUND_Y - w.height * 0.9, w.front - w.width * 0.22, GROUND_Y - w.height);
    // long tail sloping back down
    for (let x = w.front - w.width * 0.22; x > x0; x -= 26) {
      ctx.lineTo(x, tsunamiSurfaceY(w, x));
    }
    ctx.lineTo(x0, GROUND_Y + 8);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, GROUND_Y - w.height, 0, GROUND_Y);
    g.addColorStop(0, 'rgba(120,200,255,0.95)');
    g.addColorStop(0.35, 'rgba(50,120,220,0.88)');
    g.addColorStop(1, 'rgba(20,50,140,0.85)');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(235,250,255,0.9)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    let first = true;
    for (let x = w.front - w.width * 0.22; x > x0; x -= 26) {
      const y = tsunamiSurfaceY(w, x);
      if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // crest foam blobs
    const crestX = w.front - w.width * 0.12;
    ctx.fillStyle = 'rgba(240,250,255,0.85)';
    for (let k = 0; k < 5; k++) {
      const fx = crestX + Math.sin(t * 7 + k * 2.2) * 16 - k * 9;
      const fy = GROUND_Y - w.height + Math.sin(t * 5 + k) * 7 + k * 4;
      ctx.beginPath(); ctx.arc(fx, fy, 9 - k, 0, Math.PI * 2); ctx.fill();
    }
  }
}

function drawLasers(t) {
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < LB.lasers.length; i++) {
    const bm = LB.lasers[i];
    const x0 = bm.dir > 0 ? 0 : bm.head;
    const x1 = bm.dir > 0 ? bm.head : W;
    const fade = Math.min(1, bm.t * 6, (bm.dur - bm.t) * 3);
    if (fade <= 0) continue;
    // outer glow (soft blob stretched into a beam)
    ctx.globalAlpha = 0.4 * fade;
    ctx.drawImage(SPR.glow.cyan, x0, bm.y - 26, x1 - x0, 52);
    ctx.globalAlpha = 0.5 * fade;
    ctx.fillStyle = '#59e6ff';
    ctx.fillRect(x0, bm.y - 6, x1 - x0, 12);
    ctx.globalAlpha = 0.9 * fade;
    ctx.fillStyle = '#bffcff';
    ctx.fillRect(x0, bm.y - 2.6, x1 - x0, 5.2);
    // electric jitter
    ctx.globalAlpha = 0.7 * fade;
    ctx.strokeStyle = '#e8ffff';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let x = x0; x <= x1; x += 42) {
      const jy = bm.y + Math.sin(x * 0.05 + t * 40) * 3.4;
      if (x === x0) ctx.moveTo(x, jy); else ctx.lineTo(x, jy);
    }
    ctx.stroke();
    // flare at the travelling tip
    ctx.globalAlpha = 0.8 * fade;
    ctx.drawImage(SPR.glow.white, bm.head - 40, bm.y - 40, 80, 80);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

function drawVortices(t) {
  for (let i = 0; i < LB.vortices.length; i++) {
    const v = LB.vortices[i];
    const fade = Math.min(1, v.t * 2.5, (v.dur - v.t) * 1.5);
    const TOP = 190;
    const sway = function (h) { return Math.sin(t * 3.1 + h * 0.02 + v.phase) * (4 + h * 0.09); };
    const wAt = function (h) { return 34 + h * 0.5; };
    ctx.globalAlpha = fade;
    // watery funnel
    const grad = ctx.createLinearGradient(0, GROUND_Y, 0, GROUND_Y - TOP);
    grad.addColorStop(0, 'rgba(70,160,235,0.85)');
    grad.addColorStop(0.5, 'rgba(90,190,250,0.55)');
    grad.addColorStop(1, 'rgba(150,225,255,0.18)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(v.x - wAt(0) + sway(0), GROUND_Y + 4);
    for (let h = 0; h <= TOP; h += 16) ctx.lineTo(v.x - wAt(h) + sway(h), GROUND_Y - h);
    for (let h = TOP; h >= 0; h -= 16) ctx.lineTo(v.x + wAt(h) + sway(h), GROUND_Y - h);
    ctx.closePath();
    ctx.fill();
    // spiral streaks
    ctx.strokeStyle = 'rgba(220,245,255,0.5)';
    ctx.lineWidth = 2.4;
    for (let s = 0; s < 4; s++) {
      ctx.beginPath();
      for (let h = 0; h <= TOP; h += 14) {
        const ph = t * 6 + s * 1.6 + h * 0.03;
        const off = Math.sin(ph) * wAt(h) * 0.7;
        const px = v.x + sway(h) + off;
        if (h === 0) ctx.moveTo(px, GROUND_Y - h); else ctx.lineTo(px, GROUND_Y - h);
      }
      ctx.stroke();
    }
    // churning foam ring
    ctx.fillStyle = 'rgba(235,250,255,0.75)';
    for (let k = 0; k < 7; k++) {
      const a = t * 5 + k * (Math.PI * 2 / 7);
      const rr = 26 + (k % 3) * 12;
      ctx.beginPath();
      ctx.arc(v.x + sway(0) + Math.cos(a) * rr, GROUND_Y + 2 + Math.sin(a) * 6, 6 - (k % 3), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

function drawFires(t) {
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < LB.fires.length; i++) {
    const f = LB.fires[i];
    if (f.state === 'crate') {
      const b = f.crate;
      if (b && !b.plugin.lb.removed) {
        ctx.globalAlpha = 0.5;
        ctx.drawImage(SPR.glow.orange, b.position.x - 34, b.position.y - 34, 68, 68);
      }
      continue;
    }
    const fade = Math.max(0, 1 - f.t / f.dur);
    // low hot glow along the whole band
    const g = ctx.createLinearGradient(0, GROUND_Y, 0, GROUND_Y - 90);
    g.addColorStop(0, 'rgba(255,140,50,' + (0.28 * fade).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(255,100,30,0)');
    ctx.fillStyle = g;
    ctx.fillRect(f.frontL, GROUND_Y - 90, f.frontR - f.frontL, 90);
    // bright flames licking at each front
    for (let k = 0; k < 3; k++) {
      const fl = k === 0 ? f.frontL : (k === 1 ? f.frontR : (f.frontL + f.frontR) / 2 + Math.sin(t * 3 + i) * 40);
      ctx.globalAlpha = 0.75 * fade;
      ctx.drawImage(SPR.glow.orange, fl - 26, GROUND_Y - 44, 52, 52);
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

function drawReticle(t) {
  if (!LB.pointer.active || LB.pointer.type !== 'mouse' || LB.phase === 'title' || LB.paused) return;
  const meta = WEAPON_META[LB.weapon] || WEAPON_META.meteor;
  const w = screenToWorld(LB.pointer.x, LB.pointer.y);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const sx = LB.pointer.x, sy = LB.pointer.y;
  const r = 17 + Math.sin(t * 5) * 2.5;
  ctx.strokeStyle = meta.col; ctx.lineWidth = 2.2;
  ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(sx - r - 7, sy); ctx.lineTo(sx - r + 3, sy);
  ctx.moveTo(sx + r - 3, sy); ctx.lineTo(sx + r + 7, sy);
  ctx.moveTo(sx, sy - r - 7); ctx.lineTo(sx, sy - r + 3);
  ctx.moveTo(sx, sy + r - 3); ctx.lineTo(sx, sy + r + 7);
  ctx.stroke();
  ctx.font = '20px serif';
  ctx.textAlign = 'left';
  ctx.fillText(meta.emo, sx + 20, sy - 16);
}

/* ============================================================
   MAIN LOOP
   ============================================================ */
const fpsSamples = [];
let stepCounter = 0;

function stepWorld(dt) {
  LB.time += dt / 1000;
  stepCounter++;
  stepEye(dt);
  stepWeapons(dt);
  M.Engine.update(engine, dt);
  LB.bodies = M.Composite.allBodies(world);
  stepGuards();
  stepTraffic(dt);
  P.update(dt / 1000);
  stepDecals(dt / 1000);
  stepFinale(dt);
  LB.shake *= 0.9;
  LB.flash *= 0.88;
}

let last = performance.now(), acc = 0;
function frame(now) {
  requestAnimationFrame(frame);
  let dt = now - last; last = now;
  if (dt > 250) dt = 250;
  if (dt > 0) {
    fpsSamples.push(dt);
    if (fpsSamples.length > 120) fpsSamples.shift();
  }
  acc += dt;
  if (LB.paused) {
    acc = 0; // weapon picker open: the world holds its breath
  } else {
    let steps = 0;
    while (acc >= STEP && steps < 4) { stepWorld(STEP); acc -= STEP; steps++; }
    if (steps === 4) acc = 0;
  }
  render(now / 1000);
}

function render(t) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawSky();
  const shx = (Math.random() - 0.5) * LB.shake, shy = (Math.random() - 0.5) * LB.shake;
  ctx.setTransform(dpr * vs, 0, 0, dpr * vs, dpr * (offX + shx), dpr * (offY + shy));
  drawStars(t);
  drawMoon();
  drawClouds(t);
  drawSkyline();
  drawGroundAndWaterBase();
  drawRoad();
  drawVehicles(0);       // far lane: behind the landmarks
  drawReflections(t);
  drawDecals();
  drawBodies();
  drawFlag(t);
  drawVehicles(1);       // near lane + flying wrecks: in front
  drawTNTs();
  drawBombs();
  drawNovas(t);
  drawNukes();
  drawStones();
  drawMeteors();
  drawTornados(t);
  drawVortices(t);
  drawFires(t);
  P.render(ctx, 'under');
  drawHoles(t);
  drawTsunamis(t);
  ctx.globalCompositeOperation = 'lighter';
  drawLasers(t);
  drawMushrooms();
  drawNovaRings();
  P.render(ctx, 'glow');
  ctx.globalCompositeOperation = 'source-over';
  drawEyeLEDs();
  drawClockFace(t);
  // screen-space UI
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (LB.flash > 0.02) {
    ctx.fillStyle = 'rgba(255,245,230,' + Math.min(0.75, LB.flash * 0.75).toFixed(3) + ')';
    ctx.fillRect(0, 0, cw, ch);
  }
  if (!vignette) {
    vignette = ctx.createRadialGradient(cw / 2, ch / 2, Math.min(cw, ch) * 0.45, cw / 2, ch / 2, Math.max(cw, ch) * 0.75);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(2,3,12,0.42)');
  }
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, cw, ch);
  drawReticle(t);
}

/* ============================================================
   __TEST__ hooks (harmless, used by verifier)
   ============================================================ */
const testErrors = [];
window.addEventListener('error', function (e) { testErrors.push(String(e.message || e)); });
window.addEventListener('unhandledrejection', function (e) { testErrors.push('rejection:' + String(e.reason)); });
const origErr = console.error;
console.error = function () {
  testErrors.push(Array.prototype.map.call(arguments, String).join(' '));
  origErr.apply(console, arguments);
};

window.__TEST__ = {
  bodyCounts: function () {
    LB.bodies = M.Composite.allBodies(world);
    let tower = 0, eye = 0, annex = 0, dyn = 0, stat = 0;
    const kinds = {};
    for (let i = 0; i < LB.bodies.length; i++) {
      const b = LB.bodies[i], lb = b.plugin.lb;
      if (b.isStatic) stat++; else dyn++;
      if (lb && lb.set === 'tower' && !lb.removed) {
        tower++;
        kinds[lb.kind] = (kinds[lb.kind] || 0) + 1;
      }
      if (lb && lb.set === 'eye' && !lb.removed) eye++;
      if (lb && lb.set === 'annex' && !lb.removed) {
        annex++;
        kinds[lb.kind] = (kinds[lb.kind] || 0) + 1;
      }
    }
    // total stays tower+eye only: the win-math surface is untouched
    return { tower: tower, eye: eye, annex: annex, dynamic: dyn, static: stat, total: tower + eye, towerKinds: kinds };
  },
  landmarkIntegrity: function () {
    return { tower: integrityOf('tower'), eye: integrityOf('eye'), towerTop: topIntegrity() };
  },
  annexIntegrity: function () {
    return { annex: integrityOf('annex'), total: LB.annex.total };
  },
  flag: function () {
    const F = LB.flag;
    if (!F || !F.body) return { state: 'gone' };
    const b = F.body;
    if (b.plugin.lb.removed) return { state: 'gone' };
    return {
      state: Math.abs(b.angle) < 0.5 ? 'standing' : 'fallen',
      x: Math.round(b.position.x * 10) / 10,
      y: Math.round(b.position.y * 10) / 10,
      angle: Math.round(b.angle * 1000) / 1000
    };
  },
  newGame: function () { return newGame(); },
  vehicles: function () {
    return {
      counts: LB.traffic.counts,
      list: LB.traffic.vehicles.map(function (v) {
        const lb = v.body.plugin.lb;
        return {
          id: v.id, type: v.type, state: lb.state, lane: lb.lane, dir: lb.dir,
          x: Math.round(v.body.position.x), y: Math.round(v.body.position.y)
        };
      })
    };
  },
  clock: function () {
    return LB.clock || null;
  },
  bell: function () {
    return {
      scheduled: LB.audio.bellSeq.scheduled,
      played: LB.audio.bellSeq.played,
      strikes: LB.audio.bellSeq.strikes,
      active: LB.audio.bellSeq.active,
      brokenPlayed: LB.audio.brokenPlayed,
      brokenEvents: LB.events.brokenBell
    };
  },
  playTwelve: function () { LB.audio.init(); return LB.audio.playTwelve(); },
  keepPlaying: function () { keepPlaying(); },
  tnt: function () {
    // per-block fuse state: id, position, fuse seconds remaining, blink phase
    return LB.tnts.map(function (t) {
      return {
        id: t.id,
        ben: !!t.ben,
        x: Math.round(t.body.position.x * 10) / 10,
        y: Math.round(t.body.position.y * 10) / 10,
        fuse: Math.round((t.dur - t.t) * 1000) / 1000,
        blink: tntBlinkOn(t.t, t.dur)
      };
    });
  },
  weaponFired: LB.weaponFired,
  events: LB.events,
  nuke: function () {
    const w = LB.nukeWaves[0] || null;
    return {
      nukes: LB.nukes.length,
      wave: w ? {
        x: Math.round(w.x), y: Math.round(w.y),
        r: Math.round(w.r), speed: w.speed,
        progress: Math.round(Math.min(1, w.r / 2350) * 1000) / 1000
      } : null,
      cloud: LB.mushrooms.length ? {
        t: Math.round(LB.mushrooms[0].t * 100) / 100,
        dur: LB.mushrooms[0].dur,
        stage: mushStage(LB.mushrooms[0]),
        capWidth: Math.round(mushCapParams(LB.mushrooms[0]).capA * 2),
        blobs: LB.mushrooms[0].blobs.length
      } : null
    };
  },
  landmarksRemaining: function () {
    return {
      tower: aliveOf('tower'), eye: aliveOf('eye'), annex: aliveOf('annex'),
      total: aliveOf('tower') + aliveOf('eye') + aliveOf('annex')
    };
  },
  state: function () {
    const s = fpsSamples.slice().sort(function (a, b) { return a - b; });
    const med = s.length ? s[(s.length / 2) | 0] : 0;
    return {
      phase: LB.phase, fps: med > 0 ? Math.round(1000 / med) : 0,
      particles: P.active, shake: Math.round(LB.shake),
      meteors: LB.meteors.length, holes: LB.holes.length, tornados: LB.tornados.length,
      tnts: LB.tnts.length,
      bombs: LB.bombs.length, novas: LB.novas.length, nukes: LB.nukes.length,
      nukeWaves: LB.nukeWaves.length,
      tsunamis: LB.tsunamis.length, lasers: LB.lasers.length, stones: LB.stones.length,
      vortices: LB.vortices.length, fires: LB.fires.length,
      mushrooms: LB.mushrooms.length,
      weapon: LB.weapon, pickerOpen: LB.paused,
      newGameBtn: !document.getElementById('newGameBtn').classList.contains('hidden'),
      vehiclesOnScreen: LB.traffic.vehicles.length,
      continueMode: LB.continueMode,
      time: Math.round(LB.time * 10) / 10, eyeSpinDeg: Math.round(LB.eye.spin * 10) / 10
    };
  },
  fire: function (w, x, y) { return fire(w, x, y); },
  selectWeapon: function (w) { selectWeapon(w); return LB.weapon; },
  openPicker: function () { return openPicker(); },
  closePicker: function () { return closePicker(); },
  screenToWorld: screenToWorld,
  destroyAll: destroyAll,
  reset: function () { resetWorld(); },
  // headless verification helpers: pump exact fixed steps / paint one frame
  step: function (n) {
    n = n || 1;
    for (let i = 0; i < n; i++) { stepWorld(STEP); acc = 0; }
    return LB.time;
  },
  renderFrame: function () { render(performance.now() / 1000); },
  errors: testErrors
};

/* ============================================================
   BOOT
   ============================================================ */
addGround();
buildTower();
buildAnnex();
buildEye();
warmup(300);
spawnVehicle();
spawnVehicle();
LB.bodies = M.Composite.allBodies(world);
LB.phase = 'title';
requestAnimationFrame(frame);

/* F6: PWA — register the service worker only on http/https (never on file://) */
if (location.protocol === 'http:' || location.protocol === 'https:') {
  if (navigator.serviceWorker) {
    navigator.serviceWorker.register('./sw.js').catch(function () { /* offline install is optional */ });
  }
}

})();
