// GRAV-CMS-BACKEND/routes/services/googleEmployeeGmailService.js
// Per-employee Gmail — each employee connects their own Google account.
// Their refresh token is stored in Firestore cowork_employees/{empId}.gmailToken

const { google } = require("googleapis");
const { db, admin } = require("../../config/firebaseAdmin");

// Build an OAuth2 client for a specific employee using their stored token
function buildOAuth2Client(gmailToken) {
    const client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI_EMPLOYEE || process.env.GOOGLE_REDIRECT_URI
    );
    client.setCredentials({ refresh_token: gmailToken.refresh_token });
    return client;
}

// Generate OAuth URL for an employee — state = employeeId so callback knows who
function getEmployeeAuthUrl(employeeId) {
    const client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI_EMPLOYEE || process.env.GOOGLE_REDIRECT_URI
    );
    return client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: [
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/userinfo.email",
            "https://www.googleapis.com/auth/userinfo.profile",
        ],
        state: employeeId,
    });
}

// Exchange code for tokens and save to Firestore
async function saveEmployeeGmailToken(employeeId, code) {
    const client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI_EMPLOYEE || process.env.GOOGLE_REDIRECT_URI
    );
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) throw new Error("No refresh_token returned. Try disconnecting and reconnecting Gmail.");

    // Get user info to know which Gmail address was connected
    client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: "v2", auth: client });
    const userInfo = await oauth2.userinfo.get();
    const connectedEmail = userInfo.data.email;

    // Save to Firestore using existing db instance
    await db.collection("cowork_employees").doc(employeeId).update({
        gmailToken: {
            refresh_token: tokens.refresh_token,
            connectedEmail,
            connectedAt: new Date().toISOString(),
        },
    });
    return { connectedEmail };
}

// Get an employee's stored Gmail token from Firestore
async function getEmployeeGmailToken(employeeId) {
    const snap = await db.collection("cowork_employees").doc(employeeId).get();
    if (!snap.exists) throw new Error("Employee not found");
    const data = snap.data();
    if (!data.gmailToken || !data.gmailToken.refresh_token) return null;
    return data.gmailToken;
}

// Disconnect Gmail for an employee
async function disconnectEmployeeGmail(employeeId) {
    await db.collection("cowork_employees").doc(employeeId).update({
        gmailToken: admin.firestore.FieldValue.delete(),
    });
}

// ── Gmail message helpers ─────────────────────────────────────────────────────
function decodeBase64(data) {
    if (!data) return "";
    const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
    try { return Buffer.from(base64, "base64").toString("utf-8"); } catch { return ""; }
}

function extractBody(payload) {
    if (!payload) return { html: "", text: "" };
    if (payload.body?.data) {
        const decoded = decodeBase64(payload.body.data);
        if (payload.mimeType === "text/html") return { html: decoded, text: "" };
        if (payload.mimeType === "text/plain") return { html: "", text: decoded };
    }
    if (payload.parts?.length > 0) {
        let html = "", text = "";
        for (const part of payload.parts) {
            const r = extractBody(part);
            if (r.html) html = r.html;
            if (r.text) text = r.text;
        }
        return { html, text };
    }
    return { html: "", text: "" };
}

function extractAttachments(payload, messageId) {
    const attachments = [];
    function walk(parts) {
        if (!parts) return;
        for (const part of parts) {
            if (part.filename && part.body?.attachmentId) {
                attachments.push({ id: part.body.attachmentId, filename: part.filename, mimeType: part.mimeType, size: part.body.size || 0, messageId });
            }
            if (part.parts) walk(part.parts);
        }
    }
    walk(payload?.parts || []);
    return attachments;
}

function parseHeaders(headers = []) {
    const map = {};
    for (const h of headers) map[h.name.toLowerCase()] = h.value;
    return map;
}

function formatMessage(raw) {
    const headers = parseHeaders(raw.payload?.headers || []);
    const { html, text } = extractBody(raw.payload);
    const attachments = extractAttachments(raw.payload, raw.id);
    return {
        id: raw.id, threadId: raw.threadId, labelIds: raw.labelIds || [],
        snippet: raw.snippet || "",
        subject: headers["subject"] || "(no subject)",
        from: headers["from"] || "", to: headers["to"] || "",
        cc: headers["cc"] || "", date: headers["date"] || "",
        dateMs: raw.internalDate ? parseInt(raw.internalDate) : null,
        isUnread: (raw.labelIds || []).includes("UNREAD"),
        isStarred: (raw.labelIds || []).includes("STARRED"),
        body: html || `<pre style="white-space:pre-wrap;font-family:inherit">${text}</pre>`,
        bodyText: text, attachments, source: "gmail",
    };
}

async function fetchMessagesBatch(gmail, messages) {
    const results = [];
    const batchSize = 10;
    for (let i = 0; i < messages.length; i += batchSize) {
        const batch = messages.slice(i, i + batchSize);
        const fetched = await Promise.allSettled(
            batch.map(msg => gmail.users.messages.get({ userId: "me", id: msg.id, format: "full" }))
        );
        for (const res of fetched) {
            if (res.status === "fulfilled") results.push(formatMessage(res.value.data));
        }
    }
    return results;
}

// Fetch inbox messages using employee's own token
async function getEmployeeInbox(employeeId, maxResults = 30) {
    const gmailToken = await getEmployeeGmailToken(employeeId);
    if (!gmailToken) return { connected: false, messages: [], connectedEmail: null };

    const auth = buildOAuth2Client(gmailToken);
    const gmail = google.gmail({ version: "v1", auth });

    const listRes = await gmail.users.messages.list({ userId: "me", maxResults, q: "in:inbox" });
    const messages = listRes.data.messages || [];
    if (messages.length === 0) return { connected: true, messages: [], connectedEmail: gmailToken.connectedEmail };

    const formatted = await fetchMessagesBatch(gmail, messages);
    return { connected: true, messages: formatted, connectedEmail: gmailToken.connectedEmail };
}

module.exports = {
    getEmployeeAuthUrl,
    saveEmployeeGmailToken,
    getEmployeeGmailToken,
    disconnectEmployeeGmail,
    getEmployeeInbox,
};