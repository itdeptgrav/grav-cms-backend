/**
 * utils/sendWebPush.js
 * Shared FCM Web Push helper. Use this in any route/service to send
 * background push notifications to employees.
 */

const Employee = require("../models/Employee");

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

function buildPayload({ title, body, type, url, extra = {} }) {
  const finalUrl = url || getUrl(type);
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
    data,
    webpush: {
      headers: { Urgency: "high", TTL: "0" },
      notification: {
        title,
        body,
        icon: "/icon.png",
        badge: "/icon.png",
        requireInteraction: false,
        vibrate: [200, 100, 200],
        tag: "grav-" + (type || "notif") + "-" + Date.now(),
        renotify: true,
        data,
      },
      fcmOptions: { link: finalUrl },
    },
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

/**
 * Send push to a single employee by MongoDB _id.
 */
async function sendWebPush({ employeeId, title, body, type, url, extra }) {
  try {
    const emp = await Employee.findById(employeeId)
      .select("firstName fcmToken")
      .lean();
    if (!emp?.fcmToken) return { sent: 0 };

    const messaging = getMessaging();
    if (!messaging) return { sent: 0 };

    const payload = buildPayload({ title, body, type, url, extra });
    try {
      await messaging.send({ token: emp.fcmToken, ...payload });
      console.log("[WEB-PUSH] Sent to", emp.firstName, "(" + type + ")");
      return { sent: 1 };
    } catch (err) {
      const code = err.errorInfo?.code || err.code || "";
      console.error("[WEB-PUSH] Failed for", emp.firstName, code);
      if (
        code.includes("not-registered") ||
        code.includes("invalid-registration") ||
        code.includes("third-party-auth")
      ) {
        await clearStaleToken(employeeId);
      }
      return { sent: 0 };
    }
  } catch (e) {
    console.error("[WEB-PUSH] Error:", e.message);
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

    if (!emps.length) return { sent: 0, failed: 0 };

    const messaging = getMessaging();
    if (!messaging) return { sent: 0, failed: emps.length };

    const payload = buildPayload({ title, body, type, url, extra });
    let sent = 0,
      failed = 0;

    for (const emp of emps) {
      try {
        await messaging.send({ token: emp.fcmToken, ...payload });
        console.log("[WEB-PUSH] Sent to", emp.firstName, "(" + type + ")");
        sent++;
      } catch (err) {
        const code = err.errorInfo?.code || err.code || "";
        failed++;
        if (
          code.includes("not-registered") ||
          code.includes("invalid-registration") ||
          code.includes("third-party-auth")
        ) {
          await clearStaleToken(emp._id);
        }
      }
    }
    console.log("[WEB-PUSH]", type, "—", sent + "/" + emps.length, "sent");
    return { sent, failed };
  } catch (e) {
    console.error("[WEB-PUSH] Error:", e.message);
    return { sent: 0, failed: 0 };
  }
}

module.exports = { sendWebPush, sendWebPushToMany };
