// services/centralCosting/costingInput.js
//
// Central Costing — Chunk 1. WHAT A CLIENT IS ALLOWED TO SAY.
//
// ── ALLOWLIST BY CONSTRUCTION ───────────────────────────────────────────────
// Every function here NAMES the fields it copies. Nothing a caller happens to
// send — `companyId`, `status`, `versionNumber`, `createdBy`, a nested object
// — can ride along into a document, because there is no path that copies an
// unknown key. That is the same discipline `buildRecoveryReceipt` uses on
// SpIdempotencyRecord, and for the same reason: a spread of `req.body` is one
// forgotten field away from a client setting its own company.
//
// ── AND IT REFUSES RATHER THAN REPAIRS ──────────────────────────────────────
// A malformed currency is not silently replaced with INR. A float in
// `amountMinor` is not rounded. An unknown source type is not dropped. Each is
// the caller's mistake to correct, and repairing it quietly is how a costing
// ends up built on inputs nobody agreed to.
"use strict";

const mongoose = require("mongoose");

const { CONTEXT_TYPES, CONTEXT_RULES } = require("../../models/CMS_Models/Costing/costingContext");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");
const { parseCurrency, parseMoney, MoneyError, DEFAULT_CURRENCY } = require("./money");
const { fail } = require("../storePurchase/errors");

const MAX_SNAPSHOT_FACTS = 25;
const MAX_SOURCE_REFERENCES = 200;
const MAX_CONTEXT_FACTS = 12;

const bad = (message, details) => fail("VALIDATION", message, details);

const text = (v) => (typeof v === "string" ? v.trim() : "");

const objectId = (value, field) => {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw bad("That reference is not a valid id.", { field, reason: "INVALID_OBJECT_ID" });
  }
  return new mongoose.Types.ObjectId(value);
};

/**
 * The typed business-context reference.
 *
 * Validated for SHAPE only. It is never resolved, never populated and never
 * asked which company it belongs to — see companyContext.service.js for why
 * reading company off the referenced document would be circular.
 */
function parseContext(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw bad("A costing must say what it is for.", { field: "context", reason: "CONTEXT_REQUIRED" });
  }
  const type = text(input.type).toUpperCase();
  if (!CONTEXT_TYPES.includes(type)) {
    throw bad(
      "That is not a kind of thing a costing can be raised against.",
      { field: "context.type", reason: "CONTEXT_TYPE_UNKNOWN", allowed: CONTEXT_TYPES },
    );
  }

  const rules = CONTEXT_RULES[type];
  const out = { type };

  if (input.primaryId !== undefined && input.primaryId !== null && input.primaryId !== "") {
    out.primaryId = objectId(input.primaryId, "context.primaryId");
  } else if (rules.primaryId) {
    throw bad(
      "A costing raised against a style, order or enquiry must say which one.",
      { field: "context.primaryId", reason: "CONTEXT_PRIMARY_ID_REQUIRED", contextType: type },
    );
  }

  if (input.secondaryId !== undefined && input.secondaryId !== null && input.secondaryId !== "") {
    out.secondaryId = objectId(input.secondaryId, "context.secondaryId");
  }

  const key = text(input.externalKey);
  if (key) {
    if (key.length > 200) {
      throw bad("That context key is too long.", { field: "context.externalKey", reason: "TOO_LONG" });
    }
    out.externalKey = key;
  } else if (rules.externalKey) {
    /* ENQUIRY_STYLE without a product key would be a costing for "some product
       in this enquiry", which the legacy sheets — keyed by product NAME —
       cannot be matched against. */
    throw bad(
      "A costing for a product inside an enquiry must name the product.",
      { field: "context.externalKey", reason: "CONTEXT_EXTERNAL_KEY_REQUIRED", contextType: type },
    );
  }

  /* ADHOC must not smuggle an id in: it would look like a reference to
     something and resolve to nothing. */
  if (type === "ADHOC" && out.primaryId) {
    throw bad(
      "An ad-hoc costing is not raised against a document, so it cannot name one.",
      { field: "context.primaryId", reason: "CONTEXT_ADHOC_HAS_ID" },
    );
  }

  return out;
}

/** The frozen display copy. Text only — no ids, no money, no nesting. */
function parseContextSnapshot(input, { label } = {}) {
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const facts = [];
  if (src.facts !== undefined && src.facts !== null) {
    if (!Array.isArray(src.facts)) {
      throw bad("Context details must be a list.", { field: "contextSnapshot.facts", reason: "NOT_A_LIST" });
    }
    if (src.facts.length > MAX_CONTEXT_FACTS) {
      throw bad(
        `A costing may carry at most ${MAX_CONTEXT_FACTS} context details.`,
        { field: "contextSnapshot.facts", reason: "TOO_MANY" },
      );
    }
    for (const [i, f] of src.facts.entries()) {
      if (!f || typeof f !== "object" || Array.isArray(f)) {
        throw bad("Each context detail must be a key and a value.", {
          field: `contextSnapshot.facts[${i}]`, reason: "NOT_AN_OBJECT",
        });
      }
      const key = text(f.key);
      if (!key) {
        throw bad("Each context detail needs a name.", {
          field: `contextSnapshot.facts[${i}].key`, reason: "KEY_REQUIRED",
        });
      }
      facts.push({ key: key.slice(0, 64), value: text(f.value).slice(0, 300) });
    }
  }
  return {
    label: (text(src.label) || text(label)).slice(0, 300),
    facts,
    capturedAt: new Date(),
  };
}

/** One snapshotted fact. Exactly one value column, never an object. */
function parseSourceFact(input, field) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw bad("Each source detail must be an object.", { field, reason: "NOT_AN_OBJECT" });
  }
  const key = text(input.key);
  if (!key) throw bad("Each source detail needs a name.", { field: `${field}.key`, reason: "KEY_REQUIRED" });

  const given = ["text", "num", "money"].filter(
    (k) => input[k] !== undefined && input[k] !== null,
  );
  if (given.length === 0) {
    throw bad("Each source detail must carry a value.", { field, reason: "VALUE_REQUIRED" });
  }
  if (given.length > 1) {
    /* Two columns would make "which one is the real value" a question every
       later reader has to answer, and they would not all answer it the same. */
    throw bad(
      "A source detail carries one value: text, a number, or an amount — not more than one.",
      { field, reason: "VALUE_AMBIGUOUS", given },
    );
  }

  const out = { key: key.slice(0, 64) };
  if (given[0] === "text") {
    const v = input.text;
    if (typeof v !== "string") throw bad("That source detail must be text.", { field: `${field}.text`, reason: "NOT_TEXT" });
    out.text = v.trim().slice(0, 300);
    return out;
  }
  if (given[0] === "num") {
    const v = input.num;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw bad("That source detail must be a finite number.", { field: `${field}.num`, reason: "NOT_FINITE" });
    }
    out.num = v;
    return out;
  }
  /* Money — integer minor units and a currency, or a refusal. */
  try {
    out.money = parseMoney(input.money, { field: `${field}.money`, required: true, currencyRequired: true });
  } catch (err) {
    if (err instanceof MoneyError) throw bad(err.message, err.details);
    throw err;
  }
  return out;
}

/**
 * The typed source references a version was built from.
 *
 * Chunk 1 accepts them but calculates nothing from them: a caller may record
 * what a version is based on, and the snapshot freezes what those things said.
 * Chunk 2's engine reads exactly this shape.
 */
function parseSourceReferences(input, { baseCurrency }) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw bad("Sources must be a list.", { field: "sourceReferences", reason: "NOT_A_LIST" });
  }
  if (input.length > MAX_SOURCE_REFERENCES) {
    throw bad(
      `A version may record at most ${MAX_SOURCE_REFERENCES} sources.`,
      { field: "sourceReferences", reason: "TOO_MANY" },
    );
  }

  return input.map((raw, i) => {
    const field = `sourceReferences[${i}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw bad("Each source must be an object.", { field, reason: "NOT_AN_OBJECT" });
    }
    const sourceType = text(raw.sourceType).toUpperCase();
    if (!CostingVersion.SOURCE_TYPES.includes(sourceType)) {
      throw bad("That is not a kind of source a costing can be built from.", {
        field: `${field}.sourceType`, reason: "SOURCE_TYPE_UNKNOWN", allowed: CostingVersion.SOURCE_TYPES,
      });
    }

    const out = { sourceType, capturedAt: new Date() };

    if (raw.sourceId !== undefined && raw.sourceId !== null && raw.sourceId !== "") {
      out.sourceId = objectId(raw.sourceId, `${field}.sourceId`);
    }
    const key = text(raw.sourceKey);
    if (key) out.sourceKey = key.slice(0, 200);
    if (!out.sourceId && !out.sourceKey) {
      throw bad("Each source must identify what it refers to.", {
        field, reason: "SOURCE_IDENTITY_REQUIRED",
      });
    }

    out.label = text(raw.label).slice(0, 300);

    const confidence = text(raw.confidence).toUpperCase() || "PROVISIONAL";
    if (!CostingVersion.SOURCE_CONFIDENCE.includes(confidence)) {
      throw bad("A source is either provisional or verified.", {
        field: `${field}.confidence`, reason: "CONFIDENCE_UNKNOWN",
        allowed: CostingVersion.SOURCE_CONFIDENCE,
      });
    }
    out.confidence = confidence;

    const facts = raw.snapshot;
    if (facts !== undefined && facts !== null) {
      if (!Array.isArray(facts)) {
        throw bad("A source snapshot must be a list.", { field: `${field}.snapshot`, reason: "NOT_A_LIST" });
      }
      if (facts.length > MAX_SNAPSHOT_FACTS) {
        throw bad(`A source may snapshot at most ${MAX_SNAPSHOT_FACTS} details.`, {
          field: `${field}.snapshot`, reason: "TOO_MANY",
        });
      }
      out.snapshot = facts.map((f, j) => parseSourceFact(f, `${field}.snapshot[${j}]`));
    } else {
      out.snapshot = [];
    }

    /* ── ONE CURRENCY PER VERSION ────────────────────────────────────────
       A version states its base currency; a snapshotted amount in a different
       one would need a rate, and FX policy is Finance's, in a later chunk.
       Refusing is honest. Converting silently would not be. */
    for (const f of out.snapshot) {
      if (f.money && f.money.currency !== baseCurrency) {
        throw bad(
          "A source amount must be in the costing's base currency until exchange-rate policy exists.",
          {
            field: `${field}.snapshot`, reason: "CURRENCY_MISMATCH",
            baseCurrency, found: f.money.currency,
          },
        );
      }
    }

    return out;
  });
}

/** The version's base currency: the caller's, validated, or the default. */
function parseBaseCurrency(input) {
  try {
    return parseCurrency(input, { required: false, field: "baseCurrency" }) || DEFAULT_CURRENCY;
  } catch (err) {
    if (err instanceof MoneyError) throw bad(err.message, err.details);
    throw err;
  }
}

/**
 * The whole `POST /api/costings` body, validated into exactly what is stored.
 *
 * Note what it does NOT return: no company, no actor, no status, no version
 * number. Those are server-derived, and there is no code path here that could
 * take them from a payload even if one were sent.
 */
function parseCreateRequest(body = {}) {
  const context = parseContext(body.context);
  const baseCurrency = parseBaseCurrency(body.baseCurrency);
  const sourceReferences = parseSourceReferences(body.sourceReferences, { baseCurrency });
  const contextSnapshot = parseContextSnapshot(body.contextSnapshot, { label: body.label });

  const note = text(body.note);
  if (note.length > 500) {
    throw bad("That note is too long.", { field: "note", reason: "TOO_LONG" });
  }

  return { context, contextSnapshot, baseCurrency, sourceReferences, note };
}

module.exports = {
  MAX_SNAPSHOT_FACTS, MAX_SOURCE_REFERENCES, MAX_CONTEXT_FACTS,
  parseContext, parseContextSnapshot, parseSourceReferences, parseSourceFact,
  parseBaseCurrency, parseCreateRequest,
};
