// scripts/seedFilesDepartment.js
//
// Registers the standalone "Documents" app so it appears on the onboarding
// grid as an application of its own. Idempotent — safe to re-run.
//
//   node scripts/seedFilesDepartment.js
//
// ── WHY THIS SCRIPT EXISTS AT ALL ───────────────────────────────────────────
// The tile's ICON was never the missing piece: components/onboarding/
// DepartmentIcon.js has mapped the `files` slug to FolderOpen, in a neutral
// slate, since the app was built. What the portal draws is the list of
// AccessDepartment rows — so with no row, there was nothing for that icon to
// be drawn on. This adds the row.
//
// ── WHY NEUTRAL SLATE AND NOT A DEPARTMENT HUE ──────────────────────────────
// Every other tile belongs to somebody: sales orange, HR violet, accounting
// green. The company drive belongs to all of them, and painting it in any
// department's colour would quietly claim it for that department. The grey is
// the statement. It matches the hue already in DepartmentIcon, set explicitly
// here because the model's default accentColor is what "nobody chose" looks
// like and the portal cannot tell that apart from a real choice.
//
// ── WHO SEES THE TILE, AND WHAT IT DOES NOT CONTROL ─────────────────────────
// A platform admin sees every active department, so the tile appears for them
// as soon as this runs. Everyone else sees only the departments they are
// GRANTED, so grant this one in Access Control for the tile to show.
//
// That is ADVERTISING, not access. `/files` deliberately carries no
// `guardSlug` — see components/Files_DashboardLayout.js — because documents
// belong to the company rather than to one department's access row. A valid
// session already reaches the app by typing the URL, with or without a grant,
// and what any one person may OPEN is decided per document by the server
// (`mayRead` in routes/Access/files.js). This row changes who is offered the
// front door, and nothing else.
require("dotenv").config();
try { require("dns").setServers(["1.1.1.1", "8.8.8.8"]); } catch { /* older node */ }
const mongoose = require("mongoose");
const AccessDepartment = require("../models/Access/AccessDepartment");

const DOC = {
  key: "files",
  slug: "files",
  /* "Documents", not "Files": it is what the app's own nav calls itself, and
     it is the word somebody scans for when they are looking for a contract. */
  name: "Documents",
  description: "The company drive — invoices, contracts and paperwork, filed where the company keeps them.",
  dashboardPath: "/files",
  loginRedirect: "/files",
  accentColor: "#5C6B7A",
  showOnOnboarding: true,
  /* 59, not 60: Store & Purchase already sits at 60, and two tiles sharing a
     sortOrder leaves their order to whatever the database feels like that
     day. This puts Documents immediately after Budget, at the end of the
     company group — the utility the other company apps lean on rather than a
     peer of any one of them. */
  sortOrder: 59,
  isActive: true,
};

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGODB_URI is not set.");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`\nConnected to ${mongoose.connection.name}`);

  // Upsert on the immutable key. On update only the routing fields are set, so
  // re-running never clobbers an admin's later rename or re-slug.
  const existing = await AccessDepartment.findOne({ key: DOC.key });
  if (existing) {
    existing.name = existing.name || DOC.name;
    existing.description = existing.description || DOC.description;
    existing.dashboardPath = DOC.dashboardPath;
    existing.loginRedirect = DOC.loginRedirect;
    if (existing.isActive === false) existing.isActive = true;
    existing.showOnOnboarding = true;
    await existing.save();
    console.log(
      `Updated existing department "${existing.name}" (${existing.slug}) → active, redirect ${existing.resolveRedirect()}`,
    );
  } else {
    const created = await AccessDepartment.create(DOC);
    console.log(
      `Created department "${created.name}" (${created.slug}) → ${created.resolveRedirect()}`,
    );
  }

  await mongoose.disconnect();
  console.log("Done. Reload /onboarding — the Documents tile should appear.");
  console.log(
    "Note: admins see it immediately. Everyone else needs this department granted\n" +
      "to them in Access Control before the tile shows on their portal.\n",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
