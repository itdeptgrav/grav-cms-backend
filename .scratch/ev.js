require("dotenv").config();
const mongoose = require("mongoose");
(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  const svc = require("../services/industrialEngineering/ieDevelopment.service");
  const co = "6a08040a1fecacc9bb7149c2";
  const list = await svc.listDevelopment({ companyId: co, role: "editor" }, { view: "all", limit: 25 });
  console.log("=== thumbnails on the register ===");
  for (const r of list.rows) console.log(` ${r.reference.padEnd(24)} thumb=${r.thumbnail ? r.thumbnail.kind + " " + String(r.thumbnail.url).slice(0, 48) : "(none)"}`);
  for (const id of ["6ab2707f75b77ae4b311600d", "6ab8e95fbe8d3a2a8b502897"]) {
    const d = await svc.readDevelopment({ companyId: co, role: "editor" }, { styleId: id });
    console.log(`\n=== evidence for ${d.row.reference} ===`);
    console.log(" images:", d.evidence.images.length, d.evidence.images.map(i => `${i.source}/${i.kind}${i.url ? "" : "(no url)"}`).join(", ") || "(none)");
    console.log(" documents:", d.evidence.documents.length, d.evidence.documents.map(x => `${x.kind} rev=${x.revision} type=${x.fileType} openable=${x.openable} "${x.name}"`).join(" | ") || "(none)");
    console.log(" unavailable:", d.evidence.unavailable.map(u => u.kind).join(", "));
  }
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
