// constants/crm.js
//
// Central, code-first vocabulary for the CRM customer-account foundation
// (Step 01). The spec is explicit that transactional records must store stable
// CODES, not display text, and that labels live in ONE place — so every enum
// below is defined here as {code,label} and the Mongoose schemas take their
// `enum` from the `*_CODES` arrays exported at the bottom. The frontend reads
// the same values through GET /api/cms/crm/lookups (seeded from this file), so
// there is a single source of truth for both stores.
//
// Adding a value: add it here, run `node scripts/seedCrmLookups.js`. Never
// hard-code a display string in a route or a schema.

"use strict";

const pair = (code, label, meta = {}) => ({ code, label, ...meta });

// ── Account business roles (many-to-many; an account can hold several) ───────
const ACCOUNT_ROLES = [
  pair("uniform_client", "Uniform Client"),
  pair("direct_brand", "Direct Brand"),
  pair("buying_house", "Buying House"),
  pair("retailer", "Retailer"),
  pair("importer", "Importer"),
  pair("distributor", "Distributor"),
  pair("government_institution", "Government / Institution"),
  pair("school_education", "School / Education"),
  pair("hotel_hospitality", "Hotel / Hospitality"),
  pair("hospital_healthcare", "Hospital / Healthcare"),
  pair("industrial_corporate", "Industrial / Corporate"),
  pair("agent", "Agent"),
  pair("factory", "Factory"),
  pair("fabric_mill", "Fabric Mill"),
  pair("trim_supplier", "Trim Supplier"),
  pair("testing_laboratory", "Testing Laboratory"),
  pair("inspection_agency", "Inspection Agency"),
  pair("freight_forwarder", "Freight Forwarder"),
  pair("other_partner", "Other Partner"),
];

// ── Account status ───────────────────────────────────────────────────────────
// The existing CRMAccount shipped with active/inactive/blocked and live rows
// use them, so the spec's states are ADDED to a superset rather than replacing
// — nothing already written becomes invalid.
const ACCOUNT_STATUSES = [
  pair("prospect", "Prospect"),
  pair("active", "Active"),
  pair("on_hold", "On Hold"),
  pair("dormant", "Dormant"),
  pair("archived", "Archived"),
  pair("inactive", "Inactive"), // legacy
  pair("blocked", "Blocked"), // legacy
];

const LIFECYCLE_STAGES = [
  pair("target", "Target"),
  pair("prospect", "Prospect"),
  pair("development", "Development"),
  pair("customer", "Customer"),
  pair("former_customer", "Former Customer"),
  pair("partner", "Partner"),
];

const CUSTOMER_TIERS = [
  pair("strategic", "Strategic"),
  pair("key", "Key"),
  pair("standard", "Standard"),
  pair("trial", "Trial"),
];

const CREDIT_STATUSES = [
  pair("not_checked", "Not Checked"),
  pair("approved", "Approved"),
  pair("review_required", "Review Required"),
  pair("on_hold", "On Hold"),
];

// Customer type — the KIND of buyer this account is, in sales terms. Distinct
// from `industry` (a coarser sector) and `roles` (customer/buying-house/brand):
// this is the one-line "who are they" a salesperson thinks in.
const CUSTOMER_TYPES = [
  pair("hotel", "Hotel"),
  pair("corporate", "Corporate"),
  pair("school", "School"),
  pair("hospital", "Hospital"),
  pair("retail_brand", "Retail Brand"),
  pair("distributor", "Distributor"),
  pair("government", "Government"),
  pair("export_buyer", "Export Buyer"),
  pair("other", "Other"),
];

// GST treatment — how this customer is registered for tax, which drives how a
// quotation/invoice is raised.
const GST_TREATMENTS = [
  pair("registered", "Registered"),
  pair("composition", "Composition"),
  pair("unregistered", "Unregistered"),
  pair("sez", "SEZ"),
  pair("export", "Export / LUT"),
  pair("exempt", "Exempt"),
];

// Freight arrangement — who bears and books the freight on despatch.
const FREIGHT_ARRANGEMENTS = [
  pair("prepaid", "Prepaid (we pay)"),
  pair("to_pay", "To-pay (customer pays)"),
  pair("ex_works", "Ex-works (customer collects)"),
  pair("delivered", "Delivered (included in price)"),
];

// ── Enquiry / RFQ ────────────────────────────────────────────────────────────
// The opportunity lifecycle WITHIN a Sales Journey's Enquiry stage. New →
// Contacted → Requirement Gathering → Qualified → Development Started is the
// forward funnel; on_hold / lost / cancelled are the off-ramps. `lost` requires
// a reason (see ENQUIRY_LOST_REASONS).
// LABELS DESCRIBE THE ENQUIRY, NOT THE BUYER.
//
// These read "New → Contacted → Requirement Gathering → Qualified", which is
// the Lead's own qualification ladder said a second time: whether the buyer is
// real is settled before a journey exists (Lead.qualificationState), and the
// unified Opportunities stage bar now shows both, so the same three words
// appeared twice on one screen. An enquiry is a DOCUMENT — it is drafted, its
// requirement gets gathered, and it becomes complete.
//
// CODES ARE UNCHANGED ON PURPOSE. Six enquiries hold these values; renaming
// the codes would orphan every one of them for a wording problem. Only the
// labels move, and `contacted` keeps a sensible label for the one record still
// on it even though nothing advances into it any more.
const ENQUIRY_STATUSES = [
  pair("new", "Draft"),
  pair("contacted", "Details taken"),
  pair("requirement_gathering", "Gathering requirement"),
  pair("qualified", "Requirement complete"),
  pair("development_started", "Development Started"),
  pair("on_hold", "On Hold"),
  pair("lost", "Lost"),
  pair("cancelled", "Cancelled"),
];

// The allowed status moves. New → Contacted → Requirement Gathering →
// Qualified → Development Started is the forward funnel; on_hold / lost /
// cancelled are reachable off-ramps, and a parked/closed enquiry can be
// reopened back into the funnel. `development_started` is only reachable from
// `qualified` — you don't start development on an unqualified opportunity.
const ENQUIRY_STATUS_TRANSITIONS = {
  new: ["contacted", "requirement_gathering", "qualified", "on_hold", "lost", "cancelled"],
  contacted: ["requirement_gathering", "qualified", "on_hold", "lost", "cancelled"],
  requirement_gathering: ["qualified", "contacted", "on_hold", "lost", "cancelled"],
  qualified: ["development_started", "requirement_gathering", "on_hold", "lost", "cancelled"],
  development_started: ["on_hold", "cancelled"],
  on_hold: ["contacted", "requirement_gathering", "qualified", "lost", "cancelled"],
  lost: ["contacted", "requirement_gathering", "qualified"],
  cancelled: ["contacted", "requirement_gathering", "qualified"],
};

// How the enquiry came in — distinct from a Lead's source (how a prospect was
// found). An enquiry usually arrives from an existing relationship.
const ENQUIRY_SOURCES = [
  pair("repeat_customer", "Repeat Customer"),
  pair("referral", "Referral"),
  pair("tender_portal", "Tender / Portal"),
  pair("direct_rfq", "Direct RFQ"),
  pair("sales_outreach", "Sales Outreach"),
  pair("exhibition", "Exhibition"),
  pair("website", "Website"),
  pair("existing_lead", "Converted Lead"),
  pair("other", "Other"),
];

// Who a garment is cut for — used per enquiry product line.
const GARMENT_GENDERS = [
  pair("male", "Male"),
  pair("female", "Female"),
  pair("unisex", "Unisex"),
];

// What a reference attached to an enquiry IS — so the brief's supporting
// material is categorised, not a pile of untyped links. Binary file upload is
// deferred until the platform file service is wired to the CRM; until then a
// reference is a LINK (Pinterest, drive, etc.) or a NOTE about a physical
// sample, tagged by type.
const ENQUIRY_REFERENCE_TYPES = [
  pair("customer_photo", "Customer photo"),
  pair("reference_image", "Reference image"),
  pair("existing_garment", "Existing garment"),
  pair("tech_pack", "Tech pack"),
  pair("logo", "Logo"),
  pair("branding_manual", "Branding manual"),
  pair("sketch", "Sketch"),
  pair("quantity_sheet", "Quantity sheet"),
  pair("document", "Document / PDF"),
  pair("other", "Other"),
];

// How hard to push an enquiry — the salesperson's own ranking.
const ENQUIRY_PRIORITIES = [
  pair("urgent", "Urgent"),
  pair("high", "High"),
  pair("medium", "Medium"),
  pair("low", "Low"),
];

// How serious the customer seems about actually buying — the classic Hot / Warm
// / Cold read, used for qualification.
const CUSTOMER_SERIOUSNESS = [
  pair("hot", "Hot"),
  pair("warm", "Warm"),
  pair("cold", "Cold"),
];

// Why an enquiry was lost — required when status becomes `lost`. This data is
// the point of recording losses, so the reasons are a fixed, analysable set.
const ENQUIRY_LOST_REASONS = [
  pair("price_too_high", "Price too high"),
  pair("competitor_selected", "Competitor selected"),
  pair("delivery_impossible", "Delivery impossible"),
  pair("customer_cancelled", "Customer cancelled requirement"),
  pair("no_response", "No response"),
  pair("not_feasible", "Product not feasible"),
  pair("moq_issue", "MOQ issue"),
  pair("credit_issue", "Credit / payment issue"),
  pair("other", "Other"),
];

// ── Sites / addresses / departments ──────────────────────────────────────────
const SITE_TYPES = [
  pair("head_office", "Head Office"),
  pair("branch", "Branch"),
  pair("campus_school", "Campus / School"),
  pair("hotel", "Hotel"),
  pair("hospital", "Hospital"),
  pair("factory_plant", "Factory / Plant"),
  pair("project_site", "Project Site"),
  pair("warehouse", "Warehouse"),
  pair("store", "Store"),
  pair("billing_office", "Billing Office"),
  pair("other", "Other"),
];

const ADDRESS_TYPES = [
  pair("registered", "Registered"),
  pair("office", "Office"),
  pair("billing", "Billing"),
  pair("shipping", "Shipping"),
  pair("sampling", "Sampling"),
  pair("inspection", "Inspection"),
  pair("other", "Other"),
];

// ── Contact roles / preferences / consent ────────────────────────────────────
const CONTACT_ROLES = [
  pair("decision_maker", "Decision Maker"),
  pair("procurement", "Procurement"),
  pair("buyer", "Buyer"),
  pair("merchandiser", "Merchandiser"),
  pair("designer", "Designer"),
  pair("technical_quality", "Technical / Quality"),
  pair("approver", "Approver"),
  pair("contract_owner", "Contract Owner"),
  pair("hr_admin", "HR / Admin"),
  pair("uniform_coordinator", "Uniform Coordinator"),
  pair("wearer_coordinator", "Wearer Coordinator"),
  pair("site_coordinator", "Site Coordinator"),
  pair("accounts_payable", "Accounts Payable"),
  pair("logistics", "Logistics"),
  pair("compliance", "Compliance"),
  pair("management", "Management"),
  // Operational decision-makers common in hotels / hospitals / schools — named
  // explicitly so a salesperson can tag the exact person, not a generic bucket.
  pair("general_manager", "General Manager"),
  pair("owner_director", "Owner / Director"),
  pair("uniform_manager", "Uniform Manager"),
  pair("housekeeping_head", "Housekeeping Head"),
  pair("chef", "Chef / F&B"),
  pair("engineering_head", "Engineering Head"),
  pair("other", "Other"),
];

const CONTACT_STATUSES = [
  pair("active", "Active"),
  pair("left_organization", "Left Organization"),
  pair("do_not_contact", "Do Not Contact"),
  pair("archived", "Archived"),
  pair("inactive", "Inactive"), // legacy
  pair("blocked", "Blocked"), // legacy
];

const PREFERRED_CHANNELS = [
  pair("email", "Email"),
  pair("phone", "Phone"),
  pair("messaging", "Messaging"),
  pair("portal", "Portal"),
  pair("none", "None"),
];

const CONSENT_STATUSES = [
  pair("unknown", "Unknown"),
  pair("granted", "Granted"),
  pair("withdrawn", "Withdrawn"),
  pair("not_required", "Not Required"),
];

// ── Internal account team ────────────────────────────────────────────────────
const TEAM_ROLES = [
  pair("sales_owner", "Sales Owner"),
  pair("account_manager", "Account Manager"),
  pair("merchandiser", "Merchandiser"),
  pair("uniform_program_coordinator", "Uniform Program Coordinator"),
  pair("service_owner", "Service Owner"),
  pair("finance_owner", "Finance Owner"),
  pair("executive_sponsor", "Executive Sponsor"),
];

// ── Activities ───────────────────────────────────────────────────────────────
const ACTIVITY_TYPES = [
  pair("note", "Note"),
  pair("call", "Call"),
  pair("email_log", "Email Log"),
  pair("message", "Message"),
  pair("meeting", "Meeting"),
  pair("task", "Task"),
  pair("site_visit", "Site Visit"),
  pair("follow_up", "Follow-up"),
  pair("other", "Other"),
];

// The medium a "message" interaction went out on. Deliberately narrow — the CRM
// only LOGS that a message happened (see routes/CMS_Routes/Sales/leads.js); it
// never sends one, so this is a record of channel, not an integration.
const ACTIVITY_CHANNELS = [
  pair("whatsapp", "WhatsApp"),
  pair("sms", "SMS"),
  pair("other", "Other"),
];

// Which way an interaction went. Applies to call / email / message / meeting.
const ACTIVITY_DIRECTIONS = [
  pair("outbound", "Outbound"),
  pair("inbound", "Inbound"),
];

// Stored statuses. "Overdue" is DERIVED (planned + past due date), never stored,
// per the spec — a stored overdue flag drifts the moment the clock passes it.
const ACTIVITY_STATUSES = [
  pair("planned", "Planned"),
  pair("completed", "Completed"),
  pair("cancelled", "Cancelled"),
];

const ACTIVITY_PRIORITIES = [
  pair("low", "Low"),
  pair("normal", "Normal"),
  pair("high", "High"),
  pair("urgent", "Urgent"),
];

const ACTIVITY_VISIBILITIES = [
  pair("internal", "Internal"),
  pair("restricted", "Restricted"),
  pair("customer_visible_future", "Customer Visible (Future)"),
];

// The activity types that are logged as already-done by default (a note or a
// past call), vs. the forward-looking ones that default to planned.
const ACTIVITY_TASK_TYPES = new Set(["task", "follow_up"]);

// Structured interaction outcomes (Lead correction chunk) — replaces free-text
// `outcome` so "was this contact actually successful" is a real, checkable
// fact rather than whatever string a salesperson happened to type. Existing
// pre-chunk free-text values are untouched (no migration; Mongoose enum
// validation only runs on write, never on read).
const ACTIVITY_OUTCOMES = [
  pair("no_answer", "No Answer"),
  pair("replied_connected", "Replied / Connected"),
  pair("meeting_completed", "Meeting Completed"),
  pair("other", "Other"),
];
// The subset that counts as a genuine, successful TWO-WAY contact — the bar
// for a Lead's `qualificationState` to move to "contacted" and for
// `lastContactedAt` to update. A logged "No Answer" is a real outreach
// attempt (enough for "contactAttempted") but not a successful contact.
const SUCCESSFUL_CONTACT_OUTCOMES = new Set(["replied_connected", "meeting_completed"]);
// Activity types that count as a genuine outreach ATTEMPT (enough to reach
// "contactAttempted") regardless of outcome — a completed call/email/meeting/
// site visit was actually made, whether or not it succeeded. Notes, tasks and
// "other" don't count: they aren't an attempt to reach the prospect.
const OUTREACH_ATTEMPT_ACTIVITY_TYPES = ["call", "email_log", "message", "meeting", "site_visit"];

// Requirement certainty (Lead correction chunk) — how firmly the CONFIRMED
// current requirement (not the researched annual commercial potential, which
// has its own confidence enum on the Lead model) is actually known. Kept
// separate on purpose: "Commercial potential" answers "what might they buy
// overall, researched"; this answers "how sure are we about what they're
// asking for right now".
const REQUIREMENT_CERTAINTIES = [
  pair("unknown", "Unknown"),
  pair("suspected", "Suspected"),
  pair("prospect_confirmed", "Prospect Confirmed"),
  pair("document_confirmed", "Document Confirmed"),
];
// The tier at which a requirement counts as genuinely confirmed for
// qualification purposes — mirrors RESEARCHED_OR_HIGHER's role on the
// commercial-potential side (lib/leadCapture.js), but for this separate axis.
const REQUIREMENT_CERTAINTY_CONFIRMED = new Set(["prospect_confirmed", "document_confirmed"]);

// ── Account relationships (typed, directional, with inverse labels) ──────────
// relationshipType is always stored as the FORWARD code on a row that also
// carries fromAccountId/toAccountId. The inverse label is rendered from the
// other account's perspective — see relationshipLabelFrom().
const RELATIONSHIP_TYPES = [
  { code: "parent_of", label: "Parent Of", inverse: "subsidiary_of", inverseLabel: "Subsidiary Of" },
  { code: "buying_house_for", label: "Buying House For", inverse: "represented_by_buying_house", inverseLabel: "Represented By Buying House" },
  { code: "buys_for", label: "Buys For", inverse: "sourced_through", inverseLabel: "Sourced Through" },
  { code: "brand_owner_of", label: "Brand Owner Of", inverse: "owned_by", inverseLabel: "Owned By" },
  { code: "billing_party_for", label: "Billing Party For", inverse: "billed_through", inverseLabel: "Billed Through" },
  { code: "importer_for", label: "Importer For", inverse: "imported_by", inverseLabel: "Imported By" },
  { code: "agent_for", label: "Agent For", inverse: "represented_by_agent", inverseLabel: "Represented By Agent" },
  { code: "supplier_to", label: "Supplier To", inverse: "buys_from", inverseLabel: "Buys From" },
  { code: "inspector_for", label: "Inspector For", inverse: "inspected_by", inverseLabel: "Inspected By" },
  { code: "freight_forwarder_for", label: "Freight Forwarder For", inverse: "forwarded_by", inverseLabel: "Forwarded By" },
  { code: "related_company", label: "Related Company", inverse: "related_company", inverseLabel: "Related Company" },
];

// ── Garment Sales Profile (§7.2A) — business/product profile ────────────────
const BUSINESS_MODELS = [
  pair("uniforms", "Uniforms"),
  pair("export_brand", "Export Brand"),
  pair("domestic_brand", "Domestic Brand"),
  pair("buying_house", "Buying House"),
  pair("private_label", "Private Label"),
  pair("full_package_fob", "Full Package / FOB"),
  pair("cmt_cm", "CMT / CM"),
];

const PRODUCT_CATEGORIES = [
  pair("shirts", "Shirts"),
  pair("trousers", "Trousers"),
  pair("jackets", "Jackets"),
  pair("knitwear", "Knitwear"),
  pair("denim", "Denim"),
  pair("workwear", "Workwear"),
  pair("schoolwear", "Schoolwear"),
  pair("healthcare_uniforms", "Healthcare Uniforms"),
  pair("hospitality_uniforms", "Hospitality Uniforms"),
  pair("ppe", "PPE"),
];

const CONSTRUCTION_TYPES = [
  pair("woven", "Woven"),
  pair("knit", "Knit"),
  pair("denim", "Denim"),
  pair("sweater", "Sweater"),
  pair("outerwear", "Outerwear"),
];

const WEARER_CONSUMER_CATEGORIES = [
  pair("menswear", "Menswear"),
  pair("womenswear", "Womenswear"),
  pair("kidswear", "Kidswear"),
  pair("unisex", "Unisex"),
  pair("occupational", "Occupational"),
];

const ORDER_FREQUENCIES = [
  pair("seasonal", "Seasonal"),
  pair("monthly", "Monthly"),
  pair("quarterly", "Quarterly"),
  pair("annual", "Annual"),
  pair("call_off", "Call-off"),
  pair("ad_hoc", "Ad hoc"),
];

const CUSTOMER_POTENTIALS = [
  pair("strategic", "Strategic"),
  pair("high", "High"),
  pair("medium", "Medium"),
  pair("low", "Low"),
  pair("trial", "Trial"),
];

// Shared across requiredCertifications / socialComplianceRequirements /
// sustainabilityRequirements / restrictedSubstanceRequirements — the spec
// explicitly forbids permanently hard-coding a scheme list (BSCI, SEDEX/SMETA,
// WRAP, GOTS, OEKO-TEX, ISO...), so this is one configurable, extensible list
// rather than four independent hard-coded enums.
const COMPLIANCE_REQUIREMENTS = [
  pair("bsci", "BSCI"),
  pair("sedex_smeta", "SEDEX / SMETA"),
  pair("wrap", "WRAP"),
  pair("gots", "GOTS"),
  pair("oeko_tex", "OEKO-TEX"),
  pair("iso_9001", "ISO 9001"),
  pair("iso_14001", "ISO 14001"),
  pair("higg_index", "Higg Index"),
  pair("grs", "GRS (Global Recycled Standard)"),
  pair("reach", "REACH"),
  pair("cpsia", "CPSIA"),
  pair("other", "Other"),
];

const PERSONALIZATION_TYPES = [
  pair("logo", "Logo"),
  pair("wearer_name", "Wearer Name"),
  pair("employee_id", "Employee ID"),
  pair("rank", "Rank"),
  pair("department", "Department"),
  pair("badge", "Badge"),
];

// ── Garment Sales Profile — small closed sets kept as plain schema enums
// (not admin-configurable lookups) rather than full CrmLookup categories —
// the spec does not list these among the fields that "must use controlled
// values," and each set is small/stable enough for a schema enum.
const ORDERING_MODELS = ["centralized", "site_level", "department_level", "mixed"];
const FULFILLMENT_MODELS = ["stock_supported", "made_to_order", "mixed"];
const SIZING_MODELS = ["standard_size", "sizing_camp", "made_to_measure", "wearer_provided", "mixed"];
const FREIGHT_MODES = ["air", "sea", "road", "rail", "courier", "mixed"];
const ISSUE_FREQUENCIES = ["annual", "biannual", "quarterly", "on_demand", "other"];

// ── Currencies & countries ───────────────────────────────────────────────────
// A curated set (not the full ISO tables) covering the markets this
// manufacturer trades in — enough for real dropdowns without shipping 250 rows.
const CURRENCIES = [
  pair("INR", "Indian Rupee (₹)"),
  pair("USD", "US Dollar ($)"),
  pair("EUR", "Euro (€)"),
  pair("GBP", "Pound Sterling (£)"),
  pair("AED", "UAE Dirham"),
  pair("BDT", "Bangladeshi Taka"),
  pair("LKR", "Sri Lankan Rupee"),
  pair("SGD", "Singapore Dollar"),
  pair("AUD", "Australian Dollar"),
  pair("CAD", "Canadian Dollar"),
  pair("JPY", "Japanese Yen"),
  pair("CNY", "Chinese Yuan"),
];

const COUNTRIES = [
  pair("IN", "India"),
  pair("US", "United States"),
  pair("GB", "United Kingdom"),
  pair("AE", "United Arab Emirates"),
  pair("BD", "Bangladesh"),
  pair("LK", "Sri Lanka"),
  pair("SG", "Singapore"),
  pair("AU", "Australia"),
  pair("CA", "Canada"),
  pair("DE", "Germany"),
  pair("FR", "France"),
  pair("NL", "Netherlands"),
  pair("JP", "Japan"),
  pair("CN", "China"),
  pair("BH", "Bahrain"),
  pair("QA", "Qatar"),
  pair("SA", "Saudi Arabia"),
  pair("NP", "Nepal"),
];

// ── Enquiry costing request (Sales → Merchandising + Industrial Engineering) ──
// The cross-department costing/RFQ request that backs one Cowork costing sheet.
// Sales raises it; merchandiser + IE fill the sheet; Sales reads the Master and
// keys the indicative price. Reused at Cost & Quote for the formal quote.
const COSTING_REQUEST_STATUSES = [
  pair("requested", "Requested"),
  pair("in_progress", "In progress"),
  pair("returned", "Returned"),
  pair("cancelled", "Cancelled"),
];
// requested → in_progress → returned is the forward path; cancel from either
// open state; a returned request can be reopened for another costing round.
const COSTING_REQUEST_STATUS_TRANSITIONS = {
  requested: ["in_progress", "cancelled"],
  in_progress: ["returned", "cancelled"],
  returned: ["in_progress", "cancelled"],
  cancelled: [],
};
const COSTING_REQUEST_PURPOSES = [
  pair("enquiry_indicative", "Indicative (Enquiry)"),
  pair("cost_quote_formal", "Formal quote (Cost & Quote)"),
];

const codes = (list) => list.map((x) => x.code);
const labelMap = (list) => Object.fromEntries(list.map((x) => [x.code, x.label]));

const RELATIONSHIP_TYPE_CODES = codes(RELATIONSHIP_TYPES);
const RELATIONSHIP_BY_CODE = Object.fromEntries(RELATIONSHIP_TYPES.map((r) => [r.code, r]));

/**
 * Resolve how a relationship row reads FROM a given account's point of view.
 * Returns the correct (possibly inverse) label plus the id of the other party.
 */
function relationshipLabelFrom(rel, accountId) {
  const from = String(rel.fromAccountId?._id || rel.fromAccountId);
  const to = String(rel.toAccountId?._id || rel.toAccountId);
  const me = String(accountId);
  const def = RELATIONSHIP_BY_CODE[rel.relationshipType] || {
    label: rel.relationshipType,
    inverseLabel: rel.relationshipType,
  };
  if (me === from) {
    return { label: def.label, otherAccountId: rel.toAccountId, direction: "forward" };
  }
  if (me === to) {
    return { label: def.inverseLabel, otherAccountId: rel.fromAccountId, direction: "inverse" };
  }
  // Neither side — shouldn't happen, but never throw over a label.
  return { label: def.label, otherAccountId: rel.toAccountId, direction: "forward" };
}

/** De-duplicate + validate a roles array against the allowed codes. */
function normalizeRoleList(roles, allowedCodes) {
  if (!Array.isArray(roles)) return [];
  const allowed = new Set(allowedCodes);
  return [...new Set(roles.filter((r) => allowed.has(r)))];
}

/* ── Sales Journey lifecycle ─────────────────────────────────────────────────
   MIRRORS lib/salesJourney/stageConfig.js IN THE FRONTEND, DELIBERATELY.

   Every other vocabulary in this file is snake_case, and these are camelCase.
   That is a considered exception, not an oversight. The frontend's
   stageConfig.js already declares itself "THE SINGLE NAMING SOURCE OF TRUTH for
   the Sales Journey lifecycle", and its camelCase keys are load-bearing in
   eight stage components, the Progress Spine, the fixtures, the capability
   registry and the stage-state tone maps. Introducing snake_case codes here
   would mean a translation layer between two vocabularies for the same eight
   concepts — precisely the drift this file exists to prevent. The stored code
   is therefore the frontend's key, and the URL slug (`style-sample`) stays a
   separate presentational concern owned by stageConfig.

   Renaming a stage means editing BOTH files. Neither is authoritative alone. */

const SALES_JOURNEY_STAGES = [
  pair("account", "Account"),
  pair("enquiry", "Enquiry/RFQ"),
  pair("styleSample", "Style & Sample"),
  pair("costQuote", "Cost & Quote"),
  pair("poContract", "PO/Contract"),
  pair("production", "Production"),
  pair("shipment", "Shipment"),
  pair("retention", "Retention"),
];

// Four distinct concepts kept separate — the frontend spec is explicit that one
// generic status field must not be overloaded to mean all of them.
const SALES_JOURNEY_STAGE_STATES = [
  pair("notStarted", "Not Started"),
  pair("inProgress", "In Progress"),
  pair("waitingCustomer", "Waiting on Customer"),
  pair("waitingInternal", "Waiting on Internal Team"),
  pair("complete", "Complete"),
  pair("reopened", "Reopened"),
  pair("blocked", "Blocked"),
  pair("notApplicable", "Not Applicable"),
];

const SALES_JOURNEY_RISKS = [
  pair("onTrack", "On Track"),
  pair("atRisk", "At Risk"),
  pair("delayed", "Delayed"),
  pair("blocked", "Blocked"),
];

const SALES_JOURNEY_BUSINESS_TYPES = [
  pair("buyingHouse", "Buying House"),
  pair("directBrand", "Direct Brand"),
  pair("uniform", "Uniform Program"),
  pair("repeat", "Repeat Order"),
  pair("replenishment", "Replenishment"),
];

/**
 * The module code an Activity uses in `links[]` to point at a Journey.
 * One constant so the writer and every future reader agree.
 */
const SALES_JOURNEY_LINK_MODULE = "sales-journey";

/* ── Lead qualification (Lead Chunk 1) ───────────────────────────────────────
   Codes are camelCase, per docs/tasks/lead-chunk-01-foundation.md §3 — the
   task spec gives these exact literal codes ("readyToConvert", not
   "ready_to_convert"), so they are reproduced verbatim rather than converted
   to this file's usual snake_case, the same considered exception already
   documented above for the Sales Journey stage codes.

   This is the CANONICAL pre-Journey vocabulary only. Legacy Lead.stage values
   (`proposal_sent`, `negotiation`, `won`, `lost`) are NOT represented here —
   per ADR-002 they overlap the Sales Journey lifecycle and are not offered to
   new work. They remain a separate, unmigrated schema enum on the Lead model
   for backward-compatible reads by existing callers only. */
/* ── Lead CAPTURE status (Draft Lead chunk) ──────────────────────────────────
   Orthogonal to qualificationState below, on purpose — the task spec is
   explicit that "draft" must never be added to the qualification vocabulary.
   qualificationState answers "how far through funnel is this Lead"; this
   answers "does this Lead exist yet as real, workable data". A Draft Lead's
   qualificationState is always "new" (the schema default) and never moves —
   services/leadQualification.js refuses any transition while captureStatus
   is "draft" — so the two axes can never contradict each other by
   construction, the same discipline that file already applies to
   stage/qualificationState.

   Existing Lead records predate this field entirely (no migration runs, per
   the task spec) — every query that filters on captureStatus treats a
   missing value as "active", never as an error or an accidental Draft. */
const LEAD_CAPTURE_STATUSES = [
  pair("draft", "Draft"),
  pair("active", "Active"),
  pair("archived", "Archived"),
];

// The capture statuses that are NOT part of the active pipeline. `draft` (not
// real workable data yet) and `archived` (a disposed draft) must both be
// excluded from every active-lead query, pipeline total, report and overdue
// count — `{ captureStatus: { $nin: LEAD_INACTIVE_CAPTURE_STATUSES } }` is the
// one canonical "reportable / active lead" filter, reused across
// routes/CMS_Routes/Sales/leads.js and accounts.js so the rule can't drift.
// A MISSING captureStatus (every legacy pre-chunk record) is neither of these,
// so `$nin` matches it and it is always treated as Active — no migration.
const LEAD_INACTIVE_CAPTURE_STATUSES = ["draft", "archived"];

/* ── Prospect review status (Prospect → HOD Review → Active Lead workflow) ────
   A SEPARATE axis from both captureStatus and qualificationState, on purpose:
   captureStatus answers "is this a Prospect / Active Lead / Archived";
   qualificationState answers "how far through the funnel is an Active Lead";
   this answers "where is a Prospect in its HOD approval". A Prospect
   (captureStatus:"draft") begins "researching", the salesperson enriches it,
   then submits it ("submitted", read-only until reviewed). A HOD/admin then
   either approves it (→ captureStatus "active", reviewStatus "approved" — an
   Active Lead), returns it for more information ("returned", editable again
   and re-submittable), or rejects it ("rejected", → captureStatus "archived").
   Only a HOD/admin approval may make a Prospect an Active Lead — enforced in
   services/leadReview.js + routes/CMS_Routes/Sales/leads.js. This is NOT
   "conversion" (which is Lead → Account/Contact/Sales Journey, a later chunk).
   Pre-workflow records have no value here; every read treats a missing value
   as "researching" (the accurate meaning for a Prospect nobody has submitted
   yet) — no migration. */
const LEAD_REVIEW_STATUSES = [
  pair("researching", "Researching"),
  pair("submitted", "In Review"),
  pair("returned", "Returned"),
  pair("approved", "Approved"),
  pair("rejected", "Rejected"),
];

const LEAD_QUALIFICATION_STATES = [
  pair("new", "New"),
  pair("contactAttempted", "Contacting"),
  pair("contacted", "Contacted"),
  pair("qualified", "Qualified"),
  pair("readyToConvert", "Ready for Journey"),
  pair("nurture", "Nurture"),
  pair("disqualified", "Disqualified"),
  pair("duplicate", "Duplicate"),
  pair("converted", "Journey Started"),
];

// `disqualified`/`duplicate`/`nurture` require a reason on the canonical
// transition API — nurture's "reason" is "why is this being parked" (in
// addition to the next-action/follow-up-date prerequisites enforced
// separately in services/leadQualification.js). `converted` is reserved for
// the future conversion service (Chunk 5) and is never a valid direct target
// of that same API.
const LEAD_QUALIFICATION_REASON_REQUIRED = new Set(["nurture", "disqualified", "duplicate"]);
const LEAD_QUALIFICATION_RESERVED_STATES = new Set(["converted"]);

// Explicit transition graph — the ONLY moves `services/leadQualification.js`
// permits from a given current state. `disqualified` and `duplicate` are
// terminal in this chunk (empty target lists — nothing, including re-entering
// the same state, is a valid "transition" out of them). `converted` has no
// entries because nothing may transition INTO it here either — it is
// reserved for the future conversion service (Chunk 5), enforced separately
// via LEAD_QUALIFICATION_RESERVED_STATES so the rejection message can be
// specific about why, rather than a generic "not a valid transition."
//
// `contactAttempted` sits between `new` and `contacted`: reaching it requires
// a LOGGED outreach attempt (any completed call/email/meeting/site visit),
// reaching `contacted` requires a genuinely SUCCESSFUL two-way contact
// outcome — two different bars, checked in services/leadQualification.js
// against real Activity data, not merely a button click. `new` may also move
// straight to `contacted` (still gated by the SAME successful-contact proof)
// for the common one-call-and-it-connects case — `contactAttempted` is a
// real, useful waypoint, not a mandatory one; nothing about the "contacted"
// bar is weaker for skipping it. `nurture` can return to either
// `contactAttempted` or `contacted` since a parked Lead may resume from
// either point depending on what had actually happened before it was
// nurtured.
const LEAD_QUALIFICATION_TRANSITIONS = {
  new: ["contactAttempted", "contacted", "nurture", "disqualified", "duplicate"],
  contactAttempted: ["contacted", "nurture", "disqualified", "duplicate"],
  contacted: ["qualified", "nurture", "disqualified", "duplicate"],
  qualified: ["readyToConvert", "nurture", "disqualified", "duplicate"],
  readyToConvert: ["nurture", "disqualified", "duplicate"],
  nurture: ["contactAttempted", "contacted", "qualified", "disqualified", "duplicate"],
  disqualified: [],
  duplicate: [],
  converted: [],
};

/* ── Legacy `stage` ⇄ canonical `qualificationState` compatibility mapping ──
   Read this alongside services/leadQualification.js, which is the ONLY code
   that may write either field going forward — see that file's header for why
   the two fields must never be edited independently.

   LEGACY_LEAD_STAGE_TO_QUALIFICATION only covers the three legacy stage
   values that still have an honest canonical equivalent. `proposal_sent`,
   `negotiation` and `won` are deliberately absent: per ADR-002 those outcomes
   now belong to the Sales Journey (Cost & Quote / PO-Contract / conversion),
   so a Lead can no longer move directly to any of them — see
   BLOCKED_LEGACY_LEAD_STAGES. `lost` maps to `disqualified` (and requires a
   reason, like every other disqualified transition).

   LEAD_QUALIFICATION_TO_LEGACY_STAGE is the reverse projection, used to keep
   `stage` in sync whenever `qualificationState` changes through ANY entry
   point (the canonical endpoint included) — so the two fields are always a
   function of one write, never two independently-agreeing ones. `nurture`
   has no entry: it is orthogonal to the legacy funnel position, so
   `deriveLegacyStage` leaves `stage` at whatever it already was rather than
   inventing a funnel position for a state the legacy vocabulary never had. */
const LEGACY_LEAD_STAGE_TO_QUALIFICATION = {
  new: "new",
  contacted: "contacted",
  qualified: "qualified",
  lost: "disqualified",
};
const BLOCKED_LEGACY_LEAD_STAGES = new Set(["proposal_sent", "negotiation", "won"]);
// `contactAttempted` has no entry, same treatment as `nurture` above and for
// the same reason: the legacy vocabulary never had an "attempted but not yet
// contacted" position, so `deriveLegacyStage` leaves `stage` at whatever it
// already was rather than inventing one.
const LEAD_QUALIFICATION_TO_LEGACY_STAGE = {
  new: "new",
  contacted: "contacted",
  qualified: "qualified",
  readyToConvert: "qualified",
  disqualified: "lost",
  duplicate: "lost",
  converted: "won",
};

// ── Sample & Style (R&D / Sampling ↔ Sales journey "Style & Sample" stage) ────
// ONE SampleStyle record per journey product. R&D owns two production jobs
// (tech sheet, sample); each is followed by a Sales approval gate. The R&D app
// and the Sales journey stage both map their own wording onto this canonical
// vocabulary — that's how the two apps stay separate yet talk to one record.
//
// Materials are the Merchandiser's upstream input (R&D can't start the tech
// sheet until they're selected). techSheet/sample each carry a small state
// machine: R&D moves it forward to `submitted`; Sales resolves the gate to
// `approved` or bounces it back (`changes` / `rejected`).
const SAMPLE_MATERIALS_STATUSES = [
  pair("pending", "Awaiting materials"),
  pair("selected", "Materials selected"),
];
const SAMPLE_TECHSHEET_STATUSES = [
  pair("pending", "Not started"),
  pair("in_progress", "In progress"),
  pair("submitted", "With Sales"),
  pair("approved", "Approved"),
  pair("changes", "Changes requested"),
];
const SAMPLE_TECHSHEET_TRANSITIONS = {
  pending: ["in_progress"],
  in_progress: ["submitted"],
  submitted: ["approved", "changes"],
  changes: ["in_progress"],
  approved: [],
};
const SAMPLE_SAMPLING_STATUSES = [
  pair("not_started", "Not started"),
  pair("in_progress", "In progress"),
  pair("submitted", "With Sales"),
  pair("approved", "Approved"),
  pair("rejected", "Rejected"),
];
const SAMPLE_SAMPLING_TRANSITIONS = {
  not_started: ["in_progress"],
  in_progress: ["submitted"],
  submitted: ["approved", "rejected"],
  rejected: ["in_progress"],
  approved: [],
};
// How one round was judged. Deliberately separate from SAMPLE_SAMPLING_STATUSES:
// that is where the STYLE is, this is what happened to a single sample. Round 2
// stays "rejected" forever even after round 3 is approved — that is the record.
// "superseded" is the honest label for a round nobody ruled on before the next
// one was made, which is most of them.
const SAMPLE_ROUND_OUTCOMES = [
  pair("pending", "Awaiting verdict"),
  pair("accepted", "Accepted"),
  pair("rejected", "Rejected"),
  pair("superseded", "Superseded"),
];
const SAMPLE_ROUND_TYPES = [
  pair("proto", "Proto"),
  pair("fit", "Fit"),
  pair("sms", "SMS (Salesman)"),
  pair("size_set", "Size set"),
  pair("pp", "Pre-production (PP)"),
];
const SAMPLE_STYLE_STATUSES = [
  pair("active", "Active"),
  pair("completed", "Completed"),
  pair("cancelled", "Cancelled"),
];

// Routing position — the coarse WORK stage a style is in, moved like a kanban
// card in the Sales "Style & Sample" stage. A style is created at `brief` (just
// carried from the enquiry — sitting there, sent nowhere yet); Sales sends it
// to the Merchandiser (`materials`), who selects fabric/trims and sends it on
// to `rnd` for tech sheet + sampling. Nothing advances automatically. The R&D
// app only lists styles at `rnd`; within `rnd` the finer Tech sheet / Sampling
// / Done columns are derived from the phase statuses, not stored here.
const SAMPLE_STYLE_STAGES = [
  pair("brief", "Brief"),
  pair("materials", "Materials"),
  pair("rnd", "With R&D"),
];

module.exports = {
  ACCOUNT_ROLES,
  ACCOUNT_STATUSES,
  LIFECYCLE_STAGES,
  CUSTOMER_TIERS,
  CREDIT_STATUSES,
  SITE_TYPES,
  ADDRESS_TYPES,
  CONTACT_ROLES,
  CONTACT_STATUSES,
  PREFERRED_CHANNELS,
  CONSENT_STATUSES,
  TEAM_ROLES,
  ACTIVITY_TYPES,
  ACTIVITY_STATUSES,
  ACTIVITY_PRIORITIES,
  ACTIVITY_VISIBILITIES,
  ACTIVITY_TASK_TYPES,
  ACTIVITY_OUTCOMES,
  SUCCESSFUL_CONTACT_OUTCOMES,
  OUTREACH_ATTEMPT_ACTIVITY_TYPES,
  RELATIONSHIP_TYPES,

  // Requirement certainty (Lead correction chunk)
  REQUIREMENT_CERTAINTIES,
  REQUIREMENT_CERTAINTY_CODES: codes(REQUIREMENT_CERTAINTIES),
  REQUIREMENT_CERTAINTY_CONFIRMED,

  // Sales Journey lifecycle (mirrors the frontend stageConfig — see note above)
  SALES_JOURNEY_STAGES,
  SALES_JOURNEY_STAGE_STATES,
  SALES_JOURNEY_RISKS,
  SALES_JOURNEY_BUSINESS_TYPES,
  SALES_JOURNEY_LINK_MODULE,
  SALES_JOURNEY_STAGE_CODES: codes(SALES_JOURNEY_STAGES),
  SALES_JOURNEY_STAGE_STATE_CODES: codes(SALES_JOURNEY_STAGE_STATES),
  SALES_JOURNEY_RISK_CODES: codes(SALES_JOURNEY_RISKS),
  SALES_JOURNEY_BUSINESS_TYPE_CODES: codes(SALES_JOURNEY_BUSINESS_TYPES),

  // Sample & Style (R&D / Sampling ↔ Sales journey Style & Sample stage)
  SAMPLE_MATERIALS_STATUSES,
  SAMPLE_MATERIALS_STATUS_CODES: codes(SAMPLE_MATERIALS_STATUSES),
  SAMPLE_TECHSHEET_STATUSES,
  SAMPLE_TECHSHEET_STATUS_CODES: codes(SAMPLE_TECHSHEET_STATUSES),
  SAMPLE_TECHSHEET_TRANSITIONS,
  SAMPLE_SAMPLING_STATUSES,
  SAMPLE_SAMPLING_STATUS_CODES: codes(SAMPLE_SAMPLING_STATUSES),
  SAMPLE_SAMPLING_TRANSITIONS,
  SAMPLE_ROUND_TYPES,
  SAMPLE_ROUND_TYPE_CODES: codes(SAMPLE_ROUND_TYPES),
  SAMPLE_ROUND_OUTCOMES,
  SAMPLE_ROUND_OUTCOME_CODES: codes(SAMPLE_ROUND_OUTCOMES),
  SAMPLE_STYLE_STATUSES,
  SAMPLE_STYLE_STATUS_CODES: codes(SAMPLE_STYLE_STATUSES),
  SAMPLE_STYLE_STAGES,
  SAMPLE_STYLE_STAGE_CODES: codes(SAMPLE_STYLE_STAGES),

  // Lead capture status (Draft Lead chunk) — see the block comment above.
  LEAD_CAPTURE_STATUSES,
  LEAD_CAPTURE_STATUS_CODES: codes(LEAD_CAPTURE_STATUSES),
  LEAD_INACTIVE_CAPTURE_STATUSES,

  // Prospect review status (Prospect → HOD Review → Active Lead workflow)
  LEAD_REVIEW_STATUSES,
  LEAD_REVIEW_STATUS_CODES: codes(LEAD_REVIEW_STATUSES),

  // Lead qualification (Lead Chunk 1 — mirrors docs/tasks/lead-chunk-01-foundation.md §3)
  LEAD_QUALIFICATION_STATES,
  LEAD_QUALIFICATION_STATE_CODES: codes(LEAD_QUALIFICATION_STATES),
  LEAD_QUALIFICATION_REASON_REQUIRED,
  LEAD_QUALIFICATION_RESERVED_STATES,
  LEAD_QUALIFICATION_TRANSITIONS,
  LEGACY_LEAD_STAGE_TO_QUALIFICATION,
  BLOCKED_LEGACY_LEAD_STAGES,
  LEAD_QUALIFICATION_TO_LEGACY_STAGE,

  // code arrays for schema enums
  ACCOUNT_ROLE_CODES: codes(ACCOUNT_ROLES),
  ACCOUNT_STATUS_CODES: codes(ACCOUNT_STATUSES),
  LIFECYCLE_STAGE_CODES: codes(LIFECYCLE_STAGES),
  CUSTOMER_TIER_CODES: codes(CUSTOMER_TIERS),
  CUSTOMER_TYPE_CODES: codes(CUSTOMER_TYPES),
  GST_TREATMENT_CODES: codes(GST_TREATMENTS),
  FREIGHT_ARRANGEMENT_CODES: codes(FREIGHT_ARRANGEMENTS),
  ENQUIRY_STATUS_CODES: codes(ENQUIRY_STATUSES),
  COSTING_REQUEST_STATUSES,
  COSTING_REQUEST_STATUS_CODES: codes(COSTING_REQUEST_STATUSES),
  COSTING_REQUEST_STATUS_TRANSITIONS,
  COSTING_REQUEST_PURPOSES,
  COSTING_REQUEST_PURPOSE_CODES: codes(COSTING_REQUEST_PURPOSES),
  ENQUIRY_STATUS_TRANSITIONS,
  ENQUIRY_SOURCE_CODES: codes(ENQUIRY_SOURCES),
  ENQUIRY_LOST_REASON_CODES: codes(ENQUIRY_LOST_REASONS),
  GARMENT_GENDER_CODES: codes(GARMENT_GENDERS),
  ENQUIRY_PRIORITY_CODES: codes(ENQUIRY_PRIORITIES),
  CUSTOMER_SERIOUSNESS_CODES: codes(CUSTOMER_SERIOUSNESS),
  ENQUIRY_REFERENCE_TYPE_CODES: codes(ENQUIRY_REFERENCE_TYPES),
  CREDIT_STATUS_CODES: codes(CREDIT_STATUSES),
  SITE_TYPE_CODES: codes(SITE_TYPES),
  ADDRESS_TYPE_CODES: codes(ADDRESS_TYPES),
  CONTACT_ROLE_CODES: codes(CONTACT_ROLES),
  CONTACT_STATUS_CODES: codes(CONTACT_STATUSES),
  PREFERRED_CHANNEL_CODES: codes(PREFERRED_CHANNELS),
  CONSENT_STATUS_CODES: codes(CONSENT_STATUSES),
  TEAM_ROLE_CODES: codes(TEAM_ROLES),
  ACTIVITY_TYPE_CODES: codes(ACTIVITY_TYPES),
  ACTIVITY_STATUS_CODES: codes(ACTIVITY_STATUSES),
  ACTIVITY_PRIORITY_CODES: codes(ACTIVITY_PRIORITIES),
  ACTIVITY_VISIBILITY_CODES: codes(ACTIVITY_VISIBILITIES),
  ACTIVITY_OUTCOME_CODES: codes(ACTIVITY_OUTCOMES),
  ACTIVITY_CHANNELS,
  ACTIVITY_DIRECTIONS,
  ACTIVITY_CHANNEL_CODES: codes(ACTIVITY_CHANNELS),
  ACTIVITY_DIRECTION_CODES: codes(ACTIVITY_DIRECTIONS),
  RELATIONSHIP_TYPE_CODES,
  RELATIONSHIP_BY_CODE,

  // Garment Sales Profile (§7.2A)
  BUSINESS_MODEL_CODES: codes(BUSINESS_MODELS),
  PRODUCT_CATEGORY_CODES: codes(PRODUCT_CATEGORIES),
  CONSTRUCTION_TYPE_CODES: codes(CONSTRUCTION_TYPES),
  WEARER_CONSUMER_CATEGORY_CODES: codes(WEARER_CONSUMER_CATEGORIES),
  ORDER_FREQUENCY_CODES: codes(ORDER_FREQUENCIES),
  CUSTOMER_POTENTIAL_CODES: codes(CUSTOMER_POTENTIALS),
  COMPLIANCE_REQUIREMENT_CODES: codes(COMPLIANCE_REQUIREMENTS),
  PERSONALIZATION_TYPE_CODES: codes(PERSONALIZATION_TYPES),
  ORDERING_MODELS,
  FULFILLMENT_MODELS,
  SIZING_MODELS,
  FREIGHT_MODES,
  ISSUE_FREQUENCIES,

  // label maps (for building lookup/seed payloads)
  labelMap,

  // helpers
  relationshipLabelFrom,
  normalizeRoleList,

  /** Everything the lookups endpoint / seed script expose, grouped by category. */
  LOOKUP_CATEGORIES: {
    account_role: ACCOUNT_ROLES,
    account_status: ACCOUNT_STATUSES,
    lifecycle_stage: LIFECYCLE_STAGES,
    customer_tier: CUSTOMER_TIERS,
    customer_type: CUSTOMER_TYPES,
    gst_treatment: GST_TREATMENTS,
    freight_arrangement: FREIGHT_ARRANGEMENTS,
    enquiry_status: ENQUIRY_STATUSES,
    enquiry_source: ENQUIRY_SOURCES,
    enquiry_lost_reason: ENQUIRY_LOST_REASONS,
    garment_gender: GARMENT_GENDERS,
    enquiry_priority: ENQUIRY_PRIORITIES,
    customer_seriousness: CUSTOMER_SERIOUSNESS,
    enquiry_reference_type: ENQUIRY_REFERENCE_TYPES,
    costing_request_status: COSTING_REQUEST_STATUSES,
    costing_request_purpose: COSTING_REQUEST_PURPOSES,
    credit_status: CREDIT_STATUSES,
    site_type: SITE_TYPES,
    address_type: ADDRESS_TYPES,
    contact_role: CONTACT_ROLES,
    contact_status: CONTACT_STATUSES,
    preferred_channel: PREFERRED_CHANNELS,
    consent_status: CONSENT_STATUSES,
    team_role: TEAM_ROLES,
    activity_type: ACTIVITY_TYPES,
    activity_status: ACTIVITY_STATUSES,
    activity_priority: ACTIVITY_PRIORITIES,
    activity_visibility: ACTIVITY_VISIBILITIES,
    activity_outcome: ACTIVITY_OUTCOMES,
    requirement_certainty: REQUIREMENT_CERTAINTIES,
    relationship_type: RELATIONSHIP_TYPES.map((r) => ({ code: r.code, label: r.label, inverse: r.inverse, inverseLabel: r.inverseLabel })),
    currency: CURRENCIES,
    country: COUNTRIES,
    business_model: BUSINESS_MODELS,
    product_category: PRODUCT_CATEGORIES,
    construction_type: CONSTRUCTION_TYPES,
    wearer_consumer_category: WEARER_CONSUMER_CATEGORIES,
    order_frequency: ORDER_FREQUENCIES,
    customer_potential: CUSTOMER_POTENTIALS,
    compliance_requirement: COMPLIANCE_REQUIREMENTS,
    personalization_type: PERSONALIZATION_TYPES,
    lead_qualification_state: LEAD_QUALIFICATION_STATES,
    lead_capture_status: LEAD_CAPTURE_STATUSES,
    lead_review_status: LEAD_REVIEW_STATUSES,
  },
};
