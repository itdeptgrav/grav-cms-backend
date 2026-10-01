# CENTRAL COSTING — LANE A: MATERIAL CONSUMPTION AND ALLOWANCE (8 Sep 2026)

## The source contract, closed at both ends

`MATERIAL_CONSUMPTION` was reported as sourced from R&D's technical record. It
was sourced from the Merchandiser's shortlist.

`technicalSource.engineeredRow` read the approved technical revision, carried
`consumptionPerPiece` and R&D's explicit `allowancePercent`, and was returned as
`facts.engineered` — which `technicalPreview.mergeMaterial` never looked at. It
paired `planned` and `measured` only. So the modern record was complete,
approved, and unread.

**With the merge fixed, the material family's operational contract is closed:**
R&D states what one piece consumes and what the process adds, and the costing
calculates from both.

| Fact | Record | Owner | Consumed by costing |
|---|---|---|---|
| `consumptionPerPiece` | approved technical revision | R&D | yes — the base |
| `allowancePercent` | approved technical revision | R&D | yes — applied, unless already included |
| legacy `sample.consumptionRawItems[].quantity` | the sample round | R&D | yes — as the effective amount, never multiplied again |
| the Merchandiser's pick | `materials.rawItems[]` | Merchandising | which material only; its quantity is a fallback |

## Evidence precedence

`RND_ENGINEERED` → `SAMPLE_MEASURED` (approved sample) → `BOM_PLANNED`.

The first is new only in the sense that it is now reachable; the ranking was
already argued in `engineeredRow`'s own documentation. All three stay visible on
the preview row so a reader can see what the alternatives said.

## Readiness

The allowance is **optional and explicit**, by R&D's own validation
(`technicalRecord.materialGaps`): a null blocks nothing and means "R&D has not
said". A missing allowance therefore does not block material readiness, and no
Costing-side default was invented. An explicit `0` stays distinguishable from a
blank in the frozen provenance for ever.

Base consumption is a different matter and is unchanged: absent or non-positive
still blocks, owned by R&D.

## What this changes for Store

Nothing about who decides — Store still owns quotation selection — but the
quantity every decision is judged at is now the effective one. A sourcing
decision recorded against 700 metres reopens when the allowance moves it to 735
and that crosses a minimum or a tier boundary, because the same assembly
revalidates it.

## Still open in this lane

`duty` remains the one family with no authoritative record. "Does not apply"
remains the last decision taken inside Costing, and relocating it to the
department that owns each family is the next Lane A task.
