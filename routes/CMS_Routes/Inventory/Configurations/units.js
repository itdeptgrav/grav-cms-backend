// routes/cms/units.js  (or wherever your unit routes live)
// Make sure ALL routes that return unit data populate conversions.toUnit

const express = require("express");
const router = express.Router();
const Unit = require("../../../../models/CMS_Models/Inventory/Configurations/Unit");

/* ── Chunk 1: this router was mounted with NO AUTHENTICATION AT ALL ─────────
 * Chunk 0 found and pinned it: `/api/cms/units` answered every request,
 * signed in or not, including POST, PUT and DELETE. The unit master is what
 * every stock conversion in the system trusts — a wrong conversion factor
 * silently changes what a receipt puts on the shelf — so an anonymous writer
 * could corrupt inventory arithmetic across the whole company.
 *
 * Reads now require a signed-in Store/Purchase reader; writes require
 * master-maintenance authority. If some other application genuinely needs a
 * public unit vocabulary, it gets its own narrow read-only endpoint with a
 * stated contract — the administrative router does not stay open for it. */
const EmployeeAuth = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const {
  requireTenant, requireCapability, refuseLegacyWrite,
} = require("../../../../Middlewear/storePurchaseTenant");
const { CAPABILITIES } = require("../../../../services/storePurchase/capabilities");
const tenantContext = require("../../../../services/storePurchase/tenantContext.service");
const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");

router.use(EmployeeAuth);
router.use(requireTenant);

const canRead = requireCapability(CAPABILITIES.READ);

/* ── TWO DIFFERENT AUTHORITIES, AND WHY ─────────────────────────────────────
 * Creating a unit, renaming it or retiring it is master maintenance: it adds a
 * word to the vocabulary, and an item that does not use it is unaffected.
 * `sp.master.maintain` — the same authority that maintains item identity.
 *
 * Changing a CONVERSION FACTOR is not that. It retroactively redefines what
 * every quantity already stored in that unit means: say a roll is 40 metres
 * rather than 25 and every historical receipt, issue and balance expressed in
 * rolls silently revalues, across every document that ever referenced it.
 * Nothing is rewritten and everything changes. That is configuration, and it
 * takes `sp.config.manage`, which the grant table gives to owners only.
 *
 * The split is deliberate: a store editor should be able to add "metre"
 * without being able to redefine what a metre is worth. */
const canMaintain = [requireCapability(CAPABILITIES.MASTER_MAINTAIN), refuseLegacyWrite];
/* There is deliberately no `canConfigure` route guard. No endpoint here is
   purely configuration: each one serves both "retire this unit" and "a roll is
   now 40 metres", so the authority is decided per REQUEST, from the payload,
   by `conversionAuthority` below. A declared-but-unasserted guard read like a
   protection that was in force and was not. */

/**
 * Master maintenance is enough to touch a unit; redefining its arithmetic is
 * not. Applied per request rather than per route, because one endpoint serves
 * both "retire this unit" and "a roll is now 40 metres".
 */
const conversionAuthority = (req, res, next) => {
  if (req.body?.conversions === undefined) return next();
  return requireCapability(CAPABILITIES.CONFIG_MANAGE)(req, res, next);
};

/**
 * A name typed by a person is text.
 *
 * The duplicate check built `new RegExp("^" + name + "$")` from it, so a unit
 * called "m.s" matched "mXs" and refused a legitimate new unit as a duplicate
 * of one it merely pattern-matched. A name containing "(" was worse: an
 * unterminated group throws, and creating the unit answered 500.
 */
const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every unit query is company-scoped. A unit from another company is missing. */
const scoped = (req, extra = {}) => ({ ...tenantContext.tenantFilter(req.tenant), ...extra });

/**
 * Validate a whole conversion set, refusing rather than repairing.
 *
 * ── WHY NOTHING IS SILENTLY SKIPPED ─────────────────────────────────────────
 * This was `if (!conv.toUnit || !conv.quantity || parseFloat(...) <= 0) continue`.
 * `!conv.quantity` is true for 0, for "", for NaN and for a missing field, and
 * `continue` drops the row without a word — so an administrator who typed 0,
 * or whose form sent a blank, saved the unit, saw success, and kept a
 * conversion table with a row quietly missing. Every subsequent conversion
 * through that pair then fell back to whatever the caller's default was.
 *
 * A conversion factor is arithmetic that other people's stock depends on. It
 * is either stated correctly or the request is refused.
 *
 * @returns {{ok: true, conversions: []} | {ok: false, message: string, details: object}}
 */
async function validateConversions(req, rawConversions, selfId) {
  const rows = Array.isArray(rawConversions) ? rawConversions : [];
  const clean = [];
  const seen = new Map();

  for (let i = 0; i < rows.length; i += 1) {
    const conv = rows[i] || {};
    const where = { row: i + 1 };

    if (!conv.toUnit) {
      return { ok: false, message: `Conversion ${i + 1} names no target unit.`, details: where };
    }
    if (String(conv.toUnit) === String(selfId)) {
      return {
        ok: false,
        message: "A unit cannot convert to itself.",
        details: { ...where, reason: "SELF_CONVERSION" },
      };
    }

    /* Parsed from the raw value, not coerced: `Number("")` is 0 and
       `parseFloat("2 rolls")` is 2, and both would be stored as fact. */
    const text = String(conv.quantity ?? "").trim();
    if (!/^\d*\.?\d+$/.test(text)) {
      return {
        ok: false,
        message: `Conversion ${i + 1} needs a plain positive number, not "${conv.quantity}".`,
        details: { ...where, reason: "INVALID_FACTOR" },
      };
    }
    const quantity = Number(text);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return {
        ok: false,
        message: `Conversion ${i + 1} must be greater than zero.`,
        details: { ...where, reason: "INVALID_FACTOR", value: text },
      };
    }

    /* Two rows for one target are contradictory even when they agree — the
       next edit changes one of them and nothing says which wins. */
    if (seen.has(String(conv.toUnit))) {
      return {
        ok: false,
        message: `Conversion ${i + 1} repeats a target unit already converted to in row ${seen.get(String(conv.toUnit))}.`,
        details: { ...where, reason: "DUPLICATE_TARGET" },
      };
    }
    seen.set(String(conv.toUnit), i + 1);

    /* The target must exist INSIDE this company. A unit id from elsewhere is
       missing, not forbidden — the same answer an invented id gets. */
    const target = await Unit.findOne(scoped(req, { _id: conv.toUnit })).select("_id").lean();
    if (!target) {
      return {
        ok: false,
        message: `Target unit not found: ${conv.toUnit}`,
        details: { ...where, reason: "TARGET_NOT_FOUND" },
      };
    }

    clean.push({ toUnit: conv.toUnit, quantity });
  }

  return { ok: true, conversions: clean };
}

// ─── GET all units (list page) ───────────────────────────────────────────────
router.get("/", canRead, async (req, res) => {
  try {
    const units = await Unit.find(scoped(req))
      .populate("conversions.toUnit", "_id name") // ← MUST populate
      .sort({ createdAt: -1 });

    return res.json({ success: true, units });
  } catch (error) {
    console.error("Error fetching units:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── GET available units (for conversion dropdowns) ───────────────────────────
router.get("/available-units", canRead, async (req, res) => {
  try {
    const units = await Unit.find(scoped(req, { status: "Active" }))
      .select("_id name")
      .sort({ name: 1 });

    return res.json({ success: true, units });
  } catch (error) {
    console.error("Error fetching available units:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── GET single unit by ID ────────────────────────────────────────────────────
router.get("/:id", canRead, async (req, res) => {
  try {
    const unit = await Unit.findOne(scoped(req, { _id: req.params.id }))
      .populate("conversions.toUnit", "_id name"); // ← MUST populate

    if (!unit) {
      return res.status(404).json({ success: false, message: "Unit not found" });
    }

    return res.json({ success: true, unit });
  } catch (error) {
    console.error("Error fetching unit:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── CREATE unit ──────────────────────────────────────────────────────────────
router.post("/", ...canMaintain, conversionAuthority, async (req, res) => {
  try {
    const { name, conversions } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Unit name is required" });
    }

    // Check duplicate name
    const existing = await Unit.findOne(scoped(req, {
      name: new RegExp(`^${escapeRegex(String(name).trim())}$`, "i"),
    }));
    if (existing) {
      return res.status(400).json({ success: false, message: "A unit with this name already exists" });
    }

    const checked = await validateConversions(req, conversions, null);
    if (!checked.ok) {
      return res.status(400).json({
        success: false, message: checked.message, details: checked.details,
      });
    }

    const unit = new Unit({
      /* Ownership from the resolved context ONLY — never from the payload. */
      ...tenantContext.stamp(req.tenant),
      name: name.trim(),
      conversions: checked.conversions,
      createdBy: req.user?._id
    });

    await unit.save();

    // Return populated unit
    const populated = await Unit.findById(unit._id)
      .populate("conversions.toUnit", "_id name");

    return res.status(201).json({ success: true, unit: populated });
  } catch (error) {
    console.error("Error creating unit:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── UPDATE unit ──────────────────────────────────────────────────────────────
router.put("/:id", ...canMaintain, conversionAuthority, async (req, res) => {
  try {
    const { conversions, status } = req.body;

    const unit = await Unit.findOne(scoped(req, { _id: req.params.id }));
    if (!unit) {
      return res.status(404).json({ success: false, message: "Unit not found" });
    }

    /* ── AN OMITTED CONVERSION LIST IS NOT AN EMPTY ONE ───────────────────
     * This ran unconditionally, and `validateConversions` returns an EMPTY
     * array for an absent list — so `unit.conversions = checked.conversions`
     * erased the whole table on any request that did not resend it. Retiring a
     * unit (`{status: "Inactive"}`) therefore destroyed an owner's conversion
     * factors, and `conversionAuthority` waved it through because the field
     * the caller never sent could not be recognised as a change.
     *
     * Absent means untouched. The rows keep their own ids, so nothing
     * downstream sees a table that was rewritten. */
    if (conversions !== undefined) {
      const checked = await validateConversions(req, conversions, req.params.id);
      if (!checked.ok) {
        return res.status(400).json({
          success: false, message: checked.message, details: checked.details,
        });
      }
      /* Present means replace — including an explicit empty list, which is a
         deliberate clearing by somebody holding sp.config.manage. */
      unit.conversions = checked.conversions;
    }

    if (status && ["Active", "Inactive"].includes(status)) {
      unit.status = status;
    }

    unit.updatedBy = req.user?._id;

    await unit.save();

    // Return populated unit
    const populated = await Unit.findById(unit._id)
      .populate("conversions.toUnit", "_id name");

    return res.json({ success: true, unit: populated });
  } catch (error) {
    console.error("Error updating unit:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── DELETE unit ──────────────────────────────────────────────────────────────
router.delete("/:id", ...canMaintain, async (req, res) => {
  try {
    /* ── NOTHING IS DELETED OUT FROM UNDER A REFERENCE ─────────────────────
     * This used to `findByIdAndDelete` and then `$pull` the unit out of every
     * other unit's conversion table — globally, across companies, with no
     * check that anything still used it. An item measured in that unit was
     * left pointing at a name that no longer existed, and the conversions that
     * defined it were destroyed in the same breath, so the relationship could
     * not even be reconstructed afterwards.
     *
     * A unit in use is refused, and the refusal names what is holding it. */
    const unit = await Unit.findOne(scoped(req, { _id: req.params.id })).lean();
    if (!unit) {
      return res.status(404).json({ success: false, message: "Unit not found" });
    }

    const [itemsByName, itemsByCustom, referringUnits] = await Promise.all([
      RawItem.countDocuments({ ...tenantContext.tenantFilter(req.tenant), unit: unit.name }),
      RawItem.countDocuments({ ...tenantContext.tenantFilter(req.tenant), customUnit: unit.name }),
      Unit.find(scoped(req, { "conversions.toUnit": unit._id })).select("name").limit(20).lean(),
    ]);

    const blockedBy = [];
    if (itemsByName + itemsByCustom > 0) {
      blockedBy.push({
        kind: "items",
        count: itemsByName + itemsByCustom,
        detail: `${itemsByName + itemsByCustom} item(s) are measured in this unit.`,
      });
    }
    if (referringUnits.length) {
      blockedBy.push({
        kind: "conversions",
        count: referringUnits.length,
        names: referringUnits.map((u) => u.name),
        detail: `${referringUnits.length} other unit(s) convert to this one.`,
      });
    }

    if (blockedBy.length) {
      return res.status(409).json({
        success: false,
        code: "UNIT_IN_USE",
        message: "This unit is still in use, so it cannot be deleted.",
        blockedBy,
      });
    }

    await Unit.deleteOne(scoped(req, { _id: unit._id }));
    return res.json({ success: true, message: "Unit deleted successfully" });
  } catch (error) {
    console.error("Error deleting unit:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
