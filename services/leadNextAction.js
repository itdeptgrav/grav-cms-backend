// services/leadNextAction.js
//
// Which of a Lead's open items is its NEXT ACTION, and what its
// `nextFollowUpAt` should therefore be.
//
// ── THE RULE, AND THE ONE IT REPLACES ───────────────────────────────────────
// A Lead has ONE headline next action. That is a DERIVATION, not a storage
// limit — and the difference is the whole point of this file.
//
// It used to be storage: `PATCH /leads/:id/next-action` kept the earliest open
// follow-up and CANCELLED every other one. So a salesperson who planned "call
// Monday" and then planned "email the quotation" silently lost the call, and
// was told "Next action set." Real work on a lead branches — chase the PO, get
// their compliance certificate, book the sample courier — and none of those is
// a replacement for the others.
//
// Now the Lead may hold as many open items as the work actually has. Exactly
// one of them is the canonical next action, computed here, and that is what
// drives the Leads page's urgency bands. Nothing is destroyed to keep the
// headline single.
//
// ── WHY ONLY FOLLOW-UPS MOVE THE DATE ───────────────────────────────────────
// `nextFollowUpAt` answers "when do we next TOUCH this customer", which is what
// the Leads page bands on. A `task` ("prepare the costing sheet") is internal
// work on the lead, not a touch — it belongs on the lead and in My work, but
// letting it redefine the follow-up date would quietly change what the bands
// mean. Only `follow_up` counts.

/** Open = still planned and not archived. Anything else is history. */
const isOpen = (a) => Boolean(a) && a.status === "planned" && a.isActive !== false;

const isFollowUp = (a) => a?.activityType === "follow_up";

// The null check is load-bearing, not defensive: `new Date(null)` is epoch 0,
// a perfectly finite number, so an UNDATED item would sort ahead of every real
// date and become the lead's next action — due 1 Jan 1970.
const time = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
};

/**
 * Earliest-due first, ties broken by creation order — the same ordering the
 * route's `.sort({ dueDate: 1, createdAt: 1 })` produced, kept here so the
 * choice is testable without a database and cannot drift between callers.
 */
function byDueThenCreated(a, b) {
  const da = time(a.dueDate), db = time(b.dueDate);
  // A dated item always outranks an undated one: an item with no date cannot
  // be "the next thing", but it must not be dropped either.
  if (da === null && db === null) return (time(a.createdAt) ?? 0) - (time(b.createdAt) ?? 0);
  if (da === null) return 1;
  if (db === null) return -1;
  if (da !== db) return da - db;
  return (time(a.createdAt) ?? 0) - (time(b.createdAt) ?? 0);
}

/** Every open item on the lead, in the order it should be worked. */
const openItems = (activities = []) => (activities || []).filter(isOpen).sort(byDueThenCreated);

/**
 * The Lead's single headline next action: the earliest-due open FOLLOW-UP.
 * Null when the lead has none — a lead can legitimately be holding only
 * internal tasks, or nothing at all.
 */
function canonicalNextAction(activities = []) {
  return openItems(activities).filter(isFollowUp).find((a) => time(a.dueDate) !== null) || null;
}

/**
 * What `nextFollowUpAt` should be set to, given everything currently open.
 * Returns a Date, or null meaning "clear it" — an undated or absent follow-up
 * must not leave a stale date behind claiming the customer is due.
 */
function nextFollowUpAt(activities = []) {
  const c = canonicalNextAction(activities);
  return c ? new Date(c.dueDate) : null;
}

/**
 * The open items that are NOT the headline — shown under it on the Lead rather
 * than cancelled. Includes internal tasks and any further follow-ups.
 */
function secondaryOpenItems(activities = []) {
  const c = canonicalNextAction(activities);
  return openItems(activities).filter((a) => !c || String(a._id) !== String(c._id));
}

module.exports = { canonicalNextAction, nextFollowUpAt, secondaryOpenItems, openItems };
