/**
 * The storage half of the Firestore facade.
 *
 * Split from `firestoreCompat.js` on purpose: that file holds the SEMANTICS —
 * what `update()` on a missing document must do, how a sentinel becomes an
 * operator, how a subcollection is addressed — and this one holds the driver
 * calls. The split is what lets every rule up there be tested against an
 * in-memory store, with no database and no network, which matters when the
 * rules decide who approves work.
 *
 * Two implementations, one interface:
 *
 *   `mongoStore(db)`   — the real one, a thin shell over the Node driver
 *   `memoryStore()`    — an exact-enough stand-in for tests
 */

/** Deep-ish clone so a caller cannot mutate what the store is holding. */
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

/* ── The real store ───────────────────────────────────────────────────────── */

function mongoStore(db, { client = null } = {}) {
  return {
    async findOne(collection, filter) {
      return db.collection(collection).findOne(filter);
    },

    async find(collection, filter, { sort = null, limit = null } = {}) {
      let cursor = db.collection(collection).find(filter);
      if (sort) cursor = cursor.sort(sort);
      if (limit != null) cursor = cursor.limit(limit);
      return cursor.toArray();
    },

    async replace(collection, id, doc) {
      await db
        .collection(collection)
        .replaceOne({ _id: id }, { ...doc, _id: id }, { upsert: true });
    },

    /**
     * Returns whether anything MATCHED, which is the fact the facade turns back
     * into Firestore's NOT_FOUND. An upsert that inserted counts as matched:
     * `set({merge:true})` is defined to create, and only `update()` passes
     * `upsert: false`.
     */
    async update(collection, id, update, { upsert = false } = {}) {
      if (Object.keys(update).length === 0) return { matched: true };
      const r = await db
        .collection(collection)
        .updateOne({ _id: id }, update, { upsert });
      return { matched: r.matchedCount > 0 || r.upsertedCount > 0 };
    },

    async delete(collection, id) {
      await db.collection(collection).deleteOne({ _id: id });
    },

    /**
     * All-or-nothing where the deployment can give it, in order where it
     * cannot.
     *
     * Multi-document transactions need a replica set — the same requirement
     * change streams carry, so on a correctly configured deployment this is
     * always the atomic path. Without a client (or on a standalone server) the
     * operations still run, in order, stopping at the first failure. The
     * difference is real and is why this does not pretend: a caller that needs
     * the guarantee can check `atomic` on the result.
     */
    async transaction(fn) {
      if (!client) return { atomic: false, value: await fn() };
      const session = client.startSession();
      try {
        let value;
        await session.withTransaction(async () => {
          value = await fn(session);
        });
        return { atomic: true, value };
      } finally {
        await session.endSession();
      }
    },
  };
}

/* ── The test store ───────────────────────────────────────────────────────── */

/**
 * An in-memory stand-in, faithful on the points the facade depends on:
 * matched-vs-not, upsert, operator application and sort/limit ordering.
 *
 * Deliberately NOT a full Mongo: it supports the operators this facade emits
 * and throws on anything else, so a rule that starts emitting something new
 * fails loudly here rather than passing a test it no longer exercises.
 */
function memoryStore(seed = {}) {
  const data = new Map();
  for (const [name, docs] of Object.entries(seed))
    data.set(name, new Map(docs.map((d) => [String(d._id), clone(d)])));

  const col = (name) => {
    if (!data.has(name)) data.set(name, new Map());
    return data.get(name);
  };

  const matches = (doc, filter) =>
    Object.entries(filter).every(([field, clause]) => {
      const value = field
        .split(".")
        .reduce((v, k) => (v == null ? undefined : v[k]), doc);
      if (clause === null || typeof clause !== "object" || Array.isArray(clause))
        return value === clause;
      return Object.entries(clause).every(([op, operand]) => {
        switch (op) {
          case "$eq":
            return Array.isArray(value) ? value.includes(operand) : value === operand;
          case "$ne":
            return value !== operand;
          case "$lt":
            return value < operand;
          case "$lte":
            return value <= operand;
          case "$gt":
            return value > operand;
          case "$gte":
            return value >= operand;
          case "$in":
            return Array.isArray(value)
              ? value.some((v) => operand.includes(v))
              : operand.includes(value);
          case "$nin":
            return !operand.includes(value);
          default:
            throw new Error(`memoryStore does not implement ${op}`);
        }
      });
    });

  const apply = (doc, update) => {
    for (const [op, fields] of Object.entries(update)) {
      for (const [field, operand] of Object.entries(fields)) {
        const path = field.split(".");
        const last = path.pop();
        let target = doc;
        for (const k of path) target = target[k] ??= {};
        switch (op) {
          case "$set":
            target[last] = operand;
            break;
          case "$unset":
            delete target[last];
            break;
          case "$inc":
            target[last] = (target[last] ?? 0) + operand;
            break;
          case "$addToSet": {
            const list = (target[last] ??= []);
            for (const v of operand.$each) if (!list.includes(v)) list.push(v);
            break;
          }
          case "$pull":
            target[last] = (target[last] ?? []).filter(
              (v) => !operand.$in.includes(v),
            );
            break;
          default:
            throw new Error(`memoryStore does not implement ${op}`);
        }
      }
    }
  };

  return {
    _data: data,

    async findOne(collection, filter) {
      for (const doc of col(collection).values())
        if (matches(doc, filter)) return clone(doc);
      return null;
    },

    async find(collection, filter, { sort = null, limit = null } = {}) {
      let out = [...col(collection).values()].filter((d) => matches(d, filter));
      if (sort)
        out.sort((a, b) => {
          for (const [field, dir] of Object.entries(sort)) {
            if (a[field] === b[field]) continue;
            return (a[field] > b[field] ? 1 : -1) * dir;
          }
          return 0;
        });
      if (limit != null) out = out.slice(0, limit);
      return out.map(clone);
    },

    async replace(collection, id, doc) {
      col(collection).set(String(id), { ...clone(doc), _id: String(id) });
    },

    async update(collection, id, update, { upsert = false } = {}) {
      if (Object.keys(update).length === 0) return { matched: true };
      const key = String(id);
      const existing = col(collection).get(key);
      if (!existing) {
        if (!upsert) return { matched: false };
        const created = { _id: key };
        apply(created, update);
        col(collection).set(key, created);
        return { matched: true };
      }
      apply(existing, update);
      return { matched: true };
    },

    async delete(collection, id) {
      col(collection).delete(String(id));
    },

    async transaction(fn) {
      /* No rollback in memory. Tests that need to observe a partial failure
         assert on what landed, which is the honest thing for a store that
         cannot undo. */
      return { atomic: false, value: await fn() };
    },
  };
}

module.exports = { memoryStore, mongoStore };
