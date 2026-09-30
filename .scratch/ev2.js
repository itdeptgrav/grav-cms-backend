require("dotenv").config();
const mongoose = require("mongoose");
(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;
  const styles = await db.collection("samplestyles").find({}, { projection: {
    sampleStyleId: 1, styleCode: 1, "brief.images": 1, "brief.brandingRequirements.artwork": 1,
    "sample.photos": 1, "sample.rounds.images": 1, "techSheet.file": 1,
    "techSheet.technicalRevisions.file": 1, sourceStockItemId: 1 } }).toArray();
  for (const s of styles) {
    const rounds = (s.sample?.rounds || []).reduce((n, r) => n + (r.images || []).length, 0);
    const revFiles = (s.techSheet?.technicalRevisions || []).filter((r) => r.file?.url || r.file?.name).length;
    const bits = [
      (s.brief?.images || []).length && `brief:${(s.brief.images).length}`,
      s.brief?.brandingRequirements?.artwork?.url && "artwork",
      (s.sample?.photos || []).length && `photos:${s.sample.photos.length}`,
      rounds && `roundImgs:${rounds}`,
      (s.techSheet?.file?.url || s.techSheet?.file?.name) && "techsheet",
      revFiles && `revFiles:${revFiles}`,
      s.sourceStockItemId && "product",
    ].filter(Boolean);
    if (bits.length) console.log(`${(s.styleCode || s.sampleStyleId).padEnd(26)} ${bits.join(" ")}`);
  }
  console.log("\n--- stock items with images ---");
  const prods = await db.collection("stockitems").find({ images: { $exists: true, $ne: [] } }, { projection: { name: 1, images: 1 } }).limit(5).toArray();
  for (const p of prods) console.log(` ${p.name}: ${p.images.length} image(s)`);
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
