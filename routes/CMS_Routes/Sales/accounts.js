// routes/CMS_Routes/Sales/accounts.js
//
// CRM account list / detail / create / update / archive / restore, plus
// hierarchy, duplicate-check, and the enriched Step-01 detail (sites,
// departments, addresses, relationships, team, activity counts).
//
// Cross-cutting behaviour wired here:
//   • recordChange(...)  — every mutation is written to the ChangeLog audit.
//   • crmVisibility       — restricted commercial fields (credit/tax) are
//                           stripped from every response and dropped from
//                           unauthorized updates, enforced server-side.
//   • crmHierarchy        — parent changes are cycle-checked before they save.
// The mount-level salesWrites() guard already handles role + approval; an
// editor's write is held as a ChangeRequest before it ever reaches here.
const express = require("express");
const router = express.Router();
const Account = require("../../../models/CMS_Models/Sales/Account");
const Contact = require("../../../models/CMS_Models/Sales/Contact");
const Lead = require("../../../models/CMS_Models/Sales/Lead");
const Site = require("../../../models/CMS_Models/Sales/Site");
const Department = require("../../../models/CMS_Models/Sales/Department");
const Address = require("../../../models/CMS_Models/Sales/Address");
const Relationship = require("../../../models/CMS_Models/Sales/AccountRelationship");
const Team = require("../../../models/CMS_Models/Sales/AccountTeam");
const Activity = require("../../../models/CMS_Models/Sales/Activity");
const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");
const { recordChange, historyForWithChildren } = require("../../../services/changeLog");

// Sub-entities whose ChangeLog rows should surface on the parent account's
// audit tab — see services/changeLog.js historyForWithChildren.
const CHILD_ENTITIES = [
  "crm-contact", "crm-site", "crm-department", "crm-address",
  "crm-account-relationship", "crm-account-team", "crm-activity",
];
const { findAccountDuplicates } = require("../../../services/crmDuplicates");
const { assertNoAccountCycle, HierarchyError } = require("../../../services/crmHierarchy");
const { assertValidGarmentProfileRefs } = require("../../../services/crmGarmentProfile");
const {
  stripRestrictedAccountFields,
  stripRestrictedAccountList,
  stripRestrictedUpdates,
  canViewCredit,
} = require("../../../services/crmVisibility");
const { relationshipLabelFrom, LEAD_INACTIVE_CAPTURE_STATUSES } = require("../../../constants/crm");

const actor = (req) => ({ id: req.user?.id, name: req.user?.name || "" });

// ChangeLog.sanitise stringifies any nested object and truncates it at 500
// characters, which would clip the ~50-field Garment Sales Profile into an
// unreadable fragment and hide which field actually changed. Flattening it to
// dot-paths first means the diff is computed per field, so each audit entry
// names the exact profile field and stays small enough to survive intact.
function flattenProfileForAudit(doc) {
  if (!doc || !doc.garmentSalesProfile) return doc;
  const { garmentSalesProfile, ...rest } = doc;
  for (const [k, v] of Object.entries(garmentSalesProfile)) {
    rest[`garmentSalesProfile.${k}`] = v;
  }
  return rest;
}

// GET /api/cms/crm/accounts
router.get("/", salesAuth, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      search,
      type,
      status,
      industry,
      rating,
      role,
      lifecycleStage,
      tier,
      owner,
      includeArchived,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    const filter = {};
    if (includeArchived !== "true") filter.isActive = true;
    if (type && type !== "all") filter.type = type;
    if (status && status !== "all") filter.status = status;
    if (industry && industry !== "all") filter.industry = industry;
    if (rating && rating !== "all") filter.rating = rating;
    if (role && role !== "all") filter.roles = role;
    if (lifecycleStage && lifecycleStage !== "all") filter.lifecycleStage = lifecycleStage;
    if (tier && tier !== "all") filter.customerTier = tier;
    if (owner && owner !== "all") filter.assignedTo = owner;
    if (search) {
      const re = new RegExp(search, "i");
      filter.$or = [
        { companyName: re },
        { displayName: re },
        { legalName: re },
        { normalizedName: re },
        { primaryEmail: re },
        { primaryPhone: re },
        { accountId: re },
        { externalReference: re },
        { city: re },
      ];
    }

    const sort = {};
    sort[sortBy] = sortOrder === "asc" ? 1 : -1;

    const total = await Account.countDocuments(filter);
    const accounts = await Account.find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate("primaryContact", "firstName lastName email phone")
      .lean();

    const accountIds = accounts.map((a) => a._id);
    const [contactCounts, leadCounts] = await Promise.all([
      Contact.aggregate([
        { $match: { accountId: { $in: accountIds }, isActive: true } },
        { $group: { _id: "$accountId", count: { $sum: 1 } } },
      ]),
      Lead.aggregate([
        // Draft Lead chunk: a draft/archived Lead is not real pipeline, so it
        // must not inflate an account's leadCount or openLeadsValue. `$nin`
        // still counts legacy Leads with no captureStatus as active.
        { $match: { accountId: { $in: accountIds }, isActive: true, captureStatus: { $nin: LEAD_INACTIVE_CAPTURE_STATUSES } } },
        { $group: { _id: "$accountId", count: { $sum: 1 }, value: { $sum: "$estimatedValue" } } },
      ]),
    ]);

    const contactMap = Object.fromEntries(contactCounts.map((c) => [String(c._id), c.count]));
    const leadMap = Object.fromEntries(leadCounts.map((l) => [String(l._id), { count: l.count, value: l.value }]));

    const enriched = stripRestrictedAccountList(accounts, req.user).map((a) => ({
      ...a,
      contactCount: contactMap[String(a._id)] || 0,
      leadCount: leadMap[String(a._id)]?.count || 0,
      openLeadsValue: leadMap[String(a._id)]?.value || 0,
    }));

    const stats = {
      total: await Account.countDocuments({ isActive: true }),
      prospect: await Account.countDocuments({ isActive: true, type: "prospect" }),
      customer: await Account.countDocuments({ isActive: true, type: "customer" }),
      partner: await Account.countDocuments({ isActive: true, type: "partner" }),
      hot: await Account.countDocuments({ isActive: true, rating: "hot" }),
    };

    res.json({
      success: true,
      accounts: enriched,
      stats,
      // The server is the authority on restricted-field access; say so
      // explicitly rather than leaving the client to infer it from an absent
      // key (an unset field and a stripped field look identical).
      permissions: { canViewRestricted: canViewCredit(req.user) },
      pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error("[accounts] GET /", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/accounts/duplicate-check — read-shaped, bypasses approval.
// Returns candidate matches so the UI can warn before final save.
router.post("/duplicate-check", salesAuth, async (req, res) => {
  try {
    const matches = await findAccountDuplicates(Account, req.body || {}, req.body?.excludeId || null);
    res.json({ success: true, matches, hasHighConfidence: matches.some((m) => m.confidence === "high") });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/accounts
router.post("/", salesAuth, async (req, res) => {
  try {
    const data = { ...req.body };
    delete data.excludeId;
    if (data.garmentSalesProfile) {
      await assertValidGarmentProfileRefs(Account, data.garmentSalesProfile);
    }
    if (req.user) {
      data.assignedTo = data.assignedTo || req.user.id;
      data.assignedToName = data.assignedToName || req.user.name;
      data.createdBy = actor(req);
      data.updatedBy = actor(req);
    }
    const account = await Account.create(data);
    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-account",
      entityId: account._id,
      entityLabel: account.companyName,
      action: "create",
      summary: `Created account ${account.accountId} — ${account.companyName}`,
      after: account.toObject(),
    });
    res.status(201).json({ success: true, account: stripRestrictedAccountFields(account.toObject(), req.user) });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// GET /api/cms/crm/accounts/:id/hierarchy — parent chain + children + siblings
// + sites. This is what the account workspace's Group card reads: for one hotel
// in a chain it answers "who owns this, and which other properties are theirs".
router.get("/:id/hierarchy", salesAuth, async (req, res) => {
  try {
    const self = await Account.findById(req.params.id).select("accountId companyName parentAccountId").lean();
    if (!self) return res.status(404).json({ success: false, message: "Account not found" });

    // Walk UP the parent chain (bounded).
    const ancestors = [];
    let cursor = self.parentAccountId;
    const seen = new Set([String(self._id)]);
    while (cursor && !seen.has(String(cursor)) && ancestors.length < 50) {
      seen.add(String(cursor));
      const p = await Account.findById(cursor).select("accountId companyName parentAccountId").lean();
      if (!p) break;
      ancestors.push({ _id: p._id, accountId: p.accountId, companyName: p.companyName });
      cursor = p.parentAccountId;
    }

    // Siblings share this account's parent. Excluded when it has none: every
    // root account would otherwise "sibling" every other root account, which is
    // not a group, it is the whole customer list.
    const [children, siblings, sites] = await Promise.all([
      Account.find({ parentAccountId: self._id, isActive: true })
        .select("accountId companyName status lifecycleStage city").sort({ companyName: 1 }).lean(),
      self.parentAccountId
        ? Account.find({ parentAccountId: self.parentAccountId, isActive: true, _id: { $ne: self._id } })
            .select("accountId companyName status lifecycleStage city").sort({ companyName: 1 }).lean()
        : Promise.resolve([]),
      Site.find({ accountId: self._id, isActive: true }).select("siteId name siteType isPrimary").lean(),
    ]);

    // The group's root is the top ancestor, or this account when it has none —
    // so a parent opening its own page still sees "this group" rather than a
    // blank where its own name should be.
    const ordered = ancestors.reverse();
    const root = ordered[0] || { _id: self._id, accountId: self.accountId, companyName: self.companyName };

    res.json({
      success: true,
      account: self,
      root,
      isRoot: !self.parentAccountId,
      ancestors: ordered,
      parent: ordered.length ? ordered[ordered.length - 1] : null,
      children,
      siblings,
      sites,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/cms/crm/accounts/:id/history — audit trail from the existing
// ChangeLog (accounts + their sub-entities are all recorded there).
router.get("/:id/history", salesAuth, async (req, res) => {
  try {
    const history = await historyForWithChildren(
      "crm-account", req.params.id, CHILD_ENTITIES,
      ["accountId", "fromAccountId", "toAccountId"], 150,
    );
    res.json({ success: true, history });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/cms/crm/accounts/:id — enriched detail
router.get("/:id", salesAuth, async (req, res) => {
  try {
    const account = await Account.findById(req.params.id)
      .populate("primaryContact", "firstName lastName email phone designation")
      .populate("assignedTo", "name email")
      .populate("parentAccountId", "accountId companyName")
      // Populated so the workspace can NAME the portal customer rather than
      // print its id — the MPC section reads this to decide whether it has
      // anything to act on behalf of.
      .populate("linkedCustomer", "name email customerId profile.companyName")
      .populate("garmentSalesProfile.defaultPoIssuerAccountId", "accountId companyName")
      .populate("garmentSalesProfile.defaultBillToAccountId", "accountId companyName")
      .populate("garmentSalesProfile.defaultImporterAccountId", "accountId companyName")
      .populate("garmentSalesProfile.defaultAgentAccountId", "accountId companyName")
      .populate("garmentSalesProfile.nominatedLaboratoryAccountIds", "accountId companyName")
      .populate("garmentSalesProfile.nominatedSupplierAccountIds", "accountId companyName")
      .lean();
    if (!account) return res.status(404).json({ success: false, message: "Account not found" });

    const [contacts, leads, sites, departments, addresses, team, relationships, activityAgg] = await Promise.all([
      Contact.find({ accountId: req.params.id, isActive: true })
        .select("firstName lastName email phone mobile designation jobTitle roles isPrimary status siteId departmentId")
        .lean(),
      // Draft/archived Leads are excluded from an account's related-leads
      // list too — same active-only rule as the count above.
      Lead.find({ accountId: req.params.id, isActive: true, captureStatus: { $nin: LEAD_INACTIVE_CAPTURE_STATUSES } })
        .select("leadId firstName lastName stage estimatedValue priority expectedCloseDate")
        .lean(),
      Site.find({ accountId: req.params.id, isActive: true }).lean(),
      Department.find({ accountId: req.params.id, isActive: true }).lean(),
      Address.find({ accountId: req.params.id, isActive: true }).lean(),
      Team.find({ accountId: req.params.id, isActive: true }).populate("userId", "name email").lean(),
      Relationship.find({
        isActive: true,
        $or: [{ fromAccountId: req.params.id }, { toAccountId: req.params.id }],
      })
        .populate("fromAccountId", "accountId companyName")
        .populate("toAccountId", "accountId companyName")
        .lean(),
      Activity.aggregate([
        { $match: { accountId: account._id, isActive: true } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
    ]);

    // Render each relationship from THIS account's perspective (correct label).
    const relationshipsView = relationships.map((r) => {
      const persp = relationshipLabelFrom(r, req.params.id);
      return {
        _id: r._id,
        relationshipId: r.relationshipId,
        relationshipType: r.relationshipType,
        label: persp.label,
        direction: persp.direction,
        otherAccount: persp.otherAccountId,
        isPrimary: r.isPrimary,
        startDate: r.startDate,
        endDate: r.endDate,
        notes: r.notes,
      };
    });

    const activityCounts = Object.fromEntries(activityAgg.map((a) => [a._id, a.count]));

    res.json({
      success: true,
      account: stripRestrictedAccountFields(account, req.user),
      contacts,
      leads,
      sites,
      departments,
      addresses,
      team,
      relationships: relationshipsView,
      activityCounts,
      permissions: { canViewRestricted: canViewCredit(req.user) },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/cms/crm/accounts/:id
router.patch("/:id", salesAuth, async (req, res) => {
  try {
    // Loaded as a real document (not findByIdAndUpdate) so document middleware
    // — including the Garment Sales Profile's cross-field pre("validate")
    // hook, which query-style updates bypass entirely — actually runs.
    const account = await Account.findById(req.params.id);
    if (!account) return res.status(404).json({ success: false, message: "Account not found" });
    const before = account.toObject();

    // Cycle-safety before we touch the tree.
    if ("parentAccountId" in req.body) {
      await assertNoAccountCycle(Account, req.params.id, req.body.parentAccountId || null);
    }
    if ("garmentSalesProfile" in req.body) {
      await assertValidGarmentProfileRefs(Account, req.body.garmentSalesProfile);
    }

    const update = stripRestrictedUpdates({ ...req.body }, req.user);
    update.updatedBy = actor(req);

    for (const [key, value] of Object.entries(update)) {
      // Merge (not replace) the nested profile so a partial save doesn't wipe
      // sibling fields the caller didn't send.
      if (key === "garmentSalesProfile" && value && typeof value === "object") {
        account.garmentSalesProfile = { ...(before.garmentSalesProfile || {}), ...value };
      } else {
        account[key] = value;
      }
    }
    await account.save();

    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-account",
      entityId: account._id,
      entityLabel: account.companyName,
      action: "update",
      before: flattenProfileForAudit(before),
      after: flattenProfileForAudit(account.toObject()),
    });

    res.json({ success: true, account: stripRestrictedAccountFields(account.toObject(), req.user) });
  } catch (err) {
    if (err instanceof HierarchyError) return res.status(err.status).json({ success: false, message: err.message });
    res.status(400).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/accounts/:id/archive — soft archive with a required reason.
router.post("/:id/archive", salesAuth, async (req, res) => {
  try {
    const { reason } = req.body || {};
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ success: false, message: "An archive reason is required." });
    }
    const before = await Account.findById(req.params.id).lean();
    if (!before) return res.status(404).json({ success: false, message: "Account not found" });

    // Impact surface — returned so the caller can show what archiving affects.
    const [openTasks, activeRelationships, children] = await Promise.all([
      Activity.countDocuments({ accountId: req.params.id, status: "planned", isActive: true }),
      Relationship.countDocuments({ isActive: true, $or: [{ fromAccountId: req.params.id }, { toAccountId: req.params.id }] }),
      Account.countDocuments({ parentAccountId: req.params.id, isActive: true }),
    ]);

    const account = await Account.findByIdAndUpdate(
      req.params.id,
      { status: "archived", isActive: false, archivedAt: new Date(), archivedBy: actor(req) },
      { new: true },
    );

    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-account",
      entityId: account._id,
      entityLabel: account.companyName,
      action: "archive",
      summary: `Archived ${account.accountId} — reason: ${reason}`,
      before,
      after: account.toObject(),
    });

    res.json({ success: true, account, impact: { openTasks, activeRelationships, children } });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/accounts/:id/restore
router.post("/:id/restore", salesAuth, async (req, res) => {
  try {
    const before = await Account.findById(req.params.id).lean();
    if (!before) return res.status(404).json({ success: false, message: "Account not found" });

    const account = await Account.findByIdAndUpdate(
      req.params.id,
      { status: "active", isActive: true, archivedAt: null, archivedBy: null },
      { new: true },
    );

    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-account",
      entityId: account._id,
      entityLabel: account.companyName,
      action: "restore",
      summary: `Restored ${account.accountId}`,
      before,
      after: account.toObject(),
    });

    res.json({ success: true, account: stripRestrictedAccountFields(account.toObject(), req.user) });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// DELETE /api/cms/crm/accounts/:id — legacy soft delete (kept for the existing
// accounts page). Archiving via /:id/archive is preferred.
router.delete("/:id", salesAuth, async (req, res) => {
  try {
    const account = await Account.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!account) return res.status(404).json({ success: false, message: "Account not found" });
    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-account",
      entityId: account._id,
      entityLabel: account.companyName,
      action: "delete",
      summary: `Soft-deleted ${account.accountId}`,
    });
    res.json({ success: true, message: "Account deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
