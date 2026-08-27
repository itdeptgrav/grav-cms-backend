// services/sampleWhatsapp.js
//
// The sample-approval-specific WhatsApp flow (26 Aug 2026, explicit request:
// "this approval request need to auto sent to that customer ok in
// whatsapp... the customer just need to click on approve/reject button...
// so that will auto trigger here in our website").
//
// Everything GENERIC already existed in this codebase before today —
// services/whatsappSend.js (Graph API calls), services/whatsappStore.js
// (conversation/message storage + webhook ingestion),
// routes/CMS_Routes/Sales/whatsappWebhook.js (the public webhook Meta
// calls), config/whatsapp.js (credentials). This module is only the glue
// specific to SampleStyle.customerApproval: who to send the approval
// request to, what to send, and how an inbound button tap turns into the
// same decision routes/CMS_Routes/Sales/sampleStyles.js's
// POST /:id/sample/customer-decision already records when Sales enters it
// by hand.
"use strict";

const Account = require("../models/CMS_Models/Sales/Account");
const SampleStyle = require("../models/CMS_Models/Sales/SampleStyle");
const { findOrCreateByPhone } = require("./whatsappStore");
const { sendTemplate, sendText } = require("./whatsappSend");
const { cfg, canSend, mediaUploadUrl } = require("../config/whatsapp");
const { buildApprovalPdf } = require("./sampleApprovalPdf");
const { isSampleSettled } = require("./sampleReadiness");

/**
 * Upload a file to Meta so it can be referenced by media id in a template's
 * header component — a header can't carry raw bytes inline, only an id
 * (this) or a link Meta fetches itself. Throws Meta's own error message on
 * failure, same convention as sendTemplate/sendMessage in whatsappSend.js.
 */
async function uploadMedia(buffer, { filename, mimeType }) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", new Blob([buffer], { type: mimeType }), filename);
  const res = await fetch(mediaUploadUrl(), {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.accessToken}` },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) throw new Error(data?.error?.message || `WhatsApp media upload failed (HTTP ${res.status}).`);
  return data.id;
}

// Not a Sales user — Meta is calling, not a logged-in person — so this
// stands in for `actor(req)` everywhere a decision made over WhatsApp needs
// a `{id, name}` shape (history entries, customerApproval.decidedBy).
const WHATSAPP_ACTOR = Object.freeze({ id: null, name: "Customer (via WhatsApp)" });

/**
 * The best phone number to message for this style's customer, or null.
 *
 * Account.primaryContact (the reference field) and Contact.isPrimary (a flag
 * on the Contact itself) are two SEPARATE things this codebase does not keep
 * in sync — verified 26 Aug 2026 against a real account with a Contact
 * marked isPrimary:true whose id was never actually written back onto
 * Account.primaryContact, so following only the reference silently found
 * nothing ("This customer has no phone number on file." on an account that
 * plainly has one). Falls through: the account's own primaryContact ref,
 * then whichever Contact under this account is itself flagged primary, then
 * any active Contact under it at all, then the account's own switchboard
 * number.
 */
async function resolveCustomerPhone(style) {
  if (!style.accountId) return null;
  const account = await Account.findById(style.accountId)
    .select("primaryPhone")
    .populate("primaryContact", "phone")
    .lean();
  if (account?.primaryContact?.phone) return account.primaryContact.phone;

  const Contact = require("../models/CMS_Models/Sales/Contact");
  const contacts = await Contact.find({ accountId: style.accountId, isActive: true })
    .select("phone isPrimary")
    .sort({ isPrimary: -1 })
    .limit(1)
    .lean();
  if (contacts[0]?.phone) return contacts[0].phone;

  return account?.primaryPhone || null;
}

/**
 * Send the sample-approval template to the customer and record the
 * outbound message id on the style so the webhook can match a reply back
 * to THIS specific approval request (see applyDecisionFromButtonReply).
 *
 * Never throws — a misconfigured or unreachable WhatsApp setup must not
 * break the internal Sales approval action that triggers this; the caller
 * gets back a result to surface, not an exception to handle.
 *
 * @returns {Promise<{sent:boolean, reason?:string}>}
 */
async function sendApprovalRequest(style, { customerName, enquiryRef, preparedBy } = {}) {
  if (!canSend()) {
    return { sent: false, reason: "WhatsApp sending isn't configured (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID)." };
  }
  const templateName = (process.env.WHATSAPP_APPROVAL_TEMPLATE_NAME || "").trim();
  if (!templateName) {
    return { sent: false, reason: "No WHATSAPP_APPROVAL_TEMPLATE_NAME configured yet — set it to the exact approved template name from WhatsApp Manager." };
  }

  let phone;
  try {
    phone = await resolveCustomerPhone(style);
  } catch {
    phone = null;
  }
  if (!phone) {
    return { sent: false, reason: "This customer has no phone number on file." };
  }

  try {
    // product_approval's header is a PDF DOCUMENT — verified 26 Aug 2026 by
    // reading the template off the Graph API. Meta does not reuse the
    // example file from template creation; a real document has to be
    // attached on every send, so the same formal sample sheet the in-app
    // "Download sample PDF" button produces is built again here (server
    // side — sampleApprovalPdf.js, pdfkit) and uploaded first.
    const pdfBuffer = await buildApprovalPdf(style, { customerName, enquiryRef, preparedBy });
    const filename = `${(style.productName || "product").replace(/[^\w-]+/g, "_")}_sample_for_approval.pdf`;
    const mediaId = await uploadMedia(pdfBuffer, { filename, mimeType: "application/pdf" });

    const conv = await findOrCreateByPhone({ phone, accountId: style.accountId, name: customerName });
    // No BODY variables — this template's body has none (verified the same
    // way). Only the header needs a components entry, carrying the
    // just-uploaded document.
    const stored = await sendTemplate(
      conv,
      {
        name: templateName,
        language: process.env.WHATSAPP_APPROVAL_TEMPLATE_LANG || "en",
        components: [{ type: "header", parameters: [{ type: "document", document: { id: mediaId, filename } }] }],
      },
      WHATSAPP_ACTOR,
    );
    style.customerApproval = style.customerApproval || {};
    style.customerApproval.whatsapp = {
      sentAt: new Date(),
      phone,
      messageId: stored.waMessageId,
      status: "sent",
      statusUpdatedAt: new Date(),
      error: "",
    };
    await style.save();
    return { sent: true };
  } catch (err) {
    style.customerApproval = style.customerApproval || {};
    style.customerApproval.whatsapp = {
      sentAt: style.customerApproval.whatsapp?.sentAt || null,
      phone,
      messageId: style.customerApproval.whatsapp?.messageId || "",
      status: "failed",
      statusUpdatedAt: new Date(),
      error: err.message,
    };
    await style.save().catch(() => {});
    return { sent: false, reason: err.message };
  }
}

/**
 * A customer's WhatsApp button tap, matched by the outbound template
 * message's own id (Meta's `context.id` on the inbound reply — the
 * "replying to" reference every button/quick-reply message carries).
 *
 * Mirrors routes/CMS_Routes/Sales/sampleStyles.js's POST
 * /:id/sample/customer-decision — same fields written, same append-only
 * log — with WHATSAPP_ACTOR standing in for the Sales user, and no
 * salesAuth/canApprove gate (nothing to gate — Meta is calling, not a
 * logged-in person).
 *
 * Runs for EVERY inbound button tap across the whole WhatsApp inbox (this
 * is called from the generic webhook ingestion, not a sample-specific
 * route), so it silently no-ops — never throws — whenever the id doesn't
 * match an in-flight approval, the style has already moved on, or the
 * button text isn't recognizably "approve"/"reject": a reply to an
 * unrelated conversation, a stale reply to a request that was superseded,
 * or a duplicate/late tap after a decision already landed must never
 * overwrite a real decision or crash webhook ingestion for everyone else's
 * messages in the same batch.
 *
 * @returns {Promise<object|null>} the updated style, or null if nothing matched.
 */
async function applyDecisionFromButtonReply({ contextMessageId, buttonText }) {
  if (!contextMessageId) return null;
  const style = await SampleStyle.findOne({ "customerApproval.whatsapp.messageId": contextMessageId });
  if (!style) return null;
  if (!isSampleSettled(style)) return null;
  if (style.customerApproval?.approved != null) return null;

  // The template's buttons started as literally "yes"/"no" (verified 26 Aug
  // 2026 off the Graph API), then were reworded to "Yes I approved the
  // Sample" / "Reject this Sample" (same date, explicit request — plain
  // yes/no read as too casual for a formal approval). Matched by prefix so
  // either wording — or any future rewording that still starts with
  // yes/approve/no/reject — keeps working without another code change.
  const t = String(buttonText || "").trim().toLowerCase();
  const approved = t.startsWith("yes") || t.startsWith("approve") ? true
    : t.startsWith("no") || t.startsWith("reject") ? false
      : null;
  if (approved === null) return null; // unrecognized text — don't guess on a real decision

  const note = `Replied "${buttonText}" on WhatsApp`;
  const now = new Date();
  style.customerApproval.log = style.customerApproval.log || [];
  style.customerApproval.log.push({ approved, decidedAt: now, decidedBy: WHATSAPP_ACTOR, note });
  style.customerApproval.approved = approved;
  style.customerApproval.decidedAt = now;
  style.customerApproval.decidedBy = WHATSAPP_ACTOR;
  style.customerApproval.note = note;
  style.customerRejected = !approved;

  if (!Array.isArray(style.history)) style.history = [];
  style.history.push({
    kind: approved ? "customer_sample_approved" : "customer_sample_rejected",
    note,
    by: WHATSAPP_ACTOR,
    at: now,
  });
  style.updatedBy = WHATSAPP_ACTOR;
  await style.save();

  // A confirmation reply back to the customer (26 Aug 2026, explicit
  // request: "once the customer made an action, an proper response message
  // also need to sent ok"). Free-form text is only valid inside the 24h
  // customer-service window — but the button tap being handled right now IS
  // the inbound message that opens/refreshes that window, so sending back
  // immediately is always inside it. Best-effort: the decision is already
  // saved above, so a failed confirmation must never look like a failed
  // match to the caller (ingestWebhook's own try/catch would otherwise log
  // it as "button match failed", which would be misleading).
  try {
    const phone = style.customerApproval.whatsapp?.phone;
    if (phone) {
      const conv = await findOrCreateByPhone({ phone, accountId: style.accountId });
      const reply = approved
        ? `Thank you — we've recorded your approval for "${style.productName}". We'll be in touch with the next steps shortly.`
        : `Noted — we've recorded that "${style.productName}" was not approved. Our team will follow up with you shortly.`;
      await sendText(conv, reply, WHATSAPP_ACTOR);
    }
  } catch (err) {
    console.error("[sampleWhatsapp] confirmation reply failed:", err.message);
  }

  return style;
}

module.exports = { sendApprovalRequest, applyDecisionFromButtonReply, resolveCustomerPhone, WHATSAPP_ACTOR };
