// services/followUps/styleFollowUps.js
//
// THE AUTOMATIC FOLLOW-UPS OF A STYLE IN DEVELOPMENT (9 Oct 2026).
//
// A style moves Sales → Merchandising (fill the BOM) → the production manager
// (approve the BOM) → Design/R&D (tech sheet, then the sample). Each hand-off
// already sent a one-way email to a department; none left anything behind
// that had a person, a date, or a way to see that it was still waiting. Each
// hand-off now also opens a follow-up for a named person, and the step that
// answers it closes it:
//
//   brief → materials          opens  bom_needed      (Merchandising)
//   BOM approval requested     closes bom_needed / bom_fix, opens bom_approval (production manager)
//   BOM approved               closes bom_approval
//   BOM rejected               closes bom_approval, opens bom_fix (Merchandising, with the reason)
//   → rnd                      opens  tech_sheet       (R&D)
//   tech sheet submitted       closes tech_sheet
//   tech sheet changes asked   opens  tech_sheet (kind tech_sheet_changes, with the note)
//   tech sheet approved        opens  sample           (R&D)
//   sample submitted           closes sample
//   sample rejected            opens  sample (kind sample_rework, with the note)
//   sample approved            closes sample
//   material sent back by R&D  opens  material_returned (Merchandising, one per material)
//   style sent BACK a stage    closes every automatic follow-up of the style
//
// Every entry point is fire-and-forget and swallows its own errors: a
// follow-up failing must never fail the hand-off that triggered it.
"use strict";

const svc = require("./followUps.service");

const idOf = (ref) => (ref && ref.id ? { id: String(ref.id), name: ref.name || "" } : null);

function subjectOf(style) {
  return {
    type: "style",
    id: String(style._id),
    label: style.productName || "",
    code: style.styleCode || style.sampleStyleId || "",
  };
}

function nameOf(style) {
  return style.productName || style.styleCode || style.sampleStyleId || "this style";
}

/** People who already worked on this style in R&D, most recent first. */
function rndPeople(style) {
  const t = style.techSheet?.technical;
  const last = (list) => (Array.isArray(list) && list.length ? list[list.length - 1] : null);
  return [
    idOf(last(style.sample?.revisions)?.submittedBy),
    idOf(t?.submittedBy), idOf(t?.startedBy),
    idOf(last(style.techSheet?.technicalRevisions)?.submittedBy),
  ].filter(Boolean);
}

/** The merchandiser who chose this style's materials. */
function merchPeople(style) {
  return [idOf(style.materials?.selectedBy)].filter(Boolean);
}

function run(label, fn) {
  Promise.resolve()
    .then(fn)
    .catch((err) => console.warn(`[styleFollowUps] ${label} failed:`, err?.message || err));
}

/** PATCH /:id/stage, after the save. */
function onStage(style, from, to, { backward = false, reason = "" } = {}) {
  run("stage", async () => {
    const id = String(style._id);
    if (backward) {
      await svc.closeAllAutoFor("style", id, `The style was sent back to ${to}${reason ? `: ${reason}` : ""}.`);
    }
    if (to === "materials" && from === "brief") {
      await svc.raiseAuto({
        kind: "bom_needed", key: `bom_needed:${id}`, subject: subjectOf(style), fromDept: "sales",
        title: `Fill the BOM — ${nameOf(style)}`,
        detail: "Sales sent this style to Merchandising. Fill in its raw materials (BOM) so the production manager can approve it.",
        dueAt: style.materials?.deadline, prefer: merchPeople(style),
      });
    }
    if (to === "rnd" && from !== "rnd") {
      await svc.closeAuto(`bom_approval:${id}`, "The style went on to R&D.");
      await svc.closeAuto(`bom_needed:${id}`, "The style went on to R&D.");
      await svc.raiseAuto({
        kind: "tech_sheet", key: `tech_sheet:${id}`, subject: subjectOf(style), fromDept: "sales",
        title: `Tech sheet — ${nameOf(style)}`,
        detail: "The BOM is approved and the style is with R&D. Prepare and submit the tech sheet.",
        dueAt: style.techSheet?.dueDate, prefer: rndPeople(style),
      });
    }
  });
}

/** POST /:id/bom-approval/request, once the request went out. */
function onBomRequested(style) {
  run("bom request", async () => {
    const id = String(style._id);
    await svc.closeAuto(`bom_needed:${id}`, "The BOM was sent to the production manager for approval.");
    await svc.closeAuto(`bom_fix:${id}`, "The revised BOM was sent for approval again.");
    await svc.raiseAuto({
      kind: "bom_approval", key: `bom_approval:${id}`, subject: subjectOf(style), fromDept: "merchandiser",
      title: `Approve the BOM — ${nameOf(style)}`,
      detail: "Merchandising filled the BOM and Sales asked for your approval. Approve or reject it from the email, or tell them here what is missing.",
      dueAt: style.bomApproval?.deadline,
    });
  });
}

/** The public BOM decision page, after the decision is saved. */
function onBomDecided(style, decision, note) {
  run("bom decision", async () => {
    const id = String(style._id);
    await svc.closeAuto(`bom_approval:${id}`, decision === "approve" ? "Approved from the email." : `Rejected from the email: ${note}`);
    if (decision !== "approve") {
      await svc.raiseAuto({
        kind: "bom_fix", key: `bom_fix:${id}`, subject: subjectOf(style), fromDept: "ppc",
        title: `BOM rejected — revise it — ${nameOf(style)}`,
        detail: note ? `The production manager rejected the BOM: ${note}` : "The production manager rejected the BOM.",
        prefer: merchPeople(style),
      });
    }
  });
}

/** POST /:id/tech-sheet, after the save. */
function onTechSheet(style, action, note = "") {
  run("tech sheet", async () => {
    const id = String(style._id);
    if (action === "submit") {
      await svc.closeAuto(`tech_sheet:${id}`, "R&D submitted the tech sheet.");
    } else if (action === "changes") {
      await svc.raiseAuto({
        kind: "tech_sheet_changes", key: `tech_sheet:${id}`, subject: subjectOf(style), fromDept: "sales",
        title: `Tech sheet — changes asked — ${nameOf(style)}`,
        detail: note ? `Changes asked: ${note}` : "Sales asked for changes to the tech sheet.",
        prefer: rndPeople(style),
      });
    } else if (action === "approve") {
      await svc.closeAuto(`tech_sheet:${id}`, "The tech sheet was approved.");
      await svc.raiseAuto({
        kind: "sample", key: `sample:${id}`, subject: subjectOf(style), fromDept: "sales",
        title: `Make the sample — ${nameOf(style)}`,
        detail: "The tech sheet is approved. Make the sample and submit it for approval.",
        dueAt: style.sample?.dueDate, prefer: rndPeople(style),
      });
    }
  });
}

/** POST /:id/sample, after the save. */
function onSample(style, action, note = "") {
  run("sample", async () => {
    const id = String(style._id);
    if (action === "submit") {
      await svc.closeAuto(`sample:${id}`, "R&D submitted the sample.");
    } else if (action === "approve") {
      await svc.closeAuto(`sample:${id}`, "The sample was approved.");
    } else if (action === "reject") {
      await svc.raiseAuto({
        kind: "sample_rework", key: `sample:${id}`, subject: subjectOf(style), fromDept: "sales",
        title: `Sample rejected — rework — ${nameOf(style)}`,
        detail: note ? `Rejected: ${note}` : "The sample was rejected.",
        prefer: rndPeople(style),
      });
    }
  });
}

/** POST /:id/technical/materials/return, after the save. */
function onMaterialReturned(style, row, reason, by) {
  run("material returned", async () => {
    const id = String(style._id);
    await svc.raiseAuto({
      kind: "material_returned", key: `material_returned:${id}:${row.rawItemId}`, subject: subjectOf(style), fromDept: "research-development",
      title: `${row.rawItemName || "A material"} sent back by R&D — ${nameOf(style)}`,
      detail: `${by?.name || "R&D"} sent this material back: ${reason}`,
      prefer: merchPeople(style),
    });
  });
}

module.exports = { onStage, onBomRequested, onBomDecided, onTechSheet, onSample, onMaterialReturned, subjectOf };
