# R&D avatar — OxiHuman, measured by us, pinned, and kept out of the solver

**Decided 3 Oct 2026.** Extends `docs/decisions/rnd-fit-simulation.md` for the
body side of Pattern & Fit. Lane boundary: this lane owns avatar generation,
measurement verification, persistence, rendering and the collision-body
contract; Lane A owns placement, sewing, the solver and drape gates.

## The engine, and why it is built rather than downloaded

OxiHuman (Apache-2.0, COOLJAPAN OU) **v0.2.1** is the release with the OHPK
core pack and the measurement fit. It is published only as source: the GitHub
release has no assets and npm stops at 0.2.0. So the engine is compiled from
the crates.io release (`oxihuman-wasm-0.2.1.crate`, sha256 `4ab25900…`) with its
own published `Cargo.lock`, on Rust 1.97.0 (stable on the release date) and
wasm-bindgen 0.2.126, with path prefixes remapped so the binary is
reproducible. `grav-cms/scripts/oxihuman/build-wasm.sh` rebuilds it byte for
byte; two independent builds produced the same hash.

| Artefact | sha256 |
|---|---|
| `public/vendor/oxihuman/0.2.1/oxihuman_wasm_bg.wasm` | `5213bfc5…ba31` |
| `public/vendor/oxihuman/0.2.1/oxihuman-core-v1.ohpk` | `09c4bb1f…f6f7` (tag commit `603b4468`) |
| `components/rnd/avatar/oxihuman/vendor/oxihuman_wasm.js` | `7c9f2b6d…241e` (one line patched, see header) |

Nothing is fetched at runtime from anywhere but this application. The Apache
LICENSE, the NOTICE (which records the CC0 MakeHuman 1.3.0 data provenance)
and the pack's provenance JSON ship beside the binaries and are linked from the
Avatar panel. The server pins the same engine and pack hashes
(`services/rnd/avatarContract.js`) and refuses records from anything else.

## The engine is a forward model; GRAV's tape is the judge

OxiHuman's own `fit_to_measurements` is not used. It searches gender as a free
variable (a requested male came back gender 0.66) and grades itself with its own
measurer, which substitutes `0.55 × height` when a chest slice fails. In the
audit its self-report gave a 62.1 cm waist for a body whose waist section is
290 × 219 mm (ellipse perimeter 803 mm).

So the browser fits OxiHuman's parameters (height by bisection; weight, muscle
and the three `measure/` girth modifiers by damped Gauss–Newton) against
`components/rnd/avatar/meshMeasure.js` — horizontal sections of the welded skin,
torso isolated by topology, girth as convex-hull perimeter, ISO 8559-1 landmark
bands. Every "Generated" number is that tape on the final mesh. Tolerance is
fixed: Pass ≤ 5 mm, Review ≤ 10 mm, Fail beyond; "Fit verified" only when all
four pass. Shoulder width, armhole, bicep, arm length and inseam are not
claimed.

## What OxiHuman 0.2.1 cannot do, found by measurement

1. **No stature below the base mesh.** The height control only lengthens:
   about 1627 mm feminine, 1666 mm masculine is the floor. Requests below the
   floor are refused before fitting, with a pointer to the capsule body.
2. **No typical male body.** The 2 MB core pack dropped the male ethnic base
   targets and the male "average" muscle/weight corners to fit its byte budget.
   Gender 0 is the androgynous base mesh plus the eight extreme male corners: a
   broader, flatter body that still carries a bust and feminine pelvis. Its four
   girths verify; its shape is not a typical male. A fuller pack can be built
   with OxiHuman's own `pack-core --tier full` from the CC0 MakeHuman targets —
   that is a decision for the product owner, because it is no longer the
   official released pack.
3. **The mesh build is incremental** (scatter-add of changed targets), so the
   same parameters after a different history differ in the low bits. Every fit
   and every final build runs on its own fresh engine session (≈30 ms), which
   makes generation deterministic — verified identical across Node and Chrome.

The presets sit inside this envelope and all ten verify (worst |Δ| 1.2 mm).

## Poses

OxiHuman 0.2.1 has no skeleton. Arms are rotated about a shoulder joint found
from the arm's own sections, in the frontal plane, with diffused skin weights
over the shoulder cap. **A-pose = 45° from vertical; standing = 14.04°**, the
capsule body's own standing arm. Both are also reported in the capsule body's
`abductionDeg` convention (30.96° and 0°).

> **Collision with Lane A, reported, not changed:** `bodyCollision.js` measures
> `abductionDeg` from its 14.04° standing arm, so its "45°" A-pose puts the arm
> at 59° from vertical, while its comment calls it "halfway between arms down
> and a T-pose" (45°). The avatar uses 45° from vertical and states both
> numbers. Lane A should decide which its A-pose means.

## The collision body

Not the render mesh. A capsule body in exactly the shape
`bodyFromMeasurements` returns (`kind`, `pose`, `abductionDeg`, `arms`,
`landmarks`, `capsules`, `measurements`), placed from the avatar's landmarks
and rig, radii by the capsule body's own girth/2π convention, `estimated: true`,
`source: "oxihuman-avatar"`, with `measurementBasis` naming which numbers are
verified and which derived. Render and collision are posed by the same
rotation; the arm-to-capsule gap is identical in both poses (median 1.8–3.9 mm
over the ten presets) and generation fails loudly if it drifts.
`components/rnd/avatar/laneAdapter.js#avatarBodyFactory` answers `bodyAt(any
abductionDeg)` from a saved record for Lane A's pose transition. **Lane A has not
wired it in, and no drape has been verified on an OxiHuman body.**

## Persistence — no new collection

Avatar revisions are an append-only, `select: false` embedded array
`rndAvatars` on `SampleStyle` (schema `models/CMS_Models/RnD/AvatarRevision.js`,
every field immutable, written by a conditional `$push`). Not on the pattern
revision, because an approved pattern revision is never written to. The render
mesh is not stored: the record carries the pinned engine, pack, parameters and
geometry hashes, and reopening regenerates and refuses on any mismatch.
`simulationInputs.avatar.avatarRef {avatarId, revision, contentSha256, …}` is
validated against the style's library by `setSimulationInputs`, and RenderJobs
freeze it with the rest of the inputs.
