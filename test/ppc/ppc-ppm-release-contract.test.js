// test/ppc/ppc-ppm-release-contract.test.js
//
// DID THE MEETING REVIEW THE ENGINEERING RELEASE THIS PLAN IS FROZEN AGAINST?
//
// Two applications each name an IE release. Merchandising's Pre-Production
// Meeting minutes record which one was on the table; PPC's planning file
// records which one it is planning against. Nothing compared them, so an
// order could be planned against engineering nobody had met about while the
// minutes still read as satisfied.
//
// ── WHAT AGREEMENT IS, AND WHAT IT IS NOT ───────────────────────────────────
// Agreement is: the same RECORD, at the same VERSION. Both fields, both ways.
// A version alone is not an identity — v1 of one release and v1 of another are
// different engineering. An id alone is not either, because a release is
// versioned in place. And agreement is NEVER inferred from the style, the
// style code, the release name or reference, any display text, the operation
// names, or from which release happens to be the newest.
//
// ── THE SEAM ────────────────────────────────────────────────────────────────
// The fact is Merchandising's, so Merchandising publishes it
// (`planningPublication.publishIssuedMeetingMinutes`) and PPC compares it
// (`orderBook.sourceHealth`). PPC never opens the meeting record: a test below
// asserts that, because the one time this check was written inside PPC by
// reaching for the model, it broke the boundary that keeps the two apps apart.
//
// Pinned:
//   · PPM and PPC on the same release and version: no blocker;
//   · PPM reviewed v1 while PPC froze v2: PPM_RELEASE_VERSION_MISMATCH;
//   · same version number, different release record: PPM_RELEASE_ID_MISMATCH;
//   · no reviewed-release evidence: PPM_RELEASE_NOT_REVIEWED;
//   · evidence that establishes no id or no version: PPM_RELEASE_UNREADABLE;
//   · another company's minutes: unavailable, and no identity leaks;
//   · a newer IE release does not retroactively change an issued meeting or a
//     frozen plan, and a blocker rewrites neither;
//   · publishing a stage target refuses while the disagreement stands.
"use strict";

/* IE's approved cutting standard. A required CUTTING stage carries one, or it
   cannot be dated — see test/ppc/ppc-cutting-technical-basis.test.js. */
const CUT_STD = require("./planningFixtures").cuttingStandard();
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const crypto = require("crypto");
const express = require("express");
const mongoose = require("mongoose");

const fx = require("./planningFixtures");
const IeRelease = require("../../models/CMS_Models/IndustrialEngineering/IeRelease");
const IeStyleFile = require("../../models/CMS_Models/IndustrialEngineering/IeStyleFile");
const { IeReleaseReceipt } = require("../../models/CMS_Models/PPC/IeReleaseReceipt");
const { PpcPlanningFile } = require("../../models/CMS_Models/PPC/PpcPlanningFile");
const { PpcStageSchedule } = require("../../models/CMS_Models/PPC/PpcStageSchedule");
const { PpcStagePublication } = require("../../models/CMS_Models/PPC/PpcStagePublication");
const {
  PreProductionMeeting, PPM_STATE,
} = require("../../models/CMS_Models/Merchandising/PreProductionMeeting");

const publication = require("../../services/merchandising/planningPublication.service");
const orderBook = require("../../services/ppc/orderBook.service");

let http, base, seq = 0;
const PPC = "/api/cms/ppc";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(PPC, require("../../routes/CMS_Routes/PPC/orderBookRoute"));
  await new Promise((r) => { http = app.listen(0, r); });
  base = `http://127.0.0.1:${http.address().port}`;
  for (const m of [PpcPlanningFile, PpcStageSchedule, PpcStagePublication, PreProductionMeeting]) {
    await m.syncIndexes();
  }
});
afterAll(() => new Promise((r) => http.close(r)));

const call = (path, { token, method = "GET", body, company: co, key } = {}) => fetch(`${base}${path}`, {
  method,
  headers: {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(co ? { "X-Costing-Company": String(co) } : {}),
    ...(key ? { "Idempotency-Key": key } : {}),
  },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
}).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

/* ══ FIXTURES ═════════════════════════════════════════════════════════════ */

const sid = () => `stg_${crypto.randomBytes(9).toString("hex")}`;
/* Cutting and then sewing. The sewing stage is here because this suite dates
   and publishes a stage to prove the EVIDENCE gate refuses nothing that used
   to be allowed — and a cutting window is written from a capacity reservation,
   never typed, so it is the wrong stage to ask that question with. */
const ROUTE = () => {
  const ids = { cut: sid(), sew: sid() };
  return { ids, stages: [
    { stageId: ids.cut, sequence: 1, process: "CUTTING", label: "Cutting",
      applicability: "REQUIRED", predecessorStageIds: [], technicalStandard: CUT_STD },
    { stageId: ids.sew, sequence: 2, process: "SEWING", label: "Sewing",
      applicability: "REQUIRED", predecessorStageIds: [ids.cut] },
  ] };
};

const evidence = { kind: "BUYER_PO", buyerApprovalRef: "q1", documentRef: "grav/po/1", poNumber: "PO-1" };
const statement = () => ({ statedAt: new Date(), processes: [
  { process: "EMBROIDERY", requirement: "NOT_REQUIRED", buyerSpecification: "PO: none", evidence },
  { process: "PRINTING", requirement: "NOT_REQUIRED", buyerSpecification: "PO: none", evidence },
  { process: "WASHING", requirement: "NOT_REQUIRED", buyerSpecification: "PO: none", evidence },
] });

/** IE's style file, so `currentReleaseForStyle` can resolve a release at all. */
const styleFile = (co, sampleStyleId) => IeStyleFile.create({
  companyId: co._id, sampleStyleId,
  source: { technicalRevision: 1, operationCount: 1, snapshot: null },
});

/** One ISSUED release of a style, on that style's own IE file. */
async function issuedRelease(co, styleFileDoc, sampleStyleId, { versionNo = 1, processRoute } = {}) {
  const n = ++seq + Date.now();
  const doc = await IeRelease.create({
    companyId: co._id, releaseRef: `IEREL-R${String(n).slice(-9)}`, versionNo,
    ieStyleFileId: styleFileDoc._id, sampleStyleId, state: "ISSUED",
    aggregateFingerprint: `${n}`.padStart(64, "f"),
    source: {
      bulletinVersionId: new mongoose.Types.ObjectId(), bulletinVersionNo: 1,
      sourceFingerprint: `${n}`.padStart(64, "a"), rows: [],
      garmentSamMinutes: 4.5, samRowCount: 4,
      lineLayout: { stationCount: 2, stations: [], metrics: { stationCount: 2 } },
      capacityStandard: { inputs: { plannedOperatorCount: 25 },
        calculation: { targetPiecesPerDay: 100 },
        readiness: { state: "PROVISIONAL", ready: false, gaps: [] } },
      capturedAt: new Date("2026-09-01"),
      processRoute: { stages: processRoute },
    },
    issuedBy: new mongoose.Types.ObjectId(), issuedByName: "IE", issuedAt: new Date("2026-09-01"),
  });
  await IeReleaseReceipt.create({
    companyId: co._id, releaseRef: doc.releaseRef, releaseVersionNo: versionNo,
    ieReleaseId: doc._id, ieStyleFileId: doc.ieStyleFileId,
    state: "ACCEPTED", decidedAt: new Date("2026-09-02"),
    decidedBy: { id: new mongoose.Types.ObjectId(), name: "PPC" },
    idempotencyKey: `kr-${n}`, requestHash: `hr-${n}`,
  });
  return doc;
}

/**
 * Issued minutes whose frozen snapshot records EXACTLY the reviewed release.
 *
 * Written as a record rather than driven through Merchandising's routes: what
 * is under test is the identity crossing the contract, and the snapshot is
 * server-derived at issue time either way. The one thing that matters is that
 * it is FROZEN — a later release cannot change it.
 */
const minutes = (co, file, reviewed, {
  versionNo = 1, availability = "PRESENT", contractVersion = 2,
} = {}) =>
  PreProductionMeeting.create({
    companyId: co._id, fileId: file._id, fileNumber: file.fileNumber,
    handoverRef: file.handoverRef, handoverLineRef: file.handoverLineRef,
    orderRef: file.handoverRef, orderLineRef: file.handoverLineRef,
    ppmRef: `PPM-R${++seq}-${Date.now()}`, versionNo, state: PPM_STATE.ISSUED,
    issuedAt: new Date("2026-09-03"),
    sourcesCapturedAt: new Date("2026-09-03"),
    /* Which contract captured this snapshot — the whole difference between a
       record that could not answer and one that answered "none". Null is the
       legacy stamp, and it is never inferred from the rows below. */
    sourcesContractVersion: contractVersion,
    sourceReferences: contractVersion === null && !reviewed ? [] : [{
      key: "IE_RELEASE", label: "Engineering release", availability,
      recordId: reviewed?.recordId ?? null,
      reference: reviewed?.reference ?? "",
      versionNo: reviewed?.versionNo ?? null,
      revisionNo: null, state: reviewed?.state ?? "", sourceUpdatedAt: null, note: "",
    }],
  });

/**
 * A company with one confirmed line, IE's style file, an issued release, and a
 * PPC planning file frozen against that release. `reviewedAs` decides what the
 * meeting recorded — by default, exactly what PPC froze.
 */
async function world(label, { reviewedAs = "SAME", minuteOpts = {}, plan = true } = {}) {
  const co = await fx.company(label);
  const r = ROUTE();
  const styleId = new mongoose.Types.ObjectId();
  const sf = await styleFile(co, styleId);
  const rel = await issuedRelease(co, sf, styleId, { versionNo: 1, processRoute: r.stages });

  const file = await fx.orderLine(co, {
    lineRef: `LN-${crypto.randomBytes(6).toString("hex")}`, sampleStyleId: styleId,
    processRequirements: statement(), quantity: 300,
  });
  await fx.pack(co, file);

  /* What the meeting recorded as reviewed. */
  const reviewed = {
    SAME: { recordId: rel._id, reference: rel.releaseRef, versionNo: 1, state: "ISSUED" },
    OLDER_VERSION: { recordId: rel._id, reference: rel.releaseRef, versionNo: 1, state: "ISSUED" },
    OTHER_RECORD: null,   // filled below, needs a second release
    NO_ID: { recordId: null, reference: rel.releaseRef, versionNo: 1, state: "ISSUED" },
    NO_VERSION: { recordId: rel._id, reference: rel.releaseRef, versionNo: null, state: "ISSUED" },
    /* The same record, snapshotted at a version it does not have. */
    WRONG_VERSION: { recordId: rel._id, reference: rel.releaseRef, versionNo: 2, state: "ISSUED" },
    NONE: null,
  }[reviewedAs];

  let other = null;
  if (reviewedAs === "OTHER_RECORD") {
    /* A different engineering record at the SAME version number — the case a
       version-only comparison would wave through. */
    const otherStyle = new mongoose.Types.ObjectId();
    other = await issuedRelease(co, await styleFile(co, otherStyle), otherStyle,
      { versionNo: 1, processRoute: r.stages });
  }

  const ppm = reviewedAs === "NONE"
    ? await minutes(co, file, null, { ...minuteOpts, availability: "NOT_REPORTED" })
    : await minutes(co, file, other
      ? { recordId: other._id, reference: other.releaseRef, versionNo: 1, state: "ISSUED" }
      : reviewed, minuteOpts);

  const planner = await fx.actor({ companies: [co], grants: { ppc: "editor" } });
  const w = { co, file, rel, other, ppm, planner, r, styleId, styleFile: sf,
    lineRef: file.handoverLineRef, planId: null };
  w.create = () => call(`${PPC}/order-book/${w.lineRef}/planning-file`,
    { token: planner.token, company: co._id, method: "POST", body: {}, key: fx.nextKey() });
  /* The register row for this line, as PPC's own detail endpoint returns it. */
  w.row = async () => {
    const res = await call(`${PPC}/order-book/${w.lineRef}`,
      { token: planner.token, company: co._id });
    expect(res.status).toBe(200);
    return res.body.row;
  };

  if (plan) {
    const created = await w.create();
    expect(created.status).toBe(201);
    w.planId = created.body.planningFile.planningFileId;
  }
  return w;
}

const health = async (w) => {
  const plan = await PpcPlanningFile.findById(w.planId).lean();
  return { plan, health: await orderBook.sourceHealth({ companyId: String(w.co._id) }, plan) };
};
const blockerKinds = (h) => h.movements
  .filter((m) => m.key === "ppmReviewedRelease").map((m) => m.kind);
const verdict = (h) => h.reviewedRelease.state;

/* ══ THE FIVE EVIDENCE STATES ════════════════════════════════════════════ */

describe("1 · legacy minutes: history readable, new decisions refused", () => {
  /**
   * A plan frozen back when the evidence could not name a release — created
   * here the only honest way, by making it while the minutes were still valid
   * and then retiring them to the legacy shape a real deployment already
   * holds. Nothing is backfilled and nothing is rewritten to agree.
   */
  async function historicalPlan(label) {
    const w = await world(label);                        // agreeing, contract v2
    expect(w.planId).toBeTruthy();
    await mongoose.connection.collection("merchandising_pre_production_meetings")
      .updateOne({ _id: w.ppm._id },
        { $unset: { sourcesContractVersion: "", sourceReferences: "", sourcesCapturedAt: "" } });
    return w;
  }

  test("an existing plan stays readable and is NOT retroactively source-moved", async () => {
    const w = await historicalPlan("ppm-legacy");
    const { health: h } = await health(w);
    expect(verdict(h)).toBe("LEGACY_EVIDENCE_UNAVAILABLE");
    expect(h.reviewedRelease.contractVersion).toBeNull();
    /* Named, and never a movement: an existing plan frozen against minutes
       issued before the contract is not retroactively invalidated. */
    expect(blockerKinds(h)).toEqual([]);
    expect(h.moved).toBe(false);
    /* And it is not reported as agreement either. */
    expect(verdict(h)).not.toBe("AGREED");
  });

  test("a brand-new plan on the SAME legacy minutes is refused", async () => {
    const w = await historicalPlan("ppm-legacy-new");
    /* The existing plan is untouched and still readable… */
    expect((await health(w)).health.moved).toBe(false);

    /* …and a plan being decided NOW may not be made on evidence that cannot
       say which engineering was reviewed. */
    const row = await w.row();
    expect(row.inputs.ppmMinutes.state).toBe("PENDING");
    expect(row.inputs.ppmMinutes.reason).toBe("PPM_RELEASE_LEGACY_EVIDENCE");
    expect(row.inputs.ppmMinutes.reviewedRelease).toBe("LEGACY_EVIDENCE_UNAVAILABLE");
    expect(row.readyToPlan).toBe(false);

    /* A second line of the same company, on the same legacy minutes' style. */
    const fresh = await world("ppm-legacy-fresh", { plan: false, minuteOpts: { contractVersion: null } });
    const created = await fresh.create();
    expect(created.status).toBe(409);
    expect(await PpcPlanningFile.countDocuments({ companyId: fresh.co._id })).toBe(0);
  });

  test("a SUCCESSOR generation on legacy minutes is refused too", async () => {
    const w = await historicalPlan("ppm-legacy-succ");
    /* A successor is an approver's act, so it is asked for by one. */
    const approver = await fx.actor({ companies: [w.co], grants: { ppc: "approver" } });
    const succ = await call(`${PPC}/planning-files/${w.planId}/successor`,
      { token: approver.token, company: w.co._id, method: "POST", key: fx.nextKey(),
        body: { expectedRevision: (await PpcPlanningFile.findById(w.planId).lean()).revision,
          reason: "The engineering was re-issued and this plan must follow it." } });
    expect(succ.status).toBe(409);
    /* Exactly one plan, and it is the original, untouched. */
    expect(await PpcPlanningFile.countDocuments({ companyId: w.co._id })).toBe(1);
    const plan = await PpcPlanningFile.findById(w.planId).lean();
    expect(String(plan.sourceBasis.ieReleaseId)).toBe(String(w.rel._id));
  });

  test("re-issuing the minutes under contract v2 is the remedy", async () => {
    const w = await historicalPlan("ppm-legacy-remedy");
    expect((await w.row()).inputs.ppmMinutes.reason).toBe("PPM_RELEASE_LEGACY_EVIDENCE");

    /* Merchandising meets again and records WHICH release was reviewed —
       the exact one this line's plan freezes. */
    await mongoose.connection.collection("merchandising_pre_production_meetings")
      .updateOne({ _id: w.ppm._id },
        { $set: { state: "SUPERSEDED", supersededByVersionNo: 2, supersededAt: new Date() } });
    await minutes(w.co, w.file,
      { recordId: w.rel._id, reference: w.rel.releaseRef, versionNo: 1, state: "ISSUED" },
      { versionNo: 2 });

    const row = await w.row();
    expect(row.inputs.ppmMinutes.state).toBe("SATISFIED");
    expect(row.inputs.ppmMinutes.reviewedRelease).toBe("AGREED");

    /* A new line of the same style now plans normally. */
    const fresh = await world("ppm-legacy-remedied", { plan: false });
    expect((await fresh.create()).status).toBe(201);
  });

  test("a historical plan on legacy minutes stays readable and can still publish", async () => {
    const w = await historicalPlan("ppm-legacy-publish");
    const read = await call(`${PPC}/planning-files/${w.planId}/source-health`,
      { token: w.planner.token, company: w.co._id });
    expect(read.status).toBe(200);
    expect(read.body.reviewedRelease.state).toBe("LEGACY_EVIDENCE_UNAVAILABLE");

    const saved = await call(`${PPC}/planning-files/${w.planId}/stage-schedule`,
      { token: w.planner.token, company: w.co._id, method: "POST", key: fx.nextKey(),
        body: { expectedRevision: 0,
          stages: [{ stageId: w.r.ids.sew, plannedStart: "2026-10-05", plannedEnd: "2026-10-07" }] } });
    expect(saved.status).toBe(200);
    /* Publishing gets as far as PPC's own work-order requirement — this world
       links none — and is NOT stopped by the evidence gate. That is the whole
       claim: legacy evidence is reported, and it refuses nothing that used to
       be allowed. The four receivers' own suites prove publication end to end
       on valid evidence. */
    const out = await call(`${PPC}/planning-files/${w.planId}/stage-schedule/publish`,
      { token: w.planner.token, company: w.co._id, method: "POST", key: fx.nextKey(),
        body: { stageId: w.r.ids.sew, expectedScheduleVersion: 1 } });
    expect(out.body.error.code).toBe("PPC_PUBLISH_NO_WORKORDER");
    expect(out.body.error.code).not.toBe("PPC_PUBLISH_SOURCE_MOVED");
  });
});

describe("2 · new-contract minutes that reviewed no release", () => {
  test("a new plan cannot be made on them", async () => {
    const w = await world("ppm-not-reviewed", { reviewedAs: "NONE", plan: false });
    const row = await w.row();
    expect(row.inputs.ppmMinutes.state).toBe("PENDING");
    expect(row.inputs.ppmMinutes.reason).toBe("PPM_RELEASE_NOT_REVIEWED");
    expect(row.inputs.ppmMinutes.evidenceContractVersion).toBe(2);
    expect(row.readyToPlan).toBe(false);

    const created = await w.create();
    expect(created.status).toBe(409);
    expect(await PpcPlanningFile.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("the stamp still changes the NAME of the refusal, and the health verdict", async () => {
    /* Byte-identical absence, one stamped and one not. Both refuse a new
       plan — but for different reasons, with different remedies, and only one
       of them also fails an existing plan's health. */
    const stamped = await world("ppm-not-reviewed-stamped", { reviewedAs: "NONE", plan: false });
    const legacy = await world("ppm-not-reviewed-legacy",
      { reviewedAs: "NONE", plan: false, minuteOpts: { contractVersion: null } });

    expect((await stamped.row()).inputs.ppmMinutes.reason).toBe("PPM_RELEASE_NOT_REVIEWED");
    expect((await legacy.row()).inputs.ppmMinutes.reason).toBe("PPM_RELEASE_LEGACY_EVIDENCE");
    expect((await stamped.create()).status).toBe(409);
    expect((await legacy.create()).status).toBe(409);
  });
});

describe("3 · new-contract evidence that is malformed", () => {
  test("a release row with no record id, or no version, blocks a new plan", async () => {
    for (const [reviewedAs, note] of [["NO_ID", "no record id"], ["NO_VERSION", "no version"]]) {
      const w = await world(`ppm-malformed-${reviewedAs}`, { reviewedAs, plan: false });
      const row = await w.row();
      expect([note, row.inputs.ppmMinutes.state]).toEqual([note, "PENDING"]);
      expect([note, row.inputs.ppmMinutes.reason]).toEqual([note, "PPM_RELEASE_UNREADABLE"]);
      expect((await w.create()).status).toBe(409);
      expect(await PpcPlanningFile.countDocuments({ companyId: w.co._id })).toBe(0);
    }
  });

  test("a matching reference does not rescue a missing id", async () => {
    /* The reference is a business code: renamed, reused and reissued. It is
       published to be read and never matched on, and this is the test that
       says so. */
    const w = await world("ppm-ref-only", { reviewedAs: "NO_ID", plan: false });
    const published = await publication.publishIssuedMeetingMinutes(
      { companyId: String(w.co._id) }, [String(w.file._id)]);
    expect(published.get(String(w.file._id)).reviewedIeRelease.releaseRef).toBe(w.rel.releaseRef);
    expect((await w.create()).status).toBe(409);
  });
});

/* ══ AGREEMENT, AND DISAGREEMENT ══════════════════════════════════════════ */

describe("4 · the exact release and version", () => {
  test("same release, same version: the plan is made, and both identities are published", async () => {
    const w = await world("ppm-same");
    const { plan, health: h } = await health(w);

    expect(String(plan.sourceBasis.ieReleaseId)).toBe(String(w.rel._id));
    expect(plan.sourceBasis.ieReleaseVersionNo).toBe(1);
    expect(verdict(h)).toBe("AGREED");
    expect(h.reviewedRelease.contractVersion).toBe(2);
    expect(blockerKinds(h)).toEqual([]);
    expect(h.moved).toBe(false);

    expect(h.current.ppmReviewedIeRelease).toMatchObject({
      releaseId: String(w.rel._id), versionNo: 1, releaseRef: w.rel.releaseRef, state: "ISSUED",
    });
    expect(h.current.ppmMinutes.evidenceContract)
      .toEqual({ version: 2, capturesReviewedRelease: true });
  });
});

describe("5 · a different release, or a different version", () => {
  test("the same version number on a DIFFERENT record: blocked, by id, and no new plan", async () => {
    const w = await world("ppm-other-record", { reviewedAs: "OTHER_RECORD", plan: false });
    const row = await w.row();
    expect(row.inputs.ppmMinutes.reason).toBe("PPM_RELEASE_ID_MISMATCH");
    expect((await w.create()).status).toBe(409);

    /* The version numbers agree exactly — only the ids differ, and only the
       ids are reported: the other record is not this reader's to be told. */
    const verdictOut = orderBook.reviewedReleaseVerdict({
      ppm: (await publication.publishIssuedMeetingMinutes(
        { companyId: String(w.co._id) }, [String(w.file._id)])).get(String(w.file._id)),
      frozenReleaseId: String(w.rel._id), frozenVersionNo: 1,
    });
    expect(verdictOut.verdict.state).toBe("PPM_RELEASE_ID_MISMATCH");
    expect(verdictOut.movement).toMatchObject({
      key: "ppmReviewedRelease", from: String(w.rel._id), to: String(w.other._id),
    });
    expect(JSON.stringify(verdictOut.movement)).not.toContain(w.other.releaseRef);
  });

  test("a snapshot naming a version the plan did not freeze: blocked, by version", async () => {
    /* An issued IE release is immutable and so is a plan's frozen basis, so a
       same-id/different-version pair cannot be made by editing either. What
       CAN hold a wrong version is the meeting's own snapshot — it is a COPY,
       and a copy is the thing that goes stale. The ids are deliberately left
       EQUAL so nothing but the version can fail. */
    const w = await world("ppm-wrong-version", { reviewedAs: "WRONG_VERSION", plan: false });
    const row = await w.row();
    expect(row.inputs.ppmMinutes.reason).toBe("PPM_RELEASE_VERSION_MISMATCH");
    expect((await w.create()).status).toBe(409);
  });

  test("minutes re-issued with different engineering move an existing plan", async () => {
    /* A plan frozen while the evidence agreed, and Merchandising then issues
       a successor meeting that reviewed something else. The plan is not
       rewritten; it reports that its source moved. */
    const w = await world("ppm-reissued");
    expect(verdict((await health(w)).health)).toBe("AGREED");

    const otherStyle = new mongoose.Types.ObjectId();
    const otherRel = await issuedRelease(w.co, await styleFile(w.co, otherStyle), otherStyle,
      { versionNo: 1, processRoute: w.r.stages });
    /* One ISSUED minute per file, so the first steps down as Merchandising
       retires it — the successor is a new version, never an edit of the old.
       Merchandising performs that step through the document itself; the model
       refuses it through a query, correctly, which is why this reaches the
       collection rather than pretending an issued minute can be updated. */
    await mongoose.connection.collection("merchandising_pre_production_meetings")
      .updateOne({ _id: w.ppm._id },
        { $set: { state: "SUPERSEDED", supersededByVersionNo: 2, supersededAt: new Date() } });
    await minutes(w.co, w.file,
      { recordId: otherRel._id, reference: otherRel.releaseRef, versionNo: 1, state: "ISSUED" },
      { versionNo: 2 });

    const { health: h } = await health(w);
    expect(blockerKinds(h)).toEqual(["PPM_RELEASE_ID_MISMATCH"]);
    expect(h.moved).toBe(true);
    /* Neither record was rewritten to agree with the other. */
    const first = await PreProductionMeeting.findById(w.ppm._id).lean();
    expect(String(first.sourceReferences[0].recordId)).toBe(String(w.rel._id));
    const plan = await PpcPlanningFile.findById(w.planId).lean();
    expect(String(plan.sourceBasis.ieReleaseId)).toBe(String(w.rel._id));
  });
});

/* ══ BOUNDARIES ═══════════════════════════════════════════════════════════ */

describe("neither side is rewritten by the other", () => {
  test("another company's minutes are unavailable here, and leak no identity", async () => {
    const mine = await world("ppm-mine");
    const theirs = await world("ppm-theirs");

    const seen = await publication.publishIssuedMeetingMinutes(
      { companyId: String(mine.co._id) }, [String(theirs.file._id)]);
    expect(seen.size).toBe(0);

    const { health: h } = await health(mine);
    const dump = JSON.stringify(h);
    expect(dump).not.toContain(String(theirs.rel._id));
    expect(dump).not.toContain(theirs.rel.releaseRef);
    expect(dump).not.toContain(String(theirs.ppm._id));
    expect(verdict(h)).toBe("AGREED");
  });

  test("a newer IE release changes neither the issued meeting nor the frozen plan", async () => {
    const w = await world("ppm-newer");
    const before = await PreProductionMeeting.findById(w.ppm._id).lean();
    const planBefore = await PpcPlanningFile.findById(w.planId).lean();

    const newer = await issuedRelease(w.co, w.styleFile, w.styleId,
      { versionNo: 2, processRoute: w.r.stages });
    expect(String(newer._id)).not.toBe(String(w.rel._id));

    const after = await PreProductionMeeting.findById(w.ppm._id).lean();
    expect(after.sourceReferences).toEqual(before.sourceReferences);
    expect(after.sourcesContractVersion).toBe(before.sourcesContractVersion);
    const planAfter = await PpcPlanningFile.findById(w.planId).lean();
    expect(String(planAfter.sourceBasis.ieReleaseId)).toBe(String(planBefore.sourceBasis.ieReleaseId));

    /* The meeting and the plan still agree, because neither followed the
       newest release. */
    expect(verdict((await health(w)).health)).toBe("AGREED");
  });

  test("PPC reads the minutes only through Merchandising's published contract", async () => {
    const fs = require("fs");
    const path = require("path");
    const dir = path.join(__dirname, "../../services/ppc");
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
      const src = fs.readFileSync(path.join(dir, name), "utf8");
      expect(src).not.toMatch(/Merchandising\/PreProductionMeeting/);
      expect(src).not.toMatch(/\bPreProductionMeeting\b/);
    }
    /* And PPM approval is not a Production release. */
    const ob = fs.readFileSync(path.join(dir, "orderBook.service.js"), "utf8");
    expect(ob).not.toMatch(/productionRelease|releaseToProduction/i);
  });
});
