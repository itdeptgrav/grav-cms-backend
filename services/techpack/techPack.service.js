// services/techpack/techPack.service.js
//
// THE PRINTED TECH PACK OF A STYLE (15 Oct 2026) — the pages of the owner's
// advanced pack that existing data fills (grav-cms docs/techpack-layout.md,
// build step 1): the frame's header, 1 Cover & BOM, 2 swatches, 6 Construction,
// 11 Labels, 12 Hang tags, 13 Packaging.
//
// Nothing here is authored: every value is READ from the department that owns
// it, at print time —
//   • the brief and the customer (Sales);
//   • the approved material selection (Merchandising) — the SAME revision R&D
//     works to (approvedMaterialShortlist.service), with its category, colour
//     and placement;
//   • the item master: each variant's picture and supplier (Store);
//   • consumption per piece (R&D's technical record; else Merchandising's
//     assumption, marked as such);
//   • the flats and the construction (GRAV Studio — the version under review
//     or approved, its manifest's `construction`);
//   • and the pack's own few fields (`style.techPack`: season, sample size,
//     per-material specs — models/CMS_Models/Sales/sampleTechPackSchema.js).
//
// Where a value is missing, `style.techPack.preview` may hold a SAMPLE for it
// (owner, 15 Oct 2026: see the whole pack filled on the test style). Every
// value comes back with a mark — `marks` in the answer — so the page can colour
// what is real, what is a sample, what no record holds, and what is empty.
//
// `buildTechPack` is plain data in, plain data out, so it tests without a
// database; `loadTechPack` fetches what it needs, scoped to one company.

"use strict";

const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const { SPEC_FIELDS } = require("../../models/CMS_Models/Sales/sampleTechPackSchema");
const { approvedShortlistFor, approvedDevelopmentSelectionFor } = require("../approvedMaterialShortlist.service");
/* The item master and its suppliers are Store & Purchase's records, read by
   Store & Purchase's own tenancy rule (the company's, plus the unowned legacy
   rows while its read-through is on) — the rule the Raw Items screen uses. */
const { tenantFilter } = require("../storePurchase/tenantContext.service");

function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const text = (v) => (v === null || v === undefined ? "" : String(v).trim());
const idOf = (v) => (v ? String(v) : "");
const unique = (xs) => [...new Set(xs.filter(Boolean))];

/** A, B, … Z, AA, AB, … — a BOM row's name for the whole pack. */
function letterFor(i) {
  let n = i + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** A material's identity across BOM revisions: the development row's ref, else item + variant. */
const rowKeyOf = (r) => text(r.rowRef) || `${idOf(r.rawItemId)}:${idOf(r.variantId)}`;

const CATEGORY_WORDS = {
  FABRIC: "Fabric",
  TRIM: "Trim",
  LABEL: "Label",
  ACCESSORY: "Accessory",
  SAMPLE_PACKAGING: "Packaging",
};

/** The selection's own category, else what the item master or its code says it is. */
function categoryOf(row, item) {
  if (CATEGORY_WORDS[row.category]) return row.category;
  const said = `${text(item?.category)} ${text(item?.customCategory)} ${text(row.rawItemSku)}`.toLowerCase();
  if (/fabric|raw-fab/.test(said)) return "FABRIC";
  if (/label|lable|raw-lab/.test(said)) return "LABEL";
  if (/pack|poly|carton|raw-pac/.test(said)) return "SAMPLE_PACKAGING";
  if (/accessor/.test(said)) return "ACCESSORY";
  return "TRIM";
}

const isHangTag = (row) => /hang\s*-?\s*tag|swing\s*-?\s*tag/i.test(`${row.name} ${row.itemCategory || ""}`);

/**
 * What each value of a variant's combination is, by the item's attribute of
 * the same position: the supplier ("Vendor", "Mill"), the colour, the rest.
 */
function readCombination(item, variant, vendorNames) {
  const values = (variant?.combination || []).map(text);
  const names = (item?.attributes || []).map((a) => text(a?.name).toLowerCase());
  const out = { supplier: [], colour: [], other: [] };
  values.forEach((v, i) => {
    if (!v || v.toLowerCase() === "default") return;
    const n = names[i] || "";
    if (/vendor|supplier|mill|brand|maker/.test(n) || vendorNames.has(v.toLowerCase())) out.supplier.push(v);
    else if (/colou?r|shade/.test(n)) out.colour.push(v);
    else out.other.push(v);
  });
  return out;
}

/** The version the pack draws: the approved one, else the newest sent. */
function versionForPack(style) {
  const vs = [...(style?.studio?.versions || [])].sort((a, b) => (b.version || 0) - (a.version || 0));
  return vs.find((v) => v.outcome === "approved") || vs.find((v) => v.outcome !== "superseded") || vs[0] || null;
}

const flatOf = (v, kind) => {
  const flats = (v?.flats || []).filter((f) => f.kind === kind);
  const pick = (mime) => flats.find((f) => text(f.mimeType).startsWith(mime))?.fileId || "";
  const svg = pick("image/svg");
  const png = pick("image/png");
  return svg || png ? { svg, png } : null;
};

const mm = (x) => (Number.isFinite(Number(x)) && x !== null && x !== "" ? Number(x) : null);

/**
 * Pages 7–10 (Colorways, Artwork): the colours, prints and logos GRAV Studio
 * sent with the version — each print's and logo's picture found among the
 * version's artwork files by its SHA-256, the name it was sent under — and
 * where each logo lands on the coloured flats.
 */
function artworkOf(v) {
  const m = v?.manifest || {};
  const list = (x) => (Array.isArray(x) ? x : []);
  const fileOf = new Map((v?.artwork || []).map((f) => [text(f.name).replace(/\.[^.]+$/, ""), text(f.fileId)]));
  const pair = (x) => (Array.isArray(x) && x.length === 2 ? [mm(x[0]), mm(x[1])] : null);
  return {
    colours: list(m.colours).map((c) => ({ hex: text(c?.hex), panels: list(c?.panels).map(text) })),
    prints: list(m.prints).map((p) => ({
      name: text(p?.name),
      fileId: fileOf.get(text(p?.image)) || "",
      repeatMm: pair(p?.repeatMm),
      rotationDeg: mm(p?.rotationDeg),
      dye: text(p?.dye),
      panels: list(p?.panels).map(text),
    })),
    logos: list(m.artwork).map((l) => ({
      logoId: text(l?.logoId),
      name: text(l?.name),
      fileId: fileOf.get(text(l?.image)) || "",
      panel: text(l?.panel),
      widthMm: mm(l?.widthMm),
      heightMm: mm(l?.heightMm),
      rotationDeg: mm(l?.rotationDeg),
      gapsMm: l?.gapsMm && typeof l.gapsMm === "object"
        ? { left: mm(l.gapsMm.left), right: mm(l.gapsMm.right), top: mm(l.gapsMm.top), bottom: mm(l.gapsMm.bottom) }
        : null,
    })),
    flatMarks: m.flatMarks && typeof m.flatMarks === "object" ? m.flatMarks : null,
  };
}

/**
 * Pages 3–6 and 15–16: what GRAV Studio marked on its flats — the points of
 * measurement (letter, name, how, method, value and tolerance in mm), the
 * numbered feature callouts and the lettered construction pointers — as its
 * manifest carries them.
 */
const viewsOf = (c) => (Array.isArray(c?.views) ? { views: c.views.map(text).filter((x) => x === "front" || x === "back") } : {});

function markingsOf(v) {
  const m = v?.manifest || {};
  const list = (x) => (Array.isArray(x) ? x : []);
  return {
    pom: list(m.pom).map((p) => ({
      letter: text(p?.letter),
      code: text(p?.code),
      name: text(p?.name),
      how: text(p?.how),
      method: text(p?.method),
      valueMm: mm(p?.valueMm),
      toleranceMm: mm(p?.toleranceMm),
      critical: Boolean(p?.critical),
      view: text(p?.view),
    })),
    // which flats show each callout and each letter ("front", "back"), as
    // Studio drew them; absent when it did not say
    callouts: list(m.callouts).map((c) => ({ number: Number(c?.number) || 0, text: text(c?.text), view: text(c?.view), ...viewsOf(c) })),
    pointers: list(m.pointers).map((c) => ({ letter: text(c?.letter), text: text(c?.text), ...viewsOf(c) })),
  };
}

/**
 * The zips GRAV Studio set into the garment's stitches (manifest `zips`): the
 * stitch, the zip in one line, and each part of it. Lengths in mm.
 */
function zipsOf(v) {
  const list = Array.isArray(v?.manifest?.zips) ? v.manifest.zips : [];
  return list.map((z) => ({
    seamId: text(z?.seamId),
    stitch: text(z?.stitch).split("(")[0].trim(),
    text: text(z?.text),
    chain: text(z?.chain),
    gauge: Number(z?.gauge) || null,
    ends: text(z?.ends),
    lengthMm: mm(z?.lengthMm),
    tape: text(z?.tape),
    puller: text(z?.puller),
    note: text(z?.note),
  }));
}

/** "Single Needle 14": the needle a stitch is sewn with, as Studio chose it. */
const needleOf = (o) => `${text(o?.needle?.name)} ${text(o?.needle?.size)}`.trim();

/**
 * Page 6: the construction sheet GRAV Studio sent, one lettered row per
 * distinct construction — the stitches that are made the same way share a
 * row, as the reference pack's Operation column lists several seams.
 */
function constructionRows(manifest) {
  const sheet = Array.isArray(manifest?.construction) ? manifest.construction : [];
  const groups = new Map();
  const pending = [];
  for (const s of sheet) {
    const ops = Array.isArray(s?.operations) ? s.operations : [];
    if (s?.status !== "ready" || !ops.length) {
      if (text(s?.name)) pending.push(text(s.name));
      continue;
    }
    const sig = JSON.stringify([
      text(s.seamClass),
      mm(s.allowanceMm),
      ops.map((o) => [text(o.code), mm(o.spi), mm(o.needles), mm(o.gaugeMm), text(o.thread), needleOf(o)]),
    ]);
    if (!groups.has(sig)) {
      groups.set(sig, {
        seams: [],
        purposes: unique(ops.map((o) => text(o.purpose))),
        stitches: ops.map((o) => ({
          code: text(o.code),
          words: text(o.stitch) || text(o.code),
          needles: mm(o.needles),
          gaugeMm: mm(o.gaugeMm),
          spi: mm(o.spi),
          // No record holds a tolerance yet — only sample values carry one.
          spiTolerance: mm(o.spiTolerance),
          thread: text(o.thread),
          needle: needleOf(o),
        })),
        seamClass: text(s.seamClass),
        seamClassName: text(s.seamClassName),
        allowanceMm: mm(s.allowanceMm),
        notes: [],
      });
    }
    const g = groups.get(sig);
    g.seams.push(text(s.name) || text(s.seamId));
    if (text(s.note)) g.notes.push(text(s.note));
  }
  const rows = [...groups.values()].map((g, i) => ({ letter: letterFor(i), ...g, notes: unique(g.notes) }));
  return { rows, pending: unique(pending), stitchCount: sheet.length };
}

const GENDER_WORDS = { male: "Men's", female: "Women's", unisex: "Unisex" };

/**
 * The pack, from what was read.
 *
 * @param {object} p
 * @param {object} p.style            the SampleStyle (lean)
 * @param {string} p.customerName     the account's name ("" for a house sample)
 * @param {string} p.companyName      the company's own name (a house sample's brand)
 * @param {object[]} p.bomRows        the approved selection's rows, in order
 * @param {object[]} p.rawItems       their item masters (lean, with variants)
 * @param {object[]} p.vendors        their suppliers ({_id, companyName})
 */
function buildTechPack({ style, customerName = "", companyName = "", bomRows = [], rawItems = [], vendors = [] }) {
  const pack = style?.techPack || {};
  const brief = style?.brief || {};
  const items = new Map(rawItems.map((i) => [idOf(i._id), i]));
  const vendorById = new Map(vendors.map((v) => [idOf(v._id), text(v.companyName)]));
  const vendorNames = new Set([...vendorById.values()].map((n) => n.toLowerCase()).filter(Boolean));
  const specs = new Map((pack.specs || []).map((s) => [text(s.rowKey), s]));

  /* ── MARKS: where each printed value stands ────────────────────────────
     none    the value is real, from its owner in the CMS;
     yellow  the CMS has the field, but this value is a SAMPLE (techPack.preview);
     red     no CMS record has the field at all — a sample, or nothing;
     blue    the CMS has the field and it is empty.
     A real value always wins over a sample. Keys are "header.season",
     "bom.<rowKey>.qty", "sketch.front", "construction", … */
  const preview = pack.preview && typeof pack.preview === "object" ? pack.preview : {};
  const marks = {};
  const RANK = { blue: 1, yellow: 2, red: 3 };
  const mark = (key, colour) => {
    if (!marks[key] || RANK[colour] > RANK[marks[key]]) marks[key] = colour;
  };
  const filled = (v) => !(v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length));
  /** The real value, else the sample (marked yellow), else empty (marked blue). */
  const orSample = (key, real, sample) => {
    if (filled(real)) return real;
    if (filled(sample)) {
      mark(key, "yellow");
      return sample;
    }
    mark(key, "blue");
    return real;
  };

  /* R&D's engineered consumption, by item + variant. */
  const engineered = new Map();
  for (const m of style?.techSheet?.technical?.materials || []) {
    if (Number.isFinite(Number(m.consumptionPerPiece)) && m.consumptionPerPiece !== null) {
      engineered.set(`${idOf(m.rawItemId)}:${idOf(m.variantId)}`, { value: Number(m.consumptionPerPiece), unit: text(m.unit) });
    }
  }

  /* The approved selection, then any packaging Merchandising selected that
     the selection does not already name. */
  const source = [...bomRows];
  const named = new Set(source.map((r) => `${idOf(r.rawItemId)}:${idOf(r.variantId)}`));
  for (const p of style?.materials?.packagingSelections || []) {
    if (p.status === "withdrawn" || !p.rawItemId) continue;
    const k = `${idOf(p.rawItemId)}:${idOf(p.variantId)}`;
    if (named.has(k)) continue;
    named.add(k);
    source.push({
      rowRef: text(p.rowId),
      category: "SAMPLE_PACKAGING",
      rawItemId: p.rawItemId,
      rawItemName: p.rawItemName,
      rawItemSku: p.rawItemSku,
      variantId: p.variantId,
      variantCombination: text(p.variantLabel) ? [text(p.variantLabel)] : [],
      specification: p.specification,
    });
  }

  const bom = source.map((r, i) => {
    const item = items.get(idOf(r.rawItemId));
    const variant = (item?.variants || []).find((v) => idOf(v._id) === idOf(r.variantId)) || null;
    const combo = readCombination(item, variant || { combination: r.variantCombination }, vendorNames);
    const supplierIds = [
      ...(variant?.vendorNicknames || []).map((n) => idOf(n.vendor)),
      idOf(item?.primaryVendor),
    ].filter(Boolean);
    const supplier = supplierIds.map((id) => vendorById.get(id)).find(Boolean) || combo.supplier[0] || "";
    const key = `${idOf(r.rawItemId)}:${idOf(r.variantId)}`;
    const assumed = Number.isFinite(Number(r.consumptionPerPiece)) && r.consumptionPerPiece !== null && r.consumptionPerPiece !== undefined
      ? { value: Number(r.consumptionPerPiece), unit: text(r.consumptionUnit), assumed: true }
      : null;
    const qty = engineered.has(key) ? { ...engineered.get(key), assumed: false } : assumed;
    const category = categoryOf(r, item);
    const rowKey = rowKeyOf(r);
    const spec = specs.get(rowKey) || {};
    const pv = (preview.rows && typeof preview.rows === "object" && preview.rows[rowKey]) || {};
    const k = (f) => `bom.${rowKey}.${f}`;
    const sampleQty = Number.isFinite(Number(pv.qty?.value)) && pv.qty?.value !== null
      ? { value: Number(pv.qty.value), unit: text(pv.qty.unit), assumed: false }
      : null;
    return {
      letter: letterFor(i),
      rowKey,
      category,
      categoryWord: CATEGORY_WORDS[category],
      item: text(r.appliesTo) || text(r.placement) || CATEGORY_WORDS[category],
      name: text(r.rawItemName) || text(item?.name),
      description: unique([text(r.finish), text(r.placement) !== text(r.appliesTo) ? text(r.placement) : "", text(item?.description), ...combo.other]).join(" · "),
      colour: orSample(k("colour"), text(r.colourOrShade) || combo.colour.join(" · "), text(pv.colour)),
      code: orSample(k("code"), text(r.rawItemSku) || text(variant?.sku) || text(item?.sku), text(pv.code)),
      qty: orSample(k("qty"), qty, sampleQty),
      supplier: orSample(k("supplier"), supplier, text(pv.supplier)),
      image: orSample(k("image"), text(variant?.image), text(pv.image)),
      note: text(r.selectionNote) || text(r.specification),
      itemCategory: text(item?.category),
      spec: Object.fromEntries(SPEC_FIELDS.map((f) => [f, text(spec[f])])),
    };
  });

  /* The main fabric's composition and GSM are the brief's (Sales). */
  const fabricRow = bom.find((r) => r.category === "FABRIC");
  if (fabricRow) {
    const pb = (preview.brief && typeof preview.brief === "object" && preview.brief) || {};
    const key = `bom.${fabricRow.rowKey}.description`;
    const composition = orSample(key, text(brief.fabricComposition), text(pb.fabricComposition));
    const gsm = orSample(key, text(brief.gsm), text(pb.gsm));
    fabricRow.description = unique([fabricRow.description, composition, gsm ? `${gsm.replace(/\s*gsm$/i, "")} GSM` : ""]).join(" · ");
  }

  const version = versionForPack(style);
  /* The zips GRAV Studio set into the garment's stitches: each one's spec on
     the BOM's zip row when Merchandising has one, else a row of its own,
     marked red until a zip is chosen in the BOM. */
  const zipRows = bom.filter((r) => /\bzip|zipper/i.test(`${r.item} ${r.name} ${r.description}`));
  zipsOf(version).forEach((z, i) => {
    const onRow = zipRows[i];
    if (onRow) {
      onRow.studio = z.text;
      return;
    }
    const rowKey = `studio-zip:${z.seamId}`;
    bom.push({
      letter: letterFor(bom.length),
      rowKey,
      category: "TRIM",
      categoryWord: CATEGORY_WORDS.TRIM,
      item: `Zip — ${z.stitch}`,
      name: "",
      description: z.text,
      colour: z.tape,
      code: "",
      qty: { value: 1, unit: "pc", assumed: false },
      supplier: "",
      image: "",
      note: "",
      itemCategory: "",
      spec: Object.fromEntries(SPEC_FIELDS.map((f) => [f, ""])),
      studio: z.text,
    });
    for (const f of ["item", "colour", "code", "supplier"]) mark(`bom.${rowKey}.${f}`, "red");
  });
  const fabric = fabricRow;
  const sampleSize = text(pack.sampleSize);
  const sizeRange = text(brief.sizeRange);
  const isHouse = style?.sampleType === "house";
  const ph = (preview.header && typeof preview.header === "object" && preview.header) || {};

  /* The garment type ("Shirt") is in no record: the brief has no such field. */
  const garmentType = text(ph.garmentType);
  if (!text(pack.description)) mark("header.description", "red");
  const header = {
    brand: text(pack.brand) || (isHouse ? text(companyName) : text(customerName)),
    designer: text(style?.studio?.designer?.name) || text(style?.techSheet?.technical?.startedBy?.name),
    description: text(pack.description) || unique([GENDER_WORDS[brief.gender], text(brief.fit) ? `${text(brief.fit)} fit` : "", garmentType]).join(" · "),
    season: text(pack.season),
    date: pack.updatedAt || version?.sentAt || style?.updatedAt || null,
    mainFabric: fabric ? [fabric.name, fabric.colour].filter(Boolean).join(" — ") : "",
    styleName: text(style?.productName),
    styleNumber: text(style?.styleCode) || text(style?.sampleStyleId),
    sizeRange: sizeRange && sampleSize ? `${sizeRange} [${sampleSize}]` : sizeRange || (sampleSize ? `[${sampleSize}]` : ""),
  };
  for (const [f, v] of Object.entries(header)) if (!filled(v)) mark(`header.${f}`, "blue");
  if (!sampleSize) mark("header.sampleSize", "blue");
  if (fabric && marks[`bom.${fabric.rowKey}.colour`]) mark("header.mainFabric", marks[`bom.${fabric.rowKey}.colour`]);

  /* Flats: GRAV Studio's, else sample drawings (SVG markup). */
  const pf = (preview.flats && typeof preview.flats === "object" && preview.flats) || {};
  const flatOrSample = (kind) => {
    const real = flatOf(version, kind);
    if (real) return real;
    const svg = text(pf[kind]);
    if (svg.startsWith("<svg")) {
      mark(`sketch.${kind}`, "yellow");
      return { dataUri: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` };
    }
    mark(`sketch.${kind}`, "blue");
    return null;
  };

  /* Construction: GRAV Studio's, else a sample sheet in the manifest's shape. */
  let construction = { version: version?.version || null, ...constructionRows(version?.manifest) };
  if (!construction.rows.length && Array.isArray(preview.construction) && preview.construction.length) {
    construction = { version: null, sample: true, ...constructionRows({ construction: preview.construction }) };
    mark("construction", "yellow");
  } else if (!construction.rows.length) {
    mark("construction", "blue");
  }
  if (construction.rows.some((r) => r.stitches.some((s) => s.spiTolerance !== null))) mark("construction.spiTolerance", "red");

  /* Colorways and Artwork: GRAV Studio's coloured flats, and the colours,
     prints and logos it sent. Pantone codes are in no record yet. */
  const colourFlats = { front: flatOf(version, "frontColour"), back: flatOf(version, "backColour") };
  const marked = {
    pom: { front: flatOf(version, "frontPom"), back: flatOf(version, "backPom") },
    callouts: { front: flatOf(version, "frontCallouts"), back: flatOf(version, "backCallouts") },
    construction: { front: flatOf(version, "frontConstruction"), back: flatOf(version, "backConstruction") },
  };
  const markings = markingsOf(version);
  if (!markings.pom.length) mark("measurement", "blue");
  if (!markings.callouts.length) mark("callouts", "blue");
  if (!marked.construction.front) mark("construction.diagram", "blue");
  if (!colourFlats.front) mark("colorways.flat", "blue");
  const artwork = artworkOf(version);
  if (!artwork.colours.length && !artwork.prints.length) mark("colorways.colours", "blue");
  if (artwork.colours.length || artwork.prints.length) mark("colorways.pantone", "red");
  if (!artwork.prints.length && !artwork.logos.length) mark("artwork", "blue");

  /* The footer's ownership line is in no record (company settings hold none). */
  const pfoot = (preview.footer && typeof preview.footer === "object" && preview.footer) || {};
  const disclaimer = text(pfoot.disclaimer);
  mark("footer.disclaimer", "red");

  const strip = ({ itemCategory, ...r }) => r;
  const labels = bom.filter((r) => r.category === "LABEL" && !isHangTag(r)).map(strip);
  const hangTags = bom.filter((r) => isHangTag(r)).map(strip);
  const packaging = bom.filter((r) => r.category === "SAMPLE_PACKAGING" && !isHangTag(r)).map(strip);

  return {
    styleId: idOf(style?._id),
    header,
    fields: { season: text(pack.season), sampleSize, brand: text(pack.brand), description: text(pack.description) },
    sketch: {
      version: version?.version || null,
      outcome: version?.outcome || "",
      front: flatOrSample("front"),
      back: flatOrSample("back"),
      colour: colourFlats,
      marked,
      reference: (brief.images || []).map((im) => ({ fileId: text(im.fileId), publicId: text(im.publicId), url: text(im.url), name: text(im.name) }))[0] || null,
    },
    artwork,
    markings,
    zips: zipsOf(version),
    fabricSwatch: fabric?.image || "",
    bom: bom.map(strip),
    construction,
    labels,
    hangTags,
    packaging,
    footer: { disclaimer },
    marks,
    hasSample: Object.keys(preview).length > 0,
  };
}

/* ── THE PACK'S OWN FIELDS ─────────────────────────────────────────────── */

const LIMITS = { season: 80, sampleSize: 40, brand: 120, description: 200 };
const SPEC_LIMIT = 500;
const PREVIEW_LIMIT = 200 * 1024;

/**
 * Edit the pack's own fields: any of season, sample size, brand, description,
 * and per-material specs by `rowKey` (only for materials on the pack). A spec
 * with every field blank is removed.
 */
function applyEdit(style, body, { rowKeys }, actor) {
  const b = body && typeof body === "object" ? body : {};
  const pack = style.techPack?.toObject ? style.techPack.toObject() : { ...(style.techPack || {}) };
  for (const [k, max] of Object.entries(LIMITS)) {
    if (b[k] === undefined) continue;
    const v = text(b[k]);
    if (v.length > max) throw fail(400, `${k} is too long.`);
    pack[k] = v;
  }
  if (b.specs !== undefined) {
    if (!Array.isArray(b.specs)) throw fail(400, "specs must be a list.");
    const byKey = new Map((pack.specs || []).map((s) => [text(s.rowKey), { ...s }]));
    for (const s of b.specs) {
      const key = text(s?.rowKey);
      if (!rowKeys.has(key)) throw fail(400, "That material is not on this tech pack.");
      const next = { ...(byKey.get(key) || {}), rowKey: key };
      for (const f of SPEC_FIELDS) {
        if (s[f] === undefined) continue;
        const v = text(s[f]);
        if (v.length > SPEC_LIMIT) throw fail(400, `${f} is too long.`);
        next[f] = v;
      }
      if (SPEC_FIELDS.every((f) => !text(next[f]))) byKey.delete(key);
      else byKey.set(key, next);
    }
    pack.specs = [...byKey.values()];
  }
  if (b.preview !== undefined) {
    // Replaced whole; null clears it. Shown only marked (see buildTechPack).
    if (b.preview !== null && (typeof b.preview !== "object" || Array.isArray(b.preview))) throw fail(400, "preview must be an object.");
    if (b.preview && JSON.stringify(b.preview).length > PREVIEW_LIMIT) throw fail(400, "preview is too large.");
    pack.preview = b.preview || undefined;
  }
  pack.updatedAt = new Date();
  pack.updatedBy = { id: text(actor?.id), name: text(actor?.name) };
  style.techPack = pack;
  if (typeof style.markModified === "function") style.markModified("techPack.preview");
  return pack;
}

/* ── READING IT ────────────────────────────────────────────────────────── */

/** The approved selection's rows, as Merchandising wrote them where there is a development BOM. */
async function bomRowsFor(style) {
  const dev = await approvedDevelopmentSelectionFor(style, { fullRows: true });
  if (dev?.rows?.length) return dev.rows.filter((r) => r.rawItemId || text(r.rawItemName));
  const shortlist = await approvedShortlistFor(style);
  return shortlist.rows || [];
}

/** Everything the pack reads, for one style of `companyId`. */
async function loadTechPack(style, { companyId, customerName = "", companyName = "" }) {
  const bomRows = await bomRowsFor(style);
  const ids = unique([
    ...bomRows.map((r) => idOf(r.rawItemId)),
    ...(style?.materials?.packagingSelections || []).map((p) => idOf(p.rawItemId)),
  ]);
  const rawItems = ids.length
    ? await RawItem.find({ ...tenantFilter({ companyId }), _id: { $in: ids } })
      .select("name sku category customCategory description attributes primaryVendor variants._id variants.sku variants.combination variants.image variants.vendorNicknames.vendor")
      .lean()
    : [];
  const vendorIds = unique(rawItems.flatMap((i) => [
    idOf(i.primaryVendor),
    ...(i.variants || []).flatMap((v) => (v.vendorNicknames || []).map((n) => idOf(n.vendor))),
  ]));
  const vendors = vendorIds.length
    ? await Vendor.find({ ...tenantFilter({ companyId }), _id: { $in: vendorIds } }).select("companyName").lean()
    : [];
  return buildTechPack({ style, customerName, companyName, bomRows, rawItems, vendors });
}

module.exports = { buildTechPack, loadTechPack, applyEdit, constructionRows, artworkOf, markingsOf, zipsOf, letterFor, rowKeyOf, versionForPack };
