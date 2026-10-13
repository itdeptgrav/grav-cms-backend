#!/usr/bin/env node
"use strict";
/**
 * scripts/audits/store-command-behaviour.js
 *
 * AUDIT 2 OF 2 — BEHAVIOURAL. DOES A PERSON TYPING A SENTENCE GET THE RIGHT
 * ANSWER?
 *
 * ── WHY THIS IS A SEPARATE AUDIT ──────────────────────────────────────────
 * `store-command-search-coverage.js` proves every concept in every Store
 * catalogue is reachable and owned by an authorised capability. That is a
 * real property, and it is NOT this one. A previous report folded the two
 * together and read 2,646 addressable concepts as a working product, while
 * five of the ten required sentences returned nothing and two were answered
 * with the wrong records.
 *
 * The earlier attempt at measuring sentences asked whether a sentence
 * contained a concept's alias. That can be wrong in both directions at once:
 * "pending goods receipt inspections" contained one and was answered with
 * every inspection; "GRN/2026-27/0004" contained none and is answered
 * correctly. So this audit does not inspect words. It seeds a Store, asks
 * the questions through the same entry point the HTTP route calls, and reads
 * the answers back.
 *
 * ── WHAT IT COVERS ───────────────────────────────────────────────────────
 * One case per kind of question, each with what the answer must and must not
 * say: exact identity, partial identity, a field, a filter, a date window,
 * top-N, a count, an aggregate, a relationship, a location, ambiguity,
 * permission, and cross-tenant denial. A case passes only if the state is
 * right AND the words are right — "answered" alone would pass a confident
 * answer to a different question.
 *
 *   node scripts/audits/store-command-behaviour.js
 *   node scripts/audits/store-command-behaviour.js --json
 */

const mongoose = require("mongoose");

const CASES = [
  {
    kind: "exact identity",
    query: "GRN/2026-27/0004",
    state: ["answered"],
    says: [/GRN\/2026-27\/0004/],
  },
  {
    kind: "partial identity",
    query: "macbook",
    state: ["answered", "choices"],
    says: [/Macbook/],
    /* The Pro merely starts the same way. Offering it as the answer would be
       a guess wearing the right name. */
    never: [/Pro 14/],
  },
  {
    kind: "a field of a named record",
    query: "stock of macbook",
    state: ["answered"],
    says: [/Macbook/, /\b4\b/],
  },
  {
    kind: "a filter by a recorded status",
    query: "pending material requests",
    state: ["answered"],
    says: [/MRF-2605-0002/],
    /* MRF-0001 is APPROVED. Naming it would mean the status was dropped. */
    never: [/MRF-2605-0001\b/],
  },
  {
    kind: "a date window on the date the question named",
    query: "goods receipts expected in June 2026",
    state: ["answered"],
    /* A receipt recorded on 20 May is not an arrival expected in June. */
    never: [/GRN\/2026-27\/0004/],
  },
  {
    kind: "a date window the capability cannot place",
    query: "material requests in June 2026",
    state: ["needs_clarification"],
    says: [/June 2026/i],
    never: [/MRF-2605/],
  },
  {
    kind: "top-N, newest first",
    query: "latest five material requests",
    state: ["answered"],
    says: [/MRF-2605-0007/, /MRF-2605-0003/],
    never: [/MRF-2605-0001\b/, /MRF-2605-0002\b/],
  },
  {
    kind: "a count",
    query: "how many material requests are there",
    state: ["answered"],
    says: [/\b7\b/],
  },
  {
    kind: "an aggregate",
    query: "total quantity on hand of 16mm flex pipe",
    state: ["answered", "choices", "no_match"],
  },
  {
    kind: "a relationship — one supplier's orders",
    query: "purchase orders of Gaurav Enterprises",
    state: ["answered"],
    says: [/PO\/2026-27\/0101/],
    never: [/PO\/2026-27\/0102/],
  },
  {
    kind: "a physical location",
    query: "where is soda ash kept",
    state: ["answered"],
    says: [/Bin 2/, /25 Kg/],
  },
  {
    kind: "which rack",
    query: "which rack has soda ash",
    state: ["answered"],
    says: [/Rack 1/],
  },
  {
    kind: "a shortfall",
    query: "shortfall for 16mm flex pipe",
    state: ["answered"],
    says: [/short by 8 Mtr/],
  },
  {
    kind: "work pending, from the capability that records it",
    query: "pending goods receipt inspections",
    state: ["answered"],
    says: [/GRN\/2026-27\/0005/],
    never: [/GRN\/2026-27\/0004/],
  },
  {
    kind: "ambiguity — several records, no guess",
    query: "where is sodium kept",
    state: ["choices"],
    minResults: 2,
    canonical: true,
  },
  {
    kind: "words with no meaning in Store",
    query: "the of and it",
    state: ["unsupported"],
    never: [/Macbook|MRF|GRN|PO\//],
  },
  {
    kind: "permission — no Store grant",
    query: "stock of macbook",
    actor: "outsider",
    state: ["unauthorised"],
    never: [/Macbook/],
  },
  {
    kind: "cross-tenant denial",
    query: "stock of macbook",
    actor: "other_company",
    state: ["answered", "choices", "no_match", "unsupported"],
    /* Whatever it says, it cannot be THIS company's records. */
    never: [/Macbook|MRF-2605|GRN\/2026-27/],
  },
];

async function run() {
  const { MongoMemoryReplSet } = require("mongodb-memory-server");
  const service = require("../../services/ai/storeCommandSearch.service");
  const fixtures = require("../../test/support/storeCommandFixtures");

  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  await mongoose.connect(replSet.getUri(), { dbName: "store_command_audit" });

  const results = [];
  try {
    const store = await fixtures.seedStore();
    /* A second item whose name also contains "sodium", so the ambiguity case
       is a real one rather than an artefact of a single record. */
    await mongoose.connection.collection("rawitems").insertOne({
      _id: fixtures.oid(), companyId: store.companyId, name: "Sodium Hydroxide Flake",
      sku: "SODIUM-FLAKE", quantity: 7, unit: "Kg", variants: [], deletedAt: null,
      createdAt: new Date(), updatedAt: new Date(),
    });

    const reader = fixtures.storeReaderFor(store.companyId);
    const outsider = fixtures.storeReaderFor(store.companyId);
    outsider.applicationAccess.store.allowed = false;
    const otherCompany = fixtures.storeReaderFor(fixtures.oid());
    const actors = { reader, outsider, other_company: otherCompany };

    for (const probe of CASES) {
      const user = actors[probe.actor || "reader"];
      // eslint-disable-next-line no-await-in-loop
      const out = await service.search({ user, query: probe.query });
      const rows = (out.groups || []).flatMap((group) => group.results);
      const spoken = [out.note || "", ...rows.map((row) => row.title || "")].join(" || ");
      const failures = [];

      if (!probe.state.includes(out.state)) {
        failures.push(`state ${out.state}, expected ${probe.state.join(" or ")}`);
      }
      for (const pattern of probe.says || []) {
        if (!pattern.test(spoken)) failures.push(`never said ${pattern}`);
      }
      for (const pattern of probe.never || []) {
        if (pattern.test(spoken)) failures.push(`said ${pattern}, which it must not`);
      }
      if (probe.minResults && rows.length < probe.minResults) {
        failures.push(`offered ${rows.length} rows, expected at least ${probe.minResults}`);
      }
      if (probe.canonical) {
        for (const row of rows) {
          if (!/^[A-Za-z0-9_-]{1,100}$/.test(row.resolve?.recordId || "")) {
            failures.push("offered a choice with no canonical id");
          }
          if (row.resolve && JSON.stringify(row.resolve).includes(row.title)) {
            failures.push("a choice carries its own label back to the server");
          }
        }
      }
      results.push({ kind: probe.kind, query: probe.query, state: out.state, spoken, failures });
    }
  } finally {
    await mongoose.disconnect();
    await replSet.stop();
  }
  return results;
}

async function main() {
  const results = await run();
  const failed = results.filter((row) => row.failures.length);
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2)}\n`);
  } else {
    const line = (s = "") => process.stdout.write(`${s}\n`);
    line();
    line("Store command-search behaviour — real sentences, seeded records");
    line();
    for (const row of results) {
      line(`   ${row.failures.length ? "FAILED  " : "ok      "}${row.kind}`);
      line(`             "${row.query}" → ${row.state}`);
      for (const why of row.failures) line(`             ${why}`);
    }
    line();
    line(`   ${results.length - failed.length} of ${results.length} kinds of question behave correctly.`);
    if (failed.length) line("   FAILED: a question of a supported kind is answered wrongly or not at all.");
    line();
  }
  process.exitCode = failed.length ? 1 : 0;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { CASES, run };
