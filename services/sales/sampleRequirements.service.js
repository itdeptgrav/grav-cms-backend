"use strict";
/**
 * services/sales/sampleRequirements.service.js
 *
 * WHAT R&D RECORDS ABOUT PACKAGING AND OUTSIDE PROCESSES, VALIDATED AND
 * RESOLVED AGAINST THIS COMPANY'S OWN MASTERS.
 *
 * ── THE TWO FAILURES THIS FIXES ─────────────────────────────────────────────
 *
 * 1. A STARTED ROW WAS SILENTLY DROPPED. The first cut filtered incomplete
 *    rows out of the submission. Somebody who chose a carton and moved on
 *    before typing the quantity got a green tick and a sample submitted
 *    WITHOUT it, and the costing they saw a fortnight later was short a cost
 *    with nothing anywhere saying so. A row nobody touched is fine to omit; a
 *    row somebody started is a refusal that names it and names what is missing.
 *
 * 2. IDENTITIES WERE TAKEN FROM THE BROWSER. `rawItemName`, `rawItemSku`,
 *    `serviceCode`, `serviceName` and the units were all stored as sent. So a
 *    stale screen could snapshot a name that was never right, and a crafted
 *    request could snapshot ANY name at all against a real id — including one
 *    read out of another company's master. Every identity is re-read here,
 *    company-scoped, and every snapshot is taken from what came back.
 *
 * ── AND THE EVIDENCE CLAIM ──────────────────────────────────────────────────
 * The first cut stamped every row `SAMPLE_MEASURED`. That is a claim that this
 * quantity was demonstrated by the physical sample, and for a row somebody
 * typed in while planning it is simply false — it is the difference between a
 * figure a costing may treat as verified and one that must stay provisional.
 * The person states it, and nothing here guesses.
 */

const mongoose = require("mongoose");

const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Service = require("../../models/CMS_Models/Inventory/Services/Service");
/* For its charge KEYS only — the amounts stay in the costing app. */
/* One adapter for the charge table, shared with the costing — so what R&D is
   allowed to choose and what the engine can price are the same list. */
const developmentChargePolicy = require("../centralCosting/developmentChargePolicy.service");
/* ── ONE OWNERSHIP RULE, NOT A SECOND COPY ────────────────────────────────
   `technicalSource.ownershipProofFor` already proves a style belongs to a
   company, through its journey or its enquiry, and is exported for exactly
   this reason. An independent read here would be a second rule that could
   drift from the one costing uses — and it was also an unscoped
   `SalesJourney.findById`, which the tenancy guard rightly refused. */
const { ownershipProofFor } = require("../centralCosting/technicalSource.service");

/* ── THE THREE SHAPES A REQUIREMENT CAN HAVE ──────────────────────────────
   PER_GARMENT   one each, scales with the run.
   PER_CARTON    one per N garments, so it steps: 501 at 25 to a carton buys
                 twenty-one, not twenty. The conversion is NOT here — it is
                 `sample.shipment.garmentsPerCarton`, the style's single
                 statement of it, shared with freight.
   FIXED_PER_RUN bought once whatever the run, diluted across it.

   PER_CARTON is additive and is not a synonym for FIXED_PER_RUN. A service
   cannot be per-carton, so its own list stays the original two. */
const BASES = Object.freeze(["PER_GARMENT", "PER_CARTON", "FIXED_PER_RUN"]);
const SERVICE_BASES = Object.freeze(["PER_GARMENT", "FIXED_PER_RUN"]);
/* The same two words the technical source already speaks. `BOM_PLANNED` is
   what a planned material row is called; a planned packaging row is the same
   kind of claim and is named the same way rather than inventing a synonym. */
const EVIDENCE = Object.freeze(["SAMPLE_MEASURED", "BOM_PLANNED"]);
const OWNERS = Object.freeze(["RND", "PRODUCTION"]);
/* ── RECURRING WORK, OR ONE-TIME SETUP ──────────────────────────────────────
   The same Service Master answers both a wash and the screens to print with,
   and the two are the opposite kind of cost: one scales with the run and one
   is paid once whatever the run. Which it is has to be STATED, because a
   costing cannot tell from the service alone — and a screen charge mistaken
   for a wash is multiplied by every garment. */
const PURPOSES = Object.freeze(["OUTSIDE_PROCESS", "DEVELOPMENT_TOOLING"]);
/* And where the money for one-time work comes from: a supplier who quoted for
   it, or a charge the company published for work it does itself. */
const DEV_SOURCES = Object.freeze(["SUPPLIER_QUOTATION", "COMPANY_POLICY"]);

/** Tooling done in-house — the only shape that names a charge and no service. */
const isInternalDevelopment = (r = {}) =>
  r.purpose === "DEVELOPMENT_TOOLING" && r.developmentSource === "COMPANY_POLICY";

const str = (v, max = 2000) => String(v ?? "").trim().slice(0, max);
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const positive = (v) => Number.isFinite(Number(v)) && Number(v) > 0;

/**
 * This row's own identity, preserved or minted.
 *
 * ── WHY A ROW NEEDS ONE AT ALL ──────────────────────────────────────────────
 * Keyed by what they NAME, two legitimate requirements using the same service
 * or the same charge type are a single costing line: screens for the body and
 * screens for the sleeve collide, and one of them is either merged away or
 * counted twice. Neither is anything anybody asked for.
 *
 * ── AND WHY THE BROWSER CANNOT INVENT ONE ───────────────────────────────────
 * An id sent up is honoured only when the style already carries it — which is
 * what a genuine edit round-trips. Anything else is a new row and gets a new
 * identity, so a stale screen, a duplicated row or a crafted payload can
 * neither claim another row's history nor collapse two rows into one.
 */
const identityKeeper = (existing = []) => {
  const known = new Set((existing || []).map((r) => String(r?.rowId || "")).filter(Boolean));
  const used = new Set();
  return (sent) => {
    const claimed = str(sent, 40);
    if (claimed && known.has(claimed) && !used.has(claimed)) {
      used.add(claimed);
      return claimed;
    }
    const minted = new mongoose.Types.ObjectId().toString();
    used.add(minted);
    return minted;
  };
};

/** A 400 the route can send straight back, carrying the rows and the fields. */
function invalid(message, rows) {
  const err = new Error(message);
  err.status = 400;
  err.code = "SAMPLE_REQUIREMENT_INCOMPLETE";
  err.rows = rows;
  return err;
}

/**
 * Is this style the caller's company's, proved the way costing proves it?
 *
 * ── THE COMPANY IS THE REQUEST'S, NEVER THE RECORD'S ────────────────────────
 * An earlier cut DERIVED the company by reading the style's journey. That is
 * the circularity the tenant rules refuse: a record cannot nominate the scope
 * it is then checked against. The company comes from the already-authorised
 * request, and the style has to prove it belongs to it — which is what
 * `ownershipProofFor` does, once, for costing and for this.
 *
 * `null` for a style whose parent is another company's, or whose parent has no
 * company at all. Fail closed either way.
 */
async function companyForStyle(style, companyId) {
  if (!companyId) return null;
  const proof = await ownershipProofFor(style, companyId);
  return proof ? String(companyId) : null;
}

/**
 * Has anybody touched this row?
 *
 * ── DELIBERATELY GENEROUS ───────────────────────────────────────────────────
 * Any meaningful field counts, including a basis or an owner moved away from
 * its default and an exclusion decision. Being too eager costs somebody one
 * refusal they can fix in a second; being too narrow loses a cost silently,
 * which is the failure this exists to stop.
 *
 * The blank row a fresh form starts with touches none of them.
 */
const startedPackaging = (r = {}) => Boolean(
  isId(r.rawItemId) || str(r.rawItemName) || str(r.specification)
  || str(r.quantity) || str(r.unit) || isId(r.variantId)
  || str(r.notes) || r.included === false || str(r.excludedReason)
  || (r.basis && r.basis !== "PER_GARMENT")
  || str(r.evidence),
);

const startedService = (r = {}) => Boolean(
  isId(r.serviceId) || str(r.serviceName) || str(r.specification)
  || str(r.quantity) || str(r.billingUnit)
  || str(r.notes) || r.included === false || str(r.excludedReason)
  || (r.basis && r.basis !== "PER_GARMENT")
  || (r.owner && r.owner !== "RND")
  || str(r.evidence)
  /* Classifying a row as tooling, or naming where it is paid from, is as much
     a start as choosing the service — and a tooling row is the ONE shape that
     legitimately names no service at all, so without this it could be started,
     abandoned half-finished, and silently dropped. */
  || (r.purpose && r.purpose !== "OUTSIDE_PROCESS")
  || str(r.developmentSource) || str(r.developmentChargeKey),
);

/** Every field a started packaging row still owes, by name. */
function packagingGaps(r = {}) {
  const gaps = [];
  if (!isId(r.rawItemId)) gaps.push({ field: "rawItemId", message: "Choose the packaging item from the item master." });
  /* ── MISSING IS MISSING, NEVER ZERO ───────────────────────────────────
     A zero would cost the garment as though it shipped unpacked. */
  if (!positive(r.quantity)) gaps.push({ field: "quantity", message: "Say how much is used. A blank quantity is not zero." });
  if (!str(r.unit)) gaps.push({ field: "unit", message: "Say what unit that quantity is in." });
  if (!EVIDENCE.includes(r.evidence)) {
    gaps.push({
      field: "evidence",
      /* Stamping this would be claiming the sample demonstrated a figure
         somebody typed while planning. */
      message: "Say whether this was measured on the sample or planned for production. It changes whether a costing may treat it as verified.",
    });
  }
  if (r.included === false && !str(r.excludedReason)) {
    gaps.push({ field: "excludedReason", message: "Say why this was considered and left out. A row excluded without a reason is indistinguishable from a mistake." });
  }
  /* ── A CARTON BASIS NEEDS THE STYLE'S CARTON COUNT ────────────────────
     Reported HERE, where R&D is filling the row, rather than only at costing
     time — the conversion is a shipment fact on the same screen, and finding
     out weeks later that a carton line could never be priced is the failure
     this closes. Not a field on the row: the count is stated once for the
     style, in `sample.shipment`, where freight reads it too. */
  if (r.basis === "PER_CARTON" && !positive(r.shipmentGarmentsPerCarton)) {
    gaps.push({
      field: "shipment.garmentsPerCarton",
      message: "This is bought by the carton, so the shipment has to say how many garments a carton holds. Record it in Shipment — freight reads the same number.",
    });
  }
  return gaps;
}

/**
 * And a started service row — which is now two shapes, not one.
 *
 * ── WHAT EACH SHAPE OWES ────────────────────────────────────────────────────
 * An outside process and externally bought tooling both name a service, a
 * quantity and the unit the supplier bills in. Tooling the company performs
 * itself names none of those: there is no supplier, no Service master row to
 * point at, and no unit — a flat charge for the run is not billed per
 * anything. What it names is the configured CHARGE, and nothing else.
 */
function serviceGaps(r = {}) {
  const gaps = [];
  if (r.purpose && !PURPOSES.includes(r.purpose)) {
    gaps.push({ field: "purpose", message: "Say whether this is an outside process or one-time development, pattern or tooling work." });
    return gaps;
  }
  if (r.purpose === "DEVELOPMENT_TOOLING" && !DEV_SOURCES.includes(r.developmentSource)) {
    gaps.push({ field: "developmentSource", message: "Say whether this setup work is bought from a supplier or done by the company itself." });
    return gaps;
  }

  if (isInternalDevelopment(r)) {
    if (!str(r.developmentChargeKey)) {
      gaps.push({ field: "developmentChargeKey", message: "Choose which of the company's development charges this is." });
    }
    /* ── ONE SOURCE, NOT TWO ──────────────────────────────────────────
       A row naming both a company charge and a supplier's service has two
       prices and nothing choosing between them. Refused where it is
       readable, rather than quietly costed from one of them. */
    if (isId(r.serviceId) || str(r.serviceName)) {
      gaps.push({ field: "serviceId", message: "This is costed from the company's own charge, so it cannot also name a supplier's service. Clear one of the two." });
    }
  } else {
    if (!isId(r.serviceId)) gaps.push({ field: "serviceId", message: "Choose the service from the Service Master." });
    if (!positive(r.quantity)) gaps.push({ field: "quantity", message: "Say how much is needed. A blank quantity is not zero." });
    if (!str(r.billingUnit)) gaps.push({ field: "billingUnit", message: "Say how the supplier bills it — per piece, per visit, per lot." });
    if (r.purpose === "DEVELOPMENT_TOOLING" && str(r.developmentChargeKey)) {
      gaps.push({ field: "developmentChargeKey", message: "This is bought from a supplier, so it is not costed from a company charge. Clear one of the two." });
    }
  }

  if (!EVIDENCE.includes(r.evidence)) {
    gaps.push({ field: "evidence", message: "Say whether this was run on the sample or planned for production. It changes whether a costing may treat it as verified." });
  }
  if (r.included === false && !str(r.excludedReason)) {
    gaps.push({ field: "excludedReason", message: "Say why this was considered and left out." });
  }
  return gaps;
}

/**
 * Validate, resolve and snapshot both lists.
 *
 * @param {object} style      the SampleStyle being submitted against
 * @param {object} body       the request body
 * @param {object} scope      `{ companyId }` from the authorised request
 * @returns {{packagingRequirements: object[], serviceRequirements: object[]}}
 * @throws  a 400 naming every started row that is not finished
 */
async function resolveRequirements(style, body = {}, scope = {}) {
  const packagingInput = Array.isArray(body.packagingRequirements) ? body.packagingRequirements : [];
  const serviceInput = Array.isArray(body.serviceRequirements) ? body.serviceRequirements : [];

  /* Untouched rows are dropped without comment; started ones are kept and
     answered for. */
  const packaging = packagingInput
    .map((r, index) => ({ r, index }))
    .filter(({ r }) => startedPackaging(r));
  const services = serviceInput
    .map((r, index) => ({ r, index }))
    .filter(({ r }) => startedService(r));

  if (!packaging.length && !services.length) {
    return { packagingRequirements: [], serviceRequirements: [] };
  }

  /* ── SHAPE FIRST, IDENTITY SECOND ──────────────────────────────────────
     Every gap in one answer. Being told about the quantity, fixing it, and
     then being told about the unit is how a submission takes five attempts. */
  const problems = [];
  /* The style's one carton count, handed to every packaging row so a carton
     basis can be checked where it is entered. Read from the submission when
     present and from the stored shipment otherwise, because R&D fills both on
     the same screen and either order must work. */
  const shipmentGarmentsPerCarton = Number(
    body?.shipment?.garmentsPerCarton ?? style?.sample?.shipment?.garmentsPerCarton,
  );
  for (const { r, index } of packaging) {
    const gaps = packagingGaps({ ...r, shipmentGarmentsPerCarton });
    if (gaps.length) {
      problems.push({
        kind: "packaging", index,
        label: str(r.rawItemName, 200) || str(r.specification, 200) || `Packaging row ${index + 1}`,
        missing: gaps,
      });
    }
  }
  for (const { r, index } of services) {
    const gaps = serviceGaps(r);
    if (gaps.length) {
      problems.push({
        kind: "service", index,
        label: str(r.serviceName, 200) || str(r.specification, 200) || `Outside process row ${index + 1}`,
        missing: gaps,
      });
    }
  }
  if (problems.length) {
    throw invalid(
      `${problems.length} started row${problems.length === 1 ? " is" : "s are"} not finished. Complete or clear ${problems.length === 1 ? "it" : "them"} before submitting.`,
      problems,
    );
  }

  /* ── AND ONLY THEN, THE MASTERS ────────────────────────────────────────
     Company-scoped, from the authorised REQUEST's company — with the style
     proved to belong to it first. A style that does not resolves nothing. */
  const companyId = await companyForStyle(style, scope.companyId);
  if (!companyId) {
    throw invalid(
      "This style has no proven company, so packaging and outside processes cannot be recorded against it.",
      [],
    );
  }

  /* Not disclosing: "belongs to somebody else" and "does not exist" are one
     answer, because saying which would confirm a record the caller cannot
     see. */
  const notOurs = (kind, index, label, what) => ({
    kind, index, label,
    missing: [{ field: kind === "packaging" ? "rawItemId" : "serviceId", message: `That ${what} is not in this company's register.` }],
  });

  const itemIds = [...new Set(packaging.map(({ r }) => String(r.rawItemId)))];
  const items = new Map();
  if (itemIds.length) {
    const docs = await RawItem.find({ companyId, _id: { $in: itemIds } })
      /* `combination` is what `RawItem.variants[]` actually calls it. */
      .select("name sku unit customUnit variants._id variants.combination variants.sku").lean();
    for (const d of docs) items.set(String(d._id), d);
  }

  /* ── AND THE COMPANY'S OWN CHARGE TABLE, FOR THE ROWS THAT NAME ONE ────
     Read once, company-scoped, for its KEYS only. A key R&D typed or a stale
     screen kept is refused here rather than becoming a costing that blocks a
     fortnight later with nobody able to say who chose it. The AMOUNT is not
     read and is not snapshotted: the costing takes it from the policy at its
     own date, which is what makes an effective-dated table mean anything. */
  const internalRows = services.filter(({ r }) => isInternalDevelopment(r));
  const charges = new Map();
  if (internalRows.length) {
    /* ── DEFINITIONS, NOT TODAY'S RATES ────────────────────────────────
       A requirement is recorded against a charge TYPE; which rate applies is
       a question with a date on it, and the date belongs to the costing, not
       to the moment somebody happened to submit a sample. Filtering by a rate
       PERIOD here would refuse a style being developed for a season whose
       rate starts next month.

       The CATALOGUE is the Board's approved one, resolved at today: a version
       taking effect next month is not yet what the company publishes, and
       accepting a key out of it would let a requirement name a charge that
       does not exist. The two dating layers do different work. */
    const resolved = await developmentChargePolicy
      .resolveFor({ companyId }).catch(() => null);
    for (const [key, def] of developmentChargePolicy.catalogueForMerchandising(resolved)) {
      charges.set(key, def);
    }
  }

  const serviceIds = [...new Set(
    services.filter(({ r }) => !isInternalDevelopment(r)).map(({ r }) => String(r.serviceId)),
  )];
  const serviceDocs = new Map();
  if (serviceIds.length) {
    const docs = await Service.find({ companyId, _id: { $in: serviceIds } })
      .select("serviceCode name billingUnit sacCode status").lean();
    for (const d of docs) serviceDocs.set(String(d._id), d);
  }

  /* Identity is preserved against what the STYLE holds, so an edit keeps its
     row and anything else becomes a new one. */
  const keepPackaging = identityKeeper(style?.sample?.packagingRequirements);
  const keepService = identityKeeper(style?.sample?.serviceRequirements);

  const refusals = [];
  const packagingRequirements = [];
  for (const { r, index } of packaging) {
    const label = str(r.rawItemName, 200) || `Packaging row ${index + 1}`;
    const master = items.get(String(r.rawItemId));
    if (!master) { refusals.push(notOurs("packaging", index, label, "packaging item")); continue; }

    /* A variant is only a variant OF THIS ITEM. One borrowed from another
       item would snapshot a colour this row never had. */
    let variant = null;
    if (isId(r.variantId)) {
      variant = (master.variants || []).find((v) => String(v._id) === String(r.variantId)) || null;
      if (!variant) {
        refusals.push({
          kind: "packaging", index, label,
          missing: [{ field: "variantId", message: "That variant does not belong to this item." }],
        });
        continue;
      }
    }

    packagingRequirements.push({
      rowId: keepPackaging(r.rowId),
      rawItemId: master._id,
      /* ── SNAPSHOTS FROM THE MASTER, NOT FROM THE REQUEST ──────────────
         Whatever the browser sent for these is discarded. A snapshot is
         evidence, and evidence a caller can dictate is not evidence. */
      rawItemName: str(master.name, 200),
      rawItemSku: str(master.sku, 60),
      ...(variant
        ? {
          variantId: variant._id,
          variantLabel: str((variant.combination || []).join(" / ") || variant.sku, 200),
        }
        : {}),
      /* R&D's own words about this style — genuinely theirs, so genuinely
         taken from the request. */
      specification: str(r.specification),
      quantity: Number(r.quantity),
      /* The unit R&D measured in. Not the master's: a bag counted in pieces
         and an item registered in boxes is a real difference, and the costing
         resolves the quotation against what was recorded here. */
      unit: str(r.unit, 60),
      basis: BASES.includes(r.basis) ? r.basis : "PER_GARMENT",
      evidence: r.evidence,
      included: r.included !== false,
      excludedReason: r.included === false ? str(r.excludedReason, 500) : "",
      notes: str(r.notes, 500),
    });
  }

  const serviceRequirements = [];
  for (const { r, index } of services) {
    /* ── WORK THE COMPANY DOES ITSELF ────────────────────────────────────
       No supplier, no Service master row, no unit. The charge key is proved
       against what Finance actually has in force, and the row stores the KEY
       alone — never a label and never an amount, so nothing here can drift
       from the table the costing reads. */
    if (isInternalDevelopment(r)) {
      const key = str(r.developmentChargeKey, 60);
      const def = charges.get(key);
      const label = def?.label || key || `Development row ${index + 1}`;
      if (!def) {
        refusals.push({
          kind: "service", index, label,
          missing: [{
            field: "developmentChargeKey",
            message: "That development charge is not one this company has configured.",
          }],
        });
        continue;
      }
      /* ── A PER-UNIT CHARGE NEEDS A COUNT ─────────────────────────────
         "₹2,000 per screen" is not a cost until somebody says how many
         screens. It cannot be asked for in the shape check above, because
         until the charge is known nobody can say whether it applies — a flat
         charge asks for no quantity at all. */
      if (def.calculation === "PER_REQUIREMENT_UNIT" && !positive(r.quantity)) {
        refusals.push({
          kind: "service", index, label,
          missing: [{
            field: "quantity",
            message: `${label} is charged per ${def.unit || "unit"}. Say how many. A blank quantity is not one.`,
          }],
        });
        continue;
      }
      serviceRequirements.push({
        rowId: keepService(r.rowId),
        purpose: "DEVELOPMENT_TOOLING",
        developmentSource: "COMPANY_POLICY",
        developmentChargeKey: key,
        /* How many of what the charge is priced per. Absent on a flat charge,
           which is not a quantity of anything. */
        ...(def.calculation === "PER_REQUIREMENT_UNIT"
          ? { quantity: Number(r.quantity), billingUnit: str(def.unit, 60) }
          : {}),
        specification: str(r.specification),
        /* One-time by definition, and forced rather than read: a setup charge
           stored as per-garment would be multiplied by the run. */
        basis: "FIXED_PER_RUN",
        owner: OWNERS.includes(r.owner) ? r.owner : "RND",
        evidence: r.evidence,
        included: r.included !== false,
        excludedReason: r.included === false ? str(r.excludedReason, 500) : "",
        notes: str(r.notes, 500),
      });
      continue;
    }

    const label = str(r.serviceName, 200) || `Outside process row ${index + 1}`;
    const master = serviceDocs.get(String(r.serviceId));
    if (!master) { refusals.push(notOurs("service", index, label, "service")); continue; }
    /* The Service master HAS a lifecycle, unlike RawItem — so unlike the item
       above, this one can and does check it. Recording a requirement against
       a service nobody buys any more is a costing that cannot be priced. */
    if (String(master.status || "").toUpperCase() !== "ACTIVE") {
      refusals.push({
        kind: "service", index, label,
        missing: [{ field: "serviceId", message: `${master.name} is not active in the Service Master.` }],
      });
      continue;
    }

    serviceRequirements.push({
      rowId: keepService(r.rowId),
      serviceId: master._id,
      serviceCode: str(master.serviceCode, 60),
      serviceName: str(master.name, 200),
      specification: str(r.specification),
      quantity: Number(r.quantity),
      /* How the SUPPLIER bills it, as R&D recorded it. The master's own
         billing unit is a default the form offers, not an override — a
         supplier may quote per lot for something the master calls per piece,
         and the costing matches the requirement against the quotation. */
      billingUnit: str(r.billingUnit, 60),
      /* Recurring work scales with the run; bought-in setup is paid once
         whatever the run, so its basis is forced rather than read. */
      ...(r.purpose === "DEVELOPMENT_TOOLING"
        ? { purpose: "DEVELOPMENT_TOOLING", developmentSource: "SUPPLIER_QUOTATION", basis: "FIXED_PER_RUN" }
        : { purpose: "OUTSIDE_PROCESS", basis: SERVICE_BASES.includes(r.basis) ? r.basis : "PER_GARMENT" }),
      owner: OWNERS.includes(r.owner) ? r.owner : "RND",
      evidence: r.evidence,
      included: r.included !== false,
      excludedReason: r.included === false ? str(r.excludedReason, 500) : "",
      notes: str(r.notes, 500),
    });
  }

  if (refusals.length) {
    throw invalid(
      `${refusals.length} row${refusals.length === 1 ? "" : "s"} names something this company's registers do not have.`,
      refusals,
    );
  }

  return { packagingRequirements, serviceRequirements };
}

module.exports = {
  BASES, EVIDENCE, OWNERS,
  companyForStyle, startedPackaging, startedService,
  packagingGaps, serviceGaps, resolveRequirements,
};
