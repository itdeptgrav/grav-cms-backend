// routes/Accountant_Routes/Acc_chartOfAccounts.js
// =============================================================================
// CHART OF ACCOUNTS — Groups + Ledgers
// -----------------------------------------------------------------------------
// Endpoints:
//   GET    /tree                        — Group→Ledger tree (with rollups)
//   GET    /trial-balance               — Flat trial balance (Dr/Cr columns,
//                                          group totals, balanced check)
//   GET    /groups, POST/PUT/DELETE     — Group CRUD
//   GET    /groups/:id/statement        — Consolidated statement for a group
//                                          (all descendant ledgers in one view)
//   GET    /ledgers, POST/PUT/DELETE    — Ledger CRUD
//   GET    /ledgers/:id/statement       — Ledger statement (running balance,
//                                          monthly + daily buckets, contra
//                                          entries, bill-wise outstanding,
//                                          previous-period comparison)
//   POST   /ledgers/:id/transactions    — Quick add 2-line journal voucher
//   POST   /ledgers/:id/transfer-balance — Move (full or partial) balance from
//                                          one ledger to another via journal
//   GET    /gstin-lookup/:gstin         — Validate GSTIN format + checksum,
//                                          extract state + PAN; optional API
//                                          fetch (env-configured) for name/addr
//   GET    /payroll/runs                — List payroll runs + posting status
//   GET    /payroll/runs/:id/preview    — Preview salary journal voucher
//   POST   /payroll/runs/:id/post       — Post a single payroll run as voucher
//   POST   /payroll/runs/post-all       — Post every unposted run
//   POST   /payroll/runs/:id/unpost     — Cancel the auto-created vouchers
//                                          (handles paid runs with two vouchers)
//   POST   /seed-manufacturing          — Seed manufacturing-industry chart
//   GET    /parties/preview             — Preview party-ledger sync (dry-run)
//   POST   /parties/sync                — Create Sundry Debtor / Creditor
//                                          ledgers from CMS Customer + Vendor
// =============================================================================

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");
const {
  Acc_Group,
  Acc_Ledger,
  ACC_DEFAULT_GROUPS,
} = require("../../models/Accountant_model/Acc_MasterModels");
const {
  Acc_Voucher,
} = require("../../models/Accountant_model/Acc_VoucherModels");
// Payroll models live in the HR module. We require them lazily inside the
// payroll endpoints below so this route file still loads on systems that don't
// have the HR module installed yet.

router.use(accountantAuth);

// ─────────────────────────────────────────────────────────────────────────
// Helper — ensure the 28 default Tally groups exist for a company.
//
// Some companies in the wild were created before the auto-seed-on-create
// behaviour existed, OR seeding silently failed (race condition during
// company creation). Result: their chart is empty and every downstream
// feature (seed-manufacturing, parties sync, group create) fails with
// "Default Tally groups missing".
//
// This helper is idempotent: it skips groups whose name already exists,
// so calling it on a partially-seeded company tops it up without
// duplicating anything. We keep this LOCAL to this file rather than
// importing from tallyCompanies.js to avoid a circular dependency.
//
// Returns the count of groups CREATED (not total).
// ─────────────────────────────────────────────────────────────────────────
async function ensureDefaultGroups(companyId, createdBy) {
  if (!Array.isArray(ACC_DEFAULT_GROUPS) || ACC_DEFAULT_GROUPS.length === 0) {
    return 0;
  }

  // Index existing groups by lowercased name so we can skip-or-create
  const existing = await Acc_Group.find({ companyId }).lean();
  const byName = new Map(existing.map((g) => [g.name.toLowerCase(), g]));
  let created = 0;

  // Pass 1: primaries
  for (const g of ACC_DEFAULT_GROUPS.filter((x) => !x.parent)) {
    if (byName.has(g.name.toLowerCase())) continue;
    const doc = await Acc_Group.create({
      companyId,
      name: g.name,
      parent: null,
      parentName: null,
      isPrimary: true,
      isReserved: g.isReserved || false,
      nature: g.nature,
      level: 1,
      fullPath: g.name,
      createdBy,
      isActive: true,
    });
    byName.set(g.name.toLowerCase(), doc);
    created++;
  }

  // Pass 2: children — need the parent ObjectId resolved
  for (const g of ACC_DEFAULT_GROUPS.filter((x) => x.parent)) {
    if (byName.has(g.name.toLowerCase())) continue;
    const parent = byName.get(g.parent.toLowerCase());
    if (!parent) continue; // parent missing (shouldn't happen but defensive)
    const doc = await Acc_Group.create({
      companyId,
      name: g.name,
      parent: parent._id,
      parentName: parent.name,
      isPrimary: false,
      isReserved: g.isReserved || false,
      nature: g.nature,
      level: 2,
      fullPath: `${parent.name} > ${g.name}`,
      createdBy,
      isActive: true,
    });
    byName.set(g.name.toLowerCase(), doc);
    created++;
  }

  return created;
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/accountant/chart-of-accounts/ensure-defaults
// ─────────────────────────────────────────────────────────────────────────
// Self-heal endpoint — top up any missing default Tally groups for a
// company. Safe to call any time; idempotent. The CoA page surfaces a
// button calling this when the chart looks empty.
// ─────────────────────────────────────────────────────────────────────────
router.post("/ensure-defaults", async (req, res) => {
  try {
    const { companyId } = req.body || {};
    if (!companyId) {
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });
    }
    const created = await ensureDefaultGroups(companyId, req.user?.id);
    const total = await Acc_Group.countDocuments({
      companyId,
      isActive: true,
    });
    res.json({
      success: true,
      created,
      total,
      message:
        created === 0
          ? `All ${total} default groups were already present.`
          : `Created ${created} missing default groups (now ${total} total).`,
    });
  } catch (err) {
    console.error("ensure-defaults:", err);
    res.status(500).json({
      success: false,
      message: err.message || "Failed to seed defaults",
    });
  }
});

// ── GET /version — quick check that the latest backend code is loaded.
//   Hit this in the browser:  /api/accountant/chart-of-accounts/version
//   If you see the version string, the new code is deployed. If 404, the
//   server is still running an older revision and needs a restart.
router.get("/version", (req, res) => {
  res.json({
    success: true,
    version: "2026-05-07-payroll-bridge-v3",
    features: [
      "paid-aware payroll bridge (journal + payment vouchers)",
      "voucher-number prefix-string lookup (race-safe)",
      "duplicate-key retry loop (5 attempts)",
      "hard-delete unpost (frees voucher numbers)",
      "/payroll/cleanup emergency reset endpoint",
      "parties bridge (customer→sundry-debtor, vendor→sundry-creditor)",
      "manufacturing chart seeder",
    ],
    serverTime: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper — sum currentBalance for a list of leaf ledgers (signed)
// ─────────────────────────────────────────────────────────────────────────────
function sumBalances(ledgers = []) {
  return ledgers.reduce((acc, l) => acc + (l.currentBalance || 0), 0);
}

function rollupGroupTotals(group) {
  // Recursively sum: the group's own ledgers + all descendant groups' totals
  const ownTotal = sumBalances(group.ledgers || []);
  const childTotal = (group.children || []).reduce(
    (acc, c) => acc + rollupGroupTotals(c),
    0,
  );
  group.rolledUpBalance = ownTotal + childTotal;
  group.totalLedgersDeep =
    (group.ledgers?.length || 0) +
    (group.children || []).reduce(
      (acc, c) => acc + (c.totalLedgersDeep || 0),
      0,
    );
  return group.rolledUpBalance;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/accountant/chart-of-accounts/tree?companyId=...
// Returns the full Group→Ledger tree + per-group rolled-up balances
// ─────────────────────────────────────────────────────────────────────────────
router.get("/tree", async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });

    const [groups, ledgers] = await Promise.all([
      Acc_Group.find({ companyId, isActive: true }).lean(),
      Acc_Ledger.find({ companyId, isActive: true }).lean(),
    ]);

    const groupMap = new Map(
      groups.map((g) => [String(g._id), { ...g, children: [], ledgers: [] }]),
    );

    ledgers.forEach((l) => {
      const parent = groupMap.get(String(l.groupId));
      if (parent) parent.ledgers.push(l);
    });

    // Sort ledgers within each group by groupOrder (when present), then
    // alphabetical. Wrapped defensively so a bad comparator never kills
    // the response — fall back to the unsorted array.
    try {
      groupMap.forEach((g) => {
        if (!Array.isArray(g.ledgers) || g.ledgers.length < 2) return;
        g.ledgers.sort((a, b) => {
          const ao = a.groupOrder,
            bo = b.groupOrder;
          if (ao != null && bo == null) return -1;
          if (ao == null && bo != null) return 1;
          if (ao != null && bo != null && ao !== bo) return ao - bo;
          return (a.name || "").localeCompare(b.name || "");
        });
      });
    } catch (sortErr) {
      console.warn("[CoA tree] ledger sort skipped:", sortErr.message);
    }

    const roots = [];
    groupMap.forEach((g) => {
      if (g.parent) {
        const p = groupMap.get(String(g.parent));
        if (p) p.children.push(g);
        else roots.push(g);
      } else {
        roots.push(g);
      }
    });

    // Roll up balances bottom-up
    roots.forEach(rollupGroupTotals);

    // Sort child groups by displayOrder (when set), then name. Wrap so
    // a bad comparator never kills the response.
    function sortChildrenRecursive(node) {
      if (!Array.isArray(node.children) || node.children.length === 0) return;
      node.children.sort((a, b) => {
        const ao = a.displayOrder,
          bo = b.displayOrder;
        if (ao != null && bo == null) return -1;
        if (ao == null && bo != null) return 1;
        if (ao != null && bo != null && ao !== bo) return ao - bo;
        return (a.name || "").localeCompare(b.name || "");
      });
      for (const c of node.children) sortChildrenRecursive(c);
    }
    try {
      for (const r of roots) sortChildrenRecursive(r);
    } catch (sortErr) {
      console.warn("[CoA tree] child sort skipped:", sortErr.message);
    }

    const order = ["asset", "liability", "equity", "revenue", "expense"];
    roots.sort((a, b) => {
      // First by nature (Assets → Liabilities → Equity → Revenue → Expenses)
      const oa = order.indexOf(a.nature);
      const ob = order.indexOf(b.nature);
      if (oa !== ob) return oa - ob;
      // Within a nature: by user displayOrder if set, else alphabetical
      const ao = a.displayOrder,
        bo = b.displayOrder;
      if (ao != null && bo == null) return -1;
      if (ao == null && bo != null) return 1;
      if (ao != null && bo != null && ao !== bo) return ao - bo;
      return (a.name || "").localeCompare(b.name || "");
    });

    // Top-level totals by nature (handy for the page header strip)
    const totalsByNature = roots.reduce((acc, g) => {
      acc[g.nature] = (acc[g.nature] || 0) + (g.rolledUpBalance || 0);
      return acc;
    }, {});

    res.json({
      success: true,
      tree: roots,
      stats: {
        totalGroups: groups.length,
        totalLedgers: ledgers.length,
        totalsByNature,
      },
    });
  } catch (err) {
    console.error("CoA tree:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUPS — CRUD
// ─────────────────────────────────────────────────────────────────────────────
router.get("/groups", async (req, res) => {
  try {
    const { companyId, nature, parent } = req.query;
    const filter = { isActive: true };
    if (companyId) filter.companyId = companyId;
    if (nature) filter.nature = nature;
    if (parent === "null") filter.parent = null;
    else if (parent) filter.parent = parent;
    const groups = await Acc_Group.find(filter).sort({ name: 1 }).lean();
    res.json({ success: true, groups });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/groups", async (req, res) => {
  try {
    const { companyId, name, parent, nature, description } = req.body;
    if (!companyId || !name || !nature) {
      return res.status(400).json({
        success: false,
        message: "companyId, name, nature are required",
      });
    }
    let parentDoc = null;
    if (parent) {
      parentDoc = await Acc_Group.findById(parent);
      if (!parentDoc)
        return res
          .status(404)
          .json({ success: false, message: "Parent group not found" });
    }
    const group = await Acc_Group.create({
      companyId,
      name,
      nature,
      description,
      parent: parentDoc?._id || null,
      parentName: parentDoc?.name || null,
      level: parentDoc ? (parentDoc.level || 1) + 1 : 1,
      fullPath: parentDoc ? `${parentDoc.fullPath} > ${name}` : name,
      isReserved: false,
      createdBy: req.user?.id,
    });
    res.status(201).json({ success: true, group });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

router.put("/groups/:id", async (req, res) => {
  try {
    const grp = await Acc_Group.findById(req.params.id);
    if (!grp)
      return res
        .status(404)
        .json({ success: false, message: "Group not found" });
    if (grp.isReserved && req.body.name && req.body.name !== grp.name) {
      return res.status(400).json({
        success: false,
        message: "Cannot rename a reserved Tally group",
      });
    }
    Object.assign(grp, req.body);
    await grp.save();
    res.json({ success: true, group: grp });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

router.delete("/groups/:id", async (req, res) => {
  try {
    const grp = await Acc_Group.findById(req.params.id);
    if (!grp)
      return res
        .status(404)
        .json({ success: false, message: "Group not found" });
    if (grp.isReserved)
      return res
        .status(400)
        .json({ success: false, message: "Cannot delete a reserved group" });

    const childCount = await Acc_Group.countDocuments({
      parent: grp._id,
      isActive: true,
    });
    const ledgerCount = await Acc_Ledger.countDocuments({
      groupId: grp._id,
      isActive: true,
    });
    if (childCount > 0 || ledgerCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Group has ${childCount} sub-group(s) and ${ledgerCount} ledger(s). Move or delete them first.`,
      });
    }
    grp.isActive = false;
    await grp.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /groups/:id/order — manually re-order a group among its siblings
// ─────────────────────────────────────────────────────────────────────────────
// Pure display-order operation: doesn't touch any balances, doesn't change
// the group's parent, doesn't change its nature, doesn't affect any ledger.
// Only the user-visible sort within the Chart of Accounts page changes.
//
// Body shape:
//   {
//     companyId,             // required, sanity-check the group is in scope
//     destGroupId,           // the sibling we're being dropped BEFORE
//     siblingIds             // optional: the user's current view-order of
//                            // siblings. If provided, we re-rank all of
//                            // them in one go to clean up sparse gaps.
//   }
//
// Constraints:
//   • src and dest must share the same parent (or both be top-level under
//     the same nature). Cross-parent moves are NOT supported via this
//     endpoint — that would cascade nature changes, which is risky.
//   • Both groups must belong to the requested company.
//   • Either group being reserved is fine — we only change display order.
// ─────────────────────────────────────────────────────────────────────────────
router.patch("/groups/:id/order", async (req, res) => {
  try {
    const { companyId, destGroupId, siblingIds } = req.body || {};
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });
    if (!destGroupId)
      return res
        .status(400)
        .json({ success: false, message: "destGroupId required" });

    const [src, dest] = await Promise.all([
      Acc_Group.findById(req.params.id),
      Acc_Group.findById(destGroupId),
    ]);
    if (!src || !dest)
      return res
        .status(404)
        .json({ success: false, message: "Group(s) not found" });
    if (
      String(src.companyId) !== String(companyId) ||
      String(dest.companyId) !== String(companyId)
    ) {
      return res.status(400).json({
        success: false,
        message: "Both groups must belong to the same company",
      });
    }

    // Same-parent constraint. Both null parents (top-level) count as
    // "same parent" only if their natures match — otherwise you'd be
    // moving between different nature buckets, which we refuse here.
    const sameParent =
      (src.parent &&
        dest.parent &&
        String(src.parent) === String(dest.parent)) ||
      (!src.parent && !dest.parent && src.nature === dest.nature);
    if (!sameParent) {
      return res.status(400).json({
        success: false,
        message:
          "Groups can only be reordered within the same parent group (or within the same top-level nature).",
        code: "CROSS_PARENT_NOT_SUPPORTED",
      });
    }
    if (String(src._id) === String(dest._id)) {
      return res.json({ success: true, noop: true });
    }

    // Case A: client gave us the new ordered list — write ranks for all
    // of them in one go. This is the preferred path because it leaves
    // clean, evenly-spaced display order values.
    const GAP = 100;
    if (Array.isArray(siblingIds) && siblingIds.length > 0) {
      // Re-order: pull src out, insert it just before dest in the array
      const without = siblingIds
        .map(String)
        .filter((x) => x !== String(src._id));
      const destIdx = without.findIndex((x) => x === String(dest._id));
      if (destIdx < 0) {
        return res.status(400).json({
          success: false,
          message: "destGroupId not found in siblingIds",
        });
      }
      const newOrder = [
        ...without.slice(0, destIdx),
        String(src._id),
        ...without.slice(destIdx),
      ];
      const ops = newOrder.map((gid, i) => ({
        updateOne: {
          filter: { _id: gid, companyId },
          update: { $set: { displayOrder: i * GAP } },
        },
      }));
      await Acc_Group.bulkWrite(ops);
      return res.json({ success: true, reordered: newOrder.length });
    }

    // Case B: no sibling list given — just put src at dest's order - 1
    // (or 0 if dest has no order set). Simpler but can create gaps.
    const destOrder = Number.isFinite(dest.displayOrder)
      ? dest.displayOrder
      : 0;
    src.displayOrder = destOrder - 1;
    await src.save();
    res.json({ success: true });
  } catch (err) {
    console.error("[group/order]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// LEDGERS — CRUD
// ─────────────────────────────────────────────────────────────────────────────
router.get("/ledgers", async (req, res) => {
  try {
    const {
      companyId,
      groupId,
      groupName,
      group,
      nature,
      search,
      page = 1,
      limit = 50,
    } = req.query;
    const filter = { isActive: true };
    if (companyId) filter.companyId = companyId;
    if (groupId) filter.groupId = groupId;

    // Allow filtering by group NAME (e.g. "Sundry Debtors"). Resolves
    // the name → groupId on the fly. Accept either `group` or
    // `groupName` query param. Case-insensitive. Includes descendants
    // of the named group too — if a user nested "Wholesale Customers"
    // under "Sundry Debtors", those ledgers come back too.
    const gname = groupName || group;
    if (gname && !groupId && companyId) {
      const rx = new RegExp(
        "^" + gname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
        "i",
      );
      const root = await Acc_Group.findOne({
        companyId,
        isActive: true,
        name: rx,
      });
      if (!root) {
        return res.json({
          success: true,
          ledgers: [],
          total: 0,
          page: parseInt(page),
          pages: 0,
        });
      }
      // Walk descendants
      const groupIds = new Set([String(root._id)]);
      let frontier = [root._id];
      let safety = 0;
      while (frontier.length > 0 && safety++ < 20) {
        const kids = await Acc_Group.find({
          companyId,
          isActive: true,
          parent: { $in: frontier },
        }).select("_id");
        const next = [];
        for (const k of kids) {
          if (!groupIds.has(String(k._id))) {
            groupIds.add(String(k._id));
            next.push(k._id);
          }
        }
        frontier = next;
      }
      filter.groupId = { $in: Array.from(groupIds) };
    }

    if (nature) filter.nature = nature;
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { aliases: { $regex: search, $options: "i" } },
        { gstin: { $regex: search, $options: "i" } },
      ];
    }
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [ledgersRaw, total] = await Promise.all([
      Acc_Ledger.find(filter)
        .sort({ name: 1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Acc_Ledger.countDocuments(filter),
    ]);

    // Auto-derive stateCode from GSTIN for any ledger that has GSTIN
    // but is missing stateCode (common for Tally imports).
    const GST_STATES = {
      "01": "Jammu & Kashmir",
      "02": "Himachal Pradesh",
      "03": "Punjab",
      "04": "Chandigarh",
      "05": "Uttarakhand",
      "06": "Haryana",
      "07": "Delhi",
      "08": "Rajasthan",
      "09": "Uttar Pradesh",
      10: "Bihar",
      11: "Sikkim",
      12: "Arunachal Pradesh",
      13: "Nagaland",
      14: "Manipur",
      15: "Mizoram",
      16: "Tripura",
      17: "Meghalaya",
      18: "Assam",
      19: "West Bengal",
      20: "Jharkhand",
      21: "Odisha",
      22: "Chhattisgarh",
      23: "Madhya Pradesh",
      24: "Gujarat",
      25: "Daman & Diu",
      26: "Dadra & Nagar Haveli and Daman & Diu",
      27: "Maharashtra",
      28: "Andhra Pradesh (Old)",
      29: "Karnataka",
      30: "Goa",
      31: "Lakshadweep",
      32: "Kerala",
      33: "Tamil Nadu",
      34: "Puducherry",
      35: "Andaman & Nicobar Islands",
      36: "Telangana",
      37: "Andhra Pradesh",
      38: "Ladakh",
    };
    const bulkFixOps = [];
    const ledgers = ledgersRaw.map((l) => {
      if (l.gstin && l.gstin.length >= 2) {
        const code = l.gstin.slice(0, 2);
        if (GST_STATES[code]) {
          if (!l.contactDetails) l.contactDetails = {};
          if (!l.contactDetails.stateCode) {
            l.contactDetails.stateCode = code;
            bulkFixOps.push({
              updateOne: {
                filter: { _id: l._id },
                update: {
                  $set: {
                    "contactDetails.stateCode": code,
                    "contactDetails.state": GST_STATES[code],
                  },
                },
              },
            });
          }
          if (!l.contactDetails.state)
            l.contactDetails.state = GST_STATES[code];
        }
      }
      return l;
    });
    // Fire-and-forget bulk fix so next request doesn't need it
    if (bulkFixOps.length > 0) {
      Acc_Ledger.bulkWrite(bulkFixOps).catch(() => {});
    }

    res.json({
      success: true,
      ledgers,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/ledgers", async (req, res) => {
  try {
    const { companyId, name, groupId, openingBalance, openingBalanceType } =
      req.body;
    if (!companyId || !name || !groupId) {
      return res
        .status(400)
        .json({ success: false, message: "companyId, name, groupId required" });
    }
    const group = await Acc_Group.findById(groupId);
    if (!group)
      return res
        .status(404)
        .json({ success: false, message: "Group not found" });

    const signedOpen =
      (openingBalanceType === "Cr" ? -1 : 1) *
      Math.abs(parseFloat(openingBalance) || 0);

    const ledger = await Acc_Ledger.create({
      ...req.body,
      groupName: group.name,
      nature: req.body.nature || group.nature,
      openingBalance: signedOpen,
      currentBalance: signedOpen,
      currentBalanceType: openingBalanceType || "Dr",
      createdBy: req.user?.id,
    });
    res.status(201).json({ success: true, ledger });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

router.get("/ledgers/:id", async (req, res) => {
  try {
    const ledger = await Acc_Ledger.findById(req.params.id);
    if (!ledger)
      return res
        .status(404)
        .json({ success: false, message: "Ledger not found" });

    // Auto-derive stateCode from GSTIN if missing (fixes "Vendor has
    // GSTIN but no state code" warning on purchase vouchers). Also
    // auto-fill state name. Persists to DB so it's a one-time fix.
    if (ledger.gstin && ledger.gstin.length >= 2) {
      const code = ledger.gstin.slice(0, 2);
      const GST_STATES = {
        "01": "Jammu & Kashmir",
        "02": "Himachal Pradesh",
        "03": "Punjab",
        "04": "Chandigarh",
        "05": "Uttarakhand",
        "06": "Haryana",
        "07": "Delhi",
        "08": "Rajasthan",
        "09": "Uttar Pradesh",
        10: "Bihar",
        11: "Sikkim",
        12: "Arunachal Pradesh",
        13: "Nagaland",
        14: "Manipur",
        15: "Mizoram",
        16: "Tripura",
        17: "Meghalaya",
        18: "Assam",
        19: "West Bengal",
        20: "Jharkhand",
        21: "Odisha",
        22: "Chhattisgarh",
        23: "Madhya Pradesh",
        24: "Gujarat",
        25: "Daman & Diu",
        26: "Dadra & Nagar Haveli and Daman & Diu",
        27: "Maharashtra",
        28: "Andhra Pradesh (Old)",
        29: "Karnataka",
        30: "Goa",
        31: "Lakshadweep",
        32: "Kerala",
        33: "Tamil Nadu",
        34: "Puducherry",
        35: "Andaman & Nicobar Islands",
        36: "Telangana",
        37: "Andhra Pradesh",
        38: "Ladakh",
      };
      let dirty = false;
      if (!ledger.contactDetails) ledger.contactDetails = {};
      if (!ledger.contactDetails.stateCode && GST_STATES[code]) {
        ledger.contactDetails.stateCode = code;
        dirty = true;
      }
      if (!ledger.contactDetails.state && GST_STATES[code]) {
        ledger.contactDetails.state = GST_STATES[code];
        dirty = true;
      }
      if (dirty) {
        await ledger.save();
      }
    }

    res.json({ success: true, ledger: ledger.toObject() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.put("/ledgers/:id", async (req, res) => {
  try {
    const updates = { ...req.body };
    if (updates.groupId) {
      const grp = await Acc_Group.findById(updates.groupId);
      if (grp) {
        updates.groupName = grp.name;
        if (!updates.nature) updates.nature = grp.nature;
      }
    }
    // Re-sign opening balance if both fields supplied
    if (updates.openingBalance != null && updates.openingBalanceType) {
      const sign = updates.openingBalanceType === "Cr" ? -1 : 1;
      updates.openingBalance =
        sign * Math.abs(parseFloat(updates.openingBalance) || 0);
    }
    const ledger = await Acc_Ledger.findByIdAndUpdate(req.params.id, updates, {
      new: true,
    });
    if (!ledger)
      return res
        .status(404)
        .json({ success: false, message: "Ledger not found" });
    res.json({ success: true, ledger });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* DELETE /ledgers/:id — Soft-delete with dependency check             */
/* ------------------------------------------------------------------ */
/* If the ledger has transactions, returns a 409 with details about
 * where it's used, plus asks for an alternativeLedgerId to reassign.
 * If alternativeLedgerId is provided in query, reassigns all txns
 * to the alternative ledger first, then deletes.
 */
router.delete("/ledgers/:id", async (req, res) => {
  try {
    const ledger = await Acc_Ledger.findById(req.params.id);
    if (!ledger)
      return res
        .status(404)
        .json({ success: false, message: "Ledger not found" });

    const alternativeId = req.query.alternativeLedgerId;

    // Check dependencies
    const txnCount = await Acc_Voucher.countDocuments({
      "ledgerEntries.ledgerId": ledger._id,
      status: "posted",
    });

    // Check if used as party ledger in vouchers
    const partyCount = await Acc_Voucher.countDocuments({
      partyLedgerId: ledger._id,
    });

    // Check linked vendor/customer
    const linkedTo = [];
    if (ledger.linkedVendorId) linkedTo.push("Vendor");
    if (ledger.linkedCustomerId) linkedTo.push("Customer");
    if (ledger.linkedEmployeeId) linkedTo.push("Employee");

    const totalUsage = txnCount + partyCount;

    if (totalUsage > 0 && !alternativeId) {
      // Return dependency details — frontend shows a dialog
      return res.status(409).json({
        success: false,
        message: `This ledger is used in ${totalUsage} place(s). Choose an alternative ledger to reassign transactions before deleting.`,
        dependencies: {
          voucherEntries: txnCount,
          partyVouchers: partyCount,
          linkedEntities: linkedTo,
          totalUsage,
        },
        requiresAlternative: true,
      });
    }

    // If alternative provided, reassign all references
    if (alternativeId && totalUsage > 0) {
      const alt = await Acc_Ledger.findById(alternativeId);
      if (!alt)
        return res.status(404).json({
          success: false,
          message: "Alternative ledger not found",
        });

      // Reassign voucher ledger entries
      if (txnCount > 0) {
        await Acc_Voucher.updateMany(
          { "ledgerEntries.ledgerId": ledger._id },
          {
            $set: {
              "ledgerEntries.$[elem].ledgerId": alt._id,
              "ledgerEntries.$[elem].ledgerName": alt.name,
            },
          },
          { arrayFilters: [{ "elem.ledgerId": ledger._id }] },
        );
      }

      // Reassign party ledger references
      if (partyCount > 0) {
        await Acc_Voucher.updateMany(
          { partyLedgerId: ledger._id },
          {
            $set: {
              partyLedgerId: alt._id,
              partyLedgerName: alt.name,
            },
          },
        );
      }
    }

    // Soft-delete
    ledger.isActive = false;
    ledger.deletedAt = new Date();
    await ledger.save();

    res.json({
      success: true,
      message: alternativeId
        ? `Ledger deleted. ${totalUsage} reference(s) reassigned to "${(await Acc_Ledger.findById(alternativeId).select("name").lean())?.name || alternativeId}".`
        : "Ledger deleted.",
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PRIMARY INVOICE BANK — the bank ledger flagged as the default to print
// on tax invoices for a given company. At most one per company.
//
// Used by the invoice PDF generator: backend's /invoices/:id endpoint
// returns this ledger alongside the company doc, and the PDF places its
// bankDetails into the "Company's Bank Details" footer block.
// ─────────────────────────────────────────────────────────────────────────────

// GET /primary-invoice-bank?companyId=...
// Returns the currently-flagged primary bank for a company (or null).
// Used by the Settings page when it loads.
router.get("/primary-invoice-bank", async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId) {
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });
    }
    const ledger = await Acc_Ledger.findOne({
      companyId,
      isPrimaryInvoiceBank: true,
      isActive: { $ne: false },
    })
      .select("name groupName bankDetails")
      .lean();
    res.json({ success: true, ledger });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /ledgers/:id/set-primary-bank
// Marks this ledger as the primary invoice bank for its company. Atomic:
// clears the flag on any other bank ledger in the same company first,
// then sets it on the target ledger. Returns the updated ledger.
//
// The target ledger must (a) belong to a "Bank Accounts" group — soft
// check, since group names are user-editable; we just refuse if the
// resolved group has a nature other than "asset" — and (b) have at least
// a bankName populated, otherwise printing it on an invoice is
// meaningless.
router.post("/ledgers/:id/set-primary-bank", async (req, res) => {
  try {
    const ledger = await Acc_Ledger.findById(req.params.id);
    if (!ledger) {
      return res
        .status(404)
        .json({ success: false, message: "Ledger not found" });
    }
    if (!ledger.bankDetails?.bankName) {
      return res.status(400).json({
        success: false,
        message:
          "Set the ledger's bank name (and other bank details) before marking it as the primary invoice bank.",
      });
    }

    // Clear the flag on every other bank ledger in this company so the
    // invariant "at most one primary per company" holds.
    await Acc_Ledger.updateMany(
      {
        companyId: ledger.companyId,
        _id: { $ne: ledger._id },
        isPrimaryInvoiceBank: true,
      },
      { $set: { isPrimaryInvoiceBank: false } },
    );

    ledger.isPrimaryInvoiceBank = true;
    await ledger.save();

    res.json({ success: true, ledger: ledger.toObject() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /ledgers/:id/clear-primary-bank
// Removes the primary-bank flag from this ledger. Useful when an
// accountant wants no bank printed on invoices, or before switching to
// a fresh one without an in-between state.
router.post("/ledgers/:id/clear-primary-bank", async (req, res) => {
  try {
    const ledger = await Acc_Ledger.findById(req.params.id);
    if (!ledger) {
      return res
        .status(404)
        .json({ success: false, message: "Ledger not found" });
    }
    ledger.isPrimaryInvoiceBank = false;
    await ledger.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/accountant/chart-of-accounts/ledgers/:id/statement
// Full ledger statement returns three views in one payload:
//   • lines           — flat chronological list with running balance
//   • monthlySummary  — one row per month: opening, debit, credit, closing
//   • openingBalanceLine — synthetic row for the opening balance
//
// Math (consistent across all views):
//   running          = opening + Σ(debit − credit)         per row
//   month.closing    = month.opening + month.debit − month.credit
//   month[i].opening = month[i-1].closing                  carry-forward
//   period.closing   = monthlySummary.last.closing
//                    = opening + totals.debit − totals.credit
// ─────────────────────────────────────────────────────────────────────────────
router.get("/ledgers/:id/statement", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const ledger = await Acc_Ledger.findById(req.params.id).lean();
    if (!ledger)
      return res
        .status(404)
        .json({ success: false, message: "Ledger not found" });

    const dateFilter = {};
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate) {
      const e = new Date(endDate);
      e.setHours(23, 59, 59, 999);
      dateFilter.$lte = e;
    }

    const filter = {
      "ledgerEntries.ledgerId": ledger._id,
      status: "posted",
    };
    if (Object.keys(dateFilter).length) filter.voucherDate = dateFilter;

    const vouchers = await Acc_Voucher.find(filter)
      .sort({ voucherDate: 1, createdAt: 1 })
      .select(
        "voucherType voucherTypeName voucherNumber voucherDate partyLedgerName narration ledgerEntries grandTotal",
      )
      .lean();

    // Opening balance — sum all entries strictly before startDate, plus the
    // ledger's stored openingBalance figure
    let opening = ledger.openingBalance || 0;
    if (startDate) {
      const priorAgg = await Acc_Voucher.aggregate([
        {
          $match: {
            "ledgerEntries.ledgerId": ledger._id,
            status: "posted",
            voucherDate: { $lt: new Date(startDate) },
          },
        },
        { $unwind: "$ledgerEntries" },
        { $match: { "ledgerEntries.ledgerId": ledger._id } },
        {
          $group: { _id: null, total: { $sum: "$ledgerEntries.signedAmount" } },
        },
      ]);
      opening += priorAgg[0]?.total || 0;
    }

    // Build flat running statement
    let running = opening;
    const lines = vouchers.map((v) => {
      const myLines = v.ledgerEntries.filter(
        (e) => String(e.ledgerId) === String(ledger._id),
      );
      const otherLines = v.ledgerEntries.filter(
        (e) => String(e.ledgerId) !== String(ledger._id),
      );
      const dr = myLines.reduce(
        (s, e) => s + (e.type === "Dr" ? e.amount : 0),
        0,
      );
      const cr = myLines.reduce(
        (s, e) => s + (e.type === "Cr" ? e.amount : 0),
        0,
      );
      const signed = dr - cr;
      running += signed;

      // Pull bill-wise allocations from MY lines (not other ledgers)
      const myBills = myLines.flatMap((e) =>
        (e.billAllocations || []).map((b) => ({
          billName: b.billName,
          billType: b.billType,
          amount: b.amount,
          dueDate: b.dueDate,
          creditDays: b.creditDays,
        })),
      );

      return {
        voucherId: v._id,
        date: v.voucherDate,
        voucherType: v.voucherType,
        voucherTypeName: v.voucherTypeName,
        voucherNumber: v.voucherNumber,
        particulars: v.partyLedgerName || v.narration || "",
        narration: v.narration,
        debit: dr,
        credit: cr,
        runningBalance: running,
        runningBalanceType: running >= 0 ? "Dr" : "Cr",
        // ── New fields ────────────────────────────────────────────────
        // Tally-style "By/To" contras: when this row is Dr, the others are Cr (shown as "To")
        // When this row is Cr, the others are Dr (shown as "By").
        // Convention: under the leading line, the contras are listed indented.
        contraEntries: otherLines.map((e) => ({
          ledgerId: e.ledgerId,
          ledgerName: e.ledgerName,
          groupName: e.groupName,
          type: e.type,
          amount: e.amount,
        })),
        billAllocations: myBills,
      };
    });

    const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
    const totalCredit = lines.reduce((s, l) => s + l.credit, 0);
    const closing = running;

    // ── Monthly summary buckets ─────────────────────────────────────────
    // Each month's opening = previous month's closing.
    const byMonth = new Map();
    for (const l of lines) {
      const d = new Date(l.date);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      if (!byMonth.has(key)) {
        byMonth.set(key, {
          monthKey: key,
          year: d.getFullYear(),
          month: d.getMonth() + 1,
          monthName: d.toLocaleString("en-IN", { month: "long" }),
          monthShort: d.toLocaleString("en-IN", { month: "short" }),
          debit: 0,
          credit: 0,
          txCount: 0,
        });
      }
      const bucket = byMonth.get(key);
      bucket.debit += l.debit;
      bucket.credit += l.credit;
      bucket.txCount += 1;
    }

    // Determine the FULL month range to display. The accountant wants
    // EVERY month of the selected period shown — even months with no
    // transactions — each carrying the previous month's closing forward
    // (a zero-activity month still has a closing balance). Previously only
    // months that had at least one transaction appeared, so a ledger that
    // was active in Aug/Oct/Mar showed just those three rows.
    //
    // Range source priority:
    //   1. explicit startDate/endDate query params, else
    //   2. first → last transaction month, else
    //   3. the single month of `opening`'s context (fallback: current).
    function ymKey(y, mo) {
      return `${y}-${String(mo).padStart(2, "0")}`;
    }
    let rangeStart = null;
    let rangeEnd = null;
    if (startDate) {
      const s = new Date(startDate);
      rangeStart = { y: s.getFullYear(), m: s.getMonth() + 1 };
    }
    if (endDate) {
      const e = new Date(endDate);
      rangeEnd = { y: e.getFullYear(), m: e.getMonth() + 1 };
    }
    if ((!rangeStart || !rangeEnd) && lines.length > 0) {
      const first = new Date(lines[0].date);
      const last = new Date(lines[lines.length - 1].date);
      if (!rangeStart)
        rangeStart = { y: first.getFullYear(), m: first.getMonth() + 1 };
      if (!rangeEnd)
        rangeEnd = { y: last.getFullYear(), m: last.getMonth() + 1 };
    }
    if (!rangeStart && !rangeEnd) {
      const now = new Date();
      rangeStart = { y: now.getFullYear(), m: now.getMonth() + 1 };
      rangeEnd = { ...rangeStart };
    } else if (!rangeStart) {
      rangeStart = { ...rangeEnd };
    } else if (!rangeEnd) {
      rangeEnd = { ...rangeStart };
    }

    // Build the ordered list of every (year, month) in the range.
    const allMonthKeys = [];
    {
      let y = rangeStart.y;
      let mo = rangeStart.m;
      // Guard against an inverted range.
      const endSerial = rangeEnd.y * 12 + (rangeEnd.m - 1);
      let serial = y * 12 + (mo - 1);
      let safety = 0;
      while (serial <= endSerial && safety < 600) {
        allMonthKeys.push({ key: ymKey(y, mo), y, m: mo });
        mo += 1;
        if (mo > 12) {
          mo = 1;
          y += 1;
        }
        serial = y * 12 + (mo - 1);
        safety += 1;
      }
      if (allMonthKeys.length === 0)
        allMonthKeys.push({
          key: ymKey(rangeStart.y, rangeStart.m),
          y: rangeStart.y,
          m: rangeStart.m,
        });
    }

    // Walk every month in the range, carrying balance forward through
    // empty months too.
    let monthRunning = opening;
    const monthlySummary = allMonthKeys.map(({ key, y, m }) => {
      const existing = byMonth.get(key);
      const dbg = existing ? existing.debit : 0;
      const crg = existing ? existing.credit : 0;
      const txCount = existing ? existing.txCount : 0;
      const dt = new Date(y, m - 1, 1);
      const monthOpening = monthRunning;
      const monthClosing = monthOpening + dbg - crg;
      monthRunning = monthClosing;
      return {
        monthKey: key,
        year: y,
        month: m,
        monthName: dt.toLocaleString("en-IN", { month: "long" }),
        monthShort: dt.toLocaleString("en-IN", { month: "short" }),
        debit: dbg,
        credit: crg,
        txCount,
        opening: monthOpening,
        openingType: monthOpening >= 0 ? "Dr" : "Cr",
        closing: monthClosing,
        closingType: monthClosing >= 0 ? "Dr" : "Cr",
        netChange: dbg - crg,
        noActivity: txCount === 0,
      };
    });

    // ── Daily summary buckets ───────────────────────────────────────────
    const byDay = new Map();
    for (const l of lines) {
      const d = new Date(l.date);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      if (!byDay.has(key)) {
        byDay.set(key, {
          dayKey: key,
          date: d,
          debit: 0,
          credit: 0,
          txCount: 0,
        });
      }
      const bucket = byDay.get(key);
      bucket.debit += l.debit;
      bucket.credit += l.credit;
      bucket.txCount += 1;
    }
    let dayRunning = opening;
    const dailySummary = Array.from(byDay.values())
      .sort((a, b) => a.dayKey.localeCompare(b.dayKey))
      .map((d) => {
        const dayOpening = dayRunning;
        const dayClosing = dayOpening + d.debit - d.credit;
        dayRunning = dayClosing;
        return {
          ...d,
          opening: dayOpening,
          openingType: dayOpening >= 0 ? "Dr" : "Cr",
          closing: dayClosing,
          closingType: dayClosing >= 0 ? "Dr" : "Cr",
          netChange: d.debit - d.credit,
        };
      });

    // ── Bill-wise outstanding (party ledgers under Sundry Debtors/Creditors) ─
    // FIFO: sum signedAmount across all bills with the same billName.
    // Positive remaining = receivable (Dr); negative = payable (Cr).
    let billWiseOutstanding = null;
    const groupName = (ledger.groupName || "").toLowerCase();
    const isPartyLedger =
      groupName.includes("sundry debtor") ||
      groupName.includes("sundry creditor") ||
      groupName.includes("debtor") ||
      groupName.includes("creditor");
    if (isPartyLedger) {
      // Pull ALL allocations across history for this ledger, irrespective of period
      const allAlloc = await Acc_Voucher.aggregate([
        { $match: { "ledgerEntries.ledgerId": ledger._id, status: "posted" } },
        { $unwind: "$ledgerEntries" },
        { $match: { "ledgerEntries.ledgerId": ledger._id } },
        { $unwind: "$ledgerEntries.billAllocations" },
        {
          $project: {
            billName: "$ledgerEntries.billAllocations.billName",
            amount: "$ledgerEntries.billAllocations.amount",
            billType: "$ledgerEntries.billAllocations.billType",
            dueDate: "$ledgerEntries.billAllocations.dueDate",
            creditDays: "$ledgerEntries.billAllocations.creditDays",
            entryType: "$ledgerEntries.type",
            voucherDate: 1,
            voucherNumber: 1,
            voucherType: 1,
          },
        },
      ]);

      const billMap = new Map();
      for (const a of allAlloc) {
        if (!a.billName) continue;
        const key = a.billName;
        if (!billMap.has(key)) {
          billMap.set(key, {
            billName: a.billName,
            originalAmount: 0,
            settled: 0,
            remaining: 0,
            firstDate: a.voucherDate,
            dueDate: a.dueDate,
            creditDays: a.creditDays || 0,
            voucherNumbers: new Set(),
          });
        }
        const bill = billMap.get(key);
        bill.voucherNumbers.add(a.voucherNumber);
        // new_ref = original invoice (increases outstanding); agst_ref = payment against (decreases)
        const signed = (a.entryType === "Dr" ? 1 : -1) * (a.amount || 0);
        bill.remaining += signed;
        if (a.billType === "new_ref") bill.originalAmount += a.amount || 0;
        if (
          !bill.firstDate ||
          new Date(a.voucherDate) < new Date(bill.firstDate)
        )
          bill.firstDate = a.voucherDate;
      }

      const today = new Date();
      const buckets = {
        current: 0,
        "0-30": 0,
        "31-60": 0,
        "61-90": 0,
        "90+": 0,
      };
      const openBills = [];
      for (const bill of billMap.values()) {
        if (Math.abs(bill.remaining) < 0.01) continue; // settled
        const daysOverdue = bill.dueDate
          ? Math.max(0, Math.floor((today - new Date(bill.dueDate)) / 86400000))
          : Math.max(
              0,
              Math.floor((today - new Date(bill.firstDate)) / 86400000) -
                (bill.creditDays || 0),
            );
        let bucket = "current";
        if (daysOverdue > 0) bucket = "0-30";
        if (daysOverdue > 30) bucket = "31-60";
        if (daysOverdue > 60) bucket = "61-90";
        if (daysOverdue > 90) bucket = "90+";
        buckets[bucket] += Math.abs(bill.remaining);

        openBills.push({
          billName: bill.billName,
          firstDate: bill.firstDate,
          dueDate: bill.dueDate || null,
          creditDays: bill.creditDays,
          originalAmount: bill.originalAmount,
          remaining: bill.remaining,
          remainingAbs: Math.abs(bill.remaining),
          remainingType: bill.remaining >= 0 ? "Dr" : "Cr",
          daysOverdue,
          bucket,
          voucherCount: bill.voucherNumbers.size,
        });
      }
      openBills.sort((a, b) => b.daysOverdue - a.daysOverdue);

      billWiseOutstanding = {
        applicable: true,
        totalOutstanding: openBills.reduce(
          (s, b) => s + b.remainingAbs * (b.remainingType === "Dr" ? 1 : -1),
          0,
        ),
        bills: openBills,
        agingBuckets: buckets,
        bucketTotals: {
          current: buckets.current,
          d0_30: buckets["0-30"],
          d31_60: buckets["31-60"],
          d61_90: buckets["61-90"],
          d90Plus: buckets["90+"],
        },
      };
    }

    // ── Previous-period comparison ──────────────────────────────────────
    // Same date span, one year earlier
    let previousPeriodComparison = null;
    if (startDate && endDate) {
      const s = new Date(startDate);
      s.setFullYear(s.getFullYear() - 1);
      const e = new Date(endDate);
      e.setFullYear(e.getFullYear() - 1);
      e.setHours(23, 59, 59, 999);
      const prevAgg = await Acc_Voucher.aggregate([
        {
          $match: {
            "ledgerEntries.ledgerId": ledger._id,
            status: "posted",
            voucherDate: { $gte: s, $lte: e },
          },
        },
        { $unwind: "$ledgerEntries" },
        { $match: { "ledgerEntries.ledgerId": ledger._id } },
        {
          $group: {
            _id: null,
            debit: {
              $sum: {
                $cond: [
                  { $eq: ["$ledgerEntries.type", "Dr"] },
                  "$ledgerEntries.amount",
                  0,
                ],
              },
            },
            credit: {
              $sum: {
                $cond: [
                  { $eq: ["$ledgerEntries.type", "Cr"] },
                  "$ledgerEntries.amount",
                  0,
                ],
              },
            },
            txCount: { $sum: 1 },
          },
        },
      ]);
      const p = prevAgg[0] || { debit: 0, credit: 0, txCount: 0 };
      previousPeriodComparison = {
        startDate: s.toISOString().slice(0, 10),
        endDate: e.toISOString().slice(0, 10),
        debit: p.debit,
        credit: p.credit,
        txCount: p.txCount,
        debitDelta: totalDebit - p.debit,
        creditDelta: totalCredit - p.credit,
        debitGrowthPct:
          p.debit > 0 ? ((totalDebit - p.debit) / p.debit) * 100 : null,
        creditGrowthPct:
          p.credit > 0 ? ((totalCredit - p.credit) / p.credit) * 100 : null,
      };
    }

    // Synthetic opening row (so the transactions table is never empty)
    const openingBalanceLine = {
      isSynthetic: true,
      date: ledger.openingBalanceDate || null,
      voucherType: "—",
      voucherTypeName: "Opening",
      voucherNumber: "—",
      particulars: "Opening Balance",
      narration: "Brought forward from previous period",
      debit: opening > 0 ? opening : 0,
      credit: opening < 0 ? Math.abs(opening) : 0,
      runningBalance: opening,
      runningBalanceType: opening >= 0 ? "Dr" : "Cr",
    };

    res.json({
      success: true,
      ledger: {
        _id: ledger._id,
        name: ledger.name,
        groupName: ledger.groupName,
        companyId: ledger.companyId,
        nature: ledger.nature,
        gstin: ledger.gstin,
        panNumber: ledger.panNumber,
        currentBalance: ledger.currentBalance,
        currentBalanceType: ledger.currentBalanceType,
        openingBalance: ledger.openingBalance,
        openingBalanceType: ledger.openingBalanceType,
        billWiseEnabled: ledger.billWiseEnabled,
        contactDetails: ledger.contactDetails,
        linkedEmployeeId: ledger.linkedEmployeeId,
        linkedCustomerId: ledger.linkedCustomerId,
        linkedVendorId: ledger.linkedVendorId,
      },
      period: { startDate, endDate },
      opening: { amount: Math.abs(opening), type: opening >= 0 ? "Dr" : "Cr" },
      openingBalanceLine,
      lines,
      monthlySummary,
      dailySummary,
      billWiseOutstanding,
      previousPeriodComparison,
      totals: { debit: totalDebit, credit: totalCredit },
      closing: { amount: Math.abs(closing), type: closing >= 0 ? "Dr" : "Cr" },
    });
  } catch (err) {
    console.error("Ledger statement:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/accountant/chart-of-accounts/ledgers/:id/transactions
// Quick "Add Transaction" — posts a 2-line journal voucher with this ledger
// on one side and the chosen contra ledger on the other side. The existing
// pre-save hook on Acc_Voucher computes signedAmount; we then update the
// currentBalance on both ledgers in one bulkWrite. Same primitive every other
// voucher uses, just exposed as a one-shot endpoint for the ledger view.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/ledgers/:id/transactions", async (req, res) => {
  try {
    const ledgerId = req.params.id;
    const {
      contraLedgerId,
      type, // "Dr" or "Cr" — applied to THIS ledger
      amount,
      voucherDate,
      narration,
      voucherType: vchType, // optional: "journal" | "receipt" | "payment" | "contra"
      referenceNumber,
    } = req.body;

    // ─── Validate ───────────────────────────────────────────────────────
    if (!contraLedgerId)
      return res
        .status(400)
        .json({ success: false, message: "contraLedgerId required" });
    if (!["Dr", "Cr"].includes(type))
      return res
        .status(400)
        .json({ success: false, message: "type must be Dr or Cr" });
    const amt = parseFloat(amount);
    if (!amt || amt <= 0)
      return res
        .status(400)
        .json({ success: false, message: "amount must be a positive number" });
    if (String(ledgerId) === String(contraLedgerId)) {
      return res.status(400).json({
        success: false,
        message: "contra ledger cannot be the same as this ledger",
      });
    }

    const [thisLedger, contraLedger] = await Promise.all([
      Acc_Ledger.findById(ledgerId),
      Acc_Ledger.findById(contraLedgerId),
    ]);
    if (!thisLedger)
      return res
        .status(404)
        .json({ success: false, message: "Ledger not found" });
    if (!contraLedger)
      return res
        .status(404)
        .json({ success: false, message: "Contra ledger not found" });
    if (String(thisLedger.companyId) !== String(contraLedger.companyId)) {
      return res.status(400).json({
        success: false,
        message: "Both ledgers must belong to the same company",
      });
    }

    // ─── Build the voucher ──────────────────────────────────────────────
    const resolvedType =
      vchType && ["journal", "receipt", "payment", "contra"].includes(vchType)
        ? vchType
        : "journal";

    const date = voucherDate ? new Date(voucherDate) : new Date();
    const contraType = type === "Dr" ? "Cr" : "Dr";

    // Retry on duplicate-key collisions (cancelled vouchers in same FY can
    // confuse the default nextVoucherNumber implementation; allocate from MAX).
    let voucher = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const number = await getNextVoucherNumberSafe(
        thisLedger.companyId,
        resolvedType,
      );
      try {
        voucher = new Acc_Voucher({
          companyId: thisLedger.companyId,
          voucherType: resolvedType,
          voucherTypeName: {
            journal: "Journal",
            receipt: "Receipt",
            payment: "Payment",
            contra: "Contra",
          }[resolvedType],
          voucherNumber: number,
          voucherDate: date,
          referenceNumber: referenceNumber || "",
          narration: narration || "",
          ledgerEntries: [
            {
              ledgerId: thisLedger._id,
              ledgerName: thisLedger.name,
              groupName: thisLedger.groupName,
              type,
              amount: amt,
            },
            {
              ledgerId: contraLedger._id,
              ledgerName: contraLedger.name,
              groupName: contraLedger.groupName,
              type: contraType,
              amount: amt,
            },
          ],
          grandTotal: amt,
          status: "posted",
          createdBy: req.user?.id,
        });
        await voucher.save();
        break;
      } catch (e) {
        const isDup =
          e &&
          (e.code === 11000 || /E11000|duplicate key/i.test(e.message || ""));
        if (!isDup || attempt === 4) throw e;
        voucher = null;
        await new Promise((r) => setTimeout(r, 25 + Math.random() * 50));
      }
    }

    // ─── Update ledger balances ─────────────────────────────────────────
    // Use the schema's `ledgerId` field (signedAmount = +amount for Dr, -amount for Cr)
    const ops = voucher.ledgerEntries.map((e) => ({
      updateOne: {
        filter: { _id: e.ledgerId },
        update: { $inc: { currentBalance: e.signedAmount } },
      },
    }));
    await Acc_Ledger.bulkWrite(ops);

    // Refresh balanceType on both touched ledgers
    for (const e of voucher.ledgerEntries) {
      const led = await Acc_Ledger.findById(e.ledgerId);
      if (led) {
        led.currentBalanceType = led.currentBalance >= 0 ? "Dr" : "Cr";
        await led.save();
      }
    }

    res.status(201).json({
      success: true,
      voucher: {
        _id: voucher._id,
        voucherNumber: voucher.voucherNumber,
        voucherType: voucher.voucherType,
        voucherDate: voucher.voucherDate,
      },
    });
  } catch (err) {
    console.error("Quick add transaction:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/accountant/chart-of-accounts/trial-balance?companyId=...&asOf=...
// Trial Balance — flat list of all ledgers with computed Dr/Cr columns.
// Includes opening + period transactions + closing in a single row per ledger.
// Total Dr should equal Total Cr (basic accounting identity).
// ─────────────────────────────────────────────────────────────────────────────
router.get("/trial-balance", async (req, res) => {
  try {
    const { companyId, startDate, endDate } = req.query;
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });

    const ledgers = await Acc_Ledger.find({ companyId, isActive: true })
      .sort({ groupName: 1, name: 1 })
      .lean();

    const dateMatch = {};
    if (startDate) dateMatch.$gte = new Date(startDate);
    if (endDate) {
      const e = new Date(endDate);
      e.setHours(23, 59, 59, 999);
      dateMatch.$lte = e;
    }

    // Aggregate per-ledger debit/credit totals in the period
    const periodMatch = {
      companyId: new mongoose.Types.ObjectId(companyId),
      status: "posted",
    };
    if (Object.keys(dateMatch).length) periodMatch.voucherDate = dateMatch;

    const periodAgg = await Acc_Voucher.aggregate([
      { $match: periodMatch },
      { $unwind: "$ledgerEntries" },
      {
        $group: {
          _id: "$ledgerEntries.ledgerId",
          debit: {
            $sum: {
              $cond: [
                { $eq: ["$ledgerEntries.type", "Dr"] },
                "$ledgerEntries.amount",
                0,
              ],
            },
          },
          credit: {
            $sum: {
              $cond: [
                { $eq: ["$ledgerEntries.type", "Cr"] },
                "$ledgerEntries.amount",
                0,
              ],
            },
          },
          txCount: { $sum: 1 },
        },
      },
    ]);
    const periodMap = new Map(periodAgg.map((a) => [String(a._id), a]));

    // Aggregate opening totals (everything strictly before startDate)
    let openingMap = new Map();
    if (startDate) {
      const openAgg = await Acc_Voucher.aggregate([
        {
          $match: {
            companyId: new mongoose.Types.ObjectId(companyId),
            status: "posted",
            voucherDate: { $lt: new Date(startDate) },
          },
        },
        { $unwind: "$ledgerEntries" },
        {
          $group: {
            _id: "$ledgerEntries.ledgerId",
            total: { $sum: "$ledgerEntries.signedAmount" },
          },
        },
      ]);
      openingMap = new Map(openAgg.map((a) => [String(a._id), a.total]));
    }

    const rows = ledgers.map((l) => {
      const period = periodMap.get(String(l._id)) || {
        debit: 0,
        credit: 0,
        txCount: 0,
      };
      const priorTxn = openingMap.get(String(l._id)) || 0;
      const opening = (l.openingBalance || 0) + priorTxn;
      const closing = opening + period.debit - period.credit;
      const row = {
        ledgerId: l._id,
        name: l.name,
        groupName: l.groupName,
        nature: l.nature,
        opening,
        openingType: opening >= 0 ? "Dr" : "Cr",
        debit: period.debit,
        credit: period.credit,
        txCount: period.txCount,
        closing,
        closingType: closing >= 0 ? "Dr" : "Cr",
        // Flat Dr/Cr columns (typical Tally trial balance format):
        // ledger goes into the Dr column if its closing is +ve, Cr column if -ve
        drColumn: closing >= 0 ? closing : 0,
        crColumn: closing < 0 ? Math.abs(closing) : 0,
      };
      // Optional drag-and-drop fields (added Apr 2026). Wrapped so legacy
      // ledgers without these fields never crash the route. The frontend
      // uses groupId for drop targeting; groupOrder for stable manual
      // sorting set elsewhere (BS/P&L drag-reorder writes this).
      try {
        row.groupId = l.groupId || null;
        row.groupOrder = l.groupOrder === undefined ? null : l.groupOrder;
      } catch (_) {
        /* defensive */
      }
      return row;
    });

    // Sort rows by groupOrder (when present), then name. Wrapped so a
    // bad comparator never kills the response.
    try {
      rows.sort((a, b) => {
        // Primary: keep current groupName grouping so the front-end's
        // by-nature → by-group nesting stays coherent.
        if (a.groupName !== b.groupName)
          return (a.groupName || "").localeCompare(b.groupName || "");
        const ao = a.groupOrder,
          bo = b.groupOrder;
        if (ao != null && bo == null) return -1;
        if (ao == null && bo != null) return 1;
        if (ao != null && bo != null && ao !== bo) return ao - bo;
        return (a.name || "").localeCompare(b.name || "");
      });
    } catch (sortErr) {
      console.warn("[trial-balance] sort skipped:", sortErr.message);
    }

    // Filter out completely-zero ledgers? Keep them — auditors want to see "not used yet" too.
    // Group totals
    const byGroup = new Map();
    for (const r of rows) {
      if (!byGroup.has(r.groupName)) {
        byGroup.set(r.groupName, {
          groupName: r.groupName,
          nature: r.nature,
          groupId: r.groupId || null, // ← for drop-target wiring
          debit: 0,
          credit: 0,
          drColumn: 0,
          crColumn: 0,
        });
      }
      const g = byGroup.get(r.groupName);
      g.debit += r.debit;
      g.credit += r.credit;
      g.drColumn += r.drColumn;
      g.crColumn += r.crColumn;
    }

    const totals = {
      debit: rows.reduce((s, r) => s + r.debit, 0),
      credit: rows.reduce((s, r) => s + r.credit, 0),
      drColumn: rows.reduce((s, r) => s + r.drColumn, 0),
      crColumn: rows.reduce((s, r) => s + r.crColumn, 0),
    };
    totals.balanced = Math.abs(totals.drColumn - totals.crColumn) < 0.01;
    totals.imbalance = totals.drColumn - totals.crColumn;

    res.json({
      success: true,
      period: { startDate: startDate || null, endDate: endDate || null },
      ledgers: rows,
      groups: Array.from(byGroup.values()).sort((a, b) =>
        a.groupName.localeCompare(b.groupName),
      ),
      totals,
    });
  } catch (err) {
    console.error("Trial balance:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/accountant/chart-of-accounts/groups/:id/statement
// Group-level statement — consolidated transactions across all child ledgers.
// Used when accountant clicks a group node and wants to see "all postings under
// this group in one report" (e.g. "Show me all bank transactions").
// ─────────────────────────────────────────────────────────────────────────────
router.get("/groups/:id/statement", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const group = await Acc_Group.findById(req.params.id).lean();
    if (!group)
      return res
        .status(404)
        .json({ success: false, message: "Group not found" });

    // Collect this group + all descendants recursively
    const allGroups = await Acc_Group.find({
      companyId: group.companyId,
      isActive: true,
    }).lean();
    const groupMap = new Map(allGroups.map((g) => [String(g._id), g]));
    function collectDescendantIds(rootId) {
      const ids = [String(rootId)];
      const queue = [String(rootId)];
      while (queue.length) {
        const cur = queue.shift();
        for (const g of allGroups) {
          if (String(g.parent) === cur) {
            ids.push(String(g._id));
            queue.push(String(g._id));
          }
        }
      }
      return ids;
    }
    const groupIds = collectDescendantIds(group._id);

    const ledgers = await Acc_Ledger.find({
      companyId: group.companyId,
      groupId: { $in: groupIds },
      isActive: true,
    }).lean();
    const ledgerIds = ledgers.map((l) => l._id);

    const dateFilter = {};
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate) {
      const e = new Date(endDate);
      e.setHours(23, 59, 59, 999);
      dateFilter.$lte = e;
    }

    const filter = {
      "ledgerEntries.ledgerId": { $in: ledgerIds },
      status: "posted",
    };
    if (Object.keys(dateFilter).length) filter.voucherDate = dateFilter;

    const vouchers = await Acc_Voucher.find(filter)
      .sort({ voucherDate: 1, createdAt: 1 })
      .select(
        "voucherType voucherTypeName voucherNumber voucherDate partyLedgerName narration ledgerEntries grandTotal",
      )
      .lean();

    // Each row = one voucher entry within our scope
    const lines = [];
    let totalDebit = 0,
      totalCredit = 0;
    const ledgerIdSet = new Set(ledgerIds.map((id) => String(id)));
    for (const v of vouchers) {
      const myLines = v.ledgerEntries.filter((e) =>
        ledgerIdSet.has(String(e.ledgerId)),
      );
      for (const e of myLines) {
        const dr = e.type === "Dr" ? e.amount : 0;
        const cr = e.type === "Cr" ? e.amount : 0;
        totalDebit += dr;
        totalCredit += cr;
        lines.push({
          voucherId: v._id,
          date: v.voucherDate,
          voucherType: v.voucherType,
          voucherTypeName: v.voucherTypeName,
          voucherNumber: v.voucherNumber,
          ledgerName: e.ledgerName,
          ledgerId: e.ledgerId,
          particulars: v.partyLedgerName || v.narration || "",
          narration: v.narration,
          debit: dr,
          credit: cr,
        });
      }
    }

    res.json({
      success: true,
      group: {
        _id: group._id,
        name: group.name,
        nature: group.nature,
        fullPath: group.fullPath,
      },
      descendantGroupCount: groupIds.length - 1,
      ledgerCount: ledgers.length,
      period: { startDate, endDate },
      lines,
      totals: { debit: totalDebit, credit: totalCredit, txCount: lines.length },
    });
  } catch (err) {
    console.error("Group statement:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PAYROLL → LEDGER posting
//   GET  /payroll/runs                     — list payroll runs with posting status
//   POST /payroll/runs/:runId/post         — post a single run as a journal voucher
//   POST /payroll/runs/post-all            — post every unposted run for a company
//   GET  /payroll/runs/:runId/preview      — preview the journal voucher that would be created
//   POST /payroll/runs/:runId/unpost       — void the auto-created voucher (for re-posting)
//
// Payroll is computed and stored by the HR module (Payroll + PayrollItem
// collections). The HR module does NOT post journal vouchers on its own, so
// salary expense and statutory deductions never reach the chart of accounts.
//
// These endpoints bridge the gap. They generate a single Journal voucher per
// payroll run that follows standard Indian payroll accounting:
//
//   Dr   Salaries A/c                        (Total Gross Earnings)
//        Cr   Provident Fund Payable A/c     (Total PF deductions)
//        Cr   ESI Payable A/c                (Total ESI deductions)
//        Cr   Other Deductions Payable A/c   (Other deductions, if any)
//        Cr   Salary Payable A/c             (Net Pay  — to be paid via bank later)
//
// Idempotency: each voucher is tagged with sourceSystem="auto_from_payroll"
// and sourceId=payrollRunId. Re-posting the same run returns the existing
// voucher rather than creating a duplicate.
// ─────────────────────────────────────────────────────────────────────────────

// ── Helper: load HR Payroll models (lazy require so this file loads even if
// the HR module is missing in some environments) ─────────────────────────────
function loadPayrollModels() {
  try {
    return require("../../models/HR_Models/Payroll");
  } catch (e) {
    return null;
  }
}

// ── Helper: find-or-create a ledger by name under a group matching some hint
// We try multiple candidate group names (in priority order) and pick the first
// matching one that exists. If we can't find a sensible group, we fall back to
// the first group with the requested nature. If we can't find a ledger by any
// of the candidate names, we create one under the resolved group.
// ─────────────────────────────────────────────────────────────────────────────
async function findOrCreateLedger(
  companyId,
  ledgerNames,
  groupHints,
  requiredNature,
) {
  // 1) Try to find an existing ledger by any of the candidate names
  for (const name of ledgerNames) {
    const existing = await Acc_Ledger.findOne({
      companyId,
      isActive: true,
      name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
    }).lean();
    if (existing) return existing;
  }

  // 2) No ledger by name. Find a target group.
  const allGroups = await Acc_Group.find({ companyId, isActive: true }).lean();

  let targetGroup = null;
  for (const hint of groupHints) {
    const re = new RegExp(hint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    targetGroup = allGroups.find((g) => re.test(g.name));
    if (targetGroup) break;
  }
  if (!targetGroup) {
    targetGroup = allGroups.find(
      (g) => g.nature === requiredNature && !g.parent,
    );
  }
  if (!targetGroup) {
    throw new Error(
      `Cannot find a suitable group for ledger "${ledgerNames[0]}" — please create one under ${requiredNature} groups first.`,
    );
  }

  // 3) Create the ledger
  const ledger = await Acc_Ledger.create({
    companyId,
    name: ledgerNames[0],
    groupId: targetGroup._id,
    groupName: targetGroup.name,
    nature: targetGroup.nature,
    openingBalance: 0,
    openingBalanceType:
      targetGroup.nature === "expense" || targetGroup.nature === "asset"
        ? "Dr"
        : "Cr",
    isActive: true,
    notes: "Auto-created for payroll posting",
  });
  return ledger.toObject();
}

// ── GET /payroll/runs — list payroll runs with posting status ─────────────
router.get("/payroll/runs", async (req, res) => {
  try {
    const { companyId, year, status } = req.query;
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });

    const HR = loadPayrollModels();
    if (!HR) return res.json({ success: true, runs: [], hrAvailable: false });
    const { Payroll, PayrollItem } = HR;

    const filter = {};
    if (year) filter.year = parseInt(year);
    if (status) filter.status = status;

    const runs = await Payroll.find(filter)
      .sort({ year: -1, month: -1 })
      .lean();

    // Pull every active voucher for these runs, then bucket by runId + kind
    const runIds = runs.map((r) => r._id);
    const existingVouchers = await Acc_Voucher.find({
      companyId,
      sourceSystem: "auto_from_payroll",
      sourceId: { $in: runIds },
      status: { $ne: "cancelled" },
    })
      .select(
        "_id voucherNumber sourceId sourceReference voucherDate grandTotal status voucherType",
      )
      .lean();

    // runId → { processing: voucher, payment: voucher }
    const voucherMap = new Map();
    for (const v of existingVouchers) {
      const kind = (v.sourceReference || "").split("/").pop() || "processing";
      const key = String(v.sourceId);
      if (!voucherMap.has(key)) voucherMap.set(key, {});
      voucherMap.get(key)[kind] = v;
    }

    res.json({
      success: true,
      hrAvailable: true,
      runs: runs.map((r) => {
        const vs = voucherMap.get(String(r._id)) || {};
        const hasProcessing = !!vs.processing;
        const hasPayment = !!vs.payment;
        const isPaidRun = r.status === "paid";

        // Posting status semantics:
        //   "complete"     — everything that should be posted IS posted
        //   "partial"      — processing posted, but a payment voucher is also
        //                    expected (paid run) and missing
        //   "not_posted"   — no vouchers exist at all
        let postingStatus = "not_posted";
        if (hasProcessing && (!isPaidRun || hasPayment))
          postingStatus = "complete";
        else if (hasProcessing && isPaidRun && !hasPayment)
          postingStatus = "partial";

        return {
          _id: r._id,
          year: r.year,
          month: r.month,
          payPeriod: r.payPeriod,
          status: r.status,
          paidAt: r.paidAt || null,
          totalEmployees: r.totalEmployees,
          totalGross: r.totalGross || 0,
          totalDeductions: r.totalDeductions || 0,
          totalNetPay: r.totalNetPay || 0,
          totalPF: r.totalPF || 0,
          totalESIC: r.totalESIC || 0,
          createdAt: r.createdAt,
          postingStatus,
          // Backwards-compat for existing callers — reflects "has any voucher"
          postedToLedgers: hasProcessing,
          processingVoucher: vs.processing || null,
          paymentVoucher: vs.payment || null,
          voucher: vs.processing || vs.payment || null,
        };
      }),
    });
  } catch (err) {
    console.error("List payroll runs:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Helper: build the journal voucher payload from a payroll run ──────────
// ── Helper: pick a bank ledger to use as the contra for paid payroll runs.
// Strategy: any ledger under the "Bank Accounts" group. If multiple, prefer
// one whose name contains "primary"/"main"/"current"; otherwise the first.
// If the accountant only has the placeholder "Bank Account" (from seed), use
// that. If they have an explicitly-passed `bankLedgerId`, honour it.
async function resolveBankLedgerForPayroll(companyId, explicitBankLedgerId) {
  if (explicitBankLedgerId) {
    const bl = await Acc_Ledger.findById(explicitBankLedgerId).lean();
    if (bl && String(bl.companyId) === String(companyId)) return bl;
  }
  // Find the "Bank Accounts" group
  const bankGroup = await Acc_Group.findOne({
    companyId,
    isActive: true,
    name: { $regex: /^bank accounts$/i },
  }).lean();
  if (!bankGroup) {
    throw new Error(
      "Cannot find a Bank Accounts group. Seed the chart first or create a bank ledger manually before posting paid payroll runs.",
    );
  }
  const banks = await Acc_Ledger.find({
    companyId,
    isActive: true,
    groupId: bankGroup._id,
  }).lean();
  if (banks.length === 0) {
    throw new Error(
      "No bank ledger found under Bank Accounts. Create at least one bank ledger (e.g. HDFC Current A/c) before posting paid payroll runs.",
    );
  }
  // Prefer something that looks like a primary account
  const primary = banks.find((b) =>
    /primary|main|current|operating/i.test(b.name),
  );
  return primary || banks[0];
}

async function buildPayrollVouchers(companyId, run, items, opts = {}) {
  // Resolve every ledger we'll need
  const salariesLedger = await findOrCreateLedger(
    companyId,
    [
      "Salaries (Office Staff)",
      "Salaries",
      "Salaries A/c",
      "Salary",
      "Wages & Salaries",
    ],
    [
      "administrative expenses",
      "indirect expense",
      "salaries",
      "wages",
      "employee",
      "expenses",
    ],
    "expense",
  );
  const pfPayable = await findOrCreateLedger(
    companyId,
    ["PF Payable", "Provident Fund Payable", "EPF Payable"],
    ["duties & taxes", "statutory", "current liab"],
    "liability",
  );
  const esiPayable = await findOrCreateLedger(
    companyId,
    ["ESI Payable", "ESIC Payable", "Employees State Insurance Payable"],
    ["duties & taxes", "statutory", "current liab"],
    "liability",
  );
  const otherDeductionsPayable = await findOrCreateLedger(
    companyId,
    ["Other Deductions Payable", "Salary Deductions Payable"],
    ["current liab", "statutory"],
    "liability",
  );
  const salaryPayable = await findOrCreateLedger(
    companyId,
    ["Salary Payable", "Salaries Payable", "Wages Payable"],
    ["provisions", "current liab", "salary"],
    "liability",
  );

  // Aggregate totals from items (re-derive in case the run-level totals are stale)
  const totals = items.reduce(
    (a, i) => ({
      gross: a.gross + (i.earnings?.grossEarnings || 0),
      pf: a.pf + (i.deductions?.providentFund || 0),
      esi: a.esi + (i.deductions?.esic || 0),
      tdsOther:
        a.tdsOther +
        Math.max(
          0,
          (i.deductions?.totalDeductions || 0) -
            (i.deductions?.providentFund || 0) -
            (i.deductions?.esic || 0),
        ),
      net: a.net + (i.netPay || 0),
      count: a.count + 1,
    }),
    { gross: 0, pf: 0, esi: 0, tdsOther: 0, net: 0, count: 0 },
  );

  // Sanity-check
  const computedNet = totals.gross - totals.pf - totals.esi - totals.tdsOther;
  if (Math.abs(computedNet - totals.net) > 1) {
    throw new Error(
      `Payroll math doesn't reconcile: gross ${totals.gross.toFixed(2)} − deductions = ${computedNet.toFixed(2)}, but net pay is ${totals.net.toFixed(2)} (diff ${Math.abs(computedNet - totals.net).toFixed(2)}). Re-process the payroll run before posting.`,
    );
  }

  // ── Voucher 1: PROCESSING (always created) ────────────────────────────
  // Dr Salaries A/c (gross) / Cr PF + ESI + Other Deductions + Salary Payable
  // This is the journal entry recognising the salary expense and accruing
  // the liability. Always created regardless of payment status.
  const processingDate = new Date(run.year, run.month, 0); // last day of the pay-period month
  const processingEntries = [
    {
      ledgerId: salariesLedger._id,
      ledgerName: salariesLedger.name,
      groupName: salariesLedger.groupName,
      type: "Dr",
      amount: totals.gross,
    },
  ];
  if (totals.pf > 0)
    processingEntries.push({
      ledgerId: pfPayable._id,
      ledgerName: pfPayable.name,
      groupName: pfPayable.groupName,
      type: "Cr",
      amount: totals.pf,
    });
  if (totals.esi > 0)
    processingEntries.push({
      ledgerId: esiPayable._id,
      ledgerName: esiPayable.name,
      groupName: esiPayable.groupName,
      type: "Cr",
      amount: totals.esi,
    });
  if (totals.tdsOther > 0)
    processingEntries.push({
      ledgerId: otherDeductionsPayable._id,
      ledgerName: otherDeductionsPayable.name,
      groupName: otherDeductionsPayable.groupName,
      type: "Cr",
      amount: totals.tdsOther,
    });
  if (totals.net > 0)
    processingEntries.push({
      ledgerId: salaryPayable._id,
      ledgerName: salaryPayable.name,
      groupName: salaryPayable.groupName,
      type: "Cr",
      amount: totals.net,
    });

  const vouchers = [
    {
      kind: "processing",
      voucherType: "journal",
      voucherTypeName: "Journal",
      voucherDate: processingDate,
      entries: processingEntries,
      grandTotal: totals.gross,
      narration: `Salary processed for ${run.payPeriod || `${run.year}-${run.month}`} — ${items.length} employees`,
    },
  ];

  // ── Voucher 2: PAYMENT (only if run.status === "paid") ────────────────
  // Dr Salary Payable (net) / Cr Bank A/c
  // This clears the liability accrued in Voucher 1 and records the bank
  // outflow. After both vouchers, Salary Payable nets to zero for this run.
  if (run.status === "paid" && totals.net > 0) {
    const bankLedger = await resolveBankLedgerForPayroll(
      companyId,
      opts.bankLedgerId,
    );
    const paymentDate = run.paidAt ? new Date(run.paidAt) : processingDate;
    vouchers.push({
      kind: "payment",
      voucherType: "payment",
      voucherTypeName: "Payment",
      voucherDate: paymentDate,
      entries: [
        {
          ledgerId: salaryPayable._id,
          ledgerName: salaryPayable.name,
          groupName: salaryPayable.groupName,
          type: "Dr",
          amount: totals.net,
        },
        {
          ledgerId: bankLedger._id,
          ledgerName: bankLedger.name,
          groupName: bankLedger.groupName,
          type: "Cr",
          amount: totals.net,
        },
      ],
      grandTotal: totals.net,
      narration: `Salary paid for ${run.payPeriod || `${run.year}-${run.month}`} via ${bankLedger.name}`,
      bankLedger: { _id: bankLedger._id, name: bankLedger.name },
    });
  }

  return {
    vouchers,
    totals,
    ledgerIds: {
      salariesLedger,
      pfPayable,
      esiPayable,
      otherDeductionsPayable,
      salaryPayable,
    },
  };
}

// Backwards-compatible: old code imports buildPayrollVoucher (singular) — keep it
// returning the FIRST voucher only, so anything that hasn't been migrated still
// produces a sensible journal even if it doesn't know about payments.
async function buildPayrollVoucher(companyId, run, items, opts = {}) {
  const built = await buildPayrollVouchers(companyId, run, items, opts);
  const first = built.vouchers[0];
  return {
    entries: first.entries,
    totals: built.totals,
    voucherDate: first.voucherDate,
    ledgerIds: built.ledgerIds,
  };
}

// ── GET /payroll/runs/:runId/preview ──────────────────────────────────────
router.get("/payroll/runs/:runId/preview", async (req, res) => {
  try {
    const { companyId, bankLedgerId } = req.query;
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });
    const HR = loadPayrollModels();
    if (!HR)
      return res
        .status(400)
        .json({ success: false, message: "HR/Payroll module not available." });

    const run = await HR.Payroll.findById(req.params.runId).lean();
    if (!run)
      return res
        .status(404)
        .json({ success: false, message: "Payroll run not found" });

    const items = await HR.PayrollItem.find({
      payrollId: req.params.runId,
    }).lean();
    if (items.length === 0)
      return res
        .status(400)
        .json({ success: false, message: "Payroll run has no items to post." });

    let built;
    try {
      built = await buildPayrollVouchers(companyId, run, items, {
        bankLedgerId,
      });
    } catch (e) {
      // Bank-ledger missing for paid runs is the most common cause — return a
      // clear hint so the UI can prompt the accountant to create one.
      return res.json({
        success: false,
        message: e.message,
        run: {
          _id: run._id,
          payPeriod: run.payPeriod,
          year: run.year,
          month: run.month,
          status: run.status,
          totalEmployees: items.length,
        },
        bankSetupNeeded: /bank/i.test(e.message),
      });
    }

    res.json({
      success: true,
      run: {
        _id: run._id,
        payPeriod: run.payPeriod,
        year: run.year,
        month: run.month,
        status: run.status,
        totalEmployees: items.length,
      },
      vouchers: built.vouchers.map((v) => ({
        kind: v.kind,
        voucherType: v.voucherType,
        voucherDate: v.voucherDate,
        narration: v.narration,
        entries: v.entries,
        grandTotal: v.grandTotal,
        bankLedger: v.bankLedger || null,
      })),
      totals: built.totals,
    });
  } catch (err) {
    console.error("Payroll preview:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Helper: post (or re-post) the missing vouchers for a payroll run.
// Returns { created: [...], skipped: [...] }
//
// Why a helper: a run can flip from "processed" to "paid" later. The first
// time we post we may only create the journal; later when the user marks the
// run paid, we want to add the payment voucher without duplicating the journal.
// We use sourceReference to discriminate: "Payroll/<period>/processing" vs
// "Payroll/<period>/payment".
//
// Voucher-number safety: Acc_Voucher.nextVoucherNumber sorts by createdAt to
// find the latest, but two vouchers created in the same millisecond can return
// the same "next" number, which then collides on the unique index. We work
// around this by computing the next number from the actual MAX numeric suffix
// across ALL vouchers (active + cancelled), and retrying on duplicate-key
// errors with a fresh number.
async function getNextVoucherNumberSafe(companyId, voucherType) {
  const today = new Date();
  const fy =
    today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
  const fyShort = `${fy.toString().slice(2)}${(fy + 1).toString().slice(2)}`;
  const prefixMap = {
    sales: "SL",
    purchase: "PU",
    receipt: "RC",
    payment: "PY",
    contra: "CN",
    journal: "JV",
    credit_note: "CR",
    debit_note: "DR",
    stock_journal: "SJ",
  };
  const prefix = prefixMap[voucherType] || "VC";

  // Look up by the actual voucherNumber STRING prefix (`JV/2627/`), NOT by
  // the stored `financialYear` field. The two can disagree: the prefix uses
  // today's FY but the stored financialYear is derived from voucherDate.
  // What we need to avoid is colliding with the unique index, which only
  // sees the voucher number string.
  //
  // Match `<prefix>/<fyShort>/<digits>` exactly so a custom-numbered voucher
  // with a different format doesn't poison the lookup.
  const numberRegex = new RegExp(`^${prefix}/${fyShort}/\\d+$`);
  const rows = await Acc_Voucher.find({
    companyId,
    voucherType,
    voucherNumber: { $regex: numberRegex },
  })
    .select("voucherNumber")
    .lean();

  let maxSeq = 0;
  for (const r of rows) {
    const m = (r.voucherNumber || "").match(/(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > maxSeq) maxSeq = n;
    }
  }

  // Belt-and-suspenders: even after computing maxSeq, double-check the chosen
  // number doesn't already exist (defensive against very rare race or stale
  // index reads). Walk forward until we find a free slot.
  let seq = maxSeq + 1;
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = `${prefix}/${fyShort}/${seq.toString().padStart(5, "0")}`;
    const existing = await Acc_Voucher.exists({
      companyId,
      voucherType,
      voucherNumber: candidate,
    });
    if (!existing) return candidate;
    seq++;
  }
  // Fall back to a timestamp-based suffix if we somehow can't find a free slot
  return `${prefix}/${fyShort}/T${Date.now().toString().slice(-7)}`;
}

async function createVoucherWithRetry(
  payload,
  voucherType,
  companyId,
  attempts = 5,
) {
  for (let i = 0; i < attempts; i++) {
    const voucherNumber = await getNextVoucherNumberSafe(
      companyId,
      voucherType,
    );
    try {
      const voucher = await Acc_Voucher.create({ ...payload, voucherNumber });
      return voucher;
    } catch (e) {
      const isDup =
        e &&
        (e.code === 11000 || /E11000|duplicate key/i.test(e.message || ""));
      if (!isDup || i === attempts - 1) throw e;
      // small jitter sleep so concurrent callers diverge
      await new Promise((r) => setTimeout(r, 25 + Math.random() * 50));
    }
  }
  throw new Error(
    "Could not allocate a unique voucher number after multiple attempts.",
  );
}

async function postPayrollRun(companyId, run, items, opts = {}) {
  // Look at existing vouchers for this run
  const existingVouchers = await Acc_Voucher.find({
    companyId,
    sourceSystem: "auto_from_payroll",
    sourceId: run._id,
    status: { $ne: "cancelled" }, // ignore cancelled — they don't block re-post
  }).lean();
  const existingKinds = new Set(
    existingVouchers
      .map((v) => (v.sourceReference || "").split("/").pop())
      .filter(Boolean),
  );

  const built = await buildPayrollVouchers(companyId, run, items, opts);

  const created = [];
  const skipped = [];

  for (const v of built.vouchers) {
    if (existingKinds.has(v.kind)) {
      skipped.push({ kind: v.kind, reason: "already posted" });
      continue;
    }
    const voucher = await createVoucherWithRetry(
      {
        companyId,
        voucherType: v.voucherType,
        voucherTypeName: v.voucherTypeName,
        voucherDate: v.voucherDate,
        ledgerEntries: v.entries,
        grandTotal: v.grandTotal,
        narration: v.narration,
        status: "posted",
        sourceSystem: "auto_from_payroll",
        sourceId: run._id,
        sourceReference: `Payroll/${run.payPeriod || `${run.year}-${run.month}`}/${v.kind}`,
        postedAt: new Date(),
      },
      v.voucherType,
      companyId,
    );

    // Apply ledger balance changes
    for (const entry of v.entries) {
      const signed = entry.type === "Dr" ? entry.amount : -entry.amount;
      await Acc_Ledger.findByIdAndUpdate(entry.ledgerId, {
        $inc: { currentBalance: signed },
      });
    }
    created.push({
      kind: v.kind,
      voucherNumber: voucher.voucherNumber,
      voucherId: voucher._id,
    });
  }

  return { created, skipped, totals: built.totals };
}

// ── POST /payroll/runs/:runId/post ────────────────────────────────────────
router.post("/payroll/runs/:runId/post", async (req, res) => {
  try {
    const { companyId, bankLedgerId } = req.body;
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });

    const HR = loadPayrollModels();
    if (!HR)
      return res
        .status(400)
        .json({ success: false, message: "HR/Payroll module not available." });

    const run = await HR.Payroll.findById(req.params.runId).lean();
    if (!run)
      return res
        .status(404)
        .json({ success: false, message: "Payroll run not found" });

    const items = await HR.PayrollItem.find({
      payrollId: req.params.runId,
    }).lean();
    if (items.length === 0)
      return res
        .status(400)
        .json({ success: false, message: "Payroll run has no items to post." });

    let result;
    try {
      result = await postPayrollRun(companyId, run, items, { bankLedgerId });
    } catch (e) {
      return res.status(400).json({
        success: false,
        message: e.message,
        bankSetupNeeded: /bank/i.test(e.message),
      });
    }

    if (result.created.length === 0) {
      return res.json({
        success: true,
        alreadyPosted: true,
        skipped: result.skipped,
        message: "No new vouchers needed — already up to date.",
      });
    }
    res.json({
      success: true,
      alreadyPosted: false,
      created: result.created,
      skipped: result.skipped,
      message: `Posted ${result.created.length} voucher(s): ${result.created.map((c) => `${c.kind} (${c.voucherNumber})`).join(", ")}`,
    });
  } catch (err) {
    console.error("Post payroll:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /payroll/runs/post-all — post every unposted run for a company ──
router.post("/payroll/runs/post-all", async (req, res) => {
  try {
    const { companyId, year } = req.body;
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });

    const HR = loadPayrollModels();
    if (!HR)
      return res
        .status(400)
        .json({ success: false, message: "HR/Payroll module not available." });

    const filter = {};
    if (year) filter.year = parseInt(year);
    const runs = await HR.Payroll.find(filter)
      .sort({ year: 1, month: 1 })
      .lean();

    const results = [];
    for (const run of runs) {
      try {
        const items = await HR.PayrollItem.find({ payrollId: run._id }).lean();
        if (items.length === 0) {
          results.push({
            runId: run._id,
            payPeriod: run.payPeriod,
            status: "skipped_empty",
          });
          continue;
        }
        const r = await postPayrollRun(companyId, run, items, {});
        if (r.created.length === 0) {
          results.push({
            runId: run._id,
            payPeriod: run.payPeriod,
            status: "already_posted",
          });
        } else {
          results.push({
            runId: run._id,
            payPeriod: run.payPeriod,
            status: "posted",
            createdKinds: r.created.map((c) => c.kind),
            voucherNumbers: r.created.map((c) => c.voucherNumber),
          });
        }
      } catch (e) {
        results.push({
          runId: run._id,
          payPeriod: run.payPeriod,
          status: "error",
          error: e.message,
        });
      }
    }

    res.json({
      success: true,
      results,
      summary: {
        total: results.length,
        posted: results.filter((r) => r.status === "posted").length,
        alreadyPosted: results.filter((r) => r.status === "already_posted")
          .length,
        skipped: results.filter((r) => r.status === "skipped_empty").length,
        errored: results.filter((r) => r.status === "error").length,
      },
    });
  } catch (err) {
    console.error("Post all payroll:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /payroll/cleanup — emergency reset
// Removes ALL auto_from_payroll vouchers for a company (both active and
// cancelled), reverses ledger balances of any still-active ones, and frees
// up the voucher numbers. Use this when previous post/unpost attempts have
// left the database in an inconsistent state (typically: duplicate-key
// errors after multiple failed unposts).
router.post("/payroll/cleanup", async (req, res) => {
  try {
    const { companyId, confirm } = req.body;
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });
    if (confirm !== "RESET_PAYROLL_VOUCHERS") {
      return res.status(400).json({
        success: false,
        message:
          "This is destructive. Pass confirm: 'RESET_PAYROLL_VOUCHERS' to proceed.",
      });
    }

    const vouchers = await Acc_Voucher.find({
      companyId,
      sourceSystem: "auto_from_payroll",
    });

    let reversedCount = 0;
    for (const v of vouchers) {
      if (v.status !== "cancelled") {
        for (const entry of v.ledgerEntries) {
          const signed = entry.type === "Dr" ? -entry.amount : entry.amount;
          await Acc_Ledger.findByIdAndUpdate(entry.ledgerId, {
            $inc: { currentBalance: signed },
          });
        }
        reversedCount++;
      }
      await Acc_Voucher.deleteOne({ _id: v._id });
    }

    res.json({
      success: true,
      message: `Cleaned up ${vouchers.length} payroll voucher(s) (${reversedCount} balances reversed). Now click "Post all" to re-post fresh.`,
      removed: vouchers.length,
      balancesReversed: reversedCount,
    });
  } catch (err) {
    console.error("Payroll cleanup:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /payroll/runs/:runId/unpost — cancel ALL auto-created vouchers
// (a paid run can have BOTH a journal and a payment voucher; we reverse both).
//
// We HARD DELETE these vouchers (rather than soft-cancel) because:
//   • They were never human-entered — the payroll run is the source of truth
//   • A soft-cancelled voucher still occupies its (companyId, voucherType,
//     voucherNumber) slot in the unique index, which causes "duplicate key"
//     errors on the next post attempt because the model's nextVoucherNumber
//     looks at most-recently-created (not max-numeric), and finding a
//     cancelled voucher with number N can mislead it into returning N+1
//     when N+1 is also already taken (cancelled).
router.post("/payroll/runs/:runId/unpost", async (req, res) => {
  try {
    const { companyId } = req.body;
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });

    // Match BOTH active and cancelled vouchers — we want to clean up whatever's
    // there. Reverse balances only for vouchers that are currently posted.
    const vouchers = await Acc_Voucher.find({
      companyId,
      sourceSystem: "auto_from_payroll",
      sourceId: req.params.runId,
    });
    if (vouchers.length === 0)
      return res
        .status(404)
        .json({ success: false, message: "No vouchers found for this run." });

    const reversed = [];
    const deleted = [];
    for (const voucher of vouchers) {
      // If still active (posted), reverse its ledger balance impact first.
      if (voucher.status !== "cancelled") {
        for (const entry of voucher.ledgerEntries) {
          const signed = entry.type === "Dr" ? -entry.amount : entry.amount;
          await Acc_Ledger.findByIdAndUpdate(entry.ledgerId, {
            $inc: { currentBalance: signed },
          });
        }
        reversed.push(voucher.voucherNumber);
      }
      // Hard delete so the voucher number is freed for re-post
      await Acc_Voucher.deleteOne({ _id: voucher._id });
      deleted.push({
        voucherNumber: voucher.voucherNumber,
        kind: (voucher.sourceReference || "").split("/").pop(),
      });
    }

    res.json({
      success: true,
      message: `Removed ${deleted.length} voucher(s): ${deleted.map((d) => `${d.kind} (${d.voucherNumber})`).join(", ")}`,
      deleted,
      reversed,
    });
  } catch (err) {
    console.error("Unpost payroll:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MANUFACTURING CHART SEEDER
//
// POST /seed-manufacturing
//   Body: { companyId, dryRun? }
//
// Populates the chart with the standard manufacturing-industry set of
// sub-groups + ledgers, layered on top of the 28 default Tally primary groups
// that are auto-seeded when a company is created.
//
// Idempotent — running twice does not duplicate. For each item:
//   1. Look up the group/ledger by (companyId, exact name)
//   2. If it already exists, skip
//   3. Otherwise create it under the resolved parent
//
// Returns counts of what was created and what was skipped.
// ─────────────────────────────────────────────────────────────────────────────

// The chart, as a flat list of (parent → children) instructions.
// `kind` is "group" or "ledger".  `parent` is the NAME of an existing group
// (created earlier in the array, or one of the 28 default Tally groups).
const MANUFACTURING_CHART = [
  // ── ASSETS ────────────────────────────────────────────────────────────────
  { kind: "ledger", parent: "Cash-in-Hand", name: "Cash in Hand" },
  {
    kind: "ledger",
    parent: "Bank Accounts",
    name: "Bank Account",
    note: "Add specific bank ledgers (e.g. HDFC Current A/c) here",
  },

  // Inventory under Stock-in-Hand
  { kind: "group", parent: "Stock-in-Hand", name: "Inventory" },
  { kind: "ledger", parent: "Inventory", name: "Raw Materials" },
  { kind: "ledger", parent: "Inventory", name: "Work-in-Progress" },
  { kind: "ledger", parent: "Inventory", name: "Finished Goods" },
  { kind: "ledger", parent: "Inventory", name: "Stores & Spares" },
  { kind: "ledger", parent: "Inventory", name: "Packing Materials" },

  // Loans & Advances + GST Input
  {
    kind: "ledger",
    parent: "Loans & Advances (Asset)",
    name: "Advances to Suppliers",
  },
  {
    kind: "ledger",
    parent: "Loans & Advances (Asset)",
    name: "Employee Advances",
  },
  { kind: "group", parent: "Loans & Advances (Asset)", name: "GST Input" },
  {
    kind: "ledger",
    parent: "GST Input",
    name: "CGST Input",
    gstApplicable: true,
  },
  {
    kind: "ledger",
    parent: "GST Input",
    name: "SGST Input",
    gstApplicable: true,
  },
  {
    kind: "ledger",
    parent: "GST Input",
    name: "IGST Input",
    gstApplicable: true,
  },

  // Bills Receivable + Other Current Assets
  { kind: "group", parent: "Current Assets", name: "Other Current Assets" },
  { kind: "ledger", parent: "Other Current Assets", name: "Prepaid Expenses" },
  { kind: "ledger", parent: "Other Current Assets", name: "Accrued Income" },
  { kind: "ledger", parent: "Other Current Assets", name: "Bills Receivable" },

  // Fixed Assets
  { kind: "ledger", parent: "Fixed Assets", name: "Land" },
  { kind: "ledger", parent: "Fixed Assets", name: "Building" },
  { kind: "ledger", parent: "Fixed Assets", name: "Plant & Machinery" },
  { kind: "ledger", parent: "Fixed Assets", name: "Furniture & Fixtures" },
  { kind: "ledger", parent: "Fixed Assets", name: "Vehicles" },
  { kind: "ledger", parent: "Fixed Assets", name: "Office Equipment" },
  { kind: "ledger", parent: "Fixed Assets", name: "Capital Work-in-Progress" },

  { kind: "group", parent: "Fixed Assets", name: "Intangible Assets" },
  { kind: "ledger", parent: "Intangible Assets", name: "Software" },
  { kind: "ledger", parent: "Intangible Assets", name: "Patents" },

  // Investments
  { kind: "ledger", parent: "Investments", name: "Long-term Investments" },

  // ── LIABILITIES ──────────────────────────────────────────────────────────
  // Duties & Taxes
  { kind: "group", parent: "Duties & Taxes", name: "GST Payable" },
  {
    kind: "ledger",
    parent: "GST Payable",
    name: "CGST Payable",
    gstApplicable: true,
  },
  {
    kind: "ledger",
    parent: "GST Payable",
    name: "SGST Payable",
    gstApplicable: true,
  },
  {
    kind: "ledger",
    parent: "GST Payable",
    name: "IGST Payable",
    gstApplicable: true,
  },
  { kind: "ledger", parent: "Duties & Taxes", name: "Income Tax Payable" },
  { kind: "ledger", parent: "Duties & Taxes", name: "TDS Payable" },
  { kind: "ledger", parent: "Duties & Taxes", name: "PF Payable" },
  { kind: "ledger", parent: "Duties & Taxes", name: "ESI Payable" },

  // Provisions
  { kind: "ledger", parent: "Provisions", name: "Salary Payable" },
  { kind: "ledger", parent: "Provisions", name: "Expenses Payable" },
  { kind: "ledger", parent: "Provisions", name: "Gratuity Provision" },
  { kind: "ledger", parent: "Provisions", name: "Deferred Tax Liability" },

  // Other current liabilities
  {
    kind: "group",
    parent: "Current Liabilities",
    name: "Other Current Liabilities",
  },
  {
    kind: "ledger",
    parent: "Other Current Liabilities",
    name: "Advances from Customers",
  },

  // Long-term borrowings (use existing Secured Loans default group)
  { kind: "ledger", parent: "Secured Loans", name: "Term Loan – Bank" },

  // Equity / Capital
  { kind: "ledger", parent: "Capital Account", name: "Share Capital" },
  { kind: "ledger", parent: "Reserves & Surplus", name: "Retained Earnings" },
  { kind: "ledger", parent: "Reserves & Surplus", name: "General Reserve" },

  // ── REVENUE ──────────────────────────────────────────────────────────────
  {
    kind: "ledger",
    parent: "Sales Accounts",
    name: "Domestic Sales",
    gstApplicable: true,
  },
  {
    kind: "ledger",
    parent: "Sales Accounts",
    name: "Export Sales",
    gstApplicable: true,
  },
  { kind: "ledger", parent: "Direct Incomes", name: "Scrap Sales" },
  { kind: "ledger", parent: "Direct Incomes", name: "Job Work Income" },
  { kind: "ledger", parent: "Indirect Incomes", name: "Interest Income" },
  { kind: "ledger", parent: "Indirect Incomes", name: "Miscellaneous Income" },

  // ── EXPENSES ─────────────────────────────────────────────────────────────
  // Direct Expenses → Factory Overheads, Production Expenses
  { kind: "group", parent: "Direct Expenses", name: "Factory Overheads" },
  { kind: "ledger", parent: "Factory Overheads", name: "Indirect Wages" },
  {
    kind: "ledger",
    parent: "Factory Overheads",
    name: "Repairs & Maintenance (Plant)",
  },
  { kind: "ledger", parent: "Factory Overheads", name: "Consumables" },
  { kind: "ledger", parent: "Factory Overheads", name: "Factory Insurance" },

  { kind: "group", parent: "Direct Expenses", name: "Production Expenses" },
  {
    kind: "ledger",
    parent: "Production Expenses",
    name: "Quality Control Expenses",
  },
  {
    kind: "ledger",
    parent: "Production Expenses",
    name: "Production Supplies",
  },

  // Indirect Expenses → Admin / Selling / Depreciation / Finance
  {
    kind: "group",
    parent: "Indirect Expenses",
    name: "Administrative Expenses",
  },
  {
    kind: "ledger",
    parent: "Administrative Expenses",
    name: "Salaries (Office Staff)",
  },
  { kind: "ledger", parent: "Administrative Expenses", name: "Office Rent" },
  {
    kind: "ledger",
    parent: "Administrative Expenses",
    name: "Printing & Stationery",
  },
  { kind: "ledger", parent: "Administrative Expenses", name: "Audit Fees" },
  { kind: "ledger", parent: "Administrative Expenses", name: "Legal Charges" },

  {
    kind: "group",
    parent: "Indirect Expenses",
    name: "Selling & Distribution Expenses",
  },
  {
    kind: "ledger",
    parent: "Selling & Distribution Expenses",
    name: "Sales Commission",
  },
  {
    kind: "ledger",
    parent: "Selling & Distribution Expenses",
    name: "Freight & Transportation",
  },
  {
    kind: "ledger",
    parent: "Selling & Distribution Expenses",
    name: "Advertisement & Marketing",
  },
  {
    kind: "ledger",
    parent: "Selling & Distribution Expenses",
    name: "Packing & Forwarding",
  },

  { kind: "group", parent: "Indirect Expenses", name: "Depreciation" },
  {
    kind: "ledger",
    parent: "Depreciation",
    name: "Depreciation – Plant & Machinery",
  },
  { kind: "ledger", parent: "Depreciation", name: "Depreciation – Building" },
  { kind: "ledger", parent: "Depreciation", name: "Depreciation – Vehicles" },

  { kind: "group", parent: "Indirect Expenses", name: "Finance Costs" },
  { kind: "ledger", parent: "Finance Costs", name: "Interest on Loans" },
  { kind: "ledger", parent: "Finance Costs", name: "Bank Charges" },
];

router.post("/seed-manufacturing", async (req, res) => {
  try {
    const { companyId, dryRun } = req.body;
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });

    // Self-heal: if the 28 default groups are missing, seed them now rather
    // than asking the user to "re-create the company". This used to be a
    // hard failure on companies created before the auto-seed-on-create flow,
    // or where that step silently failed. The seed function is idempotent
    // so this is safe to call every time.
    let existingGroups = await Acc_Group.find({
      companyId,
      isActive: true,
    }).lean();
    let autoSeededCount = 0;
    if (existingGroups.length === 0) {
      autoSeededCount = await ensureDefaultGroups(companyId, req.user?.id);
      existingGroups = await Acc_Group.find({
        companyId,
        isActive: true,
      }).lean();
    }
    if (existingGroups.length === 0) {
      return res.status(400).json({
        success: false,
        message:
          "Couldn't seed default groups. Check that ACC_DEFAULT_GROUPS is exported from Acc_MasterModels.",
      });
    }

    // Build a lookup by name (case-insensitive). We update this as we create new groups.
    const groupByName = new Map(
      existingGroups.map((g) => [g.name.toLowerCase(), g]),
    );

    // Existing ledgers — needed for idempotency
    const existingLedgers = await Acc_Ledger.find({
      companyId,
      isActive: true,
    })
      .select("name")
      .lean();
    const ledgerNameSet = new Set(
      existingLedgers.map((l) => l.name.toLowerCase()),
    );

    const results = {
      groupsCreated: [],
      groupsSkipped: [],
      ledgersCreated: [],
      ledgersSkipped: [],
      errors: [],
    };

    // ── Two-pass execution ──────────────────────────────────────────
    // Pass 1: create every group in MANUFACTURING_CHART. Resolution is
    //   layered — a group whose parent isn't yet in groupByName is
    //   deferred to the next iteration. We loop until either nothing
    //   changes (means truly missing parents in the chart definition)
    //   or all groups are placed.
    // Pass 2: create every ledger. By this point all groups exist in
    //   the lookup, so parent resolution can't fail unless the chart
    //   itself names a parent that doesn't exist.
    //
    // Why two passes:
    //   • The seed-manufacturing chart mixes groups and ledgers in
    //     display order. A single forward pass works if and only if
    //     every group precedes its children. Two passes are immune to
    //     that ordering accident.
    //   • Dry-run preview and real-run share the same control flow,
    //     so the "37 cannot be seeded" warning can never re-appear
    //     unless the chart genuinely references a nonexistent parent.
    //
    // For dry-run we use a simulated group object so subsequent items
    // can still resolve their parent without hitting the DB.

    const allGroupItems = MANUFACTURING_CHART.filter((x) => x.kind === "group");
    const allLedgerItems = MANUFACTURING_CHART.filter(
      (x) => x.kind === "ledger",
    );

    // Helper — try to create the group from `item`. Returns true if
    // it was created (or simulated, in dry-run), false if its parent
    // isn't yet resolvable.
    async function tryCreateGroup(item) {
      if (groupByName.has(item.name.toLowerCase())) {
        results.groupsSkipped.push(item.name);
        return true; // already done — counts as placed
      }
      const parent = groupByName.get(item.parent.toLowerCase());
      if (!parent) {
        return false; // defer to next iteration
      }
      if (dryRun) {
        const simulated = {
          _id: `__simulated__${item.name}`,
          name: item.name,
          parent: parent._id,
          parentName: parent.name,
          nature: parent.nature,
          level: (parent.level || 1) + 1,
          fullPath: `${parent.fullPath || parent.name} > ${item.name}`,
        };
        groupByName.set(item.name.toLowerCase(), simulated);
        results.groupsCreated.push(item.name);
        return true;
      }
      try {
        const doc = await Acc_Group.create({
          companyId,
          name: item.name,
          parent: parent._id,
          parentName: parent.name,
          isPrimary: false,
          isReserved: false,
          nature: parent.nature,
          level: (parent.level || 1) + 1,
          fullPath: `${parent.fullPath || parent.name} > ${item.name}`,
          description: item.note || `Auto-seeded — Manufacturing chart`,
          createdBy: req.user?.id,
        });
        groupByName.set(item.name.toLowerCase(), doc.toObject());
        results.groupsCreated.push(item.name);
        return true;
      } catch (e) {
        results.errors.push({ item: item.name, reason: e.message });
        return true; // don't keep retrying a doc that fails to insert
      }
    }

    // Pass 1: keep looping over the group list until no new groups can
    // be placed. Bounded by allGroupItems.length iterations so a bad
    // chart definition can't cause an infinite loop.
    const pendingGroups = [...allGroupItems];
    for (let pass = 0; pass < allGroupItems.length + 1; pass++) {
      const remaining = [];
      let placedThisPass = 0;
      for (const item of pendingGroups) {
        const placed = await tryCreateGroup(item);
        if (placed) placedThisPass++;
        else remaining.push(item);
      }
      if (remaining.length === 0) break;
      if (placedThisPass === 0) {
        // Stuck — none of the remaining can resolve. Record them all
        // as errors and stop.
        for (const item of remaining) {
          results.errors.push({
            item: item.name,
            reason: `Parent group "${item.parent}" not found`,
          });
        }
        break;
      }
      pendingGroups.length = 0;
      pendingGroups.push(...remaining);
    }

    // Pass 2: ledgers. By now every group that COULD be created has been.
    for (const item of allLedgerItems) {
      try {
        if (ledgerNameSet.has(item.name.toLowerCase())) {
          results.ledgersSkipped.push(item.name);
          continue;
        }
        const parent = groupByName.get(item.parent.toLowerCase());
        if (!parent) {
          results.errors.push({
            item: item.name,
            reason: `Parent group "${item.parent}" not found`,
          });
          continue;
        }
        if (dryRun) {
          ledgerNameSet.add(item.name.toLowerCase());
          results.ledgersCreated.push(item.name);
          continue;
        }
        await Acc_Ledger.create({
          companyId,
          name: item.name,
          groupId: parent._id,
          groupName: parent.name,
          nature: parent.nature,
          openingBalance: 0,
          openingBalanceType:
            parent.nature === "asset" || parent.nature === "expense"
              ? "Dr"
              : "Cr",
          currentBalance: 0,
          currentBalanceType:
            parent.nature === "asset" || parent.nature === "expense"
              ? "Dr"
              : "Cr",
          gstApplicable: !!item.gstApplicable,
          isActive: true,
          notes: item.note || "Auto-seeded — Manufacturing chart",
          createdBy: req.user?.id,
        });
        ledgerNameSet.add(item.name.toLowerCase());
        results.ledgersCreated.push(item.name);
      } catch (e) {
        results.errors.push({ item: item.name, reason: e.message });
      }
    }

    res.json({
      success: true,
      dryRun: !!dryRun,
      autoSeededDefaults: autoSeededCount,
      summary: {
        groupsCreated: results.groupsCreated.length,
        groupsSkipped: results.groupsSkipped.length,
        ledgersCreated: results.ledgersCreated.length,
        ledgersSkipped: results.ledgersSkipped.length,
        errors: results.errors.length,
      },
      details: results,
    });
  } catch (err) {
    console.error("Seed manufacturing:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PARTIES → LEDGERS sync
//
//   GET  /parties/preview        — what would be created (dry-run)
//   POST /parties/sync           — actually create the missing ledgers
//
// Mirrors the payroll bridge philosophy: the CMS has its own Customer and
// Vendor collections; the chart of accounts has Acc_Ledger. Without a bridge
// the Sundry Debtors group is empty even though you have customers.
//
// What this does:
//   • Pulls every Customer  → ensures a ledger under "Sundry Debtors"  exists
//   • Pulls every Vendor    → ensures a ledger under "Sundry Creditors" exists
//
// Idempotency: link by `linkedCustomerId` / `linkedVendorId` first, then by
// exact name match. Existing ledgers are updated (in sync mode) with the
// latest contact info; never duplicated.
// ─────────────────────────────────────────────────────────────────────────────

function loadCustomerModel() {
  try {
    return require("../../models/Customer_Models/Customer");
  } catch {
    return null;
  }
}
function loadVendorModel() {
  try {
    return require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
  } catch {
    return null;
  }
}

// Choose the best display-name for a party. Customer model uses `name`;
// Vendor uses `companyName`. Fall back to email/phone if neither is set.
function partyDisplayName(p, kind) {
  if (kind === "customer")
    return p.name || p.email || p.phone || "Unnamed Customer";
  return p.companyName || p.contactPerson || p.email || "Unnamed Vendor";
}

// Build the ledger payload from a customer/vendor record
function buildPartyLedger(p, kind, parentGroup, companyId) {
  const name = partyDisplayName(p, kind);
  const isCustomer = kind === "customer";
  return {
    companyId,
    name,
    groupId: parentGroup._id,
    groupName: parentGroup.name,
    nature: parentGroup.nature, // asset for debtors, liability for creditors
    openingBalance: 0,
    openingBalanceType: isCustomer ? "Dr" : "Cr",
    currentBalance: 0,
    currentBalanceType: isCustomer ? "Dr" : "Cr",
    billWiseEnabled: true, // party ledgers always bill-wise
    gstApplicable: !!(p.gstNumber || p.gstin),
    gstin: p.gstNumber || p.gstin || "",
    panNumber: p.panNumber || p.pan || "",
    contactDetails: {
      contactPerson: p.contactPerson || "",
      phone: p.phone || "",
      email: p.email || "",
      address:
        typeof p.address === "string"
          ? p.address
          : (p.address &&
              (p.address.line1 ||
                p.address.street ||
                JSON.stringify(p.address))) ||
            "",
    },
    [isCustomer ? "linkedCustomerId" : "linkedVendorId"]: p._id,
    isActive: true,
    notes: `Auto-synced from CMS ${isCustomer ? "Customer" : "Vendor"} record on ${new Date().toISOString().slice(0, 10)}`,
  };
}

// Decide the action for one party: create / update / skip
async function reconcilePartyLedger(
  party,
  kind,
  parentGroup,
  companyId,
  existingLedgers,
  dryRun,
) {
  const linkField = kind === "customer" ? "linkedCustomerId" : "linkedVendorId";
  const partyId = String(party._id);
  const displayName = partyDisplayName(party, kind);

  // 1) Try to find by linkage
  let existing = existingLedgers.find(
    (l) => String(l[linkField] || "") === partyId,
  );
  // 2) Fall back to exact name match (case-insensitive). If we find one, link it.
  if (!existing) {
    existing = existingLedgers.find(
      (l) =>
        l.groupId &&
        String(l.groupId) === String(parentGroup._id) &&
        l.name.toLowerCase() === displayName.toLowerCase(),
    );
  }

  if (existing) {
    // Already linked — nothing to do beyond optionally refreshing contact info
    return {
      kind: "exists",
      name: existing.name,
      ledgerId: existing._id,
      partyId,
    };
  }

  if (dryRun) {
    return { kind: "to_create", name: displayName, partyId };
  }

  const payload = buildPartyLedger(party, kind, parentGroup, companyId);
  const ledger = await Acc_Ledger.create(payload);
  existingLedgers.push(ledger.toObject()); // grow cache so duplicate-name parties don't double-create
  return { kind: "created", name: ledger.name, ledgerId: ledger._id, partyId };
}

// ── GET /parties/preview ─────────────────────────────────────────────────
router.get("/parties/preview", async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });
    return doPartiesSync(req, res, companyId, true);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /parties/sync ───────────────────────────────────────────────────
router.post("/parties/sync", async (req, res) => {
  try {
    const { companyId } = req.body;
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });
    return doPartiesSync(req, res, companyId, false);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

async function doPartiesSync(req, res, companyId, dryRun) {
  const Customer = loadCustomerModel();
  const Vendor = loadVendorModel();

  // Resolve target groups (must exist; they're system-reserved and seeded with the company).
  // Self-heal: if the chart is empty, top up the 28 defaults first so this
  // call succeeds rather than 400'ing.
  let allGroups = await Acc_Group.find({ companyId, isActive: true }).lean();
  if (allGroups.length === 0) {
    await ensureDefaultGroups(companyId, req.user?.id);
    allGroups = await Acc_Group.find({ companyId, isActive: true }).lean();
  }
  const debtorsGroup = allGroups.find((g) => /^sundry debtors$/i.test(g.name));
  const creditorsGroup = allGroups.find((g) =>
    /^sundry creditors$/i.test(g.name),
  );
  if (!debtorsGroup || !creditorsGroup) {
    return res.status(400).json({
      success: false,
      message:
        "Sundry Debtors / Sundry Creditors groups missing. Try running 'Seed Default Groups' first.",
    });
  }

  // Pull existing party ledgers (we only care about the two groups)
  const existingLedgers = await Acc_Ledger.find({
    companyId,
    isActive: true,
    groupId: { $in: [debtorsGroup._id, creditorsGroup._id] },
  }).lean();

  const result = {
    debtors: { created: [], existing: [], errors: [] },
    creditors: { created: [], existing: [], errors: [] },
    customerCount: 0,
    vendorCount: 0,
  };

  // Customers
  if (Customer) {
    const customers = await Customer.find({}).lean();
    result.customerCount = customers.length;
    for (const c of customers) {
      try {
        const r = await reconcilePartyLedger(
          c,
          "customer",
          debtorsGroup,
          companyId,
          existingLedgers,
          dryRun,
        );
        if (r.kind === "created" || r.kind === "to_create")
          result.debtors.created.push(r);
        else if (r.kind === "exists") result.debtors.existing.push(r);
      } catch (e) {
        result.debtors.errors.push({
          name: partyDisplayName(c, "customer"),
          reason: e.message,
        });
      }
    }
  } else {
    result.debtors.errors.push({
      name: "Customer model",
      reason: "Customer model not available in this environment.",
    });
  }

  // Vendors
  if (Vendor) {
    const vendors = await Vendor.find({}).lean();
    result.vendorCount = vendors.length;
    for (const v of vendors) {
      try {
        const r = await reconcilePartyLedger(
          v,
          "vendor",
          creditorsGroup,
          companyId,
          existingLedgers,
          dryRun,
        );
        if (r.kind === "created" || r.kind === "to_create")
          result.creditors.created.push(r);
        else if (r.kind === "exists") result.creditors.existing.push(r);
      } catch (e) {
        result.creditors.errors.push({
          name: partyDisplayName(v, "vendor"),
          reason: e.message,
        });
      }
    }
  } else {
    result.creditors.errors.push({
      name: "Vendor model",
      reason: "Vendor model not available in this environment.",
    });
  }

  res.json({
    success: true,
    dryRun,
    summary: {
      customersFound: result.customerCount,
      vendorsFound: result.vendorCount,
      debtorLedgersToCreate: result.debtors.created.length,
      debtorLedgersExisting: result.debtors.existing.length,
      creditorLedgersToCreate: result.creditors.created.length,
      creditorLedgersExisting: result.creditors.existing.length,
      errors: result.debtors.errors.length + result.creditors.errors.length,
    },
    details: result,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GSTIN LOOKUP & VALIDATION
//
// GET /gstin-lookup/:gstin
//
// Two-tier strategy:
//
//   TIER 1 — Offline parsing (free, always available)
//     Every GSTIN encodes structured data:
//       positions 1-2  = state code      → we know all 36 states/UTs
//       positions 3-12 = embedded PAN
//       position 13    = entity number for this PAN at this state
//       position 14    = "Z" by default
//       position 15    = check digit (mod-36 algorithm)
//     We validate format + checksum and decode state + PAN. This catches
//     virtually all typos. No external call.
//
//   TIER 2 — External provider (optional, only if env-configured)
//     If GSTIN_LOOKUP_API_URL and GSTIN_LOOKUP_API_KEY are set in your .env,
//     the endpoint also fetches business name / trade name / address /
//     registration status from the configured provider. The official GSTN
//     Public API requires a GSP licence (months of paperwork); paid resellers
//     like KnowYourGST, ClearTax, Masters India, GSTSearchonline, and Surepass
//     work out of the box for a few rupees per lookup.
//
//     Provider call shape (overridable by env):
//       GSTIN_LOOKUP_METHOD       = "GET" | "POST"  (default GET)
//       GSTIN_LOOKUP_API_URL      = full URL with {GSTIN} placeholder
//                                   e.g. "https://api.example.com/gstin/{GSTIN}"
//       GSTIN_LOOKUP_API_KEY      = API key
//       GSTIN_LOOKUP_API_KEY_HDR  = header name (default "X-API-Key")
//
//     The endpoint expects JSON back. It tries common field names — adjust
//     the field-mapping section if your provider uses different keys.
//
// If neither tier succeeds (invalid GSTIN format), we return a helpful error.
// ─────────────────────────────────────────────────────────────────────────────

const GST_STATE_CODES = {
  "01": "Jammu & Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  10: "Bihar",
  11: "Sikkim",
  12: "Arunachal Pradesh",
  13: "Nagaland",
  14: "Manipur",
  15: "Mizoram",
  16: "Tripura",
  17: "Meghalaya",
  18: "Assam",
  19: "West Bengal",
  20: "Jharkhand",
  21: "Odisha",
  22: "Chhattisgarh",
  23: "Madhya Pradesh",
  24: "Gujarat",
  25: "Daman & Diu",
  26: "Dadra & Nagar Haveli",
  27: "Maharashtra",
  28: "Andhra Pradesh (Old)",
  29: "Karnataka",
  30: "Goa",
  31: "Lakshadweep",
  32: "Kerala",
  33: "Tamil Nadu",
  34: "Puducherry",
  35: "Andaman & Nicobar",
  36: "Telangana",
  37: "Andhra Pradesh",
  38: "Ladakh",
  97: "Other Territory",
  99: "Centre Jurisdiction",
};

function gstinChecksumValid(gstin) {
  // Official GSTN algorithm: base-36 over the first 14 chars, weighted alternating
  // 1, 2, 1, 2, ... Final digit is the mod-36 check digit.
  if (!/^[0-9A-Z]{15}$/.test(gstin)) return false;
  const charset = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let v = charset.indexOf(gstin[i]);
    if (v < 0) return false;
    v = v * (i % 2 === 0 ? 1 : 2);
    v = Math.floor(v / 36) + (v % 36);
    sum += v;
  }
  const expected = charset[(36 - (sum % 36)) % 36];
  return expected === gstin[14];
}

function parseGstinOffline(gstin) {
  if (!gstin || typeof gstin !== "string") {
    return { valid: false, reason: "Empty or invalid input" };
  }
  const g = gstin.trim().toUpperCase();
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(g)) {
    return {
      valid: false,
      reason:
        "Invalid GSTIN format. Should be 15 chars: 2 digits (state) + 5 letters + 4 digits + 1 letter + 1 alphanum + 'Z' + 1 alphanum.",
      gstin: g,
    };
  }
  if (!gstinChecksumValid(g)) {
    return {
      valid: false,
      reason:
        "GSTIN checksum mismatch — last digit doesn't match the algorithm. Likely a typo.",
      gstin: g,
    };
  }
  const stateCode = g.slice(0, 2);
  const stateName = GST_STATE_CODES[stateCode] || "Unknown";
  const embeddedPAN = g.slice(2, 12);
  const entityNumber = g[12]; // 1..9, A..Z — counts registrations under same PAN in this state
  return {
    valid: true,
    gstin: g,
    stateCode,
    stateName,
    embeddedPAN,
    entityNumber,
    panMatchesEmbedded: true, // caller can compare against any user-entered PAN
  };
}

router.get("/gstin-lookup/:gstin", async (req, res) => {
  try {
    const offline = parseGstinOffline(req.params.gstin);
    if (!offline.valid) {
      return res.json({ success: false, source: "offline", ...offline });
    }

    const result = {
      success: true,
      source: "offline",
      gstin: offline.gstin,
      valid: true,
      stateCode: offline.stateCode,
      stateName: offline.stateName,
      embeddedPAN: offline.embeddedPAN,
      entityNumber: offline.entityNumber,
      // Filled below if external API succeeds:
      legalName: null,
      tradeName: null,
      address: null,
      registrationStatus: null,
      registrationDate: null,
      taxpayerType: null,
    };

    // Tier 2 — external API (optional)
    const apiUrl = process.env.GSTIN_LOOKUP_API_URL;
    const apiKey = process.env.GSTIN_LOOKUP_API_KEY;
    if (apiUrl && apiKey) {
      try {
        const url = apiUrl.replace(
          "{GSTIN}",
          encodeURIComponent(offline.gstin),
        );
        const method = (process.env.GSTIN_LOOKUP_METHOD || "GET").toUpperCase();
        const keyHeader = process.env.GSTIN_LOOKUP_API_KEY_HDR || "X-API-Key";

        // Use built-in fetch (Node 18+). If your runtime is older, install node-fetch.
        const fetchFn =
          typeof fetch !== "undefined" ? fetch : require("node-fetch");
        const response = await fetchFn(url, {
          method,
          headers: {
            [keyHeader]: apiKey,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body:
            method === "POST"
              ? JSON.stringify({ gstin: offline.gstin })
              : undefined,
        });

        if (response.ok) {
          const data = await response.json();
          // Most providers return either at the top level or nested under .data
          const d = data.data || data.result || data.response || data;

          // Try multiple common field names in priority order
          result.legalName =
            d.lgnm ||
            d.legalName ||
            d.legal_name ||
            d.name ||
            d.company_name ||
            null;
          result.tradeName =
            d.tradeNam || d.tradeName || d.trade_name || d.tradingName || null;
          result.registrationStatus =
            d.sts || d.status || d.registrationStatus || null;
          result.registrationDate =
            d.rgdt || d.registrationDate || d.registration_date || null;
          result.taxpayerType =
            d.dty || d.taxpayerType || d.taxpayer_type || d.entityType || null;

          // Address can come in many shapes — concatenate whatever's available
          const addr =
            d.pradr || d.principalAddress || d.address || d.addr || null;
          if (addr) {
            if (typeof addr === "string") {
              result.address = addr;
            } else {
              const a = addr.adr || addr;
              const parts = [
                a.bnm,
                a.bno,
                a.flno,
                a.st,
                a.loc,
                a.city,
                a.dst,
                a.stcd,
                a.pncd,
              ].filter(Boolean);
              result.address = parts.join(", ") || JSON.stringify(addr);
            }
          }

          if (result.legalName || result.tradeName)
            result.source = "offline+api";
        } else {
          result.apiError = `Lookup provider returned ${response.status}`;
        }
      } catch (e) {
        result.apiError = `Lookup provider call failed: ${e.message}`;
      }
    } else {
      result.apiHint =
        "Set GSTIN_LOOKUP_API_URL + GSTIN_LOOKUP_API_KEY in your .env to enable name/address auto-fill from a provider like KnowYourGST, ClearTax, Masters India, or Surepass.";
    }

    res.json(result);
  } catch (err) {
    console.error("GSTIN lookup:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/accountant/chart-of-accounts/ledgers/:id/transfer-balance
//   Body: { destinationLedgerId, amount?, narration?, voucherDate? }
//
// Move balance (or part of it) from this ledger to another. Common use case:
// accountant created the wrong ledger and posted entries against it; later
// realises a different ledger should have received them. Rather than editing
// every voucher, post a single "transfer" journal voucher that moves the net
// balance to the correct ledger.
//
// What this does:
//   • If amount is omitted, transfers the FULL current balance
//   • Creates a journal voucher with two entries that net out the source's
//     current balance and apply it to the destination
//   • For an asset/expense source (Dr balance):  Dr destination / Cr source
//   • For a liability/revenue source (Cr balance): Dr source / Cr destination
//   • Updates currentBalance on both ledgers
// ─────────────────────────────────────────────────────────────────────────────
router.post("/ledgers/:id/transfer-balance", async (req, res) => {
  try {
    const {
      destinationLedgerId,
      amount: explicitAmount,
      narration,
      voucherDate,
    } = req.body;
    if (!destinationLedgerId)
      return res
        .status(400)
        .json({ success: false, message: "destinationLedgerId required" });

    const source = await Acc_Ledger.findById(req.params.id);
    if (!source || !source.isActive)
      return res
        .status(404)
        .json({ success: false, message: "Source ledger not found" });

    const dest = await Acc_Ledger.findById(destinationLedgerId);
    if (!dest || !dest.isActive)
      return res
        .status(404)
        .json({ success: false, message: "Destination ledger not found" });
    if (String(source.companyId) !== String(dest.companyId))
      return res.status(400).json({
        success: false,
        message: "Source and destination must belong to the same company.",
      });
    if (String(source._id) === String(dest._id))
      return res.status(400).json({
        success: false,
        message: "Source and destination cannot be the same ledger.",
      });

    // Resolve transfer amount.
    // currentBalance is signed: +ve = Dr, -ve = Cr.
    // We always transfer the absolute value.
    const sourceBal = source.currentBalance || 0;
    const fullAbs = Math.abs(sourceBal);
    const amt =
      explicitAmount != null ? Math.abs(parseFloat(explicitAmount)) : fullAbs;
    if (!amt || amt <= 0)
      return res.status(400).json({
        success: false,
        message:
          "Source ledger has no balance to transfer (or invalid amount).",
      });
    if (amt > fullAbs + 0.01)
      return res.status(400).json({
        success: false,
        message: `Cannot transfer ${amt.toFixed(2)} — source balance is only ${fullAbs.toFixed(2)} ${sourceBal >= 0 ? "Dr" : "Cr"}.`,
      });

    // Determine entry types so the source moves toward zero.
    // If source has Dr balance (+ve): we credit source to reduce → and debit destination
    // If source has Cr balance (-ve): we debit source to reduce → and credit destination
    const srcIsDr = sourceBal >= 0;
    const sourceEntryType = srcIsDr ? "Cr" : "Dr"; // opposite to clear
    const destEntryType = srcIsDr ? "Dr" : "Cr"; // mirror

    const entries = [
      {
        ledgerId: source._id,
        ledgerName: source.name,
        groupName: source.groupName,
        type: sourceEntryType,
        amount: amt,
      },
      {
        ledgerId: dest._id,
        ledgerName: dest.name,
        groupName: dest.groupName,
        type: destEntryType,
        amount: amt,
      },
    ];

    const date = voucherDate ? new Date(voucherDate) : new Date();

    const voucher = await createVoucherWithRetry(
      {
        companyId: source.companyId,
        voucherType: "journal",
        voucherTypeName: "Journal",
        voucherDate: date,
        ledgerEntries: entries,
        grandTotal: amt,
        narration:
          narration || `Balance transfer: ${source.name} → ${dest.name}`,
        status: "posted",
        sourceSystem: "manual",
        sourceReference: `Balance Transfer/${source.name}/${dest.name}`,
        postedAt: new Date(),
        createdBy: req.user?.id,
      },
      "journal",
      source.companyId,
    );

    // Apply ledger balance changes
    for (const entry of entries) {
      const signed = entry.type === "Dr" ? entry.amount : -entry.amount;
      await Acc_Ledger.findByIdAndUpdate(entry.ledgerId, {
        $inc: { currentBalance: signed },
      });
    }
    // Refresh balanceType on both ledgers
    for (const id of [source._id, dest._id]) {
      const led = await Acc_Ledger.findById(id);
      if (led) {
        led.currentBalanceType = led.currentBalance >= 0 ? "Dr" : "Cr";
        await led.save();
      }
    }

    res.json({
      success: true,
      message: `Transferred ₹${amt.toFixed(2)} from "${source.name}" to "${dest.name}" via voucher ${voucher.voucherNumber}.`,
      voucher: {
        _id: voucher._id,
        voucherNumber: voucher.voucherNumber,
        voucherType: voucher.voucherType,
        voucherDate: voucher.voucherDate,
      },
    });
  } catch (err) {
    console.error("Transfer balance:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
