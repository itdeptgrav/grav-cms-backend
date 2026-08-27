// routes/Accountant_Routes/Acc_parties.js
//
// PARTIES — Vendors & Customers sourced from the IMPORTED Tally ledgers.
// ─────────────────────────────────────────────────────────────────────────────
// Problem this solves:
//   The existing Vendors page reads the CMS `Vendor` collection and the
//   Customers page reads the CRM `Customer` collection. Neither looks at
//   the ledgers created by the Tally import. So every party that came in
//   from Tally (under the "Sundry Creditors" / "Sundry Debtors" groups)
//   was invisible in Vendors/Customers, even though its ledger and all its
//   vouchers/invoices were imported correctly.
//
// This route surfaces those imported ledgers directly:
//   • Sundry Creditors  → Vendors  (we owe them)
//   • Sundry Debtors    → Customers (they owe us)
// Each party shows its real ledger balance and every transaction tied to
// that single ledger — so all of "Mayfair Kalimpong"'s invoices/receipts
// appear together under the one party, exactly as in Tally.
//
// No data duplication: we read the Acc_Ledger / Acc_Voucher records the
// import already created. Nothing is copied into the CMS Vendor or CRM
// Customer collections (which have different schemas and would re-create
// the ghost-duplicate problem).
//
// Endpoints:
//   GET /parties?companyId=&kind=vendor|customer&search=&page=&limit=
//        → list with per-party balance + txn count
//   GET /parties/:ledgerId?companyId=
//        → one party: ledger info + computed balance summary
//   GET /parties/:ledgerId/transactions?companyId=&from=&to=
//        → every posted voucher line touching this party's ledger
//          (invoices, receipts, payments, journals — all of them)

const express = require("express");
const mongoose = require("mongoose");
const {
  Acc_Voucher,
} = require("../../models/Accountant_model/Acc_VoucherModels");
const {
  Acc_Ledger,
  Acc_Group,
} = require("../../models/Accountant_model/Acc_MasterModels");
const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");
const openItems = require("../../services/openItems.service");
const creditTerms = require("../../services/creditTerms.service");

const router = express.Router();
const auth = accountantAuth;

// Same cap as GET / (this file's own page-size limit) — see the bulk
// credit-terms endpoint below.
const MAX_BULK_LEDGERS = 500;

// Group name a party kind lives under.
const GROUP_FOR = {
  vendor: /sundry creditor/i,
  customer: /sundry debtor/i,
};

// Resolve every group id whose name (or ancestry) matches the kind's
// Sundry group, so sub-grouped ledgers are included too.
async function groupIdsForKind(cId, kind) {
  const rx = GROUP_FOR[kind];
  const all = await Acc_Group.find({ companyId: cId })
    .select("_id name parent parentName")
    .lean();
  const direct = all.filter((g) => rx.test(g.name || ""));
  const ids = new Set(direct.map((g) => String(g._id)));
  // include descendants (one or more levels)
  let added = true;
  let guard = 0;
  while (added && guard < 20) {
    added = false;
    guard++;
    for (const g of all) {
      if (ids.has(String(g._id))) continue;
      const parentRef =
        (g.parent && String(g.parent)) ||
        (g.parentName &&
          all.find((x) => x.name === g.parentName)?._id &&
          String(all.find((x) => x.name === g.parentName)._id));
      if (parentRef && ids.has(parentRef)) {
        ids.add(String(g._id));
        added = true;
      }
    }
  }
  return [...ids].map((s) => new mongoose.Types.ObjectId(s));
}

// Net signed movement (Dr +, Cr −) per ledger from POSTED vouchers.
async function balanceByLedger(cId, ledgerIds) {
  if (!ledgerIds.length) return new Map();
  const agg = await Acc_Voucher.aggregate([
    { $match: { companyId: cId, status: "posted" } },
    { $unwind: "$ledgerEntries" },
    { $match: { "ledgerEntries.ledgerId": { $in: ledgerIds } } },
    {
      $group: {
        _id: "$ledgerEntries.ledgerId",
        dr: {
          $sum: {
            $cond: [
              { $eq: ["$ledgerEntries.type", "Dr"] },
              "$ledgerEntries.amount",
              0,
            ],
          },
        },
        cr: {
          $sum: {
            $cond: [
              { $eq: ["$ledgerEntries.type", "Cr"] },
              "$ledgerEntries.amount",
              0,
            ],
          },
        },
        txns: { $sum: 1 },
      },
    },
  ]);
  const m = new Map();
  for (const r of agg)
    m.set(String(r._id), {
      dr: r.dr || 0,
      cr: r.cr || 0,
      net: (r.dr || 0) - (r.cr || 0),
      txns: r.txns || 0,
    });
  return m;
}

/* ------------------------------------------------------------------ */
/* GET /parties                                                        */
/* ------------------------------------------------------------------ */
router.get("/", auth, async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });
    const kind = req.query.kind === "customer" ? "customer" : "vendor";
    const search = (req.query.search || "").trim();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(500, parseInt(req.query.limit) || 100);
    const cId = new mongoose.Types.ObjectId(companyId);

    const gIds = await groupIdsForKind(cId, kind);
    if (!gIds.length)
      return res.json({
        kind,
        parties: [],
        total: 0,
        page,
        pages: 0,
        note: `No "${kind === "vendor" ? "Sundry Creditors" : "Sundry Debtors"}" group found — import Tally masters first.`,
      });

    const filter = { companyId: cId, groupId: { $in: gIds } };
    if (search)
      filter.name = new RegExp(
        search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i",
      );

    const total = await Acc_Ledger.countDocuments(filter);
    const ledgers = await Acc_Ledger.find(filter)
      .select(
        // `creditPeriodDays` is READ-ONLY here (C0-A, terms visibility). No write
        // path is added by this slice; editing arrives in a later one.
        "name gstin aliases groupName openingBalance openingBalanceType creditPeriodDays",
      )
      .sort({ name: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const pageLedgerIds = ledgers.map((l) => l._id);
    // Both reads are scoped to THIS PAGE of ledgers, not the whole company.
    const [balMap, openMap] = await Promise.all([
      balanceByLedger(cId, pageLedgerIds),
      openItems.openItemsByLedger(cId, pageLedgerIds),
    ]);

    const parties = ledgers.map((l) => {
      const b = balMap.get(String(l._id)) || {
        dr: 0,
        cr: 0,
        net: 0,
        txns: 0,
      };
      const openSigned =
        (l.openingBalanceType === "Cr" ? -1 : 1) *
        Math.abs(l.openingBalance || 0);
      const closingSigned = openSigned + b.net;
      const open = openMap.get(String(l._id)) || {
        openItemCount: 0,
        receivable: 0,
        payable: 0,
        oldestOpenDate: null,
        unnamedAllocations: 0,
      };

      // 0 is the schema default on every ledger and means UNSET, not
      // "due on receipt". Saying so explicitly here keeps the UI from having
      // to guess, and keeps a later slice from dating anything off a zero.
      const days = l.creditPeriodDays;
      const termsSet = typeof days === "number" && days > 0;

      return {
        ledgerId: l._id,
        name: l.name,
        creditPeriodDays: termsSet ? days : null,
        creditTermsSet: termsSet,
        openItemCount: open.openItemCount,
        openReceivable: open.receivable,
        openPayable: open.payable,
        oldestOpenDate: open.oldestOpenDate,
        // Bill-wise coverage caveat: allocations with no bill name cannot be
        // grouped into an item, so a party with these will under-report.
        unnamedAllocations: open.unnamedAllocations,
        gstin: l.gstin || null,
        aliases: l.aliases || [],
        groupName: l.groupName || null,
        openingBalance: Math.abs(openSigned),
        openingType: openSigned < 0 ? "Cr" : "Dr",
        debitTotal: b.dr,
        creditTotal: b.cr,
        transactionCount: b.txns,
        balance: Math.abs(closingSigned),
        balanceType: closingSigned < 0 ? "Cr" : "Dr",
      };
    });

    res.json({
      kind,
      parties,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (e) {
    console.error("[parties/list]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* GET /parties/:ledgerId                                              */
/* ------------------------------------------------------------------ */
router.get("/:ledgerId", auth, async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });
    const cId = new mongoose.Types.ObjectId(companyId);
    const led = await Acc_Ledger.findOne({
      _id: req.params.ledgerId,
      companyId: cId,
    }).lean();
    if (!led) return res.status(404).json({ error: "Party not found" });

    const balMap = await balanceByLedger(cId, [led._id]);
    const b = balMap.get(String(led._id)) || {
      dr: 0,
      cr: 0,
      net: 0,
      txns: 0,
    };
    const openSigned =
      (led.openingBalanceType === "Cr" ? -1 : 1) *
      Math.abs(led.openingBalance || 0);
    const closingSigned = openSigned + b.net;
    const kind = /creditor/i.test(led.groupName || "") ? "vendor" : "customer";

    res.json({
      ledgerId: led._id,
      name: led.name,
      gstin: led.gstin || null,
      aliases: led.aliases || [],
      groupName: led.groupName || null,
      kind,
      openingBalance: Math.abs(openSigned),
      openingType: openSigned < 0 ? "Cr" : "Dr",
      debitTotal: b.dr,
      creditTotal: b.cr,
      transactionCount: b.txns,
      balance: Math.abs(closingSigned),
      balanceType: closingSigned < 0 ? "Cr" : "Dr",
    });
  } catch (e) {
    console.error("[parties/detail]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* GET /parties/:ledgerId/transactions                                 */
/* Every posted voucher line touching this party's ledger.             */
/* ------------------------------------------------------------------ */
router.get("/:ledgerId/transactions", auth, async (req, res) => {
  try {
    const { companyId, from, to } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });
    const cId = new mongoose.Types.ObjectId(companyId);
    const lId = new mongoose.Types.ObjectId(req.params.ledgerId);

    const match = {
      companyId: cId,
      status: "posted",
      "ledgerEntries.ledgerId": lId,
    };
    if (from || to) {
      match.voucherDate = {};
      if (from) match.voucherDate.$gte = new Date(from);
      if (to) {
        const e = new Date(to);
        e.setHours(23, 59, 59, 999);
        match.voucherDate.$lte = e;
      }
    }

    const vouchers = await Acc_Voucher.find(match)
      .select(
        "voucherType voucherTypeName voucherNumber voucherDate partyLedgerName narration ledgerEntries grandTotal status",
      )
      .sort({ voucherDate: 1, createdAt: 1 })
      .lean();

    // Build a running statement for THIS ledger.
    const led = await Acc_Ledger.findById(lId)
      .select("name openingBalance openingBalanceType")
      .lean();
    let running =
      (led && led.openingBalanceType === "Cr" ? -1 : 1) *
      Math.abs((led && led.openingBalance) || 0);

    const rows = [];
    for (const v of vouchers) {
      // Sum this ledger's lines within the voucher (a voucher can hit the
      // same ledger more than once).
      let dr = 0;
      let cr = 0;
      for (const e of v.ledgerEntries || []) {
        if (String(e.ledgerId) !== String(lId)) continue;
        if (e.type === "Dr") dr += e.amount || 0;
        else cr += e.amount || 0;
      }
      running += dr - cr;
      rows.push({
        voucherId: v._id,
        date: v.voucherDate,
        voucherType: v.voucherType,
        voucherTypeName: v.voucherTypeName || v.voucherType,
        voucherNumber: v.voucherNumber || null,
        narration: v.narration || null,
        counterParty: v.partyLedgerName || null,
        debit: dr,
        credit: cr,
        runningBalance: Math.abs(running),
        runningType: running < 0 ? "Cr" : "Dr",
        grandTotal: v.grandTotal || null,
      });
    }

    res.json({
      ledgerId: lId,
      name: led ? led.name : null,
      openingBalance: Math.abs(
        (led && led.openingBalanceType === "Cr" ? -1 : 1) *
          Math.abs((led && led.openingBalance) || 0),
      ),
      count: rows.length,
      transactions: rows,
      closingBalance: Math.abs(running),
      closingType: running < 0 ? "Cr" : "Dr",
    });
  } catch (e) {
    console.error("[parties/transactions]", e);
    res.status(500).json({ error: e.message });
  }
});


/* ------------------------------------------------------------------ */
/* PATCH /parties/:ledgerId/credit-terms          (C0-B1)              */
/* ------------------------------------------------------------------ */
//
// The ONLY write in this file, and deliberately the narrowest one that does
// the job: one party, one field.
//
// Three properties this endpoint is built to guarantee:
//
//   1. NO BODY SPREADING. The update is assembled field-by-field by
//      `creditTerms.buildUpdate` from a fixed whitelist. The general ledger
//      `PUT /chart-of-accounts/ledgers/:id` does `{ ...req.body }`, which
//      would let a credit-terms form rewrite `nature`, `groupId`,
//      `openingBalance` or `companyId` — `nature` in particular drives the
//      revenue/expense split the budget module and the forecast both read.
//      Credit-terms editing must never travel through that route.
//
//   2. NOTHING BUT THE LEDGER IS TOUCHED. No voucher is read for write, no
//      due date is derived or stored, no bill terms are backfilled. Setting a
//      term is a statement of policy, not an act of dating anything — the
//      dating happens in a later slice, deliberately, so it can be reviewed.
//
//   3. PROVENANCE IS THE SERVER'S. Who and when are taken from the
//      authenticated user and the clock, never from the request.
//
//   4. COMPANY-SCOPED. Every read route in this file requires `companyId`
//      and filters by it (see `GET /` and `GET /:ledgerId` above). This write
//      route follows the same rule: a bare `_id` lookup would let a caller
//      who can see one company's session write into a ledger that belongs to
//      a DIFFERENT company, just by guessing/enumerating a ledger id. Both
//      the read that resolves the party and the write that changes it are
//      filtered by `{ _id, companyId }` together, never `_id` alone.
router.patch("/:ledgerId/credit-terms", auth, async (req, res) => {
  try {
    if (!creditTerms.canEditTerms(req.user)) {
      return res.status(403).json({
        error: "Your accounting role is read-only, so this change was not saved.",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(req.params.ledgerId)) {
      return res.status(400).json({ error: "Invalid ledger id." });
    }

    // companyId is REQUIRED, matching the GET routes in this file. Accepted
    // from the body (where the frontend sends it, alongside creditPeriodDays)
    // or the query string (the `?companyId=` convention the GET routes use),
    // body taking precedence if — implausibly — both are present and differ.
    const companyIdRaw = req.body?.companyId || req.query?.companyId;
    if (!companyIdRaw) {
      return res.status(400).json({ error: "companyId required." });
    }
    if (!mongoose.Types.ObjectId.isValid(companyIdRaw)) {
      return res.status(400).json({ error: "Invalid companyId." });
    }
    const companyId = new mongoose.Types.ObjectId(companyIdRaw);

    // `companyId` scopes WHERE this write lands; it is not itself a field
    // being set. Stripped out before handing the body to `buildUpdate`, whose
    // whitelist would otherwise (correctly) refuse it as an unsupported field.
    const { companyId: _scopeOnly, ...termsBody } = req.body || {};

    let update;
    try {
      update = creditTerms.buildUpdate(termsBody, req.user, new Date());
    } catch (e) {
      if (e instanceof creditTerms.CreditTermsError) {
        return res.status(400).json({ error: e.message, code: e.code });
      }
      throw e;
    }

    // Only a party ledger — a Sundry Debtor or Creditor — AND only within the
    // caller's company. `findOne({ _id, companyId })` is the whole point of
    // this fix: a ledger id from another company resolves to nothing, exactly
    // as the GET routes already behave, rather than 404 happening to be the
    // accidental result of some other check.
    const ledger = await Acc_Ledger.findOne({ _id: req.params.ledgerId, companyId })
      .select("_id name companyId groupId groupName creditPeriodDays")
      .lean();
    if (!ledger) return res.status(404).json({ error: "Party not found." });

    const partyGroupIds = [
      ...(await groupIdsForKind(companyId, "customer")),
      ...(await groupIdsForKind(companyId, "vendor")),
    ].map(String);
    if (!partyGroupIds.includes(String(ledger.groupId))) {
      return res.status(400).json({
        error:
          "Credit terms apply to customer and vendor ledgers only (Sundry Debtors / Sundry Creditors).",
      });
    }

    // $set with an explicitly constructed object — never the request body —
    // AND scoped by the same `{ _id, companyId }` pair as the lookup above.
    // Re-stating companyId here (rather than trusting the id alone, now that
    // we've already confirmed it via `findOne`) means a race — the ledger
    // being reassigned to a different company between the read and the write
    // — still can't result in a cross-company write; the update simply
    // matches nothing and falls through to the 404 below.
    const saved = await Acc_Ledger.findOneAndUpdate(
      { _id: ledger._id, companyId },
      { $set: update },
      {
        new: true,
        runValidators: true,
        // Belt and braces: even if a future edit widened `update`, only these
        // keys can reach the document.
        fields:
          "_id name creditPeriodDays creditTermsSource creditTermsUpdatedAt creditTermsUpdatedByName",
      },
    ).lean();

    if (!saved) return res.status(404).json({ error: "Party not found." });

    const days = saved.creditPeriodDays;
    const termsSet = creditTerms.isTermSet(days);
    res.json({
      ok: true,
      party: {
        ledgerId: saved._id,
        name: saved.name,
        creditPeriodDays: termsSet ? days : null,
        creditTermsSet: termsSet,
        creditTermsSource: saved.creditTermsSource || null,
        creditTermsUpdatedAt: saved.creditTermsUpdatedAt || null,
        creditTermsUpdatedByName: saved.creditTermsUpdatedByName || null,
      },
    });
  } catch (e) {
    console.error("[parties/credit-terms]", e);
    res.status(500).json({ error: e.message });
  }
});


/* ------------------------------------------------------------------ */
/* PATCH /parties/bulk-credit-terms                (C0-B2)             */
/* ------------------------------------------------------------------ */
//
// Bulk version of the single-party endpoint above. Same value validation
// (`creditTerms.buildUpdate`), same permission gate, same whitelist — this
// endpoint does not re-implement any of that, it applies it to many ledgers
// at once instead of one.
//
// ── THE VALUE IS VALIDATED ONCE, FOR THE WHOLE BATCH ────────────────────────
// `creditPeriodDays` here is a single shared parameter, not one value per
// ledger — the caller is saying "set these N parties to 30 days", not
// submitting N independent edits. So it is validated FIRST, before any
// database read, and if it's invalid the ENTIRE request is refused with
// nothing touched. That is different from — and takes priority over — the
// per-ledger skipping below, which is about which PARTIES are eligible, not
// whether the requested VALUE makes sense.
//
// ── THE FAIL-CLOSED SCOPE ────────────────────────────────────────────────
// A ledger belongs to this batch's actual update only if it is found by
//     Acc_Ledger.find({ _id: {$in: ids}, companyId, groupId: {$in: partyGroups} })
// This is not a check-then-reject step bolted on afterward — it is the ONLY
// query that ever touches a ledger for writing. A ledger from another
// company, or one that isn't a Sundry Debtor/Creditor, is structurally
// unreachable through this endpoint: it is never read for write, so it
// literally cannot be part of the `updateMany` scope, whatever the request
// claims about it. Every id from the request that isn't in that eligible set
// comes back in `skipped`, with a reason, so nothing disappears silently.
router.patch("/bulk-credit-terms", auth, async (req, res) => {
  try {
    if (!creditTerms.canEditTerms(req.user)) {
      return res.status(403).json({
        error: "Your accounting role is read-only, so this change was not saved.",
      });
    }

    const companyIdRaw = req.body?.companyId;
    if (!companyIdRaw) {
      return res.status(400).json({ error: "companyId required." });
    }
    if (!mongoose.Types.ObjectId.isValid(companyIdRaw)) {
      return res.status(400).json({ error: "Invalid companyId." });
    }
    const companyId = new mongoose.Types.ObjectId(companyIdRaw);

    const rawIds = req.body?.ledgerIds;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      return res.status(400).json({ error: "ledgerIds must be a non-empty array." });
    }
    // Same cap as this file's own GET / page-size limit — a bulk edit is a
    // deliberate, reviewed action, not a mechanism for editing the whole
    // chart of accounts in one call.
    if (rawIds.length > MAX_BULK_LEDGERS) {
      return res.status(400).json({
        error: `At most ${MAX_BULK_LEDGERS} parties per bulk update.`,
      });
    }

    // `companyId` and `ledgerIds` are request SCOPE, not fields being set —
    // stripped before handing the rest to `buildUpdate`, whose whitelist
    // would otherwise (correctly) refuse them as unsupported.
    // Validated ONCE, before any database read — see the note above.
    const { companyId: _scopeCompany, ledgerIds: _scopeIds, ...termsBody } = req.body || {};
    let update;
    try {
      update = creditTerms.buildUpdate(termsBody, req.user, new Date());
    } catch (e) {
      if (e instanceof creditTerms.CreditTermsError) {
        return res.status(400).json({ error: e.message, code: e.code });
      }
      throw e;
    }

    // Sort every requested id into: duplicate / malformed / well-formed.
    // This happens before any query — a malformed id can never resolve to a
    // document, so there's nothing to look up.
    const skipped = [];
    const wellFormedIds = [];
    const seen = new Set();
    for (const raw of rawIds) {
      const key = String(raw);
      if (seen.has(key)) {
        skipped.push({ ledgerId: key, reason: "duplicate" });
        continue;
      }
      seen.add(key);
      if (!mongoose.Types.ObjectId.isValid(key)) {
        skipped.push({ ledgerId: key, reason: "invalid_id" });
        continue;
      }
      wellFormedIds.push(new mongoose.Types.ObjectId(key));
    }

    const partyGroupIds = [
      ...(await groupIdsForKind(companyId, "customer")),
      ...(await groupIdsForKind(companyId, "vendor")),
    ];

    // THE fail-closed scope (see the file-level comment above).
    const eligible = wellFormedIds.length
      ? await Acc_Ledger.find({
          _id: { $in: wellFormedIds },
          companyId,
          groupId: { $in: partyGroupIds },
        })
          .select("_id")
          .lean()
      : [];
    const eligibleIdSet = new Set(eligible.map((l) => String(l._id)));

    // Everything well-formed but NOT eligible is either the wrong company or
    // not a party ledger — worth telling apart, so a caller can see whether
    // they picked the wrong id or the wrong kind of ledger. This is reporting
    // only: neither branch below ever writes anything.
    const notEligible = wellFormedIds.filter((id) => !eligibleIdSet.has(String(id)));
    if (notEligible.length) {
      const inCompanyAnyGroup = await Acc_Ledger.find({
        _id: { $in: notEligible },
        companyId,
      })
        .select("_id")
        .lean();
      const inCompanySet = new Set(inCompanyAnyGroup.map((l) => String(l._id)));
      for (const id of notEligible) {
        const key = String(id);
        skipped.push({
          ledgerId: key,
          reason: inCompanySet.has(key) ? "not_a_party_ledger" : "not_found_in_company",
        });
      }
    }

    if (eligible.length === 0) {
      return res.json({
        ok: true,
        updatedCount: 0,
        requestedCount: rawIds.length,
        skipped,
        parties: [],
      });
    }

    const eligibleIds = eligible.map((l) => l._id);

    // $set with the explicitly built object, scoped by the SAME
    // `{ _id: $in, companyId }` pair used to determine eligibility above —
    // re-stated here rather than trusted from the earlier read, so a ledger
    // reassigned to a different company between the two queries still can't
    // end up written.
    await Acc_Ledger.updateMany(
      { _id: { $in: eligibleIds }, companyId },
      { $set: update },
      { runValidators: true },
    );

    const saved = await Acc_Ledger.find({ _id: { $in: eligibleIds }, companyId })
      .select(
        "_id name creditPeriodDays creditTermsSource creditTermsUpdatedAt creditTermsUpdatedByName",
      )
      .lean();

    const parties = saved.map((l) => {
      const days = l.creditPeriodDays;
      const termsSet = creditTerms.isTermSet(days);
      return {
        ledgerId: l._id,
        name: l.name,
        creditPeriodDays: termsSet ? days : null,
        creditTermsSet: termsSet,
        creditTermsSource: l.creditTermsSource || null,
        creditTermsUpdatedAt: l.creditTermsUpdatedAt || null,
        creditTermsUpdatedByName: l.creditTermsUpdatedByName || null,
      };
    });

    res.json({
      ok: true,
      updatedCount: parties.length,
      requestedCount: rawIds.length,
      skipped,
      parties,
    });
  } catch (e) {
    console.error("[parties/bulk-credit-terms]", e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
