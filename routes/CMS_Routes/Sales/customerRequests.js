// routes/CMS_Routes/Sales/salesRoutes.js

const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const CustomerRequest = require("../../../models/Customer_Models/CustomerRequest");
const Customer = require("../../../models/Customer_Models/Customer");
const StockItem = require("../../../models/CMS_Models/Inventory/Products/StockItem")

const Measurement = require('../../../models/Customer_Models/Measurement');
const EmployeeMpc = require('../../../models/Customer_Models/Employee_Mpc');

const CustomerEmailService = require('../../../services/CustomerEmailService');

// Apply auth middleware
router.use(EmployeeAuthMiddleware);

// ========================
// DASHBOARD ROUTES
// ========================

// GET dashboard statistics
router.get("/dashboard", async (req, res) => {
    try {
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

        const totalRequests = await CustomerRequest.countDocuments();
        const pendingRequests = await CustomerRequest.countDocuments({ status: 'pending' });
        const inProgressRequests = await CustomerRequest.countDocuments({ status: 'in_progress' });
        const completedRequests = await CustomerRequest.countDocuments({ status: 'completed' });
        const totalCustomers = await Customer.countDocuments();

        const requestsThisMonth = await CustomerRequest.find({
            status: 'completed',
            updatedAt: { $gte: startOfMonth }
        });

        const revenueThisMonth = requestsThisMonth.reduce((sum, request) => {
            return sum + (request.quotationAmount || request.items.reduce((itemSum, item) =>
                itemSum + (item.totalEstimatedPrice || 0), 0));
        }, 0);

        const requestsLastMonth = await CustomerRequest.find({
            status: 'completed',
            updatedAt: { $gte: startOfLastMonth, $lte: endOfLastMonth }
        });

        const revenueLastMonth = requestsLastMonth.reduce((sum, request) => {
            return sum + (request.quotationAmount || request.items.reduce((itemSum, item) =>
                itemSum + (item.totalEstimatedPrice || 0), 0));
        }, 0);

        const revenueGrowth = revenueLastMonth > 0
            ? Math.round(((revenueThisMonth - revenueLastMonth) / revenueLastMonth) * 100)
            : revenueThisMonth > 0 ? 100 : 0;

        const completedRequestsCount = await CustomerRequest.countDocuments({ status: 'completed' });
        const averageOrderValue = completedRequestsCount > 0
            ? revenueThisMonth / completedRequestsCount
            : 0;

        res.json({
            success: true,
            stats: {
                totalRequests, pendingRequests, inProgressRequests, completedRequests,
                totalCustomers, revenueThisMonth, revenueGrowth, averageOrderValue
            }
        });
    } catch (error) {
        console.error("Error fetching dashboard stats:", error);
        res.status(500).json({ success: false, message: "Server error while fetching dashboard statistics" });
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
        res.json({ success: true, requests: recentRequests });
    } catch (error) {
        console.error("Error fetching recent requests:", error);
        res.status(500).json({ success: false, message: "Server error while fetching recent requests" });
    }
});

// GET top customers
router.get("/dashboard/top-customers", async (req, res) => {
    try {
        const topCustomers = await CustomerRequest.aggregate([
            { $match: { status: 'completed' } },
            { $group: { _id: '$customerId', totalSpent: { $sum: '$quotationAmount' }, orderCount: { $sum: 1 } } },
            { $sort: { totalSpent: -1 } },
            { $limit: 5 },
            { $lookup: { from: 'customers', localField: '_id', foreignField: '_id', as: 'customer' } },
            { $unwind: '$customer' },
            { $project: { _id: 1, name: '$customer.name', email: '$customer.email', phone: '$customer.phone', totalSpent: 1, orderCount: 1 } }
        ]);
        res.json({ success: true, customers: topCustomers });
    } catch (error) {
        console.error("Error fetching top customers:", error);
        res.status(500).json({ success: false, message: "Server error while fetching top customers" });
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
            filter.createdAt = { $gte: new Date(startDate), $lte: new Date(endDate) };
        }
        if (status && status !== 'all') filter.status = status;

        const requests = await CustomerRequest.find(filter)
            .sort({ createdAt: -1 })
            .populate('salesPersonAssigned', 'name email')
            .select('requestId customerInfo status priority items totalEstimatedPrice createdAt updatedAt');

        let csv = 'Request ID,Customer Name,Customer Email,Customer Phone,Status,Priority,Total Items,Total Amount,Created Date,Last Updated,Sales Person\n';
        requests.forEach(request => {
            const totalItems = request.items.reduce((sum, item) => sum + (item.totalQuantity || 0), 0);
            const totalAmount = request.items.reduce((sum, item) => sum + (item.totalEstimatedPrice || 0), 0);
            csv += `"${request.requestId}","${request.customerInfo.name}","${request.customerInfo.email}","${request.customerInfo.phone}","${request.status}","${request.priority}","${totalItems}","${totalAmount}","${request.createdAt.toISOString()}","${request.updatedAt.toISOString()}","${request.salesPersonAssigned?.name || 'Not Assigned'}"\n`;
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=customer-requests-${new Date().toISOString().split('T')[0]}.csv`);
        res.send(csv);
    } catch (error) {
        console.error("Error exporting requests:", error);
        res.status(500).json({ success: false, message: "Server error while exporting requests" });
    }
});

// GET all customer requests with filters
router.get("/requests", async (req, res) => {
    try {
        const { search = "", status, dateRange, priority, page = 1, limit = 20 } = req.query;
        let filter = {};

        if (search) {
            filter.$or = [
                { requestId: { $regex: search, $options: "i" } },
                { 'customerInfo.name': { $regex: search, $options: "i" } },
                { 'customerInfo.email': { $regex: search, $options: "i" } },
                { 'customerInfo.phone': { $regex: search, $options: "i" } }
            ];
        }
        if (status && status !== 'all') filter.status = status;
        if (priority && priority !== 'all') filter.priority = priority;

        if (dateRange && dateRange !== 'all') {
            const now = new Date();
            let startDate = new Date();
            switch (dateRange) {
                case 'today': startDate.setHours(0, 0, 0, 0); break;
                case 'yesterday':
                    startDate.setDate(startDate.getDate() - 1); startDate.setHours(0, 0, 0, 0);
                    const endDate = new Date(startDate); endDate.setDate(endDate.getDate() + 1);
                    filter.createdAt = { $gte: startDate, $lt: endDate }; break;
                case 'week': startDate.setDate(startDate.getDate() - 7); break;
                case 'month': startDate.setMonth(startDate.getMonth() - 1); break;
                case 'last_month':
                    startDate.setMonth(startDate.getMonth() - 2);
                    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth() - 1, 0);
                    filter.createdAt = { $gte: new Date(startDate.getFullYear(), startDate.getMonth(), 1), $lte: lastMonthEnd }; break;
            }
            if (dateRange !== 'yesterday' && dateRange !== 'last_month') {
                filter.createdAt = { $gte: startDate };
            }
        }

        const skip = (page - 1) * limit;
        const requests = await CustomerRequest.find(filter)
            .sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit))
            .populate('salesPersonAssigned', 'name email').select('-__v');
        const total = await CustomerRequest.countDocuments(filter);
        const stats = {
            total: await CustomerRequest.countDocuments(),
            pending: await CustomerRequest.countDocuments({ status: 'pending' }),
            inProgress: await CustomerRequest.countDocuments({ status: 'in_progress' }),
            completed: await CustomerRequest.countDocuments({ status: 'completed' }),
            cancelled: await CustomerRequest.countDocuments({ status: 'cancelled' })
        };

        res.json({ success: true, requests, stats, pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / limit) } });
    } catch (error) {
        console.error("Error fetching customer requests:", error);
        res.status(500).json({ success: false, message: "Server error while fetching customer requests" });
    }
});

// GET single customer request by ID
router.get("/requests/:requestId", async (req, res) => {
    try {
        const request = await CustomerRequest.findById(req.params.requestId)
            .populate('salesPersonAssigned', 'name email phone')
            .populate('items.stockItemId', 'name reference category images genderCategory')
            .select('-__v');

        if (!request) {
            return res.status(404).json({ success: false, message: "Request not found" });
        }

        // ── For measurement_conversion POs, enrich each item with the MPC
        //    display name so the PDF can show the alias the employee recognises.
        //    This is READ-ONLY — nothing stored in the DB changes.
        if (
            request.measurementId &&
            request.requestType === 'measurement_conversion'
        ) {
            try {
                const measurement = await Measurement.findById(request.measurementId)
                    .select('employeeMeasurements')
                    .lean();

                if (measurement) {
                    // Collect employee IDs present in the measurement
                    const employeeIds = measurement.employeeMeasurements
                        .map(e => e.employeeId)
                        .filter(Boolean);

                    // Batch-fetch MPC records (only products field needed)
                    const mpcEmployees = await EmployeeMpc.find({
                        _id: { $in: employeeIds },
                    })
                        .select('_id products')
                        .lean();

                    // Build: stockItemId (string) → first non-empty MPC productName
                    // "first found" is fine because every employee that has the same
                    // productId was assigned via the same name.
                    const mpcNameMap = new Map();
                    for (const emp of mpcEmployees) {
                        for (const prod of (emp.products || [])) {
                            const pidStr = prod.productId?.toString();
                            if (
                                pidStr &&
                                !mpcNameMap.has(pidStr) &&
                                prod.productName?.trim()
                            ) {
                                mpcNameMap.set(pidStr, prod.productName.trim());
                            }
                        }
                    }

                    // Attach mpcDisplayName to each item (plain object, not stored)
                    const enrichedRequest = request.toObject();
                    enrichedRequest.items = enrichedRequest.items.map(item => {
                        const stockId = (
                            item.stockItemId?._id || item.stockItemId
                        )?.toString();

                        // Only override when the MPC name actually differs from the
                        // canonical StockItem name to avoid unnecessary changes.
                        const mpcName = stockId ? mpcNameMap.get(stockId) : null;

                        return {
                            ...item,
                            // null when no MPC alias exists → frontend falls back to stockItemName
                            mpcDisplayName: mpcName || null,
                        };
                    });

                    return res.json({ success: true, request: enrichedRequest });
                }
            } catch (enrichError) {
                // Non-fatal: log and fall through to return without enrichment
                console.error('[salesRoutes] MPC name enrichment failed:', enrichError.message);
            }
        }

        // Default path (non-measurement requests, or enrichment failed)
        res.json({ success: true, request });
    } catch (error) {
        console.error("Error fetching customer request:", error);
        res.status(500).json({
            success: false,
            message: "Server error while fetching customer request",
        });
    }
});

// UPDATE request status
router.patch("/requests/:requestId/status", async (req, res) => {
    try {
        const { status, notes } = req.body;
        const request = await CustomerRequest.findById(req.params.requestId);
        if (!request) return res.status(404).json({ success: false, message: "Request not found" });

        request.status = status;
        if (notes) {
            request.notes.push({ text: notes, addedBy: req.user.id, addedByModel: 'SalesDepartment', createdAt: new Date() });
        }
        if (!request.salesPersonAssigned) request.salesPersonAssigned = req.user.id;
        request.updatedAt = new Date();
        await request.save();
        res.json({ success: true, message: `Request status updated to ${status}`, request });
    } catch (error) {
        console.error("Error updating request status:", error);
        res.status(500).json({ success: false, message: "Server error while updating request status" });
    }
});

// ASSIGN request to sales person
router.patch("/requests/:requestId/assign", async (req, res) => {
    try {
        const request = await CustomerRequest.findById(req.params.requestId);
        if (!request) return res.status(404).json({ success: false, message: "Request not found" });
        request.salesPersonAssigned = req.body.salesPersonId || req.user.id;
        request.updatedAt = new Date();
        await request.save();
        res.json({ success: true, message: "Request assigned successfully", request });
    } catch (error) {
        console.error("Error assigning request:", error);
        res.status(500).json({ success: false, message: "Server error while assigning request" });
    }
});

// UPDATE request priority
router.patch("/requests/:requestId/priority", async (req, res) => {
    try {
        const request = await CustomerRequest.findById(req.params.requestId);
        if (!request) return res.status(404).json({ success: false, message: "Request not found" });
        request.priority = req.body.priority;
        request.updatedAt = new Date();
        await request.save();
        res.json({ success: true, message: `Priority updated to ${req.body.priority}`, request });
    } catch (error) {
        console.error("Error updating request priority:", error);
        res.status(500).json({ success: false, message: "Server error while updating request priority" });
    }
});

// ADD note to request
router.post("/requests/:requestId/notes", async (req, res) => {
    try {
        const { text } = req.body;
        if (!text || !text.trim()) return res.status(400).json({ success: false, message: "Note text is required" });
        const request = await CustomerRequest.findById(req.params.requestId);
        if (!request) return res.status(404).json({ success: false, message: "Request not found" });
        request.notes.push({ text: text.trim(), addedBy: req.user.id, addedByModel: 'SalesDepartment', createdAt: new Date() });
        request.updatedAt = new Date();
        await request.save();
        res.json({ success: true, message: "Note added successfully", note: request.notes[request.notes.length - 1] });
    } catch (error) {
        console.error("Error adding note:", error);
        res.status(500).json({ success: false, message: "Server error while adding note" });
    }
});

// GET request notes
router.get("/requests/:requestId/notes", async (req, res) => {
    try {
        const request = await CustomerRequest.findById(req.params.requestId).select('notes');
        if (!request) return res.status(404).json({ success: false, message: "Request not found" });
        res.json({ success: true, notes: request.notes });
    } catch (error) {
        console.error("Error fetching notes:", error);
        res.status(500).json({ success: false, message: "Server error while fetching notes" });
    }
});

// ========================
// EDIT REQUEST ROUTES
// ========================

// CREATE edit request
router.post("/:requestId/edit-request", async (req, res) => {
    try {
        const { requestId } = req.params;
        const { customerInfo, reason, changes } = req.body;

        if (!reason || !reason.trim()) return res.status(400).json({ success: false, message: "Reason for edit is required" });
        if (!changes || !Array.isArray(changes) || changes.length === 0) return res.status(400).json({ success: false, message: "No changes specified" });

        const request = await CustomerRequest.findById(requestId);
        if (!request) return res.status(404).json({ success: false, message: "Request not found" });
        if (request.status === 'completed' || request.status === 'cancelled') return res.status(400).json({ success: false, message: "Cannot edit completed or cancelled requests" });

        const hasPendingEdit = request.editRequests.some(edit => edit.status === 'pending_approval');
        if (hasPendingEdit) return res.status(400).json({ success: false, message: "There is already a pending edit request for this order" });

        const editRequestCount = await CustomerRequest.countDocuments({ 'editRequests.requestId': { $exists: true } });
        const editRequestId = `EDIT-${request.requestId}-${editRequestCount + 1}`;

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

        request.editRequests.unshift(editRequest);
        const createdEditRequest = request.editRequests[0];
        request.status = 'pending_edit_approval';
        request.pendingEditRequest = createdEditRequest._id;
        request.updatedAt = new Date();
        request.notes.push({ text: `Edit request created: ${reason}`, addedBy: req.user.id, addedByModel: 'SalesDepartment', createdAt: new Date() });
        await request.save();

        try {
            const emailResult = await CustomerEmailService.sendEditRequestNotificationEmail(
                { requestId: request.requestId, createdAt: request.createdAt },
                { _id: createdEditRequest._id.toString(), reason: reason.trim(), changes: changes, requestedAt: new Date() },
                { name: request.customerInfo.name, email: request.customerInfo.email }
            );
            if (emailResult.success) {
                request.notes.push({ text: `Edit request notification email sent to customer.`, addedBy: req.user.id, addedByModel: 'SalesDepartment', createdAt: new Date() });
            } else {
                request.notes.push({ text: `Failed to send edit request notification email. Customer may need to be notified manually.`, addedBy: req.user.id, addedByModel: 'SalesDepartment', createdAt: new Date() });
            }
            await request.save();
        } catch (emailError) {
            console.error('Error in email sending process:', emailError);
        }

        res.json({ success: true, message: "Edit request sent to customer for approval", editRequest, request, emailSent: true });
    } catch (error) {
        console.error("Error creating edit request:", error);
        res.status(500).json({ success: false, message: "Server error while creating edit request" });
    }
});

// GET edit requests for a request
router.get("/:requestId/edit-requests", async (req, res) => {
    try {
        const request = await CustomerRequest.findById(req.params.requestId)
            .select('editRequests')
            .populate('editRequests.requestedBy', 'name email')
            .populate('editRequests.reviewedBy', 'name email');
        if (!request) return res.status(404).json({ success: false, message: "Request not found" });
        res.json({ success: true, editRequests: request.editRequests || [] });
    } catch (error) {
        console.error("Error fetching edit requests:", error);
        res.status(500).json({ success: false, message: "Server error while fetching edit requests" });
    }
});

// APPROVE edit request (sales side)
router.post("/:requestId/approve-edit", async (req, res) => {
    try {
        const { requestId } = req.params;
        const { action } = req.body;

        const request = await CustomerRequest.findById(requestId);
        if (!request) return res.status(404).json({ success: false, message: "Request not found" });
        if (request.status !== 'pending_edit_approval') return res.status(400).json({ success: false, message: `Request is not in pending edit approval status. Current status: ${request.status}` });

        let editRequestToApprove;
        let editRequestIndex = -1;

        if (request.pendingEditRequest) {
            editRequestIndex = request.editRequests.findIndex(edit => edit._id.toString() === request.pendingEditRequest.toString());
            if (editRequestIndex !== -1) editRequestToApprove = request.editRequests[editRequestIndex];
        }
        if (!editRequestToApprove) {
            editRequestIndex = request.editRequests.findIndex(edit => edit.status === 'approved' && (!edit.reviewedBy || edit.reviewedBy === null));
            if (editRequestIndex !== -1) editRequestToApprove = request.editRequests[editRequestIndex];
        }
        if (!editRequestToApprove) {
            editRequestIndex = request.editRequests.findIndex(edit => edit.status === 'approved');
            if (editRequestIndex !== -1) editRequestToApprove = request.editRequests[editRequestIndex];
        }
        if (!editRequestToApprove) return res.status(404).json({ success: false, message: "No approved edit request found for this order" });

        request.editRequests[editRequestIndex].reviewedBy = req.user?.id || null;
        request.editRequests[editRequestIndex].reviewedAt = new Date();
        request.editRequests[editRequestIndex].reviewNotes = 'Approved by sales team';

        if (action === 'approve_and_proceed') {
            if (editRequestToApprove.customerInfo) request.customerInfo = editRequestToApprove.customerInfo;
            if (editRequestToApprove.items && editRequestToApprove.items.length > 0) request.items = editRequestToApprove.items;
            request.status = 'in_progress';
            request.pendingEditRequest = null;
            request.notes = request.notes || [];
            request.notes.push({ text: `Sales approved edit request and applied changes. Request moved to In Progress.`, addedBy: req.user?.id || null, addedByModel: 'SalesDepartment', createdAt: new Date() });
        }

        request.updatedAt = new Date();
        await request.save();
        res.json({ success: true, message: "Edit request approved successfully", request });
    } catch (error) {
        console.error("Error approving edit request:", error);
        res.status(500).json({ success: false, message: "Server error while approving edit request", error: error.message });
    }
});

// REJECT edit request (sales side)
router.post("/:requestId/reject-edit", async (req, res) => {
    try {
        const { reason } = req.body;
        const request = await CustomerRequest.findById(req.params.requestId);
        if (!request) return res.status(404).json({ success: false, message: "Request not found" });

        const pendingEditIndex = request.editRequests.findIndex(edit => edit.status === 'pending_approval');
        if (pendingEditIndex === -1) return res.status(400).json({ success: false, message: "No pending edit request found" });
        if (request.status !== 'pending_edit_approval') return res.status(400).json({ success: false, message: "Request is not in edit approval status" });

        request.editRequests[pendingEditIndex].status = 'rejected';
        request.editRequests[pendingEditIndex].reviewedBy = req.user.id;
        request.editRequests[pendingEditIndex].reviewedAt = new Date();
        request.editRequests[pendingEditIndex].reviewNotes = reason || 'Rejected by sales team';
        request.status = 'pending';
        request.pendingEditRequest = null;
        request.notes.push({ text: `Edit request rejected. Reason: ${reason || 'No reason provided'}`, addedBy: req.user.id, addedByModel: 'SalesDepartment', createdAt: new Date() });
        request.updatedAt = new Date();
        await request.save();
        res.json({ success: true, message: "Edit request rejected successfully", request });
    } catch (error) {
        console.error("Error rejecting edit request:", error);
        res.status(500).json({ success: false, message: "Server error while rejecting edit request" });
    }
});

module.exports = router;