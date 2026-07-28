// services/mrfApprover.service.js
//
// Resolves who approves an MRF: the requester's Primary Manager / TL, taken
// from the HR Employee record.
//
//   requester (biometricId)
//     → Employee doc
//       → primaryManager.managerId
//         → manager Employee doc
//           → manager.biometricId          ← the TL's cowork login identity
//
// The TL's cowork session carries that same biometricId as
// req.coworkUser.employeeId, so the approvals queue is a straight equality
// filter on MRF.approverBiometricId.
//
// When the chain breaks anywhere (no manager set, manager missing/inactive, or
// the manager has no biometricId and therefore cannot log in to cowork) the
// request is NOT blocked — it is auto-forwarded straight to the Store, flagged
// so every screen can say why no TL approved it.

const Employee = require("../models/Employee");

function buildFullName(emp) {
  if (!emp) return "";
  return [emp.firstName, emp.middleName, emp.lastName]
    .filter(Boolean).join(" ").trim() || emp.name || emp.email || "";
}

// Mirrors the rejection rules in Middlewear/coworkAuth.js — a manager the
// cowork login would refuse must not be handed an approval queue.
function isInactive(emp) {
  if (!emp) return true;
  if (emp.isActive === false) return true;
  const s = String(emp.status || "").toLowerCase();
  return s === "inactive" || s === "suspended";
}

const HUMAN_REASON = {
  NO_MANAGER: "No Primary Manager is assigned to you in HR",
  MANAGER_NOT_FOUND: "Your Primary Manager's HR record could not be found",
  MANAGER_INACTIVE: "Your Primary Manager's account is inactive",
  MANAGER_NO_BIOMETRIC: "Your Primary Manager has no Biometric ID and cannot approve in CoWork",
  SELF_MANAGED: "You are listed as your own Primary Manager",
};

/**
 * @param {object} requester  lean Employee doc of the person raising the MRF
 * @returns {Promise<object>} field patch to spread onto a new MRF
 */
async function resolveApprover(requester) {
  const unresolved = (resolution) => ({
    approverEmployee: null,
    approverBiometricId: "",
    approverAltIds: [],
    approverName: "",
    approverResolution: resolution,
    approvalRoute: "AUTO_STORE",
    autoForwarded: true,
    autoForwardReason: `${HUMAN_REASON[resolution] || "Approver could not be determined"} — sent directly to the Store.`,
  });

  const managerId = requester?.primaryManager?.managerId;
  if (!managerId) return unresolved("NO_MANAGER");

  if (String(managerId) === String(requester._id)) return unresolved("SELF_MANAGED");

  const manager = await Employee.findById(managerId)
    .select("firstName middleName lastName name email biometricId identityId isActive status department")
    .lean();

  if (!manager) return unresolved("MANAGER_NOT_FOUND");
  if (isInactive(manager)) return unresolved("MANAGER_INACTIVE");

  // Both ids are kept: whichever one the manager's cowork_employees doc uses
  // is the one their session will present, and we cannot tell which from here.
  const ids = [manager.biometricId, manager.identityId].filter(Boolean);
  if (!ids.length) return unresolved("MANAGER_NO_BIOMETRIC");

  return {
    approverEmployee: manager._id,
    approverBiometricId: ids[0],
    approverAltIds: [...new Set(ids)],
    approverName: buildFullName(manager) || requester?.primaryManager?.managerName || "",
    approverResolution: "RESOLVED",
    approvalRoute: "TL",
    autoForwarded: false,
    autoForwardReason: "",
  };
}

/** Every cowork id an employee could be signed in as. */
function coworkIdsOf(emp) {
  return [...new Set([emp?.biometricId, emp?.identityId].filter(Boolean))];
}

/**
 * Employees this TL manages, by Mongo _id. Used to scope the approvals queue
 * for MRFs raised before this feature existed (which have no
 * approverBiometricId stored) so nothing silently disappears.
 */
async function listManagedEmployeeIds(managerBiometricId) {
  if (!managerBiometricId) return [];
  const manager = await Employee.findOne({
    $or: [{ biometricId: managerBiometricId }, { identityId: managerBiometricId }],
  }).select("_id").lean();
  if (!manager) return [];

  const reports = await Employee.find({ "primaryManager.managerId": manager._id })
    .select("_id").lean();
  return reports.map(r => r._id);
}

module.exports = {
  resolveApprover, listManagedEmployeeIds, coworkIdsOf,
  buildFullName, isInactive, HUMAN_REASON,
};
