// routes/CMS_Routes/Sales/costingRequests.js
//
// Costing requests — the Sales → Merchandising + Industrial Engineering costing
// hand-off that backs a Cowork costing sheet. See docs/enquiry-costing-sheet-plan.md.
//
// This route records the LINK and the STATUS. It does NOT create the Cowork
// sheet — grav-cms provisions that directly against Cowork's Firestore (P1,
// lib/costingSheet/*) and passes the resulting `coworkDocumentId` in on POST.
//
// Endpoints:
//   GET  /by-enquiry/:enquiryId   list an enquiry's costing requests (newest first)
//   GET  /defaults                the requester's remembered costing team (merch + IE)
//   POST /                        record a new costing request for an enquiry
//   PATCH /:id                    update status / result note / team / document link

"use strict";

const mongoose = require("mongoose");
const CostingRequest = require("../../../models/CMS_Models/Sales/CostingRequest");
const Enquiry = require("../../../models/CMS_Models/Sales/Enquiry");
const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");
const { COSTING_REQUEST_STATUS_CODES, COSTING_REQUEST_STATUS_TRANSITIONS, COSTING_REQUEST_PURPOSE_CODES } = require("../../../constants/crm");

const express = require("express");
const router = express.Router();

const actor = (req) => ({ id: req.user?.id, name: req.user?.name || "" });
const isObjectId = (v) => mongoose.Types.ObjectId.isValid(v);

// A cowork person {employeeId, name}, trimmed, or undefined if empty.
function person(input) {
  if (!input || typeof input !== "object") return undefined;
  const employeeId = String(input.employeeId || "").trim();
  if (!employeeId) return undefined;
  return { employeeId, name: String(input.name || "").trim() };
}

// Product-line snapshot, cleaned to {product, quantity}.
function sanitizeLines(input) {
  if (!Array.isArray(input)) return undefined;
  return input
    .filter((l) => l && String(l.product || "").trim())
    .map((l) => {
      const q = l.quantity === "" || l.quantity == null ? undefined : Number(l.quantity);
      return { product: String(l.product).trim(), quantity: Number.isFinite(q) && q >= 0 ? q : undefined };
    });
}

// GET /api/cms/crm/costing-requests/by-enquiry/:enquiryId
// Every costing request for an enquiry, newest first.
router.get("/by-enquiry/:enquiryId", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.enquiryId)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const requests = await CostingRequest.find({ enquiryId: req.params.enquiryId, isActive: true }).sort({ createdAt: -1 }).lean();
    return res.json({ success: true, requests });
  } catch (err) {
    console.error("[costing-requests] GET /by-enquiry", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/cms/crm/costing-requests/defaults
// The costing team this salesperson last used — "chosen once and remembered".
// The memory IS the most recent request; no separate preference store.
router.get("/defaults", salesAuth, async (req, res) => {
  try {
    const last = await CostingRequest.findOne({
      "requestedBy.id": req.user?.id,
      $or: [{ "merchandiser.employeeId": { $exists: true, $ne: "" } }, { "industrialEngineer.employeeId": { $exists: true, $ne: "" } }],
    })
      .sort({ createdAt: -1 })
      .select("merchandiser industrialEngineer")
      .lean();
    return res.json({
      success: true,
      merchandiser: last?.merchandiser?.employeeId ? last.merchandiser : null,
      industrialEngineer: last?.industrialEngineer?.employeeId ? last.industrialEngineer : null,
    });
  } catch (err) {
    console.error("[costing-requests] GET /defaults", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/costing-requests
// Record a costing request for an enquiry. `coworkDocumentId` is the sheet
// grav-cms already provisioned; journey/account are derived from the enquiry.
router.post("/", salesAuth, async (req, res) => {
  try {
    const body = req.body || {};
    if (!isObjectId(body.enquiryId)) return res.status(400).json({ success: false, message: "A valid enquiryId is required." });

    const enquiry = await Enquiry.findOne({ _id: body.enquiryId, isActive: true }).select("_id journeyId accountId products").lean();
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    const purpose = COSTING_REQUEST_PURPOSE_CODES.includes(body.purpose) ? body.purpose : "enquiry_indicative";
    const coworkDocumentId = String(body.coworkDocumentId || "").trim() || undefined;
    const merchandiser = person(body.merchandiser);
    const industrialEngineer = person(body.industrialEngineer);
    // Lines default to the enquiry's current products if the client didn't snapshot them.
    const lines = sanitizeLines(body.lines) || sanitizeLines(enquiry.products) || [];

    // A request with a sheet AND at least one person assigned is already being
    // worked; a bare record (no sheet yet) is merely "requested".
    const status = coworkDocumentId && (merchandiser || industrialEngineer) ? "in_progress" : "requested";

    const doc = await CostingRequest.create({
      enquiryId: enquiry._id,
      journeyId: enquiry.journeyId,
      accountId: enquiry.accountId,
      purpose,
      coworkDocumentId,
      merchandiser,
      industrialEngineer,
      status,
      lines,
      requestedBy: actor(req),
      createdBy: actor(req),
      updatedBy: actor(req),
    });

    return res.status(201).json({ success: true, request: doc.toObject() });
  } catch (err) {
    console.error("[costing-requests] POST /", err);
    return res.status(400).json({ success: false, message: err.message });
  }
});

// PATCH /api/cms/crm/costing-requests/:id
// Update status (transition-guarded), the result note, the team, or the sheet link.
router.patch("/:id", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid costing request reference." });
    const doc = await CostingRequest.findOne({ _id: req.params.id, isActive: true });
    if (!doc) return res.status(404).json({ success: false, message: "Costing request not found." });

    const body = req.body || {};

    // Status: only a legal transition (a no-op always passes).
    if (typeof body.status === "string" && COSTING_REQUEST_STATUS_CODES.includes(body.status) && body.status !== doc.status) {
      const allowed = COSTING_REQUEST_STATUS_TRANSITIONS[doc.status] || [];
      if (!allowed.includes(body.status)) {
        return res.status(400).json({ success: false, message: `Can't move a costing request from "${doc.status}" to "${body.status}".` });
      }
      doc.status = body.status;
    }

    if ("resultNote" in body) doc.resultNote = body.resultNote === "" ? undefined : String(body.resultNote).trim();
    if ("coworkDocumentId" in body) doc.coworkDocumentId = String(body.coworkDocumentId || "").trim() || undefined;
    if ("merchandiser" in body) doc.merchandiser = person(body.merchandiser);
    if ("industrialEngineer" in body) doc.industrialEngineer = person(body.industrialEngineer);
    if ("lines" in body) doc.lines = sanitizeLines(body.lines) || [];

    doc.updatedBy = actor(req);
    await doc.save();

    return res.json({ success: true, request: doc.toObject() });
  } catch (err) {
    console.error("[costing-requests] PATCH /:id", err);
    return res.status(400).json({ success: false, message: err.message });
  }
});

module.exports = router;
