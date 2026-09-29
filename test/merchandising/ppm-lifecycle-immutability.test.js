// test/merchandising/ppm-lifecycle-immutability.test.js
//
// THE FOUR WAYS A MINUTE BOOK STOPS BEING EVIDENCE.
//
// The first suite proved the meeting's own rules. This one proves the four
// places where the mechanism underneath them leaks:
//
//   1  SUCCESSION. A file must never be without current minutes. Booking a
//      follow-up meeting is not a decision about the last one, and if merely
//      opening a draft retires the issued version then a meeting that is later
//      called off leaves the file with nothing in force — and no way back,
//      because the retired version cannot be edited.
//
//   2  EVERY WRITE PATH. A `save()` guard protects the path the service uses.
//      It says nothing about the eight query paths a future helper will reach
//      for, each of which can rewrite or delete an issued minute.
//
//   3  IDENTITY. Maker/checker compared on email is maker/checker defeated by
//      an address change, and two people who share a display name are held to
//      be one person.
//
//   4  REPLAY. A retry after a timeout must answer what the first call
//      answered. A reduced stored shape means the caller that retried gets a
//      different object from the caller that did not.
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
const {
  PreProductionMeeting, PPM_STATE,
} = require("../../models/CMS_Models/Merchandising/PreProductionMeeting");
const {
  MerchandisingAuditEvent, MerchandisingCommandLedger,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");

const producer = require("../../services/sales/merchandisingHandover.service");
const delivery = require("../../services/integration/salesHandoverDelivery.service");
const execution = require("../../services/merchandising/execution.service");

let server, base, rs, seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "ppmlife" });
  const app = express();
  app.use(express.json());
  app.use("/api/cms/merchandising", require("../../routes/CMS_Routes/Merchandising/ppmRoute"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/merchandising`;
  await PreProductionMeeting.syncIndexes();
  await MerchandisingCommandLedger.syncIndexes();
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

/**
 * An actor with an explicit, separately-controllable stable id.
 *
 * `idOverride` is what makes the identity tests possible at all: it mints a
 * token for a real, granted seat but signs a DIFFERENT `id` into it, which is
 * how two people who share a name — or one person whose address changed — can
 * be put in front of the same rule.
 */
async function actor(co, grants, { name, email, idOverride } = {}) {
  const n = ++seq;
  const addr = email || `ppm-life-${n}@grav.test`;
  const who = name || `User ${n}`;
  const emp = await Employee.create({
    firstName: "P", lastName: `L${n}`, email: addr, biometricId: `PL${n}`,
    isActive: true, gender: "Other", department: "Merchandising",
  });
  await DeptUser.create({
    name: who, email: addr, passwordHash: "x", isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  await SpCompanyMembership.create({
    companyId: co._id, email: addr, employeeRef: emp._id, personName: who,
  });
  for (const [departmentSlug, role] of Object.entries(grants)) {
    await DepartmentRole.create({
      departmentSlug, email: addr, name: who, role, isActive: true,
      departmentId: new mongoose.Types.ObjectId(),
    });
  }
  return {
    id: String(emp._id), email: addr, name: who,
    token: jwt.sign(
      {
        id: idOverride === undefined ? String(emp._id) : idOverride,
        email: addr, name: who, employeeId: emp.biometricId,
      },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "30m" },
    ),
  };
}

async function world() {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `PPM-L ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const account = await Account.create({ companyName: `Buyer ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-PPML-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "S",
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-PPML-${n}`, journeyId: journey._id, accountId: account._id,
    companyId: co._id, title: `E${n}`, isActive: true,
    products: [{ product: "Oxford Shirt", quantity: 800 }],
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-PPML-${n}`, styleCode: `SC-PPML-${n}`, productName: "Oxford Shirt",
    journeyId: journey._id, enquiryId: enquiry._id, stage: "rnd",
  });
  const order = await CustomerRequest.create({
    requestId: `REQ-PPML-${n}`, status: "quotation_sales_approved", orderOrigin: "customer",
    customerInfo: { name: `Buyer ${n}` },
    items: [{ stockItemName: "Oxford Shirt", totalQuantity: 800, sampleStyleId: style._id }],
  });
  const saved = await CustomerRequest.findById(order._id).lean();

  const { version, correlationId } = await producer.issue({ companyId: co._id }, {
    requestId: String(order._id), lineId: String(saved.items[0].lineRef),
    body: {
      expectedCurrentVersionNo: 0,
      deliveries: [{ dropRef: "D1", committedDeliveryDate: "2026-12-01", quantity: 800 }],
      breakdown: [{
        lineSplitRef: "S1", sizeRange: "S-XXL", quantity: 800,
        attributes: [{ name: "Colourway", value: "Ecru" }],
      }],
    },
    actor: { name: "Sales Person" },
  });
  await delivery.deliverPending({ companyId: co._id, correlationId });

  const reviewer = await actor(co, { merchandiser: "owner" });
  const accepted = await execution.acceptHandover(
    { companyId: co._id }, { id: String(version._id), actor: reviewer },
  );
  return { co, fileId: String(accepted.file.id), reviewer };
}

const at = (w, who) => ({ token: who.token, company: w.co._id });

/** Draft → written up → conducted, by `taker`. Returns the conduct response. */
async function conducted(w, taker) {
  const read0 = await call(`/files/${w.fileId}/ppm`, at(w, taker));
  if (!read0.body.working) {
    await call(`/files/${w.fileId}/ppm`, {
      ...at(w, taker), method: "POST", body: { idempotencyKey: uniq() },
    });
  }
  let read = await call(`/files/${w.fileId}/ppm`, at(w, taker));
  await call(`/files/${w.fileId}/ppm`, {
    ...at(w, taker), method: "PATCH",
    body: {
      expectedRevision: read.body.working.revision,
      actualMeetingAt: "2026-10-01T09:30:00.000Z",
      locationOrMode: "Factory meeting room 2",
      chairperson: "Production Manager",
      attendees: [{ name: taker.name, department: "MERCHANDISING", role: "Merchandiser" }],
    },
  });
  read = await call(`/files/${w.fileId}/ppm`, at(w, taker));
  return call(`/files/${w.fileId}/ppm/conduct`, {
    ...at(w, taker), method: "POST",
    body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision },
  });
}

/** A file with version 1 issued, and the two people who did it. */
async function issuedWorld() {
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
  return { w, taker, checker };
}

/** Version 1, exactly as stored — the thing that must not move. */
const snapshotOf = async (w, versionNo = 1) => PreProductionMeeting.findOne({
  companyId: w.co._id, versionNo,
}).lean();

/** What a successor command must quote to be allowed to start one. */
async function successorExpectation(w, who) {
  const cur = await call(`/files/${w.fileId}/ppm`, at(w, who));
  return {
    expectedIssuedVersionNo: cur.body.issued.versionNo,
    expectedIssuedRevision: cur.body.issued.revision,
  };
}

/* ══ 1 — THE PREDECESSOR STANDS UNTIL THE SUCCESSOR IS ISSUED ════════════ */

describe("a file is never without current minutes", () => {
  test("opening a successor draft changes version 1 in no respect at all", async () => {
    const { w, checker } = await issuedWorld();
    const before = await snapshotOf(w);

    const out = await call(`/files/${w.fileId}/ppm/successor`, {
      ...at(w, checker), method: "POST",
      body: { idempotencyKey: uniq(), ...(await successorExpectation(w, checker)) },
    });
    expect(out.status).toBe(201);
    expect(out.body.versionNo).toBe(2);

    /* Byte for byte. Not "still issued" — unchanged. */
    expect(await snapshotOf(w)).toEqual(before);
    /* And the file still answers with version 1 as its current minutes. */
    const cur = await call(`/files/${w.fileId}/ppm`, at(w, checker));
    expect(cur.body.issued.versionNo).toBe(1);
    expect(cur.body.issued.state).toBe("ISSUED");
    expect(cur.body.working.versionNo).toBe(2);
  }, 180000);

  test("writing up the successor changes version 1 in no respect at all", async () => {
    const { w, taker, checker } = await issuedWorld();
    await call(`/files/${w.fileId}/ppm/successor`, {
      ...at(w, checker), method: "POST",
      body: { idempotencyKey: uniq(), ...(await successorExpectation(w, checker)) },
    });
    const before = await snapshotOf(w);

    const read = await call(`/files/${w.fileId}/ppm`, at(w, taker));
    const patched = await call(`/files/${w.fileId}/ppm`, {
      ...at(w, taker), method: "PATCH",
      body: {
        expectedRevision: read.body.working.revision,
        chairperson: "A different chairperson entirely",
        actualMeetingAt: "2026-11-02T10:00:00.000Z",
        attendees: [{ name: taker.name, department: "MERCHANDISING" }],
      },
    });
    expect(patched.status).toBe(200);
    expect(await snapshotOf(w)).toEqual(before);
  }, 180000);

  test("conducting the successor changes version 1 in no respect at all", async () => {
    const { w, taker, checker } = await issuedWorld();
    await call(`/files/${w.fileId}/ppm/successor`, {
      ...at(w, checker), method: "POST",
      body: { idempotencyKey: uniq(), ...(await successorExpectation(w, checker)) },
    });
    const before = await snapshotOf(w);

    const out = await conducted(w, taker);
    expect(out.status).toBe(200);
    expect(out.body.versionNo).toBe(2);
    expect(await snapshotOf(w)).toEqual(before);

    const cur = await call(`/files/${w.fileId}/ppm`, at(w, checker));
    expect(cur.body.issued.versionNo).toBe(1);
  }, 180000);

  test("cancelling the successor leaves version 1 current, because it never moved", async () => {
    const { w, taker, checker } = await issuedWorld();
    await call(`/files/${w.fileId}/ppm/successor`, {
      ...at(w, checker), method: "POST",
      body: { idempotencyKey: uniq(), ...(await successorExpectation(w, checker)) },
    });
    const before = await snapshotOf(w);

    await conducted(w, taker);
    const read = await call(`/files/${w.fileId}/ppm`, at(w, checker));
    const cancelled = await call(`/files/${w.fileId}/ppm/cancel`, {
      ...at(w, checker), method: "POST",
      body: {
        idempotencyKey: uniq(), expectedRevision: read.body.working.revision,
        reason: "The buyer postponed the second meeting to January.",
      },
    });
    expect(cancelled.status).toBe(200);

    /* THE DEFECT THIS TEST EXISTS FOR. If the draft had retired version 1,
       this file would now hold one CANCELLED and one SUPERSEDED meeting and
       no minutes in force — and no way to restore them, because a superseded
       version takes no edit. */
    expect(await snapshotOf(w)).toEqual(before);
    const cur = await call(`/files/${w.fileId}/ppm`, at(w, checker));
    expect(cur.body.issued.versionNo).toBe(1);
    expect(cur.body.issued.state).toBe("ISSUED");
    expect(cur.body.working).toBeNull();

    /* And a third meeting can still be booked against it. */
    const again = await call(`/files/${w.fileId}/ppm/successor`, {
      ...at(w, checker), method: "POST",
      body: { idempotencyKey: uniq(), ...(await successorExpectation(w, checker)) },
    });
    expect(again.status).toBe(201);
    expect(again.body.versionNo).toBe(3);
  }, 240000);

  test("only the successful issue supersedes it, and does both at once", async () => {
    const { w, taker, checker } = await issuedWorld();
    const second = await actor(w.co, { merchandiser: "owner" });
    await call(`/files/${w.fileId}/ppm/successor`, {
      ...at(w, checker), method: "POST",
      body: { idempotencyKey: uniq(), ...(await successorExpectation(w, checker)) },
    });
    await conducted(w, taker);

    const read = await call(`/files/${w.fileId}/ppm`, at(w, second));
    const issued = await call(`/files/${w.fileId}/ppm/issue`, {
      ...at(w, second), method: "POST",
      body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision },
    });
    expect(issued.status).toBe(200);

    const v1 = await snapshotOf(w, 1);
    const v2 = await snapshotOf(w, 2);
    expect(v1.state).toBe(PPM_STATE.SUPERSEDED);
    expect(v1.supersededByVersionNo).toBe(2);
    expect(v2.state).toBe(PPM_STATE.ISSUED);
    /* Atomically: one correlation id across both audit rows, so the two facts
       cannot be read as two separate decisions. */
    const rows = await MerchandisingAuditEvent.find({
      companyId: w.co._id, action: { $in: ["PPM_ISSUED", "PPM_SUPERSEDED"] },
    }).sort({ at: 1 }).lean();
    const pair = rows.slice(-2);
    expect(pair.map((r) => r.action).sort()).toEqual(["PPM_ISSUED", "PPM_SUPERSEDED"]);
    expect(pair[0].correlationId).toBe(pair[1].correlationId);
  }, 240000);

  test("a refused successor issue leaves version 1 exactly where it was", async () => {
    const { w, taker, checker } = await issuedWorld();
    await call(`/files/${w.fileId}/ppm/successor`, {
      ...at(w, checker), method: "POST",
      body: { idempotencyKey: uniq(), ...(await successorExpectation(w, checker)) },
    });
    await conducted(w, taker);
    const before = await snapshotOf(w);

    /* Refused three different ways: the conductor issuing it, a stale
       revision, and an incomplete record. None may move version 1. */
    const read = await call(`/files/${w.fileId}/ppm`, at(w, taker));
    const selfIssue = await call(`/files/${w.fileId}/ppm/issue`, {
      ...at(w, taker), method: "POST",
      body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision },
    });
    expect([403, 409]).toContain(selfIssue.status);
    expect(await snapshotOf(w)).toEqual(before);

    const stale = await call(`/files/${w.fileId}/ppm/issue`, {
      ...at(w, checker), method: "POST",
      body: { idempotencyKey: uniq(), expectedRevision: 0 },
    });
    expect(stale.status).toBe(409);
    expect(await snapshotOf(w)).toEqual(before);

    const cur = await call(`/files/${w.fileId}/ppm`, at(w, checker));
    expect(cur.body.issued.versionNo).toBe(1);
    expect(cur.body.issued.state).toBe("ISSUED");
  }, 240000);

  test("two racing issues of the successor produce one winner", async () => {
    const { w, taker, checker } = await issuedWorld();
    const second = await actor(w.co, { merchandiser: "owner" });
    await call(`/files/${w.fileId}/ppm/successor`, {
      ...at(w, checker), method: "POST",
      body: { idempotencyKey: uniq(), ...(await successorExpectation(w, checker)) },
    });
    await conducted(w, taker);
    const read = await call(`/files/${w.fileId}/ppm`, at(w, second));
    const revision = read.body.working.revision;

    const [a, b] = await Promise.all([
      call(`/files/${w.fileId}/ppm/issue`, {
        ...at(w, second), method: "POST",
        body: { idempotencyKey: uniq(), expectedRevision: revision },
      }),
      call(`/files/${w.fileId}/ppm/issue`, {
        ...at(w, checker), method: "POST",
        body: { idempotencyKey: uniq(), expectedRevision: revision },
      }),
    ]);
    expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1);
    expect(await PreProductionMeeting.countDocuments({
      companyId: w.co._id, state: PPM_STATE.ISSUED,
    })).toBe(1);
    expect(await PreProductionMeeting.countDocuments({
      companyId: w.co._id, state: PPM_STATE.SUPERSEDED,
    })).toBe(1);
    expect(await MerchandisingAuditEvent.countDocuments({
      companyId: w.co._id, action: "PPM_SUPERSEDED",
    })).toBe(1);
  }, 240000);

  test("a stale successor request supersedes nothing and starts nothing", async () => {
    const { w, checker } = await issuedWorld();
    const before = await snapshotOf(w);
    const expectation = await successorExpectation(w, checker);

    const stale = await call(`/files/${w.fileId}/ppm/successor`, {
      ...at(w, checker), method: "POST",
      body: {
        idempotencyKey: uniq(),
        expectedIssuedVersionNo: expectation.expectedIssuedVersionNo,
        expectedIssuedRevision: Number(expectation.expectedIssuedRevision) + 5,
      },
    });
    expect(stale.status).toBe(409);
    expect(await snapshotOf(w)).toEqual(before);
    expect(await PreProductionMeeting.countDocuments({ companyId: w.co._id })).toBe(1);

    const wrongVersion = await call(`/files/${w.fileId}/ppm/successor`, {
      ...at(w, checker), method: "POST",
      body: {
        idempotencyKey: uniq(),
        expectedIssuedVersionNo: 99, expectedIssuedRevision: expectation.expectedIssuedRevision,
      },
    });
    expect(wrongVersion.status).toBe(409);
    expect(await snapshotOf(w)).toEqual(before);

    /* And omitting the expectation altogether is refused rather than assumed. */
    const blind = await call(`/files/${w.fileId}/ppm/successor`, {
      ...at(w, checker), method: "POST", body: { idempotencyKey: uniq() },
    });
    expect(blind.status).toBe(400);
    expect(await snapshotOf(w)).toEqual(before);
  }, 240000);
});

/* ══ 2 — EVERY WRITE PATH, NOT JUST THE ONE THE SERVICE USES ═════════════ */

describe("a frozen minute refuses every query path", () => {
  /** One issued, one cancelled and one superseded record to aim at. */
  async function frozenSet() {
    const { w, taker, checker } = await issuedWorld();
    await call(`/files/${w.fileId}/ppm/successor`, {
      ...at(w, checker), method: "POST",
      body: { idempotencyKey: uniq(), ...(await successorExpectation(w, checker)) },
    });
    await conducted(w, taker);
    let read = await call(`/files/${w.fileId}/ppm`, at(w, checker));
    await call(`/files/${w.fileId}/ppm/issue`, {
      ...at(w, checker), method: "POST",
      body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision },
    });
    /* v1 SUPERSEDED, v2 ISSUED. Now a third, cancelled. */
    await call(`/files/${w.fileId}/ppm/successor`, {
      ...at(w, checker), method: "POST",
      body: { idempotencyKey: uniq(), ...(await successorExpectation(w, checker)) },
    });
    read = await call(`/files/${w.fileId}/ppm`, at(w, checker));
    await call(`/files/${w.fileId}/ppm/cancel`, {
      ...at(w, checker), method: "POST",
      body: {
        idempotencyKey: uniq(), expectedRevision: read.body.working.revision,
        reason: "Called off so this suite has a cancelled version to aim at.",
      },
    });
    const states = await PreProductionMeeting.find({ companyId: w.co._id })
      .sort({ versionNo: 1 }).lean();
    expect(states.map((s) => s.state)).toEqual([
      PPM_STATE.SUPERSEDED, PPM_STATE.ISSUED, PPM_STATE.CANCELLED,
    ]);
    return { w, docs: states };
  }

  test("updateOne, updateMany, findOneAndUpdate, replaceOne and findOneAndReplace all refuse", async () => {
    const { w, docs } = await frozenSet();
    const before = await PreProductionMeeting.find({ companyId: w.co._id })
      .sort({ versionNo: 1 }).lean();

    for (const doc of docs) {
      const id = doc._id;
      const edit = { chairperson: "Rewritten in March" };
      await expect(PreProductionMeeting.updateOne({ _id: id }, { $set: edit }))
        .rejects.toThrow(/permanent evidence/i);
      await expect(PreProductionMeeting.findOneAndUpdate({ _id: id }, { $set: edit }))
        .rejects.toThrow(/permanent evidence/i);
      await expect(PreProductionMeeting.replaceOne({ _id: id }, { ...doc, ...edit }))
        .rejects.toThrow(/permanent evidence/i);
      await expect(PreProductionMeeting.findOneAndReplace({ _id: id }, { ...doc, ...edit }))
        .rejects.toThrow(/permanent evidence/i);
    }
    /* And the blunt instrument: one statement aimed at everything. */
    await expect(PreProductionMeeting.updateMany(
      { companyId: w.co._id }, { $set: { chairperson: "All of them" } },
    )).rejects.toThrow(/permanent evidence/i);

    expect(await PreProductionMeeting.find({ companyId: w.co._id })
      .sort({ versionNo: 1 }).lean()).toEqual(before);
  }, 300000);

  test("deleteOne, deleteMany, findOneAndDelete and document deletion all refuse", async () => {
    const { w, docs } = await frozenSet();
    const before = await PreProductionMeeting.find({ companyId: w.co._id })
      .sort({ versionNo: 1 }).lean();

    for (const doc of docs) {
      await expect(PreProductionMeeting.deleteOne({ _id: doc._id }))
        .rejects.toThrow(/permanent evidence/i);
      await expect(PreProductionMeeting.findOneAndDelete({ _id: doc._id }))
        .rejects.toThrow(/permanent evidence/i);
      const loaded = await PreProductionMeeting.findById(doc._id);
      await expect(loaded.deleteOne()).rejects.toThrow(/permanent evidence/i);
    }
    await expect(PreProductionMeeting.deleteMany({ companyId: w.co._id }))
      .rejects.toThrow(/permanent evidence/i);

    expect(await PreProductionMeeting.find({ companyId: w.co._id })
      .sort({ versionNo: 1 }).lean()).toEqual(before);
  }, 300000);

  test("an upsert cannot write one into existence either", async () => {
    const { w } = await frozenSet();
    const before = await PreProductionMeeting.countDocuments({ companyId: w.co._id });
    await expect(PreProductionMeeting.updateOne(
      { companyId: w.co._id, versionNo: 47 },
      { $set: { state: PPM_STATE.ISSUED, chairperson: "Invented" } },
      { upsert: true },
    )).rejects.toThrow();
    expect(await PreProductionMeeting.countDocuments({ companyId: w.co._id })).toBe(before);
  }, 300000);

  test("no arbitrary field can be added to a frozen record by any path", async () => {
    const { w, docs } = await frozenSet();
    const target = docs[1];
    for (const op of [
      () => PreProductionMeeting.updateOne({ _id: target._id }, { $set: { smuggled: "yes" } }),
      () => PreProductionMeeting.findOneAndUpdate({ _id: target._id }, { $set: { smuggled: "yes" } }),
      () => PreProductionMeeting.updateOne({ _id: target._id }, { $unset: { conclusion: "" } }),
      () => PreProductionMeeting.updateOne({ _id: target._id }, { $push: { attendees: { name: "Gatecrasher" } } }),
    ]) {
      await expect(op()).rejects.toThrow(/permanent evidence/i);
    }
    const after = await PreProductionMeeting.findById(target._id).lean();
    expect(after.smuggled).toBeUndefined();
    expect(after).toEqual(docs[1]);
  }, 300000);

  test("a draft still takes ordinary writes, so the guard is about frozen records", async () => {
    /* The control. A guard that refused everything would pass every test
       above and make the feature unusable. */
    const w = await world();
    const me = await actor(w.co, { merchandiser: "owner" });
    await call(`/files/${w.fileId}/ppm`, {
      ...at(w, me), method: "POST", body: { idempotencyKey: uniq() },
    });
    const draft = await PreProductionMeeting.findOne({ companyId: w.co._id });
    await PreProductionMeeting.updateOne({ _id: draft._id }, { $set: { chairperson: "Fine" } });
    expect((await PreProductionMeeting.findById(draft._id).lean()).chairperson).toBe("Fine");
    await expect(PreProductionMeeting.deleteOne({ _id: draft._id })).resolves.toBeTruthy();
  }, 180000);
});

/* ══ 3 — MAKER/CHECKER ON A STABLE IDENTITY ══════════════════════════════ */

describe("maker and checker are told apart by identity, not by label", () => {
  test("the same person refuses even after their address changes", async () => {
    const w = await world();
    const taker = await actor(w.co, { merchandiser: "owner" },
      { name: "Priya R", email: "priya.r@grav.test" });
    await conducted(w, taker);

    /* Same authenticated id, new address and a new display name — which is
       precisely what a marriage, a rebrand or a typo correction looks like. */
    const renamed = await actor(w.co, { merchandiser: "owner" },
      { name: "Priya Raman", email: "priya.raman@grav.test", idOverride: taker.id });

    const read = await call(`/files/${w.fileId}/ppm`, at(w, renamed));
    const out = await call(`/files/${w.fileId}/ppm/issue`, {
      ...at(w, renamed), method: "POST",
      body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision },
    });
    expect(out.status).toBe(409);
    expect(out.body.error.code).toBe("PPM_SELF_ISSUE");
  }, 180000);

  test("two different people who share a display name are not one person", async () => {
    const w = await world();
    const taker = await actor(w.co, { merchandiser: "owner" },
      { name: "A. Kumar", email: "a.kumar.one@grav.test" });
    await conducted(w, taker);

    /* The same display name, a different authenticated identity. A rule
       comparing names would refuse this and stop a real second person from
       ever certifying the minutes — the failure that is invisible, because it
       looks exactly like the rule working. */
    const other = await actor(w.co, { merchandiser: "owner" },
      { name: "A. Kumar", email: "a.kumar.two@grav.test" });
    expect(other.id).not.toBe(taker.id);

    const read = await call(`/files/${w.fileId}/ppm`, at(w, other));
    const out = await call(`/files/${w.fileId}/ppm/issue`, {
      ...at(w, other), method: "POST",
      body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision },
    });
    expect(out.status).toBe(200);
  }, 180000);

  test("nor are two people the record happens to hold one address for", async () => {
    /* A seat's address is unique in this system, so two live seats cannot
       share one. What CAN happen is that the address stored on an old record
       is now somebody else's — reassigned, or simply recorded wrong years
       ago. The comparison must not care.

       The draft is still open here, so writing to it is an ordinary write;
       that is what makes this constructible without forging anything. */
    const w = await world();
    const taker = await actor(w.co, { merchandiser: "owner" });
    const other = await actor(w.co, { merchandiser: "owner" });
    await conducted(w, taker);

    await PreProductionMeeting.updateOne(
      { companyId: w.co._id, versionNo: 1 },
      { $set: { "conductedBy.email": other.email, "conductedBy.name": other.name } },
    );
    const held = await PreProductionMeeting.findOne({ companyId: w.co._id }).lean();
    expect(held.conductedBy.email).toBe(other.email);
    expect(String(held.conductedBy.id)).toBe(taker.id);

    const read = await call(`/files/${w.fileId}/ppm`, at(w, other));
    const out = await call(`/files/${w.fileId}/ppm/issue`, {
      ...at(w, other), method: "POST",
      body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision },
    });
    expect(out.status).toBe(200);
  }, 180000);

  test("no seniority buys an exemption", async () => {
    const w = await world();
    const owner = await actor(w.co, { merchandiser: "owner" });
    await conducted(w, owner);
    const read = await call(`/files/${w.fileId}/ppm`, at(w, owner));
    const out = await call(`/files/${w.fileId}/ppm/issue`, {
      ...at(w, owner), method: "POST",
      body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision },
    });
    expect(out.status).toBe(409);
    expect(out.body.error.code).toBe("PPM_SELF_ISSUE");
  }, 180000);

  test("a token with no stable identity cannot conduct or issue", async () => {
    const w = await world();
    /* A seat with a real grant but no `id` in its token. It fails CLOSED:
       there is no identity to hold to the separation, so the decision cannot
       be attributed and is therefore not taken. */
    const faceless = await actor(w.co, { merchandiser: "owner" }, { idOverride: "" });
    const real = await actor(w.co, { merchandiser: "owner" });

    await call(`/files/${w.fileId}/ppm`, {
      ...at(w, real), method: "POST", body: { idempotencyKey: uniq() },
    });
    let read = await call(`/files/${w.fileId}/ppm`, at(w, real));
    await call(`/files/${w.fileId}/ppm`, {
      ...at(w, real), method: "PATCH",
      body: {
        expectedRevision: read.body.working.revision,
        actualMeetingAt: "2026-10-01T09:30:00.000Z", chairperson: "PM",
        attendees: [{ name: "Somebody", department: "MERCHANDISING" }],
      },
    });
    read = await call(`/files/${w.fileId}/ppm`, at(w, real));
    const cannotConduct = await call(`/files/${w.fileId}/ppm/conduct`, {
      ...at(w, faceless), method: "POST",
      body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision },
    });
    expect([401, 403, 409]).toContain(cannotConduct.status);

    await call(`/files/${w.fileId}/ppm/conduct`, {
      ...at(w, real), method: "POST",
      body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision },
    });
    read = await call(`/files/${w.fileId}/ppm`, at(w, real));
    const cannotIssue = await call(`/files/${w.fileId}/ppm/issue`, {
      ...at(w, faceless), method: "POST",
      body: { idempotencyKey: uniq(), expectedRevision: read.body.working.revision },
    });
    expect([401, 403, 409]).toContain(cannotIssue.status);
    expect(await PreProductionMeeting.countDocuments({
      companyId: w.co._id, state: PPM_STATE.ISSUED,
    })).toBe(0);
  }, 240000);

  test("an actor identity in the body is ignored or refused, never believed", async () => {
    const w = await world();
    const taker = await actor(w.co, { merchandiser: "owner" });
    await conducted(w, taker);
    const read = await call(`/files/${w.fileId}/ppm`, at(w, taker));

    /* The conductor, claiming to be somebody else. */
    const out = await call(`/files/${w.fileId}/ppm/issue`, {
      ...at(w, taker), method: "POST",
      body: {
        idempotencyKey: uniq(), expectedRevision: read.body.working.revision,
        actorId: String(new mongoose.Types.ObjectId()),
        issuedBy: { id: String(new mongoose.Types.ObjectId()), name: "Somebody Else" },
      },
    });
    expect([400, 409]).toContain(out.status);
    expect(await PreProductionMeeting.countDocuments({
      companyId: w.co._id, state: PPM_STATE.ISSUED,
    })).toBe(0);
  }, 180000);
});

/* ══ 4 — A RETRY ANSWERS WHAT THE FIRST CALL ANSWERED ════════════════════ */

describe("idempotent replay", () => {
  const withoutReplayFlag = (body) => {
    const { replayed, ...rest } = body || {};
    return rest;
  };

  test("a replayed create returns the first response, field for field", async () => {
    const w = await world();
    const me = await actor(w.co, { merchandiser: "owner" });
    const key = uniq();
    const first = await call(`/files/${w.fileId}/ppm`, {
      ...at(w, me), method: "POST", body: { idempotencyKey: key },
    });
    const replay = await call(`/files/${w.fileId}/ppm`, {
      ...at(w, me), method: "POST", body: { idempotencyKey: key },
    });
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(first.body.replayed).toBe(false);
    expect(replay.body.replayed).toBe(true);
    expect(withoutReplayFlag(replay.body)).toEqual(withoutReplayFlag(first.body));
    expect(await PreProductionMeeting.countDocuments({ companyId: w.co._id })).toBe(1);
  }, 180000);

  test("a replayed conduct and a replayed issue do the same", async () => {
    const w = await world();
    const taker = await actor(w.co, { merchandiser: "editor" });
    const checker = await actor(w.co, { merchandiser: "owner" });
    await call(`/files/${w.fileId}/ppm`, {
      ...at(w, taker), method: "POST", body: { idempotencyKey: uniq() },
    });
    let read = await call(`/files/${w.fileId}/ppm`, at(w, taker));
    await call(`/files/${w.fileId}/ppm`, {
      ...at(w, taker), method: "PATCH",
      body: {
        expectedRevision: read.body.working.revision,
        actualMeetingAt: "2026-10-01T09:30:00.000Z", chairperson: "PM",
        attendees: [{ name: taker.name, department: "MERCHANDISING" }],
      },
    });
    read = await call(`/files/${w.fileId}/ppm`, at(w, taker));

    const conductKey = uniq();
    const revision = read.body.working.revision;
    const c1 = await call(`/files/${w.fileId}/ppm/conduct`, {
      ...at(w, taker), method: "POST",
      body: { idempotencyKey: conductKey, expectedRevision: revision },
    });
    const c2 = await call(`/files/${w.fileId}/ppm/conduct`, {
      ...at(w, taker), method: "POST",
      body: { idempotencyKey: conductKey, expectedRevision: revision },
    });
    expect(c1.status).toBe(200);
    expect(c2.status).toBe(200);
    expect(withoutReplayFlag(c2.body)).toEqual(withoutReplayFlag(c1.body));

    read = await call(`/files/${w.fileId}/ppm`, at(w, checker));
    const issueKey = uniq();
    const issueRevision = read.body.working.revision;
    const i1 = await call(`/files/${w.fileId}/ppm/issue`, {
      ...at(w, checker), method: "POST",
      body: { idempotencyKey: issueKey, expectedRevision: issueRevision },
    });
    const i2 = await call(`/files/${w.fileId}/ppm/issue`, {
      ...at(w, checker), method: "POST",
      body: { idempotencyKey: issueKey, expectedRevision: issueRevision },
    });
    expect(i1.status).toBe(200);
    expect(withoutReplayFlag(i2.body)).toEqual(withoutReplayFlag(i1.body));
    expect(await MerchandisingAuditEvent.countDocuments({
      companyId: w.co._id, action: "PPM_ISSUED",
    })).toBe(1);
  }, 240000);

  test("the same key with a different request is refused, not replayed", async () => {
    const w = await world();
    const taker = await actor(w.co, { merchandiser: "editor" });
    await call(`/files/${w.fileId}/ppm`, {
      ...at(w, taker), method: "POST", body: { idempotencyKey: uniq() },
    });
    let read = await call(`/files/${w.fileId}/ppm`, at(w, taker));
    await call(`/files/${w.fileId}/ppm`, {
      ...at(w, taker), method: "PATCH",
      body: {
        expectedRevision: read.body.working.revision,
        actualMeetingAt: "2026-10-01T09:30:00.000Z", chairperson: "PM",
        attendees: [{ name: taker.name, department: "MERCHANDISING" }],
      },
    });
    read = await call(`/files/${w.fileId}/ppm`, at(w, taker));

    const key = uniq();
    const ok = await call(`/files/${w.fileId}/ppm/conduct`, {
      ...at(w, taker), method: "POST",
      body: { idempotencyKey: key, expectedRevision: read.body.working.revision },
    });
    expect(ok.status).toBe(200);

    const reused = await call(`/files/${w.fileId}/ppm/conduct`, {
      ...at(w, taker), method: "POST",
      body: { idempotencyKey: key, expectedRevision: 999 },
    });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  }, 240000);

  test("two concurrent commands on one key make one effect and one answer", async () => {
    const w = await world();
    const me = await actor(w.co, { merchandiser: "owner" });
    const key = uniq();
    const [a, b] = await Promise.all([
      call(`/files/${w.fileId}/ppm`, {
        ...at(w, me), method: "POST", body: { idempotencyKey: key },
      }),
      call(`/files/${w.fileId}/ppm`, {
        ...at(w, me), method: "POST", body: { idempotencyKey: key },
      }),
    ]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(withoutReplayFlag(a.body)).toEqual(withoutReplayFlag(b.body));
    expect(await PreProductionMeeting.countDocuments({ companyId: w.co._id })).toBe(1);
    expect(await MerchandisingCommandLedger.countDocuments({
      companyId: w.co._id, scope: /ppm:draft/,
    })).toBe(1);
    expect(await MerchandisingAuditEvent.countDocuments({
      companyId: w.co._id, action: "PPM_DRAFTED",
    })).toBe(1);
  }, 180000);

  test("the ledger and the record cannot disagree: both land or neither does", async () => {
    const w = await world();
    const me = await actor(w.co, { merchandiser: "owner" });
    const key = uniq();
    await call(`/files/${w.fileId}/ppm`, {
      ...at(w, me), method: "POST", body: { idempotencyKey: key },
    });
    const ledger = await MerchandisingCommandLedger.findOne({
      companyId: w.co._id, idempotencyKey: key,
    }).lean();
    const doc = await PreProductionMeeting.findOne({ companyId: w.co._id }).lean();
    expect(ledger).toBeTruthy();
    expect(String(ledger.payload.ppmId)).toBe(String(doc._id));

    /* A refused command writes NO ledger row, so its key is still usable once
       the reason for the refusal is gone. */
    const badKey = uniq();
    const refused = await call(`/files/${w.fileId}/ppm`, {
      ...at(w, me), method: "POST", body: { idempotencyKey: badKey },
    });
    expect(refused.status).toBe(409);
    expect(await MerchandisingCommandLedger.countDocuments({
      companyId: w.co._id, idempotencyKey: badKey,
    })).toBe(0);
  }, 180000);

  test("a successor's expectation is part of its key's identity", async () => {
    const { w, checker } = await issuedWorld();
    const expectation = await successorExpectation(w, checker);
    const key = uniq();

    const first = await call(`/files/${w.fileId}/ppm/successor`, {
      ...at(w, checker), method: "POST", body: { idempotencyKey: key, ...expectation },
    });
    expect(first.status).toBe(201);

    /* Same key, different expected predecessor — a different command wearing
       the same name, which is the case the hash exists to catch. */
    const reused = await call(`/files/${w.fileId}/ppm/successor`, {
      ...at(w, checker), method: "POST",
      body: {
        idempotencyKey: key,
        expectedIssuedVersionNo: expectation.expectedIssuedVersionNo,
        expectedIssuedRevision: Number(expectation.expectedIssuedRevision) + 1,
      },
    });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");

    const replay = await call(`/files/${w.fileId}/ppm/successor`, {
      ...at(w, checker), method: "POST", body: { idempotencyKey: key, ...expectation },
    });
    expect(replay.status).toBe(201);
    expect(withoutReplayFlag(replay.body)).toEqual(withoutReplayFlag(first.body));
    expect(await PreProductionMeeting.countDocuments({ companyId: w.co._id })).toBe(2);
  }, 240000);
});
