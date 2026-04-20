// /service/emailService.js

const axios = require('axios');

const CEO_NOTIFICATION_EMAIL = "ray@grav.in";
const CEO_NOTIFICATION_NAME = "Grav CEO";

// ─── Helper: fetch all active HR email recipients from DB ─────────────────────
async function getHRRecipients() {
    try {
        const HRDepartment = require('../models/HRDepartment');
        const hrs = await HRDepartment.find({ isActive: true }).select('email name').lean();
        if (hrs.length) return hrs.map(h => ({ email: h.email, name: h.name || 'HR' }));
    } catch (e) { console.warn('[EmailService] getHRRecipients failed:', e.message); }
    return [{ email: CEO_NOTIFICATION_EMAIL, name: CEO_NOTIFICATION_NAME }];
}

class EmailService {
    constructor() {
        this.apiKey = process.env.BREVO_API_KEY;
        this.senderEmail = process.env.HR_SENDER_EMAIL || process.env.CUSTOMER_SENDER_EMAIL || "soumyaranjanpraharaj04@gmail.com";
        this.senderName = "Grav HR System";
        this.baseUrl = "https://api.brevo.com/v3";
    }

    async _send(payload) {
        const merged = {
            ...payload,
            sender: payload.sender || { name: this.senderName, email: this.senderEmail },
            replyTo: payload.replyTo || { name: this.senderName, email: process.env.HR_REPLY_TO_EMAIL || this.senderEmail },
            headers: {
                'List-Unsubscribe': `<mailto:${this.senderEmail}?subject=Unsubscribe>`,
                'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
                'X-Mailer': 'Grav HRMS v3',
                'X-Entity-Ref-ID': `grav-hrms-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                'Precedence': 'auto-reply',
                'X-Priority': '3',
                'Importance': 'Normal',
                ...(payload.headers || {}),
            },
        };
        const response = await axios.post(`${this.baseUrl}/smtp/email`, merged, {
            headers: { 'api-key': this.apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        });
        return { success: true, messageId: response.data.messageId };
    }

    // =========================================================================
    //  WELCOME EMAIL
    // =========================================================================
    async sendWelcomeEmail(employeeData, temporaryPassword) {
        try {
            const loginUrl = "https://cms.grav.in/login";
            return await this._send({
                to: [{ email: employeeData.email, name: employeeData.name || employeeData.email.split('@')[0] }],
                subject: `Welcome to Grav - Your Employee Dashboard Access`,
                htmlContent: this.generateWelcomeEmailTemplate(employeeData.name, employeeData.email, temporaryPassword, loginUrl, employeeData.employeeId),
                textContent: this.generatePlainTextContent(employeeData.name, employeeData.email, temporaryPassword, loginUrl, employeeData.employeeId),
                headers: { 'X-Mailin-custom': 'employee_welcome_email' },
            });
        } catch (error) {
            console.error('Error sending welcome email:', error.response?.data || error.message);
            throw new Error(`Failed to send email: ${error.response?.data?.message || error.message}`);
        }
    }

    // =========================================================================
    //  PAYROLL SETTINGS CHANGE
    // =========================================================================
    async sendPayrollSettingsChangeToCEO(changedBy, changes) {
        try {
            return await this._send({
                to: [{ email: CEO_NOTIFICATION_EMAIL, name: CEO_NOTIFICATION_NAME }],
                subject: `Payroll Settings Updated — Grav HR`,
                htmlContent: this.generatePayrollSettingsChangeTemplate(changedBy, changes),
                textContent: this.generatePayrollSettingsChangeText(changedBy, changes),
            });
        } catch (error) {
            console.error('Error sending payroll settings email:', error.response?.data || error.message);
            throw new Error(`Failed to send email: ${error.response?.data?.message || error.message}`);
        }
    }

    // =========================================================================
    //  ATTENDANCE SETTINGS CHANGE
    // =========================================================================
    async sendAttendanceSettingsChangeToCEO(changedBy, changes) {
        try {
            return await this._send({
                to: [{ email: CEO_NOTIFICATION_EMAIL, name: CEO_NOTIFICATION_NAME }],
                subject: `Attendance Settings Updated — Grav HR`,
                htmlContent: this._generateAttendanceSettingsHtml(changedBy, changes),
                textContent: this._generateAttendanceSettingsText(changedBy, changes),
            });
        } catch (error) { console.error('Error sending attendance settings email:', error.response?.data || error.message); }
    }

    _generateAttendanceSettingsHtml(changedBy, changes) {
        const when = new Date().toLocaleString('en-IN', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
        const rows = changes.map(c => `<tr><td style="padding:10px 12px;border-bottom:1px solid #edf2f7;font-weight:600;color:#2d3748;">${c.label}</td><td style="padding:10px 12px;border-bottom:1px solid #edf2f7;color:#c53030;text-decoration:line-through;">${c.before}</td><td style="padding:10px 12px;border-bottom:1px solid #edf2f7;color:#22543d;font-weight:600;">${c.after}</td></tr>`).join('');
        return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:Arial,sans-serif;line-height:1.6;color:#333;max-width:680px;margin:0 auto;padding:20px;background:#f4f4f4;"><div style="background:#fff;border-radius:8px;overflow:hidden;"><div style="background:linear-gradient(135deg,#7c3aed 0%,#4f46e5 100%);color:#fff;padding:25px 20px;text-align:center;"><h1 style="margin:0;font-size:22px;">Attendance Settings Updated</h1></div><div style="padding:28px 30px;"><div style="background:#f7fafc;border:1px solid #e2e8f0;border-radius:6px;padding:14px;margin:0 0 20px;font-size:13px;"><div><strong>Updated by:</strong> ${changedBy || 'HR'}</div><div><strong>When:</strong> ${when} IST</div></div><h3 style="margin:0 0 10px;font-size:15px;color:#2d3748;border-bottom:2px solid #7c3aed;padding-bottom:6px;">Changes (${changes.length})</h3><table style="width:100%;border-collapse:collapse;font-size:13px;"><thead><tr style="background:#edf2f7;"><th style="padding:10px 12px;text-align:left;font-weight:600;border-bottom:2px solid #cbd5e0;">Setting</th><th style="padding:10px 12px;text-align:left;font-weight:600;border-bottom:2px solid #cbd5e0;">Before</th><th style="padding:10px 12px;text-align:left;font-weight:600;border-bottom:2px solid #cbd5e0;">After</th></tr></thead><tbody>${rows}</tbody></table><div style="margin-top:30px;border-top:1px solid #e2e8f0;padding-top:20px;font-size:12px;color:#718096;text-align:center;"><p>Grav Clothing Limited · Bhubaneswar, Odisha, India</p><p>© ${new Date().getFullYear()} Grav Clothing. All rights reserved.</p></div></div></div></body></html>`;
    }

    _generateAttendanceSettingsText(changedBy, changes) {
        const when = new Date().toLocaleString('en-IN', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
        return `ATTENDANCE SETTINGS UPDATED\n\nUpdated by: ${changedBy || 'HR'}\nWhen: ${when} IST\n\nChanges:\n${changes.map(c => `  • ${c.label}: ${c.before} → ${c.after}`).join('\n')}\n\n---\nGrav Clothing Limited\n© ${new Date().getFullYear()} Grav Clothing.`;
    }

    // =========================================================================
    //  ATTENDANCE OVERRIDE / REGULARIZATION
    // =========================================================================
    async sendAttendanceOverrideToCEO(data) {
        try {
            return await this._send({
                to: [{ email: CEO_NOTIFICATION_EMAIL, name: CEO_NOTIFICATION_NAME }],
                subject: `Attendance Override: ${data.employeeName} on ${data.dateStr} — Grav HR`,
                htmlContent: this._generateAttendanceOverrideHtml(data),
                textContent: this._generateAttendanceOverrideText(data),
            });
        } catch (error) { console.error('Error sending attendance override email:', error.response?.data || error.message); }
    }

    async sendRegularizationApprovedToCEO(data) {
        try {
            return await this._send({
                to: [{ email: CEO_NOTIFICATION_EMAIL, name: CEO_NOTIFICATION_NAME }],
                subject: `Regularization Approved: ${data.employeeName} on ${data.dateStr} — Grav HR`,
                htmlContent: this._generateRegularizationApprovedHtml(data),
                textContent: this._generateRegularizationApprovedText(data),
            });
        } catch (error) { console.error('Error sending regularization email:', error.response?.data || error.message); }
    }

    _generateAttendanceOverrideHtml(data) {
        const when = new Date().toLocaleString('en-IN', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
        const punchRows = (data.punchChanges || []).map(p => `<tr><td style="padding:8px 12px;border-bottom:1px solid #edf2f7;font-weight:600;text-transform:capitalize;">${(p.punchType || '').replace(/_/g, ' ')}</td><td style="padding:8px 12px;border-bottom:1px solid #edf2f7;color:#718096;">${p.action || ''}</td><td style="padding:8px 12px;border-bottom:1px solid #edf2f7;color:#c53030;text-decoration:${p.action === 'remove' ? 'line-through' : 'none'};">${p.oldTime || '—'}</td><td style="padding:8px 12px;border-bottom:1px solid #edf2f7;color:#22543d;font-weight:600;">${p.action === 'remove' ? '<em>removed</em>' : (p.newTime || '—')}</td></tr>`).join('');
        return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:Arial,sans-serif;line-height:1.6;color:#333;max-width:680px;margin:0 auto;padding:20px;background:#f4f4f4;"><div style="background:#fff;border-radius:8px;overflow:hidden;"><div style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;padding:25px 20px;text-align:center;"><h1 style="margin:0;font-size:22px;">Attendance Override</h1></div><div style="padding:28px 30px;"><div style="background:#f7fafc;border:1px solid #e2e8f0;border-radius:6px;padding:16px;margin:0 0 20px;font-size:13px;"><div><strong>Employee:</strong> ${data.employeeName || '—'} (${data.biometricId || '—'})</div><div><strong>Date:</strong> ${data.dateStr || '—'}</div><div><strong>Overridden by:</strong> ${data.hrUserName || 'HR'} · ${when} IST</div></div><table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px;"><tr><td style="padding:10px 12px;background:#fff5f5;color:#c53030;font-weight:600;">Before: ${data.oldStatus || '—'}</td><td style="padding:10px 12px;text-align:center;color:#718096;font-size:18px;">→</td><td style="padding:10px 12px;background:#f0fff4;color:#22543d;font-weight:600;">After: ${data.newStatus || '—'}</td></tr></table>${punchRows ? `<h3 style="margin:24px 0 10px;font-size:15px;color:#2d3748;border-bottom:2px solid #667eea;padding-bottom:6px;">Punch Changes</h3><table style="width:100%;border-collapse:collapse;font-size:13px;"><thead><tr style="background:#edf2f7;"><th style="padding:8px 12px;text-align:left;border-bottom:2px solid #cbd5e0;">Punch</th><th style="padding:8px 12px;text-align:left;border-bottom:2px solid #cbd5e0;">Action</th><th style="padding:8px 12px;text-align:left;border-bottom:2px solid #cbd5e0;">Before</th><th style="padding:8px 12px;text-align:left;border-bottom:2px solid #cbd5e0;">After</th></tr></thead><tbody>${punchRows}</tbody></table>` : ''}${data.hrRemarks ? `<div style="background:#fffaf0;border:1px solid #fbd38d;border-radius:4px;padding:12px;margin:20px 0;font-size:13px;color:#744210;"><strong>HR Remarks:</strong> ${data.hrRemarks}</div>` : ''}<div style="margin-top:30px;border-top:1px solid #e2e8f0;padding-top:20px;font-size:12px;color:#718096;text-align:center;"><p>Grav Clothing Limited · Bhubaneswar, Odisha, India · © ${new Date().getFullYear()} Grav Clothing.</p></div></div></div></body></html>`;
    }

    _generateAttendanceOverrideText(data) {
        const when = new Date().toLocaleString('en-IN', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
        return `ATTENDANCE OVERRIDE\n\nEmployee: ${data.employeeName || '—'} (${data.biometricId || '—'})\nDate: ${data.dateStr || '—'}\nOverridden by: ${data.hrUserName || 'HR'} · ${when} IST\nStatus: ${data.oldStatus || '—'} → ${data.newStatus || '—'}\n${data.hrRemarks ? `\nHR Remarks: ${data.hrRemarks}` : ''}\n\n---\nGrav Clothing Limited\n© ${new Date().getFullYear()} Grav Clothing.`;
    }

    _generateRegularizationApprovedHtml(data) {
        const when = new Date().toLocaleString('en-IN', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
        return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:Arial,sans-serif;line-height:1.6;color:#333;max-width:680px;margin:0 auto;padding:20px;background:#f4f4f4;"><div style="background:#fff;border-radius:8px;overflow:hidden;"><div style="background:linear-gradient(135deg,#38a169 0%,#2f855a 100%);color:#fff;padding:25px 20px;text-align:center;"><h1 style="margin:0;font-size:22px;">Regularization Approved</h1></div><div style="padding:28px 30px;"><div style="background:#f7fafc;border:1px solid #e2e8f0;border-radius:6px;padding:16px;margin:0 0 20px;font-size:13px;"><div><strong>Employee:</strong> ${data.employeeName || '—'} (${data.biometricId || '—'})</div><div><strong>Date:</strong> ${data.dateStr || '—'} · Request: ${(data.requestType || '').replace(/_/g, ' ')}</div><div><strong>Approved by:</strong> ${data.hrUserName || 'HR'} · ${when} IST</div></div>${data.employeeReason ? `<div style="background:#ebf8ff;border:1px solid #bee3f8;border-radius:4px;padding:12px;margin:0 0 16px;font-size:13px;color:#2a4365;"><strong>Employee Reason:</strong> ${data.employeeReason}</div>` : ''}<table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px;"><tr><td style="padding:10px 12px;background:#fff5f5;color:#c53030;font-weight:600;">Before: ${data.oldStatus || '—'}</td><td style="padding:10px 12px;text-align:center;color:#718096;font-size:18px;">→</td><td style="padding:10px 12px;background:#f0fff4;color:#22543d;font-weight:600;">After: ${data.newStatus || '—'}</td></tr></table>${data.hrRemarks ? `<div style="background:#fffaf0;border:1px solid #fbd38d;border-radius:4px;padding:12px;font-size:13px;color:#744210;"><strong>HR Remarks:</strong> ${data.hrRemarks}</div>` : ''}<div style="margin-top:30px;border-top:1px solid #e2e8f0;padding-top:20px;font-size:12px;color:#718096;text-align:center;"><p>Grav Clothing Limited · © ${new Date().getFullYear()} Grav Clothing.</p></div></div></div></body></html>`;
    }

    _generateRegularizationApprovedText(data) {
        const when = new Date().toLocaleString('en-IN', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
        return `REGULARIZATION APPROVED\n\nEmployee: ${data.employeeName || '—'} (${data.biometricId || '—'})\nDate: ${data.dateStr || '—'}\nApproved by: ${data.hrUserName || 'HR'} · ${when} IST\nStatus: ${data.oldStatus || '—'} → ${data.newStatus || '—'}\n${data.employeeReason ? `\nEmployee Reason: ${data.employeeReason}` : ''}\n${data.hrRemarks ? `\nHR Remarks: ${data.hrRemarks}` : ''}\n\n---\nGrav Clothing Limited\n© ${new Date().getFullYear()} Grav Clothing.`;
    }

    // =========================================================================
    //  WELCOME EMAIL TEMPLATES
    // =========================================================================
    generateWelcomeEmailTemplate(name, email, password, loginUrl, employeeId) {
        return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:Arial,sans-serif;line-height:1.6;color:#333;max-width:600px;margin:0 auto;padding:20px}.header{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white;padding:30px;text-align:center;border-radius:8px 8px 0 0}.content{background:#fff;padding:30px;border:1px solid #e0e0e0}.credentials{background:#f8f9fa;border:1px solid #dee2e6;border-radius:4px;padding:20px;margin:20px 0}.btn{display:inline-block;background:#667eea;color:white;padding:12px 30px;text-decoration:none;border-radius:4px;margin:20px 0}.footer{background:#f8f9fa;padding:20px;text-align:center;font-size:12px;color:#666;border-radius:0 0 8px 8px}</style></head><body><div class="header"><h1>Welcome to Grav Clothing</h1><p>Your employee account has been created</p></div><div class="content"><p>Dear ${name},</p><p>Welcome to the Grav Clothing team!</p><div class="credentials"><h3>Your Login Credentials</h3><p><strong>Employee ID:</strong> ${employeeId}</p><p><strong>Email:</strong> ${email}</p><p><strong>Temporary Password:</strong> ${password}</p></div><p>Please login and change your password immediately.</p><a href="${loginUrl}" class="btn">Login to Dashboard</a></div><div class="footer"><p>© ${new Date().getFullYear()} Grav Clothing Limited · Bhubaneswar, Odisha, India</p><p>This is an automated notification. Please do not reply directly.</p></div></body></html>`;
    }

    generatePlainTextContent(name, email, password, loginUrl, employeeId) {
        return `Welcome to Grav Clothing, ${name}!\n\nEmployee ID: ${employeeId}\nEmail: ${email}\nTemporary Password: ${password}\n\nLogin: ${loginUrl}\n\nPlease change your password immediately.\n\n© ${new Date().getFullYear()} Grav Clothing.`;
    }

    // =========================================================================
    //  PAYROLL SETTINGS CHANGE TEMPLATES
    // =========================================================================
    generatePayrollSettingsChangeTemplate(changedBy, changes) {
        const rows = changes.map(c => `<tr><td style="padding:10px 12px;border-bottom:1px solid #edf2f7;font-weight:600;">${c.label}</td><td style="padding:10px 12px;border-bottom:1px solid #edf2f7;color:#c53030;text-decoration:line-through;">${c.before}</td><td style="padding:10px 12px;border-bottom:1px solid #edf2f7;color:#22543d;font-weight:600;">${c.after}</td></tr>`).join('');
        const when = new Date().toLocaleString('en-IN', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
        return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:Arial,sans-serif;line-height:1.6;color:#333;max-width:680px;margin:0 auto;padding:20px;background:#f4f4f4;"><div style="background:#fff;border-radius:8px;overflow:hidden;"><div style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white;padding:25px 20px;text-align:center;"><h1 style="margin:0;font-size:22px;">Payroll Settings Updated</h1></div><div style="padding:28px 30px;"><div style="background:#f7fafc;border:1px solid #e2e8f0;border-radius:6px;padding:16px;margin:16px 0;font-size:13px;"><div><strong>Updated by:</strong> ${changedBy || 'HR'}</div><div><strong>When:</strong> ${when} IST</div></div><table style="width:100%;border-collapse:collapse;font-size:13px;"><thead><tr style="background:#edf2f7;"><th style="padding:10px 12px;text-align:left;font-weight:600;border-bottom:2px solid #cbd5e0;">Setting</th><th style="padding:10px 12px;text-align:left;font-weight:600;border-bottom:2px solid #cbd5e0;">Before</th><th style="padding:10px 12px;text-align:left;font-weight:600;border-bottom:2px solid #cbd5e0;">After</th></tr></thead><tbody>${rows}</tbody></table><div style="margin-top:30px;border-top:1px solid #e2e8f0;padding-top:20px;font-size:12px;color:#718096;text-align:center;"><p>Grav Clothing Limited · Bhubaneswar, Odisha, India · © ${new Date().getFullYear()} Grav Clothing.</p></div></div></div></body></html>`;
    }

    generatePayrollSettingsChangeText(changedBy, changes) {
        const when = new Date().toLocaleString('en-IN', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
        return `PAYROLL SETTINGS UPDATED\n\nUpdated by: ${changedBy || 'HR'}\nWhen: ${when} IST\n\nChanges:\n${changes.map(c => `  • ${c.label}: ${c.before} → ${c.after}`).join('\n')}\n\n---\nGrav Clothing Limited\n© ${new Date().getFullYear()} Grav Clothing.`;
    }

    // =========================================================================
    //  LEAVE — APPLIED → NOTIFY PRIMARY MANAGER  (falls back to HR if no manager)
    // =========================================================================
    async sendLeaveAppliedToManager(data) {
        if (!data.managerEmail) return this.sendLeaveAppliedToHR(data);

        const typeLabels = { CL: "Casual Leave", SL: "Sick Leave", PL: "Privilege Leave" };
        const when = new Date().toLocaleString("en-IN", { dateStyle: "full", timeStyle: "short", timeZone: "Asia/Kolkata" });
        const label = typeLabels[data.leaveType] || data.leaveType;

        const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;line-height:1.6;color:#333;max-width:640px;margin:0 auto;padding:20px;background:#f4f4f4;">
<div style="background:#fff;border-radius:8px;overflow:hidden;">
<div style="background:linear-gradient(135deg,#1e293b 0%,#334155 100%);color:#fff;padding:24px 28px;">
<h1 style="margin:0;font-size:20px;">Leave Approval Required</h1>
<p style="margin:4px 0 0;font-size:13px;opacity:.85;">Action required from ${data.managerName || "Manager"}</p>
</div>
<div style="padding:28px 30px;">
<p style="margin-top:0;">Dear <strong>${data.managerName || "Manager"}</strong>,</p>
<p style="font-size:14px;color:#374151;"><strong>${data.employeeName}</strong> has applied for leave and requires your approval.</p>
<table style="width:100%;border-collapse:collapse;font-size:13px;margin:16px 0;">
<tr style="background:#f8fafc;"><td style="padding:10px 14px;color:#718096;font-weight:600;width:40%;border-bottom:1px solid #edf2f7;">Employee</td><td style="padding:10px 14px;font-weight:700;border-bottom:1px solid #edf2f7;">${data.employeeName}</td></tr>
<tr><td style="padding:10px 14px;color:#718096;font-weight:600;border-bottom:1px solid #edf2f7;">Department</td><td style="padding:10px 14px;border-bottom:1px solid #edf2f7;">${data.department}</td></tr>
<tr style="background:#f8fafc;"><td style="padding:10px 14px;color:#718096;font-weight:600;border-bottom:1px solid #edf2f7;">Leave Type</td><td style="padding:10px 14px;border-bottom:1px solid #edf2f7;font-weight:700;">${label}</td></tr>
<tr><td style="padding:10px 14px;color:#718096;font-weight:600;border-bottom:1px solid #edf2f7;">Period</td><td style="padding:10px 14px;font-weight:600;border-bottom:1px solid #edf2f7;">${data.fromDate} – ${data.toDate}</td></tr>
<tr style="background:#f8fafc;"><td style="padding:10px 14px;color:#718096;font-weight:600;border-bottom:1px solid #edf2f7;">Duration</td><td style="padding:10px 14px;font-weight:700;border-bottom:1px solid #edf2f7;">${data.isHalfDay ? "0.5 (Half Day)" : data.totalDays} day${data.totalDays > 1 ? "s" : ""}</td></tr>
<tr><td style="padding:10px 14px;color:#718096;font-weight:600;">Reason</td><td style="padding:10px 14px;">${data.reason}</td></tr>
${data.requiresDocument ? `<tr style="background:#fffbeb;"><td style="padding:10px 14px;color:#92400e;font-weight:600;" colspan="2">⚠️ Document required — ask the employee to upload a supporting document.</td></tr>` : ""}
</table>
<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px 18px;margin:20px 0;font-size:13px;color:#166534;">
📋 Log in to Employee Portal → <strong>Leave Approvals</strong> to act. Application ID: <code>${data.applicationId}</code>
</div>
<p style="font-size:12px;color:#718096;">Submitted: ${when} IST</p>
</div>
<div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:16px 28px;font-size:11px;color:#94a3b8;text-align:center;">
Grav Clothing Limited · Bhubaneswar, Odisha, India<br>© ${new Date().getFullYear()} Grav Clothing. All rights reserved.
</div>
</div></body></html>`;

        try {
            return await this._send({
                to: [{ email: data.managerEmail, name: data.managerName || "Manager" }],
                subject: `Action Required: ${data.employeeName} applied for ${label} (${data.fromDate} – ${data.toDate})`,
                htmlContent: html,
                textContent: `Leave Approval Required\n\n${data.employeeName} (${data.designation}, ${data.department}) applied for ${label}.\nPeriod: ${data.fromDate} to ${data.toDate}\nDays: ${data.isHalfDay ? "0.5 (Half Day)" : data.totalDays}\nReason: ${data.reason}\n${data.requiresDocument ? "\n⚠ Document required.\n" : ""}\nApplication ID: ${data.applicationId}\nSubmitted: ${when} IST\n\n---\nGrav Clothing Limited\n© ${new Date().getFullYear()} Grav Clothing.`,
            });
        } catch (error) { console.error("sendLeaveAppliedToManager error:", error.response?.data || error.message); }
    }

    // =========================================================================
    //  LEAVE — MANAGER FINAL APPROVAL → NOTIFY ALL HR
    // =========================================================================
    async sendLeaveManagerApprovedToHR(data) {
        const typeLabels = { CL: "Casual Leave", SL: "Sick Leave", PL: "Privilege Leave" };
        const when = new Date().toLocaleString("en-IN", { dateStyle: "full", timeStyle: "short", timeZone: "Asia/Kolkata" });
        const label = typeLabels[data.leaveType] || data.leaveType;

        const chainRows = (data.approvalChain || []).map(step =>
            `<tr><td style="padding:8px 14px;border-bottom:1px solid #edf2f7;color:#718096;text-transform:capitalize;">${step.type} Manager</td><td style="padding:8px 14px;border-bottom:1px solid #edf2f7;font-weight:600;">${step.managerName}</td><td style="padding:8px 14px;border-bottom:1px solid #edf2f7;color:#15803d;font-weight:700;">✓ Approved</td><td style="padding:8px 14px;border-bottom:1px solid #edf2f7;font-size:11px;color:#94a3b8;">${step.decidedAt ? new Date(step.decidedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : ""}</td></tr>`
        ).join("");

        const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;line-height:1.6;color:#333;max-width:640px;margin:0 auto;padding:20px;background:#f4f4f4;">
<div style="background:#fff;border-radius:8px;overflow:hidden;">
<div style="background:linear-gradient(135deg,#065f46 0%,#059669 100%);color:#fff;padding:24px 28px;">
<h1 style="margin:0;font-size:20px;">Leave Approved by Manager</h1>
<p style="margin:4px 0 0;font-size:13px;opacity:.85;">Manager workflow complete · For HR records</p>
</div>
<div style="padding:28px 30px;">
<p style="font-size:14px;color:#374151;">The following leave has been approved and attendance updated automatically.</p>
<table style="width:100%;border-collapse:collapse;font-size:13px;margin:16px 0;">
<tr style="background:#f8fafc;"><td style="padding:10px 14px;color:#718096;font-weight:600;width:40%;border-bottom:1px solid #edf2f7;">Employee</td><td style="padding:10px 14px;font-weight:700;border-bottom:1px solid #edf2f7;">${data.employeeName}</td></tr>
<tr><td style="padding:10px 14px;color:#718096;font-weight:600;border-bottom:1px solid #edf2f7;">Department</td><td style="padding:10px 14px;border-bottom:1px solid #edf2f7;">${data.department}</td></tr>
<tr style="background:#f8fafc;"><td style="padding:10px 14px;color:#718096;font-weight:600;border-bottom:1px solid #edf2f7;">Leave Type</td><td style="padding:10px 14px;border-bottom:1px solid #edf2f7;font-weight:700;">${label}</td></tr>
<tr><td style="padding:10px 14px;color:#718096;font-weight:600;border-bottom:1px solid #edf2f7;">Period</td><td style="padding:10px 14px;font-weight:600;border-bottom:1px solid #edf2f7;">${data.fromDate} – ${data.toDate}</td></tr>
<tr style="background:#f8fafc;"><td style="padding:10px 14px;color:#718096;font-weight:600;border-bottom:1px solid #edf2f7;">Duration</td><td style="padding:10px 14px;font-weight:700;border-bottom:1px solid #edf2f7;">${data.isHalfDay ? "0.5 (Half Day)" : data.totalDays} day${data.totalDays > 1 ? "s" : ""}</td></tr>
<tr><td style="padding:10px 14px;color:#718096;font-weight:600;">Reason</td><td style="padding:10px 14px;">${data.reason}</td></tr>
</table>
${chainRows ? `<p style="font-size:12px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;">Approval Chain</p><table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:20px;"><thead><tr style="background:#f8fafc;"><th style="padding:8px 14px;text-align:left;color:#6b7280;font-weight:600;">Role</th><th style="padding:8px 14px;text-align:left;color:#6b7280;font-weight:600;">Name</th><th style="padding:8px 14px;text-align:left;color:#6b7280;font-weight:600;">Decision</th><th style="padding:8px 14px;text-align:left;color:#6b7280;font-weight:600;">When</th></tr></thead><tbody>${chainRows}</tbody></table>` : ""}
<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px 18px;font-size:13px;color:#166534;">
✅ Attendance updated automatically. Application ID: <code>${data.applicationId}</code>
</div>
<p style="font-size:12px;color:#718096;margin-top:20px;">Processed: ${when} IST</p>
</div>
<div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:16px 28px;font-size:11px;color:#94a3b8;text-align:center;">
Grav Clothing Limited · Bhubaneswar, Odisha, India<br>© ${new Date().getFullYear()} Grav Clothing. All rights reserved.
</div>
</div></body></html>`;

        try {
            const hrRecipients = await getHRRecipients();
            return await this._send({
                to: hrRecipients,
                subject: `Leave Approved by Manager — ${data.employeeName} · ${label} (${data.fromDate} – ${data.toDate})`,
                htmlContent: html,
                textContent: `Leave Approved by Manager\n\nEmployee: ${data.employeeName} (${data.designation}, ${data.department})\nLeave: ${label} — ${data.fromDate} to ${data.toDate} (${data.isHalfDay ? "0.5" : data.totalDays} day${data.totalDays > 1 ? "s" : ""})\nReason: ${data.reason}\nApproved by: ${data.managerName} (${data.managerType} manager)\nApplication ID: ${data.applicationId}\n\n---\nGrav Clothing Limited\n© ${new Date().getFullYear()} Grav Clothing.`,
            });
        } catch (error) { console.error("sendLeaveManagerApprovedToHR error:", error.response?.data || error.message); }
    }

    // =========================================================================
    //  LEAVE APPLIED → NOTIFY HR  (fallback: no primary manager assigned)
    // =========================================================================
    async sendLeaveAppliedToHR(data) {
        const typeLabels = { CL: "Casual Leave", SL: "Sick Leave", PL: "Privilege Leave" };
        const when = new Date().toLocaleString("en-IN", { dateStyle: "full", timeStyle: "short", timeZone: "Asia/Kolkata" });
        const label = typeLabels[data.leaveType] || data.leaveType;

        const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;line-height:1.6;color:#333;max-width:640px;margin:0 auto;padding:20px;background:#f4f4f4;">
<div style="background:#fff;border-radius:8px;overflow:hidden;">
<div style="background:linear-gradient(135deg,#5b21b6 0%,#4f46e5 100%);color:#fff;padding:24px 28px;">
<h1 style="margin:0;font-size:20px;">New Leave Application</h1>
<p style="margin:4px 0 0;font-size:13px;opacity:.9;">No manager assigned — routed directly to HR</p>
</div>
<div style="padding:28px 30px;">
<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px;">
<tr style="background:#f8fafc;"><td style="padding:10px 14px;color:#718096;font-weight:600;width:40%;border-bottom:1px solid #edf2f7;">Employee</td><td style="padding:10px 14px;font-weight:700;border-bottom:1px solid #edf2f7;">${data.employeeName}</td></tr>
<tr><td style="padding:10px 14px;color:#718096;font-weight:600;border-bottom:1px solid #edf2f7;">Department</td><td style="padding:10px 14px;border-bottom:1px solid #edf2f7;">${data.department || "—"}</td></tr>
<tr style="background:#f8fafc;"><td style="padding:10px 14px;color:#718096;font-weight:600;border-bottom:1px solid #edf2f7;">Leave Type</td><td style="padding:10px 14px;border-bottom:1px solid #edf2f7;font-weight:700;">${label}</td></tr>
<tr><td style="padding:10px 14px;color:#718096;font-weight:600;border-bottom:1px solid #edf2f7;">Period</td><td style="padding:10px 14px;font-weight:600;border-bottom:1px solid #edf2f7;">${data.fromDate} – ${data.toDate}</td></tr>
<tr style="background:#f8fafc;"><td style="padding:10px 14px;color:#718096;font-weight:600;border-bottom:1px solid #edf2f7;">Duration</td><td style="padding:10px 14px;font-weight:700;border-bottom:1px solid #edf2f7;">${data.isHalfDay ? "0.5 (Half Day)" : data.totalDays} day${data.totalDays > 1 ? "s" : ""}</td></tr>
<tr><td style="padding:10px 14px;color:#718096;font-weight:600;">Reason</td><td style="padding:10px 14px;">${data.reason}</td></tr>
${data.requiresDocument ? `<tr><td colspan="2" style="padding:10px 14px;background:#fffbeb;color:#92400e;font-weight:600;">⚠️ Document required for this Sick Leave</td></tr>` : ""}
</table>
<p style="font-size:12px;color:#94a3b8;">Submitted: ${when} IST · ID: ${data.applicationId}</p>
</div>
<div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:16px 28px;font-size:11px;color:#94a3b8;text-align:center;">
Grav Clothing Limited · Bhubaneswar, Odisha, India<br>© ${new Date().getFullYear()} Grav Clothing. All rights reserved.
</div>
</div></body></html>`;

        try {
            const hrRecipients = await getHRRecipients();
            return await this._send({
                to: hrRecipients,
                subject: `New Leave Request: ${data.employeeName} — ${label} (${data.fromDate} to ${data.toDate})`,
                htmlContent: html,
                textContent: `NEW LEAVE APPLICATION\n\nEmployee: ${data.employeeName}\nDepartment: ${data.department || "—"}\nLeave: ${label} — ${data.fromDate} to ${data.toDate} (${data.isHalfDay ? "0.5 (Half Day)" : data.totalDays} day${data.totalDays > 1 ? "s" : ""})\nReason: ${data.reason}\n${data.requiresDocument ? "\n⚠ Document required.\n" : ""}\nSubmitted: ${when} IST\n\n---\nGrav Clothing Limited\n© ${new Date().getFullYear()} Grav Clothing.`,
            });
        } catch (error) { console.error("sendLeaveAppliedToHR error:", error.response?.data || error.message); }
    }

    // =========================================================================
    //  LEAVE APPROVED — notify employee  ← NEW
    //
    //  Called in final manager approval path after leave becomes hr_approved.
    //  Sends a confirmation email to the employee.
    //
    //  @param {string}  data.employeeEmail
    //  @param {string}  data.employeeName
    //  @param {string}  data.leaveType       CL | SL | PL
    //  @param {string}  data.fromDate
    //  @param {string}  data.toDate
    //  @param {number}  data.totalDays
    //  @param {boolean} data.isHalfDay
    //  @param {string}  data.approvedBy      manager name
    // =========================================================================
    async sendLeaveApprovedToEmployee(data) {
        if (!data.employeeEmail) return;
        const typeLabels = { CL: "Casual Leave", SL: "Sick Leave", PL: "Privilege Leave" };
        const when = new Date().toLocaleString("en-IN", { dateStyle: "full", timeStyle: "short", timeZone: "Asia/Kolkata" });
        const label = typeLabels[data.leaveType] || data.leaveType;

        const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;line-height:1.6;color:#333;max-width:600px;margin:0 auto;padding:20px;background:#f4f4f4;">
<div style="background:#fff;border-radius:8px;overflow:hidden;">
<div style="background:linear-gradient(135deg,#065f46 0%,#059669 100%);color:#fff;padding:24px 28px;">
<h1 style="margin:0;font-size:22px;">🎉 Leave Approved!</h1>
<p style="margin:6px 0 0;font-size:13px;opacity:.9;">Your leave request has been approved</p>
</div>
<div style="padding:28px 30px;">
<p style="margin-top:0;">Dear <strong>${data.employeeName}</strong>,</p>
<p style="font-size:14px;color:#374151;">Your leave application has been approved. Here are the details:</p>
<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:20px;margin:20px 0;text-align:center;">
<p style="margin:0 0 4px;font-size:11px;text-transform:uppercase;font-weight:700;color:#16a34a;letter-spacing:.05em;">Approved Leave</p>
<p style="margin:0;font-size:36px;font-weight:900;color:#14532d;">${data.isHalfDay ? "½" : data.totalDays}</p>
<p style="margin:2px 0 4px;font-size:14px;font-weight:700;color:#065f46;">${label}</p>
<p style="margin:0;font-size:13px;color:#16a34a;">${data.fromDate === data.toDate ? data.fromDate : `${data.fromDate} – ${data.toDate}`}</p>
</div>
<table style="width:100%;border-collapse:collapse;font-size:13px;margin:16px 0;">
<tr style="background:#f8fafc;"><td style="padding:10px 14px;color:#718096;font-weight:600;width:45%;border-bottom:1px solid #edf2f7;">Leave Type</td><td style="padding:10px 14px;font-weight:700;border-bottom:1px solid #edf2f7;">${label}</td></tr>
<tr><td style="padding:10px 14px;color:#718096;font-weight:600;border-bottom:1px solid #edf2f7;">From</td><td style="padding:10px 14px;border-bottom:1px solid #edf2f7;">${data.fromDate}</td></tr>
<tr style="background:#f8fafc;"><td style="padding:10px 14px;color:#718096;font-weight:600;border-bottom:1px solid #edf2f7;">To</td><td style="padding:10px 14px;border-bottom:1px solid #edf2f7;">${data.toDate}</td></tr>
<tr><td style="padding:10px 14px;color:#718096;font-weight:600;border-bottom:1px solid #edf2f7;">Duration</td><td style="padding:10px 14px;font-weight:700;border-bottom:1px solid #edf2f7;">${data.isHalfDay ? "0.5 (Half Day)" : data.totalDays} day${data.totalDays > 1 ? "s" : ""}</td></tr>
<tr style="background:#f8fafc;"><td style="padding:10px 14px;color:#718096;font-weight:600;">Approved by</td><td style="padding:10px 14px;">${data.approvedBy || "Manager"}</td></tr>
</table>
<p style="font-size:13px;color:#6b7280;">Your attendance record has been updated automatically. Have a great time off! 🌟</p>
<p style="font-size:12px;color:#94a3b8;margin-top:20px;">Processed: ${when} IST</p>
</div>
<div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:16px 28px;font-size:11px;color:#94a3b8;text-align:center;">
Grav Clothing Limited · Bhubaneswar, Odisha, India<br>
This is an automated notification. Please do not reply directly.<br>
© ${new Date().getFullYear()} Grav Clothing. All rights reserved.
</div>
</div>
</body></html>`;

        try {
            return await this._send({
                to: [{ email: data.employeeEmail, name: data.employeeName }],
                subject: `✅ Leave Approved: Your ${label} (${data.fromDate} – ${data.toDate}) has been approved`,
                htmlContent: html,
                textContent: `Your ${label} has been approved!\n\nDear ${data.employeeName},\n\nYour leave application has been approved.\n\nLeave Type : ${label}\nFrom       : ${data.fromDate}\nTo         : ${data.toDate}\nDuration   : ${data.isHalfDay ? "0.5 (Half Day)" : data.totalDays} day${data.totalDays > 1 ? "s" : ""}\nApproved by: ${data.approvedBy || "Manager"}\n\nYour attendance has been updated automatically.\n\n---\nGrav Clothing Limited · Bhubaneswar, Odisha, India\n© ${new Date().getFullYear()} Grav Clothing.`,
            });
        } catch (error) { console.error("sendLeaveApprovedToEmployee error:", error.response?.data || error.message); }
    }

    // =========================================================================
    //  LEAVE REJECTED — notify employee
    // =========================================================================
    async sendLeaveRejectedToEmployee(data) {
        if (!data.employeeEmail) return;
        const typeLabels = { CL: "Casual Leave", SL: "Sick Leave", PL: "Privilege Leave" };
        const label = typeLabels[data.leaveType] || data.leaveType;

        const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;line-height:1.6;color:#333;max-width:600px;margin:0 auto;padding:20px;background:#f4f4f4;">
<div style="background:#fff;border-radius:8px;overflow:hidden;">
<div style="background:linear-gradient(135deg,#dc2626 0%,#b91c1c 100%);color:#fff;padding:24px 28px;">
<h1 style="margin:0;font-size:20px;">Leave Not Approved</h1>
<p style="margin:4px 0 0;font-size:13px;opacity:.9;">Your leave request has been reviewed</p>
</div>
<div style="padding:28px 30px;">
<p>Dear ${data.employeeName},</p>
<p>We regret to inform you that your leave application has not been approved.</p>
<table style="width:100%;border-collapse:collapse;font-size:13px;margin:16px 0;">
<tr><td style="padding:8px 12px;border-bottom:1px solid #edf2f7;color:#718096;">Leave Type</td><td style="padding:8px 12px;border-bottom:1px solid #edf2f7;font-weight:600;">${label}</td></tr>
<tr><td style="padding:8px 12px;border-bottom:1px solid #edf2f7;color:#718096;">Period</td><td style="padding:8px 12px;border-bottom:1px solid #edf2f7;">${data.fromDate} to ${data.toDate} (${data.totalDays} day${data.totalDays !== 1 ? "s" : ""})</td></tr>
${data.reason ? `<tr><td style="padding:8px 12px;color:#718096;">Reason</td><td style="padding:8px 12px;">${data.reason}</td></tr>` : ""}
</table>
<p style="font-size:13px;color:#4a5568;">If you have any questions, please contact HR directly.</p>
<div style="margin-top:24px;border-top:1px solid #e2e8f0;padding-top:20px;font-size:12px;color:#718096;text-align:center;">
<p>Grav Clothing Limited · Bhubaneswar, Odisha, India · © ${new Date().getFullYear()} Grav Clothing.</p>
</div>
</div>
</div>
</body></html>`;

        try {
            return await this._send({
                to: [{ email: data.employeeEmail, name: data.employeeName }],
                subject: `Leave Request Update: Your ${label} was not approved`,
                htmlContent: html,
            });
        } catch (error) { console.error("sendLeaveRejectedToEmployee error:", error.response?.data || error.message); }
    }
}

module.exports = new EmailService();