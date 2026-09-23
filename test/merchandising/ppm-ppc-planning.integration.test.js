// test/merchandising/ppm-ppc-planning.integration.test.js
//
// MERCHANDISING ISSUES THE MINUTES; PPC READS THEM AND PLANS.
//
// PPC's planning file needs four inputs, one of which — issued Pre-Production
// Meeting minutes — only Merchandising can produce. Until now every PPC test
// seeded that record directly, because nothing staged could issue one. This
// suite produces it the only legitimate way: a Merchandising user writes the
// meeting up, another Merchandising user issues it, through the mounted
// Merchandising routes. PPC then reads it through Merchandising's published
// contract (`planningPublication.service`) and creates a planning file through
// its own route.
//
// The Execution File is real too: a Sales handover, delivered and accepted
// through Merchandising's route, so the order line PPC plans against is the
// line Sales confirmed. The pack and the engineering release are the other
// two applications' accepted records, seeded with PPC's own fixtures — what
// is under test here is the minutes, and the seam they cross.
//
// What PPC must never do is write a meeting record, and a test says so.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const Account = require("../../models/CMS_Models/Sales/Account");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const { PreProductionMeeting } = require("../../models/CMS_Models/Merchandising/PreProductionMeeting");
const { MerchandisingAuditEvent } = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");

const producer = require("../../services/sales/merchandisingHandover.service");
const delivery = require("../../services/integration/salesHandoverDelivery.service");
const publication = require("../../services/merchandising/planningPublication.service");
const { actor, company, pack, release, nextKey } = require("../ppc/planningFixtures");

let rs, http, base, seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "ppm_ppc" });
  await PreProductionMeeting.syncIndexes();
  const app = express();
  app.use(express.json());
  app.use("/api/cms/merchandising", require("../../routes/CMS_Routes/Merchandising/executionRoute"));
  app.use("/api/cms/merchandising", require("../../routes/CMS_Routes/Merchandising/ppmRoute"));
  app.use("/api/cms/ppc", require("../../routes/CMS_Routes/PPC/orderBookRoute"));
  await new Promise((r) => { http = app.listen(0, r); });
  base = `http://127.0.0.1:${http.address().port}/api/cms`;
}, 180000);

afterAll(async () => {
  if (http) await new Promise((r) => http.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

const call = (path, { method = "GET", body, who, co, key } = {}) => fetch(`${base}${path}`, {
  method,
  headers: {
    "Content-Type": "application/json",
    ...(who ? { Authorization: `Bearer ${who.token}` } : {}),
    ...(co ? { "X-Costing-Company": String(co._id) } : {}),
    ...(key ? { "Idempotency-Key": key } : {}),
  },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
}).then(async (r) => {
  const text = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(text || "null"); } catch { parsed = { nonJson: text.slice(0, 200) }; }
  return { status: r.status, body: parsed };
});
const uniq = () => `ppm-ppc-${++seq}-${Date.now()}`;

/**
 * A company, its people, and one CONFIRMED order line: a real Sales handover
 * accepted through Merchandising's own route. The pack and the release — the
 * other two applications' records — exist and are accepted by PPC.
 */
async function world(label, { withPack = true, withRelease = true } = {}) {
  const co = await company(label);
  const people = {
    owner: await actor({ companies: [co], grants: { merchandiser: "owner" } }),
    taker: await actor({ companies: [co], grants: { merchandiser: "editor" } }),
    checker: await actor({ companies: [co], grants: { merchandiser: "approver" } }),
    planner: await actor({ companies: [co], grants: { ppc: "editor" } }),
    viewer: await actor({ companies: [co], grants: { ppc: "viewer" } }),
  };
  const line = await confirmedLine(co, people.owner, label);
  if (withPack) await pack(co, line.file, { accepted: true });
  if (withRelease) await release(co, line.file.currentExecutionProjection.sampleStyleId, { accepted: true });
  return { co, ...people, ...line };
}

async function confirmedLine(co, owner, label) {
  const n = ++seq;
  const account = await Account.create({ companyName: `Buyer ${label} ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-PP-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "Sales",
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-PP-${n}`, journeyId: journey._id, accountId: account._id,
    companyId: co._id, title: `E${n}`, isActive: true, products: [{ product: "Oxford Shirt", quantity: 800 }],
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-PP-${n}`, styleCode: `SC-PP-${n}`, productName: "Oxford Shirt",
    journeyId: journey._id, enquiryId: enquiry._id, stage: "rnd",
  });
  const order = await CustomerRequest.create({
    requestId: `REQ-PP-${n}`, status: "quotation_sales_approved", orderOrigin: "customer",
    customerInfo: { name: `Buyer ${label} ${n}` },
    items: [{ stockItemName: "Oxford Shirt", totalQuantity: 800, sampleStyleId: style._id }],
  });
  const saved = await CustomerRequest.findById(order._id).lean();
  const out = await producer.issue({ companyId: co._id }, {
    requestId: String(order._id), lineId: String(saved.items[0].lineRef),
    body: {
      expectedCurrentVersionNo: 0,
      deliveries: [{ dropRef: "D1", committedDeliveryDate: "2026-12-01", quantity: 800 }],
      breakdown: [{ lineSplitRef: "S1", sizeRange: "S-XXL", quantity: 800,
        attributes: [{ name: "Colourway", value: "Ecru" }] }],
    },
    actor: { name: "Sales" },
  });
  await delivery.deliverPending({ companyId: co._id, correlationId: out.correlationId });
  const accepted = await call(`/merchandising/handovers/${out.version._id}/accept`, {
    method: "POST", who: owner, co, body: { idempotencyKey: uniq() },
  });
  expect([200, 201]).toContain(accepted.status);
  const file = await ExecutionFile.findById(accepted.body.file.id).lean();
  return { file, fileId: String(file._id), lineRef: String(file.handoverLineRef), orderRef: String(saved.requestId) };
}

/** The Merchandising write-up: draft → minutes → conducted, by the taker. */
async function conducted(w) {
  const draft = await call(`/merchandising/files/${w.fileId}/ppm`, {
    method: "POST", who: w.taker, co: w.co, body: { idempotencyKey: uniq() },
  });
  expect(draft.status).toBe(201);
  let cur = await call(`/merchandising/files/${w.fileId}/ppm`, { who: w.taker, co: w.co });
  const patched = await call(`/merchandising/files/${w.fileId}/ppm`, {
    method: "PATCH", who: w.taker, co: w.co,
    body: {
      expectedRevision: cur.body.working.revision,
      actualMeetingAt: "2026-10-05T09:30:00.000Z",
      locationOrMode: "Factory meeting room",
      chairperson: "Production Manager",
      attendees: [
        { name: w.taker.name, department: "MERCHANDISING", role: "Merchandiser" },
        { name: "Line supervisor", department: "PRODUCTION" },
      ],
      reviewNotes: [{ topic: "CONSTRUCTION", observation: "Side seam confirmed against the approved sample." }],
    },
  });
  expect(patched.status).toBe(200);
  cur = await call(`/merchandising/files/${w.fileId}/ppm`, { who: w.taker, co: w.co });
  const done = await call(`/merchandising/files/${w.fileId}/ppm/conduct`, {
    method: "POST", who: w.taker, co: w.co,
    body: { idempotencyKey: uniq(), expectedRevision: cur.body.working.revision },
  });
  expect(done.status).toBe(200);
  return call(`/merchandising/files/${w.fileId}/ppm`, { who: w.checker, co: w.co });
}

const orderBookRow = async (w, who = w.viewer) => {
  const r = await call(`/ppc/order-book/${encodeURIComponent(w.lineRef)}`, { who, co: w.co });
  expect(r.status).toBe(200);
  return r.body.row;
};
const createPlanningFile = (w, key = nextKey()) => call(`/ppc/order-book/${encodeURIComponent(w.lineRef)}/planning-file`, {
  method: "POST", who: w.planner, co: w.co, body: {}, key,
});

/* ══ THE WHOLE SEAM ═══════════════════════════════════════════════════════ */

describe("Merchandising → PPC, through the routes", () => {
  test("minutes written, checked and issued in Merchandising let PPC plan the confirmed line", async () => {
    const w = await world("Flow");

    /* Before: PPC sees the line, has the pack and the release, and is missing
       exactly one thing — the minutes. It cannot create a planning file. */
    let row = await orderBookRow(w);
    expect(row.orderLineRef).toBe(w.lineRef);
    expect(row.inputs.executionPack.state).toBe("SATISFIED");
    expect(row.inputs.ieRelease.state).toBe("SATISFIED");
    expect(row.inputs.ppmMinutes.state).toBe("MISSING");
    const refused = await createPlanningFile(w);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("PPC_PLANNING_NOT_READY");
    expect(refused.body.error.details.unsatisfied).toEqual(["ppmMinutes"]);

    /* Merchandising: one person writes the meeting up and marks it held… */
    const read = await conducted(w);
    expect(read.body.working.state).toBe("CONDUCTED");
    /* Conducted is not issued: PPC still sees nothing it may rely on. */
    row = await orderBookRow(w);
    expect(row.inputs.ppmMinutes.state).toBe("MISSING");

    /* …and a second person checks and issues it. */
    const issued = await call(`/merchandising/files/${w.fileId}/ppm/issue`, {
      method: "POST", who: w.checker, co: w.co,
      body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision },
    });
    expect(issued.status).toBe(200);
    expect(issued.body.state).toBe("ISSUED");
    const meeting = await PreProductionMeeting.findOne({ companyId: w.co._id, fileId: w.file._id }).lean();
    expect(meeting.orderLineRef).toBe(w.lineRef);
    expect(meeting.orderRef).toBe(w.orderRef);
    expect(String(meeting.conductedBy.id)).toBe(w.taker.id);
    expect(String(meeting.issuedBy.id)).toBe(w.checker.id);

    /* PPC reads it through Merchandising's published contract… */
    const published = await publication.publishIssuedMeetingMinutes({ companyId: w.co._id }, [w.fileId]);
    expect(published.get(w.fileId)).toEqual(expect.objectContaining({
      meetingId: String(meeting._id), versionNo: 1, state: "ISSUED",
    }));
    /* …which carries identity and state, not the meeting's content. The one
       reviewed fact that crosses is WHICH engineering release was on the
       table, as identity: PPC freezes a release too, and nothing else could
       tell the two apart. */
    expect(Object.keys(published.get(w.fileId)).sort()).toEqual([
      "evidenceContract", "executionFileId", "issuedAt", "meetingId",
      "reviewedIeRelease", "state", "supersededAt", "supersededByVersionNo", "versionNo",
    ]);
    /* And it says WHICH engineering release was on the table, captured by
       Merchandising's own issue route from IE's own published contract —
       identity, so PPC can compare it with what its plan freezes. What PPC
       does when the two disagree is pinned in
       test/ppc/ppc-ppm-release-contract.test.js. */
    const reviewed = published.get(w.fileId).reviewedIeRelease;
    expect(Object.keys(reviewed).sort())
      .toEqual(["releaseId", "releaseRef", "reviewedAt", "state", "versionNo"]);
    expect(reviewed.releaseId).toMatch(/^[0-9a-f]{24}$/);
    expect(reviewed.versionNo).toBe(1);
    /* Captured under the current contract, so its silence would be a
       statement — and here it is not silent. */
    expect(published.get(w.fileId).evidenceContract)
      .toEqual({ version: 2, capturesReviewedRelease: true });
    /* Identity only: none of the meeting's own words travel with it. */
    for (const banned of ["observation", "decision", "attendee", "conclusion", "note"]) {
      expect(Object.keys(reviewed).join(" ").toLowerCase()).not.toContain(banned);
    }

    row = await orderBookRow(w);
    expect(row.inputs.ppmMinutes.state).toBe("SATISFIED");
    expect(row.readyToPlan).toBe(true);

    /* And PPC creates the planning file, freezing the issued version it read. */
    const created = await createPlanningFile(w);
    expect(created.status).toBe(201);
    const pf = created.body.planningFile;
    expect(pf.orderLineRef).toBe(w.lineRef);
    const raw = await mongoose.connection.collection("ppc_planning_files")
      .findOne({ _id: new mongoose.Types.ObjectId(pf.planningFileId) });
    expect(JSON.stringify(raw)).toContain(String(meeting._id));
    expect(JSON.stringify(raw)).toMatch(/"ppmVersionNo":1/);

    /* PPC wrote no meeting record, and Merchandising's record is untouched. */
    expect(await PreProductionMeeting.countDocuments({ companyId: w.co._id })).toBe(1);
    const after = await PreProductionMeeting.findById(meeting._id).lean();
    expect(after).toEqual(meeting);
  }, 300000);
});

/* ══ MISSING MINUTES ══════════════════════════════════════════════════════ */

describe("without issued minutes there is no planning file", () => {
  test("a draft, a conducted meeting and a cancelled one are all still missing to PPC", async () => {
    const w = await world("Missing");
    await call(`/merchandising/files/${w.fileId}/ppm`, {
      method: "POST", who: w.taker, co: w.co, body: { idempotencyKey: uniq() },
    });
    expect((await orderBookRow(w)).inputs.ppmMinutes.state).toBe("MISSING");
    expect((await createPlanningFile(w)).status).toBe(409);

    const cur = await call(`/merchandising/files/${w.fileId}/ppm`, { who: w.checker, co: w.co });
    const cancelled = await call(`/merchandising/files/${w.fileId}/ppm/cancel`, {
      method: "POST", who: w.checker, co: w.co,
      body: { idempotencyKey: uniq(), expectedRevision: cur.body.working.revision,
        reason: "The buyer postponed the meeting to next month." },
    });
    expect(cancelled.status).toBe(200);
    expect((await orderBookRow(w)).inputs.ppmMinutes.state).toBe("MISSING");
    const refused = await createPlanningFile(w);
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.unsatisfied).toContain("ppmMinutes");
  }, 240000);

  test("minutes on one line do not satisfy another line of the same company", async () => {
    const w = await world("TwoLines");
    const other = await confirmedLine(w.co, w.owner, "TwoLines-b");
    await pack(w.co, other.file, { accepted: true });
    await release(w.co, other.file.currentExecutionProjection.sampleStyleId, { accepted: true });

    const read = await conducted(w);
    expect((await call(`/merchandising/files/${w.fileId}/ppm/issue`, {
      method: "POST", who: w.checker, co: w.co,
      body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision },
    })).status).toBe(200);

    expect((await orderBookRow(w)).inputs.ppmMinutes.state).toBe("SATISFIED");
    const otherRow = await orderBookRow({ ...w, lineRef: other.lineRef });
    expect(otherRow.inputs.ppmMinutes.state).toBe("MISSING");
    expect((await createPlanningFile({ ...w, lineRef: other.lineRef })).status).toBe(409);
  }, 300000);
});

/* ══ REVISIONS AND DUPLICATE ISSUE ════════════════════════════════════════ */

describe("issue is checked, current and once", () => {
  test("a stale revision issues nothing, and PPC still sees no minutes", async () => {
    const w = await world("Stale");
    const read = await conducted(w);
    const stale = await call(`/merchandising/files/${w.fileId}/ppm/issue`, {
      method: "POST", who: w.checker, co: w.co,
      body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision - 1 },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("PPM_REVISION_CONFLICT");
    expect((await orderBookRow(w)).inputs.ppmMinutes.state).toBe("MISSING");
  }, 240000);

  test("the person who conducted the meeting cannot issue it", async () => {
    const w = await world("Self");
    const read = await conducted(w);
    const self = await call(`/merchandising/files/${w.fileId}/ppm/issue`, {
      method: "POST", who: w.taker, co: w.co,
      body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision },
    });
    /* The taker holds only the editor rung, so the ladder refuses first; the
       separation rule is proved on an approver in the PPM suite. */
    expect([403, 409]).toContain(self.status);
    expect((await orderBookRow(w)).inputs.ppmMinutes.state).toBe("MISSING");
  }, 240000);

  test("issuing twice issues once: a replay is the first answer, a new key is refused", async () => {
    const w = await world("Twice");
    const read = await conducted(w);
    const key = uniq();
    const body = { idempotencyKey: key, expectedRevision: read.body.working.revision };
    const first = await call(`/merchandising/files/${w.fileId}/ppm/issue`, { method: "POST", who: w.checker, co: w.co, body });
    const replay = await call(`/merchandising/files/${w.fileId}/ppm/issue`, { method: "POST", who: w.checker, co: w.co, body });
    const again = await call(`/merchandising/files/${w.fileId}/ppm/issue`, {
      method: "POST", who: w.checker, co: w.co,
      body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision },
    });
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    const { replayed: _a, ...firstBody } = first.body;
    const { replayed: _b, ...replayBody } = replay.body;
    expect(replayBody).toEqual(firstBody);
    expect([404, 409]).toContain(again.status);

    expect(await PreProductionMeeting.countDocuments({ companyId: w.co._id, state: "ISSUED" })).toBe(1);
    expect(await MerchandisingAuditEvent.countDocuments({ companyId: w.co._id, action: "PPM_ISSUED" })).toBe(1);
    const published = await publication.publishIssuedMeetingMinutes({ companyId: w.co._id }, [w.fileId]);
    expect(published.get(w.fileId).versionNo).toBe(1);

    /* And PPC plans once per key: a replayed create is the same file. */
    const pfKey = nextKey();
    const a = await createPlanningFile(w, pfKey);
    const b = await createPlanningFile(w, pfKey);
    expect(a.status).toBe(201);
    expect(b.body.planningFile.planningFileId).toBe(a.body.planningFile.planningFileId);
    expect(await mongoose.connection.collection("ppc_planning_files").countDocuments({ companyId: w.co._id })).toBe(1);
  }, 300000);
});

/* ══ TENANCY, AND WHO MAY WRITE ═══════════════════════════════════════════ */

describe("each company's minutes are its own, and only Merchandising writes them", () => {
  test("another company can neither issue this file's minutes nor see them", async () => {
    const mine = await world("Mine");
    const theirs = await world("Theirs");
    const read = await conducted(mine);

    /* Their approver, pointing at my file under their company: not found. */
    const foreign = await call(`/merchandising/files/${mine.fileId}/ppm/issue`, {
      method: "POST", who: theirs.checker, co: theirs.co,
      body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision },
    });
    expect(foreign.status).toBe(404);
    /* And under MY company they hold no membership, so they are refused. */
    const crossed = await call(`/merchandising/files/${mine.fileId}/ppm/issue`, {
      method: "POST", who: theirs.checker, co: mine.co,
      body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision },
    });
    expect([401, 403, 404]).toContain(crossed.status);
    expect(await PreProductionMeeting.countDocuments({ companyId: mine.co._id, state: "ISSUED" })).toBe(0);

    /* Issued properly, the minutes are published only under their own company. */
    await call(`/merchandising/files/${mine.fileId}/ppm/issue`, {
      method: "POST", who: mine.checker, co: mine.co,
      body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision },
    });
    const leak = await publication.publishIssuedMeetingMinutes({ companyId: theirs.co._id }, [mine.fileId]);
    expect(leak.size).toBe(0);
    const theirsLookup = await call(`/ppc/order-book/${encodeURIComponent(mine.lineRef)}`, { who: theirs.viewer, co: theirs.co });
    expect(theirsLookup.status).toBe(404);
  }, 300000);

  test("a PPC planner cannot write, conduct or issue meeting records", async () => {
    const w = await world("PpcCannot");
    const read = await conducted(w);
    for (const [path, body] of [
      [`/merchandising/files/${w.fileId}/ppm/issue`, { idempotencyKey: uniq(), expectedRevision: read.body.working.revision }],
      [`/merchandising/files/${w.fileId}/ppm/conduct`, { idempotencyKey: uniq(), expectedRevision: read.body.working.revision }],
      [`/merchandising/files/${w.fileId}/ppm/successor`, { idempotencyKey: uniq() }],
    ]) {
      const r = await call(path, { method: "POST", who: w.planner, co: w.co, body });
      expect(r.status).toBe(403);
    }
    const patch = await call(`/merchandising/files/${w.fileId}/ppm`, {
      method: "PATCH", who: w.planner, co: w.co, body: { expectedRevision: read.body.working.revision, chairperson: "PPC" },
    });
    expect(patch.status).toBe(403);
    expect(await PreProductionMeeting.countDocuments({ companyId: w.co._id, state: "ISSUED" })).toBe(0);

    /* And PPC's own code has no path to the meeting model except the
       read-only publication. */
    const fs = require("fs");
    const path = require("path");
    const dir = path.join(__dirname, "..", "..", "services", "ppc");
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      expect(src).not.toMatch(/PreProductionMeeting|preProductionMeeting\.service/);
    }
  }, 240000);
});
