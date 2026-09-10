/**
 * The determinism guarantee.
 *
 * The whole architecture is arranged around one claim: given the same seed and
 * the same command stream, two simulations produce byte-identical state. Every
 * design decision that costs something — commands instead of direct calls, a
 * seeded RNG instead of Math.random, a fixed timestep instead of variable dt —
 * is paid for by this property, because it is what replays and lockstep
 * networking are built on.
 *
 * An untested claim of determinism is just a comment, so this test asserts it
 * on a full scenario: hundreds of units, AI, pathfinding, collision, combat.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Sim } from '../src/core/sim/sim';
import { CommandType } from '../src/core/sim/commands';
import { buildMap01 } from '../src/game/content/map01';
import { buildScenario } from '../src/game/scenario';

interface ScriptedCommand {
  tick: number;
  type: CommandType;
  x: number;
  y: number;
  slot: number;
}

/** A fixed script of player actions, replayed identically into both runs. */
const SCRIPT: ScriptedCommand[] = [
  { tick: 5, type: CommandType.Move, x: -80, y: -90, slot: 0 },
  { tick: 40, type: CommandType.Cast, x: -70, y: -80, slot: 0 },
  { tick: 70, type: CommandType.Cast, x: 0, y: 0, slot: 1 },
  { tick: 95, type: CommandType.AttackMove, x: -50, y: -70, slot: 0 },
  { tick: 130, type: CommandType.Cast, x: -46, y: -66, slot: 2 },
  { tick: 180, type: CommandType.Cast, x: -40, y: -60, slot: 3 },
  { tick: 240, type: CommandType.Move, x: -100, y: -100, slot: 0 },
  { tick: 300, type: CommandType.Stop, x: 0, y: 0, slot: 0 },
];

/** Runs the scenario for `ticks` and returns a digest of the final state. */
function run(ticks: number): string {
  const map = buildMap01(4242);
  const sim = new Sim(map.nav, { tickRate: 60, seed: 987654321 });
  const scenario = buildScenario(sim, map);
  const player = scenario.player.id;

  for (let t = 0; t < ticks; t++) {
    for (const cmd of SCRIPT) {
      if (cmd.tick !== t) continue;
      sim.commands.emit(cmd.type, player, cmd.x, cmd.y, 0, cmd.slot);
    }
    // Extra waves partway through, to exercise spawning inside the replay.
    if (t === 150 || t === 320) scenario.spawnWaves();
    sim.step();
  }

  return digest(sim);
}

/**
 * A compact fingerprint of everything that must match. Positions are rounded to
 * six decimals: identical float arithmetic should be exact, and the rounding
 * only guards against a formatting difference being mistaken for a divergence.
 */
function digest(sim: Sim): string {
  const parts: string[] = [`tick=${sim.world.tick}`, `rng=${sim.world.rng.save()}`];
  const units = [...sim.world.units].sort((a, b) => a.id - b.id);
  for (const u of units) {
    parts.push(
      [
        u.id,
        u.archetype,
        u.pos.x.toFixed(6),
        u.pos.y.toFixed(6),
        u.hp.toFixed(4),
        u.mp.toFixed(4),
        u.facing.toFixed(6),
        u.order.kind,
        u.statuses.length,
        u.path.length,
      ].join(':'),
    );
  }
  for (const p of sim.world.projectiles) {
    parts.push(`p:${p.defId}:${p.pos.x.toFixed(6)}:${p.pos.y.toFixed(6)}:${p.pierce}`);
  }
  return parts.join('|');
}

test('two runs of the same seed and command script produce identical state', () => {
  const a = run(420);
  const b = run(420);
  assert.equal(a.length > 500, true, 'digest should cover a populated world');
  assert.equal(a, b, 'simulation diverged between two identical runs');
});

test('a different seed produces different state', () => {
  const map = buildMap01(4242);
  const sim = new Sim(map.nav, { tickRate: 60, seed: 1 });
  buildScenario(sim, map);
  for (let t = 0; t < 200; t++) sim.step();

  const map2 = buildMap01(4242);
  const sim2 = new Sim(map2.nav, { tickRate: 60, seed: 2 });
  buildScenario(sim2, map2);
  for (let t = 0; t < 200; t++) sim2.step();

  // Not a correctness requirement so much as a canary: if these match, the
  // seed is not actually reaching anything and the determinism test above is
  // passing for the wrong reason.
  assert.notEqual(digest(sim), digest(sim2));
});

test('the map generator is reproducible', () => {
  const a = buildMap01(777);
  const b = buildMap01(777);
  assert.deepEqual(Array.from(a.nav.flags), Array.from(b.nav.flags));
  assert.equal(a.camps.length, b.camps.length);
  assert.equal(a.towers.length, b.towers.length);
});
