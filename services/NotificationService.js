// services/NotificationService.js
//
// Web-push notification service.
//
// Setup (one time):
//   npm i web-push
//   npx web-push generate-vapid-keys
//   .env:
//     VAPID_PUBLIC_KEY=...
//     VAPID_PRIVATE_KEY=...
//     VAPID_SUBJECT=mailto:admin@gravclothing.com
//
// Usage:
//   const NotificationService = require("../services/NotificationService");
//   await NotificationService.sendToRole("projectManager", {
//     title: "New MRF", body: "MRF-2607-0002 awaiting approval",
//     url: "/project-manager/dashboard/requests",
//   });

const webpush = require("web-push");
const PushSubscription = require("../models/CMS_Models/Notifications/PushSubscription");

const PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || "";
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const SUBJECT     = process.env.VAPID_SUBJECT     || "mailto:admin@example.com";

let configured = false;
if (PUBLIC_KEY && PRIVATE_KEY) {
  webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
  configured = true;
} else {
  console.warn("[NotificationService] VAPID keys missing — push notifications disabled.");
}

// ── internal: push to one subscription, prune dead ones ────────────────────
async function pushToSubscription(sub, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys },
      JSON.stringify(payload)
    );
    return true;
  } catch (err) {
    // 404 / 410 → subscription is dead (browser revoked it). Remove it.
    if (err.statusCode === 404 || err.statusCode === 410) {
      await PushSubscription.deleteOne({ endpoint: sub.endpoint }).catch(() => {});
    } else {
      console.error("[NotificationService] push failed:", err.statusCode, err.message);
    }
    return false;
  }
}

const NotificationService = {
  isConfigured: () => configured,
  getPublicKey: () => PUBLIC_KEY,

  // Save / refresh a browser subscription
  async saveSubscription({ endpoint, keys, userRef, userName, role, userAgent }) {
    if (!endpoint || !keys?.p256dh || !keys?.auth) throw new Error("Invalid subscription");
    return PushSubscription.findOneAndUpdate(
      { endpoint },
      { endpoint, keys, userRef: userRef || null, userName: userName || "",
        role: role || "", userAgent: userAgent || "", lastUsedAt: new Date() },
      { upsert: true, new: true }
    );
  },

  async removeSubscription(endpoint) {
    if (!endpoint) return;
    await PushSubscription.deleteOne({ endpoint });
  },

  // Broadcast to every browser subscribed under a role (or list of roles)
  async sendToRole(roles, payload) {
    if (!configured) return { sent: 0, skipped: true };
    const roleList = Array.isArray(roles) ? roles : [roles];
    const subs = await PushSubscription.find({ role: { $in: roleList } }).lean();
    let sent = 0;
    await Promise.all(subs.map(async s => { if (await pushToSubscription(s, payload)) sent++; }));
    return { sent, total: subs.length };
  },

  // Send to one specific user's browsers
  async sendToUser(userRef, payload) {
    if (!configured || !userRef) return { sent: 0, skipped: true };
    const subs = await PushSubscription.find({ userRef }).lean();
    let sent = 0;
    await Promise.all(subs.map(async s => { if (await pushToSubscription(s, payload)) sent++; }));
    return { sent, total: subs.length };
  },
};

module.exports = NotificationService;