"""
Bakes a building out of Medieval Village MegaKit pieces into one GLB.

The kit is a few hundred modular pieces on a two-metre grid — wall panels with
their timbers and window openings, corner posts, floors, roofs, doors,
shutters — made to be put together by hand in an editor. This puts them
together from a list instead, so a building is a few dozen lines of
`designs.py` rather than an afternoon of dragging, and the result is one file
the engine loads whole.

Merged by material. Every piece's triangles are carried into the building's
frame and appended to one primitive per material, so a house of eighty pieces
is a dozen draw calls and each texture is uploaded once, not once for every
piece that uses it.

Two corrections on the way through:

  normals    the kit's glTF export carries Unreal's normal maps, with green
             flipped, and keeps the OpenGL ones in a folder of their own.
             three.js reads OpenGL; the other set lights every brick from
             below
  occlusion  a material with an occlusion-roughness-metal map is told its
             occlusion is in the red channel, which glTF otherwise ignores

  python tools/buildings/bake.py cottage --kit <Medieval Village MegaKit[Standard]> \
      --out public/assets/buildings/cottage.glb
"""

import argparse
import copy
import io
import json
import math
import os
import struct

import numpy as np
from PIL import Image

from designs import DESIGNS

DTYPES = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
WIDTH = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}

#: Size and JPEG quality by map kind. Colour and relief are what the camera
#: reads on a wall at arm's length; roughness is a soft field and costs a
#: quarter as much at half the size with nothing lost.
TEXTURES = {"BaseColor": (2048, 90), "Normal": (2048, 92), "Roughness": (1024, 90), "ORM": (1024, 90)}
DEFAULT_TEXTURE = (1024, 90)
#: Leaves need their alpha, and at 512 pixels a PNG costs nothing.
LOSSLESS_BELOW = 512


def node_matrix(node):
    if "matrix" in node:
        return np.array(node["matrix"], dtype=np.float64).reshape(4, 4).T
    x, y, z, w = node.get("rotation", [0.0, 0.0, 0.0, 1.0])
    rotation = np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])
    m = np.eye(4)
    m[:3, :3] = rotation * np.array(node.get("scale", [1.0, 1.0, 1.0]))
    m[:3, 3] = node.get("translation", [0.0, 0.0, 0.0])
    return m


def placement(at, turn, scale):
    """Turn in degrees about +y, then move. A turn of 90 carries +z to +x."""
    a = math.radians(turn)
    c, s = math.cos(a), math.sin(a)
    m = np.eye(4)
    m[:3, :3] = np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]]) * scale
    m[:3, 3] = at
    return m


class Piece:
    def __init__(self, kit, name):
        self.path = os.path.join(kit, "glTF", name + ".gltf")
        if not os.path.exists(self.path):
            raise SystemExit("no piece called %s" % name)
        self.dir = os.path.dirname(self.path)
        with open(self.path, encoding="utf-8") as f:
            self.doc = json.load(f)
        with open(os.path.join(self.dir, self.doc["buffers"][0]["uri"]), "rb") as f:
            self.bin = f.read()

    def accessor(self, index):
        acc = self.doc["accessors"][index]
        view = self.doc["bufferViews"][acc["bufferView"]]
        dtype = np.dtype(DTYPES[acc["componentType"]])
        width = WIDTH[acc["type"]]
        if view.get("byteStride", dtype.itemsize * width) != dtype.itemsize * width:
            raise SystemExit("interleaved accessor in %s" % self.path)
        start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
        return np.frombuffer(self.bin, dtype, acc["count"] * width, start).reshape(acc["count"], width)

    def primitives(self):
        """Every primitive with the transform of the node it hangs from."""
        scene = self.doc["scenes"][self.doc.get("scene", 0)]
        stack = [(index, np.eye(4)) for index in scene["nodes"]]
        while stack:
            index, parent = stack.pop()
            node = self.doc["nodes"][index]
            matrix = parent @ node_matrix(node)
            if "mesh" in node:
                for prim in self.doc["meshes"][node["mesh"]]["primitives"]:
                    yield matrix, prim
            stack.extend((child, matrix) for child in node.get("children", []))


class Bucket:
    """Everything drawn with one material, gathered from every piece."""

    def __init__(self):
        self.positions, self.normals, self.uvs, self.indices = [], [], [], []
        self.count = 0


def resolve_image(kit, piece, uri):
    name = os.path.basename(uri)
    if name.endswith("_Normal.png"):
        opengl = os.path.join(kit, "Textures", "Normals Godot-Unity", name)
        if os.path.exists(opengl):
            return opengl
    path = os.path.join(piece.dir, uri)
    if not os.path.exists(path) and path.endswith("_png.png"):
        path = path[: -len("_png.png")] + ".png"
    if not os.path.exists(path):
        raise SystemExit("missing image %s" % path)
    return path


def encode(path):
    image = Image.open(path)
    stem = os.path.splitext(os.path.basename(path))[0]
    kind = stem.rsplit("_", 1)[-1]
    size, quality = TEXTURES.get(kind, DEFAULT_TEXTURE)
    if image.width <= LOSSLESS_BELOW:
        buf = io.BytesIO()
        image.save(buf, "PNG", optimize=True)
        return buf.getvalue(), "image/png", image.width
    image = image.convert("RGB")
    size = min(size, image.width)
    if image.width != size:
        image = image.resize((size, size), Image.LANCZOS)
    buf = io.BytesIO()
    image.save(buf, "JPEG", quality=quality, subsampling=0)
    return buf.getvalue(), "image/jpeg", size


class Writer:
    def __init__(self, kit):
        self.kit = kit
        self.binary = bytearray()
        self.views, self.accessors = [], []
        self.images, self.textures, self.samplers, self.materials = [], [], [], []
        self.image_ids, self.texture_ids, self.material_ids = {}, {}, {}
        self.report = []

    def view(self, data):
        self.binary.extend(b"\0" * (-len(self.binary) % 4))
        self.views.append({"buffer": 0, "byteOffset": len(self.binary), "byteLength": len(data)})
        self.binary.extend(data)
        return len(self.views) - 1

    def accessor(self, data, component, kind, bounds=False):
        data = np.ascontiguousarray(data.astype(DTYPES[component], copy=False))
        acc = {"bufferView": self.view(data.tobytes()), "componentType": component,
               "count": int(data.shape[0]), "type": kind}
        if bounds:
            acc["min"] = data.min(axis=0).tolist()
            acc["max"] = data.max(axis=0).tolist()
        self.accessors.append(acc)
        return len(self.accessors) - 1

    def texture(self, piece, index):
        tex = piece.doc["textures"][index]
        path = resolve_image(self.kit, piece, piece.doc["images"][tex["source"]]["uri"])
        if path not in self.image_ids:
            data, mime, size = encode(path)
            stem = os.path.splitext(os.path.basename(path))[0]
            self.images.append({"name": stem, "bufferView": self.view(data), "mimeType": mime})
            self.image_ids[path] = len(self.images) - 1
            self.report.append("  %-34s %4d  %6.0f KB" % (stem, size, len(data) / 1024))
        sampler = piece.doc["samplers"][tex["sampler"]] if "sampler" in tex else None
        key = (self.image_ids[path], json.dumps(sampler, sort_keys=True))
        if key not in self.texture_ids:
            entry = {"source": self.image_ids[path]}
            if sampler is not None:
                self.samplers.append(sampler)
                entry["sampler"] = len(self.samplers) - 1
            self.textures.append(entry)
            self.texture_ids[key] = len(self.textures) - 1
        return self.texture_ids[key]

    def material(self, piece, index):
        mat = copy.deepcopy(piece.doc["materials"][index])
        pbr = mat.get("pbrMetallicRoughness", {})
        packed = pbr.get("metallicRoughnessTexture")
        is_orm = packed is not None and "_ORM" in piece.doc["images"][piece.doc["textures"][packed["index"]]["source"]]["uri"]
        for info in [pbr.get("baseColorTexture"), packed, mat.get("normalTexture"),
                     mat.get("occlusionTexture"), mat.get("emissiveTexture")]:
            if info is not None:
                info["index"] = self.texture(piece, info["index"])
        if is_orm and "occlusionTexture" not in mat:
            mat["occlusionTexture"] = {"index": packed["index"]}
        self.materials.append(mat)
        return len(self.materials) - 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("design", choices=sorted(DESIGNS))
    ap.add_argument("--kit", required=True, help="Medieval Village MegaKit[Standard] directory")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    plan = DESIGNS[args.design]()
    pieces = {}
    buckets = {}
    sources = {}
    for entry in plan:
        name = entry["piece"]
        piece = pieces.get(name) or pieces.setdefault(name, Piece(args.kit, name))
        place = placement(entry["at"], entry.get("turn", 0.0), entry.get("scale", 1.0))
        for local, prim in piece.primitives():
            matrix = place @ local
            positions = piece.accessor(prim["attributes"]["POSITION"]).astype(np.float64)
            normals = piece.accessor(prim["attributes"]["NORMAL"]).astype(np.float64)
            uvs = (piece.accessor(prim["attributes"]["TEXCOORD_0"]) if "TEXCOORD_0" in prim["attributes"]
                   else np.zeros((len(positions), 2), np.float32))
            indices = piece.accessor(prim["indices"]).reshape(-1).astype(np.int64)
            linear = matrix[:3, :3]
            moved = positions @ linear.T + matrix[:3, 3]
            turned = normals @ np.linalg.inv(linear)
            turned /= np.maximum(np.linalg.norm(turned, axis=1, keepdims=True), 1e-9)

            material = piece.doc["materials"][prim["material"]]["name"]
            sources.setdefault(material, (piece, prim["material"]))
            bucket = buckets.setdefault(material, Bucket())
            bucket.indices.append(indices + bucket.count)
            bucket.positions.append(moved)
            bucket.normals.append(turned)
            bucket.uvs.append(uvs)
            bucket.count += len(moved)

    out = Writer(args.kit)
    primitives = []
    total = 0
    everything = []
    for material, bucket in sorted(buckets.items()):
        positions = np.concatenate(bucket.positions)
        indices = np.concatenate(bucket.indices)
        everything.append(positions)
        component = 5123 if bucket.count < 65536 else 5125
        primitives.append({
            "attributes": {
                "POSITION": out.accessor(positions, 5126, "VEC3", bounds=True),
                "NORMAL": out.accessor(np.concatenate(bucket.normals), 5126, "VEC3"),
                "TEXCOORD_0": out.accessor(np.concatenate(bucket.uvs), 5126, "VEC2"),
            },
            "indices": out.accessor(indices.reshape(-1, 1), component, "SCALAR"),
            "material": out.material(*sources[material]),
        })
        total += len(indices) // 3
        print("  %-22s %6d tris" % (material, len(indices) // 3))

    points = np.concatenate(everything)
    # What stands on the ground, for blocking movement: everything within a
    # hand's breadth of it. A roof's eaves overhang the walls by half a metre
    # and nobody walks into those.
    low = points[points[:, 1] < 0.25]
    footprint = [float(low[:, 0].min()), float(low[:, 2].min()), float(low[:, 0].max()), float(low[:, 2].max())]

    out.binary.extend(b"\0" * (-len(out.binary) % 4))
    doc = {
        "asset": {
            "version": "2.0",
            "generator": "rift-engine tools/buildings/bake.py",
            "copyright": "Medieval Village MegaKit by Quaternius, CC0 1.0",
            "extras": {"footprint": footprint, "height": float(points[:, 1].max()), "triangles": total,
                       "pieces": len(plan)},
        },
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"name": args.design, "mesh": 0}],
        "meshes": [{"name": args.design, "primitives": primitives}],
        "materials": out.materials,
        "textures": out.textures,
        "images": out.images,
        "accessors": out.accessors,
        "bufferViews": out.views,
        "buffers": [{"byteLength": len(out.binary)}],
    }
    if out.samplers:
        doc["samplers"] = out.samplers

    text = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    text += b" " * (-len(text) % 4)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(text) + 8 + len(out.binary)))
        f.write(struct.pack("<II", len(text), 0x4E4F534A))
        f.write(text)
        f.write(struct.pack("<II", len(out.binary), 0x004E4942))
        f.write(out.binary)

    print("\n".join(out.report))
    print("%d pieces, %d triangles, %d materials, footprint %s, %.1f m tall, %.2f MB -> %s" % (
        len(plan), total, len(primitives), [round(v, 2) for v in footprint], points[:, 1].max(),
        os.path.getsize(args.out) / 1e6, args.out))


if __name__ == "__main__":
    main()
