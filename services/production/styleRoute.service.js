// services/production/styleRoute.service.js
//
// PRODUCTION MANAGER — THE STYLE'S ROUTE AND ITS STANDARD TIME.
//
// ── WHOSE FACT THIS IS ──────────────────────────────────────────────────────
// Which operations a garment goes through, in what order, and how long each
// one takes. That is Production's engineering judgement, and it was being
// entered on R&D's technical record because that is where the field happened
// to live. The RECORD stays where it is — `techSheet.technical.operations[]`
// is still the one stored route, and this service writes that array and
// nothing else — but the DOOR is Production's now, and R&D's own writer no
// longer accepts operations at all.
//
// ── WHAT IT WILL NOT TOUCH ──────────────────────────────────────────────────
// Materials, packaging, requirements, the technical record's status, its
// revision, its evidence, the sample, the BOM. A body naming any of them is
// refused rather than partially applied: a save that quietly ignores half of
// what it was sent is a save nobody can reason about.
//
// It also accepts no money. Not a rate, not a salary, not a cost. Production
// records TIME; what a minute is worth is company policy, resolved at costing
// time from a record Production does not own and cannot see from here.
//
// ── AND NO JOURNEY LEAVES THIS FILE ─────────────────────────────────────────
// Production and Merchandising have no Journey concept — their work begins at
// a Style or a Product. Company ownership is still PROVED through the linked
// journey or enquiry, because that is where a SampleStyle's company actually
// lives, but neither id, nor an enquiry reference, nor a customer name is ever
// published by anything here. `styleView()` is the one shape that leaves, and
// it is built field by field for exactly that reason.
"use strict";

const mongoose = require("mongoose");
const crypto = require("crypto");

const { ownershipProofFor } = require("../centralCosting/technicalSource.service");
const technicalRecord = require("../centralCosting/technicalRecord.service");
const { fail } = require("../storePurchase/errors");
/* The three-field applicability answer, shared with Merchandising's two so one
   question does not get three subtly different validators. */
const styleApplicability = require("../styleApplicability");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

const model = (name, path) => (mongoose.models[name] || require(path));
const SampleStyle = () => model("SampleStyle", "../../models/CMS_Models/Sales/SampleStyle");
const StockItem = () => model("StockItem", "../../models/CMS_Models/Inventory/Products/StockItem");
const Operation = () => model("Operation", "../../models/CMS_Models/Inventory/Configurations/Operation");
const Service = () => model("Service", "../../models/CMS_Models/Inventory/Services/Service");

/* ── THE ONLY FIELDS A ROUTE ROW MAY CARRY IN ───────────────────────────────
 *
 * An allowlist, not a blocklist. A blocklist protects against the fields
 * somebody thought of; this refuses everything nobody declared, which is what
 * stops the next field added to the model from becoming writable here by
 * accident.
 *
 * `sequence` is accepted and never stored: the ARRAY ORDER is the sequence,
 * and storing a second copy of it would give two answers the first time
 * somebody reordered without renumbering. It is echoed back derived from the
 * index, so a client can render "3 of 7" without inventing it. */
const ROW_FIELDS = Object.freeze(["operationId", "minutes", "seconds", "notes", "sequence"]);

/* ── AND THE ONLY FIELDS AN OUTSIDE-PROCESS ROW MAY CARRY IN ────────────────
 *
 * The same allowlist discipline. `sample.serviceRequirements[]` already holds
 * every fact this section needs, so nothing is invented and no second
 * collection is created — what is written here is that array, filtered to the
 * rows whose `purpose` is `OUTSIDE_PROCESS`.
 *
 * Four of the model's fields are deliberately NOT here:
 *
 *   · `purpose` — forced to OUTSIDE_PROCESS. A body that could set it could
 *     turn a process into a tooling charge, which is a different cost with a
 *     different basis and a different source.
 *   · `serviceCode` / `serviceName` — the register's identity, re-read on
 *     every save exactly as the route re-reads an operation's.
 *   · `owner` — forced to PRODUCTION, because this door is Production's.
 *   · `evidence` — "measured on the sample" is a claim the sample
 *     demonstrated the figure. Production stating a requirement is planning,
 *     not measuring, so it stays absent and costing reads an absent evidence
 *     as planned. The weaker reading, applied where the consequence lives.
 */
const OUTSIDE_PROCESS_FIELDS = Object.freeze([
  "rowId", "serviceId", "specification", "quantity",
  "billingUnit", "basis", "included", "excludedReason", "notes",
]);

/** The two bases a recurring process may be billed on. */
const SERVICE_BASES = Object.freeze(["PER_GARMENT", "FIXED_PER_RUN"]);

/* Fields that name money, another department's record, or the Journey. Named
   explicitly so the refusal can say WHICH one was sent rather than "unknown
   field" — a person who put a rate in the body needs to be told that rates are
   not Production's, not that they made a typo. */
const REFUSED_FIELDS = Object.freeze({
  operatorCost: "a labour cost", operatorSalary: "a salary", rate: "a rate",
  rateMinor: "a rate", cost: "a cost", amount: "an amount",
  salaryDept: "a salary basis", salaryDesig: "a salary basis",
  journeyId: "a journey", enquiryId: "an enquiry", journeyRef: "a journey",
  materials: "materials", packaging: "packaging",
  packagingRequirements: "packaging", requirements: "technical requirements",
  status: "the record's status", revision: "the record's revision",
  /* ── STORE'S EVIDENCE, AND FINANCE'S ────────────────────────────────
     Production states what the style needs; who supplies it and what they
     charge is Store's dated quotation, and a standing company charge is
     Finance's. Named so the refusal says which desk owns the field rather
     than "unknown field". */
  supplierId: "a supplier", supplierName: "a supplier",
  quotation: "a quotation", quotationReference: "a quotation",
  offerId: "a quotation", price: "a price", unitPrice: "a price",
  margin: "a margin", tax: "a tax treatment", gstRatePercent: "a tax rate",
  /* One-time setup work is a DEVELOPMENT_TOOLING row with its own source.
     It is not written through this door and cannot be reached from it. */
  purpose: "a requirement purpose",
  developmentSource: "a development source",
  developmentChargeKey: "a company charge",
  /* Identity is the register's, re-read on every save. */
  serviceCode: "a service code", serviceName: "a service name",
  /* Forced, not read: this door is Production's, and evidence is a claim
     about a sample rather than a statement of what is required. */
  owner: "a requirement owner", evidence: "sample evidence",
});

const CODES = Object.freeze({
  NOT_FOUND: "NOT_FOUND",
  ROUTE_NOT_EDITABLE: "STYLE_ROUTE_NOT_EDITABLE",
  OPERATION_NOT_REGISTERED: "OPERATION_NOT_REGISTERED",
  SERVICE_NOT_REGISTERED: "SERVICE_NOT_REGISTERED",
  FIELD_NOT_ACCEPTED: "FIELD_NOT_ACCEPTED",
  VALIDATION: "VALIDATION",
});

/**
 * WHAT A PRODUCTION SCREEN MAY BE TOLD ABOUT A STYLE.
 *
 * Built field by field. A spread of the document would publish `journeyId`,
 * `enquiryId` and the customer's name the first time somebody stopped reading
 * this function, and the rule that Production has no Journey concept would
 * become a comment rather than a fact.
 */
function styleView(style) {
  const ops = style?.techSheet?.technical?.operations || [];
  return {
    styleId: str(style._id),
    reference: str(style.styleCode) || str(style.sampleStyleId) || str(style.productName),
    productName: str(style.productName),
    variantLabel: str(style.variantLabel),
    /* R&D's record status, because it decides whether the route is editable.
       The status only — no revision history, no evidence, no materials. */
    technicalStatus: str(style.techSheet?.technical?.status) || technicalRecord.STATUS.NOT_STARTED,
    operationCount: ops.length,
    /* The run's standard time, summed once here so two screens cannot
       disagree about whether 90 seconds is a minute and a half. */
    samMinutes: ops.reduce((t, o) => t + (technicalRecord.samMinutesOf(o) || 0), 0),
  };
}

/** One stored operation, as a Production screen reads it. Order IS sequence. */
function routeRow(op, index) {
  return {
    sequence: index + 1,
    operationId: str(op.operationId),
    operationCode: str(op.operationCode),
    name: str(op.name),
    /* The master's fact, shown so the route can be checked, and never
       writable here — the machine belongs to the operation, not to this
       style's use of it. */
    machineType: str(op.machineType),
    minutes: Number(op.minutes) || 0,
    seconds: Number(op.seconds) || 0,
    samMinutes: technicalRecord.samMinutesOf(op),
    notes: str(op.notes),
    /* ── A ROW THAT PREDATES THE REGISTER LINK ────────────────────────
       `operationId` is schema-required on this array, so no such row can be
       written through mongoose — but a document inserted by an older driver
       path could still hold one, and it is PUBLISHED as it stands rather
       than filtered out of the read. Its stored code and name are its own
       snapshot and stay legible; what it cannot do is be costed. */
    legacy: !op.operationId,
  };
}

/** One outside-process requirement, as Production may read it. */
function outsideProcessRow(row, index) {
  return {
    rowId: str(row.rowId),
    sequence: index + 1,
    serviceId: str(row.serviceId),
    serviceCode: str(row.serviceCode),
    serviceName: str(row.serviceName),
    specification: str(row.specification),
    quantity: row.quantity === undefined || row.quantity === null ? null : Number(row.quantity),
    billingUnit: str(row.billingUnit),
    basis: SERVICE_BASES.includes(str(row.basis)) ? str(row.basis) : "PER_GARMENT",
    included: row.included !== false,
    excludedReason: str(row.excludedReason),
    notes: str(row.notes),
  };
}

function outsideProcessRows(style) {
  return (style?.sample?.serviceRequirements || [])
    .filter((row) => (str(row.purpose) || "OUTSIDE_PROCESS") === "OUTSIDE_PROCESS")
    .map(outsideProcessRow);
}

/** Is the route open to Production right now, and if not, why not. */
function editability(style) {
  const status = str(style?.techSheet?.technical?.status) || technicalRecord.STATUS.NOT_STARTED;
  if (status === technicalRecord.STATUS.SUBMITTED) {
    return {
      editable: false,
      reason: "This style's technical record is with Sales for approval. The route can be changed "
        + "again once they send it back.",
    };
  }
  if (status === technicalRecord.STATUS.APPROVED) {
    return {
      editable: false,
      /* An approved revision is what a costing may already have been
         calculated from. Frozen versions keep their own snapshot and are
         safe either way; what would not be safe is the approved revision
         quietly disagreeing with the copy it was approved as. */
      reason: "This style's technical record is approved. Sales must return it before the route "
        + "can be changed.",
    };
  }
  return { editable: true, reason: null };
}

/**
 * The style, proved to belong to this company.
 *
 * A style in another company is NOT FOUND rather than forbidden: saying "that
 * exists, elsewhere" is itself a disclosure.
 */
async function loadOwnedStyle(ctx, styleId) {
  if (!isId(styleId)) throw fail(CODES.NOT_FOUND, "That style was not found.");
  const style = await SampleStyle().findById(styleId);
  if (!style) throw fail(CODES.NOT_FOUND, "That style was not found.");
  const owned = await ownershipProofFor(style, ctx.companyId);
  if (!owned) throw fail(CODES.NOT_FOUND, "That style was not found.");
  return style;
}

/**
 * THE STYLES OF ONE PRODUCT.
 *
 * Production's entry point is a Product — they have no Journey and no enquiry
 * list. A stock item is the finished good; the styles are the versions of it
 * that were sampled, and each carries its own route.
 */
async function listStylesForProduct(ctx, { stockItemId } = {}) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  if (!isId(stockItemId)) throw fail(CODES.VALIDATION, "Name the product whose styles to list.");

  /* ── THE PRODUCT IS NOT THE BOUNDARY, AND CANNOT BE ───────────────────
     `StockItem` carries no `companyId` — it is a global master today, like
     `Operation`. So this deliberately does NOT filter on company: a query
     naming a field the model does not have matches nothing, and a screen that
     silently returned an empty list would read as "this product has no
     styles" when it means "the query was wrong".

     The boundary is the STYLE, proved one at a time below. A style belonging
     to another company is not listed, so nothing about another company's work
     is published even though the product master is shared. Recorded in the
     Lane B input map as a missing tenancy contract. */
  const product = await StockItem()
    .findById(stockItemId)
    /* `reference` is the product's own code — `sku` on this model belongs to a
       VARIANT, not to the item, and publishing it as the product's would be a
       different record's identity under this one's name. */
    .select("_id name reference")
    .lean()
    .catch(() => null);
  if (!product) throw fail(CODES.NOT_FOUND, "That product was not found.");

  /* Both link fields, because a style reaches its finished good by either —
     `production.stockItemId` once it is in production, `sourceStockItemId`
     when it was raised from an existing product. */
  const candidates = await SampleStyle()
    .find({ $or: [{ "production.stockItemId": stockItemId }, { sourceStockItemId: stockItemId }] })
    .select([
      "_id sampleStyleId styleCode productName variantLabel",
      "journeyId enquiryId",
      "techSheet.technical.status techSheet.technical.operations",
    ].join(" "))
    .lean()
    .catch(() => []);

  const styles = [];
  for (const s of candidates) {
    /* Proved one at a time. A style whose company cannot be proved is not
       listed as unavailable — it is not listed. */
    if (!(await ownershipProofFor(s, ctx.companyId))) continue;
    styles.push(styleView(s));
  }

  return {
    product: { id: str(product._id), name: str(product.name), reference: str(product.reference) },
    styles,
  };
}

/** One style's route, as Production reads it. */
async function readRoute(ctx, { styleId } = {}) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  const style = await loadOwnedStyle(ctx, styleId);
  const ops = style.techSheet?.technical?.operations || [];
  const gate = editability(style);
  return {
    style: styleView(style),
    operations: ops.map(routeRow),
    outsideProcesses: outsideProcessRows(style),
    editable: gate.editable,
    readOnlyReason: gate.reason,
  };
}

/**
 * Validate a submitted outside-process row. The Service Master owns identity;
 * Production owns the requirement. A quote, supplier, rate or tooling purpose
 * cannot cross this boundary.
 */
function assertOutsideProcessShape(row, index) {
  const where = `outside process ${index + 1}`;
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw fail(CODES.VALIDATION, `${where} is not a requirement row.`);
  }
  for (const key of Object.keys(row)) {
    const refused = REFUSED_FIELDS[key];
    if (refused) {
      throw fail(CODES.FIELD_NOT_ACCEPTED,
        `An outside process records what Production needs. It cannot carry ${refused} — sent on ${where}.`,
        { field: key, index });
    }
    if (!OUTSIDE_PROCESS_FIELDS.includes(key)) {
      throw fail(CODES.FIELD_NOT_ACCEPTED, `"${key}" is not part of an outside-process row (${where}).`,
        { field: key, index });
    }
  }
  if (!isId(row.serviceId)) {
    throw fail(CODES.VALIDATION, `${where} does not name a registered service.`, { index });
  }
  if (row.included !== false) {
    const quantity = Number(row.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw fail(CODES.VALIDATION, `${where} needs a quantity. A blank quantity is not zero.`, { index, field: "quantity" });
    }
    if (!str(row.billingUnit)) {
      throw fail(CODES.VALIDATION, `${where} needs the unit the service is billed in.`, { index, field: "billingUnit" });
    }
  } else if (!str(row.excludedReason)) {
    throw fail(CODES.VALIDATION, `${where} is excluded but does not say why.`, { index, field: "excludedReason" });
  }
  if (row.basis !== undefined && !SERVICE_BASES.includes(str(row.basis))) {
    throw fail(CODES.VALIDATION, `${where} has an unsupported basis.`, { index, field: "basis" });
  }
}

/** Read just the Production-owned outside-process part of a style. */
async function readOutsideProcesses(ctx, { styleId } = {}) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  const style = await loadOwnedStyle(ctx, styleId);
  const gate = editability(style);
  return {
    style: styleView(style),
    outsideProcesses: outsideProcessRows(style),
    /* ── DOES ANYTHING GO OUTSIDE AT ALL? ────────────────────────────────
       An empty list is not an answer to that, and Central Costing used to be
       unable to tell the two apart — so somebody costing the garment declared
       outside services "not applicable" from a screen that could not know.
       Production knows. */
    decision: styleApplicability.decisionView(style.sample?.outsideProcessDecision),
    editable: gate.editable,
    readOnlyReason: gate.reason,
  };
}

/**
 * RECORD WHETHER THIS STYLE HAS ANY OUTSIDE PROCESSES AT ALL.
 *
 * ── WHY IT IS ITS OWN WRITE ─────────────────────────────────────────────────
 * Saving an empty row list cannot mean "nothing goes outside": it is also what
 * clearing the section to start again looks like, and what every style in the
 * deployment looks like before anybody opens it. The answer is a statement, so
 * it is stored as one.
 *
 * ── AND IT IS NOT GATED ON THE ROUTE BEING EDITABLE ─────────────────────────
 * `editability` locks the route while the technical record is with Sales or
 * approved, because the route is what a costing was calculated from. This is a
 * commercial statement about the style rather than a figure in that record,
 * and a style whose record is approved is exactly the one whose costing is
 * waiting on this answer. Locking it would leave the costing unanswerable
 * until Sales returned a record nobody needs to change.
 */
async function saveOutsideProcessDecision(ctx, { styleId, required, reason, actor = null } = {}) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  const parsed = styleApplicability.parseDecision({ required, reason }, { actor });
  if (!parsed.ok) throw fail(CODES.VALIDATION, parsed.message, { field: parsed.field, reason: parsed.code });

  const style = await loadOwnedStyle(ctx, styleId);
  /* ── SAYING "NONE" WHILE ROWS EXIST IS REFUSED ─────────────────────────
     The rows and the statement would then contradict each other, and the
     costing would have to choose which to believe. Remove the rows, or say
     the style does have outside processes. */
  const rows = outsideProcessRows(style).filter((r) => r.included);
  if (parsed.value.required === false && rows.length) {
    throw fail(CODES.VALIDATION,
      `This style has ${rows.length} outside process${rows.length === 1 ? "" : "es"} recorded. `
      + "Remove them first, or leave them and record that outside work is required.",
      { field: "required", reason: "OUTSIDE_PROCESSES_RECORDED", count: rows.length });
  }

  style.sample = style.sample || {};
  style.sample.outsideProcessDecision = parsed.value;
  style.markModified("sample.outsideProcessDecision");
  if (actor) style.updatedBy = actor;
  await style.save();
  return readOutsideProcesses(ctx, { styleId });
}

/** Replace only the Production-owned OUTSIDE_PROCESS rows. */
async function saveOutsideProcesses(ctx, { styleId, outsideProcesses, actor = null } = {}) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  if (!Array.isArray(outsideProcesses)) {
    throw fail(CODES.VALIDATION, "Send the outside processes as one list.");
  }
  const style = await loadOwnedStyle(ctx, styleId);
  const gate = editability(style);
  if (!gate.editable) throw fail(CODES.ROUTE_NOT_EDITABLE, gate.reason);
  outsideProcesses.forEach(assertOutsideProcessShape);

  const suppliedIds = outsideProcesses.map((row) => str(row.rowId)).filter(Boolean);
  if (new Set(suppliedIds).size !== suppliedIds.length) {
    throw fail(CODES.VALIDATION, "Each outside-process row must appear once.");
  }
  const wanted = [...new Set(outsideProcesses.map((row) => str(row.serviceId)))];
  const services = wanted.length
    ? await Service().find({ _id: { $in: wanted }, companyId: ctx.companyId, status: "ACTIVE" })
      .select("name serviceCode billingUnit").lean().catch(() => [])
    : [];
  const serviceById = new Map(services.map((service) => [str(service._id), service]));
  for (const [index, row] of outsideProcesses.entries()) {
    if (!serviceById.has(str(row.serviceId))) {
      throw fail(CODES.SERVICE_NOT_REGISTERED,
        `Outside process ${index + 1} is not an active service in this company's register.`,
        { index, serviceId: str(row.serviceId) });
    }
  }

  const prior = style.sample?.serviceRequirements || [];
  const developmentRows = prior.filter((row) => (str(row.purpose) || "OUTSIDE_PROCESS") !== "OUTSIDE_PROCESS");
  const persisted = outsideProcesses.map((row) => {
    const service = serviceById.get(str(row.serviceId));
    const included = row.included !== false;
    return {
      rowId: str(row.rowId) || crypto.randomBytes(8).toString("hex"),
      serviceId: service._id,
      serviceCode: str(service.serviceCode),
      serviceName: str(service.name),
      purpose: "OUTSIDE_PROCESS",
      specification: str(row.specification).slice(0, 2000),
      ...(included ? {
        quantity: Number(row.quantity),
        billingUnit: str(row.billingUnit).slice(0, 120),
      } : {}),
      basis: SERVICE_BASES.includes(str(row.basis)) ? str(row.basis) : "PER_GARMENT",
      included,
      excludedReason: included ? "" : str(row.excludedReason).slice(0, 500),
      notes: str(row.notes).slice(0, 500),
      owner: "PRODUCTION",
    };
  });

  style.sample = style.sample || {};
  /* Development/tooling belongs elsewhere. It survives byte-for-byte while
     this save replaces only Production's portion of the shared array. */
  style.sample.serviceRequirements = [...developmentRows, ...persisted];
  style.markModified("sample.serviceRequirements");
  if (actor) style.updatedBy = actor;
  await style.save();
  return readOutsideProcesses(ctx, { styleId });
}

/**
 * Validate one submitted row, and refuse rather than repair.
 *
 * The existing R&D writer silently DROPPED a row whose operation the register
 * did not hold. That is the wrong answer for a route: a person who chose an
 * operation and finds it missing afterwards has no way to tell whether they
 * mis-clicked or the register changed under them.
 */
function assertRowShape(row, index) {
  const where = `operation ${index + 1}`;
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw fail(CODES.VALIDATION, `${where} is not a route row.`);
  }
  for (const key of Object.keys(row)) {
    const refused = REFUSED_FIELDS[key];
    if (refused) {
      throw fail(CODES.FIELD_NOT_ACCEPTED,
        `A route records time and sequence. It cannot carry ${refused} — sent on ${where}.`,
        { field: key, index });
    }
    if (!ROW_FIELDS.includes(key)) {
      throw fail(CODES.FIELD_NOT_ACCEPTED, `"${key}" is not part of a route row (${where}).`,
        { field: key, index });
    }
  }
  if (!isId(row.operationId)) {
    throw fail(CODES.VALIDATION, `${where} does not name a registered operation.`, { index });
  }
  for (const field of ["minutes", "seconds"]) {
    if (row[field] === undefined || row[field] === null || row[field] === "") continue;
    const n = Number(row[field]);
    if (!Number.isFinite(n) || n < 0) {
      throw fail(CODES.VALIDATION, `${where} has a ${field} that is not a time.`, { index, field });
    }
  }
}

/**
 * WRITE THE ROUTE, AND ONLY THE ROUTE.
 *
 * @param {object[]} operations  the whole route, in order. A route is replaced
 *   rather than patched row by row, because reordering and removing are the
 *   two things this screen is for and both are expressed as "here is the
 *   list now".
 */
async function saveRoute(ctx, { styleId, operations, actor = null } = {}) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  if (!Array.isArray(operations)) {
    throw fail(CODES.VALIDATION, "Send the whole route, in order.");
  }

  const style = await loadOwnedStyle(ctx, styleId);
  const gate = editability(style);
  if (!gate.editable) throw fail(CODES.ROUTE_NOT_EDITABLE, gate.reason);

  operations.forEach(assertRowShape);

  /* ── IDENTITY COMES FROM THE REGISTER, NEVER FROM THE BODY ────────────
     The code, the name and the machine are the master's facts. Re-read on
     every save so a renamed operation reads correctly afterwards, and so a
     body claiming a different name for a real id changes nothing.

     ── AND THE MASTER HAS NO COMPANY ───────────────────────────────────
     `Operation` carries no `companyId` — it is a global register today. So
     "belongs to this company" cannot be checked here and is NOT pretended to
     be: what is enforced is that the operation is REGISTERED, and an
     unregistered id is refused by name. Filtering on a field the model does
     not have would match nothing and silently accept nothing, which is worse
     than saying so. Recorded in the Lane B input map as a missing contract. */
  const wanted = [...new Set(operations.map((o) => str(o.operationId)))];
  const masters = wanted.length
    ? await Operation().find({ _id: { $in: wanted } })
      .select("name operationCode machineType").lean().catch(() => [])
    : [];
  const masterById = new Map(masters.map((m) => [str(m._id), m]));

  for (const [index, row] of operations.entries()) {
    if (!masterById.has(str(row.operationId))) {
      throw fail(CODES.OPERATION_NOT_REGISTERED,
        `Operation ${index + 1} is not in the operation register. Choose it from the register, `
        + "or ask whoever maintains it to add it.",
        { index, operationId: str(row.operationId) });
    }
  }

  style.techSheet = style.techSheet || {};
  style.techSheet.technical = style.techSheet.technical || {};
  const t = style.techSheet.technical;

  /* ── NOTHING IS MIGRATED, AND NOTHING IS BACKFILLED ───────────────────
     The route is replaced by what was sent, in the order it was sent. Rows
     the caller kept are re-stated from the register, so a renamed operation
     reads correctly afterwards; rows they dropped are gone because they
     dropped them.

     There is no rescue pass over pre-existing rows and no attempt to
     re-identify one that names no registered operation. `operationId` is
     schema-required here, so such a row cannot be written through this
     model at all — and one already in the database is READ and published as
     it stands (see `routeRow`). Guessing an id for it would be a backfill
     nobody asked for, against a record somebody may have to explain. */
  t.operations = operations.map((row) => {
    const m = masterById.get(str(row.operationId));
    return {
      operationId: m._id,
      operationCode: str(m.operationCode),
      name: str(m.name),
      machineType: str(m.machineType),
      minutes: Math.max(0, Number(row.minutes) || 0),
      seconds: Math.max(0, Number(row.seconds) || 0),
      notes: str(row.notes).slice(0, 1000),
    };
  });

  /* ── NOTHING ELSE MOVES ───────────────────────────────────────────────
     Not the status, not the revision, not the materials. Production
     recording a route must not send R&D's record anywhere, and marking the
     path modified explicitly keeps this save to the one array even if the
     document was loaded with others populated. */
  style.markModified("techSheet.technical.operations");
  if (actor) style.updatedBy = actor;
  await style.save();

  return readRoute(ctx, { styleId });
}

module.exports = {
  CODES, ROW_FIELDS, OUTSIDE_PROCESS_FIELDS, REFUSED_FIELDS,
  styleView, routeRow, outsideProcessRow, outsideProcessRows, editability, assertRowShape, assertOutsideProcessShape,
  listStylesForProduct, readRoute, saveRoute, readOutsideProcesses, saveOutsideProcesses,
  saveOutsideProcessDecision,
};
