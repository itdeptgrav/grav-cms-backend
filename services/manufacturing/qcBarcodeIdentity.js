// services/manufacturing/qcBarcodeIdentity.js
//
// WHAT KIND OF BARCODE IS THIS — the one place QC decides, for both books.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// QC inspects two completely different things, and until now the person had to
// tell the software which one before scanning: one nav entry for garment pieces,
// another for raw materials, and each screen could only read its own format. The
// scanner already knows. A `WO-…` code cannot be a fabric roll and a 24-hex
// Barcode id cannot be a garment unit, so asking is asking a question the input
// answers.
//
// So: one classifier, and it is the ONLY place either format is recognised
// server-side. The two routers' own parsers (`parseBarcode` in qcRoutes.js,
// `stickerIdOf` in qcRawItemRoutes.js) are kept for their existing callers and
// agree with this by construction — the tests assert it — but nothing new should
// grow a third opinion about what a barcode is.
//
// ── THE RAW-MATERIAL LABEL HAS FOUR FORMS, AND ONE OF THEM WAS BROKEN ──────
// `stickerIdOf` accepted `itemid=<id>`, the legacy `RawItem=<id>`, and a bare
// 24-hex id. What it did NOT accept is the form every currently-printed Store
// label actually encodes: a URL, `https://…/store/dashboard/item-info?itemid=<id>`
// (see lib/barcodeSticker.js's `itemQrPayload` on the frontend). A hardware
// wedge scanner types the whole URL and a phone camera hands over the whole URL,
// so camera-scanning a modern label into raw-material QC was refused as "not a
// raw item label". All four forms are accepted here.
//
// ── AND A CODE FROM A THIRD FAMILY IS "UNKNOWN", NEVER GUESSED ─────────────
// A Store LOCATION label is `loc=LOC-XXXXXXXX`; an employee card is a biometric
// id. Neither is a QC subject. The classifier returns `unknown` with the value
// intact rather than falling through to whichever branch happens to be first,
// because a mis-classified scan records a real verdict against the wrong thing.
"use strict";

/**
 * `WO-<workOrderShortId>-<unitNumber>` — one garment unit of one work order.
 *
 * CASE-SENSITIVE ON `WO`, and not by oversight. Both existing parsers are —
 * `parseBarcode` in qcRoutes.js tests `parts[0] !== "WO"` and the frontend's
 * `parseBarcodeClientSide` does the same — so accepting `wo-…` here would make
 * this classifier admit a scan the lookup it feeds would still refuse.
 */
const GARMENT = /^WO-([^-\s]+)-(\d+)$/;

/** A 24-character hex Mongo id, which is what a raw-material label carries. */
const HEX24 = /^[0-9a-f]{24}$/i;

/* The two prefix forms, and the query parameter the URL form uses. Lower-cased
   comparison throughout: a scanner may deliver either case, and the id itself is
   case-insensitive hex. */
const PREFIXES = Object.freeze(["itemid=", "rawitem="]);

/** A Store LOCATION label. Recognised only so it can be REFUSED by name. */
const LOCATION = /(?:^|[?&])loc=(LOC-[0-9A-Z]{4,})/i;

/**
 * Pull a Barcode document id out of whatever the scanner produced.
 *
 * Deliberately the same four acceptances as the frontend's `parseItemQr`
 * (lib/barcodeSticker.js) — that function is what the Store's own screens use,
 * and QC reading a label differently from the Store that printed it is the
 * beginning of two systems disagreeing about the same roll of cloth.
 */
function rawMaterialIdOf(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  /* The URL form first: it CONTAINS `itemid=`, so a prefix test would match it
     and then slice the whole address as the id. */
  if (/^https?:\/\//i.test(s)) {
    const m = /[?&]itemid=([0-9a-f]{24})(?:[&#]|$)/i.exec(s);
    return m ? m[1].toLowerCase() : null;
  }

  const lower = s.toLowerCase();
  for (const prefix of PREFIXES) {
    if (lower.startsWith(prefix)) {
      const id = s.slice(prefix.length).trim();
      return HEX24.test(id) ? id.toLowerCase() : null;
    }
  }

  return HEX24.test(s) ? s.toLowerCase() : null;
}

/** `WO-A1B2C3D4-17` → `{ workOrderShortId: "A1B2C3D4", unitNumber: 17 }`. */
function garmentPieceOf(raw) {
  const s = String(raw ?? "").trim();
  const m = GARMENT.exec(s);
  if (!m) return null;
  const unitNumber = Number.parseInt(m[2], 10);
  if (!Number.isFinite(unitNumber) || unitNumber <= 0) return null;
  return { workOrderShortId: m[1], unitNumber };
}

/**
 * Classify one scanned value.
 *
 * @returns `{ type, normalizedBarcode, scanned, parsed, refusal }`
 *   type  "garment_piece" | "raw_material" | "unknown"
 *   normalizedBarcode  what the branch should be asked about — the canonical
 *                      `WO-<shortId>-<unit>` for a garment, the bare 24-hex id
 *                      for a raw-material label. NEVER the raw scan: a URL is
 *                      not a lookup key, and `save` stores this.
 *   scanned   the value exactly as it arrived, so a refusal can quote it
 *   refusal   for `unknown` only: the reason, when the value is recognisably
 *             something else. A location label gets named rather than being
 *             reported as gibberish.
 */
function classifyQcBarcode(raw) {
  const scanned = String(raw ?? "").trim();
  if (!scanned) {
    return { type: "unknown", normalizedBarcode: "", scanned, parsed: null, refusal: "Nothing was scanned." };
  }

  const piece = garmentPieceOf(scanned);
  if (piece) {
    return {
      type: "garment_piece",
      /* ── THE TRIMMED SCAN, VERBATIM. NOT A REBUILT STRING ─────────────────
         It is tempting to return `WO-${shortId}-${unitNumber}`, which would
         fold `WO-X-017` and `WO-X-17` into one piece. Do not: `barcodeId` on
         QCInspection IS this string, `/lookup-piece` queries
         `QCInspection.find({ barcodeId: trimmed })` with it, and the piece
         tracker, the operator attribution and `qcStages.pieceProgress` all key
         on it. Rewriting it would split every existing piece's history from its
         future scans — silently, and only for the pieces whose labels happen to
         carry a leading zero.

         Normalisation here means "trimmed", and nothing more. */
      normalizedBarcode: scanned,
      scanned,
      parsed: piece,
      refusal: null,
    };
  }

  const rawItemId = rawMaterialIdOf(scanned);
  if (rawItemId) {
    return {
      type: "raw_material",
      normalizedBarcode: rawItemId,
      scanned,
      parsed: { barcodeId: rawItemId },
      refusal: null,
    };
  }

  /* Named refusals, so the screen can say what the thing IS rather than only
     what it is not. Both of these get scanned into QC by mistake regularly:
     the location label is on the shelf the roll came off. */
  const loc = LOCATION.exec(scanned);
  if (loc) {
    return {
      type: "unknown", normalizedBarcode: "", scanned, parsed: null,
      refusal: `That is a Store location label (${loc[1]}), not something QC inspects. Scan the label on the garment or on the raw material itself.`,
    };
  }
  if (/^WO-/i.test(scanned)) {
    /* Includes the lower-case `wo-…` case, which the lookup would refuse too —
       so it is named here rather than reported as an unrecognised string. */
    return {
      type: "unknown", normalizedBarcode: "", scanned, parsed: null,
      refusal: "That looks like a work-order code but not a piece barcode. A piece reads WO-<work order>-<unit number>, in capitals — for example WO-A1B2C3D4-17.",
    };
  }

  return { type: "unknown", normalizedBarcode: "", scanned, parsed: null, refusal: null };
}

module.exports = { classifyQcBarcode, garmentPieceOf, rawMaterialIdOf, GARMENT, HEX24 };
