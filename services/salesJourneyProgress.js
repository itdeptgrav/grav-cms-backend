// services/salesJourneyProgress.js
//
// The Sales Journey stage state machine — the single writer of `currentStage`
// and `stageStates` after a Journey is created. Until this existed a Journey
// was frozen at `account / inProgress` forever: the model carried the fields
// but no route ever moved them. Every stage's "Send to …" button was a
// preview. This service is the one place that decides whether a move is legal
// and what it changes; routes/CMS_Routes/Sales/salesJourneys.js's
// POST /:journeyId/stage applies the plan it returns.
//
// Pure and DB-free ON PURPOSE, exactly like services/leadReadiness.js: it is
// handed a Journey document (or a plain lifecycle-shaped object) and returns
// the mutation to apply — it never loads or saves. That keeps the rules unit-
// testable without a database and keeps the atomic write the route's concern.
//
// FOUR verbs, matching the lifecycle the frontend already draws (the
// continueAction on each stage is the "advance" verb; the status strip is
// "setState"; block/reopen are the corrective off-paths):
//
//   • advance  — complete the current stage and move to the next APPLICABLE
//                one (stages marked notApplicable are skipped). Refused at the
//                final stage, and refused while the current stage is blocked.
//   • setState — set the CURRENT stage to a working state (inProgress /
//                waitingCustomer / waitingInternal / complete). This is
//                "waiting on the customer", "mark done", etc.
//   • block    — mark the current stage blocked. A reason is required and
//                audited.
//   • reopen   — reopen a COMPLETED stage (any stage at or before the current
//                one) and move the pointer back to it. Reason required.
//
// DELIBERATELY OUT OF SCOPE for this chunk (noted so the next one is obvious):
//   - No per-stage reason is STORED. stageStates is a plain string enum per the
//     model; block/reopen reasons live in the change log (recordChange) only.
//     Storing them would mean widening the stageStates sub-schema — a separate,
//     larger change.
//   - `risk` is a separate axis and is never touched here.
//   - Marking a FUTURE stage notApplicable (skip sampling for a repeat order)
//     is not offered yet — setState is current-stage-only.
"use strict";

const {
  SALES_JOURNEY_STAGES,
  SALES_JOURNEY_STAGE_STATES,
} = require("../constants/crm");

// Ordered stage codes — index IS the lifecycle position. Mirrors the frontend
// STAGE_KEYS in lib/salesJourney/stageConfig.js (both files move together).
const STAGE_ORDER = SALES_JOURNEY_STAGES.map((s) => s.code);
const STAGE_LABEL = Object.fromEntries(SALES_JOURNEY_STAGES.map((s) => [s.code, s.label]));
const STATE_LABEL = Object.fromEntries(SALES_JOURNEY_STAGE_STATES.map((s) => [s.code, s.label]));

// The states setState may assign to the current stage. Deliberately excludes
// notStarted (you cannot un-start the stage you are on), blocked (use `block`),
// reopened (use `reopen`) and notApplicable (the active stage can't be N/A).
const SETTABLE_STATES = new Set(["inProgress", "waitingCustomer", "waitingInternal", "complete"]);

/** A move the caller can fix (wrong action, illegal from here) — a 4xx, not a 500. */
class JourneyTransitionError extends Error {
  constructor(message) {
    super(message);
    this.name = "JourneyTransitionError";
  }
}

const labelOf = (code) => STAGE_LABEL[code] || code;
const stateLabelOf = (code) => STATE_LABEL[code] || code;

/** stageStates as a plain object regardless of Mongoose vs POJO input. */
function readStates(stageStates) {
  const raw = stageStates && typeof stageStates.toObject === "function" ? stageStates.toObject() : stageStates || {};
  const out = {};
  for (const code of STAGE_ORDER) out[code] = raw[code] || "notStarted";
  return out;
}

/** Index of the next stage after `from` whose state is not notApplicable, or -1. */
function nextApplicableIndex(fromIdx, states) {
  for (let i = fromIdx + 1; i < STAGE_ORDER.length; i++) {
    if (states[STAGE_ORDER[i]] !== "notApplicable") return i;
  }
  return -1;
}

/**
 * Plan a stage transition. Pure: returns what to change, never mutates or
 * saves.
 *
 * @param {object} journey  a SalesJourney document or lifecycle-shaped object
 *                          ({ currentStage, stageStates }).
 * @param {{action:string, toState?:string, stage?:string, reason?:string, context?:object}} input
 *   context.accountReadiness — {ready:boolean, missing:[{label}]} for the
 *     Account → Enquiry gate. DB-dependent (needs the account bundle), so the
 *     ROUTE computes it via services/accountReadiness.js and passes it here,
 *     exactly the split services/leadQualification.js uses for its own
 *     DB-dependent prerequisites. When advancing OUT of the "account" stage
 *     and this is supplied-and-not-ready, the move is refused. Omitted →
 *     no account gate (keeps the pure planner usable in isolation/tests).
 * @returns {{ set: Record<string,string>, summary: string }}
 *          `set` maps dot-paths ("currentStage", "stageStates.enquiry") to the
 *          values the route should assign; `summary` is the audit phrase.
 * @throws {JourneyTransitionError} for any illegal move.
 */
function planStageTransition(journey = {}, input = {}) {
  const action = String(input.action || "").trim();
  const context = input.context || {};
  const current = journey.currentStage;
  if (!STAGE_ORDER.includes(current)) {
    throw new JourneyTransitionError(`This Journey has no valid current stage ("${current}").`);
  }
  const states = readStates(journey.stageStates);
  const currentState = states[current];
  const currentIdx = STAGE_ORDER.indexOf(current);

  switch (action) {
    case "advance": {
      if (currentState === "blocked") {
        throw new JourneyTransitionError(`${labelOf(current)} is blocked — resolve the block before moving forward.`);
      }
      // (The old Account → Enquiry readiness gate was removed on 13 Aug 2026:
      // "account" is no longer a journey stage. The customer is set up on the
      // Active Lead before conversion, so there is no hollow-account state to
      // guard here.)
      const ni = nextApplicableIndex(currentIdx, states);
      if (ni === -1) {
        throw new JourneyTransitionError(`${labelOf(current)} is the final stage — there is nothing after it.`);
      }
      const next = STAGE_ORDER[ni];

      // ── The one hard prerequisite: nothing enters Production without a PO ──
      //
      // Every other transition stays permissive on purpose. This one is not,
      // because it commits factory capacity and buys fabric against a price
      // nobody has signed — the only stage move whose cost cannot be walked
      // back by editing a record.
      //
      // It IS overridable, by a Sales manager with a written reason ("customer
      // confirmed on call, PO to follow Monday"). A gate with no override gets
      // defeated by someone typing a fake PO number, which costs you both the
      // control and the truth; an override that is recorded gives you something
      // better than prevention — a list of every time the rule was bent.
      const missing = [];
      if (next === "production" && context.poOnFile === false) missing.push("customer PO");

      if (missing.length) {
        const reason = String(context.overrideReason || "").trim();
        if (!reason) {
          throw new JourneyTransitionError(
            `${labelOf(next)} needs the ${missing.join(" and ")} on file. `
            + "Record it first, or a Sales manager can proceed with a written reason.",
          );
        }
        if (!context.isManager) {
          throw new JourneyTransitionError(
            `Only a Sales manager can start ${labelOf(next)} without the ${missing.join(" and ")}.`,
          );
        }
      }

      const set = {
        currentStage: next,
        [`stageStates.${current}`]: "complete",
      };
      // Returned SEPARATELY from `set`, not as a $push inside it: the route
      // applies set with journey.set(path, value), so a mongo operator key would
      // be written as a literal field called "$push".
      const append = missing.length
        ? {
            path: "advancedWithoutPrerequisites",
            value: {
              stage: next,
              missing,
              reason: String(context.overrideReason || "").trim(),
              at: new Date(),
              by: context.actor || {},
            },
          }
        : null;
      // Only open the next stage if it hasn't already been worked — a stage
      // that is complete (advancing again after a reopen) or notApplicable is
      // left as it is.
      if (states[next] === "notStarted" || states[next] === "reopened") {
        set[`stageStates.${next}`] = "inProgress";
      }
      return {
        set,
        ...(append ? { append } : {}),
        summary: append
          ? `advanced ${labelOf(current)} → ${labelOf(next)} WITHOUT ${missing.join(" and ")}`
          : `advanced ${labelOf(current)} → ${labelOf(next)}`,
      };
    }

    // ── close ────────────────────────────────────────────────────────────
    //
    // Closing the order was routed through `advance`, and Retention is the LAST
    // stage — so advance hit "there is nothing after it" and threw. The close
    // button could not work at all. Closing is its own verb: it completes the
    // final stage rather than moving to a next one.
    //
    // The financial gate: `context.closing` carries the closing report's verdict
    // ({canClose, blockers, checklist}). When the caller supplies it, this
    // REFUSES a close with unmet checks — the UI's disabled button is not a
    // control, since anything hitting the API directly bypasses it. When it is
    // absent the close proceeds, which is deliberate for now: the route does not
    // yet assemble the verdict, and failing closed would leave no way to close
    // an order at all. Wiring that assembly is the remaining half of this fix.
    case "close": {
      if (currentIdx !== STAGE_ORDER.length - 1) {
        throw new JourneyTransitionError(
          `Only ${labelOf(STAGE_ORDER[STAGE_ORDER.length - 1])} can be closed — this Journey is on ${labelOf(current)}.`,
        );
      }
      if (currentState === "blocked") {
        throw new JourneyTransitionError(`${labelOf(current)} is blocked — resolve the block before closing.`);
      }
      if (currentState === "complete") {
        throw new JourneyTransitionError("This order is already closed.");
      }
      const verdict = context.closing;
      if (verdict && verdict.canClose === false) {
        const n = verdict.blockers;
        throw new JourneyTransitionError(
          typeof n === "number"
            ? `${n} closing ${n === 1 ? "check is" : "checks are"} unmet — the order cannot be closed yet.`
            : "The closing checks are not met — the order cannot be closed yet.",
        );
      }
      return {
        set: {
          [`stageStates.${current}`]: "complete",
          closedAt: new Date(),
        },
        summary: `closed the order at ${labelOf(current)}`,
      };
    }

    case "setState": {
      const toState = String(input.toState || "").trim();
      if (!SETTABLE_STATES.has(toState)) {
        throw new JourneyTransitionError(
          `"${toState || "(none)"}" is not a state you can set here. Use one of: ${[...SETTABLE_STATES].join(", ")}.`,
        );
      }
      if (states[current] === toState) {
        throw new JourneyTransitionError(`${labelOf(current)} is already ${stateLabelOf(toState)}.`);
      }
      return {
        set: { [`stageStates.${current}`]: toState },
        summary: `set ${labelOf(current)} to ${stateLabelOf(toState)}`,
      };
    }

    case "block": {
      const reason = String(input.reason || "").trim();
      if (!reason) throw new JourneyTransitionError("A reason is required to block a stage.");
      if (currentState === "blocked") throw new JourneyTransitionError(`${labelOf(current)} is already blocked.`);
      return {
        set: { [`stageStates.${current}`]: "blocked" },
        summary: `blocked ${labelOf(current)} — ${reason}`,
      };
    }

    case "reopen": {
      const target = String(input.stage || current).trim();
      if (!STAGE_ORDER.includes(target)) {
        throw new JourneyTransitionError(`"${target}" is not a valid stage.`);
      }
      if (STAGE_ORDER.indexOf(target) > currentIdx) {
        throw new JourneyTransitionError(`${labelOf(target)} is ahead of the current stage — it hasn't been done yet.`);
      }
      if (states[target] !== "complete") {
        throw new JourneyTransitionError(
          `Only a completed stage can be reopened; ${labelOf(target)} is ${stateLabelOf(states[target])}.`,
        );
      }
      const reason = String(input.reason || "").trim();
      if (!reason) throw new JourneyTransitionError("A reason is required to reopen a stage.");
      return {
        set: { [`stageStates.${target}`]: "reopened", currentStage: target },
        summary: `reopened ${labelOf(target)} — ${reason}`,
      };
    }

    default:
      throw new JourneyTransitionError(
        `"${action || "(none)"}" is not a stage action. Use one of: advance, close, setState, block, reopen.`,
      );
  }
}

module.exports = {
  JourneyTransitionError,
  planStageTransition,
  STAGE_ORDER,
  SETTABLE_STATES,
};
