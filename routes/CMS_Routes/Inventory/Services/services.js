// routes/CMS_Routes/Inventory/Services/services.js
//
// THE SERVICE MASTER — Store & Purchase.
//
// Services are bought, classified and budgeted like materials and behave
// nothing like them afterwards. See the model for why this is a separate
// master rather than a flag on `RawItem`.
//
// Everything here follows the conventions the Item, Unit and Supplier masters
// already use: `EmployeeAuth`, then `requireTenant`, then the SAME capability
// the other masters are maintained under. No new permission architecture: a
// person who maintains the item catalogue maintains this one.

const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const Service = require("../../../../models/CMS_Models/Inventory/Services/Service");
const Vendor = require("../../../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const itemBudgetHead = require("../../../../services/itemBudgetHead.service");
const budgetClassification = require("../../../../services/budgetClassification.service");
const { Acc_Ledger } = require("../../../../models/Accountant_model/Acc_MasterModels");

const EmployeeAuth = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const {
  requireTenant, requireCapability, refuseLegacyWrite,
} = require("../../../../Middlewear/storePurchaseTenant");
const { CAPABILITIES } = require("../../../../services/storePurchase/capabilities");
const tenantContext = require("../../../../services/storePurchase/tenantContext.service");
const { sendError } = require("../../../../services/storePurchase/errors");
const documentSequence = require("../../../../services/storePurchase/documentSequence.service");

router.use(EmployeeAuth);
router.use(requireTenant);

const canRead = requireCapability(CAPABILITIES.READ);
/* The same authority that maintains items and suppliers. */
const canMaintain = [requireCapability(CAPABILITIES.MASTER_MAINTAIN), refuseLegacyWrite];

/** Every service query is company-scoped. Another company's is missing. */
const scoped = (req, extra = {}) => ({ ...tenantContext.tenantFilter(req.tenant), ...extra });

/** A name typed by a person is text, not a pattern. */
const escapeRegex = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const CODES = {
  NOT_FOUND: "SERVICE_NOT_FOUND",
  NAME_DUPLICATE: "SERVICE_NAME_DUPLICATE",
  FIELD_INVALID: "SERVICE_FIELD_INVALID",
  VENDOR_INVALID: "SERVICE_SUPPLIER_INVALID",
  LEDGER_INVALID: "SERVICE_BUDGET_HEAD_INVALID",
  INACTIVE: "SERVICE_INACTIVE",
};

const refuse = (res, status, code, message, extra = {}) =>
  res.status(status).json({ success: false, code, message, ...extra });

/* ── WHAT GOES OUT ──────────────────────────────────────────────────────────
 * An allowlist, named field by field. The Supplier Master learned this the
 * hard way: a DTO that copies the document and deletes a key ships every field
 * somebody adds later, with no review. */
function publicService(d) {
  const doc = d?.toObject ? d.toObject() : (d || {});
  return {
    _id: doc._id,
    serviceCode: doc.serviceCode || "",
    name: doc.name || "",
    category: doc.category || "",
    description: doc.description || "",
    billingUnit: doc.billingUnit || "",
    sacCode: doc.sacCode || "",
    /* `null` and `0` are different answers: nobody has estimated a rate
       versus somebody recorded that it is free. */
    defaultGstRate: doc.defaultGstRate ?? null,
    defaultRate: doc.defaultRate ?? null,
    preferredVendorId: doc.preferredVendorId || null,
    preferredVendorName: doc.preferredVendorName || "",
    budgetLedgerId: doc.budgetLedgerId || null,
    budgetLedgerName: doc.budgetLedgerName || "",
    leadTimeDays: doc.leadTimeDays ?? null,
    recurring: {
      frequency: doc.recurring?.frequency || "NONE",
      noticeDays: doc.recurring?.noticeDays ?? null,
    },
    status: doc.status || "ACTIVE",
    /* Stated so a caller never has to infer it from `status`. */
    selectable: doc.status === "ACTIVE",
    createdByName: doc.createdByName || "",
    updatedByName: doc.updatedByName || "",
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

const LIMITS = { name: 200, category: 120, description: 5000, billingUnit: 60, sac: 20 };

function boundedText(value, max, field) {
  if (value === undefined) return { ok: true, skip: true };
  if (value === null) return { ok: true, value: "" };
  if (typeof value !== "string") return { ok: false, field, message: `${field} must be text.` };
  const text = value.trim();
  if (text.length > max) return { ok: false, field, message: `${field} is longer than ${max} characters.` };
  return { ok: true, value: text };
}

/** A number a caller may omit, but may not send nonsense for. */
function optionalNumber(raw, { field, min = 0, max = Number.MAX_SAFE_INTEGER }) {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: null };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { ok: false, field, message: `${field} must be a number.` };
  if (n < min || n > max) return { ok: false, field, message: `${field} must be between ${min} and ${max}.` };
  return { ok: true, value: n };
}

function validateBody(body, { requireName }) {
  const text = [
    ["name", LIMITS.name], ["category", LIMITS.category],
    ["description", LIMITS.description], ["billingUnit", LIMITS.billingUnit],
    ["sacCode", LIMITS.sac],
  ];
  for (const [field, max] of text) {
    const r = boundedText(body?.[field], max, field);
    if (!r.ok) return r;
  }
  if (requireName && !String(body?.name || "").trim()) {
    return { ok: false, field: "name", message: "A service name is required." };
  }
  if (body?.name !== undefined && !String(body.name || "").trim()) {
    return { ok: false, field: "name", message: "A service name is required." };
  }

  /* GST is a percentage. Anything outside 0–100 is a typo, not a rate. */
  const gst = optionalNumber(body?.defaultGstRate, { field: "defaultGstRate", min: 0, max: 100 });
  if (!gst.ok) return gst;

  const rate = optionalNumber(body?.defaultRate, { field: "defaultRate" });
  if (!rate.ok) return rate;

  const lead = optionalNumber(body?.leadTimeDays, { field: "leadTimeDays", max: 3650 });
  if (!lead.ok) return lead;

  const notice = optionalNumber(body?.recurring?.noticeDays, { field: "recurring.noticeDays", max: 3650 });
  if (!notice.ok) return notice;

  const freq = body?.recurring?.frequency;
  if (freq !== undefined && freq !== null
    && !Service.RECURRING_FREQUENCIES.includes(String(freq))) {
    return { ok: false, field: "recurring.frequency", message: "That recurring term is not one this system records." };
  }

  return { ok: true, gst: gst.value, rate: rate.value, lead: lead.value, notice: notice.value };
}

/**
 * The supplier and budget head a caller named — checked inside this company.
 *
 * ── ON THE LEDGER CHECK ─────────────────────────────────────────────────────
 * Delegated to `itemBudgetHead.assertMappable`, which is the same gate the
 * Finance item-category mapping and the Finance service-defaults screen use.
 * It answers three separate questions — does the head exist, is it THIS
 * company's, and is it a spending budget under `budgetClassification` — and
 * honours a classification Finance has set by hand.
 *
 * One honest limit remains: "is this the RIGHT budget head for this service"
 * is a judgement no field on the ledger answers, and nothing here pretends to.
 */
async function resolveReferences(req, body) {
  const out = { vendor: undefined, ledger: undefined };

  if (body?.preferredVendorId !== undefined) {
    const id = body.preferredVendorId;
    if (id === null || id === "") {
      out.vendor = null;
    } else {
      if (!mongoose.Types.ObjectId.isValid(String(id))) {
        return { ok: false, code: CODES.VENDOR_INVALID, message: "That supplier reference is not valid." };
      }
      /* `$and`, not a spread. `tenantFilter` returns a `companyId` key, and a
         second `companyId` key in the same object REPLACES it — which silently
         turns "this company's suppliers" into "everyone's". */
      const vendor = await Vendor.findOne({
        $and: [tenantContext.tenantFilter(req.tenant), { companyId: { $ne: null } }],
        _id: id,
      }).select("_id companyName status").lean();
      if (!vendor) {
        /* Another company's supplier answers exactly as an invented id. */
        return { ok: false, code: CODES.VENDOR_INVALID, message: "That supplier was not found in this company." };
      }
      out.vendor = vendor;
    }
  }

  if (body?.budgetLedgerId !== undefined) {
    const id = body.budgetLedgerId;
    if (id === null || id === "") {
      out.ledger = null;
    } else {
      if (!mongoose.Types.ObjectId.isValid(String(id))) {
        return { ok: false, code: CODES.LEDGER_INVALID, message: "That budget head reference is not valid." };
      }
      /* ── ONE AUTHORITY ON WHAT IS A BUDGET HEAD ───────────────────────
         This asked `ledger.nature === "expense"` directly, which is NOT the
         rule Finance uses. `budgetClassification` refuses expense-natured
         heads that nobody budgets — Round Off, Suspense, Opening Stock — and
         honours a `budgetControl` value Finance has set by hand. Measured
         against real chart shapes, the two disagreed on four heads out of
         five, all in the permissive direction: the Store could point a
         service at a head Finance's own screen would refuse, and Finance's
         budget-defaults screen would then display it as that service's
         classification.

         So the gate is now the same call the item-category mapping and the
         Finance service screen both make. Same contract, one answer. */
      const check = await itemBudgetHead.assertMappable(id, req.tenant.companyId, {
        subject: "a service",
      });
      if (!check.ok) {
        return { ok: false, code: CODES.LEDGER_INVALID, message: check.message };
      }
      out.ledger = check.ledger;
    }
  }

  return { ok: true, ...out };
}

/**
 * The next service code for this company.
 *
 * Delegated to the shared sequence, which increments in the DATABASE. The
 * obvious alternative — sort the collection, read the last code, add one —
 * mints the same code twice the moment two people register a service at once.
 */
async function nextServiceCode(req) {
  const { number } = await documentSequence.allocate({
    companyId: req.tenant.companyId,
    documentType: "SERVICE",
  });
  return number;
}

/* ── OPTIONS FOR THE FORM ───────────────────────────────────────────────────
 * Only what the form needs, company-scoped. Returning whole supplier or ledger
 * documents to fill two dropdowns would ship bank details and balances into a
 * screen that needs a name and an id. */
router.get("/options", canRead, async (req, res) => {
  try {
    const [suppliers, ledgers] = await Promise.all([
      Vendor.find({
        $and: [tenantContext.tenantFilter(req.tenant), { companyId: { $ne: null } }],
        status: "Active",
      }).select("_id companyName supplierCode").sort({ companyName: 1 }).lean(),
      /* `groupName` and `budgetControl` are selected because the
         classification reads them. Filtering on `nature: "expense"` alone
         offered heads the save would then REFUSE — a picker that lists a
         choice the form rejects is worse than one that lists nothing. */
      Acc_Ledger.find({ companyId: req.tenant.companyId })
        .select("_id name groupName nature budgetControl").sort({ name: 1 }).lean(),
    ]);

    /* The same contract the save enforces, applied to the offer. */
    const budgetHeads = ledgers.filter((l) => budgetClassification.isExpenseBudget({
      budgetControl: l.budgetControl, name: l.name, groupName: l.groupName, nature: l.nature,
    }));

    res.json({
      success: true,
      suppliers: suppliers.map((s) => ({ id: s._id, name: s.companyName, code: s.supplierCode || "" })),
      budgetHeads: budgetHeads.map((l) => ({ id: l._id, name: l.name, group: l.groupName || "" })),
      billingUnitSuggestions: [
        "Per month", "Per visit", "Per trip", "Per licence", "Per hour", "Per job", "Lump sum",
      ],
      recurringFrequencies: Service.RECURRING_FREQUENCIES,
    });
  } catch (error) {
    console.error("Error loading service options:", error);
    res.status(500).json({ success: false, message: "Server error while loading options" });
  }
});

/* ── THE REGISTER ───────────────────────────────────────────────────────── */
router.get("/", canRead, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));

    const filter = scoped(req);
    const status = String(req.query.status || "").toUpperCase();
    if (status === "ACTIVE" || status === "INACTIVE") filter.status = status;

    const search = String(req.query.search || "").trim();
    if (search) {
      const re = new RegExp(escapeRegex(search), "i");
      filter.$and = [{ $or: [
        { serviceCode: re }, { name: re }, { category: re },
        { sacCode: re }, { preferredVendorName: re }, { budgetLedgerName: re },
      ] }];
    }

    const [rows, total, activeCount] = await Promise.all([
      Service.find(filter).sort({ name: 1, _id: 1 })
        .skip((page - 1) * limit).limit(limit).lean(),
      Service.countDocuments(filter),
      Service.countDocuments({ ...scoped(req), status: "ACTIVE" }),
    ]);

    res.json({
      success: true,
      services: rows.map(publicService),
      pagination: {
        page, limit, total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        hasNextPage: page * limit < total,
        hasPrevPage: page > 1,
      },
      /* Counted over the company, not the page. */
      stats: { total: await Service.countDocuments(scoped(req)), active: activeCount },
    });
  } catch (error) {
    console.error("Error listing services:", error);
    res.status(500).json({ success: false, message: "Server error while listing services" });
  }
});

/** A service, whatever its status: history must stay readable. */
router.get("/:id", canRead, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return refuse(res, 404, CODES.NOT_FOUND, "Service not found.");
    }
    const service = await Service.findOne(scoped(req, { _id: req.params.id }));
    if (!service) return refuse(res, 404, CODES.NOT_FOUND, "Service not found.");
    res.json({ success: true, service: publicService(service) });
  } catch (error) {
    console.error("Error reading service:", error);
    res.status(500).json({ success: false, message: "Server error while reading the service" });
  }
});

router.post("/", ...canMaintain, async (req, res) => {
  try {
    /* Ownership, the generated code and the audit actors are server-owned.
       A body that names them is refused rather than quietly ignored. */
    try {
      tenantContext.assertNoForeignCompany(req.tenant, req.body);
    } catch (err) { return sendError(res, err); }

    for (const field of ["serviceCode", "createdBy", "createdByName", "updatedBy", "updatedByName", "companyId", "siteId"]) {
      if (req.body?.[field] !== undefined) {
        return refuse(res, 400, CODES.FIELD_INVALID,
          `${field} is set by the server and cannot be supplied.`, { field });
      }
    }

    const shape = validateBody(req.body, { requireName: true });
    if (!shape.ok) return refuse(res, 400, CODES.FIELD_INVALID, shape.message, { field: shape.field });

    const name = String(req.body.name).trim();
    const normalised = name.replace(/\s+/g, " ").toLowerCase();
    const clash = await Service.findOne(scoped(req, { nameNormalised: normalised })).select("_id").lean();
    if (clash) {
      return refuse(res, 409, CODES.NAME_DUPLICATE,
        `A service called "${name}" already exists in this company.`);
    }

    const refs = await resolveReferences(req, req.body);
    if (!refs.ok) return refuse(res, 400, refs.code, refs.message);

    const actorName = req.user?.name || req.user?.email || "";
    const service = new Service({
      ...tenantContext.stamp(req.tenant),
      serviceCode: await nextServiceCode(req),
      name,
      category: (req.body.category || "").trim(),
      description: (req.body.description || "").trim(),
      billingUnit: (req.body.billingUnit || "").trim(),
      sacCode: (req.body.sacCode || "").trim(),
      defaultGstRate: shape.gst,
      defaultRate: shape.rate,
      leadTimeDays: shape.lead,
      preferredVendorId: refs.vendor?._id || null,
      preferredVendorName: refs.vendor?.companyName || "",
      budgetLedgerId: refs.ledger?._id || null,
      budgetLedgerName: refs.ledger?.name || "",
      recurring: {
        frequency: req.body?.recurring?.frequency || "NONE",
        noticeDays: shape.notice,
      },
      status: "ACTIVE",
      createdBy: req.user?.id || null,
      createdByName: actorName,
    });

    await service.save();
    res.status(201).json({ success: true, message: "Service registered", service: publicService(service) });
  } catch (error) {
    if (error?.code === 11000) {
      return refuse(res, 409, CODES.NAME_DUPLICATE,
        "That service name or code is already used in this company.");
    }
    console.error("Error creating service:", error);
    res.status(500).json({ success: false, message: "Server error while creating the service" });
  }
});

router.patch("/:id", ...canMaintain, async (req, res) => {
  try {
    try {
      tenantContext.assertNoForeignCompany(req.tenant, req.body);
    } catch (err) { return sendError(res, err); }

    for (const field of ["serviceCode", "createdBy", "createdByName", "companyId", "siteId", "status"]) {
      if (req.body?.[field] !== undefined) {
        return refuse(res, 400, CODES.FIELD_INVALID,
          field === "status"
            /* Status moves through its own endpoint, which records who and when. */
            ? "A service's status is changed through PATCH /services/:id/status."
            : `${field} is set by the server and cannot be supplied.`,
          { field });
      }
    }

    const shape = validateBody(req.body, { requireName: false });
    if (!shape.ok) return refuse(res, 400, CODES.FIELD_INVALID, shape.message, { field: shape.field });

    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return refuse(res, 404, CODES.NOT_FOUND, "Service not found.");
    }
    const service = await Service.findOne(scoped(req, { _id: req.params.id }));
    if (!service) return refuse(res, 404, CODES.NOT_FOUND, "Service not found.");

    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      const normalised = name.replace(/\s+/g, " ").toLowerCase();
      if (normalised !== service.nameNormalised) {
        const clash = await Service.findOne(scoped(req, {
          nameNormalised: normalised, _id: { $ne: service._id },
        })).select("_id").lean();
        if (clash) {
          return refuse(res, 409, CODES.NAME_DUPLICATE,
            `A service called "${name}" already exists in this company.`);
        }
      }
      service.name = name;
    }

    const refs = await resolveReferences(req, req.body);
    if (!refs.ok) return refuse(res, 400, refs.code, refs.message);

    if (refs.vendor !== undefined) {
      service.preferredVendorId = refs.vendor?._id || null;
      service.preferredVendorName = refs.vendor?.companyName || "";
    }
    if (refs.ledger !== undefined) {
      service.budgetLedgerId = refs.ledger?._id || null;
      service.budgetLedgerName = refs.ledger?.name || "";
    }

    for (const f of ["category", "description", "billingUnit", "sacCode"]) {
      if (req.body[f] !== undefined) service[f] = (req.body[f] || "").toString().trim();
    }
    if (req.body.defaultGstRate !== undefined) service.defaultGstRate = shape.gst;
    if (req.body.defaultRate !== undefined) service.defaultRate = shape.rate;
    if (req.body.leadTimeDays !== undefined) service.leadTimeDays = shape.lead;
    if (req.body.recurring !== undefined) {
      service.recurring = {
        frequency: req.body.recurring?.frequency || "NONE",
        noticeDays: shape.notice,
      };
    }

    service.updatedBy = req.user?.id || null;
    service.updatedByName = req.user?.name || req.user?.email || "";
    await service.save();

    res.json({ success: true, message: "Service updated", service: publicService(service) });
  } catch (error) {
    if (error?.code === 11000) {
      return refuse(res, 409, CODES.NAME_DUPLICATE, "That service name is already used in this company.");
    }
    console.error("Error updating service:", error);
    res.status(500).json({ success: false, message: "Server error while updating the service" });
  }
});

/* ── ACTIVE OR NOT, INSTEAD OF DELETED ──────────────────────────────────────
 * Deleting a service that last year's requests name would make those records
 * unreadable. Inactivation stops it being offered for new work and leaves the
 * history intact. */
router.patch("/:id/status", ...canMaintain, async (req, res) => {
  try {
    const wanted = String(req.body?.status || "").toUpperCase();
    if (!["ACTIVE", "INACTIVE"].includes(wanted)) {
      return refuse(res, 400, CODES.FIELD_INVALID, "Status must be ACTIVE or INACTIVE.", { field: "status" });
    }
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return refuse(res, 404, CODES.NOT_FOUND, "Service not found.");
    }

    const service = await Service.findOne(scoped(req, { _id: req.params.id }));
    if (!service) return refuse(res, 404, CODES.NOT_FOUND, "Service not found.");

    if (service.status === wanted) {
      return res.json({
        success: true, unchanged: true,
        message: `Service is already ${wanted.toLowerCase()}.`,
        service: publicService(service),
      });
    }

    service.status = wanted;
    service.statusChangedAt = new Date();
    service.statusChangedByName = req.user?.name || req.user?.email || "";
    service.updatedBy = req.user?.id || null;
    service.updatedByName = service.statusChangedByName;
    await service.save();

    res.json({
      success: true,
      message: wanted === "ACTIVE" ? "Service reactivated" : "Service deactivated",
      service: publicService(service),
    });
  } catch (error) {
    console.error("Error changing service status:", error);
    res.status(500).json({ success: false, message: "Server error while changing the status" });
  }
});

module.exports = router;
