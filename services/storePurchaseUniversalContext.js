"use strict";

const { includesTerm } = require("./ai/semanticCatalogue");
const tenantContext = require("./storePurchase/tenantContext.service");
const { ENTITY_SPECS, CONTRACTS } = require("./storePurchaseUniversalContract");

const specById = new Map(ENTITY_SPECS.map((entry) => [entry.id, entry]));
const contractByEntity = new Map(CONTRACTS.map((contract) => [contract.id.split(".").pop(), contract]));
const catalogueRecognitionCache = new WeakMap();
const isImplicitlyRecognisable = (spec) => Boolean(spec && !spec.singleton && !spec.collectionOnly);

function valuesAtPath(value, path) {
  const parts = String(path || "").split(".").filter(Boolean);
  const visit = (current, index) => {
    if (current === null || current === undefined) return [];
    if (Array.isArray(current)) return current.flatMap((item) => visit(item, index));
    if (index >= parts.length) return [current];
    return visit(current[parts[index]], index + 1);
  };
  return visit(value, 0).filter((item) => item !== null && item !== undefined && item !== "");
}

function scopeFor(spec, user) {
  const ctx = user?.storePurchaseAccess;
  if (spec.model.schema.path("companyId")) {
    if (!ctx?.companyId) return null;
    return tenantContext.tenantFilter(ctx);
  }
  return {};
}

function identityValues(spec, record) {
  return spec.identityPaths.flatMap((path) => valuesAtPath(record, path))
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function safeLabel(spec, record) {
  return identityValues(spec, record)[0] || spec.label;
}

/* ── THE IDENTITY SPACE, KEPT FOR A SHORT WHILE ─────────────────────────
   A name nobody's vocabulary recognises is placed by reading every family's
   identity fields — 53 reads at once. Each is ~70 ms on its own; together,
   on the live cluster, the same pass measured anywhere from 0.3 s to 1.8 s,
   because the reads queue. And the palette asks it once per keystroke, each
   time for a different string, so the five-second per-message cache below
   never hit twice.

   What changes slowly is not the answer but the SPACE: which names and
   references exist in a company. So a caller may ask for that to be kept,
   per family and per tenant scope, for `STORE_IDENTITY_SPACE_CACHE_MS`
   (default 30 s) and matched in memory. The price, stated: a record created
   in the last half-minute may not be found BY BARE NAME through this pass.
   Opt-in — the assistant does not ask for it — and set the variable to 0 to
   turn it off. */
const IDENTITY_SPACE_MS = (() => {
  const configured = Number.parseInt(process.env.STORE_IDENTITY_SPACE_CACHE_MS, 10);
  return Number.isFinite(configured) && configured >= 0 ? configured : 30000;
})();
const identitySpace = new Map();

function identityRows(spec, scope, { cached = false } = {}) {
  const identityProjection = [...new Set(["_id", ...spec.identityPaths.filter((path) => spec.model.schema.path(path))])].join(" ");
  const read = () => spec.model.find(scope).select(identityProjection).limit(1000).lean();
  if (!cached || IDENTITY_SPACE_MS <= 0) return read();
  const key = `${spec.id}|${JSON.stringify(scope)}`;
  const hit = identitySpace.get(key);
  if (hit && hit.until > Date.now()) return hit.promise;
  /* `.exec()`: a Query is thenable, not a promise — handing out the Query
     itself would run it again for every caller that awaits it. */
  const promise = read().exec();
  /* A failed read is not an empty company. */
  promise.catch(() => identitySpace.delete(key));
  identitySpace.set(key, { until: Date.now() + IDENTITY_SPACE_MS, promise });
  if (identitySpace.size > 500) identitySpace.delete(identitySpace.keys().next().value);
  return promise;
}

async function resolveEntity({
  entity, user, message, subject, recognizedSubject, includeRecord = true, cached = false,
} = {}) {
  const spec = specById.get(entity);
  if (!spec) return { found: false, ambiguous: false, matches: [] };
  const scope = scopeFor(spec, user);
  if (scope === null) return { found: false, ambiguous: false, matches: [] };
  const contract = contractByEntity.get(entity);

  let winner = null;
  if (recognizedSubject?.found && recognizedSubject.entity === entity && recognizedSubject.recordId) {
    winner = { _id: recognizedSubject.recordId };
  } else if (spec.singleton) {
    winner = await spec.model.findOne(scope).select("_id").lean();
  } else {
    const searchText = [message, subject].filter(Boolean).join(" ");
    const rows = await identityRows(spec, scope, { cached });
    let longest = 0;
    const winners = [];
    for (const row of rows) {
      const matches = identityValues(spec, row).filter((value) => includesTerm(searchText, value));
      if (!matches.length) continue;
      const length = Math.max(...matches.map((value) => value.length));
      if (length > longest) {
        longest = length;
        winners.length = 0;
        winners.push(row);
      } else if (length === longest) winners.push(row);
    }
    if (winners.length > 1) {
      return {
        found: false,
        ambiguous: true,
        matches: winners.slice(0, 8).map((row) => safeLabel(spec, row)),
      };
    }
    [winner] = winners;
  }

  if (!winner) return { found: false, ambiguous: false, matches: [] };
  if (!includeRecord) {
    return {
      found: true,
      ambiguous: false,
      entity,
      recordId: String(winner._id),
      label: safeLabel(spec, winner),
    };
  }
  const record = await spec.model.findOne({ $and: [scope, { _id: winner._id }] })
    .select(`${contract.projection()} -_id`)
    .lean();
  if (!record) return { found: false, ambiguous: false, matches: [] };
  return {
    found: true,
    ambiguous: false,
    entity,
    recordId: String(winner._id),
    label: safeLabel(spec, record),
    record,
  };
}

/**
 * Resolve a business reference across the Store & Purchase catalogue once per
 * request user/message. This lets a real PO number, GRN number, document ref,
 * account name or lot label identify its entity without forcing the user to
 * also say the database/model type. The result contains only server-side ids
 * and labels and is never shown to Qwen.
 */
async function recogniseCatalogueEntity({ entity, user, message, cached = false } = {}) {
  if (!user || typeof user !== "object" || !String(message || "").trim()) return null;
  let cache = catalogueRecognitionCache.get(user);
  if (!cache) {
    cache = new Map();
    catalogueRecognitionCache.set(user, cache);
  }
  /* One key whether or not the identity space was cached: within a request
     the palette's pass and a reader's own recognition are the same question,
     and asking it twice was a second 53-read pass on every bare name. */
  const key = String(message).trim().toLowerCase();
  let entry = cache.get(key);
  if (!entry || entry.until < Date.now()) {
    const promise = Promise.all(ENTITY_SPECS.map(async (candidate) => {
      // Singleton settings rows are present by definition, not because the
      // user's words identify them. Treating existence as subject recognition
      // made every unrelated question look like both "production settings"
      // and "sales settings". Their exact entity/metric terms are already
      // handled by the tool's normal semantic match/claim path.
      if (!isImplicitlyRecognisable(candidate)) return null;
      const resolution = await resolveEntity({
        entity: candidate.id, user, message, includeRecord: false, cached,
      });
      return resolution && (resolution.found || resolution.ambiguous)
        ? { entity: candidate.id, resolution }
        : null;
    })).then((rows) => rows.filter(Boolean));
    entry = { promise, until: Date.now() + 5000 };
    cache.set(key, entry);
    if (cache.size > 50) cache.delete(cache.keys().next().value);
  }
  const matches = await entry.promise;
  if (!entity) return matches;
  const own = matches.find((match) => match.entity === entity);
  if (!own) return null;
  if (matches.filter((match) => match.resolution.found).length <= 1) return own.resolution;
  return {
    found: false,
    ambiguous: true,
    entity,
    matches: matches.filter((match) => match.resolution.found)
      .map((match) => `${match.entity}: ${match.resolution.label}`),
  };
}

/**
 * Which entity families a reference belongs to, if any.
 *
 * The same single cached pass `recogniseCatalogueEntity` already makes — it is
 * that function with no entity named, so nothing extra is read. It exists for
 * callers who have a business reference and no idea which kind of document it
 * is, which is exactly what somebody typing a number into a search box has.
 */
function recogniseAnyEntity({ user, message, cached = false } = {}) {
  return recogniseCatalogueEntity({ user, message, cached });
}

module.exports = {
  resolveEntity, recogniseCatalogueEntity, recogniseAnyEntity,
  valuesAtPath, scopeFor, identityValues, isImplicitlyRecognisable, identityRows,
};
