"use strict";

const { getTool } = require("../../services/ai/toolRegistry");
const { semanticToolCandidates } = require("../../services/ai/semanticCatalogue");
require("../../services/ai/tools/accountingTools");
require("../../services/ai/tools/storeRequestDeskTools");

describe("Store Request Desk routing boundary", () => {
  test("generic Store request language matches the unified desk capability", () => {
    expect(getTool("store_request_desk_query").matches("give me top five latest requests")).toBe(true);
  });

  test("the broad accounting report no longer claims an unrelated request question", () => {
    expect(getTool("acc_report_query").matches("give me top five latest requests")).toBe(false);
    expect(getTool("acc_report_query").matches("top five ledgers by debit turnover")).toBe(true);
  });

  test("latest requests cannot enter the Accounting candidate set", () => {
    const candidates = semanticToolCandidates([
      getTool("store_request_desk_query"),
      getTool("acc_report_query"),
    ], "give me top five latest requests");
    expect(candidates.map((tool) => tool.name)).toEqual(["store_request_desk_query"]);
  });
});
