// test/studio/techSheetStart.route.test.js
//
// Starting the tech sheet makes the style's GRAV Studio file (owner, 14 Oct
// 2026): R&D presses "Start tech sheet", the style is linked to a Studio file
// in the same save, and doing it again changes nothing. A style that is not
// with R&D starts its tech sheet without one.
"use strict";

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/SalesAuthMiddlewear", () => {
  const mw = (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ success: false, message: "Authentication required." });
    req.user = JSON.parse(raw);
    next();
  };
  mw.withRoles = () => mw;
  mw.RND_ROLES = [];
  return mw;
});
jest.mock("../../services/departmentNotify.service", () => ({ notifyEvent: async () => {}, APP_URL: "https://cms.test" }));
// One company, as membership would resolve it (the reply is company-scoped).
jest.mock("../../services/companyContext/salesScope.service", () => ({
  scopeFor: async () => ({ companyId: "66f000000000000000000001", allowUnowned: true, clause: {} }),
  scopedFilter: async (req, selector) => selector,
}));

const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");

const DESIGNER = { id: new mongoose.Types.ObjectId().toString(), name: "Dev Designer", role: "research-development" };
let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/crm/sample-styles", require("../../routes/CMS_Routes/Sales/sampleStyles"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/crm/sample-styles`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

const start = async (id) => {
  const res = await fetch(`${base}/${id}/tech-sheet`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-test-user": JSON.stringify(DESIGNER) },
    body: JSON.stringify({ action: "start" }),
  });
  return { status: res.status, body: await res.json() };
};

const style = (over = {}) => SampleStyle.create({
  sampleStyleId: `SS-${Math.random().toString(36).slice(2, 8)}`,
  styleCode: "SHT-01",
  productName: "Mandarin collar shirt",
  sampleType: "house",
  stage: "rnd",
  status: "active",
  ...over,
});

test("starting the tech sheet links the style's GRAV Studio file, once", async () => {
  const s = await style();
  const r = await start(s.sampleStyleId);
  expect(r.status).toBe(200);
  expect(r.body.sampleStyle.techSheet.status).toBe("in_progress");
  const stored = await SampleStyle.findById(s._id).lean();
  expect(stored.studio).toMatchObject({ status: "linked", linkedBy: { name: "Dev Designer" } });
  expect(stored.studio.fileId).toMatch(/^[0-9a-f-]{36}$/);
  expect(stored.history.map((h) => h.kind)).toContain("studio_linked");
});

test("a style already linked keeps its file", async () => {
  const s = await style({ studio: { status: "in_progress", fileId: "kept-file-id", linkedAt: new Date() } });
  await start(s.sampleStyleId);
  const stored = await SampleStyle.findById(s._id).lean();
  expect(stored.studio).toMatchObject({ status: "in_progress", fileId: "kept-file-id" });
});
