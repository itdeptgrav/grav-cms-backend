"use strict";

process.env.TEST_WITHOUT_MONGO = "1";

const {
  sanitizeAssistantLink,
  sanitizeAssistantLinks,
  storeRecordHref,
  recordLink,
} = require("../../services/ai/assistantLinks");
const convo = require("../../services/ai/conversationStore");
require("../../services/ai/tools/storePurchaseUniversalTools");
require("../../services/ai/tools/storePurchaseCollectionTools");
require("../../services/ai/tools/storePurchaseTools");
require("../../services/ai/tools/inventoryTools");
require("../../services/ai/tools/storeRequestDeskTools");
require("../../services/ai/tools/storeOperationalTools");
const { getTool } = require("../../services/ai/toolRegistry");

describe("assistant record navigation", () => {
  beforeEach(() => convo._clearAll());

  test("builds only catalogued Store record destinations", () => {
    expect(storeRecordHref("goods_receipt", "507f1f77bcf86cd799439011"))
      .toBe("/store/dashboard/operations/goods-receipts/507f1f77bcf86cd799439011");
    expect(storeRecordHref("purchase_order", "507f1f77bcf86cd799439011"))
      .toBe("/store/dashboard/operations/purchase-order/507f1f77bcf86cd799439011");
    expect(storeRecordHref("unknown_entity", "507f1f77bcf86cd799439011")).toBeNull();
    expect(storeRecordHref("goods_receipt", "../../admin")).toBeNull();
  });

  test("accepts same-origin CMS paths and rejects unsafe URLs", () => {
    expect(sanitizeAssistantLink({ label: "Open GRN/1", href: "/store/dashboard/operations/goods-receipts/abc" }))
      .toEqual({
        label: "Open GRN/1",
        href: "/store/dashboard/operations/goods-receipts/abc",
        kind: "record",
      });
    expect(sanitizeAssistantLink({ label: "bad", href: "javascript:alert(1)" })).toBeNull();
    expect(sanitizeAssistantLink({ label: "bad", href: "//evil.example/steal" })).toBeNull();
    expect(sanitizeAssistantLink({ label: "bad", href: "https://evil.example/steal" })).toBeNull();
  });

  test("deduplicates links and persists them with assistant history", () => {
    const link = recordLink("goods_receipt", "507f1f77bcf86cd799439011", "GRN/2026/1");
    const links = sanitizeAssistantLinks([link, link]);
    expect(links).toHaveLength(1);
    convo.append("employee-1", { role: "assistant", content: "Found it.", links });
    expect(convo.getHistory("employee-1")[0].links).toEqual(links);
  });

  test("receiving results expose the authoritative next-action destination", () => {
    const tool = getTool("store_receive_query");
    expect(tool.buildLinks({
      data: {
        rows: [{
          reference: "PO26066392",
          nextAction: { href: "/store/dashboard/operations/purchase-order/507f1f77bcf86cd799439011/receive" },
        }],
      },
    })).toEqual([{
      label: "Open PO26066392",
      href: "/store/dashboard/operations/purchase-order/507f1f77bcf86cd799439011/receive",
      kind: "record",
    }]);
  });

  test("exact and collection tools build links without asking Qwen for a URL", () => {
    const exact = getTool("store_record_purchase_order_field");
    expect(exact.buildLinks({ data: { resolution: {
      found: true,
      recordId: "507f1f77bcf86cd799439011",
      label: "PO/2026/1",
    } } })).toEqual([{
      label: "Open PO/2026/1",
      href: "/store/dashboard/operations/purchase-order/507f1f77bcf86cd799439011",
      kind: "record",
    }]);

    const collection = getTool("store_collection_goods_receipt_query");
    expect(collection.buildLinks({ data: { navigation: [{
      entity: "goods_receipt",
      recordId: "507f1f77bcf86cd799439011",
      label: "GRN/2026/1",
    }] } })).toEqual([{
      label: "Open GRN/2026/1",
      href: "/store/dashboard/operations/goods-receipts/507f1f77bcf86cd799439011",
      kind: "record",
    }]);
  });

  test("specialized Store tools use the same trusted link contract", () => {
    expect(getTool("inventory_item_metric").buildLinks({ data: { item: {
      found: true,
      record: { _id: "507f1f77bcf86cd799439011", name: "Cotton Fabric" },
    } } })).toEqual([{
      label: "Open Cotton Fabric",
      href: "/store/dashboard/raw-items/raw-items-view/507f1f77bcf86cd799439011",
      kind: "record",
    }]);

    expect(getTool("inventory_item_metric").buildLinks({ data: { item: {
      found: false,
      ambiguous: true,
      suggested: true,
      matches: [{
        _id: "507f1f77bcf86cd799439012",
        name: "Apple MacBook Air",
        sku: "RAW-MACBOOK",
      }],
    } } })).toEqual([]);

    expect(getTool("store_request_desk_query").buildLinks({ data: { navigation: [{
      type: "material",
      recordId: "507f1f77bcf86cd799439011",
      label: "MRF-001",
    }] } })).toEqual([{
      label: "Open MRF-001",
      href: "/store/dashboard/order-requests/mrf/507f1f77bcf86cd799439011",
      kind: "record",
    }]);

    expect(getTool("store_operational_workspace_query").buildLinks({ data: {
      view: "purchase_exceptions",
      rows: [{ poId: "507f1f77bcf86cd799439011", poNumber: "PO-001" }],
    } })).toEqual([{
      label: "Open PO-001",
      href: "/store/dashboard/operations/purchase-order/507f1f77bcf86cd799439011",
      kind: "record",
    }]);
  });
});
