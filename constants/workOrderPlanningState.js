// constants/workOrderPlanningState.js
//
// The work-order PLANNING axis — decision 1 of
// docs/decisions/project-manager-work-order-planning-lifecycle.md, approved
// 3 Sep 2026.
//
// This is deliberately SEPARATE from `WorkOrder.status`. `status` conflates
// planning progress with execution progress, and every byte of it is
// preserved: nothing here reads, writes or reinterprets it. The planning axis
// answers only "how far has this work order been planned", and execution
// answers "how far has it been made".
//
// Dependency-free on purpose. The Mongoose schema takes its `enum` from
// PLANNING_STATES, so the model and the projection layer cannot drift apart,
// and requiring this file pulls in no mongoose, no models and no services.

"use strict";

/**
 * The five values, least-planned first.
 *
 * `unknown` exists because legacy records predate the axis and NO evidence in
 * them proves what was planned (audit §10). It is a real, persistable value —
 * not a null stand-in — so a record can be explicitly classified as
 * "we looked, and the evidence does not say" and stay that way until an
 * approver decides otherwise.
 */
const PLANNING_STATE_UNKNOWN = "unknown";
const PLANNING_STATE_NOT_STARTED = "not_started";
const PLANNING_STATE_IN_PROGRESS = "in_progress";
const PLANNING_STATE_COMPLETE = "complete";
const PLANNING_STATE_RELEASED = "released";

const PLANNING_STATES = Object.freeze([
  PLANNING_STATE_UNKNOWN,
  PLANNING_STATE_NOT_STARTED,
  PLANNING_STATE_IN_PROGRESS,
  PLANNING_STATE_COMPLETE,
  PLANNING_STATE_RELEASED,
]);

/**
 * Read-side interpretation of a stored value. Absence means `unknown`.
 *
 * WHY THIS IS A FUNCTION AND NOT A SCHEMA DEFAULT. A Mongoose default was
 * measured against a legacy record and it MASKS absence: `findOne()` hydrates
 * the default while `.lean()` shows the field is not there, so a legacy record
 * would read as `not_started` — a positive claim that planning had not begun,
 * which no evidence supports. Interpreting on read keeps the stored document
 * honest: absent stays absent in MongoDB, and reading never writes.
 *
 * Anything not in the enum — a typo, a value from a future version, a number —
 * also reads as `unknown` rather than being echoed back as if it were valid.
 */
function normalizePlanningState(value) {
  return PLANNING_STATES.includes(value) ? value : PLANNING_STATE_UNKNOWN;
}

module.exports = {
  PLANNING_STATES,
  PLANNING_STATE_UNKNOWN,
  PLANNING_STATE_NOT_STARTED,
  PLANNING_STATE_IN_PROGRESS,
  PLANNING_STATE_COMPLETE,
  PLANNING_STATE_RELEASED,
  normalizePlanningState,
};
