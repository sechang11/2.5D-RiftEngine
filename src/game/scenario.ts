/**
 * The sandbox scenario: what actually exists on the map when the engine boots.
 *
 * This is game content, not engine. It exists to put every system on screen at
 * once — a controllable champion, a hostile champion that fights back, jungle
 * camps that leash, towers that shoot, minion waves that path across the whole
 * map and jam against each other — so that a change to collision or pathing is
 * visible within seconds rather than requiring a test to be written first.
 */

import type { Sim } from '../core/sim/sim';
import type { Unit } from '../core/ecs/types';
import { Team, UnitKind } from '../core/ecs/types';
import { setSpawnPoint } from '../core/sim/lifecycle';
import { vec2, type Vec2 } from '../core/math/vec2';
import { archetype } from './content/units';
import { laneRoute, type GameMap } from './content/map01';

export interface Scenario {
  player: Unit;
  /** Spawns one wave of minions for each team down every lane. */
  spawnWaves: () => void;
  /** Total waves spawned so far. */
  waveCount: number;
}

/** Spawns a unit from its archetype, wiring up AI and spawn point. */
export function spawnUnit(sim: Sim, archetypeId: string, team: Team, pos: Vec2): Unit {
  const arch = archetype(archetypeId);
  const unit = sim.world.spawn({
    archetype: arch.id,
    name: arch.name,
    kind: arch.kind,
    team,
    pos,
    base: arch.base,
    radius: arch.radius,
    mass: arch.mass,
    flags: arch.flags,
    abilities: arch.abilities,
  });

  setSpawnPoint(unit, pos.x, pos.y);
  if (arch.autoAcquire) unit.userData.autoAcquire = 1;

  if (arch.ai) {
    unit.brain = {
      home: vec2(pos.x, pos.y),
      route: [],
      routeIndex: 0,
      aggroRange: arch.ai.aggroRange,
      leashRange: arch.ai.leashRange,
      retargetTimer: sim.world.rng.range(0, 0.2),
      alertTimer: 0,
    };
  }

  // Nudge out of any terrain the spawn point happened to overlap.
  sim.world.nav.resolveTerrain(unit.pos, unit.radius, 8);
  unit.prevPos.x = unit.pos.x;
  unit.prevPos.y = unit.pos.y;
  return unit;
}

export function buildScenario(sim: Sim, map: GameMap): Scenario {
  const blue = map.spawns[Team.Blue];
  const red = map.spawns[Team.Red];

  // --- the player ----------------------------------------------------------
  const player = spawnUnit(sim, 'warden', Team.Blue, vec2(blue.x + 6, blue.y + 6));
  player.name = 'Warden';
  player.flags |= 1 << 6; // PlayerControlled

  // --- a hostile champion --------------------------------------------------
  // Placed down mid so it walks into the player rather than waiting to be found.
  const rival = spawnUnit(sim, 'duelist', Team.Red, vec2(28, 34));
  rival.name = 'Duelist';
  if (rival.brain) {
    rival.brain.route = laneRoute(map.lanes[1], 20, true);
    rival.brain.leashRange = 120;
    rival.brain.aggroRange = 18;
  }

  // --- training dummies ----------------------------------------------------
  // Three in a row near the fountain: the fastest way to check damage numbers,
  // attack windups and unit collision without walking anywhere.
  for (let i = 0; i < 3; i++) {
    const dummy = spawnUnit(sim, 'dummy', Team.Red, vec2(blue.x + 22 + i * 3.2, blue.y + 16));
    dummy.name = `Dummy ${i + 1}`;
  }

  // A tight cluster, to watch separation resolve a real pile-up.
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2;
    spawnUnit(
      sim,
      'footman',
      Team.Red,
      vec2(blue.x + 34 + Math.cos(angle) * 1.2, blue.y + 26 + Math.sin(angle) * 1.2),
    );
  }

  // --- jungle camps --------------------------------------------------------
  for (const camp of map.camps) {
    for (let i = 0; i < camp.count; i++) {
      const angle = (i / Math.max(1, camp.count)) * Math.PI * 2;
      const spread = camp.count > 1 ? 1.9 : 0;
      const monster = spawnUnit(
        sim,
        camp.archetype,
        Team.Neutral,
        vec2(camp.pos.x + Math.cos(angle) * spread, camp.pos.y + Math.sin(angle) * spread),
      );
      if (monster.brain) {
        monster.brain.home.x = camp.pos.x;
        monster.brain.home.y = camp.pos.y;
      }
    }
  }

  // --- towers --------------------------------------------------------------
  for (const spec of map.towers) {
    const tower = spawnUnit(sim, 'tower', spec.team, spec.pos);
    tower.name = `${spec.lane} tower`;
    tower.userData.autoAcquire = 1;
  }

  // --- minion waves --------------------------------------------------------
  const routes = new Map<string, { blue: Vec2[]; red: Vec2[] }>();
  for (const lane of map.lanes) {
    routes.set(lane.name, { blue: laneRoute(lane, 16, false), red: laneRoute(lane, 16, true) });
  }

  const scenario: Scenario = {
    player,
    waveCount: 0,
    spawnWaves: () => {
      scenario.waveCount++;
      for (const lane of map.lanes) {
        const route = routes.get(lane.name)!;
        spawnLaneWave(sim, Team.Blue, blue, route.blue);
        spawnLaneWave(sim, Team.Red, red, route.red);
      }
    },
  };

  // Open with one wave already marching so there is movement on screen at boot.
  scenario.spawnWaves();

  return scenario;
}

/** Three melee and one ranged, the classic wave shape. */
function spawnLaneWave(sim: Sim, team: Team, origin: Vec2, route: Vec2[]): void {
  const composition = ['footman', 'footman', 'footman', 'archer'];
  for (let i = 0; i < composition.length; i++) {
    // Stagger the column so they do not spawn inside one another and spend the
    // first second untangling.
    const back = i * 1.6;
    const side = (i % 2 === 0 ? 1 : -1) * 0.9;
    const spawnPos = vec2(origin.x + side - back * 0.2, origin.y - back * 0.2);
    const minion = spawnUnit(sim, composition[i], team, spawnPos);
    if (minion.brain) {
      minion.brain.route = route;
      // Skip the first waypoints that are behind the spawn point.
      minion.brain.routeIndex = Math.min(1, route.length - 1);
      minion.brain.leashRange = Infinity;
    }
  }
}

/** Counts live units by kind, for the debug panel. */
export function census(sim: Sim): Record<string, number> {
  const out: Record<string, number> = { champions: 0, minions: 0, monsters: 0, structures: 0 };
  for (const unit of sim.world.units) {
    if (unit.hp <= 0) continue;
    if (unit.kind === UnitKind.Champion) out.champions++;
    else if (unit.kind === UnitKind.Minion) out.minions++;
    else if (unit.kind === UnitKind.Monster) out.monsters++;
    else if (unit.kind === UnitKind.Structure) out.structures++;
  }
  return out;
}
