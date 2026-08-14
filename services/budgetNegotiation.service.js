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
/* Firestore is reached lazily. At module scope it demands credentials and a
   live connection from anything that imports this file — including a test of
   the turn rules, which are pure and are the part most worth pinning. */
function firestore() {
  return require("../config/firebaseAdmin").db;
}
const {
  addWorkingSecsIST,
  readOfficeCalendar,
  readMs,
  resolveAcceptanceAnchor,
} = require("./officeDeadline.service");
const { resolvePrimaryManagerApprover } = require("./primaryManager.service");

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
  const assignee = (task.assigneeIds || [])[0] || null;
  // A SELF task reverses the opening: the CREATOR (the assignee) proposed the
  // budget when they made the task, and it is their MANAGER (the assigner of
  // record, `assignedBy`) who approves or negotiates it — not the other way
  // round. Without this the self-task opening read as "the manager proposed and
  // you accept", when the manager has not even seen it yet.
  const isSelf = task.isSelfAssigned === true || task.isSelfAssigned === "true";
  return {
    state:
      opening > 0
        ? isSelf
          ? WAITING_FOR_ASSIGNOR
          : WAITING_FOR_ASSIGNEE
        : null,
    currentSecs: opening,
    proposedBy: isSelf ? assignee : task.assignedBy || null,
    // The manager's name is stored (`assignedByName`); the assignee's is
    // resolved on the client from the directory, so an empty string is right.
    proposedByName: isSelf ? "" : task.assignedByName || "",
    waitingFor: isSelf ? task.assignedBy || null : assignee,
    waitingForName: isSelf ? task.assignedByName || "" : "",
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
 * Who decides how many hours this employee gets.
 *
 * **Their manager, not whoever sent the work.** Asking for more hours is a
 * management decision about a person, so it follows the reporting line — the
 * same rule the set-hours path already applies (`taskForward.js`: "the time
 * budget belongs to whoever MANAGES the person doing the work"), and the same
 * one the budget-extension records already use. This loop was the last place
 * still routing it to the sender, so an assignee asking for more time put the
 * question to somebody in another department who does not manage them.
 *
 * Falls back to the assignor where HR records no manager, or the manager has no
 * CoWork account. A `null` here would leave the negotiation waiting on nobody,
 * which no move could ever clear.
 */
async function budgetApproverOf(task) {
  const { assignor, assignee } = partiesOf(task);
  if (!assignee) return { id: assignor, viaManager: false };
  const mgr = await resolvePrimaryManagerApprover(assignee);
  return mgr?.approverId
    ? { id: String(mgr.approverId), viaManager: true }
    : { id: assignor, viaManager: false };
}

/**
 * May this person move, and what does moving mean for whose turn it is next?
 *
 * Returns the party's role rather than a boolean, because the next state
 * depends on WHICH side acted — an assignee's counter waits on the decider and
 * vice versa.
 *
 * `approverId` is the assignee's manager, resolved by the caller before the
 * transaction opens. **Without admitting them here they would be refused as
 * NOT_A_PARTY on the very turn just handed to them** — the deadlock this
 * parameter exists to prevent. Checked last so that somebody who is also the
 * assignee or the assignor keeps that stronger role.
 */
function roleOf(task, employeeId, approverId = null) {
  const { assignor, assignee } = partiesOf(task);
  const me = String(employeeId);
  if (assignee && String(assignee) === me) return "assignee";
  if (assignor && String(assignor) === me) return "assignor";
  if (approverId && String(approverId) === me) return "approver";
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

/**
 * Resolve the approver BEFORE a transaction opens.
 *
 * The lookup crosses to HR in Mongo and back into Firestore, and neither belongs
 * inside a transaction: a transaction must finish its reads before its first
 * write, and it may be retried, which would repeat both round trips each time.
 *
 * Answers with the assignee it was resolved FOR, so the transaction can notice
 * the task being reassigned underneath it rather than hand the decision to the
 * previous assignee's manager.
 */
async function approverPreread(ref) {
  const snap = await ref.get();
  if (!snap.exists) throw new BudgetError("NOT_FOUND", "Task not found.");
  const task = snap.data();
  const approver = await budgetApproverOf(task);
  return {
    resolvedForAssignee: partiesOf(task).assignee,
    approverId: approver.id,
  };
}

/** The pre-read approver, discarded if the task changed hands since. */
function approverIn(pre, task) {
  const { assignee, assignor } = partiesOf(task);
  return String(assignee || "") === String(pre.resolvedForAssignee || "")
    ? pre.approverId
    : assignor;
}

const NOT_A_PARTY_MESSAGE =
  "Only the person who set this work, the person doing it, or the manager who decides their hours can negotiate its budget.";

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
  const ref = firestore().collection("cowork_tasks").doc(String(taskId));
  const pre = await approverPreread(ref);

  return firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new BudgetError("NOT_FOUND", "Task not found.");
    const task = snap.data();

    const approverId = approverIn(pre, task);

    const role = roleOf(task, employeeId, approverId);
    if (!role) {
      throw new BudgetError("NOT_A_PARTY", NOT_A_PARTY_MESSAGE);
    }

    const negotiation = currentNegotiation(task);
    assertTurn(negotiation, employeeId);

    const secs = readSeconds(proposedSecs);
    const { assignee } = partiesOf(task);
    /**
     * The turn passes to the OTHER side, and on this side that is the manager.
     *
     * An assignee asking for more hours is asking their MANAGER, not whoever
     * sent the work. This used to pass to `assignor`, so a cross-department
     * request landed with somebody in another department who does not manage
     * them and has no standing to decide their hours.
     *
     * `approverId` already falls back to the assignor where no manager can be
     * resolved, so this never waits on nobody.
     */
    const waitingFor = role === "assignee" ? approverId : assignee;
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
  const ref = firestore().collection("cowork_tasks").doc(String(taskId));

  /* Read before the transaction opens. A transaction must finish its reads
     before its first write, and the office calendar is not part of the
     contended state — nothing here races with a change to office hours. */
  const calendar = await readOfficeCalendar();
  /* The manager who decides this assignee's hours is a party to the agreement,
     so acceptance has to admit them too — otherwise the turn handed to them by
     a counter is one they would be refused on. */
  const pre = await approverPreread(ref);
  /* The clock's start, resolved out here for the same reason as the calendar:
     it reads the assignee's duty document, and a transaction must finish its
     reads before its first write. Keyed to the assignee it was resolved for so
     a reassignment between this read and the write is noticed, not inherited. */
  const preSnap = await ref.get();
  const preAnchor = preSnap.exists
    ? {
        forAssignee: partiesOf(preSnap.data()).assignee,
        ...(await resolveAcceptanceAnchor(preSnap.data())),
      }
    : null;

  return firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new BudgetError("NOT_FOUND", "Task not found.");
    const task = snap.data();

    if (!roleOf(task, employeeId, approverIn(pre, task))) {
      throw new BudgetError("NOT_A_PARTY", NOT_A_PARTY_MESSAGE);
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

    /**
     * **The deadline is re-derived here, not left where it was.**
     *
     * Accepting settled how long the work is worth, and nothing recomputed the
     * date from it — so a task whose budget was negotiated from one hour to two
     * kept a deadline that reflected neither figure.
     *
     * The ANCHOR does not move. It stays the moment the assignee's manager
     * granted the hours, because a round of counters can take minutes and
     * charging the negotiation to the assignee's window would shorten the time
     * they were given by exactly how long the two sides took to agree. Only the
     * DURATION changes when the budget does.
     *
     * No recorded grant means this is a NORMAL task, and there the owner's
     * rule is: the clock starts when the assignee first came online at or
     * after the task was given — never at acceptance, which rewarded sitting
     * on a task with a later deadline (see `acceptanceAnchorMs`). The
     * pre-read is trusted only if the task still belongs to the assignee it
     * was resolved for; otherwise the acceptance moment is the honest floor.
     */
    const grantMs =
      readMs(task.tlHoursSetAtMs) ?? readMs(task.tlHoursSetAt);
    const normalAnchor =
      preAnchor &&
      String(partiesOf(task).assignee || "") ===
        String(preAnchor.forAssignee || "")
        ? preAnchor
        : { anchorMs: Date.now(), source: "acceptance" };
    const anchorMs = grantMs ?? normalAnchor.anchorMs;
    const anchorSource = grantMs ? "hours_granted" : normalAnchor.source;
    const dueDate = addWorkingSecsIST(
      anchorMs,
      secs,
      calendar.schedule,
      calendar.breaks,
    );

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
      /* And in the fields that mean AGREED rather than merely offered. Writing
         only `senderTimerWindowSecs` left `deadlineWindowSecs` null, so
         `resolveTimeBudget` fell through to the assignor's opening offer and
         reported a settled budget as still proposed. */
      deadlineWindowSecs: secs,
      originalWindowSecs: Number(task.originalWindowSecs) || secs,
      /* Scoring weights every task by this — `Σ(taskScore × etcHours)` — and it
         was left at whatever the FIRST grant wrote. A task negotiated from one
         hour to two went on being scored at half its true size. */
      etcHours: secs / 3600,
      dueDate,
      /* The clock's start, stamped ONCE and kept. Presence history does not
         exist, so an anchor recomputed later would silently move with the
         assignee's next session — a deadline must be re-derivable from the
         record that set it. `source` names which branch of the rule fired. */
      clockStartsAtMs: anchorMs,
      clockStartsAtSource: anchorSource,
      /* A leftover `fixedDeadline` from the sender's create outranks `dueDate`
         in the read precedence, so leaving it would discard everything above. */
      fixedDeadline: null,
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
  budgetApproverOf,
  partiesOf,
  readSeconds,
  WAITING_FOR_ASSIGNEE,
  WAITING_FOR_ASSIGNOR,
  ACCEPTED,
};
