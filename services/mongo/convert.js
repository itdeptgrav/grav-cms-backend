/**
 * Turning a Firestore document into a MongoDB document.
 *
 * The facade in `firestoreCompat.js` makes new code work. This makes the data
 * that is already there work — and it is the half that cannot be fixed later,
 * because once a value has been written wrongly there is nothing left saying
 * what it was supposed to be.
 *
 * ## What actually differs
 *
 * Firestore stores a handful of types that have no BSON equivalent, and one
 * that has an equivalent people get wrong:
 *
 * · **Timestamp** → a BSON `Date`. This is the one that matters. A Firestore
 *   `Timestamp` carries nanoseconds and answers `.toDate()`; a BSON `Date` is
 *   millisecond-precision and does not. The precision loss is real and
 *   accepted — nothing in this product measures sub-millisecond — but the
 *   missing `.toDate()` is a runtime throw at every call site that uses it,
 *   which is why the READ side of the facade has to hand back something that
 *   still answers it. Converting on the way in is not enough on its own.
 * · **DocumentReference** → its path string. A reference is a pointer into
 *   another collection; MongoDB has no such type, and the path is the only
 *   lossless thing to keep.
 * · **GeoPoint** → `{ latitude, longitude }`, which is what it already is.
 * · **Bytes / Buffer** → passed through; the driver stores BSON Binary.
 * · **`undefined`** → dropped. Firestore refuses `undefined` outright, so any
 *   that appears here came from application code and was never stored.
 *
 * ## What must NOT be touched
 *
 * Field NAMES. A key that begins with `$`, or contains a `.`, is illegal as a
 * top-level Mongo field name and it is tempting to rewrite it. Doing so
 * silently renames somebody's data. Instead those documents are REPORTED, so a
 * human decides — see `illegalKeys`.
 */

/** Firestore Timestamps are structural: `{_seconds, _nanoseconds}` or `.toDate`. */
function isTimestamp(v) {
  if (v === null || typeof v !== "object") return false;
  if (typeof v.toDate === "function" && typeof v.seconds === "number") return true;
  return (
    typeof v._seconds === "number" && typeof v._nanoseconds === "number"
  );
}

function timestampToDate(v) {
  if (typeof v.toDate === "function") return v.toDate();
  return new Date(v._seconds * 1000 + Math.floor(v._nanoseconds / 1e6));
}

/** A DocumentReference, however it arrived — live object or plain shape. */
function isDocumentReference(v) {
  return (
    v !== null &&
    typeof v === "object" &&
    typeof v.path === "string" &&
    typeof v.id === "string" &&
    typeof v.collection === "function"
  );
}

function isGeoPoint(v) {
  return (
    v !== null &&
    typeof v === "object" &&
    typeof v.latitude === "number" &&
    typeof v.longitude === "number" &&
    Object.keys(v).length === 2
  );
}

/**
 * One value, converted.
 *
 * `seen` guards against a cycle. Firestore cannot store one, but a document
 * assembled in memory before writing can carry one, and an unguarded recursion
 * there is a stack overflow rather than an error anybody can read.
 */
function convertValue(value, seen = new Set()) {
  if (value === undefined) return undefined;
  if (value === null) return null;

  if (value instanceof Date) return value;
  if (Buffer.isBuffer(value)) return value;

  if (isTimestamp(value)) return timestampToDate(value);
  if (isDocumentReference(value)) return value.path;
  if (isGeoPoint(value)) return { latitude: value.latitude, longitude: value.longitude };

  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("Cyclic value cannot be migrated");
    seen.add(value);
    /* `undefined` inside an array cannot be dropped — that would shift every
       index after it — so it becomes null, which is what Firestore would have
       refused to store in the first place. */
    const out = value.map((v) => {
      const c = convertValue(v, seen);
      return c === undefined ? null : c;
    });
    seen.delete(value);
    return out;
  }

  if (typeof value === "object") {
    if (seen.has(value)) throw new Error("Cyclic value cannot be migrated");
    seen.add(value);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const c = convertValue(v, seen);
      if (c !== undefined) out[k] = c;
    }
    seen.delete(value);
    return out;
  }

  /* Numbers, strings, booleans. `NaN` and `Infinity` are storable as BSON
     doubles and Firestore stores them too, so they pass through rather than
     being "corrected" into something nobody wrote. */
  return value;
}

/**
 * Field names MongoDB will not accept at any depth it matters.
 *
 * Reported, never rewritten: renaming somebody's field to make an import
 * succeed is a silent data change, and the import succeeding is worth less
 * than knowing about it.
 */
function illegalKeys(value, path = "", found = []) {
  if (value === null || typeof value !== "object" || value instanceof Date) return found;
  if (Buffer.isBuffer(value)) return found;
  if (Array.isArray(value)) {
    value.forEach((v, i) => illegalKeys(v, `${path}[${i}]`, found));
    return found;
  }
  for (const [k, v] of Object.entries(value)) {
    const here = path ? `${path}.${k}` : k;
    if (k.startsWith("$") || k.includes(".") || k === "") found.push(here);
    illegalKeys(v, here, found);
  }
  return found;
}

/**
 * A whole document, ready to insert.
 *
 * The id becomes `_id` verbatim — a string, never an ObjectId — so every id
 * already written into another document, a URL, a notification or the Mongo
 * side of the product still resolves. `_parentId` is set for a document that
 * came from a subcollection, which is how the flattening in `firestoreCompat`
 * finds it again.
 */
function toMongoDocument(id, data, { parentId = null } = {}) {
  const doc = convertValue(data ?? {}) ?? {};
  doc._id = String(id);
  if (parentId != null) doc._parentId = String(parentId);
  return doc;
}

module.exports = {
  convertValue,
  illegalKeys,
  isDocumentReference,
  isGeoPoint,
  isTimestamp,
  timestampToDate,
  toMongoDocument,
};
