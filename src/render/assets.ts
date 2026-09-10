/**
 * The asset registry.
 *
 * Everything the engine did before this file was procedural: meshes built from
 * primitives at startup, textures synthesized from noise. That is a fine way to
 * start and a bad way to finish, because it means new content requires new code.
 * This is the seam where authored and generated art enters instead.
 *
 * Three responsibilities:
 *
 *   catalogue   what assets exist, their category, size and tags, from a
 *               manifest, so an editor palette can be built without loading a
 *               single mesh
 *   loading     fetch a GLB on demand, once, and hand out shared geometry
 *   fallback    when a mesh is missing or fails, produce a visible placeholder
 *               rather than an invisible hole
 *
 * The catalogue is deliberately separate from the geometry. A map that
 * references two hundred assets should show its palette immediately and pay for
 * meshes only as they are placed.
 */

import {
  BufferGeometry,
  Color,
  Mesh,
  MeshStandardMaterial,
  OctahedronGeometry,
  type Material,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MaterialLibrary, type MaterialSpec } from './triplanar';

export interface AssetEntry {
  id: string;
  name: string;
  category: string;
  tags: string[];
  /** Path to the GLB, relative to the site root. */
  mesh: string;
  /** Bounding size in world units, from the generator. */
  size: [number, number, number];
  /** Ground footprint radius, used for collision and editor snapping. */
  radius: number;
  triangles: number;
  bytes: number;
  /**
   * Which tiling surfaces the engine should project onto this mesh. Absent
   * means the flat category palette, which is what the first pack shipped with.
   */
  material?: MaterialSpec;
}

export interface AssetManifest {
  generated: string;
  assets: AssetEntry[];
}

/**
 * Per-category shading. Generated meshes arrive untextured, which suits the
 * engine's flat-shaded look: a palette applied by category reads as a coherent
 * art style rather than a pile of grey blobs, and it costs one material per
 * category instead of one texture per asset.
 */
const CATEGORY_STYLE: Record<string, { color: number; roughness: number; metalness: number }> = {
  weapon: { color: 0xb9c3d4, roughness: 0.42, metalness: 0.55 },
  shield: { color: 0xa8b0c0, roughness: 0.5, metalness: 0.4 },
  building: { color: 0x9a9384, roughness: 0.92, metalness: 0.02 },
  nature: { color: 0x6f8a5a, roughness: 0.95, metalness: 0 },
  prop: { color: 0x9c8460, roughness: 0.85, metalness: 0.05 },
  pickup: { color: 0xd8c06a, roughness: 0.35, metalness: 0.45 },
  creature: { color: 0x8f7f74, roughness: 0.8, metalness: 0.05 },
};

const DEFAULT_STYLE = { color: 0xa6adb8, roughness: 0.8, metalness: 0.05 };

/**
 * What to project onto an asset that does not name its own surfaces.
 *
 * The first pack was generated before materials existed and has no specs at
 * all. Guessing by category is crude — every creature gets hide, every weapon
 * gets steel — and it is still an enormous improvement on one flat colour per
 * category, so the whole back catalogue gets textured for free and anything
 * that deserves better can say so in its own entry.
 */
const CATEGORY_SURFACE: Record<string, MaterialSpec> = {
  weapon: { side: 'steel', top: 'wood_beam', scale: 0.55, jitter: 0.05 },
  shield: { side: 'wood_plank', top: 'iron_wrought', scale: 0.5, jitter: 0.07 },
  building: { side: 'stone_rubble', top: 'roof_shingle', scale: 1, jitter: 0.1 },
  nature: { side: 'wood_bark', top: 'grass_meadow', scale: 1, jitter: 0.14 },
  prop: { side: 'wood_plank', top: 'wood_plank', scale: 0.8, jitter: 0.12 },
  pickup: { side: 'gold', top: 'gold', scale: 0.5, jitter: 0.06 },
  creature: { side: 'leather', top: 'fur_brown', scale: 0.6, jitter: 0.12 },
  fort: { side: 'stone_ashlar', top: 'stone_ashlar', scale: 1, jitter: 0.05 },
  house: { side: 'plaster_white', top: 'roof_clay', scale: 1, jitter: 0.14 },
  civic: { side: 'stone_limestone', top: 'roof_slate', scale: 1, jitter: 0.05 },
  street: { side: 'wood_plank', top: 'wood_plank', scale: 0.8, jitter: 0.12 },
  rural: { side: 'wood_plank', top: 'roof_thatch', scale: 0.9, jitter: 0.12 },
  dock: { side: 'wood_plank', top: 'wood_plank', scale: 0.9, jitter: 0.1 },
};

export class AssetRegistry {
  private entries = new Map<string, AssetEntry>();
  private geometries = new Map<string, BufferGeometry>();
  private pending = new Map<string, Promise<BufferGeometry>>();
  private materials = new Map<string, MeshStandardMaterial>();
  private readonly loader = new GLTFLoader();
  private fallbackGeometry: BufferGeometry | null = null;

  /** Where GLB files live, relative to the site root. */
  readonly baseUrl: string;

  /** Tiling surfaces, projected onto meshes that carry a material spec. */
  readonly surfaces: MaterialLibrary;

  constructor(baseUrl = '/assets/pack/', surfaces = new MaterialLibrary()) {
    this.baseUrl = baseUrl;
    this.surfaces = surfaces;
  }

  /**
   * Loads the catalogue, and the material library alongside it.
   *
   * Both are metadata; neither pulls a mesh or a texture. They are fetched
   * together because an asset's material spec is meaningless without the
   * library that resolves it, and a caller that got one without the other
   * would silently render the whole pack in flat grey.
   */
  async loadManifest(url = '/assets/pack/manifest.json'): Promise<number> {
    const surfaces = this.surfaces.loadManifest();
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const manifest = (await res.json()) as AssetManifest;
      for (const entry of manifest.assets) this.entries.set(entry.id, entry);
      await surfaces;
      return manifest.assets.length;
    } catch (err) {
      await surfaces;
      // A missing pack is a normal state during development, not a crash: the
      // engine still runs, the editor palette is simply empty.
      console.warn(`[assets] no pack at ${url}:`, err);
      return 0;
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get(id: string): AssetEntry | undefined {
    return this.entries.get(id);
  }

  all(): AssetEntry[] {
    return [...this.entries.values()];
  }

  categories(): string[] {
    const set = new Set<string>();
    for (const e of this.entries.values()) set.add(e.category);
    return [...set].sort();
  }

  byCategory(category: string): AssetEntry[] {
    return this.all()
      .filter((e) => e.category === category)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Substring search over name and tags, for the palette's filter box. */
  search(query: string): AssetEntry[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.all();
    return this.all().filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.id.toLowerCase().includes(q) ||
        e.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }

  /** True once the geometry is resident and `geometry()` will return it. */
  isLoaded(id: string): boolean {
    return this.geometries.has(id);
  }

  /** Resident geometry, or null when it has not been loaded yet. */
  geometry(id: string): BufferGeometry | null {
    return this.geometries.get(id) ?? null;
  }

  /**
   * Loads a mesh, de-duplicating concurrent requests for the same asset.
   *
   * Generated GLBs contain a single mesh with no material worth keeping, so
   * only the geometry is retained and shading comes from the category palette.
   * That keeps one material per category rather than one per placed prop.
   */
  async load(id: string): Promise<BufferGeometry> {
    const cached = this.geometries.get(id);
    if (cached) return cached;

    const inflight = this.pending.get(id);
    if (inflight) return inflight;

    const entry = this.entries.get(id);
    if (!entry) return this.fallback();

    const url = this.baseUrl + entry.mesh;
    const promise = new Promise<BufferGeometry>((resolve) => {
      this.loader.load(
        url,
        (gltf) => {
          let found: BufferGeometry | null = null;
          gltf.scene.traverse((o) => {
            const mesh = o as Mesh;
            if (!found && mesh.isMesh) found = mesh.geometry;
          });
          if (!found) {
            console.warn(`[assets] ${id} contains no mesh`);
            resolve(this.fallback());
            return;
          }
          const geo = found as BufferGeometry;
          geo.computeBoundingSphere();
          geo.computeBoundingBox();
          this.geometries.set(id, geo);
          resolve(geo);
        },
        undefined,
        (err) => {
          console.warn(`[assets] failed to load ${url}:`, err);
          resolve(this.fallback());
        },
      );
    }).finally(() => this.pending.delete(id));

    this.pending.set(id, promise);
    return promise;
  }

  /** Loads several assets, tolerating individual failures. */
  async loadAll(ids: Iterable<string>): Promise<void> {
    await Promise.all([...ids].map((id) => this.load(id)));
  }

  /** Shared material for a category, created on first use. */
  material(category: string): MeshStandardMaterial {
    let m = this.materials.get(category);
    if (!m) {
      const style = CATEGORY_STYLE[category] ?? DEFAULT_STYLE;
      m = new MeshStandardMaterial({
        color: new Color(style.color),
        roughness: style.roughness,
        metalness: style.metalness,
        flatShading: true,
      });
      this.materials.set(category, m);
    }
    return m;
  }

  /**
   * The material to draw an asset with.
   *
   * A projected material when the asset asks for one and the library is there,
   * and the flat category palette otherwise. The fallback is not a courtesy: it
   * is what keeps the engine running against a pack generated before materials
   * existed, and what it degrades to if the texture pack fails to load.
   */
  materialFor(id: string): Material {
    const entry = this.entries.get(id);
    const spec = this.surfaceOf(id);
    if (spec && this.surfaces.ready) return this.surfaces.get(spec);
    return this.material(entry?.category ?? 'prop');
  }

  /** The surfaces an asset should wear: its own, or its category's. */
  surfaceOf(id: string): MaterialSpec | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    return entry.material ?? CATEGORY_SURFACE[entry.category];
  }

  /** How far instances of this asset may drift in tone. Zero means uniform. */
  jitterOf(id: string): number {
    return this.surfaces.ready ? (this.surfaceOf(id)?.jitter ?? 0) : 0;
  }

  /** A visible stand-in, so a broken asset reads as broken instead of absent. */
  private fallback(): BufferGeometry {
    if (!this.fallbackGeometry) {
      this.fallbackGeometry = new OctahedronGeometry(0.5, 0);
      this.fallbackGeometry.translate(0, 0.5, 0);
    }
    return this.fallbackGeometry;
  }

  dispose(): void {
    for (const g of this.geometries.values()) g.dispose();
    for (const m of this.materials.values()) m.dispose();
    this.geometries.clear();
    this.materials.clear();
    this.surfaces.dispose();
  }
}
