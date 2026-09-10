"""
Second-pass ground-plate removal over an already-built pack.

The plate detector in meshproc catches most cases during generation, but it is
deliberately conservative: it runs before anything else has measured the model,
and cutting too much is worse than leaving a skirt. On a large building the
plate can be a small fraction of total surface area and slip under the
threshold, which is why some assets still stand on a visible slab.

This runs after the fact, when more is known. Rather than a fraction of surface
area it compares the silhouette at the floor against the silhouette just above
it: a plate is a sudden, large widening in the bottom few percent of the height
that the body above does not share. That comparison is only possible once the
model has been normalised, which is exactly why it belongs in a second pass.

  python3 deplate.py <glb-dir> [--apply]

Without --apply it only reports.
"""

import os
import sys

import numpy as np
import trimesh


def silhouette_radius(v, centre, lo, hi):
    """95th-percentile horizontal radius of vertices in a height band."""
    sel = (v[:, 1] >= lo) & (v[:, 1] < hi)
    if sel.sum() < 8:
        return None
    r = np.hypot(v[sel, 0] - centre[0], v[sel, 2] - centre[1])
    return float(np.percentile(r, 95))


def find_plate(mesh, max_cut_fraction=0.14):
    """
    Returns the height to cut at, or None.

    A plate shows up as a floor band far wider than the band above it, made of
    horizontal faces. Both conditions are required: a pagoda roof is wide but
    is not at the floor, and a flat-bottomed crate is at the floor but is not
    wider than itself.
    """
    v = np.asarray(mesh.vertices)
    if len(v) < 64:
        return None
    ymin = float(v[:, 1].min())
    ymax = float(v[:, 1].max())
    height = ymax - ymin
    if height <= 1e-6:
        return None

    centre = (float(np.median(v[:, 0])), float(np.median(v[:, 2])))

    # Walk up from the floor in thin bands looking for the step where the
    # silhouette collapses.
    #
    # A fixed floor band does not work: it assumes the plate is thinner than
    # some chosen fraction of the height, and when it is not, the band contains
    # part of the object too and the widening disappears. Scanning for the drop
    # finds the plate's actual top, whatever its thickness.
    bands = 40
    step = height / bands
    radii = []
    for b in range(bands):
        r = silhouette_radius(v, centre, ymin + b * step, ymin + (b + 1) * step)
        radii.append(r)

    r_floor = radii[0]
    if r_floor is None or r_floor <= 1e-6:
        return None

    limit = int(bands * max_cut_fraction) + 1
    drop_at = None
    for b in range(1, min(limit + 1, bands)):
        r = radii[b]
        if r is None:
            continue
        if r < r_floor * 0.62:
            drop_at = b
            break

    if drop_at is None:
        return None

    # The body above the drop has to stay narrow, or this was a genuine flared
    # base such as a tower's foundation rather than an invented slab.
    above = [r for r in radii[drop_at : drop_at + bands // 3] if r is not None]
    if not above:
        return None
    if float(np.median(above)) > r_floor * 0.78:
        return None

    # Confirm the removed band is a flat slab, not a mass of real geometry.
    try:
        normals = mesh.face_normals
        centres = mesh.triangles_center
        areas = mesh.area_faces
    except Exception:
        return None
    cut = ymin + drop_at * step
    low = centres[:, 1] < cut
    flat = np.abs(normals[:, 1]) > 0.8
    if low.sum() == 0:
        return None
    flat_share = float(areas[low & flat].sum()) / max(1e-9, float(areas[low].sum()))
    if flat_share < 0.5:
        return None

    return min(cut, ymin + height * max_cut_fraction)


def deplate(path, apply=False):
    mesh = trimesh.load(path, force="mesh", process=False)
    if isinstance(mesh, trimesh.Scene):
        mesh = trimesh.util.concatenate(tuple(mesh.geometry.values()))

    before = mesh.extents.copy()
    cut = find_plate(mesh)
    if cut is None:
        return None

    # Capping needs a watertight cross-section and these meshes are not
    # reliably watertight, so an uncapped slice is the fallback. An open
    # underside is invisible: nothing ever sees a prop from below.
    sliced = None
    for cap in (True, False):
        try:
            sliced = mesh.slice_plane(plane_origin=[0, cut, 0], plane_normal=[0, 1, 0], cap=cap)
            if sliced is not None and len(sliced.faces) >= 64:
                break
            sliced = None
        except Exception:
            sliced = None
    if sliced is None:
        return None

    # Refuse to cut away a large share of the model. A plate is a thin slab;
    # anything that removes a third of the geometry is legs, or a base that is
    # part of the design.
    if len(sliced.faces) < len(mesh.faces) * 0.6:
        return None

    # Re-ground and re-centre, then keep the original height so the catalog's
    # authored size still holds.
    b = sliced.bounds
    centre = (b[0] + b[1]) / 2.0
    sliced.apply_translation([-centre[0], -b[0][1], -centre[2]])
    new_height = float(sliced.extents[1])
    if new_height > 1e-6:
        sliced.apply_scale(float(before[1]) / new_height)
    sliced.fix_normals()

    after = sliced.extents
    shrink = 1.0 - (after[0] * after[2]) / max(1e-9, before[0] * before[2])
    if apply:
        sliced.export(path)
    return {
        "before": [round(float(x), 2) for x in before],
        "after": [round(float(x), 2) for x in after],
        "footprintShrink": round(float(shrink), 3),
        "faces": int(len(sliced.faces)),
    }


# Only categories where a wide flat floor band is always an artifact.
#
# Creatures are excluded on purpose: a spider's outstretched legs sit at floor
# level, are horizontal, and are far wider than its body, which is exactly the
# signature of a plate. Cutting the legs off a spider is a much worse outcome
# than leaving a slab under a windmill.
SAFE_PREFIXES = ("building_", "nature_", "prop_")


if __name__ == "__main__":
    directory = sys.argv[1]
    apply = "--apply" in sys.argv
    changed = 0
    for name in sorted(os.listdir(directory)):
        if not name.endswith(".glb"):
            continue
        if not name.startswith(SAFE_PREFIXES):
            continue
        try:
            result = deplate(os.path.join(directory, name), apply)
        except Exception as e:
            print("  %-34s ERROR %s" % (name, e))
            continue
        if result:
            changed += 1
            print(
                "  %-34s %s -> %s  footprint -%.0f%%"
                % (name, result["before"], result["after"], result["footprintShrink"] * 100)
            )
    print("%s %d meshes" % ("stripped a plate from" if apply else "would strip a plate from", changed))
