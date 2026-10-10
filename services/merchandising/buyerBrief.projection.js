// services/merchandising/buyerBrief.projection.js
//
// SALES' BRIEF, AS MERCHANDISING READS IT.
//
// ── ONE PROJECTION, BUILT ON THE SERVER ───────────────────────────────────
// The frontend used to be handed a handful of raw Sales fields and left to
// decide what a missing one meant, what a key like `RELAXED` says in English,
// and which of three screens should show it. Three screens made three
// different choices, so a brief read differently depending on the tab.
//
// So this is the whole brief, once: every fact already resolved to the words a
// merchandiser reads, every absence already stated in a sentence, and the
// grouping already decided. A tab chooses which groups to show, never what a
// fact means.
//
// ── WHAT IT WILL NOT CARRY ────────────────────────────────────────────────
// Everything in the request's `FORBIDDEN_FIELDS` stays in Sales: the
// opportunity's value, margin, the quotation, internal notes, buyer
// conversations and buyer contacts. This module reads a fixed list of paths
// and cannot pass through a field it does not name, so a later Sales addition
// cannot leak by accident — it simply will not appear until somebody adds it
// here on purpose.
//
// ── AND WHAT AN ABSENCE IS ────────────────────────────────────────────────
// `null` means Sales has not said. It is never a zero, never a "no", and never
// a default. Each field carries its own sentence for that case, because "not
// stated" reads differently on a target price than on a wash requirement, and
// the merchandiser's next action differs too.
"use strict";

const {
  VOCABULARY, REFERENCE_TYPE_LABEL, labelFor,
} = require("../sales/developmentBriefVocabulary");

const str = (v) => String(v ?? "").trim();

/**
 * One fact, resolved.
 *
 * `value` is what to print, or null. `absent` is the sentence to print
 * instead. Both are decided here so no screen has to invent either.
 */
const fact = (value, absent, extra = {}) => ({
  value: value === 0 ? "0" : (str(value) || null),
  absent,
  ...extra,
});

/** A controlled choice, as its label plus whatever note Sales added. */
function choiceFact(node, list, absent) {
  const key = str(node?.choice).toUpperCase();
  return {
    value: key ? (labelFor(list, key) || key) : null,
    key: key || null,
    note: str(node?.note) || null,
    absent,
  };
}

/** Several controlled choices, as labels. */
function choiceListFact(node, list, absent) {
  const keys = (Array.isArray(node?.values) ? node.values : [])
    .map((v) => str(v).toUpperCase()).filter(Boolean);
  return {
    values: keys.map((k) => ({ key: k, label: labelFor(list, k) || k })),
    note: str(node?.note) || null,
    absent,
  };
}

/**
 * ── REQUIRED / NOT REQUIRED / NOT CONFIRMED / NOT ASKED ───────────────────
 * Four states on screen from three stored values plus absence, because they
 * are four different situations for a merchandiser:
 *
 *   REQUIRED      — plan for it, and the detail says what
 *   NOT_REQUIRED  — the buyer decided against it; do not price it in
 *   NOT_CONFIRMED — Sales has asked and has no answer; chase it
 *   (absent)      — nobody has asked; the brief predates the question
 */
function processFact(node, label) {
  const state = str(node?.state).toUpperCase();
  const detail = str(node?.detail) || null;
  const words = {
    REQUIRED: "Required",
    NOT_REQUIRED: "Not required",
    NOT_CONFIRMED: "Not confirmed yet",
  };
  return {
    label,
    state: state || null,
    value: state ? words[state] || state : null,
    required: state === "REQUIRED",
    detail: state === "REQUIRED" ? detail : null,
    absent: `No ${label.toLowerCase()} requirement stated`,
  };
}

/**
 * The money fact, which is the one most likely to be read in a hurry.
 *
 * Formatted here so the header, the decision strip and the Sales brief tab
 * cannot disagree about it — they used to each format it themselves.
 */
function targetPrice(ceiling) {
  /* ── `Number(null)` IS 0, AND THAT IS NOT A PRICE ──────────────────────
     An unset subdocument still materialises with `amount: null`, so coercing
     first turned "Sales said nothing" into a target price of ₹0 per piece —
     a ceiling no material on earth can be selected under. The raw value has
     to BE a number before it means anything. */
  const raw = ceiling?.amount;
  const amount = typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(amount)) {
    return {
      value: null, amount: null, currency: null, basis: null,
      display: null,
      absent: "Sales has not provided a target price",
    };
  }
  const currency = str(ceiling.currency) || "INR";
  const symbol = { INR: "₹", USD: "$", GBP: "£", EUR: "€" }[currency] || "";
  const money = `${symbol}${amount.toLocaleString("en-IN")}`;
  return {
    value: money,
    amount,
    currency,
    /* Spelled out: "PER_PIECE" is a key, "per piece" is what it means. */
    basis: "per piece",
    display: `${money} ${symbol ? "" : `${currency} `}per piece`.replace(/\s+/g, " ").trim(),
    absent: null,
  };
}

/**
 * A reference image, with its provenance intact.
 *
 * The old projection carried the url and the caption only, so a brief could
 * not tell an artwork from a packaging shot and nothing recorded which Sales
 * version supplied it. Nothing is COPIED into Merchandising: the url and the
 * storage reference point at the media Sales uploaded, and that is the only
 * copy there is.
 */
function imageView(img, { requestRef, versionNo }) {
  const type = str(img?.referenceType).toUpperCase() || "PRODUCT";
  return {
    url: str(img?.url),
    caption: str(img?.caption) || null,
    storageRef: str(img?.storageRef) || null,
    referenceType: type,
    typeLabel: REFERENCE_TYPE_LABEL[type] || REFERENCE_TYPE_LABEL.OTHER,
    /* Which Sales statement this reference arrived on. */
    sourceRequestRef: requestRef,
    sourceVersionNo: versionNo,
  };
}

/**
 * THE BRIEF.
 *
 * `request` is the Development File's CURRENT Sales request version, read
 * whole. Null when the file has none — a state the caller must still be able
 * to render, so the shape is the same and every fact is absent.
 */
function buyerBrief(request) {
  if (!request) return null;

  const requestRef = str(request.requestRef);
  const versionNo = request.versionNo ?? null;
  const cd = request.customerDirection || {};
  const pd = request.productDirection || {};
  const dn = request.developmentNeed || {};

  const season = (() => {
    const base = choiceFact(cd.season, "season", "Season not stated");
    const year = Number.isInteger(cd.season?.year) ? cd.season.year : null;
    return {
      ...base,
      year,
      value: base.value ? `${base.value}${year ? ` ${year}` : ""}` : (year ? String(year) : null),
    };
  })();

  const images = (request.referenceImages || [])
    .map((i) => imageView(i, { requestRef, versionNo }))
    .filter((i) => i.url);

  const brief = {
    /* ── WHICH STATEMENT THIS IS ──────────────────────────────────────── */
    source: {
      requestRef,
      versionNo,
      state: str(request.state),
      recordedByName: str(request.requestedBy?.name) || null,
      recordedAt: request.requestedAt || null,
      /* The one line every surface prints, so none of them words it
         differently. */
      sentence: `Recorded by Sales · Read-only in Merchandising · Request v${versionNo ?? "?"}`,
    },

    /* ── ORDER CONTEXT ────────────────────────────────────────────────── */
    orderContext: {
      productName: fact(request.productName, "Not provided"),
      styleRef: fact(request.styleRef, "No style reference"),
      buyer: fact(request.buyerDisplayLabel, "Not provided"),
      requiredByDate: request.requiredByDate || null,
      requiredByAbsent: "Sales has not stated a required-by date",
      /* Where the work came from, when Sales raised one. Ids, because the
         screens link by them; no Sales record is followed. */
      sampleStyleId: request.sampleStyleId ? str(request.sampleStyleId) : null,
      stockItemId: request.stockItemId ? str(request.stockItemId) : null,
      repeatOfRegisteredItem: Boolean(request.stockItemId),
    },

    /* ── THE COMMERCIAL BOUNDARY ──────────────────────────────────────── */
    commercial: { targetPrice: targetPrice(request.targetPriceCeiling) },

    /* ── WHO IT IS FOR ───────────────────────────────────────────────── */
    customerDirection: {
      market: choiceFact(cd.market, "market", "Market not stated"),
      season,
      intendedUse: choiceFact(cd.intendedUse, "intendedUse", "Intended use not stated"),
      targetCustomer: fact(cd.targetCustomer, "Target customer not stated"),
    },

    /* ── WHAT IT SHOULD BE LIKE ──────────────────────────────────────── */
    productDirection: {
      fit: choiceFact(pd.fit, "fit", "No fit preference stated"),
      fabric: choiceListFact(pd.fabric, "fabricFamily", "No fabric preference stated"),
      composition: fact(pd.composition, "No composition preference stated"),
      weightOrFeel: fact(pd.weightOrFeel, "No weight or feel stated"),
      coloursWanted: fact(pd.coloursWanted, "No colours stated"),
      performance: choiceListFact(pd.performance, "performance", "No performance expectation stated"),
      trimsAndBranding: fact(pd.trimsAndBranding, "No trim or branding direction stated"),
      /* Last, and its own fact, because it is the one a merchandiser must
         read before selecting anything. */
      avoid: fact(pd.avoid, "Nothing stated to avoid"),
    },

    /* ── WHAT HAS TO BE MADE ─────────────────────────────────────────── */
    developmentNeed: {
      requestedCategories: (request.requestedCategories || []).map((c) => ({
        key: str(c),
        label: str(c).replace(/_/g, " ").toLowerCase(),
      })),
      requirementSummary: fact(request.requirementSummary,
        "Sales stated no summary on this version"),
      sampleType: choiceFact(dn.sampleType, "sampleType", "Sample type not stated"),
      sampleQuantity: Number.isInteger(dn.sampleQuantity) ? dn.sampleQuantity : null,
      sampleQuantityAbsent: "Sample quantity not stated",
      sampleSizes: (Array.isArray(dn.sampleSizes) ? dn.sampleSizes : []).map(str).filter(Boolean),
      sampleSizesAbsent: "Sample sizes not stated",
      samplePackaging: fact(dn.samplePackaging, "No sample packaging instruction stated"),
    },

    /* ── SPECIAL PROCESSES ───────────────────────────────────────────── */
    specialProcesses: [
      processFact(dn.printing, "Printing"),
      processFact(dn.embroidery, "Embroidery"),
      processFact(dn.washFinish, "Wash or finish"),
    ],

    /* ── WHAT MUST BE PROVED ─────────────────────────────────────────── */
    compliance: {
      testing: choiceListFact(dn.testing, "testing", "No testing requirement stated"),
      certification: choiceListFact(dn.certification, "certification",
        "No certification requirement stated"),
      sustainability: choiceListFact(dn.sustainability, "sustainability",
        "No sustainability requirement stated"),
    },

    /* ── WHAT THE BUYER SENT ─────────────────────────────────────────── */
    references: {
      /* The one to show large: the buyer's own product shot where there is
         one, else whatever reference exists. */
      primary: images.find((i) => i.referenceType === "PRODUCT") || images[0] || null,
      all: images,
      absent: "Sales attached no references to this version",
    },
  };

  /* ── WHAT SALES HAS NOT SAID, COUNTED ONCE ─────────────────────────────
     So a screen can offer "Ask Sales" against something specific instead of
     making the merchandiser hunt for the holes. Order matters: the ones that
     block a material decision come first. */
  brief.missing = missingFacts(brief);
  return brief;
}

/** Every fact Sales has not stated, in the words the brief uses for it. */
function missingFacts(brief) {
  const out = [];
  const add = (label, sentence) => out.push({ label, sentence });

  if (!brief.commercial.targetPrice.value) {
    add("Target price", brief.commercial.targetPrice.absent);
  }
  if (!brief.orderContext.requiredByDate) {
    add("Required by", brief.orderContext.requiredByAbsent);
  }
  for (const [label, node] of [
    ["Market", brief.customerDirection.market],
    ["Season", brief.customerDirection.season],
    ["Intended use", brief.customerDirection.intendedUse],
    ["Fit", brief.productDirection.fit],
  ]) {
    if (!node.value) add(label, node.absent);
  }
  for (const [label, node] of [
    ["Fabric", brief.productDirection.fabric],
    ["Performance", brief.productDirection.performance],
    ["Testing", brief.compliance.testing],
  ]) {
    if (!node.values.length) add(label, node.absent);
  }
  for (const [label, node] of [
    ["Composition", brief.productDirection.composition],
    ["Colours", brief.productDirection.coloursWanted],
  ]) {
    if (!node.value) add(label, node.absent);
  }
  const unconfirmed = brief.specialProcesses.filter((p) => !p.state);
  if (unconfirmed.length === brief.specialProcesses.length) {
    add("Special processes", "No special process confirmed");
  }
  if (!brief.references.all.length) add("References", brief.references.absent);
  return out;
}

module.exports = {
  buyerBrief, targetPrice, processFact, choiceFact, choiceListFact, imageView,
  missingFacts, VOCABULARY,
};
