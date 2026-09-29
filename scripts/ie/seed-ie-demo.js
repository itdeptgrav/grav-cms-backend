#!/usr/bin/env node
"use strict";
/*
 * scripts/ie/seed-ie-demo.js
 *
 * A REPEATABLE INDUSTRIAL ENGINEERING DEMO, FOR LOCAL DEVELOPMENT ONLY.
 *
 * ── WHY IT EXISTS ───────────────────────────────────────────────────────────
 * Every IE screen is correct and every IE screen is empty, so the application
 * cannot be judged. This builds one coherent scenario — two companies, a real
 * order, an engineering file, an approved bulletin version, a balanced and
 * approved layout, an approved capacity standard, a ramp, and a release issued
 * to PPC — entirely through the services the routes call.
 *
 * ── WHAT IT REFUSES TO DO ───────────────────────────────────────────────────
 * It refuses to run against anything that is not a local database. See
 * `ieDemoGuards.js`: on this checkout the house convention
 * (`NODE_ENV !== production` plus a database named `test`) would have passed
 * while pointing at the team's live Atlas cluster.
 *
 *   Seed:     IE_DEMO_SEED=1 IE_DEMO_PASSWORD=... \
 *               node -r dotenv/config scripts/ie/seed-ie-demo.js --apply
 *   Clean up: IE_DEMO_SEED=1 IE_DEMO_PASSWORD=... \
 *               node -r dotenv/config scripts/ie/seed-ie-demo.js --purge
 *
 * `MONGODB_URI` must name a LOCAL replica set — release issuance is written in
 * one real transaction, which a standalone mongod refuses.
 *
 * ── IDEMPOTENT, AND NARROW ──────────────────────────────────────────────────
 * A second run reuses the manifest and updates in place. `--purge` deletes by
 * the ids the manifest recorded and nothing else: it never runs a query like
 * "delete companies whose name contains demo", because the record that matters
 * is the one somebody renamed.
 *
 * This file is new and development-only. It changes no application behaviour.
 */

const mongoose = require("mongoose");

const {
  DEMO_TAG, OPT_IN, PASSWORD_VAR, assertSeedable, assertReplicaSet, redact,
} = require("./ieDemoGuards");
const { IDENTITIES, upsertIdentity, upsertCompanyWorld } = require("./ieDemoScenario");
const {
  OPERATIONS, RETIRED_CODE, actorOf, seedLibrary, seedAllowancePolicy, approveRowTimes,
  retireOneOperation,
} = require("./ieDemoLifecycle");

const styleFiles = require("../../services/industrialEngineering/ieStyleFile.service");
const versions = require("../../services/industrialEngineering/ieBulletinVersion.service");
const layouts = require("../../services/industrialEngineering/ieLineLayout.service");
const capacity = require("../../services/industrialEngineering/ieCapacityStandard.service");
const ramps = require("../../services/industrialEngineering/ieRampProfile.service");
const releases = require("../../services/industrialEngineering/ieRelease.service");
const { transactionsAvailable } = require("../../services/storePurchase/unitOfWork.service");

const AccessDepartment = require("../../models/Access/AccessDepartment");
const { verifyScenario } = require("./ieDemoIntegrity");

/* ══ THE DEPARTMENTS THE SHELLS AND GUARDS READ ═══════════════════════════
 *
 * `ie` is copied field-for-field from `services/ensureAccessDepartments.js`.
 * `ppc` is the row that file does not yet have — reported separately as the
 * one application change this lane may not make.
 *
 * ── WHY THE SEEDER CREATES THEM ─────────────────────────────────────────────
 * An isolated in-memory database starts with nothing, so "boot the backend
 * once first" would be a manual step before a script whose whole purpose is to
 * remove manual steps. Creating them here is LOCAL DEMO CONFIGURATION of an
 * empty database, not a change to how the application decides its departments:
 * the definitions are the application's own, and on a database that already
 * has them nothing is written.
 *
 * Whether this seeder created each one is recorded, because `--purge` may only
 * remove what it made. A `ppc` row somebody else added is theirs.
 */
const DEPARTMENTS = Object.freeze({
  ie: {
    key: "ie", slug: "ie", name: "Industrial Engineering", sortOrder: 47,
    legacyModel: null, legacyCollection: "iedepartments", legacyUserType: "ie",
    dashboardPath: "/industrial-engineering/orders",
    description: "Operation standards, style bulletins, SAM, line balance and capacity standards.",
  },
  ppc: {
    key: "ppc", slug: "ppc", name: "Production Planning", sortOrder: 48,
    legacyModel: null, legacyCollection: "ppcdepartments", legacyUserType: "ppc",
    dashboardPath: "/ppc/engineering-releases",
    description: "Receives frozen engineering releases from Industrial Engineering and answers them.",
  },
});

/** Create only what is missing, and remember which ones those were. */
async function ensureDemoDepartments(manifest) {
  const out = {};
  for (const [slug, definition] of Object.entries(DEPARTMENTS)) {
    let row = await AccessDepartment.findOne({ slug });
    if (!row) {
      row = await AccessDepartment.create({ ...definition, isActive: true });
      manifest.createdDepartments.push(slug);
    }
    out[slug] = row;
  }
  return out;
}

const MANIFEST = "ie_demo_manifest";

const PRIMARY = "IE Demo Garments";
const SECONDARY = "IE Demo Textiles";

/* Several orders, so the register is not a one-row mockup. */
const PRIMARY_ORDERS = [
  { key: "A", product: "Short-sleeve tee", styleCode: "TEE-SS-01", colour: "Navy", quantity: 2400, status: "in_progress", customer: "Northwind Apparel Ltd" },
  { key: "B", product: "Long-sleeve tee", styleCode: "TEE-LS-02", colour: "Charcoal", quantity: 1200, status: "planned", customer: "Northwind Apparel Ltd" },
  { key: "C", product: "Polo shirt", styleCode: "POLO-03", colour: "White", quantity: 900, status: "planned", customer: "Harbour Retail" },
];
const SECONDARY_ORDERS = [
  { key: "A", product: "Cotton vest", styleCode: "VEST-01", colour: "Ecru", quantity: 600, status: "planned", customer: "Textiles Direct" },
];

const blankManifest = () => ({
  _id: DEMO_TAG, tag: DEMO_TAG, seededAt: null,
  companyIds: [], journeyIds: [], enquiryIds: [], styleIds: [], stockItemIds: [], workOrderIds: [],
  employeeIds: [], deptUserIds: [], membershipIds: [], grants: [],
  createdDepartments: [],
  operationIds: [], policyIds: [], studyIds: [], fileIds: [], versionIds: [],
  layoutIds: [], standardIds: [], rampIds: [], releaseIds: [],
  notes: [],
});

const uniq = (a) => [...new Set(a.map(String))];

async function loadManifest(db) {
  return (await db.collection(MANIFEST).findOne({ _id: DEMO_TAG })) || null;
}

/* ══ THE SCENARIO ═════════════════════════════════════════════════════════ */

async function buildPrimary({ ctx, editor, approver, world, manifest, skipRelease }) {
  const styleFilesSvc = styleFiles;
  const notes = manifest.notes;

  const ops = await seedLibrary(ctx, editor, approver, manifest);
  await seedAllowancePolicy(ctx, editor, approver, manifest);

  /* A ramp profile, so the capacity standard can be calculated against one
     explicitly chosen stage rather than a steady state nobody reaches on
     day one. */
  const ramp = await ramps.createProfile(ctx, {
    body: {
      name: `${DEMO_TAG} new-style ramp`,
      stages: [
        { label: "Week 1", fromProductionDay: 1, toProductionDay: 6, targetEfficiencyPercent: 35 },
        { label: "Week 2", fromProductionDay: 7, toProductionDay: 12, targetEfficiencyPercent: 55 },
        { label: "Steady", fromProductionDay: 13, toProductionDay: null, targetEfficiencyPercent: 70 },
      ],
    },
    actor: actorOf(editor),
  });
  const rampProfileId = ramp.profile.rampProfileId;
  manifest.rampIds.push(String(rampProfileId));
  const stage = ramp.profile.stages[0];

  const built = [];

  /* Order A carries the full chain. Orders B and C get an engineering file and
     a saved bulletin only, so the register shows styles at DIFFERENT stages
     rather than every row looking identical. */
  for (const order of world.orders) {
    const file = await styleFiles.createFile(ctx, {
      orderId: String(order.wo._id), styleId: String(order.style._id),
      actor: actorOf(editor),
    });
    const fileId = file.file.fileId;
    manifest.fileIds.push(String(fileId));

    const rows = OPERATIONS
      .filter((op) => order.key === "A" || op.code !== RETIRED_CODE)
      .map((op) => ({ ieOperationId: String(ops[op.code]), proposedSamMinutes: op.minutes }));

    const saved = await styleFiles.updateBulletin(ctx, {
      fileId, body: { expectedRevision: file.file.revision, rows },
      actor: actorOf(editor),
    });

    const rowsOut = saved.file.bulletin?.rows || [];

    /* ── EVERY ROW NEEDS AN APPROVED STANDARD TIME ──────────────────────
       The readiness gate refuses a submission otherwise, one gap per row.
       Order A gets every row approved so the chain can complete; B and C get
       all but the last, so the register shows a file that is genuinely
       PART-WAY and its gap list is a real one rather than a decoration. */
    const minutesByCode = {};
    for (const op of OPERATIONS) minutesByCode[op.code] = op.minutes;
    if (order.key !== "A") {
      const last = rowsOut[rowsOut.length - 1];
      if (last) delete minutesByCode[last.operationCode];
    }

    await approveRowTimes(ctx, {
      fileId, rows: rowsOut, editor, approver, minutesByCode, manifest,
    });

    /* Re-read so the caller holds the rows WITH their approved times. */
    const after = await styleFiles.readFileForStyle(ctx, {
      orderId: String(order.wo._id), styleId: String(order.style._id),
    }).catch(() => null);
    const finalFile = after?.file || saved.file;

    built.push({
      order, fileId,
      revision: finalFile.revision,
      rows: finalFile.bulletin?.rows || rowsOut,
    });
    if (order.key !== "A") {
      notes.push(`${order.ref}: engineering file + saved bulletin only (deliberately mid-journey).`);
    }
  }

  const lead = built.find((b) => b.order.key === "A");

  /* ── THE APPROVED CHAIN, MAKER THEN CHECKER ──────────────────────────── */
  const submitted = await versions.submitVersion(ctx, {
    fileId: lead.fileId,
    body: { expectedRevision: lead.revision },
    actor: actorOf(editor),
  });
  const versionId = submitted.version.bulletinVersionId;
  manifest.versionIds.push(String(versionId));

  const approvedVersion = await versions.approveVersion(ctx, {
    versionId, body: { expectedRevision: submitted.version.revision },
    actor: actorOf(approver),
  });

  /* ── AND NOW THE LIBRARY MOVES ON ───────────────────────────────────────
     One operation is retired AFTER the version froze, which is the situation
     the release override and the impact screen exist for. Retiring it earlier
     would simply have blocked the submission. */
  /* Retired by the EDITOR, overridden at release time by the APPROVER.
     `issueRelease` enforces maker-checker on the override — the person who
     withdrew an operation may not be the person who waves it through — and
     that separation is the point of the rule, not an obstacle to it. */
  await retireOneOperation(ctx, ops[RETIRED_CODE], editor);
  notes.push(
    `${RETIRED_CODE} retired by the editor AFTER the bulletin version was approved, `
    + "so the release carries a real override approved by a second person.",
  );

  const layout = await layouts.createLayout(ctx, {
    fileId: lead.fileId, body: {}, actor: actorOf(editor),
  });
  const layoutId = layout.layout.layoutId;
  manifest.layoutIds.push(String(layoutId));

  /* ── EVERY ROW SITS AT A STATION ────────────────────────────────────────
     The layout cannot be approved while a row is unassigned, which is correct:
     a balance that quietly omits an operation is not a balance. So the rows are
     chunked across four stations rather than mapped by hand — a fixed grouping
     silently stops covering everything the moment the bulletin changes length.

     The server computes pitch, bottleneck, balance efficiency and loss. The
     seeder only says which row sits where. */
  /* The rows to place come from the layout's OWN readiness gap, which names
     them — the same list the Line Planning screen works from. A freshly opened
     layout publishes its operations through `stations[].assignments` only, so
     there is no top-level row array to read, and inventing one from the
     bulletin would be this seeder guessing at a mapping the server owns. */
  const unassigned = (layout.layout.readiness?.gaps || [])
    .find((g) => g.code === "IE_LAYOUT_ROWS_UNASSIGNED");
  const rowIds = unassigned?.rowIds || [];
  if (!rowIds.length) {
    throw new Error("Refusing to seed: the new layout named no rows to place.");
  }

  /* A station must also say which machine TYPES it is planned to hold, or the
     layout cannot prove that the operations placed there can actually run —
     `IE_LAYOUT_STATION_MACHINE_TYPE_MISSING`. The types are derived from the
     operations placed at each station rather than declared up front, so the
     plan says what the work needs and stays true if the grouping changes. */
  const machineByRowId = new Map();
  for (const row of lead.rows) {
    const op = OPERATIONS.find((o) => o.code === row.operationCode);
    if (op) machineByRowId.set(row.rowId, op.machineType);
  }

  const STATION_COUNT = 4;
  const per = Math.ceil(rowIds.length / STATION_COUNT);
  const stations = [];
  for (let i = 0; i < rowIds.length; i += per) {
    const slice = rowIds.slice(i, i + per);
    const types = [...new Set(slice.map((r) => machineByRowId.get(r)).filter(Boolean))];
    stations.push({
      label: `Station ${stations.length + 1}`,
      assignments: slice.map((rowId) => ({ rowId })),
      plannedMachineTypes: types.map((machineType) => ({ machineType, quantity: 1 })),
    });
  }

  const arranged = await layouts.updateLayout(ctx, {
    layoutId, body: { expectedRevision: layout.layout.revision, stations },
    actor: actorOf(editor),
  });

  let approvedLayout;
  try {
    approvedLayout = await layouts.approveLayout(ctx, {
      layoutId, body: { expectedRevision: arranged.layout.revision },
      actor: actorOf(approver),
    });
  } catch (err) {
    if (process.env.IE_DEMO_DEBUG === "1") {
      console.error("LAYOUT GAPS:", JSON.stringify(err?.details || err?.message, null, 2).slice(0, 1200));
    }
    throw err;
  }

  /* The layout is an ARGUMENT, not a body field — the standard is opened
     against one exact layout and the service refuses it in the body. */
  const standard = await capacity.createStandard(ctx, {
    layoutId: String(layoutId),
    body: {
      availableShiftMinutes: 480, breakMinutes: 40, shiftsPerDay: 1,
      plannedOperatorCount: 18, plannedHelperCount: 3,
      targetEfficiencyPercent: 62,
      effectiveFrom: "2026-10-01",
      rampProfileId: String(rampProfileId), rampStageId: String(stage.stageId),
      note: `${DEMO_TAG} first standard`,
    },
    actor: actorOf(editor),
  });
  const standardId = standard.standard.capacityStandardId;
  manifest.standardIds.push(String(standardId));

  const approvedStandard = await capacity.approveStandard(ctx, {
    capacityStandardId: standardId,
    body: { expectedRevision: standard.standard.revision },
    actor: actorOf(approver),
  });

  let release = null;
  if (skipRelease) {
    notes.push("Release skipped by IE_DEMO_SKIP_RELEASE=1: no transaction available.");
  } else {
    const issued = await releases.issueRelease(ctx, {
      fileId: String(lead.fileId),
      body: {
        bulletinVersionId: String(versionId),
        expectedBulletinVersionNo: approvedVersion.version.versionNo,
        lineLayoutId: String(layoutId),
        expectedLayoutRevision: approvedLayout.layout.revision,
        capacityStandardId: String(standardId),
        expectedCapacityRevision: approvedStandard.standard.revision,
        /* The retired operation's identity and FROZEN revision, taken from the
           bulletin row the server itself wrote — never from the library and
           never assumed. `issueRelease` refuses an override for an operation
           it did not name, so if the retirement is not actually blocking this
           release the list is empty and the command is unchanged. */
        retiredOperationOverrides: retiredOverride(lead.rows, RETIRED_CODE),
        note: `${DEMO_TAG} issued for the October run.`,
      },
      idempotencyKey: `${DEMO_TAG}-release-1`,
      actor: actorOf(approver),
    });
    release = issued.release;
    manifest.releaseIds.push(String(release.releaseId));
  }

  return { lead, versionId, layoutId, standardId, rampProfileId, release, built };
}

/**
 * The override entry for a retired operation, built from the SAVED bulletin
 * row.
 *
 * The row carries `ieOperationId` and the `ieOperationRevision` the server
 * froze when the bulletin was saved, which is exactly what `issueRelease`
 * compares against. Reading the library again would risk sending a revision
 * that had moved since.
 */
function retiredOverride(rows, code) {
  const row = (rows || []).find((r) => r.operationCode === code);
  if (!row) return [];
  return [{
    ieOperationId: String(row.ieOperationId),
    ieOperationRevision: row.ieOperationRevision,
    reason: `${DEMO_TAG}: hand finish is retired but still performed on this run.`,
  }];
}

/* ══ ENTRY ════════════════════════════════════════════════════════════════ */

async function connect(uri) {
  await mongoose.connect(uri, { autoIndex: false });
  return mongoose.connection;
}

/**
 * Remove this demo's records, by id.
 *
 * ── TWO SCOPES ──────────────────────────────────────────────────────────────
 * `"all"` is `--purge`: everything this demo made, including the people and
 * the companies.
 *
 * `"ie"` is what a REBUILD uses. A broken engineering chain does not mean the
 * companies or the six identities are wrong, and deleting a company would
 * change its id — which would orphan every membership pointing at it and
 * leave each identity holding two, one of them at a company that no longer
 * exists. So a rebuild removes exactly the IE-owned records and leaves the
 * tenants and the people where they are.
 */
async function purge(db, out = console, { scope = "all" } = {}) {
  const keepIdentities = scope !== "all";
  const m = await loadManifest(db);
  if (!m) { out.log("Nothing to purge: no demo manifest."); return { removed: 0 }; }

  const { Types } = mongoose;
  const ids = (a) => (a || []).filter((v) => Types.ObjectId.isValid(String(v)))
    .map((v) => new Types.ObjectId(String(v)));

  /* BY ID ONLY. Never by a name pattern — the record that matters is the one
     somebody renamed. */
  const plan = [
    ["ie_releases", m.releaseIds], ["ie_command_ledger", null],
    ["ie_capacity_standards", m.standardIds],
    ["ie_line_layouts", m.layoutIds],
    ["ie_bulletin_versions", m.versionIds],
    ["ie_style_files", m.fileIds],
    ["ie_ramp_profiles", m.rampIds],
    ["ie_allowance_policies", m.policyIds],
    ["ie_method_studies", m.studyIds],
    ["ie_operations", m.operationIds],
    /* The source chain and the tenants survive a rebuild: their ids are what
       the surviving memberships and styles point at. */
    ...(keepIdentities ? [] : [
      ["workorders", m.workOrderIds],
      ["samplestyles", m.styleIds],
      ["stockitems", m.stockItemIds],
      ["enquiries", m.enquiryIds],
      ["salesjourneys", m.journeyIds],
      ["sp_company_memberships", m.membershipIds],
      ["dept_users", m.deptUserIds],
      ["employees", m.employeeIds],
      ["acc_companies", m.companyIds],
    ]),
  ];

  let removed = 0;
  for (const [coll, list] of plan) {
    if (!list || !list.length) continue;
    const r = await db.collection(coll).deleteMany({ _id: { $in: ids(list) } }).catch(() => ({ deletedCount: 0 }));
    removed += r.deletedCount || 0;
  }

  /* Grants are keyed by slug+email, not by id. */
  for (const g of (keepIdentities ? [] : m.grants || [])) {
    const r = await db.collection("department_roles")
      .deleteMany({ departmentSlug: g.department, email: g.email }).catch(() => ({ deletedCount: 0 }));
    removed += r.deletedCount || 0;
  }
  /* The command ledger rows this demo's own idempotency keys created. */
  await db.collection("ie_command_ledger")
    .deleteMany({ idempotencyKey: new RegExp(`^${DEMO_TAG}-`) }).catch(() => {});

  /* ── DEPARTMENTS THIS SEEDER CREATED, AND ONLY THOSE ──────────────────
     A department row somebody else added is theirs, and an `ie` row that was
     already there before the demo ran is the application's. */
  if (!keepIdentities) {
    for (const slug of m.createdDepartments || []) {
      const r = await db.collection("access_departments").deleteOne({ slug })
        .catch(() => ({ deletedCount: 0 }));
      removed += r.deletedCount || 0;
    }
    await db.collection(MANIFEST).deleteOne({ _id: DEMO_TAG });
    out.log(`Purged ${removed} demo records and the manifest.`);
  }
  return { removed };
}

async function seed(db, { password, skipRelease }, out = console) {
  const existing = await loadManifest(db);

  /* ── A DEEP COPY, AND THE VERDICT TAKEN ON ARRIVAL ──────────────────────
     A shallow spread shares the ARRAY REFERENCES with `existing`, so every
     `manifest.companyIds.push(...)` below also pushed into the record being
     judged — and the integrity check then read four companies on a database
     holding two, and rebuilt a scenario that was perfectly intact.

     So the arrays are copied, and the verdict is taken NOW, against what was
     actually on disk when this run started. */
  const manifest = existing
    ? {
      ...blankManifest(),
      ...existing,
      ...Object.fromEntries(
        Object.entries(existing)
          .filter(([, v]) => Array.isArray(v))
          .map(([k, v]) => [k, [...v]]),
      ),
      notes: [],
    }
    : blankManifest();

  const verdict = existing
    ? await verifyScenario(existing, { skipRelease })
    : { complete: false, reasons: ["no manifest"] };

  /* Self-contained: an empty database gets the two departments it needs. */
  const departments = await ensureDemoDepartments(manifest);
  if (manifest.createdDepartments.includes("ppc")) {
    manifest.notes.push(
      "Created the `ppc` AccessDepartment locally. `services/ensureAccessDepartments.js` "
      + "still has no `ppc` row — that remains the one application change this lane may "
      + "not make, and a non-demo database will not have it until somebody adds it.",
    );
  }

  const companies = {};
  const worlds = {};
  for (const [slot, name, orders] of [
    ["primary", PRIMARY, PRIMARY_ORDERS],
    ["secondary", SECONDARY, SECONDARY_ORDERS],
  ]) {
    const w = await upsertCompanyWorld(slot, name, { orders, manifest });
    companies[slot] = w.company;
    worlds[slot] = w;
  }

  const identities = {};
  for (const spec of IDENTITIES) {
    identities[spec.key] = await upsertIdentity(spec, {
      password,
      /* Each identity points at ITS OWN department. A PPC user aliased to the
         IE row would be a PPC user the switcher sends to Industrial
         Engineering, which is a lie the demo would then be showing. */
      departmentId: departments[spec.dept]._id,
      companies, manifest,
    });
  }

  /* ── ALREADY BUILT? ONLY IF THE WHOLE SCENARIO IS STILL THERE ──────────
     Every member of the manifest is verified, with its links and its lifecycle
     states. One surviving engineering file is not evidence that a release,
     a capacity standard or an identity still exists — and reporting "records
     reused" over a scenario with a hole in it is worse than an empty database,
     because the screens look populated and one journey dead-ends. */
  if (verdict.complete) {
    manifest.notes.push("Scenario verified complete: identities and passwords refreshed, records reused.");
  } else {
    if (existing) {
      manifest.notes.push(`Scenario incomplete, rebuilt. Reasons: ${verdict.reasons.slice(0, 6).join("; ")}`);

      /* ── PURGE BEFORE REBUILD, USING THE OLD IDS ──────────────────────
         The old ids are the only record of what this demo made, so they are
         used to clean up BEFORE they are discarded. Dropping them first would
         orphan every surviving version, layout, standard and release — they
         would sit in the database for ever with nothing naming them, and the
         next `--purge` would not know they existed. */
      await purge(db, { log() {} }, { scope: "ie" });
    }

    /* Only the IE-owned lists are reset. The companies, the source chain and
       the people were not removed and their ids are still correct. */
    for (const key of [
      "operationIds", "policyIds", "studyIds", "fileIds", "versionIds",
      "layoutIds", "standardIds", "rampIds", "releaseIds",
    ]) manifest[key] = [];

    const ctx = { companyId: companies.primary._id, membershipSource: "SERVICE" };
    await buildPrimary({
      ctx,
      editor: identities.ieEditor,
      approver: identities.ieApprover,
      world: worlds.primary,
      manifest, skipRelease,
    });
  }

  /* ── THE MANIFEST NEVER ACCUMULATES ────────────────────────────────────
     A reused run pushes the same ids again — `upsertCompanyWorld` and
     `upsertIdentity` record what they found as well as what they made. Left
     alone the arrays double on every run, and the integrity check then reports
     "manifest records 4 companies, expected 2" on a scenario that is perfectly
     intact. Deduplicated once, here, rather than at each push site. */
  for (const [key, value] of Object.entries(manifest)) {
    if (Array.isArray(value) && key.endsWith("Ids")) manifest[key] = uniq(value);
  }
  manifest.createdDepartments = [...new Set(manifest.createdDepartments || [])];
  manifest.seededAt = new Date();
  await db.collection(MANIFEST).replaceOne({ _id: DEMO_TAG }, manifest, { upsert: true });
  return manifest;
}

/** Accounts, roles and companies — never a password, hash or token. */
function report(manifest, companies, out = console) {
  out.log(`\n${DEMO_TAG} — seeded\n`);
  out.log("Accounts (password is the value of " + PASSWORD_VAR + ", not printed):");
  for (const g of manifest.grants || []) {
    out.log(`  ${g.email.padEnd(34)} ${g.department.padEnd(4)} ${g.role.padEnd(9)} ${g.companies.join(", ")}`);
  }
  out.log("\nRecords:");
  for (const [k, v] of Object.entries(manifest)) {
    if (Array.isArray(v) && k.endsWith("Ids")) out.log(`  ${k.padEnd(16)} ${v.length}`);
  }
  for (const n of manifest.notes || []) out.log(`\n  note: ${n}`);
  out.log("");
}

async function main() {
  const argv = process.argv.slice(2);
  const uri = process.env.MONGODB_URI || "";
  const { password } = assertSeedable(process.env, uri);

  const conn = await connect(uri);
  try {
    if (argv.includes("--purge")) {
      await purge(conn.db || mongoose.connection.db);
      return;
    }
    if (!argv.includes("--apply")) {
      throw new Error("Pass --apply to seed, or --purge to remove the demo.");
    }

    const skipRelease = String(process.env.IE_DEMO_SKIP_RELEASE || "") === "1";
    if (!skipRelease) assertReplicaSet(await transactionsAvailable());

    const db = conn.db || mongoose.connection.db;
    const manifest = await seed(db, { password, skipRelease });
    report(manifest);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\n${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEMO_TAG, MANIFEST, PRIMARY, SECONDARY, PRIMARY_ORDERS, SECONDARY_ORDERS,
  blankManifest, loadManifest, seed, purge, report, buildPrimary, redact,
};
