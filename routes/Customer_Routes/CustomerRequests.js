// routes/Customer_Routes/CustomerRequests.js (Updated for variations)

const express = require('express');
const router = express.Router();
const Request = require('../../models/Customer_Models/CustomerRequest');
const Customer = require('../../models/Customer_Models/Customer');
const StockItem = require('../../models/CMS_Models/Inventory/Products/StockItem');
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

// Create new request with variations
router.post('/', verifyCustomerToken, async (req, res) => {
  try {
    const { customerInfo, items } = req.body;
    const customerId = req.customerId;

    // Validate items
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one item is required'
      });
    }

    // Get customer details
    const customer = await Customer.findById(customerId);
    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found'
      });
    }

    // Validate each item and its variants
    const validatedItems = [];
    for (const item of items) {
      const stockItem = await StockItem.findById(item.stockItemId);
      
      if (!stockItem) {
        return res.status(400).json({
          success: false,
          message: `Item ${item.stockItemName || item.stockItemId} not found`
        });
      }

      // Check if item is available
      if (stockItem.quantityOnHand === 0) {
        return res.status(400).json({
          success: false,
          message: `Item ${stockItem.name} is out of stock`
        });
      }

      // Validate variants
      if (!item.variants || !Array.isArray(item.variants) || item.variants.length === 0) {
        return res.status(400).json({
          success: false,
          message: `At least one variation is required for ${stockItem.name}`
        });
      }

      const validatedVariants = [];
      let totalQuantity = 0;

      for (const variant of item.variants) {
        // Validate quantity
        if (!variant.quantity || variant.quantity < 1) {
          return res.status(400).json({
            success: false,
            message: `Invalid quantity for variation of ${stockItem.name}`
          });
        }

        totalQuantity += variant.quantity;

        // Validate attributes if item has them
        if (stockItem.attributes.length > 0) {
          if (!variant.attributes || !Array.isArray(variant.attributes)) {
            return res.status(400).json({
              success: false,
              message: `Attributes are required for ${stockItem.name}`
            });
          }

          // Check all required attributes are provided
          const missingAttributes = [];
          stockItem.attributes.forEach(attr => {
            const providedAttr = variant.attributes.find(a => a.name === attr.name);
            if (!providedAttr || !providedAttr.value) {
              missingAttributes.push(attr.name);
            }
          });

          if (missingAttributes.length > 0) {
            return res.status(400).json({
              success: false,
              message: `Missing attributes for ${stockItem.name}: ${missingAttributes.join(', ')}`
            });
          }

          // Validate attribute values
          for (const attr of variant.attributes) {
            const attributeDef = stockItem.attributes.find(a => a.name === attr.name);
            if (attributeDef && attributeDef.values.length > 0) {
              if (!attributeDef.values.includes(attr.value)) {
                return res.status(400).json({
                  success: false,
                  message: `Invalid value '${attr.value}' for attribute '${attr.name}'`
                });
              }
            }
          }
        }

        // Calculate estimated price for this variant
        let variantPrice = stockItem.salesPrice * variant.quantity;
        
        // Check if there's a matching variant with different price
        if (variant.attributes && stockItem.variants.length > 0) {
          const matchingVariant = stockItem.variants.find(sv =>
            sv.attributes.every(svAttr =>
              variant.attributes.some(vAttr =>
                vAttr.name === svAttr.name && vAttr.value === svAttr.value
              )
            )
          );

          if (matchingVariant && matchingVariant.salesPrice) {
            variantPrice = matchingVariant.salesPrice * variant.quantity;
          }
        }

        validatedVariants.push({
          attributes: variant.attributes || [],
          quantity: variant.quantity,
          specialInstructions: variant.specialInstructions?.filter(inst => inst.trim()) || [],
          estimatedPrice: variantPrice
        });
      }

      const totalEstimatedPrice = validatedVariants.reduce((sum, variant) => sum + variant.estimatedPrice, 0);

      validatedItems.push({
        stockItemId: stockItem._id,
        stockItemName: stockItem.name,
        stockItemReference: stockItem.reference,
        variants: validatedVariants,
        totalQuantity,
        totalEstimatedPrice
      });
    }

    // Generate request ID
    const requestCount = await Request.countDocuments();
    const requestId = `REQ-${new Date().getFullYear()}-${String(requestCount + 1).padStart(4, '0')}`;

    // Create new request
    const newRequest = new Request({
      requestId,
      customerId,
      customerInfo: {
        name: customerInfo.name || customer.name,
        email: customerInfo.email || customer.email,
        phone: customerInfo.phone || customer.phone,
        address: customerInfo.address || customer.profile?.address?.street || '',
        city: customerInfo.city || customer.profile?.address?.city || '',
        postalCode: customerInfo.postalCode || customer.profile?.address?.pincode || '',
        description: customerInfo.description || '',
        deliveryDeadline: customerInfo.deliveryDeadline,
        preferredContactMethod: customerInfo.preferredContactMethod || 'phone'
      },
      items: validatedItems,
      status: 'pending',
      priority: customerInfo.priority || 'medium',
      createdAt: new Date()
    });

    await newRequest.save();

    // Populate request with item details
    const populatedRequest = await Request.findById(newRequest._id)
      .populate({
        path: 'items.stockItemId',
        select: 'name reference category images'
      });

    // Send request confirmation email
    try {
      CustomerEmailService.sendRequestConfirmationEmail(
        {
          requestId: populatedRequest.requestId,
          createdAt: populatedRequest.createdAt,
          items: populatedRequest.items.map(item => ({
            name: item.stockItemName,
            reference: item.stockItemReference,
            variants: item.variants,
            totalQuantity: item.totalQuantity,
            totalEstimatedPrice: item.totalEstimatedPrice
          })),
          totalEstimatedPrice: populatedRequest.items.reduce((sum, item) => sum + item.totalEstimatedPrice, 0)
        },
        {
          name: customer.name,
          email: customer.email,
          phone: customer.phone
        }
      );
    } catch (emailError) {
      console.error('Request email sending failed:', emailError);
    }

    res.status(201).json({
      success: true,
      message: 'Request created successfully. Confirmation email has been sent.',
      request: populatedRequest,
      totalEstimatedPrice: populatedRequest.items.reduce((sum, item) => sum + item.totalEstimatedPrice, 0)
    });

  } catch (error) {
    console.error('Create request error:', error);
    
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: messages.join(', ')
      });
    }

    res.status(500).json({
      success: false,
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});


// Get all requests for a customer
// In routes/Customer_Routes/CustomerRequests.js, update the GET / route:

// Get all requests for a customer
router.get('/', verifyCustomerToken, async (req, res) => {
  try {
    const customerId = req.customerId;
    
    const requests = await Request.find({ customerId })
      .sort({ createdAt: -1 })
      .select('-__v -updatedAt')
      .lean(); // Use lean() for better performance

    // Process each request to check for pending edit approvals
    const processedRequests = requests.map(request => {
      // Check for pending edit approvals
      const pendingEditApprovals = request.editRequests ? 
        request.editRequests.filter(editReq => 
          editReq.status === 'pending_approval'
        ).length : 0;
      
      // Check if there's a pending edit request that needs customer approval
      const hasPendingCustomerApproval = request.editRequests ?
        request.editRequests.some(editReq => 
          editReq.status === 'pending_approval'
        ) : false;
      
      // Get the latest edit request for quick access
      const latestEditRequest = request.editRequests && request.editRequests.length > 0 ?
        request.editRequests.sort((a, b) => 
          new Date(b.requestedAt || b.createdAt) - new Date(a.requestedAt || a.createdAt)
        )[0] : null;

      return {
        ...request,
        hasPendingEditApproval: hasPendingCustomerApproval,
        pendingEditCount: pendingEditApprovals,
        latestEditRequest: latestEditRequest ? {
          _id: latestEditRequest._id,
          status: latestEditRequest.status,
          requestedAt: latestEditRequest.requestedAt || latestEditRequest.createdAt,
          reason: latestEditRequest.reason
        } : null
      };
    });

    res.status(200).json({
      success: true,
      requests: processedRequests,
      count: requests.length,
      pendingEditCount: processedRequests.filter(req => req.hasPendingEditApproval).length
    });

  } catch (error) {
    console.error('Get requests error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get single request
router.get('/:requestId', verifyCustomerToken, async (req, res) => {
  try {
    const { requestId } = req.params;
    const customerId = req.customerId;

    const request = await Request.findOne({ 
      _id: requestId, 
      customerId 
    }).select('-__v -updatedAt');

    if (!request) {
      return res.status(404).json({
        success: false,
        message: 'Request not found'
      });
    }

    res.status(200).json({
      success: true,
      request
    });

  } catch (error) {
    console.error('Get request error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Update request
router.put('/:requestId', verifyCustomerToken, async (req, res) => {
  try {
    const { requestId } = req.params;
    const customerId = req.customerId;
    const updateData = req.body;

    // Find request
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

    // Only allow update if status is pending
    if (request.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'Cannot update request after it has been processed'
      });
    }

    // Update request data
    request.customerInfo = {
      ...request.customerInfo,
      ...updateData.customerInfo
    };
    
    request.clothCategories = updateData.clothCategories || request.clothCategories;
    request.updatedAt = new Date();

    await request.save();

    res.status(200).json({
      success: true,
      message: 'Request updated successfully',
      request
    });

  } catch (error) {
    console.error('Update request error:', error);
    
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: messages.join(', ')
      });
    }

    res.status(500).json({
      success: false,
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Cancel request
router.patch('/:requestId/cancel', verifyCustomerToken, async (req, res) => {
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

    // Only allow cancellation if not completed
    if (request.status === 'completed') {
      return res.status(400).json({
        success: false,
        message: 'Cannot cancel completed request'
      });
    }

    request.status = 'cancelled';
    request.updatedAt = new Date();
    await request.save();

    res.status(200).json({
      success: true,
      message: 'Request cancelled successfully'
    });

  } catch (error) {
    console.error('Cancel request error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});


// routes/CMS_Routes/Sales/customerRequests.js - Add these routes

// CREATE edit request
router.post("/:requestId/edit-request", async (req, res) => {
    try {
        const { requestId } = req.params;
        const { customerInfo, reason, changes } = req.body;

        if (!reason || !reason.trim()) {
            return res.status(400).json({
                success: false,
                message: "Reason for edit is required"
            });
        }

        if (!changes || !Array.isArray(changes) || changes.length === 0) {
            return res.status(400).json({
                success: false,
                message: "No changes specified"
            });
        }

        const request = await CustomerRequest.findById(requestId);
        
        if (!request) {
            return res.status(404).json({
                success: false,
                message: "Request not found"
            });
        }

        // Check if request can be edited
        if (request.status === 'completed' || request.status === 'cancelled') {
            return res.status(400).json({
                success: false,
                message: "Cannot edit completed or cancelled requests"
            });
        }

        // Check if there's already a pending edit request
        const hasPendingEdit = request.editRequests.some(edit => 
            edit.status === 'pending_approval'
        );

        if (hasPendingEdit) {
            return res.status(400).json({
                success: false,
                message: "There is already a pending edit request for this order"
            });
        }

        // Generate edit request ID
        const editRequestCount = await CustomerRequest.countDocuments({
            'editRequests.requestId': { $exists: true }
        });
        const editRequestId = `EDIT-${request.requestId}-${editRequestCount + 1}`;

        // Create edit request
        const editRequest = {
            requestId: editRequestId,
            requestedBy: req.user.id,
            requestedAt: new Date(),
            customerInfo: {
                name: customerInfo.name || request.customerInfo.name,
                email: customerInfo.email || request.customerInfo.email,
                phone: customerInfo.phone || request.customerInfo.phone,
                address: customerInfo.address || request.customerInfo.address,
                city: customerInfo.city || request.customerInfo.city,
                postalCode: customerInfo.postalCode || request.customerInfo.postalCode,
                description: customerInfo.description || request.customerInfo.description,
                deliveryDeadline: customerInfo.deliveryDeadline || request.customerInfo.deliveryDeadline,
                preferredContactMethod: customerInfo.preferredContactMethod || request.customerInfo.preferredContactMethod
            },
            changes: changes,
            reason: reason.trim(),
            status: 'pending_approval'
        };

        // Add to edit requests array
        request.editRequests.unshift(editRequest);
        
        // Update main request status
        request.status = 'pending_edit_approval';
        request.pendingEditRequest = editRequest._id;
        request.updatedAt = new Date();

        // Add note about edit request
        request.notes.push({
            text: `Edit request created: ${reason}`,
            addedBy: req.user.id,
            addedByModel: 'SalesDepartment',
            createdAt: new Date()
        });

        await request.save();

        // TODO: Send notification/email to customer about edit request

        res.json({
            success: true,
            message: "Edit request sent to customer for approval",
            editRequest: editRequest,
            request: request
        });

    } catch (error) {
        console.error("Error creating edit request:", error);
        res.status(500).json({
            success: false,
            message: "Server error while creating edit request"
        });
    }
});

// GET edit requests for a request
router.get("/:requestId/edit-requests", async (req, res) => {
    try {
        const { requestId } = req.params;

        const request = await CustomerRequest.findById(requestId)
            .select('editRequests')
            .populate('editRequests.requestedBy', 'name email')
            .populate('editRequests.reviewedBy', 'name email');

        if (!request) {
            return res.status(404).json({
                success: false,
                message: "Request not found"
            });
        }

        res.json({
            success: true,
            editRequests: request.editRequests || []
        });

    } catch (error) {
        console.error("Error fetching edit requests:", error);
        res.status(500).json({
            success: false,
            message: "Server error while fetching edit requests"
        });
    }
});

// APPROVE edit request (sales side)
router.post("/:requestId/approve-edit", async (req, res) => {
    try {
        const { requestId } = req.params;
        const { action } = req.body; // "approve_and_proceed"

        const request = await CustomerRequest.findById(requestId);
        
        if (!request) {
            return res.status(404).json({
                success: false,
                message: "Request not found"
            });
        }

        // Check if there's a pending edit request
        const pendingEditIndex = request.editRequests.findIndex(edit => 
            edit.status === 'pending_approval'
        );

        if (pendingEditIndex === -1) {
            return res.status(400).json({
                success: false,
                message: "No pending edit request found"
            });
        }

        const pendingEdit = request.editRequests[pendingEditIndex];

        // Only allow if status is pending_edit_approval
        if (request.status !== 'pending_edit_approval') {
            return res.status(400).json({
                success: false,
                message: "Request is not in edit approval status"
            });
        }

        // Update edit request status
        request.editRequests[pendingEditIndex].status = 'approved';
        request.editRequests[pendingEditIndex].reviewedBy = req.user.id;
        request.editRequests[pendingEditIndex].reviewedAt = new Date();
        request.editRequests[pendingEditIndex].reviewNotes = 'Approved by sales team';

        // Apply changes to main request
        if (action === 'approve_and_proceed') {
            // Update customer info with edited values
            request.customerInfo = pendingEdit.customerInfo;
            
            // Update request status based on action
            request.status = 'in_progress';
            request.pendingEditRequest = null;
            
            // Add note about approval
            request.notes.push({
                text: `Edit request approved and applied. Request moved to In Progress.`,
                addedBy: req.user.id,
                addedByModel: 'SalesDepartment',
                createdAt: new Date()
            });
        }

        request.updatedAt = new Date();
        await request.save();

        res.json({
            success: true,
            message: "Edit request approved successfully",
            request: request
        });

    } catch (error) {
        console.error("Error approving edit request:", error);
        res.status(500).json({
            success: false,
            message: "Server error while approving edit request"
        });
    }
});

// REJECT edit request (sales side)
router.post("/:requestId/reject-edit", async (req, res) => {
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

        // Check if there's a pending edit request
        const pendingEditIndex = request.editRequests.findIndex(edit => 
            edit.status === 'pending_approval'
        );

        if (pendingEditIndex === -1) {
            return res.status(400).json({
                success: false,
                message: "No pending edit request found"
            });
        }

        // Only allow if status is pending_edit_approval
        if (request.status !== 'pending_edit_approval') {
            return res.status(400).json({
                success: false,
                message: "Request is not in edit approval status"
            });
        }

        // Update edit request status
        request.editRequests[pendingEditIndex].status = 'rejected';
        request.editRequests[pendingEditIndex].reviewedBy = req.user.id;
        request.editRequests[pendingEditIndex].reviewedAt = new Date();
        request.editRequests[pendingEditIndex].reviewNotes = reason || 'Rejected by sales team';

        // Revert to original status (pending)
        request.status = 'pending';
        request.pendingEditRequest = null;
        
        // Add note about rejection
        request.notes.push({
            text: `Edit request rejected. Reason: ${reason || 'No reason provided'}`,
            addedBy: req.user.id,
            addedByModel: 'SalesDepartment',
            createdAt: new Date()
        });

        request.updatedAt = new Date();
        await request.save();

        res.json({
            success: true,
            message: "Edit request rejected successfully",
            request: request
        });

    } catch (error) {
        console.error("Error rejecting edit request:", error);
        res.status(500).json({
            success: false,
            message: "Server error while rejecting edit request"
        });
    }
});


module.exports = router;

