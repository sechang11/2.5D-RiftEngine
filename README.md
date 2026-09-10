# Rift Engine

A 2.5D game engine: 3D meshes moving on a flat 2D simulation plane, with
circular unit collision, grid pathfinding, fog of war and MOBA controls. The
simulation is deterministic and fixed-step; the renderer is a passive reader of
it.

Built to be the foundation for games rather than to be one game. `src/core`
knows nothing about rendering, `src/render` never writes simulation state, and
`src/game` is content that plugs into both.

![Highhold from above: cobbled streets between blocks of tile-roofed houses,
the market square full of stalls, the citadel gate and its towers behind, and
the cathedral to the right](docs/screenshot-city.jpg)

![Mid lane at the river crossing: two minion squads, the ultimate's target
circle over the enemy group, and fog falling away at the edge of
vision](docs/screenshot.jpg)

## Running it

```bash
npm install
npm run dev
```

Then open the URL Vite prints.

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Typecheck, then production bundle |
| `npm test` | Determinism, navigation and combat tests |
| `npm run bench` | Headless simulation benchmark |
| `npm start` | Serve a production build on `PORT` |

## Controls

**Playing**

| Input | Action |
| --- | --- |
| Right click | Move, or attack the unit under the cursor |
| `Q` `W` `E` `R` | Abilities. Tap to cast at the cursor, hold to aim first |
| `D` `F` | Flash and Ignite |
| `A` then click | Attack-move |
| `S` / `H` | Stop / hold position |
| Arrow keys, screen edge | Scroll the map |
| `Space` | Centre on your champion (hold to follow) |
| `Y` | Toggle camera lock |
| Mouse wheel | Zoom, from five units to two hundred and ten |
| Walk over an item | Pick it up and equip it |
| `F2` | Open the editor |

**Editing**

| Input | Action |
| --- | --- |
| Click a palette entry | Take it as a brush |
| Left click on ground | Place it |
| Left click on an object | Select it; drag to move |
| Mouse wheel | Rotate the selection, or scale it with `Shift` |
| `[` `]` | Rotate in twelfth-turn steps |
| `Delete` | Remove the selection |
| `Ctrl+D` | Duplicate |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo |
| `G` | Cycle grid snap |
| `F` | Frame the selection |
| `Escape` | Drop the brush, then clear the selection |
| Arrows, screen edge | Scroll the map |
| `Ctrl` + wheel | Zoom |

Sandbox keys while playing: `B` spawns a minion wave, `V` toggles fog of war,
`G` the grid, `O` the path overlay, `T` swaps team vision, `P` pauses, `[` and
`]` change time scale, `` ` `` refreshes cooldowns.

`window.engine` exposes the running game from the browser console.
`engine.dress(1.5)` re-scatters the map at higher density.
`engine.capture('docs/screenshot.jpg')` writes the current view to disk, which
is how the image above was made; that endpoint is dev-server only.

## Three worlds, one engine

`?mode=` picks which one boots.

| Mode | What it is |
| --- | --- |
| `/` | The MOBA sandbox on Hollow Reach |
| `/?mode=city` | Highhold: a walled castle city, its town and the country round it |
| `/?mode=museum` | Every asset in the pack laid out as galleries you walk through |

The museum is not a debug view. It is a second game built from the same map,
scenario and content layers, with the same camera and the same controls. That
matters for reviewing art: a mesh that reads well in an asset browser can be a
smear from the game's fixed camera height, and only the game's own camera tells
you which. Each exhibit is captioned with its name, its size in world units and
its triangle count, and your champion stands among them for scale.

Highhold is the other direction: the same pieces, assembled. A curtain wall
repeated round a two-hundred-unit circuit with a tower every twenty-four units,
a citadel walled off again inside it, a market square where the two avenues
cross, a river with three bridges and two water gates, a wharf, a temple
precinct, ten districts of housing, and farms, a graveyard and a camp outside
the walls. Roughly six hundred and fifty pieces, and a few hundred townsfolk
standing in them.

Nothing in it is a model of a city. Each district is subdivided into plots by
binary partition, cutting a street at every split, and each plot takes whichever
piece fills it best in either orientation. Plots nothing fits become yards.
Buildings are stamped into the nav grid as rectangles when the city is planned
rather than left to blocking props, because a circle around a terrace either
leaves its corners walkable or eats two metres of street on each side.

![The market square at street level: striped awnings over trestle stalls, the
stone market cross, townsfolk and a dog on the cobbles](docs/screenshot-crowd.jpg)

![The buildings gallery: a portal arch, a stone keep, a tavern, a granary and a
dragon statue on open ground, each captioned with its name, world size and
triangle count, with the visitor among them for
scale](docs/screenshot-museum.jpg)

## What is in the box

**Simulation.** Fixed 60 Hz tick with an accumulator and render interpolation.
All input arrives as commands through a single queue, so the same seed and the
same command stream reproduce the same game exactly. There is a test for it.

**Navigation.** A 300×300 nav grid with per-cell movement and vision flags plus
a clearance field, so a wide body is never routed through a gap it cannot enter.
A* with corner-cut prevention, partial paths towards unreachable goals, and
string pulling that collapses the grid staircase into a few straight runs.
Placed objects re-stamp the grid, so walling off a lane in the editor closes it
for pathfinding immediately.

**Physics.** Circular bodies in a uniform-grid broadphase, separated by a
positional solver. Deliberately not an impulse solver: units slide past each
other and press through a crowd instead of bouncing.

**Combat.** Auto-attacks with real windups and travel time, an ability system
with four targeting modes, projectiles resolved by swept collision, delayed
ground effects with telegraphs, a damage pipeline with resistances and shields,
and statuses covering slows, stuns, roots, silences, shields and burns.

**Items.** A stat-modifier layer that items, runes and auras all express
themselves in. Weapons and trinkets lying on the map are picked up by walking
over them, and an equipped weapon's mesh is attached to the character's hand,
where it inherits the whole attack animation.

**Characters.** Two kinds. The ones that move are procedural, built from
primitives and posed by rotating named joints, with three body plans: bipeds,
quadrupeds and floating. The ones that stand still are generated meshes — a
hundred and fifty townsfolk, soldiers, monsters and animals at seven thousand
triangles each — because a crowd reads as a crowd from the number of people in
it long before any of them move, and two hundred static figures cost an
instanced draw call each while two hundred simulated ones cost a pathfinder.

**Assets.** A generated mesh pack of castle, town and country pieces, weapons,
creatures and people, drawn with one instanced draw call per asset type. See
[docs/ASSET-PIPELINE.md](docs/ASSET-PIPELINE.md).

**Materials.** Generated meshes have no UVs, so the texture is projected rather
than mapped: each fragment samples a tiling surface down all three object-space
axes and blends by facing. Walls get one material and up-facing surfaces get
another, which is what puts slate on a roof and ashlar on the wall beneath it
without the mesh knowing what a roof is. Tiling makes resolution nearly free —
512 pixels per world unit — so the camera zooms from a whole district down to a
mortar joint. See [docs/MATERIALS.md](docs/MATERIALS.md).

![The curtain wall at full zoom: individual ashlar blocks with mortar joints, an
arched recess, the round tower's curve, and gravel
underfoot](docs/screenshot-stone.jpg)

**Editor.** Press `F2`. A searchable palette of every asset and unit archetype,
click to place, drag to move, undo and redo, per-object flags for movement and
vision blocking, and save, load, export and import of scenes. The game keeps
running underneath while you edit.

**Vision.** Per-team fog of war on its own grid, with brush that blocks sight
without blocking movement.

## Layout

```
src/core/     the engine — no DOM, no rendering, no game content
  math/       vectors, seeded RNG, intersection tests
  ecs/        entity storage and spatial queries
  nav/        nav grid, clearance field, A*, string pulling
  physics/    broadphase and the separation solver
  sim/        tick pipeline, orders, locomotion, projectiles, lifecycle
  combat/     stats, modifiers, damage, auto-attacks
  abilities/  ability definitions and the cast state machine
  status/     buffs, debuffs, crowd control
  vision/     fog of war
  world/      placed props and runtime terrain edits
  ai/         minion and monster brains
src/render/   Three.js: terrain, characters, props, camera, effects, overlay
src/editor/   the map editor and its panel
src/input/    raw input capture and the player controller
src/ui/       HUD and minimap
src/game/     content: maps, the city, champions, abilities, items, dressing
tests/        determinism, navigation and combat tests
tools/        headless benchmark, asset generation, pack importer
```

Deployed on Railway; see [docs/DEPLOY.md](docs/DEPLOY.md).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for why it is shaped this way,
[docs/ASSET-PIPELINE.md](docs/ASSET-PIPELINE.md) for how the mesh pack is made,
[docs/MATERIALS.md](docs/MATERIALS.md) for how untextured meshes get textured,
and [docs/ROADMAP.md](docs/ROADMAP.md) for what a full MOBA still needs.
