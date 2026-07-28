// routes/CMS_Routes/Inventory/chatbot/inventoryChatbot.routes.js
//
// Store / Inventory chatbot for the Project Manager portal.
//
// POST /api/cms/inventory/chatbot/query
// Body: { message: string, history?: [{ role: "user"|"assistant", text: string }] }
//
// Flow:
//   1. Tokenize the question, run light keyword-triggered lookups across
//      RawItem / StockItem / PurchaseOrder / MRF / PurchaseOrder.deliveries (GRN).
//   2. Also always pull a cheap "snapshot" of store-wide counts so the model
//      has orientation even for vague/greeting questions.
//   3. Feed the gathered JSON as grounding context + the conversation history
//      into Gemini (text-only generateContent — same GEMINI_API_KEY / model
//      fallback pattern as routes/task_routes/askAI.routes.js, minus the
//      audio-upload machinery which isn't needed here).
//   4. Return the model's plain-text answer plus a few clickable follow-up
//      suggestions derived from whatever matched.

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

// ── Gemini text call (no file upload) ─────────────────────────────────────────
async function callGeminiText(apiKey, prompt) {
  let lastError = null;

  for (const modelName of MODELS_TO_TRY) {
    try {
      const url = `${GEMINI_BASE}/models/${modelName}:generateContent?key=${apiKey}`;
      const body = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
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

// ── Gather grounding context from the real inventory data ────────────────────
async function gatherContext(message) {
  const tokens = tokenize(message);
  const rx = tokenRegex(tokens);
  const lower = message.toLowerCase();

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

  // Name/SKU matched raw items (the core "what's the available qty of X" case)
  if (rx) {
    tasks.rawItems = RawItem.find({
      $or: [
        { name: rx }, { sku: rx }, { category: rx },
        { "variants.sku": rx }, { "variants.combination": rx },
      ],
    })
      .select("name sku category unit quantity minStock maxStock status variants primaryVendor")
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
      .select("poNumber vendorName status totalAmount totalReceived totalPending items createdAt expectedDeliveryDate")
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
      .select("name sku quantity minStock unit status")
      .sort({ quantity: 1 })
      .limit(10)
      .lean();
  }

  if (wantsPO) {
    tasks.pendingPOs = PurchaseOrder.find({ status: { $in: ["DRAFT", "ISSUED", "PARTIALLY_RECEIVED"] } })
      .select("poNumber vendorName status totalAmount totalReceived totalPending expectedDeliveryDate createdAt")
      .populate("vendor", "companyName")
      .sort({ createdAt: -1 })
      .limit(8)
      .lean();
  }

  if (wantsGRN) {
    tasks.recentDeliveries = PurchaseOrder.find({ deliveries: { $exists: true, $not: { $size: 0 } } })
      .select("poNumber vendorName deliveries status")
      .populate("vendor", "companyName")
      .sort({ "deliveries.createdAt": -1 })
      .limit(8)
      .lean()
      .then((pos) => {
        const flat = [];
        pos.forEach((po) => {
          (po.deliveries || []).forEach((d) => {
            flat.push({
              poNumber: po.poNumber,
              vendorName: po.vendorName || po.vendor?.companyName || "—",
              deliveryDate: d.deliveryDate,
              quantityReceived: d.quantityReceived,
              invoiceNumber: d.invoiceNumber,
            });
          });
        });
        flat.sort((a, b) => new Date(b.deliveryDate) - new Date(a.deliveryDate));
        return flat.slice(0, 8);
      });
  }

  if (wantsMRF) {
    tasks.recentMRFs = MRF.find({})
      .select("mrfNumber requestedForName requestedForDept status priority items createdAt")
      .sort({ createdAt: -1 })
      .limit(8)
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
  (context.rawItems || []).slice(0, 3).forEach((r) => chips.push(`Available quantity of ${r.name}`));
  (context.purchaseOrdersByMatch || []).slice(0, 2).forEach((p) => chips.push(`Status of PO ${p.poNumber}`));
  (context.mrfsByMatch || []).slice(0, 2).forEach((m) => chips.push(`Status of ${m.mrfNumber}`));
  if (!chips.length) {
    chips.push("Which raw items are low on stock?", "Show pending purchase orders", "Show recent GRN deliveries", "Show pending material requests");
  }
  return [...new Set(chips)].slice(0, 4);
}

function buildPrompt(message, history, context) {
  const historyText = (history || [])
    .slice(-6)
    .map((h) => `${h.role === "user" ? "PM" : "Assistant"}: ${h.text}`)
    .join("\n");

  return `You are "Store Assistant", an AI helping a Project Manager in a garment-manufacturing ERP understand real-time inventory / store data — raw materials, stock items (BOM), purchase orders, GRN (goods receipt / deliveries), and material requests (MRF).

Rules:
- Answer ONLY using the DATA JSON below. Never invent quantities, statuses, PO numbers, or vendor names that are not present in DATA.
- If DATA has no relevant match for the question, say so plainly and suggest what to ask instead (e.g. a different item name/spelling).
- If a raw item name matches MULTIPLE items or variants, list each option (name, variant/combination, quantity, unit, status) as short bullet lines so the PM can pick the right one — do not silently pick one.
- Be concise. Use short bullet lines for lists (item — qty unit — status). Use plain text only, no markdown headers or asterisked bold.
- Quantities/statuses/PO or MRF numbers must be copied exactly from DATA.
- If the question is a greeting or generic ("how's the store doing"), summarize using the "snapshot" section only.

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

    const context = await gatherContext(message.trim());
    const prompt = buildPrompt(message.trim(), Array.isArray(history) ? history : [], context);
    const reply = await callGeminiText(apiKey, prompt);
    const suggestions = buildSuggestions(context);

    res.json({ success: true, reply, suggestions });
  } catch (error) {
    console.error("[Inventory Chatbot] Error:", error);
    res.status(500).json({ success: false, message: error.message || "Server error while answering the question." });
  }
});

module.exports = router;
