// test/industrial-engineering/ie-development.route.test.js
//
// IE DEVELOPMENT — THE PRE-ORDER REGISTER, AT THE WIRE AND IN THE VOCABULARY.
//
// The claims worth holding are the ones the register would be unsafe without:
//
//   · nobody reaches it without a session and an `ie` grant, and the company is
//     the ACTOR'S — a request cannot name somebody else's;
//   · a style with no approved technical revision is VISIBLE and TRACKING ONLY,
//     because "IE must see the work coming" and "IE may act on it" are two
//     different permissions and the register must not conflate them;
//   · `canOpenEngineeringFile` is true for exactly one classification and only
//     for an actor who could actually perform the POST — and the refusal is
//     always NAMED, never a bare false;
//   · the Merchandising lineage is never published as PROVEN, because nothing
//     stored can prove it (see the audit's §4) — and an absent development file
//     and an unproven one are different statements;
//   · every view is a projection, each row falls in exactly one of them, and
//     the counts therefore sum to the `all` count;
//   · NEEDS_ATTENTION outranks RELEASED, so a released standard built on a
//     superseded technical revision is not hidden behind a green tab;
//   · counts are withheld rather than truncated past the scan cap;
//   · no Journey, enquiry, buyer, price, supplier, operator or barcode field
//     leaves any payload — checked by walking every key, not by reading one
//     fixture;
//   · and reading the register WRITES NOTHING, including opening no file.
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
const IeOperation = require("../../models/CMS_Models/IndustrialEngineering/IeOperation");
const { DevelopmentFile } = require("../../models/CMS_Models/Merchandising/Development");

const ieDevelopment = require("../../services/industrialEngineering/ieDevelopment.service");
const { CLASSIFICATION, VIEW, OWNER, NEXT_ACTION, LINEAGE, OPEN_BLOCKED } = ieDevelopment;

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
  const email = `ied${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "I", lastName: `D${n}`, email, biometricId: `IED${n}`,
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
      { id: String(emp._id), email, name: "IE Actor", role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

/** A company whose Sales spine can PROVE the company of a style under it. */
async function company(name) {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `${name} ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const accountId = new mongoose.Types.ObjectId();
  const journey = await SalesJourney.create({
    journeyId: `SJ-${name}-${n}`, companyId: co._id, accountId,
    ownerId: new mongoose.Types.ObjectId(), ownerName: "Owner",
    name: `Journey ${name}`, isActive: true,
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-${name}-${n}`, journeyId: journey._id, accountId,
    companyId: co._id, title: `Enquiry ${name}`, isActive: true,
    products: [{ product: "Tee", quantity: 500 }],
  });
  return { co, journey, enquiry };
}

/**
 * One style under a company's spine.
 *
 * `approvedRevision` freezes a real approved technical revision, because the
 * whole register turns on `approvedRevisionOf` and a `status: "approved"` with
 * no frozen revision is a state the production data actually contains.
 */
async function style(world, {
  code, stage = "brief", materialsStatus = "pending", sampleStatus = "not_started",
  technicalStatus = "draft", approvedRevision = null, extraApprovedCopies = 0,
} = {}) {
  const n = ++seq;
  const revisions = [];
  if (approvedRevision !== null) {
    for (let i = 0; i <= extraApprovedCopies; i += 1) {
      revisions.push({
        revision: approvedRevision, submittedAt: new Date("2026-08-01"),
        decidedAt: new Date("2026-08-05"), outcome: "approved",
      });
    }
  }
  /* One style per (journey, productName, variantKey) — the collection carries a
     unique index on exactly that, so several styles under one company's journey
     need distinct product identities rather than three copies of "Tee". */
  return SampleStyle.create({
    sampleStyleId: `SS-DEV-${n}`,
    productName: `Tee ${n}`, styleCode: code || `DEV-${n}`,
    variantLabel: "Navy", variantKey: `v${n}`,
    journeyId: world.journey._id, enquiryId: world.enquiry._id,
    stage, materials: { status: materialsStatus, rawItems: [] },
    sample: { status: sampleStatus },
    techSheet: { technical: { status: technicalStatus }, technicalRevisions: revisions },
  });
}

/** Merchandising's own record, matched to a style by stored reference only. */
const development = (world, styleDoc, over = {}) => DevelopmentFile.create({
  developmentNumber: `DEV-${++seq}`, companyId: world.co._id,
  journeyId: world.journey._id, productLineRef: `PL-${seq}`,
  sampleStyleId: styleDoc._id, lifecycleStatus: "ACTIVE", ...over,
});

/**
 * An engineering file for a style, at whatever position the test needs.
 *
 * Written directly rather than through the routes: the register READS these
 * records, and building each one through eight HTTP calls would make the suite
 * a test of the write path it is not about.
 */
async function engineeringFile(world, styleDoc, {
  technicalRevision = 3, rows = 1, samPerRow = 0.5, approvedVersionNo = null,
  reviewVersionNo = null, operationId = null,
} = {}) {
  const opId = operationId || new mongoose.Types.ObjectId();
  return IeStyleFile.create({
    companyId: world.co._id, sampleStyleId: styleDoc._id,
    source: {
      technicalRevision, approvedAt: new Date("2026-08-05"),
      submittedAt: new Date("2026-08-01"), operationCount: rows,
    },
    bulletin: {
      rows: Array.from({ length: rows }, (_, i) => ({
        rowId: `r${i + 1}`, sequence: i + 1,
        ieOperationId: opId, ieOperationRevision: 1,
        operationCode: `OP-${i + 1}`, operationName: `Operation ${i + 1}`,
        proposedSamMinutes: samPerRow,
      })),
    },
    ...(approvedVersionNo ? { currentApprovedVersionNo: approvedVersionNo, currentApprovedBulletinVersionId: new mongoose.Types.ObjectId() } : {}),
    ...(reviewVersionNo ? { bulletinReviewVersionNo: reviewVersionNo, bulletinReviewVersionId: new mongoose.Types.ObjectId() } : {}),
  });
}

const ieViewer = (co) => actor({ companies: [co], grants: { ie: "viewer" } });
const ieEditor = (co) => actor({ companies: [co], grants: { ie: "editor" } });

/** Every leaf value of a payload, with the path that reached it. */
function walk(value, path = "$", out = []) {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, `${path}[${i}]`, out));
    return out;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`, out);
    return out;
  }
  out.push([path, value]);
  return out;
}

/* ══ 1. WHO MAY OPEN THE DOOR ══════════════════════════════════════════════ */

describe("access", () => {
  test("no session reaches nothing", async () => {
    for (const path of ["/development", "/development/abc"]) {
      expect((await call(path)).status).toBe(401);
    }
  });

  test("an employee with no IE grant is refused, and told which grant", async () => {
    const w = await company("NoGrant");
    const a = await actor({ companies: [w.co], grants: {} });
    for (const path of ["/development", "/development/abc"]) {
      const res = await call(path, { token: a.token, company: w.co._id });
      expect(res.status).toBe(403);
      expect(res.body.error?.code || res.body.code).toBe("FORBIDDEN");
    }
  });

  test("a grant in another department is not an IE grant", async () => {
    const w = await company("OtherDept");
    for (const slug of ["merchandiser", "sales", "production-supervisor"]) {
      const a = await actor({ companies: [w.co], grants: { [slug]: "owner" } });
      expect((await call("/development", { token: a.token, company: w.co._id })).status).toBe(403);
    }
  });

  test("a viewer reads the register — this boundary is a read", async () => {
    const w = await company("Viewer");
    await style(w, { code: "V-1" });
    const a = await ieViewer(w.co);
    const res = await call("/development", { token: a.token, company: w.co._id });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

/* ══ 2. THE COMPANY IS THE ACTOR'S ═════════════════════════════════════════ */

describe("company scope", () => {
  test("a style belonging to another company never appears, and its detail is NOT_FOUND", async () => {
    const mine = await company("Mine");
    const theirs = await company("Theirs");
    await style(mine, { code: "MINE-1" });
    const foreign = await style(theirs, { code: "THEIRS-1" });

    const a = await ieViewer(mine.co);
    const list = await call("/development?view=all", { token: a.token, company: mine.co._id });
    expect(list.body.rows.map((r) => r.reference)).toEqual(["MINE-1"]);

    const detail = await call(`/development/${foreign._id}`, { token: a.token, company: mine.co._id });
    expect(detail.status).toBe(404);
  });

  test("the company header cannot MOVE an actor into a company they do not hold", async () => {
    /* `resolveCompanyForActor` treats a requested company as a SELECTOR among
       memberships the actor holds, never as authority. So a single-company
       actor naming somebody else's company is not refused — they are simply
       resolved into their own, which is the fail-closed answer. What must
       never happen is the foreign company's rows coming back, and that is what
       this asserts rather than a status code. */
    const mine = await company("Belong");
    const theirs = await company("NotMine");
    await style(mine, { code: "OWN-1" });
    await style(theirs, { code: "SECRET-1" });
    const a = await ieViewer(mine.co);

    const res = await call("/development?view=all", { token: a.token, company: theirs.co._id });
    expect(res.status).toBe(200);
    expect(res.body.rows.map((r) => r.reference)).toEqual(["OWN-1"]);
  });

  test("absent, foreign and malformed style ids are one indistinguishable refusal", async () => {
    const mine = await company("Oracle");
    const theirs = await company("OracleOther");
    const foreign = await style(theirs, { code: "F-1" });
    const a = await ieViewer(mine.co);

    const answers = [];
    for (const id of ["not-an-id", String(new mongoose.Types.ObjectId()), String(foreign._id)]) {
      const res = await call(`/development/${id}`, { token: a.token, company: mine.co._id });
      answers.push(`${res.status}:${res.body.error?.code || res.body.code}:${res.body.error?.message || res.body.message}`);
    }
    expect(new Set(answers).size).toBe(1);
  });
});

/* ══ 3. UPSTREAM IS VISIBLE AND TRACKING ONLY ══════════════════════════════ */

describe("upstream development", () => {
  test("a style with no approved technical revision is on the register, tracking only", async () => {
    const w = await company("Upstream");
    await style(w, { code: "UP-1", technicalStatus: "draft" });
    const a = await ieEditor(w.co);

    const res = await call(`/development?view=${VIEW.UPSTREAM}`, { token: a.token, company: w.co._id });
    expect(res.body.rows).toHaveLength(1);
    const row = res.body.rows[0];
    expect(row.classification).toBe(CLASSIFICATION.UPSTREAM);
    expect(row.trackingOnly).toBe(true);
    /* An editor is STILL refused the control: the refusal is about the source,
       not about the seat, and it says which. */
    expect(row.canOpenEngineeringFile).toBe(false);
    expect(row.openBlockedReason).toBe(OPEN_BLOCKED.SOURCE_VERSION_REQUIRED);
    expect(row.gaps.some((g) => g.code === "TECHNICAL_RECORD_NOT_APPROVED"
      && g.owner === OWNER.RND)).toBe(true);
  });

  test("a style still at Sales' brief stage owes its move to SALES, not to IE", async () => {
    const w = await company("AtBrief");
    await style(w, { code: "BRIEF-1", stage: "brief" });
    const a = await ieViewer(w.co);
    const res = await call(`/development?view=${VIEW.UPSTREAM}`, { token: a.token, company: w.co._id });
    expect(res.body.rows[0].owner).toBe(OWNER.SALES);
    expect(res.body.rows[0].nextAction).toBe(NEXT_ACTION.SEND_STYLE_TO_MERCHANDISING);
  });

  test("a Merchandising file awaiting Sales' release owes its move to MERCHANDISING", async () => {
    const w = await company("AwaitRelease");
    const s = await style(w, { code: "REL-1", stage: "materials" });
    await development(w, s, { lifecycleStatus: "APPROVED", currentBomRevisionNo: 1 });
    const a = await ieViewer(w.co);
    const res = await call(`/development?view=${VIEW.UPSTREAM}`, { token: a.token, company: w.co._id });
    expect(res.body.rows[0].owner).toBe(OWNER.MERCHANDISING);
    expect(res.body.rows[0].nextAction).toBe(NEXT_ACTION.RELEASE_SELECTION_TO_RND);
  });

  test("a development file Merchandising CLOSED is not reported as selection in progress", async () => {
    const w = await company("Halted");
    const s = await style(w, { code: "HALT-1", stage: "materials" });
    await development(w, s, { lifecycleStatus: "CLOSED" });
    const a = await ieViewer(w.co);
    const res = await call(`/development?view=${VIEW.UPSTREAM}`, { token: a.token, company: w.co._id });
    const row = res.body.rows[0];
    expect(row.nextAction).toBe(NEXT_ACTION.NOTHING_OUTSTANDING);
    expect(row.gaps.some((g) => g.code === "MERCHANDISING_DEVELOPMENT_HALTED")).toBe(true);
  });
});

/* ══ 4. THE MERCHANDISING LINEAGE IS NEVER PROVEN ══════════════════════════ */

describe("merchandising lineage", () => {
  test("a released development file naming the style is UNPROVEN, never PROVEN", async () => {
    const w = await company("Lineage");
    const s = await style(w, { code: "LIN-1", technicalStatus: "approved", approvedRevision: 3 });
    await development(w, s, {
      lifecycleStatus: "RELEASED_TO_RND", currentBomRevisionNo: 2,
      releasedBomRevisionNo: 2, releasedToRndAt: new Date("2026-09-01"),
    });
    const a = await ieViewer(w.co);

    const res = await call("/development?view=all", { token: a.token, company: w.co._id });
    const row = res.body.rows[0];
    expect(row.merchandising.lineage).toBe(LINEAGE.UNPROVEN);
    expect(row.merchandising.releasedBomRevisionNo).toBe(2);
    expect(row.gaps.some((g) => g.code === "MERCHANDISING_LINEAGE_UNPROVEN")).toBe(true);

    const detail = await call(`/development/${s._id}`, { token: a.token, company: w.co._id });
    expect(detail.body.evidence.lineage.state).toBe(LINEAGE.UNPROVEN);
    expect(detail.body.evidence.lineage.note).toMatch(/not proved/i);
  });

  test("no development file at all is ABSENT — a different statement from UNPROVEN", async () => {
    const w = await company("NoLineage");
    const s = await style(w, { code: "NOL-1", technicalStatus: "approved", approvedRevision: 3 });
    const a = await ieViewer(w.co);

    const res = await call("/development?view=all", { token: a.token, company: w.co._id });
    expect(res.body.rows[0].merchandising.lineage).toBe(LINEAGE.ABSENT);
    expect(res.body.rows[0].gaps.some((g) => g.code === "MERCHANDISING_DEVELOPMENT_ABSENT")).toBe(true);

    const detail = await call(`/development/${s._id}`, { token: a.token, company: w.co._id });
    expect(detail.body.evidence.merchandising).toBeNull();
    expect(detail.body.evidence.lineage.state).toBe(LINEAGE.ABSENT);
  });

  test("two development files naming one style are not silently resolved to one", async () => {
    const w = await company("TwoFiles");
    const s = await style(w, { code: "TWO-1", technicalStatus: "approved", approvedRevision: 3 });
    await development(w, s, { lifecycleStatus: "ACTIVE" });
    await development(w, s, { lifecycleStatus: "RELEASED_TO_RND", releasedBomRevisionNo: 1 });
    const a = await ieViewer(w.co);

    const res = await call("/development?view=all", { token: a.token, company: w.co._id });
    expect(res.body.rows[0].merchandising.duplicate).toBe(true);
  });

  test("PROVEN is in the vocabulary and is never returned by anything", async () => {
    /* Declared so the frontend that renders three states needs no fourth added
       to it on the day IE-D0 lands — but nothing composes it today. */
    expect(LINEAGE.PROVEN).toBe("PROVEN");
    const w = await company("NeverProven");
    const s = await style(w, { code: "NP-1", technicalStatus: "approved", approvedRevision: 3 });
    await development(w, s, { lifecycleStatus: "RELEASED_TO_RND", releasedBomRevisionNo: 9 });
    const a = await ieViewer(w.co);
    const res = await call("/development?view=all", { token: a.token, company: w.co._id });
    const detail = await call(`/development/${s._id}`, { token: a.token, company: w.co._id });
    for (const payload of [res.body, detail.body]) {
      expect(walk(payload).some(([, v]) => v === "PROVEN")).toBe(false);
    }
  });
});

/* ══ 5. READY FOR IE, AND WHO MAY OPEN THE FILE ════════════════════════════ */

describe("opening the engineering file", () => {
  test("an approved source with no file is READY_FOR_IE and an editor may open it", async () => {
    const w = await company("Ready");
    await style(w, { code: "RDY-1", technicalStatus: "approved", approvedRevision: 4 });
    const a = await ieEditor(w.co);

    const res = await call(`/development?view=${VIEW.READY}`, { token: a.token, company: w.co._id });
    const row = res.body.rows[0];
    expect(row.classification).toBe(CLASSIFICATION.READY_FOR_IE);
    expect(row.trackingOnly).toBe(false);
    expect(row.canOpenEngineeringFile).toBe(true);
    expect(row.openBlockedReason).toBeNull();
    expect(row.rnd.revision).toBe(4);
    expect(row.owner).toBe(OWNER.IE);
    expect(row.nextAction).toBe(NEXT_ACTION.OPEN_ENGINEERING_FILE);
  });

  test("a VIEWER sees the same row and is not offered the control", async () => {
    const w = await company("ReadyViewer");
    await style(w, { code: "RDYV-1", technicalStatus: "approved", approvedRevision: 4 });
    const a = await ieViewer(w.co);

    const res = await call(`/development?view=${VIEW.READY}`, { token: a.token, company: w.co._id });
    const row = res.body.rows[0];
    expect(row.classification).toBe(CLASSIFICATION.READY_FOR_IE);
    expect(row.canOpenEngineeringFile).toBe(false);
    expect(row.openBlockedReason).toBe(OPEN_BLOCKED.ROLE_REQUIRED);
  });

  test("two approved revisions carrying one number are AMBIGUOUS, not resolved by order", async () => {
    const w = await company("Ambiguous");
    await style(w, {
      code: "AMB-1", technicalStatus: "approved", approvedRevision: 3, extraApprovedCopies: 1,
    });
    const a = await ieEditor(w.co);

    const res = await call("/development?view=all", { token: a.token, company: w.co._id });
    const row = res.body.rows[0];
    expect(row.classification).toBe(CLASSIFICATION.UPSTREAM);
    expect(row.rnd.ambiguous).toBe(true);
    expect(row.openBlockedReason).toBe(OPEN_BLOCKED.SOURCE_VERSION_AMBIGUOUS);
    expect(row.nextAction).toBe(NEXT_ACTION.RECONCILE_DUPLICATE_APPROVED_REVISION);
  });

  test("an existing file replaces the control with the reason ALREADY_OPEN", async () => {
    const w = await company("AlreadyOpen");
    const s = await style(w, { code: "AO-1", technicalStatus: "approved", approvedRevision: 3 });
    const file = await engineeringFile(w, s, { technicalRevision: 3 });
    const a = await ieEditor(w.co);

    const res = await call("/development?view=all", { token: a.token, company: w.co._id });
    const row = res.body.rows[0];
    expect(row.canOpenEngineeringFile).toBe(false);
    expect(row.openBlockedReason).toBe(OPEN_BLOCKED.ALREADY_OPEN);
    expect(row.engineering.fileId).toBe(String(file._id));
  });
});

/* ══ 6. ONE FILE, TWO DOORS — THE SAME fileId ══════════════════════════════ */

describe("shared file identity", () => {
  test("the register's fileId is the file the style-first endpoint returns", async () => {
    const w = await company("OneFile");
    const s = await style(w, { code: "OF-1", technicalStatus: "approved", approvedRevision: 3 });
    await engineeringFile(w, s, { technicalRevision: 3 });
    const a = await ieEditor(w.co);

    const register = await call("/development?view=all", { token: a.token, company: w.co._id });
    const workspace = await call(`/styles/${s._id}/engineering-file`, { token: a.token, company: w.co._id });
    expect(workspace.status).toBe(200);
    expect(register.body.rows[0].engineering.fileId).toBe(workspace.body.file.fileId);
  });

  test("the register's source revision is the revision the file is engineered from", async () => {
    const w = await company("SameRevision");
    const s = await style(w, { code: "SR-1", technicalStatus: "approved", approvedRevision: 7 });
    await engineeringFile(w, s, { technicalRevision: 7 });
    const a = await ieViewer(w.co);
    const res = await call("/development?view=all", { token: a.token, company: w.co._id });
    expect(res.body.rows[0].engineering.sourceTechnicalRevision).toBe(7);
    expect(res.body.rows[0].rnd.revision).toBe(7);
  });
});

/* ══ 7. NEEDS ATTENTION OUTRANKS EVERYTHING BELOW IT ══════════════════════ */

describe("needs attention", () => {
  test("a file engineered from a superseded revision is NEEDS_ATTENTION", async () => {
    const w = await company("Superseded");
    const s = await style(w, { code: "SUP-1", technicalStatus: "approved", approvedRevision: 5 });
    await engineeringFile(w, s, { technicalRevision: 3, approvedVersionNo: 1 });
    const a = await ieViewer(w.co);

    const res = await call(`/development?view=${VIEW.NEEDS_ATTENTION}`, { token: a.token, company: w.co._id });
    expect(res.body.rows).toHaveLength(1);
    const row = res.body.rows[0];
    expect(row.classification).toBe(CLASSIFICATION.NEEDS_ATTENTION);
    expect(row.nextAction).toBe(NEXT_ACTION.REBASE_ONTO_NEW_TECHNICAL_VERSION);
    const stale = row.gaps.find((g) => g.code === "IE_SOURCE_VERSION_SUPERSEDED");
    expect(stale.details).toEqual({ fileSourceRevision: 3, approvedRevision: 5 });
  });

  test("a bulletin still naming a RETIRED library operation is NEEDS_ATTENTION", async () => {
    const w = await company("Retired");
    const s = await style(w, { code: "RET-1", technicalStatus: "approved", approvedRevision: 3 });
    const retired = await IeOperation.create({
      companyId: w.co._id, code: `RET${++seq}`, name: "Retired operation",
      machineType: "SNLS", status: "RETIRED", revision: 1,
    });
    await engineeringFile(w, s, { technicalRevision: 3, operationId: retired._id, approvedVersionNo: 1 });
    const a = await ieViewer(w.co);

    const res = await call(`/development?view=${VIEW.NEEDS_ATTENTION}`, { token: a.token, company: w.co._id });
    const row = res.body.rows[0];
    expect(row.classification).toBe(CLASSIFICATION.NEEDS_ATTENTION);
    expect(row.nextAction).toBe(NEXT_ACTION.REPLACE_RETIRED_OPERATION);
    expect(row.gaps.some((g) => g.code === "IE_BULLETIN_OPERATION_RETIRED")).toBe(true);
  });
});

/* ══ 8. EVERY VIEW IS A PROJECTION, AND THE COUNTS SUM ════════════════════ */

describe("views and counts", () => {
  /** Five styles, one per position, in the one company. */
  async function population() {
    const w = await company("Views");
    await style(w, { code: "P-UPSTREAM", technicalStatus: "draft" });
    await style(w, { code: "P-READY", technicalStatus: "approved", approvedRevision: 3 });

    const inEng = await style(w, { code: "P-ENG", technicalStatus: "approved", approvedRevision: 3 });
    await engineeringFile(w, inEng, { technicalRevision: 3, rows: 2 });

    const review = await style(w, { code: "P-REVIEW", technicalStatus: "approved", approvedRevision: 3 });
    await engineeringFile(w, review, { technicalRevision: 3, reviewVersionNo: 2 });

    const stale = await style(w, { code: "P-STALE", technicalStatus: "approved", approvedRevision: 6 });
    await engineeringFile(w, stale, { technicalRevision: 2, approvedVersionNo: 1 });

    return w;
  }

  test("each view returns exactly its own classification", async () => {
    const w = await population();
    const a = await ieViewer(w.co);
    const expected = {
      [VIEW.UPSTREAM]: ["P-UPSTREAM"],
      [VIEW.READY]: ["P-READY"],
      [VIEW.IN_ENGINEERING]: ["P-ENG"],
      [VIEW.AWAITING_REVIEW]: ["P-REVIEW"],
      [VIEW.NEEDS_ATTENTION]: ["P-STALE"],
      [VIEW.APPROVED]: [],
      [VIEW.RELEASED]: [],
    };
    for (const [view, refs] of Object.entries(expected)) {
      const res = await call(`/development?view=${view}`, { token: a.token, company: w.co._id });
      expect(res.body.view).toBe(view);
      expect(res.body.rows.map((r) => r.reference).sort()).toEqual(refs.sort());
    }
    const all = await call("/development?view=all", { token: a.token, company: w.co._id });
    expect(all.body.rows).toHaveLength(5);
  });

  test("the counts are published and sum to the all count", async () => {
    const w = await population();
    const a = await ieViewer(w.co);
    const res = await call("/development", { token: a.token, company: w.co._id });
    const counts = res.body.counts;
    expect(res.body.countsState).toBe("COMPLETE");
    const parts = Object.entries(counts).filter(([k]) => k !== VIEW.ALL).map(([, v]) => v);
    expect(parts.reduce((a2, b) => a2 + b, 0)).toBe(counts[VIEW.ALL]);
    expect(counts[VIEW.ALL]).toBe(5);
  });

  test("a search narrows the rows and never the counts", async () => {
    const w = await population();
    const a = await ieViewer(w.co);
    const res = await call("/development?view=all&q=P-READY", { token: a.token, company: w.co._id });
    expect(res.body.rows.map((r) => r.reference)).toEqual(["P-READY"]);
    expect(res.body.counts[VIEW.ALL]).toBe(5);
    expect(res.body.searched).toBe(true);
  });

  test("a company owning no Sales parent gets truthful zeros, not an error", async () => {
    const co = await Acc_Company.create({
      companyName: `Empty ${++seq}`, booksFromDate: new Date("2026-04-01"),
    });
    const a = await actor({ companies: [{ _id: co._id }], grants: { ie: "viewer" } });
    const res = await call("/development?view=all", { token: a.token, company: co._id });
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([]);
    expect(res.body.counts[VIEW.ALL]).toBe(0);
    expect(res.body.countsState).toBe("COMPLETE");
  });

  test("a view this register does not have is refused by name", async () => {
    const w = await company("BadView");
    const a = await ieViewer(w.co);
    const res = await call("/development?view=my-work", { token: a.token, company: w.co._id });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error?.details?.field).toBe("view");
  });
});

/* ══ 9. PAGING ════════════════════════════════════════════════════════════ */

describe("cursor paging", () => {
  test("a page names its bound, and the cursor continues it without repeating a row", async () => {
    const w = await company("Paging");
    for (let i = 0; i < 5; i += 1) {
      await style(w, { code: `PG-${i}`, technicalStatus: "draft" });
    }
    const a = await ieViewer(w.co);

    const first = await call("/development?view=all&limit=2", { token: a.token, company: w.co._id });
    expect(first.body.limit).toBe(2);
    expect(first.body.rows).toHaveLength(2);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.sort).toBe("updatedAt:desc,_id:desc");

    const second = await call(
      `/development?view=all&limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`,
      { token: a.token, company: w.co._id },
    );
    expect(second.body.rows).toHaveLength(2);
    const seen = [...first.body.rows, ...second.body.rows].map((r) => r.styleId);
    expect(new Set(seen).size).toBe(4);
  });

  test("a marker this list did not issue is refused rather than restarting page one", async () => {
    const w = await company("BadCursor");
    await style(w, { code: "BC-1" });
    const a = await ieViewer(w.co);
    const res = await call("/development?view=all&cursor=not-a-marker", { token: a.token, company: w.co._id });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error?.details?.field).toBe("cursor");
  });

  test("a page size must be a whole number", async () => {
    const w = await company("BadLimit");
    const a = await ieViewer(w.co);
    for (const limit of ["0", "-3", "2.5", "many"]) {
      const res = await call(`/development?limit=${limit}`, { token: a.token, company: w.co._id });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.error?.details?.field).toBe("limit");
    }
  });
});

/* ══ 10. WHAT MAY NOT LEAVE ═══════════════════════════════════════════════ */

describe("disclosure", () => {
  test("no Journey, enquiry, buyer, price, supplier, operator or barcode reaches a payload", async () => {
    const w = await company("Disclosure");
    const s = await style(w, { code: "DIS-1", technicalStatus: "approved", approvedRevision: 3 });
    await development(w, s, { lifecycleStatus: "RELEASED_TO_RND", releasedBomRevisionNo: 1 });
    await engineeringFile(w, s, { technicalRevision: 3 });
    const a = await ieViewer(w.co);

    const forbidden = /journey|enquiry|buyer|customer|account|price|margin|quotation|supplier|vendor|rate|salary|cost|operator|employee|barcode|machineId/i;
    for (const path of ["/development?view=all", `/development/${s._id}`]) {
      const res = await call(path, { token: a.token, company: w.co._id });
      const offending = walk(res.body).map(([p]) => p).filter((p) => forbidden.test(p));
      expect(offending).toEqual([]);
      /* And no VALUE is one of the ids the proof used, either. */
      const values = walk(res.body).map(([, v]) => String(v));
      expect(values).not.toContain(String(w.journey._id));
      expect(values).not.toContain(String(w.enquiry._id));
    }
  });
});

/* ══ 11. AND READING WRITES NOTHING ══════════════════════════════════════ */

describe("a read writes nothing", () => {
  test("no mutation path is reached, and no engineering file is created", async () => {
    const w = await company("NoWrite");
    const s = await style(w, { code: "NW-1", technicalStatus: "approved", approvedRevision: 3 });
    const a = await ieEditor(w.co);

    /* Spies installed AFTER every fixture exists, so only the reads are
       measured — and every verb mongoose offers, not a chosen few. */
    const before = await IeStyleFile.countDocuments({ companyId: w.co._id });
    const spies = [
      jest.spyOn(mongoose.Model.prototype, "save"),
      ...["updateOne", "updateMany", "findOneAndUpdate", "findByIdAndUpdate",
        "findOneAndReplace", "replaceOne", "bulkWrite", "insertMany", "create",
        "deleteOne", "deleteMany", "findOneAndDelete", "findByIdAndDelete"]
        .map((name) => jest.spyOn(mongoose.Model, name)),
    ];

    try {
      for (const path of [
        "/development", "/development?view=all", "/development?view=upstream&q=NW",
        `/development/${s._id}`, `/development/${new mongoose.Types.ObjectId()}`,
      ]) {
        const res = await call(path, { token: a.token, company: w.co._id });
        expect([200, 404]).toContain(res.status);
      }
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    /* And the register did not open a file as a side effect of being read. */
    expect(await IeStyleFile.countDocuments({ companyId: w.co._id })).toBe(before);
  });
});

/* ══ 12. THE VOCABULARY, WITHOUT A DATABASE ═══════════════════════════════
 *
 * `classify` is pure, which is what makes the two states the demo data cannot
 * reach — an approved standard with no release, and a release — assertable at
 * all. They would otherwise be the two views nothing ever proved. */

describe("classify (pure)", () => {
  const sales = { stage: "rnd", materialsStatus: "approved", sampleStatus: "approved" };
  const technical = { status: "approved", approved: true, ambiguous: false, revision: 3, revisionCount: 1 };
  const merchandising = { lineage: LINEAGE.ABSENT, developmentNumber: "", lifecycleStatus: "" };
  const engineering = (over = {}) => ({
    fileId: "f1", fileRevision: 2, sourceTechnicalRevision: 3, sourceCycleNo: 1,
    bulletinRowCount: 4, bulletinState: "APPROVED", approvedVersionNo: 1, reviewVersionNo: null,
    layoutState: "APPROVED", capacityState: "APPROVED", releaseState: "NONE", releaseNo: null,
    samMinutes: 4, samComplete: true, ...over,
  });
  const run = ({ engineering: eng, ...over } = {}) => ieDevelopment.classify({
    sales, technical, merchandising,
    currentApprovedRevision: 3, mayWrite: true, ...over,
    /* After the spread, deliberately: `engineering` is a PARTIAL in the test's
       own vocabulary and must be expanded into the full shape rather than
       replacing it. */
    engineering: engineering(eng),
  });

  test("bulletin, layout and capacity approved with no release is APPROVED_STANDARD", () => {
    const out = run();
    expect(out.classification).toBe(CLASSIFICATION.APPROVED_STANDARD);
    expect(out.nextAction).toBe(NEXT_ACTION.ISSUE_ENGINEERING_RELEASE);
    expect(out.gaps.some((g) => g.code === "ENGINEERING_RELEASE_NOT_ISSUED")).toBe(true);
  });

  test("an approved bulletin with no layout is APPROVED_STANDARD and says what is missing", () => {
    const out = run({ engineering: { layoutState: "NONE", capacityState: "NONE" } });
    expect(out.classification).toBe(CLASSIFICATION.APPROVED_STANDARD);
    expect(out.nextAction).toBe(NEXT_ACTION.BUILD_LINE_LAYOUT);
    expect(out.gaps.map((g) => g.code)).toContain("LINE_LAYOUT_NOT_APPROVED");
    expect(out.gaps.map((g) => g.code)).toContain("CAPACITY_STANDARD_NOT_APPROVED");
    /* Not yet issuable, so it is not reported as awaiting a release. */
    expect(out.gaps.some((g) => g.code === "ENGINEERING_RELEASE_NOT_ISSUED")).toBe(false);
  });

  test("a draft layout is not the same answer as no layout", () => {
    expect(run({ engineering: { layoutState: "DRAFT" } }).nextAction)
      .toBe(NEXT_ACTION.APPROVE_LINE_LAYOUT);
    expect(run({ engineering: { layoutState: "NONE" } }).nextAction)
      .toBe(NEXT_ACTION.BUILD_LINE_LAYOUT);
  });

  test("an issued release is RELEASED, owed by nobody", () => {
    const out = run({ engineering: { releaseState: "ISSUED", releaseNo: 1 } });
    expect(out.classification).toBe(CLASSIFICATION.RELEASED);
    expect(out.owner).toBe(OWNER.NOBODY);
    expect(out.nextAction).toBe(NEXT_ACTION.NOTHING_OUTSTANDING);
  });

  test("a RELEASED file on a superseded revision is NEEDS_ATTENTION, not RELEASED", () => {
    const out = run({
      engineering: { releaseState: "ISSUED", releaseNo: 1, sourceTechnicalRevision: 2 },
      currentApprovedRevision: 3,
    });
    expect(out.classification).toBe(CLASSIFICATION.NEEDS_ATTENTION);
    expect(out.nextAction).toBe(NEXT_ACTION.REBASE_ONTO_NEW_TECHNICAL_VERSION);
  });

  test("an empty bulletin is IN_ENGINEERING and asks for the source route to be mapped", () => {
    const out = run({
      engineering: {
        bulletinState: "NONE", bulletinRowCount: 0, approvedVersionNo: null,
        samComplete: false, layoutState: "NONE", capacityState: "NONE",
      },
    });
    expect(out.classification).toBe(CLASSIFICATION.IN_ENGINEERING);
    expect(out.nextAction).toBe(NEXT_ACTION.MAP_SOURCE_ROUTE_TO_LIBRARY);
  });

  test("a returned bulletin version is NEEDS_ATTENTION and editable again", () => {
    const out = run({
      engineering: { bulletinState: "RETURNED", approvedVersionNo: null, layoutState: "NONE", capacityState: "NONE" },
    });
    expect(out.classification).toBe(CLASSIFICATION.NEEDS_ATTENTION);
    expect(out.nextAction).toBe(NEXT_ACTION.REWORK_RETURNED_BULLETIN);
  });

  test("every classification reachable from classify is one a view names", () => {
    const named = new Set(Object.values(ieDevelopment.VIEW_CLASSIFICATION));
    for (const c of Object.values(CLASSIFICATION)) expect(named.has(c)).toBe(true);
  });
});
