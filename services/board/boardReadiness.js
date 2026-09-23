// services/board/boardReadiness.js
//
// BOARD DOES NOT ANSWER UNTIL ITS GRANT EXISTS.
//
// ── THE FAILURE THIS PREVENTS ───────────────────────────────────────────────
// Board authorisation reads the `board` department. Two things have to have
// happened on a given database before that is a question worth asking:
//
//   1. `services/ensureAccessDepartments.js` has seeded the `board` row;
//   2. `scripts/migrations/board-department-split.js` has copied each active
//      explicit `ceo` role across, so the people who hold Board today still do.
//
// Both run at boot, asynchronously, after the database connects. Express starts
// listening before they finish. In that window every Board request would be
// answered `BOARD_ACCESS_REQUIRED / NO_BOARD_GRANT` — which is a lie: the grant
// is not missing, it is not established yet. A director reading it would ask an
// administrator to fix their access, and an administrator looking at a codebase
// that had just changed slug would reach for the one fix that must never be
// made: `ceo || board` in the guard.
//
// So Board waits, and says so. 503, `BOARD_NOT_READY`, with the reason.
//
// ── AND IF THE MIGRATION REFUSES, IT STAYS SHUT ─────────────────────────────
// A refusal is not a transient state to retry past. If the Board department is
// missing, or two Employee records share an address that holds a board-level
// role, the honest answer is that Board access cannot be determined on this
// database — not that nobody has it, and certainly not that everyone in the
// Executive Office does.
//
// ── WHY IT IS ARMED, RATHER THAN DEFAULTING TO CLOSED ───────────────────────
// This module is a statement about one process's boot sequence, and only the
// process that HAS a boot sequence can make it. `server.js` calls `arm()` before
// it listens; until something arms it there is no boot to wait for, and a suite
// that mounts the Board router over a database it prepared itself is not in a
// window this gate knows anything about.
//
// It is not a bypass. `arm()` is called unconditionally at the top of
// `server.js`, so the real application is always gated, and nothing here
// authorises anybody — `services/board/boardAccess.js` still requires an
// explicit role on every single request either way.
"use strict";

/** `unarmed` | `pending` | `ready` | `failed`. */
let state = "unarmed";
let reason = "";
let code = "";
/** When `arm()` was called, so "starting" can be told from "stuck". */
let armedAt = 0;

/** Declare that this process has a boot sequence Board must wait for. */
function arm() {
  if (state === "unarmed") {
    state = "pending";
    armedAt = Date.now();
  }
  return state;
}

function markReady() {
  state = "ready";
  reason = "";
  code = "";
}

function markFailed(err) {
  state = "failed";
  reason = err?.message || String(err || "unknown");
  /* The migration's own outcome name, kept apart from the sentence so a caller
     can branch on it and a person can search for it. */
  code = err?.code || "UNKNOWN";
}

/** For tests and for the boot log. */
const status = () => ({ state, reason, code, waitingMs: armedAt ? Date.now() - armedAt : 0 });

/** Reset — for tests only, so one suite's arming cannot leak into another. */
function _reset() {
  state = "unarmed";
  reason = "";
  code = "";
  armedAt = 0;
}

/**
 * The gate. Mounted in `server.js` in FRONT of the Board router.
 *
 * In front rather than inside, so a suite that mounts the router directly is
 * testing the router, and the only thing that can hold Board shut is the process
 * that actually boots it.
 */
function requireBoardReady(req, res, next) {
  if (state === "unarmed" || state === "ready") return next();
  if (state === "pending") {
    /* ── WHY THE ELAPSED TIME IS PUBLISHED ────────────────────────────────
       In development `autoIndex` is on, so the seeding and migration this is
       waiting for queue behind Mongoose confirming ~285 indexes against the
       database — see `connectDB` in `server.js`. That can be tens of seconds
       after a restart, and "still starting" with no number is
       indistinguishable from "stuck forever". A client can also use it to
       decide whether retrying is still reasonable. */
    return res.status(503).json({
      success: false,
      code: "BOARD_NOT_READY",
      waitingMs: Date.now() - armedAt,
      message:
        "Board policy is still starting up on this server. This is not a problem with your "
        + "access — try again in a moment.",
    });
  }
  /* failed */
  return res.status(503).json({
    success: false,
    code: "BOARD_NOT_READY",
    reason: "MIGRATION_FAILED",
    /* Named, so an operator can tie the refusal to the boot log entry. */
    diagnostic: code || "UNKNOWN",
    message:
      "Board policy cannot start on this database: the Board access grant could not be "
      + "established. An administrator needs to resolve this; nobody's access has been "
      + "changed and no fallback has been applied.",
    detail: reason,
  });
}

module.exports = { arm, markReady, markFailed, status, requireBoardReady, _reset };
