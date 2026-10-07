"use strict";
/**
 * Embroidery › Designs — the design catalogue.
 *
 * Mounted at /api/cms/manufacturing/embroidery/designs. The page and the
 * EmbroideryDesign model shipped together and no route ever served them, so
 * the Designs tab answered 404 (found by scripts/pageSweep.js, 6 Oct 2026)
 * over a collection that already holds designs.
 *
 * Reading needs an Embroidery viewer, writing an editor — the same gates as
 * the floor. "Delete" deactivates: a design an order already used must stay
 * readable, so nothing here removes a document.
 */

const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const EmbroideryDesign = require("../../../../models/CMS_Models/Manufacturing/Embroidery/EmbroideryDesign");
const emb = require("./embroideryAccess");

const canRead = [emb.embroideryDepartment("viewer"), emb.embroideryCompany];
const canWrite = [emb.embroideryDepartment("editor"), emb.embroideryCompany];

const FIELDS = ["designCode", "name", "description", "placement", "stitchCount", "estimatedMinutes", "machineType", "heads", "threadColors", "imageUrl", "isActive"];
function pick(body = {}) {
  const out = {};
  for (const k of FIELDS) if (body[k] !== undefined) out[k] = body[k];
  if (out.stitchCount !== undefined) out.stitchCount = Math.max(0, Number(out.stitchCount) || 0);
  if (out.estimatedMinutes !== undefined) out.estimatedMinutes = Math.max(0, Number(out.estimatedMinutes) || 0);
  if (out.heads !== undefined) out.heads = out.heads === null || out.heads === "" ? null : Number(out.heads) || null;
  if (out.threadColors !== undefined && !Array.isArray(out.threadColors)) delete out.threadColors;
  return out;
}
const withCategory = (d) => ({ ...d, category: d.placement || "Unplaced" });
const who = (req) => req.user?.name || req.user?.email || "";
const fail = (res, status, message) => res.status(status).json({ success: false, message });

router.get("/", ...canRead, async (req, res) => {
  const q = req.query.includeInactive === "1" ? {} : { isActive: { $ne: false } };
  const rows = (await EmbroideryDesign.find(q).sort({ designCode: 1 }).lean()).map(withCategory);
  const counts = new Map();
  for (const d of rows) counts.set(d.category, (counts.get(d.category) || 0) + 1);
  const categories = [...counts].map(([code, count]) => ({ code, count })).sort((a, b) => a.code.localeCompare(b.code));
  res.json({ success: true, designs: rows, categories });
});

/* A starter catalogue for a department that has none. Never adds to a
   catalogue that already has designs — those are somebody's real work. */
const STARTERS = [
  { designCode: "EMB-LOGO-LC", name: "Company logo — left chest", placement: "Left Chest", stitchCount: 6000, estimatedMinutes: 6, machineType: "Multi-head" },
  { designCode: "EMB-NAME-RC", name: "Name tape — right chest", placement: "Right Chest", stitchCount: 2500, estimatedMinutes: 3, machineType: "Single-head" },
  { designCode: "EMB-SLEEVE", name: "Sleeve badge", placement: "Sleeve", stitchCount: 4000, estimatedMinutes: 4, machineType: "Multi-head" },
];
router.post("/seed", ...canWrite, async (req, res) => {
  if (await EmbroideryDesign.exists({})) {
    return res.json({ success: true, seeded: 0, message: "The catalogue already has designs, so nothing was added." });
  }
  await EmbroideryDesign.insertMany(STARTERS.map((d) => ({ ...d, createdByName: who(req) })));
  res.json({ success: true, seeded: STARTERS.length });
});

router.post("/", ...canWrite, async (req, res) => {
  const fields = pick(req.body);
  if (!String(fields.designCode || "").trim() || !String(fields.name || "").trim()) return fail(res, 400, "Design code and name are required.");
  if (await EmbroideryDesign.exists({ designCode: String(fields.designCode).trim().toUpperCase() })) {
    return fail(res, 409, `A design with code ${String(fields.designCode).trim().toUpperCase()} already exists.`);
  }
  const doc = await EmbroideryDesign.create({ ...fields, createdByName: who(req) || req.body.createdByName || "" });
  res.status(201).json({ success: true, design: withCategory(doc.toObject()) });
});

router.put("/:id", ...canWrite, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 404, "Design not found.");
  const fields = pick(req.body);
  if (fields.designCode) {
    const code = String(fields.designCode).trim().toUpperCase();
    if (await EmbroideryDesign.exists({ designCode: code, _id: { $ne: req.params.id } })) return fail(res, 409, `A design with code ${code} already exists.`);
  }
  const doc = await EmbroideryDesign.findByIdAndUpdate(req.params.id, { $set: fields }, { new: true, runValidators: true }).lean();
  if (!doc) return fail(res, 404, "Design not found.");
  res.json({ success: true, design: withCategory(doc) });
});

router.delete("/:id", ...canWrite, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 404, "Design not found.");
  const doc = await EmbroideryDesign.findByIdAndUpdate(req.params.id, { $set: { isActive: false } }, { new: true }).lean();
  if (!doc) return fail(res, 404, "Design not found.");
  res.json({ success: true, design: withCategory(doc) });
});

module.exports = router;
