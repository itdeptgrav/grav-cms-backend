// routes/CMS_Routes/Manufacturing/Manufacturing-Order/manufacturingOrderRoutes.js - UPDATED

const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");

router.use(EmployeeAuthMiddleware);

// GET all manufacturing orders (sales-approved customer requests)
router.get("/", async (req, res) => {
    try {
        const {
            page = 1,
            limit = 10,
            search = "",
            status = ""
        } = req.query;

        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const skip = (pageNum - 1) * limitNum;

        let query = {
            status: 'quotation_sales_approved'
        };

        if (search) {
            const searchRegex = new RegExp(search, 'i');
            query.$or = [
                { 'customerInfo.name': searchRegex },
                { requestId: searchRegex },
                { 'customerInfo.email': searchRegex }
            ];
        }

        if (status) {
            query.status = status;
        }

        const total = await CustomerRequest.countDocuments(query);

        const customerRequests = await CustomerRequest.find(query)
            .populate('customerId', 'name email phone')
            .populate('salesPersonAssigned', 'name email')
            .populate('quotations.preparedBy', 'name email')
            .sort({ updatedAt: -1 })
            .skip(skip)
            .limit(limitNum)
            .lean();

        const manufacturingOrders = await Promise.all(
            customerRequests.map(async (request) => {
                const workOrders = await WorkOrder.find({ 
                    customerRequestId: request._id 
                });

                const totalQuantity = request.items.reduce((sum, item) => 
                    sum + (item.totalQuantity || 0), 0
                );

                return {
                    _id: request._id,
                    moNumber: `MO-${request.requestId}`,
                    requestId: request.requestId,
                    customerInfo: request.customerInfo,
                    finalOrderPrice: request.finalOrderPrice || 0,
                    totalQuantity: totalQuantity,
                    workOrdersCount: workOrders.length,
                    status: request.status,
                    priority: request.priority,
                    createdAt: request.createdAt,
                    updatedAt: request.updatedAt,
                    salesPerson: request.salesPersonAssigned,
                    quotationNumber: request.quotations[0]?.quotationNumber,
                    quotationDate: request.quotations[0]?.date
                };
            })
        );

        res.json({
            success: true,
            manufacturingOrders,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total,
                pages: Math.ceil(total / limitNum)
            }
        });

    } catch (error) {
        console.error("Error fetching manufacturing orders:", error);
        res.status(500).json({
            success: false,
            message: "Server error while fetching manufacturing orders"
        });
    }
});

// GET single manufacturing order details
router.get("/:id", async (req, res) => {
    try {
        const { id } = req.params;

        const customerRequest = await CustomerRequest.findById(id)
            .populate('customerId', 'name email phone address')
            .populate('salesPersonAssigned', 'name email phone')
            .populate('quotations.preparedBy', 'name email')
            .lean();

        if (!customerRequest) {
            return res.status(404).json({
                success: false,
                message: "Manufacturing order not found"
            });
        }

        const workOrders = await WorkOrder.find({ 
            customerRequestId: customerRequest._id 
        })
        .populate('stockItemId', 'name reference images')
        .populate('createdBy', 'name email')
        .populate('plannedBy', 'name email')
        .sort({ createdAt: 1 })
        .lean();

        const totalWorkOrders = workOrders.length;
        const totalQuantity = workOrders.reduce((sum, wo) => sum + wo.quantity, 0);
        
        const plannedWorkOrders = workOrders.filter(wo => wo.status === 'planned').length;
        const scheduledWorkOrders = workOrders.filter(wo => wo.status === 'scheduled').length;
        const inProgressWorkOrders = workOrders.filter(wo => wo.status === 'in_progress').length;
        const completedWorkOrders = workOrders.filter(wo => wo.status === 'completed').length;

        // Get aggregated raw material requirements with available stock
        const rawMaterialMap = new Map();
        
        for (const wo of workOrders) {
            for (const rm of wo.rawMaterials) {
                if (rm.rawItemId) {
                    const key = rm.rawItemId.toString();
                    if (rawMaterialMap.has(key)) {
                        const existing = rawMaterialMap.get(key);
                        existing.quantityRequired += rm.quantityRequired;
                        existing.totalCost += rm.totalCost;
                    } else {
                        rawMaterialMap.set(key, {
                            rawItemId: rm.rawItemId,
                            name: rm.name,
                            sku: rm.sku,
                            quantityRequired: rm.quantityRequired,
                            unit: rm.unit,
                            unitCost: rm.unitCost,
                            totalCost: rm.totalCost
                        });
                    }
                }
            }
        }

        // Fetch current stock for each raw material
        const allRawMaterialRequirements = [];
        
        for (const [key, material] of rawMaterialMap) {
            if (material.rawItemId) {
                const rawItem = await RawItem.findById(material.rawItemId).lean();
                const availableQuantity = rawItem?.quantity || 0;
                const deficitQuantity = Math.max(0, material.quantityRequired - availableQuantity);
                
                let status = "available";
                if (availableQuantity === 0) {
                    status = "unavailable";
                } else if (availableQuantity < material.quantityRequired) {
                    status = "partial";
                }

                allRawMaterialRequirements.push({
                    ...material,
                    availableQuantity,
                    deficitQuantity,
                    status,
                    rawItemStatus: rawItem?.status
                });
            }
        }

        const manufacturingOrder = {
            _id: customerRequest._id,
            moNumber: `MO-${customerRequest.requestId}`,
            requestId: customerRequest.requestId,
            customerInfo: customerRequest.customerInfo,
            customer: customerRequest.customerId,
            items: customerRequest.items,
            finalOrderPrice: customerRequest.finalOrderPrice || 0,
            totalPaidAmount: customerRequest.totalPaidAmount || 0,
            totalDueAmount: customerRequest.totalDueAmount || 0,
            priority: customerRequest.priority,
            status: customerRequest.status,
            salesPerson: customerRequest.salesPersonAssigned,
            quotation: customerRequest.quotations[0],
            estimatedCompletion: customerRequest.estimatedCompletion,
            specialInstructions: customerRequest.customerInfo?.description,
            deliveryDeadline: customerRequest.customerInfo?.deliveryDeadline,
            createdAt: customerRequest.createdAt,
            updatedAt: customerRequest.updatedAt,
            
            workOrders: workOrders,
            workOrderStats: {
                total: totalWorkOrders,
                planned: plannedWorkOrders,
                scheduled: scheduledWorkOrders,
                inProgress: inProgressWorkOrders,
                completed: completedWorkOrders,
                totalQuantity: totalQuantity
            },
            
            rawMaterialRequirements: allRawMaterialRequirements,
            totalRawMaterialCost: allRawMaterialRequirements.reduce((sum, rm) => sum + rm.totalCost, 0),
            
            timeline: {
                requestCreated: customerRequest.createdAt,
                salesApproved: customerRequest.quotations[0]?.salesApproval?.approvedAt,
                estimatedCompletion: customerRequest.estimatedCompletion,
                actualCompletion: customerRequest.actualCompletion
            }
        };

        res.json({
            success: true,
            manufacturingOrder
        });

    } catch (error) {
        console.error("Error fetching manufacturing order details:", error);
        res.status(500).json({
            success: false,
            message: "Server error while fetching manufacturing order details"
        });
    }
});

// GET work orders for a manufacturing order
router.get("/:id/work-orders", async (req, res) => {
    try {
        const { id } = req.params;

        const workOrders = await WorkOrder.find({ 
            customerRequestId: id 
        })
        .populate('stockItemId', 'name reference images')
        .populate('createdBy', 'name email')
        .populate('plannedBy', 'name email')
        .sort({ createdAt: 1 });

        res.json({
            success: true,
            workOrders
        });

    } catch (error) {
        console.error("Error fetching work orders:", error);
        res.status(500).json({
            success: false,
            message: "Server error while fetching work orders"
        });
    }
});

module.exports = router;