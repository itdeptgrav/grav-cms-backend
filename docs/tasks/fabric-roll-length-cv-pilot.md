# Fabric Roll Length CV Pilot

## Active scope

1. Run a deterministic polar-unwrapping diagnostic on the supplied front-facing
   roll image.
2. Calibrate pixels from two reviewed tape marks.
3. Exclude tape-obstructed sectors.
4. Generate candidate layers, radial evidence and a research-only JSON result.
5. Visually review false and missed boundaries.
6. Refine capture and detection parameters before collecting physical truth.
7. Evaluate the simpler diameter/area estimator using an independently metered
   calibration roll from the same material and winding process.
8. Replace fixed-pitch estimation with a roll-specific local-pitch estimator:
   polar unwrap, estimate dominant radial spacing in multiple sectors and radial
   bands, reject inconsistent sectors, then integrate area divided by local
   pitch. Retain the calibrated roll-family value only as a comparison baseline.

## Out of scope

- Store/CMS routes or database writes.
- Automatic inventory adjustment.
- A production model or `<1%` accuracy statement.
- Training on the evaluation rolls.

Data collection follows
`docs/research/fabric-roll-cv-data-collection.md`, including physical-roll split
boundaries and calibrated remaining-length truth.

## Acceptance for this task

- CLI fails closed without required geometry.
- Metres remain null without physical scale.
- Diagnostic artifacts allow a reviewer to inspect every candidate ring.
- Unit tests cover scale, angular exclusion, peak spacing and perimeter math.

## Second capture evidence — IMG_1103.DNG

The cleaner front-facing image supports a provisional outer ellipse of about
193.6 × 186.6 mm and core ellipse of about 38.5 × 43.1 mm, producing a fabric
cross-sectional area of about 27,065 mm². The supplied fabric width is 147 cm;
it is retained as metadata but correctly does not enter the diameter/pitch
formula. The tape is beside the roll and appears tilted relative to its end
plane, so these dimensions remain provisional until a co-planar scale capture
or direct calliper measurement confirms them.

The owner reports this roll is approximately 147 m. That figure is a post-run
sanity check only and is not used to calibrate the dynamic estimator.

## Dynamic full-resolution result

The 8064 x 6048 DNG was polar-unwrapped and analysed without a supplied length.
The visible texture was not sufficiently periodic or consistent to resolve
individual wraps. A representative run found a median 115 candidate boundaries
per angular sector, a 16.5-boundary interquartile spread, and diagnostic sector
lengths from 29.6 m to 45.8 m. Other reasonable parameter settings changed the
candidate count materially. The detector therefore returned
`research_inconclusive` and withheld the metre estimate.

This is a useful negative result: the current image resolves broad folds and
pile texture, but not a stable roll-specific packed pitch across the face. The
software must not convert those macro-bands into a claimed length.
