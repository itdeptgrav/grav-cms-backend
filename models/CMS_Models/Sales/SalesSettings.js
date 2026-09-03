// models/CMS_Models/Sales/SalesSettings.js
//
// Singleton document — one settings record for the entire sales team.
//
// Two groups of email notifications:
//
//   SALES-TRIGGERED (sent from the sales dashboard):
//     welcome              — new customer account created by sales
//     passwordReset        — customer password reset by sales
//     profileUpdate        — customer profile edited by sales
//
//   CUSTOMER PORTAL (sent by system actions on the customer side):
//     customerWelcome      — customer self-registers on the portal
//     requestConfirmation  — customer submits a purchase order / request
//     editRequestNotification — sales requests an edit, customer must approve
//     quotationSent        — quotation sent to customer for approval

const mongoose = require("mongoose");

// ── Sampling message defaults (28 Aug 2026) ──────────────────────────────────
//
// Declared as a plain object and EXPORTED, not written inline in the schema,
// because three separate places need the exact same text:
//   • this schema, as the field defaults for a brand-new settings document;
//   • services/departmentNotify.service.js, which falls back to them when
//     sending — schema defaults only materialise on document CREATION, so the
//     settings singletons that already exist in every environment carry no
//     samplingTemplates at all and would otherwise send nothing;
//   • the Sales Settings page's "Reset to defaults", so what a salesperson
//     resets to is what actually goes out.
//
// Formal, industry-standard wording on purpose ("messgae should be in an
// formal way ok as like idustry standard ok" — 28 Aug 2026). Placeholders are
// `{curly}`, matching utils/salesEmailService.js's customer templates.
//   {product} {customer} {salesPerson} {styleCode}   — every message
//   {approvedBy}                                     — the R&D message only
//   {decidedBy}                                       — bomApproved / bomRejected
//   {reason}                                          — bomRejected only
const SAMPLING_TEMPLATE_DEFAULTS = {
  // Step 1 — "Send to Merchandiser".
  merchandiser: {
    enabled: true,
    subject: "Sampling request — BOM required for {product} ({customer})",
    heading: "Sampling request: {product}",
    bodyText:
      "Dear Merchandising Team,\n\n" +
      "The Sales team ({salesPerson}) has raised a sampling request for the product detailed below, on behalf of our customer {customer}.\n\n" +
      "Kindly prepare and record the Bill of Materials (BOM) / raw material requirement against this product so that development can proceed. The product details and reference images are set out below for your reference.\n\n" +
      "Please revert once the BOM has been filled in, or write back if any specification requires clarification.\n\n" +
      "Thank you for your support.\n\n" +
      "Regards,\n{salesPerson}\nSales Team, GRAV Clothing",
    ctaLabel: "View Product",
  },
  // Step 2 — "Send Request for BOM Approval" (decided from the email itself).
  bomApproval: {
    enabled: true,
    subject: "BOM approval required — {product} ({customer})",
    heading: "BOM approval required: {product}",
    bodyText:
      "Dear Project Manager,\n\n" +
      "The Sales team ({salesPerson}) requests your approval of the Bill of Materials prepared for the product detailed below, raised for our customer {customer}.\n\n" +
      "Kindly review the raw material selection, product specification and reference images below, and record your decision using the Approve or Reject option in this email. Should you reject the request, please state the reason so that Merchandising can revise the BOM accordingly.\n\n" +
      "Development cannot be released to R&D until this approval is received, so your prompt response would be appreciated.\n\n" +
      "Regards,\n{salesPerson}\nSales Team, GRAV Clothing",
    ctaLabel: "View Product",
  },
  // Step 3 — "Send to R&D", once Production has approved.
  rnd: {
    enabled: true,
    subject: "Sampling & development — {product} ({customer})",
    heading: "Sample development: {product}",
    bodyText:
      "Dear R&D Team,\n\n" +
      "The Sales team ({salesPerson}) has released the product detailed below for sample development, on behalf of our customer {customer}. The Bill of Materials has been approved by the Project Manager{approvedBy}.\n\n" +
      "Kindly proceed with the technical pack and the sample as per the specification and reference images below. Please revert with the tech sheet for approval once prepared.\n\n" +
      "Thank you for your support.\n\n" +
      "Regards,\n{salesPerson}\nSales Team, GRAV Clothing",
    ctaLabel: "Open in R&D",
  },
  // Sent to BOTH Merchandising and Sales the moment the Project Manager
  // records their decision on the BOM-approval email (28 Aug 2026, explicit
  // request — the decision used to reach only Sales, and only as fixed
  // system wording, not an editable template). Addressed to "Team" rather
  // than a single role since one message now serves two different readers —
  // the person who built the BOM, and the person who asked for the sign-off.
  bomApproved: {
    enabled: true,
    subject: "BOM approved — {product} ({customer})",
    heading: "BOM approved: {product}",
    bodyText:
      "Dear Team,\n\n" +
      "This is to inform you that the Bill of Materials submitted for {product}, raised for our customer {customer}, has been approved by {decidedBy}.\n\n" +
      "Development may now proceed — Sales will release this style to R&D for sample preparation. Please find the approved product and material details below for your reference.\n\n" +
      "Thank you for your continued support.\n\n" +
      "Regards,\n{salesPerson}\nSales Team, GRAV Clothing",
    ctaLabel: "View Product",
  },
  bomRejected: {
    enabled: true,
    subject: "BOM rejected — revision required for {product} ({customer})",
    heading: "BOM rejected: {product}",
    bodyText:
      "Dear Team,\n\n" +
      "This is to inform you that the Bill of Materials submitted for {product}, raised for our customer {customer}, has been rejected by {decidedBy}.\n\n" +
      "Reason for rejection: {reason}\n\n" +
      "Kindly revise the raw material selection accordingly. Once updated, Sales will send the request for approval again.\n\n" +
      "Thank you for your attention to this matter.\n\n" +
      "Regards,\n{salesPerson}\nSales Team, GRAV Clothing",
    ctaLabel: "View Product",
  },
};

/** One sampling message's fields, defaulted from the object above. */
const samplingTemplateField = (d) => ({
  enabled:  { type: Boolean, default: d.enabled },
  subject:  { type: String, trim: true, default: d.subject },
  heading:  { type: String, trim: true, default: d.heading },
  bodyText: { type: String, trim: true, default: d.bodyText },
  ctaLabel: { type: String, trim: true, default: d.ctaLabel },
});

// ── Shared sub-schema used for every email type ───────────────────────────────
const emailConfigSchema = new mongoose.Schema(
  {
    enabled:      { type: Boolean, default: false },
    subject:      { type: String, trim: true, default: "" },
    title:        { type: String, trim: true, default: "" },
    subtitle:     { type: String, trim: true, default: "" },
    greeting:     { type: String, trim: true, default: "Dear {name}," },
    bodyText:     { type: String, trim: true, default: "" },
    buttonText:   { type: String, trim: true, default: "" },
    securityNote: { type: String, trim: true, default: "" },
    footerNote:   { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const salesSettingsSchema = new mongoose.Schema(
  {
    // ── Sales Representative Profile ─────────────────────────────────────────
    repName:             { type: String, trim: true,    default: "Sales Team" },
    repEmail:            { type: String, trim: true, lowercase: true, default: "sales@grav.in" },
    repPhone:            { type: String, trim: true,    default: "+91 96920 90096" },
    officeHours:         { type: String, trim: true,    default: "Monday–Friday, 9:00 AM – 6:00 PM IST" },
    specialInstructions: { type: String, trim: true,    default: "" },
    additionalInfo:      { type: String, trim: true,    default: "" },

    // ── Company / Portal details (used as {vars} in email templates) ─────────
    companyName:    { type: String, trim: true, default: "Grav Clothing" },
    supportEmail:   { type: String, trim: true, lowercase: true, default: "support@grav.in" },
    salesEmail:     { type: String, trim: true, lowercase: true, default: "sales@grav.in" },
    portalUrl:      { type: String, trim: true, default: "https://portal.gravclothing.com" },
    companyAddress: { type: String, trim: true, default: "Mayfair Lagoon Campus, Est. 2024" },

    // ── Email notification configs ────────────────────────────────────────────
    emailNotifications: {

      // ── GROUP 1: Sales-triggered ──────────────────────────────────────────
      welcome: { type: emailConfigSchema, default: () => ({
        enabled:      false,
        subject:      "Welcome to Grav Clothing – Your Customer Account is Ready",
        title:        "Welcome to Grav Clothing",
        subtitle:     "Your customer portal account has been created successfully.",
        greeting:     "Dear {name},",
        bodyText:     "We are pleased to inform you that your customer account has been successfully created with Grav Clothing. You now have access to our customer portal where you can view your orders, quotations, and your assigned product catalogue.",
        buttonText:   "Access Customer Portal",
        securityNote: "This temporary password was set by our sales team on your behalf. Please change it immediately after your first login via your account profile settings. Do not share your credentials with anyone.",
        footerNote:   "Your dedicated sales representative will be in touch shortly. For any queries, email us at {supportEmail}.",
      }) },

      passwordReset: { type: emailConfigSchema, default: () => ({
        enabled:      false,
        subject:      "Action Required: Your Grav Clothing Portal Password Has Been Reset",
        title:        "Password Reset Notification",
        subtitle:     "Your portal access credentials have been updated.",
        greeting:     "Dear {name},",
        bodyText:     "This is to notify you that your Grav Clothing customer portal password has been updated by our sales team. Your new login credentials are listed below.",
        buttonText:   "Login to Portal",
        securityNote: "If you did not authorise this change, please contact your sales representative immediately at {salesEmail} or call {repPhone}. We recommend updating your password to a personal one after logging in.",
        footerNote:   "",
      }) },

      profileUpdate: { type: emailConfigSchema, default: () => ({
        enabled:      false,
        subject:      "Notice: Your Grav Clothing Account Details Have Been Updated",
        title:        "Account Update Notice",
        subtitle:     "Your account information has been updated by our sales team.",
        greeting:     "Dear {name},",
        bodyText:     "This is to notify you that the following details on your Grav Clothing account have been updated by our sales team. Please review the changes carefully.",
        buttonText:   "",
        securityNote: "",
        footerNote:   "If any of the above changes are incorrect, please contact your sales representative immediately at {salesEmail}.",
      }) },

      // ── GROUP 2: Customer portal ──────────────────────────────────────────
      customerWelcome: { type: emailConfigSchema, default: () => ({
        enabled:      false,
        subject:      "Welcome to Grav Clothing – Your Account is Ready",
        title:        "Welcome to Grav Clothing",
        subtitle:     "Thank you for registering with us.",
        greeting:     "Dear {name},",
        bodyText:     "Thank you for creating an account with Grav Clothing. We are excited to have you join our community. You can now access your dashboard to submit custom clothing requests, track your orders, manage your profile, and view your measurements.",
        buttonText:   "Access Your Dashboard",
        securityNote: "",
        footerNote:   "For any assistance or queries, please feel free to contact us at {supportEmail} or call us at {repPhone}.",
      }) },

      requestConfirmation: { type: emailConfigSchema, default: () => ({
        enabled:      false,
        subject:      "Grav Clothing – Your Request Has Been Received",
        title:        "Request Confirmation",
        subtitle:     "We have received your clothing request and our team is reviewing it.",
        greeting:     "Dear {name},",
        bodyText:     "Thank you for submitting your clothing request. We have received your order details and our tailoring team is now reviewing your requirements. We will contact you if any clarifications are needed.",
        buttonText:   "Track Your Request",
        securityNote: "",
        footerNote:   "Please quote your Request ID in all communications for faster service. Contact us at {supportEmail} or {repPhone}.",
      }) },

      editRequestNotification: { type: emailConfigSchema, default: () => ({
        enabled:      false,
        subject:      "Action Required: Edit Request for Your Order – Grav Clothing",
        title:        "Edit Request — Your Approval is Required",
        subtitle:     "Our sales team has proposed changes to your order. Please review and respond within 24 hours.",
        greeting:     "Dear {name},",
        bodyText:     "Our sales team has initiated an edit request for your order. The proposed changes require your approval before we can proceed with production. Please review the details carefully and respond at the earliest.",
        buttonText:   "Review & Respond to Edit Request",
        securityNote: "Please respond within 24 hours to avoid any delays in your order. If you have questions about these changes, contact us at {salesEmail} or call {repPhone}.",
        footerNote:   "Please quote your Order ID in all communications for faster service.",
      }) },

      quotationSent: { type: emailConfigSchema, default: () => ({
        enabled:      false,
        subject:      "Grav Clothing – Your Quotation is Ready for Review",
        title:        "Your Quotation is Ready",
        subtitle:     "Please review and approve your quotation at the earliest.",
        greeting:     "Dear {name},",
        bodyText:     "We are pleased to present you with a quotation for your custom clothing request. The quotation includes all taxes, charges, and a payment schedule. Please review all details carefully before approving.",
        buttonText:   "Review & Approve Quotation",
        securityNote: "",
        footerNote:   "For any queries or modifications, please contact our sales team at {salesEmail} or call us at {repPhone}. Please quote your Quotation Number in all communications.",
      }) },
    },

    // ── Department notifications — NOT customer-facing (20 Aug 2026) ─────────
    // Cross-department "something happened, you should know" emails — e.g.
    // Merchandising + the Project Manager when Sales opens a new Enquiry/RFQ,
    // R&D when a style is sent to them. WHO receives each one is decided by
    // Access Control (department membership), never stored here. This is only
    // the ON/OFF switch per situation — see services/departmentNotify.service.js
    // for the fixed event → department map and the event registry (labels,
    // descriptions) the settings page reads.
    departmentNotifications: {
      disabledEvents: { type: [String], default: [] },
    },

    // ── Sampling messages — the three Style & Sample hand-offs (28 Aug 2026) ──
    //
    // The ONE set of department emails whose wording Sales owns, on explicit
    // request: "in the setting page keep an feature for dynamically defining
    // the sampling product message & template ok.. so the sales person can
    // also modify the messgae and all templte ok.. bydefault ut an proepr
    // template".
    //
    // Every OTHER department notification stays fixed system wording (see
    // departmentNotifications above) because it reports a fact. These three are
    // different in kind: each is a formal REQUEST addressed to another
    // department — fill this BOM, approve this BOM, develop this style — and
    // the phrasing of a request is exactly the sort of thing a sales team
    // reasonably wants to set in their own house style.
    //
    // Prose only. The customer/product detail rows, the reference photos and
    // the deep-link URLs are built by the route that sends the mail, not stored
    // here — a template can change how the ask reads, never which record it
    // points at. Placeholders are `{curly}`, the same convention
    // utils/salesEmailService.js already uses for the customer templates; the
    // ones each message supports are listed on its own `bodyText` default below.
    //
    // `enabled: false` is a per-message off switch, independent of the
    // event-level `disabledEvents` opt-out above.
    samplingTemplates: {
      merchandiser: samplingTemplateField(SAMPLING_TEMPLATE_DEFAULTS.merchandiser),
      bomApproval:  samplingTemplateField(SAMPLING_TEMPLATE_DEFAULTS.bomApproval),
      rnd:          samplingTemplateField(SAMPLING_TEMPLATE_DEFAULTS.rnd),
      bomApproved:  samplingTemplateField(SAMPLING_TEMPLATE_DEFAULTS.bomApproved),
      bomRejected:  samplingTemplateField(SAMPLING_TEMPLATE_DEFAULTS.bomRejected),
    },

    // ── The house customer used by in-house sampling (31 Aug 2026) ───────────
    //
    // An in-house sample has no customer — but everything downstream of the
    // sample (the production run, the Manufacturing Order, the work orders)
    // is built on `CustomerRequest`, which needs a real Customer document to
    // hang off. So sampling borrows a standing house account.
    //
    // Explicit request: "which customer reference need to take for the
    // manufacturing order, r&d process and all... you can take reference of
    // the corresponding sales person ok, and the customer company name and
    // all you can put as like Grav Sampling Order... and also basically keep
    // the setting in the sales department so that they can also change there
    // information which is putting in the customer side".
    //
    // These are the values used to FIND-OR-CREATE that account — see
    // services/houseSamplingCustomer.service.js. `email` is the identity key
    // (Customer's only other required field, and the one the sales customer
    // route already treats as unique), so changing it here points sampling at
    // a different account rather than renaming the existing one; changing the
    // name or phone updates the existing account in place.
    //
    // The SALESPERSON who raised the sample is recorded per-order on the
    // request itself, not here — this block is the company-level identity all
    // sampling orders share.
    houseSamplingCustomer: {
      name:    { type: String, trim: true, default: "Grav Sampling Order" },
      email:   { type: String, trim: true, lowercase: true, default: "sampling@grav.in" },
      phone:   { type: String, trim: true, default: "0000000000" },
      address: { type: String, trim: true, default: "In-house sampling — no customer address" },
      city:    { type: String, trim: true, default: "Bhubaneswar" },
      postalCode: { type: String, trim: true, default: "" },
    },

    // ── Audit ─────────────────────────────────────────────────────────────────
    updatedBy:     { type: mongoose.Schema.Types.ObjectId, ref: "SalesDepartment" },
    updatedByName: { type: String, trim: true },
  },
  { timestamps: true }
);

const SalesSettings = mongoose.models.SalesSettings || mongoose.model("SalesSettings", salesSettingsSchema);

module.exports = SalesSettings;
// Named export alongside the default so the sender and the settings page can
// fall back to the same copy — see SAMPLING_TEMPLATE_DEFAULTS' own comment.
module.exports.SAMPLING_TEMPLATE_DEFAULTS = SAMPLING_TEMPLATE_DEFAULTS;