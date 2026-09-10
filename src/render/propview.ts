/**
 * Renders placed props.
 *
 * One InstancedMesh per asset, not one Mesh per prop. A dressed map is hundreds
 * of trees, rocks and barrels; drawn individually that is hundreds of draw
 * calls before a single unit is rendered, and it is the first thing that falls
 * over when a designer actually fills a map. Instancing collapses every copy of
 * an asset into one call regardless of how many are placed.
 *
 * Geometry is loaded lazily. A prop referencing an asset that is not resident
 * yet is skipped this frame and its asset is queued, so placing something never
 * blocks the frame on a network fetch.
 */

import {
  Box3,
  BoxGeometry,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Scene,
  Vector3,
} from 'three';
import type { AssetRegistry } from './assets';
import type { Prop, PropId, PropStore } from '../core/world/props';
import { PropFlag } from '../core/world/props';

/** Extra instance slots kept spare so small edits do not reallocate. */
const CAPACITY_SLACK = 16;

interface Batch {
  assetId: string;
  mesh: InstancedMesh;
  props: Prop[];
}

const scratchMatrix = new Matrix4();
const scratchPos = new Vector3();
const scratchQuat = new Quaternion();
const scratchScale = new Vector3();
const UP = new Vector3(0, 1, 0);

export class PropViews {
  readonly group = new Group();
  /** Prop currently highlighted by the editor, or 0. */
  selected: PropId = 0;
  hovered: PropId = 0;

  private readonly assets: AssetRegistry;
  private readonly store: PropStore;
  private batches = new Map<string, Batch>();
  private lastRevision = -1;
  private requested = new Set<string>();

  /** Outline box drawn around the selected prop. */
  private readonly selectionBox: Mesh;

  constructor(scene: Scene, assets: AssetRegistry, store: PropStore) {
    this.assets = assets;
    this.store = store;
    scene.add(this.group);

    this.selectionBox = new Mesh(
      new BoxGeometry(1, 1, 1),
      new MeshBasicMaterial({ color: 0x7dffa8, wireframe: true, transparent: true, opacity: 0.85, depthTest: false }),
    );
    this.selectionBox.renderOrder = 30;
    this.selectionBox.visible = false;
    this.group.add(this.selectionBox);
  }

  /**
   * Rebuilds batches when the prop set changed, then updates per-frame motion.
   *
   * `time` drives the idle animation on pickups, which bob and turn so a
   * dropped sword reads as collectable rather than as scenery.
   */
  update(time: number): void {
    if (this.store.revision !== this.lastRevision) {
      this.rebuild();
      this.lastRevision = this.store.revision;
    }
    this.animatePickups(time);
    this.updateSelection();
  }

  private rebuild(): void {
    // Group props by asset, skipping anything whose geometry is not resident.
    const grouped = new Map<string, Prop[]>();
    for (const prop of this.store.props) {
      if (!this.assets.isLoaded(prop.assetId)) {
        if (!this.requested.has(prop.assetId)) {
          this.requested.add(prop.assetId);
          // Loading bumps nothing itself; the next revision change picks it up,
          // so force a rebuild when it lands.
          void this.assets.load(prop.assetId).then(() => {
            this.lastRevision = -1;
          });
        }
        continue;
      }
      let list = grouped.get(prop.assetId);
      if (!list) {
        list = [];
        grouped.set(prop.assetId, list);
      }
      list.push(prop);
    }

    // Retire batches whose asset is no longer placed.
    for (const [assetId, batch] of [...this.batches]) {
      if (!grouped.has(assetId)) {
        this.group.remove(batch.mesh);
        batch.mesh.dispose();
        this.batches.delete(assetId);
      }
    }

    for (const [assetId, props] of grouped) {
      let batch: Batch | null = this.batches.get(assetId) ?? null;
      // An InstancedMesh has a fixed capacity, so it is rebuilt only when the
      // placed count outgrows it, with slack so ordinary edits do not thrash.
      if (!batch || props.length > batch.mesh.instanceMatrix.count) {
        if (batch) {
          this.group.remove(batch.mesh);
          batch.mesh.dispose();
        }
        batch = this.createBatch(assetId, props.length + CAPACITY_SLACK);
        if (!batch) continue;
        this.batches.set(assetId, batch);
      }
      batch.props = props;
      batch.mesh.count = props.length;
      for (let i = 0; i < props.length; i++) {
        batch.mesh.setMatrixAt(i, this.matrixFor(props[i], 0));
      }
      batch.mesh.instanceMatrix.needsUpdate = true;
      batch.mesh.computeBoundingSphere();
    }
  }

  private createBatch(assetId: string, capacity: number): Batch | null {
    const geo = this.assets.geometry(assetId);
    if (!geo) return null;
    const entry = this.assets.get(assetId);
    const mesh = new InstancedMesh(geo, this.assets.material(entry?.category ?? 'prop'), capacity);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Props are scattered across the whole map; per-instance culling is not
    // available, so the batch is always submitted and the GPU sorts it out.
    mesh.frustumCulled = false;
    this.group.add(mesh);
    return { assetId, mesh, props: [] };
  }

  private matrixFor(prop: Prop, lift: number): Matrix4 {
    scratchPos.set(prop.x, lift, prop.y);
    scratchQuat.setFromAxisAngle(UP, prop.rotation);
    scratchScale.setScalar(prop.scale);
    return scratchMatrix.compose(scratchPos, scratchQuat, scratchScale);
  }

  /** Pickups turn slowly and bob, so loot is legible at a glance. */
  private animatePickups(time: number): void {
    for (const batch of this.batches.values()) {
      let touched = false;
      for (let i = 0; i < batch.props.length; i++) {
        const prop = batch.props[i];
        if (!(prop.flags & PropFlag.Pickup)) continue;
        // Offset by id so a row of pickups does not pulse in lockstep.
        const phase = time * 1.6 + prop.id * 0.7;
        const lift = 0.35 + Math.sin(phase) * 0.09;
        scratchPos.set(prop.x, lift, prop.y);
        scratchQuat.setFromAxisAngle(UP, prop.rotation + time * 0.9);
        scratchScale.setScalar(prop.scale);
        scratchMatrix.compose(scratchPos, scratchQuat, scratchScale);
        batch.mesh.setMatrixAt(i, scratchMatrix);
        touched = true;
      }
      if (touched) batch.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  private updateSelection(): void {
    const id = this.selected || this.hovered;
    const prop = id ? this.store.get(id) : undefined;
    if (!prop) {
      this.selectionBox.visible = false;
      return;
    }
    const entry = this.assets.get(prop.assetId);
    const size = entry?.size ?? [1, 1, 1];
    this.selectionBox.position.set(prop.x, (size[1] * prop.scale) / 2, prop.y);
    this.selectionBox.rotation.y = prop.rotation;
    this.selectionBox.scale.set(
      Math.max(0.3, size[0] * prop.scale),
      Math.max(0.3, size[1] * prop.scale),
      Math.max(0.3, size[2] * prop.scale),
    );
    (this.selectionBox.material as MeshBasicMaterial).color.set(
      this.selected === id ? 0x7dffa8 : 0xffd36b,
    );
    this.selectionBox.visible = true;
  }

  /** World-space bounding box of a placed prop, for camera framing. */
  boundsOf(prop: Prop, out: Box3): Box3 {
    const entry = this.assets.get(prop.assetId);
    const size = entry?.size ?? [1, 1, 1];
    const hx = (size[0] * prop.scale) / 2;
    const hz = (size[2] * prop.scale) / 2;
    out.min.set(prop.x - hx, 0, prop.y - hz);
    out.max.set(prop.x + hx, size[1] * prop.scale, prop.y + hz);
    return out;
  }

  dispose(): void {
    for (const batch of this.batches.values()) {
      this.group.remove(batch.mesh);
      batch.mesh.dispose();
    }
    this.batches.clear();
  }
}

