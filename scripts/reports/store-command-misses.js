#!/usr/bin/env node
"use strict";
/**
 * scripts/reports/store-command-misses.js — the weekly look at what people
 * typed into Cmd/Ctrl K that it could not answer.
 *
 * READ-ONLY. Lists the most-typed unanswered searches (anonymous, kept 90
 * days — see models/CMS_Models/AI/CommandSearchMiss.js) and for each says:
 *
 *   now answered      a word added since makes it work — nothing to do
 *   suggestion        with --suggest, what the local qwen3:8b thinks it means,
 *                     written as the sentence Ctrl K would answer, and ONLY if
 *                     that suggestion survives the router contract (closed
 *                     names, nothing dropped, nothing invented). A person
 *                     decides; nothing is changed by this script.
 *   needs a person    no safe suggestion — a decision ("open POs"), a new kind
 *                     of question ("why…"), or a word nobody can map
 *
 * Approved words go into services/ai/storeVocabulary.js, with when and why,
 * and the Store suites run with them.
 *
 *   node scripts/reports/store-command-misses.js [--app store|accounting|hr] [--company <id>] [--limit 30] [--suggest]
 *
 * Loads the Store capabilities only — not the assistant — so no model client
 * and no other application's start-up code runs against the database.
 */

const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
require("dotenv").config({ path: path.join(ROOT, ".env"), quiet: true });
const mongoose = require("mongoose");

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 && process.argv[at + 1] && !process.argv[at + 1].startsWith("--") ? process.argv[at + 1] : fallback;
};

/* READ-ONLY, for every app: the accounting voucher model reconciles its
   indexes when the connection opens (an updateMany and an index check), and
   Store's capabilities load it too — found on 9 Oct 2026 when a Store-only
   probe recorded 3 writes (0 documents changed, but writes all the same).
   Exactly that listener is left out while models load — which only works
   BEFORE the connection opens (main() loads everything first); on an open
   connection the model runs it immediately. */
function withoutVoucherReconcile(load) {
  const realOnce = mongoose.connection.once;
  mongoose.connection.once = function once(event, fn) {
    return event === "open" && fn?.name === "ensureVoucherIndexes" ? this : realOnce.call(this, event, fn);
  };
  try {
    return load();
  } finally {
    mongoose.connection.once = realOnce;
  }
}

/* ── STORE ── the capabilities as the palette loads them. */
async function storeRunner() {
  const service = withoutVoucherReconcile(() => require("../../services/ai/storeCommandSearch.service")); // eslint-disable-line global-require
  const { resolveCompanyForActor } = require("../../services/companyContext/companyMembership.service"); // eslint-disable-line global-require
  const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership"); // eslint-disable-line global-require
  const { CAPABILITIES } = require("../../services/storePurchase/capabilities"); // eslint-disable-line global-require
  const membership = await SpCompanyMembership.findOne({ isActive: true }).select("employeeRef").lean();
  const { companyId } = await resolveCompanyForActor(
    { id: String(membership?.employeeRef || "000000000000000000000000") },
    { domainLabel: "Store & Purchase", fail: (code, message) => new Error(message) },
  );
  const reader = () => ({
    id: "weekly-report",
    applicationAccess: { store: { allowed: true, capabilities: { read: true } } },
    storePurchaseAccess: { companyId, capabilities: [CAPABILITIES.READ], capabilitySet: new Set([CAPABILITIES.READ]) },
  });

  let suggest = null;
  if (process.argv.includes("--suggest")) {
    const { routerFromEnv } = require("../../services/ai/storeCommandRouter"); // eslint-disable-line global-require
    const contract = require("../../services/ai/storeCommandRouterContract"); // eslint-disable-line global-require
    const route = routerFromEnv({ STORE_COMMAND_ROUTER: "qwen", STORE_COMMAND_ROUTER_TIMEOUT_MS: "20000" });
    const tools = service.storeToolsFor(await service.resolveStoreActor(reader()));
    suggest = async (query) => {
      const menu = contract.menuFor(tools, query);
      try {
        const choice = await route({ message: query, menu });
        return contract.sentenceFor(contract.validate(choice, menu, query), {});
      } catch {
        return null;
      }
    };
  }
  return {
    label: "Store",
    rerun: (query) => service.search({ user: reader(), query }),
    suggest,
    footer: "Add approved words to services/ai/storeVocabulary.js (with when and why), then run the Store suites.",
  };
}

/* ── ACCOUNTING ── the books' own readers, for one company. A miss is kept
   without its company (only the words), so it is re-asked of --company, or of
   the books' primary company. */
async function accountingRunner() {
  const service = withoutVoucherReconcile(() => require("../../services/ai/accountingCommandSearch.service")); // eslint-disable-line global-require
  const db = mongoose.connection.db;
  const chosen = arg("company", null);
  const company = chosen
    ? { _id: chosen }
    : (await db.collection("acc_companies").findOne({ isPrimary: true })) || (await db.collection("acc_companies").findOne({}));
  if (!company) throw new Error("No accounting company to re-ask the misses of.");
  if (process.argv.includes("--suggest")) console.log("(--suggest is Store-only for now: the router's menu is built from Store's vocabulary.)");
  return {
    label: `Accounting (company ${company.companyName || company._id})`,
    rerun: (query) => service.search({ companyId: String(company._id), query }),
    suggest: null,
    footer: "Add approved words to the names in services/ai/accountingCommandContract.js, then run the accounting suites.",
  };
}

/* ── HR ── HR's own readers, re-asked with the widest HR role (owner), so a
   miss that any role could have had answered shows as answered. HR has no
   company. Read-only: nothing in HR's models writes when they load. */
async function hrRunner() {
  const service = withoutVoucherReconcile(() => require("../../services/ai/hrCommandSearch.service")); // eslint-disable-line global-require
  const { ROLE_TEMPLATES, DEPARTMENT_ROLE_TEMPLATE } = require("../../services/access/hrCapabilities"); // eslint-disable-line global-require
  const capabilities = new Set(ROLE_TEMPLATES[DEPARTMENT_ROLE_TEMPLATE.owner]);
  if (process.argv.includes("--suggest")) console.log("(--suggest is Store-only for now: the router's menu is built from Store's vocabulary.)");
  return {
    label: "HR",
    rerun: (query) => service.search({ capabilities, query }),
    suggest: null,
    footer: "Add approved words to the names in services/ai/hrCommandContract.js, then run the HR suites.",
  };
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not configured; refusing to guess a database.");
  const app = arg("app", "store");
  if (!["store", "accounting", "hr"].includes(app)) throw new Error(`--app must be store, accounting or hr, not "${app}".`);
  /* Load every search BEFORE connecting: the voucher model runs its reconcile
     at once when the connection is already open, so the guard only works while
     it is still closed (it waits for "open", and that listener is dropped). */
  withoutVoucherReconcile(() => {
    require("../../services/ai/storeCommandSearch.service"); // eslint-disable-line global-require
    require("../../services/ai/accountingCommandSearch.service"); // eslint-disable-line global-require
    require("../../services/ai/hrCommandSearch.service"); // eslint-disable-line global-require
  });
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 20000 });
  try {
    const { topMisses } = require("../../services/ai/commandSearchMisses"); // eslint-disable-line global-require
    const misses = await topMisses({ app, limit: Number(arg("limit", "30")) });
    if (!misses.length) {
      console.log(`\nNo unanswered ${{ store: "Store", accounting: "Accounting", hr: "HR" }[app]} searches recorded yet.\n`);
      return;
    }
    const runner = app === "store" ? await storeRunner() : app === "hr" ? await hrRunner() : await accountingRunner();

    console.log(`\nUnanswered ${runner.label} searches — most typed first (anonymous, kept 90 days)\n`);
    for (const miss of misses) {
      // eslint-disable-next-line no-await-in-loop
      const now = await runner.rerun(miss.query);
      const answered = ["answered", "choices"].includes(now.state);
      let verdict = answered ? "now answered" : "needs a person";
      if (!answered && runner.suggest) {
        // eslint-disable-next-line no-await-in-loop
        const sentence = await runner.suggest(miss.query);
        if (sentence) verdict = `suggestion: "${sentence}"`;
      }
      const seen = new Date(miss.lastSeenAt).toISOString().slice(0, 10);
      console.log(`  ${String(miss.count).padStart(4)}×  ${miss.query.padEnd(40)}  last ${seen}  ${verdict}`);
    }
    console.log(`\n${runner.footer}\n`);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { storeRunner, accountingRunner, hrRunner };
