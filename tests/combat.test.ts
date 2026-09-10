/**
 * Combat maths and status rules.
 *
 * These encode decisions that are easy to get subtly wrong and hard to notice:
 * whether shields sit in front of or behind resistances, whether two slows
 * stack, whether a stun really does cancel a cast that was already paid for.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NavGrid } from '../src/core/nav/navgrid';
import { World } from '../src/core/ecs/world';
import { Sim } from '../src/core/sim/sim';
import { DamageType, StatusKind, Team, UnitKind } from '../src/core/ecs/types';
import { applyDamage, mitigate, recomputeStats } from '../src/core/combat/stats';
import { applyStatus } from '../src/core/status/statuses';
import { tryCast } from '../src/core/abilities/casting';
import { CastRejection } from '../src/core/abilities/types';
import { vec2 } from '../src/core/math/vec2';
import '../src/game/content/abilities';

function makeWorld(): World {
  const nav = new NavGrid({ cols: 64, rows: 64, cellSize: 1 });
  nav.rebuildClearance();
  return new World(nav, 99);
}

function makeUnit(world: World, overrides: Record<string, number> = {}) {
  return world.spawn({
    archetype: 'test',
    kind: UnitKind.Champion,
    team: Team.Blue,
    pos: vec2(0, 0),
    base: World.baseStats({ hpMax: 1000, armor: 0, magicResist: 0, ...overrides }),
  });
}

test('resistances follow the standard mitigation curve', () => {
  // 100 armour halves incoming physical damage.
  assert.ok(Math.abs(mitigate(100, 100) - 50) < 1e-9);
  assert.ok(Math.abs(mitigate(100, 0) - 100) < 1e-9);
  // Negative resistance amplifies with diminishing returns rather than
  // dividing by zero.
  assert.ok(mitigate(100, -100) > 100);
  assert.ok(mitigate(100, -100) < 200);
});

test('shields absorb after resistances, not before', () => {
  const world = makeWorld();
  const target = makeUnit(world, { armor: 100 });
  recomputeStats(target);
  applyStatus(world, target, {
    kind: StatusKind.Shield,
    duration: 5,
    magnitude: 30,
    source: 0,
    tag: 'test.shield',
  });

  // 100 raw against 100 armour mitigates to 50; the 30 shield eats part of
  // that, leaving 20 to health. If shields applied first, 70 would reach the
  // armour step and only 35 would land.
  const result = applyDamage(target, {
    amount: 100,
    type: DamageType.Physical,
    source: null,
    tag: 'test',
  });

  assert.ok(Math.abs(result.absorbed - 30) < 1e-6, `absorbed ${result.absorbed}`);
  assert.ok(Math.abs(result.dealt - 20) < 1e-6, `dealt ${result.dealt}`);
  assert.ok(Math.abs(target.hp - 980) < 1e-6);
});

test('true damage ignores resistances', () => {
  const world = makeWorld();
  const target = makeUnit(world, { armor: 500, magicResist: 500 });
  recomputeStats(target);
  const result = applyDamage(target, {
    amount: 100,
    type: DamageType.True,
    source: null,
    tag: 'test',
  });
  assert.ok(Math.abs(result.dealt - 100) < 1e-6);
});

test('the strongest slow wins instead of stacking to a standstill', () => {
  const world = makeWorld();
  const unit = makeUnit(world);
  const base = unit.base.moveSpeed;

  for (const pct of [0.3, 0.5, 0.2]) {
    applyStatus(world, unit, {
      kind: StatusKind.Slow,
      duration: 3,
      magnitude: pct,
      source: 0,
      tag: `slow.${pct}`,
    });
  }

  // Additive stacking would give 1 - 1.0 = zero movement.
  assert.ok(
    Math.abs(unit.stats.moveSpeed - base * 0.5) < 1e-6,
    `expected ${base * 0.5}, got ${unit.stats.moveSpeed}`,
  );
});

test('stats return exactly to base when a debuff expires', () => {
  const world = makeWorld();
  const unit = makeUnit(world);
  const base = unit.stats.moveSpeed;

  // Repeated application and expiry is where incremental stat maths drifts.
  for (let i = 0; i < 200; i++) {
    applyStatus(world, unit, {
      kind: StatusKind.Slow,
      duration: 0.05,
      magnitude: 0.4,
      source: 0,
      tag: 'churn',
    });
    unit.statuses.length = 0;
    recomputeStats(unit);
  }
  assert.equal(unit.stats.moveSpeed, base);
});

test('a stun cancels a cast in progress and stops movement', () => {
  const nav = new NavGrid({ cols: 64, rows: 64, cellSize: 1 });
  nav.rebuildClearance();
  const sim = new Sim(nav, { seed: 3 });
  const caster = sim.world.spawn({
    archetype: 'test',
    kind: UnitKind.Champion,
    team: Team.Blue,
    pos: vec2(0, 0),
    base: World.baseStats({ mpMax: 500 }),
    abilities: ['rift.r'],
  });

  // Cataclysm has a windup, so there is a window in which to interrupt it.
  const verdict = tryCast(sim.world, caster, 0, vec2(6, 0));
  assert.equal(verdict, CastRejection.Ok);
  assert.ok(caster.cast, 'the cast should be in progress');

  applyStatus(sim.world, caster, {
    kind: StatusKind.Stun,
    duration: 1,
    magnitude: 1,
    source: 0,
    tag: 'test.stun',
  });
  sim.step();

  assert.equal(caster.cast, null, 'the stun should have eaten the cast');
  assert.equal(sim.world.effects.length, 0, 'no blast should have been created');
  assert.equal(caster.stats.moveSpeed, 0, 'a stunned unit cannot move');
  // The cost is still paid: getting stunned mid-cast loses you the spell.
  assert.ok(caster.abilities[0].cooldown > 0);
  assert.ok(caster.mp < caster.stats.mpMax);
});

test('a cast is refused without the mana to pay for it', () => {
  const nav = new NavGrid({ cols: 64, rows: 64, cellSize: 1 });
  nav.rebuildClearance();
  const world = makeWorld();
  void nav;
  const caster = world.spawn({
    archetype: 'test',
    kind: UnitKind.Champion,
    team: Team.Blue,
    pos: vec2(0, 0),
    base: World.baseStats({ mpMax: 10 }),
    abilities: ['rift.r'],
  });
  caster.mp = 10;
  assert.equal(tryCast(world, caster, 0, vec2(5, 0)), CastRejection.NotEnoughMana);
  assert.equal(caster.cast, null);
});

test('entity handles do not survive their unit', () => {
  const world = makeWorld();
  const first = makeUnit(world);
  const staleId = first.id;
  world.despawn(staleId);

  // The freed slot gets reused; the old handle must not resolve to the new
  // occupant, or a projectile in flight would strike whoever replaced it.
  const second = makeUnit(world);
  assert.notEqual(second.id, staleId);
  assert.equal(world.get(staleId), null);
  assert.equal(world.get(second.id), second);
});
