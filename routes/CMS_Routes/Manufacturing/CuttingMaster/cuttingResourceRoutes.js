// routes/CMS_Routes/Manufacturing/CuttingMaster/cuttingResourceRoutes.js
//
// CUTTING'S OWN RESOURCES — ITS TABLES, ITS SHIFTS, ITS CREW.
//
// Mounted under /api/cms/manufacturing/cutting-master/resources, behind the
// same Cutting access rules as the rest of the floor: the Cutting department,
// the acting user's own company, reading with viewer and authoring with
// editor.
//
//   GET  /                     every version this company has
//   POST /                     save the draft (creates the first version)
//   POST /:resourceRef/publish put the draft in force
//   POST /:resourceRef/retire  withdraw the version in force, with a reason
//
// ── WHOSE SCREEN THIS IS ────────────────────────────────────────────────────
// Cutting's. A planning department has no route here at all — it reads the
// published projection through its own preview, and there is deliberately no
// endpoint on this router that a PPC session could reach even with a token,
// because the guard is Cutting's grant and nothing else.
//
// And nothing here states an engineering standard: how long a piece takes is
// Industrial Engineering's, frozen in its release. The service refuses such a
// field by name.
"use strict";

const express = require("express");

const { handle } = require("../../../../services/storePurchase/errors");
const resources = require("../../../../services/production/cuttingResource.service");
const cut = require("./cuttingAccess");

const router = express.Router();

const canRead = [cut.cuttingDepartment("viewer"), cut.cuttingCompany];
const canAuthor = [cut.cuttingDepartment("editor"), cut.cuttingCompany];

/* The authenticated session — never a body field. */
const actor = (req) => (req.user?.id ? { id: req.user.id, name: req.user.name || "" } : null);

router.get("/", ...canRead, handle(async (req, res) => {
  const out = await resources.listForCutting(req.cutting.companyId,
    { resourceRef: req.query?.resourceRef });
  return res.json({ success: true, ...out });
}));

router.post("/", ...canAuthor, handle(async (req, res) => {
  const out = await resources.saveDraft(req.cutting.companyId,
    { body: req.body || {}, actor: actor(req) });
  return res.status(201).json({ success: true, ...out });
}));

router.post("/:resourceRef/publish", ...canAuthor, handle(async (req, res) => {
  const out = await resources.publish(req.cutting.companyId, req.params.resourceRef,
    { actor: actor(req) });
  return res.json({ success: true, ...out });
}));

router.post("/:resourceRef/retire", ...canAuthor, handle(async (req, res) => {
  const out = await resources.retire(req.cutting.companyId, req.params.resourceRef,
    { reason: req.body?.reason, actor: actor(req) });
  return res.json({ success: true, ...out });
}));

module.exports = router;
