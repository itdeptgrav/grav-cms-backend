// services/departmentApprovalNotifications.service.js
//
// Push notifications for the DEPARTMENT approval queue (HR, Sales, Production…)
// — the same thing services/accountantApprovalNotifications.service.js does for
// the accountant module, over the other half of the platform.
//
//   • held     → an editor submitted a change → tell the owner and approvers
//   • approved → tell the editor who asked, so they know it landed
//   • rejected → tell them it did not, and why
//
// WHY A SECOND SERVICE RATHER THAN REUSING THE ACCOUNTANT ONE
// -----------------------------------------------------------
// Only the FCM plumbing is shared; everything that decides WHO gets a message
// differs. The accountant service resolves recipients from Acc_User by
// organizationId and reads Acc_User.fcmTokens (an array, one org account per
// person). This side resolves them from DepartmentRole by slug and reads
// Employee.fcmToken (a single string, the field the CMS and the mobile app
// already share). Generalising over both would mean a recipient resolver with a
// branch in it and two token shapes — more code than two honest services.
//
// SAFETY
//   Never throws back into the caller. It is called fire-and-forget from the
//   hold and decide paths, and a push failure must never be able to break a
//   change request being queued or approved. Every await here is inside a try.

"use strict";

const DepartmentRole = require("../models/Access/DepartmentRole");
const Employee = require("../models/Employee");

const APP_URL = (process.env.FRONTEND_URL || "https://cms.grav.in").replace(/\/+$/, "");

/**
 * Where the notification takes you.
 *
 * Every department's queue lives at the same place inside its own dashboard,
 * which is what makes one line work for all of them. A department whose
 * approvals page sits elsewhere adds a row here rather than a branch.
 */
const APPROVALS_PATH = {
  hr: "/hr/dashboard/approvals",
  sales: "/sales/dashboard/approvals",
};

function approvalsUrl(slug) {
  return `${APP_URL}${APPROVALS_PATH[slug] || `/${slug}/dashboard/approvals`}`;
}

/* ------------------------------------------------------------------ */
/* Firebase Admin — lazy, and may legitimately be unconfigured         */
/* ------------------------------------------------------------------ */

let _messaging = null; // null = untried, false = unavailable

function getMessaging() {
  if (_messaging !== null) return _messaging || null;
  try {
    const fb = require("../config/firebaseAdmin");
    _messaging = fb.messaging || false;
  } catch (err) {
    console.warn("[dept-notif] firebaseAdmin unavailable — push disabled:", err.message);
    _messaging = false;
  }
  return _messaging || null;
}

/**
 * Send to one employee's registered browser.
 *
 * DATA-ONLY, deliberately. The service worker's raw `push` listener draws the
 * notification itself (public/firebase-messaging-sw.js), which is what makes it
 * appear whether the tab is focused, backgrounded or closed. Adding a
 * `notification` block here would make the browser draw its own as well and the
 * user would see each message twice.
 */
async function sendPush(employee, { title, body, url, type = "department_approval" }) {
  /* Registered devices decide first — the rule is in utils/sendExpoPush. The
     single fcmToken field below is only for a person the registry has never
     seen. */
  try {
    const { notifyEmployeeDevices } = require("./notifyDevices.service");
    const r = await notifyEmployeeDevices(employee, { type, title, body, url });
    if (r.matched > 0) return r.sent > 0;
  } catch {
    /* fall through to the stored token */
  }

  const token = employee?.fcmToken;
  if (!token) return false;

  const messaging = getMessaging();
  if (!messaging) return false;

  try {
    await messaging.send({
      token,
      data: {
        title: String(title),
        body: String(body),
        // The service worker filters on this. It must stay in step with the
        // APPROVAL_PUSH map in public/firebase-messaging-sw.js or nothing is
        // drawn. Parametrised so the developer side's alerts can ride the same
        // transport under their own type and tray tag.
        type,
        url: String(url),
        timestamp: String(Date.now()),
      },
      webpush: { headers: { Urgency: "high", TTL: "600" } },
    });
    return true;
  } catch (err) {
    const code = err.errorInfo?.code || err.code || "";
    if (
      code.includes("registration-token-not-registered") ||
      code.includes("invalid-registration") ||
      code.includes("invalid-argument") ||
      code.includes("not-registered")
    ) {
      // The browser has revoked this registration — clear it so we stop paying
      // to send to it. Not an error worth logging: it is what a signed-out or
      // reinstalled browser looks like.
      try {
        await Employee.updateOne({ _id: employee._id }, { $set: { fcmToken: null } });
      } catch {
        /* best effort */
      }
    } else {
      console.warn(`[dept-notif] push failed for ${employee.email}:`, err.message);
    }
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Recipients                                                          */
/* ------------------------------------------------------------------ */

/** The employee behind an email, with the one field we send to. */
async function employeeByEmail(email) {
  const e = String(email || "").toLowerCase().trim();
  if (!e) return null;
  try {
    return await Employee.findOne({ email: e })
      .select("name firstName lastName email fcmToken")
      .lean();
  } catch {
    return null;
  }
}

/**
 * Who can act on a pending change in this department.
 *
 * The requester is excluded even when they hold an approver role: they cannot
 * approve their own change (the server refuses it with SELF_APPROVAL), so
 * telling them it needs approving is noise.
 */
async function approversOf(slug, exceptEmail) {
  const skip = String(exceptEmail || "").toLowerCase();
  let rows = [];
  try {
    rows = await DepartmentRole.find({
      departmentSlug: String(slug || "").toLowerCase(),
      role: { $in: ["owner", "approver"] },
    })
      .select("email")
      .lean();
  } catch (err) {
    console.warn("[dept-notif] could not list approvers:", err.message);
    return [];
  }

  const people = await Promise.all(
    rows
      .filter((r) => String(r.email || "").toLowerCase() !== skip)
      .map((r) => employeeByEmail(r.email)),
  );
  return people.filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * @param {object} cr       the ChangeRequest document
 * @param {string} event    "held" | "approved" | "rejected"
 * @param {object} [opts]
 * @param {function} [opts.send]  the transport, (employee, message) => Promise.
 *   Defaults to sendPush. It is a parameter rather than a module-local call so
 *   that WHO gets told and WHAT they are told can be checked without a Firebase
 *   project and without sending anything to a real device — that behaviour is
 *   the whole of this service, and a transport that can only be reached through
 *   FCM is a service that cannot be verified.
 */
async function notifyChangeRequest(cr, event, { send = sendPush } = {}) {
  try {
    if (!cr) return;
    const slug = cr.departmentSlug;
    const url = approvalsUrl(slug);
    const asked = cr.requestedBy?.name || cr.requestedBy?.email || "A teammate";

    // The card's own words. `summary` now names the fields (see
    // services/changeRequestDescribe), so the notification says what changed
    // rather than only that something did.
    const what =
      `${cr.entity}${cr.entityLabel ? ` “${cr.entityLabel}”` : ""}` +
      `${cr.summary ? ` — ${cr.summary}` : ""}`;

    if (event === "held") {
      const recipients = await approversOf(slug, cr.requestedBy?.email);
      if (!recipients.length) {
        console.log(`[dept-notif] ${slug}: nobody to notify about a held change`);
        return;
      }
      await Promise.all(
        recipients.map((r) =>
          send(r, { title: "Approval needed", body: `${asked}: ${what}`, url }),
        ),
      );
      return;
    }

    const requester = await employeeByEmail(cr.requestedBy?.email);
    if (!requester) return;

    const decidedBy = cr.decidedBy?.name || cr.decidedBy?.email || "An approver";

    if (event === "approved") {
      await send(requester, {
        title: "Change approved",
        body: `${decidedBy} approved your change to ${what}`,
        url,
      });
    } else if (event === "rejected") {
      await send(requester, {
        title: "Change rejected",
        body:
          `${decidedBy} rejected your change to ${what}` +
          `${cr.decisionNote ? ` — ${cr.decisionNote}` : ""}`,
        url,
      });
    }
  } catch (err) {
    console.error("[dept-notif] notifyChangeRequest error:", err.message);
  }
}

module.exports = { notifyChangeRequest, sendPush, approversOf, approvalsUrl, getMessaging };
