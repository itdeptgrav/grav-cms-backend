// Middlewear/auditTrail.js
//
// The floor under the change log: no write in a mounted department goes
// unrecorded, whether or not anybody remembered to log it.
//
// WHY THIS EXISTS ALONGSIDE recordChange()
// ----------------------------------------
// A route that calls `recordChange` writes a far better entry than this can. It
// has the document before and after, so it can say "Gross salary 25,000 →
// 30,000"; this middleware has only the request, so the best it can honestly
// say is "changed these fields, to these values". Hand-written entries are the
// goal and this does not replace them.
//
// It exists because the alternative to a floor is a history with holes in it,
// and a history with holes is worse than no history — it is read as complete.
// HR is twenty routers and ninety-odd write handlers; instrumenting all of them
// by hand leaves the next handler somebody adds silently unlogged, and nobody
// finds out until the day they need to know who changed something and the
// answer is nothing at all.
//
// So: the route logs if it can, and this logs if it did not.
//
// WHAT IT WILL NOT DO
// -------------------
//   * Log a failed write. The response status decides — a 4xx or 5xx changed
//     nothing, and recording it as a change is a lie that is hard to unpick
//     later.
//   * Log a HELD write. A 202 from the approval guard means the change was
//     queued, not applied; services/changeRequests records the submission
//     itself, and a second entry here would read as though it had landed.
//   * Log a read. GETs are untouched, and POSTs that are really reads
//     (search, export, report) are skipped by the same list the write guard
//     uses, so the two cannot disagree about what counts as a write.

"use strict";

const { recordChange } = require("../services/changeLog");
const { sectionForPath } = require("../services/auditSections");
const { READ_SHAPED } = require("./departmentWriteGuard");

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const ACTION_BY_METHOD = { POST: "create", PUT: "update", PATCH: "update", DELETE: "delete" };

/**
 * Request-body keys that describe the request rather than the record, and would
 * otherwise show up in every entry as though they had been edited.
 */
const NOISE = new Set([
  "_id", "id", "__v", "page", "limit", "sort", "order", "search", "q",
  "createdAt", "updatedAt", "token", "csrf", "signature",
]);

/**
 * The body, flattened to the same {path,from,to} shape a diff produces.
 *
 * `from` is deliberately left undefined: this middleware genuinely does not
 * know the previous value, and inventing one — reporting the old value as empty
 * — would make every fallback entry claim the field had been blank before. An
 * absent `from` renders as "set to X", which is exactly as much as is known.
 */
function fieldsFromBody(body, prefix = "", out = [], depth = 0) {
  if (!body || typeof body !== "object" || depth > 3 || out.length >= 60) return out;

  for (const [k, v] of Object.entries(body)) {
    if (out.length >= 60) break;
    if (!prefix && NOISE.has(k)) continue;
    const path = prefix ? `${prefix}.${k}` : k;

    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
      fieldsFromBody(v, path, out, depth + 1);
      continue;
    }
    if (Array.isArray(v)) {
      // Arrays are summarised rather than walked. A punch list or a 300-row
      // bulk payload expanded field-by-field turns one entry into three hundred
      // and buries the change it was meant to describe.
      out.push({ path, to: `${v.length} item${v.length === 1 ? "" : "s"}`, kind: "changed" });
      continue;
    }
    out.push({ path, to: v, kind: "changed" });
  }
  return out;
}

/**
 * A POST to `/:id/something` is an action on an existing record, not a create.
 * Same heuristic the write guard uses, for the same reason: an entry that says
 * "created leave" for an approval is actively misleading.
 */
function actionFor(req, path) {
  const method = req.method.toUpperCase();
  if (method !== "POST") return ACTION_BY_METHOD[method] || "other";

  const clean = path.split("?")[0];
  const segs = clean.split("/").filter(Boolean);
  const tail = segs[segs.length - 1] || "";
  if (/^(approve|accept|release)$/i.test(tail)) return "approve";
  if (/^(reject|decline|revoke|cancel)$/i.test(tail)) return "reject";
  if (/^(import|upload|bulk-import)$/i.test(tail)) return "import";

  // "…/<id>/<verb>" is an action on an existing record; "…/<collection>" is a
  // create. The test is whether the segment BEFORE the verb looks like an id —
  // matching any two trailing word segments instead calls a plain
  // `POST /api/hr/departments` an update, which is the collection name being
  // mistaken for a record.
  const parent = segs[segs.length - 2] || "";
  const parentIsId =
    /^[0-9a-f]{24}$/i.test(parent) ||
    /^\d+$/.test(parent) ||
    /^\d{4}-\d{2}(-\d{2})?$/.test(parent) ||
    /^[A-Z]{2}\d{3,}$/.test(parent); // biometric ids, e.g. GR0067
  return parentIsId ? "update" : "create";
}

function isReadShaped(path) {
  const p = String(path || "").toLowerCase().split("?")[0];
  return READ_SHAPED.some((frag) => p.includes(frag));
}

/**
 * The record's id, from the path.
 *
 * `req.params` is NOT reliable here: this middleware is mounted at the app
 * level, above every router, so params are populated by whichever route layer
 * matched afterwards and are reassigned per layer. Reading the path is the one
 * thing that means the same at request time and at response time. Only an id
 * SHAPED like one is taken — a trailing "release" or "bulk-reset" is a verb,
 * not a record, and filing an entry under it would invent a record that does
 * not exist.
 */
function idFromPath(path) {
  const segs = String(path || "").split("?")[0].split("/").filter(Boolean);
  for (let i = segs.length - 1; i >= 0 && i >= segs.length - 3; i -= 1) {
    const seg = segs[i];
    if (/^[0-9a-f]{24}$/i.test(seg)) return seg;        // Mongo ObjectId
    if (/^\d{4}-\d{2}-\d{2}$/.test(seg)) return seg;   // a date-keyed record
  }
  return "";
}

/**
 * Something a person recognises, dug out of whatever the route was given.
 * Falls back to the id, then to nothing — an entry with no label is still a
 * useful entry, and a made-up one is not.
 */
function labelFrom(req) {
  const b = req.body || {};
  return String(
    b.name ||
      b.fullName ||
      b.title ||
      b.employeeName ||
      [b.firstName, b.lastName].filter(Boolean).join(" ") ||
      b.employeeId ||
      b.code ||
      req.params?.id ||
      "",
  ).slice(0, 120);
}

/**
 * @param {string} departmentSlug  which department's history these belong to
 * @param {object} [opts]
 * @param {string} [opts.section]  override the path-resolved section
 * @param {string} [opts.entity]   override the path-resolved entity
 */
function auditTrail(departmentSlug, opts = {}) {
  const slug = String(departmentSlug || "").toLowerCase();

  return function auditTrailMiddleware(req, res, next) {
    if (READ_METHODS.has(req.method)) return next();

    const path = req.originalUrl || req.url || "";
    if (isReadShaped(path)) return next();

    // Captured now. By the time the response is on its way the body may have
    // been consumed, reassigned by a route, or mutated in place by validation —
    // and an entry built from a mutated body describes something nobody sent.
    const body = req.body && typeof req.body === "object" ? { ...req.body } : {};

    let done = false;
    const write = () => {
      if (done) return;
      done = true;

      // The route logged it properly. That entry is better than this one.
      if (req.__auditLogged) return;
      if (res.statusCode >= 400) return;
      // Held for approval — recorded by services/changeRequests, not applied.
      if (res.statusCode === 202) return;

      /* The response has to have actually gone out. `close` fires for an
         aborted connection too, where statusCode is still its default 200 and
         nothing was ever sent — which produced history entries for requests
         the client hung up on. */
      if (!res.writableEnded) return;

      const resolved = sectionForPath(path) || {};
      const section = req.auditSection || opts.section || resolved.section || "";
      const entity = req.auditEntity || opts.entity || resolved.entity || "";

      /* NO SECTION, NO ENTRY.
         --------------------
         The floor used to fall back to the word "record" and file the entry
         with no section, which produced a history full of lines reading
         "Created record" — true, useless, and impossible to attribute to a
         page. Worse, it swept up writes that are not business changes at all:
         sidebar pins, saved filters, nav preferences.

         A section is the definition of "something we keep history for". A path
         that maps to none is not an unrecorded change; it is a request we never
         decided to record. Mapping a new one is a line in
         services/auditSections.js — and the log line below is how anybody finds
         out that it needs one. */
      if (!section || !entity) {
        if (process.env.AUDIT_TRAIL_DEBUG) {
          console.debug(
            `[audit-trail] ${req.method} ${path} has no section — not recorded. ` +
              `Add a pattern to PATH_SECTIONS if this should be.`,
          );
        }
        return;
      }
      const action = actionFor(req, path);
      const fields = action === "delete" ? [] : fieldsFromBody(body);
      const entityId = idFromPath(path) || body._id || body.id || "";
      const label = labelFrom(req) || entityId;

      recordChange(req, {
        departmentSlug: slug,
        section,
        entity,
        entityId,
        entityLabel: label,
        action,
        fields,
        // Says plainly that this is the fallback. Somebody reading a history
        // should be able to tell an entry that knows what changed from one that
        // only knows what was sent.
        summary: `${
          { create: "Created", update: "Updated", delete: "Deleted", approve: "Approved", reject: "Rejected", import: "Imported" }[action] || "Changed"
        } ${entity}${label ? ` “${label}”` : ""}${
          fields.length ? ` — ${fields.length} field${fields.length === 1 ? "" : "s"} submitted` : ""
        }`,
      }).catch(() => {});
    };

    // `finish` rather than wrapping res.json: it fires for every kind of
    // response — json, send, sendFile, a redirect, a stream — so a route that
    // answers in some other way is still recorded. Wrapping one method logs
    // only the routes that happen to use it.
    res.on("finish", write);
    res.on("close", write);

    next();
  };
}

module.exports = auditTrail;
module.exports.fieldsFromBody = fieldsFromBody;
module.exports.actionFor = actionFor;
