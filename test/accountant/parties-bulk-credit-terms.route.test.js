// test/accountant/parties-bulk-credit-terms.route.test.js
//
// HTTP-level tests for PATCH /api/accountant/parties/bulk-credit-terms
// (C0-B2). Same harness as parties-credit-terms.route.test.js: bare Express
// app, in-memory MongoDB, AccountantAuthMiddleware mocked to read identity
// from a test header.
//
// What this file exists to prove that a pure-function test cannot:
//   - the fail-closed SCOPE actually reaches the database: a wrong-company
//     or non-party ledger id is never read for write, not merely rejected
//     by an in-process check
//   - a batch with a valid value and a mix of good/bad ids updates exactly
//     the good ones and reports the rest, with reasons
//   - an invalid VALUE touches nothing at all, even when every id in the
//     batch is otherwise perfectly eligible
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
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");

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

async function makeCompany(name = "Company A") {
  return Acc_Company.create({ companyName: name, booksFromDate: new Date("2025-04-01") });
}

async function makeGroup(companyId, name = "Sundry Debtors", nature = "asset") {
  return Acc_Group.create({ companyId, name, nature });
}

async function makeLedger(companyId, groupId, groupName, overrides = {}) {
  return Acc_Ledger.create({
    companyId,
    name: overrides.name || `Party ${new mongoose.Types.ObjectId().toString().slice(-6)}`,
    groupId,
    groupName,
    nature: "asset",
    ...overrides,
  });
}

const BULK_PATH = "/bulk-credit-terms";

/* ── companyId required ──────────────────────────────────────────────────── */

describe("companyId", () => {
  test("missing companyId is rejected, nothing touched", async () => {
    const company = await makeCompany();
    const group = await makeGroup(company._id);
    const l1 = await makeLedger(company._id, group._id, group.name);

    const { status, body } = await call(BULK_PATH, {
      method: "PATCH",
      body: { ledgerIds: [l1._id.toString()], creditPeriodDays: "30" },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/companyId required/i);

    const stored = await Acc_Ledger.findById(l1._id).lean();
    expect(stored.creditPeriodDays).toBe(0);
  });

  test("malformed companyId is rejected", async () => {
    const { status } = await call(BULK_PATH, {
      method: "PATCH",
      body: { ledgerIds: ["507f1f77bcf86cd799439011"], creditPeriodDays: "30", companyId: "not-an-id" },
    });
    expect(status).toBe(400);
  });
});

/* ── ledgerIds required and non-empty ────────────────────────────────────── */

describe("ledgerIds", () => {
  test("missing ledgerIds is rejected", async () => {
    const company = await makeCompany();
    const { status, body } = await call(BULK_PATH, {
      method: "PATCH",
      body: { creditPeriodDays: "30", companyId: company._id.toString() },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/ledgerIds/i);
  });

  test("an empty ledgerIds array is rejected", async () => {
    const company = await makeCompany();
    const { status, body } = await call(BULK_PATH, {
      method: "PATCH",
      body: { ledgerIds: [], creditPeriodDays: "30", companyId: company._id.toString() },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/non-empty/i);
  });

  test("more than the cap is rejected outright", async () => {
    const company = await makeCompany();
    const tooMany = Array.from({ length: 501 }, () => new mongoose.Types.ObjectId().toString());
    const { status, body } = await call(BULK_PATH, {
      method: "PATCH",
      body: { ledgerIds: tooMany, creditPeriodDays: "30", companyId: company._id.toString() },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/at most/i);
  });
});

/* ── Wrong-company ledgers are skipped safely, never touched ────────────── */

describe("cross-company scope", () => {
  test("a ledger from a DIFFERENT company is skipped, not updated", async () => {
    const companyA = await makeCompany("A");
    const companyB = await makeCompany("B");
    const groupA = await makeGroup(companyA._id);
    const groupB = await makeGroup(companyB._id);
    const inA = await makeLedger(companyA._id, groupA._id, groupA.name);
    const inB = await makeLedger(companyB._id, groupB._id, groupB.name);

    const { status, body } = await call(BULK_PATH, {
      method: "PATCH",
      body: {
        ledgerIds: [inA._id.toString(), inB._id.toString()],
        creditPeriodDays: "30",
        companyId: companyA._id.toString(),
      },
    });
    expect(status).toBe(200);
    expect(body.updatedCount).toBe(1);
    expect(body.requestedCount).toBe(2);
    expect(body.parties.map((p) => String(p.ledgerId))).toEqual([String(inA._id)]);
    const skippedB = body.skipped.find((s) => s.ledgerId === String(inB._id));
    expect(skippedB).toBeTruthy();
    expect(skippedB.reason).toBe("not_found_in_company");

    const storedA = await Acc_Ledger.findById(inA._id).lean();
    const storedB = await Acc_Ledger.findById(inB._id).lean();
    expect(storedA.creditPeriodDays).toBe(30);
    expect(storedB.creditPeriodDays).toBe(0); // structurally never written
    expect(storedB.creditTermsSource).toBeFalsy();
  });

  test("ALL ids from another company: 200 with zero updates, all reported", async () => {
    const companyA = await makeCompany("A");
    const companyB = await makeCompany("B");
    const groupB = await makeGroup(companyB._id);
    const inB = await makeLedger(companyB._id, groupB._id, groupB.name);

    const { status, body } = await call(BULK_PATH, {
      method: "PATCH",
      body: { ledgerIds: [inB._id.toString()], creditPeriodDays: "30", companyId: companyA._id.toString() },
    });
    expect(status).toBe(200);
    expect(body.updatedCount).toBe(0);
    expect(body.skipped).toHaveLength(1);

    const stored = await Acc_Ledger.findById(inB._id).lean();
    expect(stored.creditPeriodDays).toBe(0);
  });
});

/* ── Non-party ledgers are skipped ───────────────────────────────────────── */

describe("only Sundry Debtors / Sundry Creditors", () => {
  test("a non-party ledger (e.g. a bank ledger) is skipped, not updated", async () => {
    const company = await makeCompany();
    const debtorGroup = await makeGroup(company._id, "Sundry Debtors");
    const bankGroup = await makeGroup(company._id, "Bank Accounts", "asset");
    const debtor = await makeLedger(company._id, debtorGroup._id, debtorGroup.name);
    const bank = await makeLedger(company._id, bankGroup._id, bankGroup.name, { name: "HDFC Current A/c" });

    const { status, body } = await call(BULK_PATH, {
      method: "PATCH",
      body: {
        ledgerIds: [debtor._id.toString(), bank._id.toString()],
        creditPeriodDays: "45",
        companyId: company._id.toString(),
      },
    });
    expect(status).toBe(200);
    expect(body.updatedCount).toBe(1);
    const skippedBank = body.skipped.find((s) => s.ledgerId === String(bank._id));
    expect(skippedBank.reason).toBe("not_a_party_ledger");

    const storedBank = await Acc_Ledger.findById(bank._id).lean();
    expect(storedBank.creditPeriodDays).toBe(0);
  });
});

/* ── Malformed / duplicate ids ────────────────────────────────────────────── */

describe("malformed and duplicate ids", () => {
  test("a malformed id is skipped as invalid_id, valid ones still update", async () => {
    const company = await makeCompany();
    const group = await makeGroup(company._id);
    const good = await makeLedger(company._id, group._id, group.name);

    const { status, body } = await call(BULK_PATH, {
      method: "PATCH",
      body: {
        ledgerIds: [good._id.toString(), "not-an-object-id"],
        creditPeriodDays: "20",
        companyId: company._id.toString(),
      },
    });
    expect(status).toBe(200);
    expect(body.updatedCount).toBe(1);
    const bad = body.skipped.find((s) => s.ledgerId === "not-an-object-id");
    expect(bad.reason).toBe("invalid_id");
  });

  test("a repeated id is only applied once, and reported as a duplicate", async () => {
    const company = await makeCompany();
    const group = await makeGroup(company._id);
    const l = await makeLedger(company._id, group._id, group.name);
    const idStr = l._id.toString();

    const { status, body } = await call(BULK_PATH, {
      method: "PATCH",
      body: { ledgerIds: [idStr, idStr], creditPeriodDays: "20", companyId: company._id.toString() },
    });
    expect(status).toBe(200);
    expect(body.updatedCount).toBe(1);
    expect(body.skipped.find((s) => s.reason === "duplicate")).toBeTruthy();
    // The reconciliation invariant: every requested id is accounted for exactly once.
    expect(body.updatedCount + body.skipped.length).toBe(body.requestedCount);
  });
});

/* ── Valid selected ledgers update ───────────────────────────────────────── */

describe("valid selection", () => {
  test("all eligible, all valid: every one updates with the same value", async () => {
    const company = await makeCompany();
    const group = await makeGroup(company._id);
    const a = await makeLedger(company._id, group._id, group.name, { name: "Buyer A" });
    const b = await makeLedger(company._id, group._id, group.name, { name: "Buyer B" });
    const c = await makeLedger(company._id, group._id, group.name, { name: "Buyer C" });

    const { status, body } = await call(BULK_PATH, {
      method: "PATCH",
      body: {
        ledgerIds: [a._id, b._id, c._id].map(String),
        creditPeriodDays: "30",
        companyId: company._id.toString(),
      },
    });
    expect(status).toBe(200);
    expect(body.updatedCount).toBe(3);
    expect(body.skipped).toHaveLength(0);
    expect(body.parties.every((p) => p.creditPeriodDays === 30)).toBe(true);

    for (const id of [a._id, b._id, c._id]) {
      const stored = await Acc_Ledger.findById(id).lean();
      expect(stored.creditPeriodDays).toBe(30);
      expect(stored.creditTermsSource).toBe("manual");
      expect(String(stored.creditTermsUpdatedBy)).toBe(EDITOR.id);
    }
  });

  test("companyId accepted from body only (bulk has no GET-style query convenience)", async () => {
    const company = await makeCompany();
    const group = await makeGroup(company._id);
    const l = await makeLedger(company._id, group._id, group.name);
    const { status, body } = await call(BULK_PATH, {
      method: "PATCH",
      body: { ledgerIds: [l._id.toString()], creditPeriodDays: "10", companyId: company._id.toString() },
    });
    expect(status).toBe(200);
    expect(body.updatedCount).toBe(1);
  });
});

/* ── Unrelated fields refused ────────────────────────────────────────────── */

describe("unrelated fields refused, not spread", () => {
  test("an unsupported field in the body refuses the WHOLE request, nothing updates", async () => {
    const company = await makeCompany();
    const group = await makeGroup(company._id);
    const l = await makeLedger(company._id, group._id, group.name);

    const { status, body } = await call(BULK_PATH, {
      method: "PATCH",
      body: {
        ledgerIds: [l._id.toString()],
        creditPeriodDays: "30",
        companyId: company._id.toString(),
        openingBalance: 999999,
      },
    });
    expect(status).toBe(400);
    expect(body.code).toBe("UNSUPPORTED_FIELD");

    const stored = await Acc_Ledger.findById(l._id).lean();
    expect(stored.creditPeriodDays).toBe(0);
  });

  test("nature/groupId cannot ride along either", async () => {
    const company = await makeCompany();
    const group = await makeGroup(company._id);
    const l = await makeLedger(company._id, group._id, group.name);

    const { status, body } = await call(BULK_PATH, {
      method: "PATCH",
      body: {
        ledgerIds: [l._id.toString()],
        creditPeriodDays: "30",
        companyId: company._id.toString(),
        nature: "revenue",
      },
    });
    expect(status).toBe(400);
    expect(body.code).toBe("UNSUPPORTED_FIELD");
  });
});

/* ── Invalid credit days update nothing, even for a fully valid selection ─── */

describe("invalid value updates nothing", () => {
  test("garbage text refuses the whole batch, even though every id is otherwise eligible", async () => {
    const company = await makeCompany();
    const group = await makeGroup(company._id);
    const a = await makeLedger(company._id, group._id, group.name, { creditPeriodDays: 30, creditTermsSource: "manual" });
    const b = await makeLedger(company._id, group._id, group.name, { creditPeriodDays: 60, creditTermsSource: "manual" });

    const { status, body } = await call(BULK_PATH, {
      method: "PATCH",
      body: { ledgerIds: [a._id, b._id].map(String), creditPeriodDays: "abc", companyId: company._id.toString() },
    });
    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_TYPE");

    const storedA = await Acc_Ledger.findById(a._id).lean();
    const storedB = await Acc_Ledger.findById(b._id).lean();
    expect(storedA.creditPeriodDays).toBe(30); // untouched
    expect(storedB.creditPeriodDays).toBe(60); // untouched
  });

  test("negative value refuses the batch; absurd value refuses the batch", async () => {
    const company = await makeCompany();
    const group = await makeGroup(company._id);
    const a = await makeLedger(company._id, group._id, group.name, { creditPeriodDays: 15, creditTermsSource: "manual" });

    const neg = await call(BULK_PATH, {
      method: "PATCH",
      body: { ledgerIds: [a._id.toString()], creditPeriodDays: "-5", companyId: company._id.toString() },
    });
    expect(neg.status).toBe(400);

    const huge = await call(BULK_PATH, {
      method: "PATCH",
      body: { ledgerIds: [a._id.toString()], creditPeriodDays: "9999", companyId: company._id.toString() },
    });
    expect(huge.status).toBe(400);

    const stored = await Acc_Ledger.findById(a._id).lean();
    expect(stored.creditPeriodDays).toBe(15);
  });
});

/* ── Unauthorized ─────────────────────────────────────────────────────────── */

describe("unauthorized", () => {
  test("a read-only role cannot bulk edit; nothing updates", async () => {
    const company = await makeCompany();
    const group = await makeGroup(company._id);
    const a = await makeLedger(company._id, group._id, group.name, { creditPeriodDays: 30, creditTermsSource: "manual" });

    const { status } = await call(BULK_PATH, {
      method: "PATCH",
      body: { ledgerIds: [a._id.toString()], creditPeriodDays: "90", companyId: company._id.toString() },
      user: VIEWER,
    });
    expect(status).toBe(403);

    const stored = await Acc_Ledger.findById(a._id).lean();
    expect(stored.creditPeriodDays).toBe(30);
  });
});

/* ── Nothing else is ever touched ────────────────────────────────────────── */

describe("blast radius", () => {
  test("no voucher document exists after a bulk update, and no dueDate field appears anywhere in the response", async () => {
    const company = await makeCompany();
    const group = await makeGroup(company._id);
    const a = await makeLedger(company._id, group._id, group.name);
    const b = await makeLedger(company._id, group._id, group.name);

    const before = await Acc_Voucher.countDocuments({});
    expect(before).toBe(0);

    const { body } = await call(BULK_PATH, {
      method: "PATCH",
      body: { ledgerIds: [a._id, b._id].map(String), creditPeriodDays: "30", companyId: company._id.toString() },
    });

    const after = await Acc_Voucher.countDocuments({});
    expect(after).toBe(0);

    // No due date anywhere in the response — this slice dates nothing.
    expect(JSON.stringify(body)).not.toMatch(/dueDate/i);
  });

  test("the bulk credit-terms route never references Acc_BillTerms — that is a later slice's model, not this one's", async () => {
    // C0-F later introduced Acc_BillTerms for a DIFFERENT purpose (historical
    // due-date backfill), so the model existing is now expected and correct
    // — the assertion this test protects is narrower and still true: C0-B2's
    // own route file has no business touching it.
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(
      path.join(__dirname, "../../routes/Accountant_Routes/Acc_parties.js"),
      "utf8",
    );
    expect(source).not.toMatch(/Acc_BillTerms/);
  });
});
