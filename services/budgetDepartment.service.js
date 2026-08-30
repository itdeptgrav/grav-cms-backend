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
          /* The access link. Carried here because this list IS what the
             mapping screen renders — without it every row read as unlinked
             whatever was actually stored. */
          accessSlug: r.accessSlug || null,
          isActive: r.isActive !== false,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    size: rows.length,
  };
}

/**
 * Which budget departments a login portal may propose budget for.
 *
 * ── WHY THIS IS A LOOKUP AND NOT A NAME MATCH ───────────────────────────────
 * A portal slug ("sales") and a budget department slug ("logistics") are
 * different vocabularies — see accessSlug on Acc_BudgetDepartment. Matching
 * them by name would work often enough to be trusted and then quietly let one
 * department propose as another. So the link is stored, and a portal with no
 * linked department gets an empty list rather than a guess.
 *
 * Returns [] for a missing company or portal, which every caller must read as
 * "propose nothing" — never as "propose for anything".
 */
async function departmentsForAccessSlug({ companyId, accessSlug }) {
  const cid = actuals.oid(companyId);
  const slug = String(accessSlug ?? "").trim().toLowerCase();
  if (!cid || !slug) return [];

  const rows = await Acc_BudgetDepartment.find({
    companyId: cid,
    accessSlug: slug,
    isActive: { $ne: false },
  })
    .select("_id slug name aliases")
    .lean();

  return rows.map((r) => ({
    _id: r._id,
    slug: r.slug,
    name: r.name,
    aliases: r.aliases || [],
  }));
}

/**
 * The same lookup for SEVERAL access slugs at once.
 *
 * The standalone Budget app needs this: a user reaching `/budget` from the
 * launcher is not "in" one portal, so their entitlement is the union of every
 * department they are granted — see grantedAccessSlugs in
 * routes/Access/budgetProposals.js.
 *
 * Fails closed exactly as the single-slug version does: no slugs in, nothing
 * out. Blank and duplicate slugs are dropped rather than queried, so an empty
 * grant list can never widen into `{ accessSlug: { $in: [""] } }`.
 */
async function departmentsForAccessSlugs({ companyId, accessSlugs }) {
  const cid = actuals.oid(companyId);
  const slugs = [
    ...new Set(
      (Array.isArray(accessSlugs) ? accessSlugs : [])
        .map((v) => String(v ?? "").trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (!cid || slugs.length === 0) return [];

  const rows = await Acc_BudgetDepartment.find({
    companyId: cid,
    accessSlug: { $in: slugs },
    isActive: { $ne: false },
  })
    .select("_id slug name aliases accessSlug")
    .lean();

  return rows.map((r) => ({
    _id: r._id,
    slug: r.slug,
    name: r.name,
    aliases: r.aliases || [],
    accessSlug: r.accessSlug || null,
  }));
}

/**
 * Budget departments named DIRECTLY on an access grant, by their own slug.
 *
 * ── WHY THIS EXISTS ALONGSIDE departmentsForAccessSlugs ─────────────────────
 * That function answers "which budget departments has finance linked to the
 * portal this person signs into" — an indirection that has to be set up twice:
 * once to give somebody the Budget app, once more to link a portal to a
 * department. Granting the app was not enough, and the person was told their
 * account was "not linked" with no way to tell what was missing.
 *
 * This one answers the question the grant itself now carries: which budget
 * departments was this person actually given. One grant, one setup step.
 *
 * Company-scoped like everything here, so a slug granted in one company's
 * books can never resolve in another's. Fails closed on an empty list for the
 * same reason: an empty `$in` must never widen into everything.
 */
async function departmentsForSlugs({ companyId, slugs }) {
  const cid = actuals.oid(companyId);
  const wanted = [
    ...new Set(
      (Array.isArray(slugs) ? slugs : [])
        .map((v) => String(v ?? "").trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (!cid || wanted.length === 0) return [];

  const rows = await Acc_BudgetDepartment.find({
    companyId: cid,
    slug: { $in: wanted },
    isActive: { $ne: false },
  })
    .select("_id slug name aliases accessSlug")
    .lean();

  return rows.map((r) => ({
    _id: r._id,
    slug: r.slug,
    name: r.name,
    aliases: r.aliases || [],
    accessSlug: r.accessSlug || null,
  }));
}

/**
 * The departments a person was granted, as budget departments.
 *
 * ── WHY THIS READS THE ACCESS LIST AND NOT THE FINANCE REGISTRY ─────────────
 * A budget department used to have to exist in `Acc_BudgetDepartment` before
 * anybody could be given it, and finance had to link it to a portal on a
 * separate screen. That was two setup steps in two consoles for one question —
 * "may Rakesh submit budget for Logistics" — and it is the reason granting the
 * app appeared to do nothing.
 *
 * The company's own departments are the source now. `Acc_BudgetDepartment` is
 * still consulted when a row happens to exist, purely for its display name and
 * aliases, so books that already say "Logistics" keep saying it. A missing row
 * is not an error and never blocks access: the access grant is the authority.
 *
 * Fails closed on an empty grant, and drops the two slugs that are apps rather
 * than cost centres, so a grant can never widen into everything.
 */
async function budgetDepartmentsForGrant({ companyId, slugs }) {
  const wanted = [
    ...new Set(
      (Array.isArray(slugs) ? slugs : [])
        .map((v) => String(v ?? "").trim().toLowerCase())
        .filter(Boolean)
        .filter((v) => v !== "budget" && v !== "platform-admin"),
    ),
  ];
  if (wanted.length === 0) return [];

  const AccessDepartment = require("../models/Access/AccessDepartment");
  const [access, registered] = await Promise.all([
    AccessDepartment.find({ slug: { $in: wanted }, isActive: true, budgetEnabled: { $ne: false } })
      .select("slug name")
      .lean(),
    /* Company-scoped, and only for the nicer name. A department granted in
       Access Control but never registered in these books still resolves. */
    actuals.oid(companyId)
      ? Acc_BudgetDepartment.find({
          companyId: actuals.oid(companyId),
          slug: { $in: wanted },
          isActive: { $ne: false },
        })
          .select("_id slug name aliases accessSlug")
          .lean()
      : [],
  ]);

  const byRegistered = new Map(registered.map((r) => [r.slug, r]));
  return access.map((a) => {
    const hit = byRegistered.get(a.slug);
    return {
      _id: hit?._id ?? null,
      slug: a.slug,
      name: hit?.name || a.name,
      aliases: hit?.aliases || [],
      accessSlug: hit?.accessSlug || null,
    };
  });
}

/**
 * THE CALLER'S OWN DEPARTMENT, FROM HR.
 *
 * ── WHAT THIS REPLACED, AND WHY ─────────────────────────────────────────────
 * A person used to reach the Budget app's data through ACCESS CONTROL: either
 * a grant naming budget departments directly ("can submit budget for HR"), or
 * an older indirection where finance mapped a login portal to a budget
 * department through `Acc_BudgetDepartment.accessSlug`.
 *
 * Both asked an administrator to state, by hand, a fact HR already holds:
 * which department this person is in. Two records of one truth, kept in step
 * by nobody — and when they disagreed the app either showed somebody another
 * department's budget or told a correctly-employed person their account was
 * not linked. The second is what happened here: the grant was set, the
 * registry it resolved against was empty, and the app resolved nothing for
 * anyone.
 *
 * So the department comes from the employee record now. HR sets it when
 * somebody joins and changes it when they move, which is exactly when the
 * answer should change, and there is no second place to forget.
 *
 * ── departmentId FIRST, THE STRING AS FALLBACK ──────────────────────────────
 * The same rule the approval chain uses. A reference cannot be spelled two
 * ways; the free-text field can, so it is slugified — "R&D", "R and D" and
 * "r-and-d" are one department. Both are read, because most records carry only
 * the string.
 *
 * ── AND WHY IT WORKS WITH AN EMPTY REGISTRY ─────────────────────────────────
 * `Acc_BudgetDepartment` supplies display names and aliases when finance has
 * registered a department. It is NOT the gate: with no rows at all — which is
 * the state of this database — the caller's own HR department still resolves,
 * against the department names the budget's own lines carry. Requiring a
 * registry row would mean the app stays dark until somebody seeds eighteen of
 * them, which is the failure this change exists to end.
 *
 * ── FAILS CLOSED ────────────────────────────────────────────────────────────
 * No employee record, or no department on it, is an empty list — never every
 * department. A blank department cannot widen into a match because blank slugs
 * are dropped before anything is compared.
 */
async function budgetDepartmentsForEmployee({ companyId, user }) {
  const Employee = require("../models/Employee");

  const email = String(user?.email || "").trim().toLowerCase();
  const loginId = user?.employeeId || user?.id;
  const or = [];
  if (email) or.push({ email });
  if (loginId) or.push({ biometricId: String(loginId) }, { identityId: String(loginId) });
  if (!or.length) return [];

  const emp = await Employee.findOne({ $or: or })
    .select("department departmentId isActive status")
    .lean();
  if (!emp) return [];

  /* Somebody the login would refuse must not carry a budget entitlement. */
  const inactive =
    emp.isActive === false ||
    ["inactive", "suspended"].includes(String(emp.status || "").toLowerCase());
  if (inactive) return [];

  const names = new Set();
  if (emp.department) names.add(String(emp.department));

  /* The org-chart reference, when there is one. Read for its NAME — the id
     itself means nothing to a budget line, which stores a department as text. */
  if (emp.departmentId) {
    try {
      const mongoose = require("mongoose");
      const row = await mongoose.connection
        .collection("departments")
        .findOne({ _id: new mongoose.Types.ObjectId(String(emp.departmentId)) });
      if (row?.name) names.add(String(row.name));
    } catch {
      /* A department row that cannot be read costs the alias, not the access —
         the free-text field is still there and is what most records use. */
    }
  }

  const slugs = [...new Set([...names].map(slugify).filter(Boolean))];
  if (!slugs.length) return [];

  /* Registered departments answer with their own name and aliases; anything
     HR knows about and finance has not registered still resolves, under the
     name HR gave it. */
  const registered = await Acc_BudgetDepartment.find({
    companyId: actuals.oid(companyId),
    slug: { $in: slugs },
    isActive: { $ne: false },
  })
    .select("_id slug name aliases")
    .lean();

  const bySlug = new Map(registered.map((r) => [r.slug, r]));
  return slugs.map((slug) => {
    const hit = bySlug.get(slug);
    return hit
      ? { _id: hit._id, slug: hit.slug, name: hit.name, aliases: hit.aliases || [] }
      : {
          _id: null,
          slug,
          /* Displayed as HR spells it, not as a slug. */
          name: displayOf([...names].find((n) => slugify(n) === slug) || slug),
          aliases: [],
        };
  });
}

module.exports = {
  slugify,
  displayOf,
  departmentResolver,
  departmentsForAccessSlug,
  departmentsForAccessSlugs,
  departmentsForSlugs,
  budgetDepartmentsForGrant,
  budgetDepartmentsForEmployee,
};
