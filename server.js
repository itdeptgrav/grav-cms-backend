const dns = require("dns").setServers(["8.8.8.8", "8.8.4.4"]);
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");

const http = require("http");
const { Server } = require("socket.io");
const activeMeetingRecordings = new Map();
// IMPORT PRODUCTION SYNC SERVICE
const productionSyncService = require("./services/productionSyncService");

const app = express();

const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "https://grav-cms.vercel.app",
  "https://cms.grav.in",
  "https://cowork.grav.in",
  "https://customer.grav.in",
  "http://192.168.1.30:3000",
  "https://8ks0bflk-3000.inc1.devtunnels.ms",
  "http://10.99.21.15:3000",
  "https://8ks0bflk-5000.inc1.devtunnels.ms",
  "https://grav-cms-dncs.vercel.app",
  "https://crm.grav.in"
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
console.log("Drive key loaded:", !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
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

  // ── COWORKING SPACE: Meeting room (for audio recording signals) ───────────
  socket.on("join_meeting_room", (meetId) => {
    if (meetId) {
      socket.join(`meeting_${meetId}`);
      console.log(`Socket ${socket.id} joined meeting_${meetId}`);
      if (activeMeetingRecordings.has(meetId)) {
        const info = activeMeetingRecordings.get(meetId);
        socket.emit("recording_started", { meetId, startedBy: info.startedBy, startedByName: info.startedByName, startedAt: info.startedAt, lateJoin: true });
        console.log(`[Recording] Late joiner auto-notified for meeting_${meetId}`);
      }
    }
  });

  socket.on("leave_meeting_room", (meetId) => {
    if (meetId) {
      socket.leave(`meeting_${meetId}`);
    }
  });
  // CEO/TL starts recording → broadcast to all in meeting room
  socket.on("recording_start", ({ meetId, startedBy, startedByName }) => {
    if (!meetId) return;
    const startedAt = new Date().toISOString();
    activeMeetingRecordings.set(meetId, { startedBy, startedByName, startedAt });
    io.to(`meeting_${meetId}`).emit("recording_started", { meetId, startedBy, startedByName, startedAt });
  });

  // CEO/TL stops recording → broadcast to all in meeting room
  socket.on("recording_stop", ({ meetId, stoppedBy, stoppedByName }) => {
    if (!meetId) return;
    activeMeetingRecordings.delete(meetId);
    io.to(`meeting_${meetId}`).emit("recording_stopped", { meetId, stoppedBy, stoppedByName, stoppedAt: new Date().toISOString() });
  });

  // ── DM AUDIO CALLS ────────────────────────────────────────────────────
  // Legacy relay — old DMCallManager emits call_invite, relay as call_incoming to receiver
  socket.on("call_invite", ({ toEmployeeId, fromEmployeeId, fromName, convId }) => {
    if (!toEmployeeId || !fromEmployeeId) return;
    console.log(`[Call-legacy] ${fromEmployeeId} → ${toEmployeeId}`);
    io.to(String(toEmployeeId)).emit("call_incoming", { fromEmployeeId, fromName, convId });
  });

  // STEP 1 — Caller initiates: create LiveKit room + generate CALLER token
  // then ring the callee via socket
  socket.on("call_request", async ({ toEmployeeId, fromEmployeeId, fromName, convId }) => {
    if (!toEmployeeId || !fromEmployeeId || !convId) return;
    try {
      const { AccessToken, RoomServiceClient } = require("livekit-server-sdk");
      const LK_URL = process.env.LIVEKIT_URL || "";
      const LK_KEY = process.env.LIVEKIT_API_KEY || "";
      const LK_SECRET = process.env.LIVEKIT_API_SECRET || "";

      const roomName = `dm-call-${convId}`;
      const httpUrl = LK_URL.replace("wss://", "https://").replace("ws://", "http://");

      // Create the LiveKit room (ignore "already exists" error)
      try {
        const svc = new RoomServiceClient(httpUrl, LK_KEY, LK_SECRET);
        await svc.createRoom({ name: roomName, emptyTimeout: 120, maxParticipants: 2 });
      } catch (e) {
        if (!e.message?.includes("already exists")) console.warn("[call_request] createRoom:", e.message);
      }

      // Generate token for CALLER
      const callerAt = new AccessToken(LK_KEY, LK_SECRET, { identity: fromEmployeeId, name: fromName, ttl: "1h" });
      callerAt.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
      const callerToken = await callerAt.toJwt();

      // Send token directly back to caller's socket
      socket.emit("call_token_ready", { token: callerToken, url: LK_URL, roomName, convId });

      // Ring the callee
      console.log(`[Call] ${fromEmployeeId} → ${toEmployeeId} room=${roomName}`);
      io.to(String(toEmployeeId)).emit("call_incoming", { fromEmployeeId, fromName, convId, roomName });

    } catch (e) {
      console.error("[call_request] error:", e.message);
      socket.emit("call_error", { message: "Could not start call: " + e.message });
    }
  });

  // STEP 2 — Callee accepts: generate CALLEE token + notify caller
  socket.on("call_accept", async ({ toEmployeeId, fromEmployeeId, fromName, convId }) => {
    if (!toEmployeeId || !fromEmployeeId || !convId) return;
    try {
      const { AccessToken } = require("livekit-server-sdk");
      const LK_URL = process.env.LIVEKIT_URL || "";
      const LK_KEY = process.env.LIVEKIT_API_KEY || "";
      const LK_SECRET = process.env.LIVEKIT_API_SECRET || "";

      const roomName = `dm-call-${convId}`;

      // Generate token for CALLEE
      const calleeAt = new AccessToken(LK_KEY, LK_SECRET, { identity: fromEmployeeId, name: fromName, ttl: "1h" });
      calleeAt.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
      const calleeToken = await calleeAt.toJwt();

      // Send token to callee's socket
      socket.emit("call_token_ready", { token: calleeToken, url: LK_URL, roomName, convId });

      // Notify caller that call was answered
      io.to(String(toEmployeeId)).emit("call_answered", { fromEmployeeId, convId });

    } catch (e) {
      console.error("[call_accept] error:", e.message);
      socket.emit("call_error", { message: "Could not join call: " + e.message });
    }
  });

  // Callee rejects
  socket.on("call_reject", ({ toEmployeeId, fromEmployeeId, convId }) => {
    if (!toEmployeeId) return;
    io.to(String(toEmployeeId)).emit("call_rejected", { fromEmployeeId, convId });
  });

  // Either party ends the call
  socket.on("call_end", ({ toEmployeeId, fromEmployeeId, convId }) => {
    if (!toEmployeeId) return;
    io.to(String(toEmployeeId)).emit("call_ended", { fromEmployeeId, convId });
  });

  // Re-issue token if page reloaded mid-call (race condition recovery)
  socket.on("call_rejoin_token", async ({ employeeId, convId }) => {
    if (!employeeId || !convId) return;
    try {
      const { AccessToken } = require("livekit-server-sdk");
      const LK_URL = process.env.LIVEKIT_URL || "";
      const LK_KEY = process.env.LIVEKIT_API_KEY || "";
      const LK_SECRET = process.env.LIVEKIT_API_SECRET || "";
      const roomName = `dm-call-${convId}`;
      const at = new AccessToken(LK_KEY, LK_SECRET, { identity: employeeId, ttl: "1h" });
      at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
      const token = await at.toJwt();
      socket.emit("call_token_ready", { token, url: LK_URL, roomName, convId });
    } catch (e) {
      socket.emit("call_error", { message: "Could not rejoin: " + e.message });
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


// 1. At the top with your other requires:
const transcriptModule = require("./routes/task_routes/transcript.routes");

// 2. With your other app.use() route registrations:
app.use("/cowork", transcriptModule.router);


// ─── Database Connection ──────────────────────────────────────────────────────
const connectDB = async () => {
  try {
    await mongoose.connect(
      process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing",
    );
    console.log("✅ MongoDB connected successfully");

    // INITIALIZE PRODUCTION SYNC SERVICE AFTER DB CONNECTION
    // productionSyncService.initialize();
  } catch (error) {
    console.error("❌ MongoDB connection error:", error.message);
    process.exit(1);
  }
};

connectDB().then(async () => {
  await createDefaultCuttingMaster();
});

const CuttingMaster = require("./models/CuttingMasterDepartment");
const HRDepartment = require("./models/HRDepartment");
const AccountantDepartment = require("./models/Accountant_model/AccountantDepartment.js");

const PackagingDispatchDepartment = require("./models/PackagingDispatchDepartment");

const Measurement = require("./models/Customer_Models/Measurement");
const StockItemForVariant = require("./models/CMS_Models/Inventory/Products/StockItem");
const ProductionSupervisorDepartment = require("./models/ProductionSupervisorDepartment");


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

async function createDefaultProductionSupervisor() {
  try {
    const existing = await ProductionSupervisorDepartment.findOne({ email: "p1supervisor@grav.in" });
    if (existing) {
      console.log("✓ Default Production Supervisor already exists");
      return;
    }

    const hashed = await bcrypt.hash("P1supervisor@12345", 10);

    await ProductionSupervisorDepartment.create({
      name: "Production Supervisor",
      email: "p1supervisor@grav.in",
      password: hashed,                    // ✅ use the hashed value
      employeeId: "PSUP001",
      phone: "",
      role: "production_supervisor",
      department: "Production Supervisor",
      isActive: true,
    });

    console.log("✅ Default Production Supervisor created: p1supervisor@grav.in");
  } catch (err) {
    console.error("❌ Failed to create default Production Supervisor:", err);
  }
}

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

const createDefaultPackagingDispatch = async () => {
  try {
    const existingPackagingDispatch = await PackagingDispatchDepartment.findOne({
      role: "packaging_dispatch",
      department: "Packaging & Dispatch",
    });

    if (existingPackagingDispatch) {
      console.log("✅ Packaging & Dispatch user already exists, skipping creation");
      return;
    }

    const defaultPackagingDispatch = new PackagingDispatchDepartment({
      name: "Dispatch Admin",
      email: "dispatch@grav.in",
      password: "Dispatch@12345", // will be hashed automatically
      employeeId: "PKG001",
      phone: "9999999999",
      department: "Packaging & Dispatch",
      role: "packaging_dispatch",
      isActive: true,
    });

    await defaultPackagingDispatch.save();

    console.log("✅ Default Packaging & Dispatch user created successfully");
  } catch (error) {
    console.error("❌ Packaging & Dispatch creation failed:", error.message);
  }
};

// Update the database connection section
connectDB().then(async () => {
  await createDefaultAccountant(); // ✅ ADD THIS
  await createDefaultPackagingDispatch();
  await createDefaultProductionSupervisor();
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

const hrOverviewRoutes = require("./routes/HrRoutes/Overview-Section");
app.use("/api/hr/overview", hrOverviewRoutes);


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

const productOperations = require("./routes/CMS_Routes/Inventory/Configurations/operations.js");
app.use("/api/cms", productOperations);


const productionCompletionRoutes = require("./routes/CMS_Routes/Manufacturing/Production/productionCompletionRoutes.js");
app.use("/api/cms/manufacturing/production-completion", productionCompletionRoutes);

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

const packagingDispatchViewRoutes = require("./routes/CMS_Routes/Manufacturing/Packaging/packagingDispatchViewRoutes");
app.use("/api/cms/manufacturing/packaging-dispatch-view", packagingDispatchViewRoutes);

const workOrderRoutes = require("./routes/CMS_Routes/Manufacturing/WorkOrder/workOrderRoutes");
app.use("/api/cms/manufacturing/work-orders", workOrderRoutes);

const BarcodeRoutes = require("./routes/CMS_Routes/Manufacturing/WorkOrder/barcodeRoutes.js");
app.use("/api/cms/manufacturing/barcode", BarcodeRoutes);

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


const productionMachineLayout = require("./routes/CMS_Routes/Production/Dashboard/canvasLayoutRoutes.js");
app.use("/api/cms/production/canvas-layout", productionMachineLayout);


const packagingRoutes = require("./routes/CMS_Routes/Manufacturing/Packaging/packagingRoutes");
app.use("/api/cms/manufacturing/packaging", packagingRoutes);


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

// ─── GOOGLE WORKSPACE ROUTES ────────────────────────────────
const googleWorkspaceRoutes = require("./routes/googleWorkspaceRoutes");
app.use("/api/google", googleWorkspaceRoutes);

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

const payrollRoutes = require("./routes/HrRoutes/Payroll_section");
app.use("/api/hr/payroll", payrollRoutes);

const attendanceRouter = require("./routes/HrRoutes/Attendance_section");
app.use("/hr/attendance", attendanceRouter);

const hrLeaveRoutes = require("./routes/HrRoutes/Leave_section");
app.use("/api/hr/leaves", hrLeaveRoutes);

app.use("/hr/reports", require("./routes/HrRoutes/Reports_section.js"));

// Employee Leave Routes (employee side — apply, balance, calendar, manager actions)
const employeeLeaveRoutes = require("./routes/Employee_Routes/leaveRoutes");
app.use("/api/employee/leave-applications", employeeLeaveRoutes);

const passwordMgmt = require("./routes/HrRoutes/Passwordmanagement.js");
app.use("/api/hr/password-management", passwordMgmt);

const employeeImportRoutes = require("./routes/HrRoutes/employeeImportExport.js");
app.use("/api/employees/import-export", employeeImportRoutes);

const payRollRouter = require("./routes/HrRoutes/Payroll_section");
app.use("/api/hr/payroll", payRollRouter);

const payslipRouter = require("./routes/HrRoutes/Payslip_section");
app.use("/api/hr/payslip", payslipRouter);


const empAttendance = require("./routes/Employee_Routes/employeeAttendance");
app.use("/api/employee/attendance", empAttendance);

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

const publicProfileAPI = require("./routes/Employee_Routes/publicProfileAPI");
app.use("/employee", publicProfileAPI);

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


const barcodeScannerRoutes = require("./routes/Barcode_Scanner_Device/barcode-scanner-hardware-routes.js"); // NEW FILE
app.use("/api/barcode-devices", barcodeScannerRoutes);



app.use("/cowork", require("./routes/task_routes/taskForward.js"));
// Media upload (images → Cloudinary, PDFs → Google Drive, voice → Cloudinary)
app.use("/cowork", require("./routes/task_routes/mediaUpload.js"));

// Enhanced: group/DM media messages, subtasks, task chat, deadline edit, delete
app.use("/cowork", require("./routes/task_routes/coworkEnhanced.js"));

//new tree substack routes
const taskTreeModule = require("./routes/task_routes/taskTree.routes.js");
app.use("/cowork", taskTreeModule); // ✅ Fix: use .router

const coworkRoutes = require("./routes/task_routes/cowork");
app.use("/cowork", coworkRoutes);

app.use("/cowork", require("./routes/task_routes/livekit.routes"));

app.use("/cowork", require("./routes/task_routes/meetingSummary.routes"));

app.use("/cowork", require("./routes/task_routes/audioRecording.routes")(io));

// Fix: askAI.routes exports an object, use .router
const askAITest = require("./routes/task_routes/askAI.routes");
console.log('askAI.routes exports:', Object.keys(askAITest));
app.use("/cowork", askAITest);


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


app.post("/api/cms/production/employee-sync/manual", async (req, res) => {
  try {
    await productionSyncService.manualEmployeeSync();
    res.json({ success: true, message: "Employee sync completed successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error during employee sync", error: error.message });
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

const payslipRoutes = require('./routes/Employee_Routes/Payslip');
app.use('/api/employee/payslip', payslipRoutes);

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


if (attendanceRouter.startHourlyAttendanceSync) {
  attendanceRouter.startHourlyAttendanceSync();
  console.log("✅ Hourly attendance sync cron initialized");
} else {
  console.warn("⚠️ Hourly attendance sync not available");
}


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
  console.log(`Server running on port ${PORT}`);
  transcriptModule.startCron();

  // ── Meeting 15-min reminder cron — runs every 5 minutes ──────────────────
  const _reminderSent = new Set();
  setInterval(async () => {
    try {
      const { db } = require("./config/firebaseAdmin");
      const { sendPushToEmployees } = require("./services/fcmPush.service");
      const { sendNotificationEmail } = require("./services/emailNotifications.service");

      const now = Date.now();
      const windowStart = new Date(now + 10 * 60 * 1000).toISOString();
      const windowEnd = new Date(now + 20 * 60 * 1000).toISOString();

      const snap = await db.collection("cowork_scheduled_meets")
        .where("isCancelled", "==", false)
        .where("dateTime", ">=", windowStart)
        .where("dateTime", "<=", windowEnd)
        .get();

      for (const doc of snap.docs) {
        const meet = doc.data();
        const meetId = meet.meetId || doc.id;
        if (_reminderSent.has(meetId)) continue;
        _reminderSent.add(meetId);

        const participants = meet.participants || [];
        if (!participants.length) continue;

        const title = `Meeting in 15 minutes: ${meet.title}`;
        const body = `"${meet.title}" starts soon. Get ready to join.`;

        await sendPushToEmployees(participants, title, body, { type: "meet_reminder", meetId });

        const empDocs = await Promise.all(
          participants.map(id => db.collection("cowork_employees").doc(id).get())
        );
        for (const empDoc of empDocs) {
          if (!empDoc.exists) continue;
          const emp = empDoc.data();
          if (!emp.email) continue;
          await sendNotificationEmail({
            senderId: meet.createdBy || "system",
            senderName: "CoWork",
            receiverId: emp.employeeId || empDoc.id,
            receiverName: emp.name || empDoc.id,
            receiverEmail: emp.email,
            type: "meet_reminder",
            title,
            body,
            data: { meetId, meetTitle: meet.title, dateTime: meet.dateTime },
          });
        }
        console.log(`[MeetReminder] Sent for meetId=${meetId} to ${participants.length} participants`);
      }

      if (_reminderSent.size > 500) _reminderSent.clear();

    } catch (e) {
      console.error("[MeetReminder cron]", e.message);
    }
  }, 5 * 60 * 1000);
});
