// test/accountant/customer-statement-pack.route.test.js
//
// Lane B, Chunk 5 — bulk CUSTOMER statement packs, over real collections.
//
// A pack is many parties' statements in one download. The only thing that
// makes it trustworthy is that it is not a second calculation: every figure in
// it must be the one the individual Statement export already produces for that
// party. So the central assertion here is not "the arithmetic is correct" —
// `customerOutstanding.test.js` owns that — it is "the pack and the individual
// statement AGREE, party by party, field by field". If they ever disagree,
// nobody can tell which of the two documents an accountant sent to a customer.
//
// The rest of the file covers what only a real request over real collections
// can show:
//   • Company A's pack contains no Company B party, including when B's ledger
//     id is handed in as a selection.
//   • A SUPPLIER ledger id cannot be pulled into a customer pack.
//   • An empty filtered scope produces an empty pack — never a full one.
//   • `from`/`to` and `asOf` bound the pack exactly as they bound a statement,
//     opening balance included.
//   • GET and POST are the same request in two transports, to the digit.
//   • The XLSX, PDF and ZIP bytes are actually a workbook, a PDF and a ZIP —
//     parsed, not sniffed — and the ZIP's manifest matches its entries.
//   • Two parties with the SAME NAME get two distinct files, so a pack of 40
//     statements arrives as 40 files and not 39.
//   • Producing any of it writes nothing.
//
// `orgAuth` is mocked so identity is assertable without a JWT — it is Lane A's
// and this suite is not testing it. `requireCompanyAccess` is the REAL one.
"use strict";

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/AccountantOrgAuthMiddleware", () => {
  const actual = jest.requireActual("../../Middlewear/AccountantOrgAuthMiddleware");
  return {
    ...actual,
    orgAuth: (req, res, next) => {
      const raw = req.headers["x-test-user"];
      if (!raw) {
        return res.status(401).json({ success: false, message: "Authentication required" });
      }
      const parsed = JSON.parse(raw);
      req.user = parsed.user;
      req.organization = parsed.organization || null;
      next();
    },
  };
});

const {
  Acc_Company,
  Acc_Group,
  Acc_Ledger,
} = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");
const { readZip, zipMap, parseCsv } = require("./zipReader");

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/accountant/customers/reports",
    require("../../routes/Accountant_Routes/Acc_customerReports"),
  );
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api/accountant/customers`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/* ── Fixtures ────────────────────────────────────────────────────────────── */

async function seedCompany(name) {
  const company = await Acc_Company.create({
    companyName: name,
    booksFromDate: new Date("2025-04-01"),
  });
  const debtors = await Acc_Group.create({
    companyId: company._id,
    name: "Sundry Debtors",
    nature: "asset",
  });
  const creditors = await Acc_Group.create({
    companyId: company._id,
    name: "Sundry Creditors",
    nature: "liability",
  });
  const salesGroup = await Acc_Group.create({
    companyId: company._id,
    name: "Sales Accounts",
    nature: "revenue",
  });
  const sales = await Acc_Ledger.create({
    companyId: company._id,
    name: `${name} Sales`,
    groupId: salesGroup._id,
    groupName: salesGroup.name,
    nature: "revenue",
  });
  return { company, debtors, creditors, salesGroup, sales };
}

async function makeCustomer(fx, name, opts = {}) {
  return Acc_Ledger.create({
    companyId: fx.company._id,
    name,
    groupId: fx.debtors._id,
    groupName: fx.debtors.name,
    nature: "asset",
    gstin: opts.gstin || undefined,
    openingBalance: opts.openingBalance || 0,
    openingBalanceType: opts.openingBalanceType || "Dr",
  });
}

async function makeSupplier(fx, name) {
  return Acc_Ledger.create({
    companyId: fx.company._id,
    name,
    groupId: fx.creditors._id,
    groupName: fx.creditors.name,
    nature: "liability",
  });
}

/** One two-line voucher: `amount` Dr on the party, Cr on the sales ledger. */
async function postVoucher(fx, party, opts = {}) {
  const amount = opts.amount ?? 10000;
  const partySide = opts.partySide || "Dr";
  const otherSide = partySide === "Dr" ? "Cr" : "Dr";
  return Acc_Voucher.create({
    companyId: fx.company._id,
    voucherType: opts.voucherType || "sales",
    voucherNumber: opts.voucherNumber || `V-${Math.random().toString(36).slice(2, 9)}`,
    voucherDate: new Date(opts.date || "2026-05-01"),
    partyLedgerId: party._id,
    partyLedgerName: party.name,
    narration: opts.narration,
    status: opts.status || "posted",
    isOptional: opts.isOptional || false,
    grandTotal: amount,
    ledgerEntries: [
      { ledgerId: party._id, ledgerName: party.name, type: partySide, amount },
      { ledgerId: fx.sales._id, ledgerName: fx.sales.name, type: otherSide, amount },
    ],
  });
}

const orgFor = (company, role = "owner") => ({
  user: {
    id: new mongoose.Types.ObjectId().toString(),
    role,
    permissions: { canView: true, canEdit: true },
  },
  organization: { tallyCompanyIds: [String(company._id)] },
});

async function call(path, { user, raw = false, method = "GET", body: reqBody } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(user === null ? {} : { "x-test-user": JSON.stringify(user) }),
      ...(reqBody !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(reqBody !== undefined ? { body: JSON.stringify(reqBody) } : {}),
  });
  if (raw) return res;
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

const packUrl = (companyId, extra = "") =>
  `/reports/statement-pack?companyId=${companyId}${extra}`;

const bytesOf = async (res) => Buffer.from(await res.arrayBuffer());

/**
 * A company with three customers whose statements differ from one another in
 * every field the pack carries: opening balance and side, movement, and
 * transaction count.
 */
async function seedThreeCustomers() {
  const fx = await seedCompany("Alpha Traders");
  const acme = await makeCustomer(fx, "Acme Exports", {
    openingBalance: 5000,
    openingBalanceType: "Dr",
    gstin: "24AAAAA0000A1Z5",
  });
  const bharat = await makeCustomer(fx, "Bharat Mills", {
    openingBalance: 2000,
    openingBalanceType: "Cr",
  });
  const zeta = await makeCustomer(fx, "Zeta Retail");

  await postVoucher(fx, acme, { amount: 12000, date: "2026-05-04", voucherNumber: "S-1" });
  await postVoucher(fx, acme, {
    amount: 4000,
    date: "2026-05-20",
    partySide: "Cr",
    voucherNumber: "R-1",
  });
  await postVoucher(fx, bharat, { amount: 7500, date: "2026-05-11", voucherNumber: "S-2" });
  // Zeta has no movement at all — a party with nothing to say is still in the
  // pack, because "you owe nothing" is a statement an accountant sends.

  return { fx, acme, bharat, zeta };
}

/* ── Company scope must be present and honest ────────────────────────────── */

describe("company scope — fail closed", () => {
  test("no companyId is a 400, not an unscoped pack of every company", async () => {
    const fx = await seedCompany("A");
    const r = await call("/reports/statement-pack", { user: orgFor(fx.company) });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("COMPANY_SCOPE_REQUIRED");
  });

  test("a malformed companyId is a 400", async () => {
    const fx = await seedCompany("A");
    const r = await call(packUrl("not-an-object-id"), { user: orgFor(fx.company) });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("COMPANY_SCOPE_REQUIRED");
  });

  test("no credentials at all is a 401", async () => {
    const fx = await seedCompany("A");
    const r = await call(packUrl(fx.company._id), { user: null });
    expect(r.status).toBe(401);
  });

  test("a company the organisation does not own is refused by Lane A's check", async () => {
    const a = await seedCompany("A");
    const b = await seedCompany("B");
    const r = await call(packUrl(b.company._id), { user: orgFor(a.company) });
    expect(r.status).toBe(403);
  });

  test("companyId in the query and a DIFFERENT one in the body is refused outright", async () => {
    /* The hazard the shared guard exists for: authorised for one company,
       reported on another. A pack is the worst place for it — it would ship
       another company's entire debtor book in one file. */
    const a = await seedCompany("A");
    const b = await seedCompany("B");
    const r = await call(packUrl(a.company._id), {
      user: orgFor(a.company),
      method: "POST",
      body: { companyId: String(b.company._id), scope: "all" },
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("COMPANY_SCOPE_CONFLICT");
  });

  test("a nonexistent but well-formed companyId is a 404, not an empty success", async () => {
    const ghost = new mongoose.Types.ObjectId();
    const r = await call(packUrl(ghost), {
      user: {
        user: { id: "u", role: "owner" },
        organization: { tallyCompanyIds: [String(ghost)] },
      },
    });
    expect(r.status).toBe(404);
  });
});

/* ── THE CENTRAL CLAIM: the pack is not a second calculation ─────────────── */

describe("every statement in the pack equals the individual statement export", () => {
  /** The pack's entry for a ledger, and that ledger's own statement export. */
  async function bothWays(fx, ledger, user, period = "") {
    const pack = await call(packUrl(fx.company._id, period), { user });
    const single = await call(
      `/reports/ledger/${ledger._id}?companyId=${fx.company._id}${period}`,
      { user },
    );
    expect(pack.status).toBe(200);
    expect(single.status).toBe(200);
    const entry = pack.body.pack.statements.find(
      (s) => s.ledger.ledgerId === String(ledger._id),
    );
    expect(entry).toBeTruthy();
    return { entry, statement: single.body.statement, pack: pack.body.pack };
  }

  test("opening, closing, totals and every row match, for a party with movement", async () => {
    const { fx, acme } = await seedThreeCustomers();
    const user = orgFor(fx.company);
    const { entry, statement } = await bothWays(fx, acme, user);

    expect(entry.opening).toEqual(statement.opening);
    expect(entry.closing).toEqual(statement.closing);
    expect(entry.totals).toEqual(statement.totals);
    expect(entry.ledger).toEqual(statement.ledger);
    expect(entry.rows).toEqual(statement.rows);
  });

  test("it matches for a CREDIT opening too — the sign is not re-derived", async () => {
    const { fx, bharat } = await seedThreeCustomers();
    const { entry, statement } = await bothWays(fx, bharat, orgFor(fx.company));
    expect(entry.opening.type).toBe("Cr");
    expect(entry.opening).toEqual(statement.opening);
    expect(entry.closing).toEqual(statement.closing);
  });

  test("it matches for a party with NO movement", async () => {
    const { fx, zeta } = await seedThreeCustomers();
    const { entry, statement } = await bothWays(fx, zeta, orgFor(fx.company));
    expect(entry.totals.transactionCount).toBe(0);
    expect(entry.rows).toEqual([]);
    expect(entry.opening).toEqual(statement.opening);
    expect(entry.closing).toEqual(statement.closing);
  });

  test("it matches over a DATE RANGE, opening balance included", async () => {
    /* The hardest case to get right independently: the opening at `from` is
       the master opening plus every posted movement before it. A pack that
       recomputed openings would diverge here first. */
    const { fx, acme } = await seedThreeCustomers();
    const { entry, statement } = await bothWays(
      fx,
      acme,
      orgFor(fx.company),
      "&from=2026-05-10&to=2026-05-31",
    );
    expect(statement.opening.priorMovement).toBe(12000);
    expect(entry.opening).toEqual(statement.opening);
    expect(entry.rows).toEqual(statement.rows);
    expect(entry.totals).toEqual(statement.totals);
  });

  test("the pack's totals are the SUM of its statements, not a separate figure", async () => {
    const { fx } = await seedThreeCustomers();
    const r = await call(packUrl(fx.company._id), { user: orgFor(fx.company) });
    const p = r.body.pack;
    const sum = (f) => p.statements.reduce((a, s) => a + f(s), 0);
    expect(p.totals.debit).toBe(sum((s) => s.totals.debit));
    expect(p.totals.credit).toBe(sum((s) => s.totals.credit));
    expect(p.totals.transactionCount).toBe(sum((s) => s.totals.transactionCount));
    expect(p.totals.partyCount).toBe(3);
    expect(p.totals.partiesWithMovement).toBe(2);
  });
});

/* ── Company and party-kind isolation ────────────────────────────────────── */

describe("isolation", () => {
  test("Company A's pack contains no Company B party and no Company B amount", async () => {
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    const aCust = await makeCustomer(a, "Alpha Buyer");
    const bCust = await makeCustomer(b, "Beta Buyer");
    await postVoucher(a, aCust, { amount: 11000 });
    await postVoucher(b, bCust, { amount: 99999 });

    const r = await call(packUrl(a.company._id), { user: orgFor(a.company) });
    expect(r.status).toBe(200);
    expect(r.body.pack.statements.map((s) => s.ledger.name)).toEqual(["Alpha Buyer"]);
    expect(JSON.stringify(r.body)).not.toContain("Beta Buyer");
    expect(JSON.stringify(r.body)).not.toContain("99999");
  });

  test("a SPOOFED selected ledger id from another company is excluded, not stated", async () => {
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    const aCust = await makeCustomer(a, "Alpha Buyer");
    const bCust = await makeCustomer(b, "Beta Buyer");
    await postVoucher(a, aCust, { amount: 11000 });
    await postVoucher(b, bCust, { amount: 99999 });

    const r = await call(
      packUrl(a.company._id, `&scope=selected&ledgerIds=${aCust._id},${bCust._id}`),
      { user: orgFor(a.company) },
    );
    expect(r.status).toBe(200);
    expect(r.body.pack.statements.map((s) => s.ledger.name)).toEqual(["Alpha Buyer"]);
  });

  test("a selection of ONLY another company's ledgers gives nothing — never everything", async () => {
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    await makeCustomer(a, "Alpha Buyer").then((l) => postVoucher(a, l, { amount: 11000 }));
    const bCust = await makeCustomer(b, "Beta Buyer");

    const r = await call(packUrl(a.company._id, `&scope=selected&ledgerIds=${bCust._id}`), {
      user: orgFor(a.company),
    });
    expect(r.status).toBe(200);
    expect(r.body.pack.statements).toEqual([]);
    expect(r.body.pack.totals.partyCount).toBe(0);
  });

  test("a SUPPLIER ledger cannot be pulled into a customer pack by id", async () => {
    /* Party-kind isolation. Both packs run the same party-neutral service, so
       the only thing keeping a creditor out of a debtor pack is the group
       re-resolution — asserted here rather than assumed. */
    const fx = await seedCompany("Alpha");
    const cust = await makeCustomer(fx, "Alpha Buyer");
    const supp = await makeSupplier(fx, "Alpha Supplier");
    await postVoucher(fx, cust, { amount: 11000 });
    await postVoucher(fx, supp, { amount: 4000, partySide: "Cr" });

    const all = await call(packUrl(fx.company._id), { user: orgFor(fx.company) });
    expect(all.body.pack.statements.map((s) => s.ledger.name)).toEqual(["Alpha Buyer"]);

    const picked = await call(
      packUrl(fx.company._id, `&scope=selected&ledgerIds=${supp._id}`),
      { user: orgFor(fx.company) },
    );
    expect(picked.status).toBe(200);
    expect(picked.body.pack.statements).toEqual([]);
  });
});

/* ── Scope rules ─────────────────────────────────────────────────────────── */

describe("scope", () => {
  test('scope=all states every customer, in name order', async () => {
    const { fx } = await seedThreeCustomers();
    const r = await call(packUrl(fx.company._id, "&scope=all"), { user: orgFor(fx.company) });
    expect(r.body.pack.statements.map((s) => s.ledger.name)).toEqual([
      "Acme Exports",
      "Bharat Mills",
      "Zeta Retail",
    ]);
    expect(r.body.pack.scopeSummary).toBe("Scope: all accounting customers (3)");
  });

  test("scope=selected states EXACTLY the ids given", async () => {
    const { fx, acme, zeta } = await seedThreeCustomers();
    const r = await call(
      packUrl(fx.company._id, `&scope=selected&ledgerIds=${acme._id},${zeta._id}`),
      { user: orgFor(fx.company) },
    );
    expect(r.body.pack.statements.map((s) => s.ledger.name)).toEqual([
      "Acme Exports",
      "Zeta Retail",
    ]);
    expect(r.body.pack.scopeSummary).toBe("Scope: selected customers (2)");
  });

  test("scope=filtered states EXACTLY the ids on screen", async () => {
    const { fx, bharat } = await seedThreeCustomers();
    const r = await call(
      packUrl(fx.company._id, `&scope=filtered&ledgerIds=${bharat._id}`),
      { user: orgFor(fx.company) },
    );
    expect(r.body.pack.statements.map((s) => s.ledger.name)).toEqual(["Bharat Mills"]);
    expect(r.body.pack.scopeSummary).toBe("Scope: current filtered result (1)");
  });

  test("AN EMPTY FILTERED RESULT STAYS EMPTY — it never widens to every customer", async () => {
    /* The bug this pins: treating "no ids" as "no narrowing". A filtered
       export of nothing then becomes a pack of the entire debtor book, which
       is both wrong and a disclosure. */
    const { fx } = await seedThreeCustomers();
    const r = await call(packUrl(fx.company._id, "&scope=filtered&ledgerIds="), {
      user: orgFor(fx.company),
    });
    expect(r.status).toBe(200);
    expect(r.body.pack.statements).toEqual([]);
    expect(r.body.pack.totals.partyCount).toBe(0);
    expect(r.body.pack.resolvedLedgerCount).toBe(0);
  });

  test("scope=filtered with the parameter ABSENT is a refusal, not a full pack", async () => {
    const { fx } = await seedThreeCustomers();
    const r = await call(packUrl(fx.company._id, "&scope=filtered"), {
      user: orgFor(fx.company),
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/must send the ledger ids/i);
  });

  test("scope=selected with nothing selected is a refusal", async () => {
    const { fx } = await seedThreeCustomers();
    const r = await call(packUrl(fx.company._id, "&scope=selected&ledgerIds="), {
      user: orgFor(fx.company),
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/select at least one customer/i);
  });
});

/* ── The period bounds the whole pack ────────────────────────────────────── */

describe("period", () => {
  test("from/to are inclusive at both ends and exclude what is outside", async () => {
    const fx = await seedCompany("Alpha");
    const cust = await makeCustomer(fx, "Bounded Buyer");
    await postVoucher(fx, cust, { amount: 1000, date: "2026-05-31", voucherNumber: "BEFORE" });
    await postVoucher(fx, cust, { amount: 2000, date: "2026-06-01", voucherNumber: "FIRST" });
    await postVoucher(fx, cust, { amount: 4000, date: "2026-06-30", voucherNumber: "LAST" });
    await postVoucher(fx, cust, { amount: 8000, date: "2026-07-01", voucherNumber: "AFTER" });

    const r = await call(
      packUrl(fx.company._id, "&from=2026-06-01&to=2026-06-30"),
      { user: orgFor(fx.company) },
    );
    const s = r.body.pack.statements[0];
    expect(s.rows.map((x) => x.voucherNumber)).toEqual(["FIRST", "LAST"]);
    expect(s.totals.debit).toBe(6000);
    // The 31 May voucher is not in the window — it is in the OPENING.
    expect(s.opening.priorMovement).toBe(1000);
    expect(s.opening.amount).toBe(1000);
    expect(s.closing.amount).toBe(7000);
  });

  test("asOf bounds the pack and the later voucher is absent entirely", async () => {
    const fx = await seedCompany("Alpha");
    const cust = await makeCustomer(fx, "As-On Buyer");
    await postVoucher(fx, cust, { amount: 3000, date: "2026-06-10", voucherNumber: "IN" });
    await postVoucher(fx, cust, { amount: 9000, date: "2026-07-10", voucherNumber: "OUT" });

    const r = await call(packUrl(fx.company._id, "&asOf=2026-06-30"), {
      user: orgFor(fx.company),
    });
    const s = r.body.pack.statements[0];
    expect(s.rows.map((x) => x.voucherNumber)).toEqual(["IN"]);
    expect(s.closing.amount).toBe(3000);
    expect(JSON.stringify(r.body)).not.toContain("9000");
  });

  test("draft and optional vouchers are in no pack, at any period", async () => {
    const fx = await seedCompany("Alpha");
    const cust = await makeCustomer(fx, "Clean Buyer");
    await postVoucher(fx, cust, { amount: 5000, date: "2026-06-10", voucherNumber: "REAL" });
    await postVoucher(fx, cust, {
      amount: 70000,
      date: "2026-06-11",
      voucherNumber: "DRAFT",
      status: "draft",
    });
    await postVoucher(fx, cust, {
      amount: 80000,
      date: "2026-06-12",
      voucherNumber: "OPTIONAL",
      isOptional: true,
    });

    const r = await call(packUrl(fx.company._id), { user: orgFor(fx.company) });
    const s = r.body.pack.statements[0];
    expect(s.rows.map((x) => x.voucherNumber)).toEqual(["REAL"]);
    expect(s.closing.amount).toBe(5000);
    expect(JSON.stringify(r.body)).not.toContain("70000");
    expect(JSON.stringify(r.body)).not.toContain("80000");
  });

  test("the period line is stated on the pack itself, both ways", async () => {
    const { fx } = await seedThreeCustomers();
    const range = await call(packUrl(fx.company._id, "&from=2026-05-01&to=2026-05-31"), {
      user: orgFor(fx.company),
    });
    expect(range.body.pack.isRange).toBe(true);
    expect(range.body.pack.periodEnd).toBeTruthy();

    const asOn = await call(packUrl(fx.company._id, "&asOf=2026-05-31"), {
      user: orgFor(fx.company),
    });
    expect(asOn.body.pack.isRange).toBe(false);
    expect(asOn.body.pack.from).toBeNull();
  });
});

/* ── One request, two transports ─────────────────────────────────────────── */

describe("GET and POST are the same request", () => {
  test("a selection sent in the body gives the identical pack to the same ids in the query", async () => {
    const { fx, acme, bharat } = await seedThreeCustomers();
    const user = orgFor(fx.company);
    const ids = [String(acme._id), String(bharat._id)];

    const viaGet = await call(
      packUrl(fx.company._id, `&scope=selected&ledgerIds=${ids.join(",")}&from=2026-05-01&to=2026-05-31`),
      { user },
    );
    const viaPost = await call(packUrl(fx.company._id), {
      user,
      method: "POST",
      body: { scope: "selected", ledgerIds: ids, from: "2026-05-01", to: "2026-05-31" },
    });

    expect(viaGet.status).toBe(200);
    expect(viaPost.status).toBe(200);
    /* Everything except the two fields that legitimately differ: the instant
       each was generated (present on the pack AND on every statement in it)
       and the echo of the request that produced it. */
    const strip = (p) =>
      JSON.parse(
        JSON.stringify(p, (k, v) => (k === "generatedAt" || k === "filters" ? null : v)),
      );
    expect(strip(viaPost.body.pack)).toEqual(strip(viaGet.body.pack));
  });

  test("a POST body's ids are re-resolved in the company, not trusted", async () => {
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    const aCust = await makeCustomer(a, "Alpha Buyer");
    const bCust = await makeCustomer(b, "Beta Buyer");
    const r = await call(packUrl(a.company._id), {
      user: orgFor(a.company),
      method: "POST",
      body: { scope: "selected", ledgerIds: [String(aCust._id), String(bCust._id)] },
    });
    expect(r.body.pack.statements.map((s) => s.ledger.name)).toEqual(["Alpha Buyer"]);
  });

  test("the POST writes nothing — it is a read with a long argument list", async () => {
    const { fx, acme } = await seedThreeCustomers();
    const before = {
      vouchers: await Acc_Voucher.countDocuments({}),
      ledgers: await Acc_Ledger.countDocuments({}),
      acme: (await Acc_Ledger.findById(acme._id).lean()).updatedAt,
    };
    await call(packUrl(fx.company._id), {
      user: orgFor(fx.company),
      method: "POST",
      body: { scope: "all" },
    });
    expect(await Acc_Voucher.countDocuments({})).toBe(before.vouchers);
    expect(await Acc_Ledger.countDocuments({})).toBe(before.ledgers);
    expect((await Acc_Ledger.findById(acme._id).lean()).updatedAt).toEqual(before.acme);
  });
});

/* ── The XLSX is a workbook ──────────────────────────────────────────────── */

describe("format=xlsx", () => {
  async function workbook(fx, extra = "") {
    const res = await call(packUrl(fx.company._id, `&format=xlsx${extra}`), {
      user: orgFor(fx.company),
      raw: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("spreadsheetml");
    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await bytesOf(res));
    return { wb, res };
  }

  test("it has exactly two sheets — one row per party, one row per posting", async () => {
    const { fx } = await seedThreeCustomers();
    const { wb } = await workbook(fx);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Summary", "Transactions"]);
  });

  test("Summary carries every party once, with its own opening and closing", async () => {
    const { fx } = await seedThreeCustomers();
    const { wb } = await workbook(fx);
    const ws = wb.getWorksheet("Summary");
    const header = ws.getRow(7).values.slice(1);
    expect(header).toEqual([
      "Code",
      "Customer",
      "GSTIN",
      "Opening",
      "Dr/Cr",
      "Debit",
      "Credit",
      "Closing",
      "Dr/Cr",
      "Txns",
    ]);

    const rows = [8, 9, 10].map((r) => ws.getRow(r).values.slice(1));
    expect(rows.map((r) => r[1])).toEqual(["Acme Exports", "Bharat Mills", "Zeta Retail"]);
    // Acme: 5,000 Dr opening + 12,000 Dr − 4,000 Cr = 13,000 Dr.
    expect(rows[0][3]).toBe(5000);
    expect(rows[0][4]).toBe("Dr");
    expect(rows[0][5]).toBe(12000);
    expect(rows[0][6]).toBe(4000);
    expect(rows[0][7]).toBe(13000);
    expect(rows[0][8]).toBe("Dr");
    expect(rows[0][9]).toBe(2);
    // Bharat: 2,000 Cr opening + 7,500 Dr = 5,500 Dr.
    expect(rows[1][3]).toBe(2000);
    expect(rows[1][4]).toBe("Cr");
    expect(rows[1][7]).toBe(5500);
    expect(rows[1][8]).toBe("Dr");
  });

  test("money cells are NUMBERS with a money format, not strings", async () => {
    const { fx } = await seedThreeCustomers();
    const { wb } = await workbook(fx);
    const ws = wb.getWorksheet("Summary");
    for (const col of [4, 6, 7, 8]) {
      const cell = ws.getRow(8).getCell(col);
      expect(typeof cell.value).toBe("number");
      expect(cell.numFmt).toBeTruthy();
    }
  });

  test("the Summary total row is the sum of the party rows", async () => {
    const { fx } = await seedThreeCustomers();
    const { wb } = await workbook(fx);
    const ws = wb.getWorksheet("Summary");
    const total = ws.getRow(11);
    expect(total.getCell(1).value).toBe("TOTAL");
    expect(total.getCell(6).value).toBe(19500); // 12,000 + 7,500
    expect(total.getCell(7).value).toBe(4000);
    expect(total.getCell(10).value).toBe(3);
  });

  test("Transactions bands each party's postings between its opening and closing", async () => {
    const { fx } = await seedThreeCustomers();
    const { wb } = await workbook(fx);
    const ws = wb.getWorksheet("Transactions");
    const read = (r) => ws.getRow(r).values.slice(1);

    // Acme: opening band, two postings, closing band.
    expect(read(8)[1]).toBe("Acme Exports");
    expect(read(8)[5]).toBe("Opening Balance");
    expect(read(8)[8]).toBe(5000);
    expect(read(9)[4]).toBe("S-1");
    expect(read(9)[6]).toBe(12000);
    expect(read(10)[4]).toBe("R-1");
    expect(read(10)[7]).toBe(4000);
    expect(read(11)[5]).toBe("Closing Balance");
    expect(read(11)[8]).toBe(13000);
    expect(read(11)[9]).toBe("Dr");
    // Bharat's block starts immediately after.
    expect(read(12)[1]).toBe("Bharat Mills");
    expect(read(12)[5]).toBe("Opening Balance");
  });

  test("every sheet states the company, the period and the applied scope", async () => {
    const { fx } = await seedThreeCustomers();
    const { wb } = await workbook(fx, "&from=2026-05-01&to=2026-05-31&scope=all");
    for (const name of ["Summary", "Transactions"]) {
      const text = JSON.stringify(wb.getWorksheet(name).getRows(1, 6).map((r) => r.values));
      expect(text).toContain("Alpha Traders");
      expect(text).toContain("Scope: all accounting customers");
      expect(text).toMatch(/Period: .*2026/);
    }
  });

  test("the filename names the company, the report and the period", async () => {
    const { fx } = await seedThreeCustomers();
    const { res } = await workbook(fx, "&from=2026-05-01&to=2026-05-31");
    expect(res.headers.get("content-disposition")).toContain(
      "alpha-traders-customer-statements-2026-05-01-to-2026-05-31.xlsx",
    );
  });

  test("an empty filtered scope still produces a workbook, with no party rows", async () => {
    const { fx } = await seedThreeCustomers();
    const res = await call(
      packUrl(fx.company._id, "&format=xlsx&scope=filtered&ledgerIds="),
      { user: orgFor(fx.company), raw: true },
    );
    expect(res.status).toBe(200);
    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await bytesOf(res));
    const ws = wb.getWorksheet("Summary");
    expect(ws.getRow(8).getCell(1).value).toBe("TOTAL");
    expect(JSON.stringify(ws.getRows(1, 6).map((r) => r.values))).toContain(
      "Scope: current filtered result (0)",
    );
  });
});

/* ── The combined PDF is a PDF, one page per party ───────────────────────── */

describe("format=pdf", () => {
  const pageCount = (buf) =>
    (buf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;

  test("it is a real PDF, served as one, and each party starts a new page", async () => {
    const { fx } = await seedThreeCustomers();
    const res = await call(packUrl(fx.company._id, "&format=pdf"), {
      user: orgFor(fx.company),
      raw: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const buf = await bytesOf(res);
    expect(buf.slice(0, 5).toString()).toBe("%PDF-");
    // Three parties, three short statements — one page each and NO blanks.
    expect(pageCount(buf)).toBe(3);
  });

  test("a one-party pack is one page — footers do not add blank pages", async () => {
    /* THE BUG THIS PINS. The footer is drawn below the bottom margin, which
       is what a footer is; pdfkit answered each of the three footer writes by
       silently ADDING A PAGE. Every export in this lane was arriving with
       three blank pages after each real one, stamped "Page 1 of 1". */
    const fx = await seedCompany("Solo Ltd");
    const cust = await makeCustomer(fx, "Only Buyer");
    await postVoucher(fx, cust, { amount: 1000 });
    const res = await call(packUrl(fx.company._id, "&format=pdf"), {
      user: orgFor(fx.company),
      raw: true,
    });
    expect(pageCount(await bytesOf(res))).toBe(1);
  });

  test("an empty filtered scope produces a one-page PDF that says so", async () => {
    const { fx } = await seedThreeCustomers();
    const res = await call(
      packUrl(fx.company._id, "&format=pdf&scope=filtered&ledgerIds="),
      { user: orgFor(fx.company), raw: true },
    );
    expect(res.status).toBe(200);
    const buf = await bytesOf(res);
    expect(buf.slice(0, 5).toString()).toBe("%PDF-");
    expect(pageCount(buf)).toBe(1);
  });

  test("the download filename is the pack's, not a party's", async () => {
    const { fx } = await seedThreeCustomers();
    const res = await call(packUrl(fx.company._id, "&format=pdf&asOf=2026-05-31"), {
      user: orgFor(fx.company),
      raw: true,
    });
    expect(res.headers.get("content-disposition")).toContain(
      "alpha-traders-customer-statements-as-on-2026-05-31.pdf",
    );
  });
});

/* ── The ZIP is a ZIP, and its manifest tells the truth ──────────────────── */

describe("format=zip", () => {
  async function archive(fx, extra = "") {
    const res = await call(packUrl(fx.company._id, `&format=zip${extra}`), {
      user: orgFor(fx.company),
      raw: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const buf = await bytesOf(res);
    return { buf, entries: readZip(buf), res };
  }

  test("one PDF per party plus a manifest, and every entry parses", async () => {
    const { fx } = await seedThreeCustomers();
    const { entries } = await archive(fx);
    expect(entries).toHaveLength(4);
    expect(entries[0].name).toBe("manifest.csv");
    const pdfs = entries.filter((e) => e.name.endsWith(".pdf"));
    expect(pdfs).toHaveLength(3);
    for (const e of pdfs) {
      expect(e.data.slice(0, 5).toString()).toBe("%PDF-");
      expect(e.size).toBeGreaterThan(500);
    }
  });

  test("each entry is a COMPLETE standalone statement of one party", async () => {
    const { fx } = await seedThreeCustomers();
    const { entries } = await archive(fx);
    const named = entries.find((e) => e.name.startsWith("acme-exports"));
    expect(named).toBeTruthy();
    const text = named.data.toString("latin1");
    // pdfkit compresses page content, so assert on structure, not on glyphs.
    expect(text.slice(0, 5)).toBe("%PDF-");
    expect((text.match(/\/Type\s*\/Page[^s]/g) || []).length).toBe(1);
  });

  test("the manifest lists every party with its balances and its filename", async () => {
    const { fx } = await seedThreeCustomers();
    const { buf, entries } = await archive(fx, "&from=2026-05-01&to=2026-05-31");
    const rows = parseCsv(zipMap(buf)["manifest.csv"].toString("utf8"));
    expect(rows[0]).toEqual([
      "Company",
      "Party Code",
      "Party Name",
      "GSTIN",
      "Period",
      "Opening Balance",
      "Opening Dr/Cr",
      "Closing Balance",
      "Closing Dr/Cr",
      "Debit",
      "Credit",
      "Transactions",
      "Filename",
    ]);
    expect(rows).toHaveLength(4);

    const acme = rows.find((r) => r[2] === "Acme Exports");
    expect(acme[0]).toBe("Alpha Traders");
    expect(acme[3]).toBe("24AAAAA0000A1Z5");
    expect(acme[4]).toBe("2026-05-01 to 2026-05-31");
    expect(acme[5]).toBe("5000");
    expect(acme[6]).toBe("Dr");
    expect(acme[7]).toBe("13000");
    expect(acme[8]).toBe("Dr");
    expect(acme[9]).toBe("12000");
    expect(acme[10]).toBe("4000");
    expect(acme[11]).toBe("2");

    // Every filename in the manifest is an entry that actually exists.
    const names = new Set(entries.map((e) => e.name));
    for (const r of rows.slice(1)) expect(names.has(r[12])).toBe(true);
  });

  test("TWO PARTIES WITH THE SAME NAME GET TWO FILES, not one overwritten", async () => {
    /* Ledger names are unique per company, so the collision is not two
       identical names — it is three DIFFERENT ones that slug to the same
       filename, which is far easier to hit in real data than a duplicate.
       Without the collision rule the later entries overwrite the first and a
       pack of 3 statements arrives as 1. */
    const fx = await seedCompany("Dup Ltd");
    const one = await makeCustomer(fx, "Acme Exports");
    const two = await makeCustomer(fx, "ACME EXPORTS");
    const three = await makeCustomer(fx, "Acme & Exports");
    await postVoucher(fx, one, { amount: 100 });
    await postVoucher(fx, two, { amount: 200 });
    await postVoucher(fx, three, { amount: 300 });

    const { buf, entries } = await archive(fx);
    const pdfs = entries.filter((e) => e.name.endsWith(".pdf"));
    expect(pdfs).toHaveLength(3);
    expect(new Set(pdfs.map((e) => e.name)).size).toBe(3);

    // The manifest's filenames are distinct too, and match the entries.
    const rows = parseCsv(zipMap(buf)["manifest.csv"].toString("utf8")).slice(1);
    expect(new Set(rows.map((r) => r[12])).size).toBe(3);
    expect(rows.map((r) => r[12]).sort()).toEqual(pdfs.map((e) => e.name).sort());
    // The repeats carry their own party code, so which is which is readable.
    expect(rows.filter((r) => r[12].includes(r[1].toLowerCase()))).toHaveLength(2);
  });

  test("an empty filtered scope produces a ZIP with a manifest and no statements", async () => {
    const { fx } = await seedThreeCustomers();
    const { buf, entries } = await archive(fx, "&scope=filtered&ledgerIds=");
    expect(entries.map((e) => e.name)).toEqual(["manifest.csv"]);
    expect(parseCsv(zipMap(buf)["manifest.csv"].toString("utf8"))).toHaveLength(1);
  });

  test("the archive's own filename names the company and the period", async () => {
    const { fx } = await seedThreeCustomers();
    const { res } = await archive(fx, "&asOf=2026-05-31");
    expect(res.headers.get("content-disposition")).toContain(
      "alpha-traders-customer-statements-as-on-2026-05-31.zip",
    );
  });
});

/* ── Formats, limits, and writing nothing ────────────────────────────────── */

describe("request validation", () => {
  test("an unknown format is refused rather than defaulted", async () => {
    const { fx } = await seedThreeCustomers();
    const r = await call(packUrl(fx.company._id, "&format=docx"), {
      user: orgFor(fx.company),
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/xlsx.*pdf.*zip/i);
  });

  test('format=zip is refused on the endpoints that cannot produce one', async () => {
    /* The narrowing exists so an endpoint cannot hand back a spreadsheet under
       a .zip name. */
    const { fx } = await seedThreeCustomers();
    const r = await call(
      `/reports/outstanding?companyId=${fx.company._id}&format=zip`,
      { user: orgFor(fx.company) },
    );
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/format must be/i);
  });

  test("an id list longer than the cap is refused before any statement is built", async () => {
    const { fx } = await seedThreeCustomers();
    const tooMany = Array.from({ length: 2001 }, () => new mongoose.Types.ObjectId().toString());
    const r = await call(packUrl(fx.company._id), {
      user: orgFor(fx.company),
      method: "POST",
      body: { scope: "selected", ledgerIds: tooMany },
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/At most 2000 ledgers/i);
  });

  test("GENERATING A PACK IN EVERY FORMAT WRITES NOTHING", async () => {
    const { fx, acme, bharat, zeta } = await seedThreeCustomers();
    const user = orgFor(fx.company);
    const snapshot = async () => ({
      vouchers: await Acc_Voucher.countDocuments({}),
      ledgers: await Acc_Ledger.countDocuments({}),
      companies: await Acc_Company.countDocuments({}),
      stamps: await Promise.all(
        [acme, bharat, zeta].map(async (l) => {
          const d = await Acc_Ledger.findById(l._id).lean();
          return `${d.updatedAt}|${d.openingBalance}|${d.openingBalanceType}`;
        }),
      ),
      voucherStamps: (await Acc_Voucher.find({ companyId: fx.company._id }).lean())
        .map((v) => `${v._id}|${v.status}|${v.updatedAt}`)
        .sort(),
    });

    const before = await snapshot();
    for (const f of ["json", "xlsx", "pdf", "zip"]) {
      const res = await call(packUrl(fx.company._id, `&format=${f}`), { user, raw: true });
      expect(res.status).toBe(200);
      await res.arrayBuffer();
    }
    expect(await snapshot()).toEqual(before);
  });
});
