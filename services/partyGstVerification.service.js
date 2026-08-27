"use strict";
/**
 * services/partyGstVerification.service.js
 * ───────────────────────────────────────────────────────────────────────────
 * VERIFYING THE GSTINs THAT ARE ACTUALLY IN THE BOOKS.
 *
 * The company form checks one company. This checks the four hundred parties
 * the company trades with, which is where the money is:
 *
 *   A SUPPLIER whose registration was cancelled is not a data-quality issue.
 *   Input tax credit claimed against a cancelled GSTIN is DISALLOWED, and it
 *   is found at assessment — long after the invoice is paid, the goods are
 *   consumed and the quarter is closed. Nothing in the ledger says a word
 *   about it today.
 *
 *   A CUSTOMER with a dead GSTIN gets the wrong invoice treatment, which
 *   surfaces as a mismatch in their GSTR-2A and a call from their accountant.
 *
 * ── EVERY LOOKUP COSTS MONEY, SO NOTHING HERE IS AUTOMATIC ─────────────────
 * No hook on ledger save, no background sweep, no check-as-you-type. A sweep
 * is asked for, priced before it runs, capped, and told how many calls it
 * actually made. A compliance tool that quietly bills per keystroke gets
 * turned off, and then it is not a compliance tool.
 */

const { Acc_Ledger } = require("../models/Accountant_model/Acc_MasterModels");
const gstPortal = require("./gstPortal.service");
const { validateGstin, normaliseCompanyName } = require("./taxIdentity.service");

/* ── WHAT COUNTS AS A PARTY ────────────────────────────────────────────────
 * Having a GSTIN, and nothing else.
 *
 * The obvious filter is the group — Sundry Debtors and Sundry Creditors — and
 * it is wrong in a way that would quietly hide the risky records: real charts
 * of accounts nest parties under sub-groups ("Sundry Creditors > Fabric",
 * "Debtors > Export"), and `groupName` holds only the DIRECT parent. Every
 * party filed one level deeper would fall out of the sweep and read as
 * "nothing to check".
 *
 * A GSTIN on a ledger means somebody trades with a registered entity through
 * it. That is the whole population, whatever it is filed under. */
const hasGstin = { gstin: { $nin: ["", null] } };

const DEAD = /CANCELL?ED|SUSPEND|INACTIVE|INVALID/i;

/**
 * One lookup → the verdict to store on a ledger.
 *
 * Returns the sub-document, never writes it. Kept pure so the bulk path and
 * the single path cannot drift on what a given answer means.
 */
function verdictFrom(ledger, lookup) {
  const now = new Date();

  if (!lookup || !lookup.ok) {
    /* NOT a verdict on the party. A provider outage, a sandbox key or an
       exhausted balance says nothing about whether this supplier is
       registered, and recording it as though it did would put a red mark
       against a company that has done nothing wrong. */
    const why =
      lookup?.reason === "mismatched-response"
        ? "The provider answered about a different GSTIN — sandbox or trial key."
        : lookup?.reason === "not-configured"
          ? "No GST lookup provider is configured."
          : `Lookup ${lookup?.reason || "failed"}.`;
    return { status: "unavailable", note: why, checkedAt: now, source: lookup?.provider || "" };
  }

  if (lookup.found === false) {
    return {
      status: "not-found",
      note: "The GST Network has no registration with this GSTIN.",
      checkedAt: now,
      source: lookup.provider || "",
      legalName: "",
      tradeName: "",
    };
  }

  const d = lookup.data || {};
  const base = {
    legalName: d.legalName || "",
    tradeName: d.tradeName || "",
    registrationDate: d.registrationDate || "",
    taxpayerType: d.taxpayerType || "",
    cancelledDate: d.cancelledDate || "",
    source: lookup.provider || "",
    checkedAt: now,
    note: "",
  };

  if (d.status && DEAD.test(String(d.status))) {
    return {
      ...base,
      status: "cancelled",
      note: `Registration ${d.status}${d.cancelledDate ? ` since ${d.cancelledDate}` : ""}. Input tax credit against this party is at risk.`,
    };
  }

  /* Registered and active, but under a name that is not this ledger's. Worth
     its own status rather than a pass: it is usually a ledger pointing at the
     wrong party's GSTIN, which is exactly the error that puts somebody else's
     credit on your return. */
  const registered = d.legalName || d.tradeName;
  if (registered && ledger?.name) {
    const a = normaliseCompanyName(ledger.name);
    const b = normaliseCompanyName(registered);
    const same = a === b || (a && b && (a.includes(b) || b.includes(a)));
    if (!same) {
      return {
        ...base,
        status: "mismatch",
        note: `Registered to "${registered}", but this ledger is named "${ledger.name}".`,
      };
    }
  }

  return { ...base, status: "active" };
}

/** Verify one ledger and store the answer. Returns the ledger's new verdict. */
async function verifyLedger(ledgerId, { force = false } = {}) {
  const ledger = await Acc_Ledger.findById(ledgerId);
  if (!ledger) return { ok: false, reason: "not-found" };

  const offline = validateGstin(ledger.gstin);
  if (offline.status === "empty") {
    return { ok: false, reason: "no-gstin", name: ledger.name };
  }
  if (offline.status !== "ok") {
    /* Malformed is a verdict arithmetic can give for free, and spending a
       call to confirm it would be paying to be told what we know. */
    ledger.gstVerification = {
      status: "not-found",
      note: `The GSTIN is not valid: ${offline.message}`,
      checkedAt: new Date(),
      source: "offline",
    };
    await ledger.save();
    return { ok: true, name: ledger.name, verdict: ledger.gstVerification, spentCall: false };
  }

  const lookup = await gstPortal.lookupGstin(offline.value, { force });
  ledger.gstVerification = verdictFrom(ledger, lookup);
  await ledger.save();

  return {
    ok: true,
    name: ledger.name,
    verdict: ledger.gstVerification,
    /* A cached answer is free. Reported so a sweep can say what it actually
       spent rather than what it looked at. */
    spentCall: !lookup.cached && lookup.ok !== false,
  };
}

/** The parties worth checking, and what a sweep over them would cost. */
async function scope({ companyId, onlyStale = true, staleDays = 90 } = {}) {
  const q = {
    ...hasGstin,
    $or: [{ isActive: true }, { isActive: { $exists: false } }],
  };
  if (companyId) q.companyId = companyId;

  const all = await Acc_Ledger.find(q).select("name gstin gstVerification groupName").lean();

  const cutoff = Date.now() - staleDays * 24 * 60 * 60 * 1000;
  const needed = all.filter((l) => {
    if (!onlyStale) return true;
    const v = l.gstVerification;
    if (!v || !v.checkedAt || v.status === "unchecked") return true;
    /* An `unavailable` result is not an answer, so it never counts as done. */
    if (v.status === "unavailable") return true;
    return new Date(v.checkedAt).getTime() < cutoff;
  });

  return { total: all.length, toCheck: needed.length, ledgers: needed };
}

/**
 * Check many parties.
 *
 * `limit` is a hard stop, not a suggestion: a sweep over a chart of accounts
 * nobody has counted could otherwise spend a subscription in one request.
 * The caller is told what was skipped rather than left to assume the sweep
 * covered everything.
 */
async function verifyMany({
  companyId,
  onlyStale = true,
  staleDays = 90,
  limit = 50,
  force = false,
} = {}) {
  const found = await scope({ companyId, onlyStale, staleDays });
  const batch = found.ledgers.slice(0, limit);

  const results = [];
  let spent = 0;
  for (const l of batch) {
    /* Sequentially, on purpose. Providers rate-limit, and a burst of four
       hundred parallel requests is the fastest way to get a key throttled or
       banned. */
    const r = await verifyLedger(l._id, { force });
    if (r.spentCall) spent++;
    results.push({
      id: String(l._id),
      name: l.name,
      gstin: l.gstin,
      status: r.verdict?.status || "unavailable",
      note: r.verdict?.note || "",
      registeredAs: r.verdict?.legalName || "",
    });

    /* If the provider stops answering there is no point walking the rest of
       the list: every remaining call would fail the same way, and each one
       may still be billed. */
    if (r.verdict?.status === "unavailable" && results.length >= 3) {
      const lastThree = results.slice(-3);
      if (lastThree.every((x) => x.status === "unavailable")) {
        return {
          checked: results.length,
          spentCalls: spent,
          remaining: found.toCheck - results.length,
          total: found.total,
          abortedEarly: true,
          reason: r.verdict.note,
          results,
        };
      }
    }
  }

  return {
    checked: results.length,
    spentCalls: spent,
    remaining: Math.max(0, found.toCheck - batch.length),
    total: found.total,
    abortedEarly: false,
    results,
  };
}

/** The standing picture, for a report that costs nothing to open. */
async function summary({ companyId } = {}) {
  const q = { ...hasGstin };
  if (companyId) q.companyId = companyId;

  const rows = await Acc_Ledger.find(q).select("name gstin gstVerification groupName").lean();

  const buckets = { active: [], cancelled: [], "not-found": [], mismatch: [], unavailable: [], unchecked: [] };
  for (const r of rows) {
    const status = r.gstVerification?.status || "unchecked";
    (buckets[status] || buckets.unchecked).push({
      id: String(r._id),
      name: r.name,
      gstin: r.gstin,
      group: r.groupName,
      registeredAs: r.gstVerification?.legalName || "",
      note: r.gstVerification?.note || "",
      checkedAt: r.gstVerification?.checkedAt || null,
    });
  }

  return {
    total: rows.length,
    counts: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
    /* The two that cost money, first and in full. Everything else is a
       count — nobody opens this report to read a list of parties that are
       fine. */
    cancelled: buckets.cancelled,
    notFound: buckets["not-found"],
    mismatch: buckets.mismatch,
  };
}

module.exports = { verifyLedger, verifyMany, scope, summary, verdictFrom };
