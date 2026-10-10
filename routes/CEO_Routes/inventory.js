/**
 * routes/CEO_Routes/inventory.js
 * Register: app.use("/api/ceo/inventory", require("./routes/CEO_Routes/inventory"));
 */
"use strict";
const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
// Header before cookie: in production the frontend is a different host, so
// the auth_token cookie is third-party and Safari blocks it outright. The
// frontend also sends the session as `Authorization: Bearer`. See config/jwt.js.
const { readToken } = require("../../config/jwt");

function ceoAuth(req, res, next) {
  try {
    const token = readToken(req);
    if (!token)
      return res
        .status(401)
        .json({ success: false, message: "Authentication required" });
    const d = jwt.verify(
      token,
      require("../../config/jwt").SECRET,
    );
    if (!["ceo", "admin", "hr_manager", "project_manager"].includes(d.role))
      return res
        .status(403)
        .json({ success: false, message: "CEO access required" });
    req.ceoUser = d;
    next();
  } catch {
    return res
      .status(401)
      .json({ success: false, message: "Invalid or expired token" });
  }
}

// ── Proxy helper ──────────────────────────────────────────────────────────────
/* Forwards the CEO's read to the department route that owns the data, with the
   CEO's own credentials. It used to forward the Cookie ONLY — and in Chrome
   (cross-origin dev, and anywhere the cookie is refused) the Authorization
   header is the only credential there is, so the department route saw nobody.
   It also answered 200 whatever the department route said, so a refusal
   rendered as an empty page. Both carried through now (6 Oct 2026).
   `targetPath` may be a function of the request, for routes with an id. */
const fetchInternal = (req, path) =>
  new Promise((resolve, reject) => {
    const http = require("http");
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port: process.env.PORT || 5000,
        path,
        method: "GET",
        headers: {
          Cookie: req.headers.cookie || "",
          ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
          "Content-Type": "application/json",
        },
      },
      (response) => {
        let b = "";
        response.on("data", (c) => (b += c));
        response.on("end", () => {
          try {
            resolve({ status: response.statusCode || 200, data: JSON.parse(b) });
          } catch {
            reject(new Error(`The ${path.split("?")[0]} read did not answer with JSON (HTTP ${response.statusCode}).`));
          }
        });
      },
    );
    r.on("error", reject);
    r.end();
  });

const proxy = (targetPath, shape) => async (req, res) => {
  try {
    const qs = req.url.includes("?")
      ? req.url.slice(req.url.indexOf("?"))
      : `?${new URLSearchParams(req.query)}`;
    const target = typeof targetPath === "function" ? targetPath(req) : targetPath;
    const { status, data } = await fetchInternal(req, `${target}${qs}`);
    res.status(status).json(shape && status < 400 ? shape(data) : data);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── MACHINES & PURCHASE ORDERS ────────────────────────────────────────────────
/* The CEO pages for these shipped calling routes this router never had
   (found by scripts/pageSweep.js, 6 Oct 2026). Each is the owning
   department's own read, so the figures cannot disagree with Store's. */
const PO_BASE = "/api/cms/inventory/operations/purchase-orders";
router.get("/machines", ceoAuth, proxy("/api/cms/machines"));
router.get("/purchase-orders/stats", ceoAuth, proxy(PO_BASE, (d) => ({ success: true, stats: d.stats || null })));
router.get("/purchase-orders/vendors", ceoAuth, proxy(`${PO_BASE}/data/vendors`));
router.get("/purchase-orders/:id", ceoAuth, proxy((req) => `${PO_BASE}/${encodeURIComponent(req.params.id)}`));
router.get("/purchase-orders", ceoAuth, proxy(PO_BASE));

// ── RAW ITEMS ─────────────────────────────────────────────────────────────────
router.get(
  "/raw-items/data/categories",
  ceoAuth,
  proxy("/api/cms/raw-items/data/categories"),
);
router.get("/raw-items/stats", ceoAuth, async (req, res) => {
  try {
    const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
    const items = await RawItem.find({})
      .select("quantity minStock variants")
      .lean();
    let total = 0,
      inStock = 0,
      lowStock = 0,
      outOfStock = 0;
    const ds = (q, m) => {
      const qn = Number(q) || 0,
        mn = Number(m) || 0;
      if (qn <= 0) return "Out of Stock";
      if (qn <= mn) return "Low Stock";
      return "In Stock";
    };
    for (const it of items) {
      total++;
      let itemStatus = ds(it.quantity, it.minStock);
      if (it.variants?.length > 0) {
        const vStatuses = it.variants.map((v) =>
          ds(v.quantity, v.minStock ?? it.minStock),
        );
        if (vStatuses.some((s) => s === "Out of Stock"))
          itemStatus = "Out of Stock";
        else if (vStatuses.some((s) => s === "Low Stock"))
          itemStatus = "Low Stock";
        else itemStatus = "In Stock";
      }
      if (itemStatus === "In Stock") inStock++;
      else if (itemStatus === "Low Stock") lowStock++;
      else outOfStock++;
    }
    res.json({
      success: true,
      stats: { total, inStock, lowStock, outOfStock },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
router.get("/raw-items/:id", ceoAuth, async (req, res) => {
  try {
    const http = require("http");
    const port = process.env.PORT || 5000;
    const data = await new Promise((resolve, reject) => {
      const r = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: `/api/cms/raw-items/${req.params.id}`,
          method: "GET",
          headers: { Cookie: req.headers.cookie || "", ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}), },
        },
        (response) => {
          let b = "";
          response.on("data", (c) => (b += c));
          response.on("end", () => {
            try {
              resolve(JSON.parse(b));
            } catch {
              reject(new Error(""));
            }
          });
        },
      );
      r.on("error", reject);
      r.end();
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
router.get("/raw-items", ceoAuth, proxy("/api/cms/raw-items"));

// ── STOCK ITEMS ───────────────────────────────────────────────────────────────
router.get("/stock-items/stats", ceoAuth, async (req, res) => {
  try {
    const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
    const items = await StockItem.find({ isActive: { $ne: false } })
      .select("status inventoryValue potentialRevenue profitMargin")
      .lean();
    const total = items.length;
    const inStock = items.filter((i) => i.status === "In Stock").length;
    const lowStock = items.filter((i) => i.status === "Low Stock").length;
    const outOfStock = items.filter((i) => i.status === "Out of Stock").length;
    const totalInventoryValue = items.reduce(
      (s, i) => s + (i.inventoryValue || 0),
      0,
    );
    const totalPotentialRevenue = items.reduce(
      (s, i) => s + (i.potentialRevenue || 0),
      0,
    );
    const avgMargin =
      total > 0
        ? Math.round(
            (items.reduce((s, i) => s + (i.profitMargin || 0), 0) / total) * 10,
          ) / 10
        : 0;
    res.json({
      success: true,
      stats: {
        total,
        inStock,
        lowStock,
        outOfStock,
        totalInventoryValue,
        totalPotentialRevenue,
        avgMargin,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/stock-items/categories", ceoAuth, async (req, res) => {
  try {
    const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
    const cats = await StockItem.distinct("category", { isActive: { $ne: false } });
    res.json({ success: true, categories: cats.filter(Boolean).sort() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/stock-items/:id", ceoAuth, async (req, res) => {
  try {
    const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
    const item = await StockItem.findById(req.params.id)
      .select("-createdBy -updatedBy -__v")
      .lean();
    if (!item)
      return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, stockItem: item });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/stock-items", ceoAuth, async (req, res) => {
  try {
    const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
    const {
      search,
      category,
      status,
      gender,
      page = 1,
      limit = 20,
    } = req.query;
    const filter = { isActive: { $ne: false } };
    if (search)
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { reference: { $regex: search, $options: "i" } },
      ];
    if (category && category !== "all") filter.category = category;
    if (status && status !== "all") filter.status = status;
    if (gender && gender !== "all") filter.genderCategory = gender;
    const total = await StockItem.countDocuments(filter);
    const items = await StockItem.find(filter)
      .select(
        "name reference category genderCategory status images variants attributes totalQuantityOnHand inventoryValue potentialRevenue profitMargin averageSalesPrice averageCost operations updatedAt createdAt",
      )
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .lean();
    res.json({
      success: true,
      stockItems: items,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
