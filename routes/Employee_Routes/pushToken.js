// routes/Employee_Routes/pushToken.js
//
// Handles BOTH push token types in a single route:
//   • Mobile: Expo push tokens (ExponentPushToken[...])  → stored in `pushToken`
//   • Web:    FCM web tokens (long opaque strings)        → stored in `fcmToken`
//
// Frontend sends either:
//   POST /push-token  { pushToken: "ExponentPushToken[...]" }                  // mobile (legacy)
//   POST /push-token  { fcmToken: "...", platform: "web" }                     // web
//   POST /push-token  { token: "...", platform: "web" | "mobile" }             // unified
//
// Logout (DELETE) accepts:
//   DELETE /push-token                        → clears BOTH tokens (when platform unknown)
//   DELETE /push-token?platform=web           → clears ONLY fcmToken (web logout)
//   DELETE /push-token?platform=mobile        → clears ONLY pushToken (mobile logout)

const express = require("express");
const router = express.Router();
const Employee = require("../../models/Employee");
const AllEmployeeAppMiddleware = require("../../Middlewear/AllEmployeeAppMiddleware");
const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");

// ═══════════════════════════════════════════════════════════════════════════
// POST /push-token  — register a device token (mobile or web)
// ═══════════════════════════════════════════════════════════════════════════
router.post("/push-token", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const { pushToken, fcmToken, token, platform } = req.body;

    // Decide which kind of token this is
    // Priority: explicit pushToken/fcmToken fields, then `token` + platform hint
    let isWeb = false;
    let isMobile = false;
    let tokenValue = null;

    if (pushToken) {
      // Caller explicitly said this is a mobile Expo token
      isMobile = true;
      tokenValue = pushToken;
    } else if (fcmToken) {
      // Caller explicitly said this is a web FCM token
      isWeb = true;
      tokenValue = fcmToken;
    } else if (token) {
      // Unified field — use platform hint
      tokenValue = token;
      if (platform === "web") {
        isWeb = true;
      } else if (
        platform === "mobile" ||
        platform === "ios" ||
        platform === "android"
      ) {
        isMobile = true;
      } else {
        // Heuristic: Expo tokens start with "ExponentPushToken["
        if (token.startsWith("ExponentPushToken[")) {
          isMobile = true;
        } else {
          // Default to web for unrecognized formats
          isWeb = true;
        }
      }
    }

    if (!tokenValue) {
      console.warn(`[PUSH-TOKEN] ❌ Empty token from employee ${req.user.id}`);
      return res.status(400).json({
        success: false,
        message: "Token required (pushToken, fcmToken, or token field)",
      });
    }

    // Validate mobile tokens against Expo format
    if (isMobile) {
      const { Expo } = require("expo-server-sdk");
      if (!Expo.isExpoPushToken(tokenValue)) {
        console.warn(
          `[PUSH-TOKEN] ❌ Invalid Expo token format from ${req.user.id}: ${tokenValue.substring(0, 40)}`,
        );
        return res.status(400).json({
          success: false,
          message: "Invalid Expo push token format",
        });
      }
    }

    // Web FCM tokens are opaque base64-ish strings, usually 140-200+ chars
    // No strict format check — just sanity bounds
    if (isWeb) {
      if (tokenValue.length < 50 || tokenValue.length > 4096) {
        console.warn(
          `[PUSH-TOKEN] ❌ Suspicious FCM token length (${tokenValue.length}) from ${req.user.id}`,
        );
        return res.status(400).json({
          success: false,
          message: "Invalid FCM web token",
        });
      }
    }

    // Build update — only touch the relevant field, never overwrite the other
    const update = {};
    if (isMobile) update.pushToken = tokenValue;
    if (isWeb) update.fcmToken = tokenValue;

    const result = await Employee.findByIdAndUpdate(
      req.user.id,
      { $set: update },
      { new: true, runValidators: false },
    ).select("firstName pushToken fcmToken");

    if (!result) {
      console.error(`[PUSH-TOKEN] ❌ Employee ${req.user.id} not found`);
      return res
        .status(404)
        .json({ success: false, message: "Employee not found" });
    }

    const kind = isMobile ? "mobile (Expo)" : "web (FCM)";
    console.log(
      `[PUSH-TOKEN] ✅ ${kind} token saved for ${result.firstName} (${req.user.id}): ${tokenValue.substring(0, 35)}...`,
    );

    res.json({
      success: true,
      message: `${kind} token registered`,
      platform: isMobile ? "mobile" : "web",
    });
  } catch (err) {
    console.error("[PUSH-TOKEN] ❌ Error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// DELETE /push-token  — remove a device token on logout
// Query: ?platform=web | ?platform=mobile  (optional — defaults to clearing both)
// ═══════════════════════════════════════════════════════════════════════════
router.delete("/push-token", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const platform = req.query.platform || req.body?.platform || null;

    const update = {};
    if (platform === "web") {
      update.fcmToken = null;
    } else if (
      platform === "mobile" ||
      platform === "ios" ||
      platform === "android"
    ) {
      update.pushToken = null;
    } else {
      // No platform specified — clear both (legacy behavior, but logs the choice)
      update.pushToken = null;
      update.fcmToken = null;
    }

    await Employee.findByIdAndUpdate(
      req.user.id,
      { $set: update },
      { runValidators: false },
    );

    const cleared = Object.keys(update).join(", ");
    console.log(
      `[PUSH-TOKEN] Cleared [${cleared}] for employee ${req.user.id} (platform=${platform || "all"})`,
    );
    res.json({ success: true, message: "Push token removed" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /push-token/debug  — see what tokens this user has + overall stats
// ═══════════════════════════════════════════════════════════════════════════
router.get("/push-token/debug", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const emp = await Employee.findById(req.user.id)
      .select("firstName lastName pushToken fcmToken status isActive")
      .lean();
    if (!emp)
      return res.json({ success: false, message: "Employee not found" });

    const { Expo } = require("expo-server-sdk");
    const isValidExpoToken = emp.pushToken
      ? Expo.isExpoPushToken(emp.pushToken)
      : false;

    const [totalMobile, totalWeb] = await Promise.all([
      Employee.countDocuments({
        pushToken: { $exists: true, $nin: [null, ""] },
        $or: [{ status: "active" }, { isActive: true }],
      }),
      Employee.countDocuments({
        fcmToken: { $exists: true, $nin: [null, ""] },
        $or: [{ status: "active" }, { isActive: true }],
      }),
    ]);

    res.json({
      success: true,
      data: {
        name: `${emp.firstName} ${emp.lastName || ""}`.trim(),
        mobile: {
          hasToken: !!emp.pushToken && emp.pushToken !== "",
          tokenPreview: emp.pushToken
            ? emp.pushToken.substring(0, 40) + "..."
            : null,
          isValidExpoToken,
        },
        web: {
          hasToken: !!emp.fcmToken && emp.fcmToken !== "",
          tokenPreview: emp.fcmToken
            ? emp.fcmToken.substring(0, 40) + "..."
            : null,
        },
        status: emp.status,
        isActive: emp.isActive,
        totalEmployeesWithMobileTokens: totalMobile,
        totalEmployeesWithWebTokens: totalWeb,
      },
    });
  } catch (err) {
    console.error("[PUSH-TOKEN-DEBUG]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/test-web-push", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const { title, body, url } = req.body;

    const Employee = require("../../models/Employee");
    const emp = await Employee.findById(userId)
      .select("firstName lastName fcmToken")
      .lean();

    if (!emp)
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    if (!emp.fcmToken)
      return res.status(400).json({
        success: false,
        message:
          "No fcmToken registered. Log in on web first and allow notifications.",
      });

    let messaging;
    try {
      messaging = require("../../config/firebaseAdmin").messaging;
    } catch (e) {
      return res.status(500).json({
        success: false,
        message: "Firebase Admin not configured: " + e.message,
      });
    }

    const finalTitle = title || "🔔 Test Push";
    const finalBody = body || `Hello ${emp.firstName}, this is a test push.`;
    const finalUrl = url || "/dashboard";

    const dataPayload = {
      title: finalTitle,
      body: finalBody,
      type: "test",
      url: finalUrl,
      timestamp: String(Date.now()),
    };

    console.log(
      `[TEST-PUSH] Sending to ${emp.firstName} (${emp.fcmToken.substring(0, 30)}...)`,
    );

    try {
      const result = await messaging.send({
        token: emp.fcmToken,

        // Top-level data — SW reads these via payload.data
        data: dataPayload,

        // ── Web Push — NO notification object (data-only prevents Chrome auto-display) ──
        webpush: {
          headers: { Urgency: "high", TTL: "0" },
          fcmOptions: { link: finalUrl },
        },

        // ── APNs (iOS Safari 16.4+ PWA) ──
        apns: {
          headers: {
            "apns-priority": "10",
            "apns-push-type": "alert",
            "apns-expiration": "0",
          },
          payload: {
            aps: {
              alert: { title: finalTitle, body: finalBody },
              badge: 1,
              sound: "default",
              "mutable-content": 1,
              "content-available": 1,
            },
            ...dataPayload,
          },
        },

        // ── Android native (for future mobile-app use) ──
        android: {
          priority: "high",
          ttl: 0,
          notification: {
            title: finalTitle,
            body: finalBody,
            icon: "ic_notification",
            color: "#111827",
            sound: "default",
            channelId: "grav_default",
            priority: "max",
            defaultSound: true,
            defaultVibrateTimings: true,
          },
        },
      });

      console.log(`[TEST-PUSH] ✓ Sent. FCM messageId:`, result);
      res.json({
        success: true,
        message: `Push sent to ${emp.firstName} ${emp.lastName} (FCM messageId: ${result})`,
        messageId: result,
      });
    } catch (err) {
      const code = err.errorInfo?.code || err.code || "unknown";
      console.error(`[TEST-PUSH] ✗ FCM error (${code}):`, err.message);

      if (
        code === "messaging/registration-token-not-registered" ||
        code === "messaging/invalid-registration-token" ||
        code === "messaging/third-party-auth-error"
      ) {
        await Employee.findByIdAndUpdate(userId, { $set: { fcmToken: null } });
        return res.status(400).json({
          success: false,
          message: `Stale token cleared. Log out and back in on web to register a fresh one. (${code})`,
        });
      }

      return res.status(500).json({
        success: false,
        message: `FCM send failed: ${err.message} (${code})`,
      });
    }
  } catch (e) {
    console.error("[TEST-PUSH] Route error:", e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
