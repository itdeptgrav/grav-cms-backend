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
const SENDER = { name: "Grav Clothing", email: "biswalpramod3.1415@gmail.com" };

// ── Settings cache (5-minute TTL) ────────────────────────────────────────────
let _cachedSettings = null;
let _cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

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
  const company = settings.companyName || "Grav Clothing";
  const address = settings.companyAddress || "Mayfair Lagoon Campus, Est. 2024";
  const support = settings.supportEmail || "support@grav.in";
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
    this.baseUrl = process.env.WEBSITE_URL || "https://grav.in";
  }

  // ── Shared vars builder ───────────────────────────────────────────────────
  _vars(settings, extra = {}) {
    return {
      repName: settings.repName || "Sales Team",
      repPhone: settings.repPhone || "+91 96920 90096",
      salesEmail: settings.salesEmail || "sales@grav.in",
      supportEmail: settings.supportEmail || "support@grav.in",
      ...extra,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 1. WELCOME (self-registration)
  // ─────────────────────────────────────────────────────────────────────────
  async sendWelcomeEmail(customerData) {
    try {
      const s = await getSettings();
      const cfg = s.emailNotifications?.customerWelcome || {};
      if (cfg.enabled === false) return { success: false, reason: "disabled" };

      const apiKey = process.env.BREVO_API_KEY;
      if (!apiKey) return { success: false, reason: "no_api_key" };

      const vars = this._vars(s, { name: customerData.name || "" });
      const dashUrl = `${this.baseUrl}/dashboard`;
      const date = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });

      const title = interpolate(cfg.title || "Welcome to Grav Clothing", vars);
      const subtitle = interpolate(cfg.subtitle || "Your account has been created.", vars);
      const greeting = interpolate(cfg.greeting || "Dear {name},", vars);
      const body = interpolate(cfg.bodyText || "Thank you for creating an account with Grav Clothing.", vars);
      const btnText = interpolate(cfg.buttonText || "Access Your Dashboard", vars);
      const ftNote = interpolate(cfg.footerNote || "", vars);
      const subject = interpolate(cfg.subject || "Welcome to Grav Clothing – Your Account is Ready", vars);

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
      const s = await getSettings();
      const cfg = s.emailNotifications?.requestConfirmation || {};
      if (cfg.enabled === false) return { success: false, reason: "disabled" };

      const apiKey = process.env.BREVO_API_KEY;
      if (!apiKey) return { success: false, reason: "no_api_key" };

      const requestId = requestData.requestId || "—";
      const requestDate = new Date(requestData.createdAt).toLocaleDateString("en-IN", {
        day: "numeric", month: "long", year: "numeric",
      });
      const trackUrl = `${this.baseUrl}/dashboard/my-requests`;
      const vars = this._vars(s, { name: customerData.name || "", requestId });

      const title = interpolate(cfg.title || "Request Confirmation", vars);
      const subtitle = interpolate(cfg.subtitle || "We have received your order.", vars);
      const greeting = interpolate(cfg.greeting || "Dear {name},", vars);
      const body = interpolate(cfg.bodyText || "Thank you for submitting your clothing request.", vars);
      const btnText = interpolate(cfg.buttonText || "Track Your Request", vars);
      const ftNote = interpolate(cfg.footerNote || "", vars);
      const subject = interpolate(cfg.subject || `Grav Clothing – Request Confirmation (${requestId})`, vars);

      // ── Build items rows ──────────────────────────────────────────────────
      let itemRows = "";
      let totalItems = 0;
      let textItems = "";

      if (requestData.items && requestData.items.length > 0) {

        requestData.items.forEach((item) => {
          const productName = item.stockItemName || "—";
          const productRef = item.stockItemReference || "";
          const qty = item.totalQuantity || 0;
          totalItems += qty;

          // ── Product image ───────────────────────────────────────────────
          const imgUrl = (item.stockItemImages || [])[0] || null;
          const imgHtml = imgUrl
            ? `<img src="${imgUrl}" width="56" height="56" ` +
            `style="width:56px;height:56px;object-fit:cover;border-radius:4px;` +
            `border:1px solid #e2e8f0;display:block;" />`
            : "";

          // ── Product name cell (image + name + reference) ────────────────
          const productCell = imgUrl
            ? `<table border="0" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">` +
            `<tr>` +
            `<td style="vertical-align:top;padding-right:10px;">${imgHtml}</td>` +
            `<td style="vertical-align:middle;">` +
            `<div style="font-weight:700;font-size:13px;color:#0f172a;">${productName}</div>` +
            (productRef
              ? `<div style="font-size:11px;color:#94a3b8;font-family:monospace;margin-top:2px;">${productRef}</div>`
              : "") +
            `</td></tr></table>`
            : `<div style="font-weight:700;font-size:13px;color:#0f172a;">${productName}</div>` +
            (productRef
              ? `<div style="font-size:11px;color:#94a3b8;font-family:monospace;margin-top:2px;">${productRef}</div>`
              : "");

          // ── Variant lines ───────────────────────────────────────────────
          const variants = item.variants || [];
          let variantHtml = "";
          let textVariants = "";

          if (variants.length > 0) {
            variantHtml = variants.map((v) => {
              const attrStr = (v.attributes || [])
                .map(
                  (a) =>
                    `<span style="color:#64748b;">${a.name}:</span>&nbsp;<strong>${a.value}</strong>`
                )
                .join("&nbsp;&nbsp;·&nbsp;&nbsp;");

              const instrStr =
                (v.specialInstructions || []).length > 0
                  ? `<div style="font-size:11px;color:#94a3b8;font-style:italic;margin-top:2px;">` +
                  v.specialInstructions.join(" · ") +
                  `</div>`
                  : "";

              return (
                `<div style="margin-bottom:5px;padding-bottom:5px;border-bottom:1px dashed #f1f5f9;">` +
                `<span style="font-size:12px;">${attrStr || "Default"}</span>` +
                `<span style="font-size:12px;color:#374151;margin-left:10px;font-weight:600;">` +
                `${v.quantity} pcs</span>` +
                instrStr +
                `</div>`
              );
            }).join("");

            textVariants = variants
              .map((v) => {
                const attrs = (v.attributes || [])
                  .map((a) => `${a.name}: ${a.value}`)
                  .join(", ");
                return `      · ${attrs || "Default"} — ${v.quantity} pcs`;
              })
              .join("\n");
          } else {
            variantHtml = `<span style="font-size:12px;color:#94a3b8;">—</span>`;
          }

          // ── Table row ───────────────────────────────────────────────────
          itemRows +=
            `<tr>` +
            `<td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;vertical-align:top;">${productCell}</td>` +
            `<td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;vertical-align:top;">${variantHtml}</td>` +
            `<td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;text-align:center;vertical-align:top;` +
            `font-weight:700;font-size:14px;color:#0f172a;">${qty}</td>` +
            `</tr>`;

          // ── Plain-text ──────────────────────────────────────────────────
          textItems += `\n  - ${qty}x ${productName}${productRef ? ` (${productRef})` : ""}`;
          if (textVariants) textItems += `\n${textVariants}`;
        });

      } else if (requestData.clothCategories) {
        // Legacy clothCategories format fallback
        requestData.clothCategories.forEach((cat) => {
          cat.items?.forEach((item) => {
            totalItems += item.quantity || 0;
            itemRows +=
              `<tr>` +
              `<td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;vertical-align:top;">` +
              `<div style="font-weight:700;font-size:13px;color:#0f172a;">${cat.categoryName}</div>` +
              `<div style="font-size:11px;color:#94a3b8;">${item.color}</div></td>` +
              `<td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;vertical-align:top;">` +
              `<span style="font-size:12px;color:#374151;">Size: ${item.size}</span></td>` +
              `<td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;text-align:center;` +
              `font-weight:700;font-size:14px;color:#0f172a;">${item.quantity}</td>` +
              `</tr>`;
            textItems += `\n  - ${item.quantity}x ${item.color} ${cat.categoryName} (Size: ${item.size})`;
          });
        });
      }

      // ── Compose HTML ──────────────────────────────────────────────────────
      const html = layout(title, `
        <p class="subtitle">${subtitle}</p>
        <h1 class="title">${title}</h1>
        <p>${greeting}</p>
        <p style="color:#374151;">${body}</p>
 
        <div class="info-box">
          ${infoRow("Request ID", requestId)}
          ${infoRow("Date Submitted", requestDate)}
          ${infoRow("Total Items", totalItems.toString())}
          ${infoRow("Status", "Pending Review")}
        </div>
 
        ${itemRows ? `
        <div class="section-box">
          <h4>Items Requested</h4>
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead>
              <tr style="background:#f1f5f9;">
                <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:700;color:#64748b;
                    text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid #e2e8f0;">
                  Product
                </th>
                <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:700;color:#64748b;
                    text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid #e2e8f0;">
                  Variants &amp; Specifications
                </th>
                <th style="padding:8px 12px;text-align:center;font-size:11px;font-weight:700;color:#64748b;
                    text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid #e2e8f0;">
                  Total Qty
                </th>
              </tr>
            </thead>
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
        <p style="font-size:13px;margin-top:20px;">Best regards,<br>
        <strong>${vars.repName}</strong><br>${s.companyName || "Grav Clothing"}</p>
      `, s);

      const text =
        `${title}\n\n${greeting}\n\n${body}\n\n` +
        `Request ID: ${requestId}\nDate: ${requestDate}\nItems: ${totalItems}` +
        `${textItems}\n\n${ftNote}\n\nBest regards, ${vars.repName}`;

      const res = await brevoSend(
        apiKey, customerData.email, customerData.name,
        subject, html, text, "request_confirmation_email"
      );
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
      const s = await getSettings();
      const cfg = s.emailNotifications?.editRequestNotification || {};
      if (cfg.enabled === false) return { success: false, reason: "disabled" };

      const apiKey = process.env.BREVO_API_KEY;
      if (!apiKey) return { success: false, reason: "no_api_key" };

      const requestId = requestData.requestId || "—";
      const editUrl = `${this.baseUrl}/approval-request-for-edit-functionality/${editRequestData._id}`;
      const editDate = new Date(editRequestData.requestedAt || editRequestData.createdAt).toLocaleString("en-IN", {
        day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
      });
      const vars = this._vars(s, { name: customerData.name || "", requestId });

      const title = interpolate(cfg.title || "Edit Request — Your Approval is Required", vars);
      const subtitle = interpolate(cfg.subtitle || "Proposed changes to your order require your approval.", vars);
      const greeting = interpolate(cfg.greeting || "Dear {name},", vars);
      const body = interpolate(cfg.bodyText || "Our sales team has initiated an edit request for your order.", vars);
      const btnText = interpolate(cfg.buttonText || "Review & Respond to Edit Request", vars);
      const secNote = interpolate(cfg.securityNote || "Please respond within 24 hours to avoid delays.", vars);
      const ftNote = interpolate(cfg.footerNote || "", vars);
      const subject = interpolate(cfg.subject || `Action Required: Edit Request for Order ${requestId} – Grav Clothing`, vars);

      // Build changes rows
      let changeRows = "";
      let textChanges = "";
      if (editRequestData.changes && editRequestData.changes.length > 0) {
        editRequestData.changes.forEach((c) => {
          changeRows += `<tr><td style="font-weight:600;">${c.field}</td><td style="color:#dc2626;">${c.oldValue ?? "—"}</td><td style="color:#16a34a;">${c.newValue ?? "—"}</td></tr>`;
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
          ${infoRow("Order ID", requestId)}
          ${infoRow("Edit Request Date", editDate)}
          ${infoRow("Reason for Changes", editRequestData.reason || "—")}
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
      const s = await getSettings();
      const cfg = s.emailNotifications?.quotationSent || {};
      if (cfg.enabled === false) return { success: false, reason: "disabled" };

      const apiKey = process.env.BREVO_API_KEY;
      if (!apiKey) return { success: false, reason: "no_api_key" };

      const requestId = requestData.requestId || "—";
      const quotationNumber = quotationData.quotationNumber || `QT-${requestId}`;
      const customerName = requestData.customerInfo?.name || "Customer";
      const customerEmail = requestData.customerInfo?.email;
      if (!customerEmail) return { success: false, error: "No customer email" };

      const validUntil = new Date(quotationData.validUntil || Date.now() + 7 * 86400000).toLocaleDateString("en-IN", {
        day: "numeric", month: "long", year: "numeric",
      });
      const quotationUrl = `${this.baseUrl}/dashboard/my-requests`;
      const salesRepName = salesPerson?.name || salesPerson?.email || s.repName || "Sales Team";
      const vars = this._vars(s, { name: customerName, requestId, quotationNumber });

      const title = interpolate(cfg.title || "Your Quotation is Ready", vars);
      const subtitle = interpolate(cfg.subtitle || "Please review and approve at the earliest.", vars);
      const greeting = interpolate(cfg.greeting || "Dear {name},", vars);
      const body = interpolate(cfg.bodyText || "We are pleased to present you with a quotation for your custom clothing request.", vars);
      const btnText = interpolate(cfg.buttonText || "Review & Approve Quotation", vars);
      const ftNote = interpolate(cfg.footerNote || "", vars);
      const subject = interpolate(cfg.subject || `Grav Clothing – Quotation ${quotationNumber} for Request ${requestId}`, vars);

      // Build items rows — with product images, variant column, conditional discount
      let itemRows = "";
      let textItems = "";
      let hasDiscount = false;
      let stockItemMap = new Map();

      if (quotationData.items && quotationData.items.length > 0) {

        // ── Check if any item carries a discount ──────────────────────────
        hasDiscount = quotationData.items.some(item => (item.discountPercentage || 0) > 0);

        // ── Batch-fetch StockItems to retrieve variant images ─────────────
        try {
          const StockItem = require("../models/CMS_Models/Inventory/Products/StockItem");
          const mongoose = require("mongoose");
          const stockIds = [
            ...new Set(
              quotationData.items
                .map(i => i.stockItemId?.toString())
                .filter(Boolean)
            ),
          ];
          if (stockIds.length > 0) {
            const docs = await StockItem.find({
              _id: { $in: stockIds.map(id => new mongoose.Types.ObjectId(id)) },
            })
              .select("_id variants images")
              .lean();
            stockItemMap = new Map(docs.map(d => [d._id.toString(), d]));
          }
        } catch (fetchErr) {
          console.warn("[CustomerEmailService] Could not fetch stock images:", fetchErr.message);
        }

        // ── Build one row per quotation item ──────────────────────────────
        quotationData.items.forEach((item, i) => {
          const unitPrice = item.unitPrice?.toFixed(2) || "0.00";
          const totalWithGST = item.priceIncludingGST?.toFixed(2) || "0.00";
          const discountText = item.discountPercentage > 0
            ? `<span style="color:#16a34a;font-weight:600;">${item.discountPercentage}% off</span>`
            : `<span style="color:#94a3b8;">—</span>`;

          // ── Variant attributes ──────────────────────────────────────────
          const variantHtml = (item.attributes || []).length > 0
            ? item.attributes
              .map(a =>
                `<span style="display:block;font-size:11px;line-height:1.5;color:#374151;">` +
                `<span style="color:#94a3b8;">${a.name}:</span>&nbsp;${a.value}</span>`
              )
              .join("")
            : `<span style="font-size:11px;color:#94a3b8;">—</span>`;

          // ── Variant image (match by attributes, fallback to first image) ─
          let imgHtml = "";
          const si = stockItemMap.get(item.stockItemId?.toString());
          if (si) {
            let imgUrl = null;

            // 1. Try to match variant by attributes
            if (item.attributes && item.attributes.length > 0) {
              const norm = s => String(s || "").trim().toLowerCase();
              const matched = (si.variants || []).find(v =>
                item.attributes.every(ia =>
                  (v.attributes || []).some(
                    va => norm(va.name) === norm(ia.name) && norm(va.value) === norm(ia.value)
                  )
                )
              );
              if (matched?.images?.[0]) imgUrl = matched.images[0];
            }

            // 2. Fallback: first variant image
            if (!imgUrl) {
              for (const v of si.variants || []) {
                if (v.images?.[0]) { imgUrl = v.images[0]; break; }
              }
            }

            // 3. Fallback: stock item root images
            if (!imgUrl && Array.isArray(si.images) && si.images[0]) {
              imgUrl = si.images[0];
            }

            if (imgUrl) {
              imgHtml =
                `<img src="${imgUrl}" width="52" height="52" ` +
                `style="width:52px;height:52px;object-fit:cover;border-radius:4px;` +
                `border:1px solid #e2e8f0;display:block;" />`;
            }
          }

          // ── Product cell (image + name + code) — table-based for Outlook ─
          const productCell =
            `<table border="0" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">` +
            `<tr>` +
            (imgHtml
              ? `<td style="vertical-align:top;padding-right:10px;">${imgHtml}</td>`
              : "") +
            `<td style="vertical-align:middle;">` +
            `<div style="font-weight:700;font-size:13px;color:#0f172a;">${item.itemName || item.description || "—"}</div>` +
            (item.itemCode
              ? `<div style="font-size:11px;color:#94a3b8;font-family:monospace;margin-top:2px;">${item.itemCode}</div>`
              : "") +
            `</td></tr></table>`;

          // ── Row HTML ────────────────────────────────────────────────────
          itemRows +=
            `<tr>` +
            `<td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;vertical-align:middle;">${productCell}</td>` +
            `<td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;vertical-align:middle;">${variantHtml}</td>` +
            `<td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;text-align:center;vertical-align:middle;font-weight:600;color:#0f172a;">${item.quantity}</td>` +
            `<td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;text-align:right;vertical-align:middle;color:#374151;">₹${unitPrice}</td>` +
            (hasDiscount
              ? `<td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;text-align:right;vertical-align:middle;">${discountText}</td>`
              : "") +
            `<td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;text-align:right;vertical-align:middle;font-weight:700;color:#0f172a;">₹${totalWithGST}</td>` +
            `</tr>`;

          // ── Plain-text summary ──────────────────────────────────────────
          textItems += `\n  ${i + 1}. ${item.quantity} x ${item.itemName || item.description || "—"}`;
          if (item.attributes?.length) {
            textItems += ` (${item.attributes.map(a => `${a.name}: ${a.value}`).join(", ")})`;
          }
          textItems += ` — ₹${totalWithGST}`;
          if (item.discountPercentage > 0) textItems += ` (${item.discountPercentage}% discount)`;
        });
      }

      // Build charges section
      const charges = [
        ["Subtotal (ex-GST)", `₹${quotationData.subtotalBeforeGST?.toFixed(2) || "0.00"}`],
        ["Total GST", `₹${quotationData.totalGST?.toFixed(2) || "0.00"}`],
        ...(quotationData.shippingCharges > 0 ? [["Shipping Charges", `₹${quotationData.shippingCharges?.toFixed(2)}`]] : []),
        ...((quotationData.customAdditionalCharges || []).map((c) => [c.name, `₹${c.amount?.toFixed(2) || "0.00"}`])),
      ];

      const chargeRows = charges.map(([l, v]) =>
        `<div class="payment-row"><div class="payment-cell" style="color:#64748b;">${l}</div><div class="payment-cell" style="text-align:right;font-weight:600;">${v}</div></div>`
      ).join("");

      let textCharges = charges.map(([l, v]) => `  ${l}: ${v}`).join("\n");

      // Build payment schedule rows
      let payRows = "";
      let textPay = "";
      if (quotationData.paymentSchedule && quotationData.paymentSchedule.length > 0) {
        quotationData.paymentSchedule.forEach((p) => {
          const dueDate = p.dueDate ? new Date(p.dueDate).toLocaleDateString("en-IN") : "—";
          payRows += `<div class="payment-row"><div class="payment-cell" style="font-weight:600;">Step ${p.stepNumber}: ${p.name || "Payment"}</div><div class="payment-cell" style="text-align:center;color:#64748b;">${p.percentage}%</div><div class="payment-cell" style="text-align:right;font-weight:600;">₹${p.amount?.toFixed(2) || "0.00"}</div><div class="payment-cell" style="text-align:right;color:#64748b;">Due: ${dueDate}</div></div>`;
          textPay += `\n  Step ${p.stepNumber}: ₹${p.amount?.toFixed(2) || "0.00"} (${p.percentage}%) — Due: ${dueDate}`;
        });
      }

      const grandTotal = quotationData.grandTotal?.toFixed(2) || "0.00";

      const html = layout(title, `
        <p class="subtitle">${subtitle}</p>
        <h1 class="title">${title}</h1>
        <p>${greeting}</p>
        <p style="color:#374151;">${body}</p>
        <div class="info-box">
          ${infoRow("Request ID", requestId)}
          ${infoRow("Quotation Number", quotationNumber)}
          ${infoRow("Prepared By", salesRepName)}
          ${infoRow("Valid Until", validUntil)}
        </div>
        ${itemRows ? `
        <div class="section-box">
          <h4>Items Included</h4>
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead>
              <tr style="background:#f1f5f9;">
                <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid #e2e8f0;">
                  Product
                </th>
                <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid #e2e8f0;">
                  Variant
                </th>
                <th style="padding:8px 12px;text-align:center;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid #e2e8f0;">
                  Qty
                </th>
                <th style="padding:8px 12px;text-align:right;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid #e2e8f0;">
                  Unit Price
                </th>
                ${hasDiscount ? `
                <th style="padding:8px 12px;text-align:right;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid #e2e8f0;">
                  Discount
                </th>` : ""}
                <th style="padding:8px 12px;text-align:right;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid #e2e8f0;">
                  Total (inc. GST)
                </th>
              </tr>
            </thead>
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

  // ─────────────────────────────────────────────────────────────────────────
  // 5. PAYMENT RECORDED NOTIFICATION
  //    Sent to customer after sales records a payment (on-behalf or manual).
  //    isOnBehalf=true  → payment was made by sales rep on customer's behalf
  //    isOnBehalf=false → regular payment recorded by sales after receiving it
  // ─────────────────────────────────────────────────────────────────────────
  async sendPaymentRecordedEmail(request, quotation, submission, isOnBehalf = false) {
    try {
      const s = await getSettings();
      const cfg = s.emailNotifications?.paymentRecorded || {};
      // enabled defaults to true unless explicitly set to false in settings
      if (cfg.enabled === false) return { success: false, reason: "disabled" };

      const apiKey = process.env.BREVO_API_KEY;
      if (!apiKey) return { success: false, reason: "no_api_key" };

      const customerName = request.customerInfo?.name || "Customer";
      const customerEmail = request.customerInfo?.email;
      if (!customerEmail) return { success: false, error: "No customer email" };

      const requestId = request.requestId || "—";
      const vars = this._vars(s, { name: customerName, requestId });
      const dashUrl = `${this.baseUrl}/dashboard/my-requests`;

      // ── Financials ───────────────────────────────────────────────────────
      const totalAmount = quotation.grandTotal || 0;
      const totalPaid = request.totalPaidAmount || 0;
      const remaining = Math.max(0, totalAmount - totalPaid);
      const paidPct = totalAmount > 0 ? Math.round((totalPaid / totalAmount) * 100) : 0;

      const fmtAmt = (v) =>
        `₹${Number(v || 0).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

      // ── Step info ────────────────────────────────────────────────────────
      const step = (quotation.paymentSchedule || []).find(
        (p) => p.stepNumber === submission.paymentStepNumber
      );
      const stepName = step
        ? `Step ${step.stepNumber} — ${step.name} (${step.percentage}%)`
        : `Step ${submission.paymentStepNumber}`;

      const paymentDate = new Date(
        submission.submissionDate || new Date()
      ).toLocaleDateString("en-IN", {
        day: "numeric", month: "long", year: "numeric",
      });

      const methodLabel = (submission.paymentMethod || "")
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());

      // ── Payment schedule rows ────────────────────────────────────────────
      const scheduleRows = (quotation.paymentSchedule || [])
        .map((p) => {
          const isPaid = p.status === "paid";
          const isPartial = p.status === "partially_paid";
          const isCurrent = p.stepNumber === submission.paymentStepNumber;
          const statusLabel = isPaid ? "✓ Paid" : isPartial ? "Partial" : "Pending";
          const statusColor = isPaid ? "#16a34a" : isPartial ? "#d97706" : "#64748b";
          const rowBg = isCurrent ? "#f0fdf4" : "#fff";
          return `<tr style="background:${rowBg};">
            <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#374151;">
              ${isCurrent ? `<strong>Step ${p.stepNumber} — ${p.name}</strong>` : `Step ${p.stepNumber} — ${p.name}`}
              <span style="font-size:11px;color:#64748b;"> · ${p.percentage}%</span>
            </td>
            <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;text-align:right;font-size:13px;color:#374151;">${fmtAmt(p.amount)}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;text-align:right;font-size:13px;color:#16a34a;">${(p.paidAmount || 0) > 0 ? fmtAmt(p.paidAmount) : "—"}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;text-align:center;font-size:11px;font-weight:700;color:${statusColor};">${statusLabel}</td>
          </tr>`;
        })
        .join("");

      // ── Email content ────────────────────────────────────────────────────
      const subject = `Payment Confirmation — ${fmtAmt(submission.submittedAmount)} received for Order ${requestId}`;
      const title = cfg.title || "Payment Confirmation";

      const openingLine = isOnBehalf
        ? `A payment of <strong>${fmtAmt(submission.submittedAmount)}</strong> has been recorded by our sales representative on your behalf for your order with Grav Clothing. The details are provided below for your records.`
        : `We have received your payment of <strong>${fmtAmt(submission.submittedAmount)}</strong> for your order with Grav Clothing. The details are provided below for your confirmation.`;

      const onBehalfNote = isOnBehalf
        ? `<div class="box-amber" style="margin-top:16px;"><strong>Note:</strong> This payment was recorded by our sales representative on your behalf as per mutual confirmation. Please contact us immediately at <a href="mailto:${vars.salesEmail}" style="color:#92400e;">${vars.salesEmail}</a> or call ${vars.repPhone} if you have any discrepancy.</div>`
        : "";

      const balanceNote = remaining > 0
        ? `<div class="box-amber"><strong>Balance Reminder:</strong> A balance of <strong>${fmtAmt(remaining)}</strong> remains on your order. Please ensure timely payment as per the schedule above to avoid any delays in production and delivery.</div>`
        : `<div class="box-green"><strong>Fully Paid:</strong> Your order has been fully paid. Our team will proceed with production at the earliest. Thank you!</div>`;

      const html = layout(title, `
        <h1 class="title">${title}</h1>
        <p class="subtitle">Order ${requestId}</p>
 
        <p>Dear <strong>${customerName}</strong>,</p>
        <p style="color:#374151;">${openingLine}</p>
 
        <div class="info-box">
          ${infoRow("Request ID", requestId)}
          ${infoRow("Payment Step", stepName)}
          ${infoRow("Amount Received", fmtAmt(submission.submittedAmount))}
          ${infoRow("Payment Method", methodLabel)}
          ${submission.transactionId ? infoRow("Transaction ID", submission.transactionId) : ""}
          ${submission.utrNumber ? infoRow("UTR Number", submission.utrNumber) : ""}
          ${infoRow("Payment Date", paymentDate)}
        </div>
 
        <div class="section-box">
          <h4 style="margin:0 0 12px;font-size:12px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:.5px;">Financial Summary</h4>
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <tr>
              <td style="padding:6px 0;color:#64748b;border-bottom:1px solid #f1f5f9;">Total Order Value</td>
              <td style="padding:6px 0;text-align:right;font-weight:600;color:#0f172a;border-bottom:1px solid #f1f5f9;">${fmtAmt(totalAmount)}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;color:#64748b;border-bottom:1px solid #f1f5f9;">This Payment</td>
              <td style="padding:6px 0;text-align:right;font-weight:600;color:#16a34a;border-bottom:1px solid #f1f5f9;">+ ${fmtAmt(submission.submittedAmount)}</td>
            </tr>
            <tr>
              <td style="padding:8px 0 4px;color:#0f172a;font-weight:700;">Total Paid So Far</td>
              <td style="padding:8px 0 4px;text-align:right;font-weight:700;font-size:15px;color:#16a34a;">
                ${fmtAmt(totalPaid)}
                <span style="font-size:11px;color:#64748b;font-weight:400;"> (${paidPct}% of total)</span>
              </td>
            </tr>
            <tr>
              <td style="padding:4px 0 0;color:#64748b;">Remaining Balance</td>
              <td style="padding:4px 0 0;text-align:right;font-weight:600;color:${remaining > 0 ? "#d97706" : "#16a34a"};">
                ${fmtAmt(remaining)}
              </td>
            </tr>
          </table>
        </div>
 
        ${scheduleRows ? `
        <div class="section-box">
          <h4 style="margin:0 0 10px;font-size:12px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:.5px;">Payment Schedule</h4>
          <table class="items-table">
            <thead>
              <tr>
                <th style="text-align:left;">Step</th>
                <th style="text-align:right;">Due Amount</th>
                <th style="text-align:right;">Paid</th>
                <th style="text-align:center;">Status</th>
              </tr>
            </thead>
            <tbody>${scheduleRows}</tbody>
          </table>
        </div>` : ""}
 
        ${onBehalfNote}
        ${balanceNote}
 
        <p style="text-align:center;margin-top:20px;">
          <a href="${dashUrl}" class="btn">View Your Order Status &rarr;</a>
        </p>
 
        <p style="font-size:13px;margin-top:24px;">
          For any queries regarding this payment, please contact us at
          <a href="mailto:${vars.salesEmail}" style="color:#1e3a5f;">${vars.salesEmail}</a>
          or call ${vars.repPhone}. Please quote your Order ID <strong>${requestId}</strong> in all communications.
        </p>
 
        <p style="font-size:13px;margin-top:20px;">Best regards,<br>
        <strong>${vars.repName}</strong><br>
        ${s.companyName || "Grav Clothing"} — Sales Department</p>
      `, s);

      const text = `${title} — Order ${requestId}\n\nDear ${customerName},\n\n${isOnBehalf
        ? `A payment of ${fmtAmt(submission.submittedAmount)} has been recorded by our sales team on your behalf.`
        : `We have received your payment of ${fmtAmt(submission.submittedAmount)}.`
        }\n\nStep: ${stepName}\nAmount: ${fmtAmt(submission.submittedAmount)}\nMethod: ${methodLabel}\nDate: ${paymentDate}${submission.transactionId ? `\nTxn ID: ${submission.transactionId}` : ""}${submission.utrNumber ? `\nUTR: ${submission.utrNumber}` : ""}\n\nTotal Paid So Far: ${fmtAmt(totalPaid)} (${paidPct}%)\nRemaining Balance: ${fmtAmt(remaining)}\n\nView your order: ${dashUrl}\n\nBest regards, ${vars.repName}`;

      const res = await brevoSend(apiKey, customerEmail, customerName, subject, html, text, "payment_recorded_email");
      console.log(`[CustomerEmailService] paymentRecorded sent for ${requestId}:`, res.messageId);
      return { success: true, messageId: res.messageId };
    } catch (err) {
      console.error("[CustomerEmailService] sendPaymentRecordedEmail:", err.response?.data || err.message);
      return { success: false, error: err.response?.data?.message || err.message };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 6. SALES APPROVAL — ORDER READY FOR PRODUCTION
  //    Sent to customer after the sales team fully approves the quotation.
  //    Celebratory / milestone email — order is now cleared for production.
  // ─────────────────────────────────────────────────────────────────────────
  async sendSalesApprovalEmail(request, quotation) {
    try {
      const s = await getSettings();
      const cfg = s.emailNotifications?.salesApproval || {};
      if (cfg.enabled === false) return { success: false, reason: "disabled" };

      const apiKey = process.env.BREVO_API_KEY;
      if (!apiKey) return { success: false, reason: "no_api_key" };

      const customerName = request.customerInfo?.name || "Customer";
      const customerEmail = request.customerInfo?.email;
      if (!customerEmail) return { success: false, error: "No customer email" };

      const requestId = request.requestId || "—";
      const quotationNumber = quotation?.quotationNumber || "—";
      const vars = this._vars(s, { name: customerName, requestId });
      const dashUrl = `${this.baseUrl}/dashboard/my-requests`;

      const approvalDate = new Date(
        quotation?.salesApproval?.approvedAt || new Date()
      ).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });

      const fmtAmt = (v) =>
        `₹${Number(v || 0).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

      // ── Financial summary ─────────────────────────────────────────────────
      const grandTotal = quotation?.grandTotal || 0;
      const totalPaid = request.totalPaidAmount || 0;
      const remaining = Math.max(0, grandTotal - totalPaid);
      const paidPct = grandTotal > 0 ? Math.round((totalPaid / grandTotal) * 100) : 0;

      // ── Delivery deadline ─────────────────────────────────────────────────
      const deliveryDeadline = request.customerInfo?.deliveryDeadline
        ? new Date(request.customerInfo.deliveryDeadline).toLocaleDateString("en-IN", {
          day: "numeric", month: "long", year: "numeric",
        })
        : null;

      // ── Items summary (brief — name + variant + qty) ──────────────────────
      const itemsSummaryRows = (quotation?.items || [])
        .map((item) => {
          const variantStr = (item.attributes || [])
            .map(a => `${a.name}: ${a.value}`)
            .join(" · ");
          return (
            `<tr>` +
            `<td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#0f172a;font-weight:600;">${item.itemName || "—"}</td>` +
            `<td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#64748b;">${variantStr || "—"}</td>` +
            `<td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;text-align:center;font-size:13px;font-weight:700;color:#0f172a;">${item.quantity}</td>` +
            `<td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;text-align:right;font-size:13px;font-weight:600;color:#0f172a;">₹${(item.priceIncludingGST || 0).toFixed(2)}</td>` +
            `</tr>`
          );
        })
        .join("");

      // ── Plain-text items ──────────────────────────────────────────────────
      const textItems = (quotation?.items || [])
        .map((item, i) => {
          const v = (item.attributes || []).map(a => `${a.name}: ${a.value}`).join(", ");
          return `  ${i + 1}. ${item.quantity} x ${item.itemName || "—"}${v ? ` (${v})` : ""} — ₹${(item.priceIncludingGST || 0).toFixed(2)}`;
        })
        .join("\n");

      // ── Payment status box ────────────────────────────────────────────────
      const paymentStatusHtml = remaining > 0
        ? `<div class="box-amber" style="margin-top:16px;">
            <strong>Outstanding Balance:</strong> Your order has been approved with a remaining balance of
            <strong>${fmtAmt(remaining)}</strong>
            (${fmtAmt(totalPaid)} paid — ${paidPct}% of ${fmtAmt(grandTotal)}).
            Please ensure the remaining amount is settled as per the agreed payment schedule to avoid
            any delays in delivery. You can view your payment schedule on the dashboard.
           </div>`
        : `<div class="box-green" style="margin-top:16px;">
            <strong>Fully Paid &amp; Cleared:</strong> Your order has been fully paid.
            Production will begin at the earliest priority. Thank you!
           </div>`;

      // ── Delivery note ─────────────────────────────────────────────────────
      const deliveryNoteHtml = deliveryDeadline
        ? `<div class="box-blue" style="margin-top:16px;">
            <strong>Target Delivery Date:</strong> Based on your requirement, your order is
            scheduled for delivery by <strong>${deliveryDeadline}</strong>. Our production team
            has been briefed on this timeline. We will keep you informed of any updates.
           </div>`
        : "";

      const subject = `Your Order ${requestId} is Approved — Production Begins Now!`;
      const title = cfg.title || "Your Order is Approved!";

      const html = layout(title, `
        <h1 class="title">${title}</h1>
        <p class="subtitle">All approvals complete — production begins</p>
 
        <p>Dear <strong>${customerName}</strong>,</p>
 
        <p style="color:#374151;">
          We are delighted to inform you that your order with <strong>${s.companyName || "Grav Clothing"}</strong>
          has been <strong>fully reviewed and approved</strong> by our sales team. Your order is now
          officially cleared and our production team will begin work on it shortly.
        </p>
 
        <div class="box-green" style="font-size:14px;">
          🎉 <strong>Order Status: Approved &amp; Ready for Production</strong>
          <br />
          <span style="font-size:13px;font-weight:400;">
            Every step has been verified — quotation, customer approval, and sales sign-off.
            Your bespoke clothing is now in safe hands.
          </span>
        </div>
 
        <div class="info-box">
          ${infoRow("Order ID", requestId)}
          ${infoRow("Quotation Number", quotationNumber)}
          ${infoRow("Approved On", approvalDate)}
          ${infoRow("Order Value", fmtAmt(grandTotal))}
        </div>
 
        ${itemsSummaryRows ? `
        <div class="section-box">
          <h4>Your Order Summary</h4>
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead>
              <tr style="background:#f1f5f9;">
                <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;border-bottom:2px solid #e2e8f0;">Product</th>
                <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;border-bottom:2px solid #e2e8f0;">Variant</th>
                <th style="padding:8px 12px;text-align:center;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;border-bottom:2px solid #e2e8f0;">Qty</th>
                <th style="padding:8px 12px;text-align:right;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;border-bottom:2px solid #e2e8f0;">Amount</th>
              </tr>
            </thead>
            <tbody>${itemsSummaryRows}</tbody>
          </table>
        </div>` : ""}
 
        <div class="section-box">
          <h4>What Happens Next</h4>
          <ol class="step-list">
            <li><strong>Production Kickoff</strong> — Our tailoring team reviews your order specifications and raw material requirements.</li>
            <li><strong>Material Preparation</strong> — Fabrics, trims, and accessories are allocated from inventory and prepared for cutting.</li>
            <li><strong>Manufacturing</strong> — Our expert tailors begin crafting your bespoke garments to the exact specifications.</li>
            <li><strong>Quality Inspection</strong> — Each piece undergoes a thorough quality check before leaving our facility.</li>
            <li><strong>Packing &amp; Dispatch</strong> — Your order is carefully packed and dispatched to your delivery address.</li>
          </ol>
        </div>
 
        ${paymentStatusHtml}
        ${deliveryNoteHtml}
 
        <p style="color:#374151;margin-top:20px;">
          You can track the real-time progress of your order at any time from your customer dashboard.
          Our team will proactively keep you updated at each milestone.
        </p>
 
        <p style="text-align:center;margin-top:20px;">
          <a href="${dashUrl}" class="btn">Track Your Order &rarr;</a>
        </p>
 
        <p style="font-size:13px;margin-top:24px;">
          For any queries, please contact us at
          <a href="mailto:${vars.salesEmail}" style="color:#1e3a5f;">${vars.salesEmail}</a>
          or call <strong>${vars.repPhone}</strong>.
          Please quote your Order ID <strong>${requestId}</strong> in all communications.
        </p>
 
        <p style="font-size:13px;margin-top:20px;">
          Thank you for choosing <strong>${s.companyName || "Grav Clothing"}</strong>.
          We look forward to delivering excellence to you.
        </p>
 
        <p style="font-size:13px;margin-top:16px;">
          Warm regards,<br>
          <strong>${vars.repName}</strong><br>
          ${s.companyName || "Grav Clothing"} — Sales Department
        </p>
      `, s);

      const text =
        `${title} — Order ${requestId}\n\n` +
        `Dear ${customerName},\n\n` +
        `Your order with Grav Clothing has been fully approved and is now ready for production.\n\n` +
        `Order ID: ${requestId}\n` +
        `Quotation: ${quotationNumber}\n` +
        `Approved On: ${approvalDate}\n` +
        `Order Value: ${fmtAmt(grandTotal)}\n\n` +
        `Items:\n${textItems}\n\n` +
        `Total Paid: ${fmtAmt(totalPaid)} (${paidPct}%)\n` +
        (remaining > 0 ? `Remaining Balance: ${fmtAmt(remaining)}\n` : "Fully Paid ✓\n") +
        (deliveryDeadline ? `Target Delivery: ${deliveryDeadline}\n` : "") +
        `\nTrack your order: ${dashUrl}\n\n` +
        `Warm regards, ${vars.repName} — ${s.companyName || "Grav Clothing"}`;

      const res = await brevoSend(apiKey, customerEmail, customerName, subject, html, text, "sales_approval_email");
      console.log(`[CustomerEmailService] salesApproval sent for ${requestId}:`, res.messageId);
      return { success: true, messageId: res.messageId };
    } catch (err) {
      console.error("[CustomerEmailService] sendSalesApprovalEmail:", err.response?.data || err.message);
      return { success: false, error: err.response?.data?.message || err.message };
    }
  }

  // ── Stubs (future implementation) ────────────────────────────────────────
  async sendOrderConfirmationEmail(orderData) { return { success: true }; }
  async sendMeasurementReminderEmail(customerData) { return { success: true }; }



}

module.exports = new CustomerEmailService();