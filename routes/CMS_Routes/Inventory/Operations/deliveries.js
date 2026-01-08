// routes/CMS_Routes/Inventory/Operations/deliveries.js

const express = require("express");
const router = express.Router();
const PurchaseOrder = require("../../../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const Vendor = require("../../../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");

// Apply auth middleware to all routes
router.use(EmployeeAuthMiddleware);

// ✅ GET all deliveries with filters
// Updated routes/CMS_Routes/Inventory/Operations/deliveries.js
// Fix the GET / route to properly show delivery quantities

router.get("/", async (req, res) => {
    try {
        const {
            search = "",
            rawItem,
            vendor,
            status,
            startDate,
            endDate
        } = req.query;

        // Get all purchase orders with deliveries
        let filter = {};

        if (search) {
            filter.$or = [
                { poNumber: { $regex: search, $options: "i" } },
                { vendorName: { $regex: search, $options: "i" } },
                { "deliveries.invoiceNumber": { $regex: search, $options: "i" } }
            ];
        }

        if (vendor) {
            filter.vendor = vendor;
        }

        if (status) {
            filter.status = status;
        }

        if (rawItem) {
            filter["items.rawItem"] = rawItem;
        }

        // Filter by delivery date range
        if (startDate || endDate) {
            filter["deliveries.deliveryDate"] = {};
            if (startDate) {
                filter["deliveries.deliveryDate"].$gte = new Date(startDate);
            }
            if (endDate) {
                filter["deliveries.deliveryDate"].$lte = new Date(endDate);
            }
        }

        // Get purchase orders that have deliveries
        filter.deliveries = { $exists: true, $not: { $size: 0 } };

        const purchaseOrders = await PurchaseOrder.find(filter)
            .populate("vendor", "companyName")
            .populate("items.rawItem", "name sku unit")
            .populate("deliveries.receivedBy", "name email")
            .populate("items.rawItem", "name sku unit")
            .sort({ "deliveries.createdAt": -1 });

        // Flatten deliveries with delivery-specific quantities
        const allDeliveries = [];
        let totalQuantity = 0;
        let totalValue = 0;

        purchaseOrders.forEach(po => {
            po.deliveries.forEach(delivery => {
                const deliveryData = {
                    _id: delivery._id,
                    poNumber: po.poNumber,
                    purchaseOrderId: po._id,
                    vendorName: po.vendorName || po.vendor?.companyName,
                    vendorId: po.vendor,
                    deliveryDate: delivery.deliveryDate,
                    invoiceNumber: delivery.invoiceNumber,
                    notes: delivery.notes,
                    receivedBy: delivery.receivedBy,
                    createdAt: delivery.createdAt,
                    updatedAt: delivery.updatedAt,
                    items: [],
                    totalQuantity: delivery.quantityReceived || 0, // Use the actual delivery quantity
                    purchaseOrder: {
                        _id: po._id,
                        status: po.status,
                        totalReceived: po.totalReceived,
                        items: po.items,
                        totalOrdered: po.items.reduce((sum, item) => sum + item.quantity, 0)
                    }
                };

                // Calculate delivery value based on items
                // Note: In a real system, we should track which items were in which delivery
                // For now, we'll assume equal distribution or use the delivery quantity
                let deliveryValue = 0;

                // If we have the delivery quantity, we can calculate approximate value
                if (delivery.quantityReceived > 0 && po.items.length > 0) {
                    // Calculate average unit price
                    const avgUnitPrice = po.items.reduce((sum, item) => sum + item.unitPrice, 0) / po.items.length;
                    deliveryValue = delivery.quantityReceived * avgUnitPrice;

                    // Add item details (simplified - in reality should track per item)
                    po.items.forEach(item => {
                        // Distribute quantity proportionally
                        const itemQuantity = Math.round((item.quantity / po.items.reduce((sum, i) => sum + i.quantity, 0)) * delivery.quantityReceived);
                        if (itemQuantity > 0) {
                            deliveryData.items.push({
                                itemName: item.itemName,
                                sku: item.sku,
                                unit: item.unit,
                                quantityReceived: itemQuantity,
                                unitPrice: item.unitPrice,
                                rawItemId: item.rawItem
                            });
                        }
                    });
                }

                deliveryData.totalValue = deliveryValue;

                allDeliveries.push(deliveryData);
                totalQuantity += delivery.quantityReceived || 0;
                totalValue += deliveryValue;
            });
        });

        // Sort by delivery date (newest first)
        allDeliveries.sort((a, b) => new Date(b.deliveryDate) - new Date(a.deliveryDate));

        // Get statistics
        const totalDeliveries = allDeliveries.length;

        // Count deliveries from last 7 days
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);
        const recentDeliveries = allDeliveries.filter(d =>
            new Date(d.deliveryDate) >= weekAgo
        ).length;

        // Count pending POs
        const pendingPOs = await PurchaseOrder.countDocuments({
            status: { $in: ["ISSUED", "PARTIALLY_RECEIVED"] }
        });

        res.json({
            success: true,
            deliveries: allDeliveries,
            stats: {
                totalDeliveries,
                totalQuantity,
                totalValue,
                recentDeliveries,
                pendingPOs
            }
        });

    } catch (error) {
        console.error("Error fetching deliveries:", error);
        res.status(500).json({
            success: false,
            message: "Server error while fetching deliveries"
        });
    }
});

// ✅ GET delivery by ID
// Update the GET delivery by ID route in deliveries.js

// ✅ GET delivery by ID (updated)
router.get("/:id", async (req, res) => {
    try {
        // Find purchase order that contains this delivery
        const purchaseOrder = await PurchaseOrder.findOne({
            "deliveries._id": req.params.id
        })
            .populate("vendor", "companyName contactPerson phone email address gstNumber")
            .populate("items.rawItem", "name sku unit description")
            .populate("deliveries.receivedBy", "name email")
            .populate("createdBy", "name email");

        if (!purchaseOrder) {
            return res.status(404).json({
                success: false,
                message: "Delivery not found"
            });
        }

        // Find the specific delivery
        const delivery = purchaseOrder.deliveries.find(d =>
            d._id.toString() === req.params.id
        );

        if (!delivery) {
            return res.status(404).json({
                success: false,
                message: "Delivery not found"
            });
        }

        // Calculate delivery position to determine quantities
        const deliveryIndex = purchaseOrder.deliveries.findIndex(d =>
            d._id.toString() === req.params.id
        );

        // Get previous deliveries before this one
        const previousDeliveries = purchaseOrder.deliveries.slice(deliveryIndex + 1);

        // Calculate quantities for this specific delivery
        // This is a simplified approach - in reality, you'd need to track delivery-specific quantities
        const deliveryItems = [];

        purchaseOrder.items.forEach(item => {
            // Calculate quantity received in this delivery
            // For simplicity, we'll divide remaining quantities equally among deliveries
            // In a real system, you'd track which items in which delivery
            const totalDeliveriesForPO = purchaseOrder.deliveries.length;
            const quantityPerDelivery = Math.ceil(item.receivedQuantity / totalDeliveriesForPO);

            deliveryItems.push({
                itemName: item.itemName,
                sku: item.sku,
                unit: item.unit,
                quantity: item.quantity,
                // For this specific delivery, show estimated or equal distribution
                receivedInThisDelivery: quantityPerDelivery,
                totalReceived: item.receivedQuantity,
                pendingQuantity: item.pendingQuantity,
                unitPrice: item.unitPrice,
                totalPrice: item.totalPrice,
                rawItem: item.rawItem,
                status: item.status
            });
        });

        const deliveryDetails = {
            _id: delivery._id,
            poNumber: purchaseOrder.poNumber,
            purchaseOrderId: purchaseOrder._id,
            vendor: purchaseOrder.vendor,
            vendorName: purchaseOrder.vendorName || purchaseOrder.vendor?.companyName,
            deliveryDate: delivery.deliveryDate,
            invoiceNumber: delivery.invoiceNumber,
            notes: delivery.notes,
            receivedBy: delivery.receivedBy,
            createdAt: delivery.createdAt,
            updatedAt: delivery.updatedAt,
            purchaseOrder: {
                _id: purchaseOrder._id,
                poNumber: purchaseOrder.poNumber,
                orderDate: purchaseOrder.orderDate,
                expectedDeliveryDate: purchaseOrder.expectedDeliveryDate,
                status: purchaseOrder.status,
                totalAmount: purchaseOrder.totalAmount,
                totalReceived: purchaseOrder.totalReceived,
                totalPending: purchaseOrder.totalPending,
                hasPendingQuantities: purchaseOrder.totalPending > 0
            },
            items: deliveryItems
        };

        res.json({
            success: true,
            delivery: deliveryDetails
        });

    } catch (error) {
        console.error("Error fetching delivery:", error);
        res.status(500).json({
            success: false,
            message: "Server error while fetching delivery"
        });
    }
});

// ✅ GET purchase orders with pending deliveries
router.get("/data/pending-pos", async (req, res) => {
    try {
        const purchaseOrders = await PurchaseOrder.find({
            status: { $in: ["ISSUED", "PARTIALLY_RECEIVED"] },
            totalPending: { $gt: 0 }
        })
            .select("poNumber vendor vendorName items status totalReceived totalPending expectedDeliveryDate")
            .populate("vendor", "companyName")
            .populate("items.rawItem", "name sku unit")
            .sort({ expectedDeliveryDate: 1 });

        // Format for frontend selection
        const pendingPOs = purchaseOrders.map(po => ({
            id: po._id,
            poNumber: po.poNumber,
            vendorName: po.vendorName || po.vendor?.companyName,
            items: po.items.map(item => ({
                id: item._id,
                name: item.itemName,
                sku: item.sku,
                unit: item.unit,
                ordered: item.quantity,
                received: item.receivedQuantity,
                pending: item.pendingQuantity,
                rawItemId: item.rawItem
            })),
            totalOrdered: po.items.reduce((sum, item) => sum + item.quantity, 0),
            totalReceived: po.totalReceived,
            totalPending: po.totalPending,
            expectedDeliveryDate: po.expectedDeliveryDate,
            status: po.status
        }));

        res.json({
            success: true,
            purchaseOrders: pendingPOs
        });

    } catch (error) {
        console.error("Error fetching pending purchase orders:", error);
        res.status(500).json({
            success: false,
            message: "Server error while fetching pending purchase orders"
        });
    }
});

// ✅ GET delivery statistics
router.get("/stats/summary", async (req, res) => {
    try {
        const { period = "month" } = req.query;

        let startDate = new Date();

        switch (period) {
            case "week":
                startDate.setDate(startDate.getDate() - 7);
                break;
            case "month":
                startDate.setMonth(startDate.getMonth() - 1);
                break;
            case "quarter":
                startDate.setMonth(startDate.getMonth() - 3);
                break;
            case "year":
                startDate.setFullYear(startDate.getFullYear() - 1);
                break;
        }

        // Get purchase orders with deliveries in the period
        const purchaseOrders = await PurchaseOrder.find({
            "deliveries.deliveryDate": { $gte: startDate }
        })
            .select("deliveries items totalReceived");

        // Calculate statistics
        let totalDeliveries = 0;
        let totalQuantity = 0;
        let totalValue = 0;
        const deliveriesByDay = {};
        const itemsByCategory = {};

        purchaseOrders.forEach(po => {
            po.deliveries.forEach(delivery => {
                if (new Date(delivery.deliveryDate) >= startDate) {
                    totalDeliveries++;

                    // Track by day
                    const day = new Date(delivery.deliveryDate).toISOString().split('T')[0];
                    deliveriesByDay[day] = (deliveriesByDay[day] || 0) + 1;

                    // Calculate quantity and value
                    // Note: This is simplified - in reality you'd need to track which items in which delivery
                    po.items.forEach(item => {
                        totalQuantity += item.receivedQuantity || 0;
                        totalValue += (item.receivedQuantity || 0) * (item.unitPrice || 0);
                    });
                }
            });
        });

        // Get vendor performance
        const vendorStats = await PurchaseOrder.aggregate([
            {
                $match: {
                    "deliveries.deliveryDate": { $gte: startDate }
                }
            },
            {
                $group: {
                    _id: "$vendor",
                    vendorName: { $first: "$vendorName" },
                    deliveryCount: { $sum: { $size: "$deliveries" } },
                    totalQuantity: { $sum: "$totalReceived" },
                    totalValue: {
                        $sum: {
                            $multiply: [
                                "$totalReceived",
                                { $divide: ["$totalAmount", { $sum: "$items.quantity" }] }
                            ]
                        }
                    }
                }
            },
            { $sort: { totalValue: -1 } },
            { $limit: 5 }
        ]);

        res.json({
            success: true,
            stats: {
                totalDeliveries,
                totalQuantity,
                totalValue,
                deliveriesByDay,
                vendorPerformance: vendorStats
            }
        });

    } catch (error) {
        console.error("Error fetching delivery statistics:", error);
        res.status(500).json({
            success: false,
            message: "Server error while fetching delivery statistics"
        });
    }
});

module.exports = router;