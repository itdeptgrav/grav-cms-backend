// routes/Accountant_Routes/Acc_merge.js
//
// GHOST LEDGER / STOCK-ITEM MERGE ENGINE
// ─────────────────────────────────────────────────────────────────────────────
// When data is imported from Tally, the same real-world party or product can
// end up as several ledgers / stock items ("ghosts") — slightly different
// spellings, trailing codes, or a manually-created one plus an imported one.
// This module:
//
//   GET  /merge/ledger-suggestions   → candidate duplicate ledger groups
//   GET  /merge/stock-suggestions    → candidate duplicate stock-item groups
//   POST /merge/ledgers              → merge a set of ghost ledgers into one
//   POST /merge/stock-items          → merge a set of ghost stock items
//   POST /merge/add-alias            → attach an alias to a ledger/stock item
//
// Matching signals (in priority order):
//   • Ledgers   : exact GSTIN match (strongest) → normalised-name match →
//                 alias match → high name similarity
//   • Stock     : normalised-name match → alias match → name similarity
//
// A merge is an explicit, accountant-confirmed action. It re-points EVERY
// voucher line (ledgerEntries.ledgerId / inventoryEntries.stockItemId) and
// party references from the ghosts to the chosen survivor, copies the
// ghosts' names into the survivor's `aliases` (so future imports auto-link),
// folds opening balances, then deletes the ghosts. It is intentionally
// irreversible — the accountant reviews before confirming.

const express = require("express");
const mongoose = require("mongoose");
const {
  Acc_Voucher,
} = require("../../models/Accountant_model/Acc_VoucherModels");
const {
  Acc_Ledger,
  Acc_StockItem,
} = require("../../models/Accountant_model/Acc_MasterModels");
const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");

const router = express.Router();
const auth = accountantAuth;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

// Normalise a name for comparison: lowercase, strip punctuation, collapse
// whitespace, drop common company suffixes and trailing bracket codes.
function normName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ") // (CA-3512) trailing codes
    .replace(/\b(pvt|private|ltd|limited|llp|opc|inc|co|company|enterprises?|traders?|and|&)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Cheap similarity: token overlap (Jaccard) + length-normalised
// Levenshtein-ish ratio. Good enough to *suggest*; the accountant decides.
function lev(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return dp[m][n];
}

function similarity(a, b) {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = new Set(na.split(" "));
  const tb = new Set(nb.split(" "));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const jacc = inter / new Set([...ta, ...tb]).size;
  const dist = lev(na, nb);
  const ratio = 1 - dist / Math.max(na.length, nb.length);
  return Math.max(jacc, ratio);
}

function cleanGstin(g) {
  const s = String(g || "").toUpperCase().replace(/\s+/g, "");
  return /^[0-9A-Z]{15}$/.test(s) ? s : "";
}

/* ------------------------------------------------------------------ */
/* GET /merge/ledger-suggestions?companyId=&minScore=0.82             */
/* ------------------------------------------------------------------ */
router.get("/ledger-suggestions", auth, async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });
    const minScore = Math.min(
      0.99,
      Math.max(0.5, parseFloat(req.query.minScore) || 0.82),
    );
    const cId = new mongoose.Types.ObjectId(companyId);

    const ledgers = await Acc_Ledger.find({ companyId: cId })
      .select("name gstin aliases groupName openingBalance openingBalanceType")
      .lean();

    // Voucher reference counts so the UI can show which is the "real" one
    // (more references usually = keep) and which are ghosts.
    const refAgg = await Acc_Voucher.aggregate([
      { $match: { companyId: cId } },
      { $unwind: "$ledgerEntries" },
      { $group: { _id: "$ledgerEntries.ledgerId", n: { $sum: 1 } } },
    ]);
    const refCount = new Map(
      refAgg.map((r) => [String(r._id), r.n]),
    );

    const used = new Set();
    const groups = [];

    // Pass 1 — exact GSTIN clusters (strongest signal).
    const byGstin = new Map();
    for (const l of ledgers) {
      const g = cleanGstin(l.gstin);
      if (!g) continue;
      if (!byGstin.has(g)) byGstin.set(g, []);
      byGstin.get(g).push(l);
    }
    for (const [g, arr] of byGstin) {
      if (arr.length < 2) continue;
      arr.forEach((l) => used.add(String(l._id)));
      groups.push({
        reason: "Same GSTIN",
        score: 1,
        gstin: g,
        members: arr.map((l) => ({
          id: l._id,
          name: l.name,
          gstin: l.gstin || null,
          groupName: l.groupName || null,
          aliases: l.aliases || [],
          voucherRefs: refCount.get(String(l._id)) || 0,
          openingBalance: l.openingBalance || 0,
        })),
      });
    }

    // Pass 2 — name / alias similarity for the rest.
    const rest = ledgers.filter((l) => !used.has(String(l._id)));
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (used.has(String(a._id))) continue;
      const cluster = [a];
      for (let j = i + 1; j < rest.length; j++) {
        const b = rest[j];
        if (used.has(String(b._id))) continue;
        let s = similarity(a.name, b.name);
        for (const al of a.aliases || [])
          s = Math.max(s, similarity(al, b.name));
        for (const al of b.aliases || [])
          s = Math.max(s, similarity(a.name, al));
        if (s >= minScore) cluster.push(b);
      }
      if (cluster.length >= 2) {
        cluster.forEach((l) => used.add(String(l._id)));
        groups.push({
          reason: "Similar name",
          score: Math.round(
            Math.max(
              ...cluster
                .slice(1)
                .map((c) => similarity(a.name, c.name)),
            ) * 100,
          ) / 100,
          members: cluster.map((l) => ({
            id: l._id,
            name: l.name,
            gstin: l.gstin || null,
            groupName: l.groupName || null,
            aliases: l.aliases || [],
            voucherRefs: refCount.get(String(l._id)) || 0,
            openingBalance: l.openingBalance || 0,
          })),
        });
      }
    }

    // Suggest the survivor = most voucher references, then non-zero
    // opening, then shortest (usually the canonical) name.
    for (const grp of groups) {
      const sorted = [...grp.members].sort(
        (x, y) =>
          y.voucherRefs - x.voucherRefs ||
          Math.abs(y.openingBalance) - Math.abs(x.openingBalance) ||
          x.name.length - y.name.length,
      );
      grp.suggestedSurvivorId = sorted[0].id;
    }

    res.json({
      companyId,
      minScore,
      groupCount: groups.length,
      groups,
    });
  } catch (e) {
    console.error("[merge/ledger-suggestions]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* GET /merge/stock-suggestions?companyId=&minScore=0.85              */
/* ------------------------------------------------------------------ */
router.get("/stock-suggestions", auth, async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });
    const minScore = Math.min(
      0.99,
      Math.max(0.5, parseFloat(req.query.minScore) || 0.85),
    );
    const cId = new mongoose.Types.ObjectId(companyId);

    const items = await Acc_StockItem.find({ companyId: cId })
      .select("name aliases unit hsnCode")
      .lean();

    const refAgg = await Acc_Voucher.aggregate([
      { $match: { companyId: cId } },
      { $unwind: "$inventoryEntries" },
      {
        $group: {
          _id: "$inventoryEntries.stockItemId",
          n: { $sum: 1 },
        },
      },
    ]);
    const refCount = new Map(refAgg.map((r) => [String(r._id), r.n]));

    const used = new Set();
    const groups = [];
    for (let i = 0; i < items.length; i++) {
      const a = items[i];
      if (used.has(String(a._id))) continue;
      const cluster = [a];
      for (let j = i + 1; j < items.length; j++) {
        const b = items[j];
        if (used.has(String(b._id))) continue;
        let s = similarity(a.name, b.name);
        for (const al of a.aliases || [])
          s = Math.max(s, similarity(al, b.name));
        for (const al of b.aliases || [])
          s = Math.max(s, similarity(a.name, al));
        if (s >= minScore) cluster.push(b);
      }
      if (cluster.length >= 2) {
        cluster.forEach((it) => used.add(String(it._id)));
        const members = cluster.map((it) => ({
          id: it._id,
          name: it.name,
          aliases: it.aliases || [],
          unit: it.unit || null,
          hsnCode: it.hsnCode || null,
          voucherRefs: refCount.get(String(it._id)) || 0,
        }));
        const survivor = [...members].sort(
          (x, y) =>
            y.voucherRefs - x.voucherRefs ||
            x.name.length - y.name.length,
        )[0];
        groups.push({
          reason: "Similar item name",
          score:
            Math.round(
              Math.max(
                ...cluster
                  .slice(1)
                  .map((c) => similarity(a.name, c.name)),
              ) * 100,
            ) / 100,
          members,
          suggestedSurvivorId: survivor.id,
        });
      }
    }

    res.json({
      companyId,
      minScore,
      groupCount: groups.length,
      groups,
    });
  } catch (e) {
    console.error("[merge/stock-suggestions]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* POST /merge/ledgers                                                 */
/*   { companyId, survivorId, ghostIds:[...], confirm:"MERGE" }        */
/* ------------------------------------------------------------------ */
router.post("/ledgers", auth, async (req, res) => {
  try {
    const { companyId, survivorId, ghostIds, confirm } = req.body || {};
    if (confirm !== "MERGE")
      return res.status(400).json({
        error:
          'This permanently merges ledgers and re-points all vouchers. Send confirm:"MERGE".',
      });
    if (!companyId || !survivorId || !Array.isArray(ghostIds) || !ghostIds.length)
      return res
        .status(400)
        .json({ error: "companyId, survivorId, ghostIds[] required" });
    if (ghostIds.map(String).includes(String(survivorId)))
      return res
        .status(400)
        .json({ error: "survivorId cannot also be in ghostIds" });

    const cId = new mongoose.Types.ObjectId(companyId);
    const survivor = await Acc_Ledger.findOne({
      _id: survivorId,
      companyId: cId,
    });
    if (!survivor)
      return res.status(404).json({ error: "Survivor ledger not found" });
    const ghosts = await Acc_Ledger.find({
      _id: { $in: ghostIds },
      companyId: cId,
    });
    if (!ghosts.length)
      return res.status(404).json({ error: "No ghost ledgers found" });

    const ghostObjIds = ghosts.map((g) => g._id);
    const sId = survivor._id;

    // 1. Re-point every voucher ledger line.
    const r1 = await Acc_Voucher.updateMany(
      { companyId: cId, "ledgerEntries.ledgerId": { $in: ghostObjIds } },
      { $set: { "ledgerEntries.$[e].ledgerId": sId } },
      { arrayFilters: [{ "e.ledgerId": { $in: ghostObjIds } }] },
    );
    // 2. Re-point party references.
    const r2 = await Acc_Voucher.updateMany(
      { companyId: cId, partyLedgerId: { $in: ghostObjIds } },
      { $set: { partyLedgerId: sId, partyLedgerName: survivor.name } },
    );
    // 3. Denormalised ledgerName on the moved lines → survivor name.
    await Acc_Voucher.updateMany(
      { companyId: cId, "ledgerEntries.ledgerId": sId },
      { $set: { "ledgerEntries.$[e].ledgerName": survivor.name } },
      { arrayFilters: [{ "e.ledgerId": sId }] },
    );

    // 4. Fold names into survivor aliases (future imports auto-link),
    //    and fold opening balances (signed) so nothing is lost.
    const aliasSet = new Set(
      [...(survivor.aliases || [])].map((a) => a.trim()),
    );
    let signedOpening =
      (survivor.openingBalanceType === "Cr" ? -1 : 1) *
      Math.abs(survivor.openingBalance || 0);
    for (const g of ghosts) {
      if (g.name && g.name !== survivor.name) aliasSet.add(g.name.trim());
      for (const al of g.aliases || []) aliasSet.add(al.trim());
      if (!survivor.gstin && g.gstin) survivor.gstin = g.gstin;
      signedOpening +=
        (g.openingBalanceType === "Cr" ? -1 : 1) *
        Math.abs(g.openingBalance || 0);
    }
    survivor.aliases = [...aliasSet].filter(Boolean);
    survivor.openingBalance = Math.abs(signedOpening);
    survivor.openingBalanceType = signedOpening < 0 ? "Cr" : "Dr";
    await survivor.save();

    // 5. Delete the ghosts.
    const del = await Acc_Ledger.deleteMany({ _id: { $in: ghostObjIds } });

    res.json({
      success: true,
      message: `Merged ${del.deletedCount} ledger(s) into "${survivor.name}". Re-pointed ${r1.modifiedCount} voucher(s) and ${r2.modifiedCount} party reference(s).`,
      survivor: { id: survivor._id, name: survivor.name },
      deleted: del.deletedCount,
      vouchersRepointed: r1.modifiedCount,
      partyRepointed: r2.modifiedCount,
    });
  } catch (e) {
    console.error("[merge/ledgers]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* POST /merge/stock-items                                             */
/*   { companyId, survivorId, ghostIds:[...], confirm:"MERGE" }        */
/* ------------------------------------------------------------------ */
router.post("/stock-items", auth, async (req, res) => {
  try {
    const { companyId, survivorId, ghostIds, confirm } = req.body || {};
    if (confirm !== "MERGE")
      return res.status(400).json({
        error:
          'This permanently merges stock items and re-points all vouchers. Send confirm:"MERGE".',
      });
    if (!companyId || !survivorId || !Array.isArray(ghostIds) || !ghostIds.length)
      return res
        .status(400)
        .json({ error: "companyId, survivorId, ghostIds[] required" });
    if (ghostIds.map(String).includes(String(survivorId)))
      return res
        .status(400)
        .json({ error: "survivorId cannot also be in ghostIds" });

    const cId = new mongoose.Types.ObjectId(companyId);
    const survivor = await Acc_StockItem.findOne({
      _id: survivorId,
      companyId: cId,
    });
    if (!survivor)
      return res.status(404).json({ error: "Survivor stock item not found" });
    const ghosts = await Acc_StockItem.find({
      _id: { $in: ghostIds },
      companyId: cId,
    });
    if (!ghosts.length)
      return res.status(404).json({ error: "No ghost stock items found" });

    const ghostObjIds = ghosts.map((g) => g._id);
    const sId = survivor._id;

    const r1 = await Acc_Voucher.updateMany(
      {
        companyId: cId,
        "inventoryEntries.stockItemId": { $in: ghostObjIds },
      },
      { $set: { "inventoryEntries.$[e].stockItemId": sId } },
      { arrayFilters: [{ "e.stockItemId": { $in: ghostObjIds } }] },
    );
    await Acc_Voucher.updateMany(
      { companyId: cId, "inventoryEntries.stockItemId": sId },
      { $set: { "inventoryEntries.$[e].stockItemName": survivor.name } },
      { arrayFilters: [{ "e.stockItemId": sId }] },
    );

    const aliasSet = new Set(
      [...(survivor.aliases || [])].map((a) => a.trim()),
    );
    for (const g of ghosts) {
      if (g.name && g.name !== survivor.name) aliasSet.add(g.name.trim());
      for (const al of g.aliases || []) aliasSet.add(al.trim());
    }
    survivor.aliases = [...aliasSet].filter(Boolean);
    await survivor.save();

    const del = await Acc_StockItem.deleteMany({
      _id: { $in: ghostObjIds },
    });

    res.json({
      success: true,
      message: `Merged ${del.deletedCount} stock item(s) into "${survivor.name}". Re-pointed ${r1.modifiedCount} voucher(s).`,
      survivor: { id: survivor._id, name: survivor.name },
      deleted: del.deletedCount,
      vouchersRepointed: r1.modifiedCount,
    });
  } catch (e) {
    console.error("[merge/stock-items]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* POST /merge/add-alias                                               */
/*   { companyId, kind:"ledger"|"stock", id, alias }                   */
/* ------------------------------------------------------------------ */
router.post("/add-alias", auth, async (req, res) => {
  try {
    const { companyId, kind, id, alias } = req.body || {};
    if (!companyId || !kind || !id || !alias)
      return res
        .status(400)
        .json({ error: "companyId, kind, id, alias required" });
    const cId = new mongoose.Types.ObjectId(companyId);
    const Model = kind === "stock" ? Acc_StockItem : Acc_Ledger;
    const doc = await Model.findOne({ _id: id, companyId: cId });
    if (!doc) return res.status(404).json({ error: "Record not found" });
    const a = String(alias).trim();
    if (a && !(doc.aliases || []).includes(a)) {
      doc.aliases = [...(doc.aliases || []), a];
      await doc.save();
    }
    res.json({ success: true, aliases: doc.aliases });
  } catch (e) {
    console.error("[merge/add-alias]", e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
