// test/costing/input-readiness.test.js
//
// LANE B — the non-packaging readiness payload.
//
// The claims worth holding are the ones a screen would otherwise get wrong:
//
//   · a family with no source never becomes zero and never becomes an input;
//   · a commercial decision nobody has made reads as a decision, not as data;
//   · "not applicable" is an audited decision or it is not one;
//   · a frozen version's evidence does not move when a source changes;
//   · Packaging is Lane A's and is not described here at all.
//
// Pure — the module reads only what it is handed. No database, no request.
"use strict";

const readiness = require("../../services/centralCosting/inputReadiness");
const coverage = require("../../services/centralCosting/costCoverage");
const visibility = require("../../services/centralCosting/visibility");

const R = readiness.READINESS;

/** One frozen family entry, in the shape visibility.js publishes. */
const frozen = (over = {}) => ({
  key: "materials",
  label: "Materials",
  state: "NEEDS_INPUT",
  totalMinor: null,
  perUnitMinor: null,
  basis: null,
  authority: "AUTOMATIC",
  owner: { department: "R&D and Store", system: "SampleStyle + Supplier quotations" },
  reason: null,
  decidedByName: null,
  decidedAt: null,
  ...over,
});

const completeness = (families) => ({ recorded: true, costComplete: false, families });

const rowOf = (payload, key) => payload.families.find((f) => f.key === key);

describe("Lane B input readiness — the contract itself", () => {
  test("speaks for every non-packaging coverage family and for no other", () => {
    const coverageKeys = coverage.FAMILY_KEYS.filter((k) => k !== "packaging");
    expect([...readiness.FAMILY_KEYS].sort()).toEqual([...coverageKeys].sort());
  });

  test("does not describe Packaging, which is Lane A's family", () => {
    expect(readiness.FAMILY_KEYS).not.toContain("packaging");
    expect(readiness.EXCLUDED_FAMILY_KEYS).toContain("packaging");

    const payload = readiness.forVersion({
      completeness: completeness([
        frozen({ key: "packaging", label: "Packaging" }),
        frozen({ key: "overhead", label: "Overhead", authority: "POLICY" }),
      ]),
    });
    expect(payload.families.map((f) => f.key)).toEqual(["overhead"]);
  });

  test("every fact names a role, and every destination it names exists", () => {
    for (const family of readiness.FAMILIES) {
      expect(family.facts.length).toBeGreaterThan(0);
      for (const f of family.facts) {
        expect(f.owner.department).toBeTruthy();
        if (f.destination) expect(readiness.DESTINATIONS[f.destination]).toBeTruthy();
        /* A fact with no destination is a fact with no source — and it has to
           say so rather than quietly having nowhere to go. */
        if (!f.destination) expect(f.contract).toBe(readiness.CONTRACT.MISSING);
      }
      if (family.primaryDestination) {
        expect(readiness.DESTINATIONS[family.primaryDestination]).toBeTruthy();
      }
    }
  });

  test("every destination states what the reader must hold to be offered it", () => {
    for (const d of Object.values(readiness.DESTINATIONS)) {
      const requires = d.requires || {};
      expect(Boolean(requires.capability) || Boolean(requires.departmentSlug)).toBe(true);
      if (requires.departmentSlug) expect(requires.minimumRole).toBeTruthy();
    }
  });
});

describe("Lane B input readiness — states", () => {
  test("a costed family is READY and carries its working, not a blocker", () => {
    const payload = readiness.forVersion({
      completeness: completeness([
        frozen({ state: "CALCULATED", perUnitMinor: 4200, totalMinor: 2100000, basis: "Cost lines on this version" }),
      ]),
    });
    const row = rowOf(payload, "materials");
    expect(row.state).toBe(R.READY);
    expect(row.blocking).toBe(false);
    expect(row.missingFacts).toEqual([]);
    expect(row.destination).toBeNull();
    expect(row.evidence.entries.find((e) => e.key === "perUnit").amountMinor).toBe(4200);
    expect(payload.blocking).toEqual([]);
  });

  test("a rule that came to nil is an answer, not a gap", () => {
    const payload = readiness.forVersion({
      completeness: completeness([
        frozen({ key: "freight", label: "Freight and logistics", state: "RECORDED_ZERO", totalMinor: 0, perUnitMinor: 0 }),
      ]),
      version: {
        freightProvenance: {
          state: "RECORDED_ZERO", arrangement: "ex_works",
          arrangementSource: "Agreed on this enquiry",
        },
      },
    });
    const row = rowOf(payload, "freight");
    expect(row.state).toBe(R.RECORDED_NIL);
    expect(row.blocking).toBe(false);
    /* WHY it is nil, on the row — "the customer collects" is an answer and an
       empty row is not. */
    expect(row.evidence.entries.find((e) => e.key === "arrangement").value).toBe("ex_works");
  });

  test("a policy family with nothing approved is missing data, owned by the Board", () => {
    /* ── THIS USED TO NAME FINANCE AND THE COSTING POLICY SCREEN ────────
       Overhead was two fields somebody could save there. It is an approved,
       effective-dated Board decision now, so the desk this row sends a reader
       to is the Board's — pointing at the costing policy would send them to a
       screen that refuses the write. */
    const payload = readiness.forVersion({
      completeness: completeness([
        frozen({
          key: "overhead", label: "Allocated company and factory overhead",
          authority: "POLICY", owner: { department: "Board", system: "Company overhead policy" },
        }),
      ]),
    });
    const row = rowOf(payload, "overhead");
    expect(row.state).toBe(R.MISSING_INPUT);
    expect(row.blocking).toBe(true);
    expect(row.missingFacts.map((f) => f.key)).toEqual(["OVERHEAD_METHODOLOGY"]);
    expect(row.destination.id).toBe("BOARD_OVERHEAD_POLICY");
    /* ── THE SIGNPOST NAMES THE GRANT THE APP ACTUALLY REQUIRES ─────────
       Board has its own department now; it read `ceo` for one release. A
       signpost naming the old one sends a costing clerk to ask an
       administrator for the wrong access, and the Board app still refuses. */
    expect(row.destination.requires.departmentSlug).toBe("board");
    /* Never zero, and never quietly complete. */
    expect(row.evidence).toBeNull();
    expect(payload.blocking.map((b) => b.key)).toEqual(["overhead"]);
  });

  test("financing with no Board policy is missing data — never a silent zero", () => {
    const payload = readiness.forVersion({
      completeness: completeness([
        frozen({ key: "financing", label: "Financing", authority: "POLICY", owner: { department: "Board", system: "Company financing policy" } }),
      ]),
    });
    const row = rowOf(payload, "financing");
    expect(row.state).toBe(R.MISSING_INPUT);
    expect(row.blocking).toBe(true);
    /* ── AND IT SENDS THE READER TO THE BOARD, NOT TO COSTING ──────────
       The cost of money stopped being a field on the costing policy. Pointing
       there would send somebody to a screen that now refuses the write. */
    expect(row.destination.id).toBe("BOARD_FINANCING_POLICY");
    expect(row.destination.requires.departmentSlug).toBe("board");
    expect(row.evidence).toBeNull();
  });

  test("a source that failed to answer is BLOCKED_SOURCE, and says nobody failed to act", () => {
    const payload = readiness.forVersion({
      completeness: completeness([
        frozen({
          key: "overhead", label: "Overhead", state: "SOURCE_UNAVAILABLE", authority: "POLICY",
          reason: "The company policy declares an overhead rate, but no overhead was applied to this version.",
        }),
      ]),
    });
    const row = rowOf(payload, "overhead");
    expect(row.state).toBe(R.BLOCKED_SOURCE);
    expect(row.blocking).toBe(true);
    expect(row.explanation).toMatch(/no overhead was applied/);
  });
});

describe("Lane B input readiness — freight keeps its commercial distinction", () => {
  const freightFrozen = (over = {}) => frozen({
    key: "freight", label: "Freight and logistics",
    owner: { department: "Sales, R&D and Store", system: "Enquiry delivery terms + shipment facts + freight quotations" },
    ...over,
  });

  test("nobody has said who bears the delivery — a decision, owned by Sales", () => {
    const payload = readiness.forVersion({ completeness: completeness([freightFrozen()]) });
    const row = rowOf(payload, "freight");
    expect(row.state).toBe(R.AWAITING_DECISION);
    expect(row.blocking).toBe(true);
    expect(row.missingFacts).toHaveLength(1);
    expect(row.missingFacts[0].key).toBe("FREIGHT_ARRANGEMENT");
    expect(row.missingFacts[0].owner.departmentSlug).toBe("sales");
    expect(row.destination.id).toBe("SALES_ENQUIRY_DELIVERY_TERMS");
    /* The whole point: it is never priced at nil while unanswered. */
    expect(row.evidence).toBeNull();
    expect(row.explanation).toMatch(/commercial decision/i);
  });

  test("prepaid with no treatment is still a decision, not missing data", () => {
    const payload = readiness.forVersion({
      completeness: completeness([freightFrozen()]),
      version: { freightProvenance: { arrangement: "prepaid", prepaidTreatment: null } },
    });
    const row = rowOf(payload, "freight");
    expect(row.state).toBe(R.AWAITING_DECISION);
    expect(row.missingFacts[0].key).toBe("FREIGHT_ARRANGEMENT");
  });

  test("an arrangement that WAS decided leaves data missing, not a decision", () => {
    const payload = readiness.forVersion({
      completeness: completeness([freightFrozen()]),
      version: { freightProvenance: { arrangement: "delivered" } },
    });
    const row = rowOf(payload, "freight");
    expect(row.state).toBe(R.MISSING_INPUT);
    /* All of the facts this family still needs, ordered so the reader is not
       sent to negotiate a rate for a lane nobody has a destination for. */
    expect(row.missingFacts.map((f) => f.key)).toEqual([
      "FREIGHT_ARRANGEMENT", "FREIGHT_DESTINATION", "SHIPMENT_FACTS", "FREIGHT_QUOTATION",
    ]);
  });

  test("a priced lane reports its working read-only", () => {
    const payload = readiness.forVersion({
      completeness: completeness([freightFrozen({ state: "CALCULATED", perUnitMinor: 1200, totalMinor: 600000, basis: "Cost lines on this version" })]),
      version: {
        freightProvenance: {
          state: "SUPPLIER_QUOTATION", arrangement: "delivered", arrangementSource: "Agreed on this enquiry",
          origin: { name: "Ludhiana warehouse" }, destination: { label: "Acme, Bengaluru" },
          mode: "ROAD", supplierName: "Bluedart", quotationReference: "Q-4417",
        },
      },
    });
    const row = rowOf(payload, "freight");
    expect(row.state).toBe(R.READY);
    const keys = row.evidence.entries.map((e) => e.key);
    expect(keys).toEqual(expect.arrayContaining(["lane", "mode", "carrier", "arrangement"]));
    expect(row.evidence.entries.find((e) => e.key === "lane").value).toBe("Ludhiana warehouse → Acme, Bengaluru");
  });
});

describe("Lane B input readiness — a family with no source stops at the boundary", () => {
  test("customs duty now names three facts and three destinations, not one dead end", () => {
    /* ── WHAT THIS TEST USED TO PROVE ─────────────────────────────────
       That the duty family was a typed blocker with NO destination, because
       nothing in the system recorded a heading, an origin or a rate — so
       there was no screen to send anybody to.

       All three exist now, at three different desks, and the family reports
       them separately. A single message naming none of them sent everybody
       nowhere; that is the dead end this replaces. */
    const payload = readiness.forVersion({
      completeness: completeness([
        frozen({
          key: "duty", label: "Customs duty and non-recoverable tax",
          authority: "AWAITING_SOURCE",
          owner: { department: "Store / Purchase and Board", system: "Sourcing evidence + the approved duty table" },
        }),
      ]),
    });
    const row = rowOf(payload, "duty");
    expect(row.blocking).toBe(true);

    /* Each fact is owned, and the two desks are named separately — Store for
       the evidence and the classification, the Board for the rate. */
    const facts = row.missingFacts || [];
    const byKey = Object.fromEntries(facts.map((f) => [f.key, f]));
    expect(Object.keys(byKey)).toEqual(expect.arrayContaining([
      "IMPORT_SOURCING_EVIDENCE", "CUSTOMS_CLASSIFICATION", "CUSTOMS_DUTY_RATE",
    ]));
    expect(byKey.CUSTOMS_DUTY_RATE.owner.department).toBe("Board");
    expect(byKey.CUSTOMS_DUTY_RATE.destination).toBe("BOARD_DUTY_POLICY");
    expect(byKey.CUSTOMS_CLASSIFICATION.owner.department).toBe("Store / Purchase");

    /* And the classification is still explicitly not the quotation's HSN. */
    expect(byKey.CUSTOMS_CLASSIFICATION.label).toMatch(/not the quotation's GST HSN/);
  });

  test("financing now has both halves, each with its own owner and screen", () => {
    /* ── THIS USED TO BE THE OPPOSITE ASSERTION ────────────────────────
       The family had a rate and no duration, and the duration was recorded as
       a contract nothing in the company published. Sales confirms it on the
       enquiry now and the Board approves the methodology, so neither half is
       missing — and they are deliberately still two facts, because either can
       be the one that is outstanding and they are fixed at different desks. */
    const family = readiness.FAMILY_BY_KEY.financing;
    expect(family.facts.filter((f) => f.contract === readiness.CONTRACT.MISSING)).toEqual([]);
    expect(family.facts.map((f) => f.key))
      .toEqual(["FINANCING_METHODOLOGY", "PAYMENT_TERM_DURATION"]);

    const [methodology, duration] = family.facts;
    expect(methodology.owner.department).toBe("Board");
    expect(methodology.destination).toBe("BOARD_FINANCING_POLICY");
    expect(duration.owner.department).toBe("Sales");
    expect(duration.destination).toBe("SALES_PAYMENT_TERMS");
    /* Two owners, two screens, never collapsed into one — telling Sales to
       fix the Board's rate is how a family sits still for a month. */
    expect(methodology.destination).not.toBe(duration.destination);
  });

  test("a financed version explains itself from its own frozen provenance", () => {
    /* Not from the policy snapshot, which still carries the retired flat rate
       and would show a figure this version was never calculated with. */
    const payload = readiness.forVersion({
      completeness: completeness([
        frozen({ key: "financing", label: "Financing", state: "CALCULATED", totalMinor: 4200, authority: "POLICY" }),
      ]),
      version: {
        financingProvenance: {
          state: "CALCULATED", annualRatePercent: "12", creditDays: 45,
          creditDaysFrom: "INVOICE", financedSharePercent: "70", effectivePercent: "1.035616",
        },
      },
      policySnapshot: { financingRatePercent: "2" },
    });
    const row = rowOf(payload, "financing");
    expect(row.state).toBe(R.READY);
    const evidence = Object.fromEntries(row.evidence.entries.map((e) => [e.key, e.value]));
    expect(evidence.rate).toBe("12% a year");
    expect(evidence.duration).toBe("45 days from invoice");
    expect(evidence.share).toBe("70%");
    /* The retired flat rate on the snapshot is not what is shown. */
    expect(row.evidence.entries.some((e) => e.value === "2%")).toBe(false);
  });
});

describe("Lane B input readiness — an intentional exclusion is accountable", () => {
  test("a complete decision carries its actor, its date and its reason, and reads as audited", () => {
    const payload = readiness.forVersion({
      completeness: completeness([
        frozen({
          key: "services", label: "Outside services", state: "NOT_APPLICABLE",
          reason: "Nothing on this style is sent outside.",
          decidedByName: "R. Menon", decidedAt: "2026-09-03T09:15:00.000Z",
        }),
      ]),
    });
    const row = rowOf(payload, "services");
    expect(row.state).toBe(R.NOT_APPLICABLE);
    expect(row.blocking).toBe(false);
    expect(row.decision).toEqual({
      reason: "Nothing on this style is sent outside.",
      decidedByName: "R. Menon",
      decidedAt: "2026-09-03T09:15:00.000Z",
      audited: true,
    });
  });

  test("a decision missing its author is NOT reported as audited", () => {
    const payload = readiness.forVersion({
      completeness: completeness([
        frozen({ key: "services", state: "NOT_APPLICABLE", reason: "Not needed.", decidedByName: null, decidedAt: null }),
      ]),
    });
    expect(rowOf(payload, "services").decision.audited).toBe(false);
  });
});

describe("Lane B input readiness — Costing is not a form", () => {
  test("no row anywhere offers a manual cost, rate or quantity entry", () => {
    const everyState = ["CALCULATED", "RECORDED_ZERO", "NOT_APPLICABLE", "NEEDS_INPUT", "SOURCE_UNAVAILABLE"];
    for (const key of readiness.FAMILY_KEYS) {
      for (const state of everyState) {
        for (const authority of ["AUTOMATIC", "POLICY", "AWAITING_SOURCE"]) {
          const payload = readiness.forVersion({
            completeness: completeness([frozen({ key, state, authority })]),
          });
          const row = rowOf(payload, key);
          const serialised = JSON.stringify(row);
          /* The old vocabulary. A readiness row sends somebody to the source;
             it never invites a figure into the costing. */
          expect(serialised).not.toMatch(/"addCost"/);
          expect(serialised).not.toMatch(/override/i);
          expect(row.input).toBeUndefined();
          expect(row.editable).toBeUndefined();
          /* Every destination is a place to record a fact at ITS source. */
          if (row.destination) expect(readiness.DESTINATIONS[row.destination.id]).toBeTruthy();
        }
      }
    }
  });
});

describe("Lane B input readiness — a frozen version does not move", () => {
  const version = {
    freightProvenance: { arrangement: "delivered", supplierName: "Bluedart", quotationReference: "Q-4417" },
    policyProvenance: [],
  };
  const snapshot = { overheadRatePercent: 8 };

  test("the payload is a pure function of what the version froze", () => {
    const build = () => readiness.forVersion({
      completeness: completeness([
        frozen({ key: "overhead", state: "CALCULATED", perUnitMinor: 900, totalMinor: 450000, authority: "POLICY", basis: "Company costing policy (8%)" }),
      ]),
      version,
      policySnapshot: snapshot,
    });
    expect(JSON.stringify(build())).toEqual(JSON.stringify(build()));
    const row = rowOf(build(), "overhead");
    expect(row.evidence.entries.find((e) => e.key === "rate").value).toBe("8%");
    expect(row.evidence.entries.find((e) => e.key === "perUnit").amountMinor).toBe(900);
  });

  /* ── AND THE WIRING IS THE OTHER HALF OF THAT CLAIM ──────────────────
     A pure function is only as honest as what it is handed. This proves the
     serializer hands it the version's OWN policy snapshot — so a policy
     republished at 11% leaves a version costed at 8% reading 8%. */
  test("visibility hands it the frozen snapshot, not the live policy", () => {
    const v = {
      _id: "v1", versionNumber: 3, status: "CALCULATED", baseCurrency: "INR",
      calculation: { engineVersion: 1, calculatedAt: new Date("2026-03-04T00:00:00Z") },
      policySnapshot: { revision: 4, baseCurrency: "INR", overheadRatePercent: 8 },
      scenarios: [],
      completeness: {
        costComplete: true, assessedAt: new Date("2026-03-04T00:00:00Z"),
        families: [{
          key: "overhead", label: "Allocated company and factory overhead", state: "CALCULATED",
          perUnitMinor: 900, totalMinor: 450000, authority: "POLICY",
          ownerDepartment: "Finance", ownerSystem: "Company costing policy",
          basis: "Company costing policy (8%)",
        }],
      },
    };
    const ctx = { capabilitySet: new Set(["costing.cost.read"]) };
    const out = visibility.serializeVersion(v, ctx, new Set());
    const row = out.cost.inputReadiness.families.find((f) => f.key === "overhead");
    expect(out.cost.inputReadiness.recorded).toBe(true);
    expect(row.state).toBe(R.READY);
    expect(row.evidence.entries.find((e) => e.key === "rate").value).toBe("8%");
  });

  test("the readiness block is withheld from a reader without costing.cost.read", () => {
    const v = {
      _id: "v1", versionNumber: 1, status: "APPROVED", baseCurrency: "INR",
      scenarios: [], policySnapshot: { revision: 1, baseCurrency: "INR" },
      completeness: { costComplete: true, families: [] },
    };
    const withheld = new Set();
    const out = visibility.serializeVersion(v, { capabilitySet: new Set(["costing.output.read"]) }, withheld);
    /* Supplier rates and internal policy evidence stay behind the cost gate —
       Sales sees the approved commercial output and none of this. */
    expect(out.cost).toBeUndefined();
    expect(withheld.has("cost")).toBe(true);
  });

  test("a version assessed before completeness existed is neither ready nor blocked", () => {
    const payload = readiness.forVersion({ completeness: { recorded: false, costComplete: null, families: [] } });
    expect(payload).toEqual({ recorded: false, families: [], blocking: [] });
  });
});
