// test/requests/attachments.route.test.js
//
// QUOTES AND PROOF ON A PURCHASE OR SERVICE REQUEST.
//
// Optional at submission, deliberately: a repair often needs approving before a
// vendor will quote it, and demanding proof up front only teaches people to
// attach something meaningless. Finance may ask for it before approving, and
// the review card says when that is expected.
//
// ── WHAT IS ACTUALLY BEING GUARDED ──────────────────────────────────────────
// A quote carries a vendor, a price and terms. The bytes live in a private
// Drive folder and the only way back to them is an authenticated route that
// checks the REQUEST first and then that the file belongs to it — so a file id
// on its own opens nothing. The voucher attachment route does not do that
// second check; this one does, and these tests are why.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

/* Drive is stubbed. What is under test is the ACCESS decision and the metadata
   rules, which are ours; putting bytes in Drive is Google's job. */
jest.mock("../../services/voucherDriveUpload.service", () => ({
  uploadVoucherAttachment: jest.fn(async (_buf, { fileName, mimeType }) => ({
    fileId: `drive-${Math.random().toString(36).slice(2, 10)}`,
    fileName, mimeType, size: 1234,
  })),
  streamVoucherAttachment: jest.fn(async (fileId) => {
    const { Readable } = require("stream");
    return {
      stream: Readable.from([Buffer.from("quote-bytes")]),
      meta: { id: fileId, name: "quote.pdf", mimeType: "application/pdf", size: 11 },
    };
  }),
  deleteVoucherAttachment: jest.fn(async () => true),
}));

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const { planEveryItem, PLANNED_KEY } = require("./plannedItems.helper");
const { Acc_Budget } = require("../../models/Accountant_model/Acc_OperationalModels");
const { Acc_User } = require("../../models/Accountant_model/Acc_OrgModels");
const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");
const Employee = require("../../models/Employee");
const MRF = require("../../models/CMS_Models/Inventory/Operations/MRF");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/requests/spend",
    require("../../Middlewear/EmployeeAuthMiddlewear"),
    require("../../routes/CMS_Routes/Requests/spendRequests"),
  );
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/requests/spend`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const auth = (emp) =>
  `Bearer ${jwt.sign(
    { id: String(emp._id), role: "employee", employeeId: emp.biometricId,
      name: `${emp.firstName} ${emp.lastName}`, email: emp.email },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
  )}`;

const call = (emp, path, { method = "GET", body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: auth(emp) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const raw = (emp, path) => fetch(`${base}${path}`, { headers: { Authorization: auth(emp) } });

async function seed() {
  const n = seq++;
  const company = await Acc_Company.create({
    companyName: `Att Co ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const group = await Acc_Group.create({
    companyId: company._id, name: "Indirect Expenses", nature: "expense",
  });
  const ledger = await Acc_Ledger.create({
    companyId: company._id, name: `Repairs ${n}`, groupId: group._id,
    groupName: group.name, nature: "expense",
  });
  await planEveryItem(await Acc_Budget.create({
    name: `Budget ${n}`, financialYear: "2026-27", period: "yearly", status: "active",
    startDate: new Date("2026-03-31T18:30:00.000Z"),
    endDate: new Date("2027-03-31T18:29:59.999Z"),
    companyId: company._id,
    items: [{ ledgerId: ledger._id, ledgerName: ledger.name, nature: "expense",
              department: "Tech", allocatedAmount: 50000 }],
  }));

  const tl = await Employee.create({
    firstName: "Sakib", lastName: `T${n}`, email: `tl${n}@demo.example`,
    isActive: true, gender: "Other", biometricId: `TL${n}`, department: "Tech",
  });
  const emp = await Employee.create({
    firstName: "Rutu", lastName: `E${n}`, email: `emp${n}@demo.example`,
    isActive: true, gender: "Other", biometricId: `EM${n}`, department: "Tech",
    primaryManager: { managerId: tl._id },
  });
  const finEmp = await Employee.create({
    firstName: "Soumya", lastName: `F${n}`, email: `fin${n}@demo.example`,
    isActive: true, gender: "Other", biometricId: `FN${n}`, department: "Accounts",
  });
  await Acc_User.create({
    organizationId: new mongoose.Types.ObjectId(), email: `fin${n}@demo.example`,
    name: "Finance", role: "approver", isActive: true, passwordHash: "x",
  });
  /* Somebody with no connection to this request at all. */
  const stranger = await Employee.create({
    firstName: "Nil", lastName: `S${n}`, email: `str${n}@demo.example`,
    isActive: true, gender: "Other", biometricId: `ST${n}`, department: "Cutting",
  });

  return { company, ledger, emp, tl, finEmp, stranger };
}

const body = (over = {}) => ({
  title: "Compressor repair", requestType: "SERVICE",
  purpose: "Failed the annual inspection",
  items: [{ name: "Visit", whyNeeded: "Failed", quantity: 1, unit: "visit", rate: 8500 }],
  ...over,
});

const A = (over = {}) => ({
  fileId: "drive-abc123", fileName: "quote.pdf",
  fileType: "application/pdf", fileSize: 20480, label: "quote", ...over,
});

/* ═══ SUBMITTING ══════════════════════════════════════════════════════════ */

test("a request with no attachment submits — proof is optional", async () => {
  const { emp, ledger } = await seed();
  const { status, body: out } = await call(emp, "/", {
    method: "POST", body: body({ ledgerId: String(ledger._id) }),
  });
  expect(status).toBe(201);
  expect(out.request.attachments).toEqual([]);
  expect(out.request.attachmentCount).toBe(0);
});

test("a request with a quote carries its metadata, and no URL", async () => {
  const { emp, ledger } = await seed();
  const { status, body: out } = await call(emp, "/", {
    method: "POST", body: body({ ledgerId: String(ledger._id), attachments: [A()] }),
  });
  expect(status).toBe(201);
  const [a] = out.request.attachments;
  expect(a).toMatchObject({ fileId: "drive-abc123", fileName: "quote.pdf", label: "quote", fileSize: 20480 });
  /* Nothing anybody could paste into a browser. */
  expect(JSON.stringify(out.request)).not.toMatch(/https?:\/\//);
});

test("the uploader is the session, never what the client claimed", async () => {
  const { emp, ledger } = await seed();
  const { body: out } = await call(emp, "/", {
    method: "POST",
    body: body({
      ledgerId: String(ledger._id),
      plannedItemKey: PLANNED_KEY,
      attachments: [A({ uploadedByName: "Somebody Else", uploadedBy: new mongoose.Types.ObjectId() })],
    }),
  });
  const saved = await SpendRequest.findById(out.request._id).lean();
  expect(saved.attachments[0].uploadedByName).toBe("Rutu " + emp.lastName);
  expect(String(saved.attachments[0].uploadedBy)).toBe(String(emp._id));
});

/* ═══ METADATA THAT IS NOT VALID ══════════════════════════════════════════ */

describe("attachment metadata is checked", () => {
  const bad = async (attachments) => {
    const { emp, ledger } = await seed();
    return call(emp, "/", {
      method: "POST", body: body({ ledgerId: String(ledger._id), attachments }),
    });
  };

  test("no file id is refused — upload the file first", async () => {
    const { status, body: out } = await bad([A({ fileId: "" })]);
    expect(status).toBe(400);
    expect(out.message).toMatch(/upload the file first/);
  });

  test("a label nobody recognises is refused", async () => {
    const { status, body: out } = await bad([A({ label: "receipt-ish" })]);
    expect(status).toBe(400);
    expect(out.message).toMatch(/not a kind of attachment/);
  });

  test("a size that cannot be read is refused", async () => {
    const { status } = await bad([A({ fileSize: "quite big" })]);
    expect(status).toBe(400);
  });

  test("something that is not a list at all is refused", async () => {
    const { status } = await bad({ fileId: "x" });
    expect(status).toBe(400);
  });

  test("more than ten is refused", async () => {
    const { status, body: out } = await bad(Array.from({ length: 11 }, () => A()));
    expect(status).toBe(400);
    expect(out.message).toMatch(/at most 10/);
  });
});

/* ═══ OPENING ONE ═════════════════════════════════════════════════════════ */

describe("who can open a quote", () => {
  async function withQuote() {
    const s = await seed();
    const { body: out } = await call(s.emp, "/", {
      method: "POST", body: body({ ledgerId: String(s.ledger._id), attachments: [A()] }),
    });
    return { ...s, id: out.request._id, fileId: out.request.attachments[0].fileId };
  }

  test("the person who raised it can", async () => {
    const { emp, id, fileId } = await withQuote();
    const r = await raw(emp, `/${id}/attachments/${fileId}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/pdf/);
    expect(await r.text()).toBe("quote-bytes");
  });

  test("their TL can", async () => {
    const { tl, id, fileId } = await withQuote();
    expect((await raw(tl, `/${id}/attachments/${fileId}`)).status).toBe(200);
  });

  test("finance can", async () => {
    const { finEmp, id, fileId } = await withQuote();
    expect((await raw(finEmp, `/${id}/attachments/${fileId}`)).status).toBe(200);
  });

  test("a signed-in employee with no connection to it cannot", async () => {
    /* Being logged in is not the same as being allowed. */
    const { stranger, id, fileId } = await withQuote();
    const r = await raw(stranger, `/${id}/attachments/${fileId}`);
    expect(r.status).toBe(403);
  });

  test("a file id from another request opens nothing", async () => {
    /* The request is checked first, then that the file belongs to IT — so a
       guessed or leaked id is not a way in. Both requests here are the same
       person's in the same company, which is the case a check on the request
       alone would wave through. */
    const s = await seed();
    const one = await call(s.emp, "/", {
      method: "POST",
      body: body({ ledgerId: String(s.ledger._id), attachments: [A({ fileId: "drive-one" })] }),
    });
    const two = await call(s.emp, "/", {
      method: "POST",
      body: body({ title: "Second repair", ledgerId: String(s.ledger._id),
                   attachments: [A({ fileId: "drive-two" })] }),
    });
    expect(two.status).toBe(201);

    const r = await raw(s.emp, `/${one.body.request._id}/attachments/drive-two`);
    expect(r.status).toBe(404);
    /* And its own file still opens, so this is the file check failing and not
       the request check. */
    expect((await raw(s.emp, `/${one.body.request._id}/attachments/drive-one`)).status).toBe(200);
  });
});

/* ═══ ADDING ONE LATER ════════════════════════════════════════════════════ */

describe("adding proof after submitting", () => {
  async function pending() {
    const s = await seed();
    const { body: out } = await call(s.emp, "/", {
      method: "POST", body: body({ ledgerId: String(s.ledger._id) }),
    });
    return { ...s, id: out.request._id };
  }

  test("the requester can while it is still waiting", async () => {
    const { emp, id } = await pending();
    const { status, body: out } = await call(emp, `/${id}/attachments`, {
      method: "POST", body: { attachment: A({ fileName: "revised-quote.pdf" }) },
    });
    expect(status).toBe(200);
    expect(out.request.attachmentCount).toBe(1);
    expect(out.request.attachments[0].fileName).toBe("revised-quote.pdf");
  });

  test("finance can, while reviewing", async () => {
    const { emp, tl, finEmp, id } = await pending();
    await call(tl, `/${id}/approve`, { method: "PATCH", body: {} });
    const { status } = await call(finEmp, `/${id}/attachments`, {
      method: "POST", body: { attachment: A({ label: "proforma" }) },
    });
    expect(status).toBe(200);
  });

  test("a stranger cannot", async () => {
    const { stranger, id } = await pending();
    const { status } = await call(stranger, `/${id}/attachments`, {
      method: "POST", body: { attachment: A() },
    });
    expect(status).toBe(403);
  });

  test("nobody can once it is decided — that would be evidence for a decision already taken", async () => {
    const { emp, tl, finEmp, id } = await pending();
    await call(tl, `/${id}/approve`, { method: "PATCH", body: {} });
    await call(finEmp, `/${id}/approve`, { method: "PATCH", body: {} });
    const { status, body: out } = await call(emp, `/${id}/attachments`, {
      method: "POST", body: { attachment: A() },
    });
    expect(status).toBe(409);
    expect(out.message).toMatch(/cannot be added now/);
  });
});

/* ═══ OLD DATA, AND MRF ═══════════════════════════════════════════════════ */

test("a request saved before attachments existed still reads", async () => {
  const { emp, ledger } = await seed();
  const { body: out } = await call(emp, "/", {
    method: "POST", body: body({ ledgerId: String(ledger._id) }),
  });
  /* Exactly what an old row looks like: the field is simply absent. */
  await SpendRequest.updateOne({ _id: out.request._id }, { $unset: { attachments: "" } });

  const listed = await call(emp, "/");
  const r = listed.body.requests.find((x) => x._id === out.request._id);
  expect(r.attachments).toEqual([]);
  expect(r.attachmentCount).toBe(0);
});

test("none of this touches Material from Store", async () => {
  const before = await MRF.countDocuments({});
  const { emp, ledger } = await seed();
  await call(emp, "/", {
    method: "POST", body: body({ ledgerId: String(ledger._id), attachments: [A()] }),
  });
  await expect(MRF.countDocuments({})).resolves.toBe(before);
});
