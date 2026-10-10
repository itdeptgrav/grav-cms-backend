// test/hr-ai/storeRecordCards.test.js
//
// THE FACTS THAT MATTER ABOUT ONE RECORD, IN CMD/CTRL K — AND ONLY THOSE.
//
// A card is read by canonical id through the same tenant scope and field
// projection as every Store answer. These pin what it shows, when it appears
// at all, and that it cannot become a second, wider way into the data.
"use strict";

const mongoose = require("mongoose");
const service = require("../../services/ai/storeCommandSearch.service");
const { CARDS, MAX_CARDS, recordFromHref } = require("../../services/ai/storeRecordCards");
const { DEFINITIONS_BY_ENTITY } = require("../../services/storePurchaseUniversalContract");
const { seedStore, storeReaderFor } = require("../support/storeCommandFixtures");

let store;
let reader;
beforeEach(async () => {
  store = await seedStore();
  reader = storeReaderFor(store.companyId);
});

const rows = (out) => (out.groups || []).flatMap((g) => g.results);
const cardOf = async (query, user = reader) => rows(await service.search({ user, query })).find((r) => r.card)?.card || null;
const fact = (card, label) => card?.facts.find((f) => f.label === label)?.value;

describe("what a card shows", () => {
  test("a purchase order: supplier, status, total, items", async () => {
    /* The fixture writes `grandTotal`, which the model does not have; the
       real field is `totalAmount`, and a card shows only real fields. */
    await mongoose.connection.collection("purchaseorders").updateOne(
      { _id: store.purchaseOrders.issued }, { $set: { totalAmount: 1200 } },
    );
    const card = await cardOf("PO/2026-27/0101");
    expect(card.title).toBe("PO/2026-27/0101");
    expect(card.status).toBe("Issued");
    expect(fact(card, "Supplier")).toBe("Gaurav Enterprises");
    expect(fact(card, "Total")).toBe("₹1,200");
    expect(fact(card, "Items")).toBe("1");
  });

  test("a goods receipt: supplier, purchase order, date received", async () => {
    const card = await cardOf("GRN/2026-27/0004");
    expect(card.status).toBe("Recorded");
    expect(fact(card, "Supplier")).toBe("Gaurav Enterprises");
    expect(fact(card, "Purchase order")).toBe("PO/2026-27/0101");
    expect(fact(card, "Received on")).toMatch(/2026/);
  });

  test("a material: stock on hand with its unit", async () => {
    const card = await cardOf("macbook");
    expect(card.title).toBe("Macbook");
    expect(fact(card, "SKU")).toBe("MACBOOK");
    expect(fact(card, "Stock on hand")).toBe("4 Nos");
  });

  test("a supplier: code, contact, and how many orders are open", async () => {
    const card = await cardOf("Gaurav Enterprises");
    expect(fact(card, "Code")).toBe("SUP-GAURAV");
    expect(fact(card, "Contact")).toBe("G Rao");
    /* PO/0101 and PO/0103 are issued against this supplier; PO/0102 names
       another supplier. Counted under the same tenant scope. */
    expect(fact(card, "Open orders")).toBe("2");
  });
});

describe("a card never hides the answer", () => {
  test("a lookup's card leads; a question's card sits beneath its answer", async () => {
    const lookup = rows(await service.search({ user: reader, query: "PO/2026-27/0101" })).find((r) => r.card);
    expect(lookup.card.lead).toBe(true);
    /* "where is soda ash kept" is answered by the sentence — the bin. The
       card is the item's context and must not take the sentence's place. */
    const question = rows(await service.search({ user: reader, query: "where is soda ash kept" })).find((r) => r.card);
    expect(question).toBeTruthy();
    expect(question.card.lead).toBe(false);
    expect(question.title).toMatch(/Bin 2/);
  });
});

describe("when a card appears", () => {
  test("never for a list of several: ten records are not one record's summary", async () => {
    /* (A list that holds exactly ONE record is that record, and may show its
       card — "suppliers" in this fixture is one supplier.) */
    for (const query of ["purchase orders", "pending material requests", "material requests"]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await cardOf(query)).toBeNull();
    }
  });

  test("never for a record of another company", async () => {
    const stranger = storeReaderFor(new mongoose.Types.ObjectId());
    expect(await cardOf("PO/2026-27/0101", stranger)).toBeNull();
    expect(await cardOf("Gaurav Enterprises", stranger)).toBeNull();
  });

  test("at most a few per answer", async () => {
    const out = await service.search({ user: reader, query: "macbook" });
    expect(rows(out).filter((r) => r.card).length).toBeLessThanOrEqual(MAX_CARDS);
  });
});

describe("it is not a second way into the data", () => {
  test("a field the contract keeps out never reaches a card", async () => {
    await mongoose.connection.collection("vendors").updateOne(
      { _id: store.vendorId },
      { $set: { bankDetails: { accountNumber: "999988887777", ifscCode: "HDFC0001234", bankName: "Secret Bank" } } },
    );
    const out = await service.search({ user: reader, query: "Gaurav Enterprises" });
    const shown = JSON.stringify(rows(out));
    expect(shown).not.toMatch(/999988887777|HDFC0001234|Secret Bank/);
  });

  test("every fact a card names is a path the contract exposes", () => {
    for (const [entity, card] of Object.entries(CARDS)) {
      const exposed = new Set((DEFINITIONS_BY_ENTITY[entity] || []).map((d) => d.path));
      for (const path of card.paths) expect([entity, path, exposed.has(path)]).toEqual([entity, path, true]);
    }
  });

  test("a card is found only from a trusted Store record link", () => {
    expect(recordFromHref(`/store/dashboard/operations/purchase-order/${store.purchaseOrders.issued}`))
      .toEqual({ entity: "purchase_order", recordId: String(store.purchaseOrders.issued) });
    expect(recordFromHref("/store/dashboard/operations/purchase-order")).toBeNull();
    expect(recordFromHref("https://evil.example/store/dashboard/operations/purchase-order/abc")).toBeNull();
  });
});
