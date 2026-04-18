// /service/emailService.js

const axios = require('axios');

// ─── Notification recipients ──────────────────────────────────────────────────
const CEO_NOTIFICATION_EMAIL = "ray@grav.in";
const CEO_NOTIFICATION_NAME = "Grav CEO";

class EmailService {
    constructor() {
        this.apiKey = process.env.BREVO_API_KEY;
        // Must be a verified sender in your Brevo account.
        // Use an hr@ address — noreply@ addresses have higher spam rates.
        this.senderEmail = process.env.HR_SENDER_EMAIL
            || process.env.CUSTOMER_SENDER_EMAIL
            || "soumyaranjanpraharaj04@gmail.com";
        this.senderName = "Grav HR System";
        this.baseUrl = "https://api.brevo.com/v3";
    }

    // ─── Internal send helper ─────────────────────────────────────────────────
    //
    //  Anti-spam measures applied to every outgoing email:
    //    • replyTo  — gives Gmail/Outlook something to thread against
    //    • X-Mailer — identifies the sending application (not a forged client)
    //    • X-Entity-Ref-ID — unique per-send ID (stops dedup-as-spam)
    //    • List-Unsubscribe — required by Gmail bulk-sender rules (Feb 2024+)
    //    • Precedence: auto-reply — tells MTAs this is automated, not bulk
    //
    async _send(payload) {
        const merged = {
            ...payload,
            sender: payload.sender || { name: this.senderName, email: this.senderEmail },
            // Reply-To: the HR inbox so replies don't bounce into void
            replyTo: payload.replyTo || {
                name: this.senderName,
                email: process.env.HR_REPLY_TO_EMAIL || this.senderEmail,
            },
            headers: {
                // One-click unsubscribe (Gmail bulk-sender requirement)
                'List-Unsubscribe': `<mailto:${this.senderEmail}?subject=Unsubscribe>`,
                'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
                // Identifies origin — avoids "suspicious" flag from unknown mailer
                'X-Mailer': 'Grav HRMS v3',
                // Unique per-message ID prevents dedup spam detection
                'X-Entity-Ref-ID': `grav-hrms-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                // "auto-reply" = automated transactional, not bulk newsletter
                'Precedence': 'auto-reply',
                // Normal priority — high/low can trigger filters
                'X-Priority': '3',
                'Importance': 'Normal',
                // Spread any caller-provided custom headers on top
                ...(payload.headers || {}),
            },
        };

        const response = await axios.post(
            `${this.baseUrl}/smtp/email`,
            merged,
            {
                headers: {
                    'api-key': this.apiKey,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
            }
        );
        return { success: true, messageId: response.data.messageId };
    }

    // =========================================================================
    //  WELCOME EMAIL
    // =========================================================================

    /**
     * Send welcome email to new employee
     */
    async sendWelcomeEmail(employeeData, temporaryPassword) {
        try {
            const loginUrl = "https://cms.grav.in/login";
            const htmlContent = this.generateWelcomeEmailTemplate(
                employeeData.name, employeeData.email,
                temporaryPassword, loginUrl, employeeData.employeeId
            );
            return await this._send({
                sender: { name: this.senderName, email: this.senderEmail },
                to: [{ email: employeeData.email, name: employeeData.name || employeeData.email.split('@')[0] }],
                subject: `Welcome to Grav - Your Employee Dashboard Access`,
                htmlContent,
                textContent: this.generatePlainTextContent(
                    employeeData.name, employeeData.email,
                    temporaryPassword, loginUrl, employeeData.employeeId
                ),
                headers: { 'X-Mailin-custom': 'employee_welcome_email' },
            });
        } catch (error) {
            console.error('Error sending welcome email:', error.response?.data || error.message);
            throw new Error(`Failed to send email: ${error.response?.data?.message || error.message}`);
        }
    }

    // =========================================================================
    //  PAYROLL SETTINGS CHANGE (existing)
    // =========================================================================

    async sendPayrollSettingsChangeToCEO(changedBy, changes) {
        try {
            return await this._send({
                sender: { name: this.senderName, email: this.senderEmail },
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
    //  ATTENDANCE SETTINGS CHANGE — notify CEO
    // =========================================================================

    /**
     * Send CEO notification when HR saves attendance settings changes.
     *
     * @param {string} changedBy  - HR user name or email
     * @param {Array}  changes    - [{label, before, after}]
     *
     * Automatically called by PUT /hr/attendance/settings when any field differs
     * from the previously saved value. Non-fatal — a failure won't block the save.
     */
    async sendAttendanceSettingsChangeToCEO(changedBy, changes) {
        try {
            return await this._send({
                sender: { name: this.senderName, email: this.senderEmail },
                to: [{ email: CEO_NOTIFICATION_EMAIL, name: CEO_NOTIFICATION_NAME }],
                subject: `Attendance Settings Updated — Grav HR`,
                htmlContent: this._generateAttendanceSettingsHtml(changedBy, changes),
                textContent: this._generateAttendanceSettingsText(changedBy, changes),
            });
        } catch (error) {
            console.error('Error sending attendance settings email:', error.response?.data || error.message);
            // Non-fatal — swallow so it never blocks the save response
        }
    }

    _generateAttendanceSettingsHtml(changedBy, changes) {
        const when = new Date().toLocaleString('en-IN', {
            dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Kolkata',
        });

        const rows = changes.map(c => `
            <tr>
                <td style="padding:10px 12px;border-bottom:1px solid #edf2f7;font-weight:600;color:#2d3748;">${c.label}</td>
                <td style="padding:10px 12px;border-bottom:1px solid #edf2f7;color:#c53030;text-decoration:line-through;">${c.before}</td>
                <td style="padding:10px 12px;border-bottom:1px solid #edf2f7;color:#22543d;font-weight:600;">${c.after}</td>
            </tr>`).join('');

        return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Attendance Settings Updated</title></head>
<body style="font-family:Arial,sans-serif;line-height:1.6;color:#333;max-width:680px;margin:0 auto;padding:20px;background:#f4f4f4;">
    <div style="background:#fff;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.1);overflow:hidden;">
        <div style="background:linear-gradient(135deg,#7c3aed 0%,#4f46e5 100%);color:#fff;padding:25px 20px;text-align:center;">
            <h1 style="margin:0;font-size:22px;">Attendance Settings Updated</h1>
            <p style="margin:4px 0 0;font-size:13px;opacity:.9;">HR has modified the attendance configuration</p>
        </div>
        <div style="padding:28px 30px;">
            <p style="font-size:14px;color:#4a5568;margin:0 0 20px;">
                The attendance settings for <strong>Grav Clothing</strong> have been updated.
            </p>
            <div style="background:#f7fafc;border:1px solid #e2e8f0;border-radius:6px;padding:14px;margin:0 0 20px;font-size:13px;">
                <div><strong>Updated by:</strong> ${changedBy || 'HR'}</div>
                <div style="margin-top:4px;"><strong>When:</strong> ${when} IST</div>
            </div>
            <h3 style="margin:0 0 10px;font-size:15px;color:#2d3748;border-bottom:2px solid #7c3aed;padding-bottom:6px;">
                Changes (${changes.length})
            </h3>
            <table style="width:100%;border-collapse:collapse;font-size:13px;">
                <thead>
                    <tr style="background:#edf2f7;">
                        <th style="padding:10px 12px;text-align:left;color:#4a5568;font-weight:600;border-bottom:2px solid #cbd5e0;">Setting</th>
                        <th style="padding:10px 12px;text-align:left;color:#4a5568;font-weight:600;border-bottom:2px solid #cbd5e0;">Before</th>
                        <th style="padding:10px 12px;text-align:left;color:#4a5568;font-weight:600;border-bottom:2px solid #cbd5e0;">After</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
            <div style="background:#faf5ff;border:1px solid #e9d5ff;border-radius:4px;padding:12px;margin:24px 0;font-size:13px;color:#6b21a8;">
                <strong>Note:</strong> Changes apply to the next attendance sync. Past records are not affected unless re-synced.
            </div>
            <div style="margin-top:30px;padding-top:20px;border-top:1px solid #e2e8f0;font-size:12px;color:#718096;text-align:center;">
                <p style="margin:4px 0;">This is an automated notification from the Grav HR System. Please do not reply directly to this email.</p>
                <p style="margin:4px 0;">Grav Clothing Limited · Bhubaneswar, Odisha, India</p>
                <p style="margin:4px 0;">© ${new Date().getFullYear()} Grav Clothing. All rights reserved.</p>
            </div>
        </div>
    </div>
</body></html>`;
    }

    _generateAttendanceSettingsText(changedBy, changes) {
        const when = new Date().toLocaleString('en-IN', {
            dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Kolkata',
        });
        const lines = changes.map(c => `  • ${c.label}: ${c.before} → ${c.after}`).join('\n');
        return `ATTENDANCE SETTINGS UPDATED

The attendance settings for Grav Clothing have been updated.

Updated by: ${changedBy || 'HR'}
When:       ${when} IST

Changes (${changes.length}):
${lines}

Note: Changes apply to the next attendance sync.
Past records are not affected unless re-synced.

---
Grav Clothing Limited · Bhubaneswar, Odisha, India
This is an automated notification. Please do not reply directly to this email.
© ${new Date().getFullYear()} Grav Clothing. All rights reserved.`;
    }

    // =========================================================================
    //  ATTENDANCE HR OVERRIDE — notify CEO
    // =========================================================================

    /**
     * Send CEO notification when HR manually overrides attendance.
     *
     * @param {Object} data
     * @param {string} data.hrUserName        - Name of the HR person who made the change
     * @param {string} data.employeeName
     * @param {string} data.biometricId
     * @param {string} data.department
     * @param {string} data.designation
     * @param {string} data.dateStr           - "YYYY-MM-DD"
     * @param {string} data.oldStatus         - systemPrediction before override
     * @param {string} data.newStatus         - hrFinalStatus after override
     * @param {string} [data.hrRemarks]
     * @param {Array}  [data.punchChanges]    - [{punchType, action, oldTime, newTime}]
     */
    async sendAttendanceOverrideToCEO(data) {
        try {
            const subject = `Attendance Override: ${data.employeeName} on ${data.dateStr} — Grav HR`;
            return await this._send({
                sender: { name: this.senderName, email: this.senderEmail },
                to: [{ email: CEO_NOTIFICATION_EMAIL, name: CEO_NOTIFICATION_NAME }],
                subject,
                htmlContent: this._generateAttendanceOverrideHtml(data),
                textContent: this._generateAttendanceOverrideText(data),
            });
        } catch (error) {
            console.error('Error sending attendance override email:', error.response?.data || error.message);
            // Non-fatal — log and continue
        }
    }

    /**
     * Send CEO notification when HR approves a regularization request.
     *
     * @param {Object} data
     * @param {string} data.hrUserName
     * @param {string} data.employeeName
     * @param {string} data.biometricId
     * @param {string} data.department
     * @param {string} data.dateStr
     * @param {string} data.requestType
     * @param {string} data.oldStatus
     * @param {string} data.newStatus
     * @param {string} [data.employeeReason]
     * @param {string} [data.hrRemarks]
     * @param {Array}  [data.punchChanges]
     */
    async sendRegularizationApprovedToCEO(data) {
        try {
            const subject = `Regularization Approved: ${data.employeeName} on ${data.dateStr} — Grav HR`;
            return await this._send({
                sender: { name: this.senderName, email: this.senderEmail },
                to: [{ email: CEO_NOTIFICATION_EMAIL, name: CEO_NOTIFICATION_NAME }],
                subject,
                htmlContent: this._generateRegularizationApprovedHtml(data),
                textContent: this._generateRegularizationApprovedText(data),
            });
        } catch (error) {
            console.error('Error sending regularization email:', error.response?.data || error.message);
        }
    }

    // =========================================================================
    //  HTML TEMPLATES
    // =========================================================================

    _generateAttendanceOverrideHtml(data) {
        const when = new Date().toLocaleString('en-IN', {
            dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Kolkata',
        });

        const punchRows = (data.punchChanges || []).map(p => `
            <tr>
                <td style="padding:8px 12px;border-bottom:1px solid #edf2f7;font-weight:600;color:#2d3748;text-transform:capitalize;">
                    ${(p.punchType || '').replace(/_/g, ' ')}
                </td>
                <td style="padding:8px 12px;border-bottom:1px solid #edf2f7;color:#718096;">
                    ${p.action || ''}
                </td>
                <td style="padding:8px 12px;border-bottom:1px solid #edf2f7;color:#c53030;text-decoration:${p.action === 'remove' ? 'line-through' : 'none'};">
                    ${p.oldTime || '—'}
                </td>
                <td style="padding:8px 12px;border-bottom:1px solid #edf2f7;color:#22543d;font-weight:600;">
                    ${p.action === 'remove' ? '<em>removed</em>' : (p.newTime || '—')}
                </td>
            </tr>`).join('');

        const punchSection = punchRows ? `
            <h3 style="margin:24px 0 10px;font-size:15px;color:#2d3748;border-bottom:2px solid #667eea;padding-bottom:6px;">
                Punch Changes
            </h3>
            <table style="width:100%;border-collapse:collapse;font-size:13px;">
                <thead>
                    <tr style="background:#edf2f7;">
                        <th style="padding:8px 12px;text-align:left;color:#4a5568;border-bottom:2px solid #cbd5e0;">Punch</th>
                        <th style="padding:8px 12px;text-align:left;color:#4a5568;border-bottom:2px solid #cbd5e0;">Action</th>
                        <th style="padding:8px 12px;text-align:left;color:#4a5568;border-bottom:2px solid #cbd5e0;">Before</th>
                        <th style="padding:8px 12px;text-align:left;color:#4a5568;border-bottom:2px solid #cbd5e0;">After</th>
                    </tr>
                </thead>
                <tbody>${punchRows}</tbody>
            </table>` : '';

        return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Attendance Override</title></head>
<body style="font-family:Arial,sans-serif;line-height:1.6;color:#333;max-width:680px;margin:0 auto;padding:20px;background:#f4f4f4;">
    <div style="background:#fff;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.1);overflow:hidden;">
        <div style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;padding:25px 20px;text-align:center;">
            <h1 style="margin:0;font-size:22px;">Attendance Override</h1>
            <p style="margin:4px 0 0;font-size:13px;opacity:.9;">HR has manually adjusted an attendance record</p>
        </div>
        <div style="padding:28px 30px;">
            <div style="background:#f7fafc;border:1px solid #e2e8f0;border-radius:6px;padding:16px;margin:0 0 20px;font-size:13px;">
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                    <div><strong>Employee:</strong> ${data.employeeName || '—'}</div>
                    <div><strong>ID:</strong> ${data.biometricId || '—'}</div>
                    <div><strong>Department:</strong> ${data.department || '—'}</div>
                    <div><strong>Designation:</strong> ${data.designation || '—'}</div>
                    <div><strong>Date:</strong> ${data.dateStr || '—'}</div>
                    <div><strong>Overridden by:</strong> ${data.hrUserName || 'HR'}</div>
                    <div><strong>When:</strong> ${when} IST</div>
                </div>
            </div>

            <h3 style="margin:0 0 10px;font-size:15px;color:#2d3748;border-bottom:2px solid #667eea;padding-bottom:6px;">
                Status Change
            </h3>
            <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px;">
                <tr>
                    <td style="padding:10px 12px;background:#fff5f5;color:#c53030;font-weight:600;border-radius:4px 0 0 4px;">
                        Before: ${data.oldStatus || '—'}
                    </td>
                    <td style="padding:10px 12px;text-align:center;color:#718096;font-size:18px;">→</td>
                    <td style="padding:10px 12px;background:#f0fff4;color:#22543d;font-weight:600;border-radius:0 4px 4px 0;">
                        After: ${data.newStatus || '—'}
                    </td>
                </tr>
            </table>

            ${punchSection}

            ${data.hrRemarks ? `
            <div style="background:#fffaf0;border:1px solid #fbd38d;border-radius:4px;padding:12px;margin:20px 0;font-size:13px;color:#744210;">
                <strong>HR Remarks:</strong> ${data.hrRemarks}
            </div>` : ''}

            <div style="margin-top:30px;padding-top:20px;border-top:1px solid #e2e8f0;font-size:12px;color:#718096;text-align:center;">
                <p style="margin:4px 0;">This is an automated notification from the Grav HR System. Please do not reply directly to this email.</p>
                <p style="margin:4px 0;">Grav Clothing Limited · Bhubaneswar, Odisha, India</p>
                <p style="margin:4px 0;">© ${new Date().getFullYear()} Grav Clothing. All rights reserved.</p>
            </div>
        </div>
    </div>
</body></html>`;
    }

    _generateAttendanceOverrideText(data) {
        const when = new Date().toLocaleString('en-IN', {
            dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Kolkata',
        });
        const punches = (data.punchChanges || []).map(p =>
            `  • ${(p.punchType || '').replace(/_/g, ' ')} — ${p.action}: ${p.oldTime || '—'} → ${p.newTime || 'removed'}`
        ).join('\n');

        return `ATTENDANCE OVERRIDE NOTIFICATION

Employee:    ${data.employeeName || '—'} (${data.biometricId || '—'})
Department:  ${data.department || '—'}
Date:        ${data.dateStr || '—'}
Overridden by: ${data.hrUserName || 'HR'}
When:        ${when} IST

Status Change: ${data.oldStatus || '—'} → ${data.newStatus || '—'}
${punches ? `\nPunch Changes:\n${punches}` : ''}
${data.hrRemarks ? `\nHR Remarks: ${data.hrRemarks}` : ''}

---
Grav Clothing Limited · Bhubaneswar, Odisha, India
This is an automated notification. Please do not reply directly to this email.
© ${new Date().getFullYear()} Grav Clothing. All rights reserved.`;
    }

    _generateRegularizationApprovedHtml(data) {
        const when = new Date().toLocaleString('en-IN', {
            dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Kolkata',
        });

        const punchRows = (data.punchChanges || []).map(p => `
            <tr>
                <td style="padding:8px 12px;border-bottom:1px solid #edf2f7;font-weight:600;color:#2d3748;text-transform:capitalize;">
                    ${(p.punchType || '').replace(/_/g, ' ')}
                </td>
                <td style="padding:8px 12px;border-bottom:1px solid #edf2f7;color:#718096;">${p.action || ''}</td>
                <td style="padding:8px 12px;border-bottom:1px solid #edf2f7;color:#c53030;">${p.oldTime || '—'}</td>
                <td style="padding:8px 12px;border-bottom:1px solid #edf2f7;color:#22543d;font-weight:600;">
                    ${p.action === 'remove' ? '<em>removed</em>' : (p.newTime || '—')}
                </td>
            </tr>`).join('');

        return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Regularization Approved</title></head>
<body style="font-family:Arial,sans-serif;line-height:1.6;color:#333;max-width:680px;margin:0 auto;padding:20px;background:#f4f4f4;">
    <div style="background:#fff;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.1);overflow:hidden;">
        <div style="background:linear-gradient(135deg,#38a169 0%,#2f855a 100%);color:#fff;padding:25px 20px;text-align:center;">
            <h1 style="margin:0;font-size:22px;">Regularization Approved</h1>
            <p style="margin:4px 0 0;font-size:13px;opacity:.9;">HR has approved an attendance regularization request</p>
        </div>
        <div style="padding:28px 30px;">
            <div style="background:#f7fafc;border:1px solid #e2e8f0;border-radius:6px;padding:16px;margin:0 0 20px;font-size:13px;">
                <div><strong>Employee:</strong> ${data.employeeName || '—'} (${data.biometricId || '—'})</div>
                <div><strong>Department:</strong> ${data.department || '—'}</div>
                <div><strong>Date:</strong> ${data.dateStr || '—'}</div>
                <div><strong>Request Type:</strong> ${(data.requestType || '').replace(/_/g, ' ')}</div>
                <div><strong>Approved by:</strong> ${data.hrUserName || 'HR'}</div>
                <div><strong>When:</strong> ${when} IST</div>
            </div>

            ${data.employeeReason ? `
            <div style="background:#ebf8ff;border:1px solid #bee3f8;border-radius:4px;padding:12px;margin:0 0 16px;font-size:13px;color:#2a4365;">
                <strong>Employee's Reason:</strong> ${data.employeeReason}
            </div>` : ''}

            <h3 style="margin:0 0 10px;font-size:15px;color:#2d3748;border-bottom:2px solid #38a169;padding-bottom:6px;">
                Status Change
            </h3>
            <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px;">
                <tr>
                    <td style="padding:10px 12px;background:#fff5f5;color:#c53030;font-weight:600;border-radius:4px 0 0 4px;">
                        Before: ${data.oldStatus || '—'}
                    </td>
                    <td style="padding:10px 12px;text-align:center;color:#718096;font-size:18px;">→</td>
                    <td style="padding:10px 12px;background:#f0fff4;color:#22543d;font-weight:600;border-radius:0 4px 4px 0;">
                        After: ${data.newStatus || '—'}
                    </td>
                </tr>
            </table>

            ${punchRows ? `
            <h3 style="margin:0 0 10px;font-size:15px;color:#2d3748;border-bottom:2px solid #38a169;padding-bottom:6px;">
                Punch Changes Applied
            </h3>
            <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px;">
                <thead><tr style="background:#edf2f7;">
                    <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #cbd5e0;">Punch</th>
                    <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #cbd5e0;">Action</th>
                    <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #cbd5e0;">Before</th>
                    <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #cbd5e0;">After</th>
                </tr></thead>
                <tbody>${punchRows}</tbody>
            </table>` : ''}

            ${data.hrRemarks ? `
            <div style="background:#fffaf0;border:1px solid #fbd38d;border-radius:4px;padding:12px;font-size:13px;color:#744210;">
                <strong>HR Remarks:</strong> ${data.hrRemarks}
            </div>` : ''}

            <div style="margin-top:30px;padding-top:20px;border-top:1px solid #e2e8f0;font-size:12px;color:#718096;text-align:center;">
                <p style="margin:4px 0;">This is an automated notification from the Grav HR System. Please do not reply directly to this email.</p>
                <p style="margin:4px 0;">Grav Clothing Limited · Bhubaneswar, Odisha, India</p>
                <p style="margin:4px 0;">© ${new Date().getFullYear()} Grav Clothing. All rights reserved.</p>
            </div>
        </div>
    </div>
</body></html>`;
    }

    _generateRegularizationApprovedText(data) {
        const when = new Date().toLocaleString('en-IN', {
            dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Kolkata',
        });
        const punches = (data.punchChanges || []).map(p =>
            `  • ${(p.punchType || '').replace(/_/g, ' ')} — ${p.action}: ${p.oldTime || '—'} → ${p.newTime || 'removed'}`
        ).join('\n');

        return `REGULARIZATION APPROVED

Employee:     ${data.employeeName || '—'} (${data.biometricId || '—'})
Department:   ${data.department || '—'}
Date:         ${data.dateStr || '—'}
Request type: ${(data.requestType || '').replace(/_/g, ' ')}
Approved by:  ${data.hrUserName || 'HR'}
When:         ${when} IST

Status Change: ${data.oldStatus || '—'} → ${data.newStatus || '—'}
${data.employeeReason ? `\nEmployee's Reason: ${data.employeeReason}` : ''}
${punches ? `\nPunch Changes:\n${punches}` : ''}
${data.hrRemarks ? `\nHR Remarks: ${data.hrRemarks}` : ''}

---
Grav Clothing Limited · Bhubaneswar, Odisha, India
This is an automated notification. Please do not reply directly to this email.
© ${new Date().getFullYear()} Grav Clothing. All rights reserved.`;
    }

    // =========================================================================
    //  WELCOME EMAIL TEMPLATES  (unchanged)
    // =========================================================================

    generateWelcomeEmailTemplate(name, email, password, loginUrl, employeeId) {
        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Welcome to Grav</title>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: #ffffff; padding: 30px; border: 1px solid #e0e0e0; }
        .credentials { background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 4px; padding: 20px; margin: 20px 0; }
        .btn { display: inline-block; background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 4px; margin: 20px 0; }
        .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #666; border-radius: 0 0 8px 8px; }
    </style>
</head>
<body>
    <div class="header">
        <h1>Welcome to Grav Clothing</h1>
        <p>Your employee account has been created</p>
    </div>
    <div class="content">
        <p>Dear ${name},</p>
        <p>Welcome to the Grav Clothing team! Your employee account has been successfully created.</p>
        <div class="credentials">
            <h3>Your Login Credentials</h3>
            <p><strong>Employee ID:</strong> ${employeeId}</p>
            <p><strong>Email:</strong> ${email}</p>
            <p><strong>Temporary Password:</strong> ${password}</p>
        </div>
        <p>Please login and change your password immediately.</p>
        <a href="${loginUrl}" class="btn">Login to Dashboard</a>
        <p>If you have any issues, contact HR.</p>
    </div>
    <div class="footer">
        <p>© ${new Date().getFullYear()} Grav Clothing Limited · Bhubaneswar, Odisha, India</p>
        <p>This is an automated notification from the Grav HR System. Please do not reply directly to this email.</p>
    </div>
</body>
</html>`;
    }

    generatePlainTextContent(name, email, password, loginUrl, employeeId) {
        return `Welcome to Grav Clothing, ${name}!

Your employee account has been created.

Employee ID: ${employeeId}
Email: ${email}
Temporary Password: ${password}

Login URL: ${loginUrl}

Please change your password immediately after logging in.

© ${new Date().getFullYear()} Grav Clothing. All rights reserved.`;
    }

    // =========================================================================
    //  PAYROLL SETTINGS CHANGE TEMPLATES  (unchanged)
    // =========================================================================

    generatePayrollSettingsChangeTemplate(changedBy, changes) {
        const rows = changes.map((c) => `
            <tr>
                <td style="padding:10px 12px;border-bottom:1px solid #edf2f7;font-weight:600;color:#2d3748;">
                    ${c.label}
                </td>
                <td style="padding:10px 12px;border-bottom:1px solid #edf2f7;color:#c53030;text-decoration:line-through;">
                    ${c.before}
                </td>
                <td style="padding:10px 12px;border-bottom:1px solid #edf2f7;color:#22543d;font-weight:600;">
                    ${c.after}
                </td>
            </tr>
        `).join('');

        const when = new Date().toLocaleString('en-IN', {
            dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Kolkata'
        });

        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Payroll Settings Updated</title>
</head>
<body style="font-family:Arial,sans-serif;line-height:1.6;color:#333;max-width:680px;margin:0 auto;padding:20px;background-color:#f4f4f4;">
    <div style="background-color:#ffffff;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,0.1);overflow:hidden;">
        <div style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white;padding:25px 20px;text-align:center;">
            <h1 style="margin:0;font-size:22px;">Payroll Settings Updated</h1>
            <p style="margin:4px 0 0;font-size:13px;opacity:.9;">HR has modified the payroll configuration</p>
        </div>

        <div style="padding:28px 30px;">
            <p style="font-size:14px;color:#4a5568;margin:0 0 20px;">
                This is an automated notification that the payroll settings for
                <strong>Grav Clothing</strong> have been updated.
            </p>

            <div style="background-color:#f7fafc;border:1px solid #e2e8f0;border-radius:6px;padding:16px;margin:16px 0;font-size:13px;">
                <div style="margin-bottom:6px;"><strong>Updated by:</strong> ${changedBy || 'HR'}</div>
                <div><strong>When:</strong> ${when} IST</div>
            </div>

            <h3 style="margin:24px 0 10px;font-size:15px;color:#2d3748;border-bottom:2px solid #667eea;padding-bottom:6px;">
                Changes (${changes.length})
            </h3>

            <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:10px;">
                <thead>
                    <tr style="background-color:#edf2f7;">
                        <th style="padding:10px 12px;text-align:left;color:#4a5568;font-weight:600;border-bottom:2px solid #cbd5e0;">Setting</th>
                        <th style="padding:10px 12px;text-align:left;color:#4a5568;font-weight:600;border-bottom:2px solid #cbd5e0;">Before</th>
                        <th style="padding:10px 12px;text-align:left;color:#4a5568;font-weight:600;border-bottom:2px solid #cbd5e0;">After</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>

            <div style="background-color:#fffaf0;border:1px solid #fbd38d;border-radius:4px;padding:12px;margin:24px 0;font-size:13px;color:#744210;">
                <strong>Note:</strong> These changes apply to the next payroll run.
                Payroll items already marked as "paid" are not affected.
            </div>

            <div style="margin-top:30px;padding-top:20px;border-top:1px solid #e2e8f0;font-size:12px;color:#718096;text-align:center;">
                <p style="margin:4px 0;">This is an automated notification from the Grav HR System. Please do not reply directly to this email.</p>
                <p style="margin:4px 0;">Grav Clothing Limited · Bhubaneswar, Odisha, India</p>
                <p style="margin:4px 0;">© ${new Date().getFullYear()} Grav Clothing. All rights reserved.</p>
            </div>
        </div>
    </div>
</body>
</html>`;
    }

    generatePayrollSettingsChangeText(changedBy, changes) {
        const when = new Date().toLocaleString('en-IN', {
            dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Kolkata'
        });
        const lines = changes.map((c) => `  • ${c.label}: ${c.before} → ${c.after}`).join('\n');
        return `
PAYROLL SETTINGS UPDATED

The payroll settings for Grav Clothing have been updated.

Updated by: ${changedBy || 'HR'}
When:       ${when} IST

Changes (${changes.length}):
${lines}

Note: These changes apply to the next payroll run. Payroll items
already marked as "paid" are not affected.

---
Grav Clothing Limited · Bhubaneswar, Odisha, India
This is an automated notification. Please do not reply directly to this email.
© ${new Date().getFullYear()} Grav Clothing. All rights reserved.
`;
    }
    // =========================================================================
    //  LEAVE APPLIED — notify HR when employee submits a leave application
    // =========================================================================

    /**
     * @param {Object} data
     * @param {string} data.employeeName
     * @param {string} data.department
     * @param {string} data.designation
     * @param {string} data.leaveType       CL | SL | PL
     * @param {string} data.fromDate
     * @param {string} data.toDate
     * @param {number} data.totalDays
     * @param {string} data.reason
     * @param {boolean} data.isHalfDay
     * @param {boolean} data.requiresDocument
     * @param {string} data.applicationId
     */
    async sendLeaveAppliedToHR(data) {
        const typeLabels = { CL: "Casual Leave", SL: "Sick Leave", PL: "Privilege Leave" };
        const when = new Date().toLocaleString("en-IN", { dateStyle: "full", timeStyle: "short", timeZone: "Asia/Kolkata" });
        const subject = `New Leave Request: ${data.employeeName} — ${typeLabels[data.leaveType] || data.leaveType} (${data.fromDate} to ${data.toDate})`;

        const htmlContent = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="font-family:Arial,sans-serif;line-height:1.6;color:#333;max-width:640px;margin:0 auto;padding:20px;background:#f4f4f4;">
    <div style="background:#fff;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.1);overflow:hidden;">
        <div style="background:linear-gradient(135deg,#5b21b6 0%,#4f46e5 100%);color:#fff;padding:24px 28px;">
            <h1 style="margin:0;font-size:20px;">New Leave Application</h1>
            <p style="margin:4px 0 0;font-size:13px;opacity:.9;">Submitted by ${data.employeeName}</p>
        </div>
        <div style="padding:28px 30px;">
            <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px;">
                <tr><td style="padding:8px 12px;border-bottom:1px solid #edf2f7;color:#718096;width:40%;">Employee</td><td style="padding:8px 12px;border-bottom:1px solid #edf2f7;font-weight:600;">${data.employeeName}</td></tr>
                <tr><td style="padding:8px 12px;border-bottom:1px solid #edf2f7;color:#718096;">Department</td><td style="padding:8px 12px;border-bottom:1px solid #edf2f7;">${data.department || "—"}</td></tr>
                <tr><td style="padding:8px 12px;border-bottom:1px solid #edf2f7;color:#718096;">Designation</td><td style="padding:8px 12px;border-bottom:1px solid #edf2f7;">${data.designation || "—"}</td></tr>
                <tr><td style="padding:8px 12px;border-bottom:1px solid #edf2f7;color:#718096;">Leave Type</td><td style="padding:8px 12px;border-bottom:1px solid #edf2f7;font-weight:600;color:#5b21b6;">${typeLabels[data.leaveType] || data.leaveType}</td></tr>
                <tr><td style="padding:8px 12px;border-bottom:1px solid #edf2f7;color:#718096;">From</td><td style="padding:8px 12px;border-bottom:1px solid #edf2f7;">${data.fromDate}</td></tr>
                <tr><td style="padding:8px 12px;border-bottom:1px solid #edf2f7;color:#718096;">To</td><td style="padding:8px 12px;border-bottom:1px solid #edf2f7;">${data.toDate}</td></tr>
                <tr><td style="padding:8px 12px;border-bottom:1px solid #edf2f7;color:#718096;">Total Days</td><td style="padding:8px 12px;border-bottom:1px solid #edf2f7;font-weight:600;">${data.isHalfDay ? "0.5 (Half Day)" : data.totalDays}</td></tr>
                <tr><td style="padding:8px 12px;border-bottom:1px solid #edf2f7;color:#718096;">Reason</td><td style="padding:8px 12px;border-bottom:1px solid #edf2f7;">${data.reason}</td></tr>
                ${data.requiresDocument ? `<tr><td colspan="2" style="padding:8px 12px;background:#fef3c7;color:#92400e;font-weight:600;border-radius:4px;">⚠ Document required for this Sick Leave application</td></tr>` : ""}
            </table>
            <p style="font-size:12px;color:#718096;">Submitted: ${when} IST</p>
            <div style="margin-top:24px;padding-top:20px;border-top:1px solid #e2e8f0;font-size:12px;color:#718096;text-align:center;">
                <p>Grav Clothing Limited · Bhubaneswar, Odisha, India</p>
                <p>This is an automated notification. Please do not reply directly to this email.</p>
                <p>© ${new Date().getFullYear()} Grav Clothing. All rights reserved.</p>
            </div>
        </div>
    </div>
</body></html>`;

        const textContent = `NEW LEAVE APPLICATION\n\nEmployee: ${data.employeeName}\nDepartment: ${data.department || "—"}\nLeave Type: ${typeLabels[data.leaveType] || data.leaveType}\nFrom: ${data.fromDate}  To: ${data.toDate}\nDays: ${data.isHalfDay ? "0.5 (Half Day)" : data.totalDays}\nReason: ${data.reason}\n${data.requiresDocument ? "\n⚠ Document required for this Sick Leave." : ""}\nSubmitted: ${when} IST\n\n---\nGrav Clothing Limited · Bhubaneswar, Odisha, India\nThis is an automated notification. Please do not reply.\n© ${new Date().getFullYear()} Grav Clothing.`;

        try {
            return await this._send({
                sender: { name: this.senderName, email: this.senderEmail },
                to: [{ email: CEO_NOTIFICATION_EMAIL, name: CEO_NOTIFICATION_NAME }],
                subject,
                htmlContent,
                textContent,
            });
        } catch (error) {
            console.error("sendLeaveAppliedToHR error:", error.response?.data || error.message);
        }
    }

    // =========================================================================
    //  LEAVE REJECTED — notify employee when HR/manager rejects their leave
    // =========================================================================

    /**
     * @param {Object} data
     * @param {string} data.employeeEmail
     * @param {string} data.employeeName
     * @param {string} data.leaveType
     * @param {string} data.fromDate
     * @param {string} data.toDate
     * @param {number} data.totalDays
     * @param {string} data.reason         rejection reason
     */
    async sendLeaveRejectedToEmployee(data) {
        if (!data.employeeEmail) return;
        const typeLabels = { CL: "Casual Leave", SL: "Sick Leave", PL: "Privilege Leave" };
        const subject = `Leave Request Update: Your ${typeLabels[data.leaveType] || data.leaveType} was not approved`;

        const htmlContent = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;line-height:1.6;color:#333;max-width:600px;margin:0 auto;padding:20px;background:#f4f4f4;">
    <div style="background:#fff;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.1);overflow:hidden;">
        <div style="background:linear-gradient(135deg,#dc2626 0%,#b91c1c 100%);color:#fff;padding:24px 28px;">
            <h1 style="margin:0;font-size:20px;">Leave Not Approved</h1>
            <p style="margin:4px 0 0;font-size:13px;opacity:.9;">Your leave request has been reviewed</p>
        </div>
        <div style="padding:28px 30px;">
            <p>Dear ${data.employeeName},</p>
            <p>We regret to inform you that your leave application has not been approved.</p>
            <table style="width:100%;border-collapse:collapse;font-size:13px;margin:16px 0;">
                <tr><td style="padding:8px 12px;border-bottom:1px solid #edf2f7;color:#718096;">Leave Type</td><td style="padding:8px 12px;border-bottom:1px solid #edf2f7;font-weight:600;">${typeLabels[data.leaveType] || data.leaveType}</td></tr>
                <tr><td style="padding:8px 12px;border-bottom:1px solid #edf2f7;color:#718096;">Period</td><td style="padding:8px 12px;border-bottom:1px solid #edf2f7;">${data.fromDate} to ${data.toDate} (${data.totalDays} day${data.totalDays !== 1 ? "s" : ""})</td></tr>
                ${data.reason ? `<tr><td style="padding:8px 12px;border-bottom:1px solid #edf2f7;color:#718096;">Reason</td><td style="padding:8px 12px;border-bottom:1px solid #edf2f7;">${data.reason}</td></tr>` : ""}
            </table>
            <p style="font-size:13px;color:#4a5568;">If you have any questions, please contact HR directly.</p>
            <div style="margin-top:24px;padding-top:20px;border-top:1px solid #e2e8f0;font-size:12px;color:#718096;text-align:center;">
                <p>Grav Clothing Limited · Bhubaneswar, Odisha, India</p>
                <p>This is an automated notification. Please do not reply directly to this email.</p>
                <p>© ${new Date().getFullYear()} Grav Clothing. All rights reserved.</p>
            </div>
        </div>
    </div>
</body></html>`;

        try {
            return await this._send({
                sender: { name: this.senderName, email: this.senderEmail },
                to: [{ email: data.employeeEmail, name: data.employeeName }],
                subject,
                htmlContent,
            });
        } catch (error) {
            console.error("sendLeaveRejectedToEmployee error:", error.response?.data || error.message);
        }
    }
}

module.exports = new EmailService();