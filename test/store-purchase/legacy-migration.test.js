// test/store-purchase/legacy-migration.test.js
//
// THE LEGACY STAMP CAN ONLY EVER TOUCH WHAT THE OPERATOR NAMED.
//
// ── THE DEFECT THIS GUARDS ──────────────────────────────────────────────────
// The explicit-target option took PO NUMBERS and queried `poNumber: { $in }`.
// A PO number is unique only WITHIN a company, so the same number exists in
// several tenants — and one command meant for one order could stamp somebody
// else's. There is no way to disambiguate a bare number on a command line, so
// the option takes immutable `_id` values instead.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const mongoose = require("mongoose");
require("../../models/ProjectManager");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const governed = require("../../services/storePurchase/governedPurchaseOrder.service");

let seq = 0;
const company = () => Acc_Company.create({ companyName: `Co ${++seq}`, booksFromDate: new Date("2026-04-01") });

const makePO = (co, poNumber, over = {}) => PurchaseOrder.create({
  companyId: co._id, poNumber, status: "DRAFT",
  createdBy: new mongoose.Types.ObjectId(), vendorName: "Old Supplier",
  subtotal: 100, taxAmount: 0, totalAmount: 100,
  items: [{
    _id: new mongoose.Types.ObjectId(), rawItem: new mongoose.Types.ObjectId(),
    itemName: "Old cloth", sku: "OLD", unit: "m", quantity: 10, unitPrice: 10,
    totalPrice: 100, receivedQuantity: 0, pendingQuantity: 10, status: "PENDING",
  }],
  ...over,
});

/* ── THE REAL MIGRATION CODE, NOT A COPY OF IT ─────────────────────────────
   An earlier version of this suite defined its own `stampByObjectIds` helper
   and tested that. A defect in the actual script would have passed while the
   copy stayed correct — which is the opposite of what a migration test is for.

   The script now exports its planner and its one write, and runs `main()` only
   when executed directly, so requiring it connects to nothing. */
const migration = require("../../scripts/migrations/stamp-legacy-purchase-orders.js");

describe("explicit migration targets are tenant-safe", () => {
  it("two companies can hold the same PO number, and only the named document is stamped", async () => {
    const a = await company();
    const b = await company();
    /* The same human-readable number in both tenants — which is legal: the
       uniqueness index is on { companyId, poNumber }. */
    const mine = await makePO(a, "PO/2026-27/0007");
    const theirs = await makePO(b, "PO/2026-27/0007");

    /* The dry run first: the ids it prints are the ids the apply uses. */
    const plan = await migration.planExplicit([String(mine._id)]);
    expect(plan.targets.map(String)).toEqual([String(mine._id)]);

    const res = await migration.applyStamp(plan.targets);
    expect(res.modifiedCount).toBe(1);

    expect((await PurchaseOrder.findById(mine._id).lean()).provenancePolicy).toBe(governed.LEGACY_POLICY);
    /* The other company's identically numbered order is untouched. */
    const other = await PurchaseOrder.findById(theirs._id).lean();
    expect(other.provenancePolicy).toBeFalsy();
    expect(governed.isLegacyOrder(other)).toBe(false);
  });

  it("a missing id stops the run rather than stamping the rest", async () => {
    const a = await company();
    const po = await makePO(a, `PO/MISSING/${++seq}`);
    await expect(
      migration.planExplicit([String(po._id), String(new mongoose.Types.ObjectId())]),
    ).rejects.toThrow(/no purchase order with these ids/i);
    expect((await PurchaseOrder.findById(po._id).lean()).provenancePolicy).toBeFalsy();
  });

  it("the dry run's targets are exactly what the apply writes", async () => {
    const a = await company();
    const one = await makePO(a, `PO/DRY1/${++seq}`);
    const two = await makePO(a, `PO/DRY2/${++seq}`, { provenancePolicy: governed.PROVENANCE_POLICY });

    const plan = await migration.planExplicit([String(one._id), String(two._id)]);
    expect(plan.targets.map(String)).toEqual([String(one._id)]);

    await migration.applyStamp(plan.targets);
    expect((await PurchaseOrder.findById(one._id).lean()).provenancePolicy).toBe(governed.LEGACY_POLICY);
    expect((await PurchaseOrder.findById(two._id).lean()).provenancePolicy).toBe(governed.PROVENANCE_POLICY);
  });

  it("the cutover planner excludes undated records and lists them", async () => {
    const a = await company();
    const dated = await makePO(a, `PO/DATED/${++seq}`);
    await PurchaseOrder.collection.updateOne({ _id: dated._id }, { $set: { createdAt: new Date("2026-01-01") } });
    const undated = await makePO(a, `PO/UNDATED/${++seq}`);
    await PurchaseOrder.collection.updateOne({ _id: undated._id }, { $unset: { createdAt: "" } });

    const plan = await migration.planByCutover(new Date("2026-09-28T00:00:00.000Z"));
    expect(plan.targets.map(String)).toContain(String(dated._id));
    expect(plan.targets.map(String)).not.toContain(String(undated._id));
    expect(plan.undated.map((d) => String(d._id))).toContain(String(undated._id));
  });

  it("a malformed id is refused before anything is written", async () => {
    const a = await company();
    const po = await makePO(a, `PO/BAD/${++seq}`);
    await expect(migration.planExplicit([String(po._id), "not-an-id"])).rejects.toThrow(/not valid/i);
    /* Nothing was stamped — not even the valid one in the same call. */
    expect((await PurchaseOrder.findById(po._id).lean()).provenancePolicy).toBeFalsy();
  });

  it("a governed order is never stamped, even if its id is named", async () => {
    const a = await company();
    const po = await makePO(a, `PO/GOV/${++seq}`, { provenancePolicy: governed.PROVENANCE_POLICY });
    /* It is reported as already stamped, and is not a target. */
    const plan = await migration.planExplicit([String(po._id)]);
    expect(plan.targets).toEqual([]);
    expect(plan.already.map((d) => String(d._id))).toEqual([String(po._id)]);

    const res = await migration.applyStamp(plan.targets);
    expect(res.modifiedCount).toBe(0);
    expect((await PurchaseOrder.findById(po._id).lean()).provenancePolicy).toBe(governed.PROVENANCE_POLICY);
  });

  it("re-running stamps nothing the second time", async () => {
    const a = await company();
    const po = await makePO(a, `PO/IDEM/${++seq}`);
    expect((await migration.applyStamp([po._id])).modifiedCount).toBe(1);
    /* The second run matches nothing: the filter only ever takes orders that
       carry no policy at all. */
    expect((await migration.applyStamp([po._id])).modifiedCount).toBe(0);
  });

  it("an unstamped order is not legacy, whatever its date", async () => {
    const a = await company();
    const po = await makePO(a, `PO/UNSTAMPED/${++seq}`);
    await PurchaseOrder.collection.updateOne({ _id: po._id }, { $set: { createdAt: new Date("2019-01-01") } });
    const reloaded = await PurchaseOrder.findById(po._id).lean();
    /* Legacy is carried, never inferred from a date or from missing
       provenance. */
    expect(governed.isLegacyOrder(reloaded)).toBe(false);
  });
});

describe("the migration script's own contract", () => {
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "../../scripts/migrations/stamp-legacy-purchase-orders.js"), "utf8");

  it("refuses --ids outright rather than reinterpreting it", () => {
    expect(src).toMatch(/--ids is not supported/);
    expect(src).toMatch(/unique only within a company/i);
  });

  it("never queries by a bare PO number", () => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/poNumber:\s*\{\s*\$in/);
  });

  it("requires an explicit deployment cutover", () => {
    expect(src).toMatch(/--cutover=<ISO instant> is required/);
    expect(src).toMatch(/SP_PROVENANCE_CUTOVER/);
  });

  it("prints the immutable ids the apply will use", () => {
    expect(src).toMatch(/_id=\$\{po\._id\}/);
    expect(src).toMatch(/--object-ids=<_id,_id> --apply/);
  });

  it("refuses to apply while unstamped orders exist after the cutover", () => {
    expect(src).toMatch(/Refusing to apply while unstamped orders exist after the cutover/);
  });

  it("has exactly one write, and it is filtered on carrying no policy", () => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    /* One `updateMany` in the whole script — `applyStamp` — so there is no
       second door that could skip the filter. */
    const writes = code.match(/updateMany\(/g) || [];
    expect(writes.length).toBe(1);
    expect(code).toMatch(/updateMany\(\s*\{ \.\.\.UNSTAMPED, _id: \{ \$in: ids \} \}/);
  });

  it("runs main() only when executed directly, so requiring it is safe", () => {
    expect(src).toMatch(/if \(require\.main === module\)/);
    /* And the parts tests drive are exported rather than copied. */
    expect(Object.keys(require("../../scripts/migrations/stamp-legacy-purchase-orders.js")))
      .toEqual(expect.arrayContaining(["planExplicit", "planByCutover", "applyStamp"]));
  });
});
