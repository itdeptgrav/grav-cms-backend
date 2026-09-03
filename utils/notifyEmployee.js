// utils/notifyEmployee.js
//
// THE single notification entry point for HR-domain events (leave,
// regularization, overtime, payroll).
//
// Everything funnels through `sendExpoPush` (utils/sendExpoPush.js), which
// already fans out to BOTH the Expo native token (mobile app) and the FCM web
// token (CMS) in one call. Callers must therefore NEVER also call
// sendWebPush/sendWebPushToMany — that double-notifies web users.
//
// Two guarantees this module exists to enforce:
//
//   1. A push failure can never fail the request it accompanies.
//      Everything is wrapped; nothing here rejects, ever.
//   2. A push never blocks the response.
//      `notifyEmployee()` is SYNCHRONOUS — it schedules the send on the next
//      tick and returns immediately. Do not await it.
//
//      If you genuinely need the send result (the overtime cron does, to
//      count how many reminders actually went out), use `notifyEmployeeNow()`,
//      which returns a promise that always resolves — never rejects.
//
// Usage:
//   const { notifyLeaveApproved } = require("../../utils/notifyEmployee");
//   notifyLeaveApproved(application);          // fire-and-forget, no await
//
// Every payload carries `{ kind, screen, id }` so the app can deep-link from
// the notification tap handler (APP/src/utils/notifications.js). `screen` must
// be a real route name in APP/src/navigation/AppNavigator.js.

"use strict";

const { sendExpoPush } = require("./sendExpoPush");

// ── Hard constraints from the app side ────────────────────────────────────────
// Only these Android channels are registered (APP/src/utils/notifications.js).
// Anything else silently falls back to Expo's default channel and loses its
// configured importance on Android 8+.
const CHANNELS = new Set(["general", "payroll"]);
// Only these notification categories are registered. An unregistered category
// renders with no action buttons on both platforms.
const CATEGORIES = new Set(["general", "payroll", "leave_action"]);
// Only these navigator route names exist. A bad one deep-links nowhere.
const SCREENS = new Set([
  "Leave",
  "Regularize",
  "Overtime",
  "Attendance",
  "Performance",
  // HR-issued letters. Byte-matches the WorkStack route name in
  // App/src/navigation/AppNavigator.js — an unlisted screen is dropped with a
  // warn and the web `url` falls back to "/".
  "Documents",
]);

// Web (CMS) click destination per screen — used only by the FCM half of the fan-out.
const SCREEN_URLS = {
  Leave: "/hr/dashboard/leaves",
  Regularize: "/hr/dashboard/attendance/regularizations",
  Overtime: "/hr/dashboard/attendance",
  Attendance: "/hr/dashboard/attendance",
  Performance: "/hr/dashboard/payroll",
  Documents: "/hr/dashboard/documents/requests",
};

const MONTH_NAMES = [
  "",
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// ── Small formatting helpers ──────────────────────────────────────────────────

/** First name only — bodies read better as "Rakesh approved…" than full names. */
function firstName(nameOrEmployee) {
  if (!nameOrEmployee) return "Someone";
  if (typeof nameOrEmployee === "object") {
    const n =
      nameOrEmployee.firstName ||
      nameOrEmployee.managerName ||
      nameOrEmployee.employeeName ||
      nameOrEmployee.name ||
      "";
    return firstName(String(n));
  }
  const t = String(nameOrEmployee).trim().split(/\s+/)[0];
  return t || "Someone";
}

/** "2026-08-03" → "03 Aug". Anything unparseable falls through unchanged. */
function shortDate(dateStr) {
  if (!dateStr) return "—";
  const s = String(dateStr);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  return `${m[3]} ${MONTH_NAMES[Number(m[2])]?.slice(0, 3) || m[2]}`;
}

/** Appends "Reason: x" style tails without leaving a dangling space. */
function withReason(body, reason) {
  const r = String(reason || "").trim();
  return r ? `${body} ${r}` : body;
}

function idsFrom(input) {
  const arr = Array.isArray(input) ? input : [input];
  return arr
    .map((x) => {
      if (!x) return null;
      if (typeof x === "object") return x.managerId || x._id || x.id || null;
      return x;
    })
    .filter(Boolean)
    .map(String);
}

// ── The core ──────────────────────────────────────────────────────────────────

/**
 * Build the sendExpoPush options object, normalising/validating everything the
 * app cares about. Returns null when the payload is unusable.
 */
/* The registry type (services/notificationTypes) each domain tag means when
   the sender does not say. A kind's default is its OUTCOME ("your leave was
   decided"); the senders that announce something still PENDING name
   `type` explicitly, because a pending thing may be repeated hourly and a
   decided one never is. */
const DEFAULT_TYPE_FOR_KIND = {
  leave: "request_decided",
  regularization: "request_decided",
  overtime: "request_decided",
  payroll: "payroll",
  document: "document",
};

function buildOptions(opts) {
  const { title, body, kind, screen, id, badge } = opts || {};
  const notificationType =
    opts?.type || DEFAULT_TYPE_FOR_KIND[kind] || "general";
  if (!title || !body) {
    console.warn("[NOTIFY] dropped — missing title or body", { kind, screen });
    return null;
  }

  const scr = SCREENS.has(screen) ? screen : null;
  if (screen && !scr) {
    console.warn(
      `[NOTIFY] unknown screen "${screen}" — deep link dropped (${kind})`,
    );
  }

  const channelId = CHANNELS.has(opts.channelId) ? opts.channelId : "general";
  const categoryId = CATEGORIES.has(opts.categoryId)
    ? opts.categoryId
    : "general";

  return {
    title: String(title),
    body: String(body),
    data: {
      kind: kind || "general",
      // `type` is kept as an alias of `kind` for older app builds that read it.
      type: kind || "general",
      // What the device registry filters on — services/notificationTypes.
      notificationType,
      ...(scr ? { screen: scr } : {}),
      ...(id != null ? { id: String(id) } : {}),
    },
    channelId,
    categoryId,
    url: opts.url || (scr && SCREEN_URLS[scr]) || "/",
    ...(badge !== undefined ? { badge } : {}),
  };
}

/**
 * Fire-and-forget push. SYNCHRONOUS — returns undefined immediately.
 * Never throws, never rejects, never delays the response.
 *
 * @param {string|string[]|ObjectId|ObjectId[]|Object|Object[]} recipients
 *        Employee _id(s). Objects are accepted and unwrapped via
 *        `.managerId` / `._id` / `.id`, so `managersNotified` entries work
 *        directly.
 * @param {Object} opts
 * @param {string} opts.title
 * @param {string} opts.body
 * @param {string} opts.kind      domain tag: "leave" | "regularization" | "overtime" | "payroll"
 * @param {string} opts.screen    app route name for the deep link
 * @param {string} [opts.id]      document id the screen should open
 * @param {string} [opts.channelId="general"]
 * @param {string} [opts.categoryId="general"]
 * @param {string} [opts.url]     web click destination (defaults per screen)
 * @param {number} [opts.badge]
 * @returns {void}
 */
function notifyEmployee(recipients, opts) {
  let ids;
  let payload;
  try {
    ids = idsFrom(recipients);
    if (ids.length === 0) return;
    payload = buildOptions(opts);
    if (!payload) return;
  } catch (e) {
    console.warn("[NOTIFY] payload build failed:", e.message);
    return;
  }

  // Detach from the request lifecycle. Nothing downstream can delay or fail
  // the response that triggered this.
  setImmediate(() => {
    sendExpoPush(ids, payload)
      .then((r) => {
        if (r && (r.mobile?.failed || r.web?.failed)) {
          console.warn(
            `[NOTIFY] ${payload.data.kind}: ${r.mobile?.queued || 0} mobile / ${r.web?.sent || 0} web sent, ` +
              `${(r.mobile?.failed || 0) + (r.web?.failed || 0)} failed`,
          );
        }
      })
      .catch((e) =>
        console.warn(`[NOTIFY] ${payload.data.kind} send failed:`, e.message),
      );
  });
}

/**
 * Awaitable variant, for the few callers that need the send result (the
 * overtime reminder cron counts successful queues). Always resolves — a
 * failure resolves to the zeroed result shape rather than rejecting.
 *
 * @returns {Promise<{mobile:{queued:number,failed:number}, web:{sent:number,failed:number}}>}
 */
async function notifyEmployeeNow(recipients, opts) {
  const empty = { mobile: { queued: 0, failed: 0 }, web: { sent: 0, failed: 0 } };
  try {
    const ids = idsFrom(recipients);
    if (ids.length === 0) return empty;
    const payload = buildOptions(opts);
    if (!payload) return empty;
    return (await sendExpoPush(ids, payload)) || empty;
  } catch (e) {
    console.warn("[NOTIFY] send failed:", e.message);
    return empty;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  LEAVE  (contract §D.4, rows L1–L9)
//  All copy lives here so the app and the CMS never disagree on wording.
// ═══════════════════════════════════════════════════════════════════════════════

const leaveOf = (a) => a?.leaveType || "leave";

/** L1 — employee applied. Goes to the PRIMARY manager only. */
function notifyLeaveApplied(application, employee) {
  const a = application || {};
  const primary = (a.managersNotified || []).find((m) => m.type === "primary");
  const to = primary?.managerId || (a.managersNotified || [])[0]?.managerId;
  if (!to) return;
  const name = firstName(employee || a.employeeName);
  const n = a.totalDays != null ? a.totalDays : 1;
  notifyEmployee(to, {
    title: "New leave request",
    body: `${name} applied for ${n} day(s) ${leaveOf(a)}, ${shortDate(a.fromDate)} to ${shortDate(a.toDate)}.`,
    kind: "leave",
    type: "leave_pending",
    screen: "Leave",
    id: a._id,
  });
}

/** L2 — primary approved and a secondary exists. Goes to the SECONDARY. */
function notifyLeaveSecondaryPending(application, primaryManagerName) {
  const a = application || {};
  const secondary = (a.managersNotified || []).find(
    (m) => m.type === "secondary",
  );
  if (!secondary?.managerId) return;
  const mgr = firstName(primaryManagerName || "Your manager");
  const name = firstName(a.employeeName);
  notifyEmployee(secondary.managerId, {
    title: "Leave needs your approval",
    body: `${mgr} approved ${name}'s ${leaveOf(a)}. It's waiting on you.`,
    kind: "leave",
    type: "leave_pending",
    screen: "Leave",
    id: a._id,
  });
}

/** L3 / L5 / L7 — final approval (manager chain, HR, or HR bulk). To the employee. */
function notifyLeaveApproved(application) {
  const a = application || {};
  if (!a.employeeId) return;
  notifyEmployee(a.employeeId, {
    title: "Request approved",
    body: `Your ${leaveOf(a)} for ${shortDate(a.fromDate)} to ${shortDate(a.toDate)} is approved.`,
    kind: "leave",
    screen: "Leave",
    id: a._id,
  });
}

/** L4 / L6 — rejected by a manager or by HR. To the employee. */
function notifyLeaveRejected(application, reason) {
  const a = application || {};
  if (!a.employeeId) return;
  notifyEmployee(a.employeeId, {
    title: "Request not approved",
    body: withReason(
      `Your ${leaveOf(a)} for ${shortDate(a.fromDate)} wasn't approved.`,
      reason || a.rejectionReason,
    ),
    kind: "leave",
    screen: "Leave",
    id: a._id,
  });
}

/** L8 — employee asked to withdraw an approved leave. To BOTH managers. */
function notifyLeaveWithdrawRequested(application) {
  const a = application || {};
  const ids = (a.managersNotified || []).map((m) => m.managerId);
  if (!ids.length) return;
  notifyEmployee(ids, {
    title: "Withdrawal requested",
    body: `${firstName(a.employeeName)} wants to withdraw their approved ${leaveOf(a)} for ${shortDate(a.fromDate)}.`,
    kind: "leave",
    type: "leave_pending",
    screen: "Leave",
    id: a._id,
  });
}

/** L9 — withdrawal approved, days refunded. To the employee. */
function notifyLeaveWithdrawn(application) {
  const a = application || {};
  if (!a.employeeId) return;
  notifyEmployee(a.employeeId, {
    title: "Leave withdrawn",
    body: `Your ${leaveOf(a)} for ${shortDate(a.fromDate)} has been withdrawn and the days returned.`,
    kind: "leave",
    screen: "Leave",
    id: a._id,
  });
}

/** Not in the contract table, but the manager edit path already notified —
 *  kept so that behaviour doesn't regress. To the employee. */
function notifyLeaveEdited(application, editorName) {
  const a = application || {};
  if (!a.employeeId) return;
  notifyEmployee(a.employeeId, {
    title: "Leave request updated",
    body: `${firstName(editorName || "Your manager")} changed your ${leaveOf(a)} to ${shortDate(a.fromDate)} – ${shortDate(a.toDate)}.`,
    kind: "leave",
    screen: "Leave",
    id: a._id,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  REGULARIZATION  (contract §D.4, rows R1–R6)
//  Call sites live in routes/Employee_Routes/regularization.js and the two HR
//  decision routes in routes/HrRoutes/Attendance_section.js.
// ═══════════════════════════════════════════════════════════════════════════════

/** R1 — employee submitted. To the PRIMARY manager only. */
function notifyRegularizationSubmitted(request, employee) {
  const r = request || {};
  const primary = (r.managersNotified || []).find((m) => m.type === "primary");
  const to = primary?.managerId || (r.managersNotified || [])[0]?.managerId;
  if (!to) return;
  notifyEmployee(to, {
    title: "Attendance correction request",
    body: withReason(
      `${firstName(employee || r.employeeName)} asked to correct ${shortDate(r.dateStr)}.`,
      r.reason ? `Reason: ${r.reason}` : "",
    ),
    kind: "regularization",
    type: "regularization_pending",
    screen: "Regularize",
    id: r._id,
  });
}

/** R2 — primary approved and a secondary exists. To the SECONDARY. */
function notifyRegularizationSecondaryPending(request, primaryManagerName) {
  const r = request || {};
  const secondary = (r.managersNotified || []).find(
    (m) => m.type === "secondary",
  );
  if (!secondary?.managerId) return;
  notifyEmployee(secondary.managerId, {
    title: "Correction needs your approval",
    body: `${firstName(primaryManagerName || "Your manager")} approved ${firstName(r.employeeName)}'s correction for ${shortDate(r.dateStr)}. It's waiting on you.`,
    kind: "regularization",
    type: "regularization_pending",
    screen: "Regularize",
    id: r._id,
  });
}

/** R3 / R5 — final approval, applied to attendance. To the employee. */
function notifyRegularizationApproved(request) {
  const r = request || {};
  if (!r.employeeId) return;
  notifyEmployee(r.employeeId, {
    title: "Request approved",
    body: `Your attendance for ${shortDate(r.dateStr)} has been corrected.`,
    kind: "regularization",
    screen: "Regularize",
    id: r._id,
  });
}

/** R4 / R6 — rejected by a manager or by HR. To the employee. */
function notifyRegularizationRejected(request, reason) {
  const r = request || {};
  if (!r.employeeId) return;
  notifyEmployee(r.employeeId, {
    title: "Request not approved",
    body: withReason(
      `Your correction request for ${shortDate(r.dateStr)} wasn't approved.`,
      reason || r.rejectionReason,
    ),
    kind: "regularization",
    screen: "Regularize",
    id: r._id,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  OVERTIME  (contract §D.4, rows O1–O4)
// ═══════════════════════════════════════════════════════════════════════════════

/** O1 — report submitted. To the managers. */
function notifyOvertimeSubmitted(managerIds, { employeeName, dateStr, stayOverMins, graceMinutes, reportId }) {
  const h = Math.floor((stayOverMins || 0) / 60);
  const m = (stayOverMins || 0) % 60;
  notifyEmployee(managerIds, {
    title: "Overtime report submitted",
    body: `${firstName(employeeName)} stayed late on ${shortDate(dateStr)} (${h}h ${m}m extra). Approve to grant ${graceMinutes}min grace.`,
    kind: "overtime",
    type: "overtime_pending",
    screen: "Overtime",
    id: reportId,
  });
}

/** O2 — approved. To the employee. */
function notifyOvertimeApproved(employeeId, { body, reportId }) {
  notifyEmployee(employeeId, {
    title: "Overtime approved",
    body,
    kind: "overtime",
    screen: "Overtime",
    id: reportId,
  });
}

/** O3 — rejected. To the employee. */
function notifyOvertimeRejected(employeeId, { body, reportId }) {
  notifyEmployee(employeeId, {
    title: "Overtime report not approved",
    body,
    kind: "overtime",
    screen: "Overtime",
    id: reportId,
  });
}

/**
 * O4 — cron reminder. To the employee.
 * AWAITABLE on purpose: the cron counts how many reminders actually queued,
 * and it runs outside any request so blocking costs nothing.
 */
function notifyOvertimeReminder(employeeId, { outTime, dateStr }) {
  return notifyEmployeeNow(employeeId, {
    title: "Overtime report pending",
    body: `You stayed until ${outTime} on ${shortDate(dateStr)}. Submit your OT report to get grace time tomorrow.`,
    kind: "overtime",
    type: "attendance_alert",
    screen: "Overtime",
    id: dateStr,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PAYROLL  (contract §D.4, row P1)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * P1 — payslip published (/mark-paid). To every employee in the run.
 * `payroll` channel + category so Android gives it its own importance and the
 * app can style it separately.
 */
function notifyPayslipPublished(employeeIds, month, year, payrollId) {
  const label = `${MONTH_NAMES[Number(month)] || month} ${year}`;
  notifyEmployee(employeeIds, {
    title: "Payslip available",
    body: `Your payslip for ${label} is ready.`,
    kind: "payroll",
    screen: "Performance",
    id: payrollId || `${year}-${month}`,
    channelId: "payroll",
    categoryId: "payroll",
    badge: 1,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  EMPLOYEE DOCUMENTS  (HR-issued letters, behind the release gate)
//
//  EMPLOYEE-DIRECTED ONLY. There is deliberately no push to HR: sendExpoPush
//  resolves recipients from the Employee collection, and HR CMS users live in
//  HRDepartment with no row there — a notifyEmployee(hrUserId) call would be
//  dropped silently. HR learns of a new request from the CMS queue page.
//
//  Nothing fires when a document is merely GENERATED. That is the whole point
//  of the feature: a notification there would announce the existence of a
//  document the employee cannot see.
//
//  Channel/category stay the defaults ("general"). Adding a new channel here
//  without registering it in App/src/utils/notifications.js silently downgrades
//  importance on Android 8+.
// ═══════════════════════════════════════════════════════════════════════════════

/** The employee's word for the document. Never leaks HR's internal title logic. */
const docLabelOf = (d) =>
  (d?.type === "other" ? d?.otherTypeLabel : d?.title) || d?.title || "document";

/** D1 — HR released a document (fulfilling a request, or unsolicited). */
function notifyDocumentReleased(doc) {
  if (!doc?.employeeId) return;
  notifyEmployee(doc.employeeId, {
    title: "Document ready",
    body: `Your ${docLabelOf(doc).toLowerCase()} is ready to open.`,
    kind: "document",
    screen: "Documents",
    id: doc._id,
  });
}

/** D2 — HR declined a request. */
function notifyDocumentDeclined(doc, reason) {
  if (!doc?.employeeId) return;
  notifyEmployee(doc.employeeId, {
    title: "Request not approved",
    body: withReason(
      `Your request for a ${docLabelOf(doc).toLowerCase()} wasn't approved.`,
      reason || doc.declineReason,
    ),
    kind: "document",
    screen: "Documents",
    id: doc._id,
  });
}

/** D3 — HR withdrew a released document. */
function notifyDocumentRevoked(doc) {
  if (!doc?.employeeId) return;
  notifyEmployee(doc.employeeId, {
    title: "Document withdrawn",
    body: `Your ${docLabelOf(doc).toLowerCase()} has been withdrawn by the company.`,
    kind: "document",
    screen: "Documents",
    id: doc._id,
  });
}

module.exports = {
  // core
  notifyEmployee,
  notifyEmployeeNow,
  // leave
  notifyLeaveApplied,
  notifyLeaveSecondaryPending,
  notifyLeaveApproved,
  notifyLeaveRejected,
  notifyLeaveWithdrawRequested,
  notifyLeaveWithdrawn,
  notifyLeaveEdited,
  // regularization
  notifyRegularizationSubmitted,
  notifyRegularizationSecondaryPending,
  notifyRegularizationApproved,
  notifyRegularizationRejected,
  // overtime
  notifyOvertimeSubmitted,
  notifyOvertimeApproved,
  notifyOvertimeRejected,
  notifyOvertimeReminder,
  // payroll
  notifyPayslipPublished,
  // employee documents
  notifyDocumentReleased,
  notifyDocumentDeclined,
  notifyDocumentRevoked,
  // exported for tests / reuse
  firstName,
  shortDate,
};
