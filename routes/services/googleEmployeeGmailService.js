// GRAV-CMS-BACKEND/routes/services/googleEmployeeGmailService.js
// Per-employee Gmail — each employee connects their own Google account.
// Their refresh token is stored in Firestore cowork_employees/{empId}.gmailToken

const { google } = require("googleapis");
const { db, admin } = require("../../config/firebaseAdmin");

function buildOAuth2Client(gmailToken) {
    const client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI_EMPLOYEE || process.env.GOOGLE_REDIRECT_URI
    );
    client.setCredentials({ refresh_token: gmailToken.refresh_token });
    return client;
}

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
            "https://www.googleapis.com/auth/gmail.modify",
            "https://www.googleapis.com/auth/gmail.compose",
            "https://www.googleapis.com/auth/gmail.send",
            "https://www.googleapis.com/auth/userinfo.email",
            "https://www.googleapis.com/auth/userinfo.profile",
        ],
        state: employeeId,
    });
}

async function saveEmployeeGmailToken(employeeId, code) {
    const client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI_EMPLOYEE || process.env.GOOGLE_REDIRECT_URI
    );
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) throw new Error("No refresh_token returned. Try disconnecting and reconnecting Gmail.");
    client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: "v2", auth: client });
    const userInfo = await oauth2.userinfo.get();
    const connectedEmail = userInfo.data.email;
    // Save the Google Account display name (e.g. "Pramod Biswal") so outgoing
    // mail shows proper name instead of raw email address in From header
    const displayName = userInfo.data.name || "";

    // Find the correct doc — try by doc ID first, then by employeeId field
    let docRef = db.collection("cowork_employees").doc(employeeId);
    const snap = await docRef.get();
    if (!snap.exists) {
        const q = await db.collection("cowork_employees").where("employeeId", "==", employeeId).limit(1).get();
        if (!q.empty) docRef = q.docs[0].ref;
    }

    await docRef.update({
        gmailToken: {
            refresh_token: tokens.refresh_token,
            connectedEmail,
            displayName,
            connectedAt: new Date().toISOString(),
        },
    });
    return { connectedEmail, displayName };
}

async function getEmployeeGmailToken(employeeId) {
    // First try doc ID lookup (fast path)
    let snap = await db.collection("cowork_employees").doc(employeeId).get();
    let docRef = db.collection("cowork_employees").doc(employeeId);
    // If not found or no gmailToken, try querying by employeeId field
    if (!snap.exists || !snap.data()?.gmailToken) {
        const q = await db.collection("cowork_employees").where("employeeId", "==", employeeId).limit(1).get();
        if (!q.empty) { snap = q.docs[0]; docRef = q.docs[0].ref; }
    }
    if (!snap.exists) throw new Error("Employee not found");
    const data = snap.data();
    if (!data.gmailToken || !data.gmailToken.refresh_token) return null;
    const token = data.gmailToken;

    // Self-heal: if displayName missing, fetch from Google profile now and save it
    // Handles tokens saved before displayName was added — no manual reconnect needed
    if (!token.displayName) {
        try {
            const client = buildOAuth2Client(token);
            const oauth2 = google.oauth2({ version: "v2", auth: client });
            const userInfo = await oauth2.userinfo.get();
            const displayName = userInfo.data.name || "";
            if (displayName) {
                await docRef.update({ "gmailToken.displayName": displayName });
                token.displayName = displayName;
                console.log("[GmailToken] Patched displayName for " + employeeId + ": \"" + displayName + "\"");
            }
        } catch (e) {
            console.warn("[GmailToken] Could not fetch displayName for " + employeeId + ":", e.message);
        }
    }

    return token;
}

async function disconnectEmployeeGmail(employeeId) {
    let docRef = db.collection("cowork_employees").doc(employeeId);
    const snap = await docRef.get();
    if (!snap.exists) {
        const q = await db.collection("cowork_employees").where("employeeId", "==", employeeId).limit(1).get();
        if (!q.empty) docRef = q.docs[0].ref;
    }
    await docRef.update({ gmailToken: admin.firestore.FieldValue.delete() });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
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
        cc: headers["cc"] || "", bcc: headers["bcc"] || "",
        replyTo: headers["reply-to"] || "",
        date: headers["date"] || "",
        dateMs: raw.internalDate ? parseInt(raw.internalDate) : null,
        isUnread: (raw.labelIds || []).includes("UNREAD"),
        isStarred: (raw.labelIds || []).includes("STARRED"),
        isArchived: !(raw.labelIds || []).includes("INBOX"),
        isTrashed: (raw.labelIds || []).includes("TRASH"),
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

// ── Core operations ───────────────────────────────────────────────────────────

async function getEmployeeInbox(employeeId, maxResults = 40, pageToken = null, labelId = "INBOX", q = "") {
    const gmailToken = await getEmployeeGmailToken(employeeId);
    if (!gmailToken) return { connected: false, messages: [], connectedEmail: null, nextPageToken: null };

    const auth = buildOAuth2Client(gmailToken);
    const gmail = google.gmail({ version: "v1", auth });

    const params = { userId: "me", maxResults };
    if (labelId === "SEARCH") { params.q = q; }
    else if (labelId === "STARRED") { params.q = "is:starred"; }
    else if (labelId === "SENT") { params.labelIds = ["SENT"]; }
    else if (labelId === "TRASH") { params.labelIds = ["TRASH"]; }
    else if (labelId === "DRAFT") { params.labelIds = ["DRAFT"]; }
    else { params.labelIds = [labelId]; if (q) params.q = q; }

    if (pageToken) params.pageToken = pageToken;

    const listRes = await gmail.users.messages.list(params);
    const messages = listRes.data.messages || [];
    if (!messages.length) return { connected: true, messages: [], connectedEmail: gmailToken.connectedEmail, nextPageToken: null };

    const formatted = await fetchMessagesBatch(gmail, messages);
    return { connected: true, messages: formatted, connectedEmail: gmailToken.connectedEmail, nextPageToken: listRes.data.nextPageToken || null };
}

async function markRead(employeeId, messageId, read) {
    const gmailToken = await getEmployeeGmailToken(employeeId);
    const auth = buildOAuth2Client(gmailToken);
    const gmail = google.gmail({ version: "v1", auth });
    await gmail.users.messages.modify({
        userId: "me", id: messageId,
        requestBody: {
            addLabelIds: read ? [] : ["UNREAD"],
            removeLabelIds: read ? ["UNREAD"] : [],
        },
    });
}

async function toggleStar(employeeId, messageId, star) {
    const gmailToken = await getEmployeeGmailToken(employeeId);
    const auth = buildOAuth2Client(gmailToken);
    const gmail = google.gmail({ version: "v1", auth });
    await gmail.users.messages.modify({
        userId: "me", id: messageId,
        requestBody: {
            addLabelIds: star ? ["STARRED"] : [],
            removeLabelIds: star ? [] : ["STARRED"],
        },
    });
}

async function trashMessage(employeeId, messageId) {
    const gmailToken = await getEmployeeGmailToken(employeeId);
    const auth = buildOAuth2Client(gmailToken);
    const gmail = google.gmail({ version: "v1", auth });
    await gmail.users.messages.trash({ userId: "me", id: messageId });
}

async function archiveMessage(employeeId, messageId) {
    const gmailToken = await getEmployeeGmailToken(employeeId);
    const auth = buildOAuth2Client(gmailToken);
    const gmail = google.gmail({ version: "v1", auth });
    await gmail.users.messages.modify({
        userId: "me", id: messageId,
        requestBody: { removeLabelIds: ["INBOX"] },
    });
}

function buildMimeMessage({ from, to, cc, bcc, subject, body, inReplyTo, references, isHtml = true, attachments = [] }) {
    const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const hasAttachments = attachments && attachments.length > 0;

    const baseHeaders = [
        `From: ${from}`,
        `To: ${to}`,
        cc ? `Cc: ${cc}` : null,
        bcc ? `Bcc: ${bcc}` : null,
        `Subject: =?UTF-8?B?${Buffer.from(subject || "").toString("base64")}?=`,
        `MIME-Version: 1.0`,
        inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
        references ? `References: ${references}` : null,
    ].filter(Boolean);

    let raw;

    if (!hasAttachments) {
        // Simple email — no attachments
        const headers = [
            ...baseHeaders,
            `Content-Type: ${isHtml ? "text/html" : "text/plain"}; charset=UTF-8`,
        ].join("\r\n");
        raw = `${headers}\r\n\r\n${body}`;
    } else {
        // Multipart/mixed — body + attachments
        const headers = [
            ...baseHeaders,
            `Content-Type: multipart/mixed; boundary="${boundary}"`,
        ].join("\r\n");

        const bodyPart = [
            `--${boundary}`,
            `Content-Type: ${isHtml ? "text/html" : "text/plain"}; charset=UTF-8`,
            `Content-Transfer-Encoding: quoted-printable`,
            "",
            body,
        ].join("\r\n");

        const attParts = attachments.map(att => {
            // att.data is base64 string, att.name is filename, att.mimeType is content type
            const safeFilename = `=?UTF-8?B?${Buffer.from(att.name).toString("base64")}?=`;
            return [
                `--${boundary}`,
                `Content-Type: ${att.mimeType || "application/octet-stream"}; name="${safeFilename}"`,
                `Content-Transfer-Encoding: base64`,
                `Content-Disposition: attachment; filename="${safeFilename}"`,
                "",
                // Chunk base64 at 76 chars per line (RFC 2045)
                att.data.match(/.{1,76}/g).join("\r\n"),
            ].join("\r\n");
        });

        raw = `${headers}\r\n\r\n${bodyPart}\r\n${attParts.join("\r\n")}\r\n--${boundary}--`;
    }

    return Buffer.from(raw).toString("base64url");
}

async function getCoworkName(employeeId) {
    // Returns the custom name set in CoWork (e.g. "Pramod Biswal23")
    // This is the name shown to email recipients as the From display name
    try {
        let snap = await db.collection("cowork_employees").doc(employeeId).get();
        if (!snap.exists || !snap.data()?.name) {
            const q = await db.collection("cowork_employees").where("employeeId", "==", employeeId).limit(1).get();
            if (!q.empty) snap = q.docs[0];
        }
        return snap.exists ? (snap.data()?.name || "") : "";
    } catch { return ""; }
}

async function sendEmail(employeeId, { to, cc, bcc, subject, body, isHtml = true, attachments = [] }) {
    const gmailToken = await getEmployeeGmailToken(employeeId);
    const auth = buildOAuth2Client(gmailToken);
    const gmail = google.gmail({ version: "v1", auth });
    // Priority: 1) CoWork custom name  2) Google profile name  3) bare email
    const coworkName = await getCoworkName(employeeId);
    const displayName = coworkName || gmailToken.displayName || "";
    const fromHeader = displayName
        ? `${displayName} <${gmailToken.connectedEmail}>`
        : gmailToken.connectedEmail;
    const raw = buildMimeMessage({ from: fromHeader, to, cc, bcc, subject, body, isHtml, attachments });
    await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
}

async function replyToEmail(employeeId, messageId, { to, cc, subject, body, isHtml = true, attachments = [] }) {
    const gmailToken = await getEmployeeGmailToken(employeeId);
    const auth = buildOAuth2Client(gmailToken);
    const gmail = google.gmail({ version: "v1", auth });

    // Get original message for thread id and headers
    const orig = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
    const origData = formatMessage(orig.data);
    const headers = parseHeaders(orig.data.payload?.headers || []);
    const messageIdHeader = headers["message-id"] || "";
    const references = headers["references"] ? `${headers["references"]} ${messageIdHeader}` : messageIdHeader;

    // Priority: 1) CoWork custom name  2) Google profile name  3) bare email
    const coworkName = await getCoworkName(employeeId);
    const replyDisplayName = coworkName || gmailToken.displayName || "";
    const replyFrom = replyDisplayName
        ? `${replyDisplayName} <${gmailToken.connectedEmail}>`
        : gmailToken.connectedEmail;

    const raw = buildMimeMessage({
        from: replyFrom,
        to, cc,
        subject: subject || `Re: ${origData.subject}`,
        body, isHtml,
        inReplyTo: messageIdHeader,
        references,
        attachments: attachments || [],
    });
    await gmail.users.messages.send({ userId: "me", requestBody: { raw, threadId: orig.data.threadId } });
}

async function getAttachment(employeeId, messageId, attachmentId) {
    const gmailToken = await getEmployeeGmailToken(employeeId);
    const auth = buildOAuth2Client(gmailToken);
    const gmail = google.gmail({ version: "v1", auth });
    const res = await gmail.users.messages.attachments.get({ userId: "me", messageId, id: attachmentId });
    return res.data; // { size, data (base64url) }
}

async function getLabels(employeeId) {
    const gmailToken = await getEmployeeGmailToken(employeeId);
    const auth = buildOAuth2Client(gmailToken);
    const gmail = google.gmail({ version: "v1", auth });
    const res = await gmail.users.labels.list({ userId: "me" });
    return res.data.labels || [];
}

// ── Fetch full thread — all messages in a Gmail thread ────────────────────────
async function getThread(employeeId, threadId) {
    const gmailToken = await getEmployeeGmailToken(employeeId);
    const auth = buildOAuth2Client(gmailToken);
    const gmail = google.gmail({ version: "v1", auth });
    const res = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
    const messages = (res.data.messages || []).map(formatMessage);
    return { threadId, messages };
}

module.exports = {
    getEmployeeAuthUrl,
    saveEmployeeGmailToken,
    getEmployeeGmailToken,
    disconnectEmployeeGmail,
    getEmployeeInbox,
    markRead,
    toggleStar,
    trashMessage,
    archiveMessage,
    sendEmail,
    replyToEmail,
    getAttachment,
    getLabels,
    getThread,
};