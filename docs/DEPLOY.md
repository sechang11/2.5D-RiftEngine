# Deploying to Railway

The repository is ready to deploy as-is. Everything Railway needs is committed:
`railway.json` pins the build and start commands, and `server.mjs` serves the
build with no dependencies.

## Steps

1. In Railway, choose **New Project → Deploy from GitHub repo** and pick
   `sechang11/2.5D-RiftEngine`.
2. Railway reads `railway.json` and needs no further configuration. It runs:

   ```
   npm install --include=dev && npm run build     # build
   npm start                                      # serve
   ```

3. Under **Settings → Networking**, choose **Generate Domain**. That is the URL.

No environment variables are required. Railway injects `PORT` and the server
reads it.

## Why the build command installs dev dependencies explicitly

`vite` and `typescript` are dev dependencies, which is correct: they build the
app and are not needed to serve it. Some hosts set `NODE_ENV=production` before
installing, which makes npm skip dev dependencies, and the build then fails on a
missing `vite`. Passing `--include=dev` makes the build work regardless of what
the host sets, instead of depending on a default that may change.

## What gets served

`npm run build` typechecks, then emits three pages into `dist/`:

| Path | What it is |
| --- | --- |
| `/` | The game |
| `/viewer.html?src=/assets/pack/nature_oak.glb` | Single-mesh inspector |
| `/sheet.html?category=building` | Asset contact sheet, everything at true scale |

The asset pack ships as 184 separate GLB files totalling 12.3 MB, and meshes
load on demand. A first visit fetches only what the map actually places, which
is roughly 70 files and about 4 MB, not the whole pack.

## Caching

`server.mjs` sets three different policies, because the files have three
different lifetimes:

| Files | Policy | Why |
| --- | --- | --- |
| `/assets/*-<hash>.js`, `.css` | one year, immutable | Vite puts a content hash in the name, so the content can never change |
| `/assets/pack/*.glb` | one day, revalidate | Stable names, so it must be able to change when the pack is regenerated |
| HTML | no-cache | Points at the hashed bundles, so it has to be fresh |

## Regenerating the pack

The pack is committed, so a deploy never needs a GPU. To rebuild it, follow
[ASSET-PIPELINE.md](ASSET-PIPELINE.md) on a machine with ComfyUI, run
`node tools/import-pack.mjs <staging-dir>` to refresh `public/assets/pack/`, then
commit and push. Railway redeploys on push.

## Checking a deploy

```bash
curl -I https://<your-domain>/assets/pack/manifest.json
```

Expect `200` and `application/json`. Then open `/sheet.html`, which draws every
mesh in the pack: if the assets are being served correctly, they all appear.
