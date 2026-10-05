"use strict";
// services/merchandising/developmentNotify.service.js
//
// THE E-MAILS OF THE DEVELOPMENT SELECTION (4 Oct 2026, owner).
//
//   submitted → Sales      "Materials submitted for your approval"
//   approved  → Merchandiser "Sales approved the materials — the style is with R&D"
//   returned  → Merchandiser "Sales sent the materials back", with the reason
//
// Every mail carries the product's details and photos (the same context the
// sample-style mails use) and the FULL material table — kind, material, code,
// variant, colour / finish, placement, the assumed consumption and the
// merchandiser's reason — so the record is on the mail. Best effort: a mail
// that fails never fails the decision that triggered it.

const { DevelopmentFile, DevelopmentBomRevision, BOM_STATE } = require("../../models/CMS_Models/Merchandising/Development");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const { createServiceContext } = require("../companyContext/serviceScope.service");
const { notifyEvent, APP_URL, escapeHtml } = require("../departmentNotify.service");
const { styleEmailContext, imageGalleryHtml, devBomTableHtml } = require("../sampleStyleEmail.service");

const EVENTS = {
  submitted: "development_bom_submitted",
  approved: "development_bom_approved",
  returned: "development_bom_returned",
};

async function notifyDevelopmentBom(kind, { companyId, fileId, revisionNo = null, actor = null, reason = "" } = {}) {
  const eventKey = EVENTS[kind];
  if (!eventKey || !fileId) return { sent: 0, skipped: "unknown-event" };
  const file = await DevelopmentFile.findById(fileId).lean();
  if (!file) return { sent: 0, skipped: "no-file" };
  const revision = (revisionNo != null
    ? await DevelopmentBomRevision.findOne({ developmentFileId: file._id, revisionNo }).lean()
    : null)
    || await DevelopmentBomRevision.findOne({ developmentFileId: file._id, state: { $in: [BOM_STATE.SUBMITTED, BOM_STATE.APPROVED, BOM_STATE.DRAFT] } }).sort({ revisionNo: -1 }).lean();
  const rows = revision?.rows || [];

  const style = file.sampleStyleId ? await SampleStyle.findById(file.sampleStyleId) : null;
  let c = null;
  if (style) {
    try { c = await styleEmailContext(style, createServiceContext({ companyId: companyId || file.companyId, reason: "development selection e-mail", legacyAware: true })); }
    catch { c = null; }
  }
  const product = file.productName || style?.productName || "";
  const who = actor?.name || (kind === "submitted" ? "Merchandising" : "Sales");
  const customer = c?.customerName || file.buyerDisplayLabel || "";
  const styleCode = style?.styleCode || file.styleRef || "";
  const rev = revision?.revisionNo != null ? ` (revision ${revision.revisionNo})` : "";
  const details = [
    ...(c?.details || [["Customer", customer], ["Style code", styleCode], ["Product", product]]),
    ["Development file", file.developmentNumber],
    ["Materials", `${rows.length} line${rows.length === 1 ? "" : "s"}`],
    ...(kind === "returned" && reason ? [["Reason", reason]] : []),
  ];
  const extraHtml = imageGalleryHtml(c?.images || []) + devBomTableHtml(rows);
  const salesUrl = style?.journeyId ? `${APP_URL}/sales/dashboard/journeys/${style.journeyId}/style-sample` : `${APP_URL}/sales/dashboard`;
  const merchUrl = `${APP_URL}/merchandiser/development/${file._id}`;

  const copy = {
    submitted: {
      heading: `Materials submitted for approval: ${product}`,
      bodyHtml: `<p><strong>${escapeHtml(who)}</strong> submitted the material selection${rev} for this style. Open the style's BOM Approval step to approve it (which sends the style to R&D) or send it back with a reason.</p>`,
      bodyText: `${who} submitted the material selection${rev} for "${product}" (${customer}). Approve it on the pipeline or send it back with a reason.`,
      ctaLabel: "Open the style", ctaUrl: salesUrl,
    },
    approved: {
      heading: `Materials approved: ${product}`,
      bodyHtml: `<p><strong>${escapeHtml(who)}</strong> approved the material selection${rev}. The style has gone to R&D for the tech sheet.</p>`,
      bodyText: `${who} approved the material selection${rev} for "${product}" (${customer}). The style has gone to R&D.`,
      ctaLabel: "Open the development file", ctaUrl: merchUrl,
    },
    returned: {
      heading: `Materials sent back: ${product}`,
      bodyHtml: `<p><strong>${escapeHtml(who)}</strong> sent the material selection${rev} back for changes.</p>${reason ? `<p style="margin:10px 0 0;color:#475569">${escapeHtml(reason)}</p>` : ""}`,
      bodyText: `${who} sent the material selection${rev} for "${product}" (${customer}) back for changes.${reason ? ` Reason: ${reason}` : ""}`,
      ctaLabel: "Open the development file", ctaUrl: merchUrl,
    },
  }[kind];

  return notifyEvent(eventKey, {
    vars: { product, customer, styleCode, person: who, reason },
    heading: copy.heading, bodyHtml: copy.bodyHtml, bodyText: copy.bodyText,
    details, image: c?.images?.[0], extraHtml,
    ctaLabel: copy.ctaLabel, ctaUrl: copy.ctaUrl,
  });
}

module.exports = { notifyDevelopmentBom };
