// test/accountant/party-terms-impact.route.test.js
//
// HTTP tests for Chunk 1-F — the party credit-terms cleanup workflow.
//
// The pure service proves the ranking and preview arithmetic. What THIS file
// proves is the half a pure test cannot: that the ladder rung is read from a
// real sidecar row, that preview genuinely writes nothing, and that apply
// composes the two existing safe paths without touching what it must not.
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

const EDITOR = { id: new mongoose.Types.ObjectId().toString(), name: "Priya Editor", permissions: { canEdit: true } };
const VIEWER = { id: new mongoose.Types.ObjectId().toString(), name: "Vikram Viewer", permissions: { canEdit: false } };

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/accountant/forecast/party-terms-impact",
    require("../../routes/Accountant_Routes/Acc_partyTermsImpact"),
  );
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/accountant/forecast/party-terms-impact`;
});

afterAll(async () => { await new Promise((r) => server.close(r)); });

async function call(path, { method = "GET", body, user = EDITOR } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(user ? { "x-test-user": JSON.stringify(user) } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

let seq = 0;

async function seedCompany(name = "Company A", defaultCreditDays = 46) {
  const company = await Acc_Company.create({
    companyName: name,
    booksFromDate: new Date("2025-04-01"),
    defaultCreditDays,
  });
  const group = await Acc_Group.create({ companyId: company._id, name: "Sundry Debtors", nature: "asset" });
  return { company, group };
}

async function seedParty(company, group, name, creditPeriodDays = 0) {
  return Acc_Ledger.create({
    companyId: company._id, name, groupId: group._id, groupName: group.name,
    nature: "asset", creditPeriodDays,
  });
}

/** An open bill on a party, optionally with a sidecar row. */
async function seedBill(company, party, { billName, amount, voucherDate, dueDate, sidecar }) {
  seq += 1;
  await Acc_Voucher.create({
    companyId: company._id,
    voucherNumber: `S-${Date.now().toString(36)}-${seq}`,
    voucherType: "sales",
    voucherDate: new Date(voucherDate),
    status: "posted",
    grandTotal: amount,
    ...(dueDate ? { dueDate: new Date(dueDate) } : {}),
    ledgerEntries: [{
      ledgerId: party._id, ledgerName: party.name, type: "Dr", amount,
      billAllocations: [{ billName, billType: "new_ref", amount }],
    }],
  });
  if (sidecar) {
    await Acc_BillTerms.create({
      companyId: company._id, ledgerId: party._id, billName,
      dueDate: new Date(sidecar.dueDate),
      source: sidecar.source || "company_default",
      creditDaysUsed: sidecar.creditDaysUsed || 46,
      basisDate: new Date(voucherDate),
      isManual: !!sidecar.isManual,
      ...(sidecar.forecastExpectedDate
        ? { forecastExpectedDate: new Date(sidecar.forecastExpectedDate), forecastExpectedDateSource: "manual" }
        : {}),
      ...(sidecar.backfillRunId ? { backfillRunId: sidecar.backfillRunId } : {}),
    });
  }
}

/** A company mirroring the live shape: one dominant party on company defaults. */
async function seedRealistic() {
  const { company, group } = await seedCompany();
  const mayfair = await seedParty(company, group, "MAYFAIR Lagoon");
  const small = await seedParty(company, group, "Divaksh Textiles");

  for (const [n, amt] of [["MF-1", 300000], ["MF-2", 200000], ["MF-3", 100000]]) {
    await seedBill(company, mayfair, {
      billName: n, amount: amt, voucherDate: "2026-06-01",
      sidecar: { dueDate: "2026-07-17", source: "company_default", creditDaysUsed: 46 },
    });
  }
  await seedBill(company, small, {
    billName: "DV-1", amount: 50000, voucherDate: "2026-06-05",
    sidecar: { dueDate: "2026-07-21", source: "company_default", creditDaysUsed: 46 },
  });
  return { company, group, mayfair, small };
}

/* ── Analysis ────────────────────────────────────────────────────────────── */

describe("analysis", () => {
  test("parties are ranked with the biggest default-derived exposure first", async () => {
    const { company, mayfair } = await seedRealistic();
    const { status, body } = await call(`?companyId=${company._id}`);

    expect(status).toBe(200);
    expect(body.parties[0].ledgerName).toBe("MAYFAIR Lagoon");
    expect(String(body.parties[0].ledgerId)).toBe(mayfair._id.toString());
    expect(body.parties[0].companyDefaultDerivedCount).toBe(3);
    expect(body.parties[0].companyDefaultDerivedAmount).toBe(600000);
    expect(body.parties[0].openItemCount).toBe(3);
    expect(body.parties[1].ledgerName).toBe("Divaksh Textiles");
  });

  test("a party's date cluster and priority reason are reported", async () => {
    const { company } = await seedRealistic();
    const { body } = await call(`?companyId=${company._id}`);
    const mf = body.parties[0];

    // All three share a basis date, so the flat default lands them together —
    // the exact distortion this workflow exists to fix.
    expect(mf.topDates[0]).toEqual({ date: "2026-07-17", amount: 600000, count: 3 });
    expect(mf.suggestedPriorityReason).toMatch(/3 bills dated from the company default/);
    expect(mf.suggestedPriorityReason).toMatch(/3 land on 2026-07-17/);
  });

  test("unset credit terms are reported as null, never as 0", async () => {
    const { company, group } = await seedRealistic();
    const termed = await seedParty(company, group, "Has Terms", 30);
    await seedBill(company, termed, {
      billName: "T-1", amount: 1000, voucherDate: "2026-06-01",
      sidecar: { dueDate: "2026-07-01", source: "party_terms", creditDaysUsed: 30 },
    });

    const { body } = await call(`?companyId=${company._id}`);
    const byName = Object.fromEntries(body.parties.map((p) => [p.ledgerName, p]));
    expect(byName["MAYFAIR Lagoon"].currentCreditPeriodDays).toBeNull();
    expect(byName["Has Terms"].currentCreditPeriodDays).toBe(30);
    // Already on party terms — nothing for this workflow to fix.
    expect(byName["Has Terms"].companyDefaultDerivedCount).toBe(0);
  });

  test("manual sidecar and manual expected dates are visible but counted apart", async () => {
    const { company, group } = await seedRealistic();
    const p = await seedParty(company, group, "Mixed Party");
    await seedBill(company, p, {
      billName: "MX-1", amount: 1000, voucherDate: "2026-06-01",
      sidecar: { dueDate: "2026-08-01", source: "manual", isManual: true },
    });
    await seedBill(company, p, {
      billName: "MX-2", amount: 2000, voucherDate: "2026-06-01",
      sidecar: { dueDate: "2026-07-17", source: "company_default", forecastExpectedDate: "2027-01-10" },
    });

    const { body } = await call(`?companyId=${company._id}`);
    const mixed = body.parties.find((x) => x.ledgerName === "Mixed Party");
    expect(mixed.openItemCount).toBe(2);
    expect(mixed.manualSidecarCount).toBe(1);
    expect(mixed.manualExpectedDateCount).toBe(1);
    // The manual row is NOT automatically recalculable, so it is not counted
    // as default-derived exposure.
    expect(mixed.companyDefaultDerivedCount).toBe(1);
  });

  test("one company's parties never appear in another's analysis", async () => {
    const a = await seedRealistic();
    const b = await seedRealistic();
    void b;
    const { body } = await call(`?companyId=${a.company._id}`);
    expect(body.parties).toHaveLength(2);
    expect(body.parties.every((p) => p.ledgerName)).toBe(true);
  });

  test("a missing or malformed companyId is refused", async () => {
    expect((await call("")).status).toBe(400);
    expect((await call("?companyId=nope")).status).toBe(400);
  });

  test("no auth is refused", async () => {
    const { company } = await seedRealistic();
    expect((await call(`?companyId=${company._id}`, { user: null })).status).toBe(401);
  });
});

/* ── Preview ─────────────────────────────────────────────────────────────── */

describe("preview", () => {
  const previewBody = (company, ledger, days) => ({
    companyId: company._id.toString(),
    ledgerId: ledger._id.toString(),
    proposedCreditPeriodDays: days,
  });

  test("shows every bill moving from its current date to the proposed one", async () => {
    const { company, mayfair } = await seedRealistic();
    const { status, body } = await call("/preview", { method: "POST", body: previewBody(company, mayfair, 30) });

    expect(status).toBe(200);
    expect(body.ledgerName).toBe("MAYFAIR Lagoon");
    expect(body.currentCreditPeriodDays).toBeNull();
    expect(body.proposedCreditPeriodDays).toBe(30);
    expect(body.rows).toHaveLength(3);
    for (const r of body.rows) {
      expect(r.currentDueDate.slice(0, 10)).toBe("2026-07-17");
      expect(r.proposedDueDate.slice(0, 10)).toBe("2026-07-01");
      expect(r.deltaDays).toBe(-16);
      expect(r.canRecalculate).toBe(true);
    }
    expect(body.totals.recalculableCount).toBe(3);
    expect(body.totals.recalculableAmount).toBe(600000);
    expect(body.totals.netDateShiftDaysWeighted).toBe(-16);
    expect(body.confirmationToken).toBeTruthy();
  });

  test("a manual sidecar row is blocked and clearly labelled", async () => {
    const { company, group } = await seedRealistic();
    const p = await seedParty(company, group, "Manual Party");
    await seedBill(company, p, {
      billName: "M-1", amount: 5000, voucherDate: "2026-06-01",
      sidecar: { dueDate: "2026-08-01", source: "manual", isManual: true },
    });

    const { body } = await call("/preview", { method: "POST", body: previewBody(company, p, 30) });
    expect(body.rows[0].canRecalculate).toBe(false);
    expect(body.rows[0].blockedReason).toBe("manual_sidecar");
    expect(body.totals.blockedCount).toBe(1);
    expect(body.totals.blockedAmount).toBe(5000);
  });

  test("a row with a manual expected date is protected, not silently moved", async () => {
    const { company, group } = await seedRealistic();
    const p = await seedParty(company, group, "Expected Party");
    await seedBill(company, p, {
      billName: "E-1", amount: 7000, voucherDate: "2026-06-01",
      sidecar: { dueDate: "2026-07-17", source: "company_default", forecastExpectedDate: "2027-01-10" },
    });

    const { body } = await call("/preview", { method: "POST", body: previewBody(company, p, 30) });
    expect(body.rows[0].blockedReason).toBe("manual_expected_date");
    expect(body.rows[0].canRecalculate).toBe(false);
  });

  test("proposed days is validated 0..365", async () => {
    const { company, mayfair } = await seedRealistic();
    for (const [v, code] of [[-1, "OUT_OF_RANGE"], [366, "OUT_OF_RANGE"], [30.5, "NOT_INTEGER"], ["abc", "INVALID_TYPE"], [true, "INVALID_TYPE"]]) {
      const { status, body } = await call("/preview", { method: "POST", body: previewBody(company, mayfair, v) });
      expect(status).toBe(400);
      expect(body.code).toBe(code);
    }
  });

  test("another company's ledger is refused", async () => {
    const a = await seedRealistic();
    const b = await seedRealistic();
    const { status, body } = await call("/preview", {
      method: "POST",
      body: previewBody(a.company, b.mayfair, 30),
    });
    expect(status).toBe(404);
    expect(body.code).toBe("PARTY_NOT_FOUND");
  });

  test("PREVIEW WRITES NOTHING — counts and updatedAt unchanged", async () => {
    const { company, mayfair } = await seedRealistic();
    const snap = async () => ({
      v: await Acc_Voucher.countDocuments({}),
      bt: await Acc_BillTerms.countDocuments({}),
      l: await Acc_Ledger.countDocuments({}),
      lU: (await Acc_Ledger.find({}).select("updatedAt").lean()).map((x) => +new Date(x.updatedAt)).sort().join(","),
      btU: (await Acc_BillTerms.find({}).select("updatedAt").lean()).map((x) => +new Date(x.updatedAt)).sort().join(","),
      vU: (await Acc_Voucher.find({}).select("updatedAt").lean()).map((x) => +new Date(x.updatedAt)).sort().join(","),
    });

    const before = await snap();
    await call(`?companyId=${company._id}`);
    for (const d of [0, 15, 30, 60, 365]) {
      await call("/preview", { method: "POST", body: previewBody(company, mayfair, d) });
    }
    expect(await snap()).toEqual(before);
  });

  test("a viewer may preview — it is read-only", async () => {
    const { company, mayfair } = await seedRealistic();
    const { status } = await call("/preview", {
      method: "POST", body: previewBody(company, mayfair, 30), user: VIEWER,
    });
    expect(status).toBe(200);
  });
});

/* ── Apply ───────────────────────────────────────────────────────────────── */

describe("apply", () => {
  async function previewFor(company, ledger, days, user) {
    return call("/preview", {
      method: "POST",
      body: { companyId: company._id.toString(), ledgerId: ledger._id.toString(), proposedCreditPeriodDays: days },
      ...(user ? { user } : {}),
    });
  }

  test("applies the term and recalculates only the default-derived sidecar rows", async () => {
    const { company, mayfair } = await seedRealistic();
    const pv = await previewFor(company, mayfair, 30);

    const { status, body } = await call("/apply", {
      method: "POST",
      body: {
        companyId: company._id.toString(),
        ledgerId: mayfair._id.toString(),
        proposedCreditPeriodDays: 30,
        confirmationToken: pv.body.confirmationToken,
      },
    });

    expect(status).toBe(200);
    expect(body.creditPeriodDays).toBe(30);
    expect(body.recalculated.written).toBe(3);
    expect(body.recalculated.backfillRunId).toBeTruthy();

    // The term landed through the whitelisted path, with provenance.
    const led = await Acc_Ledger.findById(mayfair._id).lean();
    expect(led.creditPeriodDays).toBe(30);
    expect(led.creditTermsSource).toBe("manual");
    expect(String(led.creditTermsUpdatedBy)).toBe(EDITOR.id);

    // And the sidecar rows now carry party terms at the new date.
    const rows = await Acc_BillTerms.find({ ledgerId: mayfair._id }).lean();
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.source).toBe("party_terms");
      expect(r.creditDaysUsed).toBe(30);
      expect(r.dueDate.toISOString().slice(0, 10)).toBe("2026-07-01");
    }
  });

  test("a manual sidecar row is NOT touched by an apply", async () => {
    const { company, group } = await seedRealistic();
    const p = await seedParty(company, group, "Protected Party");
    await seedBill(company, p, {
      billName: "P-OK", amount: 1000, voucherDate: "2026-06-01",
      sidecar: { dueDate: "2026-07-17", source: "company_default", creditDaysUsed: 46 },
    });
    await seedBill(company, p, {
      billName: "P-MANUAL", amount: 2000, voucherDate: "2026-06-01",
      sidecar: { dueDate: "2026-12-25", source: "manual", isManual: true, creditDaysUsed: 200 },
    });

    const pv = await previewFor(company, p, 30);
    const { status, body } = await call("/apply", {
      method: "POST",
      body: {
        companyId: company._id.toString(), ledgerId: p._id.toString(),
        proposedCreditPeriodDays: 30, confirmationToken: pv.body.confirmationToken,
      },
    });
    expect(status).toBe(200);
    expect(body.protected.manualSidecar).toBe(1);

    const manual = await Acc_BillTerms.findOne({ ledgerId: p._id, billName: "P-MANUAL" }).lean();
    expect(manual.dueDate.toISOString().slice(0, 10)).toBe("2026-12-25");
    expect(manual.source).toBe("manual");
    expect(manual.isManual).toBe(true);

    const ok = await Acc_BillTerms.findOne({ ledgerId: p._id, billName: "P-OK" }).lean();
    expect(ok.dueDate.toISOString().slice(0, 10)).toBe("2026-07-01");
  });

  test("a read-only role cannot apply, and nothing changes", async () => {
    const { company, mayfair } = await seedRealistic();
    const pv = await previewFor(company, mayfair, 30);

    const { status } = await call("/apply", {
      method: "POST",
      body: {
        companyId: company._id.toString(), ledgerId: mayfair._id.toString(),
        proposedCreditPeriodDays: 30, confirmationToken: pv.body.confirmationToken,
      },
      user: VIEWER,
    });
    expect(status).toBe(403);

    const led = await Acc_Ledger.findById(mayfair._id).lean();
    expect(led.creditPeriodDays).toBe(0);
  });

  test("apply without a confirmation token is refused", async () => {
    const { company, mayfair } = await seedRealistic();
    const { status, body } = await call("/apply", {
      method: "POST",
      body: { companyId: company._id.toString(), ledgerId: mayfair._id.toString(), proposedCreditPeriodDays: 30 },
    });
    expect(status).toBe(400);
    expect(body.code).toBe("CONFIRMATION_REQUIRED");
  });

  test("a token from a DIFFERENT proposal is refused as stale", async () => {
    const { company, mayfair } = await seedRealistic();
    const pv = await previewFor(company, mayfair, 30);

    const { status, body } = await call("/apply", {
      method: "POST",
      body: {
        companyId: company._id.toString(), ledgerId: mayfair._id.toString(),
        proposedCreditPeriodDays: 60, // not what was previewed
        confirmationToken: pv.body.confirmationToken,
      },
    });
    expect(status).toBe(409);
    expect(body.code).toBe("STALE_PREVIEW");

    const led = await Acc_Ledger.findById(mayfair._id).lean();
    expect(led.creditPeriodDays).toBe(0);
  });

  test("apply never writes a voucher", async () => {
    const { company, mayfair } = await seedRealistic();
    const before = {
      count: await Acc_Voucher.countDocuments({}),
      stamps: (await Acc_Voucher.find({}).select("updatedAt").lean()).map((x) => +new Date(x.updatedAt)).sort().join(","),
    };

    const pv = await previewFor(company, mayfair, 30);
    await call("/apply", {
      method: "POST",
      body: {
        companyId: company._id.toString(), ledgerId: mayfair._id.toString(),
        proposedCreditPeriodDays: 30, confirmationToken: pv.body.confirmationToken,
      },
    });

    expect(await Acc_Voucher.countDocuments({})).toBe(before.count);
    expect(
      (await Acc_Voucher.find({}).select("updatedAt").lean()).map((x) => +new Date(x.updatedAt)).sort().join(","),
    ).toBe(before.stamps);
  });

  test("apply touches only the named party — another party's rows are untouched", async () => {
    const { company, mayfair, small } = await seedRealistic();
    const pv = await previewFor(company, mayfair, 30);
    await call("/apply", {
      method: "POST",
      body: {
        companyId: company._id.toString(), ledgerId: mayfair._id.toString(),
        proposedCreditPeriodDays: 30, confirmationToken: pv.body.confirmationToken,
      },
    });

    const other = await Acc_BillTerms.findOne({ ledgerId: small._id }).lean();
    expect(other.source).toBe("company_default");
    expect(other.dueDate.toISOString().slice(0, 10)).toBe("2026-07-21");
    const otherLedger = await Acc_Ledger.findById(small._id).lean();
    expect(otherLedger.creditPeriodDays).toBe(0);
  });
});

/* ── Scope guard ─────────────────────────────────────────────────────────── */

describe("scope guard", () => {
  test("the route uses the whitelisted credit-terms service, not a broad ledger update", async () => {
    const fs = require("fs");
    const src = fs.readFileSync(
      require.resolve("../../routes/Accountant_Routes/Acc_partyTermsImpact"),
      "utf8",
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    // The one ledger write goes through `creditTerms.buildUpdate`.
    expect(code).toMatch(/creditTerms\.buildUpdate\(/);
    // And no `$set` is ever assembled from the request body.
    expect(code).not.toMatch(/\$set:\s*\{\s*\.\.\.req\.body/);
    expect(code).not.toMatch(/\.\.\.req\.body/);
    // The only models it writes are the ledger (via the service's $set) and,
    // transitively, bill terms via C0-F's own apply.
    const writes = [...code.matchAll(/(Acc_[A-Za-z]+)\.(create|findOneAndUpdate|updateOne|updateMany|deleteOne|deleteMany)\(/g)].map((m) => m[1]);
    expect([...new Set(writes)]).toEqual(["Acc_Ledger"]);
  });
});
