// routes/Access/budgetProposals.js
//
// The department-facing budget surface: /api/budget-proposals
//
// A Sales or Production head needs to propose budget and see finance's answer.
// They must not need — or get — the accounting module to do it.
//
// ── THREE FACTS THAT DECIDED THE SHAPE ──────────────────────────────────────
//
// 1. It cannot live under /api/accountant. The frontend attaches the CMS
//    department token through lib/authFetch.js, which deliberately SKIPS
//    /api/accountant/* so a department session never reaches the books. A
//    proposals route mounted there would arrive unauthenticated.
//
// 2. There is no department-portal auth middleware to mount in front of it.
//    SalesAuthMiddlewear and EmployeeAuthMiddlewear — which guard essentially
//    every department API route — strip the department claims off the token
//    entirely. So this router authenticates itself, exactly as
//    routes/Access/changeRequests.js does and for the same reason.
//
// 3. requireDepartmentRole and changeRequests' canRead both FAIL OPEN when a
//    department has no role rows assigned, which today is every department
//    except accounting. That rule is right for a migration; it is wrong for a
//    money boundary. Nothing here fails open: an unmapped caller sees an empty
//    list and can write nothing.
//
// ── HOW A CALLER IS MAPPED TO A BUDGET DEPARTMENT ───────────────────────────
// The token's `deptSlug` says which PORTAL they signed into ("sales"). That is
// not a budget department — Acc_BudgetDepartment holds cost departments
// ("Logistics", "Admin"), a different vocabulary on purpose. The link is the
// explicit `accessSlug` field on the registry, read from the database on every
// request rather than trusted from the token: the claim says who they are, the
// database says what that entitles them to.
//
// A portal with no linked department maps to NOTHING. Never to everything.

const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const router = express.Router();

const { SECRET, LEGACY_SECRETS, readToken } = require("../../config/jwt");
const { Acc_Budget } = require("../../models/Accountant_model/Acc_OperationalModels");
const { Acc_Company, Acc_Ledger, Acc_Group } = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_BudgetDepartment } = require("../../models/Accountant_model/Acc_BudgetDepartment");
const AccessDepartment = require("../../models/Access/AccessDepartment");
const DeptUser = require("../../models/Access/DeptUser");
const Employee = require("../../models/Employee");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const departments = require("../../services/budgetDepartment.service");
const proposals = require("../../services/budgetProposals.service");
const actuals = require("../../services/budgetActuals.service");
const variance = require("../../services/budgetVariance.service");
const tracker = require("../../services/budgetTracker.service");
const phasing = require("../../services/budgetPhasing.service");
const working = require("../../services/budgetWorking.service");
const adjustments = require("../../services/budgetAdjustment.service");
const actionCentre = require("../../services/budgetActionCentre.service");
const transfersvc = require("../../services/budgetTransfer.service");
const duplicates = require("../../services/budgetDuplicates.service");

/** Same self-authentication as changeRequests: this router sits outside every
 *  department's middleware, so it reads and verifies the session itself. */
function authenticate(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ success: false, message: "Not authenticated" });

  const verify = () => {
    try {
      return jwt.verify(token, SECRET);
    } catch (err) {
      for (const legacy of LEGACY_SECRETS) {
        try {
          return jwt.verify(token, legacy);
        } catch {
          /* try the next */
        }
      }
      throw err;
    }
  };

  try {
    const decoded = verify();
    req.user = {
      id: decoded.id,
      email: String(decoded.email || "").toLowerCase(),
      name: decoded.name || "",
      isAdmin: Boolean(decoded.isAdmin),
      /* The portal they signed into. NOT a budget department — see the header.
       * `role` is deliberately not read: a platform admin browsing into Sales
       * carries role:"sales", so role cannot answer either "who is this" or
       * "which department". */
      deptSlug: String(decoded.deptSlug || "").toLowerCase(),
    };
    next();
  } catch {
    res.status(401).json({ success: false, message: "Invalid or expired session" });
  }
}

router.use(authenticate);

/* The standalone Budget app's own slug. Reaching `/budget` from the launcher
 * switches the session into it, so `deptSlug` becomes "budget" — which is a
 * portal, not a department anyone budgets for, and can never appear as an
 * `accessSlug`. It is the signal to resolve identity from grants instead. */
const BUDGET_APP_SLUG = "budget";

/* Never an entitlement, whatever a grant row says. "platform-admin" is not a
 * department (see ensureAccessDepartments) and the Budget app is not one
 * either. Listing them would let a mapping to either widen access. */
const NOT_A_DEPARTMENT = new Set([BUDGET_APP_SLUG, "platform-admin"]);

/**
 * Every access-control department this human is granted, by slug.
 *
 * Two sources, because the system has two: `DeptUser` is the account that
 * belongs to a department, and `DepartmentRole` is a role held inside one. A
 * person can have either without the other — a head seeded before roles
 * existed has only the account; someone given a role in a second department
 * has only the role row there — so the entitlement is the union.
 *
 * Keyed on EMAIL rather than the token's id: the id identifies one department
 * account, and the whole point here is to find the others belonging to the
 * same person.
 *
 * Fails closed. No email, no rows, or only non-department slugs ⇒ [].
 */
async function grantedAccessSlugs(user) {
  const email = String(user?.email || "").trim().toLowerCase();
  if (!email) return [];

  const [accounts, roles, employees] = await Promise.all([
    DeptUser.find({ email, isActive: { $ne: false } }).select("departmentId").lean(),
    DepartmentRole.find({ email }).select("departmentSlug").lean(),
    /* ── THE THIRD SOURCE, AND THE ONE THAT WAS MISSING ────────────────────
       Command Centre grants an EMPLOYEE an app by adding it to their employee
       record — `accessDepartmentId` for the one they land on, plus
       `additionalDepartmentIds` for every other. That is the main way access is
       handed out, and reading only DeptUser and DepartmentRole meant a person
       who had genuinely been given an app resolved to nothing here. The grant
       was real; nothing looked at it. */
    Employee.find({ email, isActive: { $ne: false } })
      .select("accessDepartmentId additionalDepartmentIds")
      .lean(),
  ]);

  const slugs = new Set();

  /* The account rows carry an id, so the slug is read from the registry — and
     only for departments that are still active, so deactivating one revokes
     the budget entitlement it carried without touching anything here. */
  const ids = accounts.map((a) => a.departmentId).filter(Boolean);
  for (const e of employees) {
    if (e.accessDepartmentId) ids.push(e.accessDepartmentId);
    for (const extra of e.additionalDepartmentIds || []) ids.push(extra);
  }
  if (ids.length) {
    const depts = await AccessDepartment.find({ _id: { $in: ids }, isActive: true })
      .select("slug")
      .lean();
    for (const d of depts) if (d.slug) slugs.add(String(d.slug).toLowerCase());
  }

  for (const r of roles) {
    if (r.departmentSlug) slugs.add(String(r.departmentSlug).toLowerCase());
  }

  for (const s of NOT_A_DEPARTMENT) slugs.delete(s);
  return [...slugs];
}

/**
 * The budget departments this person was granted DIRECTLY, on the Budget app
 * grant itself.
 *
 * ── THE POINT OF THIS FUNCTION ──────────────────────────────────────────────
 * Access used to need two setups that nobody could see at once: give somebody
 * the Budget app in Access Control, then separately have finance link their
 * portal to a budget department. Granting the app alone produced "your account
 * is not linked", with neither screen able to say what was missing.
 *
 * Now the grant carries the answer. One record, set in one place, read here.
 *
 * Returns SLUGS OF BUDGET DEPARTMENTS — not portal slugs. They are resolved
 * against `Acc_BudgetDepartment` for one company by the caller, so a grant can
 * never reach another company's books.
 *
 * Fails closed: no email, no grant, or a grant naming nothing ⇒ [].
 */
async function grantedBudgetDepartmentSlugs(user) {
  const email = String(user?.email || "").trim().toLowerCase();
  if (!email) return [];

  const rows = await DepartmentRole.find({
    departmentSlug: BUDGET_APP_SLUG,
    email,
    isActive: { $ne: false },
  })
    .select("budgetDepartments")
    .lean();

  const slugs = new Set();
  for (const r of rows) {
    for (const d of r.budgetDepartments || []) {
      const slug = String(d ?? "").trim().toLowerCase();
      if (slug) slugs.add(slug);
    }
  }
  return [...slugs];
}

/**
 * Which access-control slugs to resolve this request against.
 *
 * A real portal still answers for itself — a head working inside Sales gets
 * exactly what they always got, one slug, one query, unchanged. The grant
 * lookup runs only when there is no portal to ask: the standalone Budget app,
 * or a token with no `deptSlug` at all.
 */
async function accessSlugsFor(req) {
  const portal = req.user.deptSlug;
  if (portal && !NOT_A_DEPARTMENT.has(portal)) return [portal];
  return grantedAccessSlugs(req.user);
}

/**
 * Is this caller a platform administrator, according to the DATABASE?
 *
 * The token carries an `isAdmin` claim, and it is not enough on its own: a
 * claim is only as fresh as the token, and revoking admin has to take effect
 * on the next request rather than in seven days. DeptUser's own comment says
 * the same thing about this exact field, so this re-reads it.
 *
 * Both the claim AND the row must agree. The claim alone cannot promote
 * anybody, and the row alone cannot promote a token that never asserted it.
 */
async function isPlatformAdmin(user) {
  if (!user?.isAdmin) return false;
  const email = String(user.email || "").trim().toLowerCase();
  if (!email) return false;
  const row = await DeptUser.findOne({ email, isAdmin: true, isActive: { $ne: false } })
    .select("_id")
    .lean();
  return Boolean(row);
}

/**
 * The budget departments this caller may act for, in one company.
 *
 * Re-read from the database every request. The token says who they are; the
 * registry says what that entitles them to, and an administrator can revoke it
 * by clearing one field without waiting for a token to expire.
 *
 * ── THE ADMINISTRATOR PATH, DELIBERATELY EXPLICIT ───────────────────────────
 * A platform administrator sees every ACTIVE budget department in the company,
 * mapped or not. Without it an admin cannot open this app at all — they
 * usually hold no department grant — and "the feature looks broken to the only
 * person who can fix it" is how a mapping screen goes unused.
 *
 * Three things keep it from becoming a hole:
 *   - `isAdmin` is re-read from the database, not trusted from the token.
 *   - It widens NOBODY else. An ordinary user's path is untouched: grants
 *     first, mapping second, empty if either is missing.
 *   - Callers are told which path answered, so the app can say so on screen
 *     and a write can be logged as an administrator action rather than a
 *     department one. See `viewAs` on the responses and auditNote below.
 */
async function allowedFor(req, companyId) {
  if (await isPlatformAdmin(req.user)) {
    req.budgetViewAs = "administrator";
    const rows = await Acc_BudgetDepartment.find({
      companyId: actuals.oid(companyId),
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

  req.budgetViewAs = "department";

  /* ── TWO SOURCES, ONE ANSWER ──────────────────────────────────────────────
     1. The Budget grant itself, naming budget departments directly. This is
        the normal path: one grant in Access Control and the app works.
     2. The older indirection — a portal linked to a department by finance.
        Kept so every mapping made before this still resolves; it is a
        fallback, not a requirement, and nothing new needs it.

     Unioned rather than preferred, because a person can legitimately hold both
     (their own portal, plus an explicit grant for a second department) and
     dropping either would silently narrow access somebody already had.
     Deduped by department id, so holding both for the same department yields
     one row rather than two. */
  const [granted, portalSlugs] = await Promise.all([
    grantedBudgetDepartmentSlugs(req.user),
    accessSlugsFor(req),
  ]);

  return allowedForSlugs(companyId, granted, portalSlugs);
}

/**
 * The two sources, merged, for one company. Extracted so `/context` and every
 * scoped read answer with exactly the same rule rather than two that drift.
 */
async function allowedForSlugs(companyId, granted, portalSlugs) {
  const [direct, viaPortal] = await Promise.all([
    /* The grant, read against the company's own department list. No finance
       registry has to exist for this to work — that is the whole point. */
    departments.budgetDepartmentsForGrant({ companyId, slugs: granted }),
    portalSlugs.length
      ? departments.departmentsForAccessSlugs({ companyId, accessSlugs: portalSlugs })
      : [],
  ]);

  /* Keyed on SLUG, not id: a granted department may have no registry row and
     so no id at all, and keying on a null id would collapse every such
     department into one entry. */
  const bySlug = new Map();
  for (const row of [...direct, ...viaPortal]) bySlug.set(row.slug, row);
  return [...bySlug.values()];
}

/**
 * One line in the server log when an administrator WRITES through the
 * administrator path. Reads are not logged — they are how the screen renders,
 * and logging every render would bury the writes that matter.
 */
function auditNote(req, action, detail) {
  if (req.budgetViewAs !== "administrator") return;
  console.log(
    `[budget-proposals] ADMIN ${action} by ${req.user.email || req.user.id} — ${detail}`,
  );
}

/**
 * EVERY SPELLING THAT IDENTIFIES AN ALLOWED DEPARTMENT.
 *
 * ── THE BUG THIS EXISTS FOR ─────────────────────────────────────────────────
 * A department is granted under its SLUG — `hr`, `qc`, `store`. It is shown,
 * and stored on a request, under its NAME — "Human Resources", "Quality
 * Control", "Store & Purchase". Everything downstream then asked the same
 * question as `slugify(whatever the request carried)` and compared it to the
 * slug, which silently assumed the two were the same string.
 *
 * For ten of this company's eighteen departments they are not. The result was
 * a 403 on submit — "You cannot submit budget for that department" — for a
 * department the person was properly granted, and, through the same test in
 * `ownedBy`, their own already-submitted lines vanishing from their screen.
 *
 * So the allowed set carries both spellings, plus any registry aliases. It can
 * only ever contain more ways to name a department the caller is ALREADY
 * allowed — nothing here widens who is allowed what.
 */
const slugsOf = (rows) =>
  [
    ...new Set(
      rows.flatMap((r) => [
        r.slug,
        departments.slugify(r.name),
        ...(r.aliases || []).map((a) => departments.slugify(a)),
      ]),
    ),
  ].filter(Boolean);

/** Company scope must be explicit, and must be one the caller is mapped in. */
async function scope(req, res) {
  const companyId = actuals.oid(req.query.companyId || req.body?.companyId);
  if (!companyId) {
    res.status(400).json({ success: false, message: "A company is required." });
    return null;
  }
  const allowed = await allowedFor(req, companyId);
  if (!allowed.length) {
    /* 200 with nothing rather than 403: a department that has simply not been
     * linked yet is not doing anything wrong, and a refusal here would read as
     * a bug to whoever is trying to submit a budget. The write paths DO
     * refuse — see canSubmitFor. */
    return { companyId, allowed, slugs: [] };
  }
  return { companyId, allowed, slugs: slugsOf(allowed) };
}

/* ── CONTEXT ─────────────────────────────────────────────────────────────────
 * Where a department user starts: which companies they may propose in, and as
 * which department. Returns only companies where THIS portal is mapped, so it
 * is not a directory of the group's books. */
router.get("/context", async (req, res) => {
  try {
    /* The same resolution every other endpoint uses — a portal slug when there
       is one, the caller's grants when they arrived through the standalone
       Budget app. Context is the screen that decides whether the app looks
       usable at all, so it must not answer a different question from the
       endpoints behind it. */
    const admin = await isPlatformAdmin(req.user);
    let rows;
    if (admin) {
      /* Every company that HAS budget departments, so an administrator can
         reach the mapping they need to fix. Mapped or not — an unmapped
         department is precisely what they came to see. */
      rows = await Acc_BudgetDepartment.find({ isActive: { $ne: false } })
        .select("_id companyId slug name accessSlug")
        .lean();
    } else {
      /* ── WHICH COMPANIES THIS PERSON HAS A BUDGET LIFE IN ──────────────────
         The grant names departments, not companies, so the companies are the
         ones that actually run budget rounds. Listing every company would turn
         this into a directory of the group's books; listing none would hide a
         company whose first round has just opened. */
      const [granted, portalSlugs] = await Promise.all([
        grantedBudgetDepartmentSlugs(req.user),
        accessSlugsFor(req),
      ]);
      if (!granted.length && !portalSlugs.length) {
        return res.json({
          success: true,
          portal: req.user.deptSlug || null,
          viewAs: "department",
          companies: [],
        });
      }

      /* ── WHICH COMPANIES, AND WHY NOT "THE ONES WITH ROUNDS" ──────────────
         A grant names departments, not companies, so the books a granted
         person belongs to are simply the company's books.

         This deliberately does NOT filter on "has a budget round". That was
         the first shape and it was wrong in the one case that matters most:
         the day after a clean start there are no rounds, so a correctly
         granted person was told their account was not linked — the exact
         message this whole change existed to stop showing to people who ARE
         linked. "Nothing has been opened yet" and "you have no access" are
         different sentences and must not share a screen.

         The legacy branch keeps its own narrower rule: a portal mapping is
         per company, so it lists only the companies it was mapped in. */
      const [allCompanies, mapped] = await Promise.all([
        granted.length ? Acc_Company.find({}).select("_id").lean() : [],
        portalSlugs.length
          ? Acc_BudgetDepartment.distinct("companyId", {
              accessSlug: { $in: portalSlugs },
              isActive: { $ne: false },
            })
          : [],
      ]);
      const companyIds = [
        ...new Map(
          [...allCompanies.map((c) => c._id), ...mapped]
            .filter(Boolean)
            .map((id) => [String(id), id]),
        ).values(),
      ];

      const perCompany = await Promise.all(
        companyIds.map(async (cid) => ({
          companyId: cid,
          departments: await allowedForSlugs(cid, granted, portalSlugs),
        })),
      );

      const companies = await Acc_Company.find({
        _id: { $in: perCompany.filter((c) => c.departments.length).map((c) => c.companyId) },
      })
        .select("_id companyName")
        .lean();

      const deptsOf = new Map(
        perCompany.map((c) => [String(c.companyId), c.departments]),
      );

      return res.json({
        success: true,
        portal: req.user.deptSlug,
        viewAs: "department",
        companies: companies.map((c) => ({
          _id: c._id,
          name: c.companyName,
          departments: (deptsOf.get(String(c._id)) || []).map((d) => ({
            slug: d.slug,
            name: d.name,
          })),
        })),
      });
    }

    const byCompany = new Map();
    for (const r of rows) {
      const k = String(r.companyId);
      if (!byCompany.has(k)) byCompany.set(k, []);
      byCompany.get(k).push({ slug: r.slug, name: r.name });
    }

    const companies = await Acc_Company.find({ _id: { $in: [...byCompany.keys()] } })
      .select("_id companyName")
      .lean();

    res.json({
      success: true,
      portal: req.user.deptSlug,
      /* Which path answered. The app says so on screen when it is the
         administrator one, so nobody mistakes "I can see everything" for
         "everyone can see everything". */
      viewAs: admin ? "administrator" : "department",
      companies: companies.map((c) => ({
        _id: c._id,
        name: c.companyName,
        departments: byCompany.get(String(c._id)) || [],
      })),
    });
  } catch (error) {
    console.error("[budget-proposals] context error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── OPEN CYCLES ─────────────────────────────────────────────────────────── */
router.get("/open-cycles", async (req, res) => {
  try {
    const s = await scope(req, res);
    if (!s) return;
    res.json({
      success: true,
      cycles: await proposals.openCycles({ companyId: s.companyId, allowedSlugs: s.slugs }),
      departments: s.allowed,
    });
  } catch (error) {
    console.error("[budget-proposals] open-cycles error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── MY REQUESTS ─────────────────────────────────────────────────────────── */
router.get("/my-requests", async (req, res) => {
  try {
    const s = await scope(req, res);
    if (!s) return;
    const { requests, summary } = await proposals.myRequests({
      companyId: s.companyId,
      allowedSlugs: s.slugs,
      financialYear: req.query.financialYear,
    });
    res.json({ success: true, requests, summary, departments: s.allowed, viewAs: req.budgetViewAs });
  } catch (error) {
    console.error("[budget-proposals] my-requests error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── HEADS A DEPARTMENT MAY ASK AGAINST ──────────────────────────────────────
 * The company's expense/revenue ledgers, so the form can offer a real head.
 * Names and natures only — no balances, no budget figures.
 *
 * ── NATURE COMES FROM THE GROUP, NOT THE LEDGER ROW ─────────────────────────
 * `nature` on a ledger is inherited from its group but can be overridden per
 * ledger (Tally allows it), and the budget module does not honour that
 * override anywhere: budgetActuals.natureByLedger reads the GROUP, so every
 * allocation, roll-up and variance figure in the module is classified that
 * way. Offering heads by the row's own copy would let this picker call a head
 * one thing and every figure downstream call it another.
 *
 * Same rule, same query shape as /budgets/ledger-options, so the portal's
 * picker and finance's picker offer the same heads.
 */
router.get("/heads", async (req, res) => {
  try {
    const s = await scope(req, res);
    if (!s) return;
    if (!s.slugs.length) return res.json({ success: true, heads: [] });

    const groups = await Acc_Group.find({
      companyId: s.companyId,
      nature: { $in: ["revenue", "expense"] },
    })
      .select("_id name nature")
      .lean();
    if (!groups.length) return res.json({ success: true, heads: [] });

    const natureOf = new Map(groups.map((g) => [String(g._id), g]));

    const heads = await Acc_Ledger.find({
      companyId: s.companyId,
      groupId: { $in: groups.map((g) => g._id) },
    })
      .select("_id name groupId groupName isActive")
      .sort({ name: 1 })
      .limit(500)
      .lean();

    res.json({
      success: true,
      heads: heads
        .filter((l) => l.isActive !== false)
        .map((l) => {
          const g = natureOf.get(String(l.groupId));
          return {
            ledgerId: l._id,
            ledgerName: l.name,
            groupName: l.groupName || (g && g.name) || null,
            nature: g ? g.nature : "expense",
          };
        }),
    });
  } catch (error) {
    console.error("[budget-proposals] heads error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── ADJUSTMENT ASKS ─────────────────────────────────────────────────────────
 * "We need more than was approved", or "this needs revising".
 *
 * ── WHAT THIS IS AND IS NOT ────────────────────────────────────────────────
 * It creates a row in `budget.adjustments` and moves nothing. The allocation
 * changes only when finance approves through its own endpoint, which is where
 * the money, the audit trail and the four-eyes rule already live. A department
 * asking and a department approving are different verbs, and only the first
 * one is here.
 *
 * The ask is built field by field from the TARGET LINE, never spread from the
 * body — a request that could name its own `approvedNewAmount` or `state`
 * would be a request that approves itself.
 */

/** The caller's own approved line, or the reason they may not touch it. */
async function lineForAdjustment(req, s) {
  const budget = await Acc_Budget.findOne({ _id: req.body?.budgetId, companyId: s.companyId });
  if (!budget) return { error: { status: 404, message: "Budget not found." } };

  /* The same states finance allows an allocation to be adjusted in. A closed
   * year is not something to raise an ask against. */
  if (!adjustments.ADJUSTABLE_STATES.includes(budget.status)) {
    return {
      error: {
        status: 409,
        message: `This budget is ${budget.status}; its allocations can no longer be adjusted.`,
      },
    };
  }

  const line = budget.items?.id?.(req.body?.lineId);
  /* 404 rather than 403 for a line that exists but is not theirs: a refusal
   * that distinguishes the two is a way to enumerate other departments' line
   * ids. Same rule `ownedBy` follows for requests. */
  if (!line) return { error: { status: 404, message: "Budget line not found." } };

  const resolver = await departments.departmentResolver({ companyId: s.companyId });
  const mine = new Set(s.slugs);
  const resolved = resolver.resolve(line.department);
  if (!resolved || !mine.has(resolved.slug)) {
    return { error: { status: 404, message: "Budget line not found." } };
  }

  return { budget, line };
}

/** What a department may see of its own ask. */
function publicAdjustment(a, budget) {
  return {
    _id: String(a._id),
    budgetId: String(budget._id),
    budgetName: budget.name,
    financialYear: budget.financialYear,
    lineId: a.targetItemId ? String(a.targetItemId) : null,
    ledgerId: a.ledgerId ? String(a.ledgerId) : null,
    ledgerName: a.ledgerName ?? null,
    groupName: a.groupName ?? null,
    nature: a.nature || "expense",
    department: a.department ?? null,
    type: a.type,
    currentAllocatedAmount: a.currentAllocatedAmount ?? 0,
    requestedDeltaAmount: a.requestedDeltaAmount ?? null,
    requestedNewAmount: a.requestedNewAmount ?? null,
    approvedDeltaAmount: a.approvedDeltaAmount ?? null,
    approvedNewAmount: a.approvedNewAmount ?? null,
    reason: a.reason ?? null,
    justification: a.justification ?? null,
    workingLines: (a.workingLines || []).map((l) => ({
      label: l.label, description: l.description ?? null,
      quantity: l.quantity ?? null, unit: l.unit ?? null,
      rate: l.rate ?? null, multiplier: l.multiplier ?? null,
      multiplierUnit: l.multiplierUnit ?? null,
      amount: l.amount ?? 0, manualAmount: Boolean(l.manualAmount),
      ...(l.monthly?.length
        ? { monthly: l.monthly.map((m) => ({ month: m.month, amount: m.amount })) }
        : {}),
    })),
    priority: a.priority || "normal",
    origin: a.origin || "finance",
    state: a.state,
    financeNote: a.financeNote ?? null,
    requestedAt: a.requestedAt ?? null,
    reviewedAt: a.reviewedAt ?? null,
    appliedAt: a.appliedAt ?? null,
    /* Cancellable while nobody has acted on it. Decided here rather than in
       the client so both sides agree about what is still the department's. */
    cancellable: a.state === "submitted",
    /* `requestedBy`/`reviewedBy` are withheld: they name people, and neither
       screen needs them. */
  };
}

router.post("/adjustments", async (req, res) => {
  try {
    const s = await scope(req, res);
    if (!s) return;
    if (!s.slugs.length) {
      return res.status(403).json({ success: false, message: "No budget department is linked to you." });
    }

    const type = req.body?.type;
    if (!adjustments.TYPES.includes(type)) {
      return res
        .status(400)
        .json({ success: false, message: 'type must be "supplementary" or "revision".' });
    }

    const found = await lineForAdjustment(req, s);
    if (found.error) {
      return res.status(found.error.status).json({ success: false, message: found.error.message });
    }
    const { budget, line } = found;

    const reason = req.body?.reason ? String(req.body.reason).trim().slice(0, 500) : "";
    if (!reason) {
      return res
        .status(400)
        .json({ success: false, message: "Say why the approved figure needs to change." });
    }

    const current = variance.money(line.allocatedAmount) ?? 0;
    const amounts = adjustments.resolveAmounts({
      type,
      currentAllocatedAmount: current,
      requestedDeltaAmount: req.body?.requestedDeltaAmount,
      requestedNewAmount: req.body?.requestedNewAmount,
    });
    if (!amounts.ok) {
      return res.status(400).json({ success: false, message: amounts.message });
    }

    /* One open ask of a kind per line. Two open supplementaries are two people
     * asking for the same thing, and finance approving both applies the delta
     * twice — arithmetically correct and never what anyone meant. */
    /* Scoped to the department's OWN open asks: finance raising its own
       supplementary on a line we are also asking about is a different
       conversation, and blocking finance would be refusing the owner. */
    const already = duplicates.openAdjustmentFor(budget, {
      lineId: line._id,
      type,
      origin: "department",
    });
    if (already) {
      return duplicateResponse(
        res,
        "adjustment",
        already,
        `There is already an open ${type} request on ${line.ledgerName || "this line"}. Withdraw it before raising another, or wait for finance.`,
      );
    }

    /* Optional, and validated by the same rules a proposal's working is. */
    let derivation = { workingLines: [] };
    if (req.body?.workingLines !== undefined) {
      try {
        const { lines } = working.normaliseWorkingLines(req.body.workingLines);
        derivation = { workingLines: lines };
      } catch (e) {
        if (e instanceof working.WorkingError) {
          return res.status(400).json({ success: false, message: e.message, code: e.code });
        }
        throw e;
      }
    }

    budget.adjustments.push({
      type,
      targetItemId: line._id,
      sourceRequestId: line.sourceRequestId || undefined,
      /* Every identifying field comes off the LINE, not the body. */
      department: line.department || null,
      ledgerId: line.ledgerId || undefined,
      ledgerName: line.ledgerName || null,
      groupName: line.groupName || null,
      nature: line.nature || "expense",
      currentAllocatedAmount: current,
      requestedDeltaAmount: amounts.delta,
      requestedNewAmount: amounts.next,
      reason,
      justification: req.body?.justification
        ? String(req.body.justification).trim().slice(0, 2000)
        : undefined,
      priority: ["low", "normal", "high", "critical"].includes(req.body?.priority)
        ? req.body.priority
        : "normal",
      state: "submitted",
      /* Stamped here, never from the body — it is the whole basis on which
         finance treats this differently from one of its own. */
      origin: "department",
      requestedAt: new Date(),
      /* Server-derived, like every other author field here. */
      requestedBy: req.user.email || req.user.name || req.user.id,
      ...(derivation.workingLines.length ? { workingLines: derivation.workingLines } : {}),
    });

    await budget.save();
    const created = budget.adjustments[budget.adjustments.length - 1];
    auditNote(req, "ADJUSTMENT", `${created.department} · ${type} · budget ${budget._id}`);
    res.status(201).json({
      success: true,
      adjustment: publicAdjustment(created, budget),
      viewAs: req.budgetViewAs,
    });
  } catch (error) {
    console.error("[budget-proposals] adjustment error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/adjustments", async (req, res) => {
  try {
    const s = await scope(req, res);
    if (!s) return;
    if (!s.slugs.length) return res.json({ success: true, adjustments: [] });

    const budgets = await Acc_Budget.find({
      companyId: s.companyId,
      "adjustments.0": { $exists: true },
    })
      .sort({ startDate: -1 })
      .limit(24)
      .lean();

    const resolver = await departments.departmentResolver({ companyId: s.companyId });
    const mine = new Set(s.slugs);

    /* Narrowed on the SERVER by the adjustment's own department — the same
     * rule every other read here follows. */
    const rows = [];
    for (const b of budgets) {
      for (const a of b.adjustments || []) {
        const resolved = resolver.resolve(a.department);
        if (!resolved || !mine.has(resolved.slug)) continue;
        rows.push(publicAdjustment(a, b));
      }
    }
    rows.sort((x, y) => new Date(y.requestedAt || 0) - new Date(x.requestedAt || 0));

    res.json({ success: true, adjustments: rows, viewAs: req.budgetViewAs });
  } catch (error) {
    console.error("[budget-proposals] adjustments list error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/adjustments/:adjustmentId/cancel", async (req, res) => {
  try {
    const s = await scope(req, res);
    if (!s) return;
    if (!s.slugs.length) {
      return res.status(403).json({ success: false, message: "No budget department is linked to you." });
    }

    const budget = await Acc_Budget.findOne({ _id: req.body?.budgetId, companyId: s.companyId });
    if (!budget) return res.status(404).json({ success: false, message: "Adjustment not found." });

    const a = budget.adjustments?.id?.(req.params.adjustmentId);
    if (!a) return res.status(404).json({ success: false, message: "Adjustment not found." });

    const resolver = await departments.departmentResolver({ companyId: s.companyId });
    const resolved = resolver.resolve(a.department);
    if (!resolved || !new Set(s.slugs).has(resolved.slug)) {
      return res.status(404).json({ success: false, message: "Adjustment not found." });
    }

    /* Only while nobody has acted. Withdrawing something finance has already
     * approved would leave an applied delta with no ask behind it. */
    if (a.state !== "submitted") {
      return res.status(409).json({
        success: false,
        message: `This request is ${a.state} and can no longer be withdrawn.`,
      });
    }

    a.state = "cancelled";
    a.reviewedAt = new Date();
    await budget.save();
    res.json({ success: true, adjustment: publicAdjustment(a, budget) });
  } catch (error) {
    console.error("[budget-proposals] adjustment cancel error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── TRANSFER ASKS ───────────────────────────────────────────────────────────
 * "Move some of this line's budget to that one."
 *
 * Not extra money: a transfer leaves the company's total exactly where it was
 * and changes only who may spend it. That is why it is separate from an
 * adjustment — finance signs the two off on different grounds — and why the
 * source's AVAILABILITY, not its allocation, is what bounds the ask.
 *
 * Every rule here comes from budgetTransfer.service, which finance's own route
 * now uses too. Nothing is re-derived: a department computing availability its
 * own way would eventually offer an amount finance refuses, and the person
 * would have no way to see why.
 *
 * Creates a pending row and nothing else. The money moves in finance's approve
 * handler and nowhere else.
 */

/** Both lines of an ask, resolved and confirmed to belong to the caller. */
async function transferSidesFor(req, s, body) {
  const budget = await Acc_Budget.findOne({ _id: body?.budgetId, companyId: s.companyId });
  if (!budget) return { error: { status: 404, message: "Budget not found." } };

  if (!transfersvc.TRANSFERABLE_STATES.includes(budget.status)) {
    return {
      error: {
        status: 409,
        message: `This budget is ${budget.status}; its allocations can no longer be moved.`,
      },
    };
  }

  const sides = await transfersvc.resolveSides({
    companyId: s.companyId,
    budget,
    fromItemId: body?.fromLineId,
    toItemId: body?.toLineId,
    isUsableId: (v) => Boolean(v) && mongoose.Types.ObjectId.isValid(String(v)),
  });
  if (sides.error) return { error: sides.error };

  /* BOTH lines must be the caller's. Moving budget INTO a line they do not
   * hold would be a gift they are not entitled to make, and moving OUT of one
   * is obviously theirs to refuse. 404 rather than 403 on either, so a refusal
   * cannot be used to enumerate another department's line ids. */
  const resolver = await departments.departmentResolver({ companyId: s.companyId });
  const mine = new Set(s.slugs);
  const ours = (line) => {
    const r = resolver.resolve(line?.department);
    return Boolean(r && mine.has(r.slug));
  };
  if (!ours(sides.from) || !ours(sides.to)) {
    return { error: { status: 404, message: "Budget line not found." } };
  }

  return { budget, ...sides };
}

/** What a department may see of a transfer. */
function publicTransfer(t, budget) {
  return {
    _id: String(t._id),
    budgetId: String(budget._id),
    budgetName: budget.name,
    financialYear: budget.financialYear,
    fromLineId: t.fromItemId ? String(t.fromItemId) : null,
    toLineId: t.toItemId ? String(t.toItemId) : null,
    fromLedgerName: t.fromSnapshot?.ledgerName ?? null,
    toLedgerName: t.toSnapshot?.ledgerName ?? null,
    nature: t.fromSnapshot?.nature || "expense",
    amount: t.amount ?? 0,
    reason: t.reason ?? null,
    state: t.state,
    origin: t.origin || "finance",
    financeNote: t.financeNote ?? null,
    requestedAt: t.requestedAt ?? null,
    reviewedAt: t.reviewedAt ?? null,
    appliedAt: t.appliedAt ?? null,
    /* Withdrawable while nobody has acted. Decided here so both sides agree
       about what is still the department's to take back. */
    cancellable: t.state === "submitted",
  };
}

/** The lines this department may move between, with what each can give. */
router.get("/transfers/available", async (req, res) => {
  try {
    const s = await scope(req, res);
    if (!s) return;
    if (!s.slugs.length) return res.json({ success: true, lines: [] });

    const budgets = await Acc_Budget.find({
      companyId: s.companyId,
      status: { $in: transfersvc.TRANSFERABLE_STATES },
    })
      .sort({ startDate: -1 })
      .limit(24);

    const resolver = await departments.departmentResolver({ companyId: s.companyId });
    const mine = new Set(s.slugs);

    const lines = [];
    for (const budget of budgets) {
      const own = (budget.items || []).filter((i) => {
        const r = resolver.resolve(i.department);
        return Boolean(r && mine.has(r.slug));
      });
      if (!own.length) continue;

      /* Availability from the service — the department is never told a figure
         finance would compute differently. */
      const avail = await transfersvc.availabilityFor({
        companyId: s.companyId,
        budget,
        items: own,
      });

      for (const i of own) {
        const a = avail.get(String(i._id)) || { allocated: 0, actual: 0, remaining: 0 };
        lines.push({
          lineId: String(i._id),
          budgetId: String(budget._id),
          budgetName: budget.name,
          ledgerId: i.ledgerId ? String(i.ledgerId) : null,
          ledgerName: i.ledgerName || null,
          groupName: i.groupName || null,
          nature: i.nature === "revenue" ? "revenue" : "expense",
          allocated: a.allocated,
          actual: a.actual,
          available: a.remaining,
        });
      }
    }

    res.json({ success: true, lines, viewAs: req.budgetViewAs });
  } catch (error) {
    console.error("[budget-proposals] transfers available error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/transfers", async (req, res) => {
  try {
    const s = await scope(req, res);
    if (!s) return;
    if (!s.slugs.length) {
      return res.status(403).json({ success: false, message: "No budget department is linked to you." });
    }

    const found = await transferSidesFor(req, s, req.body);
    if (found.error) {
      return res.status(found.error.status).json({ success: false, message: found.error.message });
    }
    const { budget, from, to, avail } = found;

    const amount = variance.money(req.body?.amount);
    if (amount === null || amount <= 0) {
      return res.status(400).json({ success: false, message: "Enter an amount greater than zero." });
    }

    /* ── THE SAME ROUTE, TWICE ─────────────────────────────────────────── */
    const sameRoute = duplicates.openTransferFor(budget, {
      fromLineId: from._id,
      toLineId: to._id,
    });
    if (sameRoute) {
      return duplicateResponse(
        res,
        "transfer",
        sameRoute,
        `There is already an open transfer from ${from.ledgerName || "that line"} to ${to.ledgerName || "this one"}. Withdraw it before raising another.`,
      );
    }

    const fromAvail = avail.get(String(from._id));

    /* ── WHAT OTHER OPEN ASKS HAVE ALREADY SPOKEN FOR ───────────────────
     * Two transfers out of one line can each be affordable and not both.
     * Without this the second is accepted here and refused at APPROVAL —
     * the worst place to find out, because by then the department has
     * stopped thinking about it and finance is holding two asks it can
     * only grant one of.
     *
     * A courtesy, not the authority: finance recomputes availability from
     * posted vouchers when it approves, because spend keeps arriving. */
    const committed = duplicates.committedFromLine(budget, { fromLineId: from._id });
    const spare = Math.max(0, fromAvail.remaining - committed);

    if (amount > spare) {
      const r = (n) => Math.round(n).toLocaleString("en-IN");
      return res.status(committed > 0 ? 409 : 400).json({
        success: false,
        code: committed > 0 ? duplicates.CODES.transfer : "TRANSFER_EXCEEDS_AVAILABLE",
        message:
          committed > 0
            ? `${from.ledgerName || "That line"} has ₹${r(fromAvail.remaining)} free, but ₹${r(committed)} of it is already promised to open transfer requests — leaving ₹${r(spare)}.`
            : transfersvc.tooMuchMessage(from, fromAvail),
        available: { ...fromAvail, committed, spare },
      });
    }

    const reason = req.body?.reason ? String(req.body.reason).trim().slice(0, 500) : "";
    if (!reason) {
      return res.status(400).json({ success: false, message: "Say why the budget should move." });
    }

    /* Built field by field. A body that could set state, appliedAt or
     * reviewedBy would be a transfer that approves itself. */
    budget.transfers.push({
      fromItemId: from._id,
      toItemId: to._id,
      amount,
      reason,
      state: "submitted",
      origin: "department",
      fromSnapshot: transfersvc.snapshotOf(from, fromAvail),
      toSnapshot: transfersvc.snapshotOf(to, avail.get(String(to._id))),
      requestedAt: new Date(),
      requestedBy: req.user.email || req.user.name || req.user.id,
    });

    await budget.save();
    const created = budget.transfers[budget.transfers.length - 1];
    auditNote(req, "TRANSFER", `${from.ledgerName} → ${to.ledgerName} · ${amount} · budget ${budget._id}`);
    res.status(201).json({
      success: true,
      transfer: publicTransfer(created, budget),
      viewAs: req.budgetViewAs,
    });
  } catch (error) {
    console.error("[budget-proposals] transfer error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/transfers", async (req, res) => {
  try {
    const s = await scope(req, res);
    if (!s) return;
    if (!s.slugs.length) return res.json({ success: true, transfers: [] });

    const budgets = await Acc_Budget.find({
      companyId: s.companyId,
      "transfers.0": { $exists: true },
    })
      .sort({ startDate: -1 })
      .limit(24)
      .lean();

    const resolver = await departments.departmentResolver({ companyId: s.companyId });
    const mine = new Set(s.slugs);
    const ours = (name) => {
      const r = resolver.resolve(name);
      return Boolean(r && mine.has(r.slug));
    };

    const rows = [];
    for (const b of budgets) {
      for (const t of b.transfers || []) {
        const fromMine = ours(t.fromSnapshot?.department);
        const toMine = ours(t.toSnapshot?.department);
        if (!fromMine && !toMine) continue;

        const row = publicTransfer(t, b);
        /* A transfer finance raised between our line and another department's
           must not name theirs. Only the side we hold is identified. */
        if (!fromMine) row.fromLedgerName = "another department";
        if (!toMine) row.toLedgerName = "another department";
        rows.push(row);
      }
    }
    rows.sort((x, y) => new Date(y.requestedAt || 0) - new Date(x.requestedAt || 0));

    res.json({ success: true, transfers: rows, viewAs: req.budgetViewAs });
  } catch (error) {
    console.error("[budget-proposals] transfers list error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/transfers/:transferId/cancel", async (req, res) => {
  try {
    const s = await scope(req, res);
    if (!s) return;
    if (!s.slugs.length) {
      return res.status(403).json({ success: false, message: "No budget department is linked to you." });
    }

    const budget = await Acc_Budget.findOne({ _id: req.body?.budgetId, companyId: s.companyId });
    if (!budget) return res.status(404).json({ success: false, message: "Transfer not found." });

    const t = budget.transfers?.id?.(req.params.transferId);
    if (!t) return res.status(404).json({ success: false, message: "Transfer not found." });

    const resolver = await departments.departmentResolver({ companyId: s.companyId });
    const mine = new Set(s.slugs);
    const ours = (name) => {
      const r = resolver.resolve(name);
      return Boolean(r && mine.has(r.slug));
    };
    if (!ours(t.fromSnapshot?.department) && !ours(t.toSnapshot?.department)) {
      return res.status(404).json({ success: false, message: "Transfer not found." });
    }

    /* Only a department's OWN ask. Withdrawing one finance raised would be
       answering for them. */
    if (t.origin !== "department") {
      return res.status(403).json({
        success: false,
        message: "Finance raised this transfer; only finance can withdraw it.",
      });
    }

    if (t.state !== "submitted") {
      return res.status(409).json({
        success: false,
        message: `This transfer is ${t.state} and can no longer be withdrawn.`,
      });
    }

    t.state = "cancelled";
    t.reviewedAt = new Date();
    await budget.save();
    res.json({ success: true, transfer: publicTransfer(t, budget) });
  } catch (error) {
    console.error("[budget-proposals] transfer cancel error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── ACTION CENTRE ───────────────────────────────────────────────────────────
 * Everything a department head needs to know on opening /budget, in one call.
 *
 * ── WHY ONE ENDPOINT AND NOT FIVE ──────────────────────────────────────────
 * The alerts are cross-cutting: a cycle closing matters because of what is
 * NOT in it, and a countered line matters more when that cycle closes on
 * Friday. Derived from five separate reads on the client, those relationships
 * would have to be rebuilt there — and the client cannot be the place that
 * decides what a department is allowed to be told.
 *
 * Every row below is fetched through the same helpers the rest of this file
 * uses, so the scoping is not re-implemented: `scope()` fails closed, and
 * nothing here widens it. No company-wide figure is computed.
 */
router.get("/action-centre", async (req, res) => {
  try {
    const s = await scope(req, res);
    if (!s) return;
    const empty = {
      needsYourAnswer: [], waitingOnFinance: [], financeUpdates: [],
      financialRisks: [], deadlines: [],
      counts: { needsYourAnswer: 0, waitingOnFinance: 0, financeUpdates: 0, financialRisks: 0, deadlines: 0, actionable: 0 },
    };
    if (!s.slugs.length) return res.json({ success: true, ...empty });

    const [cycleData, mine, trackerData] = await Promise.all([
      proposals.openCycles({ companyId: s.companyId, allowedSlugs: s.slugs }),
      proposals.myRequests({ companyId: s.companyId, allowedSlugs: s.slugs }),
      trackerFor(req, s),
    ]);

    /* Adjustments and transfers, narrowed by the same department resolution
     * the list endpoints use. A transfer is included when EITHER side touches
     * this department — it changes their budget whichever way it moves. */
    const budgets = await Acc_Budget.find({
      companyId: s.companyId,
      $or: [{ "adjustments.0": { $exists: true } }, { "transfers.0": { $exists: true } }],
    })
      .sort({ startDate: -1 })
      .limit(24)
      .lean();

    const resolver = await departments.departmentResolver({ companyId: s.companyId });
    const mineSlugs = new Set(s.slugs);
    const ours = (name) => {
      const r = resolver.resolve(name);
      return Boolean(r && mineSlugs.has(r.slug));
    };

    const adjRows = [];
    const trRows = [];
    for (const b of budgets) {
      for (const a of b.adjustments || []) {
        if (!ours(a.department)) continue;
        adjRows.push({
          _id: String(a._id), budgetId: String(b._id), ledgerName: a.ledgerName ?? null,
          nature: a.nature || "expense", type: a.type, state: a.state,
          requestedDeltaAmount: a.requestedDeltaAmount ?? null,
          requestedNewAmount: a.requestedNewAmount ?? null,
          approvedNewAmount: a.approvedNewAmount ?? null,
          financeNote: a.financeNote ?? null,
          requestedAt: a.requestedAt ?? null, reviewedAt: a.reviewedAt ?? null,
        });
      }
      for (const t of b.transfers || []) {
        if (!ours(t.fromSnapshot?.department) && !ours(t.toSnapshot?.department)) continue;
        trRows.push({
          _id: String(t._id), budgetId: String(b._id), state: t.state, amount: t.amount ?? null,
          /* Only the names of lines this department holds. A transfer from
           * another department's head into ours must not name theirs. */
          fromLedgerName: ours(t.fromSnapshot?.department) ? t.fromSnapshot?.ledgerName ?? null : "another department",
          toLedgerName: ours(t.toSnapshot?.department) ? t.toSnapshot?.ledgerName ?? null : "another department",
          requestedAt: t.requestedAt ?? null, reviewedAt: t.reviewedAt ?? null,
        });
      }
    }

    const built = actionCentre.buildActionCentre({
      cycles: cycleData || [],
      requests: mine.requests || [],
      adjustments: adjRows,
      transfers: trRows,
      tracker: trackerData,
      now: new Date(),
    });

    res.json({ success: true, ...built, viewAs: req.budgetViewAs });
  } catch (error) {
    console.error("[budget-proposals] action centre error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── TRACKER ──────────────────────────────────────────────────────────────
 * What finance APPROVED for this department, and what has actually been spent
 * or earned against it — per budget head, and month by month.
 *
 * This is the other half of the conversation the rest of this router carries.
 * Proposals end when finance agrees a number; from that moment the department's
 * question stops being "will you fund this" and becomes "how am I doing against
 * what you funded". Until this endpoint existed the app could only answer the
 * first, and the screen had to say so.
 *
 * ── WHICH BUDGETS COUNT ───────────────────────────────────────────────────
 * Only budgets finance has actually put into force — `active`, `closed` or
 * `exceeded`. A draft or a collecting round is a proposal, not an approval, and
 * tracking spend against one would report performance against a number nobody
 * agreed to. Those rounds are already on this screen, as cycles.
 *
 * ── SCOPING ───────────────────────────────────────────────────────────────
 * `scope()` fails closed exactly as everywhere else here, and lines are then
 * narrowed to the caller's own departments by resolved slug — not by the raw
 * string on the line, which is written several ways. Nothing company-wide is
 * returned: no other department's heads, no company totals, no approval queue.
 */
/**
 * The department's tracker, as data rather than a response.
 *
 * Extracted when the action centre needed the same figures to decide what is
 * at risk. Two computations of "what has this department actually spent"
 * would eventually disagree, and the alert would be the one nobody could
 * reconcile against the table under it.
 *
 * Returns null when there is nothing in force — the same thing the endpoint
 * reports as an empty tracker.
 */
async function trackerFor(req, s) {
  if (!s.slugs.length) return null;

  const asOf = req.query.asOf ? new Date(req.query.asOf) : new Date();
  if (Number.isNaN(asOf.getTime())) return null;

  const filter = {
    companyId: s.companyId,
    status: { $in: ["active", "closed", "exceeded"] },
  };
  if (req.query.financialYear) filter.financialYear = String(req.query.financialYear);

  const budgets = await Acc_Budget.find(filter).sort({ startDate: -1 }).limit(24).lean();
  if (!budgets.length) return null;

  const resolver = await departments.departmentResolver({ companyId: s.companyId });
  const mine = new Set(s.slugs);
  const ownsLine = (line) => {
    const resolved = resolver.resolve(line && line.department);
    return Boolean(resolved && mine.has(resolved.slug));
  };

  const perBudget = await Promise.all(
    budgets.map(async (budget) => {
      const own = (budget.items || []).filter(ownsLine);
      if (!own.length) return null;

      const hydrated = await actuals.hydrateLines({
        companyId: budget.companyId || s.companyId,
        lines: own,
        from: budget.startDate,
        to: budget.endDate,
      });

      const evaluated = hydrated.map((line) => ({
        ...line,
        ...variance.evaluateLine({
          allocated: line.allocatedAmount,
          actual: line.actual,
          nature: line.nature,
          startDate: budget.startDate,
          endDate: budget.endDate,
          asOf,
          phasing: line.phasing,
          phasingMode: line.phasingMode,
          monthlyPhasing: line.monthlyPhasing,
        }),
      }));

      return { budget, evaluated };
    }),
  );

  const live = perBudget.filter(Boolean);
  if (!live.length) return null;

  const heads = tracker.mergeHeads(
    live.flatMap(({ budget, evaluated }) => evaluated.map((l) => tracker.publicHead(l, budget))),
  );

  const lead = live[0];
  const ledgerIds = lead.evaluated.map((l) => l.ledgerId).filter(Boolean);
  const movements = ledgerIds.length
    ? await actuals.monthlyMovement({
        companyId: lead.budget.companyId || s.companyId,
        ledgerIds,
        from: lead.budget.startDate,
        to: lead.budget.endDate,
      })
    : [];

  const seriesFor = (nature) =>
    tracker.monthlySeries({
      lines: lead.evaluated,
      movements,
      from: lead.budget.startDate,
      to: lead.budget.endDate,
      nature,
    });

  return {
    asOf,
    totals: tracker.totals(heads),
    heads,
    months: {
      expense: seriesFor("expense"),
      revenue: seriesFor("revenue"),
      budgetName: lead.budget.name || null,
      financialYear: lead.budget.financialYear || null,
      startDate: lead.budget.startDate,
      endDate: lead.budget.endDate,
    },
    budgets: live.map(({ budget }) => ({
      _id: String(budget._id),
      name: budget.name,
      financialYear: budget.financialYear,
      status: budget.status,
      startDate: budget.startDate,
      endDate: budget.endDate,
    })),
  };
}

router.get("/tracker", async (req, res) => {
  try {
    const s = await scope(req, res);
    if (!s) return;
    const data = await trackerFor(req, s);
    if (!data) {
      return res.json({ success: true, heads: [], totals: null, months: [], budgets: [] });
    }
    res.json({ success: true, ...data });
  } catch (error) {
    console.error("[budget-proposals] tracker error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});


/**
 * The monthly shape a department may set, checked against its own amount and
 * the cycle's window.
 *
 * ── WHY THIS IS NOT JUST ANOTHER WHITELISTED FIELD ──────────────────────────
 * `phasingMode` and `monthlyPhasing` only mean anything together, and only
 * relative to two things the body does not carry: the requested amount and the
 * cycle's date range. A split that adds up to 3L on a 4L ask, or that names a
 * month outside the cycle, is not a formatting problem — it is a plan that
 * cannot be funded, and storing it would put a line in the books whose shape
 * disagrees with its own total. So it goes through the same
 * `normalisePhasing` finance's own agree and counter paths use: one rule, one
 * place, no chance of the two sides validating differently.
 *
 * `current` lets a revise that changes ONLY the amount be re-checked against
 * the split already stored. Skipping that is how a line ends up with a
 * still-valid-looking split that no longer sums to the number beside it.
 *
 * Throws PhasingError; both callers turn that into a 400 with its code.
 */
function proposalPhasing({ body, amount, budget, current }) {
  const sent = body?.phasingMode !== undefined || body?.monthlyPhasing !== undefined;
  const mode = sent ? body?.phasingMode : current?.phasingMode;
  const rows = sent ? body?.monthlyPhasing : current?.monthlyPhasing;

  /* Anything that is not an explicit custom split is even, and an even line
     stores NO rows — a stale split left behind would silently reactivate if
     the mode were ever flipped back. */
  if (mode !== "custom_monthly") return { phasingMode: "even", monthlyPhasing: [] };

  return phasing.normalisePhasing({
    phasingMode: "custom_monthly",
    monthlyPhasing: rows,
    amount,
    startDate: budget.startDate,
    endDate: budget.endDate,
  });
}

/**
 * The line-by-line derivation a department may state, recomputed and
 * reconciled against the amount it claims to build.
 *
 * Like `proposalPhasing`, this cannot be a whitelisted field: the rows only
 * mean anything against the requested amount, and the client's own row totals
 * are not trusted at all. `current` lets a revise that changes ONLY the amount
 * be re-checked against the breakdown already stored — otherwise a request
 * ends up asking for a figure its own rows contradict.
 *
 * Throws WorkingError; both callers turn that into a 400 with its code.
 */
function proposalWorking({ body, amount, current }) {
  const sent = body?.workingLines !== undefined;
  const rows = sent ? body.workingLines : current?.workingLines;
  const { lines, total } = working.normaliseWorkingLines(rows);

  /* An override only travels with the rows it explains. A revise that resends
     the breakdown but not the override flag is dropping the override. */
  const override = sent
    ? body?.manualAmountOverride === true
    : Boolean(current?.manualAmountOverride);
  const reason = sent ? body?.manualOverrideReason : current?.manualOverrideReason;

  const settled = working.reconcileAmount({
    total,
    requestedAmount: amount,
    manualAmountOverride: override,
    manualOverrideReason: reason,
  });

  return {
    workingLines: lines,
    workingTotal: total,
    manualAmountOverride: settled.manualAmountOverride,
    manualOverrideReason: settled.manualOverrideReason,
  };
}

/**
 * The 409 a duplicate earns.
 *
 * Carries the existing row's id and state so the client can link to it rather
 * than telling someone "already requested" and leaving them to find it. Safe
 * to expose: the caller was only allowed to reach this point because the
 * budget and department already resolved to theirs.
 */
function duplicateResponse(res, flow, existing, message) {
  return res.status(409).json({
    success: false,
    code: duplicates.CODES[flow],
    message,
    existing: existing
      ? {
          id: String(existing._id),
          state: existing.requestedHead ? existing.requestedHead.state : existing.state,
        }
      : null,
  });
}

/** The fields a department may set. Built key by key rather than spread: a
 *  spread would let a caller set state, agreedAmount or submittedBy — finance's
 *  side of the exchange and the server's respectively. */
function proposalFields(body, resolver) {
  return {
    requestedAmount: variance.money(body.requestedAmount),
    priority: ["low", "normal", "high", "critical"].includes(body.priority)
      ? body.priority
      : "normal",
    purpose: body.purpose ? String(body.purpose).trim() : undefined,
    justification: body.justification ? String(body.justification).trim() : undefined,
    expectedMonth: body.expectedMonth || undefined,
    expectedFrom: body.expectedFrom || undefined,
    expectedTo: body.expectedTo || undefined,
    note: body.note ? String(body.note).trim() : undefined,
  };
}

/**
 * Build one submittable request row, or explain why it cannot be built.
 *
 * Extracted when the department form became a multi-line page. Both the single
 * POST and the bulk POST run this, so a line submitted on its own and the same
 * line submitted alongside four others are validated by identical code — the
 * alternative is two ladders of checks that drift, and the bulk one being the
 * looser of the two is exactly the accident worth preventing.
 *
 * Returns `{ ok: true, row }` or `{ ok: false, status, message, code }`. It
 * does not touch the budget document: the caller decides whether to push, so
 * a bulk submit can validate every line BEFORE writing any of them.
 */
async function buildRequestRow({ line, scope: s, budget }) {
  const gate = proposals.canSubmitFor({
    department: line?.department,
    allowedSlugs: s.slugs,
    budget,
  });
  /* `code` travels with the refusal. The window ones carry a date in their
     message and a code the screen keys off to say "opens on" versus "closed
     on" — dropping it here left the department app with prose it could not
     tell apart. */
  if (!gate.ok) {
    return { ok: false, status: gate.status, message: gate.message, code: gate.code };
  }

  const amount = variance.money(line?.requestedAmount);
  if (amount === null || amount < 0) {
    return { ok: false, status: 400, message: "requestedAmount must be a number ≥ 0" };
  }
  if (!line?.purpose && !line?.justification) {
    return {
      ok: false,
      status: 400,
      message: "Say what the money is for — a purpose or a justification.",
    };
  }

  /* ── EITHER AN EXISTING HEAD, OR A REQUEST FOR ONE ───────────────────────
   * A department budgeting for something the chart of accounts has no head
   * for should not have to file it under whatever is closest. It asks for a
   * head instead; finance decides whether that becomes a ledger, maps onto an
   * existing one, or is refused.
   *
   * The department NEVER creates a ledger here — nothing in this branch
   * touches Acc_Ledger. It writes a stated intention that finance resolves. */
  const wantsNewHead = !line?.ledgerId && line?.requestedHead;
  let ledger = null;
  let requestedHead;

  if (wantsNewHead) {
    const rh = line.requestedHead;
    const name = rh?.name ? String(rh.name).trim().slice(0, 120) : "";
    if (!name) {
      return { ok: false, status: 400, message: "Name the budget head you need." };
    }
    const nature = rh?.nature === "revenue" ? "revenue" : rh?.nature === "expense" ? "expense" : null;
    if (!nature) {
      return {
        ok: false,
        status: 400,
        message: "Say whether the new head is a revenue target or an expense budget.",
      };
    }
    const reason = rh?.reason ? String(rh.reason).trim().slice(0, 500) : "";
    if (!reason) {
      /* Without this finance is asked to add a head to the chart of accounts
       * on no stated grounds, which is how a chart of accounts becomes a list
       * of near-duplicates. */
      return {
        ok: false,
        status: 400,
        message: "Say why the existing heads do not fit — finance decides on that reason.",
      };
    }

    /* A hint, validated only if it names something real in this company.
     * A bad hint is dropped rather than refused: it is a suggestion. */
    let suggestedLedgerId;
    if (rh?.suggestedLedgerId) {
      const hint = await Acc_Ledger.findOne({ _id: rh.suggestedLedgerId, companyId: s.companyId })
        .select("_id")
        .lean();
      if (hint) suggestedLedgerId = hint._id;
    }

    requestedHead = {
      name,
      nature,
      reason,
      suggestedGroupName: rh?.suggestedGroupName
        ? String(rh.suggestedGroupName).trim().slice(0, 120)
        : undefined,
      suggestedLedgerId,
      state: "requested",
    };
  } else {
    ledger = await Acc_Ledger.findOne({ _id: line?.ledgerId, companyId: s.companyId })
      .select("_id name groupName nature")
      .lean();
    if (!ledger) {
      return {
        ok: false,
        status: 400,
        message: "Pick a budget head, or ask finance for a new one.",
      };
    }
  }

  let shape;
  let derivation;
  try {
    shape = proposalPhasing({ body: line, amount, budget });
    derivation = proposalWorking({ body: line, amount });
  } catch (e) {
    if (e instanceof phasing.PhasingError || e instanceof working.WorkingError) {
      return { ok: false, status: 400, message: e.message, code: e.code };
    }
    throw e;
  }

  /* Stored under the registry's spelling, so the department that submits and
   * the section finance sees are the same one. */
  /* Matched on either spelling, for the same reason `slugsOf` carries both —
     a line naming "Human Resources" and one naming "hr" are one department,
     and both store the registry's name so finance sees one section. */
  const asked = departments.slugify(line.department);
  const canonical =
    s.allowed.find((d) => d.slug === asked || departments.slugify(d.name) === asked)?.name ||
    departments.displayOf(line.department);

  return {
    ok: true,
    row: {
      department: canonical,
      /* No ledger yet when a head was requested — finance writes one onto this
         field when it resolves, and only then can the request be agreed. */
      ledgerId: ledger ? ledger._id : undefined,
      ledgerName: ledger ? ledger.name : requestedHead.name,
      groupName: ledger ? ledger.groupName : requestedHead.suggestedGroupName,
      nature: ledger
        ? ledger.nature === "revenue"
          ? "revenue"
          : "expense"
        : requestedHead.nature,
      requestedHead,
      ...proposalFields(line),
      phasingMode: shape.phasingMode,
      monthlyPhasing: shape.monthlyPhasing,
      workingLines: derivation.workingLines,
      manualAmountOverride: derivation.manualAmountOverride,
      manualOverrideReason: derivation.manualOverrideReason,
      state: "submitted",
    },
  };
}

/* ── SUBMIT ──────────────────────────────────────────────────────────────── */
router.post("/:budgetId/requests", async (req, res) => {
  try {
    const s = await scope(req, res);
    if (!s) return;

    const budget = await Acc_Budget.findOne({
      _id: req.params.budgetId,
      companyId: s.companyId,
    });

    const built = await buildRequestRow({ line: req.body, scope: s, budget });
    if (!built.ok) {
      return res
        .status(built.status)
        .json({ success: false, message: built.message, ...(built.code ? { code: built.code } : {}) });
    }

    const now = new Date();
    const actor = req.user.email || req.user.name || req.user.id;
    if (built.row.requestedHead) {
      /* Server-derived, for the same reason `submittedBy` is: a department
         naming its own requester could file as someone else. */
      built.row.requestedHead.requestedBy = actor;
      built.row.requestedHead.requestedAt = now;
    }

    /* ── ALREADY ASKED? ────────────────────────────────────────────────
     * Two open lines on one head in one cycle are one intention filed twice.
     * Finance ends up agreeing both, and the department's own record shows a
     * head it asked for at two different figures. */
    const dupHead = built.row.requestedHead
      ? duplicates.openHeadRequestFor(budget, {
          name: built.row.requestedHead.name,
          nature: built.row.requestedHead.nature,
          department: built.row.department,
        })
      : null;
    if (dupHead) {
      return duplicateResponse(
        res,
        "requestedHead",
        dupHead,
        `You have already asked finance for a head called "${dupHead.requestedHead.name}" in this cycle. Wait for their answer, or revise that request.`,
      );
    }

    const dupLine = duplicates.openProposalFor(budget, {
      department: built.row.department,
      ledgerId: built.row.ledgerId,
      nature: built.row.nature,
    });
    if (dupLine) {
      return duplicateResponse(
        res,
        "proposal",
        dupLine,
        `${dupLine.ledgerName || "That head"} already has an open line in this cycle. Revise it rather than proposing it twice.`,
      );
    }

    budget.budgetRequests.push({
      ...built.row,
      submittedAt: now,
      /* Server-derived. A department naming its own submitter would let one
       * person file as another. */
      submittedBy: req.user.email || req.user.name || req.user.id,
    });

    await budget.save();
    const created = budget.budgetRequests[budget.budgetRequests.length - 1];
    auditNote(req, "SUBMIT", `${created.department} · ${created.requestedAmount} · budget ${budget._id}`);
    res.status(201).json({
      success: true,
      request: proposals.publicRequest(created, budget),
      viewAs: req.budgetViewAs,
    });
  } catch (error) {
    console.error("[budget-proposals] submit error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── SUBMIT MANY ─────────────────────────────────────────────────────────────
 * A whole proposal at once: several heads, each with its own amount, monthly
 * shape and working.
 *
 * ── WHY THIS EXISTS RATHER THAN N CALLS ────────────────────────────────────
 * A department drafting five lines and firing five POSTs has five chances to
 * half-succeed. Line three failing validation would leave one and two already
 * filed and finance looking at a proposal that is missing its middle — with
 * nothing on either screen saying so. Every line lands in the SAME budget
 * document, so validating all of them before a single `save()` makes the
 * submit atomic for free. All of it arrives, or none of it does.
 *
 * The refusal names WHICH line failed, because "row 3: the monthly split does
 * not add up" is actionable and "invalid request" is not.
 */
router.post("/:budgetId/requests/bulk", async (req, res) => {
  try {
    const s = await scope(req, res);
    if (!s) return;

    const lines = Array.isArray(req.body?.lines) ? req.body.lines : null;
    if (!lines || lines.length === 0) {
      return res.status(400).json({ success: false, message: "Send at least one line." });
    }
    /* The same ceiling the working breakdown uses, for the same reason: an
       unbounded push into one document is how a cycle becomes slow to read. */
    if (lines.length > 40) {
      return res
        .status(400)
        .json({ success: false, message: "Send at most 40 lines at a time." });
    }

    const budget = await Acc_Budget.findOne({
      _id: req.params.budgetId,
      companyId: s.companyId,
    });

    // Validate EVERY line first. Nothing is written until all of them pass.
    const rows = [];
    for (const [index, line] of lines.entries()) {
      const built = await buildRequestRow({ line, scope: s, budget });
      if (!built.ok) {
        return res.status(built.status).json({
          success: false,
          /* One-based: the person is looking at a list, not an array. */
          index,
          line: index + 1,
          message: `Line ${index + 1}: ${built.message}`,
          ...(built.code ? { code: built.code } : {}),
        });
      }
      /* Against what is already in the cycle... */
      const dupHead = built.row.requestedHead
        ? duplicates.openHeadRequestFor(budget, {
            name: built.row.requestedHead.name,
            nature: built.row.requestedHead.nature,
            department: built.row.department,
          })
        : null;
      if (dupHead) {
        return duplicateResponse(
          res,
          "requestedHead",
          dupHead,
          `Line ${index + 1}: you have already asked finance for a head called "${dupHead.requestedHead.name}" in this cycle.`,
        );
      }
      const dupLine = duplicates.openProposalFor(budget, {
        department: built.row.department,
        ledgerId: built.row.ledgerId,
        nature: built.row.nature,
      });
      if (dupLine) {
        return duplicateResponse(
          res,
          "proposal",
          dupLine,
          `Line ${index + 1}: ${dupLine.ledgerName || "that head"} already has an open line in this cycle.`,
        );
      }

      /* ...AND against the rest of this same submission. A sheet with the
         same head on two rows is the commonest way to file one intention
         twice, and neither row exists in the cycle yet for the checks above
         to catch. */
      const twiceInBatch = rows.find(
        (r) =>
          (built.row.ledgerId &&
            String(r.ledgerId || "") === String(built.row.ledgerId) &&
            (r.nature || "expense") === (built.row.nature || "expense")) ||
          (built.row.requestedHead &&
            r.requestedHead &&
            duplicates.normaliseHeadName(r.requestedHead.name) ===
              duplicates.normaliseHeadName(built.row.requestedHead.name) &&
            (r.requestedHead.nature || "expense") === (built.row.requestedHead.nature || "expense")),
      );
      if (twiceInBatch) {
        return res.status(409).json({
          success: false,
          code: built.row.requestedHead
            ? duplicates.CODES.requestedHead
            : duplicates.CODES.proposal,
          message: `Line ${index + 1}: ${
            built.row.ledgerName || "that head"
          } appears twice in this proposal. Put it on one line.`,
          existing: null,
        });
      }

      rows.push(built.row);
    }

    const submittedAt = new Date();
    const submittedBy = req.user.email || req.user.name || req.user.id;
    for (const row of rows) {
      if (row.requestedHead) {
        row.requestedHead.requestedBy = submittedBy;
        row.requestedHead.requestedAt = submittedAt;
      }
      budget.budgetRequests.push({ ...row, submittedAt, submittedBy });
    }

    await budget.save();

    const created = budget.budgetRequests.slice(-rows.length);
    auditNote(
      req,
      "SUBMIT_BULK",
      `${created.length} lines · ${created.reduce((t, r) => t + (r.requestedAmount || 0), 0)} · budget ${budget._id}`,
    );
    res.status(201).json({
      success: true,
      requests: created.map((r) => proposals.publicRequest(r, budget)),
      viewAs: req.budgetViewAs,
    });
  } catch (error) {
    console.error("[budget-proposals] bulk submit error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put("/:budgetId/requests/:requestId", async (req, res) => {
  try {
    const s = await scope(req, res);
    if (!s) return;

    const budget = await Acc_Budget.findOne({
      _id: req.params.budgetId,
      companyId: s.companyId,
    });
    if (!budget) return res.status(404).json({ success: false, message: "Budget cycle not found." });

    const row = budget.budgetRequests.id(req.params.requestId);
    if (!row) return res.status(404).json({ success: false, message: "Request not found." });

    /* Ownership first, and phrased so a refusal cannot be used to discover
     * another department's request ids. */
    if (!proposals.ownedBy(row, s.slugs)) {
      return res.status(404).json({ success: false, message: "Request not found." });
    }
    if (!proposals.OPEN_STATES.includes(budget.status)) {
      return res.status(409).json({
        success: false,
        message: `This cycle is ${budget.status}; it is no longer collecting requests.`,
      });
    }
    if (!proposals.EDITABLE_STATES.includes(row.state)) {
      return res.status(409).json({
        success: false,
        message: `This request is ${row.state} and can no longer be changed.`,
      });
    }

    const patch = proposalFields(req.body);

    /* Re-checked against the amount this revise will LEAVE on the row, not the
       one it arrived with. Changing 4L to 3L without resending the split has
       to fail here, or the line keeps a shape that no longer adds up to it. */
    const nextAmount = patch.requestedAmount !== null && patch.requestedAmount !== undefined
      ? patch.requestedAmount
      : row.requestedAmount;
    let shape;
    let derivation;
    try {
      shape = proposalPhasing({ body: req.body, amount: nextAmount, budget, current: row });
      derivation = proposalWorking({ body: req.body, amount: nextAmount, current: row });
    } catch (e) {
      if (e instanceof phasing.PhasingError || e instanceof working.WorkingError) {
        return res.status(400).json({ success: false, message: e.message, code: e.code });
      }
      throw e;
    }

    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined && v !== null) row[k] = v;
    }
    /* Assigned outside the loop because switching back to "even" must CLEAR
       the stored rows, and an empty array would be skipped as falsy-ish by a
       loop written to ignore absent fields. */
    row.phasingMode = shape.phasingMode;
    row.monthlyPhasing = shape.monthlyPhasing;
    /* Outside the patch loop for the same reason the phasing is: clearing a
       breakdown means writing an empty array, which a loop that skips absent
       fields would treat as nothing to do. */
    row.workingLines = derivation.workingLines;
    row.manualAmountOverride = derivation.manualAmountOverride;
    row.manualOverrideReason = derivation.manualOverrideReason;
    /* Answering a counter puts the ball back in finance's court. */
    if (row.state === "countered") row.state = "submitted";
    row.updatedAt = new Date();

    await budget.save();
    auditNote(req, "REVISE", `${row.department} · ${row.requestedAmount} · budget ${budget._id}`);
    res.json({
      success: true,
      request: proposals.publicRequest(row, budget),
      viewAs: req.budgetViewAs,
    });
  } catch (error) {
    console.error("[budget-proposals] update error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
