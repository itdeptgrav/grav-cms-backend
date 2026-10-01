"use strict";
// test/merchandising/fulfilment-model-projection.test.js
//
// HOW AN ORDER IS FULFILLED HAS TO REACH MERCHANDISING.
//
// Sales has stamped `fulfilmentModel` on the confirmed line for some time and
// stored it on the accepted projection. Neither allowlisted view returned it,
// so every screen downstream believed every order was the same kind — and the
// one that is not is exactly the one where the CUSTOMER supplies the material.
//
// This pins the fact travelling, and pins the legacy default, which is the
// half that is easy to get wrong: an order issued before Sales stamped
// anything must read as what the company actually did then, not as blank.

const { handoverView, fileView } = require("../../services/merchandising/execution.service");
const {
  ORDER_FULFILMENT_MODELS, DEFAULT_ORDER_FULFILMENT_MODEL,
} = require("../../constants/orderFulfilment");

const projection = (over = {}) => ({
  orderRef: "ORD-1", orderLineRef: "LN-abc123abc123",
  styleRef: "ST-1", buyerStyleRef: "BS-1", productName: "Polo",
  totalQuantity: 500, deliveries: [], breakdown: [], allocations: [],
  ...over,
});

const version = (over = {}) => ({
  _id: "v1", companyId: "c1", versionNo: 1,
  handoverRef: "ORD-1", handoverLineRef: "LN-abc123abc123",
  publication: { state: "CURRENT" },
  sourceRecord: { recordType: "customer_request", sourceVersion: "3" },
  executionProjection: projection(over),
});

const file = (over = {}) => ({
  _id: "f1", companyId: "c1", fileNumber: "MEF-2026-0001",
  handoverRef: "ORD-1", handoverLineRef: "LN-abc123abc123",
  lifecycleStatus: "OPEN", revision: 0,
  currentExecutionProjection: projection(over),
});

describe("fulfilmentModel reaches Merchandising", () => {
  test("JOB_WORK travels on the handover and on the file", () => {
    expect(handoverView(version({ fulfilmentModel: "JOB_WORK" }), null).fulfilmentModel)
      .toBe("JOB_WORK");
    expect(fileView(file({ fulfilmentModel: "JOB_WORK" })).fulfilmentModel)
      .toBe("JOB_WORK");
  });

  test("FULL_PACKAGE travels on both too", () => {
    expect(handoverView(version({ fulfilmentModel: "FULL_PACKAGE" }), null).fulfilmentModel)
      .toBe("FULL_PACKAGE");
    expect(fileView(file({ fulfilmentModel: "FULL_PACKAGE" })).fulfilmentModel)
      .toBe("FULL_PACKAGE");
  });

  /* ── THE LEGACY HALF ─────────────────────────────────────────────────
     A handover issued before Sales stamped the model carries nothing. The
     answer is the model the company had before the distinction existed —
     never "", which every screen downstream would have to guess about. */
  test("a handover with no stored model reads as the pre-existing default", () => {
    for (const missing of [undefined, null, ""]) {
      expect(handoverView(version({ fulfilmentModel: missing }), null).fulfilmentModel)
        .toBe(DEFAULT_ORDER_FULFILMENT_MODEL);
      expect(fileView(file({ fulfilmentModel: missing })).fulfilmentModel)
        .toBe(DEFAULT_ORDER_FULFILMENT_MODEL);
    }
    expect(DEFAULT_ORDER_FULFILMENT_MODEL).toBe("FULL_PACKAGE");
  });

  test("a value nobody defined never reaches the screen as itself", () => {
    /* A screen that branches on this must never see a third thing. */
    const out = handoverView(version({ fulfilmentModel: "SOMETHING_ELSE" }), null);
    expect(ORDER_FULFILMENT_MODELS).toContain(out.fulfilmentModel);
    expect(out.fulfilmentModel).toBe(DEFAULT_ORDER_FULFILMENT_MODEL);
  });

  test("it is never absent from either view", () => {
    for (const view of [handoverView(version(), null), fileView(file())]) {
      expect(view).toHaveProperty("fulfilmentModel");
      expect(typeof view.fulfilmentModel).toBe("string");
      expect(view.fulfilmentModel).not.toBe("");
    }
  });

  /* ── AND NOTHING ELSE CAME WITH IT ───────────────────────────────────
     The projection is an allowlist. Exposing one field must not become a
     door for the commercial ones beside it. */
  test("exposing it opened no other field", () => {
    const out = handoverView(version({
      fulfilmentModel: "JOB_WORK",
      unitPrice: 4.5, currency: "USD", margin: 0.3, supplierId: "s1",
    }), null);
    for (const banned of ["unitPrice", "currency", "margin", "supplierId"]) {
      expect(out).not.toHaveProperty(banned);
    }
  });

  test("there is exactly one order-type field, not a second flag", () => {
    const out = fileView(file({ fulfilmentModel: "JOB_WORK" }));
    const typeish = Object.keys(out).filter((k) => /jobwork|job_work|ordertype|isjob/i.test(k));
    expect(typeish).toEqual([]);
  });
});
