// routes/CMS_Routes/Sales/leads.js
const express = require("express");
const router = express.Router();
const Lead = require("../../../models/CMS_Models/Sales/Lead");
const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");

// GET /api/cms/crm/leads — list with filters + pipeline stats
router.get("/", salesAuth, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      search,
      stage,
      priority,
      source,
      assignedTo,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    const filter = { isActive: true };
    if (stage && stage !== "all") filter.stage = stage;
    if (priority && priority !== "all") filter.priority = priority;
    if (source && source !== "all") filter.source = source;
    if (assignedTo) filter.assignedTo = assignedTo;
    if (search) {
      const re = new RegExp(search, "i");
      filter.$or = [
        { firstName: re },
        { lastName: re },
        { email: re },
        { phone: re },
        { company: re },
        { leadId: re },
      ];
    }

    const sort = {};
    sort[sortBy] = sortOrder === "asc" ? 1 : -1;

    const total = await Lead.countDocuments(filter);
    const leads = await Lead.find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .select("-activities")
      .lean();

    // Pipeline stats
    const allLeads = await Lead.find({ isActive: true })
      .select("stage estimatedValue probability")
      .lean();

    const pipelineStats = {
      new: 0,
      contacted: 0,
      qualified: 0,
      proposal_sent: 0,
      negotiation: 0,
      won: 0,
      lost: 0,
      totalPipelineValue: 0,
      weightedValue: 0,
    };
    allLeads.forEach((l) => {
      pipelineStats[l.stage] = (pipelineStats[l.stage] || 0) + 1;
      if (!["won", "lost"].includes(l.stage)) {
        pipelineStats.totalPipelineValue += l.estimatedValue || 0;
        pipelineStats.weightedValue +=
          ((l.estimatedValue || 0) * (l.probability || 0)) / 100;
      }
    });
    pipelineStats.total = allLeads.length;
    pipelineStats.conversionRate =
      pipelineStats.total > 0
        ? Math.round((pipelineStats.won / pipelineStats.total) * 100)
        : 0;

    res.json({
      success: true,
      leads,
      pipelineStats,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error("[leads] GET /", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/leads — create
router.post("/", salesAuth, async (req, res) => {
  try {
    const data = { ...req.body };
    if (req.user) {
      data.assignedTo = data.assignedTo || req.user.id;
      data.assignedToName = data.assignedToName || req.user.name;
    }
    const lead = await Lead.create(data);
    res.status(201).json({ success: true, lead });
  } catch (err) {
    console.error("[leads] POST /", err);
    res.status(400).json({ success: false, message: err.message });
  }
});

// GET /api/cms/crm/leads/:id
router.get("/:id", salesAuth, async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id)
      .populate("assignedTo", "name email")
      .lean();
    if (!lead)
      return res
        .status(404)
        .json({ success: false, message: "Lead not found" });
    res.json({ success: true, lead });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/cms/crm/leads/:id
router.patch("/:id", salesAuth, async (req, res) => {
  try {
    const lead = await Lead.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!lead)
      return res
        .status(404)
        .json({ success: false, message: "Lead not found" });
    res.json({ success: true, lead });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// PATCH /api/cms/crm/leads/:id/stage — move stage + log activity
router.patch("/:id/stage", salesAuth, async (req, res) => {
  try {
    const { stage, lostReason } = req.body;
    const lead = await Lead.findById(req.params.id);
    if (!lead)
      return res
        .status(404)
        .json({ success: false, message: "Lead not found" });

    const prevStage = lead.stage;
    lead.stage = stage;
    if (stage === "lost") lead.lostReason = lostReason;
    if (stage === "won") {
      lead.probability = 100;
      lead.convertedToCustomer = true;
      lead.convertedAt = new Date();
    }
    lead.activities.push({
      type: "status_change",
      title: `Stage changed: ${prevStage} → ${stage}`,
      performedBy: req.user?.id,
      performedByName: req.user?.name || "Sales",
      completedAt: new Date(),
    });
    await lead.save();
    res.json({ success: true, lead });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/leads/:id/activity
router.post("/:id/activity", salesAuth, async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead)
      return res
        .status(404)
        .json({ success: false, message: "Lead not found" });
    lead.activities.push({
      ...req.body,
      performedBy: req.user?.id,
      performedByName: req.user?.name || "Sales",
      completedAt: new Date(),
    });
    lead.lastContactedAt = new Date();
    await lead.save();
    res.json({ success: true, lead });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// DELETE /api/cms/crm/leads/:id — soft delete
router.delete("/:id", salesAuth, async (req, res) => {
  try {
    await Lead.findByIdAndUpdate(req.params.id, { isActive: false });
    res.json({ success: true, message: "Lead deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
