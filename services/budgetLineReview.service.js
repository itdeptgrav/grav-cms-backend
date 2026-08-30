/**
 * services/budgetLineReview.service.js
 *
 * DECIDING A BUDGET ASK AT TWO LEVELS.
 *
 * ── THE TWO THINGS A REQUEST IS ─────────────────────────────────────────────
 * A budget request is one accounting HEAD — "Staff Welfare" — and, underneath
 * it, the WORKING ROWS a department used to build the figure:
 *
 *     Staff Welfare                                        ₹4,20,000
 *       Festival                    1 × ₹2,00,000  =       ₹2,00,000
 *       Annual day                  1 × ₹1,50,000  =       ₹1,50,000
 *       Team lunch                 12 ×    ₹5,833  =         ₹70,000
 *
 * Finance's answer has always been one number for the whole head, which is too
 * coarse for the argument they actually want to have: yes to the festival, half
 * the annual day, no to the monthly lunches. Countering at ₹3,00,000 says none
 * of that, and the department's next draft is a guess at which row was meant.
 *
 * ── WHAT THIS SERVICE IS, AND IS NOT ────────────────────────────────────────
 * Row decisions do NOT become accounting lines. The allocation stays exactly
 * what it was — ONE budget line per head, written by `syncAllocationFromRequest`
 * from `agreedAmount` and `agreedPhasingMode`. This service only DERIVES those
 * two figures from the rows, so the ledger never learns that rows exist.
 *
 * That is the whole design constraint. Rows are the argument; the head is the
 * money. Everything here is pure so both can be reasoned about without a
 * database.
 *
 * ── WHY A ROW NEEDED AN IDENTITY FIRST ──────────────────────────────────────
 * `workingLines` was declared `_id: false`, so a row had no way to be addressed
 * — you could only point at its position in the array. Position is not identity
 * here: a department revising an ask between drafts inserts and reorders rows,
 * and a decision recorded against index 2 would silently reattach itself to
 * whatever row landed there. `rowId` is assigned once, additively, and old rows
 * without one are given theirs the first time they are written.
 */

"use strict";

const variance = require("./budgetVariance.service");
const phasing = require("./budgetPhasing.service");
const working = require("./budgetWorking.service");

/** A refusal a caller can turn into a 400 with a code. */
class LineReviewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LineReviewError";
    this.code = code;
  }
}

/**
 * What finance can say about one row.
 *
 * `pending` is the absence of an answer rather than an answer, which is why it
 * is not written to the document — a row with no `decision` IS pending, and
 * every proposal that existed before this reads correctly without migration.
 */
const ROW_DECISIONS = ["approved", "countered", "refused"];

/**
 * What a head reads as, once its rows are taken together.
 *
 * Derived on every read rather than stored. A stored status is a second copy of
 * a fact the rows already carry, and the two disagree the first time a row is
 * decided by a path that forgot to update it.
 */
const HEAD_STATUS = [
  "pending_review",
  "partially_reviewed",
  "approved",
  "partially_approved",
  "countered",
  "needs_department_response",
  "refused",
];

const HEAD_STATUS_LABEL = {
  pending_review: "Pending review",
  partially_reviewed: "Partially reviewed",
  approved: "Approved",
  partially_approved: "Partially approved",
  countered: "Countered",
  needs_department_response: "Needs department response",
  refused: "Refused",
};

/** The ±1 the rest of the module allows: a split of thirds cannot land on a rupee. */
const SUM_TOLERANCE = 1;

const money = (v) => variance.money(v);

/* ── IDENTITY ─────────────────────────────────────────────────────────────── */

/**
 * A short, stable id for a row.
 *
 * Deliberately not an ObjectId: these live inside an array in a document that
 * is already large, they are never queried on their own, and a 24-character hex
 * string per row across sixty rows and hundreds of requests is weight for
 * nothing. Uniqueness only has to hold WITHIN one request's rows.
 */
function makeRowId(index, taken) {
  const base = `r${index + 1}`;
  if (!taken.has(base)) return base;
  let n = index + 2;
  while (taken.has(`r${n}`)) n += 1;
  return `r${n}`;
}

/**
 * Give every row an id, keeping the ones that already have one.
 *
 * Called before any decision is recorded, so a proposal written before row
 * review existed acquires ids the first time finance touches it rather than in
 * a migration that would have to rewrite every budget in the system.
 */
function ensureRowIds(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const taken = new Set(list.map((r) => r && r.rowId).filter(Boolean));
  return list.map((row, i) => {
    if (row && row.rowId) return row;
    const rowId = makeRowId(i, taken);
    taken.add(rowId);
    return { ...(row || {}), rowId };
  });
}

/** The row this id names, or null. */
function findRow(rows, rowId) {
  return (Array.isArray(rows) ? rows : []).find((r) => r && String(r.rowId) === String(rowId)) || null;
}

/* ── WHAT ONE ROW IS WORTH ────────────────────────────────────────────────── */

/**
 * What the department asked for on this row.
 *
 * ── DERIVED, NOT READ ───────────────────────────────────────────────────────
 * Reading the stored `amount` was how a row saved with a zero multiplier came
 * out as ₹0 on the review screen while its own calculation still said "2 events
 * × ₹2,00,000" — and, worse, rolled up as zero into the head's figure, so
 * approving would have allocated the wrong money.
 *
 * `working.rowAmount` is the one derivation the whole system uses. A stored
 * total that disagrees with its own inputs loses to the inputs, here and on
 * every screen.
 */
const askedOn = (row) => working.rowAmount(row);

/**
 * What this row contributes to the head, given finance's answer.
 *
 * A row nobody has answered contributes what was ASKED. That matters for the
 * running total a reviewer watches while deciding: a half-reviewed head should
 * read as "what it would be if I stopped here", not collapse toward zero as
 * though the undecided rows had been refused.
 */
function settledOn(row) {
  switch (String(row?.decision || "")) {
    case "approved":
      return askedOn(row);
    case "refused":
      return 0;
    case "countered":
      return money(row?.approvedAmount) ?? 0;
    default:
      return askedOn(row);
  }
}

/** Has finance answered this row at all? */
const isDecided = (row) => ROW_DECISIONS.includes(String(row?.decision || ""));

/**
 * Is this row waiting on the department?
 *
 * Only a counter is. An approval needs no reply, and a refusal is an answer the
 * department argues with in the next draft rather than one they accept here.
 */
const awaitsDepartment = (row) =>
  String(row?.decision || "") === "countered" && !row?.departmentAccepted;

/* ── WHAT THE ROWS ADD UP TO ──────────────────────────────────────────────── */

/**
 * The head's position, read off its rows.
 *
 * `financeAmount` is the number that becomes `agreedAmount` when the head is
 * approved — the sum of every row's settled value. `asked` is what the
 * department wanted. The gap between them is the variance a reviewer reads.
 */
function rollUp(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const counts = { total: list.length, pending: 0, approved: 0, countered: 0, refused: 0 };

  let asked = 0;
  let financeAmount = 0;

  for (const row of list) {
    asked += askedOn(row);
    financeAmount += settledOn(row);
    const d = String(row?.decision || "");
    if (ROW_DECISIONS.includes(d)) counts[d] += 1;
    else counts.pending += 1;
  }

  return {
    counts,
    asked: Math.round(asked * 100) / 100,
    financeAmount: Math.round(financeAmount * 100) / 100,
    variance: Math.round((financeAmount - asked) * 100) / 100,
    allDecided: list.length > 0 && counts.pending === 0,
    anyDecided: counts.pending < list.length,
    awaitingDepartment: list.filter(awaitsDepartment).length,
  };
}

/**
 * What this head reads as right now.
 *
 * ── WHY MIXED NEVER READS AS APPROVED ───────────────────────────────────────
 * The failure this ordering exists to prevent: a head with one approved row and
 * one refused row showing "Approved". The department sees the word, not the
 * rows, and finds out at the end of the year that a third of the ask was never
 * funded. `partially_approved` is a different sentence and is said instead.
 *
 * Checked most-decisive first, because a head can be several of these at once
 * and only the strongest is worth saying.
 */
function headStatus({ request, rows } = {}) {
  const state = String(request?.state || "");

  /* The whole-head answers outrank anything the rows say — a refused head is
     refused whatever its rows were mid-argument. */
  if (state === "rejected") return "refused";
  if (state === "agreed") return "approved";

  const list = Array.isArray(rows) ? rows : [];

  /* A head with no breakdown is decided at head level only, and its status is
     just its state said in this vocabulary. */
  if (!list.length) return state === "countered" ? "countered" : "pending_review";

  const up = rollUp(list);

  /* Anything countered and unanswered stops the head, whatever else is true.
     It is the only status that names whose turn it is. */
  if (up.awaitingDepartment > 0) return "needs_department_response";

  /* ── ONCE ROWS ARE DECIDED, THE ROWS ARE THE STATUS ────────────────────
     `state` stays "countered" after a row counter is raised, and it is not
     cleared when the department accepts — accepting is an answer, not a
     withdrawal of the counter. Letting the stale state win here made a head
     whose every row was settled keep reading "Countered", which tells finance
     the ball is elsewhere when it is on their desk.
     A HEAD-level counter cannot reach this branch: it clears row decisions,
     so `anyDecided` is false and the state below is the honest answer. */
  if (!up.anyDecided) return state === "countered" ? "countered" : "pending_review";

  if (up.counts.refused === list.length) return "refused";
  if (!up.allDecided) return "partially_reviewed";
  if (up.counts.approved === list.length) return "approved";
  return "partially_approved";
}

/* ── RECORDING ONE ROW'S DECISION ─────────────────────────────────────────── */

/**
 * Validate and shape one row decision. Pure — returns the fields to write.
 *
 * ── WHY A NOTE IS DEMANDED ──────────────────────────────────────────────────
 * A counter or a refusal is the half of the conversation the department has to
 * act on, and "₹70,000 → ₹0" with no sentence beside it is not something anyone
 * can revise against. An approval needs no note because the row already says
 * what was agreed.
 */
function decideRow({ row, decision, amount, financeNote, actor } = {}) {
  const kind = String(decision || "");
  if (!ROW_DECISIONS.includes(kind)) {
    throw new LineReviewError(
      "ROW_DECISION_INVALID",
      `A row is approved, countered or refused — not "${decision}".`,
    );
  }
  if (!row) {
    throw new LineReviewError("ROW_NOT_FOUND", "That row is not part of this request.");
  }

  const note = typeof financeNote === "string" ? financeNote.trim() : "";
  if (kind !== "approved" && !note) {
    throw new LineReviewError(
      "ROW_NOTE_REQUIRED",
      kind === "refused"
        ? "Say why this row is not being funded — the department has to answer it."
        : "Say why this row is being cut — a number on its own cannot be revised against.",
    );
  }

  const asked = askedOn(row);
  let approvedAmount;

  if (kind === "approved") {
    approvedAmount = asked;
  } else if (kind === "refused") {
    /* Stated rather than implied. A refused row that carried its asked amount
       would roll up into the head total as though it had been funded. */
    approvedAmount = 0;
  } else {
    const value = money(amount);
    if (value === null || value < 0) {
      throw new LineReviewError(
        "ROW_AMOUNT_INVALID",
        "A countered row needs an amount of zero or more.",
      );
    }
    /* ── A COUNTER THAT CHANGES NOTHING IS NOT A COUNTER ──────────────────
       It reads to the department as a rejection they must respond to, costs a
       draft round, and ends where it started. Approving says the same thing
       and ends the argument. */
    if (Math.abs(value - asked) <= 0.5) {
      throw new LineReviewError(
        "ROW_COUNTER_UNCHANGED",
        "That is the amount the department asked for. Approve the row instead — a counter at the same figure asks them to reply to nothing.",
      );
    }
    approvedAmount = value;
  }

  return {
    decision: kind,
    approvedAmount,
    financeNote: note || undefined,
    decidedBy: actor || undefined,
    decidedAt: new Date(),
    /* A fresh decision reopens the question, so an acceptance recorded against
       the PREVIOUS counter cannot make the new one look already answered. */
    departmentAccepted: false,
  };
}

/**
 * Apply a whole-head decision down onto the rows.
 *
 * ── APPROVE TOUCHES ONLY WHAT IS UNRESOLVED ─────────────────────────────────
 * Approving a head means "yes to the rest of it", not "undo the argument I just
 * had". A row already cut to half stays cut; a row already refused stays
 * refused. Overwriting them would make the head-level button a silent way to
 * discard every row decision on the page.
 *
 * ── REFUSE TOUCHES EVERYTHING ───────────────────────────────────────────────
 * Refusing the head refuses the head. A row left reading "approved" underneath
 * a refused head is a contradiction the department would reasonably read as a
 * promise.
 */
function applyHeadDecision({ rows, decision, financeNote, actor } = {}) {
  const kind = String(decision || "");
  const list = ensureRowIds(rows);
  const note = typeof financeNote === "string" ? financeNote.trim() : "";

  if (kind === "approved") {
    return list.map((row) =>
      isDecided(row)
        ? row
        : {
            ...row,
            decision: "approved",
            approvedAmount: askedOn(row),
            decidedBy: actor || undefined,
            decidedAt: new Date(),
          },
    );
  }

  if (kind === "refused") {
    if (!note) {
      throw new LineReviewError(
        "HEAD_NOTE_REQUIRED",
        "Say why the head is being refused — the department has to answer it.",
      );
    }
    return list.map((row) => ({
      ...row,
      decision: "refused",
      approvedAmount: 0,
      financeNote: row.financeNote || note,
      decidedBy: actor || undefined,
      decidedAt: new Date(),
      departmentAccepted: false,
    }));
  }

  throw new LineReviewError(
    "HEAD_DECISION_INVALID",
    `A head is approved or refused here — not "${decision}".`,
  );
}

/**
 * Clear every row decision, because the head has been countered as a whole.
 *
 * ── WHY A HEAD COUNTER OUTRANKS THE ROW ARGUMENT ────────────────────────────
 * The two levels can contradict each other, and this is the case where they
 * do: finance approves rows adding up to ₹4,20,000, then counters the HEAD at
 * ₹5,00,000. Both figures cannot be the standing one, and "the final head
 * amount is the sum of its resolved rows" is the invariant the department, the
 * phasing and the allocation all rely on.
 *
 * So a head counter restarts the row conversation rather than sitting beside
 * it. It is a new offer on the whole thing, which is exactly what makes the
 * previous row-by-row answers stale — and leaving a row reading "approved" at
 * a figure the head no longer proposes is a promise nobody made.
 *
 * The reason is not lost: it moves to the head's own `financeNote`, which is
 * required on a counter.
 */
function clearRowDecisions(rows) {
  return ensureRowIds(rows).map((row) => {
    if (!isDecided(row)) return row;
    const next = { ...row };
    delete next.decision;
    delete next.approvedAmount;
    delete next.financeNote;
    delete next.decidedBy;
    delete next.decidedAt;
    delete next.departmentAccepted;
    delete next.departmentRespondedAt;
    return next;
  });
}

/* ── THE SHAPE THAT MUST FOLLOW THE MONEY ─────────────────────────────────── */

/**
 * The monthly split of a head whose rows have been decided.
 *
 * ── TWO SOURCES, IN ORDER ───────────────────────────────────────────────────
 * 1 · ROWS THAT CARRY THEIR OWN MONTHS. A month-wise breakdown already says
 *     what each row costs in each month, so the head's split is the sum of the
 *     rows that survived — exact, and it cannot drift from the decisions that
 *     produced it. A countered row is scaled within its own months, because
 *     "half the annual day" is half of it wherever it fell.
 *
 * 2 · A HEAD-LEVEL SPLIT ONLY. There is nothing per-row to add up, so the
 *     department's own shape is scaled to the new total. Scaling preserves the
 *     THING THE SHAPE SAID — a festival quarter stays a festival quarter — where
 *     straight-lining a cut head would quietly move money into months the
 *     department had explicitly kept empty.
 *
 * Either way the result sums to the final amount exactly. A plan whose months
 * disagree with its own total is the one outcome that must not be reachable,
 * so the last month absorbs the rounding remainder.
 */
function phasingForDecisions({ rows, phasingMode, monthlyPhasing, finalAmount } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const target = money(finalAmount) ?? 0;

  /* Nothing to spread, so nothing to say. An even split of zero is zero. */
  if (target <= 0) return { phasingMode: "even", monthlyPhasing: [] };

  const rowsWithMonths = list.filter(
    (r) => Array.isArray(r?.monthly) && r.monthly.length && settledOn(r) > 0,
  );

  if (rowsWithMonths.length) {
    const byMonth = new Map();
    for (const row of rowsWithMonths) {
      const asked = askedOn(row);
      const settled = settledOn(row);
      /* The row's own share, kept in its own months. A row cut to 60% is 60%
         of each of its months rather than 60% taken off the last one. */
      const factor = asked > 0 ? settled / asked : 0;
      for (const m of row.monthly) {
        if (!m || !phasing.isMonthKey(m.month)) continue;
        const value = (money(m.amount) ?? 0) * factor;
        byMonth.set(m.month, (byMonth.get(m.month) || 0) + value);
      }
    }
    const rowsOut = [...byMonth.entries()]
      .filter(([, amount]) => amount > 0)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([month, amount]) => ({ month, amount: Math.round(amount * 100) / 100 }));
    if (rowsOut.length) return settleRemainder(rowsOut, target);
  }

  /* ── NO ROW MONTHS: SCALE THE HEAD'S OWN SHAPE ─────────────────────────── */
  if (String(phasingMode) === "custom_monthly" && Array.isArray(monthlyPhasing) && monthlyPhasing.length) {
    const source = monthlyPhasing.filter((m) => m && phasing.isMonthKey(m.month));
    const total = source.reduce((s, m) => s + (money(m.amount) ?? 0), 0);
    if (total > 0) {
      const scaled = source.map((m) => ({
        month: m.month,
        amount: Math.round(((money(m.amount) ?? 0) / total) * target * 100) / 100,
      }));
      return settleRemainder(scaled.filter((m) => m.amount > 0), target);
    }
  }

  return { phasingMode: "even", monthlyPhasing: [] };
}

/**
 * Force a split to sum to its total exactly, by putting the rounding
 * difference on the largest month.
 *
 * The largest rather than the last, so a rupee of rounding lands where it is
 * proportionally least visible instead of always deforming March.
 */
function settleRemainder(rows, target) {
  if (!rows.length) return { phasingMode: "even", monthlyPhasing: [] };
  const sum = rows.reduce((s, m) => s + m.amount, 0);
  const drift = Math.round((target - sum) * 100) / 100;
  if (drift !== 0) {
    let biggest = 0;
    for (let i = 1; i < rows.length; i += 1) if (rows[i].amount > rows[biggest].amount) biggest = i;
    rows[biggest] = {
      ...rows[biggest],
      amount: Math.round((rows[biggest].amount + drift) * 100) / 100,
    };
  }
  return { phasingMode: "custom_monthly", monthlyPhasing: rows.filter((m) => m.amount > 0) };
}

/* ── MAY THIS HEAD BE APPROVED YET? ───────────────────────────────────────── */

/**
 * Whether a head is in a state that can become an allocation.
 *
 * ── THE RULE THAT PROTECTS THE LEDGER ───────────────────────────────────────
 * A countered row is an open question. Turning it into an allocation before the
 * department has answered writes finance's own figure into the budget and calls
 * it agreement — which is the exact thing countering exists to avoid. So a head
 * carrying an unanswered counter cannot be approved, at either level.
 */
function readyToApprove({ request, rows } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const open = list.filter(awaitsDepartment);
  if (open.length) {
    const names = open.slice(0, 3).map((r) => r.label || "an unnamed row");
    return {
      ok: false,
      code: "ROWS_AWAITING_DEPARTMENT",
      reason:
        `${open.length} row${open.length === 1 ? "" : "s"} you countered ${open.length === 1 ? "has" : "have"} not been answered yet — ` +
        `${names.join(", ")}${open.length > names.length ? ", and others" : ""}. ` +
        `The department accepts or revises ${open.length === 1 ? "it" : "them"} before this head becomes an allocation.`,
    };
  }
  return { ok: true, code: null, reason: null };
}

/**
 * The figure a head settles at, given everything decided on it.
 *
 * The one place the two levels meet, and the reason `agree` never has to be
 * told a number: whatever finance did — nothing, a head counter, a row at a
 * time — the standing figure is derivable, so approving can go on meaning
 * "as it stands" rather than "at whatever the caller typed".
 */
function standingAmount({ request, rows } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length && rollUp(list).anyDecided) return rollUp(list).financeAmount;
  const countered = money(request?.counterAmount);
  if (countered !== null && String(request?.state || "") === "countered") return countered;
  return money(request?.requestedAmount) ?? 0;
}

module.exports = {
  LineReviewError,
  ROW_DECISIONS,
  HEAD_STATUS,
  HEAD_STATUS_LABEL,
  SUM_TOLERANCE,
  makeRowId,
  ensureRowIds,
  findRow,
  askedOn,
  settledOn,
  isDecided,
  awaitsDepartment,
  rollUp,
  headStatus,
  decideRow,
  applyHeadDecision,
  clearRowDecisions,
  phasingForDecisions,
  settleRemainder,
  readyToApprove,
  standingAmount,
};
