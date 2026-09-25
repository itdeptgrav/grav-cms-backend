"use strict";
/**
 * services/budgetAllocationVocabulary.js
 *
 * THE WORDS A BUDGET ALLOCATION IS ALLOWED TO USE.
 *
 * ── WHY THIS IS A LEAF MODULE WITH NO REQUIRES ──────────────────────────────
 * These strings are needed in two very different places: the RESOLVER, which
 * reads ledgers and category mappings out of Mongo, and the two request
 * SCHEMAS, which need them for an enum and nothing else.
 *
 * Having the schemas import the resolver worked and was wrong. Requiring it
 * pulls in `Acc_ItemCategoryBudget` and `Acc_Ledger`, and registering a
 * mongoose model builds its indexes, which CREATES the collection. The
 * baseline audit distinguishes "this collection does not exist, so the feature
 * was never deployed" from "it exists and is empty" — and conflating those
 * makes an undeployed feature read as 0% coverage rather than as unknown. So
 * merely loading a request model started manufacturing that evidence.
 *
 * Hence: one file, no imports, safe to require from anywhere.
 * `itemBudgetHead.service.js` re-exports all of it, so callers that already
 * read the vocabulary off the resolver keep working and there is still exactly
 * one definition.
 */

/* ── WHERE A HEAD CAME FROM ─────────────────────────────────────────────────
 * These travel from the resolver through the Finance APIs into
 * `budgetAllocation.resolutionSource` on a request line, and into whatever
 * later reads that line. Renaming one means rewriting stored documents, so
 * they are named once, here, and re-used rather than retyped. */

/** Somebody decided THIS item is different from its category. */
const SOURCE_ITEM = "item_override";
/** The ordinary answer for a stocked item: finance mapped its category. */
const SOURCE_CATEGORY = "category_mapping";
/** The service's own configured head, from the Service Master. */
const SOURCE_SERVICE = "service_default";
/**
 * A human looked and chose — over a rule, or in the absence of one.
 *
 * Deliberately distinct from every derived source. A head a rule produced and
 * a head a person typed over the rule are different facts about how much to
 * trust the answer, and collapsing them makes "who decided this?"
 * unanswerable a year later, which is exactly when somebody asks.
 */
const SOURCE_MANUAL = "manual_selection";
/** Nobody has decided. An answer, not an error, and never a default. */
/**
 * The head the REQUEST itself was approved against.
 *
 * Not a line-level rule and deliberately not dressed as one. Before line-wise
 * allocation the request header's head was the only authority, and it is still
 * a real decision: the requester picked it from their own department's
 * approved lines and finance approved the request on it. A line whose own rule
 * produces nothing falls back to it rather than being refused — refusing would
 * make every request that predates item-wise mapping unapprovable.
 *
 * It is a distinct value precisely so nobody can later mistake "we used the
 * request's head because nothing else said otherwise" for "somebody classified
 * this line".
 */
const SOURCE_REQUEST_HEAD = "request_head";
const SOURCE_NONE = "unresolved";

const RESOLUTION_SOURCES = Object.freeze([
  SOURCE_ITEM, SOURCE_CATEGORY, SOURCE_SERVICE, SOURCE_MANUAL,
  SOURCE_REQUEST_HEAD, SOURCE_NONE,
]);

/* ── HOW SETTLED THE ANSWER IS ──────────────────────────────────────────────
 * `unresolved` means nobody has looked; `manual_selection_required` means
 * somebody has been asked and has not answered. The difference decides whether
 * a screen shows a prompt or a warning. */
const STATUS_RESOLVED = "resolved";
const STATUS_UNRESOLVED = "unresolved";
const STATUS_MANUAL_REQUIRED = "manual_selection_required";

const RESOLUTION_STATUSES = Object.freeze([
  STATUS_RESOLVED, STATUS_UNRESOLVED, STATUS_MANUAL_REQUIRED,
]);

/* ── WHICH RULES A REQUEST WAS RAISED UNDER ─────────────────────────────────
 * Service lines must be matched to the Service Master BEFORE finance approves.
 * That rule cannot be applied retroactively: thousands of requests were
 * approved without it, and refusing to order against them now would strand
 * real, already-committed work behind a rule nobody could have followed.
 *
 * So a request records the policy it was raised under. ABSENT means "raised
 * before this existed" — genuinely legacy, and eligible for the late-match
 * door on the service-order route. PRESENT means the request was created when
 * classification was required, and finance may not approve it unclassified.
 *
 * Absence is the legacy signal, which is why there is no default: a default
 * would stamp every historical document the moment it was loaded and saved,
 * quietly converting legacy requests into new-policy ones that can then never
 * be ordered.
 *
 * SERVER-CONTROLLED. A client that could send this could opt its own request
 * out of the rule, which is the whole rule.
 */
const SERVICE_CLASSIFICATION_POLICY = "service-classification-v1";

module.exports = {
  SERVICE_CLASSIFICATION_POLICY,
  SOURCE_ITEM,
  SOURCE_CATEGORY,
  SOURCE_SERVICE,
  SOURCE_MANUAL,
  SOURCE_REQUEST_HEAD,
  SOURCE_NONE,
  RESOLUTION_SOURCES,
  STATUS_RESOLVED,
  STATUS_UNRESOLVED,
  STATUS_MANUAL_REQUIRED,
  RESOLUTION_STATUSES,
};
