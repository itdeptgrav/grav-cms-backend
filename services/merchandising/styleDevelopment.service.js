// services/merchandising/styleDevelopment.service.js
//
// MERCHANDISING — WHAT ONE-TIME DEVELOPMENT OR TOOLING WORK A STYLE NEEDS.
//
// ── WHOSE FACT THIS IS ──────────────────────────────────────────────────────
// Pattern development, marker development, screen or mould making, a template,
// a one-time machine setup. Merchandising states that the style NEEDS it. That
// is a product decision, and it was being recorded on R&D's technical record
// because that is where the field happened to live.
//
// The RECORD stays where it is: `sample.serviceRequirements[]` rows whose
// `purpose` is `DEVELOPMENT_TOOLING`, the same array the costing already
// reads. No second collection, no second screen, no migration.
//
// ── THE THREE DESKS, AND WHY THIS ONE HAS NO MONEY ──────────────────────────
//   Merchandising  what work is needed, and how much of it
//   Store          what an outside supplier quoted for it, dated and referenced
//   Board/Finance  what the company charges for work it does itself
//
// So there is no rate, no supplier, no quotation, no amount, no margin, no tax
// and no policy value here — not accepted, not stored by this door, not
// returned. An internal charge is named by its KEY alone; the amount is
// resolved at costing time from the table Finance publishes, which is why a
// figure typed here would be a second, undated answer to a question the policy
// already answers properly.
//
// ── AND NO JOURNEY LEAVES THIS FILE ─────────────────────────────────────────
// Merchandising works from a Style. Company ownership is PROVED through the
// linked journey or enquiry, because that is where a SampleStyle's company
// actually lives, but no journey id, enquiry reference or customer name is
// ever published. Every response shape below is built field by field for
// exactly that reason.
//
// ── PACKAGING IS LANE A'S ───────────────────────────────────────────────────
// `sample.packagingRequirements` and `materials.packagingSelections` are not
// read, not written and not named by anything here.
"use strict";

const mongoose = require("mongoose");

/* Tenancy, not costing. Merchandising publishes identities for Costing to
   consume; it does not import Costing to ask whether a style is its own. */
const { ownershipProofFor } = require("../integration/styleOwnershipProof.service");
/* Costing publishes the charge catalogue; Merchandising consumes it through
   the integration seam rather than importing a costing policy. See
   services/integration/developmentChargeCatalog.service.js. */
const developmentChargeCatalog = require("../integration/developmentChargeCatalog.service");
const { fail } = require("../storePurchase/errors");
/* The three-field applicability answer, shared with Production's. */
const styleApplicability = require("../styleApplicability");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

const model = (name, path) => (mongoose.models[name] || require(path));
const SampleStyle = () => model("SampleStyle", "../../models/CMS_Models/Sales/SampleStyle");
const Service = () => model("Service", "../../models/CMS_Models/Inventory/Services/Service");

/** The one purpose this door speaks for. Everything else in the array is not its business. */
const PURPOSE = "DEVELOPMENT_TOOLING";

/** Bought outside, or done in-house. Never both: two sources for one requirement is two answers. */
const SOURCES = Object.freeze(["SUPPLIER_QUOTATION", "COMPANY_POLICY"]);

/* ── THE ONLY FIELDS A DEVELOPMENT ROW MAY CARRY IN ─────────────────────────
 *
 * An allowlist, not a blocklist. A blocklist protects against the fields
 * somebody thought of; this refuses everything nobody declared, so the next
 * field added to the model does not become writable here by accident.
 *
 * `basis` is absent because a one-time charge is `FIXED_PER_RUN` by
 * definition — stored as per-garment it would be multiplied by the run, which
 * is a hundredfold error on a 500-piece order. It is forced, not read.
 *
 * `billingUnit` is absent because it is not Merchandising's to state: on an
 * internal charge it is the configured unit of the charge itself, and on an
 * external one it is what the supplier bills, which Store records.
 */
const ROW_FIELDS = Object.freeze([
  "rowId", "developmentSource", "serviceId", "developmentChargeKey",
  "specification", "quantity", "included", "excludedReason", "notes",
]);

/* Fields that name money, another desk's record, or the Journey. Named
   explicitly so a refusal says WHICH desk owns the field rather than "unknown
   field" — somebody who put a rate in the body needs to be told rates are not
   Merchandising's, not that they made a typo. */
const REFUSED_FIELDS = Object.freeze({
  /* Store's, on a dated quotation. */
  supplierId: "a supplier", supplierName: "a supplier",
  quotation: "a quotation", quotationReference: "a quotation", offerId: "a quotation",
  price: "a price", unitPrice: "a price", rate: "a rate", rateMinor: "a rate",
  amount: "an amount", amountMinor: "an amount", cost: "a cost",
  /* Board and Finance's, in the company costing policy. */
  margin: "a margin", marginPercent: "a margin", minimumMarginPercent: "a profit floor",
  overheadRatePercent: "an overhead rate", financingRatePercent: "a financing rate",
  tax: "a tax treatment", gstRatePercent: "a tax rate", inputGstTreatment: "a tax policy",
  chargeAmountMinor: "a charge amount", unitAmountMinor: "a charge amount",
  /* Other desks' halves of this same array and record. */
  purpose: "a requirement purpose",
  serviceCode: "a service code", serviceName: "a service name",
  billingUnit: "a billing unit", basis: "a cost basis",
  owner: "a requirement owner", evidence: "sample evidence",
  materials: "materials", packaging: "packaging",
  packagingRequirements: "packaging", packagingSelections: "packaging",
  operations: "the production route",
  /* Merchandising has no Journey concept. */
  journeyId: "a journey", enquiryId: "an enquiry", journeyRef: "a journey",
  customerName: "a customer",
});

const CODES = Object.freeze({
  NOT_FOUND: "NOT_FOUND",
  FIELD_NOT_ACCEPTED: "FIELD_NOT_ACCEPTED",
  SERVICE_NOT_REGISTERED: "SERVICE_NOT_REGISTERED",
  CHARGE_NOT_CONFIGURED: "DEVELOPMENT_CHARGE_NOT_CONFIGURED",
  VALIDATION: "VALIDATION",
});

/**
 * WHAT A MERCHANDISING SCREEN MAY BE TOLD ABOUT A STYLE.
 *
 * Built field by field. A spread of the document would publish `journeyId`,
 * `enquiryId` and the customer's name the first time somebody stopped reading
 * this function, and the rule would become a comment rather than a fact.
 */
function styleView(style) {
  return {
    styleId: str(style._id),
    styleRef: str(style.sampleStyleId),
    styleCode: str(style.styleCode),
    productName: str(style.productName),
    variantLabel: str(style.variantLabel),
  };
}

/** One stored requirement, as Merchandising reads it. No money, ever. */
function developmentRow(r) {
  const internal = str(r.developmentSource) === "COMPANY_POLICY";
  const quantity = Number(r.quantity);
  return {
    rowId: str(r.rowId),
    developmentSource: SOURCES.includes(str(r.developmentSource)) ? str(r.developmentSource) : "",
    /* Bought outside: the Service Master's identity, as it stood when the row
       was written, so the row stays legible after a rename or a withdrawal. */
    serviceId: internal ? "" : str(r.serviceId),
    serviceCode: internal ? "" : str(r.serviceCode),
    serviceName: internal ? "" : str(r.serviceName),
    /* Done in-house: the KEY of the configured charge, never its amount. The
       label is resolved for display from the live table and is not stored. */
    developmentChargeKey: internal ? str(r.developmentChargeKey) : "",
    specification: str(r.specification),
    quantity: Number.isFinite(quantity) ? quantity : null,
    /* Shown so a count reads as "4 screens" rather than a bare 4. Derived
       from the charge or the register — never typed here. */
    unit: str(r.billingUnit),
    included: r.included !== false,
    excludedReason: str(r.excludedReason),
    notes: str(r.notes),
    /* A row stored before `rowId` existed. Readable, identified by what it
       names, and never migrated or rewritten. */
    legacy: !str(r.rowId),
  };
}

/**
 * WHAT STOPS THIS REQUIREMENT BEING PRICED.
 *
 * An EXCLUDED row is a decision, not a gap: "we considered a screen charge and
 * decided against it" is a fact worth keeping and is not a cost. It needs its
 * reason and nothing else.
 */
function developmentGaps(row, { charges = new Map() } = {}) {
  const gaps = [];
  const name = row.serviceName || row.developmentChargeKey || "this requirement";
  if (!row.included) {
    if (!row.excludedReason) {
      gaps.push({ field: "excludedReason", message: `Say why ${name} does not apply to this style.` });
    }
    return gaps;
  }
  if (!row.developmentSource) {
    gaps.push({ field: "developmentSource", message: `Say whether ${name} is bought outside or done in-house.` });
    return gaps;
  }
  if (row.developmentSource === "SUPPLIER_QUOTATION") {
    if (!row.serviceId) {
      gaps.push({ field: "serviceId", message: `${name} does not name a registered service.` });
    }
    return gaps;
  }
  /* Internal work. A per-unit charge is not a cost until somebody says how
     many — "₹2,000 a screen" prices nothing on its own. */
  if (!row.developmentChargeKey) {
    gaps.push({ field: "developmentChargeKey", message: "Choose which of the company's development charges this is." });
    return gaps;
  }
  const def = charges.get(row.developmentChargeKey);
  if (!def) {
    gaps.push({
      field: "developmentChargeKey",
      message: `${row.developmentChargeKey} is no longer a charge this company has configured.`,
    });
    return gaps;
  }
  if (def.calculation === "PER_REQUIREMENT_UNIT" && !(row.quantity > 0)) {
    gaps.push({
      field: "quantity",
      message: `${def.label || name} is charged per ${def.unit || "unit"}. Say how many.`,
    });
  }
  return gaps;
}

/**
 * The charge types this company has published, by key.
 *
 * ── FROM THE BOARD'S APPROVED CATALOGUE ─────────────────────────────────────
 * Not from the costing policy any more. What the company charges for
 * development work it does itself is a Board decision with an effective date,
 * and the catalogue read here is the one in force TODAY — which is right for a
 * screen somebody is choosing on now. The costing resolves it again against
 * its own date, so a requirement recorded today against a charge approved
 * today still prices correctly on a costing dated last month or not at all,
 * and says which.
 *
 * ── AND NOT ONE AMOUNT ──────────────────────────────────────────────────────
 * Only the key, the label, the description, the calculation method and the
 * unit cross this boundary. A Merchandising screen showing "Screen making —
 * ₹2,000 each" would be publishing the company's cost book to a desk that does
 * not own it, and to whoever they forward the page to. The projection that
 * enforces that lives with the policy, so there is one allowlist rather than a
 * second one here that could quietly widen.
 */
async function configuredCharges(companyId) {
  return developmentChargeCatalog.catalogueFor(companyId);
}

/** The style, proved to belong to this company. Foreign and missing are one answer. */
async function loadOwnedStyle(ctx, styleId) {
  if (!isId(styleId)) throw fail(CODES.NOT_FOUND, "Style not found.");
  const style = await SampleStyle().findById(styleId);
  if (!style) throw fail(CODES.NOT_FOUND, "Style not found.");
  if (!(await ownershipProofFor(style, ctx.companyId))) {
    throw fail(CODES.NOT_FOUND, "Style not found.");
  }
  return style;
}

/** Only the rows this door speaks for. Everything else in the array is untouched. */
const isDevelopment = (r) => str(r?.purpose) === PURPOSE;

/**
 * One style's development requirements, and what is still missing from them.
 */
async function readDevelopment(ctx, { styleId } = {}) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  const style = await loadOwnedStyle(ctx, styleId);
  const charges = await configuredCharges(ctx.companyId);

  const rows = (style.sample?.serviceRequirements || [])
    .filter(isDevelopment)
    .map(developmentRow)
    .map((row) => ({
      ...row,
      /* The label of the charge this row names, resolved live so a rename
         shows through. Absent when the charge has been retired, which the
         gaps below then name. */
      chargeLabel: charges.get(row.developmentChargeKey)?.label || "",
      gaps: developmentGaps(row, { charges }),
    }));

  /* ── AND WHAT MAY BE CHOSEN FROM ──────────────────────────────────────
     The company's ACTIVE services, by identity alone. Served from here
     rather than from Store's own register endpoint so a merchandiser needs
     no Store capability to name a process — and so the shape is this
     boundary's allowlist rather than Store's, which carries billing units,
     SAC codes and lifecycle detail that are not Merchandising's to read. */
  const services = await Service()
    .find({ companyId: ctx.companyId, status: "ACTIVE" })
    .select("name serviceCode").sort({ name: 1 }).limit(500).lean().catch(() => []);

  return {
    style: styleView(style),
    development: rows,
    /* ── DOES THIS STYLE NEED ANY OF IT? ─────────────────────────────────
       An empty list is not "none needed" — it is also every style nobody has
       opened yet. Costing used to be unable to tell the two apart, so whoever
       was costing the garment declared development "not applicable" from a
       screen with none of the facts. Merchandising has them. */
    decision: styleApplicability.decisionView(style.sample?.developmentDecision),
    /* Key, label, calculation and unit — the four facts a form needs, and
       no amount. */
    charges: [...charges.values()],
    services: services.map((s) => ({
      id: str(s._id), name: str(s.name), serviceCode: str(s.serviceCode),
    })),
  };
}

/** Validate one submitted requirement, and refuse rather than repair. */
function assertRowShape(row, index) {
  const where = `requirement ${index + 1}`;
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw fail(CODES.VALIDATION, `${where} is not a development requirement.`);
  }
  for (const key of Object.keys(row)) {
    const refused = REFUSED_FIELDS[key];
    if (refused) {
      throw fail(CODES.FIELD_NOT_ACCEPTED,
        `Merchandising states what work is needed. It cannot carry ${refused} — sent on ${where}.`,
        { field: key, index });
    }
    if (!ROW_FIELDS.includes(key)) {
      throw fail(CODES.FIELD_NOT_ACCEPTED, `"${key}" is not part of a development requirement (${where}).`,
        { field: key, index });
    }
  }
  const source = str(row.developmentSource);
  if (!SOURCES.includes(source)) {
    throw fail(CODES.VALIDATION,
      `${where} must say whether the work is bought outside or done in-house.`, { index });
  }
  /* ── ONE SOURCE, NEVER TWO ────────────────────────────────────────────
     A row carrying both a service and a charge key has two answers to one
     question, and nothing downstream chooses between them. Refused here
     rather than resolved by precedence, which would silently pick one. */
  if (source === "SUPPLIER_QUOTATION") {
    if (!isId(row.serviceId)) {
      throw fail(CODES.VALIDATION, `${where} does not name a registered service.`, { index });
    }
    if (str(row.developmentChargeKey)) {
      throw fail(CODES.VALIDATION,
        `${where} names both an outside service and a company charge. It is one or the other.`, { index });
    }
  } else {
    if (!str(row.developmentChargeKey)) {
      throw fail(CODES.VALIDATION, `${where} does not name a configured company charge.`, { index });
    }
    if (str(row.serviceId)) {
      throw fail(CODES.VALIDATION,
        `${where} names both a company charge and an outside service. It is one or the other.`, { index });
    }
  }
  if (row.quantity !== undefined && row.quantity !== null && row.quantity !== "") {
    const n = Number(row.quantity);
    if (!Number.isFinite(n) || n < 0) {
      throw fail(CODES.VALIDATION, `${where} has a quantity that is not a number.`, { index });
    }
  }
  if (row.included === false && !str(row.excludedReason)) {
    throw fail(CODES.VALIDATION, `${where} is marked not applicable. Say why.`, { index });
  }
}

/**
 * WRITE THE DEVELOPMENT REQUIREMENTS, AND ONLY THOSE.
 *
 * The whole list, in order, because adding and removing are what the section
 * is for and both are "here is the list now".
 *
 * ── EVERY OTHER ROW SURVIVES UNREAD ─────────────────────────────────────────
 * Production's `OUTSIDE_PROCESS` rows share this array. They are carried
 * through as the STORED objects — not rebuilt, not re-validated, not even
 * read field by field — so nothing here can alter one by accident, and a row
 * whose shape this file does not understand passes through intact.
 */
async function saveDevelopment(ctx, { styleId, requirements, actor = null } = {}) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  if (!Array.isArray(requirements)) {
    throw fail(CODES.VALIDATION, "Send the whole list of development requirements.");
  }

  const style = await loadOwnedStyle(ctx, styleId);
  requirements.forEach(assertRowShape);

  /* ── IDENTITY FROM THE REGISTERS, AND BOTH ARE THIS COMPANY'S ──────────
     `Service` carries a `companyId` and a real lifecycle, so another
     company's service and a deactivated one are both genuinely refused. The
     charge table is read from this company's own policy for the same reason. */
  const wantedServices = [...new Set(
    requirements.filter((r) => str(r.developmentSource) === "SUPPLIER_QUOTATION")
      .map((r) => str(r.serviceId)),
  )];
  const [masters, charges] = await Promise.all([
    wantedServices.length
      ? Service().find({ companyId: ctx.companyId, _id: { $in: wantedServices } })
        .select("name serviceCode billingUnit status").lean().catch(() => [])
      : Promise.resolve([]),
    configuredCharges(ctx.companyId),
  ]);
  const masterById = new Map(masters.map((m) => [str(m._id), m]));

  for (const [index, row] of requirements.entries()) {
    if (str(row.developmentSource) === "SUPPLIER_QUOTATION") {
      const master = masterById.get(str(row.serviceId));
      if (!master) {
        throw fail(CODES.SERVICE_NOT_REGISTERED,
          `Requirement ${index + 1} is not in this company's Service Master.`,
          { index, serviceId: str(row.serviceId) });
      }
      if (String(master.status || "").toUpperCase() !== "ACTIVE") {
        throw fail(CODES.SERVICE_NOT_REGISTERED,
          `${master.name} is not active in the Service Master.`, { index });
      }
      continue;
    }
    const def = charges.get(str(row.developmentChargeKey));
    if (!def) {
      throw fail(CODES.CHARGE_NOT_CONFIGURED,
        `Requirement ${index + 1} names a development charge this company has not configured.`,
        { index, developmentChargeKey: str(row.developmentChargeKey) });
    }
    /* A per-unit charge with no count is not a cost. Refused at the door
       rather than stored as a requirement nothing can price. */
    if (def.calculation === "PER_REQUIREMENT_UNIT"
      && row.included !== false && !(Number(row.quantity) > 0)) {
      throw fail(CODES.VALIDATION,
        `${def.label} is charged per ${def.unit || "unit"}. Say how many.`, { index });
    }
  }

  style.sample = style.sample || {};
  const stored = style.sample.serviceRequirements || [];
  const notOurs = stored.filter((r) => !isDevelopment(r));

  /* Identity is preserved against what the STYLE holds, so an edit keeps its
     row and anything else becomes a new one. Two legitimate requirements
     naming the same charge — screens for the body and screens for the sleeve —
     therefore stay two rows rather than collapsing into one. */
  const known = new Set(stored.map((r) => str(r.rowId)).filter(Boolean));
  const used = new Set();
  const keepRowId = (sent) => {
    const claimed = str(sent).slice(0, 40);
    if (claimed && known.has(claimed) && !used.has(claimed)) { used.add(claimed); return claimed; }
    const minted = new mongoose.Types.ObjectId().toString();
    used.add(minted);
    return minted;
  };

  style.sample.serviceRequirements = [
    ...notOurs,
    ...requirements.map((row) => {
      const internal = str(row.developmentSource) === "COMPANY_POLICY";
      const master = internal ? null : masterById.get(str(row.serviceId));
      const def = internal ? charges.get(str(row.developmentChargeKey)) : null;
      const quantity = Number(row.quantity);
      const included = row.included !== false;
      const wantsCount = internal
        ? def?.calculation === "PER_REQUIREMENT_UNIT"
        : Number.isFinite(quantity) && quantity > 0;

      return {
        rowId: keepRowId(row.rowId),
        purpose: PURPOSE,
        developmentSource: internal ? "COMPANY_POLICY" : "SUPPLIER_QUOTATION",
        ...(internal
          ? { developmentChargeKey: str(row.developmentChargeKey).slice(0, 60) }
          : {
            serviceId: master._id,
            serviceCode: str(master.serviceCode).slice(0, 60),
            serviceName: str(master.name).slice(0, 200),
          }),
        ...(wantsCount && Number.isFinite(quantity) && quantity > 0 ? { quantity } : {}),
        /* The unit is the charge's or the register's — never typed here. */
        billingUnit: str(internal ? def?.unit : master.billingUnit).slice(0, 60),
        specification: str(row.specification).slice(0, 2000),
        /* One-time by definition, and forced rather than read: a setup charge
           stored as per-garment would be multiplied by the run. */
        basis: "FIXED_PER_RUN",
        included,
        excludedReason: included ? "" : str(row.excludedReason).slice(0, 500),
        notes: str(row.notes).slice(0, 500),
      };
    }),
  ];

  style.markModified("sample.serviceRequirements");
  if (actor) style.updatedBy = actor;
  await style.save();

  return readDevelopment(ctx, { styleId });
}

/**
 * RECORD WHETHER THIS STYLE NEEDS ANY DEVELOPMENT OR TOOLING WORK.
 *
 * The whole-style answer that an empty list could never be. Row-level
 * exclusions are a different and narrower fact and are untouched: "we
 * considered screens and dropped them" lives on the row, with its own reason,
 * and says nothing about whether the style needs development at all.
 */
async function saveDevelopmentDecision(ctx, { styleId, required, reason, actor = null } = {}) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  const parsed = styleApplicability.parseDecision({ required, reason }, { actor });
  if (!parsed.ok) throw fail(CODES.VALIDATION, parsed.message, { field: parsed.field, reason: parsed.code });

  const style = await loadOwnedStyle(ctx, styleId);
  /* ── AND "NONE" CANNOT STAND BESIDE ROWS ──────────────────────────────
     A style with a screen-making requirement on it and a statement that it
     needs no development is two answers, and the costing would have to pick
     one. Excluded rows do not count: they are already decided against. */
  const rows = (style.sample?.serviceRequirements || [])
    .filter(isDevelopment).filter((r) => r.included !== false);
  if (parsed.value.required === false && rows.length) {
    throw fail(CODES.VALIDATION,
      `This style has ${rows.length} development requirement${rows.length === 1 ? "" : "s"} recorded. `
      + "Remove them first, or leave them and record that development work is required.",
      { field: "required", reason: "DEVELOPMENT_REQUIREMENTS_RECORDED", count: rows.length });
  }

  style.sample = style.sample || {};
  style.sample.developmentDecision = parsed.value;
  style.markModified("sample.developmentDecision");
  if (actor) style.updatedBy = actor;
  await style.save();
  return readDevelopment(ctx, { styleId });
}

module.exports = {
  PURPOSE, SOURCES, ROW_FIELDS, REFUSED_FIELDS, CODES,
  styleView, developmentRow, developmentGaps, assertRowShape,
  configuredCharges, isDevelopment,
  readDevelopment, saveDevelopment, saveDevelopmentDecision,
};
