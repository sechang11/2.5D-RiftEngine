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
| `/?mode=city` | Highhold, the castle city |
| `/?mode=museum` | Every asset laid out as a walkable gallery |
| `/?mode=museum&category=house` | One gallery, for when the whole pack is more than you want |
| `/viewer.html?src=/assets/pack/nature_oak.glb` | Single-mesh inspector |
| `/sheet.html?category=building` | Asset contact sheet, everything at true scale |

Two packs ship: separate GLB files for the meshes, and two JPEGs per tiling
material. Both load on demand, and only what a map actually places is fetched —
the city pulls roughly half the mesh pack and a third of the materials, not all
of either.

## Caching

`server.mjs` sets three different policies, because the files have three
different lifetimes:

| Files | Policy | Why |
| --- | --- | --- |
| `/assets/*-<hash>.js`, `.css` | one year, immutable | Vite puts a content hash in the name, so the content can never change |
| `/assets/pack/*.glb` | one day, revalidate | Stable names, so it must be able to change when the pack is regenerated |
| `/assets/materials/*.jpg` | one day, revalidate | Same: stable names, regenerated in place |
| HTML | no-cache | Points at the hashed bundles, so it has to be fresh |

## Regenerating the pack

Both packs are committed, so a deploy never needs a GPU. To rebuild them, follow
[ASSET-PIPELINE.md](ASSET-PIPELINE.md) and [MATERIALS.md](MATERIALS.md) on a
machine with ComfyUI, then

```bash
node tools/import-pack.mjs <staging-dir>
node tools/import-materials.mjs <materials-staging-dir>
```

to refresh `public/assets/`, and commit. Railway redeploys on push.

## Checking a deploy

```bash
curl -I https://<your-domain>/assets/pack/manifest.json
```

Expect `200` and `application/json`. Then open `/?mode=museum` and walk in. If
the pack is being served correctly every exhibit is standing there with a label
on it, which is a far better check than a contact sheet because it also tells
you whether the meshes look right at the size the game uses them.
