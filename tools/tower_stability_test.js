/* Node stability harness for the rebuilt Elizabeth Tower (t_0c446779).
   Extracts TOWER_PLAN from game.js (single source of truth), replicates the
   build + warmup exactly, then simulates 90 s of physics and checks the
   tower does not self-collapse.
   BASELINE RULE (learned the hard way): drift is measured from SPAWN
   positions, never from the post-warmup state — a tower that pancakes
   during warmup and then sleeps looks "stable" if you baseline late. */
'use strict';
const fs = require('fs');
const path = require('path');
const Matter = require(path.join(__dirname, '..', 'vendor', 'matter.min.js'));

const src = fs.readFileSync(path.join(__dirname, '..', 'game.js'), 'utf8');
const m = src.match(/const TOWER_PLAN = \[[\s\S]*?\n\];/);
if (!m) { console.error('TOWER_PLAN not found in game.js'); process.exit(1); }
const TOWER_PLAN = eval('(' + m[0].slice(m[0].indexOf('[')).replace(/;\s*$/, '') + ')');
const planCols = Math.max(...TOWER_PLAN.map(s => s.cols));
const BW = planCols >= 14 ? 11 : 10;
const COLS = planCols;
const GROUND_Y = 790, TOWER_X = 400, STEP = 1000 / 60;

// count planned blocks
let planned = 0;
TOWER_PLAN.forEach(s => planned += s.rows * s.cols);
console.log('planned blocks:', planned, '(target 400-550)');

const engine = Matter.Engine.create({ enableSleeping: true });
engine.gravity.y = 0.6;
engine.positionIterations = 12;
engine.velocityIterations = 6;
engine.constraintIterations = 3;
const world = engine.world;

const ground = Matter.Bodies.rectangle(800, 811, 2900, 42, { isStatic: true, friction: 0.95, frictionStatic: 1, restitution: 0 });
Matter.Composite.add(world, ground);

const X0 = TOWER_X - (COLS * BW) / 2;
const blocks = [];
let topY = GROUND_Y;
let shaftRow = 0;
const t0 = Date.now();
for (const sec of TOWER_PLAN) {
  const start = Math.floor((COLS - sec.cols) / 2);
  for (let r = 0; r < sec.rows; r++) {
    const cy = topY - sec.h / 2;
    for (let c = start; c < start + sec.cols; c++) {
      const x = X0 + (c + 0.5) * BW;
      const b = Matter.Bodies.rectangle(x, cy, BW - 0.35, sec.h, {
        friction: 0.8, frictionStatic: 1.0, restitution: 0.01, density: 0.0012,
        frictionAir: 0.02, sleepThreshold: 50
      });
      Matter.Composite.add(world, b);
      blocks.push(b);
    }
    topY -= sec.h;
    if (sec.kind === 'shaft') shaftRow++;
  }
}
console.log('built blocks:', blocks.length, 'in', Date.now() - t0, 'ms; top at y =', Math.round(topY));

// BASELINE AT SPAWN (pre-warmup!) — a post-warmup baseline hides a collapse
const y0 = blocks.map(b => b.position.y);
const x0 = blocks.map(b => b.position.x);

// warmup exactly like the game: 300 full fixed steps
for (let i = 0; i < 300; i++) Matter.Engine.update(engine, STEP);

// judge the warmup itself against spawn positions — same 55px rule as the
// game's own integrityOf('tower') (dist from origin < 55 = intact)
let warmFell = 0, warmDrift = 0;
for (let k = 0; k < blocks.length; k++) {
  if (blocks[k].position.y > y0[k] + 55) warmFell++;
  warmDrift = Math.max(warmDrift, Math.abs(blocks[k].position.y - y0[k]));
}
console.log('after warmup: asleep', blocks.filter(b => b.isSleeping).length + '/' + blocks.length,
  '| blocks moved >55px from SPAWN:', warmFell, '| max settle drift:', warmDrift.toFixed(1) + 'px');
if (warmFell > 0) {
  console.log('UNSTABLE ✗ tower collapsed during warmup (' + warmFell + ' blocks fell)');
  process.exit(2);
}

// record settled state for the live-phase check
const ys = blocks.map(b => b.position.y);
const xs = blocks.map(b => b.position.x);

// simulate 90 s (5400 steps), sample every 300 steps (5 s), drift vs settled state
const SIM = 5400;
const t1 = Date.now();
let fell = 0, maxTopDrift = 0, maxSideDrift = 0;
for (let i = 1; i <= SIM; i++) {
  Matter.Engine.update(engine, STEP);
  if (i % 300 === 0) {
    fell = 0; maxTopDrift = 0; maxSideDrift = 0;
    for (let k = 0; k < blocks.length; k++) {
      const b = blocks[k];
      if (b.position.y > ys[k] + 30) fell++;
      maxTopDrift = Math.max(maxTopDrift, Math.abs(b.position.y - ys[k]));
      maxSideDrift = Math.max(maxSideDrift, Math.abs(b.position.x - xs[k]));
    }
    const secs = (i / 60).toFixed(0);
    console.log(`t=${secs}s fell(>30px down): ${fell}  maxDriftY: ${maxTopDrift.toFixed(1)}px  maxDriftX: ${maxSideDrift.toFixed(1)}px`);
  }
}
const simMs = Date.now() - t1;
console.log('sim: 5400 steps in', simMs, 'ms →', Math.round(54000 / simMs), 'steps/wall-ms (headless, ~live needs only 1 step per frame)');

// final verdict vs the settled (standing) state
let finalFell = 0;
for (let k = 0; k < blocks.length; k++) if (blocks[k].position.y > ys[k] + 30) finalFell++;
console.log(finalFell === 0 ? 'STABLE ✓ (no block dropped >30px in 90s after a clean warmup)' : 'UNSTABLE ✗ ' + finalFell + ' blocks fell');
process.exit(finalFell === 0 ? 0 : 2);
