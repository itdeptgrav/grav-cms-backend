// test/accountant/forecast-cash-ledger-config.route.test.js
//
// HTTP tests for Chunk 1-D — which ledgers count as operating cash.
//
// The pure service proves the validation rules in isolation. What THIS file
// proves is the half a pure test cannot reach: that candidates are genuinely
// company-scoped, that a ledger which is not cash-shaped is refused by a real
// database lookup, and — the point of the whole chunk — that the forecast's
// opening cash actually changes when the selection does.
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
const Acc_BillTerms = require("../../models/Accountant_model/Acc_BillTerms");
const Acc_RecurringItem = require("../../models/Accountant_model/Acc_RecurringItem");
const Acc_ForecastCashLedgerConfig = require("../../models/Accountant_model/Acc_ForecastCashLedgerConfig");

const EDITOR = { id: new mongoose.Types.ObjectId().toString(), name: "Priya Editor", permissions: { canEdit: true } };
const VIEWER = { id: new mongoose.Types.ObjectId().toString(), name: "Vikram Viewer", permissions: { canEdit: false } };

const AS_OF = "2026-09-01";

let server;
let base;
let forecastBase;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/accountant/forecast-cash-ledger-config",
    require("../../routes/Accountant_Routes/Acc_forecastCashLedgerConfig"),
  );
  app.use(
    "/api/accountant/cash-flow-forecast",
    require("../../routes/Accountant_Routes/Acc_cashFlowForecast"),
  );
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  const port = server.address().port;
  base = `http://127.0.0.1:${port}/api/accountant/forecast-cash-ledger-config`;
  forecastBase = `http://127.0.0.1:${port}/api/accountant/cash-flow-forecast`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function req(url, { method = "GET", body, user = EDITOR } = {}) {
  const res = await fetch(url, {
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

const call = (qs, opts) => req(`${base}${qs}`, opts);
const forecastCall = (qs) => req(`${forecastBase}${qs}`);

let vSeq = 0;

/** A company whose chart mirrors the real one: company cash, personal cash, OD. */
async function seedCompany(name = "Company A") {
  const company = await Acc_Company.create({
    companyName: name,
    booksFromDate: new Date("2026-04-01"),
  });

  const mk = async (groupName, nature, ledgerName) => {
    let group = await Acc_Group.findOne({ companyId: company._id, name: groupName });
    if (!group) group = await Acc_Group.create({ companyId: company._id, name: groupName, nature });
    return Acc_Ledger.create({
      companyId: company._id,
      name: ledgerName,
      groupId: group._id,
      groupName,
      nature,
    });
  };

  const bank = await mk("Bank Accounts", "asset", "HDFC BANK A/C (CA-6085)");
  const personalBank = await mk("Bank Accounts", "asset", "CEO's HDFC BANK A/C (PA-6160)");
  const cash = await mk("Cash-in-Hand", "asset", "Petty Cash A/c");
  const od = await mk("Bank OD A/c", "liability", "HDFC OD A/c");
  // A perfectly ordinary non-cash ledger, to prove it can never be selected.
  const expense = await mk("Indirect Expenses", "expense", "Freight");

  return { company, bank, personalBank, cash, od, expense };
}

/** A posted voucher moving `amount` into (Dr) or out of (Cr) a cash ledger. */
async function seedMovement(company, ledger, amount, type = "Dr", voucherDate = "2026-08-01") {
  vSeq += 1;
  const other = await Acc_Ledger.findOne({ companyId: company._id, groupName: "Indirect Expenses" });
  return Acc_Voucher.create({
    companyId: company._id,
    voucherNumber: `CV-${Date.now().toString(36)}-${vSeq}`,
    voucherType: "receipt",
    voucherDate: new Date(voucherDate),
    status: "posted",
    grandTotal: amount,
    ledgerEntries: [
      { ledgerId: ledger._id, ledgerName: ledger.name, type, amount },
      {
        ledgerId: other._id,
        ledgerName: other.name,
        type: type === "Dr" ? "Cr" : "Dr",
        amount,
      },
    ],
  });
}

/* ── GET: candidates ─────────────────────────────────────────────────────── */

describe("GET candidates", () => {
  test("returns only cash/bank/OD ledgers of the asked-for company", async () => {
    const a = await seedCompany("Company A");
    await seedCompany("Company B");

    const { status, body } = await call(`?companyId=${a.company._id}`);
    expect(status).toBe(200);

    const names = body.candidates.map((c) => c.name).sort();
    expect(names).toEqual([
      "CEO's HDFC BANK A/C (PA-6160)",
      "HDFC BANK A/C (CA-6085)",
      "HDFC OD A/c",
      "Petty Cash A/c",
    ]);
    expect(names).not.toContain("Freight"); // not cash-shaped
    expect(JSON.stringify(body)).not.toContain("Company B");
  });

  test("with no saved config the status is suggested_default", async () => {
    const a = await seedCompany();
    const { body } = await call(`?companyId=${a.company._id}`);
    expect(body.status).toBe("suggested_default");
    expect(body.config).toBeNull();
  });

  test("the default suggestion puts OD in its own bucket, never in cash", async () => {
    const a = await seedCompany();
    const { body } = await call(`?companyId=${a.company._id}`);
    const byName = Object.fromEntries(body.candidates.map((c) => [c.name, c]));

    expect(byName["HDFC OD A/c"].suggestedRole).toBe("od");
    expect(byName["HDFC OD A/c"].selectedRole).toBe("od");
    expect(byName["HDFC BANK A/C (CA-6085)"].suggestedRole).toBe("included");
    expect(byName["Petty Cash A/c"].suggestedRole).toBe("included");
  });

  test("a personal-looking account is SUGGESTED excluded, with the signal explained", async () => {
    const a = await seedCompany();
    const { body } = await call(`?companyId=${a.company._id}`);
    const personal = body.candidates.find((c) => c.name.includes("PA-6160"));

    expect(personal.suggestedRole).toBe("excluded");
    expect(personal.personalNameSignal).toBe(true);
  });

  test("balances come from posted vouchers, and a draft moves nothing", async () => {
    const a = await seedCompany();
    await seedMovement(a.company, a.bank, 50000, "Dr");
    const draft = await seedMovement(a.company, a.bank, 999999, "Dr");
    await Acc_Voucher.findByIdAndUpdate(draft._id, { status: "draft" });

    const { body } = await call(`?companyId=${a.company._id}`);
    const bank = body.candidates.find((c) => c.name.includes("CA-6085"));
    expect(bank.currentBalance).toBe(50000);
  });

  test("openingCash reflects the suggestion when nothing is saved", async () => {
    const a = await seedCompany();
    await seedMovement(a.company, a.bank, 40000, "Dr");
    await seedMovement(a.company, a.cash, 10000, "Dr");
    await seedMovement(a.company, a.personalBank, 700000, "Dr"); // suggested out
    await seedMovement(a.company, a.od, 900000, "Cr"); // OD, never cash

    const { body } = await call(`?companyId=${a.company._id}`);
    expect(body.openingCash).toBe(50000);
    expect(body.odBalance).toBe(-900000);
  });

  test("a missing or malformed companyId is refused", async () => {
    expect((await call("")).status).toBe(400);
    expect((await call("?companyId=nope")).status).toBe(400);
  });

  test("no auth is refused", async () => {
    const a = await seedCompany();
    const { status } = await call(`?companyId=${a.company._id}`, { user: null });
    expect(status).toBe(401);
  });
});

/* ── PATCH: saving ───────────────────────────────────────────────────────── */

describe("PATCH config", () => {
  test("an editor can save a selection, and GET then reports it as saved", async () => {
    const a = await seedCompany();
    const { status, body } = await call("", {
      method: "PATCH",
      body: {
        companyId: a.company._id.toString(),
        includedLedgerIds: [a.bank._id.toString(), a.cash._id.toString()],
        excludedLedgerIds: [a.personalBank._id.toString()],
        odLedgerIds: [a.od._id.toString()],
        notes: "CEO personal account excluded",
      },
    });
    expect(status).toBe(200);
    expect(body.status).toBe("saved");
    expect(body.config.includedLedgerIds).toHaveLength(2);

    const read = await call(`?companyId=${a.company._id}`);
    expect(read.body.status).toBe("saved");
    expect(read.body.config.notes).toBe("CEO personal account excluded");
    expect(read.body.config.updatedByName).toBe("Priya Editor");
  });

  test("saving twice UPDATES the one config rather than creating a second", async () => {
    const a = await seedCompany();
    const patch = (ids) =>
      call("", {
        method: "PATCH",
        body: { companyId: a.company._id.toString(), includedLedgerIds: ids },
      });

    await patch([a.bank._id.toString()]);
    await patch([a.bank._id.toString(), a.cash._id.toString()]);

    expect(await Acc_ForecastCashLedgerConfig.countDocuments({ companyId: a.company._id })).toBe(1);
    const read = await call(`?companyId=${a.company._id}`);
    expect(read.body.config.includedLedgerIds).toHaveLength(2);
  });

  test("a read-only role cannot save", async () => {
    const a = await seedCompany();
    const { status } = await call("", {
      method: "PATCH",
      body: { companyId: a.company._id.toString(), includedLedgerIds: [a.bank._id.toString()] },
      user: VIEWER,
    });
    expect(status).toBe(403);
    expect(await Acc_ForecastCashLedgerConfig.countDocuments({})).toBe(0);
  });

  test("another company's ledger is refused", async () => {
    const a = await seedCompany("Company A");
    const b = await seedCompany("Company B");

    const { status, body } = await call("", {
      method: "PATCH",
      body: {
        companyId: a.company._id.toString(),
        includedLedgerIds: [b.bank._id.toString()],
      },
    });
    expect(status).toBe(400);
    expect(body.code).toBe("LEDGER_NOT_ELIGIBLE");
    expect(await Acc_ForecastCashLedgerConfig.countDocuments({})).toBe(0);
  });

  test("a non-cash ledger of the SAME company is refused", async () => {
    // Otherwise an expense head's balance would quietly become "cash on hand".
    const a = await seedCompany();
    const { status, body } = await call("", {
      method: "PATCH",
      body: {
        companyId: a.company._id.toString(),
        includedLedgerIds: [a.expense._id.toString()],
      },
    });
    expect(status).toBe(400);
    expect(body.code).toBe("LEDGER_NOT_ELIGIBLE");
  });

  test("validation errors surface with their codes and save nothing", async () => {
    const a = await seedCompany();
    const bad = [
      [{ includedLedgerIds: [a.bank._id.toString()], excludedLedgerIds: [a.bank._id.toString()] }, "ROLE_CONFLICT"],
      [{ includedLedgerIds: [a.bank._id.toString()], odLedgerIds: [a.bank._id.toString()] }, "ROLE_CONFLICT"],
      [{ includedLedgerIds: [a.bank._id.toString(), a.bank._id.toString()] }, "DUPLICATE_ID"],
      [{ includedLedgerIds: "not-an-array" }, "INVALID_TYPE"],
      [{ includedLedgerIds: ["junk"] }, "INVALID_ID"],
      [{ includedLedgerIds: [], somethingElse: 1 }, "UNSUPPORTED_FIELD"],
    ];
    for (const [patch, code] of bad) {
      const { status, body } = await call("", {
        method: "PATCH",
        body: { companyId: a.company._id.toString(), ...patch },
      });
      expect(status).toBe(400);
      expect(body.code).toBe(code);
    }
    expect(await Acc_ForecastCashLedgerConfig.countDocuments({})).toBe(0);
  });

  test("provenance in the body is refused, not trusted", async () => {
    const a = await seedCompany();
    const { status, body } = await call("", {
      method: "PATCH",
      body: {
        companyId: a.company._id.toString(),
        includedLedgerIds: [],
        updatedByName: "Someone Else",
      },
    });
    expect(status).toBe(400);
    expect(body.code).toBe("UNSUPPORTED_FIELD");
  });
});

/* ── The point of the chunk: the forecast follows the selection ──────────── */

describe("forecast opening cash follows the config", () => {
  async function seedFourWays() {
    const a = await seedCompany();
    await seedMovement(a.company, a.bank, 40000, "Dr");
    await seedMovement(a.company, a.cash, 10000, "Dr");
    await seedMovement(a.company, a.personalBank, 700000, "Dr");
    await seedMovement(a.company, a.od, 900000, "Cr");
    return a;
  }

  test("with NO config, behaviour is unchanged — every cash-shaped ledger counts", async () => {
    // Including the personal account and the OD. This chunk must not silently
    // move an existing company's opening balance the day it ships.
    const a = await seedFourWays();
    const { body } = await forecastCall(`?companyId=${a.company._id}&asOfDate=${AS_OF}&horizon=7`);

    expect(body.openingCash).toBe(40000 + 10000 + 700000 - 900000);
    expect(body.openingCashConfig.status).toBe("suggested_default");
    expect(body.openingCashConfig.includedLedgerCount).toBe(4);
  });

  test("saving a selection changes opening cash to exactly the included ledgers", async () => {
    const a = await seedFourWays();

    await call("", {
      method: "PATCH",
      body: {
        companyId: a.company._id.toString(),
        includedLedgerIds: [a.bank._id.toString(), a.cash._id.toString()],
        excludedLedgerIds: [a.personalBank._id.toString()],
        odLedgerIds: [a.od._id.toString()],
      },
    });

    const { body } = await forecastCall(`?companyId=${a.company._id}&asOfDate=${AS_OF}&horizon=7`);
    expect(body.openingCash).toBe(50000);
    expect(body.openingCashConfig).toEqual({
      status: "saved",
      includedLedgerCount: 2,
      excludedLedgerCount: 1,
      odLedgerCount: 1,
    });
    // OD is reported beside cash, never inside it.
    expect(body.odBalance).toBe(-900000);
    expect(body.rows[0].opening).toBe(50000);
  });

  test("excluding everything gives zero opening cash, not the old total", async () => {
    const a = await seedFourWays();
    await call("", {
      method: "PATCH",
      body: {
        companyId: a.company._id.toString(),
        includedLedgerIds: [],
        excludedLedgerIds: [
          a.bank._id.toString(),
          a.cash._id.toString(),
          a.personalBank._id.toString(),
        ],
        odLedgerIds: [a.od._id.toString()],
      },
    });

    const { body } = await forecastCall(`?companyId=${a.company._id}&asOfDate=${AS_OF}&horizon=7`);
    expect(body.openingCash).toBe(0);
    expect(body.openingCashConfig.includedLedgerCount).toBe(0);
  });

  test("one company's config never affects another's forecast", async () => {
    const a = await seedFourWays();
    const b = await seedFourWays();

    await call("", {
      method: "PATCH",
      body: { companyId: a.company._id.toString(), includedLedgerIds: [a.bank._id.toString()] },
    });

    const bResult = await forecastCall(`?companyId=${b.company._id}&asOfDate=${AS_OF}&horizon=7`);
    expect(bResult.body.openingCashConfig.status).toBe("suggested_default");
    expect(bResult.body.openingCash).toBe(40000 + 10000 + 700000 - 900000);
  });
});

/* ── Scope guard ─────────────────────────────────────────────────────────── */

describe("scope guard", () => {
  test("neither endpoint writes a voucher, ledger, bill term or recurring item", async () => {
    const a = await seedCompany();
    await seedMovement(a.company, a.bank, 1000, "Dr");
    await Acc_BillTerms.create({
      companyId: a.company._id,
      ledgerId: a.bank._id,
      billName: "X",
      dueDate: new Date("2026-09-10"),
      source: "company_default",
      creditDaysUsed: 30,
      basisDate: new Date("2026-08-11"),
    });
    await Acc_RecurringItem.create({
      companyId: a.company._id,
      name: "Rent",
      type: "rent",
      direction: "outflow",
      amount: 100,
      frequency: "monthly",
      dayOfMonth: 5,
      nextDueDate: new Date("2026-09-05"),
      startDate: new Date("2026-01-05"),
      status: "active",
      source: "manual",
    });

    const snap = async () => ({
      v: await Acc_Voucher.countDocuments({}),
      l: await Acc_Ledger.countDocuments({}),
      bt: await Acc_BillTerms.countDocuments({}),
      ri: await Acc_RecurringItem.countDocuments({}),
      vU: (await Acc_Voucher.find({}).select("updatedAt").lean()).map((x) => +new Date(x.updatedAt)).sort().join(","),
      lU: (await Acc_Ledger.find({}).select("updatedAt").lean()).map((x) => +new Date(x.updatedAt)).sort().join(","),
      btU: (await Acc_BillTerms.find({}).select("updatedAt").lean()).map((x) => +new Date(x.updatedAt)).sort().join(","),
      riU: (await Acc_RecurringItem.find({}).select("updatedAt").lean()).map((x) => +new Date(x.updatedAt)).sort().join(","),
    });

    const before = await snap();
    await call(`?companyId=${a.company._id}`);
    await call("", {
      method: "PATCH",
      body: { companyId: a.company._id.toString(), includedLedgerIds: [a.bank._id.toString()] },
    });
    await call(`?companyId=${a.company._id}`);
    expect(await snap()).toEqual(before);
  });

  test("the route writes only the config collection", async () => {
    const fs = require("fs");
    const src = fs.readFileSync(
      require.resolve("../../routes/Accountant_Routes/Acc_forecastCashLedgerConfig"),
      "utf8",
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const writes = [...code.matchAll(/(Acc_[A-Za-z]+)\.(create|findOneAndUpdate|updateOne|updateMany|deleteOne|deleteMany|insertMany|bulkWrite)\(/g)]
      .map((m) => m[1]);
    expect([...new Set(writes)]).toEqual(["Acc_ForecastCashLedgerConfig"]);
  });
});
