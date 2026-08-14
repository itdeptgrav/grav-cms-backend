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
const Account = require("../../../models/CMS_Models/Sales/Account");
const Contact = require("../../../models/CMS_Models/Sales/Contact");
const Site = require("../../../models/CMS_Models/Sales/Site");
const Address = require("../../../models/CMS_Models/Sales/Address");
const Activity = require("../../../models/CMS_Models/Sales/Activity");
const Lead = require("../../../models/CMS_Models/Sales/Lead");
const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");
const { recordChange } = require("../../../services/changeLog");
const { createWithRef } = require("../../../services/salesJourneyRef");
const { assertLeadConvertible, deriveLegacyStage } = require("../../../services/leadQualification");
const { planStageTransition, JourneyTransitionError } = require("../../../services/salesJourneyProgress");
const { computeAccountEnquiryReadiness } = require("../../../services/accountReadiness");
const { isSalesManager } = require("../../../services/salesAccess");
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
      risk, businessType, waitingOn, valueMin, valueMax,
      page = 1, limit = 50,
    } = req.query;

    const filter = { isActive: true };

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
    res.json({ success: true, journey: stripJourneyCommercial(detailDto(journey), req.user) });
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
    if (!b.businessType) throw new ValidationError("Business type is required.");
    assertEnum(b.businessType, SALES_JOURNEY_BUSINESS_TYPE_CODES, "Business type");

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

    // Account → Enquiry is a real, server-enforced gate: the customer
    // foundation must be complete before this Journey can leave the Account
    // stage. The rule (services/accountReadiness.js) is DB-dependent, so we
    // load the account bundle here and hand the planner the verdict as context
    // — the same caller-computes-facts/planner-enforces split the Lead
    // qualification gate uses. Only worth loading when actually advancing off
    // the Account stage.
    let context;
    if (String(b.action || "").trim() === "advance" && journey.currentStage === "account" && journey.accountId) {
      const accId = journey.accountId;
      const [account, contacts, sites, addresses] = await Promise.all([
        Account.findById(accId).select("roles assignedToName garmentSalesProfile.businessModels").lean(),
        Contact.countDocuments({ accountId: accId, isActive: true }),
        Site.countDocuments({ accountId: accId, isActive: true }),
        Address.countDocuments({ accountId: accId, isActive: true }),
      ]);
      context = {
        accountReadiness: computeAccountEnquiryReadiness({
          account,
          contacts: { length: contacts },
          sites: { length: sites },
          addresses: { length: addresses },
        }),
      };
    }

    // Pure planner — throws JourneyTransitionError for any illegal move.
    const plan = planStageTransition(journey, {
      action: b.action,
      toState: b.toState || b.state,
      stage: b.stage,
      reason: b.reason,
      context,
    });

    const before = journey.toObject();
    for (const [path, value] of Object.entries(plan.set)) journey.set(path, value);
    journey.updatedBy = actor(req);
    await journey.save();

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
