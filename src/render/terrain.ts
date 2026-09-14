/**
 * Terrain rendering: ground, walls, brush and the fog-of-war mask.
 *
 * The simulation is flat. Everything with height here is scenery built from the
 * same nav grid the simulation collides against, which is what keeps the visual
 * map and the collision map from ever disagreeing: if you can see a rock, you
 * cannot walk through it, because both came from the same bits.
 *
 * Fog of war is a single-channel texture sampled by every terrain material.
 * Sampling it per-fragment rather than compositing a black overlay quad means
 * fog darkens the actual surfaces, including the sides of walls, and costs one
 * texture read.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DoubleSide,
  Group,
  InstancedMesh,
  LinearFilter,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  RedFormat,
  ShaderMaterial,
  SphereGeometry,
  UnsignedByteType,
  Texture,
  Vector2,
  Vector3,
} from 'three';
import { CellFlag, type NavGrid } from '../core/nav/navgrid';
import { Team } from '../core/ecs/types';
import type { FogOfWar } from '../core/vision/fog';
import type { GameMap } from '../game/content/map01';
import { Rng } from '../core/math/rng';
import type { MaterialLibrary } from './triplanar';
import {
  createGroundTexture,
  createMacroTexture,
  createRockTexture,
} from './textures/procedural';

/** Brightness multiplier for terrain that has never been seen. */
const UNEXPLORED = 0.06;
/** Brightness for terrain seen before but not currently visible. */
const EXPLORED = 0.42;

/** World units covered by one repeat of the ground texture. */
const GROUND_TILE = 12;

const WALL_BASE_HEIGHT = 3.0;
const WALL_HEIGHT_VARIATION = 1.8;
/** Wall heights snap to this step so adjacent cells usually agree. */
const HEIGHT_QUANTUM = 0.45;

const groundVertexShader = /* glsl */ `
  varying vec2 vMapUv;
  varying vec2 vTileUv;
  varying vec3 vWorld;

  uniform vec2 uMapMin;
  uniform vec2 uMapSize;
  uniform float uTile;

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vMapUv = (world.xz - uMapMin) / uMapSize;
    vTileUv = world.xz / uTile;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const groundFragmentShader = /* glsl */ `
  precision highp float;

  // The tone mapping functions are already in the shader prefix three builds
  // for every material, so only the call site is included below. Pulling in
  // <tonemapping_pars_fragment> here would redefine all of them and the
  // program would fail to link.

  varying vec2 vMapUv;
  varying vec2 vTileUv;
  varying vec3 vWorld;

  uniform sampler2D uGround;
  uniform sampler2D uMacro;
  uniform sampler2D uSplat;
  uniform sampler2D uFog;
  uniform sampler2D uBaseTex;
  uniform sampler2D uBaseNrm;
  uniform sampler2D uLaneTex;
  uniform sampler2D uLaneNrm;
  uniform sampler2D uDirtTex;
  uniform sampler2D uDirtNrm;
  uniform vec3 uGroundTiles;
  uniform float uBaseSaturation;
  uniform vec3 uBaseTint;
  uniform vec3 uLaneTint;
  uniform vec3 uDirtTint;
  uniform float uGroundTextured;
  uniform vec3 uSunDir;
  uniform float uFogEnabled;
  uniform float uGridEnabled;
  uniform float uUnexplored;
  uniform float uExplored;
  uniform vec3 uLaneColor;
  uniform vec3 uRiverColor;
  uniform vec3 uBrushColor;

  void main() {
    // Every texture below is tagged sRGB and so is uploaded with an sRGB
    // internal format, which means the GPU decodes on sample and everything
    // here is already linear. Decoding again would darken the whole map.

    // A single stretched noise field breaks up the tiling at map scale.
    vec3 macro = texture2D(uMacro, vMapUv).rgb;

    // R: lane, G: brush, B: river, A: bare earth. Authored by the map generator.
    //
    // The lookup is displaced by a noise field before it is read. Masks are
    // painted as rectangles, and a rectangle of dirt in a meadow reads as a
    // rectangle no matter what texture fills it. Wobbling the coordinate turns
    // every boundary on the map into a natural edge for one texture fetch,
    // rather than feathering each of them where it is authored.
    vec3 local = texture2D(uMacro, vWorld.xz * 0.075).rgb;
    vec4 splat = texture2D(uSplat, vMapUv + (local.rg - 0.5) * 0.024);
    float lane = clamp(splat.r * 1.15, 0.0, 1.0);
    // Alpha carries bare earth. Paving wins where they overlap, because a road
    // through a yard is still a road.
    float dirt = clamp(splat.a * 1.1, 0.0, 1.0) * (1.0 - lane);

    vec3 base;
    if (uGroundTextured > 0.5) {
      // Two real surfaces, chosen by the map: open ground, and whatever the
      // lane mask means here — a trodden path on a battle map, a cobbled street
      // in a city. The mask was already there to tint the procedural ground;
      // this makes it select a material instead, which is the same authoring
      // for a far better result.
      vec2 uvBase = vWorld.xz * uGroundTiles.x;
      vec2 uvLane = vWorld.xz * uGroundTiles.y;
      vec2 uvDirt = vWorld.xz * uGroundTiles.z;

      // The open ground covers the whole map, so its tiling is the one that
      // shows. Cross-fading a second sample at a very different scale, driven
      // by the macro field, breaks the period without breaking the seam: both
      // samples tile, so their blend does too.
      // Mixed at thirteen-unit patches, not at map scale: the artifact being
      // hidden is a two-and-a-half-unit grid, and a blend that varies over a
      // hundred units leaves that grid perfectly visible inside each patch.
      vec3 baseCol = mix(
        texture2D(uBaseTex, uvBase).rgb,
        texture2D(uBaseTex, uvBase * 0.23 + 0.37).rgb,
        smoothstep(0.32, 0.68, local.b)
      ) * uBaseTint;
      // Pulled towards its own grey where the generated meadow is louder than
      // what stands on it: fine from a hundred units up, most of the frame at eye level.
      baseCol = mix(vec3(dot(baseCol, vec3(0.299, 0.587, 0.114))), baseCol, uBaseSaturation);

      base = mix(baseCol, texture2D(uDirtTex, uvDirt).rgb * uDirtTint, dirt);
      base = mix(base, texture2D(uLaneTex, uvLane).rgb * uLaneTint, lane);
      base *= 0.86 + macro * 0.5;

      // The ground is drawn unlit, so relief has to be faked. Reconstructing a
      // normal from the packed map and shading it against the sun direction is
      // two instructions and the difference between a photograph of cobbles
      // and actual cobbles.
      vec2 tn = mix(
        texture2D(uBaseNrm, uvBase).rg * 2.0 - 1.0,
        texture2D(uDirtNrm, uvDirt).rg * 2.0 - 1.0,
        dirt
      );
      tn = mix(tn, texture2D(uLaneNrm, uvLane).rg * 2.0 - 1.0, lane);
      vec3 nrm = normalize(vec3(tn.x, 1.45, tn.y));
      base *= clamp(0.66 + 0.62 * dot(nrm, uSunDir), 0.42, 1.3);
    } else {
      base = texture2D(uGround, vTileUv).rgb;
      base *= 0.78 + macro * 0.9;
      // Regions repaint the hue but keep the ground texture's luminance, so a
      // lane reads as trodden earth with all its grain intact rather than as a
      // flat band of paint.
      float lum = dot(base, vec3(0.299, 0.587, 0.114));
      base = mix(base, uLaneColor * (0.45 + lum * 1.9), clamp(splat.r * 0.9, 0.0, 1.0));
    }

    float wetLum = dot(base, vec3(0.299, 0.587, 0.114));
    base = mix(base, uRiverColor * (0.5 + wetLum * 1.7), splat.b * 0.72);
    // Brush only darkens and deepens what is already there.
    base = mix(base, base * uBrushColor, splat.g * 0.85);

    // Debug grid, one line every ten world units.
    if (uGridEnabled > 0.5) {
      vec2 g = abs(fract(vWorld.xz / 10.0 - 0.5) - 0.5) / fwidth(vWorld.xz / 10.0);
      float line = 1.0 - min(min(g.x, g.y), 1.0);
      base = mix(base, vec3(0.9, 0.95, 1.0), line * 0.18);
    }

    float visibility = 1.0;
    if (uFogEnabled > 0.5) {
      float f = texture2D(uFog, vMapUv).r;
      // The stored byte is 0, 110 or 255; remap those bands to brightness.
      float explored = smoothstep(0.15, 0.55, f);
      float visible = smoothstep(0.55, 0.95, f);
      visibility = mix(uUnexplored, uExplored, explored);
      visibility = mix(visibility, 1.0, visible);
    }

    vec3 color = base * visibility;
    // Desaturate what is out of sight, so remembered terrain reads as memory.
    float grey = dot(color, vec3(0.299, 0.587, 0.114));
    color = mix(vec3(grey), color, 0.35 + 0.65 * visibility);

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export interface TerrainOptions {
  showGrid?: boolean;
  fogEnabled?: boolean;
  /**
   * How tall blocked cells are extruded.
   *
   * Cliff height suits a battle map, where walls are meant to be terrain you
   * cannot see past. It is wrong for a building interior: a gallery divided by
   * three-metre rock is a maze you navigate blind. Low partitions keep the
   * rooms legible from the fixed camera.
   */
  wallHeight?: number;
  wallVariation?: number;
  /** Tiling surfaces. Without it the ground falls back to procedural noise. */
  surfaces?: MaterialLibrary;
  /** Which two surfaces the ground is made of. */
  ground?: GroundSurfaces;
}

/**
 * What the two ground layers are.
 *
 * `lane` is whatever the map's lane mask means: a trodden path between camps,
 * or a cobbled street through a city. The mask is authored the same way either
 * way, so a map picks its own vocabulary by naming a material here.
 */
export interface GroundSurfaces {
  base: string;
  lane: string;
  /** The third layer, selected by the map's dirt mask. Bare earth, usually. */
  dirt?: string;
}

const DEFAULT_GROUND: Required<GroundSurfaces> = {
  base: 'grass_meadow',
  lane: 'dirt_path',
  dirt: 'mud',
};

export class Terrain {
  readonly group = new Group();
  readonly ground: Mesh;
  readonly walls: Mesh;
  readonly bushes: InstancedMesh | null;

  private readonly fogTexture: DataTexture;
  /** Narrowed to a plain ArrayBuffer so it satisfies the texture upload path. */
  private readonly fogBytes: Uint8Array<ArrayBuffer>;
  /** Intermediate buffer for the separable blur. */
  private readonly fogScratch: Uint8Array;
  private readonly fog: FogOfWar;
  private readonly groundMaterial: ShaderMaterial;
  private readonly wallMaterial: MeshStandardMaterial;
  private readonly bushMaterial: MeshStandardMaterial;
  /** Which team's fog is displayed. */
  private viewTeam: Team;

  constructor(map: GameMap, fog: FogOfWar, viewTeam: Team, opts: TerrainOptions = {}) {
    this.fog = fog;
    this.viewTeam = viewTeam;

    // Backed by an explicit ArrayBuffer so the type is narrow enough for the
    // WebGL texture upload path.
    this.fogBytes = new Uint8Array(new ArrayBuffer(fog.cols * fog.rows));
    this.fogScratch = new Uint8Array(fog.cols * fog.rows);
    this.fogTexture = new DataTexture(this.fogBytes, fog.cols, fog.rows, RedFormat, UnsignedByteType);
    this.fogTexture.minFilter = LinearFilter;
    this.fogTexture.magFilter = LinearFilter;
    // Rows are not a multiple of four bytes wide, so the default alignment
    // would shear the texture.
    this.fogTexture.unpackAlignment = 1;
    this.fogTexture.needsUpdate = true;

    const nav = map.nav;
    const splat = buildSplatTexture(map);

    // The ground uses the material pack when there is one and the procedural
    // noise when there is not, and the choice is made once here rather than
    // branched on everywhere: the shader carries both paths behind a flag.
    const surfaces = opts.surfaces;
    const ground = opts.ground ?? DEFAULT_GROUND;
    const textured = !!surfaces?.ready;
    const blank = new Texture();
    const pick = (id: string, kind: 'a' | 'nr') => {
      if (!textured || !surfaces) return blank;
      const def = surfaces.def(id);
      return surfaces.texture(def.maps ?? def.id, kind);
    };
    const tilesPerUnit = (id: string) =>
      textured && surfaces ? 1 / surfaces.def(id).scale : 1 / GROUND_TILE;
    const tintOf = (id: string): Color => {
      const t = textured && surfaces ? surfaces.def(id).tint : null;
      return t ? new Color(t) : new Color(1, 1, 1);
    };

    this.groundMaterial = new ShaderMaterial({
      vertexShader: groundVertexShader,
      fragmentShader: groundFragmentShader,
      uniforms: {
        uGround: { value: createGroundTexture(512, 7) },
        uMacro: { value: createMacroTexture(256, 31) },
        uSplat: { value: splat },
        uFog: { value: this.fogTexture },
        uFogEnabled: { value: opts.fogEnabled === false ? 0 : 1 },
        uGridEnabled: { value: opts.showGrid ? 1 : 0 },
        uUnexplored: { value: UNEXPLORED },
        uExplored: { value: EXPLORED },
        uMapMin: { value: new Vector2(nav.minX, nav.minY) },
        uMapSize: { value: new Vector2(nav.width, nav.height) },
        uTile: { value: GROUND_TILE },
        uBaseTex: { value: pick(ground.base, 'a') },
        uBaseNrm: { value: pick(ground.base, 'nr') },
        uLaneTex: { value: pick(ground.lane, 'a') },
        uLaneNrm: { value: pick(ground.lane, 'nr') },
        uDirtTex: { value: pick(ground.dirt ?? DEFAULT_GROUND.dirt, 'a') },
        uDirtNrm: { value: pick(ground.dirt ?? DEFAULT_GROUND.dirt, 'nr') },
        uGroundTiles: {
          value: new Vector3(
            tilesPerUnit(ground.base),
            tilesPerUnit(ground.lane),
            tilesPerUnit(ground.dirt ?? DEFAULT_GROUND.dirt),
          ),
        },
        // A tinted variant is a real material choice here as much as it is on a
        // building: the generated dirt is dry orange earth, and the same file
        // cooled is the trodden mud a city yard is actually made of.
        uBaseSaturation: { value: 1 },
        uBaseTint: { value: tintOf(ground.base) },
        uLaneTint: { value: tintOf(ground.lane) },
        uDirtTint: { value: tintOf(ground.dirt ?? DEFAULT_GROUND.dirt) },
        uGroundTextured: { value: textured ? 1 : 0 },
        // Matches the renderer's sun, so ground relief is lit from the same
        // side as everything standing on it.
        uSunDir: { value: new Vector3(-52, 88, 46).normalize() },
        // Lane and river are linear-space hues that replace the ground's own.
        // Brush is a multiplier centred below one, so it only deepens.
        uLaneColor: { value: [0.36, 0.26, 0.14] },
        uRiverColor: { value: [0.11, 0.23, 0.34] },
        uBrushColor: { value: [0.5, 0.76, 0.44] },
      },
    });

    const plane = new PlaneGeometry(nav.width, nav.height, 1, 1);
    plane.rotateX(-Math.PI / 2);
    this.ground = new Mesh(plane, this.groundMaterial);
    this.ground.receiveShadow = false;
    this.ground.renderOrder = -10;
    this.group.add(this.ground);

    const rock = createRockTexture(256, 404);
    this.wallMaterial = new MeshStandardMaterial({
      map: rock,
      roughness: 0.94,
      metalness: 0,
    });
    this.injectFog(this.wallMaterial, nav);

    this.walls = new Mesh(
      buildWallGeometry(
        nav,
        opts.wallHeight ?? WALL_BASE_HEIGHT,
        opts.wallVariation ?? WALL_HEIGHT_VARIATION,
        map.builtMask ?? null,
      ),
      this.wallMaterial,
    );
    this.walls.castShadow = true;
    this.walls.receiveShadow = true;
    this.group.add(this.walls);

    this.bushMaterial = new MeshStandardMaterial({
      color: 0x2f6a33,
      roughness: 0.85,
      metalness: 0,
      transparent: true,
      opacity: 0.92,
      side: DoubleSide,
    });
    this.injectFog(this.bushMaterial, nav);

    this.bushes = buildBushes(map, this.bushMaterial);
    if (this.bushes) this.group.add(this.bushes);
  }

  /**
   * Adds fog sampling to a stock material.
   *
   * Hooking `color_fragment` scales albedo before lighting rather than editing
   * the very end of the shader, which is the stable part of the chunk chain
   * across three.js versions and keeps shadows and instancing working as-is.
   */
  private injectFog(material: MeshStandardMaterial, nav: NavGrid): void {
    const uMapMin = { value: new Vector2(nav.minX, nav.minY) };
    const uMapSize = { value: new Vector2(nav.width, nav.height) };
    const uFog = { value: this.fogTexture };
    const uFogEnabled = { value: 1 };
    material.userData.fogUniforms = { uMapMin, uMapSize, uFog, uFogEnabled };

    material.onBeforeCompile = (shader) => {
      shader.uniforms.uMapMin = uMapMin;
      shader.uniforms.uMapSize = uMapSize;
      shader.uniforms.uFogTex = uFog;
      shader.uniforms.uFogEnabled = uFogEnabled;

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vFogUv;\nuniform vec2 uMapMin;\nuniform vec2 uMapSize;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vec4 fogWorld = modelMatrix * vec4(transformed, 1.0);
           #ifdef USE_INSTANCING
             fogWorld = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
           #endif
           vFogUv = (fogWorld.xz - uMapMin) / uMapSize;`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vFogUv;\nuniform sampler2D uFogTex;\nuniform float uFogEnabled;')
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           if (uFogEnabled > 0.5) {
             float f = texture2D(uFogTex, vFogUv).r;
             float explored = smoothstep(0.15, 0.55, f);
             float visible = smoothstep(0.55, 0.95, f);
             float vis = mix(${UNEXPLORED.toFixed(3)}, ${EXPLORED.toFixed(3)}, explored);
             vis = mix(vis, 1.0, visible);
             diffuseColor.rgb *= vis;
           }`,
        );
    };
  }

  setViewTeam(team: Team): void {
    this.viewTeam = team;
    this.uploadFog(true);
  }

  setFogEnabled(enabled: boolean): void {
    this.groundMaterial.uniforms.uFogEnabled.value = enabled ? 1 : 0;
    for (const m of [this.wallMaterial, this.bushMaterial]) {
      const u = m.userData.fogUniforms;
      if (u) u.uFogEnabled.value = enabled ? 1 : 0;
    }
  }

  setGrid(enabled: boolean): void {
    this.groundMaterial.uniforms.uGridEnabled.value = enabled ? 1 : 0;
  }

  /**
   * Points the ground's faked relief at wherever the sun actually is.
   *
   * The default matches the renderer's fixed sun. A scene lit by a
   * photographed sky moves the sun to the photograph's, and cobbles shaded
   * from one side under shadows falling from the other read as painted on.
   */
  setSunDirection(direction: Vector3): void {
    (this.groundMaterial.uniforms.uSunDir.value as Vector3).copy(direction).normalize();
  }

  /** Recolours one ground layer, multiplying its texture. */
  tintGround(layer: 'base' | 'lane' | 'dirt', colour: number): void {
    const uniform = layer === 'base' ? 'uBaseTint' : layer === 'lane' ? 'uLaneTint' : 'uDirtTint';
    (this.groundMaterial.uniforms[uniform].value as Color).multiply(new Color(colour));
  }

  /** How much of the open ground's own colour to keep: one as generated, zero grey. */
  setGroundSaturation(amount: number): void {
    this.groundMaterial.uniforms.uBaseSaturation.value = amount;
  }

  /**
   * Copies the simulation's fog state into the GPU texture.
   *
   * The raw state is three discrete levels on a coarse grid, which upscales
   * into hard-edged wedges wherever a wall or a bush casts a vision shadow.
   * Blurring before upload turns those into soft gradients. It costs one pass
   * over a small buffer and is the single biggest difference between fog that
   * looks like fog and fog that looks like a stencil.
   */
  uploadFog(force = false): void {
    if (!this.fog.dirty && !force) return;
    const src = this.fog.buffer(this.viewTeam);
    const dst = this.fogBytes;
    // 0 unexplored, 1 explored, 2 visible. Spread across the byte range so the
    // shader's smoothstep bands have room either side of each level.
    for (let i = 0; i < dst.length; i++) {
      const s = src[i];
      dst[i] = s === 2 ? 255 : s === 1 ? 110 : 0;
    }
    blurSeparable(dst, this.fogScratch, this.fog.cols, this.fog.rows);
    blurSeparable(dst, this.fogScratch, this.fog.cols, this.fog.rows);
    this.fogTexture.needsUpdate = true;
    this.fog.dirty = false;
  }
}

/**
 * Three-tap box blur, run once horizontally and once vertically.
 *
 * Two passes of this approximate a Gaussian closely enough for a mask that is
 * about to be smoothstepped anyway, and it stays linear in the number of cells
 * rather than quadratic in the kernel width.
 */
function blurSeparable(buffer: Uint8Array, scratch: Uint8Array, cols: number, rows: number): void {
  for (let y = 0; y < rows; y++) {
    const row = y * cols;
    for (let x = 0; x < cols; x++) {
      const l = buffer[row + (x > 0 ? x - 1 : 0)];
      const c = buffer[row + x];
      const r = buffer[row + (x < cols - 1 ? x + 1 : cols - 1)];
      scratch[row + x] = (l + c + r) / 3;
    }
  }
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) {
      const u = scratch[(y > 0 ? y - 1 : 0) * cols + x];
      const c = scratch[y * cols + x];
      const d = scratch[(y < rows - 1 ? y + 1 : rows - 1) * cols + x];
      buffer[y * cols + x] = (u + c + d) / 3;
    }
  }
}

/**
 * Packs the map generator's masks into one RGB texture the ground shader reads.
 * R lane, G brush, B river.
 */
function buildSplatTexture(map: GameMap): Texture {
  const nav = map.nav;
  const w = nav.cols;
  const h = nav.rows;
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4 + 0] = map.laneMask[i];
    data[i * 4 + 1] = map.brushMask[i];
    data[i * 4 + 2] = map.riverMask[i];
    data[i * 4 + 3] = map.dirtMask ? map.dirtMask[i] : 0;
  }
  const tex = new DataTexture(data, w, h);
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Turns blocked nav cells into a solid mesh.
 *
 * Faces are only emitted where they would actually be visible: a top for every
 * blocked cell, and a side wherever the neighbour is open or shorter. Heights
 * are quantised so most neighbours match exactly and produce no side face at
 * all, which keeps the geometry small while still giving the rock an uneven
 * silhouette.
 */
/**
 * Extrudes blocked cells into rock.
 *
 * `skip` marks blocked cells that are somebody else's job to draw. A city's
 * curtain wall is stamped into the same grid as its cliffs, because collision
 * does not care which is which, but the wall is built out of generated masonry
 * standing on the ground and a band of procedural rock under it would show
 * through every gate arch.
 */
function buildWallGeometry(
  nav: NavGrid,
  baseHeight: number,
  variation: number,
  skip?: Uint8Array | null,
): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];

  const heightAt = (cx: number, cy: number): number => {
    // Deterministic hash so the same cell always gets the same height.
    let h = Math.imul(cx * 374761393 + cy * 668265263, 1274126177) >>> 0;
    h ^= h >>> 13;
    const n = (h % 1000) / 1000;
    const raw = baseHeight + n * variation;
    return Math.round(raw / HEIGHT_QUANTUM) * HEIGHT_QUANTUM;
  };

  const cs = nav.cellSize;
  const UV = 0.22; // texture repeats per world unit

  const pushQuad = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx2: number, cy2: number, cz: number,
    dx: number, dy: number, dz: number,
    nx: number, ny: number, nz: number,
    u0: number, v0: number, u1: number, v1: number,
  ): void => {
    positions.push(ax, ay, az, bx, by, bz, cx2, cy2, cz);
    positions.push(ax, ay, az, cx2, cy2, cz, dx, dy, dz);
    for (let i = 0; i < 6; i++) normals.push(nx, ny, nz);
    uvs.push(u0, v0, u1, v0, u1, v1);
    uvs.push(u0, v0, u1, v1, u0, v1);
  };

  const blocked = (cx: number, cy: number): boolean =>
    nav.isBlocked(cx, cy) && !(skip && skip[nav.idx(cx, cy)]);

  for (let cy = 0; cy < nav.rows; cy++) {
    for (let cx = 0; cx < nav.cols; cx++) {
      if (!blocked(cx, cy)) continue;
      const h = heightAt(cx, cy);
      const x0 = nav.minX + cx * cs;
      const x1 = x0 + cs;
      const z0 = nav.minY + cy * cs;
      const z1 = z0 + cs;

      // Top.
      pushQuad(
        x0, h, z0,
        x1, h, z0,
        x1, h, z1,
        x0, h, z1,
        0, 1, 0,
        x0 * UV, z0 * UV, x1 * UV, z1 * UV,
      );

      // Four sides, each only as tall as the step it exposes.
      const sides: Array<[number, number, number]> = [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 0, 1],
        [0, 0, -1],
      ];
      for (const [sx, , sz] of sides) {
        const nxC = cx + sx;
        const nyC = cy + sz;
        const neighbourH = blocked(nxC, nyC) ? heightAt(nxC, nyC) : 0;
        if (neighbourH >= h - 1e-4) continue;
        const base = neighbourH;

        if (sx === 1) {
          pushQuad(
            x1, base, z1, x1, base, z0, x1, h, z0, x1, h, z1,
            1, 0, 0,
            z1 * UV, base * UV, z0 * UV, h * UV,
          );
        } else if (sx === -1) {
          pushQuad(
            x0, base, z0, x0, base, z1, x0, h, z1, x0, h, z0,
            -1, 0, 0,
            z0 * UV, base * UV, z1 * UV, h * UV,
          );
        } else if (sz === 1) {
          pushQuad(
            x0, base, z1, x1, base, z1, x1, h, z1, x0, h, z1,
            0, 0, 1,
            x0 * UV, base * UV, x1 * UV, h * UV,
          );
        } else {
          pushQuad(
            x1, base, z0, x0, base, z0, x0, h, z0, x1, h, z0,
            0, 0, -1,
            x1 * UV, base * UV, x0 * UV, h * UV,
          );
        }
      }
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geo.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geo.computeBoundingSphere();
  return geo;
}

/** Scatters low-poly blobs over brush cells so bushes have real presence. */
function buildBushes(map: GameMap, material: MeshStandardMaterial): InstancedMesh | null {
  const nav = map.nav;
  const rng = new Rng(5150);
  const points: Array<[number, number, number]> = [];

  // Sample a fraction of the brush cells; a blob every few cells is plenty.
  for (let cy = 0; cy < nav.rows; cy += 2) {
    for (let cx = 0; cx < nav.cols; cx += 2) {
      const i = nav.idx(cx, cy);
      if (!(nav.flags[i] & CellFlag.Brush)) continue;
      if (map.brushMask[i] < 60) continue;
      if (!rng.chance(0.5)) continue;
      points.push([
        nav.cellCentreX(cx) + rng.range(-0.8, 0.8),
        nav.cellCentreY(cy) + rng.range(-0.8, 0.8),
        rng.range(0.85, 1.6),
      ]);
    }
  }

  if (points.length === 0) return null;

  const geo = new SphereGeometry(1, 6, 4);
  const mesh = new InstancedMesh(geo, material, points.length);
  const m = new Matrix4();
  for (let i = 0; i < points.length; i++) {
    const [x, z, s] = points[i];
    m.makeScale(s * 1.15, s * 0.72, s * 1.15);
    m.setPosition(x, s * 0.5, z);
    mesh.setMatrixAt(i, m);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  return mesh;
}
