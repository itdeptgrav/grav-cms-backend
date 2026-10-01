"use strict";
/*
 * scripts/ie/ieDemoLifecycle.js
 *
 * THE IE LIFECYCLE, DRIVEN THROUGH THE SERVICES THE ROUTES CALL.
 *
 * Every step here is the same function the HTTP layer invokes, with the same
 * `(ctx, { ..., actor })` shape the router passes. Nothing sets a status
 * field, nothing writes a revision, and nothing reaches into a model to make a
 * state the application would not have produced.
 *
 * ── MAKER AND CHECKER ARE TWO PEOPLE, BECAUSE THE SERVER SAYS SO ────────────
 * The bulletin version, the line layout and the capacity standard each refuse
 * an approval by the person who submitted or drafted it. The demo therefore
 * drafts as the editor and approves as the approver — which is also the only
 * way the seeded scenario tells the truth about how the department works.
 *
 * This file is new and development-only. It changes no application behaviour.
 */

const styleFiles = require("../../services/industrialEngineering/ieStyleFile.service");
const operations = require("../../services/industrialEngineering/ieOperationLibrary.service");
const policies = require("../../services/industrialEngineering/ieAllowancePolicy.service");
const versions = require("../../services/industrialEngineering/ieBulletinVersion.service");
const layouts = require("../../services/industrialEngineering/ieLineLayout.service");
const capacity = require("../../services/industrialEngineering/ieCapacityStandard.service");
const ramps = require("../../services/industrialEngineering/ieRampProfile.service");
const releases = require("../../services/industrialEngineering/ieRelease.service");
const methodStudies = require("../../services/industrialEngineering/ieMethodStudy.service");

const { DEMO_TAG } = require("./ieDemoGuards");

const actorOf = (id) => ({ id: String(id.employee._id), email: id.email, name: id.user.name });

/**
 * A realistic short-sleeve tee bulletin.
 *
 * Deliberately varied so the screens have something to show: three machine
 * types, an attachment, two labour grades, and one operation that is later
 * RETIRED so the library has both states and the release has an honest
 * retired-operation story to tell.
 */
const OPERATIONS = Object.freeze([
  { code: "SJ-01", name: "Join shoulder", machineType: "SNLS", minutes: 0.72, grade: "GRADE_B" },
  { code: "OL-02", name: "Attach sleeve", machineType: "OL4", minutes: 1.15, grade: "GRADE_A" },
  { code: "OL-03", name: "Close side seam", machineType: "OL4", minutes: 1.40, grade: "GRADE_A" },
  { code: "CS-04", name: "Attach neck rib", machineType: "CSTITCH", minutes: 1.05, grade: "GRADE_A", attachment: true },
  { code: "HM-05", name: "Hem bottom", machineType: "CSTITCH", minutes: 0.88, grade: "GRADE_B" },
  { code: "SJ-06", name: "Attach label", machineType: "SNLS", minutes: 0.45, grade: "GRADE_C" },
  { code: "HF-07", name: "Hand finish and trim", machineType: "MANUAL", minutes: 0.60, grade: "GRADE_C" },
]);

/** The one the demo retires, so both library states are visible. */
const RETIRED_CODE = "HF-07";

async function seedLibrary(ctx, editor, approver, manifest) {
  const made = {};
  for (const op of OPERATIONS) {
    const res = await operations.createOperation(ctx, {
      body: { code: op.code, name: op.name, machineType: op.machineType },
      actor: actorOf(editor),
    });
    const id = res.operation.operationId;
    made[op.code] = id;
    manifest.operationIds.push(String(id));

    /* Machine, attachment and labour requirements — the three kinds the
       release's requirement evidence publishes separately, in the service's
       own field names and row shapes. */
    await operations.updateRequirements(ctx, {
      operationId: id,
      body: {
        expectedRevision: res.operation.revision,
        machineRequirements: [{ machineType: op.machineType, quantity: 1 }],
        labourRequirements: [{
          workerType: "OPERATOR", quantity: 1, grade: op.grade,
          skillCode: `SK-${op.machineType}`, skillName: op.name,
        }],
        attachmentRequirements: op.attachment
          ? [{ code: "ATT-06", name: "Folder 6mm", quantity: 1, note: "Left bed" }]
          : [],
      },
      actor: actorOf(editor),
    });
  }

  return made;
}

/**
 * A published allowance policy, made by two people.
 *
 * Without one, no standard time can be calculated for a method study — the IE
 * Settings screen says exactly that, and the demo would hit the same wall a
 * real company does on day one.
 */
async function seedAllowancePolicy(ctx, editor, approver, manifest) {
  const draft = await policies.createPolicy(ctx, {
    body: {
      name: `${DEMO_TAG} standard allowances`,
      effectiveFrom: "2026-01-01",
      categories: [
        { code: "RELAXATION", name: "Relaxation", percent: 8 },
        { code: "CONTINGENCY", name: "Contingency", percent: 4 },
      ],
    },
    actor: actorOf(editor),
  });
  const policyId = draft.policy.policyId;
  manifest.policyIds.push(String(policyId));

  await policies.publishPolicyDraft(ctx, {
    policyId, body: { expectedRevision: draft.policy.revision },
    actor: actorOf(approver),
  });
  return policyId;
}

module.exports = { OPERATIONS, RETIRED_CODE, actorOf, seedLibrary, seedAllowancePolicy };

/**
 * ONE APPROVED METHOD STUDY PER BULLETIN ROW.
 *
 * A bulletin cannot be submitted until every row carries a standard time a
 * second person approved — the readiness gate refuses with one gap per row
 * otherwise, which is the application correctly insisting that a SAM is
 * evidence rather than a number somebody typed.
 *
 * So the demo does what an industrial engineer does: opens a study on the row,
 * records an observation and a rating, submits it, and has the approver accept
 * it. The manual standard time is used so the seeded SAMs are the exact
 * minutes the scenario intends and the line balance is legible — the same
 * device the existing IE route tests use, with the override reason the service
 * requires.
 *
 * `skipRows` leaves some rows unapproved on purpose where a partially-ready
 * file is wanted; the caller decides.
 */
async function approveRowTimes(ctx, { fileId, rows, editor, approver, minutesByCode, manifest }) {
  const done = [];
  for (const row of rows) {
    const minutes = minutesByCode[row.operationCode];
    if (minutes === undefined) continue;

    const opened = await methodStudies.createStudy(ctx, {
      fileId, rowId: row.rowId, actor: actorOf(editor),
    });
    const studyId = opened.study.studyId;
    manifest.studyIds.push(String(studyId));

    const filled = await methodStudies.updateStudy(ctx, {
      studyId,
      body: {
        expectedRevision: opened.study.revision,
        studiedAt: "2026-09-08T04:30:00.000Z",
        location: "Line 4",
        methodNote: "Two-hand method, observed on the sample run.",
        ratingPercent: 100,
        observations: [{ durationSeconds: Math.round(minutes * 60) }],
      },
      actor: actorOf(editor),
    });

    const submitted = await methodStudies.submitStudy(ctx, {
      studyId,
      body: {
        expectedRevision: filled.study.revision,
        manualStandardTimeMinutes: minutes,
        overrideReason: `${DEMO_TAG}: standard agreed for the demo scenario.`,
      },
      actor: actorOf(editor),
    });

    await methodStudies.approveStudy(ctx, {
      studyId,
      body: { expectedRevision: submitted.study.revision },
      actor: actorOf(approver),
    });
    done.push(row.operationCode);
  }
  return done;
}

module.exports.approveRowTimes = approveRowTimes;

/**
 * RETIRE ONE OPERATION, AFTER the bulletin version was approved.
 *
 * ── WHY THE ORDER MATTERS ───────────────────────────────────────────────────
 * A retired operation BLOCKS a bulletin submission — the readiness gate counts
 * it as a thing needing attention, which is correct: you should not freeze a
 * plan around an operation your library has withdrawn. Retiring first would
 * simply have made the scenario unbuildable.
 *
 * Retiring afterwards is also the true story, and the more useful one. It is
 * exactly the situation the release's retired-operation override and the whole
 * change-impact screen exist for: the plan froze, the library moved on, and
 * somebody now has to say in writing why the frozen plan may still be issued.
 *
 * It also gives the Operations register both an Active and a Retired state to
 * show, which it otherwise would not have.
 */
async function retireOneOperation(ctx, operationId, approver) {
  const current = await operations.readOperation(ctx, { operationId });
  if (current.operation.status !== "ACTIVE") return current.operation;
  const out = await operations.retireOperation(ctx, {
    operationId,
    body: { expectedRevision: current.operation.revision },
    actor: actorOf(approver),
  });
  return out.operation;
}

module.exports.retireOneOperation = retireOneOperation;
