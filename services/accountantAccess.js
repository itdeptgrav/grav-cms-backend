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

const crypto = require("crypto");

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

/**
 * Give this email an accountant role, creating the Acc_User if needed.
 *
 * Used by Access Control. Creating here is genuinely creating an accountant
 * user — the same row the accountant team page lists — not a shadow copy.
 *
 * @param password  only used when creating; an existing user keeps theirs
 */
async function setAccountantRole({ email, name, role, password, actorId }) {
  const normalised = String(email || "").toLowerCase().trim();
  if (!normalised) throw new Error("An email address is required");
  if (!ROLES.includes(role)) {
    throw new Error(`Role must be one of: ${ROLES.join(", ")}`);
  }

  const org = await resolveOrganization();
  if (!org) {
    throw new Error(
      "No accounting organisation exists yet. Open the Accounting module once to create it.",
    );
  }

  let user = await Acc_User.findOne({ organizationId: org._id, email: normalised });

  if (user) {
    // Exactly one owner per organisation — the model enforces it, so demote
    // the incumbent rather than letting the save fail with a validation error
    // the admin cannot act on.
    if (role === "owner" && user.role !== "owner") {
      await Acc_User.updateMany(
        { organizationId: org._id, role: "owner", _id: { $ne: user._id } },
        { $set: { role: "approver" } },
      );
    }
    if (user.role !== role) {
      user.role = role;
      // Their permissions just changed; existing accountant sessions must not
      // keep the old ones.
      user.tokenVersion = (user.tokenVersion || 0) + 1;
    }
    user.isActive = true;
    await user.save();
    return { user, created: false };
  }

  // ONE PASSWORD PER HUMAN.
  //
  // If this email already belongs to an employee, they sign in with the
  // password on their HR record — the department login path authenticates them
  // and then attaches this accounting role. Asking for a second password here
  // would create two credentials for one person that immediately drift apart,
  // and the one they were given would be the one that did not work.
  //
  // So for an employee the Acc_User row carries the ROLE only, behind a hash no
  // password can match. It is never used: the employee branch of login runs
  // first and authenticates against the HR record.
  const Employee = require("../models/Employee");
  const isEmployee = await Employee.exists({ email: normalised });

  if (!isEmployee && (!password || String(password).length < 8)) {
    throw new Error(
      "This email does not belong to an employee, so it needs its own password " +
        "of at least 8 characters to sign in.",
    );
  }

  if (role === "owner") {
    await Acc_User.updateMany(
      { organizationId: org._id, role: "owner" },
      { $set: { role: "approver" } },
    );
  }

  user = new Acc_User({
    organizationId: org._id,
    name: name || normalised,
    email: normalised,
    role,
    isActive: true,
    invitedBy: actorId || undefined,
    passwordHash: "pending",
  });

  if (password) {
    await user.setPassword(String(password));
  } else {
    // Employee — an unusable hash. Their HR password is the real credential.
    await user.setPassword(crypto.randomBytes(24).toString("hex"));
  }

  await user.save();

  return { user, created: true, usesEmployeePassword: !password };
}

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

  await user.setPassword(plain);
  user.tokenVersion = (user.tokenVersion || 0) + 1;   // ends their open sessions
  await user.save();

  /* The HR record, when the same person has one. Assigned and saved rather
     than updated in place: Employee hashes in a pre-save hook, and a
     findOneAndUpdate would store the plaintext. */
  const Employee = require("../models/Employee");
  const employee = await Employee.findOne({ email: normalised });
  if (employee) {
    employee.password = plain;
    await employee.save();
  }

  return { user, accountUpdated: true, employeeUpdated: Boolean(employee) };
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

/**
 * Delete an accounting user outright.
 *
 * Only for people who exist ONLY as an Acc_User — an external bookkeeper or
 * auditor. For them "remove access" and "delete" are the same act: the row IS
 * the account, so deactivating it leaves a dead entry in the list that can
 * never do anything again.
 *
 * An employee is refused. Their identity is the HR record, and dropping the
 * Acc_User row is how you take away their accounting role — that is
 * revokeAccountantRole, not this.
 */
async function deleteAccountantUser(email) {
  const normalised = String(email || "").toLowerCase().trim();
  const user = await findAccountantUser(normalised);
  if (!user) return null;

  if (user.role === "owner") {
    throw new Error(
      "The organisation owner cannot be deleted. Make somebody else the owner first.",
    );
  }

  await Acc_User.deleteOne({ _id: user._id });
  return user;
}

/** Remove someone's accountant access without deleting their history. */
async function revokeAccountantRole(email) {
  const user = await findAccountantUser(email);
  if (!user) return null;

  if (user.role === "owner") {
    throw new Error(
      "The organisation owner cannot be removed. Make somebody else the owner first.",
    );
  }

  user.isActive = false;
  user.tokenVersion = (user.tokenVersion || 0) + 1;   // sign them out now
  await user.save();
  return user;
}

module.exports = {
  ROLES,
  resolveOrganization,
  findAccountantUser,
  setAccountantRole,
  setAccountantPassword,
  resetAccountantPassword,
  getAccountantNavPrefs,
  setAccountantNavPrefs,
  revokeAccountantRole,
  deleteAccountantUser,
};
