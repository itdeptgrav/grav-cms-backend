// routes/hr/passwordManagement.js

const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const Employee = require("../../models/Employee");
const HRDepartment = require("../../models/HRDepartment");
const SalesDepartment = require("../../models/SalesDepartment");
const AccountantDepartment = require("../../models/Accountant_model/AccountantDepartment");
const CuttingMasterDepartment = require("../../models/CuttingMasterDepartment");
const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");

// ─── Utility: only HR managers can access these routes ───────────────────────
function hrOnly(req, res, next) {
    if (req.user?.role !== "hr_manager") {
        return res.status(403).json({ success: false, message: "Access denied" });
    }
    next();
}

// ─── Helper: resolve model by userType ───────────────────────────────────────
function getModelByType(userType) {
    switch (userType) {
        case "sales": return SalesDepartment;
        case "accountant": return AccountantDepartment;
        case "cutting-master": return CuttingMasterDepartment;
        case "hr": return HRDepartment;
        default: return Employee;         // regular employees
    }
}

/**
 * GET /api/hr/password-management/users
 * Returns ALL staff accounts across every model for the HR dashboard list.
 * Query params: search, department, userType, page, limit
 */
router.get(
    "/users",
    EmployeeAuthMiddleware,
    hrOnly,
    async (req, res) => {
        try {
            const { search = "", department = "", userType = "all", page = 1, limit = 20 } = req.query;
            const skip = (Number(page) - 1) * Number(limit);

            const buildQuery = (extra = {}) => {
                const q = { isActive: true, ...extra };
                if (search) {
                    q.$or = [
                        { name: { $regex: search, $options: "i" } },
                        { email: { $regex: search, $options: "i" } },
                        { employeeId: { $regex: search, $options: "i" } },
                    ];
                }
                if (department) q.department = { $regex: department, $options: "i" };
                return q;
            };

            const buildEmployeeQuery = () => {
                const q = { isActive: true };
                if (search) {
                    q.$or = [
                        { firstName: { $regex: search, $options: "i" } },
                        { lastName: { $regex: search, $options: "i" } },
                        { email: { $regex: search, $options: "i" } },
                        { biometricId: { $regex: search, $options: "i" } },
                    ];
                }
                if (department) q.department = { $regex: department, $options: "i" };
                return q;
            };

            const SELECT = "name email employeeId department role phone createdAt";

            let results = [];

            // Fetch from each collection unless filtered
            if (userType === "all" || userType === "employee") {
                const emps = await Employee.find(buildEmployeeQuery())
                    .select("firstName lastName email biometricId department jobTitle createdAt isActive")
                    .lean();
                results.push(
                    ...emps.map((e) => ({
                        _id: e._id,
                        name: `${e.firstName} ${e.lastName}`,
                        email: e.email,
                        employeeId: e.biometricId,
                        department: e.department,
                        role: e.jobTitle || "Employee",
                        userType: "employee",
                        createdAt: e.createdAt,
                        isActive: e.isActive,
                    }))
                );
            }

            if (userType === "all" || userType === "sales") {
                const sales = await SalesDepartment.find(buildQuery()).select(SELECT).lean();
                results.push(...sales.map((u) => ({ ...u, userType: "sales" })));
            }

            if (userType === "all" || userType === "accountant") {
                const acc = await AccountantDepartment.find(buildQuery()).select(SELECT).lean();
                results.push(...acc.map((u) => ({ ...u, userType: "accountant" })));
            }

            if (userType === "all" || userType === "cutting-master") {
                const cm = await CuttingMasterDepartment.find(buildQuery()).select(SELECT).lean();
                results.push(...cm.map((u) => ({ ...u, userType: "cutting-master" })));
            }

            if (userType === "all" || userType === "hr") {
                const hr = await HRDepartment.find(buildQuery()).select(SELECT).lean();
                results.push(...hr.map((u) => ({ ...u, userType: "hr" })));
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
    }
);

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
                return res.status(400).json({ success: false, message: "Both password fields are required" });
            }
            if (newPassword !== confirmPassword) {
                return res.status(400).json({ success: false, message: "Passwords do not match" });
            }
            if (newPassword.length < 8) {
                return res.status(400).json({ success: false, message: "Password must be at least 8 characters" });
            }
            if (!/[A-Z]/.test(newPassword)) {
                return res.status(400).json({ success: false, message: "Password must contain at least one uppercase letter" });
            }
            if (!/[0-9]/.test(newPassword)) {
                return res.status(400).json({ success: false, message: "Password must contain at least one number" });
            }

            const Model = getModelByType(userType);
            const user = await Model.findById(id);

            if (!user) {
                return res.status(404).json({ success: false, message: "User not found" });
            }

            const salt = await bcrypt.genSalt(10);
            const hashed = await bcrypt.hash(newPassword, salt);

            user.password = hashed;

            // Bypass the pre-save hook (already hashed manually)
            await Model.findByIdAndUpdate(id, { password: hashed });

            res.status(200).json({
                success: true,
                message: `Password updated successfully for ${user.name || `${user.firstName} ${user.lastName}`}`,
            });
        } catch (err) {
            console.error("Change password error:", err);
            if (err.name === "CastError") {
                return res.status(400).json({ success: false, message: "Invalid user ID" });
            }
            res.status(500).json({ success: false, message: "Error updating password" });
        }
    }
);

/**
 * POST /api/hr/password-management/reset-password/:userType/:id
 * Generates and sets a temporary password (returned in response for HR to share).
 */
router.post(
    "/reset-password/:userType/:id",
    EmployeeAuthMiddleware,
    hrOnly,
    async (req, res) => {
        try {
            const { userType, id } = req.params;

            // Generate a secure temporary password
            const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789@#$!";
            let tempPassword = "";
            tempPassword += "ABCDEFGHJKLMNPQRSTUVWXYZ"[Math.floor(Math.random() * 24)]; // 1 uppercase
            tempPassword += "23456789"[Math.floor(Math.random() * 8)];                   // 1 number
            tempPassword += "@#$!"[Math.floor(Math.random() * 4)];                       // 1 special
            for (let i = 3; i < 10; i++) {
                tempPassword += chars[Math.floor(Math.random() * chars.length)];
            }
            // Shuffle
            tempPassword = tempPassword.split("").sort(() => 0.5 - Math.random()).join("");

            const Model = getModelByType(userType);
            const user = await Model.findById(id);

            if (!user) {
                return res.status(404).json({ success: false, message: "User not found" });
            }

            const salt = await bcrypt.genSalt(10);
            const hashed = await bcrypt.hash(tempPassword, salt);

            await Model.findByIdAndUpdate(id, { password: hashed });

            res.status(200).json({
                success: true,
                message: "Temporary password generated",
                temporaryPassword: tempPassword,   // HR shares this with the employee
                userName: user.name || `${user.firstName} ${user.lastName}`,
            });
        } catch (err) {
            console.error("Reset password error:", err);
            res.status(500).json({ success: false, message: "Error resetting password" });
        }
    }
);

module.exports = router;