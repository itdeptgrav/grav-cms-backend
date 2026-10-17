// services/followUps/followUps.service.js
//
// Reads and writes follow-ups (models/CMS_Models/FollowUps/FollowUp.js), finds
// the people of a department, raises and closes the automatic ones at the
// hand-offs, and mails the person a follow-up is for. Every rule it applies is
// asked of followUpRules.js.
//
// Mail goes through departmentNotify's Brevo sender, so it obeys the same
// ENABLE_EMAILS switch. Nothing here ever throws into the request that
// triggered an automatic follow-up — callers use the `safe*` wrappers.
"use strict";

const mongoose = require("mongoose");
const FollowUp = require("../../models/CMS_Models/FollowUps/FollowUp");
const AccessDepartment = require("../../models/Access/AccessDepartment");
const DeptUser = require("../../models/Access/DeptUser");
const Employee = require("../../models/Employee");
const SystemSetting = require("../../models/DevOps/SystemSetting");
const rules = require("./followUpRules");
const { sendCmsEmail, wrapEmail, escapeHtml, APP_URL } = require("../departmentNotify.service");

const SETTINGS_KEY = "followups.settings";
const SYSTEM_ACTOR = Object.freeze({ id: "", name: "GRAV (automatic)", email: "", system: true });

class FollowUpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

// ── Who is asking ───────────────────────────────────────────────────────────

/** The signed-in person, in the shape the rules take. */
function meOf(req) {
  const u = req.user || {};
  return {
    id: String(u.id || ""),
    email: String(u.email || "").toLowerCase(),
    name: String(u.name || ""),
    dept: rules.deptOfSlug(u.deptSlug),
    slug: String(u.deptSlug || ""),
    isAdmin: Boolean(u.isAdmin),
  };
}

/**
 * The signed-in person, seen from the portal they are in. One login opens
 * several portals (a merchandiser with a PPC grant), and the token carries
 * only the department it was issued for — so the page says which portal it
 * is (`?as=ppc`) and that is believed only when the person really works
 * there (or is an admin). Otherwise the token's own department stands.
 */
async function resolveMe(req) {
  const me = meOf(req);
  const as = String(req.query?.as || "").trim();
  if (as && as !== me.dept && rules.deptByKey(as)) {
    if (me.isAdmin) return { ...me, dept: as };
    const people = await departmentPeople(as);
    if (people.some((p) => rules.samePerson(p, me))) return { ...me, dept: as };
  }
  return me;
}

function actorOf(me) {
  return { id: me.id, name: me.name || me.email, email: me.email, dept: me.dept || me.slug || "", system: false };
}

// ── The people of a department ──────────────────────────────────────────────

const peopleCache = new Map(); // key → { at, people }
const PEOPLE_TTL_MS = 60 * 1000;

/**
 * Everybody who can open this department's portal: dept_users rows in it and
 * employees holding it as primary OR as an extra grant. Primary first. Unlike
 * the department emails (primary only — "whose work it is"), a follow-up is
 * addressed to ONE named person, so anybody who works there may be chosen.
 */
async function departmentPeople(key) {
  const dept = rules.deptByKey(key);
  if (!dept) return [];
  const hit = peopleCache.get(key);
  if (hit && Date.now() - hit.at < PEOPLE_TTL_MS) return hit.people;

  const rows = await AccessDepartment.find({ slug: { $in: dept.slugs }, isActive: true }).select("_id").lean();
  const ids = rows.map((r) => r._id);
  const byKey = new Map();
  const add = (p) => {
    const k = p.email || `id:${p.id}`;
    if (!byKey.has(k) || (p.primary && !byKey.get(k).primary)) byKey.set(k, p);
  };
  if (ids.length) {
    const active = { $or: [{ status: "active" }, { isActive: true }] };
    const [users, primary, extra] = await Promise.all([
      DeptUser.find({ departmentId: { $in: ids }, isActive: true }).select("name email").lean(),
      Employee.find({ $and: [active, { accessDepartmentId: { $in: ids } }] }).select("firstName lastName email").lean(),
      Employee.find({ $and: [active, { additionalDepartmentIds: { $in: ids } }] }).select("firstName lastName email").lean(),
    ]);
    const nameOf = (e) => `${e.firstName || ""} ${e.lastName || ""}`.trim() || e.email || "";
    for (const u of users) add({ id: String(u._id), kind: "deptUser", name: u.name || u.email || "", email: String(u.email || "").toLowerCase(), primary: true });
    for (const e of primary) add({ id: String(e._id), kind: "employee", name: nameOf(e), email: String(e.email || "").toLowerCase(), primary: true });
    for (const e of extra) add({ id: String(e._id), kind: "employee", name: nameOf(e), email: String(e.email || "").toLowerCase(), primary: false });
  }
  const people = [...byKey.values()]
    .filter((p) => p.name || p.email)
    .sort((a, b) => (a.primary === b.primary ? a.name.localeCompare(b.name) : a.primary ? -1 : 1));
  peopleCache.set(key, { at: Date.now(), people });
  return people;
}

/** The person in `key`'s people matching `wanted` (by email, else id), or null. */
async function findPerson(key, wanted) {
  if (!wanted) return null;
  const people = await departmentPeople(key);
  const p = people.find((x) => rules.samePerson(x, wanted));
  return p ? { id: p.id, kind: p.kind, name: p.name, email: p.email } : null;
}

// ── Settings: the default person per department ─────────────────────────────

async function getSettings() {
  const row = await SystemSetting.findOne({ key: SETTINGS_KEY }).lean();
  const value = row?.value && typeof row.value === "object" ? row.value : {};
  return { defaults: value.defaults && typeof value.defaults === "object" ? value.defaults : {} };
}

/** Set (or clear, with null) the default person of one department. A member
 *  of that department may set its own; an admin may set any. */
async function setDefaultPerson(me, deptKey, person) {
  if (!rules.deptByKey(deptKey)) throw new FollowUpError(400, "Unknown department.");
  if (!me.isAdmin && me.dept !== deptKey) {
    throw new FollowUpError(403, "Only somebody in that department, or an admin, can choose its default person.");
  }
  let chosen = null;
  if (person) {
    chosen = await findPerson(deptKey, person);
    if (!chosen) throw new FollowUpError(400, "That person does not work in this department.");
  }
  const current = await getSettings();
  const defaults = { ...current.defaults, [deptKey]: chosen };
  const value = { defaults };
  await SystemSetting.findOneAndUpdate(
    { key: SETTINGS_KEY },
    {
      $set: { value, updatedByEmail: me.email, updatedByName: me.name },
      $push: { history: { $each: [{ at: new Date(), byEmail: me.email, byName: me.name, from: current, to: value }], $position: 0, $slice: 20 } },
    },
    { upsert: true },
  );
  return { defaults };
}

// ── Subjects ────────────────────────────────────────────────────────────────

function models() {
  return {
    SampleStyle: mongoose.models.SampleStyle || require("../../models/CMS_Models/Sales/SampleStyle"),
    CustomerRequest: mongoose.models.CustomerRequest || require("../../models/Customer_Models/CustomerRequest"),
  };
}

/** The label and code a subject is shown with, read from the record itself. */
async function resolveSubject(subject) {
  const type = subject?.type;
  const id = String(subject?.id || "");
  if (type === "none" || !type) return { type: "none", id: "", label: "", code: "" };
  if (!mongoose.Types.ObjectId.isValid(id)) throw new FollowUpError(400, "That record does not exist.");
  const { SampleStyle, CustomerRequest } = models();
  if (type === "style") {
    const s = await SampleStyle.findById(id).select("productName styleCode sampleStyleId").lean();
    if (!s) throw new FollowUpError(404, "That style does not exist.");
    return { type, id, label: s.productName || "", code: s.styleCode || s.sampleStyleId || "" };
  }
  if (type === "order") {
    const o = await CustomerRequest.findById(id).select("requestId customerInfo.name").lean();
    if (!o) throw new FollowUpError(404, "That order does not exist.");
    // The MO number as PPC shows it (services/ppc/control/orders.service.js).
    return { type, id, label: o.customerInfo?.name || "", code: o.requestId ? `MO-${o.requestId}` : "" };
  }
  throw new FollowUpError(400, "A follow-up is about a style, an order, or nothing.");
}

/** Styles and orders matching a search, for the "about" picker. */
async function searchSubjects(q) {
  const text = String(q || "").trim();
  if (text.length < 2) return [];
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp(escape(text), "i");
  // An order is shown as "MO-<requestId>", so a search may carry the prefix.
  const requestRx = new RegExp(escape(text.replace(/^MO-/i, "")), "i");
  const { SampleStyle, CustomerRequest } = models();
  const [styles, orders] = await Promise.all([
    SampleStyle.find({ $or: [{ productName: rx }, { styleCode: rx }, { sampleStyleId: rx }] })
      .select("productName styleCode sampleStyleId stage").sort({ updatedAt: -1 }).limit(10).lean(),
    CustomerRequest.find({ $or: [{ requestId: requestRx }, { "customerInfo.name": rx }] })
      .select("requestId customerInfo.name status").sort({ updatedAt: -1 }).limit(10).lean(),
  ]);
  return [
    ...styles.map((s) => ({ type: "style", id: String(s._id), label: s.productName || "", code: s.styleCode || s.sampleStyleId || "", note: s.stage || "" })),
    ...orders.map((o) => ({ type: "order", id: String(o._id), label: o.customerInfo?.name || "", code: o.requestId ? `MO-${o.requestId}` : "", note: o.status || "" })),
  ];
}

// ── Mail ────────────────────────────────────────────────────────────────────

function portalLink(deptKey, fu) {
  const portal = rules.deptByKey(deptKey)?.portal || "/ppc";
  return `${APP_URL}${portal}/follow-ups?open=${fu._id}`;
}

function fmtDate(d) {
  return d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "";
}

function aboutText(fu) {
  if (!fu.subject || fu.subject.type === "none") return "";
  const what = fu.subject.type === "style" ? "Style" : "Order";
  return `${what} ${[fu.subject.code, fu.subject.label].filter(Boolean).join(" · ")}`;
}

/** Mail one follow-up to some people. Best-effort; never throws. */
async function mail(fu, recipients, { heading, line, deptKey }) {
  try {
    const to = recipients.filter((r) => r && r.email).map((r) => ({ email: r.email, name: r.name || r.email }));
    if (!to.length) return;
    const url = portalLink(deptKey || fu.toDept, fu);
    const details = [
      ["Follow-up", `${fu.number} · ${fu.title}`],
      ["About", aboutText(fu) || undefined],
      ["From", `${fu.raisedBy?.name || ""} (${rules.deptByKey(fu.fromDept)?.label || fu.fromDept})`],
      ["For", `${fu.assignee?.name || "Nobody named yet"} (${rules.deptByKey(fu.toDept)?.label || fu.toDept})`],
      ["Needed by", fmtDate(fu.dueAt) || undefined],
    ];
    const html = wrapEmail({
      heading: escapeHtml(heading),
      bodyHtml: `<p>${escapeHtml(line)}</p>${fu.detail ? `<p style="margin:10px 0 0;color:#475569">${escapeHtml(fu.detail)}</p>` : ""}`,
      details,
      ctaLabel: "Open the follow-up",
      ctaUrl: url,
    }).replace("Turn these off from Sales &rarr; Settings &rarr; Department Notifications.", "You are getting this because a follow-up is waiting on you.");
    const text = `${line}\n${fu.number} · ${fu.title}${aboutText(fu) ? `\n${aboutText(fu)}` : ""}\nNeeded by ${fmtDate(fu.dueAt) || "—"}\n${url}`;
    await sendCmsEmail({ to, subject: `${heading} — ${fu.number}`, html, text });
  } catch (err) {
    console.warn("[followUps] mail failed:", err.message);
  }
}

/** The people to mail when a follow-up names nobody: everyone in the department. */
async function departmentRecipients(deptKey) {
  return (await departmentPeople(deptKey)).filter((p) => p.email);
}

async function mailAssignee(fu, heading, line) {
  if (fu.needsPerson || !fu.assignee?.email) return mail(fu, await departmentRecipients(fu.toDept), { heading, line: `${line} Nobody in your department has been named for it yet — please pick who owns it.` });
  return mail(fu, [fu.assignee], { heading, line });
}

// ── Numbering ───────────────────────────────────────────────────────────────

async function insertWithNumber(doc) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const last = await FollowUp.findOne({}).sort({ seq: -1 }).select("seq").lean();
    const seq = (last?.seq || 0) + 1;
    try {
      return await FollowUp.create({ ...doc, seq, number: rules.numberOf(seq) });
    } catch (err) {
      if (err?.code !== 11000 || !/seq/.test(String(err.message))) throw err;
    }
  }
  throw new FollowUpError(503, "Could not number the follow-up — please try again.");
}

// ── Manual follow-ups ───────────────────────────────────────────────────────

async function create(me, body) {
  const { errors, value } = rules.validateNew(body);
  if (errors.length) throw new FollowUpError(400, errors[0], { errors });
  const assignee = await findPerson(value.toDept, body.assignee);
  if (!assignee) throw new FollowUpError(400, `${body.assignee?.name || "That person"} does not work in ${rules.deptByKey(value.toDept).label}.`);
  const subject = await resolveSubject(value.subject);
  const fromDept = me.dept || (rules.DEPT_KEYS.includes(body.fromDept) ? body.fromDept : "") || "other";
  const by = actorOf(me);
  const fu = await insertWithNumber({
    title: value.title, detail: value.detail, kind: "manual",
    subject, fromDept, toDept: value.toDept, assignee, needsPerson: false,
    raisedBy: by, dueAt: value.dueAt, priority: value.priority, status: rules.STATUS.OPEN,
    thread: [{ by, kind: "create", text: value.detail }],
    lastActivityAt: new Date(),
  });
  mailAssignee(fu, `${by.name || "Somebody"} is waiting on you`, `${by.name || "Somebody"} raised a follow-up for you.`);
  return fu;
}

// ── Lists ───────────────────────────────────────────────────────────────────

function filtersQuery({ toDept, subjectType, subjectId, q } = {}) {
  const and = [];
  if (toDept && rules.DEPT_KEYS.includes(toDept)) and.push({ toDept });
  if (subjectType && subjectId) and.push({ "subject.type": subjectType, "subject.id": String(subjectId) });
  if (q && String(q).trim()) {
    const rx = new RegExp(String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    and.push({ $or: [{ title: rx }, { number: rx }, { "subject.label": rx }, { "subject.code": rx }, { "assignee.name": rx }, { "raisedBy.name": rx }] });
  }
  return and;
}

function shape(fu, me, now = new Date()) {
  const o = typeof fu.toObject === "function" ? fu.toObject() : fu;
  return {
    ...o,
    _id: String(o._id),
    openKey: undefined,
    overdue: rules.isOverdue(o, now),
    waitingOn: rules.waitingOn(o),
    can: rules.allowed(o, me),
  };
}

async function list(me, { view = "mine", ...filters } = {}) {
  const now = new Date();
  const v = rules.VIEWS.includes(view) ? view : "mine";
  const query = { $and: [rules.viewQuery(v, me, now), ...filtersQuery(filters)] };
  const sort = v === "closed" ? { closedAt: -1 } : { dueAt: 1, lastActivityAt: -1 };
  const rows = await FollowUp.find(query).sort(sort).limit(v === "closed" ? 200 : 500).select("-thread").lean();
  // `dueAt: 1` puts follow-ups with no date first; they belong last.
  if (v !== "closed") rows.sort((a, b) => (a.dueAt ? 0 : 1) - (b.dueAt ? 0 : 1));
  return rows.map((r) => shape(r, me, now));
}

/** The figures for the bell and the tabs. */
async function counts(me) {
  const now = new Date();
  const base = (view) => FollowUp.countDocuments(rules.viewQuery(view, me, now));
  const [mine, raised, department, overdue, open, mineOverdue] = await Promise.all([
    base("mine"), base("raised"), base("department"), base("overdue"), base("open"),
    FollowUp.countDocuments({ $and: [rules.viewQuery("mine", me, now), rules.viewQuery("overdue", me, now)] }),
  ]);
  return { mine, raised, department, overdue, open, mineOverdue };
}

async function get(me, id) {
  if (!mongoose.Types.ObjectId.isValid(id)) throw new FollowUpError(404, "That follow-up does not exist.");
  const fu = await FollowUp.findById(id).lean();
  if (!fu) throw new FollowUpError(404, "That follow-up does not exist.");
  return shape(fu, me);
}

// ── Actions ─────────────────────────────────────────────────────────────────

const ACTIONS = ["comment", "answer", "close", "reopen", "reassign", "due"];

async function act(me, id, action, body = {}) {
  if (!ACTIONS.includes(action)) throw new FollowUpError(400, "Unknown action.");
  if (!mongoose.Types.ObjectId.isValid(id)) throw new FollowUpError(404, "That follow-up does not exist.");
  const fu = await FollowUp.findById(id);
  if (!fu) throw new FollowUpError(404, "That follow-up does not exist.");
  const can = rules.allowed(fu, me);
  const permission = { comment: "comment", answer: "answer", close: "close", reopen: "reopen", reassign: "reassign", due: "due" }[action];
  if (!can[permission]) throw new FollowUpError(403, refusal(action, fu));

  const by = actorOf(me);
  const text = String(body.text || "").trim().slice(0, 4000);
  const now = new Date();
  let notify = null;

  if (action === "comment") {
    if (!text) throw new FollowUpError(400, "Write something first.");
    fu.thread.push({ by, kind: "comment", text });
    // The other side hears about it: the assignee when the raiser writes, the
    // raiser when anyone else does.
    const raiserWrote = rules.samePerson(fu.raisedBy, me);
    notify = raiserWrote
      ? () => mailAssignee(fu, `New message on ${fu.number}`, `${by.name} wrote: "${text}"`)
      : !fu.raisedBy?.system && fu.raisedBy?.email
        ? () => mail(fu, [fu.raisedBy], { heading: `New message on ${fu.number}`, line: `${by.name} wrote: "${text}"`, deptKey: fu.fromDept })
        : null;
  } else if (action === "answer") {
    if (!text) throw new FollowUpError(400, "Say what was done, so whoever raised it can check.");
    fu.thread.push({ by, kind: "answer", text });
    fu.answeredAt = now;
    if (fu.raisedBy?.system) {
      // Nobody to accept an answer to an automatic follow-up: answering it is
      // finishing it.
      closeDoc(fu, by, text);
    } else {
      fu.status = rules.STATUS.ANSWERED;
      notify = () => mail(fu, [fu.raisedBy], { heading: `${by.name} answered ${fu.number}`, line: `${by.name} answered your follow-up: "${text}". Close it if that settles it, or reopen it.`, deptKey: fu.fromDept });
    }
  } else if (action === "close") {
    closeDoc(fu, by, text);
    if (!rules.samePerson(fu.assignee, me)) notify = () => mailAssignee(fu, `${fu.number} closed`, `${by.name} closed this follow-up.${text ? ` "${text}"` : ""}`);
  } else if (action === "reopen") {
    if (!text) throw new FollowUpError(400, "Say why it is not done yet.");
    fu.status = rules.STATUS.OPEN;
    fu.closedAt = null;
    fu.closedBy = undefined;
    fu.thread.push({ by, kind: "reopen", text });
    notify = () => mailAssignee(fu, `${fu.number} reopened`, `${by.name} reopened this follow-up: "${text}"`);
  } else if (action === "reassign") {
    const toDept = rules.DEPT_KEYS.includes(body.toDept) ? body.toDept : fu.toDept;
    const person = await findPerson(toDept, body.assignee);
    if (!person) throw new FollowUpError(400, `Choose somebody who works in ${rules.deptByKey(toDept)?.label || "that department"}.`);
    const from = `${fu.assignee?.name || "nobody"} (${rules.deptByKey(fu.toDept)?.label || fu.toDept})`;
    const to = `${person.name} (${rules.deptByKey(toDept).label})`;
    fu.toDept = toDept;
    fu.assignee = person;
    fu.needsPerson = false;
    fu.thread.push({ by, kind: "reassign", text, from, to });
    notify = () => mail(fu, [person], { heading: `${fu.number} is now yours`, line: `${by.name} handed this follow-up to you.${text ? ` "${text}"` : ""}` });
  } else if (action === "due") {
    const d = new Date(body.dueAt);
    if (!body.dueAt || Number.isNaN(d.getTime())) throw new FollowUpError(400, "Choose a date.");
    const from = fmtDate(fu.dueAt) || "no date";
    fu.dueAt = d;
    fu.remindedOn = "";
    fu.thread.push({ by, kind: "due", text, from, to: fmtDate(d) });
    if (!rules.samePerson(fu.assignee, me)) notify = () => mailAssignee(fu, `${fu.number} — new date`, `${by.name} moved the date from ${from} to ${fmtDate(d)}.${text ? ` "${text}"` : ""}`);
  }

  fu.lastActivityAt = now;
  await fu.save();
  if (notify) notify();
  return shape(fu, me, now);
}

function closeDoc(fu, by, text) {
  fu.status = rules.STATUS.CLOSED;
  fu.closedAt = new Date();
  fu.closedBy = by;
  fu.openKey = undefined;
  fu.thread.push({ by, kind: "close", text });
}

function refusal(action, fu) {
  switch (action) {
    case "answer": return fu.status !== rules.STATUS.OPEN ? "It is not waiting on an answer." : "Only the person it is for can answer it.";
    case "close": return fu.status === rules.STATUS.CLOSED ? "It is already closed." : "Only whoever raised it can close it.";
    case "reopen": return fu.status === rules.STATUS.OPEN ? "It is already open." : "Only whoever raised it can reopen it.";
    case "reassign": return fu.status === rules.STATUS.CLOSED ? "A closed follow-up cannot be handed on." : "Only whoever raised it, the person it is for, or their department can hand it on.";
    case "due": return "Only whoever raised it or the person it is for can change the date.";
    default: return "Only the two departments and the people involved can write here.";
  }
}

// ── Automatic follow-ups (the hand-offs) ────────────────────────────────────

/**
 * Raise the automatic follow-up `key` unless one is already open. The person
 * is the first of `prefer` who works in the department, else the department's
 * default person, else nobody (`needsPerson`, mailed to the whole department).
 */
async function raiseAuto({ kind, key, subject, fromDept, title, detail = "", dueAt, prefer = [] }) {
  const spec = rules.AUTO_KINDS[kind];
  if (!spec) throw new Error(`Unknown follow-up kind ${kind}`);
  const existing = await FollowUp.findOne({ openKey: key });
  if (existing) return existing;

  let assignee = null;
  for (const p of prefer) {
    if (!p || (!p.id && !p.email)) continue;
    assignee = await findPerson(spec.toDept, { id: p.id ? String(p.id) : "", email: p.email || "" });
    if (assignee) break;
  }
  if (!assignee) {
    const def = (await getSettings()).defaults[spec.toDept];
    if (def) assignee = await findPerson(spec.toDept, def);
  }

  const by = { ...SYSTEM_ACTOR, dept: fromDept };
  let fu;
  try {
    fu = await insertWithNumber({
      title: title || spec.label, detail, kind, openKey: key,
      subject, fromDept, toDept: spec.toDept,
      assignee: assignee || {}, needsPerson: !assignee,
      raisedBy: by, dueAt: rules.autoDueAt(kind, dueAt), status: rules.STATUS.OPEN,
      thread: [{ by, kind: "create", text: detail }],
      lastActivityAt: new Date(),
    });
  } catch (err) {
    if (err?.code === 11000 && /openKey/.test(String(err.message))) return FollowUp.findOne({ openKey: key });
    throw err;
  }
  mailAssignee(fu, `Waiting on you: ${fu.title}`, `This was raised automatically when ${aboutText(fu) || "a record"} reached you.`);
  return fu;
}

/** Close the open automatic follow-up `key`, saying why. */
async function closeAuto(key, note) {
  const fu = await FollowUp.findOne({ openKey: key });
  if (!fu) return null;
  closeDoc(fu, { ...SYSTEM_ACTOR, dept: fu.toDept }, note);
  fu.lastActivityAt = new Date();
  await fu.save();
  return fu;
}

/** Close every open automatic follow-up about one record (a style sent back). */
async function closeAllAutoFor(subjectType, subjectId, note) {
  const rows = await FollowUp.find({ "subject.type": subjectType, "subject.id": String(subjectId), openKey: { $exists: true, $ne: null } });
  for (const fu of rows) {
    closeDoc(fu, { ...SYSTEM_ACTOR, dept: fu.toDept }, note);
    fu.lastActivityAt = new Date();
    await fu.save();
  }
  return rows.length;
}

// ── The morning reminder ────────────────────────────────────────────────────

/**
 * One email per person with every open follow-up of theirs that is overdue or
 * due today; follow-ups naming nobody go to their whole department. Each goes
 * out once a day (`remindedOn`).
 */
async function sendReminders(now = new Date()) {
  const today = rules.istDay(now);
  const endOfToday = new Date(`${today}T23:59:59.999+05:30`);
  const rows = await FollowUp.find({ status: rules.STATUS.OPEN, dueAt: { $ne: null, $lte: endOfToday }, remindedOn: { $ne: today } }).lean();
  if (!rows.length) return { people: 0, followUps: 0 };

  const byPerson = new Map(); // email → { person, deptKey, rows }
  for (const fu of rows) {
    const recipients = fu.needsPerson || !fu.assignee?.email ? await departmentRecipients(fu.toDept) : [fu.assignee];
    for (const r of recipients) {
      if (!r.email) continue;
      const k = r.email.toLowerCase();
      if (!byPerson.has(k)) byPerson.set(k, { person: r, deptKey: fu.toDept, rows: [] });
      byPerson.get(k).rows.push(fu);
    }
  }
  for (const { person, deptKey, rows: mine } of byPerson.values()) {
    const late = mine.filter((f) => new Date(f.dueAt) < now);
    const list = mine.map((f) => `<li style="margin:0 0 6px"><strong>${escapeHtml(f.number)}</strong> ${escapeHtml(f.title)}${aboutText(f) ? ` — ${escapeHtml(aboutText(f))}` : ""} · ${new Date(f.dueAt) < now ? `<span style="color:#b91c1c">late since ${escapeHtml(fmtDate(f.dueAt))}</span>` : "due today"}</li>`).join("");
    const portal = rules.deptByKey(deptKey)?.portal || "/ppc";
    const html = wrapEmail({
      heading: `${mine.length} follow-up${mine.length === 1 ? "" : "s"} waiting on you`,
      bodyHtml: `<p>${late.length ? `${late.length} ${late.length === 1 ? "is" : "are"} past the date.` : "All are due today."}</p><ul style="padding-left:18px">${list}</ul>`,
      ctaLabel: "Open my follow-ups",
      ctaUrl: `${APP_URL}${portal}/follow-ups`,
    }).replace("Turn these off from Sales &rarr; Settings &rarr; Department Notifications.", "Sent every morning while a follow-up of yours is due or late.");
    const text = mine.map((f) => `${f.number} ${f.title} — ${new Date(f.dueAt) < now ? `late since ${fmtDate(f.dueAt)}` : "due today"}`).join("\n");
    try {
      await sendCmsEmail({ to: [{ email: person.email, name: person.name || person.email }], subject: `Follow-ups waiting on you (${mine.length})`, html, text });
    } catch (err) {
      console.warn("[followUps] reminder failed:", err.message);
    }
  }
  await FollowUp.updateMany({ _id: { $in: rows.map((r) => r._id) } }, { $set: { remindedOn: today } });
  return { people: byPerson.size, followUps: rows.length };
}

function startFollowUpReminders() {
  const cron = require("node-cron");
  cron.schedule("30 9 * * *", () => {
    sendReminders().catch((err) => console.error("[followUps] reminders failed:", err.message));
  }, { timezone: "Asia/Kolkata" });
  console.log("✅ [followUps] morning reminders scheduled (09:30 IST daily)");
}

module.exports = {
  FollowUpError, meOf, resolveMe, departmentPeople, findPerson,
  getSettings, setDefaultPerson,
  resolveSubject, searchSubjects,
  create, list, counts, get, act,
  raiseAuto, closeAuto, closeAllAutoFor,
  sendReminders, startFollowUpReminders,
  SYSTEM_ACTOR,
};
