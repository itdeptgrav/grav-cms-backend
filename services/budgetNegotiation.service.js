/**
 * GRAV-CMS-BACKEND/services/budgetNegotiation.service.js
 *
 * The time-budget negotiation loop.
 *
 * **Why this exists beside `proposeDeadline` rather than inside it.** That
 * function is one-directional by construction: it refuses anyone who is not an
 * assignee, and its arithmetic treats every proposal as the assignee asking for
 * an extension against a deadline the assignor owns. Widening it would have
 * meant changing what it means for the extension flow that also uses it, on a
 * task that may already be in progress. This owns one question — what is the
 * budget, and whose turn is it — and hands the settled figure back to the
 * existing deadline machinery once both sides agree.
 *
 * **There is no reject.** A refusal that ends the negotiation leaves the work
 * with a budget one side never accepted, which is the state the loop exists to
 * make impossible. The only two moves are ACCEPT and COUNTER, and the only exit
 * is agreement.
 *
 * The turn is the whole permission model: whoever the record says is waited on
 * may act, and nobody else. That makes "you cannot approve your own proposal"
 * a consequence of the state rather than a separate rule that could disagree
 * with it.
 */

const admin = require("firebase-admin");
const { db } = require("../config/firebaseAdmin");

const WAITING_FOR_ASSIGNEE = "WAITING_FOR_ASSIGNEE";
const WAITING_FOR_ASSIGNOR = "WAITING_FOR_ASSIGNOR";
const ACCEPTED = "ACCEPTED";

/** An outcome a caller can branch on, rather than prose. */
class BudgetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BudgetError";
    this.code = code;
  }
}

/** Seconds, sane and bounded. Rejects the shapes a client can send by mistake. */
function readSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new BudgetError("INVALID_BUDGET", "Enter a number of hours above zero.");
  }
  /* A year of working time is not a budget; it is a typo or an attack on the
     deadline arithmetic downstream. */
  if (n > 2000 * 3600) {
    throw new BudgetError("INVALID_BUDGET", "That budget is implausibly large.");
  }
  return Math.round(n);
}

/**
 * The negotiation as it stands, derived for a task that has never had one.
 *
 * A task created with a sender window is ALREADY mid-negotiation — the assignor
 * has proposed and the assignee has not answered — so the absent case is that
 * opening state rather than "nothing happening". Reading it this way means
 * existing tasks join the loop without a migration.
 */
function currentNegotiation(task) {
  if (task.budgetNegotiation && task.budgetNegotiation.state) {
    return task.budgetNegotiation;
  }
  const opening = Number(task.senderTimerWindowSecs) || 0;
  return {
    state: opening > 0 ? WAITING_FOR_ASSIGNEE : null,
    currentSecs: opening,
    proposedBy: task.assignedBy || null,
    proposedByName: task.assignedByName || "",
    waitingFor: (task.assigneeIds || [])[0] || null,
    round: opening > 0 ? 1 : 0,
    history: [],
  };
}

/** Who the two sides are. The assignor is the creator; legacy stores no other. */
function partiesOf(task) {
  return {
    assignor: task.assignedBy || null,
    assignee: (task.assigneeIds || [])[0] || null,
  };
}

/**
 * May this person move, and what does moving mean for whose turn it is next?
 *
 * Returns the party's role rather than a boolean, because the next state
 * depends on WHICH side acted — an assignee's counter waits on the assignor and
 * vice versa.
 */
function roleOf(task, employeeId) {
  const { assignor, assignee } = partiesOf(task);
  const me = String(employeeId);
  if (assignee && String(assignee) === me) return "assignee";
  if (assignor && String(assignor) === me) return "assignor";
  return null;
}

function assertTurn(negotiation, employeeId) {
  if (negotiation.state === ACCEPTED) {
    throw new BudgetError(
      "ALREADY_SETTLED",
      "This budget has already been agreed.",
    );
  }
  if (!negotiation.state) {
    throw new BudgetError(
      "NO_NEGOTIATION",
      "This task has no time budget to negotiate.",
    );
  }
  if (String(negotiation.waitingFor || "") !== String(employeeId)) {
    /* The single check that also delivers "you cannot approve your own
       proposal": after proposing you are never the one waited on. */
    throw new BudgetError(
      "NOT_YOUR_TURN",
      "It is not your turn — the other side is deciding.",
    );
  }
}

function historyEntry(input) {
  return {
    roundNumber: input.round,
    previousBudgetSeconds: input.previousSecs,
    proposedBudgetSeconds: input.proposedSecs,
    proposedBy: input.proposedBy,
    proposedByName: input.proposedByName || "",
    waitingFor: input.waitingFor,
    reason: (input.reason || "").trim(),
    /* Stored as an instant. Every reader renders IST from it, rather than each
       writer deciding a format — see the frontend's single formatter. */
    createdAt: new Date().toISOString(),
    decision: input.decision || null,
    decidedBy: input.decidedBy || null,
  };
}

/**
 * Counter with a different figure. Available to whichever side is waited on.
 *
 * This is the move that makes it a loop: an assignor countering is the same
 * act as an assignee countering, and neither ends anything.
 */
async function counterBudgetProposal({
  taskId,
  employeeId,
  employeeName,
  proposedSecs,
  reason,
}) {
  const ref = db.collection("cowork_tasks").doc(String(taskId));

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new BudgetError("NOT_FOUND", "Task not found.");
    const task = snap.data();

    const role = roleOf(task, employeeId);
    if (!role) {
      throw new BudgetError(
        "NOT_A_PARTY",
        "Only the person who set this work or the person doing it can negotiate its budget.",
      );
    }

    const negotiation = currentNegotiation(task);
    assertTurn(negotiation, employeeId);

    const secs = readSeconds(proposedSecs);
    const { assignor, assignee } = partiesOf(task);
    /* The turn passes to the OTHER side. That is the whole loop. */
    const waitingFor = role === "assignee" ? assignor : assignee;
    const round = (Number(negotiation.round) || 0) + 1;

    const entry = historyEntry({
      round,
      previousSecs: Number(negotiation.currentSecs) || 0,
      proposedSecs: secs,
      proposedBy: String(employeeId),
      proposedByName: employeeName,
      waitingFor: waitingFor ? String(waitingFor) : null,
      reason,
      decision: "countered",
      decidedBy: String(employeeId),
    });

    tx.update(ref, {
      budgetNegotiation: {
        state:
          role === "assignee" ? WAITING_FOR_ASSIGNOR : WAITING_FOR_ASSIGNEE,
        currentSecs: secs,
        proposedBy: String(employeeId),
        proposedByName: employeeName || "",
        waitingFor: waitingFor ? String(waitingFor) : null,
        round,
        history: [...(negotiation.history || []), entry],
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      state: role === "assignee" ? WAITING_FOR_ASSIGNOR : WAITING_FOR_ASSIGNEE,
      currentSecs: secs,
      waitingFor,
      round,
    };
  });
}

/**
 * Accept what is on the table. Only the side being waited on may.
 *
 * The settled figure becomes `senderTimerWindowSecs`, which is the field the
 * rest of the product already treats as the agreed budget — so acceptance hands
 * back to the existing deadline machinery instead of introducing a second
 * source of truth for how long the work is worth.
 */
async function acceptBudgetProposal({ taskId, employeeId, employeeName }) {
  const ref = db.collection("cowork_tasks").doc(String(taskId));

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new BudgetError("NOT_FOUND", "Task not found.");
    const task = snap.data();

    if (!roleOf(task, employeeId)) {
      throw new BudgetError(
        "NOT_A_PARTY",
        "Only the person who set this work or the person doing it can agree its budget.",
      );
    }

    const negotiation = currentNegotiation(task);
    assertTurn(negotiation, employeeId);

    const secs = Number(negotiation.currentSecs) || 0;
    if (secs <= 0) {
      throw new BudgetError("INVALID_BUDGET", "There is no budget to accept.");
    }

    const entry = historyEntry({
      round: Number(negotiation.round) || 1,
      previousSecs: secs,
      proposedSecs: secs,
      proposedBy: negotiation.proposedBy || null,
      proposedByName: negotiation.proposedByName || "",
      waitingFor: null,
      reason: "",
      decision: "accepted",
      decidedBy: String(employeeId),
    });

    tx.update(ref, {
      budgetNegotiation: {
        state: ACCEPTED,
        currentSecs: secs,
        proposedBy: negotiation.proposedBy || null,
        proposedByName: negotiation.proposedByName || "",
        waitingFor: null,
        round: Number(negotiation.round) || 1,
        history: [...(negotiation.history || []), entry],
      },
      /* The agreed figure, in the field the rest of the product reads. */
      senderTimerWindowSecs: secs,
      senderTimerApprovedBy: String(employeeId),
      senderTimerApprovedByName: employeeName || "",
      senderTimerApprovedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { state: ACCEPTED, currentSecs: secs, waitingFor: null };
  });
}

module.exports = {
  BudgetError,
  counterBudgetProposal,
  acceptBudgetProposal,
  currentNegotiation,
  roleOf,
  readSeconds,
  WAITING_FOR_ASSIGNEE,
  WAITING_FOR_ASSIGNOR,
  ACCEPTED,
};
