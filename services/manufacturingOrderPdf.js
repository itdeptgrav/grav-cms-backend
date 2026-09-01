// services/manufacturingOrderPdf.js
//
// THE MANUFACTURING ORDER SUMMARY SHEET — the PDF attached to the Project
// Manager's "new MO" email.
//
// Explicit request, 31 Aug 2026: "in that mail the pdf also need to attach
// about that order ok, so that it can be more understandable and more formal
// and industry standard", and the content brief: "properly describe about that
// order properly ok, which type of order, which customer, what's the total qty,
// total WO, wo wise. which type of order, lists (product name, photo, qty and
// all)".
//
// Modelled on services/sampleApprovalPdf.js — same page geometry, same
// built-in-fonts-only rule (no font files ship with this repo), same
// buffer-collection pattern, and the same image handling, which matters: most
// product photos are Cloudinary WebP, and pdfkit's `doc.image()` decodes only
// JPEG/PNG and THROWS on WebP. `imageUrl()` below rewrites Cloudinary URLs
// through an `f_jpg/` transformation for exactly that reason.
"use strict";

const PDFDocument = require("pdfkit");

const StoreSettings = require("../models/CMS_Models/Inventory/Operations/StoreSettings");
const StockItem = require("../models/CMS_Models/Inventory/Products/StockItem");
const { resolveOrderOrigin } = require("./orderOrigin");
const { personsOnOrder } = require("./personRoster");

/**
 * IS THIS A PERSON-WISE ORDER OR A SIZE-WISE ONE?
 *
 * Two genuinely different documents, on explicit request (31 Aug 2026: "as per
 * the order wise if we consider it is of 2 types, one is person wise and
 * another is size wise so accordingly do it ok for person wise how the report
 * will be show and for size wise order how the report will be show").
 *
 *   person-wise — a measurement conversion. Named individuals, each with their
 *     own measured size. What the floor needs is a roster.
 *   size-wise   — a bulk order. Quantities against sizes. Nobody is named.
 *     The code's own word for this is "bulk" (see WorkOrder's
 *     `dispatchType: ["person_wise","bulk"]` enum).
 *
 * The OR is deliberate and is copied verbatim from the two places the backend
 * already makes this call (quotationRoutes.js's WO factory and
 * manufacturingOrderRoutes.js's detail response): some converted requests
 * carry `measurementId` while `requestType` stayed at its default, so testing
 * `requestType` alone silently misclassifies them as bulk.
 */
const isPersonWiseOrder = (request) =>
  Boolean(request?.requestType === "measurement_conversion" || request?.measurementId);

const PAGE_W = 595.28; // A4 points
const PAGE_H = 841.89;
const MARGIN = 40;
const CONTENT_W = PAGE_W - MARGIN * 2;

const INK = "#111111";
const MUTED = "#777777";
const RULE = "#DDDDDD";
const HEAD_BG = "#F3F4F6";

const prettyDate = (d) =>
  d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—";

/**
 * How to name a work order on paper.
 *
 * `workOrderNumber` is declared on the WorkOrder schema but is NOT actually
 * written by the factory that creates them — every real work order in this
 * database has none, so printing that field alone gave a column of dashes.
 * The rest of the system already identifies a work order by the last 8
 * characters of its `_id`: that is exactly what the shop-floor barcode encodes
 * (`WO-<shortId>-<unit>`, see productionCompletionRoutes.js and the QC
 * scanner), so the same short form is what somebody holding a printed sheet
 * can actually match against a scanned label.
 */
const workOrderLabel = (wo) =>
  wo?.workOrderNumber || (wo?._id ? `WO-${String(wo._id).slice(-8)}` : "—");
const prettyDateTime = (d) =>
  new Date(d).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** A Drive/Cloudinary image record OR a bare url string → a fetchable URL. */
function imageUrl(img) {
  if (!img) return null;
  const raw = typeof img === "string" ? img : img.fileId ? `https://lh3.googleusercontent.com/d/${img.fileId}=w600` : img.url || null;
  if (!raw) return null;
  // See the header — pdfkit throws on WebP, Cloudinary can re-encode inline.
  const m = raw.match(/^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(.*)$/);
  return m ? `${m[1]}f_jpg/${m[2]}` : raw;
}

/** Best-effort image bytes, one retry, never throws — a missing photo degrades
 *  to a placeholder box, never to a failed PDF. */
async function fetchImageBuffer(img) {
  const url = imageUrl(img);
  if (!url) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (attempt === 1) {
        console.warn("[manufacturingOrderPdf] photo fetch failed:", err.message);
        return null;
      }
    }
  }
  return null;
}

/** Page break if `need` points won't fit; returns the y to draw at. */
function ensure(doc, y, need) {
  if (y + need > PAGE_H - MARGIN - 24) {
    doc.addPage();
    return MARGIN;
  }
  return y;
}

function sectionTitle(doc, y, text) {
  y = ensure(doc, y, 30);
  doc.font("Helvetica-Bold").fontSize(10.5).fillColor(INK).text(text.toUpperCase(), MARGIN, y, { width: CONTENT_W, characterSpacing: 0.8 });
  y = doc.y + 4;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_W, y).lineWidth(0.8).strokeColor(INK).stroke();
  return y + 10;
}

function row(doc, y, label, value, w = CONTENT_W) {
  y = ensure(doc, y, 18);
  doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(label, MARGIN, y, { width: w * 0.32 });
  doc.font("Helvetica-Bold").fontSize(9.5).fillColor(INK).text(String(value ?? "—"), MARGIN + w * 0.32, y, { width: w * 0.68 });
  return Math.max(doc.y, y + 12) + 4;
}

/**
 * Build the order summary sheet.
 *
 * @param {object} request  a CustomerRequest (document or lean)
 * @param {Array}  workOrders  the WorkOrder documents raised for it
 * @returns {Promise<Buffer>}
 */
async function buildManufacturingOrderPdf(request, workOrders = [], opts = {}) {
  // ── WHO IS READING THIS SHEET ─────────────────────────────────────────
  //
  // One builder, four cuts. Explicit request: "as per the mail also the
  // corresponding pdf also need to attach in order to fully represent about
  // that mail" — so each department's letter carries the sheet that matches
  // what its letter says, not a single generic document four times.
  //
  //   projectManager — everything. The production plan is the full picture.
  //   rnd            — the specification and what is being made. No material
  //                    consumption: procurement is not their call.
  //   merchandiser   — the material requirement, which is the whole reason
  //                    they were written to. Work-order scheduling omitted.
  //   sales          — what was ordered and when it is due, in terms a
  //                    customer could be told. No materials, no shop-floor
  //                    work orders — neither is theirs to discuss.
  //
  // Defaults to the full sheet, so any caller that does not care gets what
  // this function always produced.
  const audience = opts.audience || "projectManager";
  const show = {
    materials: audience === "merchandiser" || audience === "projectManager",
    workOrders: audience === "projectManager" || audience === "rnd",
    roster: true,
    products: true,
  };

  const origin = resolveOrderOrigin(request);
  // Which of the two documents this is. Everything below branches on it — the
  // particulars block, the size line on each product card, and whether the
  // roster section exists at all.
  const personWise = isPersonWiseOrder(request);
  const persons = personWise ? personsOnOrder(request.items || []) : [];

  // Letterhead + product photos, fetched before any drawing so the page flow
  // is synchronous once it starts.
  const [letterhead, stockItems] = await Promise.all([
    // PRODUCTION'S OWN LETTERHEAD, falling back to the store's.
    //
    // This sheet used to head itself from the `store` record purely because
    // that was the only scope in existence. Production now has its own (see
    // routes/CMS_Routes/Manufacturing/productionPdfSettingsRoutes.js) so the
    // Project Manager can set the header on their own document. The fallback
    // matters: a fresh `production` record is created empty, and an empty
    // letterhead would silently replace a store address that was correct.
    StoreSettings.get("production")
      .then(async (p) => {
        const filled = p && [p.addressLine1, p.addressLine2, p.city, p.phone, p.gstin].some((v) => String(v || "").trim());
        return filled ? p : StoreSettings.get("store").catch(() => p);
      })
      .catch(() => null),
    StockItem.find({ _id: { $in: (request.items || []).map((i) => i.stockItemId).filter(Boolean) } })
      .select("name reference images").lean().catch(() => []),
  ]);
  const stockById = new Map((stockItems || []).map((s) => [String(s._id), s]));
  const photos = new Map();
  await Promise.all(
    (stockItems || []).map(async (s) => {
      const buf = await fetchImageBuffer((s.images || [])[0]);
      if (buf) photos.set(String(s._id), buf);
    }),
  );

  const doc = new PDFDocument({ size: "A4", margin: MARGIN, info: {
    Title: `Manufacturing Order MO-${request.requestId}`,
    Author: "GRAV Clothing",
    Subject: `${origin.label} — ${personWise ? "person-wise" : "size-wise"} production summary`,
  } });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  // ── Letterhead ──────────────────────────────────────────────────────────
  let y = MARGIN;
  doc.font("Helvetica-Bold").fontSize(17).fillColor(INK).text("GRAV CLOTHING", MARGIN, y);
  y = doc.y + 2;
  const addr = [
    letterhead?.addressLine1, letterhead?.addressLine2,
    [letterhead?.city, letterhead?.state, letterhead?.pincode].filter(Boolean).join(", "),
    letterhead?.phone ? `Phone: ${letterhead.phone}` : null,
    letterhead?.gstin ? `GSTIN: ${letterhead.gstin}` : null,
  ].filter(Boolean).join("\n") || "Bhubaneswar, Odisha, India";
  doc.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(addr, MARGIN, y, { width: CONTENT_W * 0.6, lineGap: 1.5 });

  // Document title block, right-aligned.
  doc.font("Helvetica-Bold").fontSize(13).fillColor(INK)
    .text("MANUFACTURING ORDER", MARGIN + CONTENT_W * 0.55, MARGIN, { width: CONTENT_W * 0.45, align: "right" });
  doc.font("Helvetica-Bold").fontSize(11).fillColor(INK)
    .text(`MO-${request.requestId}`, MARGIN + CONTENT_W * 0.55, doc.y + 2, { width: CONTENT_W * 0.45, align: "right" });
  doc.font("Helvetica").fontSize(8.5).fillColor(MUTED)
    .text(`Raised ${prettyDateTime(request.createdAt || Date.now())}`, MARGIN + CONTENT_W * 0.55, doc.y + 2, { width: CONTENT_W * 0.45, align: "right" });

  y = Math.max(doc.y, y + 52) + 8;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_W, y).lineWidth(1.2).strokeColor(INK).stroke();
  y += 14;

  // ── ORDER TYPE — the first thing the PM must see ────────────────────────
  // Called out in its own banner rather than as one row among many: the whole
  // point of the request was that a sampling run must not be mistaken for a
  // customer's order at a glance.
  y = ensure(doc, y, 46);
  doc.roundedRect(MARGIN, y, CONTENT_W, 38, 4).fillAndStroke(HEAD_BG, RULE);
  doc.font("Helvetica").fontSize(8).fillColor(MUTED).text("ORDER TYPE", MARGIN + 12, y + 7, { characterSpacing: 0.8 });
  doc.font("Helvetica-Bold").fontSize(12).fillColor(INK).text(origin.label, MARGIN + 12, y + 18);
  doc.font("Helvetica").fontSize(8).fillColor(MUTED)
    .text(origin.description, MARGIN + 150, y + 12, { width: CONTENT_W - 162, lineGap: 1.5 });
  y += 50;

  // ── Order particulars ───────────────────────────────────────────────────
  y = sectionTitle(doc, y, "Order particulars");
  const totalQty = (request.items || []).reduce((s, i) => s + (i.totalQuantity || 0), 0);
  y = row(doc, y, "Order shape", personWise ? "Person-wise (measurement conversion)" : "Size-wise (bulk)");
  y = row(doc, y, "Customer", request.customerInfo?.name || "—");
  if (personWise && request.measurementName) y = row(doc, y, "Measurement drive", request.measurementName);
  if (request.customerInfo?.email) y = row(doc, y, "Customer email", request.customerInfo.email);
  if (request.customerInfo?.phone) y = row(doc, y, "Customer phone", request.customerInfo.phone);
  y = row(doc, y, "Priority", String(request.priority || "medium").toUpperCase());
  y = row(doc, y, "Delivery deadline", prettyDate(request.customerInfo?.deliveryDeadline));
  y = row(doc, y, "Total quantity", `${totalQty} pcs`);
  if (personWise) y = row(doc, y, "People on this order", persons.length ? String(persons.length) : "roster not recorded");
  y = row(doc, y, "Work orders raised", String(workOrders.length));
  y = row(doc, y, "Products", String((request.items || []).length));
  if (request.customerInfo?.description) y = row(doc, y, "Notes", request.customerInfo.description);
  y += 6;

  // ── Products ────────────────────────────────────────────────────────────
  y = sectionTitle(doc, y, "Products in this order");
  for (const item of request.items || []) {
    const stock = stockById.get(String(item.stockItemId));
    const photo = photos.get(String(item.stockItemId));
    const cardH = 92;
    y = ensure(doc, y, cardH + 8);

    doc.roundedRect(MARGIN, y, CONTENT_W, cardH, 4).strokeColor(RULE).lineWidth(0.8).stroke();

    // Photo, or a labelled placeholder — drawn as a box FIRST so a decode
    // failure leaves a tidy empty frame rather than a gap.
    const px = MARGIN + 8, py = y + 8, pw = 72, ph = cardH - 16;
    doc.rect(px, py, pw, ph).fillAndStroke(HEAD_BG, RULE);
    if (photo) {
      try { doc.image(photo, px, py, { fit: [pw, ph], align: "center", valign: "center" }); }
      catch { /* undecodable — the placeholder box stands */ }
    } else {
      doc.font("Helvetica").fontSize(7).fillColor(MUTED)
        .text("no photo", px, py + ph / 2 - 4, { width: pw, align: "center" });
    }

    const tx = px + pw + 12;
    const tw = CONTENT_W - (tx - MARGIN) - 12;
    doc.font("Helvetica-Bold").fontSize(11).fillColor(INK)
      .text(item.stockItemName || stock?.name || "Unnamed product", tx, y + 10, { width: tw });
    doc.font("Helvetica").fontSize(8.5).fillColor(MUTED)
      .text(item.stockItemReference || stock?.reference || "", tx, doc.y + 1, { width: tw });

    doc.font("Helvetica-Bold").fontSize(9.5).fillColor(INK)
      .text(`${item.totalQuantity || 0} pcs`, tx, doc.y + 4, { width: tw });

    // ── THE SIZE BREAKDOWN, AND WHY IT COMES FROM DIFFERENT PLACES ───────
    //
    // Size-wise: `request.items[].variants[]` is the truth — quantities per
    //   size are exactly what was ordered.
    //
    // Person-wise: it is NOT. Measurement conversion originally writes every
    //   person onto `stockItem.variants[0]`, and the real per-person sizes are
    //   re-resolved later, at work-order time
    //   (quotationRoutes.js's `resolveMeasurementRequestItems`). The row on
    //   disk stays stale, so printing sizes from it would confidently show the
    //   wrong size for most of the order. The WORK ORDERS carry the corrected
    //   variant, so that is what is summarised here instead.
    const sizeLine = personWise
      ? (() => {
          const mine = workOrders.filter((w) => String(w.stockItemId) === String(item.stockItemId));
          if (!mine.length) return "";
          const bySize = new Map();
          for (const w of mine) {
            const label = (w.variantAttributes || []).map((a) => a?.value).filter(Boolean).join(" / ") || "base";
            bySize.set(label, (bySize.get(label) || 0) + (Number(w.quantity) || 0));
          }
          return [...bySize].map(([k, v]) => `${k} × ${v}`).join("   ·   ");
        })()
      : (item.variants || [])
          .map((v) => {
            const attrs = Array.isArray(v.attributes)
              ? v.attributes.map((a) => a?.value).filter(Boolean).join(" / ")
              : "";
            return `${attrs || "base"} × ${v.quantity || 0}`;
          })
          .join("   ·   ");

    if (sizeLine) {
      doc.font("Helvetica").fontSize(8).fillColor(MUTED)
        .text(sizeLine, tx, doc.y + 3, { width: tw, lineGap: 1.5 });
    }
    y += cardH + 8;
  }

  // ── WHO THIS IS BEING MADE FOR (person-wise orders only) ────────────────
  //
  // The roster is the whole point of a measurement conversion: the floor is
  // making a named individual's garment to their own measured size, not N of
  // a size. Column order and wording deliberately match the on-screen
  // Employee Tracking report (components/packaging-dispatch/
  // EmployeeTrackingPDF.js) so the two are recognisably the same document.
  if (personWise) {
    y = sectionTitle(doc, y, `Person-wise roster (${persons.length} ${persons.length === 1 ? "person" : "people"})`);

    if (!persons.length) {
      // Said plainly rather than printing an empty table. A converted order
      // raised before the roster field existed genuinely has no per-person
      // list on it — that is a gap in the record, not zero people, and the
      // two must not look alike.
      doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(
        "No per-person roster was recorded on this order. The people and their sizes are held on the " +
        `measurement drive${request.measurementName ? ` “${request.measurementName}”` : ""}; open it in the CMS for the full list.`,
        MARGIN, y, { width: CONTENT_W, lineGap: 2 },
      );
      y = doc.y + 12;
    } else {
      const pcols = [
        { label: "#", w: 0.05 },
        { label: "NAME / UIN", w: 0.28 },
        { label: "DEPARTMENT", w: 0.22 },
        { label: "GARMENTS (QTY)", w: 0.35 },
        { label: "QTY", w: 0.10 },
      ];
      y = ensure(doc, y, 26);
      doc.rect(MARGIN, y, CONTENT_W, 18).fill(HEAD_BG);
      let hx = MARGIN + 6;
      pcols.forEach((c) => {
        doc.font("Helvetica-Bold").fontSize(7.5).fillColor(MUTED)
          .text(c.label, hx, y + 5.5, { width: CONTENT_W * c.w - 8, characterSpacing: 0.5 });
        hx += CONTENT_W * c.w;
      });
      y += 18;

      persons.forEach((p, i) => {
        const garments = (p.garments || []).map((g) => {
          const attrs = (g.attributes || []).map((a) => a?.value).filter(Boolean).join(" / ");
          return `${g.stockItemName}${attrs ? ` (${attrs})` : ""} ×${g.quantity}`;
        });
        // Two lines for the name block, plus one per garment beyond the first.
        const rowH = Math.max(26, 14 + Math.max(garments.length, 2) * 10);
        y = ensure(doc, y, rowH + 2);
        if (i % 2 === 1) doc.rect(MARGIN, y, CONTENT_W, rowH).fill("#FAFAFB");

        let cx2 = MARGIN + 6;
        const put = (fn, w) => { fn(cx2, CONTENT_W * w - 8); cx2 += CONTENT_W * w; };

        put((x, w) => doc.font("Helvetica").fontSize(8).fillColor(MUTED)
          .text(String(i + 1), x, y + 6, { width: w }), pcols[0].w);

        put((x, w) => {
          doc.font("Helvetica-Bold").fontSize(8.5).fillColor(INK)
            .text(p.employeeName || "—", x, y + 5, { width: w, ellipsis: true, lineBreak: false });
          doc.font("Helvetica").fontSize(7.5).fillColor(MUTED)
            .text(p.employeeUIN || "—", x, y + 15, { width: w, ellipsis: true, lineBreak: false });
        }, pcols[1].w);

        put((x, w) => doc.font("Helvetica").fontSize(8).fillColor(INK)
          .text(p.department || "—", x, y + 6, { width: w, ellipsis: true, lineBreak: false }), pcols[2].w);

        put((x, w) => {
          let gy = y + 5;
          (garments.length ? garments : ["—"]).forEach((g) => {
            doc.font("Helvetica").fontSize(7.8).fillColor(INK)
              .text(g, x, gy, { width: w, ellipsis: true, lineBreak: false });
            gy += 10;
          });
        }, pcols[3].w);

        put((x, w) => doc.font("Helvetica-Bold").fontSize(8.5).fillColor(INK)
          .text(String(p.totalQuantity || 0), x, y + 6, { width: w }), pcols[4].w);

        y += rowH;
        doc.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_W, y).lineWidth(0.4).strokeColor(RULE).stroke();
      });
      y += 10;
    }
  }

  // ── MATERIAL REQUIREMENT (Merchandising's sheet) ────────────────────────
  //
  // Consolidated across every work order, because that is the question
  // procurement actually asks: not "what does one garment need" but "what does
  // this whole run consume". Read off the work orders rather than the stock
  // items, since the WO already carries the quantity scaled to what is being
  // made (see createWorkOrdersAndProgress).
  if (show.materials) {
    // Field names taken from the WorkOrder's real `rawMaterials` subdocument:
    // `name` / `sku` / `quantityRequired` / `unit`, plus the variant
    // combination (e.g. ["Normal"]) which distinguishes two rolls of the same
    // item. Keyed on name+variant+unit so the same material in two different
    // variants stays two procurement lines rather than being silently summed.
    const byMaterial = new Map();
    for (const wo of workOrders) {
      for (const rm of wo.rawMaterials || []) {
        const variant = Array.isArray(rm.rawItemVariantCombination)
          ? rm.rawItemVariantCombination.filter(Boolean).join(" / ")
          : "";
        const name = rm.name || "—";
        const key = `${name}|${variant}|${rm.unit || ""}`;
        const cur = byMaterial.get(key) || {
          name,
          variant,
          reference: rm.sku || "",
          unit: rm.unit || "",
          qty: 0,
        };
        cur.qty += Number(rm.quantityRequired ?? 0) || 0;
        byMaterial.set(key, cur);
      }
    }
    const materials = [...byMaterial.values()].sort((a, b) => a.name.localeCompare(b.name));

    y = sectionTitle(doc, y, `Material requirement (${materials.length})`);
    if (!materials.length) {
      doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(
        "No material requirement is recorded against this order's work orders. The Bill of Materials may not " +
        "have been set on the product — verify before procuring.",
        MARGIN, y, { width: CONTENT_W, lineGap: 2 },
      );
      y = doc.y + 12;
    } else {
      const mcols = [
        { label: "MATERIAL", w: 0.38 },
        { label: "VARIANT", w: 0.16 },
        { label: "REFERENCE", w: 0.26 },
        { label: "REQUIRED", w: 0.20 },
      ];
      y = ensure(doc, y, 26);
      doc.rect(MARGIN, y, CONTENT_W, 18).fill(HEAD_BG);
      let mx = MARGIN + 6;
      mcols.forEach((c) => {
        doc.font("Helvetica-Bold").fontSize(7.5).fillColor(MUTED)
          .text(c.label, mx, y + 5.5, { width: CONTENT_W * c.w - 8, characterSpacing: 0.5 });
        mx += CONTENT_W * c.w;
      });
      y += 18;

      for (const m of materials) {
        y = ensure(doc, y, 20);
        let cx3 = MARGIN + 6;
        const cells = [
          { v: m.name, bold: true },
          { v: m.variant || "—", bold: false },
          { v: m.reference || "—", bold: false },
          { v: `${Math.round(m.qty * 1000) / 1000} ${m.unit}`.trim(), bold: true },
        ];
        cells.forEach((c, i) => {
          doc.font(c.bold ? "Helvetica-Bold" : "Helvetica").fontSize(8.5).fillColor(c.bold ? INK : MUTED)
            .text(String(c.v), cx3, y + 4, { width: CONTENT_W * mcols[i].w - 8, ellipsis: true, lineBreak: false });
          cx3 += CONTENT_W * mcols[i].w;
        });
        y += 18;
        doc.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_W, y).lineWidth(0.4).strokeColor(RULE).stroke();
      }
      y += 6;
      doc.font("Helvetica").fontSize(7.5).fillColor(MUTED).text(
        "Consolidated across every work order on this order, at the quantities actually released to production.",
        MARGIN, y, { width: CONTENT_W },
      );
      y = doc.y + 10;
    }
  }

  // ── Work orders ─────────────────────────────────────────────────────────
  if (show.workOrders) {
  y = sectionTitle(doc, y, `Work orders (${workOrders.length})`);
  if (!workOrders.length) {
    doc.font("Helvetica").fontSize(9).fillColor(MUTED)
      .text("No work orders were raised against this order.", MARGIN, y, { width: CONTENT_W });
    y = doc.y + 10;
  } else {
    // Table header
    y = ensure(doc, y, 24);
    const cols = [
      { label: "WORK ORDER", w: 0.30 },
      { label: "PRODUCT", w: 0.38 },
      { label: "QTY", w: 0.14 },
      { label: "STATUS", w: 0.18 },
    ];
    doc.rect(MARGIN, y, CONTENT_W, 18).fill(HEAD_BG);
    let cx = MARGIN + 6;
    cols.forEach((c) => {
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor(MUTED)
        .text(c.label, cx, y + 5.5, { width: CONTENT_W * c.w - 8, characterSpacing: 0.5 });
      cx += CONTENT_W * c.w;
    });
    y += 18;

    for (const wo of workOrders) {
      y = ensure(doc, y, 20);
      cx = MARGIN + 6;
      const cells = [
        workOrderLabel(wo),
        wo.stockItemName || wo.productName || "—",
        String(wo.quantity ?? wo.totalQuantity ?? "—"),
        String(wo.status || "pending").replace(/_/g, " "),
      ];
      cells.forEach((val, i) => {
        doc.font(i === 0 ? "Helvetica-Bold" : "Helvetica").fontSize(8.5).fillColor(INK)
          .text(val, cx, y + 4, { width: CONTENT_W * cols[i].w - 8, ellipsis: true, lineBreak: false });
        cx += CONTENT_W * cols[i].w;
      });
      y += 18;
      doc.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_W, y).lineWidth(0.4).strokeColor(RULE).stroke();
    }
    y += 10;
  }
  }

  // ── Footer note ─────────────────────────────────────────────────────────
  y = ensure(doc, y, 50);
  doc.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_W, y).lineWidth(0.6).strokeColor(RULE).stroke();
  y += 8;
  doc.font("Helvetica").fontSize(7.5).fillColor(MUTED).text(
    origin.key === "sampling"
      ? "This is a SAMPLING order — produced to prove or develop a garment. It is not against a customer purchase order, and no customer delivery commitment attaches to it."
      : origin.key === "testing"
        ? "This is a TESTING order — raised to trial a process or machine. It is not for delivery."
        : origin.key === "internal"
          ? "This is an INTERNAL order — funded by the company rather than an external customer."
          : "System-generated summary of the manufacturing order named above. Quantities and specifications are as released by Sales at the time of this document.",
    MARGIN, y, { width: CONTENT_W, lineGap: 2 },
  );
  doc.font("Helvetica").fontSize(7).fillColor(MUTED)
    .text(`Generated ${prettyDateTime(Date.now())} · GRAV Manufacturing Suite`, MARGIN, doc.y + 6, { width: CONTENT_W });

  doc.end();
  return done;
}

module.exports = { buildManufacturingOrderPdf };
