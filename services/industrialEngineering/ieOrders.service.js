// services/industrialEngineering/ieOrders.service.js
//
// INDUSTRIAL ENGINEERING — CHUNK 1B. THE ORDER-WISE WORKLIST, READ ONLY.
//
// ── WHICH RECORD IS "AN IE ORDER" ───────────────────────────────────────────
// The repository holds two competing things a person might call an order, and
// this file picks ONE and says which:
//
//   · `WorkOrder` — the record production is actually authorised and driven
//     from. It carries `workOrderNumber`, an execution `status`, the separate
//     `planningState` axis, a planned start/end timeline, the operation
//     snapshot, and it is the unit `ProductionSchedule.scheduledWorkOrders[]`
//     books capacity against. THIS IS THE IE ORDER.
//
//   · `CustomerRequest` — what the Project Manager's screens label
//     "Manufacturing Order". It is a CUSTOMER order: customer identity and
//     contact, quotations, quotation items with unit prices, payment receipts,
//     payment schedules and uploaded purchase orders. IE was told not to treat
//     a customer order, quotation or PO as its order, and every commercial
//     field on it is one this boundary must refuse.
//
// So `CustomerRequest` is used INTERNALLY and only as a join hop — it is the
// record that stores `items[].sampleStyleId`, which is one of the two provable
// paths from an order to a style. Nothing on it is published, not even its id:
// publishing `customerRequestId` would hand out the key to a customer record.
//
// The two are NOT merged. One work order is one IE order; several work orders
// raised from one customer request are several IE orders, because that is what
// production plans and schedules.
//
// ── AND HOW AN ORDER IS PROVED TO BE THIS COMPANY'S ─────────────────────────
// It is not proved from the order. `WorkOrder` has no `companyId`, and neither
// does `CustomerRequest`, `Customer` or `StockItem` — a filter on a field none
// of them has would match nothing and the empty list would read as successful
// isolation, which the Chunk 0 audit names as a migration hazard in its own
// right.
//
// The only company fact reachable from here is the one Chunk 1A already
// proves: a `SampleStyle` belongs to a company through its Sales parents. So
// AN ORDER IS THIS COMPANY'S WHEN A STYLE PROVABLY LINKED TO IT IS. An order
// no style can be linked to cannot be attributed to anybody and is not listed
// — that is a fail-closed refusal, not an empty answer, and it is reported in
// the module's own limitations rather than hidden.
//
// ── NOTHING IS GUESSED, AND NOTHING IS WRITTEN ──────────────────────────────
// There is no save, update, findOneAndUpdate, bulkWrite or backfill in this
// file, and the router above it exposes no verb that could reach one. No order
// is created, no style or route is touched, no SAM is recalculated or stored,
// and no schema changes.
"use strict";

const mongoose = require("mongoose");

const { fail } = require("../storePurchase/errors");
const {
  styleOwnershipClause, styleOwnerFrom,
} = require("../companyContext/merchandisingScope.service");
const orderStyleLink = require("./orderStyleLink");
const { STATUS_CLASS, statusClassOf } = require("./orderStatus");
const { styleLifecycleOf } = require("./styleLifecycle");
const { normalizePlanningState } = require("../../constants/workOrderPlanningState");
const ieRead = require("./ieRead.service");
const routeComparison = require("./routeComparison");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));
const oid = (v) => new mongoose.Types.ObjectId(str(v));

const model = (name, path) => (mongoose.models[name] || require(path));
const WorkOrder = () => model("WorkOrder", "../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = () => model("CustomerRequest", "../../models/Customer_Models/CustomerRequest");
const SampleStyle = () => model("SampleStyle", "../../models/CMS_Models/Sales/SampleStyle");

const CODES = Object.freeze({
  NOT_FOUND: "NOT_FOUND",
  VALIDATION: "VALIDATION",
  COMPANY_CONTEXT_UNAVAILABLE: "COMPANY_CONTEXT_UNAVAILABLE",
});

/** One indistinguishable refusal for absent, foreign and unprovable alike. */
const orderNotFound = () => fail(CODES.NOT_FOUND, "That order was not found.");

/* ── ONE VOCABULARY, SHARED WITH THE AUDIT ──────────────────────────────────
 * These were declared here and re-declared in the Chunk 1C classifier, which is
 * how the endpoint came to admit a conflicting order the audit counted as
 * clean. They now live in `orderStyleLink.js` and BOTH callers read them from
 * there, so the two cannot describe the same order differently. Re-exported
 * below so no existing importer breaks. */
const { LINE_RESOLUTION, STYLE_LINK, STYLE_LINK_STATUS, COMPANY_ATTRIBUTION } = orderStyleLink;
/* The approved IE operation standard, resolved through the file's own pointer
   and nothing else — see `approvedStandard.service.js`. */
const {
  STANDARD_STATE, STANDARD_SOURCE, approvedStandardsFor, standardSummaryOf,
} = require("./approvedStandard.service");
const { resolveOrderLine, resolveOrderStyleLink } = orderStyleLink;

/** Where one style stands as an engineering unit. */
const STYLE_READINESS = Object.freeze({
  /* A route exists, every row of it is timed, no row is unidentified, and the
     two stored sources do not contradict each other. */
  READY: "READY",
  /* Something is recorded and something is missing. */
  INCOMPLETE: "INCOMPLETE",
  /* The sources cannot be compared at all — see Chunk 1A's comparison states. */
  AMBIGUOUS: "AMBIGUOUS",
  /* Neither source holds a route. Not "zero minutes"; nobody has started. */
  NOT_STARTED: "NOT_STARTED",
});

/** Where the whole order stands. */
const ORDER_READINESS = Object.freeze({
  READY: "READY",
  BLOCKED: "BLOCKED",
  NOT_STARTED: "NOT_STARTED",
  /* No style could be proved to belong to this order, so nothing about its
     engineering can be claimed either way. Never reported as ready. */
  UNKNOWN: "UNKNOWN",
});

const GAP_OWNER = ieRead.GAP_OWNER;

/**
 * ── LINE PLANNING HAS NO STORED SOURCE, AND THAT IS SAID OUT LOUD ──────────
 *
 * The order row is asked for line-planning readiness "only where a truthful
 * stored source exists". There is none. No model in this repository holds a
 * production line, a station assignment, a balance or a line-level plan —
 * `CanvasLayout` is the supervisor's PHYSICAL floor layout with machine
 * positions and canvas state, which the Chunk 0 audit is explicit is not an IE
 * line-balance standard and must not be adopted as one.
 *
 * So the field is published as an explicit unavailable state rather than as a
 * plausible-looking `false`, `0` or `"NOT_PLANNED"` — each of which is a claim
 * about work nobody has recorded.
 */
const LINE_PLANNING = Object.freeze({
  available: false,
  state: "UNAVAILABLE",
  limitation: "NO_LINE_PLANNING_SOURCE",
  message: "No line plan, station assignment or line-balance record exists in this system yet, so "
    + "line-planning readiness cannot be reported for any order. The supervisor's physical floor "
    + "layout is not an engineering line standard and is deliberately not read here.",
});

/* ═══ CONTEXT AND PAGING ═══════════════════════════════════════════════════ */

function assertContext(ctx) {
  if (!ctx?.companyId) {
    throw fail(CODES.COMPANY_CONTEXT_UNAVAILABLE, "Your company could not be resolved.");
  }
}

/* The page bounds are Chunk 1A's, not a second set: one department, one answer
   to "how many rows may I ask for". */
const { DEFAULT_LIMIT, MAX_LIMIT, pageSize, encodeCursor, decodeCursor } = ieRead;

/* ── LANE A — OWNERSHIP IS PERMANENT, QUEUE PARTICIPATION IS NOT ────────────
 *
 * Every ownership read in this file passes `activeOnly: false`, which is the
 * option the shared rule already carries: it drops the `isActive` and
 * terminal-status clauses and decides on PARENTAGE alone. Nothing else about
 * the rule changes — a named journey is still authoritative, an enquiry still
 * answers only for a style with no journey, and a missing, dangling or
 * company-less journey is still unprovable.
 *
 * ── WHY IE NEEDS THAT AND MERCHANDISING DOES NOT ───────────────────────────
 * A company owns a record permanently; a work queue holds what somebody still
 * has to do. Conflating the two made a live production order vanish because
 * somebody closed the development record behind it — the Chunk 1C audit
 * measured FIVE of the seven agreeing orders lost exactly that way. Of the
 * other two, one was already attributable and one is refused for unprovable
 * parentage, which is a separate fault this mode deliberately leaves alone.
 *
 * Merchandising's own callers pass nothing and therefore still get
 * `activeOnly: true`. Their behaviour is unchanged by construction: this file
 * is the only caller that opts out, and the option predates it. */
const OWNERSHIP_MODE = Object.freeze({ activeOnly: false });

/* ═══ COMPANY OWNERSHIP OF AN ORDER ════════════════════════════════════════ */

/**
 * The filter that binds a `WorkOrder` query to one company.
 *
 * Expressed the same way `styleOwnershipClause` expresses the style bound: the
 * company's own provable records are resolved first, in bounded reads, and the
 * order query is limited to the ids they name before Mongo looks at a work
 * order. There is no company field on `WorkOrder` to filter by and none is
 * pretended.
 *
 * @returns {Promise<{clause: object, styleIds: Set<string>}|null>} `null` when
 *   this company can prove no order at all — a truthful empty list, not an
 *   error, and not everybody else's orders.
 */
/**
 * The company that provably owns each of a set of styles.
 *
 * The ACCEPTED rule, applied row-wise via the shared `styleOwnerFrom` — the
 * same four clauses `styleOwnershipClause` carries as a query, including the
 * `isActive` flag, the terminal-status exclusion, and the refusal to fall back
 * to an enquiry when a journey is named but unprovable.
 *
 * It resolves styles belonging to ANY company, deliberately. Deciding whether
 * two references reach one company means knowing who owns the style on the
 * other end even when that owner is somebody else — and a foreign owner here
 * produces a refusal, never a disclosure: nothing about those styles leaves
 * this function except the fact that they are not the caller's.
 */
async function styleOwnersFor(styleIds) {
  const wanted = [...new Set(styleIds.map(str).filter(isId))];
  if (!wanted.length) return new Map();

  const styles = await SampleStyle().find({ _id: { $in: wanted.map(oid) } })
    .select("_id journeyId enquiryId isActive status")
    .lean();

  const journeyIds = [...new Set(styles.map((s) => str(s.journeyId)).filter(isId))];
  const enquiryIds = [...new Set(styles.map((s) => str(s.enquiryId)).filter(isId))];
  const SalesJourney = model("SalesJourney", "../../models/CMS_Models/Sales/SalesJourney");
  const Enquiry = model("Enquiry", "../../models/CMS_Models/Sales/Enquiry");

  /* Only `companyId` is read off the parents. No journey reference, enquiry
     number, title or account is selected, so none can leak. */
  const [journeys, enquiries] = await Promise.all([
    journeyIds.length
      ? SalesJourney.find({ _id: { $in: journeyIds.map(oid) } }).select("_id companyId").lean()
      : [],
    enquiryIds.length
      ? Enquiry.find({ _id: { $in: enquiryIds.map(oid) } }).select("_id companyId").lean()
      : [],
  ]);
  const journeyCompany = new Map(journeys.map((j) => [str(j._id), str(j.companyId)]));
  const enquiryCompany = new Map(enquiries.map((e) => [str(e._id), str(e.companyId)]));

  const out = new Map();
  for (const style of styles) {
    const { companyId } = styleOwnerFrom(style, {
      journeyCompanyOf: (id) => journeyCompany.get(id) || null,
      enquiryCompanyOf: (id) => enquiryCompany.get(id) || null,
    }, OWNERSHIP_MODE);
    out.set(str(style._id), companyId || null);
  }
  /* A style id naming no document at all resolves to null, which the decision
     reads as unprovable and fails closed on. */
  return out;
}

/**
 * The work orders this company can prove, and the decision behind each.
 *
 * Expressed the same way `styleOwnershipClause` expresses the style bound: the
 * company's own provable records are resolved first, in bounded reads, and the
 * order query is then limited to an EXACT id set. There is no company field on
 * `WorkOrder` to filter by and none is pretended.
 *
 * ── BOTH REFERENCES ARE RESOLVED TOGETHER ─────────────────────────────────
 * An earlier version admitted an order as soon as one of THIS company's styles
 * named it, before looking at the request line. A direct reference is
 * order-specific, so that felt safe — and it was not. An order named by company
 * A's style and line-resolved to company B's style was admitted to A on the
 * direct reference and to B on the line, and appeared in both companies' lists.
 *
 * So every style either path reaches is resolved — including styles belonging
 * to other companies — and the order is admitted only when they all belong to
 * ONE company. Anything else, including a single style whose ownership cannot
 * be proved, is refused to everybody.
 *
 * @returns {Promise<{clause, styleIds:Set<string>, decisions:Map}|null>}
 */
async function orderOwnershipBound(companyId) {
  const want = str(companyId);
  const styleBound = await styleOwnershipClause(want, OWNERSHIP_MODE);
  if (!styleBound) return null;

  const myStyles = await SampleStyle().find(styleBound)
    .select("_id production.workOrderIds")
    .lean();
  if (!myStyles.length) return null;

  const styleIds = new Set();
  const candidateOrderIds = new Set();
  for (const style of myStyles) {
    styleIds.add(str(style._id));
    for (const id of style.production?.workOrderIds || []) {
      if (isId(id)) candidateOrderIds.add(str(id));
    }
  }

  /* ── IE CHUNK 1D — ORDERS THAT NAME ONE OF THIS COMPANY'S STYLES ────────
     The canonical link points from the ORDER to the style, so a work order
     carrying it is not reachable through any style's `workOrderIds[]` and
     would otherwise never become a candidate. Bounded by this company's own
     style ids, exactly like the other two discovery paths. */
  const canonicallyLinked = styleIds.size
    ? await WorkOrder().find({ sampleStyleId: { $in: [...styleIds].map(oid) } })
      .select("_id").lean().catch(() => [])
    : [];
  for (const found of canonicallyLinked) candidateOrderIds.add(str(found._id));

  /* The requests naming any of this company's styles, read for their line
     structure and nothing else. The request also holds the customer, the
     quotation and the payments; none of it is selected. */
  const styleObjectIds = [...styleIds].map(oid);
  const requests = await CustomerRequest().find({
    $or: [
      { "items.sampleStyleId": { $in: styleObjectIds } },
      { sampleStyleId: { $in: styleObjectIds } },
    ],
  }).select("_id sampleStyleId items.stockItemId items.sampleStyleId").lean();
  const requestById = new Map(requests.map((r) => [str(r._id), r]));

  /* Candidates: orders this company's styles name, plus every order raised
     from a request that names one. Bounded by the company's own records. */
  const candidates = await WorkOrder().find({
    $or: [
      ...(candidateOrderIds.size ? [{ _id: { $in: [...candidateOrderIds].map(oid) } }] : []),
      ...(requests.length ? [{ customerRequestId: { $in: requests.map((r) => r._id) } }] : []),
    ],
  }).select("_id stockItemId customerRequestId sampleStyleId").lean().catch(() => []);
  if (!candidates.length) return null;

  /* ── THE CANDIDATES' OWN REQUESTS, WHOEVER THEY NAME ────────────────────
     The `requests` above were found by naming THIS company's styles, which is
     right for discovering candidates and wrong for deciding them: a seat whose
     own records do not reach the request would resolve no line at all, see
     only the direct reference, and admit an order the other company's line
     disputes. That is the same leak in the other direction.

     So the request is re-read by the candidates' OWN `customerRequestId`. Line
     structure only — the customer, the quotation and the payments on it are
     not selected and cannot be published. */
  const candidateRequestIds = [...new Set(
    candidates.map((c) => str(c.customerRequestId)).filter(isId),
  )];
  const candidateRequests = candidateRequestIds.length
    ? await CustomerRequest().find({ _id: { $in: candidateRequestIds.map(oid) } })
      .select("_id sampleStyleId items.stockItemId items.sampleStyleId").lean()
    : [];
  for (const request of candidateRequests) requestById.set(str(request._id), request);

  /* EVERY style naming any candidate order, from any company — the read that
     makes a cross-company conflict visible from either seat. */
  const namingStyles = await SampleStyle()
    .find({ "production.workOrderIds": { $in: candidates.map((c) => c._id) } })
    .select("_id production.workOrderIds")
    .lean();
  const directByOrder = new Map();
  for (const style of namingStyles) {
    for (const orderId of new Set((style.production?.workOrderIds || []).map(str))) {
      if (!directByOrder.has(orderId)) directByOrder.set(orderId, []);
      directByOrder.get(orderId).push(str(style._id));
    }
  }

  /* One ownership resolution for every style any decision depends on. */
  const decisionStyleIds = new Set();
  const preliminary = new Map();
  for (const candidate of candidates) {
    const key = str(candidate._id);
    const request = requestById.get(str(candidate.customerRequestId)) || null;
    const direct = directByOrder.get(key) || [];
    preliminary.set(key, { request, direct });
    if (isId(candidate.sampleStyleId)) decisionStyleIds.add(str(candidate.sampleStyleId));
    for (const id of direct) decisionStyleIds.add(id);
    const line = resolveOrderLine(candidate, request);
    for (const id of line.styleIds || []) decisionStyleIds.add(id);
  }
  const owners = await styleOwnersFor([...decisionStyleIds]);
  const ownerOf = (styleId) => owners.get(str(styleId)) || null;

  const decisions = new Map();
  const admissible = new Set();
  for (const candidate of candidates) {
    const key = str(candidate._id);
    const { request, direct } = preliminary.get(key);
    const decision = resolveOrderStyleLink({
      order: candidate, request, directStyleIds: direct,
      /* Read straight off the candidate; `resolveOrderStyleLink` also falls
         back to `order.sampleStyleId`, so neither side can forget it. */
      canonicalStyleId: candidate.sampleStyleId || null,
      ownerOf,
    });
    decisions.set(key, decision);
    /* Admitted only when the whole decision resolves to THIS company. */
    if (decision.companyId && decision.companyId === want) admissible.add(key);
  }

  if (!admissible.size) return null;
  return {
    clause: { _id: { $in: [...admissible].map(oid) } },
    styleIds,
    decisions,
  };
}

/* ═══ ORDER → STYLE, PROVED OR NOT AT ALL ══════════════════════════════════ */

/**
 * The styles attached to a page of orders — read from the decision, not
 * re-derived.
 *
 * `orderOwnershipBound` already resolved both references together and decided
 * what may be attached. Recomputing any part of that here is how the endpoint
 * and the audit came to disagree in the first place, so this only reads.
 */
function styleLinksFor(orders, bound) {
  const out = new Map();
  for (const order of orders) {
    const orderId = str(order._id);
    const decision = bound.decisions.get(orderId);
    if (!decision) {
      out.set(orderId, { styles: [], decision: null });
      continue;
    }
    out.set(orderId, {
      /* Deterministic order, so two identical requests return two identical
         responses and a page cannot reorder itself between reads. */
      styles: decision.attachedStyleIds.map((styleId) => ({
        styleId, via: decision.linkVia[styleId],
      })),
      decision,
    });
  }
  return out;
}

/* ═══ READINESS ════════════════════════════════════════════════════════════ */

/**
 * Where one style stands, derived from Chunk 1A's own assembly.
 *
 * Nothing is recalculated here — the route projection, the SAM total and the
 * comparison state are the ones the style endpoint publishes, so a style reads
 * the same inside an order as it does on its own.
 */
function styleReadinessOf(parts, standard = null) {
  const S = routeComparison.STATE;
  const { comparison, technical } = parts;

  /* ── THE APPROVED IE STANDARD COMES FIRST ────────────────────────────────
     A current approved Operation Bulletin Version IS the operation standard IE
     exists to produce: every row identified, active and timed, approved by
     somebody other than its author. It satisfies the requirement outright.

     The legacy route comparison below is still computed and still published —
     it is source context about R&D's record and the product's route — but it
     is no longer allowed to overrule the department's own signed-off standard.
     Before this, an empty R&D route made a style with an approved seven-row
     bulletin read NOT_STARTED. */
  if (standard?.state === STANDARD_STATE.APPROVED_CURRENT) return STYLE_READINESS.READY;

  if (comparison.state === S.AMBIGUOUS) return STYLE_READINESS.AMBIGUOUS;
  if (comparison.state === S.NO_ROUTE) return STYLE_READINESS.NOT_STARTED;
  /* A route that lives only on the product record is not an engineering
     standard IE has recorded. */
  if (comparison.state === S.ONLY_PRODUCT_ROUTE) return STYLE_READINESS.INCOMPLETE;
  if ([S.DIFFERENT_OPERATIONS, S.DIFFERENT_SEQUENCE, S.DIFFERENT_TIME].includes(comparison.state)) {
    return STYLE_READINESS.INCOMPLETE;
  }
  /* MATCHED or ONLY_TECHNICAL_ROUTE — the technical route stands unopposed.
     It still has to be complete to be ready. */
  if (!technical.present || !technical.samComplete || technical.rowsNotIdentified) {
    return STYLE_READINESS.INCOMPLETE;
  }
  return STYLE_READINESS.READY;
}

/**
 * The legacy gaps an approved IE standard answers, and nothing more.
 *
 * Each of these tells IE to RECORD an operation route, a standard time or an
 * identified operation. An approved bulletin version has done exactly that, so
 * publishing them beside it would contradict the department's own record —
 * "no route recorded" over a style with seven approved operations.
 *
 * Everything else the legacy comparison raises is kept, because it is still
 * true and still somebody's to fix: R&D's record not being approved, the
 * product route disagreeing or missing, a duplicated code in the register.
 * Those are source context, and an approved IE standard does not make them go
 * away — it only stops them deciding IE's readiness.
 */
const SATISFIED_BY_APPROVED_STANDARD = Object.freeze([
  "NO_ROUTE_RECORDED",
  "TECHNICAL_ROUTE_MISSING",
  "STANDARD_TIME_MISSING",
  "OPERATION_NOT_IDENTIFIED",
]);

function styleGapsWith(legacyGaps, standard) {
  if (standard?.state !== STANDARD_STATE.APPROVED_CURRENT) {
    return { gaps: legacyGaps, satisfied: [] };
  }
  const satisfied = [];
  const gaps = [];
  for (const g of legacyGaps || []) {
    if (SATISFIED_BY_APPROVED_STANDARD.includes(g.code)) satisfied.push(g.code);
    else gaps.push(g);
  }
  return { gaps, satisfied };
}

/**
 * The figures a style row HEADLINES — its operation count and SAM — with the
 * source they came from stated rather than implied.
 *
 * The approved IE standard wins when there is one. Otherwise the legacy
 * technical route, exactly as before. The legacy numbers are never overwritten:
 * they stay in `routeSources.technical`, where they always were.
 */
function headlineOf(parts, standard) {
  if (standard?.state === STANDARD_STATE.APPROVED_CURRENT) {
    return {
      operationCount: standard.operationCount,
      samMinutes: standard.garmentSamMinutes,
      samComplete: standard.garmentSamMinutes !== null,
      standardSource: STANDARD_SOURCE.APPROVED_BULLETIN_VERSION,
    };
  }
  return {
    operationCount: parts.technical.operationCount,
    samMinutes: parts.technical.totalSamMinutes,
    samComplete: parts.technical.samComplete,
    standardSource: parts.technical.present
      ? STANDARD_SOURCE.LEGACY_TECHNICAL_ROUTE : STANDARD_SOURCE.NONE,
  };
}

/** The order's own state, from its styles' — never better than the worst. */
function orderReadinessOf(states) {
  if (!states.length) return ORDER_READINESS.UNKNOWN;
  if (states.every((s) => s === STYLE_READINESS.READY)) return ORDER_READINESS.READY;
  if (states.every((s) => s === STYLE_READINESS.NOT_STARTED)) return ORDER_READINESS.NOT_STARTED;
  return ORDER_READINESS.BLOCKED;
}

/**
 * The order's route and SAM position, summed from the styles' own totals.
 *
 * `totalSamMinutes` is null unless at least one linked style has a technical
 * total, and `samComplete` is true only when EVERY linked style is complete.
 * A partial sum published without that flag is the number somebody quotes as
 * the order's standard time.
 */
function routeSummaryOf(perStyle) {
  const withRoute = perStyle.filter((s) => s.technical.present);
  const totals = withRoute
    .map((s) => s.technical.totalSamMinutes)
    .filter((v) => v !== null && v !== undefined);
  const legacyTotal = totals.length ? Number(totals.reduce((a, b) => a + b, 0).toFixed(6)) : null;
  const legacyComplete = perStyle.length > 0 && perStyle.every((s) => s.technical.samComplete);

  /* ── WHICH STANDARD THE ORDER'S HEADLINE SAM STANDS ON ─────────────────
     `totalSamMinutes` is the number somebody quotes as this order's standard
     time, so it follows the same precedence a style does — under the order
     aggregate rule in `approvedStandard.service.js`:

       · every style approved → the approved sum, complete;
       · no style approved    → exactly the legacy technical figure, as before;
       · some but not all     → NO total. Adding an approved 6.25 to a legacy
         route nobody approved would publish a figure that looks like the
         order's standard and is not, so it is withheld and the reason named.

     The legacy figures are not erased — they are kept whole in
     `legacyTechnical` beside it. */
  const standards = perStyle.map((s) => s.standard);
  const approvedCount = standards.filter((x) => x?.state === STANDARD_STATE.APPROVED_CURRENT).length;
  const summary = standardSummaryOf(standards);

  let totalSamMinutes = legacyTotal;
  let samComplete = legacyComplete;
  let standardSource = withRoute.length ? STANDARD_SOURCE.LEGACY_TECHNICAL_ROUTE : STANDARD_SOURCE.NONE;
  let samUnavailableReason = null;
  if (perStyle.length && approvedCount === perStyle.length) {
    totalSamMinutes = summary.garmentSamMinutes;
    samComplete = true;
    standardSource = STANDARD_SOURCE.APPROVED_BULLETIN_VERSION;
  } else if (approvedCount > 0) {
    totalSamMinutes = null;
    samComplete = false;
    standardSource = "MIXED";
    samUnavailableReason = summary.unavailableReason;
  }

  return {
    styles: perStyle.length,
    stylesWithTechnicalRoute: withRoute.length,
    stylesWithoutTechnicalRoute: perStyle.length - withRoute.length,
    stylesSamComplete: perStyle.filter((s) => s.technical.samComplete).length,
    totalSamMinutes,
    samComplete,
    standardSource,
    samUnavailableReason,
    /* R&D's technical route, exactly as it was always summed. Source context,
       never overwritten. */
    legacyTechnical: {
      totalSamMinutes: legacyTotal,
      samComplete: legacyComplete,
      stylesWithTechnicalRoute: withRoute.length,
      stylesSamComplete: perStyle.filter((s) => s.technical.samComplete).length,
    },
  };
}

const gap = (code, owner, action, message, details = {}) =>
  ({ code, owner, action, message, ...(Object.keys(details).length ? { details } : {}) });

/**
 * WHAT IS MISSING ON THIS ORDER, WHO OWNS IT, AND WHAT THEY MUST DO.
 *
 * A missing style link is reported as a gap and never closed by a guess. The
 * per-style engineering gaps stay on their own style rather than being flattened
 * up here, where they would lose the row they are about.
 */
function orderGapsFor({ decision, perStyle, readiness }) {
  const gaps = [];
  const status = decision?.linkStatus || STYLE_LINK_STATUS.NO_STYLE_REFERENCE;

  if (status === STYLE_LINK_STATUS.REFERENCES_CONFLICT) {
    /* Both stored references are order-specific and they name different
       styles. Nothing stored says which is right, so neither is attached —
       choosing between two references on no evidence is exactly what this
       boundary exists to refuse. */
    gaps.push(gap("STYLE_LINK_CONFLICT", GAP_OWNER.IE, "RECONCILE_STYLE_REFERENCES",
      "This order is named by one style and its request line names another. Both references are "
      + "stored and they disagree, so no style has been attached. Reconcile the two references "
      + "before this order's engineering can be shown.",
      {
        directStyles: decision.directStyleIds.length,
        orderLineStyles: decision.lineStyleIds.length,
      }));
  } else if (status === STYLE_LINK_STATUS.AMBIGUOUS_ORDER_LINES) {
    gaps.push(gap("STYLE_LINK_AMBIGUOUS", GAP_OWNER.IE, "LINK_STYLE_TO_ORDER",
      "More than one line of this order's request names its product, and they do not resolve to a "
      + "single style. No style has been attached — which line this order is for cannot be read from "
      + "what is stored.",
      { candidateLines: decision.lineStyleIds.length || null }));
  } else if (!perStyle.length) {
    gaps.push(gap("STYLE_LINK_UNRESOLVED", GAP_OWNER.IE, "LINK_STYLE_TO_ORDER",
      "No style can be proved to belong to this order. Nothing names it, and no line of its request "
      + "matching its product carries a style reference."));
  }

  /* ── LANE A — A LIFECYCLE CONTRADICTION IS A GAP, NOT A DELETION ──────────
     The old boundary answered "this order's style was cancelled" by removing
     the order. It is reported instead, once per distinct code, so the Orders
     LIST carries it too — the list has no styles on it, and a warning only the
     detail could show is a warning most people never see. */
  const seen = new Set();
  for (const style of perStyle) {
    for (const warning of style.lifecycle?.warnings || []) {
      if (seen.has(warning.code)) continue;
      seen.add(warning.code);
      gaps.push(gap(warning.code, GAP_OWNER.IE, "REVIEW_STYLE_LIFECYCLE", warning.message, {
        styles: perStyle.filter(
          (s) => (s.lifecycle?.warnings || []).some((w) => w.code === warning.code),
        ).length,
      }));
    }
  }

  if (readiness === ORDER_READINESS.BLOCKED) {
    gaps.push(gap("ORDER_ENGINEERING_INCOMPLETE", GAP_OWNER.IE, "COMPLETE_STYLE_ENGINEERING",
      "One or more styles on this order have no complete, unambiguous route and standard time.",
      {
        blockedStyles: perStyle.filter((s) => s.readiness !== STYLE_READINESS.READY).length,
        totalStyles: perStyle.length,
      }));
  }

  return gaps;
}

/* ═══ PROJECTIONS ══════════════════════════════════════════════════════════ */

/**
 * The ONLY work-order fields this boundary reads.
 *
 * Written as an allowlist and used as the mongoose `select`, so the forbidden
 * ones are not merely unpublished — they never leave the database. `customerId`
 * and `customerName` are a buyer; `estimatedCost`, `actualCost` and every
 * `rawMaterials[].unitCost` are money; `customerRequestId` is the key to a
 * record holding quotations, prices and payments. None is selected, and
 * `customerRequestId` is the single exception that IS selected — because it is
 * the join hop to the style reference — and is never published.
 */
/* Chunk 1A's style fields plus the style's own lifecycle, which Lane A
   publishes so a reader can see WHY a historical style is on an order. Adding
   fields to the read cannot widen the response — every field that leaves is
   written out by hand — and the two lifecycle fields are the only additions. */
const ORDER_STYLE_PROJECTION = `${ieRead.STYLE_PROJECTION} status isActive`;

const ORDER_PROJECTION = [
  "_id workOrderNumber status planningState priority",
  "quantity originalQuantity",
  "timeline.plannedStartDate timeline.plannedEndDate",
  "stockItemId stockItemName stockItemReference",
  /* IE Chunk 1D. Read for the link decision and never published as an id —
     the styles it resolves to are published instead, each with its provenance. */
  "sampleStyleId",
  "customerRequestId createdAt updatedAt",
].join(" ");

/**
 * WHAT AN IE ORDER ROW MAY CONTAIN.
 *
 * Built field by field. A spread of the work order would publish the customer,
 * the customer request, the estimated cost and the raw-material unit costs the
 * first time somebody stopped reading this function.
 */
function orderRow(order, { decision, perStyle, readiness, routeSummary, gaps }) {
  return {
    orderId: str(order._id),
    /* The internal production reference — the number the floor and the
       schedule already use. Not a customer PO, not a quotation number. */
    reference: str(order.workOrderNumber),
    status: str(order.status),
    /* The separate planning axis, interpreted on read exactly as Production
       interprets it: an absent value is `unknown`, never `not_started`. */
    planningState: normalizePlanningState(order.planningState),
    priority: str(order.priority),
    plannedQuantity: order.quantity === undefined || order.quantity === null
      ? null : Number(order.quantity),
    /* Nulls, not zeroes and not today's date: a work order with no planned
       timeline has none, and inventing one would put work on a calendar. */
    plannedStartDate: order.timeline?.plannedStartDate || null,
    plannedEndDate: order.timeline?.plannedEndDate || null,
    product: {
      name: str(order.stockItemName),
      reference: str(order.stockItemReference),
    },
    styleCount: perStyle.length,
    /* Lane A: how many of this order's styles are closed or archived records.
       Published as a count so the list can say "this order rests on historical
       development" without carrying the styles themselves. */
    historicalStyles: perStyle.filter((s) => s.lifecycle?.historical).length,
    stylesReady: perStyle.filter((s) => s.readiness === STYLE_READINESS.READY).length,
    stylesWithGaps: perStyle.filter((s) => s.readiness !== STYLE_READINESS.READY).length,
    ieReadiness: readiness,
    routeSummary,
    /* The approved IE standard across this order's styles, under the one
       aggregate rule — see `standardSummaryOf`. Separate from `routeSummary`
       so the approved evidence is never confused with R&D's route. */
    engineeringStandardSummary: standardSummaryOf(perStyle.map((s) => s.standard)),
    /* Reported as unavailable rather than guessed — see LINE_PLANNING. */
    linePlanning: LINE_PLANNING,
    /* HOW the order's style link stands, as a state rather than a count. The
       count this replaced was a tally of styles across every company sharing
       the product — a number that changed when a tenant the caller cannot see
       added a style, which is a disclosure however small. */
    styleLinkState: decision?.linkStatus || STYLE_LINK_STATUS.NO_STYLE_REFERENCE,
    gaps,
  };
}

/* ═══ THE TWO READS ════════════════════════════════════════════════════════ */

/**
 * Assemble one page of orders: their styles, each style's Chunk 1A engineering,
 * and the order-level roll-up.
 *
 * Shared by both reads so the list and the detail cannot disagree about an
 * order's readiness — the detail is the same computation with the styles left
 * in rather than counted.
 */
async function assembleOrders(orders, bound, companyId) {
  const links = styleLinksFor(orders, bound);

  /* Every style named by the whole page, loaded once. */
  const wantedStyleIds = [...new Set(
    [...links.values()].flatMap((l) => l.styles.map((s) => s.styleId)),
  )];
  const styles = wantedStyleIds.length
    ? await SampleStyle().find({ _id: { $in: wantedStyleIds.map(oid) } })
      .select(ORDER_STYLE_PROJECTION).lean()
    : [];
  const styleById = new Map(styles.map((s) => [str(s._id), s]));

  /* Chunk 1A's own product-route resolution and duplicate-code lookup, reused
     rather than re-implemented, and batched across the page. */
  const productRoutes = await ieRead.productRoutesFor(styles);
  const projected = new Map(styles.map((s) =>
    [str(s._id), ieRead.projectRoutes(s, productRoutes.get(str(s._id)))]));
  const pageCodes = new Set();
  for (const parts of projected.values()) {
    for (const code of ieRead.codesUsedBy(parts)) pageCodes.add(code);
  }
  const duplicated = await ieRead.duplicateCodes(pageCodes);

  /* ── THE APPROVED IE STANDARD, FOR EVERY STYLE ON THE PAGE AT ONCE ──────
     Two queries for the whole page — the engineering files, then only the
     versions those files POINT at — company-scoped in both. Never a read per
     style, and never "the latest approved version": the pointer is the
     decision. */
  const standards = await approvedStandardsFor(companyId, wantedStyleIds);

  return orders.map((order) => {
    const own = links.get(str(order._id)) || { styles: [], decision: null };

    const orderStatusClass = statusClassOf(order);
    const perStyle = own.styles.map(({ styleId, via }) => {
      const style = styleById.get(styleId);
      const projection = projected.get(styleId);
      const parts = ieRead.assemble(style, projection, ieRead.ownDuplicates(projection, duplicated));
      const standard = standards.get(styleId) || null;
      const { gaps: styleGaps, satisfied } = styleGapsWith(parts.gaps, standard);
      return {
        styleId, via, style, parts, ...parts,
        /* The approved standard and the legacy gaps it answered. `parts.gaps`
           stays untouched; `gaps` here is the precedence-aware set. */
        standard,
        satisfiedLegacyGaps: satisfied,
        gaps: styleGaps,
        headline: headlineOf(parts, standard),
        readiness: styleReadinessOf(parts, standard),
        /* Lane A: the style's own lifecycle, and any contradiction between it
           and this order. Terminal styles are kept, not hidden — this is what
           explains them. */
        lifecycle: styleLifecycleOf(style, orderStatusClass),
      };
    });

    const readiness = orderReadinessOf(perStyle.map((s) => s.readiness));
    const routeSummary = routeSummaryOf(perStyle);
    const gaps = orderGapsFor({ decision: own.decision, perStyle, readiness });
    return {
      order, decision: own.decision, perStyle, readiness, routeSummary, gaps, orderStatusClass,
    };
  });
}

/**
 * THE IE ORDERS LANDING LIST.
 *
 * Bounded, cursor-paged and stably ordered. Only orders whose company can be
 * proved — a foreign order is not listed as unavailable, it is not listed, and
 * so is one nobody can attribute at all.
 */
async function listOrders(ctx, { limit, cursor } = {}) {
  assertContext(ctx);
  const size = pageSize(limit);
  const after = decodeCursor(cursor, "time");

  const bound = await orderOwnershipBound(ctx.companyId);
  if (!bound) {
    return { rows: [], limit: size, hasMore: false, nextCursor: null, sort: "createdAt:desc,_id:desc" };
  }

  const filter = { $and: [bound.clause] };
  if (after) {
    const at = new Date(Number(after.t));
    filter.$and.push({
      $or: [
        { createdAt: { $lt: at } },
        { createdAt: at, _id: { $lt: oid(after.i) } },
      ],
    });
  }

  /* One row more than asked for, so "is there another page" is answered by the
     database rather than guessed from a full page. */
  const found = await WorkOrder().find(filter)
    .select(ORDER_PROJECTION)
    .sort({ createdAt: -1, _id: -1 })
    .limit(size + 1)
    .lean();

  const page = found.slice(0, size);
  const assembled = await assembleOrders(page, bound, ctx.companyId);
  const rows = assembled.map((a) => orderRow(a.order, a));

  const last = page[page.length - 1];
  return {
    rows,
    limit: size,
    hasMore: found.length > size,
    nextCursor: found.length > size
      ? encodeCursor({ t: last?.createdAt ? new Date(last.createdAt).getTime() : 0, i: str(last?._id) })
      : null,
    sort: "createdAt:desc,_id:desc",
  };
}

/**
 * ONE ORDER, WITH THE STYLES PROVABLY ON IT.
 *
 * Absent, another company's and unprovable all return the same refusal — a
 * refusal that varied with the answer would be an oracle for which order ids
 * are real and which belong to somebody else.
 */
async function readOrder(ctx, { orderId } = {}) {
  assertContext(ctx);
  if (!isId(orderId)) throw orderNotFound();

  const bound = await orderOwnershipBound(ctx.companyId);
  if (!bound) throw orderNotFound();

  /* The ownership bound is part of the QUERY, not a check after it: a work
     order this company cannot prove is never loaded, so there is nothing to
     leak from and nothing to forget to filter. */
  const order = await WorkOrder().findOne({ $and: [{ _id: oid(orderId) }, bound.clause] })
    .select(ORDER_PROJECTION)
    .lean();
  if (!order) throw orderNotFound();

  const [assembled] = await assembleOrders([order], bound, ctx.companyId);

  return {
    order: orderRow(order, assembled),
    /* The styles, in full engineering detail — the same shape the Chunk 1A
       style list publishes, plus how the link was proved and where to open the
       style's own record. */
    styles: assembled.perStyle.map((s) => ({
      ...ieRead.styleListRow(s.style, s.parts),
      /* ── THE OPENED ORDER CARRIES THE ROUTES, NOT JUST THEIR TOTALS ─────
         `styleListRow` is the WORKLIST shape: its `routeSources` hold counts
         and totals with no rows, because a list row does not draw a route. An
         opened order does, and a screen given only the summary renders "no
         operations recorded" over a style that has seven — the summary and the
         rows disagreeing about the same style.

         The rows are taken from the projection this order already assembled.
         They are NOT fetched from the standalone style endpoint per style:
         that read applies the active-style lifecycle admission, and Lane A
         deliberately retains completed, cancelled and archived styles here, so
         exactly the historical styles this boundary exists to keep would come
         back empty. Same numbers, one assembly, no second query into Sales. */
      routeSources: {
        technical: { ...s.parts.technical, rows: s.parts.technicalRows },
        product: { ...s.parts.product, rows: s.parts.productRows },
      },
      /* ── THE HEADLINE FIGURES, WITH THEIR SOURCE ────────────────────────
         `styleListRow` fills these from R&D's technical route. When IE has an
         approved standard for the style, THAT is the standard, so it wins here
         — and `standardSource` says which one a reader is looking at. The
         technical route's own figures are untouched in `routeSources` above. */
      operationCount: s.headline.operationCount,
      samMinutes: s.headline.samMinutes,
      samComplete: s.headline.samComplete,
      standardSource: s.headline.standardSource,
      /* The legacy gaps minus the ones the approved standard answers. */
      gaps: s.gaps,
      /* ── THE APPROVED IE OPERATION STANDARD ─────────────────────────────
         Its own projection, beside the legacy route sources rather than over
         them. Every figure is a stated absence when there is no approved
         standard, and the state says which link broke. */
      engineeringStandard: {
        ...s.standard,
        /* The legacy gap codes this standard answered on this style — so a
           reader can see WHY "no route recorded" is no longer shown, rather
           than wondering where it went. */
        satisfiesLegacyGaps: s.satisfiedLegacyGaps,
      },
      /* Enough identity to open the existing engineering file — through the
         route that already opens it, scoped by this order and style. */
      engineeringFile: {
        styleFileId: s.standard?.styleFileId || null,
        href: `/api/cms/ie/orders/${str(order._id)}/styles/${s.styleId}/engineering-file`,
      },
      linkedVia: s.via,
      ieReadiness: s.readiness,
      /* Built field by field, like everything else here: the style's own
         lifecycle and nothing about the Sales parents that proved its
         company. */
      lifecycle: {
        lifecycleStatus: s.lifecycle.lifecycleStatus,
        recordActive: s.lifecycle.recordActive,
        historical: s.lifecycle.historical,
        warnings: s.lifecycle.warnings.map((w) => ({ code: w.code, message: w.message })),
      },
      /* A relative path onto the existing IE style endpoint. An identifier and
         a route, never a Sales deep link. */
      href: `/api/cms/ie/styles/${s.styleId}`,
    })),
    /* Chunk 1B adds no writer, and says so in the payload so no shell renders
       a Save affordance against it by assumption. */
    readOnly: true,
  };
}

module.exports = {
  CODES, DEFAULT_LIMIT, MAX_LIMIT,
  STYLE_LINK, LINE_RESOLUTION, STYLE_LINK_STATUS, COMPANY_ATTRIBUTION,
  STYLE_READINESS, ORDER_READINESS, LINE_PLANNING, ORDER_PROJECTION, ORDER_STYLE_PROJECTION,
  OWNERSHIP_MODE, STATUS_CLASS, statusClassOf,
  orderOwnershipBound, resolveOrderLine, resolveOrderStyleLink, styleOwnersFor,
  styleLinksFor, styleReadinessOf, orderReadinessOf,
  routeSummaryOf, orderGapsFor, orderRow,
  SATISFIED_BY_APPROVED_STANDARD, styleGapsWith, headlineOf,
  listOrders, readOrder,
};
