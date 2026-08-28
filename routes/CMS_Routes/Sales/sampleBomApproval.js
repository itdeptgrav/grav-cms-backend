// routes/CMS_Routes/Sales/sampleBomApproval.js
//
// The Project Manager's BOM decision, made FROM THE EMAIL — the only
// unauthenticated route in the Sales module, and deliberately so.
//
// 28 Aug 2026, explicit request: step 2 of Style & Sample asks the Project
// Manager to approve the BOM, "so here on that mail they need to approve/reject
// the request ok.. so if approve then it will goona auto trigger here (don't
// keep manual button here for production manager approval ok) for approval..
// or if reject then here it will show for Sent Approval Again".
//
// Extended the same day, once the page was actually used: it needed the full
// customer/product/photo/BOM context the request email itself carries ("in the
// webpage where the product manager is redirecting... showcase everything means
// proper details"), and it needed to stop being a one-shot page ("don't make it
// temporary page ok, if the product manager come to that page for second time
// also he can see the history ki what action he have taken ok and whom, what
// time and all").
//
// WHY NOT A NORMAL AUTHENTICATED ROUTE. Every other approve/reject in this
// backend sits behind a login because it is pressed inside the CMS. This one is
// pressed inside Outlook. Sending the manager to a login screen to record a
// yes/no is exactly the friction that makes email approvals get ignored, and it
// is the reason the decision has to auto-trigger back in the stage rather than
// being re-entered by Sales afterwards.
//
// WHAT STANDS IN FOR THE LOGIN:
//   • A 24-byte random token, minted per request and stored `select:false` on
//     the style. Guessing it is not a realistic attack; not having it is a 404.
//   • The token ROTATES on every send ("Send Approval Again"), so a decision
//     link from a superseded round is dead. An approval can never be replayed
//     against a BOM that has since been revised.
//   • It is NOT single-use any more (28 Aug 2026 — see above). The SAME link
//     stays valid to REVISIT after a decision, showing what was decided, by
//     whom, and when, plus the full request→decision history — it just can no
//     longer RECORD a second decision once one exists. "Not recordable twice"
//     and "not visitable twice" turned out to be two different requirements;
//     only the first one is actually a security property.
//   • It only ever writes THIS ONE FIELD (well, one sub-document) on THIS ONE
//     style. There is no session, nothing else becomes reachable, and the
//     worst case for a leaked link is a BOM decision Sales can see the audit
//     trail for and re-request.
//
// WHY GET RENDERS A PAGE AND POST RECORDS. Corporate mail security (Outlook
// Safe Links, scanners, some mobile previewers) FETCHES the links in a message
// to check them. A GET that recorded the decision would be silently approving
// BOMs the moment the email arrived. So GET only ever shows a confirmation
// screen (or, once decided, a read-only status screen); the decision itself is
// only ever a POST from a real button press — "don't auto accept/reject upon
// considering the clicked button on the mail... also ask for the confirmation".
//
// HTML is rendered here rather than on the CMS frontend because the reader is
// not signed in and may not be on the corporate network — a self-contained page
// from the API is the one thing guaranteed to work from any inbox on any device.

"use strict";

const express = require("express");
const mongoose = require("mongoose");
const crypto = require("crypto");
const router = express.Router();

const SampleStyle = require("../../../models/CMS_Models/Sales/SampleStyle");
const {
  notifyEvent, APP_URL: DEPT_NOTIFY_APP_URL, escapeHtml,
} = require("../../../services/departmentNotify.service");
const { styleEmailContext, imageGalleryHtml, bomTableHtml } = require("../../../services/sampleStyleEmail.service");

const DECISIONS = { approve: "approved", reject: "rejected" };

// What a style's own history entries are called, on this page. Reuses the
// SAME `kind` strings sampleStyles.js already logs (`bom_approval_requested`
// on send, `bom_approved`/`bom_rejected` here on decide) — one history, read
// by both the Sales dashboard's timeline and this page, so the two can never
// disagree about what happened.
const BOM_HISTORY_KINDS = new Set(["bom_approval_requested", "bom_approved", "bom_rejected"]);
const HISTORY_LABEL = {
  bom_approval_requested: "Approval requested",
  bom_approved: "BOM approved",
  bom_rejected: "BOM rejected",
};
const fmtWhen = (d) => {
  try { return new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }); }
  catch { return ""; }
};

/**
 * The full request→decision trail for THIS style's BOM approval, oldest
 * first — what answers "what action have I taken, and when" on a revisit.
 */
function historyTimelineHtml(style) {
  const entries = (style.history || [])
    .filter((h) => BOM_HISTORY_KINDS.has(h.kind))
    .sort((a, b) => new Date(a.at) - new Date(b.at));
  if (!entries.length) return "";
  return `<p style="margin:18px 0 6px;font-size:12px;color:#64748b;font-weight:600">HISTORY</p>
<div>${entries.map((h) => `<div style="padding:8px 0;border-top:1px solid #eef1f5">
  <p style="margin:0;font-size:13.5px;font-weight:600;color:#0f172a">${escapeHtml(HISTORY_LABEL[h.kind] || h.kind)}</p>
  <p style="margin:2px 0 0;font-size:12px;color:#64748b">${escapeHtml(h.by?.name || "—")} &middot; ${escapeHtml(fmtWhen(h.at))}</p>
  ${h.note ? `<p style="margin:5px 0 0;font-size:13px;color:#334155">&ldquo;${escapeHtml(h.note)}&rdquo;</p>` : ""}
</div>`).join("")}</div>`;
}

// ── The page ────────────────────────────────────────────────────────────────
// One shell, several states (confirm / status / error), so a manager who opens
// an old or already-decided link gets a real, useful page rather than a stack
// trace, a blank 404 body, or (before 28 Aug 2026) a scary "no longer valid".
function page({ title, tone = "neutral", intro, detailRows = [], extraHtml = "", formHtml = "", footer }) {
  const accent = tone === "positive" ? "#15803d" : tone === "negative" ? "#b91c1c" : "#0f172a";
  const rows = detailRows.filter(Boolean).map(([l, v]) =>
    `<tr><td style="padding:6px 18px 6px 0;color:#64748b;font-weight:600;white-space:nowrap;vertical-align:top">${escapeHtml(l)}</td><td style="color:#0f172a;padding:6px 0">${escapeHtml(v)}</td></tr>`
  ).join("");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)} &middot; GRAV</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;background:#f1f5f9;margin:0;padding:24px;color:#0f172a}
  .card{max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 10px 30px -12px rgba(15,23,42,.25)}
  .bar{background:#0f172a;padding:16px 24px;color:#fff;font-weight:700;font-size:15px}
  .body{padding:24px}
  h1{font-size:18px;margin:0 0 10px;color:${accent}}
  p{font-size:14px;line-height:1.6;margin:0 0 12px}
  table{border-collapse:collapse;font-size:13.5px;margin:16px 0;width:100%}
  textarea{width:100%;box-sizing:border-box;font:inherit;font-size:14px;padding:10px;border:1px solid #cbd5e1;border-radius:8px;min-height:90px}
  label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}
  button{font:inherit;font-weight:600;font-size:14px;padding:11px 24px;border:0;border-radius:8px;color:#fff;background:${accent};cursor:pointer}
  .muted{font-size:12px;color:#94a3b8;margin-top:20px;border-top:1px solid #e2e8f0;padding-top:14px}
  a{color:#0f172a}
</style></head>
<body><div class="card">
  <div class="bar">GRAV &middot; Manufacturing Suite</div>
  <div class="body">
    <h1>${escapeHtml(title)}</h1>
    ${intro ? `<p>${intro}</p>` : ""}
    ${rows ? `<table>${rows}</table>` : ""}
    ${extraHtml}
    ${formHtml}
    <p class="muted">${footer || "You received this because you are the Project Manager on record in Access Control."}</p>
  </div>
</div></body></html>`;
}

/**
 * Load the style this token belongs to, or null.
 *
 * `token` is `select:false` on the schema, so it has to be asked for
 * explicitly — which is also the guard against ever returning it in a normal
 * style read. Compared with `timingSafeEqual` on equal-length buffers: a
 * plain `===` on a secret leaks its prefix through response timing, and this
 * is the one route in the module where an attacker controls the comparison
 * input directly.
 */
async function loadByToken(styleId, token) {
  if (!mongoose.Types.ObjectId.isValid(styleId) || !token) return null;
  const style = await SampleStyle.findById(styleId).select("+bomApproval.token");
  const stored = style?.bomApproval?.token;
  if (!stored) return null;
  const a = Buffer.from(String(stored));
  const b = Buffer.from(String(token));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return style;
}

const expired = (res) =>
  res.status(410).send(page({
    title: "This approval link is no longer valid",
    tone: "negative",
    intro: "It doesn't match any pending or decided BOM approval for this style — most likely a newer approval request "
      + "has since been sent, which retires every link from the round before it. "
      + "If you still need to record a decision, ask the Sales team to re-send the request.",
    footer: "No decision was recorded.",
  }));

/**
 * The read-only page for a round that's ALREADY been decided — what a
 * revisit of the same link shows instead of "expired" (28 Aug 2026). Also
 * what a duplicate POST (double form-submit, back-button resend) resolves to,
 * so a replay is a no-op that shows the truth, not an error.
 */
async function statusPage(style, { justDecided = false } = {}) {
  const c = await styleEmailContext(style);
  const approved = style.bomApproval.status === "approved";
  return page({
    title: justDecided
      ? (approved ? "BOM approved — thank you" : "BOM rejected — thank you")
      : `This BOM was already ${style.bomApproval.status}`,
    tone: approved ? "positive" : "negative",
    intro: approved
      ? `You approved this Bill of Materials${style.bomApproval.decidedAt ? ` on ${escapeHtml(fmtWhen(style.bomApproval.decidedAt))}` : ""}. Sales can now release this style to R&amp;D for sample development.`
      : `You rejected this Bill of Materials${style.bomApproval.decidedAt ? ` on ${escapeHtml(fmtWhen(style.bomApproval.decidedAt))}` : ""}.${style.bomApproval.note ? ` Your reason: &ldquo;${escapeHtml(style.bomApproval.note)}&rdquo;` : ""} Merchandising has been notified to revise and resubmit.`,
    // The FULL customer/product spec (28 Aug 2026 fix — this used to hand-pick
    // three rows here, which is what "some informations are goona skipped"
    // was reported against: the email carries the whole spec via `c.details`,
    // but this page was quietly dropping everything past Customer/Product/
    // Style code). Decision facts appended after it, same as the email's own
    // details list does.
    detailRows: [
      ...c.details,
      ["Decision", approved ? "Approved" : "Rejected"],
      ["Decided by", style.bomApproval.decidedByName || undefined],
      ["Reason", style.bomApproval.note || undefined],
    ],
    extraHtml: `${imageGalleryHtml(c.images)}${bomTableHtml(c.bom, c.variantTotal)}${historyTimelineHtml(style)}`,
    footer: "This link stays valid to look back on — nothing further to do here.",
  });
}

// ── GET — show the confirmation screen (pending) or the status/history page
// (already decided). Never records anything. ────────────────────────────────
router.get("/:styleId/:token", async (req, res) => {
  try {
    const style = await loadByToken(req.params.styleId, req.params.token);
    if (!style) return expired(res);

    // Already decided — a revisit, NOT a dead link (28 Aug 2026, see file
    // header). Shows the same page a decision resolves to.
    if (style.bomApproval.status !== "pending") {
      return res.send(await statusPage(style));
    }

    const decision = req.query.d === "reject" ? "reject" : "approve";
    const rejecting = decision === "reject";
    const c = await styleEmailContext(style);

    return res.send(page({
      title: rejecting ? "Reject this BOM?" : "Approve this BOM?",
      tone: rejecting ? "negative" : "positive",
      intro: rejecting
        ? "Please confirm you are rejecting the Bill of Materials for the product below, and state what needs to be corrected."
        : "Please confirm you are approving the Bill of Materials for the product below. Sales will then release the style to R&amp;D for development.",
      detailRows: [
        ...c.details,
        ["Requested by", style.bomApproval?.requestedBy?.name || "Sales"],
        ["Decision needed by", style.bomApproval?.deadline ? fmtWhen(style.bomApproval.deadline) : undefined],
      ],
      extraHtml: `${imageGalleryHtml(c.images)}${bomTableHtml(c.bom, c.variantTotal)}`,
      formHtml: `<form method="POST" action="">
        <input type="hidden" name="decision" value="${rejecting ? "reject" : "approve"}" />
        <label for="note">${rejecting ? "Reason for rejection (required)" : "Note (optional)"}</label>
        <textarea id="note" name="note" ${rejecting ? "required" : ""} placeholder="${rejecting ? "e.g. Fabric GSM is not available with the listed vendor — please re-pick." : "Anything the team should know."}"></textarea>
        <p style="margin-top:16px"><button type="submit">${rejecting ? "Confirm rejection" : "Confirm approval"}</button></p>
      </form>`,
      footer: "Nothing has been recorded yet — your decision is saved when you press the button above.",
    }));
  } catch (err) {
    console.error("[bomApproval] GET", err);
    return res.status(500).send(page({ title: "Something went wrong", tone: "negative", intro: "Please try the link again, or contact the Sales team." }));
  }
});

// ── POST — record it (once). ────────────────────────────────────────────────
router.post("/:styleId/:token", express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const style = await loadByToken(req.params.styleId, req.params.token);
    if (!style) return expired(res);

    // Already decided — a duplicate submit (double-click, back-button
    // resend, or the same GET-then-POST replayed). Not an error: show the
    // recorded outcome instead of recording a second one.
    if (style.bomApproval.status !== "pending") {
      return res.send(await statusPage(style));
    }

    const decision = req.body?.decision === "reject" ? "reject" : "approve";
    const note = String(req.body?.note || "").trim().slice(0, 2000);
    if (decision === "reject" && !note) {
      const c = await styleEmailContext(style);
      return res.status(400).send(page({
        title: "A reason is required",
        tone: "negative",
        intro: "Please go back and say what needs to be corrected, so Merchandising knows what to revise.",
        detailRows: c.details,
        extraHtml: `${imageGalleryHtml(c.images)}${bomTableHtml(c.bom, c.variantTotal)}`,
        footer: "No decision was recorded.",
      }));
    }

    // Who decided. There is no session, so this is the honest answer: the
    // role the request was addressed to. Sales and Merchandising see
    // "Project Manager (via email)" rather than a name the system cannot
    // actually verify from an unauthenticated click.
    const decidedByName = "Project Manager (via email)";
    style.bomApproval.status = DECISIONS[decision];
    style.bomApproval.decidedAt = new Date();
    style.bomApproval.decidedByName = decidedByName;
    style.bomApproval.decidedByEmail = "";
    style.bomApproval.note = note;
    // The token is DELIBERATELY kept (28 Aug 2026 — see file header): the
    // same link must keep working to show the recorded decision on a
    // revisit. What actually stops a second decision is the status check
    // above, not the token's existence.
    if (!Array.isArray(style.history)) style.history = [];
    style.history.push({
      kind: decision === "approve" ? "bom_approved" : "bom_rejected",
      from: "materials", to: "materials",
      note, by: { name: decidedByName }, at: new Date(),
    });
    await style.save();

    // Tell Merchandising (who built the BOM) AND Sales (who asked for the
    // decision) — one shared, Sales-authored template per outcome (28 Aug
    // 2026, explicit request: this used to reach only Sales, with fixed
    // wording). Fire-and-forget: the manager's decision is already saved,
    // and a mail failure must not turn their confirmation into an error.
    (async () => {
      const c = await styleEmailContext(style);
      const salesPerson = style.bomApproval?.requestedBy?.name || "Sales";
      const eventKey = decision === "approve" ? "sample_bom_approved" : "sample_bom_rejected";
      await notifyEvent(eventKey, {
        vars: {
          product: style.productName || "", customer: c.customerName, salesPerson,
          styleCode: style.styleCode || style.sampleStyleId || "", decidedBy: decidedByName,
          reason: note || "",
        },
        heading: `BOM ${DECISIONS[decision]}: ${style.productName || style.styleCode || ""}`,
        bodyHtml: `<p>The Project Manager <strong>${decision === "approve" ? "approved" : "rejected"}</strong> the Bill of Materials for this style.${
          note ? ` They wrote: &ldquo;${escapeHtml(note)}&rdquo;` : ""
        }</p>${decision === "approve"
          ? "<p>Sales can now send this style to R&amp;D from the Style &amp; Sample stage.</p>"
          : "<p>Please revise the BOM on the product; Sales will send the approval request again once it's updated.</p>"}`,
        details: [
          ...c.details,
          ["Decision", decision === "approve" ? "Approved" : "Rejected"],
          ["Decided by", decidedByName],
          ["Reason", note || undefined],
        ],
        image: c.images[0],
        extraHtml: `${imageGalleryHtml(c.images)}${bomTableHtml(c.bom, c.variantTotal)}`,
        bodyText: `The Project Manager ${decision === "approve" ? "approved" : "rejected"} the BOM for "${style.productName}" (${c.customerName}).${note ? ` Reason: ${note}` : ""}`,
        ctaLabel: "View Product",
        ctaUrl: c.viewUrl || `${DEPT_NOTIFY_APP_URL}/sales/dashboard`,
      });
    })().catch(() => {});

    return res.send(await statusPage(style, { justDecided: true }));
  } catch (err) {
    console.error("[bomApproval] POST", err);
    return res.status(500).send(page({ title: "Something went wrong", tone: "negative", intro: "Your decision was not recorded. Please try the link again, or contact the Sales team." }));
  }
});

module.exports = router;
