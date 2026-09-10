/**
 * Imports a generated material library into the web project.
 *
 * The generator writes two files per material and a manifest keyed by id. The
 * runtime wants an array with only the fields the shader reads, and the maps
 * beside it under public/ so Vite serves them.
 *
 * Byte sizes are reported per group because a material pack is downloaded and a
 * pack that has quietly doubled is worth noticing before it ships.
 *
 *   node tools/import-materials.mjs <staging-dir> [--out public/assets/materials]
 *
 * `staging-dir` holds mat_manifest.json and a materials/ directory, as produced
 * by scripts/materials.py on the generation host.
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const stagingDir = args[0] ?? 'materials-staging';
const outIndex = args.indexOf('--out');
const outDir = outIndex >= 0 ? args[outIndex + 1] : 'public/assets/materials';

const manifestPath = join(stagingDir, 'mat_manifest.json');
const mapDir = join(stagingDir, 'materials');

let raw;
try {
  raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (err) {
  console.error(`Could not read ${manifestPath}: ${err.message}`);
  process.exit(1);
}

const available = new Set();
try {
  for (const f of readdirSync(mapDir)) if (f.endsWith('.jpg')) available.add(f);
} catch (err) {
  console.error(`Could not read ${mapDir}: ${err.message}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) {
  if (f.endsWith('.jpg')) rmSync(join(outDir, f));
}

const materials = [];
const skipped = [];
const bytesByGroup = {};

for (const id of Object.keys(raw).sort()) {
  const def = raw[id];
  const albedo = `${id}_a.jpg`;
  const packed = `${id}_nr.jpg`;
  // Both maps or neither: the shader reads roughness out of the packed map, so
  // a material with only an albedo would render shiny and wrong rather than
  // merely flat.
  if (!available.has(albedo) || !available.has(packed)) {
    skipped.push(`${id}: missing maps`);
    continue;
  }
  let bytes = 0;
  for (const f of [albedo, packed]) {
    copyFileSync(join(mapDir, f), join(outDir, f));
    bytes += statSync(join(mapDir, f)).size;
  }
  bytesByGroup[def.group] = (bytesByGroup[def.group] ?? 0) + bytes;

  materials.push({
    id,
    name: def.name ?? id,
    group: def.group ?? 'surface',
    scale: def.scale ?? 2,
    roughness: def.roughness ?? 0.85,
    metalness: def.metalness ?? 0,
    normalStrength: def.normalStrength ?? 1,
    tint: def.tint ?? null,
  });
}

writeFileSync(
  join(outDir, 'manifest.json'),
  JSON.stringify({ generated: new Date().toISOString(), materials }, null, 1),
);

console.log(`imported ${materials.length} materials into ${resolve(outDir)}`);
let total = 0;
for (const k of Object.keys(bytesByGroup).sort()) {
  console.log(`  ${k.padEnd(10)} ${(bytesByGroup[k] / 1024 / 1024).toFixed(1)} MB`);
  total += bytesByGroup[k];
}
console.log(`  ${'total'.padEnd(10)} ${(total / 1024 / 1024).toFixed(1)} MB`);
if (skipped.length) {
  console.log(`skipped ${skipped.length}:`);
  for (const s of skipped) console.log(`  ${s}`);
}
