// routes/CMS_Routes/Sales/customerRequests.js

const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const CustomerRequest = require("../../../models/Customer_Models/CustomerRequest");
const Customer = require("../../../models/Customer_Models/Customer");
const StockItem = require("../../../models/CMS_Models/Inventory/Products/StockItem")
const WorkOrder = require("../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");

const Measurement = require('../../../models/Customer_Models/Measurement');
const EmployeeMpc = require('../../../models/Customer_Models/Employee_Mpc');

const CustomerEmailService = require('../../../services/CustomerEmailService');

router.use(EmployeeAuthMiddleware);

// ════════════════════════════════════════════════════════════════════════════
// DASHBOARD ROUTES
// ════════════════════════════════════════════════════════════════════════════

// GET /api/cms/crm/customer-requests/:id/persons
// GET /api/cms/crm/customer-requests/:id/persons?uin=EMP-0042
//
// WHO is on this order — the answer to "did we make, or bill, Ramesh's
// uniform?", which until now required opening the measurement drive and
// guessing by garment size.
//
// Reads the roster carried on each line (services/personRoster.js). Orders
// converted before that existed have no roster and honestly report none,
// rather than inferring one from sizes and being confidently wrong.
router.get("/:id/persons", async (req, res) => {
  try {
    const request = await CustomerRequest.findById(req.params.id)
      .select("requestId requestType measurementId measurementName items status")
      .lean();
    if (!request) return res.status(404).json({ success: false, message: "Order not found" });

    let persons = personsOnOrder(request.items);
    const uin = String(req.query.uin || "").trim();
    if (uin) {
      const needle = uin.toLowerCase();
      persons = persons.filter(
        (p) =>
          String(p.employeeUIN).toLowerCase() === needle ||
          String(p.employeeName).toLowerCase().includes(needle),
      );
    }

    return res.json({
      success: true,
      requestId: request.requestId,
      // Says WHY the list is empty. An ordinary stock order has nobody to name;
      // a pre-roster measurement order has people the record simply never kept.
      traceable: (request.items || []).some((i) =>
        (i.variants || []).some((v) => (v.persons || []).length > 0),
      ),
      isMeasurementOrder: request.requestType === "measurement_conversion",
      fromDrive: request.measurementName || null,
      count: persons.length,
      persons,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

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

// ════════════════════════════════════════════════════════════════════════════
// CUSTOMER REQUESTS ROUTES
// ════════════════════════════════════════════════════════════════════════════

router.get("/requests/export", async (req, res) => {
    try {
        const { startDate, endDate, status } = req.query;
        let filter = {};
        if (startDate && endDate) {
            filter.createdAt = { $gte: new Date(startDate), $lte: new Date(endDate) };
        }
        // Same stage-vs-status handling as the list route below, so an export
        // taken with a filter on screen contains the rows that were on screen.
        applyStatusFilter(filter, status);

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

/**
 * Apply the `status` query param to a Mongo filter.
 *
 * `customer_approved` is a STAGE, not a status value (24 Aug 2026 bug fix —
 * "the filter is not working for this customer approved"). The Order Book was
 * defaulted to `status: "quotation_customer_approved"` and came back empty,
 * because request.status walks a ONE-WAY ladder:
 *
 *   quotation_draft → quotation_sent → quotation_customer_approved
 *                                    → quotation_sales_approved → production → …
 *
 * (see REQUEST_STATUS_FOR_QUOTATION in quotationRoutes.js). The customer's
 * approval advances it to `quotation_customer_approved`, and Sales'
 * counter-approval — normally moments later — advances it again, so that
 * value only exists inside that window. Measured against the live data: of
 * 30 requests, 16 had a customer-approved quotation and NOT ONE still read
 * `quotation_customer_approved`; they had all moved on to
 * `quotation_sales_approved`.
 *
 * So the question "has the customer approved this?" is answered by the
 * QUOTATION's own status, which does not get overwritten when the request
 * moves to production — not by the request's current status. That is also
 * what the page is asking for literally: requests "whose quotation is
 * approved by the customer".
 *
 * Every other value stays an exact status match, so existing callers of this
 * endpoint are untouched.
 */
const CUSTOMER_APPROVED_QUOTATION_STATES = ["customer_approved", "sales_approved"];
function applyStatusFilter(filter, status) {
    if (!status || status === "all") return filter;
    if (status === "customer_approved") {
        filter["quotations.status"] = { $in: CUSTOMER_APPROVED_QUOTATION_STATES };
        // A cancelled order is not an approved one, whatever its quotation
        // still says.
        filter.status = { $ne: "cancelled" };
        return filter;
    }
    filter.status = status;
    return filter;
}

// GET all customer requests — NOW with WO completion enrichment + deadline risk
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
        applyStatusFilter(filter, status);
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
            .populate('salesPersonAssigned', 'name email')
            .select('-__v')
            .lean();

        // ── WO completion aggregation: one query for all returned requests ──
        const requestIds = requests.map(r => r._id);
        let woMap = new Map();
        if (requestIds.length > 0) {
            const woAgg = await WorkOrder.aggregate([
                { $match: { customerRequestId: { $in: requestIds } } },
                {
                    $group: {
                        _id: "$customerRequestId",
                        count: { $sum: 1 },
                        totalQty: { $sum: { $ifNull: ["$quantity", 0] } },
                        totalCompleted: {
                            $sum: { $ifNull: ["$productionCompletion.overallCompletedQuantity", 0] }
                        },
                        anyStarted: {
                            $sum: {
                                $cond: [
                                    { $gt: [{ $ifNull: ["$productionCompletion.overallCompletedQuantity", 0] }, 0] },
                                    1, 0
                                ]
                            }
                        }
                    }
                }
            ]);
            woMap = new Map(woAgg.map(w => [w._id.toString(), w]));
        }

        // ── Enrich each request with derived status + completion + deadline risk ──
        const enriched = requests.map(r => {
            const woStats = woMap.get(r._id.toString());
            const woCount = woStats?.count || 0;

            const totalUnitsOrdered = woCount > 0
                ? (woStats.totalQty || 0)
                : (r.items || []).reduce((s, i) => s + (i.totalQuantity || 0), 0);
            const totalUnitsCompleted = woStats?.totalCompleted || 0;
            const completionPercentage = totalUnitsOrdered > 0
                ? Math.round((totalUnitsCompleted / totalUnitsOrdered) * 100)
                : 0;

            // Derive status — override quotation_sales_approved based on WO progress
            let derivedStatus = r.status;
            if (r.status === "quotation_sales_approved" && woCount > 0) {
                if (totalUnitsOrdered > 0 && totalUnitsCompleted >= totalUnitsOrdered) {
                    derivedStatus = "production_complete";
                } else if (totalUnitsCompleted > 0) {
                    derivedStatus = "in_production";
                } else {
                    derivedStatus = "ready_for_production";
                }
            }

            // Deadline risk
            let deadlineRisk = null;
            let daysUntilDeadline = null;
            const deadline = r.customerInfo?.deliveryDeadline;
            const isAllComplete = totalUnitsOrdered > 0 && totalUnitsCompleted >= totalUnitsOrdered;
            const isTerminal = r.status === "cancelled" || r.status === "completed" || derivedStatus === "production_complete";
            if (deadline && !isAllComplete && !isTerminal) {
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const dl = new Date(deadline);
                dl.setHours(0, 0, 0, 0);
                daysUntilDeadline = Math.round((dl - today) / (1000 * 60 * 60 * 24));
                if (daysUntilDeadline < 0) deadlineRisk = "missed";
                else if (daysUntilDeadline === 0) deadlineRisk = "due_today";
                else if (daysUntilDeadline <= 3 && completionPercentage < 70) deadlineRisk = "due_soon";
                else if (daysUntilDeadline <= 7 && completionPercentage < 50) deadlineRisk = "at_risk";
                else deadlineRisk = "on_track";
            }

            return {
                ...r,
                totalUnitsOrdered,
                totalUnitsCompleted,
                completionPercentage,
                workOrdersCount: woCount,
                derivedStatus,
                deadlineRisk,
                daysUntilDeadline,
            };
        });

        // Six counts that used to be awaited ONE AT A TIME — the page paid every
        // latency end to end (27 Aug 2026, explicit performance request). The
        // four status tallies are now a single $group pass instead of four
        // separate full counts, and it runs alongside the filtered total rather
        // than after it. Same numbers, one round trip.
        const [total, grouped] = await Promise.all([
            CustomerRequest.countDocuments(filter),
            CustomerRequest.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
        ]);
        // `stats` is deliberately UNFILTERED — it always described the whole
        // order book, not the current filter, and the tabs that read it depend
        // on that. Preserved exactly.
        const byStatus = Object.fromEntries(grouped.map((g) => [g._id, g.count]));
        const stats = {
            total: grouped.reduce((n, g) => n + g.count, 0),
            pending: byStatus.pending || 0,
            inProgress: byStatus.in_progress || 0,
            completed: byStatus.completed || 0,
            cancelled: byStatus.cancelled || 0
        };

        res.json({
            success: true,
            requests: enriched,
            stats,
            pagination: {
                page: parseInt(page), limit: parseInt(limit), total,
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error("Error fetching customer requests:", error);
        res.status(500).json({ success: false, message: "Server error while fetching customer requests" });
    }
});

/**
 * Where this order came from, when it came from anywhere.
 *
 * An order raised in the customer portal has no history — most of them. One
 * that came down the Pipeline does, and the Order Book had no way to say so:
 * the page showed the order as if it had appeared from nowhere, while the
 * enquiry, the journey and everything decided on them sat one join away.
 *
 * Two indexed lookups, both optional, neither ever fatal.
 */
async function upstreamOf(requestId) {
    try {
        const SalesJourney = require("../../../models/CMS_Models/Sales/SalesJourney");
        const EnquiryModel = require("../../../models/CMS_Models/Sales/Enquiry");
        const enquiry = await EnquiryModel.findOne({ customerRequestId: requestId, isActive: true })
            .select("enquiryId title journeyId").lean();
        if (!enquiry) return null;
        const journey = enquiry.journeyId
            ? await SalesJourney.findById(enquiry.journeyId).select("journeyId name currentStage").lean()
            : null;
        return {
            enquiryRef: enquiry.enquiryId || null,
            enquiryId: String(enquiry._id),
            journeyRef: journey?.journeyId || null,
            journeyName: journey?.name || null,
            journeyStage: journey?.currentStage || null,
        };
    } catch {
        return null;
    }
}

router.get("/requests/:requestId", async (req, res) => {
    try {
        const request = await CustomerRequest.findById(req.params.requestId)
            .populate('salesPersonAssigned', 'name email phone')
            // `variants.images` as well as `images` (27 Aug 2026). A StockItem
            // carries photos in TWO places — a top-level `images` array and a
            // per-variant one — and in the live register only 9 of 119 products
            // use the top-level field while 99 have their photo on a variant
            // alone. Selecting `images` by itself therefore returned nothing
            // for 83% of products, which is why the Order Items list appeared
            // to have no photos. Only the variant IMAGES are pulled, not whole
            // variant documents, so this stays cheap.
            // `variants.attributes` too, so the frontend can pick the photo for
            // the SIZE/COLOUR actually ordered rather than any variant's.
            .populate('items.stockItemId', 'name reference category images variants.images variants.attributes genderCategory')
            .select('-__v');

        if (!request) {
            return res.status(404).json({ success: false, message: "Request not found" });
        }

        if (
            request.measurementId &&
            request.requestType === 'measurement_conversion'
        ) {
            try {
                const measurement = await Measurement.findById(request.measurementId)
                    .select('employeeMeasurements')
                    .lean();

                if (measurement) {
                    const employeeIds = measurement.employeeMeasurements
                        .map(e => e.employeeId)
                        .filter(Boolean);

                    const mpcEmployees = await EmployeeMpc.find({
                        _id: { $in: employeeIds },
                    })
                        .select('_id products')
                        .lean();

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

                    const enrichedRequest = request.toObject();
                    enrichedRequest.items = enrichedRequest.items.map(item => {
                        const stockId = (
                            item.stockItemId?._id || item.stockItemId
                        )?.toString();
                        const mpcName = stockId ? mpcNameMap.get(stockId) : null;
                        return {
                            ...item,
                            mpcDisplayName: mpcName || null,
                        };
                    });

                    return res.json({
                        success: true,
                        request: enrichedRequest,
                        upstream: await upstreamOf(request._id),
                    });
                }
            } catch (enrichError) {
                console.error('[salesRoutes] MPC name enrichment failed:', enrichError.message);
            }
        }

        res.json({ success: true, request, upstream: await upstreamOf(request._id) });
    } catch (error) {
        console.error("Error fetching customer request:", error);
        res.status(500).json({
            success: false,
            message: "Server error while fetching customer request",
        });
    }
});

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

// ════════════════════════════════════════════════════════════════════════════
// EDIT REQUEST ROUTES (unchanged)
// ════════════════════════════════════════════════════════════════════════════

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

// ════════════════════════════════════════════════════════════════════════════
// EXECUTION — Production, Shipment, Order Closing
// ════════════════════════════════════════════════════════════════════════════
//
// The three screens the Sales Journey shows after the PO, served here keyed by
// the ORDER instead of the enquiry (22 Aug 2026).
//
// The journey's own versions live on /crm/enquiries/:id/{production,shipment,
// closing-report}. Every one of them spends its first half turning an enquiry
// into a `customerRequestId` — by stored link if one exists, otherwise by
// matching the customer's NAME — and its second half reading work orders off
// that id. This page already holds the id, so these routes are that second half
// and nothing else. The view builders are the same modules, so the numbers are
// the same numbers.
//
// Why this way round, rather than resolving an enquiry from here: of the 16
// orders that have work orders, exactly ONE is reachable through an enquiry.
// Orders raised in the customer portal never had a journey, and the Order Book
// is the surface that has to show them all.
//
// The enquiry is still looked up when one exists, because two things genuinely
// live on it: the early-dispatch asks Sales has recorded, and the costing-sheet
// estimate half of the closing report. Both degrade to absent, never to an
// error — an order with no enquiry still gets its production, its dispatch and
// its closing figures.
const DispatchChallan = require("../../../models/CMS_Models/Manufacturing/Dispatch/DispatchChallan");
const Enquiry = require("../../../models/CMS_Models/Sales/Enquiry");
const { buildProductionView } = require("../../../services/productionView");
const { buildShipmentView } = require("../../../services/shipmentView");
const { buildClosingReport } = require("../../../services/closingReport");
const { isSalesManager } = require("../../../services/salesAccess");
const mongooseLib = require("mongoose");

const isOid = (v) => mongooseLib.Types.ObjectId.isValid(v);

/** The enquiry behind this order, when the two were ever linked. Never fatal. */
async function enquiryForRequest(requestId) {
    try {
        return await Enquiry.findOne({ customerRequestId: requestId, isActive: true }).lean();
    } catch {
        return null;
    }
}

// GET /api/cms/sales/requests/:requestId/production
router.get("/requests/:requestId/production", async (req, res) => {
    try {
        const { requestId } = req.params;
        if (!isOid(requestId)) return res.status(400).json({ success: false, message: "Invalid order reference." });

        const workOrders = await WorkOrder.find({ customerRequestId: requestId })
            .select("workOrderNumber stockItemName stockItemReference variantAttributes quantity status "
                  + "assignedDeadline productionCompletion customerName stockItemId variantId")
            // Product identity for the style rail — a photo, the reference code
            // and the gender, so a style can be RECOGNISED and not just named
            // (27 Aug 2026). `variants.images` matters as much as `images`:
            // most products in the live register carry their photo only on a
            // variant, so selecting the top-level array alone finds nothing.
            .populate("stockItemId", "name reference category genderCategory images variants.images")
            .lean();

        if (!workOrders.length) {
            return res.json({
                success: true, linked: true, requestId, workOrders: 0,
                reason: "No work order has been raised against this order yet, so nothing is in production.",
            });
        }

        return res.json({ success: true, linked: true, requestId, view: buildProductionView(workOrders) });
    } catch (error) {
        console.error("[customerRequests] GET /requests/:requestId/production", error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// GET /api/cms/sales/requests/:requestId/shipment
router.get("/requests/:requestId/shipment", async (req, res) => {
    try {
        const { requestId } = req.params;
        if (!isOid(requestId)) return res.status(400).json({ success: false, message: "Invalid order reference." });

        const [workOrders, challans, enquiry] = await Promise.all([
            WorkOrder.find({ customerRequestId: requestId })
                .select("workOrderNumber stockItemName stockItemReference variantAttributes quantity status "
                      + "assignedDeadline dispatchedQuantity productionCompletion.operationCompletion "
                      + "stockItemId variantId")
                .populate("stockItemId", "name reference category genderCategory images variants.images")
                .lean(),
            DispatchChallan.find({ manufacturingOrderId: requestId })
                .select("challanNumber dispatchType totalUnits totalPersons persons.employeeName persons.employeeUIN "
                      + "persons.department persons.designation persons.totalUnits dispatchedBy notes createdAt")
                .lean(),
            enquiryForRequest(requestId),
        ]);

        if (!workOrders.length) {
            return res.json({
                success: true, linked: true, requestId, workOrders: 0,
                enquiryId: enquiry ? String(enquiry._id) : null,
                reason: "No work order has been raised against this order yet, so nothing has been packed.",
            });
        }

        return res.json({
            success: true,
            linked: true,
            requestId,
            // The early-send ask is WRITTEN onto the enquiry, so the panel that
            // raises one needs this id and hides itself without it. Reading is
            // unaffected: no enquiry simply means no asks recorded yet.
            enquiryId: enquiry ? String(enquiry._id) : null,
            view: buildShipmentView(workOrders, challans, enquiry?.earlyDispatchRequests || []),
        });
    } catch (error) {
        console.error("[customerRequests] GET /requests/:requestId/shipment", error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// GET /api/cms/sales/requests/:requestId/closing-report
router.get("/requests/:requestId/closing-report", async (req, res) => {
    try {
        const { requestId } = req.params;
        if (!isOid(requestId)) return res.status(400).json({ success: false, message: "Invalid order reference." });

        const [workOrders, challans, request, enquiry] = await Promise.all([
            WorkOrder.find({ customerRequestId: requestId })
                .select("workOrderNumber stockItemName stockItemReference variantAttributes quantity assignedDeadline "
                      + "dispatchedQuantity estimatedCost actualCost rawMaterials.quantityIssued rawMaterials.unitCost "
                      + "productionCompletion.operationCompletion productionCompletion.timeMetrics "
                      + "productionCompletion.invalidScansCount")
                .lean(),
            DispatchChallan.find({ manufacturingOrderId: requestId })
                .select("challanNumber dispatchType totalUnits totalPersons createdAt "
                      + "persons.employeeName persons.department persons.totalUnits")
                .lean(),
            CustomerRequest.findById(requestId)
                .select("requestId customerInfo.name grandTotal paymentSchedule quotations.grandTotal").lean(),
            enquiryForRequest(requestId),
        ]);

        if (!request) return res.status(404).json({ success: false, message: "Order not found." });

        if (!workOrders.length) {
            return res.json({
                success: true, linked: true, requestId, workOrders: 0,
                reason: "No work order was ever raised against this order, so there is nothing to report on.",
            });
        }

        const report = buildClosingReport({ workOrders, challans, request, enquiry });

        // Same rule as the journey's own closing report, and for the same
        // reason: profit = revenue − cost, and the invoice total is visible to
        // everyone, so a margin percentage hands over the cost by subtraction.
        // Cost and margin move together or not at all.
        //
        // The enquiry's owner usually cannot be consulted here — most orders
        // have no enquiry — so where the journey grants "cost" to the deal
        // owner, this route mostly falls back to manager-or-not. Stricter,
        // never looser.
        const owns = enquiry?.ownerId && String(enquiry.ownerId) === String(req.user?.id);
        const tier = owns || (await isSalesManager(req.user)) ? "cost" : "floor";

        if (tier === "floor") {
            const { costing, ...rest } = report;
            return res.json({
                success: true, linked: true, tier, requestId,
                customerName: request.customerInfo?.name || null,
                report: {
                    ...rest,
                    costing: null,
                    lines: rest.lines.map(({ cost, ...line }) => line),
                },
            });
        }

        return res.json({
            success: true, linked: true, tier, requestId,
            customerName: request.customerInfo?.name || null,
            report,
        });
    } catch (error) {
        console.error("[customerRequests] GET /requests/:requestId/closing-report", error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
