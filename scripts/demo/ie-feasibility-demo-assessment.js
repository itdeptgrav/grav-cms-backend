// The Engineering Feasibility demonstration assessment, and the one safe way to
// record it.
//
// WHY THIS IS A MODULE AND NOT A FEW LINES IN A SEED SCRIPT
// Somebody will eventually want this demonstration in a database that also holds
// real work. So the writing is guarded here, once, rather than re-decided at
// each call site: it goes through the engineering file's own PATCH route, it
// never touches a file that has stopped being a draft, it never overwrites an
// assessment it did not itself write, and it never touches an approved bulletin
// version's frozen copy — that copy is evidence of what was decided, and a
// demonstration has no business editing it.
//
// It records a judgement about a piqué knit polo: a garment the factory can
// make, once R&D confirms the shrinkage and somebody runs a pilot. Nothing in
// it is a plan — no quantity, no line, no shift, no daily target, no price and
// no capacity booking. Feasibility answers whether the garment can be made,
// never when or how many.
"use strict";

/** The outcome, the findings and the conditions, exactly as the demo records them. */
const DEMO_ASSESSMENT = Object.freeze({
  outcome: "FEASIBLE_WITH_CONDITIONS",
  recommendation: "Suitable for controlled development production once the named "
    + "conditions are closed.",
  findings: [
    {
      area: "CONSTRUCTION",
      title: "Collar attachment consistency",
      observation: "The rib collar sets unevenly across the back neck when it is attached "
        + "by hand, so the finished neckline differs from one garment to the next.",
      severity: "CONCERN",
      owner: "INDUSTRIAL_ENGINEERING",
      requiredAction: "Fix the collar attachment method and prove it holds over a run, "
        + "rather than on one sample.",
    },
    {
      area: "MACHINES",
      title: "Lockstitch and edge-stitch capability required",
      observation: "The placket and the collar edge both need a lockstitch and an "
        + "edge-stitch finish to hold their shape.",
      severity: "CONCERN",
      owner: "INDUSTRIAL_ENGINEERING",
      requiredAction: "Confirm both capabilities are on the line that will run this style.",
      availability: "AVAILABLE",
    },
    {
      area: "SKILLS",
      title: "Operator must control collar shape without stretching the neckline",
      observation: "The neckline grows if the collar is eased in under tension, and the "
        + "garment cannot be recovered once it has.",
      severity: "CONCERN",
      owner: "INDUSTRIAL_ENGINEERING",
      requiredAction: "Put the collar operation with an operator who has done rib necklines, "
        + "and show the handling before the run.",
    },
    {
      area: "MATERIALS",
      title: "Verify piqué relaxation and shrinkage after wash",
      observation: "The piqué relaxes after washing. How much is not yet recorded for this "
        + "fabric, so the finished measurements cannot be trusted yet.",
      severity: "CONCERN",
      owner: "RESEARCH_DEVELOPMENT",
      requiredAction: "Wash-test the approved fabric and record the relaxation and shrinkage.",
      availability: "NEED_TO_ARRANGE",
    },
    {
      area: "SPECIAL_PROCESSES",
      title: "Embroidery placement and backing must be confirmed",
      observation: "The chest embroidery needs a backing on a knit, and the placement has "
        + "to be reachable before the front is joined.",
      severity: "CONCERN",
      owner: "RESEARCH_DEVELOPMENT",
      requiredAction: "Confirm the backing and fix the placement on the approved fabric.",
    },
    {
      area: "QUALITY_RISK",
      title: "Collar symmetry and placket alignment are critical checkpoints",
      observation: "Both show immediately on a finished polo, and both are set earlier in "
        + "the sequence than the point they become visible.",
      severity: "CONCERN",
      owner: "INDUSTRIAL_ENGINEERING",
      requiredAction: "Check collar symmetry and placket alignment in process, not at the end.",
    },
  ],
  conditions: [
    {
      text: "R&D confirms the piqué shrinkage and the approved wash result",
      owner: "RESEARCH_DEVELOPMENT",
      requiredAction: "Record the wash test against the approved fabric.",
    },
    {
      text: "A pilot construction trial is run before bulk production",
      owner: "PRODUCTION",
      requiredAction: "Run a pilot on the collar and placket sequence and record what it showed.",
    },
  ],
});

/** Is the stored assessment the one this module writes? Matched on its own words. */
const isDemoAssessment = (assessment) => Boolean(assessment)
  && assessment.recommendation === DEMO_ASSESSMENT.recommendation;

/**
 * Record the demonstration assessment on an engineering file, or explain why not.
 *
 * @param {object} p
 * @param {Function} p.call   a caller for the IE router: (path, {method, body}) => {status, body}
 * @param {string} p.fileId   the engineering file to assess
 * @returns {Promise<{action: string, assessment: object|null, reason?: string}>}
 *   action is "created" | "already-present" | "refused"
 */
async function ensureDemoAssessment({ call, fileId } = {}) {
  if (typeof call !== "function" || !fileId) {
    throw new Error("ensureDemoAssessment needs a caller and a fileId");
  }

  const before = await call(`/engineering-files/${fileId}/feasibility`);
  if (before.status !== 200) {
    return { action: "refused", assessment: null,
      reason: `the assessment could not be read (${before.status})` };
  }
  const current = before.body.assessment;

  /* ── GUARD 1: SOMEBODY ELSE'S JUDGEMENT IS NOT OURS TO REPLACE ──────────── */
  if (current.assessed && !isDemoAssessment(current)) {
    return { action: "refused", assessment: current,
      reason: "this file already carries an assessment that this demonstration did not write" };
  }

  /* ── GUARD 2: ALREADY DONE ─────────────────────────────────────────────── */
  if (isDemoAssessment(current)) {
    return { action: "already-present", assessment: current };
  }

  const res = await call(`/engineering-files/${fileId}/feasibility`, {
    method: "PATCH",
    body: { expectedRevision: current.revision, ...DEMO_ASSESSMENT },
  });

  /* ── GUARD 3: A FILE THAT HAS STOPPED BEING A DRAFT ─────────────────────
     The route refuses this itself — a submitted file's assessment is frozen
     with the version under review, and an approved one is evidence. The
     refusal is reported rather than worked around. */
  if (res.status !== 200) {
    return { action: "refused", assessment: current,
      reason: `${res.status} ${res.body?.error?.code || ""} ${res.body?.message || ""}`.trim() };
  }
  return { action: "created", assessment: res.body.assessment };
}

module.exports = { DEMO_ASSESSMENT, isDemoAssessment, ensureDemoAssessment };
