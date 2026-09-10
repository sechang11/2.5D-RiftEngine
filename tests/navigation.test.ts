/**
 * Navigation and physics invariants.
 *
 * These are the properties that, when they break, produce the bugs that are
 * hardest to diagnose from a screenshot: a unit that walks through a wall, a
 * route through a gap too narrow to enter, a crowd that never untangles.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CellFlag, NavGrid } from '../src/core/nav/navgrid';
import { Pathfinder } from '../src/core/nav/pathfinder';
import { Sim } from '../src/core/sim/sim';
import { buildMap01 } from '../src/game/content/map01';
import { buildScenario } from '../src/game/scenario';
import { vec2 } from '../src/core/math/vec2';
import { UnitFlag } from '../src/core/ecs/types';

/** A room split by a wall with a single doorway of the given width, in cells. */
function corridorGrid(doorWidthCells: number): NavGrid {
  const grid = new NavGrid({ cols: 60, rows: 60, cellSize: 1 });
  // Solid wall down the middle.
  for (let cy = 0; cy < 60; cy++) grid.flags[grid.idx(30, cy)] |= CellFlag.BlockMove;
  // Punch a doorway.
  const start = 30 - Math.floor(doorWidthCells / 2);
  for (let i = 0; i < doorWidthCells; i++) {
    grid.flags[grid.idx(30, start + i)] &= ~CellFlag.BlockMove;
  }
  grid.rebuildClearance();
  return grid;
}

test('clearance keeps a wide body out of a narrow gap', () => {
  const grid = corridorGrid(1);
  const finder = new Pathfinder(grid);

  // A one-cell doorway leaves 0.5 units of clearance at its centre. A small
  // body fits; a large one must not be routed through it.
  const small = finder.find({ start: vec2(-20, 0), goal: vec2(20, 0), radius: 0.3 });
  const large = finder.find({ start: vec2(-20, 0), goal: vec2(20, 0), radius: 1.2 });

  assert.equal(small.complete, true, 'a small body should fit through a one-cell door');
  assert.equal(large.complete, false, 'a large body must not be routed through it');
});

test('a wide doorway admits a wide body', () => {
  const grid = corridorGrid(7);
  const finder = new Pathfinder(grid);
  const result = finder.find({ start: vec2(-20, 0), goal: vec2(20, 0), radius: 1.2 });

  assert.equal(result.complete, true);
  // Every waypoint must be somewhere the body actually fits.
  for (const wp of result.waypoints) {
    assert.ok(
      grid.clearanceAtWorld(wp.x, wp.y) >= 1.2,
      `waypoint ${wp.x},${wp.y} has insufficient clearance`,
    );
  }
});

test('string pulling collapses an open path to a single segment', () => {
  const grid = new NavGrid({ cols: 60, rows: 60, cellSize: 1 });
  grid.rebuildClearance();
  const finder = new Pathfinder(grid);
  const result = finder.find({ start: vec2(-20, -20), goal: vec2(20, 20), radius: 0.5 });

  assert.equal(result.complete, true);
  assert.equal(result.waypoints.length, 1, 'an unobstructed path needs one waypoint');
  assert.ok(Math.abs(result.waypoints[0].x - 20) < 1);
  assert.ok(Math.abs(result.waypoints[0].y - 20) < 1);
});

test('an unreachable goal still returns a partial route towards it', () => {
  const grid = new NavGrid({ cols: 40, rows: 40, cellSize: 1 });
  // Seal a chamber in the corner.
  for (let i = 0; i < 12; i++) {
    grid.flags[grid.idx(12, i)] |= CellFlag.BlockMove;
    grid.flags[grid.idx(i, 12)] |= CellFlag.BlockMove;
  }
  grid.rebuildClearance();
  const finder = new Pathfinder(grid);

  // From outside the chamber, towards a point inside it.
  const result = finder.find({ start: vec2(5, 5), goal: vec2(-15, -15), radius: 0.4 });
  assert.equal(result.complete, false, 'the goal is walled off');
  assert.ok(result.waypoints.length > 0, 'a partial route should still be offered');
});

test('bodies separate and never end up inside terrain', () => {
  const map = buildMap01(31337);
  const sim = new Sim(map.nav, { tickRate: 60, seed: 5 });
  const scenario = buildScenario(sim, map);

  // Stack many waves so lanes genuinely jam.
  for (let i = 0; i < 5; i++) scenario.spawnWaves();
  for (let t = 0; t < 600; t++) sim.step();

  const live = sim.world.units.filter((u) => u.hp > 0 && u.alive);
  assert.ok(live.length > 40, 'expected a crowded field');

  for (const u of live) {
    assert.ok(Number.isFinite(u.pos.x) && Number.isFinite(u.pos.y), `${u.name} has a NaN position`);
    // The solver tolerates a small overlap with terrain rather than fighting
    // it every tick; anything beyond that is a body genuinely inside a wall.
    assert.ok(
      map.nav.clearanceAtWorld(u.pos.x, u.pos.y) >= u.radius - 0.15,
      `${u.name} ended up inside terrain at ${u.pos.x.toFixed(1)},${u.pos.y.toFixed(1)}`,
    );
  }

  let worstRatio = 0;
  let worstPair = '';
  for (let i = 0; i < live.length; i++) {
    const a = live[i];
    if (!(a.flags & UnitFlag.Collides) || a.flags & UnitFlag.Ghosted) continue;
    for (let j = i + 1; j < live.length; j++) {
      const b = live[j];
      if (!(b.flags & UnitFlag.Collides) || b.flags & UnitFlag.Ghosted) continue;
      if (a.flags & UnitFlag.Immovable && b.flags & UnitFlag.Immovable) continue;
      const d = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
      const ratio = (a.radius + b.radius - d) / Math.min(a.radius, b.radius);
      if (ratio > worstRatio) {
        worstRatio = ratio;
        worstPair = `${a.name} / ${b.name}`;
      }
    }
  }

  // A positional solver always leaves some residual overlap under crowd
  // pressure, and a little is desirable: it is what lets units squeeze past
  // each other instead of locking up. The bar is that it stay invisible.
  // tools/bench.ts measures about 0.13 of a radius at the shipped iteration
  // count, so 0.25 catches a regression with room for scenario variance.
  assert.ok(
    worstRatio < 0.25,
    `worst overlap is ${(worstRatio * 100).toFixed(0)}% of a body radius (${worstPair})`,
  );
});

test('lane corridors keep both bases connected', () => {
  const map = buildMap01(2024);
  const finder = new Pathfinder(map.nav);
  const result = finder.find({
    start: map.spawns[1],
    goal: map.spawns[2],
    radius: 0.7,
    maxExpansions: 200000,
  });
  assert.equal(result.complete, true, 'the map generator produced an unreachable base');
});
