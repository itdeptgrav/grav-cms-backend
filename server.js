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
});

// WebSocket connection handling
io.on("connection", (socket) => {
  console.log("✅ New WebSocket client connected:", socket.id);

  socket.on("join-workorder", (workOrderId) => {
    socket.join(`workorder-${workOrderId}`);
    console.log(`Socket ${socket.id} joined room workorder-${workOrderId}`);
  });

  socket.on("leave-workorder", (workOrderId) => {
    socket.leave(`workorder-${workOrderId}`);
    console.log(`Socket ${socket.id} left room workorder-${workOrderId}`);
  });

  socket.on("disconnect", () => {
    console.log("❌ WebSocket client disconnected:", socket.id);
  });
});

// Make io accessible to routes
app.set("io", io);

const connectDB = async () => {
  try {
    await mongoose.connect(
      process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing",
    );
    console.log("✅ MongoDB connected successfully");

    // INITIALIZE PRODUCTION SYNC SERVICE AFTER DB CONNECTION
    productionSyncService.initialize();
  } catch (error) {
    console.error("❌ MongoDB connection error:", error.message);
    process.exit(1);
  }
};

connectDB().then(async () => {
  await createDefaultCuttingMaster();
});

const CuttingMaster = require("./models/CuttingMasterDepartment");
const HRDepartment = require("./models/HRDepartment"); // make sure this exists in server.js also
const AccountantDepartment = require("./models/Accountant_model/AccountantDepartment.js"); // ✅ ADD THIS

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
      password: "Cut@12345", // will be hashed automatically
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
      password: "Account@12345", // will be hashed automatically
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

// Update the database connection section
connectDB().then(async () => {
  await createDefaultAccountant(); // ✅ ADD THIS
});
//changes

const StockItem = require("./models/CMS_Models/Inventory/Products/StockItem.js");

const CATEGORY_MEASUREMENTS = {
  Shirts: [
    "Length",
    "Chest",
    "Stomach",
    "Button Hem",
    "Shoulder",
    "Sleeve Length",
    "Cuff",
    "Coller",
  ],
  Outerwear: ["Length", "Chest", "Stomach", "Button Hem", "Shoulder"],
  Bottoms: [
    "Length",
    "Waist",
    "Sheet",
    "Thigh",
    "Knee",
    "Buttom",
    "Crouch Kista Cut",
  ],
};

const overwriteExistingMeasurements = async () => {
  try {
    const existingHR = await HRDepartment.findOne({
      role: "hr_manager",
      department: "Human Resources",
    });
    for (const [category, measurements] of Object.entries(
      CATEGORY_MEASUREMENTS,
    )) {
      const result = await StockItem.updateMany(
        { category },
        { $set: { measurements } },
      );

      console.log(`✅ ${category}: ${result.modifiedCount} documents updated`);
    }

    const defaultHR = new HRDepartment({
      name: "HR Admin",
      email: "hr@grav.in",
      password: "Hr@12345", // will be hashed automatically
      employeeId: "HR001",
      phone: "9999999999",
      department: "Human Resources",
      role: "hr_manager",
      isActive: true,
    });

    await defaultHR.save();

    console.log("✅ Default HR Department created successfully");
  } catch (error) {
    console.error("❌ Measurement overwrite failed:", error.message);
  }
};

/* =====================
    Normal Employees ROUTES
  ===================== */
const authRoutes = require("./routes/login");
const employeeRoutes = require("./routes/HrRoutes/Employee-Section");

// HR Profile Routes
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

// Add this to your server.js in the CMS ROUTES section
const customerStockItemsRoutes = require("./routes/Customer_Routes/StockItems");
app.use("/api/customer/stock-items", customerStockItemsRoutes);

const customerEditRequestRoutes = require("./routes/Customer_Routes/EditRequests.js");
app.use("/api/customer/edit-requests", customerEditRequestRoutes);

const customerQuotationRoutes = require("./routes/Customer_Routes/QuotationRoutes");
app.use("/api/customer", customerQuotationRoutes);

const employeeMpcRoutes = require("./routes/Customer_Routes/Employee_Mpc");
// Use the routes
app.use("/api/customer/employees", employeeMpcRoutes);

/* ===================
  CMS ROUTES
===================== */
// Inventory Routes
const unitsRoutes = require("./routes/CMS_Routes/Inventory/Configurations/units");
app.use("/api/cms/units", unitsRoutes);

const operatorsRoutes = require("./routes/CMS_Routes/Inventory/Configurations/operators");
app.use("/api/cms/employees/operators", operatorsRoutes);

const machinesRoutes = require("./routes/CMS_Routes/Inventory/Configurations/machines");
app.use("/api/cms/machines", machinesRoutes);

const warehousesRoutes = require("./routes/CMS_Routes/Inventory/Configurations/warehouses");
app.use("/api/cms/warehouses", warehousesRoutes);

// Vendor-Buyer Category
const vendorRoutes = require("./routes/CMS_Routes/Inventory/Vendor-Buyer/vendor");
app.use("/api/cms/vendors", vendorRoutes);

// Products Category
const rawItemsRoutes = require("./routes/CMS_Routes/Inventory/Products/rawItems");
app.use("/api/cms/raw-items", rawItemsRoutes);

const stockItemsRoutes = require("./routes/CMS_Routes/Inventory/Products/stockItems");
app.use("/api/cms/stock-items", stockItemsRoutes);

// Operations Category
const purchaseOrderRoutes = require("./routes/CMS_Routes/Inventory/Operations/purchaseOrders");
app.use("/api/cms/inventory/operations/purchase-orders", purchaseOrderRoutes);

const deliveryRoutes = require("./routes/CMS_Routes/Inventory/Operations/deliveries");
app.use("/api/cms/inventory/operations/deliveries", deliveryRoutes);

// Overview Section
const overviewRoutes = require("./routes/CMS_Routes/Inventory/overview/overview");
app.use("/api/cms/inventory/overview", overviewRoutes);

const RegisteredDepartments = require("./routes/CMS_Routes/Sales/Configuration/OrganizationDepartment/organizationDepartmentRoutes");
app.use(
  "/api/cms/configuration/organization-departments",
  RegisteredDepartments,
);

// Measurement Routes
const measurementRoutes = require("./routes/CMS_Routes/Measurement/measurementRoutes");
app.use("/api/cms/measurements", measurementRoutes);

// Manufacturing Routes
const manufacturingOrderRoutes = require("./routes/CMS_Routes/Manufacturing/Manufacturing-Order/manufacturingOrderRoutes");
app.use(
  "/api/cms/manufacturing/manufacturing-orders",
  manufacturingOrderRoutes,
);

const workOrderRoutes = require("./routes/CMS_Routes/Manufacturing/WorkOrder/workOrderRoutes");
app.use("/api/cms/manufacturing/work-orders", workOrderRoutes);

const BarcodeRoutes = require("./routes/CMS_Routes/Manufacturing/WorkOrder/barcodeRoutes.js");
app.use("/api/cms/manufacturing/barcode", BarcodeRoutes);

const ProductionTracking = require("./routes/CMS_Routes/Production/Tracking/trackingRoutes.js");
app.use("/api/cms/production/tracking", ProductionTracking);

// In your main server.js or app.js
const workOrderProgressRoutes = require("./routes/CMS_Routes/Manufacturing/WorkOrder/workOrderProgressRoutes");
app.use(
  "/api/cms/manufacturing/work-orders/production-tracking",
  workOrderProgressRoutes,
);

const workOrderTimeline = require("./routes/CMS_Routes/Manufacturing/WorkOrder/workOrderTimeline");
app.use("/api/cms/manufacturing/work-orders/progress", workOrderTimeline);

const productionDashboardRoutes = require("./routes/CMS_Routes/Production/Dashboard/productionDashboardRoutes");
app.use("/api/cms/production/dashboard", productionDashboardRoutes);

// In your main server.js or app.js
const workFlowTrackRoutes = require("./routes/CMS_Routes/Manufacturing/Production/workFlowTrackRoutes.js");
app.use("/api/cms/manufacturing/production-tracking", workFlowTrackRoutes);

const ProductionSchedule = require("./routes/CMS_Routes/Production/ProductionSchedule/productionScheduleRoutes.js");
app.use("/api/cms/manufacturing/production-schedule", ProductionSchedule);

const employeeTrackingRoutes = require("./routes/CMS_Routes/Manufacturing/Manufacturing-Order/employeeTrackingRoutes.js");
app.use("/api/cms/manufacturing/employee-tracking", employeeTrackingRoutes);

// Sales Routes
const salesRoutes = require("./routes/CMS_Routes/Sales/customerRequests");
app.use("/api/cms/sales", salesRoutes);

const salesOverview = require("./routes/CMS_Routes/Sales/dashboard");
app.use("/api/cms/sales/overview", salesOverview);

const quotationRoutes = require("./routes/CMS_Routes/Sales/quotationRoutes");
app.use("/api/cms/sales", quotationRoutes);

// HR Department Routes
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

// Accountant Department Routes
const accountantCustomersRoutes = require("./routes/Accountant_Routes/customersRoutes");
app.use("/api/accountant/customers", accountantCustomersRoutes);

// Accountant Vendor Routes
const accountantVendorRoutes = require("./routes/Accountant_Routes/vendors");
app.use("/api/accountant/vendors", accountantVendorRoutes);
const vendorProfileRoutes = require("./routes/Vendor_Routes/profile.js");
app.use("/api/vendor/profile", vendorProfileRoutes);

const vendorEmployees = require("./routes/Vendor_Routes/Partneremployees.js");
app.use("/api/vendor/partner-employees", vendorEmployees);

const vendorWO = require("./routes/Vendor_Routes/vendorWorkOrderRoutes.js");
app.use("/api/vendor/work-orders", vendorWO);

// Employee Routes
const employeeLoginRoutes = require("./routes/Employee_Routes/login.js");
app.use("/api/employee/auth", employeeLoginRoutes);

const employeeAuthRoutes = require("./routes/Employee_Routes/employeeAuth");
app.use("/api/employee", employeeAuthRoutes);

const TasksEmployee = require("./routes/Employee_Routes/TasksEmployee");
app.use("/api/employee/tasks", TasksEmployee);

// Import the cutting master routes
const cuttingMasterRoutes = require("./routes/CMS_Routes/Manufacturing/CuttingMaster/cuttingMasterRoutes");
app.use("/api/cms/manufacturing/cutting-master", cuttingMasterRoutes);

const patternGradingRoutes = require("./routes/CMS_Routes/Manufacturing/CuttingMaster/patternGradingRoutes");
app.use("/api/cms/manufacturing/cutting-master", patternGradingRoutes);

// Import measurement routes
const CuttingmeasurementRoutes = require("./routes/CMS_Routes/Manufacturing/CuttingMaster/measurementRoutes");
app.use("/api/cms/manufacturing/cutting-master", CuttingmeasurementRoutes);

// Import the bulk cutting routes
const bulkCuttingRoutes = require("./routes/CMS_Routes/Manufacturing/CuttingMaster/bulkCuttingRoutes.js");
// Merge the routers
app.use("/api/cms/manufacturing/cutting-master", bulkCuttingRoutes);

// Vendor Routes For Vendor Portal
const vendorAuthRoutes = require("./routes/Vendor_Routes/vendorAuthRoutes"); // NEW FILE
app.use("/api/vendor", vendorAuthRoutes);

/* =====================
    HEALTH CHECK
  ===================== */
app.get("/api/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Backend server is running 🚀",
    database:
      mongoose.connection.readyState === 1 ? "Connected" : "Disconnected",
    timestamp: new Date().toISOString(),
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
  });
});

/* =====================
    PRODUCTION SYNC MANAGEMENT ROUTES
  ===================== */
app.post("/api/cms/production/sync/manual", async (req, res) => {
  try {
    await productionSyncService.manualSync();
    res.json({
      success: true,
      message: "Manual sync completed successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error during manual sync",
      error: error.message,
    });
  }
});

app.post("/api/cms/production/cleanup/manual", async (req, res) => {
  try {
    await productionSyncService.manualCleanup();
    res.json({
      success: true,
      message: "Manual cleanup completed successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error during manual cleanup",
      error: error.message,
    });
  }
});

// Health check with sync service status
app.get("/api/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Backend server is running 🚀",
    database:
      mongoose.connection.readyState === 1 ? "Connected" : "Disconnected",
    productionSync: {
      enabled: true,
      syncInterval: "Every 20 minutes",
      cleanupSchedule: "Daily at 2 AM",
    },
    timestamp: new Date().toISOString(),
  });
});

// Graceful shutdown
let isShuttingDown = false;

const gracefulShutdown = (signal) => {
  if (isShuttingDown) return;

  isShuttingDown = true;
  console.log(`\n🛑 ${signal} received, starting graceful shutdown...`);

  // Stop production sync service
  productionSyncService.stop();

  // Close server
  server.close(() => {
    console.log("✅ HTTP server closed");

    // Close MongoDB connection
    mongoose.connection.close(false, () => {
      console.log("✅ MongoDB connection closed");
      console.log("👋 Shutdown complete");
      process.exit(0);
    });
  });

  // Force shutdown after 10 seconds
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
  console.log(`✅ Production sync service is active`);
});
