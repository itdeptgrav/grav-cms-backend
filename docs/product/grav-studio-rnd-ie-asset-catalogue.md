# GRAV Studio Asset Catalogue for R&D and IE

**Status:** Storage foundation implemented on 16 October 2026. It deliberately
does not implement approval, a public gallery, a browser 3D viewer, or IE
writes.

## Purpose

GRAV Studio's editable design information must be preserved centrally so that
R&D, IE, and future CMS screens can find the exact current source and its
supporting files. The CMS must not rely on a designer's local PC for any
factory-relevant asset.

This is a storage and provenance boundary. Review/approval comes later.

## Storage rule

| Data type | Authoritative store | CMS database stores |
|---|---|---|
| Any binary asset — design, document, audio or video | Grav Storage project `GRAV-3D-Studio` | opaque `fileId`, filename, MIME type, byte size, checksum, purpose. This includes `.grav`, future `.glb`, PNG/SVG/PDF/DXF, WAV/MP3 and video. |
| Structured JSON and technical facts | MongoDB / Compass, embedded in the relevant `SampleStyle` record | submitted Studio manifest, construction/stitch data, measurements, piece summaries, revision metadata and file references |
| R&D technical facts | `SampleStyle.techSheet.technical` and its frozen technical revision | existing structured fields and revision snapshot |
| Studio design linkage and asset catalogue | `SampleStyle` R&D aggregate | design identity, state, asset references, timestamps and creator |
| IE manufacturing standard | `IeStyleFile`, bulletin versions, method studies and releases | existing IE records |

Neither Studio nor a browser receives the Grav Storage server key. Studio sends
to the CMS; the CMS validates the request and forwards the assets to storage.
The CMS database never holds the bytes of a design, drawing, audio or video
file; it holds the searchable, auditable JSON catalogue that points to the
private object.

## Catalogue

| Asset / fact | Current source | Current state | Required central location |
|---|---|---|---|
| Editable garment project | Studio `.grav` | Studio can send it; CMS receiver is absent | Grav Storage, asset purpose `STUDIO_PROJECT` |
| Pattern geometry, seams, material settings and project metadata | inside `.grav` `project.json` | preserved by the project file | `STUDIO_PROJECT`; selected searchable summary in CMS |
| Construction sheet | Studio manifest and `.grav` techpack data | Studio can send seam/stitch details | structured CMS submission plus `STUDIO_PROJECT` |
| Renders: front, back, left, right, three-quarter | Studio-generated PNG | Studio can send them | Grav Storage, purpose `RENDER_<VIEW>` |
| Flat drawings | Studio-generated SVG and PNG | Studio can send front/back files | Grav Storage, purpose `FLAT_<VIEW>_<FORMAT>` |
| Pattern pieces | `.grav` project | Studio manifest currently sends names only | project archive now; later structured piece summary (name, area, grainline, fold, cut quantity, material) |
| Buttons, buttonholes and trims | Studio project data | not included in the current send manifest | project archive now; add structured Studio export before IE consumes it |
| Browser-interactive garment model | no current Studio garment export | not available | later `GARMENT_GLB` asset; do not claim it exists today |
| R&D technical document / tech pack source file | `SampleStyle.techSheet.file` | existing URL record | existing file path today; migrate/reference as `TECHNICAL_DOCUMENT` only under a separate storage decision |
| Measurements, materials, consumption and R&D technical requirements | `SampleStyle.techSheet.technical` | existing structured data and immutable revision snapshots | MongoDB R&D aggregate; not duplicated into Studio assets |
| IE operation bulletin, SAM and machine/skill requirements | IE records | existing governed IE boundary | existing IE collections; Studio construction is evidence, never IE command data |
| IE line layout, capacity and release | IE records | existing governed IE boundary | existing IE collections |

## Required links

Every central Studio design submission must name:

```text
companyId
sampleStyleId
studioDesignId
submissionNumber
projectFileId
asset fileIds by purpose
Studio app version
submittedBy / submittedAt
source R&D technical revision, when one exists
SHA-256 for each uploaded object
```

`SampleStyle` is the R&D identity. A `WorkOrder` may be linked later but must
not be used as the only identity: IE Development supports styles before an
order exists and historical work orders are not reliably style-linked.

## What the CMS should be able to answer

For every stored Studio design, CMS must answer without opening a designer's
computer:

1. Which R&D style does this project belong to?
2. Which `.grav` file is the editable source?
3. Which renders and flats represent that source?
4. Which Studio release generated it and when?
5. Which construction/stitch facts came with it?
6. Which R&D technical revision was current when it was stored?
7. Which IE engineering file later consumed an approved technical source?

## Link an editable project to an R&D style

The relationship is deliberate and style-scoped, not inferred from a filename:

1. A Sales manager assigns a Studio designer to a `SampleStyle` through
   `PATCH /api/cms/crm/sample-styles/:id/studio-assignment`. An R&D designer may
   assign only their own authenticated email.
2. That assignment makes the style visible to that designer in Studio's
   **File → Link to CMS Sample** flow.
3. Studio writes the resulting CMS sample ID into the `.grav` project's `cms`
   metadata. The local project remains editable and is still only a draft.
4. **Send for Review** uploads a new immutable submission to that exact style.

The Studio bearer key can only list its assigned styles and append a new
submission. It cannot assign itself to a different style, alter an old
submission, or receive the Grav Storage key.

## Known gaps to close before claiming complete coverage

1. Current Studio sends project, five renders, flats and construction; it does
   not yet send a standalone garment GLB. The editable `.grav` remains the
   authoritative source, including its embedded avatar and drape data.
2. The existing CMS measurement source must be mapped to the Studio sample
   payload using a real or sanitised style before Studio can reliably open all
   measurement details.
3. The CMS browser UI still needs the R&D style-assignment, linked-revision and
   asset-viewer screens. It must use the assignment and revision APIs; it must
   not write Grav Storage directly.
4. Storage and metadata must be introduced without creating an unplanned Mongo
   collection while the Atlas collection-limit issue remains unresolved.

## Implemented ingestion slice

The initial ingestion and catalogue foundation now:

- receive Studio's existing multipart submission;
- validate its designer/style scope;
- forward each validated object to Grav Storage (the initial endpoint has
  explicit per-file and total-request bounds);
- persist bounded R&D-owned asset metadata and `fileId` references;
- return a successful upload response to Studio;
- add authenticated CMS retrieval/proxy endpoints.

The receiver also reserves a generic attachment lane for a future Studio
exporter to send GLB, DXF, PDF, WAV/MP3 or video. Those files follow the same
rule: private object bytes in Grav Storage, typed JSON metadata and file
references in MongoDB.

It adds `POST /api/studio/v1/samples/:id/versions`, plus Studio's existing
`/me`, `/samples` and `/open` compatibility endpoints. The route requires a
separate `GRAV_STUDIO_API_KEY`, a configured designer email, and a matching
`SampleStyle.studio.designer.email`; an unassigned style is invisible. The
Grav Storage key is accepted only by the backend process.

Before a workstation is connected, configure the separate Studio key and
designer identity in the deployment environment and assign the intended R&D
styles. This slice creates no public gallery, no browser 3D viewer, no IE
writer, no approval decision, and no change to the existing R&D or IE technical
authority.
