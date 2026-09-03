// services/notificationTypes.js
//
// Every kind of notification this system sends, named once.
//
// ── WHY A REGISTRY ──────────────────────────────────────────────────────────
// A settings screen that lets somebody switch notifications on and off has to
// know what the choices ARE, and the only honest source for that is the list of
// things actually sent. Before this, the types existed as string literals
// scattered across the senders and a hardcoded map in the browser's service
// worker — so a new kind of notification could ship with no way to turn it off,
// and a setting could exist for something nothing sends.
//
// The service worker's APPROVAL_PUSH map still filters what the browser draws.
// The `webTag` below is what keeps the two in step; a type with no tag simply
// is not drawn on web, which is a real answer for the ones that only make sense
// on a phone.
//
// ── REPEATABLE IS NOT THE SAME AS IMPORTANT ─────────────────────────────────
// `repeatable` marks the types that describe something STILL OUTSTANDING — a
// leave waiting for a decision, an overtime report nobody has signed off. Those
// can sensibly be sent again in an hour, because the reason for them has not
// gone away.
//
// A type that reports something that already happened — "your leave was
// approved" — is not repeatable and never will be. Repeating it would not
// remind anybody to do anything; it would just say the same finished thing
// again, hourly, until they turned notifications off entirely. Which is the
// real risk here: a repeat that annoys is a repeat that gets the whole channel
// muted, including the ones that mattered.

"use strict";

/**
 * @typedef {object} NotificationType
 * @property {string}  key         what senders pass as `type`
 * @property {string}  label       what the settings screen shows
 * @property {string}  description one line, so somebody can decide
 * @property {string}  group       how the settings screen groups them
 * @property {boolean} repeatable  may be re-sent hourly while still pending
 * @property {string}  [webTag]    the service worker's tag, when drawn on web
 * @property {string}  [url]       where tapping it should land
 */

/** @type {NotificationType[]} */
const NOTIFICATION_TYPES = [
  /* ── Things waiting on YOU ─────────────────────────────────────────────
     All repeatable: each describes a decision somebody else is blocked on. */
  {
    key: "leave_pending",
    label: "Leave awaiting your approval",
    description: "Somebody in your team has applied for leave.",
    group: "Waiting for you",
    repeatable: true,
    webTag: "leave",
    url: "/hr/dashboard/leaves",
  },
  {
    key: "regularization_pending",
    label: "Attendance correction awaiting your approval",
    description: "Somebody has asked for a day's attendance to be corrected.",
    group: "Waiting for you",
    repeatable: true,
    webTag: "regular",
    url: "/hr/dashboard/attendance/regularizations",
  },
  {
    key: "overtime_pending",
    label: "Overtime awaiting your approval",
    description: "An overtime report needs signing off.",
    group: "Waiting for you",
    repeatable: true,
    webTag: "ot",
    url: "/hr/dashboard/attendance/overtime",
  },
  {
    key: "department_approval",
    label: "Change awaiting your approval",
    description: "An editor has submitted a change that needs an approver.",
    group: "Waiting for you",
    repeatable: true,
    webTag: "dept",
    url: "/hr/dashboard/approvals",
  },
  {
    key: "accountant_approval",
    label: "Accounting entry awaiting your approval",
    description: "A voucher or budget item needs an approver.",
    group: "Waiting for you",
    repeatable: true,
    webTag: "acc",
    url: "/accountant/approvals",
  },

  /* ── Outcomes ──────────────────────────────────────────────────────────
     None repeatable. They report a fact, and a fact does not become more
     true on the hour. */
  {
    key: "request_decided",
    label: "Your request was decided",
    description: "Your leave, overtime or correction was approved or rejected.",
    group: "About you",
    repeatable: false,
    webTag: "req",
  },
  {
    key: "payroll",
    label: "Payroll and payslips",
    description: "Your payslip is ready, or your pay has been processed.",
    group: "About you",
    repeatable: false,
    webTag: "pay",
  },
  {
    key: "attendance_alert",
    label: "Attendance reminders",
    description: "A missed punch, or a day that needs your attention.",
    group: "About you",
    repeatable: true,
    webTag: "att",
  },

  {
    key: "document",
    label: "Documents",
    description: "A document you asked for is ready, or was declined.",
    group: "About you",
    repeatable: false,
    webTag: "doc",
    url: "/work/documents",
  },

  /* ── Operational ───────────────────────────────────────────────────────── */
  {
    key: "developer_alert",
    label: "System alerts",
    description: "Errors and health warnings. Developer access only.",
    group: "System",
    repeatable: false,
    webTag: "devalert",
    url: "/developer/alerts",
  },
];

const BY_KEY = new Map(NOTIFICATION_TYPES.map((t) => [t.key, t]));

/** Every type, for the settings screen. */
function listTypes() {
  return NOTIFICATION_TYPES.map((t) => ({ ...t }));
}

function getType(key) {
  return BY_KEY.get(String(key || "")) || null;
}

/** Can this type sensibly be sent again while the thing is still pending? */
function isRepeatable(key) {
  return Boolean(BY_KEY.get(String(key || ""))?.repeatable);
}

/**
 * The default preference for a type, used for a device nobody has configured.
 *
 * Everything ON, every repeat OFF. On because a person who installed the app
 * and signed in has asked to be told things; off because an hourly repeat
 * nobody chose is the fastest way to make somebody mute the whole channel —
 * and the ones they would lose are the ones this exists for.
 */
function defaultPrefs() {
  const out = {};
  for (const t of NOTIFICATION_TYPES) {
    out[t.key] = { enabled: true, repeat: false };
  }
  return out;
}

module.exports = {
  NOTIFICATION_TYPES,
  listTypes,
  getType,
  isRepeatable,
  defaultPrefs,
};
