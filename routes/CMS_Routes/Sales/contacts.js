// routes/CMS_Routes/Sales/contacts.js
//
// Step 01 extension: createdBy/updatedBy/archivedBy stamping and ChangeLog
// audit entries on every write — the Contact model already declares these
// fields (see models/CMS_Models/Sales/Contact.js), the original route just
// never populated them. Section 16 of the spec requires contact changes to be
// auditable; this closes that gap without altering the existing list/get
// behaviour or response shape.
const express = require("express");
const {
  scopedFilter: scoped, scopeFor: salesScopeFor, scopeAndOwnership,
} = require("../../../services/companyContext/salesScope.service");
const { stripCompanyOwnershipInput } = require("../../../models/CMS_Models/Sales/companyOwnership");
const router = express.Router();
const Contact = require("../../../models/CMS_Models/Sales/Contact");
const Account = require("../../../models/CMS_Models/Sales/Account");
const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");
const { recordChange } = require("../../../services/changeLog");

const actor = (req) => ({ id: req.user?.id, name: req.user?.name || "" });

/* ── A CONTACT'S ACCOUNT IS CHECKED, NOT POPULATED ──────────────────────────
 * A Contact carries its own `companyId`, so a scoped read of the contact says
 * nothing about whose account it points at: a body naming another company's
 * account produced a contact that was mine by ownership and theirs by
 * relationship, and the first place anyone found out was `.populate()` on the
 * detail page — which had already read the foreign account to render its name.
 *
 * So the account is resolved through the request's own company clause, before
 * the write, and a foreign one is refused exactly as a missing one is. The
 * link stays optional: a contact with no account is still valid, and clearing
 * it is still allowed.
 */
async function assertAccountInScope(accountId, scope) {
  if (!accountId) return; // no link, or the link being cleared — both fine
  const account = await Account.findOne({ $and: [scope.clause, { _id: accountId }] })
    .select("_id").lean();
  if (!account) {
    const err = new Error("That account was not found.");
    err.status = 404;
    throw err;
  }
}

// GET /api/cms/crm/contacts
router.get("/", salesAuth, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      search,
      type,
      status,
      assignedTo,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    const filter = { isActive: true };
    if (type && type !== "all") filter.type = type;
    if (status && status !== "all") filter.status = status;
    if (assignedTo) filter.assignedTo = assignedTo;
    if (search) {
      const re = new RegExp(search, "i");
      filter.$or = [
        { firstName: re },
        { lastName: re },
        { email: re },
        { phone: re },
        { company: re },
        { contactId: re },
      ];
    }

    const sort = {};
    sort[sortBy] = sortOrder === "asc" ? 1 : -1;

    const scopedList = await scoped(req, filter);
    const total = await Contact.countDocuments(scopedList);
    const contacts = await Contact.find(scopedList)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate("accountId", "companyName")
      .lean();

    const stats = {
      total: await Contact.countDocuments(await scoped(req, { isActive: true })),
      lead: await Contact.countDocuments(await scoped(req, { isActive: true, type: "lead" })),
      prospect: await Contact.countDocuments(await scoped(req, {
        isActive: true,
        type: "prospect",
      })),
      customer: await Contact.countDocuments(await scoped(req, {
        isActive: true,
        type: "customer",
      })),
      partner: await Contact.countDocuments(await scoped(req, {
        isActive: true,
        type: "partner",
      })),
    };

    res.json({
      success: true,
      contacts,
      stats,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error("[contacts] GET /", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/contacts
router.post("/", salesAuth, async (req, res) => {
  try {
    /* One company decision: the account check and the ownership stamp are the
       same company, resolved once. */
    const { scope, ownership } = await scopeAndOwnership(req);
    const data = stripCompanyOwnershipInput({ ...req.body });
    if (req.user) {
      data.assignedTo = data.assignedTo || req.user.id;
      data.assignedToName = data.assignedToName || req.user.name;
      data.createdBy = actor(req);
      data.updatedBy = actor(req);
    }
    await assertAccountInScope(data.accountId, scope);
    /* Ownership from the actor's own membership — proven, or nothing is
       created. Never from `data`, which is the request. */
    const contact = await Contact.create({ ...data, ...ownership });
    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-contact",
      entityId: contact._id,
      entityLabel: `${contact.firstName || ""} ${contact.lastName || ""}`.trim(),
      action: "create",
      summary: `Added contact ${contact.contactId}`,
      after: contact.toObject(),
    });
    res.status(201).json({ success: true, contact });
  } catch (err) {
    res.status(err.status || 400).json({ success: false, message: err.message });
  }
});

// GET /api/cms/crm/contacts/:id
router.get("/:id", salesAuth, async (req, res) => {
  try {
    const contact = await Contact.findOne(await scoped(req, { _id: req.params.id }))
      .populate("accountId", "companyName city")
      .populate("assignedTo", "name email")
      .lean();
    if (!contact)
      return res
        .status(404)
        .json({ success: false, message: "Contact not found" });
    res.json({ success: true, contact });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/cms/crm/contacts/:id
router.patch("/:id", salesAuth, async (req, res) => {
  try {
    const scope = await salesScopeFor(req);
    const before = await Contact.findOne({ $and: [scope.clause, { _id: req.params.id }] }).lean();
    if (!before) return res.status(404).json({ success: false, message: "Contact not found" });

    /* A move to another company's account is refused BEFORE the update runs,
       so a rejected relationship leaves every other field untouched too. */
    if (Object.prototype.hasOwnProperty.call(req.body, "accountId")) {
      await assertAccountInScope(req.body.accountId, scope);
    }
    const update = stripCompanyOwnershipInput({ ...req.body });
    const contact = await Contact.findOneAndUpdate({ $and: [scope.clause, { _id: req.params.id }] }, { ...update, updatedBy: actor(req) },
      { new: true, runValidators: true },);
    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-contact",
      entityId: contact._id,
      entityLabel: `${contact.firstName || ""} ${contact.lastName || ""}`.trim(),
      action: "update",
      before,
      after: contact.toObject(),
    });
    res.json({ success: true, contact });
  } catch (err) {
    res.status(err.status || 400).json({ success: false, message: err.message });
  }
});

// DELETE /api/cms/crm/contacts/:id — soft archive (kept in history, never
// hard-deleted, per the spec's "no normal UI operation permanently deletes
// customer history").
router.delete("/:id", salesAuth, async (req, res) => {
  try {
    const contact = await Contact.findOneAndUpdate(await scoped(req, { _id: req.params.id }), { isActive: false, status: "archived", archivedAt: new Date(), archivedBy: actor(req) },
      { new: true },);
    if (!contact) return res.status(404).json({ success: false, message: "Contact not found" });
    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-contact",
      entityId: contact._id,
      entityLabel: `${contact.firstName || ""} ${contact.lastName || ""}`.trim(),
      action: "archive",
      summary: `Archived contact ${contact.contactId}`,
    });
    res.json({ success: true, message: "Contact archived" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
