// routes/CMS_Routes/Inventory/Operations/requisitionRoutes.js
// Mount: app.use("/api/cms/inventory/requisitions", requisitionRoutes)
//
// Store-raised requisition forms. The PDF is generated client-side from this
// record, so history can re-download an identical document later.

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Requisition = require("../../../../models/CMS_Models/Inventory/Operations/Requisition");
const Employee = require("../../../../models/Employee");
const MRF = require("../../../../models/CMS_Models/Inventory/Operations/MRF");
// READ-ONLY LEGACY fallback — see the write-back block in POST / below.
const RawItemAddRequest = require("../../../../models/CMS_Models/Inventory/Operations/RawItemAddRequest");
const EmployeeAuth = require("../../../../Middlewear/EmployeeAuthMiddlewear");

router.use(EmployeeAuth);

const getActorId = (req) => req.user?._id || req.user?.id || null;
const actorName = (req) =>
  req.user?.name ||
  [req.user?.firstName, req.user?.lastName].filter(Boolean).join(" ") ||
  "Store";

/**
 * Keep only what the form defines, and enforce the three mandatory fields.
 * Optional fields normalise to "" / null rather than 0 — a blank price must
 * print as a fillable space, not as "Rs 0.00".
 */
function cleanItems(items) {
  if (!Array.isArray(items)) return { items: [], error: "items must be an array" };

  const out = [];
  for (let i = 0; i < items.length; i++) {
    const raw = items[i] || {};
    const name = String(raw.name || "").trim();
    const unit = String(raw.unit || "").trim();
    const qty = raw.quantity === "" || raw.quantity === null || raw.quantity === undefined
      ? NaN
      : Number(raw.quantity);

    // Skip fully-blank trailing rows the UI may send.
    if (!name && !unit && !Number.isFinite(qty)) continue;

    const row = i + 1;
    if (!name) return { items: [], error: `Row ${row}: item name is required` };
    if (!Number.isFinite(qty) || qty <= 0) return { items: [], error: `Row ${row}: enter a quantity greater than zero` };
    if (!unit) return { items: [], error: `Row ${row}: unit is required` };

    const priceRaw = raw.price;
    const price =
      priceRaw === "" || priceRaw === null || priceRaw === undefined || Number.isNaN(Number(priceRaw))
        ? null
        : Number(priceRaw);
    if (price !== null && price < 0) return { items: [], error: `Row ${row}: price cannot be negative` };

    out.push({
      name,
      quantity: qty,
      unit,
      vendorName: String(raw.vendorName || "").trim(),
      price,
      notes: String(raw.notes || "").trim(),
      productId: mongoose.Types.ObjectId.isValid(raw.productId) ? raw.productId : null,
    });
  }

  if (!out.length) return { items: [], error: "Add at least one item" };
  return { items: out, error: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /data/employees — the HR staff list, for the "Requested By" dropdown.
//
// Registered BEFORE "/:id" so Express does not read "data" as a requisition id.
// Returns everyone active, sorted by name, so the field can be a plain dropdown
// rather than forcing the store person to guess a search term.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/data/employees", async (req, res) => {
  try {
    const employees = await Employee.find({ isActive: { $ne: false } })
      .select("firstName middleName lastName name biometricId identityId department designation")
      .sort({ firstName: 1, lastName: 1 })
      .limit(1000)
      .lean();

    const mapped = employees
      .map(e => ({
        _id: e._id,
        name: [e.firstName, e.middleName, e.lastName].filter(Boolean).join(" ").trim() || e.name || "",
        biometricId: e.biometricId || e.identityId || "",
        department: e.department || "",
        designation: e.designation || "",
      }))
      // An employee with no usable name would render as a blank option.
      .filter(e => e.name)
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({ success: true, employees: mapped });
  } catch (e) {
    console.error("[Requisition employees]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET / — history ─────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const { status, search = "", page = 1, limit = 50 } = req.query;

    const filter = {};
    if (status && status !== "ALL") filter.status = status;
    if (search) {
      filter.$or = [
        { requisitionNumber: { $regex: search, $options: "i" } },
        { "items.name": { $regex: search, $options: "i" } },
        { "items.vendorName": { $regex: search, $options: "i" } },
        { reason: { $regex: search, $options: "i" } },
        { createdByName: { $regex: search, $options: "i" } },
      ];
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const perPage = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

    const [total, requisitions] = await Promise.all([
      Requisition.countDocuments(filter),
      Requisition.find(filter)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * perPage)
        .limit(perPage)
        .lean({ virtuals: true }),
    ]);

    res.json({
      success: true,
      requisitions,
      pagination: {
        total, page: pageNum, limit: perPage,
        totalPages: Math.max(1, Math.ceil(total / perPage)),
      },
    });
  } catch (e) {
    console.error("[Requisition GET /]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /:id ────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const requisition = await Requisition.findById(req.params.id).lean({ virtuals: true });
    if (!requisition) return res.status(404).json({ success: false, message: "Requisition not found" });
    res.json({ success: true, requisition });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── POST / — create ─────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const {
      items, department, requiredBy, reason, notes, priority,
      requestedByEmployee, requestedByName, requestedById,
      pettyCashAmount, pettyCashGivenTo, pettyCashGivenToEmployee, pettyCashNote,
      sourceMrfId, sourceMrfNumber,
    } = req.body;

    const { items: cleaned, error } = cleanItems(items);
    if (error) return res.status(400).json({ success: false, message: error });

    // Resolve the picked employee against HR rather than trusting the name the
    // client sent — the printed form is an official document, so the name and
    // badge on it should come from the HR record.
    let resolved = null;
    if (requestedByEmployee) {
      resolved = await Employee.findById(requestedByEmployee)
        .select("firstName middleName lastName name biometricId identityId department")
        .lean();
    }
    const resolvedName = resolved
      ? ([resolved.firstName, resolved.middleName, resolved.lastName].filter(Boolean).join(" ").trim() || resolved.name || "")
      : String(requestedByName || "").trim();

    if (pettyCashAmount !== "" && pettyCashAmount !== null && pettyCashAmount !== undefined &&
      Number(pettyCashAmount) < 0) {
      return res.status(400).json({ success: false, message: "Petty cash amount cannot be negative" });
    }

    // Petty cash can go to anyone — a driver, a contractor, someone with no HR
    // record at all — so the name is accepted as free text. When the client did
    // match it to an employee, the HR spelling wins so the printed cash record
    // names them as HR knows them; otherwise the typed name is kept verbatim.
    let cashPerson = null;
    if (pettyCashGivenToEmployee) {
      cashPerson = await Employee.findById(pettyCashGivenToEmployee)
        .select("firstName middleName lastName name").lean();
    }
    const cashPersonName = cashPerson
      ? ([cashPerson.firstName, cashPerson.middleName, cashPerson.lastName].filter(Boolean).join(" ").trim() || cashPerson.name || "")
      : String(pettyCashGivenTo || "").trim();

    const requisition = new Requisition({
      items: cleaned,
      requestedByEmployee: resolved?._id || null,
      requestedByName: resolvedName,
      requestedById: resolved
        ? (resolved.biometricId || resolved.identityId || "")
        : String(requestedById || "").trim(),
      // Fall back to the employee's HR department when none was typed.
      department: String(department || "").trim() || resolved?.department || "",
      requiredBy: requiredBy ? new Date(requiredBy) : null,
      reason: String(reason || "").trim(),
      notes: String(notes || "").trim(),
      priority: ["LOW", "NORMAL", "HIGH", "URGENT"].includes(priority) ? priority : "NORMAL",
      // Blank stays null, not 0 — "no cash handed over" and "zero rupees
      // handed over" print differently on the form.
      pettyCashAmount:
        pettyCashAmount === "" || pettyCashAmount === null || pettyCashAmount === undefined ||
          Number.isNaN(Number(pettyCashAmount))
          ? null
          : Number(pettyCashAmount),
      pettyCashGivenTo: cashPersonName,
      pettyCashGivenToEmployee: cashPerson?._id || null,
      pettyCashNote: String(pettyCashNote || "").trim(),
      status: "SUBMITTED",
      createdByRef: getActorId(req),
      createdByName: actorName(req),
      sourceMrfId: mongoose.Types.ObjectId.isValid(sourceMrfId) ? sourceMrfId : null,
      sourceMrfNumber: String(sourceMrfNumber || "").trim(),
    });

    await requisition.save();

    // Mark the specific item(s) this was raised for so the Store screen shows
    // "Purchase Form Raised" instead of offering the same buttons again with
    // no memory of it. Best-effort — the requisition itself is already saved
    // and is the record that matters; a failure here must not undo it.
    //
    // `sourceMrfId`/`productId` point at an MRF item going forward; tried
    // first. RawItemAddRequest is a read-only-legacy fallback for anything
    // raised against a pre-cutover product request that's still open.
    const productIds = cleaned.map(it => it.productId).filter(Boolean);
    if (mongoose.Types.ObjectId.isValid(sourceMrfId) && productIds.length) {
      try {
        const mrf = await MRF.findById(sourceMrfId);
        if (mrf) {
          let touched = false;
          for (const pid of productIds) {
            const item = mrf.items.id(pid);
            if (!item) continue;
            item.purchaseFormRaised = true;
            item.purchaseRequisitionId = requisition._id;
            item.purchaseRequisitionNumber = requisition.requisitionNumber;
            item.purchaseFormRaisedAt = new Date();
            touched = true;
          }
          if (touched) await mrf.save();
        } else {
          const prDoc = await RawItemAddRequest.findById(sourceMrfId);
          if (prDoc) {
            let touched = false;
            for (const pid of productIds) {
              const product = prDoc.products.id(pid);
              if (!product) continue;
              product.purchaseFormRaised = true;
              product.purchaseRequisitionId = requisition._id;
              product.purchaseRequisitionNumber = requisition.requisitionNumber;
              product.purchaseFormRaisedAt = new Date();
              touched = true;
            }
            if (touched) await prDoc.save();
          }
        }
      } catch (e) {
        console.error("[Requisition POST /] failed to flag product request", e);
      }
    }

    res.status(201).json({
      success: true,
      message: `${requisition.requisitionNumber} created`,
      requisition: requisition.toObject({ virtuals: true }),
    });
  } catch (e) {
    console.error("[Requisition POST /]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── PATCH /:id — edit an already-raised purchase form ────────────────────────
// Same field set and validation as create. Number/source/creator stay fixed —
// this corrects what was raised, it does not re-raise it under a new identity.
router.patch("/:id", async (req, res) => {
  try {
    const requisition = await Requisition.findById(req.params.id);
    if (!requisition) return res.status(404).json({ success: false, message: "Requisition not found" });
    if (["CONVERTED", "CANCELLED"].includes(requisition.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot edit — this purchase form is already ${requisition.status.toLowerCase()}.`,
      });
    }

    const {
      items, department, requiredBy, reason, notes, priority,
      requestedByEmployee, requestedByName, requestedById,
      pettyCashAmount, pettyCashGivenTo, pettyCashGivenToEmployee, pettyCashNote,
    } = req.body;

    const { items: cleaned, error } = cleanItems(items);
    if (error) return res.status(400).json({ success: false, message: error });

    let resolved = null;
    if (requestedByEmployee) {
      resolved = await Employee.findById(requestedByEmployee)
        .select("firstName middleName lastName name biometricId identityId department")
        .lean();
    }
    const resolvedName = resolved
      ? ([resolved.firstName, resolved.middleName, resolved.lastName].filter(Boolean).join(" ").trim() || resolved.name || "")
      : String(requestedByName || "").trim();

    if (pettyCashAmount !== "" && pettyCashAmount !== null && pettyCashAmount !== undefined &&
      Number(pettyCashAmount) < 0) {
      return res.status(400).json({ success: false, message: "Petty cash amount cannot be negative" });
    }

    let cashPerson = null;
    if (pettyCashGivenToEmployee) {
      cashPerson = await Employee.findById(pettyCashGivenToEmployee)
        .select("firstName middleName lastName name").lean();
    }
    const cashPersonName = cashPerson
      ? ([cashPerson.firstName, cashPerson.middleName, cashPerson.lastName].filter(Boolean).join(" ").trim() || cashPerson.name || "")
      : String(pettyCashGivenTo || "").trim();

    requisition.items = cleaned;
    requisition.requestedByEmployee = resolved?._id || null;
    requisition.requestedByName = resolvedName;
    requisition.requestedById = resolved
      ? (resolved.biometricId || resolved.identityId || "")
      : String(requestedById || "").trim();
    requisition.department = String(department || "").trim() || resolved?.department || "";
    requisition.requiredBy = requiredBy ? new Date(requiredBy) : null;
    requisition.reason = String(reason || "").trim();
    requisition.notes = String(notes || "").trim();
    requisition.priority = ["LOW", "NORMAL", "HIGH", "URGENT"].includes(priority) ? priority : "NORMAL";
    requisition.pettyCashAmount =
      pettyCashAmount === "" || pettyCashAmount === null || pettyCashAmount === undefined ||
        Number.isNaN(Number(pettyCashAmount))
        ? null
        : Number(pettyCashAmount);
    requisition.pettyCashGivenTo = cashPersonName;
    requisition.pettyCashGivenToEmployee = cashPerson?._id || null;
    requisition.pettyCashNote = String(pettyCashNote || "").trim();

    await requisition.save();

    res.json({
      success: true,
      message: `${requisition.requisitionNumber} updated`,
      requisition: requisition.toObject({ virtuals: true }),
    });
  } catch (e) {
    console.error("[Requisition PATCH /:id]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── PATCH /:id/status ───────────────────────────────────────────────────────
router.patch("/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    if (!["DRAFT", "SUBMITTED", "CONVERTED", "CANCELLED"].includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status" });
    }
    const requisition = await Requisition.findById(req.params.id);
    if (!requisition) return res.status(404).json({ success: false, message: "Requisition not found" });

    requisition.status = status;
    await requisition.save();
    res.json({ success: true, message: `Marked ${status.toLowerCase()}`, requisition });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
