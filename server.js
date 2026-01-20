const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs"); // Add this
require("dotenv").config();

const app = express();

const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "https://grav-cms.vercel.app",
  "https://cms.grav.in",
  "https://customer.grav.in",
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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const connectDB = async () => {
  try {
    await mongoose.connect(
      process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing",
    );
    console.log("✅ MongoDB connected successfully");
    createDefaultHR();
  } catch (error) {
    console.error("❌ MongoDB connection error:", error.message);
    process.exit(1);
  }
};

connectDB();

const HRDepartment = require("./models/HRDepartment");

const createDefaultHR = async () => {
  try {
    const existingHR = await HRDepartment.findOne({
      role: "hr_manager",
      department: "Human Resources",
    });

    if (existingHR) {
      console.log("ℹ️ HR Department already exists");
      return;
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
    console.error("❌ Error creating default HR:", error.message);
  }
};

/* =====================
  Normal Employees ROUTES
===================== */
const authRoutes = require("./routes/login");
const employeeRoutes = require("./routes/HrRoutes/Employee-Section");

// HR Profile Routes
const hrProfileRoutes = require("./routes/HrRoutes/HrProfile-section");

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

/* =====================
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

// In your main server.js or app.js
const workFlowTrackRoutes = require("./routes/CMS_Routes/Manufacturing/Production/workFlowTrackRoutes.js");
app.use("/api/cms/manufacturing/production-tracking", workFlowTrackRoutes);

const ProductionSchedule = require("./routes/CMS_Routes/Production/ProductionSchedule/productionScheduleRoutes.js");
app.use("/api/cms/manufacturing/production-schedule", ProductionSchedule);

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

// In your server.js, add this after the other route imports:

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
