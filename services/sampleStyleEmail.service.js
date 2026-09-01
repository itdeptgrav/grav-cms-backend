// services/sampleStyleEmail.service.js
//
// Shared building blocks for every Style & Sample hand-off email AND for the
// Project Manager's BOM decision page (routes/CMS_Routes/Sales/sampleStyles.js
// and sampleBomApproval.js both use this) — pulled out to its own file rather
// than left in sampleStyles.js once sampleBomApproval.js needed the exact same
// customer/product/photo/BOM context to render its page (28 Aug 2026). Two
// copies of "how do we describe this style" would inevitably drift; the page
// the Project Manager decides on must say EXACTLY what the email that brought
// them there said.
//
// 28 Aug 2026, explicit request, after the BOM approval email came back
// missing its photo: "make sure ki every mail should attach with that
// customer details and the corresponding product details and the product
// photo also". And separately: "in that bom approval mail, make sure to also
// attach the Bom ok means the raw materials and there consumption and there
// units and all" — see bomTableHtml below.
//
// FOLLOW-UP FIX, same day: the BOM table came back EMPTY even for a style
// that visibly had raw items in the CMS. Root cause — `style.materials.
// rawItems` is a legacy field from a picking form removed 26 Aug 2026; the
// REAL bill of materials the Style & Sample stage reads (StockItemBomPanel →
// GET /:id/production) is derived from the LINKED STOCK ITEM's own
// variant-level BOM (`StockItem.variants[].rawItems[]`), rolled up by
// `stockItemBom()` below — moved here from sampleStyles.js so this file reads
// the exact same source the CMS panel does, not a field that's been unused
// since before this feature existed. Also fixed the same day: a dangling
// `accountId` (an Account deleted after its Journey was created) made
// `customerName` fall all the way to a bare "—", which read as "customer
// information skipped" — it now falls back to the Journey's own name, which
// stays resolvable even when the Account underneath it is gone.

const Account = require("../models/CMS_Models/Sales/Account");
const StockItem = require("../models/CMS_Models/Inventory/Products/StockItem");
const Enquiry = require("../models/CMS_Models/Sales/Enquiry");
const SalesJourney = require("../models/CMS_Models/Sales/SalesJourney");
const { APP_URL: DEPT_NOTIFY_APP_URL, imageUrlFor, escapeHtml } = require("./departmentNotify.service");

/** Every reference photo for a style, newest source first. */
async function styleImages(style) {
  const own = style?.brief?.images || [];
  if (own.length) return own;
  if (!style?.enquiryId) return [];
  const enq = await Enquiry.findById(style.enquiryId).select("products").lean();
  return enq?.products?.find((p) => p.product === style.productName)?.images || [];
}

/** The linked finished good — same precedence the rest of this module uses. */
const linkedStockItemId = (style) => style?.production?.stockItemId || style?.sourceStockItemId || null;

/**
 * The finished good's Bill of Materials, de-duped across variants — THE SAME
 * computation GET /:id/production uses to feed StockItemBomPanel (moved here
 * from routes/CMS_Routes/Sales/sampleStyles.js, 28 Aug 2026, so the Style &
 * Sample stage, the BOM-approval email, and the decision page can never show
 * three different answers to "what raw items does this product need"). A
 * StockItem has no top-level `rawItems`; the BOM hangs off each variant and
 * has to be walked and merged, which is the step the now-removed
 * materials-picking form's `style.materials.rawItems` never did (that field
 * only ever held what a Merchandiser typed by hand into the old form — for
 * every style raised since 26 Aug 2026, it is simply empty, which is exactly
 * why the BOM-approval email was reporting "no raw materials" for a product
 * that visibly had them in the CMS).
 *
 * @param {object|null} stockItem A lean StockItem with `variants[].rawItems`.
 * @returns {Array} `[{ rawItemId, rawItemName, rawItemSku, variantCombination, quantity, unit, allowancePercent, unitCost, totalCost, variantLabels[] }]`
 */
function stockItemBom(stockItem) {
  const variants = Array.isArray(stockItem?.variants) ? stockItem.variants : [];
  const byKey = new Map();
  for (const v of variants) {
    const label = Array.isArray(v.attributes)
      ? v.attributes.map((a) => a?.value).filter(Boolean).join(" / ")
      : "";
    for (const r of Array.isArray(v.rawItems) ? v.rawItems : []) {
      if (!r?.rawItemId) continue;
      const key = `${String(r.rawItemId)}::${String(r.variantId || "")}`;
      const existing = byKey.get(key);
      if (existing) {
        if (label && !existing.variantLabels.includes(label)) existing.variantLabels.push(label);
        continue;
      }
      byKey.set(key, {
        rawItemId: String(r.rawItemId),
        rawItemName: r.rawItemName || "",
        rawItemSku: r.rawItemSku || "",
        variantCombination: r.variantCombination || [],
        // Quantities are the variant rows' own `quantity`, which is already
        // the post-allowance effective figure (see StockItem's
        // variantRawItemSchema) — `allowancePercent` is carried through for
        // display only (R&D's Quantities step reads it) and must NOT be
        // applied again on top.
        quantity: r.quantity ?? null,
        unit: r.unit || "",
        allowancePercent: r.allowancePercent ?? 0,
        unitCost: r.unitCost ?? null,
        totalCost: r.totalCost ?? null,
        variantLabels: label ? [label] : [],
      });
    }
  }
  return [...byKey.values()];
}

/**
 * Customer, product spec, photos, the Bill of Materials, and the deep link —
 * the shared body of every style hand-off email AND the BOM decision page.
 *
 * `details` is deliberately long. A merchandiser filling a BOM, a Project
 * Manager approving one and R&D drawing a tech pack are each about to make a
 * decision from this alone; a two-row summary ("Customer / Product") is what
 * made the old notifications something you had to open the CMS to act on.
 * Empty fields drop out on their own — departmentNotify's `_row` (and this
 * module's own detailRowsHtml, for the decision page) skip them.
 */
async function styleEmailContext(style) {
  const [account, images] = await Promise.all([
    style.accountId
      ? Account.findById(style.accountId).select("displayName companyName primaryEmail primaryPhone city state").lean()
      : null,
    styleImages(style),
  ]);
  const stockItemId = linkedStockItemId(style);
  const stockItem = stockItemId
    ? await StockItem.findById(stockItemId).select("name reference category variants").lean()
    : null;
  const bom = stockItemBom(stockItem);
  const variantTotal = (stockItem?.variants || []).length;

  let customerName = account?.displayName || account?.companyName;
  if (!customerName) {
    // An in-house sample has no account and no journey to fall back to at
    // all — `style.journeyId` is null by design (1 Sept 2026 bug fix: this
    // fell through to the journey lookup below with a null id and landed on
    // a bare "—", which every email reading "Customer: —" made a house
    // sample look like a broken/incomplete record rather than the thing it
    // actually is).
    if (style.sampleType === "house") {
      customerName = "In-house sample — no customer";
    } else {
      // The Account this style's Journey pointed at is gone (a dangling
      // reference — observed live: an Account deleted after its Journey was
      // created). A bare "—" here IS the "customer information skipped" bug;
      // the Journey's own name is still resolvable and is a real identifier a
      // reader can act on, even when the Account underneath it no longer is.
      const journey = await SalesJourney.findById(style.journeyId).select("name").lean();
      customerName = journey?.name || "—";
    }
  }
  const b = style.brief || {};
  const finishes = [b.logo && "Logo", b.embroidery && "Embroidery", b.printing && "Printing"].filter(Boolean).join(", ");
  const customSpecs = (b.customSpecs || []).filter((s) => s?.label && s?.value).map((s) => [s.label, s.value]);

  const details = [
    ["Customer", customerName],
    ["Customer contact", [account?.primaryEmail, account?.primaryPhone].filter(Boolean).join(" · ") || undefined],
    ["Location", [account?.city, account?.state].filter(Boolean).join(", ") || undefined],
    ["Style code", style.styleCode || style.sampleStyleId],
    ["Product", style.productName],
    ["Variant", style.variantLabel || undefined],
    ["Registered as", stockItem ? `${stockItem.name}${stockItem.reference ? ` (${stockItem.reference})` : ""}` : undefined],
    ["Category", stockItem?.category || undefined],
    ["Quantity", b.quantity ? String(b.quantity) : undefined],
    ["Gender", b.gender || undefined],
    ["Colour", b.colour || undefined],
    ["Fabric", b.fabricPreference || undefined],
    ["Composition", b.fabricComposition || undefined],
    ["GSM", b.gsm || undefined],
    ["Fit", b.fit || undefined],
    ["Size range", b.sizeRange || undefined],
    ["Branding", [b.branding, b.brandingPlacement].filter(Boolean).join(" — ") || undefined],
    ["Finishes", finishes || undefined],
    ["Trims", b.trims || undefined],
    ["Special construction", b.specialConstruction || undefined],
    ["Existing uniform", b.existingUniform || undefined],
    ["Customer note", b.note || undefined],
    ...customSpecs,
  ];

  return {
    customerName,
    account,
    images,
    stockItemId,
    stockItem,
    bom,
    variantTotal,
    details,
    // "keep an button for View ok, so upon clcik on the view, redirect to the
    // /merchandiser/products/stock-item-view/<id> page" (28 Aug 2026). Only
    // when the style actually has a registered product behind it — a link to
    // /stock-item-view/null is worse than no button.
    viewUrl: stockItemId ? `${DEPT_NOTIFY_APP_URL}/merchandiser/products/stock-item-view/${stockItemId}` : null,
  };
}

/**
 * The reference photos, as an email-safe row of thumbnails.
 *
 * departmentNotify's own `imageUrl` slot takes exactly one picture; a garment
 * is normally captured from several angles, and the whole point of attaching
 * them is that the reader can SEE what is being asked for. Inline <img> rather
 * than real attachments: mail clients render these without a download, and
 * these are already-hosted Drive/Cloudinary assets, so re-uploading megabytes
 * onto every message would be pure waste.
 *
 * Renders from ONE photo up (28 Aug 2026 fix — this used to require at least
 * TWO, on the reasoning that a single photo was already shown as the top
 * banner image via departmentNotify's own `image`/`imageUrl` slot. That
 * reasoning didn't hold for the BOM-approval page, which has no such banner
 * slot and was rendering zero photos for a style that had exactly one — the
 * bug this was reported against. Showing the same single photo in both the
 * email's top banner AND this gallery is a harmless duplicate; showing it in
 * neither is the actual failure.)
 */
function imageGalleryHtml(images) {
  const urls = (images || []).map((img) => imageUrlFor(img, 260)).filter(Boolean);
  if (!urls.length) return "";
  return `<p style="margin:14px 0 4px;font-size:12px;color:#64748b;font-weight:600">REFERENCE IMAGES</p>
<div>${urls.slice(0, 6).map((u) => `<img src="${u}" alt="" style="display:inline-block;width:110px;height:110px;object-fit:cover;border-radius:6px;border:1px solid #e2e8f0;margin:0 6px 6px 0" />`).join("")}</div>`;
}

/**
 * The Bill of Materials itself — raw items, what they apply to, quantity and
 * unit — as a table. 28 Aug 2026, explicit request: the BOM-approval email
 * asked someone to approve a Bill of Materials without showing it, which
 * defeats the entire point of asking; a reader had to open the CMS to see
 * what they were being asked to sign off on.
 *
 * Takes the RESOLVED rows from `styleEmailContext`'s `bom` (i.e.
 * `stockItemBom(stockItem)`) and `variantTotal`, not a style — this used to
 * take the style and read `style.materials.rawItems`/`.items`, a legacy field
 * the Style & Sample stage stopped writing to on 26 Aug 2026, which is why
 * the table always rendered empty (fixed 28 Aug 2026). "Applies to" collapses
 * to "All variants" using the exact same rule StockItemBomPanel's own render
 * does, so the email and the CMS panel it mirrors never disagree.
 */
function bomTableHtml(bom, variantTotal = 0) {
  const rows = Array.isArray(bom) ? bom : [];
  if (!rows.length) {
    return `<p style="margin:16px 0 4px;font-size:12px;color:#64748b;font-weight:600">BILL OF MATERIALS</p>
<p style="margin:0;font-size:13.5px;color:#64748b">No raw materials recorded against this product yet.</p>`;
  }
  const body = rows.map((r) => {
    const labels = r.variantLabels || [];
    const applies = labels.length === 0 ? "All variants"
      : variantTotal && labels.length >= variantTotal ? "All variants"
      : labels.join(", ");
    const qty = r.quantity != null && r.quantity !== "" ? `${r.quantity}${r.unit ? ` ${r.unit}` : ""}` : "—";
    const name = r.rawItemName || "—";
    const combo = (r.variantCombination || []).length ? ` (${r.variantCombination.join(" / ")})` : "";
    return `<tr>
  <td style="padding:6px 14px 6px 0;border-bottom:1px solid #eef1f5">${escapeHtml(name)}${r.rawItemSku ? ` <span style="color:#94a3b8">${escapeHtml(r.rawItemSku)}</span>` : ""}${combo ? `<span style="color:#94a3b8">${escapeHtml(combo)}</span>` : ""}</td>
  <td style="padding:6px 14px 6px 0;border-bottom:1px solid #eef1f5;color:#475569">${escapeHtml(applies)}</td>
  <td style="padding:6px 0;border-bottom:1px solid #eef1f5;text-align:right;color:#475569;white-space:nowrap">${escapeHtml(qty)}</td>
</tr>`;
  }).join("");
  return `<p style="margin:16px 0 6px;font-size:12px;color:#64748b;font-weight:600">BILL OF MATERIALS</p>
<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:13px">
  <thead><tr style="text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:#94a3b8">
    <th style="padding:0 14px 6px 0;font-weight:600">Raw item</th>
    <th style="padding:0 14px 6px 0;font-weight:600">Applies to</th>
    <th style="padding:0 0 6px;font-weight:600;text-align:right">Qty / unit</th>
  </tr></thead>
  <tbody>${body}</tbody>
</table>`;
}

module.exports = { styleImages, linkedStockItemId, stockItemBom, styleEmailContext, imageGalleryHtml, bomTableHtml };
