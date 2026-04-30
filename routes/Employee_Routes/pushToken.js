const express = require("express");
const router = express.Router();
const Employee = require("../../models/Employee");
const AllEmployeeAppMiddleware = require("../../Middlewear/AllEmployeeAppMiddleware");

// Save push token for the logged-in employee
router.post("/push-token", AllEmployeeAppMiddleware, async (req, res) => {
    try {
        const { pushToken } = req.body;
        if (!pushToken) {
            return res.status(400).json({ success: false, message: "pushToken required" });
        }

        await Employee.findByIdAndUpdate(req.user.id, { pushToken });
        console.log(`[PUSH] Token saved for employee ${req.user.id}`);

        res.json({ success: true, message: "Push token registered" });
    } catch (err) {
        console.error("[PUSH-TOKEN]", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// Remove push token on logout
router.delete("/push-token", AllEmployeeAppMiddleware, async (req, res) => {
    try {
        await Employee.findByIdAndUpdate(req.user.id, { pushToken: null });
        res.json({ success: true, message: "Push token removed" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;