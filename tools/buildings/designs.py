"""
Buildings, as lists of Medieval Village MegaKit pieces.

Metres, y up, and +z out of the front door. The kit's grid is two metres:
floor tiles and wall panels are two wide, and a storey is three tall. A wall
panel's origin is the middle of its bottom edge, on the line between two
cells, with its outside facing +z; a floor tile's is the middle of its cell;
a corner post's is the grid point it stands on. So a wall down the right-hand
side of a house is turned ninety degrees, and one across the back a hundred
and eighty.

Windows, doors and shutters are separate pieces that sit in a panel's opening.
Most share the panel's origin. Doors do not: they hinge, so their origin is
the hinge, and they are hung half an opening to the left of it.
"""

import math

CELL = 2.0
STOREY = 3.0

#: The glazed piece that fills each kind of opening.
GLAZING = {
    "Window_Wide_Round": "Window_Wide_Round1",
    "Window_Wide_Flat": "Window_Wide_Flat1",
    "Window_Thin_Round": "Window_Thin_Round1",
    "Window_Thin_Flat": "Window_Thin_Flat1",
}

#: Half the width of a door leaf, which is where its hinge sits from the middle.
DOOR_HINGE = -0.56


class Plan:
    def __init__(self):
        self.pieces = []

    def put(self, piece, x, y, z, turn=0.0, scale=1.0):
        self.pieces.append({"piece": piece, "at": [x, y, z], "turn": turn, "scale": scale})

    def relative(self, piece, origin, turn, dx, dy, dz, extra_turn=0.0, scale=1.0):
        """Places a piece in another's frame: `dx` along it, `dz` out of its face."""
        a = math.radians(turn)
        x = origin[0] + dx * math.cos(a) + dz * math.sin(a)
        z = origin[2] - dx * math.sin(a) + dz * math.cos(a)
        self.put(piece, x, origin[1] + dy, z, turn + extra_turn, scale)

    def wall(self, panel, x, y, z, turn, shutters=None, door=None):
        """A panel, and whatever its opening needs to be finished."""
        self.put(panel, x, y, z, turn)
        for opening, glazing in GLAZING.items():
            if opening in panel:
                self.put(glazing, x, y, z, turn)
                if shutters:
                    self.put(shutters, x, y, z, turn)
        if "Door" in panel and door:
            frame, leaf = door
            self.put(frame, x, y, z, turn)
            self.relative(leaf, (x, y, z), turn, DOOR_HINGE, 0.0, -0.02)


def ring(plan, width, depth, y, sides, corner, shutters=None, door=None):
    """
    Walls round a `width` by `depth` block of cells centred on the origin.

    `sides` maps front, right, back and left to one panel per cell, read left
    to right as seen standing outside that side.
    """
    hw, hd = width * CELL / 2, depth * CELL / 2
    layout = {
        "front": lambda i: (-hw + CELL * (i + 0.5), hd, 0.0),
        "right": lambda i: (hw, hd - CELL * (i + 0.5), 90.0),
        "back": lambda i: (hw - CELL * (i + 0.5), -hd, 180.0),
        "left": lambda i: (-hw, -hd + CELL * (i + 0.5), -90.0),
    }
    for side, panels in sides.items():
        for i, panel in enumerate(panels):
            x, z, turn = layout[side](i)
            plan.wall(panel, x, y, z, turn, shutters=shutters.get(side) if shutters else None, door=door)
    corners(plan, width, depth, y, corner)


def corners(plan, width, depth, y, piece):
    # Corner pieces reach out along -x and +z at no turn, which is the
    # front-left corner; each of the others is a quarter turn on from it.
    hw, hd = width * CELL / 2, depth * CELL / 2
    for x, z, turn in ((-hw, hd, 0.0), (hw, hd, 90.0), (hw, -hd, 180.0), (-hw, -hd, -90.0)):
        plan.put(piece, x, y, z, turn)


def kerb(plan, width, depth):
    """A dressed-stone kerb round the foot of the walls, a hand high and most of a metre out."""
    hw, hd = width * CELL / 2, depth * CELL / 2
    for i in range(width):
        x = -hw + CELL * (i + 0.5)
        plan.put("Prop_ExteriorBorder_Straight1", x, 0.0, hd, 0.0)
        plan.put("Prop_ExteriorBorder_Straight2", -x, 0.0, -hd, 180.0)
    for j in range(depth):
        z = hd - CELL * (j + 0.5)
        plan.put("Prop_ExteriorBorder_Straight2", hw, 0.0, z, 90.0)
        plan.put("Prop_ExteriorBorder_Straight1", -hw, 0.0, -z, -90.0)
    corners(plan, width, depth, 0.0, "Prop_ExteriorBorder_Corner")


def floor(plan, width, depth, y, tile):
    hw, hd = width * CELL / 2, depth * CELL / 2
    for i in range(width):
        for j in range(depth):
            plan.put(tile, -hw + CELL * (i + 0.5), y, -hd + CELL * (j + 0.5))


def cottage():
    """
    Two storeys on a six-metre square, gable to the lane.

    Rubble stone below with dressed quoins, limewash and timber above, a
    clay-tile roof with a chimney through it. A studded door under a plank
    canopy between two shuttered windows, a stone kerb round the foot of the
    walls, ivy coming down from the upper floor, and the clutter of a yard.
    """
    plan = Plan()
    width, depth = 3, 3
    hw, hd = width * CELL / 2, depth * CELL / 2

    ring(plan, width, depth, 0.0, {
        "front": ["Wall_UnevenBrick_Window_Wide_Round", "Wall_UnevenBrick_Door_Round", "Wall_UnevenBrick_Window_Wide_Round"],
        "right": ["Wall_UnevenBrick_Window_Wide_Flat", "Wall_UnevenBrick_Straight", "Wall_UnevenBrick_Window_Wide_Round"],
        "back": ["Wall_UnevenBrick_Straight", "Wall_UnevenBrick_Window_Wide_Flat", "Wall_UnevenBrick_Straight"],
        "left": ["Wall_UnevenBrick_Straight", "Wall_UnevenBrick_Window_Wide_Round", "Wall_UnevenBrick_Straight"],
    }, "Corner_Exterior_Brick",
        shutters={"front": "WindowShutters_Wide_Round_Open", "left": "WindowShutters_Wide_Round_Closed"},
        door=("DoorFrame_Round_Brick", "Door_2_Round"))
    kerb(plan, width, depth)

    floor(plan, width, depth, STOREY, "Floor_WoodDark")

    # No shutters up here: two open pairs on neighbouring panels meet in the
    # middle, and the kit's pairs are wider than the panel they hang on.
    ring(plan, width, depth, STOREY, {
        "front": ["Wall_Plaster_Window_Wide_Flat2", "Wall_Plaster_WoodGrid", "Wall_Plaster_Window_Wide_Flat2"],
        "right": ["Wall_Plaster_Straight", "Wall_Plaster_Window_Thin_Round", "Wall_Plaster_Straight"],
        "back": ["Wall_Plaster_WoodGrid", "Wall_Plaster_Window_Wide_Flat2", "Wall_Plaster_WoodGrid"],
        "left": ["Wall_Plaster_Window_Thin_Round", "Wall_Plaster_Straight", "Wall_Plaster_Window_Thin_Round"],
    }, "Corner_Exterior_Wood")

    roof_y = STOREY * 2
    plan.put("Roof_RoundTiles_6x6", 0.0, roof_y, 0.0)
    plan.put("Roof_Front_Brick6", 0.0, roof_y, hd, 0.0)
    plan.put("Roof_Front_Brick6", 0.0, roof_y, -hd, 180.0)
    plan.put("Prop_Chimney", 1.9, roof_y + 0.5, -1.2)

    # A plank canopy over the door. The kit's braces are for balconies, and
    # under a canopy this shallow they stuck out through the front of it.
    plan.put("Roof_Wooden_2x1", 0.0, 2.55, hd + 0.1, 0.0)

    # Ivy down the front, off the upper floor's sill.
    plan.put("Prop_Vine1", hw - 0.6, STOREY + 0.15, hd + 0.15, 0.0)
    plan.put("Prop_Vine4", -hw + 0.5, STOREY + 0.2, hd + 0.15, 0.0)

    # The yard.
    plan.put("Prop_Crate", hw + 1.35, 0.0, hd - 0.2, 18.0, 0.8)
    plan.put("Prop_Crate", hw + 1.5, 0.85, hd - 0.15, 40.0, 0.62)
    plan.put("Prop_Crate", hw + 1.2, 0.0, hd - 1.35, -8.0, 0.7)
    plan.put("Prop_Wagon", -hw - 2.4, 0.0, 1.2, -12.0)
    plan.put("Prop_WoodenFence_Single", hw + 2.6, 0.0, -1.2, 90.0)
    plan.put("Prop_WoodenFence_Extension1", hw + 2.6, 0.0, -3.25, 90.0)
    plan.put("Prop_WoodenFence_Extension2", hw + 2.6, 0.0, 0.85, 90.0)
    return plan.pieces


DESIGNS = {"cottage": cottage}
