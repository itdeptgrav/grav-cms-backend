/**
 * cowork-backend/services/fcmPush.service.js
 * Sends FCM push notifications to employee devices.
 * Reads FCM tokens from Firestore: cowork_fcm_tokens/{employeeId}
 */
const admin = require("firebase-admin");

async function sendPushToEmployees(recipientIds, title, body, data = {}) {
    if (!recipientIds?.length) return;
    const db = admin.firestore();

    try {
        // Fetch tokens for all recipients
        const tokenDocs = await Promise.all(
            recipientIds.map(id => db.collection("cowork_fcm_tokens").doc(id).get())
        );

        const validDocs = tokenDocs.filter(d => d.exists && (d.data()?.tokens?.length || d.data()?.token));
        // Support both new (tokens array) and legacy (single token) format
        const tokens = [...new Set(
            validDocs.flatMap(d => {
                const data = d.data();
                if (data.tokens?.length) return data.tokens;        // new: array
                if (data.token) return [data.token];                 // legacy: single
                return [];
            })
        )];

        if (!tokens.length) return; // no devices registered yet

        const message = {
            notification: { title, body },
            data: Object.fromEntries(
                Object.entries({ type: "", url: "/coworking", ...data })
                    .map(([k, v]) => [k, String(v ?? "")])
            ),
            webpush: {
                notification: {
                    title,
                    body,
                    icon: "/favicon.ico",
                    badge: "/favicon.ico",
                    requireInteraction: false,
                },
                fcmOptions: { link: "/coworking" },
            },
            tokens,
        };

        const response = await admin.messaging().sendEachForMulticast(message);
        console.log(`[FCM] ${response.successCount}/${tokens.length} delivered`);

        // Remove stale/invalid tokens
        response.responses.forEach((resp, idx) => {
            if (!resp.success) {
                const code = resp.error?.code;
                if (
                    code === "messaging/invalid-registration-token" ||
                    code === "messaging/registration-token-not-registered"
                ) {
                    validDocs[idx]?.ref?.delete().catch(() => { });
                }
            }
        });
    } catch (err) {
        console.error("[FCM] sendPushToEmployees error:", err.message);
    }
}

module.exports = { sendPushToEmployees };