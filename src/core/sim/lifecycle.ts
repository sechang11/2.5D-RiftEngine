/**
 * Regeneration, death and respawn.
 *
 * Champions persist through death as a corpse with a respawn timer, because the
 * camera, the HUD and the player's ability bar all hold a reference to that unit
 * and should not have to cope with it vanishing. Everything else is removed from
 * the world the moment it dies; the renderer plays its death effect from the
 * event, which does not need the unit to still exist.
 */

import type { World } from '../ecs/world';
import type { Unit } from '../ecs/types';
import { NO_ENTITY, OrderKind, UnitFlag, UnitKind } from '../ecs/types';
import { SimEventType } from '../events/bus';
import { recomputeStats } from '../combat/stats';
import { cancelAttack } from '../combat/autoattack';
import { cancelCast } from '../abilities/casting';
import { clearPath } from './locomotion';

/** Seconds a champion stays down. A real game scales this with level and time. */
const RESPAWN_SECONDS = 7;

export function updateRegeneration(world: World, dt: number): void {
  const units = world.units;
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (u.hp <= 0 || !u.alive) continue;
    if (u.hp < u.stats.hpMax) u.hp = Math.min(u.stats.hpMax, u.hp + u.stats.hpRegen * dt);
    if (u.mp < u.stats.mpMax) u.mp = Math.min(u.stats.mpMax, u.mp + u.stats.mpRegen * dt);
  }
}

/**
 * Handles units that hit zero health this tick, and ticks respawn timers.
 *
 * Iterating backwards matters: despawn swaps the last unit into the current
 * slot, so a forward loop would skip whoever got moved.
 */
export function updateDeaths(world: World, dt: number): void {
  const units = world.units;

  for (let i = units.length - 1; i >= 0; i--) {
    const unit = units[i];

    if (unit.hp <= 0 && unit.alive) {
      killUnit(world, unit);
      if (unit.kind !== UnitKind.Champion) {
        world.despawn(unit.id);
      }
      continue;
    }

    if (!unit.alive && unit.respawnTimer > 0) {
      unit.respawnTimer -= dt;
      if (unit.respawnTimer <= 0) respawn(world, unit);
    }
  }
}

function killUnit(world: World, unit: Unit): void {
  unit.alive = false;
  unit.hp = 0;
  unit.vel.x = 0;
  unit.vel.y = 0;
  unit.flags &= ~UnitFlag.Targetable;
  unit.flags &= ~UnitFlag.RevealsFog;
  unit.flags &= ~UnitFlag.Collides;
  unit.statuses.length = 0;
  unit.dash = null;
  cancelCast(world, unit, 'died');
  cancelAttack(unit);
  clearPath(unit);
  unit.order.kind = OrderKind.Stop;
  unit.order.target = NO_ENTITY;
  recomputeStats(unit);

  unit.respawnTimer = unit.kind === UnitKind.Champion ? RESPAWN_SECONDS : -1;

  world.events.push(SimEventType.Death, world.tick, {
    source: unit.id,
    target: unit.id,
    x: unit.pos.x,
    y: unit.pos.y,
    tag: unit.archetype,
  });
}

function respawn(world: World, unit: Unit): void {
  const sx = unit.userData.spawnX ?? 0;
  const sy = unit.userData.spawnY ?? 0;
  unit.pos.x = sx;
  unit.pos.y = sy;
  unit.prevPos.x = sx;
  unit.prevPos.y = sy;
  unit.alive = true;
  unit.respawnTimer = -1;
  unit.flags |= UnitFlag.Targetable | UnitFlag.RevealsFog | UnitFlag.Collides;
  recomputeStats(unit);
  unit.hp = unit.stats.hpMax;
  unit.mp = unit.stats.mpMax;
  for (let i = 0; i < unit.abilities.length; i++) unit.abilities[i].cooldown = 0;
  world.nav.resolveTerrain(unit.pos, unit.radius, 8);

  world.events.push(SimEventType.Spawn, world.tick, {
    source: unit.id,
    target: unit.id,
    x: unit.pos.x,
    y: unit.pos.y,
    tag: unit.archetype,
  });
}

/** Marks a unit's spawn point, used on respawn. */
export function setSpawnPoint(unit: Unit, x: number, y: number): void {
  unit.userData.spawnX = x;
  unit.userData.spawnY = y;
}
