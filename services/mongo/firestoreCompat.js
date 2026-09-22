/**
 * The Firestore API, over MongoDB.
 *
 * ## Why a facade and not 504 rewrites
 *
 * The Cowork backend reaches Firestore from **504 call sites across 87 files**.
 * Rewriting each by hand is weeks of mechanical edits, and every one is a
 * chance to invert a condition or drop a field in code that decides who
 * approves work and what somebody is scored on. The failures would be silent
 * and scattered.
 *
 * The surface those sites actually use is small and was measured, not guessed:
 *
 *   `.collection` `.doc` `.get` `.set` `.update` `.add` `.delete`
 *   `.where` `.orderBy` `.limit` `.startAfter` `.batch` `runTransaction`
 *   `FieldValue.serverTimestamp/arrayUnion/arrayRemove/increment/delete`
 *   `.exists` `.data()` `.id` `.docs` `.empty` `.size`
 *
 * and, just as importantly, what it does NOT use: no `collectionGroup`, no
 * `onSnapshot` (the backend never listened — that is the browser's job, and it
 * is being replaced by change streams), no `count()`, no `offset`, no
 * `FieldPath`. Eight query operators in total.
 *
 * So this implements exactly that surface against MongoDB. The call sites keep
 * their code; one import changes. What cannot be emulated is made LOUD rather
 * than approximated — see "Deliberate refusals" below.
 *
 * ## The semantics that are easy to get wrong
 *
 * · **`snapshot.exists` is a PROPERTY, not a method.** Firestore's admin SDK
 *   exposes it as a getter, and this codebase has been bitten by the
 *   difference before — a `snap.exists()` reads fine and throws. It is a getter
 *   here too.
 * · **`update()` on a missing document must FAIL.** Firestore rejects with
 *   NOT_FOUND; Mongo's `updateOne` quietly matches nothing and reports success.
 *   Code that relies on the throw — and 218 update sites might — would silently
 *   stop noticing deleted records. So the miss is turned back into a throw.
 * · **`set()` replaces, `set(data, {merge:true})` merges.** Two different
 *   writes, and conflating them either loses fields or fails to clear them.
 * · **Document ids stay strings.** `_id` is the Firestore id verbatim rather
 *   than an ObjectId, so every id already stored in another document, in a URL,
 *   or in the Mongo side of the product still resolves after the migration.
 *
 * ## Subcollections
 *
 * Firestore nests (`cowork_tasks/{id}/chat/{msg}`); MongoDB does not. The nine
 * subcollections in use — chat, draft_chat, messages, dailyReports, sessions,
 * logs, reports, lines, events — are flattened to `<parent>__<child>` with the
 * parent recorded on each document as `_parentId`. Every read through a
 * subcollection reference scopes itself by that field automatically, so the
 * call sites cannot see the difference, and `{parent}__{child}` + `_parentId`
 * indexes exactly as a nested collection would have.
 */

const { convertValue } = require("./convert");
const { reviveTimestamps } = require("./timestamp");

const OPERATORS = {
  "==": (v) => ({ $eq: v }),
  "!=": (v) => ({ $ne: v }),
  "<": (v) => ({ $lt: v }),
  "<=": (v) => ({ $lte: v }),
  ">": (v) => ({ $gt: v }),
  ">=": (v) => ({ $gte: v }),
  in: (v) => ({ $in: v }),
  "not-in": (v) => ({ $nin: v }),
  /* Firestore's array-contains asks whether the array holds this value, which
     is precisely what an equality match on an array field means in Mongo. */
  "array-contains": (v) => ({ $eq: v }),
  "array-contains-any": (v) => ({ $in: v }),
};

/* ── Field sentinels ──────────────────────────────────────────────────────── */

const SENTINEL = Symbol("firestoreCompat.sentinel");

const FieldValue = {
  /**
   * A write-time timestamp.
   *
   * Firestore stamps this on the SERVER; here it is stamped in this process at
   * the moment the write is built. For a single self-hosted backend those are
   * the same clock, which is the whole reason it is acceptable — it would not
   * be across several machines with drifting clocks.
   */
  serverTimestamp: () => ({ [SENTINEL]: "serverTimestamp" }),
  arrayUnion: (...values) => ({ [SENTINEL]: "arrayUnion", values }),
  arrayRemove: (...values) => ({ [SENTINEL]: "arrayRemove", values }),
  increment: (by) => ({ [SENTINEL]: "increment", by }),
  delete: () => ({ [SENTINEL]: "delete" }),
};

const isOwnSentinel = (v) =>
  v !== null && typeof v === "object" && SENTINEL in v;

/**
 * The admin SDK's OWN sentinels, which this has to understand too.
 *
 * 239 write sites in this backend call `admin.firestore.FieldValue.serverTimestamp()`
 * rather than the `FieldValue` exported above — they were written against
 * Firestore and there was no reason for them to import anything else. Those
 * objects carry no symbol of ours, so without this they would fall through as
 * ordinary values and be stored verbatim: `serverTimestamp()` would persist as
 * `{}`, `increment(3)` as `{operand: 3}`, and every one of them would look like
 * a successful write.
 *
 * Recognised by constructor name and shape rather than `instanceof`, so this
 * module does not have to import firebase-admin. A facade that pulled in the
 * SDK it replaces would keep the dependency alive for ever and would break the
 * day Firebase is finally removed from the deployment.
 *
 * The five names are stable across firebase-admin v11-v13 and are verified
 * against the installed SDK by `adminSentinels.test.js` — if a future version
 * renames one, that test fails rather than the data going quietly wrong.
 */
function adminSentinel(v) {
  if (v === null || typeof v !== "object") return null;
  switch (v.constructor && v.constructor.name) {
    case "ServerTimestampTransform":
      return { kind: "serverTimestamp" };
    case "DeleteTransform":
      return { kind: "delete" };
    case "NumericIncrementTransform":
      return { kind: "increment", by: v.operand };
    case "ArrayUnionTransform":
      return { kind: "arrayUnion", values: v.elements };
    case "ArrayRemoveTransform":
      return { kind: "arrayRemove", values: v.elements };
    default:
      return null;
  }
}

/** One reading of a value, whichever FieldValue it came from. */
function readSentinel(v) {
  if (isOwnSentinel(v)) {
    const kind = v[SENTINEL];
    return { kind, by: v.by, values: v.values };
  }
  return adminSentinel(v);
}

const isSentinel = (v) => readSentinel(v) !== null;

/**
 * Turn a Firestore-shaped patch into a Mongo update document.
 *
 * Firestore mixes plain values and sentinels in one object; Mongo needs them
 * split across `$set`, `$unset`, `$inc`, `$addToSet` and `$pull`. Dotted keys
 * pass through untouched — both systems mean "the nested field" by them.
 */
function toUpdate(patch, { now = new Date() } = {}) {
  const $set = {};
  const $unset = {};
  const $inc = {};
  const $addToSet = {};
  const $pull = {};

  for (const [key, value] of Object.entries(patch ?? {})) {
    const sentinel = readSentinel(value);
    if (!sentinel) {
      /* Converted, not passed through. A caller can hand back a value it just
         READ — a Timestamp, most often — and storing that object literally
         would put `{seconds, nanoseconds}` in the database where a real date
         belongs, making it unqueryable and unsortable. `convertValue` turns it
         back into the BSON Date it came from. */
      $set[key] = convertValue(value);
      continue;
    }
    switch (sentinel.kind) {
      case "serverTimestamp":
        $set[key] = now;
        break;
      case "delete":
        $unset[key] = "";
        break;
      case "increment":
        $inc[key] = sentinel.by;
        break;
      case "arrayUnion":
        $addToSet[key] = { $each: sentinel.values };
        break;
      case "arrayRemove":
        $pull[key] = { $in: sentinel.values };
        break;
      default:
        throw new Error(`Unknown field sentinel: ${String(sentinel.kind)}`);
    }
  }

  const update = {};
  if (Object.keys($set).length) update.$set = $set;
  if (Object.keys($unset).length) update.$unset = $unset;
  if (Object.keys($inc).length) update.$inc = $inc;
  if (Object.keys($addToSet).length) update.$addToSet = $addToSet;
  if (Object.keys($pull).length) update.$pull = $pull;
  return update;
}

/**
 * A whole document for `set()` without merge — sentinels resolved, no operators.
 *
 * `arrayUnion` on a replacing `set` has nothing to union WITH, so it resolves
 * to the values themselves; that is what Firestore does too.
 */
function toDocument(data, { now = new Date() } = {}) {
  const out = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    const sentinel = readSentinel(value);
    if (!sentinel) {
      out[key] = convertValue(value);
      continue;
    }
    switch (sentinel.kind) {
      case "serverTimestamp":
        out[key] = now;
        break;
      case "delete":
        break; // absent, which is what deleting a field means on a fresh write
      case "increment":
        out[key] = sentinel.by;
        break;
      case "arrayUnion":
        out[key] = sentinel.values;
        break;
      case "arrayRemove":
        out[key] = [];
        break;
      default:
        throw new Error(`Unknown field sentinel: ${String(sentinel.kind)}`);
    }
  }
  return out;
}

/* ── Ids ──────────────────────────────────────────────────────────────────── */

const ID_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Firestore's own shape: 20 characters, so an auto-id looks like the old ones. */
function autoId(random = Math.random) {
  let out = "";
  for (let i = 0; i < 20; i += 1)
    out += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)];
  return out;
}

/* ── Snapshots ────────────────────────────────────────────────────────────── */

/**
 * The document as its author wrote it.
 *
 * `_id` and `_parentId` are storage and are removed. Every BSON `Date` becomes
 * a `CompatTimestamp`, because that is what Firestore returned and what ~12
 * call sites call `.toDate()` on — and what the browser reads as
 * `{_seconds, _nanoseconds}`. See `timestamp.js`.
 */
function strip(doc) {
  if (!doc) return undefined;
  const { _id, _parentId, ...rest } = doc;
  return reviveTimestamps(rest);
}

class DocumentSnapshot {
  constructor(id, doc, ref) {
    this.id = id;
    this.ref = ref;
    this._doc = doc ?? null;
  }
  /** A GETTER. `snap.exists()` throws, and that is the point — see the header. */
  get exists() {
    return this._doc !== null;
  }
  data() {
    return this._doc ? strip(this._doc) : undefined;
  }
  get(path) {
    return path
      .split(".")
      .reduce((v, k) => (v == null ? undefined : v[k]), this.data());
  }
}

class QuerySnapshot {
  constructor(docs) {
    this.docs = docs;
  }
  get empty() {
    return this.docs.length === 0;
  }
  get size() {
    return this.docs.length;
  }
  forEach(fn) {
    this.docs.forEach(fn);
  }
}

/* ── Queries ──────────────────────────────────────────────────────────────── */

class Query {
  constructor(store, collection, state = {}) {
    this._store = store;
    this._collection = collection;
    this._filter = state.filter ?? {};
    this._sort = state.sort ?? null;
    this._limit = state.limit ?? null;
    this._after = state.after ?? null;
  }

  _next(patch) {
    return new Query(this._store, this._collection, {
      filter: this._filter,
      sort: this._sort,
      limit: this._limit,
      after: this._after,
      ...patch,
    });
  }

  where(field, op, value) {
    const build = OPERATORS[op];
    if (!build)
      throw new Error(
        `Unsupported query operator "${op}". Supported: ${Object.keys(OPERATORS).join(", ")}`,
      );
    /* Merged rather than replaced, so two `where`s on one field both apply —
       `>= a` and `<= b` is a range, not the second overwriting the first. */
    const existing = this._filter[field];
    const clause = build(value);
    const merged =
      existing && typeof existing === "object" && !Array.isArray(existing)
        ? { ...existing, ...clause }
        : clause;
    return this._next({ filter: { ...this._filter, [field]: merged } });
  }

  orderBy(field, direction = "asc") {
    return this._next({
      sort: { ...(this._sort ?? {}), [field]: direction === "desc" ? -1 : 1 },
    });
  }

  limit(n) {
    return this._next({ limit: n });
  }

  /**
   * Only the snapshot form is supported, and only with a single `orderBy`.
   *
   * Firestore's cursors take either values or a snapshot and work across a
   * compound sort. Emulating that faithfully over Mongo needs a composite
   * comparison this codebase has exactly one caller for. Rather than write an
   * approximation that quietly pages wrongly, the unsupported shapes throw.
   */
  startAfter(cursor) {
    return this._cursor(cursor, false, "startAfter");
  }

  /** Inclusive: the row equal to the cursor is the first row returned. */
  startAt(cursor) {
    return this._cursor(cursor, true, "startAt");
  }

  _cursor(cursor, inclusive, name) {
    if (!this._sort || Object.keys(this._sort).length !== 1)
      throw new Error(`${name}() needs exactly one orderBy()`);
    const [field] = Object.keys(this._sort);
    const value =
      cursor instanceof DocumentSnapshot
        ? field === "_id"
          ? cursor.id
          : cursor.get(field)
        : cursor;
    return this._next({ after: { field, value, dir: this._sort[field], inclusive } });
  }

  async get() {
    const filter = { ...this._filter };
    if (this._after) {
      const desc = this._after.dir === -1;
      const op = this._after.inclusive
        ? desc ? "$lte" : "$gte"
        : desc ? "$lt" : "$gt";
      filter[this._after.field] = {
        ...(filter[this._after.field] ?? {}),
        [op]: this._after.value,
      };
    }
    const docs = await this._store.find(this._collection, filter, {
      sort: this._sort,
      limit: this._limit,
    });
    return new QuerySnapshot(
      docs.map(
        (d) =>
          new DocumentSnapshot(
            String(d._id),
            d,
            new DocumentReference(this._store, this._collection, String(d._id)),
          ),
      ),
    );
  }
}

/* ── References ───────────────────────────────────────────────────────────── */

class DocumentReference {
  /**
   * `parentId` is what makes a flattened subcollection hold together.
   *
   * It has to live on the DOCUMENT reference, not only on the collection that
   * made it: a write goes through `doc().set()`, and without the parent stamped
   * on that write the document lands in the shared physical collection carrying
   * no owner — invisible to its own subcollection's scoped read, and visible to
   * nobody else's either. It simply vanished. `add()` happened to work, which
   * is what made it look like subcollections worked at all.
   */
  constructor(store, collection, id, parentId = null, session = null) {
    this._store = store;
    this._collection = collection;
    this._parentId = parentId;
    this._session = session;
    this.id = id;
  }

  /**
   * The same reference, enrolled in a transaction.
   *
   * A reference created outside `runTransaction` and used inside it would read
   * and write outside the transaction — succeeding, and committing nothing.
   * The transaction object below binds every reference it is handed through
   * here, so a caller can go on building refs from `db.collection(...)` exactly
   * as it does with Firestore.
   */
  withSession(session) {
    return new DocumentReference(
      this._store,
      this._collection,
      this.id,
      this._parentId,
      session,
    );
  }

  /** The owner stamp, on every write this reference makes. */
  _own(doc) {
    return this._parentId ? { ...doc, _parentId: this._parentId } : doc;
  }

  /** A subcollection, flattened — see the note in the file header. */
  collection(name) {
    return new CollectionReference(
      this._store,
      `${this._collection}__${name}`,
      { parentId: this.id },
    );
  }


  async get() {
    const doc = await this._store.findOne(
      this._collection,
      { _id: this.id },
      { session: this._session },
    );
    return new DocumentSnapshot(this.id, doc, this);
  }

  async set(data, options = {}) {
    if (options.merge) {
      await this._store.update(
        this._collection,
        this.id,
        toUpdate(this._own(data)),
        { upsert: true, session: this._session },
      );
      return this;
    }
    await this._store.replace(
      this._collection,
      this.id,
      this._own(toDocument(data)),
      { session: this._session },
    );
    return this;
  }

  /**
   * Firestore fails on a missing document. Mongo does not, so the miss is
   * turned back into the failure the 218 call sites were written against.
   */
  async update(patch) {
    const result = await this._store.update(
      this._collection,
      this.id,
      toUpdate(patch),
      { upsert: false, session: this._session },
    );
    if (!result.matched) {
      const e = new Error(
        `No document to update: ${this._collection}/${this.id}`,
      );
      e.code = 5; // NOT_FOUND, the code the admin SDK uses
      throw e;
    }
    return this;
  }

  async delete() {
    await this._store.delete(this._collection, this.id, { session: this._session });
    return this;
  }
}

class CollectionReference extends Query {
  constructor(store, name, { parentId = null } = {}) {
    /* A subcollection reference is a query already scoped to its parent, so
       every read through it is confined without the caller doing anything. */
    super(store, name, parentId ? { filter: { _parentId: parentId } } : {});
    this.id = name;
    this._parentId = parentId;
  }

  doc(id) {
    return new DocumentReference(
      this._store,
      this._collection,
      id ?? autoId(),
      this._parentId,
    );
  }

  async add(data) {
    const ref = this.doc();
    await this._store.replace(this._collection, ref.id, ref._own(toDocument(data)));
    return ref;
  }
}

/* ── Batches ──────────────────────────────────────────────────────────────── */

/**
 * A batch, applied in order.
 *
 * Firestore's batch is atomic. This is atomic **only when the store is given a
 * session** — which needs a replica set, the same requirement change streams
 * carry. Without one it applies in order and stops at the first failure, which
 * is weaker, and `commit()` says so rather than letting a caller believe in a
 * guarantee it is not getting.
 */
class WriteBatch {
  constructor(store) {
    this._store = store;
    this._ops = [];
  }
  set(ref, data, options = {}) {
    this._ops.push({ kind: "set", ref, data, options });
    return this;
  }
  update(ref, patch) {
    this._ops.push({ kind: "update", ref, patch });
    return this;
  }
  delete(ref) {
    this._ops.push({ kind: "delete", ref });
    return this;
  }
  /**
   * Firestore resolves a batch to one `WriteResult` per operation. Returning a
   * count, or a `{atomic, value}` wrapper, is a different shape from the one
   * every caller was written against.
   */
  /**
   * Can this whole batch be sent as ONE command?
   *
   * Only when every write lands in the same collection, and only when the
   * batch is either all `update` or has no `update` at all. That second rule
   * is about one thing: `update()` must still fail on a missing document, and
   * `bulkWrite` reports one matched count for the whole command, not one per
   * operation. With nothing but updates the count is unambiguous — every one
   * of them had to match. Mix an upserting `set` into the same command and it
   * no longer is, so that batch takes the original path instead of guessing.
   *
   * Everything else — several collections, a mixture of kinds — is unchanged.
   */
  _bulkPlan() {
    if (this._ops.length < 2) return null;
    const collection = this._ops[0].ref._collection;
    if (!this._ops.every((o) => o.ref._collection === collection)) return null;
    const updates = this._ops.filter((o) => o.kind === "update").length;
    if (updates !== 0 && updates !== this._ops.length) return null;

    const operations = [];
    const mustMatch = [];
    for (const op of this._ops) {
      const ref = op.ref;
      if (op.kind === "delete") {
        operations.push({ deleteOne: { filter: { _id: ref.id } } });
      } else if (op.kind === "update") {
        const update = toUpdate(op.patch);
        /* An empty patch touches nothing and cannot fail — the store already
           treats it as matched, and bulkWrite would refuse it outright. */
        if (Object.keys(update).length === 0) continue;
        operations.push({ updateOne: { filter: { _id: ref.id }, update, upsert: false } });
        mustMatch.push(ref.id);
      } else if (op.options && op.options.merge) {
        const update = toUpdate(ref._own(op.data));
        if (Object.keys(update).length === 0) continue;
        operations.push({ updateOne: { filter: { _id: ref.id }, update, upsert: true } });
      } else {
        const doc = ref._own(toDocument(op.data));
        operations.push({
          replaceOne: { filter: { _id: ref.id }, replacement: { ...doc, _id: ref.id }, upsert: true },
        });
      }
    }
    return { collection, operations, mustMatch };
  }

  /**
   * Firestore resolves a batch to one `WriteResult` per operation. Returning a
   * count, or a `{atomic, value}` wrapper, is a different shape from the one
   * every caller was written against.
   */
  async commit() {
    return this._store.transaction(async (session) => {
      const plan = typeof this._store.bulk === "function" ? this._bulkPlan() : null;
      if (plan) {
        const { matched } = await this._store.bulk(plan.collection, plan.operations, { session });
        if (plan.mustMatch.length > 0 && matched < plan.mustMatch.length) {
          /* One of the updates had nothing to update. Which one costs a single
             extra read, and only on this path — the batch is inside the
             session, so throwing here rolls all of it back, exactly as a
             mid-batch NOT_FOUND did before. */
          const found = new Set(
            (
              await this._store.find(
                plan.collection,
                { _id: { $in: plan.mustMatch } },
                { session },
              )
            ).map((d) => d._id),
          );
          const missing = plan.mustMatch.find((id) => !found.has(id));
          const e = new Error(`No document to update: ${plan.collection}/${missing}`);
          e.code = 5; // NOT_FOUND, the code the admin SDK uses
          throw e;
        }
        return this._ops.map(() => ({ writeTime: new Date() }));
      }

      const results = [];
      for (const op of this._ops) {
        const ref = session ? op.ref.withSession(session) : op.ref;
        if (op.kind === "set") await ref.set(op.data, op.options);
        else if (op.kind === "update") await ref.update(op.patch);
        else await ref.delete();
        results.push({ writeTime: new Date() });
      }
      return results;
    });
  }
}

/* ── The database handle ──────────────────────────────────────────────────── */

/**
 * @param {object} store the storage adapter (see `mongoStore.js`), injected so
 *   every rule above can be tested without a database.
 */
function createFirestoreCompat(store) {
  return {
    collection: (name) => new CollectionReference(store, name),
    batch: () => new WriteBatch(store),
    /**
     * Resolves to what the callback returned — not a wrapper.
     *
     * Ten call sites use the value directly: a generated document id, an HTTP
     * status, the claimed/not-claimed answer to a race. A `{atomic, value}`
     * wrapper broke all of them silently, because an object is truthy.
     *
     * Every reference the callback touches is rebound to the session first, so
     * a ref built with the ordinary `db.collection(...).doc(...)` — which is
     * how all ten are written — actually takes part in the transaction rather
     * than running beside it.
     */
    runTransaction: (fn) =>
      store.transaction((session) => {
        const bind = (ref) => (session ? ref.withSession(session) : ref);
        return fn({
          get: (ref) => bind(ref).get(),
          /**
           * Several documents in one read, which `taskForward.js` uses to
           * verify a whole queue belongs to one person before renumbering it.
           * Firestore reads them at a single consistent point; the loop here is
           * inside the transaction, so it sees one snapshot too.
           */
          getAll: (...refs) => Promise.all(refs.flat().map((r) => bind(r).get())),
          set: (ref, data, options) => bind(ref).set(data, options),
          update: (ref, patch) => bind(ref).update(patch),
          delete: (ref) => bind(ref).delete(),
        });
      }),
    /* Deliberate refusals. Both are absent from this backend — measured, not
       assumed — and a silent approximation of either would be worse than a
       clear failure the day somebody reaches for one. */
    collectionGroup() {
      throw new Error(
        "collectionGroup() is not supported. Subcollections are flattened to `<parent>__<child>`; query that collection directly.",
      );
    },
  };
}

module.exports = {
  CompatTimestamp: require("./timestamp").CompatTimestamp,
  adminSentinel,
  readSentinel,
  FieldValue,
  CollectionReference,
  DocumentReference,
  DocumentSnapshot,
  QuerySnapshot,
  Query,
  WriteBatch,
  OPERATORS,
  autoId,
  createFirestoreCompat,
  isSentinel,
  strip,
  toDocument,
  toUpdate,
};
