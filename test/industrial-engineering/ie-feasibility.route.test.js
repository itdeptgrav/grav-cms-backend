// test/industrial-engineering/ie-feasibility.route.test.js
//
// ENGINEERING FEASIBILITY — can this factory make this style, and who says so?
//
// The assessment is IE's own judgement, saved on the engineering file while it
// is a draft, frozen into the bulletin version at submission, and decided with
// that version under the maker-checker that already exists. The claims worth
// holding, each a way this could be wrong rather than a restatement:
//
//   · silence is never a pass — an unassessed style cannot be submitted, and
//     an empty assessment never reads as feasible;
//   · a result the findings do not support is refused: feasible over an open
//     blocker, conditional with no condition, blocked with nothing blocking;
//   · a blocked assessment SAVES and shares, and cannot become the approved
//     standard;
//   · approving freezes it, and later edits build the next one rather than
//     rewriting what was approved;
//   · a newer R&D technical pack marks it as needing reassessment rather than
//     carrying it forward;
//   · a viewer cannot write, another company cannot see it, and two editors
//     cannot both believe they saved.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const IeStyleFile = require("../../models/CMS_Models/IndustrialEngineering/IeStyleFile");
const IeBulletinVersion = require("../../models/CMS_Models/IndustrialEngineering/IeBulletinVersion");

const feasibility = require("../../services/industrialEngineering/ieFeasibility.service");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/ie", require("../../routes/CMS_Routes/IndustrialEngineering/ieRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/ie`;
});

afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (path, { method = "GET", body, token, company } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => {
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text || "null"); } catch { parsed = { nonJson: true }; }
    return { status: r.status, body: parsed };
  });

async function actor({ companies = [], grants = {} } = {}) {
  const n = ++seq;
  const email = `ief${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "I", lastName: `F${n}`, email, biometricId: `IEF${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "I" });
  }
  for (const [departmentSlug, role] of Object.entries(grants)) {
    await DepartmentRole.create({
      departmentSlug, email, name: "User", role, isActive: true,
      departmentId: new mongoose.Types.ObjectId(),
    });
  }
  return {
    email,
    token: jwt.sign(
      { id: String(emp._id), email, name: `IE Person ${n}`, role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

const editorIn = (co) => actor({ companies: [co], grants: { ie: "editor" } });
const viewerIn = (co) => actor({ companies: [co], grants: { ie: "viewer" } });

/** A company with a style and an engineering file on it, as a draft. */
async function world(name, { technicalRevision = 2 } = {}) {
  const n = ++seq;
  const co = await Acc_Company.create({ companyName: `${name} ${n}`, booksFromDate: new Date("2026-04-01") });
  const accountId = new mongoose.Types.ObjectId();
  const journey = await SalesJourney.create({
    journeyId: `SJ-${name}-${n}`, companyId: co._id, accountId,
    ownerId: new mongoose.Types.ObjectId(), ownerName: "Owner", name: `J ${name}`, isActive: true,
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-${name}-${n}`, journeyId: journey._id, accountId, companyId: co._id,
    title: `E ${name}`, isActive: true, products: [{ product: "Polo", quantity: 500 }],
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-F-${n}`, productName: `Polo ${n}`, styleCode: `NW-POLO-${n}`,
    variantLabel: "Navy", variantKey: `v${n}`,
    journeyId: journey._id, enquiryId: enquiry._id, stage: "rnd",
    techSheet: { technical: { status: "approved", revision: technicalRevision } },
  });
  const file = await IeStyleFile.create({
    companyId: co._id, sampleStyleId: style._id,
    source: {
      technicalRevision, approvedAt: new Date("2026-08-05"),
      submittedAt: new Date("2026-08-01"), operationCount: 1,
    },
    bulletin: { rows: [] },
  });
  const editor = await editorIn(co);
  return { co, style, file, editor, t: { token: editor.token, company: co._id } };
}

const read = (w, who) => call(`/engineering-files/${w.file._id}/feasibility`,
  { token: who.token, company: w.co._id });
const save = (w, who, body) => call(`/engineering-files/${w.file._id}/feasibility`,
  { method: "PATCH", token: who.token, company: w.co._id, body });

const FINDING = {
  area: "CONSTRUCTION",
  title: "Fabric stretches while attaching the collar",
  observation: "The rib collar grows on the shoulder seam when it is set by hand.",
  severity: "CONCERN",
  owner: "INDUSTRIAL_ENGINEERING",
  requiredAction: "Trial a folder or guide on the next sample.",
};

/* ══ 1. NOTHING RECORDED IS NOT A PASS ════════════════════════════════════ */

describe("an unassessed style says so", () => {
  test("the read answers NOT_ASSESSED, with every area unchecked", async () => {
    const w = await world("FeasEmpty");
    const res = await read(w, w.editor);
    expect(res.status).toBe(200);
    expect(res.body.assessment).toMatchObject({
      outcome: "NOT_ASSESSED", assessed: false, openBlockers: 0, revision: 0,
    });
    expect(res.body.assessment.findings).toEqual([]);
    /* Not "clear": nobody has looked at any of them. */
    expect(new Set(res.body.assessment.areas.map((a) => a.state))).toEqual(new Set(["NOT_CHECKED"]));
    const wire = JSON.stringify(res.body);
    for (const claim of ["FEASIBLE", "feasible", "No issues", "makeable"]) {
      expect(wire).not.toContain(claim);
    }
  });

  test("an unassessed style cannot be submitted", async () => {
    const w = await world("FeasGateSubmit");
    const gaps = feasibility.feasibilityGaps(await IeStyleFile.findById(w.file._id).lean(), { stage: "submitted" });
    expect(gaps.map((g) => g.code)).toContain("IE_FEASIBILITY_NOT_ASSESSED");
  });
});

/* ══ 2. THE RESULT MUST MATCH THE FINDINGS ════════════════════════════════ */

describe("a result the findings do not support is refused", () => {
  test("feasible over an open blocking finding", async () => {
    const w = await world("FeasBlocked1");
    const res = await save(w, w.editor, {
      expectedRevision: 0,
      outcome: "FEASIBLE",
      findings: [{ ...FINDING, severity: "BLOCKING", owner: "RESEARCH_DEVELOPMENT" }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IE_FEASIBILITY_INVALID");
    expect(res.body.message).toMatch(/cannot be recorded as feasible/i);
    /* And nothing was written. */
    expect((await IeStyleFile.findById(w.file._id).lean()).feasibility).toBeUndefined();
  });

  test("feasible with conditions and no condition", async () => {
    const w = await world("FeasCond");
    const res = await save(w, w.editor, {
      expectedRevision: 0, outcome: "FEASIBLE_WITH_CONDITIONS", findings: [FINDING],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/needs at least one condition/i);
  });

  test("blocked with nothing blocking", async () => {
    const w = await world("FeasBlockedEmpty");
    const res = await save(w, w.editor, { expectedRevision: 0, outcome: "BLOCKED", findings: [FINDING] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/needs at least one open blocking finding/i);
  });

  test("a finding resolved with nothing said about it", async () => {
    const w = await world("FeasResolve");
    const res = await save(w, w.editor, {
      expectedRevision: 0, outcome: "FEASIBLE",
      findings: [{ ...FINDING, status: "RESOLVED" }],
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/Say what was done/i);
  });

  test("a finding with no area, severity or owner", async () => {
    const w = await world("FeasShape");
    const res = await save(w, w.editor, {
      expectedRevision: 0, outcome: "FEASIBLE", findings: [{ title: "Something" }],
    });
    expect(res.status).toBe(400);
    const fields = (res.body.error.details?.fieldErrors || []).map((f) => f.field);
    expect(fields).toEqual(expect.arrayContaining(["findings.0.area", "findings.0.severity", "findings.0.owner"]));
  });

  test("planning and costing facts are refused by name", async () => {
    const w = await world("FeasRefused");
    for (const [field, value] of [["quantity", 500], ["targetOutput", 120], ["lineId", "L-1"],
      ["machineId", "M-7"], ["rate", 12], ["supplierId", "S-1"]]) {
      const res = await save(w, w.editor, {
        expectedRevision: 0, outcome: "FEASIBLE", findings: [{ ...FINDING, [field]: value }],
      });
      expect([field, res.status]).toEqual([field, 400]);
      expect(res.body.error.code).toBe("FIELD_NOT_ACCEPTED");
    }
  });
});

/* ══ 3. A REAL ASSESSMENT SAVES, AND READS BACK ═══════════════════════════ */

describe("an editor records an assessment", () => {
  test("feasible with conditions saves, and the strip follows the findings", async () => {
    const w = await world("FeasSave");
    const res = await save(w, w.editor, {
      expectedRevision: 0,
      outcome: "FEASIBLE_WITH_CONDITIONS",
      recommendation: "Make it, once the folder is arranged and the decoration order is agreed.",
      findings: [
        FINDING,
        { area: "SPECIAL_PROCESSES", title: "Chest embroidery must be finished before front assembly",
          observation: "The crest cannot be hooped once the front is joined.",
          severity: "CONCERN", owner: "PRODUCTION",
          requiredAction: "Sequence the outside process before assembly." },
        { area: "MACHINES", title: "Collar folder must be arranged before bulk",
          severity: "INFORMATION", owner: "INDUSTRIAL_ENGINEERING",
          availability: "NEED_TO_ARRANGE", requiredAction: "Raise it with the floor." },
      ],
      conditions: [{
        text: "A collar folder is available before bulk production starts",
        owner: "INDUSTRIAL_ENGINEERING", requiredAction: "Arrange the folder.",
      }],
    });
    expect(res.status).toBe(200);
    const a = res.body.assessment;
    expect(a).toMatchObject({ outcome: "FEASIBLE_WITH_CONDITIONS", assessed: true, openBlockers: 0, revision: 1 });
    expect(a.basedOnTechnicalRevision).toBe(2);
    expect(a.assessedByName).toMatch(/IE Person/);
    expect(a.findings).toHaveLength(3);
    for (const f of a.findings) expect(f.findingId).toMatch(/^fnd_[0-9a-f]{16}$/);
    const byArea = Object.fromEntries(a.areas.map((x) => [x.area, x.state]));
    expect(byArea.CONSTRUCTION).toBe("CONCERN");
    expect(byArea.SPECIAL_PROCESSES).toBe("CONCERN");
    /* An area with no finding is CLEAR once an assessment exists — and was
       NOT_CHECKED before one did. */
    expect(byArea.QUALITY_RISK).toBe("CLEAR");

    /* It is on the record, not in the browser. */
    const reread = await read(w, w.editor);
    expect(reread.body.assessment.findings.map((f) => f.title)).toEqual(a.findings.map((f) => f.title));
    expect(reread.body.assessment.conditions[0].owner).toBe("INDUSTRIAL_ENGINEERING");
  });

  test("a finding keeps its identity and its author through an edit", async () => {
    const w = await world("FeasIdentity");
    const first = await save(w, w.editor, { expectedRevision: 0, outcome: "FEASIBLE", findings: [FINDING] });
    const id = first.body.assessment.findings[0].findingId;
    const second = await save(w, w.editor, {
      expectedRevision: 1, outcome: "FEASIBLE",
      findings: [{ ...FINDING, findingId: id, title: "Collar grows on the shoulder seam" }],
    });
    expect(second.status).toBe(200);
    expect(second.body.assessment.findings[0].findingId).toBe(id);
    expect(second.body.assessment.findings[0].title).toBe("Collar grows on the shoulder seam");
  });

  test("an unknown finding id is refused rather than minted", async () => {
    const w = await world("FeasUnknownId");
    const res = await save(w, w.editor, {
      expectedRevision: 0, outcome: "FEASIBLE",
      findings: [{ ...FINDING, findingId: "fnd_0000000000000000" }],
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/not part of this assessment/i);
  });

  test("resolving the last blocker lets feasible be recorded in the same save", async () => {
    const w = await world("FeasResolveThen");
    const blocked = await save(w, w.editor, {
      expectedRevision: 0, outcome: "BLOCKED",
      findings: [{ ...FINDING, severity: "BLOCKING", owner: "RESEARCH_DEVELOPMENT" }],
    });
    expect(blocked.status).toBe(200);
    expect(blocked.body.assessment.openBlockers).toBe(1);
    const id = blocked.body.assessment.findings[0].findingId;
    const cleared = await save(w, w.editor, {
      expectedRevision: 1, outcome: "FEASIBLE",
      findings: [{ ...FINDING, findingId: id, severity: "BLOCKING", owner: "RESEARCH_DEVELOPMENT",
        status: "RESOLVED", resolutionNote: "R&D confirmed the needle and thread on the approved fabric." }],
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.assessment).toMatchObject({ outcome: "FEASIBLE", openBlockers: 0 });
  });
});

/* ══ 4. CONCURRENCY, ROLES AND COMPANY ════════════════════════════════════ */

describe("the same rules as every other IE edit", () => {
  test("a stale revision conflicts and writes nothing", async () => {
    const w = await world("FeasStale");
    await save(w, w.editor, { expectedRevision: 0, outcome: "FEASIBLE", findings: [] });
    const stale = await save(w, w.editor, { expectedRevision: 0, outcome: "BLOCKED", findings: [] });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("IE_FEASIBILITY_REVISION_CONFLICT");
    expect((await IeStyleFile.findById(w.file._id).lean()).feasibility.outcome).toBe("FEASIBLE");
  });

  test("a viewer reads and cannot write", async () => {
    const w = await world("FeasViewer");
    const viewer = await viewerIn(w.co);
    await save(w, w.editor, { expectedRevision: 0, outcome: "FEASIBLE", findings: [] });
    const got = await read(w, viewer);
    expect(got.status).toBe(200);
    expect(got.body.assessment.outcome).toBe("FEASIBLE");
    const tried = await save(w, viewer, { expectedRevision: 1, outcome: "BLOCKED", findings: [] });
    expect(tried.status).toBe(403);
  });

  test("another company's file is indistinguishable from one that does not exist", async () => {
    const mine = await world("FeasMine");
    const theirs = await world("FeasTheirs");
    const outsider = await editorIn(theirs.co);
    const foreign = await call(`/engineering-files/${mine.file._id}/feasibility`,
      { token: outsider.token, company: theirs.co._id });
    const invented = await call(`/engineering-files/${new mongoose.Types.ObjectId()}/feasibility`,
      { token: outsider.token, company: theirs.co._id });
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(invented.body);
  });
});

/* ══ 5. THE BULLETIN'S LIFECYCLE OWNS THE DECISION ════════════════════════ */

describe("the assessment rides the bulletin's lifecycle", () => {
  test("an open blocker stops the approval, and the save itself is allowed", async () => {
    const w = await world("FeasApproveGate");
    const saved = await save(w, w.editor, {
      expectedRevision: 0, outcome: "BLOCKED",
      findings: [{ ...FINDING, severity: "BLOCKING", owner: "RESEARCH_DEVELOPMENT",
        title: "Sample did not prove wash shrinkage" }],
    });
    expect(saved.status).toBe(200);

    const file = await IeStyleFile.findById(w.file._id).lean();
    /* Saved and shareable — that is how R&D learns what to fix. */
    expect(feasibility.feasibilityGaps(file, { stage: "submitted" }).map((g) => g.code))
      .not.toContain("IE_FEASIBILITY_BLOCKED");
    /* And it cannot become the approved standard. */
    const approving = feasibility.feasibilityGaps(file, { stage: "approved" });
    expect(approving.map((g) => g.code)).toContain("IE_FEASIBILITY_BLOCKED");
    expect(approving[0].message).toMatch(/must be resolved before this standard can be approved/i);
  });

  test("a newer R&D technical pack marks the assessment as needing reassessment", async () => {
    const w = await world("FeasStaleSource");
    await save(w, w.editor, { expectedRevision: 0, outcome: "FEASIBLE", findings: [] });
    /* R&D approves a newer pack and the file is rebased onto it. */
    await IeStyleFile.updateOne({ _id: w.file._id }, { $set: { "source.technicalRevision": 3 } });
    const after = await read(w, w.editor);
    expect(after.body.assessment).toMatchObject({
      needsReassessment: true, basedOnTechnicalRevision: 2, currentTechnicalRevision: 3,
    });
    /* It is not silently carried forward as current. */
    expect(after.body.assessment.outcome).toBe("FEASIBLE");
    const gaps = feasibility.feasibilityGaps(await IeStyleFile.findById(w.file._id).lean(), { stage: "approved" });
    expect(gaps.map((g) => g.code)).toContain("IE_FEASIBILITY_STALE");
  });

  test("the draft is frozen while its bulletin is under review", async () => {
    const w = await world("FeasFrozenReview");
    await save(w, w.editor, { expectedRevision: 0, outcome: "FEASIBLE", findings: [] });
    await IeStyleFile.updateOne({ _id: w.file._id }, {
      $set: { bulletinReviewVersionId: new mongoose.Types.ObjectId(), bulletinReviewVersionNo: 1 },
    });
    const res = await save(w, w.editor, { expectedRevision: 1, outcome: "BLOCKED", findings: [] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_BULLETIN_VERSION_IN_REVIEW");
  });

  test("a frozen copy is evidence: it reads back and is never editable", async () => {
    const w = await world("FeasFrozen");
    await save(w, w.editor, {
      expectedRevision: 0, outcome: "FEASIBLE_WITH_CONDITIONS",
      findings: [FINDING],
      conditions: [{ text: "Folder arranged before bulk", owner: "INDUSTRIAL_ENGINEERING" }],
    });
    const file = await IeStyleFile.findById(w.file._id).lean();
    const frozen = feasibility.freezeFeasibility(file);
    expect(frozen.outcome).toBe("FEASIBLE_WITH_CONDITIONS");

    const version = await IeBulletinVersion.create({
      companyId: w.co._id, ieStyleFileId: w.file._id, sampleStyleId: w.style._id,
      versionNo: 1, state: "APPROVED", fileRevisionAtSubmit: 1,
      rows: [], sourceFingerprint: "fp", sourceApprovalDigest: "ad",
      submittedBy: new mongoose.Types.ObjectId(), submittedAt: new Date(),
      feasibility: frozen,
    });

    /* Editing the draft afterwards builds the NEXT assessment… */
    await save(w, w.editor, { expectedRevision: 1, outcome: "BLOCKED",
      findings: [{ ...FINDING, severity: "BLOCKING", owner: "RESEARCH_DEVELOPMENT" }] });

    /* …and what was approved is untouched. */
    const stored = await IeBulletinVersion.findById(version._id).lean();
    expect(stored.feasibility.outcome).toBe("FEASIBLE_WITH_CONDITIONS");
    expect(stored.feasibility.findings).toHaveLength(1);
    const published = feasibility.publishFeasibility(null, { frozen: stored.feasibility });
    expect(published.editable).toBe(false);
    expect(published.outcome).toBe("FEASIBLE_WITH_CONDITIONS");
  });

  test("an unassessed style blocks submission; an assessed one does not", async () => {
    const w = await world("FeasSubmitGate");
    const before = await IeStyleFile.findById(w.file._id).lean();
    expect(feasibility.feasibilityGaps(before, { stage: "submitted" })).toHaveLength(1);
    await save(w, w.editor, { expectedRevision: 0, outcome: "FEASIBLE", findings: [] });
    const after = await IeStyleFile.findById(w.file._id).lean();
    expect(feasibility.feasibilityGaps(after, { stage: "submitted" })).toEqual([]);
  });
});

/* ══ 6. THE PURE RULES ════════════════════════════════════════════════════ */

describe("the rules are pure, and shared with the gate", () => {
  test("outcomeProblems names each impossible combination", () => {
    const blocking = { severity: "BLOCKING", status: "OPEN", area: "MATERIALS", title: "x", owner: "RESEARCH_DEVELOPMENT" };
    expect(feasibility.outcomeProblems({ outcome: "FEASIBLE", findings: [blocking] })[0].code)
      .toBe("FEASIBLE_WITH_OPEN_BLOCKER");
    expect(feasibility.outcomeProblems({ outcome: "FEASIBLE_WITH_CONDITIONS", findings: [], conditions: [] })[0].code)
      .toBe("CONDITIONS_REQUIRED");
    expect(feasibility.outcomeProblems({ outcome: "BLOCKED", findings: [] })[0].code).toBe("BLOCKER_REQUIRED");
    /* A resolved blocker no longer blocks. */
    expect(feasibility.outcomeProblems({
      outcome: "FEASIBLE", findings: [{ ...blocking, status: "RESOLVED" }],
    })).toEqual([]);
  });

  test("an empty assessment is never published as feasible", () => {
    const published = feasibility.publishFeasibility({});
    expect(published).toMatchObject({ outcome: "NOT_ASSESSED", assessed: false, editable: true });
    expect(published.areas.every((a) => a.state === "NOT_CHECKED")).toBe(true);
  });
});

/* ══ 7. THE RULE IS PROSPECTIVE, AND NOTHING EXISTING IS INVALIDATED ══════
 *
 * The gate applies to the next submission ATTEMPT. It does not reach back:
 * versions already submitted, approved and released were decided under the
 * rules of their day, and they stay readable, usable and exactly as they were.
 * Nothing is backfilled and no date is consulted — a record simply either
 * carries an assessment or does not.
 */

describe("existing work is not invalidated", () => {
  /** A version approved before the assessment existed: no snapshot at all. */
  async function legacyApproved(w) {
    return IeBulletinVersion.create({
      companyId: w.co._id, ieStyleFileId: w.file._id, sampleStyleId: w.style._id,
      versionNo: 1, state: "APPROVED", fileRevisionAtSubmit: 1,
      rows: [], totals: { garmentSamMinutes: 5.65, samRowCount: 6 },
      sourceFingerprint: "legacy-fp", sourceApprovalDigest: "legacy-ad",
      submittedBy: new mongoose.Types.ObjectId(), submittedAt: new Date("2026-07-01"),
      approvedBy: new mongoose.Types.ObjectId(), approvedAt: new Date("2026-07-05"),
    });
  }

  test("a legacy approved version stays readable, and says the assessment was not recorded", async () => {
    const w = await world("FeasLegacy");
    const version = await legacyApproved(w);
    const viewer = await viewerIn(w.co);

    const res = await call(`/bulletin-versions/${version._id}`, { token: viewer.token, company: w.co._id });
    expect(res.status).toBe(200);
    expect(res.body.version.versionNo).toBe(1);
    expect(res.body.version.state).toBe("APPROVED");
    /* Absent on a version means nobody recorded one when it was submitted.
       It is NOT an error and it is NOT a pass. */
    expect(res.body.version.feasibility).toBeNull();
    const wire = JSON.stringify(res.body.version);
    expect(wire).not.toContain("FEASIBLE");
  });

  test("the totals, rows and approval of a legacy version are untouched by the new field", async () => {
    const w = await world("FeasLegacyIntact");
    const version = await legacyApproved(w);
    const before = await IeBulletinVersion.findById(version._id).lean();
    /* Reading it through the route changes nothing about it. */
    const viewer = await viewerIn(w.co);
    await call(`/bulletin-versions/${version._id}`, { token: viewer.token, company: w.co._id });
    const after = await IeBulletinVersion.findById(version._id).lean();
    expect(after).toEqual(before);
    expect(after.feasibility).toBeUndefined();
  });

  test("downstream records that name a legacy version stay valid", async () => {
    const w = await world("FeasDownstream");
    const version = await legacyApproved(w);
    /* A layout balanced against that version, as the layout model stores one. */
    const IeLineLayout = require("../../models/CMS_Models/IndustrialEngineering/IeLineLayout");
    const layout = await IeLineLayout.create({
      companyId: w.co._id, ieStyleFileId: w.file._id, sampleStyleId: w.style._id,
      bulletinRevision: 1, sourceFingerprint: "legacy-fp",
      ieBulletinVersionId: version._id, bulletinVersionNo: 1,
      status: "APPROVED", approvedRevision: 1,
      sourceRows: [], stations: [],
    });
    const stored = await IeLineLayout.findById(layout._id).lean();
    expect(stored.status).toBe("APPROVED");
    expect(String(stored.ieBulletinVersionId)).toBe(String(version._id));
    /* The assessment gate is about SUBMITTING a bulletin. It says nothing
       about a layout, a capacity standard or a release that already exists. */
    expect(feasibility.feasibilityGaps(await IeStyleFile.findById(w.file._id).lean(), { stage: "approved" })
      .every((g) => g.code.startsWith("IE_FEASIBILITY"))).toBe(true);
  });

  test("a reopened legacy file must be assessed before its NEXT submission", async () => {
    const w = await world("FeasReopened");
    await legacyApproved(w);
    /* The file carries no assessment, exactly as it did before the feature. */
    const file = await IeStyleFile.findById(w.file._id).lean();
    expect(file.feasibility).toBeUndefined();

    /* Its next submission is refused — the rule is prospective, not retroactive. */
    const gaps = feasibility.feasibilityGaps(file, { stage: "submitted" });
    expect(gaps.map((g) => g.code)).toEqual(["IE_FEASIBILITY_NOT_ASSESSED"]);

    /* And recording one clears it, without touching the approved version. */
    const saved = await save(w, w.editor, { expectedRevision: 0, outcome: "FEASIBLE", findings: [] });
    expect(saved.status).toBe(200);
    expect(feasibility.feasibilityGaps(await IeStyleFile.findById(w.file._id).lean(), { stage: "submitted" })).toEqual([]);
    const legacyAfter = await IeBulletinVersion.findOne({ ieStyleFileId: w.file._id }).lean();
    expect(legacyAfter.feasibility).toBeUndefined();
  });

  test("no absent assessment anywhere is read as feasible", async () => {
    const w = await world("FeasAbsentNeverPass");
    const version = await legacyApproved(w);
    const stored = await IeBulletinVersion.findById(version._id).lean();
    /* Three absences, three honest answers. */
    expect(feasibility.publishFeasibility({}).outcome).toBe("NOT_ASSESSED");
    expect(feasibility.publishFeasibility(await IeStyleFile.findById(w.file._id).lean()).outcome).toBe("NOT_ASSESSED");
    expect(stored.feasibility).toBeUndefined();
    for (const o of [feasibility.publishFeasibility({}), feasibility.publishFeasibility({ feasibility: null })]) {
      expect(o.assessed).toBe(false);
      expect(o.areas.every((a) => a.state === "NOT_CHECKED")).toBe(true);
    }
  });

  test("a changed R&D source must be reassessed before the next submission", async () => {
    const w = await world("FeasResubmit");
    await save(w, w.editor, { expectedRevision: 0, outcome: "FEASIBLE", findings: [] });
    await IeStyleFile.updateOne({ _id: w.file._id }, { $set: { "source.technicalRevision": 4 } });

    const file = await IeStyleFile.findById(w.file._id).lean();
    const { stale, basedOn, current } = feasibility.stalenessOf(file);
    expect({ stale, basedOn, current }).toEqual({ stale: true, basedOn: 2, current: 4 });
    expect(feasibility.feasibilityGaps(file, { stage: "approved" }).map((g) => g.code))
      .toContain("IE_FEASIBILITY_STALE");

    /* Reassessing against the new pack clears it — the judgement is re-made,
       not re-dated. */
    const again = await save(w, w.editor, { expectedRevision: 1, outcome: "FEASIBLE", findings: [] });
    expect(again.body.assessment.basedOnTechnicalRevision).toBe(4);
    expect(again.body.assessment.needsReassessment).toBe(false);
  });
});
