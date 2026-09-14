"""
Assembles a playable character from the Quaternius modular kits into one GLB.

Three sources go into it:

  outfit   a full outfit from Modular Character Outfits - Fantasy: clothes,
           boots, hood and bare hands, skinned to the kit's humanoid rig
  head     cut out of a Universal Base Characters body with its eyes and
           eyebrows. The free outfit kit ships no heads, and the kit's own
           readme says a full body under the clothes clips through them
  extras   hair or a beard, which that kit already rigs to the outfit skeleton

Everything is bound to the outfit's skeleton **and the outfit's inverse bind
matrices**. The base body stands on a rig of its own, up to thirteen degrees
different in the neck, and binding its head with its own matrices would carry
that difference across as a crooked head. Bound with the outfit's, the head
sits exactly where it sits in its source file and turns about the outfit's
head bone, which is in the same place.

What is dropped on the way:

  - vertex colours, which are uniformly white, and the second to fourth UV
    sets, which no material reads
  - every triangle of the body not weighted to the head or neck
  - texture resolution the camera cannot use, per map, and PNG, for JPEG at
    4:4:4 so a packed map's channels do not bleed into each other

And what is added:

  - an occlusion reference on materials that carry an
    occlusion-roughness-metal map. The occlusion is already in its red
    channel; glTF ignores it unless a material says so
  - a colour on the hair. The free kit's hair maps are grey strands, meant to
    be tinted by a shader that only ships in the paid version, and untinted
    every character is an old man

  python tools/characters/build.py ranger --outfits <kit dir> --base <kit dir> \
      --out public/assets/characters/ranger.glb
"""

import argparse
import copy
import io
import json
import os
import struct

import numpy as np
from PIL import Image

DTYPES = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
WIDTH = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
ARRAY_BUFFER = 34962
ELEMENT_ARRAY_BUFFER = 34963

#: The attributes that survive. Everything the materials here actually read.
KEEP_ATTRIBUTES = ("POSITION", "NORMAL", "TEXCOORD_0", "JOINTS_0", "WEIGHTS_0")

#: How much of a body counts as head: the summed weight a vertex gives these
#: bones. Low enough to keep the neck the hood's collar sits over.
HEAD_BONES = ("Head", "neck_01")
HEAD_WEIGHT = 0.35

#: Size and quality per map, by source file name. The outfit is most of what
#: the camera sees and gets the most; the skin atlas is mostly a body that is
#: thrown away, so the face lives in a small corner of it and keeps 2048.
TEXTURES = {
    "T_Ranger_BaseColor.png": (4096, 90),
    "T_Ranger_3_BaseColor.png": (4096, 90),
    "T_Ranger_Normal.png": (4096, 92),
    "T_Ranger_ORM.png": (2048, 90),
    "T_Peasant_BaseColor.png": (4096, 90),
    "T_Peasant_2_BaseColor.png": (4096, 90),
    "T_Peasant_Normal.png": (4096, 92),
    "T_Peasant_ORM.png": (2048, 90),
    "T_Regular_Male_Dark_BaseColor.png": (1024, 90),
    "T_Regular_Male_Normal.png": (1024, 92),
    "T_Regular_Male_Roughness.png": (512, 90),
    "T_Superhero_Male_Dark.png": (2048, 92),
    "T_Superhero_Male_Ligh.png": (2048, 92),
    "T_Superhero_Male_Normal.png": (2048, 92),
    "T_Superhero_Male_Roughness.png": (1024, 90),
    "T_Hair_1_BaseColor.png": (1024, 90),
    "T_Hair_1_Normal.png": (1024, 92),
    "T_Hair_2_BaseColor.png": (1024, 90),
    "T_Hair_2_Normal.png": (1024, 92),
}
DEFAULT_TEXTURE = (2048, 90)
#: Small maps stay lossless; at 256 pixels the saving is nothing.
LOSSLESS_BELOW = 512

OUTFITS = "Exports/glTF (Godot-Unreal)/Outfits/"
BODIES = "Base Characters/Godot - UE/"
HAIR = "Hairstyles/Rigged to Head Bone/glTF (Godot -Unreal)/"

#: Dark warm brown. The factor multiplies a grey map, so it is well below the
#: colour it produces: the strands average 0.27 in linear light.
BROWN_HAIR = [0.2, 0.1, 0.05, 1.0]

RANGER = {
    "outfit": ("outfits", OUTFITS + "Male_Ranger.gltf"),
    "head": ("base", BODIES + "Superhero_Male_FullBody.gltf"),
    # Buzzed, because it is the only cut that sits inside the hood: every
    # longer one pushes through the cloth at the crown or the nape.
    "extras": [("base", HAIR + "Hair_Buzzed.gltf"), ("base", HAIR + "Hair_Beard.gltf")],
    # Swap a map for one of the kit's colour variants: {uri: (kit, path)}.
    "palette": {},
    # Merged into a material by name, after its textures are resolved.
    "materials": {"MI_Hair_1": {"pbrMetallicRoughness": {"baseColorFactor": BROWN_HAIR}}},
}

RECIPES = {
    # The kit's third colourway: oiled leather, undyed wool and a mustard
    # tunic. Its own default is forest green, which next to a stone cottage
    # reads as a costume rather than as clothes.
    "ranger": dict(RANGER, palette={"T_Ranger_BaseColor.png": ("outfits", "Textures/Ranger/T_Ranger_3_BaseColor.png")}),
    "ranger_green": RANGER,
}


class Source:
    """A .gltf with an external .bin, read-only."""

    def __init__(self, path):
        self.path = path
        self.dir = os.path.dirname(path)
        with open(path, encoding="utf-8") as f:
            self.doc = json.load(f)
        with open(os.path.join(self.dir, self.doc["buffers"][0]["uri"]), "rb") as f:
            self.bin = f.read()

    def accessor(self, index):
        acc = self.doc["accessors"][index]
        view = self.doc["bufferViews"][acc["bufferView"]]
        dtype = np.dtype(DTYPES[acc["componentType"]])
        width = WIDTH[acc["type"]]
        if view.get("byteStride", dtype.itemsize * width) != dtype.itemsize * width:
            raise SystemExit("interleaved accessor %d in %s" % (index, self.path))
        start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
        data = np.frombuffer(self.bin, dtype, acc["count"] * width, start).reshape(acc["count"], width)
        return data, acc

    def node(self, name):
        for i, n in enumerate(self.doc["nodes"]):
            if n.get("name") == name:
                return i, n
        raise SystemExit("no node %r in %s" % (name, self.path))

    def joint_names(self):
        return [self.doc["nodes"][j]["name"] for j in self.doc["skins"][0]["joints"]]

    def image_uri(self, texture_index):
        return self.doc["images"][self.doc["textures"][texture_index]["source"]]["uri"]


def weights_as_float(data, acc):
    if acc["componentType"] == 5126:
        return data.astype(np.float32)
    return data.astype(np.float32) / float(np.iinfo(DTYPES[acc["componentType"]]).max)


def head_only(src, attributes, triangles):
    """Keeps triangles whose every corner leans on the head or neck."""
    names = src.joint_names()
    joints, _ = attributes["JOINTS_0"]
    weights = weights_as_float(*attributes["WEIGHTS_0"])
    share = sum(((joints == names.index(b)) * weights).sum(axis=1) for b in HEAD_BONES)
    return (share[triangles] >= HEAD_WEIGHT).all(axis=1)


def merge(into, patch):
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(into.get(key), dict):
            merge(into[key], value)
        else:
            into[key] = copy.deepcopy(value)


def encode(path):
    size, quality = TEXTURES.get(os.path.basename(path), DEFAULT_TEXTURE)
    image = Image.open(path)
    if image.width <= LOSSLESS_BELOW:
        buf = io.BytesIO()
        image.save(buf, "PNG", optimize=True)
        return buf.getvalue(), "image/png", image.size
    image = image.convert("RGB")
    if image.width != size:
        image = image.resize((size, size), Image.LANCZOS)
    buf = io.BytesIO()
    # 4:4:4, because every map here is either a packed map whose channels are
    # unrelated or hand-painted colour with hard edges. No `optimize`: with
    # full chroma it has produced unreadable files before.
    image.save(buf, "JPEG", quality=quality, subsampling=0)
    return buf.getvalue(), "image/jpeg", image.size


class Output:
    def __init__(self, palette, materials):
        self.palette = palette
        self.overrides = materials
        self.binary = bytearray()
        self.doc = {
            "asset": {"version": "2.0", "generator": "rift-engine tools/characters/build.py"},
            "scene": 0,
            "scenes": [],
            "nodes": [],
            "meshes": [],
            "materials": [],
            "textures": [],
            "images": [],
            "samplers": [],
            "skins": [],
            "accessors": [],
            "bufferViews": [],
            "buffers": [],
        }
        self.materials = {}
        self.images = {}
        self.textures = {}
        self.report = []

    def view(self, data, target=None):
        self.binary.extend(b"\0" * (-len(self.binary) % 4))
        view = {"buffer": 0, "byteOffset": len(self.binary), "byteLength": len(data)}
        if target:
            view["target"] = target
        self.binary.extend(data)
        self.doc["bufferViews"].append(view)
        return len(self.doc["bufferViews"]) - 1

    def accessor(self, data, component, kind, normalized=False, bounds=False, target=None):
        data = np.ascontiguousarray(data.astype(DTYPES[component], copy=False))
        acc = {"bufferView": self.view(data.tobytes(), target), "componentType": component,
               "count": int(data.shape[0]), "type": kind}
        if normalized:
            acc["normalized"] = True
        if bounds:
            acc["min"] = data.min(axis=0).tolist()
            acc["max"] = data.max(axis=0).tolist()
        self.doc["accessors"].append(acc)
        return len(self.doc["accessors"]) - 1

    def texture(self, src, index):
        uri = src.image_uri(index)
        path = self.palette.get(uri) or os.path.join(src.dir, uri)
        if not os.path.exists(path) and path.endswith("_png.png"):
            # Blender names an image it re-saved "<name>_png.png", and the kits
            # reference those names without always shipping the files. The
            # original sits beside it.
            path = path[: -len("_png.png")] + ".png"
        if not os.path.exists(path):
            raise SystemExit("missing image %s" % path)
        if path not in self.images:
            data, mime, size = encode(path)
            name = os.path.splitext(os.path.basename(path))[0]
            self.doc["images"].append({"name": name, "bufferView": self.view(data), "mimeType": mime})
            self.images[path] = len(self.doc["images"]) - 1
            self.report.append("  %-36s %4d  %6.0f KB" % (name, size[0], len(data) / 1024))
        tex = src.doc["textures"][index]
        sampler = src.doc["samplers"][tex["sampler"]] if "sampler" in tex else None
        key = (self.images[path], json.dumps(sampler, sort_keys=True))
        if key not in self.textures:
            entry = {"source": self.images[path]}
            if sampler is not None:
                self.doc["samplers"].append(sampler)
                entry["sampler"] = len(self.doc["samplers"]) - 1
            self.doc["textures"].append(entry)
            self.textures[key] = len(self.doc["textures"]) - 1
        return self.textures[key]

    def material(self, src, index):
        mat = copy.deepcopy(src.doc["materials"][index])
        name = mat.get("name", "material%d" % index)
        if name in self.materials:
            return self.materials[name]
        pbr = mat.get("pbrMetallicRoughness", {})
        packed = pbr.get("metallicRoughnessTexture")
        is_orm = packed is not None and "_ORM" in src.image_uri(packed["index"])
        for info in [pbr.get("baseColorTexture"), packed, mat.get("normalTexture"),
                     mat.get("occlusionTexture"), mat.get("emissiveTexture")]:
            if info is not None:
                info["index"] = self.texture(src, info["index"])
        if is_orm and "occlusionTexture" not in mat:
            mat["occlusionTexture"] = {"index": packed["index"]}
        merge(mat, self.overrides.get(name, {}))
        self.doc["materials"].append(mat)
        self.materials[name] = len(self.doc["materials"]) - 1
        return self.materials[name]

    def mesh(self, src, mesh_index, name, keep=None):
        primitives = []
        triangles_out = 0
        for prim in src.doc["meshes"][mesh_index]["primitives"]:
            attributes = {k: src.accessor(v) for k, v in prim["attributes"].items() if k in KEEP_ATTRIBUTES}
            triangles = src.accessor(prim["indices"])[0].reshape(-1, 3).astype(np.int64)
            if keep is not None:
                triangles = triangles[keep(src, attributes, triangles)]
                used = np.unique(triangles)
                remap = np.full(attributes["POSITION"][0].shape[0], -1, np.int64)
                remap[used] = np.arange(len(used))
                triangles = remap[triangles]
                attributes = {k: (data[used], acc) for k, (data, acc) in attributes.items()}
            if not len(triangles):
                continue
            written = {}
            for key, (data, acc) in attributes.items():
                written[key] = self.accessor(data, acc["componentType"], acc["type"], acc.get("normalized", False),
                                             bounds=(key == "POSITION"), target=ARRAY_BUFFER)
            count = attributes["POSITION"][0].shape[0]
            out = {
                "attributes": written,
                "indices": self.accessor(triangles.reshape(-1, 1), 5123 if count < 65536 else 5125, "SCALAR",
                                         target=ELEMENT_ARRAY_BUFFER),
            }
            if "material" in prim:
                out["material"] = self.material(src, prim["material"])
            primitives.append(out)
            triangles_out += len(triangles)
        self.doc["meshes"].append({"name": name, "primitives": primitives})
        return len(self.doc["meshes"]) - 1, triangles_out

    def glb(self, path):
        self.binary.extend(b"\0" * (-len(self.binary) % 4))
        self.doc["buffers"] = [{"byteLength": len(self.binary)}]
        for key in [k for k, v in self.doc.items() if isinstance(v, list) and not v]:
            del self.doc[key]
        text = json.dumps(self.doc, separators=(",", ":")).encode("utf-8")
        text += b" " * (-len(text) % 4)
        with open(path, "wb") as f:
            f.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(text) + 8 + len(self.binary)))
            f.write(struct.pack("<II", len(text), 0x4E4F534A))
            f.write(text)
            f.write(struct.pack("<II", len(self.binary), 0x004E4942))
            f.write(self.binary)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("recipe", choices=sorted(RECIPES))
    ap.add_argument("--outfits", required=True, help="Modular Character Outfits - Fantasy[Standard] directory")
    ap.add_argument("--base", required=True, help="Universal Base Characters[Standard] directory")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    kits = {"outfits": args.outfits, "base": args.base}
    recipe = RECIPES[args.recipe]
    resolve = lambda ref: os.path.join(kits[ref[0]], ref[1])
    out = Output({uri: resolve(ref) for uri, ref in recipe["palette"].items()}, recipe.get("materials", {}))

    outfit = Source(resolve(recipe["outfit"]))
    skeleton = outfit.joint_names()

    # The outfit's own nodes come across whole, so bone indices and the
    # hierarchy survive untouched; only what the mesh nodes point at changes.
    out.doc["nodes"] = copy.deepcopy(outfit.doc["nodes"])
    out.doc["scenes"] = copy.deepcopy(outfit.doc["scenes"])
    ibm, ibm_acc = outfit.accessor(outfit.doc["skins"][0]["inverseBindMatrices"])
    skin = copy.deepcopy(outfit.doc["skins"][0])
    skin["inverseBindMatrices"] = out.accessor(ibm, ibm_acc["componentType"], "MAT4")
    out.doc["skins"] = [skin]

    bone_names = set(skeleton)
    armature = None
    total = 0
    for i, node in enumerate(out.doc["nodes"]):
        if "mesh" in node:
            node["mesh"], tris = out.mesh(outfit, outfit.doc["nodes"][i]["mesh"], node["name"])
            node["skin"] = 0
            total += tris
            print("  %-34s %6d tris  (outfit)" % (node["name"], tris))
        if node.get("children") and any(outfit.doc["nodes"][c].get("name") == "root" for c in node["children"]):
            armature = node
    if armature is None:
        raise SystemExit("could not find the armature node in the outfit")

    def graft(src, node_name, new_name, keep=None):
        nonlocal total
        if src.joint_names() != skeleton:
            raise SystemExit("%s is on a different joint list" % src.path)
        if new_name in bone_names:
            raise SystemExit("%s would shadow a bone of the same name" % new_name)
        _, node = src.node(node_name)
        mesh, tris = out.mesh(src, node["mesh"], new_name, keep)
        out.doc["nodes"].append({"name": new_name, "mesh": mesh, "skin": 0})
        armature["children"].insert(0, len(out.doc["nodes"]) - 1)
        total += tris
        print("  %-34s %6d tris  (%s)" % (new_name, tris, os.path.basename(src.path)))

    head = Source(resolve(recipe["head"]))
    body = next(n["name"] for n in head.doc["nodes"] if "mesh" in n and n["name"] not in ("Eyes", "Eyebrows"))
    graft(head, body, "Character_Head", keep=head_only)
    graft(head, "Eyes", "Character_Eyes")
    graft(head, "Eyebrows", "Character_Eyebrows")
    for ref in recipe["extras"]:
        extra = Source(resolve(ref))
        for node in extra.doc["nodes"]:
            if "mesh" in node:
                graft(extra, node["name"], "Character_" + node["name"])

    top = max(float(out.doc["accessors"][p["attributes"]["POSITION"]]["max"][1])
              for m in out.doc["meshes"] for p in m["primitives"])
    out.doc["asset"]["copyright"] = "Quaternius, CC0 1.0: Modular Character Outfits - Fantasy, Universal Base Characters"
    out.doc["asset"]["extras"] = {"height": top, "triangles": total}

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    out.glb(args.out)
    print("\n".join(out.report))
    print("%d triangles, %.3f tall, %d materials, %.2f MB -> %s" % (
        total, top, len(out.doc["materials"]), os.path.getsize(args.out) / 1e6, args.out))


if __name__ == "__main__":
    main()
