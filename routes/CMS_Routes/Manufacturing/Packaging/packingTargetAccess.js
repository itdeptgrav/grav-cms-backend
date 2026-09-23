// routes/CMS_Routes/Manufacturing/Packaging/packingTargetAccess.js
//
// WHO MAY READ AND ANSWER PPC'S PACKING TARGETS, AND FOR WHICH WORK.
//
// The fourth of the receiver access modules, after Cutting's, Embroidery's
// and Production's, and stated again here for the same reason they are stated
// separately from each other: these doors are edited by different people at
// different times, and a shared guard silently changing one of them is the
// failure the set is guarding against.
//
// ── WHY THIS IS A SEPARATE DOOR FROM THE PACKAGING EXECUTION ROUTES ─────────
// It began as one: when this door was written, `packagingRoutes.js` and
// `packagingDispatchViewRoutes.js` carried `EmployeeAuthMiddleware` and
// nothing else — no department role, no company — so a commitment one
// company's Packaging & Dispatch makes to one company's PPC could not be made
// on them. Those routes have since been hardened in their own right and now
// carry the same department and company rules through `./packagingAccess.js`.
//
// This door stays separate anyway, for the reason it will keep: ANSWERING A
// TARGET IS NOT RECORDING WORK, and the two need different policy.
//
//   · Reading Packaging's own numbers is deliberately wider than Packaging —
//     `packagingReader` also admits a `project-manager` or `ceo` viewer,
//     because those departments' screens already show the floor. None of that
//     reaches here: this door resolves `packaging-dispatch` and nothing else,
//     so watching the floor never becomes answering for it.
//   · Those routes serve a live floor and carry their own rollout rule. This
//     door is new, nothing depends on it being permissive, and it fails
//     closed. One answer to "who is this person and what role do they hold",
//     shared below; two explicit answers to "what happens when they hold
//     none".
//
// The packaging screens therefore call this door as a second request, and it
// is mounted ahead of the execution router so its prefix resolves here.
//
// Three questions, the same three the other receivers ask:
//
//   1. IS THIS PERSON PACKAGING & DISPATCH?  (`packagingDepartment`)
//      An administrator, as everywhere. Otherwise, once any
//      `packaging-dispatch` grant exists, a live grant in it — viewer to read
//      a target, editor to answer one. Before any grant exists, only a session
//      of the Packaging & Dispatch department itself.
//
//      This fails CLOSED. An ungranted deployment cannot accept PPC's packing
//      dates on a whole company's behalf, and "nobody can answer yet" is a
//      state PPC can see and an administrator can fix in one screen.
//
//      A PPC grant is not a Packaging grant and never admits anybody here:
//      PPC publishes the target and may not answer its own request. Neither
//      is a Production, Cutting or Embroidery grant — each department answers
//      its own process, on its own door.
//
//   2. WHICH COMPANY?  (`packagingCompany`)
//      The actor's own membership, resolved server-side by the shared company
//      middleware. Never a company id from the client.
//
//   3. IS THIS WORK THAT COMPANY'S?  (`workOrderScope`)
//      A WorkOrder's company is its Sales-line link, stamped at creation by
//      the Sales-line ↔ WorkOrder bridge. That link is the only authoritative
//      source, so it is the whole rule. A historical WorkOrder with no link is
//      nobody's — it is in no company's queue and reveals no target — and it
//      is never given a company from its style, buyer, number or product name.
"use strict";

const departmentRoles = require("../../../../services/departmentRoles");

/* ── SHARED IDENTITY, OWN POLICY ────────────────────────────────────────────
   Who this person is, what role they hold, which company they act in and which
   WorkOrders are that company's are one implementation, shared with Packaging's
   execution routes (packagingAccess.js). What happens when somebody holds NO
   role is NOT shared: this door fails closed, and says so below. */
const shared = require("./packagingAccess");

const {
  SLUG, LEGACY_ROLES, isPackagingSession, packagingCompany, workOrderScope, isId,
} = shared;

/** Guard: this person is Packaging & Dispatch (`required` applies once grants exist). */
function packagingDepartment(required = "viewer") {
  return async (req, res, next) => {
    try {
      if (!req.user?.id) return res.status(401).json({ success: false, message: "Authentication required" });
      if (req.user.isAdmin) return next();

      if (!(await shared.grantsExist(SLUG))) {
        if (isPackagingSession(req.user)) return next();
        return res.status(403).json({ success: false, code: "NO_DEPARTMENT_ROLE",
          message: "Packing targets are Packaging & Dispatch's." });
      }
      const role = await shared.effectiveRole(req, SLUG);
      if (!role) {
        return res.status(403).json({ success: false, code: "NO_DEPARTMENT_ROLE",
          message: "You have not been given a role in Packaging & Dispatch." });
      }
      if (!departmentRoles.roleAtLeast(role, required)) {
        return res.status(403).json({ success: false, code: "INSUFFICIENT_DEPARTMENT_ROLE", role, requires: required,
          message: `This action needs ${required} access in Packaging & Dispatch. You are ${role}.` });
      }
      req.departmentRole = role;
      return next();
    } catch (err) {
      console.error("[packing-target-access] guard failed:", err.message);
      return res.status(500).json({ success: false, message: "Could not check your access." });
    }
  };
}

/**
 * May this person ANSWER a packing target — accept or refuse it?
 *
 * The same rule `packagingDepartment("editor")` enforces, asked without
 * refusing the request, so a read can tell the screen whether to offer the
 * controls at all. Derived here from the live grant and the session's own
 * department: never from a badge, a department label, an email or anything
 * the browser sent. The guard on the answer routes remains the authority —
 * this only decides whether a button is worth drawing.
 */
async function canAnswerTargets(req) {
  try {
    if (!req.user?.id) return false;
    if (req.user.isAdmin) return true;
    if (!(await shared.grantsExist(SLUG))) return isPackagingSession(req.user);
    const role = await shared.effectiveRole(req, SLUG);
    return Boolean(role) && departmentRoles.roleAtLeast(role, "editor");
  } catch (err) {
    /* An unreadable grant is not a permission. */
    console.error("[packing-target-access] capability check failed:", err.message);
    return false;
  }
}

module.exports = {
  SLUG, LEGACY_ROLES, isPackagingSession,
  packagingDepartment, packagingCompany, canAnswerTargets, workOrderScope, isId,
};
