const express = require("express");
const router = express.Router();
const Employee = require("../../models/Employee");
const AllEmployeeAppMiddleware = require("../../Middlewear/AllEmployeeAppMiddleware");

// Save push token for the logged-in employee
router.post("/push-token", AllEmployeeAppMiddleware, async (req, res) => {
    try {
        const { pushToken } = req.body;
        if (!pushToken) {
            console.warn(`[PUSH-TOKEN] ❌ Empty pushToken from employee ${req.user.id}`);
            return res.status(400).json({ success: false, message: "pushToken required" });
        }

        // *** FIXED: Validate it's a real Expo push token ***
        const { Expo } = require("expo-server-sdk");
        if (!Expo.isExpoPushToken(pushToken)) {
            console.warn(`[PUSH-TOKEN] ❌ Invalid Expo token format from employee ${req.user.id}: ${pushToken}`);
            return res.status(400).json({ success: false, message: "Invalid push token format" });
        }

        const result = await Employee.findByIdAndUpdate(
            req.user.id,
            { pushToken },
            { new: true }
        ).select("firstName pushToken");

        if (!result) {
            console.error(`[PUSH-TOKEN] ❌ Employee ${req.user.id} not found in DB`);
            return res.status(404).json({ success: false, message: "Employee not found" });
        }

        console.log(`[PUSH-TOKEN] ✅ Token saved for ${result.firstName} (${req.user.id}): ${pushToken.substring(0, 35)}...`);

        res.json({ success: true, message: "Push token registered" });
    } catch (err) {
        console.error("[PUSH-TOKEN] ❌ Error:", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// Remove push token on logout
router.delete("/push-token", AllEmployeeAppMiddleware, async (req, res) => {
    try {
        await Employee.findByIdAndUpdate(req.user.id, { pushToken: null });
        console.log(`[PUSH-TOKEN] Token removed for employee ${req.user.id}`);
        res.json({ success: true, message: "Push token removed" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// *** NEW: Debug endpoint — check if current user has a valid push token ***
router.get("/push-token/debug", AllEmployeeAppMiddleware, async (req, res) => {
    try {
        const emp = await Employee.findById(req.user.id)
            .select("firstName lastName pushToken status isActive")
            .lean();

        if (!emp) {
            return res.json({ success: false, message: "Employee not found" });
        }

        const { Expo } = require("expo-server-sdk");
        const isValid = emp.pushToken ? Expo.isExpoPushToken(emp.pushToken) : false;

        // Also count all employees with tokens for overview
        const totalWithTokens = await Employee.countDocuments({
            pushToken: { $exists: true, $nin: [null, ""] },
            $or: [{ status: "active" }, { isActive: true }],
        });

        res.json({
            success: true,
            data: {
                name: `${emp.firstName} ${emp.lastName || ""}`.trim(),
                hasPushToken: !!emp.pushToken && emp.pushToken !== "",
                tokenPreview: emp.pushToken ? emp.pushToken.substring(0, 40) + "..." : null,
                isValidExpoToken: isValid,
                status: emp.status,
                isActive: emp.isActive,
                totalEmployeesWithTokens: totalWithTokens,
            },
        });
    } catch (err) {
        console.error("[PUSH-TOKEN-DEBUG]", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;