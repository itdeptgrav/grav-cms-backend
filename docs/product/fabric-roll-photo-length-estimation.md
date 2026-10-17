# Fabric Roll Photo Length Estimation

## Product objective

Evaluate whether a controlled end-face photograph can produce a useful
remaining-length estimate for soft fabric rolls without opening them. The
system must not represent a computer-vision estimate as a sub-1% measurement
unless that performance is demonstrated on independently measured held-out
rolls.

## Measurement boundary

Outer diameter or area alone is insufficient when effective layer pitch varies.
The pilot therefore investigates direct visible-wrap tracing: unwrap the end
face into polar coordinates, find layer boundaries across multiple unobstructed
angular sectors and sum candidate layer perimeters.

Computer vision cannot recover boundaries that are hidden, merged or visually
indistinguishable. The result must retain the source image, operator geometry,
physical scale, excluded sectors, candidate overlay and confidence evidence.

## Pilot output

- Candidate wrap count and radii.
- Candidate perimeter sum in metres only when physical scale is supplied.
- Annotated source image, polar image, radial gradient and aggregate profile.
- Explicit warnings and `accuracyClaimed: false`.
- No inventory mutation or production API integration.

## Validation gate

Production consideration requires a representative dataset with independently
metered truth, capture controls, frozen parameters and held-out evaluation.
Report median, 95th percentile and maximum absolute percentage error, plus the
percentage of rolls at or above 1% error. Until that gate passes, results remain
research-only.
