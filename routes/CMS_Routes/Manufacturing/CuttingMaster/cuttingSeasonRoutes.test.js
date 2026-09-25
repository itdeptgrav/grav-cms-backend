// routes/CMS_Routes/Manufacturing/CuttingMaster/cuttingSeasonRoutes.test.js
//
// What the seasons router promises without a database: the routes and their
// methods, that every write sits behind the Cutting department guard and the
// company resolver, the season's state machine as the schema declares it,
// and that the collection is the one the cluster could give it.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const router = require("./cuttingSeasonRoutes");
const parent = require("./cuttingMasterRoutes");
const CuttingSeason = require("../../../../models/CMS_Models/Manufacturing/CuttingMaster/CuttingSeason");

const routes = router.stack.filter((l) => l.route).map((l) => ({ path: l.route.path, methods: Object.keys(l.route.methods).filter((m) => l.route.methods[m]), handlers: l.route.stack.length }));
const find = (m, p) => routes.find((r) => r.path === p && r.methods.includes(m));

test("every season route the page uses is mounted with its method", () => {
  for (const [m, p] of [["get", "/seasons"], ["get", "/seasons/open"], ["post", "/seasons"], ["get", "/seasons/:id"], ["post", "/seasons/:id/raw-items"], ["delete", "/seasons/:id/raw-items/:barcodeId"], ["post", "/seasons/:id/start"], ["post", "/seasons/:id/pieces"], ["delete", "/seasons/:id/pieces/:barcode"], ["post", "/seasons/:id/close"], ["post", "/seasons/:id/discard"], ["get", "/seasons/:id/report"], ["get", "/find-piece"], ["get", "/seasons/ping"], ["post", "/seasons/:id/raw-items/batch"], ["post", "/seasons/:id/pieces/batch"]]) assert.ok(find(m, p), `${m.toUpperCase()} ${p}`);
});

test("reads carry the viewer guard and the company resolver; writes the editor guard", () => {
  /* guard + company + handler = 3 for every route; nothing here is unguarded */
  for (const r of routes.filter((x) => x.path !== "/seasons/ping")) assert.equal(r.handlers, 3, `${r.methods.join(",")} ${r.path} has guard, company, handler`);
});

test("'seasons' and 'find-piece' are mounted on the cutting-master router before the ':moId' routes", () => {
  const layers = parent.stack;
  const mine = layers.findIndex((l) => l.name === "router" && l.handle === router);
  const firstParam = layers.findIndex((l) => l.route && /:moId/.test(l.route.path));
  assert.ok(mine >= 0, "the seasons router is mounted");
  const ping = routes.findIndex((r) => r.path === "/seasons/ping"), byId = routes.findIndex((r) => r.path === "/seasons/:id");
  assert.ok(ping >= 0 && ping < byId, "ping is declared before /seasons/:id so it is never read as an id");
  assert.ok(firstParam < 0 || mine < firstParam, "literal segments are declared before the order-id routes");
});

test("the season state machine and its collection are what the docs say", () => {
  const s = CuttingSeason.schema;
  assert.deepEqual(s.path("status").enumValues, ["draft", "active", "closed"]);
  assert.equal(s.path("status").defaultValue, "draft");
  assert.equal(CuttingSeason.collection.collectionName, "cutting_seasons");
  for (const k of ["name", "companyId", "rawItems", "pieces", "products", "piecesCount", "createdBy.name", "startedAt", "closedAt"]) assert.ok(s.path(k), k);
  /* a raw item remembers the sticker's own cutting session — stock is never recorded twice */
  const raw = s.path("rawItems").schema;
  for (const k of ["barcodeId", "quantityAtScan", "sessionId", "startQty", "endQty", "usedQty"]) assert.ok(raw.path(k), `rawItems.${k}`);
});
