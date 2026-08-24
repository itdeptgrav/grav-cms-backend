// test/crm/group-link.test.js — a "Parent Of" link IS the group spine.
//
// The rule under test: creating a parent_of / subsidiary_of relationship must
// set Account.parentAccountId, ending one must clear it, and neither may leave
// an account with two parents or a cycle. Before this, the relationship was a
// label with no structural effect, so a group entered through the only UI that
// offered it never appeared in the hierarchy at all.
"use strict";

const Account = require("../../models/CMS_Models/Sales/Account");
const {
  resolveGroupEdge,
  assertGroupEdgeApplicable,
  applyGroupLink,
  clearGroupLink,
  isHierarchyType,
} = require("../../services/crmGroupLink");
const { HierarchyError } = require("../../services/crmHierarchy");

const parentOf = (from, to) => ({ fromAccountId: from._id, toAccountId: to._id, relationshipType: "parent_of" });
const subsidiaryOf = (from, to) => ({ fromAccountId: from._id, toAccountId: to._id, relationshipType: "subsidiary_of" });
const parentIdOf = async (a) => {
  const doc = await Account.findById(a._id).select("parentAccountId").lean();
  return doc.parentAccountId ? String(doc.parentAccountId) : null;
};

describe("which types are group edges", () => {
  test("only the two ownership types are", () => {
    expect(isHierarchyType("parent_of")).toBe(true);
    expect(isHierarchyType("subsidiary_of")).toBe(true);
    // Commercial edges: an account can hold several at once, so none of them
    // can imply a single parent.
    for (const t of ["buying_house_for", "brand_owner_of", "billing_party_for", "agent_for", "related_company"]) {
      expect(isHierarchyType(t)).toBe(false);
    }
  });

  test("the two types put the child on opposite sides", async () => {
    const group = await Account.create({ companyName: "Mayfair Group" });
    const hotel = await Account.create({ companyName: "Mayfair Bhubaneswar" });
    expect(resolveGroupEdge(parentOf(group, hotel))).toEqual({
      childId: String(hotel._id), parentId: String(group._id),
    });
    expect(resolveGroupEdge(subsidiaryOf(hotel, group))).toEqual({
      childId: String(hotel._id), parentId: String(group._id),
    });
  });

  test("a commercial edge resolves to nothing", async () => {
    const a = await Account.create({ companyName: "A" });
    const b = await Account.create({ companyName: "B" });
    expect(resolveGroupEdge({ ...parentOf(a, b), relationshipType: "agent_for" })).toBeNull();
  });
});

describe("applying a group edge", () => {
  test("parent_of sets the child's parent", async () => {
    const group = await Account.create({ companyName: "Mayfair Group" });
    const hotel = await Account.create({ companyName: "Mayfair Bhubaneswar" });
    const rel = parentOf(group, hotel);
    await assertGroupEdgeApplicable(Account, rel);
    await applyGroupLink(Account, rel);
    expect(await parentIdOf(hotel)).toBe(String(group._id));
    // ...and the group is not itself given a parent.
    expect(await parentIdOf(group)).toBeNull();
  });

  test("subsidiary_of sets the same link from the other side", async () => {
    const group = await Account.create({ companyName: "Mayfair Group" });
    const hotel = await Account.create({ companyName: "Mayfair Puri" });
    const rel = subsidiaryOf(hotel, group);
    await assertGroupEdgeApplicable(Account, rel);
    await applyGroupLink(Account, rel);
    expect(await parentIdOf(hotel)).toBe(String(group._id));
  });

  test("twenty properties all hang off one group", async () => {
    const group = await Account.create({ companyName: "Mayfair Group" });
    const hotels = [];
    for (let i = 0; i < 20; i++) {
      const h = await Account.create({ companyName: `Mayfair Property ${i + 1}` });
      const rel = parentOf(group, h);
      await assertGroupEdgeApplicable(Account, rel);
      await applyGroupLink(Account, rel);
      hotels.push(h);
    }
    const children = await Account.find({ parentAccountId: group._id }).lean();
    expect(children).toHaveLength(20);
    expect(await parentIdOf(hotels[19])).toBe(String(group._id));
  });

  test("re-applying the same edge changes nothing", async () => {
    const group = await Account.create({ companyName: "G" });
    const hotel = await Account.create({ companyName: "H" });
    const rel = parentOf(group, hotel);
    await assertGroupEdgeApplicable(Account, rel);
    await applyGroupLink(Account, rel);
    // Idempotent: asserting again must not read as a conflict with itself.
    await expect(assertGroupEdgeApplicable(Account, rel)).resolves.toBeTruthy();
    await applyGroupLink(Account, rel);
    expect(await parentIdOf(hotel)).toBe(String(group._id));
  });
});

describe("an account has exactly one parent", () => {
  test("a second, different group is refused and names the current one", async () => {
    const mayfair = await Account.create({ companyName: "Mayfair Group", accountId: "ACC-MAYFAIR" });
    const oberoi = await Account.create({ companyName: "Oberoi Group" });
    const hotel = await Account.create({ companyName: "Contested Hotel" });

    const first = parentOf(mayfair, hotel);
    await assertGroupEdgeApplicable(Account, first);
    await applyGroupLink(Account, first);

    await expect(assertGroupEdgeApplicable(Account, parentOf(oberoi, hotel))).rejects.toThrow(HierarchyError);
    await expect(assertGroupEdgeApplicable(Account, parentOf(oberoi, hotel))).rejects.toThrow(/Mayfair Group/);
    // Refused, not silently reparented.
    expect(await parentIdOf(hotel)).toBe(String(mayfair._id));
  });

  test("a cycle is refused", async () => {
    const a = await Account.create({ companyName: "A" });
    const b = await Account.create({ companyName: "B" });
    const first = parentOf(a, b);
    await assertGroupEdgeApplicable(Account, first);
    await applyGroupLink(Account, first);
    // Now make A a child of B — that closes the loop the hierarchy walk relies
    // on terminating.
    await expect(assertGroupEdgeApplicable(Account, parentOf(b, a))).rejects.toThrow(HierarchyError);
  });

  test("self-parenting is refused", async () => {
    const a = await Account.create({ companyName: "Solo" });
    await expect(assertGroupEdgeApplicable(Account, parentOf(a, a))).rejects.toThrow(HierarchyError);
  });

  test("a missing account is refused rather than writing a dangling parent", async () => {
    const group = await Account.create({ companyName: "G" });
    const ghost = await Account.create({ companyName: "Ghost" });
    await Account.deleteOne({ _id: ghost._id });
    await expect(assertGroupEdgeApplicable(Account, parentOf(group, ghost))).rejects.toThrow(HierarchyError);
  });
});

describe("ending a group edge", () => {
  test("clears the parent", async () => {
    const group = await Account.create({ companyName: "G" });
    const hotel = await Account.create({ companyName: "H" });
    const rel = parentOf(group, hotel);
    await assertGroupEdgeApplicable(Account, rel);
    await applyGroupLink(Account, rel);
    await clearGroupLink(Account, rel);
    expect(await parentIdOf(hotel)).toBeNull();
  });

  test("does NOT detach an account that has since moved groups", async () => {
    const oldGroup = await Account.create({ companyName: "Old" });
    const newGroup = await Account.create({ companyName: "New" });
    const hotel = await Account.create({ companyName: "H" });

    const oldRel = parentOf(oldGroup, hotel);
    await applyGroupLink(Account, oldRel);
    // Moved to a different group (old row ended first in the real flow; here we
    // simulate the stale row surviving).
    await Account.findByIdAndUpdate(hotel._id, { parentAccountId: newGroup._id });

    await clearGroupLink(Account, oldRel);
    expect(await parentIdOf(hotel)).toBe(String(newGroup._id));
  });

  test("ending a commercial edge touches nothing", async () => {
    const group = await Account.create({ companyName: "G" });
    const hotel = await Account.create({ companyName: "H" });
    await applyGroupLink(Account, parentOf(group, hotel));
    await clearGroupLink(Account, { ...parentOf(group, hotel), relationshipType: "agent_for" });
    expect(await parentIdOf(hotel)).toBe(String(group._id));
  });
});
