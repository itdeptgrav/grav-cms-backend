"use strict";

/**
 * /api/accountant/fy-locks — freeze and unfreeze financial years
 * (13 Oct 2026, owner).
 *
 *   GET  /?companyId=          every FY from the books' beginning to the
 *                              current one: dates, frozen or open, who/when/
 *                              why, its full history, and its voucher count
 *   POST /lock    { companyId, fyStartYear, reason }   owner or approver
 *   POST /unlock  { companyId, fyStartYear, reason }   owner only
 *
 * The rule itself lives in services/accounting/fyLock.js, on the models.
 * A reason is required both ways (at least 10 characters) and every change
 * is kept in the year's history.
 */

const express = require("express");
const mongoose = require("mongoose");
const { accountantAuth, requireCompanyScope } = require("../../Middlewear/AccountantAuthMiddleware");
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const { fyStartYearOf, fyBounds, fyLabel, forget } = require("../../services/accounting/fyLock");

const router = express.Router();
router.use(accountantAuth);
const companyScope = (req, res, next) => requireCompanyScope(req, res, next);

const startMonthOf = (co) =>
  co && co.financialYearStart ? new Date(new Date(co.financialYearStart).getTime() + 330 * 60000).getUTCMonth() + 1 : 4;
const actorName = (req) => req.user?.name || req.user?.email || "";
const can = (req, perm) => !!req.user?.permissions?.[perm];

router.get("/", companyScope, async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId) return res.status(400).json({ success: false, message: "companyId required" });
    const co = await Acc_Company.findById(companyId).select("booksFromDate financialYearStart financialYearLocks").lean();
    const sm = startMonthOf(co);
    const now = new Date();
    const first = fyStartYearOf(co?.booksFromDate || now, sm);
    const current = fyStartYearOf(now, sm);
    const locks = (co && co.financialYearLocks) || [];
    const counts = await Acc_Voucher.aggregate([
      { $match: { companyId: new mongoose.Types.ObjectId(String(companyId)) } },
      { $group: { _id: { $year: { date: "$voucherDate", timezone: "+05:30" } }, m: { $push: { $month: { date: "$voucherDate", timezone: "+05:30" } } } } },
    ]);
    /* Vouchers per FY: a voucher in month >= start month belongs to that
       calendar year's FY, otherwise the one before. */
    const perFy = new Map();
    for (const c of counts)
      for (const mo of c.m) {
        const fy = mo >= sm ? c._id : c._id - 1;
        perFy.set(fy, (perFy.get(fy) || 0) + 1);
      }
    const lowest = Math.min(first, ...[...perFy.keys()], ...locks.map((l) => l.fyStartYear));
    const years = [];
    for (let y = current; y >= lowest; y--) {
      const { from, to } = fyBounds(y, sm);
      const l = locks.find((x) => x.fyStartYear === y);
      years.push({
        fyStartYear: y,
        label: fyLabel(y),
        from,
        to,
        current: y === current,
        locked: !!l?.locked,
        lockedAt: l?.locked ? l.lockedAt : null,
        lockedByName: l?.locked ? l.lockedByName : "",
        lockReason: l?.locked ? l.lockReason : "",
        history: (l?.history || []).slice().reverse(),
        vouchers: perFy.get(y) || 0,
      });
    }
    res.json({
      success: true,
      years,
      canLock: can(req, "canApprove"),
      canUnlock: can(req, "canManageSettings"),
    });
  } catch (e) {
    console.error("[fy-locks]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

async function change(req, res, action) {
  try {
    const { companyId, reason } = req.body || {};
    const fyStartYear = parseInt(req.body?.fyStartYear, 10);
    if (!companyId || !fyStartYear) return res.status(400).json({ success: false, message: "companyId and fyStartYear required" });
    const why = String(reason || "").trim();
    if (why.length < 10)
      return res.status(400).json({ success: false, code: "REASON_REQUIRED", message: `Give a proper reason to ${action === "lock" ? "freeze" : "unfreeze"} ${fyLabel(fyStartYear)} (at least 10 characters).` });
    if (action === "lock" && !can(req, "canApprove"))
      return res.status(403).json({ success: false, message: "Only an owner or an approver can freeze a financial year." });
    if (action === "unlock" && !can(req, "canManageSettings"))
      return res.status(403).json({ success: false, message: "Only an owner can unfreeze a financial year." });

    const co = await Acc_Company.findById(companyId);
    if (!co) return res.status(404).json({ success: false, message: "Company not found" });
    const sm = startMonthOf(co);
    if (action === "lock" && fyStartYear >= fyStartYearOf(new Date(), sm))
      return res.status(400).json({ success: false, message: `${fyLabel(fyStartYear)} is the current (or a future) year — only a past year can be frozen.` });

    const { from, to } = fyBounds(fyStartYear, sm);
    if (!Array.isArray(co.financialYearLocks)) co.financialYearLocks = [];
    let existing = co.financialYearLocks.find((l) => l.fyStartYear === fyStartYear);
    if (action === "lock" && existing?.locked) return res.status(409).json({ success: false, message: `${fyLabel(fyStartYear)} is already frozen.` });
    if (action === "unlock" && !existing?.locked) return res.status(409).json({ success: false, message: `${fyLabel(fyStartYear)} is not frozen.` });

    const event = { action, reason: why, by: mongoose.Types.ObjectId.isValid(String(req.user?.id)) ? req.user.id : null, byName: actorName(req), at: new Date() };
    if (!existing) {
      co.financialYearLocks.push({ fyStartYear, from, to, history: [] });
      existing = co.financialYearLocks[co.financialYearLocks.length - 1];
    }
    const doc = existing;
    doc.from = from;
    doc.to = to;
    doc.locked = action === "lock";
    doc.lockedAt = action === "lock" ? event.at : null;
    doc.lockedByName = action === "lock" ? event.byName : "";
    doc.lockReason = action === "lock" ? why : "";
    doc.history.push(event);
    co.markModified("financialYearLocks");
    await co.save({ validateModifiedOnly: true });
    forget(companyId);
    res.json({
      success: true,
      message: action === "lock"
        ? `${fyLabel(fyStartYear)} is frozen. No voucher can be created, changed or deleted in it until it is unfrozen.`
        : `${fyLabel(fyStartYear)} is open again.`,
    });
  } catch (e) {
    console.error(`[fy-locks/${action}]`, e);
    res.status(500).json({ success: false, message: e.message });
  }
}

router.post("/lock", companyScope, (req, res) => change(req, res, "lock"));
router.post("/unlock", companyScope, (req, res) => change(req, res, "unlock"));

module.exports = router;
