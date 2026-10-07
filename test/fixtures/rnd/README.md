# R&D pattern fixtures

## `clo-tshirt-aama.dxf` — a genuine CLO export, not a hand-written stub

67 KB, and every byte of it came out of CLO. Its own header says so:

```
AUTHOR: CLO Virtual Fashion Inc.
PRODUCT: CLO Standalone OnlineAuth 7.1.178
VERSION: 3
SAMPLE SIZE: M
UNITS: ENGLISH
```

It is in the repository on purpose, and the purpose is that a hand-written
fixture cannot test this parser. A fixture one writes contains exactly the
conventions one already knows about, so it proves the parser agrees with its
author rather than with CLO. Three defects in this feature were found only
because this file is real:

1. **`$EXTMAX` is a placeholder.** The header claims extents of `1000,1000`
   while the geometry lives between X −35…17 and Y 41…79. A viewer that framed
   on the header would draw the pattern in the corner of an empty sheet.
2. **Internal construction lines overshoot their piece by exactly 20.0 mm.**
   CLO extends them past the edge so a cutter can see where they run. A check
   for "artwork outside its piece" written against a tidy fixture reported three
   of the five pieces.
3. **Trim meshes are named `BindedTrim_57204`.** The `\b` in a regex matching
   trim names never fires, because `_` is a word character — so nineteen trim
   meshes were offered as candidate matches for a front bodice.

### What it contains

| | |
|---|---|
| Pieces | 5 blocks — two bodices, two identical sleeves (a mirror pair), one neck rib |
| Sizes | M only. **Not graded** |
| Layers | 1 boundary, 2 turn points, 3 curve points, 7 grainline, 8 internal lines |
| Unit | inches, from AAMA's own `UNITS: ENGLISH` — `$INSUNITS` is absent |

### What it deliberately does NOT contain

Notches (layer 4), grade points (layer 5), mirror lines (layer 6), drill holes
(layer 13) and a sew line (layer 14) are all absent. That is what makes it the
right fixture for the rule that matters most in this feature: **absent is
reported as absent**, never as zero, false or a plausible default. A pattern
with no sew line has an *unpublished* seam allowance, not a zero one.

Piece names are `Pattern_636968` and similar — identifiers CLO counted out,
not names a patternmaker chose. So this file is also the live case for
name-based 2D→3D mapping being impossible, and for "needs mapping" rather
than a guess.
