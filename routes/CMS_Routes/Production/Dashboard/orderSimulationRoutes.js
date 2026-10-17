// routes/CMS_Routes/Production/Dashboard/orderSimulationRoutes.js
//
// The Order simulation's history (3 Oct 2026), mounted at
// /api/cms/production/order-simulations:
//
//   GET    /        the runs, newest first — no report, no inputs (light)
//   GET    /:id     one run with its inputs and its whole report
//   POST   /        keep a finished run (the page saves every run it finishes)
//   PATCH  /:id     rename it / add a note — whoever ran it, or an admin
//   DELETE /:id     take it out of the history (soft) — the same people
//
// A saved simulation is a record of a what-if, not a change to production, so
// it is authentication only: no department approval queue in front of it.

const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const OrderSimulationRun = require("../../../../models/CMS_Models/Manufacturing/Production/OrderSimulationRun");
const { packReport, unpackReport, runFromBody, canChange, editsFromBody } = require("../../../../services/production/orderSimulationRuns");

router.use(EmployeeAuthMiddleware);

const ORG = "default";
const LIST_LIMIT = 200;
const live = { organizationId: ORG, deletedAt: null };
const isId = (id) => /^[0-9a-f]{24}$/i.test(String(id || ""));

router.get("/", async (req, res) => {
  try {
    const filter = { ...live };
    if (req.query.product) filter["product.id"] = String(req.query.product);
    const runs = await OrderSimulationRun.find(filter).select("-inputs").sort({ createdAt: -1 }).limit(LIST_LIMIT).lean();
    res.json({ success: true, runs });
  } catch (error) {
    console.error("[order-simulations] list", error);
    res.status(500).json({ success: false, message: "Could not read the simulation history." });
  }
});

router.get("/:id", async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ success: false, message: "No such saved simulation." });
    const run = await OrderSimulationRun.findOne({ _id: req.params.id, ...live }).select("+report").lean();
    if (!run) return res.status(404).json({ success: false, message: "No such saved simulation — it may have been deleted." });
    const { report, ...rest } = run;
    res.json({ success: true, run: rest, report: unpackReport(report) });
  } catch (error) {
    console.error("[order-simulations] read", error);
    res.status(500).json({ success: false, message: "Could not read that simulation." });
  }
});

router.post("/", async (req, res) => {
  try {
    const parsed = runFromBody(req.body);
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
    const { buffer, bytes } = packReport(parsed.report);
    const doc = await OrderSimulationRun.create({
      ...parsed.run,
      organizationId: ORG,
      report: buffer,
      reportBytes: bytes,
      createdBy: { id: String(req.user?.id || ""), name: req.user?.name || "", email: req.user?.email || "" },
    });
    const { report, ...saved } = doc.toObject();
    res.status(201).json({ success: true, run: saved });
  } catch (error) {
    console.error("[order-simulations] save", error);
    // Atlas refuses a NEW collection once the cluster holds its plan's 500
    if (/already using \d+ collections/i.test(error?.message || "")) {
      return res.status(507).json({ success: false, code: "COLLECTION_LIMIT", message: "The database has no room for the simulation history: the cluster already holds the 500 collections its Atlas plan allows. Free a collection or move to a bigger plan, and runs will be kept." });
    }
    res.status(500).json({ success: false, message: "Could not save the simulation." });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ success: false, message: "No such saved simulation." });
    const run = await OrderSimulationRun.findOne({ _id: req.params.id, ...live });
    if (!run) return res.status(404).json({ success: false, message: "No such saved simulation." });
    if (!canChange(run, req.user)) return res.status(403).json({ success: false, message: `Only ${run.createdBy?.name || "whoever ran it"} or an administrator can rename this simulation.` });
    Object.assign(run, editsFromBody(req.body));
    await run.save();
    const { report, inputs, ...saved } = run.toObject();
    res.json({ success: true, run: saved });
  } catch (error) {
    console.error("[order-simulations] edit", error);
    res.status(500).json({ success: false, message: "Could not change that simulation." });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ success: false, message: "No such saved simulation." });
    const run = await OrderSimulationRun.findOne({ _id: req.params.id, ...live });
    if (!run) return res.status(404).json({ success: false, message: "No such saved simulation." });
    if (!canChange(run, req.user)) return res.status(403).json({ success: false, message: `Only ${run.createdBy?.name || "whoever ran it"} or an administrator can delete this simulation.` });
    run.deletedAt = new Date();
    run.deletedBy = String(req.user?.id || "");
    await run.save();
    res.json({ success: true });
  } catch (error) {
    console.error("[order-simulations] delete", error);
    res.status(500).json({ success: false, message: "Could not delete that simulation." });
  }
});

module.exports = router;
