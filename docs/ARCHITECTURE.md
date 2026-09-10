# Architecture

Why the engine is shaped the way it is. Each section states a decision, what it
buys, and what it costs.

## The simulation is a pure state machine

`src/core` has no reference to Three.js, the DOM, or anything in `src/render`.
It advances a world by a fixed timestep, driven only by a command queue and a
seeded random stream.

That constraint is what makes everything else possible:

- **Replays** are the seed plus the command stream. Nothing else.
- **Lockstep networking** becomes viable: peers exchange a few dozen bytes of
  commands per tick instead of synchronising thousands of positions.
- **Tests** run headless, at thousands of ticks per second, with no browser.
- **The renderer is disposable.** Every view object is derived from sim state
  each frame, so it can be destroyed and rebuilt at any time.

The cost is discipline. Input cannot call `issueOrder` directly, view code
cannot nudge a position, and nothing in the simulation may call `Math.random`
or read the wall clock.

## Fixed timestep, interpolated rendering

The simulation runs at 60 Hz. The renderer runs at display rate and interpolates
between the previous and current tick using the leftover time in the
accumulator.

Variable timestep would make collision resolution, cooldowns, attack windups and
path following all behave differently at different frame rates. A player on a
144 Hz monitor would get a measurably different game. It also makes determinism
impossible, since floating-point results depend on the exact `dt` sequence.

The accumulator is clamped to five catch-up ticks per frame. Past that the
simulation runs slower than wall-clock, which is survivable; the alternative is
a death spiral where each slow frame schedules more work than the next frame can
absorb.

## Tick order

Within a tick the rule is: decide, then move, then resolve, then react.

1. Drain commands into orders
2. Snapshot positions for interpolation
3. Cooldowns and statuses
4. Rebuild the spatial index
5. AI brains, then orders
6. Casts
7. Locomotion
8. Rebuild the index, then separate bodies and push them out of terrain
9. Attacks, projectiles, delayed effects
10. Regeneration, damage reactions, deaths, fog

Timers run before decisions so an ability that came off cooldown is usable this
tick. Casts advance after orders so a cast started this tick winds up from this
tick. Combat resolves after movement so a unit that walked out of range really
is out of range.

## Entities are objects, not parallel arrays

Units are pooled objects with a generation-tagged integer handle. A
struct-of-arrays layout would be faster, but a MOBA-scale fight is a few hundred
bodies — three orders of magnitude below where cache layout starts to dominate —
and the benchmark puts a 180-unit tick at about 0.4 ms. Readable entities are
worth more than headroom nobody is using.

The generation counter is not optional. Abilities hold target handles across
many ticks, and without generations a projectile in flight would resolve
against whichever unit later reused that slot.

Only the broadphase keeps its own typed-array mirror, because that is the one
loop where locality actually shows up.

## Terrain is a grid with a clearance field

Everything about where things can be lives in one `NavGrid`: per-cell flags for
movement blocking, vision blocking and brush, plus a clearance field giving the
approximate distance from each cell to the nearest blocker.

The clearance field is what stops A* from returning routes a body physically
cannot follow. Without it a 0.65-radius champion is happily pathed through a
one-cell gap and then grinds against the corner forever.

The renderer builds wall geometry from the same bits the simulation collides
against, so the visible map and the collision map cannot disagree.

### Line of sight and the corner-squeeze trap

A straight-line reachability test is used in two places: the pathfinder's fast
path, and string pulling. Both originally tested only the clearance field along
the centre line, and both were wrong in the same way.

Where two blocked cells touch at a corner, the passage between them is exactly
zero units wide — but the clearance field, which measures distance to the
nearest blocked cell *centre*, still reads half a cell. A centre-only test walks
a unit straight through solid rock, and string pulling would happily
re-introduce a diagonal move that A* had explicitly refused.

`lineClear` therefore samples three points per step: the centre and both edges
of the swept capsule, offset perpendicular by the body radius. That puts the two
pinching cells directly under the test. `maxTravel`, which validates dashes,
does the same. There is a test for it.

## Collision is positional, not impulse-based

Overlapping bodies are pushed apart and their velocities are left alone.

This single choice is most of what makes a MOBA feel like a MOBA. Units squeeze
past each other and slide along a wall of bodies. An impulse solver would make a
minion wave behave like a pile of marbles.

A few properties are load-bearing:

- **Soft correction.** Only 70% of the overlap is resolved per iteration, so
  pressure spreads through a crowd over a few ticks instead of exploding it.
- **A slop distance.** A small overlap is tolerated without correction, which
  stops touching units from trading sub-millimetre pushes forever.
- **Deterministic tie-breaks.** Exactly co-located bodies separate along a
  direction derived from their entity ids, never from a random jitter.
- **Terrain wins.** Separation can shove a unit into a wall, so terrain
  correction runs last. A body clipped inside geometry is far worse than one
  slightly overlapping a neighbour.

Iteration count was measured, not guessed. `npm run bench` reports worst-case
residual overlap against CPU cost; going from three to four iterations halves
the overlap for about a tenth of a millisecond, and past four the curve flattens.

## Abilities are data plus hooks

An ability declares its targeting mode, range, radius, cost, cooldown, cast
time and indicator shape. Only the effect itself is code.

That split is why the HUD can draw a correct range indicator for a spell it has
never heard of, and why adding a champion means adding content rather than
editing systems. Validation is separated from commitment so the indicator can
predict exactly what the cast will do, including range clamping.

Casting is a state machine rather than an immediate call, because the windup is
where a MOBA's counterplay lives. A spell that resolves on the same tick the key
is pressed cannot be interrupted, cannot be dodged on reaction, and gives the
renderer nothing to telegraph. Cost and cooldown are committed at the *start* of
the windup: getting stunned mid-cast loses you the spell.

## AI only issues orders

Bots go through the same order layer players do. A bot that moved units directly
would quietly diverge from player behaviour, and every pathing or collision bug
would then exist in two variants.

## Events are drained, not subscribed to

When something worth seeing happens, the simulation pushes an event. The view
drains the queue once per frame. A subscriber list would let view code run in
the middle of a tick and mutate state mid-solve.

The same seam lets systems react to each other without knowing each other
exists: AI aggro is driven by scanning this tick's damage events, so the damage
pipeline needs no reference to the AI.

## Rendering reads, never writes

Views are reconciled against the world's unit list each frame. Positions come
from interpolating the last two ticks. Animation is derived from simulation
state — gait phase advances with distance travelled, so a slowed unit takes
shorter steps rather than moon-walking, and attack poses are driven by the real
windup timer.

Fog of war is a single-channel texture sampled by every terrain material rather
than a black quad composited on top. That means fog darkens actual surfaces,
including the sides of walls, for the cost of one texture read. The mask is
blurred before upload; the raw state is three discrete levels on a coarse grid,
and unblurred it upscales into hard-edged wedges wherever a bush casts a vision
shadow.

## Not everything is a Unit

The original entity model had exactly one kind of thing in it: a Unit, with
health, orders and an ability bar. That is enough to build a battle and not
enough to build a world. A tree is not a unit. Neither is a tavern, a barrel, or
a sword lying on the ground.

A **prop** is deliberately much smaller: a transform, an asset to draw, and a
few flags. Two of the flags carry real weight.

`Blocks` stamps the navigation grid, which is where runtime terrain editing
comes from. Props do not own terrain; the store keeps a pristine copy of the
map's own flags and recomputes `base | props` whenever a blocking prop moves.
Rebuilding from a clean base rather than un-stamping is what makes editing
reversible: un-stamping cannot know whether a cell was blocked by the map, by
this prop, or by an overlapping one, and gets it wrong the first time two props
touch. There is a test that asserts the grid comes back byte-for-byte.

`Pickup` makes a prop collectable. Its item is resolved from the asset
manifest rather than a separate table, so dropping a sword on the ground in the
editor and having it work in play needs no extra authoring step.

## Item stats are derived, not authored

There are forty weapons in the generated pack and there will be more. Writing a
stat line for each by hand is a table that goes stale the moment the pack is
regenerated.

Instead an item's numbers come from what the engine already knows about the
mesh: its category, its tags, and its size in the manifest. A greatsword hits
harder and swings slower than a dagger because it is physically larger, not
because someone typed that in. New weapons get sensible stats for free, and the
balance curve lives in one place where it can be tuned as a curve.

This only works because there is a **stat-modifier layer** underneath. Statuses
could already move movement speed and attack speed, but only because those two
were special-cased in stat recomputation; anything else had nowhere to live. A
modifier is a named, grouped change to one stat, with flat additions applied
before multipliers so the result never depends on the order sources happen to
sit in the array.

## Props are instanced

One InstancedMesh per asset, not one Mesh per prop. A dressed map is hundreds of
trees, rocks and barrels; drawn individually that is hundreds of draw calls
before a single unit is rendered, and it is the first thing that falls over when
a designer actually fills a map. Instancing collapses every copy of an asset
into one call regardless of how many are placed.

Geometry loads lazily. A prop referencing an asset that is not resident yet is
skipped for that frame and its asset is queued, so placing something never
blocks the frame on a fetch.

## The editor runs on top of the game, not instead of it

Everything the editor does goes through the same stores the game uses at
runtime. Toggling it tears nothing down: the simulation keeps running
underneath, which is why a prop placed in the editor immediately blocks
pathfinding, and a weapon dropped on the ground can be walked over the moment
you switch back.

Scenes serialize to a few kilobytes because terrain is **not** stored. It is
regenerated from the map seed, and props are re-stamped on load. That keeps a
scene file diffable, and means an improvement to the terrain generator improves
every existing scene instead of orphaning it.

Undo is a stack of closure pairs rather than a general command system. It is far
less machinery and covers everything an editor of this size needs.

## Characters stay procedural

The asset pipeline produces static meshes. Single-view reconstruction returns a
surface with no skeleton, so anything that has to walk cannot come from it, and
reconstruction is also much worse at humanoids than at rocks and buildings.

Animated characters are therefore still assembled from primitives and posed by
rotating named joints, with three body plans: biped, quadruped and floating.
Body plan does most of the work of making a roster look varied; a robe and hood
read as a caster, a horizontal spine reads as a beast.

The payoff for keeping the rig as plain scene-graph nodes shows up in equipment.
A generated weapon mesh, which has never been rigged, is parented to the same
joint the procedural weapon hung from, and it inherits the entire attack
animation for free because the arm it is attached to is what moves.

## Known limits

- **Float determinism is same-binary only.** Two browsers on different CPUs may
  disagree in the last bits. Cross-platform lockstep needs fixed-point maths in
  the sim's hot paths. The architecture is ready for that swap; the maths layer
  is not yet abstracted over it.
- **Pathfinding is flat A*.** Fine at 90,000 cells and about 500 expansions for
  a cross-map route, but a much larger map wants hierarchical pathfinding or
  flow fields for crowds sharing a destination.
- **Draw calls still scale with unit count.** Props are instanced, characters
  are not: each one is roughly ten meshes, so 180 units is about 1,300 calls.
  The fix is the same technique, applied per archetype, and it is harder because
  every unit is posed differently.
- **No spatial partition for rendering.** The whole map is submitted every
  frame and relies on frustum culling. Instanced prop batches disable culling
  entirely, because per-instance culling is not available and the batch spans
  the map.
- **Generated meshes are untextured.** Hunyuan3D's texture stage is a separate
  model that is not installed, so the pack is shaded by category from a palette.
  It suits the flat-shaded look and would not survive a change of art direction.
- **Champions and abilities are still code.** Everything else that content
  touches is data. This is the last place where adding content means editing
  TypeScript, and the honest way to find out whether the boundary holds is to
  add a second and third champion and see what breaks.
