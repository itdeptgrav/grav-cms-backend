// services/accountantAccess.js
//
// The bridge between department access and the accountant module's own roles.
//
// WHY THERE IS NO NEW SCHEMA HERE
// -------------------------------
// The accountant module already models its users properly: `Acc_User`, scoped
// to an organisation, with the roles owner / approver / editor / viewer and its
// own password and token version. Copying that into the access layer would give
// two records per person that immediately disagree — somebody made an editor in
// the accountant team page would still be a viewer in Access Control.
//
// So `Acc_User` stays the single source of truth. Access Control reads and
// writes THAT collection, which is what makes "create it on one side and it
// appears on the other" true by construction rather than by synchronisation.
//
// What this file adds is the missing link at sign-in: when somebody signs in to
// the Accounting department through the portal, they also need the
// `accountant_token` the module's middleware expects. Without it they arrive
// holding a CMS token whose role is "hr_manager" or "accountant", which the
// accountant guards correctly refuse — the error the CEO saw on /accountant.

"use strict";

const {
  Acc_Organization,
  Acc_User,
  ROLES,
} = require("../models/Accountant_model/Acc_OrgModels");

/**
 * The organisation new accountant users belong to.
 *
 * This deployment runs a single company, so the first organisation is it.
 * Returned rather than assumed so a multi-org future has one place to change.
 */
async function resolveOrganization() {
  return Acc_Organization.findOne({}).sort({ createdAt: 1 });
}

/** The accountant identity for an email, or null. */
async function findAccountantUser(email) {
  const normalised = String(email || "").toLowerCase().trim();
  if (!normalised) return null;
  return Acc_User.findOne({ email: normalised });
}

/* GAC-2 correction: setAccountantRole, revokeAccountantRole and
   deleteAccountantUser are REMOVED. Every Accounting grant, role change and
   revoke goes through services/access/accessGrantAdmin.service.js
   (changeAppAccess) — the Acc_User adapter there is the only writer of
   Acc_User.role / Acc_User.isActive. test/access/gac2-single-writer.contract.test.js
   fails if a route or service writes them anywhere else. */

/**
 * Set somebody's accounting password — on EVERY door it opens.
 *
 * WHY THIS NO LONGER REFUSES EMPLOYEES
 * ------------------------------------
 * It used to, on the reasoning that "their credential lives on the HR record
 * and that is the one login checks". That is only half true, and the missing
 * half is what made a reset appear to work and change nothing:
 *
 *   /api/auth/login            (the CMS)        checks Employee.password
 *   /api/accountant/auth/login (the books)      checks Acc_User.password
 *
 * Somebody who is both an employee and an accountant team member therefore has
 * TWO passwords, and resetting either one leaves the other door open on the old
 * one. Refusing the reset did not fix that; it just moved the surprise.
 *
 * So a reset now writes both, and reports which it touched, so the person doing
 * it can be told the truth rather than a guess.
 *
 * WORTH KNOWING BEFORE YOU USE IT: this means an accounting owner resetting a
 * team member's password also changes that person's CMS password, if they have
 * one. That is the point — one person, one credential — but it is real
 * authority, which is why the routes that call this are owner-only and why
 * every call is written to the change log.
 *
 * @returns {{user, accountUpdated: boolean, employeeUpdated: boolean}}
 */
async function setAccountantPassword(email, password) {
  const normalised = String(email || "").toLowerCase().trim();
  const plain = String(password || "");
  if (plain.length < 8) {
    throw new Error("The password must be at least 8 characters");
  }

  const user = await findAccountantUser(normalised);
  if (!user) throw new Error("No accounting user with that email");

  /* A role-only record (loginMode "none") has no password to set: the person
     signs in with their GRAV login. Only that credential is changed below. */
  const roleOnly = user.loginMode === "none";
  if (!roleOnly) {
    await user.setPassword(plain);
    user.tokenVersion = (user.tokenVersion || 0) + 1;   // ends their open sessions
    await user.save();
  }

  /* The HR record, when the same person has one. Assigned and saved rather
     than updated in place: Employee hashes in a pre-save hook, and a
     findOneAndUpdate would store the plaintext. */
  const Employee = require("../models/Employee");
  const employee = await Employee.findOne({ email: normalised });
  if (employee) {
    employee.password = plain;
    await employee.save();
  }
  if (roleOnly && !employee) {
    throw new Error("This person signs in with their GRAV department login; reset it in Access Control.");
  }

  return { user, accountUpdated: !roleOnly, employeeUpdated: Boolean(employee) };
}

/**
 * Kept under its old name because Access Control calls it that. Same behaviour
 * as before for an accounting-only user; for an employee it now succeeds and
 * syncs instead of throwing.
 */
async function resetAccountantPassword(email, password) {
  const { user } = await setAccountantPassword(email, password);
  return user;
}

/* ------------------------------------------------------------------ */
/* Sidebar access                                                      */
/* ------------------------------------------------------------------ */

/**
 * Which nav items this person has hidden.
 *
 * Lives here rather than in either router because BOTH manage it — the
 * accountant Team page and Access Control — and a second copy is how the two
 * screens start disagreeing about what somebody can see.
 */
async function getAccountantNavPrefs(email) {
  const user = await findAccountantUser(email);
  if (!user) throw new Error("No accounting user with that email");
  return {
    email: user.email,
    name: user.name,
    role: user.role,
    hiddenNavItems: user.hiddenNavItems || [],
  };
}

async function setAccountantNavPrefs(email, hiddenNavItems) {
  const user = await findAccountantUser(email);
  if (!user) throw new Error("No accounting user with that email");

  const cleaned = Array.isArray(hiddenNavItems)
    ? hiddenNavItems
        .filter((x) => typeof x === "string")
        .map((x) => x.trim())
        .filter((x) => x.startsWith("/accountant"))
        /* Never hide the dashboard — it is where login lands, and hiding it
           leaves the person with nowhere to arrive. Same rule the Team page
           applies; it lives here so both callers get it. */
        .filter((x) => x !== "/accountant")
    : [];

  /* updateOne + `strict: false`, matching the Team route — see the note there
     for why this write is the one that cannot regress. */
  await Acc_User.updateOne(
    { _id: user._id },
    { $set: { hiddenNavItems: cleaned } },
    { strict: false },
  );

  // Read back, so a caller is never told a value was saved when it was not.
  return Acc_User.findById(user._id).select("name email role hiddenNavItems").lean();
}

module.exports = {
  ROLES,
  resolveOrganization,
  findAccountantUser,
  setAccountantPassword,
  resetAccountantPassword,
  getAccountantNavPrefs,
  setAccountantNavPrefs,
};
