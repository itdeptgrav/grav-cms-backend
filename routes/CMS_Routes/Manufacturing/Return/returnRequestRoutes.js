// routes/CMS_Routes/Manufacturing/Return/returnRequestRoutes.js
// Mount: app.use("/api/cms/manufacturing/return-requests", returnRequestRoutes);

const express  = require("express");
const router   = express.Router();
const mongoose = require("mongoose");

const EmployeeAuthMiddleware     = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const ReturnRequest              = require("../../../../models/CMS_Models/Manufacturing/Return/ReturnRequest");
const CustomerRequest            = require("../../../../models/Customer_Models/CustomerRequest");
const WorkOrder                  = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const Measurement                = require("../../../../models/Customer_Models/Measurement");
const EmployeeProductionProgress = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress");
const StockItem                  = require("../../../../models/CMS_Models/Inventory/Products/StockItem");
const Customer                   = require("../../../../models/Customer_Models/Customer");
const EmployeeMpc                = require("../../../../models/Customer_Models/Employee_Mpc");

router.use(EmployeeAuthMiddleware);

async function generateReturnRequestNumber() {
  const now      = new Date();
  const dateStr  = now.toISOString().slice(0, 10).replace(/-/g, "");
  const startDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const endDay   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  const count    = await ReturnRequest.countDocuments({ createdAt: { $gte: startDay, $lte: endDay } });
  return `RR-${dateStr}-${String(count + 1).padStart(4, "0")}`;
}

// ─── GET dispatched-employees ─────────────────────────────────────────────────
router.get("/manufacturing-orders/:moId/dispatched-employees", async (req, res) => {
  try {
    const { moId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(moId))
      return res.status(400).json({ success: false, message: "Invalid MO id" });

    const docs = await EmployeeProductionProgress.find({
      manufacturingOrderId: new mongoose.Types.ObjectId(moId),
      isDispatched: true, packagedUnits: { $gt: 0 },
    }).lean();

    if (!docs.length) return res.json({ success: true, employees: [], totals: { employees: 0, units: 0 } });

    const woIds = [...new Set(docs.map((d) => d.workOrderId.toString()))];
    const wos   = await WorkOrder.find({ _id: { $in: woIds } })
      .select("workOrderNumber stockItemId stockItemName stockItemReference variantId variantAttributes").lean();
    const woMap = new Map(wos.map((w) => [w._id.toString(), w]));

    const empMap = new Map();
    for (const doc of docs) {
      const empKey = doc.employeeId?.toString(); if (!empKey) continue;
      const wo = woMap.get(doc.workOrderId.toString());
      if (!empMap.has(empKey)) {
        empMap.set(empKey, { employeeId: doc.employeeId, employeeName: doc.employeeName, employeeUIN: doc.employeeUIN, gender: doc.gender || "", department: "", designation: "", products: [], totalDispatchedUnits: 0 });
      }
      const rec = empMap.get(empKey);
      rec.products.push({
        progressDocId: doc._id, workOrderId: doc.workOrderId,
        workOrderNumber: wo?.workOrderNumber || "—",
        stockItemId: wo?.stockItemId || null, stockItemIdStr: wo?.stockItemId?.toString() || "",
        woVariantId: wo?.variantId || "",
        productName: wo?.stockItemName || "—", displayProductName: wo?.stockItemName || "—",
        productRef: wo?.stockItemReference || "", variantAttributes: wo?.variantAttributes || [],
        dispatchedUnits: doc.packagedUnits || 0,
      });
      rec.totalDispatchedUnits += doc.packagedUnits || 0;
    }

    const empIds = [...empMap.keys()].filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (empIds.length) {
      const mpcDocs = await EmployeeMpc.find({ _id: { $in: empIds.map((id) => new mongoose.Types.ObjectId(id)) } })
        .select("_id department designation products").lean();
      const mpcMap = new Map(mpcDocs.map((e) => [e._id.toString(), e]));
      for (const [empId, empData] of empMap.entries()) {
        const mpc = mpcMap.get(empId); if (!mpc) continue;
        empData.department = mpc.department || ""; empData.designation = mpc.designation || "";
        for (const prod of empData.products) {
          const siStr = prod.stockItemIdStr, woVarStr = prod.woVariantId?.toString() || "";
          let mpcProd = null;
          if (woVarStr) mpcProd = (mpc.products || []).find((p) => p.productId?.toString() === siStr && p.variantId?.toString() === woVarStr);
          if (!mpcProd) mpcProd = (mpc.products || []).find((p) => p.productId?.toString() === siStr);
          if (mpcProd && typeof mpcProd.productName === "string" && mpcProd.productName.trim()) prod.displayProductName = mpcProd.productName.trim();
        }
      }
    }

    const employees = [...empMap.values()].sort((a, b) => a.employeeName.localeCompare(b.employeeName));
    return res.json({ success: true, employees, totals: { employees: employees.length, units: employees.reduce((s, e) => s + e.totalDispatchedUnits, 0) } });
  } catch (err) { console.error("dispatched-employees error:", err); return res.status(500).json({ success: false, message: "Server error" }); }
});

// ─── POST / — create return request ──────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const { originalMoId, dispatchType, createdByType, persons, bulkProducts, notes } = req.body;
    if (!mongoose.Types.ObjectId.isValid(originalMoId)) return res.status(400).json({ success: false, message: "Invalid originalMoId" });
    if (!["person_wise", "bulk"].includes(dispatchType)) return res.status(400).json({ success: false, message: "Invalid dispatchType" });

    const originalMo = await CustomerRequest.findById(originalMoId).select("requestId customerId customerInfo").lean();
    if (!originalMo) return res.status(404).json({ success: false, message: "Original MO not found" });

    const enrichProduct = async (prod) => {
      if (!prod.workOrderId || !mongoose.Types.ObjectId.isValid(prod.workOrderId)) return prod;
      const wo = await WorkOrder.findById(prod.workOrderId).select("workOrderNumber stockItemId stockItemName stockItemReference variantId variantAttributes").lean();
      if (!wo) return prod;
      return { workOrderId: prod.workOrderId, workOrderNumber: wo.workOrderNumber || "", stockItemId: wo.stockItemId || null, variantId: wo.variantId || "", productName: wo.stockItemName || prod.productName || "—", productRef: wo.stockItemReference || "", variantAttributes: wo.variantAttributes || [], returnQuantity: prod.returnQuantity };
    };

    let enrichedPersons = [], enrichedBulk = [];
    let totalReturnUnits = 0, totalPersons = 0, totalProducts = 0;

    if (dispatchType === "person_wise") {
      for (const person of (persons || [])) {
        const prods = await Promise.all((person.products || []).map(enrichProduct));
        const valid = prods.filter((p) => p.returnQuantity > 0);
        if (!valid.length) continue;
        const unitSum = valid.reduce((s, p) => s + p.returnQuantity, 0);
        enrichedPersons.push({ ...person, products: valid, totalReturnUnits: unitSum });
        totalReturnUnits += unitSum; totalPersons += 1; totalProducts += valid.length;
      }
      if (!enrichedPersons.length) return res.status(400).json({ success: false, message: "No valid persons" });
    } else {
      enrichedBulk = await Promise.all((bulkProducts || []).filter((p) => p.returnQuantity > 0).map(enrichProduct));
      if (!enrichedBulk.length) return res.status(400).json({ success: false, message: "No valid products" });
      totalReturnUnits = enrichedBulk.reduce((s, p) => s + p.returnQuantity, 0);
      totalProducts = enrichedBulk.length;
    }

    const returnRequestNumber = await generateReturnRequestNumber();
    const returnRequest = await ReturnRequest.create({
      returnRequestNumber, originalMoId, originalRequestId: originalMo.requestId || "",
      customerId: originalMo.customerId || null, customerName: originalMo.customerInfo?.name || "—",
      customerInfo: originalMo.customerInfo || null, dispatchType,
      persons: dispatchType === "person_wise" ? enrichedPersons : [],
      bulkProducts: dispatchType === "bulk" ? enrichedBulk : [],
      totalReturnUnits, totalPersons, totalProducts,
      createdByType: createdByType || "dispatch", createdByEmployee: req.user?.id || null,
      notes: notes || "",
    });

    return res.json({ success: true, message: `Return request ${returnRequestNumber} created`, returnRequest, returnRequestNumber });
  } catch (err) { console.error("Create return request error:", err); return res.status(500).json({ success: false, message: "Server error", error: err.message }); }
});

// ─── GET /manufacturing-orders/:moId — list with search + pagination ──────────
router.get("/manufacturing-orders/:moId", async (req, res) => {
  try {
    const { moId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(moId)) return res.status(400).json({ success: false, message: "Invalid MO id" });
    const { page = 1, limit = 15, status = "", search = "" } = req.query;
    const pg = Math.max(1, parseInt(page, 10)), lm = Math.max(1, parseInt(limit, 10));
    const base = { originalMoId: new mongoose.Types.ObjectId(moId) };
    const filter = { ...base };
    if (status) filter.status = status;
    if (search && search.trim()) {
      const re = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ returnRequestNumber: re }, { customerName: re }, { "persons.employeeName": re }, { "persons.employeeUIN": re }, { "persons.products.productName": re }, { "bulkProducts.productName": re }];
    }
    const [total, returnRequests] = await Promise.all([
      ReturnRequest.countDocuments(filter),
      ReturnRequest.find(filter).sort({ createdAt: -1 }).skip((pg - 1) * lm).limit(lm).lean(),
    ]);
    const [pending, processing, moCreated, rejected] = await Promise.all([
      ReturnRequest.countDocuments({ ...base, status: "pending" }),
      ReturnRequest.countDocuments({ ...base, status: "store_processing" }),
      ReturnRequest.countDocuments({ ...base, status: "mo_created" }),
      ReturnRequest.countDocuments({ ...base, status: "rejected" }),
    ]);
    return res.json({ success: true, returnRequests, totals: { total: await ReturnRequest.countDocuments(base), pending, store_processing: processing, mo_created: moCreated, rejected }, pagination: { page: pg, limit: lm, total, totalPages: Math.ceil(total / lm) } });
  } catch (err) { return res.status(500).json({ success: false, message: "Server error" }); }
});

// ─── GET /:id ─────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Invalid id" });
    const rr = await ReturnRequest.findById(req.params.id).lean();
    if (!rr) return res.status(404).json({ success: false, message: "Not found" });
    return res.json({ success: true, returnRequest: rr });
  } catch { return res.status(500).json({ success: false, message: "Server error" }); }
});

// ─── PATCH /:id/start-processing ──────────────────────────────────────────────
router.patch("/:id/start-processing", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Invalid id" });
    const rr = await ReturnRequest.findById(req.params.id);
    if (!rr) return res.status(404).json({ success: false, message: "Not found" });
    if (rr.status !== "pending") return res.status(400).json({ success: false, message: `Current status: ${rr.status}` });
    rr.status = "store_processing"; rr.processingStartedBy = req.user?.id || null; rr.processingStartedAt = new Date();
    rr.returnDispatchStatus = "in_progress";
    for (const p of rr.persons || []) { p.returnDispatchStatus = "in_progress"; for (const pr of p.products || []) pr.returnDispatchStatus = "in_progress"; }
    for (const p of rr.bulkProducts || []) p.returnDispatchStatus = "in_progress";
    rr.markModified("persons"); rr.markModified("bulkProducts");
    await rr.save();

    return res.json({ success: true, returnRequest: rr });
  } catch { return res.status(500).json({ success: false, message: "Server error" }); }
});

// ─── PATCH /:id/reject ────────────────────────────────────────────────────────
router.patch("/:id/reject", async (req, res) => {
  try {
    const { rejectionReason } = req.body;
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Invalid id" });
    if (!rejectionReason?.trim()) return res.status(400).json({ success: false, message: "Rejection reason required" });
    const rr = await ReturnRequest.findById(req.params.id);
    if (!rr) return res.status(404).json({ success: false, message: "Not found" });
    if (!["pending", "store_processing"].includes(rr.status)) return res.status(400).json({ success: false, message: `Cannot reject — status: ${rr.status}` });
    rr.status = "rejected"; rr.rejectedBy = req.user?.id || null; rr.rejectedAt = new Date(); rr.rejectionReason = rejectionReason.trim();
    await rr.save();
    return res.json({ success: true, returnRequest: rr });
  } catch { return res.status(500).json({ success: false, message: "Server error" }); }
});

// ─── PATCH /:id/dispatch-return — mark products as dispatched (global or per-product) ──
// Body: { mode: "all" } OR { mode: "product", personIndex, productIndex }
router.patch("/:id/dispatch-return", async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ success: false, message: "Invalid id" });
    const rr = await ReturnRequest.findById(id);
    if (!rr) return res.status(404).json({ success: false, message: "Not found" });
    
    if (!["store_processing", "mo_created"].includes(rr.status)) return res.status(400).json({ success: false, message: `Can only dispatch when status is store_processing or mo_created (current: ${rr.status})` });

    const { mode = "all", personIndex, productIndex } = req.body;
    const now = new Date();
    const dispatchedBy = req.user?.name || req.user?.id?.toString() || "Store";

    if (rr.dispatchType === "person_wise") {
      if (mode === "all") {
        for (const person of rr.persons) {
          for (const prod of person.products || []) {
            if (prod.returnDispatchStatus !== "dispatched") { prod.returnDispatchStatus = "dispatched"; prod.returnDispatchedAt = now; prod.returnDispatchedBy = dispatchedBy; }
          }
          person.returnDispatchStatus = "dispatched";
        }
        rr.returnDispatchStatus = "dispatched"; rr.returnDispatchedAt = now; rr.returnDispatchedBy = dispatchedBy;
      } else if (mode === "product" && personIndex != null && productIndex != null) {
        const person = rr.persons[personIndex];
        if (!person) return res.status(400).json({ success: false, message: "Invalid personIndex" });
        const prod = person.products[productIndex];
        if (!prod) return res.status(400).json({ success: false, message: "Invalid productIndex" });
        prod.returnDispatchStatus = "dispatched"; prod.returnDispatchedAt = now; prod.returnDispatchedBy = dispatchedBy;
        // Update person status
        const allDisp = person.products.every((p) => p.returnDispatchStatus === "dispatched");
        const anyDisp = person.products.some((p) => p.returnDispatchStatus === "dispatched");
        person.returnDispatchStatus = allDisp ? "dispatched" : anyDisp ? "partial" : "in_progress";
        // Update top-level
        const allPersonsDisp = rr.persons.every((p) => p.returnDispatchStatus === "dispatched");
        const anyPersonDisp  = rr.persons.some((p) => ["dispatched", "partial"].includes(p.returnDispatchStatus));
        rr.returnDispatchStatus = allPersonsDisp ? "dispatched" : anyPersonDisp ? "partial" : "in_progress";
        if (allPersonsDisp) { rr.returnDispatchedAt = now; rr.returnDispatchedBy = dispatchedBy; }
      }
    } else {
      // Bulk
      if (mode === "all") {
        for (const prod of rr.bulkProducts || []) { prod.returnDispatchStatus = "dispatched"; prod.returnDispatchedAt = now; prod.returnDispatchedBy = dispatchedBy; }
        rr.returnDispatchStatus = "dispatched"; rr.returnDispatchedAt = now; rr.returnDispatchedBy = dispatchedBy;
      } else if (mode === "product" && productIndex != null) {
        const prod = rr.bulkProducts[productIndex];
        if (!prod) return res.status(400).json({ success: false, message: "Invalid productIndex" });
        prod.returnDispatchStatus = "dispatched"; prod.returnDispatchedAt = now; prod.returnDispatchedBy = dispatchedBy;
        const allDisp = rr.bulkProducts.every((p) => p.returnDispatchStatus === "dispatched");
        const anyDisp = rr.bulkProducts.some((p) => p.returnDispatchStatus === "dispatched");
        rr.returnDispatchStatus = allDisp ? "dispatched" : anyDisp ? "partial" : "in_progress";
        if (allDisp) { rr.returnDispatchedAt = now; rr.returnDispatchedBy = dispatchedBy; }
      }
    }

    rr.markModified("persons"); rr.markModified("bulkProducts");
    await rr.save();
    return res.json({ success: true, returnRequest: rr, message: "Return dispatch status updated" });
  } catch (err) { console.error("dispatch-return error:", err); return res.status(500).json({ success: false, message: "Server error" }); }
});

// ─── POST /:id/create-mo — full auto MO creation ─────────────────────────────
router.post("/:id/create-mo", async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ success: false, message: "Invalid id" });
    const rr = await ReturnRequest.findById(id);
    if (!rr) return res.status(404).json({ success: false, message: "Not found" });
    if (rr.status !== "store_processing") return res.status(400).json({ success: false, message: `Need store_processing (current: ${rr.status})` });

    const finalPersons      = Array.isArray(req.body.persons)      ? req.body.persons      : rr.persons;
    const finalBulkProducts = Array.isArray(req.body.bulkProducts) ? req.body.bulkProducts : rr.bulkProducts;
    const processingNotes   = req.body.notes || "";

    const originalMo = await CustomerRequest.findById(rr.originalMoId).select("customerId customerInfo priority").lean();
    if (!originalMo) return res.status(404).json({ success: false, message: "Original MO not found" });
    const customer = await Customer.findById(originalMo.customerId).select("name email phone profile").lean();
    const requestCount = await CustomerRequest.countDocuments();
    const newRequestId = `REQ-${new Date().getFullYear()}-${String(requestCount + 1).padStart(4, "0")}`;

    let newMeasurement = null, newRequest = null;
    const createdWorkOrders = [];

    if (rr.dispatchType === "person_wise") {
      const validPersons = finalPersons.filter((p) => p.products?.some((pr) => (pr.returnQuantity || 0) > 0));
      if (!validPersons.length) return res.status(400).json({ success: false, message: "No valid persons" });

      const siMap = new Map();
      for (const person of validPersons) {
        for (const prod of person.products || []) {
          const qty = prod.returnQuantity || 0; if (qty <= 0) continue;
          const key = `${prod.stockItemId?.toString()}_${prod.variantId || ""}`;
          if (!siMap.has(key)) siMap.set(key, { stockItemId: prod.stockItemId, variantId: prod.variantId || "", productName: prod.productName, productRef: prod.productRef || "", variantAttributes: prod.variantAttributes || [], totalQty: 0, persons: [] });
          const entry = siMap.get(key);
          entry.totalQty += qty;
          entry.persons.push({ employeeId: person.employeeId, employeeName: person.employeeName, employeeUIN: person.employeeUIN, gender: person.gender || "", qty });
        }
      }

      const siIds = [...new Set([...siMap.values()].map((e) => e.stockItemId?.toString()).filter(Boolean))];
      const siDocs = await StockItem.find({ _id: { $in: siIds } }).lean();
      const siDocMap = new Map(siDocs.map((s) => [s._id.toString(), s]));

      const requestItems = [...siMap.values()].map((entry) => ({ stockItemId: entry.stockItemId, stockItemName: entry.productName, stockItemReference: entry.productRef || siDocMap.get(entry.stockItemId?.toString())?.reference || "", variants: [{ variantId: entry.variantId || `VAR-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`, attributes: entry.variantAttributes, quantity: entry.totalQty, specialInstructions: [], estimatedPrice: 0 }], totalQuantity: entry.totalQty, totalEstimatedPrice: 0 }));
      const employeeMeasurements = validPersons.map((person) => ({ employeeId: person.employeeId, employeeName: person.employeeName, employeeUIN: person.employeeUIN || "", gender: person.gender || "", products: (person.products || []).filter((p) => (p.returnQuantity || 0) > 0).map((prod) => ({ productId: prod.stockItemId, productName: prod.productName, variantId: prod.variantId || null, variantName: (prod.variantAttributes || []).map((v) => v.value).join(" / ") || "Default", quantity: prod.returnQuantity, measurements: [], measuredAt: new Date() })), noProductAssigned: false, categoryMeasurements: [], isCompleted: true, completedAt: new Date(), remarks: `Return ${rr.returnRequestNumber}` }));

      newMeasurement = new Measurement({ organizationId: originalMo.customerId, organizationName: customer?.name || rr.customerName || "", name: `Return-${rr.returnRequestNumber}`, description: `Auto-created for return request ${rr.returnRequestNumber}. Original MO: ${rr.originalRequestId}`, registeredEmployeeIds: validPersons.map((p) => p.employeeId).filter(Boolean), employeeMeasurements, totalRegisteredEmployees: validPersons.length, measuredEmployees: validPersons.length, pendingEmployees: 0, completionRate: 100, convertedToPO: false, createdBy: req.user?.id || null });
      await newMeasurement.save();

      newRequest = new CustomerRequest({ requestId: newRequestId, customerId: originalMo.customerId, requestType: "measurement_conversion", measurementId: newMeasurement._id, measurementName: `Return-${rr.returnRequestNumber}`, customerInfo: { ...originalMo.customerInfo, description: `Return order. Original MO: ${rr.originalRequestId}. Return Req: ${rr.returnRequestNumber}`, deliveryDeadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) }, items: requestItems, status: "pending", priority: "high", processingStartedAt: new Date(), processingStartedBy: req.user?.id || null });
      await newRequest.save();

      newRequest.quotations.push({ quotationNumber: `QT-${newRequestId}-001`, date: new Date(), validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), items: requestItems.map((item) => ({ stockItemId: item.stockItemId, itemName: item.stockItemName, quantity: item.totalQuantity, unitPrice: 0, gstPercentage: 0, priceBeforeGST: 0, gstAmount: 0, priceIncludingGST: 0, discountPercentage: 0, discountAmount: 0 })), subtotalBeforeGST: 0, totalDiscount: 0, totalGST: 0, shippingCharges: 0, grandTotal: 0, customAdditionalCharges: [], paymentSchedule: [], paymentSubmissions: [], status: "sales_approved", preparedBy: req.user?.id || null, customerApproval: { approved: true, approvedAt: new Date(), notes: "Auto-approved — return order" }, salesApproval: { approved: true, approvedAt: new Date(), approvedBy: req.user?.id || null, notes: "Auto-approved — return order" }, createdAt: new Date(), updatedAt: new Date() });
      newRequest.status = "quotation_sales_approved"; newRequest.finalOrderPrice = 0;
      newRequest.notes.push({ text: `Auto-created for return request ${rr.returnRequestNumber}.${processingNotes ? " Notes: " + processingNotes : ""}`, addedBy: req.user?.id || null, addedByModel: "SalesDepartment" });
      await newRequest.save();
      await Measurement.findByIdAndUpdate(newMeasurement._id, { convertedToPO: true, poRequestId: newRequest._id, poConversionDate: new Date(), convertedBy: req.user?.id || null });

      for (const entry of siMap.values()) {
        const si = siDocMap.get(entry.stockItemId?.toString());
        const operations = (si?.operations || []).map((op) => ({ operationType: op.type || op.operationType || "", operationCode: op.operationCode || "", plannedTimeSeconds: op.totalSeconds || 0, status: "pending" }));
        let variantData = entry.variantId && si?.variants?.length ? si.variants.find((v) => v._id.toString() === entry.variantId) : null;
        if (!variantData && si?.variants?.length) variantData = si.variants[0];
        const rawMaterials = (variantData?.rawItems || []).map((ri) => ({ rawItemId: ri.rawItemId, name: ri.rawItemName, sku: ri.rawItemSku || "", rawItemVariantId: ri.variantId || null, rawItemVariantCombination: ri.variantCombination || [], quantityRequired: (ri.quantity || 0) * entry.totalQty, quantityAllocated: 0, quantityIssued: 0, unit: ri.unit, unitCost: ri.unitCost || 0, totalCost: (ri.totalCost || 0) * entry.totalQty, allocationStatus: "not_allocated" }));
        const wo = new WorkOrder({ customerRequestId: newRequest._id, stockItemId: entry.stockItemId, stockItemName: entry.productName, stockItemReference: entry.productRef || si?.reference || "", variantId: entry.variantId || variantData?._id?.toString() || "", variantAttributes: entry.variantAttributes.length ? entry.variantAttributes : (variantData?.attributes || []), quantity: entry.totalQty, customerId: originalMo.customerId, customerName: originalMo.customerInfo?.name || "", priority: "high", status: "pending", operations, rawMaterials, estimatedCost: rawMaterials.reduce((s, rm) => s + (rm.totalCost || 0), 0), actualCost: 0, createdBy: req.user?.id || null });
        await wo.save();
        createdWorkOrders.push({ ...entry, woDoc: wo });
      }

      for (const woEntry of createdWorkOrders) {
        let unitCursor = 1;
        for (const person of woEntry.persons) {
          const unitStart = unitCursor, unitEnd = unitCursor + person.qty - 1;
          const barcodes = [];
          for (let u = unitStart; u <= unitEnd; u++) barcodes.push(`${woEntry.woDoc.workOrderNumber}-${u.toString().padStart(3, "0")}`);
          try { await EmployeeProductionProgress.findOneAndUpdate({ workOrderId: woEntry.woDoc._id, employeeId: person.employeeId }, { $set: { measurementId: newMeasurement._id, manufacturingOrderId: newRequest._id, employeeName: person.employeeName, employeeUIN: person.employeeUIN || "", gender: person.gender || "", unitStart, unitEnd, totalUnits: person.qty, assignedBarcodeIds: barcodes, completedUnits: 0, completedUnitNumbers: [], completionPercentage: 0, packagedUnits: 0, isFullyPackaged: false, isDispatched: false, lastSyncedAt: new Date() } }, { upsert: true, new: true }); }
          catch (e) { console.error(`Progress doc error for ${person.employeeName}:`, e.message); }
          unitCursor = unitEnd + 1;
        }
      }
    } else {
      const validBulk = (finalBulkProducts || []).filter((p) => (p.returnQuantity || 0) > 0);
      if (!validBulk.length) return res.status(400).json({ success: false, message: "No valid products" });
      const siIds = [...new Set(validBulk.map((p) => p.stockItemId?.toString()).filter(Boolean))];
      const siDocs = await StockItem.find({ _id: { $in: siIds } }).lean();
      const siDocMap = new Map(siDocs.map((s) => [s._id.toString(), s]));
      const requestItems = validBulk.map((prod) => ({ stockItemId: prod.stockItemId, stockItemName: prod.productName, stockItemReference: prod.productRef || siDocMap.get(prod.stockItemId?.toString())?.reference || "", variants: [{ variantId: prod.variantId || `VAR-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`, attributes: prod.variantAttributes || [], quantity: prod.returnQuantity, specialInstructions: [], estimatedPrice: 0 }], totalQuantity: prod.returnQuantity, totalEstimatedPrice: 0 }));
      newRequest = new CustomerRequest({ requestId: newRequestId, customerId: originalMo.customerId, requestType: "customer_request", customerInfo: { ...originalMo.customerInfo, description: `Return order. Original MO: ${rr.originalRequestId}. Return Req: ${rr.returnRequestNumber}`, deliveryDeadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) }, items: requestItems, status: "pending", priority: "high", processingStartedAt: new Date(), processingStartedBy: req.user?.id || null });
      await newRequest.save();
      newRequest.quotations.push({ quotationNumber: `QT-${newRequestId}-001`, date: new Date(), validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), items: requestItems.map((item) => ({ stockItemId: item.stockItemId, itemName: item.stockItemName, quantity: item.totalQuantity, unitPrice: 0, gstPercentage: 0, priceBeforeGST: 0, gstAmount: 0, priceIncludingGST: 0, discountPercentage: 0, discountAmount: 0 })), subtotalBeforeGST: 0, totalDiscount: 0, totalGST: 0, shippingCharges: 0, grandTotal: 0, customAdditionalCharges: [], paymentSchedule: [], paymentSubmissions: [], status: "sales_approved", preparedBy: req.user?.id || null, customerApproval: { approved: true, approvedAt: new Date(), notes: "Auto-approved — return order" }, salesApproval: { approved: true, approvedAt: new Date(), approvedBy: req.user?.id || null, notes: "Auto-approved — return order" }, createdAt: new Date(), updatedAt: new Date() });
      newRequest.status = "quotation_sales_approved"; newRequest.finalOrderPrice = 0;
      newRequest.notes.push({ text: `Auto-created for return request ${rr.returnRequestNumber}.${processingNotes ? " Notes: " + processingNotes : ""}`, addedBy: req.user?.id || null, addedByModel: "SalesDepartment" });
      await newRequest.save();
      for (const prod of validBulk) {
        const si = siDocMap.get(prod.stockItemId?.toString());
        const operations = (si?.operations || []).map((op) => ({ operationType: op.type || op.operationType || "", operationCode: op.operationCode || "", plannedTimeSeconds: op.totalSeconds || 0, status: "pending" }));
        let variantData = prod.variantId && si?.variants?.length ? si.variants.find((v) => v._id.toString() === prod.variantId) : null;
        if (!variantData && si?.variants?.length) variantData = si.variants[0];
        const rawMaterials = (variantData?.rawItems || []).map((ri) => ({ rawItemId: ri.rawItemId, name: ri.rawItemName, sku: ri.rawItemSku || "", rawItemVariantId: ri.variantId || null, rawItemVariantCombination: ri.variantCombination || [], quantityRequired: (ri.quantity || 0) * prod.returnQuantity, quantityAllocated: 0, quantityIssued: 0, unit: ri.unit, unitCost: ri.unitCost || 0, totalCost: (ri.totalCost || 0) * prod.returnQuantity, allocationStatus: "not_allocated" }));
        const wo = new WorkOrder({ customerRequestId: newRequest._id, stockItemId: prod.stockItemId, stockItemName: prod.productName, stockItemReference: prod.productRef || si?.reference || "", variantId: prod.variantId || variantData?._id?.toString() || "", variantAttributes: (prod.variantAttributes || []).length ? prod.variantAttributes : (variantData?.attributes || []), quantity: prod.returnQuantity, customerId: originalMo.customerId, customerName: originalMo.customerInfo?.name || "", priority: "high", status: "pending", operations, rawMaterials, estimatedCost: rawMaterials.reduce((s, rm) => s + (rm.totalCost || 0), 0), actualCost: 0, createdBy: req.user?.id || null });
        await wo.save(); createdWorkOrders.push(wo);
      }
    }

    // Set all products to "in_progress" since MO is now created
    rr.status = "mo_created"; rr.newMoId = newRequest._id; rr.newRequestId = newRequest.requestId;
    rr.newMeasurementId = newMeasurement?._id || null;
    rr.processedPersons = rr.dispatchType === "person_wise" ? finalPersons : [];
    rr.processedBulkProducts = rr.dispatchType === "bulk" ? finalBulkProducts : [];
    rr.returnDispatchStatus = "in_progress";
    // Mark all products as in_progress
    for (const person of rr.persons) { person.returnDispatchStatus = "in_progress"; for (const prod of person.products || []) { prod.returnDispatchStatus = "in_progress"; } }
    for (const prod of rr.bulkProducts || []) { prod.returnDispatchStatus = "in_progress"; }
    rr.markModified("persons"); rr.markModified("bulkProducts");
    await rr.save();

    return res.json({ success: true, message: `New MO ${newRequest.requestId} created from return request ${rr.returnRequestNumber}`, returnRequest: rr, newMoId: newRequest._id, newRequestId: newRequest.requestId, newMeasurementId: newMeasurement?._id || null, workOrdersCreated: createdWorkOrders.length });
  } catch (err) { console.error("create-mo error:", err); return res.status(500).json({ success: false, message: "Server error", error: err.message }); }
});

module.exports = router;