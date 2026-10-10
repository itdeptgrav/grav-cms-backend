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

describe("native pattern creation without a DXF", () => {
  test("an editor-authored multi-piece pattern reaches drape readiness without a source DXF", async () => {
    const w = await world();
    const root = (await patterns.createNativeRevision(w.ctx, {
      styleId: w.style._id, name: "Native shirt pilot", idempotencyKey: `native-${++seq}`, actor: w.actor,
    })).revision;
    const doc = (await documentOf(w, root.id)).editorDocument;
    /* This is a synthetic editor document, not the imported CLO test DXF. It
       exercises the same save/projection path as drawn outlines, using a small
       five-panel construction whose seam runs are already reviewed. */
    const drawn = tee.patternSet({ withNeckBand: true });
    doc.pieces = drawn.pieces.map((piece) => ({
      pieceId: piece.pieceRef.toLowerCase(), pieceRef: piece.pieceRef,
      name: piece.name, closed: true,
      points: piece.outline.map((point, index) => ({
        pointId: `${piece.pieceRef}-${index}`, x: point.x, y: point.y, kind: "corner",
      })),
      grainline: {
        fromX: piece.grainline.from.x, fromY: piece.grainline.from.y,
        toX: piece.grainline.to.x, toY: piece.grainline.to.y,
      },
      allowance: { widthMm: 10, source: "stated" },
      notches: [], internalLines: [],
      provenance: { geometry: "authored", note: "Synthetic native-path regression" },
    }));
    const child = (await patterns.saveEditorRevision(w.ctx, {
      revisionId: root.id, document: doc, name: "Five drawn panels", actor: w.actor,
    })).revision;
    const settings = tee.simulationInputs({ withNeckBand: true });
    settings.template = "woven-shirt";
    settings.avatar.poseRef = "a-pose";
    settings.avatarConfirmed = true;
    settings.fabricConfirmed = true;
    settings.sewingLine = { lineMeaning: "cut_line", source: "derived", allowanceMm: 10,
      origin: "user-confirmation", confirmed: true };
    const slots = {
      "PC-FRONT": "front", "PC-BACK": "back", "PC-SLV-L": "left-arm",
      "PC-SLV-R": "right-arm", "PC-BAND": "neck",
    };
    settings.pieces = settings.pieces.map((plan) => ({
      ...plan, placementSlot: slots[plan.pieceRef], placementLayer: "base",
      placementOffsetMm: [0, 0, 0], placementYawDeg: 0,
      placementConfirmed: true,
    }));
    await patterns.setSimulationInputs(w.ctx, {
      revisionId: child.id, actor: w.actor, inputs: settings,
    });
    const saved = await documentOf(w, child.id);
    const untouchedRoot = await documentOf(w, root.id);
    expect(saved.origin.rootKind).toBe("native-authoring");
    expect(saved.sourceDxf.sha256).toBe("");
    expect(saved.patternSet.pieces).toHaveLength(5);
    expect(saved.readiness.ready).toBe(true);
    expect(saved.simulationInputs.pieces.map((p) => p.placementSlot)).toEqual([
      "front", "back", "left-arm", "right-arm", "neck",
    ]);
    expect(untouchedRoot.patternSet.pieces).toEqual([]);
  });

  test("native placement is confirmed per piece and expires after a changed arrangement", async () => {
    const w = await world();
    const root = (await patterns.createNativeRevision(w.ctx, {
      styleId: w.style._id, name: "Woven shirt", idempotencyKey: `native-${++seq}`, actor: w.actor,
    })).revision;
    const doc = (await documentOf(w, root.id)).editorDocument;
    doc.pieces.push({ pieceId: "front", pieceRef: "", name: "Front", closed: true,
      points: [
        { pointId: "a", x: 0, y: 0, kind: "corner" },
        { pointId: "b", x: 200, y: 0, kind: "corner" },
        { pointId: "c", x: 200, y: 300, kind: "corner" },
        { pointId: "d", x: 0, y: 300, kind: "corner" },
      ], notches: [], internalLines: [], provenance: { geometry: "authored", note: "" } });
    const child = (await patterns.saveEditorRevision(w.ctx, {
      revisionId: root.id, document: doc, name: "Front panel", actor: w.actor,
    })).revision;
    await patterns.setSimulationInputs(w.ctx, { revisionId: child.id, actor: w.actor, inputs: {
      pieces: [{ pieceRef: "PP-FRONT", role: "body.front", roleConfirmed: true,
        placementSlot: "front", placementLayer: "base",
        placementOffsetMm: [0, 0, 0], placementYawDeg: 0,
        placementConfirmed: true }],
    } });
    let read = await documentOf(w, child.id);
    expect(read.simulationInputs.pieces[0].placementConfirmed).toMatchObject({
      by: expect.objectContaining({ name: w.actor.name }),
    });
    expect(read.readiness.failures.map((f) => f.code)).not.toContain("R_NATIVE_PLACEMENT_UNCONFIRMED");

    await patterns.setSimulationInputs(w.ctx, { revisionId: child.id, actor: w.actor, inputs: {
      pieces: [{ ...read.simulationInputs.pieces[0], placementLayer: "outer" }],
    } });
    read = await documentOf(w, child.id);
    expect(read.simulationInputs.pieces[0].placementConfirmed).toBeNull();
    expect(read.readiness.failures.map((f) => f.code)).toContain("R_NATIVE_PLACEMENT_UNCONFIRMED");

    await patterns.setSimulationInputs(w.ctx, { revisionId: child.id, actor: w.actor, inputs: {
      pieces: [{ ...read.simulationInputs.pieces[0], placementConfirmed: true }],
    } });
    read = await documentOf(w, child.id);
    await patterns.setSimulationInputs(w.ctx, { revisionId: child.id, actor: w.actor, inputs: {
      pieces: [{ ...read.simulationInputs.pieces[0], placementOffsetMm: [20, 0, 0] }],
    } });
    read = await documentOf(w, child.id);
    expect(read.simulationInputs.pieces[0].placementConfirmed).toBeNull();

    await patterns.setSimulationInputs(w.ctx, { revisionId: child.id, actor: w.actor, inputs: {
      pieces: [{ ...read.simulationInputs.pieces[0], placementConfirmed: true }],
    } });
    read = await documentOf(w, child.id);
    await patterns.setSimulationInputs(w.ctx, { revisionId: child.id, actor: w.actor, inputs: {
      avatar: { name: "New body", poseRef: "a-pose", measurements: { chestMm: 1000 } },
    } });
    read = await documentOf(w, child.id);
    expect(read.simulationInputs.pieces[0].placementConfirmed).toBeNull();
  });

  test("body and fabric review stamps are attributable and expire when their values change", async () => {
    const w = await world();
    const root = (await patterns.createNativeRevision(w.ctx, {
      styleId: w.style._id, name: "Woven shirt", idempotencyKey: `native-${++seq}`, actor: w.actor,
    })).revision;
    await patterns.setSimulationInputs(w.ctx, { revisionId: root.id, actor: w.actor, inputs: {
      avatar: { name: "Body M", measurements: { chestMm: 1000 } },
      avatarConfirmed: true,
      fabrics: [{ profileId: "cotton", name: "Cotton", behaviour: "woven", weightGsm: 120,
        grade: "measured", source: "mill test", stretchWarpPercent: 2, stretchWeftPercent: 3 }],
      fabricConfirmed: true,
    } });
    let read = await documentOf(w, root.id);
    expect(read.simulationInputs.avatarConfirmed).toMatchObject({ by: expect.objectContaining({ name: w.actor.name }) });
    expect(read.simulationInputs.fabricConfirmed).toMatchObject({ by: expect.objectContaining({ name: w.actor.name }) });
    expect(read.readiness.failures.map((f) => f.code)).not.toContain("R_NATIVE_AVATAR_UNCONFIRMED");
    expect(read.readiness.failures.map((f) => f.code)).not.toContain("R_NATIVE_FABRIC_UNCONFIRMED");

    await patterns.setSimulationInputs(w.ctx, { revisionId: root.id, actor: w.actor, inputs: {
      avatar: { name: "Body M", measurements: { chestMm: 1040 } },
      avatarConfirmed: read.simulationInputs.avatarConfirmed,
    } });
    read = await documentOf(w, root.id);
    expect(read.simulationInputs.avatarConfirmed).toBeNull();
    expect(read.simulationInputs.fabricConfirmed).not.toBeNull();
    expect(read.readiness.failures.map((f) => f.code)).toContain("R_NATIVE_AVATAR_UNCONFIRMED");

    await patterns.setSimulationInputs(w.ctx, { revisionId: root.id, actor: w.actor, inputs: {
      fabrics: [{ profileId: "cotton", name: "Cotton", behaviour: "woven", weightGsm: 130,
        grade: "measured", source: "mill test", stretchWarpPercent: 2, stretchWeftPercent: 3 }],
      fabricConfirmed: read.simulationInputs.fabricConfirmed,
    } });
    read = await documentOf(w, root.id);
    expect(read.simulationInputs.fabricConfirmed).toBeNull();
    expect(read.readiness.failures.map((f) => f.code)).toContain("R_NATIVE_FABRIC_UNCONFIRMED");
  });

  test("a buttoned-front decision persists and its confirmation expires when stations change", async () => {
    const w = await world();
    const root = (await patterns.createNativeRevision(w.ctx, {
      styleId: w.style._id, name: "Woven shirt", idempotencyKey: `native-${++seq}`, actor: w.actor,
    })).revision;
    await patterns.setSimulationInputs(w.ctx, { revisionId: root.id, actor: w.actor, inputs: {
      frontClosure: { state: "buttoned", leftPlacketRef: "left", rightPlacketRef: "right",
        stationsFromTopMm: [100, 220], confirmed: true },
    } });
    let read = await documentOf(w, root.id);
    expect(read.simulationInputs.frontClosure.stationsFromTopMm).toEqual([100, 220]);
    expect(read.simulationInputs.frontClosure.confirmed).toMatchObject({
      by: expect.objectContaining({ name: w.actor.name }),
    });
    await patterns.setSimulationInputs(w.ctx, { revisionId: root.id, actor: w.actor, inputs: {
      frontClosure: { ...read.simulationInputs.frontClosure,
        stationsFromTopMm: [100, 225] },
    } });
    read = await documentOf(w, root.id);
    expect(read.simulationInputs.frontClosure.confirmed).toBeNull();
    expect(read.simulationInputs.frontClosure.stationsFromTopMm).toEqual([100, 225]);
  });

  test("a named empty root opens in the editor but is not render-ready", async () => {
    const w = await world();
    const created = await patterns.createNativeRevision(w.ctx, {
      styleId: w.style._id, name: "Woven shirt", idempotencyKey: `native-${++seq}`, actor: w.actor,
    });
    const read = await documentOf(w, created.revision.id);
    expect(created.idempotent).toBe(false);
    expect(read.origin).toEqual({ kind: "native-authoring", rootKind: "native-authoring", parentRevisionRef: "" });
    expect(read.state).toBe("draft");
    expect(read.sourceDxf.sha256).toBe("");
    expect(read.patternSet.unit).toBe("mm");
    expect(read.patternSet.pieces).toEqual([]);
    expect(read.editorDocumentOrigin).toBe("stored");
    expect(read.editorDocument.pieces).toEqual([]);
    expect(read.readiness.ready).toBe(false);
  });

  test("retrying creation cannot produce a second root", async () => {
    const w = await world();
    const key = `native-${++seq}`;
    const first = await patterns.createNativeRevision(w.ctx, {
      styleId: w.style._id, name: "Woven shirt", idempotencyKey: key, actor: w.actor,
    });
    const retry = await patterns.createNativeRevision(w.ctx, {
      styleId: w.style._id, name: "Woven shirt", idempotencyKey: key, actor: w.actor,
    });
    expect(retry.idempotent).toBe(true);
    expect(retry.revision.id).toBe(first.revision.id);
    expect(await PatternRevision.countDocuments({ companyId: w.co._id, styleId: w.style._id })).toBe(1);
    await refuses(() => patterns.createNativeRevision(w.ctx, {
      styleId: w.other._id, name: "Different style", idempotencyKey: key, actor: w.actor,
    }), "REVISION_CONFLICT");
  });

  test("a drawn child saves without inventing an imported source", async () => {
    const w = await world();
    const root = (await patterns.createNativeRevision(w.ctx, {
      styleId: w.style._id, name: "Woven shirt", idempotencyKey: `native-${++seq}`, actor: w.actor,
    })).revision;
    const doc = (await documentOf(w, root.id)).editorDocument;
    doc.pieces.push({
      pieceId: "p1", pieceRef: "", name: "Front", closed: true,
      points: [
        { pointId: "v1", x: 0, y: 0, kind: "corner", edge: "" },
        { pointId: "v2", x: 200, y: 0, kind: "corner", edge: "" },
        { pointId: "v3", x: 200, y: 300, kind: "corner", edge: "" },
        { pointId: "v4", x: 0, y: 300, kind: "corner", edge: "" },
      ],
      notches: [], internalLines: [], provenance: { geometry: "authored", note: "" },
    });
    const child = (await patterns.saveEditorRevision(w.ctx, {
      revisionId: root.id, document: doc, name: "First drafted piece", actor: w.actor,
    })).revision;
    const saved = await documentOf(w, child.id);
    expect(saved.origin).toEqual({ kind: "edit", rootKind: "native-authoring", parentRevisionRef: root.revisionRef });
    expect(saved.sourceDxf.sha256).toBe("");
    expect(saved.patternSet.pieces).toHaveLength(1);
    expect(saved.editorDocument.pieces[0].provenance.geometry).toBe("authored");
    expect((await documentOf(w, root.id)).editorDocument.pieces).toEqual([]);
  });

  test("internal operations persist but cannot be silently omitted from a native drape", async () => {
    const w = await world();
    const root = (await patterns.createNativeRevision(w.ctx, {
      styleId: w.style._id, name: "Woven shirt", idempotencyKey: `native-${++seq}`, actor: w.actor,
    })).revision;
    const doc = (await documentOf(w, root.id)).editorDocument;
    doc.pieces.push({
      pieceId: "front", pieceRef: "", name: "Front", closed: true,
      points: [
        { pointId: "a", x: 0, y: 0, kind: "corner", edge: "" },
        { pointId: "b", x: 200, y: 0, kind: "corner", edge: "" },
        { pointId: "c", x: 200, y: 300, kind: "corner", edge: "" },
        { pointId: "d", x: 0, y: 300, kind: "corner", edge: "" },
      ],
      notches: [], provenance: { geometry: "authored", note: "" },
      internalLines: [{ lineId: "placket", points: [{ x: 90, y: 0 }, { x: 90, y: 300 }],
        closed: false, operation: "placket", confirmed: true, note: "front opening", provenance: "authored" }],
    });
    const saved = (await patterns.saveEditorRevision(w.ctx, {
      revisionId: root.id, document: doc, name: "Placket drafted", actor: w.actor,
    })).revision;
    const read = await documentOf(w, saved.id);
    expect(read.editorDocument.pieces[0].internalLines[0]).toMatchObject({
      lineId: "placket", operation: "placket", confirmed: true, note: "front opening",
    });
    expect(read.patternSet.pieces[0].internalLines[0]).toMatchObject({
      lineId: "placket", operation: "placket", confirmed: true, note: "front opening",
      provenance: "authored",
    });
    expect(read.readiness.ready).toBe(false);
    expect(read.readiness.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "R_NATIVE_PATH_UNSUPPORTED", lineId: "placket" }),
    ]));
  });

  test("editing an outline clears an inherited boundary-finish confirmation but keeps its role", async () => {
    const w = await world();
    const root = (await patterns.createNativeRevision(w.ctx, {
      styleId: w.style._id, name: "Woven shirt", idempotencyKey: `native-${++seq}`, actor: w.actor,
    })).revision;
    const doc = (await documentOf(w, root.id)).editorDocument;
    doc.pieces.push({ pieceId: "front", pieceRef: "", name: "Front", closed: true,
      points: [
        { pointId: "a", x: 0, y: 0, kind: "corner", edge: "" },
        { pointId: "b", x: 200, y: 0, kind: "corner", edge: "" },
        { pointId: "c", x: 200, y: 300, kind: "corner", edge: "" },
        { pointId: "d", x: 0, y: 300, kind: "corner", edge: "" },
      ], notches: [], internalLines: [], provenance: { geometry: "authored", note: "" } });
    const first = (await patterns.saveEditorRevision(w.ctx, {
      revisionId: root.id, document: doc, name: "Draft front", actor: w.actor,
    })).revision;
    await PatternRevision.updateOne({ _id: first.id }, { $set: { "simulationInputs.pieces": [{
      pieceRef: "PP-FRONT", role: "body.front", boundaryConfirmed: { by: w.actor, at: new Date() },
    }] } });
    const edited = (await documentOf(w, first.id)).editorDocument;
    edited.pieces[0].points[0].x = 5;
    const child = (await patterns.saveEditorRevision(w.ctx, {
      revisionId: first.id, document: edited, name: "Reshaped front", actor: w.actor,
    })).revision;
    const plan = (await documentOf(w, child.id)).simulationInputs.pieces[0];
    expect(plan.role).toBe("body.front");
    expect(plan.boundaryConfirmed).toBeNull();
  });
});

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
      sideA: { runs: [{ pieceId: p.pieceId, edgePointIds: [p.points[0].pointId, p.points[1].pointId], reversed: false, lengthMm: 123.4, role: "side", provenance: "authored", notchIds: [] }], reversed: false },
      sideB: { runs: [{ pieceId: doc.pieces[1].pieceId, edgePointIds: [doc.pieces[1].points[0].pointId, doc.pieces[1].points[1].pointId], reversed: true, lengthMm: 125.9, role: "side", provenance: "authored", notchIds: [] }], reversed: false },
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
    expect(back.seams[0].sideA.runs[0].edgePointIds.length).toBe(2);
    expect(back.seams[0].sideB.runs[0].reversed).toBe(true);

    expect(back.measurements[0]).toMatchObject({
      measurementId: "m1", kind: "straight", name: "Chest width", pomCode: "A-01",
      note: "half, flat", valueMmAtSave: 310.5,
    });
  });

  test("the point ids a seam names are the same ids after reload", async () => {
    const w = await world();
    const parent = await imported(w);
    const doc = enrich((await documentOf(w, parent.id)).editorDocument);
    const wanted = doc.seams[0].sideA.runs[0].edgePointIds.slice();
    const saved = await patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: doc, name: "x", actor: w.actor,
    });
    const back = (await documentOf(w, saved.revision.id)).editorDocument;
    expect(back.seams[0].sideA.runs[0].edgePointIds).toEqual(wanted);
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
      sideA: { runs: [{ pieceId: p.pieceId, edgePointIds: [p.points[0].pointId, p.points[2].pointId] }] },
      sideB: { runs: [{ pieceId: d.pieces[1].pieceId, edgePointIds: [d.pieces[1].points[0].pointId] }] },
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
    const side = { runs: [{ pieceId: p.pieceId, edgePointIds: [p.points[0].pointId] }] };
    d.seams = [
      { seamId: "s1", name: "First", sideA: side, sideB: { runs: [{ pieceId: q.pieceId, edgePointIds: [q.points[0].pointId] }] }, alignment: "", confidence: "proposed" },
      { seamId: "s2", name: "Second", sideA: side, sideB: { runs: [{ pieceId: q.pieceId, edgePointIds: [q.points[1].pointId] }] }, alignment: "", confidence: "proposed" },
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
      sideA: { runs: [{ pieceId: d.pieces[0].pieceId, edgePointIds: [d.pieces[1].points[0].pointId] }] },
      sideB: { runs: [{ pieceId: d.pieces[1].pieceId, edgePointIds: [d.pieces[1].points[1].pointId] }] },
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
      sideA: { runs: [{ pieceId: p.pieceId, edgePointIds: [p.points[0].pointId, p.points[1].pointId], reversed: false, role: "side" }], reversed: false },
      sideB: { runs: [{ pieceId: q.pieceId, edgePointIds: [q.points[0].pointId, q.points[1].pointId], reversed: true, role: "side" }], reversed: false },
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
    expect(seams.length).toBeGreaterThan(0);
    for (const s of seams) {
      expect(s.sideA.runs.length).toBeGreaterThan(0);
      expect(s.sideB.runs.length).toBeGreaterThan(0);
      for (const run of [...s.sideA.runs, ...s.sideB.runs]) {
        expect(run.edgePointIds.length).toBeGreaterThan(0);
      }
    }
    /* And at least one side is COMPOUND — the thing v1 could not say. */
    expect(seams.some((s) => s.sideA.runs.length > 1 || s.sideB.runs.length > 1)).toBe(true);
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
    for (const s of doc.seams) {
      const a = editorDoc.sideLength(s.sideA, doc.pieces).totalMm;
      const b = editorDoc.sideLength(s.sideB, doc.pieces).totalMm;
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

  test("every seam is expressible, so opening and saving re-confirms the mapping", async () => {
    /* The blocker this task removes. Three of the ten seams had a side made of
       several runs sewn in order, so the mapping could never be re-confirmed in
       the editor, so every save carried the parent's stamp and readiness refused
       with R11 for ever. A side is a list of runs now. */
    const w = await world();
    const parent = await imported(w);
    await patterns.setSimulationInputs(w.ctx, {
      revisionId: parent.id, inputs: tee.simulationInputs(), actor: w.actor,
    });
    const doc = (await documentOf(w, parent.id)).editorDocument;
    expect(doc.seams.every((s) => s.sideA.runs.length && s.sideB.runs.length)).toBe(true);
    expect(doc.seams.some((s) => s.unsupported)).toBe(false);

    const confirmed = {
      ...doc,
      seams: doc.seams.map((s) => ({ ...s, confidence: "confirmed", alignment: s.alignment || "start-to-start" })),
    };
    const saved = await patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: confirmed, name: "Mapping re-confirmed", actor: w.actor,
    });
    const row = await PatternRevision.findById(saved.revision.id).lean();
    expect(row.mappingConfirmedAgainstRef).toBe(row.revisionRef);
    expect(saved.revision.readiness.failures.map((f) => f.code)).not.toContain("R11");
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
    expect(seams.length).toBeGreaterThan(0);
    for (const s of seams) {
      expect(s.sideA.runs.length).toBeGreaterThan(0);
      expect(s.sideB.runs.length).toBeGreaterThan(0);
      for (const run of [...s.sideA.runs, ...s.sideB.runs]) {
        expect(run.edgePointIds.length).toBeGreaterThan(0);
      }
    }
    /* And at least one side is COMPOUND — the thing v1 could not say. */
    expect(seams.some((s) => s.sideA.runs.length > 1 || s.sideB.runs.length > 1)).toBe(true);
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
    for (const s of doc.seams) {
      const a = editorDoc.sideLength(s.sideA, doc.pieces).totalMm;
      const b = editorDoc.sideLength(s.sideB, doc.pieces).totalMm;
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

});

/* ═══ 10 · COMPOUND SEAM SIDES ════════════════════════════════════════════ */

describe("a seam side is an ordered list of runs", () => {
  const runOn = (doc, i, at, count) => {
    const p = doc.pieces[i];
    return {
      pieceId: p.pieceId,
      edgePointIds: Array.from({ length: count },
        (_, k) => p.points[(at + k) % p.points.length].pointId),
      reversed: false,
      role: "",
      provenance: "authored",
      notchIds: [],
    };
  };

  const seamOf = (a, b, over = {}) => ({
    seamId: "s1", name: "A seam",
    sideA: { runs: a, reversed: false },
    sideB: { runs: b, reversed: false },
    alignment: "start-to-start", confidence: "needs-checking",
    easeMm: null, easePercent: null, note: "",
    ...over,
  });

  test("ONE RUN PER SIDE STILL WORKS", async () => {
    const w = await world();
    const parent = await imported(w);
    const doc = (await documentOf(w, parent.id)).editorDocument;
    doc.seams = [seamOf([runOn(doc, 0, 0, 2)], [runOn(doc, 1, 0, 2)])];
    const saved = await patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: doc, name: "One run a side", actor: w.actor,
    });
    const back = (await documentOf(w, saved.revision.id)).editorDocument;
    expect(back.seams[0].sideA.runs).toHaveLength(1);
    expect(back.seams[0].sideB.runs).toHaveLength(1);
  });

  test("SEVERAL RUNS ON ONE PIECE ARE KEPT IN ORDER", async () => {
    const w = await world();
    const parent = await imported(w);
    const doc = (await documentOf(w, parent.id)).editorDocument;
    const first = runOn(doc, 0, 0, 2);
    const second = runOn(doc, 0, 4, 2);
    doc.seams = [seamOf([first, second], [runOn(doc, 1, 0, 4)])];
    const saved = await patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: doc, name: "Two runs one piece", actor: w.actor,
    });
    const back = (await documentOf(w, saved.revision.id)).editorDocument;
    expect(back.seams[0].sideA.runs.map((r) => r.edgePointIds))
      .toEqual([first.edgePointIds, second.edgePointIds]);
  });

  test("RUNS ON DIFFERENT PIECES ARE NOT REFUSED FOR BEING APART IN 2D", async () => {
    /* A front and a back sit apart on a marker. The order is the order a
       machinist sews them, not a claim about where they lie. */
    const w = await world();
    const parent = await imported(w);
    const doc = (await documentOf(w, parent.id)).editorDocument;
    doc.seams = [seamOf(
      [runOn(doc, 0, 0, 2), runOn(doc, 1, 0, 2)],
      [runOn(doc, 2, 0, 2)],
    )];
    const saved = await patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: doc, name: "Front and back to one cap", actor: w.actor,
    });
    const back = (await documentOf(w, saved.revision.id)).editorDocument;
    const pieces = back.seams[0].sideA.runs.map((r) => r.pieceId);
    expect(new Set(pieces).size).toBe(2);
  });

  test("the saved ORDER is authoritative and survives a reload", async () => {
    const w = await world();
    const parent = await imported(w);
    const doc = (await documentOf(w, parent.id)).editorDocument;
    const a = runOn(doc, 1, 0, 2);
    const b = runOn(doc, 0, 0, 2);
    doc.seams = [seamOf([a, b], [runOn(doc, 2, 0, 2)])];
    const saved = await patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: doc, name: "Back then front", actor: w.actor,
    });
    const back = (await documentOf(w, saved.revision.id)).editorDocument;
    expect(back.seams[0].sideA.runs[0].pieceId).toBe(a.pieceId);
    expect(back.seams[0].sideA.runs[1].pieceId).toBe(b.pieceId);
  });

  test("a run's own reversal and the side's are both kept", async () => {
    const w = await world();
    const parent = await imported(w);
    const doc = (await documentOf(w, parent.id)).editorDocument;
    const a = { ...runOn(doc, 0, 0, 2), reversed: true };
    doc.seams = [seamOf([a, runOn(doc, 1, 0, 2)], [runOn(doc, 2, 0, 2)],
      { sideA: { runs: [a, runOn(doc, 1, 0, 2)], reversed: true } })];
    const saved = await patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: doc, name: "Reversed", actor: w.actor,
    });
    const back = (await documentOf(w, saved.revision.id)).editorDocument;
    expect(back.seams[0].sideA.reversed).toBe(true);
    expect(back.seams[0].sideA.runs[0].reversed).toBe(true);
  });

  test("REVERSING A SIDE TURNS THE RUN ORDER AND EACH RUN", () => {
    const pieces = [
      { pieceId: "p1", points: [{ pointId: "a", x: 0, y: 0 }, { pointId: "b", x: 10, y: 0 }, { pointId: "c", x: 10, y: 10 }] },
    ];
    const side = { runs: [{ pieceId: "p1", edgePointIds: ["a"] }, { pieceId: "p1", edgePointIds: ["b"] }], reversed: true };
    const ordered = editorDoc.orderedRunsOf(side);
    expect(ordered.map((r) => r.edgePointIds[0])).toEqual(["b", "a"]);
    expect(ordered.every((r) => r.reversed)).toBe(true);
  });

  test("the total length is the sum of the runs, with where each one starts", () => {
    const pieces = [
      { pieceId: "p1", name: "Front", points: [
        { pointId: "a", x: 0, y: 0 }, { pointId: "b", x: 30, y: 0 },
        { pointId: "c", x: 30, y: 40 }, { pointId: "d", x: 0, y: 40 }] },
      { pieceId: "p2", name: "Back", points: [
        { pointId: "e", x: 100, y: 0 }, { pointId: "f", x: 120, y: 0 },
        { pointId: "g", x: 120, y: 10 }, { pointId: "h", x: 100, y: 10 }] },
    ];
    const side = { runs: [
      { pieceId: "p1", edgePointIds: ["a"] },      /* 30 */
      { pieceId: "p2", edgePointIds: ["e"] },      /* 20 */
    ], reversed: false };
    const out = editorDoc.sideLength(side, pieces);
    expect(out.totalMm).toBe(50);
    expect(out.stations).toHaveLength(2);
    expect(out.stations[0]).toMatchObject({ pieceName: "Front", lengthMm: 30, atMm: 0 });
    expect(out.stations[1]).toMatchObject({ pieceName: "Back", lengthMm: 20, atMm: 30 });
  });

  test("the path runs through every run in sewing order", () => {
    const pieces = [
      { pieceId: "p1", points: [{ pointId: "a", x: 0, y: 0 }, { pointId: "b", x: 10, y: 0 }, { pointId: "c", x: 10, y: 5 }] },
    ];
    const path = editorDoc.sidePath({ runs: [{ pieceId: "p1", edgePointIds: ["a", "b"] }] }, pieces);
    expect(path.map((p) => p.pointId)).toEqual(["a", "b", "c"]);
  });

  /* ── WHAT IS REFUSED ─────────────────────────────────────────────────── */

  test("a side with no runs is not a side", async () => {
    const w = await world();
    const parent = await imported(w);
    const doc = (await documentOf(w, parent.id)).editorDocument;
    doc.seams = [seamOf([], [runOn(doc, 1, 0, 2)])];
    const err = await refuses(() => patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: doc, name: "x", actor: w.actor,
    }), "VALIDATION");
    expect(err.message).toMatch(/no runs/);
  });

  test("THE SAME RUN TWICE ON ONE SIDE IS REFUSED", async () => {
    const w = await world();
    const parent = await imported(w);
    const doc = (await documentOf(w, parent.id)).editorDocument;
    const a = runOn(doc, 0, 0, 2);
    doc.seams = [seamOf([a, { ...a }], [runOn(doc, 1, 0, 4)])];
    const err = await refuses(() => patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: doc, name: "x", actor: w.actor,
    }), "VALIDATION");
    expect(err.message).toMatch(/already in this side/);
  });

  test("a run naming a piece that is not in the document is refused", async () => {
    const w = await world();
    const parent = await imported(w);
    const doc = (await documentOf(w, parent.id)).editorDocument;
    doc.seams = [seamOf([{ ...runOn(doc, 0, 0, 2), pieceId: "nope" }], [runOn(doc, 1, 0, 2)])];
    await refuses(() => patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: doc, name: "x", actor: w.actor,
    }), "VALIDATION");
  });

  test("an edge in two seams is refused even across compound sides", async () => {
    const w = await world();
    const parent = await imported(w);
    const doc = (await documentOf(w, parent.id)).editorDocument;
    const shared = runOn(doc, 0, 0, 2);
    doc.seams = [
      seamOf([shared], [runOn(doc, 1, 0, 2)]),
      { ...seamOf([runOn(doc, 2, 0, 2), shared], [runOn(doc, 3, 0, 2)]), seamId: "s2" },
    ];
    const err = await refuses(() => patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: doc, name: "x", actor: w.actor,
    }), "VALIDATION");
    expect(err.message).toMatch(/already sewn into/);
  });
});

/* ═══ 11 · SCHEMA v1 → v2 ═════════════════════════════════════════════════ */

describe("a document saved under schema v1", () => {
  const v1Seam = (doc) => ({
    seamId: "s-old", name: "Left side",
    a: { pieceId: doc.pieces[0].pieceId, edgePointIds: [doc.pieces[0].points[0].pointId], reversed: false, role: "side" },
    b: { pieceId: doc.pieces[1].pieceId, edgePointIds: [doc.pieces[1].points[0].pointId], reversed: true, role: "side" },
    alignment: "start-to-start", confidence: "confirmed", easePercent: 1.2, note: "",
  });

  test("IT STILL OPENS, AND ITS SIDES BECOME ONE-RUN LISTS", async () => {
    const w = await world();
    const parent = await imported(w);
    const doc = (await documentOf(w, parent.id)).editorDocument;
    await PatternRevision.updateOne({ _id: parent.id }, {
      $set: { editorDocument: { ...doc, schemaVersion: 1, seams: [v1Seam(doc)] } },
    });
    const read = await documentOf(w, parent.id);
    expect(read.editorDocumentOrigin).toBe("migrated-v1");
    expect(read.editorDocument.schemaVersion).toBe(editorDoc.EDITOR_SCHEMA_VERSION);
    const seam = read.editorDocument.seams[0];
    expect(seam.sideA.runs).toHaveLength(1);
    expect(seam.sideB.runs).toHaveLength(1);
    expect(seam.sideB.runs[0].reversed).toBe(true);
    expect(seam.alignment).toBe("start-to-start");
    expect(seam.confidence).toBe("confirmed");
  });

  test("NOTHING ABOUT ITS MEANING CHANGES", async () => {
    const w = await world();
    const parent = await imported(w);
    const doc = (await documentOf(w, parent.id)).editorDocument;
    const old = v1Seam(doc);
    await PatternRevision.updateOne({ _id: parent.id }, {
      $set: { editorDocument: { ...doc, schemaVersion: 1, seams: [old] } },
    });
    const seam = (await documentOf(w, parent.id)).editorDocument.seams[0];
    expect(seam.sideA.runs[0].edgePointIds).toEqual(old.a.edgePointIds);
    expect(seam.sideA.runs[0].pieceId).toBe(old.a.pieceId);
    expect(seam.sideB.runs[0].edgePointIds).toEqual(old.b.edgePointIds);
  });

  test("A v1 SEAM MARKED UNSUPPORTED IS REBUILT, NOT DROPPED", async () => {
    /* v1 wrote `unsupported` when a stored side was several runs and it could
       not hold them, emptying the sides. The edges are recoverable from the
       mapping v1 read, and an absent seam looks like a garment with no armhole. */
    const w = await world();
    const parent = await imported(w);
    await patterns.setSimulationInputs(w.ctx, {
      revisionId: parent.id, inputs: tee.simulationInputs(), actor: w.actor,
    });
    const doc = (await documentOf(w, parent.id)).editorDocument;
    const compound = doc.seams.find((s) => s.sideA.runs.length > 1 || s.sideB.runs.length > 1);
    expect(compound).toBeTruthy();

    await PatternRevision.updateOne({ _id: parent.id }, {
      $set: {
        editorDocument: {
          ...doc, schemaVersion: 1,
          seams: [{
            seamId: compound.seamId, name: compound.name, unsupported: true,
            a: { pieceId: "", edgePointIds: [] }, b: { pieceId: "", edgePointIds: [] },
            alignment: compound.alignment, confidence: "needs-checking", note: "carried",
          }],
        },
      },
    });
    const read = await documentOf(w, parent.id);
    const back = read.editorDocument.seams[0];
    expect(back.unsupported).toBeFalsy();
    expect(back.sideA.runs.length + back.sideB.runs.length).toBeGreaterThan(2);
    expect(read.editorDocumentNotes.join(" ")).toMatch(/rebuilt from the mapping it came from/);
  });

  test("a v1 seam whose edges cannot be recovered is kept and still refused", async () => {
    const w = await world();
    const parent = await imported(w);
    const doc = (await documentOf(w, parent.id)).editorDocument;
    await PatternRevision.updateOne({ _id: parent.id }, {
      $set: {
        editorDocument: {
          ...doc, schemaVersion: 1,
          seams: [{
            seamId: "s-lost", name: "Left armhole", unsupported: true,
            a: { pieceId: "", edgePointIds: [] }, b: { pieceId: "", edgePointIds: [] },
            alignment: "", confidence: "needs-checking", note: "carried",
          }],
        },
      },
    });
    const read = await documentOf(w, parent.id);
    expect(read.editorDocument.seams).toHaveLength(1);
    expect(read.editorDocument.seams[0].unsupported).toBe(true);
    expect(read.editorDocumentNotes.join(" ")).toMatch(/not in the document to recover/);
  });

  test("and a migrated document saves as v2", async () => {
    const w = await world();
    const parent = await imported(w);
    const doc = (await documentOf(w, parent.id)).editorDocument;
    await PatternRevision.updateOne({ _id: parent.id }, {
      $set: { editorDocument: { ...doc, schemaVersion: 1, seams: [v1Seam(doc)] } },
    });
    const migrated = (await documentOf(w, parent.id)).editorDocument;
    const saved = await patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: migrated, name: "Migrated", actor: w.actor,
    });
    const row = await PatternRevision.findById(saved.revision.id).lean();
    expect(row.editorDocument.schemaVersion).toBe(2);
    expect(row.editorDocument.seams[0].sideA.runs).toHaveLength(1);
  });
});

/* ═══ 12 · THE LANE A CONTRACT ════════════════════════════════════════════ */

describe("what reaches Lane A", () => {
  /** A mapping confirmed in the editor, from whatever the revision already has. */
  const confirmEverything = (doc) => ({
    ...doc,
    seams: doc.seams.map((s) => ({
      ...s,
      alignment: s.alignment || "start-to-start",
      confidence: "confirmed",
    })),
  });

  test("A COMPOUND SIDE ARRIVES AS AN ORDERED LIST OF RUN REFS", async () => {
    const w = await world();
    const parent = await imported(w);
    await patterns.setSimulationInputs(w.ctx, {
      revisionId: parent.id, inputs: tee.simulationInputs(), actor: w.actor,
    });
    const doc = (await documentOf(w, parent.id)).editorDocument;
    const compound = doc.seams.find((s) => s.sideA.runs.length > 1 || s.sideB.runs.length > 1);
    expect(compound).toBeTruthy();

    const saved = await patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: confirmEverything(doc), name: "Confirmed", actor: w.actor,
    });
    const row = await PatternRevision.findById(saved.revision.id).lean();
    const sent = row.simulationInputs.seams.find((s) => s.seamId === compound.seamId);

    const wider = compound.sideA.runs.length > 1 ? "sideA" : "sideB";
    expect(sent[wider]).toHaveLength(compound[wider].runs.length);
    /* Every ref names a piece and a run, and every run it names exists. */
    const runIds = new Set(row.simulationInputs.pieces
      .flatMap((p) => p.runs.map((r) => `${p.pieceRef}:${r.runId}`)));
    for (const ref of sent[wider]) {
      expect(runIds.has(`${ref.pieceRef}:${ref.runId}`)).toBe(true);
    }
  });

  test("each run carries its own direction, and the side carries the order", async () => {
    const w = await world();
    const parent = await imported(w);
    await patterns.setSimulationInputs(w.ctx, {
      revisionId: parent.id, inputs: tee.simulationInputs(), actor: w.actor,
    });
    const doc = (await documentOf(w, parent.id)).editorDocument;
    const saved = await patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: confirmEverything(doc), name: "x", actor: w.actor,
    });
    const row = await PatternRevision.findById(saved.revision.id).lean();
    const runs = row.simulationInputs.pieces.flatMap((p) => p.runs);
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) {
      expect(["forward", "reverse"]).toContain(r.direction);
      expect(r.startAnchor.kind).toBe("turn-point");
      expect(Number.isInteger(r.startAnchor.pointIndex)).toBe(true);
    }
  });

  test("the confirmation is attributable, which is what R4 asks for", async () => {
    const w = await world();
    const parent = await imported(w);
    await patterns.setSimulationInputs(w.ctx, {
      revisionId: parent.id, inputs: tee.simulationInputs(), actor: w.actor,
    });
    const doc = (await documentOf(w, parent.id)).editorDocument;
    const saved = await patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: confirmEverything(doc), name: "x", actor: w.actor,
    });
    const row = await PatternRevision.findById(saved.revision.id).lean();
    for (const s of row.simulationInputs.seams) {
      expect(s.confidence).toBe("confirmed");
      expect(s.alignmentConfirmed?.by?.name).toBe(w.actor.name);
      expect(s.alignmentConfirmed?.at).toBeTruthy();
    }
  });

  test("R11 IS GONE ONCE THE MAPPING IS CONFIRMED HERE", async () => {
    /* The blocker. Before compound sides, three of the real T-shirt's seams
       could not be expressed, so the mapping could never be re-confirmed in the
       editor, so every save carried the parent's stamp and readiness refused
       with R11 for ever. */
    const w = await world();
    const parent = await imported(w);
    await patterns.setSimulationInputs(w.ctx, {
      revisionId: parent.id, inputs: tee.simulationInputs(), actor: w.actor,
    });
    const doc = (await documentOf(w, parent.id)).editorDocument;

    /* Before: a mapping nobody has confirmed HERE carries the parent's stamp,
       and readiness refuses with R11 — which is exactly what happened to every
       save while three of the seams could not be expressed at all. */
    const unconfirmed = await patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, name: "Not confirmed", actor: w.actor,
      document: { ...doc, seams: doc.seams.map((s) => ({ ...s, confidence: "needs-checking" })) },
    });
    expect(unconfirmed.revision.readiness.failures.map((f) => f.code)).toContain("R11");

    /* After: confirmed here, stamped here, and R11 is not among the failures. */
    const after = await patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: confirmEverything(doc), name: "Confirmed", actor: w.actor,
    });
    const codes = after.revision.readiness.failures.map((f) => f.code);
    expect(codes).not.toContain("R11");
    expect(after.revision.mappingConfirmedAgainstRef).toBe(after.revision.revisionRef);
  });

  test("and no edge is lost on the way through", async () => {
    const w = await world();
    const parent = await imported(w);
    await patterns.setSimulationInputs(w.ctx, {
      revisionId: parent.id, inputs: tee.simulationInputs(), actor: w.actor,
    });
    const doc = (await documentOf(w, parent.id)).editorDocument;
    const before = doc.seams.reduce((n, s) =>
      n + s.sideA.runs.reduce((m, r) => m + r.edgePointIds.length, 0)
        + s.sideB.runs.reduce((m, r) => m + r.edgePointIds.length, 0), 0);

    const saved = await patterns.saveEditorRevision(w.ctx, {
      revisionId: parent.id, document: confirmEverything(doc), name: "x", actor: w.actor,
    });
    const back = (await documentOf(w, saved.revision.id)).editorDocument;
    const after = back.seams.reduce((n, s) =>
      n + s.sideA.runs.reduce((m, r) => m + r.edgePointIds.length, 0)
        + s.sideB.runs.reduce((m, r) => m + r.edgePointIds.length, 0), 0);
    expect(after).toBe(before);
  });
});
