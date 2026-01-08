// models/Customer_models/CustomerRequest.js

const mongoose = require('mongoose');

// ========== REQUEST ITEM SCHEMAS ==========
const requestItemVariantSchema = new mongoose.Schema({
  variantId: {  // ADD THIS FIELD
    type: String,
    default: () => `VAR-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  },
  attributes: [{
    name: {
      type: String,

    },
    value: {
      type: String,

    }
  }],
  quantity: {
    type: Number,

    min: 1
  },
  specialInstructions: [{
    type: String,
    trim: true
  }],
  estimatedPrice: {
    type: Number,
    min: 0
  }
}, { _id: false });

const requestItemSchema = new mongoose.Schema({
  stockItemId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'StockItem',

  },
  stockItemName: {
    type: String,

  },
  stockItemReference: {
    type: String,

  },
  variants: [requestItemVariantSchema],
  totalQuantity: {
    type: Number,
    min: 1
  },
  totalEstimatedPrice: {
    type: Number,
    min: 0
  }
}, { _id: false });

// ========== PAYMENT RECEIPT SCHEMA ==========
const paymentReceiptSchema = new mongoose.Schema({
  receiptId: {
    type: String,

  },
  amount: {
    type: Number,

    min: 0
  },
  paymentMethod: {
    type: String,
    enum: ['bank_transfer', 'upi', 'cheque', 'cash', 'credit_card', 'debit_card'],

  },
  transactionId: {
    type: String,
    trim: true
  },
  utrNumber: {
    type: String,
    trim: true
  },
  receiptImage: {
    type: String // Cloudinary URL
  },
  additionalNotes: {
    type: String,
    trim: true
  },
  receivedAt: {
    type: Date,
    default: Date.now
  },
  verifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SalesDepartment'
  },
  verifiedAt: {
    type: Date
  },
  verificationStatus: {
    type: String,
    enum: ['pending', 'verified', 'rejected'],
    default: 'pending'
  },
  verificationNotes: {
    type: String,
    trim: true
  }
}, { _id: true, timestamps: true });

// ========== PAYMENT SCHEDULE SCHEMA ==========
const paymentScheduleSchema = new mongoose.Schema({
  stepNumber: {
    type: Number,

    min: 1
  },
  name: {
    type: String,

    trim: true
  },
  percentage: {
    type: Number,

    min: 0,
    max: 100
  },
  amount: {
    type: Number,

    min: 0
  },
  dueDate: {
    type: Date,

  },
  status: {
    type: String,
    enum: ['pending', 'paid', 'overdue', 'partially_paid'],
    default: 'pending'
  },
  paidAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  remainingAmount: {
    type: Number,
    min: 0
  },
  paidDate: {
    type: Date
  },
  paymentMethod: {
    type: String,
    trim: true
  },
  paymentReceipts: [paymentReceiptSchema], // Multiple receipts can be attached to one payment step
  transactionId: {
    type: String,
    trim: true
  }
}, { _id: true });

// ========== QUOTATION ITEM SCHEMA ==========
const quotationItemSchema = new mongoose.Schema({
  stockItemId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'StockItem',

  },
  itemName: {
    type: String,

  },
  itemCode: {
    type: String,

  },
  hsnCode: {
    type: String
  },
  description: {
    type: String
  },
  quantity: {
    type: Number,

    min: 1
  },
  unitPrice: {
    type: Number,

    min: 0
  },
  discountPercentage: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  discountAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  gstPercentage: {
    type: Number,
    default: 18,
    min: 0,
    max: 100
  },
  priceBeforeGST: {
    type: Number,
    min: 0
  },
  gstAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  priceIncludingGST: {
    type: Number,

    min: 0
  },
  attributes: [{
    name: String,
    value: String
  }],
  stockInfo: {
    quantityOnHand: Number,
    status: String
  }
}, { _id: true });

// ========== PAYMENT SUBMISSION SCHEMA ==========
const paymentSubmissionSchema = new mongoose.Schema({
  paymentStepNumber: {
    type: Number,

  },
  submissionDate: {
    type: Date,
    default: Date.now
  },
  submittedAmount: {
    type: Number,

    min: 0
  },
  paymentMethod: {
    type: String,

    enum: ['bank_transfer', 'upi', 'cheque', 'cash', 'credit_card', 'debit_card']
  },
  transactionId: {
    type: String,
    trim: true
  },
  utrNumber: {
    type: String,
    trim: true
  },
  receiptImage: {
    type: String // Cloudinary URL
  },
  additionalNotes: {
    type: String,
    trim: true
  },
  submittedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',

  },
  status: {
    type: String,
    enum: ['pending', 'verified', 'rejected'],
    default: 'pending'
  },
  verifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SalesDepartment'
  },
  verifiedAt: {
    type: Date
  },
  verificationNotes: {
    type: String,
    trim: true
  }
}, { _id: true, timestamps: true });

// ========== QUOTATION SCHEMA ==========
const quotationSchema = new mongoose.Schema({
  quotationNumber: {
    type: String,

    sparse: true
  },
  date: {
    type: Date,
    default: Date.now
  },
  validUntil: {
    type: Date,

  },
  items: [quotationItemSchema],
  subtotalBeforeGST: {
    type: Number,

    min: 0
  },
  totalDiscount: {
    type: Number,
    default: 0,
    min: 0
  },
  totalGST: {
    type: Number,

    min: 0
  },
  // REMOVED: adjustment field
  // ADDED: customAdditionalCharges
  customAdditionalCharges: [{
    name: {
      type: String,

      trim: true
    },
    amount: {
      type: Number,

      min: 0
    },
    description: {
      type: String,
      trim: true
    }
  }],
  shippingCharges: {
    type: Number,
    default: 0,
    min: 0
  },
  grandTotal: {
    type: Number,

    min: 0
  },
  paymentSchedule: [paymentScheduleSchema],
  // ADDED: Payment submission tracking
  paymentSubmissions: [paymentSubmissionSchema],
  notes: {
    type: String,
    trim: true
  },
  termsAndConditions: {
    type: String,
    trim: true
  },
  preparedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SalesDepartment',

  },
  status: {
    type: String,
    enum: ['draft', 'sent_to_customer', 'customer_approved', 'sales_approved', 'rejected', 'expired'],
    default: 'draft'
  },
  customerApproval: {
    approved: {
      type: Boolean,
      default: false
    },
    approvedAt: Date,
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer'
    },
    notes: String
  },
  salesApproval: {
    approved: {
      type: Boolean,
      default: false
    },
    approvedAt: Date,
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SalesDepartment'
    },
    notes: String
  },
  sentToCustomerAt: Date,
  sentBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SalesDepartment'
  }
}, { timestamps: true });

// ========== EDIT REQUEST SCHEMA ==========
const editRequestSchema = new mongoose.Schema({
  requestId: {
    type: String,

  },
  requestedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SalesDepartment',

  },
  requestedAt: {
    type: Date,
    default: Date.now
  },
  customerInfo: {
    name: {
      type: String,

    },
    email: {
      type: String,

      lowercase: true
    },
    phone: {
      type: String,

    },
    address: {
      type: String,

    },
    city: {
      type: String,

    },
    postalCode: {
      type: String,

    },
    description: {
      type: String,
      trim: true
    },
    deliveryDeadline: {
      type: Date
    },
    preferredContactMethod: {
      type: String,
      enum: ['phone', 'email', 'whatsapp'],
      default: 'phone'
    }
  },
  items: [requestItemSchema],
  changes: [{
    field: String,
    oldValue: mongoose.Schema.Types.Mixed,
    newValue: mongoose.Schema.Types.Mixed,
    changeType: {
      type: String,
      enum: ['modified', 'added', 'removed']
    }
  }],
  reason: {
    type: String,
    trim: true
  },
  status: {
    type: String,
    enum: ['pending_approval', 'approved', 'rejected', 'cancelled'],
    default: 'pending_approval'
  },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer'
  },
  reviewedAt: {
    type: Date
  },
  reviewNotes: {
    type: String,
    trim: true
  }
}, { timestamps: true });

// ========== QUOTATION NOTIFICATION SCHEMA ==========
const quotationNotificationSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['customer_approval', 'sales_approval_required', 'quotation_expired', 'payment_received', 'payment_verified', 'payment_rejected'],

  },
  message: {
    type: String,

  },
  relatedId: {
    type: mongoose.Schema.Types.ObjectId // Could be quotation ID or payment receipt ID
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed
  },
  read: {
    type: Boolean,
    default: false
  },
  actionRequired: {
    type: Boolean,
    default: false
  }
}, { _id: true, timestamps: true });

// ========== NOTE SCHEMA ==========
const noteSchema = new mongoose.Schema({
  text: {
    type: String,

  },
  addedBy: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: 'notes.addedByModel',

  },
  addedByModel: {
    type: String,
    enum: ['SalesDepartment', 'Customer'],

  },
  relatedTo: {
    type: String,
    enum: ['request', 'quotation', 'payment', 'edit_request']
  },
  relatedId: {
    type: mongoose.Schema.Types.ObjectId
  }
}, { _id: true, timestamps: true });

// ========== MAIN CUSTOMER REQUEST SCHEMA ==========
const customerRequestSchema = new mongoose.Schema({
  // Basic Information
  requestId: {
    type: String,
  },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',

  },

  // Customer Information
  customerInfo: {
    name: {
      type: String,

    },
    email: {
      type: String,

      lowercase: true
    },
    phone: {
      type: String,

    },
    address: {
      type: String,

    },
    city: {
      type: String,

    },
    postalCode: {
      type: String,

    },
    description: {
      type: String,
      trim: true
    },
    deliveryDeadline: {
      type: Date
    },
    preferredContactMethod: {
      type: String,
      enum: ['phone', 'email', 'whatsapp'],
      default: 'phone'
    }
  },

  // Order Items
  items: [requestItemSchema],

  // Status Tracking
  status: {
    type: String,
    enum: [
      'pending',
      'pending_edit_approval',
      'in_progress',
      'quotation_draft',
      'quotation_sent',
      'quotation_customer_approved',
      'quotation_sales_approved',
      'production',
      'shipping',
      'delivered',
      'completed',
      'cancelled',
      'on_hold'
    ],
    default: 'pending'
  },

  // Timeline
  estimatedCompletion: {
    type: Date
  },
  actualCompletion: {
    type: Date
  },

  // Quotation Management - ONLY ONE QUOTATION ALLOWED
  quotations: [quotationSchema],
  // REMOVED: currentQuotation field (not needed with single quotation)
  finalOrderPrice: {
    type: Number,
    min: 0
  },

  // Tax Summary
  taxSummary: {
    totalGST: {
      type: Number,
      default: 0
    },
    sgst: {
      type: Number,
      default: 0
    },
    cgst: {
      type: Number,
      default: 0
    },
    igst: {
      type: Number,
      default: 0
    }
  },

  // Payment Tracking
  totalPaidAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  totalDueAmount: {
    type: Number,
    min: 0
  },
  lastPaymentDate: {
    type: Date
  },

  // Quotation Validity
  quotationValidUntil: {
    type: Date
  },

  // Priority and Assignment
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium'
  },
  salesPersonAssigned: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SalesDepartment'
  },

  // Communication
  notes: [noteSchema],

  // Edit Requests
  editRequests: [editRequestSchema],
  pendingEditRequest: {
    type: mongoose.Schema.Types.ObjectId
  },

  // Notifications
  quotationNotifications: [quotationNotificationSchema],

  // Audit Fields
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',

  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: 'updatedByModel'
  },
  updatedByModel: {
    type: String,
    enum: ['Customer', 'SalesDepartment']
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Virtual for checking if quotation is expired
customerRequestSchema.virtual('isQuotationExpired').get(function () {
  if (!this.quotationValidUntil) return false;
  return new Date(this.quotationValidUntil) < new Date();
});

// Virtual for getting quotation (only one allowed)
customerRequestSchema.virtual('quotation').get(function () {
  if (!this.quotations || this.quotations.length === 0) return null;
  return this.quotations[0];
});

// Virtual for getting pending edit requests
customerRequestSchema.virtual('pendingEditRequests').get(function () {
  if (!this.editRequests) return [];
  return this.editRequests.filter(req => req.status === 'pending_approval');
});

// Virtual for getting unread notifications
customerRequestSchema.virtual('unreadNotifications').get(function () {
  if (!this.quotationNotifications) return [];
  return this.quotationNotifications.filter(notif => !notif.read);
});

// Virtual for getting total order value
customerRequestSchema.virtual('totalOrderValue').get(function () {
  if (this.finalOrderPrice) return this.finalOrderPrice;
  return this.items.reduce((total, item) => total + (item.totalEstimatedPrice || 0), 0);
});

// Virtual for payment completion percentage
customerRequestSchema.virtual('paymentCompletionPercentage').get(function () {
  if (!this.finalOrderPrice || this.finalOrderPrice === 0) return 0;
  return Math.round((this.totalPaidAmount / this.finalOrderPrice) * 100);
});

// REMOVED: Complex pre-save middleware - handle calculations in API routes
// Only keep basic timestamp updates
customerRequestSchema.pre('save', function (next) {
  this.updatedAt = Date.now();

  // Only calculate request item totals (simple calculation)
  if (this.items && this.items.length > 0) {
    this.items.forEach(item => {
      item.totalQuantity = item.variants.reduce((sum, variant) => sum + variant.quantity, 0);
      item.totalEstimatedPrice = item.variants.reduce((sum, variant) => sum + variant.estimatedPrice, 0);
    });
  }

});

// SIMPLIFIED: Post-save hook (optional)
customerRequestSchema.post('save', async function (doc, next) {
  try {
    // Only update customer stats if needed
    const Customer = mongoose.model('Customer');
    await Customer.findByIdAndUpdate(doc.customerId, {
      $set: { lastOrderDate: new Date() }
    });
  } catch (error) {
    console.error('Error updating customer stats:', error);
  }

});

// SIMPLIFIED: Instance methods (keep only essential ones)
customerRequestSchema.methods.addNote = function (text, addedBy, addedByModel, relatedTo = null, relatedId = null) {
  this.notes.push({
    text,
    addedBy,
    addedByModel,
    relatedTo,
    relatedId
  });
};

customerRequestSchema.methods.addNotification = function (type, message, relatedId = null, metadata = null, actionRequired = false) {
  this.quotationNotifications.push({
    type,
    message,
    relatedId,
    metadata,
    actionRequired,
    read: false
  });
};

// SIMPLIFIED: Query helpers (keep only essential ones)
customerRequestSchema.query.byCustomerId = function (customerId) {
  return this.where({ customerId });
};

customerRequestSchema.query.byStatus = function (status) {
  return this.where({ status });
};

customerRequestSchema.query.bySalesPerson = function (salesPersonId) {
  return this.where({ salesPersonAssigned: salesPersonId });
};

module.exports = mongoose.model('CustomerRequest', customerRequestSchema);





// Basically now it's the time to do next task

// Ok let's move to next means activating the feature for "assign-edit" page of the work-order means in that page the machine's/raw-item's will goona assigned for that wo ok.. So let's do it. and basically in that page both assign and edit will happen ok means the admin can also edit the existing planned wo ok.

// - so here as you know that 3 steps need to keep , first is for showcasing the corresponding raw-item needed and with availability in order to represent ki that corresponding raw-item is going to book for that wo ok. 

// - 2nd step is for showcasing the operations that needed for that wo(means upon considering that stock item registered operations) , so that the admin is goona assign the machine's to each and every operations ok.(basically keep the feature for assign new machine because sometimes one operations needs multiple machine ok).

// -3rd step is for just showcasing the timeline's means for that work-order, the corresponding operations time need to sum and showcase it total ok so that he can see the total time required, and also keep the feature so that he can edit that ok. (or also he can also change the individual operations time also ok).

// so keep the button for "Create Planning" so that after click on that it will goona move for planning means we can consider ki that corresponding order goona move to planning means the formalities for assigning the machine's raw-items like things need to book means basically after click on the button the corresponding raw-items quantity, machine's assigned , final timeline for that wo need to set ok.. 

// so let's do that feature ok. btw as this is now the concept of work-order so now let's create an another api route page ok. 

// so for the timing just do that assign-edit page of work order ok, after that we will activate the view-wo page ok.

// -btw don't want to create the new workorder schema ok, if you want to modify then modify the mo schema ok

// for your help, am providing you the raw-item schema once again because there is feature present in order to keep the history transaction ok means for the credit/debit of raw-item quantity ok..

