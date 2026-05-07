/**
 * fcmPush.service.js
 * Sends FCM push to all devices of given employee IDs.
 * Reads tokens from both:
 *   - cowork_fcm_tokens/{id}.tokens  (browser/PWA via useFCMToken.ts)
 *   - cowork_employees/{id}.fcmTokens (backend saveFCMToken)
 */
const admin = require("firebase-admin");

const webpush = require("web-push");

// VAPID keys — must match NEXT_PUBLIC_FIREBASE_VAPID_KEY on frontend
// Get these from Firebase Console → Project Settings → Cloud Messaging → Web Push certificates
const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY || process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_EMAIL = process.env.VAPID_EMAIL || "mailto:admin@grav.in";

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

async function sendIOSWebPush(subscriptionJSON, title, body, data = {}) {
    try {
        const subscription = typeof subscriptionJSON === "string"
            ? JSON.parse(subscriptionJSON) : subscriptionJSON;
        const payload = JSON.stringify({ title, body, data });
        await webpush.sendNotification(subscription, payload);
        console.log("[WebPush] ✓ iOS push sent");
        return true;
    } catch (e) {
        console.warn("[WebPush] ✗ iOS push failed:", e.message);
        return false;
    }
}

async function sendPushToEmployees(recipientIds, title, body, data = {}) {
    if (!recipientIds?.length) return;
    const db = admin.firestore();

    console.log(`[FCM] ── Sending "${title}" to ${recipientIds.length} recipient(s): [${recipientIds.join(", ")}]`);

    try {
        // ── 1. Collect tokens from both Firestore locations ──────────────────
        const [fcmDocs, empDocs] = await Promise.all([
            Promise.all(recipientIds.map(id => db.collection("cowork_fcm_tokens").doc(id).get())),
            Promise.all(recipientIds.map(id => db.collection("cowork_employees").doc(id).get())),
        ]);

        // Map employeeId → tokens for detailed logging
        const tokenMap = {}; // { employeeId: [token1, token2] }

        recipientIds.forEach((id, i) => {
            const tokens = new Set();

            const fcmDoc = fcmDocs[i];
            if (fcmDoc.exists) {
                const d = fcmDoc.data();
                // Old format: tokens array
                (d.tokens || []).forEach(t => t && tokens.add(t));
                if (d.token) tokens.add(d.token);
                // Always use latestToken — most recent registration
                if (d.latestToken) tokens.add(d.latestToken);
                // New format: device_* keys — one per device, replaces stale tokens
                Object.keys(d).filter(k => k.startsWith("device_")).forEach(k => {
                    if (d[k]) tokens.add(d[k]);
                });
            } else {
                console.log(`[FCM]   ⚠️  ${id}: no doc in cowork_fcm_tokens`);
            }

            const empDoc = empDocs[i];
            if (empDoc.exists) {
                const d = empDoc.data();
                (d.fcmTokens || []).forEach(t => t && tokens.add(t));
            } else {
                console.log(`[FCM]   ⚠️  ${id}: employee doc not found`);
            }

            tokenMap[id] = [...tokens].filter(Boolean);
            console.log(`[FCM]   ${id}: ${tokenMap[id].length} token(s) found`);
        });

        // Flatten all unique tokens
        const allTokens = [...new Set(Object.values(tokenMap).flat())];

        if (!allTokens.length) {
            console.log(`[FCM] ✗ No tokens found for any recipient — push not sent`);
            console.log(`[FCM]   → Ask recipients to open the app once to register their device`);
            return;
        }

        // ── Separate iOS Web Push subscriptions from FCM tokens ──────────────
        const iosTokens = allTokens.filter(t => {
            try { const p = JSON.parse(t); return p && p.endpoint && p.keys; } catch { return false; }
        });
        const fcmTokens = allTokens.filter(t => {
            try { const p = JSON.parse(t); return !(p && p.endpoint && p.keys); } catch { return true; }
        });

        // ── 2. Build payload ─────────────────────────────────────────────────
        const dataPayload = Object.fromEntries(
            Object.entries({ title, body, type: "", url: "/coworking", ...data })
                .map(([k, v]) => [k, String(v ?? "")])
        );

        // Send iOS Web Push
        if (iosTokens.length) {
            console.log(`[WebPush] Sending to ${iosTokens.length} iOS subscription(s)`);
            await Promise.all(iosTokens.map(t => sendIOSWebPush(t, title, body, dataPayload)));
        }

        if (!fcmTokens.length) return;
        console.log(`[FCM] Sending to ${fcmTokens.length} FCM token(s) total`);

        const message = {
            // Top-level notification (Android background, some web)
            notification: { title, body },

            // Data payload (always included — sw.js reads this)
            data: dataPayload,

            // ── Web Push (Chrome, Firefox, Edge, desktop) ──
            webpush: {
                headers: { Urgency: "high", TTL: "0" },
                notification: {
                    title,
                    body,
                    icon: "/icons/icon-192x192.png",
                    badge: "/icons/badge-72x72.png",
                    requireInteraction: false,
                    vibrate: [200, 100, 200],
                    tag: `cowork-${data.type || "notif"}-${Date.now()}`,
                    renotify: true,
                    data: dataPayload,
                },
                fcmOptions: { link: "/coworking" },
            },

            // ── APNs (iOS Safari PWA — requires iOS 16.4+ & Add to Home Screen) ──
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
                    ...dataPayload,
                },
            },

            // ── Android (high priority for MIUI, OnePlus, Xiaomi etc.) ──
            android: {
                priority: "high",
                ttl: 0, // 0 = deliver NOW or drop — no queuing delay
                notification: {
                    title,
                    body,
                    icon: "ic_notification",
                    color: "#5B5EF4",
                    sound: "default",
                    channelId: "cowork_default",
                    priority: "max",
                    defaultSound: true,
                    defaultVibrateTimings: true,
                },
            },

            tokens: fcmTokens,
        };

        // ── 3. Send ───────────────────────────────────────────────────────────
        const response = await admin.messaging().sendEachForMulticast(message);
        console.log(`[FCM] ✓ ${response.successCount}/${allTokens.length} delivered`);

        // ── 4. Log failures + remove stale tokens ─────────────────────────────
        const staleTokens = [];
        response.responses.forEach((resp, idx) => {
            if (resp.success) {
                console.log(`[FCM]   ✓ Token[${idx}] delivered`);
            } else {
                const code = resp.error?.code || "unknown";
                const msg = resp.error?.message || "";
                console.log(`[FCM]   ✗ Token[${idx}] FAILED — ${code}: ${msg}`);

                if (
                    code === "messaging/invalid-registration-token" ||
                    code === "messaging/registration-token-not-registered" ||
                    code === "messaging/invalid-argument"
                ) {
                    staleTokens.push(allTokens[idx]);
                }

                // Common failure reasons for debugging
                if (code === "messaging/message-rate-exceeded") {
                    console.log(`[FCM]   ℹ️  Rate limited — too many messages to this device`);
                }
                if (code === "messaging/device-message-rate-exceeded") {
                    console.log(`[FCM]   ℹ️  Device rate limit — reduce frequency`);
                }
                if (code === "messaging/mismatched-credential") {
                    console.log(`[FCM]   ℹ️  Wrong Firebase project — check GOOGLE_APPLICATION_CREDENTIALS`);
                }
            }
        });

        // ── 5. Clean up stale tokens ──────────────────────────────────────────
        if (staleTokens.length) {
            console.log(`[FCM] Removing ${staleTokens.length} stale token(s) from Firestore`);
            await Promise.all(recipientIds.map(async id => {
                // Clean cowork_fcm_tokens
                const fcmRef = db.collection("cowork_fcm_tokens").doc(id);
                const fcmSnap = await fcmRef.get();
                if (fcmSnap.exists) {
                    const d = fcmSnap.data();
                    const updates = {};
                    // Clean old tokens array
                    const existing = d.tokens || [];
                    const cleaned = existing.filter(t => !staleTokens.includes(t));
                    if (cleaned.length !== existing.length) updates.tokens = cleaned;
                    // Clean new device_* keys
                    Object.keys(d).filter(k => k.startsWith("device_")).forEach(k => {
                        if (staleTokens.includes(d[k])) updates[k] = admin.firestore.FieldValue.delete();
                    });
                    // Clean latestToken if stale
                    if (d.latestToken && staleTokens.includes(d.latestToken)) updates.latestToken = null;
                    if (Object.keys(updates).length) await fcmRef.update(updates);
                }
                // Clean cowork_employees
                const empRef = db.collection("cowork_employees").doc(id);
                const empSnap = await empRef.get();
                if (empSnap.exists) {
                    const existing = empSnap.data().fcmTokens || [];
                    const cleaned = existing.filter(t => !staleTokens.includes(t));
                    if (cleaned.length !== existing.length) {
                        await empRef.update({ fcmTokens: cleaned });
                    }
                }
            }));
        }

    } catch (err) {
        console.error(`[FCM] ✗ Fatal error: ${err.message}`);
        if (err.code === "app/invalid-credential") {
            console.error("[FCM] ℹ️  Check GOOGLE_APPLICATION_CREDENTIALS env var");
        }
    }
}

module.exports = { sendPushToEmployees };
