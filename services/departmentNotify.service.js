// services/departmentNotify.service.js
//
// Cross-department "something happened, you should know" EMAIL notifications —
// distinct from the two email senders already in this backend:
//   - utils/salesEmailService.js         → customer-facing (quotations, welcome…)
//   - services/emailNotifications.service.js → CoWork's own app, CoWork's own audience
// This one notifies STAFF on another department's CMS dashboard (Merchandiser,
// Project Manager, R&D, …) when a Sales-side event concerns them.
//
// WHO GETS NOTIFIED is decided by Access Control — AccessDepartment/DeptUser
// plus Employee.accessDepartmentId, i.e. the department STAR-MARKED as that
// person's primary. Secondary grants (additionalDepartmentIds) can open the
// dashboard but are NOT emailed (28 Aug 2026 — see resolveDepartmentRecipients
// below for why). There is deliberately no separate "recipients" list to
// maintain: make that department someone's primary and they start receiving
// its event emails; move them and they stop.
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
const { SAMPLING_TEMPLATE_DEFAULTS } = require("../models/CMS_Models/Sales/SalesSettings");

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
  // ── The three Style & Sample hand-offs (28 Aug 2026) ──────────────────────
  // Unlike every other event here, these three carry a template Sales can
  // REWRITE from Sales Settings → Sampling Messages (see `templateKey`, and
  // SalesSettings.samplingTemplates). The wording is customer- and
  // supplier-facing in tone — a formal request another department acts on —
  // so a fixed system sentence was the wrong shape for it.
  {
    key: "sample_sent_to_merchandiser",
    label: "Style sent to Merchandising (BOM request)",
    description: "Merchandising is notified when Sales routes a style to them to fill the BOM / raw materials.",
    departments: ["merchandiser"],
    templateKey: "merchandiser",
  },
  {
    key: "sample_bom_approval_requested",
    label: "BOM approval requested from the Project Manager",
    description: "The Project Manager is asked to approve or reject the BOM for a style, straight from the email.",
    // NOT production-supervisor (28 Aug 2026 correction, explicit: "am
    // talking about this /project-manager/dashboard department ok. not the
    // production supervisor"). See services/ensureAccessDepartments.js's
    // `project_manager` entry — slug "project-manager", dashboardPath
    // /project-manager/dashboard.
    departments: ["project-manager"],
    templateKey: "bomApproval",
  },
  // Split approve/reject into two keys — same reasoning as
  // stock_item_created_merchandiser/production below: each needs its own
  // wording (an approval reads as a green light, a rejection has to carry the
  // Project Manager's reason), and BOTH now reach Merchandising as well as
  // Sales (28 Aug 2026, explicit request: "when the project manager approve/
  // reject the BOM approval request, make sure to also notify to the
  // merchantiser... that mail also need to send to the sales person also").
  // Merchandising is the one who actually built the BOM being judged; Sales
  // is who asked for the judgement — both need to know the outcome, and
  // notifyEvent sends one ctx to every department an event lists, so one
  // event covers both audiences with one shared message.
  {
    key: "sample_bom_approved",
    label: "BOM approved — notify Merchandiser & Sales",
    description: "Merchandising and Sales are notified when the Project Manager approves a style's BOM.",
    departments: ["merchandiser", "sales"],
    templateKey: "bomApproved",
  },
  {
    key: "sample_bom_rejected",
    label: "BOM rejected — notify Merchandiser & Sales",
    description: "Merchandising and Sales are notified when the Project Manager rejects a style's BOM, with their reason.",
    departments: ["merchandiser", "sales"],
    templateKey: "bomRejected",
  },
  {
    key: "sample_sent_to_rnd",
    label: "Sample sent to R&D",
    description: "R&D is notified when Sales routes a style to them for tech-pack / development.",
    departments: ["research-development"],
    templateKey: "rnd",
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
    // 31 Aug 2026, explicit request: "in the product manager side basically it
    // is needed to notify about the order ok, means when when the
    // manufacturing order goona create (means the customer request sent to
    // production)".
    //
    // Fired from services/manufacturingOrderNotify.service.js, which is called
    // from inside `createWorkOrdersAndProgress` — the one factory every route
    // that raises an MO goes through, so no entry point can quietly skip it.
    // Carries a full order summary in the body AND the same thing as a PDF
    // attachment.
    key: "manufacturing_order_created",
    label: "Manufacturing Order created",
    description:
      "The Project Manager is notified whenever an order reaches production — with the order type " +
      "(customer / sampling / internal / testing), its quantities, its work orders, and a PDF summary attached.",
    departments: ["project-manager"],
    templateKey: "manufacturingOrder",
    // This event's copy belongs to the PROJECT MANAGER, not Sales — it is
    // their own inbound notification, edited on their own settings page. See
    // ProductionSettings' header for why that is a separate collection.
    templateStore: "production",
  },
  // ── The same moment, told to three more audiences ──────────────────────
  //
  // 31 Aug 2026, explicit request: "whatever actions are goona happened upon
  // considering an order, so make sure to notify to the sales team,
  // merchantiser, project manager, r&d and all... and the format should be
  // different ok as per there department wise responsibility".
  //
  // Four separate EVENTS rather than one event with four recipient lists,
  // because each has its own wording, its own attached PDF, and its own
  // on/off switch — a merchandiser silencing the material notice must not
  // silence the project manager's schedule.
  {
    key: "mo_rnd_notice",
    label: "Order in production — R&D notice",
    description:
      "R&D is told when a style they developed enters production. Most useful on a sampling order, where R&D " +
      "asked for the run and otherwise never hears that it started.",
    departments: ["research-development"],
    templateKey: "researchDevelopment",
    templateStore: "production",
  },
  {
    key: "mo_merchandiser_notice",
    label: "Order in production — Merchandising notice",
    description: "Merchandising is told what a released order will consume, so procurement can cover any shortfall.",
    departments: ["merchandiser"],
    templateKey: "merchandiser",
    templateStore: "production",
  },
  {
    key: "mo_sales_notice",
    label: "Order in production — Sales notice",
    description: "Sales is told their customer's order has entered production, and what may be confirmed to the customer.",
    departments: ["sales"],
    templateKey: "sales",
    templateStore: "production",
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

function listEventsWithTemplates() {
  return EVENT_REGISTRY.filter((e) => e.templateKey).map((e) => ({ key: e.key, templateKey: e.templateKey, label: e.label, description: e.description }));
}

async function isEventEnabled(eventKey) {
  // An event whose copy belongs to another department is switched off from
  // THAT department's settings — asking Sales whether the Project Manager
  // wants their own notification would be the wrong question, and would let
  // Sales silently mute somebody else's inbox.
  const event = EVENT_BY_KEY.get(eventKey);
  if (event?.templateStore === "production") {
    const ProductionSettings = require("../models/CMS_Models/Manufacturing/ProductionSettings");
    const settings = await ProductionSettings.findOne({ key: "production" }).select("disabledEvents").lean();
    return !(settings?.disabledEvents || []).includes(eventKey);
  }
  const settings = await SalesSettings.findOne().select("departmentNotifications").lean();
  const disabled = settings?.departmentNotifications?.disabledEvents || [];
  return !disabled.includes(eventKey);
}

/**
 * `{placeholder}` substitution for the Sales-authored sampling templates.
 *
 * Deliberately the SAME shape utils/salesEmailService.js already uses for the
 * customer-facing templates (`{name}`, `{portalUrl}`, …) so a salesperson who
 * has edited one kind of template already knows how these work. An unknown
 * placeholder is left standing rather than blanked: seeing `{prodcut}` in a
 * test send is how you find the typo — silently emptying it is how you ship it.
 */
function interpolate(text, vars) {
  return String(text == null ? "" : text).replace(/\{(\w+)\}/g, (whole, key) =>
    (vars[key] === undefined || vars[key] === null || vars[key] === "" ? whole : String(vars[key])),
  );
}

/**
 * The Sales-authored template for an event, or null when the event has none
 * (every event without a `templateKey`) / Sales hasn't overridden the default.
 *
 * Returns the RAW stored strings — interpolation happens in notifyEvent, where
 * the caller's own variables are known. `enabled: false` on a template is a
 * second, per-template off switch alongside the `disabledEvents` opt-out, and
 * is reported back so notifyEvent can skip with an accurate reason.
 */
async function resolveTemplate(eventKey) {
  const event = EVENT_BY_KEY.get(eventKey);
  if (!event?.templateKey) return null;

  // Two stores, one seam. Which department OWNS an event's wording is declared
  // on the registry entry (`templateStore`), so the merge logic below — which
  // is the part that actually matters — stays single.
  let saved;
  let fallback;
  if (event.templateStore === "production") {
    const ProductionSettings = require("../models/CMS_Models/Manufacturing/ProductionSettings");
    const settings = await ProductionSettings.findOne({ key: "production" }).select("templates").lean();
    saved = settings?.templates?.[event.templateKey];
    fallback = ProductionSettings.PRODUCTION_TEMPLATE_DEFAULTS[event.templateKey];
  } else {
    const settings = await SalesSettings.findOne().select("samplingTemplates").lean();
    saved = settings?.samplingTemplates?.[event.templateKey];
    fallback = SAMPLING_TEMPLATE_DEFAULTS[event.templateKey];
  }
  // Field-by-field over the defaults, not `saved || fallback`. Mongoose
  // defaults only materialise when a document is CREATED, so every settings
  // singleton that already existed before 28 Aug 2026 has no samplingTemplates
  // at all — without this fallback those environments would send an email with
  // no body. Merging per field also means a template saved before a new field
  // was added still picks the new one up.
  if (!fallback) return saved || null;
  return {
    enabled:  saved?.enabled  ?? fallback.enabled,
    subject:  saved?.subject  || fallback.subject,
    heading:  saved?.heading  || fallback.heading,
    bodyText: saved?.bodyText || fallback.bodyText,
    ctaLabel: saved?.ctaLabel || fallback.ctaLabel,
  };
}

/** Small helper: add an employee to the recipient map, keyed by lowercase email. */
function addEmployee(map, e) {
  if (!e.email) return;
  map.set(e.email.toLowerCase(), `${e.firstName || ""} ${e.lastName || ""}`.trim() || e.email);
}

/**
 * Every unique, emailable person whose PRIMARY department this is — dept_users
 * rows in it, plus employees whose `accessDepartmentId` is it, plus — when an
 * employee has NO explicit grant at all — the same department-NAME fallback
 * routes/auth/deptAuth.js's own login (resolveEmployeeDepartments) uses.
 *
 * PRIMARY ONLY, NOT EVERY DEPARTMENT SOMEONE CAN OPEN (28 Aug 2026, explicit
 * request: "as u currently fetch the email id of the person upon considering
 * from the access control, so make sure to track only the primary department
 * access ok not the other department access — the department which is star
 * marked for that employee").
 *
 * `Employee.accessDepartmentId` IS that star: Access Control → People shows a
 * filled star on an employee's primary department and a hollow one on every
 * extra grant, and the star button writes exactly this field (see
 * components/access/PeoplePanel.js's promoteToPrimary, and the
 * `primary department set to …` change-log entry in routes/Admin/accessAdmin
 * .js). `additionalDepartmentIds` — the hollow-star extras — used to be
 * unioned in here, which meant somebody granted Merchandising as a SECOND
 * department received every merchandising email as if it were their job.
 *
 * This deliberately makes "who can OPEN this dashboard" wider than "who gets
 * EMAILED about it". That gap is the point: access is about permission, a
 * notification is about whose work it is.
 */
async function resolveDepartmentRecipients(slug) {
  const dept = await AccessDepartment.findOne({ slug, isActive: true });
  if (!dept) return [];
  const recipients = new Map();

  const deptUsers = await DeptUser.find({ departmentId: dept._id, isActive: true }).select("name email");
  for (const u of deptUsers) if (u.email) recipients.set(u.email.toLowerCase(), u.name || u.email);

  const activeCond = { $or: [{ status: "active" }, { isActive: true }] };

  const granted = await Employee.find({
    $and: [activeCond, { accessDepartmentId: dept._id }],
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

/**
 * `extraHtml` renders BELOW the details table and ABOVE the CTA — for content
 * that is neither prose nor a fact row. Today that is the BOM-approval email's
 * Approve/Reject pair (sampleStyles.js) and its gallery of product photos: a
 * decision the reader makes in their inbox, which the single `ctaUrl` button
 * cannot express.
 */
function wrapEmail({ heading, bodyHtml, details, imageUrl, ctaLabel, ctaUrl, extraHtml }) {
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a">
  <div style="background:#0f172a;padding:16px 24px"><span style="color:#fff;font-size:16px;font-weight:700">GRAV &middot; Manufacturing Suite</span></div>
  <div style="padding:24px">
    <h2 style="font-size:16px;margin:0 0 14px">${heading}</h2>
    ${imageUrl ? `<img src="${imageUrl}" alt="" style="display:block;max-width:220px;border-radius:8px;margin:0 0 14px;border:1px solid #e2e8f0" />` : ""}
    ${bodyHtml || ""}
    ${_table(details || [])}
    ${extraHtml || ""}
    ${ctaUrl ? `<p style="margin-top:20px"><a href="${ctaUrl}" style="display:inline-block;background:#0f172a;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600">${ctaLabel || "Open"}</a></p>` : ""}
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
    <p style="font-size:12px;color:#888">Automated notification from GRAV Manufacturing Suite. Turn these off from Sales &rarr; Settings &rarr; Department Notifications.</p>
  </div>
</div>`;
}

/**
 * @param {object}   opts
 * @param {Array=}   opts.attachments  `[{ name, content }]` where `content` is
 *   a Buffer or an already-base64 string. Brevo's /v3/smtp/email takes these
 *   as `attachment: [{ name, content: <base64> }]` (30 Aug 2026 — added for
 *   the Project Manager's Manufacturing Order PDF; nothing sent attachments
 *   before this). Omitted entirely when empty, so every existing caller
 *   produces a byte-identical request to what it did before.
 */
async function sendCmsEmail({ to, subject, html, text, attachments }) {
  if (process.env.ENABLE_EMAILS !== "true") {
    console.warn(`[departmentNotify] SKIPPED "${subject}" — ENABLE_EMAILS is not "true"`);
    return;
  }
  const key = process.env.BREVO_API_KEY;
  if (!key) {
    console.warn("[departmentNotify] BREVO_API_KEY not set");
    return;
  }
  const attachment = (Array.isArray(attachments) ? attachments : [])
    .filter((a) => a && a.name && a.content)
    .map((a) => ({
      name: a.name,
      content: Buffer.isBuffer(a.content) ? a.content.toString("base64") : String(a.content),
    }));
  try {
    await axios.post(
      BREVO_URL,
      {
        sender: { name: FROM_NAME, email: FROM_EMAIL },
        to: Array.isArray(to) ? to : [to],
        subject,
        htmlContent: html,
        textContent: text,
        ...(attachment.length ? { attachment } : {}),
        headers: { "X-Mailer": "Grav-CMS-DeptNotify" },
      },
      // Attachments make the body much larger than a plain notification, so the
      // 10s that suffices for text is not enough once a PDF rides along.
      { headers: { "api-key": key, "Content-Type": "application/json", Accept: "application/json" }, timeout: attachment.length ? 30000 : 10000 },
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
 * @param {string} [ctx.extraHtml]  raw HTML below the details table — see wrapEmail.
 * @param {object} [ctx.vars]  `{placeholder}` values for a Sales-authored template
 *   (events with a `templateKey`). Ignored by every other event.
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

    // ── Sales-authored template, when this event has one ────────────────────
    // The stored subject/heading/body/CTA REPLACE what the call site passed,
    // once interpolated against ctx.vars. The call site's own values stay as
    // the fallback for a template that was never saved, and for every event
    // without a templateKey — so nothing that worked before this existed
    // changes shape.
    //
    // Only the prose is Sales'. The details table, the photo, and the CTA URL
    // stay with the call site: those are facts about the record, not copy, and
    // a mistyped URL in a template is a dead link in somebody's inbox.
    const tpl = await resolveTemplate(eventKey);
    if (tpl && tpl.enabled === false) {
      console.log(`[departmentNotify] "${eventKey}" skipped — its template is switched off in Sales Settings.`);
      return { sent: 0, skipped: "template-disabled" };
    }
    const vars = ctx.vars || {};
    const tplBody = tpl?.bodyText ? interpolate(tpl.bodyText, vars) : null;

    const heading = (tpl?.heading && interpolate(tpl.heading, vars)) || ctx.heading || event.label;
    const imageUrl = ctx.imageUrl || imageUrlFor(ctx.image);
    const details = (ctx.details || []).map(([label, value]) => _row(label, value));
    // A Sales-authored body is PLAIN TEXT, so it is escaped and its blank
    // lines become paragraphs. ctx.bodyHtml, by contrast, is pre-escaped HTML
    // the call site built (see this function's own @param note) — escaping
    // that again would print the tags.
    const bodyHtml = tplBody
      ? tplBody.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`).join("")
      : ctx.bodyHtml;
    const ctaLabel = (tpl?.ctaLabel && interpolate(tpl.ctaLabel, vars)) || ctx.ctaLabel;
    const html = wrapEmail({ heading, bodyHtml, details, imageUrl, ctaLabel, ctaUrl: ctx.ctaUrl, extraHtml: ctx.extraHtml });
    const subject = (tpl?.subject && interpolate(tpl.subject, vars)) || ctx.subject || event.label;
    const textDetails = (ctx.details || []).filter(([, v]) => v).map(([l, v]) => `${l}: ${v}`).join("\n");
    const text = `${heading}\n\n${tplBody || ctx.bodyText || ""}${textDetails ? `\n\n${textDetails}` : ""}`;

    await Promise.all(
      [...recipients].map(([email, name]) =>
        // `ctx.attachments` — `[{ name, content }]`, content a Buffer. Built by
        // the call site (the Manufacturing Order PDF is the first user), never
        // by a template: an attachment is a fact about the record, the same
        // reasoning that keeps the details table and the CTA URL out of Sales'
        // editable copy.
        sendCmsEmail({ to: [{ email, name }], subject, html, text, attachments: ctx.attachments })),
    );
    console.log(`[departmentNotify] "${eventKey}" sent to ${recipients.size} recipient(s): ${[...recipients.keys()].join(", ")}`);
    return { sent: recipients.size };
  } catch (err) {
    console.error(`[departmentNotify] "${eventKey}" failed:`, err.message);
    return { sent: 0, skipped: "error" };
  }
}

/**
 * Render an event exactly as `notifyEvent` would, and return it instead of
 * sending it.
 *
 * Added 31 Aug 2026 for the Project Manager's template editor. Deliberately
 * shares the resolve/interpolate/wrap path above rather than reimplementing it
 * — a preview that renders through different code is a preview that can be
 * wrong in exactly the way you were trying to check for.
 *
 * Also reports WHO would receive it and whether anything would stop the send,
 * because "why did nobody get this" is usually a recipients or a switch
 * problem, not a wording one.
 */
async function renderEventPreview(eventKey, ctx = {}) {
  const event = EVENT_BY_KEY.get(eventKey);
  if (!event) return { error: `Unknown event "${eventKey}"` };

  const tpl = await resolveTemplate(eventKey);
  const vars = ctx.vars || {};
  const tplBody = tpl?.bodyText ? interpolate(tpl.bodyText, vars) : null;
  const heading = (tpl?.heading && interpolate(tpl.heading, vars)) || ctx.heading || event.label;
  const subject = (tpl?.subject && interpolate(tpl.subject, vars)) || ctx.subject || event.label;
  const bodyHtml = tplBody
    ? tplBody.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`).join("")
    : ctx.bodyHtml;
  const details = (ctx.details || []).map(([label, value]) => _row(label, value));
  const html = wrapEmail({
    heading, bodyHtml, details,
    imageUrl: ctx.imageUrl || imageUrlFor(ctx.image),
    ctaLabel: (tpl?.ctaLabel && interpolate(tpl.ctaLabel, vars)) || ctx.ctaLabel,
    ctaUrl: ctx.ctaUrl,
    extraHtml: ctx.extraHtml,
  });

  const lists = await Promise.all(event.departments.map(resolveDepartmentRecipients));
  const recipients = new Map();
  for (const list of lists) for (const r of list) recipients.set(r.email, r.name);

  const enabled = await isEventEnabled(eventKey);
  const blocked = !enabled ? "This notification is switched off in settings."
    : tpl && tpl.enabled === false ? "This template is switched off in settings."
    : !recipients.size ? `Nobody currently holds the ${event.departments.join(" / ")} department in Access Control, so this would reach no one.`
    : null;

  return {
    subject,
    html,
    heading,
    recipients: [...recipients].map(([email, name]) => ({ email, name })),
    departments: event.departments,
    wouldSend: !blocked,
    blocked,
  };
}

module.exports = {
  EVENT_REGISTRY, APP_URL, listEvents, listEventsWithTemplates, isEventEnabled, renderEventPreview,
  resolveDepartmentRecipients, notifyEvent, imageUrlFor, escapeHtml, interpolate,
};
