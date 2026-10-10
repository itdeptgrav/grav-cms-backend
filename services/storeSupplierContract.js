"use strict";

const Vendor = require("../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const { compileSemanticCatalogue } = require("./ai/semanticCatalogue");
const { compileFieldCoverageContract, mongooseSchemaPaths } = require("./ai/fieldCoverageContract");

const STORE_PURCHASE_CATALOGUE_ID = "store_purchase";

const DEFINITIONS = Object.freeze([
  ["supplier.company_name", "Supplier company name", ["supplier name", "vendor name", "company name", "name"], "companyName", "text"],
  ["supplier.code", "Supplier code", ["supplier code", "vendor code"], "supplierCode", "text"],
  ["supplier.type", "Supplier type", ["supplier type", "vendor type"], "vendorType", "text"],
  ["supplier.contact_person", "Supplier contact person", ["supplier contact", "vendor contact", "contact person"], "contactPerson", "text"],
  ["supplier.email", "Supplier email", ["supplier email", "vendor email", "email"], "email", "text"],
  ["supplier.phone", "Supplier phone", ["supplier phone", "vendor phone", "phone"], "phone", "text"],
  ["supplier.alternate_phone", "Supplier alternate phone", ["supplier alternate phone", "vendor alternate phone"], "alternatePhone", "text"],
  ["supplier.gstin", "Supplier GSTIN", ["supplier gst", "supplier gstin", "vendor gst"], "gstNumber", "text"],
  ["supplier.pan", "Supplier PAN", ["supplier pan", "vendor pan"], "panNumber", "text"],
  ["supplier.street", "Supplier street", ["supplier street", "supplier address"], "address.street", "text"],
  ["supplier.city", "Supplier city", ["supplier city"], "address.city", "text"],
  ["supplier.state", "Supplier state", ["supplier state"], "address.state", "text"],
  ["supplier.country", "Supplier country", ["supplier country"], "address.country", "text"],
  ["supplier.pincode", "Supplier pincode", ["supplier pincode", "supplier postal code"], "address.pincode", "text"],
  ["supplier.primary_products", "Supplier primary products", ["supplier products", "vendor products", "primary products"], "primaryProducts", "text_list"],
  ["supplier.status", "Supplier status", ["supplier status", "vendor status"], "status", "text"],
  ["supplier.rating", "Supplier rating", ["supplier rating", "vendor rating"], "rating", "number"],
  ["supplier.rating_reason", "Supplier rating reason", ["supplier rating reason", "vendor rating reason"], "ratingReason", "text"],
  ["supplier.rating_recorded_by", "Supplier rating recorded by", ["who rated supplier", "supplier rating by"], "ratingRecordedByName", "text"],
  ["supplier.rating_recorded_at", "Supplier rating recorded at", ["supplier rating date"], "ratingRecordedAt", "date_time"],
  ["supplier.notes", "Supplier notes", ["supplier notes", "vendor notes"], "notes", "text"],
  ["supplier.verified", "Supplier verification status", ["supplier verified", "vendor verified"], "isVerified", "boolean"],
  ["supplier.verified_at", "Supplier verified at", ["supplier verification date"], "verifiedAt", "date_time"],
  ["supplier.verified_by", "Supplier verified by", ["who verified supplier", "supplier verified by"], "verifiedByName", "text"],
  ["supplier.blacklist", "Supplier blacklist details", ["supplier blacklist", "vendor blacklist", "why blacklisted"], ["blacklist.at", "blacklist.byName", "blacklist.reason"], "status_details"],
  ["supplier.archive", "Supplier archive details", ["supplier archive", "vendor archive", "why archived"], ["archive.at", "archive.byName", "archive.reason"], "status_details"],
  ["supplier.created_at", "Supplier created at", ["supplier created date"], "createdAt", "date_time"],
  ["supplier.updated_at", "Supplier updated at", ["supplier updated date", "supplier last updated"], "updatedAt", "date_time"],
].map(([id, label, aliases, path, valueType]) => Object.freeze({
  id, label, aliases: Object.freeze(aliases), path, valueType,
  temporal: "current",
  source: "store_supplier_master",
  domain: "supplier_master",
  entity: "supplier",
})));

const EXCLUDED = Object.freeze({
  _id: "Internal database identifier; supplierCode is the business identifier.",
  __v: "Database concurrency metadata.",
  "archive.by": "Internal actor identifier; the recorded actor name is exposed.",
  "bankDetails.accountName": "Restricted bank-account data is not exposed by the conversational read assistant.",
  "bankDetails.accountNumber": "Restricted bank-account data is not exposed by the conversational read assistant.",
  "bankDetails.bankName": "Restricted bank-account data is not exposed by the conversational read assistant.",
  "bankDetails.branch": "Restricted bank-account data is not exposed by the conversational read assistant.",
  "bankDetails.ifscCode": "Restricted bank-account data is not exposed by the conversational read assistant.",
  "blacklist.by": "Internal actor identifier; the recorded actor name is exposed.",
  companyId: "Server-owned tenancy boundary; never a conversational data field.",
  createdBy: "Internal actor identifier.",
  emailNormalised: "Derived identity index; the canonical email is exposed.",
  gstNormalised: "Derived identity index; the canonical GSTIN is exposed.",
  legacySource: "Migration internals are not business master data.",
  "lifecycleHistory._id": "Recovery-marker storage metadata is not business master data.",
  "lifecycleHistory.action": "Recovery markers are not the authoritative audit stream.",
  "lifecycleHistory.at": "Recovery markers are not the authoritative audit stream.",
  "lifecycleHistory.by": "Recovery markers are not the authoritative audit stream.",
  "lifecycleHistory.byName": "Recovery markers are not the authoritative audit stream.",
  "lifecycleHistory.fromState": "Recovery markers are not the authoritative audit stream.",
  "lifecycleHistory.operationId": "Internal idempotency metadata is not business master data.",
  "lifecycleHistory.reason": "Recovery markers are not the authoritative audit stream.",
  "lifecycleHistory.toState": "Recovery markers are not the authoritative audit stream.",
  migratedAt: "Migration internals are not business master data.",
  panNormalised: "Derived identity index; the canonical PAN is exposed.",
  ratingRecordedBy: "Internal actor identifier; the recorded actor name is exposed.",
  recordVersion: "Optimistic-concurrency metadata.",
  siteId: "Server-owned tenancy/site boundary.",
  updatedBy: "Internal actor identifier.",
  verificationSignature: "Restricted verification evidence is not exposed conversationally.",
  verifiedBy: "Internal actor identifier; the recorded actor name is exposed.",
});

const physicalPaths = [...new Set(DEFINITIONS.flatMap((definition) => (
  Array.isArray(definition.path) ? definition.path : [definition.path]
)))];
const exposed = physicalPaths.map((path) => {
  const owner = DEFINITIONS.find((definition) => (Array.isArray(definition.path) ? definition.path : [definition.path]).includes(path));
  return { id: owner.id, label: owner.label, valueType: owner.valueType, path };
});

const FIELD_CONTRACT = compileFieldCoverageContract({
  id: "store_purchase.supplier_master",
  sourceModels: ["models/CMS_Models/Inventory/Vendor-Buyer/Vendor.js"],
  schemaPaths: mongooseSchemaPaths(Vendor.schema),
  exposed,
  excluded: EXCLUDED,
});

const CATALOGUE = compileSemanticCatalogue({
  id: STORE_PURCHASE_CATALOGUE_ID,
  domains: [{ id: "supplier_master", label: "supplier master", aliases: ["vendor master", "supplier profile", "vendor profile"] }],
  entities: [{ id: "supplier", label: "supplier", aliases: ["vendor"] }],
  metrics: DEFINITIONS,
});

module.exports = {
  STORE_PURCHASE_CATALOGUE_ID,
  CATALOGUE,
  FIELD_CONTRACT,
  DEFINITIONS,
  metric: (id) => CATALOGUE.metrics[id] || null,
  metricFromText: (value) => CATALOGUE.resolveMetric(value),
};
