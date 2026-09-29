"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { answerPartyReport } = require("../../services/ai/openJev/partyReportAnswer");
const { OUTCOME } = require("../../services/ai/openJev/ledgerAnswer");

const NOW = new Date("2026-09-27T00:00:00.000Z");

test("customer outstanding ranking is formatted from deterministic report rows", async () => {
  let received;
  const result = await answerPartyReport({
    resolvedArguments: {
      report: "customer_outstanding", asOf: null, search: null, ranking: "largest", limit: 2,
    },
    buildPartyReport: async (args) => {
      received = args;
      return {
        partyKind: "customer",
        asOf: new Date("2026-09-26T18:29:59.999Z"),
        totals: { receivable: 1800, customerCredit: 75 },
        rows: [
          { name: "Small Customer", receivable: 300 },
          { name: "Large Customer", receivable: 1500 },
        ],
      };
    },
    now: NOW,
  });
  assert.equal(result.outcome, OUTCOME.ANSWERED);
  assert.deepEqual(received, {
    report: "customer_outstanding", asOf: null, search: null, ranking: "largest", limit: 2,
  });
  assert.match(result.reply, /Total receivables: ₹1,800/);
  assert.match(result.reply, /1\. Large Customer — ₹1,500; 2\. Small Customer — ₹300/);
  assert.equal(result.evidence.schema, "grav.acc.party-report.evidence/1");
  assert.equal(result.evidence.rowCount, 2);
});

test("supplier ageing keeps payables and advances separate", async () => {
  const result = await answerPartyReport({
    resolvedArguments: {
      report: "supplier_ageing", asOf: "2026-09-27", search: null, ranking: "none", limit: 5,
    },
    buildPartyReport: async () => ({
      partyKind: "supplier",
      asOf: new Date("2026-09-27T18:29:59.999Z"),
      totals: { agedTotal: 2500, billOpposite: 125 },
      parties: [{ name: "Vendor", agedTotal: 2500 }],
    }),
    now: NOW,
  });
  assert.equal(result.outcome, OUTCOME.ANSWERED);
  assert.match(result.reply, /Supplier payables ageing total: ₹2,500/);
  assert.match(result.reply, /Supplier advances: ₹125/);
  assert.ok(!result.reply.includes("Largest"));
});

test("missing or unavailable reports fail closed", async () => {
  const missing = await answerPartyReport({ resolvedArguments: null, buildPartyReport: async () => ({}), now: NOW });
  assert.equal(missing.outcome, OUTCOME.CLARIFY);
  const unavailable = await answerPartyReport({
    resolvedArguments: { report: "customer_outstanding", ranking: "none", limit: 5 },
    buildPartyReport: async () => ({ available: false, reason: "company_unavailable" }),
    now: NOW,
  });
  assert.equal(unavailable.outcome, OUTCOME.FAILED);
  assert.equal(unavailable.reason, "company_unavailable");
});
