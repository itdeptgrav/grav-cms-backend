// services/accountantApprovalNotifications.service.js
//
// Notifications for the accountant approval workflow.
//
// WHAT TRIGGERS THIS
//   Post-save hooks on the Acc_ApprovalRequest model (see Acc_OrgModels.js)
//   call notifyApprovalEvent(doc, event) whenever a request is:
//     • created   → an editor submitted something (post / cancel / void a
//                   voucher) that needs review → notify owner + approvers
//     • approved  → an approver/owner approved it → notify the requester
//     • rejected  → an approver/owner rejected it → notify the requester
//   Because it hangs off the model, every submit/approve/reject site is
//   covered without editing any route file.
//
// CHANNELS
//   • Email — Brevo HTTP API. Works today: every Acc_User has an .email.
//             Reuses the same env the CoWork email service uses:
//               ENABLE_EMAILS=true, BREVO_API_KEY, CUSTOMER_SENDER_EMAIL
//   • Push  — FCM web push via config/firebaseAdmin. STAGED: it reads
//             Acc_User.fcmTokens, which stays empty until the accountant
//             frontend registers a device token (phase 2). Until then this
//             channel is a no-op — no error, just nothing to send to.
//
// SAFETY
//   Never throws back into the caller. The model hook fires this
//   fire-and-forget, so a mail/push failure can never break a voucher
//   submission or an approval.

const { Acc_User } = require("../models/Accountant_model/Acc_OrgModels");

// ── Config ──────────────────────────────────────────────────────────────────
const APP_URL = (
  process.env.ACCOUNTANT_APP_URL ||
  process.env.FRONTEND_URL ||
  "https://cms.grav.in"
).replace(/\/+$/, "");
const APPROVALS_URL = `${APP_URL}/accountant/approvals`;

// ── Firebase Admin (lazy; may be unconfigured) ──────────────────────────────
let _messaging = null; // null = untried, false = unavailable
function getMessaging() {
  if (_messaging !== null) return _messaging || null;
  try {
    const fb = require("../config/firebaseAdmin");
    _messaging = fb.messaging || false;
  } catch (e) {
    console.warn(
      "[acc-notif] firebaseAdmin unavailable — push disabled:",
      e.message,
    );
    _messaging = false;
  }
  return _messaging || null;
}

// ── FCM push to one user's device tokens (no-op until tokens exist) ─────────
async function sendPush(user, { title, body, url }) {
  const tokens = Array.isArray(user.fcmTokens)
    ? user.fcmTokens.filter(Boolean)
    : [];
  if (!tokens.length) return;
  const messaging = getMessaging();
  if (!messaging) return;

  const data = {
    title: String(title),
    body: String(body),
    type: "accountant_approval",
    url: String(url || APPROVALS_URL),
    timestamp: String(Date.now()),
  };

  const staleTokens = [];
  await Promise.all(
    tokens.map(async (token) => {
      try {
        await messaging.send({
          token,
          // Data-only: the service worker's onBackgroundMessage (now filled
          // in) draws the notification when the tab is closed/backgrounded,
          // and the in-app foreground listener draws it when the tab is open.
          data,
          webpush: {
            headers: { Urgency: "high", TTL: "0" },
            fcmOptions: { link: data.url },
          },
          apns: {
            headers: {
              "apns-priority": "10",
              "apns-push-type": "alert",
              "apns-expiration": "0",
            },
            payload: {
              aps: {
                alert: { title: data.title, body: data.body },
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
              title: data.title,
              body: data.body,
              channelId: "grav_default",
              priority: "max",
              defaultSound: true,
            },
          },
        });
      } catch (e) {
        const code = e.errorInfo?.code || e.code || "";
        if (
          code.includes("registration-token-not-registered") ||
          code.includes("invalid-registration") ||
          code.includes("invalid-argument") ||
          code.includes("not-registered")
        ) {
          staleTokens.push(token);
        } else {
          console.warn(`[acc-notif] push failed for ${user.email}:`, e.message);
        }
      }
    }),
  );

  if (staleTokens.length) {
    try {
      await Acc_User.updateOne(
        { _id: user._id },
        { $pull: { fcmTokens: { $in: staleTokens } } },
      );
    } catch (e) {
      console.warn("[acc-notif] stale token prune failed:", e.message);
    }
  }
}

// ── Recipient resolution ────────────────────────────────────────────────────
async function getApprovers(organizationId, excludeUserId) {
  // Owner + approvers are the people who can act on a pending request.
  const users = await Acc_User.find({
    organizationId,
    role: { $in: ["owner", "approver"] },
    isActive: true,
  })
    .select("name email role fcmTokens")
    .lean();
  return users.filter((u) => String(u._id) !== String(excludeUserId || ""));
}

async function getUser(userId) {
  if (!userId) return null;
  return Acc_User.findById(userId).select("name email role fcmTokens").lean();
}
// ── Main entry — called by the Acc_ApprovalRequest model hook ────────────────
async function notifyApprovalEvent(doc, event) {
  try {
    const requesterName = doc.requestedByName || "A teammate";
    const title = doc.title || "Change request";

    // ── New submission → notify approvers + owner ──────────────────────────
    if (event === "created") {
      const approvers = await getApprovers(doc.organizationId, doc.requestedBy);
      if (!approvers.length) {
        console.log("[acc-notif] no approvers/owner to notify for new request");
        return;
      }
      for (const u of approvers) {
        await sendPush(u, {
          title: "Approval needed",
          body: `${requesterName}: ${title}`,
          url: APPROVALS_URL,
        });
      }
      return;
    }

    // ── Decision → notify the original requester ───────────────────────────
    const requester = await getUser(doc.requestedBy);
    if (!requester) {
      console.log("[acc-notif] requester not found for decision notify");
      return;
    }
    const decidedBy = doc.reviewedByName || "An approver";

    let pushTitle;
    if (event === "approved") {
      pushTitle = "Request approved";
    } else if (event === "rejected") {
      pushTitle = "Request rejected";
    } else {
      return;
    }

    await sendPush(requester, {
      title: pushTitle,
      body: title,
      url: APPROVALS_URL,
    });
  } catch (e) {
    console.error("[acc-notif] notifyApprovalEvent error:", e.message);
  }
}

module.exports = { notifyApprovalEvent, sendPush, getMessaging };