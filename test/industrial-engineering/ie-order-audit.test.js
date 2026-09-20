// test/industrial-engineering/ie-order-audit.test.js
//
// IE CHUNK 1C — THE AUDIT CLASSIFIER, AS ARITHMETIC.
//
// The audit's whole value is that it counts what the ENDPOINT would do, so the
// classifier has to agree with the accepted Chunk 1B rules on every shape the
// real data can take. These are synthetic fixtures on purpose: a branch proved
// against whatever the live database happens to hold this week is a branch
// nobody can re-prove next week.
//
// No database, no network — `TEST_WITHOUT_MONGO` keeps the shared harness from
// starting one for a suite that never touches a collection.
"use strict";
process.env.TEST_WITHOUT_MONGO = "1";

const mongoose = require("mongoose");
const {
  COMPANY_ATTRIBUTION, STYLE_LINK_STATUS, STATUS_CLASS,
  statusClassOf, classifyOrder,
} = require("../../services/industrialEngineering/ieOrderAudit");

const id = () => new mongoose.Types.ObjectId();

const CO_A = "company-a";
const CO_B = "company-b";

/** A work order, in the shape the audit reads it from the collection. */
const order = ({ stockItemId, customerRequestId, status = "planned", number = "WO-1" } = {}) => ({
  _id: id(), workOrderNumber: number, status,
  ...(stockItemId ? { stockItemId } : {}),
  ...(customerRequestId ? { customerRequestId } : {}),
});

const request = (items, extra = {}) => ({ _id: id(), items, ...extra });

/** A company lookup built from an explicit map — never from anything inferred. */
const owner = (map) => (styleId) => map[String(styleId)] || null;

/* ══ THE SEVEN STYLE-LINK STATES ══════════════════════════════════════════ */

describe("style-link classification", () => {
  test("DIRECT_WORK_ORDER_REFERENCE — only a style naming the order", () => {
    const style = id();
    const out = classifyOrder({
      order: order({ stockItemId: id() }),
      directStyleIds: [style],
      companyOf: owner({ [style]: CO_A }),
    });
    expect(out.styleLinkStatus).toBe(STYLE_LINK_STATUS.DIRECT_WORK_ORDER_REFERENCE);
    expect(out.companyAttribution).toBe(COMPANY_ATTRIBUTION.ONE_COMPANY);
    expect(out.visibleToOneCompany).toBe(true);
    expect(out.displayableStyles).toBe(1);
    /* No request at all is its own fact, not a missing one. */
    expect(out.flags).toContain("NO_CUSTOMER_REQUEST_REFERENCE");
  });

  test("UNIQUE_ORDER_LINE_REFERENCE — only the request line", () => {
    const stockItemId = id();
    const style = id();
    const out = classifyOrder({
      order: order({ stockItemId, customerRequestId: id() }),
      request: request([{ stockItemId, sampleStyleId: style }]),
      companyOf: owner({ [style]: CO_A }),
    });
    expect(out.styleLinkStatus).toBe(STYLE_LINK_STATUS.UNIQUE_ORDER_LINE_REFERENCE);
    expect(out.lineResolution).toBe("RESOLVED");
    expect(out.visibleToOneCompany).toBe(true);
  });

  test("BOTH_REFERENCES_AGREE — the two paths name the same style", () => {
    const stockItemId = id();
    const style = id();
    const out = classifyOrder({
      order: order({ stockItemId, customerRequestId: id() }),
      request: request([{ stockItemId, sampleStyleId: style }]),
      directStyleIds: [style],
      companyOf: owner({ [style]: CO_A }),
    });
    expect(out.styleLinkStatus).toBe(STYLE_LINK_STATUS.BOTH_REFERENCES_AGREE);
    expect(out.displayableStyles).toBe(1);
  });

  test("REFERENCES_CONFLICT — the two paths name different styles", () => {
    /* The state a reviewer most needs to see: both references are stored, both
       are order-specific, and they disagree. Nothing in the records says which
       is right, so this cannot be called full readiness. */
    const stockItemId = id();
    const direct = id();
    const line = id();
    const out = classifyOrder({
      order: order({ stockItemId, customerRequestId: id() }),
      request: request([{ stockItemId, sampleStyleId: line }]),
      directStyleIds: [direct],
      companyOf: owner({ [direct]: CO_A, [line]: CO_A }),
    });
    expect(out.styleLinkStatus).toBe(STYLE_LINK_STATUS.REFERENCES_CONFLICT);
    expect(out.directStyleCount).toBe(1);
    expect(out.lineStyleCount).toBe(1);
  });

  test("AMBIGUOUS_ORDER_LINES — two lines share the product", () => {
    const stockItemId = id();
    const s1 = id();
    const s2 = id();
    const out = classifyOrder({
      order: order({ stockItemId, customerRequestId: id() }),
      request: request([
        { stockItemId, sampleStyleId: s1 },
        { stockItemId, sampleStyleId: s2 },
      ]),
      companyOf: owner({ [s1]: CO_A, [s2]: CO_A }),
    });
    expect(out.styleLinkStatus).toBe(STYLE_LINK_STATUS.AMBIGUOUS_ORDER_LINES);
    expect(out.flags).toContain("SHARED_PRODUCT_REQUEST_LINES");
    /* Both candidates are one company's, so the order IS attributable — and
       has no style to show, which the page must state rather than imply. */
    expect(out.companyAttribution).toBe(COMPANY_ATTRIBUTION.ONE_COMPANY);
    expect(out.visibleToOneCompany).toBe(true);
    expect(out.displayableStyles).toBe(0);
  });

  test("UNRESOLVED_ORDER_LINE — no line matches the order's product", () => {
    const out = classifyOrder({
      order: order({ stockItemId: id(), customerRequestId: id() }),
      request: request([{ stockItemId: id(), sampleStyleId: id() }]),
      companyOf: owner({}),
    });
    expect(out.styleLinkStatus).toBe(STYLE_LINK_STATUS.UNRESOLVED_ORDER_LINE);
    expect(out.flags).toContain("NO_REQUEST_LINE_MATCHING_PRODUCT");
    expect(out.companyAttribution).toBe(COMPANY_ATTRIBUTION.NO_COMPANY_PROOF);
    expect(out.visibleToOneCompany).toBe(false);
  });

  test("UNRESOLVED_ORDER_LINE — the matching line carries no style id", () => {
    const stockItemId = id();
    const out = classifyOrder({
      order: order({ stockItemId, customerRequestId: id() }),
      request: request([{ stockItemId }]),
      companyOf: owner({}),
    });
    expect(out.styleLinkStatus).toBe(STYLE_LINK_STATUS.UNRESOLVED_ORDER_LINE);
    expect(out.flags).toContain("REQUEST_LINE_MISSING_STYLE_ID");
  });

  test("NO_STYLE_REFERENCE — nothing names it and there is no request", () => {
    const out = classifyOrder({ order: order({ stockItemId: id() }), companyOf: owner({}) });
    expect(out.styleLinkStatus).toBe(STYLE_LINK_STATUS.NO_STYLE_REFERENCE);
    expect(out.companyAttribution).toBe(COMPANY_ATTRIBUTION.NO_COMPANY_PROOF);
  });
});

/* ══ COMPANY ATTRIBUTION ══════════════════════════════════════════════════ */

describe("company attribution comes from SampleStyle ownership alone", () => {
  test("MULTIPLE_COMPANIES — the order's own references span two companies", () => {
    const stockItemId = id();
    const mine = id();
    const theirs = id();
    const out = classifyOrder({
      order: order({ stockItemId, customerRequestId: id() }),
      request: request([{ stockItemId, sampleStyleId: theirs }]),
      directStyleIds: [mine],
      companyOf: owner({ [mine]: CO_A, [theirs]: CO_B }),
    });
    expect(out.companyAttribution).toBe(COMPANY_ATTRIBUTION.MULTIPLE_COMPANIES);
    expect(out.companies).toEqual([CO_A, CO_B].sort());
    /* Not displayable to either — admitting it for one would expose an order
       the other has an equal claim to. */
    expect(out.visibleToOneCompany).toBe(false);
    expect(out.displayableStyles).toBe(0);
  });

  test("a referenced style that does not exist is NO_COMPANY_PROOF and flagged", () => {
    const ghost = id();
    const out = classifyOrder({
      order: order({ stockItemId: id() }),
      directStyleIds: [ghost],
      companyOf: owner({}),
      knownStyleIds: new Set(),
    });
    expect(out.flags).toContain("REFERENCED_STYLE_MISSING");
    expect(out.flags).toContain("STYLE_OWNERSHIP_UNPROVABLE");
    expect(out.companyAttribution).toBe(COMPANY_ATTRIBUTION.NO_COMPANY_PROOF);
  });

  test("a style that exists but cannot be attributed is unprovable, not missing", () => {
    const orphan = id();
    const out = classifyOrder({
      order: order({ stockItemId: id() }),
      directStyleIds: [orphan],
      companyOf: owner({}),
      knownStyleIds: new Set([String(orphan)]),
    });
    expect(out.flags).toContain("STYLE_OWNERSHIP_UNPROVABLE");
    expect(out.flags).not.toContain("REFERENCED_STYLE_MISSING");
    expect(out.companyAttribution).toBe(COMPANY_ATTRIBUTION.NO_COMPANY_PROOF);
  });

  test("one proven style plus one unprovable is NOT one-company", () => {
    /* Fail closed. Half an attribution is not an attribution — the unprovable
       style could belong to anybody, including somebody else. */
    const stockItemId = id();
    const proven = id();
    const unknown = id();
    const out = classifyOrder({
      order: order({ stockItemId, customerRequestId: id() }),
      request: request([{ stockItemId, sampleStyleId: unknown }]),
      directStyleIds: [proven],
      companyOf: owner({ [proven]: CO_A }),
    });
    expect(out.companyAttribution).toBe(COMPANY_ATTRIBUTION.NO_COMPANY_PROOF);
    expect(out.visibleToOneCompany).toBe(false);
  });
});

/* ══ MISSING RECORDS AND STATUS ═══════════════════════════════════════════ */

describe("data-quality flags", () => {
  test("a work order naming a request that is not there is flagged", () => {
    const out = classifyOrder({
      order: order({ stockItemId: id(), customerRequestId: id() }),
      request: null,
      companyOf: owner({}),
    });
    expect(out.flags).toContain("MISSING_CUSTOMER_REQUEST");
    expect(out.flags).not.toContain("NO_CUSTOMER_REQUEST_REFERENCE");
    expect(out.styleLinkStatus).toBe(STYLE_LINK_STATUS.NO_STYLE_REFERENCE);
  });

  test("a missing product and a missing number are each flagged", () => {
    const out = classifyOrder({
      order: { _id: id(), status: "planned" },
      companyOf: owner({}),
    });
    expect(out.flags).toEqual(expect.arrayContaining([
      "MISSING_STOCK_ITEM", "MISSING_WORK_ORDER_NUMBER", "NO_CUSTOMER_REQUEST_REFERENCE",
    ]));
  });
});

describe("status classification uses the model's own enum", () => {
  test("every declared status lands in exactly one bucket", () => {
    const expected = {
      pending: STATUS_CLASS.OPERATIONAL, planned: STATUS_CLASS.OPERATIONAL,
      scheduled: STATUS_CLASS.OPERATIONAL, ready_to_start: STATUS_CLASS.OPERATIONAL,
      in_progress: STATUS_CLASS.OPERATIONAL, paused: STATUS_CLASS.OPERATIONAL,
      delayed: STATUS_CLASS.OPERATIONAL, partial_allocation: STATUS_CLASS.OPERATIONAL,
      forwarded: STATUS_CLASS.OPERATIONAL,
      completed: STATUS_CLASS.COMPLETED,
      cancelled: STATUS_CLASS.CANCELLED,
    };
    for (const [status, bucket] of Object.entries(expected)) {
      expect(statusClassOf({ status })).toBe(bucket);
    }
  });

  test("an unknown or absent status is UNRECOGNISED, never counted as open", () => {
    /* A status the enum does not declare must not inflate the operational
       denominator — that is the number the readiness verdict rests on. */
    for (const status of ["", null, undefined, "on_hold", "archived", "PLANNED"]) {
      expect(statusClassOf({ status })).toBe(STATUS_CLASS.UNRECOGNISED);
    }
    expect(statusClassOf({})).toBe(STATUS_CLASS.UNRECOGNISED);
    expect(classifyOrder({ order: order({ status: "on_hold" }), companyOf: owner({}) }).statusClass)
      .toBe(STATUS_CLASS.UNRECOGNISED);
  });
});

describe("the classifier agrees with the accepted resolver", () => {
  test("it calls resolveOrderLine rather than re-deciding the line rule", () => {
    /* The request-level style is usable only on a single-line request — the
       accepted rule. If this file had its own copy, this is where the two
       would drift. */
    const stockItemId = id();
    const style = id();
    const single = classifyOrder({
      order: order({ stockItemId, customerRequestId: id() }),
      request: request([], { sampleStyleId: style }),
      companyOf: owner({ [style]: CO_A }),
    });
    expect(single.styleLinkStatus).toBe(STYLE_LINK_STATUS.UNIQUE_ORDER_LINE_REFERENCE);

    const multi = classifyOrder({
      order: order({ stockItemId, customerRequestId: id() }),
      request: request(
        [{ stockItemId: id(), sampleStyleId: style }, { stockItemId }],
        { sampleStyleId: style },
      ),
      companyOf: owner({ [style]: CO_A }),
    });
    expect(multi.styleLinkStatus).toBe(STYLE_LINK_STATUS.UNRESOLVED_ORDER_LINE);
  });
});
