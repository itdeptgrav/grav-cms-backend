// routes/CMS_Routes/Sales/quotationRoutes.js

const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const CustomerRequest = require("../../../models/Customer_Models/CustomerRequest");
const StockItem = require("../../../models/CMS_Models/Inventory/Products/StockItem");
const CustomerEmailService = require('../../../services/CustomerEmailService');
const WorkOrder = require("../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const mongoose = require("mongoose");

// Apply auth middleware
router.use(EmployeeAuthMiddleware);

// Helper function to extract GST percentage
const extractGSTPercentage = (salesTaxString) => {
  if (!salesTaxString) return 18;
  const match = salesTaxString.match(/(\d+(\.\d+)?)%/);
  return match && match[1] ? parseFloat(match[1]) : 18;
};

// Function to separate GST from price
const separateGSTFromPrice = (priceIncludingGST, gstPercentage) => {
  if (!gstPercentage || gstPercentage === 0) {
    return {
      priceBeforeGST: priceIncludingGST,
      gstAmount: 0
    };
  }

  const priceBeforeGST = (priceIncludingGST * 100) / (100 + gstPercentage);
  const gstAmount = priceIncludingGST - priceBeforeGST;

  return {
    priceBeforeGST: parseFloat(priceBeforeGST.toFixed(2)),
    gstAmount: parseFloat(gstAmount.toFixed(2))
  };
};


// CREATE quotation for a request
router.post("/requests/:requestId/quotation", async (req, res) => {
  try {
    const { requestId } = req.params;
    const quotationData = req.body;

    const request = await CustomerRequest.findById(requestId);
    if (!request) {
      return res.status(404).json({
        success: false,
        message: "Request not found"
      });
    }

    // Check if quotation already exists
    const existingQuotation = request.quotations.length > 0 ? request.quotations[0] : null;

    // Generate quotation number if new
    const quotationNumber = existingQuotation
      ? existingQuotation.quotationNumber
      : `QT-${request.requestId}-001`;

    // Prepare items with proper GST calculations
    const itemsWithCalculations = await Promise.all(quotationData.items.map(async (item) => {
      let gstPercentage = 18; // Default

      if (item.stockItemId) {
        const stockItem = await StockItem.findById(item.stockItemId);
        if (stockItem) {
          gstPercentage = extractGSTPercentage(stockItem.salesTax);
        }
      }

      const priceIncludingGST = item.unitPrice * item.quantity;
      const { priceBeforeGST, gstAmount } = separateGSTFromPrice(priceIncludingGST, gstPercentage);
      const discountAmount = priceIncludingGST * (item.discountPercentage / 100);
      const priceAfterDiscount = priceIncludingGST - discountAmount;
      const discountedPriceBreakdown = separateGSTFromPrice(priceAfterDiscount, gstPercentage);

      return {
        ...item,
        gstPercentage: gstPercentage,
        priceBeforeGST: discountedPriceBreakdown.priceBeforeGST,
        gstAmount: discountedPriceBreakdown.gstAmount,
        priceIncludingGST: priceAfterDiscount,
        discountAmount: discountAmount,
        stockInfo: {
          quantityOnHand: stockItem?.quantityOnHand || 0,
          status: stockItem?.status || 'Unknown'
        }
      };
    }));

    // Calculate totals INCLUDING custom charges
    const subtotalBeforeGST = itemsWithCalculations.reduce((sum, item) => sum + (item.priceBeforeGST || 0), 0);
    const totalDiscount = itemsWithCalculations.reduce((sum, item) => sum + (item.discountAmount || 0), 0);
    const totalGST = itemsWithCalculations.reduce((sum, item) => sum + (item.gstAmount || 0), 0);

    const shippingCharges = parseFloat(quotationData.shippingCharges) || 0;
    const customAdditionalCharges = quotationData.customAdditionalCharges || [];
    const totalCustomCharges = customAdditionalCharges.reduce((sum, charge) => sum + (charge.amount || 0), 0);

    const grandTotal = subtotalBeforeGST + totalGST + shippingCharges + totalCustomCharges;

    // Create or update quotation
    const quotation = {
      ...quotationData,
      items: itemsWithCalculations,
      customAdditionalCharges: customAdditionalCharges,
      subtotalBeforeGST: parseFloat(subtotalBeforeGST.toFixed(2)),
      totalDiscount: parseFloat(totalDiscount.toFixed(2)),
      totalGST: parseFloat(totalGST.toFixed(2)),
      shippingCharges: parseFloat(shippingCharges.toFixed(2)),
      grandTotal: parseFloat(grandTotal.toFixed(2)),
      quotationNumber,
      preparedBy: req.user.id,
      status: quotationData.status || 'draft',
      updatedAt: new Date()
    };

    if (!existingQuotation) {
      // Create new quotation
      quotation.createdAt = new Date();
      request.quotations.push(quotation);
    } else {
      // Update existing quotation
      Object.assign(existingQuotation, quotation);
    }

    // Set as current quotation
    const currentQuotation = existingQuotation || request.quotations[request.quotations.length - 1];
    request.currentQuotation = currentQuotation._id;

    // Update request status
    if (quotationData.status === 'sent_to_customer') {
      request.status = 'quotation_sent';
      currentQuotation.sentToCustomerAt = new Date();
      currentQuotation.sentBy = req.user.id;
    } else if (quotationData.status === 'draft') {
      request.status = 'quotation_draft';
    }

    // Update tax summary
    request.taxSummary = {
      totalGST,
      sgst: totalGST / 2,
      cgst: totalGST / 2,
      igst: 0
    };

    request.quotationValidUntil = new Date(quotationData.validUntil);
    request.updatedAt = new Date();

    await request.save();

    res.json({
      success: true,
      message: existingQuotation ? "Quotation updated successfully" : "Quotation created successfully",
      quotation: currentQuotation,
      request: request
    });

  } catch (error) {
    console.error("Error saving quotation:", error);
    res.status(500).json({
      success: false,
      message: "Server error while saving quotation"
    });
  }
});

// UPDATE quotation
router.put("/requests/:requestId/quotation/:quotationId", async (req, res) => {
  try {
    const { requestId, quotationId } = req.params;
    const quotationData = req.body;

    const request = await CustomerRequest.findById(requestId);
    if (!request) {
      return res.status(404).json({
        success: false,
        message: "Request not found"
      });
    }

    const quotation = request.quotations.id(quotationId);
    if (!quotation) {
      return res.status(404).json({
        success: false,
        message: "Quotation not found"
      });
    }

    // Only allow updates for draft quotations
    if (quotation.status !== 'draft') {
      return res.status(400).json({
        success: false,
        message: "Only draft quotations can be updated"
      });
    }

    // Recalculate items with GST
    const itemsWithCalculations = await Promise.all(quotationData.items.map(async (item) => {
      let gstPercentage = 18;

      if (item.stockItemId) {
        const stockItem = await StockItem.findById(item.stockItemId);
        if (stockItem) {
          gstPercentage = extractGSTPercentage(stockItem.salesTax);
        }
      }

      const priceIncludingGST = item.unitPrice * item.quantity;
      const { priceBeforeGST, gstAmount } = separateGSTFromPrice(priceIncludingGST, gstPercentage);
      const discountAmount = priceIncludingGST * (item.discountPercentage / 100);
      const priceAfterDiscount = priceIncludingGST - discountAmount;
      const discountedPriceBreakdown = separateGSTFromPrice(priceAfterDiscount, gstPercentage);

      return {
        ...item,
        gstPercentage: gstPercentage,
        priceBeforeGST: discountedPriceBreakdown.priceBeforeGST,
        gstAmount: discountedPriceBreakdown.gstAmount,
        priceIncludingGST: priceAfterDiscount,
        discountAmount: discountAmount
      };
    }));

    // Recalculate totals
    const subtotalBeforeGST = itemsWithCalculations.reduce((sum, item) => sum + (item.priceBeforeGST || 0), 0);
    const totalDiscount = itemsWithCalculations.reduce((sum, item) => sum + (item.discountAmount || 0), 0);
    const totalGST = itemsWithCalculations.reduce((sum, item) => sum + (item.gstAmount || 0), 0);

    const shippingCharges = parseFloat(quotationData.shippingCharges) || 0;
    const adjustment = parseFloat(quotationData.adjustment) || 0;
    const grandTotal = subtotalBeforeGST + totalGST + shippingCharges + adjustment;

    // Update quotation
    Object.assign(quotation, {
      ...quotationData,
      items: itemsWithCalculations,
      subtotalBeforeGST: parseFloat(subtotalBeforeGST.toFixed(2)),
      totalDiscount: parseFloat(totalDiscount.toFixed(2)),
      totalGST: parseFloat(totalGST.toFixed(2)),
      shippingCharges: parseFloat(shippingCharges.toFixed(2)),
      adjustment: parseFloat(adjustment.toFixed(2)),
      grandTotal: parseFloat(grandTotal.toFixed(2)),
      updatedAt: new Date()
    });

    // Update request tax summary
    request.taxSummary = {
      totalGST,
      sgst: totalGST / 2,
      cgst: totalGST / 2,
      igst: 0
    };

    request.quotationValidUntil = new Date(quotationData.validUntil);
    request.updatedAt = new Date();

    await request.save();

    res.json({
      success: true,
      message: "Quotation updated successfully",
      quotation: quotation,
      request: request
    });

  } catch (error) {
    console.error("Error updating quotation:", error);
    res.status(500).json({
      success: false,
      message: "Server error while updating quotation"
    });
  }
});

// ADD NEW ROUTE: Update payment submission status
router.put("/payment-submissions/:submissionId/status", async (req, res) => {
  try {
    const { submissionId } = req.params;
    const { status, verificationNotes } = req.body;

    // Find request with this payment submission
    const request = await CustomerRequest.findOne({
      'quotations.paymentSubmissions._id': submissionId
    });

    if (!request) {
      return res.status(404).json({
        success: false,
        message: "Payment submission not found"
      });
    }

    // Find the quotation and submission
    const quotation = request.quotations.find(q =>
      q.paymentSubmissions.some(s => s._id.toString() === submissionId)
    );

    if (!quotation) {
      return res.status(404).json({
        success: false,
        message: "Quotation not found"
      });
    }

    const submission = quotation.paymentSubmissions.id(submissionId);
    if (!submission) {
      return res.status(404).json({
        success: false,
        message: "Payment submission not found"
      });
    }

    // Update submission status
    submission.status = status;
    submission.verifiedBy = req.user.id;
    submission.verifiedAt = new Date();
    if (verificationNotes) {
      submission.verificationNotes = verificationNotes;
    }
    submission.updatedAt = new Date();

    // Update corresponding payment schedule if verified
    if (status === 'verified') {
      const paymentStep = quotation.paymentSchedule.find(p => p.stepNumber === submission.paymentStepNumber);
      if (paymentStep) {
        paymentStep.paidAmount = (paymentStep.paidAmount || 0) + submission.submittedAmount;
        paymentStep.paidDate = new Date();
        if (paymentStep.paidAmount >= paymentStep.amount) {
          paymentStep.status = 'paid';
        } else {
          paymentStep.status = 'partially_paid';
        }
      }
    }

    await request.save();

    res.json({
      success: true,
      message: "Payment submission status updated",
      submission: submission
    });

  } catch (error) {
    console.error("Error updating payment submission:", error);
    res.status(500).json({
      success: false,
      message: "Server error while updating payment submission"
    });
  }
});

// ADD NEW ROUTE: Get payment submissions for a quotation
router.get("/requests/:requestId/payment-submissions", async (req, res) => {
  try {
    const { requestId } = req.params;

    const request = await CustomerRequest.findById(requestId);
    if (!request) {
      return res.status(404).json({
        success: false,
        message: "Request not found"
      });
    }

    if (request.quotations.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No quotation found"
      });
    }

    const quotation = request.quotations[0];

    res.json({
      success: true,
      submissions: quotation.paymentSubmissions || []
    });

  } catch (error) {
    console.error("Error fetching payment submissions:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching payment submissions"
    });
  }
});

// SEND quotation to customer
// UPDATE: Send quotation to customer (simplified)
// SEND quotation to customer
router.post("/requests/:requestId/quotation/send", async (req, res) => {
  try {
    const { requestId } = req.params;

    const request = await CustomerRequest.findById(requestId);
    if (!request) {
      return res.status(404).json({
        success: false,
        message: "Request not found"
      });
    }

    if (request.quotations.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No quotation found to send"
      });
    }

    const quotation = request.quotations[0];

    // Only allow sending draft quotations
    if (quotation.status !== 'draft') {
      return res.status(400).json({
        success: false,
        message: "Only draft quotations can be sent"
      });
    }

    // Update quotation status
    quotation.status = 'sent_to_customer';
    quotation.sentToCustomerAt = new Date();
    quotation.sentBy = req.user.id;
    quotation.updatedAt = new Date();

    // Update request status
    request.status = 'quotation_sent';
    request.updatedAt = new Date();

    // Add notification
    request.quotationNotifications.push({
      type: 'customer_approval',
      message: 'Quotation sent to customer for approval',
      actionRequired: false,
      createdAt: new Date()
    });

    await request.save();

    // Send quotation email to customer
    try {
      await CustomerEmailService.sendQuotationEmail(request, quotation, req.user);
    } catch (emailError) {
      console.error("Failed to send quotation email:", emailError);
      // Don't fail the request if email fails
    }

    res.json({
      success: true,
      message: "Quotation sent to customer successfully",
      request: request
    });

  } catch (error) {
    console.error("Error sending quotation:", error);
    res.status(500).json({
      success: false,
      message: "Server error while sending quotation"
    });
  }
});


// Add this route to your quotationRoutes.js file

// GET payment submissions for a specific quotation
router.get("/requests/:requestId/quotation/:quotationId/payment-submissions", async (req, res) => {
  try {
    const { requestId, quotationId } = req.params;

    const request = await CustomerRequest.findById(requestId);
    if (!request) {
      return res.status(404).json({
        success: false,
        message: "Request not found"
      });
    }

    const quotation = request.quotations.id(quotationId);
    if (!quotation) {
      return res.status(404).json({
        success: false,
        message: "Quotation not found"
      });
    }

    // Get payment submissions for this quotation
    const submissions = quotation.paymentSubmissions || [];

    // Sort by submission date (newest first)
    submissions.sort((a, b) => new Date(b.submissionDate) - new Date(a.submissionDate));

    res.json({
      success: true,
      submissions: submissions,
      count: submissions.length
    });

  } catch (error) {
    console.error("Error fetching payment submissions:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching payment submissions"
    });
  }
});

// SALES APPROVAL - FIXED VERSION with Variant Raw Item Support
router.post("/requests/:requestId/quotation/sales-approve", async (req, res) => {
  try {
    const { requestId } = req.params;
    const { notes } = req.body;

    const request = await CustomerRequest.findById(requestId);
    if (!request) {
      return res.status(404).json({
        success: false,
        message: "Request not found"
      });
    }

    if (request.quotations.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No quotation found for this request"
      });
    }

    const quotation = request.quotations[0];

    if (quotation.status !== 'customer_approved') {
      return res.status(400).json({
        success: false,
        message: "Quotation is not approved by customer"
      });
    }

    // Update quotation status
    quotation.status = 'sales_approved';
    quotation.salesApproval = {
      approved: true,
      approvedAt: new Date(),
      approvedBy: req.user.id,
      notes: notes || ''
    };
    quotation.updatedAt = new Date();

    // Update request status
    request.status = 'quotation_sales_approved';
    request.finalOrderPrice = quotation.grandTotal;
    request.updatedAt = new Date();

    // Clear notifications
    request.quotationNotifications = request.quotationNotifications.filter(
      n => n.type !== 'sales_approval_required'
    );

    const createdWorkOrders = [];

    // Process each item in the request
    for (const item of request.items) {
      const stockItem = await StockItem.findById(item.stockItemId);
      if (!stockItem) {
        console.warn(`StockItem not found: ${item.stockItemId} for ${item.stockItemName}`);
        continue;
      }

      // Process each variant in the item
      for (const variant of item.variants) {
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
        if (!variantData && variant.variantId) {
          variantData = stockItem.variants.find(v => v.sku === variant.variantId);
        }

        if (!variantData) {
          console.warn(`Variant not found in stockItem. Request variant:`, variant);
          console.warn(`Available variants in stockItem:`, stockItem.variants.map(v => ({
            id: v._id,
            sku: v.sku,
            attributes: v.attributes
          })));
          continue;
        }

        console.log(`Found matching variant: ${variantData.sku}`);

        // Get operations from stockItem
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

        // Get raw materials - FROM VARIANT-SPECIFIC RAW ITEMS
        let rawMaterials = [];
        
        if (variantData.rawItems && variantData.rawItems.length > 0) {
          rawMaterials = variantData.rawItems.map(rawItem => ({
            rawItemId: rawItem.rawItemId,
            name: rawItem.rawItemName,
            sku: rawItem.rawItemSku,
            // STORE VARIANT INFORMATION FOR RAW ITEMS
            rawItemVariantId: rawItem.variantId || null,
            rawItemVariantCombination: rawItem.variantCombination || [],
            quantityRequired: rawItem.quantity * variant.quantity,
            quantityAllocated: 0,
            quantityIssued: 0,
            unit: rawItem.unit,
            unitCost: rawItem.unitCost,
            totalCost: rawItem.totalCost * variant.quantity,
            allocationStatus: "not_allocated"
          }));
        } else {
          console.warn(`No raw items found for variant: ${variantData.sku}. Using empty BOM.`);
        }

        // Get variant attributes
        const variantAttributes = variant.attributes || [];
        if (variantAttributes.length === 0 && variantData.attributes) {
          variantAttributes.push(...variantData.attributes);
        }

        // Create work order
        const workOrder = new WorkOrder({
          customerRequestId: request._id,
          stockItemId: item.stockItemId,
          stockItemName: item.stockItemName,
          stockItemReference: item.stockItemReference,
          variantId: variantData._id.toString(),
          variantAttributes: variantAttributes,
          quantity: variant.quantity,
          customerId: request.customerId,
          customerName: request.customerInfo.name,
          priority: request.priority,
          status: "pending",
          operations: operations,
          rawMaterials: rawMaterials,
          timeline: {
            plannedStartDate: null,
            plannedEndDate: null,
            actualStartDate: null,
            actualEndDate: null,
            scheduledStartDate: null,
            scheduledEndDate: null
          },
          specialInstructions: variant.specialInstructions || [],
          estimatedCost: rawMaterials.reduce((total, rm) => total + (rm.totalCost || 0), 0),
          actualCost: 0,
          createdBy: req.user.id
        });

        await workOrder.save();
        createdWorkOrders.push({
          _id: workOrder._id,
          workOrderNumber: workOrder.workOrderNumber,
          stockItemName: workOrder.stockItemName,
          variantId: workOrder.variantId,
          variantAttributes: workOrder.variantAttributes,
          quantity: workOrder.quantity,
          rawMaterialCount: workOrder.rawMaterials.length,
          status: workOrder.status
        });
      }
    }

    await request.save();

    res.json({
      success: true,
      message: createdWorkOrders.length > 0 
        ? `Quotation approved by sales and ${createdWorkOrders.length} work order(s) created` 
        : "Quotation approved by sales but no work orders were created (check variant matching)",
      request: request,
      createdWorkOrders: createdWorkOrders
    });

  } catch (error) {
    console.error("Error processing sales approval:", error);
    res.status(500).json({
      success: false,
      message: "Server error while processing approval",
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});


// REJECT quotation
router.post("/requests/:requestId/quotation/reject", async (req, res) => {
  try {
    const { requestId } = req.params;
    const { reason } = req.body;

    const request = await CustomerRequest.findById(requestId);
    if (!request) {
      return res.status(404).json({
        success: false,
        message: "Request not found"
      });
    }

    if (request.quotations.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No quotation found"
      });
    }

    const quotation = request.quotations[0];

    // Update quotation status
    quotation.status = 'rejected';
    quotation.updatedAt = new Date();

    // If rejected by sales after customer approval, add sales rejection notes
    if (quotation.status === 'customer_approved') {
      quotation.salesApproval = {
        approved: false,
        approvedAt: new Date(),
        approvedBy: req.user.id,
        notes: reason || 'Rejected by sales team'
      };
    }

    // Update request status based on current state
    if (request.status === 'quotation_customer_approved') {
      request.status = 'quotation_sent'; // Go back to sent state
    } else {
      request.status = 'in_progress'; // Go back to processing
    }

    request.updatedAt = new Date();

    // Add notification
    request.quotationNotifications.push({
      type: 'quotation_expired',
      message: `Quotation rejected: ${reason}`,
      actionRequired: false
    });

    await request.save();

    res.json({
      success: true,
      message: "Quotation rejected",
      request: request
    });

  } catch (error) {
    console.error("Error rejecting quotation:", error);
    res.status(500).json({
      success: false,
      message: "Server error while rejecting quotation"
    });
  }
});

// GET quotation details
router.get("/requests/:requestId/quotations/:quotationId", async (req, res) => {
  try {
    const { requestId, quotationId } = req.params;

    const request = await CustomerRequest.findById(requestId);
    if (!request) {
      return res.status(404).json({
        success: false,
        message: "Request not found"
      });
    }

    const quotation = request.quotations.id(quotationId);
    if (!quotation) {
      return res.status(404).json({
        success: false,
        message: "Quotation not found"
      });
    }

    res.json({
      success: true,
      quotation: quotation
    });

  } catch (error) {
    console.error("Error fetching quotation:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching quotation"
    });
  }
});

// GET all quotations for a request
router.get("/requests/:requestId/quotations", async (req, res) => {
  try {
    const { requestId } = req.params;

    const request = await CustomerRequest.findById(requestId);
    if (!request) {
      return res.status(404).json({
        success: false,
        message: "Request not found"
      });
    }

    res.json({
      success: true,
      quotations: request.quotations
    });

  } catch (error) {
    console.error("Error fetching quotations:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching quotations"
    });
  }
});

// DOWNLOAD quotation as PDF
router.get("/requests/:requestId/quotations/:quotationId/download", async (req, res) => {
  try {
    const { requestId, quotationId } = req.params;

    const request = await CustomerRequest.findById(requestId);
    if (!request) {
      return res.status(404).json({
        success: false,
        message: "Request not found"
      });
    }

    const quotation = request.quotations.id(quotationId);
    if (!quotation) {
      return res.status(404).json({
        success: false,
        message: "Quotation not found"
      });
    }

    // For now, return JSON data
    // In production, you would generate PDF here
    res.json({
      success: true,
      quotation: quotation,
      request: {
        requestId: request.requestId,
        customerInfo: request.customerInfo
      }
    });

  } catch (error) {
    console.error("Error fetching quotation for download:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching quotation"
    });
  }
});

module.exports = router;