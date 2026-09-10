/**
 * Imports a generated asset pack into the web project.
 *
 * The generator writes a manifest describing what it made and a directory of
 * GLB files. This turns that into the shape the browser wants: one manifest
 * with only the fields the runtime reads, and the meshes under public/ so Vite
 * serves them.
 *
 * Assets whose mesh failed are dropped rather than listed, so the editor
 * palette never offers something that will not load. A short report is printed
 * because a pack that silently lost a third of its contents is worth noticing.
 *
 *   node tools/import-pack.mjs <staging-dir> [--out public/assets/pack]
 *
 * `staging-dir` holds manifest.json and a glb/ directory, as produced by
 * scripts/pipeline.py on the generation host.
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const stagingDir = args[0] ?? 'assets-staging';
const outIndex = args.indexOf('--out');
const outDir = outIndex >= 0 ? args[outIndex + 1] : 'public/assets/pack';

const manifestPath = join(stagingDir, 'manifest.json');
const glbDir = join(stagingDir, 'glb');

let raw;
try {
  raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (err) {
  console.error(`Could not read ${manifestPath}: ${err.message}`);
  process.exit(1);
}

const available = new Set();
try {
  for (const f of readdirSync(glbDir)) if (f.endsWith('.glb')) available.add(f);
} catch (err) {
  console.error(`Could not read ${glbDir}: ${err.message}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
// Clear stale meshes so a reimport cannot leave orphans behind that the
// manifest no longer mentions.
for (const f of readdirSync(outDir)) {
  if (f.endsWith('.glb')) rmSync(join(outDir, f));
}

const assets = [];
const skipped = [];
let totalBytes = 0;
let totalTris = 0;

for (const [id, entry] of Object.entries(raw.assets ?? {})) {
  const file = entry.mesh;
  if (!file || !available.has(file)) {
    skipped.push(`${id}: no mesh`);
    continue;
  }
  const info = entry.meshInfo ?? {};
  const src = join(glbDir, file);
  const bytes = statSync(src).size;
  copyFileSync(src, join(outDir, file));

  assets.push({
    id,
    name: entry.name ?? id,
    category: entry.category ?? 'prop',
    tags: entry.tags ?? [],
    mesh: file,
    size: info.size ?? [1, 1, 1],
    radius: info.radius ?? 0.5,
    triangles: info.triangles ?? 0,
    bytes,
    // Which tiling surfaces to project onto this mesh. Absent for the first
    // pack, which predates materials; the runtime falls back to its category.
    ...(entry.material ? { material: entry.material } : {}),
  });
  totalBytes += bytes;
  totalTris += info.triangles ?? 0;
}

assets.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

writeFileSync(
  join(outDir, 'manifest.json'),
  JSON.stringify({ generated: new Date().toISOString(), assets }, null, 1),
);

const byCategory = {};
for (const a of assets) byCategory[a.category] = (byCategory[a.category] ?? 0) + 1;

console.log(`imported ${assets.length} assets into ${resolve(outDir)}`);
for (const k of Object.keys(byCategory).sort()) {
  console.log(`  ${k.padEnd(10)} ${byCategory[k]}`);
}
console.log(`  ${'total'.padEnd(10)} ${(totalBytes / 1024 / 1024).toFixed(1)} MB, ${totalTris.toLocaleString()} triangles`);
if (skipped.length) {
  console.log(`skipped ${skipped.length}:`);
  for (const s of skipped.slice(0, 12)) console.log(`  ${s}`);
  if (skipped.length > 12) console.log(`  ... and ${skipped.length - 12} more`);
}
