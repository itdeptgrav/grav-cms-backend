// services/fabricCategoryImport.js
//
// What an imported fabric category must look like before it is stored. The
// frontend checks the merchandiser's Excel template already; this is the
// server's own check on the JSON it is sent, so a hand-made request cannot
// plant a category the shade-card page would choke on (a 200-colour
// category, a shade numbered 0, a leaf type nobody has).
//
// Pure — no database — so `node --test` covers it.

const MAX_SHADES = 150;
const TYPES = ["standard", "premium"];
const HEROES = ["right", "bottom", "none"];
const CATEGORIES = ["plain-shirting", "uniform", "corporate", "suiting", "uniform-suiting", "premium-suiting", "other"];

const text = (v, max = 200) => String(v == null ? "" : v).trim().slice(0, max);
const pad3 = (n) => String(n).padStart(3, "0");

/** "67/33 PV" + "142 CM" → "67/33 PV 142 CM"; either alone; "" for neither. */
function specText({ composition, width }) {
  return [text(composition), text(width)].filter(Boolean).join(" ").toUpperCase();
}

/**
 * One category as sent → the document to store. Throws an Error whose
 * message names the field, so the route can report every bad category at
 * once and store none of them.
 */
function normaliseCategory(input) {
  if (!input || typeof input !== "object") throw new Error("a category must be an object");
  const name = text(input.name, 60).toUpperCase();
  if (!name) throw new Error("the quality name is missing");
  if (!/^[A-Z0-9][A-Z0-9 &'./+-]*$/.test(name)) throw new Error(`"${name}" is not a usable quality name (letters, digits, spaces and & ' . / + - only)`);

  const type = text(input.type).toLowerCase() || "standard";
  if (!TYPES.includes(type)) throw new Error(`${name}: leaf type "${input.type}" must be standard or premium`);
  const hero = text(input.hero).toLowerCase() || "right";
  if (!HEROES.includes(hero)) throw new Error(`${name}: big box "${input.hero}" must be right, bottom or none`);
  const category = text(input.category).toLowerCase() || "other";
  if (!CATEGORIES.includes(category)) throw new Error(`${name}: category "${input.category}" is not one of ${CATEGORIES.join(", ")}`);

  const shadesIn = Array.isArray(input.shades) ? input.shades : [];
  const seenNo = new Set();
  const shades = shadesIn.map((s, i) => {
    const no = Number.parseInt(s?.no, 10);
    if (!Number.isInteger(no) || no < 1 || no > MAX_SHADES) throw new Error(`${name}: shade ${i + 1} has no usable Ray&Co number (1–${MAX_SHADES})`);
    if (seenNo.has(no)) throw new Error(`${name}: shade number ${pad3(no)} appears twice`);
    seenNo.add(no);
    return { no, code: `${name}-${pad3(no)}`, vendorCode: text(s?.vendorCode, 40), colour: text(s?.colour, 80) };
  });
  shades.sort((a, b) => a.no - b.no);

  let count = Number.parseInt(input.count, 10);
  if (shades.length) {
    const highest = shades[shades.length - 1].no;
    if (!Number.isInteger(count) || count < highest) count = highest;
  }
  if (!Number.isInteger(count) || count < 1) throw new Error(`${name}: how many colours? (no shade list and no count)`);
  if (count > MAX_SHADES) throw new Error(`${name}: ${count} colours is over the ${MAX_SHADES} a category can carry`);

  const composition = text(input.composition, 80);
  const width = text(input.width, 40);
  return {
    name,
    vendor: text(input.vendor, 80),
    vendorSeries: text(input.vendorSeries, 80),
    type,
    hero,
    composition,
    width,
    spec: text(input.spec, 120) || specText({ composition, width }),
    category,
    notes: text(input.notes, 500),
    count,
    shades,
  };
}

/**
 * A whole import: every category normalised, or the list of what is wrong.
 * All or nothing — a sheet with one bad row stores nothing, so the
 * merchandiser fixes the sheet and imports once, rather than half now and
 * half after a hunt for what went in.
 */
function normaliseImport(categories) {
  if (!Array.isArray(categories) || !categories.length) return { categories: [], errors: [{ message: "nothing to import" }] };
  const out = [];
  const errors = [];
  const names = new Set();
  categories.forEach((c, index) => {
    try {
      const doc = normaliseCategory(c);
      if (names.has(doc.name)) throw new Error(`${doc.name} appears twice in the import`);
      names.add(doc.name);
      out.push(doc);
    } catch (error) {
      errors.push({ index, name: text(c?.name, 60).toUpperCase() || null, message: error.message });
    }
  });
  return { categories: out, errors };
}

module.exports = { MAX_SHADES, TYPES, HEROES, CATEGORIES, normaliseCategory, normaliseImport, specText };
