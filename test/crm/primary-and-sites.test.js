// test/crm/primary-and-sites.test.js — single-primary enforcement, site code
// uniqueness, contact rules.
"use strict";

const Account = require("../../models/CMS_Models/Sales/Account");
const Site = require("../../models/CMS_Models/Sales/Site");
const Address = require("../../models/CMS_Models/Sales/Address");
const Contact = require("../../models/CMS_Models/Sales/Contact");
const { makeSolePrimary, ensureGroupHasPrimary } = require("../../services/crmPrimary");

beforeAll(async () => {
  await Site.syncIndexes(); // partial-unique (accountId, siteCode)
});

describe("single primary enforcement", () => {
  test("makeSolePrimary demotes every other primary in the group", async () => {
    const acc = await Account.create({ companyName: "Acc" });
    const s1 = await Site.create({ accountId: acc._id, name: "HO", isPrimary: true });
    const s2 = await Site.create({ accountId: acc._id, name: "Branch", isPrimary: true });
    await makeSolePrimary(Site, { accountId: acc._id, isActive: true }, s2._id);
    const primaries = await Site.find({ accountId: acc._id, isPrimary: true });
    expect(primaries).toHaveLength(1);
    expect(String(primaries[0]._id)).toBe(String(s2._id));
  });

  test("ensureGroupHasPrimary promotes the first member only", async () => {
    const acc = await Account.create({ companyName: "Acc2" });
    const s1 = await Site.create({ accountId: acc._id, name: "First" });
    const promoted1 = await ensureGroupHasPrimary(Site, { accountId: acc._id, isActive: true }, s1._id);
    expect(promoted1).toBe(true);
    const s2 = await Site.create({ accountId: acc._id, name: "Second" });
    const promoted2 = await ensureGroupHasPrimary(Site, { accountId: acc._id, isActive: true }, s2._id);
    expect(promoted2).toBe(false);
  });

  test("addresses have one primary per (account, type)", async () => {
    const acc = await Account.create({ companyName: "Acc3" });
    const billing = await Address.create({ accountId: acc._id, addressType: "billing", isPrimaryForType: true });
    const shipping = await Address.create({ accountId: acc._id, addressType: "shipping", isPrimaryForType: true });
    await makeSolePrimary(Address, { accountId: acc._id, addressType: "billing", isActive: true }, billing._id, "isPrimaryForType");
    // Setting the billing primary must NOT touch the shipping primary.
    const shipStill = await Address.findById(shipping._id);
    expect(shipStill.isPrimaryForType).toBe(true);
  });
});

describe("site code uniqueness within an account", () => {
  test("rejects a duplicate siteCode on the same account", async () => {
    const acc = await Account.create({ companyName: "Acc4" });
    await Site.create({ accountId: acc._id, name: "One", siteCode: "H1" });
    await expect(Site.create({ accountId: acc._id, name: "Two", siteCode: "H1" })).rejects.toThrow();
  });

  test("allows the same siteCode on a different account", async () => {
    const a = await Account.create({ companyName: "A" });
    const b = await Account.create({ companyName: "B" });
    await Site.create({ accountId: a._id, name: "One", siteCode: "H1" });
    const ok = await Site.create({ accountId: b._id, name: "One", siteCode: "H1" });
    expect(ok._id).toBeDefined();
  });
});

describe("contact rules", () => {
  test("requires at least a first or last name", async () => {
    const acc = await Account.create({ companyName: "Acc5" });
    await expect(Contact.create({ accountId: acc._id, email: "x@y.co" })).rejects.toThrow();
  });

  test("accepts a last-name-only contact and derives normalizedName", async () => {
    const acc = await Account.create({ companyName: "Acc6" });
    const c = await Contact.create({ accountId: acc._id, lastName: "Rao" });
    expect(c.normalizedName).toBe("rao");
    expect(c.contactId).toMatch(/^CONT-\d{4}$/);
  });
});
