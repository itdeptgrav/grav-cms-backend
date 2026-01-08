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
    request.updatedAt = new Date();

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

    // Check if payment exceeds remaining amount
    const remainingAmount = paymentStep.amount - (paymentStep.paidAmount || 0);
    if (paymentAmount > remainingAmount) {
      return res.status(400).json({
        success: false,
        message: `Payment amount exceeds remaining amount of ₹${remainingAmount}`
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
    
    // Update payment step totals
    const currentPaid = paymentStep.paidAmount || 0;
    quotation.paymentSchedule[paymentStepIndex].paidAmount = currentPaid + paymentAmount;
    quotation.paymentSchedule[paymentStepIndex].paidDate = new Date();
    
    // Update payment method if not set
    if (!paymentStep.paymentMethod) {
      quotation.paymentSchedule[paymentStepIndex].paymentMethod = paymentMethod;
    }
    
    if (transactionId && !paymentStep.transactionId) {
      quotation.paymentSchedule[paymentStepIndex].transactionId = transactionId;
    }

    // Update payment step status
    const updatedPaidAmount = currentPaid + paymentAmount;
    if (updatedPaidAmount >= paymentStep.amount) {
      quotation.paymentSchedule[paymentStepIndex].status = 'paid';
    } else if (updatedPaidAmount > 0) {
      quotation.paymentSchedule[paymentStepIndex].status = 'partially_paid';
    }

    // Update request totals
    request.totalPaidAmount = (request.totalPaidAmount || 0) + paymentAmount;
    request.totalDueAmount = quotation.grandTotal - request.totalPaidAmount;
    request.lastPaymentDate = new Date();
    request.updatedAt = new Date();

    // Add note
    request.notes.push({
      text: `Payment of ₹${paymentAmount} submitted for ${paymentStep.name} (Step ${paymentStepNumber}). Status: Pending verification.`,
      addedBy: customerId,
      addedByModel: 'Customer'
    });

    await request.save();

    res.status(200).json({
      success: true,
      message: 'Payment submitted successfully. Receipt is pending verification.',
      submission: paymentSubmission,
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

    if (request.quotations && request.quotations.length > 0) {
      const latestQuotation = request.quotations[request.quotations.length - 1];
      
      paymentSummary.totalAmount = latestQuotation.grandTotal;
      paymentSummary.totalPaid = request.totalPaidAmount || 0;
      paymentSummary.totalDue = paymentSummary.totalAmount - paymentSummary.totalPaid;
      
      // Process payment steps
      paymentSummary.paymentSteps = latestQuotation.paymentSchedule.map(step => ({
        stepNumber: step.stepNumber,
        name: step.name,
        percentage: step.percentage,
        amount: step.amount,
        dueDate: step.dueDate,
        status: step.status,
        paidAmount: step.paidAmount || 0,
        remainingAmount: step.amount - (step.paidAmount || 0),
        paymentReceipts: step.paymentReceipts || []
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