// backfill_face_embeddings.js
//
// Fill in the face embedding for registration photos that were backed up
// before the API started storing one.
//
// Run:  node -r dotenv/config backfill_face_embeddings.js          # dry run
//       node -r dotenv/config backfill_face_embeddings.js --apply
//
// Reads `face_photos` rows that have no embedding, asks the engine for the
// numbers for that photo, and writes them back. It touches nothing else: no
// photo is moved, uploaded, re-encoded or deleted, and a row that already has
// an embedding is skipped.
//
// The engine must be running and must be the one holding these photos — the
// embedding is derived from the file on its disk, so pointing this at an
// engine with a different REGISTERED_PEOPLE will simply report not_found
// rather than writing anything wrong.

"use strict";

const mongoose = require("mongoose");
const FacePhoto = require("./models/HR_Models/FacePhoto");
const faceConfig = require("./config/faceBiometric");

const APPLY = process.argv.includes("--apply");

async function embedOne(folder, filename) {
  const r = await faceConfig.callEngine(
    "/register/embed",
    { folder, filename },
    30000,
  );
  if (r.status === 0) return { error: r.error || "engine_unreachable" };
  if (r.status !== 200 || !r.json || r.json.ok !== true) {
    return { error: (r.json && r.json.error) || `http_${r.status}` };
  }
  return { embedding: r.json.embedding, model: r.json.model, accepted: r.json.accepted };
}

async function main() {
  await mongoose.connect(
    process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing",
  );
  console.log(`\nconnected to ${mongoose.connection.name}`);
  console.log(`engine at ${faceConfig.FACE_BIOMETRIC_SERVICE_URL}`);
  console.log(APPLY ? "APPLYING\n" : "DRY RUN — pass --apply to write\n");

  const health = await faceConfig.engineHealth();
  if (!health || health.running !== true) {
    console.error("the face engine is not reachable; start it with " +
      `\`${faceConfig.START_COMMAND}\` and try again.`);
    process.exit(1);
  }

  /* Only live rows: an archived photo's local original has been moved to
     _archive/, so the engine cannot embed it, and its numbers are of no use. */
  const rows = await FacePhoto.find({
    archivedAt: null,
    $or: [{ embedding: { $exists: false } }, { embedding: { $size: 0 } }],
  })
    .select("+embedding")
    .sort({ createdAt: 1 });

  console.log(`${rows.length} row(s) without an embedding\n`);

  let done = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    const label = `${row.biometricId}/${row.filename}`;
    const folder = row.folder || row.biometricId;
    const r = await embedOne(folder, row.filename);

    if (r.error) {
      console.log(`  FAIL  ${label} — ${r.error}`);
      failed += 1;
      continue;
    }
    if (!Array.isArray(r.embedding) || !r.embedding.length) {
      // The photo is on disk but the gate refuses it — no face, too small.
      // Nothing to store, and nothing wrong with the row.
      console.log(`  skip  ${label} — no usable face (${r.accepted === false ? "rejected" : "no embedding"})`);
      skipped += 1;
      continue;
    }
    if (APPLY) {
      row.embedding = r.embedding;
      row.embeddingModel = r.model || "";
      await row.save();
    }
    console.log(`  ok    ${label} — ${r.embedding.length} dims${APPLY ? "" : " (not written)"}`);
    done += 1;
  }

  console.log(`\n${done} embedded, ${skipped} skipped, ${failed} failed`);
  if (!APPLY && done) console.log("nothing was written — re-run with --apply\n");
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error("\nbackfill error:", err);
  try {
    await mongoose.disconnect();
  } catch {
    /* already disconnected */
  }
  process.exit(1);
});
