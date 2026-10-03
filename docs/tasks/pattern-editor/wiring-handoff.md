# 2D pattern editor — what still has to be wired

**Lane B · 3 Oct 2026.** Frontend commit `62a3c8aa`, `components/rnd/pattern-editor/**`
plus the isolated route `/preview/pattern-editor`.

The editor is **built, tested and deliberately not connected**. It opens a
pattern revision, edits it, validates it, produces a save payload and asks for a
3D preview — all through the existing `rnd_pattern_revisions` contract, with no
second pattern model and no new collection. What it does not do is call the
server or sit inside the shared R&D workspace, because the 3D lane has eight
files open under `components/rnd/fit/` and a shared workspace page is one file
two lanes would both be editing.

This is the list of what connecting it means. Nothing here is hard; all of it is
somebody's decision.

---

## W-1 · The save call — the only thing between this and a usable feature

`buildSave(doc, { name, changeNote, author })` already returns a payload shaped
exactly like a `patternRevision` document:

```
{ state: "draft",
  name,
  origin: { kind: "edit", parentRevisionRef },
  sourceDxf,                 // carried forward unchanged
  patternSet,                // millimetres, unitInMm: 1
  edits: [{ kind: "outline", … }],
  simulationInputs: { pieces: [{ pieceRef, grainVector, runs }], seams: [...] },
  provenance: { sourceRevisionRef, sourceRevisionNumber, sourceState,
                editedBy, editedAt, changeNote, sourceUnit, savedUnit } }
```

The editor takes an `onSave` prop and uses whatever ref it returns. Wiring it is
one call to the existing create-revision endpoint. **The server must mint the
`revisionRef` and `revisionNumber`** — the editor does not invent either, and
the preview route's local `PR-LOCAL-…` is a harness stand-in.

**What the server has to enforce rather than trust the client for:**

- the parent revision is not written to, whatever the payload says;
- `origin.parentRevisionRef` names a revision in the same style;
- a save against an `approved` or `submitted` parent creates a child and does
  not change the parent's state.

`revision.js` refuses all three client-side. That is a convenience, not the gate.

---

## W-2 · Three fields the stored schema has no home for

Listed by `buildSave().notCarried` at save time, so a person is told rather than
finding out later. Each is real editor state with nowhere to go on
`rnd_pattern_revisions`:

| What | Why it matters | What would hold it |
|---|---|---|
| **Edge classes** — sew / finished / fold / internal, per boundary segment | What a cut list and a seam check both read. The single biggest reason to add a field | `patternSet.pieces[].edges: [{ fromPointIndex, class }]` |
| **Saved measurements** with POM codes and notes | The numbers a tech pack is checked against. `GarmentModel` has a measurement schema; the pattern revision does not | `patternRevision.measurements: [measurementSchema]` |
| **Per-edge seam allowance** | `seamAllowance` carries one figure plus `uniform`. A 40 mm hem on a 10 mm garment is ordinary and cannot be expressed | `patternSet.pieces[].seamAllowance.perEdge: [{ fromPointIndex, value }]` |

Until these exist the editor keeps them in the session and says, on save, that
they will not survive it. **It does not write them into a field that means
something else.**

---

## W-3 · Into the shared R&D workspace, once Lane A is done

The editor is a single component:

```jsx
<PatternEditor
  revision={revision}            // an rnd_pattern_revisions document
  author={{ name, id }}
  onSave={async (payload) => revisionRef}
  onRequestPreview={({ patternRevisionRef }) => …}
/>
```

It renders into `position: absolute; inset: 0`, owns its own panels and its own
layout memory (`grav.rnd.pattern-editor.layout.v1`), and imports nothing from
`components/rnd/fit/**` or `components/rnd/workspace3d/**`. Two things to settle
when it moves:

- **Where it sits.** A tab beside Pattern & Fit is the obvious place. It should
  not share the 3D workspace's panel layout — the two have different regions and
  one stored layout for both would restore a workspace missing a panel.
- **`onRequestPreview` is the join.** It receives `{ patternRevisionRef }` and
  nothing else, and the 3D lane decides what to do with it. If the drape runner
  ever needs more than a ref, that is a conversation, not a prop.

---

## W-4 · The DXF fixture the preview route reads

`/preview/pattern-editor` imports `components/rnd/fit/cloTshirt.patternSet.json`
— Lane A's directory, read-only and never written. It is the archive's genuine
five-piece CLO export and the only real pattern in the tree.

Once the editor loads revisions from the server this import goes away. Until
then it is a cross-lane read worth knowing about: if Lane A moves or renames that
file, the preview route breaks and the editor does not.

---

## W-5 · What the MVP does not pretend to do

Said plainly, because each of these is the kind of gap that gets assumed away:

- **A seam pairing is one segment to one segment.** Clicking an edge pairs that
  edge. A real shoulder seam spans several segments and an armhole is one sleeve
  cap sewn to two or three body runs in order — which is exactly what
  `boundaryRunSchema` was built to express. Extending a run across adjacent
  segments is the next piece of work, and until it exists the ease figure on a
  multi-segment seam will look absurd because it is comparing one short segment
  with one long one. The arithmetic is right; the selection is too coarse.
- **There is no automatic drafting.** No block generation, no grading, no
  "make me a sleeve". The editor edits what is there and draws what somebody
  draws.
- **No grading.** The stored schema carries `grading`; the editor neither reads
  nor writes it, and a graded nest opened here would show its base size only.
- **The DXF export is R12 geometry.** It keeps piece names, points, the
  corner/curve split, grainlines, notches, internal lines and the allowance line,
  and it cannot carry an edge class or a seam pairing — `exportBundle().dxfLost`
  enumerates what was dropped, and the neutral JSON export loses nothing.

---

## Running it now

```
/preview/pattern-editor            the imported revision, approved, as evidence
/preview/pattern-editor?state=draft the same pattern as an editable draft
```

Tests: `node --test --import ./test-support/register.mjs "components/rnd/pattern-editor/*.test.mjs"`
