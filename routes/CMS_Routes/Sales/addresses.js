// routes/CMS_Routes/Sales/addresses.js  →  /api/cms/crm/addresses
//
// Multiple typed addresses per account (registered/office/billing/shipping/…),
// with one primary per (account, type). Billing is never assumed to equal
// shipping — they are separate records.
const express = require("express");
const router = express.Router();
const Address = require("../../../models/CMS_Models/Sales/Address");
const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");
const { recordChange } = require("../../../services/changeLog");
const { makeSolePrimary, ensureGroupHasPrimary } = require("../../../services/crmPrimary");

const actor = (req) => ({ id: req.user?.id, name: req.user?.name || "" });

// GET /api/cms/crm/addresses?accountId=&addressType=
router.get("/", salesAuth, async (req, res) => {
  try {
    const { accountId, addressType, includeArchived } = req.query;
    const filter = {};
    if (accountId) filter.accountId = accountId;
    if (addressType && addressType !== "all") filter.addressType = addressType;
    if (includeArchived !== "true") filter.isActive = true;
    const addresses = await Address.find(filter).sort({ addressType: 1, isPrimaryForType: -1 }).lean();
    res.json({ success: true, addresses });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/addresses
router.post("/", salesAuth, async (req, res) => {
  try {
    if (!req.body.accountId) return res.status(400).json({ success: false, message: "accountId is required." });
    const address = await Address.create({ ...req.body, createdBy: actor(req), updatedBy: actor(req) });
    const group = { accountId: address.accountId, addressType: address.addressType, isActive: true };
    if (address.isPrimaryForType) {
      await makeSolePrimary(Address, group, address._id, "isPrimaryForType");
    } else {
      await ensureGroupHasPrimary(Address, group, address._id, "isPrimaryForType");
    }
    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-address",
      entityId: address._id,
      entityLabel: `${address.addressType} address`,
      action: "create",
      summary: `Added ${address.addressType} address`,
      after: address.toObject(),
    });
    res.status(201).json({ success: true, address });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// PATCH /api/cms/crm/addresses/:id
router.patch("/:id", salesAuth, async (req, res) => {
  try {
    const before = await Address.findById(req.params.id).lean();
    if (!before) return res.status(404).json({ success: false, message: "Address not found" });
    const address = await Address.findByIdAndUpdate(
      req.params.id,
      { ...req.body, updatedBy: actor(req) },
      { new: true, runValidators: true },
    );
    if (req.body.isPrimaryForType === true) {
      await makeSolePrimary(
        Address,
        { accountId: address.accountId, addressType: address.addressType, isActive: true },
        address._id,
        "isPrimaryForType",
      );
    }
    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-address",
      entityId: address._id,
      entityLabel: `${address.addressType} address`,
      action: "update",
      before,
      after: address.toObject(),
    });
    res.json({ success: true, address });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// DELETE /api/cms/crm/addresses/:id — soft archive
router.delete("/:id", salesAuth, async (req, res) => {
  try {
    const address = await Address.findByIdAndUpdate(
      req.params.id,
      { isActive: false, archivedAt: new Date(), archivedBy: actor(req) },
      { new: true },
    );
    if (!address) return res.status(404).json({ success: false, message: "Address not found" });
    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-address",
      entityId: address._id,
      entityLabel: `${address.addressType} address`,
      action: "archive",
      summary: `Archived ${address.addressType} address`,
    });
    res.json({ success: true, message: "Address archived" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
