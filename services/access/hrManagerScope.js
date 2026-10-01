"use strict";
/**
 * services/access/hrManagerScope.js — proving a reporting relationship.
 *
 * WHAT AUTHORITY LOOKS LIKE HERE
 * ------------------------------
 * A manager route is not authorised by a capability. Every employee is
 * somebody's manager or nobody's, and which of the two they are depends
 * entirely on the RECORD in front of them. So the question is never "does this
 * account hold leave.decide.manager" — it is "is this account, according to
 * records the server wrote, the manager for THIS leave application".
 *
 * The proof comes from two places, both stored:
 *
 *   1. `managersNotified` on the request itself — the chain the server built
 *      when the request was raised, which is what the handlers already decide
 *      turn-taking from; and
 *   2. `primaryManager` / `secondaryManager` on the target employee's own
 *      record, which is where (1) came from and which still answers for a
 *      record raised before the chain existed.
 *
 * NOTHING IN THE REQUEST BODY IS EVIDENCE. `managerId`, `isManager`, `role`,
 * `approverId` — a caller may send any of them and they prove nothing. The only
 * thing read out of the request is WHICH record is being acted on.
 *
 * WHY AT THE MOUNT AS WELL AS IN THE HANDLER
 * ------------------------------------------
 * The handlers do check, and they stay: defence in depth, and they need the
 * record anyway for turn-taking. But a check that lives only inside a handler
 * runs after that handler has begun its work, and it is one `await` away from
 * being forgotten by whoever adds the next manager route. The contract refuses
 * an unrelated employee before the handler is entered at all.
 *
 * ENUMERATION
 * -----------
 * Every negative answer is the same answer. A record that does not exist, an id
 * that is not an id, a record belonging to somebody else's team, a missing
 * target — all of them return `false` and the caller receives the same 403 with
 * the same sentence. Nothing here reports what it did or did not find.
 */

const mongoose = require("mongoose");

/**
 * The record families a manager acts on. Each one carries `employeeId` and the
 * `managersNotified` chain, which is what makes one resolver enough for all
 * three.
 */
const RECORD_SOURCES = Object.freeze({
  leave: () => require("../../models/HR_Models/LeaveManagement").LeaveApplication,
  regularization: () => require("../../models/HR_Models/LeaveManagement").RegularizationRequest,
  overtime: () => require("../../models/HR_Models/OvertimeReport"),
});

function isObjectId(value) {
  return value && mongoose.Types.ObjectId.isValid(String(value));
}

/**
 * The manager's own identity — an ACTIVE Employee record, or nothing.
 *
 * WHY THIS IS THE FIRST QUESTION, NOT THE LAST.
 *
 * Every proof below works by finding the actor's id in a stored record, and
 * stored records are retained: `managersNotified` chains and
 * `primaryManager.managerId` outlive the person they name. `resolveHrActor`
 * also falls back to the token's own `id` as `employeeRef` when no Employee row
 * was found, so an id that merely APPEARS in a reporting field was enough —
 * which meant a hard-deleted manager, a deactivated one, and a legacy HR or CEO
 * department account whose `_id` happened to sit in a manager field could all
 * be managers of somebody.
 *
 * A manager is an employee. `actor.employee` is the row `resolveHrActor`
 * actually fetched — not the token's assertion — and it has to be there and has
 * to be active. Retained history keeps an active former manager's own record of
 * their decisions; it does not keep application access for somebody who has
 * left.
 *
 * @returns {Set<string>} the single id to match on, or an empty set.
 */
function actorIds(actor) {
  /* Required lazily: hrAuthorization reaches back into this module, and a
     top-level require in both directions is a load-order trap waiting for
     whichever file somebody happens to import first. */
  const { employeeIsActive } = require("./hrAuthorization");
  const employee = actor?.employee;
  if (!employee || !employee._id) return new Set();
  if (!employeeIsActive(employee)) return new Set();
  return new Set([String(employee._id)]);
}

/** Is `actor` in this record's server-built notification chain? */
function inNotifiedChain(record, mine) {
  return (record?.managersNotified || []).some((m) => mine.has(String(m?.managerId || "")));
}

/** Is `actor` the stored primary or secondary manager of this employee? */
async function isStoredManagerOf(employeeId, mine) {
  if (!isObjectId(employeeId)) return false;
  const Employee = require("../../models/Employee");
  const target = await Employee.findById(employeeId)
    .select("primaryManager.managerId secondaryManager.managerId")
    .lean()
    .catch(() => null);
  if (!target) return false;
  return (
    mine.has(String(target.primaryManager?.managerId || "")) ||
    mine.has(String(target.secondaryManager?.managerId || ""))
  );
}

/**
 * Read the target id out of the request, from the path or the body — never as a
 * claim of authority, only as "which record".
 */
function readTarget(descriptor, req) {
  if (descriptor.param) {
    return req?.hrParams?.[descriptor.param] ?? req?.params?.[descriptor.param];
  }
  if (descriptor.employeeFrom) {
    const [source, key] = descriptor.employeeFrom.split(".");
    const bag = source === "body" ? req?.body : source === "query" ? req?.query : req?.params;
    return bag && typeof bag === "object" ? bag[key] : undefined;
  }
  return undefined;
}


/* ── The manager persona, and why history is different ───────────────────────
 *
 * A queue route carries no target, so there is nothing to prove a relationship
 * AGAINST. What can still be proven is that this account is a manager — and
 * that is the persona the route is for.
 *
 * TWO RULES, DELIBERATELY, because a single one is wrong at one end or the
 * other:
 *
 *   "current"  at least one ACTIVE employee names this account as their primary
 *              or secondary manager. This is the live org chart, and it is what
 *              `/manager/pending`, `/manager/my-team` and
 *              `/manager/withdraw-pending` are about: work waiting on somebody
 *              who manages people today. A genuine manager whose queue happens
 *              to be empty still passes — the persona is proven from the
 *              reporting rows, not from having something to do.
 *
 *   "history"  the current rule OR their name on a stored `managersNotified`
 *              chain. A reorganisation moves people; the decisions the previous
 *              manager made are still theirs, and their own history should not
 *              disappear because the org chart changed underneath them. The
 *              records themselves name them, which is proof enough to READ
 *              their own past decisions — and only their own, because the
 *              handler's query filters on their id either way.
 *
 * Both rules are records-only. Nothing in the request contributes.
 */
const HISTORY_SOURCES = ["leave", "regularization", "overtime"];

async function namesAnyActiveReport(mine) {
  const Employee = require("../../models/Employee");
  const ids = [...mine].filter((id) => isObjectId(id));
  if (!ids.length) return false;
  try {
    const found = await Employee.findOne({
      $or: [
        { "primaryManager.managerId": { $in: ids } },
        { "secondaryManager.managerId": { $in: ids } },
      ],
      /* A leaver's record still names their old manager. Counting it would keep
         somebody a "manager" of nobody for as long as the record is retained,
         which is for ever. */
      isActive: { $ne: false },
      status: { $ne: "inactive" },
    })
      .select("_id")
      .lean();
    return Boolean(found);
  } catch {
    return false;
  }
}

async function namedOnAnyStoredChain(mine) {
  const ids = [...mine].filter((id) => isObjectId(id));
  if (!ids.length) return false;
  for (const kind of HISTORY_SOURCES) {
    try {
      const Model = RECORD_SOURCES[kind]();
      const found = await Model.findOne({ "managersNotified.managerId": { $in: ids } })
        .select("_id")
        .lean();
      if (found) return true;
    } catch {
      /* An unreadable collection proves nothing; try the next. */
    }
  }
  return false;
}

async function proveManagerPersona(mode, mine) {
  if (await namesAnyActiveReport(mine)) return true;
  if (mode === "history") return namedOnAnyStoredChain(mine);
  return false;
}

/**
 * @param {object} input
 * @param {object} input.actor       a resolved HR actor
 * @param {object} input.descriptor  the declaration's `managerScope`
 * @param {object} input.req
 * @returns {Promise<boolean>} true only when the relationship is PROVEN
 */
async function proveManagerScope({ actor, descriptor, req }) {
  if (!actor?.authenticated) return false;

  const mine = actorIds(actor);
  if (!mine.size) return false;

  /* A queue read has no target in the request, so the proof is the PERSONA:
     is this account a manager at all? It used to return `true` unconditionally,
     which meant every authenticated employee passed the central contract for
     every manager queue and the entire manager persona was enforced nowhere but
     inside the handlers' own queries. See proveManagerPersona for the rule. */
  if (descriptor?.queue) return proveManagerPersona(descriptor.queue, mine);

  const target = readTarget(descriptor || {}, req);
  if (target === undefined || target === null || String(target).trim() === "") return false;

  /* Acting on a named employee — "raise this leave on their behalf". The id in
     the body says WHO; the stored reporting rows say whether that is allowed. */
  if (descriptor.employeeFrom) {
    return isStoredManagerOf(String(target).trim(), mine);
  }

  const load = RECORD_SOURCES[descriptor.record];
  if (!load) return false;
  if (!isObjectId(target)) return false;

  let record = null;
  try {
    record = await load()
      .findById(String(target))
      .select("employeeId managersNotified")
      .lean();
  } catch {
    /* An unreadable record proves nothing, which is a refusal. */
    return false;
  }
  if (!record) return false;

  if (inNotifiedChain(record, mine)) return true;
  return isStoredManagerOf(record.employeeId, mine);
}

module.exports = { proveManagerScope, proveManagerPersona, RECORD_SOURCES };
