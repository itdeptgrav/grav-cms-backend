"use strict";
/**
 * services/orderBrief/assembleOrderBrief.test.js
 *
 * The order brief is only worth having if its labels can be trusted, so most
 * of these tests are about what it must NOT say:
 *
 *   - a draft must never be presented as confirmed;
 *   - an internal approval must never be presented as the buyer's;
 *   - an account default must never be presented as this order's agreement;
 *   - a handover that no longer describes the approved order must stop
 *     presenting its contents as the instruction.
 *
 * Pure: no database. The assembler receives already-loaded records, exactly as
 * the service hands them over, and `approvedRevisionOf` is the real R&D rule.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { assembleOrderBrief, contentEvidence, STALE, HANDOVER_STATE } = require("./assembleOrderBrief");
const { resolve, candidate, source, STATUS, AUTHORITY } = require("./facts");
const { approvedRevisionOf } = require("../centralCosting/technicalRecord.service");

/* ── fixtures ──────────────────────────────────────────────────────────── */

const ID = (n) => `64b0000000000000000000${String(n).padStart(2, "0")}`;
const D = (s) => new Date(`2026-${s}T10:00:00Z`);

const LINE = "LN-aaaaaaaaaaaa";
const STYLE_ID = ID(10);

function acceptedQuotation(over = {}) {
  return {
    quotationNumber: "QT-2026-0042",
    revision: 1,
    status: "sales_approved",
    grandTotal: 118000,
    customerApproval: { approved: true, approvedAt: D("08-01"), approvedBy: ID(90), notes: "" },
    salesApproval: { approved: true, approvedAt: D("08-02") },
    /* The realistic default: Sales' approval was the last write to this
       round, so its figures are NOT provable — see the ladder tests. */
    updatedAt: D("08-02"),
    poProof: { poNumber: "PO-7781", poDate: D("07-30"), poValue: 118000, url: "https://drive/po.pdf", name: "po.pdf", uploadedAt: D("08-02") },
    items: [{
      itemName: "Polo shirt", itemCode: "POLO-1", productLineRef: "PL-1",
      sampleStyleId: STYLE_ID, quantity: 500, unitPrice: 200, priceIncludingGST: 236,
      /* Internal fields that must never reach the brief. */
      costingSource: { unitPriceMinor: 15000, priceTier: "floor", fingerprint: "secret" },
    }],
    ...over,
  };
}

/* Accepted by the buyer and never written again: the only shape in which the
   round's figures are provably the ones accepted. */
const untouched = (over = {}) => acceptedQuotation({
  status: "customer_approved",
  salesApproval: {},
  updatedAt: D("08-01"),
  ...over,
});

function request(over = {}) {
  return {
    _id: ID(1),
    requestId: "CR-0001",
    status: "quotation_sales_approved",
    customerInfo: { name: "Acme Retail", deliveryDeadline: D("10-15") },
    createdAt: D("07-20"),
    quotations: [acceptedQuotation()],
    quotationRevisions: [],
    items: [{
      lineRef: LINE,
      productLineRef: "PL-1",
      sampleStyleId: STYLE_ID,
      stockItemName: "Polo shirt",
      totalQuantity: 500,
      variants: [
        { attributes: [{ name: "Size", value: "M" }, { name: "Colour", value: "Navy" }], quantity: 300 },
        { attributes: [{ name: "Size", value: "L" }, { name: "Colour", value: "Navy" }], quantity: 200 },
      ],
      commercialDecision: { floorPriceMinor: 12000, wasBelowFloorException: false },
    }],
    ...over,
  };
}

function version(over = {}) {
  return {
    _id: ID(20),
    handoverRef: "CR-0001",
    handoverLineRef: LINE,
    versionNo: 1,
    sourceRecord: { recordId: ID(1), issuedAt: D("08-05") },
    issuedBy: { name: "Sana (Sales)" },
    publication: { state: "CURRENT" },
    executionProjection: {
      orderRef: "CR-0001", orderLineRef: LINE, styleRef: "SC-J1-01", productName: "Polo shirt",
      sampleStyleId: STYLE_ID, totalQuantity: 500,
      breakdown: [
        { lineSplitRef: "S1", attributes: [{ name: "Colour", value: "Navy" }], sizeRange: "M-L", quantity: 500 },
      ],
      deliveries: [{ dropRef: "D1", committedDeliveryDate: D("10-10"), quantity: 500 }],
      packingRequirement: "Single polybag, 20 per carton",
      testingRequirement: "AQL 2.5 final inspection",
      deliveryRequirement: "Deliver to Bhubaneswar DC",
    },
    ...over,
  };
}

function style(over = {}) {
  return {
    _id: STYLE_ID,
    sampleStyleId: "SS-0001",
    styleCode: "SC-J1-01",
    productName: "Polo shirt",
    sample: {
      status: "approved",
      approvedAt: D("07-25"),
      rounds: [
        { roundNo: 1, type: "fit", outcome: "rejected" },
        { roundNo: 2, type: "pp", outcome: "accepted", judgedAt: D("07-25") },
      ],
    },
    customerApproval: {
      approved: true,
      decidedAt: D("07-26"),
      decidedBy: { name: "Sana (Sales)" },
      note: "Approved, keep collar",
      log: [{ approved: true, decidedAt: D("07-26") }],
    },
    techSheet: {
      status: "approved",
      technical: { status: "approved", revision: 2 },
      file: { name: "techpack-v2.pdf", url: "https://drive/tp2.pdf" },
      technicalRevisions: [
        { revision: 1, outcome: "returned" },
        {
          revision: 2, outcome: "approved", decidedAt: D("07-24"), decidedBy: { name: "Ravi (R&D)" },
          file: { name: "techpack-v2.pdf", url: "https://drive/tp2.pdf" },
          snapshot: { materials: [{ rawItemName: "Pique 220gsm", specification: "100% cotton", unit: "m" }] },
        },
      ],
    },
    ...over,
  };
}

const account = (over = {}) => ({
  accountId: "ACC-0007",
  companyName: "Acme Retail Pvt Ltd",
  garmentSalesProfile: {
    defaultTestingProtocol: "Buyer protocol v3",
    defaultAqlLevel: "AQL 4.0",
    packagingManualRef: "Acme packaging manual 2025",
    requiredCertifications: ["oeko_tex"],
  },
  ...over,
});

function brief(over = {}) {
  const st = over.style === undefined ? style() : over.style;
  return assembleOrderBrief({
    request: over.request || request(),
    enquiry: over.enquiry || null,
    journey: over.journey || null,
    account: over.account === undefined ? null : over.account,
    stylesById: new Map(st ? [[String(st._id), st]] : []),
    handoverVersions: over.versions || [],
    executionFiles: over.files || [],
    trimRevisions: over.trims || [],
    packagingRevisions: over.packaging || [],
    techApprovedOf: approvedRevisionOf,
    now: D("09-01"),
  });
}

const line = (b) => b.lines[0];

/* ═══════════════════════════════════════════════════════════════════════════
 * SOURCE PRECEDENCE — the resolver
 * ══════════════════════════════════════════════════════════════════════════ */

const C = (status, authority, value, note) => candidate({ status, authority, value, note, source: source({ kind: "t" }) });

test("a confirmed answer from a weaker source beats a draft from a stronger one", () => {
  const f = resolve({
    key: "packing",
    label: "Packing",
    candidates: [
      C(STATUS.DRAFT, AUTHORITY.MERCHANDISING, { rev: 3 }),
      C(STATUS.CONFIRMED, AUTHORITY.SALES_HANDOVER, { text: "polybag" }),
    ],
  });
  /* Merchandising's revision in draft is not an instruction yet; the issued
     handover is, until Merchandising approves. */
  assert.equal(f.status, STATUS.CONFIRMED);
  assert.equal(f.authority, AUTHORITY.SALES_HANDOVER);
  assert.equal(f.alsoOnRecord[0].authority, AUTHORITY.MERCHANDISING);
});

test("within the same status, the caller's order is the precedence", () => {
  const f = resolve({
    key: "packing",
    label: "Packing",
    candidates: [
      C(STATUS.CONFIRMED, AUTHORITY.MERCHANDISING, { same: 1 }),
      C(STATUS.CONFIRMED, AUTHORITY.SALES_HANDOVER, { same: 1 }),
    ],
  });
  assert.equal(f.authority, AUTHORITY.MERCHANDISING);
  assert.equal(f.status, STATUS.CONFIRMED);
});

test("two confirmed sources that disagree are NOT confirmed", () => {
  const f = resolve({
    key: "quantity",
    label: "Quantity",
    candidates: [
      C(STATUS.CONFIRMED, AUTHORITY.SALES_HANDOVER, 500),
      C(STATUS.CONFIRMED, AUTHORITY.BUYER, 650),
    ],
  });
  /* Picking the higher-ranked one would present a live contradiction as a
     settled fact. */
  assert.equal(f.status, STATUS.DRAFT);
  assert.equal(f.conflicts.length, 1);
  assert.match(f.note, /the Sales handover and the buyer have each confirmed a different value/);
});

test("a draft or default that disagrees does not demote a confirmed fact", () => {
  const f = resolve({
    key: "quality",
    label: "Quality",
    candidates: [
      C(STATUS.CONFIRMED, AUTHORITY.SALES_HANDOVER, { aql: "2.5" }),
      C(STATUS.DRAFT, AUTHORITY.BUYER_DEFAULT, { aql: "4.0" }),
    ],
  });
  /* An account's standing default differing from what was agreed is the
     normal case, not a conflict. It stays visible, below. */
  assert.equal(f.status, STATUS.CONFIRMED);
  assert.equal(f.alsoOnRecord[0].value.aql, "4.0");
});

test("an explicit 'not applicable' outranks a draft", () => {
  const f = resolve({
    key: "x",
    label: "X",
    candidates: [C(STATUS.DRAFT, AUTHORITY.ENQUIRY, 1), C(STATUS.NOT_APPLICABLE, AUTHORITY.SALES, null)],
  });
  assert.equal(f.status, STATUS.NOT_APPLICABLE);
});

test("no source at all is missing, with the caller's reason", () => {
  const f = resolve({ key: "x", label: "X", candidates: [null, false, 0, ""], missingNote: "Nothing yet." });
  assert.equal(f.status, STATUS.MISSING);
  assert.equal(f.note, "Nothing yet.");
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE COMMERCIAL BASIS
 * ══════════════════════════════════════════════════════════════════════════ */

test("an accepted quotation and its evidenced PO are the buyer's confirmed facts", () => {
  const b = brief();
  assert.equal(b.order.acceptedQuotation.status, STATUS.CONFIRMED);
  assert.equal(b.order.acceptedQuotation.authority, AUTHORITY.BUYER);
  assert.equal(b.order.acceptedQuotation.value.quotationNumber, "QT-2026-0042");
  assert.equal(b.order.purchaseOrder.status, STATUS.CONFIRMED);
  assert.equal(b.order.purchaseOrder.value.poNumber, "PO-7781");
});

test("costing and floor-price data never reach the brief", () => {
  const json = JSON.stringify(brief());
  /* Internal by the model's own declaration. A brief shown beside the buyer's
     documents must not carry them in any field, even one the UI ignores. */
  for (const secret of ["costingSource", "commercialDecision", "floorPriceMinor", "unitPriceMinor", "priceTier", "secret"]) {
    assert.equal(json.includes(secret), false, `"${secret}" leaked into the brief`);
  }
});

test("acceptance recorded on the buyer's behalf says so", () => {
  const q = acceptedQuotation({
    customerApproval: { approved: true, approvedAt: D("08-01"), approvedBy: null, notes: "[On Behalf by Sales] phone call" },
  });
  const b = brief({ request: request({ quotations: [q] }) });
  assert.equal(b.order.acceptedQuotation.status, STATUS.CONFIRMED);
  assert.match(b.order.acceptedQuotation.note, /on the buyer's behalf/);
});

test("a quotation revised after acceptance is a draft basis, not the accepted one", () => {
  const archived = acceptedQuotation({ revision: 1 });
  const redraft = acceptedQuotation({ revision: 2, status: "draft", customerApproval: {}, salesApproval: {}, poProof: {} });
  const b = brief({ request: request({ quotations: [redraft], quotationRevisions: [archived] }) });

  assert.equal(b.order.acceptedQuotation.status, STATUS.DRAFT);
  assert.match(b.order.acceptedQuotation.note, /accepted revision 1, but revision 2 is now being prepared/);
  /* The buyer's PO was issued against revision 1 and is still their PO. */
  assert.equal(b.order.purchaseOrder.status, STATUS.CONFIRMED);
  assert.match(b.order.purchaseOrder.note, /revision 1 was accepted; the quotation is now being revised/);
});

test("a rejected current round is not described as 'being revised'", () => {
  const archived = acceptedQuotation({ revision: 1 });
  const rejected = acceptedQuotation({ revision: 2, status: "rejected", poProof: {} });
  const b = brief({ request: request({ quotations: [rejected], quotationRevisions: [archived] }) });
  assert.equal(b.order.acceptedQuotation.status, STATUS.MISSING);
  assert.match(b.order.acceptedQuotation.note, /latest quotation is rejected/);
});

test("no quotation at all is missing", () => {
  const b = brief({ request: request({ quotations: [] }) });
  assert.equal(b.order.acceptedQuotation.status, STATUS.MISSING);
  assert.equal(b.order.purchaseOrder.status, STATUS.MISSING);
});

test("a PO number with no document is a draft", () => {
  const q = acceptedQuotation({ poProof: { poNumber: "PO-7781" } });
  const b = brief({ request: request({ quotations: [q] }) });
  assert.equal(b.order.purchaseOrder.status, STATUS.DRAFT);
});

test("the journey's PO is used when the quotation holds none, and must be evidenced", () => {
  const q = acceptedQuotation({ poProof: {} });
  const journey = { journeyId: "J-1", po: { number: "PO-7781", file: { url: "https://drive/po.pdf" }, recordedAt: D("08-03"), recordedBy: { name: "Sana" } } };
  const b = brief({ request: request({ quotations: [q] }), journey });
  assert.equal(b.order.purchaseOrder.status, STATUS.CONFIRMED);
  assert.equal(b.order.purchaseOrder.source.kind, "journey_po");

  const bare = brief({ request: request({ quotations: [q] }), journey: { journeyId: "J-1", po: { number: "PO-7781" } } });
  assert.equal(bare.order.purchaseOrder.status, STATUS.DRAFT);
});

test("both PO records naming the same PO agree, whatever the spacing", () => {
  const journey = { journeyId: "J-1", po: { number: "po 7781".replace("po ", "PO-"), file: { url: "https://drive/x.pdf" } } };
  const b = brief({ journey: { ...journey, po: { ...journey.po, number: " po-7781 " } } });
  assert.equal(b.order.purchaseOrder.status, STATUS.CONFIRMED);
  assert.equal(b.order.purchaseOrder.source.kind, "quotation_po_proof");
});

test("two PO records naming different POs are a conflict, not a confirmed PO", () => {
  const journey = { journeyId: "J-1", po: { number: "PO-9999", file: { url: "https://drive/other.pdf" } } };
  const b = brief({ journey });
  assert.equal(b.order.purchaseOrder.status, STATUS.DRAFT);
  assert.equal(b.order.purchaseOrder.conflicts.length, 1);
  assert.equal(b.order.purchaseOrder.conflicts[0].value.poNumber, "PO-9999");
});

/* ═══════════════════════════════════════════════════════════════════════════
 * NO INVENTED APPROVALS
 * ══════════════════════════════════════════════════════════════════════════ */

test("an internally accepted sample round is not buyer approval", () => {
  const st = style({ customerApproval: { approved: null, log: [] } });
  const b = brief({ style: st });
  /* Round 2 is 'accepted' and sample.status is 'approved' — both Sales'
     verdicts. The buyer has said nothing. */
  assert.equal(line(b).facts.sample.status, STATUS.DRAFT);
  assert.match(line(b).facts.sample.note, /buyer's decision is not recorded/);
});

test("the buyer's recorded approval of a settled sample is confirmed, by the buyer", () => {
  const f = line(brief()).facts.sample;
  assert.equal(f.status, STATUS.CONFIRMED);
  assert.equal(f.authority, AUTHORITY.BUYER);
  assert.equal(f.value.round.roundNo, 2);
});

test("a buyer rejection leaves no approved sample, and says why", () => {
  const st = style({ customerApproval: { approved: false, decidedAt: D("07-26"), note: "Collar too wide", log: [] } });
  const f = line(brief({ style: st })).facts.sample;
  assert.equal(f.status, STATUS.MISSING);
  assert.match(f.note, /rejected the sample on 2026-07-26: "Collar too wide"/);
});

test("a waived sample is not applicable", () => {
  const st = style({ sample: { status: "notApplicable", rounds: [] }, customerApproval: {} });
  assert.equal(line(brief({ style: st })).facts.sample.status, STATUS.NOT_APPLICABLE);
});

test("an approved tech pack is R&D's confirmation, never the buyer's", () => {
  const f = line(brief()).facts.techPack;
  assert.equal(f.status, STATUS.CONFIRMED);
  assert.equal(f.authority, AUTHORITY.RND);
  assert.equal(f.value.revision, 2);
  assert.match(f.note, /no buyer approval for tech packs/);
});

test("a submitted tech pack is a draft", () => {
  const st = style({
    techSheet: { status: "submitted", technical: { status: "submitted", revision: 3 }, technicalRevisions: [{ revision: 3, outcome: "submitted" }] },
  });
  assert.equal(line(brief({ style: st })).facts.techPack.status, STATUS.DRAFT);
});

test("buyer account defaults are only ever drafts", () => {
  /* No handover, no Merchandising revisions: the account is the only source. */
  const b = brief({ account: account() });
  const l = line(b);
  assert.equal(l.facts.packing.status, STATUS.DRAFT);
  assert.equal(l.facts.packing.authority, AUTHORITY.BUYER_DEFAULT);
  assert.equal(l.facts.quality.status, STATUS.DRAFT);
  assert.equal(b.order.compliance.status, STATUS.DRAFT);
  assert.deepEqual(b.order.compliance.value.requiredCertifications, ["oeko_tex"]);
});

test("an account with no compliance recorded is missing, not 'not applicable'", () => {
  const b = brief({ account: account({ garmentSalesProfile: {} }) });
  assert.equal(b.order.compliance.status, STATUS.MISSING);
});

test("with no account at all, compliance says it could not be read", () => {
  assert.match(brief().order.compliance.note, /No buyer account could be proved/);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * MISSING DATA
 * ══════════════════════════════════════════════════════════════════════════ */

test("a line with no permanent reference cannot have a handover, and says so", () => {
  const r = request();
  r.items[0].lineRef = undefined;
  const b = brief({ request: r, versions: [version()] });
  assert.equal(line(b).handover.state, HANDOVER_STATE.NO_LINE_REF);
  /* The version exists but cannot be tied to this line by anything but a
     guess, so it is not used. What remains is the accepted quotation's
     quantity — and Sales wrote the round after acceptance, so it is the
     buyer's figure but cannot be proved unchanged. */
  assert.equal(line(b).facts.quantity.authority, AUTHORITY.BUYER);
  assert.equal(line(b).facts.quantity.status, STATUS.DRAFT);
  assert.notEqual(line(b).facts.quantity.authority, AUTHORITY.SALES_HANDOVER);
  assert.equal(b.handover.linesWithoutLineRef, 1);
});

test("an order with no handover and no approvals is mostly draft and missing", () => {
  const r = request({ quotations: [] });
  const b = brief({ request: r, style: null });
  const l = line(b);
  assert.equal(l.handover.state, HANDOVER_STATE.NOT_ISSUED);
  assert.equal(l.facts.quantity.status, STATUS.DRAFT);
  assert.equal(l.facts.quantity.authority, AUTHORITY.ORDER_RECORD);
  assert.equal(l.facts.sizes.status, STATUS.DRAFT);
  assert.equal(l.facts.sample.status, STATUS.MISSING);
  assert.equal(l.facts.techPack.status, STATUS.MISSING);
  assert.equal(l.facts.fabricTrims.status, STATUS.MISSING);
  assert.equal(l.facts.packing.status, STATUS.MISSING);
  assert.equal(b.summary.confirmed, 0);
});

test("sizes are the order's own attributes, not a fixed S–XXL set", () => {
  const b = brief({ request: request(), style: null });
  const splits = line(b).facts.sizes.value.splits;
  assert.deepEqual(splits.map((s) => s.quantity), [300, 200]);
  assert.deepEqual(splits[0].attributes, [{ name: "Size", value: "M" }, { name: "Colour", value: "Navy" }]);
});

test("enquiry fabric requirements are a draft, never a specification", () => {
  const enquiry = { enquiryId: "ENQ-1", products: [{ productLineRef: "PL-1", fabricPreference: "Pique", gsm: "220" }] };
  const st = style({ techSheet: { status: "pending", technical: {}, technicalRevisions: [] } });
  const f = line(brief({ enquiry, style: st })).facts.fabricTrims;
  assert.equal(f.status, STATUS.DRAFT);
  assert.equal(f.authority, AUTHORITY.ENQUIRY);
  assert.equal(f.value.gsm, "220");
});

/* ═══════════════════════════════════════════════════════════════════════════
 * MERCHANDISING SPECIFICATIONS
 * ══════════════════════════════════════════════════════════════════════════ */

const FILE_ID = ID(30);
const file = (over = {}) => ({ _id: FILE_ID, fileNumber: "MEF-2026-0001", handoverLineRef: LINE, currentHandoverVersionId: ID(20), ...over });
const trimRev = (over = {}) => ({
  fileId: FILE_ID, revisionNo: 1, state: "APPROVED", approvedAt: D("08-10"), approvedBy: { name: "Meera (Merch)" },
  rows: [{ group: "FABRIC", componentName: "Pique body", colourOrShade: "Navy 19-4024", specification: "220gsm" }],
  ...over,
});

test("an approved Merchandising trim revision outranks the style's R&D spec", () => {
  const f = line(brief({ versions: [version()], files: [file()], trims: [trimRev()] })).facts.fabricTrims;
  assert.equal(f.status, STATUS.CONFIRMED);
  assert.equal(f.authority, AUTHORITY.MERCHANDISING);
  assert.equal(f.value.rows[0].colourOrShade, "Navy 19-4024");
  assert.equal(f.alsoOnRecord[0].authority, AUTHORITY.RND);
});

test("a Merchandising trim revision in draft does not displace an approved R&D spec", () => {
  const f = line(brief({ versions: [version()], files: [file()], trims: [trimRev({ state: "DRAFT", approvedAt: null, revisionNo: 2 })] })).facts.fabricTrims;
  assert.equal(f.status, STATUS.CONFIRMED);
  assert.equal(f.authority, AUTHORITY.RND);
  assert.equal(f.alsoOnRecord[0].status, STATUS.DRAFT);
});

test("an approved packaging revision outranks the handover's packing text", () => {
  const pack = { fileId: FILE_ID, revisionNo: 1, state: "APPROVED", approvedAt: D("08-11"), rows: [], instructions: { cartonMarks: "ACME / PO-7781" } };
  const f = line(brief({ versions: [version()], files: [file()], packaging: [pack] })).facts.packing;
  assert.equal(f.authority, AUTHORITY.MERCHANDISING);
  /* Asserted separately because authority alone passed while the field was
     wrongly demoted: the revision refines the handover's one-line
     requirement, and the two must not be read as a contradiction. */
  assert.equal(f.status, STATUS.CONFIRMED);
  assert.equal(f.conflicts.length, 0);
  assert.equal(f.value.instructions.cartonMarks, "ACME / PO-7781");
});

test("claims of a different kind never conflict; claims of the same kind still do", () => {
  const two = (claimB) => resolve({
    key: "x",
    label: "X",
    candidates: [
      candidate({ status: STATUS.CONFIRMED, authority: AUTHORITY.MERCHANDISING, claim: "order_selection", value: 1 }),
      candidate({ status: STATUS.CONFIRMED, authority: AUTHORITY.RND, claim: claimB, value: 2 }),
    ],
  });
  assert.equal(two("style_specification").status, STATUS.CONFIRMED);
  assert.equal(two("order_selection").status, STATUS.DRAFT);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * CHANGED VERSIONS — invalidating an older handover
 * ══════════════════════════════════════════════════════════════════════════ */

test("a current handover that nothing has moved is the confirmed instruction", () => {
  const l = line(brief({ versions: [version()] }));
  assert.equal(l.handover.state, HANDOVER_STATE.CURRENT);
  assert.equal(l.handover.stale, false);
  assert.equal(l.facts.delivery.status, STATUS.CONFIRMED);
  assert.equal(l.facts.delivery.authority, AUTHORITY.SALES_HANDOVER);
  assert.equal(l.facts.quality.value.requirement, "AQL 2.5 final inspection");
  /* The handover and the accepted quotation agree on 500. */
  assert.equal(l.facts.quantity.status, STATUS.CONFIRMED);
});

test("a quotation accepted again after issue invalidates the handover", () => {
  /* A real re-acceptance: the buyer accepts revision 2, Sales approves in the
     same minute, and nothing touches the round afterwards. */
  const q = acceptedQuotation({
    revision: 2,
    customerApproval: { approved: true, approvedAt: D("08-20"), approvedBy: ID(90) },
    salesApproval: { approved: true, approvedAt: new Date(D("08-20").getTime() + 1000) },
    updatedAt: new Date(D("08-20").getTime() + 1000),
    items: [{ ...acceptedQuotation().items[0], quantity: 650 }],
  });
  const b = brief({ request: request({ quotations: [q] }), versions: [version()] });
  const l = line(b);

  assert.equal(l.handover.stale, true);
  assert.equal(l.handover.staleReasons[0].code, STALE.QUOTATION_REAPPROVED);
  assert.match(l.handover.staleReasons[0].message, /accepted again on 2026-08-20, after handover version 1 was issued on 2026-08-05/);

  /* Everything taken from the handover is demoted, with the reason beside it. */
  assert.equal(l.facts.delivery.status, STATUS.DRAFT);
  assert.match(l.facts.delivery.note, /handover version 1, which is out of date/);
  assert.equal(l.facts.packing.status, STATUS.DRAFT);

  /* And the quantity the buyer accepted now stands on its own. */
  assert.equal(l.facts.quantity.status, STATUS.CONFIRMED);
  assert.equal(l.facts.quantity.authority, AUTHORITY.BUYER);
  assert.equal(l.facts.quantity.value.totalQuantity, 650);

  assert.equal(b.handover.anyStale, true);
});

test("a quotation reopened for revision invalidates the handover", () => {
  const archived = acceptedQuotation({ revision: 1 });
  const redraft = acceptedQuotation({ revision: 2, status: "draft", customerApproval: {}, salesApproval: {} });
  const l = line(brief({ request: request({ quotations: [redraft], quotationRevisions: [archived] }), versions: [version()] }));
  assert.equal(l.handover.stale, true);
  assert.equal(l.handover.staleReasons[0].code, STALE.QUOTATION_NOT_ACCEPTED);
  assert.match(l.handover.staleReasons[0].message, /revision 2 is draft/);
});

test("a buyer sample decision recorded after issue invalidates the handover", () => {
  const st = style({
    customerApproval: {
      approved: true, decidedAt: D("08-15"), decidedBy: { name: "Sana" },
      log: [{ approved: false, decidedAt: D("08-12") }, { approved: true, decidedAt: D("08-15") }],
    },
  });
  const l = line(brief({ style: st, versions: [version()] }));
  assert.equal(l.handover.stale, true);
  assert.ok(l.handover.staleReasons.some((r) => r.code === STALE.SAMPLE_DECISION_CHANGED));
});

test("a tech pack approved again after issue invalidates the handover", () => {
  const st = style();
  st.techSheet.technical.revision = 3;
  st.techSheet.technicalRevisions.push({ revision: 3, outcome: "approved", decidedAt: D("08-18"), snapshot: { materials: [] } });
  const l = line(brief({ style: st, versions: [version()] }));
  assert.ok(l.handover.staleReasons.some((r) => r.code === STALE.TECH_PACK_REAPPROVED && /revision 3/.test(r.message)));
});

test("an unapproved edit to the order line warns, but does not void the handover", () => {
  const r = request();
  r.items[0].totalQuantity = 650;
  const l = line(brief({ request: r, versions: [version()] }));

  /* Nobody re-approved 650. The buyer's acceptance still supports 500, so the
     handover is still the instruction — and the drift is shown, loudly. */
  assert.equal(l.handover.stale, false);
  assert.equal(l.handover.divergences[0].code, STALE.ORDER_QUANTITY_CHANGED);
  assert.match(l.handover.divergences[0].message, /now says 650 pieces, but handover version 1 was issued for 500/);
  assert.equal(l.facts.delivery.status, STATUS.CONFIRMED);
  assert.equal(l.facts.quantity.status, STATUS.CONFIRMED);
  assert.equal(l.facts.quantity.value.totalQuantity, 500);
  assert.equal(l.facts.quantity.alsoOnRecord.find((c) => c.authority === AUTHORITY.ORDER_RECORD).value.totalQuantity, 650);
});

test("a style swapped on the order line is a divergence, not a silent pass", () => {
  const r = request();
  r.items[0].sampleStyleId = ID(11);
  const l = line(brief({ request: r, versions: [version()], style: null }));
  assert.ok(l.handover.divergences.some((d) => d.code === STALE.STYLE_CHANGED));
});

test("a handover issued with a different quantity from the accepted quotation is not confirmed", () => {
  /* Accepted 650 before issue; the handover was issued for 500. No timeline
     moved — the two approvals simply disagree, and the resolver refuses to
     pick one. */
  const q = untouched({ items: [{ ...acceptedQuotation().items[0], quantity: 650 }] });
  const l = line(brief({ request: request({ quotations: [q] }), versions: [version()] }));
  assert.equal(l.handover.stale, false);
  assert.equal(l.facts.quantity.status, STATUS.DRAFT);
  assert.equal(l.facts.quantity.conflicts.length, 1);
});

test("an unprovable quotation figure does not manufacture a conflict", () => {
  /* The same disagreement, but the quotation's 650 cannot be shown to be
     what the buyer accepted — so it is a draft beside the handover's 500,
     visible, and not a confirmed contradiction. */
  const q = acceptedQuotation({ items: [{ ...acceptedQuotation().items[0], quantity: 650 }] });
  const f = line(brief({ request: request({ quotations: [q] }), versions: [version()] })).facts.quantity;
  assert.equal(f.status, STATUS.CONFIRMED);
  assert.equal(f.authority, AUTHORITY.SALES_HANDOVER);
  const quoted = f.alsoOnRecord.find((c) => c.authority === AUTHORITY.BUYER);
  assert.equal(quoted.status, STATUS.DRAFT);
  assert.equal(quoted.value.totalQuantity, 650);
});

test("only the CURRENT version is the instruction; superseded ones are history", () => {
  const v1 = version({
    _id: ID(21), versionNo: 1,
    publication: { state: "SUPERSEDED", supersededAt: D("08-09"), supersededByVersionId: ID(22) },
    executionProjection: { ...version().executionProjection, packingRequirement: "Old packing" },
  });
  const v2 = version({ _id: ID(22), versionNo: 2, sourceRecord: { issuedAt: D("08-09") } });
  const l = line(brief({ versions: [v2, v1] }));

  assert.equal(l.handover.current.versionNo, 2);
  assert.deepEqual(l.handover.history.map((h) => [h.versionNo, h.state]), [[1, "SUPERSEDED"], [2, "CURRENT"]]);
  assert.equal(l.facts.packing.value.requirement, "Single polybag, 20 per carton");
});

test("Merchandising still working from an older version is surfaced", () => {
  const v1 = version({ _id: ID(21), versionNo: 1, publication: { state: "SUPERSEDED" } });
  const v2 = version({ _id: ID(22), versionNo: 2 });
  const l = line(brief({ versions: [v1, v2], files: [file({ currentHandoverVersionId: ID(21) })] }));
  assert.equal(l.handover.merchandising.acceptedVersionNo, 1);
  assert.equal(l.handover.merchandising.workingFromOlderVersion, true);
});

test("a cancelled handover is not an instruction", () => {
  const v = version({ publication: { state: "CANCELLED", cancelledAt: D("08-09") } });
  const l = line(brief({ versions: [v] }));
  assert.equal(l.handover.state, HANDOVER_STATE.CANCELLED);
  assert.notEqual(l.facts.delivery.authority, AUTHORITY.SALES_HANDOVER);
  assert.notEqual(l.facts.packing.authority, AUTHORITY.SALES_HANDOVER);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE FINGERPRINT
 * ══════════════════════════════════════════════════════════════════════════ */

test("the fingerprint moves with confirmed content, and only with it", () => {
  const base = brief({ versions: [version()] }).fingerprint;
  assert.equal(brief({ versions: [version()] }).fingerprint, base, "a re-read must not move it");

  const v = version();
  v.executionProjection.packingRequirement = "Double polybag";
  assert.notEqual(brief({ versions: [v] }).fingerprint, base, "a confirmed change must move it");

  /* The enquiry is only ever a draft source, and here it does not even win. */
  const enquiry = { enquiryId: "ENQ-1", products: [{ productLineRef: "PL-1", gsm: "999" }] };
  assert.equal(brief({ versions: [version()], enquiry }).fingerprint, base, "a draft-only change must not move it");
});

test("the brief declares itself a read model, not a stored document", () => {
  const b = brief();
  assert.equal(b.kind, "read_model");
  assert.equal(typeof b.fingerprint, "string");
  assert.equal(b.request.buyerName, "Acme Retail");
});


/* ═══════════════════════════════════════════════════════════════════════════
 * EDITED AFTER ACCEPTANCE
 *
 * `POST /requests/:id/quotation` rewrites an accepted round in place with no
 * new buyer approval, and nothing keeps the accepted version. These pin the
 * only honest reading of the one trace an edit leaves — the round's
 * `updatedAt` — and the rule that a figure is buyer-confirmed only while it is
 * provably the one the buyer accepted.
 * ══════════════════════════════════════════════════════════════════════════ */

const at = (s, ms = 0) => new Date(D(s).getTime() + ms);

test("the ladder: nothing written after acceptance is provably unchanged", () => {
  const ev = contentEvidence(untouched());
  assert.equal(ev.state, "unchanged");
});

test("the ladder: a later write explained by Sales' approval is unprovable, not clean", () => {
  const ev = contentEvidence(acceptedQuotation());
  /* Sales' approval explains the LAST write. An edit between the buyer's
     acceptance and that approval would leave the very same trace. */
  assert.equal(ev.state, "unprovable");
  assert.equal(ev.explainedBy, "Sales' approval");
});

test("the ladder: a later write nothing explains is an edit", () => {
  const ev = contentEvidence(acceptedQuotation({ updatedAt: D("08-09") }));
  assert.equal(ev.state, "edited");
  assert.equal(ev.lastModifiedAt.slice(0, 10), "2026-08-09");
});

test("the ladder: a payment recorded after an edit masks it, and is not read as proof", () => {
  /* Edited on 08-09, then a payment on 08-12: `updatedAt` now points at the
     payment. The edit cannot be seen — which is exactly why this is
     'unprovable' and never 'unchanged'. */
  const ev = contentEvidence(acceptedQuotation({
    updatedAt: at("08-12", 200),
    paymentSubmissions: [{ submissionDate: D("08-12"), createdAt: D("08-12"), updatedAt: D("08-12") }],
  }));
  assert.equal(ev.state, "unprovable");
  assert.equal(ev.explainedBy, "a payment submission");
});

test("the ladder: missing timestamps prove nothing", () => {
  assert.equal(contentEvidence(acceptedQuotation({ updatedAt: undefined })).state, "unprovable");
  assert.equal(contentEvidence(untouched({ customerApproval: {} , salesApproval: {} })).state, "unprovable");
});

test("an untouched accepted quotation: total, quantity and price are the buyer's", () => {
  const b = brief({ request: request({ quotations: [untouched()] }) });
  assert.equal(b.order.acceptedTotal.status, STATUS.CONFIRMED);
  assert.equal(b.order.acceptedTotal.authority, AUTHORITY.BUYER);
  assert.equal(line(b).facts.quantity.status, STATUS.CONFIRMED);
  assert.equal(line(b).facts.price.status, STATUS.CONFIRMED);
  assert.equal(line(b).facts.price.value.unitPrice, 200);
  assert.equal(b.summary.needsReconfirmation, 0);
});

test("the acceptance is a confirmed event; its figures are separate facts", () => {
  const q = acceptedQuotation({ updatedAt: D("08-09") });
  const f = brief({ request: request({ quotations: [q] }) }).order.acceptedQuotation;
  /* That the buyer accepted revision 1 on 1 Aug is still true after any edit. */
  assert.equal(f.status, STATUS.CONFIRMED);
  assert.equal(f.value.contentSinceAcceptance, "edited");
  /* And it carries no figure an edit could have changed under its label. */
  assert.equal("grandTotal" in f.value, false);
  assert.equal("lines" in f.value, false);
  assert.match(f.note, /changed since/);
});

test("an edited quotation's figures need the buyer's reconfirmation, and are never buyer-confirmed", () => {
  const q = acceptedQuotation({
    updatedAt: D("08-09"),
    grandTotal: 131000,
    items: [{ ...acceptedQuotation().items[0], quantity: 560, unitPrice: 210 }],
  });
  const b = brief({ request: request({ quotations: [q] }) });
  const l = line(b);

  for (const f of [l.facts.quantity, l.facts.price]) {
    assert.equal(f.status, STATUS.DRAFT);
    assert.equal(f.needsReconfirmation, true);
    assert.match(f.note, /changed on 2026-08-09, after the buyer accepted it on 2026-08-01/);
  }
  assert.equal(l.facts.quantity.value.totalQuantity, 560);

  /* The buyer's PO still says ₹1,18,000: that figure stands, confirmed, and
     the edited total waits beside it. */
  const t = b.order.acceptedTotal;
  assert.equal(t.status, STATUS.CONFIRMED);
  assert.equal(t.source.kind, "quotation_po_proof");
  assert.equal(t.value.grandTotal, 118000);
  const edited = t.alsoOnRecord.find((c) => c.source.kind === "quotation");
  assert.equal(edited.value.grandTotal, 131000);
  assert.equal(edited.needsReconfirmation, true);

  assert.ok(b.summary.needsReconfirmation >= 2);
});

test("an edit that left the total equal to the buyer's PO still leaves line prices unconfirmed", () => {
  /* Quantity up, price down, same total: the PO corroborates the total and
     nothing corroborates the lines. */
  const q = acceptedQuotation({
    updatedAt: D("08-09"),
    items: [{ ...acceptedQuotation().items[0], quantity: 590, unitPrice: 169.49 }],
  });
  const b = brief({ request: request({ quotations: [q] }) });
  assert.equal(b.order.acceptedTotal.status, STATUS.CONFIRMED);
  assert.match(b.order.acceptedTotal.note, /buyer's PO/);
  assert.equal(line(b).facts.price.status, STATUS.DRAFT);
  assert.equal(line(b).facts.price.needsReconfirmation, true);
});

test("an unprovable (but not edited) quotation is draft, without a reconfirmation alarm", () => {
  const b = brief();
  const f = line(b).facts.price;
  assert.equal(f.status, STATUS.DRAFT);
  /* No positive evidence of an edit: honest, and not alarming. */
  assert.equal(f.needsReconfirmation, false);
  assert.match(f.note, /cannot be proved to be the one the buyer accepted/);
  /* The total is still confirmed — by the buyer's PO. */
  assert.equal(b.order.acceptedTotal.status, STATUS.CONFIRMED);
  assert.equal(b.summary.needsReconfirmation, 0);
});

test("a provably unchanged total that disagrees with the buyer's PO is not confirmed", () => {
  const b = brief({ request: request({ quotations: [untouched({ grandTotal: 131000 })] }) });
  assert.equal(b.order.acceptedTotal.status, STATUS.DRAFT);
  assert.equal(b.order.acceptedTotal.conflicts.length, 1);
});

test("an edit after the handover was issued is a divergence, not an invalidation", () => {
  const q = acceptedQuotation({ updatedAt: D("08-09") });
  const l = line(brief({ request: request({ quotations: [q] }), versions: [version()] }));
  assert.equal(l.handover.stale, false);
  assert.ok(l.handover.divergences.some((d) => d.code === STALE.QUOTATION_EDITED));
});

test("R&D approval is never presented as the buyer's", () => {
  const b = brief({ request: request({ quotations: [untouched()] }) });
  const facts = [...Object.values(b.order), ...Object.values(line(b).facts)];
  for (const f of facts) {
    if (f.authority !== AUTHORITY.RND) continue;
    assert.notEqual(f.authority, AUTHORITY.BUYER);
    /* Wherever R&D confirms something on a buyer brief, it says whose
       approval that is — or it is the fabric spec, which says so itself. */
    assert.match(f.note, /no buyer approval|approved technical record/);
  }
  assert.equal(line(b).facts.techPack.authority, AUTHORITY.RND);
});

test("reconfirmation is only ever a flag on a draft", () => {
  assert.throws(
    () => candidate({ status: STATUS.CONFIRMED, needsReconfirmation: true }),
    /Only a draft can need reconfirmation/,
  );
});
