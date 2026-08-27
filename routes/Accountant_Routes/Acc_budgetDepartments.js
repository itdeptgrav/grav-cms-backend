// routes/Accountant_Routes/Acc_budgetDepartments.js
//
// The department registry behind budget scoping, lines and requests.
//
// Small on purpose. This exists so a department can be PICKED rather than
// typed — see services/budgetDepartment.service.js for why free text made
// "Logistics", "logistics" and "LOGISTICS " three departments in every
// roll-up, and for why none of the three department tables already in this
// codebase could be the one.
//
// Nothing here is a precondition for using a department. A company that never
// opens this screen keeps typing departments and keeps getting case- and
// spacing-tolerant grouping; registering one only adds a canonical spelling
// and a place to record its misspellings.

const express = require("express");
const router = express.Router();
const AccountantAuthMiddleware = require("../../Middlewear/AccountantAuthMiddleware");
const { Acc_BudgetDepartment } = require("../../models/Accountant_model/Acc_BudgetDepartment");
const { Acc_Budget } = require("../../models/Accountant_model/Acc_OperationalModels");
const departments = require("../../services/budgetDepartment.service");
const actuals = require("../../services/budgetActuals.service");

router.use(AccountantAuthMiddleware.accountantAuth);

function companyOf(req) {
  return (
    req.headers["x-company-id"] ||
    req.query.companyId ||
    req.body?.companyId ||
    (req.user && req.user.companyId) ||
    null
  );
}

/** Same wording as the budget router's, so a read-only user gets one message
 *  however they reach a write. */
function requireEdit(req, res) {
  if (req.user?.permissions?.canEdit) return false;
  res.status(403).json({
    success: false,
    message: "Your accounting role is read-only, so this change was not saved.",
  });
  return true;
}

const actorOf = (req) => req.user?.email || req.user?.name || null;

const shape = (d) => ({
  _id: d._id,
  slug: d.slug,
  name: d.name,
  aliases: d.aliases || [],
  /* The link to an access-control department, which is what lets a head reach
     the standalone Budget app and act for this department. Null until finance
     maps it; see routes/Access/budgetProposals.js. */
  accessSlug: d.accessSlug || null,
  isActive: d.isActive !== false,
  createdBy: d.createdBy || null,
  updatedBy: d.updatedBy || null,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
});

/**
 * GET / — the picker's contents, plus what is already in use.
 *
 * `inUse` lists department spellings that appear on this company's budgets but
 * are NOT registered. That is the whole migration story: a company sees its
 * own history offered as one-click registrations instead of being handed an
 * empty registry and told to remember what it used to call things.
 *
 * `?includeInactive=true` for a maintenance screen; the default is what may
 * be picked today. A closed department disappears from the picker but never
 * from the budgets that reference it.
 */
router.get("/", async (req, res) => {
  try {
    const companyId = actuals.oid(companyOf(req));
    if (!companyId) {
      return res.status(400).json({ success: false, message: "A company is required." });
    }

    const includeInactive = String(req.query.includeInactive) === "true";
    const resolver = await departments.departmentResolver({ companyId });
    const registered = resolver.list().filter((d) => includeInactive || d.isActive);

    /* Every department spelling this company's budgets actually carry, with a
     * count, so the unregistered ones can be ranked by how much depends on
     * them. Read from the budgets themselves rather than a cached list —
     * there is no second place for this to drift from. */
    const budgets = await Acc_Budget.find({ companyId })
      .select("department items.department budgetRequests.department")
      .lean();

    const counts = new Map();
    const bump = (value) => {
      const hit = resolver.resolve(value);
      if (!hit || hit.known) return;
      const row = counts.get(hit.slug) || { slug: hit.slug, name: hit.name, count: 0 };
      row.count += 1;
      counts.set(hit.slug, row);
    };
    for (const b of budgets) {
      bump(b.department);
      for (const i of b.items || []) bump(i.department);
      for (const r of b.budgetRequests || []) bump(r.department);
    }

    res.json({
      success: true,
      departments: registered,
      /* Named for what it is: spellings in use that nobody has registered. */
      unregistered: [...counts.values()].sort((a, b) => b.count - a.count),
    });
  } catch (error) {
    console.error("[budget-departments] list error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST / — register a department.
 *
 * The slug is DERIVED, never accepted from the caller. A slug the user can
 * type is a second name to keep in step with the first, and the whole point
 * of this table is that there is exactly one identity per department.
 */
router.post("/", async (req, res) => {
  try {
    if (requireEdit(req, res)) return;

    const companyId = actuals.oid(companyOf(req));
    if (!companyId) {
      return res.status(400).json({ success: false, message: "A company is required." });
    }

    const name = departments.displayOf(req.body?.name);
    const slug = departments.slugify(name);
    if (!slug) {
      return res.status(400).json({ success: false, message: "A department needs a name." });
    }

    const aliases = [...new Set(
      (Array.isArray(req.body?.aliases) ? req.body.aliases : [])
        .map(departments.slugify)
        .filter((a) => a && a !== slug),
    )];

    const existing = await Acc_BudgetDepartment.findOne({ companyId, slug }).lean();
    if (existing) {
      /* Not an error worth a 409 body the caller has to special-case: the
       * department they asked for exists, which is the state they wanted. */
      return res.status(200).json({
        success: true,
        department: shape(existing),
        alreadyExisted: true,
      });
    }

    const created = await Acc_BudgetDepartment.create({
      companyId,
      slug,
      name,
      aliases,
      /* Optional at creation — most departments are mapped later, once someone
         knows which portal owns them. Slugified rather than trusted verbatim so
         "Sales " and "sales" cannot become two different links. */
      accessSlug: departments.slugify(req.body?.accessSlug) || undefined,
      createdBy: actorOf(req),
      updatedBy: actorOf(req),
    });

    res.status(201).json({ success: true, department: shape(created.toObject()) });
  } catch (error) {
    /* The unique index is the real guard against two people adding the same
     * department at once; both pass the findOne above. */
    if (error?.code === 11000) {
      const dup = await Acc_BudgetDepartment.findOne({
        companyId: actuals.oid(companyOf(req)),
        slug: departments.slugify(req.body?.name),
      }).lean();
      if (dup) {
        return res.status(200).json({ success: true, department: shape(dup), alreadyExisted: true });
      }
    }
    console.error("[budget-departments] create error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * PATCH /:id — rename, teach it a misspelling, or retire it.
 *
 * Low-risk by construction: the SLUG never moves. Renaming changes only what
 * is displayed, aliases only add resolutions, and retiring only removes it
 * from the picker. None of the three rewrites a budget or changes a figure.
 */
router.patch("/:id", async (req, res) => {
  try {
    if (requireEdit(req, res)) return;

    const companyId = actuals.oid(companyOf(req));
    if (!companyId) {
      return res.status(400).json({ success: false, message: "A company is required." });
    }

    const current = await Acc_BudgetDepartment.findOne({ _id: req.params.id, companyId }).lean();
    if (!current) {
      return res.status(404).json({ success: false, message: "Department not found." });
    }

    const patch = { updatedBy: actorOf(req) };

    if (req.body?.name !== undefined) {
      const name = departments.displayOf(req.body.name);
      if (!name) {
        return res.status(400).json({ success: false, message: "A department needs a name." });
      }
      /* The slug stays as it was even when the new name would slugify
       * differently. That is the point of having one: "Logistics" renamed to
       * "Supply Chain" must not orphan every budget that says Logistics. The
       * old spelling keeps resolving because the slug did not move. */
      patch.name = name;
    }

    if (req.body?.aliases !== undefined) {
      if (!Array.isArray(req.body.aliases)) {
        return res.status(400).json({ success: false, message: "aliases must be a list." });
      }
      patch.aliases = [...new Set(
        req.body.aliases.map(departments.slugify).filter((a) => a && a !== current.slug),
      )];

      /* An alias that is another registered department's slug would make one
       * department silently swallow another's spend. Refused rather than
       * resolved by precedence, because the precedence would be invisible. */
      const clash = await Acc_BudgetDepartment.findOne({
        companyId,
        _id: { $ne: current._id },
        slug: { $in: patch.aliases },
      }).lean();
      if (clash) {
        return res.status(400).json({
          success: false,
          message: `"${clash.name}" is a department in its own right, so it cannot also be an alias of "${current.name}".`,
        });
      }
    }

    /* ── THE ACCESS LINK ──────────────────────────────────────────────────
     * Which access-control department may propose for this budget department.
     * Empty string CLEARS it, which is the revocation path: one field, no
     * token to wait out — routes/Access/budgetProposals.js re-reads this on
     * every request.
     *
     * Slugified rather than stored as typed, so it matches the portal slug the
     * token carries. Not validated against the AccessDepartment registry on
     * purpose: a department can legitimately be mapped before its portal row
     * is seeded, and refusing that would make ordering the setup steps a
     * puzzle. An unmatched slug simply resolves to nobody. */
    if (req.body?.accessSlug !== undefined) {
      const raw = String(req.body.accessSlug ?? "").trim();
      patch.accessSlug = raw ? departments.slugify(raw) : "";
    }

    if (req.body?.isActive !== undefined) patch.isActive = !!req.body.isActive;

    const updated = await Acc_BudgetDepartment.findOneAndUpdate(
      { _id: current._id, companyId },
      patch,
      { new: true, runValidators: true },
    ).lean();

    res.json({ success: true, department: shape(updated) });
  } catch (error) {
    console.error("[budget-departments] update error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
