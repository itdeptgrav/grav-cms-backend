// GRAV-CMS-BACKEND/routes/services/googleGmailService.js
// Fetches Gmail messages using the admin OAuth2 refresh token.

const { google } = require("googleapis");
const { getOAuth2Client } = require("./googleAuthService");

function getGmailClient() {
  const auth = getOAuth2Client();
  return google.gmail({ version: "v1", auth });
}

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

async function getInboxMessages(maxResults = 30, userEmail = null) {
  const gmail = getGmailClient();
  let q = "in:inbox";
  if (userEmail) q = `in:inbox (to:${userEmail} OR from:${userEmail})`;
  const listRes = await gmail.users.messages.list({ userId: "me", maxResults, q });
  const messages = listRes.data.messages || [];
  if (messages.length === 0) return [];
  return fetchMessagesBatch(gmail, messages);
}

async function getEmailBody(messageId) {
  const gmail = getGmailClient();
  const res = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  return formatMessage(res.data);
}

async function getUnreadCount() {
  const gmail = getGmailClient();
  const [unreadRes, totalRes] = await Promise.allSettled([
    gmail.users.messages.list({ userId: "me", q: "in:inbox is:unread", maxResults: 1 }),
    gmail.users.messages.list({ userId: "me", q: "in:inbox", maxResults: 1 }),
  ]);
  return {
    unread: unreadRes.status === "fulfilled" ? (unreadRes.value.data.resultSizeEstimate || 0) : 0,
    total: totalRes.status === "fulfilled" ? (totalRes.value.data.resultSizeEstimate || 0) : 0,
  };
}

async function searchEmails(queryStr, maxResults = 15) {
  const gmail = getGmailClient();
  const listRes = await gmail.users.messages.list({ userId: "me", maxResults, q: queryStr });
  const messages = listRes.data.messages || [];
  if (messages.length === 0) return [];
  return fetchMessagesBatch(gmail, messages);
}

async function getEmailsForUser(userEmail, maxResults = 30) {
  if (!userEmail) throw new Error("userEmail is required");
  return getInboxMessages(maxResults, userEmail);
}

async function getAllInbox(maxResults = 30) {
  return getInboxMessages(maxResults, null);
}

module.exports = { getInboxMessages, getEmailBody, getUnreadCount, searchEmails, getEmailsForUser, getAllInbox };
