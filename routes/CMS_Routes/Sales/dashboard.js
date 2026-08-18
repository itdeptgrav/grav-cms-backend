// routes/CMS_Routes/Sales/dashboard.js

const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const CustomerRequest = require("../../../models/Customer_Models/CustomerRequest");
const Customer = require("../../../models/Customer_Models/Customer");

// Apply auth middleware
router.use(EmployeeAuthMiddleware);

// GET dashboard statistics
router.get("/dashboard", async (req, res) => {
  try {
    // Get current date for calculations
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

    // Get total requests
    const totalRequests = await CustomerRequest.countDocuments();

    // ── Requests by status, ALL of them ──────────────────────────────────
    //
    // This used to be three countDocuments() calls — pending, in_progress,
    // completed — while the model's status enum has thirteen values. The
    // dashboard therefore showed nine pending out of twenty total requests
    // and nothing at any other stage, which read as "nothing has progressed"
    // when the truth was "this endpoint does not count those stages". One
    // $group covers every status, so a stage can never silently vanish
    // again, and a status added to the enum later needs no change here.
    const statusGroups = await CustomerRequest.aggregate([
      { $group: { _id: "$status", n: { $sum: 1 } } },
    ]);
    const byStatus = statusGroups.reduce((acc, row) => {
      acc[row._id || "unknown"] = row.n;
      return acc;
    }, {});
    const countOf = (...statuses) =>
      statuses.reduce((sum, s) => sum + (byStatus[s] || 0), 0);

    const pendingRequests   = countOf("pending", "pending_edit_approval");
    const inProgressRequests = countOf("in_progress");
    const completedRequests = countOf("completed", "delivered");

    // Get total customers
    const totalCustomers = await Customer.countDocuments();

    // Calculate revenue for this month
    const requestsThisMonth = await CustomerRequest.find({
      status: 'completed',
      updatedAt: { $gte: startOfMonth }
    });

    const revenueThisMonth = requestsThisMonth.reduce((sum, request) => {
      return sum + (request.quotationAmount || request.items.reduce((itemSum, item) => 
        itemSum + (item.totalEstimatedPrice || 0), 0));
    }, 0);

    // Calculate revenue for last month
    const requestsLastMonth = await CustomerRequest.find({
      status: 'completed',
      updatedAt: { $gte: startOfLastMonth, $lte: endOfLastMonth }
    });

    const revenueLastMonth = requestsLastMonth.reduce((sum, request) => {
      return sum + (request.quotationAmount || request.items.reduce((itemSum, item) => 
        itemSum + (item.totalEstimatedPrice || 0), 0));
    }, 0);

    // Calculate revenue growth
    const revenueGrowth = revenueLastMonth > 0 
      ? Math.round(((revenueThisMonth - revenueLastMonth) / revenueLastMonth) * 100)
      : revenueThisMonth > 0 ? 100 : 0;

    // Calculate average order value
    const completedRequestsCount = await CustomerRequest.countDocuments({ status: 'completed' });
    const averageOrderValue = completedRequestsCount > 0 
      ? revenueThisMonth / completedRequestsCount 
      : 0;

    // ── Six months of billing, for the dashboard's revenue trend ─────────
    //
    // The frontend has read `monthlyRevenue` off this response for a long
    // time and this route never sent it, so the Monthly Revenue panel showed
    // its "appears once orders are approved" empty state permanently. Same
    // definition of value and same date field as revenueThisMonth above, so
    // the trend's last point and the headline figure always agree.
    // ── Bucket width follows how much history there actually is ──────────
    //
    // Six fixed monthly buckets on a two-month-old dataset gives three real
    // points and three months of flat zero before them — a trend line that is
    // half padding. Weekly buckets over the same records fill the axis with
    // real observations instead. Once there is more than a couple of months of
    // history, weeks become too many to label and months are the right unit
    // again, so the width is chosen from the span rather than fixed.
    const firstDoc = await CustomerRequest.find({}, { createdAt: 1 })
      .sort({ createdAt: 1 }).limit(1).lean();
    const firstAt = firstDoc[0] && firstDoc[0].createdAt ? new Date(firstDoc[0].createdAt) : now;
    const spanDays = Math.max(0, (now - firstAt) / 86400000);
    // Months, always. Weekly buckets were an attempt to fill the chart, but the
    // question being asked is month-on-month growth, and you cannot read that
    // off weeks. Three real months beats ten thin weeks.
    const granularity = "month";

    // Bucket COUNT is capped, not fixed. A fixed count longer than the history
    // pads the left of the chart with empty buckets, which is the same
    // emptiness monthly buckets caused — just at a finer grain. One bucket of
    // headroom past the oldest record, and no more.
    const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
    const BUCKETS = clamp(Math.ceil(spanDays / 30) + 1, 3, 12);

    // Window start: the first day of the earliest bucket we intend to draw.
    const startOfWindow = granularity === "week"
      ? (() => {
          const d = new Date(now);
          d.setHours(0, 0, 0, 0);
          d.setDate(d.getDate() - d.getDay() + (d.getDay() === 0 ? -6 : 1)); // Monday of this week
          d.setDate(d.getDate() - 7 * (BUCKETS - 1));
          return d;
        })()
      : new Date(now.getFullYear(), now.getMonth() - (BUCKETS - 1), 1);

    // $year/$month bucket in UTC unless told otherwise, but every date boundary
    // in this route is built with `new Date(y, m, 1)` — server-local. Left to
    // default, an order completed in the first 5.5 hours of a month in IST
    // would be bucketed into the PREVIOUS month by Mongo while the loop below
    // looks for it in the current one, and its revenue would drop out of the
    // trend entirely rather than land a month early. Bucketing in the same zone
    // the boundaries were built in keeps the two in step.
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

    // One bucket expression, used by both aggregations so the two series are
    // always cut on identical boundaries.
    const bucketId = (field) => (granularity === "week"
      ? { y: { $isoWeekYear: { date: field, timezone: tz } },
          w: { $isoWeek:     { date: field, timezone: tz } } }
      : { y: { $year:  { date: field, timezone: tz } },
          m: { $month: { date: field, timezone: tz } } });

    // The same cut, computed in JS, so the fill loop below can find a bucket by
    // key instead of guessing. ISO weeks belong to the year holding their
    // Thursday, which is why this is not simply "week number of this year".
    const isoParts = (d) => {
      const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
      const day = t.getUTCDay() || 7;
      t.setUTCDate(t.getUTCDate() + 4 - day);
      const y = t.getUTCFullYear();
      const w = Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
      return { y, w };
    };
    const monthlyGroups = await CustomerRequest.aggregate([
      { $match: { status: { $in: ["completed", "delivered"] }, updatedAt: { $gte: startOfWindow } } },
      {
        $group: {
          _id: bucketId("$updatedAt"),
          revenue: { $sum: { $sum: { $ifNull: ["$items.totalEstimatedPrice", []] } } },
          orders:  { $sum: 1 },
        },
      },
    ]);

    // ── The second series: value BOOKED, not billed ──────────────────────
    //
    // Billing above counts only requests that reached completed or delivered.
    // A young account has none, so that series is a truthful but useless row
    // of zeroes while twenty real requests carrying real value sit in the
    // pipeline. This is what came IN each month — every request raised, at its
    // own item value, cancelled ones excluded — dated by createdAt rather than
    // updatedAt because booking is when the request arrived.
    //
    // Same unit as revenue (rupees), so the two can share one axis honestly
    // and the gap between them is a real quantity: value won but not yet
    // delivered.
    // Split by where that value has GOT TO, which is what turns one line into
    // the multi-series trend: of the value that arrived each month, how much is
    // still unquoted, how much is out with the customer, how much is approved
    // and awaiting payment, how much is on the floor, how much is billed. Every
    // series is rupees, so they share an axis honestly, and they sum to the
    // month's booked total.
    const VALUE_BUCKETS = {
      unquoted: ["pending", "pending_edit_approval", "in_progress", "quotation_draft"],
      quoted:   ["quotation_sent"],
      awaiting: ["quotation_customer_approved", "quotation_sales_approved"],
      inFlight: ["production", "shipping"],
      billed:   ["completed", "delivered"],
    };
    const bucketFor = (status) =>
      Object.keys(VALUE_BUCKETS).find((k) => VALUE_BUCKETS[k].includes(status)) || null;

    const bookedGroups = await CustomerRequest.aggregate([
      { $match: { status: { $ne: "cancelled" }, createdAt: { $gte: startOfWindow } } },
      {
        $group: {
          _id: { ...bucketId("$createdAt"), s: "$status" },
          value: { $sum: { $sum: { $ifNull: ["$items.totalEstimatedPrice", []] } } },
          n: { $sum: 1 },
        },
      },
    ]);

    // ── Revenue per customer: the series that actually wants many lines ──
    //
    // One revenue line stretched across the slab is a single fact. Split by
    // ACCOUNT it stays revenue — the metric asked for — and becomes the
    // multi-series trend the reference figure is built for, answering the
    // question a sales head has: which accounts are growing, which have gone
    // quiet. Top five by value in the window; the rest would be hairlines.
    const VALUE = { $sum: { $ifNull: ["$items.totalEstimatedPrice", []] } };
    const inWindow = { status: { $ne: "cancelled" }, createdAt: { $gte: startOfWindow } };

    const topCustomers = await CustomerRequest.aggregate([
      { $match: inWindow },
      { $group: { _id: "$customerInfo.name", v: { $sum: VALUE } } },
      { $match: { _id: { $ne: null }, v: { $gt: 0 } } },
      { $sort: { v: -1 } },
      { $limit: 5 },
    ]);
    const trendCustomers = topCustomers.map((c) => c._id);

    const customerGroups = trendCustomers.length
      ? await CustomerRequest.aggregate([
          { $match: { ...inWindow, "customerInfo.name": { $in: trendCustomers } } },
          { $group: { _id: { ...bucketId("$createdAt"), c: "$customerInfo.name" },
                      v: { $sum: VALUE } } },
        ])
      : [];

    // Every month in the window gets a point, including the ones with no
    // orders. A month absent from the array would make the trend line skip
    // over it and imply a shorter, smoother history than actually happened.
    const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                         "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const monthlyRevenue = [];
    for (let i = BUCKETS - 1; i >= 0; i--) {
      // The bucket's start date, and the predicate that finds its aggregated
      // rows — both switch on granularity together, so they cannot disagree.
      let d, sameBucket, label;
      if (granularity === "week") {
        d = new Date(startOfWindow);
        d.setDate(d.getDate() + 7 * (BUCKETS - 1 - i));
        const { y, w } = isoParts(d);
        sameBucket = (g) => g._id.y === y && g._id.w === w;
        label = `${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`;
      } else {
        d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        sameBucket = (g) => g._id.y === d.getFullYear() && g._id.m === d.getMonth() + 1;
        label = MONTH_NAMES[d.getMonth()];
      }
      const hit = monthlyGroups.find(sameBucket);

      // Fold this bucket's per-status rows into the value buckets. Every one is
      // present as 0 when it has nothing, so a series is a full line or it is
      // absent — never a line with holes in it.
      const buckets = Object.keys(VALUE_BUCKETS).reduce((a, k) => ({ ...a, [k]: 0 }), {});
      let booked = 0;
      let requests = 0;
      bookedGroups.filter(sameBucket).forEach((row) => {
        const b = bucketFor(row._id.s);
        if (b) buckets[b] += row.value;
        booked += row.value;
        requests += row.n;
      });
      Object.keys(buckets).forEach((k) => {
        buckets[k] = Math.round(buckets[k] * 100) / 100;
      });

      // Per-customer value for this bucket, every tracked account present as 0
      // so each line is continuous.
      const customers = trendCustomers.reduce((a, name) => {
        const row = customerGroups.find((g) => sameBucket(g) && g._id.c === name);
        a[name] = row ? Math.round(row.v * 100) / 100 : 0;
        return a;
      }, {});

      // Growth against the previous bucket. Null rather than 0 for the first
      // bucket and for any month following a zero — a percentage change needs
      // something to change from, and "0%" would read as "flat".
      const prevRow = monthlyRevenue[monthlyRevenue.length - 1];
      const growth = prevRow && prevRow.booked > 0
        ? Math.round(((booked - prevRow.booked) / prevRow.booked) * 100)
        : null;

      monthlyRevenue.push({
        customers,
        growth,
        month: label,
        year: d.getFullYear(),
        startsAt: d,
        revenue: hit ? Math.round(hit.revenue * 100) / 100 : 0,
        orders: hit ? hit.orders : 0,
        booked: Math.round(booked * 100) / 100,
        requests,
        ...buckets,
      });
    }

    res.json({
      success: true,
      stats: {
        totalRequests,
        pendingRequests,
        inProgressRequests,
        completedRequests,
        totalCustomers,
        revenueThisMonth,
        revenueGrowth,
        averageOrderValue,

        // The stages the dashboard asks for and this route never sent.
        quotationSentCount:   countOf("quotation_draft", "quotation_sent"),
        awaitingPaymentCount: countOf("quotation_customer_approved", "quotation_sales_approved"),
        productionCount:      countOf("production"),
        shippingCount:        countOf("shipping"),
        cancelledRequests:    countOf("cancelled"),
        onHoldCount:          countOf("on_hold"),
      },
      monthlyRevenue,
      trendGranularity: granularity,
      trendCustomers,
    });

  } catch (error) {
    console.error("Error fetching dashboard stats:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching dashboard statistics"
    });
  }
});

// GET recent requests
router.get("/dashboard/recent-requests", async (req, res) => {
  try {
    const recentRequests = await CustomerRequest.find()
      .sort({ createdAt: -1 })
      .limit(10)
      .populate('salesPersonAssigned', 'name email')
      .select('-__v -updatedAt');

    res.json({
      success: true,
      requests: recentRequests
    });

  } catch (error) {
    console.error("Error fetching recent requests:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching recent requests"
    });
  }
});

// GET top customers
router.get("/dashboard/top-customers", async (req, res) => {
  try {
    // Aggregate top customers by order value
    const topCustomers = await CustomerRequest.aggregate([
      { $match: { status: 'completed' } },
      { $group: {
          _id: '$customerId',
          totalSpent: { $sum: '$quotationAmount' },
          orderCount: { $sum: 1 }
        }
      },
      { $sort: { totalSpent: -1 } },
      { $limit: 5 },
      { $lookup: {
          from: 'customers',
          localField: '_id',
          foreignField: '_id',
          as: 'customer'
        }
      },
      { $unwind: '$customer' },
      { $project: {
          _id: 1,
          name: '$customer.name',
          email: '$customer.email',
          phone: '$customer.phone',
          totalSpent: 1,
          orderCount: 1
        }
      }
    ]);

    res.json({
      success: true,
      customers: topCustomers
    });

  } catch (error) {
    console.error("Error fetching top customers:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching top customers"
    });
  }
});

module.exports = router;