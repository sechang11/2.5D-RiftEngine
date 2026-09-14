# Authored models

Everything else in the pack is generated: a picture, reconstructed into a shape,
coloured by projecting the picture back onto it. That got a whole city standing
and it has a ceiling. A reconstructed mesh has no UV layout, so nothing can be
painted onto it; no clean topology, so nothing can bend it; and no skeleton, so
nothing can move it. Every trick in [MATERIALS.md](MATERIALS.md) is a way of
working round those three facts, and up close all of them show.

A modern game character is made the other way round. Someone models it,
unwraps it, paints its colour, relief and roughness into textures laid out for
that mesh, skins it to a skeleton, and hands it to animators. The same goes
for a building made of kit pieces. None of that can be faked afterwards, so the
engine now takes models made that way, and the showcase exists to look at one
of each.

![The ranger on a cobbled apron in front of the cottage, lit by a photographed
sky](screenshot-showcase.jpg)

`/?mode=showcase` — right click to walk, Q W E R to cast, Z and C or the middle
mouse button to turn the view, and the wheel all the way down to the face.

## Where they came from

The choice was between generating with a newer model and using work made by
artists. The generators that now paint real PBR textures (TRELLIS.2,
Hunyuan3D 2.1) still return a statue: no rig, and topology that tears the moment
it is bent. For a character that has to walk, that decides it.

| Pack | Author | Licence | Download | Used for |
| --- | --- | --- | --- | --- |
| Universal Base Characters | Quaternius | CC0 | 129 MB | the head, eyes, brows, hair and beard |
| Modular Character Outfits – Fantasy | Quaternius | CC0 | 294 MB | the ranger's clothes, boots, hood and hands |
| Universal Animation Library | Quaternius | CC0 | 16 MB | every clip the ranger plays |
| Medieval Village MegaKit | Quaternius | CC0 | 161 MB | the cottage |
| Kloofendal 48d Partly Cloudy (Pure Sky) | Poly Haven | CC0 | 1.4 MB | the sky that lights both |

All four Quaternius packs are the free *Standard* tier from quaternius.itch.io,
and they share one humanoid rig and one art style, which is the reason for
using them together. Two things were looked at and passed over: KayKit's
characters, which are chibi-proportioned and would have repeated the complaint
about the old ones, and Poly Haven's scanned props, which are excellent and
photographic, and look pasted in next to painted models.

None of the source packs are in the repository. The tools below read them from
wherever they were unzipped and write only what the engine loads.

## The character

```bash
python tools/characters/build.py ranger \
    --outfits "<Modular Character Outfits - Fantasy[Standard]>" \
    --base "<Universal Base Characters[Standard]>" \
    --out public/assets/characters/ranger.glb
```

The outfit kit ships no heads. Its readme says to put its clothes on a base
character's head, and the free base characters are whole bodies. So the tool
cuts one: every triangle whose three corners take at least 35% of their weight
from the head or neck bone stays, and the other four fifths of the body go.

The head is bound with the **outfit's** inverse bind matrices, not its own. The
two skeletons put the head in exactly the same place but disagree by up to
thirteen degrees further down, and binding with the body's own matrices would
carry that disagreement up the neck. Bound with the outfit's, the head sits
where it sat in its source file and turns about the outfit's head bone.

On the way through it also:

- strips vertex colours, which are uniformly white, and three unused UV sets
- tints the hair material brown. The free kit's hair maps are grey, for a
  shader in the paid version to colour, and untinted every face is an old man's
- adds hair under the hood. Buzzed, because every longer cut pushes through the
  hood at the crown
- points occlusion at the red channel of the outfit's packed map, which glTF
  otherwise ignores
- takes the kit's third colourway — oiled leather, undyed wool, a mustard
  tunic — over its default forest green, which next to a stone cottage reads as
  a costume. `ranger_green` builds the other one
- re-encodes every map: the outfit's colour and relief at 4096, its packed map
  at 2048, the face at 2048, the hands, which are mostly under bracers, at 1024

33,502 triangles, five materials, 8.5 MB.

## Its animation

```bash
python tools/characters/anims.py "<Universal Animation Library>/Unreal-Godot/UAL1_Standard.glb" \
    public/assets/characters/anims.glb
```

The library keys all sixty-five bones in translation, rotation and scale on a
mannequin. A bone's translation is the length of the bone above it, so every
clip carries the mannequin's proportions as constant keys, and played on the
ranger they would drag his skeleton into the mannequin's shape. Only rotation
is kept, plus translation on the pelvis, where it is motion — the bob of a
stride, the drop of a crouch. Twenty clips survive, and the file goes from
7.6 MB to 0.7.

The mannequin's rest pose is still not the ranger's: its neck sits seventeen
degrees differently in its parent. Copying rotations would put the mannequin's
posture on the ranger. So each key is retargeted as a turn away from rest,
measured in the skeleton's frame, for bone *b* under parent *p*:

    target(b) = C · source(b) · sourceRest(b)⁻¹ · C⁻¹ · targetRest(b)
    where   C = targetRestWorld(p)⁻¹ · sourceRestWorld(p)

Both factors either side of the key are constants per bone, so a clip retargets
with two multiplications a key, once, at load. With identical rest poses `C` is
the identity and the whole thing collapses to a copy.

In play the body runs in two halves. The legs and pelvis blend walk, jog and
sprint by ground speed, with the playback rate set by stride length — metres
per cycle, read off the library's root-motion export — so feet do not skate.
Everything above blends the same clips until there is something to do with the
hands, and then plays that instead, so a spell goes off without the stride
stopping. When standing still the legs join in.

Attack and cast clips are laid onto the simulation's own timeline. A clip has
no marker for when a spell leaves the hand, so it is found: the frame at which
either hand moves fastest, measured once per model on a throwaway copy. That
frame is then scheduled to land on the tick the simulation fires, however long
the unit's attack speed makes the windup.

## The building

```bash
python tools/buildings/bake.py cottage --kit "<Medieval Village MegaKit[Standard]>" \
    --out public/assets/buildings/cottage.glb
```

A building is a function in `tools/buildings/designs.py` that returns a list of
kit pieces with positions and turns. The kit is on a two-metre grid with
three-metre storeys, and its conventions are written at the top of that file;
the helpers there put a ring of wall panels round a block of cells, fill each
opening with its glazing, shutters or door, lay floors, and run a kerb round the
foot of the walls. The cottage is eighty-eight pieces.

The bake carries every piece's triangles into the building's frame and appends
them to one primitive per material, so the cottage is ten draw calls and each of
its textures is uploaded once rather than once for every piece that uses it.

It also swaps the normal maps. The kit's glTF export carries Unreal's, with the
green channel flipped, and keeps the OpenGL ones in a folder of their own;
three.js reads OpenGL, and the wrong set lights every stone from below.

35,359 triangles, ten materials, 10.1 MB. The ground it covers is written into
the file, and the showcase stamps it into the nav grid so the ranger walks
round it rather than through it.

## In the engine

| | |
| --- | --- |
| `render/characters.ts` | Loads character models and the clip library, retargets, splits clips into halves, and hands out `SkinnedBody`s that pose from the same inputs as the procedural rigs |
| `render/buildings.ts` | Loads building models with their materials intact and places copies |
| `render/unitview.ts` | Draws an authored body for any archetype that names a model, and primitives for the rest, or if the model failed to load |
| `render/renderer.ts` | `loadSky` lights authored materials with an HDR sky, and in the showcase lights, shows and turns it |
| `game/showcase.ts` | The showcase map: the apron, the path to the door, the cottage's footprint |

The warden archetype names the ranger, so he is the player in every mode, not
only the showcase.

Three rendering changes came with them, all switched on only where they are
needed:

- **A photographed sky.** Painted models were balanced by their authors under
  skies like it, and under the old two-colour gradient their leather went grey
  and their buckles black. The generated pack keeps the gradient it was tuned
  against. In the showcase the sky is also turned about the vertical so its sun
  comes over the camera's shoulder: the scene is composed first and lit to suit.
- **Shadows on the ground.** The terrain is drawn unlit and receives nothing, so
  a transparent plane that renders only shadow follows the view. Without it the
  ranger looked pasted onto the cobbles.
- **Shaders compiled before the first frame.** The cottage's materials, the
  ranger's and the shadow variants of both would otherwise compile one after
  another on the main thread inside the first draw. They are compiled in
  parallel before it, for at most three seconds: readiness is checked on a
  timer, and a tab loaded in the background slows timers to a crawl.

## Costs

| | Triangles | Draw calls | File |
| --- | --- | --- | --- |
| Ranger | 33,502 | 14 | 8.5 MB |
| Clip library | | | 0.7 MB |
| Cottage | 35,359 | 10 | 10.1 MB |
| Sky | | | 1.4 MB |
