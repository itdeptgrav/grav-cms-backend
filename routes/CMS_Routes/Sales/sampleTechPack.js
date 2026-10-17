// routes/CMS_Routes/Sales/sampleTechPack.js — mounted at /api/cms/techpack
//
// THE PRINTED TECH PACK (15 Oct 2026). One style's pack, assembled at read
// time from the departments that own each value
// (services/techpack/techPack.service.js), and the few fields only the pack
// holds (season, sample size, per-material specs).
//
//   GET   /styles/:id      the pack
//   PATCH /styles/:id      the pack's own fields (Design / administrators)
//
// The flats it prints are read through /api/cms/studio-link/styles/:id/files/:fileId.
// Every style is looked up inside the actor's company (salesScope.scopeFor).

"use strict";

const express = require("express");
const salesAuthBase = require("../../../Middlewear/SalesAuthMiddlewear");
const { scopeFor } = require("../../../services/companyContext/salesScope.service");
const { loadStyle, customerNames } = require("../../../services/studio/sampleStudioQueries");
const techPack = require("../../../services/techpack/techPack.service");
const { Acc_Company } = require("../../../models/Accountant_model/Acc_MasterModels");

const router = express.Router();
const auth = salesAuthBase.withRoles(salesAuthBase.RND_ROLES);
const canEdit = (u) => salesAuthBase.RND_ROLES.includes(u?.role) || Boolean(u?.isAdmin);
const actor = (req) => ({ id: req.user?.id, name: req.user?.name || "" });

function sendError(res, e) {
  const status = e.status || (e.code === "UNAUTHENTICATED" ? 401 : 500);
  if (status >= 500) console.error("[techpack]", e);
  res.status(status).json({ success: false, message: status >= 500 ? "Something went wrong. Try again." : e.message });
}

async function packFor(style, companyId) {
  const plain = style.toObject ? style.toObject() : style;
  const nameOf = await customerNames([plain], companyId);
  const company = plain.sampleType === "house"
    ? await Acc_Company.findById(companyId).select("companyName").lean().catch(() => null)
    : null;
  return techPack.loadTechPack(plain, {
    companyId,
    customerName: plain.sampleType === "house" ? "" : nameOf(plain),
    companyName: company?.companyName || "",
  });
}

router.get("/styles/:id", auth, async (req, res) => {
  try {
    const { companyId } = await scopeFor(req, { domainLabel: "Tech pack" });
    const style = await loadStyle(req.params.id, companyId, { lean: true });
    res.json({ success: true, techPack: await packFor(style, companyId), canEdit: canEdit(req.user) });
  } catch (e) {
    sendError(res, e);
  }
});

router.patch("/styles/:id", auth, async (req, res) => {
  try {
    if (!canEdit(req.user)) return res.status(403).json({ success: false, message: "Only Design (R&D) edits the tech pack." });
    const { companyId } = await scopeFor(req, { domainLabel: "Tech pack" });
    const style = await loadStyle(req.params.id, companyId);
    const current = await packFor(style, companyId);
    techPack.applyEdit(style, req.body, { rowKeys: new Set(current.bom.map((r) => r.rowKey)) }, actor(req));
    await style.save();
    res.json({ success: true, techPack: await packFor(style, companyId), canEdit: true });
  } catch (e) {
    sendError(res, e);
  }
});

module.exports = router;
