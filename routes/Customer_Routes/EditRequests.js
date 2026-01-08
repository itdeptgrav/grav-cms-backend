// routes/Customer_Routes/EditRequests.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const Request = require('../../models/Customer_Models/CustomerRequest');

// Helper function to find edit request by either _id or requestId
const findEditRequest = async (editRequestId) => {
    try {
        // First, try to find by _id (if it's a valid ObjectId)
        if (mongoose.Types.ObjectId.isValid(editRequestId)) {
            const requestByObjectId = await Request.findOne({
                'editRequests._id': new mongoose.Types.ObjectId(editRequestId)
            });
            
            if (requestByObjectId) {
                const editReq = requestByObjectId.editRequests.find(
                    req => req._id.toString() === editRequestId
                );
                if (editReq) {
                    return { request: requestByObjectId, editRequest: editReq };
                }
            }
        }
        
        // If not found by _id, try to find by requestId
        const requestByRequestId = await Request.findOne({
            'editRequests.requestId': editRequestId
        });
        
        if (requestByRequestId) {
            const editReq = requestByRequestId.editRequests.find(
                req => req.requestId === editRequestId
            );
            if (editReq) {
                return { request: requestByRequestId, editRequest: editReq };
            }
        }
        
        return null;
    } catch (error) {
        console.error('Error finding edit request:', error);
        return null;
    }
};

// Get edit request details for customer
router.get('/:editRequestId', async (req, res) => {
    try {
        const { editRequestId } = req.params;

        console.log('Fetching edit request:', editRequestId);

        // Use helper function to find edit request
        const result = await findEditRequest(editRequestId);
        
        if (!result) {
            return res.status(404).json({
                success: false,
                message: 'Edit request not found'
            });
        }

        const { request: customerRequest, editRequest } = result;

        // Get the sales department info if requestedBy exists
        let salesPersonInfo = null;
        if (editRequest.requestedBy) {
            const SalesDepartment = mongoose.model('SalesDepartment');
            salesPersonInfo = await SalesDepartment.findById(
                editRequest.requestedBy
            ).select('name email phone');
        }

        // Calculate total amount for original request
        const originalTotalAmount = customerRequest.items?.reduce((sum, item) => 
            sum + (item.totalEstimatedPrice || 0), 0) || 0;

        // Calculate total amount for edited request
        const editedTotalAmount = editRequest.items?.reduce((sum, item) => 
            sum + (item.totalEstimatedPrice || 0), 0) || 0;

        res.json({
            success: true,
            editRequest: {
                _id: editRequest._id,
                requestId: editRequest.requestId,
                requestedBy: editRequest.requestedBy,
                requestedAt: editRequest.requestedAt,
                salesPersonInfo: salesPersonInfo,
                customerInfo: editRequest.customerInfo,
                items: editRequest.items || [],
                changes: editRequest.changes || [],
                reason: editRequest.reason,
                status: editRequest.status,
                reviewedBy: editRequest.reviewedBy,
                reviewedAt: editRequest.reviewedAt,
                reviewNotes: editRequest.reviewNotes,
                createdAt: editRequest.createdAt || editRequest.requestedAt,
                updatedAt: editRequest.updatedAt || editRequest.requestedAt,
                totalAmount: editedTotalAmount
            },
            originalRequest: {
                _id: customerRequest._id,
                requestId: customerRequest.requestId,
                customerInfo: customerRequest.customerInfo,
                items: customerRequest.items || [],
                status: customerRequest.status,
                totalAmount: originalTotalAmount,
                createdAt: customerRequest.createdAt,
                updatedAt: customerRequest.updatedAt
            }
        });

    } catch (error) {
        console.error('Error fetching edit request:', error);
        res.status(500).json({
            success: false,
            message: 'Server error: ' + error.message
        });
    }
});

// Customer approves edit request
router.post('/:editRequestId/approve', async (req, res) => {
    try {
        const { editRequestId } = req.params;
        const { reviewNotes } = req.body;

        console.log('Approving edit request:', editRequestId);

        // Use helper function to find edit request
        const result = await findEditRequest(editRequestId);
        
        if (!result) {
            return res.status(404).json({
                success: false,
                message: 'Edit request not found'
            });
        }

        const { request: customerRequest, editRequest } = result;

        // Check if already processed
        if (editRequest.status !== 'pending_approval') {
            return res.status(400).json({
                success: false,
                message: `Edit request already ${editRequest.status}`
            });
        }

        // Update edit request with approval
        editRequest.status = 'approved';
        editRequest.reviewedAt = new Date();
        editRequest.reviewNotes = reviewNotes || 'Customer approved the changes';

        // Update customer request status to pending_edit_approval
        customerRequest.status = 'pending_edit_approval';

        // ✅ IMPORTANT: Apply the changes to customer request immediately
        // Apply customer info changes
        if (editRequest.customerInfo) {
            customerRequest.customerInfo = editRequest.customerInfo;
        }
        
        // Apply items changes
        if (editRequest.items && editRequest.items.length > 0) {
            customerRequest.items = editRequest.items;
        }

        // Add a note to the customer request
        const note = {
            text: `Customer approved edit request. Changes have been applied and are now pending sales confirmation.`,
            addedByModel: 'Customer',
            createdAt: new Date()
        };
        
        customerRequest.notes = customerRequest.notes || [];
        customerRequest.notes.push(note);

        // Mark the edit request as the pending one
        customerRequest.pendingEditRequest = editRequest._id;

        await customerRequest.save();

        res.json({
            success: true,
            message: 'Edit request approved successfully. Changes have been applied to the order.',
            editRequest: {
                _id: editRequest._id,
                requestId: editRequest.requestId,
                status: editRequest.status,
                reviewedAt: editRequest.reviewedAt,
                reviewNotes: editRequest.reviewNotes
            },
            customerRequest: {
                _id: customerRequest._id,
                requestId: customerRequest.requestId,
                status: customerRequest.status,
                customerInfo: customerRequest.customerInfo,
                items: customerRequest.items
            }
        });

    } catch (error) {
        console.error('Error approving edit request:', error);
        res.status(500).json({
            success: false,
            message: 'Server error: ' + error.message
        });
    }
});

// Customer rejects edit request
router.post('/:editRequestId/reject', async (req, res) => {
    try {
        const { editRequestId } = req.params;
        const { reviewNotes } = req.body;

        console.log('Rejecting edit request:', editRequestId);

        // Use helper function to find edit request
        const result = await findEditRequest(editRequestId);
        
        if (!result) {
            return res.status(404).json({
                success: false,
                message: 'Edit request not found'
            });
        }

        const { request: customerRequest, editRequest } = result;

        // Check if already processed
        if (editRequest.status !== 'pending_approval') {
            return res.status(400).json({
                success: false,
                message: `Edit request already ${editRequest.status}`
            });
        }

        // Update edit request with rejection
        editRequest.status = 'rejected';
        editRequest.reviewedAt = new Date();
        editRequest.reviewNotes = reviewNotes || 'Customer rejected the changes';

        // Add a note to the customer request
        const note = {
            text: `Customer rejected edit request. Original order details remain unchanged.`,
            addedByModel: 'Customer',
            createdAt: new Date()
        };
        
        customerRequest.notes = customerRequest.notes || [];
        customerRequest.notes.push(note);

        // If this was the pending edit request, clear it
        if (customerRequest.pendingEditRequest && 
            customerRequest.pendingEditRequest.toString() === editRequest._id.toString()) {
            customerRequest.pendingEditRequest = null;
        }

        await customerRequest.save();

        res.json({
            success: true,
            message: 'Edit request rejected successfully',
            editRequest: {
                _id: editRequest._id,
                requestId: editRequest.requestId,
                status: editRequest.status,
                reviewedAt: editRequest.reviewedAt,
                reviewNotes: editRequest.reviewNotes
            },
            customerRequest: {
                _id: customerRequest._id,
                requestId: customerRequest.requestId,
                status: customerRequest.status
            }
        });

    } catch (error) {
        console.error('Error rejecting edit request:', error);
        res.status(500).json({
            success: false,
            message: 'Server error: ' + error.message
        });
    }
});

module.exports = router;