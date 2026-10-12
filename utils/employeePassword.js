// utils/employeePassword.js
//
// How an employee's password is checked — in one place.
//
// There are four ways an employee credential can currently be valid, and they
// accumulated across three files that each knew about a different subset:
//
//   1. A bcrypt hash            — the normal case
//   2. A PLAINTEXT string       — legacy rows written before hashing existed
//   3. Firstname@MMDDYYYY       — derived from first name + date of birth
//                                 (routes/HrRoutes/Passwordmanagement.js)
//   4. A phone-derived default  — (routes/Employee_Routes/login.js)
//
// The department portal originally checked only (1), so anyone still on a
// derived or legacy password was told "invalid email or password" while the
// employee app let them straight in. Same person, same password, two answers.
//
// A successful match on (2), (3) or (4) UPGRADES the stored value to a bcrypt
// hash, so each account converts the first time its owner signs in and the
// legacy paths quietly drain away rather than living forever — but (3) and (4)
// only when no real (bcrypt) password is stored: a default sign-in never
// replaces a password HR or the person set (12 Oct 2026).

"use strict";

const bcrypt = require("bcryptjs");

/** Firstname@MMDDYYYY — mirrors Passwordmanagement.js exactly. */
function defaultFromNameAndDob(firstName, dateOfBirth) {
  if (!firstName || !dateOfBirth) return null;

  const name =
    firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();

  const date = typeof dateOfBirth === "string" ? new Date(dateOfBirth) : dateOfBirth;
  if (!date || isNaN(date.getTime())) return null;

  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");

  return `${name}@${month}${day}${year}`;
}

/** The phone-number default used by the employee mobile app. */
function defaultFromPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length === 10 ? digits : null;
}

/**
 * Does `plain` authenticate `employee`?
 *
 * @param employee  a full Employee document (needs password, firstName,
 *                  dateOfBirth, phone) — NOT a partially-selected one
 * @param plain     the submitted password
 * @returns {Promise<{ ok: boolean, via: string|null, needsUpgrade: boolean }>}
 */
async function matchesEmployeePassword(employee, plain) {
  const submitted = String(plain || "");
  if (!employee || !submitted) return { ok: false, via: null, needsUpgrade: false };

  const stored = employee.password || "";

  // 1. bcrypt — the only path that should exist long-term.
  if (stored.startsWith("$2")) {
    const ok = await bcrypt.compare(submitted, stored);
    if (ok) return { ok: true, via: "hash", needsUpgrade: false };
    // Fall through: a stale hash must not block a valid derived password,
    // otherwise resetting someone to a default would lock them out.
  } else if (stored && stored === submitted) {
    // 2. Legacy plaintext.
    return { ok: true, via: "plaintext", needsUpgrade: true };
  }

  /* A default may still sign somebody in, but it must NEVER replace a real
     password that is stored (12 Oct 2026). "Upgrading" on a default match
     overwrote the password HR had just set through "forgot password"
     whenever anybody — or an app holding old credentials — signed in with a
     default, so HR had to set it again several times a day. A default
     upgrades only an account with no real password: nothing stored, or the
     legacy plain text. */
  const hasRealPassword = stored.startsWith("$2");

  // 3. Firstname@MMDDYYYY
  const nameDefault = defaultFromNameAndDob(employee.firstName, employee.dateOfBirth);
  if (nameDefault && submitted === nameDefault) {
    return { ok: true, via: "default-name-dob", needsUpgrade: !hasRealPassword };
  }

  // 4. Phone default
  const phoneDefault = defaultFromPhone(employee.phone);
  if (phoneDefault && submitted === phoneDefault) {
    return { ok: true, via: "default-phone", needsUpgrade: !hasRealPassword };
  }

  return { ok: false, via: null, needsUpgrade: false };
}

/**
 * Persist a bcrypt hash for an account that just authenticated by a legacy or
 * derived route.
 *
 * Written with updateOne rather than .save() on purpose: Employee has a
 * pre-save hook that recalculates and re-encrypts the entire salary block, and
 * running payroll code as a side effect of somebody signing in is both slow and
 * a way to corrupt salary on a partially-loaded document.
 */
async function upgradeEmployeePassword(EmployeeModel, employeeId, plain) {
  try {
    const hash = await bcrypt.hash(String(plain), 10);
    await EmployeeModel.updateOne({ _id: employeeId }, { $set: { password: hash } });
    return true;
  } catch (err) {
    // Never fail a valid login because the upgrade failed — they authenticated.
    console.error("[employeePassword] upgrade failed:", err.message);
    return false;
  }
}

module.exports = {
  matchesEmployeePassword,
  upgradeEmployeePassword,
  defaultFromNameAndDob,
  defaultFromPhone,
};
