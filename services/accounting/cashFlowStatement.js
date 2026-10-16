"use strict";

/**
 * THE CASH FLOW STATEMENT (16 Oct 2026 audit).
 *
 * The Cash Flow page (app/accountant/reports/cash-flow) has always drawn an
 * AS-3 statement — operating / investing / financing, opening and closing
 * cash, internal transfers — from `activities`, `openingCash`, `closingCash`
 * and `internalTransfers`. The route it calls never returned any of them: it
 * sent a per-ledger `breakdown` and `totals` only, so the statement showed ₹0
 * in every section and only the hand-added adjustments ever appeared.
 *
 * DIRECT METHOD, by counterpart. For each posted voucher that moves a cash or
 * bank ledger, the cash it moved is attributed to its OTHER lines: a credit
 * to a customer is cash in from that customer, a debit to rent is cash out to
 * rent. Each non-cash line contributes −(its signed amount); for a balanced
 * voucher those contributions add up to exactly the cash movement, so the
 * three sections always add up to closing − opening. A voucher whose lines
 * are all cash or bank (a contra) is an internal transfer: it moves no cash
 * in or out of the business and is reported apart.
 *
 * The section is the counterpart's PRIMARY group (the root of its group
 * tree): Fixed Assets / Investments are investing; Capital, Reserves and the
 * loan groups are financing; everything else is operating.
 */

const INVESTING = /^(fixed assets|investments|capital work[- ]in[- ]progress)$/i;
const FINANCING = /^(capital account|reserves? (&|and) surplus|loans? \(liability\)|loans? (&|and) advances \(liability\)|secured loans?|unsecured loans?|share capital)$/i;

function sectionOfRoot(rootName) {
  const n = String(rootName || "").trim();
  if (INVESTING.test(n)) return "investing";
  if (FINANCING.test(n)) return "financing";
  return "operating";
}

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const signed = (e) => (e.type === "Dr" ? 1 : -1) * (Number(e.amount) || 0);

/**
 * @param vouchers     posted, non-optional vouchers in the period that touch cash
 * @param cashIds      Set of cash / bank ledger ids (strings)
 * @param ledgerInfo   Map(ledgerId → { name, groupName, rootName })
 * @param openingCash  cash + bank balance at the start of the period (signed, + Dr)
 */
function buildCashFlow({ vouchers = [], cashIds, ledgerInfo = new Map(), openingCash = 0 }) {
  const sections = {
    operating: new Map(),
    investing: new Map(),
    financing: new Map(),
  };
  const transfers = { inflow: 0, outflow: 0 };
  let periodNet = 0;

  for (const v of vouchers) {
    const lines = v.ledgerEntries || [];
    const cashLines = lines.filter((e) => e.ledgerId && cashIds.has(String(e.ledgerId)));
    if (!cashLines.length) continue;
    const cashNet = cashLines.reduce((s, e) => s + signed(e), 0);
    periodNet += cashNet;
    const others = lines.filter((e) => !(e.ledgerId && cashIds.has(String(e.ledgerId))));

    if (!others.length) {
      /* a contra: cash to bank, bank to bank */
      for (const e of cashLines) {
        if (e.type === "Dr") transfers.inflow += Number(e.amount) || 0;
        else transfers.outflow += Number(e.amount) || 0;
      }
      continue;
    }

    for (const e of others) {
      const flow = -signed(e); // a credit to the counterpart is cash in
      if (!flow) continue;
      const id = String(e.ledgerId || `name:${e.ledgerName || "Unknown"}`);
      const info = ledgerInfo.get(String(e.ledgerId)) || {};
      const section = sectionOfRoot(info.rootName);
      const map = sections[section];
      const row = map.get(id) || {
        ledgerId: e.ledgerId || null,
        ledgerName: info.name || e.ledgerName || "Unknown",
        groupName: info.groupName || e.groupName || "",
        inflow: 0,
        outflow: 0,
        net: 0,
      };
      if (flow > 0) row.inflow += flow;
      else row.outflow += -flow;
      row.net += flow;
      map.set(id, row);
    }
  }

  const activities = {};
  for (const [key, map] of Object.entries(sections)) {
    const lines = [...map.values()]
      .map((l) => ({ ...l, inflow: r2(l.inflow), outflow: r2(l.outflow), net: r2(l.net) }))
      .filter((l) => l.net !== 0 || l.inflow !== 0)
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
    activities[key] = {
      lines,
      inflow: r2(lines.reduce((s, l) => s + l.inflow, 0)),
      outflow: r2(lines.reduce((s, l) => s + l.outflow, 0)),
      net: r2(lines.reduce((s, l) => s + l.net, 0)),
    };
  }

  return {
    openingCash: r2(openingCash),
    closingCash: r2(openingCash + periodNet),
    netChange: r2(periodNet),
    activities,
    internalTransfers: { inflow: r2(transfers.inflow), outflow: r2(transfers.outflow) },
  };
}

module.exports = { buildCashFlow, sectionOfRoot };
