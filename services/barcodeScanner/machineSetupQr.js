// services/barcodeScanner/machineSetupQr.js
//
// THE MACHINE SETUP QR (17 Oct 2026, owner: "the machine barcode the
// production supervisor links to the barcode scanner — show it on the IE
// machine page too").
//
// One rule for the text a scanner device reads to learn which machine it is
// on. The firmware's parser wants exactly `MID:<machine _id>,MNAME:<name>`;
// the Production Supervisor's Config Barcodes card (section 6) has built that
// string in the browser since Sep 2026, and the machine register's
// "Show barcode" now gets the SAME string from here. The frontend mirror is
// grav-clothing components/machines/machineQr.mjs — both tests pin the
// format, so the two cannot drift.
//
// Drawing options are the ones POST /api/cms/production/scanner/qr uses
// (error correction M, quiet zone 2): a code printed from either page reads
// the same at the device.

const OBJECT_ID = /^[a-f0-9]{24}$/i;

/** The text on the machine's setup QR, or null when the machine cannot carry one. */
function machineSetupPayload(machine) {
  const id = String(machine?._id ?? "").trim();
  const name = String(machine?.name ?? "").trim();
  if (!OBJECT_ID.test(id) || !name) return null;
  return `MID:${id},MNAME:${name}`;
}

/** Why a machine's name would read back wrong at the device, or null. The
 *  firmware splits on "," and ":" — a name holding either is cut short there. */
function payloadWarning(machine) {
  const name = String(machine?.name ?? "");
  if (/[,:]/.test(name)) {
    return `The name "${name.trim()}" holds a comma or colon; the scanner reads the name up to it. The machine id is unaffected, so scans still land on this machine.`;
  }
  return null;
}

const clampWidth = (w) => Math.min(Math.max(Number(w) || 240, 100), 600);

/** The QR as an SVG string (server-drawn, never hand-rolled). */
async function drawSetupQr(payload, width) {
  const QRCode = require("qrcode");
  return QRCode.toString(payload, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 2,
    width: clampWidth(width),
  });
}

module.exports = { machineSetupPayload, payloadWarning, drawSetupQr, clampWidth };
