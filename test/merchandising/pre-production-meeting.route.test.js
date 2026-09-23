// test/merchandising/pre-production-meeting.route.test.js
//
// THE PRE-PRODUCTION MEETING — THE CLAIMS THAT MAKE A MINUTE WORTH KEEPING.
//
// A minute is evidence or it is nothing. Every test here is a way it could
// quietly stop being evidence:
//
//   · a browser stating which revision was reviewed, so the record says a
//     meeting looked at something it never saw;
//   · an issued minute taking an edit, so "what did we agree in September"
//     has a different answer in March;
//   · a department's silence arriving as a tick, which is the single most
//     dangerous thing this record could do, because it reads like proof;
//   · the same person taking and certifying the minutes;
//   · a second style with the same name sharing one meeting;
//   · and a cost, a rate or a supplier riding in on a document that gets
//     circulated to everyone who attended.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const Account = require("../../models/CMS_Models/Sales/Account");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const {
  PreProductionMeeting, PPM_STATE,
} = require("../../models/CMS_Models/Merchandising/PreProductionMeeting");
const {
  MerchandisingAuditEvent,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");

const producer = require("../../services/sales/merchandisingHandover.service");
const delivery = require("../../services/integration/salesHandoverDelivery.service");
const execution = require("../../services/merchandising/execution.service");

let server, base, rs, seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "ppm" });
  const app = express();
  app.use(express.json());
  app.use("/api/cms/merchandising", require("../../routes/CMS_Routes/Merchandising/ppmRoute"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/merchandising`;
  /* The two invariants ARE indexes — one open version, one issued version —
     so they have to genuinely exist for the tests that lean on them. */
  await PreProductionMeeting.syncIndexes();
}, 180000);

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

const uniq = () => `k-${++seq}-${Date.now()}`;

const call = (p, { token, company, method = "GET", body } = {}) =>
  fetch(`${base}${p}`, {
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
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: r.status, body: parsed };
  });

async function actor(co, grants) {
  const n = ++seq;
  const email = `ppm-${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "P", lastName: `M${n}`, email, biometricId: `PM${n}`,
    isActive: true, gender: "Other", department: "Merchandising",
  });
  await DeptUser.create({
    name: `User ${n}`, email, passwordHash: "x", isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  await SpCompanyMembership.create({
    companyId: co._id, email, employeeRef: emp._id, personName: `User ${n}`,
  });
  for (const [departmentSlug, role] of Object.entries(grants)) {
    await DepartmentRole.create({
      departmentSlug, email, name: `User ${n}`, role, isActive: true,
      departmentId: new mongoose.Types.ObjectId(),
    });
  }
  return {
    email, name: `User ${n}`,
    token: jwt.sign(
      { id: String(emp._id), email, name: `User ${n}`, employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "30m" },
    ),
  };
}

/** A company with a real Execution File, opened the only way one is opened. */
async function world({ productName = "Oxford Shirt", colour = "Ecru" } = {}) {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `PPM ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const account = await Account.create({ companyName: `Buyer ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-PPM-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "S",
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-PPM-${n}`, journeyId: journey._id, accountId: account._id,
    companyId: co._id, title: `E${n}`, isActive: true,
    products: [{ product: productName, quantity: 800 }],
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-PPM-${n}`, styleCode: `SC-PPM-${n}`, productName,
    journeyId: journey._id, enquiryId: enquiry._id, stage: "rnd",
  });
  const order = await CustomerRequest.create({
    requestId: `REQ-PPM-${n}`, status: "quotation_sales_approved", orderOrigin: "customer",
    customerInfo: { name: `Buyer ${n}` },
    items: [{ stockItemName: productName, totalQuantity: 800, sampleStyleId: style._id }],
  });
  const saved = await CustomerRequest.findById(order._id).lean();
  const lineRef = String(saved.items[0].lineRef);

  const { version, correlationId } = await producer.issue({ companyId: co._id }, {
    requestId: String(order._id), lineId: lineRef,
    body: {
      expectedCurrentVersionNo: 0,
      deliveries: [{ dropRef: "D1", committedDeliveryDate: "2026-12-01", quantity: 800 }],
      breakdown: [{
        lineSplitRef: "S1", sizeRange: "S-XXL", quantity: 800,
        attributes: [{ name: "Colourway", value: colour }],
      }],
    },
    actor: { name: "Sales Person" },
  });
  await delivery.deliverPending({ companyId: co._id, correlationId });

  const reviewer = await actor(co, { merchandiser: "owner" });
  const accepted = await execution.acceptHandover(
    { companyId: co._id }, { id: String(version._id), actor: reviewer },
  );
  return { co, fileId: String(accepted.file.id), reviewer, style, colour, productName };
}

const at = (w, who) => ({ token: who.token, company: w.co._id });

/** A draft taken all the way to CONDUCTED, by the coordinator. */
async function conducted(w, coordinator) {
  await call(`/files/${w.fileId}/ppm`, {
    ...at(w, coordinator), method: "POST", body: { idempotencyKey: uniq() },
  });
  const read = await call(`/files/${w.fileId}/ppm`, at(w, coordinator));
  await call(`/files/${w.fileId}/ppm`, {
    ...at(w, coordinator), method: "PATCH",
    body: {
      expectedRevision: read.body.working.revision,
      actualMeetingAt: "2026-10-01T09:30:00.000Z",
      locationOrMode: "Factory meeting room 2",
      chairperson: "Production Manager",
      merchandisingRepresentative: coordinator.name,
      attendees: [
        { name: coordinator.name, department: "MERCHANDISING", role: "Merchandiser" },
        { name: "Quality Head", department: "QUALITY" },
      ],
      absentDepartments: ["STORE"],
      reviewNotes: [
        { topic: "CONSTRUCTION", observation: "Twin needle on the side seam, confirmed against the tech pack." },
      ],
    },
  });
  const before = await call(`/files/${w.fileId}/ppm`, at(w, coordinator));
  const out = await call(`/files/${w.fileId}/ppm/conduct`, {
    ...at(w, coordinator), method: "POST",
    body: { idempotencyKey: uniq(), expectedRevision: before.body.working.revision },
  });
  return out;
}

/** What a successor command must quote: the issued version it follows. */
async function succeed(w, who, extra = {}) {
  const cur = await call(`/files/${w.fileId}/ppm`, at(w, who));
  return call(`/files/${w.fileId}/ppm/successor`, {
    ...at(w, who), method: "POST",
    body: {
      idempotencyKey: uniq(),
      expectedIssuedVersionNo: cur.body.issued.versionNo,
      expectedIssuedRevision: cur.body.issued.revision,
      ...extra,
    },
  });
}

/* ══ 1 — IDENTITY AND ISOLATION ═══════════════════════════════════════════ */

describe("a meeting belongs to one file, in one company", () => {
  test("a foreign file and a missing one are the same answer", async () => {
    const mine = await world();
    const theirs = await world();
    const me = await actor(mine.co, { merchandiser: "owner" });

    const foreign = await call(`/files/${theirs.fileId}/ppm`, at(mine, me));
    const missing = await call(`/files/${new mongoose.Types.ObjectId()}/ppm`, at(mine, me));
    const malformed = await call("/files/not-an-id/ppm", at(mine, me));

    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(foreign.body.message).toBe(missing.body.message);
    expect(malformed.body.message).toBe(missing.body.message);
  }, 120000);

  test("it carries the permanent line and style identity, not the product name", async () => {
    const w = await world();
    const me = await actor(w.co, { merchandiser: "owner" });
    await call(`/files/${w.fileId}/ppm`, {
      ...at(w, me), method: "POST", body: { idempotencyKey: uniq() },
    });
    const doc = await PreProductionMeeting.findOne({ companyId: w.co._id }).lean();
    expect(doc.orderLineRef).toMatch(/^LN-[0-9a-f]{12}$/);
    expect(doc.orderRef).toMatch(/^REQ-PPM-/);
    expect(doc.handoverLineRef).toBe(doc.orderLineRef);
    expect(String(doc.fileId)).toBe(w.fileId);
    expect(doc.ppmRef).toMatch(/^PPM-\d{4}-\d{4}$/);
  }, 120000);

  test("two styles with the same name keep separate meetings", async () => {
    /* A minute book keyed on a product name merges the day somebody repeats a
       style, and nobody notices until two colourways share one record. */
    const a = await world({ productName: "Oxford Shirt", colour: "Ecru" });
    const b = await world({ productName: "Oxford Shirt", colour: "Navy" });
    const one = await actor(a.co, { merchandiser: "owner" });
    const two = await actor(b.co, { merchandiser: "owner" });

    await call(`/files/${a.fileId}/ppm`, { ...at(a, one), method: "POST", body: { idempotencyKey: uniq() } });
    await call(`/files/${b.fileId}/ppm`, { ...at(b, two), method: "POST", body: { idempotencyKey: uniq() } });

    const docs = await PreProductionMeeting.find({}).lean();
    const forA = docs.filter((d) => String(d.fileId) === a.fileId);
    const forB = docs.filter((d) => String(d.fileId) === b.fileId);
    expect(forA).toHaveLength(1);
    expect(forB).toHaveLength(1);
    expect(forA[0].orderLineRef).not.toBe(forB[0].orderLineRef);
    expect(forA[0].ppmRef).not.toBe(forB[0].ppmRef);
  }, 120000);
});

/* ══ 2 — ONE DRAFT, ONE ISSUED VERSION ════════════════════════════════════ */

describe("one meeting in progress, and one in force", () => {
  test("a second draft on the same file is refused", async () => {
    const w = await world();
    const me = await actor(w.co, { merchandiser: "owner" });
    const first = await call(`/files/${w.fileId}/ppm`, {
      ...at(w, me), method: "POST", body: { idempotencyKey: uniq() },
    });
    expect(first.status).toBe(201);
    const second = await call(`/files/${w.fileId}/ppm`, {
      ...at(w, me), method: "POST", body: { idempotencyKey: uniq() },
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("PPM_STATE_CONFLICT");
    expect(await PreProductionMeeting.countDocuments({ companyId: w.co._id })).toBe(1);
  }, 120000);

  test("two racing creates produce exactly one", async () => {
    const w = await world();
    const me = await actor(w.co, { merchandiser: "owner" });
    const results = await Promise.allSettled([
      call(`/files/${w.fileId}/ppm`, { ...at(w, me), method: "POST", body: { idempotencyKey: uniq() } }),
      call(`/files/${w.fileId}/ppm`, { ...at(w, me), method: "POST", body: { idempotencyKey: uniq() } }),
    ]);
    const created = results.filter((r) => r.value?.status === 201);
    expect(created).toHaveLength(1);
    expect(await PreProductionMeeting.countDocuments({ companyId: w.co._id })).toBe(1);
  }, 120000);

  test("a cancelled draft leaves room for another", async () => {
    const w = await world();
    const me = await actor(w.co, { merchandiser: "owner" });
    await call(`/files/${w.fileId}/ppm`, { ...at(w, me), method: "POST", body: { idempotencyKey: uniq() } });
    const read = await call(`/files/${w.fileId}/ppm`, at(w, me));
    const cancelled = await call(`/files/${w.fileId}/ppm/cancel`, {
      ...at(w, me), method: "POST",
      body: {
        idempotencyKey: uniq(), expectedRevision: read.body.working.revision,
        reason: "The buyer moved the meeting to next month.",
      },
    });
    expect(cancelled.status).toBe(200);
    const again = await call(`/files/${w.fileId}/ppm`, {
      ...at(w, me), method: "POST", body: { idempotencyKey: uniq() },
    });
    expect(again.status).toBe(201);
  }, 120000);
});

/* ══ 3 — CONCURRENCY AND IDEMPOTENCY ══════════════════════════════════════ */

describe("every command carries a revision and a key", () => {
  test("a stale revision is refused", async () => {
    const w = await world();
    const me = await actor(w.co, { merchandiser: "owner" });
    await call(`/files/${w.fileId}/ppm`, { ...at(w, me), method: "POST", body: { idempotencyKey: uniq() } });
    const read = await call(`/files/${w.fileId}/ppm`, at(w, me));
    await call(`/files/${w.fileId}/ppm`, {
      ...at(w, me), method: "PATCH",
      body: { expectedRevision: read.body.working.revision, chairperson: "First" },
    });
    const stale = await call(`/files/${w.fileId}/ppm`, {
      ...at(w, me), method: "PATCH",
      body: { expectedRevision: read.body.working.revision, chairperson: "Second" },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("PPM_REVISION_CONFLICT");
  }, 120000);

  test("conducting twice with one key conducts once", async () => {
    const w = await world();
    const me = await actor(w.co, { merchandiser: "owner" });
    await conducted(w, me);
    const after = await call(`/files/${w.fileId}/ppm`, at(w, me));
    const key = uniq();
    const a = await call(`/files/${w.fileId}/ppm/conduct`, {
      ...at(w, me), method: "POST",
      body: { idempotencyKey: key, expectedRevision: after.body.working.revision },
    });
    const b = await call(`/files/${w.fileId}/ppm/conduct`, {
      ...at(w, me), method: "POST",
      body: { idempotencyKey: key, expectedRevision: after.body.working.revision },
    });
    /* Already conducted, so both are the same refusal — and the record did not
       take a second snapshot between them. */
    expect(a.status).toBe(b.status);
    const doc = await PreProductionMeeting.findOne({ companyId: w.co._id }).lean();
    expect(doc.state).toBe(PPM_STATE.CONDUCTED);
  }, 120000);

  test("issuing twice with one key issues once", async () => {
    const w = await world();
    const taker = await actor(w.co, { merchandiser: "editor" });
    const checker = await actor(w.co, { merchandiser: "owner" });
    await conducted(w, taker);
    const read = await call(`/files/${w.fileId}/ppm`, at(w, checker));
    const key = uniq();
    const first = await call(`/files/${w.fileId}/ppm/issue`, {
      ...at(w, checker), method: "POST",
      body: { idempotencyKey: key, expectedRevision: read.body.working.revision },
    });
    const replay = await call(`/files/${w.fileId}/ppm/issue`, {
      ...at(w, checker), method: "POST",
      body: { idempotencyKey: key, expectedRevision: read.body.working.revision },
    });
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(await PreProductionMeeting.countDocuments({
      companyId: w.co._id, state: PPM_STATE.ISSUED,
    })).toBe(1);
  }, 120000);
});

/* ══ 4 — THE SERVER OWNS WHAT WAS REVIEWED ════════════════════════════════ */

describe("the browser cannot state what was on the table", () => {
  test("every server-owned fact is refused by name", async () => {
    const w = await world();
    const me = await actor(w.co, { merchandiser: "owner" });
    await call(`/files/${w.fileId}/ppm`, { ...at(w, me), method: "POST", body: { idempotencyKey: uniq() } });
    const read = await call(`/files/${w.fileId}/ppm`, at(w, me));

    for (const [field, expected] of [
      ["sourceReferences", /server reads from each owner/],
      ["conclusion", /derived from its decisions/],
      ["orderRef", /Sales confirmed/],
      ["styleRef", /Sales owns/],
      ["versionNo", /version number/],
      ["state", /lifecycle state/],
      ["issuedBy", /who issued/],
      ["companyId", /proved from your grant/],
    ]) {
      const out = await call(`/files/${w.fileId}/ppm`, {
        ...at(w, me), method: "PATCH",
        body: { expectedRevision: read.body.working.revision, [field]: "anything" },
      });
      expect(out.status).toBe(400);
      expect(out.body.error.code).toBe("FIELD_NOT_ACCEPTED");
      expect(out.body.message).toMatch(expected);
    }
  }, 180000);

  test("a forged source id changes nothing about the snapshot", async () => {
    const w = await world();
    const me = await actor(w.co, { merchandiser: "owner" });
    await call(`/files/${w.fileId}/ppm`, { ...at(w, me), method: "POST", body: { idempotencyKey: uniq() } });
    const read = await call(`/files/${w.fileId}/ppm`, at(w, me));

    /* A note may NAME a source; it cannot invent one. */
    const invented = await call(`/files/${w.fileId}/ppm`, {
      ...at(w, me), method: "PATCH",
      body: {
        expectedRevision: read.body.working.revision,
        reviewNotes: [{
          topic: "CONSTRUCTION", observation: "Something about a source that is not ours.",
          sourceKey: "SOMEBODY_ELSES_RECORD",
        }],
      },
    });
    expect(invented.status).toBe(400);
    expect(invented.body.message).toMatch(/is not a source this meeting reviews/);
  }, 120000);

  test("the snapshot is taken by conducting, and names the real revisions", async () => {
    const w = await world();
    const me = await actor(w.co, { merchandiser: "owner" });
    const out = await conducted(w, me);
    expect(out.status).toBe(200);

    const doc = await PreProductionMeeting.findOne({ companyId: w.co._id }).lean();
    expect(doc.sourcesCapturedAt).toBeTruthy();
    const keys = doc.sourceReferences.map((s) => s.key).sort();
    expect(keys).toEqual([
      "APPROVALS", "DEPARTMENT_STATUS", "DEVELOPMENT", "EXECUTION_PACK",
      "IE_RELEASE", "MATERIAL_TRIM", "PACKAGING", "PPC_IE_RECEIPT", "TNA_BASELINE",
    ]);
  }, 120000);
});

/* ══ 5 — A SILENCE IS A SILENCE ═══════════════════════════════════════════ */

describe("missing evidence stays missing", () => {
  test("nothing absent is recorded as zero, complete, approved or ready", async () => {
    const w = await world();
    const me = await actor(w.co, { merchandiser: "owner" });
    await conducted(w, me);

    const doc = await PreProductionMeeting.findOne({ companyId: w.co._id }).lean();
    const absent = doc.sourceReferences.filter((s) => s.availability !== "PRESENT");
    /* This file has no pack, no approved selection, no baseline, no IE
       release and no department reporting — so most of it is absent, which is
       exactly the case worth pinning. */
    expect(absent.length).toBeGreaterThan(4);
    for (const s of absent) {
      expect(["UNKNOWN", "NOT_REPORTED", "UNAVAILABLE"]).toContain(s.availability);
      expect(s.note.length).toBeGreaterThan(10);
      expect(s.revisionNo).toBeNull();
      expect(s.versionNo).toBeNull();
      expect(s.state).toBe("");
      /* The machine-readable fields above carry the claim, and they say
         nothing. The prose is then held to one rule: if it uses a word like
         "approved" or "ready" at all, it must be denying it — "nothing has
         been approved" is the honest sentence, "approved" on its own is not. */
      if (/\b(ready|complete|completed|approved)\b/i.test(s.note)) {
        expect(s.note).toMatch(/\b(no|not|nothing|none|never|yet)\b/i);
      }
      expect(s.note).toMatch(/\b(no|not|nothing|none|never|yet|unknown|unavailable|awaiting)\b/i);
    }
  }, 120000);

  test("IE and PPC silence is NOT_REPORTED — nobody is late, nothing is done", async () => {
    const w = await world();
    const me = await actor(w.co, { merchandiser: "owner" });
    await conducted(w, me);
    const doc = await PreProductionMeeting.findOne({ companyId: w.co._id }).lean();
    const byKey = Object.fromEntries(doc.sourceReferences.map((s) => [s.key, s]));
    expect(byKey.IE_RELEASE.availability).toBe("NOT_REPORTED");
    expect(byKey.PPC_IE_RECEIPT.availability).toBe("NOT_REPORTED");
    expect(byKey.PPC_IE_RECEIPT.note).toMatch(/has not yet decided|no engineering release/i);
    expect(byKey.DEPARTMENT_STATUS.availability).toBe("NOT_REPORTED");
  }, 120000);

  test("and none of it blocks the minutes", async () => {
    /* THE RULE THAT MATTERS MOST. Merchandising cannot make Store report. If
       another department's silence stopped a meeting being minuted, the
       meeting would still have happened and there would be no record of it. */
    const w = await world();
    const taker = await actor(w.co, { merchandiser: "editor" });
    const checker = await actor(w.co, { merchandiser: "owner" });
    await conducted(w, taker);
    const read = await call(`/files/${w.fileId}/ppm`, at(w, checker));
    const issued = await call(`/files/${w.fileId}/ppm/issue`, {
      ...at(w, checker), method: "POST",
      body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision },
    });
    expect(issued.status).toBe(200);
    expect(issued.body.state).toBe("ISSUED");
  }, 120000);
});

/* ══ 6 — THE CONCLUSION IS ABOUT THE MEETING ══════════════════════════════ */

describe("the outcome never says the order is ready", () => {
  test("a meeting with an open clarification says so", async () => {
    const w = await world();
    const taker = await actor(w.co, { merchandiser: "editor" });
    const checker = await actor(w.co, { merchandiser: "owner" });
    await conducted(w, taker);
    const read = await call(`/files/${w.fileId}/ppm`, at(w, checker));
    await call(`/files/${w.fileId}/ppm`, {
      ...at(w, taker), method: "PATCH",
      body: {
        expectedRevision: read.body.working.revision,
        decisions: [{
          decision: "Confirm whether the buyer accepts the substitute interlining.",
          ownerDepartment: "SALES", status: "OPEN", topic: "MATERIAL_TRIM",
        }],
      },
    });
    const now = await call(`/files/${w.fileId}/ppm`, at(w, checker));
    const issued = await call(`/files/${w.fileId}/ppm/issue`, {
      ...at(w, checker), method: "POST",
      body: { idempotencyKey: uniq(), expectedRevision: now.body.working.revision },
    });
    expect(issued.body.conclusion).toBe("CONDUCTED_WITH_OPEN_CLARIFICATIONS");
  }, 120000);

  test("neither outcome, nor the printed minute, claims production readiness", async () => {
    const w = await world();
    const taker = await actor(w.co, { merchandiser: "editor" });
    const checker = await actor(w.co, { merchandiser: "owner" });
    await conducted(w, taker);
    const read = await call(`/files/${w.fileId}/ppm`, at(w, checker));
    const issued = await call(`/files/${w.fileId}/ppm/issue`, {
      ...at(w, checker), method: "POST",
      body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision },
    });
    expect(issued.body.conclusion).toBe("CONDUCTED_WITHOUT_OPEN_CLARIFICATIONS");

    const printed = await call(`/files/${w.fileId}/ppm/printable`, at(w, checker));
    expect(printed.status).toBe(200);
    const text = JSON.stringify(printed.body);
    expect(text).not.toMatch(/production ready|ready for production|cleared for production/i);
    /* And it says whose decision that actually is. */
    expect(printed.body.statement).toMatch(/PPC's decision/);
  }, 120000);
});

/* ══ 7 — AN ISSUED MINUTE IS PERMANENT ════════════════════════════════════ */

describe("issued minutes take no edit, by any path", () => {
  async function issuedWorld() {
    const w = await world();
    const taker = await actor(w.co, { merchandiser: "editor" });
    const checker = await actor(w.co, { merchandiser: "owner" });
    await conducted(w, taker);
    const read = await call(`/files/${w.fileId}/ppm`, at(w, checker));
    await call(`/files/${w.fileId}/ppm/issue`, {
      ...at(w, checker), method: "POST",
      body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision },
    });
    return { w, taker, checker };
  }

  test("the update door refuses it and says what to do instead", async () => {
    const { w, checker } = await issuedWorld();
    const out = await call(`/files/${w.fileId}/ppm`, {
      ...at(w, checker), method: "PATCH",
      body: { expectedRevision: 0, chairperson: "Somebody else entirely" },
    });
    expect(out.status).toBe(409);
    expect(out.body.error.code).toBe("PPM_IMMUTABLE");
    expect(out.body.message).toMatch(/successor/);
  }, 120000);

  test("conduct, cancel and a second issue all refuse it too", async () => {
    const { w, checker } = await issuedWorld();
    for (const path of ["conduct", "cancel", "issue"]) {
      const out = await call(`/files/${w.fileId}/ppm/${path}`, {
        ...at(w, checker), method: "POST",
        body: { idempotencyKey: uniq(), expectedRevision: 0, reason: "Trying it on, at length." },
      });
      expect([404, 409]).toContain(out.status);
    }
    const doc = await PreProductionMeeting.findOne({
      companyId: w.co._id, state: PPM_STATE.ISSUED,
    }).lean();
    expect(doc.state).toBe(PPM_STATE.ISSUED);
  }, 120000);

  test("and the record itself refuses a write that bypassed the service", async () => {
    /* The floor under the door. A future helper reaching for the document
       directly is refused by the document. */
    const { w } = await issuedWorld();
    const doc = await PreProductionMeeting.findOne({
      companyId: w.co._id, state: PPM_STATE.ISSUED,
    });
    doc.chairperson = "Rewritten in March";
    await expect(doc.save()).rejects.toThrow(/permanent evidence and takes no edit/);
  }, 120000);
});

/* ══ 8 — MAKER/CHECKER ════════════════════════════════════════════════════ */

describe("the person who took the minutes does not certify them", () => {
  test("the conductor cannot issue", async () => {
    const w = await world();
    const both = await actor(w.co, { merchandiser: "owner" });
    await conducted(w, both);
    const read = await call(`/files/${w.fileId}/ppm`, at(w, both));
    const out = await call(`/files/${w.fileId}/ppm/issue`, {
      ...at(w, both), method: "POST",
      body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision },
    });
    expect(out.status).toBe(409);
    expect(out.body.error.code).toBe("PPM_SELF_ISSUE");
  }, 120000);

  test("the capability ladder is the existing one — an editor cannot issue", async () => {
    const w = await world();
    const taker = await actor(w.co, { merchandiser: "editor" });
    await conducted(w, taker);
    const read = await call(`/files/${w.fileId}/ppm`, at(w, taker));
    const out = await call(`/files/${w.fileId}/ppm/issue`, {
      ...at(w, taker), method: "POST",
      body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision },
    });
    expect(out.status).toBe(403);
    /* And a viewer cannot even start one. */
    const viewer = await actor(w.co, { merchandiser: "viewer" });
    const started = await call(`/files/${w.fileId}/ppm`, {
      ...at(w, viewer), method: "POST", body: { idempotencyKey: uniq() },
    });
    expect(started.status).toBe(403);
  }, 120000);
});

/* ══ 9 — SUCCESSION ══════════════════════════════════════════════════════ */

describe("a later meeting keeps the earlier one", () => {
  test("the predecessor is superseded and still readable, field for field", async () => {
    const w = await world();
    const taker = await actor(w.co, { merchandiser: "editor" });
    const checker = await actor(w.co, { merchandiser: "owner" });
    await conducted(w, taker);
    let read = await call(`/files/${w.fileId}/ppm`, at(w, checker));
    await call(`/files/${w.fileId}/ppm/issue`, {
      ...at(w, checker), method: "POST",
      body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision },
    });
    const v1 = await PreProductionMeeting.findOne({ companyId: w.co._id, versionNo: 1 }).lean();

    const successor = await succeed(w, checker);
    expect(successor.status).toBe(201);
    expect(successor.body.versionNo).toBe(2);
    expect(successor.body.successorOfVersionNo).toBe(1);

    /* ── THE DRAFT CHANGES NOTHING ABOUT VERSION 1 ──────────────────────
       Booking a follow-up meeting is not a decision about the last one. Until
       version 2 is issued, version 1 IS the minutes in force — otherwise a
       successor that is later called off would leave the file with none. */
    const after = await PreProductionMeeting.findOne({ companyId: w.co._id, versionNo: 1 }).lean();
    expect(after).toEqual(v1);
    expect(after.state).toBe(PPM_STATE.ISSUED);

    /* Only issuing version 2 retires it — and everything a reader was told
       about version 1 survives that, field for field. */
    const second = await actor(w.co, { merchandiser: "owner" });
    await conducted(w, taker);
    read = await call(`/files/${w.fileId}/ppm`, at(w, second));
    await call(`/files/${w.fileId}/ppm/issue`, {
      ...at(w, second), method: "POST",
      body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision },
    });
    const retired = await PreProductionMeeting.findOne({ companyId: w.co._id, versionNo: 1 }).lean();
    expect(retired.state).toBe(PPM_STATE.SUPERSEDED);
    expect(retired.supersededByVersionNo).toBe(2);
    expect(retired.chairperson).toBe(v1.chairperson);
    expect(retired.conclusion).toBe(v1.conclusion);
    expect(retired.attendees).toEqual(v1.attendees);
    expect(retired.reviewNotes).toEqual(v1.reviewNotes);
    expect(retired.sourceReferences).toEqual(v1.sourceReferences);
    expect(retired.issuedAt).toEqual(v1.issuedAt);

    /* And both versions are listed. */
    const versions = await call(`/files/${w.fileId}/ppm/versions`, at(w, checker));
    expect(versions.body.versions.map((v) => v.versionNo)).toEqual([2, 1]);
  }, 180000);

  test("meeting context carries forward, observations do not", async () => {
    const w = await world();
    const taker = await actor(w.co, { merchandiser: "editor" });
    const checker = await actor(w.co, { merchandiser: "owner" });
    await conducted(w, taker);
    let read = await call(`/files/${w.fileId}/ppm`, at(w, checker));
    await call(`/files/${w.fileId}/ppm`, {
      ...at(w, taker), method: "PATCH",
      body: {
        expectedRevision: read.body.working.revision,
        decisions: [
          { decision: "Buyer to confirm the interlining substitution.", ownerDepartment: "SALES", status: "OPEN" },
          { decision: "Carton size was settled in the meeting.", ownerDepartment: "MERCHANDISING", status: "CLOSED", closureNote: "Agreed 60x40x30." },
        ],
      },
    });
    read = await call(`/files/${w.fileId}/ppm`, at(w, checker));
    await call(`/files/${w.fileId}/ppm/issue`, {
      ...at(w, checker), method: "POST",
      body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision },
    });
    await succeed(w, checker);

    const v2 = await PreProductionMeeting.findOne({ companyId: w.co._id, versionNo: 2 }).lean();
    /* Who was there comes forward; what THIS meeting says does not exist yet. */
    expect(v2.attendees.length).toBe(2);
    expect(v2.reviewNotes).toEqual([]);
    /* The open point is still open; the closed one is not re-opened. */
    expect(v2.decisions).toHaveLength(1);
    expect(v2.decisions[0].status).toBe("OPEN");
    expect(v2.decisions[0].decisionRef).toBeTruthy();
    /* The chairperson is NOT carried: somebody has to chair this meeting. */
    expect(v2.chairperson).toBe("");
  }, 180000);
});

/* ══ 10 — A MOVED SOURCE MUST BE LOOKED AT AGAIN ═════════════════════════ */

describe("when a reviewed source moves", () => {
  test("the issued minute is untouched and the comparison says it moved", async () => {
    const w = await world();
    const taker = await actor(w.co, { merchandiser: "editor" });
    const checker = await actor(w.co, { merchandiser: "owner" });
    await conducted(w, taker);
    const read = await call(`/files/${w.fileId}/ppm`, at(w, checker));
    await call(`/files/${w.fileId}/ppm/issue`, {
      ...at(w, checker), method: "POST",
      body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision },
    });
    const before = await PreProductionMeeting.findOne({ companyId: w.co._id, versionNo: 1 }).lean();

    /* Merchandising approves a packaging revision after the meeting — through
       the selection service's own door, which is what actually happens. */
    const selection = require("../../services/merchandising/selection.service");
    const ctx = { companyId: w.co._id };
    await selection.createDraft(ctx, {
      fileId: w.fileId, family: "PACKAGING", actor: taker, idempotencyKey: uniq(),
    });
    const cur = await selection.getCurrent(ctx, { fileId: w.fileId, family: "PACKAGING" });
    await selection.addRow(ctx, {
      fileId: w.fileId, family: "PACKAGING",
      body: {
        expectedRevision: cur.working.revision, group: "POLYBAG",
        componentName: "Polybag 300x400", componentCode: "PKG-PLY-001", appliesToAllUnits: true,
      },
      actor: taker,
    });
    const afterRow = await selection.getCurrent(ctx, { fileId: w.fileId, family: "PACKAGING" });
    await selection.submit(ctx, {
      fileId: w.fileId, family: "PACKAGING",
      body: { expectedRevision: afterRow.working.revision }, actor: taker, idempotencyKey: uniq(),
    });
    const afterSubmit = await selection.getCurrent(ctx, { fileId: w.fileId, family: "PACKAGING" });
    await selection.approve(ctx, {
      fileId: w.fileId, family: "PACKAGING",
      body: { expectedRevision: afterSubmit.working.revision }, actor: checker, idempotencyKey: uniq(),
    });

    /* The minute has not moved a byte. */
    const still = await PreProductionMeeting.findOne({ companyId: w.co._id, versionNo: 1 }).lean();
    expect(still.sourceReferences).toEqual(before.sourceReferences);
    expect(still.state).toBe(PPM_STATE.ISSUED);

    /* And the comparison says which source moved, and under which topic. */
    const health = await call(`/files/${w.fileId}/ppm/source-health`, at(w, checker));
    expect(health.status).toBe(200);
    expect(health.body.anyMoved).toBe(true);
    const packaging = health.body.sources.find((s) => s.key === "PACKAGING");
    expect(packaging.movement).toBe("MOVED");
    expect(packaging.reviewedState.availability).toBe("UNKNOWN");
    expect(health.body.movedTopics).toContain("PACKAGING_PRESENTATION");
  }, 240000);

  test("a successor cannot be issued until the moved topic is reviewed again", async () => {
    const w = await world();
    const taker = await actor(w.co, { merchandiser: "editor" });
    const checker = await actor(w.co, { merchandiser: "owner" });
    await conducted(w, taker);
    let read = await call(`/files/${w.fileId}/ppm`, at(w, checker));
    await call(`/files/${w.fileId}/ppm/issue`, {
      ...at(w, checker), method: "POST",
      body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision },
    });

    const selection = require("../../services/merchandising/selection.service");
    const ctx = { companyId: w.co._id };
    await selection.createDraft(ctx, {
      fileId: w.fileId, family: "PACKAGING", actor: taker, idempotencyKey: uniq(),
    });
    const cur = await selection.getCurrent(ctx, { fileId: w.fileId, family: "PACKAGING" });
    await selection.addRow(ctx, {
      fileId: w.fileId, family: "PACKAGING",
      body: {
        expectedRevision: cur.working.revision, group: "POLYBAG",
        componentName: "Polybag 300x400", componentCode: "PKG-PLY-001", appliesToAllUnits: true,
      },
      actor: taker,
    });
    const afterRow = await selection.getCurrent(ctx, { fileId: w.fileId, family: "PACKAGING" });
    await selection.submit(ctx, {
      fileId: w.fileId, family: "PACKAGING",
      body: { expectedRevision: afterRow.working.revision }, actor: taker, idempotencyKey: uniq(),
    });
    const afterSubmit = await selection.getCurrent(ctx, { fileId: w.fileId, family: "PACKAGING" });
    await selection.approve(ctx, {
      fileId: w.fileId, family: "PACKAGING",
      body: { expectedRevision: afterSubmit.working.revision }, actor: checker, idempotencyKey: uniq(),
    });

    const successor = await succeed(w, checker);
    expect(successor.body.topicsRequiringReReview).toContain("PACKAGING_PRESENTATION");

    /* Conduct it, then try to issue without looking at packaging again. */
    read = await call(`/files/${w.fileId}/ppm`, at(w, taker));
    await call(`/files/${w.fileId}/ppm`, {
      ...at(w, taker), method: "PATCH",
      body: {
        expectedRevision: read.body.working.revision,
        actualMeetingAt: "2026-11-01T09:00:00.000Z", chairperson: "Production Manager",
      },
    });
    read = await call(`/files/${w.fileId}/ppm`, at(w, taker));
    await call(`/files/${w.fileId}/ppm/conduct`, {
      ...at(w, taker), method: "POST",
      body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision },
    });
    read = await call(`/files/${w.fileId}/ppm`, at(w, checker));
    const refused = await call(`/files/${w.fileId}/ppm/issue`, {
      ...at(w, checker), method: "POST",
      body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision },
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("PPM_REVIEW_REQUIRED");
    expect(refused.body.message).toMatch(/PACKAGING_PRESENTATION/);

    /* Look at it, and the requirement clears. */
    read = await call(`/files/${w.fileId}/ppm`, at(w, taker));
    await call(`/files/${w.fileId}/ppm`, {
      ...at(w, taker), method: "PATCH",
      body: {
        expectedRevision: read.body.working.revision,
        reviewNotes: [{
          topic: "PACKAGING_PRESENTATION",
          observation: "Reviewed the newly approved polybag; no change to the folding method.",
          sourceKey: "PACKAGING",
        }],
      },
    });
    read = await call(`/files/${w.fileId}/ppm`, at(w, checker));
    const issued = await call(`/files/${w.fileId}/ppm/issue`, {
      ...at(w, checker), method: "POST",
      body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision },
    });
    expect(issued.status).toBe(200);
  }, 300000);
});

/* ══ 11 — WHAT IT NEVER DOES ═════════════════════════════════════════════ */

describe("the boundaries, held at the wire", () => {
  test("no decision may carry an assignee, a due date or a reminder", async () => {
    const w = await world();
    const me = await actor(w.co, { merchandiser: "owner" });
    await call(`/files/${w.fileId}/ppm`, { ...at(w, me), method: "POST", body: { idempotencyKey: uniq() } });
    const read = await call(`/files/${w.fileId}/ppm`, at(w, me));
    for (const field of ["assignee", "dueDate", "reminder", "priority", "checklist"]) {
      const out = await call(`/files/${w.fileId}/ppm`, {
        ...at(w, me), method: "PATCH",
        body: {
          expectedRevision: read.body.working.revision,
          decisions: [{
            decision: "Something with a task shape.", ownerDepartment: "STORE",
            status: "OPEN", [field]: "x",
          }],
        },
      });
      expect(out.status).toBe(400);
      expect(out.body.message).toMatch(/Tasks app/);
    }
  }, 180000);

  test("a follow-up is a REFERENCE to a task the Tasks app owns", async () => {
    const w = await world();
    const me = await actor(w.co, { merchandiser: "owner" });
    await call(`/files/${w.fileId}/ppm`, { ...at(w, me), method: "POST", body: { idempotencyKey: uniq() } });
    const read = await call(`/files/${w.fileId}/ppm`, at(w, me));
    const out = await call(`/files/${w.fileId}/ppm`, {
      ...at(w, me), method: "PATCH",
      body: {
        expectedRevision: read.body.working.revision,
        decisions: [{
          decision: "Store to confirm the trim shortage.", ownerDepartment: "STORE",
          status: "OPEN", externalTaskRef: "TASK-9182",
        }],
      },
    });
    expect(out.status).toBe(200);
    const doc = await PreProductionMeeting.findOne({ companyId: w.co._id }).lean();
    expect(doc.decisions[0].externalTaskRef).toBe("TASK-9182");
    /* And nothing that looks like a task was created anywhere. */
    const collections = (await mongoose.connection.db.listCollections().toArray())
      .map((c) => c.name);
    expect(collections.filter((c) => /task/i.test(c))).toEqual([]);
  }, 120000);

  test("no PPC, IE, Store or Production record is written by any of it", async () => {
    const w = await world();
    const taker = await actor(w.co, { merchandiser: "editor" });
    const checker = await actor(w.co, { merchandiser: "owner" });

    const foreign = ["ie_releases", "ppc_ie_release_receipts", "ppc_downstream_handover_receipts",
      "merchandising_department_status_projections", "workorders", "productionschedules"];
    const before = {};
    for (const c of foreign) {
      before[c] = await mongoose.connection.db.collection(c).countDocuments().catch(() => 0);
    }

    await conducted(w, taker);
    const read = await call(`/files/${w.fileId}/ppm`, at(w, checker));
    await call(`/files/${w.fileId}/ppm/issue`, {
      ...at(w, checker), method: "POST",
      body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision },
    });
    await succeed(w, checker);

    for (const c of foreign) {
      const now = await mongoose.connection.db.collection(c).countDocuments().catch(() => 0);
      expect(now).toBe(before[c]);
    }
    /* And the Execution File's own lifecycle is untouched: PPM does not hand
       anything over and does not release anything. */
    const file = await ExecutionFile.findById(w.fileId).lean();
    expect(file.lifecycleStatus).toBe("OPEN");
    expect(file.downstreamReceiptState ?? null).toBeFalsy();
  }, 180000);

  test("the router exposes no capacity, line-allocation or release verb", () => {
    const fs = require("fs");
    const path = require("path");
    const bare = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const route = bare(fs.readFileSync(
      path.join(__dirname, "..", "..", "routes/CMS_Routes/Merchandising/ppmRoute.js"), "utf8"));
    const service = bare(fs.readFileSync(
      path.join(__dirname, "..", "..", "services/merchandising/preProductionMeeting.service.js"), "utf8"));
    for (const src of [route, service]) {
      expect(src).not.toMatch(/capacity|lineAllocation|allocateLine|releaseToProduction|productionRelease/i);
    }
    /* Every mounted path is under the Merchandising file, and every verb is a
       read or a write of this record. */
    const paths = [...route.matchAll(/router\.(get|post|patch)\("([^"]+)"/g)].map((m) => m[2]);
    expect(paths.length).toBeGreaterThan(8);
    for (const p of paths) expect(p).toMatch(/^\/files\/:id\/ppm/);
  });

  test("no cost, rate, supplier or margin is anywhere on the record", async () => {
    const w = await world();
    const taker = await actor(w.co, { merchandiser: "editor" });
    const checker = await actor(w.co, { merchandiser: "owner" });
    await conducted(w, taker);
    const read = await call(`/files/${w.fileId}/ppm`, at(w, checker));
    await call(`/files/${w.fileId}/ppm/issue`, {
      ...at(w, checker), method: "POST",
      body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision },
    });

    const printed = await call(`/files/${w.fileId}/ppm/printable`, at(w, checker));
    const current = await call(`/files/${w.fileId}/ppm`, at(w, checker));
    for (const payload of [printed.body, current.body]) {
      const text = JSON.stringify(payload);
      expect(text).not.toMatch(/"(unitCost|totalCost|rate|price|amount|margin|markup|supplier|vendor)"/i);
    }
    const doc = await PreProductionMeeting.findOne({ companyId: w.co._id, versionNo: 1 }).lean();
    expect(JSON.stringify(doc)).not.toMatch(/"(unitCost|rate|price|margin|markup|supplierId)"/i);
  }, 180000);
});

/* ══ 12 — IT SHOWS UP IN THE FILE'S HISTORY ══════════════════════════════ */

describe("the meeting's acts are on the file's own record", () => {
  test("every act writes one audit row, against this file", async () => {
    const w = await world();
    const taker = await actor(w.co, { merchandiser: "editor" });
    const checker = await actor(w.co, { merchandiser: "owner" });
    await conducted(w, taker);
    const read = await call(`/files/${w.fileId}/ppm`, at(w, checker));
    await call(`/files/${w.fileId}/ppm/issue`, {
      ...at(w, checker), method: "POST",
      body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision },
    });
    await succeed(w, checker);

    /* Supersession is recorded when it HAPPENS, which is when the successor
       is issued — not when somebody books the meeting. So the second version
       is taken all the way through. */
    const second = await actor(w.co, { merchandiser: "owner" });
    await conducted(w, taker);
    const ready = await call(`/files/${w.fileId}/ppm`, at(w, second));
    await call(`/files/${w.fileId}/ppm/issue`, {
      ...at(w, second), method: "POST",
      body: { idempotencyKey: uniq(), expectedRevision: ready.body.working.revision },
    });

    const rows = await MerchandisingAuditEvent.find({
      companyId: w.co._id, recordType: "PRE_PRODUCTION_MEETING",
    }).sort({ at: 1 }).lean();
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("PPM_DRAFTED");
    expect(actions).toContain("PPM_UPDATED");
    expect(actions).toContain("PPM_CONDUCTED");
    expect(actions).toContain("PPM_ISSUED");
    expect(actions).toContain("PPM_SUPERSEDED");
    /* And the retirement is on the same breath as the issue that caused it. */
    const superseded = rows.find((r) => r.action === "PPM_SUPERSEDED");
    const issuedSecond = rows.filter((r) => r.action === "PPM_ISSUED").pop();
    expect(superseded.correlationId).toBe(issuedSecond.correlationId);
    for (const r of rows) {
      expect(String(r.fileId)).toBe(w.fileId);
      expect(r.source).toBe("merchandising");
    }
  }, 180000);
});
