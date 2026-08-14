// test/crm/audit-history.test.js — an account's audit tab must surface both
// its own field changes AND changes to its sub-records (contacts, sites,
// relationships...), since those log rows carry the SUB-RECORD's id as
// entityId, not the parent account's — see services/changeLog.js.
"use strict";

const Account = require("../../models/CMS_Models/Sales/Account");
const Contact = require("../../models/CMS_Models/Sales/Contact");
const AccountRelationship = require("../../models/CMS_Models/Sales/AccountRelationship");
const { recordChange, historyForWithChildren } = require("../../services/changeLog");

const CHILD_ENTITIES = ["crm-contact", "crm-site", "crm-account-relationship"];

describe("historyForWithChildren", () => {
  test("includes the account's own logged changes", async () => {
    const acc = await Account.create({ companyName: "Audited Co" });
    await recordChange({}, { entity: "crm-account", entityId: acc._id, action: "create", after: acc.toObject() });

    const rows = await historyForWithChildren("crm-account", acc._id, CHILD_ENTITIES, ["accountId", "fromAccountId", "toAccountId"]);
    expect(rows.some((r) => r.entity === "crm-account")).toBe(true);
  });

  test("includes a contact's logged change (accountId key)", async () => {
    const acc = await Account.create({ companyName: "Parent Co" });
    const contact = await Contact.create({ accountId: acc._id, firstName: "Ana" });
    await recordChange({}, { entity: "crm-contact", entityId: contact._id, action: "create", after: contact.toObject() });

    const rows = await historyForWithChildren("crm-account", acc._id, CHILD_ENTITIES, ["accountId", "fromAccountId", "toAccountId"]);
    expect(rows.some((r) => r.entity === "crm-contact")).toBe(true);
  });

  test("includes a relationship's logged change on BOTH sides (fromAccountId/toAccountId keys)", async () => {
    const a = await Account.create({ companyName: "Side A" });
    const b = await Account.create({ companyName: "Side B" });
    const rel = await AccountRelationship.create({ fromAccountId: a._id, toAccountId: b._id, relationshipType: "related_company" });
    await recordChange({}, { entity: "crm-account-relationship", entityId: rel._id, action: "create", after: rel.toObject() });

    const rowsA = await historyForWithChildren("crm-account", a._id, CHILD_ENTITIES, ["accountId", "fromAccountId", "toAccountId"]);
    const rowsB = await historyForWithChildren("crm-account", b._id, CHILD_ENTITIES, ["accountId", "fromAccountId", "toAccountId"]);
    expect(rowsA.some((r) => r.entity === "crm-account-relationship")).toBe(true);
    expect(rowsB.some((r) => r.entity === "crm-account-relationship")).toBe(true);
  });

  test("does NOT include another account's unrelated contact", async () => {
    const acc = await Account.create({ companyName: "Lonely Co" });
    const other = await Account.create({ companyName: "Other Co" });
    const otherContact = await Contact.create({ accountId: other._id, firstName: "Not Mine" });
    await recordChange({}, { entity: "crm-contact", entityId: otherContact._id, action: "create", after: otherContact.toObject() });

    const rows = await historyForWithChildren("crm-account", acc._id, CHILD_ENTITIES, ["accountId", "fromAccountId", "toAccountId"]);
    expect(rows.some((r) => r.entity === "crm-contact")).toBe(false);
  });
});
