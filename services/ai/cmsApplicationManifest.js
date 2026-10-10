"use strict";

/**
 * CMS-wide assistant coverage contract.
 *
 * A route area cannot silently be treated as assistant-ready. It is either:
 *   - catalogued: all reachable data sources have typed field contracts and
 *     authorised deterministic tools;
 *   - partial: safe typed slices exist, but the whole application is not yet
 *     covered and unsupported questions must remain behind the boundary;
 *   - pending: business data that still needs that contract;
 *   - excluded: infrastructure or a deliberately unavailable security surface.
 *
 * This manifest is also the runtime coverage boundary. A pending application's
 * business vocabulary may identify an unavailable data area, but tool names and
 * physical route paths never enter a model prompt.
 */

const { includesTerm } = require("./semanticCatalogue");

const CATALOGUED = "catalogued";
const PARTIAL = "partial";
const PENDING = "pending";
const EXCLUDED = "excluded";

const app = (id, routeRoots, status, details = {}) => Object.freeze({
  ...details,
  id,
  routeRoots: Object.freeze(routeRoots),
  status,
  terms: Object.freeze([...(details.terms || [])]),
  excludedSources: Object.freeze({ ...(details.excludedSources || {}) }),
});

const APPLICATIONS = Object.freeze([
  app("hr", ["routes/HrRoutes", "routes/Employee_Routes"], PARTIAL, { catalogues: ["hr"], toolPrefixes: ["hr_"] }),
  app("accounting", ["routes/Accountant_Routes"], PARTIAL, { catalogues: ["accounting"], toolPrefixes: ["acc_"] }),

  app("board", ["routes/CMS_Routes/Board", "routes/CEO_Routes"], PENDING, { terms: ["board", "ceo dashboard", "leadership dashboard"] }),
  app("configurations", ["routes/CMS_Routes/Configurations"], CATALOGUED, {
    terms: ["configuration", "configurations", "cms settings", "measurement category", "measurement template", "mrf budget setting"],
    excludedSources: {
      "mongo:models/CMS_Models/Inventory/Products/StockItem.js": "Mutation-only dependency used when assigning measurement fields to products; it is not a Configuration read source.",
    },
    catalogues: ["configurations"],
    toolPrefixes: ["config_"],
  }),
  app("costing", ["routes/CMS_Routes/Costing"], PENDING, { terms: ["costing", "cost sheet", "cost estimate"] }),
  app("industrial_engineering", ["routes/CMS_Routes/IndustrialEngineering"], PENDING, { terms: ["industrial engineering", "operation bulletin", "standard allowed minute", "sam"] }),
  app("inventory", ["routes/CMS_Routes/Inventory"], PENDING, { terms: ["inventory", "inventory stock", "stock on hand"], toolPrefixes: ["inventory_"] }),
  app("manufacturing", ["routes/CMS_Routes/Manufacturing"], PENDING, { terms: ["manufacturing", "manufacturing order", "work order"] }),
  app("marketing", ["routes/CMS_Routes/Marketing"], PENDING, { terms: ["marketing", "campaign", "lead source"] }),
  app("measurement", ["routes/CMS_Routes/Measurement"], PENDING, { terms: ["measurement", "measurements", "size chart"] }),
  app("merchandising", ["routes/CMS_Routes/Merchandising"], PENDING, { terms: ["merchandising", "merchandiser", "development file"] }),
  app("order_brief", ["routes/CMS_Routes/OrderBrief"], PENDING, { terms: ["order brief", "buyer brief"] }),
  app("ppc", ["routes/CMS_Routes/PPC"], PENDING, { terms: ["ppc", "production planning", "capacity plan"] }),
  app("production", ["routes/CMS_Routes/Production"], PENDING, { terms: ["production", "production floor", "production output"] }),
  app("requests", ["routes/CMS_Routes/Requests"], PENDING, { terms: ["material request", "mrf", "request desk"] }),
  app("rnd", ["routes/CMS_Routes/RnD"], PENDING, { terms: ["r&d", "rnd", "research and development", "pattern", "sample development"] }),
  app("sales", ["routes/CMS_Routes/Sales"], PENDING, { terms: ["sales order", "sales quotation", "sales pipeline"], toolPrefixes: ["sales_"] }),
  app("store", ["routes/CMS_Routes/Store"], CATALOGUED, {
    terms: ["store", "goods receipt", "stock issue", "put away", "store purchase order", "worker work order"],
    excludedSources: {
      "mongo:models/CMS_Models/Inventory/Products/materialOwnership.js": "Schema helper imported by StockItem; it is not an independent Store collection.",
      "mongo:models/CMS_Models/Inventory/Products/usedAs.js": "Schema helper imported by StockItem; it is not an independent Store collection.",
      "mongo:models/CMS_Models/Manufacturing/WorkOrder/productionExecutionBasis.schema.js": "Embedded WorkOrder schema helper; it is not an independent Store collection.",
      "mongo:models/Customer_Models/customerRequestLineIdentity.js": "CustomerRequest schema helper; it is not an independent Store collection.",
    },
    catalogues: ["store"],
    toolPrefixes: ["store_metric"],
  }),
  app("store_purchase", ["routes/CMS_Routes/StorePurchase"], CATALOGUED, {
    terms: ["purchase order", "purchase orders", "procurement", "supplier sourcing"],
    toolPrefixes: ["store_"],
    catalogues: ["store_purchase", "store_purchase_schema", "inventory_locations"],
    excludedSources: {
      "mongo:models/Access/AccessDepartment.js": "Application-access authority; it gates candidate tools and is never Store business data returned to Qwen.",
      "mongo:models/Access/AccessGrantEvent.js": "Security grant audit history is not a Store business-data surface.",
      "mongo:models/Access/DepartmentRole.js": "Application role authority; it gates access and is never returned as Store business data.",
      "mongo:models/Access/DeptUser.js": "Authentication/authorisation identity source; it is used only to prove the caller.",
      "mongo:models/Accountant_model/Acc_MasterModels.js": "Accounting-owned company/ledger masters imported for server-side validation and tenant joins; Store does not expose the raw accounting aggregate. Authorised accounting reads use the Accounting catalogue.",
      "mongo:models/Accountant_model/Acc_OrgModels.js": "Accounting login, invite and approval authority imported through shared access services; it is not Store business data.",
      "mongo:models/CMS_Models/Inventory/Products/materialOwnership.js": "Embedded RawItem/StockItem schema helper, not an independent collection or conversational entity.",
      "mongo:models/CMS_Models/Inventory/Products/usedAs.js": "Embedded RawItem/StockItem schema helper, not an independent collection or conversational entity.",
      "mongo:models/CMS_Models/Manufacturing/WorkOrder/productionExecutionBasis.schema.js": "Embedded WorkOrder schema helper, not an independent Store collection.",
      "mongo:models/CMS_Models/Sales/enquiryBrandingRequirement.js": "Embedded Enquiry schema helper; any authorised fact must be projected through the owning Enquiry contract.",
      "mongo:models/CMS_Models/Sales/enquiryProductLineIdentity.js": "Embedded Enquiry schema helper; any authorised fact must be projected through the owning Enquiry contract.",
      "mongo:models/CMS_Models/Sales/executionProjection.js": "Embedded Sales projection schema helper; it is not an independent collection.",
      "mongo:models/CMS_Models/Sales/paymentPlanRow.js": "Embedded Sales payment-plan schema helper; it is not an independent collection.",
      "mongo:models/CMS_Models/Sales/companyOwnership.js": "Server-side Sales ownership helper used to prove company scope; it is not an independent collection or conversational field source.",
      "mongo:models/CMS_Models/StorePurchase/SpCompanyMembership.js": "Server-owned tenancy authority; it scopes every Store read and is never offered as conversational business data.",
      "mongo:models/CMS_Models/StorePurchase/SpIdempotencyRecord.js": "Internal mutation replay protection; not a read-side business concept.",
      "mongo:models/Customer_Models/customerRequestLineIdentity.js": "Embedded CustomerRequest schema helper; it is not an independent collection.",
      "mongo:models/Employee.js": "Shared workforce identity imported for actor/access resolution; Store action projections expose recorded actor names without opening the Employee master.",
      "mongo:models/HR_Models/LeaveManagement.js": "HR-owned absence authority imported by shared workforce services; Store reads do not expose raw leave records.",
      "mongo:models/HR_Models/OvertimeReport.js": "HR-owned overtime authority imported by shared workforce services; Store reads do not expose raw overtime records.",
      "mongo:models/Salaryconfig.js": "HR-owned compensation authority imported through shared employee services; Store must never expose it.",
      "firestore:sp_transaction_probe": "Infrastructure transaction-capability probe; it contains no Store business facts.",
      "adapter:firebase-admin": "Infrastructure adapter used by the transaction probe and shared identity services, not a Store business-data source.",
    },
  }),
  app("project_management", ["routes/CMS_Routes/pm"], PENDING, { terms: ["project management", "project milestone", "project status"] }),
  app("customers", ["routes/Customer_Routes"], PENDING, { terms: ["customer master", "buyer master", "customer profile"] }),
  app("vendors", ["routes/Vendor_Routes"], PENDING, { terms: ["vendor master", "supplier master", "vendor profile"] }),
  app("planner", ["routes/Planner"], CATALOGUED, { terms: ["planner", "planning calendar"], catalogues: ["planner"], toolPrefixes: ["planner_"] }),
  app("sop", ["routes/soproutes"], PENDING, { terms: ["sop", "standard operating procedure"] }),
  app("tasks", ["routes/task_routes"], PENDING, { terms: ["task", "tasks", "to do"] }),

  app("access_control", ["routes/Access", "routes/Admin"], EXCLUDED, { reason: "Security administration is not exposed to the conversational read assistant." }),
  app("authentication", ["routes/auth"], EXCLUDED, { reason: "Authentication, tokens and sessions are never assistant data sources." }),
  app("devops", ["routes/DevOps"], EXCLUDED, { reason: "Operational control and deployment surfaces are excluded from the business-data assistant." }),
  app("device_ingress", ["routes/Barcode_Scan_Punchings", "routes/Barcode_Scanner_Device"], EXCLUDED, { reason: "Device mutation/ingress endpoints are excluded; authorised attendance reads use the HR catalogue." }),
  app("assistant_transport", ["routes/ai"], EXCLUDED, { reason: "Assistant transport is infrastructure, not a business-data source." }),
  app("media", ["routes/music"], EXCLUDED, { reason: "Non-CMS media endpoints are outside the business assistant." }),
  app("service_transport", ["routes/services"], EXCLUDED, { reason: "Integration transport endpoints require purpose-built contracts and are not queried directly." }),
]);

function detectApplications(text, { status } = {}) {
  return APPLICATIONS.filter((application) => (
    (!status || application.status === status) &&
    application.terms.some((term) => includesTerm(text, term))
  ));
}

module.exports = { APPLICATIONS, CATALOGUED, PARTIAL, PENDING, EXCLUDED, detectApplications };
