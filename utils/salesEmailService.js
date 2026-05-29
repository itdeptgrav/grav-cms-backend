// utils/salesEmailService.js
//
// Sends transactional emails to customers via the Brevo API.
// All email content (subject, title, body, etc.) is now DYNAMIC —
// pulled from the SalesSettings document in MongoDB.
// Falls back to built-in defaults if settings are not found or email type is disabled.
//
// Template variables supported in any text field:
//   {name}         — customer name
//   {supportEmail} — from settings.supportEmail
//   {salesEmail}   — from settings.salesEmail
//   {repPhone}     — from settings.repPhone
//   {repName}      — from settings.repName
//   {portalUrl}    — from settings.portalUrl

const axios = require("axios");

const BREVO_BASE = "https://api.brevo.com/v3";
const SENDER = { name: "Grav Clothing", email: "biswalpramod3.1415@gmail.com" };

// ── In-memory settings cache (5-min TTL) ─────────────────────────────────────
let _cachedSettings = null;
let _cacheTime      = 0;
const CACHE_TTL     = 5 * 60 * 1000;

const invalidateCache = () => { _cachedSettings = null; _cacheTime = 0; };

const getSettings = async () => {
  if (_cachedSettings && Date.now() - _cacheTime < CACHE_TTL) return _cachedSettings;
  try {
    const SalesSettings = require("../models/CMS_Models/Sales/SalesSettings");
    let s = await SalesSettings.findOne().lean();
    if (!s) { const doc = new SalesSettings({}); await doc.save(); s = doc.toObject(); }
    _cachedSettings = s;
    _cacheTime = Date.now();
  } catch (e) {
    console.warn("[SalesEmailService] Could not load SalesSettings:", e.message);
  }
  return _cachedSettings;
};

// ── Variable substitution helper ─────────────────────────────────────────────
const interpolate = (str, vars) => {
  if (!str) return "";
  return str.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
};

// ── Shared HTML layout ────────────────────────────────────────────────────────
const layout = (title, bodyHtml, settings = {}) => {
  const company = settings.companyName || "Grav Clothing";
  const address = settings.companyAddress || "Mayfair Lagoon Campus, Est. 2024";
  const supportEmail = settings.supportEmail || "support@grav.in";
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
    .hdr-badge { font-size: 10px; color: #64748b; background: #f8fafc; padding: 4px 10px; border-radius: 3px; display: inline-block; margin-top: 8px; letter-spacing: 0.5px; }
    .body { background: #fff; padding: 32px; border: 1px solid #e2e8f0; border-top: none; }
    .creds { border: 1px solid #e2e8f0; border-radius: 4px; overflow: hidden; margin: 24px 0; }
    .cred-row { border-bottom: 1px solid #e2e8f0; }
    .cred-row:last-child { border-bottom: none; }
    .cred-lbl { background: #f8fafc; padding: 10px 16px; font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: .5px; width: 38%; display: inline-block; vertical-align: middle; }
    .cred-val { padding: 10px 16px; font-size: 13px; color: #0f172a; font-weight: 600; font-family: monospace; display: inline-block; vertical-align: middle; }
    .btn { display: inline-block; background: #1e3a5f; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 4px; font-size: 14px; font-weight: 600; margin: 20px 0; letter-spacing: .5px; }
    .box-blue  { background: #eff6ff; border: 1px solid #bfdbfe; color: #1e40af; padding: 14px 18px; border-radius: 4px; margin: 20px 0; font-size: 13px; line-height: 1.5; }
    .box-red   { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; padding: 14px 18px; border-radius: 4px; margin: 20px 0; font-size: 13px; line-height: 1.5; }
    .box-amber { background: #fffbeb; border: 1px solid #fde68a; color: #92400e; padding: 14px 18px; border-radius: 4px; margin: 20px 0; font-size: 13px; line-height: 1.5; }
    .box-green { background: #f0fdf4; border: 1px solid #bbf7d0; color: #15803d; padding: 14px 18px; border-radius: 4px; margin: 20px 0; font-size: 13px; line-height: 1.5; }
    .changes-table { width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 13px; }
    .changes-table th { background: #f8fafc; padding: 10px 14px; text-align: left; font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: .5px; border-bottom: 2px solid #e2e8f0; }
    .changes-table td { padding: 10px 14px; border-bottom: 1px solid #f1f5f9; color: #374151; }
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
    <p style="margin:0 0 6px">Support: <a href="mailto:${supportEmail}" style="color:#1e3a5f;">${supportEmail}</a> &nbsp;|&nbsp; ${address}</p>
    <p style="margin:0;font-size:11px;color:#94a3b8;">&copy; ${new Date().getFullYear()} ${company}. All rights reserved.</p>
  </div>
</body>
</html>`;
};

// ── Credential row helper ─────────────────────────────────────────────────────
const credRow = (label, value) =>
  `<div class="cred-row"><span class="cred-lbl">${label}</span><span class="cred-val">${value}</span></div>`;

// ── BUILD EMAIL HTML/TEXT per type ────────────────────────────────────────────

function buildWelcomeEmail(data, cfg, settings, vars) {
  const { customerId, email, password, portalUrl } = data;
  const date = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });

  const title    = interpolate(cfg.title || "Welcome to Grav Clothing", vars);
  const subtitle = interpolate(cfg.subtitle || "Your account has been created.", vars);
  const greeting = interpolate(cfg.greeting || "Dear {name},", vars);
  const body     = interpolate(cfg.bodyText || "Your customer account has been successfully created.", vars);
  const btnText  = interpolate(cfg.buttonText || "Access Customer Portal", vars);
  const secNote  = interpolate(cfg.securityNote || "", vars);
  const ftNote   = interpolate(cfg.footerNote || "", vars);
  const repName  = settings.repName || "Sales Team";

  const html = layout(title, `
    <p style="font-size:13px;color:#64748b;text-transform:uppercase;letter-spacing:1px;margin:0 0 8px">${subtitle}</p>
    <h1 style="font-size:24px;font-weight:700;color:#0f172a;margin:0 0 20px">${title}</h1>
    <p style="font-size:15px;color:#374151;">${greeting}</p>
    <p style="font-size:15px;color:#374151;margin-top:8px;">${body}</p>
    <div class="creds">
      ${credRow("Customer ID", customerId)}
      ${credRow("Portal URL", portalUrl)}
      ${credRow("Login Email", email)}
      ${credRow("Temp. Password", password)}
      ${credRow("Created On", date)}
    </div>
    <p><a href="${portalUrl}" class="btn">${btnText} &rarr;</a></p>
    ${secNote ? `<div class="box-blue"><strong>Security Notice:</strong> ${secNote}</div>` : ""}
    ${ftNote ? `<p style="font-size:13px;color:#374151;">${ftNote}</p>` : ""}
    <p style="font-size:13px;margin-top:20px;">Best regards,<br><strong>${repName}</strong><br>${settings.companyName || "Grav Clothing"}</p>
  `, settings);

  const text = `
${title}

${greeting}

${body}

Login Credentials:
  Customer ID       : ${customerId}
  Portal URL        : ${portalUrl}
  Login Email       : ${email}
  Temporary Password: ${password}
  Created On        : ${date}

${secNote ? `Security Notice: ${secNote}\n` : ""}
${ftNote ? `${ftNote}\n` : ""}
Best regards,
${repName}
${settings.companyName || "Grav Clothing"} · ${settings.companyAddress || ""}

---
© ${new Date().getFullYear()} ${settings.companyName || "Grav Clothing"}. All rights reserved.
`;
  return { html, text };
}

function buildPasswordResetEmail(data, cfg, settings, vars) {
  const { email, newPassword, resetBy, portalUrl } = data;
  const dateTime = new Date().toLocaleString("en-IN", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });

  const title    = interpolate(cfg.title || "Password Reset Notification", vars);
  const subtitle = interpolate(cfg.subtitle || "Your portal credentials have been updated.", vars);
  const greeting = interpolate(cfg.greeting || "Dear {name},", vars);
  const body     = interpolate(cfg.bodyText || "Your portal password has been reset by our sales team.", vars);
  const btnText  = interpolate(cfg.buttonText || "Login to Portal", vars);
  const secNote  = interpolate(cfg.securityNote || "", vars);
  const repName  = settings.repName || "Sales Team";

  const html = layout(title, `
    <p style="font-size:13px;color:#64748b;text-transform:uppercase;letter-spacing:1px;margin:0 0 8px">${subtitle}</p>
    <h1 style="font-size:24px;font-weight:700;color:#0f172a;margin:0 0 20px">${title}</h1>
    <p style="font-size:15px;color:#374151;">${greeting}</p>
    <p style="font-size:15px;color:#374151;margin-top:8px;">${body}</p>
    <div class="creds">
      ${credRow("Portal URL", portalUrl)}
      ${credRow("Login Email", email)}
      ${credRow("New Password", newPassword)}
      ${credRow("Reset By", resetBy || repName)}
      ${credRow("Date &amp; Time", dateTime)}
    </div>
    <p><a href="${portalUrl}" class="btn">${btnText} &rarr;</a></p>
    ${secNote ? `<div class="box-red"><strong>Important:</strong> ${secNote}</div>` : ""}
    <p style="font-size:13px;margin-top:20px;">Best regards,<br><strong>${repName}</strong><br>${settings.companyName || "Grav Clothing"}</p>
  `, settings);

  const text = `
${title}

${greeting}

${body}

Updated Credentials:
  Portal URL  : ${portalUrl}
  Login Email : ${email}
  New Password: ${newPassword}
  Reset By    : ${resetBy || repName}
  Date & Time : ${dateTime}

${secNote ? `Important: ${secNote}\n` : ""}
Best regards, ${repName} · ${settings.companyName || "Grav Clothing"}

---
© ${new Date().getFullYear()} ${settings.companyName || "Grav Clothing"}. All rights reserved.
`;
  return { html, text };
}

function buildProfileUpdateEmail(data, cfg, settings, vars) {
  const { updatedFields, updatedBy } = data;
  const dateTime = new Date().toLocaleString("en-IN", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });

  const title    = interpolate(cfg.title || "Account Update Notice", vars);
  const subtitle = interpolate(cfg.subtitle || "Your account information has been updated.", vars);
  const greeting = interpolate(cfg.greeting || "Dear {name},", vars);
  const body     = interpolate(cfg.bodyText || "The following details on your account have been updated by our sales team.", vars);
  const ftNote   = interpolate(cfg.footerNote || "", vars);
  const repName  = settings.repName || "Sales Team";

  const rows = updatedFields.map(([label, value]) =>
    `<tr><td style="font-weight:600;color:#374151;width:35%;">${label}</td><td>${value || "—"}</td></tr>`
  ).join("");

  const html = layout(title, `
    <p style="font-size:13px;color:#64748b;text-transform:uppercase;letter-spacing:1px;margin:0 0 8px">${subtitle}</p>
    <h1 style="font-size:24px;font-weight:700;color:#0f172a;margin:0 0 20px">${title}</h1>
    <p style="font-size:15px;color:#374151;">${greeting}</p>
    <p style="font-size:15px;color:#374151;margin-top:8px;">${body}</p>
    <table class="changes-table">
      <thead><tr><th>Field</th><th>Updated Value</th></tr></thead>
      <tbody>
        ${rows}
        <tr><td style="font-weight:600;color:#374151;width:35%;">Updated By</td><td>${updatedBy || repName}</td></tr>
        <tr><td style="font-weight:600;color:#374151;width:35%;">Date &amp; Time</td><td>${dateTime}</td></tr>
      </tbody>
    </table>
    <div class="box-green">If all the above changes are correct, no further action is required.</div>
    ${ftNote ? `<div class="box-amber">${ftNote}</div>` : ""}
    <p style="font-size:13px;margin-top:20px;">Best regards,<br><strong>${repName}</strong><br>${settings.companyName || "Grav Clothing"}</p>
  `, settings);

  const text = `
${title}

${greeting}

${body}

Changes Made:
${updatedFields.map(([l, v]) => `  ${l}: ${v || "—"}`).join("\n")}
  Updated By : ${updatedBy || repName}
  Date & Time: ${dateTime}

${ftNote ? `Note: ${ftNote}\n` : ""}
Best regards, ${repName} · ${settings.companyName || "Grav Clothing"}

---
© ${new Date().getFullYear()} ${settings.companyName || "Grav Clothing"}. All rights reserved.
`;
  return { html, text };
}

// ── Default subjects (fallback if settings not configured) ────────────────────
const DEFAULT_SUBJECTS = {
  welcome:       "Welcome to Grav Clothing – Your Customer Account is Ready",
  passwordReset: "Action Required: Your Grav Clothing Portal Password Has Been Reset",
  profileUpdate: "Notice: Your Grav Clothing Account Details Have Been Updated",
};

// ── Main exported function ────────────────────────────────────────────────────
const sendCustomerEmail = async (type, to, data) => {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.warn("[SalesEmailService] BREVO_API_KEY not set — skipping");
    return false;
  }

  // Fetch settings (cached)
  const settings = await getSettings() || {};
  const notifications = settings.emailNotifications || {};
  const cfg = notifications[type] || {};

  // Check if this email type is enabled
  if (cfg.enabled === false) {
    console.log(`[SalesEmailService] "${type}" notifications disabled in settings — skipping`);
    return false;
  }

  // Build interpolation variables
  const vars = {
    name:         data.name || "",
    supportEmail: settings.supportEmail || "support@grav.in",
    salesEmail:   settings.salesEmail   || "sales@grav.in",
    repPhone:     settings.repPhone     || "+91-XXXXXXXXXX",
    repName:      settings.repName      || "Sales Team",
    portalUrl:    data.portalUrl || settings.portalUrl || "https://portal.gravclothing.com",
  };

  // Merge portalUrl into data for builders
  const enrichedData = {
    ...data,
    portalUrl: vars.portalUrl,
  };

  let html = "", text = "";

  if (type === "welcome")       { const r = buildWelcomeEmail(enrichedData, cfg, settings, vars);       html = r.html; text = r.text; }
  else if (type === "passwordReset") { const r = buildPasswordResetEmail(enrichedData, cfg, settings, vars); html = r.html; text = r.text; }
  else if (type === "profileUpdate") { const r = buildProfileUpdateEmail(enrichedData, cfg, settings, vars); html = r.html; text = r.text; }
  else { console.warn(`[SalesEmailService] Unknown type: "${type}"`); return false; }

  const subject = interpolate(cfg.subject || DEFAULT_SUBJECTS[type] || "Notification from Grav Clothing", vars);

  try {
    const response = await axios.post(
      `${BREVO_BASE}/smtp/email`,
      {
        sender: SENDER,
        to: [{ email: to, name: data.name || to.split("@")[0] }],
        subject,
        htmlContent: html,
        textContent: text,
        headers: { "X-Mailin-custom": `sales_${type}_email` },
      },
      {
        headers: {
          "api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      }
    );
    console.log(`[SalesEmailService] "${type}" sent to ${to}:`, response.data?.messageId);
    return true;
  } catch (err) {
    console.error(`[SalesEmailService] Failed "${type}" to ${to}:`, err.response?.data?.message || err.message);
    return false;
  }
};

module.exports = { sendCustomerEmail, invalidateCache };