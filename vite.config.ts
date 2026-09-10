import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/**
 * Dev-only screenshot sink.
 *
 * The game view is a WebGL canvas plus a 2D overlay, so a capture is a data URL
 * the page already has. This lets the page hand it straight to disk instead of
 * a human saving it by hand, which keeps the README image easy to refresh as
 * the renderer changes.
 *
 * From the browser console:
 *
 *   await engine.capture('docs/screenshot.jpg')
 *
 * Serve only. It is never registered in a production build, so the endpoint
 * cannot ship.
 */
function screenshotSink(): Plugin {
  const root = fileURLToPath(new URL('.', import.meta.url));
  return {
    name: 'rift-screenshot-sink',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__capture', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST only');
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', async () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              path: string;
              dataUrl: string;
            };
            // Confine writes to the project directory.
            const target = resolve(root, body.path);
            if (!target.startsWith(resolve(root))) {
              res.statusCode = 400;
              res.end('path escapes the project root');
              return;
            }
            const base64 = body.dataUrl.slice(body.dataUrl.indexOf(',') + 1);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, Buffer.from(base64, 'base64'));
            res.statusCode = 200;
            res.end(JSON.stringify({ written: target, bytes: base64.length }));
          } catch (err) {
            res.statusCode = 500;
            res.end(String(err));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [screenshotSink()],
  server: { port: 5180, strictPort: false },
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      '@render': fileURLToPath(new URL('./src/render', import.meta.url)),
      '@game': fileURLToPath(new URL('./src/game', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      // The mesh inspector and the asset contact sheet are part of the
      // toolchain, not scratch files: reviewing a generated pack needs them, so
      // they ship with a build rather than only working under the dev server.
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        viewer: fileURLToPath(new URL('./viewer.html', import.meta.url)),
        sheet: fileURLToPath(new URL('./sheet.html', import.meta.url)),
      },
    },
  },
});
