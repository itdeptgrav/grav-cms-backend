// routes/CMS_Routes/Sales/accounts.js
const express = require("express");
const router = express.Router();
const Account = require("../../../models/CMS_Models/Sales/Account");
const Contact = require("../../../models/CMS_Models/Sales/Contact");
const Lead = require("../../../models/CMS_Models/Sales/Lead");
const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");

// GET /api/cms/crm/accounts
router.get("/", salesAuth, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      search,
      type,
      status,
      industry,
      rating,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    const filter = { isActive: true };
    if (type && type !== "all") filter.type = type;
    if (status && status !== "all") filter.status = status;
    if (industry && industry !== "all") filter.industry = industry;
    if (rating && rating !== "all") filter.rating = rating;
    if (search) {
      const re = new RegExp(search, "i");
      filter.$or = [
        { companyName: re },
        { primaryEmail: re },
        { primaryPhone: re },
        { accountId: re },
        { city: re },
      ];
    }

    const sort = {};
    sort[sortBy] = sortOrder === "asc" ? 1 : -1;

    const total = await Account.countDocuments(filter);
    const accounts = await Account.find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate("primaryContact", "firstName lastName email phone")
      .lean();

    // Enrich each account with contact/lead counts
    const accountIds = accounts.map((a) => a._id);
    const [contactCounts, leadCounts] = await Promise.all([
      Contact.aggregate([
        { $match: { accountId: { $in: accountIds }, isActive: true } },
        { $group: { _id: "$accountId", count: { $sum: 1 } } },
      ]),
      Lead.aggregate([
        { $match: { accountId: { $in: accountIds }, isActive: true } },
        {
          $group: {
            _id: "$accountId",
            count: { $sum: 1 },
            value: { $sum: "$estimatedValue" },
          },
        },
      ]),
    ]);

    const contactMap = {};
    contactCounts.forEach((c) => {
      contactMap[c._id] = c.count;
    });
    const leadMap = {};
    leadCounts.forEach((l) => {
      leadMap[l._id] = { count: l.count, value: l.value };
    });

    const enriched = accounts.map((a) => ({
      ...a,
      contactCount: contactMap[a._id] || 0,
      leadCount: leadMap[a._id]?.count || 0,
      openLeadsValue: leadMap[a._id]?.value || 0,
    }));

    const stats = {
      total: await Account.countDocuments({ isActive: true }),
      prospect: await Account.countDocuments({
        isActive: true,
        type: "prospect",
      }),
      customer: await Account.countDocuments({
        isActive: true,
        type: "customer",
      }),
      partner: await Account.countDocuments({
        isActive: true,
        type: "partner",
      }),
      hot: await Account.countDocuments({ isActive: true, rating: "hot" }),
    };

    res.json({
      success: true,
      accounts: enriched,
      stats,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error("[accounts] GET /", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/accounts
router.post("/", salesAuth, async (req, res) => {
  try {
    const data = { ...req.body };
    if (req.user) {
      data.assignedTo = data.assignedTo || req.user.id;
      data.assignedToName = data.assignedToName || req.user.name;
    }
    const account = await Account.create(data);
    res.status(201).json({ success: true, account });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// GET /api/cms/crm/accounts/:id — detail with linked contacts + leads
router.get("/:id", salesAuth, async (req, res) => {
  try {
    const account = await Account.findById(req.params.id)
      .populate("primaryContact", "firstName lastName email phone designation")
      .populate("assignedTo", "name email")
      .lean();
    if (!account)
      return res
        .status(404)
        .json({ success: false, message: "Account not found" });

    const [contacts, leads] = await Promise.all([
      Contact.find({ accountId: req.params.id, isActive: true })
        .select("firstName lastName email phone designation type status")
        .lean(),
      Lead.find({ accountId: req.params.id, isActive: true })
        .select(
          "leadId firstName lastName stage estimatedValue priority expectedCloseDate",
        )
        .lean(),
    ]);

    res.json({ success: true, account, contacts, leads });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/cms/crm/accounts/:id
router.patch("/:id", salesAuth, async (req, res) => {
  try {
    const account = await Account.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!account)
      return res
        .status(404)
        .json({ success: false, message: "Account not found" });
    res.json({ success: true, account });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// DELETE /api/cms/crm/accounts/:id
router.delete("/:id", salesAuth, async (req, res) => {
  try {
    await Account.findByIdAndUpdate(req.params.id, { isActive: false });
    res.json({ success: true, message: "Account deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
