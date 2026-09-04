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
const router = express.Router();

const mongoose = require("mongoose");
const SalesJourney = require("../../../models/CMS_Models/Sales/SalesJourney");
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
const { planStageTransition, JourneyTransitionError } = require("../../../services/salesJourneyProgress");
const { isSalesManager } = require("../../../services/salesAccess");
const { journeyAttention } = require("../../../services/journeyAttention");
const { ensureOrderLink } = require("../../../services/orderBookLink");
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

// Split a single "Full Name" string into { firstName, lastName } — the Contact
// model wants the two apart, a Lead often only has the whole thing (a
// decisionMakerName, or a lead.contacts[] entry's `name`).
function splitName(full) {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

// Derive the Account primary Contact a converting Lead should seed, or null if
// the Lead carries no usable person. The Lead model's own comment says its
// contacts "belong to an Account, created at conversion" — this is that
// promotion, which never actually happened before: a Lead that qualified on a
// contact route + a decision-maker would still land on an Account with zero
// contacts, forcing the salesperson to re-enter someone they already had.
//
// Preference order: a lead.contacts[] entry flagged decision-maker → the first
// lead.contacts[] entry → the Lead's own top-level person fields (with the
// canonical decisionMakerName as the name when the Lead itself is company-only).
function deriveAccountContactFromLead(lead = {}) {
  const list = Array.isArray(lead.contacts) ? lead.contacts : [];
  const chosen = list.find((c) => c.isDecisionMaker && String(c.name || "").trim()) || list.find((c) => String(c.name || "").trim());

  if (chosen) {
    const { firstName, lastName } = splitName(chosen.name);
    return {
      firstName,
      lastName,
      email: chosen.email || undefined,
      phone: chosen.phone || undefined,
      jobTitle: chosen.role || undefined,
      roles: chosen.isDecisionMaker ? ["decision_maker"] : [],
    };
  }

  // Fall back to the Lead's top-level person. A pre-Account Lead that qualified
  // has at least a phone/email and a decision-maker name (see
  // services/leadReadiness.js), so there is normally something here.
  const hasOwnPerson = String(lead.firstName || "").trim() || String(lead.lastName || "").trim();
  if (hasOwnPerson) {
    return {
      firstName: lead.firstName || "",
      lastName: lead.lastName || "",
      email: lead.email || undefined,
      phone: lead.phone || undefined,
      mobile: lead.whatsapp || undefined,
      jobTitle: lead.designation || undefined,
      roles: [],
    };
  }
  if (String(lead.decisionMakerName || "").trim()) {
    const { firstName, lastName } = splitName(lead.decisionMakerName);
    return {
      firstName,
      lastName,
      email: lead.email || undefined,
      phone: lead.phone || undefined,
      mobile: lead.whatsapp || undefined,
      jobTitle: lead.decisionMakerRole || undefined,
      roles: ["decision_maker"],
    };
  }
  return null;
}

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

/** Resolve an Account reference, asserting it exists and may trade. */
async function assertUsableAccount(id, label) {
  if (!isObjectId(id)) throw new ValidationError(`${label} is not a valid account reference.`);
  const acc = await Account.findById(id).select("accountId companyName status isActive").lean();
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
      const matchedAccounts = await Account.find({ $or: [{ companyName: re }, { accountId: re }, { displayName: re }] })
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

    const [rows, total] = await Promise.all([
      SalesJourney.find(filter)
        .populate(POPULATE_SUMMARY)
        .sort({ updatedAt: -1 })
        .skip((pageNum - 1) * perPage)
        .limit(perPage)
        .lean({ virtuals: false }),
      SalesJourney.countDocuments(filter),
    ]);

    res.json({
      success: true,
      journeys: stripJourneyCommercialList(rows.map(summaryDto), req.user),
      pagination: { page: pageNum, limit: perPage, total, pages: Math.ceil(total / perPage) },
    });
  } catch (err) {
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
    const rows = await SalesJourney.aggregate([
      { $match: match },
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
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ── GET /api/cms/crm/sales-journeys/:journeyId ──────────────────────────────
   Keyed on the HUMAN reference. A Mongo id in this URL would end up in a
   breadcrumb, which the frontend spec forbids outright. */

router.get("/:journeyId", salesAuth, async (req, res) => {
  try {
    const journey = await SalesJourney.findOne({ journeyId: req.params.journeyId, isActive: true })
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
    const gate = await advanceStatus(journey);
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
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ── POST /api/cms/crm/sales-journeys ───────────────────────────────────────── */

router.post("/", salesAuth, async (req, res) => {
  try {
    const b = req.body || {};

    // ── Account: required, must exist, must be tradeable ──────────────────
    if (!b.accountId) throw new ValidationError("Select a customer Account for this Journey.");
    const account = await assertUsableAccount(b.accountId, "Customer account");

    // ── Lead → Journey bridge: resolved and validated FIRST, before anything
    //    is written, so a Lead that cannot convert never leaves an orphaned
    //    Journey behind. See assertLeadConvertible for the rule; the atomic
    //    write that actually flips the Lead happens after the Journey (and its
    //    optional Activity) are safely created — see below.
    let sourceLead = null;
    if (b.sourceLeadId) {
      if (!isObjectId(b.sourceLeadId)) throw new ValidationError("Source lead is not a valid reference.");
      sourceLead = await Lead.findById(b.sourceLeadId);
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
      const contact = await Contact.findById(b.primaryContactId).select("accountId isActive").lean();
      if (!contact) throw new ValidationError("Primary contact was not found.");
      if (String(contact.accountId) !== String(account._id)) {
        throw new ValidationError("The primary contact does not belong to the selected account.");
      }
      primaryContactId = b.primaryContactId;
    }

    // ── Carry the Lead's person across to the Account, if it has none ──────
    // A converting Lead qualified on a contact route + a decision-maker, but
    // that person lived only on the Lead. Promote it to a real Account Contact
    // here (the Lead model's own comment: contacts "belong to an Account,
    // created at conversion") so the Journey doesn't land on a contactless
    // Account. Only when: converting, the caller didn't pass one, and the
    // Account genuinely has no contact yet. Tracked for rollback below.
    let createdContactId = null;
    if (sourceLead && !primaryContactId) {
      const existing = await Contact.countDocuments({ accountId: account._id, isActive: true });
      if (existing === 0) {
        const seed = deriveAccountContactFromLead(sourceLead);
        if (seed && (seed.firstName || seed.lastName)) {
          const contact = await Contact.create({
            ...seed,
            accountId: account._id,
            isPrimary: true,
            isActive: true,
            createdBy: actor(req),
            updatedBy: actor(req),
          });
          primaryContactId = contact._id;
          createdContactId = contact._id;
        }
      }
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
      await assertUsableAccount(value, label);
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
    const journey = await createWithRef(SalesJourney, payload);

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
      const convertedLead = await Lead.findOneAndUpdate(
        { _id: sourceLead._id, qualificationState: "readyToConvert" },
        {
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
        { new: true },
      );

      if (!convertedLead) {
        // Lost the race — roll back so a retry never leaves two Journeys.
        if (journey.currentNextActionId) await Activity.deleteOne({ _id: journey.currentNextActionId }).catch(() => {});
        await SalesJourney.deleteOne({ _id: journey._id }).catch(() => {});
        // The Contact we seeded from the Lead belongs to this rolled-back
        // conversion — remove it too, so the winning request seeds its own.
        if (createdContactId) await Contact.deleteOne({ _id: createdContactId }).catch(() => {});
        return res.status(409).json({
          success: false,
          message: "This Lead already started a Sales Journey — refresh and open its record instead.",
        });
      }

      const leadLabel = convertedLead.company || `${convertedLead.firstName || ""} ${convertedLead.lastName || ""}`.trim() || convertedLead.leadId;
      await recordChange(req, {
        departmentSlug: "sales",
        entity: "lead",
        entityId: convertedLead._id,
        entityLabel: leadLabel,
        action: "update",
        summary: `Lead ${convertedLead.leadId} converted to Sales Journey ${journey.journeyId}`,
        after: convertedLead.toObject(),
      });
    }

    const saved = await SalesJourney.findById(journey._id).populate(POPULATE_DETAIL).lean({ virtuals: false });

    res.status(201).json({
      success: true,
      journey: stripJourneyCommercial(detailDto(saved), req.user),
      ...(warning ? { warning } : {}),
    });
  } catch (err) {
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

// PATCH /api/cms/crm/sales-journeys/:journeyId/po
// Record the customer's purchase order against the journey. This is what makes
// "do not start production without a PO" checkable at all — before it, nothing
// anywhere held a PO, so the PO/Contract stage could complete on nothing.
router.patch("/:journeyId/po", salesAuth, async (req, res) => {
  try {
    const journey = await SalesJourney.findOne({ journeyId: req.params.journeyId, isActive: true });
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
    // the moment to pin its order record by id instead of leaving the post-PO
    // screens to find it by matching the customer's name. Advisory: never
    // throws, and a PO is recorded whether or not the link resolves. See
    // services/orderBookLink.js for why it links but does not create.
    const orderLink = await ensureOrderLink(journey);

    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-sales-journey",
      entityId: journey._id,
      entityLabel: journey.journeyId,
      action: "update",
      summary: `Sales Journey ${journey.journeyId} PO recorded (${number})`
        + (orderLink.linked && orderLink.requestId ? ` — order ${orderLink.requestId} linked` : ""),
      before,
      after: journey.toObject(),
    });

    const saved = await SalesJourney.findById(journey._id).populate(POPULATE_DETAIL).lean({ virtuals: false });
    return res.json({
      success: true,
      journey: stripJourneyCommercial(detailDto(saved), req.user),
      // Advisory only — the UI does not depend on it yet. Surfaced so the link
      // (or the reason it could not be made) is visible rather than silent.
      orderLink,
    });
  } catch (err) {
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
async function advanceStatus(journey) {
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

  const EnquiryModel = require("../../../models/CMS_Models/Sales/Enquiry");
  const CustomerRequestModel = require("../../../models/Customer_Models/CustomerRequest");
  const enquiry = await EnquiryModel.findOne({ journeyId: journey._id, isActive: true })
    .select("customerRequestId").lean();
  const order = enquiry?.customerRequestId
    ? await CustomerRequestModel.findById(enquiry.customerRequestId)
        .select("grandTotal totalPaidAmount quotations.grandTotal").lean()
    : null;

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
    const journey = await SalesJourney.findOne({ journeyId: req.params.journeyId, isActive: true });
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
      const closing = await closingVerdictForJourney(journey._id);
      if (closing) context = { closing };
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
        advance: await advanceStatus(journey),
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

    const saved = await SalesJourney.findById(journey._id).populate(POPULATE_DETAIL).lean({ virtuals: false });
    res.json({ success: true, journey: stripJourneyCommercial(detailDto(saved), req.user) });
  } catch (err) {
    const status =
      err instanceof ValidationError || err instanceof JourneyTransitionError ||
      err.name === "ValidationError" || err.name === "JourneyTransitionError"
        ? 400
        : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

module.exports = router;
