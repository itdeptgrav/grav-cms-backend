// routes/CMS_Routes/Sales/salesCustomers.js
//
// Customer management for the Sales dashboard.
// Changes from v1:
//   - Password is optional on create; a temp password is auto-generated if omitted
//   - Welcome / password-reset / profile-update emails sent via salesEmailService
//   - hasPassword boolean added to list responses (password field has select:false)
//   - stock-items/search route moved BEFORE /:id to prevent param collision
//   - GET /:id/work-orders  — production work orders for a customer
//   - GET /:id/measurements — MPC measurement sessions for a customer
//   - profile.avatar field handled on create + update

const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const Customer = require("../../../models/Customer_Models/Customer");
const StockItem = require("../../../models/CMS_Models/Inventory/Products/StockItem");
const WorkOrder = require("../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const Measurement = require("../../../models/Customer_Models/Measurement");
const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");
const { sendCustomerEmail } = require("../../../utils/salesEmailService");
// Was required only inside GET /:id/orders's own function scope (below),
// invisible to every other handler in this file — including POST
// /:id/create-request, which called it at its own line 661 and threw
// "nextRequestId is not defined" on every single call (26 Aug 2026, explicit
// report — "this error is happening while click on the Submit Request").
// This route had never worked; nothing before now had exercised it enough to
// surface the missing import.
const { nextRequestId } = require("../../../services/requestId");

// ── Temp password generator ───────────────────────────────────────────────────
const generateTempPassword = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#";
  return Array.from(
    { length: 10 },
    () => chars[Math.floor(Math.random() * chars.length)],
  ).join("");
};

// ─── GET /api/cms/sales/customers ─────────────────────────────────────────────
router.get("/", salesAuth, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 30,
      search,
      sortBy = "createdAt",
      sortOrder = "desc",
      isActive,
    } = req.query;

    const filter = {};
    if (isActive !== undefined) filter.isActive = isActive === "true";
    if (search) {
      const re = new RegExp(search, "i");
      filter.$or = [
        { name: re },
        { email: re },
        { phone: re },
        { customerId: re },
        { "profile.companyName": re },
      ];
    }

    const sort = {};
    sort[sortBy] = sortOrder === "asc" ? 1 : -1;

    const total = await Customer.countDocuments(filter);

    // Include password field to derive hasPassword boolean
    const rawCustomers = await Customer.find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .select("+password -cart -favorites -orders -__v")
      .lean();

    // Which assigned products still exist (26 Aug 2026, bug fix). This list's
    // "Products" badge used to be `assignedStockItems.length` — a raw count
    // that includes rows whose StockItem was since deleted (see the delete
    // route's own cleanup, and the /assigned-items and /:id routes' filters,
    // added the same day). That desynced this list from reality: a customer
    // showed e.g. "4 products" here while the Bulk Request panel — which DOES
    // filter — correctly showed none available, with no way to tell from this
    // list why. One batched query across every customer on the page, not one
    // query per customer, since a list can be up to `limit` (default 30) rows.
    const allStockItemIds = [
      ...new Set(
        rawCustomers.flatMap((c) => (c.assignedStockItems || []).map((a) => a.stockItemId)).filter(Boolean).map(String),
      ),
    ];
    const aliveIds = allStockItemIds.length
      ? new Set((await StockItem.find({ _id: { $in: allStockItemIds } }).select("_id").lean()).map((s) => String(s._id)))
      : new Set();

    // Strip raw password, replace with boolean flag
    const customers = rawCustomers.map(({ password, ...c }) => ({
      ...c,
      hasPassword: !!password,
      // The count the "Products" badge should show — assigned AND still in
      // the register. `assignedStockItems` itself is left exactly as stored;
      // only this derived count changes, so nothing else reading the raw
      // array (e.g. the customer detail page, which does its own filtering)
      // is affected.
      productCount: (c.assignedStockItems || []).filter((a) => a.stockItemId && aliveIds.has(String(a.stockItemId))).length,
      unavailableProductCount: (c.assignedStockItems || []).filter((a) => !a.stockItemId || !aliveIds.has(String(a.stockItemId))).length,
    }));

    const [total_all, active, withPassword, createdBySales] = await Promise.all(
      [
        Customer.countDocuments(),
        Customer.countDocuments({ isActive: true }),
        Customer.countDocuments({
          password: { $exists: true, $ne: null, $ne: "" },
        }),
        Customer.countDocuments({ createdBySales: true }),
      ],
    );

    res.json({
      success: true,
      customers,
      stats: { total: total_all, active, withPassword, createdBySales },
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error("[salesCustomers] GET /", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/cms/sales/customers ───────────────────────────────────────────
router.post("/", salesAuth, async (req, res) => {
  try {
    const { name, password: rawPassword, profile = {}, businessInfo } = req.body;

    // ── Sanitise inputs first — trim whitespace so queries are clean ─────────
    const email = (req.body.email || "").trim().toLowerCase();
    const phone = (req.body.phone || "").trim();
    const alternatePhone = (req.body.alternatePhone || "").trim();
    // Kept in step with profile.gstNumber ("kept for backward compat" per the
    // model's own comment) — the Lead-conversion verification form (20 Aug
    // 2026) is the first caller that actually sends this at creation time,
    // so both copies get written together rather than one silently trailing
    // the other from day one.
    const gstNumber = (req.body.gstNumber || profile.gstNumber || "").trim().toUpperCase();

    if (!name?.trim() || !email || !phone) {
      return res.status(400).json({
        success: false,
        message: "Name, email and phone are required",
      });
    }

    // ── Check email uniqueness separately ────────────────────────────────────
    const emailExists = await Customer.findOne({ email }).select("_id").lean();
    if (emailExists) {
      return res.status(409).json({
        success: false,
        message: "A customer with this email address already exists",
      });
    }

    // ── Check phone uniqueness separately ────────────────────────────────────
    const phoneExists = await Customer.findOne({ phone }).select("_id").lean();
    if (phoneExists) {
      return res.status(409).json({
        success: false,
        message: "A customer with this phone number already exists",
      });
    }

    // Use provided password or auto-generate a secure temp password
    const tempPassword =
      rawPassword && rawPassword.trim().length >= 6
        ? rawPassword.trim()
        : generateTempPassword();

    const customer = await Customer.create({
      name: name.trim(),
      email,
      phone,
      alternatePhone: alternatePhone || undefined,
      gstNumber: gstNumber || undefined,
      password: tempPassword, // hashed by pre-save hook
      profile: {
        ...profile,
        gstNumber: gstNumber || profile.gstNumber || undefined,
        avatar: profile.avatar || null,
      },
      businessInfo: businessInfo || undefined,
      isActive: true,
      isEmailVerified: true,
      createdBySales: true,
      salesAssignedBy: req.user?.id,
      salesAssignedByName: req.user?.name || "Sales Team",
    });

    // Send welcome email (non-blocking — never fails the request)
    sendCustomerEmail("welcome", customer.email, {
      name: customer.name,
      customerId: customer.customerId,
      email: customer.email,
      password: tempPassword,
      salesRepName: req.user?.name,
      portalUrl:
        process.env.CUSTOMER_PORTAL_URL || "https://portal.gravclothing.com",
    }).catch(() => {});

    const safe = customer.toObject();
    delete safe.password;

    res.status(201).json({
      success: true,
      message: "Customer account created successfully",
      customer: safe,
      tempPassword,
    });
  } catch (err) {
    console.error("[salesCustomers] POST /", err);
    if (err.code === 11000) {
      // MongoDB unique index violation — tell the user exactly which field
      const field = Object.keys(err.keyValue || {})[0] || "field";
      const label =
        field === "email"
          ? "email address"
          : field === "phone"
            ? "phone number"
            : field;
      return res.status(409).json({
        success: false,
        message: `A customer with this ${label} already exists`,
      });
    }
    res.status(400).json({ success: false, message: err.message });
  }
});

// ─── IMPORTANT: Static sub-routes MUST come before /:id ──────────────────────

// ─── GET /api/cms/sales/customers/stock-items/search ─────────────────────────
router.get("/stock-items/search", salesAuth, async (req, res) => {
  try {
    const { q = "", limit = 200, category } = req.query;
    const filter = { isActive: { $ne: false } };
    if (q) {
      const re = new RegExp(q, "i");
      filter.$or = [{ name: re }, { reference: re }, { category: re }];
    }
    if (category && category !== "all") filter.category = category;

    const items = await StockItem.find(filter)
      .select(
        "name reference category images variants baseSalesPrice attributes",
      )
      .limit(parseInt(limit))
      .lean();

    res.json({ success: true, items });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/cms/sales/customers/for-account/:accountId ─────────────────────
//
// Resolving the portal Customer BEHIND a CRM Account — the one thing Cost &
// Quote's "raise a PI" flow and the Purchase Invoice stage both need and, until
// now, both got wrong the same way: they searched the portal Customer
// collection BY THE ACCOUNT'S NAME (lib/salesJourney/piResolve.js), while this
// exact bridge already exists, explicit and authoritative, as
// `Account.linkedCustomer` — built for the Account workspace's MPC/measurement
// sections (app/sales/dashboard/accounts/[id]/_sections/_linkedCustomer.js).
// Name-searching a DIFFERENT collection instead of reading the field built
// for this is why raising an invoice could fail with "no customer record
// matches" even when the account was fully set up — the invoice code simply
// never looked at the one field that would have answered it (2 Sept 2026,
// explicit report: PI stage dead-ending on a real, active account).
//
// linkedCustomer wins outright when set — it is a deliberate choice someone
// made, not a guess to second-guess. It is emphatically NOT second-guessed by
// comparing the account's name to the customer's name: real accounts here
// link to a personal contact name or a different trading name on purpose
// (checked against live data — 4 of 5 existing links would have "failed" a
// name-similarity check while being entirely correct), so that check was
// tried and thrown out as pure alarm-fatigue noise.
//
// What IS a genuine anomaly — found on real data while building this route —
// is the SAME portal customer linked from TWO DIFFERENT accounts (Umung Pvt
// Ltd and Soumya Pvt Ltd both pointing at one customer, evidently a mistake
// made linking one of them). A portal login belongs to one company; two
// unrelated CRM accounts sharing one is the actual "linked to the wrong
// thing" signal, and writing an invoice against the wrong customer is not a
// recoverable mistake — so `sharedWithAccounts` names every OTHER account
// that resolves to this same customer, for the frontend to warn on rather
// than hide.
//
// Falls back to a name search only when there is NO explicit link — the
// legacy behaviour, kept so accounts nobody has linked yet (there is at least
// one on real data) still resolve when a same-named Customer exists, rather
// than breaking something that happened to work.
router.get("/for-account/:accountId", salesAuth, async (req, res) => {
  try {
    const Account = require("../../../models/CMS_Models/Sales/Account");
    const account = await Account.findById(req.params.accountId)
      .select("companyName displayName normalizedName linkedCustomer")
      .populate("linkedCustomer", "name email phone customerId profile.companyName isActive")
      .lean();
    if (!account) return res.status(404).json({ success: false, message: "Account not found" });

    const accountName = account.displayName || account.companyName || "";

    if (account.linkedCustomer) {
      const sharedWith = await Account.find({
        _id: { $ne: account._id },
        linkedCustomer: account.linkedCustomer._id,
      }).select("companyName displayName").lean();
      return res.json({
        success: true,
        customer: account.linkedCustomer,
        matchedBy: "linked",
        sharedWithAccounts: sharedWith.map((a) => a.displayName || a.companyName),
        accountName,
      });
    }

    // No explicit link — fall back to the old name search rather than a hard
    // failure, so an account nobody has linked yet (but that happens to have
    // a same-named portal Customer) keeps working exactly as before.
    const re = new RegExp(accountName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const rows = accountName
      ? await Customer.find({
          $or: [{ name: re }, { email: re }, { phone: re }, { customerId: re }, { "profile.companyName": re }],
        }).select("name email phone customerId profile.companyName isActive").limit(5).lean()
      : [];
    const norm = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    let customer = null;
    if (rows.length === 1) customer = rows[0];
    else if (rows.length > 1) {
      const exact = rows.filter((c) => norm(c.profile?.companyName || c.name) === norm(accountName));
      customer = exact.length === 1 ? exact[0] : null;
    }

    return res.json({
      success: true,
      customer,
      matchedBy: customer ? "name" : "none",
      sharedWithAccounts: [],
      accountName,
      // So the frontend can tell "no match" from "matched more than one" —
      // the two need different guidance, and the old code showed the same
      // sentence for both.
      candidateCount: rows.length,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/cms/sales/customers/:id ────────────────────────────────────────
router.get("/:id", salesAuth, async (req, res) => {
  try {
    const rawCustomer = await Customer.findById(req.params.id)
      .select("+password -cart -favorites -__v")
      .populate(
        "assignedStockItems.stockItemId",
        "name reference category images variants",
      )
      .lean();

    if (!rawCustomer)
      return res
        .status(404)
        .json({ success: false, message: "Customer not found" });

    const { password, ...customer } = rawCustomer;
    customer.hasPassword = !!password;
    // Same dangling-reference filter as /assigned-items above — a deleted
    // product populates to null here too, and anything mapping over this list
    // would hit the same id-less row (26 Aug 2026).
    customer.assignedStockItems = (customer.assignedStockItems || []).filter((a) => a?.stockItemId);

    res.json({ success: true, customer });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /api/cms/sales/customers/:id ──────────────────────────────────────
router.patch("/:id", salesAuth, async (req, res) => {
  try {
    delete req.body.password;

    // Capture what changed for the email notification
    const before = await Customer.findById(req.params.id)
      .select("name email phone profile")
      .lean();

    const customer = await Customer.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true, runValidators: true },
    ).select("-password -cart -favorites -__v");

    if (!customer)
      return res
        .status(404)
        .json({ success: false, message: "Customer not found" });

    // Build changed-fields list for email
    const changedFields = [];
    if (before && req.body.name && before.name !== req.body.name)
      changedFields.push(["Name", req.body.name]);
    if (before && req.body.email && before.email !== req.body.email)
      changedFields.push(["Email", req.body.email]);
    if (before && req.body.phone && before.phone !== req.body.phone)
      changedFields.push(["Phone", req.body.phone]);
    if (req.body.profile?.companyName)
      changedFields.push(["Company", req.body.profile.companyName]);
    if (req.body.profile?.gstNumber)
      changedFields.push(["GST Number", req.body.profile.gstNumber]);

    if (changedFields.length > 0) {
      sendCustomerEmail("profileUpdate", customer.email, {
        name: customer.name,
        email: customer.email,
        updatedFields: changedFields,
        updatedBy: req.user?.name || "Sales Team",
      }).catch(() => {});
    }

    res.json({ success: true, message: "Customer updated", customer });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// ─── POST /api/cms/sales/customers/:id/reset-password ────────────────────────
router.post("/:id/reset-password", salesAuth, async (req, res) => {
  try {
    const { newPassword } = req.body;

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 6 characters",
      });
    }

    const salt = await bcrypt.genSalt(10);
    const hashed = await bcrypt.hash(newPassword, salt);

    const customer = await Customer.findByIdAndUpdate(
      req.params.id,
      { password: hashed },
      { new: true },
    ).select("name email");

    if (!customer)
      return res
        .status(404)
        .json({ success: false, message: "Customer not found" });

    // Send password reset email (non-blocking)
    sendCustomerEmail("passwordReset", customer.email, {
      name: customer.name,
      email: customer.email,
      newPassword,
      resetBy: req.user?.name || "Sales Team",
      portalUrl:
        process.env.CUSTOMER_PORTAL_URL || "https://portal.gravclothing.com",
    }).catch(() => {});

    res.json({
      success: true,
      message: "Password reset successfully. Notification sent to customer.",
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/cms/sales/customers/:id/deletion-impact ────────────────────────
//
// What deleting this customer would actually remove, counted, plus whether it
// is allowed at all. Added 28 Aug 2026 with the delete control itself.
//
// Separate from the DELETE on purpose: the person confirming has to be able to
// SEE the scope first. A cascade across ~35 collections that you agree to
// blind is not a decision, and "I didn't know it would take the orders too" is
// not recoverable afterwards.
router.get("/:id/deletion-impact", salesAuth, async (req, res) => {
  try {
    const { deletionImpact } = require("../../../services/customerPurge.service");
    const impact = await deletionImpact(req.params.id);
    if (!impact) return res.status(404).json({ success: false, message: "Customer not found" });
    res.json({ success: true, ...impact });
  } catch (err) {
    console.error("[salesCustomers] deletion-impact failed:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── DELETE /api/cms/sales/customers/:id ─────────────────────────────────────
//
// Delete the customer and everything raised for them — orders, work orders,
// dispatch challans, per-person progress, their CRM account and everything
// under it (leads, enquiries, journeys, styles, activities, contacts), their
// employee roster and measurement sessions.
//
// THREE GUARDS, none of them decorative:
//
//   1. MANAGER ONLY. Irreversible and wide; an editor's mistake here cannot be
//      walked back, and this file's other destructive-ish route is already
//      role-gated.
//   2. TYPED CONFIRMATION. The caller must send the customer's own code
//      (CUST-0027) in the body. A misfired click cannot produce that string,
//      and it also proves the client deleted the record it was looking at
//      rather than one a stale id pointed to.
//   3. NO MONEY ATTACHED. Refused outright when the customer has invoices,
//      proformas, reconciled bank lines, an accounting ledger, or any order
//      with payments received. Accounting records are not a sales screen's to
//      destroy, and orphaning them silently breaks reconciliation. The service
//      names what is in the way so the answer is actionable, not just "no".
router.delete("/:id", salesAuth, async (req, res) => {
  try {
    const { isSalesManager } = require("../../../services/salesAccess");
    if (!(await isSalesManager(req.user))) {
      return res.status(403).json({
        success: false,
        message: "Only a sales manager can delete a customer. Ask a manager, or deactivate the customer instead.",
      });
    }

    const { deletionImpact, purgeCustomer } = require("../../../services/customerPurge.service");
    const impact = await deletionImpact(req.params.id);
    if (!impact) return res.status(404).json({ success: false, message: "Customer not found" });

    const typed = String(req.body?.confirm || "").trim();
    const expected = String(impact.customer.code || "").trim();
    if (!expected || typed !== expected) {
      return res.status(400).json({
        success: false,
        message: `To confirm, type the customer's code exactly: ${expected || "(this customer has no code, so it cannot be deleted this way)"}`,
        expected,
      });
    }

    if (!impact.safeToDelete) {
      return res.status(409).json({
        success: false,
        code: "has-financial-records",
        message: `This customer can't be deleted — ${impact.blockers.join(", ")} reference them. Deleting would orphan accounting records and break reconciliation. Deactivate the customer instead, which hides them everywhere without destroying the books.`,
        blockers: impact.blockers,
        financial: impact.financial,
      });
    }

    const result = await purgeCustomer(req.params.id);
    if (!result.ok) {
      return res.status(409).json({ success: false, message: "Deletion was refused.", ...result });
    }

    console.warn(
      `[salesCustomers] customer PURGED: ${result.customer.code} "${result.customer.name}" by ${req.user?.name || req.user?.id} — ${JSON.stringify(result.deleted)}`,
    );
    res.json({ success: true, deleted: result.deleted, customer: result.customer });
  } catch (err) {
    console.error("[salesCustomers] delete failed:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /api/cms/sales/customers/:id/toggle-status ────────────────────────
router.patch("/:id/toggle-status", salesAuth, async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);
    if (!customer)
      return res
        .status(404)
        .json({ success: false, message: "Customer not found" });

    customer.isActive = !customer.isActive;
    await customer.save();

    res.json({
      success: true,
      message: `Customer ${customer.isActive ? "activated" : "deactivated"}`,
      isActive: customer.isActive,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/cms/sales/customers/:id/orders ─────────────────────────────────
// DEDICATED endpoint — always filters strictly by this customer's _id.
// Fixes the cross-contamination bug where the shared /requests route
// returned all requests when customerId param was ignored.
router.get("/:id/orders", salesAuth, async (req, res) => {
  try {
    const CustomerRequest = require("../../../models/Customer_Models/CustomerRequest");
    // nextRequestId is unused in this handler — moved to the module-level
    // import above, which is what create-request actually needed.
    const mongoose = require("mongoose");

    let custObjectId;
    try {
      custObjectId = new mongoose.Types.ObjectId(req.params.id);
    } catch {
      return res
        .status(400)
        .json({ success: false, message: "Invalid customer ID" });
    }

    const orders = await CustomerRequest.find({ customerId: custObjectId })
      .sort({ createdAt: -1 })
      .select(
        "requestId status priority requestType measurementName measurementId " +
          "customerInfo items finalOrderPrice totalPaidAmount totalDueAmount " +
          "quotations.quotationNumber quotations.grandTotal quotations.status " +
          "quotations.paymentSchedule quotations.paymentSubmissions " +
          "quotations.validUntil quotations.date quotations.notes " +
          "quotations.items quotations.totalGST quotations.subtotalBeforeGST " +
          "quotations.shippingCharges quotations.customAdditionalCharges " +
          "processingStartedAt estimatedCompletion actualCompletion " +
          "createdAt updatedAt",
      )
      .lean();

    res.json({ success: true, orders, total: orders.length });
  } catch (err) {
    console.error("[salesCustomers] GET /:id/orders", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/cms/sales/customers/:id/work-orders ────────────────────────────
router.get("/:id/work-orders", salesAuth, async (req, res) => {
  try {
    const workOrders = await WorkOrder.find({ customerId: req.params.id })
      .select(
        "workOrderNumber status quantity stockItemName stockItemReference variantAttributes priority timeline assignedDeadline createdAt isSplitOrder parentWorkOrderId productionCompletion.overallCompletionPercentage cuttingStatus",
      )
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    res.json({ success: true, workOrders });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/cms/sales/customers/:id/measurements ───────────────────────────
// Returns measurement sessions for this customer.
// IMPORTANT: measured count = employeeMeasurements.length (anyone in the array
// has data entered — no status field needed per business rule).
router.get("/:id/measurements", salesAuth, async (req, res) => {
  try {
    const raw = await Measurement.find({ organizationId: req.params.id })
      .select(
        "name description registeredEmployeeIds employeeMeasurements " +
          "convertedToPO poConversionDate createdAt",
      )
      .sort({ createdAt: -1 })
      .lean();

    // Compute counts directly from array lengths — do NOT use stored
    // measuredEmployees / completionRate fields as they may be stale or
    // rely on isCompleted status which is not relevant here.
    const measurements = raw.map((m) => {
      const totalRegistered =
        m.registeredEmployeeIds?.length || m.employeeMeasurements?.length || 0;
      const actualMeasured = m.employeeMeasurements?.length || 0;
      const pending = Math.max(0, totalRegistered - actualMeasured);
      const completionRate =
        totalRegistered > 0
          ? Math.round((actualMeasured / totalRegistered) * 100)
          : actualMeasured > 0
            ? 100
            : 0;

      return {
        _id: m._id,
        name: m.name,
        description: m.description,
        totalRegistered,
        actualMeasured,
        pending,
        completionRate,
        convertedToPO: m.convertedToPO,
        poConversionDate: m.poConversionDate,
        createdAt: m.createdAt,
      };
    });

    res.json({ success: true, measurements });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/cms/sales/customers/:id/assigned-items ─────────────────────────
router.get("/:id/assigned-items", salesAuth, async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id)
      .select("assignedStockItems name customerId")
      .populate({
        path: "assignedStockItems.stockItemId",
        select:
          "name reference category genderCategory images variants attributes baseSalesPrice",
      })
      .lean();

    if (!customer)
      return res
        .status(404)
        .json({ success: false, message: "Customer not found" });

    // Drop assignments whose product no longer exists (26 Aug 2026, bug fix).
    // `populate` resolves a dangling reference to `null`, not to the raw id,
    // so a deleted StockItem arrives here as `{ stockItemId: null }`. Served
    // as-is, each one became a product row with no id — un-orderable, and
    // (when a customer had more than one) sharing a null React key, which is
    // the "Encountered two children with the same key, `null`" crash in the
    // size-wise bulk order slider. Two customers in the live data had EVERY
    // assignment in this state.
    //
    // Filtered rather than repaired: this is a read, and a GET must not
    // write. The delete route now unassigns properly, and
    // scripts/cleanup_dangling_assignments.js clears the historic rows.
    const assignedItems = (customer.assignedStockItems || []).filter((a) => a?.stockItemId);
    const dropped = (customer.assignedStockItems || []).length - assignedItems.length;
    if (dropped) {
      console.warn(`[salesCustomers] customer ${customer.customerId || customer._id}: hid ${dropped} assignment(s) whose product was deleted.`);
    }

    // ── ?customerApprovedOnly=1 — only what THIS customer signed off ─────────
    // 27 Aug 2026, explicit request: a proforma invoice may only offer products
    // "which are approved by that customer... or else not show ok even though
    // the product id linked to the customer". Being assigned means someone put
    // it on their list; being APPROVED means they saw the sample and said yes.
    // Invoicing the first for the second is how a customer gets billed for
    // something they rejected — which the live data has, so this is not
    // hypothetical.
    //
    // `SampleStyle.customerApproval.approved` is the authoritative field (the
    // enquiry's older costingLifecycle equivalent was superseded). Strictly
    // `=== true`: the default is null, so a "not false" test would let every
    // undecided product through — the exact opposite of what was asked.
    //
    // Opt-in, because "assigned" and "approved" are different questions and
    // other callers legitimately want the first.
    // THREE outcomes, not two — the distinction that makes this shippable:
    //
    //   • went through Style & Sample AND was approved  → offer it
    //   • went through Style & Sample, rejected or still
    //     awaiting the customer's answer                → HIDE it
    //   • never entered Style & Sample at all (legacy)  → offer it, flagged
    //
    // The third case is why this is not a plain "approved only" filter. Customer
    // approval is a recent step: as of 27 Aug 2026 exactly 2 products in the
    // live database carry one, while Mayfair alone has 102 assigned products
    // from before it existed. A strict filter would have shown every real
    // customer an empty catalogue — enforcing the rule by deleting the feature.
    // Hiding a product nobody ever asked the customer about is not enforcement,
    // it is just data loss; hiding one they actually rejected is the rule.
    // Confirmed as the intended behaviour before shipping.
    let items = assignedItems;
    let notApprovedCount = 0;
    if (String(req.query.customerApprovedOnly || "") === "1") {
      const SampleStyle = require("../../../models/CMS_Models/Sales/SampleStyle");
      const ids = items.map((a) => a.stockItemId?._id).filter(Boolean);
      // Base rows only — a variant carries its parent's decision, and
      // sourceStockItemId is what ties a style back to an assigned product.
      const styles = ids.length
        ? await SampleStyle.find({
            isActive: true,
            variantKey: { $in: [null, ""] },
            sourceStockItemId: { $in: ids },
          }).select("sourceStockItemId customerApproval.approved").lean()
        : [];

      // A product can carry more than one style; approved by any of them counts.
      const seen = new Map();
      for (const s of styles) {
        const k = String(s.sourceStockItemId);
        seen.set(k, (seen.get(k) || false) || s.customerApproval?.approved === true);
      }

      const before = items.length;
      items = items
        .filter((a) => {
          const k = String(a.stockItemId?._id);
          if (!seen.has(k)) return true;  // legacy — no approval was ever sought
          return seen.get(k) === true;    // asked: only if they said yes
        })
        // Tagged so the picker can mark a legacy row rather than implying the
        // customer approved something they were never shown.
        .map((a) => ({
          ...a,
          approvalState: seen.has(String(a.stockItemId?._id)) ? "approved" : "no-record",
        }));
      notApprovedCount = before - items.length;
    }

    res.json({
      success: true,
      assignedItems: items,
      // Named so the UI can say "3 assigned products are no longer in the
      // register" rather than silently showing a shorter list.
      unavailableCount: dropped,
      // Same principle for the approval filter: a shorter list must come with
      // a reason, or it reads as missing data.
      notApprovedCount,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/cms/sales/customers/:id/assign-items ──────────────────────────
router.post("/:id/assign-items", salesAuth, async (req, res) => {
  try {
    const { stockItemIds = [], mode = "replace" } = req.body;

    if (!Array.isArray(stockItemIds))
      return res
        .status(400)
        .json({ success: false, message: "stockItemIds must be an array" });

    const customer = await Customer.findById(req.params.id);
    if (!customer)
      return res
        .status(404)
        .json({ success: false, message: "Customer not found" });

    const stockItems = await StockItem.find({ _id: { $in: stockItemIds } })
      .select("name reference")
      .lean();

    const itemMap = {};
    stockItems.forEach((s) => {
      itemMap[s._id.toString()] = s;
    });

    const newAssignments = stockItemIds
      .filter((id) => itemMap[id])
      .map((id) => ({
        stockItemId: id,
        stockItemName: itemMap[id].name,
        stockItemReference: itemMap[id].reference,
        assignedAt: new Date(),
        assignedBy: req.user?.id,
        assignedByName: req.user?.name || "Sales",
      }));

    if (mode === "replace") {
      customer.assignedStockItems = newAssignments;
    } else {
      // Null-guarded (26 Aug 2026): an assignment row with no stockItemId
      // would throw here and fail the whole assign action. This route reads
      // the customer unpopulated, so today the id is always the raw ObjectId
      // and present — but that is a property of this one query, not of the
      // data, and it is one `.populate()` away from being false.
      const existingIds = new Set(
        (customer.assignedStockItems || []).map((a) => (a?.stockItemId ? String(a.stockItemId) : null)).filter(Boolean),
      );
      const toAdd = newAssignments.filter(
        (a) => a?.stockItemId && !existingIds.has(String(a.stockItemId)),
      );
      customer.assignedStockItems.push(...toAdd);
    }

    await customer.save();

    res.json({
      success: true,
      message: `${customer.assignedStockItems.length} item(s) assigned`,
      assignedCount: customer.assignedStockItems.length,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── DELETE /api/cms/sales/customers/:id/assign-items/:itemId ────────────────
router.delete("/:id/assign-items/:itemId", salesAuth, async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);
    if (!customer)
      return res
        .status(404)
        .json({ success: false, message: "Customer not found" });

    customer.assignedStockItems = customer.assignedStockItems.filter(
      (a) =>
        a._id.toString() !== req.params.itemId &&
        a.stockItemId.toString() !== req.params.itemId,
    );
    await customer.save();

    res.json({ success: true, message: "Item removed from customer" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/cms/sales/customers/:id/create-request ────────────────────────
// Sales creates a bulk request ON BEHALF of a customer.
// Same payload as /api/customer/requests but authenticated by sales JWT.
router.post("/:id/create-request", salesAuth, async (req, res) => {
  try {
    const CustomerRequest = require("../../../models/Customer_Models/CustomerRequest");
    const StockItem = require("../../../models/CMS_Models/Inventory/Products/StockItem");
    const customer = await Customer.findById(req.params.id)
      .select("name email phone profile customerId")
      .lean();
    if (!customer)
      return res
        .status(404)
        .json({ success: false, message: "Customer not found" });

    const { customerInfo = {}, items = [] } = req.body;
    if (!items.length)
      return res
        .status(400)
        .json({ success: false, message: "At least one item is required" });

    const validatedItems = [];
    for (const item of items) {
      const stockItem = await StockItem.findById(item.stockItemId)
        .select("name reference baseSalesPrice variants")
        .lean();
      if (!stockItem) continue;

      const validatedVariants = [];
      let totalQuantity = 0;
      for (const variant of item.variants || []) {
        const qty = Number(variant.quantity) || 0;
        if (qty <= 0) continue;
        // The slider's own cart never carries a variantId through to submit
        // — it only ever sent { attributes, quantity } (26 Aug 2026,
        // explicit report: "product pricing is showing as 0"). Falling back
        // to matching by attributes is what makes pricing work at all for
        // every request this route has ever created; matching by id stays
        // the first attempt for whenever the frontend does start sending one.
        let matchedVariant = variant.variantId
          ? (stockItem.variants || []).find((v) => v._id.toString() === variant.variantId)
          : null;
        if (!matchedVariant && Array.isArray(variant.attributes) && variant.attributes.length) {
          matchedVariant = (stockItem.variants || []).find((v) =>
            (v.attributes || []).length === variant.attributes.length &&
            (v.attributes || []).every((va) =>
              variant.attributes.some((a) => a.name === va.name && a.value === va.value),
            ),
          );
        }
        // `variantSchema` (models/CMS_Models/Inventory/Products/StockItem.js)
        // names this field `salesPrice`, not `price` — there is no `price`
        // field on a variant at all, so this always fell through to
        // `baseSalesPrice` (often unset for these products) and then to 0.
        const unitPrice =
          matchedVariant?.salesPrice || stockItem.baseSalesPrice || 0;
        totalQuantity += qty;
        validatedVariants.push({
          variantId: matchedVariant?._id || variant.variantId || null,
          attributes: variant.attributes || [],
          quantity: qty,
          specialInstructions: (variant.specialInstructions || []).filter(
            Boolean,
          ),
          estimatedPrice: unitPrice * qty,
        });
      }
      if (!validatedVariants.length) continue;
      validatedItems.push({
        stockItemId: stockItem._id,
        stockItemName: stockItem.name,
        stockItemReference: stockItem.reference,
        variants: validatedVariants,
        totalQuantity,
        totalEstimatedPrice: validatedVariants.reduce(
          (s, v) => s + v.estimatedPrice,
          0,
        ),
      });
    }

    if (!validatedItems.length)
      return res
        .status(400)
        .json({ success: false, message: "No valid items in request" });

    const requestId = await nextRequestId(CustomerRequest);

    const newRequest = new CustomerRequest({
      requestId,
      customerId: customer._id,
      customerInfo: {
        name: customerInfo.name || customer.name,
        email: customerInfo.email || customer.email,
        phone: customerInfo.phone || customer.phone,
        address:
          customerInfo.address || customer.profile?.address?.street || "",
        city: customerInfo.city || customer.profile?.address?.city || "",
        postalCode:
          customerInfo.postalCode || customer.profile?.address?.pincode || "",
        description: customerInfo.description || "",
        deliveryDeadline: customerInfo.deliveryDeadline || null,
        preferredContactMethod: customerInfo.preferredContactMethod || "phone",
      },
      items: validatedItems,
      status: "pending",
      priority: customerInfo.priority || "medium",
      createdBySales: true,
      createdBySalesId: req.user?.id,
      createdAt: new Date(),
    });
    await newRequest.save();

    res.status(201).json({
      success: true,
      message: "Request created on behalf of customer",
      requestId: newRequest.requestId,
      _id: newRequest._id,
    });
  } catch (err) {
    console.error("[salesCustomers] create-request", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
