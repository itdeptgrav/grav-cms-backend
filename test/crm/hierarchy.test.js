// test/crm/hierarchy.test.js — parent/child cycle safety for accounts & sites.
"use strict";

const Account = require("../../models/CMS_Models/Sales/Account");
const Site = require("../../models/CMS_Models/Sales/Site");
const {
  assertNoAccountCycle,
  assertNoSiteCycle,
  HierarchyError,
} = require("../../services/crmHierarchy");

describe("account hierarchy", () => {
  test("rejects self-parenting", async () => {
    const a = await Account.create({ companyName: "Solo" });
    await expect(assertNoAccountCycle(Account, a._id, a._id)).rejects.toThrow(HierarchyError);
  });

  test("rejects a direct cycle (A→B then B→A)", async () => {
    const a = await Account.create({ companyName: "A" });
    const b = await Account.create({ companyName: "B", parentAccountId: a._id });
    // Now try to make A a child of B — that closes the loop.
    await expect(assertNoAccountCycle(Account, a._id, b._id)).rejects.toThrow(HierarchyError);
  });

  test("rejects an indirect cycle (A→B→C then A under C)", async () => {
    const a = await Account.create({ companyName: "A" });
    const b = await Account.create({ companyName: "B", parentAccountId: a._id });
    const c = await Account.create({ companyName: "C", parentAccountId: b._id });
    await expect(assertNoAccountCycle(Account, a._id, c._id)).rejects.toThrow(HierarchyError);
  });

  test("allows a legitimate new parent", async () => {
    const parent = await Account.create({ companyName: "Parent" });
    const child = await Account.create({ companyName: "Child" });
    await expect(assertNoAccountCycle(Account, child._id, parent._id)).resolves.toBeUndefined();
  });

  test("allows detaching (null parent)", async () => {
    const a = await Account.create({ companyName: "A" });
    await expect(assertNoAccountCycle(Account, a._id, null)).resolves.toBeUndefined();
  });
});

describe("site hierarchy", () => {
  test("rejects a site cycle", async () => {
    const acc = await Account.create({ companyName: "Acc" });
    const s1 = await Site.create({ accountId: acc._id, name: "HO" });
    const s2 = await Site.create({ accountId: acc._id, name: "Branch", parentSiteId: s1._id });
    await expect(assertNoSiteCycle(Site, s1._id, s2._id)).rejects.toThrow(HierarchyError);
  });
});
