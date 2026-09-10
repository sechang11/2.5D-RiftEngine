/**
 * Props, scenes, modifiers and items.
 *
 * These cover the systems the editor stands on. The one that matters most is
 * navigation restoration: placing and removing a blocking object has to leave
 * terrain exactly as it was, or a dressing session slowly corrupts the map
 * underneath the person doing it, and nothing about the symptom points at the
 * cause.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CellFlag, NavGrid } from '../src/core/nav/navgrid';
import { PropFlag, PropStore } from '../src/core/world/props';
import { Sim } from '../src/core/sim/sim';
import { buildMap01 } from '../src/game/content/map01';
import { World } from '../src/core/ecs/world';
import { Team, UnitKind } from '../src/core/ecs/types';
import { recomputeStats, setModifiers, removeModifiers } from '../src/core/combat/stats';
import { itemForAsset } from '../src/game/content/items';
import type { AssetEntry } from '../src/render/assets';
import * as scene from '../src/game/scene';
import { vec2 } from '../src/core/math/vec2';

function grid(): NavGrid {
  const g = new NavGrid({ cols: 80, rows: 80, cellSize: 1 });
  g.rebuildClearance();
  return g;
}

test('a blocking prop closes ground and removing it reopens exactly the same ground', () => {
  const nav = grid();
  const before = Array.from(nav.flags);
  const props = new PropStore(nav);

  assert.equal(nav.isWalkableWorld(0, 0), true);

  const prop = props.add({
    assetId: 'building_keep',
    x: 0,
    y: 0,
    flags: PropFlag.Blocks | PropFlag.Opaque,
    radius: 3,
  });
  props.rebuildNav();

  assert.equal(nav.isWalkableWorld(0, 0), false, 'the prop should block its own footprint');
  assert.equal(nav.blocksVision(nav.colAt(0), nav.rowAt(0)), true, 'and should block sight');
  assert.equal(nav.isWalkableWorld(20, 20), true, 'but nothing far away');

  props.remove(prop.id);
  props.rebuildNav();

  // Byte-for-byte, not merely "walkable again". Un-stamping instead of
  // rebuilding from a pristine base is what gets this wrong once two props
  // overlap, and the damage is invisible until something cannot path.
  assert.deepEqual(Array.from(nav.flags), before, 'terrain must be restored exactly');
});

test('overlapping props do not tear holes in each other when one is removed', () => {
  const nav = grid();
  const props = new PropStore(nav);

  const a = props.add({ assetId: 'rock', x: 0, y: 0, flags: PropFlag.Blocks, radius: 3 });
  props.add({ assetId: 'rock', x: 2, y: 0, flags: PropFlag.Blocks, radius: 3 });
  props.rebuildNav();

  props.remove(a.id);
  props.rebuildNav();

  // The surviving prop still covers the origin even though the removed one
  // also did.
  assert.equal(nav.isWalkableWorld(2, 0), false, 'the remaining prop must still block');
  assert.equal(nav.isWalkableWorld(-2.6, 0), true, 'and the removed one must be gone');
});

test('pathfinding routes around a wall built out of props', () => {
  const nav = grid();
  const props = new PropStore(nav);
  const sim = new Sim(nav, { seed: 4 });

  const direct = sim.world.pathfinder.find({ start: vec2(-20, 0), goal: vec2(20, 0), radius: 0.6 });
  assert.equal(direct.waypoints.length, 1, 'open ground needs one waypoint');

  // A barricade with a gap at one end.
  for (let y = -30; y <= 20; y += 2) {
    props.add({ assetId: 'crate', x: 0, y, flags: PropFlag.Blocks, radius: 1.4 });
  }
  props.rebuildNav();

  const around = sim.world.pathfinder.find({ start: vec2(-20, 0), goal: vec2(20, 0), radius: 0.6 });
  assert.equal(around.complete, true, 'the gap should still be reachable');
  assert.ok(around.waypoints.length > 1, 'the route must bend around the wall');
  // Every waypoint has to be somewhere the body actually fits.
  for (const wp of around.waypoints) {
    assert.ok(nav.clearanceAtWorld(wp.x, wp.y) >= 0.6, 'waypoint is inside the barricade');
  }
});

test('a scene round-trips through serialization', () => {
  const map = buildMap01(1234);
  const sim = new Sim(map.nav, { seed: 9 });
  const props = new PropStore(map.nav);

  props.add({ assetId: 'nature_oak', x: 12.5, y: -4.25, rotation: 1.1, scale: 1.4, flags: PropFlag.Blocks, radius: 2 });
  props.add({ assetId: 'weapon_longsword', x: -3, y: 8, flags: PropFlag.Pickup, radius: 0.4, item: 'weapon_longsword' });
  props.add({ assetId: 'prop_barrel', x: 0, y: 0, radius: 0.5 });

  const saved = scene.serialize('test', 1234, props, sim);
  assert.equal(saved.props.length, 3);

  const fresh = new PropStore(map.nav);
  const result = scene.deserialize(saved, fresh, sim, {
    spawnUnits: false,
    radiusOf: () => 2,
  });

  assert.equal(result.props, 3);
  assert.equal(fresh.props.length, 3);

  const oak = fresh.props.find((p) => p.assetId === 'nature_oak');
  assert.ok(oak);
  assert.ok(Math.abs(oak.x - 12.5) < 1e-3);
  assert.ok(Math.abs(oak.y + 4.25) < 1e-3);
  assert.ok(Math.abs(oak.rotation - 1.1) < 1e-3);
  assert.ok(Math.abs(oak.scale - 1.4) < 1e-3);
  assert.equal((oak.flags & PropFlag.Blocks) !== 0, true);

  const sword = fresh.props.find((p) => p.assetId === 'weapon_longsword');
  assert.equal(sword?.item, 'weapon_longsword');
});

test('modifiers apply flat before percentage, and removal restores base exactly', () => {
  const nav = grid();
  const world = new World(nav, 5);
  const unit = world.spawn({
    archetype: 'test',
    kind: UnitKind.Champion,
    team: Team.Blue,
    pos: vec2(0, 0),
    base: World.baseStats({ attackDamage: 100, hpMax: 1000 }),
  });
  recomputeStats(unit);
  const baseAd = unit.stats.attackDamage;

  setModifiers(unit, 'itemA', [
    { stat: 'attackDamage', add: 50, source: 'itemA' },
    { stat: 'attackDamage', mul: 0.1, source: 'itemA' },
  ]);
  // Flat first: (100 + 50) * 1.1 = 165. Percentage first would give 160.
  assert.ok(Math.abs(unit.stats.attackDamage - 165) < 1e-6, `got ${unit.stats.attackDamage}`);

  // Two sources of the same percentage sum, so order cannot matter.
  setModifiers(unit, 'itemB', [{ stat: 'attackDamage', mul: 0.1, source: 'itemB' }]);
  assert.ok(Math.abs(unit.stats.attackDamage - 100 - 50 - 30) < 1e-6, `got ${unit.stats.attackDamage}`);

  removeModifiers(unit, 'itemA');
  removeModifiers(unit, 'itemB');
  assert.equal(unit.stats.attackDamage, baseAd);
});

test('raising a health cap does not leave the unit over it when it is lowered again', () => {
  const nav = grid();
  const world = new World(nav, 5);
  const unit = world.spawn({
    archetype: 'test',
    kind: UnitKind.Champion,
    team: Team.Blue,
    pos: vec2(0, 0),
    base: World.baseStats({ hpMax: 1000 }),
  });
  setModifiers(unit, 'item', [{ stat: 'hpMax', add: 500, source: 'item' }]);
  unit.hp = unit.stats.hpMax;
  assert.equal(unit.hp, 1500);

  removeModifiers(unit, 'item');
  assert.equal(unit.stats.hpMax, 1000);
  assert.ok(unit.hp <= unit.stats.hpMax, 'health must be clamped back under the cap');
});

test('item stats are derived from the asset, so a bigger weapon hits harder and slower', () => {
  const make = (id: string, name: string, category: string, height: number, tags: string[] = []): AssetEntry => ({
    id,
    name,
    category,
    tags,
    mesh: id + '.glb',
    size: [0.4, height, 0.2],
    radius: 0.3,
    triangles: 2000,
    bytes: 40000,
  });

  const dagger = itemForAsset(make('weapon_dagger', 'Dagger', 'weapon', 0.5));
  const greatsword = itemForAsset(make('weapon_greatsword', 'Greatsword', 'weapon', 1.9));
  assert.ok(dagger && greatsword);

  const adOf = (i: NonNullable<typeof dagger>): number =>
    i.modifiers.filter((m) => m.stat === 'attackDamage').reduce((s, m) => s + (m.add ?? 0), 0);
  const asOf = (i: NonNullable<typeof dagger>): number =>
    i.modifiers.filter((m) => m.stat === 'attackSpeed').reduce((s, m) => s + (m.mul ?? 0), 0);

  assert.ok(adOf(greatsword) > adOf(dagger), 'the bigger weapon should hit harder');
  assert.ok(asOf(greatsword) < asOf(dagger), 'and swing slower');

  // A staff is a caster implement, not a club.
  const staff = itemForAsset(make('weapon_staff_wizard', 'Wizard Staff', 'weapon', 2.0, ['staff']));
  assert.ok(staff);
  assert.ok(staff.modifiers.some((m) => m.stat === 'abilityPower'));
  assert.ok(!staff.modifiers.some((m) => m.stat === 'attackDamage'));

  // Potions are consumed rather than worn.
  const potion = itemForAsset(make('pickup_potion_red', 'Health Potion', 'pickup', 0.3, ['potion']));
  assert.ok(potion?.consume?.heal);

  // Scenery is not an item at all.
  assert.equal(itemForAsset(make('nature_oak', 'Oak', 'nature', 7)), null);
});

test('the prop store finds what is under a point and what is near one', () => {
  const nav = grid();
  const props = new PropStore(nav);
  const tree = props.add({ assetId: 'nature_oak', x: 5, y: 5, radius: 1.2 });
  props.add({ assetId: 'prop_barrel', x: 20, y: 20, radius: 0.5 });

  assert.equal(props.pick(5.2, 5.1)?.id, tree.id);
  assert.equal(props.pick(40, 40), null);

  const out: ReturnType<PropStore['query']> = [];
  props.query(5, 5, 2, out);
  assert.equal(out.length, 1);

  // Flags are respected by the nearest-with-filter search the interaction
  // prompt uses.
  assert.equal(props.nearest(5, 5, 3, (p) => (p.flags & PropFlag.Pickup) !== 0), null);
});

test('the map generator still marks brush as walkable but opaque', () => {
  const map = buildMap01(555);
  let brushCells = 0;
  for (let i = 0; i < map.nav.flags.length; i++) {
    if (map.nav.flags[i] & CellFlag.Brush) {
      brushCells++;
      assert.equal((map.nav.flags[i] & CellFlag.BlockMove) === 0, true, 'brush must stay walkable');
    }
  }
  assert.ok(brushCells > 100, 'the map should have brush on it');
});
