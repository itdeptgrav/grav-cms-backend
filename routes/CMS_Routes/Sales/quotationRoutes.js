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

// ─── GST RULE (single source of truth) ────────────────────────────────────────
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
      return { ...item, gstPercentage,
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

    Object.assign(quotation, { ...quotationData, items: itemsWithCalculations,
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

// Payment submission status
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
// FIX: Tightened employee-product matching to prevent ghost/wrong assignments
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

    // ── Determine order type ─────────────────────────────────────────────
    const isMeasurementOrder = !!(request.requestType === 'measurement_conversion' || request.measurementId);
    const orderType = isMeasurementOrder ? 'measurement_conversion' : 'customer_request';

    // ── Load measurement if this is a measurement order ──────────────────
    let measurement = null;
    if (isMeasurementOrder && request.measurementId) {
      measurement = await Measurement.findById(request.measurementId)
        .select('_id employeeMeasurements')
        .lean();
      if (measurement) {
        console.log(`[sales-approve] Loaded measurement ${measurement._id} with ${measurement.employeeMeasurements?.length || 0} employees`);
      } else {
        console.warn(`[sales-approve] Measurement ${request.measurementId} not found — will skip employee tracking creation`);
      }
    }

    const createdWorkOrders = [];
    const skippedVariants = [];
    const createdProgressDocs = [];

    // ── Create Work Orders ───────────────────────────────────────────────
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

        // ─────────────────────────────────────────────────────────────────
        // CREATE EmployeeProductionProgress docs for measurement orders
        // ─────────────────────────────────────────────────────────────────
        if (isMeasurementOrder && measurement) {
          const stockIdStr = item.stockItemId.toString();
          const woVariantIdStr = variantData._id.toString();

          // ── FIXED: Find employees assigned to THIS specific product+variant ──
          const employeeEntries = [];
          for (const empM of measurement.employeeMeasurements || []) {

            const productEntry = (empM.products || []).find((p) => {
              // ── Step 1: Match by productId ──────────────────────────────
              const pIdMatch = p.productId?.toString() === stockIdStr;

              if (!pIdMatch) {
                // ── Step 2: productId exists but doesn't match → hard reject ──
                // Only fall through to name match if this product entry has
                // NO productId stored at all (legacy/older measurement data)
                if (p.productId) return false;

                // Legacy fallback: match by name
                if (p.productName !== item.stockItemName) return false;

                // Name matched — also check variant if both sides have it
                if (woVariantIdStr && p.variantId) {
                  return p.variantId.toString() === woVariantIdStr;
                }
                // Name matched, variant info missing on one side → accept
                return true;
              }

              // ── Step 3: productId matched — now check variant ────────────
              if (woVariantIdStr && p.variantId) {
                // Both sides have variant info → must match exactly
                return p.variantId.toString() === woVariantIdStr;
              }

              if (woVariantIdStr && !p.variantId) {
                // WO has a variant but measurement entry doesn't store variantId
                // (older measurement data) — fall back to name confirm
                return p.productName === item.stockItemName;
              }

              // productId matched, no variant to disambiguate → accept
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

            // Safety check: total assigned units must not exceed WO quantity
            const totalAssigned = employeeEntries.reduce((sum, e) => sum + e.quantity, 0);
            if (totalAssigned > workOrder.quantity) {
              console.warn(
                `[sales-approve] WO ${woNumber} (${workOrder.stockItemName}): ` +
                `employee total units (${totalAssigned}) exceeds WO quantity (${workOrder.quantity}). ` +
                `Check measurement data.`
              );
            }

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
                      unitStart,
                      unitEnd,
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
                  employeeName: emp.employeeName,
                  employeeUIN: emp.employeeUIN,
                  productName: workOrder.stockItemName,
                  unitStart, unitEnd,
                  totalUnits: emp.quantity,
                  barcodeCount: assignedBarcodeIds.length,
                });
              } catch (progressErr) {
                console.error(`[sales-approve] Error creating progress doc for ${emp.employeeName}:`, progressErr.message);
              }

              unitCursor = unitEnd + 1;
            }

            console.log(`[sales-approve] Created ${employeeEntries.length} progress doc(s) for WO ${woNumber} (${workOrder.stockItemName})`);
          } else {
            // No employees matched this WO — log clearly so it's easy to spot
            console.warn(
              `[sales-approve] No employees matched WO for "${workOrder.stockItemName}" ` +
              `(stockItemId: ${stockIdStr}, variantId: ${woVariantIdStr}). ` +
              `Check measurement.employeeMeasurements[].products entries.`
            );
          }
        }
        // ─────────────────────────────────────────────────────────────────
      }
    }

    await request.save();

    const autoCount = createdWorkOrders.filter(wo => wo.autoSelectedVariant).length;
    let msg = createdWorkOrders.length > 0
      ? `Quotation approved and ${createdWorkOrders.length} work order(s) created${autoCount > 0 ? ` (${autoCount} with auto-selected variants)` : ''}`
      : "Quotation approved but no work orders were created";

    if (createdProgressDocs.length > 0) {
      msg += `. ${createdProgressDocs.length} employee tracking record(s) created.`;
    }

    res.json({
      success: true, message: msg, request, createdWorkOrders,
      skippedVariants: skippedVariants.length > 0 ? skippedVariants : undefined,
      employeeTrackingCreated: createdProgressDocs.length,
      employeeTrackingDetails: createdProgressDocs.length > 0 ? createdProgressDocs : undefined,
    });
  } catch (error) {
    console.error("Error processing sales approval:", error);
    res.status(500).json({ success: false, message: "Server error while processing approval", error: process.env.NODE_ENV === 'development' ? error.message : undefined });
  }
});



router.get('/:measurementId/po-persons-export', async (req, res) => {
    try {
        const { measurementId } = req.params;
 
        if (!mongoose.Types.ObjectId.isValid(measurementId)) {
            return res.status(400).json({ success: false, message: 'Valid measurement ID required' });
        }
 
        const measurement = await Measurement.findById(measurementId)
            .populate({ path: 'employeeMeasurements.products.productId', select: '_id name' })
            .lean();
 
        if (!measurement) {
            return res.status(404).json({ success: false, message: 'Measurement not found' });
        }
 
        // Fetch MPC employees to get their display product names
        const empIds = measurement.employeeMeasurements.map(e => e.employeeId).filter(Boolean);
 
        const mpcEmployees = await EmployeeMpc.find({ _id: { $in: empIds } })
            .select('_id products department designation')
            .lean();
 
        // Build map: employeeId → productId → mpcProductName
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
 
        // Build CSV
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
                idx + 1,
                `"${emp.employeeName || ''}"`,
                emp.employeeUIN || '',
                emp.gender || '',
                `"${mpcDets.department || ''}"`,
                `"${mpcDets.designation || ''}"`,
                `"${productsStr}"`,
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


// REJECT quotation
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
 
    // ── If this request originated from a measurement, clear its PO fields ──
    if (request.measurementId) {
      await Measurement.findByIdAndUpdate(request.measurementId, {
        $set: {
          convertedToPO: false,
          poRequestId: null,
          poConversionDate: null,
          convertedBy: null,
          poCreatedForEmployeeIds: [],
        },
      });
      console.log(`[delete-request] Reset PO fields on measurement ${request.measurementId}`);
    }
 
    // ── Delete associated work orders if any ────────────────────────────────
    if (WorkOrder) {
      const woResult = await WorkOrder.deleteMany({ customerRequestId: request._id });
      if (woResult.deletedCount) {
        console.log(`[delete-request] Deleted ${woResult.deletedCount} work order(s) for request ${requestId}`);
      }
    }
 
    // ── Delete the CustomerRequest itself ────────────────────────────────────
    await CustomerRequest.findByIdAndDelete(requestId);
 
    res.json({
      success: true,
      message: "PO/Quotation removed successfully",
      measurementReset: !!request.measurementId,
    });
  } catch (error) {
    console.error("Error deleting request:", error);
    res.status(500).json({ success: false, message: "Server error while removing PO/Quotation" });
  }
});



// ═══════════════════════════════════════════════════════════════════════════════
// GET /requests/:requestId/po-breakdown
// Realtime PO breakdown for PDF generation.
// For measurement_conversion POs, expands items into rows keyed by
// (stockItemId, variantId, MPC alias name, gender), summing quantities across
// employees. For non-measurement POs, returns the quotation items as-is.
// Rows are sorted by: productName (alpha) → gender (Male, Female, Unisex, Kids).
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/requests/:requestId/po-breakdown", async (req, res) => {
  try {
    const { requestId } = req.params;

    const request = await CustomerRequest.findById(requestId)
      .populate("items.stockItemId", "name genderCategory hsnCode reference")
      .lean();

    if (!request) {
      return res.status(404).json({ success: false, message: "Request not found" });
    }
    if (!request.quotations || request.quotations.length === 0) {
      return res.status(400).json({ success: false, message: "No quotation found for this request" });
    }

    const quotation = request.quotations[0];

    // ── Non-measurement POs: no breakdown needed, return as-is ────────────
    const isMeasurementPO =
      request.requestType === "measurement_conversion" && !!request.measurementId;

    if (!isMeasurementPO) {
      return res.json({ success: true, quotation, request });
    }

    // ── Load measurement ──────────────────────────────────────────────────
    const measurement = await Measurement.findById(request.measurementId)
      .select("employeeMeasurements")
      .lean();

    if (!measurement) {
      console.warn(`[po-breakdown] Measurement ${request.measurementId} not found, falling back to stored quotation`);
      return res.json({ success: true, quotation, request });
    }

    // ── Load EmployeeMpc records for alias lookup ─────────────────────────
    const empIds = (measurement.employeeMeasurements || [])
      .map((e) => e.employeeId)
      .filter(Boolean);

    const mpcEmployees = await EmployeeMpc.find({ _id: { $in: empIds } })
      .select("_id products")
      .lean();

    // Map<empIdStr, Map<"pid::vid"|"pid::_noVar_"|pid, aliasProductName>>
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
        // fallback bucket (first one wins)
        if (!lookup.has(pidStr)) lookup.set(pidStr, alias);
      }
      mpcAliasMap.set(eid, lookup);
    }

    // ── Helper: attribute-equal match for quotation item lookup ──────────
    const attrsEqual = (a = [], b = []) => {
      if (a.length !== b.length) return false;
      return a.every((x) =>
        b.some((y) => y.name === x.name && y.value === x.value)
      );
    };

    // ── Bucket: key = "pid::vid::alias::gender" ───────────────────────────
    const bucketMap = new Map();

    for (const empM of measurement.employeeMeasurements || []) {
      const eid = empM.employeeId?.toString();
      const gender = empM.gender || "Unisex";
      const aliasLookup = mpcAliasMap.get(eid) || new Map();

      for (const prod of empM.products || []) {
        const pidStr = prod.productId?.toString();
        if (!pidStr) continue;
        const vidStr = prod.variantId?.toString() || null;
        const qty = Number(prod.quantity) || 0;
        if (qty <= 0) continue;

        // Resolve alias — prefer variant-specific, then product-only, then measurement's own stored name
        let aliasName =
          (vidStr && aliasLookup.get(`${pidStr}::${vidStr}`)) ||
          aliasLookup.get(`${pidStr}::_noVar_`) ||
          aliasLookup.get(pidStr) ||
          (prod.productName || "").trim() ||
          "Unknown";

        const bucketKey = `${pidStr}::${vidStr || "noVar"}::${aliasName}::${gender}`;

        if (!bucketMap.has(bucketKey)) {
          // Find the corresponding request item + variant to pull attributes/reference
          const reqItem = request.items.find((i) => {
            const iPid = (i.stockItemId?._id || i.stockItemId)?.toString();
            return iPid === pidStr;
          });

          let reqVariant = null;
          if (reqItem) {
            // try match by attribute set if measurement variant attrs exist somewhere,
            // otherwise fall back to the first variant under this stockItem
            // (we don't have attrs on measurement.products[] so we'll rely on index position of variant in stockItem — use first for now)
            reqVariant = reqItem.variants?.[0] || null;
          }

          // Match quotation item by stockItemId + attribute equality
          let quotItem = null;
          if (reqItem && reqVariant) {
            quotItem = quotation.items.find((qi) => {
              const qiPid = (qi.stockItemId?._id || qi.stockItemId)?.toString();
              if (qiPid !== pidStr) return false;
              return attrsEqual(qi.attributes || [], reqVariant.attributes || []);
            });
          }
          // Fallback — first quotation item with matching stockItemId
          if (!quotItem) {
            quotItem = quotation.items.find((qi) => {
              const qiPid = (qi.stockItemId?._id || qi.stockItemId)?.toString();
              return qiPid === pidStr;
            });
          }

          const unitPrice = Number(quotItem?.unitPrice) || 0;
          const gstPercentage =
            quotItem?.gstPercentage != null
              ? Number(quotItem.gstPercentage)
              : getGSTPercentage(unitPrice);

          bucketMap.set(bucketKey, {
            stockItemId: pidStr,
            variantId: vidStr,
            itemName: gender ? `${aliasName} (${gender})` : aliasName,
            itemCode:
              quotItem?.itemCode ||
              reqItem?.stockItemReference ||
              reqItem?.stockItemId?.reference ||
              "",
            hsnCode:
              quotItem?.hsnCode ||
              reqItem?.stockItemId?.hsnCode ||
              "",
            gender,
            attributes: reqVariant?.attributes || quotItem?.attributes || [],
            unitPrice,
            gstPercentage,
            quantity: 0,
            priceBeforeGST: 0,
            gstAmount: 0,
            priceIncludingGST: 0,
          });
        }

        bucketMap.get(bucketKey).quantity += qty;
      }
    }

    // ── Finalise rows: compute totals, sort ───────────────────────────────
    const rows = Array.from(bucketMap.values()).map((r) => {
      const { priceBeforeGST, gstAmount, priceIncludingGST } = calculateItemTotals(
        r.quantity,
        r.unitPrice,
        r.gstPercentage
      );
      return { ...r, priceBeforeGST, gstAmount, priceIncludingGST };
    });

    const genderOrder = { Male: 1, Female: 2, Unisex: 3, Kids: 4 };
    rows.sort((a, b) => {
      const nameCmp = (a.itemName || "").localeCompare(b.itemName || "");
      if (nameCmp !== 0) return nameCmp;
      const ga = genderOrder[a.gender] || 99;
      const gb = genderOrder[b.gender] || 99;
      if (ga !== gb) return ga - gb;
      // tie-break by attribute signature so rows stay stable
      const aSig = (a.attributes || []).map((x) => `${x.name}=${x.value}`).join("|");
      const bSig = (b.attributes || []).map((x) => `${x.name}=${x.value}`).join("|");
      return aSig.localeCompare(bSig);
    });

    // ── Rebuild quotation totals from broken-down rows ────────────────────
    const subtotalBeforeGST = rows.reduce((s, r) => s + r.priceBeforeGST, 0);
    const totalGST = rows.reduce((s, r) => s + r.gstAmount, 0);
    const customCharges = quotation.customAdditionalCharges || [];
    const customTotal = customCharges.reduce((s, c) => s + (Number(c.amount) || 0), 0);
    const shipping = Number(quotation.shippingCharges) || 0;
    const grandTotal = subtotalBeforeGST + totalGST + shipping + customTotal;

    const brokenDownQuotation = {
      ...quotation,
      items: rows,
      subtotalBeforeGST: parseFloat(subtotalBeforeGST.toFixed(2)),
      totalGST: parseFloat(totalGST.toFixed(2)),
      grandTotal: parseFloat(grandTotal.toFixed(2)),
      paymentSchedule: (quotation.paymentSchedule || []).map((p) => ({
        ...p,
        amount: parseFloat(
          ((grandTotal * (Number(p.percentage) || 0)) / 100).toFixed(2)
        ),
      })),
    };

    res.json({
      success: true,
      quotation: brokenDownQuotation,
      request,
      meta: {
        breakdownApplied: true,
        rowCount: rows.length,
        source: "measurement_mpc_aliases",
      },
    });
  } catch (error) {
    console.error("Error generating PO breakdown:", error);
    res.status(500).json({
      success: false,
      message: "Server error while generating PO breakdown",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});



module.exports = router;