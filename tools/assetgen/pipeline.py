"""
Asset pipeline: text -> concept art -> mesh -> game-ready GLB.

Run in two phases on purpose. Every concept image is generated first with SDXL
resident in VRAM, then every mesh with Hunyuan3D resident. Interleaving them
would evict a multi-gigabyte model on each asset and the reloads would cost
more than the generation.

  python3 pipeline.py images   [--only prefix] [--limit N]
  python3 pipeline.py meshes   [--only prefix] [--limit N]
  python3 pipeline.py all

State lives in a manifest on disk, so a run that dies partway can be restarted
and will skip what it already finished.
"""

import argparse
import json
import os
import shutil
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import comfy_client as cc
import graphs
import meshproc
import prep_image
import quality

COMFY = "/home/k4shix/ComfyUI"
OUT = os.path.join(COMFY, "output")
STAGE = os.path.join(COMFY, "input", "gamegen")

ROOT = os.path.expanduser("~/gamegen")
GLB_DIR = os.path.join(ROOT, "out", "glb")
CONCEPT_DIR = os.path.join(ROOT, "out", "concept")
MANIFEST = os.path.join(ROOT, "out", "manifest.json")

# Meshing settings established by the threshold sweep: surface nets at 0.4
# gives clean topology at roughly half the triangle count of marching cubes,
# and the field is too noisy near zero to mesh there.
MESH_ALGORITHM = "surface net"
MESH_THRESHOLD = 0.4
OCTREE = 256
MESH_STEPS = 30

# How many assets share one ComfyUI submission. Sized so a batch is long enough
# to amortise a model load but short enough that one bad asset does not cost
# much when the batch has to be retried.
IMAGE_BATCH = 10
MESH_BATCH = 5


def load_manifest():
    if os.path.exists(MANIFEST):
        with open(MANIFEST) as f:
            return json.load(f)
    return {"assets": {}}


def save_manifest(m):
    os.makedirs(os.path.dirname(MANIFEST), exist_ok=True)
    tmp = MANIFEST + ".tmp"
    with open(tmp, "w") as f:
        json.dump(m, f, indent=1)
    os.replace(tmp, MANIFEST)


def _seed_for(spec, salt=0):
    return spec.get("seed", (abs(hash(spec["id"])) + salt) % (2**31))


def phase_images(catalog, manifest, only=None, limit=None, log=print, batch=IMAGE_BATCH):
    todo = [
        s
        for s in catalog
        if (not only or s["id"].startswith(only))
        and manifest["assets"].get(s["id"], {}).get("concept") is None
    ]
    if limit:
        todo = todo[:limit]
    log("images: %d to do in batches of %d" % (len(todo), batch))

    done = 0
    for start in range(0, len(todo), batch):
        chunk = todo[start : start + batch]
        items = [(s["id"], s["prompt"], _seed_for(s)) for s in chunk]
        t0 = time.time()
        try:
            g = graphs.concept_image_batch(items, steps=chunk[0].get("imageSteps", 26))
            outputs, secs = cc.run(g, timeout=300 + 120 * len(chunk))
        except Exception as e:
            log("  batch of %d FAILED (%s); falling back to one at a time" % (len(chunk), e))
            traceback.print_exc()
            if not cc.wait_for_server(240):
                log("  ComfyUI did not come back; stopping image phase")
                return False
            for s in chunk:
                _one_image(s, manifest, log)
                done += 1
            continue

        # Outputs are keyed by node id, so each result maps back to its item by
        # position with no filename guessing.
        for i, spec in enumerate(chunk):
            aid = spec["id"]
            files = cc.files_of(outputs.get("s%d" % i, {}))
            if not files:
                log("  %-34s no image produced" % aid)
                continue
            try:
                _stage_and_record(spec, files[0], manifest)
                done += 1
            except Exception as e:
                log("  %-34s prep FAILED %s" % (aid, e))
        save_manifest(manifest)
        log(
            "  images %d/%d  %5.1fs for %d  (%.1fs each)"
            % (done, len(todo), secs, len(chunk), secs / max(1, len(chunk)))
        )
    return True


def _stage_and_record(spec, file_entry, manifest):
    aid = spec["id"]
    sub = file_entry.get("subfolder") or ""
    src = os.path.join(OUT, sub, file_entry["filename"])
    os.makedirs(STAGE, exist_ok=True)
    os.makedirs(CONCEPT_DIR, exist_ok=True)
    staged = os.path.join(STAGE, aid + ".png")
    info = prep_image.prepare(src, staged, size=1024)
    shutil.copy2(staged, os.path.join(CONCEPT_DIR, aid + ".png"))
    entry = manifest["assets"].setdefault(aid, {})
    entry.update(
        {
            "id": aid,
            "name": spec.get("name", aid),
            "category": spec.get("category", "prop"),
            "tags": spec.get("tags", []),
            "concept": aid + ".png",
            "conceptInfo": info,
            "material": spec.get("material"),
        }
    )


def _one_image(spec, manifest, log):
    """Single-image fallback, used when a batch fails."""
    aid = spec["id"]
    try:
        g = graphs.concept_image(
            spec["prompt"], seed=_seed_for(spec), prefix="gamegen_concept/" + aid
        )
        outputs, _ = cc.run(g, timeout=600)
        files = cc.all_files(outputs)
        if files:
            _stage_and_record(spec, files[0], manifest)
            save_manifest(manifest)
    except Exception as e:
        log("  %-34s FAILED %s" % (aid, e))


def phase_meshes(catalog, manifest, only=None, limit=None, log=print, batch=MESH_BATCH):
    todo = [
        s
        for s in catalog
        if (not only or s["id"].startswith(only))
        and manifest["assets"].get(s["id"], {}).get("concept")
        and manifest["assets"].get(s["id"], {}).get("mesh") is None
    ]
    if limit:
        todo = todo[:limit]
    # One octree setting applies to a whole submission, so batches have to be
    # homogeneous in it. Sorting first means a hero asset's 320 is never quietly
    # applied to the four ordinary props that happened to follow it.
    todo.sort(key=lambda s: (s.get("octree", OCTREE), s.get("meshSteps", MESH_STEPS)))
    log("meshes: %d to do in batches of %d" % (len(todo), batch))

    done = 0
    for start in range(0, len(todo), batch):
        chunk = todo[start : start + batch]
        items = [
            (s["id"], "gamegen/" + s["id"] + ".png", s.get("meshSeed", 7000 + (abs(hash(s["id"])) % 100000)))
            for s in chunk
        ]
        try:
            g = graphs.image_to_mesh_batch(
                items,
                octree=chunk[0].get("octree", OCTREE),
                steps=chunk[0].get("meshSteps", MESH_STEPS),
                threshold=MESH_THRESHOLD,
                algorithm=MESH_ALGORITHM,
            )
            outputs, secs = cc.run(g, timeout=600 + 300 * len(chunk))
        except Exception as e:
            log("  mesh batch of %d FAILED (%s)" % (len(chunk), e))
            traceback.print_exc()
            if not cc.wait_for_server(300):
                log("  ComfyUI did not come back; stopping mesh phase")
                return False
            continue

        for i, spec in enumerate(chunk):
            aid = spec["id"]
            files = cc.files_of(outputs.get("o%d" % i, {}))
            if not files:
                log("  %-34s no mesh produced" % aid)
                continue
            sub = files[0].get("subfolder") or ""
            raw = os.path.join(OUT, sub, files[0]["filename"])
            try:
                os.makedirs(GLB_DIR, exist_ok=True)
                dst = os.path.join(GLB_DIR, aid + ".glb")
                meta = meshproc.process(
                    raw,
                    dst,
                    target_faces=spec.get("faces", 3000),
                    target_height=spec.get("height", 2.0),
                    upright=spec.get("upright", "none"),
                    ground=spec.get("ground", True),
                    fit=spec.get("fit"),
                )
                manifest["assets"][aid].update({"mesh": aid + ".glb", "meshInfo": meta})
                done += 1
                log(
                    "  %-34s %5d tris  %6.1f KB  %s"
                    % (aid, meta["triangles"], meta["bytes"] / 1024.0, meta["size"])
                )
            except Exception as e:
                log("  %-34s post FAILED %s" % (aid, e))
            finally:
                # Raw reconstructions are five to twenty megabytes each and
                # there are hundreds; keeping them would fill the disk.
                try:
                    os.remove(raw)
                except OSError:
                    pass

        save_manifest(manifest)
        log("  meshes %d/%d  %5.1fs for %d  (%.1fs each)" % (done, len(todo), secs, len(chunk), secs / max(1, len(chunk))))
    return True


def phase_retry(catalog, manifest, rounds=2, only=None, log=print):
    """
    Re-rolls meshes that failed automated inspection.

    Reconstruction failures are seed-dependent, so a second attempt at the same
    image usually succeeds. The retry keeps whichever attempt scores better,
    which means running this can only improve a pack, never damage one.
    """
    by_id = {s["id"]: s for s in catalog}

    for round_index in range(rounds):
        _, bad = quality.audit(manifest)
        bad = [b for b in bad if not only or b[0].startswith(only)]
        if not bad:
            log("retry round %d: nothing to fix" % (round_index + 1))
            return True
        log("retry round %d: %d assets to re-roll" % (round_index + 1, len(bad)))
        for aid, reason, _ in bad:
            log("    %-32s %s" % (aid, reason))

        for start in range(0, len(bad), MESH_BATCH):
            chunk = [by_id[aid] for aid, _, _ in bad[start : start + MESH_BATCH] if aid in by_id]
            if not chunk:
                continue
            items = [
                (
                    s["id"],
                    "gamegen/" + s["id"] + ".png",
                    # A different seed each round, derived so it is reproducible.
                    91000 + round_index * 7919 + (abs(hash(s["id"])) % 60000),
                )
                for s in chunk
            ]
            try:
                g = graphs.image_to_mesh_batch(
                    items,
                    octree=OCTREE,
                    steps=MESH_STEPS + 6,
                    threshold=MESH_THRESHOLD,
                    algorithm=MESH_ALGORITHM,
                )
                outputs, secs = cc.run(g, timeout=600 + 300 * len(chunk))
            except Exception as e:
                log("  retry batch FAILED (%s)" % e)
                if not cc.wait_for_server(300):
                    return False
                continue

            for i, spec in enumerate(chunk):
                aid = spec["id"]
                files = cc.files_of(outputs.get("o%d" % i, {}))
                if not files:
                    continue
                sub = files[0].get("subfolder") or ""
                raw = os.path.join(OUT, sub, files[0]["filename"])
                candidate = os.path.join(GLB_DIR, aid + ".retry.glb")
                try:
                    meta = meshproc.process(
                        raw,
                        candidate,
                        target_faces=spec.get("faces", 3000),
                        target_height=spec.get("height", 2.0),
                        upright=spec.get("upright", "none"),
                        ground=spec.get("ground", True),
                        fit=spec.get("fit"),
                    )
                    entry = manifest["assets"][aid]
                    before = quality.score(entry)
                    trial = dict(entry)
                    trial["meshInfo"] = meta
                    after = quality.score(trial)

                    if after > before:
                        os.replace(candidate, os.path.join(GLB_DIR, aid + ".glb"))
                        entry["meshInfo"] = meta
                        log("  %-32s improved %.2f -> %.2f  %s" % (aid, before, after, meta["size"]))
                    else:
                        os.remove(candidate)
                        log("  %-32s kept original (%.2f >= %.2f)" % (aid, before, after))
                except Exception as e:
                    log("  %-32s retry post FAILED %s" % (aid, e))
                finally:
                    try:
                        os.remove(raw)
                    except OSError:
                        pass
            save_manifest(manifest)
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("phase", choices=["images", "meshes", "retry", "audit", "all"])
    ap.add_argument("--only", default=None, help="id prefix filter")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--catalog", default=os.path.join(ROOT, "scripts", "catalog.json"))
    args = ap.parse_args()

    with open(args.catalog) as f:
        catalog = json.load(f)
    manifest = load_manifest()

    if not cc.server_alive():
        print("ComfyUI is not responding on 8188")
        return 1

    if args.phase == "audit":
        good, bad = quality.audit(manifest)
        print("pass: %d   fail: %d" % (len(good), len(bad)))
        for aid, reason, sc in bad:
            print("  %-32s %-42s score %.2f" % (aid, reason, sc))
        return 0

    started = time.time()
    if args.phase in ("images", "all"):
        phase_images(catalog, manifest, args.only, args.limit)
    if args.phase in ("meshes", "all"):
        phase_meshes(catalog, manifest, args.only, args.limit)
    if args.phase in ("retry", "all"):
        phase_retry(catalog, manifest, rounds=2, only=args.only)

    done = sum(1 for a in manifest["assets"].values() if a.get("mesh"))
    print("finished %d meshes in %.1f min" % (done, (time.time() - started) / 60.0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
