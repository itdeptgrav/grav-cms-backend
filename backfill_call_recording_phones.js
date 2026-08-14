"use strict";

/**
 * backfill_call_recording_phones.js
 *
 *   node -r dotenv/config backfill_call_recording_phones.js
 *
 * Fills `CallRecording.normalizedPhone` on documents synced before that field
 * existed. Reads and writes the LIVE database named by MONGODB_URI.
 *
 * Safe to skip and safe to re-run. The Sales matcher already falls back to a
 * digit-tail regex on `phoneNumber` for un-backfilled rows, so this changes no
 * results — it only lets the indexed `normalizedPhone` clause carry the query
 * instead of a collection scan. Idempotent: it only touches documents where
 * `normalizedPhone` is missing or stale.
 *
 * Writes are per-document (not bulk) so a partial run leaves a consistent
 * collection rather than a half-applied batch; this collection is small enough
 * that the extra round-trips do not matter.
 */

const mongoose = require("mongoose");
const CallRecording = require("./models/CallRecording");
const { phoneKey } = require("./services/callRecordingMatch.service");

(async () => {
  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing";
  await mongoose.connect(uri);
  console.log(`connected: ${uri.replace(/\/\/[^@]+@/, "//***@")}`);

  const cursor = CallRecording.find({}, { phoneNumber: 1, normalizedPhone: 1 }).lean().cursor();

  let scanned = 0;
  let updated = 0;
  let unusable = 0;

  for await (const doc of cursor) {
    scanned += 1;
    const key = phoneKey(doc.phoneNumber);
    if (!key) {
      // Withheld numbers, extensions, "Unknown" — nothing to normalize.
      unusable += 1;
      continue;
    }
    if (doc.normalizedPhone === key) continue;
    await CallRecording.updateOne({ _id: doc._id }, { $set: { normalizedPhone: key } });
    updated += 1;
  }

  console.log(`scanned ${scanned} · updated ${updated} · no usable number ${unusable}`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
