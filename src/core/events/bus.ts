/**
 * Frame-scoped event queue.
 *
 * The simulation never touches the renderer. When something worth seeing
 * happens it pushes an event, and the view drains the queue once per frame to
 * spawn floating numbers, impact flashes and log lines.
 *
 * The queue is drained, not subscribed to, on purpose: a subscriber list would
 * let view code run in the middle of a sim tick and mutate state mid-solve.
 */

import type { EntityId } from '../ecs/types';
import type { DamageType } from '../ecs/types';
import type { Vec2 } from '../math/vec2';

export const enum SimEventType {
  Damage = 0,
  Heal = 1,
  Death = 2,
  Spawn = 3,
  CastStart = 4,
  CastFire = 5,
  CastCancel = 6,
  ProjectileHit = 7,
  StatusApplied = 8,
  OrderIssued = 9,
  Impact = 10,
  LevelUp = 11,
}

export interface SimEvent {
  type: SimEventType;
  tick: number;
  source: EntityId;
  target: EntityId;
  /** World position the event happened at. */
  x: number;
  y: number;
  /** Damage dealt, heal amount, shield absorbed, and so on. */
  amount: number;
  damageType: DamageType;
  /** Ability id, status tag, or free-form label. */
  tag: string;
  /** True when the damage was a critical strike or the effect was empowered. */
  crit: boolean;
}

export class EventBus {
  private queue: SimEvent[] = [];
  private pool: SimEvent[] = [];

  push(
    type: SimEventType,
    tick: number,
    opts: Partial<Omit<SimEvent, 'type' | 'tick'>> = {},
  ): void {
    const e = this.pool.pop() ?? {
      type,
      tick,
      source: 0,
      target: 0,
      x: 0,
      y: 0,
      amount: 0,
      damageType: 0 as DamageType,
      tag: '',
      crit: false,
    };
    e.type = type;
    e.tick = tick;
    e.source = opts.source ?? 0;
    e.target = opts.target ?? 0;
    e.x = opts.x ?? 0;
    e.y = opts.y ?? 0;
    e.amount = opts.amount ?? 0;
    e.damageType = opts.damageType ?? (0 as DamageType);
    e.tag = opts.tag ?? '';
    e.crit = opts.crit ?? false;
    this.queue.push(e);
  }

  pushAt(type: SimEventType, tick: number, pos: Vec2, opts: Partial<SimEvent> = {}): void {
    this.push(type, tick, { ...opts, x: pos.x, y: pos.y });
  }

  get pending(): readonly SimEvent[] {
    return this.queue;
  }

  /** Hands the accumulated events to the consumer and recycles them. */
  drain(consume: (e: SimEvent) => void): void {
    for (let i = 0; i < this.queue.length; i++) consume(this.queue[i]);
    for (let i = 0; i < this.queue.length; i++) this.pool.push(this.queue[i]);
    this.queue.length = 0;
  }

  clear(): void {
    for (let i = 0; i < this.queue.length; i++) this.pool.push(this.queue[i]);
    this.queue.length = 0;
  }
}
