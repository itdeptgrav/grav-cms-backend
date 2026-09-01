// services/changeRequestDescribe.js
//
// Works out WHAT an editor is asking to change, so the approver's queue can
// say "Email: rutushree.ray@gravclothing.in → rutushree.ray@gmail.com" rather
// than "Change · employee".
//
// WHY THIS IS NOT A DETAIL
// ------------------------
// An approver is being asked to take responsibility for a change. A card that
// names only the entity gives them nothing to be responsible for — the honest
// response to it is to approve everything, which makes the queue theatre. The
// field list is the entire product.
//
// WHY IT IS GENERIC RATHER THAN PER-ROUTE
// ---------------------------------------
// `departmentWrites` is mounted per department, above every route in it — HR
// alone is twenty-odd routers. A describe() written per route would be missing
// from whichever route somebody adds next, which is the same reason the guard
// itself is mount-level. So this reads the request the way the audit trail
// does: resolve the record from the path, diff the submitted body against it,
// label the paths with the same table the change history uses.
//
// TWO THINGS IT DELIBERATELY WILL NOT DO
// --------------------------------------
// 1. It never diffs a field the editor did not submit. A PUT body is usually
//    partial, and diffing the whole document against it would report every
//    absent field as deleted — an approver reading "Salary: 42000 → (empty)"
//    on an email change would be right to refuse it, and wrong. Only keys
//    PRESENT in the body are compared.
// 2. It never blocks the write. Every failure path returns what it has, or
//    nothing. A held change with a bare card is a worse queue entry; a 500
//    because a describe() threw is a broken department.

"use strict";

const { fieldDiff } = require("./changeLog");
const { fieldLabel } = require("./auditSections");
const ChangeLog = require("../models/Access/ChangeLog");

/** Detail beyond this is noise on a card — the full diff lands in the log. */
const MAX_CHANGES = 25;

/** Bookkeeping the editor did not type and an approver does not want to read. */
const NOISE = new Set([
  "_id",
  "id",
  "__v",
  "createdAt",
  "updatedAt",
  "updatedBy",
  "createdBy",
  "modifiedAt",
  "lastModified",
]);

/**
 * Path prefix -> the collection it writes to, for reading the BEFORE values.
 *
 * Lazy `require`s: this module is loaded by the write guard at boot, and
 * pulling twenty models in at that point would cost every restart whether or
 * not anybody ever holds a change.
 *
 * An unlisted path is not an error — see describeChange's fallback. Adding a
 * row here upgrades that path from "here is what they submitted" to "here is
 * what it would replace", which is worth one line but is not worth guessing:
 * a wrong model reports the wrong before-value, which is worse than none.
 */
const REGISTRY = [
  {
    match: "/api/employees",
    model: () => require("../models/Employee"),
    label: personName,
    // Salary is encrypted at rest (utils/salaryEncryption.js) and the form
    // submits the plaintext it was shown. Comparing the two makes every salary
    // field look changed on every save — eleven rows of
    // "Gross salary: enc:f856bc… → 19227" beside a one-field email edit.
    normalise: (doc) => require("../utils/salaryEncryption").decryptEmployeeDoc(doc),
  },
  {
    match: "/api/hr/departments",
    model: () => require("../models/HR_Models/Departments"),
    label: (d) => d.name || d.departmentName || "",
  },
  {
    match: "/api/hr/candidates",
    model: () => require("../models/HR_Models/Candidates"),
    label: personName,
  },
  {
    match: "/api/hr/job-postings",
    model: () => require("../models/HR_Models/JobPosting"),
    label: (d) => d.title || d.position || "",
  },
  {
    match: "/api/hr/documents",
    model: () => require("../models/HR_Models/EmployeeDocument"),
    label: (d) => d.documentName || d.title || d.type || "",
  },
];

function personName(d) {
  const name =
    d.name ||
    [d.firstName, d.lastName].filter(Boolean).join(" ").trim() ||
    d.fullName ||
    "";
  // biometricId, not employeeId: `employeeId` is a VIRTUAL on the Employee
  // schema aliasing biometricId, and virtuals do not exist on a .lean()
  // document or in a .select() projection. Reading it off a lean query is
  // always undefined — silently, which is why an employee code never
  // appeared here.
  const code = d.biometricId || d.employeeId || "";
  return code ? `${name || code} (${code})` : name;
}

/**
 * The record's id, taken from the path.
 *
 * Written to match a 24-character ObjectId or a GRAV employee code rather than
 * "the last segment", because half these routes end in an action — `/:id/void`,
 * `/:id/approve` — and taking the last segment would look the record up by the
 * word "approve".
 */
function idFromPath(path) {
  const segments = String(path || "").split("?")[0].split("/").filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const seg = segments[i];
    if (/^[0-9a-f]{24}$/i.test(seg) || /^(GR|E)\d{3,}$/i.test(seg)) return seg;
  }
  return "";
}

function entryFor(path) {
  const p = String(path || "").toLowerCase();
  // Longest match wins: /api/hr/documents must not be answered by a shorter
  // prefix that happens to also match.
  return REGISTRY.filter((r) => p.includes(r.match)).sort(
    (a, b) => b.match.length - a.match.length,
  )[0];
}

/** Load the record being changed, or null. Never throws. */
async function loadBefore(path) {
  const entry = entryFor(path);
  const id = idFromPath(path);
  if (!entry || !id) return { doc: null, entry: entry || null };
  try {
    const Model = entry.model();
    let doc = /^[0-9a-f]{24}$/i.test(id)
      ? await Model.findById(id).lean()
      : await Model.findOne({ biometricId: id }).lean();
    // Bring the stored record into the same terms the form submits in — see
    // the note on the Employee entry above.
    if (doc && entry.normalise) {
      try {
        doc = entry.normalise(doc) || doc;
      } catch (err) {
        console.warn("[change-requests] could not normalise the record:", err.message);
      }
    }
    return { doc: doc || null, entry };
  } catch (err) {
    console.warn(
      "[change-requests] could not read the record being changed:",
      err.message,
    );
    return { doc: null, entry };
  }
}

/**
 * Build the {field, from, to} rows the approval card renders.
 *
 * `before` may be null — for a create, and for any path not in REGISTRY. Then
 * every submitted value is shown with no from-value, which reads correctly as
 * "this is what it will be set to" rather than pretending nothing was there.
 */
function changesFrom(section, before, body) {
  const rows = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) return rows;

  for (const key of Object.keys(body)) {
    if (rows.length >= MAX_CHANGES) break;
    if (NOISE.has(key)) continue;

    // Only this key's subtree, so a partial body cannot report the fields it
    // omitted as removals. See the header note.
    const diffs = fieldDiff(before ? before[key] : undefined, body[key], {
      prefix: key,
    });
    for (const d of diffs) {
      if (rows.length >= MAX_CHANGES) break;

      // JSON cannot express `undefined`, so an undefined AFTER value always
      // means the body simply did not carry that field — never that the editor
      // cleared it. (Clearing sends null or "".) The top-level loop above
      // already skips unsubmitted keys; this catches the same thing one level
      // down, where a form posts `primaryManager: { name }` and omits
      // `managerId`. Reporting those as removals is how a one-field edit grew
      // into twenty-five rows.
      if (d.to === undefined) continue;

      const label = fieldLabel(section, d.path);
      rows.push({
        // `field` is what the approval card prints; `path`/`label` are what the
        // change log stores when this submission is recorded. See the note on
        // the changes sub-schema in models/Access/ChangeRequest.js.
        field: label,
        path: d.path,
        label,
        from: ChangeLog.sanitiseValue(d.path, before ? d.from : undefined),
        to: ChangeLog.sanitiseValue(d.path, d.to),
      });
    }
  }
  return rows;
}

/** One line for the approver, naming the fields rather than counting them. */
function summaryFrom(rows, action) {
  if (!rows.length) return "";
  const verb =
    action === "create" ? "Adding" : action === "delete" ? "Removing" : "Changing";
  const names = rows.map((r) => r.field);
  const shown = names.slice(0, 3).join(", ");
  const rest = names.length - 3;
  return `${verb} ${shown}${rest > 0 ? ` and ${rest} more` : ""}.`;
}

/**
 * The describe() hook handed to departmentWrites.
 *
 * @param {string} action  "create" | "update" | "delete" — what the queue will
 *                         call it, so the summary agrees with the chip beside it.
 * @returns {function} (req) => { entityId, entityLabel, summary, changes }
 */
function describeChange(action) {
  return async function describe(req) {
    const path = req.originalUrl || req.url || "";
    const section = req.auditSection || "";

    const { doc } = await loadBefore(path);

    // A delete submits nothing, so there is no diff to show. Naming the record
    // is the whole of what an approver needs.
    const changes = action === "delete" ? [] : changesFrom(section, doc, req.body);

    const entry = entryFor(path);
    let entityLabel = "";
    if (doc && entry?.label) {
      try {
        entityLabel = String(entry.label(doc) || "").trim();
      } catch {
        /* a label is a nicety; never let it cost the card */
      }
    }

    return {
      entityId: idFromPath(path) || String(req.params?.id || ""),
      entityLabel,
      summary: summaryFrom(changes, action),
      changes,
    };
  };
}

module.exports = describeChange;
module.exports.idFromPath = idFromPath;
module.exports.changesFrom = changesFrom;
module.exports.summaryFrom = summaryFrom;
module.exports.REGISTRY = REGISTRY;
