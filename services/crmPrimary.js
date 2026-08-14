// services/crmPrimary.js
//
// "Only one primary per group" for contacts (per account), sites (per account),
// and addresses (per account+type). MongoDB standalone has no multi-document
// transaction, so this is a compensating two-step: demote every other primary
// in the group, then promote the chosen one. Order matters — demote first, so
// there is never a window with two primaries; a crash between the steps leaves
// ZERO primaries (a recoverable, visible state) rather than two.

"use strict";

/**
 * Make `docId` the sole primary within `groupFilter`.
 * @param {Model} Model
 * @param {object} groupFilter  e.g. { accountId } or { accountId, addressType }
 * @param {string} docId
 * @param {string} [flag="isPrimary"]
 */
async function makeSolePrimary(Model, groupFilter, docId, flag = "isPrimary") {
  await Model.updateMany(
    { ...groupFilter, _id: { $ne: docId }, [flag]: true },
    { $set: { [flag]: false } },
  );
  await Model.updateOne({ _id: docId }, { $set: { [flag]: true } });
}

/**
 * If nothing in the group is primary yet, make `docId` primary. Used on create
 * so the first site/contact/address of a group is primary automatically.
 * @returns {Promise<boolean>} whether it was promoted
 */
async function ensureGroupHasPrimary(Model, groupFilter, docId, flag = "isPrimary") {
  const existing = await Model.exists({ ...groupFilter, [flag]: true, _id: { $ne: docId } });
  if (!existing) {
    await Model.updateOne({ _id: docId }, { $set: { [flag]: true } });
    return true;
  }
  return false;
}

module.exports = { makeSolePrimary, ensureGroupHasPrimary };
