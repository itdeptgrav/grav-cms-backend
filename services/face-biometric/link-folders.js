"use strict";

/**
 * link-folders.js — connect registration folders to real HR employees.
 *
 * The engine can only identify somebody it has an employee id for. Folders
 * created before that rule existed are named after people, which is not an
 * identity: a name is a label an HR record happens to carry today.
 *
 * This resolves them the only honest way available — by looking the name up
 * in the employee collection and using that record's biometricId. It links
 * ONLY when exactly one employee matches. Two matches, or none, is reported
 * for a human to settle; guessing here would file one person's face under
 * another's id, and every attendance row after that would be wrong.
 *
 *   node services/face-biometric/link-folders.js          # report only
 *   node services/face-biometric/link-folders.js --apply  # write the links
 */

require("dotenv").config();
const fs = require("fs");
const mongoose = require("mongoose");
const faceConfig = require("../../config/faceBiometric");

const APPLY = process.argv.includes("--apply");

/** Compare names the way people mistype them, not byte for byte. */
function normalise(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(s) {
  return new Set(normalise(s).split(" ").filter(Boolean));
}

/** Does the folder name identify this employee unambiguously enough to try? */
function nameScore(folder, employee) {
  const full = [employee.firstName, employee.middleName, employee.lastName]
    .filter(Boolean)
    .join(" ");
  const f = tokens(folder);
  const e = tokens(full);
  if (!f.size || !e.size) return 0;
  let hits = 0;
  for (const t of f) if (e.has(t)) hits += 1;
  // Every token of the folder name must appear in the employee's name.
  // "Pramod" matching "PRAMOD BEHERA" is a real signal; a partial overlap
  // like "Ana" against "Anand" is not, and scores nothing.
  return hits === f.size ? hits / e.size : 0;
}

(async () => {
  const mapPath = faceConfig.FACE_BIOMETRIC_PEOPLE_MAP;
  const regDir = faceConfig.FACE_BIOMETRIC_REGISTERED_DIR;

  const map = fs.existsSync(mapPath)
    ? JSON.parse(fs.readFileSync(mapPath, "utf8"))
    : { version: 1, people: {} };
  map.people = map.people || {};

  const folders = fs.existsSync(regDir)
    ? fs
        .readdirSync(regDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
        .map((d) => d.name)
    : [];
  const unlinked = folders.filter((f) => !map.people[f]);

  console.log(`registered dir : ${regDir}`);
  console.log(`mapping        : ${mapPath}`);
  console.log(`folders        : ${folders.length}   unlinked: ${unlinked.length}`);
  if (!unlinked.length) {
    console.log("nothing to link.");
    process.exit(0);
  }

  await mongoose.connect(
    process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing",
  );
  const Employee = require("../../models/Employee");
  const staff = await Employee.find({
    biometricId: { $exists: true, $nin: [null, ""] },
  })
    .select("firstName middleName lastName biometricId")
    .lean();
  console.log(`employees with a biometricId: ${staff.length}\n`);

  const taken = new Set(
    Object.values(map.people).map((p) => String(p.employee_id)),
  );
  let linked = 0;
  const unresolved = [];

  for (const folder of unlinked) {
    const scored = staff
      .map((e) => ({ e, score: nameScore(folder, e) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);

    if (!scored.length) {
      unresolved.push({ folder, why: "no employee matches this name" });
      continue;
    }
    // A tie is not a match. Linking the first of two equally good candidates
    // is exactly the guess this refuses to make.
    if (scored.length > 1 && scored[1].score === scored[0].score) {
      unresolved.push({
        folder,
        why:
          "ambiguous: " +
          scored
            .filter((x) => x.score === scored[0].score)
            .map((x) => `${x.e.biometricId} ${[x.e.firstName, x.e.lastName].filter(Boolean).join(" ")}`)
            .join(" | "),
      });
      continue;
    }

    const best = scored[0].e;
    const eid = String(best.biometricId);
    const name = [best.firstName, best.middleName, best.lastName]
      .filter(Boolean)
      .join(" ")
      .trim();

    if (taken.has(eid)) {
      // Already claimed by another folder. Allowed — two galleries of one
      // person are merged at identification time — but it is a decision the
      // operator should see, not one made silently.
      console.log(`  ~ ${folder.padEnd(12)} -> ${eid} ${name}  (already linked to another folder)`);
    } else {
      console.log(`  + ${folder.padEnd(12)} -> ${eid} ${name}`);
    }
    if (APPLY) {
      map.people[folder] = {
        employee_id: eid,
        employee_name: name,
        enabled: true,
        linked_at: new Date().toISOString().slice(0, 19),
        linked_by: "link-folders",
      };
      taken.add(eid);
      linked += 1;
    }
  }

  if (unresolved.length) {
    console.log("\n  needs a human:");
    for (const u of unresolved) console.log(`  ? ${u.folder.padEnd(12)} ${u.why}`);
    console.log(
      "\n  Link these explicitly once you know who they are:\n" +
        "    npm run face:link -- --folder <FOLDER> --employee-id <biometricId>",
    );
  }

  if (APPLY && linked) {
    const tmp = `${mapPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2) + "\n");
    fs.renameSync(tmp, mapPath);
    console.log(`\n  wrote ${linked} link(s) to ${mapPath}`);
  } else if (!APPLY) {
    console.log("\n  (dry run — re-run with --apply to write these links)");
  }
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error("link-folders failed:", e.message);
  process.exit(1);
});
