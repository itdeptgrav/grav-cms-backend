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
        // Read tokens from BOTH storage locations:
        // 1. cowork_fcm_tokens/{id}.tokens  — saved by browser via useFCMToken.ts
        // 2. cowork_employees/{id}.fcmTokens — saved by backend saveFCMToken()
        const [fcmDocs, empDocs] = await Promise.all([
            Promise.all(recipientIds.map(id => db.collection("cowork_fcm_tokens").doc(id).get())),
            Promise.all(recipientIds.map(id => db.collection("cowork_employees").doc(id).get())),
        ]);

        const allTokens = new Set();

        fcmDocs.forEach(d => {
            if (!d.exists) return;
            const data = d.data();
            (data.tokens || []).forEach(t => t && allTokens.add(t));
            if (data.token) allTokens.add(data.token);
            if (data.latestToken) allTokens.add(data.latestToken);
        });

        empDocs.forEach(d => {
            if (!d.exists) return;
            const data = d.data();
            (data.fcmTokens || []).forEach(t => t && allTokens.add(t));
        });

        const tokens = [...allTokens].filter(Boolean);

        if (!tokens.length) {
            console.log(`[FCM] No tokens found for: ${recipientIds.join(", ")}`);
            return;
        }

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

        // Remove stale/invalid tokens from cowork_fcm_tokens
        const staleTokens = [];
        response.responses.forEach((resp, idx) => {
            if (!resp.success) {
                const code = resp.error?.code;
                if (
                    code === "messaging/invalid-registration-token" ||
                    code === "messaging/registration-token-not-registered"
                ) {
                    staleTokens.push(tokens[idx]);
                }
            }
        });
        if (staleTokens.length) {
            console.log(`[FCM] Removing ${staleTokens.length} stale token(s)`);
            // Remove from cowork_fcm_tokens
            await Promise.all(
                recipientIds.map(async id => {
                    const ref = db.collection("cowork_fcm_tokens").doc(id);
                    const snap = await ref.get();
                    if (!snap.exists) return;
                    const existing = snap.data().tokens || [];
                    const cleaned = existing.filter(t => !staleTokens.includes(t));
                    if (cleaned.length !== existing.length) {
                        await ref.update({ tokens: cleaned });
                    }
                })
            );
            // Remove from cowork_employees
            await Promise.all(
                recipientIds.map(async id => {
                    const ref = db.collection("cowork_employees").doc(id);
                    const snap = await ref.get();
                    if (!snap.exists) return;
                    const existing = snap.data().fcmTokens || [];
                    const cleaned = existing.filter(t => !staleTokens.includes(t));
                    if (cleaned.length !== existing.length) {
                        await ref.update({ fcmTokens: cleaned });
                    }
                })
            );
        }
    } catch (err) {
        console.error("[FCM] sendPushToEmployees error:", err.message);
    }
}

module.exports = { sendPushToEmployees };
