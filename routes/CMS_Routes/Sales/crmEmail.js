"use strict";
// routes/CMS_Routes/Sales/crmEmail.js  →  mounted at /api/cms/crm/email
//
// The Sales-facing email surface: which emails were exchanged with a customer,
// and whether this salesperson has connected their Google account yet.
//
// Sibling to callEvents.js (device call log) and whatsapp.js's /for-lead — same
// shape, same identity lookup, same read-only posture. Added 27 Aug 2026 on
// explicit request to automate email the way call and WhatsApp already are.
//
// EVERY ROUTE IS SCOPED TO THE CALLER'S OWN MAILBOX. `employeeId` is taken from
// the verified JWT (`req.user.employeeId`) and never from a query parameter —
// see the note on GET /status. Nothing here can read another employee's mail.

const express = require("express");
const router = express.Router();

const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");
const { emailsForLead, resolveToken } = require("../../../services/gmailLeadMatch.service");
const {
  getEmployeeAuthUrl,
  disconnectEmployeeGmail,
} = require("../../services/googleEmployeeGmailService");

router.use(salesAuth);

/**
 * GET /api/cms/crm/email/status
 *
 * Is this salesperson's Google account connected, and as which address?
 *
 * The employee is resolved from the token, NOT from a query parameter. The
 * pre-existing /api/google/employee-gmail/* routes take `employeeId` as a plain
 * query param with no auth middleware at all, which means anyone who can reach
 * the backend can read anyone's inbox by guessing an id. This module does not
 * repeat that, and that separate issue is flagged rather than inherited.
 */
router.get("/status", async (req, res) => {
  try {
    // Whether the SERVER can do OAuth at all, reported up front (27 Aug 2026).
    // Without this the page could only discover it by offering a Connect button
    // and letting the click fail — which is what happened: a dead button next to
    // an error, when the honest answer is "this needs an administrator, not you".
    const configured = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

    const employeeId = req.user?.employeeId;
    if (!employeeId) {
      return res.json({ success: true, configured, connected: false, connectedEmail: null, reason: "no-employee-id" });
    }
    const { token, reason } = await resolveToken(employeeId);
    res.json({
      success: true,
      configured,
      connected: Boolean(token),
      reason: token ? null : reason,
      connectedEmail: token?.connectedEmail || null,
      connectedAt: token?.connectedAt || null,
      displayName: token?.displayName || null,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/cms/crm/email/auth-url
 *
 * Where to send the browser to connect this salesperson's Google account. The
 * consent screen's `state` carries the employee id, and Google returns it to
 * the existing callback, so the token lands against the right person.
 */
router.get("/auth-url", (req, res) => {
  try {
    const employeeId = req.user?.employeeId;
    if (!employeeId) {
      return res.status(400).json({
        success: false,
        message: "Your login isn't linked to an employee record, so a mailbox can't be connected to it. Ask HR to link your employee ID.",
      });
    }
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      return res.status(503).json({
        success: false,
        message: "Google sign-in isn't configured on the server yet (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are missing).",
      });
    }
    // Come back to Sales' own settings, not CoWork's — see parseOAuthState.
    res.json({ success: true, url: getEmployeeAuthUrl(employeeId, "/sales/dashboard/settings") });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/** POST /api/cms/crm/email/disconnect — forget this salesperson's mailbox. */
router.post("/disconnect", async (req, res) => {
  try {
    const employeeId = req.user?.employeeId;
    if (!employeeId) return res.status(400).json({ success: false, message: "No employee record on this login." });
    await disconnectEmployeeGmail(employeeId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/cms/crm/email/for-lead?leadId=… | ?accountId=… | ?customerId=…
 *
 * The emails exchanged with this customer, newest first.
 *
 * Three distinct empty answers, deliberately NOT collapsed into one — they mean
 * different things and need different fixes:
 *   • connected:false        → link your Google account (nothing can be found)
 *   • addresses: []          → this customer has no email address on file
 *   • messages: []           → connected and searchable, genuinely nothing yet
 */
router.get("/for-lead", async (req, res) => {
  try {
    const { leadId, accountId, customerId } = req.query;
    if (!leadId && !accountId && !customerId) {
      return res.status(400).json({ success: false, message: "leadId, accountId or customerId is required" });
    }
    const employeeId = req.user?.employeeId;
    if (!employeeId) {
      return res.json({ success: true, connected: false, connectedEmail: null, messages: [], addresses: [] });
    }

    const out = await emailsForLead({ employeeId, leadId, accountId, customerId });
    if (!out) return res.status(404).json({ success: false, message: leadId ? "Lead not found" : "Customer not found" });

    res.json({
      success: true,
      // Same flag as /status, so the lead drawer and the settings page can
      // never disagree about whose problem this is.
      configured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
      connected: out.connected,
      reason: out.reason || null,
      connectedEmail: out.connectedEmail,
      addresses: out.addresses,
      messages: out.messages,
    });
  } catch (err) {
    // A revoked/expired Google grant surfaces here as an opaque Google error.
    // Translated, because "invalid_grant" tells a salesperson nothing.
    const raw = String(err?.message || "");
    const friendly = /invalid_grant|Token has been expired|revoked/i.test(raw)
      ? "Your Google connection has expired or was revoked. Reconnect your account in Settings to see emails again."
      : raw;
    console.error("[crm/email] for-lead failed:", raw);
    res.status(500).json({ success: false, message: friendly });
  }
});

module.exports = router;
