// scripts/audits/ie-order-readiness-audit.js
//
// IE CHUNK 1C — CAN THE REAL DATA SUPPORT AN ORDER-WISE IE LANDING PAGE?
//
// ── STRICTLY READ-ONLY ──────────────────────────────────────────────────────
// This script has no create, save, update, delete, backfill or reconcile path,
// and it takes no `--apply` flag because there is nothing to apply. It opens
// the connection, counts, and disconnects. If it ever needs to change a record
// it is the wrong script.
//
// ── AND IT PRINTS NOTHING CONFIDENTIAL ──────────────────────────────────────
// Totals, percentages and internal work-order references only. No connection
// string, no customer or buyer, no email or phone, no enquiry or journey, no
// quotation, no price, cost, margin, payment, invoice, salary or wage. Company
// identities are reduced to opaque labels (`company-1`, `company-2`) because
// the question is HOW MANY companies an order reaches, never which.
//
// ── IT ASKS THE ENDPOINT'S OWN QUESTION ─────────────────────────────────────
// Classification is `services/industrialEngineering/ieOrderAudit.js`, which
// calls the accepted `resolveOrderLine` from the Chunk 1B service unchanged. An
// audit with its own opinion of the rules would report coverage the endpoint
// cannot deliver, which is worse than no audit at all.
//
//   node scripts/audits/ie-order-readiness-audit.js
//   node scripts/audits/ie-order-readiness-audit.js --json   # machine-readable
"use strict";

require("dotenv").config({ quiet: true });
const mongoose = require("mongoose");

const {
  COMPANY_ATTRIBUTION, STYLE_LINK_STATUS, STATUS_CLASS, classifyOrder,
} = require("../../services/industrialEngineering/ieOrderAudit");
const routeComparison = require("../../services/industrialEngineering/routeComparison");
const {
  styleOwnerFrom,
} = require("../../services/companyContext/merchandisingScope.service");
const { OWNERSHIP_MODE } = require("../../services/industrialEngineering/ieOrders.service");
const { styleLifecycleOf } = require("../../services/industrialEngineering/styleLifecycle");
const ieRead = require("../../services/industrialEngineering/ieRead.service");

const AS_JSON = process.argv.includes("--json");
const str = (v) => String(v ?? "").trim();
const pct = (n, d) => (d > 0 ? Number(((n / d) * 100).toFixed(2)) : null);

/** Counts that start at zero for every declared key, so a zero is a measured
 *  zero rather than a key nobody wrote. */
const tally = (keys) => Object.fromEntries(keys.map((k) => [k, 0]));

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error(JSON.stringify({
      verdict: "AUDIT_BLOCKED",
      reason: "MONGODB_URI is not set in this environment. Refusing to guess a database.",
      command: "node scripts/audits/ie-order-readiness-audit.js",
    }, null, 2));
    process.exit(2);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  const startedAt = new Date();

  const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
  const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
  const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
  const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
  const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
  const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");

  /* ── 1. COMPANY OWNERSHIP OF EVERY STYLE ────────────────────────────────
     The ACCEPTED rule, via the shared `styleOwnerFrom` — the same four clauses
     `styleOwnershipClause` carries as a query. An earlier version of this
     audit re-derived it and got a different answer: it fell back to an enquiry
     when a journey was named but unprovable, and it ignored `isActive` and the
     terminal statuses entirely. Both are now impossible, because there is only
     one statement of the rule and this reads it.

     Only `companyId` is read off the parents. No journey reference, enquiry
     number, title or account is selected, so none can leak. */
  const [journeys, enquiries] = await Promise.all([
    SalesJourney.find({}).select("_id companyId").lean(),
    Enquiry.find({}).select("_id companyId").lean(),
  ]);
  const journeyCompany = new Map(journeys.map((j) => [str(j._id), str(j.companyId)]));
  const enquiryCompany = new Map(enquiries.map((e) => [str(e._id), str(e.companyId)]));

  const styles = await SampleStyle.find({})
    .select("_id journeyId enquiryId isActive status production.workOrderIds techSheet.technical.status techSheet.technical.operations sourceStockItemId production.stockItemId")
    .lean();

  /* Opaque labels. The audit needs to count companies, never to name one. */
  const companyLabels = new Map();
  const labelFor = (companyId) => {
    const key = str(companyId);
    if (!key) return null;
    if (!companyLabels.has(key)) companyLabels.set(key, `company-${companyLabels.size + 1}`);
    return companyLabels.get(key);
  };

  const styleCompany = new Map();
  const knownStyleIds = new Set();
  /* ── LANE A — TWO DIFFERENT QUESTIONS, COUNTED SEPARATELY ───────────────
     `ownershipProvable` uses IE's status-independent mode: parentage alone,
     which is what decides whether a work order is visible. `merchandisingQueue`
     uses the default, which additionally excludes inactive and terminal styles.
     A style can be the first without being the second, and before Lane A the
     endpoint conflated them — which is how six of the seven orders whose style
     references AGREED were refused because the style behind them was closed.

     `unprovableParentage` is the only genuine ownership fault. Terminal and
     inactive are reported as RETAINED for IE, not as exclusions. */
  const styleEligibility = {
    scanned: 0,
    ownershipProvable: 0,
    merchandisingQueueEligible: 0,
    retainedTerminalStatus: 0,
    retainedInactive: 0,
    unprovableParentage: 0,
  };
  const unprovableReasons = {};
  for (const style of styles) {
    knownStyleIds.add(str(style._id));
    styleEligibility.scanned += 1;

    const parents = {
      journeyCompanyOf: (id) => journeyCompany.get(id) || null,
      enquiryCompanyOf: (id) => enquiryCompany.get(id) || null,
    };
    /* The IE answer — the one the visibility figures are built from. */
    const owner = styleOwnerFrom(style, parents, OWNERSHIP_MODE);
    /* And the Merchandising answer, reported beside it so the difference is
       visible rather than inferred. */
    const queue = styleOwnerFrom(style, parents);

    if (queue.companyId) styleEligibility.merchandisingQueueEligible += 1;

    if (owner.companyId) {
      styleEligibility.ownershipProvable += 1;
      styleCompany.set(str(style._id), labelFor(owner.companyId));
      const lifecycle = styleLifecycleOf(style, null);
      if (!lifecycle.recordActive) styleEligibility.retainedInactive += 1;
      else if (lifecycle.historical) styleEligibility.retainedTerminalStatus += 1;
      continue;
    }
    styleEligibility.unprovableParentage += 1;
    unprovableReasons[owner.reason] = (unprovableReasons[owner.reason] || 0) + 1;
  }
  const companyOf = (styleId) => styleCompany.get(str(styleId)) || null;

  /* style id → the work orders it names directly. */
  const directByOrder = new Map();
  let duplicateWorkOrderIdsWithinStyle = 0;
  for (const style of styles) {
    const ids = (style.production?.workOrderIds || []).map(str).filter(Boolean);
    if (new Set(ids).size !== ids.length) duplicateWorkOrderIdsWithinStyle += 1;
    for (const orderId of new Set(ids)) {
      if (!directByOrder.has(orderId)) directByOrder.set(orderId, []);
      directByOrder.get(orderId).push(str(style._id));
    }
  }

  /* ── 2. THE ORDERS, AND THE REQUESTS THEY NAME ──────────────────────── */
  const orders = await WorkOrder.find({})
    .select("_id workOrderNumber status stockItemId customerRequestId sampleStyleId")
    .lean();
  const orderIds = new Set(orders.map((o) => str(o._id)));

  /* ── A STYLE NAMING A WORK ORDER THAT IS NOT THERE ────────────────────
     A dangling direct reference. Counted separately from "no reference at
     all", because the two need different answers: one is an order nobody
     linked, the other is a link to an order somebody removed. */
  let danglingDirectReferences = 0;
  let stylesWithDanglingDirect = 0;
  for (const [orderId, styleIds] of directByOrder.entries()) {
    if (orderIds.has(orderId)) continue;
    danglingDirectReferences += 1;
    stylesWithDanglingDirect += styleIds.length;
  }
  const stylesNamingAnyOrder = styles.filter(
    (s) => (s.production?.workOrderIds || []).length > 0,
  ).length;

  const requestIds = [...new Set(orders.map((o) => str(o.customerRequestId)).filter(Boolean))]
    .filter((v) => mongoose.Types.ObjectId.isValid(v));
  /* Line structure only. The request also holds the customer, the quotation
     and the payments; none of that is selected, so none of it can be printed. */
  const requests = requestIds.length
    ? await CustomerRequest.find({ _id: { $in: requestIds } })
      .select("_id sampleStyleId items.stockItemId items.sampleStyleId").lean()
    : [];
  const requestById = new Map(requests.map((r) => [str(r._id), r]));

  const stockItemIds = [...new Set(orders.map((o) => str(o.stockItemId)).filter(Boolean))]
    .filter((v) => mongoose.Types.ObjectId.isValid(v));
  const presentStockItems = new Set(
    (stockItemIds.length
      ? await StockItem.find({ _id: { $in: stockItemIds } }).select("_id").lean()
      : []).map((s) => str(s._id)),
  );

  /* ── 3. CLASSIFY ─────────────────────────────────────────────────────── */
  const byStatus = tally(Object.values(STATUS_CLASS));
  const attribution = tally(Object.values(COMPANY_ATTRIBUTION));
  const linkStatus = tally(Object.values(STYLE_LINK_STATUS));
  const operational = {
    total: 0,
    ...tally(Object.values(COMPANY_ATTRIBUTION)),
    ...tally(Object.values(STYLE_LINK_STATUS)),
    visible: 0,
    visibleWithAStyle: 0,
    visibleWithNoStyle: 0,
  };
  const flags = {};
  const bump = (key) => { flags[key] = (flags[key] || 0) + 1; };

  /* ── IE CHUNK 1D — HOW MUCH OF THE REGISTER CARRIES THE CANONICAL LINK ──
     Counted apart from the legacy paths, because "the contract is in place"
     and "an old record happens to be reachable" are different facts and only
     the first is progress. No backfill is authorised, so every existing
     record is expected here as legacy; the figures say whether NEW orders are
     arriving with the link. */
  const linkage = {
    canonicalOnly: 0,
    canonicalAgreeingWithLegacy: 0,
    legacyDirectOnly: 0,
    legacyRequestLineOnly: 0,
    legacyBothAgree: 0,
    conflicting: 0,
    none: 0,
    canonicalPresentButInvalid: 0,
  };
  const operationalLinkage = { visibleViaCanonical: 0, unresolved: 0 };

  const classified = [];
  for (const order of orders) {
    const out = classifyOrder({
      order,
      request: requestById.get(str(order.customerRequestId)) || null,
      directStyleIds: directByOrder.get(str(order._id)) || [],
      companyOf,
      knownStyleIds,
    });
    /* A product reference pointing at nothing is its own fault, distinct from
       naming no product at all. */
    if (str(order.stockItemId) && !presentStockItems.has(str(order.stockItemId))) {
      out.flags = [...new Set([...out.flags, "MISSING_STOCK_ITEM_RECORD"])].sort();
    }
    classified.push(out);

    byStatus[out.statusClass] += 1;
    attribution[out.companyAttribution] += 1;
    linkStatus[out.styleLinkStatus] += 1;
    for (const flag of out.flags) bump(flag);

    const legacySources = out.directStyleCount + out.lineStyleCount;
    if (out.styleLinkStatus === STYLE_LINK_STATUS.REFERENCES_CONFLICT) linkage.conflicting += 1;
    else if (out.hasCanonicalLink) {
      if (legacySources) linkage.canonicalAgreeingWithLegacy += 1;
      else linkage.canonicalOnly += 1;
      /* A canonical id naming no live, ownable style — the fault the write
         path refuses, counted here in case an older record ever shows one. */
      if (out.companyAttribution === COMPANY_ATTRIBUTION.NO_COMPANY_PROOF) {
        linkage.canonicalPresentButInvalid += 1;
      }
    } else if (out.directStyleCount && out.lineStyleCount) linkage.legacyBothAgree += 1;
    else if (out.directStyleCount) linkage.legacyDirectOnly += 1;
    else if (out.lineStyleCount) linkage.legacyRequestLineOnly += 1;
    else linkage.none += 1;

    if (out.statusClass === STATUS_CLASS.OPERATIONAL) {
      operational.total += 1;
      operational[out.companyAttribution] += 1;
      operational[out.styleLinkStatus] += 1;
      if (out.visibleToOneCompany) {
        operational.visible += 1;
        if (out.displayableStyles > 0) operational.visibleWithAStyle += 1;
        else operational.visibleWithNoStyle += 1;
        if (out.hasCanonicalLink) operationalLinkage.visibleViaCanonical += 1;
      } else {
        operationalLinkage.unresolved += 1;
      }
    }
  }

  /* ── 4. THE ENGINEERING BEHIND THE LINKED STYLES ─────────────────────── */
  const linkedStyleIds = [...new Set(
    classified.filter((c) => c.visibleToOneCompany).flatMap((c) => c.referencedStyleIds),
  )].filter((sid) => knownStyleIds.has(sid));

  const styleById = new Map(styles.map((s) => [str(s._id), s]));
  const productRoutes = await ieRead.productRoutesFor(
    linkedStyleIds.map((sid) => styleById.get(sid)).filter(Boolean),
  );
  const projected = new Map();
  const codes = new Set();
  for (const sid of linkedStyleIds) {
    const style = styleById.get(sid);
    if (!style) continue;
    const parts = ieRead.projectRoutes(style, productRoutes.get(sid));
    projected.set(sid, parts);
    for (const code of ieRead.codesUsedBy(parts)) codes.add(code);
  }
  const duplicated = await ieRead.duplicateCodes(codes);

  const engineering = {
    linkedStyles: linkedStyleIds.length,
    withNoRoute: 0,
    samIncomplete: 0,
    samComplete: 0,
    duplicateOperationCodeAmbiguity: 0,
    comparison: tally(routeComparison.STATES),
  };
  for (const sid of linkedStyleIds) {
    const parts = projected.get(sid);
    if (!parts) continue;
    const assembled = ieRead.assemble(
      styleById.get(sid), parts, ieRead.ownDuplicates(parts, duplicated),
    );
    engineering.comparison[assembled.comparison.state] += 1;
    if (assembled.comparison.state === routeComparison.STATE.NO_ROUTE) engineering.withNoRoute += 1;
    if (assembled.comparison.reason === "OPERATION_CODE_NOT_UNIQUE") {
      engineering.duplicateOperationCodeAmbiguity += 1;
    }
    if (assembled.technical.present && assembled.technical.samComplete) engineering.samComplete += 1;
    else engineering.samIncomplete += 1;
  }

  /* ── 5. THE VERDICT ──────────────────────────────────────────────────── */
  const opDenominator = operational.total;
  const visiblePct = pct(operational.visible, opDenominator);
  const blocking = {
    operationalWithoutOneCompany: opDenominator - operational.visible,
    operationalMultipleCompanies: operational[COMPANY_ATTRIBUTION.MULTIPLE_COMPANIES],
    operationalReferencesConflict: operational[STYLE_LINK_STATUS.REFERENCES_CONFLICT],
    operationalSilentlyAbsent: opDenominator - operational.visible,
  };
  const fullyReady = opDenominator > 0
    && blocking.operationalWithoutOneCompany === 0
    && blocking.operationalMultipleCompanies === 0
    && blocking.operationalReferencesConflict === 0;
  const verdict = fullyReady
    ? "READY_FOR_ORDER_WISE_FRONTEND"
    : (operational.visible > 0
      ? "READY_WITH_EXPLICIT_PARTIAL_COVERAGE"
      : "NOT_READY_FOR_ORDER_WISE_FRONTEND");

  const report = {
    verdict,
    audit: {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      /* A safe identifier — the database NAME only. Never the host, never the
         connection string, never credentials. */
      database: mongoose.connection.db.databaseName,
      nodeEnv: process.env.NODE_ENV || "(unset)",
      readOnly: true,
    },
    population: {
      workOrdersScanned: orders.length,
      sampleStylesScanned: styles.length,
      customerRequestsInspectedAsJoins: requests.length,
      customerRequestsNamedByOrders: requestIds.length,
      salesJourneysRead: journeys.length,
      enquiriesRead: enquiries.length,
    },
    status: { ...byStatus, denominator: orders.length },
    companyAttribution: { ...attribution, denominator: orders.length },
    styleLink: { ...linkStatus, denominator: orders.length },
    operational: { ...operational, denominator: opDenominator, visiblePercent: visiblePct },
    linkage: { ...linkage, denominator: orders.length },
    operationalLinkage: { ...operationalLinkage, denominator: opDenominator },
    dataQualityFlags: Object.fromEntries(Object.entries(flags).sort(([a], [b]) => a.localeCompare(b))),
    styleOwnership: {
      sampleStylesScanned: styleEligibility.scanned,
      /* Lane A: what IE uses. Lifecycle-independent. */
      ownershipProvable: styleEligibility.ownershipProvable,
      /* What an active Merchandising queue would hold — reported for contrast,
         never used to decide IE visibility. */
      merchandisingQueueEligible: styleEligibility.merchandisingQueueEligible,
      retainedTerminalStatus: styleEligibility.retainedTerminalStatus,
      retainedInactive: styleEligibility.retainedInactive,
      unprovableParentage: styleEligibility.unprovableParentage,
      unprovableReasons,
      duplicateWorkOrderIdsWithinStyle,
      stylesNamingAnyWorkOrder: stylesNamingAnyOrder,
      danglingDirectWorkOrderReferences: danglingDirectReferences,
      styleRowsHoldingADanglingReference: stylesWithDanglingDirect,
    },
    engineering,
    /* Lane A, said in the report itself: terminal status affects Merchandising
       work queues and no longer erases IE order ownership. */
    ownershipPolicy: {
      mode: "STATUS_INDEPENDENT",
      note: "Company ownership is permanent record provenance. Lifecycle status controls queue "
        + "participation, not ownership: completed, cancelled and archived styles still prove "
        + "which company a work order belongs to, and are retained in IE order history. Active "
        + "Merchandising work queues continue to exclude them.",
    },
    blocking,
    companiesObserved: companyLabels.size,
  };

  if (AS_JSON) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
  await mongoose.disconnect();
  return report;
}

main().catch(async (err) => {
  /* Non-secret failure reason only — never the URI, never the stack's env. */
  console.error(JSON.stringify({
    verdict: "AUDIT_BLOCKED",
    reason: `${err.name}: ${String(err.message).slice(0, 200)}`,
    command: "node scripts/audits/ie-order-readiness-audit.js",
  }, null, 2));
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
