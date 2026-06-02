// routes/hr/passwordManagement.js

const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const Employee = require("../../models/Employee");
const HRDepartment = require("../../models/HRDepartment");
const SalesDepartment = require("../../models/SalesDepartment");
const AccountantDepartment = require("../../models/Accountant_model/Acc_Department");
const CuttingMasterDepartment = require("../../models/CuttingMasterDepartment");
const ProjectManager = require("../../models/ProjectManager");
const MpcMeasurement = require("../../models/MpcMeasurement");
const PackagingDispatchDepartment = require("../../models/PackagingDispatchDepartment");
const ProductionSupervisorDepartment = require("../../models/ProductionSupervisorDepartment");
const QCDepartment = require("../../models/QCDepartment");
const CEODepartment = require("../../models/CEODepartment");
const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");

// Helper function to generate default password (must match login route)
const generateDefaultPassword = (firstName, dateOfBirth) => {
  if (!firstName || !dateOfBirth) return null;

  const formattedFirstName =
    firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();

  let date;
  if (typeof dateOfBirth === "string") {
    date = new Date(dateOfBirth);
  } else {
    date = dateOfBirth;
  }

  if (isNaN(date.getTime())) return null;

  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const dobString = `${month}${day}${year}`;

  return `${formattedFirstName}@${dobString}`;
};

// ─── Utility: only HR managers can access these routes ───────────────────────
function hrOnly(req, res, next) {
  if (req.user?.role !== "hr_manager") {
    return res.status(403).json({
      success: false,
      message: "Access denied. HR privileges required.",
    });
  }
  next();
}

// ─── Helper: resolve model by userType ───────────────────────────────────────
function getModelByType(userType) {
  switch (userType) {
    case "hr":
      return HRDepartment;
    case "sales":
      return SalesDepartment;
    case "accountant":
      return AccountantDepartment;
    case "cutting-master":
      return CuttingMasterDepartment;
    case "project_manager":
      return ProjectManager;
    case "mpc-measurement":
      return MpcMeasurement;
    case "packaging-dispatch":
      return PackagingDispatchDepartment;
    case "production-supervisor":
      return ProductionSupervisorDepartment;
    case "qc":
      return QCDepartment;
    case "ceo":
      return CEODepartment;
    default:
      return Employee; // regular employees
  }
}

// ─── Shared: the department login models (single source of truth) ────────────
// Reused by the /users list and the /sync-dept-logins reconcile endpoints.
const DEPT_TYPES = [
  { key: "hr", Model: HRDepartment, label: "HR" },
  { key: "sales", Model: SalesDepartment, label: "Sales" },
  { key: "accountant", Model: AccountantDepartment, label: "Accountant" },
  {
    key: "cutting-master",
    Model: CuttingMasterDepartment,
    label: "Cutting Master",
  },
  { key: "project_manager", Model: ProjectManager, label: "Project Manager" },
  { key: "mpc-measurement", Model: MpcMeasurement, label: "MPC Measurement" },
  {
    key: "packaging-dispatch",
    Model: PackagingDispatchDepartment,
    label: "Packaging & Dispatch",
  },
  {
    key: "production-supervisor",
    Model: ProductionSupervisorDepartment,
    label: "Production Supervisor",
  },
  { key: "qc", Model: QCDepartment, label: "QC" },
  { key: "ceo", Model: CEODepartment, label: "CEO" },
];
const DEPT_KEY_SET = new Set(DEPT_TYPES.map((d) => d.key));

// Map a free-text employee department / jobTitle to one of the dept-login keys.
// Returns null if the employee doesn't belong to any dept-login model (they're
// then a plain Employee-collection user and need no separate dept login).
function mapEmployeeToDeptKey(emp) {
  const hay = `${emp.department || ""} ${emp.jobTitle || ""}`
    .toLowerCase()
    .trim();
  if (!hay) return null;
  // Order matters: check more specific phrases before generic ones.
  if (/\bceo\b|managing director|founder|chairman/.test(hay)) return "ceo";
  if (/human resource|\bhr\b/.test(hay)) return "hr";
  if (/account|finance/.test(hay)) return "accountant";
  if (/cutting/.test(hay)) return "cutting-master";
  if (/project\s*manager|\bpm\b/.test(hay)) return "project_manager";
  if (/mpc|measurement/.test(hay)) return "mpc-measurement";
  if (/packaging|dispatch/.test(hay)) return "packaging-dispatch";
  if (/production\s*supervisor|supervisor/.test(hay))
    return "production-supervisor";
  if (/quality|\bqc\b/.test(hay)) return "qc";
  if (/\bsales\b/.test(hay)) return "sales";
  return null;
}

// Normalise a phone/bio value for comparison (trim, drop spaces & dashes).
function normKey(v) {
  return String(v ?? "")
    .replace(/[\s-]/g, "")
    .trim()
    .toLowerCase();
}

// Helper to get user name from different models
function getUserName(user, userType) {
  if (userType === "employee") {
    return (
      `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email
    );
  }
  return user.name || user.email;
}

// Helper to get user email from different models
function getUserEmail(user, userType) {
  return user.email;
}

// Helper to get user phone from different models
function getUserPhone(user, userType) {
  if (userType === "employee") {
    return user.phone;
  }
  return user.phone || user.mobileNumber;
}

/**
 * GET /api/hr/password-management/users
 * Returns ALL staff accounts across every model for the HR dashboard list.
 * Query params: search, department, userType, page, limit
 */
router.get("/users", EmployeeAuthMiddleware, hrOnly, async (req, res) => {
  try {
    const {
      search = "",
      department = "",
      userType = "all",
      page = 1,
      limit = 20,
    } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    // Query builder for department models (name, email, phone, employeeId fields)
    const buildQuery = (extra = {}) => {
      const q = { isActive: true, ...extra };
      if (search) {
        q.$or = [
          { name: { $regex: search, $options: "i" } },
          { email: { $regex: search, $options: "i" } },
          { employeeId: { $regex: search, $options: "i" } },
          { phone: { $regex: search, $options: "i" } },
        ];
      }
      if (department) q.department = { $regex: department, $options: "i" };
      return q;
    };

    // Query builder for Employee model (firstName/lastName split)
    const buildEmployeeQuery = () => {
      const q = { isActive: true };
      if (search) {
        q.$or = [
          { firstName: { $regex: search, $options: "i" } },
          { lastName: { $regex: search, $options: "i" } },
          { email: { $regex: search, $options: "i" } },
          { biometricId: { $regex: search, $options: "i" } },
          { phone: { $regex: search, $options: "i" } },
        ];
      }
      if (department) q.department = { $regex: department, $options: "i" };
      return q;
    };

    let results = [];

    // ── Employee (biometric/HRMS staff) ──────────────────────────────
    if (userType === "all" || userType === "employee") {
      const emps = await Employee.find(buildEmployeeQuery())
        .select(
          "firstName lastName email phone biometricId department jobTitle createdAt isActive dateOfBirth",
        )
        .lean();
      results.push(
        ...emps.map((e) => ({
          _id: e._id,
          name: `${e.firstName || ""} ${e.lastName || ""}`.trim() || e.email,
          email: e.email,
          phone: e.phone,
          employeeId: e.biometricId,
          department: e.department,
          role: e.jobTitle || "Employee",
          userType: "employee",
          createdAt: e.createdAt,
          isActive: e.isActive,
          dateOfBirth: e.dateOfBirth,
        })),
      );
    }

    // ── Department models ─────────────────────────────────────────────
    const deptTypes = [
      { key: "hr", Model: HRDepartment, label: "HR" },
      { key: "sales", Model: SalesDepartment, label: "Sales" },
      { key: "accountant", Model: AccountantDepartment, label: "Accountant" },
      {
        key: "cutting-master",
        Model: CuttingMasterDepartment,
        label: "Cutting Master",
      },
      {
        key: "project_manager",
        Model: ProjectManager,
        label: "Project Manager",
      },
      {
        key: "mpc-measurement",
        Model: MpcMeasurement,
        label: "MPC Measurement",
      },
      {
        key: "packaging-dispatch",
        Model: PackagingDispatchDepartment,
        label: "Packaging & Dispatch",
      },
      {
        key: "production-supervisor",
        Model: ProductionSupervisorDepartment,
        label: "Production Supervisor",
      },
      { key: "qc", Model: QCDepartment, label: "QC" },
      { key: "ceo", Model: CEODepartment, label: "CEO" },
    ];

    for (const { key, Model } of deptTypes) {
      if (userType === "all" || userType === key) {
        const users = await Model.find(buildQuery())
          .select(
            "name email phone employeeId department role createdAt isActive",
          )
          .lean();
        results.push(...users.map((u) => ({ ...u, userType: key })));
      }
    }

    // Sort by name, paginate
    results.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    const total = results.length;
    const paginated = results.slice(skip, skip + Number(limit));

    res.status(200).json({
      success: true,
      data: paginated,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (err) {
    console.error("Password Management - fetch users error:", err);
    res.status(500).json({ success: false, message: "Error fetching users" });
  }
});

/**
 * PATCH /api/hr/password-management/change-password/:userType/:id
 * HR changes password for any staff member.
 * Body: { newPassword, confirmPassword }
 */
router.patch(
  "/change-password/:userType/:id",
  EmployeeAuthMiddleware,
  hrOnly,
  async (req, res) => {
    try {
      const { userType, id } = req.params;
      const { newPassword, confirmPassword } = req.body;

      // Validations
      if (!newPassword || !confirmPassword) {
        return res.status(400).json({
          success: false,
          message: "Both password fields are required",
        });
      }
      if (newPassword !== confirmPassword) {
        return res
          .status(400)
          .json({ success: false, message: "Passwords do not match" });
      }
      if (newPassword.length < 8) {
        return res.status(400).json({
          success: false,
          message: "Password must be at least 8 characters",
        });
      }
      if (!/[A-Z]/.test(newPassword)) {
        return res.status(400).json({
          success: false,
          message: "Password must contain at least one uppercase letter",
        });
      }
      if (!/[0-9]/.test(newPassword)) {
        return res.status(400).json({
          success: false,
          message: "Password must contain at least one number",
        });
      }

      const Model = getModelByType(userType);
      const user = await Model.findById(id);

      if (!user) {
        return res
          .status(404)
          .json({ success: false, message: "User not found" });
      }

      const salt = await bcrypt.genSalt(10);
      const hashed = await bcrypt.hash(newPassword, salt);

      await Model.findByIdAndUpdate(id, { password: hashed });

      const userName = getUserName(user, userType);

      res.status(200).json({
        success: true,
        message: `Password updated successfully for ${userName}`,
      });
    } catch (err) {
      console.error("Change password error:", err);
      if (err.name === "CastError") {
        return res
          .status(400)
          .json({ success: false, message: "Invalid user ID" });
      }
      res
        .status(500)
        .json({ success: false, message: "Error updating password" });
    }
  },
);

/**
 * POST /api/hr/password-management/reset-password/:userType/:id
 * Resets password to default format (FirstName@MMDDYYYY) for employees
 * For other departments, generates a secure temporary password
 */
router.post(
  "/reset-password/:userType/:id",
  EmployeeAuthMiddleware,
  hrOnly,
  async (req, res) => {
    try {
      const { userType, id } = req.params;

      const Model = getModelByType(userType);
      const user = await Model.findById(id);

      if (!user) {
        return res
          .status(404)
          .json({ success: false, message: "User not found" });
      }

      let tempPassword;
      let userName;

      // For employees, reset to default password format
      if (userType === "employee") {
        if (!user.phone) {
          return res.status(400).json({
            success: false,
            message:
              "Cannot reset password: Employee has no mobile number on record",
          });
        }
        tempPassword = user.phone.trim();
        userName =
          `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email;
      } else {
        // For all department accounts, generate a secure temporary password
        const chars =
          "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789@#$!";
        tempPassword = "";
        tempPassword += "ABCDEFGHJKLMNPQRSTUVWXYZ"[
          Math.floor(Math.random() * 24)
        ];
        tempPassword += "23456789"[Math.floor(Math.random() * 8)];
        tempPassword += "@#$!"[Math.floor(Math.random() * 4)];
        for (let i = 3; i < 10; i++) {
          tempPassword += chars[Math.floor(Math.random() * chars.length)];
        }
        // Shuffle
        tempPassword = tempPassword
          .split("")
          .sort(() => 0.5 - Math.random())
          .join("");
        userName = user.name || user.email;
      }

      const salt = await bcrypt.genSalt(10);
      const hashed = await bcrypt.hash(tempPassword, salt);

      await Model.findByIdAndUpdate(id, { password: hashed });

      res.status(200).json({
        success: true,
        message: `Password reset successfully for ${userName}`,
        temporaryPassword: tempPassword,
        userName: userName,
        userType: userType,
        note:
          userType === "employee"
            ? "Password reset to employee mobile number"
            : "Temporary password generated",
      });
    } catch (err) {
      console.error("Reset password error:", err);
      res.status(500).json({
        success: false,
        message: "Error resetting password: " + err.message,
      });
    }
  },
);

/**
 * GET /api/hr/password-management/user/:userType/:id
 * Get specific user details for password management
 */
router.get(
  "/user/:userType/:id",
  EmployeeAuthMiddleware,
  hrOnly,
  async (req, res) => {
    try {
      const { userType, id } = req.params;

      const Model = getModelByType(userType);
      const user = await Model.findById(id).select("-password");

      if (!user) {
        return res
          .status(404)
          .json({ success: false, message: "User not found" });
      }

      let userData;
      if (userType === "employee") {
        userData = {
          _id: user._id,
          name:
            `${user.firstName || ""} ${user.lastName || ""}`.trim() ||
            user.email,
          email: user.email,
          phone: user.phone,
          employeeId: user.biometricId,
          department: user.department,
          role: user.jobTitle,
          userType: "employee",
          hasDateOfBirth: !!user.dateOfBirth,
          hasFirstName: !!user.firstName,
        };
      } else {
        userData = {
          _id: user._id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          employeeId: user.employeeId,
          department: user.department,
          role: user.role,
          userType: userType,
        };
      }

      res.status(200).json({
        success: true,
        data: userData,
      });
    } catch (err) {
      console.error("Get user error:", err);
      res
        .status(500)
        .json({ success: false, message: "Error fetching user details" });
    }
  },
);

/**
 * POST /api/hr/password-management/bulk-reset
 * Bulk reset passwords for multiple employees (only for employee type)
 * Body: { userIds: [], userType: "employee" }
 */
router.post("/bulk-reset", EmployeeAuthMiddleware, hrOnly, async (req, res) => {
  try {
    const { userIds, userType } = req.body;

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "User IDs are required" });
    }

    if (userType !== "employee") {
      return res.status(400).json({
        success: false,
        message: "Bulk reset only available for employees",
      });
    }

    const Model = getModelByType(userType);
    const results = [];
    const errors = [];

    for (const userId of userIds) {
      try {
        const user = await Model.findById(userId);

        if (!user) {
          errors.push({ userId, error: "User not found" });
          continue;
        }

        if (!user.phone) {
          errors.push({
            userId,
            error: "No mobile number on record",
            name:
              `${user.firstName || ""} ${user.lastName || ""}`.trim() ||
              user.email,
          });
          continue;
        }
        const defaultPassword = user.phone.trim();
        const salt = await bcrypt.genSalt(10);
        const hashed = await bcrypt.hash(defaultPassword, salt);

        await Model.findByIdAndUpdate(userId, { password: hashed });

        results.push({
          userId,
          name: `${user.firstName} ${user.lastName || ""}`.trim(),
          email: user.email,
          newPassword: defaultPassword,
        });
      } catch (err) {
        errors.push({ userId, error: err.message });
      }
    }

    res.status(200).json({
      success: true,
      message: `Reset completed: ${results.length} successful, ${errors.length} failed`,
      data: {
        successful: results,
        failed: errors,
      },
    });
  } catch (err) {
    console.error("Bulk reset error:", err);
    res
      .status(500)
      .json({ success: false, message: "Error performing bulk reset" });
  }
});

/**
 * Shared reconcile computation (CLEANUP-ONLY).
 *
 * Every active employee already has an Employee login (they appear under the
 * "Employee" type and can sign in via the employee app). So a SEPARATE
 * department login for that same person is a DUPLICATE — that's what produced
 * the two ARNOLDIN rows (Employee + Cutting Master). This sync therefore does
 * NOT create department logins. It only finds department logins that should be
 * cleaned up, matching on BOTH biometric id and phone:
 *
 *   duplicates — a dept login whose (bio, phone) matches an active employee.
 *                The person already has an Employee login, so this dept login
 *                is redundant. Recommended for removal by default.
 *   orphans    — a dept login that matches NO active employee at all.
 *                Could be a hand-made standalone account, so NOT recommended
 *                by default (left unchecked for HR to decide).
 *
 * Admin department logins are NEVER offered for removal — HR, Accountant, CEO
 * and Project Manager accounts are protected, since those are real login
 * accounts that may legitimately have no Employee record.
 */
const ADMIN_PROTECTED_DEPT_KEYS = new Set([
  "hr",
  "accountant",
  "ceo",
  "project_manager",
]);

async function computeDeptReconcile() {
  // 1. Active employees — the source of truth for who can already log in.
  const employees = await Employee.find({ isActive: true })
    .select("firstName lastName email phone biometricId department jobTitle")
    .lean();

  // Composite (bio|phone) index of active employees.
  const empByComposite = new Map();
  for (const e of employees) {
    const k = `${normKey(e.biometricId)}|${normKey(e.phone)}`;
    if (normKey(e.biometricId) && normKey(e.phone)) empByComposite.set(k, e);
  }

  // 2. Walk every department login model. Admin types are skipped entirely so
  //    they can never be flagged for removal.
  const duplicates = [];
  const orphans = [];
  for (const { key, Model, label } of DEPT_TYPES) {
    if (ADMIN_PROTECTED_DEPT_KEYS.has(key)) continue; // protected — never touch
    const rows = await Model.find({})
      .select("name email phone employeeId department role isActive")
      .lean();
    for (const a of rows) {
      const bio = normKey(a.employeeId);
      const phone = normKey(a.phone);
      // Skip accounts that can't be keyed on both fields — we can't safely
      // judge them, so we leave them alone.
      if (!bio || !phone) continue;
      const composite = `${bio}|${phone}`;
      const matchedEmp = empByComposite.get(composite);
      const row = {
        _id: a._id,
        userType: key,
        deptLabel: label,
        name: a.name || a.email,
        email: a.email,
        phone: a.phone,
        employeeId: a.employeeId,
        department: a.department,
        role: a.role,
      };
      if (matchedEmp) {
        // Person already has an Employee login → this dept login is a duplicate.
        row.reason = "Already has an Employee login";
        duplicates.push(row);
      } else {
        // No matching employee → orphaned dept login.
        row.reason = "No matching employee (biometric ID + mobile)";
        orphans.push(row);
      }
    }
  }

  return { duplicates, orphans };
}

/**
 * GET /api/hr/password-management/sync-dept-logins
 * Dry-run preview. Returns { duplicates, orphans } — changes nothing.
 */
router.get(
  "/sync-dept-logins",
  EmployeeAuthMiddleware,
  hrOnly,
  async (req, res) => {
    try {
      const { duplicates, orphans } = await computeDeptReconcile();
      res.status(200).json({
        success: true,
        data: {
          duplicates,
          orphans,
          counts: {
            duplicates: duplicates.length,
            orphans: orphans.length,
          },
        },
      });
    } catch (err) {
      console.error("Sync preview error:", err);
      res
        .status(500)
        .json({ success: false, message: "Error computing sync preview" });
    }
  },
);

/**
 * POST /api/hr/password-management/sync-dept-logins
 * Removes only the department logins HR KEPT TICKED in the popup.
 *   body.removeIds — array of dept-login _id (string) to delete
 * Each id is re-validated against a fresh reconcile so a stale popup can't
 * delete the wrong record, and admin-protected types can never be deleted.
 */
router.post(
  "/sync-dept-logins",
  EmployeeAuthMiddleware,
  hrOnly,
  async (req, res) => {
    try {
      const removeIds = Array.isArray(req.body?.removeIds)
        ? req.body.removeIds.map(String)
        : [];

      if (removeIds.length === 0) {
        return res
          .status(400)
          .json({ success: false, message: "Nothing selected to remove." });
      }

      // Re-validate: only ids that are genuinely a duplicate or orphan right
      // now (and therefore non-admin) may be deleted.
      const { duplicates, orphans } = await computeDeptReconcile();
      const removable = new Map(
        [...duplicates, ...orphans].map((r) => [String(r._id), r]),
      );

      const removed = [];
      const errors = [];
      for (const id of removeIds) {
        const target = removable.get(id);
        if (!target) {
          errors.push({
            id,
            error: "No longer a removable dept login (or protected admin)",
          });
          continue;
        }
        try {
          const Model = getModelByType(target.userType);
          await Model.findByIdAndDelete(id);
          removed.push({
            id,
            name: target.name,
            deptLabel: target.deptLabel,
          });
        } catch (e) {
          errors.push({ id, error: e.message });
        }
      }

      res.status(200).json({
        success: true,
        message: `Sync complete: ${removed.length} duplicate/orphan login(s) removed${errors.length ? `, ${errors.length} skipped` : ""}.`,
        data: { removed, errors },
      });
    } catch (err) {
      console.error("Sync apply error:", err);
      res.status(500).json({ success: false, message: "Error applying sync" });
    }
  },
);

module.exports = router;
