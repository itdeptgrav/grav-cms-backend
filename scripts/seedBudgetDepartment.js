// scripts/seedBudgetDepartment.js
//
// Registers the standalone "Budget" app so it appears on the onboarding grid
// as an application of its own. Idempotent — safe to re-run.
//
//   node scripts/seedBudgetDepartment.js
//
// ── WHY BUDGET IS ITS OWN APP AND NOT PART OF ACCOUNTING ────────────────────
// Accounting has a budget view, but that is finance's side of the conversation:
// cycles, approvals, adjustments, transfers. This app is the OTHER side — a
// department head proposing lines and reading finance's answer — and it must
// not require entering `/accountant` to reach. Two audiences, two apps, one
// engine underneath.
//
// The row only ADVERTISES and gates the app. Every read is still scoped
// server-side by `Acc_BudgetDepartment.accessSlug` in
// services/budgetProposals.service.js, so a head who reaches `/budget` sees
// their own department's cycles whichever tile they arrived through.
//
// ── WHO SEES THE TILE ───────────────────────────────────────────────────────
// A platform admin sees every active department, so the tile appears for them
// as soon as this runs. A department head sees only the departments they are
// GRANTED — so if heads should reach Budget from the portal rather than by
// typing the URL, grant them this department in Access Control. No user
// assignment is created here; see the note printed at the end.
require("dotenv").config();
try { require("dns").setServers(["1.1.1.1", "8.8.8.8"]); } catch { /* older node */ }
const mongoose = require("mongoose");
const AccessDepartment = require("../models/Access/AccessDepartment");

const DOC = {
  key: "budget",
  slug: "budget",
  name: "Budget",
  description: "Department budget proposals and finance's answer.",
  dashboardPath: "/budget",
  loginRedirect: "/budget",
  /* Deliberately not the accountant green. The two tiles sit near each other
     and would otherwise read as one app split in two. */
  accentColor: "#4C7DBD",
  showOnOnboarding: true,
  /* Just after Accounting, because that is what it is adjacent to in meaning. */
  sortOrder: 58,
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
  console.log("Done. Reload /onboarding — the Budget tile should appear.");
  console.log(
    "Note: admins see it immediately. Department heads need this department granted\n" +
      "to them in Access Control before the tile shows on their portal.\n",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
