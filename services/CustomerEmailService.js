// services/CustomerEmailService.js
//
// Handles all customer-facing transactional emails sent by the system.
// Uses the same formal HTML template as salesEmailService.js for brand consistency.
// All content is dynamic — driven by the SalesSettings document in MongoDB.
//
// Email types handled:
//   sendWelcomeEmail               — customer self-registers on the portal
//   sendRequestConfirmationEmail   — customer submits a PO / request
//   sendEditRequestNotificationEmail — sales proposes edits, customer must approve
//   sendQuotationEmail             — quotation sent to customer for approval
//   sendOrderConfirmationEmail     — stub (future)
//   sendMeasurementReminderEmail   — stub (future)
//
// Template variables supported in any configurable text field:
//   {name}         — customer name
//   {repName}      — sales rep name (from settings)
//   {repPhone}     — sales rep phone (from settings)
//   {salesEmail}   — sales email (from settings)
//   {supportEmail} — support email (from settings)
//   {requestId}    — request / PO ID
//   {quotationNumber} — quotation number

const axios = require("axios");

const BREVO_BASE = "https://api.brevo.com/v3";
const SENDER     = { name: "Grav Clothing", email: "biswalpramod3.1415@gmail.com" };

// ── Settings cache (5-minute TTL) ────────────────────────────────────────────
let _cachedSettings = null;
let _cacheTime      = 0;
const CACHE_TTL     = 5 * 60 * 1000;

async function getSettings() {
  if (_cachedSettings && Date.now() - _cacheTime < CACHE_TTL) return _cachedSettings;
  try {
    const SalesSettings = require("../models/CMS_Models/Sales/SalesSettings");
    let s = await SalesSettings.findOne().lean();
    if (!s) { const doc = new SalesSettings({}); await doc.save(); s = doc.toObject(); }
    _cachedSettings = s;
    _cacheTime = Date.now();
  } catch (e) {
    console.warn("[CustomerEmailService] Could not load SalesSettings:", e.message);
  }
  return _cachedSettings || {};
}

// ── Variable substitution ────────────────────────────────────────────────────
const interpolate = (str, vars) => {
  if (!str) return "";
  return str.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
};

// ── Shared formal HTML layout (identical to salesEmailService.js) ─────────────
const layout = (title, bodyHtml, settings = {}) => {
  const company  = settings.companyName   || "Grav Clothing";
  const address  = settings.companyAddress|| "Mayfair Lagoon Campus, Est. 2024";
  const support  = settings.supportEmail  || "support@grav.in";
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
    .hdr { background: #1e3a5f; padding: 28px 32px; border-radius: 6px 6px 0 0; text-align: center; }
    .hdr-name { font-size: 20px; font-weight: 700; color: #fff; letter-spacing: 2px; text-transform: uppercase; margin: 0; }
    .hdr-sub { font-size: 11px; color: #93c5fd; letter-spacing: 1px; margin: 6px 0 0; text-transform: uppercase; }
    .hdr-badge { font-size: 10px; color: #64748b; background: #f8fafc; padding: 4px 10px; border-radius: 3px; display: inline-block; margin-top: 8px; letter-spacing: .5px; }
    .body { background: #fff; padding: 32px; border: 1px solid #e2e8f0; border-top: none; font-size: 14px; }
    .title { font-size: 22px; font-weight: 700; color: #0f172a; margin: 0 0 6px; }
    .subtitle { font-size: 12px; color: #64748b; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 20px; }
    .info-box { border: 1px solid #e2e8f0; border-radius: 4px; overflow: hidden; margin: 20px 0; }
    .info-row { border-bottom: 1px solid #e2e8f0; display: table; width: 100%; }
    .info-row:last-child { border-bottom: none; }
    .info-lbl { background: #f8fafc; padding: 10px 16px; font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: .5px; width: 38%; display: table-cell; vertical-align: middle; }
    .info-val { padding: 10px 16px; font-size: 13px; color: #0f172a; font-weight: 600; font-family: monospace; display: table-cell; vertical-align: middle; }
    .section-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; padding: 16px 20px; margin: 20px 0; }
    .section-box h4 { margin: 0 0 10px; font-size: 13px; color: #374151; }
    .items-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
    .items-table th { background: #f1f5f9; padding: 8px 12px; text-align: left; font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase; border-bottom: 2px solid #e2e8f0; }
    .items-table td { padding: 8px 12px; border-bottom: 1px solid #f1f5f9; color: #374151; }
    .total-row { background: #1e3a5f; color: #fff; padding: 14px 20px; border-radius: 4px; text-align: right; font-size: 18px; font-weight: 700; margin: 16px 0; }
    .btn { display: inline-block; background: #1e3a5f; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 4px; font-size: 14px; font-weight: 600; margin: 20px 0; letter-spacing: .5px; }
    .box-blue  { background: #eff6ff; border: 1px solid #bfdbfe; color: #1e40af; padding: 14px 18px; border-radius: 4px; margin: 20px 0; font-size: 13px; }
    .box-amber { background: #fffbeb; border: 1px solid #fde68a; color: #92400e; padding: 14px 18px; border-radius: 4px; margin: 20px 0; font-size: 13px; }
    .box-red   { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; padding: 14px 18px; border-radius: 4px; margin: 20px 0; font-size: 13px; }
    .box-green { background: #f0fdf4; border: 1px solid #bbf7d0; color: #15803d; padding: 14px 18px; border-radius: 4px; margin: 20px 0; font-size: 13px; }
    .step-list { margin: 12px 0; padding: 0; list-style: none; counter-reset: step; }
    .step-list li { counter-increment: step; padding: 6px 0 6px 30px; position: relative; font-size: 13px; color: #374151; border-bottom: 1px solid #f1f5f9; }
    .step-list li:last-child { border-bottom: none; }
    .step-list li::before { content: counter(step); position: absolute; left: 0; top: 6px; width: 20px; height: 20px; background: #1e3a5f; color: #fff; border-radius: 50%; font-size: 11px; text-align: center; line-height: 20px; font-weight: 700; }
    .payment-row { display: table; width: 100%; border-bottom: 1px solid #e2e8f0; }
    .payment-row:last-child { border-bottom: none; }
    .payment-cell { display: table-cell; padding: 8px 12px; font-size: 13px; }
    .ftr { background: #f8fafc; padding: 20px 32px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 6px 6px; font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <div class="hdr">
    <p class="hdr-name">${company.toUpperCase()}</p>
    <p class="hdr-sub">Crafted for Excellence</p>
    <span class="hdr-badge">OFFICIAL COMMUNICATION</span>
  </div>
  <div class="body">${bodyHtml}</div>
  <div class="ftr">
    <p style="margin:0 0 6px">This is an automated message. Please do not reply to this email.</p>
    <p style="margin:0 0 6px">Support: <a href="mailto:${support}" style="color:#1e3a5f;">${support}</a> &nbsp;|&nbsp; ${address}</p>
    <p style="margin:0;font-size:11px;color:#94a3b8;">&copy; ${new Date().getFullYear()} ${company}. All rights reserved.</p>
  </div>
</body>
</html>`;
};

// ── Row helpers ───────────────────────────────────────────────────────────────
const infoRow = (label, value) =>
  `<div class="info-row"><div class="info-lbl">${label}</div><div class="info-val">${value || "—"}</div></div>`;

// ── Send via Brevo ────────────────────────────────────────────────────────────
async function brevoSend(apiKey, to, toName, subject, html, text, customHeader) {
  const response = await axios.post(
    `${BREVO_BASE}/smtp/email`,
    {
      sender: SENDER,
      to: [{ email: to, name: toName || to.split("@")[0] }],
      subject,
      htmlContent: html,
      textContent: text,
      headers: { "X-Mailin-custom": customHeader },
    },
    { headers: { "api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" } }
  );
  return response.data;
}

// ─────────────────────────────────────────────────────────────────────────────
class CustomerEmailService {
  constructor() {
    this.baseUrl    = process.env.WEBSITE_URL || "https://grav.in";
  }

  // ── Shared vars builder ───────────────────────────────────────────────────
  _vars(settings, extra = {}) {
    return {
      repName:      settings.repName      || "Sales Team",
      repPhone:     settings.repPhone     || "+91 96920 90096",
      salesEmail:   settings.salesEmail   || "sales@grav.in",
      supportEmail: settings.supportEmail || "support@grav.in",
      ...extra,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 1. WELCOME (self-registration)
  // ─────────────────────────────────────────────────────────────────────────
  async sendWelcomeEmail(customerData) {
    try {
      const s   = await getSettings();
      const cfg = s.emailNotifications?.customerWelcome || {};
      if (cfg.enabled === false) return { success: false, reason: "disabled" };

      const apiKey = process.env.BREVO_API_KEY;
      if (!apiKey) return { success: false, reason: "no_api_key" };

      const vars       = this._vars(s, { name: customerData.name || "" });
      const dashUrl    = `${this.baseUrl}/dashboard`;
      const date       = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });

      const title    = interpolate(cfg.title    || "Welcome to Grav Clothing", vars);
      const subtitle = interpolate(cfg.subtitle || "Your account has been created.", vars);
      const greeting = interpolate(cfg.greeting || "Dear {name},", vars);
      const body     = interpolate(cfg.bodyText || "Thank you for creating an account with Grav Clothing.", vars);
      const btnText  = interpolate(cfg.buttonText || "Access Your Dashboard", vars);
      const ftNote   = interpolate(cfg.footerNote || "", vars);
      const subject  = interpolate(cfg.subject   || "Welcome to Grav Clothing – Your Account is Ready", vars);

      const html = layout(title, `
        <p class="subtitle">${subtitle}</p>
        <h1 class="title">${title}</h1>
        <p>${greeting}</p>
        <p style="color:#374151;">${body}</p>
        <div class="info-box">
          ${infoRow("Name", customerData.name)}
          ${infoRow("Email", customerData.email)}
          ${infoRow("Account Created", date)}
        </div>
        <p><a href="${dashUrl}" class="btn">${btnText} &rarr;</a></p>
        ${ftNote ? `<p style="font-size:13px;color:#64748b;">${ftNote}</p>` : ""}
        <p style="font-size:13px;margin-top:20px;">Best regards,<br><strong>${vars.repName}</strong><br>${s.companyName || "Grav Clothing"}</p>
      `, s);

      const text = `${title}\n\n${greeting}\n\n${body}\n\nName: ${customerData.name}\nEmail: ${customerData.email}\nCreated: ${date}\n\n${ftNote}\n\nBest regards, ${vars.repName}`;

      const res = await brevoSend(apiKey, customerData.email, customerData.name, subject, html, text, "customer_welcome_email");
      console.log(`[CustomerEmailService] welcome sent to ${customerData.email}:`, res.messageId);
      return { success: true, messageId: res.messageId };
    } catch (err) {
      console.error("[CustomerEmailService] sendWelcomeEmail:", err.response?.data || err.message);
      return { success: false, error: err.response?.data?.message || err.message };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2. REQUEST CONFIRMATION
  // ─────────────────────────────────────────────────────────────────────────
  async sendRequestConfirmationEmail(requestData, customerData) {
    try {
      const s   = await getSettings();
      const cfg = s.emailNotifications?.requestConfirmation || {};
      if (cfg.enabled === false) return { success: false, reason: "disabled" };

      const apiKey = process.env.BREVO_API_KEY;
      if (!apiKey) return { success: false, reason: "no_api_key" };

      const requestId  = requestData.requestId || "—";
      const requestDate= new Date(requestData.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
      const trackUrl   = `${this.baseUrl}/dashboard/my-requests`;
      const vars       = this._vars(s, { name: customerData.name || "", requestId });

      const title    = interpolate(cfg.title    || "Request Confirmation", vars);
      const subtitle = interpolate(cfg.subtitle || "We have received your order.", vars);
      const greeting = interpolate(cfg.greeting || "Dear {name},", vars);
      const body     = interpolate(cfg.bodyText || "Thank you for submitting your clothing request.", vars);
      const btnText  = interpolate(cfg.buttonText || "Track Your Request", vars);
      const ftNote   = interpolate(cfg.footerNote || "", vars);
      const subject  = interpolate(cfg.subject || `Grav Clothing – Request Confirmation (${requestId})`, vars);

      // Build items rows
      let itemRows = "";
      let totalItems = 0;
      let textItems  = "";
      if (requestData.items && requestData.items.length > 0) {
        requestData.items.forEach((item) => {
          const qty = item.totalQuantity || 0;
          totalItems += qty;
          itemRows += `<tr><td>${item.stockItemName || "—"}</td><td style="font-family:monospace;">${item.stockItemReference || "—"}</td><td style="text-align:center;">${qty}</td></tr>`;
          textItems  += `\n  - ${qty}x ${item.stockItemName || "—"} (${item.stockItemReference || ""})`;
        });
      } else if (requestData.clothCategories) {
        requestData.clothCategories.forEach((cat) => {
          cat.items?.forEach((item) => {
            totalItems += item.quantity || 0;
            itemRows += `<tr><td>${item.quantity}x ${item.color} ${cat.categoryName}</td><td>Size: ${item.size}</td><td style="text-align:center;">${item.quantity}</td></tr>`;
            textItems  += `\n  - ${item.quantity}x ${item.color} ${cat.categoryName} (Size: ${item.size})`;
          });
        });
      }

      const html = layout(title, `
        <p class="subtitle">${subtitle}</p>
        <h1 class="title">${title}</h1>
        <p>${greeting}</p>
        <p style="color:#374151;">${body}</p>
        <div class="info-box">
          ${infoRow("Request ID",    requestId)}
          ${infoRow("Date Submitted",requestDate)}
          ${infoRow("Total Items",   totalItems.toString())}
          ${infoRow("Status",        "Pending Review")}
        </div>
        ${itemRows ? `
        <div class="section-box">
          <h4>Items Requested</h4>
          <table class="items-table">
            <thead><tr><th>Product</th><th>Reference</th><th>Qty</th></tr></thead>
            <tbody>${itemRows}</tbody>
          </table>
        </div>` : ""}
        <div class="section-box">
          <h4>Next Steps</h4>
          <ol class="step-list">
            <li>Our team reviews your request (1–2 business days)</li>
            <li>We will contact you if any clarifications are needed</li>
            <li>Once approved, we will begin working on your order</li>
            <li>You will receive status updates on your dashboard</li>
          </ol>
        </div>
        <p><a href="${trackUrl}" class="btn">${btnText} &rarr;</a></p>
        ${ftNote ? `<div class="box-blue">${ftNote}</div>` : ""}
        <p style="font-size:13px;margin-top:20px;">Best regards,<br><strong>${vars.repName}</strong><br>${s.companyName || "Grav Clothing"}</p>
      `, s);

      const text = `${title}\n\n${greeting}\n\n${body}\n\nRequest ID: ${requestId}\nDate: ${requestDate}\nItems: ${totalItems}${textItems}\n\n${ftNote}\n\nBest regards, ${vars.repName}`;

      const res = await brevoSend(apiKey, customerData.email, customerData.name, subject, html, text, "request_confirmation_email");
      console.log(`[CustomerEmailService] requestConfirmation sent for ${requestId}:`, res.messageId);
      return { success: true, messageId: res.messageId };
    } catch (err) {
      console.error("[CustomerEmailService] sendRequestConfirmationEmail:", err.response?.data || err.message);
      return { success: false, error: err.response?.data?.message || err.message };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3. EDIT REQUEST NOTIFICATION (customer approval required)
  // ─────────────────────────────────────────────────────────────────────────
  async sendEditRequestNotificationEmail(requestData, editRequestData, customerData) {
    try {
      const s   = await getSettings();
      const cfg = s.emailNotifications?.editRequestNotification || {};
      if (cfg.enabled === false) return { success: false, reason: "disabled" };

      const apiKey = process.env.BREVO_API_KEY;
      if (!apiKey) return { success: false, reason: "no_api_key" };

      const requestId     = requestData.requestId || "—";
      const editUrl       = `${this.baseUrl}/approval-request-for-edit-functionality/${editRequestData._id}`;
      const editDate      = new Date(editRequestData.requestedAt || editRequestData.createdAt).toLocaleString("en-IN", {
        day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
      });
      const vars = this._vars(s, { name: customerData.name || "", requestId });

      const title    = interpolate(cfg.title    || "Edit Request — Your Approval is Required", vars);
      const subtitle = interpolate(cfg.subtitle || "Proposed changes to your order require your approval.", vars);
      const greeting = interpolate(cfg.greeting || "Dear {name},", vars);
      const body     = interpolate(cfg.bodyText || "Our sales team has initiated an edit request for your order.", vars);
      const btnText  = interpolate(cfg.buttonText || "Review & Respond to Edit Request", vars);
      const secNote  = interpolate(cfg.securityNote || "Please respond within 24 hours to avoid delays.", vars);
      const ftNote   = interpolate(cfg.footerNote || "", vars);
      const subject  = interpolate(cfg.subject || `Action Required: Edit Request for Order ${requestId} – Grav Clothing`, vars);

      // Build changes rows
      let changeRows = "";
      let textChanges = "";
      if (editRequestData.changes && editRequestData.changes.length > 0) {
        editRequestData.changes.forEach((c) => {
          changeRows  += `<tr><td style="font-weight:600;">${c.field}</td><td style="color:#dc2626;">${c.oldValue ?? "—"}</td><td style="color:#16a34a;">${c.newValue ?? "—"}</td></tr>`;
          textChanges += `\n  - ${c.field}: "${c.oldValue}" → "${c.newValue}"`;
        });
      }

      const html = layout(title, `
        <p class="subtitle">${subtitle}</p>
        <h1 class="title">${title}</h1>
        <div class="box-amber"><strong>⚠ Action Required:</strong> Please review the proposed changes below and respond within 24 hours to avoid delays in your order.</div>
        <p>${greeting}</p>
        <p style="color:#374151;">${body}</p>
        <div class="info-box">
          ${infoRow("Order ID",            requestId)}
          ${infoRow("Edit Request Date",   editDate)}
          ${infoRow("Reason for Changes",  editRequestData.reason || "—")}
        </div>
        ${changeRows ? `
        <div class="section-box">
          <h4>Proposed Changes</h4>
          <table class="items-table">
            <thead><tr><th>Field</th><th>Previous Value</th><th>New Value</th></tr></thead>
            <tbody>${changeRows}</tbody>
          </table>
        </div>` : ""}
        <p style="text-align:center;"><a href="${editUrl}" class="btn">${btnText} &rarr;</a></p>
        ${secNote ? `<div class="box-red"><strong>Important:</strong> ${secNote}</div>` : ""}
        <div class="section-box">
          <h4>Important Notes</h4>
          <ul style="margin:0;padding-left:20px;font-size:13px;color:#374151;">
            <li>Please review all changes carefully before approving</li>
            <li>Once approved, the changes will be applied to your order</li>
            <li>If rejected, your original order details will remain unchanged</li>
            <li>If no action is taken within 24 hours, the edit request may expire</li>
          </ul>
        </div>
        ${ftNote ? `<p style="font-size:13px;color:#64748b;">${ftNote}</p>` : ""}
        <p style="font-size:13px;margin-top:20px;">Best regards,<br><strong>${vars.repName}</strong><br>${s.companyName || "Grav Clothing"} — Sales Department</p>
      `, s);

      const text = `${title}\n\n${greeting}\n\n${body}\n\nOrder ID: ${requestId}\nEdit Date: ${editDate}\nReason: ${editRequestData.reason || "—"}${textChanges}\n\nReview here: ${editUrl}\n\n${secNote}\n\nBest regards, ${vars.repName}`;

      const res = await brevoSend(apiKey, customerData.email, customerData.name, subject, html, text, "edit_request_notification_email");
      console.log(`[CustomerEmailService] editRequestNotification sent for ${requestId}:`, res.messageId);
      return { success: true, messageId: res.messageId };
    } catch (err) {
      console.error("[CustomerEmailService] sendEditRequestNotificationEmail:", err.response?.data || err.message);
      return { success: false, error: err.response?.data?.message || err.message };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4. QUOTATION EMAIL
  // ─────────────────────────────────────────────────────────────────────────
  async sendQuotationEmail(requestData, quotationData, salesPerson) {
    try {
      const s   = await getSettings();
      const cfg = s.emailNotifications?.quotationSent || {};
      if (cfg.enabled === false) return { success: false, reason: "disabled" };

      const apiKey = process.env.BREVO_API_KEY;
      if (!apiKey) return { success: false, reason: "no_api_key" };

      const requestId      = requestData.requestId || "—";
      const quotationNumber= quotationData.quotationNumber || `QT-${requestId}`;
      const customerName   = requestData.customerInfo?.name || "Customer";
      const customerEmail  = requestData.customerInfo?.email;
      if (!customerEmail) return { success: false, error: "No customer email" };

      const validUntil = new Date(quotationData.validUntil || Date.now() + 7 * 86400000).toLocaleDateString("en-IN", {
        day: "numeric", month: "long", year: "numeric",
      });
      const quotationUrl = `${this.baseUrl}/dashboard/my-requests`;
      const salesRepName = salesPerson?.name || salesPerson?.email || s.repName || "Sales Team";
      const vars = this._vars(s, { name: customerName, requestId, quotationNumber });

      const title    = interpolate(cfg.title    || "Your Quotation is Ready", vars);
      const subtitle = interpolate(cfg.subtitle || "Please review and approve at the earliest.", vars);
      const greeting = interpolate(cfg.greeting || "Dear {name},", vars);
      const body     = interpolate(cfg.bodyText || "We are pleased to present you with a quotation for your custom clothing request.", vars);
      const btnText  = interpolate(cfg.buttonText || "Review & Approve Quotation", vars);
      const ftNote   = interpolate(cfg.footerNote || "", vars);
      const subject  = interpolate(cfg.subject || `Grav Clothing – Quotation ${quotationNumber} for Request ${requestId}`, vars);

      // Build items rows
      let itemRows = "";
      let textItems = "";
      if (quotationData.items && quotationData.items.length > 0) {
        quotationData.items.forEach((item, i) => {
          const unitPrice   = item.unitPrice?.toFixed(2) || "0.00";
          const totalWithGST= item.priceIncludingGST?.toFixed(2) || "0.00";
          const discount    = item.discountPercentage > 0 ? `${item.discountPercentage}% off` : "—";
          itemRows  += `<tr><td>${item.itemName || item.description || "—"}</td><td style="font-family:monospace;">${item.itemCode || "—"}</td><td style="text-align:center;">${item.quantity}</td><td style="text-align:right;">₹${unitPrice}</td><td style="text-align:right;">${discount}</td><td style="text-align:right;font-weight:600;">₹${totalWithGST}</td></tr>`;
          textItems += `\n  ${i + 1}. ${item.quantity} x ${item.itemName || item.description || "—"} — ₹${totalWithGST}${item.discountPercentage > 0 ? ` (${item.discountPercentage}% discount)` : ""}`;
        });
      }

      // Build charges section
      const charges = [
        ["Subtotal (ex-GST)", `₹${quotationData.subtotalBeforeGST?.toFixed(2) || "0.00"}`],
        ["Total GST",         `₹${quotationData.totalGST?.toFixed(2) || "0.00"}`],
        ...(quotationData.shippingCharges > 0 ? [["Shipping Charges", `₹${quotationData.shippingCharges?.toFixed(2)}`]] : []),
        ...((quotationData.customAdditionalCharges || []).map((c) => [c.name, `₹${c.amount?.toFixed(2) || "0.00"}`])),
      ];

      const chargeRows = charges.map(([l, v]) =>
        `<div class="payment-row"><div class="payment-cell" style="color:#64748b;">${l}</div><div class="payment-cell" style="text-align:right;font-weight:600;">${v}</div></div>`
      ).join("");

      let textCharges = charges.map(([l, v]) => `  ${l}: ${v}`).join("\n");

      // Build payment schedule rows
      let payRows = "";
      let textPay  = "";
      if (quotationData.paymentSchedule && quotationData.paymentSchedule.length > 0) {
        quotationData.paymentSchedule.forEach((p) => {
          const dueDate = p.dueDate ? new Date(p.dueDate).toLocaleDateString("en-IN") : "—";
          payRows += `<div class="payment-row"><div class="payment-cell" style="font-weight:600;">Step ${p.stepNumber}: ${p.name || "Payment"}</div><div class="payment-cell" style="text-align:center;color:#64748b;">${p.percentage}%</div><div class="payment-cell" style="text-align:right;font-weight:600;">₹${p.amount?.toFixed(2) || "0.00"}</div><div class="payment-cell" style="text-align:right;color:#64748b;">Due: ${dueDate}</div></div>`;
          textPay  += `\n  Step ${p.stepNumber}: ₹${p.amount?.toFixed(2) || "0.00"} (${p.percentage}%) — Due: ${dueDate}`;
        });
      }

      const grandTotal = quotationData.grandTotal?.toFixed(2) || "0.00";

      const html = layout(title, `
        <p class="subtitle">${subtitle}</p>
        <h1 class="title">${title}</h1>
        <p>${greeting}</p>
        <p style="color:#374151;">${body}</p>
        <div class="info-box">
          ${infoRow("Request ID",       requestId)}
          ${infoRow("Quotation Number", quotationNumber)}
          ${infoRow("Prepared By",      salesRepName)}
          ${infoRow("Valid Until",      validUntil)}
        </div>
        ${itemRows ? `
        <div class="section-box">
          <h4>Items Included</h4>
          <table class="items-table">
            <thead><tr><th>Product</th><th>Code</th><th>Qty</th><th style="text-align:right">Unit Price</th><th>Discount</th><th style="text-align:right">Total (inc. GST)</th></tr></thead>
            <tbody>${itemRows}</tbody>
          </table>
        </div>` : ""}
        <div class="section-box">
          <h4>Charges Breakdown</h4>
          ${chargeRows}
        </div>
        <div class="total-row">Grand Total: ₹${grandTotal}</div>
        ${payRows ? `
        <div class="section-box">
          <h4>Payment Schedule</h4>
          ${payRows}
        </div>` : ""}
        <p style="text-align:center;"><a href="${quotationUrl}" class="btn">${btnText} &rarr;</a></p>
        <div class="section-box">
          <h4>Next Steps</h4>
          <ol class="step-list">
            <li>Review the quotation details carefully</li>
            <li>Approve the quotation online if everything looks correct</li>
            <li>Contact our sales team for any questions or modifications</li>
            <li>Once approved, our team will proceed with production</li>
          </ol>
        </div>
        ${ftNote ? `<div class="box-blue">${ftNote}</div>` : ""}
        <p style="font-size:13px;margin-top:20px;">Best regards,<br><strong>${salesRepName}</strong><br>${s.companyName || "Grav Clothing"} — Sales Department</p>
      `, s);

      const text = `${title}\n\n${greeting}\n\n${body}\n\nRequest ID: ${requestId}\nQuotation: ${quotationNumber}\nPrepared By: ${salesRepName}\nValid Until: ${validUntil}\n\nItems:${textItems}\n\nCharges:\n${textCharges}\n  Grand Total: ₹${grandTotal}${textPay ? `\n\nPayment Schedule:${textPay}` : ""}\n\nApprove here: ${quotationUrl}\n\n${ftNote}\n\nBest regards, ${salesRepName}`;

      const res = await brevoSend(apiKey, customerEmail, customerName, subject, html, text, "quotation_email");
      console.log(`[CustomerEmailService] quotation sent for ${quotationNumber}:`, res.messageId);
      return { success: true, messageId: res.messageId };
    } catch (err) {
      console.error("[CustomerEmailService] sendQuotationEmail:", err.response?.data || err.message);
      return { success: false, error: err.response?.data?.message || err.message };
    }
  }

  // ── Stubs (future implementation) ────────────────────────────────────────
  async sendOrderConfirmationEmail(orderData)       { return { success: true }; }
  async sendMeasurementReminderEmail(customerData)  { return { success: true }; }
}

module.exports = new CustomerEmailService();