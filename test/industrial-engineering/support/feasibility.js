// test/industrial-engineering/support/feasibility.js
//
// THE MINIMAL FEASIBILITY ASSESSMENT A FIXTURE NEEDS BEFORE IT MAY SUBMIT.
//
// Submitting a bulletin now requires somebody to have said whether the factory
// can make the style — "not assessed" is not a pass, and the gate refuses it.
// Every suite that submits a bulletin as part of its SETUP therefore has to do
// what an engineer does: open the assessment and record a result.
//
// ── WHY A HELPER AND NOT A FABRICATED FIELD ─────────────────────────────────
// It would be quicker to write `feasibility: { outcome: "FEASIBLE" }` straight
// into the fixture document. It would also be a lie: the route is what applies
// the rules, stamps the technical pack the judgement was made against and
// moves the revision, and a fixture that bypassed it would keep passing after
// the rules changed underneath it. So this goes through the real endpoint with
// the suite's own `call`, exactly as the screen does.
//
// ── IT IS DELIBERATELY THE SMALLEST HONEST ASSESSMENT ───────────────────────
// One outcome, no findings, no conditions: a style a suite is using to test
// something else is a style nobody found a problem with. A suite that wants a
// concern, a condition or a block states it itself — and the suites that prove
// the gate REFUSES an unassessed submission do not call this at all.
"use strict";

/**
 * Record "feasible, nothing found" on a file, through the real route.
 *
 * @param {Function} call  the suite's own fetch helper
 * @param {object} p
 * @param {string} p.fileId   the engineering file
 * @param {string} p.token    an IE EDITOR's token — the assessment is a write
 * @param {string} p.company  the acting company
 * @param {object} [p.body]   overrides, for a fixture that wants a real finding
 */
async function assessFeasible(call, { fileId, token, company, body = {} } = {}) {
  /* ── "ENSURE ASSESSED", NOT "ASSESS ONCE" ────────────────────────────────
     Idempotent, because a fixture may reach a second submission on the same
     file — a returned version reworked and sent again, a successor cycle — and
     because two fixture submissions may run CONCURRENTLY: the suite that
     proves exactly one of two simultaneous submissions wins fires both through
     this helper at the same time. Read-then-write is not atomic, so the loser
     of that race is told its revision moved. That refusal is correct and it is
     also not a failure HERE: somebody assessed the file, which is all this
     helper promises. So a revision conflict re-reads and accepts the winner's
     assessment rather than throwing. */
  const read = async () => {
    const res = await call(`/engineering-files/${fileId}/feasibility`, { token, company });
    if (res.status !== 200) {
      throw new Error(`assessFeasible(${fileId}) could not read: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.assessment;
  };

  /* Two attempts is enough: the only way the first loses is that another
     writer won, and that writer has by then finished. */
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await read();
    if (current.assessed && !Object.keys(body).length) return current;

    const res = await call(`/engineering-files/${fileId}/feasibility`, {
      method: "PATCH",
      token,
      company,
      body: {
        expectedRevision: current.revision,
        outcome: "FEASIBLE", findings: [], conditions: [], ...body,
      },
    });
    if (res.status === 200) return res.body.assessment;

    const raced = res.status === 409
      && res.body?.error?.code === "IE_FEASIBILITY_REVISION_CONFLICT";
    /* Loud on anything else: a fixture that silently failed to assess would
       surface later as a confusing "not ready" from the submit it was
       preparing for. */
    if (!raced) {
      throw new Error(`assessFeasible(${fileId}) failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
  }

  const settled = await read();
  if (settled.assessed) return settled;
  throw new Error(`assessFeasible(${fileId}) kept losing the revision race and the file is still unassessed`);
}

module.exports = { assessFeasible };
