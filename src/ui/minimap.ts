/**
 * The minimap.
 *
 * Terrain is rasterised once into an offscreen canvas and blitted every frame;
 * only fog, units and the camera rectangle are redrawn. Repainting 90,000 nav
 * cells per frame would cost more than the 3D scene does.
 *
 * It is also an input surface: left click scrolls the camera, right click
 * issues a move order, which is how players actually rotate around a MOBA map.
 */

import type { Sim } from '../core/sim/sim';
import type { GameMap } from '../game/content/map01';
import { CellFlag } from '../core/nav/navgrid';
import { Team, UnitKind } from '../core/ecs/types';
import { FogState } from '../core/vision/fog';
import type { RtsCamera } from '../render/camera';
import { vec2 } from '../core/math/vec2';
import { TEAM_CSS } from '../game/content/units';

const SIZE = 224;

export class Minimap {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly base: HTMLCanvasElement;
  private readonly fogCanvas: HTMLCanvasElement;
  private readonly fogCtx: CanvasRenderingContext2D;
  private readonly fogImage: ImageData;

  private readonly map: GameMap;
  private readonly sim: Sim;
  private readonly camera: RtsCamera;
  private viewTeam: Team;
  private readonly extent = vec2();

  /** Set by the host so minimap clicks can issue orders. */
  onOrder: ((x: number, y: number) => void) | null = null;

  constructor(mount: HTMLElement, map: GameMap, sim: Sim, camera: RtsCamera, viewTeam: Team) {
    this.map = map;
    this.sim = sim;
    this.camera = camera;
    this.viewTeam = viewTeam;

    this.canvas = document.createElement('canvas');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = SIZE * dpr;
    this.canvas.height = SIZE * dpr;
    this.canvas.style.width = `${SIZE}px`;
    this.canvas.style.height = `${SIZE}px`;
    mount.appendChild(this.canvas);

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Minimap context unavailable');
    ctx.scale(dpr, dpr);
    this.ctx = ctx;

    this.base = renderTerrainBase(map);

    this.fogCanvas = document.createElement('canvas');
    this.fogCanvas.width = sim.fog.cols;
    this.fogCanvas.height = sim.fog.rows;
    const fogCtx = this.fogCanvas.getContext('2d');
    if (!fogCtx) throw new Error('Minimap fog context unavailable');
    this.fogCtx = fogCtx;
    this.fogImage = fogCtx.createImageData(sim.fog.cols, sim.fog.rows);

    this.bindInput();
  }

  setViewTeam(team: Team): void {
    this.viewTeam = team;
  }

  private bindInput(): void {
    const toWorld = (e: MouseEvent) => {
      const rect = this.canvas.getBoundingClientRect();
      const u = (e.clientX - rect.left) / rect.width;
      const v = (e.clientY - rect.top) / rect.height;
      return {
        x: this.map.nav.minX + u * this.map.nav.width,
        y: this.map.nav.minY + v * this.map.nav.height,
      };
    };

    this.canvas.addEventListener('mousedown', (e) => {
      const p = toWorld(e);
      if (e.button === 2) this.onOrder?.(p.x, p.y);
      else this.camera.jumpTo(p.x, p.y);
      e.preventDefault();
      e.stopPropagation();
    });

    // Dragging with the left button held scrubs the camera around the map.
    this.canvas.addEventListener('mousemove', (e) => {
      if ((e.buttons & 1) === 0) return;
      const p = toWorld(e);
      this.camera.centreOn(p.x, p.y);
    });

    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private worldToMap(x: number, y: number): [number, number] {
    const nav = this.map.nav;
    return [((x - nav.minX) / nav.width) * SIZE, ((y - nav.minY) / nav.height) * SIZE];
  }

  update(fogEnabled: boolean): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.drawImage(this.base, 0, 0, SIZE, SIZE);

    if (fogEnabled) this.drawFog();
    this.drawUnits(fogEnabled);
    this.drawViewport();

    ctx.strokeStyle = 'rgba(180,200,230,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, SIZE - 1, SIZE - 1);
  }

  private drawFog(): void {
    const fog = this.sim.fog;
    const src = fog.buffer(this.viewTeam);
    const data = this.fogImage.data;
    for (let i = 0; i < src.length; i++) {
      const s = src[i];
      // Darkness is drawn as alpha over the terrain image.
      const alpha = s === FogState.Visible ? 0 : s === FogState.Explored ? 130 : 225;
      const o = i * 4;
      data[o] = 4;
      data[o + 1] = 6;
      data[o + 2] = 10;
      data[o + 3] = alpha;
    }
    this.fogCtx.putImageData(this.fogImage, 0, 0);
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.drawImage(this.fogCanvas, 0, 0, SIZE, SIZE);
  }

  private drawUnits(fogEnabled: boolean): void {
    const ctx = this.ctx;
    const units = this.sim.world.units;
    const visibleBit = 1 << this.viewTeam;

    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      if (unit.hp <= 0 || !unit.alive) continue;
      if (fogEnabled && (unit.visibleTo & visibleBit) === 0) continue;

      const [mx, my] = this.worldToMap(unit.pos.x, unit.pos.y);
      let radius = 2;
      if (unit.kind === UnitKind.Champion) radius = 4;
      else if (unit.kind === UnitKind.Structure) radius = 3.5;
      else if (unit.kind === UnitKind.Monster) radius = 2.6;

      ctx.beginPath();
      if (unit.kind === UnitKind.Structure) {
        ctx.rect(mx - radius, my - radius, radius * 2, radius * 2);
      } else {
        ctx.arc(mx, my, radius, 0, Math.PI * 2);
      }
      ctx.fillStyle = TEAM_CSS[unit.team];
      ctx.fill();

      if (unit.kind === UnitKind.Champion) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.stroke();
      }
    }
  }

  private drawViewport(): void {
    this.camera.visibleHalfExtent(this.extent);
    const nav = this.map.nav;
    const w = (this.extent.x / nav.width) * SIZE * 2;
    const h = (this.extent.y / nav.height) * SIZE * 2;
    const [cx, cy] = this.worldToMap(this.camera.focusX, this.camera.focusY);

    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(cx - w / 2, cy - h / 2, w, h);
  }
}

/** Rasterises static terrain into an offscreen canvas once at startup. */
function renderTerrainBase(map: GameMap): HTMLCanvasElement {
  const nav = map.nav;
  const canvas = document.createElement('canvas');
  canvas.width = nav.cols;
  canvas.height = nav.rows;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Minimap base context unavailable');

  const image = ctx.createImageData(nav.cols, nav.rows);
  const data = image.data;

  for (let i = 0; i < nav.cols * nav.rows; i++) {
    const flags = nav.flags[i];
    let r: number;
    let g: number;
    let b: number;

    if (flags & CellFlag.BlockMove) {
      r = 34;
      g = 36;
      b = 44;
    } else {
      // Open ground, tinted by the same masks the 3D terrain uses.
      const lane = map.laneMask[i] / 255;
      const river = map.riverMask[i] / 255;
      const brush = map.brushMask[i] / 255;
      r = 44 + lane * 62 + river * 4;
      g = 70 + lane * 46 + river * 34 - brush * 22;
      b = 48 + lane * 22 + river * 62 - brush * 10;
    }

    const o = i * 4;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = 255;
  }

  ctx.putImageData(image, 0, 0);
  return canvas;
}

export const MINIMAP_SIZE = SIZE;
