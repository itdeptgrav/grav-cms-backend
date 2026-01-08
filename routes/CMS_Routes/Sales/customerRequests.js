// routes/CMS_Routes/Sales/salesRoutes.js

const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const CustomerRequest = require("../../../models/Customer_Models/CustomerRequest");
const Customer = require("../../../models/Customer_Models/Customer");
const StockItem = require("../../../models/CMS_Models/Inventory/Products/StockItem")

const CustomerEmailService = require('../../../services/CustomerEmailService');

// Apply auth middleware
router.use(EmployeeAuthMiddleware);

// ========================
// DASHBOARD ROUTES
// ========================

// GET dashboard statistics
router.get("/dashboard", async (req, res) => {
    try {
        // Get current date for calculations
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

        // Get total requests
        const totalRequests = await CustomerRequest.countDocuments();

        // Get requests by status
        const pendingRequests = await CustomerRequest.countDocuments({ status: 'pending' });
        const inProgressRequests = await CustomerRequest.countDocuments({ status: 'in_progress' });
        const completedRequests = await CustomerRequest.countDocuments({ status: 'completed' });

        // Get total customers
        const totalCustomers = await Customer.countDocuments();

        // Calculate revenue for this month
        const requestsThisMonth = await CustomerRequest.find({
            status: 'completed',
            updatedAt: { $gte: startOfMonth }
        });

        const revenueThisMonth = requestsThisMonth.reduce((sum, request) => {
            return sum + (request.quotationAmount || request.items.reduce((itemSum, item) =>
                itemSum + (item.totalEstimatedPrice || 0), 0));
        }, 0);

        // Calculate revenue for last month
        const requestsLastMonth = await CustomerRequest.find({
            status: 'completed',
            updatedAt: { $gte: startOfLastMonth, $lte: endOfLastMonth }
        });

        const revenueLastMonth = requestsLastMonth.reduce((sum, request) => {
            return sum + (request.quotationAmount || request.items.reduce((itemSum, item) =>
                itemSum + (item.totalEstimatedPrice || 0), 0));
        }, 0);

        // Calculate revenue growth
        const revenueGrowth = revenueLastMonth > 0
            ? Math.round(((revenueThisMonth - revenueLastMonth) / revenueLastMonth) * 100)
            : revenueThisMonth > 0 ? 100 : 0;

        // Calculate average order value
        const completedRequestsCount = await CustomerRequest.countDocuments({ status: 'completed' });
        const averageOrderValue = completedRequestsCount > 0
            ? revenueThisMonth / completedRequestsCount
            : 0;

        res.json({
            success: true,
            stats: {
                totalRequests,
                pendingRequests,
                inProgressRequests,
                completedRequests,
                totalCustomers,
                revenueThisMonth,
                revenueGrowth,
                averageOrderValue
            }
        });

    } catch (error) {
        console.error("Error fetching dashboard stats:", error);
        res.status(500).json({
            success: false,
            message: "Server error while fetching dashboard statistics"
        });
    }
});

// GET recent requests for dashboard
router.get("/dashboard/recent-requests", async (req, res) => {
    try {
        const recentRequests = await CustomerRequest.find()
            .sort({ createdAt: -1 })
            .limit(10)
            .populate('salesPersonAssigned', 'name email')
            .select('-__v -updatedAt');

        res.json({
            success: true,
            requests: recentRequests
        });

    } catch (error) {
        console.error("Error fetching recent requests:", error);
        res.status(500).json({
            success: false,
            message: "Server error while fetching recent requests"
        });
    }
});

// GET top customers
router.get("/dashboard/top-customers", async (req, res) => {
    try {
        // Aggregate top customers by order value
        const topCustomers = await CustomerRequest.aggregate([
            { $match: { status: 'completed' } },
            {
                $group: {
                    _id: '$customerId',
                    totalSpent: { $sum: '$quotationAmount' },
                    orderCount: { $sum: 1 }
                }
            },
            { $sort: { totalSpent: -1 } },
            { $limit: 5 },
            {
                $lookup: {
                    from: 'customers',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'customer'
                }
            },
            { $unwind: '$customer' },
            {
                $project: {
                    _id: 1,
                    name: '$customer.name',
                    email: '$customer.email',
                    phone: '$customer.phone',
                    totalSpent: 1,
                    orderCount: 1
                }
            }
        ]);

        res.json({
            success: true,
            customers: topCustomers
        });

    } catch (error) {
        console.error("Error fetching top customers:", error);
        res.status(500).json({
            success: false,
            message: "Server error while fetching top customers"
        });
    }
});

// ========================
// CUSTOMER REQUESTS ROUTES
// ========================

// Export requests to CSV
router.get("/requests/export", async (req, res) => {
    try {
        const { startDate, endDate, status } = req.query;

        let filter = {};

        if (startDate && endDate) {
            filter.createdAt = {
                $gte: new Date(startDate),
                $lte: new Date(endDate)
            };
        }

        if (status && status !== 'all') {
            filter.status = status;
        }

        const requests = await CustomerRequest.find(filter)
            .sort({ createdAt: -1 })
            .populate('salesPersonAssigned', 'name email')
            .select('requestId customerInfo status priority items totalEstimatedPrice createdAt updatedAt');

        // Convert to CSV
        let csv = 'Request ID,Customer Name,Customer Email,Customer Phone,Status,Priority,Total Items,Total Amount,Created Date,Last Updated,Sales Person\n';

        requests.forEach(request => {
            const totalItems = request.items.reduce((sum, item) => sum + (item.totalQuantity || 0), 0);
            const totalAmount = request.items.reduce((sum, item) => sum + (item.totalEstimatedPrice || 0), 0);

            csv += `"${request.requestId}",`;
            csv += `"${request.customerInfo.name}",`;
            csv += `"${request.customerInfo.email}",`;
            csv += `"${request.customerInfo.phone}",`;
            csv += `"${request.status}",`;
            csv += `"${request.priority}",`;
            csv += `"${totalItems}",`;
            csv += `"${totalAmount}",`;
            csv += `"${request.createdAt.toISOString()}",`;
            csv += `"${request.updatedAt.toISOString()}",`;
            csv += `"${request.salesPersonAssigned?.name || 'Not Assigned'}"\n`;
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=customer-requests-${new Date().toISOString().split('T')[0]}.csv`);
        res.send(csv);

    } catch (error) {
        console.error("Error exporting requests:", error);
        res.status(500).json({
            success: false,
            message: "Server error while exporting requests"
        });
    }
});

// GET all customer requests with filters (main listing)
router.get("/requests", async (req, res) => {
    try {
        const {
            search = "",
            status,
            dateRange,
            priority,
            page = 1,
            limit = 20
        } = req.query;

        let filter = {};

        // Search filter
        if (search) {
            filter.$or = [
                { requestId: { $regex: search, $options: "i" } },
                { 'customerInfo.name': { $regex: search, $options: "i" } },
                { 'customerInfo.email': { $regex: search, $options: "i" } },
                { 'customerInfo.phone': { $regex: search, $options: "i" } }
            ];
        }

        // Status filter
        if (status && status !== 'all') {
            filter.status = status;
        }

        // Priority filter
        if (priority && priority !== 'all') {
            filter.priority = priority;
        }

        // Date range filter
        if (dateRange && dateRange !== 'all') {
            const now = new Date();
            let startDate = new Date();

            switch (dateRange) {
                case 'today':
                    startDate.setHours(0, 0, 0, 0);
                    break;
                case 'yesterday':
                    startDate.setDate(startDate.getDate() - 1);
                    startDate.setHours(0, 0, 0, 0);
                    const endDate = new Date(startDate);
                    endDate.setDate(endDate.getDate() + 1);
                    filter.createdAt = { $gte: startDate, $lt: endDate };
                    break;
                case 'week':
                    startDate.setDate(startDate.getDate() - 7);
                    break;
                case 'month':
                    startDate.setMonth(startDate.getMonth() - 1);
                    break;
                case 'last_month':
                    startDate.setMonth(startDate.getMonth() - 2);
                    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth() - 1, 0);
                    filter.createdAt = {
                        $gte: new Date(startDate.getFullYear(), startDate.getMonth(), 1),
                        $lte: lastMonthEnd
                    };
                    break;
            }

            if (dateRange !== 'yesterday' && dateRange !== 'last_month') {
                filter.createdAt = { $gte: startDate };
            }
        }

        // Pagination
        const skip = (page - 1) * limit;

        // Get requests with pagination
        const requests = await CustomerRequest.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .populate('salesPersonAssigned', 'name email')
            .select('-__v');

        // Get total count
        const total = await CustomerRequest.countDocuments(filter);

        // Get statistics
        const stats = {
            total: await CustomerRequest.countDocuments(),
            pending: await CustomerRequest.countDocuments({ status: 'pending' }),
            inProgress: await CustomerRequest.countDocuments({ status: 'in_progress' }),
            completed: await CustomerRequest.countDocuments({ status: 'completed' }),
            cancelled: await CustomerRequest.countDocuments({ status: 'cancelled' })
        };

        res.json({
            success: true,
            requests,
            stats,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        console.error("Error fetching customer requests:", error);
        res.status(500).json({
            success: false,
            message: "Server error while fetching customer requests"
        });
    }
});

// GET single customer request by ID
router.get("/requests/:requestId", async (req, res) => {
    try {
        const { requestId } = req.params;

        const request = await CustomerRequest.findById(requestId)
            .populate('salesPersonAssigned', 'name email phone')
            .populate('items.stockItemId', 'name reference category images')
            .select('-__v');

        if (!request) {
            return res.status(404).json({
                success: false,
                message: "Request not found"
            });
        }

        res.json({
            success: true,
            request
        });

    } catch (error) {
        console.error("Error fetching customer request:", error);
        res.status(500).json({
            success: false,
            message: "Server error while fetching customer request"
        });
    }
});

// UPDATE request status
router.patch("/requests/:requestId/status", async (req, res) => {
    try {
        const { requestId } = req.params;
        const { status, notes } = req.body;

        const request = await CustomerRequest.findById(requestId);

        if (!request) {
            return res.status(404).json({
                success: false,
                message: "Request not found"
            });
        }

        // Update status
        request.status = status;

        // Add note if provided
        if (notes) {
            request.notes.push({
                text: notes,
                addedBy: req.user.id,
                addedByModel: 'SalesDepartment',
                createdAt: new Date()
            });
        }

        // Update sales person if not assigned
        if (!request.salesPersonAssigned) {
            request.salesPersonAssigned = req.user.id;
        }

        request.updatedAt = new Date();
        await request.save();

        res.json({
            success: true,
            message: `Request status updated to ${status}`,
            request
        });

    } catch (error) {
        console.error("Error updating request status:", error);
        res.status(500).json({
            success: false,
            message: "Server error while updating request status"
        });
    }
});

// ASSIGN request to sales person
router.patch("/requests/:requestId/assign", async (req, res) => {
    try {
        const { requestId } = req.params;
        const { salesPersonId } = req.body;

        const request = await CustomerRequest.findById(requestId);

        if (!request) {
            return res.status(404).json({
                success: false,
                message: "Request not found"
            });
        }

        request.salesPersonAssigned = salesPersonId || req.user.id;
        request.updatedAt = new Date();
        await request.save();

        res.json({
            success: true,
            message: "Request assigned successfully",
            request
        });

    } catch (error) {
        console.error("Error assigning request:", error);
        res.status(500).json({
            success: false,
            message: "Server error while assigning request"
        });
    }
});

// UPDATE request priority
router.patch("/requests/:requestId/priority", async (req, res) => {
    try {
        const { requestId } = req.params;
        const { priority } = req.body;

        const request = await CustomerRequest.findById(requestId);

        if (!request) {
            return res.status(404).json({
                success: false,
                message: "Request not found"
            });
        }

        request.priority = priority;
        request.updatedAt = new Date();
        await request.save();

        res.json({
            success: true,
            message: `Priority updated to ${priority}`,
            request
        });

    } catch (error) {
        console.error("Error updating request priority:", error);
        res.status(500).json({
            success: false,
            message: "Server error while updating request priority"
        });
    }
});

// ADD note to request
router.post("/requests/:requestId/notes", async (req, res) => {
    try {
        const { requestId } = req.params;
        const { text } = req.body;

        if (!text || !text.trim()) {
            return res.status(400).json({
                success: false,
                message: "Note text is required"
            });
        }

        const request = await CustomerRequest.findById(requestId);

        if (!request) {
            return res.status(404).json({
                success: false,
                message: "Request not found"
            });
        }

        request.notes.push({
            text: text.trim(),
            addedBy: req.user.id,
            addedByModel: 'SalesDepartment',
            createdAt: new Date()
        });

        request.updatedAt = new Date();
        await request.save();

        res.json({
            success: true,
            message: "Note added successfully",
            note: request.notes[request.notes.length - 1]
        });

    } catch (error) {
        console.error("Error adding note:", error);
        res.status(500).json({
            success: false,
            message: "Server error while adding note"
        });
    }
});

// GET request notes
router.get("/requests/:requestId/notes", async (req, res) => {
    try {
        const { requestId } = req.params;

        const request = await CustomerRequest.findById(requestId).select('notes');

        if (!request) {
            return res.status(404).json({
                success: false,
                message: "Request not found"
            });
        }

        res.json({
            success: true,
            notes: request.notes
        });

    } catch (error) {
        console.error("Error fetching notes:", error);
        res.status(500).json({
            success: false,
            message: "Server error while fetching notes"
        });
    }
});

// CREATE edit request
// Then update the CREATE edit request route:
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

        // Get the newly created edit request (first one in array)
        const createdEditRequest = request.editRequests[0];

        // Update main request status
        request.status = 'pending_edit_approval';
        request.pendingEditRequest = createdEditRequest._id;
        request.updatedAt = new Date();

        // Add note about edit request
        request.notes.push({
            text: `Edit request created: ${reason}`,
            addedBy: req.user.id,
            addedByModel: 'SalesDepartment',
            createdAt: new Date()
        });

        await request.save();

        // ✅ Send email notification to customer
        try {
            const emailResult = await CustomerEmailService.sendEditRequestNotificationEmail(
                {
                    requestId: request.requestId,
                    createdAt: request.createdAt
                },
                {
                    _id: createdEditRequest._id.toString(),
                    reason: reason.trim(),
                    changes: changes,
                    requestedAt: new Date()
                },
                {
                    name: request.customerInfo.name,
                    email: request.customerInfo.email
                }
            );

            if (emailResult.success) {
                console.log(`Edit request notification email sent to ${request.customerInfo.email}`);
                
                // Add a note about email sent
                request.notes.push({
                    text: `Edit request notification email sent to customer.`,
                    addedBy: req.user.id,
                    addedByModel: 'SalesDepartment',
                    createdAt: new Date()
                });
                
                await request.save();
            } else {
                console.warn(`Failed to send edit request email: ${emailResult.error}`);
                
                // Add a note about email failure
                request.notes.push({
                    text: `Failed to send edit request notification email. Customer may need to be notified manually.`,
                    addedBy: req.user.id,
                    addedByModel: 'SalesDepartment',
                    createdAt: new Date()
                });
                
                await request.save();
            }
        } catch (emailError) {
            console.error('Error in email sending process:', emailError);
            // Don't fail the entire request if email fails
        }

        res.json({
            success: true,
            message: "Edit request sent to customer for approval",
            editRequest: editRequest,
            request: request,
            emailSent: true
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

        console.log(`Approving edit request for: ${requestId}, action: ${action}`);

        const request = await CustomerRequest.findById(requestId);

        if (!request) {
            return res.status(404).json({
                success: false,
                message: "Request not found"
            });
        }

        // Check if request is in pending_edit_approval status
        if (request.status !== 'pending_edit_approval') {
            return res.status(400).json({
                success: false,
                message: `Request is not in pending edit approval status. Current status: ${request.status}`
            });
        }

        // Find the edit request that's approved by customer and needs sales approval
        // We need to find edit requests that are: 
        // 1. status = 'approved' (by customer)
        // 2. OR if there's a pendingEditRequest reference

        let editRequestToApprove;
        let editRequestIndex = -1;

        // First, check if there's a pendingEditRequest reference
        if (request.pendingEditRequest) {
            editRequestIndex = request.editRequests.findIndex(edit =>
                edit._id.toString() === request.pendingEditRequest.toString()
            );

            if (editRequestIndex !== -1) {
                editRequestToApprove = request.editRequests[editRequestIndex];
            }
        }

        // If not found by pendingEditRequest, look for approved edit requests
        if (!editRequestToApprove) {
            editRequestIndex = request.editRequests.findIndex(edit =>
                edit.status === 'approved' &&
                (!edit.reviewedBy || edit.reviewedBy === null) // Not yet reviewed by sales
            );

            if (editRequestIndex !== -1) {
                editRequestToApprove = request.editRequests[editRequestIndex];
            }
        }

        // If still not found, check for any approved edit request
        if (!editRequestToApprove) {
            editRequestIndex = request.editRequests.findIndex(edit =>
                edit.status === 'approved'
            );

            if (editRequestIndex !== -1) {
                editRequestToApprove = request.editRequests[editRequestIndex];
            }
        }

        if (!editRequestToApprove) {
            return res.status(404).json({
                success: false,
                message: "No approved edit request found for this order"
            });
        }

        console.log(`Found edit request to approve: ${editRequestToApprove._id}, status: ${editRequestToApprove.status}`);

        // Update edit request with sales approval
        request.editRequests[editRequestIndex].reviewedBy = req.user?.id || null;
        request.editRequests[editRequestIndex].reviewedAt = new Date();
        request.editRequests[editRequestIndex].reviewNotes = 'Approved by sales team';

        // Note: Don't change status from 'approved' (customer already approved)
        // We're just marking it as reviewed by sales

        // Apply changes to main request
        if (action === 'approve_and_proceed') {
            // Update customer info with edited values
            if (editRequestToApprove.customerInfo) {
                request.customerInfo = editRequestToApprove.customerInfo;
            }

            // Update items if they exist in edit request
            if (editRequestToApprove.items && editRequestToApprove.items.length > 0) {
                request.items = editRequestToApprove.items;
            }

            // Update request status based on action
            request.status = 'in_progress';
            request.pendingEditRequest = null; // Clear the pending reference

            // Add note about approval
            const note = {
                text: `Sales approved edit request and applied changes. Request moved to In Progress.`,
                addedBy: req.user?.id || null,
                addedByModel: 'SalesDepartment',
                createdAt: new Date()
            };

            request.notes = request.notes || [];
            request.notes.push(note);
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
            message: "Server error while approving edit request",
            error: error.message
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









// Add these routes to your salesRoutes.js file

// Add these routes to your salesRoutes.js file

// Helper function to extract GST percentage
const extractGSTPercentage = (salesTaxString) => {
  if (!salesTaxString) return 18;
  const match = salesTaxString.match(/(\d+(\.\d+)?)%/);
  return match && match[1] ? parseFloat(match[1]) : 18;
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

    // Generate quotation number
    const quotationCount = request.quotations.length;
    const quotationNumber = `QT-${request.requestId}-${quotationCount + 1}`;

    // Prepare items with GST from stock items
    const itemsWithGST = await Promise.all(quotationData.items.map(async (item) => {
      if (item.stockItemId) {
        const stockItem = StockItem.findById(item.stockItemId);
        if (stockItem) {
          // Extract GST from salesTax field
          const gstPercentage = extractGSTPercentage(stockItem.salesTax);
          return {
            ...item,
            hsnCode: stockItem.hsnCode || '',
            gstPercentage: item.gstPercentage || gstPercentage,
            stockInfo: {
              quantityOnHand: stockItem.quantityOnHand,
              status: stockItem.status
            }
          };
        }
      }
      return item;
    }));

    // Create quotation
    const quotation = {
      ...quotationData,
      items: itemsWithGST,
      quotationNumber,
      preparedBy: req.user.id,
      status: quotationData.status || 'draft',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    // Add quotation to request
    request.quotations.push(quotation);
    
    // Set as current quotation
    const newQuotation = request.quotations[request.quotations.length - 1];
    request.currentQuotation = newQuotation._id;
    
    // Update request status
    if (quotationData.status === 'sent_to_customer') {
      request.status = 'quotation_sent';
      quotation.sentToCustomerAt = new Date();
      quotation.sentBy = req.user.id;
    } else {
      request.status = 'quotation_draft';
    }

    // Update tax summary
    const totalGST = itemsWithGST.reduce((sum, item) => sum + (item.gstAmount || 0), 0);
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
      message: "Quotation created successfully",
      quotation: newQuotation,
      request: request
    });

  } catch (error) {
    console.error("Error creating quotation:", error);
    res.status(500).json({
      success: false,
      message: "Server error while creating quotation"
    });
  }
});

// SEND quotation to customer
router.post("/requests/:requestId/quotation/:quotationId/send", async (req, res) => {
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
      actionRequired: false
    });

    await request.save();

    // TODO: Send email to customer with quotation

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

// CUSTOMER APPROVAL (Webhook/API endpoint for customer)
router.post("/requests/:requestId/quotation/:quotationId/customer-approve", async (req, res) => {
  try {
    const { requestId, quotationId } = req.params;
    const { notes } = req.body;

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

    if (quotation.status !== 'sent_to_customer') {
      return res.status(400).json({
        success: false,
        message: "Quotation is not in sent state"
      });
    }

    // Update quotation with customer approval
    quotation.status = 'customer_approved';
    quotation.customerApproval = {
      approved: true,
      approvedAt: new Date(),
      approvedBy: req.user?.id || null,
      notes: notes || ''
    };
    quotation.updatedAt = new Date();

    // Update request status
    request.status = 'quotation_customer_approved';
    request.finalOrderPrice = quotation.grandTotal;
    request.updatedAt = new Date();

    // Add notification for sales team
    request.quotationNotifications.push({
      type: 'sales_approval_required',
      message: 'Customer has approved the quotation. Sales approval required.',
      actionRequired: true,
      createdAt: new Date()
    });

    await request.save();

    // TODO: Send notification to sales team

    res.json({
      success: true,
      message: "Quotation approved by customer",
      request: request
    });

  } catch (error) {
    console.error("Error processing customer approval:", error);
    res.status(500).json({
      success: false,
      message: "Server error while processing approval"
    });
  }
});

// SALES APPROVAL
router.post("/requests/:requestId/quotation/:quotationId/sales-approve", async (req, res) => {
  try {
    const { requestId, quotationId } = req.params;
    const { notes } = req.body;

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

    if (quotation.status !== 'customer_approved') {
      return res.status(400).json({
        success: false,
        message: "Quotation is not approved by customer"
      });
    }

    // Update quotation with sales approval
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

    await request.save();

    // TODO: Send notification to production team

    res.json({
      success: true,
      message: "Quotation approved by sales",
      request: request
    });

  } catch (error) {
    console.error("Error processing sales approval:", error);
    res.status(500).json({
      success: false,
      message: "Server error while processing approval"
    });
  }
});

// REJECT quotation
router.post("/requests/:requestId/quotation/:quotationId/reject", async (req, res) => {
  try {
    const { requestId, quotationId } = req.params;
    const { reason } = req.body;

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




module.exports = router;