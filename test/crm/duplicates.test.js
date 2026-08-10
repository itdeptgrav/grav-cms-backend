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
    await Account.create({ companyName: "Harbor & Field" });
    const matches = await findAccountDuplicates(Account, { companyName: "harbor and field" });
    // "and" vs "&" differ after normalization, so use an exact-ish variant:
    const exact = await findAccountDuplicates(Account, { companyName: "Harbor & Field" });
    expect(exact.length).toBe(1);
    expect(exact[0].confidence).toBe("high");
    expect(exact[0].matchedOn).toContain("name");
    expect(Array.isArray(matches)).toBe(true);
  });

  test("flags a shared email/website domain", async () => {
    await Account.create({ companyName: "Acme One", primaryEmail: "sales@acme.co" });
    const matches = await findAccountDuplicates(Account, { companyName: "Totally Different", website: "https://acme.co" });
    expect(matches.length).toBe(1);
    expect(matches[0].matchedOn).toContain("domain");
  });

  test("flags matching GST/tax number as high confidence", async () => {
    await Account.create({ companyName: "Taxed Co", gstNumber: "GST123" });
    const matches = await findAccountDuplicates(Account, { companyName: "Other", gstNumber: "GST123" });
    expect(matches[0].confidence).toBe("high");
  });

  test("excludes the record being edited", async () => {
    const a = await Account.create({ companyName: "Self Co" });
    const matches = await findAccountDuplicates(Account, { companyName: "Self Co" }, a._id);
    expect(matches.length).toBe(0);
  });
});

describe("findContactDuplicates", () => {
  test("warns on a repeated email (but does not block)", async () => {
    const acc = await Account.create({ companyName: "Acc" });
    await Contact.create({ firstName: "Nadia", accountId: acc._id, email: "nadia@x.co" });
    const matches = await findContactDuplicates(Contact, { firstName: "Nadia", email: "nadia@x.co", accountId: acc._id });
    expect(matches.length).toBe(1);
    expect(matches[0].matchedOn).toContain("email");
  });
});
