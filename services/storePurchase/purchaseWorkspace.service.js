// services/storePurchase/purchaseWorkspace.service.js
//
// ONE PURCHASING READ: WHAT NEEDS SOURCING, WHAT IS DRAFTED, WHAT IS ON ORDER,
// AND WHAT IS FINISHED.
//
// ── WHY AN ADAPTER ──────────────────────────────────────────────────────────
// A buyer's question — "what do I have to do next" — is answered today by five
// separate registers: purchase orders, service orders, three kinds of supplier
// offer, and the sourcing-decision queue. Composing that in the browser means
// five requests whose partial failures the page has to reconcile, and a stage
// vocabulary reimplemented in JavaScript. So it is composed once, here.
//
// ── STAGE COMES FROM STORED STATUS, NEVER FROM A LABEL OR A DATE ────────────
// Each source's own status decides its stage. The mapping is written down in
// `docs/tasks/store-purchase-lane-a-purchase-a1.md` and mirrored in the tables
// below, so a reader can check one against the other.
//
// The single exception is offer EXPIRY, which no source stores: `SupplierOffer`
// says so itself — "expired is derived from `validUntil` against the clock, and
// the stored status stays a record of what somebody DID". So expiry travels as
// its own fact beside `exactStatus`, and an expired offer is never relabelled
// withdrawn.
//
// ── AND IT WRITES NOTHING ───────────────────────────────────────────────────
// No purchase, receipt, stock, payment or Accounting semantics change here. It
// does not recompute a pending receipt quantity — the purchase order's own
// stored line state is read as it stands — and it never derives receipt-control
// state, which belongs to Receive.

"use strict";

const mongoose = require("mongoose");

const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const ServiceOrder = require("../../models/CMS_Models/Inventory/Operations/ServiceOrder");
const SupplierOffer = require("../../models/CMS_Models/Inventory/Sourcing/SupplierOffer");
const ServiceSupplierOffer = require("../../models/CMS_Models/Inventory/Sourcing/ServiceSupplierOffer");
const FreightOffer = require("../../models/CMS_Models/Inventory/Sourcing/FreightOffer");
/* The approved purchasing demand that starts the whole chain. Read-only here:
   this adapter never writes a request, and never changes one's status. */

const tenantContext = require("./tenantContext.service");

/**
 * A company-scoped filter with a search folded in SAFELY.
 *
 * ── THE BUG THIS EXISTS TO PREVENT ──────────────────────────────────────────
 * `tenantFilter` returns an `$or` whenever legacy read-through is on — which is
 * the default. Assigning `filter.$or = [...search clauses]` on top of it
 * REPLACES the company clause, so the query keeps the status and drops the
 * tenancy: typing in the search box returned other companies' orders. Folding
 * both into `$and` keeps each one a separate, undisturbed condition.
 */
function scoped(tenant, base, ...orGroups) {
  const filter = { ...tenantContext.tenantFilter(tenant), ...base };
  const groups = orGroups.filter((g) => Array.isArray(g) && g.length);
  if (!groups.length) return filter;
  const tenancy = filter.$or;
  delete filter.$or;
  /* Each group stays its own condition. Two `$or`s assigned to one object
     would be one `$or`, and the narrower of them would simply vanish. */
  filter.$and = [
    ...(tenancy ? [{ $or: tenancy }] : []),
    ...groups.map((g) => ({ $or: g })),
  ];
  return filter;
}

/* The four adapter stages, including the legacy sourcing view retained for
   callers outside the Purchase Orders screen. */
const STAGE = Object.freeze({
  /* Every open stage at once (30 Sep 2026, the owner's default: "by default
     select for all"). Each source reads all of its stage statuses; the exact
     status filter then does the narrowing on its own. */
  ALL: "all",
  TO_SOURCE: "to-source",
  DRAFT: "draft-orders",
  ON_ORDER: "on-order",
  COMPLETED: "completed",
});
const STAGES = Object.freeze([STAGE.ALL, STAGE.TO_SOURCE, STAGE.DRAFT, STAGE.ON_ORDER, STAGE.COMPLETED]);

/* What is being bought. Freight is its own kind because a transporter's
   quotation is neither a material nor an outside service. */
const TYPE = Object.freeze({
  ALL: "all",
  MATERIAL: "material",
  SERVICE: "service",
  FREIGHT: "freight",
});
const TYPES = Object.freeze([TYPE.ALL, TYPE.MATERIAL, TYPE.SERVICE, TYPE.FREIGHT]);

const RECORD = Object.freeze({
  /* There is deliberately no `NEED` here. Approved demand is a pre-purchase
     record and does not belong in a workspace of purchasing records — see the
     note in `workspace()`. */
  MATERIAL_ORDER: "material-order",
  SERVICE_ORDER: "service-order",
  OFFER: "offer",
  DECISION: "decision",
});


/* ── THE STAGE MAPPING, FROM STORED STATUS ONLY ──────────────────────────────
   Read these beside §3 of the task document. A status absent from a table does
   not belong to any of the four tabs; `CLOSED_STATUS` lists those, and they are
   reachable through the explicit status filter rather than being folded into
   Completed. A cancelled order was not completed, and saying so in the one view
   a buyer trusts is worse than making them ask for it. */
const MATERIAL_STAGE = Object.freeze({
  DRAFT: STAGE.DRAFT,
  ISSUED: STAGE.ON_ORDER,
  PARTIALLY_RECEIVED: STAGE.ON_ORDER,
  COMPLETED: STAGE.COMPLETED,
});
const SERVICE_STAGE = Object.freeze({
  DRAFT: STAGE.DRAFT,
  ISSUED: STAGE.ON_ORDER,
  IN_PROGRESS: STAGE.ON_ORDER,
  /* The supplier says they are finished; the requesting department has not
     accepted. Live work, not a completed order. */
  COMPLETION_REPORTED: STAGE.ON_ORDER,
  /* A correction is outstanding, so the commercial relationship is open. */
  REWORK_REQUIRED: STAGE.ON_ORDER,
  ACCEPTED: STAGE.COMPLETED,
});
const OFFER_STAGE = Object.freeze({
  DRAFT: STAGE.DRAFT,
  /* An ACTIVE offer is a quotation still waiting to be chosen — the one thing
     `To source` exists for. An expired one is NOT: see `stageOfOffer`. */
  ACTIVE: STAGE.TO_SOURCE,
});
/* Kept out of every tab, searchable through `status=closed`. */
const CLOSED_STATUS = Object.freeze(["CANCELLED", "SUPERSEDED", "WITHDRAWN"]);

/**
 * The lifecycle axis, which CROSSES the stage tabs rather than sitting in them.
 *
 * ── WHY THERE IS NO "ALL" ───────────────────────────────────────────────────
 * A cancelled order has no stage: `CANCELLED` is in no stage map, because a
 * cancelled order is not drafted, not on order and certainly not completed. So
 * an "all" view could only include closed records by repeating every one of
 * them under all four tabs — which is exactly what it did. Closed records get
 * one view of their own instead, and `all` resolves forward to `open` so a link
 * already carrying it still opens something sensible.
 */
const STATUS_FILTER = Object.freeze({ OPEN: "open", CLOSED: "closed" });
const STATUS_FILTERS = Object.freeze([STATUS_FILTER.OPEN, STATUS_FILTER.CLOSED]);

/* One primary action per row, and each opens a workflow that already exists.
   Nothing here performs a mutation. */
const ACTION = Object.freeze({
  RECORD_DECISION: { code: "RECORD_DECISION", label: "Record sourcing decision" },
  REVIEW_DECISION: { code: "REVIEW_DECISION", label: "Review sourcing decision" },
  CONTINUE_DRAFT: { code: "CONTINUE_DRAFT", label: "Continue draft order" },
  ISSUE_ORDER: { code: "ISSUE_ORDER", label: "Issue order" },
  REVIEW_ORDER: { code: "REVIEW_ORDER", label: "Review active order" },
  RESOLVE_EXCEPTION: { code: "RESOLVE_EXCEPTION", label: "Resolve exception" },
  VIEW_COMPLETED: { code: "VIEW_COMPLETED", label: "View completed order" },
  REVIEW_OFFER: { code: "REVIEW_OFFER", label: "Review quotation" },
  /* The freight register, which has no per-quotation page to open. */
  OPEN_FREIGHT_REGISTER: { code: "OPEN_FREIGHT_REGISTER", label: "Open freight quotations" },
});

/* Bounded by default: every read is capped and the response says what it saw. */
const cap = (envName, fallback) => Math.max(1, parseInt(process.env[envName], 10) || fallback);
const ORDER_CAP = () => cap("PURCHASE_WORKSPACE_ORDER_CAP", 300);
const OFFER_CAP = () => cap("PURCHASE_WORKSPACE_OFFER_CAP", 200);
const DECISION_CAP = () => cap("PURCHASE_WORKSPACE_DECISION_CAP", 50);

const str = (v) => (typeof v === "string" ? v.trim() : "");
const rxOf = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const idOf = (v) => (v === null || v === undefined ? null : String(v));

/** Normalise whatever the URL carried into the closed vocabulary. */
/**
 * Where a legacy exact-status link should land when it names no stage.
 *
 * ── WHY THIS IS NOT JUST KEEPING THE WORD ───────────────────────────────────
 * `?status=ISSUED` links have been in circulation since the register existed.
 * Carrying the word forward but opening the default tab is not compatibility:
 * "To source" contains no issued orders, so the link that used to list them
 * now lists nothing and looks like the orders are gone. The status names the
 * stage it belongs to, so that is the stage the link opens.
 */
function inferredViewFor(poStatus) {
  if (!poStatus) return null;
  /* A cancelled order is in no stage at all — it belongs to the closed view,
     which crosses the tabs. */
  if (CLOSED_STATUS.includes(poStatus)) {
    return { stage: STAGE.TO_SOURCE, status: STATUS_FILTER.CLOSED };
  }
  const stage = MATERIAL_STAGE[poStatus];
  return stage ? { stage, status: STATUS_FILTER.OPEN } : null;
}

function readQuery(q = {}) {
  /* Whether the caller CHOSE a stage, as opposed to getting the default. An
     explicit stage always wins; the exact status then only narrows it. */
  const explicitStage = STAGES.includes(str(q.stage)) ? str(q.stage) : null;
  const explicitStatus = STATUS_FILTERS.includes(str(q.status)) ? str(q.status) : null;

  const type = TYPES.includes(str(q.type)) ? str(q.type) : TYPE.ALL;
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(q.pageSize, 10) || 25));

  /* ── TWO FILTERS THAT ONLY A MATERIAL ORDER CAN ANSWER ──────────────────
     A supplier id and an exact purchase-order status are fields on a purchase
     order. Nothing else in this workspace has them, so when either is asked
     for, only material orders can match — and that is applied HERE rather than
     in the page. Filtering in the browser would leave the value strip and the
     record count describing the stage before the filter, so the figures would
     report a different set from the rows under them.

     An unrecognised status — including the literal `all`, which used to mean
     "any status" — becomes NO filter rather than a filter nothing can match.
     A query for a status that does not exist would otherwise return an empty
     list that reads as "there are none". */
  const vendor = mongoose.isValidObjectId(str(q.vendor)) ? str(q.vendor) : "";
  const asked = str(q.poStatus);
  const poStatus = Object.prototype.hasOwnProperty.call(MATERIAL_STAGE, asked)
    || CLOSED_STATUS.includes(asked)
    ? asked
    : "";

  const inferred = explicitStage ? null : inferredViewFor(poStatus);
  const stage = explicitStage || inferred?.stage || STAGE.TO_SOURCE;
  /* A cancelled (or superseded, withdrawn) order is in no open stage. Asked
     for by exact status under any stage — the "all" stage above all — it is
     the closed view that holds it, so that is what is read, rather than an
     open read that can never match it. */
  const status = CLOSED_STATUS.includes(poStatus)
    ? STATUS_FILTER.CLOSED
    : (explicitStatus || inferred?.status || STATUS_FILTER.OPEN);
  const ordersOnly = str(q.records) === "orders";

  return {
    stage, type, status, search: str(q.search).slice(0, 200), page, pageSize,
    vendor, poStatus,
    /* So the page can tell whether a status it sent was honoured, and avoid
       showing a chip for a filter the server ignored. */
    poStatusApplied: Boolean(poStatus), ordersOnly,
    stageInferred: Boolean(inferred),
  };
}

/**
 * An offer's stage.
 *
 * Expiry is the one derived value in this service and it is derived here, once.
 * An ACTIVE offer past its `validUntil` is no longer something to source from —
 * but its STORED status is still ACTIVE, because that is what somebody did, and
 * the row reports both.
 */
function stageOfOffer(offer, asOf) {
  const expired = Boolean(offer.validUntil) && new Date(offer.validUntil) < asOf;
  if (offer.status === "ACTIVE" && expired) return { stage: null, expired: true };
  return { stage: OFFER_STAGE[offer.status] || null, expired };
}

/**
 * One material order as a workspace row.
 *
 * ── ONLY FIELDS THAT MEAN SOMETHING HERE ────────────────────────────────────
 * A material row carries an item line count and an expected delivery date. It
 * does not carry a service's billing unit or acceptance state, because those
 * are not facts about a material order and a blank column invites somebody to
 * read one into it.
 *
 * ── AND THE RECEIPT STATE IS READ, NEVER RECOMPUTED ─────────────────────────
 * `linesAwaitingReceipt` counts the order's OWN stored line statuses. Receive
 * owns the receiving workflow; this reports what the order already says.
 */
function materialRow(po, { exceptionsByPo = new Map() } = {}) {
  const items = Array.isArray(po.items) ? po.items : [];
  const stage = MATERIAL_STAGE[po.status] || null;
  const exception = exceptionsByPo.get(String(po._id)) || null;

  const action = exception ? ACTION.RESOLVE_EXCEPTION
    : po.status === "DRAFT" ? ACTION.CONTINUE_DRAFT
      : po.status === "COMPLETED" ? ACTION.VIEW_COMPLETED
        : ACTION.REVIEW_ORDER;

  return {
    id: idOf(po._id),
    recordType: RECORD.MATERIAL_ORDER,
    purchaseType: TYPE.MATERIAL,
    reference: po.poNumber || "",
    /* The order's own subject. Not a summed quantity — an order carrying
       metres and kilograms has no total, and printing one invites a division. */
    title: items.length === 1
      ? (items[0].itemName || "")
      : `${items.length} item${items.length === 1 ? "" : "s"}`,
    supplierLabel: po.vendorName || "",
    stage,
    /* The stored status, verbatim. A cancelled order says CANCELLED. */
    exactStatus: po.status,
    orderDate: po.orderDate || po.createdAt || null,
    /* Only when recorded. An invented date reads as a promise somebody made. */
    expectedDate: po.expectedDeliveryDate || null,
    lineCount: items.length,
    /* Stored line state, read as it stands. */
    linesAwaitingReceipt: items.filter(
      (i) => i.status === "PENDING" || i.status === "PARTIALLY_RECEIVED",
    ).length,
    totalAmount: num(po.totalAmount),
    /* Its own currency travels with its own amount. Two currencies are never
       added — see `summarise`. */
    currency: po.currency || "INR",

    /* ── THE STORED FACTS THE ROW'S OWN FEATURES RUN ON ────────────────────
       Read as they stand. Nothing here is recomputed: the receipt total is the
       order's own `totalReceived`, and the per-line quantities are the order's
       own. Receive owns the receiving workflow; this only reports what the
       purchase order already records. */
    paymentStatus: po.paymentStatus || null,
    totalReceived: num(po.totalReceived),
    /* Each line's own unit travels with its own quantity, so nothing
       downstream can add metres to kilograms. */
    items: items.map((i) => ({
      itemName: i.itemName || "",
      unit: i.unit || "",
      quantity: num(i.quantity),
      receivedQuantity: num(i.receivedQuantity),
      status: i.status || null,
    })),
    exceptionSummary: exception ? exception.summary : null,
    exceptionHref: exception ? "/store/dashboard/operations/purchase-exceptions" : null,
    nextAction: {
      ...action,
      /* Every order — a draft included — opens on its OWN page (30 Sep 2026,
         the owner: a draft's next step is to issue it, and issuing happens on
         the order page, not in the editor). The editor is a step away from
         there ("Edit"), and the register row still offers "Edit draft". */
      href: `/store/dashboard/operations/purchase-order/${idOf(po._id)}`,
    },
  };
}

/**
 * One service order as a workspace row.
 *
 * A service has no expected delivery date and no item lines; it has a
 * department that asked for it and an acceptance step. Material-only fields are
 * absent rather than null, so a renderer cannot show an empty "Expected"
 * column against work that has no delivery.
 */
function serviceRow(so) {
  const lines = Array.isArray(so.lines) ? so.lines : [];
  return {
    id: idOf(so._id),
    recordType: RECORD.SERVICE_ORDER,
    purchaseType: TYPE.SERVICE,
    reference: so.serviceOrderNumber || "",
    title: so.title || (lines[0]?.serviceName || ""),
    supplierLabel: so.vendorName || "",
    stage: SERVICE_STAGE[so.status] || null,
    exactStatus: so.status,
    orderDate: so.createdAt || null,
    lineCount: lines.length,
    /* Who asked, which is the fact a service order turns on. */
    requestedFor: so.department || "",
    totalAmount: num(so.totalAmount),
    currency: so.currency || "INR",
    exceptionSummary: null,
    exceptionHref: null,
    nextAction: {
      ...(so.status === "DRAFT" ? ACTION.ISSUE_ORDER
        : so.status === "ACCEPTED" ? ACTION.VIEW_COMPLETED
          : ACTION.REVIEW_ORDER),
      href: `/store/dashboard/operations/service-orders/${idOf(so._id)}`,
    },
  };
}

/**
 * One supplier quotation as a workspace row.
 *
 * `expired` is its own field beside the stored status, for the reason the model
 * gives: the status records what somebody DID, and expiry is what the clock has
 * since done to it.
 */
function offerRow(offer, { purchaseType, asOf, hrefBase, registerHref = null }) {
  const { stage, expired } = stageOfOffer(offer, asOf);
  /* ── THE DESTINATION DECIDES THE WORDING ──────────────────────────────────
     Freight quotations have no `[id]` route — the register is the only place
     one can be read — so a freight row links to that register and says so. The
     previous link pointed at a page that does not exist.
     And a MATERIAL or SERVICE row opens ONE quotation's detail page, which is
     not a comparison, so it must not be labelled "Compare offers". Comparing
     is what the sourcing decision does, and that is a different row. */
  const href = registerHref || `${hrefBase}/${idOf(offer._id)}`;
  const action = registerHref ? ACTION.OPEN_FREIGHT_REGISTER : ACTION.REVIEW_OFFER;
  return {
    id: idOf(offer._id),
    recordType: RECORD.OFFER,
    purchaseType,
    reference: offer.quotationReference || "",
    title: offer.itemName || offer.serviceName || offer.laneLabel || "",
    supplierLabel: offer.supplierName || "",
    stage,
    exactStatus: offer.status,
    /* Never folded into the status. An expired ACTIVE offer still reads
       ACTIVE, because that is what the register says somebody left it at. */
    expired,
    revision: num(offer.revision),
    validUntil: offer.validUntil || null,
    orderDate: offer.createdAt || null,
    currency: offer.currency || null,
    /* Deliberately no `totalAmount`: an offer is a rate for a quantity nobody
       has committed to, and presenting one as an order value would invite a
       buyer to compare it against a real commitment. */
    exceptionSummary: null,
    exceptionHref: null,
    nextAction: { ...action, href },
  };
}

/** One outstanding sourcing decision as a workspace row. */
function decisionRow(d) {
  return {
    id: `${d.costingId}:${d.lineKey || d.itemId || ""}`,
    recordType: RECORD.DECISION,
    purchaseType: d.serviceId ? TYPE.SERVICE : TYPE.MATERIAL,
    reference: d.costingLabel || "",
    title: d.itemName || d.serviceName || d.lineKey || "",
    supplierLabel: "",
    stage: STAGE.TO_SOURCE,
    /* A decision is not a document with a lifecycle status; it is an open
       question. Said plainly rather than borrowed from another vocabulary. */
    exactStatus: "DECISION_REQUIRED",
    orderDate: null,
    candidateCount: Array.isArray(d.candidates) ? d.candidates.length : num(d.candidateCount),
    currency: null,
    exceptionSummary: null,
    exceptionHref: null,
    nextAction: {
      ...(d.decided ? ACTION.REVIEW_DECISION : ACTION.RECORD_DECISION),
      href: "/store/dashboard/supplier-offers/sourcing-decisions",
    },
  };
}

/* ── THE READS ───────────────────────────────────────────────────────────────
   Each is bounded, projected, and does its own filtering IN THE QUERY so a cap
   never turns into "an arbitrary slice presented as complete". */

/** Which stored statuses a stage and status-filter combination wants. */
function statusesFor(map, stage, statusFilter) {
  if (statusFilter === STATUS_FILTER.CLOSED) {
    /* The stage is deliberately ignored here: closed records are not IN a
       stage, and asking which tab a cancelled order belongs to has no answer.
       Returning them per-stage is what repeated them under all four. */
    return Object.keys(map).length
      ? CLOSED_STATUS.filter((st) => !map[st])
      : CLOSED_STATUS;
  }
  if (stage === STAGE.ALL) return Object.keys(map);
  return Object.entries(map).filter(([, v]) => v === stage).map(([k]) => k);
}


async function readMaterialOrders(tenant, { stage, status, search, vendor, poStatus }) {
  let statuses = statusesFor(MATERIAL_STAGE, stage, status);
  /* An exact status narrows the stage's set; it never widens it. Asking for
     ISSUED inside Completed is an empty answer, not a redefinition of
     Completed. */
  if (poStatus) statuses = statuses.filter((st) => st === poStatus);
  if (!statuses.length) return { rows: [], coverage: null };

  const base = { status: { $in: statuses } };
  if (vendor) base.vendor = vendor;
  const rx = search ? rxOf(search) : null;
  const filter = scoped(tenant, base, rx
    ? [{ poNumber: rx }, { vendorName: rx }, { "items.itemName": rx }]
    : null);
  const limit = ORDER_CAP();
  const [storedMatchCount, docs] = await Promise.all([
    PurchaseOrder.countDocuments(filter),
    /* Projected, and no populate: the register's five populates are exactly
       the N+1 this adapter exists not to repeat. Denormalised names are on the
       document already. */
    PurchaseOrder.find(filter)
      /* ── WHAT THE ROW NEEDS TO BE COMPLETE ON ITS OWN ──────────────────
         Payment state, the stored receipt total and each line's ordered and
         received quantity with its unit. The page used to recover these by
         fetching the whole legacy purchase-order register a second time, so a
         valid row lost its actions and its progress whenever that unbounded
         request failed. Projected here instead — still no `populate`. */
      .select("poNumber vendorName status orderDate expectedDeliveryDate currency "
        + "totalAmount paymentStatus totalReceived createdAt "
        + "items.itemName items.status items.unit items.quantity items.receivedQuantity")
      .sort({ orderDate: -1, _id: -1 })
      .limit(limit)
      .lean(),
  ]);
  return {
    rows: docs,
    coverage: { scannedCount: docs.length, scanCap: limit, storedMatchCount, truncated: storedMatchCount > limit },
  };
}

async function readServiceOrders(tenant, { stage, status, search }) {
  const statuses = statusesFor(SERVICE_STAGE, stage, status);
  if (!statuses.length) return { rows: [], coverage: null };

  const rx = search ? rxOf(search) : null;
  const filter = scoped(tenant, { status: { $in: statuses } }, rx
    ? [{ serviceOrderNumber: rx }, { vendorName: rx }, { title: rx }, { department: rx }]
    : null);
  const limit = ORDER_CAP();
  const [storedMatchCount, docs] = await Promise.all([
    ServiceOrder.countDocuments(filter),
    ServiceOrder.find(filter)
      .select("serviceOrderNumber vendorName status title department currency totalAmount createdAt lines.serviceName")
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .lean(),
  ]);
  return {
    rows: docs,
    coverage: { scannedCount: docs.length, scanCap: limit, storedMatchCount, truncated: storedMatchCount > limit },
  };
}

async function readOffers(Model, tenant, { stage, status, search, asOf, extraSearchFields = [] }) {
  const statuses = statusesFor(OFFER_STAGE, stage, status);
  const closed = status === STATUS_FILTER.CLOSED;

  /* ── AN EXPIRED OFFER IS CLOSED, BUT ITS STORED STATUS IS NOT ────────────
     Expiry is a DATE passing, not something anybody did, so an expired
     quotation still reads ACTIVE in the register — which meant a status-only
     query could never find it, and the closed view simply did not contain it.
     It is reached by the date instead, and the row still reports the stored
     ACTIVE with `expired: true` beside it. */
  const lifecycle = closed
    ? [
      ...(statuses.length ? [{ status: { $in: statuses } }] : []),
      { status: "ACTIVE", validUntil: { $ne: null, $lt: asOf } },
    ]
    : null;
  if (!closed && !statuses.length) return { rows: [], coverage: null };

  const rx = search ? rxOf(search) : null;
  const filter = scoped(
    tenant,
    closed ? {} : { status: { $in: statuses } },
    lifecycle,
    rx ? [
      { supplierName: rx }, { quotationReference: rx },
      ...extraSearchFields.map((f) => ({ [f]: rx })),
    ] : null,
  );
  const limit = OFFER_CAP();
  const [storedMatchCount, docs] = await Promise.all([
    Model.countDocuments(filter),
    Model.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .lean(),
  ]);
  return {
    rows: docs,
    coverage: { scannedCount: docs.length, scanCap: limit, storedMatchCount, truncated: storedMatchCount > limit },
  };
}

/**
 * Purchase exceptions, as an indicator keyed by order.
 *
 * ── THE REGISTER'S RULES ARE NOT COPIED ─────────────────────────────────────
 * `poExceptionsRegister` owns what an exception IS. This asks it, keeps the
 * group names and the order id, and links to the register for the detail. No
 * second exception calculation exists here or in the browser.
 */
async function readExceptions(tenant) {
  const register = require("./poExceptionsRegister.service");
  const scope = tenantContext.tenantFilter(tenant);
  const limit = ORDER_CAP();
  /* Only orders that could still carry one. A completed or cancelled order is
     not an open exception. */
  const purchaseOrders = await PurchaseOrder.find({
    ...scope, status: { $in: ["ISSUED", "PARTIALLY_RECEIVED"] },
  })
    .select("poNumber vendorName status orderDate expectedDeliveryDate items deliveries returnRequests currency totalAmount createdAt")
    .sort({ orderDate: -1 })
    .limit(limit)
    .lean();

  const built = register.buildExceptionsRegister({ purchaseOrders, asOf: new Date() });
  const byPo = new Map();
  for (const row of built.rows || []) {
    const key = idOf(row.purchaseOrderId || row.id);
    if (!key) continue;
    const groups = (row.groups || row.exceptionGroups || []).filter(Boolean);
    if (!groups.length) continue;
    byPo.set(key, { summary: groups.join(", "), groups });
  }
  return { byPo, coverage: { scannedCount: purchaseOrders.length, scanCap: limit, storedMatchCount: purchaseOrders.length, truncated: false } };
}

/**
 * Totals, grouped by currency.
 *
 * ── TWO CURRENCIES ARE NEVER ONE NUMBER ─────────────────────────────────────
 * A page showing "₹4,20,000 + $900" as one figure is showing a number that
 * does not exist. Each currency keeps its own subtotal, and a row with no
 * recorded amount is counted, not valued at zero.
 */
/**
 * What this stage is worth — one figure per currency, never a combined total.
 *
 * ── ONLY THINGS THAT HAVE AN ORDERED VALUE ──────────────────────────────────
 * A committed order has one. A quotation is a rate for a quantity nobody has
 * committed to, and a sourcing decision is an open question. Counting either as
 * "not valued" would report them as orders somebody forgot to price; counting
 * them in the total would report money as committed that nobody has committed.
 * They are excluded, and `valuedRecordCount` says how many rows the figures
 * actually cover.
 */
const VALUED_RECORDS = Object.freeze([RECORD.MATERIAL_ORDER, RECORD.SERVICE_ORDER]);

function summarise(rows) {
  const byCurrency = new Map();
  let unvalued = 0;
  let valuedRows = 0;
  for (const r of rows) {
    if (!VALUED_RECORDS.includes(r.recordType)) continue;
    valuedRows += 1;
    if (r.totalAmount === null || r.totalAmount === undefined) { unvalued += 1; continue; }
    const key = r.currency || "INR";
    /* Per currency. Adding two of them produces a number nobody can act on. */
    byCurrency.set(key, (byCurrency.get(key) || 0) + Number(r.totalAmount));
  }
  return {
    totalsByCurrency: [...byCurrency.entries()].map(([currency, amount]) => ({ currency, amount })),
    unvaluedCount: unvalued,
    /* The orders the figures above describe — not every row on screen. */
    valuedRecordCount: valuedRows,
    rowCount: rows.length,
  };
}

/**
 * The whole workspace, as one closed DTO.
 *
 * ── A FAILED SOURCE IS NEVER AN EMPTY TAB ───────────────────────────────────
 * Each source is read independently and its failure reported with the reason. A
 * buyer told "nothing needs sourcing" because the offer register threw is a
 * buyer who stops sourcing.
 */
async function workspace(tenant, ctx, query = {}) {
  const {
    stage, type, status, search, page, pageSize, vendor, poStatus,
    poStatusApplied, stageInferred, ordersOnly,
  } = readQuery(query);
  /* Asking for a supplier or a purchase-order status is asking about material
     orders, so the other sources are not read at all — reading them only to
     discard every row would report them as available and contributing nothing,
     which is a different claim from not having been asked. */
  const materialOnly = Boolean(vendor || poStatus);
  const asOf = new Date();

  const sources = {};
  const attempt = async (key, fn) => {
    try {
      const out = await fn();
      sources[key] = { available: true, unavailableReason: null, coverage: out.coverage };
      return out;
    } catch (err) {
      sources[key] = { available: false, unavailableReason: err?.message || "This source could not be read.", coverage: null };
      return { rows: [], coverage: null };
    }
  };

  const wantMaterial = type === TYPE.ALL || type === TYPE.MATERIAL;
  const wantService = !materialOnly && (type === TYPE.ALL || type === TYPE.SERVICE);
  const wantFreight = !materialOnly && (type === TYPE.ALL || type === TYPE.FREIGHT);

  let rows = [];

  /* Exceptions are only an indicator, and only where an order could carry one. */
  let exceptionsByPo = new Map();
  if (wantMaterial && (stage === STAGE.ALL || stage === STAGE.ON_ORDER || stage === STAGE.COMPLETED)) {
    const ex = await attempt("purchaseExceptions", () => readExceptions(tenant));
    exceptionsByPo = ex.byPo || new Map();
  }

  if (wantMaterial) {
    const out = await attempt("materialOrders", () => readMaterialOrders(tenant, { stage, status, search, vendor, poStatus }));
    rows = rows.concat((out.rows || []).map((po) => materialRow(po, { exceptionsByPo })));
  }
  if (wantService) {
    const out = await attempt("serviceOrders", () => readServiceOrders(tenant, { stage, status, search }));
    rows = rows.concat((out.rows || []).map(serviceRow));
  }

  /* ── WHY APPROVED DEMAND IS NOT LISTED HERE (30 Sep 2026) ───────────────
     This workspace shows PURCHASING records. An approved spend request is a
     pre-purchase record: nobody has ordered anything, so a row reading
     "Approved, not yet ordered" in a table of purchase orders described a
     document that did not exist.

     It is not lost, and nothing about the governed chain changed. Approved
     buying balances live in Store › Requests, and the approved request's own
     page carries "Create purchase order", which is the same governed flow the
     row used to link to (`/store/dashboard/order-requests/quote/:id` →
     `POST /api/requests/spend/:id/purchase-order`). A record appears here once
     an actual purchase order exists. */

  /* The Purchase Orders page asks for `records=orders`, which skips these
     sourcing records even in the closed view. Legacy adapter callers can still
     read them; their dedicated sourcing screens and data remain untouched. */
  if (!ordersOnly && !materialOnly && (status === STATUS_FILTER.CLOSED
      || stage === STAGE.ALL || stage === STAGE.TO_SOURCE || stage === STAGE.DRAFT)) {
    if (wantMaterial) {
      const out = await attempt("materialOffers", () => readOffers(SupplierOffer, tenant, {
        stage, status, search, asOf, extraSearchFields: ["itemName", "itemSku", "supplierItemCode"],
      }));
      rows = rows.concat((out.rows || [])
        .map((o) => offerRow(o, { purchaseType: TYPE.MATERIAL, asOf, hrefBase: "/store/dashboard/supplier-offers" }))
        .filter((r) => r.stage === stage || stage === STAGE.ALL || status === STATUS_FILTER.CLOSED));
    }
    if (wantService) {
      const out = await attempt("serviceOffers", () => readOffers(ServiceSupplierOffer, tenant, {
        stage, status, search, asOf, extraSearchFields: ["serviceName", "serviceCode"],
      }));
      rows = rows.concat((out.rows || [])
        .map((o) => offerRow(o, { purchaseType: TYPE.SERVICE, asOf, hrefBase: "/store/dashboard/supplier-offers/services" }))
        .filter((r) => r.stage === stage || stage === STAGE.ALL || status === STATUS_FILTER.CLOSED));
    }
    if (wantFreight) {
      const out = await attempt("freightOffers", () => readOffers(FreightOffer, tenant, {
        stage, status, search, asOf, extraSearchFields: ["laneLabel", "originCity", "destinationCity"],
      }));
      rows = rows.concat((out.rows || [])
        .map((o) => offerRow(o, {
          purchaseType: TYPE.FREIGHT, asOf,
          registerHref: "/store/dashboard/supplier-offers?subject=freight",
        }))
        .filter((r) => r.stage === stage || stage === STAGE.ALL || status === STATUS_FILTER.CLOSED));
    }
  }

  if (!ordersOnly && !materialOnly && (stage === STAGE.TO_SOURCE || stage === STAGE.ALL) && status !== STATUS_FILTER.CLOSED) {
    const out = await attempt("sourcingDecisions", async () => {
      const sourcingDecision = require("./sourcingDecision.service");
      const queue = await sourcingDecision.openQueue(ctx, { limit: DECISION_CAP() });
      return {
        rows: queue.rows || [],
        coverage: {
          scannedCount: (queue.rows || []).length, scanCap: DECISION_CAP(),
          storedMatchCount: (queue.rows || []).length, truncated: Boolean(queue.hasMore),
          unreadable: queue.unreadable || [],
        },
      };
    });
    rows = rows.concat((out.rows || []).map(decisionRow));
  }

  /* ── ONE ROW, ONE PLACE ────────────────────────────────────────────────
     In the closed view the stage constraint is DISABLED rather than widened: a
     closed record has no stage, so applying one would either drop it or — as it
     used to — repeat it under all four tabs.

     A BACKSTOP, not the mechanism. Each source already asks only for the
     statuses belonging to this stage (`statusesFor`), so nothing out of stage
     is read in the first place; neutralising this line alone changes no test.
     It is kept so that a future source which returns a row for a stage it does
     not belong to cannot put that row under the wrong tab. */
  if (status === STATUS_FILTER.OPEN && stage !== STAGE.ALL) rows = rows.filter((r) => r.stage === stage);

  const totalItems = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const current = Math.min(page, totalPages);
  const paged = rows.slice((current - 1) * pageSize, (current - 1) * pageSize + pageSize);

  const truncated = Object.entries(sources).filter(([, v]) => v.coverage?.truncated);
  const unavailable = Object.entries(sources).filter(([, v]) => !v.available);

  return {
    stage, type, status, search, vendor, poStatus,
    /* False when the caller named a status this workspace does not recognise,
       so the page can drop the chip rather than claim a filter is on. */
    poStatusApplied,
    /* The Purchase Orders page requests this closed scope so quotation records
       cannot leak back through its closed-record view. */
    recordScope: ordersOnly ? "orders" : "all-purchasing",
    /* True when the stage came from a legacy status link rather than a tab. */
    stageInferred,
    /* True when the stage tabs do not apply to what is shown, so the page can
       say so rather than leaving a tab looking selected over a list it did not
       choose. */
    stageApplies: status === STATUS_FILTER.OPEN,
    /* Said out loud, because it changes what the rows and figures cover. */
    materialOnly,
    rows: paged,
    summary: summarise(rows),
    pagination: {
      page: current, pageSize, totalItems, totalPages,
      hasNextPage: current < totalPages, hasPrevPage: current > 1,
      /* Honest: a stage is assembled from several capped reads, so this
         describes the composed set rather than a company-wide total. */
      scope: "composedSet",
    },
    sources,
    coverage: {
      truncated: truncated.length > 0,
      note: truncated.length
        ? `Showing the newest records from ${truncated.map(([k]) => k).join(", ")}; older matching records may exist. Counts and pagination describe only this set.`
        : null,
    },
    unavailable: unavailable.map(([source, v]) => ({ source, reason: v.unavailableReason })),
    stages: STAGES, typeOptions: TYPES, statusOptions: STATUS_FILTERS,
  };
}

module.exports = {
  workspace, materialRow, serviceRow, offerRow, decisionRow, statusesFor, summarise,
  readMaterialOrders, readServiceOrders, readOffers, readExceptions,
  scoped, VALUED_RECORDS,
  STAGE, STAGES, TYPE, TYPES, RECORD, ACTION,
  MATERIAL_STAGE, SERVICE_STAGE, OFFER_STAGE, CLOSED_STATUS,
  STATUS_FILTER, STATUS_FILTERS,
  readQuery, stageOfOffer, inferredViewFor,
  ORDER_CAP, OFFER_CAP, DECISION_CAP,
  PurchaseOrder, ServiceOrder, SupplierOffer, ServiceSupplierOffer, FreightOffer,
  tenantContext, mongoose, str, rxOf, num, idOf,
};
