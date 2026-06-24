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

const axios = require("axios");
const { Acc_User } = require("../models/Accountant_model/Acc_OrgModels");

// ── Config ──────────────────────────────────────────────────────────────────
const BREVO_URL = "https://api.brevo.com/v3/smtp/email";
const FROM_EMAIL = process.env.CUSTOMER_SENDER_EMAIL || "noreply@grav.in";
const FROM_NAME = "GRAV Accounts";
const APP_URL = (
  process.env.ACCOUNTANT_APP_URL ||
  process.env.FRONTEND_URL ||
  "https://cms.grav.in"
).replace(/\/+$/, "");
const APPROVALS_URL = `${APP_URL}/accountant/approvals`;

function emailsEnabled() {
  return process.env.ENABLE_EMAILS === "true" && !!process.env.BREVO_API_KEY;
}

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

// ── Brevo send (single recipient) ───────────────────────────────────────────
async function sendEmail({ toEmail, toName, subject, html, text }) {
  if (!toEmail) return;
  if (!emailsEnabled()) {
    console.log(
      `[acc-notif] email skipped (ENABLE_EMAILS!=true or BREVO_API_KEY unset): "${subject}" -> ${toEmail}`,
    );
    return;
  }
  try {
    await axios.post(
      BREVO_URL,
      {
        sender: { name: FROM_NAME, email: FROM_EMAIL },
        to: [{ email: toEmail, name: toName || toEmail.split("@")[0] }],
        subject,
        htmlContent: html,
        textContent: text,
        headers: {
          "X-Mailer": "GRAV-Accounts-Notifications",
          "X-Priority": "3",
        },
      },
      {
        headers: {
          "api-key": process.env.BREVO_API_KEY,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        timeout: 10000,
      },
    );
    console.log(`[acc-notif] email sent: "${subject}" -> ${toEmail}`);
  } catch (e) {
    console.error(
      `[acc-notif] email FAILED "${subject}" -> ${toEmail}:`,
      e.response?.data?.message || e.message,
    );
  }
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

// ── HTML helpers ────────────────────────────────────────────────────────────
function wrap(heading, inner) {
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a">
  <div style="background:#4f46e5;padding:16px 24px"><span style="color:#fff;font-size:18px;font-weight:700">GRAV Accounts</span></div>
  <div style="padding:24px">
    <h2 style="font-size:16px;margin:0 0 16px">${heading}</h2>
    ${inner}
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
    <p style="font-size:12px;color:#888">Automated notification from the GRAV accounting workspace.</p>
  </div>
</div>`;
}
function btn(label, url) {
  return `<p><a href="${url}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600">${label}</a></p>`;
}
function callout(text) {
  return `<p style="font-size:15px;background:#f5f5ff;border-left:3px solid #4f46e5;padding:10px 12px;border-radius:0 6px 6px 0;margin:12px 0">${text}</p>`;
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
      const subject = `Approval needed: ${title}`;
      for (const u of approvers) {
        const html = wrap(
          "A request needs your approval",
          `<p>Dear ${u.name || "there"},</p>
           <p><strong>${requesterName}</strong> submitted a change that needs an approver's review:</p>
           ${callout(title)}
           ${btn("Review in Approvals", APPROVALS_URL)}`,
        );
        const text = `${requesterName} submitted a change that needs approval:\n${title}\n\nReview: ${APPROVALS_URL}`;
        await sendEmail({
          toEmail: u.email,
          toName: u.name,
          subject,
          html,
          text,
        });
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

    let subject;
    let heading;
    let line;
    let pushTitle;
    if (event === "approved") {
      subject = `Approved: ${title}`;
      heading = "Your request was approved";
      line = `<strong>${decidedBy}</strong> approved your request. It has been applied.`;
      pushTitle = "Request approved";
    } else if (event === "rejected") {
      subject = `Rejected: ${title}`;
      heading = "Your request was rejected";
      const note = doc.reviewNote
        ? `<br><span style="color:#b91c1c">Reason: ${doc.reviewNote}</span>`
        : "";
      line = `<strong>${decidedBy}</strong> rejected your request. No change was applied.${note}`;
      pushTitle = "Request rejected";
    } else {
      return; // other statuses (e.g. withdrawn) are not notified
    }

    const html = wrap(
      heading,
      `<p>Dear ${requester.name || "there"},</p>
       <p>${line}</p>
       ${callout(title)}
       ${btn("Open Approvals", APPROVALS_URL)}`,
    );
    const text = `${heading}\n${title}\n\nOpen: ${APPROVALS_URL}`;
    await sendEmail({
      toEmail: requester.email,
      toName: requester.name,
      subject,
      html,
      text,
    });
    await sendPush(requester, {
      title: pushTitle,
      body: title,
      url: APPROVALS_URL,
    });
  } catch (e) {
    console.error("[acc-notif] notifyApprovalEvent error:", e.message);
  }
}

module.exports = { notifyApprovalEvent };
