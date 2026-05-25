// routes/CMS_Routes/Manufacturing/Dispatch/dispatchChallanRoutes.js
//
// Mount in server.js:
//   const dispatchChallanRoutes = require("./routes/CMS_Routes/Manufacturing/Dispatch/dispatchChallanRoutes");
//   app.use("/api/cms/manufacturing/dispatch-challans", dispatchChallanRoutes);

const express  = require("express");
const router   = express.Router();
const mongoose = require("mongoose");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const DispatchChallan = require("../../../../models/CMS_Models/Manufacturing/Dispatch/DispatchChallan");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");

router.use(EmployeeAuthMiddleware);

// ─────────────────────────────────────────────────────────────────────────────
// Helper: generate challan number  DC-YYYYMMDD-XXXX  (sequential per day)
// ─────────────────────────────────────────────────────────────────────────────
async function generateChallanNumber() {
  const now      = new Date();
  const dateStr  = now.toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
  const startDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(),  0,  0,  0,   0);
  const endDay   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  const todayCount = await DispatchChallan.countDocuments({
    createdAt: { $gte: startDay, $lte: endDay },
  });

  return `DC-${dateStr}-${String(todayCount + 1).padStart(4, "0")}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /
// Create a dispatch challan.
// Called when the user clicks "Save & Generate Receipt" in the frontend.
//
// Body: {
//   manufacturingOrderId: string,
//   dispatchType:         "person_wise" | "bulk",
//   persons?:             [...],   // required when dispatchType === "person_wise"
//   bulkProducts?:        [...],   // required when dispatchType === "bulk"
//   notes?:               string,
// }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const { manufacturingOrderId, dispatchType, persons, bulkProducts, notes } = req.body;

    if (!mongoose.Types.ObjectId.isValid(manufacturingOrderId)) {
      return res.status(400).json({ success: false, message: "Invalid manufacturing order ID" });
    }
    if (!["person_wise", "bulk"].includes(dispatchType)) {
      return res.status(400).json({ success: false, message: "dispatchType must be person_wise or bulk" });
    }

    // Load MO for customer info
    const mo = await CustomerRequest.findById(manufacturingOrderId)
      .select("requestId customerInfo")
      .lean();
    if (!mo) {
      return res.status(404).json({ success: false, message: "Manufacturing order not found" });
    }

    const challanNumber = await generateChallanNumber();

    const parsedPersons = Array.isArray(persons)      ? persons      : [];
    const parsedBulk    = Array.isArray(bulkProducts) ? bulkProducts : [];

    // Compute totals + ensure totalUnits is set on each person
    let totalUnits = 0, totalPersons = 0, totalProducts = 0;

    const enrichedPersons = parsedPersons.map((p) => {
      const pu = (p.products || []).reduce((s, pr) => s + (Number(pr.quantity) || 0), 0);
      totalUnits    += pu;
      totalPersons  += 1;
      totalProducts += (p.products || []).length;
      return { ...p, totalUnits: pu };
    });

    parsedBulk.forEach((p) => {
      totalUnits    += Number(p.quantity) || 0;
      totalProducts += 1;
    });

    const challan = await DispatchChallan.create({
      challanNumber,
      manufacturingOrderId,
      requestId:    mo.requestId    || "",
      customerName: mo.customerInfo?.name || "—",
      customerInfo: mo.customerInfo || null,
      dispatchType,
      persons:      dispatchType === "person_wise" ? enrichedPersons : [],
      bulkProducts: dispatchType === "bulk"        ? parsedBulk      : [],
      totalUnits,
      totalPersons,
      totalProducts,
      notes:        notes || "",
      dispatchedBy: req.user?.name || req.user?.employeeId || "Dispatch Dept",
      createdBy:    req.user?.id   || null,
    });

    return res.json({
      success: true,
      message: `Challan ${challanNumber} created successfully`,
      challan,
      challanNumber,
    });
  } catch (err) {
    console.error("Create challan error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /manufacturing-orders/:id
// All challans for a given MO — paginated, searchable, filterable by date.
// Query: page, limit, search, startDate (ISO), endDate (ISO)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/manufacturing-orders/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      page = 1, limit = 20,
      search = "",
      startDate = "", endDate = "",
    } = req.query;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid MO id" });
    }

    const filter = { manufacturingOrderId: new mongoose.Types.ObjectId(id) };

    if (search) {
      const re = new RegExp(search.trim(), "i");
      filter.$or = [
        { challanNumber: re },
        { "persons.employeeName": re },
        { "persons.employeeUIN": re },
        { "bulkProducts.productName": re },
        { dispatchedBy: re },
      ];
    }

    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
    }

    const pageNum  = Math.max(1, parseInt(page,  10));
    const limitNum = Math.max(1, parseInt(limit, 10));

    const [total, challans] = await Promise.all([
      DispatchChallan.countDocuments(filter),
      DispatchChallan.find(filter)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
    ]);

    // Aggregate stats across ALL matching documents (not just current page)
    const allStats = await DispatchChallan.find(filter)
      .select("totalUnits dispatchType")
      .lean();

    const totals = {
      totalChallans:   total,
      totalUnits:      allStats.reduce((s, c) => s + (c.totalUnits || 0), 0),
      personWiseCount: allStats.filter((c) => c.dispatchType === "person_wise").length,
      bulkCount:       allStats.filter((c) => c.dispatchType === "bulk").length,
    };

    return res.json({
      success: true,
      challans,
      totals,
      pagination: {
        page:       pageNum,
        limit:      limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    console.error("Get challans error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:challanId
// Single challan by ID — used when re-downloading a specific challan PDF.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:challanId", async (req, res) => {
  try {
    const { challanId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(challanId)) {
      return res.status(400).json({ success: false, message: "Invalid challan ID" });
    }
    const challan = await DispatchChallan.findById(challanId).lean();
    if (!challan) {
      return res.status(404).json({ success: false, message: "Challan not found" });
    }
    return res.json({ success: true, challan });
  } catch (err) {
    console.error("Get single challan error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;