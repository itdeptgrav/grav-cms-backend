// routes/Customer_Routes/QuotationRoutes.js

const express = require('express');
const router = express.Router();
const Request = require('../../models/Customer_Models/CustomerRequest');
const Customer = require('../../models/Customer_Models/Customer');
const jwt = require('jsonwebtoken');
const CustomerEmailService = require('../../services/CustomerEmailService');

// Middleware to verify customer token
const verifyCustomerToken = async (req, res, next) => {
  try {
    const token = req.cookies.customerToken;
    
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. Please sign in.'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'grav_clothing_secret_key_2024');
    req.customerId = decoded.id;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid token. Please sign in again.'
    });
  }
};

// GET quotation details for a request
router.get('/requests/:requestId/quotation', verifyCustomerToken, async (req, res) => {
  try {
    const { requestId } = req.params;
    const customerId = req.customerId;

    const request = await Request.findOne({ 
      _id: requestId, 
      customerId 
    });

    if (!request) {
      return res.status(404).json({
        success: false,
        message: 'Request not found'
      });
    }

    // Check if there are any quotations
    if (!request.quotations || request.quotations.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No quotation found for this request'
      });
    }

    // Get the latest quotation
    const latestQuotation = request.quotations[request.quotations.length - 1];

    res.status(200).json({
      success: true,
      quotation: latestQuotation,
      request: {
        requestId: request.requestId,
        customerInfo: request.customerInfo
      }
    });

  } catch (error) {
    console.error('Get quotation error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// APPROVE quotation (customer side)
router.post('/requests/:requestId/quotation/approve', verifyCustomerToken, async (req, res) => {
  try {
    const { requestId } = req.params;
    const { notes, quotationId } = req.body;
    const customerId = req.customerId;

    const request = await Request.findOne({ 
      _id: requestId, 
      customerId 
    });

    if (!request) {
      return res.status(404).json({
        success: false,
        message: 'Request not found'
      });
    }

    let quotation;
    if (quotationId) {
      // Find specific quotation
      quotation = request.quotations.id(quotationId);
    } else {
      // Get the latest quotation
      quotation = request.quotations[request.quotations.length - 1];
    }

    if (!quotation) {
      return res.status(404).json({
        success: false,
        message: 'Quotation not found'
      });
    }

    // Check if quotation can be approved
    if (quotation.status !== 'sent_to_customer') {
      return res.status(400).json({
        success: false,
        message: 'Quotation is not in a state that can be approved'
      });
    }

    // Check if quotation is expired
    if (quotation.validUntil && new Date(quotation.validUntil) < new Date()) {
      return res.status(400).json({
        success: false,
        message: 'Quotation has expired'
      });
    }

    // Update quotation with customer approval
    quotation.status = 'customer_approved';
    quotation.customerApproval = {
      approved: true,
      approvedAt: new Date(),
      approvedBy: customerId,
      notes: notes || ''
    };
    quotation.updatedAt = new Date();

    // Update request status
    request.status = 'quotation_customer_approved';
    request.finalOrderPrice = quotation.grandTotal;
    request.totalDueAmount = Math.max(0, (quotation.grandTotal || 0) - (request.totalPaidAmount || 0));
    request.updatedAt = new Date();

    // Put it on the sales team's action list — approval alone does not move the
    // order to production, a sales approval still has to follow.
    request.quotationNotifications = request.quotationNotifications || [];
    request.quotationNotifications.push({
      type: 'sales_approval_required',
      message: `Customer approved quotation ${quotation.quotationNumber || ''}. Sales approval required to push the order to production.`,
      relatedId: quotation._id,
      actionRequired: true,
      createdAt: new Date(),
    });

    // Add note
    request.notes.push({
      text: `Customer approved quotation ${quotation.quotationNumber}. ${notes ? 'Notes: ' + notes : ''}`,
      addedBy: customerId,
      addedByModel: 'Customer',
      createdAt: new Date()
    });

    await request.save();

    // Send notification to sales team
    // TODO: Implement notification system

    res.status(200).json({
      success: true,
      message: 'Quotation approved successfully',
      quotation,
      request
    });

  } catch (error) {
    console.error('Approve quotation error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// REJECT quotation (customer side)
router.post('/requests/:requestId/quotation/reject', verifyCustomerToken, async (req, res) => {
  try {
    const { requestId } = req.params;
    const { reason, quotationId } = req.body;
    const customerId = req.customerId;

    const request = await Request.findOne({ 
      _id: requestId, 
      customerId 
    });

    if (!request) {
      return res.status(404).json({
        success: false,
        message: 'Request not found'
      });
    }

    let quotation;
    if (quotationId) {
      quotation = request.quotations.id(quotationId);
    } else {
      quotation = request.quotations[request.quotations.length - 1];
    }

    if (!quotation) {
      return res.status(404).json({
        success: false,
        message: 'Quotation not found'
      });
    }

    // Check if quotation can be rejected
    if (quotation.status !== 'sent_to_customer') {
      return res.status(400).json({
        success: false,
        message: 'Quotation is not in a state that can be rejected'
      });
    }

    if (!reason || reason.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Reason for rejection is required'
      });
    }

    // Update quotation with rejection
    quotation.status = 'rejected';
    quotation.updatedAt = new Date();

    // Update request status
    request.status = 'in_progress'; // Go back to processing
    request.updatedAt = new Date();

    // Add note
    request.notes.push({
      text: `Customer rejected quotation ${quotation.quotationNumber}. Reason: ${reason}`,
      addedBy: customerId,
      addedByModel: 'Customer',
      createdAt: new Date()
    });

    await request.save();

    res.status(200).json({
      success: true,
      message: 'Quotation rejected successfully',
      quotation,
      request
    });

  } catch (error) {
    console.error('Reject quotation error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// SUBMIT payment for a payment step
router.post('/requests/:requestId/quotation/payment', verifyCustomerToken, async (req, res) => {
  try {
    const { requestId } = req.params;
    const { 
      paymentStepNumber,
      paymentMethod,
      amount,
      transactionId,
      utrNumber,
      receiptImageUrl,
      additionalNotes 
    } = req.body;
    
    const customerId = req.customerId;

    const request = await Request.findOne({ 
      _id: requestId, 
      customerId 
    });

    if (!request) {
      return res.status(404).json({
        success: false,
        message: 'Request not found'
      });
    }

    // Get the quotation (only one per request now)
    const quotation = request.quotations[0];
    if (!quotation) {
      return res.status(404).json({
        success: false,
        message: 'No quotation found'
      });
    }

    // A customer can only pay against a quotation they have accepted. Sales
    // recording a payment on their behalf goes through the separate sales-side
    // record-payment route and is deliberately not gated this way.
    if (!['customer_approved', 'sales_approved'].includes(quotation.status)) {
      return res.status(400).json({
        success: false,
        message: quotation.status === 'sent_to_customer'
          ? 'Please approve the quotation before making a payment.'
          : `Payments cannot be made against a quotation in '${quotation.status}' state.`
      });
    }

    // Find the payment step
    const paymentStepIndex = quotation.paymentSchedule.findIndex(
      step => step.stepNumber === paymentStepNumber
    );

    if (paymentStepIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'Payment step not found'
      });
    }

    const paymentStep = quotation.paymentSchedule[paymentStepIndex];

    // Validate payment amount
    const paymentAmount = parseFloat(amount);
    if (isNaN(paymentAmount) || paymentAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment amount'
      });
    }

    // Check if payment exceeds remaining amount. Receipts already submitted and
    // still awaiting sales approval count against the remainder too, otherwise
    // a customer can submit the same step several times over while nothing has
    // been verified yet.
    const pendingForStep = (quotation.paymentSubmissions || [])
      .filter(s => s.paymentStepNumber === paymentStepNumber && s.status === 'pending')
      .reduce((sum, s) => sum + (s.submittedAmount || 0), 0);
    const remainingAmount = paymentStep.amount - (paymentStep.paidAmount || 0) - pendingForStep;
    if (paymentAmount > remainingAmount) {
      return res.status(400).json({
        success: false,
        message: pendingForStep > 0
          ? `You already have ₹${pendingForStep} awaiting approval for this step. Only ₹${Math.max(0, remainingAmount)} can be submitted now.`
          : `Payment amount exceeds remaining amount of ₹${Math.max(0, remainingAmount)}`
      });
    }

    // Create payment submission
    const paymentSubmission = {
      paymentStepNumber,
      submittedAmount: paymentAmount,
      paymentMethod,
      transactionId: transactionId?.trim(),
      utrNumber: utrNumber?.trim(),
      receiptImage: receiptImageUrl,
      additionalNotes: additionalNotes?.trim(),
      submittedBy: customerId,
      status: 'pending'
    };

    // Add to payment submissions array
    quotation.paymentSubmissions.push(paymentSubmission);

    // NOTE: paymentStep.paidAmount/status and request.totalPaidAmount/totalDueAmount
    // are DELIBERATELY not touched here. This is a customer-submitted receipt —
    // it only becomes real money once a sales person verifies it via
    // PUT /api/cms/sales/payment-submissions/:submissionId/status. Bumping the
    // "paid" numbers immediately on submission (the old behaviour) made the
    // sales dashboard show a payment as done before anyone on sales had
    // actually checked it.
    //
    // Payment method/transaction id ARE still worth recording on the step as
    // metadata even before verification, so sales sees what to check against.
    if (!paymentStep.paymentMethod) {
      quotation.paymentSchedule[paymentStepIndex].paymentMethod = paymentMethod;
    }
    if (transactionId && !paymentStep.transactionId) {
      quotation.paymentSchedule[paymentStepIndex].transactionId = transactionId;
    }

    request.updatedAt = new Date();

    // Put it on the sales team's action list so the receipt is visibly waiting
    // for approval on the CMS side instead of sitting silently in an array.
    request.quotationNotifications = request.quotationNotifications || [];
    request.quotationNotifications.push({
      type: 'payment_received',
      message: `Customer submitted a payment of ₹${paymentAmount} for ${paymentStep.name} (Step ${paymentStepNumber}). Awaiting sales approval.`,
      actionRequired: true,
      createdAt: new Date(),
    });

    // Add note
    request.notes.push({
      text: `Payment of ₹${paymentAmount} submitted for ${paymentStep.name} (Step ${paymentStepNumber}). Status: Pending verification.`,
      addedBy: customerId,
      addedByModel: 'Customer'
    });

    await request.save();

    // Return the saved subdocument (it now has an _id) plus the fresh
    // submissions list, so the portal can render the pending row immediately.
    const savedQuotation = request.quotations[0];
    const savedSubmission =
      savedQuotation.paymentSubmissions[savedQuotation.paymentSubmissions.length - 1];

    res.status(200).json({
      success: true,
      message: 'Payment submitted successfully. It is now awaiting sales approval.',
      submission: savedSubmission,
      submissions: savedQuotation.paymentSubmissions,
      request
    });

  } catch (error) {
    console.error('Submit payment error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// GET payment history for a request
router.get('/requests/:requestId/payments', verifyCustomerToken, async (req, res) => {
  try {
    const { requestId } = req.params;
    const customerId = req.customerId;

    const request = await Request.findOne({ 
      _id: requestId, 
      customerId 
    });

    if (!request) {
      return res.status(404).json({
        success: false,
        message: 'Request not found'
      });
    }

    // Extract all payment receipts from all quotations
    let allReceipts = [];
    let paymentSummary = {
      totalAmount: 0,
      totalPaid: 0,
      totalDue: 0,
      paymentSteps: []
    };

    let submissions = [];

    if (request.quotations && request.quotations.length > 0) {
      const latestQuotation = request.quotations[request.quotations.length - 1];
      submissions = latestQuotation.paymentSubmissions || [];

      const pendingFor = (stepNumber) => submissions
        .filter(s => s.paymentStepNumber === stepNumber && s.status === 'pending')
        .reduce((sum, s) => sum + (s.submittedAmount || 0), 0);

      paymentSummary.totalAmount = latestQuotation.grandTotal;
      paymentSummary.totalPaid = request.totalPaidAmount || 0;
      paymentSummary.totalDue = paymentSummary.totalAmount - paymentSummary.totalPaid;
      // Submitted but not yet approved by sales — shown separately so the
      // customer can see their money is registered without it being counted
      // as paid before anyone has checked it.
      paymentSummary.totalPendingApproval = submissions
        .filter(s => s.status === 'pending')
        .reduce((sum, s) => sum + (s.submittedAmount || 0), 0);

      // Process payment steps
      paymentSummary.paymentSteps = latestQuotation.paymentSchedule.map(step => ({
        stepNumber: step.stepNumber,
        name: step.name,
        percentage: step.percentage,
        amount: step.amount,
        dueDate: step.dueDate,
        status: step.status,
        paidAmount: step.paidAmount || 0,
        pendingApprovalAmount: pendingFor(step.stepNumber),
        remainingAmount: step.amount - (step.paidAmount || 0),
        paymentReceipts: step.paymentReceipts || [],
        submissions: submissions.filter(s => s.paymentStepNumber === step.stepNumber),
      }));

      // Collect all receipts
      latestQuotation.paymentSchedule.forEach(step => {
        if (step.paymentReceipts && step.paymentReceipts.length > 0) {
          allReceipts = allReceipts.concat(
            step.paymentReceipts.map(receipt => ({
              ...receipt._doc,
              paymentStepName: step.name,
              paymentStepNumber: step.stepNumber
            }))
          );
        }
      });
    }

    // Sort receipts by date (newest first)
    allReceipts.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));

    res.status(200).json({
      success: true,
      paymentSummary,
      submissions,
      receipts: allReceipts,
      totalReceipts: allReceipts.length
    });

  } catch (error) {
    console.error('Get payments error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// DOWNLOAD quotation PDF
router.get('/requests/:requestId/quotation/download', verifyCustomerToken, async (req, res) => {
  try {
    const { requestId } = req.params;
    const customerId = req.customerId;

    const request = await Request.findOne({ 
      _id: requestId, 
      customerId 
    });

    if (!request) {
      return res.status(404).json({
        success: false,
        message: 'Request not found'
      });
    }

    // Check if there are any quotations
    if (!request.quotations || request.quotations.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No quotation found for this request'
      });
    }

    // Get the latest quotation
    const latestQuotation = request.quotations[request.quotations.length - 1];

    // For now, return JSON data
    // In production, you would generate and stream PDF here
    res.status(200).json({
      success: true,
      quotation: latestQuotation,
      request: {
        requestId: request.requestId,
        customerInfo: request.customerInfo
      },
      downloadUrl: `#` // Placeholder for actual PDF URL
    });

  } catch (error) {
    console.error('Download quotation error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});


// Add these routes to your existing QuotationRoutes.js

// GET payment submissions for a quotation
router.get('/requests/:requestId/quotation/payment-submissions', verifyCustomerToken, async (req, res) => {
  try {
    const { requestId } = req.params;
    const customerId = req.customerId;

    const request = await Request.findOne({ 
      _id: requestId, 
      customerId 
    });

    if (!request) {
      return res.status(404).json({
        success: false,
        message: 'Request not found'
      });
    }

    // Check if there are any quotations
    if (!request.quotations || request.quotations.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No quotation found for this request'
      });
    }

    // Get the latest quotation
    const latestQuotation = request.quotations[0];

    // Return payment submissions
    const submissions = latestQuotation.paymentSubmissions || [];

    res.status(200).json({
      success: true,
      submissions
    });

  } catch (error) {
    console.error('Get payment submissions error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// UPDATE: Submit payment for a payment step (use new paymentSubmissions array)


module.exports = router;