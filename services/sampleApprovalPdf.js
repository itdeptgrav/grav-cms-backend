// services/sampleApprovalPdf.js
//
// Server-side twin of grav-clothing's ProductApprovalPDFGenerator.js — same
// content (photo, full specification, description, terms; deliberately NO
// price, see that file's own header comment), built with pdfkit instead of
// @react-pdf/renderer because this is a plain Node backend with no JSX
// build step. pdfkit is already a dependency here, used the same way for
// invoices (routes/Accountant_Routes/Acc_invoices.js).
//
// Exists for exactly one caller (26 Aug 2026): sampleWhatsapp.js needs
// actual PDF bytes to attach as the product_approval WhatsApp template's
// document header — Meta requires a real document on every send, it does
// not reuse the template's own example file. The in-app "Download sample
// PDF" button keeps using the React version; this is not a replacement for
// it, just the same document available where there's no browser.
"use strict";

const PDFDocument = require("pdfkit");
const StockItem = require("../models/CMS_Models/Inventory/Products/StockItem");
const Account = require("../models/CMS_Models/Sales/Account");
const ModuleSettings = require("../models/CMS_Models/Inventory/Operations/StoreSettings");

const PAGE_W = 595.28; // A4 points
const MARGIN = 40;
const CONTENT_W = PAGE_W - MARGIN * 2;

const SAMPLE_TERMS = [
  "This sheet confirms the sample's specification and appearance only. It is not a price quotation, invoice, or order confirmation.",
  "Bulk production may show minor variation from this sample in colour, fabric handfeel and trims, within normal industry tolerance.",
  "Approval or rejection should be communicated in writing (reply to the message this sheet was sent with, or by signing and returning this sheet).",
  "Pricing, payment terms and delivery schedule are shared separately once the sample is approved.",
  "This approval request is valid for 15 days from the date below unless a different validity was communicated.",
];

const prettyDateTime = (d) =>
  new Date(d).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** A Drive/Cloudinary image record OR a bare url string → a fetchable URL. */
function imageUrl(img) {
  if (!img) return null;
  const raw = typeof img === "string" ? img : img.fileId ? `https://lh3.googleusercontent.com/d/${img.fileId}=w600` : img.url || null;
  if (!raw) return null;
  // pdfkit's doc.image() only decodes JPEG/PNG — it throws on WebP, which is
  // what most references get uploaded as (confirmed 26 Aug 2026: the exact
  // photo that came through blank in the delivered WhatsApp PDF was a
  // Cloudinary .webp). Cloudinary can re-encode on the fly via an
  // f_jpg transformation segment, so ask for that instead of falling back
  // to a placeholder whenever we can.
  const m = raw.match(/^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(.*)$/);
  return m ? `${m[1]}f_jpg/${m[2]}` : raw;
}

/**
 * Best-effort image bytes, one retry, never throws — a missing/unreachable
 * photo degrades to no photo, not a failed PDF (same discipline as the
 * frontend's resolveImageDataUri).
 */
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
        console.warn("[sampleApprovalPdf] photo fetch failed:", err.message);
        return null;
      }
    }
  }
  return null;
}

/** The customer's company + contact details, live off the CRM account. */
async function loadAccountDetails(accountId) {
  if (!accountId) return null;
  try {
    return await Account.findById(accountId)
      .select("companyName gstNumber address city state primaryPhone primaryEmail")
      .populate("primaryContact", "firstName lastName phone email designation")
      .lean();
  } catch {
    return null;
  }
}

/** Live StockItem image/reference when this style is linked to one, else null. */
async function loadStockItem(stockItemId) {
  if (!stockItemId) return null;
  try {
    return await StockItem.findById(stockItemId).select("images reference").lean();
  } catch {
    return null;
  }
}

function drawWrappedRow(doc, x, y, w, label, value) {
  doc.font("Helvetica").fontSize(9).fillColor("#777").text(label, x, y, { width: w * 0.45 });
  doc.font("Helvetica-Bold").fontSize(9.5).fillColor("#111").text(String(value), x + w * 0.45, y, { width: w * 0.55 });
}

/**
 * @param {object} style A SampleStyle Mongoose document (or lean object)
 *   with brief/accountId/sourceStockItemId/sourceStockItemReference/
 *   productName populated.
 * @param {object} [opts]
 * @param {string} [opts.customerName] Fallback if the account has no companyName.
 * @param {string} [opts.enquiryRef] Journey/enquiry reference to show in the header.
 * @param {string} [opts.preparedBy] Who triggered this send.
 * @returns {Promise<Buffer>}
 */
async function buildApprovalPdf(style, opts = {}) {
  const [salesSettings, account, stockItem] = await Promise.all([
    ModuleSettings.get("sales").catch(() => null),
    loadAccountDetails(style.accountId),
    loadStockItem(style.sourceStockItemId),
  ]);

  const brief = style.brief || {};
  const images = (stockItem?.images?.length ? stockItem.images : brief.images) || [];
  const heroBuffer = await fetchImageBuffer(images[0]);

  const companyName = account?.companyName || opts.customerName || "Customer";
  const contact = account?.primaryContact;
  const contactName = contact ? [contact.firstName, contact.lastName].filter(Boolean).join(" ") : "";
  const addressLine = [account?.address, account?.city, account?.state].filter(Boolean).join(", ");

  const facts = [
    ["Colour", brief.colour],
    ["Fabric", brief.fabricPreference],
    ["Composition", brief.fabricComposition],
    ["GSM", brief.gsm],
    ["Fit", brief.fit],
    ["Size range", brief.sizeRange],
    ["Gender / wearer", brief.gender],
    ["Trims & accessories", brief.trims],
    ["Special construction", brief.specialConstruction],
    ["Branding", brief.branding],
    ["Branding placement", brief.brandingPlacement],
    ["Quantity requested", brief.quantity ? `${Number(brief.quantity).toLocaleString("en-IN")} pcs` : null],
    ...(brief.customSpecs || []).filter((s) => s?.label).map((s) => [s.label, s.value]),
    // Unfilled fields dropped entirely, not shown as "Not specified" (26 Aug
    // 2026, explicit request — reverses the earlier "show every field" call:
    // "some input which are not specified are not needed to showcase").
  ].filter(([, v]) => v != null && String(v).trim() !== "");

  const doc = new PDFDocument({ size: "A4", margin: MARGIN });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  let y = MARGIN;

  // ── Header — company block (left) + badge (right) ──────────────────────
  //
  // The headline is the COMPANY, and every settings line sits beneath it
  // (26 Aug 2026, bug fix: "change the pdf header as per the provided
  // header... because u are writing something else"). This used to print
  // `storeName` — "Mayfair Lagoon Campus", a premises — in bold as though it
  // were the business name. Mirrors grav-clothing's pdfChrome.js PdfHeader
  // and QuotationPDFGenerator, which are the letterhead of record; keep the
  // three in step.
  const salesLines = [
    salesSettings?.storeName,
    salesSettings?.addressLine1 || "Mayfair Lagoon Campus 8B, Jayadev Vihar",
    salesSettings?.addressLine2 || "Regional Research Laboratory, Khorda",
    [
      [salesSettings?.city, salesSettings?.state || "Orissa", salesSettings?.country].filter(Boolean).join(", "),
      salesSettings?.pincode && `– ${salesSettings.pincode}`,
    ].filter(Boolean).join(" "),
    [
      `GSTIN: ${salesSettings?.gstin || "27AABCU9603R1ZM"}`,
      `Ph: ${salesSettings?.phone || "+91 22 1234 5678"}`,
      salesSettings?.email,
    ].filter(Boolean).join("  |  "),
    salesSettings?.contactPerson && `Contact: ${salesSettings.contactPerson}`,
  ].filter(Boolean);
  doc.font("Helvetica-Bold").fontSize(17).fillColor("#111").text("GRAV CLOTHING", MARGIN, y, { width: CONTENT_W * 0.6 });
  y = doc.y + 3;
  doc.font("Helvetica").fontSize(8.5).fillColor("#555");
  for (const line of salesLines) { doc.text(line, MARGIN, y, { width: CONTENT_W * 0.6 }); y = doc.y; }

  doc.roundedRect(MARGIN + CONTENT_W * 0.62, MARGIN, CONTENT_W * 0.38, 52, 3).stroke("#ccc");
  doc.font("Helvetica-Bold").fontSize(12.5).fillColor("#111").text("SAMPLE FOR APPROVAL", MARGIN + CONTENT_W * 0.62 + 8, MARGIN + 9, { width: CONTENT_W * 0.38 - 16 });
  doc.font("Helvetica").fontSize(8.5).fillColor("#666").text(opts.enquiryRef || "", MARGIN + CONTENT_W * 0.62 + 8, MARGIN + 27, { width: CONTENT_W * 0.38 - 16 });
  doc.text(prettyDateTime(new Date()), MARGIN + CONTENT_W * 0.62 + 8, MARGIN + 38, { width: CONTENT_W * 0.38 - 16 });

  y = Math.max(y, MARGIN + 52) + 12;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_W, y).lineWidth(1.5).stroke("#222");
  y += 16;

  // ── Sample for / Sample details ─────────────────────────────────────────
  const boxW = (CONTENT_W - 12) / 2;
  const box1Y = y;
  const box1H = 80;
  doc.roundedRect(MARGIN, y, boxW, box1H, 3).stroke("#ddd");
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#555").text("SAMPLE FOR", MARGIN + 10, y + 10);
  doc.font("Helvetica-Bold").fontSize(10.5).fillColor("#111").text(companyName, MARGIN + 10, y + 23, { width: boxW - 20 });
  let by = doc.y + 3;
  doc.font("Helvetica").fontSize(8.5).fillColor("#444");
  if (account?.gstNumber) { doc.text(`GSTIN: ${account.gstNumber}`, MARGIN + 10, by, { width: boxW - 20 }); by = doc.y; }
  if (addressLine) { doc.text(addressLine, MARGIN + 10, by, { width: boxW - 20 }); by = doc.y; }
  if (contactName) { doc.text(`Contact: ${contactName}${contact?.designation ? `, ${contact.designation}` : ""}`, MARGIN + 10, by, { width: boxW - 20 }); }

  doc.roundedRect(MARGIN + boxW + 12, box1Y, boxW, box1H, 3).stroke("#ddd");
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#555").text("SAMPLE DETAILS", MARGIN + boxW + 22, box1Y + 10);
  drawWrappedRow(doc, MARGIN + boxW + 22, box1Y + 26, boxW - 18, "Status", "Pending");
  drawWrappedRow(doc, MARGIN + boxW + 22, box1Y + 41, boxW - 18, "Prepared by", opts.preparedBy || "Sales Team");
  drawWrappedRow(doc, MARGIN + boxW + 22, box1Y + 56, boxW - 18, "Prepared on", prettyDateTime(new Date()));

  y = box1Y + box1H + 16;

  // ── Product card ─────────────────────────────────────────────────────────
  const cardTop = y;
  doc.font("Helvetica-Bold").fontSize(16).fillColor("#111").text(style.productName || "Product", MARGIN + 10, y + 12, { width: CONTENT_W - 20 });
  y = doc.y + 3;
  const qty = brief.quantity ? `${Number(brief.quantity).toLocaleString("en-IN")} pcs` : null;
  const ref = stockItem?.reference || style.sourceStockItemReference || brief.stockItemReference || null;
  doc.font("Helvetica").fontSize(9).fillColor("#666").text([qty, ref].filter(Boolean).join("   ·   ") || "—", MARGIN + 10, y, { width: CONTENT_W - 20 });
  y = doc.y + 10;
  doc.moveTo(MARGIN + 10, y).lineTo(MARGIN + CONTENT_W - 10, y).lineWidth(0.5).stroke("#eee");
  y += 10;

  // Bigger throughout (26 Aug 2026, "increase the pdf look size if
  // possible") — the sheet is read on a phone inside WhatsApp's PDF viewer,
  // where the earlier, denser sizing read as cramped/hard to make out.
  const photoX = MARGIN + 10, photoY = y, photoW = 170, photoH = 220;
  // Draw the fallback FIRST, the real photo on top only if it actually
  // renders — a bug fix, not just a size change (26 Aug 2026, "the pdf is
  // not showing properly"): pdfkit throws on some fetched bytes (an
  // unsupported format, a truncated download) and the old code swallowed
  // that error without ever drawing anything, leaving a blank hole where a
  // photo OR a placeholder should have been.
  doc.roundedRect(photoX, photoY, photoW, photoH, 3).fillAndStroke("#f5f5f5", "#ddd");
  let photoDrawn = false;
  if (heroBuffer) {
    try { doc.image(heroBuffer, photoX, photoY, { fit: [photoW, photoH] }); photoDrawn = true; }
    catch (err) { console.warn("[sampleApprovalPdf] doc.image() failed:", err.message); }
  }
  if (!photoDrawn) {
    doc.font("Helvetica").fontSize(9).fillColor("#aaa").text(
      heroBuffer ? "Reference photo could not be loaded" : "No reference photo",
      photoX + 8, photoY + photoH / 2 - 6, { width: photoW - 16, align: "center" },
    );
  }

  const factsX = photoX + photoW + 18, factsW = CONTENT_W - 20 - photoW - 18;
  let fy = photoY;
  doc.font("Helvetica-Bold").fillColor("#111");
  for (const [k, v] of facts) {
    if (fy > photoY + photoH - 10) break; // don't run the facts list past the photo's bottom
    drawWrappedRow(doc, factsX, fy, factsW, k, v);
    fy += 17;
  }
  y = Math.max(photoY + photoH, fy) + 14;

  if (brief.note) {
    doc.moveTo(MARGIN + 10, y).lineTo(MARGIN + CONTENT_W - 10, y).lineWidth(0.5).stroke("#eee");
    y += 10;
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#888").text("DESCRIPTION", MARGIN + 10, y);
    y = doc.y + 4;
    doc.font("Helvetica").fontSize(10).fillColor("#333").text(brief.note, MARGIN + 10, y, { width: CONTENT_W - 20 });
    y = doc.y;
  }
  doc.roundedRect(MARGIN, cardTop, CONTENT_W, y - cardTop + 10, 4).stroke("#ddd");
  y += 20;

  // ── Ask box ──────────────────────────────────────────────────────────────
  doc.roundedRect(MARGIN, y, CONTENT_W, 52, 3).fillAndStroke("#fafafa", "#ddd");
  doc.font("Helvetica-Bold").fontSize(10.5).fillColor("#111").text("Please confirm this sample", MARGIN + 12, y + 10, { width: CONTENT_W - 24 });
  doc.font("Helvetica").fontSize(9).fillColor("#555").text(
    "Review the sample and the specification above, then reply to confirm — Yes to approve, No to reject.",
    MARGIN + 12, y + 25, { width: CONTENT_W - 24 },
  );
  y += 66;

  // ── Terms ────────────────────────────────────────────────────────────────
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#555").text("TERMS & CONDITIONS", MARGIN, y);
  y = doc.y + 5;
  doc.font("Helvetica").fontSize(8).fillColor("#555");
  SAMPLE_TERMS.forEach((t, i) => {
    doc.text(`${i + 1}. ${t}`, MARGIN, y, { width: CONTENT_W });
    y = doc.y + 3;
  });

  doc.end();
  return done;
}

module.exports = { buildApprovalPdf };
