// test/hr-ai/storeCommandArgs.test.js
//
// FILLING A CAPABILITY'S FORM WITHOUT A MODEL.
//
// ── WHAT THIS GUARDS ──────────────────────────────────────────────────────
// The 55 collection capabilities expect their arguments chosen for them. The
// danger in choosing them deterministically is not that a question fails to
// be answered — it is that one is answered with a constraint quietly dropped.
// Four of the assertions below are about exactly that, and each one failed
// against real data before the rule existed.
//
// Every case drives the REAL registered capability. A fabricated tool with a
// hand-written schema would prove the code runs, not that it fits the
// vocabulary the capabilities actually publish.
"use strict";

process.env.TEST_WITHOUT_MONGO = "1";

const args = require("../../services/ai/storeCommandArgs");
const { compileIntent } = require("../../services/ai/storeCommandIntent");
const registry = require("../../services/ai/toolRegistry");
require("../../services/ai/storeCommandSearch.service"); // registers the tools

const tool = (name) => {
  const found = registry.getTool(name);
  if (!found) throw new Error(`${name} is not registered`);
  return found;
};
const fill = (name, question) => args.claimFromIntent(tool(name), compileIntent(question), question);

describe("the form is filled from what the capability publishes", () => {
  test("a plural question lists", () => {
    const out = fill("store_collection_material_request_query", "material requests");
    expect(out).toMatchObject({ operation: "list", metric: args.RECORDS });
  });

  test("a counting question counts", () => {
    const out = fill("store_collection_material_request_query", "how many material requests are there");
    expect(out.operation).toBe("count");
  });

  test("every slot the schema requires is filled", () => {
    const capability = tool("store_collection_purchase_order_query");
    const out = fill("store_collection_purchase_order_query", "purchase orders");
    for (const slot of capability.parameters.required) {
      expect(out[slot]).toBeDefined();
    }
  });

  test("an order and a limit are carried, because the grammar knows both", () => {
    const out = fill("store_collection_material_request_query", "latest five material requests");
    expect(out).toMatchObject({ sort: "descending", limit: 5 });
  });

  test("oldest is the other direction", () => {
    expect(fill("store_collection_material_request_query", "oldest three material requests"))
      .toMatchObject({ sort: "ascending", limit: 3 });
  });
});

describe("a window is attached to a date, or the capability does not answer", () => {
  test("a capability that can place it, does", () => {
    const out = fill("store_receive_query", "goods receipts expected in June 2026");
    expect(out).toMatchObject({
      stage: "expected", dateBasis: "expected_date", from: "2026-06-01", to: "2026-06-30",
    });
  });

  test("a capability that cannot place it does NOT claim the question", () => {
    /* This is the defect in one line: the goods-receipt collection answered
       "expected in June 2026" with a receipt recorded in May, because the
       window was dropped and the rest of the question still ran. */
    expect(fill("store_collection_goods_receipt_query", "goods receipts expected in June 2026"))
      .toBeNull();
  });

  test("the same capability answers the same question without a window", () => {
    expect(fill("store_collection_goods_receipt_query", "goods receipts")).toMatchObject({
      operation: "list",
    });
  });
});

describe("a status is placed where the capability records it, or refused", () => {
  test("a status that is a recorded value becomes a filter", () => {
    const out = fill("store_collection_material_request_query", "pending material requests");
    expect(out.filterMetric).toMatch(/status/);
    expect(out.filterOperator).toBe("equals");
    /* As RECORDED, not as read aloud: a filter compares against what is
       stored, and "partially issued" matches nothing in a column holding
       `PARTIALLY_ISSUED`. */
    expect(out.filterValue).toBe("PENDING");
  });

  test("a capability whose stages ARE its statuses uses a stage", () => {
    const out = fill("store_receive_query", "pending goods receipt inspections");
    expect(out.stage).toBe("action_required");
    expect(out.filterMetric).toBeUndefined();
  });

  test("a capability that records no such status does NOT claim it", () => {
    /* A goods receipt inspection has no status field at all — the record
       exists only once the decision is made — so "pending inspections"
       cannot mean a row of this kind, and answering with every inspection
       was the defect. */
    expect(fill("store_collection_goods_receipt_inspection_query", "pending goods receipt inspections"))
      .toBeNull();
  });
});

describe("an aggregate needs something to aggregate", () => {
  test("summing the records themselves is not a question", () => {
    const intent = compileIntent("total of material requests");
    const out = args.compileArgs(tool("store_collection_material_request_query"), intent, "total of material requests");
    expect(out).toBeNull();
  });
});

describe("the capability must recognise the question first", () => {
  test("a capability the words do not name is not filled", () => {
    expect(fill("store_collection_machine_query", "material requests")).toBeNull();
  });

  test("a capability that owns its own claim is left alone", () => {
    /* `inventory_item_metric` decides for itself. A second opinion here
       would be a second place for the same decision. */
    expect(args.claimFromIntent(tool("inventory_item_metric"), compileIntent("stock of macbook"), "stock of macbook"))
      .toBeNull();
  });
});

describe("the value chooser reads aliases, and refuses a tie", () => {
  const stage = () => tool("store_receive_query").parameters.properties.stage;

  test("the longest matching alias wins", () => {
    expect(args.valueFromMessage(stage(), "anything not yet received here")).toBe("expected");
  });

  test("an unnamed slot falls to its own neutral value", () => {
    expect(args.neutralOf(stage())).toBe("all");
    expect(args.valueFromMessage(stage(), "goods receipts")).toBeNull();
  });

  test("a short alias does not match inside a longer word", () => {
    expect(args.says("predone work", "done")).toBe(false);
    expect(args.says("work is done", "done")).toBe(true);
  });
});
