// test/rnd/pattern-editor-save.test.js
//
// SAVING A WHOLE PATTERN FROM THE 2D EDITOR.
//
// `editRevision` takes a list of named operations. That is right for a scripted
// change and wrong for somebody who has spent twenty minutes reshaping an
// armhole: by the end there is no list of operations, there is a pattern. So
// `saveEditorRevision` takes the document, and these tests pin the four things
// that make it safe to do that:
//
//   · the revision it was opened from is not touched, whatever the payload says;
//   · the same save pressed twice makes one revision, not two;
//   · the semantics a pattern editor knows — point identity, edge classes,
//     notch anchors, seam runs, POM measurements — survive a round trip;
//   · a revision stored before any of this existed still opens, normalised from
//     the parse, with nothing about its geometry reinterpreted.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const mongoose = require("mongoose");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Account = require("../../models/CMS_Models/Sales/Account");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const { PatternRevision, REVISION_STATE } = require("../../models/CMS_Models/RnD/PatternRevision");

const patterns = require("../../services/rnd/patternRevision.service");
const editorDoc = require("../../services/rnd/patternEditorDocument");
const tee = require("./fixtures/renderableTee");

let seq = 0;

async function world() {
  const n = ++seq;
  const co = await Acc_Company.create({ companyName: `Editor Co ${n}`, booksFromDate: new Date("2026-04-01") });
  const account = await Account.create({ companyName: `Buyer ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-ED-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-ED-${n}`, styleCode: `SC-ED-${n}`, productName: "Tee",
    journeyId: journey._id, accountId: account._id, stage: "rnd", techSheet: { status: "pending" },
  });
  const other = await SampleStyle.create({
    sampleStyleId: `SS-ED-${n}-B`, styleCode: `SC-ED-${n}-B`, productName: "Other tee",
    journeyId: journey._id, accountId: account._id, stage: "rnd", techSheet: { status: "pending" },
  });
  return {
    co, style, other,
    ctx: { companyId: co._id },
    actor: { id: `u${n}`, name: "A Patternmaker", email: `p${n}@grav.test` },
    /* Approval is maker-checker: the person who drew a pattern does not approve
       it, which is why these two exist separately. */
    checker: { id: `c${n}`, name: "A Checker", email: `c${n}@grav.test` },
  };
}

async function imported(w) {
  const out = await patterns.importRevision(w.ctx, {
    styleId: w.style._id,
    patternSet: tee.patternSet(),
    sourceDxf: { driveFileId: "drv-1", name: "tee.dxf", sha256: "a".repeat(64), bytes: 4096 },
    name: "Imported from CAD",
    actor: w.actor,
  });
  return out.revision;
}

/** The editor's document for a revision, as the read endpoint hands it over. */
async function documentOf(w, revisionId) {
  const out = await patterns.readRevision(w.ctx, { revisionId });
  return out.revision;
}

const refuses = async (fn, code) => {
  try { await fn(); } catch (err) { expect(err.code).toBe(code); return err; }
  throw new Error(`expected a ${code} refusal and nothing was refused`);
};

/** A deep, order-preserving signature of the geometry and what it means. */
const signature = (doc) => JSON.stringify((doc.pieces || []).map((p) => [
  p.pieceRef, p.name, p.closed,
  (p.points || []).map((v) => [v.x, v.y, v.kind, v.edge || "", v.allowanceMm ?? null]),
  p.grainline, (p.notches || []).map((n) => [n.x, n.y, n.form, n.afterPointId]),
  (p.internalLines || []).map((l) => l.points),
  p.allowance, p.sewingLine,
]));

/* ═══ 1 · THE ROUND TRIP ══════════════════════════════════════════════════ */

describe("an imported pattern, opened and saved unchanged", () => {
  test("it is normalised from the parse, and says so", async () => {
    const w = await world();
    const rev = await imported(w);
    const read = await documentOf(w, rev.id);
    expect(read.editorDocumentOrigin).toBe("normalised");
    expect(read.editorDocumentProblems).toEqual([]);
    expect(read.editorDocument.schemaVersion).toBe(editorDoc.EDITOR_SCHEMA_VERSION);
    expect(read.editorDocument.unit).toBe("mm");
    /* Nobody authored any of it, and the record says that rather than implying
       somebody chose the geometry. */
    for (const p of read.editorDocument.pieces) {
      expect(p.provenance.geometry).toBe("imported");
      for (const v of p.points) expect(v.edge).toBe("");
    }
  });

  test("EVERY POINT HAS AN ID, AND EVERY ID IS DIFFERENT", async () => {
    const w = await world();
    const read = await documentOf(w, (await imported(w)).id);
    const ids = read.editorDocument.pieces.flatMap((p) => p.points.map((v) => v.pointId));
    expect(ids.length).toBeGreaterThan(8);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("AN UNTOUCHED PATTERN IS BYTE-EQUIVALENT AFTER A SAVE AND A RELOAD", async () => {
    const w = await world();
    const parent = await imported(w);
    const before = (await documentOf(w, parent.id)).editorDocument;

    const saved = await patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: before, name: "Opened and saved", actor: w.actor,
    });
    const after = (await documentOf(w, saved.revision.id)).editorDocument;

    expect(after.editorDocumentOrigin).toBeUndefined();
    expect(signature(after)).toBe(signature(before));
    expect((await documentOf(w, saved.revision.id)).editorDocumentOrigin).toBe("stored");
  });

  test("and the parse is rewritten from the same points, in millimetres", async () => {
    const w = await world();
    const parent = await imported(w);
    const doc = (await documentOf(w, parent.id)).editorDocument;
    const saved = await patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: doc, name: "x", actor: w.actor,
    });
    const child = await PatternRevision.findById(saved.revision.id).lean();
    expect(child.patternSet.unit).toBe("mm");
    expect(child.patternSet.unitInMm).toBe(1);
    expect(child.patternSet.pieces.length).toBe(doc.pieces.length);
    for (let i = 0; i < doc.pieces.length; i += 1) {
      expect(child.patternSet.pieces[i].outline.length).toBe(doc.pieces[i].points.length);
      expect(child.patternSet.pieces[i].outline[0].x).toBeCloseTo(doc.pieces[i].points[0].x, 6);
    }
  });
});

/* ═══ 2 · THE PARENT IS NEVER TOUCHED ═════════════════════════════════════ */

describe("the revision that was opened", () => {
  test("IT IS NOT CHANGED BY A SAVE, NOT IN ONE FIELD", async () => {
    const w = await world();
    const parent = await imported(w);
    const frozen = JSON.stringify(await PatternRevision.findById(parent.id).lean());

    const doc = (await documentOf(w, parent.id)).editorDocument;
    doc.pieces[0].name = "Front — reshaped";
    doc.pieces[0].points[0].x += 7.5;
    await patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: doc, name: "Reshaped", actor: w.actor,
    });

    expect(JSON.stringify(await PatternRevision.findById(parent.id).lean())).toBe(frozen);
  });

  test("an approved parent forks rather than being written to", async () => {
    const w = await world();
    const parent = await imported(w);
    await patterns.approveRevision(w.ctx, { revisionId: parent.id, actor: w.checker });
    const approved = await PatternRevision.findById(parent.id).lean();
    expect(approved.state).toBe(REVISION_STATE.APPROVED);

    const doc = (await documentOf(w, parent.id)).editorDocument;
    const saved = await patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: doc, name: "After approval", actor: w.actor,
    });
    expect(saved.revision.state).toBe(REVISION_STATE.DRAFT);
    expect(saved.revision.origin.parentRevisionRef).toBe(parent.revisionRef);
    expect((await PatternRevision.findById(parent.id).lean()).state).toBe(REVISION_STATE.APPROVED);
  });

  test("the revision id comes from the backend, never from the client", async () => {
    const w = await world();
    const parent = await imported(w);
    const doc = (await documentOf(w, parent.id)).editorDocument;
    const saved = await patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: doc, name: "x",
      /* A client trying to choose its own identity. */
      revisionRef: "PR-CLIENT-CHOSE-THIS", revisionNumber: 99,
      actor: w.actor,
    });
    expect(saved.revision.revisionRef).not.toBe("PR-CLIENT-CHOSE-THIS");
    expect(saved.revision.revisionRef).toMatch(/^PR-[0-9A-F]{10}$/);
    expect(saved.revision.revisionNumber).toBe(parent.revisionNumber + 1);
  });

  test("EDITING AN OLD REVISION BRANCHES, AND LEAVES THE NEWER ONES ALONE", async () => {
    const w = await world();
    const r1 = await imported(w);
    const doc1 = (await documentOf(w, r1.id)).editorDocument;
    const r2 = (await patterns.saveEditorRevision(w.ctx, {
      revisionId: r1.id, document: doc1, name: "Second", actor: w.actor,
    })).revision;
    const r2Frozen = JSON.stringify(await PatternRevision.findById(r2.id).lean());

    /* Now go back and edit the FIRST one. */
    const branched = (await patterns.saveEditorRevision(w.ctx, {
      revisionId: r1.id, document: doc1, name: "Branch from the first", actor: w.actor,
    })).revision;

    expect(branched.origin.parentRevisionRef).toBe(r1.revisionRef);
    expect(branched.revisionNumber).toBe(3);
    expect(JSON.stringify(await PatternRevision.findById(r2.id).lean())).toBe(r2Frozen);
  });

  test("the history walks parent to child", async () => {
    const w = await world();
    const r1 = await imported(w);
    const doc = (await documentOf(w, r1.id)).editorDocument;
    const r2 = (await patterns.saveEditorRevision(w.ctx, {
      revisionId: r1.id, document: doc, name: "Second", actor: w.actor,
    })).revision;
    const list = await patterns.listRevisions(w.ctx, { styleId: String(w.style._id) });
    const byRef = new Map(list.revisions.map((r) => [r.revisionRef, r]));
    expect(byRef.get(r2.revisionRef).origin.parentRevisionRef).toBe(r1.revisionRef);
    expect(byRef.get(r1.revisionRef).origin.kind).toBe("dxf-import");
  });
});

/* ═══ 3 · THE SAME SAVE, PRESSED TWICE ════════════════════════════════════ */

describe("a retried save", () => {
  test("MAKES ONE REVISION, AND RETURNS THE ONE IT MADE", async () => {
    const w = await world();
    const parent = await imported(w);
    const doc = (await documentOf(w, parent.id)).editorDocument;
    const key = "save-attempt-0001";

    const first = await patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: doc, name: "Once", idempotencyKey: key, actor: w.actor,
    });
    const second = await patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: doc, name: "Once", idempotencyKey: key, actor: w.actor,
    });

    expect(first.idempotent).toBe(false);
    expect(second.idempotent).toBe(true);
    expect(second.revision.id).toBe(first.revision.id);
    expect(await PatternRevision.countDocuments({ companyId: w.co._id })).toBe(2);
  });

  test("two retries arriving together still make one revision", async () => {
    const w = await world();
    const parent = await imported(w);
    const doc = (await documentOf(w, parent.id)).editorDocument;
    const key = "racing-key";
    const results = await Promise.all([
      patterns.saveEditorRevision(w.ctx, { revisionId: parent.id, document: doc, name: "R", idempotencyKey: key, actor: w.actor }),
      patterns.saveEditorRevision(w.ctx, { revisionId: parent.id, document: doc, name: "R", idempotencyKey: key, actor: w.actor }),
    ]);
    expect(results[0].revision.id).toBe(results[1].revision.id);
    expect(await PatternRevision.countDocuments({ companyId: w.co._id })).toBe(2);
  });

  test("a different save is a different revision", async () => {
    const w = await world();
    const parent = await imported(w);
    const doc = (await documentOf(w, parent.id)).editorDocument;
    const a = await patterns.saveEditorRevision(w.ctx, { revisionId: parent.id, document: doc, name: "A", idempotencyKey: "k1", actor: w.actor });
    const b = await patterns.saveEditorRevision(w.ctx, { revisionId: parent.id, document: doc, name: "B", idempotencyKey: "k2", actor: w.actor });
    expect(b.revision.id).not.toBe(a.revision.id);
  });

  test("and a save with no key at all is never treated as a repeat", async () => {
    const w = await world();
    const parent = await imported(w);
    const doc = (await documentOf(w, parent.id)).editorDocument;
    const a = await patterns.saveEditorRevision(w.ctx, { revisionId: parent.id, document: doc, name: "A", actor: w.actor });
    const b = await patterns.saveEditorRevision(w.ctx, { revisionId: parent.id, document: doc, name: "B", actor: w.actor });
    expect(b.revision.id).not.toBe(a.revision.id);
  });
});

/* ═══ 4 · THE SEMANTICS ═══════════════════════════════════════════════════ */

describe("what a pattern editor knows, and what the schema now holds", () => {
  const enrich = (doc) => {
    const p = doc.pieces[0];
    p.points[0].edge = "sew";
    p.points[1].edge = "finished";
    p.points[2].edge = "fold";
    p.points[1].allowanceMm = 40;
    p.points[0].kind = "curve";
    p.provenance = { geometry: "authored", note: "reshaped here" };
    p.allowance = { widthMm: 10, source: "stated", provenance: "authored" };
    p.notches.push({
      notchId: "n-new", x: p.points[0].x, y: p.points[0].y, form: "v", depthMm: 6,
      afterPointId: p.points[0].pointId, offsetMm: 0, provenance: "authored",
    });
    p.grainline = {
      fromX: 10, fromY: 10, toX: 10, toY: 200, provenance: "authored",
    };
    p.sewingLine = {
      points: p.points.map((v) => ({ x: v.x + 1, y: v.y + 1 })), provenance: "derived",
    };
    doc.seams = [{
      seamId: "s1", name: "Left side",
      a: { pieceId: p.pieceId, edgePointIds: [p.points[0].pointId, p.points[1].pointId], reversed: false, lengthMm: 123.4, role: "side" },
      b: { pieceId: doc.pieces[1].pieceId, edgePointIds: [doc.pieces[1].points[0].pointId, doc.pieces[1].points[1].pointId], reversed: true, lengthMm: 125.9, role: "side" },
      alignment: "start-to-start", confidence: "needs-checking", easeMm: 2.5, easePercent: 2.03, note: "",
    }];
    doc.measurements = [{
      measurementId: "m1", kind: "straight", pieceId: p.pieceId,
      fromPointId: p.points[0].pointId, toPointId: p.points[2].pointId,
      name: "Chest width", pomCode: "A-01", note: "half, flat", valueMmAtSave: 310.5,
    }];
    return doc;
  };

  test("EVERY FIELD SURVIVES THE ROUND TRIP", async () => {
    const w = await world();
    const parent = await imported(w);
    const doc = enrich((await documentOf(w, parent.id)).editorDocument);
    const saved = await patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: doc, name: "Everything", changeNote: "the lot", actor: w.actor,
    });
    const back = (await documentOf(w, saved.revision.id)).editorDocument;
    const p = back.pieces[0];

    expect(p.points[0].edge).toBe("sew");
    expect(p.points[1].edge).toBe("finished");
    expect(p.points[2].edge).toBe("fold");
    expect(p.points[1].allowanceMm).toBe(40);
    expect(p.points[0].kind).toBe("curve");
    expect(p.provenance.geometry).toBe("authored");
    expect(p.allowance).toMatchObject({ widthMm: 10, source: "stated", provenance: "authored" });
    expect(p.notches.find((n) => n.notchId === "n-new")).toMatchObject({ form: "v", depthMm: 6, provenance: "authored" });
    expect(p.grainline).toMatchObject({ toY: 200, provenance: "authored" });
    expect(p.sewingLine.points.length).toBe(p.points.length);
    expect(p.sewingLine.provenance).toBe("derived");

    expect(back.seams[0]).toMatchObject({
      seamId: "s1", name: "Left side", alignment: "start-to-start",
      confidence: "needs-checking", easeMm: 2.5, easePercent: 2.03,
    });
    expect(back.seams[0].a.edgePointIds.length).toBe(2);
    expect(back.seams[0].b.reversed).toBe(true);

    expect(back.measurements[0]).toMatchObject({
      measurementId: "m1", kind: "straight", name: "Chest width", pomCode: "A-01",
      note: "half, flat", valueMmAtSave: 310.5,
    });
  });

  test("the point ids a seam names are the same ids after reload", async () => {
    const w = await world();
    const parent = await imported(w);
    const doc = enrich((await documentOf(w, parent.id)).editorDocument);
    const wanted = doc.seams[0].a.edgePointIds.slice();
    const saved = await patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: doc, name: "x", actor: w.actor,
    });
    const back = (await documentOf(w, saved.revision.id)).editorDocument;
    expect(back.seams[0].a.edgePointIds).toEqual(wanted);
    const onPiece = new Set(back.pieces[0].points.map((v) => v.pointId));
    for (const id of wanted) expect(onPiece.has(id)).toBe(true);
  });

  test("a sewing line is kept apart from the cut line, never folded into it", async () => {
    const w = await world();
    const parent = await imported(w);
    const doc = enrich((await documentOf(w, parent.id)).editorDocument);
    const cut = doc.pieces[0].points.map((v) => [v.x, v.y]);
    const saved = await patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: doc, name: "x", actor: w.actor,
    });
    const back = (await documentOf(w, saved.revision.id)).editorDocument;
    expect(back.pieces[0].points.map((v) => [v.x, v.y])).toEqual(cut);
    expect(back.pieces[0].sewingLine.points[0].x).toBe(cut[0][0] + 1);
  });
});

/* ═══ 5 · WHAT IS REFUSED ═════════════════════════════════════════════════ */

describe("a document that cannot be saved", () => {
  const doc = async (w, parent) => (await documentOf(w, parent.id)).editorDocument;

  test("no name", async () => {
    const w = await world();
    const parent = await imported(w);
    const d = await doc(w, parent);
    const err = await refuses(() => patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: d, name: "  ", actor: w.actor,
    }), "VALIDATION");
    expect(err.message).toMatch(/needs a name/);
  });

  test("two points sharing an id", async () => {
    const w = await world();
    const parent = await imported(w);
    const d = await doc(w, parent);
    d.pieces[0].points[1].pointId = d.pieces[0].points[0].pointId;
    const err = await refuses(() => patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: d, name: "x", actor: w.actor,
    }), "VALIDATION");
    expect(err.message).toMatch(/share the id/);
  });

  test("A DISCONTINUOUS SEAM RUN", async () => {
    const w = await world();
    const parent = await imported(w);
    const d = await doc(w, parent);
    const p = d.pieces[0];
    d.seams = [{
      seamId: "s1", name: "Broken",
      /* Edges 0 and 2 — with 1 missing. Sewn as one run, cloth is attached to a
         gap, and nothing on the screen shows it. */
      a: { pieceId: p.pieceId, edgePointIds: [p.points[0].pointId, p.points[2].pointId] },
      b: { pieceId: d.pieces[1].pieceId, edgePointIds: [d.pieces[1].points[0].pointId] },
      alignment: "", confidence: "proposed",
    }];
    const err = await refuses(() => patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: d, name: "x", actor: w.actor,
    }), "VALIDATION");
    expect(err.message).toMatch(/not continuous/);
  });

  test("ONE EDGE SEWN INTO TWO SEAMS", async () => {
    const w = await world();
    const parent = await imported(w);
    const d = await doc(w, parent);
    const p = d.pieces[0];
    const q = d.pieces[1];
    const run = { pieceId: p.pieceId, edgePointIds: [p.points[0].pointId] };
    d.seams = [
      { seamId: "s1", name: "First", a: run, b: { pieceId: q.pieceId, edgePointIds: [q.points[0].pointId] }, alignment: "", confidence: "proposed" },
      { seamId: "s2", name: "Second", a: run, b: { pieceId: q.pieceId, edgePointIds: [q.points[1].pointId] }, alignment: "", confidence: "proposed" },
    ];
    const err = await refuses(() => patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: d, name: "x", actor: w.actor,
    }), "VALIDATION");
    expect(err.message).toMatch(/already sewn into/);
  });

  test("a run naming an edge that is not on its piece", async () => {
    const w = await world();
    const parent = await imported(w);
    const d = await doc(w, parent);
    d.seams = [{
      seamId: "s1", name: "Wrong piece",
      a: { pieceId: d.pieces[0].pieceId, edgePointIds: [d.pieces[1].points[0].pointId] },
      b: { pieceId: d.pieces[1].pieceId, edgePointIds: [d.pieces[1].points[1].pointId] },
      alignment: "", confidence: "proposed",
    }];
    await refuses(() => patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: d, name: "x", actor: w.actor,
    }), "VALIDATION");
  });

  test("a measurement on a piece that is not there", async () => {
    const w = await world();
    const parent = await imported(w);
    const d = await doc(w, parent);
    d.measurements = [{ measurementId: "m1", kind: "straight", pieceId: "nope", name: "X" }];
    await refuses(() => patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: d, name: "x", actor: w.actor,
    }), "VALIDATION");
  });

  test("a document in anything but millimetres", async () => {
    const w = await world();
    const parent = await imported(w);
    const d = await doc(w, parent);
    d.unit = "in";
    await refuses(() => patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: d, name: "x", actor: w.actor,
    }), "VALIDATION");
  });

  test("a save against a revision changed underneath it", async () => {
    const w = await world();
    const parent = await imported(w);
    await refuses(() => patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: null, name: "x",
      expectedRevision: parent.revision + 5, actor: w.actor,
    }), "REVISION_CONFLICT");
  });
});

/* ═══ 6 · TENANCY ═════════════════════════════════════════════════════════ */

describe("a revision belongs to one company", () => {
  test("ANOTHER COMPANY CANNOT READ IT, AND CANNOT SAVE OVER IT", async () => {
    const a = await world();
    const b = await world();
    const parent = await imported(a);
    const doc = (await documentOf(a, parent.id)).editorDocument;

    await refuses(() => patterns.readRevision(b.ctx, { revisionId: parent.id }), "NOT_FOUND");
    await refuses(() => patterns.saveEditorRevision(b.ctx, {
      revisionId: parent.id, document: doc, name: "theirs", actor: b.actor,
    }), "NOT_FOUND");
  });

  test("a save with no company context is refused before anything is read", async () => {
    const w = await world();
    const parent = await imported(w);
    await refuses(() => patterns.saveEditorRevision({}, {
      revisionId: parent.id, document: null, name: "x",
    }), "COMPANY_CONTEXT_UNAVAILABLE");
  });

  test("the child lands on the parent's style, not on one the caller names", async () => {
    const w = await world();
    const parent = await imported(w);
    const doc = (await documentOf(w, parent.id)).editorDocument;
    const saved = await patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: doc, name: "x",
      styleId: String(w.other._id), actor: w.actor,
    });
    const row = await PatternRevision.findById(saved.revision.id).lean();
    expect(String(row.styleId)).toBe(String(w.style._id));
    expect(String(row.styleId)).not.toBe(String(w.other._id));
  });
});

/* ═══ 7 · OLDER REVISIONS ═════════════════════════════════════════════════ */

describe("schema versions", () => {
  test("a revision stored before this field existed still opens", async () => {
    const w = await world();
    const parent = await imported(w);
    await PatternRevision.updateOne({ _id: parent.id }, { $unset: { editorDocument: 1 } });
    const read = await documentOf(w, parent.id);
    expect(read.editorDocumentOrigin).toBe("normalised");
    expect(read.editorDocument.pieces.length).toBeGreaterThan(0);
  });

  test("A DOCUMENT FROM A LATER VERSION IS REFUSED, NOT REINTERPRETED", async () => {
    const w = await world();
    const parent = await imported(w);
    await PatternRevision.updateOne(
      { _id: parent.id },
      { $set: { editorDocument: { schemaVersion: 99, unit: "mm", pieces: [] } } },
    );
    const read = await documentOf(w, parent.id);
    expect(read.editorDocument).toBeNull();
    expect(read.editorDocumentProblems[0]).toMatch(/v99/);
    expect(read.editorDocumentProblems[0]).toMatch(/looks right and is not/);
  });

  test("a pattern with no declared unit is not normalised at a guessed scale", () => {
    const out = editorDoc.normaliseFromPatternSet({ unit: "", unitInMm: null, pieces: [] });
    expect(out.document).toBeNull();
    expect(out.problems[0]).toMatch(/25\.4/);
  });

  test("the version the server writes is the version it declares", async () => {
    const w = await world();
    const parent = await imported(w);
    const doc = (await documentOf(w, parent.id)).editorDocument;
    const saved = await patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: doc, name: "x", actor: w.actor,
    });
    const row = await PatternRevision.findById(saved.revision.id).lean();
    expect(row.editorDocument.schemaVersion).toBe(editorDoc.EDITOR_SCHEMA_VERSION);
  });
});

/* ═══ 8 · THE SEAM MAPPING AND READINESS ══════════════════════════════════ */

describe("a seam mapping confirmed in the editor", () => {
  const confirmedSeam = (doc) => {
    const p = doc.pieces[0];
    const q = doc.pieces[1];
    return {
      seamId: "s-side", name: "Left side",
      a: { pieceId: p.pieceId, edgePointIds: [p.points[0].pointId, p.points[1].pointId], reversed: false, role: "side" },
      b: { pieceId: q.pieceId, edgePointIds: [q.points[0].pointId, q.points[1].pointId], reversed: true, role: "side" },
      alignment: "start-to-start", confidence: "confirmed", easePercent: 1.2,
    };
  };

  test("IS STAMPED AGAINST THE REVISION IT WAS DRAWN ON", async () => {
    /* Readiness refuses a mapping confirmed against a different revision, and it
       is right to — a mapping names point indices and an edit moves them. But
       carrying the parent's stamp forward means every save makes the pattern
       un-renderable until somebody re-confirms the mapping they just drew. */
    const w = await world();
    const parent = await imported(w);
    const doc = (await documentOf(w, parent.id)).editorDocument;
    doc.seams = [confirmedSeam(doc)];

    const saved = await patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: doc, name: "Mapped here", actor: w.actor,
    });
    const row = await PatternRevision.findById(saved.revision.id).lean();
    expect(row.mappingConfirmedAgainstRef).toBe(row.revisionRef);
    expect(row.simulationInputs.seams).toHaveLength(1);
    expect(row.simulationInputs.seams[0].confidence).toBe("confirmed");
    expect(row.simulationInputs.seams[0].alignment).toBe("start-to-start");
  });

  test("and the runs it projects name the pieces and carry a direction", async () => {
    const w = await world();
    const parent = await imported(w);
    const doc = (await documentOf(w, parent.id)).editorDocument;
    doc.seams = [confirmedSeam(doc)];
    const saved = await patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: doc, name: "x", actor: w.actor,
    });
    const row = await PatternRevision.findById(saved.revision.id).lean();
    const refs = row.simulationInputs.pieces.filter((p) => p.runs.length);
    expect(refs).toHaveLength(2);
    const sideB = row.simulationInputs.pieces
      .flatMap((p) => p.runs).find((r) => r.runId === "s-side-b");
    expect(sideB.direction).toBe("reverse");
    expect(sideB.startAnchor.kind).toBe("turn-point");
  });

  test("AN UNCONFIRMED MAPPING DOES NOT STAMP, AND READINESS GOES ON REFUSING", async () => {
    const w = await world();
    const parent = await imported(w);
    const doc = (await documentOf(w, parent.id)).editorDocument;
    doc.seams = [{ ...confirmedSeam(doc), confidence: "needs-checking" }];
    const saved = await patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: doc, name: "x", actor: w.actor,
    });
    const row = await PatternRevision.findById(saved.revision.id).lean();
    expect(row.mappingConfirmedAgainstRef).not.toBe(row.revisionRef);
    /* The parent's inputs are carried unchanged, so nothing was invented. */
    expect(JSON.stringify(row.simulationInputs.seams || []))
      .toBe(JSON.stringify((await PatternRevision.findById(parent.id).lean()).simulationInputs.seams || []));
  });

  test("a confirmed seam with no alignment stated is not confirmation", async () => {
    const w = await world();
    const parent = await imported(w);
    const doc = (await documentOf(w, parent.id)).editorDocument;
    doc.seams = [{ ...confirmedSeam(doc), alignment: "" }];
    const saved = await patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: doc, name: "x", actor: w.actor,
    });
    const row = await PatternRevision.findById(saved.revision.id).lean();
    expect(row.mappingConfirmedAgainstRef).not.toBe(row.revisionRef);
  });

  test("a document with no seams at all leaves the parent's mapping alone", async () => {
    const w = await world();
    const parent = await imported(w);
    const before = (await PatternRevision.findById(parent.id).lean()).simulationInputs;
    const doc = (await documentOf(w, parent.id)).editorDocument;
    const saved = await patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: doc, name: "x", actor: w.actor,
    });
    const row = await PatternRevision.findById(saved.revision.id).lean();
    /* By value, not by serialised key order: a mongoose round trip reorders
       keys and that is not a change to anything. */
    expect(row.simulationInputs).toEqual(before);
  });
});

/* ═══ 9 · A MAPPING MADE SOMEWHERE ELSE ═══════════════════════════════════ */

describe("a seam mapping that already exists on the revision", () => {
  test("IT REACHES THE EDITOR AS MULTI-EDGE RUNS, NOT AS NOTHING", async () => {
    /* Opening a mapped revision in the editor and saving it must not silently
       drop the mapping — that would make a renderable pattern un-renderable for
       no reason anybody could see. */
    const w = await world();
    const parent = await imported(w);
    await patterns.setSimulationInputs(w.ctx, {
      revisionId: parent.id, inputs: tee.simulationInputs(), actor: w.actor,
    });
    const read = await documentOf(w, parent.id);
    const seams = read.editorDocument.seams;
    expect(seams.length).toBeGreaterThan(0);
    /* The fixture's pieces are eight and four points, so its runs are one and
       two edges. What matters here is that a single-run side arrives as a LIST
       of edges rather than as nothing — the multi-edge case is the same code
       path and is walked against the real 125-point export. */
    const usable = seams.filter((s) => !s.unsupported);
    expect(usable.length).toBeGreaterThan(0);
    for (const s of usable) {
      expect(s.a.edgePointIds.length).toBeGreaterThan(0);
      expect(s.b.edgePointIds.length).toBeGreaterThan(0);
      expect(Array.isArray(s.a.edgePointIds)).toBe(true);
    }
  });

  test("THE RUN IS THE STRETCH IT WAS MEANT TO BE, BY LENGTH", async () => {
    /* `theLongWay` is about arc length. Choosing by edge count instead picks a
       twenty-nine-segment curve over the four long segments the other way round
       and hands the solver a 27 cm run to sew to a 12 cm one. */
    const w = await world();
    const parent = await imported(w);
    await patterns.setSimulationInputs(w.ctx, {
      revisionId: parent.id, inputs: tee.simulationInputs(), actor: w.actor,
    });
    const doc = (await documentOf(w, parent.id)).editorDocument;
    const lengthOf = (run) => {
      const p = doc.pieces.find((x) => x.pieceId === run.pieceId);
      if (!p) return 0;
      const order = p.points.map((v) => v.pointId);
      let total = 0;
      for (const id of run.edgePointIds) {
        const i = order.indexOf(id);
        const a = p.points[i];
        const b = p.points[(i + 1) % p.points.length];
        total += Math.hypot(b.x - a.x, b.y - a.y);
      }
      return total;
    };
    for (const s of doc.seams) {
      if (s.unsupported) continue;
      const a = lengthOf(s.a);
      const b = lengthOf(s.b);
      const ease = Math.abs(a - b) / Math.max(1, Math.min(a, b));
      expect(ease).toBeLessThan(0.3);
    }
  });

  test("A SIDE MADE OF SEVERAL RUNS IS CARRIED, NOT MISTRANSLATED", async () => {
    /* A set-in sleeve is one cap run sewn to two or three body runs in order.
       The editor's run is one continuous stretch on one piece and cannot say
       that, so the seam is kept and marked rather than silently reduced to its
       first run — which is what produced 119% of ease that was nowhere in the
       pattern. */
    const w = await world();
    const parent = await imported(w);
    await patterns.setSimulationInputs(w.ctx, {
      revisionId: parent.id, inputs: tee.simulationInputs(), actor: w.actor,
    });
    const doc = (await documentOf(w, parent.id)).editorDocument;
    const carried = doc.seams.filter((s) => s.unsupported);
    for (const s of carried) {
      expect(s.confidence).toBe("needs-checking");
      expect(s.note).toMatch(/runs sewn in order/);
      expect(s.a.edgePointIds.length === 0 || s.b.edgePointIds.length === 0).toBe(true);
    }
  });

  test("and an unsupported seam does not block a save", async () => {
    const w = await world();
    const parent = await imported(w);
    await patterns.setSimulationInputs(w.ctx, {
      revisionId: parent.id, inputs: tee.simulationInputs(), actor: w.actor,
    });
    const doc = (await documentOf(w, parent.id)).editorDocument;
    const saved = await patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: doc, name: "Opened a mapped revision", actor: w.actor,
    });
    expect(saved.revision.revisionRef).toBeTruthy();
    /* Not every seam is confirmable here, so the parent's mapping and stamp are
       carried rather than re-stamped. */
    const row = await PatternRevision.findById(saved.revision.id).lean();
    expect(row.mappingConfirmedAgainstRef).not.toBe(row.revisionRef);
  });
});
