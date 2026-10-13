"use strict";

/**
 * Generated Store & Purchase semantic/field contract.
 *
 * This module deliberately derives the conversational field vocabulary from
 * the persisted Mongoose schemas.  A model upgrade therefore cannot create a
 * silent assistant blind spot: every new path is either exposed here or is
 * rejected by the safety policy with a durable reason.
 */

const Unit = require("../models/CMS_Models/Inventory/Configurations/Unit");
const Warehouse = require("../models/CMS_Models/Inventory/Configurations/Warehouse");
const Machine = require("../models/CMS_Models/Inventory/Configurations/Machine");
const MachineType = require("../models/CMS_Models/Inventory/Configurations/MachineType");
const MeasurementSizeConfig = require("../models/CMS_Models/Inventory/Configurations/MeasurementSizeConfig");
const Operation = require("../models/CMS_Models/Inventory/Configurations/Operation");
const OperationCode = require("../models/CMS_Models/Inventory/Configurations/OperationCode");
const OperationGroup = require("../models/CMS_Models/Inventory/Configurations/OperationGroup");
const Barcode = require("../models/CMS_Models/Inventory/Operations/Barcode");
const LocationBalance = require("../models/CMS_Models/Inventory/Operations/LocationBalance");
const LocationMovement = require("../models/CMS_Models/Inventory/Operations/LocationMovement");
const MRF = require("../models/CMS_Models/Inventory/Operations/MRF");
const PurchaseOrder = require("../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const Requisition = require("../models/CMS_Models/Inventory/Operations/Requisition");
const ServiceOrder = require("../models/CMS_Models/Inventory/Operations/ServiceOrder");
const StockCount = require("../models/CMS_Models/Inventory/Operations/StockCount");
const StockLedger = require("../models/CMS_Models/Inventory/Operations/StockLedger");
const StockReservation = require("../models/CMS_Models/Inventory/Operations/StockReservation");
const StoreSettings = require("../models/CMS_Models/Inventory/Operations/StoreSettings");
const Service = require("../models/CMS_Models/Inventory/Services/Service");
const FreightOffer = require("../models/CMS_Models/Inventory/Sourcing/FreightOffer");
const ServiceSupplierOffer = require("../models/CMS_Models/Inventory/Sourcing/ServiceSupplierOffer");
const SourcingDecision = require("../models/CMS_Models/Inventory/Sourcing/SourcingDecision");
const SupplierOffer = require("../models/CMS_Models/Inventory/Sourcing/SupplierOffer");
const LandedCostAllocation = require("../models/CMS_Models/Inventory/Valuation/LandedCostAllocation");
const RawItem = require("../models/CMS_Models/Inventory/Products/RawItem");
const Vendor = require("../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const ProductionSettings = require("../models/CMS_Models/Manufacturing/ProductionSettings");
const { CustomerMaterialExpectation } = require("../models/CMS_Models/Merchandising/CustomerMaterialExpectation");
const Development = require("../models/CMS_Models/Merchandising/Development");
const ExecutionFile = require("../models/CMS_Models/Merchandising/ExecutionFile");
const MerchandisingEvent = require("../models/CMS_Models/Merchandising/MerchandisingEvent");
const Account = require("../models/CMS_Models/Sales/Account");
const { SalesDevelopmentRequest: DevelopmentRequest } = require("../models/CMS_Models/Sales/DevelopmentRequest");
const Enquiry = require("../models/CMS_Models/Sales/Enquiry");
const SalesHandoverVersion = require("../models/CMS_Models/Sales/SalesHandoverVersion");
const SalesJourney = require("../models/CMS_Models/Sales/SalesJourney");
const SalesSettings = require("../models/CMS_Models/Sales/SalesSettings");
const { CustomerMaterialLot } = require("../models/CMS_Models/StorePurchase/CustomerMaterialLot");
const { CustomerMaterialReturn } = require("../models/CMS_Models/StorePurchase/CustomerMaterialReturn");
const GoodsReceipt = require("../models/CMS_Models/StorePurchase/GoodsReceipt");
const GoodsReceiptDisposition = require("../models/CMS_Models/StorePurchase/GoodsReceiptDisposition");
const GoodsReceiptInspection = require("../models/CMS_Models/StorePurchase/GoodsReceiptInspection");
const GoodsReceiptPutaway = require("../models/CMS_Models/StorePurchase/GoodsReceiptPutaway");
const GoodsReceiptPutawayPosition = require("../models/CMS_Models/StorePurchase/GoodsReceiptPutawayPosition");
const GoodsReceiptSession = require("../models/CMS_Models/StorePurchase/GoodsReceiptSession");
const SpActionHistory = require("../models/CMS_Models/StorePurchase/SpActionHistory");
const SpDocumentSequence = require("../models/CMS_Models/StorePurchase/SpDocumentSequence");
const IntakeRequest = require("../models/CMS_Models/Requests/IntakeRequest");
const SpendRequest = require("../models/CMS_Models/Requests/SpendRequest");
const { compileSemanticCatalogue } = require("./ai/semanticCatalogue");
const { compileFieldCoverageContract, mongooseSchemaPaths } = require("./ai/fieldCoverageContract");
const { vocabularyFor } = require("./ai/storeVocabulary");

const CATALOGUE_ID = "store_purchase_schema";

const pluralizeLabel = (value) => String(value || "").replace(/([^\s]+)$/, (word) => {
  if (/s$/i.test(word)) return word;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(?:ch|sh|x|z)$/i.test(word)) return `${word}es`;
  return `${word}s`;
});

/* The words GRAV people use, kept apart from the catalogue's own names with
   when and why each was added — see services/ai/storeVocabulary.js. */
const spec = (id, label, aliases, model, sourceModel, identityPaths, options = {}) => Object.freeze({
  id, label, aliases: Object.freeze([...new Set([...aliases, ...vocabularyFor(id), pluralizeLabel(label)])]), model, sourceModel,
  identityPaths: Object.freeze(identityPaths),
  singleton: Boolean(options.singleton),
  collectionOnly: Boolean(options.collectionOnly),
  temporal: options.temporal || "current",
});

/**
 * The one workflow concept per family, and the values it records.
 *
 * Published so a caller can tell a word that NAMES the field ("status") from
 * a word that is one of its recorded VALUES ("recorded", "reserved"). Both
 * are aliases of the same concept, and a caller that cannot tell them apart
 * reports the field where it was asked to filter by it.
 */
const WORKFLOW_BY_ENTITY = {};

const ENTITY_SPECS = Object.freeze([
  spec("unit", "unit", ["measurement unit", "inventory unit"], Unit, "models/CMS_Models/Inventory/Configurations/Unit.js", ["name"]),
  spec("warehouse", "warehouse", ["store warehouse", "storage warehouse"], Warehouse, "models/CMS_Models/Inventory/Configurations/Warehouse.js", ["name", "shortName", "address"]),
  spec("machine", "machine", ["store machine", "production machine"], Machine, "models/CMS_Models/Inventory/Configurations/Machine.js", ["name", "machineCode", "serialNumber", "location"]),
  spec("machine_type", "machine type", ["equipment type", "machine category"], MachineType, "models/CMS_Models/Inventory/Configurations/MachineType.js", ["name", "code"]),
  spec("measurement_size_config", "measurement size configuration", ["size configuration", "measurement size"], MeasurementSizeConfig, "models/CMS_Models/Inventory/Configurations/MeasurementSizeConfig.js", ["name", "code"]),
  spec("operation", "operation", ["production operation", "store operation master"], Operation, "models/CMS_Models/Inventory/Configurations/Operation.js", ["name", "operationCode", "code"]),
  spec("operation_code", "operation code", ["production operation code"], OperationCode, "models/CMS_Models/Inventory/Configurations/OperationCode.js", ["name", "code"]),
  spec("operation_group", "operation group", ["production operation group"], OperationGroup, "models/CMS_Models/Inventory/Configurations/OperationGroup.js", ["name", "code"]),
  spec("barcode", "barcode", ["stock label", "material label"], Barcode, "models/CMS_Models/Inventory/Operations/Barcode.js", ["barcodeLabel", "rawItemSku", "rawItemName", "goodsReceiptNumber", "purchaseOrderNumber"]),
  spec("storage_position", "storage position", ["warehouse position", "rack position", "shelf position", "bin position", "location balance"], LocationBalance, "models/CMS_Models/Inventory/Operations/LocationBalance.js", ["warehouseName", "locationCode", "locationName", "rawItemName", "rawItemSku"]),
  spec("location_movement", "location movement", ["stock movement", "material movement"], LocationMovement, "models/CMS_Models/Inventory/Operations/LocationMovement.js", ["barcodeLabel", "warehouseName", "locationCode", "locationName", "source"], { temporal: "event" }),
  spec("material_request", "material request", ["mrf", "material requisition form", "material demand"], MRF, "models/CMS_Models/Inventory/Operations/MRF.js", ["mrfNumber", "requestedForName", "requestedForDept", "purpose", "spendRequestNumber", "intakeRequestNumber"]),
  spec("purchase_order", "purchase order", ["po", "procurement order"], PurchaseOrder, "models/CMS_Models/Inventory/Operations/PurchaseOrder.js", ["poNumber", "sourceMrfNumber", "vendorName", "piInvoiceNumber"]),
  spec("requisition", "store requisition", ["requisition", "purchase requisition"], Requisition, "models/CMS_Models/Inventory/Operations/Requisition.js", ["requisitionNumber", "requestedByName", "department", "sourceMrfNumber"]),
  spec("service_order", "service order", ["service purchase order", "service job order"], ServiceOrder, "models/CMS_Models/Inventory/Operations/ServiceOrder.js", ["serviceOrderNumber", "spendRequestNumber", "vendorName", "title", "requestedByName"]),
  spec("stock_count", "stock count", ["physical count", "inventory count", "cycle count"], StockCount, "models/CMS_Models/Inventory/Operations/StockCount.js", ["countNumber", "warehouseName", "warehouseShortName", "locationCode", "locationName"]),
  spec("stock_ledger", "stock ledger entry", ["inventory ledger", "material ledger", "stock transaction"], StockLedger, "models/CMS_Models/Inventory/Operations/StockLedger.js", ["rawItemName", "rawItemSku", "purchaseOrderNo", "mrfNumber", "vendorName"], { temporal: "event" }),
  spec("stock_reservation", "stock reservation", ["material reservation", "reserved stock", "allocation"], StockReservation, "models/CMS_Models/Inventory/Operations/StockReservation.js", ["mrfNumber", "requestedForName", "itemName", "sku", "variantCombination"]),
  spec("store_settings", "store settings", ["store document settings", "store contact settings"], StoreSettings, "models/CMS_Models/Inventory/Operations/StoreSettings.js", ["key", "storeName"], { singleton: true }),
  spec("service", "service master", ["service", "service catalogue", "service item"], Service, "models/CMS_Models/Inventory/Services/Service.js", ["serviceCode", "name", "category", "preferredVendorName"]),
  spec("freight_offer", "freight offer", ["freight quote", "freight quotation"], FreightOffer, "models/CMS_Models/Inventory/Sourcing/FreightOffer.js", ["supplierName", "originName", "destinationLabel", "quotationReference"]),
  spec("service_supplier_offer", "service supplier offer", ["service offer", "service supplier quote", "service quotation"], ServiceSupplierOffer, "models/CMS_Models/Inventory/Sourcing/ServiceSupplierOffer.js", ["supplierName", "serviceCode", "serviceName", "supplierServiceCode", "supplierServiceName", "quotationReference"]),
  spec("sourcing_decision", "sourcing decision", ["supplier selection", "offer decision", "quote decision"], SourcingDecision, "models/CMS_Models/Inventory/Sourcing/SourcingDecision.js", ["subject.label", "subject.code", "decidedByActorName", "note"]),
  spec("supplier_offer", "supplier offer", ["material offer", "supplier quote", "material quotation"], SupplierOffer, "models/CMS_Models/Inventory/Sourcing/SupplierOffer.js", ["supplierName", "itemName", "itemSku", "supplierItemCode", "supplierItemName", "quotationReference"]),
  spec("landed_cost_allocation", "landed cost allocation", ["landed cost", "freight allocation", "purchase cost allocation"], LandedCostAllocation, "models/CMS_Models/Inventory/Valuation/LandedCostAllocation.js", ["sourceVoucherNumber", "purchaseOrderNumber", "actorName", "reason"], { temporal: "event" }),
  // Exact item/supplier reads use their purpose-built contracts. These schema
  // entries add complete collection/filter/aggregate coverage without creating
  // a second exact-record tool for the same business subject.
  spec("inventory_item_master", "inventory item", ["raw item", "material", "stock item"], RawItem, "models/CMS_Models/Inventory/Products/RawItem.js", ["name", "sku"], { collectionOnly: true }),
  spec("supplier_master", "supplier", ["vendor", "supplier master"], Vendor, "models/CMS_Models/Inventory/Vendor-Buyer/Vendor.js", ["companyName", "supplierCode", "contactPerson", "email", "phone"], { collectionOnly: true }),
  spec("production_settings", "production settings", ["production notification settings"], ProductionSettings, "models/CMS_Models/Manufacturing/ProductionSettings.js", ["key"], { singleton: true }),
  spec("customer_material_expectation", "customer material expectation", ["customer material requirement"], CustomerMaterialExpectation, "models/CMS_Models/Merchandising/CustomerMaterialExpectation.js", ["documentRef", "sourceMrfNumber", "fileNumber", "orderRef", "productName", "styleRef"]),
  spec("development_request_receipt", "development request receipt", ["development receipt"], Development.DevelopmentRequestReceipt, "models/CMS_Models/Merchandising/Development.js", ["requestRef"]),
  spec("development_file", "development file", ["development", "sample development file"], Development.DevelopmentFile, "models/CMS_Models/Merchandising/Development.js", ["developmentNumber", "journeyRef", "productName", "styleRef", "buyerDisplayLabel"]),
  spec("development_bom_revision", "development BOM revision", ["development bill of materials", "bom revision"], Development.DevelopmentBomRevision, "models/CMS_Models/Merchandising/Development.js", ["revisionNo"]),
  spec("execution_file", "execution file", ["merchandising execution file"], ExecutionFile, "models/CMS_Models/Merchandising/ExecutionFile.js", ["fileNumber", "handoverRef", "developmentReference"]),
  spec("merchandising_intake", "merchandising intake", ["handover intake"], MerchandisingEvent.MerchandisingIntakeLedger, "models/CMS_Models/Merchandising/MerchandisingEvent.js", ["sourceEventId", "handoverRef", "handoverLineRef"], { temporal: "event" }),
  spec("merchandising_audit_event", "merchandising audit event", ["merchandising history"], MerchandisingEvent.MerchandisingAuditEvent, "models/CMS_Models/Merchandising/MerchandisingEvent.js", ["fileNumber", "developmentNumber", "action", "recordType"], { temporal: "event" }),
  spec("account", "customer account", ["account", "customer company"], Account, "models/CMS_Models/Sales/Account.js", ["accountId", "companyName", "displayName", "legalName", "brandName", "primaryEmail", "primaryPhone"]),
  spec("sales_development_request", "sales development request", ["sample request", "development request"], DevelopmentRequest, "models/CMS_Models/Sales/DevelopmentRequest.js", ["requestRef", "journeyRef", "buyerDisplayLabel", "productName", "styleRef"]),
  spec("enquiry", "sales enquiry", ["enquiry", "inquiry", "opportunity"], Enquiry, "models/CMS_Models/Sales/Enquiry.js", ["enquiryId", "title", "ownerName"]),
  spec("sales_handover", "sales handover", ["handover version"], SalesHandoverVersion, "models/CMS_Models/Sales/SalesHandoverVersion.js", ["handoverRef", "handoverLineRef"]),
  spec("sales_journey", "sales journey", ["customer journey", "sales pipeline journey"], SalesJourney, "models/CMS_Models/Sales/SalesJourney.js", ["journeyId", "name", "requirementRef", "leadRef", "ownerName", "merchandiserName"]),
  spec("sales_settings", "sales settings", ["sales contact settings"], SalesSettings, "models/CMS_Models/Sales/SalesSettings.js", ["companyName"], { singleton: true }),
  spec("customer_material_lot", "customer material lot", ["customer owned material lot"], CustomerMaterialLot, "models/CMS_Models/StorePurchase/CustomerMaterialLot.js", ["documentRef", "goodsReceiptNumber", "itemName", "sku", "orderRef", "customerLabel"]),
  spec("customer_material_return", "customer material return", ["customer owned material return"], CustomerMaterialReturn, "models/CMS_Models/StorePurchase/CustomerMaterialReturn.js", ["documentRef", "customerReference", "orderRef", "customerLabel"]),
  spec("goods_receipt", "goods receipt", ["grn", "material receipt"], GoodsReceipt, "models/CMS_Models/StorePurchase/GoodsReceipt.js", ["receiptNumber", "poNumber", "invoiceNumber", "supplierName", "customerMaterial.documentRef"]),
  spec("goods_receipt_disposition", "goods receipt disposition", ["inspection disposition", "quarantine disposition"], GoodsReceiptDisposition, "models/CMS_Models/StorePurchase/GoodsReceiptDisposition.js", ["receiptNumber", "itemName", "sku", "fromLocationCode", "toLocationCode"], { temporal: "event" }),
  spec("goods_receipt_inspection", "goods receipt inspection", ["grn inspection", "material inspection"], GoodsReceiptInspection, "models/CMS_Models/StorePurchase/GoodsReceiptInspection.js", ["receiptNumber", "warehouseName", "receivingLocationCode"], { temporal: "event" }),
  spec("goods_receipt_putaway", "goods receipt put-away", ["putaway", "put away"], GoodsReceiptPutaway, "models/CMS_Models/StorePurchase/GoodsReceiptPutaway.js", ["receiptNumber", "itemName", "sku", "fromLocationCode", "toLocationCode", "toLocationName"], { temporal: "event" }),
  spec("goods_receipt_putaway_position", "goods receipt put-away position", ["putaway balance", "receipt line position"], GoodsReceiptPutawayPosition, "models/CMS_Models/StorePurchase/GoodsReceiptPutawayPosition.js", ["unit"]),
  spec("goods_receipt_session", "goods receipt session", ["receiving session"], GoodsReceiptSession, "models/CMS_Models/StorePurchase/GoodsReceiptSession.js", ["goodsReceiptNumber", "poNumber", "customerDocumentRef", "itemName", "sku"]),
  // Only the business document reference identifies a history subject.
  // entityType/action/actorName are queryable fields, but categorical values
  // such as PURCHASE_ORDER must never make a plural aggregate question look
  // like a request for one exact history row.
  spec("store_action_history", "Store action history", ["store audit history", "store history"], SpActionHistory, "models/CMS_Models/StorePurchase/SpActionHistory.js", ["documentNumber"], { temporal: "event" }),
  spec("document_sequence", "document sequence", ["document numbering sequence"], SpDocumentSequence, "models/CMS_Models/StorePurchase/SpDocumentSequence.js", ["documentType", "fiscalYear"]),
  spec("intake_request", "fulfilment request", ["intake request", "request intake", "fulfilment intake"], IntakeRequest, "models/CMS_Models/Requests/IntakeRequest.js", ["requestNumber", "title", "requestedByName", "department", "workOrderNumber", "workerName", "mrfNumber"]),
  spec("spend_request", "purchase or service request", ["spend request", "purchase request", "service request", "classified request"], SpendRequest, "models/CMS_Models/Requests/SpendRequest.js", ["requestNumber", "title", "requestedByName", "department", "vendorName", "purchaseOrderNumber", "serviceOrderNumber"]),
]);

const INTERNAL_PATH = /(^|\.)(_id|__v|companyId|siteId|createdBy|updatedBy|actorId|recordId|entityId|requestId|correlationId|idempotencyKey|operationKey|requestHash|identityUnique|masterIdentityKey|recordVersion|structureVersion)(\.|$)/i;
const SECRET_PATH = /(^|\.)(password|passwordHash|secret|token|otp|hash|signature)(\.|$)/i;
const FILE_PATH = /(^|\.)(url|logo|photo|image|images|referenceImages|evidenceRef|publicId|fileId)(\.|$)/i;
const FINANCIAL_CREDENTIAL_PATH = /(^|\.)(accountNumber|ifscCode|upiId|chequeNumber|paymentAccountNumber|paymentIfscCode|paymentUpiId|paymentChequeNumber)(\.|$)/i;
const RAW_INTERNAL_PATH = /(^|\.)(payload|result|metadata|details)(\.|$)/i;

function humanize(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function metricId(entity, path) {
  return `sp.${entity}.${String(path).replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase()}`;
}

const BUSINESS_ALIASES = Object.freeze({
  "account.primaryEmail": ["email", "email address", "contact email"],
  "purchase_order.paymentStatus": ["paid", "payment settled", "settled payment"],
  "customer_material_lot.availableQuantity": ["amount available", "amount still usable", "remaining usable quantity", "can still be used"],
  "goods_receipt.locationCode": ["store position", "receipt location", "where received", "arrival location"],
});

// Date-basis vocabulary is intentionally separate from general metric aliases.
// A lifecycle word such as "recorded" may also be a valid workflow status; it
// can select a business date without becoming an ambiguous output/filter field.
const BUSINESS_DATE_ALIASES = Object.freeze({
  "goods_receipt.receiptDate": ["recorded date", "date recorded", "recorded on", "recorded"],
});

function schemaTypeFor(model, path) {
  return model.schema.path(path) || null;
}

function unsafeReason(model, path) {
  const schemaType = schemaTypeFor(model, path);
  const instance = schemaType?.instance || "";
  const casterInstance = schemaType?.caster?.instance || "";
  if (INTERNAL_PATH.test(path)) return "Internal identifier, tenancy boundary or mutation-correlation metadata; server-side only.";
  if (SECRET_PATH.test(path)) return "Credential, token, hash or verification secret; never conversational data.";
  if (FILE_PATH.test(path)) return "Attachment/media reference; files require a separately authorised document capability.";
  if (FINANCIAL_CREDENTIAL_PATH.test(path)) return "Restricted payment or bank credential; never conversational data.";
  if (/^bankDetails(?:\.|$)/i.test(path)) return "Restricted supplier bank details; never conversational data.";
  if (RAW_INTERNAL_PATH.test(path)) return "Unbounded internal payload/metadata; only typed business projections may be exposed.";
  if (instance === "ObjectId" || casterInstance === "ObjectId") return "Internal database relationship identifier; expose the recorded business label/reference instead.";
  if (instance === "Mixed" || casterInstance === "Mixed") return "Unbounded mixed-schema content cannot be safely projected into a typed assistant field.";
  return null;
}

function valueType(model, path) {
  const instance = schemaTypeFor(model, path)?.instance;
  if (instance === "Number" || instance === "Decimal128") return "number";
  if (instance === "Boolean") return "boolean";
  if (instance === "Date") return "date_time";
  if (instance === "Array") return "list";
  return "text";
}

const DEFINITIONS = [];
const CONTRACTS = [];
const DEFINITIONS_BY_ENTITY = Object.create(null);

for (const entity of ENTITY_SPECS) {
  const paths = mongooseSchemaPaths(entity.model.schema);
  const leafCounts = new Map();
  const fullLabels = new Map();
  for (const path of paths) {
    const leaf = humanize(path.split(".").pop());
    leafCounts.set(leaf, (leafCounts.get(leaf) || 0) + 1);
    const label = humanize(path);
    fullLabels.set(label, (fullLabels.get(label) || 0) + 1);
  }
  /* ── THE WORKFLOW STATE, WHATEVER THE FIELD IS CALLED ───────────────────
     Most families record it on `status`; several do not. A customer-material
     expectation records `state` (DRAFT / ISSUED / CANCELLED), an execution
     file an `executionPhase`. Reading only `status` meant "draft customer
     material expectations" grounded nothing: the words named a recorded
     value of a closed set and the catalogue did not publish it, so the
     question was either refused or answered with every record.

     One root field per family, chosen by what it IS — a top-level closed set
     of workflow values — with `status` winning when there are several,
     because that is the one people mean. */
  /* ── EVERY WORKFLOW FIELD, NOT THE FIRST ONE ───────────────────────────
     A family can record more than one closed workflow set. A stock-ledger
     entry has both a `status` and an `applicationState`; a development
     request receipt has a `status` and a `state`. Publishing only the first
     meant "pending stock ledger entries" named a value of the OTHER field,
     the catalogue had never heard of it, and the question was refused.

     So every top-level closed set is published — except a value two of them
     share, which names neither field on its own and would make a filter a
     coin toss. Those stay unpublished and the question stays refusable. */
  const WORKFLOW = /^(status|state|phase|stage)$|(?:Status|State|Phase|Stage)$/;
  const workflowPaths = [...new Set(["status", ...paths])].filter((path) => (
    !path.includes(".") && WORKFLOW.test(path)
      && ((entity.model.schema.path(path)?.enumValues || []).length > 1)
  ));
  const seenValue = new Map();
  for (const path of workflowPaths) {
    for (const value of entity.model.schema.path(path)?.enumValues || []) {
      if (!value) continue;
      const key = humanize(value);
      seenValue.set(key, (seenValue.get(key) || 0) + 1);
    }
  }
  const ownValues = (path) => (entity.model.schema.path(path)?.enumValues || [])
    .filter((value) => value && seenValue.get(humanize(value)) === 1);
  const valuesByPath = new Map(workflowPaths.map((path) => [path, ownValues(path)]));
  /* Every workflow value of the family, for suppressing a short leaf alias
     that would collide with one. */
  const statusValues = new Set(workflowPaths
    .flatMap((path) => entity.model.schema.path(path)?.enumValues || [])
    .filter(Boolean).map(humanize));

  WORKFLOW_BY_ENTITY[entity.id] = workflowPaths.length
    ? {
      /* The primary one, for callers that want a single answer. */
      path: workflowPaths[0],
      values: (valuesByPath.get(workflowPaths[0]) || []).map(humanize),
      /* And exactly as recorded, because a filter compares against what is
         stored: "partially issued" matches nothing in a column holding
         `PARTIALLY_ISSUED`. */
      recorded: valuesByPath.get(workflowPaths[0]) || [],
      /* Every workflow field, each with the values that name only it. */
      fields: workflowPaths.map((path) => ({
        path, recorded: valuesByPath.get(path) || [],
      })).filter((field) => field.recorded.length),
    }
    : null;
  const exposed = [];
  const excluded = {};
  const entityDefinitions = [];
  for (const path of paths) {
    const reason = unsafeReason(entity.model, path);
    if (reason) {
      excluded[path] = reason;
      continue;
    }
    const ordinaryPathLabel = humanize(path);
    // Mongoose occasionally exposes both an embedded path and a flattened
    // compatibility path whose humanised names are identical. Preserve both
    // fields, but keep their semantic labels unambiguous without model-specific
    // aliases.
    const pathLabel = (fullLabels.get(ordinaryPathLabel) || 0) > 1 && path.includes(".")
      ? humanize(path.replace(/\./g, " nested "))
      : ordinaryPathLabel;
    const leaf = humanize(path.split(".").pop());
    const aliases = [pathLabel, ...(BUSINESS_ALIASES[`${entity.id}.${path}`] || [])];
    // Root workflow states are a closed vocabulary already declared by the
    // model. Make those stored enum values semantic aliases of the root status
    // concept, so “partially received” resolves to status without a manually
    // maintained phrase list. Nested line statuses remain path-qualified.
    if (valuesByPath.has(path)) {
      for (const value of valuesByPath.get(path)) aliases.push(humanize(value));
    }
    // A short leaf alias is offered only when it cannot collide with another
    // full path or a root workflow-status enum. The generator therefore stays
    // schema-driven without making words such as "approved" ambiguous between
    // status and a nested budget snapshot.
    if (leaf && leafCounts.get(leaf) === 1
        && (fullLabels.get(leaf) || 0) <= (pathLabel === leaf ? 1 : 0)
        && (valuesByPath.has(path) || !statusValues.has(leaf))) aliases.push(leaf);
    const definition = Object.freeze({
      id: metricId(entity.id, path),
      label: `${entity.label} ${pathLabel}`,
      aliases: Object.freeze([...new Set(aliases)]),
      dateAliases: Object.freeze(valueType(entity.model, path) === "date_time"
        ? [...new Set(BUSINESS_DATE_ALIASES[`${entity.id}.${path}`] || [])]
        : []),
      path,
      valueType: valueType(entity.model, path),
      temporal: entity.temporal,
      source: entity.id,
      domain: entity.id,
      entity: entity.id,
    });
    DEFINITIONS.push(definition);
    entityDefinitions.push(definition);
    exposed.push({ id: definition.id, label: definition.label, valueType: definition.valueType, path });
  }
  DEFINITIONS_BY_ENTITY[entity.id] = Object.freeze(entityDefinitions);
  CONTRACTS.push(compileFieldCoverageContract({
    id: `store_purchase.schema.${entity.id}`,
    sourceModels: [entity.sourceModel],
    schemaPaths: paths,
    exposed,
    excluded,
  }));
}

const CATALOGUE = compileSemanticCatalogue({
  id: CATALOGUE_ID,
  domains: ENTITY_SPECS.map((entity) => ({ id: entity.id, label: entity.label, aliases: entity.aliases })),
  entities: ENTITY_SPECS.map((entity) => ({ id: entity.id, label: entity.label, aliases: entity.aliases })),
  metrics: DEFINITIONS,
});

module.exports = {
  WORKFLOW_BY_ENTITY,
  CATALOGUE_ID,
  CATALOGUE,
  CONTRACTS: Object.freeze(CONTRACTS),
  DEFINITIONS: Object.freeze(DEFINITIONS),
  DEFINITIONS_BY_ENTITY: Object.freeze(DEFINITIONS_BY_ENTITY),
  ENTITY_SPECS,
  humanize,
  metric: (id) => CATALOGUE.metrics[id] || null,
};
