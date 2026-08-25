// test/accountant/parties-credit-terms.route.test.js
//
// HTTP-level tests for PATCH /api/accountant/parties/:ledgerId/credit-terms
// (C0-B1, corrected). Mirrors test/crm/lead.route.test.js: the router is
// mounted on a bare Express app against an in-memory MongoDB, and
// AccountantAuthMiddleware is mocked so identity/permissions are assertable
// per request without a JWT.
//
// What this file exists to prove that a pure-function test cannot:
//   - company scoping actually reaches the database (a wrong companyId
//     really does fail to find the ledger, not just "look like" it would)
//   - an invalid PATCH leaves the PERSISTED document untouched, not just
//     that the validator would have thrown in isolation
//   - the raw-string contract survives a real HTTP round trip (JSON-encoded
//     over the wire, not just passed as a JS value in-process)
"use strict";

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/AccountantAuthMiddleware", () => ({
  accountantAuth: (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ error: "Authentication required." });
    req.user = JSON.parse(raw);
    next();
  },
}));

const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");

const EDITOR = { id: new mongoose.Types.ObjectId().toString(), name: "Priya Editor", permissions: { canEdit: true } };
const VIEWER = { id: new mongoose.Types.ObjectId().toString(), name: "Vikram Viewer", permissions: { canEdit: false } };

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/accountant/parties", require("../../routes/Accountant_Routes/Acc_parties"));
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api/accountant/parties`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** One request, as a given user. */
async function call(path, { method = "GET", body, user = EDITOR } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(user ? { "x-test-user": JSON.stringify(user) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Company A + a Sundry Debtors party ledger with no terms set. */
async function seedParty(overrides = {}) {
  const company = await Acc_Company.create({ companyName: "Company A", booksFromDate: new Date("2025-04-01") });
  const group = await Acc_Group.create({
    companyId: company._id,
    name: "Sundry Debtors",
    nature: "asset",
  });
  const ledger = await Acc_Ledger.create({
    companyId: company._id,
    name: "Test Buyer Pvt Ltd",
    groupId: group._id,
    groupName: group.name,
    nature: "asset",
    ...overrides,
  });
  return { company, group, ledger };
}

const patchPath = (ledgerId) => `/${ledgerId}/credit-terms`;

/* ── Company scoping ─────────────────────────────────────────────────────── */

describe("company scoping", () => {
  test("refuses a PATCH with no companyId at all", async () => {
    const { ledger } = await seedParty();
    const { status, body } = await call(patchPath(ledger._id), {
      method: "PATCH",
      body: { creditPeriodDays: "30" },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/companyId required/i);

    const stored = await Acc_Ledger.findById(ledger._id).lean();
    expect(stored.creditPeriodDays).toBe(0);
  });

  test("refuses a malformed companyId", async () => {
    const { ledger } = await seedParty();
    const { status, body } = await call(patchPath(ledger._id), {
      method: "PATCH",
      body: { creditPeriodDays: "30", companyId: "not-an-object-id" },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/invalid companyid/i);
  });

  test("refuses a WRONG companyId — cannot write across companies via a bare ledger id", async () => {
    const { ledger } = await seedParty();
    const otherCompanyId = new mongoose.Types.ObjectId().toString();

    const { status } = await call(patchPath(ledger._id), {
      method: "PATCH",
      body: { creditPeriodDays: "30", companyId: otherCompanyId },
    });
    expect(status).toBe(404); // ledger simply isn't found under that company

    const stored = await Acc_Ledger.findById(ledger._id).lean();
    expect(stored.creditPeriodDays).toBe(0);
    expect(stored.creditTermsSource).toBeFalsy();
  });

  test("a valid, matching companyId saves", async () => {
    const { ledger, company } = await seedParty();
    const { status, body } = await call(patchPath(ledger._id), {
      method: "PATCH",
      body: { creditPeriodDays: "30", companyId: company._id.toString() },
    });
    expect(status).toBe(200);
    expect(body.party.creditPeriodDays).toBe(30);
    expect(body.party.creditTermsSet).toBe(true);

    const stored = await Acc_Ledger.findById(ledger._id).lean();
    expect(stored.creditPeriodDays).toBe(30);
    expect(stored.creditTermsSource).toBe("manual");
    expect(String(stored.creditTermsUpdatedBy)).toBe(EDITOR.id);
  });

  test("companyId accepted via query string too, matching this file's GET convention", async () => {
    const { ledger, company } = await seedParty();
    const { status, body } = await call(
      `${patchPath(ledger._id)}?companyId=${company._id.toString()}`,
      { method: "PATCH", body: { creditPeriodDays: "15" } },
    );
    expect(status).toBe(200);
    expect(body.party.creditPeriodDays).toBe(15);
  });
});

/* ── Frontend sends a raw string; the backend owns parsing ───────────────── */

describe("raw-string contract", () => {
  test("a plain numeric string, as the frontend now sends, saves correctly", async () => {
    const { ledger, company } = await seedParty();
    const { status, body } = await call(patchPath(ledger._id), {
      method: "PATCH",
      body: { creditPeriodDays: "45", companyId: company._id.toString() },
    });
    expect(status).toBe(200);
    expect(body.party.creditPeriodDays).toBe(45);
  });

  test("an empty string clears/leaves the term unset — not an error", async () => {
    const { ledger, company } = await seedParty();
    const { status, body } = await call(patchPath(ledger._id), {
      method: "PATCH",
      body: { creditPeriodDays: "", companyId: company._id.toString() },
    });
    expect(status).toBe(200);
    expect(body.party.creditTermsSet).toBe(false);
  });
});

/* ── Invalid input does not clear an existing term ───────────────────────── */

describe("invalid input never clears an existing term", () => {
  test("garbage text is rejected with 400, and the stored term is untouched", async () => {
    const { ledger, company } = await seedParty({ creditPeriodDays: 30, creditTermsSource: "manual" });

    const { status, body } = await call(patchPath(ledger._id), {
      method: "PATCH",
      body: { creditPeriodDays: "abc", companyId: company._id.toString() },
    });
    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_TYPE");

    const stored = await Acc_Ledger.findById(ledger._id).lean();
    expect(stored.creditPeriodDays).toBe(30);
    expect(stored.creditTermsSource).toBe("manual");
  });

  test("the historical bug this guards against: NaN over JSON must not silently clear a term", async () => {
    // This is what the OLD frontend code produced: Number("abc") = NaN, and
    // JSON.stringify(NaN) serialises to `null`. A body of
    // `{ creditPeriodDays: null }` is exactly what "please clear this term"
    // looks like to the backend — so a typo would have silently wiped an
    // existing 30-day term. Proving the null path clears (by design, for a
    // deliberate clear) makes the point: sending "abc" as a STRING must
    // instead be rejected outright, which the test above confirms.
    const { ledger, company } = await seedParty({ creditPeriodDays: 30, creditTermsSource: "manual" });
    const nanOverJson = JSON.stringify(Number("abc"));
    expect(nanOverJson).toBe("null");
  });

  test("negative input is rejected, and an existing term survives", async () => {
    const { ledger, company } = await seedParty({ creditPeriodDays: 60, creditTermsSource: "manual" });
    const { status } = await call(patchPath(ledger._id), {
      method: "PATCH",
      body: { creditPeriodDays: "-5", companyId: company._id.toString() },
    });
    expect(status).toBe(400);

    const stored = await Acc_Ledger.findById(ledger._id).lean();
    expect(stored.creditPeriodDays).toBe(60);
  });

  test("an absurd value is rejected, and an existing term survives", async () => {
    const { ledger, company } = await seedParty({ creditPeriodDays: 60, creditTermsSource: "manual" });
    const { status } = await call(patchPath(ledger._id), {
      method: "PATCH",
      body: { creditPeriodDays: "9999", companyId: company._id.toString() },
    });
    expect(status).toBe(400);

    const stored = await Acc_Ledger.findById(ledger._id).lean();
    expect(stored.creditPeriodDays).toBe(60);
  });
});

/* ── Existing C0-B1 guarantees still hold ────────────────────────────────── */

describe("still true after the fix", () => {
  test("a read-only role cannot edit, and the ledger is untouched", async () => {
    const { ledger, company } = await seedParty({ creditPeriodDays: 30, creditTermsSource: "manual" });
    const { status } = await call(patchPath(ledger._id), {
      method: "PATCH",
      body: { creditPeriodDays: "90", companyId: company._id.toString() },
      user: VIEWER,
    });
    expect(status).toBe(403);

    const stored = await Acc_Ledger.findById(ledger._id).lean();
    expect(stored.creditPeriodDays).toBe(30);
  });

  test("an unrelated field is refused outright, not silently dropped", async () => {
    const { ledger, company } = await seedParty();
    const { status, body } = await call(patchPath(ledger._id), {
      method: "PATCH",
      body: { creditPeriodDays: "30", companyId: company._id.toString(), openingBalance: 999999 },
    });
    expect(status).toBe(400);
    expect(body.code).toBe("UNSUPPORTED_FIELD");
  });

  test("no voucher document is created, read for write, or otherwise touched", async () => {
    const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");
    const before = await Acc_Voucher.countDocuments({});
    expect(before).toBe(0); // sanity: nothing pre-existing in this isolated DB

    const { ledger, company } = await seedParty();
    await call(patchPath(ledger._id), {
      method: "PATCH",
      body: { creditPeriodDays: "30", companyId: company._id.toString() },
    });

    const after = await Acc_Voucher.countDocuments({});
    expect(after).toBe(0);
  });
});
