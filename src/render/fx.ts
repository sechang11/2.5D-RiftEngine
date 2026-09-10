/**
 * Transient visual effects: missiles in flight, spell telegraphs, impact rings.
 *
 * Everything is pooled. These are the objects that spawn and die most often in
 * a fight, and allocating a mesh per missile is the fastest way to turn a
 * teamfight into a stutter. Pools are grown on demand and never shrunk.
 *
 * Telegraphs deserve a note: the growing fill is not decoration. It is the
 * player's only read on *when* a delayed spell lands, so it is driven directly
 * from the effect's own countdown rather than an independent animation.
 */

import {
  AdditiveBlending,
  CircleGeometry,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  Scene,
  SphereGeometry,
  type Texture,
} from 'three';
import type { World } from '../core/ecs/world';
import { clamp01 } from '../core/math/scalar';
import { createRingTexture } from './textures/procedural';

/** Visual keys used by content, mapped to a colour and a size. */
const PROJECTILE_STYLES: Record<string, { color: number; scale: number; trail: number }> = {
  bolt_blue: { color: 0x7fc4ff, scale: 0.22, trail: 1.6 },
  bolt_red: { color: 0xff8a7a, scale: 0.22, trail: 1.6 },
  bolt_arcane: { color: 0xc79bff, scale: 0.4, trail: 2.4 },
};

const DEFAULT_PROJECTILE = { color: 0xffffff, scale: 0.25, trail: 1.5 };

interface Impact {
  mesh: Mesh;
  material: MeshBasicMaterial;
  age: number;
  duration: number;
  startScale: number;
  endScale: number;
  active: boolean;
}

export class Effects {
  readonly group = new Group();

  private readonly projectilePool: Mesh[] = [];
  private readonly projectileMaterials = new Map<string, MeshBasicMaterial>();
  private projectileGeometry = new SphereGeometry(1, 8, 6);

  private readonly telegraphPool: Array<{ fill: Mesh; ring: Mesh }> = [];
  private readonly telegraphFillMaterial: MeshBasicMaterial;
  private readonly telegraphRingMaterial: MeshBasicMaterial;
  private readonly discGeometry = new CircleGeometry(1, 40);
  private readonly ringTexture: Texture;

  private readonly impacts: Impact[] = [];

  constructor(scene: Scene) {
    this.ringTexture = createRingTexture(256, 0.08, 0.03);

    this.telegraphFillMaterial = new MeshBasicMaterial({
      color: 0xff6a3a,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    });
    this.telegraphRingMaterial = new MeshBasicMaterial({
      map: this.ringTexture,
      color: 0xffb070,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: AdditiveBlending,
    });

    scene.add(this.group);
  }

  /** Positions a mesh for every live projectile, interpolated between ticks. */
  syncProjectiles(world: World, alpha: number): void {
    const list = world.projectiles;
    let used = 0;

    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p.alive) continue;

      const mesh = this.acquireProjectile(used++);
      const style = PROJECTILE_STYLES[p.visual] ?? DEFAULT_PROJECTILE;
      mesh.material = this.materialFor(p.visual, style.color);

      const x = p.prevPos.x + (p.pos.x - p.prevPos.x) * alpha;
      const z = p.prevPos.y + (p.pos.y - p.prevPos.y) * alpha;
      mesh.position.set(x, 1.0, z);

      // Stretch along the direction of travel so fast missiles read as streaks.
      mesh.scale.set(style.scale, style.scale, style.scale * style.trail);
      mesh.rotation.y = Math.atan2(p.dir.x, p.dir.y);
      mesh.visible = true;
    }

    for (let i = used; i < this.projectilePool.length; i++) {
      this.projectilePool[i].visible = false;
    }
  }

  private acquireProjectile(index: number): Mesh {
    while (this.projectilePool.length <= index) {
      const mesh = new Mesh(this.projectileGeometry, this.materialFor('bolt_blue', 0x7fc4ff));
      mesh.renderOrder = 6;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.projectilePool.push(mesh);
    }
    return this.projectilePool[index];
  }

  private materialFor(key: string, color: number): MeshBasicMaterial {
    let m = this.projectileMaterials.get(key);
    if (!m) {
      m = new MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.95,
        blending: AdditiveBlending,
        depthWrite: false,
      });
      this.projectileMaterials.set(key, m);
    }
    return m;
  }

  /**
   * Draws a telegraph for each pending ground effect: an outline at the full
   * radius, and a fill that grows to meet it as the countdown runs out.
   */
  syncTelegraphs(world: World): void {
    const list = world.effects;
    let used = 0;

    for (let i = 0; i < list.length; i++) {
      const fx = list[i];
      if (!fx.alive) continue;

      const pair = this.acquireTelegraph(used++);
      const t = clamp01(fx.delay <= 0 ? 1 : fx.elapsed / fx.delay);

      pair.ring.position.set(fx.pos.x, 0.09, fx.pos.y);
      pair.ring.scale.setScalar(fx.radius);
      pair.ring.visible = true;

      pair.fill.position.set(fx.pos.x, 0.085, fx.pos.y);
      // Ease the fill so the last moments read as urgent.
      pair.fill.scale.setScalar(fx.radius * (t * t * 0.85 + t * 0.15));
      pair.fill.visible = true;
    }

    for (let i = used; i < this.telegraphPool.length; i++) {
      this.telegraphPool[i].fill.visible = false;
      this.telegraphPool[i].ring.visible = false;
    }
  }

  private acquireTelegraph(index: number): { fill: Mesh; ring: Mesh } {
    while (this.telegraphPool.length <= index) {
      const fill = new Mesh(this.discGeometry, this.telegraphFillMaterial);
      fill.rotation.x = -Math.PI / 2;
      fill.renderOrder = 3;
      const ring = new Mesh(this.discGeometry, this.telegraphRingMaterial);
      ring.rotation.x = -Math.PI / 2;
      ring.renderOrder = 4;
      this.group.add(fill);
      this.group.add(ring);
      this.telegraphPool.push({ fill, ring });
    }
    return this.telegraphPool[index];
  }

  /** Expanding ring at a world position. Used for hits, blinks and deaths. */
  spawnImpact(
    x: number,
    y: number,
    color: number,
    startScale: number,
    endScale: number,
    duration = 0.35,
  ): void {
    let impact = this.impacts.find((i) => !i.active);
    if (!impact) {
      const material = new MeshBasicMaterial({
        map: this.ringTexture,
        transparent: true,
        opacity: 1,
        depthWrite: false,
        blending: AdditiveBlending,
      });
      const mesh = new Mesh(this.discGeometry, material);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.12;
      mesh.renderOrder = 7;
      this.group.add(mesh);
      impact = { mesh, material, age: 0, duration, startScale, endScale, active: false };
      this.impacts.push(impact);
    }

    impact.active = true;
    impact.age = 0;
    impact.duration = duration;
    impact.startScale = startScale;
    impact.endScale = endScale;
    impact.material.color = new Color(color);
    impact.mesh.position.set(x, 0.12, y);
    impact.mesh.scale.setScalar(startScale);
    impact.mesh.visible = true;
  }

  update(dt: number): void {
    for (let i = 0; i < this.impacts.length; i++) {
      const impact = this.impacts[i];
      if (!impact.active) continue;
      impact.age += dt;
      const t = clamp01(impact.age / impact.duration);
      impact.mesh.scale.setScalar(impact.startScale + (impact.endScale - impact.startScale) * t);
      impact.material.opacity = 1 - t;
      if (t >= 1) {
        impact.active = false;
        impact.mesh.visible = false;
      }
    }
  }

  dispose(): void {
    this.projectileGeometry.dispose();
    this.discGeometry.dispose();
    this.ringTexture.dispose();
    for (const m of this.projectileMaterials.values()) m.dispose();
    this.telegraphFillMaterial.dispose();
    this.telegraphRingMaterial.dispose();
    for (const i of this.impacts) i.material.dispose();
  }
}
