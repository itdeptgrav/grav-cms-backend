// test/store-purchase/po-material-link-repair.route.test.js
//
// PATCH /api/cms/inventory/operations/purchase-orders/:id/lines/:lineId/material-link
//
// A legacy purchase-order line saved without a material cannot be received.
// This command supplies that ONE missing identity and nothing else. These
// tests prove every refusal the service names, that nothing commercial moves,
// that the repair is written to history with its reason, and that a retry is
// a replay rather than a second write.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

jest.mock("../../services/VendorEmailService", () => ({ sendPurchaseOrderEmail: jest.fn(() => Promise.resolve()) }));
jest.mock("../../services/NotificationService", () => ({
  sendToRole: jest.fn(() => Promise.resolve()), sendToUser: jest.fn(() => Promise.resolve()),
}));

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

require("../../models/ProjectManager");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const Unit = require("../../models/CMS_Models/Inventory/Configurations/Unit");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SpActionHistory = require("../../models/CMS_Models/StorePurchase/SpActionHistory");
const GoodsReceipt = require("../../models/CMS_Models/StorePurchase/GoodsReceipt");
const { CAPABILITIES, GRANTS } = require("../../services/storePurchase/capabilities");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/inventory/operations/purchase-orders", require("../../routes/CMS_Routes/Inventory/Operations/purchaseOrders"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const tokenFor = (over = {}) => jwt.sign(
  { id: String(new mongoose.Types.ObjectId()), role: "store_manager", employeeId: `ST${seq}`, name: "Test Store", email: "store@test.example", ...over },
  process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
);

const call = (path, { method = "GET", body, token = tokenFor(), auth = true, idempotencyKey } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({
    status: r.status,
    body: JSON.parse((await r.text()) || "null"),
    replayed: r.headers.get("Idempotency-Replayed") === "true",
  }));

async function actor({ company, grant = "store", role = "approver", name = "Tester" } = {}) {
  const n = ++seq;
  const email = `sp${n}@test.example`;
  const employeeRef = new mongoose.Types.ObjectId();
  if (grant) await DepartmentRole.create({ departmentSlug: grant, email, role, name, isActive: true });
  if (company) await SpCompanyMembership.create({ companyId: company._id, email, employeeRef, personName: name });
  return { email, employeeRef, token: tokenFor({ id: String(employeeRef), email, name }) };
}

const company = (label) => Acc_Company.create({ companyName: `${label} ${++seq}`, booksFromDate: new Date("2026-04-01") });
const newKey = () => `test-key-${++seq}-${Math.random().toString(36).slice(2)}`;

/** A catalogue material of one company. `variants` are combinations. */
const material = (companyId, { unit = "m", variants = [], name } = {}) => RawItem.create({
  name: name || `Gripper ${++seq}`, sku: `GRP-${seq}`, unit, quantity: 0, minStock: 0, companyId,
  variants: variants.map((combination, i) => ({ combination, sku: `GRP-${seq}-V${i + 1}` })),
});

/** An ISSUED order with one legacy line that has no material link. */
async function issuedOrder(companyId, { unit = "m", line = {}, over = {} } = {}) {
  const vendor = await Vendor.create({ companyName: `Vendor ${++seq}`, contactPerson: "V", phone: "9", status: "Active" });
  const po = await PurchaseOrder.create({
    companyId, poNumber: `PO/T/${seq}`, status: "ISSUED", vendor: vendor._id, vendorName: vendor.companyName,
    createdBy: new mongoose.Types.ObjectId(),
    items: [{
      itemName: "WaistBand Gripper Carbon", sku: "WBG-CARB", unit, quantity: 300, unitPrice: 40, totalPrice: 12000,
      receivedQuantity: 0, pendingQuantity: 300, status: "PENDING", ...line,
    }],
    totalAmount: 12000, ...over,
  });
  return { po, vendor, lineId: String(po.items[0]._id) };
}

const OPS = "/api/cms/inventory/operations/purchase-orders";
const linkPath = (poId, lineId) => `${OPS}/${poId}/lines/${lineId}/material-link`;
const repair = (po, lineId, body, token, key = newKey()) => call(linkPath(po._id, lineId), { method: "PATCH", body, token, idempotencyKey: key });

/** The commercial facts of the line and order, frozen for comparison. */
const commercial = (po) => {
  const l = po.items[0];
  return {
    itemName: l.itemName, sku: l.sku, unit: l.unit, quantity: l.quantity, unitPrice: l.unitPrice, totalPrice: l.totalPrice,
    gstRate: l.gstRate, gstAmount: l.gstAmount, receivedQuantity: l.receivedQuantity, pendingQuantity: l.pendingQuantity,
    lineStatus: l.status, status: po.status, vendor: String(po.vendor), vendorName: po.vendorName,
    totalAmount: po.totalAmount, approvedBy: po.approvedBy ? String(po.approvedBy) : null, deliveries: (po.deliveries || []).length,
  };
};

/* ═══ 1 · AUTHORISATION ═══════════════════════════════════════════════════ */

describe("authorisation", () => {
  test("the repair capability is its own grant: approver and owner hold it, editor (who receives) does not", () => {
    expect(CAPABILITIES.PO_REPAIR_LINK).toBe("sp.po.repair");
    expect(GRANTS.store.approver).toContain(CAPABILITIES.PO_REPAIR_LINK);
    expect(GRANTS.store.owner).toContain(CAPABILITIES.PO_REPAIR_LINK);
    expect(GRANTS.store.editor).toContain(CAPABILITIES.RECEIPT_RECORD);
    expect(GRANTS.store.editor).not.toContain(CAPABILITIES.PO_REPAIR_LINK);
  });

  test("a receiver without the repair capability is refused, and told which grant it needs", async () => {
    const a = await company("Acme");
    const editor = await actor({ company: a, role: "editor" });
    const { po, lineId } = await issuedOrder(a._id);
    const m = await material(a._id);
    const res = await repair(po, lineId, { rawItemId: String(m._id) }, editor.token);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    expect(res.body.error.details.required).toContain("sp.po.repair");
    expect(res.body.message).not.toMatch(/sp\./);
    const after = await PurchaseOrder.findById(po._id).lean();
    expect(after.items[0].rawItem).toBeUndefined();
  });

  test("no token, and an authenticated outsider with no grant, are both refused", async () => {
    const a = await company("Acme");
    const outsider = await actor({ company: a, grant: null });
    const { po, lineId } = await issuedOrder(a._id);
    expect((await call(linkPath(po._id, lineId), { method: "PATCH", body: {}, auth: false })).status).toBe(401);
    expect((await repair(po, lineId, { rawItemId: String(new mongoose.Types.ObjectId()) }, outsider.token)).status).toBe(403);
  });
});

/* ═══ 2 · THE SUCCESSFUL REPAIR ═══════════════════════════════════════════ */

describe("a successful repair", () => {
  test("links a non-variant material, changes nothing commercial, and writes the audit entry", async () => {
    const a = await company("Acme");
    const approver = await actor({ company: a });
    const { po, lineId } = await issuedOrder(a._id);
    const before = commercial(await PurchaseOrder.findById(po._id).lean());
    const m = await material(a._id, { name: "WaistBand Gripper Carbon 30mm" });

    const key = newKey();
    const res = await repair(po, lineId, { rawItemId: String(m._id) }, approver.token, key);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.unchanged).toBe(false);
    expect(res.body.message).toBe("Material linked. This line can now be received.");
    expect(res.body.line).toMatchObject({ id: lineId, rawItemId: String(m._id), rawItemName: m.name, rawItemSku: m.sku, variantId: null });
    expect(res.body.unit).toEqual({ poUnit: "m", registeredUnit: "m", factor: 1, same: true });
    /* The order comes back as GET /:id returns it, material populated. */
    expect(res.body.purchaseOrder.items[0].rawItem._id).toBe(String(m._id));
    expect(res.body.purchaseOrder.items[0].rawItem.name).toBe(m.name);

    const after = await PurchaseOrder.findById(po._id).lean();
    expect(String(after.items[0].rawItem)).toBe(String(m._id));
    expect(after.items[0].variantId).toBeNull();
    expect(after.items[0].baseUnit).toBe("m");
    expect(commercial(after)).toEqual(before);

    const history = await SpActionHistory.find({ entityType: "PURCHASE_ORDER", entityId: po._id }).lean();
    expect(history).toHaveLength(1);
    const h = history[0];
    expect(h.action).toBe("MATERIAL_LINK_REPAIRED");
    expect(h.reason).toBe("REPAIR_MISSING_MATERIAL_LINK");
    expect(String(h.companyId)).toBe(String(a._id));
    expect(String(h.actorId)).toBe(String(approver.employeeRef));
    expect(h.at).toBeInstanceOf(Date);
    expect(h.idempotencyKey).toBe(key);
    expect(h.documentNumber).toBe(po.poNumber);
    expect(h.metadata).toMatchObject({
      poId: String(po._id), poNumber: po.poNumber, poLineId: lineId, previousIdentity: "MISSING",
      rawItemId: String(m._id), rawItemName: m.name, rawItemSku: m.sku, variantId: "NOT_APPLICABLE", variantAttributes: [],
      poUnit: "m", registeredUnit: "m", conversionFactor: 1,
    });
    expect(h.changes.map((c) => c.field)).toEqual([`items.${lineId}.rawItem`, `items.${lineId}.variantId`, `items.${lineId}.baseUnit`]);
    expect(h.changes[0]).toMatchObject({ from: null, to: String(m._id) });
  });

  test("the repaired line is what GET /:id serves afterwards — a client refresh sees the link", async () => {
    const a = await company("Acme");
    const approver = await actor({ company: a });
    const { po, lineId } = await issuedOrder(a._id);
    const m = await material(a._id);
    expect((await repair(po, lineId, { rawItemId: String(m._id) }, approver.token)).status).toBe(200);
    const got = await call(`${OPS}/${po._id}`, { token: approver.token });
    expect(got.status).toBe(200);
    expect(got.body.purchaseOrder.items[0].rawItem._id).toBe(String(m._id));
    expect(got.body.purchaseOrder.items[0].quantity).toBe(300);
    expect(got.body.purchaseOrder.status).toBe("ISSUED");
  });
});

/* ═══ 3 · VARIANTS ════════════════════════════════════════════════════════ */

describe("variants", () => {
  test("a material with variants needs the exact variant — none is ever chosen for the caller", async () => {
    const a = await company("Acme");
    const approver = await actor({ company: a });
    const { po, lineId } = await issuedOrder(a._id);
    const m = await material(a._id, { variants: [["Navy", "30mm"], ["Black", "30mm"]] });

    const missing = await repair(po, lineId, { rawItemId: String(m._id) }, approver.token);
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("VALIDATION");
    expect(missing.body.error.details).toMatchObject({ field: "variantId", reason: "VARIANT_REQUIRED", variantCount: 2 });
    expect((await PurchaseOrder.findById(po._id).lean()).items[0].rawItem).toBeUndefined();

    const black = m.variants[1];
    const ok = await repair(po, lineId, { rawItemId: String(m._id), variantId: String(black._id) }, approver.token);
    expect(ok.status).toBe(200);
    expect(ok.body.line).toMatchObject({ variantId: String(black._id), variantSku: black.sku, variantAttributes: ["Black", "30mm"] });
    const after = await PurchaseOrder.findById(po._id).lean();
    expect(String(after.items[0].variantId)).toBe(String(black._id));
    expect(after.items[0].variantCombination).toEqual(["Black", "30mm"]);
    const h = await SpActionHistory.findOne({ entityId: po._id }).lean();
    expect(h.metadata.variantAttributes).toEqual(["Black", "30mm"]);
    expect(h.metadata.variantSku).toBe(black.sku);
  });

  test("a one-variant material still needs that variant named explicitly", async () => {
    const a = await company("Acme");
    const approver = await actor({ company: a });
    const { po, lineId } = await issuedOrder(a._id);
    const m = await material(a._id, { variants: [["Natural"]] });
    expect((await repair(po, lineId, { rawItemId: String(m._id) }, approver.token)).body.error.details.reason).toBe("VARIANT_REQUIRED");
    const ok = await repair(po, lineId, { rawItemId: String(m._id), variantId: String(m.variants[0]._id) }, approver.token);
    expect(ok.status).toBe(200);
    expect(ok.body.line.variantAttributes).toEqual(["Natural"]);
  });

  test("a variant of another material is refused as a mismatch; a variant on a variant-less material is refused too", async () => {
    const a = await company("Acme");
    const approver = await actor({ company: a });
    const { po, lineId } = await issuedOrder(a._id);
    const m = await material(a._id, { variants: [["Navy"]] });
    const other = await material(a._id, { variants: [["Red"]] });
    const mismatch = await repair(po, lineId, { rawItemId: String(m._id), variantId: String(other.variants[0]._id) }, approver.token);
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.details.reason).toBe("VARIANT_MISMATCH");

    const plain = await material(a._id);
    const na = await repair(po, lineId, { rawItemId: String(plain._id), variantId: String(m.variants[0]._id) }, approver.token);
    expect(na.status).toBe(400);
    expect(na.body.error.details.reason).toBe("VARIANT_NOT_APPLICABLE");
    expect((await PurchaseOrder.findById(po._id).lean()).items[0].rawItem).toBeUndefined();
  });

  test("a line that already carries its own variant description keeps it", async () => {
    const a = await company("Acme");
    const approver = await actor({ company: a });
    const { po, lineId } = await issuedOrder(a._id, { line: { variantCombination: ["Navy (supplier wording)"] } });
    const m = await material(a._id, { variants: [["Navy"]] });
    expect((await repair(po, lineId, { rawItemId: String(m._id), variantId: String(m.variants[0]._id) }, approver.token)).status).toBe(200);
    expect((await PurchaseOrder.findById(po._id).lean()).items[0].variantCombination).toEqual(["Navy (supplier wording)"]);
  });
});

/* ═══ 4 · UNITS ═══════════════════════════════════════════════════════════ */

describe("units", () => {
  test("a different unit with no recorded conversion is refused — never assumed 1:1 — and nothing changes", async () => {
    const a = await company("Acme");
    const approver = await actor({ company: a });
    const { po, lineId } = await issuedOrder(a._id, { unit: "m" });
    const kg = await material(a._id, { unit: "kg" });
    const res = await repair(po, lineId, { rawItemId: String(kg._id) }, approver.token);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION");
    expect(res.body.error.details).toMatchObject({ reason: "UOM_CONVERSION_MISSING", poUnit: "m", registeredUnit: "kg" });
    const after = await PurchaseOrder.findById(po._id).lean();
    expect(after.items[0].rawItem).toBeUndefined();
    expect(after.items[0].unit).toBe("m");
    expect(after.items[0].quantity).toBe(300);
    expect(await SpActionHistory.countDocuments({ entityId: po._id })).toBe(0);
  });

  test("a different unit with a recorded conversion links, records the factor, and leaves the PO unit and quantity alone", async () => {
    const a = await company("Acme");
    const approver = await actor({ company: a });
    const metre = await Unit.create({ name: "metre", companyId: a._id });
    await Unit.create({ name: "roll", companyId: a._id, conversions: [{ toUnit: metre._id, quantity: 50 }] });
    const { po, lineId } = await issuedOrder(a._id, { unit: "roll" });
    const m = await material(a._id, { unit: "metre" });
    const res = await repair(po, lineId, { rawItemId: String(m._id) }, approver.token);
    expect(res.status).toBe(200);
    expect(res.body.unit).toEqual({ poUnit: "roll", registeredUnit: "metre", factor: 50, same: false });
    const after = await PurchaseOrder.findById(po._id).lean();
    expect(after.items[0].unit).toBe("roll");
    expect(after.items[0].quantity).toBe(300);
    expect(after.items[0].baseUnit).toBe("metre");
    expect((await SpActionHistory.findOne({ entityId: po._id }).lean()).metadata.conversionFactor).toBe(50);
  });

  test("a material with no registered unit cannot be linked", async () => {
    const a = await company("Acme");
    const approver = await actor({ company: a });
    const { po, lineId } = await issuedOrder(a._id);
    const m = await material(a._id, { unit: "" });
    const res = await repair(po, lineId, { rawItemId: String(m._id) }, approver.token);
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe("MATERIAL_UNIT_MISSING");
  });
});

/* ═══ 5 · COMPANY SCOPE ═══════════════════════════════════════════════════ */

describe("company scope", () => {
  test("another company's material answers exactly as a missing one, and a legacy-global material is never offered", async () => {
    const a = await company("Acme");
    const b = await company("Borealis");
    const approver = await actor({ company: a });
    const { po, lineId } = await issuedOrder(a._id);
    const foreign = await material(b._id);
    const res = await repair(po, lineId, { rawItemId: String(foreign._id) }, approver.token);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    const ghost = await repair(po, lineId, { rawItemId: String(new mongoose.Types.ObjectId()) }, approver.token);
    expect(ghost.status).toBe(404);
    expect(ghost.body.error.code).toBe(res.body.error.code);

    const legacy = await RawItem.create({ name: "Legacy global", sku: `LEG-${++seq}`, unit: "m", quantity: 0, minStock: 0 });
    expect((await repair(po, lineId, { rawItemId: String(legacy._id) }, approver.token)).status).toBe(404);
    expect((await PurchaseOrder.findById(po._id).lean()).items[0].rawItem).toBeUndefined();
  });

  test("another company's order cannot be repaired by this company's approver", async () => {
    const a = await company("Acme");
    const b = await company("Borealis");
    const approverA = await actor({ company: a });
    const { po, lineId } = await issuedOrder(b._id);
    const m = await material(a._id);
    const res = await repair(po, lineId, { rawItemId: String(m._id) }, approverA.token);
    expect(res.status).toBe(404);
  });
});

/* ═══ 6 · LINE STATE ══════════════════════════════════════════════════════ */

describe("line and order state", () => {
  test("a line that already has a link refuses a different material, and answers unchanged for the same one", async () => {
    const a = await company("Acme");
    const approver = await actor({ company: a });
    const linked = await material(a._id);
    const { po, lineId } = await issuedOrder(a._id, { line: { rawItem: linked._id, baseUnit: "m" } });
    const other = await material(a._id);
    const res = await repair(po, lineId, { rawItemId: String(other._id) }, approver.token);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
    expect(res.body.error.details.reason).toBe("LINE_ALREADY_LINKED");
    expect(String((await PurchaseOrder.findById(po._id).lean()).items[0].rawItem)).toBe(String(linked._id));

    const same = await repair(po, lineId, { rawItemId: String(linked._id) }, approver.token);
    expect(same.status).toBe(200);
    expect(same.body.unchanged).toBe(true);
    expect(await SpActionHistory.countDocuments({ entityId: po._id })).toBe(0);
  });

  test("a line with receipt history is refused: a received quantity, or a goods receipt naming the line", async () => {
    const a = await company("Acme");
    const approver = await actor({ company: a });
    const m = await material(a._id);

    const received = await issuedOrder(a._id, { line: { receivedQuantity: 40, pendingQuantity: 260 }, over: { status: "PARTIALLY_RECEIVED" } });
    const r1 = await repair(received.po, received.lineId, { rawItemId: String(m._id) }, approver.token);
    expect(r1.status).toBe(409);
    expect(r1.body.error.code).toBe("LIFECYCLE_BLOCKED");
    expect(r1.body.error.details).toMatchObject({ reason: "LINE_HAS_RECEIPTS", source: "line" });

    const delivered = await issuedOrder(a._id);
    /* An authoritative goods receipt naming the line — inserted directly so
       the check is exercised on the stored shape, not on the receipt engine. */
    await GoodsReceipt.collection.insertOne({
      companyId: a._id, purchaseOrderId: delivered.po._id, sourceDocumentId: delivered.po._id,
      receiptNumber: `GRN/T/${++seq}`, receiptDate: new Date(),
      lines: [{ poItemId: delivered.po.items[0]._id, itemName: "x", quantityReceived: 0, unit: "m" }],
    });
    const r2 = await repair(delivered.po, delivered.lineId, { rawItemId: String(m._id) }, approver.token);
    expect(r2.status).toBe(409);
    expect(r2.body.error.details.source).toBe("goodsReceipts");
    expect((await PurchaseOrder.findById(delivered.po._id).lean()).items[0].rawItem).toBeUndefined();
  });

  test("a draft is sent to the editor; a cancelled or completed order is closed to repair", async () => {
    const a = await company("Acme");
    const approver = await actor({ company: a });
    const m = await material(a._id);
    for (const [status, reason] of [["DRAFT", "ORDER_NOT_ISSUED"], ["CANCELLED", "ORDER_CLOSED"], ["COMPLETED", "ORDER_CLOSED"]]) {
      const { po, lineId } = await issuedOrder(a._id, { over: { status } });
      const res = await repair(po, lineId, { rawItemId: String(m._id) }, approver.token);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("LIFECYCLE_BLOCKED");
      expect(res.body.error.details.reason).toBe(reason);
    }
  });

  test("a missing line, a missing material choice, and a malformed variant are each refused by name", async () => {
    const a = await company("Acme");
    const approver = await actor({ company: a });
    const { po, lineId } = await issuedOrder(a._id);
    const m = await material(a._id);
    expect((await repair(po, String(new mongoose.Types.ObjectId()), { rawItemId: String(m._id) }, approver.token)).status).toBe(404);
    const none = await repair(po, lineId, {}, approver.token);
    expect(none.status).toBe(400);
    expect(none.body.error.details.reason).toBe("MATERIAL_REQUIRED");
    const bad = await repair(po, lineId, { rawItemId: String(m._id), variantId: "not-an-id" }, approver.token);
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.reason).toBe("VARIANT_INVALID");
  });
});

/* ═══ 7 · IDEMPOTENCY ═════════════════════════════════════════════════════ */

describe("retries", () => {
  test("the same key replays the first answer; a new key for the same material is unchanged; the key is required", async () => {
    const a = await company("Acme");
    const approver = await actor({ company: a });
    const { po, lineId } = await issuedOrder(a._id);
    const m = await material(a._id);
    const key = newKey();
    const first = await repair(po, lineId, { rawItemId: String(m._id) }, approver.token, key);
    expect(first.status).toBe(200);
    expect(first.replayed).toBe(false);

    const again = await repair(po, lineId, { rawItemId: String(m._id) }, approver.token, key);
    expect(again.status).toBe(200);
    expect(again.replayed).toBe(true);
    expect(again.body.line).toEqual(first.body.line);

    const fresh = await repair(po, lineId, { rawItemId: String(m._id) }, approver.token);
    expect(fresh.status).toBe(200);
    expect(fresh.body.unchanged).toBe(true);
    /* One repair, one history entry — a retry never writes a second. */
    expect(await SpActionHistory.countDocuments({ entityId: po._id })).toBe(1);

    const { po: po2, lineId: line2 } = await issuedOrder(a._id);
    const noKey = await call(linkPath(po2._id, line2), { method: "PATCH", body: { rawItemId: String(m._id) }, token: approver.token });
    expect(noKey.status).toBe(400);
    expect(noKey.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });
});
