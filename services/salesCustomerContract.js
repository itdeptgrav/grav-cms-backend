"use strict";

const Customer = require("../models/Customer_Models/Customer");
const { compileSemanticCatalogue } = require("./ai/semanticCatalogue");
const { compileFieldCoverageContract, mongooseSchemaPaths } = require("./ai/fieldCoverageContract");

const SALES_CATALOGUE_ID = "sales";
const CURRENT = "current";

const DEFINITIONS = Object.freeze([
  ["customer.name", "Customer name", ["customer full name", "customer name", "buyer name", "full name", "name"], "name", "text"],
  ["customer.id", "Customer ID", ["customer id", "customer code", "buyer id"], "customerId", "text"],
  ["customer.company_name", "Customer company name", ["customer company", "buyer company", "company name"], "profile.companyName", "text"],
  ["customer.email", "Customer email", ["customer email", "buyer email", "email"], "email", "text"],
  ["customer.phone", "Customer phone", ["customer phone", "buyer phone", "customer mobile", "phone", "mobile"], "phone", "text"],
  ["customer.alternate_phone", "Customer alternate phone", ["customer alternate phone", "buyer alternate phone"], "alternatePhone", "text"],
  ["customer.gstin", "Customer GSTIN", ["customer gst", "customer gstin", "buyer gst"], "gstNumber", "text"],
  ["customer.active_status", "Customer active status", ["customer status", "is customer active"], "isActive", "boolean"],
  ["customer.email_verification", "Customer email verification", ["customer email verified", "customer email verification"], "isEmailVerified", "boolean"],
  ["customer.phone_verification", "Customer phone verification", ["customer phone verified", "customer phone verification"], "isPhoneVerified", "boolean"],
  ["customer.last_login", "Customer last login", ["customer last login"], "lastLogin", "date_time"],
  ["customer.lead_source", "Customer lead source", ["customer lead source", "customer source"], "leadSource", "text"],
  ["customer.street", "Customer street", ["customer street", "customer address"], "profile.address.street", "text"],
  ["customer.city", "Customer city", ["customer city"], "profile.address.city", "text"],
  ["customer.state", "Customer state", ["customer state"], "profile.address.state", "text"],
  ["customer.country", "Customer country", ["customer country"], "profile.address.country", "text"],
  ["customer.pincode", "Customer pincode", ["customer pincode", "customer postal code"], "profile.address.pincode", "text"],
  ["customer.landmark", "Customer landmark", ["customer landmark"], "profile.address.landmark", "text"],
  ["customer.business_type", "Customer business type", ["customer business type"], "businessInfo.businessType", "text"],
  ["customer.industry", "Customer industry", ["customer industry", "customer industry type"], "businessInfo.industryType", "text"],
  ["customer.website", "Customer website", ["customer website"], "businessInfo.website", "text"],
  ["customer.year_established", "Customer year established", ["customer established year", "customer year established"], "businessInfo.yearEstablished", "number"],
  ["customer.employee_count", "Customer employee count", ["customer employee count", "customer company size"], "businessInfo.employeeCount", "text"],
  ["customer.payment_terms", "Customer payment terms", ["customer payment terms", "buyer payment terms"], ["paymentTerms.schedule", "paymentTerms.notes"], "payment_terms"],
  ["customer.assigned_products", "Customer assigned products", ["customer products", "assigned products", "products assigned to customer"], "assignedStockItems", "assigned_products"],
  ["customer.sales_assignee", "Customer sales assignee", ["customer sales person", "customer assigned sales person", "sales assigned by"], "salesAssignedByName", "text"],
  ["customer.created_by_sales", "Customer creation source", ["created by sales", "customer created by sales"], "createdBySales", "boolean"],
  ["customer.created_at", "Customer created at", ["customer created date", "customer created at"], "createdAt", "date_time"],
  ["customer.updated_at", "Customer updated at", ["customer updated date", "customer last updated"], "updatedAt", "date_time"],
].map(([id, label, aliases, path, valueType]) => Object.freeze({
  id, label, aliases: Object.freeze(aliases), path, valueType,
  temporal: CURRENT,
  source: "sales_customer_master",
  domain: "customer_master",
  entity: "customer",
})));

const exposedPaths = [...new Set(DEFINITIONS.flatMap((definition) => (
  Array.isArray(definition.path) ? definition.path : [definition.path]
)).flatMap((path) => path === "assignedStockItems"
  ? [
    "assignedStockItems.assignedAt", "assignedStockItems.assignedByName", "assignedStockItems.notes",
    "assignedStockItems.stockItemName", "assignedStockItems.stockItemReference",
  ]
  : path === "paymentTerms.schedule"
    ? ["paymentTerms.schedule.name", "paymentTerms.schedule.percentage"]
    : [path]))];

const EXCLUDED = Object.freeze({
  _id: "Internal database identifier; the business identifier is customerId.",
  __v: "Database concurrency metadata.",
  "assignedStockItems._id": "Internal embedded-row identifier.",
  "assignedStockItems.assignedBy": "Internal actor identifier; the recorded actor name is exposed.",
  "assignedStockItems.stockItemId": "Internal product identifier; product name and reference are exposed.",
  "bankDetails.accountHolderName": "Restricted financial account data is not exposed by the conversational read assistant.",
  "bankDetails.accountNumber": "Restricted financial account data is not exposed by the conversational read assistant.",
  "bankDetails.bankName": "Restricted financial account data is not exposed by the conversational read assistant.",
  "bankDetails.branchName": "Restricted financial account data is not exposed by the conversational read assistant.",
  "bankDetails.ifscCode": "Restricted financial account data is not exposed by the conversational read assistant.",
  "bankDetails.upiId": "Restricted financial account data is not exposed by the conversational read assistant.",
  "cart._id": "Customer-portal commerce state belongs to a separate pending capability.",
  "cart.customization": "Customer-portal commerce state belongs to a separate pending capability.",
  "cart.customization.$*": "Customer-portal commerce state belongs to a separate pending capability.",
  "cart.product": "Customer-portal commerce state belongs to a separate pending capability.",
  "cart.quantity": "Customer-portal commerce state belongs to a separate pending capability.",
  favorites: "Customer-portal preference state belongs to a separate pending capability.",
  orders: "Order relationships belong to the Sales order catalogue, not the customer scalar contract.",
  password: "Authentication secret.",
  "passwordResetOTP.attempts": "Authentication recovery state.",
  "passwordResetOTP.expiresAt": "Authentication recovery state.",
  "passwordResetOTP.hash": "Authentication secret.",
  "profile.avatar": "Media is excluded from the business-data assistant.",
  "profile.gstNumber": "Legacy duplicate; gstNumber is the authoritative exposed field.",
  "profile.measurements.chest": "Personal measurements belong to the separately governed Measurement application.",
  "profile.measurements.height": "Personal measurements belong to the separately governed Measurement application.",
  "profile.measurements.hips": "Personal measurements belong to the separately governed Measurement application.",
  "profile.measurements.shoulder": "Personal measurements belong to the separately governed Measurement application.",
  "profile.measurements.sleeve": "Personal measurements belong to the separately governed Measurement application.",
  "profile.measurements.waist": "Personal measurements belong to the separately governed Measurement application.",
  "profile.preferences.emailNotifications": "Customer-portal notification preference; not internal Sales master data.",
  "profile.preferences.exclusiveAccess": "Customer-portal notification preference; not internal Sales master data.",
  "profile.preferences.whatsappNotifications": "Customer-portal notification preference; not internal Sales master data.",
  salesAssignedBy: "Internal actor identifier; the recorded actor name is exposed.",
});

const fields = exposedPaths.map((path) => {
  const owner = DEFINITIONS.find((definition) => {
    const conceptPaths = Array.isArray(definition.path) ? definition.path : [definition.path];
    return conceptPaths.some((conceptPath) => (
      path === conceptPath || path.startsWith(`${conceptPath}.`)
    ));
  });
  return {
    id: owner?.id || `source.${path}`,
    label: owner?.label || path,
    valueType: owner?.valueType || "source_field",
    path,
  };
});
const FIELD_CONTRACT = compileFieldCoverageContract({
  id: "sales.customer_master",
  sourceModels: ["models/Customer_Models/Customer.js"],
  schemaPaths: mongooseSchemaPaths(Customer.schema),
  exposed: fields,
  excluded: EXCLUDED,
});

const CATALOGUE = compileSemanticCatalogue({
  id: SALES_CATALOGUE_ID,
  domains: [{
    id: "customer_master",
    label: "customer master",
    aliases: ["customer profile", "buyer profile", "customer details", "buyer details"],
  }],
  entities: [{ id: "customer", label: "customer", aliases: ["buyer", "client"] }],
  metrics: DEFINITIONS,
});

const metric = (id) => CATALOGUE.metrics[id] || null;
const metricFromText = (value) => CATALOGUE.resolveMetric(value);

module.exports = {
  SALES_CATALOGUE_ID,
  CATALOGUE,
  FIELD_CONTRACT,
  DEFINITIONS,
  EXCLUDED,
  metric,
  metricFromText,
};
