/**
 * GRAV-CMS-BACKEND/models/Accountant_model/Acc_BudgetDepartment.js
 *
 * The departments a company's budgets can be owned by, tagged with, or asked
 * for by.
 *
 * ── WHY THIS IS ITS OWN TABLE ───────────────────────────────────────────────
 * Three department-ish tables already exist. None of them is this:
 *
 *   AccessDepartment  the org-wide LOGIN PORTAL registry (accountant, hr, qc,
 *     cutting-master). Seeded at boot, deliberately global — it decides where
 *     a person lands after signing in. Accounting is multi-company; giving it
 *     a companyId would change authentication routing. Its vocabulary is also
 *     simply not the budgets' vocabulary: the live budgets name Logistics,
 *     Admin, Facilities and Projects, none of which is a login portal.
 *
 *   Acc_Department  the accountant login table, despite the name. Its inbound
 *     refs are createdBy/approvedBy and point at PEOPLE.
 *
 *   Acc_CostCentre  company-scoped and accounting-owned, but it is the
 *     PROJECT dimension. Project-scope budgets will attribute spend through it
 *     later; merging departments into it now would weld together two
 *     dimensions that have to stay separable.
 *
 * ── DELIBERATELY SOFT ───────────────────────────────────────────────────────
 * No budget field is a hard ref to this table. Budgets keep storing the
 * department as text; this registry decides what that text MEANS. Three
 * reasons that is the right shape here:
 *
 *   - Every budget written before this table existed still reads, groups and
 *     reports correctly, with no migration to get wrong.
 *   - A department can be renamed without rewriting history: the slug is the
 *     identity, the name is what is shown.
 *   - Free text keeps working. Registering a department improves how its
 *     spellings fold together; it is not a precondition for using one.
 */

const mongoose = require("mongoose");

const budgetDepartmentSchema = new mongoose.Schema(
  {
    /* Required, unlike almost everything else department-shaped in this
     * codebase. A registry row that belonged to no company would be offered
     * in every company's picker, which is exactly the confusion this exists
     * to remove. */
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Company",
      required: true,
      index: true,
    },

    /* The identity. Derived from `name` by budgetDepartment.service's
     * slugify, and never edited directly — a slug the user can type is a
     * second name to keep in step with the first. Renaming the department
     * leaves this alone on purpose, so past budgets keep resolving. */
    slug: { type: String, required: true, trim: true, lowercase: true },

    /* What people see. Changing it renames the department everywhere it is
     * displayed without touching a single budget row. */
    name: { type: String, required: true, trim: true },

    /* Spellings that mean this department but do not slugify to it — which in
     * practice means MISSPELLINGS. slugify already folds case, spacing,
     * punctuation, accents and & vs and; it cannot fold "Logistcs" into
     * "Logistics", because no rule can tell that apart from a genuinely
     * different word. A human says so once here, and every past and future
     * row carrying the typo resolves correctly.
     *
     * Stored slugified, so an alias is matched the same way a name is. */
    aliases: [{ type: String, trim: true, lowercase: true }],

    /* "Stop offering this in pickers", never "stop reading rows that use it".
     * A closed department's budgets must still report — a company that
     * dissolves Logistics in March still has to explain what Logistics spent
     * in January. Nothing in the read path drops a row for being inactive. */
    isActive: { type: Boolean, default: true, index: true },

    createdBy: { type: String, trim: true },
    updatedBy: { type: String, trim: true },
  },
  { timestamps: true },
);

/* One department per slug per company. The unique index is the real guard:
 * two people adding "Logistics" at the same moment both pass an application
 * -level check and only this stops the duplicate. */
budgetDepartmentSchema.index({ companyId: 1, slug: 1 }, { unique: true });

/* Aliases are looked up by slug across a company's rows. */
budgetDepartmentSchema.index({ companyId: 1, aliases: 1 });

const Acc_BudgetDepartment =
  mongoose.models.Acc_BudgetDepartment ||
  mongoose.model("Acc_BudgetDepartment", budgetDepartmentSchema, "acc_budget_departments");

module.exports = { Acc_BudgetDepartment, budgetDepartmentSchema };
