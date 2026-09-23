// routes/CMS_Routes/Sales/salesJourneys.js
//
// Sales Journey list / detail / create.
//
// SCOPE, STATED UP FRONT: this router creates a Journey and, optionally, the
// one CRMActivity task that is its first next action. It creates NOTHING else.
// No Enquiry, Style, Quotation, Order, Production, Shipment or Retention record
// is written here, and none should be added without its own module.
//
// THE LEAD → JOURNEY BRIDGE: POST /:id also accepts an optional `sourceLeadId`
// — the ONE sanctioned way a Lead becomes `qualificationState:"converted"` (see
// services/leadQualification.js's assertLeadConvertible; the general Lead
// PATCH endpoint refuses "converted" outright). When present: the source Lead
// must already be "readyToConvert" and not already converted; after the
// Journey (and its optional Activity) are created, the Lead is flipped with an
// ATOMIC conditional update (`findOneAndUpdate` gated on its still being
// "readyToConvert") so two concurrent requests — a double-click, a retry —
// can never both succeed. The loser's Journey (and Activity) is rolled back
// and it is told the Lead already converted, rather than leaving a second,
// orphaned Journey behind.
//
// Cross-cutting behaviour, all reused rather than re-invented:
//   • salesWrites() at the mount    — role + approval. An EDITOR's create is
//                                     held as a ChangeRequest and answered 202
//                                     before it ever reaches this file.
//   • salesAuth                     — identity, same as every other CRM router.
//   • recordChange(...)             — every successful mutation is audited.
//   • crmVisibility                 — expected value is removed server-side for
//                                     unauthorized callers.
//
// TWO THINGS THE CLIENT IS NEVER TRUSTED WITH:
//   1. `ownerId` for MY-WORK SCOPE. `?scope=mine` resolves to the authenticated
//      user's own id. A client-supplied user id cannot widen or impersonate a
//      scope. (An explicit `owner` FILTER is a different thing and is allowed
//      on team scope — filtering to a colleague is not impersonation.)
//   2. `journeyId`, `createdBy`, `updatedBy`, `stageStates`, `currentStage`.
//      All are assigned by the server.

const express = require("express");
const { ownershipFieldsFor } = require("../../../services/companyContext/ownershipStamp.service");
const { scopeAndOwnership } = require("../../../services/companyContext/salesScope.service");
/* ── EVERY JOURNEY QUERY CARRIES THE ACTOR'S COMPANY ────────────────────────
 * An ownership field is not a boundary until every read and write uses it.
 * `companyId` was added to SalesJourney and then consulted nowhere in this
 * router: a foreign journey could still be listed, read, updated and advanced.
 * The shared scope is folded into the same query as the selector — including
 * the initial `$match` of the aggregation, because aggregating globally and
 * filtering afterwards has already read the rows. */
const {
  scopedFilter: salesScopedFilter, scopeFor: salesScopeFor,
} = require("../../../services/companyContext/salesScope.service");
const { createServiceContext, serviceFilter } = require("../../../services/companyContext/serviceScope.service");

/** A selector with this actor's company clause folded in. */
const scoped = (req, selector = {}) => salesScopedFilter(req, selector);

/**
 * A tenant refusal keeps its own status rather than becoming a generic 500.
 * "Choose which company you are working in" (409), "not linked to a company"
 * (403) and "could not check just now" (503) are all actionable; 500 is not.
 */
function answeredTenantRefusal(res, err) {
  if (err?.name !== "StorePurchaseError") return false;
  res.status(err.status).json(err.toResponse());
  return true;
}
const router = express.Router();

const mongoose = require("mongoose");
const SalesJourney = require("../../../models/CMS_Models/Sales/SalesJourney");
const Enquiry = require("../../../models/CMS_Models/Sales/Enquiry");
const { resolvePaymentTerms, advanceGate } = require("../../../services/paymentTerms");
const Account = require("../../../models/CMS_Models/Sales/Account");
const Contact = require("../../../models/CMS_Models/Sales/Contact");
const Activity = require("../../../models/CMS_Models/Sales/Activity");
const Lead = require("../../../models/CMS_Models/Sales/Lead");
const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");
const { recordChange } = require("../../../services/changeLog");
const { createWithRef } = require("../../../services/salesJourneyRef");
const { closingVerdictForJourney } = require("../../../services/closingVerdict");
const { assertLeadConvertible, deriveLegacyStage } = require("../../../services/leadQualification");
const { promoteLeadContacts } = require("../../../services/leadContactPromotion");
const { planStageTransition, JourneyTransitionError } = require("../../../services/salesJourneyProgress");
const { isSalesManager } = require("../../../services/salesAccess");
const { journeyAttention } = require("../../../services/journeyAttention");
const {
  ensureOrderLink, resolveOrderLink, listOrderCandidates, chooseOrderLink, provedOrderFor, OrderLinkError,
  STATUS: ORDER_LINK,
} = require("../../../services/orderBookLink");
const {
  canViewCredit,
  stripJourneyCommercial,
  stripJourneyCommercialList,
} = require("../../../services/crmVisibility");
const {
  SALES_JOURNEY_STAGE_CODES,
  SALES_JOURNEY_STAGE_STATE_CODES,
  SALES_JOURNEY_RISK_CODES,
  SALES_JOURNEY_BUSINESS_TYPE_CODES,
  SALES_JOURNEY_LINK_MODULE,
} = require("../../../constants/crm");

const actor = (req) => ({ id: req.user?.id, name: req.user?.name || "" });

// Statuses that mean an Account may not start new business.
const INACTIVE_ACCOUNT_STATUSES = new Set(["archived", "inactive", "blocked"]);

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* `splitName` and `deriveAccountContactFromLead` lived here and picked ONE
   person off a Lead — "decision-maker, else the first one". That rule is gone:
   promotion moved to services/leadContactPromotion.js, which promotes every
   contact the Lead holds and is shared with POST /leads/:id/account so both
   paths produce the same people. */

/* Present is not usable. `isActive: false` is ARCHIVED (the contacts delete
   route sets it alongside `status: "archived"`), and a status like
   `left_organization` or `blocked` describes somebody real whom nobody should
   be pointed at.

   `doNotContact` is a SEPARATE boolean on CRMContact, not a status value — a
   contact can be `status: "active"`, `isActive: true` and still be suppressed.
   Checking status alone let those through while looking as though the question
   had been asked. Only an active, contactable, unsuppressed person may be a
   Journey's primary — named in the request or inherited from the Account. */
const isUsableContact = (c) => Boolean(c)
  && c.isActive !== false
  && (!c.status || c.status === "active")
  && c.doNotContact !== true;

/** A bad request the caller can act on, as opposed to a 500. */
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

/* ── DTOs ─────────────────────────────────────────────────────────────────────
   Purpose-built, never a raw Mongoose document. A raw document would leak
   `__v`, internal ids and — critically — expectedValue past the visibility
   strip, because the strip runs on the DTO. */

/** The Account shape the UI needs: enough to tell two similar names apart. */
const accountDto = (a) =>
  a ? { id: String(a._id), code: a.accountId || null, name: a.companyName || a.displayName || "" } : null;

/** The Activity shape the Hub needs. The Activity still owns these fields. */
const nextActionDto = (a) =>
  a
    ? {
        id: String(a._id),
        activityId: a.activityId || null,
        label: a.subject,
        dueDate: a.dueDate || null,
        status: a.status,
        ownerId: a.ownerId ? String(a.ownerId) : null,
        ownerName: a.ownerName || "",
        // Derived here as it is on the model — never stored.
        overdue: a.status === "planned" && a.dueDate instanceof Date && a.dueDate.getTime() < Date.now(),
      }
    : null;

/**
 * One Journey as the Hub needs it.
 *
 * Dates go out as real ISO dates. The client derives "in 3 days" and its
 * urgency band from them, which is the only way those stay true past midnight.
 */
function summaryDto(j) {
  const stageStates = j.stageStates ? { ...(j.stageStates.toObject?.() ?? j.stageStates) } : {};
  delete stageStates._id;
  const currentStageState = stageStates[j.currentStage] || "notStarted";
  return {
    id: j.journeyId,
    reference: j.journeyId,
    name: j.name,
    businessType: j.businessType,
    requirementRef: j.requirementRef || null,
    customer: accountDto(j.accountId),
    currentStage: j.currentStage,
    currentStageState,
    stageStates,
    risk: j.risk,
    riskReason: j.riskReason || null,
    // The second axis. Legacy rows have no `outcome`, so it reads "active" —
    // which is what they are.
    outcome: j.outcome || "active",
    outcomeStage: j.outcomeStage || null,
    outcomeReason: j.outcomeReason || null,
    outcomeNote: j.outcomeNote || null,
    outcomeAt: j.outcomeAt || null,
    outcomeBy: j.outcomeBy?.name || null,
    revisitOn: j.revisitOn || null,
    // "This needs a decision", and which of the three reasons put it there.
    // Computed on read rather than stored: every input is a date compared to
    // now, so a stored flag would be wrong by tomorrow.
    attention: journeyAttention({
      outcome: j.outcome,
      revisitOn: j.revisitOn,
      hold: j.hold,
      nextAction: j.nextAction,
      targetDate: j.targetDate,
      updatedAt: j.updatedAt,
    }),
    // Why the current stage is not moving, when it is not. Cleared to null the
    // moment the stage moves to any other state.
    po: j.po
      ? {
        number: j.po.number || null,
        date: j.po.date || null,
        amount: j.po.amount ?? null,
        currency: j.po.currency || "INR",
        file: j.po.file?.url ? { name: j.po.file.name || null, url: j.po.file.url } : null,
        paymentTerms: j.po.paymentTerms?.advancePercent != null || j.po.paymentTerms?.balanceTerms
          ? {
            advancePercent: j.po.paymentTerms.advancePercent ?? null,
            balanceTerms: j.po.paymentTerms.balanceTerms || null,
            note: j.po.paymentTerms.note || null,
          }
          : null,
      }
      : null,
    hold: j.hold?.kind
      ? {
        kind: j.hold.kind,
        on: j.hold.on || null,
        expectedBack: j.hold.expectedBack || null,
        since: j.hold.since || null,
        by: j.hold.by?.name || null,
        stage: j.hold.stage || null,
      }
      : null,
    businessStatus: j.businessStatus || null,
    waitingOn:
      currentStageState === "waitingCustomer" ? "customer"
        : currentStageState === "waitingInternal" ? "internal"
          : null,
    owner: j.ownerId ? String(j.ownerId) : null,
    ownerName: j.ownerName || "",
    merchandiser: j.merchandiserId ? String(j.merchandiserId) : null,
    merchandiserName: j.merchandiserName || "",
    nextAction: nextActionDto(j.currentNextActionId),
    targetDate: j.targetDate?.date ? { label: j.targetDate.label || "Target", date: j.targetDate.date } : null,
    expectedValue: j.expectedValue?.amount != null ? j.expectedValue : null,
    updatedAt: j.updatedAt,
    createdAt: j.createdAt,
  };
}

/** Detail adds the resolved parties and the contact. */
function detailDto(j) {
  const p = j.parties || {};
  return {
    ...summaryDto(j),
    // Where this order came from. Null for walk-in and repeat business that
    // never had a lead — the field is optional by design.
    sourceLead: j.leadId
      ? { id: String(j.leadId._id || j.leadId), ref: j.leadRef || null }
      : null,
    primaryContact: j.primaryContactId
      ? {
          id: String(j.primaryContactId._id || j.primaryContactId),
          name: j.primaryContactId.firstName
            ? `${j.primaryContactId.firstName} ${j.primaryContactId.lastName || ""}`.trim()
            : "",
          jobTitle: j.primaryContactId.jobTitle || null,
        }
      : null,
    parties: {
      buyingHouse: accountDto(p.buyingHouseAccountId),
      brand: accountDto(p.brandAccountId),
      poIssuer: accountDto(p.poIssuerAccountId),
      billTo: accountDto(p.billToAccountId),
      consignee: accountDto(p.consigneeAccountId),
      importer: accountDto(p.importerAccountId),
      agent: accountDto(p.agentAccountId),
    },
  };
}

const POPULATE_SUMMARY = [
  { path: "accountId", select: "accountId companyName displayName" },
  { path: "currentNextActionId", select: "activityId subject dueDate status ownerId ownerName" },
];

const POPULATE_DETAIL = [
  ...POPULATE_SUMMARY,
  { path: "primaryContactId", select: "firstName lastName jobTitle" },
  ...[
    "buyingHouseAccountId", "brandAccountId", "poIssuerAccountId",
    "billToAccountId", "consigneeAccountId", "importerAccountId", "agentAccountId",
  ].map((f) => ({ path: `parties.${f}`, select: "accountId companyName displayName" })),
];

/* ── Validation helpers ─────────────────────────────────────────────────────── */

const isObjectId = (v) => mongoose.Types.ObjectId.isValid(String(v));

/**
 * Resolve an Account reference, asserting it exists, may trade, AND is ours.
 *
 * ── THE CLAIM PATH THIS CLOSES ──────────────────────────────────────────────
 * This used to be `Account.findById(id)` with no company at all. A Journey was
 * then created, correctly stamped with the ACTOR's company, from a customer
 * belonging to somebody else — Company A's journey against Company B's buyer,
 * and every enquiry, costing and (from Chunk 3) supplier quotation hanging off
 * it. The journey's own ownership being right is what made it hard to see.
 *
 * `scope` is the company clause resolved ONCE for this request and passed in.
 * It is not re-resolved here: one request must use one company decision, or
 * two lookups can disagree halfway through an operation.
 *
 * A foreign account is reported exactly as a missing one.
 */
async function assertUsableAccount(id, label, scope) {
  if (!isObjectId(id)) throw new ValidationError(`${label} is not a valid account reference.`);
  const acc = await Account.findOne({ $and: [scope, { _id: id }] })
    .select("accountId companyName status isActive").lean();
  if (!acc) throw new ValidationError(`${label} was not found.`);
  if (acc.isActive === false || INACTIVE_ACCOUNT_STATUSES.has(acc.status)) {
    throw new ValidationError(`${label} (${acc.accountId || acc.companyName}) is not active.`);
  }
  return acc;
}

function assertEnum(value, allowed, label) {
  if (value == null || value === "") return undefined;
  if (!allowed.includes(value)) {
    throw new ValidationError(`${label} must be one of: ${allowed.join(", ")}.`);
  }
  return value;
}

function parseDate(value, label) {
  if (value == null || value === "") return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new ValidationError(`${label} is not a valid date.`);
  return d;
}

function parseAmount(value, label) {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new ValidationError(`${label} must be a positive number.`);
  return n;
}

/* ── GET /api/cms/crm/sales-journeys ────────────────────────────────────────── */

router.get("/", salesAuth, async (req, res) => {
  try {
    const {
      scope = "team", search, accountId, owner, stage, stageState,
      risk, businessType, waitingOn, valueMin, valueMax, outcome,
      page = 1, limit = 50,
    } = req.query;

    const filter = { isActive: true };

    // ── The board shows what is IN FLIGHT ───────────────────────────────────
    //
    // Parked and lost journeys are excluded unless asked for. Without this the
    // hub counts a deal we lost in March forever, and "6 journeys in flight"
    // stops meaning anything — which is the state it was in before the outcome
    // axis existed.
    //
    // `outcome=all` returns everything; a specific value filters to it. The
    // `$ne` form rather than `outcome: "active"` is deliberate: every journey
    // that predates this field has no `outcome` at all, and an equality filter
    // would hide all of them.
    if (outcome && outcome !== "all") {
      filter.outcome = outcome;
    } else if (!outcome) {
      // A PARKED JOURNEY WHOSE DATE HAS COME ROUND IS BACK ON THE BOARD.
      //
      // Hiding every parked journey would break the one thing parking is FOR:
      // you said November, and in November it has to reappear. Without this the
      // revisit date is a note in a drawer and nobody would ever park anything.
      //
      // Lost and closed stay hidden unconditionally — those decisions are made.
      filter.$and = [
        ...(filter.$and || []),
        {
          $or: [
            { outcome: { $nin: ["parked", "lost", "closed"] } },
            { outcome: "parked", revisitOn: { $lte: new Date() } },
          ],
        },
      ];
    }

    // MY WORK IS RESOLVED FROM THE SESSION, NOT THE QUERY STRING. A client that
    // sends `?scope=mine&owner=<someone-else>` still gets its own work.
    if (scope === "mine") {
      if (!req.user?.id) return res.json({ success: true, journeys: [], pagination: { page: 1, limit: 0, total: 0, pages: 0 } });
      filter.ownerId = req.user.id;
    } else if (owner && owner !== "all") {
      if (!isObjectId(owner)) return res.status(400).json({ success: false, message: "Invalid owner filter." });
      filter.ownerId = owner;
    }

    if (accountId && accountId !== "all") {
      if (!isObjectId(accountId)) return res.status(400).json({ success: false, message: "Invalid account filter." });
      filter.accountId = accountId;
    }
    if (stage && stage !== "all") filter.currentStage = stage;
    if (risk && risk !== "all") filter.risk = risk;
    if (businessType && businessType !== "all") filter.businessType = businessType;

    // Stage state and waiting-on both describe the CURRENT stage, so they are
    // expressed against the current stage's own key rather than any stage's.
    if (stageState && stageState !== "all") {
      const stages = stage && stage !== "all" ? [stage] : SALES_JOURNEY_STAGE_CODES;
      filter.$or = stages.map((s) => ({ currentStage: s, [`stageStates.${s}`]: stageState }));
    }
    if (waitingOn === "customer" || waitingOn === "internal") {
      const want = waitingOn === "customer" ? "waitingCustomer" : "waitingInternal";
      const stages = stage && stage !== "all" ? [stage] : SALES_JOURNEY_STAGE_CODES;
      const clause = stages.map((s) => ({ currentStage: s, [`stageStates.${s}`]: want }));
      filter.$and = [...(filter.$and || []), { $or: clause }];
    }

    // Commercial range is a restricted filter: an unauthorized caller cannot
    // use it to binary-search a value it is not allowed to read.
    if (canViewCredit(req.user)) {
      const min = parseAmount(valueMin, "Minimum value");
      const max = parseAmount(valueMax, "Maximum value");
      if (min !== undefined || max !== undefined) {
        filter["expectedValue.amount"] = {
          ...(min !== undefined ? { $gte: min } : {}),
          ...(max !== undefined ? { $lte: max } : {}),
        };
      }
    }

    // Search spans the Journey's own fields plus the customer's name/code, so
    // "Northstar" finds journeys even though the name lives on the Account.
    if (search) {
      const re = new RegExp(escapeRegex(search), "i");
      const matchedAccounts = await Account.find(await scoped(req, { $or: [{ companyName: re }, { accountId: re }, { displayName: re }] }))
        .select("_id")
        .limit(200)
        .lean();
      const searchOr = [
        { journeyId: re },
        { name: re },
        { requirementRef: re },
        ...(matchedAccounts.length ? [{ accountId: { $in: matchedAccounts.map((a) => a._id) } }] : []),
      ];
      filter.$and = [...(filter.$and || []), { $or: searchOr }];
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const perPage = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

    const scopedList = await scoped(req, filter);
    const [rows, total] = await Promise.all([
      SalesJourney.find(scopedList)
        .populate(POPULATE_SUMMARY)
        .sort({ updatedAt: -1 })
        .skip((pageNum - 1) * perPage)
        .limit(perPage)
        .lean({ virtuals: false }),
      SalesJourney.countDocuments(scopedList),
    ]);

    res.json({
      success: true,
      journeys: stripJourneyCommercialList(rows.map(summaryDto), req.user),
      pagination: { page: pageNum, limit: perPage, total, pages: Math.ceil(total / perPage) },
    });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    const status = err instanceof ValidationError ? 400 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

/* ── GET /api/cms/crm/sales-journeys/owners ──────────────────────────────────
   The distinct owners with at least one live journey — just what the Pipeline's
   owner filter dropdown needs to render.

   Added 27 Aug 2026 (explicit performance request). The dropdown used to be
   populated by a SECOND full `loadHubSummaries({view:"team"})` on every mount:
   200 fully-hydrated journey rows, every populate the list route does, fetched
   purely to read two fields off each and throw the rest away — so the Pipeline
   paid for its own list twice on every single load.

   MUST stay declared ABOVE `GET /:journeyId` — Express matches in order, and a
   param route directly below would otherwise capture "owners" as a journey
   reference and answer 404. */

router.get("/owners", salesAuth, async (req, res) => {
  try {
    // Mirrors the list route's own scoping: "mine" narrows to the caller.
    const match = { isActive: true, ownerId: { $ne: null } };
    if (req.query.scope === "mine" && req.user?.id) {
      match.ownerId = new mongoose.Types.ObjectId(String(req.user.id));
    }
    /* The company clause goes in the INITIAL $match. Aggregating globally and
       filtering afterwards has already read every company's rows — and this
       one groups owner names, so it would have listed other companies' staff. */
    const rows = await SalesJourney.aggregate([
      { $match: await scoped(req, match) },
      // $last, not $first: if a person's display name was corrected at some
      // point, the most recent journey carries the corrected spelling.
      { $group: { _id: "$ownerId", name: { $last: "$ownerName" } } },
      { $sort: { name: 1 } },
    ]);
    res.json({
      success: true,
      owners: rows.map((r) => ({ id: String(r._id), name: r.name || String(r._id) })),
    });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ── GET /api/cms/crm/sales-journeys/:journeyId ──────────────────────────────
   Keyed on the HUMAN reference. A Mongo id in this URL would end up in a
   breadcrumb, which the frontend spec forbids outright. */

router.get("/:journeyId", salesAuth, async (req, res) => {
  try {
    const journey = await SalesJourney.findOne(await scoped(req, { journeyId: req.params.journeyId, isActive: true }))
      .populate(POPULATE_DETAIL)
      .lean({ virtuals: false });

    if (!journey) {
      return res.status(404).json({ success: false, message: `No Sales Journey matches ${req.params.journeyId}.` });
    }
    // The payment gate travels with the journey so Order Confirmation can list
    // it as outstanding work from the start. Previously it existed only inside
    // the stage POST, which meant the first anyone heard of an unpaid advance
    // was an error on "Release to Production" — after the work of the stage was
    // already done.
    const gate = await advanceStatus(journey, req);
    const dto = stripJourneyCommercial(detailDto(journey), req.user);

    // The VERDICT is operational — anyone working this journey needs to know
    // whether it can be released. The rupee figures are commercial, and follow
    // the same credit-visibility rule as expectedValue above.
    dto.paymentGate = gate
      ? canViewCredit(req.user)
        ? gate
        : {
            required: gate.required,
            cleared: gate.cleared,
            percent: gate.percent,
            reason: gate.reason,
            terms: { source: gate.terms.source, overridden: gate.terms.overridden },
            restricted: true,
          }
      : null;

    res.json({ success: true, journey: dto });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ── POST /api/cms/crm/sales-journeys ───────────────────────────────────────── */

router.post("/", salesAuth, async (req, res) => {
  /* Outside the try on purpose: promotion happens deep inside it, and the
     catch below has to be able to put it back. */
  let undoPromotion = async () => {};
  /* ── THE COMMIT BOUNDARY ─────────────────────────────────────────────────
     The core operation is: the promoted contacts, the Journey, its optional
     first Activity, and the Lead's conversion. It COMMITS the moment the
     conditional Lead flip succeeds — or, when there is no source Lead, once
     the Journey and its audit entry are written.

     Before that point, any failure undoes ALL of it. Partial rollback was the
     bug: the outer catch undid the contact promotion and left the Journey and
     a converted Lead pointing at contacts that no longer existed.

     After that point nothing is reversed. The remaining work is the Lead's
     audit entry and the reload for the response — reporting problems, not
     creating them — so a failure there becomes a warning on a successful
     Journey, the same policy this route already applies to the optional first
     action. */
  let committed = false;
  let compensate = async () => {};
  try {
    const b = req.body || {};

    /* ── ONE COMPANY DECISION, MADE FIRST, USED BY EVERYTHING BELOW ───────
       Resolved before any source record is loaded, so every load below —
       account, lead, contact, commercial parties — is scoped by the same
       answer. Re-resolving midway would let one request act on two companies. */
    /* ── ONE RESOLUTION, USED FOR EVERYTHING ─────────────────────────────
       The scope AND the ownership stamp come from a single call. They used to
       be two — `scopeFor` for the source lookups and `ownershipFieldsFor` for
       the stamp — and two resolutions in one request are two chances to
       disagree: a membership changed in between and the journey is created
       owned by a company whose sources were never checked. */
    const { scope: journeyScope, ownership: journeyOwnership } = await scopeAndOwnership(req);
    const sourceScope = journeyScope.clause;

    // ── Account: required, must exist, must be tradeable, must be OURS ────
    if (!b.accountId) throw new ValidationError("Select a customer Account for this Journey.");
    const account = await assertUsableAccount(b.accountId, "Customer account", sourceScope);

    // ── Lead → Journey bridge: resolved and validated FIRST, before anything
    //    is written, so a Lead that cannot convert never leaves an orphaned
    //    Journey behind. See assertLeadConvertible for the rule; the atomic
    //    write that actually flips the Lead happens after the Journey (and its
    //    optional Activity) are safely created — see below.
    let sourceLead = null;
    if (b.sourceLeadId) {
      if (!isObjectId(b.sourceLeadId)) throw new ValidationError("Source lead is not a valid reference.");
      /* Scoped: converting another company's lead would carry their
         qualification, their contact and their requirement into our journey. */
      sourceLead = await Lead.findOne(await scoped(req, { $and: [sourceScope, { _id: b.sourceLeadId }] }));
      if (!sourceLead) throw new ValidationError("The source Lead was not found.");
      assertLeadConvertible(sourceLead);
    }

    // ── Name and business type ────────────────────────────────────────────
    const name = String(b.name || "").trim();
    if (!name) throw new ValidationError("Journey name is required.");
    // Optional now — see the model. Still validated when one IS sent, so an
    // existing caller or a later filter UI cannot write a value off the enum.
    if (b.businessType) assertEnum(b.businessType, SALES_JOURNEY_BUSINESS_TYPE_CODES, "Business type");

    // ── Contact: if given, it must belong to the selected Account ─────────
    let primaryContactId;
    if (b.primaryContactId) {
      if (!isObjectId(b.primaryContactId)) throw new ValidationError("Primary contact is not a valid reference.");
      /* Two conditions, and both matter: the contact must be OURS, and it
         must belong to the account we just proved is ours. The company check
         is in the query; the account agreement is checked after, because a
         contact whose company is right and whose account is wrong is a
         different mistake and deserves a different message. */
      const contact = await Contact.findOne(await scoped(req, { $and: [sourceScope, { _id: b.primaryContactId }] }))
        .select("accountId isActive status doNotContact").lean();
      if (!contact) throw new ValidationError("Primary contact was not found.");
      if (String(contact.accountId) !== String(account._id)) {
        throw new ValidationError("The primary contact does not belong to the selected account.");
      }
      /* Present is not the same as usable. `isActive: false` means archived
         (see the contacts delete route), and a status like `left_organization`
         or `do_not_contact` means the person is real but must not be the face
         of this Journey. Naming an unreachable primary is how a Journey ends
         up with nobody to call. */
      if (!isUsableContact(contact)) {
        throw new ValidationError("That contact is archived, marked do-not-contact, or otherwise not contactable — pick an active contact.");
      }
      primaryContactId = b.primaryContactId;
    }

    // ── Carry the Lead's PEOPLE across to the Account ─────────────────────
    /* This used to seed exactly ONE contact — "decision-maker, else the first
       one" — and only when the Account had none at all. A Lead that had
       collected a merchandiser, a purchase manager and an admin head arrived
       with one of them, and the salesperson re-typed the other two.
       `promoteLeadContacts` promotes all of them, reuses anybody the Account
       already has, and is safe to re-run. Tracked for rollback below. */
    let promotedContacts = null;
    /* Promotion is NOT the last thing this request does — a Journey insert can
       still lose a race, and anything after it can throw. Contacts created a
       moment ago, fields filled on existing ones, `linkedLeads` entries and
       every `promotedContactId` written onto the Lead are all just as wrong in
       that case as a half-finished promotion. `undoPromotion` puts all of it
       back, and every failure path below calls it. Deleting the created
       contacts (which is all the old rollback did) left the rest behind. */
    if (sourceLead) {
      const promotion = await promoteLeadContacts({ Contact, Lead }, {
        lead: sourceLead,
        account,
        scopeClause: sourceScope,
        ownership: journeyOwnership,
        actor: actor(req),
      });
      promotedContacts = promotion.summary;
      undoPromotion = promotion.undo;
      compensate = undoPromotion;

      /* An explicitly supplied contact is the caller's decision and is already
         validated above — it is never overridden. Otherwise prefer the CRM
         Contact this Lead's own primary became, then whatever primary the
         Account itself already had. */
      if (!primaryContactId && promotedContacts.primaryContactId) {
        primaryContactId = promotedContacts.primaryContactId;
      }
    }
    if (!primaryContactId) {
      /* Same rule as an explicit choice: an archived or non-contactable
         primary is not a fallback, it is a different bug wearing the answer's
         clothes. */
      const accountPrimary = await Contact.findOne(
        await scoped(req, { accountId: account._id, isPrimary: true, isActive: true, doNotContact: { $ne: true } }),
      ).select("_id status isActive doNotContact").lean();
      if (accountPrimary && isUsableContact(accountPrimary)) primaryContactId = accountPrimary._id;
    }

    // ── Optional commercial parties, each a real active Account ───────────
    const parties = {};
    const PARTY_FIELDS = {
      buyingHouseAccountId: "Buying house",
      brandAccountId: "Brand",
      poIssuerAccountId: "PO issuer",
      billToAccountId: "Bill-to party",
      consigneeAccountId: "Consignee",
      importerAccountId: "Importer",
      agentAccountId: "Agent",
    };
    for (const [field, label] of Object.entries(PARTY_FIELDS)) {
      const value = b.parties?.[field];
      if (!value) continue;
      /* Commercial parties are Accounts too, and are scoped identically. */
      await assertUsableAccount(value, label, sourceScope);
      parties[field] = value;
    }

    // ── Ownership. Defaults to the signed-in user; never read from the body
    //    as an audit actor. A user picker is later work — see the handoff.
    const ownerId = req.user?.id;
    if (!ownerId) throw new ValidationError("Could not resolve the Journey owner from your session.");

    // ── Timing and commercial summary ─────────────────────────────────────
    const targetDate = parseDate(b.targetDate?.date, "Target date");
    const expectedAmount = parseAmount(b.expectedValue?.amount, "Expected value");

    const payload = {
      name,
      accountId: account._id,
      businessType: b.businessType,
      requirementRef: String(b.requirementRef || "").trim() || undefined,
      parties,
      primaryContactId,
      ownerId,
      ownerName: req.user?.name || "",
      // currentStage and stageStates are SERVER-ASSIGNED defaults — a client
      // cannot start a Journey at Production.
      createdBy: actor(req),
      updatedBy: actor(req),
      // The reverse half of the Lead → Journey bridge. The Lead already records
      // the Journey (the `links` append below), but nothing recorded the Lead on
      // the JOURNEY — so from an order you could not name the lead that won it
      // without scanning every lead's links for this journey's id. `sourceLead`
      // is already resolved and validated above, so this costs nothing.
      ...(sourceLead ? { leadId: sourceLead._id, leadRef: sourceLead.leadId || undefined } : {}),
      ...(targetDate ? { targetDate: { label: String(b.targetDate?.label || "Target").trim(), date: targetDate } } : {}),
      ...(expectedAmount !== undefined
        ? {
            expectedValue: {
              amount: expectedAmount,
              currency: String(b.expectedValue?.currency || "INR").trim().toUpperCase(),
              confirmed: false,
            },
          }
        : {}),
    };

    /*
     * SAMPLING IS NOT DECIDED HERE ANY MORE (22 Aug 2026).
     *
     * This used to mark styleSample "notApplicable" whenever the journey's
     * businessType was `repeat` or `replenishment` — whenever the CUSTOMER was
     * a returning one. That is the wrong axis. A repeat customer ordering a
     * garment nobody has made before still needs a sample; a first-time
     * customer ordering a shirt that has sat in the register for two years,
     * with a measured SAM and a costed bill of materials, does not.
     *
     * What decides it is the PRODUCT, and the product is not known here — at
     * journey creation there is no enquiry and no product rows yet. The call is
     * made where it can be: services/sampleStyleProvision.js, one style at a
     * time, against whether that row is linked to a registered stock item.
     */
    /* Ownership was resolved at the top of this handler, with the source
       scope, and is reused here — see there for the contract: proven, or the
       journey is not created. */
    const journey = await createWithRef(SalesJourney, { ...payload, ...journeyOwnership });

    /* From here the Journey — and any Activity it gains — belong to the same
       uncommitted operation as the promoted contacts. Scoped deletes: a
       rollback that could reach further than the write it is undoing is a
       rollback nobody should have to reason about. */
    compensate = async () => {
      if (journey.currentNextActionId) await Activity.deleteOne({ _id: journey.currentNextActionId }).catch(() => {});
      await SalesJourney.deleteOne(await scoped(req, { _id: journey._id })).catch(() => {});
      await undoPromotion().catch(() => {});
    };

    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-sales-journey",
      entityId: journey._id,
      entityLabel: journey.journeyId,
      action: "create",
      summary: `Created Sales Journey ${journey.journeyId} — ${journey.name} for ${account.accountId || account.companyName}`,
      after: journey.toObject(),
    });

    // ── Optional first next action: a REAL CRMActivity, linked both ways ──
    //
    // Partial failure is reported, never swallowed. If the Journey saved and
    // the task did not, the caller is told plainly — the Journey exists and is
    // usable, and the user can add the task from the timeline.
    let warning = null;
    const wantsAction = Boolean(String(b.nextAction?.label || "").trim());

    if (wantsAction) {
      try {
        const activity = await Activity.create({
          accountId: account._id,
          contactId: primaryContactId,
          activityType: "task",
          subject: String(b.nextAction.label).trim(),
          status: "planned",
          priority: "normal",
          dueDate: parseDate(b.nextAction?.dueDate, "Next action due date"),
          ownerId,
          ownerName: req.user?.name || "",
          visibility: "internal",
          // The forward link the Activity model was designed for. This is what
          // makes the task reachable from the Journey without a second table.
          links: [{ module: SALES_JOURNEY_LINK_MODULE, recordId: journey._id }],
          createdBy: actor(req),
          updatedBy: actor(req),
        });

        journey.currentNextActionId = activity._id;
        await journey.save();

        await recordChange(req, {
          departmentSlug: "sales",
          entity: "crm-activity",
          entityId: activity._id,
          entityLabel: activity.subject,
          action: "create",
          summary: `Created first next action for Sales Journey ${journey.journeyId}`,
          after: activity.toObject(),
        });
      } catch (activityErr) {
        warning =
          `The Journey was created, but its first next action could not be saved (${activityErr.message}). ` +
          `Add it from the Journey's Activity timeline.`;
      }
    }

    // ── Flip the source Lead, atomically ───────────────────────────────────
    //
    // A CONDITIONAL update, not a load-then-save: the query itself requires
    // the Lead to still be "readyToConvert" at write time. Two concurrent
    // requests for the same Lead (a double-click, a retry after a slow
    // response) both pass assertLeadConvertible's earlier read-based check,
    // but only ONE of them can match this query and flip it — the loser's
    // Journey (and its Activity, if it made one) is rolled back below rather
    // than left behind as a duplicate. No multi-document transaction is
    // needed for that guarantee; the condition IS the lock.
    if (sourceLead) {
      const convertedLead = await Lead.findOneAndUpdate(await scoped(req, { _id: sourceLead._id, qualificationState: "readyToConvert" }), {
          $set: {
            qualificationState: "converted",
            stage: deriveLegacyStage("converted", sourceLead.stage),
            conversion: {
              accountId: account._id,
              contactId: primaryContactId || undefined,
              journeyId: journey._id,
              convertedAt: new Date(),
              convertedBy: actor(req),
            },
            updatedBy: actor(req),
          },
        },
        { new: true },);

      if (!convertedLead) {
        /* Lost the race. The whole operation goes back — Activity, Journey and
           every trace of the promotion — so a retry never leaves two Journeys
           and the winning request promotes from a clean record. */
        await compensate();
        return res.status(409).json({
          success: false,
          message: "This Lead already started a Sales Journey — refresh and open its record instead.",
        });
      }

      /* COMMITTED. The Lead is converted and points at this Journey; undoing
         anything from here would mean reversing a conversion another request
         may already be acting on. */
      committed = true;

      const leadLabel = convertedLead.company || `${convertedLead.firstName || ""} ${convertedLead.lastName || ""}`.trim() || convertedLead.leadId;
      try {
        await recordChange(req, {
          departmentSlug: "sales",
          entity: "lead",
          entityId: convertedLead._id,
          entityLabel: leadLabel,
          action: "update",
          summary: `Lead ${convertedLead.leadId} converted to Sales Journey ${journey.journeyId}`,
          after: convertedLead.toObject(),
        });
      } catch (auditErr) {
        /* An audit entry records what happened; failing to write one does not
           unhappen it. Reversing a committed conversion to keep the log tidy
           would be the more damaging choice. */
        warning = [warning, `The Journey and Lead conversion were saved, but the audit entry could not be written (${auditErr.message}).`]
          .filter(Boolean).join(" ");
      }
    } else {
      /* No source Lead: the Journey and its audit entry ARE the operation. */
      committed = true;
    }

    /* Scoped like the write that preceded it: a reload must not be able to
       return a record the update itself could not have reached. Past the
       commit point, so a failure here is a thin response — never a reversal of
       work that is already done and already visible to other requests. */
    let saved = null;
    try {
      saved = await SalesJourney.findOne(await scoped(req, { _id: journey._id }))
        .populate(POPULATE_DETAIL).lean({ virtuals: false });
    } catch (reloadErr) {
      warning = [warning, `The Journey was created, but could not be re-read for this response (${reloadErr.message}). Open it from the Journeys list.`]
        .filter(Boolean).join(" ");
    }

    res.status(201).json({
      success: true,
      journey: saved
        ? stripJourneyCommercial(detailDto(saved), req.user)
        : { id: String(journey._id), journeyId: journey.journeyId, name: journey.name },
      ...(warning ? { warning } : {}),
    });
  } catch (err) {
    /* Anything that threw BEFORE the commit point takes the whole operation
       with it — promoted contacts, the Journey, its Activity. After the commit
       point nothing is reversed: the Lead is converted and other requests can
       already see it. `compensate` grows as the operation does, and is
       declared in the enclosing scope precisely so this catch can reach it. */
    if (!committed) await compensate().catch(() => {});
    if (answeredTenantRefusal(res, err)) return;
    // LeadTransitionError is assertLeadConvertible's — same 4xx treatment as
    // this route's own ValidationError, just a different class from the
    // shared Lead service.
    const status = err instanceof ValidationError || err.name === "ValidationError" || err.name === "LeadTransitionError" ? 400 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

/* ── POST /api/cms/crm/sales-journeys/:journeyId/stage ───────────────────────
   The lifecycle mover — the ONLY writer of currentStage/stageStates after
   create. Body: { action: "advance"|"setState"|"block"|"reopen", toState?,
   stage?, reason? }. The rules live in services/salesJourneyProgress.js; this
   route only loads the Journey, checks who may move it, applies the plan and
   audits it.

   ACCESS: the Journey owner, or a Sales manager, may progress it — the same
   "owner or authorised manager" rule the Lead routes use. (An EDITOR's write
   never even reaches here: salesWrites() at the mount has already answered 202
   and held it as a ChangeRequest.) */

/* ── THE ORDER LINK'S COMPANY CONTEXT ───────────────────────────────────────
   From THIS already-authorised request, never from the journey or enquiry
   being examined — the same construction the close gate uses. */
async function orderLinkCtx(req) {
  const scope = await salesScopeFor(req);
  return createServiceContext({ companyId: scope.companyId, reason: "sales order link", legacyAware: true });
}

/** The PO path's link. Never throws — the PO is already durable. */
async function orderLinkOnPo(req, journey) {
  try {
    return await ensureOrderLink(await orderLinkCtx(req), journey);
  } catch (err) {
    console.error("[salesJourneys] order link after PO:", err?.message || err);
    return {
      status: ORDER_LINK.UNAVAILABLE, method: null, customerRequestId: null, requestId: null,
      message: "The order link could not be checked right now. The PO is recorded; try again shortly.",
      needsChoice: false, candidateCount: null, confirmedAt: null, confirmedBy: null,
    };
  }
}

/** Load a journey for an order-link call, with the owner-or-manager rule. */
async function journeyForOrderLink(req, res, { write }) {
  const journey = await SalesJourney.findOne(await scoped(req, { journeyId: req.params.journeyId, isActive: true }));
  if (!journey) {
    res.status(404).json({ success: false, message: `No Sales Journey matches ${req.params.journeyId}.` });
    return null;
  }
  const isOwner = String(journey.ownerId) === String(req.user?.id);
  if (!isOwner && !(await isSalesManager(req.user))) {
    res.status(403).json({
      success: false,
      message: write
        ? "Only this Journey's owner or a Sales manager can choose its order."
        : "Only this Journey's owner or a Sales manager can see its order candidates.",
    });
    return null;
  }
  return journey;
}

// GET /api/cms/crm/sales-journeys/:journeyId/order-link
// Which order this deal is, and — when that is not proved — the orders an
// authorised salesperson may choose from. Read-only. Candidates are only ever
// this company's: orders raised from this enquiry, or orders of the portal
// customer this company's account alone is linked to.
router.get("/:journeyId/order-link", salesAuth, async (req, res) => {
  try {
    const journey = await journeyForOrderLink(req, res, { write: false });
    if (!journey) return;
    const ctx = await orderLinkCtx(req);
    const enquiry = await Enquiry.findOne(serviceFilter(ctx, { journeyId: journey._id, isActive: true }));
    const orderLink = await resolveOrderLink(ctx, enquiry);
    const candidates = enquiry && orderLink.needsChoice ? await listOrderCandidates(ctx, enquiry) : [];
    return res.json({ success: true, orderLink, candidates });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[salesJourneys] GET order-link", err);
    return res.status(500).json({ success: false, message: "The order link could not be checked right now." });
  }
});

// POST /api/cms/crm/sales-journeys/:journeyId/order-link
// Body: { customerRequestId, expectedCustomerRequestId: <the link you saw, or null>, reason? }
// An authorised salesperson settles which existing order this deal is. The
// order must be one GET offered; replacing a link needs a reason and the link
// you saw, so a stale screen cannot overwrite someone else's correction.
// Re-sending the same choice is a no-op.
router.post("/:journeyId/order-link", salesAuth, async (req, res) => {
  try {
    const journey = await journeyForOrderLink(req, res, { write: true });
    if (!journey) return;
    const b = req.body || {};
    const chosen = String(b.customerRequestId || "").trim();
    if (!mongoose.isValidObjectId(chosen)) {
      return res.status(400).json({ success: false, code: "invalid_order", message: "Choose an order to link." });
    }
    if (!Object.prototype.hasOwnProperty.call(b, "expectedCustomerRequestId")) {
      return res.status(400).json({
        success: false, code: "expected_required",
        message: "Send the order link you are replacing (null when there is none).",
      });
    }
    const ctx = await orderLinkCtx(req);
    const enquiry = await Enquiry.findOne(serviceFilter(ctx, { journeyId: journey._id, isActive: true }));
    if (!enquiry) {
      return res.status(404).json({ success: false, code: "no_enquiry", message: "This journey has no active enquiry." });
    }

    const out = await chooseOrderLink(ctx, enquiry, {
      customerRequestId: chosen,
      expectedCustomerRequestId: b.expectedCustomerRequestId,
      reason: b.reason,
      actor: actor(req),
    });
    if (out.changed) {
      await recordChange(req, {
        departmentSlug: "sales",
        entity: "crm-enquiry",
        entityId: enquiry._id,
        entityLabel: journey.journeyId,
        action: "update",
        summary: `Sales Journey ${journey.journeyId} order ${out.before ? "re-linked" : "linked"}`
          + (out.orderLink.requestId ? ` to ${out.orderLink.requestId}` : "")
          + (b.reason ? ` — ${String(b.reason).trim()}` : ""),
        before: { customerRequestId: out.before },
        after: { customerRequestId: out.orderLink.customerRequestId, method: out.orderLink.method },
      });
    }
    return res.json({ success: true, changed: out.changed, orderLink: out.orderLink });
  } catch (err) {
    if (err instanceof OrderLinkError) {
      return res.status(err.status).json({ success: false, code: err.code, message: err.message });
    }
    if (answeredTenantRefusal(res, err)) return;
    console.error("[salesJourneys] POST order-link", err);
    return res.status(500).json({ success: false, message: "The order could not be linked right now." });
  }
});

// PATCH /api/cms/crm/sales-journeys/:journeyId/po
// Record the customer's purchase order against the journey. This is what makes
// "do not start production without a PO" checkable at all — before it, nothing
// anywhere held a PO, so the PO/Contract stage could complete on nothing.
router.patch("/:journeyId/po", salesAuth, async (req, res) => {
  try {
    const journey = await SalesJourney.findOne(await scoped(req, { journeyId: req.params.journeyId, isActive: true }));
    if (!journey) {
      return res.status(404).json({ success: false, message: `No Sales Journey matches ${req.params.journeyId}.` });
    }
    const isOwner = String(journey.ownerId) === String(req.user?.id);
    if (!isOwner && !(await isSalesManager(req.user))) {
      return res.status(403).json({
        success: false,
        message: "Only this Journey's owner or a Sales manager can record the PO.",
      });
    }

    const b = req.body || {};
    const number = String(b.number || "").trim();
    if (!number) throw new ValidationError("The customer's PO number is required.");

    let poDate;
    if (b.date) {
      poDate = new Date(b.date);
      if (Number.isNaN(poDate.getTime())) throw new ValidationError("PO date is not a valid date.");
    }
    let amount;
    if (b.amount !== undefined && b.amount !== null && b.amount !== "") {
      amount = Number(b.amount);
      if (!Number.isFinite(amount) || amount < 0) throw new ValidationError("PO amount must be a positive number.");
    }

    // ── Payment terms ───────────────────────────────────────────────────
    // Only `advancePercent` is validated as a number, because it is the only
    // one anything enforces. The rest is the deal in the words it was agreed
    // in. Terms already on file survive a PO edit that does not mention them —
    // re-recording a PO number should not quietly drop the payment agreement.
    const prevTerms = journey.po?.paymentTerms;
    let advancePercent;
    if (b.advancePercent !== undefined && b.advancePercent !== null && b.advancePercent !== "") {
      advancePercent = Number(b.advancePercent);
      if (!Number.isFinite(advancePercent) || advancePercent < 0 || advancePercent > 100) {
        throw new ValidationError("The advance must be a percentage between 0 and 100.");
      }
    }
    const termsTouched = ["advancePercent", "balanceTerms", "paymentNote"].some((k) => b[k] !== undefined);
    const paymentTerms = termsTouched
      ? {
        ...(advancePercent !== undefined ? { advancePercent } : {}),
        ...(b.balanceTerms !== undefined ? { balanceTerms: String(b.balanceTerms || "").trim() } : {}),
        ...(b.paymentNote !== undefined ? { note: String(b.paymentNote || "").trim() } : {}),
        agreedAt: new Date(),
        agreedBy: actor(req),
      }
      : prevTerms;

    const before = journey.toObject();
    journey.po = {
      number,
      ...(poDate ? { date: poDate } : {}),
      ...(amount !== undefined ? { amount } : {}),
      ...(paymentTerms ? { paymentTerms } : {}),
      currency: String(b.currency || journey.po?.currency || "INR").trim().toUpperCase(),
      ...(b.file?.name || b.file?.url
        ? { file: { name: String(b.file.name || "").trim(), url: String(b.file.url || "").trim() } }
        : {}),
      recordedAt: new Date(),
      recordedBy: { employeeId: req.user?.employeeId || "", name: req.user?.name || "" },
    };
    journey.updatedBy = actor(req);
    await journey.save();

    // Recording the PO is the moment an opportunity becomes an order, so it is
    // the moment to say WHICH order. Only a proved link is written — the one
    // order raised from this enquiry — and anything else is REPORTED
    // ("order not linked", "not verified", …) for a salesperson to settle
    // through /order-link. Never throws: the PO above is already recorded,
    // and a retry or correction resolves to the same answer. See
    // services/orderBookLink.js.
    const orderLink = await orderLinkOnPo(req, journey);

    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-sales-journey",
      entityId: journey._id,
      entityLabel: journey.journeyId,
      action: "update",
      summary: `Sales Journey ${journey.journeyId} PO recorded (${number})`
        + (orderLink.status === ORDER_LINK.LINKED && orderLink.requestId
          ? ` — order ${orderLink.requestId} linked` : " — order not linked"),
      before,
      after: journey.toObject(),
    });

    /* Scoped like the write that preceded it: a reload must not be able to
       return a record the update itself could not have reached. */
    const saved = await SalesJourney.findOne(await scoped(req, { _id: journey._id }))
      .populate(POPULATE_DETAIL).lean({ virtuals: false });
    return res.json({
      success: true,
      journey: stripJourneyCommercial(detailDto(saved), req.user),
      // The PO is recorded whatever this says. `status` other than "linked"
      // means the Order Book cannot yet be trusted for this deal; the contract
      // is documented at the top of services/orderBookLink.js.
      orderLink,
    });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    const status = err instanceof ValidationError || err.name === "ValidationError" ? 400 : 500;
    return res.status(status).json({ success: false, message: err.message });
  }
});

/**
 * How much of the agreed advance has actually arrived.
 *
 * Two halves that live in different places: the TERMS are on the journey's PO
 * (where they were negotiated) and the RECEIPTS are on the linked
 * CustomerRequest (where the accountant records them). Neither is any use
 * without the other, which is why nothing could enforce payment terms before.
 *
 * Returns null when there is nothing to enforce — no terms agreed, or no order
 * to read receipts from. The planner treats null as "no gate", deliberately: a
 * rule nobody agreed to should not stop a journey.
 */
// The advance gate for one journey: which terms apply, and whether the money
// against them has arrived.
//
// TERMS COME FROM THE ACCOUNT (services/paymentTerms.js). They used to come
// only from whatever somebody typed on this PO, so two journeys for the same
// buyer could gate on different figures and neither was wrong. The journey may
// still override for one deal — that is recorded as a deviation, not hidden.
async function advanceStatus(journey, req) {
  const AccountModel = require("../../../models/CMS_Models/Sales/Account");
  // Populated on the detail GET, a bare ObjectId on the stage POST — take the
  // id either way rather than depending on which caller we are serving.
  const accountId = journey.accountId?._id || journey.accountId;
  const account = accountId
    ? await AccountModel.findById(accountId)
        .select("advancePercent paymentTermsCode creditDays negotiatedTerms")
        .lean()
    : null;

  const terms = resolvePaymentTerms(account, journey.po);
  if (terms.advancePercent === null) return null;

  /* ── ONLY THIS DEAL'S PROVED ORDER COUNTS (G02) ─────────────────────────
     This read the journey's enquiry with no company and trusted whatever
     order its link held — so a link written by the old recency or name guess
     counted ANOTHER order's payments as this deal's advance received. The
     money is now read only from the order proved to be this deal's; with none
     proved, nothing is counted as received, which holds the gate shut rather
     than opening it on someone else's payment. */
  const CustomerRequestModel = require("../../../models/Customer_Models/CustomerRequest");
  let order = null;
  try {
    const ctx = await orderLinkCtx(req);
    const enquiry = await Enquiry.findOne(serviceFilter(ctx, { journeyId: journey._id, isActive: true }));
    const { customerRequestId } = enquiry ? await provedOrderFor(ctx, enquiry) : { customerRequestId: null };
    order = customerRequestId
      ? await CustomerRequestModel.findById(customerRequestId)
          .select("grandTotal totalPaidAmount quotations.grandTotal").lean()
      : null;
  } catch (err) {
    console.error("[salesJourneys] advance status order read:", err?.message || err);
    order = null;
  }

  // The PO's own amount is the agreed value and wins. The order's total is the
  // fallback for a PO recorded without one.
  const orderValue = Number(journey.po?.amount) > 0
    ? Number(journey.po.amount)
    : Number(order?.grandTotal) || Number(order?.quotations?.slice(-1)[0]?.grandTotal) || 0;

  const gate = advanceGate(terms, {
    orderValue,
    received: Number(order?.totalPaidAmount) || 0,
    currency: journey.po?.currency || account?.defaultCurrency || "INR",
  });

  return { ...gate, terms };
}

router.post("/:journeyId/stage", salesAuth, async (req, res) => {
  try {
    const journey = await SalesJourney.findOne(await scoped(req, { journeyId: req.params.journeyId, isActive: true }));
    if (!journey) {
      return res.status(404).json({ success: false, message: `No Sales Journey matches ${req.params.journeyId}.` });
    }

    const isOwner = String(journey.ownerId) === String(req.user?.id);
    if (!isOwner && !(await isSalesManager(req.user))) {
      return res.status(403).json({
        success: false,
        message: "Only this Journey's owner or a Sales manager can move it through its stages.",
      });
    }

    const b = req.body || {};

    // The old Account → Enquiry readiness gate was removed on 13 Aug 2026:
    // "account" is no longer a journey stage (the customer is set up on the
    // Active Lead before conversion), so there is no account bundle to load or
    // verdict to hand the planner.
    //
    // Closing is the one transition that DOES get a verdict. It is the moment
    // money and delivery are declared settled, and until now the only thing
    // stopping a close with unmet checks was a disabled button on one screen —
    // which any direct API call walked straight past. Computed only for `close`
    // so no other transition pays for the four queries behind it.
    let context;
    if (b.action === "close") {
      /* The company comes from THIS already-authorised request — the journey
         was loaded under it — not from the journey or enquiry being examined. */
      const closingScope = await salesScopeFor(req);
      /* The legacy allowance is settled by the factory against the company
         master, not asserted by this caller — a boolean passed in is not
         proof of anything. */
      const closing = await closingVerdictForJourney(journey._id, await createServiceContext({
        companyId: closingScope.companyId,
        reason: "sales journey stage transition",
        legacyAware: true,
      }));
      /* Always handed over. This used to be `if (closing) context = …`, which
         dropped a null verdict on the floor — and the planner, finding no
         verdict, closed the order. The verdict service no longer returns null,
         and even if it did, an absent verdict must reach the planner as the
         refusal it is rather than vanish here. (G03.) */
      context = { closing };
    } else if (b.action === "lose") {
      // Derived, never trusted from the client: whether a PO exists is the one
      // thing standing between "we lost it" and "we have to cancel a committed
      // order".
      context = { poOnFile: Boolean(journey.po?.number) };
    } else if (b.action === "advance") {
      // Only the Production gate needs anything, and it needs one boolean plus
      // who is asking. `poOnFile` is derived here rather than trusted from the
      // client for the obvious reason.
      context = {
        poOnFile: Boolean(journey.po?.number),
        advance: await advanceStatus(journey, req),
        // Styles Sales has approved but the CUSTOMER has not (2 Sept 2026,
        // explicit request: "jabtak the customer not approved this sample,
        // the purchase invoice/order should be initiate against this
        // customer"). Derived here, never trusted from the client, same as
        // poOnFile. Only styles that actually went through development count
        // — one waived from sampling has no customer verdict to wait for.
        samplesAwaitingCustomer: await require("../../../models/CMS_Models/Sales/SampleStyle").countDocuments({
          journeyId: journey._id,
          isActive: true,
          "sample.status": "approved",
          $or: [
            { "customerApproval.approved": { $ne: true } },
            { "customerApproval.approved": { $exists: false } },
          ],
        }),
        isManager: isOwner ? await isSalesManager(req.user) : true,
        overrideReason: b.overrideReason || b.reason || "",
        actor: { employeeId: req.user?.employeeId || "", name: req.user?.name || "" },
      };
    }

    // Pure planner — throws JourneyTransitionError for any illegal move.
    const plan = planStageTransition(journey, {
      action: b.action,
      toState: b.toState || b.state,
      stage: b.stage,
      reason: b.reason,
      note: b.note,
      revisitOn: b.revisitOn,
      // Who the stage is waiting on, and when it is due back. Free text by
      // design — see the `hold` block on the model.
      on: b.on,
      expectedBack: b.expectedBack,
      actor: actor(req),
      context,
    });

    const before = journey.toObject();
    for (const [path, value] of Object.entries(plan.set)) journey.set(path, value);
    // Array appends come back separately — see the planner's note on why this is
    // not a $push inside `set`.
    if (plan.append) {
      journey[plan.append.path] = [...(journey[plan.append.path] || []), plan.append.value];
    }
    journey.updatedBy = actor(req);
    await journey.save();

    // ── Tell R&D ────────────────────────────────────────────────────────────
    //
    // A journey with open styles has real work on R&D's board: a tech sheet
    // being drawn, a sample being stitched. Marking the deal lost in Sales and
    // saying nothing means the factory keeps making samples for a customer who
    // is gone — the sharpest cost of this whole gap.
    //
    // LOST cancels those styles. PARKED does not: it is expected back, and
    // cancelling a style would throw away a tech sheet that will be wanted
    // again. It leaves a line on the style's shared timeline instead, which is
    // what R&D actually reads.
    //
    // Best-effort and never fatal — the outcome is already saved, and failing
    // to notify must not undo it.
    if (plan.set.outcome === "lost" || plan.set.outcome === "parked") {
      try {
        const SampleStyle = require("../../../models/CMS_Models/Sales/SampleStyle");
        const open = await SampleStyle.find({
          journeyId: journey._id, isActive: true, status: "active",
        }).select("_id history status");
        for (const st of open) {
          st.history = [...(st.history || []), {
            kind: plan.set.outcome === "lost" ? "journey_lost" : "journey_parked",
            note: plan.set.outcome === "lost"
              ? `Sales marked this journey lost — stop work on this style.`
              : `Sales parked this journey — hold work until it is picked up again.`,
            by: actor(req),
            at: new Date(),
          }];
          if (plan.set.outcome === "lost") st.status = "cancelled";
          await st.save();
        }
      } catch (e) {
        console.error("[salesJourneys] notifying R&D of outcome failed", e.message);
      }
    }

    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-sales-journey",
      entityId: journey._id,
      entityLabel: journey.journeyId,
      action: "update",
      summary: `Sales Journey ${journey.journeyId} ${plan.summary}`,
      before,
      after: journey.toObject(),
    });

    /* Scoped like the write that preceded it: a reload must not be able to
       return a record the update itself could not have reached. */
    const saved = await SalesJourney.findOne(await scoped(req, { _id: journey._id }))
      .populate(POPULATE_DETAIL).lean({ virtuals: false });
    res.json({ success: true, journey: stripJourneyCommercial(detailDto(saved), req.user) });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    const status =
      err instanceof ValidationError || err instanceof JourneyTransitionError ||
      err.name === "ValidationError" || err.name === "JourneyTransitionError"
        ? 400
        : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

module.exports = router;
