// test/costing/approved-technical-source.test.js
//
// PHASE 2 — NO R&D VALUE REACHES A COSTING EXCEPT THROUGH AN IE-APPROVED VERSION.
//
// ── THE AUTHORITY CHAIN ─────────────────────────────────────────────────────
// Merchandising owns SELECTION. R&D owns the technical PROPOSAL. IE CONFIRMS
// the R&D-derived manufacturing facts by approving the exact frozen revision it
// reviewed. Store owns the COMMERCIAL rate. Central Costing calculates and
// decides none of them.
//
// ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
// `technicalSource.service.js` read `approvedRevisionOf(style.techSheet)`
// directly and, where that carried no route, fell back to
// `style.sample.operations`. So R&D could move a number into a price with
// nobody confirming it, and a style whose approved revision had no route was
// costed from a sample run nobody engineered.
//
// ── THE UNIT UNDER TEST ─────────────────────────────────────────────────────
// `approvedTechnicalSource.bindFor` — the one bound read. It either returns
// BOUND with every identity proved, or a NAMED state with the department that
// can resolve it. It never substitutes a live record, a zero or an empty list.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const mongoose = require("mongoose");

const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const IeStyleFile = require("../../models/CMS_Models/IndustrialEngineering/IeStyleFile");
const IeBulletinVersion = require("../../models/CMS_Models/IndustrialEngineering/IeBulletinVersion");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");

const bind = require("../../services/centralCosting/approvedTechnicalSource.service");
const { technicalRevisionKeyOf } = require("../../services/industrialEngineering/ieBulletinVersion.service");

const { BINDING_STATE: S, SELECTION_FORM } = bind;
let seq = 0;

/* ══ FIXTURES — the records each desk actually keeps ══════════════════════ */

const RAW_A = () => new mongoose.Types.ObjectId();

/** R&D's frozen approved revision. */
function rndRevision({ revision = 3, decidedAt = "2026-08-05", materials = [] } = {}) {
  return {
    revision,
    submittedAt: new Date("2026-08-01"),
    outcome: "approved",
    decidedAt: new Date(decidedAt),
    snapshot: { revision, materials, requirements: [], operations: [] },
  };
}

/**
 * A company, a journey, an enquiry and a style whose BOM Merchandising has
 * approved and whose technical record R&D has approved.
 */
async function world(name, {
  bomStatus = "approved",
  rawItemIds = null,
  revisions = null,
} = {}) {
  const n = ++seq;
  const co = await Acc_Company.create({ companyName: `${name} ${n}`, booksFromDate: new Date("2026-04-01") });
  const accountId = new mongoose.Types.ObjectId();
  const journey = await SalesJourney.create({
    journeyId: `SJ-${name}-${n}`, companyId: co._id, accountId,
    ownerId: new mongoose.Types.ObjectId(), ownerName: "Owner", name: `J ${name}`, isActive: true,
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-${name}-${n}`, journeyId: journey._id, accountId, companyId: co._id,
    title: `E ${name}`, isActive: true, products: [{ product: "Tee", quantity: 500 }],
  });

  const ids = rawItemIds || [RAW_A()];
  const materials = ids.map((id) => ({
    rawItemId: String(id), rawItemName: "Fabric A",
    consumptionPerPiece: 1.4, allowancePercent: 5, unit: "m",
  }));
  const revs = revisions || [rndRevision({ materials })];

  const style = await SampleStyle.create({
    sampleStyleId: `SS-${name}-${n}`, productName: `Tee ${name}`, styleCode: `ST-${name}`,
    variantLabel: "Navy", journeyId: journey._id, enquiryId: enquiry._id,
    materials: {
      status: "selected",
      rawItems: ids.map((id) => ({ rawItemId: id, rawItemName: "Fabric A", quantity: 1.4, unit: "m" })),
    },
    /* Top-level on SampleStyle, beside `materials` — this is the emailed
       Merchandising/PM decision, and `round` is its rotating identity. */
    bomApproval: {
      status: bomStatus, round: 2,
      decidedAt: new Date("2026-08-04"),
      decidedByName: "Merch Lead", decidedByEmail: "merch@grav.test",
    },
    techSheet: {
      technical: {
        status: revs.some((r) => r.outcome === "approved") ? "approved" : "draft",
        revision: revs.length ? revs[revs.length - 1].revision : 0,
      },
      technicalRevisions: revs,
    },
  });
  return { co, journey, enquiry, style, rawItemIds: ids, revisions: revs };
}

/** The engineering file, and a bulletin version in whatever state is wanted. */
async function engineering(w, {
  state = "APPROVED",
  pointAtIt = true,
  confirms = null,
  styleIdOverride = null,
  rows = [{ operationCode: "SEW-1", standardTimeMinutes: 1.25 }],
} = {}) {
  const rev = confirms || w.revisions.find((r) => r.outcome === "approved");
  const file = await IeStyleFile.create({
    companyId: w.co._id, sampleStyleId: w.style._id, openedFromOrderId: null,
    source: {
      technicalRevision: rev.revision, submittedAt: rev.submittedAt,
      approvedAt: rev.decidedAt, snapshot: rev.snapshot, operationCount: 0,
    },
    status: "DRAFT", revision: 1, bulletin: { rows: [] },
  });
  const version = await IeBulletinVersion.create({
    companyId: w.co._id, ieStyleFileId: file._id,
    sampleStyleId: styleIdOverride || w.style._id,
    versionNo: 1, state, revision: 1, fileRevisionAtSubmit: 1,
    rows: rows.map((r, i) => ({
      rowId: `r${i + 1}`, sequence: i + 1,
      ieOperationId: new mongoose.Types.ObjectId(), ieOperationRevision: 1,
      operationCode: r.operationCode, operationName: r.operationCode, machineType: "SNLS",
      proposedSamMinutes: r.standardTimeMinutes, standardTimeMinutes: r.standardTimeMinutes,
    })),
    totals: { garmentSamMinutes: rows.reduce((a, r) => a + (r.standardTimeMinutes || 0), 0), samRowCount: rows.length },
    sourceFingerprint: "fp", sourceApprovalDigest: "ad", sourceRequirementDigest: "rd",
    technicalSource: {
      sampleStyleId: styleIdOverride || w.style._id,
      technicalRevision: rev.revision,
      technicalRevisionKey: technicalRevisionKeyOf({
        revision: rev.revision, submittedAt: rev.submittedAt,
        decidedAt: rev.decidedAt, outcome: "approved",
      }),
      submittedAt: rev.submittedAt, approvedAt: rev.decidedAt,
      snapshot: rev.snapshot,
      materialCount: (rev.snapshot.materials || []).length, operationCount: 0,
      fileSourceRevision: rev.revision, frozenAt: new Date(),
    },
    submittedBy: new mongoose.Types.ObjectId(), submittedByName: "Maker",
    submittedAt: new Date("2026-08-10"),
    ...(state === "APPROVED"
      ? { approvedBy: new mongoose.Types.ObjectId(), approvedByName: "Checker", approvedAt: new Date("2026-08-11") }
      : {}),
  });
  if (pointAtIt && state === "APPROVED") {
    await IeStyleFile.updateOne(
      { _id: file._id },
      { $set: { currentApprovedBulletinVersionId: version._id, currentApprovedVersionNo: 1 } },
    );
  }
  return { file, version };
}

const ctxOf = (w) => ({ companyId: w.co._id });

/* ═══ 1 · NOTHING IS COSTABLE WITHOUT AN IE APPROVAL ═══════════════════════ */

describe("the IE gate", () => {
  test("no engineering file at all: awaiting IE, owned by IE", async () => {
    const w = await world("NoFile");
    const out = await bind.bindFor(ctxOf(w), { styleId: w.style._id });

    expect(out.state).toBe(S.AWAITING_IE_TECHNICAL_CONFIRMATION);
    expect(out.bound).toBe(false);
    expect(out.owner.departmentSlug).toBe("ie");
    /* ── R&D IS NOT THE OWNER OF THIS WAIT ─────────────────────────────
       R&D has done its part: the revision is approved and submitted into the
       IE chain. Naming R&D here would send somebody to a desk with nothing
       left to do. */
    expect(out.owner.department).not.toMatch(/R&D/);
    /* And nothing was substituted. */
    expect(out.technical).toBeNull();
  });

  test("R&D has submitted nothing: awaiting R&D, and only then", async () => {
    const w = await world("NoRnd", { revisions: [{ ...rndRevision(), outcome: "submitted" }] });
    const out = await bind.bindFor(ctxOf(w), { styleId: w.style._id });
    expect(out.state).toBe(S.AWAITING_RND_TECHNICAL_SUBMISSION);
    expect(out.owner.departmentSlug).toBe("research-development");
  });

  for (const state of ["IN_REVIEW", "RETURNED", "SUPERSEDED"]) {
    test(`a ${state} version cannot feed a costing`, async () => {
      /* Only the version the FILE POINTS AT, and only when approved. "The
         latest approved" is a query; the pointer is a decision two people
         took. */
      const w = await world(`State${state}`);
      await engineering(w, { state, pointAtIt: false });

      const out = await bind.bindFor(ctxOf(w), { styleId: w.style._id });
      expect(out.state).toBe(S.AWAITING_IE_TECHNICAL_CONFIRMATION);
      expect(out.technical).toBeNull();
    });
  }

  test("an APPROVED version the file does not point at is not the standard", async () => {
    const w = await world("Unpointed");
    await engineering(w, { state: "APPROVED", pointAtIt: false });
    const out = await bind.bindFor(ctxOf(w), { styleId: w.style._id });
    expect(out.state).toBe(S.AWAITING_IE_TECHNICAL_CONFIRMATION);
  });

  test("a version approved before the frozen source existed confirms nothing", async () => {
    /* Absent is not revision 0. A legacy version carries no `technicalSource`
       and must not become a licence to read R&D. */
    const w = await world("Legacy");
    const { file } = await engineering(w, { pointAtIt: false });

    /* ── WHY THIS IS INSERTED BENEATH THE MODEL ────────────────────────
       `technicalSource` is in no transition allowlist, so the immutability
       guard REFUSES to unset it on an existing version — which is the guard
       working. A genuinely legacy document is one that never had the field,
       so it is written the only way one can exist: directly, as it would have
       been before the field was added. */
    const legacyId = new mongoose.Types.ObjectId();
    await IeBulletinVersion.collection.insertOne({
      _id: legacyId, companyId: w.co._id, ieStyleFileId: file._id,
      sampleStyleId: w.style._id, versionNo: 9, state: "APPROVED", revision: 1,
      fileRevisionAtSubmit: 1, rows: [], totals: { garmentSamMinutes: 1, samRowCount: 0 },
      sourceFingerprint: "fp", sourceApprovalDigest: "ad", sourceRequirementDigest: "",
      submittedBy: new mongoose.Types.ObjectId(), submittedAt: new Date(),
      approvedBy: new mongoose.Types.ObjectId(), approvedAt: new Date(),
      history: [], createdAt: new Date(), updatedAt: new Date(),
    });
    await IeStyleFile.updateOne(
      { _id: file._id },
      { $set: { currentApprovedBulletinVersionId: legacyId, currentApprovedVersionNo: 9 } },
    );

    const out = await bind.bindFor(ctxOf(w), { styleId: w.style._id });
    expect(out.state).toBe(S.AWAITING_IE_TECHNICAL_CONFIRMATION);
    expect(out.reason).toBe("NO_FROZEN_TECHNICAL_SOURCE");
    expect(out.technical).toBeNull();
  });
});

/* ═══ 2 · THE APPROVED SNAPSHOT WINS OVER THE LIVE RECORD ══════════════════ */

describe("what is actually read", () => {
  test("a fully aligned source set binds, and publishes the approved facts", async () => {
    const w = await world("Aligned");
    const { file, version } = await engineering(w);

    const out = await bind.bindFor(ctxOf(w), { styleId: w.style._id });
    expect(out.state).toBe(S.BOUND);
    expect(out.bound).toBe(true);

    /* Every identity a costing must freeze. */
    expect(out.technical.ieStyleFileId).toBe(String(file._id));
    expect(out.technical.bulletinVersionId).toBe(String(version._id));
    expect(out.technical.bulletinVersionNo).toBe(1);
    expect(out.technical.technicalRevision).toBe(3);
    expect(out.technical.technicalRevisionKey).toMatch(/^[0-9a-f]{32}$/);

    /* Consumption from the CONFIRMED snapshot. */
    expect(out.technical.materials[0].consumptionPerPiece).toBe(1.4);
    expect(out.technical.materials[0].allowancePercent).toBe(5);

    /* Route and SAM from IE's own rows. */
    expect(out.technical.operations).toHaveLength(1);
    expect(out.technical.operations[0].standardTimeMinutes).toBe(1.25);
    expect(out.technical.garmentSamMinutes).toBe(1.25);

    /* And Merchandising's selection, in the form that applies. */
    expect(out.selection.form).toBe(SELECTION_FORM.BOM_APPROVAL);
    expect(out.selection.bomApprovalRound).toBe(2);
    expect(out.selection.materialsCompared).toBe(true);
  });

  test("the approved snapshot is used even after live R&D changes underneath", async () => {
    /* ── THE WHOLE POINT ───────────────────────────────────────────────
       R&D edits its live record. Until IE confirms the new revision, the
       costing reads what was confirmed — and says so. */
    const w = await world("LiveMoves");
    await engineering(w);

    await SampleStyle.updateOne(
      { _id: w.style._id },
      { $set: { "techSheet.technicalRevisions.0.snapshot.materials.0.consumptionPerPiece": 9.9 } },
    );

    const out = await bind.bindFor(ctxOf(w), { styleId: w.style._id });
    expect(out.state).toBe(S.BOUND);
    expect(out.technical.materials[0].consumptionPerPiece).toBe(1.4);
    expect(JSON.stringify(out.technical)).not.toMatch(/9\.9/);
  });

  test("a NEWER approved R&D revision makes the confirmation stale, and blocks", async () => {
    const w = await world("Stale");
    await engineering(w);

    await SampleStyle.updateOne(
      { _id: w.style._id },
      {
        $push: { "techSheet.technicalRevisions": rndRevision({ revision: 4, decidedAt: "2026-09-01" }) },
        $set: { "techSheet.technical.revision": 4 },
      },
    );

    const out = await bind.bindFor(ctxOf(w), { styleId: w.style._id });
    expect(out.state).toBe(S.IE_TECHNICAL_APPROVAL_STALE);
    expect(out.confirmedRevision).toBe(3);
    expect(out.currentRevision).toBe(4);
    expect(out.owner.departmentSlug).toBe("ie");
    expect(out.technical).toBeNull();
  });

  test("a revision re-approved under the SAME number is still a different decision", async () => {
    /* The number is R&D's counter, not an identity. The key catches it. */
    const w = await world("SameNumber");
    await engineering(w);

    await SampleStyle.updateOne(
      { _id: w.style._id },
      { $set: { "techSheet.technicalRevisions.0.decidedAt": new Date("2026-09-20") } },
    );

    const out = await bind.bindFor(ctxOf(w), { styleId: w.style._id });
    expect(out.state).toBe(S.IE_TECHNICAL_APPROVAL_STALE);
    expect(out.confirmedRevision).toBe(3);
    expect(out.currentRevision).toBe(3);
  });

  test("absent stays absent — nothing missing becomes zero or an empty list", async () => {
    /* ── EACH FAMILY IS UNKNOWN AT ITS OWN OWNER'S RECORD ─────────────
       This asserted `technical.packaging` and `technical.shipment` were null.
       Both were read off the frozen snapshot, which has never carried either,
       so "null" was being produced by a key that simply did not exist — the
       assertion passed for the wrong reason and hid the fact that no real
       style ever had packaging or a packed weight.

       They are not part of the technical basis at all now, so what has to stay
       absent is each OWNER's answer. An empty list would be a claim ("this
       style needs no packaging") that nobody made. */
    const w = await world("Nulls", { revisions: [rndRevision({ materials: [] })] });
    await engineering(w);

    const out = await bind.bindFor(ctxOf(w), { styleId: w.style._id });
    expect(out.state).toBe(S.BOUND);

    /* Not on the technical basis — and not silently null there either. */
    expect(out.technical.packaging).toBeUndefined();
    expect(out.technical.shipment).toBeUndefined();

    /* Merchandising has approved no packaging, and the state says whose it is. */
    expect(out.packagingSource.rows).toBeNull();
    expect(out.packagingSource.state).toBe(bind.FAMILY_STATE.AWAITING_MERCHANDISING_PACKAGING);

    /* Neither packing fact is recorded, and null is not zero. */
    expect(out.packingFacts.packedWeightGrams).toBeNull();
    expect(out.packingFacts.garmentsPerCarton).toBeNull();
    expect(out.packingFacts.gaps).toEqual(expect.arrayContaining([
      bind.FAMILY_STATE.AWAITING_RND_PACKING_MEASUREMENT,
      bind.FAMILY_STATE.AWAITING_MERCHANDISING_PACK_CONFIGURATION,
    ]));

    /* The revision froze an empty requirements list, so "none of this family"
       is a real answer and reads as one — which is a different statement from
       the null above, and the difference is the whole point. */
    expect(out.technical.services).toEqual([]);
    expect(out.technical.development).toEqual([]);
    /* And the empty material list the snapshot DID carry stays an empty list. */
    expect(out.technical.materials).toEqual([]);
  });

  test("an approved version cannot carry an untimed operation at all", async () => {
    /* ── A STRONGER GUARANTEE THAN "NULL STAYS NULL" ───────────────────
       `standardTimeMinutes` is REQUIRED on a frozen row, and IE's own gates
       refuse to submit a row without an approved method study. So a costing
       can never meet an untimed operation in an approved version — the
       question is answered before it reaches here. */
    const w = await world("Untimed");
    await expect(engineering(w, {
      rows: [{ operationCode: "SEW-1", standardTimeMinutes: null }],
    })).rejects.toThrow(/standardTimeMinutes/);
  });
});

/* ═══ 3 · MERCHANDISING OWNS SELECTION ═════════════════════════════════════ */

describe("the Merchandising gate", () => {
  test("an unapproved BOM blocks costing, owned by Merchandising", async () => {
    const w = await world("NoBom", { bomStatus: "pending" });
    await engineering(w);

    const out = await bind.bindFor(ctxOf(w), { styleId: w.style._id });
    expect(out.state).toBe(S.AWAITING_MERCHANDISING_SELECTION);
    expect(out.owner.departmentSlug).toBe("merchandiser");
    expect(out.technical).toBeNull();
    expect(out.selection).toBeNull();
  });

  test("a confirmed material outside the approved selection is a named mismatch", async () => {
    /* Neither record is overruled and neither is silently preferred: they
       disagree about what the garment is made of, and Merchandising owns that
       question. */
    const selected = RAW_A();
    const w = await world("Mismatch", { rawItemIds: [selected] });
    const other = RAW_A();
    await SampleStyle.updateOne(
      { _id: w.style._id },
      { $set: { "techSheet.technicalRevisions.0.snapshot.materials.0.rawItemId": String(other) } },
    );
    const fresh = await SampleStyle.findById(w.style._id).lean();
    await engineering({ ...w, revisions: fresh.techSheet.technicalRevisions });

    const out = await bind.bindFor(ctxOf(w), { styleId: w.style._id });
    expect(out.state).toBe(S.SELECTION_MISMATCH);
    expect(out.owner.departmentSlug).toBe("merchandiser");
    expect(out.unselectedMaterialIds).toEqual([String(other)]);
    expect(out.technical).toBeNull();
  });
});

/* ═══ 4 · IDENTITY, AND THE REFUSAL THAT REVEALS NOTHING ═══════════════════ */

describe("exact identity binding", () => {
  test("another company cannot bind this style", async () => {
    const mine = await world("Mine");
    const theirs = await world("Theirs");
    await engineering(mine);

    const out = await bind.bindFor({ companyId: theirs.co._id }, { styleId: mine.style._id });
    expect(out.state).toBe(S.TECHNICAL_SOURCE_MISMATCH);
    expect(out.technical).toBeNull();
  });

  test("a version recorded against another style is refused, not followed", async () => {
    const w = await world("WrongStyle");
    const other = await world("OtherStyle");
    await engineering(w, { styleIdOverride: other.style._id });

    const out = await bind.bindFor(ctxOf(w), { styleId: w.style._id });
    expect(out.state).toBe(S.TECHNICAL_SOURCE_MISMATCH);
    expect(out.technical).toBeNull();
  });

  test("a version whose own style field disagrees is refused, even inside the right file", async () => {
    /* ── THE CASE `approvedStandard` CANNOT SEE ────────────────────────
       It proves style → file → pointer → version-belongs-to-file → number.
       It does NOT read the version's own `sampleStyleId`. A version sitting in
       the right file while claiming another style is a data inconsistency, and
       this is the layer that catches it. Only the version's own field is moved
       here — the frozen source still names the right style — so the check is
       isolated rather than shadowed by the one after it. */
    const w = await world("FieldDisagrees");
    const other = await world("Neighbour");
    const { version } = await engineering(w);
    await IeBulletinVersion.collection.updateOne(
      { _id: version._id }, { $set: { sampleStyleId: other.style._id } },
    );

    const out = await bind.bindFor(ctxOf(w), { styleId: w.style._id });
    expect(out.state).toBe(S.TECHNICAL_SOURCE_MISMATCH);
    expect(out.technical).toBeNull();
  });

  test("an absent or malformed style is refused the same way a foreign one is", async () => {
    const w = await world("Absent");
    const foreign = await world("Foreign");
    const a = await bind.bindFor(ctxOf(w), { styleId: new mongoose.Types.ObjectId() });
    const b = await bind.bindFor(ctxOf(w), { styleId: "not-an-id" });
    const c = await bind.bindFor(ctxOf(w), { styleId: foreign.style._id });
    for (const out of [a, b, c]) expect(out.state).toBe(S.TECHNICAL_SOURCE_MISMATCH);
  });
});

/* ═══ 5 · THE FINGERPRINT CARRIES EVERY AUTHORITY ══════════════════════════ */

describe("staleness", () => {
  const fingerprint = require("../../services/centralCosting/sourceFingerprint.service");

  const partsFor = (binding) => fingerprint.partsFor({
    brief: null, preview: { approvedSource: binding }, assembled: null, policy: {},
  });

  test("the IE and Merchandising identities are in the fingerprint", async () => {
    const w = await world("Fingerprint");
    await engineering(w);
    const bound = await bind.bindFor(ctxOf(w), { styleId: w.style._id });

    const keys = partsFor(bound).map((p) => p.key);
    expect(keys).toEqual(expect.arrayContaining([
      "ie:file", "ie:version", "ie:technicalRevision", "merch:selection",
    ]));
  });

  test("no part carries a consumption, a rate or a SAM", async () => {
    /* A token that can be COMPARED and cannot be READ BACK as a figure. */
    const w = await world("NoFigures");
    await engineering(w);
    const bound = await bind.bindFor(ctxOf(w), { styleId: w.style._id });

    const tokens = partsFor(bound).map((p) => JSON.stringify(p));
    for (const t of tokens) {
      expect(t).not.toMatch(/1\.4\b/);
      expect(t).not.toMatch(/1\.25\b/);
    }
  });

  test("a new IE version changes the fingerprint", async () => {
    const w = await world("NewVersion");
    await engineering(w);
    const before = fingerprint.hashOf(partsFor(await bind.bindFor(ctxOf(w), { styleId: w.style._id })));

    /* IE approves a replacement for the same revision. */
    const file = await IeStyleFile.findOne({ sampleStyleId: w.style._id }).lean();
    const rev = w.revisions[0];
    const v2 = await IeBulletinVersion.create({
      companyId: w.co._id, ieStyleFileId: file._id, sampleStyleId: w.style._id,
      versionNo: 2, state: "APPROVED", revision: 1, fileRevisionAtSubmit: 1,
      rows: [], totals: { garmentSamMinutes: 2, samRowCount: 1 },
      sourceFingerprint: "fp2", sourceApprovalDigest: "ad2", sourceRequirementDigest: "rd2",
      technicalSource: {
        sampleStyleId: w.style._id, technicalRevision: rev.revision,
        technicalRevisionKey: technicalRevisionKeyOf({
          revision: rev.revision, submittedAt: rev.submittedAt,
          decidedAt: rev.decidedAt, outcome: "approved",
        }),
        snapshot: rev.snapshot, materialCount: 1, operationCount: 0,
        fileSourceRevision: rev.revision, frozenAt: new Date(),
      },
      submittedBy: new mongoose.Types.ObjectId(), submittedAt: new Date(),
      approvedBy: new mongoose.Types.ObjectId(), approvedAt: new Date(),
    });
    await IeStyleFile.updateOne(
      { _id: file._id },
      { $set: { currentApprovedBulletinVersionId: v2._id, currentApprovedVersionNo: 2 } },
    );

    const after = fingerprint.hashOf(partsFor(await bind.bindFor(ctxOf(w), { styleId: w.style._id })));
    expect(after).not.toBe(before);
  });

  test("a new Merchandising approval changes the fingerprint", async () => {
    const w = await world("NewSelection");
    await engineering(w);
    const before = fingerprint.hashOf(partsFor(await bind.bindFor(ctxOf(w), { styleId: w.style._id })));

    await SampleStyle.updateOne(
      { _id: w.style._id },
      {
        $set: {
          "bomApproval.round": 3,
          "bomApproval.decidedAt": new Date("2026-09-10"),
        },
      },
    );

    const after = fingerprint.hashOf(partsFor(await bind.bindFor(ctxOf(w), { styleId: w.style._id })));
    expect(after).not.toBe(before);
  });

  test("nothing moving means nothing changes", async () => {
    const w = await world("Stable");
    await engineering(w);
    const a = fingerprint.hashOf(partsFor(await bind.bindFor(ctxOf(w), { styleId: w.style._id })));
    const b = fingerprint.hashOf(partsFor(await bind.bindFor(ctxOf(w), { styleId: w.style._id })));
    expect(a).toBe(b);
  });
});

/* ═══ INDEPENDENTLY OWNED SOURCES, INDEPENDENTLY STALED ═══════════════════ */

describe("each source stales only its own binding", () => {
  const fingerprint = require("../../services/centralCosting/sourceFingerprint.service");
  const partsFor = (binding) => fingerprint.partsFor({
    brief: null, preview: { approvedSource: binding }, assembled: null, policy: {},
  });
  const tokenOf = (binding, key) =>
    (partsFor(binding).find((p) => p.key === key) || {}).token ?? null;

  /* Merchandising's approved packaging, R&D's approved weighing and
     Merchandising's approved pack-out, on a style IE has already confirmed. */
  const withPackingSources = async (w) => {
    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: {
        "materials.packagingSelections": [{
          rowId: "sel-1", rawItemId: RAW_A(), rawItemName: "Poly Bag",
          rawItemSku: "PKG-1", specification: "Printed poly bag, 300x400mm",
          status: "approved", selectedAt: new Date("2026-07-10"),
        }],
        "materials.packagingDecision": {
          required: true, reason: "",
          decidedBy: { id: new mongoose.Types.ObjectId(), name: "Merch Lead" },
          decidedAt: new Date("2026-07-10"),
        },
        "materials.packingConfiguration": {
          revision: 1, garmentsPerCarton: 40,
          decidedBy: { id: new mongoose.Types.ObjectId(), name: "Merch Lead" },
          decidedAt: new Date("2026-07-11"),
        },
        "sample.packagingRequirements": [{
          rowId: "req-1", sourceSelectionRowId: "sel-1",
          quantity: 1, unit: "Piece", basis: "PER_GARMENT", evidence: "SAMPLE_MEASURED",
        }],
        "sample.packingMeasurement": {
          revision: 1, packedWeightGrams: 420,
          measuredAt: new Date("2026-07-20"),
          approvedBy: { id: new mongoose.Types.ObjectId(), name: "R&D Checker" },
          approvedAt: new Date("2026-07-21"),
        },
      },
    });
  };

  test("all four owners appear as separate parts", async () => {
    /* ── WHY SEPARATE PARTS AND NOT ONE HASH ──────────────────────────
       A style whose carton capacity changed has not had its route revised.
       One part per owned fact is what lets the freeze say which desk moved. */
    const w = await world("FourOwners");
    await engineering(w);
    await withPackingSources(w);
    const bound = await bind.bindFor(ctxOf(w), { styleId: w.style._id });
    expect(bound.state).toBe(S.BOUND);

    expect(partsFor(bound).map((p) => p.key)).toEqual(expect.arrayContaining([
      "ie:version", "ie:technicalRevision", "merch:selection",
      "merch:packaging", "merch:packConfiguration", "rnd:packingMeasurement",
    ]));
  });

  test("a re-weighed garment stales the packed weight and nothing else", async () => {
    const w = await world("Reweigh");
    await engineering(w);
    await withPackingSources(w);
    const before = await bind.bindFor(ctxOf(w), { styleId: w.style._id });

    /* R&D weighs it again and a second person approves that — revision 2. */
    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: {
        "sample.packingMeasurement": {
          revision: 2, packedWeightGrams: 455,
          measuredAt: new Date("2026-08-02"),
          approvedBy: { id: new mongoose.Types.ObjectId(), name: "R&D Checker" },
          approvedAt: new Date("2026-08-03"),
        },
      },
    });
    const after = await bind.bindFor(ctxOf(w), { styleId: w.style._id });

    /* The one part that moved. */
    expect(tokenOf(after, "rnd:packingMeasurement"))
      .not.toBe(tokenOf(before, "rnd:packingMeasurement"));
    /* And every other owner's identity is untouched — the route was not
       re-approved and the buyer did not change the packing. */
    for (const key of ["ie:file", "ie:version", "ie:technicalRevision",
      "merch:selection", "merch:packaging", "merch:packConfiguration"]) {
      expect(tokenOf(after, key)).toBe(tokenOf(before, key));
    }
    /* Still bound: a new approved weighing is not a broken authority. */
    expect(after.state).toBe(S.BOUND);
    expect(after.packingFacts.packedWeightGrams).toBe(455);
  });

  test("a new pack-out stales the carton capacity and nothing else", async () => {
    const w = await world("Repack");
    await engineering(w);
    await withPackingSources(w);
    const before = await bind.bindFor(ctxOf(w), { styleId: w.style._id });

    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: {
        "materials.packingConfiguration": {
          revision: 2, garmentsPerCarton: 30,
          decidedBy: { id: new mongoose.Types.ObjectId(), name: "Merch Lead" },
          decidedAt: new Date("2026-08-05"),
        },
      },
    });
    const after = await bind.bindFor(ctxOf(w), { styleId: w.style._id });

    expect(tokenOf(after, "merch:packConfiguration"))
      .not.toBe(tokenOf(before, "merch:packConfiguration"));
    for (const key of ["ie:version", "ie:technicalRevision", "merch:selection",
      "merch:packaging", "rnd:packingMeasurement"]) {
      expect(tokenOf(after, key)).toBe(tokenOf(before, key));
    }
    expect(after.packingFacts.garmentsPerCarton).toBe(30);
    /* The weight did not move with it. */
    expect(after.packingFacts.packedWeightGrams).toBe(420);
  });

  test("the working shipment note is not a source, however it is edited", async () => {
    /* ── THE WHOLE POINT OF THE SPLIT ─────────────────────────────────
       `sample.shipment` is R&D's scratch record. A costing that read it froze
       a figure anybody could change afterwards with nothing recording it. */
    const w = await world("WorkingNote");
    await engineering(w);
    await withPackingSources(w);
    const before = await bind.bindFor(ctxOf(w), { styleId: w.style._id });

    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: { "sample.shipment": { packedWeightGrams: 9999, garmentsPerCarton: 1 } },
    });
    const after = await bind.bindFor(ctxOf(w), { styleId: w.style._id });

    /* Not one part moved, and not one figure. */
    expect(fingerprint.hashOf(partsFor(after))).toBe(fingerprint.hashOf(partsFor(before)));
    expect(after.packingFacts.packedWeightGrams).toBe(420);
    expect(after.packingFacts.garmentsPerCarton).toBe(40);
  });

  test("an unapproved weighing is not a weight, and is named rather than zeroed", async () => {
    const w = await world("Unapproved");
    await engineering(w);
    await withPackingSources(w);
    /* Measured, not yet approved by anybody. */
    await SampleStyle.updateOne({ _id: w.style._id }, {
      /* One `$set` of the whole sub-document: a `$set` of the object plus an
         `$unset` of a path inside it is a conflicting update, and replacing it
         wholesale is also the truthful shape — this is a new measurement, not
         an edit that removed an approval. */
      $set: {
        "sample.packingMeasurement": {
          revision: 2, packedWeightGrams: 455, measuredAt: new Date("2026-08-02"),
        },
      },
    });
    const after = await bind.bindFor(ctxOf(w), { styleId: w.style._id });

    /* Null, never 0: a garment of no weight ships for nothing. */
    expect(after.packingFacts.packedWeightGrams).toBeNull();
    expect(after.packingFacts.gaps).toContain(bind.FAMILY_STATE.AWAITING_RND_PACKING_MEASUREMENT);
    /* And the garment is still costable — one absent fact blocks one family. */
    expect(after.state).toBe(S.BOUND);
  });

  test("packaging nobody approved is a record, not a cost", async () => {
    const w = await world("Unselected");
    await engineering(w);
    await withPackingSources(w);
    /* R&D measures a second component Merchandising never selected. */
    await SampleStyle.updateOne({ _id: w.style._id }, {
      $push: {
        "sample.packagingRequirements": {
          rowId: "req-2", sourceSelectionRowId: "sel-nope",
          rawItemName: "Hang Tag", quantity: 1, unit: "Piece", basis: "PER_GARMENT",
        },
      },
    });
    const after = await bind.bindFor(ctxOf(w), { styleId: w.style._id });

    expect(after.packagingSource.rows.map((r) => r.rowId)).toEqual(["req-1"]);
    expect(after.packagingSource.unapproved.map((r) => r.rawItemName)).toEqual(["Hang Tag"]);
  });

  test("with no approved packaging at all, the gap names Merchandising", async () => {
    /* ── NEVER AN EMPTY LIST ──────────────────────────────────────────
       `[]` is a claim that the garment is packed in nothing, and only
       Merchandising's applicability decision may make it. */
    const w = await world("NoPackaging");
    await engineering(w);
    const after = await bind.bindFor(ctxOf(w), { styleId: w.style._id });

    expect(after.packagingSource.state).toBe(bind.FAMILY_STATE.AWAITING_MERCHANDISING_PACKAGING);
    expect(after.packagingSource.rows).toBeNull();
    expect(bind.FAMILY_MESSAGE[after.packagingSource.state]).toMatch(/Merchandising/);
  });

  test("the frozen snapshot carries no packaging, services or shipment key", async () => {
    /* ── THE FIXTURE MAY NOT INVENT A SHAPE ───────────────────────────
       `technicalRecord.snapshotOf` is what an R&D submit freezes a revision
       through, and these three keys have never been in it. Binding to them
       read fixture-built styles and nothing else. */
    const technicalRecord = require("../../services/centralCosting/technicalRecord.service");
    const produced = technicalRecord.snapshotOf(
      { revision: 1, materials: [], operations: [], requirements: [] }, null, null,
    );
    expect(Object.keys(produced).sort())
      .toEqual(["file", "materials", "operations", "requirements", "revision"]);
  });
});
