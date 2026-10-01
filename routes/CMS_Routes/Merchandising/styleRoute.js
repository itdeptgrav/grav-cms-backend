"use strict";
// routes/CMS_Routes/Merchandising/styleRoute.js
//
// MERCHANDISING'S OWN DOORS ONTO THE SHARED STYLE RECORD.
//
// A `SampleStyle` is one record with several owners. Merchandising chooses the
// materials and the packaging on it; Sales raises it and R&D builds the
// technical half. Ownership of the RECORD is Sales'; ownership of these
// OPERATIONS is Merchandising's, and until now they did not match: every one of
// these handlers lived on `routes/CMS_Routes/Sales/sampleStyles.js`.
//
// ── WHY THEY MOVED ──────────────────────────────────────────────────────────
// That router is 4,500 lines and is being rewritten by another lane for
// multi-tenancy. Merchandising's endpoints sat in the middle of it, which meant
// a Merchandising release could not be assembled without also taking whatever
// state that rewrite happened to be in. Eleven handlers were holding the whole
// application hostage to a file none of them belonged in.
//
// Nothing about the handlers changed. They resolve the company the same way,
// demand the same live Merchandising grant, and call the same services. What
// changed is the door they are behind and the file they live in.
//
// ── AND THE OLD URLs STILL ANSWER ───────────────────────────────────────────
// The R&D application calls four of these on the Sales path. Breaking it to
// tidy a boundary would be a poor trade, so `legacyPackagingCompat` below
// registers those four legacy shapes against THE SAME handler functions. It is
// a second doorway onto one room, not a second room: there is no copy of any
// handler, and this file imports nothing of the Sales router.
//
// ── AUTHORISATION IS UNCHANGED AND IS STILL THE SERVICES' ───────────────────
// Every handler resolves the company itself and then asks
// `access.service.js` for the live grant. That is why they can be mounted
// behind two different authentication middlewares without either mount
// deciding what a person may do: the mount proves WHO is calling, the handler
// proves what they may do, and only the second one is Merchandising's rule.

const crypto = require("crypto");
const express = require("express");

const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");

const merchandisingAccess = require("../../../services/merchandising/access.service");
const {
  merchandisingScopeFor, isScopeRefusal,
} = require("../../../services/companyContext/merchandisingScope.service");
const { scopeFor: salesScopeFor } = require("../../../services/companyContext/salesScope.service");
const { ownershipProofFor } = require("../../../services/integration/styleOwnershipProof.service");
const packagingBom = require("../../../services/sales/packagingBom.service");
const styleDevelopment = require("../../../services/merchandising/styleDevelopment.service");
const styleApplicability = require("../../../services/styleApplicability");
const {
  resolveStyle, logHistory, actorOf: actor, isObjectId,
} = require("../../../services/merchandising/styleRecord.service");
const SampleStyle = require("../../../models/CMS_Models/Sales/SampleStyle");
const RawItem = require("../../../models/CMS_Models/Inventory/Products/RawItem");
const SalesJourney = require("../../../models/CMS_Models/Sales/SalesJourney");
const Enquiry = require("../../../models/CMS_Models/Sales/Enquiry");
const { publicSelection: publicPackagingSelection } = packagingBom;

const router = express.Router();
router.use(EmployeeAuthMiddleware);

/* The compatibility doorway. Its own router so it carries the AUTHENTICATION
   the callers on that path already use, while sharing every handler below. */
const legacy = express.Router();
legacy.use(salesAuth);

/* ══════════════════════════════════════════════════════════════════════════
 THE MERCHANDISING STYLE BOUNDARY
 ═══════════════════════════════════════════════════════════════════════════
 Merchandising works from a STYLE. It has no Journey concept at all, and the
 ordinary style list is not usable here: it populates `journeyId` and returns
 the journey's own name, which is Sales' commercial spine and none of
 Merchandising's business.

 So this is a separate, deliberately thin boundary. It publishes a style's
 IDENTITY and what Merchandising owns on it, and nothing else — no journey,
 no enquiry, no customer, no quantity, no supplier, no rate, no costing.

 ── OWNERSHIP IS PROVED, NOT REIMPLEMENTED ─────────────────────────────────
 A SampleStyle carries no `companyId`; it is proved through its parent, which
 is what `ownershipProofFor` already does for every other reader. The parents
 are queried by company FIRST so the style query is bounded, and each style
 is then proved individually — so a style whose parent is unowned is absent
 rather than assumed.
════════════════════════════════════════════════════════════════════════════ */

/**
 * Everything that may leave this boundary for one style.
 *
 * An allowlist, and a short one. `ownershipProofFor` returns `journeyRef` and
 * it is deliberately not read here: publishing the whole proof would put the
 * journey back on the screen through the back door.
 */
function publicMerchandisingStyle(style) {
const packaging = (style.materials?.packagingSelections || []);
return {
  id: String(style._id),
  /* The two references Merchandising actually recognises a style by. */
  styleRef: style.sampleStyleId || "",
  styleCode: style.styleCode || "",
  productName: style.productName || "",
  variantLabel: style.variantLabel || "",
  /* Counts only — the lifecycle is the point, not the components. */
  packagingCounts: {
    approved: packaging.filter((r) => r.status === "approved").length,
    proposed: packaging.filter((r) => r.status === "proposed").length,
    withdrawn: packaging.filter((r) => r.status === "withdrawn").length,
  },
  updatedAt: style.updatedAt || null,
};
}

/**
 * GET /merchandising/styles — the styles this company owns.
 *
 * Company-scoped through the parents, which carry the company; the style does
 * not. Role-gated by `salesAuth`, the same gate every other style route uses.
 */

const listStyles = async (req, res) => {
try {
  const scope = await merchandisingScopeFor(req);
  /* Reading Merchandising's own style list. The company is resolved first, then the LIVE grant, and only
     then is the record reached for. */
  await merchandisingAccess.requireMerchandisingCapability(req, merchandisingAccess.CAPABILITY.FILE_READ);

  /* ── BOUND THE QUERY BY THE COMPANY'S OWN PARENTS ──────────────────
     Two indexed reads, then a style query restricted to what they found.
     Scanning every style and proving each would work and would read the
     whole collection to answer one company's question. */
  /* Resolved once and spread into both reads — the form the tenancy guard
     recognises, so a future edit that drops it is caught by the scanner
     rather than by somebody seeing another company's styles. */
  const companyClause = { companyId: scope.companyId };
  const [journeys, enquiries] = await Promise.all([
    SalesJourney.find({ ...companyClause }).select("_id").lean(),
    Enquiry.find({ ...companyClause }).select("_id").lean(),
  ]);
  const journeyIds = journeys.map((j) => j._id);
  const enquiryIds = enquiries.map((e) => e._id);
  if (!journeyIds.length && !enquiryIds.length) return res.json({ success: true, styles: [] });

  const q = String(req.query.q || "").trim();
  const filter = {
    isActive: true,
    $or: [
      ...(journeyIds.length ? [{ journeyId: { $in: journeyIds } }] : []),
      ...(enquiryIds.length ? [{ enquiryId: { $in: enquiryIds } }] : []),
    ],
  };
  if (q) {
    /* Narrowed with `$and` so the search cannot displace the ownership
       clause above — the failure mode of merging two `$or`s into one. */
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$and = [{ $or: [{ productName: rx }, { styleCode: rx }, { sampleStyleId: rx }] }];
  }

  const rows = await SampleStyle.find(filter)
    .select("sampleStyleId styleCode productName variantLabel materials.packagingSelections journeyId enquiryId updatedAt")
    .sort({ updatedAt: -1 }).limit(200).lean();

  /* Proved one by one even though the query was bounded: a parent whose
     company is unset proves nothing, and the bound above cannot see that. */
  const styles = [];
  for (const style of rows) {
    if (!(await ownershipProofFor(style, scope.companyId))) continue;
    styles.push(publicMerchandisingStyle(style));
  }
  return res.json({ success: true, styles });
} catch (err) {
  /* A company-context refusal already knows what it is — "choose a company",
     "not your company", "ask again shortly". Flattening it to a 500 tells
     the screen nothing it can act on. Anything else falls through to the
     handling this block always had. */
  if (isScopeRefusal(err)) return res.status(err.status).json(err.toResponse());
  console.error("[merchandising/styleRoute] GET /merchandising/styles", err);
  return res.status(500).json({ success: false, message: err.message });
}
};

const readStyle = async (req, res) => {
try {
  const scope = await merchandisingScopeFor(req);
  /* Reading one style's Merchandising identity. The company is resolved first, then the LIVE grant, and only
     then is the record reached for. */
  await merchandisingAccess.requireMerchandisingCapability(req, merchandisingAccess.CAPABILITY.FILE_READ);
  /* Only now is the record reached for: the company is settled and the
     grant is proved, so a refusal cannot double as a way to ask whether
     a style exists. */
  const style = await resolveStyle(req.params.id);
  if (!style) return res.status(404).json({ success: false, message: "Style not found." });
  if (!(await ownershipProofFor(style, scope.companyId))) {
    /* Missing and foreign are one answer. */
    return res.status(404).json({ success: false, message: "Style not found." });
  }
  return res.json({ success: true, style: publicMerchandisingStyle(style) });
} catch (err) {
  /* A company-context refusal already knows what it is — "choose a company",
     "not your company", "ask again shortly". Flattening it to a 500 tells
     the screen nothing it can act on. Anything else falls through to the
     handling this block always had. */
  if (isScopeRefusal(err)) return res.status(err.status).json(err.toResponse());
  console.error("[merchandising/styleRoute] GET /merchandising/styles/:id", err);
  return res.status(500).json({ success: false, message: err.message });
}
};

const readStylePackaging = async (req, res) => {
try {
  const scope = await merchandisingScopeFor(req);
  /* Reading the packaging handoff. The company is resolved first, then the LIVE grant, and only
     then is the record reached for. */
  await merchandisingAccess.requireMerchandisingCapability(req, merchandisingAccess.CAPABILITY.FILE_READ);
  /* Only now is the record reached for: the company is settled and the
     grant is proved, so a refusal cannot double as a way to ask whether
     a style exists. */
  const style = await resolveStyle(req.params.id);
  if (!style) return res.status(404).json({ success: false, message: "Style not found." });
  if (!(await ownershipProofFor(style, scope.companyId))) {
    return res.status(404).json({ success: false, message: "Style not found." });
  }

  const merged = packagingBom.mergePackaging(
    style.materials?.packagingSelections || [],
    style.sample?.packagingRequirements || [],
  );
  const handoffBySelection = new Map(
    merged.rows
      .filter((row) => row.selectionStatus !== packagingBom.SELECTION_STATE.LEGACY)
      .map((row) => [String(row.rowId), packagingBom.merchandisingHandoff(row)]),
  );
  return res.json({
    success: true,
    selections: (style.materials?.packagingSelections || []).map((selection) => ({
      ...publicPackagingSelection(selection),
      handoff: handoffBySelection.get(String(selection.rowId))
        || { state: "AWAITING_APPROVAL", label: "Awaiting approval" },
    })),
    /* ── AND WHETHER THIS STYLE IS PACKED AT ALL ──────────────────────
       An empty selection list is not "no packaging"; it is also every
       style nobody has opened. Central Costing could not tell them apart,
       so it used to be answered there, by whoever was costing. */
    decision: styleApplicability.decisionView(style.materials?.packagingDecision),
  });
} catch (err) {
  /* A company-context refusal already knows what it is — "choose a company",
     "not your company", "ask again shortly". Flattening it to a 500 tells
     the screen nothing it can act on. Anything else falls through to the
     handling this block always had. */
  if (isScopeRefusal(err)) return res.status(err.status).json(err.toResponse());
  console.error("[merchandising/styleRoute] GET /merchandising/styles/:id/packaging", err);
  return res.status(500).json({ success: false, message: err.message });
}
};

const readStyleDevelopment = async (req, res) => {
try {
  const scope = await merchandisingScopeFor(req);
  /* Reading the development requirements. The company is resolved first, then the LIVE grant, and only
     then is the record reached for. */
  await merchandisingAccess.requireMerchandisingCapability(req, merchandisingAccess.CAPABILITY.FILE_READ);
  const out = await styleDevelopment.readDevelopment(scope, { styleId: req.params.id });
  return res.json({ success: true, ...out });
} catch (err) {
  /* A company-context refusal already knows what it is — "choose a company",
     "not your company", "ask again shortly". Flattening it to a 500 tells
     the screen nothing it can act on. Anything else falls through to the
     handling this block always had. */
  if (isScopeRefusal(err)) return res.status(err.status).json(err.toResponse());
  if (err?.code === styleDevelopment.CODES.NOT_FOUND) {
    return res.status(404).json({ success: false, message: "Style not found." });
  }
  console.error("[merchandising/styleRoute] GET /merchandising/styles/:id/development", err);
  return res.status(err?.status || 500).json({
    success: false, code: err?.code, message: err.message,
  });
}
};

const saveStyleDevelopment = async (req, res) => {
try {
  const scope = await merchandisingScopeFor(req);
  /* Stating what development work a style needs. The company is resolved first, then the LIVE grant, and only
     then is the record reached for. */
  await merchandisingAccess.requireMerchandisingCapability(req, merchandisingAccess.CAPABILITY.REQUIREMENT_WRITE);
  const out = await styleDevelopment.saveDevelopment(scope, {
    styleId: req.params.id,
    requirements: req.body?.development,
    actor: actor(req),
  });
  return res.json({ success: true, ...out });
} catch (err) {
  /* A company-context refusal already knows what it is — "choose a company",
     "not your company", "ask again shortly". Flattening it to a 500 tells
     the screen nothing it can act on. Anything else falls through to the
     handling this block always had. */
  if (isScopeRefusal(err)) return res.status(err.status).json(err.toResponse());
  if (err?.code === styleDevelopment.CODES.NOT_FOUND) {
    return res.status(404).json({ success: false, message: "Style not found." });
  }
  if (err?.code && err.code !== "COMPANY_CONTEXT_UNAVAILABLE") {
    /* The refusals this boundary raises are all "the body said something it
       may not say" — a 400 with the code and the row, so the screen can
       mark the row rather than the person hunting for what went wrong. */
    return res.status(err.status && err.status !== 500 ? err.status : 400).json({
      success: false, code: err.code, message: err.message, details: err.details || {},
    });
  }
  console.error("[merchandising/styleRoute] PUT /merchandising/styles/:id/development", err);
  return res.status(500).json({ success: false, message: err.message });
}
};

const decideStyleDevelopment = async (req, res) => {
try {
  const scope = await merchandisingScopeFor(req);
  await merchandisingAccess.requireMerchandising(req, merchandisingAccess.ROLE.EDITOR);
  const out = await styleDevelopment.saveDevelopmentDecision(scope, {
    styleId: req.params.id,
    required: req.body?.required,
    reason: req.body?.reason,
    actor: actor(req),
  });
  return res.json({ success: true, ...out });
} catch (err) {
  if (isScopeRefusal(err)) return res.status(err.status).json(err.toResponse());
  if (err?.code === styleDevelopment.CODES.NOT_FOUND) {
    return res.status(404).json({ success: false, message: "Style not found." });
  }
  if (err?.code && err.code !== "COMPANY_CONTEXT_UNAVAILABLE") {
    return res.status(err.status && err.status !== 500 ? err.status : 400).json({
      success: false, code: err.code, message: err.message, details: err.details || {},
    });
  }
  console.error("[merchandising/styleRoute] PUT /merchandising/styles/:id/development/decision", err);
  return res.status(500).json({ success: false, message: err.message });
}
};

const listPackagingSelections = async (req, res) => {
try {
  const style = await resolveStyle(req.params.id);
  if (!style) return res.status(404).json({ success: false, message: "Style not found." });
  const scope = await salesScopeFor(req);
  if (!(await ownershipProofFor(style, scope.companyId))) {
    return res.status(404).json({ success: false, message: "Style not found." });
  }
  /* Merged on READ as well as on write. The merge is idempotent by
     construction, so a page view cannot grow a duplicate requirement — and
     R&D sees an approved component the moment it is approved, without
     Merchandising having to trigger anything. */
  const merged = packagingBom.mergePackaging(
    style.materials?.packagingSelections || [],
    style.sample?.packagingRequirements || [],
  );
  const perCarton = style.sample?.shipment?.garmentsPerCarton ?? null;

  return res.json({
    success: true,
    selections: (style.materials?.packagingSelections || []).map(publicPackagingSelection),
    /* The BOM → Packaging read model: one row per component, carrying its
       selection lifecycle and R&D's consumption where there is any. */
    packaging: merged.rows,
    readiness: packagingBom.readiness(merged.rows, { garmentsPerCarton: perCarton }),
    /* Stated once for the style and shared with freight — reported here so
       a carton row can show what it depends on, never copied onto a row. */
    shipment: { garmentsPerCarton: perCarton },
    /* ── IS THIS STYLE PACKED AT ALL? ────────────────────────────────
       Merchandising's whole-style answer, which an empty selection list
       could never be. Central Costing reads it; until it is given, the
       packaging family stays outstanding rather than costing the garment
       as though it shipped loose. */
    decision: styleApplicability.decisionView(style.materials?.packagingDecision),
  });
} catch (err) {
  console.error("[merchandising/styleRoute] GET /:id/packaging-selections", err);
  return res.status(500).json({ success: false, message: err.message });
}
};

const savePackagingDecision = async (req, res) => {
try {
  const scope = await merchandisingScopeFor(req);
  await merchandisingAccess.requireMerchandising(req, merchandisingAccess.ROLE.EDITOR);
  const style = await resolveStyle(req.params.id);
  if (!style) return res.status(404).json({ success: false, message: "Style not found." });
  if (!(await ownershipProofFor(style, scope.companyId))) {
    return res.status(404).json({ success: false, message: "Style not found." });
  }

  const parsed = styleApplicability.parseDecision(req.body || {}, { actor: actor(req) });
  if (!parsed.ok) {
    return res.status(400).json({ success: false, code: parsed.code, message: parsed.message, field: parsed.field });
  }

  /* ── "NONE" CANNOT STAND BESIDE APPROVED COMPONENTS ─────────────────
     A style with an approved poly bag and a statement that it needs no
     packaging is two answers, and the costing would have to choose. A
     withdrawn selection does not count: it is already decided against. */
  const live = (style.materials?.packagingSelections || [])
    .filter((r) => r.status === packagingBom.APPROVED || r.status === packagingBom.PROPOSED);
  if (parsed.value.required === false && live.length) {
    return res.status(400).json({
      success: false, code: "PACKAGING_COMPONENTS_SELECTED",
      message: `This style has ${live.length} packaging component${live.length === 1 ? "" : "s"} selected. `
        + "Withdraw them first, or leave them and record that packaging is required.",
      field: "required",
    });
  }

  style.materials = style.materials || {};
  style.materials.packagingDecision = parsed.value;
  style.markModified("materials.packagingDecision");
  await style.save();

  return res.json({
    success: true,
    decision: styleApplicability.decisionView(style.materials.packagingDecision),
  });
} catch (err) {
  if (isScopeRefusal(err)) return res.status(err.status).json(err.toResponse());
  if (err?.status && typeof err.toResponse === "function") {
    return res.status(err.status).json(err.toResponse());
  }
  console.error("[merchandising/styleRoute] PUT /:id/packaging-decision", err);
  return res.status(500).json({ success: false, message: err.message });
}
};

const selectPackaging = async (req, res) => {
try {
  const scope = await merchandisingScopeFor(req);
  /* Choosing a packaging component. The company is resolved first, then the LIVE grant, and only
     then is the record reached for. */
  await merchandisingAccess.requireMerchandisingCapability(req, merchandisingAccess.CAPABILITY.SELECTION_WRITE);
  /* Only now is the record reached for: the company is settled and the
     grant is proved, so a refusal cannot double as a way to ask whether
     a style exists. */
  const style = await resolveStyle(req.params.id);
  if (!style) return res.status(404).json({ success: false, message: "Style not found." });
  if (!(await ownershipProofFor(style, scope.companyId))) {
    return res.status(404).json({ success: false, message: "Style not found." });
  }

  const rawItemId = req.body?.rawItemId;
  if (!isObjectId(rawItemId)) {
    return res.status(400).json({
      success: false, code: "PACKAGING_ITEM_REQUIRED",
      message: "Choose a packaging item from the register.",
    });
  }
  /* Company-scoped, and missing and foreign answer alike. */
  const item = await RawItem.findOne({ _id: rawItemId, companyId: scope.companyId })
    .select("name sku unit").lean();
  if (!item) {
    return res.status(404).json({
      success: false, code: "PACKAGING_ITEM_NOT_FOUND",
      message: "That packaging item is not in this company's register.",
    });
  }

  style.materials = style.materials || {};
  style.materials.packagingSelections = style.materials.packagingSelections || [];
  const row = {
    /* Minted server-side. Two legitimate rows may name the same item — two
       different printed bags — and keying by what they name would merge
       them. */
    rowId: crypto.randomBytes(8).toString("hex"),
    rawItemId: item._id,
    /* Snapshots for readability. The id is the identity: a renamed master
       must not orphan the row, and a name is never what a lookup matches. */
    rawItemName: item.name || "",
    rawItemSku: item.sku || "",
    specification: String(req.body?.specification || "").trim().slice(0, 2000),
    status: "proposed",
    selectedBy: actor(req),
    selectedAt: new Date(),
  };
  style.materials.packagingSelections.push(row);
  logHistory(style, {
    kind: "packaging_selected",
    note: `${row.rawItemName || "A packaging item"} added to the packaging selection.`,
  }, req);
  style.updatedBy = actor(req);
  await style.save();

  return res.status(201).json({ success: true, selection: publicPackagingSelection(row) });
} catch (err) {
  /* A company-context refusal already knows what it is — "choose a company",
     "not your company", "ask again shortly". Flattening it to a 500 tells
     the screen nothing it can act on. Anything else falls through to the
     handling this block always had. */
  if (isScopeRefusal(err)) return res.status(err.status).json(err.toResponse());
  console.error("[merchandising/styleRoute] POST /:id/packaging-selections", err);
  return res.status(500).json({ success: false, message: err.message });
}
};

const setPackagingSelectionStatus = async (req, res) => {
try {
  const scope = await merchandisingScopeFor(req);
  /* Restating a packing instruction is an EDIT; approving a component or
     withdrawing one is a DECISION. The same door, two authorities — so the
     level is read from what the body actually asks for, and a body that
     does both needs the higher. */
  await merchandisingAccess.requireMerchandisingCapability(
    req, merchandisingAccess.packagingChangeCapability(req.body),
  );
  /* Only now is the record reached for: the company is settled and the
     grant is proved, so a refusal cannot double as a way to ask whether
     a style exists. */
  const style = await resolveStyle(req.params.id);
  if (!style) return res.status(404).json({ success: false, message: "Style not found." });
  if (!(await ownershipProofFor(style, scope.companyId))) {
    return res.status(404).json({ success: false, message: "Style not found." });
  }

  const row = (style.materials?.packagingSelections || [])
    .find((r) => String(r.rowId) === String(req.params.rowId));
  if (!row) return res.status(404).json({ success: false, message: "That packaging selection is not on this style." });

  if (req.body?.specification !== undefined) {
    row.specification = String(req.body.specification || "").trim().slice(0, 2000);
  }

  const status = req.body?.status;
  if (status !== undefined) {
    if (!["proposed", "approved", "withdrawn"].includes(status)) {
      return res.status(400).json({
        success: false, code: "PACKAGING_STATUS_INVALID",
        message: "A packaging selection is proposed, approved or withdrawn.",
      });
    }
    if (status === "withdrawn") {
      const reason = String(req.body?.withdrawnReason || "").trim();
      if (!reason) {
        /* R&D may have recorded consumption against it, and "it went away"
           is not something they can act on. */
        return res.status(400).json({
          success: false, code: "PACKAGING_WITHDRAW_REASON_REQUIRED",
          message: "Say why this packaging component is no longer needed.",
        });
      }
      row.withdrawnReason = reason.slice(0, 1000);
      row.withdrawnAt = new Date();
      row.withdrawnBy = actor(req);
    }
    row.status = status;
  }

  logHistory(style, {
    kind: "packaging_selection_changed",
    note: `${row.rawItemName || "A packaging item"} is now ${row.status}.`,
  }, req);
  style.updatedBy = actor(req);
  await style.save();

  return res.json({ success: true, selection: publicPackagingSelection(row) });
} catch (err) {
  /* A company-context refusal already knows what it is — "choose a company",
     "not your company", "ask again shortly". Flattening it to a 500 tells
     the screen nothing it can act on. Anything else falls through to the
     handling this block always had. */
  if (isScopeRefusal(err)) return res.status(err.status).json(err.toResponse());
  console.error("[merchandising/styleRoute] PATCH /:id/packaging-selections/:rowId", err);
  return res.status(500).json({ success: false, message: err.message });
}
};

const savePackagingRequirement = async (req, res) => {
try {
  const style = await resolveStyle(req.params.id);
  if (!style) return res.status(404).json({ success: false, message: "Style not found." });
  const scope = await salesScopeFor(req);
  if (!(await ownershipProofFor(style, scope.companyId))) {
    return res.status(404).json({ success: false, message: "Style not found." });
  }

  style.sample = style.sample || {};
  const selections = style.materials?.packagingSelections || [];
  /* Merged first, so a component approved since the last write already has a
     row to edit and the identity is authoritative before anything is set. */
  const merged = packagingBom.mergePackaging(selections, style.sample.packagingRequirements || []);
  const rowId = String(req.params.rowId);
  const row = merged.requirements.find(
    (r) => String(r.sourceSelectionRowId || "") === rowId || String(r.rowId || "") === rowId,
  );
  if (!row) return res.status(404).json({ success: false, message: "That packaging component is not on this style." });

  /* A proposal is not yet R&D's to measure. */
  const sel = selections.find((x) => String(x.rowId) === String(row.sourceSelectionRowId || ""));
  if (sel && sel.status === packagingBom.PROPOSED) {
    return res.status(409).json({
      success: false, code: "PACKAGING_NOT_APPROVED",
      message: "This component is still awaiting approval, so there is nothing yet to measure against.",
    });
  }

  const body = req.body || {};
  const included = body.included !== false;
  if (!included && !String(body.excludedReason || "").trim()) {
    return res.status(400).json({
      success: false, code: "PACKAGING_EXCLUDE_REASON_REQUIRED",
      message: "Say why this was considered and left out. A row excluded without a reason is indistinguishable from a mistake.",
    });
  }
  if (included) {
    const q = Number(body.quantity);
    if (!Number.isFinite(q) || q <= 0) {
      return res.status(400).json({
        success: false, code: "PACKAGING_QUANTITY_REQUIRED",
        message: "Say how much is used. A blank quantity is not zero.",
      });
    }
    if (!String(body.unit || "").trim()) {
      return res.status(400).json({ success: false, code: "PACKAGING_UNIT_REQUIRED", message: "Say what unit that quantity is in." });
    }
    row.quantity = q;
    row.unit = String(body.unit).trim().slice(0, 60);
  }
  const basis = ["PER_GARMENT", "PER_CARTON", "FIXED_PER_RUN"].includes(body.basis) ? body.basis : "PER_GARMENT";
  row.basis = basis;
  if (["SAMPLE_MEASURED", "BOM_PLANNED"].includes(body.evidence)) row.evidence = body.evidence;
  row.included = included;
  row.excludedReason = included ? "" : String(body.excludedReason).trim().slice(0, 500);
  row.notes = String(body.notes || "").trim().slice(0, 500);

  style.sample.packagingRequirements = merged.requirements;
  style.updatedBy = actor(req);
  await style.save();

  const after = packagingBom.mergePackaging(selections, style.sample.packagingRequirements);
  const perCarton = style.sample?.shipment?.garmentsPerCarton ?? null;
  return res.json({
    success: true,
    packaging: after.rows,
    readiness: packagingBom.readiness(after.rows, { garmentsPerCarton: perCarton }),
    shipment: { garmentsPerCarton: perCarton },
  });
} catch (err) {
  console.error("[merchandising/styleRoute] PATCH /:id/packaging-requirements/:rowId", err);
  return res.status(500).json({ success: false, message: err.message });
}
};

/* ── THE MERCHANDISING NAMESPACE ─────────────────────────────────────── */
router.get("/styles", listStyles);
router.get("/styles/:id", readStyle);
router.get("/styles/:id/packaging", readStylePackaging);
router.get("/styles/:id/development", readStyleDevelopment);
router.put("/styles/:id/development", saveStyleDevelopment);
router.put("/styles/:id/development/decision", decideStyleDevelopment);
router.get("/styles/:id/packaging-selections", listPackagingSelections);
router.put("/styles/:id/packaging-decision", savePackagingDecision);
router.post("/styles/:id/packaging-selections", selectPackaging);
router.patch("/styles/:id/packaging-selections/:rowId", setPackagingSelectionStatus);
router.patch("/styles/:id/packaging-requirements/:rowId", savePackagingRequirement);

/* ── THE LEGACY PACKAGING DOORWAY, FOR R&D ───────────────────────────── */
legacy.get("/:id/packaging-selections", listPackagingSelections);
legacy.put("/:id/packaging-decision", savePackagingDecision);
legacy.post("/:id/packaging-selections", selectPackaging);
legacy.patch("/:id/packaging-selections/:rowId", setPackagingSelectionStatus);
legacy.patch("/:id/packaging-requirements/:rowId", savePackagingRequirement);

module.exports = router;
module.exports.legacyPackagingCompat = legacy;
