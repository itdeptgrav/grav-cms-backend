"use strict";
/**
 * services/commitmentRelease.service.js
 *
 * WHICH PART OF A PROMISE A BILL ACTUALLY DISCHARGES.
 *
 * ── THE PROBLEM ─────────────────────────────────────────────────────────────
 * A request buys fabric, packaging, freight and a repair, and commits against
 * four budget heads. The supplier bills the fabric. Release was
 * whole-document, so posting that bill freed the budget on all four — three
 * heads suddenly had money back that nothing had been billed against, and the
 * budget report said so with complete confidence.
 *
 * ── WHY THIS IS ITS OWN MODULE, AND MOSTLY PURE ─────────────────────────────
 * The arithmetic is where this goes wrong quietly: a paise short, a line
 * released twice, an over-billed line pushing a remaining figure negative.
 * None of that is visible from a route test. `planRelease` takes plain objects
 * and returns plain objects; only `applyRelease`/`restoreVoucher` touch a
 * document.
 *
 * ── AND WHAT IT MUST NEVER DO ───────────────────────────────────────────────
 * Match on item name, vendor, amount or array position. A bill line discharges
 * a request line because it carries that line's id, derived on the server from
 * the purchase or service order — or it discharges nothing and says so.
 */

const toPaise = (v) => Math.round(Number(v || 0) * 100);
const toRupees = (p) => Math.round(p) / 100;
const money = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : 0);

/* ── A FIGURE THAT IS THERE, AS DISTINCT FROM ZERO ──────────────────────────
 * `Number(null)` is 0, and 0 IS finite. So a voucher carrying no grandTotal
 * read as a voucher totalling nothing, and every mapped line was adjusted down
 * to zero — releasing nothing while looking like a clean reconciliation. The
 * absence has to be tested before the value is. */
const present = (v) =>
  v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));

/**
 * Each contributing line's share of a group, after any adjustment moved the
 * group's total.
 *
 * The remainder goes on the last part, computed from the group total rather
 * than accumulated — so the parts add to the whole by construction, the same
 * way every other split in this programme does.
 */
function scaleParts(parts = [], groupPaise) {
  const rawTotal = parts.reduce((t, p) => t + p.paise, 0);
  if (!parts.length) return [];
  if (rawTotal === groupPaise || rawTotal === 0) {
    return parts.map((p) => ({ voucherLineId: p.voucherLineId, amount: toRupees(Math.max(0, p.paise)) }));
  }
  const out = [];
  let placed = 0;
  for (const p of parts.slice(0, -1)) {
    const share = Math.round((groupPaise * p.paise) / rawTotal);
    out.push({ voucherLineId: p.voucherLineId, amount: toRupees(Math.max(0, share)) });
    placed += share;
  }
  const last = parts[parts.length - 1];
  out.push({ voucherLineId: last.voucherLineId, amount: toRupees(Math.max(0, groupPaise - placed)) });
  return out;
}

/** A voucher line's own gross — what it actually bills, tax included. */
function lineGrossPaise(entry = {}) {
  return (present(entry.amount) ? toPaise(entry.amount) : 0)
    + (present(entry.taxAmount) ? toPaise(entry.taxAmount) : 0);
}

/**
 * What each request line is billed by this voucher.
 *
 * ── THE VOUCHER-LEVEL ADJUSTMENT ────────────────────────────────────────────
 * A bill carries a round-off, and sometimes a header discount, that belongs to
 * no line. Ignoring it makes the released parts fail to reconcile with the
 * voucher; dropping it on one line is arbitrary. It is spread across the
 * MAPPED lines in proportion, with the remainder on the last — the same rule
 * the approval side uses, so the two halves of the story round identically.
 *
 * Only mapped lines take a share. An unmapped charge line is not a request
 * line's problem, and letting it absorb part of the adjustment would silently
 * change what a mapped line discharges.
 */
function attributeByLine({ entries = [], grandTotal = null } = {}) {
  const mapped = [];
  const unmapped = [];

  for (const e of entries) {
    /* The id is the only thing that maps a bill line to a request line. */
    if (e && e.spendLineId) mapped.push(e);
    else unmapped.push(e);
  }

  const byLine = new Map();
  for (const e of mapped) {
    const key = String(e.spendLineId);
    const g = byLine.get(key) || { spendLineId: key, paise: 0, lineIds: [], parts: [] };
    const own = lineGrossPaise(e);
    g.paise += own;
    if (e._id) g.lineIds.push(String(e._id));
    /* Each contributing line's OWN share, kept so a cancellation can reverse
       exactly what this voucher wrote rather than one aggregate figure. */
    g.parts.push({ voucherLineId: e._id ? String(e._id) : null, paise: own });
    byLine.set(key, g);
  }

  const groups = [...byLine.values()];
  const mappedPaise = groups.reduce((t, g) => t + g.paise, 0);

  /* Only a GENUINE adjustment: the difference between what the voucher says it
     totals and what its lines add up to, INCLUDING the unmapped ones. An
     unmapped charge is not an adjustment, and treating it as one would inflate
     what the mapped lines release. */
  const entriesPaise = entries.reduce((t, e) => t + lineGrossPaise(e), 0);
  const adjustmentPaise = present(grandTotal)
    ? toPaise(grandTotal) - entriesPaise
    : 0;

  if (adjustmentPaise !== 0 && mappedPaise > 0) {
    let placed = 0;
    for (const g of groups.slice(0, -1)) {
      const share = Math.round((adjustmentPaise * g.paise) / mappedPaise);
      g.paise += share;
      placed += share;
    }
    /* The remainder, computed from the total rather than accumulated, so the
       parts add to the whole by construction. */
    groups[groups.length - 1].paise += adjustmentPaise - placed;
  }

  return {
    lines: groups.map((g) => ({
      spendLineId: g.spendLineId,
      voucherLineIds: g.lineIds,
      /* Scaled by whatever the adjustment did to the group, so the parts
         still sum to the group's amount. */
      contributions: scaleParts(g.parts, g.paise),
      amount: toRupees(Math.max(0, g.paise)),
    })),
    unmappedCount: unmapped.length,
    unmappedAmount: toRupees(unmapped.reduce((t, e) => t + lineGrossPaise(e), 0)),
    mappedAmount: toRupees(mappedPaise),
  };
}

/**
 * What this voucher would release from this commitment.
 *
 * Pure: `commitment` may be a lean object. Returns the per-allocation
 * decisions without touching anything.
 */
function planRelease({ commitment, voucher, entries = null } = {}) {
  if (!commitment) return { ok: false, why: "no_commitment" };

  const allocations = Array.isArray(commitment.allocations) ? commitment.allocations : null;
  if (!allocations || !allocations.length) {
    /* ── LEGACY: WHOLE-DOCUMENT, EXACTLY AS BEFORE ────────────────────────
       A commitment written before line-wise allocation has one head and no
       rows to release individually. Its behaviour is untouched. */
    return { ok: true, mode: "whole_document" };
  }

  const rows = entries || voucher?.inventoryEntries || [];
  const attributed = attributeByLine({ entries: rows, grandTotal: voucher?.grandTotal });

  /* ── ALREADY DONE IS NOT DONE AGAIN ───────────────────────────────────────
     A voucher saved twice, or posted and re-saved, must not release twice.
     Recognised by the voucher id already appearing in a release row — not by
     a status flag, because a re-post after cancellation has to be allowed to
     write again once the cancellation removed the rows. */
  const alreadyReleased = allocations.some((a) =>
    (a.releases || []).some((r) => String(r.voucherId) === String(voucher?._id)));
  if (alreadyReleased) return { ok: true, mode: "already_released", decisions: [] };

  const byLine = new Map(attributed.lines.map((l) => [l.spendLineId, l]));
  const decisions = [];
  let matched = 0;

  for (const a of allocations) {
    const billed = byLine.get(String(a.spendLineId));
    if (!billed) continue;
    matched += 1;

    const committedPaise = toPaise(a.amount);
    const alreadyPaise = toPaise(a.releasedAmount || 0);
    const remainingPaise = Math.max(0, committedPaise - alreadyPaise);
    /* ── AN OVER-BILLED LINE EXHAUSTS ITS PROMISE, NEVER MORE ────────────
       Billing ₹9,000 against a ₹6,000 commitment releases ₹6,000. The extra
       ₹3,000 is real spending and the voucher records it as such; it is not a
       promise anybody made, so there is nothing more here to discharge. A
       negative remaining would give the head money back it never had. */
    const releasePaise = Math.min(toPaise(billed.amount), remainingPaise);
    if (releasePaise <= 0) continue;

    /* Capped releases scale their contributions down with them, so the parts
       still sum to what was actually released. */
    const contributions = releasePaise === toPaise(billed.amount)
      ? billed.contributions
      : scaleParts(
        (billed.contributions || []).map((c) => ({ voucherLineId: c.voucherLineId, paise: toPaise(c.amount) })),
        releasePaise,
      );

    decisions.push({
      spendLineId: String(a.spendLineId),
      voucherLineIds: billed.voucherLineIds,
      contributions,
      amount: toRupees(releasePaise),
      billedAmount: billed.amount,
      remainingAfter: toRupees(remainingPaise - releasePaise),
      overBilled: toPaise(billed.amount) > remainingPaise,
    });
  }

  return {
    ok: true,
    mode: "line_wise",
    decisions,
    matchedAllocations: matched,
    /* ── SAID, NOT SWALLOWED ─────────────────────────────────────────────
       A line-wise commitment whose voucher maps to nothing must NOT fall back
       to whole-document release. The bill posts — it is the actual — and the
       commitment stays live carrying the reason. */
    warning: !attributed.lines.length
      ? "No line on this bill carries a request line, so no part of the commitment could be released."
      : matched === 0
        ? "This bill's lines do not match any allocation on the commitment."
        : attributed.unmappedCount
          ? `${attributed.unmappedCount} line(s) on this bill carry no request line and released nothing.`
          : null,
    attributed,
  };
}

/**
 * Apply the plan to a live commitment document.
 *
 * Writes append-only release rows, recomputes each allocation's remaining and
 * status, and only then decides the document's own status.
 */
async function applyRelease({ commitment, voucher, actor, entries = null } = {}) {
  const plan = planRelease({ commitment, voucher, entries });
  if (!plan.ok) return { released: false, why: plan.why };

  if (plan.mode === "whole_document") return { released: false, why: "legacy_whole_document" };
  if (plan.mode === "already_released") return { released: false, why: "already_released" };

  const stamp = {
    voucherId: voucher?._id,
    voucherNumber: voucher?.voucherNumber || "",
    at: new Date(),
    by: actor?.email || actor?.id || "",
    byName: actor?.name || "",
  };

  const byLine = new Map(plan.decisions.map((d) => [d.spendLineId, d]));
  for (const a of commitment.allocations) {
    const d = byLine.get(String(a.spendLineId));
    if (d) {
      if (!Array.isArray(a.releases)) a.releases = [];
      a.releases.push({
        ...stamp,
        voucherLineId: d.voucherLineIds[0] || undefined,
        /* Every contributing line, not only the first. */
        contributions: (d.contributions || []).length ? d.contributions : undefined,
        amount: d.amount,
      });
      a.releasedAmount = money((a.releasedAmount || 0) + d.amount);
    }
    /* Recomputed for EVERY allocation, not only the ones just touched — a row
       written before `remainingAmount` existed has none, and leaving it unset
       would make the availability aggregation read it as zero. */
    a.remainingAmount = money(Math.max(0, money(a.amount) - money(a.releasedAmount || 0)));
    /* ── AN UNBUDGETED LINE HAS A BILLING LIFECYCLE TOO ─────────────────
       It reduces no budget — that is what `unbudgeted` means, and it stays
       excluded from every availability figure. But it is still a promise the
       company made, and finance still needs to know whether it has been
       billed. Its status keeps the word `unbudgeted` so nothing downstream
       mistakes it for spendable, while `releasedAmount` and `remainingAmount`
       track it exactly as they do a budgeted row. */
    if (a.status !== "unbudgeted") {
      a.status = a.remainingAmount <= 0
        ? "released"
        : (a.releasedAmount > 0 ? "partially_released" : "committed");
    }
  }

  /* ── THE DOCUMENT IS DONE ONLY WHEN EVERY ROW IS ──────────────────────────
     A partially billed request stays live. Marking the document released while
     three of its four heads are still promised is precisely the bug — and an
     UNBUDGETED row that nobody has billed holds it open just the same. It
     reduces no budget, but the company still owes the money, and a commitment
     reported complete while part of it is unbilled is a false statement about
     what is outstanding. */
  const allDone = commitment.allocations.length > 0
    && commitment.allocations.every((a) => (a.remainingAmount || 0) <= 0);

  commitment.releasedAmount = money(
    commitment.allocations.reduce((t, a) => t + money(a.releasedAmount || 0), 0),
  );
  commitment.reconciliationWarning = plan.warning || undefined;

  if (allDone) {
    commitment.status = "released";
    commitment.releasedAt = new Date();
    commitment.releasedBy = stamp.by;
    commitment.releasedByName = stamp.byName;
    commitment.releaseReason = "voucher_posted";
    commitment.releasedByVoucherId = voucher?._id;
    commitment.releasedByVoucherNumber = voucher?.voucherNumber || "";
  } else if (commitment.releasedAmount > 0) {
    commitment.status = "partially_released";
  }

  await commitment.save();
  return {
    released: plan.decisions.length > 0,
    mode: "line_wise",
    decisions: plan.decisions,
    warning: plan.warning || null,
    commitment,
  };
}

/**
 * Undo exactly what one voucher released, and nothing else.
 *
 * ── WHY THE ROWS, NOT A TOTAL ───────────────────────────────────────────────
 * Two bills partially released one line. Cancelling the first must give back
 * only the first's amount — restoring "everything released" would revive the
 * second bill's discharge too, and that bill is still posted.
 */
async function restoreVoucher({ commitment, voucher } = {}) {
  if (!commitment || !voucher?._id) return { restored: false };
  const allocations = Array.isArray(commitment.allocations) ? commitment.allocations : null;
  if (!allocations || !allocations.length) return { restored: false, why: "legacy_whole_document" };

  let givenBack = 0;
  for (const a of allocations) {
    const keep = (a.releases || []).filter((r) => String(r.voucherId) !== String(voucher._id));
    const dropped = (a.releases || []).filter((r) => String(r.voucherId) === String(voucher._id));
    if (!dropped.length) continue;

    givenBack += dropped.reduce((t, r) => t + money(r.amount), 0);
    a.releases = keep.length ? keep : undefined;
    a.releasedAmount = money(keep.reduce((t, r) => t + money(r.amount), 0));
    a.remainingAmount = money(Math.max(0, money(a.amount) - a.releasedAmount));
    /* An unbudgeted row's figures move back too; only its WORD is fixed. */
    if (a.status !== "unbudgeted") {
      a.status = a.remainingAmount <= 0
        ? "released"
        : (a.releasedAmount > 0 ? "partially_released" : "committed");
    }
  }

  if (!givenBack) return { restored: false, why: "nothing_from_this_voucher" };

  commitment.releasedAmount = money(
    allocations.reduce((t, a) => t + money(a.releasedAmount || 0), 0),
  );
  const allDone = allocations.length > 0
    && allocations.every((a) => (a.remainingAmount || 0) <= 0);

  if (allDone) {
    commitment.status = "released";
  } else {
    commitment.status = commitment.releasedAmount > 0 ? "partially_released" : "committed";
    /* The whole-document release fields described a completion that has not
       happened any more. */
    commitment.releasedAt = undefined;
    commitment.releasedBy = undefined;
    commitment.releasedByName = undefined;
    commitment.releaseReason = undefined;
    commitment.releasedByVoucherId = undefined;
    commitment.releasedByVoucherNumber = undefined;
  }

  await commitment.save();
  return { restored: true, amount: money(givenBack), commitment };
}

/* ══ THE ONE ORCHESTRATOR ════════════════════════════════════════════════════
 *
 * ── WHY EXACTLY ONE ─────────────────────────────────────────────────────────
 * A voucher becomes posted in six places — create-with-autoPost, /post,
 * /approve, the edit path, the expense module and the approvals executor — and
 * every one of them ends in `save()`. The model's post-save hook is the
 * chokepoint they all pass through, which is why the release belongs there and
 * not in any route.
 *
 * B3B briefly had BOTH: the hook still calling the legacy whole-document
 * release, and the create route calling the new line-wise one. For a
 * line-wise commitment the hook could get there first and free the whole
 * thing — the exact bug the chunk existed to fix, reintroduced by the fix.
 * There is now one entry point, and the routes call nothing.
 *
 * ── AND WHY IT DECIDES, RATHER THAN THE CALLER ──────────────────────────────
 * Legacy whole-document versus line-wise is a property of the COMMITMENT, not
 * of the call site. A caller that had to know which kind it was holding would
 * be a seventh place to get it wrong.
 */
async function orchestrate({ voucher, actor, transition } = {}) {
  const Commitment = require("../models/Accountant_model/Acc_BudgetCommitment");
  const commitments = require("./budgetCommitment.service");

  if (transition === "cancelled") {
    /* Any commitment this voucher wrote a release row on — found by the ROW,
       because a partially released commitment is `partially_released` and the
       legacy lookup only ever knew `released`. */
    const byRow = await Commitment.findOne({ "allocations.releases.voucherId": voucher?._id });
    if (byRow) return restoreVoucher({ commitment: byRow, voucher });
    return commitments.restoreForVoucher({ voucher });
  }

  if (transition !== "posted") return { released: false, why: "not_a_release_transition" };

  const commitment = await commitments.commitmentForVoucher(voucher);
  if (!commitment) return { released: false, why: "no_commitment" };

  /* One company's voucher must never touch another's promise. */
  if (commitment.companyId && voucher?.companyId
    && String(commitment.companyId) !== String(voucher.companyId)) {
    return { released: false, why: "different_company" };
  }

  const hasAllocations = Array.isArray(commitment.allocations) && commitment.allocations.length;
  if (!hasAllocations) {
    /* Unchanged for every commitment written before line-wise allocation. */
    return commitments.releaseForVoucher({ commitment, voucher, actor });
  }

  /* ── AND NEVER A FALLBACK ───────────────────────────────────────────────
     A line-wise commitment whose bill maps to nothing stays live. Releasing
     it because the mapping was missing would free money with no evidence
     anybody had billed for it. */
  return applyRelease({ commitment, voucher, actor });
}

/* ══ WHAT A STORED VOUCHER DISCHARGED ════════════════════════════════════════
 *
 * ── WHY THIS IS READ, NOT REMEMBERED ────────────────────────────────────────
 * The reconciliation used to ride back on the response to voucher CREATION.
 * It appeared once, and reopening the voucher tomorrow — or refreshing the
 * page — showed nothing at all, because there was nothing to show it from.
 *
 * Everything below is reconstructed from the commitment's own stored release
 * rows, so the answer is the same on the hundredth visit as on the first.
 */
async function reconciliationFor(voucher) {
  if (!voucher?._id) return null;
  const Commitment = require("../models/Accountant_model/Acc_BudgetCommitment");

  /* By the release ROW first — that is the only link that survives a
     partially released commitment. The explicit id is the fallback for a
     voucher that released nothing (so wrote no rows) but is still linked. */
  const commitment = await Commitment.findOne({
    $or: [
      { "allocations.releases.voucherId": voucher._id },
      ...(voucher.budgetCommitmentId ? [{ _id: voucher.budgetCommitmentId }] : []),
      ...(voucher.spendRequestId ? [{ spendRequestId: voucher.spendRequestId }] : []),
    ],
  }).lean().catch(() => null);
  if (!commitment) return null;

  const allocations = Array.isArray(commitment.allocations) ? commitment.allocations : [];
  const mine = [];
  let releasedHere = 0;

  for (const a of allocations) {
    for (const r of a.releases || []) {
      if (String(r.voucherId) !== String(voucher._id)) continue;
      releasedHere += money(r.amount);
      mine.push({
        spendLineId: String(a.spendLineId),
        name: a.name || "",
        ledgerName: a.ledgerName || null,
        unbudgeted: a.status === "unbudgeted",
        released: money(r.amount),
        /* Every contributing bill line, so the audit is complete even where
           several mapped to one request line. */
        contributions: (r.contributions || []).map((c) => ({
          voucherLineId: c.voucherLineId ? String(c.voucherLineId) : null,
          amount: money(c.amount),
        })),
        remainingAfter: money(a.remainingAmount ?? a.amount),
        reserved: money(a.amount),
      });
    }
  }

  /* Which of THIS voucher's lines discharged nothing, and why. */
  const mappedLineIds = new Set(mine.flatMap((m) => m.contributions.map((c) => c.voucherLineId)));
  const unmapped = (voucher.inventoryEntries || [])
    .filter((e) => !e.spendLineId || !mappedLineIds.has(String(e._id)))
    .map((e) => ({
      voucherLineId: e._id ? String(e._id) : null,
      name: e.stockItemName || e.chargeDescription || "",
      amount: toRupees(lineGrossPaise(e)),
      reason: !e.spendLineId
        ? "This line is not matched to a request line."
        : "This line's request line had nothing left to release.",
    }));

  return {
    commitmentId: String(commitment._id),
    spendRequestId: commitment.spendRequestId ? String(commitment.spendRequestId) : null,
    spendRequestNumber: commitment.spendRequestNumber || null,
    status: commitment.status,
    reserved: money(commitment.amount),
    /* Everything every voucher has released, not only this one — the two
       answer different questions and a screen showing one as the other would
       misstate what is outstanding. */
    releasedToDate: money(commitment.releasedAmount || 0),
    releasedByThisVoucher: money(releasedHere),
    remaining: money(allocations.reduce((t, a) => t + money(a.remainingAmount ?? a.amount), 0)),
    lines: mine,
    unmapped,
    warning: commitment.reconciliationWarning || null,
    legacy: !allocations.length,
  };
}

module.exports = {
  orchestrate,
  reconciliationFor,
  attributeByLine,
  planRelease,
  applyRelease,
  restoreVoucher,
  lineGrossPaise,
};
