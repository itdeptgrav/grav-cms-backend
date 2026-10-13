"use strict";

const express = require("express");
const router = express.Router();

const { authenticateCmsSession } = require("../../services/cmsSession");
const { resolveAppAccess } = require("../../services/access/appAccess.service");
const { resolveMailPrincipal, resolveMailActor, searchDirectory } = require("../../services/mail/mailIdentity.service");
const internal = require("../../services/mail/internalMail.service");
const googleMail = require("../../services/mail/googleMail.service");

function fail(res, error, label) {
  const status = Number(error?.status) || 500;
  if (status >= 500) {
    console.error(`[mail/${label}]`, error);
  }
  return res.status(status).json({
    success: false,
    code: error?.code || (status >= 500 ? "MAIL_UNAVAILABLE" : "MAIL_REQUEST_FAILED"),
    message: status >= 500 ? "Mail is temporarily unavailable." : error.message,
    details: error?.details,
  });
}

// Google returns here without the CMS cookie being authoritative. A one-use,
// expiring state record binds the callback to the verified actor who started it.
async function googleOAuthCallback(req, res) {
  const target = `${googleMail.appUrl()}/mail/settings`;
  try {
    if (!req.query.code || !req.query.state) throw Object.assign(new Error("Google did not return an authorisation code"), { status: 400 });
    await googleMail.completeConnection(req.query.state, req.query.code);
    return res.redirect(`${target}?gmail=connected`);
  } catch (error) {
    console.error("[mail/oauth/callback]", error?.message || error);
    return res.redirect(`${target}?gmail=error`);
  }
}

router.get("/oauth/google/callback", googleOAuthCallback);

router.use(authenticateCmsSession);
router.use(async (req, res, next) => {
  try {
    const access = await resolveAppAccess(req.user, "mail");
    if (!access.allowed) {
      return res.status(access.denialCode === "UNAUTHENTICATED" ? 401 : 403).json({
        success: false,
        code: access.denialCode,
        message: "You do not have access to Mail.",
      });
    }
    req.mailAccess = access;
    req.mailPrincipal = await resolveMailPrincipal(req.user);
    return next();
  } catch (error) {
    return fail(res, error, "access");
  }
});

router.use((req, res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && !req.mailAccess?.capabilities?.write) {
    return res.status(403).json({ success: false, code: "MAIL_WRITE_DENIED", message: "Your Mail role is read-only." });
  }
  return next();
});

async function internalActor(req) {
  if (!req.mailActor) req.mailActor = await resolveMailActor(req.user);
  return req.mailActor;
}

router.get("/me", async (req, res) => {
  try { return res.json({ success: true, me: await internalActor(req), access: req.mailAccess }); }
  catch (error) { return fail(res, error, "me"); }
});

router.get("/directory", async (req, res) => {
  try {
    return res.json({ success: true, people: await searchDirectory(req.query.q) });
  } catch (error) { return fail(res, error, "directory"); }
});

// One compose endpoint for the standalone Mail client. Delivery is inferred
// from each recipient: an address containing @ leaves through the connected
// Gmail account; every other token is resolved as a GRAV employee ID. A mixed
// recipient list is intentionally supported so the UI never asks the sender
// to understand or choose a transport.
router.post("/messages", async (req, res) => {
  try {
    const recipients = (Array.isArray(req.body?.to) ? req.body.to : String(req.body?.to || "").split(/[\s,;]+/))
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    const externalRecipients = recipients.filter((value) => value.includes("@"));
    const internalRecipients = recipients.filter((value) => !value.includes("@"));
    if (!recipients.length) {
      const error = new Error("Add at least one employee ID or email address");
      error.status = 400;
      throw error;
    }

    const deliveries = {};
    if (internalRecipients.length) {
      deliveries.internal = await internal.createMessage(await internalActor(req), {
        toEmployeeIds: internalRecipients,
        subject: req.body?.subject,
        body: req.body?.body,
      });
    }
    if (externalRecipients.length) {
      deliveries.external = await googleMail.send(req.mailPrincipal.actorKey, {
        to: externalRecipients.join(", "),
        cc: req.body?.cc,
        bcc: req.body?.bcc,
        subject: req.body?.subject,
        body: req.body?.body,
      });
    }
    return res.status(201).json({
      success: true,
      route: internalRecipients.length && externalRecipients.length
        ? "mixed"
        : internalRecipients.length ? "internal" : "gmail",
      recipients: { internal: internalRecipients, external: externalRecipients },
      deliveries,
    });
  } catch (error) { return fail(res, error, "send"); }
});

router.get("/internal/conversations", async (req, res) => {
  try {
    const threads = await internal.listThreads(await internalActor(req), {
      archived: req.query.archived === "1",
      limit: req.query.limit,
    });
    return res.json({ success: true, threads });
  } catch (error) { return fail(res, error, "internal/list"); }
});

router.post("/internal/messages", async (req, res) => {
  try {
    return res.status(201).json({ success: true, thread: await internal.createMessage(await internalActor(req), req.body) });
  } catch (error) { return fail(res, error, "internal/send"); }
});

router.get("/internal/conversations/:id", async (req, res) => {
  try {
    const actor = await internalActor(req);
    const thread = await internal.threadFor(actor, req.params.id);
    if (!thread) return res.status(404).json({ success: false, message: "Conversation not found." });
    await internal.setThreadState(actor, req.params.id, { read: true });
    return res.json({ success: true, thread: { ...thread, unread: false } });
  } catch (error) { return fail(res, error, "internal/thread"); }
});

router.post("/internal/conversations/:id/replies", async (req, res) => {
  try {
    const thread = await internal.reply(await internalActor(req), req.params.id, req.body);
    if (!thread) return res.status(404).json({ success: false, message: "Conversation not found." });
    return res.status(201).json({ success: true, thread });
  } catch (error) { return fail(res, error, "internal/reply"); }
});

router.patch("/internal/conversations/:id/state", async (req, res) => {
  try {
    const thread = await internal.setThreadState(await internalActor(req), req.params.id, req.body);
    if (!thread) return res.status(404).json({ success: false, message: "Conversation not found." });
    return res.json({ success: true });
  } catch (error) { return fail(res, error, "internal/state"); }
});

router.get("/external/status", async (req, res) => {
  try { return res.json({ success: true, ...(await googleMail.status(req.mailPrincipal.actorKey)) }); }
  catch (error) { return fail(res, error, "external/status"); }
});

router.post("/external/connect", async (req, res) => {
  try {
    const url = await googleMail.createConnectUrl(req.mailPrincipal.actorKey);
    return res.json({ success: true, url });
  }
  catch (error) { return fail(res, error, "external/connect"); }
});

router.delete("/external/connection", async (req, res) => {
  try { return res.json({ success: true, disconnected: await googleMail.disconnect(req.mailPrincipal.actorKey) }); }
  catch (error) { return fail(res, error, "external/disconnect"); }
});

router.get("/external/messages", async (req, res) => {
  try {
    return res.json({ success: true, ...(await googleMail.listMessages(req.mailPrincipal.actorKey, {
      folder: req.query.folder,
      query: req.query.q,
      pageToken: req.query.pageToken,
      limit: req.query.limit,
    })) });
  } catch (error) { return fail(res, error, "external/list"); }
});

router.post("/external/messages", async (req, res) => {
  try { return res.status(201).json({ success: true, message: await googleMail.send(req.mailPrincipal.actorKey, req.body) }); }
  catch (error) { return fail(res, error, "external/send"); }
});

router.get("/external/threads/:id", async (req, res) => {
  try { return res.json({ success: true, thread: await googleMail.getThread(req.mailPrincipal.actorKey, req.params.id) }); }
  catch (error) { return fail(res, error, "external/thread"); }
});

router.post("/external/messages/:id/replies", async (req, res) => {
  try { return res.status(201).json({ success: true, message: await googleMail.reply(req.mailPrincipal.actorKey, req.params.id, req.body) }); }
  catch (error) { return fail(res, error, "external/reply"); }
});

router.patch("/external/messages/:id/state", async (req, res) => {
  try {
    await googleMail.setMessageState(req.mailPrincipal.actorKey, req.params.id, req.body);
    return res.json({ success: true });
  } catch (error) { return fail(res, error, "external/state"); }
});

module.exports = router;
module.exports.googleOAuthCallback = googleOAuthCallback;
