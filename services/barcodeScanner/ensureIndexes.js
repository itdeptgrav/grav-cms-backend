// services/barcodeScanner/ensureIndexes.js
//
// Builds the indexes the four scan collections own, explicitly, at boot.
//
// connectDB() sets `autoIndex: process.env.NODE_ENV !== "production"`, which is
// right for the CMS's own collections but means that on a production box these
// four would never get their indexes at all. On a developer laptop they already
// exist from earlier runs, so the gap does not show up here — it shows up on the
// deployed server, which starts from an empty database.
//
// The one that matters is ProductionEvent.eventId. Delivery from a scanner is
// at-least-once: a device that does not see our 200 re-sends the same scan, and
// the unique index on eventId is what turns that retry into a no-op. Without it
// the retry inserts a SECOND row and the garment is counted twice — silent,
// permanent, and wrong in the direction nobody checks.
//
// Failure is logged, not fatal: a missing index makes queries slow, but
// refusing to start makes the whole floor stop.

const M = "../../models/CMS_Models/Manufacturing/Production/Barcode";

async function ensureScannerIndexes() {
  const owned = [
    require(`${M}/ProductionEvent`),
    require(`${M}/DeviceHeartbeat`),
    require(`${M}/MachineDayStats`),
    require(`${M}/OperatorDayStats`),
    // CanvasLayout is deliberately absent: it declares no indexes of its own,
    // and the CMS floor canvas writes it too — the scanner pipeline should not
    // be the process that shapes a collection it shares.
  ];

  let built = 0;
  for (const Model of owned) {
    try {
      await Model.createIndexes();
      built++;
    } catch (err) {
      console.error(
        `[Scanner] index build failed for ${Model.modelName}: ${err.message}`
      );
    }
  }
  console.log(`[Scanner] indexes ensured for ${built}/${owned.length} scan collections`);
}

module.exports = { ensureScannerIndexes };
