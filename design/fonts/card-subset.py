# Makes the two static fonts the link preview cards are drawn with (crates/card): the site's
# Recursive Mono (recursive.woff2, beside this script) at weights 400 and 600, cut to the
# characters a card can show, with the slashed zero the site's `slashed-zero` selects as the
# plain zero. Needs fontTools 4.68 and brotli. Run from the repository root:
#
#   python3 design/fonts/card-subset.py
#
# Then run `cargo test -p card`: a test checks that every string a card can show, every pool
# name included, has its glyphs. A pool name with a character outside the set below fails it.
from pathlib import Path

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "design/fonts/recursive.woff2"
OUT = ROOT / "crates/card/fonts"

# Printable ASCII (the cards' words, hex ids, numbers and every pool name), the ellipsis of a
# shortened id, the en dash of a missing figure, and the narrow no-break space digits group with.
UNICODES = [*range(0x20, 0x7F), 0x2013, 0x2026, 0x202F]


def slashed_zero(font: TTFont) -> str:
    """The glyph the `zero` feature puts in place of the digit zero."""
    gsub = font["GSUB"].table
    for record in gsub.FeatureList.FeatureRecord:
        if record.FeatureTag != "zero":
            continue
        for index in record.Feature.LookupListIndex:
            for table in gsub.LookupList.Lookup[index].SubTable:
                if "zero" in getattr(table, "mapping", {}):
                    return table.mapping["zero"]
    raise SystemExit("no slashed zero")


for weight in (400, 600):
    font = TTFont(SOURCE)
    zero = slashed_zero(font)
    font = instancer.instantiateVariableFont(font, {"wght": weight})
    for table in font["cmap"].tables:
        if table.isUnicode() and 0x30 in table.cmap:
            table.cmap[0x30] = zero
    options = Options()
    options.layout_features = []
    options.hinting = False
    options.notdef_outline = True
    options.glyph_names = False
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
    options.drop_tables += ["GSUB", "GPOS", "GDEF", "gasp", "prep", "STAT", "DSIG"]
    subsetter = Subsetter(options)
    subsetter.populate(unicodes=UNICODES)
    subsetter.subset(font)
    # Read from WOFF2, written as a plain TrueType file, which the server reads directly.
    font.flavor = None
    path = OUT / f"recursive-mono-{weight}.ttf"
    font.save(path)
    print(path.relative_to(ROOT), path.stat().st_size, "bytes")
