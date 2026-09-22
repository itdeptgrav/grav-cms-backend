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
  /**
   * The driver only counts an operation as part of a transaction if it is
   * handed the session. Every method below therefore takes one and passes it
   * through.
   *
   * Leaving it out is not a loud failure — the reads and writes still succeed,
   * outside the transaction, and `withTransaction` commits an empty one. So
   * there is no rollback, no read-conflict detection, and every compare-and-set
   * in Cowork silently becomes a plain race. That is the worst shape a bug can
   * have: correct-looking under test, wrong only under concurrency.
   */
  const opts = (session, extra = {}) => (session ? { ...extra, session } : extra);

  return {
    async findOne(collection, filter, { session = null } = {}) {
      return db.collection(collection).findOne(filter, opts(session));
    },

    async find(collection, filter, { sort = null, limit = null, session = null } = {}) {
      let cursor = db.collection(collection).find(filter, opts(session));
      if (sort) cursor = cursor.sort(sort);
      if (limit != null) cursor = cursor.limit(limit);
      return cursor.toArray();
    },

    async replace(collection, id, doc, { session = null } = {}) {
      await db
        .collection(collection)
        .replaceOne({ _id: id }, { ...doc, _id: id }, opts(session, { upsert: true }));
    },

    /**
     * Returns whether anything MATCHED, which is the fact the facade turns back
     * into Firestore's NOT_FOUND. An upsert that inserted counts as matched:
     * `set({merge:true})` is defined to create, and only `update()` passes
     * `upsert: false`.
     */
    async update(collection, id, update, { upsert = false, session = null } = {}) {
      if (Object.keys(update).length === 0) return { matched: true };
      const r = await db
        .collection(collection)
        .updateOne({ _id: id }, update, opts(session, { upsert }));
      return { matched: r.matchedCount > 0 || r.upsertedCount > 0 };
    },

    async delete(collection, id, { session = null } = {}) {
      await db.collection(collection).deleteOne({ _id: id }, opts(session));
    },

    /**
     * Several writes to ONE collection as a single command.
     *
     * A batch used to be sent one operation at a time, each waiting for the
     * last, because that is the only shape a Firestore `WriteBatch` has. Over
     * a network that is a round trip per write: forty read receipts on one
     * conversation cost forty of them. `bulkWrite` is one command carrying the
     * same forty operations, and inside a session it is still all-or-nothing.
     *
     * Returns how many documents the update operations MATCHED, which is what
     * `firestoreCompat` turns back into Firestore's NOT_FOUND.
     */
    async bulk(collection, operations, { session = null } = {}) {
      if (operations.length === 0) return { matched: 0 };
      const r = await db
        .collection(collection)
        .bulkWrite(operations, opts(session, { ordered: true }));
      return { matched: (r.matchedCount || 0) + (r.upsertedCount || 0) };
    },

    /**
     * All-or-nothing, returning what the callback returned.
     *
     * **Returns the value itself, not a wrapper.** Firestore's `runTransaction`
     * resolves to whatever the callback returned, and ten call sites in this
     * backend use it directly — as a document id, as an HTTP status, as the
     * claimed/not-claimed answer to a race. Wrapping it in `{atomic, value}`
     * broke every one of them, quietly, since `{...}` is truthy.
     *
     * The session is passed to the callback so every operation inside can be
     * enrolled in the transaction. Atomicity is no longer reported as a
     * maybe: `coworkDbChoice` refuses to boot against anything that is not a
     * replica set, so by the time this runs the guarantee is already there.
     */
    async transaction(fn) {
      if (!client) return fn(null);
      const session = client.startSession();
      try {
        let value;
        await session.withTransaction(async () => {
          value = await fn(session);
        });
        return value;
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

    /**
     * The same contract as the real store, applied one at a time.
     *
     * There is nothing to batch in memory; what matters is that a test
     * exercising the fast path sees the same RESULT as the driver would
     * return, or the path that only runs in production is the untested one.
     */
    async bulk(collection, operations, _options = {}) {
      let matched = 0;
      for (const o of operations) {
        if (o.updateOne) {
          const r = await this.update(collection, o.updateOne.filter._id, o.updateOne.update, {
            upsert: o.updateOne.upsert === true,
          });
          if (r.matched) matched += 1;
        } else if (o.replaceOne) {
          await this.replace(collection, o.replaceOne.filter._id, o.replaceOne.replacement);
          matched += 1;
        } else if (o.deleteOne) {
          await this.delete(collection, o.deleteOne.filter._id);
        }
      }
      return { matched };
    },

    async transaction(fn) {
      /* No rollback in memory, and no session to hand out. Tests that need to
         observe a partial failure assert on what landed, which is the honest
         thing for a store that cannot undo. The RETURN SHAPE matches the real
         store — the callback's value — because that is what ten call sites
         depend on. */
      return fn(null);
    },
  };
}

module.exports = { memoryStore, mongoStore };
