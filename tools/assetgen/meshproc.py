"""
Turns a raw Hunyuan3D reconstruction into a game-ready mesh.

A single-view reconstruction comes out as a dense iso-surface: a couple of
hundred thousand triangles, arbitrary scale, arbitrary centre, no normals worth
having. None of that is usable in a browser, where the whole asset pack has to
download. This does the six things that make it usable:

  clean       drop duplicate vertices and degenerate faces
  decimate    quadric edge collapse to a triangle budget
  orient      put the model in the engine's frame, longest axis where it belongs
  ground      centre on the origin in X/Z, rest the base at y = 0
  scale       normalise to a real size in world units
  shade       recompute normals so flat shading reads correctly

The result is a few hundred kilobytes instead of nine megabytes, and it drops
onto the ground plane at the right size without hand-tuning every asset.
"""

import json
import math
import os

import numpy as np
import trimesh

try:
    import fast_simplification

    HAVE_FS = True
except Exception:  # pragma: no cover - environment dependent
    HAVE_FS = False


def _remove_base_slab(mesh):
    """
    Cuts off the ground plate the reconstructor invents beneath the subject.

    Single-view reconstruction reads the concept art's background as a surface
    and returns the object standing on a wide, flat disc. It is usually fused to
    the model, so component splitting will not remove it, and it is nearly
    always the largest thing in the file: filtering by area keeps the plate and
    throws away the sword.

    Detection is by silhouette radius per horizontal band. A plate shows up as a
    band near the floor that is several times wider than the body above it. The
    mesh is sliced just above that band.
    """
    v = np.asarray(mesh.vertices)
    if len(v) < 32:
        return mesh
    ymin = float(v[:, 1].min())
    ymax = float(v[:, 1].max())
    height = ymax - ymin
    if height <= 1e-6:
        return mesh

    # A plate is identified by what it is made of, not how wide it is. Width
    # alone cannot tell a ground disc from a winged crossguard, but a plate is
    # almost entirely up-facing and down-facing triangles crowded into a thin
    # band at the floor, and real subject geometry is not.
    try:
        normals = mesh.face_normals
        centres = mesh.triangles_center
        areas = mesh.area_faces
    except Exception:
        return mesh

    flat_faces = np.abs(normals[:, 1]) > 0.86
    low_faces = centres[:, 1] < (ymin + height * 0.25)
    slab = flat_faces & low_faces
    total_area = float(areas.sum())
    if total_area <= 0 or float(areas[slab].sum()) < total_area * 0.05:
        return mesh

    # Cut just above the highest part of the slab.
    y_cut = float(np.percentile(centres[slab, 1], 96)) + height * 0.012

    # Never take more than a quarter of the model. A crate or a chest is
    # legitimately a flat-bottomed box, and losing its lower half to an
    # over-eager plate detector is worse than leaving a thin skirt on a tower.
    y_cut = min(y_cut, ymin + height * 0.25)
    try:
        sliced = mesh.slice_plane(plane_origin=[0, y_cut, 0], plane_normal=[0, 1, 0], cap=True)
    except Exception:
        return mesh
    if sliced is None or len(sliced.faces) < 64:
        return mesh
    return sliced


def _remove_wide_base(mesh, bands=26, ratio=1.5, max_cut=0.18):
    """
    Cuts a base that is far wider than the model standing on it.

    The flat-face detector above finds the thin disc a reconstructor invents
    under a sword. It cannot find the one under a building, because a building
    genuinely has a flat bottom and its own footprint is exactly what the test
    measures. What separates the two is the profile: real architecture is about
    as wide at the ankles as at the waist, and an invented plate is not. A
    barracks came back 20.7 by 24.5 with the building itself occupying maybe
    half of that.

    The cut is capped at a sixth of the height, so a genuinely battered wall or
    a stepped plinth loses a skirt at worst rather than its ground floor.
    """
    v = np.asarray(mesh.vertices)
    if len(v) < 256:
        return mesh
    ymin, ymax = float(v[:, 1].min()), float(v[:, 1].max())
    height = ymax - ymin
    if height <= 1e-6:
        return mesh

    edges = np.linspace(ymin, ymax, bands + 1)
    idx = np.clip(np.digitize(v[:, 1], edges) - 1, 0, bands - 1)
    span = np.zeros(bands)
    for b in range(bands):
        pts = v[idx == b]
        if len(pts) < 8:
            span[b] = np.nan
            continue
        # Robust half-extent: percentiles rather than min and max, so one
        # stray vertex does not define the band.
        dx = np.percentile(pts[:, 0], 97) - np.percentile(pts[:, 0], 3)
        dz = np.percentile(pts[:, 2], 97) - np.percentile(pts[:, 2], 3)
        span[b] = max(dx, dz)

    # The body is the middle of the model, which is what the base is compared to.
    body = np.nanmedian(span[max(1, bands // 6) : bands // 2 + 1])
    if not np.isfinite(body) or body <= 1e-6:
        return mesh
    if not np.isfinite(span[0]) or span[0] < body * ratio:
        return mesh

    limit = int(bands * max_cut) + 1
    cut_band = 0
    for b in range(1, limit + 1):
        if np.isfinite(span[b]) and span[b] < body * 1.18:
            cut_band = b
            break
    if cut_band == 0:
        cut_band = limit

    y_cut = float(edges[cut_band])
    try:
        sliced = mesh.slice_plane(plane_origin=[0, y_cut, 0], plane_normal=[0, 1, 0], cap=True)
    except Exception:
        return mesh
    if sliced is None or len(sliced.faces) < 128:
        return mesh
    return sliced


def _keep_significant_parts(mesh, min_fraction=0.12):
    """
    Drops floating speckle while keeping real detached detail.

    Parts are ranked by bounding-box diagonal rather than surface area, because
    area over-rewards a large flat artifact and under-rewards a thin blade.
    """
    try:
        parts = mesh.split(only_watertight=False)
    except Exception:
        return mesh
    if len(parts) <= 1:
        return mesh

    def span(p):
        e = p.extents
        return float(math.sqrt(float(e[0]) ** 2 + float(e[1]) ** 2 + float(e[2]) ** 2))

    spans = np.array([span(p) for p in parts])
    keep = [p for p, s in zip(parts, spans) if s >= spans.max() * min_fraction]
    if not keep:
        return mesh
    return trimesh.util.concatenate(keep)


def _decimate(mesh, target_faces, passes=4):
    """
    Collapses to a triangle budget, repeatedly.

    One call to the quadric simplifier does not reach the target from a million
    faces: it stops early rather than collapse edges it judges harmful, and asked
    for 3,000 from 1,042,218 it returned 4,967. Iterating on its own output gets
    there, because each pass starts from a mesh whose remaining edges are cheaper
    to judge. Measured over the pack this is the difference between a 30 MB
    download and a 17 MB one, for detail that the projected texture supplies
    anyway.
    """
    if len(mesh.faces) <= target_faces:
        return mesh
    if HAVE_FS:
        for _ in range(passes):
            faces = np.asarray(mesh.faces, dtype=np.int32)
            if len(faces) <= target_faces * 1.15:
                break
            verts = np.asarray(mesh.vertices, dtype=np.float32)
            ratio = min(max(1.0 - (target_faces / float(len(faces))), 0.0), 0.999)
            v, f = fast_simplification.simplify(verts, faces, ratio)
            if len(f) >= len(faces):
                break  # no progress; another pass would spin
            mesh = trimesh.Trimesh(vertices=v, faces=f, process=False)
        return mesh
    # Vertex clustering fallback: snap to a grid sized to hit roughly the
    # target count, averaging positions per cell so the silhouette survives.
    extent = float(np.max(mesh.extents))
    cells = max(8, int(round((target_faces / 2.0) ** (1.0 / 3.0) * 4)))
    pitch = extent / cells
    return mesh.simplify_vertex_clustering(pitch) if hasattr(mesh, "simplify_vertex_clustering") else mesh


def _orient(mesh, upright_axis=None):
    """
    Rotates the model into the engine's frame.

    The engine is Y-up with characters facing +Z. A reconstruction arrives in
    whatever frame the model felt like. `upright_axis` says which of the
    model's own axes should end up vertical: "longest" for things that are
    meant to stand tall, such as a sword or a tower, and None to leave it be.
    """
    if upright_axis != "longest":
        return mesh
    ext = mesh.extents
    axis = int(np.argmax(ext))
    if axis == 1:
        return mesh
    matrix = np.eye(4)
    if axis == 0:  # X is longest: rotate about Z to bring it to Y
        matrix = trimesh.transformations.rotation_matrix(math.pi / 2, [0, 0, 1])
    elif axis == 2:  # Z is longest: rotate about X
        matrix = trimesh.transformations.rotation_matrix(-math.pi / 2, [1, 0, 0])
    mesh.apply_transform(matrix)
    return mesh


def process(
    src_path,
    dst_path,
    target_faces=3000,
    target_height=2.0,
    upright="none",
    ground=True,
    fit=None,
):
    """
    Returns a metadata dict describing the written asset, or raises.

    `target_height` is the size in world units the longest vertical extent is
    scaled to, which is what lets a manifest place a tower and a dagger on the
    same map without either being absurd.
    """
    loaded = trimesh.load(src_path, force="mesh", process=False)
    if isinstance(loaded, trimesh.Scene):
        loaded = trimesh.util.concatenate(tuple(loaded.geometry.values()))
    mesh = loaded

    raw_faces = int(len(mesh.faces))
    if raw_faces == 0:
        raise ValueError("no geometry in %s" % src_path)

    mesh.merge_vertices()
    mesh.update_faces(mesh.nondegenerate_faces())
    mesh.remove_unreferenced_vertices()

    # Order matters: strip the invented ground plate before anything measures
    # the model, or every subsequent step is sized against the artifact.
    mesh = _remove_base_slab(mesh)
    mesh = _remove_wide_base(mesh)
    mesh = _keep_significant_parts(mesh)

    mesh = _decimate(mesh, target_faces)
    mesh.merge_vertices()
    mesh.update_faces(mesh.nondegenerate_faces())
    mesh.remove_unreferenced_vertices()

    mesh = _orient(mesh, "longest" if upright == "longest" else None)

    # Scale so the model's height matches the requested world size.
    extents = mesh.extents
    height = float(extents[1]) if extents[1] > 1e-6 else float(np.max(extents))
    scale = target_height / height if height > 1e-6 else 1.0
    mesh.apply_scale(scale)

    # Kit pieces are forced into an exact box, non-uniformly.
    #
    # A wall section that comes back 3.87 units long leaves a gap every time it
    # repeats, and forty repeats is a hole you can walk through. The distortion
    # is a few percent on a piece whose proportions were already asked for in
    # the prompt, and it is the difference between a kit and a pile of props.
    if fit:
        extents = mesh.extents
        mesh.apply_scale(
            [
                (fit[i] / extents[i]) if (fit[i] and extents[i] > 1e-6) else 1.0
                for i in range(3)
            ]
        )

    # Centre in X/Z and rest the base on the ground plane, so a placed prop
    # sits on the terrain instead of floating or sinking.
    bounds = mesh.bounds
    centre = (bounds[0] + bounds[1]) / 2.0
    offset = np.array([-centre[0], -bounds[0][1] if ground else -centre[1], -centre[2]])
    mesh.apply_translation(offset)

    mesh.fix_normals()

    os.makedirs(os.path.dirname(dst_path), exist_ok=True)
    mesh.export(dst_path)

    b = mesh.bounds
    size = (b[1] - b[0]).tolist()
    # Footprint radius drives collision and editor snapping.
    radius = float(math.hypot(size[0], size[2]) * 0.5)
    return {
        "file": os.path.basename(dst_path),
        "triangles": int(len(mesh.faces)),
        "rawTriangles": raw_faces,
        "bytes": os.path.getsize(dst_path),
        "size": [round(v, 4) for v in size],
        "radius": round(radius, 4),
        "decimator": "quadric" if HAVE_FS else "clustering",
    }


if __name__ == "__main__":
    import sys

    src, dst = sys.argv[1], sys.argv[2]
    faces = int(sys.argv[3]) if len(sys.argv) > 3 else 3000
    height = float(sys.argv[4]) if len(sys.argv) > 4 else 2.0
    upright = sys.argv[5] if len(sys.argv) > 5 else "none"
    print(json.dumps(process(src, dst, faces, height, upright), indent=2))
