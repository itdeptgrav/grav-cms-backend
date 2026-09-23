// services/ppc/lineProcessRequirements.js
//
// WHAT SALES HAS APPROVED THAT ONE ORDER LINE NEEDS — EMBROIDERY, PRINT, WASH.
//
// ── WHY THIS IS A SEPARATE, TINY READER ─────────────────────────────────────
// IE declares a process route per STYLE. Two confirmed lines of one style can
// differ — one buyer wants a chest logo embroidered, the other does not — so
// a style route is not proof of a line's stages until it is checked against
// what Sales approved for THAT line. This module is the one place PPC reads
// that line-level statement, from the exact Sales handover version the plan's
// frozen execution pack names — never the line's current version.
//
// ── WHERE IT COMES FROM ─────────────────────────────────────────────────────
// `SalesHandoverVersion.executionProjection.processRequirements`, authored by
// Sales at issue (services/sales/lineProcessRequirement.js) and frozen with
// the version. A version issued before it existed has no such field and reads
// NOT_STATED — legacy handovers stay readable and unproven.
//
// ── FAIL-CLOSED, EVEN AGAINST A STORED RECORD ───────────────────────────────
// Sales validates at issue; this re-checks what is stored, because a reader
// that trusted its writer would pass whatever a future writer, a migration or
// a hand edit left behind. For each of EMBROIDERY, PRINTING and WASHING:
//   · missing, or stated more than once       → not stated
//   · UNKNOWN                                 → not stated
//   · REQUIRED / NOT_REQUIRED without the buyer's document (or, on a company
//     order, a named Sales authorisation with
//     its reason), or with no stated decision  → not stated
// and any OTHER process marked REQUIRED is UNMATCHABLE: its label is free
// text, so no route stage can be shown to be it. Nothing here reads an
// enquiry checkbox, a style flag or free text as an answer.
"use strict";

/** The buyer-specific processes. Cutting, sewing, finishing and packing are
    not buyer choices, so the style route alone governs them. */
const SPECIAL_PROCESSES = Object.freeze(["EMBROIDERY", "PRINTING", "WASHING"]);
const LINE_REQUIREMENT = Object.freeze({ REQUIRED: "REQUIRED", NOT_REQUIRED: "NOT_REQUIRED" });
const DEFINITE = Object.freeze(Object.values(LINE_REQUIREMENT));

const NOT_STATED_DETAIL =
  "Sales' approved handover for this line does not state whether it needs embroidery, printing or washing.";

const str = (v) => String(v ?? "").trim();
const word = (p) => p.toLowerCase();

/**
 * A definite answer something stands behind:
 *   BUYER_PO        the buyer's approved order, with the document they sent;
 *   INTERNAL_ORDER  a company order with no buyer — a named Sales approver
 *                   and a stated reason.
 * Either way the answer also says what was decided.
 */
const evidenced = (row) => {
  const e = row?.evidence;
  if (!e || !str(e.buyerApprovalRef) || !str(row.buyerSpecification)) return false;
  if (str(e.kind) === "BUYER_PO") return Boolean(str(e.documentRef));
  if (str(e.kind) === "INTERNAL_ORDER") return Boolean(str(e.authorisedById) && str(e.reason));
  return false;
};

/**
 * The line's approved special-process statement, read from ONE Sales handover
 * version document (already read, company-scoped, by the caller).
 *
 * @returns
 *   `{ state: "STATED", processes }`       all three proven
 *   `{ state: "NOT_STATED", processes, problems, detail }`
 *   `{ state: "UNMATCHABLE", processes, unmatchable, detail }`
 * `processes` holds only the answers that ARE proven, so a caller can still
 * show a contradiction on one process while another is unstated.
 */
function readStatement(handoverVersion) {
  const rows = handoverVersion?.executionProjection?.processRequirements?.processes;
  if (!Array.isArray(rows)) {
    return { state: "NOT_STATED", processes: null, problems: [], detail: NOT_STATED_DETAIL };
  }

  const processes = {};
  const problems = [];
  for (const process of SPECIAL_PROCESSES) {
    const own = rows.filter((r) => str(r?.process) === process);
    const requirement = str(own[0]?.requirement);
    let why = null;
    if (!own.length) why = "MISSING";
    else if (own.length > 1) why = "DUPLICATE";
    else if (requirement === "UNKNOWN") why = "UNKNOWN";
    else if (!DEFINITE.includes(requirement)) why = "INVALID";
    else if (!evidenced(own[0])) why = "NO_EVIDENCE";
    if (why) problems.push({ process, why });
    else processes[process] = requirement;
  }

  const unmatchable = rows
    .filter((r) => str(r?.process) === "OTHER" && str(r?.requirement) === LINE_REQUIREMENT.REQUIRED)
    .map((r) => str(r.otherLabel) || "an unnamed process");
  if (unmatchable.length) {
    return {
      state: "UNMATCHABLE", processes, problems, unmatchable,
      detail: `Sales states this line requires ${unmatchable.map((l) => `"${l}"`).join(", ")} — a process named in free text, which no IE route stage can be shown to be.`,
    };
  }
  if (problems.length) {
    const say = { MISSING: "is not stated", DUPLICATE: "is stated more than once", UNKNOWN: "is stated as unknown",
      INVALID: "has no valid answer", NO_EVIDENCE: "has an answer with no buyer approval behind it" };
    return {
      state: "NOT_STATED", processes, problems,
      detail: `In Sales' approved handover for this line, ${problems.map((p) => `${word(p.process)} ${say[p.why]}`).join("; ")}.`,
    };
  }
  return { state: "STATED", processes, problems: [], detail: null };
}

module.exports = { readStatement, SPECIAL_PROCESSES, LINE_REQUIREMENT, NOT_STATED_DETAIL };
