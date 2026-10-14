"use strict";
/**
 * The cutting season's log book over HTTP (14 Oct 2026): header, add / edit /
 * delete a lay, the worked-out columns and summary on every answer, closing
 * without any scanning, and a closed season refusing changes. The cutting
 * access guards are stubbed — what is tested here is the log book, and the
 * guards have their own suite.
 */
const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../routes/CMS_Routes/Manufacturing/CuttingMaster/cuttingAccess", () => {
  const actual = jest.requireActual("../../routes/CMS_Routes/Manufacturing/CuttingMaster/cuttingAccess");
  return {
    ...actual,
    cuttingDepartment: () => (req, _res, next) => next(),
    cuttingCompany: (req, _res, next) => { req.cutting = { companyId: req.app.locals.companyId }; next(); },
  };
});

const CuttingSeason = require("../../models/CMS_Models/Manufacturing/CuttingMaster/CuttingSeason");

let server, base;
beforeAll(async () => {
  const app = express();
  app.locals.companyId = new mongoose.Types.ObjectId();
  global.__cuttingCompanyId = app.locals.companyId;
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: String(new mongoose.Types.ObjectId()), name: "Bablu", employeeId: "GR0042" }; next(); });
  app.use("/cm", require("../../routes/CMS_Routes/Manufacturing/CuttingMaster/cuttingSeasonRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/cm`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

async function call(method, path, body) {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const LAY = {
  date: "2026-09-22", tableNo: "T-1", cuttingMaster: "Bablu", styleNo: "RC-2041", colour: "Navy", layNo: "L-01",
  fabricLot: "Lot 7 / Shade A", markerLength: 8.6, markerWidth: 58, markerEff: 84,
  ratio: { S: 1, M: 2, L: 2, XL: 1 }, plies: 60, fabricIssued: 540, fabricReturned: 10, bomCons: 1.45, remarks: "first lay",
};

test("a season is ONE lay, dated by the season, filled in like the register and closed without scanning", async () => {
  const created = await call("POST", "/seasons", { name: "Monday T-1" });
  expect(created.status).toBe(201);
  const id = created.body.season.id;

  const header = await call("PUT", `/seasons/${id}/header`, { buyerName: "Ripple", poNo: "MO-REQ-0041", styleNo: "RC-2041", colour: "Navy", date: "2026-09-22" });
  expect(header.status).toBe(200);
  expect(header.body.season.header.buyerName).toBe("Ripple");

  const refused = await call("POST", `/seasons/${id}/lays`, { ...LAY, plies: 0 });
  expect(refused.status).toBe(400);
  expect(refused.body.message).toMatch(/plies/);

  /* no date is asked: the lay takes the season's */
  const { date, ...noDate } = LAY;
  void date;
  const added = await call("POST", `/seasons/${id}/lays`, noDate);
  expect(added.status).toBe(201);
  expect(added.body.lay).toMatchObject({ garmentsPerPly: 6, pcsCut: 360, fabricConsumed: 530, markerReq: 516, wastage: 14, status: "OK", markerEff: 0.84 });
  expect(new Date(added.body.lay.date).toISOString().slice(0, 10)).toBe("2026-09-22");
  expect(added.body.lay.createdBy.name).toBe("Bablu");
  const layId = added.body.lay.id;

  /* one lay a season: the next is refused and pointed at the one there is */
  const second = await call("POST", `/seasons/${id}/lays`, { ...noDate, layNo: "L-02" });
  expect(second.status).toBe(409);
  expect(second.body.code).toBe("ONE_LAY_PER_SEASON");
  expect(second.body.layId).toBe(layId);

  const edited = await call("PUT", `/seasons/${id}/lays/${layId}`, { ...noDate, plies: 50, fabricIssued: 445 }); // 435 m over 300 pcs = 1.45 m/pc
  expect(edited.status).toBe(200);
  expect(edited.body.season.lays).toHaveLength(1);
  expect(edited.body.season.lays[0]).toMatchObject({ plies: 50, pcsCut: 300, status: "OK" });

  /* moving the report's date moves the lay with it */
  const moved = await call("PUT", `/seasons/${id}/header`, { buyerName: "Ripple", poNo: "MO-REQ-0041", styleNo: "RC-2041", colour: "Navy", date: "2026-09-23" });
  expect(new Date(moved.body.season.lays[0].date).toISOString().slice(0, 10)).toBe("2026-09-23");

  const discard = await call("POST", `/seasons/${id}/discard`, {});
  expect(discard.status).toBe(409); // a season with its lay is never thrown away by accident

  const closed = await call("POST", `/seasons/${id}/close`, { remaining: {} });
  expect(closed.status).toBe(200);
  expect(closed.body.season.status).toBe("closed");

  /* Closed: still editable for 24 hours, then final (14 Oct 2026). */
  const until = new Date(closed.body.season.editableUntil).getTime();
  expect(until - new Date(closed.body.season.closedAt).getTime()).toBe(24 * 3600 * 1000);
  expect(closed.body.season.editable).toBe(true);
  expect((await call("PUT", `/seasons/${id}/lays/${layId}`, { ...noDate, plies: 50, fabricIssued: 445 })).status).toBe(200);
  expect((await call("DELETE", `/seasons/${id}/lays/${layId}`)).status).toBe(409); // a closed season keeps its lay
  const fixedHeader = await call("PUT", `/seasons/${id}/header`, { buyerName: "Ripple", poNo: "MO-REQ-0041", styleNo: "RC-2041", colour: "Navy" });
  expect(fixedHeader.status).toBe(200);
  expect(fixedHeader.body.season.status).toBe("closed");
  /* a day and a minute later it is final */
  await CuttingSeason.updateOne({ _id: id }, { $set: { closedAt: new Date(Date.now() - 24 * 3600 * 1000 - 60000) } });
  const late = await call("PUT", `/seasons/${id}/lays/${layId}`, noDate);
  expect(late.status).toBe(409);
  expect(late.body.code).toBe("SEASON_FINAL");
  expect((await call("PUT", `/seasons/${id}/header`, { buyerName: "x" })).status).toBe(409);
  expect((await call("GET", `/seasons/${id}`)).body.season.editable).toBe(false);

  const report = await call("GET", `/seasons/${id}/report`);
  expect(report.body.season.lays).toHaveLength(1);
  expect(report.body.season.header.poNo).toBe("MO-REQ-0041");
  expect(report.body.season.log.sizeWise).toEqual({ XS: 0, S: 50, M: 100, L: 100, XL: 50, XXL: 0, "3XL": 0 });

  /* The list carries the summary, not the lay. */
  const list = await call("GET", "/seasons?status=closed");
  expect(list.body.seasons[0].lays).toBeUndefined();
  expect(list.body.seasons[0].log.pcsCut).toBe(300);
});

test("the report over a date range: every season's lay in it, one row each, with the summary", async () => {
  const mk = async (name, day, extra = {}) => {
    const { body } = await call("POST", "/seasons", { name });
    await call("PUT", `/seasons/${body.season.id}/header`, { buyerName: extra.buyer || "Ripple", poNo: extra.mo || "MO-1", styleNo: "RC-2041", colour: "Navy", date: day });
    const { date, ...noDate } = LAY;
    void date;
    await call("POST", `/seasons/${body.season.id}/lays`, { ...noDate, ...extra.lay });
    return body.season.id;
  };
  await mk("R1", "2026-10-01");
  await mk("R2", "2026-10-03", { buyer: "Blue Mills", mo: "MO-2", lay: { plies: 40, bomCons: 1.2 } });
  await mk("R3", "2026-10-09");
  const empty = await call("POST", "/seasons", { name: "R4 no lay" });
  await call("PUT", `/seasons/${empty.body.season.id}/header`, { date: "2026-10-02" });

  const r = await call("GET", "/seasons/report-range?from=2026-10-01&to=2026-10-03");
  expect(r.status).toBe(200);
  expect(r.body.lays.map((l) => l.seasonName)).toEqual(["R1", "R2"]); // R3 is past the range; R4 has no lay
  expect(r.body.lays[1]).toMatchObject({ buyerName: "Blue Mills", poNo: "MO-2", plies: 40, pcsCut: 240 });
  expect(r.body.log).toMatchObject({ lays: 2, totalPlies: 100, pcsCut: 600 });
  expect(r.body.header).toMatchObject({ buyerName: "Ripple, Blue Mills", poNo: "MO-1, MO-2", styleNo: "RC-2041" });

  expect((await call("GET", "/seasons/report-range?from=2026-10-05&to=2026-10-01")).status).toBe(400);
  expect((await call("GET", "/seasons/report-range?from=bad&to=2026-10-01")).status).toBe(400);
});

test("no name is asked: a season is named from its report details and its lay (14 Oct 2026)", async () => {
  const created = await call("POST", "/seasons", {});
  expect(created.status).toBe(201);
  const id = created.body.season.id;
  expect(created.body.season.name).toMatch(/^\d{2} [A-Z][a-z]{2} · New season$/);
  const h = await call("PUT", `/seasons/${id}/header`, { buyerName: "Ripple", poNo: "MO-REQ-2026-0012", styleNo: "RC-2041", colour: "Navy", date: "2026-10-03" });
  expect(h.body.season.name).toBe("MO-REQ-2026-0012");
  const l = await call("POST", `/seasons/${id}/lays`, { ...LAY, layNo: "L-07" });
  expect(l.body.season.name).toBe("MO-REQ-2026-0012");
  /* a second nameless season is not refused as a duplicate */
  expect((await call("POST", "/seasons", {})).status).toBe(201);
  /* a season named by hand before keeps its name */
  const named = await call("POST", "/seasons", { name: "Old style name" });
  const named2 = await call("PUT", `/seasons/${named.body.season.id}/header`, { poNo: "MO-X" });
  expect(named2.body.season.name).toBe("Old style name");
});

test("an empty draft cannot be closed, but can be discarded", async () => {
  const { body } = await call("POST", "/seasons", { name: "Empty" });
  expect((await call("POST", `/seasons/${body.season.id}/close`, {})).status).toBe(409);
  expect((await call("POST", `/seasons/${body.season.id}/discard`, {})).status).toBe(200);
  expect(await CuttingSeason.countDocuments({ name: "Empty" })).toBe(0);
});

test("PO No suggests every order cut in this company, with its PO, buyer, MO and styles (14 Oct 2026)", async () => {
  const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
  const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
  const withPo = new mongoose.Types.ObjectId();
  const noPo = new mongoose.Types.ObjectId();
  const elsewhere = new mongoose.Types.ObjectId();
  await CustomerRequest.collection.insertMany([
    { _id: withPo, requestId: "REQ-0041", customerInfo: { name: "Ripple Retail" }, quotations: [{ quotationNumber: "Q-1", poProof: { poNumber: "PO-7781" } }], createdAt: new Date("2026-10-01") },
    { _id: noPo, requestId: "REQ-0042", customerInfo: { name: "Blue Mills" }, quotations: [], createdAt: new Date("2026-10-02") },
    { _id: elsewhere, requestId: "REQ-0099", customerInfo: { name: "Other company" }, quotations: [{ poProof: { poNumber: "PO-NOT-OURS" } }] },
  ]);
  const company = global.__cuttingCompanyId;
  await WorkOrder.collection.insertMany([
    { workOrderNumber: "WO-T-1", customerRequestId: withPo, stockItemName: "Polo", stockItemReference: "RC-2041", salesLineLink: { companyId: company } },
    { workOrderNumber: "WO-T-2", customerRequestId: withPo, stockItemName: "Polo", stockItemReference: "RC-2041", salesLineLink: { companyId: company } },
    { workOrderNumber: "WO-T-3", customerRequestId: noPo, stockItemName: "Trouser", salesLineLink: { companyId: company } },
    { workOrderNumber: "WO-T-4", customerRequestId: elsewhere, stockItemName: "Shirt", salesLineLink: { companyId: new mongoose.Types.ObjectId() } },
  ]);
  const r = await call("GET", "/seasons/po-options");
  expect(r.status).toBe(200);
  const byMo = Object.fromEntries(r.body.options.map((o) => [o.moNumber, o]));
  expect(byMo["MO-REQ-0041"]).toMatchObject({ poNo: "PO-7781", buyerName: "Ripple Retail", styles: ["RC-2041"] });
  expect(byMo["MO-REQ-0042"]).toMatchObject({ poNo: "", buyerName: "Blue Mills", styles: ["Trouser"] });
  expect(byMo["MO-REQ-0099"]).toBeUndefined(); // another company's order is never offered
  expect(r.body.withoutPo).toBe(1);
});
