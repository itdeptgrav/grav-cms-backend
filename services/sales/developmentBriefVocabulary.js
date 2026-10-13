// services/sales/developmentBriefVocabulary.js
//
// THE ONE PLACE EVERY CONTROLLED CHOICE IN THE BUYER BRIEF IS NAMED.
//
// ── WHY THE LABEL LIVES HERE AND NOT IN THE FORM ──────────────────────────
// Each option has a KEY, which is what the versioned request stores and what
// every report counts, and a LABEL, which is the plain words a salesperson
// picks and a merchandiser reads. Both belong together: a label kept in the
// React form means the Sales screen and the Merchandising brief can disagree
// about what `RELAXED` means, and the one that is wrong is invisible until
// somebody cuts fabric.
//
// So this module is served to the browser (`GET /api/cms/sales/development-
// requests/vocabulary`) and imported by the model for its enums. The frontend
// never hard-codes an option.
//
// ── AND WHY SOME FACTS ARE NOT HERE ───────────────────────────────────────
// Colours, composition, trims, construction notes and "avoid" instructions
// stay concise free text. A buyer who says "warm ivory, not optic white" has
// said something a dropdown of twelve colours cannot hold, and forcing the
// choice would lose the sentence that mattered. The rule used: a controlled
// list where the vocabulary is the company's and stable, free text where the
// value is the buyer's own words.
"use strict";

/** A list of `{key, label}`, frozen, from a flat object of key → label. */
const vocab = (pairs) => Object.freeze(Object.entries(pairs)
  .map(([key, label]) => Object.freeze({ key, label })));

const keysOf = (list) => list.map((o) => o.key);

/* ── CUSTOMER DIRECTION ─────────────────────────────────────────────────── */

/** Where it will be sold. Destinations the company actually ships to. */
const MARKET = vocab({
  UK: "United Kingdom",
  EUROPE: "Europe",
  USA: "United States",
  CANADA: "Canada",
  MIDDLE_EAST: "Middle East",
  INDIA: "India",
  AUSTRALIA: "Australia / New Zealand",
  JAPAN: "Japan",
  SOUTH_KOREA: "South Korea",
  OTHER: "Somewhere else",
});

/**
 * When it is for. Retail seasons, not months: a buyer says "Resort 2027" and
 * the year matters, so the year is a separate number rather than thirty
 * enum values that go stale.
 */
const SEASON = vocab({
  SPRING_SUMMER: "Spring / Summer",
  AUTUMN_WINTER: "Autumn / Winter",
  RESORT: "Resort / Cruise",
  PRE_FALL: "Pre-fall",
  HOLIDAY: "Holiday / Festive",
  YEAR_ROUND: "Year round",
});

/** What it is for. Decides fabric weight and finish more than anything else. */
const INTENDED_USE = vocab({
  EVERYDAY: "Everyday wear",
  OCCASION: "Occasion / party",
  RESORT_HOLIDAY: "Resort and holiday",
  WORKWEAR: "Office and workwear",
  ACTIVE: "Active and sport",
  LOUNGE_SLEEP: "Lounge and sleep",
  OUTERWEAR: "Outerwear",
  UNIFORM: "Uniform and corporate",
});

/* ── PRODUCT DIRECTION ──────────────────────────────────────────────────── */

/** How it should fit. */
const FIT = vocab({
  SLIM: "Slim",
  TAILORED: "Tailored",
  REGULAR: "Regular",
  RELAXED: "Relaxed",
  OVERSIZED: "Oversized",
  BOXY: "Boxy",
  STRAIGHT: "Straight",
  A_LINE: "A-line",
});

/** The family of fabric, not the quality — that is the composition note. */
const FABRIC_FAMILY = vocab({
  COTTON_WOVEN: "Cotton woven",
  COTTON_KNIT: "Cotton jersey / knit",
  LINEN: "Linen and linen blends",
  VISCOSE: "Viscose / rayon",
  POLYESTER: "Polyester and blends",
  WOOL: "Wool and wool blends",
  SILK: "Silk",
  DENIM: "Denim",
  TENCEL_LYOCELL: "Tencel / lyocell",
  CORDUROY: "Corduroy",
  TERRY_FLEECE: "Terry and fleece",
  OTHER: "Something else",
});

/** What the garment has to DO. Each one changes what may be selected. */
const PERFORMANCE = vocab({
  BREATHABLE: "Breathable",
  OPAQUE: "Opaque enough to wear alone",
  STRETCH: "Stretch and recovery",
  MOISTURE_WICKING: "Moisture wicking",
  QUICK_DRY: "Quick drying",
  WRINKLE_RESISTANT: "Wrinkle resistant",
  WATER_REPELLENT: "Water repellent",
  WIND_RESISTANT: "Wind resistant",
  THERMAL: "Warm / thermal",
  UV_PROTECTION: "UV protection",
  ANTIMICROBIAL: "Odour control",
  SOFT_HANDLE: "Soft handle",
});

/* ── DEVELOPMENT NEED ───────────────────────────────────────────────────── */

/** Which sample Sales needs made. */
const SAMPLE_TYPE = vocab({
  PROTO: "Proto sample",
  FIT: "Fit sample",
  SIZE_SET: "Size set",
  SALESMAN: "Salesman / showroom sample",
  PHOTOSHOOT: "Photoshoot sample",
  PRE_PRODUCTION: "Pre-production sample",
});

/**
 * ── THREE ANSWERS, BECAUSE "NOT CONFIRMED" IS A REAL ONE ──────────────────
 * A brief that leaves printing blank is unreadable: nobody can tell whether the
 * buyer said no or whether Sales has not asked yet. Those lead to different
 * actions — one is a decision, the other is a question for the buyer — so they
 * are different values, and the absence of the field is a third thing again
 * (a request raised before this was captured at all).
 */
const PROCESS_STATE = vocab({
  REQUIRED: "Required",
  NOT_REQUIRED: "Not required",
  NOT_CONFIRMED: "Not confirmed yet",
});

/** Tests the buyer expects passed. */
const TESTING = vocab({
  COLOUR_FASTNESS: "Colour fastness",
  SHRINKAGE: "Shrinkage",
  PILLING: "Pilling and abrasion",
  TENSILE_SEAM: "Tensile and seam strength",
  FIBRE_COMPOSITION: "Fibre composition",
  AZO_DYES: "Banned azo dyes",
  PH_VALUE: "pH value",
  FLAMMABILITY: "Flammability",
  METAL_DETECTION: "Metal detection",
  CARE_WASH: "Care and wash trial",
});

/** Certifications and compliance schemes the buyer requires. */
const CERTIFICATION = vocab({
  GOTS: "GOTS (organic)",
  OEKO_TEX: "OEKO-TEX Standard 100",
  GRS: "GRS (recycled)",
  RCS: "RCS (recycled claim)",
  BCI: "Better Cotton",
  FSC: "FSC (paper and packaging)",
  REACH: "REACH",
  CPSIA: "CPSIA (children's)",
  SEDEX_SMETA: "Sedex / SMETA audit",
  WRAP: "WRAP",
});

/** Sustainability expectations, which are not the same as a certificate. */
const SUSTAINABILITY = vocab({
  RECYCLED_CONTENT: "Recycled content",
  ORGANIC_FIBRE: "Organic fibre",
  DEADSTOCK: "Deadstock / surplus fabric",
  LOW_WATER_DYE: "Low-water dyeing",
  BIODEGRADABLE: "Biodegradable materials",
  RECYCLABLE_PACKAGING: "Recyclable packaging",
  PLASTIC_FREE_PACKAGING: "Plastic-free packaging",
  LOCAL_SOURCING: "Locally sourced",
});

/* ── WHAT A REFERENCE IMAGE IS OF ───────────────────────────────────────────
   The model's own `REFERENCE_TYPE` keys, given the words a person reads. Kept
   here beside the rest so one request serves the whole form and the whole
   brief; the keys themselves stay owned by the model. */
const REFERENCE_TYPE_LABEL = Object.freeze({
  PRODUCT: "Product reference",
  ARTWORK: "Artwork reference",
  BUYER_SAMPLE: "Buyer sample",
  TRIM: "Material or trim reference",
  PACKAGING: "Packaging reference",
  OTHER: "Other reference",
});

const VOCABULARY = Object.freeze({
  market: MARKET,
  season: SEASON,
  intendedUse: INTENDED_USE,
  fit: FIT,
  fabricFamily: FABRIC_FAMILY,
  performance: PERFORMANCE,
  sampleType: SAMPLE_TYPE,
  processState: PROCESS_STATE,
  testing: TESTING,
  certification: CERTIFICATION,
  sustainability: SUSTAINABILITY,
});

/** Every label, by list and key, for a reader that holds only stored keys. */
const labelFor = (list, key) => (VOCABULARY[list] || [])
  .find((o) => o.key === String(key || "").toUpperCase())?.label || "";

module.exports = {
  MARKET, SEASON, INTENDED_USE, FIT, FABRIC_FAMILY, PERFORMANCE,
  SAMPLE_TYPE, PROCESS_STATE, TESTING, CERTIFICATION, SUSTAINABILITY,
  REFERENCE_TYPE_LABEL, VOCABULARY, keysOf, labelFor,
};
