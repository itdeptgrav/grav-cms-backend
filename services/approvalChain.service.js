/**
 * services/approvalChain.service.js
 *
 * WHO HAS TO AGREE, INSIDE ONE DEPARTMENT.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 * A request walks UP the reporting line from the person who raised it, and
 * stops at the edge of their department:
 *
 *     Soumya (IT) → Pramod (IT) → Rakesh (IT) ─╫─ CEO (not IT)
 *
 * Rakesh is the highest person IN IT, so the chain ends with him. The CEO is
 * his manager and is not in IT, so the CEO is never asked — and Rakesh's OWN
 * request has nobody above him inside the department, so it skips approval
 * entirely and goes straight to Store.
 *
 * ── WHY THE DEPARTMENT BOUND, AND NOT A LEVEL COUNT ─────────────────────────
 * Because "how many approvals" is not a fact about the company; "who runs this
 * department" is. A fixed two-step chain would ask a CEO to sign off on a box
 * of blades in a flat team and would stop halfway up a deep one. The reporting
 * line already encodes the answer — it just has to be read to the department's
 * edge and no further.
 *
 * ── WHY IT IS FROZEN ONTO THE REQUEST ───────────────────────────────────────
 * This builds the chain ONCE, when the request is raised, and the route writes
 * it down. HR reorganises; a request in flight must not be re-routed underneath
 * the people already looking at it, and an approval is a record of who was
 * actually asked. Re-deriving the chain at decision time would make that record
 * a function of today's org chart — the same mistake single-approver routing
 * made before `tlRouting.service` froze it.
 *
 * ── PURE WALK, INJECTED LOOKUPS ─────────────────────────────────────────────
 * The walk takes a `load(id)` function rather than reaching for the Employee
 * model, so every stop condition — a loop, a missing record, a manager in
 * another department — can be tested as the arithmetic it is, with no database
 * and no fixtures.
 */

"use strict";

const { slugify } = require("./budgetDepartment.service");

/** How far up one department can plausibly go before something is wrong. */
const MAX_DEPTH = 12;

/* Why a chain ended where it did. Recorded on the request, because "nobody
   approved this" and "there was nobody to ask" look identical afterwards and
   are completely different facts. */
const STOP = {
  TOP_OF_DEPARTMENT: "top_of_department",
  NO_MANAGER: "no_manager",
  OUTSIDE_DEPARTMENT: "outside_department",
  MANAGER_NOT_FOUND: "manager_not_found",
  MANAGER_INACTIVE: "manager_inactive",
  MANAGER_NO_LOGIN: "manager_no_login",
  LOOP: "loop",
  MAX_DEPTH: "max_depth",
};

const STOP_REASON = {
  [STOP.TOP_OF_DEPARTMENT]: "Reached the most senior person in the department.",
  [STOP.NO_MANAGER]: "No Primary Manager is assigned in HR.",
  [STOP.OUTSIDE_DEPARTMENT]: "The next manager is in another department, so the chain ends here.",
  [STOP.MANAGER_NOT_FOUND]: "A manager's HR record could not be found.",
  [STOP.MANAGER_INACTIVE]: "A manager's account is inactive.",
  [STOP.MANAGER_NO_LOGIN]: "A manager has no login id and could not be routed to.",
  [STOP.LOOP]: "The reporting line loops back on itself in HR.",
  [STOP.MAX_DEPTH]: "The reporting line is longer than this department should be.",
};

/** Per-approver state. Absent is not a state — every step carries one. */
const STEP_STATUSES = ["pending", "approved", "rejected"];

function fullName(emp) {
  if (!emp) return "";
  return (
    [emp.firstName, emp.middleName, emp.lastName].filter(Boolean).join(" ").trim() ||
    emp.name ||
    emp.email ||
    ""
  );
}

/**
 * Mirrors the rejection rules the CoWork login applies — somebody the login
 * would refuse must not be handed an approval step.
 */
function isInactive(emp) {
  if (!emp) return true;
  if (emp.isActive === false) return true;
  const s = String(emp.status || "").toLowerCase();
  return s === "inactive" || s === "suspended";
}

/** Every id a person could be signed in as. */
function loginIdsOf(emp) {
  return [...new Set([emp?.biometricId, emp?.identityId].filter(Boolean).map(String))];
}

/**
 * Are these two people in the same department?
 *
 * `departmentId` wins when BOTH carry one — it is a reference and cannot be
 * spelled two ways. The free-text `department` is the fallback, slugified with
 * the same function the budget module uses, so "R&D", "R and D" and "r-and-d"
 * are one department rather than three.
 *
 * Two people with NO department between them are deliberately NOT "the same
 * department": an unset field is missing data, and treating two blanks as a
 * match would walk a chain through everyone HR has not filled in yet.
 */
function sameDepartment(a, b) {
  if (a?.departmentId && b?.departmentId) {
    return String(a.departmentId) === String(b.departmentId);
  }
  const sa = slugify(a?.department);
  const sb = slugify(b?.department);
  if (!sa || !sb) return false;
  return sa === sb;
}

/**
 * Build the approval chain for one requester.
 *
 * @param {object}   requester  the Employee raising it
 * @param {function} load       `async (id) => Employee|null`
 * @returns {Promise<{chain: object[], stop: string, stopReason: string, department: string}>}
 *
 * `chain` is ordered immediate senior first: `[Pramod, Rakesh]`. Empty means
 * the requester is the most senior person in their department — which is an
 * answer, not a failure, and the caller sends the request straight on.
 */
async function buildChain({ requester, load } = {}) {
  const department = requester?.department || "";
  const chain = [];

  if (!requester) {
    return { chain, stop: STOP.MANAGER_NOT_FOUND, stopReason: STOP_REASON[STOP.MANAGER_NOT_FOUND], department };
  }

  /* Everyone already on the path, so a reporting line that loops is caught
     rather than walked forever. The requester counts: a person listed as their
     own manager is a loop of length one. */
  const seen = new Set([String(requester._id)]);
  let current = requester;
  let stop = STOP.TOP_OF_DEPARTMENT;

  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const managerId = current?.primaryManager?.managerId;
    if (!managerId) {
      /* No manager at all. At depth 0 that means HR named nobody; deeper it
         means we walked to the top of the tree, which is the ordinary end. */
      stop = depth === 0 ? STOP.NO_MANAGER : STOP.TOP_OF_DEPARTMENT;
      break;
    }
    if (seen.has(String(managerId))) {
      stop = STOP.LOOP;
      break;
    }

    const manager = await load(managerId);
    if (!manager) {
      stop = STOP.MANAGER_NOT_FOUND;
      break;
    }

    /* ── THE DEPARTMENT EDGE ──────────────────────────────────────────────
       Checked BEFORE anything else about the manager, because a manager in
       another department is not a broken link — it is the end of the chain,
       and the person below them is the department's most senior. Rakesh
       reporting to a CEO outside IT is exactly this, and it is not a problem
       to report. */
    if (!sameDepartment(requester, manager)) {
      stop = chain.length ? STOP.TOP_OF_DEPARTMENT : STOP.OUTSIDE_DEPARTMENT;
      break;
    }

    if (isInactive(manager)) {
      stop = STOP.MANAGER_INACTIVE;
      break;
    }
    const ids = loginIdsOf(manager);
    if (!ids.length) {
      /* Real, in the department, and unable to sign in to anything — so they
         cannot be routed to. Stopping here rather than skipping them: skipping
         would hand their approval to somebody more senior without anyone
         deciding that, which is a control quietly weakening itself. */
      stop = STOP.MANAGER_NO_LOGIN;
      break;
    }

    seen.add(String(manager._id));
    chain.push({
      order: chain.length,
      employeeId: manager._id,
      name: fullName(manager),
      loginId: ids[0],
      altIds: ids,
      department: manager.department || "",
      designation: manager.designation || manager.jobTitle || "",
      status: "pending",
    });
    current = manager;

    if (chain.length >= MAX_DEPTH) {
      stop = STOP.MAX_DEPTH;
      break;
    }
  }

  return { chain, stop, stopReason: STOP_REASON[stop] || "", department };
}

/**
 * Whose turn is it?
 *
 * Reads the frozen chain on the request, never HR. Returns the step object or
 * null when the chain is finished or was never populated.
 */
function currentStep(request) {
  const chain = request?.approvalChain || [];
  if (!chain.length) return null;
  const i = Number.isInteger(request.currentApproverIndex) ? request.currentApproverIndex : 0;
  return chain[i] || null;
}

/**
 * May this viewer answer the step the request is actually on?
 *
 * @param {object} request the stored document
 * @param {object} viewer  `{ employeeId }` — the caller's own login id
 * @returns {{can: boolean, reason: string|null, step: object|null}}
 *
 * Deliberately NOT "is this person anywhere in the chain". Rakesh approving
 * before Pramod has looked would skip a step the department decided to have,
 * and the record would say Pramod approved nothing while the request sailed
 * past him.
 */
function chainEntitlement({ request, viewer } = {}) {
  const me = String(viewer?.employeeId || "");
  const no = (reason) => ({ can: false, reason, step: null });

  /* Nobody answers their own, whatever the chain says. A manager who is also
     the requester is a chain of one that approves itself. */
  if (me && request?.requestedById && me === String(request.requestedById)) {
    return no("You cannot approve your own request.");
  }

  const step = currentStep(request);
  if (!step) return no("This request has no approval step waiting.");

  const ids = [step.loginId, ...(step.altIds || [])].filter(Boolean).map(String);
  if (me && ids.includes(me)) return { can: true, reason: null, step };

  /* Saying WHO is waiting turns a refusal into something the reader can act
     on — and on a multi-step chain it also answers "why can I not approve
     this yet" for somebody who IS in the chain, just not next. */
  return no(`This is waiting for ${step.name || "the next approver in the department"}.`);
}

/**
 * Where an approval leaves the request.
 *
 * @returns {{done: boolean, nextIndex: number, next: object|null}}
 *
 * `done` means every step has answered and the request moves on to Store.
 */
function advance(request) {
  const chain = request?.approvalChain || [];
  const nextIndex = (Number.isInteger(request.currentApproverIndex) ? request.currentApproverIndex : 0) + 1;
  return {
    done: nextIndex >= chain.length,
    nextIndex,
    next: chain[nextIndex] || null,
  };
}

/**
 * What to call the step somebody is being asked to take.
 *
 * "Pramod's approval", then "Rakesh's final approval" — the last one is named
 * differently on purpose: it is the one that releases the request to Store,
 * and an approver should know they are the last gate rather than assuming
 * somebody senior will look again.
 */
function stepLabel(request) {
  const chain = request?.approvalChain || [];
  const step = currentStep(request);
  if (!step) return null;
  const last = step.order === chain.length - 1;
  const who = step.name || "Department";
  return last && chain.length > 1 ? `${who} — final approval` : `${who} — approval`;
}

/** "Soumya → Pramod → Rakesh", with each step's state, for the progress rail. */
function progressOf(request) {
  const chain = request?.approvalChain || [];
  const i = Number.isInteger(request.currentApproverIndex) ? request.currentApproverIndex : 0;
  return chain.map((s) => ({
    order: s.order,
    name: s.name,
    designation: s.designation || null,
    status: s.status || "pending",
    current: s.order === i && s.status === "pending",
    approvedAt: s.approvedAt || null,
    rejectedAt: s.rejectedAt || null,
    note: s.note || null,
  }));
}

module.exports = {
  MAX_DEPTH,
  STOP,
  STOP_REASON,
  STEP_STATUSES,
  fullName,
  isInactive,
  loginIdsOf,
  sameDepartment,
  buildChain,
  currentStep,
  chainEntitlement,
  advance,
  stepLabel,
  progressOf,
};
