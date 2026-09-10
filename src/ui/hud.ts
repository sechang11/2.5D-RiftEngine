/**
 * The heads-up display.
 *
 * Plain DOM rather than in-canvas UI. Text stays crisp at any device pixel
 * ratio, layout is free, and the bits a player interacts with get real hit
 * testing and focus handling. The cost is one DOM write per changed value per
 * frame, so every update below checks whether the value actually changed before
 * touching the element.
 */

import type { Sim } from '../core/sim/sim';
import type { Unit } from '../core/ecs/types';
import { StatusKind } from '../core/ecs/types';
import { getAbility } from '../core/abilities/types';
import { shieldAmount, statusRemaining } from '../core/status/statuses';
import { clamp01 } from '../core/math/scalar';
import { KIT_KEYS } from '../game/content/abilities';
import type { PlayerController } from '../input/controller';

interface SlotElements {
  root: HTMLDivElement;
  icon: HTMLDivElement;
  key: HTMLDivElement;
  sweep: HTMLDivElement;
  timer: HTMLDivElement;
  cost: HTMLDivElement;
  lastCooldown: number;
  lastReady: boolean;
}

/** Rows in the performance panel, in display order. */
const STAT_ROWS = [
  'fps',
  'frame',
  'sim',
  'ticks',
  'units',
  'projectiles',
  'pairs',
  'paths',
  'expansions',
] as const;

type StatRow = (typeof STAT_ROWS)[number];

export class Hud {
  private readonly rootEl: HTMLElement;
  private readonly slots: SlotElements[] = [];
  private readonly statCells = new Map<StatRow, HTMLSpanElement>();
  private readonly logList: HTMLDivElement;
  private readonly logLines: string[] = [];

  private readonly nameEl: HTMLDivElement;
  private readonly hpFill: HTMLDivElement;
  private readonly hpShield: HTMLDivElement;
  private readonly hpText: HTMLDivElement;
  private readonly mpFill: HTMLDivElement;
  private readonly mpText: HTMLDivElement;
  private readonly statsEl: HTMLDivElement;
  private readonly stateEl: HTMLDivElement;
  private readonly perfPanel: HTMLDivElement;
  private readonly toastEl: HTMLDivElement;

  /** Container the minimap canvas is mounted into. */
  readonly minimapMount: HTMLDivElement;

  private fpsAccum = 0;
  private fpsFrames = 0;
  private fpsValue = 0;
  private toastTimer = 0;

  constructor(root: HTMLElement) {
    this.rootEl = root;
    root.classList.add('hud');

    // --- champion panel -----------------------------------------------------
    const champ = div('hud-panel hud-champion');
    this.nameEl = div('champ-name');
    champ.appendChild(this.nameEl);

    const hpBar = div('bar bar-hp');
    this.hpFill = div('bar-fill');
    this.hpShield = div('bar-shield');
    this.hpText = div('bar-text');
    hpBar.append(this.hpFill, this.hpShield, this.hpText);
    champ.appendChild(hpBar);

    const mpBar = div('bar bar-mp');
    this.mpFill = div('bar-fill');
    this.mpText = div('bar-text');
    mpBar.append(this.mpFill, this.mpText);
    champ.appendChild(mpBar);

    this.statsEl = div('champ-stats');
    champ.appendChild(this.statsEl);
    this.stateEl = div('champ-state');
    champ.appendChild(this.stateEl);
    root.appendChild(champ);

    // --- ability bar --------------------------------------------------------
    const bar = div('hud-abilities');
    for (let i = 0; i < KIT_KEYS.length; i++) {
      const slotRoot = div('slot');
      const icon = div('slot-icon');
      const key = div('slot-key');
      key.textContent = KIT_KEYS[i];
      const sweep = div('slot-sweep');
      const timer = div('slot-timer');
      const cost = div('slot-cost');
      slotRoot.append(icon, sweep, timer, key, cost);
      bar.appendChild(slotRoot);
      this.slots.push({
        root: slotRoot,
        icon,
        key,
        sweep,
        timer,
        cost,
        lastCooldown: -1,
        lastReady: false,
      });
    }
    root.appendChild(bar);

    // --- minimap ------------------------------------------------------------
    this.minimapMount = div('hud-minimap');
    root.appendChild(this.minimapMount);

    // --- performance --------------------------------------------------------
    this.perfPanel = div('hud-panel hud-perf');
    const title = div('perf-title');
    title.textContent = 'Engine';
    this.perfPanel.appendChild(title);
    for (const rowKey of STAT_ROWS) {
      const row = div('perf-row');
      const label = document.createElement('span');
      label.className = 'perf-label';
      label.textContent = STAT_LABELS[rowKey];
      const value = document.createElement('span');
      value.className = 'perf-value';
      value.textContent = '0';
      row.append(label, value);
      this.perfPanel.appendChild(row);
      this.statCells.set(rowKey, value);
    }
    root.appendChild(this.perfPanel);

    // --- controls reference -------------------------------------------------
    const help = div('hud-panel hud-help');
    help.innerHTML = HELP_HTML;
    root.appendChild(help);

    // --- log ----------------------------------------------------------------
    this.logList = div('hud-log');
    root.appendChild(this.logList);

    this.toastEl = div('hud-toast');
    root.appendChild(this.toastEl);
  }

  log(message: string): void {
    this.logLines.push(message);
    if (this.logLines.length > 7) this.logLines.shift();
    this.logList.textContent = '';
    for (const line of this.logLines) {
      const el = div('log-line');
      el.textContent = line;
      this.logList.appendChild(el);
    }
  }

  toast(message: string): void {
    this.toastEl.textContent = message;
    this.toastEl.classList.add('visible');
    this.toastTimer = 1.8;
  }

  setPerfVisible(visible: boolean): void {
    this.perfPanel.style.display = visible ? '' : 'none';
  }

  /** Hides gameplay chrome that would collide with the editor's panels. */
  setEditorMode(on: boolean): void {
    this.rootEl.classList.toggle('editing', on);
  }

  update(sim: Sim, controller: PlayerController, unit: Unit | null, dt: number, frameMs: number): void {
    this.updateFps(dt);
    this.updateChampion(unit);
    this.updateAbilities(unit, controller);
    this.updatePerf(sim, frameMs);

    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toastEl.classList.remove('visible');
    }
  }

  private updateFps(dt: number): void {
    this.fpsAccum += dt;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.5) {
      this.fpsValue = this.fpsFrames / this.fpsAccum;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }
  }

  private updateChampion(unit: Unit | null): void {
    if (!unit) {
      this.nameEl.textContent = 'No champion';
      return;
    }

    const dead = unit.hp <= 0 || !unit.alive;
    this.nameEl.textContent = dead
      ? `${unit.name} — respawning in ${Math.max(0, unit.respawnTimer).toFixed(1)}s`
      : unit.name;

    const hpRatio = clamp01(unit.hp / Math.max(1, unit.stats.hpMax));
    this.hpFill.style.width = `${hpRatio * 100}%`;
    const shield = shieldAmount(unit);
    const shieldRatio = clamp01(shield / Math.max(1, unit.stats.hpMax));
    this.hpShield.style.left = `${hpRatio * 100}%`;
    this.hpShield.style.width = `${Math.min(1 - hpRatio, shieldRatio) * 100}%`;
    this.hpText.textContent = `${Math.ceil(unit.hp)} / ${Math.round(unit.stats.hpMax)}${
      shield > 0 ? `  (+${Math.round(shield)})` : ''
    }`;

    const mpRatio = unit.stats.mpMax > 0 ? clamp01(unit.mp / unit.stats.mpMax) : 0;
    this.mpFill.style.width = `${mpRatio * 100}%`;
    this.mpText.textContent =
      unit.stats.mpMax > 0 ? `${Math.ceil(unit.mp)} / ${Math.round(unit.stats.mpMax)}` : '—';

    this.statsEl.textContent =
      `AD ${Math.round(unit.stats.attackDamage)}   ` +
      `AP ${Math.round(unit.stats.abilityPower)}   ` +
      `AR ${Math.round(unit.stats.armor)}   ` +
      `MR ${Math.round(unit.stats.magicResist)}   ` +
      `AS ${unit.stats.attackSpeed.toFixed(2)}   ` +
      `MS ${unit.stats.moveSpeed.toFixed(1)}`;

    // Surface whichever control effect is currently the most important.
    const parts: string[] = [];
    const stun = statusRemaining(unit, StatusKind.Stun);
    const root = statusRemaining(unit, StatusKind.Root);
    const slow = statusRemaining(unit, StatusKind.Slow);
    const haste = statusRemaining(unit, StatusKind.Haste);
    if (stun > 0) parts.push(`Stunned ${stun.toFixed(1)}s`);
    if (root > 0) parts.push(`Rooted ${root.toFixed(1)}s`);
    if (slow > 0) parts.push(`Slowed ${slow.toFixed(1)}s`);
    if (haste > 0) parts.push(`Hasted ${haste.toFixed(1)}s`);
    if (unit.dash) parts.push('Dashing');
    this.stateEl.textContent = parts.join('   ');
  }

  private updateAbilities(unit: Unit | null, controller: PlayerController): void {
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      const inst = unit?.abilities[i];
      const def = inst ? getAbility(inst.defId) : undefined;

      if (!def || !unit) {
        slot.root.classList.add('empty');
        slot.icon.textContent = '';
        continue;
      }

      slot.root.classList.remove('empty');
      if (slot.icon.textContent !== def.icon) {
        slot.icon.textContent = def.icon;
        slot.root.title = `${def.name} — ${def.description}`;
        slot.cost.textContent = def.manaCost > 0 ? String(def.manaCost) : '';
      }

      const cooldown = inst!.cooldown;
      const ratio = def.cooldown > 0 ? clamp01(cooldown / def.cooldown) : 0;
      if (cooldown !== slot.lastCooldown) {
        slot.sweep.style.setProperty('--sweep', `${ratio * 100}%`);
        slot.timer.textContent = cooldown > 0.05 ? formatCooldown(cooldown) : '';
        slot.lastCooldown = cooldown;
      }

      const ready = cooldown <= 0 && unit.mp >= def.manaCost && unit.hp > 0;
      if (ready !== slot.lastReady) {
        slot.root.classList.toggle('ready', ready);
        slot.root.classList.toggle('no-mana', cooldown <= 0 && unit.mp < def.manaCost);
        slot.lastReady = ready;
      }
      slot.root.classList.toggle('aiming', controller.aiming === i);
    }
  }

  private updatePerf(sim: Sim, frameMs: number): void {
    const p = sim.profile;
    this.setStat('fps', this.fpsValue.toFixed(0));
    this.setStat('frame', `${frameMs.toFixed(2)} ms`);
    this.setStat('sim', `${p.simMs.toFixed(2)} ms`);
    this.setStat('ticks', `${p.ticksLastFrame} @ ${sim.tickRate}Hz`);
    this.setStat('units', String(p.units));
    this.setStat('projectiles', String(p.projectiles));
    this.setStat('pairs', String(p.collision.pairsResolved));
    this.setStat('paths', String(p.pathRequests));
    this.setStat('expansions', String(p.pathExpansions));
  }

  private setStat(key: StatRow, value: string): void {
    const cell = this.statCells.get(key);
    if (cell && cell.textContent !== value) cell.textContent = value;
  }
}

const STAT_LABELS: Record<StatRow, string> = {
  fps: 'FPS',
  frame: 'Frame',
  sim: 'Sim',
  ticks: 'Ticks',
  units: 'Units',
  projectiles: 'Missiles',
  pairs: 'Contacts',
  paths: 'Path calls',
  expansions: 'Nodes',
};

function div(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

function formatCooldown(seconds: number): string {
  return seconds >= 10 ? String(Math.ceil(seconds)) : seconds.toFixed(1);
}

const HELP_HTML = `
  <div class="perf-title">Controls</div>
  <div class="help-grid">
    <span>Right click</span><span>Move / attack</span>
    <span>Q W E R</span><span>Abilities (hold to aim)</span>
    <span>D F</span><span>Flash / Ignite</span>
    <span>A + click</span><span>Attack-move</span>
    <span>S / H</span><span>Stop / hold</span>
    <span>Arrows / edge</span><span>Scroll map</span>
    <span>Space</span><span>Centre on champion</span>
    <span>Y</span><span>Lock camera</span>
    <span>Wheel</span><span>Zoom</span>
    <span>B</span><span>Spawn minion wave</span>
    <span>V / G / O</span><span>Fog / grid / paths</span>
    <span>T</span><span>Swap team vision</span>
    <span>P  [  ]</span><span>Pause, time scale</span>
    <span>\`</span><span>Refresh cooldowns</span>
  </div>
`;
