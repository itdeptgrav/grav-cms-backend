const { Expo } = require("expo-server-sdk");
const Employee = require("../models/Employee");

// Create Expo SDK client
const expo = new Expo();

// ── Send payroll notification to all employees ───────────────────────────
async function sendPayrollNotifications(month, year, employeeIds = [], type = "generated") {
    try {
        const MONTH_NAMES = [
            "", "January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December",
        ];

        // *** FIXED: Query filter excludes both null AND empty string ***
        const filter = {
            pushToken: { $exists: true, $nin: [null, ""] },
            $or: [{ status: "active" }, { isActive: true }],
        };
        if (employeeIds.length > 0) {
            filter._id = { $in: employeeIds };
        }

        console.log("[PUSH] ── Querying employees with push tokens...");
        console.log("[PUSH] Query filter:", JSON.stringify(filter));

        const employees = await Employee.find(filter)
            .select("pushToken firstName lastName biometricId status isActive")
            .lean();

        console.log(`[PUSH] Found ${employees.length} employee(s) with push tokens`);

        if (employees.length === 0) {
            console.log("[PUSH] ❌ No employees with push tokens found");
            console.log("[PUSH]    Check that:");
            console.log("[PUSH]    1. Employees have status 'active' or isActive: true");
            console.log("[PUSH]    2. pushToken field is saved (not null/empty)");
            console.log("[PUSH]    3. Mobile app has registered tokens successfully");
            return { sent: 0, failed: 0 };
        }

        // Log each employee found
        for (const emp of employees) {
            console.log(`[PUSH]   → ${emp.firstName} ${emp.lastName || ""} | token: ${emp.pushToken?.substring(0, 35)}...`);
        }

        // Build notification messages
        const messages = [];
        const tokenToEmpId = new Map();

        for (const emp of employees) {
            if (!Expo.isExpoPushToken(emp.pushToken)) {
                console.warn(`[PUSH] ✗ Invalid token for ${emp.firstName}: "${emp.pushToken}"`);
                await Employee.findByIdAndUpdate(emp._id, { pushToken: null });
                continue;
            }

            tokenToEmpId.set(emp.pushToken, emp._id);

            // Different messages for generated vs paid
            const title = type === "paid"
                ? "✅ Salary Credited"
                : "💰 Payslip Generated";
            const body = type === "paid"
                ? `Hi ${emp.firstName}, your salary for ${MONTH_NAMES[month]} ${year} has been credited. Open the app to view your payslip.`
                : `Hi ${emp.firstName}, your payslip for ${MONTH_NAMES[month]} ${year} has been processed. Open the app to view details.`;

            messages.push({
                to: emp.pushToken,
                sound: "default",
                title,
                body,
                data: {
                    type: "payroll",
                    month,
                    year,
                    screen: "Salary",
                },
                channelId: "payroll",
                priority: "high",
                badge: 1,
                categoryId: "payroll",
            });
        }

        if (messages.length === 0) {
            console.log("[PUSH] No valid tokens to send after filtering");
            return { sent: 0, failed: 0 };
        }

        console.log(`[PUSH] Sending ${messages.length} notification(s) via Expo Push API...`);

        // Send in chunks
        const chunks = expo.chunkPushNotifications(messages);
        let sent = 0, failed = 0;
        const staleTokens = [];

        for (const chunk of chunks) {
            try {
                const receipts = await expo.sendPushNotificationsAsync(chunk);
                console.log(`[PUSH] Receipts:`, JSON.stringify(receipts));

                for (let i = 0; i < receipts.length; i++) {
                    const receipt = receipts[i];
                    if (receipt.status === "ok") {
                        sent++;
                        console.log(`[PUSH] ✓ OK → ${chunk[i].to.substring(0, 35)}...`);
                    } else {
                        failed++;
                        console.warn(`[PUSH] ✗ FAIL → ${chunk[i].to}: ${receipt.message || JSON.stringify(receipt.details)}`);
                        if (receipt.details?.error === "DeviceNotRegistered") {
                            const token = chunk[i]?.to;
                            if (token && tokenToEmpId.has(token)) {
                                staleTokens.push(tokenToEmpId.get(token));
                            }
                        }
                    }
                }
            } catch (err) {
                console.error("[PUSH] CHUNK SEND ERROR:", err.message);
                failed += chunk.length;
            }
        }

        // Clean up stale tokens
        if (staleTokens.length > 0) {
            await Employee.updateMany(
                { _id: { $in: staleTokens } },
                { $set: { pushToken: null } }
            ).catch(e => console.warn("[PUSH] Cleanup failed:", e.message));
            console.log(`[PUSH] Cleaned ${staleTokens.length} stale token(s)`);
        }

        console.log(`[PUSH] ══ RESULT: ${sent} sent, ${failed} failed ══`);
        return { sent, failed };
    } catch (err) {
        console.error("[PUSH] CRITICAL ERROR in sendPayrollNotifications:", err.message, err.stack);
        return { sent: 0, failed: 0, error: err.message };
    }
}

// ── Send notification to a specific employee ─────────────────────────────
async function sendNotificationToEmployee(employeeId, title, body, data = {}) {
    try {
        const emp = await Employee.findById(employeeId).select("pushToken firstName").lean();
        if (!emp?.pushToken || !Expo.isExpoPushToken(emp.pushToken)) {
            console.log(`[PUSH] No valid token for employee ${employeeId}`);
            return false;
        }

        console.log(`[PUSH] Sending to ${emp.firstName}: "${title}"`);

        const receipts = await expo.sendPushNotificationsAsync([{
            to: emp.pushToken,
            sound: "default",
            title,
            body,
            data,
            channelId: "general",
            priority: "high",
        }]);

        console.log(`[PUSH] Receipt:`, JSON.stringify(receipts[0]));

        if (receipts[0]?.status !== "ok") {
            if (receipts[0]?.details?.error === "DeviceNotRegistered") {
                await Employee.findByIdAndUpdate(employeeId, { pushToken: null });
            }
            return false;
        }
        return true;
    } catch (err) {
        console.error(`[PUSH] Failed to notify ${employeeId}:`, err.message);
        return false;
    }
}

module.exports = { sendPayrollNotifications, sendNotificationToEmployee };