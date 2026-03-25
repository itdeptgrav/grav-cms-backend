const dns = require("dns").setServers(["8.8.8.8", "8.8.4.4"]);
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
require("dotenv").config();

const http = require("http");
const { Server } = require("socket.io");

// IMPORT PRODUCTION SYNC SERVICE
const productionSyncService = require("./services/productionSyncService");

const app = express();

const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "https://grav-cms.vercel.app",
  "https://cms.grav.in",
  "https://customer.grav.in",
  "http://192.168.1.30:3000",
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  }),
);

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(cookieParser());

// Create HTTP server
const server = http.createServer(app);

// Initialize Socket.IO with CORS configuration
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
    methods: ["GET", "POST"],
  },
  transports: ["websocket", "polling"],
  pingTimeout: 60000,
});

// Make io accessible to routes
app.set("io", io);

// ─── WebSocket connection handling ────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("✅ New WebSocket client connected:", socket.id);

  // Join cowork room
  socket.on("join_cowork", (employeeId) => {
    if (employeeId) {
      socket.join(String(employeeId));
      console.log(`✅ Employee ${employeeId} joined socket room`);

      // Broadcast online status
      socket.broadcast.emit("workspace-member-status", {
        memberId: employeeId,
        isOnline: true,
      });
    }
  });

  // Typing indicator
  socket.on("typing", (data) => {
    const { conversationId, isTyping } = data;
    socket.to(`dm_${conversationId}`).emit("typing_indicator", {
      conversationId,
      isTyping,
    });
  });

  // ── COWORKING SPACE: Group chat rooms ─────────────────────────────────
  socket.on("join_group", (groupId) => {
    if (groupId) {
      socket.join(`group_${groupId}`);
      console.log(`Socket ${socket.id} joined group_${groupId}`);
    }
  });

  socket.on("leave_group", (groupId) => {
    if (groupId) {
      socket.leave(`group_${groupId}`);
      console.log(`Socket ${socket.id} left group_${groupId}`);
    }
  });

  // ── COWORKING SPACE: Direct message rooms ─────────────────────────────
  socket.on("join_dm", (chatId) => {
    // chatId = [senderId, receiverId].sort().join("_")
    if (chatId) {
      socket.join(`dm_${chatId}`);
      console.log(`Socket ${socket.id} joined dm_${chatId}`);
    }
  });

  socket.on("leave_dm", (chatId) => {
    if (chatId) {
      socket.leave(`dm_${chatId}`);
    }
  });

  // ── COWORKING SPACE: Online presence tracking ─────────────────────────
  socket.on("workspace-set-online", (memberId) => {
    socket.workspaceMemberId = memberId;
    socket.broadcast.emit("workspace-member-status", {
      memberId,
      isOnline: true,
    });
  });

  socket.on("disconnect", () => {
    console.log("❌ WebSocket client disconnected:", socket.id);
    // Broadcast offline status when a workspace member disconnects
    if (socket.workspaceMemberId) {
      socket.broadcast.emit("workspace-member-status", {
        memberId: socket.workspaceMemberId,
        isOnline: false,
      });
    }
  });
});

// ─── Database Connection ──────────────────────────────────────────────────────
const connectDB = async () => {
  try {
    await mongoose.connect(
      process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing",
    );
    console.log("✅ MongoDB connected successfully");


    // INITIALIZE PRODUCTION SYNC SERVICE AFTER DB CONNECTION
    productionSyncService.initialize();

    await assignMeasurementsToExistingProducts();

  } catch (error) {
    console.error("❌ MongoDB connection error:", error.message);
    process.exit(1);
  }
};

connectDB().then(async () => {
  await createDefaultCuttingMaster();
  await createDefaultAccountant();
  await assignMeasurementsToExistingProducts();
});

const CuttingMaster = require("./models/CuttingMasterDepartment");
const HRDepartment = require("./models/HRDepartment");
const AccountantDepartment = require("./models/Accountant_model/AccountantDepartment.js");

const createDefaultCuttingMaster = async () => {
  try {
    const existingCuttingMaster = await CuttingMaster.findOne({
      role: "cutting_master",
      department: "Cutting",
    });

    if (existingCuttingMaster) {
      console.log("✅ Cutting Master already exists, skipping creation");
      return;
    }

    const defaultCuttingMaster = new CuttingMaster({
      name: "Cutting Admin",
      email: "cutting@grav.in",
      password: "Cut@12345",
      employeeId: "CUT001",
      phone: "9999999999",
      department: "Cutting",
      role: "cutting_master",
      isActive: true,
    });

    await defaultCuttingMaster.save();
    console.log("✅ Default Cutting Master created successfully");
  } catch (error) {
    console.error("❌ Cutting Master creation failed:", error.message);
  }
};

// const backfillWorkOrderOperationCodes = async () => {
//   const flagKey = "backfill_workorder_operation_codes_v3_fixess";
//   const db = mongoose.connection.db;
//   const flagsCol = db.collection("_migration_flags");

//   const alreadyRan = await flagsCol.findOne({ key: flagKey });
//   if (alreadyRan) {
//     console.log("✅ WorkOrder operationCode backfill already ran — skipping");
//     return;
//   }

//   console.log("🔄 Backfilling operationCode on WorkOrder operations from StockItem...");

//   // Fetch all work orders that have operations with missing operationCode
//   const workOrders = await WorkOrder.find({
//     "operations.0": { $exists: true }
//   }).select("workOrderNumber stockItemId operations").lean();

//   console.log(`   📦 Found ${workOrders.length} work orders to process`);

//   let totalPatched = 0;
//   let totalNoMatch = 0;
//   let totalWOsUpdated = 0;

//   for (const wo of workOrders) {
//     if (!wo.stockItemId) {
//       console.warn(`   ⚠️  WO ${wo.workOrderNumber} has no stockItemId — skipping`);
//       continue;
//     }

//     // Fetch the corresponding StockItem
//     const stockItem = await StockItem.findById(wo.stockItemId)
//       .select("name operations").lean();

//     if (!stockItem || !stockItem.operations?.length) {
//       console.warn(`   ⚠️  WO ${wo.workOrderNumber} — StockItem not found or has no operations`);
//       continue;
//     }

//     // Build a map of operationType (normalized) → operationCode from StockItem
//     const stockOpMap = new Map();
//     for (const op of stockItem.operations) {
//       const key = (op.type || "").trim().toLowerCase().replace(/\s+/g, " ");
//       if (key && op.operationCode) {
//         stockOpMap.set(key, op.operationCode);
//       }
//     }

//     let woModified = false;
//     const updatedOps = wo.operations.map(op => {
//       // Skip if operationCode already filled


//       const key = (op.operationType || "").trim().toLowerCase().replace(/\s+/g, " ");
//       const matchedCode = stockOpMap.get(key);

//       if (matchedCode) {
//         totalPatched++;
//         woModified = true;
//         console.log(`     ✓ WO ${wo.workOrderNumber} — "${op.operationType}" → ${matchedCode}`);
//         return { ...op, operationCode: matchedCode };
//       } else {
//         totalNoMatch++;
//         console.warn(`     ⚠️  WO ${wo.workOrderNumber} — no match for "${op.operationType}" in StockItem "${stockItem.name}"`);
//         return op;
//       }
//     });

//     if (woModified) {
//       await WorkOrder.updateOne(
//         { _id: wo._id },
//         { $set: { operations: updatedOps } }
//       );
//       totalWOsUpdated++;
//     }
//   }

//   await flagsCol.insertOne({
//     key: flagKey,
//     ranAt: new Date(),
//     stats: {
//       workOrdersProcessed: workOrders.length,
//       workOrdersUpdated: totalWOsUpdated,
//       operationsPatched: totalPatched,
//       operationsNoMatch: totalNoMatch,
//     }
//   });

//   console.log(`✅ WorkOrder operationCode backfill complete — ${totalWOsUpdated} WOs updated, ${totalPatched} operations patched, ${totalNoMatch} had no match`);
// };

const createDefaultAccountant = async () => {
  try {
    const existingAccountant = await AccountantDepartment.findOne({
      role: "accountant",
      department: "Accounting",
    });

    if (existingAccountant) {
      console.log("✅ Accountant already exists, skipping creation");
      return;
    }

    const defaultAccountant = new AccountantDepartment({
      name: "Accountant Admin",
      email: "accountant@grav.in",
      password: "Account@12345",
      employeeId: "ACC001",
      phone: "9999999999",
      department: "Accounting",
      role: "accountant",
      isActive: true,
    });

    await defaultAccountant.save();
    console.log("✅ Default Accountant created successfully");
  } catch (error) {
    console.error("❌ Accountant creation failed:", error.message);
  }
};

const StockItem = require("./models/CMS_Models/Inventory/Products/StockItem.js");

const assignMeasurementsToExistingProducts = async () => {
  try {
    console.log("🔄 Starting automatic measurement assignment to existing products (FORCE OVERRIDE)...");

    const StockItem = require("./models/CMS_Models/Inventory/Products/StockItem.js");

    const CATEGORY_MEASUREMENTS = {
      Shirts: [
        "Length", "Chest", "Stomach", "Bottom hem",
        "Shoulder", "Sleeve Length", "Cuff", "Coller",
      ],
      Bottoms: [
        "Length", "Waist", "Sheet", "Thigh", "Knee", "Buttom", "Crouch Kista Cut",
      ],
      Outerwear: [
        "Length", "Chest", "Stomach", "Buttom hem",
        "Shoulder"
      ],
    };

    let totalUpdated = 0;

    for (const [category, measurements] of Object.entries(CATEGORY_MEASUREMENTS)) {
      const result = await StockItem.updateMany(
        { category },
        { $set: { measurements, updatedAt: new Date() } },
      );
      if (result.modifiedCount > 0 || result.matchedCount > 0) {
        console.log(
          `✅ ${category}: Updated ${result.modifiedCount} products (matched: ${result.matchedCount}) with ${measurements.length} measurements`,
        );
        totalUpdated += result.modifiedCount;
      } else {
        console.log(
          `ℹ️ ${category}: No products found in this category`,
        );
      }
    }

    console.log(
      `✅ Measurement force override complete! Total products updated: ${totalUpdated}`,
    );

    // Create default HR
    const existingHR = await HRDepartment.findOne({
      role: "hr_manager",
      department: "Human Resources",
    });

    if (!existingHR) {
      const defaultHR = new HRDepartment({
        name: "HR Admin",
        email: "hr@grav.in",
        password: "Hr@12345",
        employeeId: "HR001",
        phone: "9999999999",
        department: "Human Resources",
        role: "hr_manager",
        isActive: true,
      });

      await defaultHR.save();
      console.log("✅ Default HR Department created successfully");
    }
  } catch (error) {
    console.error(
      "❌ Error assigning measurements to existing products:",
      error.message,
    );
  }
};

/* =====================
    Normal Employees ROUTES
  ===================== */
const authRoutes = require("./routes/login");
const employeeRoutes = require("./routes/HrRoutes/Employee-Section");

const hrProfileRoutes = require("./routes/HrRoutes/HrProfile-Section");
app.use("/api/hr", hrProfileRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/employees", employeeRoutes);

/* =====================
    Customer ROUTES
  ===================== */
const customerRoutes = require("./routes/Customer_Routes/auth");
app.use("/api/customer", customerRoutes);

const customerRequestsRoutes = require("./routes/Customer_Routes/CustomerRequests.js");
app.use("/api/customer/requests", customerRequestsRoutes);

const customerProfileRoutes = require("./routes/Customer_Routes/Profile.js");
app.use("/api/customer/profile", customerProfileRoutes);

const customerStockItemsRoutes = require("./routes/Customer_Routes/StockItems");
app.use("/api/customer/stock-items", customerStockItemsRoutes);

const customerEditRequestRoutes = require("./routes/Customer_Routes/EditRequests.js");
app.use("/api/customer/edit-requests", customerEditRequestRoutes);

const customerQuotationRoutes = require("./routes/Customer_Routes/QuotationRoutes");
app.use("/api/customer", customerQuotationRoutes);

const employeeMpcRoutes = require("./routes/Customer_Routes/Employee_Mpc");
app.use("/api/customer/employees", employeeMpcRoutes);

const productOperations = require("./routes/CMS_Routes/Inventory/Configurations/operations.js");
app.use("/api/cms", productOperations);

/* ===================
  CMS ROUTES
===================== */
const unitsRoutes = require("./routes/CMS_Routes/Inventory/Configurations/units");
app.use("/api/cms/units", unitsRoutes);

const operatorsRoutes = require("./routes/CMS_Routes/Inventory/Configurations/operators");
app.use("/api/cms/employees/operators", operatorsRoutes);

const machinesRoutes = require("./routes/CMS_Routes/Inventory/Configurations/machines");
app.use("/api/cms/machines", machinesRoutes);

const warehousesRoutes = require("./routes/CMS_Routes/Inventory/Configurations/warehouses");
app.use("/api/cms/warehouses", warehousesRoutes);

const vendorRoutes = require("./routes/CMS_Routes/Inventory/Vendor-Buyer/vendor");
app.use("/api/cms/vendors", vendorRoutes);

const rawItemsRoutes = require("./routes/CMS_Routes/Inventory/Products/rawItems");
app.use("/api/cms/raw-items", rawItemsRoutes);

const stockItemsRoutes = require("./routes/CMS_Routes/Inventory/Products/stockItems.js");
app.use("/api/cms/stock-items", stockItemsRoutes);

const purchaseOrderRoutes = require("./routes/CMS_Routes/Inventory/Operations/purchaseOrders");
app.use("/api/cms/inventory/operations/purchase-orders", purchaseOrderRoutes);

const deliveryRoutes = require("./routes/CMS_Routes/Inventory/Operations/deliveries");
app.use("/api/cms/inventory/operations/deliveries", deliveryRoutes);

const overviewRoutes = require("./routes/CMS_Routes/Inventory/overview/overview");
app.use("/api/cms/inventory/overview", overviewRoutes);

const RegisteredDepartments = require("./routes/CMS_Routes/Sales/Configuration/OrganizationDepartment/organizationDepartmentRoutes");
app.use("/api/cms/configuration/organization-departments", RegisteredDepartments);

const measurementRoutes = require("./routes/CMS_Routes/Measurement/measurementRoutes");
app.use("/api/cms/measurements", measurementRoutes);

const manufacturingOrderRoutes = require("./routes/CMS_Routes/Manufacturing/Manufacturing-Order/manufacturingOrderRoutes");
app.use("/api/cms/manufacturing/manufacturing-orders", manufacturingOrderRoutes);

const workOrderRoutes = require("./routes/CMS_Routes/Manufacturing/WorkOrder/workOrderRoutes");
app.use("/api/cms/manufacturing/work-orders", workOrderRoutes);

const BarcodeRoutes = require("./routes/CMS_Routes/Manufacturing/WorkOrder/barcodeRoutes.js");
app.use("/api/cms/manufacturing/barcode", BarcodeRoutes);

const ProductionTrackingBarcode = require("./routes/Barcode_Scan_Punchings/trackingRoutes.js");
app.use("/api/cms/production/barcode_punchings", ProductionTrackingBarcode);

const workOrderProgressRoutes = require("./routes/CMS_Routes/Manufacturing/WorkOrder/workOrderProgressRoutes");
app.use("/api/cms/manufacturing/work-orders/production-tracking", workOrderProgressRoutes);

const workOrderTimeline = require("./routes/CMS_Routes/Manufacturing/WorkOrder/workOrderTimeline");
app.use("/api/cms/manufacturing/work-orders/progress", workOrderTimeline);

const productionDashboardRoutes = require("./routes/CMS_Routes/Production/Dashboard/productionDashboardRoutes");
app.use("/api/cms/production/dashboard", productionDashboardRoutes);

const productionMachineLayout = require("./routes/CMS_Routes/Production/Dashboard/canvasLayoutRoutes.js");
app.use("/api/cms/production/canvas-layout", productionMachineLayout);

const workFlowTrackRoutes = require("./routes/CMS_Routes/Manufacturing/Production/workFlowTrackRoutes.js");
app.use("/api/cms/manufacturing/production-tracking", workFlowTrackRoutes);

const ProductionSchedule = require("./routes/CMS_Routes/Production/ProductionSchedule/productionScheduleRoutes.js");
app.use("/api/cms/manufacturing/production-schedule", ProductionSchedule);

const employeeTrackingRoutes = require("./routes/CMS_Routes/Manufacturing/Manufacturing-Order/employeeTrackingRoutes.js");
app.use("/api/cms/manufacturing/employee-tracking", employeeTrackingRoutes);

const dispatchRoutes = require("./routes/CMS_Routes/Manufacturing/Manufacturing-Order/dispatchRoutes.js");
app.use("/api/cms/manufacturing/dispatch", dispatchRoutes);

const markAsDoneRoutes = require("./routes/CMS_Routes/Manufacturing/Manufacturing-Order/markAsDoneRoutes");
app.use("/api/cms/manufacturing/mark-as-done", markAsDoneRoutes);

const salesRoutes = require("./routes/CMS_Routes/Sales/customerRequests");
app.use("/api/cms/sales", salesRoutes);

const salesOverview = require("./routes/CMS_Routes/Sales/dashboard");
app.use("/api/cms/sales/overview", salesOverview);

const quotationRoutes = require("./routes/CMS_Routes/Sales/quotationRoutes");
app.use("/api/cms/sales", quotationRoutes);

// ─── GOOGLE WORKSPACE ROUTES ────────────────────────────────
const googleWorkspaceRoutes = require("./routes/googleWorkspaceRoutes");
app.use("/api/google", googleWorkspaceRoutes);

const hrDepartmentRoutes = require("./routes/HrRoutes/Departments");
app.use("/api/hr/departments", hrDepartmentRoutes);

const jobPostingsRouter = require("./routes/HrRoutes/JobPosting_Section");
app.use("/api/hr/job-postings", jobPostingsRouter);

const CandidatesRouter = require("./routes/HrRoutes/Candidates_section");
app.use("/api/hr/candidates", CandidatesRouter);

const employeeTasksRouter = require("./routes/HrRoutes/EmployeeTasks_section");
app.use("/api/hr/tasks", employeeTasksRouter);

const vendorDetailsRoutes = require("./routes/Vendor_Routes/vendorRoutes");
app.use("/api/hr/vendors", vendorDetailsRoutes);

const payrollRoutes = require("./routes/HrRoutes/Payroll_section");
app.use("/api/hr/payroll", payrollRoutes);

const attendanceRoutes = require("./routes/HrRoutes/Attendance_section");
app.use("/api/hr/attendance", attendanceRoutes);

const passwordMgmt = require("./routes/HrRoutes/Passwordmanagement.js");
app.use("/api/hr/password-management", passwordMgmt);

const accountantCustomersRoutes = require("./routes/Accountant_Routes/customersRoutes");
app.use("/api/accountant/customers", accountantCustomersRoutes);

const accountantVendorRoutes = require("./routes/Accountant_Routes/vendors");
app.use("/api/accountant/vendors", accountantVendorRoutes);

const vendorProfileRoutes = require("./routes/Vendor_Routes/profile.js");
app.use("/api/vendor/profile", vendorProfileRoutes);

const vendorEmployees = require("./routes/Vendor_Routes/Partneremployees.js");
app.use("/api/vendor/partner-employees", vendorEmployees);

const vendorWO = require("./routes/Vendor_Routes/vendorWorkOrderRoutes.js");
app.use("/api/vendor/work-orders", vendorWO);

const employeeLoginRoutes = require("./routes/Employee_Routes/login.js");
app.use("/api/employee/auth", employeeLoginRoutes);

const employeeAuthRoutes = require("./routes/Employee_Routes/employeeAuth");
app.use("/api/employee", employeeAuthRoutes);

const TasksEmployee = require("./routes/Employee_Routes/TasksEmployee");
app.use("/api/employee/tasks", TasksEmployee);

const cuttingMasterRoutes = require("./routes/CMS_Routes/Manufacturing/CuttingMaster/cuttingMasterRoutes");
app.use("/api/cms/manufacturing/cutting-master", cuttingMasterRoutes);

const patternGradingRoutes = require("./routes/CMS_Routes/Manufacturing/CuttingMaster/patternGradingRoutes");
app.use("/api/cms/manufacturing/cutting-master", patternGradingRoutes);

const CuttingmeasurementRoutes = require("./routes/CMS_Routes/Manufacturing/CuttingMaster/measurementRoutes");
app.use("/api/cms/manufacturing/cutting-master", CuttingmeasurementRoutes);

const bulkCuttingRoutes = require("./routes/CMS_Routes/Manufacturing/CuttingMaster/bulkCuttingRoutes.js");
app.use("/api/cms/manufacturing/cutting-master", bulkCuttingRoutes);

const vendorAuthRoutes = require("./routes/Vendor_Routes/vendorAuthRoutes");
app.use("/api/vendor", vendorAuthRoutes);

const barcodeScannerRoutes = require("./routes/Barcode_Scanner_Device/barcode-scanner-hardware-routes.js");
app.use("/api/barcode-devices", barcodeScannerRoutes);

// app.use("/cowork", require("./routes/task_routes/taskForward.js"));
// // Media upload (images → Cloudinary, PDFs → Google Drive, voice → Cloudinary)
// app.use("/cowork", require("./routes/task_routes/mediaUpload.js"));


// // Enhanced: group/DM media messages, subtasks, task chat, deadline edit, delete
// app.use("/cowork", require("./routes/task_routes/coworkEnhanced.js"));

// //new tree substack routes
// app.use("/cowork", require("./routes/task_routes/taskTree.routes.js"));

// const coworkRoutes = require("./routes//task_routes/cowork");
// app.use("/cowork", coworkRoutes);

const crossOrgRoutes = require('./routes/Customer_Routes/cross-org-assign.js');
app.use('/api/customer/employees/cross-org', crossOrgRoutes);

/* =====================================================================
   INLINE: Barcode Scanner Tracking Routes
   Base URL: /api/cms/production/tracking
   Used by ESP32 firmware — keep socket.io wired up here directly.
   ===================================================================== */

const ProductionTracking = require("./models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking");
const Employee = require("./models/Employee");
const Machine = require("./models/CMS_Models/Inventory/Configurations/Machine");
const WorkOrder = require("./models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const Operation = require("./models/CMS_Models/Inventory/Configurations/Operation");

// ── Helpers ──────────────────────────────────────────────────────────────────

const isBarcodeId = (id) => id && typeof id === "string" && id.startsWith("WO-");
const isEmployeeId = (id) => id && typeof id === "string" && id.startsWith("GR");

const parseBarcode = (barcodeId) => {
  try {
    const parts = barcodeId.split("-");
    if (parts.length >= 3 && parts[0] === "WO") {
      return {
        success: true,
        workOrderShortId: parts[1],
        unitNumber: parseInt(parts[2]),
        operationNumber: parts[3] ? parseInt(parts[3]) : null,
      };
    }
    return { success: false, error: "Invalid barcode format" };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

const findWorkOrderByShortId = async (shortId) => {
  try {
    const workOrders = await WorkOrder.find({});
    return workOrders.find((wo) => wo._id.toString().slice(-8) === shortId);
  } catch {
    return null;
  }
};

const extractEmployeeIdFromUrl = (value) => {
  try {
    if (!value || typeof value !== "string") return value;
    const trimmed = value.trim();
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      const url = new URL(trimmed);
      const parts = url.pathname.split("/").filter(Boolean);
      return parts[parts.length - 1] || value;
    }
    return value;
  } catch {
    return value;
  }
};


app.post("/api/cms/production/tracking/scan", async (req, res) => {
  try {
    const { scanId: rawScanId, machineId, timeStamp, activeOps = "" } = req.body;
    const scanId = extractEmployeeIdFromUrl(rawScanId);

    if (!scanId || !machineId || !timeStamp) {
      return res.status(400).json({ success: false, message: "scanId, machineId, and timeStamp are required" });
    }

    const scanTime = new Date(timeStamp);
    if (isNaN(scanTime.getTime())) {
      return res.status(400).json({ success: false, message: "Invalid timeStamp format" });
    }

    const scanDate = new Date(scanTime);
    scanDate.setHours(0, 0, 0, 0);

    let trackingDoc = await ProductionTracking.findOne({ date: scanDate });
    if (!trackingDoc) {
      trackingDoc = new ProductionTracking({ date: scanDate, machines: [] });
    }

    const machine = await Machine.findById(machineId);
    if (!machine) {
      return res.status(400).json({ success: false, message: "Machine not found" });
    }

    let machineTracking = trackingDoc.machines.find(
      (m) => m.machineId.toString() === machineId,
    );
    if (!machineTracking) {
      trackingDoc.machines.push({ machineId, currentOperatorIdentityId: null, operators: [] });
      machineTracking = trackingDoc.machines[trackingDoc.machines.length - 1];
    }

    // ── BARCODE SCAN ──────────────────────────────────────────────────────────
    if (isBarcodeId(scanId)) {
      if (!machineTracking.currentOperatorIdentityId) {
        return res.status(400).json({
          success: false,
          message: "No operator is signed in on this machine",
          action: "error",
        });
      }

      const operatorTracking = machineTracking.operators.find(
        (op) => op.operatorIdentityId === machineTracking.currentOperatorIdentityId && !op.signOutTime,
      );
      if (!operatorTracking) {
        return res.status(400).json({ success: false, message: "Operator session not found" });
      }

      // Store scan with active operations snapshot
      operatorTracking.barcodeScans.push({
        barcodeId: scanId,
        timeStamp: scanTime,
        activeOps: activeOps || "",
      });
      await trackingDoc.save();

      const employeeName = operatorTracking.operatorName || "Unknown";
      const scanCount = operatorTracking.barcodeScans.length;

      // WebSocket events
      try {
        const parsedBarcode = parseBarcode(scanId);
        if (parsedBarcode.success && io) {
          let workOrder = await findWorkOrderByShortId(parsedBarcode.workOrderShortId);
          if (!workOrder) {
            try { workOrder = await WorkOrder.findById(parsedBarcode.workOrderShortId); } catch { }
          }
          if (workOrder) {
            io.to(`workorder-${workOrder._id}`).emit("workorder-scan-update", {
              workOrderId: workOrder._id,
              workOrderNumber: workOrder.workOrderNumber,
              barcodeId: scanId,
              unitNumber: parsedBarcode.unitNumber,
              operationNumber: parsedBarcode.operationNumber,
              machineId,
              machineName: machine.name,
              timestamp: scanTime,
              employeeName,
              activeOps: activeOps || "",
              type: "scan",
              scanCount,
            });
          }
          io.emit("tracking-data-updated", {
            date: scanDate,
            timestamp: new Date(),
            message: "New scan recorded",
            workOrderId: workOrder?._id,
            unitNumber: parsedBarcode.unitNumber,
            activeOps: activeOps || "",
          });
        }
      } catch (wsError) {
        console.error("Error emitting WebSocket event:", wsError);
      }

      return res.json({
        success: true,
        message: "Barcode scanned",
        employeeName,
        scanCount,
        barcodeData: { barcodeId: scanId, activeOps: activeOps || "" },
      });
    }

    // ── EMPLOYEE SIGN IN / OUT ────────────────────────────────────────────────
    if (isEmployeeId(scanId)) {
      const operator = await Employee.findOne({
        identityId: scanId,
        status: "active",
      }).select("firstName lastName identityId");

      if (!operator) {
        return res.status(400).json({
          success: false,
          message: `Employee with identityId ${scanId} not found`,
        });
      }

      const employeeName = `${operator.firstName || ""} ${operator.lastName || ""}`.trim();

      // Sign out from any other machine
      for (const m of trackingDoc.machines) {
        if (
          m.currentOperatorIdentityId === scanId &&
          m.machineId.toString() !== machineId.toString()
        ) {
          const existingSession = m.operators.find(
            (op) => op.operatorIdentityId === scanId && !op.signOutTime,
          );
          if (existingSession) existingSession.signOutTime = scanTime;
          m.currentOperatorIdentityId = null;
        }
      }

      // Same operator already on this machine → sign out
      if (machineTracking.currentOperatorIdentityId === scanId) {
        const session = machineTracking.operators.find(
          (op) => op.operatorIdentityId === scanId && !op.signOutTime,
        );
        if (session) {
          session.signOutTime = scanTime;
          machineTracking.currentOperatorIdentityId = null;
          await trackingDoc.save();
          try {
            if (io) io.emit("operator-status-update", {
              machineId, machineName: machine.name, employeeName,
              message: `${employeeName} signed out`, timestamp: new Date(),
            });
          } catch { }
          return res.json({
            success: true,
            message: `${employeeName} signed out`,
            employeeName,
            employeeId: scanId,
            action: "signout",
            scanCount: 0,
          });
        }
        return res.status(400).json({ success: false, message: "Operator session not found" });
      }

      // Different operator signed in → sign out existing, sign in new
      if (machineTracking.currentOperatorIdentityId) {
        const existingSession = machineTracking.operators.find(
          (op) => op.operatorIdentityId === machineTracking.currentOperatorIdentityId && !op.signOutTime,
        );
        if (existingSession) existingSession.signOutTime = scanTime;
      }

      machineTracking.operators.push({
        operatorIdentityId: scanId,
        operatorName: employeeName,
        signInTime: scanTime,
        signOutTime: null,
        barcodeScans: [],
      });
      machineTracking.currentOperatorIdentityId = scanId;
      await trackingDoc.save();

      try {
        if (io) io.emit("operator-status-update", {
          machineId, machineName: machine.name, employeeName,
          status: `${employeeName} signed in to ${machine.name}`, timestamp: new Date(),
        });
      } catch { }

      return res.json({
        success: true,
        message: `${employeeName} signed in`,
        employeeName,
        employeeId: scanId,
        action: "signin",
        scanCount: 0,
      });
    }

    return res.status(400).json({ success: false, message: "Invalid scan ID format" });

  } catch (error) {
    console.error("Error processing scan:", error);
    res.status(500).json({ success: false, message: "Server error while processing scan", error: error.message });
  }
});

// ── POST /api/cms/production/tracking/bulk-scans ──────────────────────────────

app.post("/api/cms/production/tracking/bulk-scans", async (req, res) => {
  try {
    const { scans } = req.body;
    if (!scans || !Array.isArray(scans) || scans.length === 0) {
      return res.status(400).json({ success: false, message: "Scans array is required" });
    }

    const results = { total: scans.length, successful: 0, failed: 0, errors: [] };
    const scansByDate = {};

    for (const scanData of scans) {
      const { scanId, machineId, timeStamp } = scanData;
      if (!scanId || !machineId || !timeStamp) {
        results.failed++;
        results.errors.push({ scanId, error: "Missing required fields" });
        continue;
      }
      const scanTime = new Date(timeStamp);
      if (isNaN(scanTime.getTime())) {
        results.failed++;
        results.errors.push({ scanId, error: "Invalid timestamp" });
        continue;
      }
      const scanDate = new Date(scanTime);
      scanDate.setHours(0, 0, 0, 0);
      const dateKey = scanDate.toISOString();
      if (!scansByDate[dateKey]) scansByDate[dateKey] = { date: scanDate, machines: {} };
      if (!scansByDate[dateKey].machines[machineId]) scansByDate[dateKey].machines[machineId] = { machineId, scans: [] };
      scansByDate[dateKey].machines[machineId].scans.push({ ...scanData, timeStamp: scanTime });
    }

    for (const dateKey in scansByDate) {
      const dateGroup = scansByDate[dateKey];
      let trackingDoc = await ProductionTracking.findOne({ date: dateGroup.date });
      if (!trackingDoc) trackingDoc = new ProductionTracking({ date: dateGroup.date, machines: [] });

      for (const machineId in dateGroup.machines) {
        const machineData = dateGroup.machines[machineId];
        const machine = await Machine.findById(machineId);
        if (!machine) {
          results.failed += machineData.scans.length;
          results.errors.push({ machineId, error: "Machine not found" });
          continue;
        }

        let machineTracking = trackingDoc.machines.find(
          (m) => m.machineId && m.machineId.toString() === machineId,
        );
        if (!machineTracking) {
          trackingDoc.machines.push({ machineId, currentOperatorIdentityId: null, operators: [] });
          machineTracking = trackingDoc.machines[trackingDoc.machines.length - 1];
        }

        for (const scan of machineData.scans) {
          try {
            if (scan.isEmployeeScan) {
              const { employeeName, employeeId, action } = scan;
              if (action === "signout") {
                const session = machineTracking.operators.find(
                  (op) => op.operatorIdentityId === (employeeId || scan.scanId) && !op.signOutTime,
                );
                if (session) {
                  session.signOutTime = scan.timeStamp;
                  machineTracking.currentOperatorIdentityId = null;
                }
              } else {
                if (machineTracking.currentOperatorIdentityId) {
                  const existing = machineTracking.operators.find(
                    (op) => op.operatorIdentityId === machineTracking.currentOperatorIdentityId && !op.signOutTime,
                  );
                  if (existing) existing.signOutTime = scan.timeStamp;
                }
                machineTracking.operators.push({
                  operatorIdentityId: employeeId || scan.scanId,
                  operatorName: employeeName || "",
                  signInTime: scan.timeStamp,
                  signOutTime: null,
                  barcodeScans: [],
                });
                machineTracking.currentOperatorIdentityId = employeeId || scan.scanId;
              }
            } else {
              // Barcode scan — store with activeOps snapshot
              if (!machineTracking.currentOperatorIdentityId) throw new Error("No operator signed in");
              const operatorSession = machineTracking.operators.find(
                (op) => op.operatorIdentityId === machineTracking.currentOperatorIdentityId && !op.signOutTime,
              );
              if (!operatorSession) throw new Error("Operator session not found");
              operatorSession.barcodeScans.push({
                barcodeId: scan.scanId,
                timeStamp: scan.timeStamp,
                activeOps: scan.activeOps || "",
              });
            }
            results.successful++;
          } catch (scanError) {
            results.failed++;
            results.errors.push({ scanId: scan.scanId, error: scanError.message });
          }
        }
      }
      await trackingDoc.save();
    }

    return res.status(200).json({
      success: true,
      message: `Processed ${results.successful} of ${results.total} scans`,
      results,
    });
  } catch (error) {
    console.error("Bulk scan error:", error);
    res.status(500).json({ success: false, message: "Server error processing bulk scans", error: error.message });
  }
});

// ── GET /api/cms/production/tracking/status/today ─────────────────────────────

app.get("/api/cms/production/tracking/status/today", async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const trackingDoc = await ProductionTracking.findOne({ date: today })
      .populate("machines.machineId", "name serialNumber type")
      .lean();

    if (!trackingDoc) {
      return res.json({ success: true, message: "No tracking data for today", date: today, machines: [], totalScans: 0, totalMachines: 0 });
    }

    let totalScans = 0;
    const machinesStatus = [];

    for (const machine of trackingDoc.machines) {
      let machineScans = 0;
      const operatorsWithDetails = [];

      for (const operator of machine.operators) {
        const employeeDoc = await Employee.findOne({ identityId: operator.operatorIdentityId })
          .select("firstName lastName identityId");
        machineScans += operator.barcodeScans.length;
        totalScans += operator.barcodeScans.length;
        operatorsWithDetails.push({
          identityId: operator.operatorIdentityId,
          name: employeeDoc ? `${employeeDoc.firstName} ${employeeDoc.lastName}` : "Unknown Operator",
          signInTime: operator.signInTime,
          signOutTime: operator.signOutTime,
          barcodeScans: operator.barcodeScans.map((s) => ({ barcodeId: s.barcodeId, timeStamp: s.timeStamp, activeOps: s.activeOps || "" })),
          scanCount: operator.barcodeScans.length,
          isActive: !operator.signOutTime,
        });
      }

      let currentOperator = null;
      if (machine.currentOperatorIdentityId) {
        const empDoc = await Employee.findOne({ identityId: machine.currentOperatorIdentityId }).select("firstName lastName identityId");
        currentOperator = empDoc
          ? { identityId: empDoc.identityId, name: `${empDoc.firstName} ${empDoc.lastName}` }
          : { identityId: machine.currentOperatorIdentityId, name: "Unknown Operator" };
      }

      machinesStatus.push({
        machineId: machine.machineId?._id,
        machineName: machine.machineId?.name || "Unknown Machine",
        machineSerial: machine.machineId?.serialNumber || "Unknown",
        currentOperator,
        operators: operatorsWithDetails,
        machineScans,
      });
    }

    res.json({ success: true, date: trackingDoc.date, totalMachines: trackingDoc.machines.length, totalScans, machines: machinesStatus });
  } catch (error) {
    console.error("Error getting today's status:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

// ── GET /api/cms/production/tracking/status/:date ─────────────────────────────

app.get("/api/cms/production/tracking/status/:date", async (req, res) => {
  try {
    const { date } = req.params;
    const queryDate = new Date(date);
    queryDate.setHours(0, 0, 0, 0);

    const trackingDoc = await ProductionTracking.findOne({ date: queryDate })
      .populate("machines.machineId", "name serialNumber type")
      .lean();

    if (!trackingDoc) {
      return res.json({ success: true, message: `No tracking data for ${date}`, date: queryDate, machines: [], totalScans: 0, totalMachines: 0 });
    }

    let totalScans = 0;
    const machinesStatus = [];

    for (const machine of trackingDoc.machines) {
      let machineScans = 0;
      const operatorsWithDetails = [];

      for (const operator of machine.operators) {
        const employeeDoc = await Employee.findOne({ identityId: operator.operatorIdentityId })
          .select("firstName lastName identityId");
        machineScans += operator.barcodeScans.length;
        totalScans += operator.barcodeScans.length;
        operatorsWithDetails.push({
          identityId: operator.operatorIdentityId,
          name: employeeDoc ? `${employeeDoc.firstName} ${employeeDoc.lastName}` : "Unknown Operator",
          signInTime: operator.signInTime,
          signOutTime: operator.signOutTime,
          barcodeScans: operator.barcodeScans.map((s) => ({ barcodeId: s.barcodeId, timeStamp: s.timeStamp, activeOps: s.activeOps || "" })),
          scanCount: operator.barcodeScans.length,
          isActive: !operator.signOutTime,
        });
      }

      let currentOperator = null;
      if (machine.currentOperatorIdentityId) {
        const empDoc = await Employee.findOne({ identityId: machine.currentOperatorIdentityId }).select("firstName lastName identityId");
        currentOperator = empDoc
          ? { identityId: empDoc.identityId, name: `${empDoc.firstName} ${empDoc.lastName}` }
          : { identityId: machine.currentOperatorIdentityId, name: "Unknown Operator" };
      }

      machinesStatus.push({
        machineId: machine.machineId?._id,
        machineName: machine.machineId?.name || "Unknown Machine",
        machineSerial: machine.machineId?.serialNumber || "Unknown",
        currentOperator,
        operators: operatorsWithDetails,
        machineScans,
      });
    }

    res.json({ success: true, date: trackingDoc.date, totalMachines: trackingDoc.machines.length, totalScans, machines: machinesStatus });
  } catch (error) {
    console.error("Error getting date status:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

/* =====================
    HEALTH CHECK
  ===================== */
app.get("/api/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Backend server is running 🚀",
    database: mongoose.connection.readyState === 1 ? "Connected" : "Disconnected",
    productionSync: {
      enabled: true,
      syncInterval: "Every 20 minutes",
      cleanupSchedule: "Daily at 2 AM",
    },
    timestamp: new Date().toISOString(),
  });
});

// Simple health check for socket
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    socket: "running",
    connections: io.engine.clientsCount
  });
});

/* =====================
    DEFAULT ROUTE
  ===================== */
app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Welcome to GRAV Clothing Backend API",
    version: "1.0.0",
    departments: ["HR", "Project Management", "Sales"],
    socketio: "enabled",
  });
});

/* =====================
    PRODUCTION SYNC MANAGEMENT ROUTES
  ===================== */
app.post("/api/cms/production/sync/manual", async (req, res) => {
  try {
    await productionSyncService.manualSync();
    res.json({ success: true, message: "Manual sync completed successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error during manual sync", error: error.message });
  }
});

app.post("/api/cms/production/cleanup/manual", async (req, res) => {
  try {
    await productionSyncService.manualCleanup();
    res.json({ success: true, message: "Manual cleanup completed successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error during manual cleanup", error: error.message });
  }
});

// Graceful shutdown
let isShuttingDown = false;

const gracefulShutdown = (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n🛑 ${signal} received, starting graceful shutdown...`);

  productionSyncService.stop();

  server.close(() => {
    console.log("✅ HTTP server closed");
    mongoose.connection.close(false, () => {
      console.log("✅ MongoDB connection closed");
      console.log("👋 Shutdown complete");
      process.exit(0);
    });
  });

  setTimeout(() => {
    console.error("⚠️  Forcing shutdown after timeout");
    process.exit(1);
  }, 10000);
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`✅ WebSocket server is ready`);
  console.log(`✅ Socket.IO connections available at ws://localhost:${PORT}`);
  console.log(`✅ Production sync service is active`);
});
