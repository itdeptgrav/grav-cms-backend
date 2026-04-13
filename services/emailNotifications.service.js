/**
 * services/emailNotifications.service.js
 *
 * Sends transactional emails via Brevo API.
 * ENV: BREVO_API_KEY, ENABLE_EMAILS, CUSTOMER_SENDER_EMAIL, COWORK_APP_URL
 *
 * TWO delivery paths:
 *   1. sendNotificationEmail()     — all in-app events with 20-min cooldown per pair
 *   2. sendWelcomeEmail()          — account creation (no cooldown)
 *   3. sendMeetingScheduledEmail() — meeting invites (no cooldown)
 *   4. sendTaskAssignedEmail()     — task assigned (no cooldown)
 *
 * COOLDOWN RULE (emails only, push notifications unaffected):
 *   Same senderId + same receiverId within 20 min → skip email
 *   Different sender OR receiver → send immediately
 *   senderId === receiverId → always send
 */

const axios = require("axios");

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";
const FROM_EMAIL = process.env.CUSTOMER_SENDER_EMAIL || "noreply@grav.in";
const FROM_NAME = "Grav CoWork";
const LOGIN_URL = process.env.COWORK_APP_URL || "https://cowork.grav.in";
const COOLDOWN_MS = 20 * 60 * 1000; // 20 minutes

// ── In-memory cooldown map ─────────────────────────────────────────────────
// Key: "senderId::receiverId"   Value: timestamp ms of last email sent
const _cooldownMap = new Map();

function _coolingDown(senderId, receiverId) {
    if (!senderId || !receiverId || senderId === receiverId) return false;
    const last = _cooldownMap.get(`${senderId}::${receiverId}`);
    return !!last && Date.now() - last < COOLDOWN_MS;
}
function _markSent(senderId, receiverId) {
    if (!senderId || !receiverId || senderId === receiverId) return;
    _cooldownMap.set(`${senderId}::${receiverId}`, Date.now());
}
// Purge stale entries every hour
setInterval(() => {
    const cutoff = Date.now() - COOLDOWN_MS;
    for (const [k, v] of _cooldownMap.entries()) if (v < cutoff) _cooldownMap.delete(k);
}, 3600000);

// ── Internal Brevo send ────────────────────────────────────────────────────
async function _send({ to, subject, html, text }) {
    if (process.env.ENABLE_EMAILS !== "true") return;
    const key = process.env.BREVO_API_KEY;
    if (!key) { console.warn("[Email] BREVO_API_KEY not set"); return; }
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
                "Precedence": "bulk",
                "List-Unsubscribe": `<mailto:${FROM_EMAIL}?subject=unsubscribe>`,
            },
        }, {
            headers: { "api-key": key, "Content-Type": "application/json", Accept: "application/json" },
            timeout: 10000,
        });
        const toStr = (Array.isArray(to) ? to : [to]).map(t => t.email).join(", ");
        console.log(`[Email] "${subject}" -> ${toStr}`);
    } catch (e) {
        console.error(`[Email] Failed "${subject}":`, e.response?.data?.message || e.message);
    }
}

// ── HTML helpers ───────────────────────────────────────────────────────────
function _wrap(title, body) {
    return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a">
  <div style="background:#2563EB;padding:16px 24px"><span style="color:#fff;font-size:18px;font-weight:700">Grav CoWork</span></div>
  <div style="padding:24px">
    <h2 style="font-size:16px;margin:0 0 16px">${title}</h2>
    ${body}
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
    <p style="font-size:12px;color:#888"><a href="${LOGIN_URL}" style="color:#2563EB">Open CoWork</a> &nbsp;·&nbsp; Emails group every 20 min per conversation to reduce inbox noise.</p>
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
    if (!receiverEmail) return;
    if (process.env.ENABLE_EMAILS !== "true") return;

    if (_coolingDown(senderId, receiverId)) {
        console.log(`[Email] Cooldown ${senderId}->${receiverId} (${type}) skipped`);
        return;
    }

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
    else if (type === "password_reset") {
        subject = `Your CoWork password was reset`;
        html = _wrap("Password Reset", `<p>Your password was reset by ${senderName}.</p><p>You have been logged out. Please log in with your new password.</p>${_btn("Log In", LOGIN_URL)}`);
    }

    // FALLBACK
    else {
        html = _wrap(title, `<p>${body}</p>${_btn("Open CoWork", app)}`);
    }

    _markSent(senderId, receiverId);

    await _send({
        to: [{ name: receiverName, email: receiverEmail }],
        subject,
        html,
        text: `${title}\n\n${body}\n\nOpen CoWork: ${app}`,
    });
}

// ── WELCOME EMAIL (no cooldown) ────────────────────────────────────────────
async function sendWelcomeEmail(employee, tempPassword) {
    const { name, email, employeeId, role, department } = employee;
    const roleLabel = role === "tl" ? "Team Lead" : "Employee";
    const html = _wrap("Welcome to CoWork", `<p>Dear ${name},</p><p>Your CoWork account has been created.</p>${_table(_row("Employee ID", employeeId), _row("Role", roleLabel), _row("Department", department || "—"), _row("Email", email), _row("Password", `<strong>${tempPassword}</strong>`))}${_btn("Log In Now", LOGIN_URL)}<p>Please change your password immediately after first login.</p>`);
    await _send({ to: [{ name, email }], subject: `Your CoWork account is ready — ${name}`, html, text: `ID: ${employeeId} | Password: ${tempPassword} | Login: ${LOGIN_URL}` });
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