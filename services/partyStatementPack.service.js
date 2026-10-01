/**
 * GRAV-CMS-BACKEND/services/partyStatementPack.service.js
 *
 * Many parties' statements of account, in one download.
 *
 * ── WHAT THIS IS AND IS NOT ─────────────────────────────────────────────────
 * It is an ASSEMBLY step. Every figure in a pack comes from
 * `partyOutstanding.partyLedgerStatement` — the same function the single
 * Statement tab download calls, per party, unchanged. Nothing here adds,
 * nets, re-derives or rounds a balance.
 *
 * That is deliberate and it is the whole design constraint. A bulk export that
 * computed its own opening balances would be a second balance engine, and the
 * day it disagreed with the individual statement nobody would know which of
 * the two an accountant had sent to a customer. So the pack's arithmetic is
 * not tested against a specification; it is tested against the individual
 * statement, statement by statement.
 *
 * ── SCOPE RULES, UNCHANGED ──────────────────────────────────────────────────
 * The same rules the outstanding and ageing exports obey, for the same
 * reasons — see `partyOutstanding.resolvePartyLedgers`:
 *
 *   selected / filtered   defined by their EXACT id list, re-resolved inside
 *                         the company AND the party kind's Sundry group. An id
 *                         from another company, or a customer's id in a
 *                         supplier pack, is simply not in the answer.
 *   an EMPTY filtered set produces an EMPTY pack. It never widens to "all" —
 *                         that widening is how a filtered export of nothing
 *                         becomes an export of everything.
 *   all                   every party ledger of this kind in this company.
 *
 * ── COST ────────────────────────────────────────────────────────────────────
 * One statement is three queries; a pack of N parties is ~3N. The 2,000-ledger
 * cap is inherited from the other exports and is a real ceiling here, not a
 * theoretical one — see the note on `MAX_PACK_LEDGERS`.
 *
 * ── READ-ONLY ───────────────────────────────────────────────────────────────
 * Nothing here writes.
 */

"use strict";

const party = require("./partyOutstanding.service");

/**
 * The same cap the other exports use.
 *
 * It bounds the id list, and for a pack it also bounds the work: 2,000 parties
 * is ~6,000 queries and a document nobody reads end to end. It is kept
 * identical rather than lowered so one number governs every export, but a pack
 * near the cap is slow and the route says so in its own comment.
 */
const MAX_PACK_LEDGERS = party.MAX_EXPORT_LEDGERS;

/**
 * Every party this pack covers, under the scope rules.
 *
 * Returns lean ledger docs, ordered by name — the order the pack's sheets,
 * pages and zip entries all follow, so the three formats of one request list
 * the same parties in the same sequence.
 */
async function packLedgers(kind, filters) {
  const restrictToIds = !!filters.restrictToIds;
  return party.resolvePartyLedgers(kind, filters.companyId, {
    ledgerIds: restrictToIds ? filters.ledgerIds : [],
    restrictToIds,
    /* An id scope is already exact; re-applying the screen's search on top
     * could only drop parties the user selected. Same rule as the other
     * exports. */
    search: restrictToIds ? "" : filters.search,
  });
}

/**
 * The period line every document in the pack shares.
 *
 * A pack is one request over one period, so this is computed once from the
 * filters rather than read off the first statement — an empty pack still has a
 * period, and still has to say what it was.
 */
function packPeriod(filters) {
  const from = filters.from || null;
  const to = filters.to || null;
  const asOf = filters.asOf || null;
  return {
    from,
    to,
    asOf,
    /* `to` wins when both are given; `asOf` alone means "everything up to
     * here". Identical to the single statement's own rule. */
    periodEnd: to || asOf || null,
    isRange: !!from,
  };
}

/** The applied-scope line printed on every document. */
function describeScope(kind, filters, { resolvedCount = null } = {}) {
  const k = party.partyKind(kind);
  const n = resolvedCount != null ? ` (${resolvedCount})` : "";
  if (filters.scope === "selected") return `Scope: selected ${k.partyLabelPlural}${n}`;
  if (filters.scope === "filtered") return `Scope: current filtered result${n}`;
  return `Scope: all accounting ${k.partyLabelPlural}${n}`;
}

/** Pack-level totals. Sums of the statements, never a re-derivation. */
function packTotals(statements) {
  let debit = 0;
  let credit = 0;
  let transactions = 0;
  let openingSigned = 0;
  let closingSigned = 0;
  let withMovement = 0;
  for (const s of statements) {
    debit += s.totals.debit;
    credit += s.totals.credit;
    transactions += s.totals.transactionCount;
    openingSigned += s.opening.signed;
    closingSigned += s.closing.signed;
    if (s.totals.transactionCount > 0) withMovement += 1;
  }
  return {
    partyCount: statements.length,
    partiesWithMovement: withMovement,
    transactionCount: transactions,
    debit: party.round2(debit),
    credit: party.round2(credit),
    openingSigned: party.round2(openingSigned),
    closingSigned: party.round2(closingSigned),
  };
}

/**
 * THE STATEMENT PACK.
 *
 * @param {object} kind     a PARTY_KINDS descriptor or key
 * @param {object} filters  as produced by `parseReportQuery().filters`
 * @returns {object|null}   null when the company does not exist
 */
async function partyStatementPack(kind, filters = {}) {
  const k = party.partyKind(kind);
  const cId = party.oid(filters.companyId);
  if (!cId) return null;

  const company = await party.companyHeader(cId);
  if (!company) return null;

  const ledgers = await packLedgers(k, { ...filters, companyId: cId });

  /* THE CAP IS ENFORCED ON THE RESOLVED POPULATION, NOT JUST THE ID LIST.
   *
   * `parseReportQuery` already refuses an id list longer than the cap, but
   * `scope=all` names no ids at all — a company with 5,000 debtors would walk
   * straight past that check into ~15,000 queries and a document nobody can
   * open. Every other export survives that because it is ONE aggregate; this
   * one is three queries per party, so the ceiling has to be re-checked here,
   * after the scope resolves and before any statement is built. */
  if (ledgers.length > MAX_PACK_LEDGERS) {
    const e = new Error(
      `This scope resolves to ${ledgers.length} ${k.partyLabelPlural}. ` +
        `At most ${MAX_PACK_LEDGERS} can be exported in one statement pack — ` +
        `narrow the selection or filter first.`,
    );
    e.code = "EXPORT_TOO_LARGE";
    e.resolvedLedgerCount = ledgers.length;
    throw e;
  }

  const period = packPeriod(filters);

  /* Sequential on purpose. Each statement is three queries and a pack can name
   * two thousand parties; firing them all at once would open a connection
   * storm against the same Mongo the rest of the app is using. A slow export
   * is better than a fast one that degrades every other request. */
  const statements = [];
  for (const ledger of ledgers) {
    const stmt = await party.partyLedgerStatement(k, {
      companyId: cId,
      ledgerId: ledger._id,
      from: filters.from,
      to: filters.to,
      asOf: filters.asOf,
    });
    /* `partyLedgerStatement` re-resolves the id itself and returns null when
     * it is not a party of this kind in this company. `packLedgers` already
     * guaranteed that, so a null here would mean the two disagreed — skip it
     * rather than emit a half-built entry. */
    if (stmt) statements.push(stmt);
  }

  return {
    reportType: `${k.key}-statement-pack`,
    partyKind: k.key,
    title: `${k.columnLabel} Statement Pack`,
    labels: {
      party: k.partyLabel,
      partyPlural: k.partyLabelPlural,
      column: k.columnLabel,
      group: k.groupLabel,
      filenameStem: `${k.key}-statements`,
      statementTitle: k.statementTitle,
      primaryLabel: k.primaryLabel,
      secondaryLabel: k.secondaryLabel,
      primarySide: k.primarySide,
    },
    company,
    ...period,
    generatedAt: new Date(),
    filters: { ...filters, companyId: String(cId) },
    scopeSummary: describeScope(k, filters, { resolvedCount: ledgers.length }),
    /* How many party ledgers the scope resolved to, before any statement was
     * built. Equal to `statements.length` unless a ledger vanished mid-run. */
    resolvedLedgerCount: ledgers.length,
    statements,
    totals: packTotals(statements),
  };
}

module.exports = {
  MAX_PACK_LEDGERS,
  packLedgers,
  packPeriod,
  describeScope,
  packTotals,
  partyStatementPack,
};
