// test/hr-ai/storeCommandRegistry.test.js
//
// THE PALETTE REACHES THE WHOLE OF STORE & PURCHASE.
//
// ── THE DEFECT THIS LOCKS SHUT ────────────────────────────────────────────
// The service filtered `tool.application === "store"`. The registry tags 7
// capabilities that way and 110 as `store_purchase`, so 110 of 117 were
// silently unreachable: inventory stock and locations, the Request Desk,
// receiving, procurement, operational summaries and every universal field.
// Nothing failed — the palette simply could not answer most of Store.
//
// These assertions run against the REAL registry, not fabricated tool
// objects, because a fabricated `{application: "store"}` would have passed
// the whole time the product was broken.
"use strict";

process.env.TEST_WITHOUT_MONGO = "1";

const service = require("../../services/ai/storeCommandSearch.service");
const registry = require("../../services/ai/toolRegistry");
const { CAPABILITIES } = require("../../services/storePurchase/capabilities");
const { compileIntent } = require("../../services/ai/storeCommandIntent");
const {
  selectCandidates, groupBySubject, MAX_CANDIDATES,
} = require("../../services/ai/storeCommandRouting");

/* The real capability string ("sp.read"), read from the real module. Spelling
   it "READ" here would have made every assertion below pass against an empty
   authorised set, which is exactly the failure this file exists to catch. */
const storeReader = (over = {}) => ({
  id: "u1",
  applicationAccess: { store: { allowed: true, capabilities: { read: true } } },
  storePurchaseAccess: {
    capabilities: [CAPABILITIES.READ],
    capabilitySet: new Set([CAPABILITIES.READ]),
    companyId: "c1",
  },
  ...over,
});

const names = (tools) => tools.map((t) => t.name);

describe("both internal families are one application here", () => {
  const authorised = service.storeToolsFor(storeReader());

  test("the registry really does hold both, and mostly the second", () => {
    const all = [...registry._tools.values()];
    const store = all.filter((t) => t.application === "store");
    const purchase = all.filter((t) => t.application === "store_purchase");
    expect(store.length).toBeGreaterThan(0);
    expect(purchase.length).toBeGreaterThan(50);
    /* The number that made the old filter a product-wide defect. */
    expect(purchase.length).toBeGreaterThan(store.length * 10);
  });

  test("storeToolsFor() contains BOTH families, and at least 100 of the second", () => {
    /* The defect in one assertion: the old filter returned only the 7 tagged
       `store`, and nothing said so. Both the presence of each family and the
       SIZE of the larger one are pinned, because "contains store_purchase"
       would still pass if 109 of the 110 vanished. */
    const apps = new Set(authorised.map((t) => t.application));
    expect([...apps].sort()).toEqual(["store", "store_purchase"]);

    const store = authorised.filter((t) => t.application === "store");
    const purchase = authorised.filter((t) => t.application === "store_purchase");
    expect(store.length).toBeGreaterThanOrEqual(7);
    expect(purchase.length).toBeGreaterThanOrEqual(100);
    expect(authorised.length).toBe(store.length + purchase.length);
    expect(authorised.length).toBeGreaterThanOrEqual(107);
  });

  test.each([
    ["store_metric", /^store_metric$/],
    ["inventory item", /inventory_item/],
    ["inventory location", /inventory_location/],
    ["request desk", /^store_request_desk_query$/],
    ["goods receiving", /^store_(receive_query|collection_goods_receipt_query)$/],
    ["procurement / collection", /^store_collection_purchase_order_query$/],
    ["universal Store & Purchase fields", /^store_record_.+_field$/],
  ])("a representative %s capability is reachable", (_label, pattern) => {
    const hit = authorised.filter((t) => pattern.test(t.name));
    expect(hit.length).toBeGreaterThan(0);
  });

  test("the Store read capability alone opens all of them", () => {
    /* No tool in either family asks for more than `sp.read`, so a reader
       loses nothing. Were that ever to change, this says so rather than the
       palette quietly answering less for most people. */
    const all = [...registry._tools.values()]
      .filter((t) => service.APPLICATIONS.includes(t.application));
    expect(authorised.length).toBe(all.length);
  });
});

describe("including both families widens nothing", () => {
  test("without the Store application grant, no capability at all", () => {
    /* A `store_purchase` tool's own check asks only for the purchase read
       capability. Somebody could hold that and not hold Store. The floor is
       what stops the palette reaching further than the Store UI does. */
    const noApp = storeReader({
      applicationAccess: { store: { allowed: false, capabilities: { read: true } } },
    });
    expect(service.hasStoreApplicationAccess(noApp)).toBe(false);
    expect(service.storeToolsFor(noApp)).toEqual([]);
  });

  test("without the Store read capability, no capability at all", () => {
    const noRead = storeReader({
      applicationAccess: { store: { allowed: true, capabilities: { read: false } } },
    });
    expect(service.storeToolsFor(noRead)).toEqual([]);
  });

  test("without the Store & Purchase read capability, the purchase family drops out", () => {
    const noPurchase = storeReader({
      storePurchaseAccess: { capabilities: [], capabilitySet: new Set(), companyId: "c1" },
    });
    const apps = new Set(service.storeToolsFor(noPurchase).map((t) => t.application));
    expect(apps.has("store_purchase")).toBe(false);
  });

  test("without a resolved company, a search is refused", async () => {
    const noTenant = storeReader({
      storePurchaseAccess: {
        capabilities: [CAPABILITIES.READ],
        capabilitySet: new Set([CAPABILITIES.READ]),
        companyId: null,
      },
    });
    expect(service.tenantOf(noTenant)).toBeNull();
    const out = await service.search({ user: noTenant, query: "stock of macbook" });
    expect(out.state).toBe("unauthorised");
    expect(out.groups).toEqual([]);
  });

  test("every reachable capability is Store or Store & Purchase, and nothing else", () => {
    for (const tool of service.storeToolsFor(storeReader())) {
      expect(service.APPLICATIONS).toContain(tool.application);
    }
  });
});

/* ══ BOUNDED SELECTION ════════════════════════════════════════════════════ */

describe("one keystroke does not ask 117 capabilities", () => {
  const authorised = service.storeToolsFor(storeReader());

  const QUESTIONS = [
    "macbook", "stock of macbook", "where is sodium kept", "which rack has soda ash",
    "GRN/2026-27/0004", "goods receipts expected in June 2026",
    "latest five material requests", "purchase orders of Gaurav Enterprises",
    "pending goods receipt inspections", "shortfall for 16mm flex pipe",
  ];

  test.each(QUESTIONS)("%s routes to a bounded candidate set", (question) => {
    const candidates = selectCandidates(authorised, compileIntent(question));
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(MAX_CANDIDATES);
    /* The evidence that matters: a tiny fraction of what is authorised. */
    expect(candidates.length / authorised.length).toBeLessThan(0.1);
  });

  test("a question with nothing to identify routes nowhere, and reads nothing", () => {
    expect(selectCandidates(authorised, compileIntent("the of and it"))).toEqual([]);
  });

  test("capabilities sharing a subject are grouped, so identity is read once", () => {
    const candidates = selectCandidates(authorised, compileIntent("purchase orders of Gaurav Enterprises"));
    const groups = groupBySubject(candidates);
    expect(groups.length).toBeLessThanOrEqual(candidates.length);
    const total = groups.reduce((n, g) => n + g.tools.length, 0);
    expect(total).toBe(candidates.length);
  });

  test("the same question routes the same way every time", () => {
    /* A palette that answered differently on a second press would be worse
       than one that did not answer. */
    const once = names(selectCandidates(authorised, compileIntent("latest five material requests")));
    const twice = names(selectCandidates(authorised, compileIntent("latest five material requests")));
    expect(twice).toEqual(once);
  });

  test("routing reads no database — it is pure", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "..", "services", "ai", "storeCommandRouting.js"), "utf8",
    );
    for (const forbidden of ["await ", "mongoose", "find(", "provideContext", "recognizeSubject("]) {
      expect(src).not.toContain(forbidden);
    }
  });
});

/* ══ THE ONE EXPENSIVE PATH, AND WHEN IT RUNS ═════════════════════════════ */

describe("the catalogue-wide reference lookup is the exception, not the rule", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(
    path.join(__dirname, "..", "..", "services", "ai", "storeCommandSearch.service.js"), "utf8",
  );

  test("it runs only when no capability's own aliases recognised the words", () => {
    /* It is an identity read per family — the most expensive thing on this
       path. "GRN/2026-27/0004" must never reach it, because "GRN" is a goods
       receipt's own alias and routing already has the answer. A bare name
       that matches nobody's vocabulary does reach it, because otherwise
       which capabilities get asked depends on module load order. */
    expect(src).toMatch(/const nothingRecognised = !candidates\.some\(\(tool\) => recognises\(tool, intent\.raw\)\)/);
    /* A reference takes it directly: there is no cheaper way to learn which
       family issued a number nobody's vocabulary recognises. */
    expect(src).toMatch(/if \(Boolean\(intent\.reference\) && nothingRecognised\)/);
    /* A bare NAME reaches it only after the routed capabilities found
       nothing — the cheap attempt first, the catalogue pass last. */
    expect(src).toMatch(/if \(!found\.length && nothingRecognised\)/);
    expect(src).toMatch(/async function lookUpFamily/);
  });

  test("and the set it produces is still bounded", () => {
    expect(src).toMatch(/\.slice\(0, MAX_CANDIDATES\)/);
    expect(MAX_CANDIDATES).toBeLessThanOrEqual(8);
  });
});
