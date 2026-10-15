"use strict";

/**
 * /api/accountant/fy-locks — lock and unlock periods of the books.
 *
 *   GET  /?companyId=          every FY from the books' beginning to the
 *                              current one with its twelve months, and every
 *                              day / week / range lock: dates, locked or open,
 *                              WHICH SECTIONS, who / when / why, the history,
 *                              the voucher count; plus the section list
 *   GET  /locked?companyId=    every lock in force, flat, with its sections —
 *                              what the screens read to show records read only
 *
 *   POST /lock          { companyId, fyStartYear, sections?, reason }
 *   POST /unlock        { companyId, fyStartYear, reason }
 *   POST /lock-month    { companyId, month: "YYYY-MM", sections?, reason }
 *   POST /unlock-month  { companyId, month, reason }
 *   POST /lock-period   { companyId, from, to: "YYYY-MM-DD", kind, sections?, reason }
 *   POST /unlock-period { companyId, key: "from..to", reason }
 *   POST /sections      { companyId, target, action: "lock"|"unlock", sections, reason }
 *       target = { kind: "year", fyStartYear } | { kind: "month", month }
 *              | { kind: "period", key } (or from / to / rangeKind for a new one)
 *       closes more sections of a period, or opens some of them again; the
 *       period unlocks when its last section opens.
 *
 * WHO (16 Oct 2026, owner: "editors and all must not be able to … that's
 * only admin access"): every lock and unlock is the OWNER's — the accounting
 * owner, or the CEO, who is an owner here (`canManageSettings`). Approvers,
 * editors and viewers can read the locks and nothing else.
 *
 * Only a period that has ENDED can be locked. A reason (10+ characters) is
 * required for every change and every change stays in the period's history.
 * The rule itself is services/accounting/fyLock.js, on the models.
 */

const express = require("express");
const mongoose = require("mongoose");
const { accountantAuth, requireCompanyScope } = require("../../Middlewear/AccountantAuthMiddleware");
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const {
  SECTIONS,
  SECTION_KEYS,
  sectionLabel,
  effectiveSections,
  fyStartYearOf,
  fyBounds,
  fyLabel,
  forget,
  monthBounds,
  monthLabel,
  monthOf,
  dayRangeBounds,
  dayOf,
  periodLabel,
  lockedPeriods,
} = require("../../services/accounting/fyLock");

const router = express.Router();
router.use(accountantAuth);
const companyScope = (req, res, next) => requireCompanyScope(req, res, next);

const startMonthOf = (co) =>
  co && co.financialYearStart ? new Date(new Date(co.financialYearStart).getTime() + 330 * 60000).getUTCMonth() + 1 : 4;
const actorName = (req) => req.user?.name || req.user?.email || "";
/** Locking and unlocking are the owner's alone. */
const isOwner = (req) => !!req.user?.permissions?.canManageSettings;
const OWNER_ONLY = "Only the accounting owner can lock or unlock a period, or change which sections it closes.";

/** The sections asked for: a list of known keys, or null for "every section". Throws on an unknown key. */
function readSections(raw) {
  if (raw === undefined || raw === null || raw === "all") return null;
  if (!Array.isArray(raw)) throw Object.assign(new Error("sections must be a list of section keys."), { status: 400 });
  const keys = [...new Set(raw.map(String))];
  const unknown = keys.filter((k) => !SECTION_KEYS.includes(k));
  if (unknown.length) throw Object.assign(new Error(`Unknown section${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}.`), { status: 400 });
  if (!keys.length) throw Object.assign(new Error("Choose at least one section."), { status: 400 });
  return keys.length === SECTION_KEYS.length ? null : keys;
}
/** What a lock entry shows: its effective sections and whether that is all of them. */
function sectionsView(l) {
  if (!l || !l.locked) return { sections: [], allSections: false };
  const eff = effectiveSections(l);
  return { sections: eff, allSections: eff.length === SECTION_KEYS.length };
}
const sectionWords = (keys) => (!keys || keys.length === SECTION_KEYS.length ? "every section" : keys.map(sectionLabel).join(", "));
/** Stored form: [] = all. */
const storeSections = (keys) => (!keys || keys.length >= SECTION_KEYS.length ? [] : SECTION_KEYS.filter((k) => keys.includes(k)));

/* ── GET / ───────────────────────────────────────────────────────────── */
router.get("/", companyScope, async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId) return res.status(400).json({ success: false, message: "companyId required" });
    const co = await Acc_Company.findById(companyId).select("booksFromDate financialYearStart financialYearLocks monthLocks periodLocks").lean();
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
    const perMonth = new Map();
    for (const c of counts)
      for (const mo of c.m) {
        const fy = mo >= sm ? c._id : c._id - 1;
        perFy.set(fy, (perFy.get(fy) || 0) + 1);
        const key = `${c._id}-${String(mo).padStart(2, "0")}`;
        perMonth.set(key, (perMonth.get(key) || 0) + 1);
      }
    const monthLocks = (co && co.monthLocks) || [];
    const thisMonth = monthOf(now);
    const lowest = Math.min(first, ...[...perFy.keys()], ...locks.map((l) => l.fyStartYear));
    const lockFacts = (l) => ({
      locked: !!l?.locked,
      lockedAt: l?.locked ? l.lockedAt : null,
      lockedByName: l?.locked ? l.lockedByName : "",
      lockReason: l?.locked ? l.lockReason : "",
      ...sectionsView(l),
      history: (l?.history || []).slice().reverse(),
    });
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
        ...lockFacts(l),
        vouchers: perFy.get(y) || 0,
        months: Array.from({ length: 12 }, (_, i) => {
          const calMonth = ((sm - 1 + i) % 12) + 1;
          const calYear = sm - 1 + i >= 12 ? y + 1 : y;
          const month = `${calYear}-${String(calMonth).padStart(2, "0")}`;
          const b = monthBounds(month);
          const ml = monthLocks.find((x) => x.month === month);
          return {
            month,
            label: monthLabel(month),
            from: b.from,
            to: b.to,
            ended: month < thisMonth,
            current: month === thisMonth,
            ...lockFacts(ml),
            vouchers: perMonth.get(month) || 0,
          };
        }),
      });
    }
    /* days, weeks and ranges — locked ones first, then the newest */
    const cid = new mongoose.Types.ObjectId(String(companyId));
    const periods = await Promise.all(
      ((co && co.periodLocks) || [])
        .slice()
        .sort((a, b) => Number(b.locked) - Number(a.locked) || String(b.toDay).localeCompare(String(a.toDay)))
        .map(async (l) => ({
          key: l.key,
          kind: l.kind,
          fromDay: l.fromDay,
          toDay: l.toDay,
          label: periodLabel(l),
          from: l.from,
          to: l.to,
          ...lockFacts(l),
          vouchers: await Acc_Voucher.countDocuments({ companyId: cid, voucherDate: { $gte: l.from, $lte: l.to } }),
        })),
    );
    res.json({
      success: true,
      years,
      periods,
      sections: SECTIONS,
      booksFromDay: co?.booksFromDate ? dayOf(co.booksFromDate) : null,
      today: dayOf(now),
      canLock: isOwner(req),
      canUnlock: isOwner(req),
    });
  } catch (e) {
    console.error("[fy-locks]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/* Every lock in force, flat — the screens read this to show a record in a
   locked period as read only (the server refuses the write either way). */
router.get("/locked", companyScope, async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId) return res.status(400).json({ success: false, message: "companyId required" });
    const locks = await lockedPeriods(companyId);
    res.json({
      success: true,
      locks: locks.map((l) => ({
        kind: l.kind === "period" ? l.rangeKind || "range" : l.kind,
        label: l.label,
        from: l.from,
        to: l.to,
        sections: l.effective,
        allSections: l.all,
        lockedByName: l.lockedByName || "",
        lockedAt: l.lockedAt || null,
        lockReason: l.lockReason || "",
      })),
    });
  } catch (e) {
    console.error("[fy-locks/locked]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ── Finding the entry a change is about ─────────────────────────────── */
/**
 * Resolves `target` on the company to { list, field, find(), create(), label,
 * bounds, ended } — or answers the request itself (400 / 409) and returns null.
 */
const KINDS = ["day", "week", "range", "upto"];
function resolveTarget(co, target, res) {
  const t = target || {};
  if (t.kind === "year") {
    const fyStartYear = parseInt(t.fyStartYear, 10);
    if (!fyStartYear) return void res.status(400).json({ success: false, message: "fyStartYear required" });
    const sm = startMonthOf(co);
    const b = fyBounds(fyStartYear, sm);
    return {
      field: "financialYearLocks",
      label: fyLabel(fyStartYear),
      noun: "year",
      lockWord: "freeze",
      unlockWord: "unfreeze",
      bounds: b,
      ended: fyStartYear < fyStartYearOf(new Date(), sm),
      notEnded: `${fyLabel(fyStartYear)} is the current (or a future) year — only a past year can be frozen.`,
      find: (list) => list.find((l) => l.fyStartYear === fyStartYear),
      fresh: () => ({ fyStartYear, from: b.from, to: b.to, history: [] }),
    };
  }
  if (t.kind === "month") {
    const month = String(t.month || "").trim();
    const b = monthBounds(month);
    if (!b) return void res.status(400).json({ success: false, message: "month (YYYY-MM) required" });
    return {
      field: "monthLocks",
      label: monthLabel(month),
      noun: "month",
      lockWord: "lock",
      unlockWord: "unlock",
      bounds: b,
      month,
      ended: month < monthOf(new Date()),
      notEnded: `${monthLabel(month)} has not ended yet — only a past month can be locked.`,
      find: (list) => list.find((l) => l.month === month),
      fresh: () => ({ month, from: b.from, to: b.to, history: [] }),
    };
  }
  if (t.kind === "period") {
    let fromDay = String(t.from || "").trim();
    let toDay = String(t.to || "").trim();
    if (t.key) [fromDay, toDay] = String(t.key).split("..");
    const b = dayRangeBounds(fromDay, toDay);
    if (!b) return void res.status(400).json({ success: false, message: "Give the period as from and to dates (YYYY-MM-DD), the first on or before the last." });
    const key = `${fromDay}..${toDay}`;
    const existing = (co.periodLocks || []).find((l) => l.key === key);
    const rangeKind = KINDS.includes(t.rangeKind) ? t.rangeKind : existing?.kind || (fromDay === toDay ? "day" : "range");
    const label = periodLabel({ kind: rangeKind, fromDay, toDay });
    return {
      field: "periodLocks",
      label,
      noun: rangeKind === "upto" ? "these days" : fromDay === toDay ? "day" : "period",
      plural: rangeKind === "upto",
      lockWord: "lock",
      unlockWord: "unlock",
      bounds: b,
      key,
      rangeKind,
      ended: toDay < dayOf(new Date()),
      notEnded: `${label} has not ended yet — only days that are over can be locked (yesterday at the latest).`,
      find: (list) => list.find((l) => l.key === key),
      fresh: () => ({ key, kind: rangeKind, fromDay, toDay, from: b.from, to: b.to, history: [] }),
    };
  }
  return void res.status(400).json({ success: false, message: "target.kind must be year, month or period" });
}

/**
 * The one way a lock changes. `action`: "lock" | "unlock"; `sections`: the
 * keys it is about, or null for every section; `whole`: true for the plain
 * lock / unlock routes (a whole-period change), false for /sections.
 */
async function applyChange(req, res, target, action, sectionsRaw, whole) {
  try {
    const { companyId, reason } = req.body || {};
    if (!companyId) return res.status(400).json({ success: false, message: "companyId required" });
    if (!["lock", "unlock"].includes(action)) return res.status(400).json({ success: false, message: "action must be lock or unlock" });
    if (!isOwner(req)) return res.status(403).json({ success: false, code: "OWNER_ONLY", message: OWNER_ONLY });
    let sections;
    try {
      sections = readSections(sectionsRaw);
    } catch (e) {
      return res.status(e.status || 400).json({ success: false, message: e.message });
    }

    const co = await Acc_Company.findById(companyId);
    if (!co) return res.status(404).json({ success: false, message: "Company not found" });
    const t = resolveTarget(co, target, res);
    if (!t) return; // answered
    const are = t.plural ? "are" : "is";
    const why = String(reason || "").trim();
    if (why.length < 10)
      return res.status(400).json({ success: false, code: "REASON_REQUIRED", message: `Give a proper reason to ${action === "lock" ? t.lockWord : t.unlockWord} ${t.label} (at least 10 characters).` });

    if (!Array.isArray(co[t.field])) co[t.field] = [];
    let entry = t.find(co[t.field]);
    const current = entry && entry.locked ? effectiveSections(entry) : [];
    const asked = sections || SECTION_KEYS;

    let next; // the sections closed after the change
    if (action === "lock") {
      if (!t.ended) return res.status(400).json({ success: false, message: t.notEnded });
      if (whole && entry?.locked) return res.status(409).json({ success: false, message: `${t.label} ${are} already ${t.noun === "year" ? "frozen" : "locked"}.` });
      if (!whole && asked.every((k) => current.includes(k)))
        return res.status(409).json({ success: false, message: `${t.label} ${are} already locked for ${sectionWords(asked)}.` });
      /* a month inside a year frozen for every section it asks for gains nothing */
      if (t.field === "monthLocks") {
        const fy = fyStartYearOf(t.bounds.from, startMonthOf(co));
        const yl = (co.financialYearLocks || []).find((l) => l.fyStartYear === fy && l.locked);
        if (yl) {
          const yEff = effectiveSections(yl);
          if (asked.every((k) => yEff.includes(k)))
            return res.status(409).json({ success: false, message: `${t.label} is in ${fyLabel(fy)}, which is frozen${yEff.length === SECTION_KEYS.length ? "" : ` for ${sectionWords(yEff)}`} — the year already closes it. Unfreeze the year to work month by month.` });
        }
      }
      next = SECTION_KEYS.filter((k) => current.includes(k) || asked.includes(k));
    } else {
      if (!entry || !entry.locked) return res.status(409).json({ success: false, message: `${t.label} ${are} not ${t.noun === "year" ? "frozen" : "locked"}.` });
      if (!whole && !asked.some((k) => current.includes(k)))
        return res.status(409).json({ success: false, message: `${t.label} ${are} not locked for ${sectionWords(asked)}.` });
      next = whole ? [] : current.filter((k) => !asked.includes(k));
    }

    const event = {
      action,
      reason: why,
      by: mongoose.Types.ObjectId.isValid(String(req.user?.id)) ? req.user.id : null,
      byName: actorName(req),
      at: new Date(),
      ...(sections ? { sections } : {}),
    };
    if (!entry) {
      co[t.field].push(t.fresh());
      entry = co[t.field][co[t.field].length - 1];
    }
    if (t.field === "periodLocks" && action === "lock") entry.kind = t.rangeKind;
    entry.from = t.bounds.from;
    entry.to = t.bounds.to;
    const nowLocked = next.length > 0;
    const freshLock = nowLocked && !entry.locked;
    entry.locked = nowLocked;
    entry.sections = nowLocked ? storeSections(next) : [];
    if (freshLock) {
      entry.lockedAt = event.at;
      entry.lockedByName = event.byName;
      entry.lockReason = why;
    } else if (!nowLocked) {
      entry.lockedAt = null;
      entry.lockedByName = "";
      entry.lockReason = "";
    }
    entry.history.push(event);
    co.markModified(t.field);
    await co.save({ validateModifiedOnly: true });
    forget(companyId);

    /* unlocking one lock does not open days another lock still covers */
    const stillCovered =
      action === "unlock" &&
      (await lockedPeriods(companyId)).some((l) => t.bounds.from <= new Date(l.to) && t.bounds.to >= new Date(l.from) && (l.all || asked.some((k) => l.effective.includes(k))));
    const closedWords = nowLocked ? sectionWords(next) : "";
    const message =
      action === "lock"
        ? `${t.label} ${are} ${t.noun === "year" ? "frozen" : "locked"} for ${closedWords}. Nothing there can be created, changed or deleted until it is unlocked.`
        : nowLocked
          ? `${sectionWords(asked)} ${asked.length === 1 ? "is" : "are"} open again in ${t.label}; still locked: ${closedWords}.`
          : `${t.label} ${are} open again${stillCovered ? " — but another lock still covers some of it" : ""}.`;
    res.json({ success: true, locked: nowLocked, sections: next, allSections: next.length === SECTION_KEYS.length, ...(t.key ? { key: t.key } : {}), message });
  } catch (e) {
    console.error(`[fy-locks/${action}]`, e);
    res.status(500).json({ success: false, message: e.message });
  }
}

const body = (req) => req.body || {};
router.post("/lock", companyScope, (req, res) => applyChange(req, res, { kind: "year", fyStartYear: body(req).fyStartYear }, "lock", body(req).sections, true));
router.post("/unlock", companyScope, (req, res) => applyChange(req, res, { kind: "year", fyStartYear: body(req).fyStartYear }, "unlock", null, true));
router.post("/lock-month", companyScope, (req, res) => applyChange(req, res, { kind: "month", month: body(req).month }, "lock", body(req).sections, true));
router.post("/unlock-month", companyScope, (req, res) => applyChange(req, res, { kind: "month", month: body(req).month }, "unlock", null, true));
router.post("/lock-period", companyScope, (req, res) =>
  applyChange(req, res, { kind: "period", from: body(req).from, to: body(req).to, rangeKind: body(req).kind }, "lock", body(req).sections, true),
);
router.post("/unlock-period", companyScope, (req, res) =>
  applyChange(req, res, { kind: "period", key: body(req).key, from: body(req).from, to: body(req).to }, "unlock", null, true),
);
/* close more sections of a period, or open some of them again */
router.post("/sections", companyScope, (req, res) => {
  const b = body(req);
  if (!Array.isArray(b.sections) || !b.sections.length) return res.status(400).json({ success: false, message: "Choose at least one section." });
  return applyChange(req, res, b.target, b.action, b.sections, false);
});

module.exports = router;
