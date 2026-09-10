/**
 * Production static server.
 *
 * Serves the Vite build. Deliberately dependency-free: the whole job is reading
 * files off disk with the right headers, and a framework for that is a supply
 * chain for no benefit.
 *
 * Two details matter for this particular app:
 *
 *   GLB mime type       the asset pack is a hundred and eighty binary meshes,
 *                       and they should not go out as octet-stream
 *   cache headers       Vite fingerprints its own output so it can be cached
 *                       forever; the mesh pack has stable names, so it is
 *                       cached hard but revalidated, and HTML never is
 *
 *   PORT   the port to listen on, supplied by the host. Defaults to 8080.
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const ROOT = resolve(process.cwd(), 'dist');
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

function cacheControl(pathname) {
  // Vite writes a content hash into its own filenames, so those can never go
  // stale and are safe to cache indefinitely.
  if (pathname.startsWith('/assets/') && /-[A-Za-z0-9_-]{8,}\./.test(pathname)) {
    return 'public, max-age=31536000, immutable';
  }
  // The mesh pack keeps stable names across builds, so it is cached for a day
  // but revalidated rather than pinned.
  if (pathname.startsWith('/assets/pack/')) {
    return 'public, max-age=86400, must-revalidate';
  }
  if (pathname.endsWith('.html') || pathname === '/') {
    return 'no-cache';
  }
  return 'public, max-age=3600';
}

/** Resolves a URL path to a file inside dist, or null. */
function resolveFile(pathname) {
  let rel = decodeURIComponent(pathname.split('?')[0]);
  if (rel.endsWith('/')) rel += 'index.html';

  // normalize collapses any ".." before it can escape the root.
  const target = resolve(ROOT, '.' + normalize(rel));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) return null;

  if (existsSync(target) && statSync(target).isFile()) return target;

  // A bare name such as /viewer resolves to /viewer.html, so the extra pages
  // work with or without the extension.
  const withHtml = target + '.html';
  if (existsSync(withHtml) && statSync(withHtml).isFile()) return withHtml;

  return null;
}

const server = createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end('Method not allowed');
    return;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  let file = resolveFile(url.pathname);

  // Anything unrecognised falls back to the app shell. There is no client-side
  // router today, but a deep link should still land somewhere useful rather
  // than on a bare 404.
  if (!file && !extname(url.pathname)) file = join(ROOT, 'index.html');

  if (!file || !existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const stat = statSync(file);
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': cacheControl(url.pathname),
    'X-Content-Type-Options': 'nosniff',
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = createReadStream(file);
  stream.on('error', () => {
    res.destroy();
  });
  stream.pipe(res);
});

if (!existsSync(ROOT)) {
  console.error(`No build found at ${ROOT}. Run "npm run build" first.`);
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  console.log(`Rift Engine serving ${ROOT} on http://${HOST}:${PORT}`);
});

// Hosts stop containers with SIGTERM; exiting cleanly avoids a forced kill.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
