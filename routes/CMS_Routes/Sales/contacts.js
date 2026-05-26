// routes/CMS_Routes/Sales/contacts.js
const express = require("express");
const router = express.Router();
const Contact = require("../../../models/CMS_Models/Sales/Contact");
const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");

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

    const total = await Contact.countDocuments(filter);
    const contacts = await Contact.find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate("accountId", "companyName")
      .lean();

    const stats = {
      total: await Contact.countDocuments({ isActive: true }),
      lead: await Contact.countDocuments({ isActive: true, type: "lead" }),
      prospect: await Contact.countDocuments({
        isActive: true,
        type: "prospect",
      }),
      customer: await Contact.countDocuments({
        isActive: true,
        type: "customer",
      }),
      partner: await Contact.countDocuments({
        isActive: true,
        type: "partner",
      }),
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
    const data = { ...req.body };
    if (req.user) {
      data.assignedTo = data.assignedTo || req.user.id;
      data.assignedToName = data.assignedToName || req.user.name;
    }
    const contact = await Contact.create(data);
    res.status(201).json({ success: true, contact });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// GET /api/cms/crm/contacts/:id
router.get("/:id", salesAuth, async (req, res) => {
  try {
    const contact = await Contact.findById(req.params.id)
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
    const contact = await Contact.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!contact)
      return res
        .status(404)
        .json({ success: false, message: "Contact not found" });
    res.json({ success: true, contact });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// DELETE /api/cms/crm/contacts/:id — soft delete
router.delete("/:id", salesAuth, async (req, res) => {
  try {
    await Contact.findByIdAndUpdate(req.params.id, { isActive: false });
    res.json({ success: true, message: "Contact deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
