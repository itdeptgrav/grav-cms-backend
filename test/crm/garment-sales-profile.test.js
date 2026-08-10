// test/crm/garment-sales-profile.test.js — spec §7.2A Garment Sales Profile:
// business/product, compliance, buying-house/brand, and uniform-customer
// sub-profiles, plus their cross-field rules and party-reference checks.
"use strict";

const Account = require("../../models/CMS_Models/Sales/Account");
const { assertValidGarmentProfileRefs, GarmentProfileError } = require("../../services/crmGarmentProfile");
const { stripRestrictedAccountFields } = require("../../services/crmVisibility");

describe("Garment Sales Profile", () => {
  test("saves and round-trips a full profile across all four sub-sections", async () => {
    const a = await Account.create({
      companyName: "Harbor & Field",
      garmentSalesProfile: {
        businessModels: ["export_brand", "full_package_fob"],
        productCategories: ["shirts", "knitwear"],
        estimatedAnnualPieces: 500000,
        typicalOrderQuantityMin: 1000,
        typicalOrderQuantityMax: 20000,
        targetPriceBandMin: 4.5,
        targetPriceBandMax: 8,
        targetPriceCurrency: "USD",
        orderFrequency: "seasonal",
        customerPotential: "high",
        requiredCertifications: ["bsci", "gots"],
        defaultAqlLevel: "2.5",
        vendorCode: "HF-2201",
        preferredFreightMode: "sea",
        estimatedWearerCount: 0,
        orderingModel: "centralized",
      },
    });
    const found = await Account.findById(a._id).lean();
    expect(found.garmentSalesProfile.businessModels).toEqual(["export_brand", "full_package_fob"]);
    expect(found.garmentSalesProfile.targetPriceCurrency).toBe("USD");
    expect(found.garmentSalesProfile.requiredCertifications).toEqual(["bsci", "gots"]);
    expect(found.garmentSalesProfile.vendorCode).toBe("HF-2201");
    expect(found.garmentSalesProfile.orderingModel).toBe("centralized");
  });

  test("rejects an invalid lookup code in a controlled multi-select", async () => {
    await expect(
      Account.create({
        companyName: "Bad Codes Co",
        garmentSalesProfile: { businessModels: ["not_a_real_model"] },
      }),
    ).rejects.toThrow();
  });

  test("rejects negative quantities and lead times", async () => {
    await expect(
      Account.create({ companyName: "Neg Qty Co", garmentSalesProfile: { estimatedAnnualPieces: -10 } }),
    ).rejects.toThrow();
    await expect(
      Account.create({ companyName: "Neg Lead Co", garmentSalesProfile: { expectedDevelopmentLeadDays: -5 } }),
    ).rejects.toThrow();
    await expect(
      Account.create({ companyName: "Neg Wearer Co", garmentSalesProfile: { estimatedWearerCount: -1 } }),
    ).rejects.toThrow();
  });

  test("rejects a reversed typical-order-quantity range", async () => {
    await expect(
      Account.create({
        companyName: "Reversed Range Co",
        garmentSalesProfile: { typicalOrderQuantityMin: 5000, typicalOrderQuantityMax: 1000 },
      }),
    ).rejects.toThrow(/typicalOrderQuantityMin cannot exceed/);
  });

  test("rejects a reversed target-price band", async () => {
    await expect(
      Account.create({
        companyName: "Reversed Price Co",
        garmentSalesProfile: { targetPriceBandMin: 10, targetPriceBandMax: 5, targetPriceCurrency: "USD" },
      }),
    ).rejects.toThrow(/targetPriceBandMin cannot exceed/);
  });

  test("requires a currency when a target price band is set", async () => {
    await expect(
      Account.create({
        companyName: "No Currency Co",
        garmentSalesProfile: { targetPriceBandMin: 5, targetPriceBandMax: 10 },
      }),
    ).rejects.toThrow(/targetPriceCurrency is required/);
  });

  test("treats an untouched dropdown's empty string as not-set, not a validation error", async () => {
    const a = await Account.create({
      companyName: "Blank Profile Optionals Co",
      garmentSalesProfile: { orderFrequency: "", customerPotential: "", defaultPoIssuerAccountId: "" },
    });
    expect(a.garmentSalesProfile.orderFrequency).toBeUndefined();
    expect(a.garmentSalesProfile.customerPotential).toBeUndefined();
    expect(a.garmentSalesProfile.defaultPoIssuerAccountId).toBeUndefined();
  });

  describe("assertValidGarmentProfileRefs", () => {
    test("passes when no party references are set", async () => {
      await expect(assertValidGarmentProfileRefs(Account, {})).resolves.toBeUndefined();
    });

    test("rejects a PO-issuer reference that does not exist", async () => {
      const fakeId = "507f1f77bcf86cd799439011";
      await expect(
        assertValidGarmentProfileRefs(Account, { defaultPoIssuerAccountId: fakeId }),
      ).rejects.toThrow(GarmentProfileError);
    });

    test("rejects an agent reference that is archived (inactive)", async () => {
      const archived = await Account.create({ companyName: "Archived Agent Co", isActive: false });
      await expect(
        assertValidGarmentProfileRefs(Account, { defaultAgentAccountId: String(archived._id) }),
      ).rejects.toThrow(/archived/);
    });

    test("accepts a valid active nominated-laboratory/supplier reference", async () => {
      const lab = await Account.create({ companyName: "Acme Testing Lab" });
      const supplier = await Account.create({ companyName: "Acme Fabric Mill" });
      await expect(
        assertValidGarmentProfileRefs(Account, {
          nominatedLaboratoryAccountIds: [String(lab._id)],
          nominatedSupplierAccountIds: [String(supplier._id)],
        }),
      ).resolves.toBeUndefined();
    });

    test("rejects when only one of several nominated suppliers is invalid", async () => {
      const supplier = await Account.create({ companyName: "Real Supplier Co" });
      const fakeId = "507f1f77bcf86cd799439099";
      await expect(
        assertValidGarmentProfileRefs(Account, {
          nominatedSupplierAccountIds: [String(supplier._id), fakeId],
        }),
      ).rejects.toThrow(GarmentProfileError);
    });
  });

  test("hides the commission reference from an unauthorized user but keeps other profile fields", () => {
    const account = {
      companyName: "Commission Co",
      garmentSalesProfile: { defaultCommissionRef: "5% to Northstar", vendorCode: "VC-1" },
    };
    const stripped = stripRestrictedAccountFields(account, { role: "sales" });
    expect(stripped.garmentSalesProfile.defaultCommissionRef).toBeUndefined();
    expect(stripped.garmentSalesProfile.vendorCode).toBe("VC-1");
    // Original object must not be mutated by the strip.
    expect(account.garmentSalesProfile.defaultCommissionRef).toBe("5% to Northstar");
  });

  test("keeps the commission reference visible to an authorized (admin) user", () => {
    const account = { garmentSalesProfile: { defaultCommissionRef: "5% to Northstar" } };
    const stripped = stripRestrictedAccountFields(account, { role: "admin" });
    expect(stripped.garmentSalesProfile.defaultCommissionRef).toBe("5% to Northstar");
  });
});
