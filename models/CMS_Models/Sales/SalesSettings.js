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

    // ── Audit ─────────────────────────────────────────────────────────────────
    updatedBy:     { type: mongoose.Schema.Types.ObjectId, ref: "SalesDepartment" },
    updatedByName: { type: String, trim: true },
  },
  { timestamps: true }
);

module.exports = mongoose.models.SalesSettings || mongoose.model("SalesSettings", salesSettingsSchema);