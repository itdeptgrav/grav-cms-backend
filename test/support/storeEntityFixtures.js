"use strict";
/**
 * test/support/storeEntityFixtures.js — one representative pair of records in
 * EVERY Store & Purchase entity family.
 *
 * ── WHY A PAIR, AND WHY GENERATED ─────────────────────────────────────────
 * A single record cannot catch the failure that matters. "Pending purchase
 * orders" answered with the only purchase order there is looks right whether
 * the filter was applied or dropped. So every family gets two: one that
 * matches each filter the matrix will ask for, and one that does NOT — a
 * different status, a date outside the window — and the question fails if the
 * second one appears.
 *
 * The records are written from each entity's own declaration: its identity
 * paths, the enum values its own schema records, the date and text concepts
 * its catalogue publishes. Nothing here knows what a purchase order is, so a
 * family registered tomorrow is seeded by the same rules.
 *
 * Written through the raw collections on purpose. A goods receipt insisted on
 * by its schema needs a purchase order, which needs a supplier, a sequence
 * and a chain of approvals; seeding that chain would be testing the chain.
 * Every reader under test reads with `.find().lean()`, so what matters is the
 * shape on disk.
 */

const mongoose = require("mongoose");

const {
  ENTITY_SPECS, DEFINITIONS_BY_ENTITY,
} = require("../../services/storePurchaseUniversalContract");
const matrix = require("./storeQuestionMatrix");

const oid = () => new mongoose.Types.ObjectId();

/** Inside June 2026, and well outside it. */
const IN_WINDOW = new Date("2026-06-12T06:00:00.000Z");
const OUT_OF_WINDOW = new Date("2026-02-03T06:00:00.000Z");

/** Set a possibly-nested path on a plain object. */
function put(doc, path, value) {
  const parts = String(path).split(".");
  let node = doc;
  for (const part of parts.slice(0, -1)) {
    if (!node[part] || typeof node[part] !== "object") node[part] = {};
    node = node[part];
  }
  node[parts[parts.length - 1]] = value;
}

/**
 * A value this schema path will accept.
 *
 * Identity values must be DISTINCTIVE: the catalogue resolves a record by
 * matching what somebody typed against its identity fields, so two families
 * sharing a value would make an ambiguous question out of an exact one.
 */
function identityValue(spec, path, tag, index) {
  const schemaPath = spec.model.schema.path(path);
  const kind = schemaPath?.instance || "String";
  if (kind === "Number") return tag === "a" ? 101 : 202;
  if (kind === "Date") return tag === "a" ? IN_WINDOW : OUT_OF_WINDOW;
  if (kind === "ObjectId") return oid();
  if (kind === "Boolean") return tag === "a";
  const enums = schemaPath?.enumValues || [];
  if (enums.length) return enums[tag === "a" ? 0 : Math.min(1, enums.length - 1)];
  /* ── ONE VALUE PER FIELD, ONE TOKEN PER RECORD ──────────────────────
     Writing the same string into every identity field of a record makes an
     exact question ambiguous: the catalogue finds several identity FIELDS
     matching the words and refuses, correctly. Real records do not look
     like that, and a fixture that does tests the fixture.

     Each value nonetheless carries the RECORD's token, because which of a
     record's identity fields an answer prints is the catalogue's choice —
     `labelFor` takes the first non-empty one — and an assertion naming a
     specific field would be testing that choice rather than the answer. */
  return `${recordToken(spec, tag)}-${index + 1}`;
}

/**
 * The one string that means "this record", in any identity field it holds.
 *
 * Hyphen-free so it survives every tokenisation on the way to the answer.
 */
function recordToken(spec, tag) {
  /* Short, hyphen-free and unique per family: it has to read as ONE segment
     of a business reference, which is what a person types. A twenty-character
     word is not a reference anybody has ever issued. */
  const index = ENTITY_SPECS.findIndex((entry) => entry.id === spec.id);
  return `Q${String(index).padStart(2, "0")}${tag === "a" ? "A" : "B"}7731`;
}

/**
 * Every top-level path a unique index covers.
 *
 * Compound ones too: a unique `{companyId, goodsReceiptId}` collides for two
 * documents that both leave `goodsReceiptId` unset, and the pair is the whole
 * point of seeding two. Giving every covered field its own value per document
 * is generic; knowing which families index what is not.
 */
function uniquePaths(spec) {
  const out = new Set();
  for (const [fields, options] of spec.model.schema.indexes()) {
    if (!options?.unique) continue;
    for (const key of Object.keys(fields)) {
      if (key === "_id" || key === "companyId" || key.includes(".")) continue;
      out.add(key);
    }
  }
  for (const [path, schemaPath] of Object.entries(spec.model.schema.paths)) {
    if (schemaPath.options?.unique && !path.includes(".")) out.add(path);
  }
  return [...out];
}

/** The identity paths worth writing: the top-level, string-ish ones. */
function writableIdentity(spec) {
  return (spec.identityPaths || []).filter((path) => {
    if (String(path).includes(".")) return false;
    /* ── IT HAS TO BE A FIELD THE MODEL DECLARES ───────────────────────
         `resolveEntity` projects `identityPaths.filter(p => schema.path(p))`
         — a path the schema does not declare is never read, so writing one
         puts a value in the database that no reader can see. The first
         version of this fixture did exactly that for three families and
         then failed the product for not finding them. */
    const schemaPath = spec.model.schema.path(path);
    return Boolean(schemaPath) && ["String", "Number"].includes(schemaPath.instance);
  });
}

/**
 * Seed one family, and say what was written so the matrix can ask about it.
 *
 * Returns null when the family has no identity worth asking about — a
 * singleton settings document, or one whose only identity is an internal id.
 */
async function seedFamily(spec, companyId) {
  const identity = writableIdentity(spec);
  if (!identity.length) return null;

  const definitions = matrix.conceptsOf(spec.id);
  const status = matrix.statusConcept(definitions, spec);
  const date = matrix.dateConcept(definitions);
  const text = matrix.textConcept(definitions, spec);
  const enums = status ? (spec.model.schema.path(status.path)?.enumValues || []) : [];

  const build = (tag) => {
    const doc = { _id: oid(), createdAt: IN_WINDOW, updatedAt: IN_WINDOW };
    if (spec.model.schema.path("companyId")) doc.companyId = companyId;
    identity.forEach((path, index) => put(doc, path, identityValue(spec, path, tag, index)));
    /* Two different recorded statuses, so a status question has something to
       exclude. */
    if (status && enums.length > 1) put(doc, status.path, tag === "a" ? enums[0] : enums[1]);
    /* One date inside the window and one far outside it. */
    if (date) put(doc, date.path, tag === "a" ? IN_WINDOW : OUT_OF_WINDOW);
    if (text && !identity.includes(text.path)) {
      put(doc, text.path, `${spec.id}-${tag}-text`);
    }
    return doc;
  };

  const a = build("a");
  const b = build("b");
  /* ── A UNIQUE INDEX IS PART OF THE SHAPE ON DISK ───────────────────────
     Several of these collections carry a unique index on a field this
     seeding knows nothing about — `sourceEventId`, say — and two documents
     leaving it null collide. Giving every uniquely-indexed field its own
     value per document is the generic answer; guessing which field each
     family happens to index is not. */
  for (const doc of [a, b]) {
    for (const path of uniquePaths(spec)) {
      if (doc[path] !== undefined) continue;
      const schemaPath = spec.model.schema.path(path);
      doc[path] = schemaPath?.instance === "ObjectId"
        ? oid()
        : `${spec.id}-${doc === a ? "a" : "b"}-${path}-unique`;
    }
  }
  try {
    await mongoose.connection.collection(spec.model.collection.name).insertMany([a, b]);
  } catch (error) {
    /* A family whose shape cannot be written generically is reported as
       skipped, not silently dropped: an unreachable family has to be
       visible, and the suite fails if too many are. */
    return { entity: spec.id, failed: String(error?.message || error).slice(0, 160) };
  }

  const first = identity[0];
  return {
    entity: spec.id,
    collection: spec.model.collection.name,
    /* The exact value to TYPE, and the token to look for in the answer. */
    identity: String(a[first] ?? ""),
    other: String(b[first] ?? ""),
    /* The token is what an answer must name. Where the identity is a bare
       number the token IS that number, because that is what the catalogue
       prints for such a record and asserting on anything else would be
       asserting about the fixture rather than the answer. */
    token: /^\d+$/.test(String(a[first] ?? "")) ? String(a[first]) : recordToken(spec, "a"),
    otherToken: /^\d+$/.test(String(b[first] ?? "")) ? String(b[first]) : recordToken(spec, "b"),
    identityPath: first,
    statusValue: status && enums.length > 1 ? enums[0] : null,
    otherStatusValue: status && enums.length > 1 ? enums[1] : null,
    datePath: date?.path || null,
    dateInWindow: Boolean(date),
    ids: { a: a._id, b: b._id },
  };
}

/**
 * Words, not a reference — what a person types for a supplier or a material.
 *
 * Invented so no catalogue alias or status word is among them, and ending in
 * a plural on purpose: "DIBANKSH ENTERPRISES" was read as a LIST question by
 * the grammar, which is part of how it reached nothing.
 */
const NAME_WORDS = Object.freeze([
  "Dibrava Kestrel", "Fanorel Osprey", "Corvanth Ibis", "Melquor Plover",
]);
function nameFor(spec) {
  const index = ENTITY_SPECS.filter((entry) => entry.collectionOnly).findIndex((entry) => entry.id === spec.id);
  return `${NAME_WORDS[index % NAME_WORDS.length]} Enterprises`;
}

/** A document with distinct values in every uniquely-indexed field. */
function withUniques(spec, doc, tag) {
  for (const path of uniquePaths(spec)) {
    if (doc[path] !== undefined) continue;
    const schemaPath = spec.model.schema.path(path);
    doc[path] = schemaPath?.instance === "ObjectId" ? oid() : `${spec.id}-${tag}-${path}-unique`;
  }
  return doc;
}

/**
 * A record of every COLLECTION-ONLY family known by a NAME — and the same name
 * written on a record of another family.
 *
 * ── WHY THE SECOND RECORD ─────────────────────────────────────────────────
 * The catalogue-wide pass leaves collection-only families out, and the
 * palette asked them directly only when that pass found NOTHING. A supplier's
 * name is also on its purchase orders, so the pass found a purchase order, the
 * supplier was never asked, and "DIBANKSH ENTERPRISES" answered with an order.
 * A name nobody else records would have passed either way; the neighbour is
 * what makes this case able to fail.
 */
async function seedNamedRecords(seeded, companyId) {
  const neighbour = ENTITY_SPECS.find((spec) => (
    !spec.collectionOnly && !spec.singleton && seeded[spec.id]
      && writableIdentity(spec).length > 1
      && spec.model.schema.path(writableIdentity(spec)[1])?.instance === "String"
  ));
  for (const spec of ENTITY_SPECS.filter((entry) => entry.collectionOnly)) {
    const plan = seeded[spec.id];
    const [first] = writableIdentity(spec);
    if (!plan || !first || spec.model.schema.path(first)?.instance !== "String") continue;
    const name = nameFor(spec);
    const doc = withUniques(spec, { _id: oid(), createdAt: OUT_OF_WINDOW, updatedAt: OUT_OF_WINDOW }, "n");
    if (spec.model.schema.path("companyId")) doc.companyId = companyId;
    put(doc, first, name);
    // eslint-disable-next-line no-await-in-loop
    await mongoose.connection.collection(spec.model.collection.name).insertOne(doc);

    let maskedBy = null;
    if (neighbour) {
      const [own, named] = writableIdentity(neighbour);
      const index = ENTITY_SPECS.findIndex((entry) => entry.id === neighbour.id);
      const other = withUniques(neighbour, { _id: oid(), createdAt: OUT_OF_WINDOW, updatedAt: OUT_OF_WINDOW }, `m${spec.id}`);
      if (neighbour.model.schema.path("companyId")) other.companyId = companyId;
      put(other, own, `Q${String(index).padStart(2, "0")}M${spec.id.length}-1`);
      put(other, named, name);
      // eslint-disable-next-line no-await-in-loop
      await mongoose.connection.collection(neighbour.model.collection.name).insertOne(other);
      maskedBy = neighbour.id;
    }
    plan.name = name;
    plan.nameId = String(doc._id);
    plan.nameMaskedBy = maskedBy;
  }
}

/** Seed every family. Returns `{ companyId, seeded, skipped }`. */
async function seedEveryEntity({ companyId = oid() } = {}) {
  const seeded = {};
  const skipped = [];
  for (const spec of ENTITY_SPECS) {
    // eslint-disable-next-line no-await-in-loop
    const plan = await seedFamily(spec, companyId);
    if (plan?.failed) skipped.push({ entity: spec.id, why: plan.failed });
    else if (plan) seeded[spec.id] = plan;
    else skipped.push({ entity: spec.id, why: "no writable business identity" });
  }
  await seedNamedRecords(seeded, companyId);
  return { companyId, seeded, skipped };
}

module.exports = {
  seedEveryEntity, seedFamily, writableIdentity, uniquePaths, recordToken, oid,
  IN_WINDOW, OUT_OF_WINDOW,
};
