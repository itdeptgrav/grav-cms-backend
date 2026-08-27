// scripts/add-mrf-app.js
//
// The Material Requests tile.
//
// It is a row, not code: the launcher draws whatever active departments the
// signed-in account holds, so "adding an app" means adding an AccessDepartment
// and granting it.
//
// An ORDINARY CMS department — no external origin, no SSO. Material Requests
// runs in the CMS on the CMS login, at /mrf, against the same Mongo data the
// store side already reads. It was briefly wired as a handoff into Cowork;
// that was the wrong shape, and this fixes an existing row if it finds one.
//
// Dry by default. Pass --yes to write.
"use strict";

require("dotenv").config({ quiet: true });
const mongoose = require("mongoose");

const SLUG = "mrf";
const NAME = "Material Requests";
const DESCRIPTION = "Ask Store for materials and track approvals.";
const PATH = "/mrf";

(async () => {
  const write = process.argv.includes("--yes");
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const AccessDepartment = require("../models/Access/AccessDepartment");

  const existing = await AccessDepartment.findOne({ slug: SLUG });

  if (existing) {
    /* Repair rather than refuse: the row may have been created when this was
       an external handoff, and an `externalBaseUrl` left on it would send the
       tile to another origin instead of opening the CMS app. */
    const fixes = {};
    if (existing.externalBaseUrl) fixes.externalBaseUrl = "";
    if (existing.dashboardPath !== PATH) fixes.dashboardPath = PATH;
    if (existing.name !== NAME) fixes.name = NAME;
    if (!existing.isActive) fixes.isActive = true;

    if (!Object.keys(fixes).length) {
      console.log(`"${NAME}" is already correct — nothing to do.`);
      return mongoose.disconnect();
    }
    console.log(write ? "Fixing:" : "Would fix (dry run — pass --yes):");
    console.log(JSON.stringify(fixes, null, 2));
    if (write) {
      await AccessDepartment.updateOne({ _id: existing._id }, { $set: fixes });
      console.log("\nDone. The tile now opens /mrf inside the CMS.");
    }
    return mongoose.disconnect();
  }

  const doc = {
    key: "MRF",
    slug: SLUG,
    name: NAME,
    description: DESCRIPTION,
    dashboardPath: PATH,
    isActive: true,
    showOnOnboarding: true,
  };

  console.log(write ? "Creating:" : "Would create (dry run — pass --yes):");
  console.log(JSON.stringify(doc, null, 2));
  if (write) {
    const made = await AccessDepartment.create(doc);
    console.log(`\nCreated ${made._id}. Grant it on the Access Control page.`);
  }
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
