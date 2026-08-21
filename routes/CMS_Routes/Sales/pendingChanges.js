// routes/CMS_Routes/Sales/pendingChanges.js
//
// The Sales-wide inbox for what Enquiry/RFQ's costing sheet and Style &
// Sample's materials picker each already know about per-product: everything
// a Merchandiser or Project Manager/IE submitted that's still waiting on a
// decision. Both stage panels surface a scoped copy of this already, right
// where the edit happened — but a Sales person's real question is often "what
// needs my decision RIGHT NOW, across every journey", not "let me open each
// product one at a time to find out" (19 Aug 2026, explicit request: showcase
// this globally on the Sales dashboard, not only inside the panel it came from).
//
// Read-only aggregation. Deciding still goes through the existing per-domain
// routes (enquiries.js's costing-sheet decide, sampleStyles.js's materials
// decide) — this file only collects what they'd otherwise leave scattered
// across every active enquiry and sample style in the database.

"use strict";

const express = require("express");
const router = express.Router();

const Enquiry = require("../../../models/CMS_Models/Sales/Enquiry");
const SampleStyle = require("../../../models/CMS_Models/Sales/SampleStyle");
const SalesJourney = require("../../../models/CMS_Models/Sales/SalesJourney");
const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");
const { bypassesApproval } = require("../../../services/salesAccess");

// GET /api/cms/crm/pending-changes — every costing and materials submission
// still awaiting a decision, across every active enquiry and sample style.
// Sales/CEO/admin only: these are exactly the people the decide routes below
// let act on any of them, so this list is scoped to the same audience.
router.get("/", salesAuth, async (req, res) => {
  try {
    if (!bypassesApproval(req.user)) {
      return res.status(403).json({ success: false, message: "Only Sales, an admin or the CEO can see the approvals queue." });
    }

    const [enquiries, styles] = await Promise.all([
      Enquiry.find({ isActive: true, "costingChangeLog.status": "pending" })
        .select("journeyId costingChangeLog").lean(),
      SampleStyle.find({ isActive: true, "materialsChangeLog.status": "pending" })
        .select("journeyId productName sampleStyleId materialsChangeLog").lean(),
    ]);

    const journeyIds = [...new Set([
      ...enquiries.map((e) => String(e.journeyId)),
      ...styles.map((s) => String(s.journeyId)),
    ])];
    const journeys = await SalesJourney.find({ _id: { $in: journeyIds } }).select("journeyId name").lean();
    const journeyById = new Map(journeys.map((j) => [String(j._id), j]));

    const items = [];
    for (const e of enquiries) {
      const j = journeyById.get(String(e.journeyId));
      for (const c of e.costingChangeLog || []) {
        if (c.status !== "pending") continue;
        items.push({
          kind: "costing",
          id: String(c._id),
          enquiryId: String(e._id),
          journeyId: String(e.journeyId),
          journeyRef: j?.journeyId || null,
          journeyName: j?.name || null,
          productName: c.productName,
          part: c.part || "combined",
          materials: c.materials?.length ? c.materials : undefined,
          operations: c.operations?.length ? c.operations : undefined,
          miscellaneous: c.miscellaneous?.length ? c.miscellaneous : undefined,
          submittedBy: c.submittedBy || null,
          submittedAt: c.submittedAt || null,
        });
      }
    }
    for (const s of styles) {
      const j = journeyById.get(String(s.journeyId));
      for (const c of s.materialsChangeLog || []) {
        if (c.status !== "pending") continue;
        items.push({
          kind: "materials",
          id: String(c._id),
          sampleStyleId: s.sampleStyleId || String(s._id),
          journeyId: String(s.journeyId),
          journeyRef: j?.journeyId || null,
          journeyName: j?.name || null,
          productName: s.productName,
          items: c.items || [],
          submittedBy: c.submittedBy || null,
          submittedAt: c.submittedAt || null,
        });
      }
    }
    items.sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0));

    return res.json({ success: true, count: items.length, items });
  } catch (err) {
    console.error("[pendingChanges] GET /", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
