"use strict";
// services/merchandising/styleRecord.service.js
//
// REACHING THE SHARED STYLE RECORD, FROM MERCHANDISING'S SIDE.
//
// `SampleStyle` is one record with several owners: Sales raises it, R&D builds
// the technical half, Merchandising chooses the materials and the packaging.
// Merchandising's endpoints used to live on the Sales style router and used
// that router's private helpers to find and annotate a style. When those
// endpoints moved to a Merchandising router, the helpers had to come with
// them — or the move would have swapped a route dependency for an import
// dependency, which is the same dependency wearing a hat.
//
// So the three are here. They are RECORD ACCESS, not business rules: finding a
// style by either of its two references, and appending to its history. The
// rules about what Merchandising may then do live in `access.service.js` and in
// the packaging and development services, exactly as before.
//
// The Sales router keeps its own copies, untouched. They are four lines each
// and are that router's business; consolidating them would mean editing a file
// another lane is actively rewriting, to save duplication a reader of either
// file can see through.

const mongoose = require("mongoose");

const SampleStyle = () => require("../../models/CMS_Models/Sales/SampleStyle");

const isObjectId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));

/** Who is acting, as the history records it. Never a role or a grant. */
const actorOf = (req) => ({ id: req.user?.id, name: req.user?.name || "" });

/**
 * A style by either of its references.
 *
 * `_id` and `sampleStyleId` are both in use — the second is the business
 * reference people quote. An id-shaped value tries both, because a business
 * reference is not guaranteed to be un-id-shaped forever.
 */
async function resolveStyle(idOrRef) {
  const query = isObjectId(idOrRef)
    ? { $or: [{ _id: idOrRef }, { sampleStyleId: idOrRef }] }
    : { sampleStyleId: idOrRef };
  return SampleStyle().findOne({ ...query, isActive: true });
}

/** Append one event to a style's history, stamped with who and when. */
const logHistory = (style, ev, req) => {
  if (!Array.isArray(style.history)) style.history = [];
  style.history.push({ ...ev, by: actorOf(req), at: new Date() });
};

module.exports = { resolveStyle, logHistory, actorOf, isObjectId };
