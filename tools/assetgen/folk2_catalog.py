"""
People, second pass: the crowd rather than the cast.

The first character pass made forty-seven named figures — a king, an archmage,
a paladin — which is the right thing to make first and the wrong thing to fill a
market square with. A crowd is mostly nobody in particular, and it reads as a
crowd because the postures differ, not because the faces do.

So this pass is townsfolk doing things, deliberately varied in silhouette:
carrying, kneeling, leaning, seated, hooded, laden. Poses are stated plainly
because reconstruction depends on them far more than on any adjective, and a
figure with a load on its shoulder is a different outline from a figure with its
arms at its sides even when it is the same person.

  python3 folk2_catalog.py > catalog_folk2.json
"""

import json

import folk_catalog as base

STYLE = base.STYLE
M = base.M
A = []


def spec(aid, category, name, prompt, height=None, faces=None, material=None, tags=()):
    dh, df = base.DEFAULTS[category]
    entry = {
        "id": "%s_%s" % (category, aid),
        "name": name,
        "category": category,
        "tags": list(tags),
        "height": height if height is not None else dh,
        "faces": faces if faces is not None else df,
        "upright": "longest" if category == "folk" else "none",
        "prompt": prompt + ", " + STYLE,
        "material": material or M("leather"),
    }
    A.append(entry)
    return entry


PEASANT = M("canvas_stripe", "leather", 0.7, 0.18)
CLOTH = M("robe_cloth", "leather", 0.7, 0.14)
LEATHER = M("leather", "wood_plank", 0.6, 0.14)
MAIL = M("chainmail", "steel", 0.55, 0.07)
HIDE = M("fur_brown", "leather", 0.7, 0.12)
SKIN = M("skin_human", "canvas_stripe", 0.8, 0.12)

TOWNSFOLK = [
    ("porter", "Porter", 2.4, PEASANT,
     "a labourer carrying a heavy sack over one shoulder, bent slightly under the weight"),
    ("watercarrier", "Water Carrier", 2.3, PEASANT,
     "a woman carrying a yoke across her shoulders with a wooden pail hanging at each end"),
    ("basket_woman", "Basket Seller", 2.3, PEASANT,
     "a woman with a wide flat basket of vegetables balanced on her head, one hand steadying it"),
    ("crier", "Town Crier", 2.4, CLOTH,
     "a town crier with one arm raised holding a bell, the other holding an unrolled scroll"),
    ("drunk", "Drunkard", 2.2, PEASANT,
     "a dishevelled man leaning heavily against nothing, a tankard hanging from one hand"),
    ("beggar_seated", "Seated Beggar", 1.3, PEASANT,
     "a ragged beggar sitting cross-legged on the ground with a bowl in his lap"),
    ("kneeling_pilgrim", "Pilgrim", 1.6, CLOTH,
     "a hooded pilgrim kneeling with head bowed and a staff laid across the knees"),
    ("child_running", "Street Child", 1.4, PEASANT,
     "a barefoot child in a loose smock running with arms out"),
    ("child_standing", "Urchin", 1.5, PEASANT,
     "a thin child in a patched tunic standing with hands behind the back"),
    ("old_woman", "Old Woman", 2.1, CLOTH,
     "a bent old woman leaning on a walking stick, a shawl over her head"),
    ("old_man", "Elder", 2.2, CLOTH,
     "a white-bearded old man in a long coat leaning on a staff"),
    ("scribe", "Scribe", 2.3, CLOTH,
     "a scribe standing with an open ledger held in one arm and a quill in the other hand"),
    ("fishwife", "Fishwife", 2.3, PEASANT,
     "a stout woman in an apron holding a large fish by the tail in one hand"),
    ("carpenter", "Carpenter", 2.4, PEASANT,
     "a carpenter carrying a long plank balanced on one shoulder, a saw at his belt"),
    ("mason", "Mason", 2.4, PEASANT,
     "a stonemason with a mallet and chisel, a leather apron, dust on his arms"),
    ("cooper", "Cooper", 2.4, PEASANT,
     "a barrel maker rolling a barrel on its edge with both hands"),
    ("shepherd", "Shepherd", 2.4, HIDE,
     "a shepherd in a hooded cloak with a long crook, a dog at his heel"),
    ("hunter", "Hunter", 2.5, LEATHER,
     "a hunter in furs with a brace of hares hanging from his belt and a short bow"),
    ("miller", "Miller", 2.4, PEASANT,
     "a broad miller white with flour carrying a sack under one arm"),
    ("cook", "Cook", 2.3, PEASANT,
     "a cook in a stained apron holding a big ladle and a covered pot"),
    ("maid", "Serving Maid", 2.3, PEASANT,
     "a serving maid carrying a tray of tankards on one raised hand"),
    ("noble_seated", "Seated Lady", 1.7, CLOTH,
     "a finely dressed lady sitting upright on a stool, hands folded in her lap"),
    ("squire", "Squire", 2.2, LEATHER,
     "a young squire carrying a helm under one arm and a shield on the other"),
    ("standard_bearer", "Standard Bearer", 2.6, MAIL,
     "an armoured soldier holding a tall banner pole upright with both hands"),
    ("guard_leaning", "Off-Duty Guard", 2.5, MAIL,
     "a guard leaning back with a spear propped under one arm, helmet under the other"),
    ("watchman_lantern", "Night Watchman", 2.5, MAIL,
     "a watchman holding a lantern out at arm's length, a cudgel at his hip"),
    ("gravedigger", "Gravedigger", 2.4, PEASANT,
     "a gaunt gravedigger leaning on a long spade, a wide hat shading his face"),
    ("plague_doctor", "Plague Doctor", 2.5, CLOTH,
     "a figure in a long waxed coat and a beaked bird mask holding a cane"),
    ("jester", "Jester", 2.2, CLOTH,
     "a jester in a belled parti-coloured motley caught mid-caper, one leg raised"),
    ("dancer", "Dancer", 2.3, CLOTH,
     "a dancer in a flowing skirt with both arms raised and one foot turned out"),
    ("musician", "Piper", 2.3, CLOTH,
     "a musician playing a shawm, cheeks puffed, elbows out"),
    ("smith_apprentice", "Apprentice", 2.1, PEASANT,
     "a young apprentice working a pair of bellows with both hands"),
    ("nun", "Sister", 2.3, CLOTH,
     "a nun in a full habit and wimple with hands clasped in front"),
    ("bathhouse_woman", "Bather", 2.2, SKIN,
     "a woman wrapped in a linen sheet, hair bound up, holding a comb"),
]
for aid, name, h, mtl, prompt in TOWNSFOLK:
    spec(aid, "folk", name, prompt, height=h, material=mtl, faces=6500)

BEASTS = [
    ("dog_street", "Street Dog", 0.9, HIDE, "a lean scruffy street dog standing alert on all fours"),
    ("cat", "Cat", 0.5, HIDE, "a sitting tabby cat with its tail curled round its feet"),
    ("rat_giant", "Giant Rat", 0.7, HIDE, "a large mangy rat on all fours, nose down"),
    ("goose", "Goose", 0.9, HIDE, "a white goose standing with its neck stretched out"),
    ("horse_cart", "Draft Horse", 2.3, HIDE,
     "a heavy draft horse in a leather collar and harness standing four square"),
    ("donkey", "Donkey", 1.6, HIDE, "a small grey donkey standing with its head low"),
    ("sheep", "Sheep", 1.1, HIDE, "a woolly sheep standing on all fours, head down grazing"),
    ("ox", "Ox", 1.9, HIDE, "a heavy yoked ox standing side on"),
    ("raven", "Raven", 0.6, HIDE, "a black raven perched with wings folded"),
    ("falcon", "Falcon", 0.7, HIDE, "a hooded hunting falcon perched on a block"),
]
for aid, name, h, mtl, prompt in BEASTS:
    spec(aid, "creature", name, prompt, height=h, material=mtl, faces=5000)


if __name__ == "__main__":
    print(json.dumps(A, indent=1))
