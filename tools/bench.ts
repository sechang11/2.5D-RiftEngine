/**
 * Headless simulation benchmark.
 *
 * Runs the full scenario without a renderer and reports per-tick cost and
 * collision quality across solver settings. The point is to make the tuning
 * decision on measurements rather than on feel: separation iterations trade
 * CPU against how tightly bodies pack, and the right number is whichever one
 * stops buying visible improvement.
 *
 *   npm run bench
 */

import { Sim } from '../src/core/sim/sim';
import { buildMap01 } from '../src/game/content/map01';
import { buildScenario } from '../src/game/scenario';
import { UnitFlag } from '../src/core/ecs/types';

const TICKS = 600;
const WAVES = 5;

interface Result {
  iterations: number;
  units: number;
  msPerTick: string;
  worstOverlap: string;
  overlapVsRadius: string;
  touchingPairs: number;
  meanOverlap: string;
  stuckInTerrain: number;
}

function measure(iterations: number): Result {
  const map = buildMap01(31337);
  const sim = new Sim(map.nav, { tickRate: 60, seed: 5, collisionIterations: iterations });
  const scenario = buildScenario(sim, map);
  for (let i = 0; i < WAVES; i++) scenario.spawnWaves();

  const started = performance.now();
  for (let t = 0; t < TICKS; t++) sim.step();
  const elapsed = performance.now() - started;

  const live = sim.world.units.filter((u) => u.hp > 0 && u.alive);
  let worst = 0;
  let worstSmallerRadius = 1;
  let sum = 0;
  let pairs = 0;
  let stuck = 0;

  for (const u of live) {
    if (map.nav.clearanceAtWorld(u.pos.x, u.pos.y) < u.radius - 0.15) stuck++;
  }

  for (let i = 0; i < live.length; i++) {
    const a = live[i];
    if (!(a.flags & UnitFlag.Collides) || a.flags & UnitFlag.Ghosted) continue;
    for (let j = i + 1; j < live.length; j++) {
      const b = live[j];
      if (!(b.flags & UnitFlag.Collides) || b.flags & UnitFlag.Ghosted) continue;
      if (a.flags & UnitFlag.Immovable && b.flags & UnitFlag.Immovable) continue;
      const d = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
      const overlap = a.radius + b.radius - d;
      if (overlap <= 0.005) continue;
      sum += overlap;
      pairs++;
      if (overlap > worst) {
        worst = overlap;
        worstSmallerRadius = Math.min(a.radius, b.radius);
      }
    }
  }

  return {
    iterations,
    units: live.length,
    msPerTick: (elapsed / TICKS).toFixed(3),
    worstOverlap: worst.toFixed(4),
    overlapVsRadius: (worst / worstSmallerRadius).toFixed(3),
    touchingPairs: pairs,
    meanOverlap: pairs ? (sum / pairs).toFixed(4) : '0',
    stuckInTerrain: stuck,
  };
}

const rows = [1, 2, 3, 4, 6, 8].map(measure);
console.table(rows);
