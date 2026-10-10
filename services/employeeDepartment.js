"use strict";
/**
 * services/employeeDepartment.js — one department, not two.
 *
 * An Employee carries the same fact twice:
 *
 *   departmentId   a reference into `departments`   ← authoritative
 *   department     the department's NAME, free text ← a copy, for display
 *
 * Nothing kept the copy in step, so they drifted, and the two screens that
 * read them disagreed in front of the user: the detail view prints
 * `department` and the edit form drives its dropdown from `departmentId`. One
 * live record read
 *
 *   department:   "SAMPLING"      (a department that no longer exists)
 *   departmentId: 6a9bbee1…       → "R&D"
 *
 * so the profile said SAMPLING, you opened the editor and it said R&D, and
 * neither screen was lying about what it had been given.
 *
 * ── WHY THE COPY IS KEPT AT ALL ─────────────────────────────────────────────
 * Deleting `department` would be the clean fix and is not available: exports,
 * the ID card, payroll sheets, the attendance roster, the employee app and
 * several legacy queries read the string directly, and a reference needs a
 * populate every one of them would have to grow. So the copy stays and this
 * module makes it a DERIVED copy instead of an independently editable one:
 *
 *   • on every write that carries a departmentId, the name is re-derived from
 *     that department and whatever the client sent as `department` is
 *     overwritten (`syncDepartmentName`);
 *   • on read, a populated departmentId's name wins over the stored string
 *     (`departmentNameOf`), so records that drifted BEFORE this show the truth
 *     without anybody having to migrate them first.
 *
 * The id is authoritative in both directions, which is also what
 * services/approvalChain.service.js already decided for itself — its test is
 * literally "departmentId wins over the free-text name when both carry one".
 * This makes that the rule everywhere rather than one service's local opinion.
 */

/**
 * The department NAME to show for an employee record.
 *
 * @param {object} employee  an Employee, ideally with `departmentId` populated
 *   (`.populate("departmentId", "name …")`). An unpopulated ObjectId is not a
 *   name and is ignored rather than stringified into the UI.
 * @returns {string} the name, or "" when there is nothing to show.
 */
function departmentNameOf(employee) {
  if (!employee) return "";
  const ref = employee.departmentId;
  /* A populated document has `name`; a bare ObjectId does not. Checking for
     the FIELD rather than for a Mongoose type keeps this usable on `.lean()`
     results, on plain objects in tests, and on a hand-built payload. */
  if (ref && typeof ref === "object" && typeof ref.name === "string" && ref.name.trim()) {
    return ref.name.trim();
  }
  return typeof employee.department === "string" ? employee.department : "";
}

/**
 * Make `data.department` agree with `data.departmentId` before a write.
 *
 * Mutates and returns `data`, because every caller is already building an
 * update object and a copy would just be one more thing to remember to use.
 *
 * Three cases, and the third is the one that keeps imports working:
 *
 *   1. a departmentId that resolves  → the name is set from it, overwriting
 *      whatever the client sent. The client does not get a vote: a payload
 *      naming one department and referencing another is exactly the drift
 *      this exists to stop, and the reference is the half with integrity.
 *   2. a departmentId that resolves to nothing → left alone and reported, so a
 *      caller can refuse rather than silently blank somebody's department.
 *   3. NO departmentId but a department name → the id is filled in from the
 *      name when EXACTLY ONE department matches it, case- and
 *      whitespace-insensitively. Exactly one, because this database really
 *      does contain both "R&D" and "R & D"; guessing between them would be
 *      worse than leaving the record as it came in.
 *
 * @param {object} data   the create/update payload
 * @param {object} Department  the Department model (passed in so this module
 *   requires no model and stays trivially testable)
 * @returns {Promise<{changed:boolean, name:string, reason:string}>}
 */
async function syncDepartmentName(data, Department) {
  const out = { changed: false, name: "", reason: "" };
  if (!data || typeof data !== "object") {
    out.reason = "no payload";
    return out;
  }

  const id = data.departmentId;
  if (id) {
    const dept = await Department.findById(id).select("name").lean();
    if (!dept) {
      out.reason = "departmentId does not resolve";
      return out;
    }
    const name = String(dept.name || "").trim();
    out.name = name;
    out.reason = "derived from departmentId";
    if (data.department !== name) {
      data.department = name;
      out.changed = true;
    }
    return out;
  }

  const typed = typeof data.department === "string" ? data.department.trim() : "";
  if (!typed) {
    out.reason = "nothing to sync";
    return out;
  }

  /* Anchored and escaped: a department called "R&D" must not be matched by a
     regex built out of its own punctuation, and a name must not match a
     longer one that merely contains it. */
  const escaped = typed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = await Department.find({
    name: { $regex: `^\\s*${escaped}\\s*$`, $options: "i" },
  })
    .select("name")
    .limit(2)
    .lean();

  if (matches.length === 1) {
    data.departmentId = matches[0]._id;
    out.name = String(matches[0].name || "").trim();
    out.changed = true;
    out.reason = "id filled in from the name";
    return out;
  }

  out.name = typed;
  out.reason = matches.length ? "the name matches more than one department" : "no department has that name";
  return out;
}

module.exports = { departmentNameOf, syncDepartmentName };
