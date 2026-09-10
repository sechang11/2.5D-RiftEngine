/**
 * Triplanar materials: texture without UVs.
 *
 * A single-view reconstructor returns shape and nothing else. No UV layout, no
 * texture, no way to make one that is not either a per-asset unwrap-and-bake
 * pipeline or a lie. With two hundred assets, neither was going to happen.
 *
 * So the texture is projected instead of mapped. Each fragment samples the same
 * tiling material three times, once down each object-space axis, and blends the
 * three by how much the surface faces that axis. Nothing is unwrapped, nothing
 * is baked, seams cannot exist because there are none, and the texel density is
 * uniform everywhere on the model.
 *
 * Three consequences worth stating, because they shaped the rest of the design:
 *
 *   Tiling means resolution is nearly free. A 1024 texture at 2 world units per
 *   tile is 512 pixels per unit. A champion is 2.2 units tall. No per-asset
 *   unwrap at any sane budget comes close, which is why zooming all the way in
 *   still shows mortar joints rather than a blurry smear.
 *
 *   Projection is in object space, not world space. World space is easier and
 *   hides tiling better, but it makes the grain slide across a building when
 *   the building is rotated, and every house in the city is a rotated copy of
 *   six shells. Object space rotates the grain with the model.
 *
 *   Surfaces are split by angle, not by material slot. `side` covers walls,
 *   `top` covers anything facing up past the blend threshold, which is what
 *   puts slate on a roof and ashlar on the wall beneath it without either the
 *   mesh or the generator knowing that a roof is a thing.
 *
 * The face normal is recomputed from screen-space derivatives rather than read
 * from the vertex normal. It costs two instructions, it gives crisp faceting on
 * architecture that smooth vertex normals ruin, and the same vector serves as
 * the projection blend weight, the up-facing test and the base for the normal
 * map. One value, three uses.
 */

import {
  Color,
  DoubleSide,
  MeshStandardMaterial,
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  type IUniform,
  type WebGLProgramParametersWithUniforms,
} from 'three';

/** What the generator recorded about one tiling surface. */
export interface MaterialDef {
  id: string;
  name: string;
  group: string;
  /**
   * Which pair of map files this material reads, when that is not its own id.
   *
   * A tinted variant is a whole material as far as an asset is concerned — a
   * pink plaster and a cream one are different choices — and it costs nothing
   * to ship, because both read the same two files and differ only in the
   * multiplier the shader applies. Half the library's colour variety is this.
   */
  maps?: string;
  /** World units covered by one tile of the texture. */
  scale: number;
  roughness: number;
  metalness: number;
  normalStrength: number;
  tint?: string | null;
}

/** What an asset asks for: two surfaces and how much instances may drift. */
export interface MaterialSpec {
  side: string;
  top: string;
  /** Multiplies both materials' own tile scale, per asset. */
  scale?: number;
  /** How far individual instances may drift in brightness and hue, 0 to 1. */
  jitter?: number;
  tint?: string | null;
  /**
   * Multiplies the relief already baked into the map. One is the material as
   * generated; this exists for the asset that wants its stone flatter or its
   * thatch deeper than the library's default.
   */
  normalScale?: number;
}

export interface MaterialManifest {
  generated?: string;
  materials: MaterialDef[];
}

/** Where the up-facing blend starts and finishes, in normal.y. */
const UP_LOW = 0.32;
const UP_HIGH = 0.68;

const FALLBACK: MaterialDef = {
  id: 'fallback',
  name: 'Fallback',
  group: 'surface',
  scale: 2,
  roughness: 0.85,
  metalness: 0,
  normalStrength: 1,
};

const VERT_PARS = /* glsl */ `
varying vec3 vTriPos;
varying vec3 vTriNrm;
varying mat3 vTriBasis;
`;

const VERT_BODY = /* glsl */ `
vTriPos = position;
vTriNrm = normal;
#ifdef USE_INSTANCING
  // Instances are placed with rotation and uniform scale only, so the upper
  // 3x3 doubles as the normal transform without an inverse transpose.
  vTriBasis = normalMatrix * mat3( instanceMatrix );
#else
  vTriBasis = normalMatrix;
#endif
`;

const FRAG_PARS = /* glsl */ `
uniform sampler2D triSideMap;
uniform sampler2D triTopMap;
uniform sampler2D triSideNrm;
uniform sampler2D triTopNrm;
uniform vec2 triScale;        // 1 / world units per tile, side and top
uniform vec2 triRough;
uniform vec2 triMetal;
uniform vec2 triNrmScale;
uniform vec3 triSideTint;
uniform vec3 triTopTint;

varying vec3 vTriPos;
varying vec3 vTriNrm;
varying mat3 vTriBasis;

vec3 triBlendWeights( vec3 n ) {
  // A high power makes the dominant axis win decisively. Blending gently
  // across a cube's corner sounds nicer and reads as a smudge.
  vec3 b = pow( abs( n ), vec3( 6.0 ) );
  return b / max( b.x + b.y + b.z, 1e-4 );
}

vec3 triUnpack( vec2 rg, float strength ) {
  vec2 xy = clamp( ( rg * 2.0 - 1.0 ) * strength, vec2( -0.97 ), vec2( 0.97 ) );
  return vec3( xy, sqrt( max( 0.0, 1.0 - dot( xy, xy ) ) ) );
}

/**
 * Whiteout blending: each plane's tangent normal is folded into the surface
 * normal's other two components, then the three are combined by the same
 * weights the colour used. Cheaper than building a tangent frame, and it does
 * not need one to exist.
 */
vec3 triWhiteout( vec3 tx, vec3 ty, vec3 tz, vec3 n, vec3 w ) {
  tx = vec3( tx.xy + n.zy, abs( tx.z ) * n.x );
  ty = vec3( ty.xy + n.xz, abs( ty.z ) * n.y );
  tz = vec3( tz.xy + n.xy, abs( tz.z ) * n.z );
  return normalize( tx.zyx * w.x + ty.xzy * w.y + tz.xyz * w.z );
}
`;

// Both packed maps are sampled once, here, and their three planes kept: the
// blue channel feeds roughness and the red and green feed the normal. Sampling
// them again in the normal chunk would double a twelve-fetch shader for a
// value already in a register.
const FRAG_SETUP = /* glsl */ `
vec3 triFaceN = normalize( cross( dFdx( vTriPos ), dFdy( vTriPos ) ) );
triFaceN *= sign( dot( triFaceN, vTriNrm ) + 1e-5 );
#ifdef DOUBLE_SIDED
  // Reconstructed shells come back with their winding inverted often enough
  // that it cannot be treated as a defect: a tent rendered as a black hole
  // because the only visible surface was its inside. Drawing both sides and
  // flipping the normal on the far one is a cheaper fix than repairing the
  // winding of a mesh that may not be a closed surface in the first place.
  triFaceN *= gl_FrontFacing ? 1.0 : -1.0;
#endif
vec3 triW = triBlendWeights( triFaceN );
float triUp = smoothstep( ${UP_LOW.toFixed(2)}, ${UP_HIGH.toFixed(2)}, triFaceN.y );

vec2 triPx = vTriPos.zy;
vec2 triPy = vTriPos.xz;
vec2 triPz = vTriPos.xy;

vec3 triSideCol =
    texture2D( triSideMap, triPx * triScale.x ).rgb * triW.x
  + texture2D( triSideMap, triPy * triScale.x ).rgb * triW.y
  + texture2D( triSideMap, triPz * triScale.x ).rgb * triW.z;
vec3 triTopCol =
    texture2D( triTopMap, triPx * triScale.y ).rgb * triW.x
  + texture2D( triTopMap, triPy * triScale.y ).rgb * triW.y
  + texture2D( triTopMap, triPz * triScale.y ).rgb * triW.z;
vec3 triAlbedo = mix( triSideCol * triSideTint, triTopCol * triTopTint, triUp );

vec3 triSnX = texture2D( triSideNrm, triPx * triScale.x ).rgb;
vec3 triSnY = texture2D( triSideNrm, triPy * triScale.x ).rgb;
vec3 triSnZ = texture2D( triSideNrm, triPz * triScale.x ).rgb;
vec3 triTnX = texture2D( triTopNrm, triPx * triScale.y ).rgb;
vec3 triTnY = texture2D( triTopNrm, triPy * triScale.y ).rgb;
vec3 triTnZ = texture2D( triTopNrm, triPz * triScale.y ).rgb;

float triRoughDetail = mix(
  triSnX.b * triW.x + triSnY.b * triW.y + triSnZ.b * triW.z,
  triTnX.b * triW.x + triTnY.b * triW.y + triTnZ.b * triW.z,
  triUp
);
`;

function patch(shader: WebGLProgramParametersWithUniforms, uniforms: Record<string, IUniform>): void {
  Object.assign(shader.uniforms, uniforms);

  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\n' + VERT_PARS)
    .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERT_BODY);

  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
    // The setup goes before the first chunk that uses it, and `color_fragment`
    // is also where instance colour would normally arrive. Three only applies
    // instance colour when vertexColors is on, and turning that on without a
    // colour attribute reads (0,0,0) and renders everything black, so the
    // multiply is done here instead, guarded by the define three does set.
    .replace(
      '#include <color_fragment>',
      FRAG_SETUP +
        'diffuseColor.rgb *= triAlbedo;\n' +
        '#ifdef USE_INSTANCING_COLOR\n  diffuseColor.rgb *= vColor;\n#endif',
    )
    .replace(
      '#include <roughnessmap_fragment>',
      'float roughnessFactor = clamp( mix( triRough.x, triRough.y, triUp ) * ( 0.62 + 0.76 * triRoughDetail ), 0.04, 1.0 );',
    )
    .replace(
      '#include <metalnessmap_fragment>',
      'float metalnessFactor = mix( triMetal.x, triMetal.y, triUp );',
    )
    .replace(
      '#include <normal_fragment_maps>',
      `vec3 triN = normalize( mix(
         triWhiteout(
           triUnpack( triSnX.rg, triNrmScale.x ),
           triUnpack( triSnY.rg, triNrmScale.x ),
           triUnpack( triSnZ.rg, triNrmScale.x ), triFaceN, triW ),
         triWhiteout(
           triUnpack( triTnX.rg, triNrmScale.y ),
           triUnpack( triTnY.rg, triNrmScale.y ),
           triUnpack( triTnZ.rg, triNrmScale.y ), triFaceN, triW ),
         triUp
       ) );
       normal = normalize( vTriBasis * triN );`,
    );
}

/**
 * Loads the material pack and builds shaders from it.
 *
 * Textures and compiled materials are both shared: two hundred assets asking
 * for ashlar get one texture and, if they ask on the same terms, one material.
 */
export class MaterialLibrary {
  private defs = new Map<string, MaterialDef>();
  private textures = new Map<string, Texture>();
  private cache = new Map<string, MeshStandardMaterial>();
  private readonly loader = new TextureLoader();
  private readonly baseUrl: string;

  /** True once a manifest with at least one material has been loaded. */
  ready = false;

  constructor(baseUrl = '/assets/materials/') {
    this.baseUrl = baseUrl;
  }

  async loadManifest(url = '/assets/materials/manifest.json'): Promise<number> {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const manifest = (await res.json()) as MaterialManifest;
      for (const def of manifest.materials) this.defs.set(def.id, def);
      this.ready = this.defs.size > 0;
      return this.defs.size;
    } catch (err) {
      // No material pack is a legitimate state: the engine falls back to the
      // flat category palette and everything still runs.
      console.warn(`[materials] no pack at ${url}:`, err);
      return 0;
    }
  }

  get size(): number {
    return this.defs.size;
  }

  all(): MaterialDef[] {
    return [...this.defs.values()];
  }

  def(id: string): MaterialDef {
    return this.defs.get(id) ?? FALLBACK;
  }

  /** One map of one material, shared. `a` is albedo, `nr` is normal plus roughness. */
  texture(id: string, kind: 'a' | 'nr'): Texture {
    const key = `${id}_${kind}`;
    let tex = this.textures.get(key);
    if (!tex) {
      tex = this.loader.load(`${this.baseUrl}${key}.jpg`);
      tex.wrapS = RepeatWrapping;
      tex.wrapT = RepeatWrapping;
      // The albedo is authored art and is sRGB. The packed map is data:
      // decoding it would bend the normals and lift the roughness.
      tex.colorSpace = kind === 'a' ? SRGBColorSpace : NoColorSpace;
      tex.anisotropy = 8;
      this.textures.set(key, tex);
    }
    return tex;
  }

  /** Stable key for a spec, so identical requests share one compiled shader. */
  private static key(spec: MaterialSpec): string {
    return [
      spec.side,
      spec.top,
      (spec.scale ?? 1).toFixed(3),
      (spec.normalScale ?? 1).toFixed(2),
      spec.tint ?? '',
    ].join('|');
  }

  /**
   * A material for one asset.
   *
   * `jitter` is not part of the key: instance drift is applied per instance
   * through vertex colour, so two assets differing only in jitter still share
   * the same shader.
   */
  get(spec: MaterialSpec): MeshStandardMaterial {
    const key = MaterialLibrary.key(spec);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const side = this.def(spec.side);
    const top = this.def(spec.top);
    const assetScale = spec.scale ?? 1;
    const tint = spec.tint ? new Color(spec.tint) : null;

    const uniforms: Record<string, IUniform> = {
      triSideMap: { value: this.texture(side.maps ?? side.id, 'a') },
      triTopMap: { value: this.texture(top.maps ?? top.id, 'a') },
      triSideNrm: { value: this.texture(side.maps ?? side.id, 'nr') },
      triTopNrm: { value: this.texture(top.maps ?? top.id, 'nr') },
      // The shader multiplies position by this, so it is tiles per unit: the
      // reciprocal of the world size one tile covers.
      triScale: { value: [1 / (side.scale * assetScale), 1 / (top.scale * assetScale)] },
      triRough: { value: [side.roughness, top.roughness] },
      triMetal: { value: [side.metalness, top.metalness] },
      // Not the material's `normalStrength`. The generator already fits the
      // gradient scale to that when it bakes the map, and applying it a second
      // time here tilted stone by seventy degrees per texel: every wall facing
      // away from the sun went black and the pale cream albedo above rendered
      // as wet slate.
      triNrmScale: { value: [spec.normalScale ?? 1, spec.normalScale ?? 1] },
      triSideTint: {
        value: tint ?? (side.tint ? new Color(side.tint) : new Color(1, 1, 1)),
      },
      triTopTint: {
        value: tint ?? (top.tint ? new Color(top.tint) : new Color(1, 1, 1)),
      },
    };

    const material = new MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1,
      metalness: 0,
      side: DoubleSide,
    });
    material.onBeforeCompile = (shader) => patch(shader, uniforms);
    // Exposed so the uniforms can be read and nudged from the console, which is
    // the only practical way to tune a projected material against real geometry.
    material.userData.triUniforms = uniforms;
    // Two materials with different uniforms must not share a compiled program.
    material.customProgramCacheKey = () => 'triplanar:' + key;
    this.cache.set(key, material);
    return material;
  }

  dispose(): void {
    for (const t of this.textures.values()) t.dispose();
    for (const m of this.cache.values()) m.dispose();
    this.textures.clear();
    this.cache.clear();
  }
}

/**
 * Per-instance drift, as a colour multiplier.
 *
 * A street is six house shells repeated forty times. Nothing gives that away
 * faster than forty identical roofs, and nothing fixes it more cheaply than
 * moving each instance a little in brightness and hue. Deterministic in the
 * instance index, so a reload does not reshuffle the street.
 */
export function jitterColor(target: Color, seed: number, amount: number): Color {
  if (amount <= 0) return target.setRGB(1, 1, 1);
  const a = Math.sin(seed * 12.9898) * 43758.5453;
  const b = Math.sin(seed * 78.233 + 1.7) * 24634.6345;
  const value = 1 + (a - Math.floor(a) - 0.5) * amount * 1.6;
  const hue = (b - Math.floor(b) - 0.5) * amount * 0.5;
  return target.setRGB(
    Math.max(0, value * (1 + hue * 0.6)),
    Math.max(0, value),
    Math.max(0, value * (1 - hue * 0.8)),
  );
}
