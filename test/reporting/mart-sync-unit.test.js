// test/reporting/mart-sync-unit.test.js
//
// THE TRANSFORMATIONS, WITHOUT A POSTGRES.
//
// Everything here is about what the sync turns a Mongo document INTO: the
// flattening of `ledgerEntries[]`, the money coercion, the tenant stamping, and
// — the one that is a security property rather than a correctness one — which
// fields are allowed anywhere near the mart at all.
//
// The database-facing half (transactions, reconciliation, the curated views,
// the read-only role) is in mart-sync-integration.test.js, which needs a real
// PostgreSQL.
//
// Mongo here is the in-memory server from test/setup.js. NO REAL ACCOUNTING
// RECORD IS READ OR WRITTEN BY ANY TEST IN THIS DIRECTORY.
"use strict";

const mongoose = require("mongoose");

const sync = require("../../services/reporting/martSync.service");
const {
  Acc_Company,
  Acc_Group,
  Acc_Ledger,
} = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");
const { Acc_Organization } = require("../../models/Accountant_model/Acc_OrgModels");

const oid = () => new mongoose.Types.ObjectId();

/* ═══════════════════════════════════════════════════════════════════════════
 * Flattening — the transformation the whole mart exists for
 * ══════════════════════════════════════════════════════════════════════════ */

describe("flattenVoucher", () => {
  const baseVoucher = (entries) => ({
    _id: oid(),
    companyId: oid(),
    voucherNumber: "S-1",
    voucherType: "sales",
    voucherDate: new Date("2026-05-04T00:00:00Z"),
    status: "posted",
    isLive: true,
    grandTotal: 1000,
    ledgerEntries: entries,
  });

  test("the grain is EXACTLY one row per ledgerEntries element", () => {
    const v = baseVoucher([
      { _id: oid(), ledgerName: "A", type: "Dr", amount: 600 },
      { _id: oid(), ledgerName: "B", type: "Dr", amount: 400 },
      { _id: oid(), ledgerName: "Sales", type: "Cr", amount: 1000 },
    ]);
    const { rows } = sync.flattenVoucher(v, { organizationId: "org1", syncedAt: "2026-06-01T00:00:00Z" });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.line_no)).toEqual([1, 2, 3]);
  });

  test("line_no is the ordinal POSITION, so it is stable and 1-based", () => {
    // Not a stored field — it is what makes (voucher_id, line_no) a grain key.
    const v = baseVoucher([
      { _id: oid(), ledgerName: "A", type: "Dr", amount: 1 },
      { _id: oid(), ledgerName: "B", type: "Cr", amount: 1 },
    ]);
    const { rows } = sync.flattenVoucher(v, { organizationId: "o", syncedAt: "t" });
    expect(rows[0].line_no).toBe(1);
    expect(rows[1].line_no).toBe(2);
  });

  test("a voucher with no lines produces no lines, and does not throw", () => {
    for (const entries of [[], undefined, null]) {
      const { rows } = sync.flattenVoucher(baseVoucher(entries), {
        organizationId: "o",
        syncedAt: "t",
      });
      expect(rows).toEqual([]);
    }
  });

  test("the subdocument _id becomes source_id — the idempotency key", () => {
    const lineId = oid();
    const v = baseVoucher([{ _id: lineId, ledgerName: "A", type: "Dr", amount: 5 }]);
    const { rows } = sync.flattenVoucher(v, { organizationId: "o", syncedAt: "t" });
    expect(rows[0].source_id).toBe(String(lineId));
  });

  test("a line with no _id still gets a DETERMINISTIC source_id", () => {
    /* Older documents predate `{ _id: true }` on the sub-schema. A random key
       would make every re-sync insert duplicates instead of replacing. */
    const v = baseVoucher([{ ledgerName: "A", type: "Dr", amount: 5 }]);
    const a = sync.flattenVoucher(v, { organizationId: "o", syncedAt: "t" }).rows[0];
    const b = sync.flattenVoucher(v, { organizationId: "o", syncedAt: "u" }).rows[0];
    expect(a.source_id).toBe(`${v._id}:1`);
    expect(b.source_id).toBe(a.source_id);
  });

  test("every row carries the tenant and the company", () => {
    const v = baseVoucher([{ _id: oid(), ledgerName: "A", type: "Dr", amount: 5 }]);
    const { rows } = sync.flattenVoucher(v, { organizationId: "ORG-7", syncedAt: "t" });
    expect(rows[0].organization_id).toBe("ORG-7");
    expect(rows[0].company_id).toBe(String(v.companyId));
  });

  test("voucher header attributes are denormalised onto every line", () => {
    const v = baseVoucher([
      { _id: oid(), ledgerName: "A", type: "Dr", amount: 5 },
      { _id: oid(), ledgerName: "B", type: "Cr", amount: 5 },
    ]);
    v.status = "cancelled";
    v.isLive = false;
    const { rows } = sync.flattenVoucher(v, { organizationId: "o", syncedAt: "t" });
    for (const r of rows) {
      expect(r.voucher_id).toBe(String(v._id));
      expect(r.voucher_number).toBe("S-1");
      expect(r.voucher_type).toBe("sales");
      expect(r.voucher_status).toBe("cancelled");
      expect(r.is_live).toBe(false);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Debit, credit and signed amount
 * ══════════════════════════════════════════════════════════════════════════ */

describe("debit / credit / signed_amount", () => {
  const one = (entry) =>
    sync.flattenVoucher(
      {
        _id: oid(),
        companyId: oid(),
        voucherType: "journal",
        voucherDate: new Date("2026-05-04T00:00:00Z"),
        status: "posted",
        ledgerEntries: [{ _id: oid(), ledgerName: "L", ...entry }],
      },
      { organizationId: "o", syncedAt: "t" },
    );

  test("a debit is +amount, with credit zero", () => {
    const { rows } = one({ type: "Dr", amount: 1234.56 });
    expect(rows[0]).toMatchObject({
      dr_cr: "Dr",
      amount: "1234.56",
      debit: "1234.56",
      credit: "0.00",
      signed_amount: "1234.56",
    });
  });

  test("a credit is −amount, with debit zero", () => {
    const { rows } = one({ type: "Cr", amount: 1234.56 });
    expect(rows[0]).toMatchObject({
      dr_cr: "Cr",
      amount: "1234.56",
      debit: "0.00",
      credit: "1234.56",
      signed_amount: "-1234.56",
    });
  });

  test("money is an exact 2-decimal STRING, never a float", () => {
    /* Handing the driver a JavaScript number would put an IEEE-754 double into
       a numeric column and re-introduce exactly the imprecision the column
       exists to escape. */
    const { rows } = one({ type: "Dr", amount: 0.1 + 0.2 });
    expect(typeof rows[0].amount).toBe("string");
    expect(rows[0].amount).toBe("0.30");
    expect(sync.money(145402590.99)).toBe("145402590.99");
    expect(sync.money(undefined)).toBe("0.00");
    expect(sync.money(null)).toBe("0.00");
    expect(sync.money(NaN)).toBe("0.00");
  });

  test("a negative amount on a Dr line is stored as a positive debit", () => {
    // The CHECK constraint requires amount >= 0; the side is carried by dr_cr.
    const { rows } = one({ type: "Dr", amount: -50 });
    expect(rows[0].amount).toBe("50.00");
    expect(rows[0].signed_amount).toBe("50.00");
  });

  test("THE STORED signedAmount DOES NOT OVERRIDE type + amount", () => {
    /* `signedAmount` is a cached derivative set in pre-save, and an imported
       voucher can bypass the hook. `type` and `amount` are what the accountant
       entered and what every other report reads, so a stale sign must not
       silently become the mart's version of the truth — it is corrected and
       REPORTED. */
    const { rows, signMismatches } = one({ type: "Cr", amount: 100, signedAmount: 100 });
    expect(rows[0].signed_amount).toBe("-100.00");
    expect(signMismatches).toHaveLength(1);
    expect(signMismatches[0]).toMatchObject({
      storedSignedAmount: 100,
      derivedSignedAmount: -100,
    });
  });

  test("an agreeing stored signedAmount raises nothing", () => {
    const { signMismatches } = one({ type: "Cr", amount: 100, signedAmount: -100 });
    expect(signMismatches).toEqual([]);
  });

  test("the three money columns always satisfy the table's CHECK", () => {
    // debit = amount, credit = 0, signed = +amount  (or the credit mirror)
    for (const [type, amount] of [["Dr", 10], ["Cr", 10], ["Dr", 0], ["Cr", 0.01]]) {
      const r = one({ type, amount }).rows[0];
      const ok =
        (r.dr_cr === "Dr" && r.debit === r.amount && r.credit === "0.00" &&
          Number(r.signed_amount) === Number(r.amount)) ||
        (r.dr_cr === "Cr" && r.credit === r.amount && r.debit === "0.00" &&
          Number(r.signed_amount) === -Number(r.amount));
      expect(ok).toBe(true);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Dates — the business timezone
 * ══════════════════════════════════════════════════════════════════════════ */

describe("dates are resolved in business time", () => {
  test("an IST-midnight voucher lands on the day the accountant sees", () => {
    /* 2025-08-03T18:30:00Z IS 4 August in Kolkata. Read in UTC it is the 3rd,
       and in this company 530 of 1,868 vouchers are stored this way — a UTC
       reading would misdate every one of them, and some across a month end. */
    expect(sync.businessDate(new Date("2025-08-03T18:30:00Z"))).toBe("2025-08-04");
    expect(sync.businessPeriodMonth(new Date("2025-08-31T18:30:00Z"))).toBe("2025-09-01");
  });

  test("a UTC-midnight voucher is unaffected", () => {
    expect(sync.businessDate(new Date("2025-08-08T00:00:00Z"))).toBe("2025-08-08");
    expect(sync.businessPeriodMonth(new Date("2025-08-08T00:00:00Z"))).toBe("2025-08-01");
  });

  test("a missing date is null, not today and not an epoch", () => {
    expect(sync.businessDate(null)).toBeNull();
    expect(sync.businessDate(undefined)).toBeNull();
    expect(sync.businessDate("not a date")).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Ownership materialisation
 * ══════════════════════════════════════════════════════════════════════════ */

describe("organization_id is materialised from tallyCompanyIds", () => {
  test("a company's rows carry its organisation", async () => {
    const company = await Acc_Company.create({
      companyName: "Alpha",
      booksFromDate: new Date("2025-04-01"),
    });
    const org = await Acc_Organization.create({
      name: "Org A",
      tallyCompanyIds: [company._id],
    });

    const mapping = await sync.resolveOwnership();
    expect(mapping.get(String(company._id))).toBe(String(org._id));
  });

  test("A COMPANY WITH NO OWNER IS REFUSED, not stamped with a blank", async () => {
    /* organization_id is the row-level-security key. A blank one is a row
       nobody can be shown; a guessed one is a cross-tenant leak. */
    const company = await Acc_Company.create({
      companyName: "Orphan",
      booksFromDate: new Date("2025-04-01"),
    });
    await Acc_Organization.create({ name: "Org A", tallyCompanyIds: [] });

    await expect(sync.resolveOwnership()).rejects.toMatchObject({
      code: "OWNERSHIP_MISSING",
      missing: [String(company._id)],
    });
  });

  test("A COMPANY CLAIMED BY TWO ORGANISATIONS IS REFUSED", async () => {
    const company = await Acc_Company.create({
      companyName: "Contested",
      booksFromDate: new Date("2025-04-01"),
    });
    const a = await Acc_Organization.create({ name: "Org A", tallyCompanyIds: [] });
    const b = await Acc_Organization.create({ name: "Org B", tallyCompanyIds: [] });
    const coll = mongoose.connection.db.collection("acc_organizations");

    /* The unique multikey index `acc_org_company_ownership_unique` normally
       makes this state impossible — it refuses the second write, which is the
       product working correctly and is asserted first. The index is then
       dropped for the length of this test, because the POINT is that the sync
       does not DEPEND on it: a database that predates the index, or one where
       it was built while a conflict already stood, still must not be stamped
       with a guessed tenant. */
    await coll.updateOne({ _id: a._id }, { $set: { tallyCompanyIds: [company._id] } });
    await expect(
      coll.updateOne({ _id: b._id }, { $set: { tallyCompanyIds: [company._id] } }),
    ).rejects.toMatchObject({ code: 11000 });

    await coll.dropIndex("acc_org_company_ownership_unique");
    try {
      await coll.updateOne({ _id: b._id }, { $set: { tallyCompanyIds: [company._id] } });

      await expect(sync.resolveOwnership()).rejects.toMatchObject({
        code: "OWNERSHIP_AMBIGUOUS",
      });

      const err = await sync.resolveOwnership().catch((e) => e);
      expect(err.ambiguous[0].companyId).toBe(String(company._id));
      expect(err.ambiguous[0].organizationIds.sort()).toEqual(
        [String(a._id), String(b._id)].sort(),
      );
    } finally {
      // Leave the collection as it was found, whatever happened above.
      await coll.updateOne({ _id: b._id }, { $set: { tallyCompanyIds: [] } });
      await Acc_Organization.syncIndexes().catch(() => {});
    }
  });

  test("the refusal names the companies, so it can be acted on", async () => {
    await Acc_Company.create({ companyName: "One", booksFromDate: new Date("2025-04-01") });
    await Acc_Company.create({ companyName: "Two", booksFromDate: new Date("2025-04-01") });
    const err = await sync.resolveOwnership().catch((e) => e);
    expect(err.code).toBe("OWNERSHIP_MISSING");
    expect(err.missing).toHaveLength(2);
    expect(err.message).toMatch(/accounting-organization-company-repair/);
  });

  test("one organisation with several companies maps each of them", async () => {
    const a = await Acc_Company.create({ companyName: "A", booksFromDate: new Date("2025-04-01") });
    const b = await Acc_Company.create({ companyName: "B", booksFromDate: new Date("2025-04-01") });
    const org = await Acc_Organization.create({
      name: "Org",
      tallyCompanyIds: [a._id, b._id],
    });
    const mapping = await sync.resolveOwnership();
    expect(mapping.get(String(a._id))).toBe(String(org._id));
    expect(mapping.get(String(b._id))).toBe(String(org._id));
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Sensitive fields
 * ══════════════════════════════════════════════════════════════════════════ */

describe("sensitive fields never reach the mart", () => {
  /**
   * A ledger and a voucher stuffed with everything the decision doc classifies
   * as excluded. If a projection ever widens, these values appear in the built
   * rows and the assertions below fail.
   */
  async function seedSensitive() {
    const company = await Acc_Company.create({
      companyName: "Sensitive Co",
      booksFromDate: new Date("2025-04-01"),
      gstin: "27AAAAA0000A1Z5",
      pan: "SECRETPAN01",
      tan: "SECRETTAN01",
      cin: "SECRETCIN01",
      contact: { email: "secret@example.com", phone: "9999999999" },
    });
    const group = await Acc_Group.create({
      companyId: company._id,
      name: "Sundry Debtors",
      nature: "asset",
    });
    const ledger = await Acc_Ledger.create({
      companyId: company._id,
      name: "Acme",
      groupId: group._id,
      groupName: group.name,
      nature: "asset",
      gstin: "27BBBBB1111B1Z4",
      panNumber: "SECRETLEDGERPAN",
      bankDetails: {
        accountNumber: "1234567890SECRET",
        ifsc: "SECRETIFSC01",
        bankName: "Secret Bank",
      },
      contactDetails: { email: "ledger-secret@example.com", phone: "8888888888" },
    });
    const voucher = await Acc_Voucher.create({
      companyId: company._id,
      voucherType: "sales",
      voucherNumber: "S-1",
      voucherDate: new Date("2026-05-04"),
      status: "posted",
      grandTotal: 100,
      ledgerEntries: [
        { ledgerId: ledger._id, ledgerName: "Acme", type: "Dr", amount: 100 },
        { ledgerId: ledger._id, ledgerName: "Sales", type: "Cr", amount: 100 },
      ],
      attachments: [{ url: "https://drive.example/SECRET-ATTACHMENT", name: "secret.pdf" }],
    });
    return { company, group, ledger, voucher };
  }

  /** What the sync would actually write, read back through its own projections. */
  async function builtRows(company) {
    const [groups, ledgers, vouchers] = await Promise.all([
      Acc_Group.find({ companyId: company._id }).select(sync.GROUP_FIELDS).lean(),
      Acc_Ledger.find({ companyId: company._id }).select(sync.LEDGER_FIELDS).lean(),
      Acc_Voucher.find({ companyId: company._id }).select(sync.VOUCHER_FIELDS).lean(),
    ]);
    const c = await Acc_Company.findById(company._id).select(sync.COMPANY_FIELDS).lean();
    return sync.buildCompanyRows({
      company: c,
      groups,
      ledgers,
      vouchers,
      organizationId: "org-1",
      syncedAt: "2026-06-01T00:00:00Z",
    });
  }

  const SECRETS = [
    "SECRETPAN01",
    "SECRETTAN01",
    "SECRETCIN01",
    "SECRETLEDGERPAN",
    "1234567890SECRET",
    "SECRETIFSC01",
    "SECRET-ATTACHMENT",
    "secret@example.com",
    "ledger-secret@example.com",
    "9999999999",
    "8888888888",
  ];

  test("not one excluded value appears anywhere in the built rows", async () => {
    const { company } = await seedSensitive();
    const built = await builtRows(company);
    const serialised = JSON.stringify(built);
    for (const secret of SECRETS) {
      expect(serialised).not.toContain(secret);
    }
  });

  test("the projections themselves name no excluded field", () => {
    /* The projection is the enforcement. Asserting on it as well as on the
       output catches a widening that this fixture happens not to exercise. */
    const all = [
      sync.COMPANY_FIELDS,
      sync.GROUP_FIELDS,
      sync.LEDGER_FIELDS,
      sync.VOUCHER_FIELDS,
    ].join(" ");
    for (const forbidden of [
      "bankDetails", "panNumber", "pan ", "tan", "cin", "contactDetails",
      "contact.", "attachments", "signatures", "passwordHash", "fcmTokens",
      "token", "billAllocations", "costCentreAllocations",
    ]) {
      expect(all).not.toContain(forbidden);
    }
  });

  test("what IS carried is what reporting needs, and it is still there", async () => {
    // A negative test alone would pass on a sync that copied nothing at all.
    const { company, ledger } = await seedSensitive();
    const built = await builtRows(company);
    expect(built.companyRow.company_name).toBe("Sensitive Co");
    expect(built.companyRow.gstin).toBe("27AAAAA0000A1Z5"); // restricted-but-needed
    expect(built.ledgerRows[0].ledger_name).toBe("Acme");
    expect(built.ledgerRows[0].gstin).toBe("27BBBBB1111B1Z4");
    expect(built.ledgerRows[0].ledger_id).toBe(String(ledger._id));
    expect(built.lineRows).toHaveLength(2);
    expect(built.lineRows[0].debit).toBe("100.00");
  });
});
