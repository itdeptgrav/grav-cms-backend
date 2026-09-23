// services/orderBookLink.js
//
// WHICH ORDER IS THIS DEAL? — the Opportunity → Order Book link (G02).
//
// The journey's post-PO screens (Production, Shipment, Order Closing) all read
// one order record — a CustomerRequest, with its WorkOrders and challans
// hanging off it — through `enquiry.customerRequestId`.
//
// ── WHAT THIS USED TO DO, AND WHY IT IS GONE ─────────────────────────────────
//
// On PO record it read the journey's account, took the account's linked portal
// customer, and wrote the NEWEST CustomerRequest for that customer onto the
// enquiry. A customer with two open orders — two uniform programmes, a portal
// reorder, a measurement conversion — had its PO pinned to whichever was raised
// last, silently, and every later screen trusted it. It also read the enquiry
// and the account with no company at all. The enquiry routes had a second copy
// of the same guess (`resolveRequestId`: customer NAME, then newest order,
// persisted); it is gone too.
//
// ── WHAT COUNTS AS PROOF NOW ────────────────────────────────────────────────
//
// Only two things prove which order an enquiry is (services/orderLinkProof.js
// holds the rule, shared with the closing verdict and the buyer brief):
//
//   1. ORIGIN — a request raised from this enquiry through Cost & Invoicing
//      carries `salesOrigin.enquiryId`, stamped server-side from an enquiry
//      read under the caller's company. Successors raised through the explicit
//      supersession path point back with `supersedesRequestId`; the current
//      order is the head of that chain.
//   2. A PERSON — an authorised salesperson choosing one of this company's own
//      candidate orders (`chooseOrderLink`). Portal and measurement orders have
//      no origin, so this is the only honest way they become linked.
//
// Anything else stored in `customerRequestId` is reported as UNVERIFIED, never
// trusted, and never silently replaced — except by an order raised from this
// very enquiry, which is proof (`recordOriginLink`).
//
// ── ONE ORDER, ONE ENQUIRY ─────────────────────────────────────────────────
//
// Every write here first CLAIMS the order in `order_link_claims`, whose `_id`
// is the order's id — see models/CMS_Models/Sales/OrderLinkClaim.js for why a
// claim document and not a unique index on Enquiry. Two enquiries racing for
// one order cannot both win.
//
// ── WHAT IT NEVER DOES ─────────────────────────────────────────────────────
//
//   • create a CustomerRequest, or a portal customer to hang one on;
//   • pick between several possible orders, or match anything by name;
//   • overwrite a link it did not expect — every write is conditional on the
//     link the caller saw, so retries and concurrent corrections are safe;
//   • fail the PO. A PO is a commercial fact recorded before this runs.
//
// ── THE CONTRACT (Lane B reads this) ───────────────────────────────────────
//
// Every entry point returns the same `orderLink` shape:
//
//   {
//     status:  "linked" | "not_linked" | "unverified" | "ambiguous" | "conflict" | "unavailable",
//     method:  "sales_origin" | "manual" | null,     // how a `linked` order was proved
//     customerRequestId: string | null,               // the order record's _id
//     requestId: string | null,                       // its human reference (REQ-…)
//     message: string,                                // what the salesperson reads
//     needsChoice: boolean,                           // the chooser should be offered
//     candidateCount: number | null,                  // orders the chooser would list
//     confirmedAt: ISO string | null,
//     confirmedBy: string | null,                     // name only, for `manual`
//   }
//
// `customerRequestId`/`requestId` are only ever the id of an order this
// company has been proved to own. An unverified link that fails company proof
// is reported without naming it.

const Enquiry = require("../models/CMS_Models/Sales/Enquiry");
const Account = require("../models/CMS_Models/Sales/Account");
const CustomerRequest = require("../models/Customer_Models/CustomerRequest");
const OrderLinkClaim = require("../models/CMS_Models/Sales/OrderLinkClaim");
const { serviceFilter, assertServiceContext, createServiceContext } = require("./companyContext/serviceScope.service");
const {
  DEAD_STATUSES, originHeads, originRequestsFor, proveOrderOwnership, classifyStoredLink, proveExactOrderLink,
} = require("./orderLinkProof");

const STATUS = Object.freeze({
  LINKED: "linked",
  NOT_LINKED: "not_linked",
  UNVERIFIED: "unverified",
  AMBIGUOUS: "ambiguous",
  CONFLICT: "conflict",
  UNAVAILABLE: "unavailable",
});

/* A sampling or testing run is not a customer's order. */
const NOT_CUSTOMER_ORDERS = ["sampling", "testing"];

/* What the chooser shows, on top of the proof fields. */
const DISPLAY_FIELDS = "createdAt requestType orderOrigin measurementName items.stockItemName items.totalQuantity";

/* A claim younger than this is a write in flight, never stale. */
const CLAIM_GRACE_MS = 60 * 1000;

/** Refused choice — `code` is stable for callers and tests. */
class OrderLinkError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "OrderLinkError";
    this.status = status;
    this.code = code;
  }
}

const str = (v) => (v == null ? "" : String(v));
const sameId = (a, b) => Boolean(a) && Boolean(b) && str(a) === str(b);

function contract(status, over = {}) {
  return {
    status,
    method: null,
    customerRequestId: null,
    requestId: null,
    message: "",
    needsChoice: false,
    candidateCount: null,
    confirmedAt: null,
    confirmedBy: null,
    ...over,
  };
}

const MESSAGES = {
  noEnquiry: "This journey has no active enquiry, so it has no order to link.",
  notLinked: "Order not linked. The PO is recorded, but which customer order it belongs to has not been proved. "
    + "Choose the order it belongs to.",
  unverified: "Order link not verified. This enquiry points at an order that was matched automatically, "
    + "not proved. Confirm it or choose the correct order.",
  unproved: "Order link not verified. The linked order cannot be proved to belong to this company. "
    + "Choose the correct order.",
  stale: "Order link out of date. The linked order was cancelled or replaced. Choose the current order.",
  ambiguous: "Order not linked. More than one current order was raised from this enquiry, so the PO "
    + "cannot be linked automatically. Choose the one it belongs to.",
  conflict: "Order link conflict. This enquiry points at a different order from the one raised from it. "
    + "Choose which order the PO belongs to.",
  claimed: "Order not linked. The order raised from this enquiry is already linked to another enquiry. "
    + "Ask a Sales manager to check which deal it belongs to.",
  error: "The order link could not be checked right now. The PO is recorded; try again shortly.",
};

const scopeOf = (ctx) => (selector) => serviceFilter(ctx, selector);

/* ══ CLAIMS ════════════════════════════════════════════════════════════════ */

/** Is someone else's claim still meaningful? A claim in its grace period is a
 *  write in flight; after it, the claim holds only while its enquiry still
 *  links the order (a crash between claim and link leaves a dead one). */
async function claimIsLive(claim, now = Date.now()) {
  if (now - new Date(claim.claimedAt).getTime() < CLAIM_GRACE_MS) return true;
  /* Existence only, across companies: the holder's fields are never read. */
  return Boolean(await Enquiry.exists({ _id: claim.enquiryId, isActive: true, customerRequestId: claim._id }));
}

/**
 * Claim an order for an enquiry. The `_id` of the claim is the order's id, so
 * the database — not a prior read — decides a race.
 *
 * @returns {Promise<{ok:true, created:boolean} | {ok:false}>}
 *          `created` is true when this call made (or took over) the claim, so
 *          a failed link write knows to release it.
 */
async function claimOrder(ctx, { customerRequestId, enquiryId, method }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const now = new Date();
    try {
      await OrderLinkClaim.create({
        _id: customerRequestId, enquiryId, companyId: ctx.companyId || null, method, claimedAt: now,
      });
      return { ok: true, created: true };
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
    const held = await OrderLinkClaim.findById(customerRequestId).lean();
    if (!held) continue; // released between the insert and the read — try once more
    if (sameId(held.enquiryId, enquiryId)) return { ok: true, created: false };
    if (await claimIsLive(held, now.getTime())) return { ok: false };
    /* Dead claim: taken over only if nobody else took it first. */
    const took = await OrderLinkClaim.findOneAndUpdate(
      { _id: customerRequestId, enquiryId: held.enquiryId, claimedAt: held.claimedAt },
      { $set: { enquiryId, companyId: ctx.companyId || null, method, claimedAt: now } },
    );
    if (took) return { ok: true, created: true };
  }
  return { ok: false };
}

/** Release this enquiry's claim on an order. Never someone else's. */
const releaseClaim = (customerRequestId, enquiryId) => OrderLinkClaim
  .deleteOne({ _id: customerRequestId, enquiryId })
  .catch((err) => console.error("[orderBookLink] claim release failed:", err?.message || err));

/**
 * THE ONLY WAY A LINK IS WRITTEN. Claim, then write conditionally on the link
 * the caller saw, then release the claim on the order it replaced.
 *
 * @returns {Promise<{ok:true, enquiry:object} | {ok:false, code:"claimed"|"link_changed"}>}
 */
async function writeLink(ctx, enquiry, request, { method, actor = null, reason = "" }) {
  const current = enquiry.customerRequestId || null;
  const claim = await claimOrder(ctx, { customerRequestId: request._id, enquiryId: enquiry._id, method });
  if (!claim.ok) return { ok: false, code: "claimed" };

  const why = str(reason).trim();
  const orderLink = {
    customerRequestId: request._id,
    method,
    confirmedAt: new Date(),
    ...(actor ? { confirmedBy: { id: str(actor.id) || undefined, name: str(actor.name) || undefined } } : {}),
    ...(why ? { reason: why } : {}),
    ...(current && !sameId(current, request._id) ? { replacedCustomerRequestId: current } : {}),
  };
  const updated = await Enquiry.findOneAndUpdate(
    serviceFilter(ctx, { _id: enquiry._id, isActive: true, customerRequestId: current }),
    { $set: { customerRequestId: request._id, orderLink } },
    { new: true },
  );
  if (!updated) {
    if (claim.created) await releaseClaim(request._id, enquiry._id);
    return { ok: false, code: "link_changed" };
  }
  if (current && !sameId(current, request._id)) await releaseClaim(current, enquiry._id);
  return { ok: true, enquiry: updated };
}

/* ══ CANDIDATES ════════════════════════════════════════════════════════════ */

/**
 * The portal customer this company's account is linked to — but only when no
 * account outside this company links the same customer. Same rule as the
 * ownership proof's customer chain.
 */
async function provedCustomerFor(ctx, enquiry) {
  if (!enquiry?.accountId) return null;
  const account = await Account.findOne(serviceFilter(ctx, { _id: enquiry.accountId }))
    .select("linkedCustomer").lean();
  if (!account?.linkedCustomer) return null;
  const claimedElsewhere = await Account.exists({
    linkedCustomer: account.linkedCustomer,
    $nor: [serviceFilter(ctx, {})],
  });
  return claimedElsewhere ? null : account.linkedCustomer;
}

/** A candidate as the chooser shows it: enough to recognise, no money. */
function candidateView(r, { enquiry }) {
  const items = Array.isArray(r.items) ? r.items : [];
  const source = r.salesOrigin?.enquiryId ? "sales"
    : r.requestType === "measurement_conversion" ? "measurement" : "portal";
  return {
    customerRequestId: str(r._id),
    requestId: str(r.requestId) || null,
    source,
    status: str(r.status) || null,
    createdAt: r.createdAt || null,
    measurementName: r.measurementName || null,
    itemCount: items.length,
    totalQuantity: items.reduce((n, it) => n + (Number(it.totalQuantity) || 0), 0),
    itemNames: [...new Set(items.map((it) => str(it.stockItemName)).filter(Boolean))].slice(0, 4),
    raisedFromThisEnquiry: sameId(r.salesOrigin?.enquiryId, enquiry._id),
    isCurrentLink: sameId(enquiry.customerRequestId, r._id),
  };
}

/**
 * THE ORDERS A SALESPERSON MAY CHOOSE FROM. Never auto-selected, whatever
 * their number.
 *
 *   • When orders were raised from this enquiry, only their current head(s)
 *     are offered: the enquiry's own origin is decisive, and a portal order
 *     cannot outrank it.
 *   • Otherwise, orders of this company's proved portal customer (portal and
 *     measurement orders), excluding cancelled, sampling/testing runs, orders
 *     raised from ANOTHER enquiry, superseded ones, and orders another enquiry
 *     already holds — by a live claim, or by a legacy link in this company.
 *
 * @returns {Promise<object[]>} raw requests, newest first
 */
async function candidateRequests(ctx, enquiry, origin) {
  const originList = origin || await originRequestsFor(enquiry._id, DISPLAY_FIELDS);
  const heads = originHeads(originList);
  if (heads.length) return heads.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  const customerId = await provedCustomerFor(ctx, enquiry);
  if (!customerId) return [];

  const pool = await CustomerRequest.find({
    customerId,
    status: { $nin: DEAD_STATUSES },
    orderOrigin: { $nin: NOT_CUSTOMER_ORDERS },
    /* Matches absent AND null: an order raised from another enquiry is that
       enquiry's, whatever its customer. */
    "salesOrigin.enquiryId": null,
  }).select(`requestId customerId status salesOrigin.enquiryId ${DISPLAY_FIELDS}`).sort({ createdAt: -1 }).lean();
  if (!pool.length) return [];

  const ids = pool.map((r) => r._id);
  const [supersededBy, heldHere, claims] = await Promise.all([
    CustomerRequest.find({ "salesOrigin.supersedesRequestId": { $in: ids } })
      .select("salesOrigin.supersedesRequestId").lean(),
    /* A legacy (pre-claim) link on another of THIS company's enquiries. A
       foreign company's legacy link is not consulted: it cannot pass that
       company's own proof, because this customer is linked only here. */
    Enquiry.find(serviceFilter(ctx, { customerRequestId: { $in: ids }, _id: { $ne: enquiry._id }, isActive: true }))
      .select("customerRequestId").lean(),
    OrderLinkClaim.find({ _id: { $in: ids }, enquiryId: { $ne: enquiry._id } }).lean(),
  ]);
  const liveClaims = [];
  for (const c of claims) if (await claimIsLive(c)) liveClaims.push(c);
  const blocked = new Set([
    ...supersededBy.map((r) => str(r.salesOrigin?.supersedesRequestId)),
    ...heldHere.map((e) => str(e.customerRequestId)),
    ...liveClaims.map((c) => str(c._id)),
  ]);
  return pool.filter((r) => !blocked.has(str(r._id)));
}

async function listOrderCandidates(ctx, enquiry) {
  assertServiceContext(ctx, "order link candidates");
  const raw = await candidateRequests(ctx, enquiry);
  return raw.map((r) => candidateView(r, { enquiry }));
}

/* ══ RESOLUTION ════════════════════════════════════════════════════════════ */

const linkedFrom = (request, method, enquiry) => contract(STATUS.LINKED, {
  method,
  customerRequestId: str(request._id),
  requestId: str(request.requestId) || null,
  message: method === "manual" ? "Order linked — chosen by Sales." : "Order linked — raised from this enquiry.",
  confirmedAt: enquiry.orderLink?.confirmedAt ? new Date(enquiry.orderLink.confirmedAt).toISOString() : null,
  confirmedBy: method === "manual" ? (enquiry.orderLink?.confirmedBy?.name || null) : null,
});

/**
 * Classify an enquiry's order link. Read-only unless `write` is set, and then
 * the only write is filling an EMPTY link with the single order raised from
 * this enquiry.
 *
 * @param {object} ctx       the caller's company service context
 * @param {object} enquiry   an Enquiry already read under that company
 * @param {{write?: boolean}} [opt]
 * @returns {Promise<object>} the contract above
 */
async function resolveOrderLink(ctx, enquiry, { write = false } = {}) {
  assertServiceContext(ctx, "order link");
  if (!enquiry) return contract(STATUS.UNAVAILABLE, { message: MESSAGES.noEnquiry });

  const origin = await originRequestsFor(enquiry._id, DISPLAY_FIELDS);
  const heads = originHeads(origin);
  const withCount = async (c) => ({ ...c, candidateCount: (await candidateRequests(ctx, enquiry, origin)).length });

  /* ── NOTHING STORED ─────────────────────────────────────────────────── */
  if (!enquiry.customerRequestId) {
    if (heads.length === 1) {
      const head = heads[0];
      if (!write) return linkedFrom(head, "sales_origin", enquiry);
      const out = await writeLink(ctx, enquiry, head, { method: "sales_origin" });
      if (out.ok) return linkedFrom(head, "sales_origin", out.enquiry);
      if (out.code === "claimed") return contract(STATUS.NOT_LINKED, { message: MESSAGES.claimed, candidateCount: 0 });
      /* Someone linked it first — answer with what is there now. */
      const fresh = await Enquiry.findOne(serviceFilter(ctx, { _id: enquiry._id }));
      return fresh && fresh.customerRequestId
        ? resolveOrderLink(ctx, fresh)
        : contract(STATUS.UNAVAILABLE, { message: MESSAGES.error });
    }
    if (heads.length > 1) {
      return contract(STATUS.AMBIGUOUS, { message: MESSAGES.ambiguous, needsChoice: true, candidateCount: heads.length });
    }
    return withCount(contract(STATUS.NOT_LINKED, { message: MESSAGES.notLinked, needsChoice: true }));
  }

  /* ── SOMETHING STORED: owned by this company, and exactly this deal's? ── */
  const owned = await proveOrderOwnership({ enquiry, scope: scopeOf(ctx), fields: DISPLAY_FIELDS });
  if (!owned.ok) return withCount(contract(STATUS.UNVERIFIED, { message: MESSAGES.unproved, needsChoice: true }));

  const stored = owned.request;
  const supersededElsewhere = await CustomerRequest.exists({ "salesOrigin.supersedesRequestId": stored._id });
  const c = classifyStoredLink({
    enquiry, request: stored, basis: owned.basis, origin, supersededElsewhere: Boolean(supersededElsewhere),
  });
  if (c.exact) return linkedFrom(stored, c.method, enquiry);

  const named = { customerRequestId: str(stored._id), requestId: str(stored.requestId) || null };
  switch (c.reason) {
    case "stale":
      return withCount(contract(STATUS.UNVERIFIED, { ...named, message: MESSAGES.stale, needsChoice: true }));
    case "ambiguous":
      return contract(STATUS.AMBIGUOUS, {
        ...named, message: MESSAGES.ambiguous, needsChoice: true, candidateCount: heads.length,
      });
    case "conflict":
      return withCount(contract(STATUS.CONFLICT, { ...named, message: MESSAGES.conflict, needsChoice: true }));
    default:
      return withCount(contract(STATUS.UNVERIFIED, { ...named, message: MESSAGES.unverified, needsChoice: true }));
  }
}

/**
 * For readers that ACT on the order (production, shipment, dispatch asks,
 * the commercial ladder, payment gates): the proved order id, or null with
 * the reason in `orderLink`. Read-only.
 */
async function provedOrderFor(ctx, enquiry) {
  const orderLink = await resolveOrderLink(ctx, enquiry);
  return {
    customerRequestId: orderLink.status === STATUS.LINKED ? orderLink.customerRequestId : null,
    orderLink,
  };
}

/**
 * The reverse question, for the Order Book: which of this company's enquiries
 * is this order EXACTLY the deal of? Null unless exactly one active enquiry
 * links it and that link passes the full proof. Read-only.
 */
async function provedEnquiryForOrder(ctx, customerRequestId) {
  assertServiceContext(ctx, "order enquiry");
  const holders = await Enquiry.find(serviceFilter(ctx, { customerRequestId, isActive: true })).limit(2).lean();
  if (holders.length !== 1) return null;
  const proof = await proveExactOrderLink({ enquiry: holders[0], scope: scopeOf(ctx) });
  return proof.ok ? holders[0] : null;
}

/**
 * The PO path. Finds the journey's enquiry under the caller's company and
 * resolves its link, filling an empty one only from this enquiry's own origin.
 * Never throws: the PO is already recorded.
 */
async function ensureOrderLink(ctx, journey) {
  try {
    if (!journey?._id) return contract(STATUS.UNAVAILABLE, { message: MESSAGES.noEnquiry });
    const enquiry = await Enquiry.findOne(serviceFilter(ctx, { journeyId: journey._id, isActive: true }));
    return await resolveOrderLink(ctx, enquiry, { write: true });
  } catch (err) {
    console.error("[orderBookLink] ensureOrderLink failed:", err.message);
    return contract(STATUS.UNAVAILABLE, { message: MESSAGES.error });
  }
}

/**
 * A PROFORMA WAS RAISED (or replayed) FROM THIS ENQUIRY. Called by
 * services/sales/proformaRequest.service.js in place of its own link write.
 *
 * The request is re-read and must be this enquiry's own, current (head)
 * order — the caller's object is never trusted. Then:
 *   • no link, or a link to this very order → linked, with proof recorded;
 *   • an UNPROVED link (the old guesses, a superseded predecessor, a
 *     cancelled order) → replaced, and the replaced id kept on `orderLink`.
 *     This is what stops a guessed link looking authoritative after Sales has
 *     raised the real document;
 *   • a link a PERSON confirmed to another order → kept. The resolver reports
 *     the conflict and a salesperson decides; a proforma does not overrule a
 *     person;
 *   • more than one current order from this enquiry → nothing; ambiguous.
 *
 * Never throws: the proforma is already durable.
 *
 * @param {{companyId:any}} costingCtx  the caller's company, from its authorised context
 * @returns {Promise<{written:boolean, reason:string}>}
 */
async function recordOriginLink(costingCtx, enquiryId, request) {
  try {
    const ctx = await createServiceContext({
      companyId: costingCtx?.companyId, reason: "proforma order link", legacyAware: true,
    });
    const enquiry = await Enquiry.findOne(serviceFilter(ctx, { _id: enquiryId, isActive: true }));
    if (!enquiry) return { written: false, reason: "no_enquiry" };

    const raised = request?._id
      ? await CustomerRequest.findById(request._id).select("requestId status salesOrigin.enquiryId").lean()
      : null;
    if (!raised || !sameId(raised.salesOrigin?.enquiryId, enquiry._id)) return { written: false, reason: "not_origin" };

    const origin = await originRequestsFor(enquiry._id);
    const heads = originHeads(origin);
    if (!heads.some((h) => sameId(h._id, raised._id))) return { written: false, reason: "not_current" };
    if (heads.length > 1) return { written: false, reason: "ambiguous" };

    const stored = enquiry.customerRequestId;
    if (sameId(stored, raised._id) && sameId(enquiry.orderLink?.customerRequestId, raised._id)) {
      /* Already recorded — make sure the claim exists too (a link written
         before claims existed gets one here), then stop. */
      await claimOrder(ctx, { customerRequestId: raised._id, enquiryId: enquiry._id, method: "sales_origin" });
      return { written: false, reason: "already_linked" };
    }
    if (stored && !sameId(stored, raised._id)) {
      const personChose = enquiry.orderLink?.method === "manual"
        && sameId(enquiry.orderLink.customerRequestId, stored)
        && Boolean(enquiry.orderLink?.confirmedBy?.id || enquiry.orderLink?.confirmedBy?.name);
      if (personChose) return { written: false, reason: "person_choice_kept" };
    }

    const out = await writeLink(ctx, enquiry, raised, {
      method: "sales_origin",
      reason: stored && !sameId(stored, raised._id) ? "Replaced by the order raised from this enquiry." : "",
    });
    return out.ok ? { written: true, reason: stored ? "replaced" : "linked" } : { written: false, reason: out.code };
  } catch (err) {
    console.error("[orderBookLink] recordOriginLink failed:", err?.message || err);
    return { written: false, reason: "error" };
  }
}

/**
 * AN AUTHORISED SALESPERSON CHOOSES THE ORDER. The caller has already checked
 * that this person may act on the journey.
 *
 * @param {object} ctx
 * @param {object} enquiry  read under ctx
 * @param {object} p
 * @param {string} p.customerRequestId          the order chosen
 * @param {string|null} p.expectedCustomerRequestId
 *        the link the salesperson SAW (null when there was none). The write
 *        happens only if the stored link still equals it, so two people
 *        correcting at once cannot overwrite each other unseen.
 * @param {string} [p.reason]  required when an existing link is replaced
 * @param {{id?:string,name?:string}} p.actor
 * @returns {Promise<{changed:boolean, before:string|null, orderLink:object}>}
 */
async function chooseOrderLink(ctx, enquiry, { customerRequestId, expectedCustomerRequestId = null, reason = "", actor = {} }) {
  assertServiceContext(ctx, "order link choice");
  const chosen = str(customerRequestId).trim();
  const expected = expectedCustomerRequestId == null ? "" : str(expectedCustomerRequestId).trim();
  const why = str(reason).trim();
  const current = str(enquiry.customerRequestId);
  const changed = () => new OrderLinkError(409, "link_changed",
    "This enquiry's order link changed since you opened it. Reload and choose again.");
  /* One refusal for every order that is not offered — foreign, cancelled,
     superseded, held by another enquiry (including one that won a race for
     it), raised from another enquiry, or non-existent — so the chooser cannot
     be used to probe other orders. */
  const notOffered = () => new OrderLinkError(422, "not_a_candidate",
    "That order cannot be linked to this enquiry. Choose one of the orders listed for it.");

  /* Idempotent retry: the same choice, already recorded as a proved link. */
  if (current && current === chosen) {
    const now = await resolveOrderLink(ctx, enquiry);
    if (now.status === STATUS.LINKED) return { changed: false, before: current, orderLink: now };
  }

  if (current !== expected) throw changed();
  if (current && current !== chosen && why.length < 5) {
    throw new OrderLinkError(400, "reason_required",
      "Say why the linked order is being replaced (at least 5 characters).");
  }

  const candidates = await candidateRequests(ctx, enquiry);
  const pick = candidates.find((r) => str(r._id) === chosen);
  if (!pick) throw notOffered();

  const method = sameId(pick.salesOrigin?.enquiryId, enquiry._id) ? "sales_origin" : "manual";
  const out = await writeLink(ctx, enquiry, pick, { method, actor, reason: why });
  if (!out.ok) throw out.code === "claimed" ? notOffered() : changed();
  return { changed: true, before: current || null, orderLink: await resolveOrderLink(ctx, out.enquiry) };
}

module.exports = {
  STATUS,
  OrderLinkError,
  CLAIM_GRACE_MS,
  ensureOrderLink,
  resolveOrderLink,
  provedOrderFor,
  provedEnquiryForOrder,
  listOrderCandidates,
  chooseOrderLink,
  recordOriginLink,
  claimOrder,
  originHeads,
};
