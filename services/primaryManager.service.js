/**
 * GRAV-CMS-BACKEND/services/primaryManager.service.js
 *
 * Who manages this employee, as a CoWork account that can be asked to decide.
 *
 * **Two hops, and both can fail.** The reporting line lives in HR (Mongo), keyed
 * by `biometricId`; the person who has to press a button lives in CoWork
 * (Firestore). A manager recorded in HR who has never been provisioned in CoWork
 * cannot be routed to, and saying so — by answering `null` — is the only honest
 * result. Callers fall back rather than route a decision to somebody who cannot
 * take it.
 *
 * Extracted from `taskForward.js`, which still calls it under its old name. It
 * decides who may set and settle an employee's time budget, and a permission
 * lookup with two copies is a permission lookup with two answers.
 */

/**
 * @returns {Promise<{approverId: string, approverName: string, source: string}|null>}
 *   Null where HR records no primary manager, or where that manager has no
 *   CoWork account to act with.
 */
async function resolvePrimaryManagerApprover(employeeId) {
  try {
    const { db } = require("../config/firebaseAdmin");
    const Employee = require("../models/Employee");
    const hrEmp = await Employee.findOne({ biometricId: employeeId })
      .populate("primaryManager.managerId", "firstName middleName lastName biometricId")
      .lean();
    const mgr = hrEmp?.primaryManager?.managerId;
    const mgrBiometricId = mgr?.biometricId;
    if (!mgrBiometricId) return null;
    const cwSnap = await db.collection("cowork_employees").doc(mgrBiometricId).get();
    if (!cwSnap.exists) return null;
    const cw = cwSnap.data();
    return { approverId: cw.employeeId, approverName: cw.name, source: "primary_manager" };
  } catch (e) {
    console.warn("[resolvePrimaryManagerApprover]", e.message);
    return null;
  }
}

module.exports = { resolvePrimaryManagerApprover };
