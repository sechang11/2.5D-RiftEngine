/**
 * Authored buildings: static models with their own materials, placed whole.
 *
 * The pack's generated buildings are shells reconstructed from a picture and
 * coloured by projection, and however much is done to them they read as what
 * they are. These are the other kind: modular kit pieces made by an artist,
 * UV-mapped and painted, assembled into one building by
 * tools/buildings/bake.py and loaded here as that single file, with every
 * material it was painted with intact.
 *
 * A building is not a prop. Props are instanced by the hundred with one
 * material each, which is the right shape for a city of generated shells and
 * the wrong one for a house carrying a dozen materials. A building is one
 * object with its own draw calls, and there are few enough of them for that
 * to be free.
 */

import type { Mesh, MeshStandardMaterial, Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * World units per metre for everything authored.
 *
 * Taken from the ranger, who is 1.865 metres to the top of his hood and 2.2
 * units tall, because a building has to agree with him about the size of a
 * door.
 */
export const METRE = 2.2 / 1.865;

export const BUILDING_MODELS: Record<string, { url: string }> = {
  cottage: { url: '/assets/buildings/cottage.glb' },
};

/** The ground a building stands on, in world units about its origin, before any turn. */
export interface Footprint {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

interface BuildingTemplate {
  scene: Object3D;
  footprint: Footprint;
  materials: MeshStandardMaterial[];
}

export class BuildingModels {
  private readonly loader = new GLTFLoader();
  private readonly templates = new Map<string, BuildingTemplate>();

  /** Loads buildings by id. One that fails is simply not there. */
  async load(ids: Iterable<string>): Promise<void> {
    await Promise.all([...new Set(ids)].map((id) => this.loadOne(id)));
  }

  has(id: string): boolean {
    return this.templates.has(id);
  }

  footprint(id: string): Footprint | null {
    return this.templates.get(id)?.footprint ?? null;
  }

  /**
   * A placed copy, at a ground position in world units and turned about the
   * vertical. Copies share geometry and materials with the template.
   */
  create(id: string, x: number, z: number, turn = 0): Object3D | null {
    const template = this.templates.get(id);
    if (!template) return null;
    const copy = template.scene.clone();
    copy.scale.setScalar(METRE);
    copy.position.set(x, 0, z);
    copy.rotation.y = turn;
    return copy;
  }

  /** Keeps painted detail sharp at grazing angles, which a wall is seen at more than anything. */
  setAnisotropy(level: number): void {
    for (const template of this.templates.values()) {
      for (const material of template.materials) {
        for (const map of [material.map, material.normalMap, material.roughnessMap, material.metalnessMap, material.aoMap]) {
          if (!map) continue;
          map.anisotropy = level;
          map.needsUpdate = true;
        }
      }
    }
  }

  private async loadOne(id: string): Promise<void> {
    const spec = BUILDING_MODELS[id];
    if (!spec || this.templates.has(id)) return;
    try {
      const gltf = await this.loader.loadAsync(spec.url);
      const extras = gltf.asset.extras as { footprint?: number[] } | undefined;
      const [minX, minZ, maxX, maxZ] = extras?.footprint ?? [0, 0, 0, 0];
      const materials = new Set<MeshStandardMaterial>();
      gltf.scene.traverse((object) => {
        const mesh = object as Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of list) materials.add(material as MeshStandardMaterial);
      });
      this.templates.set(id, {
        scene: gltf.scene,
        footprint: { minX: minX * METRE, minZ: minZ * METRE, maxX: maxX * METRE, maxZ: maxZ * METRE },
        materials: [...materials],
      });
    } catch (err) {
      console.warn(`[buildings] ${id} did not load:`, err);
    }
  }
}
