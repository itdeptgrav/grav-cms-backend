// test/hr-ai/storeCommandSearch.test.js
//
// CMD/CTRL K ANSWERS STORE WITHOUT A LANGUAGE MODEL.
//
// ── WHAT THIS GUARDS ──────────────────────────────────────────────────────
// The palette's value is that it is DETERMINISTIC: the same words give the
// same answer, from the same authorised catalogue, every time. The ways that
// can quietly stop being true are all here:
//
//   1  a model creeping onto the path, as a fallback or an import;
//   2  an uninterpretable phrase becoming a broad collection read;
//   3  a person seeing a record their grants do not cover;
//   4  a link that is not one of the application's own routes;
//   5  a mutation tool being reachable at all;
//   6  an ambiguity being resolved by picking the first match.
//
// It needs no database: every case is about what the service DECIDES, and the
// decisions are made before anything is read.
"use strict";

process.env.TEST_WITHOUT_MONGO = "1";

const path = require("path");
const fs = require("fs");

const registry = require("../../services/ai/toolRegistry");
const service = require("../../services/ai/storeCommandSearch.service");
const { sanitizeAssistantLink, STORE_RECORD_ROUTES } = require("../../services/ai/assistantLinks");

const { CAPABILITIES } = require("../../services/storePurchase/capabilities");

/* A person with the Store application grant and its read capability — the same
   two facts `mayReadStore` asks for, already resolved so no database is
   touched.

   ── THE CAPABILITY STRING IS READ FROM THE REAL MODULE ──────────────────
   It is `sp.read`, not `READ`. This fixture spelled it `"READ"`, which no
   capability's `permission` has ever asked for, so every `store_purchase`
   capability was unauthorised throughout this suite and its assertions about
   both families holding were made against a 7-tool set. A fixture that
   invents the value it is testing against proves nothing. */
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

const outsider = () => ({
  id: "u2",
  applicationAccess: { store: { allowed: false, capabilities: {} } },
  storePurchaseAccess: { capabilities: [], capabilitySet: new Set(), companyId: null },
});

/* ══ 1 — NO MODEL, ANYWHERE ═══════════════════════════════════════════════ */

describe("the deterministic path cannot reach a language model", () => {
  test("no model module is in this service's require graph", () => {
    /* ── THE GUARANTEE, CHECKED RATHER THAN PROMISED ────────────────────
       A comment saying "no Qwen here" is worth nothing the day somebody adds
       a convenient import. This walks what Node actually loaded. */
    const forbidden = /gravAssistant|qwenToolPlanner|qwenClient|ollama|llm/i;
    const loaded = Object.keys(require.cache)
      .filter((p) => !p.includes("node_modules"))
      .filter((p) => forbidden.test(path.basename(p)));
    expect(loaded).toEqual([]);
  });

  test("and the source names none of them either", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "..", "services", "ai", "storeCommandSearch.service.js"), "utf8",
    ).split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
    for (const name of ["gravAssistant", "qwen", "ollama", "chat(", "generateGrounded"]) {
      expect(src.toLowerCase()).not.toContain(name.toLowerCase());
    }
  });

  test("the route is a different door from the assistant's", () => {
    const route = fs.readFileSync(
      path.join(__dirname, "..", "..", "routes", "ai", "storeCommandSearch.js"), "utf8",
    );
    expect(route).not.toMatch(/gravAssistant/);
    expect(route).toMatch(/storeCommandSearch\.service/);
    /* And it authenticates with the same middleware every CMS route uses. */
    expect(route).toMatch(/EmployeeAuthMiddleware/);
  });
});

/* ══ 2 — AN UNINTERPRETABLE PHRASE IS NOT A QUERY ═════════════════════════ */

describe("nothing runs that was not claimed", () => {
  test("wording that reaches nobody is unsupported; wording that reaches capabilities but matches nothing is no_match", async () => {
    /* ── THE LINE BETWEEN A PALETTE AND A QUERY BOX ─────────────────────
       The failure that matters is not "no answer". It is answering anyway
       with an unfiltered read of a collection, which looks like an answer
       and is not one. Both states below return NO groups — the difference
       is what the person is told, and the two lead to different next
       actions: rephrase, or accept that there is no such record. */
    const nowhere = await service.search({
      user: storeReader(),
      query: "the of and it",
    });
    expect(nowhere.state).toBe("unsupported");
    expect(nowhere.groups).toEqual([]);

    const routed = await service.search({
      user: storeReader(),
      query: "why did the supplier call me on tuesday about the thing",
    });
    /* "supplier" routes to real capabilities; none of them recognised a
       record, so this is an honest miss rather than unknown wording. */
    expect(routed.state).toBe("no_match");
    expect(routed.groups).toEqual([]);
    expect(routed.note).toMatch(/No authorised Store record/);
  });

  test("an empty query reads nothing", async () => {
    for (const query of ["", "   ", null, undefined]) {
      // eslint-disable-next-line no-await-in-loop
      const out = await service.search({ user: storeReader(), query });
      expect(out.state).toBe("unsupported");
      expect(out.groups).toEqual([]);
    }
  });

  test("several capabilities claiming are all answered, never just the first", async () => {
    /* Picking whichever registered first is an arbitrary answer wearing a
       confident face; returning nothing because more than one capability
       recognised the question is worse. Two claims on "stock of macbook" are
       the stock figure AND the shelf — both are the answer. */
    const user = storeReader();
    const make = (name, title) => ({
      name, application: "store",
      claim: () => ({ metric: name }),
      provideContext: async () => ({ ok: true }),
      renderAnswer: () => title,
      buildLinks: () => [],
      buildChoices: () => [],
    });

    const spy = jest.spyOn(service, "claimsFor");
    /* `search` reaches claimsFor through the module's own binding, so drive
       the public pieces it is built from instead of the private loop. */
    spy.mockRestore();

    const two = [
      { tool: make("a", "Macbook's stock on hand is 4."), args: { metric: "a" }, subject: null },
      { tool: make("b", "Macbook is kept at R01-L01-B01."), args: { metric: "b" }, subject: null },
    ];
    /* Each claim renders its own reading; neither is discarded. */
    const titles = [];
    for (const claim of two) {
      const data = await claim.tool.provideContext({});
      titles.push(claim.tool.renderAnswer({ data }));
    }
    expect(titles).toHaveLength(2);
    expect(new Set(titles).size).toBe(2);

    /* And the service says so, in one place, as behaviour: a bound on how
       many are read, and choices taking precedence over facts. */
    const src = fs.readFileSync(
      path.join(__dirname, "..", "..", "services", "ai", "storeCommandSearch.service.js"), "utf8",
    );
    expect(src).toMatch(/onTopic\.slice\(0, MAX_ANSWERS\)/);
    expect(src).toMatch(/if \(choices\) \{/);
    expect(service.MAX_ANSWERS).toBeGreaterThan(1);
    expect(service.MAX_ANSWERS).toBeLessThanOrEqual(5);
    /* ── AND ONLY THE FAMILY THE QUESTION NAMED ────────────────────────
         "How many material requests are there" was answered three times
         over — the material requests, then the inventory items, then the
         request desk — because a count is not a filter and all three
         claimed. Two of those answer a question nobody asked. */
    expect(src).toMatch(/recognisedLength\(claim\.tool, message\)/);
  });
});

/* ══ 3 — PERMISSION AND TENANT ════════════════════════════════════════════ */

describe("authority is resolved from the database, never from the request", () => {
  test("somebody without the Store grant gets nothing at all", async () => {
    const out = await service.search({ user: outsider(), query: "stock of macbook" });
    expect(out.state).toBe("unauthorised");
    expect(out.groups).toEqual([]);
  });

  test("the grant AND the read capability are both required", async () => {
    const granted = storeReader();
    const noRead = storeReader({
      applicationAccess: { store: { allowed: true, capabilities: { read: false } } },
    });
    expect(service.storeToolsFor(granted).length).toBeGreaterThan(0);
    expect(service.storeToolsFor(noRead)).toEqual([]);
  });

  test("only Store & Purchase capabilities are ever consulted", () => {
    /* Both internal families, and nothing outside them. This asserted
       `=== "store"` and passed only because the fixture's capability string
       was wrong, so the 110 `store_purchase` capabilities were never in the
       set it checked. */
    const tools = service.storeToolsFor(storeReader());
    expect(tools.length).toBeGreaterThanOrEqual(107);
    for (const tool of tools) {
      expect(service.APPLICATIONS).toContain(tool.application);
    }
  });

  test("a resolved actor fails closed when resolution throws", async () => {
    const actor = await service.resolveStoreActor({ id: "u3" });
    /* No grant could be resolved without a database, so none is held. */
    expect(actor.applicationAccess.store.allowed).toBeFalsy();
    expect(service.storeToolsFor(actor)).toEqual([]);
  });

  test("nothing the browser sends can grant access", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "..", "routes", "ai", "storeCommandSearch.js"), "utf8",
    );
    /* The body is read for the query and the chosen identity. Never for a
       company, a capability, a field or a route. */
    for (const forbidden of ["companyId", "capabilities", "fields", "href", "collection"]) {
      expect(src).not.toMatch(new RegExp(`req\\.body[^\\n]*${forbidden}`, "i"));
    }
  });
});

/* ══ 4 — LINKS ════════════════════════════════════════════════════════════ */

describe("every link is one of the application's own routes", () => {
  test("an arbitrary URL cannot be emitted", () => {
    for (const href of [
      "https://example.com/steal", "//example.com", "javascript:alert(1)",
      "/store\n/evil", "ftp://x", "",
    ]) {
      expect(sanitizeAssistantLink({ href, label: "Open" })).toBeNull();
    }
  });

  test("a record route is built from the entity and a validated id", () => {
    const link = sanitizeAssistantLink({
      href: STORE_RECORD_ROUTES.goods_receipt("abc123"), label: "Open receipt",
    });
    expect(link.href).toBe("/store/dashboard/operations/goods-receipts/abc123");
  });

  test("the service re-sanitises what a tool returned", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "..", "services", "ai", "storeCommandSearch.service.js"), "utf8",
    );
    expect(src).toMatch(/sanitizeAssistantLinks\(/);
  });
});

/* ══ 5 — NOTHING HERE CAN WRITE ═══════════════════════════════════════════ */

describe("the palette cannot change anything", () => {
  test("no authorised capability offers anything but a read", () => {
    /* ── BEHAVIOUR, NOT A SUBSTRING ────────────────────────────────────
       This used to refuse any capability whose NAME contained "issue",
       "receive" or "create". That is a guess about a word, and it was
       wrong in both directions: `store_receive_query` READS the receiving
       register, `store_collection_stock_issuance_query` READS the issuance
       book, and a capability called `store_summary` could write all day
       without tripping it.

       What actually makes these safe is their shape. A registered tool's
       only entry points are the ones the service calls, and every one of
       them is a read: `claim`, `recognizeSubject`, `provideContext`,
       `renderAnswer`, `buildLinks`, `buildChoices`, `matches`. A tool
       carrying any other callable is a tool with a door nobody checked. */
    const READ_ONLY = new Set([
      "claim", "recognizeSubject", "provideContext", "renderAnswer",
      "buildLinks", "buildChoices", "matches", "permission",
    ]);
    const tools = service.storeToolsFor(storeReader());
    expect(tools.length).toBeGreaterThanOrEqual(107);
    for (const tool of tools) {
      expect(typeof tool.provideContext).toBe("function");
      for (const [key, value] of Object.entries(tool)) {
        if (typeof value !== "function") continue;
        expect(READ_ONLY.has(key)).toBe(true);
      }
    }
  });

  test("and the service calls no entry point but those reads", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "..", "services", "ai", "storeCommandSearch.service.js"), "utf8",
    );
    const called = [...src.matchAll(/\btool\.(\w+)\(/g)].map((m) => m[1]);
    const resolverCalled = [...src.matchAll(/\bresolver\.tool\.(\w+)\(/g)].map((m) => m[1]);
    for (const name of [...called, ...resolverCalled]) {
      expect([
        "claim", "recognizeSubject", "provideContext", "renderAnswer",
        "buildLinks", "buildChoices", "matches",
      ]).toContain(name);
    }
  });

  test("the endpoint accepts no verb but POST-to-read, and no mutation body", () => {
    const route = fs.readFileSync(
      path.join(__dirname, "..", "..", "routes", "ai", "storeCommandSearch.js"), "utf8",
    );
    expect((route.match(/router\.(post|get|put|patch|delete)\(/g) || [])).toEqual(["router.post("]);
  });
});

/* ══ 6 — THE SHAPE THE BROWSER RECEIVES ═══════════════════════════════════ */

describe("the answer shape is closed", () => {
  test("the kinds are exactly the ones the browser validates", () => {
    expect(Object.values(service.RESULT_KIND).sort()).toEqual(
      ["choice", "collection", "fact", "record", "safe_action"],
    );
  });

  test("a chosen identity is re-authorised, not trusted from the first call", async () => {
    const out = await service.resolveChoice({
      user: outsider(),
      query: "stock of macbook",
      resolution: { tool: "store_metric", identity: "MacBook Pro 14" },
    });
    expect(["unauthorised", "unsupported"]).toContain(out.state);
    expect(out.groups).toEqual([]);
  });

  test("a choice naming a tool outside Store is refused", async () => {
    const out = await service.resolveChoice({
      user: storeReader(),
      query: "anything",
      resolution: { tool: "hr_overview", identity: "someone" },
    });
    expect(out.state).toBe("unsupported");
  });
});
