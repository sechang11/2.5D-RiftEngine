# What it takes to build the whole game

An honest breakdown of everything a League-like MOBA needs, what this engine
already does, and what order the rest should come in.

Legend: **done** · **partial** · **missing**

---

## 0. What makes it an engine rather than one game

Worth separating from the feature list, because these are the changes that pay
off across every game of this shape rather than in one of them. The test for
whether something belongs here is simple: does adding content require editing
code?

Four of these are now built, and they were the necessary ones.

| Change | State | Why it generalises |
| --- | --- | --- |
| **Content as data, not code** | partial | Props, scenes and items are data. Champions and abilities are still TypeScript, which is the remaining half of this. |
| **An asset registry** | done | Meshes are catalogued, loaded on demand and shared. Nothing in the engine names a specific model. |
| **A generic placed object** | done | Not everything is a Unit. A tree, a tavern and a dropped sword are props: a transform, an asset, and flags. |
| **Scene serialization** | done | Maps save and load as a few kilobytes of JSON. Terrain regenerates from a seed rather than being stored. |
| **A stat-modifier layer** | done | One mechanism that items, runes, auras and passives all express themselves in, instead of special cases in stat recomputation. |
| **Runtime terrain edits** | done | Props stamp the nav grid from a pristine base, so placing a wall closes a lane and deleting it reopens one. |
| **Instanced rendering** | done | Draw calls scale with asset *types*, not object count, which is what makes a dressed map affordable. |
| **An editor** | done | The difference between a system only its author can add to and one anyone can. |
| Data-driven champions and abilities | missing | The last place where new content means new code. |
| Skeletal animation from glTF | missing | Would let authored or rigged characters replace the procedural ones. |
| A trigger and scripting layer | missing | Doors, capture points, quest volumes. Needed for game modes that are not a straight fight. |

**Was it necessary?** The four marked done at the top were, in the strict sense
that the editor could not exist without them. An editor that places objects
needs a thing to place that is not a unit, a registry to find its mesh, a file
format to save the result, and terrain that can change while the game runs.

The rest is not necessary and is worth doing anyway. Instanced rendering was the
known scaling limit and cost an afternoon. Data-driven champions is the one
remaining place where the abstraction leaks, and the honest way to find out
whether the boundary holds is to add a second and third champion and see what
breaks.

---

## 1. The simulation core

This is the layer everything else sits on, and it is the part that is hardest
to retrofit. It is largely finished.

| Piece | State | Notes |
| --- | --- | --- |
| Fixed-timestep loop with interpolation | done | 60 Hz, accumulator, catch-up clamp |
| Command-driven input | done | The seam that replays and networking need |
| Seeded RNG with save and restore | done | No `Math.random` anywhere in the sim |
| Entity storage with safe handles | done | Generation-tagged, O(1) removal |
| Spatial broadphase | done | Uniform grid, rebuilt per tick |
| Event bus | done | Drained per frame, never subscribed to |
| Determinism test | done | Same seed and script produce identical state |
| Fixed-point maths | missing | Needed for cross-platform lockstep |
| Snapshot and rollback | missing | Needed for client-side prediction |

**Next:** nothing urgent. Fixed-point only matters once networking is real.

## 2. Movement, collision, terrain

| Piece | State | Notes |
| --- | --- | --- |
| Nav grid with movement and vision flags | done | 300×300 at one unit per cell |
| Clearance field | done | Keeps wide bodies out of narrow gaps |
| A* with corner-cut prevention | done | ~500 expansions for a cross-map route |
| Partial paths to unreachable goals | done | Clicking a wall walks you to the wall |
| String pulling | done | Capsule-aware, no diagonal squeezes |
| Circle-vs-circle separation | done | Positional solver, measured tuning |
| Terrain push-out | done | Clearance-gradient escape |
| Dashes and blinks | done | Clipped against terrain, ghosted through bodies |
| Stuck detection and repathing | done | Progress-based, throttled |
| Knockbacks and displacements | missing | Same machinery as dashes, applied by a source |
| Hierarchical pathfinding | missing | Only needed for much larger maps |
| Flow fields for crowds | missing | Worth it when many units share a destination |
| Terrain that changes at runtime | done | Props re-stamp the nav grid from a pristine base |

**Next:** knockbacks. The dash machinery already moves a unit along a validated
path against terrain; a knockback is the same thing with the direction supplied
by an attacker instead of by the unit's own order.

Runtime terrain editing landed with the prop system, but only the navigation
side is incremental: the wall mesh is not rebuilt, so a prop that blocks
movement is drawn as its own model rather than as terrain. That is correct for a
crate and wrong for a spell that raises a wall of stone.

## 3. Combat

| Piece | State | Notes |
| --- | --- | --- |
| Auto-attacks with windup and travel time | done | Melee resolves instantly, ranged fires a missile |
| Damage pipeline | done | Resistances, then amplification, then shields, then health |
| Physical, magic and true damage | done | |
| Critical strikes | done | Seeded roll |
| Shields | done | Consumed in application order |
| Statuses | done | Slow, haste, stun, root, silence, shield, burn, regeneration |
| Tenacity | done | Applied to crowd control only |
| Death and respawn | done | Champions leave a corpse, everything else despawns |
| Lifesteal, spell vamp, on-hit effects | missing | The damage pipeline has the hook; nothing uses it |
| Attack cancelling and orb-walking | partial | Windups cancel on new orders; no dedicated support |
| Damage attribution and assists | missing | Needs a recent-damage ledger per unit |
| Healing reduction, resistance shred | partial | The modifier layer now exists; no content uses it yet |

**Next:** on-hit effects. The stat-modifier layer now exists and items use it,
but the damage pipeline still has no hook a modifier can attach behaviour to, so
lifesteal and shred have nowhere to live. One callback list on the damage path
covers all of them.

## 4. Abilities and champions

| Piece | State | Notes |
| --- | --- | --- |
| Four targeting modes | done | Self, unit, point, direction |
| Cast state machine | done | Windup, recovery, interrupt |
| Range clamping | done | Casting past max range casts at max range |
| Targeting indicators | done | Range circle, area, line, cone |
| Projectiles | done | Swept collision, piercing, homing |
| Delayed ground effects | done | With a growing telegraph |
| One full six-slot kit | done | Q W E R plus two summoner spells |
| Ability ranks and levelling | partial | Rank is stored but nothing scales with it |
| Channelled abilities | partial | The phase exists; nothing uses it |
| Toggles and stances | missing | |
| Passives and triggered effects | missing | Needs an event-hook table on units |
| Pets and controllable minions | missing | Needs multi-unit selection and control |
| A roster of champions | partial | Two dozen procedural archetypes; one has a full ability kit |

**Next:** rank scaling and a passive-hook table. Between them they cover most
of what a real kit needs, and every champion after that is content rather than
engine work.

## 5. Map and game mode

| Piece | State | Notes |
| --- | --- | --- |
| Large map with lanes, jungle, river, brush | done | Generated, reproducible, guaranteed connected |
| Towers | partial | They target and shoot; no aggro rules or protection |
| Lane minion waves | done | Route-following, engage on contact |
| Jungle camps with leashing | done | Retaliate when struck, return home |
| Fog of war | done | Per team, brush blocks sight, enemies fade out |
| Wards and vision items | missing | The unit flag exists; no placement ability |
| Inhibitors, nexus, win condition | missing | The game currently never ends |
| Shops, gold, items | partial | Items, modifiers and walk-over pickups work; no gold or shop |
| Experience and levels | missing | |
| Objectives with timers | missing | Dragon, herald, and the like |
| Recall | missing | A channel with an interrupt; the machinery exists |
| Map editor | done | Palette, place, move, undo, save and load |

**Next:** gold, experience and a shop. It is the shortest path from "sandbox"
to "a match you can win", and it forces the modifier layer from section 3 to
exist.

## 6. Networking

Nothing here is built. This is the largest remaining piece and the one most
shaped by decisions already made.

The architecture is deliberately ready for **deterministic lockstep**, which is
what League itself uses: clients exchange only commands, each simulates the
same tick, and the server arbitrates. It is cheap on bandwidth, naturally
cheat-resistant about state, and gives replays for free.

What it needs:

1. **Fixed-point maths** in the simulation's hot paths. Float results differ
   across CPU architectures and compiler settings; lockstep cannot tolerate
   that. This means a `Fixed` type replacing `number` in `core/math` and every
   position, velocity and timer.
2. **A tick-synchronised transport.** Commands are stamped with the tick they
   execute on, buffered a couple of ticks ahead, and applied identically
   everywhere.
3. **Input delay or rollback.** Lockstep with a fixed delay is simple and is
   what MOBAs ship. Rollback needs snapshot and restore for the entire world.
4. **Desync detection.** A per-tick state hash compared between peers, so a
   divergence is caught in seconds rather than discovered as a bug report.
5. **A server that simulates.** Authoritative simulation is also what fog of war
   requires: a client must never receive positions it cannot see, or the map
   hack writes itself.

The alternative, **server-authoritative with client prediction**, tolerates
float drift and does not need fixed-point, but costs far more bandwidth and
means writing reconciliation for every mispredicted action.

**Next:** the state hash and a local two-instance harness. Proving two
simulations in the same process stay identical over a long match is the cheap
version of the hard problem, and it can be built today.

## 7. Presentation

| Piece | State | Notes |
| --- | --- | --- |
| Fixed-pitch camera with pan, zoom, lock | done | |
| Procedural terrain, walls, brush | done | Built from the nav grid |
| Procedural animated characters | done | Assembled from primitives |
| Ability indicators and click feedback | done | |
| Health bars, cast bars, floating text | done | 2D overlay canvas |
| HUD with cooldown sweeps | done | |
| Minimap with fog and camera rect | done | |
| Imported models and animation | partial | glTF props load and instance; characters are still procedural and unrigged |
| Particle systems | partial | Pooled impact rings only |
| Sound | missing | Nothing at all |
| Death and respawn cinematics | missing | |
| Scoreboard, shop UI, chat | missing | |

**Next:** sound. It is entirely absent and it is the single largest gap between
this and something that feels like a game.

---

## If you want the shortest route to a playable match

1. Gold, experience and levels
2. A stat-modifier layer, then a small item shop
3. Ability ranks and a passive-hook table
4. Nexus, inhibitors and a win condition
5. Sound
6. A second and third champion, to prove the content pipeline
7. Then networking

Steps one to four turn the sandbox into a game with an ending. Step six is the
real test of whether the engine boundary holds: if adding a champion needs
changes under `src/core`, the abstraction is wrong and it is much cheaper to
learn that before there are twenty of them.
