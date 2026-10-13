// services/sales/developmentBriefCarryForward.js
//
// WHAT A CORRECTED SALES REQUEST KEEPS, CHANGES AND CLEARS.
//
// ── THE DEFECT THIS FIXES ─────────────────────────────────────────────────
// `issue()` built every successor from the posted body alone. So a correction
// that changed the required-by date and said nothing about the target price
// issued a new version with NO target price — and because each version is
// immutable and the previous one is superseded, the buyer's ceiling was simply
// gone, with nothing in the record to show it had ever been there or that
// anybody had decided to drop it.
//
// Nobody chose that. It was the shape of the write.
//
// ── THE RULE ──────────────────────────────────────────────────────────────
//   field absent from the body        → carry the previous version's value
//   field posted as null              → cleared, deliberately
//   field posted with a value         → that value
//
// Applied all the way down, so `{productDirection: {fit: {note: "..."}}}`
// changes the note and keeps the fit. An ARRAY is replaced whole, never
// merged: a buyer who sends three performance requirements instead of four has
// removed one, and a union would make removal impossible.
//
// `null` is the only way to clear. That is deliberate too — it means a clear
// is always something a person did, and never something a form forgot to send.
"use strict";

/** Is this a plain object worth recursing into (not an array, date or id)? */
const isGroup = (v) => Boolean(v)
  && typeof v === "object"
  && !Array.isArray(v)
  && Object.prototype.toString.call(v) === "[object Object]";

/**
 * One value's worth of the rule above.
 *
 * `absent` is what a cleared field becomes — the schema's own empty value, so
 * a cleared choice is `""` and a cleared list is `[]` rather than a null that
 * every reader would have to guard.
 */
function mergeValue(previous, incoming, absent) {
  if (incoming === undefined) return previous;
  if (incoming === null) return absent;

  if (isGroup(incoming)) {
    /* A group posted over a non-group (or over nothing) still merges field by
       field, so a first-ever `{fit: {value: "RELAXED"}}` works. */
    const base = isGroup(previous) ? previous : {};
    const emptyBase = isGroup(absent) ? absent : {};
    const out = { ...base };
    for (const key of Object.keys(incoming)) {
      out[key] = mergeValue(base[key], incoming[key], emptyBase[key]);
    }
    return out;
  }

  /* Arrays and scalars: taken as sent. */
  return incoming;
}

/**
 * ── WHAT "EMPTY" IS, PER FIELD ────────────────────────────────────────────
 * The shape a cleared brief has, matching the schema's own defaults. Written
 * out rather than derived from the Mongoose schema because it is the statement
 * of intent the tests read, and because a schema default can change for
 * reasons that have nothing to do with clearing.
 */
const EMPTY_BRIEF = Object.freeze({
  customerDirection: {
    market: { choice: "", note: "" },
    season: { choice: "", year: null, note: "" },
    intendedUse: { choice: "", note: "" },
    targetCustomer: "",
  },
  productDirection: {
    fit: { choice: "", note: "" },
    fabric: { values: [], note: "" },
    composition: "",
    weightOrFeel: "",
    coloursWanted: "",
    performance: { values: [], note: "" },
    trimsAndBranding: "",
    avoid: "",
  },
  developmentNeed: {
    sampleType: { choice: "", note: "" },
    sampleQuantity: null,
    sampleSizes: [],
    samplePackaging: "",
    printing: { state: "", detail: "" },
    embroidery: { state: "", detail: "" },
    washFinish: { state: "", detail: "" },
    testing: { values: [], note: "" },
    certification: { values: [], note: "" },
    sustainability: { values: [], note: "" },
  },
});

/** The groups this module governs. */
const BRIEF_GROUPS = Object.freeze(Object.keys(EMPTY_BRIEF));

/**
 * Merge the three brief groups of a successor against the version in force.
 *
 * `previous` may be null (a first version) and may be missing the groups
 * entirely (a request issued before they existed) — both behave as empty,
 * which is what makes an old record correctable without first being migrated.
 */
function carryForwardBrief(previous, body) {
  const out = {};
  for (const group of BRIEF_GROUPS) {
    out[group] = mergeValue(
      previous?.[group] ?? EMPTY_BRIEF[group],
      body?.[group],
      EMPTY_BRIEF[group],
    );
  }
  return out;
}

/**
 * The same rule for the fields that are NOT in a group — the ones that already
 * existed and were being cleared by omission in exactly the same way.
 *
 * `targetPriceCeiling` is the one that mattered: a commercial ceiling that
 * vanished on an unrelated correction. Its empty value is `undefined` rather
 * than an object, because the schema records "no ceiling" as an absent
 * subdocument and every reader already tests `Number.isFinite(amount)`.
 */
const EMPTY_FLAT = Object.freeze({
  targetPriceCeiling: undefined,
  requiredByDate: null,
  styleRef: "",
  referenceImages: [],
  requestedCategories: [],
  requirementSummary: "",
  sampleStyleId: null,
  stockItemId: null,
});

const FLAT_FIELDS = Object.freeze(Object.keys(EMPTY_FLAT));

function carryForwardFlat(previous, body, { only = FLAT_FIELDS } = {}) {
  const out = {};
  for (const field of only) {
    out[field] = mergeValue(previous?.[field], body?.[field], EMPTY_FLAT[field]);
  }
  return out;
}

/* ── VALIDATION ────────────────────────────────────────────────────────────
   Checked here rather than left to the schema's enums so a refusal names the
   field and offers the words a person chose from, instead of Mongoose's
   "Validator failed for path". */

const str = (v) => String(v ?? "").trim();

/** Where each controlled field's vocabulary comes from. One list, not two. */
const CONTROLLED = Object.freeze({
  "customerDirection.market.choice": { list: "market", many: false },
  "customerDirection.season.choice": { list: "season", many: false },
  "customerDirection.intendedUse.choice": { list: "intendedUse", many: false },
  "productDirection.fit.choice": { list: "fit", many: false },
  "productDirection.fabric.values": { list: "fabricFamily", many: true },
  "productDirection.performance.values": { list: "performance", many: true },
  "developmentNeed.sampleType.choice": { list: "sampleType", many: false },
  "developmentNeed.printing.state": { list: "processState", many: false },
  "developmentNeed.embroidery.state": { list: "processState", many: false },
  "developmentNeed.washFinish.state": { list: "processState", many: false },
  "developmentNeed.testing.values": { list: "testing", many: true },
  "developmentNeed.certification.values": { list: "certification", many: true },
  "developmentNeed.sustainability.values": { list: "sustainability", many: true },
});

/* "productDirection.fit.choice" reads as "fit", not "value" — the leaf names the
   shape, the segment before it names the fact. */
const fieldWords = (path) => {
  const parts = path.split(".");
  const leaf = parts[parts.length - 1];
  const name = ["choice", "values", "state"].includes(leaf) ? parts[parts.length - 2] : leaf;
  return name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
};

const at = (obj, path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
const setAt = (obj, path, value) => {
  const keys = path.split(".");
  const last = keys.pop();
  const parent = keys.reduce((o, k) => (o[k] = o[k] || {}), obj);
  parent[last] = value;
};

/**
 * Normalise and check a merged brief. `fail` is the caller's error factory, so
 * this module stays free of the Store's error registry and testable on its own.
 *
 * Returns the brief with every controlled value upper-cased and every unknown
 * one refused by name.
 */
function validateBrief(brief, { vocabulary, fail }) {
  const out = JSON.parse(JSON.stringify(brief));

  for (const [path, spec] of Object.entries(CONTROLLED)) {
    const options = vocabulary[spec.list] || [];
    const allowed = options.map((o) => o.key);
    const words = () => options.map((o) => `${o.label}`).join(", ");

    if (spec.many) {
      const raw = at(out, path);
      const list = (Array.isArray(raw) ? raw : []).map((v) => str(v).toUpperCase()).filter(Boolean);
      for (const v of list) {
        if (!allowed.includes(v)) {
          throw fail("VALIDATION",
            `"${v}" is not one of the choices for ${fieldWords(path)}. Choose from: ${words()}.`,
            { field: path, value: v, allowed });
        }
      }
      /* Deduplicated: the same requirement twice is one requirement. */
      setAt(out, path, [...new Set(list)]);
      continue;
    }

    const value = str(at(out, path)).toUpperCase();
    if (value && !allowed.includes(value)) {
      throw fail("VALIDATION",
        `"${value}" is not one of the choices for ${fieldWords(path)}. Choose from: ${words()}.`,
        { field: path, value, allowed });
    }
    setAt(out, path, value);
  }

  /* ── A DETAIL ONLY MEANS SOMETHING WHEN THE ANSWER IS "REQUIRED" ────────
     The form shows the box only then. Refused rather than dropped, because a
     detail typed against "not required" is somebody describing work they
     believe is happening, and silently discarding it loses that. */
  for (const key of ["printing", "embroidery", "washFinish"]) {
    const node = out.developmentNeed?.[key] || {};
    const detail = str(node.detail);
    if (detail && node.state !== "REQUIRED") {
      throw fail("VALIDATION",
        `${key === "washFinish" ? "Wash or finish" : key[0].toUpperCase() + key.slice(1)} has `
        + `details but is not marked Required. Mark it Required, or clear the details.`,
        { field: `developmentNeed.${key}.detail`, state: node.state || "" });
    }
    node.detail = detail;
  }

  /* The season year, when one is given at all. */
  const year = out.customerDirection?.season?.year;
  if (year !== null && year !== undefined && year !== "") {
    const n = Number(year);
    if (!Number.isInteger(n) || n < 2000 || n > 2100) {
      throw fail("VALIDATION", "A season year is a whole year between 2000 and 2100.",
        { field: "customerDirection.season.year", value: year });
    }
    out.customerDirection.season.year = n;
  } else if (out.customerDirection?.season) {
    out.customerDirection.season.year = null;
  }

  const qty = out.developmentNeed?.sampleQuantity;
  if (qty !== null && qty !== undefined && qty !== "") {
    const n = Number(qty);
    if (!Number.isInteger(n) || n < 0 || n > 10000) {
      throw fail("VALIDATION", "A sample quantity is a whole number of pieces, 0 to 10000.",
        { field: "developmentNeed.sampleQuantity", value: qty });
    }
    out.developmentNeed.sampleQuantity = n;
  } else if (out.developmentNeed) {
    out.developmentNeed.sampleQuantity = null;
  }

  if (out.developmentNeed) {
    const sizes = (Array.isArray(out.developmentNeed.sampleSizes)
      ? out.developmentNeed.sampleSizes : []).map(str).filter(Boolean);
    if (sizes.length > 20) {
      throw fail("VALIDATION", "That is more than twenty sample sizes.",
        { field: "developmentNeed.sampleSizes", limit: 20 });
    }
    out.developmentNeed.sampleSizes = [...new Set(sizes)];
  }

  return out;
}

module.exports = {
  mergeValue, carryForwardBrief, carryForwardFlat, validateBrief, CONTROLLED, fieldWords,
  EMPTY_BRIEF, EMPTY_FLAT, BRIEF_GROUPS, FLAT_FIELDS, isGroup,
};
