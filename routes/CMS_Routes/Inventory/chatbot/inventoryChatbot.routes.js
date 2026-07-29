// routes/CMS_Routes/Inventory/chatbot/inventoryChatbot.routes.js
//
// Store / Inventory chatbot for the Project Manager portal.
//
// POST /api/cms/inventory/chatbot/query
// Body: { message: string, history?: [{ role: "user"|"assistant", text: string }] }
//
// Flow:
//   1. Look for an explicit PO/MRF number in the message. If the message has
//      none but is clearly a follow-up ("that", "more detail", "expand"...),
//      resolve the most recently mentioned PO/MRF number from the
//      conversation history instead — this is what makes "show me in detail
//      about that GRN" actually work instead of guessing.
//   2. If an identifier resolved, fetch the FULL document (every item line,
//      every delivery/GRN entry, every status field) — not the trimmed list
//      shape used for browsing.
//   3. Otherwise run keyword-triggered lookups across RawItem / StockItem /
//      PurchaseOrder / MRF / PurchaseOrder.deliveries (GRN), each pulling a
//      genuinely complete field set (item lines, not just totals).
//   4. Always pull a cheap store-wide snapshot too, for orientation.
//   5. Feed the gathered JSON as grounding context + conversation history
//      into Gemini (text-only generateContent — same GEMINI_API_KEY / model
//      fallback pattern as routes/task_routes/askAI.routes.js), instructed to
//      scale its level of detail to what was actually asked and to label
//      every number instead of dumping bare values.

const express = require("express");
const router = express.Router();

const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const StockItem = require("../../../../models/CMS_Models/Inventory/Products/StockItem");
const PurchaseOrder = require("../../../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const MRF = require("../../../../models/CMS_Models/Inventory/Operations/MRF");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");

router.use(EmployeeAuthMiddleware);

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MODELS_TO_TRY = [
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
];

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "of", "for", "to", "in", "on",
  "at", "with", "and", "or", "but", "what", "whats", "how", "many", "much", "do", "does", "did",
  "we", "i", "you", "he", "she", "it", "they", "want", "know", "please", "tell", "me", "about",
  "show", "give", "current", "have", "has", "had", "there", "any", "all", "can", "could", "would",
  "should", "will", "shall", "get", "list", "check", "find", "need", "hi", "hello", "hey", "thanks",
  "thank", "ok", "okay",
]);

function tokenize(message) {
  const words = (message.toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
  return [...new Set(words)].slice(0, 8);
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenRegex(tokens) {
  if (!tokens.length) return null;
  return new RegExp(tokens.map(escapeRegex).join("|"), "i");
}

// ── Explicit identifier extraction (PO26075969, MRF-2607-0001, ...) ──────────
const PO_ID_RX = /\bPO\d{6,10}\b/gi;
const MRF_ID_RX = /\bMRF-\d{3,4}-\d{3,6}\b/gi;
const WANTS_MORE_DETAIL_RX = /\b(that|this|it|those|more detail|in detail|full detail|more info|expand|elaborate|explain more|details?)\b/i;

function extractIds(text) {
  const po = [...new Set((text.match(PO_ID_RX) || []).map((s) => s.toUpperCase()))];
  const mrf = [...new Set((text.match(MRF_ID_RX) || []).map((s) => s.toUpperCase()))];
  return { po, mrf };
}

// If the current message has no explicit ID but is clearly a follow-up
// ("show me in detail about that GRN"), pull the most recently mentioned
// PO/MRF number out of the conversation history instead of guessing.
function resolveIdsFromHistory(currentIds, message, history) {
  if (currentIds.po.length || currentIds.mrf.length) return currentIds;
  if (!WANTS_MORE_DETAIL_RX.test(message) || !Array.isArray(history) || !history.length) return currentIds;

  for (let i = history.length - 1; i >= 0; i--) {
    const ids = extractIds(history[i].text || "");
    if (ids.po.length || ids.mrf.length) return ids;
  }
  return currentIds;
}

// ── Gemini text call (no file upload) ─────────────────────────────────────────
async function callGeminiText(apiKey, prompt) {
  let lastError = null;

  for (const modelName of MODELS_TO_TRY) {
    try {
      const url = `${GEMINI_BASE}/models/${modelName}:generateContent?key=${apiKey}`;
      const body = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.35, maxOutputTokens: 2048 },
      };

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        lastError = new Error(err?.error?.message || `HTTP ${res.status}`);
        if (res.status === 404) continue; // model not available, try next
        continue;
      }

      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        lastError = new Error("Empty response from Gemini");
        continue;
      }
      return text.trim();
    } catch (e) {
      lastError = e;
    }
  }

  throw lastError || new Error("All Gemini models failed");
}

// ── Full single-document detail fetches ───────────────────────────────────────
async function fetchPoFullDetail(poNumbers) {
  if (!poNumbers.length) return [];
  return PurchaseOrder.find({ poNumber: { $in: poNumbers } })
    .select(
      "poNumber vendorName status paymentStatus totalAmount totalReceived totalPending " +
      "items deliveries returnRequests createdAt expectedDeliveryDate"
    )
    .populate("vendor", "companyName contactPerson phone email")
    .lean();
}

async function fetchMrfFullDetail(mrfNumbers) {
  if (!mrfNumbers.length) return [];
  return MRF.find({ mrfNumber: { $in: mrfNumbers } })
    .select(
      "mrfNumber requestedForName requestedForDept requestType status priority deadline " +
      "reason costCentre projectReference items storeNotes pmApproved pmRejected " +
      "approvedAt rejectedAt rejectionNote createdAt"
    )
    .lean();
}

// ── Gather grounding context from the real inventory data ────────────────────
async function gatherContext(message, history) {
  const tokens = tokenize(message);
  const rx = tokenRegex(tokens);
  const lower = message.toLowerCase();

  const currentIds = extractIds(message);
  const resolvedIds = resolveIdsFromHistory(currentIds, message, history);
  const isFollowUpDetailRequest =
    (resolvedIds.po.length || resolvedIds.mrf.length) &&
    (currentIds.po.length || currentIds.mrf.length || WANTS_MORE_DETAIL_RX.test(message));

  const wantsLowStock = /low stock|out of stock|running low|shortage|reorder|below min/.test(lower);
  const wantsPO = /purchase order|\bpo\b|\bpos\b|order status|outstanding order/.test(lower);
  const wantsGRN = /\bgrn\b|delivery|deliveries|received|receipt/.test(lower);
  const wantsMRF = /\bmrf\b|material request|issue.*(material|item)|requisition/.test(lower);
  const wantsVendor = /vendor|supplier/.test(lower);

  const tasks = {};

  // Always: cheap store-wide snapshot
  tasks.snapshot = Promise.all([
    RawItem.countDocuments({}),
    RawItem.countDocuments({ status: "Low Stock" }),
    RawItem.countDocuments({ status: "Out of Stock" }),
    StockItem.countDocuments({}),
    PurchaseOrder.countDocuments({ status: { $in: ["ISSUED", "PARTIALLY_RECEIVED"] } }),
    MRF.countDocuments({ status: { $in: ["PENDING", "APPROVED", "PARTIALLY_ISSUED"] } }),
  ]).then(([rawTotal, rawLow, rawOut, stockTotal, poOpen, mrfOpen]) => ({
    rawItemsTotal: rawTotal,
    rawItemsLowStock: rawLow,
    rawItemsOutOfStock: rawOut,
    stockItemsTotal: stockTotal,
    openPurchaseOrders: poOpen,
    openMaterialRequests: mrfOpen,
  }));

  // ── Explicit / carried-forward identifier => FULL detail, every field ──────
  if (resolvedIds.po.length) {
    tasks.poFullDetail = fetchPoFullDetail(resolvedIds.po);
  }
  if (resolvedIds.mrf.length) {
    tasks.mrfFullDetail = fetchMrfFullDetail(resolvedIds.mrf);
  }

  // Name/SKU matched raw items (the core "what's the available qty of X" case)
  // Skip the generic keyword search when this is purely a resolved-ID detail
  // follow-up — no need to also dump unrelated token matches.
  if (rx && !isFollowUpDetailRequest) {
    tasks.rawItems = RawItem.find({
      $or: [
        { name: rx }, { sku: rx }, { category: rx },
        { "variants.sku": rx }, { "variants.combination": rx },
      ],
    })
      .select("name sku category unit quantity minStock maxStock status variants primaryVendor description")
      .populate("primaryVendor", "companyName")
      .limit(6)
      .lean();

    tasks.stockItems = StockItem.find({
      $or: [{ name: rx }, { reference: rx }, { category: rx }, { "variants.sku": rx }],
    })
      .select("name reference category variants totalQuantityOnHand inventoryValue")
      .limit(6)
      .lean();

    tasks.purchaseOrdersByMatch = PurchaseOrder.find({
      $or: [{ poNumber: rx }, { vendorName: rx }, { "items.itemName": rx }, { "items.sku": rx }],
    })
      .select("poNumber vendorName status paymentStatus totalAmount totalReceived totalPending items deliveries createdAt expectedDeliveryDate")
      .populate("vendor", "companyName")
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    tasks.mrfsByMatch = MRF.find({
      $or: [
        { mrfNumber: rx }, { requestedForName: rx },
        { "items.rawItemName": rx }, { "items.rawItemSku": rx },
      ],
    })
      .select("mrfNumber requestedForName requestedForDept status priority deadline items createdAt")
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();
  }

  if (wantsLowStock) {
    tasks.criticalRawItems = RawItem.find({ $expr: { $lte: ["$quantity", "$minStock"] } })
      .select("name sku category quantity minStock maxStock unit status")
      .populate("primaryVendor", "companyName")
      .sort({ quantity: 1 })
      .limit(15)
      .lean();
  }

  if (wantsPO && !isFollowUpDetailRequest) {
    tasks.pendingPOs = PurchaseOrder.find({ status: { $in: ["DRAFT", "ISSUED", "PARTIALLY_RECEIVED"] } })
      .select("poNumber vendorName status paymentStatus totalAmount totalReceived totalPending items expectedDeliveryDate createdAt")
      .populate("vendor", "companyName")
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();
  }

  if (wantsGRN && !isFollowUpDetailRequest) {
    tasks.recentDeliveries = PurchaseOrder.find({ deliveries: { $exists: true, $not: { $size: 0 } } })
      .select("poNumber vendorName status totalAmount totalReceived totalPending deliveries items")
      .populate("vendor", "companyName")
      .sort({ "deliveries.createdAt": -1 })
      .limit(10)
      .lean()
      .then((pos) => {
        const flat = [];
        pos.forEach((po) => {
          (po.deliveries || []).forEach((d) => {
            flat.push({
              poNumber: po.poNumber,
              vendorName: po.vendorName || po.vendor?.companyName || "—",
              poStatus: po.status,
              poTotalReceived: po.totalReceived,
              poTotalPending: po.totalPending,
              deliveryDate: d.deliveryDate,
              quantityReceived: d.quantityReceived,
              invoiceNumber: d.invoiceNumber,
              notes: d.notes,
            });
          });
        });
        flat.sort((a, b) => new Date(b.deliveryDate) - new Date(a.deliveryDate));
        return flat.slice(0, 10);
      });
  }

  if (wantsMRF && !isFollowUpDetailRequest) {
    tasks.recentMRFs = MRF.find({})
      .select("mrfNumber requestedForName requestedForDept requestType status priority deadline items createdAt")
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();
  }

  if (wantsVendor) {
    tasks.topVendors = PurchaseOrder.aggregate([
      { $match: { status: { $ne: "CANCELLED" } } },
      { $group: { _id: "$vendor", vendorName: { $first: "$vendorName" }, totalValue: { $sum: { $ifNull: ["$totalAmount", 0] } }, poCount: { $sum: 1 } } },
      { $sort: { totalValue: -1 } },
      { $limit: 5 },
      { $lookup: { from: "vendors", localField: "_id", foreignField: "_id", as: "vendorDoc" } },
      { $project: { _id: 0, vendorName: { $ifNull: [{ $arrayElemAt: ["$vendorDoc.companyName", 0] }, "$vendorName"] }, totalValue: 1, poCount: 1 } },
    ]);
  }

  const keys = Object.keys(tasks);
  const values = await Promise.all(Object.values(tasks));
  const context = {};
  keys.forEach((k, i) => { context[k] = values[i]; });
  return context;
}

// ── Build follow-up chips from whatever matched ───────────────────────────────
function buildSuggestions(context) {
  const chips = [];
  (context.poFullDetail || []).forEach((p) => chips.push(`Show delivery (GRN) history for ${p.poNumber}`));
  (context.mrfFullDetail || []).forEach((m) => chips.push(`Show item-wise status for ${m.mrfNumber}`));
  (context.rawItems || []).slice(0, 3).forEach((r) => chips.push(`Available quantity of ${r.name}`));
  (context.purchaseOrdersByMatch || []).slice(0, 2).forEach((p) => chips.push(`Show full details for ${p.poNumber}`));
  (context.mrfsByMatch || []).slice(0, 2).forEach((m) => chips.push(`Show full details for ${m.mrfNumber}`));
  if (!chips.length) {
    chips.push("Which raw items are low on stock?", "Show pending purchase orders", "Show recent GRN deliveries", "Show pending material requests");
  }
  return [...new Set(chips)].slice(0, 4);
}

function buildPrompt(message, history, context) {
  const historyText = (history || [])
    .slice(-8)
    .map((h) => `${h.role === "user" ? "PM" : "Assistant"}: ${h.text}`)
    .join("\n");

  return `You are "Store Assistant", an AI helping a Project Manager in a garment-manufacturing ERP understand real-time inventory / store data — raw materials, stock items (BOM), purchase orders (PO), GRN (goods receipt / deliveries, embedded per-PO), and material requests (MRF).

The store has many different categories of data (raw items with variants, POs with line items and delivery/GRN history, MRFs with per-item issue status, vendors). Structure your answer to match whichever category the DATA actually contains — don't force everything into one generic list shape.

Formatting rules:
- You may use light markdown: **bold** for field labels/headings, "- " bullet lines for lists, and blank lines between sections. The chat UI renders this.
- NEVER present a bare number with no label. Always say what it is — e.g. "Received: 5 units", "Pending: 20 units", not "5 — 20".
- For a purchase order, when the data is available, cover: PO number, vendor, status, payment status, order value, each line item (name, ordered qty, received qty, pending qty, unit price), and every delivery/GRN entry (date, quantity received, invoice number, notes).
- For an MRF, cover: MRF number, requested for (name/department), status, priority, deadline, and each item (name, requested/issued/returned qty, unit, item status).
- For a raw item, cover: name, SKU, category, unit, quantity, min/max stock, status, and per-variant breakdown if variants are present.

Depth rules — this is the most important part:
- If DATA includes a "poFullDetail" or "mrfFullDetail" section, or the PM's question asks for "detail"/"more"/"full"/"explain"/"expand", give the COMPLETE breakdown using every relevant field present in DATA for that record — every line item, every delivery/GRN entry, every date. Do not compress, summarize away, or omit fields that are present in DATA just to stay short.
- Otherwise, for browsing-type questions ("show pending POs", "which items are low"), give a well-labeled list — one clearly formatted entry per record — rather than a one-line-per-record dump, so the PM can actually read the numbers.
- If the question is a greeting or generic ("how's the store doing"), summarize using the "snapshot" section only.

Other rules:
- Answer ONLY using the DATA JSON below. Never invent quantities, statuses, PO/MRF numbers, or vendor names that are not present in DATA.
- If DATA has no relevant match for the question, say so plainly and suggest what to ask instead (e.g. a different item name, PO number, or MRF number).
- If a raw item name matches MULTIPLE items or variants, list each option (name, variant/combination, quantity, unit, status) so the PM can pick the right one — do not silently pick one.
- Quantities/statuses/PO or MRF numbers must be copied exactly from DATA.

${historyText ? `Recent conversation:\n${historyText}\n` : ""}
DATA (JSON, grounding only — do not repeat it verbatim, use it to answer):
${JSON.stringify(context)}

PM's question: ${message}

Answer:`;
}

router.post("/query", async (req, res) => {
  try {
    const { message, history } = req.body || {};

    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ success: false, message: "A message is required." });
    }
    if (message.trim().length > 400) {
      return res.status(400).json({ success: false, message: "Keep questions under 400 characters." });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ success: false, message: "GEMINI_API_KEY not set in .env on the server." });
    }

    const safeHistory = Array.isArray(history) ? history : [];
    const context = await gatherContext(message.trim(), safeHistory);
    const prompt = buildPrompt(message.trim(), safeHistory, context);
    const reply = await callGeminiText(apiKey, prompt);
    const suggestions = buildSuggestions(context);

    res.json({ success: true, reply, suggestions });
  } catch (error) {
    console.error("[Inventory Chatbot] Error:", error);
    res.status(500).json({ success: false, message: error.message || "Server error while answering the question." });
  }
});

module.exports = router;
