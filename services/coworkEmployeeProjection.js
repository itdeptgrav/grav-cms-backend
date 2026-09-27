// services/coworkEmployeeProjection.js
//
// THE ONE SHAPE A CoWork EMPLOYEE HAS WHEN IT IS SHOWN TO SOMEBODY ELSE.
//
// SEC-1 (25 Sep 2026): the directory and member-list responses used to return
// the whole `cowork_employees` document minus a hand-maintained denylist
// (`tempPassword`, sometimes `authUid` and `fcmTokens`). A denylist fails open:
// the Gmail connect flow later stored `gmailToken.refresh_token` on the same
// document, and nobody added it to the list, so a Google refresh token rode
// along in every directory read.
//
// This is an ALLOWLIST. A field reaches another person only if it is named
// below, so a field added to the document tomorrow is private by default.
// The fields are the ones the directory consumers actually read (the CMS
// CoWork pages and the CoWork app's lib/legacy/employees.ts): identity, contact,
// department, operational role, avatar and the first-sign-in status.
//
// Deliberately NOT here, whatever they are called: gmailToken, any OAuth
// token, tempPassword or any password / reset field, authUid, custom claims,
// fcmTokens or any push token, session or API tokens, configuration. The
// authenticated self `/me` response is a different contract and does not use
// this.
"use strict";

const STRING_FIELDS = ["employeeId", "name", "email", "mobile", "city", "department", "role", "profilePicUrl"];

/** @param {object|null} doc  `{ id, ...firestoreData }` or a raw data object */
function toDirectoryEmployee(doc) {
  if (!doc || typeof doc !== "object") return null;
  const out = {};
  if (doc.id !== undefined && doc.id !== null) out.id = String(doc.id);
  for (const key of STRING_FIELDS) {
    const value = doc[key];
    if (typeof value === "string") out[key] = value;
    else if (value === null && key === "profilePicUrl") out[key] = null;
  }
  // Safe status fields: booleans / short strings only, never objects.
  if (typeof doc.passwordChanged === "boolean") out.passwordChanged = doc.passwordChanged;
  if (typeof doc.isActive === "boolean") out.isActive = doc.isActive;
  if (typeof doc.status === "string") out.status = doc.status;
  return out;
}

/** Firestore snapshot doc → directory entry. */
function directoryEntryFromSnapshot(snapDoc) {
  if (!snapDoc) return null;
  return toDirectoryEmployee({ id: snapDoc.id, ...(snapDoc.data ? snapDoc.data() : {}) });
}

module.exports = {
  toDirectoryEmployee,
  directoryEntryFromSnapshot,
  DIRECTORY_FIELDS: Object.freeze(["id", ...STRING_FIELDS, "passwordChanged", "isActive", "status"]),
};
