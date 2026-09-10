/**
 * The 2D overlay: health bars, cast bars and floating combat text.
 *
 * These are drawn on a plain canvas above the WebGL view rather than as world
 * geometry or DOM nodes. Health bars must stay the same pixel size at every
 * zoom level, text has to stay crisp, and there can be a hundred of them, so
 * billboarded sprites would be both blurrier and slower. One canvas, one pass,
 * no layout cost.
 */

import type { World } from '../core/ecs/world';
import type { SimEvent } from '../core/events/bus';
import { SimEventType } from '../core/events/bus';
import type { Unit } from '../core/ecs/types';
import { CastPhase, DamageType, StatusKind, Team, UnitKind } from '../core/ecs/types';
import { shieldAmount } from '../core/status/statuses';
import { clamp01 } from '../core/math/scalar';
import { Vector3 } from 'three';
import type { RtsCamera } from './camera';
import type { UnitViews } from './unitview';
import { TEAM_CSS } from '../game/content/units';

/**
 * A caption pinned to a point in the world.
 *
 * Used by the asset museum to name each exhibit. Drawn on the overlay rather
 * than as world geometry for the same reason health bars are: text has to stay
 * the same size and stay readable at every zoom, and a billboarded texture is
 * blurrier and slower.
 */
export interface WorldLabel {
  x: number;
  /** Height above the ground to anchor at. */
  height: number;
  y: number;
  text: string;
  /** Smaller second line, for dimensions or a triangle count. */
  sub?: string;
  size?: number;
  colour?: string;
}

interface FloatingText {
  text: string;
  x: number;
  y: number;
  vy: number;
  age: number;
  life: number;
  color: string;
  size: number;
  active: boolean;
}

const BAR_WIDTH: Record<UnitKind, number> = {
  [UnitKind.Champion]: 62,
  [UnitKind.Minion]: 30,
  [UnitKind.Monster]: 46,
  [UnitKind.Structure]: 76,
  [UnitKind.Ward]: 24,
};

const DAMAGE_COLOR: Record<DamageType, string> = {
  [DamageType.Physical]: '#ffb36b',
  [DamageType.Magic]: '#c9a0ff',
  [DamageType.True]: '#ffffff',
};

/** Pixels a damage number rises over its lifetime. */
const FLOAT_RISE = 52;

export class Overlay {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texts: FloatingText[] = [];
  private readonly anchor = new Vector3();
  private dpr = 1;
  private width = 1;
  private height = 1;

  /** Draw health bars for every unit, or only for damaged ones. */
  alwaysShowBars = true;

  /** Captions pinned to world positions. Set by the host, drawn every frame. */
  labels: readonly WorldLabel[] = [];

  /**
   * Labels further than this from the camera's focus are skipped.
   *
   * A museum holds a couple of hundred captions and only a handful are ever
   * legible. Projecting all of them is wasted work, and drawing all of them is
   * a wall of overlapping text.
   */
  labelRange = 26;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D overlay context unavailable');
    this.ctx = ctx;
  }

  resize(width: number, height: number, dpr: number): void {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.floor(width * dpr);
    this.canvas.height = Math.floor(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }

  /** Turns simulation events into floating text. */
  consume(event: SimEvent, world: World): void {
    switch (event.type) {
      case SimEventType.Damage: {
        if (event.amount < 1) return;
        const value = Math.round(event.amount);
        this.spawnText(
          event.x,
          event.y,
          String(value),
          DAMAGE_COLOR[event.damageType] ?? '#ffffff',
          event.crit ? 22 : 15,
        );
        break;
      }
      case SimEventType.Heal: {
        if (event.amount < 1) return;
        this.spawnText(event.x, event.y, `+${Math.round(event.amount)}`, '#7dffa8', 15);
        break;
      }
      case SimEventType.Death: {
        const unit = world.get(event.source);
        const name = unit ? unit.name : 'Unit';
        if (unit && unit.kind !== UnitKind.Minion) {
          this.spawnText(event.x, event.y, `${name} slain`, '#ffd36b', 17);
        }
        break;
      }
      default:
        break;
    }
  }

  private spawnText(x: number, y: number, text: string, color: string, size: number): void {
    let slot = this.texts.find((t) => !t.active);
    if (!slot) {
      slot = { text: '', x: 0, y: 0, vy: 0, age: 0, life: 1, color: '#fff', size: 14, active: false };
      this.texts.push(slot);
    }
    slot.active = true;
    slot.text = text;
    slot.x = x;
    slot.y = y;
    // A little horizontal scatter stops stacked numbers from overlapping exactly.
    slot.vy = 0;
    slot.age = 0;
    slot.life = 0.95;
    slot.color = color;
    slot.size = size;
  }

  /**
   * Draws the whole overlay.
   *
   * Bars are skipped for units the viewing team cannot see, and faded with the
   * same smoothed visibility the meshes use so a unit stepping into brush does
   * not leave its bar behind for a frame.
   */
  draw(
    world: World,
    camera: RtsCamera,
    views: UnitViews,
    viewTeam: Team,
    selected: ReadonlySet<number>,
    dt: number,
    fogEnabled: boolean,
  ): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

    const units = world.units;
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      if (unit.hp <= 0 || !unit.alive) continue;

      const visibility = views.visibilityOf(unit.id);
      if (fogEnabled && visibility < 0.1) continue;

      views.anchorFor(camera, unit, this.anchor);
      if (this.anchor.z > 1) continue;
      const sx = this.anchor.x;
      const sy = this.anchor.y;
      if (sx < -80 || sy < -60 || sx > this.width + 80 || sy > this.height + 60) continue;

      this.drawUnitBars(unit, sx, sy, viewTeam, selected.has(unit.id), visibility);
    }

    this.drawLabels(camera);
    this.drawFloatingText(camera, dt);
  }

  /**
   * Draws world-pinned captions, nearest last so the closest one wins any
   * overlap, and fading with distance so a crowded hall stays readable.
   */
  private drawLabels(camera: RtsCamera): void {
    if (this.labels.length === 0) return;
    const ctx = this.ctx;
    const fx = camera.focusX;
    const fy = camera.focusY;
    const range = this.labelRange;

    const visible: Array<{ label: WorldLabel; sx: number; sy: number; d: number }> = [];
    for (const label of this.labels) {
      const d = Math.hypot(label.x - fx, label.y - fy);
      if (d > range) continue;
      camera.worldToScreen(label.x, label.height, label.y, this.anchor);
      if (this.anchor.z > 1) continue;
      if (this.anchor.x < -120 || this.anchor.x > this.width + 120) continue;
      if (this.anchor.y < -60 || this.anchor.y > this.height + 60) continue;
      visible.push({ label, sx: this.anchor.x, sy: this.anchor.y, d });
    }

    visible.sort((a, b) => b.d - a.d);

    ctx.textAlign = 'center';
    for (const { label, sx, sy, d } of visible) {
      // Full strength up close, fading out over the last third of the range.
      const alpha = Math.min(1, Math.max(0, (range - d) / (range * 0.35)));
      const size = label.size ?? 12;

      ctx.globalAlpha = alpha;
      ctx.font = `600 ${size}px ui-sans-serif, system-ui, sans-serif`;

      // A dark plate behind the text, so a pale mesh does not swallow it.
      const w = ctx.measureText(label.text).width;
      const subWidth = label.sub
        ? (() => {
            ctx.font = `500 ${size - 2}px ui-sans-serif, system-ui, sans-serif`;
            const m = ctx.measureText(label.sub).width;
            ctx.font = `600 ${size}px ui-sans-serif, system-ui, sans-serif`;
            return m;
          })()
        : 0;
      const boxWidth = Math.max(w, subWidth) + 12;
      const boxHeight = label.sub ? size + 16 : size + 8;

      ctx.fillStyle = 'rgba(8, 12, 19, 0.72)';
      ctx.fillRect(sx - boxWidth / 2, sy - boxHeight + 2, boxWidth, boxHeight);

      ctx.fillStyle = label.colour ?? '#e6edf7';
      ctx.fillText(label.text, sx, sy - (label.sub ? size - 1 : 2));

      if (label.sub) {
        ctx.font = `500 ${size - 2}px ui-sans-serif, system-ui, sans-serif`;
        ctx.fillStyle = 'rgba(150, 168, 190, 0.95)';
        ctx.fillText(label.sub, sx, sy - 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawUnitBars(
    unit: Unit,
    sx: number,
    sy: number,
    viewTeam: Team,
    selected: boolean,
    alpha: number,
  ): void {
    const ctx = this.ctx;
    const width = BAR_WIDTH[unit.kind] ?? 32;
    const height = unit.kind === UnitKind.Champion ? 7 : 5;
    const x = Math.round(sx - width / 2);
    const y = Math.round(sy);

    ctx.globalAlpha = alpha;

    // Backing plate.
    ctx.fillStyle = 'rgba(6,9,14,0.78)';
    ctx.fillRect(x - 1, y - 1, width + 2, height + 2);

    // Health. Allies and enemies are coloured by relationship, not by team, so
    // the player reads threat rather than having to remember which side is blue.
    const friendly = unit.team === viewTeam;
    const neutral = unit.team === Team.Neutral;
    const hpRatio = clamp01(unit.hp / Math.max(1, unit.stats.hpMax));
    ctx.fillStyle = neutral ? '#d8b45a' : friendly ? '#5ad46a' : '#e0554a';
    ctx.fillRect(x, y, Math.max(0, width * hpRatio), height);

    // Shield sits on top of health, in white, clipped to the bar.
    const shield = shieldAmount(unit);
    if (shield > 0) {
      const shieldRatio = clamp01(shield / Math.max(1, unit.stats.hpMax));
      const start = width * hpRatio;
      const span = Math.min(width - start, width * shieldRatio);
      ctx.fillStyle = 'rgba(235,245,255,0.9)';
      ctx.fillRect(x + start, y, Math.max(0, span), height);
    }

    // Segment ticks let the player judge absolute health, not just a fraction.
    if (unit.kind === UnitKind.Champion || unit.kind === UnitKind.Structure) {
      const per = unit.kind === UnitKind.Champion ? 150 : 500;
      const segments = Math.floor(unit.stats.hpMax / per);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      for (let s = 1; s <= segments; s++) {
        const px = x + (width * (s * per)) / unit.stats.hpMax;
        if (px >= x + width) break;
        ctx.fillRect(Math.round(px), y, 1, height);
      }
    }

    let cursorY = y + height + 1;

    // Mana.
    if (unit.stats.mpMax > 0) {
      const mpRatio = clamp01(unit.mp / unit.stats.mpMax);
      ctx.fillStyle = 'rgba(6,9,14,0.78)';
      ctx.fillRect(x - 1, cursorY, width + 2, 4);
      ctx.fillStyle = '#3e8fe0';
      ctx.fillRect(x, cursorY + 1, width * mpRatio, 2);
      cursorY += 5;
    }

    // Cast bar, only while actually winding up.
    if (unit.cast && unit.cast.phase === CastPhase.Windup) {
      ctx.fillStyle = 'rgba(6,9,14,0.8)';
      ctx.fillRect(x - 1, cursorY, width + 2, 4);
      ctx.fillStyle = '#ffd36b';
      // Remaining time is known; total is not, so draw it draining.
      const remaining = clamp01(unit.cast.timer / 0.6);
      ctx.fillRect(x, cursorY + 1, width * (1 - remaining), 2);
      cursorY += 5;
    }

    // Crowd-control pips.
    const pips: Array<[StatusKind, string]> = [
      [StatusKind.Stun, '#ffd36b'],
      [StatusKind.Root, '#b08cff'],
      [StatusKind.Slow, '#6bc9ff'],
      [StatusKind.Burn, '#ff7a4a'],
    ];
    let pipX = x;
    for (const [kind, color] of pips) {
      let present = false;
      for (let i = 0; i < unit.statuses.length; i++) {
        if (unit.statuses[i].kind === kind) {
          present = true;
          break;
        }
      }
      if (!present) continue;
      ctx.fillStyle = color;
      ctx.fillRect(pipX, cursorY, 5, 3);
      pipX += 7;
    }

    // Name, for champions and structures only.
    if (unit.kind === UnitKind.Champion) {
      ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillText(unit.name, sx + 1, y - 5 + 1);
      ctx.fillStyle = selected ? '#ffffff' : TEAM_CSS[unit.team];
      ctx.fillText(unit.name, sx, y - 5);
    }

    ctx.globalAlpha = 1;
  }

  private drawFloatingText(camera: RtsCamera, dt: number): void {
    const ctx = this.ctx;
    ctx.textAlign = 'center';

    for (let i = 0; i < this.texts.length; i++) {
      const t = this.texts[i];
      if (!t.active) continue;
      t.age += dt;
      if (t.age >= t.life) {
        t.active = false;
        continue;
      }

      camera.worldToScreen(t.x, 1.6, t.y, this.anchor);
      if (this.anchor.z > 1) continue;

      const progress = t.age / t.life;
      // Rise quickly then slow, which reads as a pop rather than a drift.
      const rise = Math.sqrt(progress) * FLOAT_RISE;
      const alpha = 1 - progress * progress;

      ctx.globalAlpha = alpha;
      ctx.font = `700 ${t.size}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillText(t.text, this.anchor.x + 1.5, this.anchor.y - rise + 1.5);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, this.anchor.x, this.anchor.y - rise);
    }
    ctx.globalAlpha = 1;
  }
}
