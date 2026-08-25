// services/requestId.js
//
// Mint the next REQ-YYYY-NNNN.
//
// ── WHY THIS IS NOT `countDocuments() + 1` ──────────────────────────────────
// Four routes independently built the id as
// `REQ-${year}-${(await CustomerRequest.countDocuments()) + 1}`, and
// `requestId` carries no unique index, so nothing caught the result: three ids
// in the live database belong to two orders each (REQ-2026-0003, -0007, -0010).
//
// A count is not a sequence. Delete one order and the count drops, so the next
// order re-mints an id that already exists; create two at once and both see the
// same count. On an order reference that people quote at each other — and that
// a person-level "did we bill Ramesh?" query has to resolve to ONE order — that
// is not cosmetic.
//
// This reads the highest suffix actually in use for the year and goes one past
// it, so deletions cannot rewind it. Still not safe against two truly
// simultaneous creates; the real fix for that is a unique index plus retry,
// which cannot be added until the three existing duplicates are resolved (a
// business call — two real orders currently share a reference).

const PATTERN = /^REQ-(\d{4})-(\d+)$/;

/**
 * @param {import("mongoose").Model} CustomerRequest
 * @param {number} [year]
 * @returns {Promise<string>} e.g. "REQ-2026-0025"
 */
async function nextRequestId(CustomerRequest, year = new Date().getFullYear()) {
  const prefix = `REQ-${year}-`;
  // Lexical sort is safe here only because the suffix is zero-padded to a fixed
  // width; parse anyway rather than trusting that, since older rows predate the
  // padding and a 5-digit year would break the assumption silently.
  const rows = await CustomerRequest.find(
    { requestId: { $regex: `^${prefix}` } },
    { requestId: 1, _id: 0 },
  ).lean();

  let highest = 0;
  for (const r of rows) {
    const m = PATTERN.exec(r.requestId || "");
    // Re-check the year rather than trusting the query filter alone. The
    // captured year is right there, and a caller that passes an unfiltered list
    // would otherwise inherit last year's highest number.
    if (!m || Number(m[1]) !== Number(year)) continue;
    const n = Number(m[2]);
    if (Number.isFinite(n) && n > highest) highest = n;
  }
  return `${prefix}${String(highest + 1).padStart(4, "0")}`;
}

module.exports = { nextRequestId };
