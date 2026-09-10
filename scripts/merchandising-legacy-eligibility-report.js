// scripts/merchandising-legacy-eligibility-report.js
//
// LEGACY ELIGIBILITY AND RECONCILIATION REPORT — read-only, and only that.
//
// It looks at every confirmed CustomerRequest line that predates the M1
// Sales → Merchandising handover and reports, per line, whether the frozen B1
// evidence is exactly provable. It connects, reads, counts and prints. There
// is no `--apply`, no `--authorized-by`, no batch identity and no rollback
// identity, because there is nothing here that could write.
//
// ── WHY THIS IS A REPORT AND NOT A MIGRATION ────────────────────────────────
// It was written as a migration with a dry-run default and an `--apply` mode
// that refused to do anything, and a rollback identity for writes it could
// not perform. That is a tool describing itself as more dangerous and more
// capable than it is, and both halves are their own problem: nobody can tell
// from the outside that `--apply` is inert, and a rollback identity implies a
// rollback exists.
//
// The reason it could never write is not an implementation gap, it is the
// delivery contract. An Execution File exists only as the consequence of an
// ACCEPTED handover version, and a handover version requires a Sales-authored
// `committedDeliveryDate` on every delivery drop. No legacy CustomerRequest
// carries a delivery date in any field — verified against the schema — so
// creating one would mean inventing the single date the whole downstream plan
// is anchored to. That is not a migration anybody could authorise; it is a
// commitment only a person can make.
//
// So the honest tool is this one: it tells you which lines are ready for a
// salesperson to issue, and exactly what is missing from the rest. Issuing is
// then done where it belongs — on the order screen, by somebody with the
// authority to promise a date.
//
// ── THE SEPARATE UTILITY THAT DOES WRITE ────────────────────────────────────
// `scripts/backfill-customer-request-line-refs.js` gives existing order lines
// their permanent Sales line reference. That one has a real, bounded,
// Sales-owned write and a real apply mode, and it is kept separate precisely
// so the difference is visible from the command line.
//
// Usage:
//   node scripts/merchandising-legacy-eligibility-report.js
//   node scripts/merchandising-legacy-eligibility-report.js --json

"use strict";

require("dotenv").config();
const mongoose = require("mongoose");

const CustomerRequest = require("../models/Customer_Models/CustomerRequest");
const SampleStyle = require("../models/CMS_Models/Sales/SampleStyle");
const SalesJourney = require("../models/CMS_Models/Sales/SalesJourney");
const Enquiry = require("../models/CMS_Models/Sales/Enquiry");
const SalesHandoverVersion = require("../models/CMS_Models/Sales/SalesHandoverVersion");
const ExecutionFile = require("../models/CMS_Models/Merchandising/ExecutionFile");

const producer = require("../services/sales/merchandisingHandover.service");
/* Tenancy, not costing. See services/integration/styleOwnershipProof.service.js. */
const { ownershipProofFor } = require("../services/integration/styleOwnershipProof.service");

const str = (v) => String(v ?? "").trim();

/* ── The frozen B1 evidence conditions, each with its own exclusion bucket ──
   The first group reuses the producer's own `lineBlockers`, so the report can
   never drift from what issuance would actually refuse. The rest are the
   report's additional questions. */
const EXCLUSIONS = [
  "NOT_CONFIRMED",              // Sales state before quotation_sales_approved
  "NOT_A_CUSTOMER_ORDER",       // internal order — no buyer commitment
  "NO_LINE_REFERENCE",          // predates permanent line identity — backfill
  "NO_SELECTED_STYLE",          // line references no SampleStyle
  "STYLE_INACTIVE",
  "HOUSE_SAMPLE",
  "NO_QUANTITY",
  "VARIANT_UNRESOLVED",         // competing style attempt not resolved
  "NO_PO_OR_CONTRACT_PROOF",    // accepted PO/contract commitment not provable
  "COMPANY_CHAIN_UNPROVABLE",   // no parent proves a company
  "NO_COMMITTED_DELIVERY_DATE", // the record holds no Sales-authored date
  "ALREADY_HANDED_OVER",        // the M1 path already owns this line
];

function parseArgs(argv) {
  const args = { json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else {
      console.error(
        `Unknown argument: ${a}\n`
        + "This is a read-only report. It takes only --json.\n"
        + "To give existing order lines their permanent Sales line reference, use\n"
        + "  node scripts/backfill-customer-request-line-refs.js",
      );
      process.exit(2);
    }
  }
  return args;
}

/** Which company this style's parent chain proves, if any — reusing the frozen
 *  proof rather than re-deriving it. */
async function provableCompanyFor(style) {
  let candidate = null;
  if (style.journeyId) {
    const j = await SalesJourney.findOne(
      mongoose.Types.ObjectId.isValid(style.journeyId)
        ? { _id: style.journeyId } : { journeyId: str(style.journeyId) },
    ).select("companyId").lean();
    if (j?.companyId) candidate = str(j.companyId);
  }
  if (!candidate && style.enquiryId) {
    const e = await Enquiry.findOne(
      mongoose.Types.ObjectId.isValid(style.enquiryId)
        ? { _id: style.enquiryId } : { enquiryId: str(style.enquiryId) },
    ).select("companyId").lean();
    if (e?.companyId) candidate = str(e.companyId);
  }
  if (!candidate) return null;
  const proof = await ownershipProofFor(style, candidate);
  return proof ? candidate : null;
}

/** Is an accepted PO/contract commitment provable on this request?
 *  Provable means: the approved quotation carries a PO proof document or a PO
 *  number, or the request has moved into a physical execution state whose own
 *  gates already demanded the commitment. Nothing is inferred from a
 *  customer's quotation approval alone. */
function poProvable(request) {
  const quots = Array.isArray(request.quotations) ? request.quotations : [];
  const anyProof = quots.some((q) => q?.poProof
    && (str(q.poProof.url) || str(q.poProof.fileId) || str(q.poProof.poNumber)));
  if (anyProof) return true;
  return ["production", "shipping", "delivered", "completed"].includes(str(request.status));
}

async function main() {
  const args = parseArgs(process.argv);

  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");

  const counts = Object.fromEntries(EXCLUSIONS.map((k) => [k, 0]));
  const exceptions = [];   // rows excluded, with every reason
  const issuable = [];     // rows a salesperson can hand over today

  const query = { status: { $in: producer.CONFIRMED_STATUSES } };
  const requests = CustomerRequest.find(query)
    .select("requestId status orderOrigin items quotations updatedAt")
    .lean().cursor();

  let lines = 0;
  for await (const request of requests) {
    for (const item of request.items || []) {
      lines += 1;
      const reasons = [];

      const style = str(item.sampleStyleId)
        ? await SampleStyle.findById(item.sampleStyleId)
          .select("sampleStyleId styleCode productName variantChosen sampleType isActive journeyId enquiryId")
          .lean()
        : null;

      /* Exactly what issuance itself would refuse, asked of the same code. */
      for (const b of await producer.lineBlockers(request, item, style)) reasons.push(b.code);

      if (!poProvable(request)) reasons.push("NO_PO_OR_CONTRACT_PROOF");

      let companyId = null;
      if (style) {
        companyId = await provableCompanyFor(style);
        if (!companyId) reasons.push("COMPANY_CHAIN_UNPROVABLE");
      }

      /* The delivery commitment. No legacy field could hold one, so this
         excludes every legacy line — which is the finding, not a bug. */
      reasons.push("NO_COMMITTED_DELIVERY_DATE");

      if (companyId && str(item.lineRef)) {
        const existing = await SalesHandoverVersion.findOne({
          companyId, handoverRef: str(request.requestId), handoverLineRef: str(item.lineRef),
        }).select("_id").lean();
        if (existing) reasons.push("ALREADY_HANDED_OVER");
      }

      const row = {
        requestRef: str(request.requestId),
        lineRef: str(item.lineRef) || null,
        styleId: str(item.sampleStyleId) || null,
        product: str(item.stockItemName),
        quantity: Number(item.totalQuantity) || 0,
        companyId: companyId || null,
      };
      const unique = [...new Set(reasons)];
      for (const r of unique) counts[r] += 1;

      /* ── "ISSUABLE TODAY" IS THE USEFUL ANSWER ────────────────────────
         Every legacy line lacks a committed delivery date, so a report of
         what is migratable would always read zero and say nothing. What a
         salesperson can act on is the line where the ONLY thing missing is
         the date they are about to author. */
      if (unique.length === 1 && unique[0] === "NO_COMMITTED_DELIVERY_DATE") issuable.push(row);
      else exceptions.push({ ...row, excludedBecause: unique });
    }
  }

  const report = {
    mode: "read-only report",
    confirmedRequestsScanned: await CustomerRequest.countDocuments(query),
    orderLinesExamined: lines,
    issuableBySalesToday: issuable.length,
    issuable,
    exclusionCounts: counts,
    exceptions,
    existingM1Records: {
      handoverVersions: await SalesHandoverVersion.countDocuments({}),
      executionFiles: await ExecutionFile.countDocuments({}),
    },
    finding: "No legacy CustomerRequest carries a Sales-authored committedDeliveryDate, "
      + "so no Execution File can be created from history without inventing the one date "
      + "the whole downstream plan is anchored to. Lines listed under `issuable` need only "
      + "that commitment: an authorised Sales user issues them on the order screen, "
      + "authoring the date as they do.",
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("\nMerchandising legacy eligibility report (read-only)");
    console.log(`  Confirmed requests scanned : ${report.confirmedRequestsScanned}`);
    console.log(`  Order lines examined       : ${report.orderLinesExamined}`);
    console.log("  Exclusions by condition:");
    for (const [k, v] of Object.entries(counts)) {
      if (v) console.log(`    ${k.padEnd(28)} ${v}`);
    }
    console.log(`\n  Ready for Sales to issue today: ${issuable.length}`);
    for (const e of issuable.slice(0, 20)) {
      console.log(`    ${e.requestRef}  ${e.product}  x${e.quantity}`);
    }
    if (issuable.length > 20) console.log(`    ... and ${issuable.length - 20} more (use --json for all)`);
    console.log(`\n  Existing M1 records: ${report.existingM1Records.handoverVersions} versions, `
      + `${report.existingM1Records.executionFiles} files (read, never written)\n`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Report failed:", err?.message || err);
  process.exit(1);
});
