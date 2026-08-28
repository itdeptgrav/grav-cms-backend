"use strict";
// services/gmailLeadMatch.service.js
//
// "Which emails in this salesperson's mailbox belong to this customer?"
//
// The email counterpart to services/callRecordingMatch.service.js (device call
// log → lead) and services/whatsappStore.js (Meta webhook → lead), added
// 27 Aug 2026 on explicit request: automate email the way call and WhatsApp
// already are, "so that the website can track every mail whatever sent/received
// ok, so form there it can track and track that customer mail and showcase the
// log over here ok, so do that and remove this manual method".
//
// ── WHY THIS QUERIES GMAIL LIVE INSTEAD OF SYNCING A COPY ────────────────────
//
// The obvious design — mirror whatsappStore.js, poll the whole mailbox, store
// every message in Mongo — was deliberately NOT taken:
//
//   • PRIVACY. A salesperson's mailbox contains their salary review, their HR
//     correspondence and their personal mail. Copying all of it into the CRM
//     database to find the handful of customer threads means the CRM now holds
//     all of it, forever, readable by anyone with database access. Querying
//     Gmail for the customer's address returns only the customer's threads and
//     stores none of it.
//   • FRESHNESS. A stored copy is only as current as the last sync ran. This is
//     always live, so a reply that arrived thirty seconds ago is visible.
//   • NO NEW INFRASTRUCTURE. Gmail has no webhook here — a push setup needs
//     users.watch plus a Google Pub/Sub topic and a public endpoint, and a poll
//     needs a cron plus per-mailbox historyId bookkeeping. Neither exists yet.
//
// The cost, stated honestly: one Gmail API round trip per open (mitigated by
// asking for metadata only and capping results), and nothing is searchable
// server-side across customers. If a cross-customer email report is ever
// wanted, THAT is when a stored index earns its keep — and it should then store
// only messages that matched a known customer, never the whole mailbox.

const { google } = require("googleapis");
const { getEmployeeGmailToken } = require("../routes/services/googleEmployeeGmailService");
const { identityFor } = require("./customerIdentityLookup.service");

/** Never ask Gmail for more than this in one go. */
const MAX_RESULTS = 25;

function buildOAuth2Client(gmailToken) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI_EMPLOYEE || process.env.GOOGLE_REDIRECT_URI,
  );
  client.setCredentials({ refresh_token: gmailToken.refresh_token });
  return client;
}

/**
 * The employee's Gmail token, or a REASON there isn't one — never a throw.
 *
 * `getEmployeeGmailToken` throws `"Employee not found"` when the employee has
 * no `cowork_employees` document, and returns null only when the doc exists but
 * carries no token. That distinction matters more here than it does for the
 * CoWork mail client it was written for: Sales lives in MongoDB while
 * `cowork_employees` is Firestore, so a salesperson can legitimately have no
 * CoWork record at all — and a "Mail" button that answers HTTP 500 for those
 * people is indistinguishable from the feature being broken.
 *
 * Both cases become a calm `connected: false` with a `reason` the UI can turn
 * into the right sentence, because the fixes differ: one person needs to click
 * Connect, the other needs an employee record before they can.
 */
async function resolveToken(employeeId) {
  try {
    const token = await getEmployeeGmailToken(employeeId);
    return token ? { token } : { token: null, reason: "not-connected" };
  } catch (err) {
    if (/Employee not found/i.test(String(err?.message || ""))) {
      return { token: null, reason: "no-employee-record" };
    }
    throw err; // A real failure (Firestore down, bad credentials) still surfaces.
  }
}

/** The bare address out of `Name <addr@x.com>`, lowercased. */
function bareAddress(v) {
  const raw = String(v || "").trim().toLowerCase();
  const angled = raw.match(/<([^>]+)>/);
  return (angled ? angled[1] : raw).trim();
}

/** One header out of Gmail's `[{name, value}]` array, case-insensitively. */
function header(headers, name) {
  const row = (headers || []).find((h) => String(h.name || "").toLowerCase() === name);
  return row ? row.value : "";
}

/**
 * Every email address this customer is known by, from the same identity lookup
 * the call and WhatsApp matchers use — so "who is this customer" has ONE answer
 * across all three channels rather than three subtly different ones.
 */
async function emailsForCustomer({ leadId, accountId, customerId }) {
  const identity = await identityFor({ leadId, accountId, customerId });
  if (!identity) return null;
  return { identity, emails: identity.emails || [] };
}

/**
 * Emails exchanged with this customer, newest first.
 *
 * Returns `{ connected, connectedEmail, messages, identity }`. `connected:false`
 * means this salesperson has not linked their Google account yet — a state the
 * caller must render as "connect your account", never as "no emails", because
 * the two look identical from the outside and mean opposite things.
 */
async function emailsForLead({ employeeId, leadId, accountId, customerId }) {
  const found = await emailsForCustomer({ leadId, accountId, customerId });
  if (!found) return null;
  const { identity, emails } = found;

  const { token: gmailToken, reason } = await resolveToken(employeeId);
  if (!gmailToken) {
    return { connected: false, reason, connectedEmail: null, messages: [], identity, addresses: emails };
  }
  // A customer with no email address on file cannot be matched at all — that is
  // a missing-data answer, not an empty-inbox one, and the caller says so.
  if (!emails.length) {
    return { connected: true, connectedEmail: gmailToken.connectedEmail, messages: [], identity, addresses: [] };
  }

  const auth = buildOAuth2Client(gmailToken);
  const gmail = google.gmail({ version: "v1", auth });

  // Both directions in one query — mail we sent them and mail they sent us.
  // Gmail's search covers From/To/Cc for a bare address, and `-in:chats`
  // keeps Hangouts records out.
  const q = `{${emails.map((e) => `from:${e} to:${e}`).join(" ")}} -in:chats`;

  const listRes = await gmail.users.messages.list({ userId: "me", q, maxResults: MAX_RESULTS });
  const ids = listRes.data.messages || [];
  if (!ids.length) {
    return { connected: true, connectedEmail: gmailToken.connectedEmail, messages: [], identity, addresses: emails };
  }

  // `format: "metadata"` with an explicit header list — the body is never
  // needed here (this powers a "log this email" list, not a mail reader) and
  // not requesting it keeps both the API response and this server's memory
  // free of customer correspondence it has no reason to hold.
  const fetched = await Promise.allSettled(
    ids.map((m) =>
      gmail.users.messages.get({
        userId: "me",
        id: m.id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"],
      }),
    ),
  );

  const connectedAddr = bareAddress(gmailToken.connectedEmail);
  const messages = fetched
    .filter((r) => r.status === "fulfilled")
    .map((r) => {
      const d = r.value.data;
      const h = d.payload?.headers || [];
      const from = header(h, "from");
      const fromAddr = bareAddress(from);
      // Direction from WHO SENT IT, not from Gmail's SENT label: a thread can
      // carry both, and the label describes the thread, not this message.
      const outbound = fromAddr === connectedAddr;
      return {
        id: d.id,
        threadId: d.threadId,
        subject: header(h, "subject") || "(no subject)",
        from,
        fromAddress: fromAddr,
        to: header(h, "to"),
        snippet: d.snippet || "",
        sentAt: d.internalDate ? new Date(Number(d.internalDate)).toISOString() : null,
        direction: outbound ? "outbound" : "inbound",
        isUnread: (d.labelIds || []).includes("UNREAD"),
      };
    })
    .sort((a, b) => new Date(b.sentAt || 0) - new Date(a.sentAt || 0));

  return {
    connected: true,
    connectedEmail: gmailToken.connectedEmail,
    messages,
    identity,
    addresses: emails,
  };
}

module.exports = { emailsForLead, emailsForCustomer, bareAddress, resolveToken };
