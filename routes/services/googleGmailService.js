// GRAV-CMS-BACKEND/services/googleGmailService.js
const { google } = require("googleapis");
const { getOAuth2Client } = require("./googleAuthService");

// Fetch inbox messages (latest 20)
async function getInboxMessages(maxResults = 20) {
  const auth = getOAuth2Client();
  const gmail = google.gmail({ version: "v1", auth });

  const listRes = await gmail.users.messages.list({
    userId: "me",
    maxResults,
    labelIds: ["INBOX"],
  });

  const messageIds = (listRes.data.messages || []).map((m) => m.id);
  if (!messageIds.length) return [];

  // Fetch full details for each message (in parallel, max 10 at a time)
  const chunks = [];
  for (let i = 0; i < messageIds.length; i += 5) {
    chunks.push(messageIds.slice(i, i + 5));
  }

  const allMessages = [];
  for (const chunk of chunks) {
    const details = await Promise.all(
      chunk.map((id) =>
        gmail.users.messages.get({ userId: "me", id, format: "metadata",
          metadataHeaders: ["From", "To", "Subject", "Date"] })
      )
    );
    details.forEach((r) => {
      const headers = r.data.payload?.headers || [];
      const get = (name) => headers.find((h) => h.name === name)?.value || "";
      allMessages.push({
        id: r.data.id,
        threadId: r.data.threadId,
        snippet: r.data.snippet || "",
        subject: get("Subject"),
        from: get("From"),
        to: get("To"),
        date: get("Date"),
        labelIds: r.data.labelIds || [],
        isUnread: (r.data.labelIds || []).includes("UNREAD"),
        isStarred: (r.data.labelIds || []).includes("STARRED"),
      });
    });
  }
  return allMessages;
}

// Get full body of a single email
async function getEmailBody(messageId) {
  const auth = getOAuth2Client();
  const gmail = google.gmail({ version: "v1", auth });
  const res = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  const msg = res.data;

  const extractBody = (payload) => {
    if (!payload) return "";
    if (payload.body?.data) {
      return Buffer.from(payload.body.data, "base64").toString("utf-8");
    }
    if (payload.parts) {
      for (const part of payload.parts) {
        if (part.mimeType === "text/plain" || part.mimeType === "text/html") {
          if (part.body?.data) return Buffer.from(part.body.data, "base64").toString("utf-8");
        }
        const nested = extractBody(part);
        if (nested) return nested;
      }
    }
    return "";
  };

  const headers = msg.payload?.headers || [];
  const get = (name) => headers.find((h) => h.name === name)?.value || "";

  return {
    id: msg.id,
    threadId: msg.threadId,
    subject: get("Subject"),
    from: get("From"),
    to: get("To"),
    date: get("Date"),
    body: extractBody(msg.payload),
    snippet: msg.snippet || "",
    labelIds: msg.labelIds || [],
    isUnread: (msg.labelIds || []).includes("UNREAD"),
    isStarred: (msg.labelIds || []).includes("STARRED"),
  };
}

// Get unread count
async function getUnreadCount() {
  const auth = getOAuth2Client();
  const gmail = google.gmail({ version: "v1", auth });
  const res = await gmail.users.labels.get({ userId: "me", id: "INBOX" });
  return {
    unread: res.data.messagesUnread || 0,
    total: res.data.messagesTotal || 0,
  };
}

// Search emails
async function searchEmails(query, maxResults = 10) {
  const auth = getOAuth2Client();
  const gmail = google.gmail({ version: "v1", auth });
  const listRes = await gmail.users.messages.list({ userId: "me", q: query, maxResults });
  const ids = (listRes.data.messages || []).map((m) => m.id);
  if (!ids.length) return [];
  const details = await Promise.all(
    ids.map((id) =>
      gmail.users.messages.get({ userId: "me", id, format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"] })
    )
  );
  return details.map((r) => {
    const headers = r.data.payload?.headers || [];
    const get = (name) => headers.find((h) => h.name === name)?.value || "";
    return {
      id: r.data.id, threadId: r.data.threadId, snippet: r.data.snippet || "",
      subject: get("Subject"), from: get("From"), to: get("To"), date: get("Date"),
      isUnread: (r.data.labelIds || []).includes("UNREAD"),
    };
  });
}

module.exports = { getInboxMessages, getEmailBody, getUnreadCount, searchEmails };
