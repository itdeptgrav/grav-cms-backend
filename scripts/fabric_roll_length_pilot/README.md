# Fabric roll length vision pilot

This is a research CLI for testing whether individual wrap boundaries are
recoverable from a controlled photograph of a fabric-roll end face. It does
not provide a production measurement or a sub-1% accuracy claim.

The algorithm maps an operator-supplied outer ellipse into polar coordinates,
excludes obstructed angular sectors, aggregates radial edge evidence and draws
candidate nested layer boundaries. If two image points with a known physical
separation are supplied, it also reports a candidate perimeter sum in metres.

## Setup

```sh
python3 -m venv .venv
.venv/bin/pip install -r scripts/fabric_roll_length_pilot/requirements.txt
```

## Supplied JPEG example

The following coordinates are provisional visual annotations for the supplied
900 x 1600 JPEG. The scale points approximate the tape's 2 cm and 20 cm marks;
they must be reviewed before treating even the scale as evidence.

```sh
.venv/bin/python scripts/fabric_roll_length_pilot/analyze_roll.py \
  /path/to/roll.jpg \
  --output-dir /tmp/fabric-roll-result \
  --center 500,835 \
  --outer-radii 395,365 \
  --inner-fraction 0.04 \
  --scale-points 407,1112,548,452 \
  --scale-distance-mm 180 \
  --exclude-degrees 85:125,255:295
```

Review `candidate-layers.jpg`, `polar-unwrapped.jpg`,
`radial-gradient.png`, `radial-profile.png` and `result.json`. A plausible
number in `candidateLengthM` is not proof of accuracy. Validation requires the
same rolls to be independently measured using a calibrated length counter.

## Simpler diameter method

Use `estimate_from_diameter.py` when a roll-family effective packed pitch is
available. Without that calibration it outputs geometry and deliberately leaves
metres empty.

```sh
.venv/bin/python scripts/fabric_roll_length_pilot/estimate_from_diameter.py \
  /path/to/roll.jpg \
  --output-dir /tmp/fabric-roll-diameter \
  --center 500,835 \
  --outer-radii 395,365 \
  --core-radii 10,14 \
  --scale-points 407,1112,548,452 \
  --scale-distance-mm 180 \
  --fabric-width-cm 147 \
  --effective-pitch-mm 1.2
```

The sample pitch above is illustrative only and must not be used as a default.
