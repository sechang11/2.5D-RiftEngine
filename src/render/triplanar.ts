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
  /**
   * How much of the concept art's colour to take, and how much of the tiling
   * material's grain to modulate it by.
   */
  colourMix?: [number, number];
  /** How hard the image's own edges push the surface normal around. */
  relief?: number;
}

/**
 * The concept image the mesh was reconstructed from, as a colour map.
 *
 * The reconstruction is in that image's own frame, so the two line up: height
 * maps to height and the subject's own bounding box maps to the image's. The
 * engine wraps it round the mesh cylindrically, which puts the front where the
 * front is, something plausible on the sides, and the front again on the back —
 * which for a building is what the back looks like anyway.
 */
export interface AssetFace {
  /** Asset id; the map is `<id>.jpg` under the face directory. */
  id: string;
  /** Object-space extents of the mesh, which the image is stretched over. */
  size: [number, number, number];
  /** Pixels along one side of the map, for the relief gradient's step. */
  resolution?: number;
  /**
   * How much the mesh is enlarged when placed.
   *
   * Projection is in object space, so a mesh drawn at two and a half times its
   * modelled size stretches its tiling material to match: a three-unit ashlar
   * block became a seven-unit one and the wall read as untextured plaster.
   * Dividing it back out keeps a stone the size a stone is.
   */
  meshScale?: number;
}

/**
 * Colour strength, and how much of the material's grain rides on top of it.
 *
 * Found by looking rather than reasoned. Taking only a timid hue was the
 * mistake the sixteen-band version made — what the eye reads as a building is
 * the dark window and the dark beam, and those are luminance, not hue — but
 * taking nearly all of it is a second mistake: the mesh is not the shape the
 * picture was of, so at full strength a street reads as photographs wrapped
 * round lumps. Two thirds keeps the windows and lets the stone assert itself,
 * and the grain term is turned up to compensate.
 */
const DEFAULT_COLOUR_MIX: [number, number] = [0.68, 0.85];

/** What a delit albedo averages, used to normalise the material's grain. */
const TEXTURE_MEAN_LUMA = 0.55;

/** How hard the concept image's edges push the normal. Enough to catch light. */
const DEFAULT_RELIEF = 2.6;

const placeholderImages = new Map<string, HTMLCanvasElement>();

/**
 * A one-pixel stand-in for a map that has not arrived.
 *
 * Neutral, not white. Three binds a black texture for an unloaded one, and the
 * colour transfer divides by the material's own luminance, so black in was
 * black out and white in blew every building to paper. Mid-grey is what "no
 * information yet" actually means to both.
 */
function placeholder(fill: string): HTMLCanvasElement {
  let canvas = placeholderImages.get(fill);
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, 1, 1);
    }
    placeholderImages.set(fill, canvas);
  }
  return canvas;
}

/** sRGB grey that decodes to about the average of a delit albedo. */
const NEUTRAL_ALBEDO = '#c2c2c2';

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
varying mat3 vTriBasis;
`;

const VERT_BODY = /* glsl */ `
vTriPos = position;
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
uniform sampler2D triFace;
uniform vec3 triFaceSize;    // object-space extents the image is stretched over
uniform vec2 triColourMix;   // x: how much of the image, y: how much grain
uniform vec2 triFaceRelief;  // x: relief strength, y: one texel of the image

varying vec3 vTriPos;
varying mat3 vTriBasis;

vec3 triBlendWeights( vec3 n ) {
  // A high power makes the dominant axis win decisively. Blending gently
  // across a cube's corner sounds nicer and reads as a smudge.
  vec3 b = pow( abs( n ), vec3( 6.0 ) );
  return b / max( b.x + b.y + b.z, 1e-4 );
}

/**
 * The concept image, wrapped round the mesh.
 *
 * Height always maps to height. The horizontal coordinate comes from whichever
 * axis is tangent to the surface, so a wall facing the camera reads the image
 * across, and a wall facing sideways reads it across its own depth. Two fetches
 * rather than three: the up-facing and front-facing planes share a coordinate.
 */
vec3 triFaceColour( vec3 p, vec3 w ) {
  float v = 1.0 - clamp( p.y / max( triFaceSize.y, 1e-3 ), 0.0, 1.0 );
  float ux = clamp( p.z / max( triFaceSize.z, 1e-3 ) + 0.5, 0.0, 1.0 );
  float uz = clamp( p.x / max( triFaceSize.x, 1e-3 ) + 0.5, 0.0, 1.0 );
  return texture2D( triFace, vec2( ux, v ) ).rgb * w.x
       + texture2D( triFace, vec2( uz, v ) ).rgb * ( w.y + w.z );
}

/** Where the dominant plane reads the image, for the relief gradient. */
vec2 triFaceUv( vec3 p, vec3 w ) {
  float v = 1.0 - clamp( p.y / max( triFaceSize.y, 1e-3 ), 0.0, 1.0 );
  float ux = clamp( p.z / max( triFaceSize.z, 1e-3 ) + 0.5, 0.0, 1.0 );
  float uz = clamp( p.x / max( triFaceSize.x, 1e-3 ) + 0.5, 0.0, 1.0 );
  return vec2( mix( uz, ux, step( 0.5, w.x ) ), v );
}

float triLuma( vec3 c ) {
  return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
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
// The face normal, oriented toward the viewer.
//
// Neither of the two things that usually settle this can be trusted on a
// reconstructed mesh: the winding comes back inverted often enough that the
// cross product's sign is a coin toss, and the vertex normals it was exported
// with may disagree with the winding. Trying both — orient to the vertex
// normal, then flip on back faces — is worse than either, because on a mesh
// where they disagree the two corrections cancel and the object renders black.
//
// The side of a surface you can see is the side that is lit. That is the only
// rule here, it needs nothing from the file, and it cannot cancel with itself.
vec3 triFaceN = normalize( cross( dFdx( vTriPos ), dFdy( vTriPos ) ) );
triFaceN *= sign( ( vTriBasis * triFaceN ).z + 1e-5 );
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
vec2 triFaceGrad = vec2( 0.0 );

// The image supplies the colour *and* its own light and dark — a window is a
// dark rectangle, a beam is a dark line, and neither survives a transfer that
// keeps only hue. The tiling material comes back as grain: its luminance,
// normalised about its own average, multiplying the image. Colour from the
// picture, surface from the material.
{
  vec3 face = triFaceColour( vTriPos, triW );

  // Ground contact. Nothing in the pack casts an ambient occlusion term, so
  // everything hovers: a building and its own shadow meet at a hard line and
  // the eye reads the building as sitting on the ground rather than in it.
  // Darkening the lowest tenth of every mesh is not occlusion, but it is where
  // occlusion would be, and it costs one smoothstep.
  face *= mix( 0.62, 1.0, smoothstep( 0.0, 0.09, vTriPos.y / max( triFaceSize.y, 1e-3 ) ) );

  // Relief from the picture. A window in the concept art is a dark rectangle
  // with a hard edge, and a timber is a dark line with two: differencing the
  // image's own luminance across a texel turns both back into surface, which
  // no tiling material can do because no tiling material knows where the
  // window is. Two extra fetches.
  vec2 triFaceAt = triFaceUv( vTriPos, triW );
  float triFaceL = triLuma( face );
  triFaceGrad = vec2(
    triLuma( texture2D( triFace, triFaceAt + vec2( triFaceRelief.y, 0.0 ) ).rgb ) - triFaceL,
    triLuma( texture2D( triFace, triFaceAt + vec2( 0.0, triFaceRelief.y ) ).rgb ) - triFaceL
  ) * triFaceRelief.x;
  // Clamped, because a pale material would otherwise multiply the picture past
  // white and a dark one would put it out altogether. The band is wide enough
  // for stone to read as stone and narrow enough that nothing is lost.
  float grain = clamp(
    mix( 1.0, triLuma( triAlbedo ) / ${TEXTURE_MEAN_LUMA.toFixed(2)}, triColourMix.y ),
    0.55, 1.4
  );
  triAlbedo = mix( triAlbedo, face * grain, triColourMix.x );
}

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
       // The image's relief, folded in along the axis it was projected on.
       vec3 triTangent = mix( vec3( 1.0, 0.0, 0.0 ), vec3( 0.0, 0.0, 1.0 ), step( 0.5, triW.x ) );
       triN = normalize( triN - triTangent * triFaceGrad.x + vec3( 0.0, 1.0, 0.0 ) * triFaceGrad.y );
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
  /** Materials carrying one asset's face map, held only so they can be freed. */
  private perAsset: MeshStandardMaterial[] = [];
  private faceWaiters = new Map<string, Array<() => void>>();
  private readonly loader = new TextureLoader();
  private readonly baseUrl: string;

  /** True once a manifest with at least one material has been loaded. */
  ready = false;

  readonly faceUrl: string;

  constructor(baseUrl = '/assets/materials/', faceUrl = '/assets/faces/') {
    this.baseUrl = baseUrl;
    this.faceUrl = faceUrl;
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

  /** The concept image for one asset, loaded once. */
  faceTexture(id: string): Texture {
    const key = 'face:' + id;
    let tex = this.textures.get(key);
    if (!tex) {
      tex = this.loader.load(`${this.faceUrl}${id}.jpg`);
      tex.colorSpace = SRGBColorSpace;
      tex.anisotropy = 4;
      this.textures.set(key, tex);
    }
    return tex;
  }

  /** Runs `then` once an asset's face map has arrived, or immediately if it has. */
  private whenFaceReady(id: string, then: () => void): void {
    const tex = this.faceTexture(id);
    if (tex.image) {
      then();
      return;
    }
    const waiting = this.faceWaiters.get(id) ?? [];
    waiting.push(then);
    this.faceWaiters.set(id, waiting);
    if (waiting.length > 1) return;
    this.loader.load(`${this.faceUrl}${id}.jpg`, (loaded) => {
      tex.image = loaded.image;
      tex.needsUpdate = true;
      for (const fn of this.faceWaiters.get(id) ?? []) fn();
      this.faceWaiters.delete(id);
    });
  }

  /** A shared one-pixel white texture, for materials with nothing to project. */
  private blank(): Texture {
    let tex = this.textures.get('blank');
    if (!tex) {
      tex = new Texture(placeholder(NEUTRAL_ALBEDO));
      tex.needsUpdate = true;
      this.textures.set('blank', tex);
    }
    return tex;
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
  get(spec: MaterialSpec, face?: AssetFace): MeshStandardMaterial {
    // A face map belongs to one asset, so a material carrying one cannot be
    // shared. The program still is: the cache key ignores it, and three keys
    // its compiled shaders on that rather than on the material.
    const key = MaterialLibrary.key(spec);
    if (!face) {
      const cached = this.cache.get(key);
      if (cached) return cached;
    }

    const side = this.def(spec.side);
    const top = this.def(spec.top);
    // Divided, not multiplied: the projection is in object space, so a mesh
    // drawn at two and a half times its modelled size needs its tiles two and a
    // half times smaller there to come out the same size in the world.
    const assetScale = (spec.scale ?? 1) / (face?.meshScale ?? 1);
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
      triFace: { value: face ? this.faceTexture(face.id) : this.blank() },
      triFaceSize: { value: face ? face.size : [1, 1, 1] },
      // Off until the image is actually here. Three binds a black texture for
      // one that has not loaded, and a transfer that multiplies by the picture
      // would paint every building black for the first second of a map.
      triColourMix: { value: [0, 0] },
      triFaceRelief: { value: [spec.relief ?? DEFAULT_RELIEF, 1 / (face?.resolution ?? 256)] },
    };

    const material = new MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1,
      metalness: 0,
      side: DoubleSide,
      // Three defaults a double-sided material's shadow pass to back faces,
      // which is right for a closed box and wrong for a canvas tent: its back
      // face is a millimetre behind its front, so the lit surface reads as
      // being behind the shadow map and the whole tent goes black. Recording
      // both sides means the depth map holds the nearest surface, which is the
      // one being lit, and the ordinary bias handles it.
      shadowSide: DoubleSide,
    });
    if (face) {
      const mix = spec.colourMix ?? DEFAULT_COLOUR_MIX;
      this.whenFaceReady(face.id, () => {
        (uniforms.triColourMix.value as number[])[0] = mix[0];
        (uniforms.triColourMix.value as number[])[1] = mix[1];
      });
    }
    material.onBeforeCompile = (shader) => patch(shader, uniforms);
    // Face maps are sRGB art, so the material has to be told which of its
    // samplers is colour; without it three leaves the map linear and every
    // building comes out washed.
    // Exposed so the uniforms can be read and nudged from the console, which is
    // the only practical way to tune a projected material against real geometry.
    material.userData.triUniforms = uniforms;
    // Two materials with different uniforms must not share a compiled program.
    material.customProgramCacheKey = () => 'triplanar:' + key;
    if (!face) this.cache.set(key, material);
    else this.perAsset.push(material);
    return material;
  }

  dispose(): void {
    for (const t of this.textures.values()) t.dispose();
    for (const m of this.cache.values()) m.dispose();
    for (const m of this.perAsset) m.dispose();
    this.textures.clear();
    this.cache.clear();
    this.perAsset.length = 0;
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
