"use strict";

const { OUTCOME } = require("./ledgerAnswer");

const money = (value) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(Number(value) || 0)}`;

function rowAmount(report, row) {
  if (report.partyKind === "customer") return Number(row.receivable ?? row.agedTotal ?? 0);
  return Number(row.payable ?? row.agedTotal ?? 0);
}

function partyRows(report) {
  return Array.isArray(report.parties) ? report.parties : Array.isArray(report.rows) ? report.rows : [];
}

async function answerPartyReport({ resolvedArguments, buildPartyReport, now }) {
  if (!resolvedArguments || typeof resolvedArguments !== "object") {
    return { outcome: OUTCOME.CLARIFY, reason: "party_report_arguments_missing", reply: "Which receivables, payables or ageing report would you like?" };
  }
  let report;
  try {
    report = await buildPartyReport(resolvedArguments);
  } catch {
    return { outcome: OUTCOME.FAILED, reason: "party_report_read_failed" };
  }
  if (!report || report.available === false || !report.totals) {
    return { outcome: OUTCOME.FAILED, reason: report && report.reason || "party_report_unavailable" };
  }

  const ageing = resolvedArguments.report.endsWith("_ageing");
  const customer = resolvedArguments.report.startsWith("customer_");
  const noun = customer ? "customer" : "supplier";
  const primary = ageing
    ? Number(report.totals.agedTotal || 0)
    : Number(customer ? report.totals.receivable || 0 : report.totals.payable || 0);
  const secondary = ageing
    ? Number(report.totals.billOpposite || 0)
    : Number(customer ? report.totals.customerCredit || 0 : report.totals.supplierAdvance || 0);
  const rows = partyRows(report);
  const ranking = resolvedArguments.ranking || "none";
  const limit = Math.max(1, Math.min(15, Number(resolvedArguments.limit) || 5));
  const ranked = [...rows]
    .sort((a, b) => ranking === "smallest" ? rowAmount(report, a) - rowAmount(report, b) : rowAmount(report, b) - rowAmount(report, a))
    .slice(0, ranking === "none" ? 0 : limit);

  const parts = [
    ageing
      ? `${customer ? "Customer receivables" : "Supplier payables"} ageing total: ${money(primary)}`
      : `${customer ? "Total receivables" : "Total payables"}: ${money(primary)}`,
  ];
  if (secondary) {
    parts.push(`${customer ? "Customer credits" : "Supplier advances"}: ${money(secondary)}`);
  }
  if (ranked.length) {
    parts.push(`${ranking === "smallest" ? "Smallest" : "Largest"} ${ranked.length}: ${ranked.map((row, i) => `${i + 1}. ${row.name} — ${money(rowAmount(report, row))}`).join("; ")}`);
  }
  parts.push(`As at ${report.asOf ? new Date(report.asOf).toISOString().slice(0, 10) : now.toISOString().slice(0, 10)}`);

  return {
    outcome: OUTCOME.ANSWERED,
    reply: `${parts.join(". ")}.`,
    evidence: {
      schema: "grav.acc.party-report.evidence/1",
      report: resolvedArguments.report,
      partyKind: noun,
      total: primary,
      secondary,
      rowCount: rows.length,
      ranked: ranked.map((row) => ({ name: row.name, amount: rowAmount(report, row) })),
      effectiveAt: now.toISOString(),
    },
  };
}

module.exports = { answerPartyReport, rowAmount, partyRows };
