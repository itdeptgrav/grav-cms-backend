/**
 * services/emailNotifications.service.js
 *
 * Sends transactional emails via Brevo SMTP API.
 * Two functions:
 *   sendWelcomeEmail(employee, tempPassword)   – called when a new employee/TL is created
 *   sendTaskAssignedEmail(task, assignees)     – called when a task/subtask/forwarded task is assigned
 *
 * Emails are plain, professional, no decorative design.
 * ENV: BREVO_API_KEY
 */

const axios = require("axios");

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";
const FROM_EMAIL = process.env.CUSTOMER_SENDER_EMAIL || "noreply@grav.in";
const FROM_NAME = "Grav CoWork";
const LOGIN_URL = process.env.COWORK_APP_URL || "https://cowork.grav.in";

// ── Internal: send via Brevo ─────────────────────────────────────────────────
async function sendEmail({ to, subject, html, text }) {
    const apiKey = process.env.BREVO_API_KEY;
    if (!apiKey) {
        console.warn("[EmailNotifications] BREVO_API_KEY not set — skipping email.");
        return;
    }
    try {
        await axios.post(
            BREVO_URL,
            {
                sender: { name: FROM_NAME, email: FROM_EMAIL },
                to: Array.isArray(to) ? to : [to],
                subject,
                htmlContent: html,
                textContent: text,
            },
            {
                headers: {
                    "api-key": apiKey,
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                timeout: 10000,
            }
        );
        console.log(`[EmailNotifications] Sent "${subject}" → ${to.map ? to.map(t => t.email).join(", ") : to.email}`);
    } catch (err) {
        // Log but don't throw — email failure should never break the main action
        console.error(`[EmailNotifications] Failed to send "${subject}":`, err.response?.data?.message || err.message);
    }
}

// ── 1. WELCOME EMAIL — new employee or TL account created ────────────────────
/**
 * @param {Object} employee
 * @param {string} employee.name
 * @param {string} employee.email
 * @param {string} employee.employeeId
 * @param {string} employee.role          "employee" | "tl"
 * @param {string} employee.department
 * @param {string} tempPassword           Temporary password to include in email
 */
async function sendWelcomeEmail(employee, tempPassword) {
    const { name, email, employeeId, role, department } = employee;
    const roleLabel = role === "tl" ? "Team Lead" : "Employee";
    const subject = `Your CoWork account is ready — ${name}`;

    const text = `
Dear ${name},

Your CoWork account has been created. Below are your login credentials.

  Employee ID  : ${employeeId}
  Role         : ${roleLabel}
  Department   : ${department || "—"}
  Email        : ${email}
  Password     : ${tempPassword}
  Login URL    : ${LOGIN_URL}

Please log in and change your password immediately after your first sign-in.

If you have any questions, contact your administrator.

Regards,
Grav CoWork Team
`.trim();

    const html = `
<p>Dear ${name},</p>
<p>Your CoWork account has been created. Below are your login credentials.</p>
<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:14px;">
  <tr><td style="padding:4px 16px 4px 0;color:#555;font-weight:600;">Employee ID</td><td>${employeeId}</td></tr>
  <tr><td style="padding:4px 16px 4px 0;color:#555;font-weight:600;">Role</td><td>${roleLabel}</td></tr>
  <tr><td style="padding:4px 16px 4px 0;color:#555;font-weight:600;">Department</td><td>${department || "—"}</td></tr>
  <tr><td style="padding:4px 16px 4px 0;color:#555;font-weight:600;">Email</td><td>${email}</td></tr>
  <tr><td style="padding:4px 16px 4px 0;color:#555;font-weight:600;">Password</td><td><strong>${tempPassword}</strong></td></tr>
</table>
<p>Please log in at <a href="${LOGIN_URL}">${LOGIN_URL}</a> and change your password immediately.</p>
<p>If you have any questions, contact your administrator.</p>
<p>Regards,<br>Grav CoWork Team</p>
`.trim();

    await sendEmail({ to: [{ name, email }], subject, html, text });
}

// ── 2. TASK ASSIGNED EMAIL ────────────────────────────────────────────────────
/**
 * @param {Object} task
 * @param {string} task.taskId
 * @param {string} task.title
 * @param {string} task.description
 * @param {string} task.assignedByName
 * @param {string} task.dueDate           "YYYY-MM-DD" | null
 * @param {string} task.priority          "low" | "medium" | "high"
 * @param {string} task.type              "task" | "subtask" | "forwarded"
 * @param {string} task.parentTitle       Parent task title if subtask/forwarded (optional)
 *
 * @param {Array}  assignees              [{ name, email }]
 */
async function sendTaskAssignedEmail(task, assignees) {
    if (!assignees?.length) return;

    const { taskId, title, description, assignedByName, dueDate, priority, type, parentTitle } = task;

    const typeLabel = type === "subtask" ? "Subtask"
        : type === "forwarded" ? "Forwarded Task"
            : "Task";

    const subject = `${typeLabel} Assigned: ${title}`;

    for (const assignee of assignees) {
        if (!assignee?.email) continue;

        const text = `
Dear ${assignee.name},

A ${typeLabel.toLowerCase()} has been assigned to you on CoWork.

  Title        : ${title}
  ${parentTitle ? `Parent Task  : ${parentTitle}\n  ` : ""}Assigned By  : ${assignedByName}
  Priority     : ${priority || "medium"}
  Due Date     : ${dueDate || "Not specified"}
  ${description ? `Description  : ${description}\n  ` : ""}
Login to view and start working on this task:
${LOGIN_URL}

Regards,
Grav CoWork Team
`.trim();

        const html = `
<p>Dear ${assignee.name},</p>
<p>A ${typeLabel.toLowerCase()} has been assigned to you on CoWork.</p>
<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:14px;">
  <tr><td style="padding:4px 16px 4px 0;color:#555;font-weight:600;">Title</td><td>${title}</td></tr>
  ${parentTitle ? `<tr><td style="padding:4px 16px 4px 0;color:#555;font-weight:600;">Parent Task</td><td>${parentTitle}</td></tr>` : ""}
  <tr><td style="padding:4px 16px 4px 0;color:#555;font-weight:600;">Assigned By</td><td>${assignedByName}</td></tr>
  <tr><td style="padding:4px 16px 4px 0;color:#555;font-weight:600;">Priority</td><td>${priority || "Medium"}</td></tr>
  <tr><td style="padding:4px 16px 4px 0;color:#555;font-weight:600;">Due Date</td><td>${dueDate || "Not specified"}</td></tr>
  ${description ? `<tr><td style="padding:4px 16px 4px 0;color:#555;font-weight:600;vertical-align:top;">Description</td><td>${description}</td></tr>` : ""}
</table>
<p>Log in to view and start working on this task: <a href="${LOGIN_URL}">${LOGIN_URL}</a></p>
<p>Regards,<br>Grav CoWork Team</p>
`.trim();

        await sendEmail({ to: [{ name: assignee.name, email: assignee.email }], subject, html, text });
    }
}

module.exports = { sendWelcomeEmail, sendTaskAssignedEmail, sendMeetingScheduledEmail };

// ── 3. MEETING SCHEDULED EMAIL ────────────────────────────────────────────────
/**
 * @param {Object} meeting
 * @param {string} meeting.meetId
 * @param {string} meeting.title
 * @param {string} meeting.description
 * @param {string} meeting.dateTime       ISO string
 * @param {string} meeting.createdByName
 * @param {string} meeting.googleMeetLink optional
 * @param {Array}  participants           [{ name, email }]
 */
async function sendMeetingScheduledEmail(meeting, participants) {
    if (!participants?.length) return;

    const { meetId, title, description, dateTime, createdByName, googleMeetLink } = meeting;

    const dateStr = dateTime
        ? new Date(dateTime).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })
        : "Not specified";

    const subject = `Meeting Scheduled: ${title}`;
    const meetUrl = `${LOGIN_URL}/coworking/cowork-meeting/${meetId}`;

    for (const participant of participants) {
        if (!participant?.email) continue;

        const text = `
Dear ${participant.name},

A meeting has been scheduled and you are invited.

  Title        : ${title}
  ${description ? `Description  : ${description}\n  ` : ""}Date & Time  : ${dateStr}
  Organised By : ${createdByName}
  Join Link    : ${meetUrl}
  ${googleMeetLink ? `Google Meet  : ${googleMeetLink}\n  ` : ""}
Please log in to CoWork to join the meeting at the scheduled time.

Regards,
Grav CoWork Team
`.trim();

        const html = `
<p>Dear ${participant.name},</p>
<p>A meeting has been scheduled and you are invited.</p>
<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:14px;">
  <tr><td style="padding:4px 16px 4px 0;color:#555;font-weight:600;">Title</td><td>${title}</td></tr>
  ${description ? `<tr><td style="padding:4px 16px 4px 0;color:#555;font-weight:600;vertical-align:top;">Description</td><td>${description}</td></tr>` : ""}
  <tr><td style="padding:4px 16px 4px 0;color:#555;font-weight:600;">Date &amp; Time</td><td>${dateStr}</td></tr>
  <tr><td style="padding:4px 16px 4px 0;color:#555;font-weight:600;">Organised By</td><td>${createdByName}</td></tr>
  <tr><td style="padding:4px 16px 4px 0;color:#555;font-weight:600;">Join Link</td><td><a href="${meetUrl}">${meetUrl}</a></td></tr>
  ${googleMeetLink ? `<tr><td style="padding:4px 16px 4px 0;color:#555;font-weight:600;">Google Meet</td><td><a href="${googleMeetLink}">${googleMeetLink}</a></td></tr>` : ""}
</table>
<p>Please log in to CoWork to join the meeting at the scheduled time.</p>
<p>Regards,<br>Grav CoWork Team</p>
`.trim();

        await sendEmail({ to: [{ name: participant.name, email: participant.email }], subject, html, text });
    }
}