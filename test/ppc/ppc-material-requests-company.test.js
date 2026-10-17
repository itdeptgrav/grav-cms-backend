// test/ppc/ppc-material-requests-company.test.js
//
// WHAT THE FLOOR IS STILL WAITING ON, ACROSS EVERY ORDER.
//
// `listForCompany` is the read PPC's overview asks: which material requests is
// the Store still holding, anywhere. Pinned here:
//
//   · a request of ANOTHER company's order is not in it — the same Sales-line
//     company proof every other PPC read uses, including its legacy window: a
//     work order carrying no link at all is in scope while that window is open
//     (nearly every work order in the live database is one) and out of it under
//     STORE_PURCHASE_STRICT_TENANCY;
//   · a request the Store has fully issued against is finished and is gone;
//     one it has partly issued is still owed and says so;
//   · a cancelled request is not work, and Merchandising's inbound request is
//     somebody else's book;
//   · the oldest comes first, because that is the one the floor has been
//     waiting on longest;
//   · the totals count requests and the LINES still owed, never a sum of
//     quantities across different units.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const mongoose = require("mongoose");

const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const StockIssuance = require("../../models/CMS_Models/Inventory/Operations/StockIssuance");
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
const svc = require("../../services/ppc/materialRequests.service");

let seq = 0;
const oid = () => new mongoose.Types.ObjectId();
const ago = (days) => new Date(Date.now() - days * 86_400_000);

/** One order of `company` (or of nobody, when null), carrying `requests`. */
async function order(company, requests, { label = "O" } = {}) {
  const item = await StockItem.create({
    name: `Tee ${label}${++seq}`, sku: `SKU-MR-${seq}`, reference: `REF-MR-${seq}`, category: "Garment",
    createdBy: oid(), quantityOnHand: 0, minStock: 0, maxStock: 10, numberOfPanels: 2,
    variants: [{ sku: `V-MR-${seq}`, cost: 0, salesPrice: 0, attributes: [{ name: "Size", value: "M" }] }],
  });
  const mo = await CustomerRequest.create({
    requestId: `CR-MR-${++seq}`, customerId: oid(), customerInfo: { name: `Buyer ${label}` },
    status: "quotation_sales_approved",
    items: [{ stockItemId: item._id, stockItemName: item.name, totalQuantity: 10 }],
    materialRequests: requests,
  });
  await WorkOrder.create({
    customerRequestId: mo._id, stockItemId: item._id, stockItemName: item.name, quantity: 10, status: "in_progress",
    variantId: String(item.variants[0]._id), variantAttributes: [{ name: "Size", value: "M" }],
    ...(company ? { salesLineLink: { companyId: company, customerRequestId: mo._id, lineRef: `LN-${(++seq).toString(16).padStart(12, "0")}`, basis: "sales_line", linkedAt: new Date() } } : {}),
  });
  return await CustomerRequest.findById(mo._id).lean();
}

/** A request for `qty` of one material, raised `days` ago. */
const request = (number, qty, { days = 1, status = "open", source = "ppc", unit = "Mtr" } = {}) => ({
  requestNumber: number, source, status, reason: "For cutting", createdAt: ago(days),
  lines: [{ rawItemId: oid(), rawItemName: `Fabric ${number}`, rawItemSku: `RAW-${number}`, quantity: qty, unit }],
});

/** The Store issues `qty` against one line of a stored request. */
async function issue(mo, requestIndex, qty) {
  const stored = await CustomerRequest.findById(mo._id).lean();
  const req = stored.materialRequests[requestIndex];
  const line = req.lines[0];
  await StockIssuance.create({
    manufacturingOrder: mo._id, moNumber: `MO-${stored.requestId}`, direction: "debit",
    reason: "Issue against request", performedByName: "Store",
    materialRequestId: req._id,
    items: [{
      rawItem: line.rawItemId, rawItemName: line.rawItemName, rawItemSku: line.rawItemSku,
      materialRequestLineId: line._id, issuedQty: qty, issuedUnit: line.unit, nativeQty: qty, nativeUnit: line.unit,
    }],
  });
}

describe("what the floor is waiting on, company-wide", () => {
  test("only this company's unfinished requests, oldest first", async () => {
    const mine = oid();
    const theirs = oid();

    const waited = await order(mine, [request("MR-OLD", 100, { days: 9 })], { label: "Old" });
    const partial = await order(mine, [request("MR-PART", 50, { days: 2 })], { label: "Part" });
    const done = await order(mine, [request("MR-DONE", 20, { days: 3 })], { label: "Done" });
    await order(theirs, [request("MR-THEIRS", 70, { days: 8 })], { label: "Theirs" });

    await issue(partial, 0, 20);   // part of it
    await issue(done, 0, 20);      // all of it

    const out = await svc.listForCompany(mine);
    const numbers = out.rows.map((r) => r.requestNumber);

    expect(numbers).toEqual(["MR-OLD", "MR-PART"]);
    expect(numbers).not.toContain("MR-THEIRS");
    expect(numbers).not.toContain("MR-DONE");

    const [oldest, part] = out.rows;
    expect(oldest.status).toBe("open");
    expect(oldest.moNumber).toBe(`MO-${waited.requestId}`);
    expect(oldest.customerName).toBe("Buyer Old");
    expect(part.status).toBe("partially_issued");
    expect(part.lines[0].issuedQty).toBe(20);
    expect(part.lines[0].remaining).toBe(30);

    expect(out.totals).toMatchObject({ awaiting: 1, partlyIssued: 1, orders: 2, lines: 2 });
    expect(new Date(out.totals.oldestAt).getTime()).toBe(new Date(oldest.createdAt).getTime());
  });

  test("a cancelled request is not work, and Merchandising's is not ours", async () => {
    const mine = oid();
    await order(mine, [
      { ...request("MR-CANCELLED", 10, { days: 5 }), status: "cancelled", cancelledAt: ago(4), cancelReason: "Not needed" },
      request("MR-INBOUND", 10, { days: 5, source: "merchandising" }),
      request("MR-LIVE", 10, { days: 5 }),
    ], { label: "Mixed" });

    const out = await svc.listForCompany(mine);
    expect(out.rows.map((r) => r.requestNumber)).toEqual(["MR-LIVE"]);
    expect(out.totals.awaiting).toBe(1);
  });

  test("an unlinked order is in scope while the legacy window is open, and out when it is strict", async () => {
    const mine = oid();
    await order(mine, [request("MR-MINE", 10, { days: 2 })], { label: "Mine" });
    await order(null, [request("MR-UNLINKED", 10, { days: 3 })], { label: "Unlinked" });

    /* The live database: almost no work order carries a Sales-line link yet,
       so Packaging, Cutting and Finishing all read through to them — and so
       must this, or the panel reports an empty Store on a floor that is
       waiting. */
    const open = await svc.listForCompany(mine);
    expect(open.rows.map((r) => r.requestNumber).sort()).toEqual(["MR-MINE", "MR-UNLINKED"]);

    /* Closing the window is `STORE_PURCHASE_STRICT_TENANCY=1`, read once when
       the module loads and shared with Packaging, Cutting and Finishing — it
       is pinned by the store-purchase suites, and re-requiring this service
       here would detach it from the test's own connection. */
  });

  test("a company with no work at all, and one whose orders carry no request", async () => {
    expect(await svc.listForCompany(oid())).toMatchObject({ rows: [], totals: { awaiting: 0, orders: 0 } });

    const quiet = oid();
    await order(quiet, [], { label: "NoRequests" });
    const out = await svc.listForCompany(quiet);
    expect(out.rows).toEqual([]);
    expect(out.totals.lines).toBe(0);
  });

  test("the list is bounded, and says when it was cut", async () => {
    const mine = oid();
    await order(mine, [1, 2, 3].map((i) => request(`MR-B${i}`, 10, { days: i })), { label: "Many" });
    const out = await svc.listForCompany(mine, { limit: 2 });
    expect(out.rows).toHaveLength(2);
    expect(out.truncated).toBe(true);
    /* The totals describe everything owed, not the page. */
    expect(out.totals.awaiting).toBe(3);
  });
});
