// services/merchandising/styleWork.service.js
//
// MERCHANDISING — WHAT IS WAITING FOR A MERCHANDISER RIGHT NOW.
//
// ── WHAT THIS IS, AND WHAT IT REFUSES TO INVENT ─────────────────────────────
// The Merchandising Overview and the Style Work queue are built here, from the
// facts the current records actually hold. There is no assignment model yet,
// no Time-and-Action calendar, no SLA and no readiness engine — so nothing
// here says "assigned to you", "due", "overdue", "at risk" or "ready". Those
// words would each need an authoritative field that does not exist, and a
// queue that guesses them is worse than a queue that does not have them.
//
// Five things ARE recorded, and each is a merchandiser's own next action:
//
//   MATERIALS_UNANSWERED         the style is AT `materials` — Sales has sent
//                                it over — its bill of materials has NOT been
//                                approved, no submission of it is sitting with
//                                Sales awaiting their decision, and the
//                                materials pick is still unsettled.
//   PACKAGING_APPROVAL_REQUIRED  a `materials.packagingSelections[]` row is
//                                still `proposed` — Merchandising's own
//                                approve/withdraw decision.
//   DEVELOPMENT_INCOMPLETE       a `DEVELOPMENT_TOOLING` requirement has a gap
//                                as `styleDevelopment.developmentGaps` defines
//                                one, OR the style has reached Merchandising
//                                and the section is empty — which is not "none
//                                needed", it is "nobody has looked".
//   BOM_APPROVAL_REJECTED        the Project Manager refused the BOM, with the
//                                note saying what Merchandising has to fix.
//
// Where a stage condition applies and why is set out at `STAGE` below.
//
// ── AND ONE THAT WAS PUBLISHED AND IS NOT ANY MORE ──────────────────────────
// `MATERIAL_RETURNED` reported `techSheet.technical.materials[].
// returnedToMaterials.reason` — R&D sending a material back for correction.
// The record proves that a return HAPPENED. Nothing in the schema proves it is
// still outstanding: the field is written once and thereafter only preserved —
// `mergeOntoApproved` carries it across every technical save, and no route,
// service or migration clears it. So a material returned in March was still
// being reported as this week's work, for ever, and nothing a merchandiser
// could do would make it stop.
//
// Resolution could have been inferred — a later edit, a stage move, an empty
// reason, a timestamp comparison — and every one of those would be a rule this
// application invented about a fact it does not own. A queue that cannot say
// when an item is finished is not a queue. It is removed from the published
// contract until R&D's record carries a resolution, which is a Product
// Development fact and a later chunk's to add.
//
// ── AND NOTHING ELSE LEAVES THIS FILE ───────────────────────────────────────
// Merchandising works from a STYLE. Company ownership is PROVED through the
// Sales parents, because that is where a SampleStyle's company lives — but no
// journey id, enquiry id, enquiry reference, customer, quotation, supplier,
// rate, cost, margin, tax, consumption, evidence, measurement, stock quantity,
// machine or production plan is read into a response. Every shape below is
// built field by field for exactly that reason, and the parent ids are not
// even projected out of the database.
//
// ── HOW THE QUERY STAYS BOUNDED ─────────────────────────────────────────────
// `SampleStyle` carries no `companyId`. Proving each style one at a time — the
// way `ownershipProofFor` does — is correct and is an N+1 read per row, which
// a work queue cannot afford. So the company's own parents are resolved FIRST,
// by `companyContext/merchandisingScope.service.js`, and every count and page
// is bounded by their ids before Mongo looks at a style. The derivation then
// runs on a projection holding only the fields the allowlist and the work rules
// need.
//
// The counts are per STYLE, never per row: one style with three proposed
// packaging components is one affected style, because it is one thing a person
// has to open.
"use strict";

const mongoose = require("mongoose");

const { fail } = require("../storePurchase/errors");
const { styleOwnershipClause } = require("../companyContext/merchandisingScope.service");
const packagingBom = require("../sales/packagingBom.service");
const styleDevelopment = require("./styleDevelopment.service");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

const model = (name, path) => (mongoose.models[name] || require(path));
const SampleStyle = () => model("SampleStyle", "../../models/CMS_Models/Sales/SampleStyle");

const CODES = Object.freeze({
  VALIDATION: "VALIDATION",
  COMPANY_CONTEXT_UNAVAILABLE: "COMPANY_CONTEXT_UNAVAILABLE",
});

/* ═══ THE WORK KINDS ═══════════════════════════════════════════════════════
 *
 * Stable codes. They are what a dashboard card links by and what a URL carries,
 * so they are part of the contract and outlive any wording change on screen.
 * Each one names a fact that IS stored — see the header for which.
 */
const WORK_KIND = Object.freeze({
  MATERIALS_UNANSWERED: "MATERIALS_UNANSWERED",
  PACKAGING_APPROVAL_REQUIRED: "PACKAGING_APPROVAL_REQUIRED",
  DEVELOPMENT_INCOMPLETE: "DEVELOPMENT_INCOMPLETE",
  BOM_APPROVAL_REJECTED: "BOM_APPROVAL_REJECTED",
});

/** Filter order, and the order actions are listed on a row. */
const WORK_KINDS = Object.freeze([
  WORK_KIND.MATERIALS_UNANSWERED,
  WORK_KIND.PACKAGING_APPROVAL_REQUIRED,
  WORK_KIND.DEVELOPMENT_INCOMPLETE,
  WORK_KIND.BOM_APPROVAL_REJECTED,
]);

/**
 * Pagination bounds.
 *
 * Conservative on purpose: this list is derived from a projection over a
 * company's whole style portfolio, and a caller asking for a thousand rows is
 * asking for a report, which is a later chunk with its own contract.
 */
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/* ═══ WHERE A STYLE IS, AND WHOSE WORK THAT MAKES IT ═══════════════════════
 *
 * `SAMPLE_STYLE_STAGES` is the routing position, and it is the only statement
 * the current records make about which desk is holding a style:
 *
 *   brief      carried from the enquiry and SENT NOWHERE YET. It is Sales'.
 *   materials  Sales pressed "Send to Merchandiser". It is Merchandising's.
 *   rnd        Sales pressed "Send to R&D", which the Project Manager's BOM
 *              approval gates. It is R&D's.
 *
 * That is not an interpretation. `PATCH /:id/stage` in the sample-style router
 * refuses `materials → rnd` from anybody but Sales, requires an approved BOM
 * for it, and — decisively — RESETS `materials.status` to `pending` when a
 * style is sent BACK to brief. A style pending at `brief` is pending because
 * Sales put it back, and telling a merchandiser to answer it would be telling
 * them to do somebody else's work on a style they have not been handed.
 *
 * A missing `stage` is not treated as `materials`. The field defaults to
 * `brief`, so a document without one predates the field entirely and the
 * schema's own answer for it is "brief" — the conservative reading, and the
 * one that cannot invent work.
 */
const STAGE = Object.freeze({ BRIEF: "brief", MATERIALS: "materials", RND: "rnd" });

/** The style is in Merchandising's hands right now. */
const WITH_MERCHANDISING = [STAGE.MATERIALS];

/**
 * The style has reached Merchandising — it is theirs now, or it passed through
 * them and went on.
 *
 * Used only where a question stays Merchandising's after the style moves on:
 * "has anybody said whether this needs development work" is unanswered whether
 * the style is sitting in Materials or already with R&D, and the costing input
 * map reads it as a Merchandising requirement with no stage condition at all
 * (`sourceAppRequirements.service.js`, DEVELOPMENT_REQUIREMENT_IDENTITY).
 */
const AT_OR_PAST_MERCHANDISING = [STAGE.MATERIALS, STAGE.RND];

/* ── THE RETIRED MATERIALS FLAG, NAMED SO IT CAN BE RETIRED ─────────────────
 *
 * `materials.status` is `pending` until a pick is settled, and it used to be
 * the whole answer. It is not one on its own any more: the precondition that
 * read it — "materials must be selected before the tech sheet starts" — was
 * removed on 26 Aug 2026 because it guarded a step that no longer exists, and
 * the gate the workflow now runs on is `bomApproval`.
 *
 * It is kept as one clause, in one place, with one name, because records
 * written under the old flow still carry it and nothing has migrated them.
 * When those records are settled or migrated, this constant is deleted and
 * nothing else moves.
 */
const LEGACY_MATERIALS_PICK_UNSETTLED = Object.freeze({
  "materials.status": { $ne: "selected" },
});

/** The JS half of the same clause, over a projected style. */
const legacyMaterialsPickUnsettled = (style) => (
  str(style?.materials?.status) !== "selected"
);

/* ═══ THE WORK RULES, AS QUERIES ═══════════════════════════════════════════ */

/**
 * The gap rules of `styleDevelopment.developmentGaps`, expressed as a Mongo
 * predicate so the queue can be paginated by the database.
 *
 * ── WHY BOTH FORMS EXIST ────────────────────────────────────────────────────
 * The rules live in one place — `developmentGaps` — and are reused to LABEL a
 * row. What a database cannot do is call that function while sorting and
 * limiting, so the same rules are also stated as a query. The two are held in
 * step by a test that walks a matrix of stored rows and asserts that matching
 * this predicate and having a gap are the same answer, every time.
 *
 * @param {Map} charges  this company's configured charges, by key, from
 *   `styleDevelopment.configuredCharges` — key, label, calculation and unit,
 *   and never an amount.
 */
function developmentGapPredicate(charges) {
  const activeKeys = [...charges.keys()];
  const perUnitKeys = [...charges.values()]
    .filter((c) => c.calculation === "PER_REQUIREMENT_UNIT")
    .map((c) => c.key);

  const included = { $ne: false };
  const blank = { $in: [null, ""] };

  const gaps = [
    /* Not applicable, and nobody said why. */
    { included: false, excludedReason: blank },
    /* Included, and the source question is unanswered. `$nin` matches an
       absent field too, which is what an unanswered row looks like. */
    { included, developmentSource: { $nin: styleDevelopment.SOURCES } },
    /* Bought outside, and no registered service is named. */
    { included, developmentSource: "SUPPLIER_QUOTATION", serviceId: { $in: [null] } },
    /* Done in-house, and no company charge is named. */
    { included, developmentSource: "COMPANY_POLICY", developmentChargeKey: blank },
  ];

  /* Done in-house against a charge this company no longer publishes. With no
     charges configured at all, every key is unknown — which is the truth. */
  gaps.push({
    included,
    developmentSource: "COMPANY_POLICY",
    developmentChargeKey: { $nin: [null, "", ...activeKeys] },
  });

  /* Charged per unit, and nobody said how many. `$not: {$gt: 0}` covers an
     absent quantity as well as a zero one — a blank quantity is not zero. */
  if (perUnitKeys.length) {
    gaps.push({
      included,
      developmentSource: "COMPANY_POLICY",
      developmentChargeKey: { $in: perUnitKeys },
      quantity: { $not: { $gt: 0 } },
    });
  }

  return {
    $or: [
      /* A row somebody wrote, which does not yet say enough to be priced. */
      {
        "sample.serviceRequirements": {
          $elemMatch: { purpose: styleDevelopment.PURPOSE, $or: gaps },
        },
      },
      /* ── AND SILENCE IS NOT "NONE NEEDED" ──────────────────────────────
         An empty Development section reads as "nobody has looked", which is
         exactly what it is. That is not a rule invented here: it is the
         contract the costing input map already states for this very
         requirement — `DEVELOPMENT_REQUIREMENT_IDENTITY` answers NOT_STARTED
         with "Nobody has said whether this style needs pattern, tooling or
         setup work" — and it is the contract the Development card renders.

         A style that genuinely needs no development work is answered by
         SAYING so: an excluded row with its required reason. That row exists,
         so it does not match this branch, and a not-applicable row WITHOUT a
         reason falls into the gap list above.

         Gated on stage, because at `brief` nobody has been asked yet. */
      {
        stage: { $in: AT_OR_PAST_MERCHANDISING },
        "sample.serviceRequirements": {
          $not: { $elemMatch: { purpose: styleDevelopment.PURPOSE } },
        },
      },
    ],
  };
}

/**
 * Is the Development section unanswered on this style?
 *
 * The JS half of `developmentGapPredicate`, over the projected row. Returns the
 * number of gapped rows and whether the section is empty, so a label can say
 * which of the two it is rather than merging them into one count.
 */
function developmentState(style, { charges }) {
  const rows = (style.sample?.serviceRequirements || []).filter(styleDevelopment.isDevelopment);
  const answered = rows.length > 0;
  const gapped = rows
    .map((row) => styleDevelopment.developmentRow(row))
    .filter((row) => styleDevelopment.developmentGaps(row, { charges }).length).length;
  return {
    unanswered: !answered && AT_OR_PAST_MERCHANDISING.includes(str(style.stage)),
    gapped,
  };
}

/**
 * One Mongo predicate per work kind.
 *
 * Every one of them names a field that is STORED. None derives a date, an
 * owner, a risk or a readiness — those facts do not exist yet, and a queue
 * that implied them would be the same defect this chunk exists to close.
 *
 * ── WHY ONLY TWO OF THE FIVE LOOK AT `stage` ────────────────────────────────
 * A stage condition is added where the stored workflow says the question has
 * not been PUT to Merchandising yet. That is true of the two things whose only
 * evidence is an ABSENCE — unselected materials, and an empty Development
 * section — because an absence on a style Sales has not sent over says nothing
 * about Merchandising at all.
 *
 * The other three have their own evidence, written by somebody, and it is that
 * record rather than the routing position that makes them Merchandising's:
 *
 *   · a `proposed` packaging selection exists only because a merchandiser
 *     created it, and only they can approve or withdraw it;
 *   · a returned material carries R&D's reason, addressed to Merchandising;
 *   · a rejected BOM carries the Project Manager's note saying what
 *     Merchandising has to fix — and the model records that this gate is a
 *     sub-state of `materials` rather than a stage of its own.
 *
 * Adding a stage filter to those would be inventing a lifecycle rule the
 * records do not state, and would hide work somebody explicitly handed over.
 */
function kindPredicates(charges) {
  return {
    /* ── MATERIALS ARE STILL THE MERCHANDISER'S TO ANSWER ─────────────
       Four conditions, and the newest is the one that decides it:

       · the style is AT `materials` — Sales has handed it over. A style at
         `brief` has not been sent to Merchandising at all, and one at `rnd`
         went on to R&D. See the STAGE block above for why this is the
         records' own statement rather than an assumption.
       · the BILL OF MATERIALS IS NOT APPROVED. `bomApproval` is the gate the
         active workflow actually runs on — `materials → rnd` is refused
         without it — and an approved BOM is the Project Manager's signature
         on the very pick this kind claims is unmade. It is the authoritative
         CLOSING fact, and it outranks the flag below.
       · no submission is sitting with Sales awaiting their decision — the
         merchandiser has done their part and the next move is somebody
         else's, so listing it as their work would be untrue.
       · and the legacy flag, isolated and named. */
    [WORK_KIND.MATERIALS_UNANSWERED]: {
      stage: { $in: WITH_MERCHANDISING },
      "bomApproval.status": { $ne: "approved" },
      materialsChangeLog: { $not: { $elemMatch: { status: "pending" } } },
      ...LEGACY_MATERIALS_PICK_UNSETTLED,
    },
    /* ── A PROPOSED COMPONENT IS MERCHANDISING'S OWN DECISION ─────────
       It is the one selection state `packagingBom.merchandisingHandoff`
       reports as AWAITING_APPROVAL, and the lifecycle word comes from that
       module rather than being spelled again here, so the two cannot drift.

       The handoff FUNCTION is deliberately not called: it needs the merged
       row, and merging needs `sample.packagingRequirements` — R&D's
       consumption, unit, basis and evidence. Reading those into memory to
       derive "somebody proposed a bag" would put the whole of R&D's record
       one careless spread away from a Merchandising response. The selection's
       own status answers the question on its own. */
    [WORK_KIND.PACKAGING_APPROVAL_REQUIRED]: {
      "materials.packagingSelections": { $elemMatch: { status: packagingBom.PROPOSED } },
    },
    [WORK_KIND.DEVELOPMENT_INCOMPLETE]: developmentGapPredicate(charges),
    /* The BOM approval gate came back refused. `bomApproval.note` is
       required on a rejection and says what Merchandising has to fix. */
    [WORK_KIND.BOM_APPROVAL_REJECTED]: { "bomApproval.status": "rejected" },
  };
}

/* ═══ WHAT LEAVES THE SERVICE ══════════════════════════════════════════════ */

/**
 * The only fields the projection asks for.
 *
 * ── FIELD BY FIELD, INCLUDING INSIDE THE ARRAYS ─────────────────────────────
 * `journeyId` and `enquiryId` are deliberately absent: ownership is proved by
 * the bound before the query runs, so the parent ids are never in memory here
 * and cannot be spread into a response by a later edit.
 *
 * `sample.serviceRequirements` is asked for by SUBFIELD rather than whole.
 * Taking the array wholesale pulled in every requirement's specification,
 * notes, billing unit, basis, evidence and owner — Production's outside
 * processes included — to answer one question about completeness. Listed here
 * are exactly the seven fields `styleDevelopment.developmentGaps` reads to
 * DECIDE, and no more; the free text it uses to phrase a message is not among
 * them, because this file counts gaps and never publishes their wording.
 *
 * The same discipline applies to R&D's technical materials: the returned
 * reason and the item's name, never the consumption, unit, allowance,
 * specification or evidence sitting beside them on the same subdocument.
 */
const PROJECTION = [
  "_id sampleStyleId styleCode productName variantLabel updatedAt stage",
  "materials.status materials.packagingSelections.status",
  "materialsChangeLog.status",
  "sample.serviceRequirements.purpose",
  "sample.serviceRequirements.included",
  "sample.serviceRequirements.excludedReason",
  "sample.serviceRequirements.developmentSource",
  "sample.serviceRequirements.serviceId",
  "sample.serviceRequirements.developmentChargeKey",
  "sample.serviceRequirements.quantity",
  "bomApproval.status bomApproval.note",
].join(" ");

/** A sentence, not a database value. Truncated so a pasted essay cannot become a row. */
const reasonText = (v) => str(v).slice(0, 300);

/**
 * The actions currently open on one style, in a stable order.
 *
 * Derived from the SAME stored facts the predicates query, so a row that the
 * database selected always carries at least one action, and a style with three
 * open things carries three.
 */
function actionsFor(style, { charges }) {
  const out = [];

  const stage = str(style.stage);
  /* The Project Manager's signature on this very pick. It closes the question
     whatever the retired flag still says. */
  const bomApproved = str(style.bomApproval?.status) === "approved";
  const materialsWithSales = (style.materialsChangeLog || [])
    .some((entry) => str(entry?.status) === "pending");
  if (WITH_MERCHANDISING.includes(stage)
    && !bomApproved
    && !materialsWithSales
    && legacyMaterialsPickUnsettled(style)) {
    out.push({
      kind: WORK_KIND.MATERIALS_UNANSWERED,
      label: "Materials not selected yet",
    });
  }

  const proposed = (style.materials?.packagingSelections || [])
    .filter((row) => str(row?.status) === packagingBom.PROPOSED).length;
  if (proposed) {
    out.push({
      kind: WORK_KIND.PACKAGING_APPROVAL_REQUIRED,
      label: proposed === 1
        ? "1 packaging component awaiting your approval"
        : `${proposed} packaging components awaiting your approval`,
    });
  }

  /* Unanswered and incomplete are the same work kind and different sentences.
     "Nobody has said whether this style needs development work" tells a person
     to open the section; "two requirements are incomplete" tells them what to
     finish. Collapsing them into one count would say the second when the first
     is true. */
  const development = developmentState(style, { charges });
  if (development.unanswered) {
    out.push({
      kind: WORK_KIND.DEVELOPMENT_INCOMPLETE,
      label: "Nobody has said whether this style needs development or tooling work",
    });
  } else if (development.gapped) {
    out.push({
      kind: WORK_KIND.DEVELOPMENT_INCOMPLETE,
      label: development.gapped === 1
        ? "1 development requirement is incomplete"
        : `${development.gapped} development requirements are incomplete`,
    });
  }

  /* A returned material used to be reported here. It is not, and the header
     says why: nothing in the record clears one, so it could only ever have
     been reported for ever. */

  if (str(style.bomApproval?.status) === "rejected") {
    out.push({
      kind: WORK_KIND.BOM_APPROVAL_REJECTED,
      label: "The bill of materials was rejected",
      ...(str(style.bomApproval?.note) ? { reason: reasonText(style.bomApproval.note) } : {}),
    });
  }

  return out;
}

/**
 * WHAT A MERCHANDISING WORK ROW MAY CONTAIN.
 *
 * Built field by field. A spread of the stored document would publish the
 * journey, the enquiry, the sample lifecycle and R&D's measurements the first
 * time somebody stopped reading this function.
 */
function workRow(style, actions) {
  return {
    styleId: str(style._id),
    styleRef: str(style.sampleStyleId),
    styleCode: str(style.styleCode),
    productName: str(style.productName),
    variantLabel: str(style.variantLabel),
    updatedAt: style.updatedAt || null,
    actions,
  };
}

/* ═══ CURSOR ═══════════════════════════════════════════════════════════════ */

/**
 * An opaque cursor over the deterministic sort `updatedAt DESC, _id DESC`.
 *
 * Opaque because it is a position in a result set, not a filter a caller may
 * compose: it encodes the last row of the previous page and nothing else. Two
 * styles saved in the same millisecond are separated by `_id`, so no row can be
 * skipped or repeated at a page boundary.
 *
 * It is NOT signed, and it does not need to be: it names a moment and a style
 * that the company bound has to re-prove on the next request anyway. A forged
 * cursor can move somebody within their OWN list and reaches nothing else.
 */
function encodeCursor(row) {
  const at = row?.updatedAt ? new Date(row.updatedAt).getTime() : 0;
  return Buffer.from(`${at}.${str(row?._id)}`, "utf8").toString("base64url");
}

/** A malformed cursor is refused by name — never ignored, which would silently
 *  restart the list at page one and look like duplicated work. */
function decodeCursor(raw) {
  const value = str(raw);
  if (!value) return null;
  let decoded = "";
  try {
    decoded = Buffer.from(value, "base64url").toString("utf8");
  } catch {
    decoded = "";
  }
  const [at, id] = decoded.split(".");
  const millis = Number(at);
  if (!Number.isFinite(millis) || millis < 0 || !isId(id)) {
    throw fail(CODES.VALIDATION, "That page marker is not one this list issued.", { field: "cursor" });
  }
  return { updatedAt: new Date(millis), id: new mongoose.Types.ObjectId(id) };
}

/** The clause that resumes the sort after the cursor's row. */
const afterCursor = (cursor) => (cursor
  ? {
    $or: [
      { updatedAt: { $lt: cursor.updatedAt } },
      { updatedAt: cursor.updatedAt, _id: { $lt: cursor.id } },
    ],
  }
  : null);

/* ═══ SEARCH ═══════════════════════════════════════════════════════════════ */

/**
 * The three references a merchandiser recognises a style by.
 *
 * The term is escaped before it becomes a regular expression: an unescaped
 * `(` is a syntax error the caller can trigger, and an unescaped `.*` is a
 * scan somebody else pays for.
 */
function searchClause(q) {
  const term = str(q);
  if (!term) return null;
  const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  return { $or: [{ productName: rx }, { styleCode: rx }, { sampleStyleId: rx }] };
}

/* ═══ THE TWO READS ════════════════════════════════════════════════════════ */

function assertContext(ctx) {
  if (!ctx?.companyId) {
    throw fail(CODES.COMPANY_CONTEXT_UNAVAILABLE, "Your company could not be resolved.");
  }
}

/**
 * THE OVERVIEW — FACTUAL, STYLE-LEVEL COUNTS.
 *
 * Every figure is a count of STYLES matching one stored condition, and every
 * figure has a queue behind it that returns exactly those styles. Nothing is a
 * percentage, a trend, a risk or a deadline.
 *
 * `generatedAt` is stated because a count is an answer at a moment; a screen
 * that shows a number with no as-of time invites somebody to quote it an hour
 * later.
 */
async function overview(ctx) {
  assertContext(ctx);
  const bound = await styleOwnershipClause(ctx.companyId);
  const generatedAt = new Date();

  /* An empty company is a truthful set of zeroes, not an error and not an
     empty screen: "nothing is outstanding" is a real and useful answer. */
  if (!bound) {
    const counts = { activeStyles: 0, stylesWithAction: 0 };
    for (const kind of WORK_KINDS) counts[kind] = 0;
    return { generatedAt, counts };
  }

  const charges = await styleDevelopment.configuredCharges(ctx.companyId);
  const predicates = kindPredicates(charges);

  const [activeStyles, stylesWithAction, ...perKind] = await Promise.all([
    SampleStyle().countDocuments(bound),
    SampleStyle().countDocuments({
      ...bound,
      $and: [{ $or: WORK_KINDS.map((kind) => predicates[kind]) }],
    }),
    ...WORK_KINDS.map((kind) => SampleStyle().countDocuments({ ...bound, $and: [predicates[kind]] })),
  ]);

  const counts = { activeStyles, stylesWithAction };
  WORK_KINDS.forEach((kind, i) => { counts[kind] = perKind[i]; });
  return { generatedAt, counts };
}

/**
 * THE STYLE WORK QUEUE — ONE ROW PER STYLE WITH SOMETHING OPEN.
 *
 * A style with three open things appears ONCE, carrying three actions. The
 * selection, the sort and the page all happen in the database; the derivation
 * that turns a stored row into a label runs on the page that came back, and on
 * nothing else.
 */
async function work(ctx, { q = "", kind = "", limit, cursor } = {}) {
  assertContext(ctx);

  const wanted = str(kind).toUpperCase();
  if (wanted && !WORK_KINDS.includes(wanted)) {
    /* Refused by name rather than ignored. A filter silently dropped returns
       the whole list, which reads as "everything matches this filter". */
    throw fail(CODES.VALIDATION, "That is not a kind of Merchandising work.", { field: "kind" });
  }

  const asked = limit === undefined || limit === null || limit === "" ? DEFAULT_LIMIT : Number(limit);
  if (!Number.isFinite(asked) || asked < 1 || Math.floor(asked) !== asked) {
    throw fail(CODES.VALIDATION, "Ask for a whole number of rows.", { field: "limit" });
  }
  const size = Math.min(asked, MAX_LIMIT);

  const after = decodeCursor(cursor);
  const bound = await styleOwnershipClause(ctx.companyId);
  if (!bound) {
    return { rows: [], kinds: WORK_KINDS, nextCursor: null, hasMore: false, limit: size };
  }

  const charges = await styleDevelopment.configuredCharges(ctx.companyId);
  const predicates = kindPredicates(charges);
  const kinds = wanted ? [wanted] : WORK_KINDS;

  /* Every added condition goes into `$and` so it can never displace the
     ownership bound — the failure mode of merging two `$or`s into one. */
  const filter = { ...bound, $and: [{ $or: kinds.map((k) => predicates[k]) }] };
  const search = searchClause(q);
  if (search) filter.$and.push(search);
  const resume = afterCursor(after);
  if (resume) filter.$and.push(resume);

  /* One row more than asked for, so "is there another page" is answered by
     the database rather than guessed from a full page. */
  const found = await SampleStyle().find(filter)
    .select(PROJECTION)
    .sort({ updatedAt: -1, _id: -1 })
    .limit(size + 1)
    .lean();

  const page = found.slice(0, size);
  const rows = page.map((style) => {
    const actions = actionsFor(style, { charges });
    /* Narrowed to the requested kind so a filtered row states the reason it
       is in THIS list, rather than everything else that is also open on it. */
    return workRow(style, wanted ? actions.filter((a) => a.kind === wanted) : actions);
  });

  return {
    rows,
    kinds: WORK_KINDS,
    limit: size,
    hasMore: found.length > size,
    nextCursor: found.length > size ? encodeCursor(page[page.length - 1]) : null,
  };
}

module.exports = {
  CODES, WORK_KIND, WORK_KINDS, DEFAULT_LIMIT, MAX_LIMIT, PROJECTION,
  STAGE, WITH_MERCHANDISING, AT_OR_PAST_MERCHANDISING,
  LEGACY_MATERIALS_PICK_UNSETTLED, legacyMaterialsPickUnsettled,
  developmentGapPredicate, developmentState, kindPredicates,
  actionsFor, workRow, searchClause, encodeCursor, decodeCursor,
  overview, work,
};
