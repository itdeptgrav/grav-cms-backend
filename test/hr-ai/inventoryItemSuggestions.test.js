"use strict";

const { suggestionTokens } = require("../../services/inventoryItemContext");

describe("inventory item partial-name suggestions", () => {
  test("keeps only the identifying words from stock and location questions", () => {
    expect(suggestionTokens("stock of macbook?")).toEqual(["macbook"]);
    expect(suggestionTokens("where is Apple MacBook kept?")).toEqual(["apple", "macbook"]);
  });

  test("does not propose the whole catalogue when no identity words remain", () => {
    expect(suggestionTokens("what is the stock quantity?")).toEqual([]);
    expect(suggestionTokens("which rack or shelf?")).toEqual([]);
  });
});
