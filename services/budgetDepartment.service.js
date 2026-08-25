/**
 * GRAV-CMS-BACKEND/services/budgetDepartment.service.js
 *
 * One department, one identity.
 *
 * ── THE DEFECT THIS EXISTS TO FIX ───────────────────────────────────────────
 * `items[].department`, `budgetRequests[].department` and the department-scope
 * owner are free text against a registry nothing seeds. So:
 *
 *     "Logistics"   "logistics"   "LOGISTICS "   "Logistics "
 *
 * are four departments in every roll-up, four rows on the Departments tab, and
 * four different answers to "does this voucher match this budget line?" in
 * budget control. Tolerable while department is a tag on a line; serious once
 * a department OWNS a budget (Chunk A's `scope: "department"`), because then
 * the typo is the identity of the envelope.
 *
 * ── WHAT NORMALISATION CAN AND CANNOT FIX ───────────────────────────────────
 * `slugify` folds case, surrounding and repeated whitespace, punctuation,
 * accents, and `&` vs `and`. It CANNOT fix a misspelling: "Logistcs" slugifies
 * to `logistcs`, which is honestly a different department as far as any
 * machine can tell. That is what the registry's `aliases[]` is for — a human
 * says once that `logistcs` means Logistics, and every past and future row
 * carrying it resolves correctly.
 *
 * ── WHY A NEW REGISTRY RATHER THAN AN EXISTING ONE ──────────────────────────
 * Three department-ish tables already exist and none of them fits:
 *
 *   AccessDepartment (`access_departments`)  IS seeded at boot and IS the
 *     org-wide master — but it registers LOGIN PORTALS (accountant, hr, qc,
 *     cutting-master), not cost departments, and it is deliberately global.
 *     Every accounting model is company-scoped; this one cannot gain a
 *     companyId without changing how people log in.
 *
 *   Acc_Department (`acc_departments`)  is the accountant LOGIN table. Its
 *     ~40 inbound refs are createdBy/approvedBy — they point at people.
 *
 *   Acc_CostCentre  is company-scoped and accounting-owned, but it is the
 *     PROJECT dimension that project-scope budgets will attribute spend
 *     through in a later chunk. Folding departments into it now would merge
 *     two dimensions that need to stay separable.
 *
 * ── WHAT IS AND IS NOT STORED ───────────────────────────────────────────────
 * Deliberately no new field on any budget subdocument. Writes canonicalise the
 * DISPLAY NAME (so a picked department is stored the registry's way), and
 * reads derive the slug. Legacy rows therefore keep working untouched and
 * group correctly the moment this ships, with no migration to get wrong.
 */

const { Acc_BudgetDepartment } = require("../models/Accountant_model/Acc_BudgetDepartment");
const actuals = require("./budgetActuals.service");

/**
 * A department name reduced to its identity.
 *
 * Pure and synchronous — the same input always gives the same slug, with no
 * registry involved. That matters: a legacy row whose department was never
 * registered still has to group with its own variants.
 *
 * Returns "" for anything empty, which callers read as "no department".
 */
function slugify(value) {
  if (value === null || value === undefined) return "";
  return (
    String(value)
      .normalize("NFD")
      /* Strip combining marks so "Opérations" and "Operations" are one
       * department rather than two that look identical on screen. */
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      /* "R&D" and "R and D" are the same department written two ways. Done
       * before punctuation is stripped, or the & would simply vanish and
       * "R&D" would become "rd". */
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
  );
}

/** Display form for a department nobody registered: trimmed, spaces collapsed,
 *  but otherwise exactly as it was typed. Normalising the CASE of an unknown
 *  department would be inventing a spelling for it. */
function displayOf(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

/**
 * A company's departments, loaded once, ready to resolve any spelling.
 *
 * One database read per request rather than one per line — a dashboard
 * resolves every line of every budget, and a per-line lookup would turn a
 * cheap normalisation into a hundred round trips.
 */
async function departmentResolver({ companyId } = {}) {
  const cid = actuals.oid(companyId);
  const rows = cid
    ? await Acc_BudgetDepartment.find({ companyId: cid }).lean()
    : [];

  /* Slug → canonical row, including every alias. A registered department is
   * reachable by its own slug and by any spelling someone has taught it. */
  const bySlug = new Map();
  for (const row of rows) {
    if (!row.slug) continue;
    bySlug.set(row.slug, row);
    for (const alias of row.aliases || []) {
      const a = slugify(alias);
      /* An alias never shadows a real department: if someone registers
       * "Admin" and someone else lists "admin" as an alias of Facilities, the
       * department itself wins. */
      if (a && !bySlug.has(a)) bySlug.set(a, row);
    }
  }
  /* A real department's own slug must win even when an alias was inserted
   * first, which the guard above cannot guarantee across two rows. */
  for (const row of rows) if (row.slug) bySlug.set(row.slug, row);

  /**
   * Any spelling → a stable identity.
   *
   * An UNREGISTERED department still resolves, to its own slug and its own
   * text. Free text keeps working, legacy rows keep displaying, and variants
   * of an unregistered name still group with each other — the registry
   * improves normalisation rather than being a precondition for it.
   */
  function resolve(value) {
    const slug = slugify(value);
    if (!slug) return null;
    const row = bySlug.get(slug);
    if (!row) {
      return { slug, name: displayOf(value), known: false, isActive: true };
    }
    return {
      slug: row.slug,
      name: row.name,
      known: true,
      /* Inactive is "do not offer this any more", never "stop reading rows
       * that reference it" — a closed department's past budgets must still
       * report. Callers decide what to do with the flag; nothing here drops a
       * row because of it. */
      isActive: row.isActive !== false,
    };
  }

  /** The stored display form for a value — canonical when the department is
   *  registered, as-typed when it is not. This is what writes persist. */
  const canonicalName = (value) => resolve(value)?.name ?? null;

  /** The identity two values are compared on. */
  const sameDepartment = (a, b) => {
    const x = resolve(a);
    const y = resolve(b);
    return !!x && !!y && x.slug === y.slug;
  };

  return {
    resolve,
    canonicalName,
    sameDepartment,
    /** Everything registered, for a picker. */
    list: () =>
      rows
        .map((r) => ({
          _id: r._id,
          slug: r.slug,
          name: r.name,
          aliases: r.aliases || [],
          isActive: r.isActive !== false,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    size: rows.length,
  };
}

module.exports = { slugify, displayOf, departmentResolver };
