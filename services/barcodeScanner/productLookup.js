// lib/productLookup.js
//
// Resolves a scanned barcode's work-order key into the things a supervisor
// recognises: the product, its image, and the manufacturing order it belongs to.
//
// The chain — now entirely inside the ONE local database:
//
//   barcode  WO-359e7172-009
//              |  last 8 hex of the WorkOrder _id
//              v
//   workorders._id ...359e7172   -> stockItemName "kalam_Cargo"
//              +-- stockItemId ---> stockitems  -> variant image
//              +-- customerRequestId -> customerrequests.requestId  "REQ-2026-0009"
//                                      ^ the MO number
//
// Previously this opened its own connection to the hosted Atlas cluster and
// kept a mirror fallback for when the internet was down. Both are gone: the ERP
// collections are local, so this is three ordinary queries on the default
// mongoose connection.
//
// ─── The one thing worth knowing about the image ─────────────────────────────
// It usually lives on variants[].images, NOT the top-level stockitems.images[],
// and an entry may be a bare URL string or an object carrying url / src /
// imageUrl. Variant order matters: a product has one variant per size or colour
// with its own photo, so this work order's OWN variant is matched first. Taking
// "any" image would show a size 34 photo against a size 30 work order.
//
// The URLs are Cloudinary and therefore still need internet to DISPLAY. That is
// a browser concern, not a database one — the page falls back to a placeholder.

const mongoose = require("mongoose");

const TTL_MS = Number(process.env.PRODUCT_LOOKUP_TTL_MS || 60 * 1000);

const cache = new Map(); // shortId -> { at, data }

const extractUrl = (entry) => {
  if (!entry) return null;
  if (typeof entry === "string") return entry;
  return entry.url || entry.src || entry.imageUrl || null;
};

const firstImage = (images) => {
  if (!Array.isArray(images)) return null;
  for (const img of images) {
    const url = extractUrl(img);
    if (url) return url;
  }
  return null;
};

function pickImage(wo, si) {
  if (!si) return null;

  let matched = null;
  if (wo.variantId && Array.isArray(si.variants)) {
    matched = si.variants.find(
      (v) => v && v._id && String(v._id) === String(wo.variantId)
    );
  }
  if (
    !matched &&
    Array.isArray(wo.variantAttributes) &&
    wo.variantAttributes.length &&
    Array.isArray(si.variants)
  ) {
    matched = si.variants.find((v) => {
      const va = (v && v.attributes) || [];
      if (va.length !== wo.variantAttributes.length) return false;
      return wo.variantAttributes.every((wa) =>
        va.some((a) => a.name === wa.name && a.value === wa.value)
      );
    });
  }
  if (matched) {
    const url = firstImage(matched.images);
    if (url) return url;
  }

  const top = firstImage(si.images);
  if (top) return top;

  // Last resort: any variant with a photo. Better than a blank tile, though it
  // may not be this work order's exact size or colour.
  if (Array.isArray(si.variants)) {
    for (const v of si.variants) {
      const url = firstImage(v && v.images);
      if (url) return url;
    }
  }
  return null;
}

async function readWorkOrders(shortIds) {
  const db = mongoose.connection.db;

  // $substrCP on the stringified _id: characters 16..24 of the 24-char hex are
  // exactly the last 8 the barcode carries. Computed in the query rather than
  // by pulling the whole collection and filtering in JS.
  const wos = await db
    .collection("workorders")
    .aggregate([
      { $addFields: { _sid: { $substrCP: [{ $toString: "$_id" }, 16, 8] } } },
      { $match: { _sid: { $in: shortIds } } },
      {
        $project: {
          _sid: 1, stockItemId: 1, stockItemName: 1, customerName: 1,
          quantity: 1, status: 1, customerRequestId: 1,
          variantAttributes: 1, variantId: 1,
        },
      },
    ])
    .toArray();

  const stockIds = wos.map((w) => w.stockItemId).filter(Boolean);
  const reqIds = wos.map((w) => w.customerRequestId).filter(Boolean);

  const [items, reqs] = await Promise.all([
    stockIds.length
      ? db.collection("stockitems")
          .find(
            { _id: { $in: stockIds } },
            {
              projection: {
                name: 1, images: 1, category: 1, unit: 1,
                // variants carry the photos — omitting them is what once made
                // every product look like it had none.
                "variants._id": 1, "variants.images": 1, "variants.attributes": 1,
              },
            }
          )
          .toArray()
      : [],
    reqIds.length
      ? db.collection("customerrequests")
          .find(
            { _id: { $in: reqIds } },
            { projection: { requestId: 1, status: 1, requestType: 1 } }
          )
          .toArray()
      : [],
  ]);

  const itemById = new Map(items.map((s) => [String(s._id), s]));
  const reqById = new Map(reqs.map((r) => [String(r._id), r]));

  const out = new Map();
  for (const w of wos) {
    const si = w.stockItemId ? itemById.get(String(w.stockItemId)) : null;
    const cr = w.customerRequestId ? reqById.get(String(w.customerRequestId)) : null;
    out.set(w._sid, {
      shortId: w._sid,
      productName: w.stockItemName || (si && si.name) || "",
      productImage: pickImage(w, si),
      productCategory: (si && si.category) || "",
      // [{name:"Size", value:"30"}] — objects, not strings. Joining the array
      // directly renders "[object Object]".
      variant: Array.isArray(w.variantAttributes)
        ? w.variantAttributes
            .map((a) => (a && a.name ? a.name + " " + a.value : ""))
            .filter(Boolean)
            .join(" · ")
        : "",
      customerName: w.customerName || "",
      orderQuantity: w.quantity != null ? w.quantity : null,
      workOrderStatus: w.status || "",
      moNumber: (cr && cr.requestId) || null,
      moStatus: (cr && cr.status) || null,
      source: "local",
    });
  }
  return out;
}

/**
 * @param {string[]} shortIds work-order keys from scanned barcodes
 * @returns {Promise<Map<string, object>>} keyed by shortId; a key with no work
 *          order simply has no entry, which callers render as "unknown product"
 */
async function resolve(shortIds) {
  const wanted = [...new Set((shortIds || []).filter(Boolean))];
  if (wanted.length === 0) return new Map();

  const now = Date.now();
  const out = new Map();
  const missing = [];

  for (const id of wanted) {
    const hit = cache.get(id);
    if (hit && now - hit.at < TTL_MS) out.set(id, hit.data);
    else missing.push(id);
  }
  if (missing.length === 0) return out;

  try {
    const resolved = await readWorkOrders(missing);
    for (const [k, v] of resolved) {
      cache.set(k, { at: now, data: v });
      out.set(k, v);
    }
  } catch (err) {
    console.error("[ProductLookup] read failed:", err.message);
  }
  return out;
}

module.exports = { resolve };
