"use strict";

const crypto = require("crypto");
const { google } = require("googleapis");
const SystemSetting = require("../../models/DevOps/SystemSetting");
const cipher = require("./mailCredentialCipher");

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

const redirectUri = () => process.env.GOOGLE_REDIRECT_URI_MAIL
  || `${String(process.env.API_PUBLIC_URL || `http://localhost:${process.env.PORT || 5000}`).replace(/\/+$/, "")}/api/cms/mail/oauth/google/callback`;

function oauthClient() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    const err = new Error("Google OAuth is not configured");
    err.code = "MAIL_GOOGLE_NOT_CONFIGURED";
    err.status = 503;
    throw err;
  }
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri(),
  );
}

const hash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const connectionKey = (actorKey) => `mail:connection:${hash(actorKey)}`;
const attemptKey = (state) => `mail:oauth:${hash(state)}`;
const appUrl = () => String(process.env.FRONTEND_URL || "http://localhost:3001").replace(/\/+$/, "");
const integrationConfigured = () => Boolean(
  process.env.GOOGLE_CLIENT_ID
  && process.env.GOOGLE_CLIENT_SECRET
  && process.env.GOOGLE_REDIRECT_URI_MAIL
  && cipher.isConfigured(),
);

function providerId(value, name = "Provider ID") {
  const id = String(value || "");
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(id)) {
    const err = new Error(`${name} is invalid`);
    err.status = 400;
    throw err;
  }
  return id;
}

async function connectionFor(actorKey, includeSecret = false) {
  const row = await SystemSetting.collection.findOne(
    { key: connectionKey(actorKey) },
    includeSecret ? undefined : { projection: { "value.refreshToken": 0 } },
  );
  return row ? { ...(row.value || {}), _id: row._id, _key: row.key } : null;
}

async function status(actorKey) {
  const connection = await connectionFor(actorKey);
  return {
    configured: integrationConfigured(),
    connected: Boolean(connection),
    email: connection?.email || null,
    displayName: connection?.displayName || "",
    connectedAt: connection?.connectedAt || null,
    lastError: connection?.lastError || "",
  };
}

async function createConnectUrl(actorKey) {
  if (!integrationConfigured()) {
    const err = new Error("Google Mail integration is not fully configured");
    err.code = "MAIL_GOOGLE_NOT_CONFIGURED";
    err.status = 503;
    throw err;
  }
  // The prefix is routing information only; all authority remains in the
  // hashed, expiring database record. It lets the already-registered legacy
  // Google callback hand Mail attempts to the new handler without claiming
  // or changing ordinary Cowork callbacks.
  const state = `mail_${crypto.randomBytes(32).toString("base64url")}`;
  const now = new Date();
  // Reuse the established key/value store rather than creating another Mongo
  // collection. Some deployments are already at their collection quota; a
  // first write to a new collection then waits indefinitely. The state remains
  // random, hashed, expiring, actor-bound and single-use.
  await SystemSetting.collection.updateOne(
    { key: attemptKey(state) },
    {
      $set: {
        value: { actorKey, expiresAt: new Date(Date.now() + 10 * 60 * 1000), consumedAt: null },
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now, history: [], updatedByEmail: "", updatedByName: "" },
    },
    { upsert: true },
  );
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: true,
    scope: SCOPES,
    state,
  });
}

async function completeConnection(state, code) {
  const attempt = await SystemSetting.collection.findOneAndUpdate(
    { key: attemptKey(state), "value.consumedAt": null, "value.expiresAt": { $gt: new Date() } },
    { $set: { "value.consumedAt": new Date(), updatedAt: new Date() } },
    { returnDocument: "after", includeResultMetadata: false },
  );
  if (!attempt) {
    const err = new Error("This Google connection link is invalid or has expired");
    err.status = 400;
    err.code = "MAIL_OAUTH_STATE_INVALID";
    throw err;
  }
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    const err = new Error("Google did not return a refresh token. Revoke access and connect again.");
    err.status = 400;
    throw err;
  }
  client.setCredentials(tokens);
  const profile = await google.oauth2({ version: "v2", auth: client }).userinfo.get();
  const email = String(profile.data.email || "").toLowerCase();
  if (!email) throw new Error("Google did not return an email address");
  const actorKey = attempt.value.actorKey;
  const now = new Date();
  await SystemSetting.collection.updateOne(
    { key: connectionKey(actorKey) },
    {
      $set: {
        value: {
          actorKey,
          provider: "google",
          email,
          displayName: profile.data.name || "",
          refreshToken: cipher.encrypt(tokens.refresh_token),
          scopes: tokens.scope ? String(tokens.scope).split(/\s+/).filter(Boolean) : SCOPES,
          connectedAt: now,
          lastUsedAt: null,
          lastError: "",
        },
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now, history: [], updatedByEmail: "", updatedByName: "" },
    },
    { upsert: true },
  );
  await SystemSetting.collection.deleteOne({ key: attempt.key });
  return { actorKey, email };
}

async function disconnect(actorKey) {
  const connection = await connectionFor(actorKey, true);
  if (!connection) return false;
  try {
    const client = oauthClient();
    await client.revokeToken(cipher.decrypt(connection.refreshToken));
  } catch { /* local deletion is authoritative even if Google is unavailable */ }
  await SystemSetting.collection.deleteOne({ key: connection._key });
  return true;
}

async function gmailFor(actorKey) {
  const connection = await connectionFor(actorKey, true);
  if (!connection) {
    const err = new Error("Connect Gmail to use external mail");
    err.status = 409;
    err.code = "MAIL_GMAIL_NOT_CONNECTED";
    throw err;
  }
  const client = oauthClient();
  client.setCredentials({ refresh_token: cipher.decrypt(connection.refreshToken) });
  return { gmail: google.gmail({ version: "v1", auth: client }), connection };
}

const decode = (data) => {
  try { return Buffer.from(String(data || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); }
  catch { return ""; }
};

function bodies(payload) {
  if (!payload) return { html: "", text: "" };
  if (payload.body?.data) {
    const value = decode(payload.body.data);
    if (payload.mimeType === "text/html") return { html: value, text: "" };
    if (payload.mimeType === "text/plain") return { html: "", text: value };
  }
  return (payload.parts || []).reduce((all, part) => {
    const next = bodies(part);
    return { html: all.html || next.html, text: all.text || next.text };
  }, { html: "", text: "" });
}

function headersOf(headers = []) {
  return Object.fromEntries(headers.map((header) => [String(header.name || "").toLowerCase(), header.value || ""]));
}

function htmlToText(value) {
  return String(value || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function formatMessage(raw) {
  const headers = headersOf(raw.payload?.headers || []);
  const body = bodies(raw.payload);
  return {
    id: raw.id,
    threadId: raw.threadId,
    channel: "external",
    subject: headers.subject || "(no subject)",
    from: headers.from || "",
    to: headers.to || "",
    cc: headers.cc || "",
    replyTo: headers["reply-to"] || "",
    preview: raw.snippet || "",
    bodyText: body.text || htmlToText(body.html),
    timestamp: raw.internalDate ? new Date(Number(raw.internalDate)) : (headers.date || null),
    unread: (raw.labelIds || []).includes("UNREAD"),
    starred: (raw.labelIds || []).includes("STARRED"),
    labels: raw.labelIds || [],
  };
}

async function listMessages(actorKey, { folder = "inbox", query = "", pageToken = null, limit = 40 } = {}) {
  const { gmail, connection } = await gmailFor(actorKey);
  const params = { userId: "me", maxResults: Math.min(Math.max(Number(limit) || 40, 1), 50) };
  const folders = { inbox: "INBOX", sent: "SENT", trash: "TRASH", starred: "STARRED", drafts: "DRAFT" };
  if (folder === "search") params.q = String(query || "").slice(0, 300);
  else if (folder === "starred") params.q = "is:starred";
  else params.labelIds = [folders[folder] || "INBOX"];
  if (query && folder !== "search") params.q = String(query).slice(0, 300);
  if (pageToken) {
    const cursor = String(pageToken);
    if (!/^[A-Za-z0-9_\-=]{1,2000}$/.test(cursor)) {
      const err = new Error("Page cursor is invalid");
      err.status = 400;
      throw err;
    }
    params.pageToken = cursor;
  }
  const listed = await gmail.users.messages.list(params);
  const rows = listed.data.messages || [];
  const fetched = await Promise.allSettled(rows.map((row) => gmail.users.messages.get({
    userId: "me", id: row.id, format: "full",
  })));
  await SystemSetting.collection.updateOne(
    { key: connection._key },
    { $set: { "value.lastUsedAt": new Date(), "value.lastError": "", updatedAt: new Date() } },
  );
  return {
    connected: true,
    email: connection.email,
    messages: fetched.filter((row) => row.status === "fulfilled").map((row) => formatMessage(row.value.data)),
    nextPageToken: listed.data.nextPageToken || null,
  };
}

/**
 * The inbox's unread count and its newest few unread messages, for the home
 * (services/home/homeMessages.js). Deliberately light: the count is one
 * labels.get, and each message is a METADATA read (From, Subject, Date and
 * Google's snippet) — never the full bodies listMessages decodes.
 */
async function unreadSummary(actorKey, { limit = 4 } = {}) {
  const { gmail } = await gmailFor(actorKey);
  const [label, list] = await Promise.all([
    gmail.users.labels.get({ userId: "me", id: "INBOX" }),
    gmail.users.messages.list({ userId: "me", q: "in:inbox is:unread", maxResults: Math.min(Math.max(Number(limit) || 4, 1), 10) }),
  ]);
  const ids = (list.data.messages || []).map((m) => m.id);
  const metas = await Promise.all(ids.map((id) => gmail.users.messages.get({
    userId: "me", id, format: "metadata", metadataHeaders: ["From", "Subject", "Date"],
  })));
  const items = metas.map(({ data }) => {
    const headers = headersOf(data.payload?.headers || []);
    /* "Arpita Sen <arpita@x.com>" → "Arpita Sen" */
    const from = String(headers.from || "").replace(/\s*<[^>]*>\s*$/, "").replace(/^"|"$/g, "").trim() || headers.from || "";
    return {
      id: data.id,
      channel: "external",
      from,
      subject: headers.subject || "(no subject)",
      preview: data.snippet || "",
      at: data.internalDate ? new Date(Number(data.internalDate)) : headers.date || null,
      href: `/mail/inbox?open=external:${encodeURIComponent(data.id)}`,
    };
  });
  return { unread: Number(label.data.messagesUnread) || 0, items };
}

async function getThread(actorKey, threadId) {
  const { gmail } = await gmailFor(actorKey);
  const id = providerId(threadId, "Thread ID");
  const response = await gmail.users.threads.get({ userId: "me", id, format: "full" });
  return { id, channel: "external", messages: (response.data.messages || []).map(formatMessage) };
}

function safeHeader(value, name, max = 1000) {
  const result = String(value || "").trim().slice(0, max);
  if (/\r|\n/.test(result)) {
    const err = new Error(`${name} contains an invalid line break`);
    err.status = 400;
    throw err;
  }
  return result;
}

function mime({ from, to, cc, bcc, subject, body, inReplyTo, references }) {
  const lines = [
    `From: ${safeHeader(from, "From")}`,
    `To: ${safeHeader(to, "To")}`,
    cc ? `Cc: ${safeHeader(cc, "Cc")}` : null,
    bcc ? `Bcc: ${safeHeader(bcc, "Bcc")}` : null,
    `Subject: =?UTF-8?B?${Buffer.from(safeHeader(subject, "Subject", 500)).toString("base64")}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    inReplyTo ? `In-Reply-To: ${safeHeader(inReplyTo, "In-Reply-To")}` : null,
    references ? `References: ${safeHeader(references, "References")}` : null,
  ].filter(Boolean);
  return Buffer.from(`${lines.join("\r\n")}\r\n\r\n${String(body || "")}`).toString("base64url");
}

async function send(actorKey, input) {
  const to = safeHeader(input?.to, "To");
  const subject = safeHeader(input?.subject, "Subject", 500);
  const body = String(input?.body || "").trim().slice(0, 500000);
  if (!to || !subject || !body) {
    const err = new Error("To, subject and message are required");
    err.status = 400;
    throw err;
  }
  const { gmail, connection } = await gmailFor(actorKey);
  const from = connection.displayName ? `${connection.displayName} <${connection.email}>` : connection.email;
  const response = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: mime({ from, to, cc: input?.cc, bcc: input?.bcc, subject, body }) },
  });
  return { id: response.data.id, threadId: response.data.threadId };
}

async function reply(actorKey, messageId, input) {
  const body = String(input?.body || "").trim().slice(0, 500000);
  if (!body) {
    const err = new Error("Message is required");
    err.status = 400;
    throw err;
  }
  const { gmail, connection } = await gmailFor(actorKey);
  const original = await gmail.users.messages.get({ userId: "me", id: providerId(messageId, "Message ID"), format: "full" });
  const formatted = formatMessage(original.data);
  const headers = headersOf(original.data.payload?.headers || []);
  const messageIdHeader = headers["message-id"] || "";
  const references = [headers.references, messageIdHeader].filter(Boolean).join(" ");
  const to = safeHeader(input?.to || formatted.replyTo || formatted.from, "To");
  const subject = safeHeader(input?.subject || (/^re:/i.test(formatted.subject) ? formatted.subject : `Re: ${formatted.subject}`), "Subject", 500);
  const from = connection.displayName ? `${connection.displayName} <${connection.email}>` : connection.email;
  const response = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      threadId: original.data.threadId,
      raw: mime({ from, to, cc: input?.cc, subject, body, inReplyTo: messageIdHeader, references }),
    },
  });
  return { id: response.data.id, threadId: response.data.threadId };
}

async function setMessageState(actorKey, messageId, state) {
  const { gmail } = await gmailFor(actorKey);
  const id = providerId(messageId, "Message ID");
  if (state?.trashed === true) {
    await gmail.users.messages.trash({ userId: "me", id });
    return;
  }
  const addLabelIds = [];
  const removeLabelIds = [];
  if (typeof state?.read === "boolean") (state.read ? removeLabelIds : addLabelIds).push("UNREAD");
  if (typeof state?.starred === "boolean") (state.starred ? addLabelIds : removeLabelIds).push("STARRED");
  if (state?.archived === true) removeLabelIds.push("INBOX");
  if (!addLabelIds.length && !removeLabelIds.length) {
    const err = new Error("No supported state change was supplied");
    err.status = 400;
    throw err;
  }
  await gmail.users.messages.modify({ userId: "me", id, requestBody: { addLabelIds, removeLabelIds } });
}

module.exports = {
  appUrl, redirectUri, status, createConnectUrl, completeConnection, disconnect,
  listMessages, getThread, send, reply, setMessageState, unreadSummary,
};
