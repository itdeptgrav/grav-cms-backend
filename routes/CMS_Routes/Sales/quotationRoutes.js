// routes/CMS_Routes/Sales/quotationRoutes.js

const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const CustomerRequest = require("../../../models/Customer_Models/CustomerRequest");
const StockItem = require("../../../models/CMS_Models/Inventory/Products/StockItem");
const CustomerEmailService = require('../../../services/CustomerEmailService');
const WorkOrder = require("../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const Measurement = require("../../../models/Customer_Models/Measurement");
const EmployeeProductionProgress = require("../../../models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress");
const mongoose = require("mongoose");
const EmployeeMpc = require("../../../models/Customer_Models/Employee_Mpc");

router.use(EmployeeAuthMiddleware);

// ─── GST RULE ─────────────────────────────────────────────────────────────────
const getGSTPercentage = (unitPrice) => {
  const price = parseFloat(unitPrice) || 0;
  return price < 2499 ? 5 : 18;
};

const calculateItemTotals = (quantity, unitPrice, gstPercentage) => {
  const qty = parseFloat(quantity) || 0;
  const price = parseFloat(unitPrice) || 0;
  const gst = parseFloat(gstPercentage) || 0;
  const priceBeforeGST = qty * price;
  const gstAmount = priceBeforeGST * (gst / 100);
  const priceIncludingGST = priceBeforeGST + gstAmount;
  return {
    priceBeforeGST: parseFloat(priceBeforeGST.toFixed(2)),
    gstAmount: parseFloat(gstAmount.toFixed(2)),
    priceIncludingGST: parseFloat(priceIncludingGST.toFixed(2))
  };
};

// CREATE quotation for a request
router.post("/requests/:requestId/quotation", async (req, res) => {
  try {
    const { requestId } = req.params;
    const quotationData = req.body;
    const request = await CustomerRequest.findById(requestId);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });

    const existingQuotation = request.quotations.length > 0 ? request.quotations[0] : null;
    const quotationNumber = existingQuotation ? existingQuotation.quotationNumber : `QT-${request.requestId}-001`;

    const itemsWithCalculations = await Promise.all(quotationData.items.map(async (item) => {
      let stockItem = null;
      if (item.stockItemId) stockItem = await StockItem.findById(item.stockItemId);
      const unitPrice = parseFloat(item.unitPrice) || 0;
      const gstPercentage = getGSTPercentage(unitPrice);
      const quantity = parseFloat(item.quantity) || 0;
      const { priceBeforeGST, gstAmount, priceIncludingGST } = calculateItemTotals(quantity, unitPrice, gstPercentage);
      const discountPercentage = parseFloat(item.discountPercentage) || 0;
      const discountAmount = priceBeforeGST * (discountPercentage / 100);
      const discountedBase = priceBeforeGST - discountAmount;
      const discountedGST = discountedBase * (gstPercentage / 100);
      const discountedTotal = discountedBase + discountedGST;
      return {
        ...item, gstPercentage,
        priceBeforeGST: discountPercentage > 0 ? parseFloat(discountedBase.toFixed(2)) : priceBeforeGST,
        gstAmount: discountPercentage > 0 ? parseFloat(discountedGST.toFixed(2)) : gstAmount,
        priceIncludingGST: discountPercentage > 0 ? parseFloat(discountedTotal.toFixed(2)) : priceIncludingGST,
        discountAmount: parseFloat(discountAmount.toFixed(2)),
        hsnCode: item.hsnCode || stockItem?.hsnCode || stockItem?.hsn_code || '',
        stockInfo: { quantityOnHand: stockItem?.quantityOnHand || 0, status: stockItem?.status || 'Unknown' }
      };
    }));

    const subtotalBeforeGST = itemsWithCalculations.reduce((sum, item) => sum + (item.priceBeforeGST || 0), 0);
    const totalDiscount = itemsWithCalculations.reduce((sum, item) => sum + (item.discountAmount || 0), 0);
    const totalGST = itemsWithCalculations.reduce((sum, item) => sum + (item.gstAmount || 0), 0);
    const shippingCharges = parseFloat(quotationData.shippingCharges) || 0;
    const customAdditionalCharges = quotationData.customAdditionalCharges || [];
    const totalCustomCharges = customAdditionalCharges.reduce((sum, charge) => sum + (charge.amount || 0), 0);
    const grandTotal = subtotalBeforeGST + totalGST + shippingCharges + totalCustomCharges;

    const quotation = {
      ...quotationData, items: itemsWithCalculations, customAdditionalCharges,
      subtotalBeforeGST: parseFloat(subtotalBeforeGST.toFixed(2)),
      totalDiscount: parseFloat(totalDiscount.toFixed(2)),
      totalGST: parseFloat(totalGST.toFixed(2)),
      shippingCharges: parseFloat(shippingCharges.toFixed(2)),
      grandTotal: parseFloat(grandTotal.toFixed(2)),
      quotationNumber, preparedBy: req.user.id,
      status: quotationData.status || 'draft', updatedAt: new Date()
    };

    if (!existingQuotation) { quotation.createdAt = new Date(); request.quotations.push(quotation); }
    else Object.assign(existingQuotation, quotation);

    const currentQuotation = existingQuotation || request.quotations[request.quotations.length - 1];
    request.currentQuotation = currentQuotation._id;

    if (quotationData.status === 'sent_to_customer') {
      request.status = 'quotation_sent'; currentQuotation.sentToCustomerAt = new Date(); currentQuotation.sentBy = req.user.id;
    } else if (quotationData.status === 'draft') request.status = 'quotation_draft';

    request.taxSummary = { totalGST, sgst: totalGST / 2, cgst: totalGST / 2, igst: 0 };
    request.quotationValidUntil = new Date(quotationData.validUntil);
    request.updatedAt = new Date();
    await request.save();

    res.json({ success: true, message: existingQuotation ? "Quotation updated successfully" : "Quotation created successfully", quotation: currentQuotation, request });
  } catch (error) {
    console.error("Error saving quotation:", error);
    res.status(500).json({ success: false, message: "Server error while saving quotation" });
  }
});

// UPDATE quotation
router.put("/requests/:requestId/quotation/:quotationId", async (req, res) => {
  try {
    const { requestId, quotationId } = req.params;
    const quotationData = req.body;
    const request = await CustomerRequest.findById(requestId);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    const quotation = request.quotations.id(quotationId);
    if (!quotation) return res.status(404).json({ success: false, message: "Quotation not found" });
    if (quotation.status !== 'draft') return res.status(400).json({ success: false, message: "Only draft quotations can be updated" });

    const itemsWithCalculations = await Promise.all(quotationData.items.map(async (item) => {
      let stockItem = null;
      if (item.stockItemId) stockItem = await StockItem.findById(item.stockItemId);
      const unitPrice = parseFloat(item.unitPrice) || 0;
      const gstPercentage = getGSTPercentage(unitPrice);
      const quantity = parseFloat(item.quantity) || 0;
      const { priceBeforeGST, gstAmount, priceIncludingGST } = calculateItemTotals(quantity, unitPrice, gstPercentage);
      const discountPercentage = parseFloat(item.discountPercentage) || 0;
      const discountAmount = priceBeforeGST * (discountPercentage / 100);
      const discountedBase = priceBeforeGST - discountAmount;
      const discountedGST = discountedBase * (gstPercentage / 100);
      const discountedTotal = discountedBase + discountedGST;
      return {
        ...item, gstPercentage,
        priceBeforeGST: discountPercentage > 0 ? parseFloat(discountedBase.toFixed(2)) : priceBeforeGST,
        gstAmount: discountPercentage > 0 ? parseFloat(discountedGST.toFixed(2)) : gstAmount,
        priceIncludingGST: discountPercentage > 0 ? parseFloat(discountedTotal.toFixed(2)) : priceIncludingGST,
        discountAmount: parseFloat(discountAmount.toFixed(2))
      };
    }));

    const subtotalBeforeGST = itemsWithCalculations.reduce((s, i) => s + (i.priceBeforeGST || 0), 0);
    const totalDiscount = itemsWithCalculations.reduce((s, i) => s + (i.discountAmount || 0), 0);
    const totalGST = itemsWithCalculations.reduce((s, i) => s + (i.gstAmount || 0), 0);
    const shippingCharges = parseFloat(quotationData.shippingCharges) || 0;
    const adjustment = parseFloat(quotationData.adjustment) || 0;
    const grandTotal = subtotalBeforeGST + totalGST + shippingCharges + adjustment;

    Object.assign(quotation, {
      ...quotationData, items: itemsWithCalculations,
      subtotalBeforeGST: parseFloat(subtotalBeforeGST.toFixed(2)), totalDiscount: parseFloat(totalDiscount.toFixed(2)),
      totalGST: parseFloat(totalGST.toFixed(2)), shippingCharges: parseFloat(shippingCharges.toFixed(2)),
      adjustment: parseFloat(adjustment.toFixed(2)), grandTotal: parseFloat(grandTotal.toFixed(2)), updatedAt: new Date()
    });

    request.taxSummary = { totalGST, sgst: totalGST / 2, cgst: totalGST / 2, igst: 0 };
    request.quotationValidUntil = new Date(quotationData.validUntil);
    request.updatedAt = new Date();
    await request.save();
    res.json({ success: true, message: "Quotation updated successfully", quotation, request });
  } catch (error) {
    console.error("Error updating quotation:", error);
    res.status(500).json({ success: false, message: "Server error while updating quotation" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// BATCH ADD EMPLOYEES TO MEASUREMENT-PO  (NEW)
//
// Body: { employeeIds: [id1, id2, id3, ...] }
//
// Loads request + measurement ONCE, processes each employee sequentially,
// caches WO docs across the loop so multiple employees adding to the same WO
// keep allocating non-overlapping unit ranges, then saves everything once.
//
// Returns per-employee results (succeeded/failed/skipped) so the UI can show
// exactly what happened.
// ═══════════════════════════════════════════════════════════════════════════════
router.post("/requests/:requestId/add-employees-batch", async (req, res) => {
  try {
    const { requestId } = req.params;
    const { employeeIds } = req.body;

    if (!mongoose.Types.ObjectId.isValid(requestId)) {
      return res.status(400).json({ success: false, message: "Invalid request id" });
    }
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) {
      return res.status(400).json({ success: false, message: "employeeIds array required" });
    }

    const request = await CustomerRequest.findById(requestId);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    if (request.requestType !== "measurement_conversion" || !request.measurementId) {
      return res.status(400).json({ success: false, message: "Only available for measurement POs" });
    }

    const measurement = await Measurement.findById(request.measurementId);
    if (!measurement) return res.status(404).json({ success: false, message: "Measurement not found" });

    // Caches that persist across the entire batch
    const woCache = new Map();           // woIdStr -> WO doc (loaded once, mutated, saved at end)
    const woOriginalQty = new Map();     // woIdStr -> qty BEFORE this batch (for proportional raw-material calc)
    const woMaxUnitCache = new Map();    // woIdStr -> current max unitEnd (advances as we allocate)
    const queuedProgressDocs = [];
    const perEmployeeResults = [];

    for (const employeeId of employeeIds) {
      const result = {
        employeeId,
        employeeName: null,
        success: false,
        addedProducts: [],
        skippedProducts: [],
        error: null,
      };

      try {
        if (!mongoose.Types.ObjectId.isValid(employeeId)) {
          result.error = "Invalid employee id";
          perEmployeeResults.push(result);
          continue;
        }

        const employee = await EmployeeMpc.findById(employeeId)
          .populate("products.productId", "name reference")
          .lean();

        if (!employee) { result.error = "Employee not found"; perEmployeeResults.push(result); continue; }
        result.employeeName = employee.name;

        if (measurement.organizationId.toString() !== employee.customerId?.toString()) {
          result.error = "Employee not in this organization";
          perEmployeeResults.push(result); continue;
        }

        const alreadyExists = (measurement.employeeMeasurements || []).some(
          (e) => e.employeeId?.toString() === employeeId.toString()
        );
        if (alreadyExists) {
          result.error = "Already in PO";
          perEmployeeResults.push(result); continue;
        }

        if (!employee.products || employee.products.length === 0) {
          result.error = "No products assigned";
          perEmployeeResults.push(result); continue;
        }

        const productsToAddToMeasurement = [];
        const employeeProgressDocs = [];

        for (const empProd of employee.products) {
          const empProdId = (empProd.productId?._id || empProd.productId)?.toString();
          const empVariantId = empProd.variantId?.toString() || null;
          const qty = empProd.quantity || 1;
          const empProdName = empProd.productName?.trim() || empProd.productId?.name || "Unknown";

          if (!empProdId) {
            result.skippedProducts.push({ productName: empProdName, reason: "Missing productId" });
            continue;
          }

          // Locate request item
          const reqItem = request.items.find((it) => {
            const iid = (it.stockItemId?._id || it.stockItemId)?.toString();
            return iid === empProdId;
          });
          if (!reqItem) {
            result.skippedProducts.push({ productName: empProdName, reason: "Not in PO" });
            continue;
          }

          // Locate matching WO — first check cache, fall back to DB query
          let matchingWO = null;

          // Try cache first
          for (const cachedWO of woCache.values()) {
            if (cachedWO.stockItemId.toString() !== reqItem.stockItemId.toString()) continue;
            if (empVariantId && cachedWO.variantId === empVariantId) { matchingWO = cachedWO; break; }
          }

          if (!matchingWO) {
            const candidateWOs = await WorkOrder.find({
              customerRequestId: request._id,
              stockItemId: reqItem.stockItemId,
            });

            let foundWO = null;
            if (empVariantId) foundWO = candidateWOs.find((w) => w.variantId === empVariantId);
            if (!foundWO && candidateWOs.length > 0) foundWO = candidateWOs[0];

            if (foundWO) {
              const woIdStr = foundWO._id.toString();
              if (woCache.has(woIdStr)) {
                matchingWO = woCache.get(woIdStr);
              } else {
                woCache.set(woIdStr, foundWO);
                woOriginalQty.set(woIdStr, foundWO.quantity || 0);

                const lastProgress = await EmployeeProductionProgress.find({ workOrderId: foundWO._id })
                  .select("unitEnd")
                  .sort({ unitEnd: -1 })
                  .limit(1)
                  .lean();
                woMaxUnitCache.set(woIdStr, lastProgress[0]?.unitEnd || 0);
                matchingWO = foundWO;
              }
            }
          }

          if (!matchingWO) {
            result.skippedProducts.push({ productName: empProdName, reason: "No matching work order" });
            continue;
          }

          const blockedStatuses = ["completed", "cancelled", "forwarded"];
          if (blockedStatuses.includes(matchingWO.status)) {
            result.skippedProducts.push({ productName: empProdName, reason: `WO is ${matchingWO.status}` });
            continue;
          }

          const woIdStr = matchingWO._id.toString();

          // Find request variant matching this WO
          let reqVariant = null;
          if (empVariantId) {
            reqVariant = reqItem.variants.find((v) => v.variantId && v.variantId.toString() === empVariantId);
          }
          if (!reqVariant && matchingWO.variantAttributes?.length) {
            reqVariant = reqItem.variants.find((v) => {
              if (!v.attributes || v.attributes.length === 0) return false;
              return matchingWO.variantAttributes.every((wa) =>
                v.attributes.find((a) => a.name === wa.name && a.value === wa.value)
              );
            });
          }
          if (!reqVariant && reqItem.variants.length > 0) reqVariant = reqItem.variants[0];

          if (!reqVariant) {
            result.skippedProducts.push({ productName: empProdName, reason: "No variant entry to extend" });
            continue;
          }

          // Allocate unit range from in-memory cursor
          const currentMax = woMaxUnitCache.get(woIdStr);
          const unitStart = currentMax + 1;
          const unitEnd = currentMax + qty;
          woMaxUnitCache.set(woIdStr, unitEnd);

          const woNumber = matchingWO.workOrderNumber;
          const assignedBarcodeIds = [];
          for (let u = unitStart; u <= unitEnd; u++) {
            assignedBarcodeIds.push(`${woNumber}-${u.toString().padStart(3, "0")}`);
          }

          // Mutate WO quantity in-memory (raw materials recalc once per WO at end)
          matchingWO.quantity = (matchingWO.quantity || 0) + qty;

          // Mutate request item in-memory
          const oldVariantQty = reqVariant.quantity || 0;
          reqVariant.quantity = oldVariantQty + qty;
          reqItem.totalQuantity = (reqItem.totalQuantity || 0) + qty;

          if (oldVariantQty > 0 && reqVariant.estimatedPrice) {
            const perUnitPrice = reqVariant.estimatedPrice / oldVariantQty;
            const newVariantPrice = perUnitPrice * reqVariant.quantity;
            const priceDelta = newVariantPrice - reqVariant.estimatedPrice;
            reqVariant.estimatedPrice = parseFloat(newVariantPrice.toFixed(2));
            reqItem.totalEstimatedPrice = parseFloat(((reqItem.totalEstimatedPrice || 0) + priceDelta).toFixed(2));
          }

          productsToAddToMeasurement.push({
            productId: empProd.productId?._id || empProd.productId,
            productName: empProdName,
            variantId: empProd.variantId || null,
            variantName: "Default",
            quantity: qty,
            measurements: [],
            measuredAt: new Date(),
            qrGenerated: false,
            qrGeneratedAt: null,
          });

          employeeProgressDocs.push({
            workOrderId: matchingWO._id,
            manufacturingOrderId: request._id,
            measurementId: measurement._id,
            orderType: "measurement_conversion",
            employeeId: employee._id,
            employeeName: employee.name,
            employeeUIN: employee.uin,
            gender: employee.gender,
            unitStart, unitEnd, totalUnits: qty,
            assignedBarcodeIds,
            productName: empProdName,
          });

          result.addedProducts.push({
            productName: empProdName,
            unitStart, unitEnd, totalUnits: qty,
          });
        }

        if (productsToAddToMeasurement.length === 0) {
          result.error = "No products could be added — all skipped";
          perEmployeeResults.push(result);
          continue;
        }

        // Push to measurement
        measurement.employeeMeasurements.push({
          employeeId: employee._id,
          employeeName: employee.name,
          employeeUIN: employee.uin,
          gender: employee.gender,
          products: productsToAddToMeasurement,
          noProductAssigned: false,
          categoryMeasurements: [],
          isCompleted: false,
          remarks: "",
        });

        if (!(measurement.registeredEmployeeIds || []).some((id) => id.toString() === employee._id.toString())) {
          measurement.registeredEmployeeIds = measurement.registeredEmployeeIds || [];
          measurement.registeredEmployeeIds.push(employee._id);
        }
        if (!(measurement.poCreatedForEmployeeIds || []).some((id) => id.toString() === employee._id.toString())) {
          measurement.poCreatedForEmployeeIds = measurement.poCreatedForEmployeeIds || [];
          measurement.poCreatedForEmployeeIds.push(employee._id);
        }

        queuedProgressDocs.push(...employeeProgressDocs);
        result.success = true;
        perEmployeeResults.push(result);
      } catch (innerErr) {
        console.error(`[batch-add] Error processing employee ${employeeId}:`, innerErr);
        result.error = innerErr.message || "Processing error";
        perEmployeeResults.push(result);
      }
    }

    // ── Update each touched WO once: raw materials proportional + cost ───
    for (const wo of woCache.values()) {
      const woIdStr = wo._id.toString();
      const oldQty = woOriginalQty.get(woIdStr);
      const newQty = wo.quantity;

      if (wo.rawMaterials && wo.rawMaterials.length > 0 && oldQty > 0 && newQty > oldQty) {
        for (const rm of wo.rawMaterials) {
          const perUnitQty = (rm.quantityRequired || 0) / oldQty;
          const perUnitCost = (rm.totalCost || 0) / oldQty;
          rm.quantityRequired = parseFloat((perUnitQty * newQty).toFixed(4));
          rm.totalCost = parseFloat((perUnitCost * newQty).toFixed(2));
        }
      }
      wo.estimatedCost = (wo.rawMaterials || []).reduce((s, rm) => s + (rm.totalCost || 0), 0);
      await wo.save();
    }

    // Update measurement counts for newly-added employees
    const newlyAdded = perEmployeeResults.filter((r) => r.success).length;
    if (newlyAdded > 0) {
      measurement.totalRegisteredEmployees = (measurement.totalRegisteredEmployees || 0) + newlyAdded;
      measurement.pendingEmployees = (measurement.pendingEmployees || 0) + newlyAdded;
    }

    await measurement.save();
    request.markModified("items");
    request.updatedAt = new Date();
    await request.save();

    // Create progress docs
    for (const pd of queuedProgressDocs) {
      try {
        await EmployeeProductionProgress.findOneAndUpdate(
          { workOrderId: pd.workOrderId, employeeId: pd.employeeId },
          {
            $set: {
              measurementId: pd.measurementId,
              manufacturingOrderId: pd.manufacturingOrderId,
              orderType: pd.orderType,
              employeeName: pd.employeeName,
              employeeUIN: pd.employeeUIN,
              gender: pd.gender,
              unitStart: pd.unitStart,
              unitEnd: pd.unitEnd,
              totalUnits: pd.totalUnits,
              assignedBarcodeIds: pd.assignedBarcodeIds,
              completedUnits: 0,
              completedUnitNumbers: [],
              completionPercentage: 0,
              lastSyncedAt: new Date(),
            },
          },
          { upsert: true, new: true }
        );
      } catch (progressErr) {
        console.error(`[batch-add] Progress doc error for ${pd.employeeName}:`, progressErr.message);
      }
    }

    const successCount = perEmployeeResults.filter((r) => r.success).length;
    const failCount = perEmployeeResults.length - successCount;
    const totalUnits = perEmployeeResults.reduce(
      (s, r) => s + (r.addedProducts?.reduce((s2, p) => s2 + p.totalUnits, 0) || 0),
      0
    );

    res.json({
      success: true,
      message: `Added ${successCount} of ${employeeIds.length} employee(s) · ${totalUnits} unit(s) total${failCount > 0 ? ` · ${failCount} skipped` : ""}`,
      summary: {
        total: employeeIds.length,
        succeeded: successCount,
        failed: failCount,
        totalUnits,
      },
      results: perEmployeeResults,
    });
  } catch (err) {
    console.error("add-employees-batch error:", err);
    res.status(500).json({
      success: false,
      message: "Server error while adding employees",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
});

router.put("/payment-submissions/:submissionId/status", async (req, res) => {
  try {
    const { submissionId } = req.params;
    const { status, verificationNotes } = req.body;
    const request = await CustomerRequest.findOne({ 'quotations.paymentSubmissions._id': submissionId });
    if (!request) return res.status(404).json({ success: false, message: "Payment submission not found" });
    const quotation = request.quotations.find(q => q.paymentSubmissions.some(s => s._id.toString() === submissionId));
    if (!quotation) return res.status(404).json({ success: false, message: "Quotation not found" });
    const submission = quotation.paymentSubmissions.id(submissionId);
    if (!submission) return res.status(404).json({ success: false, message: "Payment submission not found" });

    const previousStatus = submission.status;
    submission.status = status; submission.verifiedBy = req.user.id; submission.verifiedAt = new Date();
    if (verificationNotes) submission.verificationNotes = verificationNotes;
    submission.updatedAt = new Date();

    const paymentStep = quotation.paymentSchedule.find(p => p.stepNumber === submission.paymentStepNumber);
    if (paymentStep) {
      if (status === 'verified' && previousStatus !== 'verified') {
        paymentStep.paidAmount = (paymentStep.paidAmount || 0) + submission.submittedAmount;
        paymentStep.paidDate = new Date();
      } else if (previousStatus === 'verified' && status !== 'verified') {
        paymentStep.paidAmount = Math.max(0, (paymentStep.paidAmount || 0) - submission.submittedAmount);
      }
      if (paymentStep.paidAmount >= paymentStep.amount) paymentStep.status = 'paid';
      else if (paymentStep.paidAmount > 0) paymentStep.status = 'partially_paid';
      else paymentStep.status = 'pending';
    }
    await request.save();
    res.json({ success: true, message: "Payment submission status updated", submission });
  } catch (error) {
    console.error("Error updating payment submission:", error);
    res.status(500).json({ success: false, message: "Server error while updating payment submission" });
  }
});

router.get("/requests/:requestId/payment-submissions", async (req, res) => {
  try {
    const request = await CustomerRequest.findById(req.params.requestId);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    if (request.quotations.length === 0) return res.status(404).json({ success: false, message: "No quotation found" });
    res.json({ success: true, submissions: request.quotations[0].paymentSubmissions || [] });
  } catch (error) {
    console.error("Error fetching payment submissions:", error);
    res.status(500).json({ success: false, message: "Server error while fetching payment submissions" });
  }
});

router.post("/requests/:requestId/quotation/send", async (req, res) => {
  try {
    const request = await CustomerRequest.findById(req.params.requestId);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    if (request.quotations.length === 0) return res.status(400).json({ success: false, message: "No quotation found to send" });
    const quotation = request.quotations[0];
    if (quotation.status !== 'draft') return res.status(400).json({ success: false, message: "Only draft quotations can be sent" });
    quotation.status = 'sent_to_customer'; quotation.sentToCustomerAt = new Date(); quotation.sentBy = req.user.id; quotation.updatedAt = new Date();
    request.status = 'quotation_sent'; request.updatedAt = new Date();
    request.quotationNotifications.push({ type: 'customer_approval', message: 'Quotation sent to customer for approval', actionRequired: false, createdAt: new Date() });
    await request.save();
    try { await CustomerEmailService.sendQuotationEmail(request, quotation, req.user); } catch (emailError) { console.error("Failed to send quotation email:", emailError); }
    res.json({ success: true, message: "Quotation sent to customer successfully", request });
  } catch (error) {
    console.error("Error sending quotation:", error);
    res.status(500).json({ success: false, message: "Server error while sending quotation" });
  }
});

router.get("/requests/:requestId/quotation/:quotationId/payment-submissions", async (req, res) => {
  try {
    const request = await CustomerRequest.findById(req.params.requestId);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    const quotation = request.quotations.id(req.params.quotationId);
    if (!quotation) return res.status(404).json({ success: false, message: "Quotation not found" });
    const submissions = quotation.paymentSubmissions || [];
    submissions.sort((a, b) => new Date(b.submissionDate) - new Date(a.submissionDate));
    res.json({ success: true, submissions, count: submissions.length });
  } catch (error) {
    console.error("Error fetching payment submissions:", error);
    res.status(500).json({ success: false, message: "Server error while fetching payment submissions" });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// SALES APPROVAL — Creates WOs + EmployeeProductionProgress docs
// ═══════════════════════════════════════════════════════════════════════════════
router.post("/requests/:requestId/quotation/sales-approve", async (req, res) => {
  try {
    const { requestId } = req.params;
    const { notes } = req.body;

    const request = await CustomerRequest.findById(requestId);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    if (request.quotations.length === 0) return res.status(400).json({ success: false, message: "No quotation found for this request" });

    const quotation = request.quotations[0];
    if (quotation.status !== 'customer_approved') return res.status(400).json({ success: false, message: "Quotation is not approved by customer" });

    quotation.status = 'sales_approved';
    quotation.salesApproval = { approved: true, approvedAt: new Date(), approvedBy: req.user.id, notes: notes || '' };
    quotation.updatedAt = new Date();
    request.status = 'quotation_sales_approved';
    request.finalOrderPrice = quotation.grandTotal;
    request.updatedAt = new Date();
    request.quotationNotifications = request.quotationNotifications.filter(n => n.type !== 'sales_approval_required');

    const isMeasurementOrder = !!(request.requestType === 'measurement_conversion' || request.measurementId);
    const orderType = isMeasurementOrder ? 'measurement_conversion' : 'customer_request';

    let measurement = null;
    if (isMeasurementOrder && request.measurementId) {
      measurement = await Measurement.findById(request.measurementId)
        .select('_id employeeMeasurements')
        .lean();
    }

    const createdWorkOrders = [];
    const skippedVariants = [];
    const createdProgressDocs = [];

    for (const item of request.items) {
      const stockItem = await StockItem.findById(item.stockItemId);
      if (!stockItem) { console.warn(`StockItem not found: ${item.stockItemId}`); continue; }

      for (const variant of item.variants) {
        let variantData = null;
        let usedFallback = false;

        if (variant.variantId && mongoose.Types.ObjectId.isValid(variant.variantId)) {
          variantData = stockItem.variants.find(v => v._id.toString() === variant.variantId);
        }
        if (!variantData && variant.attributes?.length > 0) {
          variantData = stockItem.variants.find(v => {
            if (!v.attributes || v.attributes.length !== variant.attributes.length) return false;
            return variant.attributes.every(reqAttr => {
              const stockAttr = v.attributes.find(a => a.name === reqAttr.name);
              return stockAttr && stockAttr.value === reqAttr.value;
            });
          });
        }
        if (!variantData && variant.variantId) {
          variantData = stockItem.variants.find(v => v.sku === variant.variantId);
        }
        if (!variantData && stockItem.variants?.length > 0) {
          variantData = stockItem.variants[0];
          usedFallback = true;
          skippedVariants.push({ productName: stockItem.name, originalVariantId: variant.variantId, selectedVariant: { id: variantData._id, sku: variantData.sku } });
        }
        if (!variantData) {
          skippedVariants.push({ productName: stockItem.name, originalVariantId: variant.variantId, error: "No variants available" });
          continue;
        }

        const operations = stockItem.operations.map(op => ({
          operationType: op.type || op.name || op.operationType,
          operationCode: op.operationCode || op.code || "",
          plannedTimeSeconds: op.totalSeconds || op.durationSeconds || 0,
          status: "pending",
        }));

        let rawMaterials = [];
        if (variantData.rawItems?.length > 0) {
          rawMaterials = variantData.rawItems.map(rawItem => ({
            rawItemId: rawItem.rawItemId, name: rawItem.rawItemName, sku: rawItem.rawItemSku,
            rawItemVariantId: rawItem.variantId || null,
            rawItemVariantCombination: rawItem.variantCombination || [],
            quantityRequired: rawItem.quantity * variant.quantity,
            quantityAllocated: 0, quantityIssued: 0,
            unit: rawItem.unit, unitCost: rawItem.unitCost,
            totalCost: rawItem.totalCost * variant.quantity,
            allocationStatus: "not_allocated"
          }));
        }

        const variantAttributes = variant.attributes || [];
        if (variantAttributes.length === 0 && variantData.attributes) variantAttributes.push(...variantData.attributes);

        const workOrder = new WorkOrder({
          customerRequestId: request._id, stockItemId: item.stockItemId,
          stockItemName: item.stockItemName, stockItemReference: item.stockItemReference,
          variantId: variantData._id.toString(), variantAttributes,
          quantity: variant.quantity, customerId: request.customerId,
          customerName: request.customerInfo.name, priority: request.priority,
          status: "pending", operations, rawMaterials,
          timeline: { plannedStartDate: null, plannedEndDate: null, actualStartDate: null, actualEndDate: null, scheduledStartDate: null, scheduledEndDate: null },
          specialInstructions: variant.specialInstructions || [],
          estimatedCost: rawMaterials.reduce((total, rm) => total + (rm.totalCost || 0), 0),
          actualCost: 0, createdBy: req.user.id
        });
        await workOrder.save();

        createdWorkOrders.push({
          _id: workOrder._id, workOrderNumber: workOrder.workOrderNumber,
          stockItemName: workOrder.stockItemName, stockItemId: item.stockItemId,
          variantId: variantData._id.toString(),
          quantity: workOrder.quantity, rawMaterialCount: workOrder.rawMaterials.length,
          autoSelectedVariant: usedFallback
        });

        if (isMeasurementOrder && measurement) {
          const stockIdStr = item.stockItemId.toString();
          const woVariantIdStr = variantData._id.toString();

          const employeeEntries = [];
          for (const empM of measurement.employeeMeasurements || []) {
            const productEntry = (empM.products || []).find((p) => {
              const pIdMatch = p.productId?.toString() === stockIdStr;
              if (!pIdMatch) {
                if (p.productId) return false;
                if (p.productName !== item.stockItemName) return false;
                if (woVariantIdStr && p.variantId) return p.variantId.toString() === woVariantIdStr;
                return true;
              }
              if (woVariantIdStr && p.variantId) return p.variantId.toString() === woVariantIdStr;
              if (woVariantIdStr && !p.variantId) return p.productName === item.stockItemName;
              return true;
            });
            if (!productEntry) continue;
            employeeEntries.push({
              employeeId: empM.employeeId,
              employeeName: empM.employeeName,
              employeeUIN: empM.employeeUIN,
              gender: empM.gender,
              quantity: productEntry.quantity || variant.quantity,
            });
          }

          if (employeeEntries.length > 0) {
            const woNumber = workOrder.workOrderNumber;
            let unitCursor = 1;
            for (const emp of employeeEntries) {
              const unitStart = unitCursor;
              const unitEnd = unitCursor + emp.quantity - 1;

              const assignedBarcodeIds = [];
              for (let u = unitStart; u <= unitEnd; u++) {
                assignedBarcodeIds.push(`${woNumber}-${u.toString().padStart(3, '0')}`);
              }

              try {
                await EmployeeProductionProgress.findOneAndUpdate(
                  { workOrderId: workOrder._id, employeeId: emp.employeeId },
                  {
                    $set: {
                      measurementId: measurement._id,
                      manufacturingOrderId: request._id,
                      orderType,
                      employeeName: emp.employeeName,
                      employeeUIN: emp.employeeUIN,
                      gender: emp.gender,
                      unitStart, unitEnd,
                      totalUnits: emp.quantity,
                      assignedBarcodeIds,
                      completedUnits: 0,
                      completedUnitNumbers: [],
                      completionPercentage: 0,
                      lastSyncedAt: new Date(),
                    },
                  },
                  { upsert: true, new: true }
                );
                createdProgressDocs.push({
                  employeeName: emp.employeeName, employeeUIN: emp.employeeUIN,
                  productName: workOrder.stockItemName,
                  unitStart, unitEnd, totalUnits: emp.quantity,
                  barcodeCount: assignedBarcodeIds.length,
                });
              } catch (progressErr) {
                console.error(`[sales-approve] Progress doc error for ${emp.employeeName}:`, progressErr.message);
              }
              unitCursor = unitEnd + 1;
            }
          }
        }
      }
    }

    await request.save();

    let msg = createdWorkOrders.length > 0
      ? `Quotation approved and ${createdWorkOrders.length} work order(s) created`
      : "Quotation approved but no work orders were created";
    if (createdProgressDocs.length > 0) msg += `. ${createdProgressDocs.length} employee tracking record(s) created.`;

    res.json({
      success: true, message: msg, request, createdWorkOrders,
      skippedVariants: skippedVariants.length > 0 ? skippedVariants : undefined,
      employeeTrackingCreated: createdProgressDocs.length,
    });
  } catch (error) {
    console.error("Error processing sales approval:", error);
    res.status(500).json({ success: false, message: "Server error while processing approval" });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// ADD EMPLOYEE TO MEASUREMENT-PO  (NEW)
//
// Two endpoints:
//   GET  /requests/:requestId/search-employees-for-add?query=...
//   POST /requests/:requestId/add-employee  { employeeId }
//
// The POST cascades through:
//   1. Measurement.employeeMeasurements  → push entry (empty measurement values)
//   2. CustomerRequest.items[].variants[].quantity → increment per matched product
//   3. WorkOrder.quantity + rawMaterials proportional update
//   4. EmployeeProductionProgress → create new doc with appended unit range
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/requests/:requestId/search-employees-for-add", async (req, res) => {
  try {
    const { requestId } = req.params;
    const { query = "" } = req.query;

    if (!query || query.trim().length < 2) {
      return res.json({ success: true, results: [] });
    }
    if (!mongoose.Types.ObjectId.isValid(requestId)) {
      return res.status(400).json({ success: false, message: "Invalid request id" });
    }

    const request = await CustomerRequest.findById(requestId)
      .select("customerId measurementId requestType")
      .lean();
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    if (request.requestType !== "measurement_conversion" || !request.measurementId) {
      return res.status(400).json({ success: false, message: "Available only for measurement POs" });
    }

    const measurement = await Measurement.findById(request.measurementId)
      .select("organizationId employeeMeasurements")
      .lean();
    if (!measurement) return res.status(404).json({ success: false, message: "Measurement not found" });

    // Already-added IDs to filter out
    const existingEmpIds = new Set(
      (measurement.employeeMeasurements || [])
        .map((e) => e.employeeId?.toString())
        .filter(Boolean)
    );

    const re = new RegExp(query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const employees = await EmployeeMpc.find({
      customerId: measurement.organizationId,
      status: "active",
      $or: [{ uin: re }, { name: re }],
    })
      .populate("products.productId", "name reference genderCategory")
      .limit(15)
      .lean();

    const results = employees
      .filter((e) => !existingEmpIds.has(e._id.toString()))
      .map((e) => ({
        employeeId: e._id,
        name: e.name,
        uin: e.uin,
        gender: e.gender,
        department: e.department || "",
        designation: e.designation || "",
        productCount: (e.products || []).length,
        products: (e.products || []).map((p) => ({
          productId: (p.productId?._id || p.productId)?.toString(),
          productName:
            p.productName?.trim() || p.productId?.name || "Unknown",
          variantId: p.variantId?.toString() || null,
          quantity: p.quantity || 1,
        })),
      }));

    res.json({ success: true, results });
  } catch (err) {
    console.error("search-employees-for-add error:", err);
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

router.post("/requests/:requestId/add-employee", async (req, res) => {
  try {
    const { requestId } = req.params;
    const { employeeId } = req.body;

    if (
      !mongoose.Types.ObjectId.isValid(requestId) ||
      !mongoose.Types.ObjectId.isValid(employeeId)
    ) {
      return res.status(400).json({ success: false, message: "Invalid IDs" });
    }

    // ── 1. Load resources ────────────────────────────────────────────────
    const request = await CustomerRequest.findById(requestId);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    if (request.requestType !== "measurement_conversion" || !request.measurementId) {
      return res.status(400).json({ success: false, message: "Only available for measurement POs" });
    }

    const employee = await EmployeeMpc.findById(employeeId)
      .populate("products.productId", "name reference")
      .lean();
    if (!employee) return res.status(404).json({ success: false, message: "Employee not found" });
    if (!employee.products || employee.products.length === 0) {
      return res.status(400).json({ success: false, message: "Employee has no products assigned" });
    }

    const measurement = await Measurement.findById(request.measurementId);
    if (!measurement) return res.status(404).json({ success: false, message: "Measurement not found" });

    // Belongs to same org?
    if (measurement.organizationId.toString() !== employee.customerId?.toString()) {
      return res.status(400).json({
        success: false,
        message: "Employee is not part of this organization",
      });
    }

    // Already added?
    const alreadyExists = (measurement.employeeMeasurements || []).some(
      (e) => e.employeeId?.toString() === employeeId.toString()
    );
    if (alreadyExists) {
      return res.status(400).json({ success: false, message: "Employee already added to this PO" });
    }

    // ── 2. For each product the employee has, find matching item + WO ────
    const woUpdates = [];                  // { wo, reqItem, reqVariant, qty }
    const productsToAddToMeasurement = []; // entries pushed into measurement.employeeMeasurements
    const newProgressDocsToCreate = [];    // queued doc creations
    const skippedProducts = [];

    for (const empProd of employee.products) {
      const empProdId = (empProd.productId?._id || empProd.productId)?.toString();
      const empVariantId = empProd.variantId?.toString() || null;
      const qty = empProd.quantity || 1;
      const empProdName =
        empProd.productName?.trim() || empProd.productId?.name || "Unknown";

      if (!empProdId) {
        skippedProducts.push({ productName: empProdName, reason: "Missing productId" });
        continue;
      }

      // Locate the item in request.items by stockItemId
      const reqItem = request.items.find((it) => {
        const iid = (it.stockItemId?._id || it.stockItemId)?.toString();
        return iid === empProdId;
      });
      if (!reqItem) {
        skippedProducts.push({ productName: empProdName, reason: "Product not in this PO" });
        continue;
      }

      // Locate matching WO (by stockItemId + variantId if possible)
      const candidateWOs = await WorkOrder.find({
        customerRequestId: request._id,
        stockItemId: reqItem.stockItemId,
      });

      let matchingWO = null;
      if (empVariantId) {
        matchingWO = candidateWOs.find((w) => w.variantId === empVariantId);
      }
      if (!matchingWO && candidateWOs.length === 1) {
        // single variant — safe fallback
        matchingWO = candidateWOs[0];
      }
      if (!matchingWO && candidateWOs.length > 0) {
        // multiple WOs but no variant match — pick first as last resort
        matchingWO = candidateWOs[0];
      }

      if (!matchingWO) {
        skippedProducts.push({ productName: empProdName, reason: "No matching work order found" });
        continue;
      }

      // Block if WO is already past production
      const blockedStatuses = ["completed", "cancelled", "forwarded"];
      if (blockedStatuses.includes(matchingWO.status)) {
        skippedProducts.push({
          productName: empProdName,
          reason: `Work order is ${matchingWO.status} — cannot extend`,
        });
        continue;
      }

      // Find which variant on reqItem corresponds to this WO
      let reqVariant = null;
      if (empVariantId) {
        reqVariant = reqItem.variants.find(
          (v) => v.variantId && v.variantId.toString() === empVariantId
        );
      }
      if (!reqVariant) {
        // Match by attributes against WO's variantAttributes
        if (matchingWO.variantAttributes?.length) {
          reqVariant = reqItem.variants.find((v) => {
            if (!v.attributes || v.attributes.length === 0) return false;
            return matchingWO.variantAttributes.every((wa) =>
              v.attributes.find((a) => a.name === wa.name && a.value === wa.value)
            );
          });
        }
      }
      if (!reqVariant && reqItem.variants.length === 1) reqVariant = reqItem.variants[0];
      if (!reqVariant && reqItem.variants.length > 0) reqVariant = reqItem.variants[0];

      if (!reqVariant) {
        skippedProducts.push({ productName: empProdName, reason: "No variant entry to extend" });
        continue;
      }

      // Compute next unit range for new progress doc
      const lastProgress = await EmployeeProductionProgress.find({
        workOrderId: matchingWO._id,
      })
        .select("unitEnd")
        .sort({ unitEnd: -1 })
        .limit(1)
        .lean();
      const currentMaxUnit = lastProgress[0]?.unitEnd || 0;
      const unitStart = currentMaxUnit + 1;
      const unitEnd = currentMaxUnit + qty;

      const woNumber = matchingWO.workOrderNumber;
      const assignedBarcodeIds = [];
      for (let u = unitStart; u <= unitEnd; u++) {
        assignedBarcodeIds.push(`${woNumber}-${u.toString().padStart(3, "0")}`);
      }

      woUpdates.push({ wo: matchingWO, reqItem, reqVariant, qty });

      newProgressDocsToCreate.push({
        workOrderId: matchingWO._id,
        manufacturingOrderId: request._id,
        measurementId: measurement._id,
        orderType: "measurement_conversion",
        employeeId: employee._id,
        employeeName: employee.name,
        employeeUIN: employee.uin,
        gender: employee.gender,
        unitStart,
        unitEnd,
        totalUnits: qty,
        assignedBarcodeIds,
        productName: empProdName,
      });

      productsToAddToMeasurement.push({
        productId: empProd.productId?._id || empProd.productId,
        productName: empProdName,
        variantId: empProd.variantId || null,
        variantName: "Default",
        quantity: qty,
        measurements: [], // empty — user fills in via measurement edit later
        measuredAt: new Date(),
        qrGenerated: false,
        qrGeneratedAt: null,
      });
    }

    if (woUpdates.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No products could be added — all skipped",
        skippedProducts,
      });
    }

    // ── 3. Apply WO updates: quantity, rawMaterials proportional, cost ──
    for (const u of woUpdates) {
      const oldWOQty = u.wo.quantity || 0;
      u.wo.quantity = oldWOQty + u.qty;

      if (u.wo.rawMaterials && u.wo.rawMaterials.length > 0 && oldWOQty > 0) {
        for (const rm of u.wo.rawMaterials) {
          const perUnitQty = (rm.quantityRequired || 0) / oldWOQty;
          const perUnitCost = (rm.totalCost || 0) / oldWOQty;
          rm.quantityRequired = parseFloat((perUnitQty * u.wo.quantity).toFixed(4));
          rm.totalCost = parseFloat((perUnitCost * u.wo.quantity).toFixed(2));
        }
      }
      u.wo.estimatedCost = (u.wo.rawMaterials || []).reduce(
        (s, rm) => s + (rm.totalCost || 0),
        0
      );
      await u.wo.save();

      // ── 4. Update request item totals ───────────────────────────────
      const oldVariantQty = u.reqVariant.quantity || 0;
      u.reqVariant.quantity = oldVariantQty + u.qty;
      u.reqItem.totalQuantity = (u.reqItem.totalQuantity || 0) + u.qty;

      if (oldVariantQty > 0 && u.reqVariant.estimatedPrice) {
        const perUnitPrice = u.reqVariant.estimatedPrice / oldVariantQty;
        const newVariantPrice = perUnitPrice * u.reqVariant.quantity;
        const priceDelta = newVariantPrice - u.reqVariant.estimatedPrice;
        u.reqVariant.estimatedPrice = parseFloat(newVariantPrice.toFixed(2));
        u.reqItem.totalEstimatedPrice = parseFloat(
          ((u.reqItem.totalEstimatedPrice || 0) + priceDelta).toFixed(2)
        );
      }
    }

    // ── 5. Push to measurement.employeeMeasurements ──────────────────
    measurement.employeeMeasurements.push({
      employeeId: employee._id,
      employeeName: employee.name,
      employeeUIN: employee.uin,
      gender: employee.gender,
      products: productsToAddToMeasurement,
      noProductAssigned: false,
      categoryMeasurements: [],
      isCompleted: false,
      remarks: "",
    });

    measurement.totalRegisteredEmployees =
      (measurement.totalRegisteredEmployees || 0) + 1;
    measurement.pendingEmployees = (measurement.pendingEmployees || 0) + 1;

    if (
      !(measurement.registeredEmployeeIds || []).some(
        (id) => id.toString() === employee._id.toString()
      )
    ) {
      measurement.registeredEmployeeIds = measurement.registeredEmployeeIds || [];
      measurement.registeredEmployeeIds.push(employee._id);
    }
    if (
      !(measurement.poCreatedForEmployeeIds || []).some(
        (id) => id.toString() === employee._id.toString()
      )
    ) {
      measurement.poCreatedForEmployeeIds = measurement.poCreatedForEmployeeIds || [];
      measurement.poCreatedForEmployeeIds.push(employee._id);
    }

    await measurement.save();

    // ── 6. Save the request ──────────────────────────────────────────
    request.markModified("items");
    request.updatedAt = new Date();
    await request.save();

    // ── 7. Create progress docs ──────────────────────────────────────
    const createdProgressDetails = [];
    for (const pd of newProgressDocsToCreate) {
      try {
        await EmployeeProductionProgress.findOneAndUpdate(
          { workOrderId: pd.workOrderId, employeeId: pd.employeeId },
          {
            $set: {
              measurementId: pd.measurementId,
              manufacturingOrderId: pd.manufacturingOrderId,
              orderType: pd.orderType,
              employeeName: pd.employeeName,
              employeeUIN: pd.employeeUIN,
              gender: pd.gender,
              unitStart: pd.unitStart,
              unitEnd: pd.unitEnd,
              totalUnits: pd.totalUnits,
              assignedBarcodeIds: pd.assignedBarcodeIds,
              completedUnits: 0,
              completedUnitNumbers: [],
              completionPercentage: 0,
              lastSyncedAt: new Date(),
            },
          },
          { upsert: true, new: true }
        );
        createdProgressDetails.push({
          productName: pd.productName,
          unitStart: pd.unitStart,
          unitEnd: pd.unitEnd,
          totalUnits: pd.totalUnits,
        });
      } catch (progressErr) {
        console.error(
          `[add-employee] Progress doc error for ${pd.employeeName} on WO ${pd.workOrderId}:`,
          progressErr.message
        );
      }
    }

    res.json({
      success: true,
      message: `${employee.name} added · ${createdProgressDetails.length} product(s) · ${createdProgressDetails.reduce((s, p) => s + p.totalUnits, 0)} unit(s)`,
      added: {
        employee: { name: employee.name, uin: employee.uin, gender: employee.gender },
        productCount: createdProgressDetails.length,
        totalUnits: createdProgressDetails.reduce((s, p) => s + p.totalUnits, 0),
        details: createdProgressDetails,
      },
      skippedProducts: skippedProducts.length > 0 ? skippedProducts : undefined,
    });
  } catch (err) {
    console.error("add-employee error:", err);
    res.status(500).json({
      success: false,
      message: "Server error while adding employee",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
});


// ── Existing endpoints below ─────────────────────────────────────────────────

router.get('/:measurementId/po-persons-export', async (req, res) => {
  try {
    const { measurementId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(measurementId)) {
      return res.status(400).json({ success: false, message: 'Valid measurement ID required' });
    }
    const measurement = await Measurement.findById(measurementId)
      .populate({ path: 'employeeMeasurements.products.productId', select: '_id name' })
      .lean();
    if (!measurement) return res.status(404).json({ success: false, message: 'Measurement not found' });

    const empIds = measurement.employeeMeasurements.map(e => e.employeeId).filter(Boolean);
    const mpcEmployees = await EmployeeMpc.find({ _id: { $in: empIds } })
      .select('_id products department designation')
      .lean();

    const mpcNameMap = new Map();
    const mpcDetailsMap = new Map();
    mpcEmployees.forEach(emp => {
      const eid = emp._id.toString();
      mpcDetailsMap.set(eid, { department: emp.department || '', designation: emp.designation || '' });
      const prodMap = new Map();
      (emp.products || []).forEach(p => {
        const pid = p.productId?.toString();
        if (pid && p.productName?.trim()) prodMap.set(pid, p.productName.trim());
      });
      mpcNameMap.set(eid, prodMap);
    });

    const headers = ['#', 'Employee Name', 'UIN', 'Gender', 'Department', 'Designation', 'Products'];
    const rows = measurement.employeeMeasurements.map((emp, idx) => {
      const eid = emp.employeeId?.toString();
      const mpcDets = mpcDetailsMap.get(eid) || {};
      const prodMap = mpcNameMap.get(eid) || new Map();
      const productsStr = (emp.products || []).map(p => {
        const pid = (p.productId?._id || p.productId)?.toString();
        const displayName = (pid && prodMap.get(pid)) || p.productName || p.productId?.name || 'Unknown';
        return `${displayName} x${p.quantity || 1}`;
      }).join(' | ');
      return [
        idx + 1, `"${emp.employeeName || ''}"`, emp.employeeUIN || '', emp.gender || '',
        `"${mpcDets.department || ''}"`, `"${mpcDets.designation || ''}"`, `"${productsStr}"`,
      ].join(',');
    });

    const csv = ['\uFEFF', headers.join(','), ...rows].join('\n');
    const safeName = (measurement.name || 'measurement').replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}_persons.csv"`);
    res.send(csv);
  } catch (error) {
    console.error('po-persons-export error:', error);
    res.status(500).json({ success: false, message: 'Export failed' });
  }
});


router.post("/requests/:requestId/quotation/reject", async (req, res) => {
  try {
    const { reason } = req.body;
    const request = await CustomerRequest.findById(req.params.requestId);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    if (request.quotations.length === 0) return res.status(400).json({ success: false, message: "No quotation found" });
    const quotation = request.quotations[0];
    const wasCustomerApproved = quotation.status === 'customer_approved';
    quotation.status = 'rejected'; quotation.updatedAt = new Date();
    if (wasCustomerApproved) quotation.salesApproval = { approved: false, approvedAt: new Date(), approvedBy: req.user.id, notes: reason || 'Rejected by sales team' };
    request.status = request.status === 'quotation_customer_approved' ? 'quotation_sent' : 'in_progress';
    request.updatedAt = new Date();
    request.quotationNotifications.push({ type: 'quotation_expired', message: `Quotation rejected: ${reason}`, actionRequired: false });
    await request.save();
    res.json({ success: true, message: "Quotation rejected", request });
  } catch (error) {
    console.error("Error rejecting quotation:", error);
    res.status(500).json({ success: false, message: "Server error while rejecting quotation" });
  }
});

router.get("/requests/:requestId/quotations/:quotationId", async (req, res) => {
  try {
    const request = await CustomerRequest.findById(req.params.requestId);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    const quotation = request.quotations.id(req.params.quotationId);
    if (!quotation) return res.status(404).json({ success: false, message: "Quotation not found" });
    res.json({ success: true, quotation });
  } catch (error) {
    console.error("Error fetching quotation:", error);
    res.status(500).json({ success: false, message: "Server error while fetching quotation" });
  }
});

router.get("/requests/:requestId/quotations", async (req, res) => {
  try {
    const request = await CustomerRequest.findById(req.params.requestId);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    res.json({ success: true, quotations: request.quotations });
  } catch (error) {
    console.error("Error fetching quotations:", error);
    res.status(500).json({ success: false, message: "Server error while fetching quotations" });
  }
});

router.get("/requests/:requestId/quotations/:quotationId/download", async (req, res) => {
  try {
    const request = await CustomerRequest.findById(req.params.requestId);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    const quotation = request.quotations.id(req.params.quotationId);
    if (!quotation) return res.status(404).json({ success: false, message: "Quotation not found" });
    res.json({ success: true, quotation, request: { requestId: request.requestId, customerInfo: request.customerInfo } });
  } catch (error) {
    console.error("Error fetching quotation for download:", error);
    res.status(500).json({ success: false, message: "Server error while fetching quotation" });
  }
});


router.delete("/requests/:requestId", async (req, res) => {
  try {
    const { requestId } = req.params;
    const request = await CustomerRequest.findById(requestId);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });

    if (request.measurementId) {
      await Measurement.findByIdAndUpdate(request.measurementId, {
        $set: {
          convertedToPO: false, poRequestId: null, poConversionDate: null,
          convertedBy: null, poCreatedForEmployeeIds: [],
        },
      });
    }
    if (WorkOrder) await WorkOrder.deleteMany({ customerRequestId: request._id });
    await CustomerRequest.findByIdAndDelete(requestId);

    res.json({ success: true, message: "PO/Quotation removed successfully", measurementReset: !!request.measurementId });
  } catch (error) {
    console.error("Error deleting request:", error);
    res.status(500).json({ success: false, message: "Server error while removing PO/Quotation" });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// GET /requests/:requestId/po-breakdown
// (unchanged)
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/requests/:requestId/po-breakdown", async (req, res) => {
  try {
    const { requestId } = req.params;
    const request = await CustomerRequest.findById(requestId)
      .populate("items.stockItemId", "name genderCategory hsnCode reference")
      .lean();
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    if (!request.quotations || request.quotations.length === 0) return res.status(400).json({ success: false, message: "No quotation found for this request" });

    const quotation = request.quotations[0];
    const isMeasurementPO = request.requestType === "measurement_conversion" && !!request.measurementId;
    if (!isMeasurementPO) return res.json({ success: true, quotation, request });

    const measurement = await Measurement.findById(request.measurementId).select("employeeMeasurements").lean();
    if (!measurement) return res.json({ success: true, quotation, request });

    const empIds = (measurement.employeeMeasurements || []).map((e) => e.employeeId).filter(Boolean);
    const mpcEmployees = await EmployeeMpc.find({ _id: { $in: empIds } }).select("_id products").lean();

    const mpcAliasMap = new Map();
    for (const emp of mpcEmployees) {
      const eid = emp._id.toString();
      const lookup = new Map();
      for (const p of emp.products || []) {
        const pidStr = p.productId?.toString();
        if (!pidStr) continue;
        const vidStr = p.variantId?.toString() || null;
        const alias = (p.productName || "").trim();
        if (!alias) continue;
        if (vidStr) lookup.set(`${pidStr}::${vidStr}`, alias);
        else lookup.set(`${pidStr}::_noVar_`, alias);
        if (!lookup.has(pidStr)) lookup.set(pidStr, alias);
      }
      mpcAliasMap.set(eid, lookup);
    }

    const attrsEqual = (a = [], b = []) => {
      if (a.length !== b.length) return false;
      return a.every((x) => b.some((y) => y.name === x.name && y.value === x.value));
    };

    const bucketMap = new Map();
    for (const empM of measurement.employeeMeasurements || []) {
      const eid = empM.employeeId?.toString();
      const aliasLookup = mpcAliasMap.get(eid) || new Map();
      for (const prod of empM.products || []) {
        const pidStr = prod.productId?.toString();
        if (!pidStr) continue;
        const vidStr = prod.variantId?.toString() || null;
        const qty = Number(prod.quantity) || 0;
        if (qty <= 0) continue;
        const reqItemForGender = request.items.find(i => {
          const iPid = (i.stockItemId?._id || i.stockItemId)?.toString();
          return iPid === pidStr;
        });
        const gender = reqItemForGender?.stockItemId?.genderCategory || "Unisex";
        let aliasName =
          (vidStr && aliasLookup.get(`${pidStr}::${vidStr}`)) ||
          aliasLookup.get(`${pidStr}::_noVar_`) ||
          aliasLookup.get(pidStr) ||
          (prod.productName || "").trim() || "Unknown";
        const bucketKey = `${pidStr}::${vidStr || "noVar"}::${aliasName}::${gender}`;
        if (!bucketMap.has(bucketKey)) {
          const reqItem = request.items.find((i) => {
            const iPid = (i.stockItemId?._id || i.stockItemId)?.toString();
            return iPid === pidStr;
          });
          let reqVariant = null;
          if (reqItem) reqVariant = reqItem.variants?.[0] || null;
          let quotItem = null;
          if (reqItem && reqVariant) {
            quotItem = quotation.items.find((qi) => {
              const qiPid = (qi.stockItemId?._id || qi.stockItemId)?.toString();
              if (qiPid !== pidStr) return false;
              return attrsEqual(qi.attributes || [], reqVariant.attributes || []);
            });
          }
          if (!quotItem) {
            quotItem = quotation.items.find((qi) => {
              const qiPid = (qi.stockItemId?._id || qi.stockItemId)?.toString();
              return qiPid === pidStr;
            });
          }
          const unitPrice = Number(quotItem?.unitPrice) || 0;
          const gstPercentage = quotItem?.gstPercentage != null ? Number(quotItem.gstPercentage) : getGSTPercentage(unitPrice);
          bucketMap.set(bucketKey, {
            stockItemId: pidStr, variantId: vidStr,
            itemName: gender ? `${aliasName} (${gender})` : aliasName,
            itemCode: quotItem?.itemCode || reqItem?.stockItemReference || reqItem?.stockItemId?.reference || "",
            hsnCode: quotItem?.hsnCode || reqItem?.stockItemId?.hsnCode || "",
            gender,
            attributes: reqVariant?.attributes || quotItem?.attributes || [],
            unitPrice, gstPercentage, quantity: 0,
            priceBeforeGST: 0, gstAmount: 0, priceIncludingGST: 0,
          });
        }
        bucketMap.get(bucketKey).quantity += qty;
      }
    }

    const rows = Array.from(bucketMap.values()).map((r) => {
      const { priceBeforeGST, gstAmount, priceIncludingGST } = calculateItemTotals(r.quantity, r.unitPrice, r.gstPercentage);
      return { ...r, priceBeforeGST, gstAmount, priceIncludingGST };
    });

    const genderOrder = { Male: 1, Female: 2, Unisex: 3, Kids: 4 };
    rows.sort((a, b) => {
      const nameCmp = (a.itemName || "").localeCompare(b.itemName || "");
      if (nameCmp !== 0) return nameCmp;
      const ga = genderOrder[a.gender] || 99;
      const gb = genderOrder[b.gender] || 99;
      if (ga !== gb) return ga - gb;
      const aSig = (a.attributes || []).map((x) => `${x.name}=${x.value}`).join("|");
      const bSig = (b.attributes || []).map((x) => `${x.name}=${x.value}`).join("|");
      return aSig.localeCompare(bSig);
    });

    const subtotalBeforeGST = rows.reduce((s, r) => s + r.priceBeforeGST, 0);
    const totalGST = rows.reduce((s, r) => s + r.gstAmount, 0);
    const customCharges = quotation.customAdditionalCharges || [];
    const customTotal = customCharges.reduce((s, c) => s + (Number(c.amount) || 0), 0);
    const shipping = Number(quotation.shippingCharges) || 0;
    const grandTotal = subtotalBeforeGST + totalGST + shipping + customTotal;

    const brokenDownQuotation = {
      ...quotation, items: rows,
      subtotalBeforeGST: parseFloat(subtotalBeforeGST.toFixed(2)),
      totalGST: parseFloat(totalGST.toFixed(2)),
      grandTotal: parseFloat(grandTotal.toFixed(2)),
      paymentSchedule: (quotation.paymentSchedule || []).map((p) => ({
        ...p, amount: parseFloat(((grandTotal * (Number(p.percentage) || 0)) / 100).toFixed(2)),
      })),
    };

    res.json({
      success: true, quotation: brokenDownQuotation, request,
      meta: { breakdownApplied: true, rowCount: rows.length, source: "measurement_mpc_aliases" },
    });
  } catch (error) {
    console.error("Error generating PO breakdown:", error);
    res.status(500).json({ success: false, message: "Server error while generating PO breakdown" });
  }
});

module.exports = router;