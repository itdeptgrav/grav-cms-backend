"use strict";
// scripts/migrations/lib/indexPreflight.js
//
// IS THIS INDEX ALREADY THERE? — ANSWERED BY STRUCTURE, NOT BY NAME.
//
// ── THE DEFECT THIS EXISTS TO REMOVE ────────────────────────────────────────
// Every index migration here used to decide with `existing.some(i => i.name ===
// spec.name)`. A name is not an index. That comparison is wrong in both
// directions, and both directions hurt:
//
//   A different name, the same index. Somebody created the index by hand, or an
//   earlier `syncIndexes()` built it under Mongoose's generated name. The
//   preflight reports MISSING, an operator runs `--apply`, and the database ends
//   up with two identical indexes under two names — paying twice for every write
//   for the rest of the collection's life.
//
//   The same name, a different index. A name that matches while the key pattern,
//   uniqueness or partial filter does not is the dangerous case: the preflight
//   reports "present", `--apply` skips it, and everyone believes a constraint is
//   being enforced that is not there. For a UNIQUE index that belief is exactly
//   the one that lets duplicates accumulate silently.
//
// ── WHAT COUNTS AS THE SAME INDEX ───────────────────────────────────────────
// The key pattern INCLUDING FIELD ORDER — `{a:1,b:1}` and `{b:1,a:1}` are
// different indexes serving different queries — and the direction of each field,
// plus the three options that change what an index MEANS rather than how it is
// stored: `unique`, `partialFilterExpression` and `sparse`. Absent and false are
// the same thing for all three, because that is how the server reports them.
//
// Deliberately NOT compared: `background` (meaningless since 4.2), `v`, `ns`,
// `collation` and TTL — none of them are used by the specs this guards, and
// treating an unrelated difference as a conflict would block a correct migration.
// `expireAfterSeconds` IS compared, because a TTL index quietly deleting
// documents is not a thing to be wrong about.

/** Ordered key signature: field names, in order, each with its direction. */
function keySignature(key) {
  return Object.keys(key || {}).map((k) => `${k}:${normaliseDirection(key[k])}`).join(",");
}

/**
 * `1`, `-1`, `"2dsphere"`, `"text"` — compared as the server reports them, so a
 * numeric string from a hand-written script matches a number from a model.
 */
function normaliseDirection(v) {
  if (typeof v === "number") return String(v);
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : String(v);
}

/** Deterministic comparison of a filter document, whatever key order it arrived in. */
function canonicalJson(value) {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    /* A BSON value (ObjectId, Date) stringifies to itself; a plain object is
       sorted, so `{a:1,b:2}` and `{b:2,a:1}` are one filter. */
    if (typeof value.toJSON === "function" && !isPlainObject(value)) {
      return JSON.stringify(value.toJSON());
    }
    return `{${Object.keys(value).sort().map((k) => `${k}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isPlainObject(v) {
  return Object.prototype.toString.call(v) === "[object Object]"
    && (v.constructor === Object || v.constructor === undefined);
}

/** The meaning-bearing shape of one index, as a comparable string. */
function structureOf(spec) {
  const o = spec.options || spec;
  return [
    `key=${keySignature(spec.key)}`,
    `unique=${o.unique ? "1" : "0"}`,
    `sparse=${o.sparse ? "1" : "0"}`,
    `partial=${canonicalJson(o.partialFilterExpression)}`,
    `ttl=${o.expireAfterSeconds === undefined ? "" : String(o.expireAfterSeconds)}`,
  ].join(" ");
}

/** True when two index descriptions would behave identically. */
function sameStructure(a, b) {
  return structureOf(a) === structureOf(b);
}

/**
 * Compare one wanted index against what the collection actually has.
 *
 * @returns {object} one of three verdicts, and never a bare boolean:
 *   { state: "present",  matchedName }              — equivalent, build nothing
 *   { state: "missing" }                            — safe to build
 *   { state: "conflict", matchedName, differences } — the name is taken by a
 *       DIFFERENT index. Never built over: dropping an index to replace it is a
 *       decision for a person, on a database whose size and load they can see.
 */
function classify(spec, existing = []) {
  const wanted = structureOf(spec);

  /* Structure first, name second. An equivalent index under any name means the
     work is done, whatever it is called. */
  const equivalent = existing.find((i) => structureOf(i) === wanted);
  if (equivalent) {
    return {
      state: "present",
      matchedName: equivalent.name,
      renamed: equivalent.name !== spec.name,
      structure: wanted,
    };
  }

  const sameName = existing.find((i) => i.name === spec.name);
  if (sameName) {
    return {
      state: "conflict",
      matchedName: sameName.name,
      structure: wanted,
      found: structureOf(sameName),
      differences: differencesBetween(spec, sameName),
    };
  }

  return { state: "missing", structure: wanted };
}

/** Which properties differ, named, so a report can say what is wrong. */
function differencesBetween(wanted, found) {
  const out = [];
  const w = wanted.options || wanted;
  const f = found.options || found;
  if (keySignature(wanted.key) !== keySignature(found.key)) {
    out.push({ property: "key", wanted: keySignature(wanted.key), found: keySignature(found.key) });
  }
  for (const flag of ["unique", "sparse"]) {
    if (Boolean(w[flag]) !== Boolean(f[flag])) {
      out.push({ property: flag, wanted: Boolean(w[flag]), found: Boolean(f[flag]) });
    }
  }
  const wp = canonicalJson(w.partialFilterExpression);
  const fp = canonicalJson(f.partialFilterExpression);
  if (wp !== fp) out.push({ property: "partialFilterExpression", wanted: wp, found: fp });
  if (String(w.expireAfterSeconds ?? "") !== String(f.expireAfterSeconds ?? "")) {
    out.push({
      property: "expireAfterSeconds",
      wanted: w.expireAfterSeconds ?? null, found: f.expireAfterSeconds ?? null,
    });
  }
  return out;
}

/**
 * Survey a list of specs against a live database — READ ONLY.
 *
 * `db` is a driver `Db`. A collection that does not exist yet reports every index
 * as missing, which is true and is what creating them would resolve.
 */
async function surveyIndexes(db, specs) {
  const byCollection = new Map();
  const out = [];
  for (const spec of specs) {
    if (!byCollection.has(spec.collection)) {
      let existing = [];
      try {
        existing = await db.collection(spec.collection).indexes();
      } catch {
        /* No such collection. Nothing has been written to it. */
        existing = [];
      }
      byCollection.set(spec.collection, existing);
    }
    const verdict = classify(spec, byCollection.get(spec.collection));
    out.push({
      ...spec,
      ...verdict,
      /* Kept for every existing caller and report that reads `present`. It is
         now derived from structure, which is the whole point. */
      present: verdict.state === "present",
    });
  }
  return out;
}

/**
 * Build the ones that are missing. Conflicts are REFUSED, not resolved.
 *
 * Returns what it did and what it would not touch, so the caller's report can
 * state both rather than implying everything succeeded.
 */
async function buildMissing(db, rows) {
  const built = [];
  const refused = [];
  for (const r of rows) {
    if (r.state === "present") continue;
    if (r.state === "conflict") {
      refused.push({
        collection: r.collection, name: r.name, differences: r.differences,
      });
      continue;
    }
    await db.collection(r.collection).createIndex(r.key, { name: r.name, ...(r.options || {}) });
    built.push({ collection: r.collection, name: r.name });
  }
  return { built, refused };
}

/** One line per index, for a migration's own report. */
function renderRow(r) {
  if (r.state === "present") {
    return r.renamed
      ? `  present  ${r.collection}.${r.name}  (exists as "${r.matchedName}" — equivalent, nothing to build)`
      : `  present  ${r.collection}.${r.name}`;
  }
  if (r.state === "conflict") {
    const diffs = (r.differences || [])
      .map((d) => `${d.property}: want ${JSON.stringify(d.wanted)}, found ${JSON.stringify(d.found)}`)
      .join("; ");
    return `  CONFLICT ${r.collection}.${r.name}  — that name holds a DIFFERENT index (${diffs}). `
      + "Not built and not replaced: dropping an index is a person's decision.";
  }
  return `  MISSING  ${r.collection}.${r.name}`;
}

module.exports = {
  keySignature, canonicalJson, structureOf, sameStructure, classify,
  differencesBetween, surveyIndexes, buildMissing, renderRow,
};
