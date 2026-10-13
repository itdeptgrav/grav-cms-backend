"use strict";
/**
 * services/ai/storeCollectionOwnership.js — which application owns a
 * collection, and whether Store search reads it.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 * "Is any Store data missed?" used to be answered by counting catalogued
 * CONCEPTS, which says nothing about a collection nobody catalogued at all.
 * The honest question is per collection: for every collection in the
 * database, either Store search reads it, or it is deliberately left alone
 * with a reason, or it belongs to another application. Anything else is a
 * gap. `scripts/audits/store-collection-coverage.js` asks that question and
 * fails on a gap; this module is what it asks.
 *
 * ── OWNERSHIP IS READ FROM THE REPOSITORY, NOT GUESSED FROM A NAME ────────
 * A collection's owner is the directory of the model that writes it — a
 * model under `models/CMS_Models/StorePurchase/` is Store's, one under
 * `models/HR_Models/` is HR's. That is a property the repository already
 * holds, so a model added tomorrow is classified by where it is put, and a
 * model put somewhere this table does not know fails the audit rather than
 * being waved through.
 *
 * Collections with NO model — written by an older module, another service
 * sharing the database, or nothing any more — cannot be placed that way, so
 * each one any running code still names is declared below with its owner and
 * the evidence. One no running code names is reported as orphaned.
 *
 * No database access here: the audit supplies what it read.
 */

const path = require("path");
const { ENTITY_SPECS } = require("../storePurchaseUniversalContract");
const { CONTRACTS: LEGACY_STORE_CONTRACTS } = require("../storeApplicationFieldContracts");
const { excludedCollection } = require("./storeCommandExclusions");

const STORE = "store";
const ROOT = path.join(__dirname, "..", "..");

/**
 * Model locations and the application that owns what they write.
 *
 * Longest prefix wins, so a file can be placed more specifically than its
 * directory. The four Store roots are the ones the gate applies to.
 */
const OWNERS = Object.freeze([
  ["models/CMS_Models/Inventory/", STORE],
  ["models/CMS_Models/Store/", STORE],
  ["models/CMS_Models/StorePurchase/", STORE],
  ["models/CMS_Models/Requests/", STORE],
  ["models/StoreDepartment.js", STORE],

  /* The scanners are fitted to production machines and managed from the
     production supervisor's firmware screen and /barcode-scanner-device —
     no Store screen shows them. */
  ["models/Barcode_Scanner_Device/", "production devices"],
  ["models/CMS_Models/Configurations/", "CMS configuration"],
  ["models/CMS_Models/Manufacturing/", "manufacturing"],
  ["models/CMS_Models/Sales/", "sales"],
  ["models/CMS_Models/Merchandising/", "merchandising"],
  ["models/CMS_Models/PPC/", "production planning"],
  ["models/CMS_Models/IndustrialEngineering/", "industrial engineering"],
  ["models/CMS_Models/Costing/", "costing"],
  ["models/CMS_Models/Marketing/", "marketing"],
  ["models/CMS_Models/RnD/", "R&D"],
  ["models/CMS_Models/Board/", "board"],
  ["models/CMS_Models/AI/", "assistant"],
  ["models/CMS_Models/Notifications/", "notifications"],
  ["models/Accountant_model/", "accounting"],
  ["models/HR_Models/", "HR"],
  ["models/Employee.js", "HR"],
  ["models/Salaryconfig.js", "HR"],
  ["models/Access/", "access control"],
  ["models/Auth/", "authentication"],
  ["models/Customer_Models/", "customer portal"],
  ["models/Vendor_Models/", "vendor portal"],
  ["models/MpcMeasurement.js", "measurement"],
  ["models/ProjectManager.js", "project management"],
  ["models/DevOps/", "operations tooling"],
  ["models/BandwidthSample.js", "operations tooling"],
  ["models/Appversion.js", "mobile app"],
  ["models/Files/", "files"],
  ["models/Planner/", "planner"],
  ["models/BandConfig.js", "cowork"],
  ["models/CallEvent.js", "cowork"],
  ["models/CallRecording.js", "cowork"],
  ["models/VoiceContact.js", "GRAV Voice"],
  ["models/sopmodel/", "cowork"],
  ["models/music/", "media"],
  ["models/FieldLocationPing.js", "field sales tracking"],
  ["models/FieldTrackingSession.js", "field sales tracking"],
  ["models/FieldVisit.js", "field sales tracking"],
  ["models/FieldZone.js", "field sales tracking"],
  /* Department sign-in accounts. The Store one is listed with Store above
     and excluded as credentials; the others are their departments'. */
  ["models/CEODepartment.js", "department sign-in"],
  ["models/CuttingMasterDepartment.js", "department sign-in"],
  ["models/EmbroideryDepartment.js", "department sign-in"],
  ["models/HRDepartment.js", "department sign-in"],
  ["models/PackagingDispatchDepartment.js", "department sign-in"],
  ["models/ProductionSupervisorDepartment.js", "department sign-in"],
  ["models/QCDepartment.js", "department sign-in"],
  ["models/SalesDepartment.js", "department sign-in"],
]);

/**
 * Collections with no model that running code still names, or that hold rows.
 *
 * Read on 8 Oct 2026 against the live database. "Website shop" is the GRAV
 * public storefront — a different service sharing this database; its
 * `settings` row holds a store name and a delivery fee, which is why it is
 * easy to mistake for Store & Purchase.
 */
const UNMODELLED = Object.freeze({
  acc_bank_recon_sessions: { owner: "accounting", evidence: "raw collection of routes/Accountant_Routes/Acc_bankRecon.js" },
  accountant_organizations: { owner: "accounting", evidence: "pre-`acc_` name, copied by scripts/migrate_to_acc_namespace.js" },
  accountant_users: { owner: "accounting", evidence: "pre-`acc_` name, read by services/access/accountingAccess.js" },
  accountantdepartments: { owner: "accounting", evidence: "the accountant department's sign-in accounts, read by Acc_auth.js" },
  workspacemembers: { owner: "accounting", evidence: "pre-`acc_` name, listed in scripts/migrate_to_acc_namespace.js" },
  budgets: { owner: "accounting", evidence: "empty; the name appears in budgetControl.service.js and the acc_ migration" },
  expenses: { owner: "accounting", evidence: "empty; an accounting word in the chart of accounts, not this collection" },
  invoices: { owner: "accounting", evidence: "empty; an accounting word in accountingContext.js, not this collection" },
  payments: { owner: "accounting", evidence: "empty; an accounting word in accountingContext.js, not this collection" },
  proforma_invoices: { owner: "accounting", evidence: "empty; pre-`acc_` name of acc_proforma_invoices" },
  categories: { owner: "website shop", evidence: "storefront categories — name, image, slug, position" },
  products: { owner: "website shop", evidence: "storefront products — title, price, compareAtPrice, variants" },
  orders: { owner: "website shop", evidence: "empty; the storefront's orders" },
  settings: { owner: "website shop", evidence: "storefront settings — storeName, deliveryFee, codFee" },
  sitecontents: { owner: "website shop", evidence: "storefront page content — section, label, value" },
  users: { owner: "website shop", evidence: "storefront customer accounts — addresses, tokenVersion" },
  wallets: { owner: "website shop", evidence: "storefront customer wallet — cashIn, cashOut" },
  costingrequests: { owner: "costing", evidence: "a costing request against an enquiry and journey" },
  crm_sequences: { owner: "sales", evidence: "reference counters for services/enquiryRef.js and leadRef.js" },
  parts: { owner: "sales", evidence: "empty; a word in routes/CMS_Routes/Sales/enquiries.js, not this collection" },
  documentsconfig: { owner: "HR", evidence: "letter settings — probation, notice period, letterhead" },
  employeepolicyconfig: { owner: "HR", evidence: "employee defaults — probation, password policy" },
  importexportconfig: { owner: "HR", evidence: "employee import settings — upload size, required fields" },
  overtimesettings: { owner: "HR", evidence: "overtime rules — scheduled out time, grace tiers" },
  payslipconfig: { owner: "HR", evidence: "payslip layout — visible earnings and deductions" },
  reportsconfig: { owner: "HR", evidence: "attendance report settings — paid attendance codes" },
  shiftswaps: { owner: "HR", evidence: "a shift swap between two employees" },
  ownercanteendatas: { owner: "canteen", evidence: "a canteen owner's menu, plans and customers" },
  projectmanagersettings: { owner: "project management", evidence: "product approval switch and template" },
  grav_storage: { owner: "file storage", evidence: "the storage service's own sign-in accounts" },
  ie_demo_manifest: { owner: "industrial engineering", evidence: "what scripts/ie/seed-*.js seeded, so it can be removed" },
  _migration_flags: { owner: "operations tooling", evidence: "which one-off migrations have run" },
});

const CATEGORY = Object.freeze({
  CATALOGUED: "catalogued",
  LEGACY: "served by the legacy store family",
  EXCLUDED: "deliberately excluded",
  OTHER: "another application",
  ORPHANED: "orphaned",
  UNCLASSIFIED: "UNCLASSIFIED",
});

/** The application a model file belongs to, by the longest matching prefix. */
function ownerOfFile(file) {
  const rel = String(file || "").replace(/\\/g, "/");
  let best = null;
  for (const [prefix, owner] of OWNERS) {
    if (rel.startsWith(prefix) && (!best || prefix.length > best[0].length)) best = [prefix, owner];
  }
  return best ? best[1] : null;
}

/** Every model a module exports — one, or an object of several. */
function modelsIn(exported) {
  const isModel = (value) => typeof value === "function" && value.collection?.name && value.schema;
  if (isModel(exported)) return [exported];
  if (exported && typeof exported === "object") return Object.values(exported).filter(isModel);
  return [];
}

/** Collections the universal Store & Purchase catalogue reads, by family. */
function cataloguedCollections() {
  const out = new Map();
  for (const spec of ENTITY_SPECS) out.set(spec.model.collection.name, spec.id);
  return out;
}

/** Collections the legacy `store` family reads, from its own field contracts. */
function legacyCollections() {
  const out = new Map();
  for (const contract of LEGACY_STORE_CONTRACTS) {
    for (const source of contract.sourceModels || []) {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      for (const model of modelsIn(require(path.join(ROOT, source)))) {
        out.set(model.collection.name, contract.id);
      }
    }
  }
  return out;
}

/**
 * Classify one collection.
 *
 * @param {object} facts
 * @param {string}   facts.name           the collection
 * @param {string[]} facts.modelFiles     repo-relative model files that write it
 * @param {boolean}  facts.namedByCode    whether running code names it (for
 *                                        collections with no model)
 * @param {object}   [facts.catalogued]   from `cataloguedCollections()`
 * @param {object}   [facts.legacy]       from `legacyCollections()`
 */
function classifyCollection({
  name, modelFiles = [], namedByCode = false,
  catalogued = cataloguedCollections(), legacy = legacyCollections(),
}) {
  /* Who OWNS it comes from its model; whether Store search READS it is the
     category. A Sales account the Store catalogue reads is still Sales'. */
  const ownerOf = () => [...new Set(modelFiles.map(ownerOfFile).filter(Boolean))].join(" + ") || STORE;
  if (catalogued.has(name)) {
    return { category: CATEGORY.CATALOGUED, application: ownerOf(), detail: catalogued.get(name) };
  }
  if (legacy.has(name)) {
    return { category: CATEGORY.LEGACY, application: ownerOf(), detail: legacy.get(name) };
  }
  const excluded = excludedCollection(name);
  if (excluded) {
    return { category: CATEGORY.EXCLUDED, application: STORE, detail: excluded.reason, instead: excluded.instead };
  }

  if (modelFiles.length) {
    const owners = [...new Set(modelFiles.map(ownerOfFile))];
    if (owners.includes(null)) {
      return {
        category: CATEGORY.UNCLASSIFIED,
        application: null,
        detail: `a model in a location no owner is declared for: ${modelFiles.join(", ")}`,
      };
    }
    if (owners.includes(STORE)) {
      return {
        category: CATEGORY.UNCLASSIFIED,
        application: STORE,
        detail: `a Store model nothing in search reads, and no exclusion explains: ${modelFiles.join(", ")}`,
      };
    }
    return { category: CATEGORY.OTHER, application: owners.join(" + "), detail: modelFiles.join(", ") };
  }

  const declared = UNMODELLED[name];
  if (declared) return { category: CATEGORY.OTHER, application: declared.owner, detail: declared.evidence };
  if (namedByCode) {
    return {
      category: CATEGORY.UNCLASSIFIED,
      application: null,
      detail: "no model writes it, running code names it, and no owner is declared",
    };
  }
  return { category: CATEGORY.ORPHANED, application: null, detail: "no model writes it and no running code names it" };
}

module.exports = {
  STORE, OWNERS, UNMODELLED, CATEGORY,
  ownerOfFile, modelsIn, cataloguedCollections, legacyCollections, classifyCollection,
};
