// test/store-purchase/location-stock.route.test.js
//
// Warehouse Stock V1 — the location ledger and its operations. Proves location
// balances derive from immutable movements, reconcile exactly to RawItem's
// company-wide on-hand, and that assign/transfer never change the company total
// while issue changes it atomically with the location write.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Warehouse = require("../../models/CMS_Models/Inventory/Configurations/Warehouse");
const LocationMovement = require("../../models/CMS_Models/Inventory/Operations/LocationMovement");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/inventory/locations", require("../../routes/CMS_Routes/Inventory/Operations/locationStockRoutes"));
  // The CANONICAL manual stock in/out — now location-aware. Location tests use
  // it to prove issues go through real stock history, not a standalone path.
  app.use("/api/cms/inventory/stock-adjustments", require("../../routes/CMS_Routes/Inventory/Products/stockAdjustments"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const oid = () => new mongoose.Types.ObjectId();
const tokenFor = (over = {}) =>
  jwt.sign({ id: String(new mongoose.Types.ObjectId()), role: "store_manager", employeeId: `ST${seq}`, name: "St", email: "s@x.example", ...over },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" });

const call = (path, { method = "GET", body, token, key } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const newKey = () => `k-${++seq}-${Math.random().toString(36).slice(2)}`;

async function actor(company) {
  const n = ++seq;
  const email = `loc${n}@x.example`;
  const employeeRef = new mongoose.Types.ObjectId();
  await DepartmentRole.create({ departmentSlug: "store", email, role: "approver", name: "Loc", isActive: true });
  await SpCompanyMembership.create({ companyId: company._id, email, employeeRef, personName: "Loc" });
  return tokenFor({ id: String(employeeRef), email });
}

const company = () => Acc_Company.create({ companyName: `Co ${++seq}`, booksFromDate: new Date("2026-04-01") });

const warehouse = (companyId, over = {}) =>
  Warehouse.create({
    companyId, name: over.name || `WH ${++seq}`, shortName: over.shortName || `W${seq}`,
    status: over.status || "Active",
    locations: over.locations || [
      { code: "RECV", name: "Receiving", type: "RECEIVING", status: "Active" },
      { code: "STOCK", name: "Usable stock", type: "USABLE_STOCK", status: "Active" },
    ],
  });

const rawItem = (companyId, over = {}) =>
  RawItem.create({
    companyId, sku: over.sku || `RAW-${++seq}`, name: over.name || `Item ${seq}`,
    unit: over.unit || "PCS", quantity: over.quantity != null ? over.quantity : 10,
    variants: over.variants || [],
  });

// A ready scenario: company, active warehouse with RECV+STOCK, an item on-hand 10.
async function scene({ quantity = 10, variants } = {}) {
  const c = await company();
  const wh = await warehouse(c._id);
  const [recv, stock] = wh.locations;
  const item = await rawItem(c._id, { quantity, variants });
  const token = await actor(c);
  return { c, wh, recv, stock, item, token };
}

// ── Legacy / derivation ──────────────────────────────────────────────────────
describe("legacy stock and derivation", () => {
  // 10 + 11
  test("legacy stock with no movements reads as Unassigned, never zero or guessed", async () => {
    const s = await scene({ quantity: 10 });
    const r = await call(`/api/cms/inventory/locations/item/${s.item._id}`, { token: s.token });
    expect(r.status).toBe(200);
    expect(r.body.item.onHand).toBe(10);
    expect(r.body.item.assigned).toBe(0);
    expect(r.body.item.unassigned).toBe(10); // all unassigned, not zero, not a guessed warehouse
    expect(r.body.item.balances).toEqual([]);
    // reconcile: assigned + unassigned === onHand
    expect(r.body.item.assigned + r.body.item.unassigned).toBe(r.body.item.onHand);
  });
});

// ── Assign ───────────────────────────────────────────────────────────────────
describe("assign existing stock", () => {
  const assign = (s, qty, key, over = {}) =>
    call("/api/cms/inventory/locations/assign", { method: "POST", token: s.token, key: key || newKey(), body: {
      rawItemId: String(s.item._id), warehouseId: String(s.wh._id), locationId: String(s.stock._id), quantity: qty, ...over,
    } });

  // 3
  test("assignment cannot exceed current on-hand", async () => {
    const s = await scene({ quantity: 10 });
    const r = await assign(s, 11);
    expect(r.status).toBe(400);
    expect(r.body.error?.details?.reason).toBe("EXCEEDS_ON_HAND");
  });

  // 1 (via assign) + 4 + 11
  test("a partial assignment leaves the correct Unassigned amount and preserves the total", async () => {
    const s = await scene({ quantity: 10 });
    const before = (await RawItem.findById(s.item._id).lean()).quantity;
    const r = await assign(s, 6);
    expect([200, 201]).toContain(r.status);
    const after = (await RawItem.findById(s.item._id).lean()).quantity;
    expect(after).toBe(before); // company total unchanged by placement
    const view = await call(`/api/cms/inventory/locations/item/${s.item._id}`, { token: s.token });
    expect(view.body.item.assigned).toBe(6);
    expect(view.body.item.unassigned).toBe(4);
    expect(view.body.item.assigned + view.body.item.unassigned).toBe(10); // reconcile
    expect(view.body.item.balances[0].onHand).toBe(6);
  });
});

// ── Standalone stock-changing endpoints are RETIRED ──────────────────────────
describe("standalone location endpoints cannot bypass canonical stock", () => {
  test("the standalone /issue and /receipt are gone (410) and change nothing", async () => {
    const s = await scene({ quantity: 10 });
    const iss = await call("/api/cms/inventory/locations/issue", { method: "POST", token: s.token, key: newKey(), body: {
      rawItemId: String(s.item._id), warehouseId: String(s.wh._id), locationId: String(s.stock._id), quantity: 1,
    } });
    expect(iss.status).toBe(410);
    expect(iss.body.reason).toBe("ENDPOINT_RETIRED");
    const rec = await call("/api/cms/inventory/locations/receipt", { method: "POST", token: s.token, key: newKey(), body: {
      rawItemId: String(s.item._id), warehouseId: String(s.wh._id), locationId: String(s.recv._id), quantity: 1,
    } });
    expect(rec.status).toBe(410);
    expect(rec.body.reason).toBe("ENDPOINT_RETIRED");
    expect(await LocationMovement.countDocuments({ itemId: s.item._id })).toBe(0);
    expect((await RawItem.findById(s.item._id).lean()).quantity).toBe(10);
  });
});

// ── Canonical issue (stock adjustment) now carries location ──────────────────
const ISSUE_REASON = "issued to the production floor for the morning run";
const canonicalIssue = (s, { direction = "debit", qty = 1, loc, key } = {}) =>
  call("/api/cms/inventory/stock-adjustments/issue", { method: "POST", token: s.token, key: key || newKey(), body: {
    direction, reason: ISSUE_REASON,
    items: [{ rawItemId: String(s.item._id), issuedQty: qty, issuedUnit: "PCS",
      ...(loc ? { warehouseId: String(s.wh._id), locationId: String(loc._id) } : {}) }],
  } });

describe("canonical stock issue with location", () => {
  async function placed(qty, at) {
    const s = await scene({ quantity: 10 });
    await call("/api/cms/inventory/locations/assign", { method: "POST", token: s.token, key: newKey(), body: {
      rawItemId: String(s.item._id), warehouseId: String(s.wh._id), locationId: String((at || s.stock)._id), quantity: qty,
    } });
    return s;
  }

  test("a canonical issue writes stock history AND a location out together", async () => {
    const s = await placed(8);
    const r = await canonicalIssue(s, { qty: 3, loc: s.stock });
    expect([200, 201]).toContain(r.status);
    const item = await RawItem.findById(s.item._id).lean();
    expect(item.quantity).toBe(7);
    const tx = item.stockTransactions.find((t) => t.type === "REDUCE");
    expect(tx).toBeTruthy();
    expect(String(tx.locationCode)).toBe("STOCK");
    const mv = await LocationMovement.findOne({ itemId: s.item._id, type: "issue" }).lean();
    expect(mv.direction).toBe("out");
    expect(mv.source.kind).toBe("stock_issue");
    expect(String(mv.source.id)).toBeTruthy();
    const view = await call(`/api/cms/inventory/locations/item/${s.item._id}`, { token: s.token });
    expect(view.body.item.balances.find((b) => b.locationId === String(s.stock._id)).onHand).toBe(5);
  });

  test("a canonical issue refuses more than the source location holds", async () => {
    const s = await placed(5);
    const r = await canonicalIssue(s, { qty: 6, loc: s.stock });
    expect(r.status).toBe(400);
    expect(r.body.error?.details?.reason).toBe("INSUFFICIENT_AT_LOCATION");
  });

  test("when the location side fails neither side is applied", async () => {
    const s = await placed(5);
    const before = (await RawItem.findById(s.item._id).lean()).quantity;
    const r = await canonicalIssue(s, { qty: 6, loc: s.stock });
    expect(r.status).toBe(400);
    expect((await RawItem.findById(s.item._id).lean()).quantity).toBe(before);
    expect(await LocationMovement.countDocuments({ itemId: s.item._id, type: "issue" })).toBe(0);
  });

  test("a canonical issue records exactly one canonical stock transaction", async () => {
    const s = await placed(8);
    await canonicalIssue(s, { qty: 3, loc: s.stock });
    const item = await RawItem.findById(s.item._id).lean();
    const reduces = item.stockTransactions.filter((t) => t.type === "REDUCE");
    expect(reduces.length).toBe(1);
    expect(reduces[0].quantity).toBe(3);
  });
});

// ── Transfer ─────────────────────────────────────────────────────────────────
describe("internal transfer", () => {
  async function assignedScene() {
    const s = await scene({ quantity: 10 });
    await call("/api/cms/inventory/locations/assign", { method: "POST", token: s.token, key: newKey(), body: {
      rawItemId: String(s.item._id), warehouseId: String(s.wh._id), locationId: String(s.stock._id), quantity: 10,
    } });
    return s;
  }
  const transferBody = (s, qty) => ({
    rawItemId: String(s.item._id),
    fromWarehouseId: String(s.wh._id), fromLocationId: String(s.stock._id),
    toWarehouseId: String(s.wh._id), toLocationId: String(s.recv._id),
    quantity: qty,
  });

  // 6
  test("a transfer writes equal out/in legs and leaves the company total unchanged", async () => {
    const s = await assignedScene();
    const before = (await RawItem.findById(s.item._id).lean()).quantity;
    const r = await call("/api/cms/inventory/locations/transfer", { method: "POST", token: s.token, key: newKey(), body: transferBody(s, 4) });
    expect([200, 201]).toContain(r.status);
    expect((await RawItem.findById(s.item._id).lean()).quantity).toBe(before); // unchanged
    const legs = await LocationMovement.find({ transferId: new mongoose.Types.ObjectId(r.body.transfer.transferId) }).lean();
    expect(legs).toHaveLength(2);
    const out = legs.find((l) => l.type === "transfer_out");
    const inn = legs.find((l) => l.type === "transfer_in");
    expect(out.quantity).toBe(4);
    expect(inn.quantity).toBe(4);
    const view = await call(`/api/cms/inventory/locations/item/${s.item._id}`, { token: s.token });
    expect(view.body.item.balances.find((b) => b.locationId === String(s.stock._id)).onHand).toBe(6);
    expect(view.body.item.balances.find((b) => b.locationId === String(s.recv._id)).onHand).toBe(4);
  });

  test("a transfer refuses more than the source holds", async () => {
    const s = await assignedScene();
    // move 10 → stock now 0 at recv... actually stock holds 10; ask for 11
    const r = await call("/api/cms/inventory/locations/transfer", { method: "POST", token: s.token, key: newKey(), body: transferBody(s, 11) });
    expect(r.status).toBe(400);
    expect(r.body.error?.details?.reason).toBe("INSUFFICIENT_AT_SOURCE");
  });

  test("same source and destination is refused", async () => {
    const s = await assignedScene();
    const r = await call("/api/cms/inventory/locations/transfer", { method: "POST", token: s.token, key: newKey(), body: {
      ...transferBody(s, 1), toLocationId: String(s.stock._id),
    } });
    expect(r.status).toBe(400);
    expect(r.body.error?.details?.reason).toBe("SAME_LOCATION");
  });

  test("the transfer response carries the committed before/after result facts", async () => {
    const s = await assignedScene(); // STOCK holds 10, RECV holds 0
    const r = await call("/api/cms/inventory/locations/transfer", { method: "POST", token: s.token, key: newKey(), body: transferBody(s, 4) });
    expect([200, 201]).toContain(r.status);
    const t = r.body.transfer;
    expect(t.transferId).toBeTruthy();
    expect(t.quantity).toBe(4);
    expect(t.baseUnit).toBe("PCS");
    expect(String(t.item.rawItemId)).toBe(String(s.item._id));
    expect(t.variantId).toBeNull();
    // Source snapshot + before/after — from the committed operation.
    expect(String(t.source.locationId)).toBe(String(s.stock._id));
    expect(t.source.locationCode).toBe("STOCK");
    expect(t.source.before).toBe(10);
    expect(t.source.after).toBe(6);
    // Destination snapshot + before/after.
    expect(String(t.destination.locationId)).toBe(String(s.recv._id));
    expect(t.destination.before).toBe(0);
    expect(t.destination.after).toBe(4);
    // Company on-hand is unchanged by a transfer.
    expect(t.companyOnHand.before).toBe(10);
    expect(t.companyOnHand.after).toBe(10);
  });

  // Correction pass — committed before/after facts under concurrency.
  test("two simultaneous transfers that both succeed return CHAINED before→after, not a stale duplicate", async () => {
    const s = await assignedScene(); // STOCK holds 10, RECV holds 0
    const [a, b] = await Promise.all([
      call("/api/cms/inventory/locations/transfer", { method: "POST", token: s.token, key: newKey(), body: transferBody(s, 2) }),
      call("/api/cms/inventory/locations/transfer", { method: "POST", token: s.token, key: newKey(), body: transferBody(s, 2) }),
    ]);
    expect([200, 201]).toContain(a.status);
    expect([200, 201]).toContain(b.status);

    // Source chain: {10→8, 8→6} in either order — NEVER both 10→8.
    const src = [a.body.transfer.source, b.body.transfer.source].sort((x, y) => y.before - x.before);
    expect(src.map((v) => [v.before, v.after])).toEqual([[10, 8], [8, 6]]);
    // Destination chains the same way: {0→2, 2→4}.
    const dst = [a.body.transfer.destination, b.body.transfer.destination].sort((x, y) => x.before - y.before);
    expect(dst.map((v) => [v.before, v.after])).toEqual([[0, 2], [2, 4]]);

    // The projection agrees with the last committed figures.
    const view = await call(`/api/cms/inventory/locations/item/${s.item._id}`, { token: s.token });
    expect(view.body.item.balances.find((x) => x.locationId === String(s.stock._id)).onHand).toBe(6);
    expect(view.body.item.balances.find((x) => x.locationId === String(s.recv._id)).onHand).toBe(4);
    // Company on-hand is unchanged and comes from the company authority.
    expect(a.body.transfer.companyOnHand.before).toBe(a.body.transfer.companyOnHand.after);
    expect((await RawItem.findById(s.item._id).lean()).quantity).toBe(10);
  });

  // 7
  test("replaying the same transfer key does not duplicate either leg", async () => {
    const s = await assignedScene();
    const key = newKey();
    const first = await call("/api/cms/inventory/locations/transfer", { method: "POST", token: s.token, key, body: transferBody(s, 4) });
    expect([200, 201]).toContain(first.status);
    const second = await call("/api/cms/inventory/locations/transfer", { method: "POST", token: s.token, key, body: transferBody(s, 4) });
    expect([200, 201]).toContain(second.status); // replayed, not a new transfer
    expect(await LocationMovement.countDocuments({ itemId: s.item._id, type: { $in: ["transfer_in", "transfer_out"] } })).toBe(2);
    const view = await call(`/api/cms/inventory/locations/item/${s.item._id}`, { token: s.token });
    expect(view.body.item.balances.find((b) => b.locationId === String(s.stock._id)).onHand).toBe(6); // not 2
  });
});

// ── Put-away destination semantics ───────────────────────────────────────────
describe("put-away destination semantics", () => {
  const TYPES = [
    { code: "RECV", name: "Receiving", type: "RECEIVING", status: "Active" },
    { code: "RECV2", name: "Receiving 2", type: "RECEIVING", status: "Active" },
    { code: "STOCK", name: "Usable", type: "USABLE_STOCK", status: "Active" },
    { code: "QUAR", name: "Quarantine", type: "QUARANTINE", status: "Active" },
    { code: "INSP", name: "Inspection", type: "INSPECTION", status: "Active" },
    { code: "RETN", name: "Returns", type: "RETURNS", status: "Active" },
    { code: "SCRAP", name: "Scrap", type: "SCRAP", status: "Active" },
  ];
  async function putawayScene() {
    const c = await company();
    const wh = await warehouse(c._id, { locations: TYPES });
    const item = await rawItem(c._id, { quantity: 20 });
    const token = await actor(c);
    const byCode = {};
    wh.locations.forEach((l) => { byCode[l.code] = l; });
    // Put 20 into the RECV dock so a put-away has something to move.
    await call("/api/cms/inventory/locations/assign", { method: "POST", token, key: newKey(), body: {
      rawItemId: String(item._id), warehouseId: String(wh._id), locationId: String(byCode.RECV._id), quantity: 20,
    } });
    return { c, wh, item, token, byCode };
  }
  const put = (s, toCode, qty = 5) => call("/api/cms/inventory/locations/transfer", { method: "POST", token: s.token, key: newKey(), body: {
    rawItemId: String(s.item._id),
    fromWarehouseId: String(s.wh._id), fromLocationId: String(s.byCode.RECV._id),
    toWarehouseId: String(s.wh._id), toLocationId: String(s.byCode[toCode]._id),
    quantity: qty,
  } });

  test("Receiving → Usable Stock is allowed", async () => {
    const s = await putawayScene();
    expect([200, 201]).toContain((await put(s, "STOCK")).status);
  });
  test("Receiving → another Receiving is refused as a put-away", async () => {
    const s = await putawayScene();
    const r = await put(s, "RECV2");
    expect(r.status).toBe(400);
    expect(r.body.error?.details?.reason).toBe("PUTAWAY_DESTINATION_NOT_USABLE");
  });
  for (const code of ["QUAR", "INSP", "RETN", "SCRAP"]) {
    test(`Receiving → ${code} (an exception type) is refused as a put-away`, async () => {
      const s = await putawayScene();
      const r = await put(s, code);
      expect(r.status).toBe(400);
      expect(r.body.error?.details?.reason).toBe("PUTAWAY_DESTINATION_NOT_USABLE");
    });
  }
  test("an ORDINARY transfer (usable source, not a put-away) may still reach a non-usable active location", async () => {
    const s = await putawayScene();
    expect([200, 201]).toContain((await put(s, "STOCK", 10)).status); // stock now in Usable
    const r = await call("/api/cms/inventory/locations/transfer", { method: "POST", token: s.token, key: newKey(), body: {
      rawItemId: String(s.item._id),
      fromWarehouseId: String(s.wh._id), fromLocationId: String(s.byCode.STOCK._id),
      toWarehouseId: String(s.wh._id), toLocationId: String(s.byCode.QUAR._id),
      quantity: 3,
    } });
    expect([200, 201]).toContain(r.status);
  });
});

// ── Variants ─────────────────────────────────────────────────────────────────
describe("variant separation", () => {
  // 5
  test("variant balances remain separate", async () => {
    const vA = oid(); const vB = oid();
    const s = await scene({ variants: [{ _id: vA, sku: "V-A", combination: ["A"], quantity: 6 }, { _id: vB, sku: "V-B", combination: ["B"], quantity: 4 }], quantity: 10 });
    await call("/api/cms/inventory/locations/assign", { method: "POST", token: s.token, key: newKey(), body: {
      rawItemId: String(s.item._id), variantId: String(vA), warehouseId: String(s.wh._id), locationId: String(s.stock._id), quantity: 5,
    } });
    const view = await call(`/api/cms/inventory/locations/item/${s.item._id}`, { token: s.token });
    const a = view.body.variants.find((v) => v.variantId === String(vA));
    const b = view.body.variants.find((v) => v.variantId === String(vB));
    expect(a.assigned).toBe(5); expect(a.unassigned).toBe(1); // on-hand 6
    expect(b.assigned).toBe(0); expect(b.unassigned).toBe(4); // untouched
  });

  // Correction 2 regression: Red and Blue at DIFFERENT locations. The item
  // endpoint must return each variant's OWN balances (so a Red MRF line can be
  // offered Red stock, not Blue's or the whole item's), and a truthful `tracked`
  // flag per scope.
  test("Red and Blue at different locations — each variant returns only its own stock, tracked", async () => {
    const red = oid(); const blue = oid();
    const s = await scene({
      quantity: 10,
      variants: [
        { _id: red, sku: "RED", combination: ["Red"], quantity: 6 },
        { _id: blue, sku: "BLUE", combination: ["Blue"], quantity: 4 },
      ],
    });
    // Red → RECV, Blue → STOCK (two distinct locations).
    await call("/api/cms/inventory/locations/assign", { method: "POST", token: s.token, key: newKey(), body: {
      rawItemId: String(s.item._id), variantId: String(red), warehouseId: String(s.wh._id), locationId: String(s.recv._id), quantity: 6,
    } });
    await call("/api/cms/inventory/locations/assign", { method: "POST", token: s.token, key: newKey(), body: {
      rawItemId: String(s.item._id), variantId: String(blue), warehouseId: String(s.wh._id), locationId: String(s.stock._id), quantity: 4,
    } });

    const view = await call(`/api/cms/inventory/locations/item/${s.item._id}`, { token: s.token });
    const r = view.body.variants.find((v) => v.variantId === String(red));
    const b = view.body.variants.find((v) => v.variantId === String(blue));

    // Red offers ONLY its own location, with its own quantity — never Blue's.
    expect(r.tracked).toBe(true);
    expect(r.balances).toHaveLength(1);
    expect(String(r.balances[0].locationId)).toBe(String(s.recv._id));
    expect(r.balances[0].onHand).toBe(6);
    expect(r.balances.some((x) => String(x.locationId) === String(s.stock._id))).toBe(false);

    // Blue is separate, at the other location.
    expect(b.tracked).toBe(true);
    expect(b.balances).toHaveLength(1);
    expect(String(b.balances[0].locationId)).toBe(String(s.stock._id));
    expect(b.balances[0].onHand).toBe(4);

    // The whole-item scope, by contrast, was never placed → not tracked.
    expect(view.body.item.tracked).toBe(false);
  });
});

// ── Boundary refusals ────────────────────────────────────────────────────────
describe("location boundary refusals", () => {
  const assignTo = (s, wid, lid) =>
    call("/api/cms/inventory/locations/assign", { method: "POST", token: s.token, key: newKey(), body: {
      rawItemId: String(s.item._id), warehouseId: String(wid), locationId: String(lid), quantity: 1,
    } });

  // 8
  test("an inactive location is refused", async () => {
    const s = await scene();
    const wh = await warehouse(s.c._id, { locations: [{ code: "OLD", name: "Old", type: "USABLE_STOCK", status: "Inactive" }] });
    const r = await assignTo(s, wh._id, wh.locations[0]._id);
    expect(r.status).toBe(400);
    expect(r.body.error?.details?.reason).toBe("LOCATION_INACTIVE");
  });
  test("an archived warehouse is refused", async () => {
    const s = await scene();
    const wh = await warehouse(s.c._id, { status: "Archived" });
    const r = await assignTo(s, wh._id, wh.locations[0]._id);
    expect(r.status).toBe(400);
    expect(r.body.error?.details?.reason).toBe("WAREHOUSE_INACTIVE");
  });
  test("a cross-company warehouse is not found", async () => {
    const s = await scene();
    const other = await company();
    const wh = await warehouse(other._id);
    const r = await assignTo(s, wh._id, wh.locations[0]._id);
    expect(r.status).toBe(400);
    expect(r.body.error?.details?.reason).toBe("WAREHOUSE_NOT_FOUND");
  });
  test("a location from the wrong warehouse is not found", async () => {
    const s = await scene();
    const otherWh = await warehouse(s.c._id);
    const r = await assignTo(s, s.wh._id, otherWh.locations[0]._id); // location belongs to otherWh
    expect(r.status).toBe(400);
    expect(r.body.error?.details?.reason).toBe("LOCATION_NOT_FOUND");
  });
});

// ── Warehouse view ───────────────────────────────────────────────────────────
describe("warehouse stock view", () => {
  test("warehouse detail lists items held per location", async () => {
    const s = await scene({ quantity: 10 });
    await call("/api/cms/inventory/locations/assign", { method: "POST", token: s.token, key: newKey(), body: {
      rawItemId: String(s.item._id), warehouseId: String(s.wh._id), locationId: String(s.stock._id), quantity: 7,
    } });
    const r = await call(`/api/cms/inventory/locations/warehouse/${s.wh._id}`, { token: s.token });
    expect(r.status).toBe(200);
    const stockLoc = r.body.locations.find((l) => l.locationId === String(s.stock._id));
    expect(stockLoc.items).toHaveLength(1);
    expect(stockLoc.items[0].onHand).toBe(7);
    expect(String(stockLoc.items[0].itemId)).toBe(String(s.item._id));
  });
});

// ── Concurrency: atomic guards prevent oversubscription ──────────────────────
describe("concurrent oversubscription is refused", () => {
  test("two simultaneous assignments of the same headroom: only one wins", async () => {
    const s = await scene({ quantity: 10 });
    const body = { rawItemId: String(s.item._id), warehouseId: String(s.wh._id), locationId: String(s.stock._id), quantity: 6 };
    const [a, b] = await Promise.all([
      call("/api/cms/inventory/locations/assign", { method: "POST", token: s.token, key: newKey(), body }),
      call("/api/cms/inventory/locations/assign", { method: "POST", token: s.token, key: newKey(), body }),
    ]);
    const oks = [a, b].filter((r) => r.status === 201 || r.status === 200).length;
    expect(oks).toBe(1);
    const view = await call(`/api/cms/inventory/locations/item/${s.item._id}`, { token: s.token });
    expect(view.body.item.assigned).toBe(6);
    expect(view.body.item.assigned).toBeLessThanOrEqual(view.body.item.onHand);
  });

  test("two simultaneous canonical issues from one location: only one wins", async () => {
    const s = await scene({ quantity: 20 });
    await call("/api/cms/inventory/locations/assign", { method: "POST", token: s.token, key: newKey(), body: {
      rawItemId: String(s.item._id), warehouseId: String(s.wh._id), locationId: String(s.stock._id), quantity: 8,
    } });
    const body = { direction: "debit", reason: ISSUE_REASON, items: [{ rawItemId: String(s.item._id), issuedQty: 6, issuedUnit: "PCS", warehouseId: String(s.wh._id), locationId: String(s.stock._id) }] };
    const [a, b] = await Promise.all([
      call("/api/cms/inventory/stock-adjustments/issue", { method: "POST", token: s.token, key: newKey(), body }),
      call("/api/cms/inventory/stock-adjustments/issue", { method: "POST", token: s.token, key: newKey(), body }),
    ]);
    const oks = [a, b].filter((r) => r.status === 200 || r.status === 201).length;
    expect(oks).toBe(1);
    const view = await call(`/api/cms/inventory/locations/item/${s.item._id}`, { token: s.token });
    const bal = view.body.item.balances.find((x) => x.locationId === String(s.stock._id));
    expect(bal.onHand).toBe(2);
  });
});
