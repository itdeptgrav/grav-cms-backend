// services/departmentNotify.service.js
//
// Cross-department "something happened, you should know" EMAIL notifications —
// distinct from the two email senders already in this backend:
//   - utils/salesEmailService.js         → customer-facing (quotations, welcome…)
//   - services/emailNotifications.service.js → CoWork's own app, CoWork's own audience
// This one notifies STAFF on another department's CMS dashboard (Merchandiser,
// Project Manager, R&D, …) when a Sales-side event concerns them.
//
// WHO GETS NOTIFIED is decided by Access Control — AccessDepartment/DeptUser,
// plus Employee.accessDepartmentId/additionalDepartmentIds, resolved the SAME
// way routes/auth/deptAuth.js's login decides who may open that dashboard.
// There is deliberately no separate "recipients" list to maintain: grant
// someone that department, they start receiving its event emails; revoke it,
// they stop. See resolveDepartmentRecipients below.
//
// WHETHER an event sends at all is the one thing Sales controls — from Sales
// Settings → Department Notifications, stored on SalesSettings.
// departmentNotifications.disabledEvents (an opt-OUT list; everything is ON
// by default). WHICH departments a given event notifies is NOT configurable
// there — that is business logic, fixed per event in EVENT_REGISTRY below.
//
// Every entry point (notifyEvent) is best-effort and never throws: a
// notification failing must never break the request that triggered it. Call
// it WITHOUT awaiting from a route handler, same discipline enquiries.js
// already follows for its web-push notifyAssignee().

const axios = require("axios");
const AccessDepartment = require("../models/Access/AccessDepartment");
const DeptUser = require("../models/Access/DeptUser");
const Employee = require("../models/Employee");
const SalesSettings = require("../models/CMS_Models/Sales/SalesSettings");

// ── Event registry ──────────────────────────────────────────────────────────
// key + label/description (read by the Sales Settings page) + the FIXED set
// of department slugs (see services/ensureAccessDepartments.js and
// scripts/seedRnDDepartment.js) each event notifies.
const EVENT_REGISTRY = [
  {
    key: "enquiry_created",
    label: "New enquiry created",
    description: "Merchandising and the Project Manager are notified when Sales opens a new Enquiry/RFQ.",
    departments: ["merchandiser", "project-manager"],
  },
  {
    key: "sample_sent_to_rnd",
    label: "Sample sent to R&D",
    description: "R&D is notified when Sales routes a style to them for tech-pack / development.",
    departments: ["research-development"],
  },
  {
    key: "materials_change_requested",
    label: "Materials change requested",
    description: "Sales is notified when Merchandising or the Project Manager proposes a materials change for a style.",
    departments: ["sales"],
  },
  {
    key: "tech_sheet_submitted",
    label: "Tech sheet submitted",
    description: "Sales is notified when R&D submits a tech sheet for review.",
    departments: ["sales"],
  },
  {
    key: "tech_sheet_decision",
    label: "Tech sheet approved / changes requested",
    description: "R&D is notified when Sales approves a tech sheet, or asks for changes.",
    departments: ["research-development"],
  },
  {
    key: "sample_submitted",
    label: "Sample submitted for approval",
    description: "Sales is notified when R&D submits a physical sample — with photos — for approval.",
    departments: ["sales"],
  },
  {
    key: "sample_decision",
    label: "Sample approved / rejected",
    description: "R&D is notified when Sales approves or rejects a submitted sample.",
    departments: ["research-development"],
  },
  {
    key: "costing_sent_to_customer",
    label: "Cost & Invoicing sent to customer",
    description: "Merchandising and the Project Manager are notified when Sales sends pricing to the customer.",
    departments: ["merchandiser", "project-manager"],
  },
  {
    key: "customer_decision_recorded",
    label: "Customer approved / rejected quote",
    description: "Merchandising and the Project Manager are notified when Sales records what the customer decided.",
    departments: ["merchandiser", "project-manager"],
  },
  {
    key: "stock_item_requested",
    label: "Stock item requested",
    description: "Merchandising is notified when Sales asks for a costed product to be added to inventory.",
    departments: ["merchandiser"],
  },
  {
    key: "stock_item_request_decided",
    label: "Stock item request approved / rejected",
    description: "Sales is notified when Merchandising approves or rejects a stock-item request.",
    departments: ["sales"],
  },
  // Split into two keys, not one "stock_item_created" fired at both
  // departments, because each needs a DIFFERENT task message in the body
  // (26 Aug 2026, explicit request: "if the id is for merchantiser then
  // represent it like for the ur task is to now fill the pricing, BOM
  // creation... and for the production manager, represent the message for
  // put the operations, measurements parameters, company costing, cmp
  // costings"). notifyEvent() sends one ctx to every department an event
  // lists, so two audiences with two different messages need two events.
  {
    key: "stock_item_created_merchandiser",
    label: "New product created — Merchandiser task",
    description: "Merchandising is notified when a new product is created, with pricing/BOM as their next step.",
    departments: ["merchandiser"],
  },
  {
    key: "stock_item_created_production",
    label: "New product created — Production task",
    description: "The Production Supervisor is notified when a new product is created, with operations/costing as their next step.",
    departments: ["production-supervisor"],
  },
];
const EVENT_BY_KEY = new Map(EVENT_REGISTRY.map((e) => [e.key, e]));

function listEvents() {
  return EVENT_REGISTRY.map((e) => ({ key: e.key, label: e.label, description: e.description, departments: e.departments }));
}

async function isEventEnabled(eventKey) {
  const settings = await SalesSettings.findOne().select("departmentNotifications").lean();
  const disabled = settings?.departmentNotifications?.disabledEvents || [];
  return !disabled.includes(eventKey);
}

/** Small helper: add an employee to the recipient map, keyed by lowercase email. */
function addEmployee(map, e) {
  if (!e.email) return;
  map.set(e.email.toLowerCase(), `${e.firstName || ""} ${e.lastName || ""}`.trim() || e.email);
}

/**
 * Every unique, emailable person with access to a department — dept_users
 * rows in it, plus employees granted it (explicitly via accessDepartmentId /
 * additionalDepartmentIds, or — when an employee has NO explicit grant at
 * all — by the same department-NAME fallback routes/auth/deptAuth.js's own
 * login (resolveEmployeeDepartments) uses, so "who can reach this dashboard"
 * and "who gets emailed about it" never quietly disagree.
 */
async function resolveDepartmentRecipients(slug) {
  const dept = await AccessDepartment.findOne({ slug, isActive: true });
  if (!dept) return [];
  const recipients = new Map();

  const deptUsers = await DeptUser.find({ departmentId: dept._id, isActive: true }).select("name email");
  for (const u of deptUsers) if (u.email) recipients.set(u.email.toLowerCase(), u.name || u.email);

  const activeCond = { $or: [{ status: "active" }, { isActive: true }] };

  const granted = await Employee.find({
    $and: [activeCond, { $or: [{ accessDepartmentId: dept._id }, { additionalDepartmentIds: dept._id }] }],
  }).select("firstName lastName email");
  for (const e of granted) addEmployee(recipients, e);

  const escaped = dept.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nameMatched = await Employee.find({
    $and: [
      activeCond,
      { accessDepartmentId: { $exists: false } },
      { $or: [{ additionalDepartmentIds: { $exists: false } }, { additionalDepartmentIds: { $size: 0 } }] },
      { department: new RegExp(`^${escaped}$`, "i") },
    ],
  }).select("firstName lastName email");
  for (const e of nameMatched) addEmployee(recipients, e);

  return [...recipients].map(([email, name]) => ({ email, name }));
}

// ── Email send (Brevo) — same guarded pattern as every other Brevo sender in
// this backend: silently skipped, never failed, when ENABLE_EMAILS isn't
// "true" or no API key is configured. ────────────────────────────────────────
const BREVO_URL = "https://api.brevo.com/v3/smtp/email";
const FROM_EMAIL = process.env.CUSTOMER_SENDER_EMAIL || "noreply@grav.in";
const FROM_NAME = "GRAV Manufacturing Suite";
// Same env + fallback services/accountantApprovalNotifications.service.js
// already uses for CMS deep links — exported so callers can build a CTA URL
// into whichever page the event concerns.
const APP_URL = (process.env.FRONTEND_URL || "https://cms.grav.in").replace(/\/+$/, "");

// ── Detail rows + product photo — every event below fills these in so the
// email actually says WHICH customer/enquiry and WHICH product this is
// about, not just "something happened" (20 Aug 2026, explicit request:
// "describe properly about which customer request it is, and also about
// which specific product, photo, details and all"). ─────────────────────────
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}
function _row(label, value) {
  if (value == null || value === "") return "";
  return `<tr><td style="padding:4px 16px 4px 0;color:#64748b;font-weight:600;white-space:nowrap;vertical-align:top">${escapeHtml(label)}</td><td style="color:#0f172a">${escapeHtml(value)}</td></tr>`;
}
function _table(rows) {
  const filled = rows.filter(Boolean);
  if (!filled.length) return "";
  return `<table cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-size:13.5px;margin:14px 0;width:100%">${filled.join("")}</table>`;
}

/**
 * A directly renderable thumbnail URL for a stored reference/sample image —
 * the SAME two shapes the frontend's lib/driveImage.js resolves (Drive
 * `{fileId}` via lh3, or Cloudinary `{publicId}`/a res.cloudinary.com `url`),
 * reimplemented here because this is the backend and that module isn't
 * reachable from it (no shared package between the two repos — see the repo
 * root CLAUDE.md). Kept deliberately tiny: just enough to put a photo in an
 * email, not a general image pipeline.
 */
function imageUrlFor(img, width = 320) {
  if (!img) return null;
  const url = img.url || "";
  if (img.publicId || (url.includes("res.cloudinary.com") && url.includes("/upload/"))) {
    return url.includes("/upload/")
      ? url.replace("/upload/", `/upload/c_fill,w_${width},h_${width},q_auto/`)
      : url;
  }
  if (img.fileId) return `https://lh3.googleusercontent.com/d/${img.fileId}=w${width}`;
  return url || null;
}

function wrapEmail({ heading, bodyHtml, details, imageUrl, ctaLabel, ctaUrl }) {
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a">
  <div style="background:#0f172a;padding:16px 24px"><span style="color:#fff;font-size:16px;font-weight:700">GRAV &middot; Manufacturing Suite</span></div>
  <div style="padding:24px">
    <h2 style="font-size:16px;margin:0 0 14px">${heading}</h2>
    ${imageUrl ? `<img src="${imageUrl}" alt="" style="display:block;max-width:220px;border-radius:8px;margin:0 0 14px;border:1px solid #e2e8f0" />` : ""}
    ${bodyHtml || ""}
    ${_table(details || [])}
    ${ctaUrl ? `<p style="margin-top:20px"><a href="${ctaUrl}" style="display:inline-block;background:#0f172a;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600">${ctaLabel || "Open"}</a></p>` : ""}
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
    <p style="font-size:12px;color:#888">Automated notification from GRAV Manufacturing Suite. Turn these off from Sales &rarr; Settings &rarr; Department Notifications.</p>
  </div>
</div>`;
}

async function sendCmsEmail({ to, subject, html, text }) {
  if (process.env.ENABLE_EMAILS !== "true") {
    console.warn(`[departmentNotify] SKIPPED "${subject}" — ENABLE_EMAILS is not "true"`);
    return;
  }
  const key = process.env.BREVO_API_KEY;
  if (!key) {
    console.warn("[departmentNotify] BREVO_API_KEY not set");
    return;
  }
  try {
    await axios.post(
      BREVO_URL,
      {
        sender: { name: FROM_NAME, email: FROM_EMAIL },
        to: Array.isArray(to) ? to : [to],
        subject,
        htmlContent: html,
        textContent: text,
        headers: { "X-Mailer": "Grav-CMS-DeptNotify" },
      },
      { headers: { "api-key": key, "Content-Type": "application/json", Accept: "application/json" }, timeout: 10000 },
    );
  } catch (err) {
    console.error(`[departmentNotify] Brevo failed "${subject}":`, err.response?.data?.message || err.message);
  }
}

/**
 * Notify every department a registered event concerns. A no-op if Sales has
 * turned the event off, if the event key is unknown, or if nobody currently
 * has access to any of its departments. NEVER THROWS.
 *
 * @param {string} eventKey  one of EVENT_REGISTRY's keys
 * @param {object} [ctx]
 * @param {string} [ctx.heading]   defaults to the event's own label
 * @param {string} [ctx.bodyHtml]  freeform intro sentence(s), already HTML-escaped by the caller
 * @param {Array<[string,string]>} [ctx.details]  [label, value] rows — customer, enquiry ref,
 *   product, quantity, requested by, etc. Rendered as a table; escaped here, callers pass plain text.
 * @param {object} [ctx.image]     a stored image record ({fileId}/{publicId,url}/{url}) — resolved
 *   to a thumbnail via imageUrlFor. Prefer this over ctx.imageUrl so escaping/resolution stays here.
 * @param {string} [ctx.imageUrl]  an already-resolved image URL, when the caller has one directly.
 * @param {string} [ctx.subject]
 * @param {string} [ctx.bodyText]  plain-text fallback (details are NOT auto-appended to this)
 * @param {string} [ctx.ctaLabel]
 * @param {string} [ctx.ctaUrl]
 * @returns {Promise<{sent:number, skipped?:string}>}
 */
async function notifyEvent(eventKey, ctx = {}) {
  try {
    const event = EVENT_BY_KEY.get(eventKey);
    if (!event) {
      console.warn(`[departmentNotify] Unknown event "${eventKey}"`);
      return { sent: 0, skipped: "unknown-event" };
    }
    if (!(await isEventEnabled(eventKey))) {
      // Not an error — Sales turned this one off deliberately (Sales Settings
      // → Department Notifications). Logged anyway, at the same visibility as
      // the other skip reasons below, so "why didn't this email go out" is
      // answerable from the server logs alone rather than by re-reading code.
      console.log(`[departmentNotify] "${eventKey}" skipped — disabled in Sales Settings.`);
      return { sent: 0, skipped: "disabled" };
    }

    const lists = await Promise.all(event.departments.map(resolveDepartmentRecipients));
    const recipients = new Map();
    for (const list of lists) for (const r of list) recipients.set(r.email, r.name);
    if (!recipients.size) {
      // The single most likely cause of "the email never arrived": nobody
      // currently holds any of this event's departments in Access Control.
      console.warn(
        `[departmentNotify] "${eventKey}" skipped — no one has access to ` +
        `[${event.departments.join(", ")}] yet. Grant it from Access Control.`,
      );
      return { sent: 0, skipped: "no-recipients" };
    }

    const heading = ctx.heading || event.label;
    const imageUrl = ctx.imageUrl || imageUrlFor(ctx.image);
    const details = (ctx.details || []).map(([label, value]) => _row(label, value));
    const html = wrapEmail({ heading, bodyHtml: ctx.bodyHtml, details, imageUrl, ctaLabel: ctx.ctaLabel, ctaUrl: ctx.ctaUrl });
    const subject = ctx.subject || event.label;
    const textDetails = (ctx.details || []).filter(([, v]) => v).map(([l, v]) => `${l}: ${v}`).join("\n");
    const text = `${heading}\n\n${ctx.bodyText || ""}${textDetails ? `\n\n${textDetails}` : ""}`;

    await Promise.all(
      [...recipients].map(([email, name]) => sendCmsEmail({ to: [{ email, name }], subject, html, text })),
    );
    console.log(`[departmentNotify] "${eventKey}" sent to ${recipients.size} recipient(s): ${[...recipients.keys()].join(", ")}`);
    return { sent: recipients.size };
  } catch (err) {
    console.error(`[departmentNotify] "${eventKey}" failed:`, err.message);
    return { sent: 0, skipped: "error" };
  }
}

module.exports = { EVENT_REGISTRY, APP_URL, listEvents, isEventEnabled, resolveDepartmentRecipients, notifyEvent, imageUrlFor };
