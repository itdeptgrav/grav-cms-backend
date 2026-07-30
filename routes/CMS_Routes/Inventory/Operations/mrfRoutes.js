// routes/CMS_Routes/Inventory/Operations/mrfRoutes.js
// Mount: app.use("/api/cms/inventory/mrf", mrfRoutes)

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const MRF = require("../../../../models/CMS_Models/Inventory/Operations/MRF");
const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const Unit = require("../../../../models/CMS_Models/Inventory/Configurations/Unit");
const Employee = require("../../../../models/Employee");
const EmployeeAuth = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const NotificationService = require("../../../../services/NotificationService");
const RawItemAddRequest = require("../../../../models/CMS_Models/Inventory/Operations/RawItemAddRequest");

const mrfNotify = require("../../../../services/mrfNotify.service");
const mrfChat = require("../../../../services/mrfChat.service");
const { buildContext } = require("../../../../services/mrfContext.service");
const mrfUnits = require("../../../../services/mrfUnits.service");

router.use(EmployeeAuth);

// ── Approval flow ─────────────────────────────────────────────────────────
// Employee → Primary Manager/TL (in cowork) → Store.
// The store no longer approves or rejects MRFs; by the time one appears here
// it has already been approved by the requester's TL, or auto-forwarded
// because no TL could be resolved. What the store owns is availability and
// issuance — see PATCH /:id/availability and POST /:id/unfulfilled.
const isStoreActionable = (mrf) =>
  mrf.tlApproved || mrf.autoForwarded || mrf.creationMode === "BYPASS" || mrf.pmApproved;

// ── helpers ───────────────────────────────────────────────────────────────────
function buildFullName(emp) {
  if (!emp) return "";
  return [emp.firstName, emp.middleName, emp.lastName]
    .filter(Boolean).join(" ").trim() || emp.email || emp.name || "";
}

// EmployeeAuthMiddleware sets req.user._id (ObjectId) on the store/PM side.
// On the cowork/employee side it may set req.user.id as a string.
// Always prefer _id for ObjectId fields.
function getActorId(req) {
  return req.user._id || req.user.id;
}

// Unit handling is centralised in mrfUnits.service: the requester's chosen
// unit is authoritative for every displayed and entered quantity, and
// conversion to the catalogue base unit happens only where stock is touched.
const convertQty = mrfUnits.convertQty;

async function adjustStock(rawItemId, variantId, variantCombination, delta, txnMeta) {
  const raw = await RawItem.findById(rawItemId);
  if (!raw) throw new Error(`RawItem ${rawItemId} not found`);
  const prevQty = raw.quantity || 0;

  let matchedVariant = null;
  if (variantId && raw.variants?.length) matchedVariant = raw.variants.id(variantId);
  if (!matchedVariant && variantCombination?.length && raw.variants?.length) {
    matchedVariant = raw.variants.find(v =>
      v.combination?.length === variantCombination.length &&
      v.combination.every((val, i) => val === variantCombination[i])
    );
  }
  if (matchedVariant) {
    matchedVariant.quantity = Math.max(0, (matchedVariant.quantity || 0) + delta);
    matchedVariant.status =
      matchedVariant.quantity === 0 ? "Out of Stock" :
        matchedVariant.quantity <= (matchedVariant.minStock || raw.minStock || 0) ? "Low Stock" : "In Stock";
  }

  raw.quantity = Math.max(0, prevQty + delta);
  raw.status =
    raw.quantity === 0 ? "Out of Stock" :
      raw.quantity <= (raw.minStock || 0) ? "Low Stock" : "In Stock";

  raw.stockTransactions.push({
    ...txnMeta,
    previousQuantity: prevQty,
    newQuantity: raw.quantity,
    ...(matchedVariant ? { variantId, variantCombination } : {}),
  });
  await raw.save();
}

const buildUnitConversions = mrfUnits.buildUnitConversions;

/** Actor label for audit entries and chat system messages. */
const actorName = (req) => req.user?.name || req.user?.firstName || "Store";

/**
 * May the Store act on this product request (match / register / reject)?
 *
 * Approved by the requester's TL, or auto-forwarded because no TL could be
 * resolved. The third case covers requests raised BEFORE TL approval existed:
 * `approvalStatus` defaults to PENDING_TL on those, so a store person who had
 * already started working one would suddenly find it frozen. If the store has
 * already actioned any product on it, that decision was clearly made under the
 * old rules and must stand.
 */
function prStoreActionable(doc) {
  if (!doc) return false;
  if (doc.approvalStatus === "TL_APPROVED") return true;
  if (doc.approvalStatus === "TL_REJECTED") return false;
  if (doc.autoForwarded) return true;
  return (doc.products || []).some(p => p.status && p.status !== "PENDING");
}

/** Guard for the store's mutating product-request routes. */
function requirePrApproved(doc, res) {
  if (prStoreActionable(doc)) return true;
  res.status(403).json({
    success: false,
    message: doc.approvalStatus === "TL_REJECTED"
      ? `This product request was rejected by ${doc.tlRejectedByName || "the requester's Primary Manager/TL"} — it cannot be actioned.`
      : `This product request is still awaiting approval from ${doc.approverName || "the requester's Primary Manager/TL"}. You can discuss it in the chat, but it cannot be matched or registered until they approve.`,
  });
  return false;
}

/**
 * An MRF spawned from a product request still needs the requester's TL to
 * approve the issue — the store only decided *which catalogue item* it is.
 * Returns the approver-routing patch plus the requester's biometric id.
 */
async function approverPatchFor(employeeId) {
  const mrfApprover = require("../../../../services/mrfApprover.service");
  const emp = await Employee.findById(employeeId)
    .select("_id firstName middleName lastName name biometricId identityId department primaryManager isActive status")
    .lean();
  if (!emp) {
    return {
      patch: {
        approverResolution: "MANAGER_NOT_FOUND",
        approvalRoute: "AUTO_STORE",
        autoForwarded: true,
        autoForwardReason: "Requester's HR record could not be read — sent directly to the Store.",
      },
      requestedForId: "",
    };
  }
  const patch = await mrfApprover.resolveApprover(emp);
  return { patch, requestedForId: emp.biometricId || emp.identityId || "" };
}

async function buildMrfItems(items) {
  const built = [];
  for (const it of items) {
    if (!it.rawItemId || !it.requestedQty || parseFloat(it.requestedQty) <= 0) continue;
    const raw = await RawItem.findById(it.rawItemId)
      .select("name sku unit customUnit").lean();
    if (!raw) continue;
    const baseUnit = raw.customUnit || raw.unit || "unit";
    built.push({
      rawItem: raw._id,
      rawItemName: raw.name,
      rawItemSku: raw.sku || "",
      variantId: it.variantId || null,
      variantCombination: it.variantCombination || [],
      description: String(it.description || "").trim().slice(0, 1000),
      specifications: String(it.specifications || "").trim().slice(0, 1000),
      images: Array.isArray(it.images)
        ? it.images
          .filter(im => im?.url && /^https?:\/\//i.test(im.url))
          .slice(0, 5)
          .map(im => ({ url: im.url, publicId: im.publicId || "", name: im.name || "" }))
        : [],
      requestedQty: parseFloat(it.requestedQty),
      // The unit the requester chose is authoritative for this line.
      unit: it.unit || baseUnit,
      baseUnit,
      itemStatus: "PENDING",
      availability: "UNREVIEWED",
    });
  }
  return built;
}

function markOverdue(mrfs) {
  const now = new Date();
  mrfs.forEach(mrf => {
    if (mrf.requestType === "TIME_BASED" && mrf.deadline && new Date(mrf.deadline) < now) {
      mrf.items.forEach(item => {
        if (item.itemStatus === "ISSUED") item.itemStatus = "OVERDUE";
      });
    }
  });
}

// ── GET /data/raw-items ───────────────────────────────────────────────────────
router.get("/data/raw-items", async (req, res) => {
  try {
    const { search = "" } = req.query;
    const filter = search
      ? { $or: [{ name: { $regex: search, $options: "i" } }, { sku: { $regex: search, $options: "i" } }] }
      : {};
    const items = await RawItem.find(filter)
      .select("name sku unit customUnit quantity variants")
      .sort({ name: 1 }).limit(50).lean();
    const unitMap = await buildUnitConversions();
    const formatted = items.map(item => {
      const baseUnit = item.customUnit || item.unit || "unit";
      return {
        _id: item._id, name: item.name, sku: item.sku, baseUnit,
        quantity: item.quantity || 0,
        conversions: unitMap[baseUnit] || [],
        variants: (item.variants || []).map(v => ({
          _id: v._id, combination: v.combination || [],
          quantity: v.quantity || 0, sku: v.sku || "", status: v.status || "Out of Stock",
        })),
      };
    });
    res.json({ success: true, rawItems: formatted });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── GET /data/employees ───────────────────────────────────────────────────────
router.get("/data/employees", async (req, res) => {
  try {
    const { search = "" } = req.query;
    if (!search.trim()) return res.json({ success: true, employees: [] });
    const s = search.trim();
    const filter = {
      $or: [
        { firstName: { $regex: s, $options: "i" } },
        { middleName: { $regex: s, $options: "i" } },
        { lastName: { $regex: s, $options: "i" } },
        { biometricId: { $regex: s, $options: "i" } },
        { identityId: { $regex: s, $options: "i" } },
        { email: { $regex: s, $options: "i" } },
        { name: { $regex: s, $options: "i" } },  // fallback for single-field name
        {
          $expr: {
            $regexMatch: {
              input: {
                $trim: {
                  input: {
                    $concat: [
                      { $ifNull: ["$firstName", ""] }, " ",
                      { $ifNull: ["$middleName", ""] }, " ",
                      { $ifNull: ["$lastName", ""] }
                    ]
                  }
                }
              },
              regex: s, options: "i"
            }
          }
        }
      ],
      isActive: { $ne: false },
    };
    const employees = await Employee.find(filter)
      .select("firstName middleName lastName name biometricId identityId email department designation")
      .limit(20).lean();
    res.json({
      success: true,
      employees: employees.map(e => ({
        _id: e._id,
        fullName: buildFullName(e),
        biometricId: e.biometricId || e.identityId || "",
        department: e.department || "",
        email: e.email || "",
        designation: e.designation || "",
      })),
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── GET / — list MRFs ─────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const {
      status, requestType, creationMode, priority,
      page = 1, limit = 20, search = ""
    } = req.query;

    // Simple rule: only scope to own MRFs if role is explicitly "employee"
    // All other roles (projectManager, admin, store, ceo, etc.) see everything
    const filter = {};
    if (req.user.role === "employee") {
      filter.requestedFor = req.user.id;
    }

    if (status) filter.status = status;
    if (requestType) filter.requestType = requestType;
    if (creationMode) filter.creationMode = creationMode;
    if (priority) filter.priority = priority;
    if (search) {
      filter.$or = [
        { mrfNumber: { $regex: search, $options: "i" } },
        { requestedForName: { $regex: search, $options: "i" } },
        { requestedForId: { $regex: search, $options: "i" } },
        { reason: { $regex: search, $options: "i" } },
        { costCentre: { $regex: search, $options: "i" } },
        { projectReference: { $regex: search, $options: "i" } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await MRF.countDocuments(filter);
    const mrfs = await MRF.find(filter)
      .sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit))
      .populate("requestedFor", "firstName middleName lastName biometricId identityId name department")
      .populate("approvedBy", "firstName lastName name")
      .populate("rejectedBy", "firstName lastName name")
      .lean();

    mrfs.forEach(mrf => {
      if (mrf.requestedFor && typeof mrf.requestedFor === "object") {
        mrf.requestedFor._fullName = buildFullName(mrf.requestedFor);
      }
      // Same contextual copy the requester and TL see, phrased for the store.
      mrf.context = buildContext(mrf, "store");
      mrf.storeActionable = isStoreActionable(mrf);
    });
    markOverdue(mrfs);

    // Attach "originally requested as X" to any MRF that was spawned from a
    // product-request match/approve — one batched lookup, not one per MRF.
    const mrfIds = mrfs.map(m => m._id);
    if (mrfIds.length) {
      const sourceDocs = await RawItemAddRequest.find({ "products.spawnedMrf": { $in: mrfIds } })
        .select("products requestedByName")
        .lean();
      const sourceByMrfId = {};
      sourceDocs.forEach(doc => {
        (doc.products || []).forEach(p => {
          if (p.spawnedMrf) {
            sourceByMrfId[p.spawnedMrf.toString()] = { itemName: p.itemName, requestedByName: doc.requestedByName };
          }
        });
      });
      mrfs.forEach(mrf => {
        mrf.sourceProductRequest = sourceByMrfId[mrf._id.toString()] || null;
      });
    }

    // Stats — no filter, always global counts for the store dashboard

    const statsAgg = await MRF.aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          pending: { $sum: { $cond: [{ $eq: ["$status", "PENDING"] }, 1, 0] } },
          approved: { $sum: { $cond: [{ $eq: ["$status", "APPROVED"] }, 1, 0] } },
          issued: { $sum: { $cond: [{ $in: ["$status", ["ISSUED", "PARTIALLY_ISSUED"]] }, 1, 0] } },
          bypass: { $sum: { $cond: [{ $eq: ["$creationMode", "BYPASS"] }, 1, 0] } },
          // Approved and sitting with the store, availability not yet recorded.
          awaitingStore: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ["$status", "APPROVED"] }, { $eq: ["$storeReviewedAt", null] }] },
                1, 0,
              ],
            },
          },
        }
      },
    ]);
    const stats = statsAgg[0] || { total: 0, pending: 0, approved: 0, issued: 0, bypass: 0, awaitingStore: 0 };
    delete stats._id;

    res.json({
      success: true, mrfs, stats,
      // MRF approval now happens in cowork (Employee → TL → Store). The store
      // never approves; these flags tell the UI to render accordingly.
      approvalFlow: "TL",
      pmApprovalRequired: false,
      storeCanApprove: false,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (e) { console.error("[MRF GET /]", e); res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// STORE-SIDE: New Product Registration Requests (from cowork employees)
// Registered BEFORE "/:id" — otherwise Express matches "/:id" first and
// treats "product-requests" as an MRF id, returning nothing.
// ═══════════════════════════════════════════════════════════════════════════
router.get("/product-requests", async (req, res) => {
  try {
    const { status } = req.query;
    // The Store SEES every product request, approved or not — so they know
    // what is coming and can ask about it in the chat. What they cannot do is
    // ACT on one (match / register / reject) before the requester's Primary
    // Manager/TL has approved it; that gate lives on the mutating routes
    // below, not here. Hiding unapproved requests entirely would leave the
    // store unable to prepare or answer questions about them.
    const filter = {};
    if (status) filter.status = status;
    const requests = await RawItemAddRequest.find(filter)
      .sort({ createdAt: -1 })
      .populate("requestedBy", "firstName middleName lastName name department")
      .populate("matchedTo", "name sku")
      .populate("products.matchedTo", "name sku")
      .populate("products.spawnedMrf", "mrfNumber status")
      .lean();
    res.json({ success: true, requests });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get("/product-requests/:id", async (req, res) => {
  try {
    const request = await RawItemAddRequest.findById(req.params.id)
      .populate("requestedBy", "firstName middleName lastName name department")
      .populate("matchedTo", "name sku")
      .populate("products.matchedTo", "name sku")
      .populate("products.spawnedMrf", "mrfNumber status")
      .lean();
    if (!request) return res.status(404).json({ success: false, message: "Product request not found" });
    // Viewable either way; whether the store can act on it is a separate
    // question the UI reads off `storeActionable`.
    res.json({
      success: true,
      request,
      storeActionable: prStoreActionable(request),
      awaitingTlMessage: prStoreActionable(request)
        ? ""
        : request.approvalStatus === "TL_REJECTED"
          ? `Rejected by ${request.tlRejectedByName || "the requester's Primary Manager/TL"}.${request.tlRejectionNote ? ` Reason: "${request.tlRejectionNote}"` : ""}`
          : `Awaiting approval from ${request.approverName || "the requester's Primary Manager/TL"}. You can discuss it in the chat, but it cannot be matched or registered until they approve.`,
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── Product request chat — store side of the same thread ─────────────────
// Registered before "/:id" so Express does not read "product-requests" as an
// MRF id.
router.get("/product-requests/:id/chat", async (req, res) => {
  try {
    const doc = await RawItemAddRequest.findById(req.params.id)
      .select("products approvalStatus status").lean();
    if (!doc) return res.status(404).json({ success: false, message: "Product request not found" });
    // Chat is open before approval on purpose — the store asking "what exactly
    // is this?" is often what lets the TL decide.

    const messages = await mrfChat.listMessages(req.params.id, {
      subjectType: "PRODUCT_REQUEST", limit: req.query.limit, before: req.query.before,
    });
    await mrfChat.markRead(req.params.id, getActorId(req), "PRODUCT_REQUEST");

    res.json({
      success: true,
      messages,
      mrfNumber: mrfChat.describeSubject(doc, "PRODUCT_REQUEST").label,
      status: doc.status,
      isFinal: doc.status === "RESOLVED" || doc.status === "REJECTED",
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post("/product-requests/:id/chat", async (req, res) => {
  try {
    const doc = await RawItemAddRequest.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: "Product request not found" });
    // Deliberately not gated on approval — see the GET above.

    const attachments = Array.isArray(req.body.attachments)
      ? req.body.attachments
        .filter(a => a?.url && /^https?:\/\//i.test(a.url))
        .slice(0, 5)
        .map(a => ({ url: a.url, publicId: a.publicId || "", name: a.name || "", type: a.type || "image" }))
      : [];

    const message = await mrfChat.postMessage(doc, {
      subjectType: "PRODUCT_REQUEST",
      body: req.body.body,
      attachments,
      senderRef: getActorId(req),
      senderName: actorName(req),
      senderRole: "store",
    });

    res.status(201).json({ success: true, message });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, message: e.message });
  }
});

function cartesianProduct(arrays) {
  if (!arrays || arrays.length === 0) return [[]];
  return arrays.reduce((acc, vals) => {
    const result = [];
    for (const prefix of acc) {
      for (const val of vals) {
        result.push([...prefix, val]);
      }
    }
    return result;
  }, [[]]);
}

router.patch("/product-requests/:id/match", async (req, res) => {
  try {
    const { rawItemId, productId, requestedQty, unit, variantId, variantCombination } = req.body;
    if (!rawItemId) return res.status(400).json({ success: false, message: "rawItemId required" });
    if (!productId) return res.status(400).json({ success: false, message: "productId required" });
    if (!requestedQty || parseFloat(requestedQty) <= 0) {
      return res.status(400).json({ success: false, message: "requestedQty required" });
    }

    const doc = await RawItemAddRequest.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: "Request not found" });
    if (!requirePrApproved(doc, res)) return;

    const product = doc.products.id(productId);
    if (!product) return res.status(404).json({ success: false, message: "Product not found on this request" });
    if (!["PENDING", "MATCHED"].includes(product.status)) {
      return res.status(400).json({ success: false, message: `Cannot match – this product's status is ${product.status}` });
    }

    const rawItem = await RawItem.findById(rawItemId);
    if (!rawItem) return res.status(404).json({ success: false, message: "Raw item not found" });
    if ((rawItem.variants || []).length > 0 && !variantId) {
      return res.status(400).json({ success: false, message: "This item has variants — pick one before matching" });
    }

    // If this product was matched before, it already has a spawned MRF.
    // Editing the match should correct THAT SAME MRF, not retire it and
    // mint a new number — only safe to do while it's still untouched
    // (PENDING, nothing issued); block it otherwise.
    const wasRematch = !!product.spawnedMrf;
    let oldMrf = null;
    if (wasRematch) {
      oldMrf = await MRF.findById(product.spawnedMrf);
      if (oldMrf) {
        const anyIssued = oldMrf.items.some(i => (i.issuedQty || 0) > 0);
        if (anyIssued || oldMrf.status !== "PENDING") {
          return res.status(400).json({
            success: false,
            message: `Cannot re-match — ${oldMrf.mrfNumber} is already ${oldMrf.status.toLowerCase()}${anyIssued ? " with items issued" : ""}. Resolve or cancel it directly instead.`,
          });
        }
      }
    }

    const builtItems = await buildMrfItems([{ rawItemId, requestedQty, unit: unit || product.unit, variantId, variantCombination }]);
    if (!builtItems.length) {
      return res.status(400).json({ success: false, message: "Could not build a request line for that item" });
    }

    let mrf;
    if (oldMrf) {
      // Same MRF id/number — just swap which item it points to.
      oldMrf.items = builtItems;
      oldMrf.reason = doc.reason || `Matched from product request: ${product.itemName}`;
      oldMrf.priority = doc.priority;
      await oldMrf.save();
      mrf = oldMrf;
    } else {
      // Route it to the requester's TL just like a directly-raised MRF —
      // matching an item to the catalogue is not an approval to issue it.
      const { patch: approver, requestedForId } = await approverPatchFor(doc.requestedBy);
      const autoForward = approver.approvalRoute === "AUTO_STORE";

      mrf = new MRF({
        requestedFor: doc.requestedBy,
        requestedForName: doc.requestedByName,
        requestedForDept: doc.requestedByDept,
        requestedForId,
        creationMode: "SELF",
        createdByRef: doc.requestedBy,
        createdByModel: "Employee",
        createdByName: doc.requestedByName,
        requestType: "USES_BASED",
        deadline: null,
        reason: doc.reason || `Matched from product request: ${product.itemName}`,
        priority: doc.priority,
        ...approver,
        status: autoForward ? "APPROVED" : "PENDING",
        items: autoForward
          ? builtItems.map(i => ({ ...i, itemStatus: "APPROVED" }))
          : builtItems,
        ...(autoForward ? { approvedAt: new Date() } : {}),
      });
      mrf.logEvent({
        action: "CREATED", actorName: actorName(req), actorRole: "store",
        detail: `Created from product request "${product.itemName}" matched to "${rawItem.name}".`,
      });
      await mrf.save();

      if (autoForward) mrfNotify.autoForwarded(mrf).catch(() => { });
      else mrfNotify.submitted(mrf).catch(() => { });
    }

    product.matchedTo = rawItemId;
    product.status = "MATCHED";
    product.spawnedMrf = mrf._id;
    product.resolvedAt = new Date();
    doc.resolvedBy = getActorId(req);
    doc.recomputeStatus();
    await doc.save();

    NotificationService.sendToUser(doc.requestedBy, {
      title: "Product Request Matched",
      body: wasRematch
        ? `Your requested product "${product.itemName}" was re-matched to "${rawItem.name}" — request ${mrf.mrfNumber} updated.`
        : `Your requested product "${product.itemName}" was found in inventory as "${rawItem.name}" — request ${mrf.mrfNumber} created.`,
      type: "request",
      url: "/coworking/mrf",
      tag: `product-request-${doc._id}-${product._id}`,
    }).catch(() => { });

    res.json({ success: true, message: "Matched to existing item", request: doc, mrfId: mrf._id, mrfNumber: mrf.mrfNumber, wasRematch });
  } catch (e) {
    console.error("[Match Product Request]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

router.patch("/product-requests/:id/approve", async (req, res) => {
  try {
    const { productId, storeNote, requestedQty, unit } = req.body;
    if (!productId) return res.status(400).json({ success: false, message: "productId required" });
    if (!requestedQty || parseFloat(requestedQty) <= 0) {
      return res.status(400).json({ success: false, message: "requestedQty required" });
    }

    const doc = await RawItemAddRequest.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: "Request not found" });
    if (!requirePrApproved(doc, res)) return;

    const product = doc.products.id(productId);
    if (!product) return res.status(404).json({ success: false, message: "Product not found on this request" });
    if (product.status !== "PENDING") {
      return res.status(400).json({ success: false, message: `Cannot approve – this product's status is ${product.status}` });
    }

    let variants = [];
    if (product.attributes && product.attributes.length > 0) {
      const combos = cartesianProduct(product.attributes.map(a => a.values));
      variants = combos.map(combo => ({
        combination: combo.map((val, idx) => ({ attribute: product.attributes[idx].name, value: val })),
        quantity: 0,
        status: "Out of Stock",
        sku: `${product.itemName.substring(0, 3)}-${combo.join('-')}`.toUpperCase(),
      }));
    }

    const newRawItem = new RawItem({
      name: product.itemName,
      category: product.category || "",
      unit: product.unit || "unit",
      customUnit: product.unit || "unit",
      quantity: 0,
      status: "Out of Stock",
      variants: variants,
      sku: `${product.itemName.substring(0, 4)}-${Date.now()}`.toUpperCase(),
      minStock: 0,
    });
    await newRawItem.save();

    const builtItems = await buildMrfItems([{
      rawItemId: newRawItem._id,
      requestedQty,
      unit: unit || product.unit,
      // Carry the requester's own photos and notes onto the new MRF line.
      description: product.notes || "",
      images: product.images || [],
    }]);

    // Registering the product does not approve the issue — the requester's TL
    // still decides, same as any other MRF.
    const { patch: approver, requestedForId } = await approverPatchFor(doc.requestedBy);
    const autoForward = approver.approvalRoute === "AUTO_STORE";

    const mrf = new MRF({
      requestedFor: doc.requestedBy,
      requestedForName: doc.requestedByName,
      requestedForDept: doc.requestedByDept,
      requestedForId,
      creationMode: "SELF",
      createdByRef: doc.requestedBy,
      createdByModel: "Employee",
      createdByName: doc.requestedByName,
      requestType: "USES_BASED",
      deadline: null,
      reason: doc.reason || `Approved from product request: ${product.itemName}`,
      priority: doc.priority,
      ...approver,
      status: autoForward ? "APPROVED" : "PENDING",
      items: autoForward
        ? builtItems.map(i => ({ ...i, itemStatus: "APPROVED" }))
        : builtItems,
      ...(autoForward ? { approvedAt: new Date() } : {}),
    });
    mrf.logEvent({
      action: "CREATED", actorName: actorName(req), actorRole: "store",
      detail: `Created from product request "${product.itemName}" after registering it in inventory.`,
    });
    await mrf.save();

    if (autoForward) mrfNotify.autoForwarded(mrf).catch(() => { });
    else mrfNotify.submitted(mrf).catch(() => { });

    product.status = "ADDED";
    product.matchedTo = newRawItem._id;
    product.spawnedMrf = mrf._id;
    product.resolvedAt = new Date();
    if (storeNote) product.storeNote = storeNote;
    doc.resolvedBy = getActorId(req);
    doc.recomputeStatus();
    await doc.save();

    NotificationService.sendToUser(doc.requestedBy, {
      title: "Product Request Approved",
      body: `Your requested product "${product.itemName}" has been added to inventory — request ${mrf.mrfNumber} created.`,
      type: "request",
      url: "/coworking/mrf",
      tag: `product-request-${doc._id}-${product._id}`,
    }).catch(() => { });

    res.json({ success: true, message: "Product added to inventory", request: doc, rawItem: newRawItem, mrfId: mrf._id, mrfNumber: mrf.mrfNumber });
  } catch (e) {
    console.error("[Approve Product Request]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});
router.patch("/product-requests/:id/reject", async (req, res) => {
  try {
    const { note, productId } = req.body;
    const doc = await RawItemAddRequest.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: "Request not found" });
    if (!requirePrApproved(doc, res)) return;

    if (productId) {
      const product = doc.products.id(productId);
      if (!product) return res.status(404).json({ success: false, message: "Product not found on this request" });
      if (product.status !== "PENDING") {
        return res.status(400).json({ success: false, message: `Cannot reject – this product's status is ${product.status}` });
      }
      product.status = "REJECTED";
      product.storeNote = note || "";
      product.resolvedAt = new Date();
    } else {
      doc.products.forEach(p => {
        if (p.status === "PENDING") {
          p.status = "REJECTED";
          p.storeNote = note || "";
          p.resolvedAt = new Date();
        }
      });
    }
    doc.storeNote = note || "";
    doc.resolvedBy = getActorId(req);
    doc.recomputeStatus();
    await doc.save();

    NotificationService.sendToUser(doc.requestedBy, {
      title: "Product Request Rejected",
      body: note ? `Reason: ${note}` : "Your product request was rejected.",
      type: "request",
      url: "/coworking/mrf",
      tag: `product-request-${doc._id}`,
    }).catch(() => { });

    res.json({ success: true, message: "Request rejected", request: doc });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── GET /:id ──────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const mrf = await MRF.findById(req.params.id)
      .populate("requestedFor", "firstName middleName lastName biometricId identityId name department email designation")
      .populate("approvedBy", "firstName lastName name")
      .populate("rejectedBy", "firstName lastName name")
      .lean();
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" });
    if (mrf.requestedFor && typeof mrf.requestedFor === "object")
      mrf.requestedFor._fullName = buildFullName(mrf.requestedFor);
    markOverdue([mrf]);
    res.json({
      success: true,
      mrf,
      context: buildContext(mrf, "store"),
      storeActionable: isStoreActionable(mrf),
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── POST / — employee creates own MRF ────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const { requestType, deadline, reason = "", priority = "NORMAL", costCentre = "", projectReference = "", items } = req.body;
    if (!["TIME_BASED", "USES_BASED"].includes(requestType))
      return res.status(400).json({ success: false, message: "Invalid requestType" });
    if (requestType === "TIME_BASED" && !deadline)
      return res.status(400).json({ success: false, message: "Deadline required for TIME_BASED" });
    if (!items?.length)
      return res.status(400).json({ success: false, message: "At least one item required" });

    const builtItems = await buildMrfItems(items);
    if (!builtItems.length)
      return res.status(400).json({ success: false, message: "No valid items found" });

    const actorId = getActorId(req);
    const employee = await Employee.findOne({
      $or: [{ _id: actorId }, { biometricId: req.user.id }, { identityId: req.user.id }]
    }).select("firstName middleName lastName name biometricId identityId department").lean();

    const fullName = buildFullName(employee) || req.user.name || "";
    const biometricId = employee?.biometricId || employee?.identityId || "";

    // Same routing as the cowork side: Employee → Primary Manager/TL → Store,
    // falling through to the Store when no TL can be resolved.
    const { patch: approver } = await approverPatchFor(employee?._id || actorId);
    const autoForward = approver.approvalRoute === "AUTO_STORE";

    const mrf = new MRF({
      requestedFor: employee?._id || actorId,
      requestedForName: fullName,
      requestedForDept: employee?.department || "",
      requestedForId: biometricId,
      creationMode: "SELF",
      createdByRef: employee?._id || actorId,
      createdByModel: "Employee",
      createdByName: fullName,
      requestType,
      deadline: requestType === "TIME_BASED" ? new Date(deadline) : null,
      reason, priority, costCentre, projectReference,
      ...approver,
      status: autoForward ? "APPROVED" : "PENDING",
      items: autoForward
        ? builtItems.map(i => ({ ...i, itemStatus: "APPROVED" }))
        : builtItems,
      ...(autoForward ? { approvedAt: new Date() } : {}),
    });
    mrf.logEvent({
      action: "CREATED", actorName: fullName, actorRole: "employee",
      detail: autoForward ? approver.autoForwardReason : `Submitted for approval by ${approver.approverName}.`,
    });
    await mrf.save();

    if (autoForward) mrfNotify.autoForwarded(mrf).catch(() => { });
    else mrfNotify.submitted(mrf).catch(() => { });

    res.status(201).json({
      success: true,
      message: autoForward
        ? approver.autoForwardReason
        : `${mrf.mrfNumber} submitted — waiting for approval from ${approver.approverName}.`,
      mrf,
    });
  } catch (e) { console.error("[MRF POST /]", e); res.status(500).json({ success: false, message: e.message }); }
});

// ── POST /bypass ──────────────────────────────────────────────────────────────
// Frontend sends: { employeeMongoId, requestType, deadline?, reason, priority?, items }
router.post("/bypass", async (req, res) => {
  try {
    const {
      employeeMongoId,   // ← frontend sends this (MongoDB _id of the employee)
      requestType, deadline, reason = "",
      priority = "NORMAL", costCentre = "", projectReference = "", items,
    } = req.body;

    if (!employeeMongoId)
      return res.status(400).json({ success: false, message: "employeeMongoId is required" });
    if (!["TIME_BASED", "USES_BASED"].includes(requestType))
      return res.status(400).json({ success: false, message: "Invalid requestType" });
    if (requestType === "TIME_BASED" && !deadline)
      return res.status(400).json({ success: false, message: "Deadline required for TIME_BASED" });
    if (!items?.length)
      return res.status(400).json({ success: false, message: "At least one item required" });

    const employee = await Employee.findById(employeeMongoId)
      .select("firstName middleName lastName name biometricId identityId email department designation").lean();
    if (!employee)
      return res.status(404).json({ success: false, message: "Employee not found" });

    const builtItems = await buildMrfItems(items);
    if (!builtItems.length)
      return res.status(400).json({ success: false, message: "No valid items found" });

    const actorId = getActorId(req);
    const empFullName = buildFullName(employee);
    const biometricId = employee.biometricId || employee.identityId || "";

    const mrf = new MRF({
      requestedFor: employee._id,
      requestedForName: empFullName,
      requestedForDept: employee.department || "",
      requestedForId: biometricId,
      creationMode: "BYPASS",
      createdByRef: actorId,           // ← PM's ObjectId, not a string
      createdByModel: "ProjectManager",
      createdByName: req.user.name || "",
      requestType,
      deadline: requestType === "TIME_BASED" ? new Date(deadline) : null,
      reason, priority, costCentre, projectReference,
      // A bypass MRF is raised by the store, standing in front of the
      // employee — there is no TL step to wait for.
      approverResolution: "RESOLVED",
      approvalRoute: "AUTO_STORE",
      autoForwarded: true,
      autoForwardReason: `Raised on behalf of ${empFullName} by the Store — no TL approval step applies.`,
      status: "APPROVED",
      items: builtItems.map(i => ({ ...i, itemStatus: "APPROVED" })),
      approvedBy: actorId,
      approvedAt: new Date(),
      storeNotes: `Bypass MRF raised by ${req.user.name || "Store"}`,
    });
    mrf.logEvent({
      action: "CREATED", actorName: actorName(req), actorRole: "store",
      detail: `Raised on behalf of ${empFullName} — no TL approval required.`,
    });
    await mrf.save();

    // Tell the employee it exists — they did not raise it themselves.
    if (mrf.requestedForId) {
      mrfNotify.notifyCowork({
        recipientIds: [mrf.requestedForId],
        type: "request",
        tag: `mrf-bypass-${mrf._id}`,
        title: "Material request raised for you",
        body: `${mrf.mrfNumber}: the Store raised a material request on your behalf for ${builtItems.length} item(s).`,
        data: { mrfId: String(mrf._id), mrfNumber: mrf.mrfNumber, url: "/coworking/mrf" },
      }).catch(() => { });
    }

    res.status(201).json({
      success: true,
      message: "On-behalf MRF created and approved — ready to issue.",
      mrf,
    });
  } catch (e) { console.error("[MRF POST /bypass]", e); res.status(500).json({ success: false, message: e.message }); }
});

// ── PATCH /:id/approve — retired ─────────────────────────────────────────────
// Approval moved to the requester's Primary Manager/TL in cowork. Kept as an
// explicit 403 rather than deleted so any stale client gets told why instead
// of a confusing 404.
router.patch("/:id/approve", (req, res) => {
  res.status(403).json({
    success: false,
    message: "MRFs are approved by the requester's Primary Manager/TL in CoWork. The store records availability and issues material — it does not approve.",
  });
});

// ── PATCH /:id/reject — retired ──────────────────────────────────────────────
router.patch("/:id/reject", (req, res) => {
  res.status(403).json({
    success: false,
    message: "Only the requester's Primary Manager/TL can reject an MRF. If the material cannot be supplied, use 'Cannot Fulfil' instead so the requester sees the correct reason.",
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PATCH /:id/availability — the store's core action
//
// Records what the store actually found, per item:
//   AVAILABLE | PARTIAL | NOT_AVAILABLE | ALTERNATIVE
// This is independent of issuance — it is how the requester and TL learn
// whether their material exists before anything is handed over.
//
// Body: { items: [{ itemId, availability, availableQty?, note?,
//                   alternativeName?, alternativeRawItemId? }], storeNotes? }
// ═══════════════════════════════════════════════════════════════════════════
const AVAILABILITY_VALUES = ["AVAILABLE", "PARTIAL", "NOT_AVAILABLE", "ALTERNATIVE"];

router.patch("/:id/availability", async (req, res) => {
  try {
    const { items = [], storeNotes } = req.body;
    if (!Array.isArray(items) || !items.length)
      return res.status(400).json({ success: false, message: "No availability updates supplied" });

    const mrf = await MRF.findById(req.params.id);
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" });

    if (!isStoreActionable(mrf))
      return res.status(403).json({
        success: false,
        message: `This request has not been approved yet — it is still with ${mrf.approverName || "the requester's Primary Manager/TL"}.`,
      });
    if (["REJECTED", "CANCELLED"].includes(mrf.status))
      return res.status(400).json({ success: false, message: `Cannot update — this request is ${mrf.status.toLowerCase()}.` });

    const who = actorName(req);
    const summary = [];

    for (const line of items) {
      const item = mrf.items.id(line.itemId);
      if (!item) continue;
      if (["REJECTED", "UNFULFILLED"].includes(item.itemStatus)) continue;

      const availability = String(line.availability || "").toUpperCase();
      if (!AVAILABILITY_VALUES.includes(availability))
        return res.status(400).json({
          success: false,
          message: `Invalid availability "${line.availability}" — expected one of ${AVAILABILITY_VALUES.join(", ")}.`,
        });

      const remaining = Math.max(0, (item.requestedQty || 0) - (item.issuedQty || 0));

      // availableQty is always in the requester's unit — the same unit the
      // store person is looking at on screen.
      let availableQty;
      if (availability === "AVAILABLE") availableQty = remaining;
      else if (availability === "NOT_AVAILABLE") availableQty = 0;
      else if (availability === "PARTIAL") {
        availableQty = parseFloat(line.availableQty);
        if (!Number.isFinite(availableQty) || availableQty <= 0)
          return res.status(400).json({
            success: false,
            message: `Enter how much of "${item.rawItemName}" is available — a partial quantity must be greater than zero.`,
          });
        if (availableQty >= remaining) {
          // "Partial" that covers the whole remainder is just available.
          availableQty = remaining;
        }
      } else {
        availableQty = line.availableQty === undefined || line.availableQty === null
          ? null : parseFloat(line.availableQty);
      }

      const finalAvailability =
        availability === "PARTIAL" && availableQty >= remaining ? "AVAILABLE" : availability;

      if (finalAvailability === "ALTERNATIVE" && !String(line.alternativeName || "").trim())
        return res.status(400).json({
          success: false,
          message: `Name the alternative product you are offering for "${item.rawItemName}".`,
        });

      item.availability = finalAvailability;
      item.availableQty = availableQty;
      item.availabilityNote = String(line.note || "").trim().slice(0, 500);
      item.availabilityUpdatedAt = new Date();
      item.availabilityUpdatedBy = getActorId(req);
      item.availabilityUpdatedByName = who;
      item.alternativeItem = finalAvailability === "ALTERNATIVE"
        ? {
          rawItem: line.alternativeRawItemId || null,
          name: String(line.alternativeName || "").trim(),
          note: String(line.alternativeNote || "").trim().slice(0, 500),
        }
        : { rawItem: null, name: "", note: "" };

      summary.push({
        itemId: String(item._id),
        name: item.rawItemName,
        unit: item.unit,
        availability: finalAvailability,
        requested: item.requestedQty,
        available: availableQty,
        note: item.availabilityNote,
        alternativeName: item.alternativeItem?.name || "",
      });
    }

    if (!summary.length)
      return res.status(400).json({ success: false, message: "None of the supplied items are on this request." });

    if (storeNotes !== undefined) mrf.storeNotes = String(storeNotes || "").trim();
    if (!mrf.storeReviewedAt) mrf.storeReviewedAt = new Date();

    const detail = summary
      .map(s => `${s.name}: ${s.availability.replace(/_/g, " ").toLowerCase()}${s.availability === "PARTIAL" ? ` (${s.available} of ${s.requested} ${s.unit})` : ""}`)
      .join("; ");
    mrf.logEvent({ action: "AVAILABILITY_UPDATED", actorName: who, actorRole: "store", detail });

    await mrf.save();

    mrfChat.systemMessage(mrf, `Store availability update — ${detail}`, who);
    mrfNotify.availabilityUpdated(mrf, summary).catch(e => console.error("[availability notify]", e.message));

    const obj = mrf.toObject();
    res.json({
      success: true,
      message: "Availability recorded — the requester and their TL have been notified.",
      mrf: obj,
      summary,
      context: buildContext(obj, "store"),
    });
  } catch (e) {
    console.error("[MRF availability]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /:id/unfulfilled — close an approved request the store cannot supply.
//
// Deliberately NOT called "reject": rejection means the TL said no. This means
// the TL said yes and the material does not exist. The requester sees two
// different messages because they need to do two different things.
// ═══════════════════════════════════════════════════════════════════════════
router.post("/:id/unfulfilled", async (req, res) => {
  try {
    const reason = String(req.body.reason || "").trim();
    if (!reason)
      return res.status(400).json({
        success: false,
        message: "A reason is required — the requester and their TL both see it.",
      });

    const mrf = await MRF.findById(req.params.id);
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" });

    if (!isStoreActionable(mrf))
      return res.status(403).json({ success: false, message: "This request has not been approved yet." });
    if (["REJECTED", "CANCELLED", "UNFULFILLED", "COMPLETED"].includes(mrf.status))
      return res.status(400).json({ success: false, message: `This request is already ${mrf.status.toLowerCase()}.` });

    const anyIssued = mrf.items.some(i => (i.issuedQty || 0) > 0);
    const who = actorName(req);

    mrf.items.forEach(i => {
      // Anything already handed over keeps its issued state; only what is
      // still owed becomes unfulfillable.
      if ((i.issuedQty || 0) > 0) return;
      if (i.itemStatus === "REJECTED") return;
      i.itemStatus = "UNFULFILLED";
      if (i.availability === "UNREVIEWED") i.availability = "NOT_AVAILABLE";
    });

    // If some material already went out, the request is partially issued and
    // closed — not wholly unfulfilled.
    mrf.status = anyIssued ? "PARTIALLY_ISSUED" : "UNFULFILLED";
    mrf.unfulfilledAt = new Date();
    mrf.unfulfilledBy = getActorId(req);
    mrf.unfulfilledByName = who;
    mrf.unfulfilledReason = reason;
    if (!mrf.storeReviewedAt) mrf.storeReviewedAt = new Date();

    mrf.logEvent({
      action: "STORE_UNFULFILLED", actorName: who, actorRole: "store",
      detail: anyIssued ? `Remaining quantity cannot be supplied. ${reason}` : reason,
    });
    await mrf.save();

    mrfChat.systemMessage(mrf, `The Store cannot supply ${anyIssued ? "the remaining quantity" : "this request"}. Reason: ${reason}`, who);
    mrfNotify.unfulfilled(mrf).catch(e => console.error("[unfulfilled notify]", e.message));

    const obj = mrf.toObject();
    res.json({
      success: true,
      message: "Request closed as unfulfillable — the requester and their TL have been notified.",
      mrf: obj,
      context: buildContext(obj, "store"),
    });
  } catch (e) {
    console.error("[MRF unfulfilled]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── PATCH /:id/cancel ─────────────────────────────────────────────────────────
router.patch("/:id/cancel", async (req, res) => {
  try {
    const mrf = await MRF.findById(req.params.id);
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" });
    if (!["PENDING", "APPROVED"].includes(mrf.status))
      return res.status(400).json({ success: false, message: "Only PENDING or APPROVED MRFs can be cancelled" });

    mrf.status = "CANCELLED";
    mrf.cancelledBy = getActorId(req);
    mrf.cancelledByModel = req.user.role === "employee" ? "Employee" : "ProjectManager";
    mrf.cancelledAt = new Date();
    mrf.cancellationNote = req.body.cancellationNote || "";
    mrf.items.forEach(i => { if (i.itemStatus !== "ISSUED") i.itemStatus = "REJECTED"; });
    await mrf.save();
    res.json({ success: true, message: "MRF cancelled", mrf });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── POST /:id/issue ───────────────────────────────────────────────────────────
router.post("/:id/issue", async (req, res) => {
  try {
    const { items = [], storeNotes = "" } = req.body;
    const mrf = await MRF.findById(req.params.id);
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" });

    // Approval gate — the requester's Primary Manager/TL must have approved,
    // unless no TL could be resolved (auto-forwarded) or the store raised it.
    if (!isStoreActionable(mrf)) {
      return res.status(403).json({
        success: false,
        message: `Cannot issue — this request is still awaiting approval from ${mrf.approverName || "the requester's Primary Manager/TL"}.`,
      });
    }

    if (mrf.status === "CANCELLED")
      return res.status(400).json({ success: false, message: "This request was cancelled by the requester — do not issue against it." });
    if (!["APPROVED", "PARTIALLY_ISSUED"].includes(mrf.status))
      return res.status(400).json({ success: false, message: `Cannot issue — status is ${mrf.status}` });

    // ── Validate every line before touching stock ──────────────────────────
    // All-or-nothing: a partially applied issue would leave stock and the MRF
    // disagreeing, and two store people issuing at once makes that likely.
    const planned = [];
    for (const line of items) {
      const mrfItem = mrf.items.id(line.itemId);
      if (!mrfItem) continue;
      const issuedQty = parseFloat(line.issuedQty) || 0;
      if (issuedQty <= 0) continue;

      if (["REJECTED", "UNFULFILLED"].includes(mrfItem.itemStatus))
        return res.status(400).json({
          success: false,
          message: `"${mrfItem.rawItemName}" is marked ${mrfItem.itemStatus.toLowerCase()} on this request and cannot be issued.`,
        });

      const remaining = Math.max(0, (mrfItem.requestedQty || 0) - (mrfItem.issuedQty || 0));
      if (issuedQty > remaining + 0.001)
        return res.status(400).json({
          success: false,
          message: `Cannot issue ${issuedQty} ${mrfItem.unit} of "${mrfItem.rawItemName}" — only ${remaining} ${mrfItem.unit} is still owed on this request.`,
        });

      planned.push({ mrfItem, issuedQty, notes: line.storeNotes || "" });
    }

    if (!planned.length)
      return res.status(400).json({ success: false, message: "Enter at least one quantity to issue." });

    // Re-check live stock at the moment of issue — inventory may have moved
    // since the store person opened the page.
    const stockNow = await mrfUnits.enrichItemsWithStock(planned.map(p => p.mrfItem.toObject()));
    const short = [];
    planned.forEach((p, i) => {
      const live = stockNow[i];
      if (live.available !== null && p.issuedQty > live.available + 0.001) {
        short.push(`${p.mrfItem.rawItemName}: trying to issue ${p.issuedQty} ${p.mrfItem.unit} but only ${live.available} ${p.mrfItem.unit} is in stock right now`);
      }
    });
    if (short.length)
      return res.status(409).json({
        success: false,
        message: "Stock changed since this page was loaded — nothing was issued.",
        details: short,
      });

    const who = actorName(req);
    const issuedLines = [];

    for (const { mrfItem, issuedQty, notes } of planned) {
      // The only place a requester-unit quantity is converted to the
      // catalogue's base unit: the stock ledger.
      const deductQty = await convertQty(issuedQty, mrfItem.unit, mrfItem.baseUnit);
      await adjustStock(
        mrfItem.rawItem, mrfItem.variantId, mrfItem.variantCombination, -deductQty,
        {
          type: mrfItem.variantId ? "VARIANT_REDUCE" : "REDUCE",
          quantity: deductQty,
          reason: `MRF Issue — ${mrf.mrfNumber}`,
          notes: `Issued to ${mrf.requestedForName} (${mrf.requestedForDept}). MRF: ${mrf.mrfNumber}`,
          performedBy: getActorId(req),
        }
      );
      mrfItem.issuedQty += issuedQty;
      mrfItem.consumedQty = mrfItem.issuedQty - mrfItem.returnedQty;
      mrfItem.itemStatus = mrfItem.issuedQty >= mrfItem.requestedQty - 0.001 ? "ISSUED" : "PARTIALLY_ISSUED";
      // Issuing settles the availability question for what just went out.
      if (mrfItem.itemStatus === "ISSUED") mrfItem.availability = "AVAILABLE";
      if (notes) mrfItem.storeNotes = notes;
      mrfItem.issueHistory = mrfItem.issueHistory || [];
      mrfItem.issueHistory.push({
        issuedQty,
        notes: notes || storeNotes || "",
        recordedBy: getActorId(req),
        recordedAt: new Date(),
      });

      issuedLines.push({
        name: mrfItem.rawItemName,
        unit: mrfItem.unit,
        issuedQty,
        remaining: Math.max(0, (mrfItem.requestedQty || 0) - mrfItem.issuedQty),
      });
    }

    if (storeNotes) mrf.storeNotes = storeNotes;
    if (!mrf.storeReviewedAt) mrf.storeReviewedAt = new Date();

    // Fully issued only when every live line is done; UNFULFILLED lines are
    // settled and must not hold the request open, but must not fake completion
    // either — the status stays PARTIALLY_ISSUED if anything is still owed.
    const live = mrf.items.filter(i => !["REJECTED", "UNFULFILLED"].includes(i.itemStatus));
    const allIssued = live.length > 0 && live.every(i => i.itemStatus === "ISSUED");
    const someIssued = mrf.items.some(i => (i.issuedQty || 0) > 0);
    mrf.status = allIssued ? "ISSUED" : someIssued ? "PARTIALLY_ISSUED" : mrf.status;

    const detail = issuedLines
      .map(l => `${l.issuedQty} ${l.unit} of ${l.name}${l.remaining > 0 ? ` (${l.remaining} ${l.unit} still pending)` : ""}`)
      .join("; ");
    mrf.logEvent({
      action: allIssued ? "FULLY_ISSUED" : "PARTIALLY_ISSUED",
      actorName: who, actorRole: "store", detail,
    });

    await mrf.save();

    mrfChat.systemMessage(mrf, `Store issued ${detail}.`, who);
    mrfNotify.issued(mrf, issuedLines).catch(e => console.error("[issue notify]", e.message));

    const obj = mrf.toObject();
    res.json({
      success: true,
      message: allIssued
        ? "All requested material issued."
        : `Issued. ${issuedLines.filter(l => l.remaining > 0).map(l => `${l.remaining} ${l.unit} of ${l.name}`).join(", ")} still pending on this request.`,
      mrf: obj,
      issued: issuedLines,
      context: buildContext(obj, "store"),
    });
  } catch (e) { console.error("[MRF issue]", e); res.status(500).json({ success: false, message: e.message }); }
});

// ── POST /:id/items/:itemId/return ────────────────────────────────────────────
router.post("/:id/items/:itemId/return", async (req, res) => {
  try {
    const { returnedQty, notes = "" } = req.body;
    const qty = parseFloat(returnedQty) || 0;
    if (qty <= 0) return res.status(400).json({ success: false, message: "returnedQty must be > 0" });

    const mrf = await MRF.findById(req.params.id);
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" });
    const mrfItem = mrf.items.id(req.params.itemId);
    if (!mrfItem) return res.status(404).json({ success: false, message: "Item not found in MRF" });

    const maxReturn = mrfItem.issuedQty - mrfItem.returnedQty;
    if (qty > maxReturn + 0.001)
      return res.status(400).json({ success: false, message: `Cannot return ${qty} — max returnable is ${maxReturn.toFixed(3)} ${mrfItem.unit}` });

    const creditQty = await convertQty(qty, mrfItem.unit, mrfItem.baseUnit);
    await adjustStock(
      mrfItem.rawItem, mrfItem.variantId, mrfItem.variantCombination, +creditQty,
      {
        type: mrfItem.variantId ? "VARIANT_ADD" : "ADD",
        quantity: creditQty,
        reason: `MRF Return — ${mrf.mrfNumber}`,
        notes: notes || `Return from ${mrf.requestedForName}. MRF: ${mrf.mrfNumber}`,
        performedBy: getActorId(req),
      }
    );

    mrfItem.returnedQty += qty;
    mrfItem.consumedQty = mrfItem.issuedQty - mrfItem.returnedQty;
    mrfItem.returnHistory.push({
      returnedQty: qty, notes,
      recordedBy: getActorId(req), recordedByModel: "ProjectManager",
      // The schema field is `returnedAt`. This used to push `recordedAt`,
      // which Mongoose stripped as unknown — the timestamp only survived
      // because `returnedAt` has a Date.now default, and anything reading
      // `recordedAt` (the store's own activity log) got undefined.
      returnedAt: new Date(),
    });

    const fullyReturned = mrfItem.returnedQty >= mrfItem.issuedQty - 0.001;
    mrfItem.itemStatus = fullyReturned ? "RETURNED" : "PARTIALLY_RETURNED";

    const allReturned = mrf.items.every(i => ["RETURNED", "REJECTED"].includes(i.itemStatus));
    const someReturned = mrf.items.some(i => ["RETURNED", "PARTIALLY_RETURNED"].includes(i.itemStatus));
    mrf.status = allReturned ? "COMPLETED" : someReturned ? "PARTIALLY_RETURNED" : mrf.status;

    const who = actorName(req);
    mrf.logEvent({
      action: allReturned ? "FULLY_RETURNED" : "RETURNED",
      actorName: who, actorRole: "store",
      detail: `${qty} ${mrfItem.unit} of ${mrfItem.rawItemName} returned${notes ? ` — ${notes}` : ""}`,
    });

    await mrf.save();

    // A return was the one movement that told nobody. The requester needs to
    // know their return was recorded (it clears what they owe), and the TL
    // needs it because the request may now be complete.
    mrfChat.systemMessage(
      mrf,
      `${who} recorded a return of ${qty} ${mrfItem.unit} of ${mrfItem.rawItemName}.${notes ? ` Note: ${notes}` : ""}`,
      who
    );
    mrfNotify.returned(mrf, {
      name: mrfItem.rawItemName,
      unit: mrfItem.unit,
      returnedQty: qty,
      outstanding: Math.max(0, (mrfItem.issuedQty || 0) - (mrfItem.returnedQty || 0)),
      complete: allReturned,
    }).catch(e => console.error("[return notify]", e.message));

    res.json({ success: true, message: `${qty} ${mrfItem.unit} returned & stock credited`, mrf });
  } catch (e) { console.error("[MRF return]", e); res.status(500).json({ success: false, message: e.message }); }
});


router.get("/:id/stock-check", async (req, res) => {
  try {
    const mrf = await MRF.findById(req.params.id)
      .populate(
        "requestedFor",
        "firstName middleName lastName name biometricId identityId department designation email phone"
      )
      .populate("approvedBy", "firstName lastName name")
      .lean();

    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" });

    // Attach resolved full name
    if (mrf.requestedFor && typeof mrf.requestedFor === "object") {
      mrf.requestedFor._fullName = buildFullName(mrf.requestedFor);
    }

    // Mark overdue flag (reuse existing helper)
    markOverdue([mrf]);

    // ── Live stock lookup for each item ──────────────────────────────────
    // `available` comes back in the REQUESTER's unit, not the catalogue base
    // unit. The store UI prints it beside `item.unit`, so returning the base
    // figure here (as this endpoint used to) showed the wrong number whenever
    // the two differed — 20 pcs in stock reading as "20 packets available"
    // against a request for 2 packets.
    const itemsWithStock = await mrfUnits.enrichItemsWithStock(mrf.items || []);

    // If this MRF was spawned from a product-request match/approve, find
    // that source so the page can link back to it — that's where "Edit
    // Match" lives, and there's otherwise no trail back to it once resolved.
    let sourceProductRequest = null;
    const sourceDoc = await RawItemAddRequest.findOne({ "products.spawnedMrf": req.params.id })
      .select("products requestedByName")
      .lean();
    if (sourceDoc) {
      const sourceProduct = (sourceDoc.products || []).find(
        p => p.spawnedMrf && p.spawnedMrf.toString() === req.params.id
      );
      if (sourceProduct) {
        sourceProductRequest = {
          id: sourceDoc._id,
          itemName: sourceProduct.itemName,
          requestedByName: sourceDoc.requestedByName,
        };
      }
    }

    return res.json({
      success: true,
      mrf,
      itemsWithStock,
      // Approval belongs to the requester's TL in cowork — the store never
      // approves, so these stay false for every client.
      approvalFlow: "TL",
      pmApprovalRequired: false,
      storeCanApprove: false,
      storeActionable: isStoreActionable(mrf),
      context: buildContext(mrf, "store"),
      sourceProductRequest,
    });
  } catch (err) {
    console.error("MRF stock-check error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// MRF chat — store side of the same thread the requester and TL use.
// Auth here is the CMS JWT; the cowork side hits the mirror of these routes in
// coworkMrfRoutes.js. Both go through services/mrfChat.service.js.
// ═══════════════════════════════════════════════════════════════════════════

router.get("/:id/chat", async (req, res) => {
  try {
    const mrf = await MRF.findById(req.params.id).select("mrfNumber status").lean();
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" });

    const messages = await mrfChat.listMessages(req.params.id, {
      limit: req.query.limit, before: req.query.before,
    });
    await mrfChat.markRead(req.params.id, getActorId(req));

    res.json({
      success: true,
      messages,
      mrfNumber: mrf.mrfNumber,
      status: mrf.status,
      // A closed request keeps its thread open — the store may still owe the
      // requester an explanation — but the UI flags it.
      isFinal: ["COMPLETED", "REJECTED", "CANCELLED", "UNFULFILLED"].includes(mrf.status),
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post("/:id/chat", async (req, res) => {
  try {
    const mrf = await MRF.findById(req.params.id);
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" });

    const attachments = Array.isArray(req.body.attachments)
      ? req.body.attachments
        .filter(a => a?.url && /^https?:\/\//i.test(a.url))
        .slice(0, 5)
        .map(a => ({ url: a.url, publicId: a.publicId || "", name: a.name || "", type: a.type || "image" }))
      : [];

    const message = await mrfChat.postMessage(mrf, {
      body: req.body.body,
      attachments,
      senderRef: getActorId(req),
      senderName: actorName(req),
      senderRole: "store",
    });

    res.status(201).json({ success: true, message });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, message: e.message });
  }
});

router.patch("/:id/chat/read", async (req, res) => {
  try {
    const r = await mrfChat.markRead(req.params.id, getActorId(req));
    res.json({ success: true, ...r });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});



module.exports = router;