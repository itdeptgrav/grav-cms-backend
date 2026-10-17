# Decision: Fabric Roll Length Measurement Boundary

## Status

Experimental — 14 October 2026

## Decision

The first implementation is an isolated offline CLI. It may propose visible
wrap boundaries and a candidate length but may not write Store inventory,
advertise metrological accuracy or silently infer missing physical scale.

The operational MVP prioritises outer/core diameter or segmented area combined
with a dynamically estimated packed pitch from the same roll. The vision path
must estimate local radial layer spacing across multiple unobstructed sectors
and radial bands; a fixed roll-family pitch may be used only as a fallback prior,
never as the dynamic result. Direct wrap tracing remains a research cross-check
because the first real image did not expose consistent complete boundaries.
Neither method becomes a truth source until it passes held-out physical
validation.

## Consequences

- Manual centre, boundary and scale annotations are acceptable in the pilot.
- Obstructed sectors such as the measuring tape are excluded explicitly.
- The candidate length is research evidence only.
- Integration requires held-out comparison with a calibrated physical length
  counter and an agreed rejection policy for low-quality images.
