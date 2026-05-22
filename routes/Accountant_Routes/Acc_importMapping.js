// routes/Accountant_Routes/Acc_importMapping.js
//
// IMPORT MAPPING / REVIEW STEP
// ─────────────────────────────────────────────────────────────────────────────
// The accountant uploads the Tally Master file. Instead of blindly creating
// every Sundry Creditor / Debtor / Stock Item, this route lets them REVIEW
// and CONFIRM how each one maps to existing data before anything is written:
//
//   • Each Sundry Creditor  → pick an existing Vendor   (or "create new")
//   • Each Sundry Debtor    → pick an existing Customer  (or "create new")
//   • Each Stock Item       → pick an existing inventory item, OR keep the
//                             Tally name as plain text (no forced create)
//
// The system auto-suggests the best match (GSTIN first, else fuzzy name) so
// the accountant mostly just confirms. "deeksha" ↔ "Diksha Textiles" is
// surfaced as a suggestion, never auto-merged.
//
// Endpoints:
//   POST /import-mapping/analyze   (multipart: file=Master.json, companyId)
//        → { sessionId, creditors:[…suggestion…], debtors:[…], stock:[…] }
//   POST /import-mapping/commit    { sessionId, companyId, decisions }
//        → creates/links ledgers per the accountant's choices
//
// "Create new" makes an Acc_Ledger under Sundry Creditors/Debtors. That is
// the accounting source of truth and the Vendors/Customers pages already
// surface Acc_Ledgers (via the imported-party bridge), so a created party
// shows up there immediately. We deliberately do NOT write into the CMS
// Vendor / CRM Customer collections from here — linking to those is done by
// recording the chosen existing id on the ledger (refVendorId/refCustomerId)
// so reports can join them without duplicating/!corrupting CMS data.

const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");
const {
  Acc_Ledger,
  Acc_Group,
  Acc_StockItem,
  Acc_Company,
} = require("../../models/Accountant_model/Acc_MasterModels");
const mapSvc = require("../../services/tallyImportMapping.service");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 80 * 1024 * 1024 }, // 46 MB DayBook + headroom
});

// In-memory staging of an analyze result until the accountant commits.
// Keyed by sessionId. Cleared on commit or after TTL. (Same-process; the
// import wizard commits within minutes of analyzing.)
const SESSIONS = new Map();
const SESSION_TTL_MS = 60 * 60 * 1000;
function gcSessions() {
  const now = Date.now();
  for (const [k, v] of SESSIONS)
    if (now - v.createdAt > SESSION_TTL_MS) SESSIONS.delete(k);
}

async function resolveCompanyId(passed) {
  if (passed) {
    try {
      return new mongoose.Types.ObjectId(passed);
    } catch {
      /* fall through */
    }
  }
  let c = await Acc_Company.findOne({ isPrimary: true }).select("_id").lean();
  if (!c) {
    const all = await Acc_Company.find({}).select("_id").limit(2).lean();
    if (all.length === 1) c = all[0];
  }
  return c ? c._id : null;
}

// Pull existing Vendors/Customers to match against. The CMS Vendor / CRM
// Customer models live outside this module, so we match against the
// ACCOUNTING ledgers already in the books (Sundry Creditors = our vendor
// list, Sundry Debtors = our customer list). This keeps matching in one
// consistent place and avoids cross-collection schema coupling.
async function existingParties(cId, groupRx) {
  // Primary: company-scoped (correct when company resolves cleanly).
  let groups = await Acc_Group.find({ companyId: cId })
    .select("_id name parent parentName companyId")
    .lean();
  // Fallback: if nothing under this company (company mis-resolve, or a
  // single-tenant setup where ids drift), match groups by name across
  // the whole collection. The Vendors/Customers pages effectively do
  // this too, which is why they showed vendors while this came back
  // empty. Better to over-offer choices than show an empty dropdown.
  if (!groups.length) {
    groups = await Acc_Group.find({})
      .select("_id name parent parentName companyId")
      .lean();
  }
  const ids = new Set(
    groups.filter((g) => groupRx.test(g.name || "")).map((g) => String(g._id)),
  );
  let added = true;
  let guard = 0;
  while (added && guard++ < 20) {
    added = false;
    for (const g of groups) {
      if (ids.has(String(g._id))) continue;
      const pid = g.parent && String(g.parent);
      if (
        (pid && ids.has(pid)) ||
        (g.parentName &&
          groups.some((x) => x.name === g.parentName && ids.has(String(x._id))))
      ) {
        ids.add(String(g._id));
        added = true;
      }
    }
  }
  if (!ids.size) return [];
  const gIds = [...ids].map((s) => new mongoose.Types.ObjectId(s));
  // Match on groupId (authoritative). Try company-scoped first; if that
  // yields nothing, drop the company filter so previously-imported
  // ledgers still surface (same reason as the group fallback above).
  let leds = await Acc_Ledger.find({
    companyId: cId,
    groupId: { $in: gIds },
  })
    .select("name gstin")
    .lean();
  if (!leds.length) {
    leds = await Acc_Ledger.find({ groupId: { $in: gIds } })
      .select("name gstin")
      .lean();
  }
  return leds.map((l) => ({
    id: String(l._id),
    name: l.name,
    gstin: l.gstin || "",
  }));
}

// The REAL vendor/customer master lives in the CMS Vendor collection and
// the CRM Customer collection — that's what the Vendors/Customers pages
// show, and what the accountant expects to link a Tally party to. On a
// fresh import there are no Acc_Ledgers yet, so matching ONLY against
// ledgers gave an empty dropdown. Pull the actual CMS/CRM masters here.
async function existingVendorsCMS() {
  let Vendor;
  try {
    Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
  } catch {
    return [];
  }
  try {
    const rows = await Vendor.find({})
      .select("companyName gstNumber email phone")
      .lean();
    return rows.map((v) => ({
      id: String(v._id),
      name: v.companyName || "",
      gstin: (v.gstNumber || "").toUpperCase().replace(/\s+/g, ""),
      source: "cms_vendor",
    }));
  } catch {
    return [];
  }
}

async function existingCustomersCRM() {
  let Customer;
  try {
    Customer = require("../../models/Customer_Models/Customer");
  } catch {
    return [];
  }
  try {
    const rows = await Customer.find({}).select("name email phone").lean();
    return rows.map((c) => ({
      id: String(c._id),
      name: c.name || "",
      gstin: "",
      source: "crm_customer",
    }));
  } catch {
    return [];
  }
}

// Merge CMS/CRM masters with any existing accounting ledgers, de-duping
// by normalised name so the same party isn't offered twice.
function mergeParties(primary, ledgers) {
  const seen = new Set(primary.map((p) => mapSvc._norm(p.name)));
  const extra = ledgers.filter((l) => {
    const n = mapSvc._norm(l.name);
    if (!n || seen.has(n)) return false;
    seen.add(n);
    return true;
  });
  return [...primary, ...extra];
}
/* ------------------------------------------------------------------ */
router.post(
  "/analyze",
  accountantAuth,
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file)
        return res.status(400).json({ error: "Master JSON file required" });
      const cId = await resolveCompanyId(req.body.companyId);
      if (!cId)
        return res
          .status(400)
          .json({ error: "No company resolved — create a company first" });

      const extracted = mapSvc.extractMappables(req.file.buffer);

      const [
        ledgerVendors,
        ledgerCustomers,
        cmsVendors,
        crmCustomers,
        existStock,
      ] = await Promise.all([
        existingParties(cId, /sundry creditor/i),
        existingParties(cId, /sundry debtor/i),
        existingVendorsCMS(),
        existingCustomersCRM(),
        Acc_StockItem.find({ companyId: cId })
          .select("name")
          .lean()
          .then((rows) =>
            rows.map((s) => ({ id: String(s._id), name: s.name })),
          ),
      ]);
      const existVendors = mergeParties(cmsVendors, ledgerVendors);
      const existCustomers = mergeParties(crmCustomers, ledgerCustomers);

      const creditors = mapSvc.suggestForParties(
        extracted.creditors,
        existVendors,
      );
      const debtors = mapSvc.suggestForParties(
        extracted.debtors,
        existCustomers,
      );
      const stock = mapSvc.suggestForStock(extracted.stockItems, existStock);

      gcSessions();
      const sessionId = new mongoose.Types.ObjectId().toString();
      SESSIONS.set(sessionId, {
        createdAt: Date.now(),
        companyId: String(cId),
        extracted,
      });

      res.json({
        sessionId,
        companyId: String(cId),
        counts: extracted.counts,
        existing: {
          vendors: existVendors.length,
          customers: existCustomers.length,
          stockItems: existStock.length,
        },
        creditors,
        debtors,
        stock,
      });
    } catch (e) {
      console.error("[import-mapping/analyze]", e);
      res.status(500).json({ error: e.message });
    }
  },
);

/* ------------------------------------------------------------------ */
/* POST /import-mapping/commit                                          */
/*  body: {                                                             */
/*    sessionId, companyId,                                             */
/*    decisions: {                                                      */
/*      creditors: [ { tallyName, action:"link"|"create"|"skip",        */
/*                      targetId? } ],                                  */
/*      debtors:   [ … same … ],                                        */
/*      stock:     [ { tallyName, action:"link"|"text"|"skip",          */
/*                      targetId? } ]                                   */
/*    }                                                                 */
/*  }                                                                   */
/* ------------------------------------------------------------------ */
router.post("/commit", accountantAuth, async (req, res) => {
  try {
    const { sessionId, decisions } = req.body || {};
    if (!sessionId || !SESSIONS.has(sessionId))
      return res
        .status(400)
        .json({ error: "Unknown or expired sessionId — re-run analyze" });
    if (!decisions)
      return res.status(400).json({ error: "decisions required" });

    const sess = SESSIONS.get(sessionId);
    const cId = new mongoose.Types.ObjectId(sess.companyId);

    // Resolve (or create) the destination group for create-new ledgers.
    async function groupFor(name) {
      let g = await Acc_Group.findOne({
        companyId: cId,
        name: new RegExp(`^${name}$`, "i"),
      });
      if (!g) {
        g = await Acc_Group.create({
          companyId: cId,
          name,
          parent: null,
          parentName: null,
          isPrimary: true,
          nature: name === "Sundry Debtors" ? "Assets" : "Liabilities",
          level: 1,
          fullPath: name,
          description: "Auto-created during import mapping",
        });
      }
      return g;
    }

    const result = {
      creditors: { linked: 0, created: 0, skipped: 0 },
      debtors: { linked: 0, created: 0, skipped: 0 },
      stock: { linked: 0, asText: 0, skipped: 0 },
      errors: [],
    };

    async function processParty(kind, list, groupName) {
      if (!Array.isArray(list)) return;
      const src =
        kind === "creditors"
          ? sess.extracted.creditors
          : sess.extracted.debtors;
      const byName = new Map(src.map((r) => [r.tallyName, r]));
      let grp = null;
      for (const d of list) {
        try {
          const t = byName.get(d.tallyName);
          if (!t) continue;
          if (d.action === "skip") {
            result[kind].skipped++;
            continue;
          }
          if (d.action === "link") {
            if (!d.targetId) {
              result.errors.push(`${d.tallyName}: link chosen but no targetId`);
              continue;
            }
            // Record the Tally name as an alias on the chosen ledger so
            // future imports and the voucher importer auto-resolve to it.
            await Acc_Ledger.updateOne(
              { _id: d.targetId, companyId: cId },
              {
                $addToSet: { aliases: t.tallyName },
                ...(t.gstin ? { $setOnInsert: {} } : {}),
              },
            );
            // Backfill GSTIN if the existing ledger had none.
            if (t.gstin) {
              await Acc_Ledger.updateOne(
                {
                  _id: d.targetId,
                  companyId: cId,
                  $or: [
                    { gstin: { $exists: false } },
                    { gstin: "" },
                    { gstin: null },
                  ],
                },
                { $set: { gstin: t.gstin } },
              );
            }
            result[kind].linked++;
          } else if (d.action === "create") {
            if (!grp) grp = await groupFor(groupName);
            const exists = await Acc_Ledger.findOne({
              companyId: cId,
              name: t.tallyName,
            }).select("_id");
            if (exists) {
              result[kind].linked++;
              continue;
            }
            await Acc_Ledger.create({
              companyId: cId,
              name: t.tallyName,
              groupId: grp._id,
              groupName: grp.name,
              nature: grp.nature,
              openingBalance: 0,
              openingBalanceType: "Dr",
              gstin: t.gstin || undefined,
              address: {
                line1: t.address || undefined,
                state: t.state || undefined,
                phone: t.phone || undefined,
                email: t.email || undefined,
              },
              sourceSystem: "tally_import_mapping",
            });
            result[kind].created++;
          }
        } catch (e) {
          result.errors.push(`${d.tallyName}: ${e.message}`);
        }
      }
    }

    await processParty("creditors", decisions.creditors, "Sundry Creditors");
    await processParty("debtors", decisions.debtors, "Sundry Debtors");

    // Stock items: link to inventory id, keep as text, or skip. We only
    // record the accountant's choice as an alias on the matched stock item
    // (when linked). "text" items are intentionally NOT created — the
    // voucher importer will carry the Tally name as a plain string.
    if (Array.isArray(decisions.stock)) {
      const byName = new Map(
        sess.extracted.stockItems.map((r) => [r.tallyName, r]),
      );
      for (const d of decisions.stock) {
        try {
          const t = byName.get(d.tallyName);
          if (!t) continue;
          if (d.action === "skip") {
            result.stock.skipped++;
          } else if (d.action === "text") {
            result.stock.asText++;
          } else if (d.action === "link" && d.targetId) {
            await Acc_StockItem.updateOne(
              { _id: d.targetId, companyId: cId },
              { $addToSet: { aliases: t.tallyName } },
            );
            result.stock.linked++;
          }
        } catch (e) {
          result.errors.push(`stock ${d.tallyName}: ${e.message}`);
        }
      }
    }

    SESSIONS.delete(sessionId);
    res.json({ success: true, result });
  } catch (e) {
    console.error("[import-mapping/commit]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* POST /import-mapping/suggest-from-session                            */
/* Called by the import wizard's preview screen. Instead of re-parsing  */
/* the uploaded file, it takes the ledger list already parsed for the  */
/* preview and returns a vendor/customer suggestion per Sundry party.   */
/*  body: { companyId?, sessionId?, ledgers:[{name,groupName,gstin}] }  */
/* ------------------------------------------------------------------ */
router.post("/suggest-from-session", accountantAuth, async (req, res) => {
  try {
    const { ledgers } = req.body || {};
    if (!Array.isArray(ledgers) || !ledgers.length)
      return res.json({ suggestions: [], vendors: [], customers: [] });

    // CMS Vendor / CRM Customer are GLOBAL collections — they are NOT
    // scoped by accounting company, so fetch them unconditionally. Only
    // the accounting-ledger fallback needs a resolved company. Previously
    // a failed company resolve returned an entirely empty payload, which
    // is exactly why the dropdown showed nothing even though the Vendors
    // page had vendors.
    const cId = await resolveCompanyId(req.body.companyId);

    const creditors = ledgers.filter((l) =>
      /sundry creditor/i.test(l.groupName || ""),
    );
    const debtors = ledgers.filter((l) =>
      /sundry debtor/i.test(l.groupName || ""),
    );

    const [cmsVendors, crmCustomers, ledgerVendors, ledgerCustomers] =
      await Promise.all([
        existingVendorsCMS(),
        existingCustomersCRM(),
        existingParties(cId, /sundry creditor/i),
        existingParties(cId, /sundry debtor/i),
      ]);
    const existVendors = mergeParties(cmsVendors, ledgerVendors);
    const existCustomers = mergeParties(crmCustomers, ledgerCustomers);

    const toRows = (arr) =>
      arr.map((l) => ({
        tallyName: l.name,
        gstin: (l.gstin || "").toUpperCase().replace(/\s+/g, ""),
      }));

    const credSug = mapSvc.suggestForParties(toRows(creditors), existVendors);
    const debSug = mapSvc.suggestForParties(toRows(debtors), existCustomers);

    const out = [];
    for (const s of credSug) {
      out.push({
        tallyName: s.tally.tallyName,
        kind: "vendor",
        suggestedId: s.suggestedId,
        suggestedName: s.suggestedName,
        score: s.score,
        reason: s.reason,
        defaultAction: s.defaultAction,
        alternatives: s.alternatives || [],
      });
    }
    for (const s of debSug) {
      out.push({
        tallyName: s.tally.tallyName,
        kind: "customer",
        suggestedId: s.suggestedId,
        suggestedName: s.suggestedName,
        score: s.score,
        reason: s.reason,
        defaultAction: s.defaultAction,
        alternatives: s.alternatives || [],
      });
    }
    res.json({
      suggestions: out,
      // Full pick-lists so the "Link to existing" dropdown is never empty
      // — the accountant can always choose any vendor/customer manually,
      // even when no fuzzy match was found.
      vendors: existVendors
        .map((v) => ({ id: v.id, name: v.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      customers: existCustomers
        .map((c) => ({ id: c.id, name: c.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  } catch (e) {
    console.error("[import-mapping/suggest-from-session]", e);
    res.status(500).json({ error: e.message, suggestions: [] });
  }
});

module.exports = router;
