// services/centralCosting/calculationInput.js
//
// Central Costing — Chunk 2. WHAT A CLIENT MAY SEND TO A CALCULATION.
//
// Same discipline as `costingInput.js`: allowlist by construction, refuse
// rather than repair, and never let a payload set anything the server owns.
// Nothing here reads or writes a database, so the whole request contract can
// be exercised without one.
//
// ── WHAT IT DELIBERATELY CANNOT PRODUCE ─────────────────────────────────────
// A company. An actor. A version number. A status. A policy. A `VERIFIED`
// confidence. Every one of those is server-derived, and there is no code path
// in this file that could take one from a body even if it were sent.
"use strict";

const { CATEGORIES, BEHAVIOURS, BASIS_KEYS, TAX_TREATMENTS } = require("./engine");
const { parseMoney, MoneyError } = require("./money");
const { dec, percent, DecimalError } = require("./decimal");
const { fail } = require("../storePurchase/errors");
/* Lazily, like `costCoverage` above it: this module is required by the route
   layer at load, and the applicability table pulls the Store evidence service
   behind it. */
const familyApplicability = () => require("./familyApplicability.service");

const MAX_LINES = 400;
const MAX_SCENARIOS = 12;

const bad = (message, details) => fail("VALIDATION", message, details);
const text = (v) => (typeof v === "string" ? v.trim() : "");

/** Translate the pure parsers' errors into the API's refusal shape. */
const lift = (fn) => {
  try {
    return fn();
  } catch (err) {
    if (err instanceof DecimalError || err instanceof MoneyError) throw bad(err.message, err.details);
    throw err;
  }
};

/**
 * One cost line from a request.
 *
 * `confidence` is NOT read from the payload. Chunk 1's hardening established
 * why: `VERIFIED` is a statement that the server checked something against a
 * master, and nothing typed into a request has been checked by anybody. A
 * manual line is provisional, and a caller that asks otherwise is told so
 * rather than quietly downgraded.
 */
function parseLine(raw, i, currency, seen) {
  const field = `lines[${i}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw bad("Each cost line must be an object.", { field, reason: "LINE_SHAPE" });
  }

  const lineKey = text(raw.lineKey);
  if (!lineKey) throw bad("Every cost line needs a stable key.", { field: `${field}.lineKey`, reason: "LINE_KEY_REQUIRED" });
  if (lineKey.length > 120) throw bad("That line key is too long.", { field: `${field}.lineKey`, reason: "TOO_LONG" });
  if (seen.has(lineKey)) {
    throw bad(`Two cost lines share the key "${lineKey}".`, { field: `${field}.lineKey`, reason: "LINE_KEY_DUPLICATE", lineKey });
  }
  seen.add(lineKey);
  if (lineKey.startsWith("policy:")) {
    /* Reserved: the engine synthesises `policy:overhead` from the company
       policy, and a client line sharing that key would collide with it and
       make the breakdown unreadable. */
    throw bad("Line keys beginning with \"policy:\" are reserved for the company policy.", {
      field: `${field}.lineKey`, reason: "LINE_KEY_RESERVED", lineKey,
    });
  }

  const category = text(raw.category).toUpperCase();
  if (!CATEGORIES.includes(category)) {
    throw bad("That is not a cost category.", { field: `${field}.category`, reason: "CATEGORY_UNKNOWN", allowed: CATEGORIES });
  }
  const behaviour = text(raw.behaviour).toUpperCase();
  if (!BEHAVIOURS.includes(behaviour)) {
    throw bad("That is not a cost behaviour.", { field: `${field}.behaviour`, reason: "BEHAVIOUR_UNKNOWN", allowed: BEHAVIOURS });
  }

  const out = {
    lineKey,
    category,
    behaviour,
    label: text(raw.label).slice(0, 300),
    /* Always. See the header. */
    confidence: "PROVISIONAL",
    sourceRefKey: text(raw.sourceRefKey).slice(0, 200),
    note: text(raw.note).slice(0, 500),
    /* ── WHERE A LINE CAME FROM, IF IT WAS IMPORTED (Chunk 4A) ───────────
       The STABLE source key the technical preview issued — an item-and-variant
       pair for a material, an operation code for an operation. Never a display
       label: an operation renamed between two calculations would come back as
       a second row, and the costing would pay for the stitching twice.

       Only the key is accepted. What that key MEANT is re-read from the style
       at calculation time and frozen server-side, so a client cannot post a
       consumption the technical record never said. */
    technicalKey: text(raw.technicalKey).slice(0, 200),
    /* WHICH evidence was chosen — the planned pick or the approved sample.
       They can carry the same quantity and are different claims about where
       the number came from, so the binding step verifies it too. */
    technicalEvidence: text(raw.technicalEvidence).slice(0, 40),
    /* ── WHICH UNRESOLVED GROUP THIS LINE ANSWERS (Chunk 4A correction) ───
       Explicit, never inferred from the label. A SERVICE line could be the
       outside job work or the embroidery, and guessing from wording would
       let one clear the other. */
    unresolvedGroup: text(raw.unresolvedGroup).slice(0, 40),
  };
  /* ── A LINE MAY NAME A SUPPLIER QUOTATION (Chunk 3.2) ────────────────────
     Only the id, the subject and how much is consumed. NOT a supplier name
     and NOT a rate: a price the browser supplied is a price nobody quoted,
     and it would be frozen into a version as evidence. The server re-reads
     the offer from the Store register and derives the rate itself — see
     `offerPricing.service.js`.

     A line with no `supplierOfferId` is unchanged: a typed rate is still
     accepted and is still labelled PROVISIONAL, which is the manual
     compatibility path this chunk deliberately keeps. */
  /* ── A TECHNICAL LINE CARRIES ITS ITEM EVEN WITH NO QUOTATION ─────────
     These used to be parsed only for a quotation-backed line, because only
     the offer service needed them. An imported material with no quotation
     yet still has to prove it is about the item the technical record named,
     so the identity is kept whenever a technical key is present. Dropping it
     would make the binding check compare `undefined` and pass. */
  if (!text(raw.supplierOfferId) && out.technicalKey) {
    out.itemId = text(raw.itemId);
    if (text(raw.variantId)) out.variantId = text(raw.variantId);
    if (text(raw.consumptionUom)) out.consumptionUom = text(raw.consumptionUom).slice(0, 32);
  }

  const supplierOfferId = text(raw.supplierOfferId);
  if (supplierOfferId) {
    out.supplierOfferId = supplierOfferId;
    out.itemId = text(raw.itemId);
    out.variantId = text(raw.variantId) || undefined;
    out.consumptionUom = text(raw.consumptionUom).slice(0, 32);
    if (!out.itemId) {
      throw bad("A quotation-backed line must say which item it is for.",
        { field: `${field}.itemId`, reason: "ITEM_REQUIRED" });
    }
    if (!out.consumptionUom) {
      throw bad("A quotation-backed line must say what unit it is consumed in.",
        { field: `${field}.consumptionUom`, reason: "CONSUMPTION_UOM_REQUIRED" });
    }
    /* A caller that named an offer AND a rate is telling us two things about
       the same number. The quotation wins and the typed rate is refused
       outright, rather than silently ignored — silently ignoring it is how
       somebody believes they overrode a price. */
    if (raw.unitRate !== undefined && raw.unitRate !== null) {
      throw bad(
        "A line priced from a supplier quotation cannot also carry a typed rate.",
        { field: `${field}.unitRate`, reason: "RATE_AND_OFFER_BOTH_GIVEN" },
      );
    }
  }

  /* ── AND A PROVISIONAL OVERRIDE IS NOT ACCEPTED AT ALL ──────────────────
     It used to be: a declared, reasoned, server-attributed figure for a cost
     family no record in this repository could supply. That was a defensible
     answer while five of the ten families had no source. It is not one now —
     materials, operations, packaging, services, development, freight and
     financing each read a record, and the only family still awaiting a source
     is customs duty, which is answered by saying it does not apply and why.

     The remaining argument for keeping it was compatibility. But an override
     is indistinguishable in a total from a figure the server read off a dated
     quotation, and a costing is quoted from that total. "Somebody typed it"
     survives only in the provenance, which is not where a price is read.

     So it is refused by name, and the refusal says which application owns the
     fact. Refused rather than dropped: a payload that is quietly stripped and
     calculated anyway leaves the person believing their figure is in the
     costing, and the version they approve does not contain it. */
  if (raw.override !== undefined && raw.override !== null) {
    const owner = require("./costCoverage").ownerOf({
      family: text(raw.override?.family),
      category,
    });
    throw fail(
      "COSTING_MANUAL_INPUT_RETIRED",
      owner?.department
        ? `${owner.label} cannot be entered in Costing. ${owner.department} records it in ${owner.recordedIn}, and the costing reads it from there.`
        : "A cost figure cannot be entered in Costing. Every cost is read from the record of the department that owns it.",
      {
        field: `${field}.override`,
        reason: "MANUAL_OVERRIDE_RETIRED",
        lineKey,
        /* Named separately from the message so a screen can route on it
           rather than parse prose. */
        family: owner?.family || text(raw.override?.family) || null,
        owner: owner ? { department: owner.department, recordedIn: owner.recordedIn } : null,
        awaitingMessage: owner?.awaitingMessage || null,
      },
    );
  }
  /* ── AND NEITHER ARE ITS PARTS, SENT LOOSE ─────────────────────────────
     A caller that learned `override` is refused could send the same figure
     with the wrapper removed. `replacesLineKey` is the one that matters: it
     is the instruction to DISPLACE an assembled line, which is how a typed
     number takes a Store quotation's place in a total. Refused where it is
     written, rather than reached as an unknown key and dropped. */
  if (raw.replacesLineKey !== undefined && raw.replacesLineKey !== null) {
    throw fail(
      "COSTING_MANUAL_INPUT_RETIRED",
      "A cost line assembled from its source cannot be replaced by one sent with the request.",
      { field: `${field}.replacesLineKey`, reason: "REPLACEMENT_LINE_RETIRED", lineKey },
    );
  }

  /* ── SERVER-DERIVED FIGURES ARE REFUSED, NOT IGNORED (Chunk 5A) ─────────
     Every one of these is something the server works out from the quotation
     it re-reads: the rate a scenario reaches, the supplier quantity that
     earned it, and the saving that follows. A client that sent one would be
     asserting a commercial fact nobody quoted, and it would be frozen into an
     immutable version as evidence.

     Refused by name rather than dropped. Silently ignoring teaches a client
     the field works, and the next version of it stops checking. */
  const SERVER_DERIVED = [
    "unitRateByScenario", "ratesByScenario", "effectiveRate", "effectiveRateMinor",
    /* Freight's run total per scenario. Derived from the shipment facts and
       the quotation the server re-read, never posted. */
    "amountByScenario", "freightProvenance", "shipmentWorking",
    /* Moving a cost out of the price basis is not something a caller may
       ask for: it follows from the delivery terms on the enquiry. */
    "recoveredSeparately",
    "tierPrice", "tierPriceMinor", "purchaseQuantity", "supplierPurchaseQuantity",
    "eosSaving", "savingMinor", "comparedToPrimary", "explanation", "causes",
  ];
  for (const key of SERVER_DERIVED) {
    if (raw[key] !== undefined && raw[key] !== null) {
      throw bad(
        "Scenario rates and their explanations are worked out by the server from the quotation, and cannot be supplied.",
        { field: `${field}.${key}`, reason: "SERVER_DERIVED_FIELD" },
      );
    }
  }

  if (raw.confidence !== undefined && text(raw.confidence).toUpperCase() !== "PROVISIONAL") {
    throw bad(
      "A cost line entered through the API is provisional; it cannot declare itself verified.",
      { field: `${field}.confidence`, reason: "CONFIDENCE_NOT_CLIENT_SETTABLE", applied: "PROVISIONAL" },
    );
  }

  /* ── ABSENT IS PASSED THROUGH; MALFORMED IS REFUSED HERE ────────────────
     A line with no rate is not a shape problem, it is an incomplete costing —
     and the ENGINE is the layer that collects those, so it can report all six
     of them at once instead of sending the person back to the form six times.
     A rate that is present but wrong (a float, another currency, text) is a
     shape problem and is refused immediately, because the engine would only be
     guessing what it meant. */
  if (behaviour === "PER_UNIT") {
    out.unitRate = lift(() => parseMoney(raw.unitRate, {
      field: `${field}.unitRate`, required: false, currencyRequired: true,
    }));
    if (out.unitRate && out.unitRate.currency !== currency) {
      throw bad(`That rate is in ${out.unitRate.currency}, not the costing's ${currency}.`, {
        field: `${field}.unitRate.currency`, reason: "CURRENCY_MISMATCH", expected: currency,
      });
    }
    /* No default of 1: defaulting is a silent substitution, and "1" is one
       keystroke for a line that really is one per garment. */
    const qty = lift(() => dec(raw.quantityPerUnit, {
      field: `${field}.quantityPerUnit`, required: false, allowNegative: false,
    }));
    if (qty !== undefined) out.quantityPerUnit = qty.toFixed();
    out.quantityUom = text(raw.quantityUom).slice(0, 32);
  } else if (behaviour === "FIXED_PER_RUN") {
    out.amount = lift(() => parseMoney(raw.amount, {
      field: `${field}.amount`, required: false, currencyRequired: true,
    }));
    if (out.amount && out.amount.currency !== currency) {
      throw bad(`That amount is in ${out.amount.currency}, not the costing's ${currency}.`, {
        field: `${field}.amount.currency`, reason: "CURRENCY_MISMATCH", expected: currency,
      });
    }
  } else {
    const basis = text(raw.basis).toUpperCase();
    if (!BASIS_KEYS.includes(basis)) {
      throw bad("That is not something a percentage can be taken of.", {
        field: `${field}.basis`, reason: "BASIS_UNKNOWN", allowed: BASIS_KEYS,
      });
    }
    out.basis = basis;
    const pct = lift(() => percent(raw.percent, {
      field: `${field}.percent`, min: 0, max: 1000, required: false,
    }));
    if (pct !== undefined) out.percent = pct.toFixed();
  }

  const treatment = text(raw.tax?.treatment).toUpperCase() || "NONE";
  if (!TAX_TREATMENTS.includes(treatment)) {
    throw bad("That is not a tax treatment.", {
      field: `${field}.tax.treatment`, reason: "TAX_TREATMENT_UNKNOWN", allowed: TAX_TREATMENTS,
    });
  }
  out.tax = { treatment };
  if (treatment !== "NONE") {
    const rate = lift(() => percent(raw.tax?.ratePercent, {
      field: `${field}.tax.ratePercent`, min: 0, max: 100, required: false,
    }));
    if (rate !== undefined) out.tax.ratePercent = rate.toFixed();
  }

  return out;
}

/** The quantities to cost. */
function parseScenarios(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw bad("A calculation needs at least one quantity.", { field: "scenarios", reason: "SCENARIO_REQUIRED" });
  }
  if (raw.length > MAX_SCENARIOS) {
    throw bad(`A version may hold at most ${MAX_SCENARIOS} quantity scenarios.`, {
      field: "scenarios", reason: "TOO_MANY",
    });
  }
  const seen = new Set();
  const out = raw.map((s, i) => {
    const field = `scenarios[${i}]`;
    if (!s || typeof s !== "object" || Array.isArray(s)) {
      throw bad("Each scenario must be an object.", { field, reason: "SCENARIO_SHAPE" });
    }
    const key = text(s.key);
    if (!key) throw bad("Every scenario needs a key.", { field: `${field}.key`, reason: "SCENARIO_KEY_REQUIRED" });
    if (seen.has(key)) {
      throw bad(`Two scenarios share the key "${key}".`, { field: `${field}.key`, reason: "SCENARIO_KEY_DUPLICATE", key });
    }
    seen.add(key);
    const quantity = lift(() => dec(s.quantity, { field: `${field}.quantity`, allowNegative: false }));
    if (quantity.isZero()) {
      throw bad("A scenario must be for at least one piece.", {
        field: `${field}.quantity`, reason: "SCENARIO_QUANTITY_ZERO", key,
      });
    }
    /* ── THE PROPOSED SELLING PRICE (Chunk 4B) ────────────────────────────
       A COMMERCIAL PROPOSAL, not a cost input. It is parsed here beside the
       quantity because a price is proposed per run size, and it is carried
       through the calculation without ever reaching the engine: no cost line
       reads it, and changing it cannot move a single cost figure.

       EXCLUDING GST. Tax collected from a customer is not the company's
       revenue — it is collected on the government's behalf and paid over —
       so including it would inflate every profit figure by the tax rate. The
       field name says so, and the screen repeats it, because the whole answer
       is wrong if somebody enters the invoice total.

       Absent is not zero: a scenario nobody has priced yet has no profit to
       report, and a zero would render as losing the entire cost. */
    const proposed = s.proposedSellingPriceExclTax;
    const price = (proposed === undefined || proposed === null || proposed === "")
      ? undefined
      : lift(() => parseMoney(proposed, {
        field: `${field}.proposedSellingPriceExclTax`, required: false, currencyRequired: true,
      }));
    if (price && price.amountMinor < 0) {
      throw bad("A selling price cannot be negative.", {
        field: `${field}.proposedSellingPriceExclTax`, reason: "PRICE_NEGATIVE", key,
      });
    }

    return {
      key: key.slice(0, 64),
      label: text(s.label).slice(0, 200) || key.slice(0, 64),
      quantity: quantity.toFixed(),
      quantityUom: text(s.quantityUom).slice(0, 32) || undefined,
      isPrimary: Boolean(s.isPrimary),
      ...(price ? { proposedSellingPriceExclTax: price } : {}),
    };
  });

  const primaries = out.filter((s) => s.isPrimary).length;
  if (primaries > 1) {
    throw bad("Only one scenario can be the primary one.", {
      field: "scenarios", reason: "SCENARIO_PRIMARY_AMBIGUOUS",
    });
  }
  if (primaries === 0) out[0].isPrimary = true;
  return out;
}

/**
 * The whole `POST /api/costings/:id/versions` body.
 *
 * @param {object} body
 * @param {string} currency  the costing's base currency, from the POLICY —
 *   not from the request. A caller cannot choose the currency of a company's
 *   costing; the company's policy does.
 */
function parseCalculationRequest(body = {}, { currency, assembled = false } = {}) {
  const rawLines = body.lines;
  /* ── AN ASSEMBLED COSTING SENDS NO LINES, AND THAT IS THE POINT ────────
     A source-backed costing's material and operation rows are built by the
     server from the technical record. Requiring the browser to send at least
     one was the last place the old contract survived: it meant a client had
     to reconstruct the record before the server would assemble it, which is
     the defect this chunk exists to remove.

     Ad-hoc and historical costings are unchanged — they have no source to
     assemble from, so an empty list there really is an empty costing. */
  if (!Array.isArray(rawLines) || (rawLines.length === 0 && !assembled)) {
    throw bad("A calculation needs at least one cost line.", { field: "lines", reason: "NO_COST_LINES" });
  }
  if (rawLines.length > MAX_LINES) {
    throw bad(`A version may hold at most ${MAX_LINES} cost lines.`, { field: "lines", reason: "TOO_MANY" });
  }

  const seen = new Set();
  const lines = rawLines.map((l, i) => parseLine(l, i, currency, seen));

  refuseCommercialInputs(body);

  refuseAcknowledgements(body);
  refuseQuotationChoices(body);

  /* ── AND THE COMMERCIAL HALF IS NOT PARSED HERE ANY MORE ──────────────
     `scenarios`, `note` and `technicalStyleId` were read off the body and
     returned beside the lines. All three come from the Sales costing brief
     now — `salesBrief.toCalculationInput` builds them, `parseScenarios` still
     validates the quantities so the engine's contract has one authority, and
     the caller composes them onto this. */
  return { lines };
}

/**
 * THE COMMERCIAL INPUTS ARE REFUSED, AND TOLD WHERE THEY ARE RECORDED.
 *
 * ── WHAT THIS REPLACED ──────────────────────────────────────────────────────
 * `scenarios`, `note` and `technicalStyleId` on the calculation body: the run
 * sizes to price, which of them is primary, the unit, the proposed selling
 * price per run size, why the costing was raised, and which of several
 * SampleStyles it is about.
 *
 * Every one is a commercial decision. Which style is being quoted, what
 * quantities the customer wants priced and what the company proposes to sell
 * at belong to the person with the customer and the negotiation in front of
 * them — and none of what they typed here survived anywhere Sales could read
 * it back. It lives on the Enquiry now, as a brief Sales confirms.
 *
 * ── REFUSED, NOT IGNORED ────────────────────────────────────────────────────
 * A stale browser still sends these. Calculating from the brief while
 * silently discarding the quantities somebody just typed would produce a
 * version that is right and unexplainable — and a proposed price they believe
 * they recorded would be absent from the frozen record with nothing saying
 * why.
 */
function refuseCommercialInputs(body) {
  const sent = ["scenarios", "note", "technicalStyleId", "quantityUom"]
    .filter((k) => body?.[k] !== undefined && body?.[k] !== null);
  if (!sent.length) return;
  throw fail(
    "COSTING_BRIEF_MOVED",
    "What to cost — which approved style, what quantities, in what unit, at what proposed price — "
    + "is recorded by Sales on the enquiry and read by the costing. It cannot be sent one.",
    {
      field: sent[0],
      reason: "COMMERCIAL_INPUT_MOVED_TO_SALES",
      fields: sent,
      owner: { department: "Sales", recordedIn: "Enquiry · Costing brief" },
      /* Where, precisely. */
      briefAt: "/sales/dashboard/enquiries",
    },
  );
}

/**
 * A quotation choice sent with a calculation is refused, and told where it
 * belongs.
 *
 * ── WHAT THIS REPLACED ──────────────────────────────────────────────────────
 * `parseQuotationChoices` — `{ [assembledLineKey]: offerId }`, an identity and
 * never a rate, re-read and revalidated server-side per scenario. As a
 * PAYLOAD contract it was careful and it held: nothing a client sent could
 * become a price nobody quoted.
 *
 * What it could not fix is who was answering. Which supplier the company buys
 * from weighs lead time, capacity, quality history, terms and the
 * relationship, and a person costing a garment has none of that in front of
 * them. The decision belongs to Store, and Store now records it against the
 * requirement — so a costing READS the choice instead of carrying it.
 *
 * ── REFUSED, NOT IGNORED ────────────────────────────────────────────────────
 * A stale browser still sends this. Dropping it silently would calculate from
 * whatever Store decided — possibly a different supplier — while the person
 * who pressed Calculate believes they chose. That is worse than a refusal,
 * because the costing would be right and unexplainable.
 */
function refuseQuotationChoices(body) {
  const raw = body?.quotationChoices;
  if (raw === undefined || raw === null) return;
  /* An empty object is still a client that thinks it owns this decision. */
  throw fail(
    "COSTING_QUOTATION_CHOICE_MOVED",
    "Which supplier quotation prices a requirement is Store's decision, and is made in Store · Supplier offers. A costing reads it and cannot be sent one.",
    {
      field: "quotationChoices",
      reason: "QUOTATION_CHOICE_MOVED_TO_STORE",
      owner: { department: "Store", system: "Supplier offers · Sourcing decisions" },
      /* Where, precisely — a refusal with no address is what sends people
         looking for another way in. */
      decideAt: "/store/dashboard/supplier-offers/sourcing-decisions",
      lineKeys: raw && typeof raw === "object" && !Array.isArray(raw)
        ? Object.keys(raw).slice(0, 20) : [],
    },
  );
}

/**
 * AN APPLICABILITY DECISION SENT WITH A CALCULATION IS REFUSED.
 *
 * ── WHAT THIS REPLACED ──────────────────────────────────────────────────────
 * `parseAcknowledgements` — `technicalAcknowledgements: [{key, reason}]`, a
 * fixed vocabulary, a compulsory reason, one answer per group, frozen on the
 * version with its author's name. As a PAYLOAD contract it was careful and it
 * held: nothing here could turn a missing cost into no cost without somebody
 * signing for it.
 *
 * What it could not fix is who was signing. Whether the customer supplies the
 * packaging is Merchandising's fact; whether anything is sent outside is
 * Production's; whether these goods are imported is Store's; whether this
 * order is financed is Sales'. A person costing a garment has none of that in
 * front of them, and the reason they typed was their best guess at somebody
 * else's answer — frozen, permanently, as though it were evidence.
 *
 * So the decision moved to the record its owner already works in, and a
 * costing READS it.
 *
 * ── REFUSED, NOT STRIPPED ───────────────────────────────────────────────────
 * A stale browser still sends this. Dropping it silently would calculate from
 * whatever the departments had actually decided — quite possibly not what the
 * person pressing Calculate believes they excluded — and the version would be
 * right and unexplainable. Worse, a family they thought they had answered
 * would come back as outstanding with no indication why.
 *
 * ── AND MATERIALS AND OPERATIONS ARE NOT MERELY MOVED ───────────────────────
 * They cannot be excused anywhere, by anybody. A garment is made of something
 * and somebody makes it; a blank bill of materials or a blank route is
 * unfinished work, and the refusal says so rather than naming a desk that
 * could sign it off.
 */
function refuseAcknowledgements(body) {
  const raw = body?.technicalAcknowledgements;
  if (raw === undefined || raw === null) return;
  /* An empty list is still a client that believes it owns this decision. */
  const keys = Array.isArray(raw)
    ? raw.map((a) => text(a?.key)).filter(Boolean).slice(0, 20)
    : [];
  const owners = {};
  for (const key of keys) {
    const owner = familyApplicability().APPLICABILITY_OWNER[key];
    owners[key] = owner
      ? { department: owner.department, recordedIn: owner.recordedIn }
      /* Named as unanswerable rather than left out: a client told only "not
         here" for materials would look for the other screen. */
      : { department: null, recordedIn: null, inherentlyRequired: true };
  }
  throw fail(
    "COSTING_APPLICABILITY_DECISION_MOVED",
    "Whether a cost applies to this order is recorded by the department that owns it, and a costing reads that decision. "
    + "It cannot be sent one, and several families cannot be excused at all.",
    {
      field: "technicalAcknowledgements",
      reason: "APPLICABILITY_DECISION_MOVED_TO_SOURCE",
      keys,
      /* Where each one is actually answered. A refusal with no address is what
         sends people looking for another way in. */
      owners,
    },
  );
}

module.exports = {
  MAX_LINES, MAX_SCENARIOS,
  parseLine, parseScenarios, refuseAcknowledgements, refuseQuotationChoices,
  refuseCommercialInputs, parseCalculationRequest,
};
