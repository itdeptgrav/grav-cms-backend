/**
 * utils/sendWebPush.js  (or wherever you place it in your backend)
 * Shared FCM Web Push helper — DATA-ONLY payloads.
 *
 * Why data-only?
 *   If you include a `notification` object, Chrome/FCM auto-displays it
 *   BEFORE the service worker's onBackgroundMessage fires. This causes:
 *     - "You have a new notification" generic text (Chrome's fallback)
 *     - Duplicate notifications
 *     - Notifications not coming from the PWA
 *   Data-only means onBackgroundMessage is the SINGLE display controller.
 */

const Employee = require("../models/Employee"); // adjust path as needed

const URL_MAP = {
  salary_credited: "/salary",
  payslip_generated: "/salary",
  payroll: "/salary",
  leave_applied: "/leave",
  leave_approved: "/leave",
  leave_rejected: "/leave",
  leave_withdrawn: "/leave",
  leave_cancelled: "/leave",
  overtime_required: "/overtime",
  overtime_approved: "/overtime",
  overtime_rejected: "/overtime",
  test: "/dashboard",
};

function getUrl(type) {
  return URL_MAP[type] || "/dashboard";
}

/**
 * Build a DATA-ONLY FCM payload.
 * No `notification` object anywhere — SW controls display entirely.
 */
function buildPayload({ title, body, type, url, extra = {} }) {
  const finalUrl = url || getUrl(type);

  // FCM requires all data values to be strings
  const data = {
    title,
    body,
    type: type || "general",
    url: finalUrl,
    timestamp: String(Date.now()),
    ...Object.fromEntries(
      Object.entries(extra).map(([k, v]) => [k, String(v ?? "")]),
    ),
  };

  return {
    // ── Data-only: SW handles display ──────────────────────────────────
    data,

    // ── Web push delivery options (no notification object!) ────────────
    webpush: {
      headers: { Urgency: "high", TTL: "0" },
      // NO webpush.notification — that's what causes Chrome auto-display
      fcmOptions: { link: finalUrl },
    },

    // ── APNs (iOS Safari 16.4+ PWA) ────────────────────────────────────
    apns: {
      headers: {
        "apns-priority": "10",
        "apns-push-type": "alert",
        "apns-expiration": "0",
      },
      payload: {
        aps: {
          alert: { title, body },
          badge: 1,
          sound: "default",
          "mutable-content": 1,
          "content-available": 1,
        },
        ...data,
      },
    },

    // ── Android native (future) ────────────────────────────────────────
    android: {
      priority: "high",
      ttl: 0,
      notification: {
        title,
        body,
        icon: "ic_notification",
        color: "#111827",
        sound: "default",
        channelId: "grav_default",
        priority: "max",
        defaultSound: true,
        defaultVibrateTimings: true,
      },
    },
  };
}

function getMessaging() {
  try {
    return require("../config/firebaseAdmin").messaging;
  } catch (e) {
    console.error("[WEB-PUSH] Firebase Admin not configured:", e.message);
    return null;
  }
}

async function clearStaleToken(id) {
  await Employee.findByIdAndUpdate(id, { $set: { fcmToken: null } }).catch(
    () => {},
  );
}

function isStaleError(code = "") {
  return (
    code.includes("not-registered") ||
    code.includes("invalid-registration") ||
    code.includes("third-party-auth")
  );
}

/**
 * Send push to a single employee by MongoDB _id.
 */
async function sendWebPush({ employeeId, title, body, type, url, extra }) {
  try {
    const emp = await Employee.findById(employeeId)
      .select("firstName fcmToken")
      .lean();
    if (!emp?.fcmToken) {
      console.log(`[WEB-PUSH] No FCM token for ${employeeId}`);
      return { sent: 0 };
    }

    const messaging = getMessaging();
    if (!messaging) return { sent: 0 };

    const payload = buildPayload({ title, body, type, url, extra });
    try {
      await messaging.send({ token: emp.fcmToken, ...payload });
      console.log(
        `[WEB-PUSH] ✅ Sent "${title}" to ${emp.firstName} (${type})`,
      );
      return { sent: 1 };
    } catch (err) {
      const code = err.errorInfo?.code || err.code || "";
      console.error(`[WEB-PUSH] ✗ ${emp.firstName}: ${code}`);
      if (isStaleError(code)) await clearStaleToken(employeeId);
      return { sent: 0 };
    }
  } catch (e) {
    console.error("[WEB-PUSH] sendWebPush error:", e.message);
    return { sent: 0 };
  }
}

/**
 * Send push to multiple employees by array of MongoDB _ids.
 */
async function sendWebPushToMany({
  employeeIds,
  title,
  body,
  type,
  url,
  extra,
}) {
  if (!employeeIds?.length) return { sent: 0, failed: 0 };
  try {
    const emps = await Employee.find({
      _id: { $in: employeeIds },
      fcmToken: { $exists: true, $nin: [null, ""] },
    })
      .select("firstName fcmToken")
      .lean();

    if (!emps.length) {
      console.log(
        `[WEB-PUSH] No FCM tokens for ${employeeIds.length} employee(s)`,
      );
      return { sent: 0, failed: 0 };
    }

    const messaging = getMessaging();
    if (!messaging) return { sent: 0, failed: emps.length };

    const payload = buildPayload({ title, body, type, url, extra });
    let sent = 0,
      failed = 0;

    for (const emp of emps) {
      try {
        await messaging.send({ token: emp.fcmToken, ...payload });
        console.log(`[WEB-PUSH] ✅ ${emp.firstName} (${type})`);
        sent++;
      } catch (err) {
        const code = err.errorInfo?.code || err.code || "";
        console.error(`[WEB-PUSH] ✗ ${emp.firstName}: ${code}`);
        failed++;
        if (isStaleError(code)) await clearStaleToken(emp._id);
      }
    }
    console.log(`[WEB-PUSH] ${type} — ${sent}/${emps.length} sent`);
    return { sent, failed };
  } catch (e) {
    console.error("[WEB-PUSH] sendWebPushToMany error:", e.message);
    return { sent: 0, failed: 0 };
  }
}

module.exports = { sendWebPush, sendWebPushToMany };
