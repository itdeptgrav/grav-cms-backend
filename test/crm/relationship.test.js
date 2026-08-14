// test/crm/relationship.test.js — typed account relationships.
"use strict";

const mongoose = require("mongoose");
const Account = require("../../models/CMS_Models/Sales/Account");
const Relationship = require("../../models/CMS_Models/Sales/AccountRelationship");
const { relationshipLabelFrom } = require("../../constants/crm");

beforeAll(async () => {
  // The exact-duplicate guard relies on a partial-unique index; build it.
  await Relationship.syncIndexes();
});

describe("account relationships", () => {
  test("rejects a self-link", async () => {
    const a = await Account.create({ companyName: "A" });
    await expect(
      Relationship.create({ fromAccountId: a._id, toAccountId: a._id, relationshipType: "related_company" }),
    ).rejects.toThrow();
  });

  test("rejects an exact active duplicate edge", async () => {
    const a = await Account.create({ companyName: "House" });
    const b = await Account.create({ companyName: "Brand" });
    await Relationship.create({ fromAccountId: a._id, toAccountId: b._id, relationshipType: "buying_house_for" });
    await expect(
      Relationship.create({ fromAccountId: a._id, toAccountId: b._id, relationshipType: "buying_house_for" }),
    ).rejects.toThrow();
  });

  test("allows the reverse-direction edge (not a duplicate)", async () => {
    const a = await Account.create({ companyName: "House" });
    const b = await Account.create({ companyName: "Brand" });
    await Relationship.create({ fromAccountId: a._id, toAccountId: b._id, relationshipType: "buying_house_for" });
    const reverse = await Relationship.create({ fromAccountId: b._id, toAccountId: a._id, relationshipType: "buys_for" });
    expect(reverse._id).toBeDefined();
  });

  test("renders the correct label from each account's perspective", async () => {
    const house = new mongoose.Types.ObjectId();
    const brand = new mongoose.Types.ObjectId();
    const rel = { fromAccountId: house, toAccountId: brand, relationshipType: "buying_house_for" };
    const fromHouse = relationshipLabelFrom(rel, house);
    const fromBrand = relationshipLabelFrom(rel, brand);
    expect(fromHouse.label).toBe("Buying House For");
    expect(fromBrand.label).toBe("Represented By Buying House");
    expect(String(fromHouse.otherAccountId)).toBe(String(brand));
    expect(String(fromBrand.otherAccountId)).toBe(String(house));
  });
});
