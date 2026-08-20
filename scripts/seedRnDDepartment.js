// scripts/seedRnDDepartment.js
//
// Registers the "Research & Development" department so it appears on the
// onboarding hex grid and login redirects to it. Idempotent — safe to re-run.
//
//   node scripts/seedRnDDepartment.js
//
// The R&D app itself is a frontend base (localStorage) for now; this only adds
// the AccessDepartment row that gates/advertises it. No user assignment is
// created — a platform admin already sees every active department.
require("dotenv").config();
try { require("dns").setServers(["1.1.1.1", "8.8.8.8"]); } catch { /* older node */ }
const mongoose = require("mongoose");
const AccessDepartment = require("../models/Access/AccessDepartment");

const DOC = {
  key: "research-development",
  slug: "research-development",
  name: "Research & Development",
  description: "Sample development, version tracking and dev requests.",
  dashboardPath: "/research-development/dashboard",
  loginRedirect: "/research-development/dashboard",
  accentColor: "#0EA5E9",
  showOnOnboarding: true,
  sortOrder: 55,
  isActive: true,
};

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) { console.error("MONGODB_URI is not set."); process.exit(1); }

  await mongoose.connect(uri);
  console.log(`\nConnected to ${mongoose.connection.name}`);

  // Upsert on the immutable key. On update we only set the editable fields, so
  // re-running never clobbers an admin's later rename/re-slug of an existing row.
  const existing = await AccessDepartment.findOne({ key: DOC.key });
  if (existing) {
    existing.name = existing.name || DOC.name;
    existing.dashboardPath = DOC.dashboardPath;
    existing.loginRedirect = DOC.loginRedirect;
    if (existing.isActive === false) existing.isActive = true;
    existing.showOnOnboarding = true;
    await existing.save();
    console.log(`Updated existing department "${existing.name}" (${existing.slug}) → active, redirect ${existing.resolveRedirect()}`);
  } else {
    const created = await AccessDepartment.create(DOC);
    console.log(`Created department "${created.name}" (${created.slug}) → ${created.resolveRedirect()}`);
  }

  await mongoose.disconnect();
  console.log("Done. Reload /onboarding — the Research & Development tile should appear.\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
