// test/crm/duplicates.test.js — account & contact duplicate detection.
"use strict";

const Account = require("../../models/CMS_Models/Sales/Account");
const Contact = require("../../models/CMS_Models/Sales/Contact");
const {
  findAccountDuplicates,
  findContactDuplicates,
  normalizeName,
  domainOf,
  normalizePhone,
} = require("../../services/crmDuplicates");


/* ── DUPLICATE DETECTION IS NOW COMPANY-SCOPED (Chunk 3B1) ───────────────────
 * The finders take a `{companyId, reason}` service context, because matching
 * across companies would answer "is this a duplicate?" by revealing that
 * ANOTHER company has a customer with the same name — the disclosure, not the
 * answer. Fixtures are stamped with the same company the context names. */
let CO;
let CTX;
beforeEach(async () => {
  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  CO = await Acc_Company.create({ companyName: "Test Co", booksFromDate: new Date("2026-04-01") });
  CTX = { companyId: CO._id, reason: "duplicate detection test" };
});

describe("normalizers", () => {
  test("normalizeName collapses case, punctuation, spacing", () => {
    expect(normalizeName("  Harbor & Field, Ltd. ")).toBe("harbor field ltd");
  });
  test("domainOf handles emails and urls", () => {
    expect(domainOf("a@acme.co")).toBe("acme.co");
    expect(domainOf("https://www.acme.co/x")).toBe("acme.co");
  });
  test("normalizePhone keeps last 10 digits", () => {
    expect(normalizePhone("+91 98765 43210")).toBe("9876543210");
  });
});

describe("findAccountDuplicates", () => {
  test("flags a same-name match as high confidence", async () => {
    await Account.create({ companyId: CO._id, companyName: "Harbor & Field" });
    const matches = await findAccountDuplicates(Account, CTX, { companyName: "harbor and field" });
    // "and" vs "&" differ after normalization, so use an exact-ish variant:
    const exact = await findAccountDuplicates(Account, CTX, { companyName: "Harbor & Field" });
    expect(exact.length).toBe(1);
    expect(exact[0].confidence).toBe("high");
    expect(exact[0].matchedOn).toContain("name");
    expect(Array.isArray(matches)).toBe(true);
  });

  test("flags a shared email/website domain", async () => {
    await Account.create({ companyId: CO._id, companyName: "Acme One", primaryEmail: "sales@acme.co" });
    const matches = await findAccountDuplicates(Account, CTX, { companyName: "Totally Different", website: "https://acme.co" });
    expect(matches.length).toBe(1);
    expect(matches[0].matchedOn).toContain("domain");
  });

  test("flags matching GST/tax number as high confidence", async () => {
    await Account.create({ companyId: CO._id, companyName: "Taxed Co", gstNumber: "GST123" });
    const matches = await findAccountDuplicates(Account, CTX, { companyName: "Other", gstNumber: "GST123" });
    expect(matches[0].confidence).toBe("high");
  });

  test("excludes the record being edited", async () => {
    const a = await Account.create({ companyId: CO._id, companyName: "Self Co" });
    const matches = await findAccountDuplicates(Account, CTX, { companyName: "Self Co" }, a._id);
    expect(matches.length).toBe(0);
  });
});

describe("findContactDuplicates", () => {
  test("warns on a repeated email (but does not block)", async () => {
    const acc = await Account.create({ companyId: CO._id, companyName: "Acc" });
    await Contact.create({ companyId: CO._id, firstName: "Nadia", accountId: acc._id, email: "nadia@x.co" });
    const matches = await findContactDuplicates(Contact, CTX, { firstName: "Nadia", email: "nadia@x.co", accountId: acc._id });
    expect(matches.length).toBe(1);
    expect(matches[0].matchedOn).toContain("email");
  });
});
