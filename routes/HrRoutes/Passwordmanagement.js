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

// Helper function to generate default password (must match login route)
const generateDefaultPassword = (firstName, dateOfBirth) => {
    if (!firstName || !dateOfBirth) return null;

    const formattedFirstName = firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();

    let date;
    if (typeof dateOfBirth === 'string') {
        date = new Date(dateOfBirth);
    } else {
        date = dateOfBirth;
    }

    if (isNaN(date.getTime())) return null;

    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const dobString = `${month}${day}${year}`;

    return `${formattedFirstName}@${dobString}`;
};

// ─── Utility: only HR managers can access these routes ───────────────────────
function hrOnly(req, res, next) {
    if (req.user?.role !== "hr_manager") {
        return res.status(403).json({ success: false, message: "Access denied. HR privileges required." });
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

// Helper to get user name from different models
function getUserName(user, userType) {
    if (userType === "employee") {
        return `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email;
    }
    return user.name || user.email;
}

// Helper to get user email from different models
function getUserEmail(user, userType) {
    if (userType === "employee") {
        return user.email;
    }
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
                        { phone: { $regex: search, $options: "i" } },
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
                        { phone: { $regex: search, $options: "i" } },
                    ];
                }
                if (department) q.department = { $regex: department, $options: "i" };
                return q;
            };

            let results = [];

            // Fetch from each collection unless filtered
            if (userType === "all" || userType === "employee") {
                const emps = await Employee.find(buildEmployeeQuery())
                    .select("firstName lastName email phone biometricId department jobTitle createdAt isActive dateOfBirth")
                    .lean();
                results.push(
                    ...emps.map((e) => ({
                        _id: e._id,
                        name: `${e.firstName || ''} ${e.lastName || ''}`.trim() || e.email,
                        email: e.email,
                        phone: e.phone,
                        employeeId: e.biometricId,
                        department: e.department,
                        role: e.jobTitle || "Employee",
                        userType: "employee",
                        createdAt: e.createdAt,
                        isActive: e.isActive,
                        dateOfBirth: e.dateOfBirth,
                    }))
                );
            }

            if (userType === "all" || userType === "sales") {
                const sales = await SalesDepartment.find(buildQuery()).select("name email phone employeeId department role createdAt isActive").lean();
                results.push(...sales.map((u) => ({ ...u, userType: "sales" })));
            }

            if (userType === "all" || userType === "accountant") {
                const acc = await AccountantDepartment.find(buildQuery()).select("name email phone employeeId department role createdAt isActive").lean();
                results.push(...acc.map((u) => ({ ...u, userType: "accountant" })));
            }

            if (userType === "all" || userType === "cutting-master") {
                const cm = await CuttingMasterDepartment.find(buildQuery()).select("name email phone employeeId department role createdAt isActive").lean();
                results.push(...cm.map((u) => ({ ...u, userType: "cutting-master" })));
            }

            if (userType === "all" || userType === "hr") {
                const hr = await HRDepartment.find(buildQuery()).select("name email phone employeeId department role createdAt isActive").lean();
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

            // Update password
            await Model.findByIdAndUpdate(id, { password: hashed });

            const userName = getUserName(user, userType);

            res.status(200).json({
                success: true,
                message: `Password updated successfully for ${userName}`,
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
                return res.status(404).json({ success: false, message: "User not found" });
            }

            let tempPassword;
            let userName;

            // For employees, reset to default password format
            if (userType === "employee") {
                // Check if employee has firstName and dateOfBirth
                if (!user.firstName || !user.dateOfBirth) {
                    return res.status(400).json({
                        success: false,
                        message: "Cannot reset password: Employee missing first name or date of birth"
                    });
                }

                tempPassword = generateDefaultPassword(user.firstName, user.dateOfBirth);
                userName = `${user.firstName} ${user.lastName || ''}`.trim();

                if (!tempPassword) {
                    return res.status(400).json({
                        success: false,
                        message: "Cannot generate default password. Please check employee data."
                    });
                }
            } else {
                // For other departments, generate a secure temporary password
                const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789@#$!";
                tempPassword = "";
                tempPassword += "ABCDEFGHJKLMNPQRSTUVWXYZ"[Math.floor(Math.random() * 24)];
                tempPassword += "23456789"[Math.floor(Math.random() * 8)];
                tempPassword += "@#$!"[Math.floor(Math.random() * 4)];
                for (let i = 3; i < 10; i++) {
                    tempPassword += chars[Math.floor(Math.random() * chars.length)];
                }
                // Shuffle
                tempPassword = tempPassword.split("").sort(() => 0.5 - Math.random()).join("");
                userName = user.name || user.email;
            }

            // Hash the password
            const salt = await bcrypt.genSalt(10);
            const hashed = await bcrypt.hash(tempPassword, salt);

            // Update password
            await Model.findByIdAndUpdate(id, { password: hashed });

            res.status(200).json({
                success: true,
                message: `Password reset successfully for ${userName}`,
                temporaryPassword: tempPassword,
                userName: userName,
                userType: userType,
                note: userType === "employee" ? "Password reset to default format: FirstName@MMDDYYYY" : "Temporary password generated"
            });
        } catch (err) {
            console.error("Reset password error:", err);
            res.status(500).json({ success: false, message: "Error resetting password: " + err.message });
        }
    }
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
                return res.status(404).json({ success: false, message: "User not found" });
            }

            let userData;
            if (userType === "employee") {
                userData = {
                    _id: user._id,
                    name: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email,
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
            res.status(500).json({ success: false, message: "Error fetching user details" });
        }
    }
);

/**
 * POST /api/hr/password-management/bulk-reset
 * Bulk reset passwords for multiple employees (only for employee type)
 * Body: { userIds: [], userType: "employee" }
 */
router.post(
    "/bulk-reset",
    EmployeeAuthMiddleware,
    hrOnly,
    async (req, res) => {
        try {
            const { userIds, userType } = req.body;

            if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
                return res.status(400).json({ success: false, message: "User IDs are required" });
            }

            if (userType !== "employee") {
                return res.status(400).json({ success: false, message: "Bulk reset only available for employees" });
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

                    if (!user.firstName || !user.dateOfBirth) {
                        errors.push({ userId, error: "Missing first name or date of birth", name: user.email });
                        continue;
                    }

                    const defaultPassword = generateDefaultPassword(user.firstName, user.dateOfBirth);
                    const salt = await bcrypt.genSalt(10);
                    const hashed = await bcrypt.hash(defaultPassword, salt);

                    await Model.findByIdAndUpdate(userId, { password: hashed });

                    results.push({
                        userId,
                        name: `${user.firstName} ${user.lastName || ''}`.trim(),
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
            res.status(500).json({ success: false, message: "Error performing bulk reset" });
        }
    }
);

module.exports = router;