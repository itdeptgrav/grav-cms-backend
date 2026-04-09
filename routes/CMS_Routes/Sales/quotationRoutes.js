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
<<<<<<< HEAD
        console.log(`Processing variant: ${JSON.stringify(variant)}`);
        
        // Find the correct variant in stockItem
        let variantData = null;
        
        // Method 1: Try to match by variantId (if it's a MongoDB ObjectId string)
        if (variant.variantId && mongoose.Types.ObjectId.isValid(variant.variantId)) {
          variantData = stockItem.variants.find(v => 
            v._id.toString() === variant.variantId
          );
        }
        
        // Method 2: If no match by ID or variantId is not ObjectId, try to match by attributes
        if (!variantData && variant.attributes && variant.attributes.length > 0) {
          variantData = stockItem.variants.find(v => {
            // Check if all attributes match
            if (!v.attributes || v.attributes.length !== variant.attributes.length) {
              return false;
            }
            
            // Check each attribute
            const allAttributesMatch = variant.attributes.every(reqAttr => {
              const stockAttr = v.attributes.find(a => a.name === reqAttr.name);
              return stockAttr && stockAttr.value === reqAttr.value;
            });
            
            return allAttributesMatch;
          });
        }
        
        // Method 3: Try to match by variantId as SKU (if variantId is actually SKU)
=======
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
>>>>>>> origin/main
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

<<<<<<< HEAD
        console.log(`Found matching variant: ${variantData.sku}`);

        // Get operations from stockItem
=======
>>>>>>> origin/main
        const operations = stockItem.operations.map(op => ({
          operationType: op.type,
          machineType: op.machineType,
          assignedMachine: null,
          assignedMachineName: null,
          estimatedTimeSeconds: op.totalSeconds || 0,
          scheduledStartTime: null,
          scheduledEndTime: null,
          operatorAssigned: null,
          operatorName: null,
          actualStartTime: null,
          actualEndTime: null,
          status: "pending"
        }));

        let rawMaterials = [];
<<<<<<< HEAD
        
        if (variantData.rawItems && variantData.rawItems.length > 0) {
=======
        if (variantData.rawItems?.length > 0) {
>>>>>>> origin/main
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

<<<<<<< HEAD
    res.json({
      success: true,
      message: createdWorkOrders.length > 0 
        ? `Quotation approved by sales and ${createdWorkOrders.length} work order(s) created` 
        : "Quotation approved by sales but no work orders were created (check variant matching)",
      request: request,
      createdWorkOrders: createdWorkOrders
    });
=======
    const autoCount = createdWorkOrders.filter(wo => wo.autoSelectedVariant).length;
    let msg = createdWorkOrders.length > 0
      ? `Quotation approved and ${createdWorkOrders.length} work order(s) created${autoCount > 0 ? ` (${autoCount} with auto-selected variants)` : ''}`
      : "Quotation approved but no work orders were created";
>>>>>>> origin/main

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



module.exports = router;