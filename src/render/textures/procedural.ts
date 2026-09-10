/**
 * Procedurally generated textures.
 *
 * The engine ships with no binary assets on purpose. Everything the renderer
 * needs is synthesized at startup from a seeded noise function, which keeps the
 * repository text-only, makes the art deterministic, and means a fresh clone
 * runs without a download step. Painted or generated art can replace any of
 * these by swapping the texture on the material.
 */

import {
  CanvasTexture,
  RepeatWrapping,
  SRGBColorSpace,
  LinearFilter,
  LinearMipmapLinearFilter,
  type Texture,
} from 'three';
import { Rng } from '../../core/math/rng';

/** Smooth value noise. Cheap, tileable, and good enough under a tiling material. */
function makeValueNoise(seed: number, period = 256) {
  const rng = new Rng(seed);
  const table = new Float32Array(period * period);
  for (let i = 0; i < table.length; i++) table[i] = rng.next();

  const fade = (t: number) => t * t * (3 - 2 * t);

  return (x: number, y: number): number => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const x0 = ((xi % period) + period) % period;
    const y0 = ((yi % period) + period) % period;
    const x1 = (x0 + 1) % period;
    const y1 = (y0 + 1) % period;

    const v00 = table[y0 * period + x0];
    const v10 = table[y0 * period + x1];
    const v01 = table[y1 * period + x0];
    const v11 = table[y1 * period + x1];

    const u = fade(xf);
    const v = fade(yf);
    const a = v00 + (v10 - v00) * u;
    const b = v01 + (v11 - v01) * u;
    return a + (b - a) * v;
  };
}

/** Fractal sum of value noise. `octaves` controls how much fine detail appears. */
function fbm(
  noise: (x: number, y: number) => number,
  x: number,
  y: number,
  octaves: number,
  lacunarity = 2,
  gain = 0.5,
): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += noise(x * freq, y * freq) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

function createCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  return { canvas, ctx };
}

const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Tiling ground texture. Two noise fields are combined: a fine one for grass
 * grain and a coarse one that decides where the patchy dirt shows through, so
 * repetition is broken up at two different scales.
 */
export function createGroundTexture(size = 512, seed = 7): Texture {
  const { canvas, ctx } = createCanvas(size);
  const image = ctx.createImageData(size, size);
  const data = image.data;

  // Period must divide the pixel span for the result to tile seamlessly.
  const fine = makeValueNoise(seed, 64);
  const coarse = makeValueNoise(seed + 991, 16);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * 64;
      const v = (y / size) * 64;
      const grain = fbm(fine, u, v, 4);
      const patch = fbm(coarse, (x / size) * 16, (y / size) * 16, 3);

      // Base grass, drifting from deep to lighter green.
      let r = mix(38, 74, grain);
      let g = mix(72, 118, grain * 0.75 + patch * 0.25);
      let b = mix(44, 62, grain);

      // Dirt breaks through where the coarse field runs high.
      const dirt = Math.max(0, (patch - 0.62) * 3.4);
      if (dirt > 0) {
        const d = Math.min(1, dirt);
        r = mix(r, mix(96, 128, grain), d);
        g = mix(g, mix(80, 104, grain), d);
        b = mix(b, mix(58, 74, grain), d);
      }

      // Occasional darker mottling for depth.
      const shade = Math.max(0, 0.45 - grain) * 0.9;
      r *= 1 - shade;
      g *= 1 - shade;
      b *= 1 - shade;

      const i = (y * size + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);
  const tex = new CanvasTexture(canvas);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.colorSpace = SRGBColorSpace;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.anisotropy = 8;
  return tex;
}

/**
 * A single large-scale colour field stretched once across the whole map, layered
 * over the tiling ground to hide repetition and give regions their own tint.
 */
export function createMacroTexture(size = 256, seed = 31): Texture {
  const { canvas, ctx } = createCanvas(size);
  const image = ctx.createImageData(size, size);
  const data = image.data;
  const noise = makeValueNoise(seed, 32);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(noise, (x / size) * 8, (y / size) * 8, 4);
      const warm = Math.max(0, n - 0.5) * 1.6;
      const cool = Math.max(0, 0.5 - n) * 1.6;
      const i = (y * size + x) * 4;
      data[i] = 128 + warm * 46 - cool * 26;
      data[i + 1] = 128 + warm * 20 - cool * 6;
      data[i + 2] = 128 - warm * 30 + cool * 40;
      data[i + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);
  const tex = new CanvasTexture(canvas);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/** Rock texture for wall faces, with strata and speckle. */
export function createRockTexture(size = 256, seed = 404): Texture {
  const { canvas, ctx } = createCanvas(size);
  const image = ctx.createImageData(size, size);
  const data = image.data;
  const noise = makeValueNoise(seed, 32);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(noise, (x / size) * 24, (y / size) * 8, 4);
      // Horizontal banding reads as sedimentary layers.
      const band = Math.sin((y / size) * Math.PI * 14 + n * 4) * 0.5 + 0.5;
      const v = n * 0.7 + band * 0.3;
      const i = (y * size + x) * 4;
      data[i] = mix(52, 104, v);
      data[i + 1] = mix(50, 98, v);
      data[i + 2] = mix(56, 104, v);
      data[i + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);
  const tex = new CanvasTexture(canvas);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * A soft radial gradient used for blob shadows and glow decals. Drawn as a
 * texture rather than a shader because it is sampled by dozens of tiny quads
 * where the overhead of a custom material would dominate.
 */
export function createRadialTexture(
  size = 128,
  inner = 'rgba(0,0,0,0.55)',
  outer = 'rgba(0,0,0,0)',
): Texture {
  const { canvas, ctx } = createCanvas(size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.55, inner.replace(/[\d.]+\)$/, '0.28)'));
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/** Ring decal for selection circles and range indicators. */
export function createRingTexture(size = 256, thickness = 0.06, soft = 0.02): Texture {
  const { canvas, ctx } = createCanvas(size);
  const image = ctx.createImageData(size, size);
  const data = image.data;
  const half = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - half) / half;
      const dy = (y - half) / half;
      const d = Math.sqrt(dx * dx + dy * dy);
      const edge = Math.abs(d - (1 - thickness));
      let a = 1 - edge / (thickness + soft);
      a = a < 0 ? 0 : a > 1 ? 1 : a;
      if (d > 1) a = 0;
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = a * 255;
    }
  }

  ctx.putImageData(image, 0, 0);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}
