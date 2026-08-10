// test/crm/account.model.test.js — Account model business rules.
"use strict";

const Account = require("../../models/CMS_Models/Sales/Account");

describe("CRMAccount model", () => {
  test("creates with minimum valid data (companyName only)", async () => {
    const a = await Account.create({ companyName: "MetroCare Hospitals" });
    expect(a.companyName).toBe("MetroCare Hospitals");
    expect(a.isActive).toBe(true);
    expect(a.status).toBe("active");
  });

  test("rejects missing required companyName", async () => {
    await expect(Account.create({ legalName: "No Name Ltd" })).rejects.toThrow();
  });

  test("auto-generates a unique, sequential accountId", async () => {
    const a = await Account.create({ companyName: "Alpha" });
    const b = await Account.create({ companyName: "Bravo" });
    expect(a.accountId).toBe("ACC-0001");
    expect(b.accountId).toBe("ACC-0002");
  });

  test("derives normalizedName and defaults displayName from (trimmed) companyName", async () => {
    const a = await Account.create({ companyName: "  Harbor & Field  " });
    expect(a.normalizedName).toBe("harbor field");
    // companyName has schema trim, so displayName defaults to the trimmed value.
    expect(a.displayName).toBe("Harbor & Field");
  });

  test("accepts the spec's extended statuses (prospect, on_hold, dormant, archived)", async () => {
    for (const status of ["prospect", "on_hold", "dormant", "archived"]) {
      const a = await Account.create({ companyName: `Co-${status}`, status });
      expect(a.status).toBe(status);
    }
  });

  test("carries multiple roles and de-duplicates them", async () => {
    const a = await Account.create({
      companyName: "Dual Role Co",
      roles: ["direct_brand", "uniform_client", "direct_brand"],
    });
    expect(a.roles.sort()).toEqual(["direct_brand", "uniform_client"]);
  });

  test("cleans unknown role codes rather than rejecting the whole save", async () => {
    const a = await Account.create({ companyName: "Clean Co", roles: ["buying_house", "not_a_real_role"] });
    expect(a.roles).toEqual(["buying_house"]);
  });

  test("treats an empty-string customerTier/size (an untouched form dropdown) as not-set, not a validation error", async () => {
    const a = await Account.create({ companyName: "Blank Optionals Co", customerTier: "", size: "" });
    expect(a.customerTier).toBeUndefined();
    expect(a.size).toBeUndefined();
  });

  test("findByIdAndUpdate also treats an empty-string customerTier/size as a clear, not an error", async () => {
    const a = await Account.create({ companyName: "Has Tier Co", customerTier: "key", size: "51-200" });
    const updated = await Account.findByIdAndUpdate(a._id, { customerTier: "", size: "" }, { new: true });
    expect(updated.customerTier).toBeUndefined();
    expect(updated.size).toBeUndefined();
  });

  test("findByIdAndUpdate keeps normalizedName in step", async () => {
    const a = await Account.create({ companyName: "Old Name" });
    const updated = await Account.findByIdAndUpdate(a._id, { companyName: "New Name Co" }, { new: true });
    expect(updated.normalizedName).toBe("new name co");
  });
});
