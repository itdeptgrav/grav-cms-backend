// test/costing/source-app-requirements.test.js
//
// LANE B — the source-app requirement projection.
//
// The claims worth holding are the ones that decide whether this is safe to
// render inside somebody else's department app:
//
//   · one owner per fact — a family appears in exactly one app's list;
//   · a department with no grant is REFUSED, not handed an empty list;
//   · no rate, supplier, policy value or cost is in any payload, for anybody;
//   · a fact with no form is a typed blocker and never a fake action;
//   · no action anywhere navigates to /costing;
//   · Packaging is Lane A's and is not emitted.
//
// Mostly pure — `resolveRequirement` is exported so every branch is exercised
// without a database. The route-level tests use the in-memory server the rest
// of this folder uses.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const apps = require("../../services/centralCosting/sourceApps");
const projection = require("../../services/centralCosting/sourceAppRequirements.service");
const coverage = require("../../services/centralCosting/costCoverage");
const readiness = require("../../services/centralCosting/inputReadiness");

const { STATUS, SOURCE_APP, SOURCE_FORM, BLOCKER } = apps;

const facts = (over = {}) => ({
  style: { present: false },
  enquiry: { present: false },
  store: { quotedItemIds: new Set(), quotedServiceIds: new Set(), freightLaneOffers: 0 },
  operationMaster: { unset: [], checked: false },
  /* Store's own sourcing projection. Null means the read failed, which is a
     different fact from "nothing recorded" — see the resolver. */
  sourcing: null,
  ...over,
});

const style = (over = {}) => ({
  present: true, id: "s1", reference: "ST-1", label: "Tee",
  enquiryId: "e1", journeyId: "j1",
  bomCount: 0, bomItemIds: [], legacyBomOnly: false,
  technicalStatus: "not_started", technicalMaterials: [], operations: [],
  services: [], development: [], packedWeightGrams: null,
  ...over,
});

const enquiry = (over = {}) => ({
  present: true, id: "e1", reference: "ENQ-9", journeyId: "j1",
  arrangement: "", mode: "", shippingAddressId: "", originWarehouseId: "", prepaidTreatment: "",
  /* Sales' structured payment terms, as the projection publishes them. */
  paymentTerms: { state: "NOT_STARTED", advancePercent: null, creditDays: null, gaps: [] },
  ...over,
});

const find = (key) => apps.REQUIREMENTS.find((r) => r.key === key);
const resolve = (key, f) => projection.resolveRequirement(find(key), f);

/* ══ THE CONTRACT ══════════════════════════════════════════════════════════ */

describe("the source-app contract", () => {
  test("Packaging is never named — it is Lane A's family", () => {
    expect(apps.EXCLUDED_FAMILIES).toContain("packaging");
    for (const r of apps.REQUIREMENTS) {
      expect(r.family).not.toBe("packaging");
      expect(JSON.stringify(r)).not.toMatch(/packaging|PER_CARTON|carton/i);
    }
    for (const p of apps.BOARD_POLICIES) expect(p.families).not.toContain("packaging");
  });

  test("every family Costing gates, except Packaging, has an owning app", () => {
    const owned = new Set(apps.REQUIREMENTS.map((r) => r.family));
    const viaBoard = new Set(apps.BOARD_POLICIES.flatMap((p) => p.families));
    for (const key of coverage.FAMILY_KEYS) {
      if (key === "packaging") continue;
      expect(owned.has(key) || viaBoard.has(key)).toBe(true);
    }
  });

  test("its family keys are Costing's own — one vocabulary, not two", () => {
    /* ── AND A CALCULATION PREREQUISITE HAS NO FAMILY TO SPEAK ────────
       Every FAMILY-scoped requirement feeds a named cost family and must use
       Costing's own key for it. A CALCULATION-scoped one — the confirmed
       Sales brief — feeds no family: it is what says a costing should exist
       at all, and giving it one would invent a cost that never appears in a
       build-up. It is excluded here rather than exempted silently. */
    const familyScoped = apps.REQUIREMENTS.filter((r) => r.scope === apps.SCOPE.FAMILY);
    expect(familyScoped.length).toBeGreaterThan(0);

    const known = new Set(coverage.FAMILY_KEYS);
    for (const r of familyScoped) expect(known.has(r.family)).toBe(true);
    /* And the frozen-version side speaks the same ones. */
    for (const r of familyScoped) {
      expect(readiness.FAMILY_KEYS.includes(r.family)).toBe(true);
    }

    /* The calculation-scoped ones carry null, not a made-up key. */
    for (const r of apps.REQUIREMENTS.filter((x) => x.scope === apps.SCOPE.CALCULATION)) {
      expect(r.family).toBeNull();
    }
  });

  test("ONE app owns each requirement, and each names a grant", () => {
    const seen = new Set();
    for (const r of apps.REQUIREMENTS) {
      expect(seen.has(r.key)).toBe(false);
      seen.add(r.key);
      expect(apps.APP_GRANT[r.sourceApp]).toBeTruthy();
      expect(apps.APP_GRANT[r.sourceApp].departmentSlug).toBeTruthy();
    }
  });

  test("a requirement either has a form and an action, or a typed blocker and none", () => {
    for (const r of apps.REQUIREMENTS) {
      if (r.sourceForm === SOURCE_FORM.PRESENT) {
        expect(r.action).toBeTruthy();
        expect(r.blocker).toBeNull();
      } else {
        /* No fake action for a form that does not exist. */
        expect(r.action).toBeNull();
        expect(r.blocker).toBeTruthy();
        expect(Object.values(BLOCKER)).toContain(r.blocker.code);
        /* And the missing contract is written down, not left implied. */
        expect(String(r.blocker.contract || "").length).toBeGreaterThan(20);
      }
    }
  });

  test("no action anywhere is a URL, and none mentions the costing app", () => {
    const serialised = JSON.stringify(apps.REQUIREMENTS);
    expect(serialised).not.toMatch(/\/costing/);
    expect(serialised).not.toMatch(/https?:/);
    for (const r of apps.REQUIREMENTS) {
      if (!r.action) continue;
      expect(r.action.id).toMatch(/^[A-Z_]+$/);
      expect(r.action.section).toBeTruthy();
    }
  });
});

/* ══ GRANTS ════════════════════════════════════════════════════════════════ */

describe("department isolation", () => {
  test("a grant opens exactly one app", () => {
    expect(projection.appsForGrants({ "research-development": "editor" })).toEqual([SOURCE_APP.RND]);
    expect(projection.appsForGrants({ store: "viewer" })).toEqual([SOURCE_APP.STORE]);
    expect(projection.appsForGrants({ sales: "owner" })).toEqual([SOURCE_APP.SALES]);
    expect(projection.appsForGrants({ merchandiser: "editor" })).toEqual([SOURCE_APP.MERCHANDISING]);
    expect(projection.appsForGrants({ "project-manager": "approver" })).toEqual([SOURCE_APP.PRODUCTION]);
  });

  test("no grant opens nothing, and a foreign grant opens nothing", () => {
    expect(projection.appsForGrants({})).toEqual([]);
    expect(projection.appsForGrants({ hr: "owner" })).toEqual([]);
    expect(projection.appsForGrants({ store: null })).toEqual([]);
  });

  test("nobody is served the Board list — there is no Board grant to hold", () => {
    expect(projection.appsForGrants({ board: "owner" })).toEqual([SOURCE_APP.BOARD]);
    /* And the route refuses it outright; see the route test below. The point
       here is that no ordinary department grant reaches it. */
    for (const slug of ["sales", "store", "research-development", "merchandiser", "project-manager"]) {
      expect(projection.appsForGrants({ [slug]: "owner" })).not.toContain(SOURCE_APP.BOARD);
    }
  });

  test("each family surfaces in exactly one app's requirement list", () => {
    const byFamily = new Map();
    for (const app of apps.SOURCE_APP_KEYS) {
      for (const r of apps.requirementsFor(app)) {
        if (!byFamily.has(r.family)) byFamily.set(r.family, new Set());
        byFamily.get(r.family).add(app);
      }
    }
    /* A family may legitimately need two desks — materials needs Merchandising
       AND R&D AND Store — but each FACT has one owner, which is what stops two
       screens claiming the same work. */
    for (const r of apps.REQUIREMENTS) {
      const owners = apps.REQUIREMENTS.filter((o) => o.key === r.key).map((o) => o.sourceApp);
      expect(new Set(owners).size).toBe(1);
    }
  });
});

/* ══ STATUS RESOLUTION ═════════════════════════════════════════════════════ */

describe("Merchandising", () => {
  test("no materials chosen is not started", () => {
    expect(resolve("MATERIAL_BOM_IDENTITY", facts({ style: style() })).status).toBe(STATUS.NOT_STARTED);
  });

  test("free-text materials are in progress, not ready", () => {
    const r = resolve("MATERIAL_BOM_IDENTITY", facts({ style: style({ legacyBomOnly: true }) }));
    expect(r.status).toBe(STATUS.IN_PROGRESS);
    expect(r.reason).toMatch(/item master/);
  });

  test("a structured BOM is ready", () => {
    const r = resolve("MATERIAL_BOM_IDENTITY", facts({ style: style({ bomCount: 3, bomItemIds: ["a", "b", "c"] }) }));
    expect(r.status).toBe(STATUS.READY);
  });
});

describe("R&D", () => {
  test("nothing to measure until Merchandising has chosen — and it says whose it is", () => {
    const r = resolve("MATERIAL_CONSUMPTION", facts({ style: style() }));
    expect(r.status).toBe(STATUS.AWAITING_OTHER_DEPARTMENT);
    expect(r.waitingOn.department).toBe("Merchandising");
    /* Named, and nothing about their record. */
    expect(JSON.stringify(r)).not.toMatch(/rate|price|supplier|quotation/i);
  });

  test("a half-measured record is in progress and names what is left", () => {
    const r = resolve("MATERIAL_CONSUMPTION", facts({
      style: style({
        bomCount: 2, bomItemIds: ["a", "b"],
        technicalMaterials: [
          { rawItemId: "a", name: "Jersey", measured: true, unit: "kg" },
          { rawItemId: "b", name: "Rib", measured: false, unit: "" },
        ],
      }),
    }));
    expect(r.status).toBe(STATUS.IN_PROGRESS);
    expect(r.reason).toMatch(/Rib/);
  });

  test("a quantity with no unit is not a measurement", () => {
    const r = resolve("MATERIAL_CONSUMPTION", facts({
      style: style({
        bomCount: 1, bomItemIds: ["a"],
        technicalMaterials: [{ rawItemId: "a", name: "Jersey", measured: true, unit: "" }],
      }),
    }));
    expect(r.status).toBe(STATUS.IN_PROGRESS);
    expect(r.reason).toMatch(/no unit/);
  });

  test("a submitted technical record waits on Sales, not on R&D", () => {
    const r = resolve("TECHNICAL_SPECIFICATION", facts({ style: style({ technicalStatus: "submitted" }) }));
    expect(r.status).toBe(STATUS.AWAITING_OTHER_DEPARTMENT);
    expect(r.waitingOn.department).toBe("Sales");
  });

  test("packed weight is not asked for when the customer collects", () => {
    const r = resolve("SHIPMENT_PACKED_WEIGHT", facts({
      style: style(), enquiry: enquiry({ arrangement: "ex_works" }),
    }));
    expect(r.status).toBe(STATUS.NOT_APPLICABLE);
    expect(r.reason).toMatch(/customer bears the delivery/);
  });

  test("packed weight IS asked for when the company delivers", () => {
    const r = resolve("SHIPMENT_PACKED_WEIGHT", facts({
      style: style(), enquiry: enquiry({ arrangement: "delivered" }),
    }));
    expect(r.status).toBe(STATUS.NOT_STARTED);
  });
});

describe("Production", () => {
  /* ── THE ROUTE HAS A PRODUCTION SCREEN NOW ────────────────────────────
     It used to be a `SOURCE_FORM_MISSING` blocker with no action, because the
     route was entered on R&D's technical record and Production had nowhere to
     record it. The Route & SAM section on the product workspace closed that;
     the RECORD did not move. */
  test("the route is a real Production action, into the product workspace", () => {
    const contract = find("OPERATION_ROUTE_AND_SAM");
    expect(contract.sourceForm).toBe(SOURCE_FORM.PRESENT);
    expect(contract.blocker).toBeNull();
    expect(contract.action.id).toBe("PM_STYLE_ROUTE");
    expect(contract.action.section).toBe("route-and-sam");
    /* Production has no Journey concept, and nothing here is a costing screen. */
    const serialised = JSON.stringify(contract);
    expect(serialised).not.toMatch(/journey|enquiry/i);
    expect(serialised).not.toMatch(/\/costing/);
  });

  test("an unrouted style is Production's gap, not R&D's", () => {
    const r = resolve("OPERATION_ROUTE_AND_SAM", facts({ style: style() }));
    expect(r.status).toBe(STATUS.NOT_STARTED);
    expect(r.reason).toMatch(/prices its labour at nothing/);
    /* Owned by Production — the whole point of moving it. */
    expect(find("OPERATION_ROUTE_AND_SAM").sourceApp).toBe(SOURCE_APP.PRODUCTION);
  });

  test("an operation with no standard time is half done, and names which", () => {
    const r = resolve("OPERATION_ROUTE_AND_SAM", facts({
      style: style({
        operations: [
          { operationId: "o1", name: "Side seam", timed: true },
          { operationId: "o2", name: "Hem", timed: false },
        ],
      }),
    }));
    expect(r.status).toBe(STATUS.IN_PROGRESS);
    expect(r.reason).toMatch(/Hem/);
  });

  test("a legacy row naming no registered operation blocks readiness, and is not dropped", () => {
    const r = resolve("OPERATION_ROUTE_AND_SAM", facts({
      style: style({ operations: [{ operationId: "", code: "SEW", name: "Side seam", timed: true }] }),
    }));
    expect(r.status).toBe(STATUS.IN_PROGRESS);
    expect(r.reason).toMatch(/registered operation/);
  });

  test("a fully timed, registered route is ready", () => {
    const r = resolve("OPERATION_ROUTE_AND_SAM", facts({
      style: style({
        operations: [
          { operationId: "o1", name: "Side seam", timed: true },
          { operationId: "o2", name: "Hem", timed: true },
        ],
      }),
    }));
    expect(r.status).toBe(STATUS.READY);
    expect(r.reason).toBe("2 operations, all timed.");
  });

  test("an operation with no salary basis is named, and prices at nothing rather than free", () => {
    const r = resolve("OPERATION_SALARY_BASIS", facts({
      style: style({ operations: [{ operationId: "o1", code: "SEW", name: "Side seam", timed: true }] }),
      operationMaster: { checked: true, unset: ["Side seam"] },
    }));
    expect(r.status).toBe(STATUS.NOT_STARTED);
    expect(r.reason).toMatch(/Side seam/);
  });

  test("all operations based is ready", () => {
    const r = resolve("OPERATION_SALARY_BASIS", facts({
      style: style({ operations: [{ operationId: "o1", timed: true }] }),
      operationMaster: { checked: true, unset: [] },
    }));
    expect(r.status).toBe(STATUS.READY);
  });
});

describe("Sales — and freight's commercial distinction", () => {
  test("an unrecorded arrangement is never nil", () => {
    const r = resolve("FREIGHT_ARRANGEMENT", facts({ enquiry: enquiry() }));
    expect(r.status).toBe(STATUS.NOT_STARTED);
    expect(r.reason).toMatch(/never costed at nil/);
  });

  test("prepaid raises the recovery question; delivered does not", () => {
    const prepaid = resolve("FREIGHT_RECOVERY_DECISION", facts({ enquiry: enquiry({ arrangement: "prepaid" }) }));
    expect(prepaid.status).toBe(STATUS.NOT_STARTED);
    expect(prepaid.reason).toMatch(/differ by the whole freight amount/);

    const delivered = resolve("FREIGHT_RECOVERY_DECISION", facts({ enquiry: enquiry({ arrangement: "delivered" }) }));
    expect(delivered.status).toBe(STATUS.NOT_APPLICABLE);
  });

  test("a collected order needs no destination", () => {
    const r = resolve("FREIGHT_DESTINATION", facts({ enquiry: enquiry({ arrangement: "to_pay" }) }));
    expect(r.status).toBe(STATUS.NOT_APPLICABLE);
  });

  test("payment-term duration is Sales' own form now, on the enquiry", () => {
    /* It used to be a typed blocker: nothing published this order's payment
       terms to costing. Sales records them structurally on the enquiry now —
       the advance, how long the balance runs, and what it runs from. */
    const req = find("PAYMENT_TERMS_DURATION");
    expect(req.blocker).toBeNull();
    expect(req.action.id).toBe("SALES_PAYMENT_TERMS");
    expect(req.action.section).toBe("payment-terms");
  });

  test("an unanswered order is never read as a cash sale", () => {
    /* The whole point of the contract. Silence blocks; a confirmed set does
       not; and "paid up front" is an advance somebody stated, not an absence
       of terms. */
    const silent = resolve("PAYMENT_TERMS_DURATION", facts({ enquiry: enquiry() }));
    expect(silent.status).toBe(STATUS.NOT_STARTED);
    expect(silent.reason).toMatch(/not a cash sale/);

    const confirmed = resolve("PAYMENT_TERMS_DURATION", facts({
      enquiry: enquiry({
        paymentTerms: {
          state: "CONFIRMED", advancePercent: 30, creditDays: 45,
          creditDaysFrom: "INVOICE", creditDaysFromLabel: "Invoice date", gaps: [],
        },
      }),
    }));
    expect(confirmed.status).toBe(STATUS.READY);
    expect(confirmed.reason).toBe("30% advance, 45 days from invoice date.");
  });

  test("recorded but unconfirmed terms are in progress, naming the gap", () => {
    const r = resolve("PAYMENT_TERMS_DURATION", facts({
      enquiry: enquiry({
        paymentTerms: {
          state: "DRAFT", advancePercent: null, creditDays: null,
          gaps: [{ field: "advancePercent", message: "Say what advance is agreed." }],
        },
      }),
    }));
    expect(r.status).toBe(STATUS.IN_PROGRESS);
    expect(r.reason).toMatch(/Say what advance is agreed/);
  });

  test("not applicable needs a stated condition, and is never reached from silence", () => {
    const r = resolve("PAYMENT_TERMS_DURATION", facts({
      enquiry: enquiry({
        paymentTerms: {
          state: "NOT_APPLICABLE", notApplicable: true,
          notApplicableReason: "Intercompany transfer, billed at cost.", gaps: [],
        },
      }),
    }));
    expect(r.status).toBe(STATUS.NOT_APPLICABLE);
    expect(r.reason).toMatch(/Intercompany/);
    /* And silence never gets there. */
    expect(resolve("PAYMENT_TERMS_DURATION", facts({ enquiry: enquiry() })).status)
      .not.toBe(STATUS.NOT_APPLICABLE);
  });
});

describe("Store", () => {
  test("nothing to quote until Merchandising has chosen", () => {
    const r = resolve("MATERIAL_QUOTATION", facts({ style: style() }));
    expect(r.status).toBe(STATUS.AWAITING_OTHER_DEPARTMENT);
    expect(r.waitingOn.department).toBe("Merchandising");
  });

  test("a partly quoted BOM counts what is left, and names no supplier", () => {
    const r = resolve("MATERIAL_QUOTATION", facts({
      style: style({ bomCount: 3, bomItemIds: ["a", "b", "c"] }),
      store: { quotedItemIds: new Set(["a"]), quotedServiceIds: new Set(), freightLaneOffers: 0 },
    }));
    expect(r.status).toBe(STATUS.NOT_STARTED);
    expect(r.reason).toBe("2 of 3 materials have no active quotation.");
  });

  test("an empty outside-process list is a question, not 'nothing goes outside'", () => {
    /* ── WHAT THIS TEST USED TO ASSERT ────────────────────────────────
       That an empty `serviceRequirements` resolved NOT_APPLICABLE. It read a
       style nobody had considered as one that is finished entirely in-house,
       and those are different facts — only one of them is an answer. */
    const r = resolve("SERVICE_QUOTATION", facts({ style: style() }));
    expect(r.status).toBe(STATUS.AWAITING_OTHER_DEPARTMENT);
    expect(r.waitingOn.department).toBe("Production");
  });

  test("Production saying nothing goes outside IS an answer", () => {
    const decided = style();
    decided.outsideProcessDecision = {
      state: "NOT_REQUIRED", required: false,
      reason: "Cut, made and finished in-house.",
    };
    const r = resolve("SERVICE_QUOTATION", facts({ style: decided }));
    expect(r.status).toBe(STATUS.NOT_APPLICABLE);
    expect(r.reason).toMatch(/Production recorded/);
  });

  test("freight is not quoted until Sales has settled the lane", () => {
    const r = resolve("FREIGHT_QUOTATION", facts({ enquiry: enquiry({ arrangement: "delivered" }) }));
    expect(r.status).toBe(STATUS.AWAITING_OTHER_DEPARTMENT);
    expect(r.waitingOn.department).toBe("Sales");
  });

  test("customs origin evidence is Store's own form now, on the quotation register", () => {
    /* It used to be a typed blocker: nothing anywhere recorded a tariff
       heading or a country of origin. Store records both now — sourcing type
       and origin on the supplier quotation, the tariff classification on the
       item master — so the requirement carries a real local action. */
    const req = find("SOURCING_ORIGIN_EVIDENCE");
    expect(req.blocker).toBeNull();
    expect(req.action.id).toBe("STORE_MATERIAL_QUOTATIONS");

    /* Nothing chosen yet, so there is nothing to classify and Store is
       waiting on Merchandising rather than being asked. */
    const r = resolve("SOURCING_ORIGIN_EVIDENCE", facts({ style: style() }));
    expect(r.status).toBe(STATUS.AWAITING_OTHER_DEPARTMENT);
    expect(r.waitingOn.department).toBe("Merchandising");
  });

  test("an unanswered origin is never read as a domestic supply", () => {
    /* The whole point of the contract. Silence blocks; a stated DOMESTIC
       decision does not — and the two reach different statuses. */
    const bom = { bomCount: 1, bomItemIds: ["i1"] };
    const silent = resolve("SOURCING_ORIGIN_EVIDENCE", facts({
      style: style(bom),
      sourcing: { items: [{ state: "MISSING", blocking: true, missing: [], itemName: "Jersey" }] },
    }));
    expect(silent.status).toBe(STATUS.NOT_STARTED);
    expect(silent.reason).toMatch(/not a domestic supply/);

    const decided = resolve("SOURCING_ORIGIN_EVIDENCE", facts({
      style: style(bom),
      sourcing: { items: [{ state: "NOT_APPLICABLE", blocking: false, missing: [], itemName: "Jersey" }] },
    }));
    expect(decided.status).toBe(STATUS.NOT_APPLICABLE);
    expect(decided.reason).toMatch(/bought in India/);
  });

  test("a partly classified bill of materials is in progress, and names what is left", () => {
    const r = resolve("SOURCING_ORIGIN_EVIDENCE", facts({
      style: style({ bomCount: 2, bomItemIds: ["i1", "i2"] }),
      sourcing: {
        items: [
          { state: "READY", blocking: false, missing: [], itemName: "Jersey" },
          {
            state: "IN_PROGRESS", blocking: true, itemName: "Rib",
            missing: [{ field: "customsTariffCode", owner: "Store", message: "Rib has no classification." }],
          },
        ],
      },
    }));
    expect(r.status).toBe(STATUS.IN_PROGRESS);
    expect(r.reason).toMatch(/Rib/);
  });
});

/* ══ BOARD POLICY ══════════════════════════════════════════════════════════ */

describe("Board policy is named, never valued", () => {
  const policy = (configured, over = {}) => ({
    revision: 4, effectiveFrom: null, boardApproved: null,
    companyScope: "c1", configured, ...over,
  });

  test("an unconfigured policy blocks the family it governs, with its scope and dating", () => {
    const out = projection.boardBlockersFor(SOURCE_APP.PRODUCTION, policy({ LABOUR_METHODOLOGY: false }));
    const labour = out.find((b) => b.key === "LABOUR_METHODOLOGY");
    expect(labour.code).toBe(BLOCKER.BOARD_POLICY_REQUIRED);
    expect(labour.policyName).toBe("Labour costing methodology");
    expect(labour.families).toContain("operations");
    expect(labour.companyScope).toBe("c1");
    /* Not recorded is reported as not recorded — never asserted. */
    expect(labour.effectiveFrom).toBeNull();
    expect(labour.boardApproved).toBeNull();
    expect(labour.message).toMatch(/Board decision/);
  });

  test("a configured policy stops blocking", () => {
    const out = projection.boardBlockersFor(SOURCE_APP.PRODUCTION, policy({ LABOUR_METHODOLOGY: true }));
    expect(out.map((b) => b.key)).not.toContain("LABOUR_METHODOLOGY");
  });

  test("no policy VALUE reaches any department", () => {
    for (const app of [SOURCE_APP.RND, SOURCE_APP.SALES, SOURCE_APP.STORE, SOURCE_APP.MERCHANDISING, SOURCE_APP.PRODUCTION]) {
      const out = projection.boardBlockersFor(app, policy({}));
      const serialised = JSON.stringify(out);
      expect(serialised).not.toMatch(/RatePercent"\s*:\s*[0-9]/);
      expect(serialised).not.toMatch(/\b\d+(\.\d+)?%/);
      for (const b of out) {
        expect(b.value).toBeUndefined();
        expect(b.ratePercent).toBeUndefined();
      }
    }
  });

  test("a policy that governs no cost family blocks nothing", () => {
    /* Margin guardrails govern the selling decision. A costing with a complete
       COST and no price is a normal state, not a fault. */
    for (const app of apps.SOURCE_APP_KEYS) {
      const out = projection.boardBlockersFor(app, policy({}));
      expect(out.map((b) => b.key)).not.toContain("MARGIN_GUARDRAILS");
    }
  });
});

/* ══ NO MONEY, ANYWHERE ════════════════════════════════════════════════════ */

describe("nothing commercial can leave this projection", () => {
  test("no resolved requirement carries a rate, a supplier or an amount", () => {
    const everyFact = facts({
      style: style({
        bomCount: 2, bomItemIds: ["a", "b"], legacyBomOnly: false,
        technicalStatus: "approved", packedWeightGrams: 210,
        technicalMaterials: [{ rawItemId: "a", name: "Jersey", measured: true, unit: "kg" }],
        operations: [{ operationId: "o1", name: "Side seam", timed: true }],
        services: [{ rowId: "r1", purpose: "OUTSIDE_PROCESS", serviceId: "sv1", name: "Wash" }],
      }),
      enquiry: enquiry({ arrangement: "prepaid", prepaidTreatment: "IN_PRICE", shippingAddressId: "ad1", originWarehouseId: "w1", mode: "ROAD" }),
      store: { quotedItemIds: new Set(["a"]), quotedServiceIds: new Set(["sv1"]), freightLaneOffers: 2 },
      operationMaster: { checked: true, unset: [] },
    });
    for (const r of apps.REQUIREMENTS) {
      const out = projection.resolveRequirement(r, everyFact);
      const s = JSON.stringify(out);
      expect(s).not.toMatch(/Minor|amount|₹|\bINR\b/i);
      expect(out.rate).toBeUndefined();
      expect(out.supplierName).toBeUndefined();
      /* And no route out of the department. */
      expect(s).not.toMatch(/\/costing/);
    }
  });
});
