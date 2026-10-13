// test/hr-ai/storeCommandRouter.test.js
//
// A ROUTER BEHIND THE GRAMMAR — AND EVERY WAY IT IS KEPT IN ITS PLACE.
//
// The plan's six guardrails, each one proved here without a model: the
// router is a stub, so what is under test is the contract and the one place
// the service consults it, never the model's judgement.
//
//   1 closed output        a choice must be names from the menu, or it is discarded
//   2 re-authorised        the menu holds only authorised families; the sentence
//                          it becomes is answered by the ordinary, gated path
//   3 typed values only    a value must be words the person typed — and not
//                          the route's own words restated
//   4 bounded              one call per question, never for one the grammar placed
//   5 optional             down, slow, wrong: exactly today's answer
//   6 attributable         a routed answer says how the words were read
"use strict";

const service = require("../../services/ai/storeCommandSearch.service");
const contract = require("../../services/ai/storeCommandRouterContract");
const { routerFromEnv } = require("../../services/ai/storeCommandRouter");
const { seedStore, storeReaderFor } = require("../support/storeCommandFixtures");

let store;
let reader;
beforeEach(async () => {
  store = await seedStore();
  reader = storeReaderFor(store.companyId);
});

const rows = (out) => (out.groups || []).flatMap((g) => g.results);
const said = (out) => rows(out).map((r) => `${r.title} ${r.value || ""}`).join(" || ");
const choice = (over) => ({ family: null, concept: null, operation: "list", status: null, value: null, ...over });
function spyRouter(answer) {
  const calls = [];
  const router = async (args) => {
    calls.push(args);
    return typeof answer === "function" ? answer(args) : answer;
  };
  return { router, calls };
}

/* ══ 1 · THE MENU AND THE SCHEMA ══════════════════════════════════════════ */

describe("what the router is shown", () => {
  test("names only — never a record, a figure, a document number or a person", async () => {
    const tools = service.storeToolsFor(await service.resolveStoreActor(reader));
    const message = "anything about Gaurav Enterprises or GRN/2026-27/0004 or macbook";
    const prompt = contract.promptFor(contract.menuFor(tools, message), message);
    const menuOnly = prompt.slice(0, prompt.lastIndexOf("Search:"));
    for (const secret of ["Gaurav", "GRN/2026-27/0004", "Macbook", "Soda Ash", "Bin 2", "1200"]) {
      expect(menuOnly).not.toContain(secret);
    }
    /* The sentence itself is the one thing it is given. */
    expect(prompt).toContain(message);
  });

  test("a family this person may not use is not on the menu", async () => {
    const tools = service.storeToolsFor(await service.resolveStoreActor(reader));
    /* Both readers of purchase orders: the legacy `store` family has its own,
       and while either is authorised the family is rightly on the menu. */
    const without = tools.filter((tool) => ![
      "store_collection_purchase_order_query", "store_legacy_collection_purchase_order_query",
    ].includes(tool.name));
    const menu = contract.menuFor(without, "purchase orders");
    expect(menu.families.map((f) => f.label)).not.toContain("purchase order");
    /* …so naming it is not a route. */
    expect(contract.validate(choice({ family: "purchase order" }), menu, "purchase orders")).toBeNull();
  });

  test("the output schema is closed: every field is a name it was given, or null", async () => {
    const tools = service.storeToolsFor(await service.resolveStoreActor(reader));
    const menu = contract.menuFor(tools, "goods we received");
    const schema = contract.schemaFor(menu);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.family.enum).toEqual([...menu.families.map((f) => f.label), null]);
    expect(schema.properties.concept.enum).toEqual([...menu.concepts.map((c) => c.key), null]);
    expect(schema.properties.status.enum).toEqual([...menu.statuses, null]);
    expect(schema.properties.operation.enum).toEqual([...contract.OPERATIONS]);
    expect(menu.concepts.length).toBeLessThanOrEqual(contract.MAX_CONCEPTS);
  });
});

/* ══ 2 · THE CHOICE, RE-CHECKED ═══════════════════════════════════════════ */

describe("a choice must survive validation, or it is discarded", () => {
  /* Each case is checked against the menu ITS OWN sentence produces, so a
     refusal is for the reason named and not because the name was never
     offered. */
  let tools;
  beforeEach(async () => {
    tools = service.storeToolsFor(await service.resolveStoreActor(reader));
  });
  const ok = (c, message) => contract.validate(c, contract.menuFor(tools, message), message);

  test("a concept the sentence never uses does not cover the word it was chosen for", () => {
    /* The live menu offered "lines pending after" for store requisitions and
       qwen3:8b chose it with operation "list" — the sentence that becomes is
       "store requisitions", which uses no concept, and "pending" was quietly
       gone. Reproduced on a menu built to match, because which concepts rank
       into the forty depends on the catalogue the sentence meets. */
    const family = {
      id: "requisition", label: "store requisition", aliases: [], plural: "store requisitions",
      statuses: ["draft", "submitted", "converted", "cancelled"],
    };
    const menu = {
      families: [family],
      concepts: [{ key: "lines pending after (store requisition)", phrase: "lines pending after", family: "requisition" }],
      statuses: family.statuses,
      operations: contract.OPERATIONS,
    };
    const c = choice({ family: "store requisition", concept: "lines pending after (store requisition)", operation: "list" });
    expect(contract.validate(c, menu, "requisitions pending")).toBeNull();
    /* Without the concept the same route is refused for the same reason. */
    expect(contract.validate(choice({ family: "store requisition" }), menu, "requisitions pending")).toBeNull();
    /* And a question with no word to drop is routed. */
    expect(contract.validate(choice({ family: "store requisition" }), menu, "requisitions")).not.toBeNull();
  });

  test.each([
    ["a family that is not on the menu", choice({ family: "spaceship" }), "spaceship orders"],
    ["neither a family nor a concept", choice({}), "orders"],
    ["an operation that does not exist", choice({ family: "purchase order", operation: "delete" }), "purchase orders"],
    ["a status this family does not record", choice({ family: "purchase order", status: "open" }), "open purchase orders"],
    ["a value the person never typed", choice({ family: "purchase order", value: "Gaurav Enterprises" }), "purchase orders from someone"],
    ["a field the schema does not have", { ...choice({ family: "purchase order" }), sql: "drop" }, "purchase orders"],
    ["not an object at all", "purchase orders", "purchase orders"],
    /* ("stuff in the store" WOULD anchor it — "store warehouse" is an alias.) */
    ["a real family the words never mention", choice({ family: "warehouse" }), "things lying around"],
    /* The two wrong routes the provisional corpus found: each dropped a word
       the person typed, and so answered a wider question. */
    ["a route that drops a status the person typed", choice({ family: "store requisition" }), "requisitions pending"],
    ["a route that drops the rest of the question", choice({ family: "stock item" }), "why is our fabric stock wrong"],
  ])("refuses %s", (_why, c, message) => {
    expect(ok(c, message)).toBeNull();
  });

  test("a value that only restates the route is set aside — it constrains nothing", () => {
    const routed = ok(choice({ family: "purchase order", operation: "count", value: "POs" }), "how many POs");
    expect(routed.value).toBeNull();
    expect(contract.sentenceFor(routed, {})).toBe("how many purchase orders");
  });

  test("…but a value with a word of its own stays a filter", () => {
    const routed = ok(choice({ family: "purchase order", value: "Gaurav Enterprises" }), "purchase orders from Gaurav Enterprises");
    expect(contract.sentenceFor(routed, {})).toBe("purchase orders of Gaurav Enterprises");
  });

  test("a family chosen by a word's stem is anchored (\"supplies\" → supplier)", () => {
    expect(contract.sentenceFor(ok(choice({ family: "supplier" }), "who supplies us"), {})).toBe("suppliers");
  });

  test("a rephrasing that keeps every word is still accepted", () => {
    /* "received" is accounted for by "receipt", on its stem. */
    expect(contract.sentenceFor(ok(choice({ family: "goods receipt" }), "goods we received"), {})).toBe("goods receipts");
  });

  test("accepts a choice anchored in the words, and writes it in the catalogue's", () => {
    const valid = ok(choice({ family: "purchase order", operation: "count", status: "draft" }), "how many POs are still draft");
    expect(contract.sentenceFor(valid, {})).toBe("how many draft purchase orders");
    const named = ok(choice({ family: "purchase order", value: "Gaurav Enterprises" }), "what did we order from Gaurav Enterprises");
    expect(contract.sentenceFor(named, {})).toBe("purchase orders of Gaurav Enterprises");
  });
});

/* ══ 3 · WHERE THE SERVICE CONSULTS IT ════════════════════════════════════ */

describe("the one place it plugs in", () => {
  test("a question the grammar placed never reaches the router", async () => {
    const { router, calls } = spyRouter(() => { throw new Error("must not be called"); });
    for (const query of [
      "macbook", "stock of macbook", "where is soda ash kept", "GRN/2026-27/0004",
      "goods receipts expected in June 2026", "latest five material requests",
      "purchase orders of Gaurav Enterprises", "pending material requests", "Gaurav Enterprises",
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const out = await service.search({ user: reader, query, router });
      expect(["answered", "choices"]).toContain(out.state);
    }
    expect(calls).toEqual([]);
  });

  test("words it could not place are translated, answered by the ordinary path, and say so", async () => {
    const query = "goods we received";
    const without = await service.search({ user: reader, query });
    expect(without.state).not.toBe("answered");

    const { router, calls } = spyRouter(choice({ family: "goods receipt", operation: "list" }));
    const out = await service.search({ user: reader, query, router });
    expect(calls).toHaveLength(1);
    expect(out.state).toBe("answered");
    expect(out.note).toBe('Read as "goods receipts".');
    for (const row of rows(out)) expect(row.metadata?.via).toBe("router");

    /* The SAME answer the deterministic layer gives the sentence directly. */
    const direct = await service.search({ user: reader, query: "goods receipts" });
    expect(said(out)).toBe(said(direct));
  });

  test("a value is a filter, never a widening: a name nobody has answers nothing", async () => {
    const { router } = spyRouter(choice({ family: "purchase order", value: "Nobody Traders" }));
    const out = await service.search({ user: reader, query: "what did we order from Nobody Traders", router });
    expect(said(out)).not.toMatch(/PO\/2026-27\/010[12]/);
  });

  describe("and when the router is down, slow or wrong, the answer is today's", () => {
    const UNPLACED = ["goods we received", "stuff in the store", "the of and it", "what did we order from Nobody"];
    test.each([
      ["unreachable", () => Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "OLLAMA_UNAVAILABLE" }))],
      ["timed out", () => Promise.reject(Object.assign(new Error("timeout"), { code: "OLLAMA_TIMEOUT" }))],
      ["returns prose", () => "purchase orders, probably"],
      ["returns null", () => null],
      ["returns a name off the menu", () => choice({ family: "invoices" })],
      ["invents a value", () => choice({ family: "purchase order", value: "Gaurav Enterprises" })],
    ])("%s", async (_why, behaviour) => {
      for (const query of UNPLACED) {
        // eslint-disable-next-line no-await-in-loop
        const before = await service.search({ user: reader, query });
        // eslint-disable-next-line no-await-in-loop
        const after = await service.search({ user: reader, query, router: behaviour });
        expect(after).toEqual(before);
      }
    });
  });
});

/* ══ 4 · THE MODEL CALLER ═════════════════════════════════════════════════ */

describe("the model caller", () => {
  test("is off unless STORE_COMMAND_ROUTER is set", () => {
    expect(routerFromEnv({})).toBeNull();
    expect(routerFromEnv({ STORE_COMMAND_ROUTER: "off" })).toBeNull();
  });

  test("asks qwen3:8b on local Ollama by default — never the assistant's OLLAMA_* settings", async () => {
    const seen = [];
    const route = routerFromEnv(
      { STORE_COMMAND_ROUTER: "qwen", OLLAMA_BASE_URL: "http://127.0.0.1:11436", OLLAMA_MODEL: "qwen3:32b" },
      { chat: async (args) => { seen.push(args); return { data: choice({ family: "goods receipt" }) }; } },
    );
    const menu = { families: [{ label: "goods receipt" }], concepts: [], statuses: [], operations: contract.OPERATIONS };
    await route({ message: "goods we received", menu });
    expect(seen).toHaveLength(1);
    expect(seen[0].model).toBe("qwen3:8b");
    expect(seen[0].baseUrl).toBe("http://127.0.0.1:11434");
    expect(seen[0].timeoutMs).toBeLessThanOrEqual(5000);
    expect(seen[0].schema.additionalProperties).toBe(false);
  });

  test("the search service never loads it", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "services", "ai", "storeCommandSearch.service.js"), "utf8");
    expect(src).not.toMatch(/require\(["'][^"']*storeCommandRouter["']\)/);
    const contractSrc = fs.readFileSync(path.join(__dirname, "..", "..", "services", "ai", "storeCommandRouterContract.js"), "utf8");
    expect(contractSrc).not.toMatch(/require\(["'][^"']*(qwen|ollama|gravAssistant)/i);
  });
});
