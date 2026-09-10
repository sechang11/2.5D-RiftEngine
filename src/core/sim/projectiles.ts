/**
 * Projectile and delayed-effect integration.
 *
 * Projectiles are swept, not sampled. A bolt travelling 22 units per second
 * covers a third of a unit per tick, and point-sampling would let it pass
 * cleanly through a body that happens to sit between two sample positions.
 * Sweeping also gives the correct *first* victim when several are on the line,
 * which matters for a non-piercing skillshot.
 */

import type { World, Projectile } from '../ecs/world';
import type { Unit } from '../ecs/types';
import { UnitFlag } from '../ecs/types';
import { SimEventType } from '../events/bus';
import { sweepCircleEntry } from '../math/geom';
import * as V from '../math/vec2';
import { vec2 } from '../math/vec2';
import { getAbility, type EffectContext, type ProjectileHitContext } from '../abilities/types';

const candidates: Unit[] = [];
const impacts: Array<{ unit: Unit; t: number }> = [];
const impactPoint = vec2();

export function updateProjectiles(world: World, dt: number): void {
  const list = world.projectiles;

  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p.alive) continue;

    const owner = world.get(p.owner);
    // A projectile whose caster has left the world has no stats to resolve
    // against, so it is retired rather than resolving against stale data.
    if (!owner) {
      p.alive = false;
      continue;
    }

    V.copy(p.prevPos, p.pos);

    if (p.target !== 0) {
      // Homing: re-aim at the target's current position each tick. Auto-attack
      // missiles in League cannot be dodged by walking, and this reproduces it.
      const t = world.get(p.target);
      if (t && t.hp > 0) V.direction(p.dir, p.pos, t.pos);
    }

    const step = p.speed * dt;
    const nextX = p.pos.x + p.dir.x * step;
    const nextY = p.pos.y + p.dir.y * step;

    const hit = sweepAgainstUnits(world, p, nextX, nextY, owner);

    p.pos.x = nextX;
    p.pos.y = nextY;
    p.travelled += step;

    if (!p.alive) continue;

    if (p.collidesTerrain && !world.nav.isWalkableWorld(p.pos.x, p.pos.y)) {
      p.alive = false;
      world.events.push(SimEventType.Impact, world.tick, {
        source: p.owner,
        x: p.pos.x,
        y: p.pos.y,
        tag: p.defId,
      });
      continue;
    }

    if (p.travelled >= p.maxRange) {
      p.alive = false;
      world.events.push(SimEventType.Impact, world.tick, {
        source: p.owner,
        x: p.pos.x,
        y: p.pos.y,
        tag: p.defId,
      });
      continue;
    }

    // A homing missile whose target vanished expires where it is.
    if (p.target !== 0 && !hit) {
      const t = world.get(p.target);
      if (!t || t.hp <= 0) p.alive = false;
    }
  }
}

function sweepAgainstUnits(
  world: World,
  p: Projectile,
  nextX: number,
  nextY: number,
  owner: Unit,
): boolean {
  const def = getAbility(p.defId);
  if (!def) return false;

  // Query a disc that covers the whole swept segment.
  const midX = (p.pos.x + nextX) * 0.5;
  const midY = (p.pos.y + nextY) * 0.5;
  const half = Math.hypot(nextX - p.pos.x, nextY - p.pos.y) * 0.5;

  world.queryCircle(midX, midY, half + p.radius, candidates, (u) => {
    if (u.id === p.owner) return false;
    if (!(u.flags & UnitFlag.Targetable)) return false;
    if (u.team === p.team) return false;
    return p.hitList.indexOf(u.id) === -1;
  });

  if (candidates.length === 0) return false;

  const to = vec2(nextX, nextY);
  impacts.length = 0;
  for (let i = 0; i < candidates.length; i++) {
    const u = candidates[i];
    const t = sweepCircleEntry(p.pos, to, u.pos, u.radius + p.radius);
    if (t >= 0) impacts.push({ unit: u, t });
  }
  if (impacts.length === 0) return false;

  // Nearest first, so a single-target bolt strikes whoever it actually reaches.
  impacts.sort((a, b) => a.t - b.t);

  let struck = false;
  for (let i = 0; i < impacts.length && p.pierce > 0; i++) {
    const { unit, t } = impacts[i];
    impactPoint.x = p.pos.x + (nextX - p.pos.x) * t;
    impactPoint.y = p.pos.y + (nextY - p.pos.y) * t;

    p.hitList.push(unit.id);
    p.pierce--;
    struck = true;

    const ctx: ProjectileHitContext = {
      world,
      caster: owner,
      def,
      point: impactPoint,
      target: unit.id,
      rank: 1,
      victim: unit,
      impact: impactPoint,
      power: p.power,
    };
    def.onProjectileHit?.(ctx);

    world.events.push(SimEventType.ProjectileHit, world.tick, {
      source: p.owner,
      target: unit.id,
      x: impactPoint.x,
      y: impactPoint.y,
      tag: p.defId,
    });
  }

  if (p.pierce <= 0) p.alive = false;
  return struck;
}

/**
 * Ground effects that resolve after a telegraph.
 *
 * The delay is the whole point: it is the window in which a player can walk out.
 * The renderer draws the growing circle; this only counts down and resolves.
 */
export function updateEffects(world: World, dt: number): void {
  const list = world.effects;
  for (let i = 0; i < list.length; i++) {
    const fx = list[i];
    if (!fx.alive) continue;

    fx.elapsed += dt;
    if (fx.elapsed < fx.delay) continue;

    fx.alive = false;
    const def = getAbility(fx.defId);
    const owner = world.get(fx.owner);
    if (!def || !owner) continue;

    const ctx: EffectContext = {
      world,
      caster: owner,
      def,
      point: fx.pos,
      target: 0,
      rank: 1,
      origin: fx.pos,
      radius: fx.radius,
      power: fx.power,
    };
    def.onEffectResolve?.(ctx);

    world.events.push(SimEventType.Impact, world.tick, {
      source: fx.owner,
      x: fx.pos.x,
      y: fx.pos.y,
      amount: fx.radius,
      tag: fx.defId,
    });
  }
}
