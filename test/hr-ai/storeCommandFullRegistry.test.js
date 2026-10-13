// test/hr-ai/storeCommandFullRegistry.test.js
//
// THE PALETTE, WITH EVERY APPLICATION'S CAPABILITIES REGISTERED — AS THE SERVER
// HAS THEM.
//
// ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
// Every other Store suite loads the Store tool modules only. The server loads
// every application's, through `services/ai/gravAssistant`, in a different
// order — and routing ties used to fall back to registration order. A bare
// material name was answered by the inventory reader in the suites and by a
// supplier reader on the server: tests green, product broken, for a day.
//
// So this suite registers the tool modules in EXACTLY the order
// `gravAssistant.js` does, before the palette loads its own, and asks the
// questions whose answers depended on that order. `gravAssistant` itself is
// not required: it pulls in the model client, and this path must stay
// model-free — the no-model suite pins that separately.
"use strict";

/* The HR tools reach the push sender, whose SDK ships ESM only. Nothing here
   sends a notification; the stub only lets the module load, as the HR
   suites already do. */
jest.mock("expo-server-sdk", () => ({
  Expo: class { static isExpoPushToken() { return false; } chunkPushNotifications() { return []; } },
}));

/* The order of `services/ai/gravAssistant.js`, lines 16-28. If that file's
   order changes, this list should follow it — the test below fails if a
   module it loads is not loaded here. */
const SERVER_ORDER = [
  "hrTools", "accountingTools", "salesTools",
  "storePurchaseTools", "storePurchaseUniversalTools", "storePurchaseCollectionTools",
  "inventoryTools", "plannerTools", "configurationTools",
  "storeTools", "storeCollectionTools", "storeRequestDeskTools", "storeOperationalTools",
];
for (const name of SERVER_ORDER) require(`../../services/ai/tools/${name}`);

const fs = require("fs");
const path = require("path");
const service = require("../../services/ai/storeCommandSearch.service");
const { seedStore, storeReaderFor } = require("../support/storeCommandFixtures");

let store;
let reader;

beforeEach(async () => {
  store = await seedStore();
  reader = storeReaderFor(store.companyId);
});

const ask = (query) => service.search({ user: reader, query });
const rows = (out) => (out.groups || []).flatMap((g) => g.results);
const said = (out) => rows(out).map((r) => `${r.title} ${r.value || ""}`).join(" || ");

describe("the registry is the server's", () => {
  test("it registers what gravAssistant registers, in the same order", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "..", "services", "ai", "gravAssistant.js"), "utf8",
    );
    const order = [...src.matchAll(/require\("\.\/tools\/(\w+)"\)/g)].map((m) => m[1]);
    expect(order).toEqual(SERVER_ORDER);
  });

  test("and other applications' capabilities really are in it", () => {
    /* HR and accounting capabilities carry no `application` tag at all, so
       what is counted is everything that is not Store & Purchase. */
    const others = [...require("../../services/ai/toolRegistry")._tools.values()]
      .filter((tool) => !service.APPLICATIONS.includes(tool.application));
    expect(others.length).toBeGreaterThanOrEqual(25);
  });
});

describe("a supplier by name — with the server's registry", () => {
  test("the supplier itself answers, first, though its orders carry its name", async () => {
    /* "Gaurav Enterprises" is the supplier's companyName AND the vendorName
       on PO/2026-27/0101 — the shape of DIBANKSH ENTERPRISES on the live
       database, which answered with a purchase order. */
    const out = await ask("Gaurav Enterprises");
    expect(out.state).toBe("answered");
    const [first] = rows(out);
    expect(first.href).toBe(`/store/dashboard/vendors-buyer/vendors/view/${store.vendorId}`);
    expect(first.title).toBe("Gaurav Enterprises");
    expect(first.entityType).toBe("supplier_master");
  });

  test("ONE order carrying the name is the exact live shape, and still the supplier leads", async () => {
    /* "Gaurav Enterprises" is on an order AND a receipt, so the catalogue
       pass finds it ambiguous and names nothing — the old fallback happened
       to run. DIBANKSH ENTERPRISES had exactly ONE order: the pass found
       that order, and the supplier master was never asked. */
    const mongoose = require("mongoose");
    const db = mongoose.connection;
    const vendor = new mongoose.Types.ObjectId();
    const order = new mongoose.Types.ObjectId();
    await db.collection("vendors").insertOne({
      _id: vendor, companyId: store.companyId, companyName: "DIBANKSH ENTERPRISES",
      supplierCode: "SUP-DIB", status: "ACTIVE",
    });
    await db.collection("purchaseorders").insertOne({
      _id: order, companyId: store.companyId, poNumber: "PO26094229", vendorId: vendor,
      vendorName: "DIBANKSH ENTERPRISES", status: "ISSUED", poStatus: "ISSUED", items: [],
    });
    const out = await ask("DIBANKSH ENTERPRISES");
    expect(out.state).toBe("answered");
    const [first, ...rest] = rows(out);
    expect(first.href).toBe(`/store/dashboard/vendors-buyer/vendors/view/${vendor}`);
    /* The order is a neighbour, shown after it, never instead of it. */
    expect(rest.map((row) => row.href)).toContain(`/store/dashboard/operations/purchase-order/${order}`);
  });

  test("a supplier nobody has raised an order against is found too", async () => {
    const mongoose = require("mongoose");
    const lonely = new mongoose.Types.ObjectId();
    await mongoose.connection.collection("vendors").insertOne({
      _id: lonely, companyId: store.companyId, companyName: "Fancy Corner",
      supplierCode: "SUP-FANCY", status: "ACTIVE",
    });
    const out = await ask("Fancy Corner");
    expect(out.state).toBe("answered");
    expect(rows(out)[0].href).toBe(`/store/dashboard/vendors-buyer/vendors/view/${lonely}`);
  });

  test("a supplier of ANOTHER company is not found by its name", async () => {
    const other = storeReaderFor(new (require("mongoose").Types.ObjectId)());
    const out = await service.search({ user: other, query: "Gaurav Enterprises" });
    expect(said(out)).not.toMatch(/Gaurav/);
  });

  test("the plural still lists them", async () => {
    const out = await ask("suppliers");
    expect(out.state).toBe("answered");
    expect(said(out)).toMatch(/Gaurav Enterprises/);
  });
});

describe("the questions that once depended on load order", () => {
  test("a bare material name opens the material", async () => {
    const out = await ask("macbook");
    expect(out.state).toBe("answered");
    expect(rows(out)[0].href).toMatch(/^\/store\/dashboard\/raw-items\//);
    expect(said(out)).not.toMatch(/Pro 14/);
  });

  test("a document number answers about that document", async () => {
    const out = await ask("PO/2026-27/0101");
    expect(out.state).toBe("answered");
    expect(said(out)).toMatch(/PO\/2026-27\/0101/);
    expect(said(out)).not.toMatch(/PO\/2026-27\/0102/);
  });

  test("a concept whose phrase contains a family's name answers as that concept", async () => {
    /* "next po number" is the numbering capability's own concept. "po" is
       also a purchase order's family name, and that shorter match used to
       win: the person asking for the next number got a list of existing
       ones. Found on the live database while auditing the numbering
       settings, which the matrix never asks about. */
    const mongoose = require("mongoose");
    const { fiscalYearOf } = require("../../services/storePurchase/documentSequence.service");
    const db = mongoose.connection;
    /* The legacy Store screen's counter — NOT what the question means. */
    await db.collection("purchaseordersettings").insertOne({
      key: "global", prefix: "PO-", suffix: "", padding: 4, counter: 41,
    });
    /* The register's own sequence: 13 issued, so the next is 14 — and
       another company's sequence, which must never be read. */
    const fy = fiscalYearOf(new Date());
    await db.collection("sp_document_sequences").insertMany([
      { companyId: store.companyId, documentType: "PURCHASE_ORDER", fiscalYear: fy, siteId: null, next: 13 },
      { companyId: new mongoose.Types.ObjectId(), documentType: "PURCHASE_ORDER", fiscalYear: fy, siteId: null, next: 90 },
    ]);
    const out = await ask("next po number");
    expect(out.state).toBe("answered");
    /* The owner's decision, 8 Oct 2026: the register, not the legacy counter. */
    expect(said(out)).toContain(`PO/${fy}/0014`);
    expect(said(out)).not.toMatch(/PO-0042|0091/);
    expect(said(out)).not.toMatch(/PO\/2026-27\/010[12]/);
    /* And asking moved nothing. */
    const after = await db.collection("sp_document_sequences").findOne({ companyId: store.companyId });
    expect(after.next).toBe(13);
  });

  test("a company that has issued no purchase order this year starts at 0001", async () => {
    const { fiscalYearOf } = require("../../services/storePurchase/documentSequence.service");
    const out = await ask("next po number");
    expect(said(out)).toContain(`PO/${fiscalYearOf(new Date())}/0001`);
  });

  test("a document number nobody issued is refused, never answered with the list", async () => {
    const out = await ask("PO/2026-27/9999");
    expect(out.state).toBe("no_match");
    expect(said(out)).not.toMatch(/0101|0102/);
  });
});
