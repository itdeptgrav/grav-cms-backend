/**
 * services/emailNotifications.service.js
 *
 * Sends transactional emails via Brevo API.
 * ENV: BREVO_API_KEY, ENABLE_EMAILS, CUSTOMER_SENDER_EMAIL, COWORK_APP_URL
 *
 * Every notification event sends an email immediately — no cooldown.
 * Push notifications also fire immediately (unchanged).
 */

const axios = require("axios");
const { brevoAgent } = require("../config/brevoAgent");

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";
const FROM_EMAIL = process.env.CUSTOMER_SENDER_EMAIL || "noreply@grav.in";
const FROM_NAME = "Grav CoWork";
const LOGIN_URL = process.env.COWORK_APP_URL || "https://cowork.grav.in";

// ── Internal Brevo send ────────────────────────────────────────────────────
// Returns { sent, reason } so a caller that promises the user "we emailed them"
// can tell whether that is true. Every existing caller ignores the return value,
// which is why this could be added without touching any of them.
async function _send({ to, subject, html, text }) {
    if (process.env.ENABLE_EMAILS !== "true") { console.warn(`[Email] SKIPPED "${subject}" — ENABLE_EMAILS is not "true"`); return { sent: false, reason: "Email sending is switched off on the server (ENABLE_EMAILS)." }; }
    const key = process.env.BREVO_API_KEY;
    if (!key) { console.warn("[Email] BREVO_API_KEY not set"); return { sent: false, reason: "No mail API key is configured on the server." }; }
    try {
        await axios.post(BREVO_URL, {
            sender: { name: FROM_NAME, email: FROM_EMAIL },
            to: Array.isArray(to) ? to : [to],
            subject,
            htmlContent: html,
            textContent: text,
            // Headers that improve deliverability and reduce spam scoring
            headers: {
                "X-Mailer": "Grav-CoWork-Notifications",
                "X-Priority": "3",
                "X-CoWork-Notification": "true",
                "Precedence": "bulk",
                "List-Unsubscribe": `<mailto:${FROM_EMAIL}?subject=unsubscribe>`,
            },
        }, {
            headers: { "api-key": key, "Content-Type": "application/json", Accept: "application/json" },
            timeout: 10000,
            // Pinned to one outbound address so Brevo's IP allowlist can hold —
            // see config/brevoAgent.js.
            ...(brevoAgent ? { httpsAgent: brevoAgent } : {}),
        });
        const toStr = (Array.isArray(to) ? to : [to]).map(t => t.email).join(", ");
        console.log(`[Email] "${subject}" -> ${toStr}`);
        return { sent: true };
    } catch (e) {
        const raw = e.response?.data?.message || e.message || "Unknown mail error";
        console.error(`[Email] Failed "${subject}":`, raw);
        return { sent: false, reason: _mailErrorSummary(raw, e.response?.status), detail: raw };
    }
}

/**
 * A provider error in one short line somebody can act on.
 *
 * Brevo answers in prose — the IP-allowlist refusal is three sentences and an
 * IPv6 address — and that was being passed through to a table cell verbatim,
 * where it wrapped to six lines and pushed the row apart. Length is not the
 * only problem: "We have detected you are using an unrecognised IP address"
 * describes Brevo's situation, not what the person reading it should do.
 *
 * The full text is still returned as `detail` and is always logged. Nothing is
 * hidden — it is moved to where length does not break a layout.
 */
function _mailErrorSummary(raw, status) {
    const text = String(raw);

    // The account has an IP allowlist and this server is not on it. Common after
    // a server move, a dynamic-IP change, or the first deploy to a new machine.
    if (/unrecognised IP address|unrecognized IP address|authorised_ips|authorized_ips/i.test(text)) {
        const ip = text.match(/(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7})/i)?.[1];
        // Kept short on purpose: this lands in a table cell. The IP is the one
        // piece that cannot be shortened and is the whole point of the message.
        return `Brevo is blocking this server's IP${ip ? ` (${ip})` : ""}. Add it in Brevo's authorised IPs.`;
    }
    if (status === 401) return "Brevo rejected this server's mail credentials.";
    if (/quota|credit/i.test(text)) return "Brevo has no sending credit left on this account.";
    if (status === 429) return "Brevo is rate-limiting this account. Try again shortly.";
    if (/ECONNABORTED|timeout/i.test(text)) return "The mail server did not respond in time. Try again.";

    // Unknown: pass it through, but bounded — an unbounded provider string is
    // how this became a layout bug in the first place.
    return text.length > 140 ? `${text.slice(0, 137)}…` : text;
}

// ── HTML helpers ───────────────────────────────────────────────────────────
function _wrap(title, body) {
    // The white background is load-bearing, not decoration. Without it a
    // dark-mode client paints its own dark ground behind #1a1a1a text and the
    // body of the mail comes out near-invisible — the boxed sections survive
    // only because they set their own background.
    return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;background:#ffffff">
  <div style="background:#2563EB;padding:16px 24px"><span style="color:#fff;font-size:18px;font-weight:700">Grav CoWork</span></div>
  <div style="padding:24px">
    <h2 style="font-size:16px;margin:0 0 16px">${title}</h2>
    ${body}
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
    <p style="font-size:12px;color:#888"><a href="${LOGIN_URL}" style="color:#2563EB">Open CoWork</a> &nbsp;·&nbsp; This is an automated notification from Grav CoWork.</p>
  </div>
</div>`;
}
function _row(l, v) { return `<tr><td style="padding:4px 16px 4px 0;color:#555;font-weight:600;white-space:nowrap">${l}</td><td>${v}</td></tr>`; }
function _table(...rows) { return `<table cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-size:14px;margin:12px 0">${rows.filter(Boolean).join("")}</table>`; }
function _btn(label, url) { return `<p><a href="${url}" style="display:inline-block;background:#2563EB;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600">${label}</a></p>`; }
function _quote(text, color) { return `<blockquote style="border-left:3px solid ${color || "#2563EB"};margin:8px 0;padding:8px 12px;background:#f8f9ff;border-radius:0 6px 6px 0;font-style:italic">${text}</blockquote>`; }

// ── MAIN: sendNotificationEmail ────────────────────────────────────────────
/**
 * @param {string} opts.senderId
 * @param {string} opts.senderName
 * @param {string} opts.receiverId
 * @param {string} opts.receiverName
 * @param {string} opts.receiverEmail
 * @param {string} opts.type              notification type
 * @param {string} opts.title             push title
 * @param {string} opts.body              push body
 * @param {Object} opts.data              extra context (taskId, groupId, meetId, etc.)
 */
async function sendNotificationEmail({ senderId, senderName, receiverId, receiverName, receiverEmail, type, title, body, data = {} }) {
    if (!receiverEmail) { console.warn(`[Email] SKIPPED "${type}" for ${receiverId || "unknown"} — no email on file`); return; }
    if (process.env.ENABLE_EMAILS !== "true") { console.warn(`[Email] SKIPPED "${type}" for ${receiverId || "unknown"} — ENABLE_EMAILS is not "true"`); return; }

    const app = `${LOGIN_URL}/coworking`;
    let subject = title;
    let html;

    // MESSAGES
    if (type === "direct_message") {
        subject = `New message from ${senderName}`;
        html = _wrap("New Direct Message", `<p><strong>${senderName}</strong> sent you a message:</p>${_quote(body, "#2563EB")}${_btn("Reply in CoWork", `${app}/direct-messages`)}`);
    }
    else if (type === "group_message") {
        subject = `${senderName} in ${data.groupName || "a group"}`;
        html = _wrap("New Group Message", `<p><strong>${senderName}</strong> sent a message in <strong>${data.groupName || "a group"}</strong>:</p>${_quote(body, "#7C3AED")}${_btn("Open Group Chat", `${app}/create-group/group-chat/${data.groupId || ""}`)}`);
    }
    else if (type === "group_added") {
        subject = `You were added to: ${data.groupName || "a group"}`;
        html = _wrap("Added to Group", `<p>You have been added to <strong>${data.groupName || "a group"}</strong> by ${senderName}.</p>${_btn("Open Groups", `${app}/create-group`)}`);
    }
    else if (type === "group_removed") {
        subject = `You were removed from: ${data.groupName || "a group"}`;
        html = _wrap("Removed from Group", `<p>You have been removed from <strong>${data.groupName || "a group"}</strong> by ${senderName}.</p>${_btn("Open CoWork", app)}`);
    }
    else if (type === "group_deleted") {
        subject = `Group deleted: ${data.groupName || "a group"}`;
        html = _wrap("Group Deleted", `<p>The group <strong>${data.groupName || "a group"}</strong> was deleted by ${senderName}.</p>`);
    }

    // TASKS
    else if (type === "task_assigned") {
        subject = `Task assigned: ${data.taskTitle || title}`;
        html = _wrap("Task Assigned to You", `<p><strong>${senderName}</strong> assigned you a task.</p>${_table(_row("Task", data.taskTitle || ""), _row("Priority", data.priority || "Medium"), data.dueDate ? _row("Due", new Date(data.dueDate).toLocaleDateString("en-IN", { dateStyle: "medium" })) : "", data.description ? _row("Description", data.description) : "")}${_btn("Open Tasks", `${app}/tasks`)}`);
    }
    else if (type === "task_started") {
        subject = `Work started: ${data.taskTitle || ""}`;
        html = _wrap("Work Started", `<p><strong>${senderName}</strong> started working on <strong>${data.taskTitle || ""}</strong>.</p>${_btn("View Task", `${app}/tasks`)}`);
    }
    else if (type === "task_update") {
        subject = `Progress update on: ${data.taskTitle || ""}`;
        html = _wrap("Task Progress Updated", `<p><strong>${senderName}</strong> updated progress on <strong>${data.taskTitle || ""}</strong>.</p><p style="font-size:28px;font-weight:700;color:#2563EB;margin:8px 0">${data.progressPercent ?? ""}%</p>${_btn("View Task", `${app}/tasks`)}`);
    }
    else if (type === "task_chat") {
        subject = `New message in task: ${data.taskTitle || ""}`;
        html = _wrap("Task Chat Message", `<p><strong>${senderName}</strong> sent a message in <strong>${data.taskTitle || "a task"}</strong>:</p>${_quote(body, "#2563EB")}${_btn("Open Task Chat", `${app}/tasks`)}`);
    }
    else if (type === "daily_report") {
        subject = `Daily report: ${data.taskTitle || ""}`;
        html = _wrap("Daily Report Submitted", `<p><strong>${senderName}</strong> submitted a daily report for <strong>${data.taskTitle || "a task"}</strong>.</p><p>${body}</p>${_btn("View Report", `${app}/tasks`)}`);
    }
    else if (type === "task_forwarded") {
        subject = `Task forwarded: ${data.taskTitle || ""}`;
        html = _wrap("Task Forwarded", `<p><strong>${senderName}</strong> forwarded <strong>${data.taskTitle || "a task"}</strong> to <strong>${data.forwardedToName || "another employee"}</strong>.</p>${_btn("View Task", `${app}/tasks`)}`);
    }
    else if (type === "task_deleted") {
        subject = `Task deleted: ${data.taskTitle || ""}`;
        html = _wrap("Task Deleted", `<p>The task <strong>${data.taskTitle || ""}</strong> was deleted by ${senderName}.</p>`);
    }
    else if (type === "deadline_changed") {
        subject = `Deadline changed: ${data.taskTitle || ""}`;
        html = _wrap("Task Deadline Changed", `<p><strong>${senderName}</strong> changed the deadline for <strong>${data.taskTitle || "a task"}</strong>.</p><p>${body}</p>${_btn("View Task", `${app}/tasks`)}`);
    }
    else if (type === "completion_submitted") {
        subject = `Work submitted for review: ${data.taskTitle || ""}`;
        html = _wrap("Work Submitted for Review", `<p><strong>${senderName}</strong> submitted work on <strong>${data.taskTitle || "a task"}</strong> for your review.</p>${_btn("Review Now", `${app}/tasks`)}`);
    }
    else if (type === "completion_tl_approved") {
        subject = `TL approved work: ${data.taskTitle || ""}`;
        html = _wrap("Work Approved by TL", `<p><strong>${senderName}</strong> approved the work on <strong>${data.taskTitle || "a task"}</strong>.</p><p>${body}</p>${_btn("View Task", `${app}/tasks`)}`);
    }
    else if (type === "completion_rejected") {
        subject = `Work rejected: ${data.taskTitle || ""}`;
        html = _wrap("Work Rejected", `<p><strong>${senderName}</strong> rejected the work on <strong>${data.taskTitle || "a task"}</strong>.</p><p><strong>Reason:</strong> ${data.reason || body}</p>${_btn("View Task", `${app}/tasks`)}`);
    }
    else if (type === "completion_ceo_approved") {
        subject = `Task complete: ${data.taskTitle || ""}`;
        html = _wrap("Task Approved — Complete!", `<p>CEO approved the work on <strong>${data.taskTitle || "a task"}</strong>. Task is done!</p>${_btn("View Task", `${app}/tasks`)}`);
    }
    else if (type === "completion_ceo_rejected") {
        subject = `Task rejected by CEO: ${data.taskTitle || ""}`;
        html = _wrap("Task Rejected by CEO", `<p>CEO rejected the work on <strong>${data.taskTitle || "a task"}</strong>.</p><p><strong>Reason:</strong> ${data.reason || body}</p>${_btn("View Task", `${app}/tasks`)}`);
    }

    // MEETINGS
    else if (type === "meet_scheduled") {
        const ds = data.dateTime ? new Date(data.dateTime).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "TBD";
        subject = `Meeting invitation: ${data.meetTitle || title}`;
        html = _wrap("Meeting Scheduled", `<p><strong>${senderName}</strong> scheduled a meeting and you are invited.</p>${_table(_row("Title", data.meetTitle || ""), _row("Date & Time", ds), _row("Organised by", senderName))}${_btn("View Meeting", `${app}/schedule-meet`)}`);
    }
    else if (type === "meet_cancelled") {
        subject = `Meeting cancelled: ${data.meetTitle || title}`;
        html = _wrap("Meeting Cancelled", `<p>The meeting <strong>${data.meetTitle || ""}</strong> was cancelled by ${senderName}.</p>`);
    }
    else if (type === "meet_updated") {
        const ds = data.dateTime ? new Date(data.dateTime).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";
        subject = `Meeting rescheduled: ${data.meetTitle || title}`;
        html = _wrap("Meeting Updated", `<p>The meeting <strong>${data.meetTitle || ""}</strong> was updated by ${senderName}.</p><p><strong>New time:</strong> ${ds}</p>${_btn("View Meeting", `${app}/schedule-meet`)}`);
    }
    else if (type === "meet_reminder") {
        subject = `Meeting in 15 minutes: ${data.meetTitle || ""}`;
        html = _wrap("Meeting Starting Soon", `<p>Your meeting <strong>${data.meetTitle || ""}</strong> starts in <strong>15 minutes</strong>.</p>${_btn("Join Meeting", `${LOGIN_URL}/coworking/cowork-meeting/${data.meetId || ""}`)}`);
    }

    // REQUESTS
    else if (type === "request") {
        subject = `New request from ${senderName}: ${data.subject || body}`;
        html = _wrap("New Request", `<p><strong>${senderName}</strong> sent you a request.</p>${_table(_row("Subject", data.subject || body), data.priority ? _row("Priority", data.priority) : "", data.dueDate ? _row("Due Date", new Date(data.dueDate).toLocaleDateString("en-IN", { dateStyle: "medium" })) : "", data.message ? _row("Message", data.message) : "")}${_btn("View Request", app)}`);
    }
    else if (type === "request_approved") {
        subject = `Request approved: ${data.subject || ""}`;
        html = _wrap("Request Approved", `<p><strong>${senderName}</strong> approved your request <strong>${data.subject || ""}</strong>.</p>${data.responseMessage ? `<p><strong>Response:</strong> ${data.responseMessage}</p>` : ""}${_btn("View Request", app)}`);
    }
    else if (type === "request_rejected") {
        subject = `Request rejected: ${data.subject || ""}`;
        html = _wrap("Request Rejected", `<p><strong>${senderName}</strong> rejected your request <strong>${data.subject || ""}</strong>.</p>${data.responseMessage ? `<p><strong>Reason:</strong> ${data.responseMessage}</p>` : ""}${_btn("View Request", app)}`);
    }

    // ACCOUNT
    else if (type === "role_changed") {
        const roleLabel = data.newRole === "tl" ? "Team Lead" : "Employee";
        subject = `Your CoWork role has been updated to ${roleLabel}`;
        html = _wrap("Role Changed", `<p>Your CoWork role has been updated to <strong>${roleLabel}</strong> by ${senderName}.</p><p>You have been logged out. Please log in again to continue.</p>${_btn("Log In", LOGIN_URL)}`);
    }
    else if (type === "department_changed") {
        subject = `Your CoWork department has been updated to ${data.newDepartment || ""}`;
        html = _wrap("Department Changed", `<p>Your CoWork department has been updated by ${senderName}.</p>${_table(data.oldDepartment ? _row("Previous Department", data.oldDepartment) : "", _row("New Department", data.newDepartment || ""))}${_btn("Open CoWork", app)}`);
    }
    else if (type === "password_reset") {
        subject = `Your CoWork password was reset`;
        html = _wrap("Password Reset", `<p>Your password was reset by ${senderName}.</p><p>You have been logged out. Please log in with your new password.</p>${_btn("Log In", LOGIN_URL)}`);
    }

    // GOAL TASK ACTIVITIES
    else if (type === "goal_final_submit") {
        subject = `Goal roadmap submitted: ${data.taskTitle || ""}`;
        html = _wrap("Goal Roadmap Submitted", `
            <p><strong>${senderName}</strong> has submitted the activity roadmap for goal task <strong>${data.taskTitle || ""}</strong>.</p>
            ${_table(
            _row("Task", data.taskTitle || ""),
            _row("Components", data.componentCount ? `${data.componentCount} component${data.componentCount !== 1 ? "s" : ""}` : "—"),
            _row("Submitted At", data.submittedAt || "")
        )}
            <p>Please review the submitted plan.</p>
            ${_btn("Review Goal Task", `${app}/tasks`)}
        `);
    }
    else if (type === "goal_component_done") {
        subject = `Component completed: ${data.componentTitle || ""} — ${data.taskTitle || ""}`;
        html = _wrap("Goal Component Marked Done", `
            <p><strong>${senderName}</strong> completed a component in goal task <strong>${data.taskTitle || ""}</strong>.</p>
            ${_table(
            _row("Task", data.taskTitle || ""),
            _row("Component", data.componentTitle || ""),
            _row("Completed At", data.doneAt || ""),
            _row("Progress", data.progress || "")
        )}
            ${data.reportText ? `<p><strong>Report notes:</strong></p>${_quote(data.reportText, "#22C55E")}` : ""}
            ${_btn("View Task", `${app}/tasks`)}
        `);
    }
    else if (type === "goal_report_submitted") {
        subject = `Report submitted for: ${data.componentTitle || ""} — ${data.taskTitle || ""}`;
        html = _wrap("Goal Component Report Submitted", `
            <p><strong>${senderName}</strong> submitted a completion report for component <strong>${data.componentTitle || ""}</strong> in goal task <strong>${data.taskTitle || ""}</strong>.</p>
            ${_table(
            _row("Task", data.taskTitle || ""),
            _row("Component", data.componentTitle || ""),
            _row("Submitted At", data.submittedAt || ""),
            data.fileCount ? _row("Attachments", `${data.fileCount} file${data.fileCount !== 1 ? "s" : ""}`) : ""
        )}
            ${data.reportText ? `<p><strong>Report:</strong></p>${_quote(data.reportText, "#2563EB")}` : ""}
            ${_btn("View Report", `${app}/tasks`)}
        `);
    }

    // FALLBACK
    else {
        html = _wrap(title, `<p>${body}</p>${_btn("Open CoWork", app)}`);
    }

    await _send({
        to: [{ name: receiverName, email: receiverEmail }],
        subject,
        html,
        text: `${title}\n\n${body}\n\nOpen CoWork: ${app}`,
    });
}

// ── WELCOME EMAIL (no cooldown) ────────────────────────────────────────────
// This is the one an employee reads before they have ever seen the product, so
// it carries more than the bare credentials: what CoWork is, what their id is
// for, and a plain instruction to change the password. Returns { sent, reason }
// so the admin who created the account is told whether it actually went out —
// they hold the only other copy of the temporary password.
async function sendWelcomeEmail(employee, tempPassword) {
    const { name, email, employeeId, role, department } = employee;
    if (!email) return { sent: false, reason: "That employee has no email address on file." };
    const roleLabel = role === "tl" ? "Team Lead" : "Employee";

    const cred = (label, value, mono) =>
        `<tr><td style="padding:9px 14px;border-bottom:1px solid #e5e7eb;font-size:13px;color:#555;width:44%">${label}</td>` +
        `<td style="padding:9px 14px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#111;font-weight:600${mono ? ";font-family:'Courier New',Courier,monospace;letter-spacing:.5px" : ""}">${value}</td></tr>`;

    const body = `
<p>Dear ${name},</p>
<p>An account has been created for you on <strong>Grav CoWork</strong> — the workspace where your tasks, projects, meetings, messages and performance record are kept. You can sign in using the details below.</p>
<table style="width:100%;border-collapse:collapse;background:#f8f9fb;border:1px solid #e5e7eb;border-radius:6px;margin:18px 0">
${cred("Employee ID", employeeId)}
${cred("Email address", email)}
${cred("Temporary password", tempPassword, true)}
${cred("Role", roleLabel)}
${department ? cred("Department", department) : ""}
</table>
${_btn("Sign in to CoWork", LOGIN_URL)}
<div style="background:#fffbeb;border:1px solid #fde68a;border-left:3px solid #f59e0b;border-radius:0 6px 6px 0;padding:12px 14px;margin:18px 0;font-size:13px;color:#78350f">
<strong>Please change this password when you first sign in.</strong> It is temporary, it was generated for you, and it should not be shared with anyone — including anyone claiming to be from IT.
</div>
<p style="font-size:13px;color:#666;margin-bottom:0">If you were not expecting this email, or believe you have received it in error, please contact your manager or the IT department before signing in.</p>`;

    const text = `YOUR COWORK ACCOUNT IS READY

Dear ${name},

An account has been created for you on Grav CoWork - the workspace where
your tasks, projects, meetings, messages and performance record are kept.

  Employee ID .......... ${employeeId}
  Email address ........ ${email}
  Temporary password ... ${tempPassword}
  Role ................. ${roleLabel}${department ? `\n  Department ........... ${department}` : ""}

Sign in: ${LOGIN_URL}

IMPORTANT: Please change this password when you first sign in. It is
temporary, it was generated for you, and it should not be shared with
anyone - including anyone claiming to be from IT.

If you were not expecting this email, contact your manager or the IT
department before signing in.

--
This is an automated message from Grav CoWork. Please do not reply to it.`;

    return _send({
        to: [{ name, email }],
        subject: "Your CoWork account is ready — sign-in details inside",
        html: _wrap("Welcome to CoWork", body),
        text,
    });
}

// ── TASK ASSIGNED EMAIL (no cooldown) ─────────────────────────────────────
async function sendTaskAssignedEmail(task, assignees) {
    if (!assignees?.length) return;
    const { title, description, assignedByName, dueDate, priority, type, parentTitle } = task;
    const tl = type === "subtask" ? "Subtask" : type === "forwarded" ? "Forwarded Task" : "Task";
    for (const a of assignees) {
        if (!a?.email) continue;
        const html = _wrap(`${tl} Assigned to You`, `<p>Dear ${a.name},</p><p>A ${tl.toLowerCase()} was assigned to you.</p>${_table(_row("Title", title), parentTitle ? _row("Parent Task", parentTitle) : "", _row("Assigned By", assignedByName), _row("Priority", priority || "Medium"), _row("Due Date", dueDate || "Not specified"), description ? _row("Description", description) : "")}${_btn("Open Tasks", `${LOGIN_URL}/coworking/tasks`)}`);
        await _send({ to: [{ name: a.name, email: a.email }], subject: `${tl} Assigned: ${title}`, html, text: `${tl}: ${title}\nBy: ${assignedByName}\nLogin: ${LOGIN_URL}` });
    }
}

// ── MEETING SCHEDULED EMAIL (no cooldown) ─────────────────────────────────
async function sendMeetingScheduledEmail(meeting, participants) {
    if (!participants?.length) return;
    const { meetId, title, description, dateTime, createdByName, googleMeetLink } = meeting;
    const ds = dateTime ? new Date(dateTime).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "TBD";
    const meetUrl = `${LOGIN_URL}/coworking/cowork-meeting/${meetId}`;
    for (const p of participants) {
        if (!p?.email) continue;
        const html = _wrap("Meeting Invitation", `<p>Dear ${p.name},</p><p>A meeting has been scheduled and you are invited.</p>${_table(_row("Title", title), description ? _row("Description", description) : "", _row("Date & Time", ds), _row("Organised By", createdByName), _row("Join Link", `<a href="${meetUrl}">${meetUrl}</a>`), googleMeetLink ? _row("Google Meet", `<a href="${googleMeetLink}">${googleMeetLink}</a>`) : "")}${_btn("Join Meeting", meetUrl)}`);
        await _send({ to: [{ name: p.name, email: p.email }], subject: `Meeting Scheduled: ${title}`, html, text: `Meeting: ${title}\nTime: ${ds}\nOrganised by: ${createdByName}\nJoin: ${meetUrl}` });
    }
}

module.exports = { sendNotificationEmail, sendWelcomeEmail, sendTaskAssignedEmail, sendMeetingScheduledEmail };