// test/costing/costing-contract.test.js
//
// Central Costing — Chunk 1. THE RULES, WITHOUT A ROUTE.
//
// The capability mapping, the visibility layer, the money conventions and the
// legacy adapter are all pure. Exercising them here rather than only through
// HTTP means a rule can be checked at the point it is written — the reason
// `services/crmCostVisibility.js` was extracted from the enquiry router in the
// first place.
"use strict";

const capabilities = require("../../services/centralCosting/capabilities");
const visibility = require("../../services/centralCosting/visibility");
const money = require("../../services/centralCosting/money");
const adapter = require("../../services/centralCosting/legacyEnquiryCostingAdapter");

const { CAPABILITIES } = capabilities;

const ctxWith = (list) => ({ capabilitySet: new Set(list), capabilities: list, companyId: "c1" });

describe("the capability mapping", () => {
  test("every capability the chunk names exists, and nothing else does", () => {
    expect([...capabilities.ALL].sort()).toEqual([
      "costing.approve",
      "costing.cost.read",
      "costing.draft.write",
      "costing.margin.read",
      "costing.output.read",
      "costing.policy.manage",
    ]);
  });

  test("no grant, no capabilities — authentication is not authorisation", () => {
    expect(capabilitiesFrom([])).toEqual([]);
    expect(capabilitiesFrom([{ departmentSlug: "sales", role: "" }])).toEqual([]);
  });

  test("only sales and ceo are mapped; every other department grants nothing", () => {
    /* Not an oversight — Store, Merchandising, R&D, PM and the accountant
       module each need a business decision before they can hold any of this.
       Until then they hold none of it, and the decision record says so. */
    for (const slug of ["store", "inventory", "merchandiser", "research-development",
      "project-manager", "accountant", "accounting", "hr", "developer", "access"]) {
      expect(capabilitiesFrom([{ departmentSlug: slug, role: "owner" }])).toEqual([]);
    }
    expect(Object.keys(capabilities.GRANTS).sort()).toEqual(["ceo", "sales"]);
  });

  test("a Sales grant of any rank carries approved output and nothing more", () => {
    for (const role of ["viewer", "editor", "approver", "owner"]) {
      expect(capabilitiesFrom([{ departmentSlug: "sales", role }])).toEqual([CAPABILITIES.OUTPUT_READ]);
    }
  });

  test("the CEO authority and a platform admin hold everything", () => {
    expect(capabilitiesFrom([{ departmentSlug: "ceo", role: "viewer" }]).sort())
      .toEqual([...capabilities.ALL].sort());
    expect(capabilities.capabilitiesFromGrants([], true).capabilities.sort())
      .toEqual([...capabilities.ALL].sort());
  });

  function capabilitiesFrom(rows) {
    return capabilities.capabilitiesFromGrants(rows, false).capabilities;
  }
});

describe("who may know a costing exists", () => {
  const draft = [{ status: "DRAFT" }];
  const approved = [{ status: "DRAFT" }, { status: "APPROVED" }];

  test("an output-only reader sees an approved costing and not a draft", () => {
    const sales = ctxWith([CAPABILITIES.OUTPUT_READ]);
    expect(visibility.mayRead(sales, { versions: draft })).toBe(false);
    expect(visibility.mayRead(sales, { versions: approved })).toBe(true);
  });

  test("anyone with an internal capability sees the record whatever its state", () => {
    for (const cap of [CAPABILITIES.COST_READ, CAPABILITIES.DRAFT_WRITE,
      CAPABILITIES.APPROVE, CAPABILITIES.MARGIN_READ]) {
      expect(visibility.mayRead(ctxWith([cap]), { versions: draft })).toBe(true);
    }
  });

  test("no capability at all sees nothing", () => {
    expect(visibility.mayRead(ctxWith([]), { versions: approved })).toBe(false);
  });
});

describe("what leaves the server", () => {
  const version = {
    _id: "v1", costingId: "c1", versionNumber: 1, status: "DRAFT", baseCurrency: "INR",
    calculationSchemaVersion: 0,
    provenance: { origin: "MANUAL", createdAt: new Date("2026-09-01"), createdByActorName: "A" },
    sourceReferences: [{
      sourceType: "SUPPLIER_OFFER", sourceKey: "acme-cotton", label: "Acme cotton",
      confidence: "PROVISIONAL",
      snapshot: [{ key: "unitPrice", money: { amountMinor: 41250, currency: "INR" } }],
    }],
    scenarios: [],
  };
  const serialize = (caps) =>
    visibility.serialize({ costing: { _id: "c1", context: {}, status: "DRAFT" }, versions: [version], ctx: ctxWith(caps) });

  test("a supplier price never appears without costing.cost.read", () => {
    for (const caps of [[], [CAPABILITIES.OUTPUT_READ], [CAPABILITIES.MARGIN_READ],
      [CAPABILITIES.DRAFT_WRITE], [CAPABILITIES.APPROVE]]) {
      const payload = serialize(caps);
      expect(JSON.stringify(payload)).not.toContain("41250");
      expect(JSON.stringify(payload)).not.toContain("acme-cotton");
      expect(payload.versions[0]).not.toHaveProperty("cost");
      expect(payload.visibility.withheld).toContain("cost");
    }
  });

  test("cost does not carry margin with it", () => {
    const payload = serialize([CAPABILITIES.COST_READ]);
    expect(payload.versions[0].cost.sourceReferences[0].snapshot[0].money.amountMinor).toBe(41250);
    expect(payload.versions[0]).not.toHaveProperty("margin");
    expect(payload.visibility.withheld).toContain("margin");
  });

  test("a withheld block is absent, not null — the two say different things", () => {
    const payload = serialize([CAPABILITIES.COST_READ, CAPABILITIES.MARGIN_READ, CAPABILITIES.OUTPUT_READ]);
    const v = payload.versions[0];
    /* Permitted but uncalculated is stated as such. A zero would be a claim. */
    expect(v.cost.calculated).toBe(false);
    expect(v.cost).not.toHaveProperty("totals");
    expect(v.margin).toEqual({ calculated: false });
    expect(v.output).toEqual({ approved: false, reason: "NO_APPROVED_VERSION" });
    expect(payload.visibility.withheld).toEqual([]);
  });
});

describe("money", () => {
  test("minor units survive a round trip that a float would not", () => {
    const tenth = money.parseMoney({ amountMinor: 10, currency: "INR" });
    const fifth = money.parseMoney({ amountMinor: 20, currency: "INR" });
    expect(tenth.amountMinor + fifth.amountMinor).toBe(30);
    expect(money.formatMinor({ amountMinor: 30, currency: "INR" })).toBe("0.30 INR");
    /* The arithmetic this replaces: 0.1 + 0.2 !== 0.3 */
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  test("missing and zero stay different", () => {
    expect(money.parseMoney(undefined)).toBeUndefined();
    expect(money.parseMoney({ amountMinor: 0, currency: "INR" })).toEqual({ amountMinor: 0, currency: "INR" });
    expect(() => money.parseMoney(null)).toThrow(/null/i);
  });

  test("a credit is a real amount", () => {
    expect(money.parseMoney({ amountMinor: -500, currency: "INR" }).amountMinor).toBe(-500);
    expect(money.formatMinor({ amountMinor: -500, currency: "INR" })).toBe("-5.00 INR");
  });
});

describe("the Chunk 2 legacy seam", () => {
  test("a legacy rupee float becomes integer paise, and says what it rounded", () => {
    expect(adapter.toMinorUnits(412.35)).toEqual({ amountMinor: 41235, currency: "INR", roundedBy: 0 });
    const rounded = adapter.toMinorUnits(12.005);
    expect(rounded.amountMinor).toBe(1201);
    expect(rounded.roundedBy).not.toBe(0);
  });

  test("a missing legacy value does not become zero", () => {
    for (const v of [undefined, null, "", "abc"]) expect(adapter.toMinorUnits(v)).toBeUndefined();
    expect(adapter.toMinorUnits(0)).toEqual({ amountMinor: 0, currency: "INR", roundedBy: 0 });
  });

  test("an enquiry sheet maps onto the canonical context and a provisional source", () => {
    const ctx = adapter.contextForEnquiryProduct("64b7d1f9c2a4e81234567890", " Blazer ");
    expect(ctx).toEqual({ type: "ENQUIRY_STYLE", primaryId: "64b7d1f9c2a4e81234567890", externalKey: "Blazer" });

    const src = adapter.sourceReferenceForSheet({
      enquiryId: "64b7d1f9c2a4e81234567890", productName: "Blazer", part: "raw",
    });
    expect(src.sourceType).toBe("ENQUIRY_COSTING_SHEET");
    expect(src.sourceKey).toBe("Blazer::raw");
    /* A legacy row carries no quotation, validity or effective date, so
       nothing in it can be verified from the record itself. */
    expect(src.confidence).toBe("PROVISIONAL");
  });
});
