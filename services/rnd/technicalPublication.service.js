"use strict";

/*
 * The 3D workspace only needs a stable label for the approved R&D source it
 * was published against. NEW_CMS_BRANCH already owns that source through the
 * central technical-record service, so this adapter reads that contract
 * instead of importing the older integration branch's provenance layer.
 */
const technicalRecord = require("../centralCosting/technicalRecord.service");

const str = (value) => (value === null || value === undefined ? "" : String(value).trim());

async function approvedTechnicalPublicationFor(style) {
  const techSheet = style?.techSheet
    ? (style.techSheet.toObject ? style.techSheet.toObject() : style.techSheet)
    : null;
  if (!techSheet) return null;

  const revision = technicalRecord.approvedRevisionOf(techSheet);
  if (!revision) return null;

  return {
    technicalRevisionRef: str(revision.revisionRef) || `revision-${revision.revision}`,
    revision: revision.revision,
    submittedAt: revision.submittedAt || null,
    submittedBy: str(revision.submittedBy?.name),
    approvedAt: revision.decidedAt || techSheet.approvedAt || null,
    approvedBy: str(revision.decidedBy?.name || techSheet.approvedBy?.name),
    approvalNote: str(revision.decisionNote),
    file: revision.file || revision.snapshot?.file || techSheet.file || null,
    snapshot: revision.snapshot || null,
  };
}

async function approvedTechnicalPublicationForStyleId(styleId) {
  const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
  const style = await SampleStyle.findById(styleId).select("techSheet").lean().catch(() => null);
  if (!style) return null;
  return approvedTechnicalPublicationFor({ _id: styleId, ...style });
}

module.exports = {
  approvedTechnicalPublicationFor,
  approvedTechnicalPublicationForStyleId,
};
