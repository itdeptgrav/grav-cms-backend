// routes/employee/testPush.js
// ⚠️ DEBUG ONLY — remove this file before production deployment
const express = require("express");
const router = express.Router();
const { Expo } = require("expo-server-sdk");
const Employee = require("../../models/Employee");

const expo = new Expo();

// ── GET /test-push — test push notification to a specific employee ───────
// Usage: GET /api/employee/test-push?employeeId=69e85bfa55429ffaf7369ffe
//    or: GET /api/employee/test-push?token=ExponentPushToken[kWgTjhNK-IIc3M4VLHCyBc]
router.get("/test-push", async (req, res) => {
    try {
        const { employeeId, token } = req.query;
        let pushToken = token;
        let empName = "Test User";

        // If employeeId provided, look up their token
        if (employeeId && !pushToken) {
            const emp = await Employee.findById(employeeId)
                .select("pushToken firstName lastName")
                .lean();

            if (!emp) {
                return res.json({
                    success: false,
                    step: "EMPLOYEE_LOOKUP",
                    message: `No employee found with ID: ${employeeId}`,
                });
            }

            if (!emp.pushToken) {
                return res.json({
                    success: false,
                    step: "TOKEN_CHECK",
                    message: `Employee ${emp.firstName} has no push token saved. Open the app and log in first.`,
                    employee: { name: emp.firstName, pushToken: emp.pushToken },
                });
            }

            pushToken = emp.pushToken;
            empName = `${emp.firstName} ${emp.lastName || ""}`.trim();
        }

        if (!pushToken) {
            // No specific target — list all employees with tokens
            const allWithTokens = await Employee.find({
                pushToken: { $ne: null, $exists: true },
            })
                .select("firstName lastName biometricId pushToken status isActive")
                .lean();

            return res.json({
                success: false,
                step: "NO_TARGET",
                message: "Provide ?employeeId=xxx or ?token=ExponentPushToken[...] to test",
                employeesWithTokens: allWithTokens.map(e => ({
                    id: e._id,
                    name: `${e.firstName} ${e.lastName || ""}`.trim(),
                    biometricId: e.biometricId,
                    token: e.pushToken,
                    status: e.status,
                    isActive: e.isActive,
                })),
            });
        }

        // Validate token format
        if (!Expo.isExpoPushToken(pushToken)) {
            return res.json({
                success: false,
                step: "TOKEN_VALIDATION",
                message: `Invalid Expo push token format: "${pushToken}"`,
            });
        }

        console.log(`[TEST-PUSH] Sending test notification to ${empName} (${pushToken})`);

        // Send test notification
        const messages = [{
            to: pushToken,
            sound: "default",
            title: "🔔 Test Notification",
            body: `Hi ${empName}, this is a test push from Grav CRM. If you see this, push notifications work!`,
            data: {
                type: "test",
                screen: "Salary",
                timestamp: new Date().toISOString(),
            },
            channelId: "payroll",
            priority: "high",
        }];

        const chunks = expo.chunkPushNotifications(messages);
        const allReceipts = [];

        for (const chunk of chunks) {
            const receipts = await expo.sendPushNotificationsAsync(chunk);
            allReceipts.push(...receipts);
        }

        console.log(`[TEST-PUSH] Receipts:`, JSON.stringify(allReceipts));

        const receipt = allReceipts[0];
        if (receipt.status === "ok") {
            return res.json({
                success: true,
                step: "DELIVERED_TO_EXPO",
                message: `✓ Notification accepted by Expo Push API for ${empName}. Check the device!`,
                receipt,
                note: "If you still don't see it on the device, the issue is FCM/APNs delivery (google-services.json or Apple push certs).",
            });
        } else {
            return res.json({
                success: false,
                step: "EXPO_REJECTED",
                message: `Expo rejected the notification`,
                receipt,
                error: receipt.message || receipt.details,
            });
        }
    } catch (err) {
        console.error("[TEST-PUSH] Error:", err.message, err.stack);
        return res.status(500).json({
            success: false,
            step: "EXCEPTION",
            message: err.message,
            stack: err.stack,
        });
    }
});

// ── GET /check-tokens — list all employees and their push token status ────
router.get("/check-tokens", async (req, res) => {
    try {
        const employees = await Employee.find({
            $or: [{ status: "active" }, { isActive: true }],
        })
            .select("firstName lastName biometricId pushToken status isActive")
            .lean();

        const summary = {
            totalActive: employees.length,
            withToken: employees.filter(e => e.pushToken).length,
            withoutToken: employees.filter(e => !e.pushToken).length,
        };

        return res.json({
            success: true,
            summary,
            employees: employees.map(e => ({
                id: e._id,
                name: `${e.firstName} ${e.lastName || ""}`.trim(),
                biometricId: e.biometricId,
                hasToken: !!e.pushToken,
                tokenPreview: e.pushToken ? e.pushToken.substring(0, 35) + "..." : null,
                status: e.status,
                isActive: e.isActive,
            })),
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;