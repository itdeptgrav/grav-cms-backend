// services/studio/studioStorage.service.js
//
// Where GRAV Studio's files go: private objects on the company Drive
// (services/companyDrive.service.js — no "anyone with the link" permission is
// ever added), named "GRAV Studio / <style> / v<N> / <file>". Read back only
// through the authenticated routes, which check the id belongs to the style.
//
// The backing store is swappable so the routes test without Google
// (`useStorage` in tests only).

"use strict";

let impl = null;

function companyDrive() {
  // Required lazily: the Drive client reads its credentials when first used.
  const drive = require("../companyDrive.service");
  return {
    async put(buffer, { fileName, mimeType, folderPath }) {
      const r = await drive.uploadCompanyFile(buffer, { fileName, mimeType, folderPath });
      return { fileId: r.driveFileId, mimeType: r.mimeType || mimeType, size: buffer.length, name: fileName };
    },
    async stream(fileId) {
      return drive.streamCompanyFile(fileId);
    },
    async remove(fileId) {
      return drive.deleteCompanyFile(fileId);
    },
  };
}

const storage = () => impl || (impl = companyDrive());

/** Tests only: put a stand-in store behind the routes. */
function useStorage(stand_in) {
  impl = stand_in;
}

module.exports = {
  put: (...a) => storage().put(...a),
  stream: (...a) => storage().stream(...a),
  remove: (...a) => storage().remove(...a),
  useStorage,
};
