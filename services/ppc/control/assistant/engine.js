// services/ppc/control/assistant/engine.js
//
// THE PRODUCTION ASSISTANT'S ANSWERS — from the same services as the pages.
//
// intents.js turns the question into { intent, entities }; this file turns
// that into an answer built ONLY from orders.service, reports.service and
// overview.service, so a number the assistant gives is the number the Orders
// page, the department page or the report shows. It keeps no arithmetic of
// its own beyond formatting.
//
// An answer is structured, not prose: a headline sentence, then blocks the
// CMS renders — facts (summary cards), a table, a progress figure, links to
// the page that holds the detail, and a report the person can generate. No
// external model is called; when one is connected it produces the same
// { intent, entities } and lands here.
"use strict";

const intents = require("./intents");
const orders = require("../orders.service");
const reports = require("../reports.service");
const overview = require("../overview.service");
const { DEPARTMENTS, DEPARTMENT_META } = require("../ledger.service");
const shift = require("../../../manufacturing/shiftHours");

const fmtDay = (ymd) => { if (!ymd) return ""; const [y, m, d] = ymd.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }); };
const fmtAt = (at) => (at ? new Date(new Date(at).getTime() + shift.IST_OFFSET_MS).toISOString().replace("T", " ").slice(0, 16) : "—");
const n = (v) => (v == null ? "—" : Number(v).toLocaleString("en-IN"));
const pctS = (v) => (v == null ? "—" : `${v}%`);
const label = (d) => DEPARTMENT_META[d]?.label || d;
const STATUS_WORD = { behind: "Behind", on_track: "On track", achieved: "Achieved", exceeded: "Exceeded", not_started: "Not started", no_target: "No target", none: "No target" };
const STATUS_TONE = { behind: "overdue", on_track: "neutral", achieved: "positive", exceeded: "positive", not_started: "neutral", no_target: "neutral", none: "neutral" };
const RISK_WORD = { overdue: "Overdue", at_risk: "At risk", due_soon: "Due soon", on_track: "On track", none: "No delivery date", closed: "Complete" };

const facts = (items) => ({ type: "facts", items: items.filter(Boolean) });
const table = (title, columns, rows, opts = {}) => ({ type: "table", title, columns, rows, ...opts });
const links = (items) => ({ type: "links", items: items.filter(Boolean) });
const report = (lbl, reportType, filters) => ({ type: "report", label: lbl, reportType, filters });
const note = (tone, text) => ({ type: "note", tone, text });
const orderHref = (moId) => `/ppc/orders/${moId}`;
const woHref = (woId) => `/ppc/work-orders/${woId}`;
const deptHref = (d, date) => `/ppc/departments/${d}${date ? `?date=${date}` : ""}`;
const monitorHref = (date, department) => `/ppc/monitor?date=${date}${department ? `&department=${department}` : ""}`;

/* ── finding the order the question names ───────────────────────────────── */

async function resolveOrder(companyId, e) {
  const q = e.po || e.mo || (e.moSuffix ? e.moSuffix : null);
  if (!q) return { order: null, candidates: [] };
  const { hits } = await orders.search(companyId, q);
  let cands = hits.filter((h) => h.type === "order");
  if (e.po) cands = cands.filter((h) => h.matched === "poNumber") .concat(cands.filter((h) => h.matched !== "poNumber"));
  if (e.mo) { const exact = cands.filter((h) => h.label.toUpperCase() === e.mo.toUpperCase()); if (exact.length) cands = exact; }
  if (e.moSuffix) cands = cands.filter((h) => h.label.endsWith(e.moSuffix));
  if (!cands.length) return { order: null, candidates: [] };
  return { order: cands[0], candidates: cands };
}

function orderFacts(o) {
  return facts([
    { label: "Order", value: o.moNumber, sub: o.customerName },
    { label: "PO", value: o.poNumber || "Not recorded", sub: o.poDate ? fmtDay(shift.istDayKeyOf(o.poDate)) : null },
    { label: "Quantity", value: n(o.quantity), sub: `${o.workOrders} work order${o.workOrders === 1 ? "" : "s"} · ${o.orderType === "person_wise" ? "person-wise" : "bulk"}` },
    { label: "Produced (sewn)", value: n(o.produced), sub: `${o.progressPct}%`, tone: o.progressPct >= 100 ? "positive" : null },
    { label: "Remaining", value: n(o.remaining) },
    { label: "Furthest stage", value: o.currentStageLabel, sub: o.nextStage ? `still short: ${o.nextStageLabel}` : null },
    { label: "Delivery", value: o.deliveryDate ? fmtDay(shift.istDayKeyOf(o.deliveryDate)) : "Not set", sub: RISK_WORD[o.risk], tone: o.risk === "overdue" || o.risk === "at_risk" ? "overdue" : null },
    { label: "Targets", value: o.targets ? STATUS_WORD[o.targetStatus] : "None set", tone: STATUS_TONE[o.targetStatus], sub: o.targets ? `${o.targets} active` : null },
    o.lastActivityAt ? { label: "Last activity", value: fmtAt(o.lastActivityAt) } : null,
  ]);
}
const deptCols = [{ key: "label", label: "Department" }, { key: "done", label: "Done", align: "right" }, { key: "remaining", label: "Remaining", align: "right" }, { key: "pct", label: "%", align: "right" }, { key: "today", label: "Today", align: "right" }];

/* ── the answers ────────────────────────────────────────────────────────── */

async function answer(companyId, message, { history = [] } = {}) {
  const today = orders.todayKey();
  const parsed = intents.parse(message, today);
  const e = parsed.entities;
  /* a follow-up that names no order inherits the last one asked about */
  if (!e.po && !e.mo && !e.moSuffix && !e.wo && !e.barcode && ["order_status", "person_wise", "pending_quantity", "recovery_pace"].includes(parsed.intent)) {
    const prev = [...history].reverse().find((h) => h?.entities?.mo || h?.entities?.po);
    if (prev) { e.mo = prev.entities.mo; e.po = prev.entities.po; }
  }
  const base = { question: parsed.text, intent: parsed.intent, intentLabel: parsed.label, entities: e };
  try {
    const out = await handlers[parsed.intent](companyId, e, today);
    return { ...base, ...out };
  } catch (err) {
    console.error("[ppc assistant]", err);
    return { ...base, title: "I could not answer that", text: err.message, blocks: [], followUps: SUGGESTIONS.slice(0, 4).map((s) => s.text) };
  }
}

const handlers = {
  async help() {
    return { title: "What I can answer", text: "Ask about today, a department, an hour range, an order (by PO or MO number), a work order, a barcode, a product or size, a person on a measurement order, targets, delays and reports. Every figure comes from the same records the PPC pages show.", blocks: [table("Examples", [{ key: "group", label: "Topic" }, { key: "text", label: "Try" }], SUGGESTIONS.map((s) => ({ group: s.group, text: s.text })))], followUps: SUGGESTIONS.slice(0, 5).map((s) => s.text) };
  },

  async summary_today(companyId, e) {
    const date = e.date || e.to;
    const o = await overview.overview(companyId, { date });
    const k = o.kpis;
    const depts = o.departments.filter((d) => d.hasTarget || d.actual > 0);
    return {
      title: `Production on ${fmtDay(date)}${o.isToday ? " (today)" : ""}`,
      text: `${n(k.todayProduced)} pieces sewn${k.todayProducedTarget ? ` against a target of ${n(k.todayProducedTarget)} (${pctS(Math.round((k.todayProduced / k.todayProducedTarget) * 100))})` : ""}. ${k.active} active order${k.active === 1 ? "" : "s"}, ${k.delayed} delayed, ${k.departmentsBehind} department${k.departmentsBehind === 1 ? "" : "s"} behind target${k.departmentsWithTarget ? ` of ${k.departmentsWithTarget} with a target` : ""}.`,
      blocks: [
        facts([{ label: "Sewn today", value: n(k.todayProduced), sub: k.todayProducedTarget ? `target ${n(k.todayProducedTarget)}` : "no sewing target" }, { label: "All targets today", value: `${n(k.todayActual)} / ${n(k.todayTarget)}`, sub: pctS(k.todayAchievementPct) }, { label: "Active orders", value: n(k.active), sub: `${k.inProduction} in production` }, { label: "Delayed", value: n(k.delayed), tone: k.delayed ? "overdue" : "positive", sub: `${k.overdue} overdue · ${k.atRisk} at risk` }, { label: "Behind target", value: n(k.departmentsBehind), tone: k.departmentsBehind ? "overdue" : "positive", sub: "departments" }, { label: "Order book", value: `${n(k.produced)} / ${n(k.quantity)}`, sub: `${n(k.remaining)} remaining` }]),
        table("Departments", [{ key: "label", label: "Department" }, { key: "target", label: "Target", align: "right" }, { key: "actual", label: "Actual", align: "right" }, { key: "achievementPct", label: "Achieved", align: "right", type: "pct" }, { key: "remaining", label: "Remaining", align: "right" }, { key: "pacePerHour", label: "Pace/h", align: "right" }, { key: "expectedEndOfDay", label: "Expected EOD", align: "right" }, { key: "status", label: "Status", type: "status" }, { key: "activeOrders", label: "Orders", align: "right" }], depts.map((d) => ({ ...d, status: STATUS_WORD[d.status], statusTone: STATUS_TONE[d.status], href: deptHref(d.department, date) })), { emptyText: "Nothing recorded and no targets set for this day." }),
        o.atRisk.length ? table("Orders at risk", [{ key: "moNumber", label: "Order" }, { key: "customerName", label: "Customer" }, { key: "poNumber", label: "PO" }, { key: "produced", label: "Sewn", align: "right" }, { key: "quantity", label: "Qty", align: "right" }, { key: "currentStageLabel", label: "Stage" }, { key: "risk", label: "Risk", type: "status" }], o.atRisk.map((r) => ({ ...r, risk: RISK_WORD[r.risk], statusTone: "overdue", href: orderHref(r.moId) }))) : null,
        links([{ label: "Open the control center", href: `/ppc?date=${date}` }, { label: "Hour by hour", href: monitorHref(date) }]),
        report("Generate the daily report", "daily", { date }),
      ].filter(Boolean),
      followUps: ["Which departments are behind target?", "Which orders are delayed?", "Give me hour-wise sewing production today"],
    };
  },

  async department_today(companyId, e) {
    const dept = e.department || "production";
    const date = e.date || e.to;
    const d = await reports.departmentPage(companyId, dept, { date });
    const s = d.summary;
    return {
      title: `${d.label} — ${fmtDay(date)}${d.isToday ? " (today)" : ""}`,
      text: s.targets ? `${n(s.actual)} ${d.doneWord} against a target of ${n(s.target)} (${pctS(s.achievementPct)}), ${n(s.remaining)} still needed${s.requiredPerRemainingHour ? ` — ${n(s.requiredPerRemainingHour)} an hour for the rest of the shift` : ""}.` : `${n(s.actual)} ${d.doneWord} on this day. No PPC target is set for ${d.label} on this day.`,
      blocks: [
        facts([{ label: "Target", value: n(s.target) }, { label: "Produced", value: n(s.actual) }, { label: "Achievement", value: pctS(s.achievementPct), tone: STATUS_TONE[s.status] }, { label: "Remaining", value: n(s.remaining) }, { label: "Current pace", value: `${s.pacePerHour}/h` }, { label: "Required pace", value: s.requiredPerRemainingHour != null ? `${n(s.requiredPerRemainingHour)}/h` : "—" }, { label: "Expected EOD", value: n(s.expectedEndOfDay) }, s.efficiency ? { label: "Efficiency", value: pctS(s.efficiency.pct), sub: `${n(s.efficiency.earnedMinutes)} of ${n(s.efficiency.availableMinutes)} min` } : null, { label: "Active orders", value: n(s.activeOrders), sub: s.delayedOrders ? `${s.delayedOrders} delayed` : null }]),
        table("Hour by hour", [{ key: "label", label: "Hour" }, { key: "target", label: "Target", align: "right" }, { key: "actual", label: "Actual", align: "right" }, { key: "cumulativeActual", label: "Cumulative", align: "right" }, { key: "difference", label: "Difference", align: "right", type: "delta" }], d.hourly.filter((h) => !h.future && (h.actual || h.target))),
        d.activeOrders.length ? table("Active orders here", [{ key: "moNumber", label: "Order" }, { key: "customerName", label: "Customer" }, { key: "poNumber", label: "PO" }, { key: "done", label: "Done", align: "right" }, { key: "quantity", label: "Qty", align: "right" }, { key: "today", label: "Today", align: "right" }, { key: "status", label: "Status", type: "status" }], d.activeOrders.slice(0, 10).map((r) => ({ ...r, status: STATUS_WORD[r.status] || r.status, statusTone: STATUS_TONE[r.status] || "neutral", href: orderHref(r.moId) }))) : null,
        links([{ label: `Open ${d.label}`, href: deptHref(dept, date) }]),
        report(`Generate the ${d.label} report`, "department", { department: dept, from: date, to: date }),
      ].filter(Boolean),
      followUps: [`Give me hour-wise ${d.label.toLowerCase().split(" ")[0]} production today`, `What is today's target for ${d.label.toLowerCase().split(" ")[0]}?`, "Which orders are delayed?"],
    };
  },

  async hourly(companyId, e) {
    const date = e.date || e.to;
    const dept = e.department || "production";
    const { order } = await resolveOrder(companyId, e);
    const h = await reports.hourly(companyId, { date, department: dept, moId: order?.moId });
    const d = h.departments[0];
    let hours = d.hours;
    if (e.hoursFrom && e.hoursTo) hours = hours.filter((x) => !x.outside && x.key >= e.hoursFrom.slice(0, 5) && x.key < e.hoursTo);
    const total = hours.reduce((s, x) => s + x.actual, 0), target = hours.reduce((s, x) => s + x.target, 0);
    const peak = d.totals.peakHour;
    return {
      title: `${d.label} hour by hour — ${fmtDay(date)}${order ? ` · ${order.label}` : ""}${e.hoursFrom ? ` · ${e.hoursFrom}–${e.hoursTo}` : ""}`,
      text: `${n(total)} pieces${target ? ` against ${n(target)} expected (${pctS(Math.round((total / target) * 100))})` : ""}${peak ? `; the best hour was ${peak.label} with ${n(peak.actual)}` : ""}.`,
      blocks: [
        facts([{ label: "Pieces", value: n(total) }, { label: "Expected", value: target ? n(target) : "no target" }, { label: "Difference", value: target ? n(total - target) : "—", tone: target ? (total >= target ? "positive" : "overdue") : null }, peak ? { label: "Peak hour", value: peak.label, sub: n(peak.actual) } : null, { label: "Pace", value: `${d.totals.pacePerHour}/h` }, h.isToday ? { label: "Expected EOD", value: n(d.totals.expectedEndOfDay) } : null]),
        table("Hours", [{ key: "label", label: "Hour" }, { key: "target", label: "Target", align: "right" }, { key: "actual", label: "Actual", align: "right" }, { key: "cumulativeTarget", label: "Cum. target", align: "right" }, { key: "cumulativeActual", label: "Cum. actual", align: "right" }, { key: "difference", label: "Difference", align: "right", type: "delta" }, { key: "achievementPct", label: "Achieved", align: "right", type: "pct" }, { key: "orders", label: "Orders", align: "right" }, { key: "workOrders", label: "WOs", align: "right" }], hours.filter((x) => !x.future || x.target)),
        links([{ label: "Open the hourly monitor", href: monitorHref(date, dept) }]),
        report("Generate the hourly report", "hourly", { date, department: dept, moId: order?.moId }),
      ],
      followUps: ["Compare target vs actual hour-wise", "Which hour had the highest production?", `Give me today's ${d.label.toLowerCase().split(" ")[0]} update`],
    };
  },

  async compare_days(companyId, e) {
    const from = e.from, to = e.to;
    const dept = e.department || null;
    const d = await reports.daily(companyId, { from, to, department: dept || undefined });
    const a = d.days[0], b = d.days[d.days.length - 1];
    const rows = DEPARTMENTS.map((dep) => { const x = a.departments.find((y) => y.department === dep), y = b.departments.find((z) => z.department === dep); return x && y && (x.actual || y.actual || x.target || y.target) ? { label: label(dep), a: x.actual, b: y.actual, change: y.actual - x.actual, aTarget: x.target, bTarget: y.target } : null; }).filter(Boolean);
    return {
      title: `${fmtDay(from)} vs ${fmtDay(to)}${dept ? ` — ${label(dept)}` : ""}`,
      text: `${d.headline}: ${n(a.actual)} on ${fmtDay(from)}, ${n(b.actual)} on ${fmtDay(to)} (${b.actual - a.actual >= 0 ? "+" : ""}${n(b.actual - a.actual)}).`,
      blocks: [facts([{ label: fmtDay(from), value: n(a.actual), sub: a.target ? `target ${n(a.target)}` : null }, { label: fmtDay(to), value: n(b.actual), sub: b.target ? `target ${n(b.target)}` : null }, { label: "Change", value: `${b.actual - a.actual >= 0 ? "+" : ""}${n(b.actual - a.actual)}`, tone: b.actual >= a.actual ? "positive" : "overdue" }]),
        table("By department", [{ key: "label", label: "Department" }, { key: "a", label: fmtDay(from), align: "right" }, { key: "b", label: fmtDay(to), align: "right" }, { key: "change", label: "Change", align: "right", type: "delta" }], rows),
        links([{ label: "Day by day", href: `/ppc/monitor?view=daily&from=${from}&to=${to}` }])],
      followUps: ["Give me today's production summary", "Which departments missed target yesterday?"],
    };
  },

  async departments_behind(companyId, e) {
    const date = e.date || e.to;
    const o = await overview.overview(companyId, { date });
    const behind = o.departments.filter((d) => d.status === "behind");
    const withTarget = o.departments.filter((d) => d.hasTarget);
    return {
      title: `Departments behind target — ${fmtDay(date)}`,
      text: !withTarget.length ? "No department has a PPC target for this day, so none can be behind one." : behind.length ? `${behind.map((d) => `${d.label} (${n(d.actual)} of ${n(d.target)}, ${pctS(d.achievementPct)})`).join("; ")}.` : `Every department with a target is on track or has achieved it (${withTarget.length} with targets).`,
      blocks: [table("Departments with a target", [{ key: "label", label: "Department" }, { key: "target", label: "Target", align: "right" }, { key: "actual", label: "Actual", align: "right" }, { key: "achievementPct", label: "Achieved", align: "right", type: "pct" }, { key: "remaining", label: "Short", align: "right" }, { key: "requiredPerRemainingHour", label: "Needed/h", align: "right" }, { key: "status", label: "Status", type: "status" }], withTarget.map((d) => ({ ...d, status: STATUS_WORD[d.status], statusTone: STATUS_TONE[d.status], href: deptHref(d.department, date) }))),
        links(behind.map((d) => ({ label: `Open ${d.label}`, href: deptHref(d.department, date) })))],
      followUps: ["Which orders are falling behind?", "What recovery rate is required?", "Give target achievement report"],
    };
  },

  async department_best(companyId, e) {
    const date = e.date || e.to;
    const o = await overview.overview(companyId, { date });
    const ranked = o.departments.filter((d) => d.actual > 0).sort((a, b) => (b.achievementPct ?? -1) - (a.achievementPct ?? -1) || b.actual - a.actual);
    const best = ranked[0];
    return {
      title: `Best department — ${fmtDay(date)}`,
      text: best ? `${best.label}: ${n(best.actual)} pieces${best.hasTarget ? ` (${pctS(best.achievementPct)} of target)` : " (no target set)"}${best.efficiency?.pct != null ? `, efficiency ${pctS(best.efficiency.pct)}` : ""}.` : "Nothing has been recorded by any department on this day.",
      blocks: [table("Ranked by achievement, then pieces", [{ key: "label", label: "Department" }, { key: "actual", label: "Pieces", align: "right" }, { key: "target", label: "Target", align: "right" }, { key: "achievementPct", label: "Achieved", align: "right", type: "pct" }, { key: "efficiencyPct", label: "Efficiency", align: "right", type: "pct" }], ranked.map((d) => ({ ...d, efficiencyPct: d.efficiency?.pct ?? null, href: deptHref(d.department, date) })))],
      followUps: ["Which departments are behind target?", "Give me today's production summary"],
    };
  },

  async orders_delayed(companyId, e) {
    const d = await reports.delays(companyId, { date: e.date });
    return {
      title: `Delayed orders — ${fmtDay(d.date)}`,
      text: d.orders.length ? `${d.totals.delayed} order${d.totals.delayed === 1 ? " is" : "s are"} behind: ${d.totals.overdue} past the delivery date, ${d.totals.atRisk} projected to miss it, ${d.totals.behindTarget} behind a target. ${n(d.totals.shortfall)} pieces still to sew across them.` : "No order is past its delivery date, projected to miss it, or behind a target.",
      blocks: [table("Orders", [{ key: "moNumber", label: "Order" }, { key: "poNumber", label: "PO" }, { key: "customerName", label: "Customer" }, { key: "deliveryDate", label: "Delivery", type: "date" }, { key: "daysToDelivery", label: "Days", align: "right" }, { key: "produced", label: "Sewn", align: "right" }, { key: "quantity", label: "Qty", align: "right" }, { key: "remaining", label: "Remaining", align: "right" }, { key: "furthestBehindLabel", label: "Furthest-behind stage" }, { key: "requiredPerDay", label: "Needed/day", align: "right" }, { key: "risk", label: "Why", type: "status" }], d.orders.map((r) => ({ ...r, risk: r.reasons.join("; "), statusTone: "overdue", href: orderHref(r.moId) })), { emptyText: "Nothing delayed." }),
        report("Generate the delay / shortfall report", "delays", { date: d.date })],
      followUps: ["What recovery rate is required?", "Which department is the furthest behind?", "Show delayed orders' targets"],
    };
  },

  async delay_cause(companyId, e) {
    const d = await reports.delays(companyId, { date: e.date });
    const by = d.byDepartment.filter((x) => x.ordersFurthestBehind > 0).sort((a, b) => b.ordersFurthestBehind - a.ordersFurthestBehind);
    return {
      title: "Where the delay is",
      text: !d.orders.length ? "No order is delayed." : by.length ? `The data does not establish a cause; it shows where each delayed order is stuck. ${by[0].label} is the furthest-behind stage on ${by[0].ordersFurthestBehind} of ${d.orders.length} delayed order${d.orders.length === 1 ? "" : "s"}${by[1] ? `, then ${by[1].label} on ${by[1].ordersFurthestBehind}` : ""}.` : "Every delayed order has completed its applicable stages; the delay is in what has not been recorded yet.",
      blocks: [table("Furthest-behind stage, by department", [{ key: "label", label: "Department" }, { key: "ordersFurthestBehind", label: "Delayed orders stuck here", align: "right" }, { key: "shortfall", label: "Pieces short", align: "right" }, { key: "targetsBehind", label: "Targets behind", align: "right" }], d.byDepartment.filter((x) => x.shortfall > 0 || x.ordersFurthestBehind > 0)),
        table("Delayed orders", [{ key: "moNumber", label: "Order" }, { key: "customerName", label: "Customer" }, { key: "furthestBehindLabel", label: "Furthest-behind stage" }, { key: "remaining", label: "Remaining", align: "right" }, { key: "currentStageLabel", label: "Current stage" }], d.orders.map((r) => ({ ...r, href: orderHref(r.moId) })))],
      followUps: ["Which orders are delayed?", "Which departments are behind target?"],
    };
  },

  async orders_near_completion(companyId) {
    const l = await orders.listOrders(companyId, { status: "active", limit: 500 });
    const rows = l.rows.filter((r) => r.progressPct >= 80).sort((a, b) => b.progressPct - a.progressPct).slice(0, 15);
    return {
      title: "Orders close to completion",
      text: rows.length ? `${rows.length} active order${rows.length === 1 ? " is" : "s are"} at 80% or more sewn.` : "No active order has reached 80% sewn yet.",
      blocks: [table("80% or more sewn", [{ key: "moNumber", label: "Order" }, { key: "poNumber", label: "PO" }, { key: "customerName", label: "Customer" }, { key: "produced", label: "Sewn", align: "right" }, { key: "quantity", label: "Qty", align: "right" }, { key: "progressPct", label: "%", align: "right", type: "pct" }, { key: "currentStageLabel", label: "Stage" }, { key: "nextStageLabel", label: "Next" }, { key: "dispatched", label: "Dispatched", align: "right" }], rows.map((r) => ({ ...r, href: orderHref(r.moId) })))],
      followUps: ["Which orders are delayed?", "Give me today's production summary"],
    };
  },

  async order_status(companyId, e) {
    const { order, candidates } = await resolveOrder(companyId, e);
    if (!order) return { title: "Order not found", text: `No order matches "${e.po || e.mo || e.moSuffix}". Try the MO number (MO-REQ-2026-0003) or the PO number as recorded on the quotation.`, blocks: [], followUps: ["Show delayed orders", "Give me today's production summary"] };
    if (candidates.length > 1 && !e.po) {
      return { title: `${candidates.length} orders match ${order.label}`, text: "That number is recorded on more than one order — pick one.", blocks: [table("Matches", [{ key: "label", label: "Order" }, { key: "detail", label: "Customer / PO" }], candidates.map((c) => ({ ...c, href: orderHref(c.moId) })))], followUps: [] };
    }
    const d = await orders.orderDetail(companyId, order.moId);
    const o = d.order;
    const pipeline = d.departments.filter((p) => p.applicable);
    return {
      title: `${o.moNumber} · ${o.customerName}${o.poNumber ? ` · PO ${o.poNumber}` : ""}`,
      text: `${n(o.produced)} of ${n(o.quantity)} sewn (${o.progressPct}%), ${n(o.remaining)} remaining. Furthest stage reached: ${o.currentStageLabel}${o.nextStage ? `; earliest stage still short: ${o.nextStageLabel}` : ""}. ${o.deliveryDate ? `Delivery ${fmtDay(shift.istDayKeyOf(o.deliveryDate))} — ${RISK_WORD[o.risk].toLowerCase()}.` : "No delivery date recorded."}${o.lastActivityAt ? ` Last activity ${fmtAt(o.lastActivityAt)}.` : ""}`,
      blocks: [orderFacts(o),
        table("Department by department", deptCols, pipeline.map((p) => ({ ...p, href: `${orderHref(o.moId)}?tab=departments&department=${p.department}` }))),
        table("Work orders", [{ key: "number", label: "WO" }, { key: "product", label: "Product" }, { key: "variant", label: "Variant" }, { key: "quantity", label: "Qty", align: "right" }, { key: "produced", label: "Sewn", align: "right" }, { key: "progressPct", label: "%", align: "right", type: "pct" }, { key: "currentStageLabel", label: "Stage" }], d.workOrders.map((w) => ({ ...w, href: woHref(w.id) }))),
        links([{ label: `Open ${o.moNumber}`, href: orderHref(o.moId) }, o.orderType === "person_wise" ? { label: "Person-wise progress", href: `${orderHref(o.moId)}?tab=persons` } : null]),
        report("Generate the order report", "order", { moId: o.moId })],
      followUps: [`What remains for ${o.moNumber}?`, `Show all WOs for ${o.moNumber}`, o.orderType === "person_wise" ? `Show person-wise production for ${o.moNumber}` : `Give variant-wise progress for ${o.moNumber}`],
    };
  },

  async pending_quantity(companyId, e) {
    if (e.po || e.mo || e.moSuffix) {
      const r = await handlers.order_status(companyId, e);
      return { ...r, title: r.title.startsWith("Order not") ? r.title : `What remains — ${r.title}` };
    }
    const dept = e.department;
    const l = await orders.listOrders(companyId, { status: "active", limit: 500 });
    const rows = l.rows;
    const total = rows.reduce((s, r) => s + r.remaining, 0);
    if (dept) {
      const drows = rows.map((r) => ({ ...r, deptRemaining: r.departments.find((d) => d.department === dept)?.remaining || 0 })).filter((r) => r.deptRemaining > 0).sort((a, b) => b.deptRemaining - a.deptRemaining);
      return { title: `Pending at ${label(dept)}`, text: `${n(drows.reduce((s, r) => s + r.deptRemaining, 0))} pieces across ${drows.length} order${drows.length === 1 ? "" : "s"} have not been ${DEPARTMENT_META[dept].done} yet.`, blocks: [table("Orders", [{ key: "moNumber", label: "Order" }, { key: "customerName", label: "Customer" }, { key: "quantity", label: "Qty", align: "right" }, { key: "deptRemaining", label: `Not ${DEPARTMENT_META[dept].done}`, align: "right" }, { key: "currentStageLabel", label: "Stage" }], drows.map((r) => ({ ...r, href: orderHref(r.moId) })))], followUps: [`Give me today's ${label(dept).toLowerCase()} update`] };
    }
    return { title: "Pending quantity", text: `${n(total)} pieces are still to be sewn across ${rows.length} active order${rows.length === 1 ? "" : "s"}.`, blocks: [facts([{ label: "Remaining to sew", value: n(total) }, { label: "Active orders", value: n(rows.length) }, { label: "Not yet packed", value: n(rows.reduce((s, r) => s + Math.max(0, r.quantity - r.packed), 0)) }, { label: "Not yet dispatched", value: n(rows.reduce((s, r) => s + Math.max(0, r.quantity - r.dispatched), 0)) }]), table("By order", [{ key: "moNumber", label: "Order" }, { key: "customerName", label: "Customer" }, { key: "quantity", label: "Qty", align: "right" }, { key: "produced", label: "Sewn", align: "right" }, { key: "remaining", label: "Remaining", align: "right" }, { key: "currentStageLabel", label: "Stage" }], rows.filter((r) => r.remaining > 0).sort((a, b) => b.remaining - a.remaining).slice(0, 20).map((r) => ({ ...r, href: orderHref(r.moId) })))], followUps: ["Which orders are delayed?", "What recovery rate is required?"] };
  },

  async recovery_pace(companyId, e) {
    const date = e.date || e.to;
    if (e.po || e.mo || e.moSuffix) {
      const { order } = await resolveOrder(companyId, e);
      if (order) {
        const d = await orders.orderDetail(companyId, order.moId, date);
        const o = d.order;
        const rows = d.departments.filter((p) => p.applicable && p.remaining > 0).map((p) => ({ label: p.label, remaining: p.remaining, requiredToDelivery: o.daysToDelivery > 0 ? Math.ceil(p.remaining / o.daysToDelivery) : null, targetPace: p.activeTarget?.span?.neededPerDay ?? null, capacity: p.standard?.capacityPerDay ?? null }));
        return { title: `Recovery pace — ${o.moNumber}`, text: o.daysToDelivery == null ? "No delivery date is recorded, so no pace can be required against it." : o.daysToDelivery <= 0 ? `The delivery date has passed; ${n(o.remaining)} pieces remain to sew.` : `${n(o.remaining)} pieces remain with ${o.daysToDelivery} day${o.daysToDelivery === 1 ? "" : "s"} to delivery: ${n(o.requiredPerDay)} a day sewn from here.`, blocks: [table("Per department", [{ key: "label", label: "Department" }, { key: "remaining", label: "Remaining", align: "right" }, { key: "requiredToDelivery", label: "Needed/day to delivery", align: "right" }, { key: "targetPace", label: "Needed/day to target", align: "right" }, { key: "capacity", label: "Capacity/day", align: "right" }], rows), links([{ label: `Open ${o.moNumber}`, href: orderHref(o.moId) }])], followUps: [`What is the status of ${o.moNumber}?`] };
      }
    }
    const h = await reports.hourly(companyId, { date });
    const rows = h.departments.filter((d) => d.hasTarget).map((d) => ({ label: d.label, target: d.totals.target, actual: d.totals.actual, remaining: d.totals.remaining, requiredPerRemainingHour: d.totals.requiredPerRemainingHour, pacePerHour: d.totals.pacePerHour, expectedEndOfDay: d.totals.expectedEndOfDay, href: deptHref(d.department, date) }));
    return { title: `Pace required for the rest of ${h.isToday ? "today" : fmtDay(date)}`, text: rows.length ? rows.filter((r) => r.remaining > 0).map((r) => `${r.label}: ${n(r.remaining)} more, ${r.requiredPerRemainingHour != null ? `${n(r.requiredPerRemainingHour)}/h needed vs ${r.pacePerHour}/h so far` : "the shift is over"}`).join("; ") + "." : "No department has a target for this day.", blocks: [table("Departments with a target", [{ key: "label", label: "Department" }, { key: "target", label: "Target", align: "right" }, { key: "actual", label: "Done", align: "right" }, { key: "remaining", label: "Remaining", align: "right" }, { key: "pacePerHour", label: "Pace so far/h", align: "right" }, { key: "requiredPerRemainingHour", label: "Needed/h", align: "right" }, { key: "expectedEndOfDay", label: "Expected EOD", align: "right" }], rows)], followUps: ["Which departments are behind target?", "Which orders are delayed?"] };
  },

  async wo_status(companyId, e) {
    const { hits } = await orders.search(companyId, e.wo.replace(/^WO-/i, ""));
    const hit = hits.find((h) => h.type === "workOrder");
    if (!hit) return { title: "Work order not found", text: `No work order matches ${e.wo}.`, blocks: [], followUps: [] };
    const d = await orders.workOrderDetail(companyId, hit.woId);
    const w = d.workOrder;
    return {
      title: `${w.number} · ${w.product}${w.variant ? ` · ${w.variant}` : ""}`,
      text: `${n(w.produced)} of ${n(w.quantity)} sewn (${w.progressPct}%). Reached ${w.currentStageLabel}${w.nextStage ? `; next ${w.nextStageLabel}` : ""}. Order ${d.order?.moNumber || "—"}${d.order?.poNumber ? `, PO ${d.order.poNumber}` : ""}, ${d.order?.customerName || ""}.${w.lastActivityAt ? ` Last activity ${fmtAt(w.lastActivityAt)}.` : ""}`,
      blocks: [facts([{ label: "Work order", value: w.number, sub: `${w.product}${w.variant ? ` · ${w.variant}` : ""}` }, { label: "Order", value: d.order?.moNumber || "—", sub: d.order?.customerName }, { label: "PO", value: d.order?.poNumber || "Not recorded" }, { label: "Quantity", value: n(w.quantity) }, { label: "Sewn", value: n(w.produced), sub: `${w.progressPct}%` }, { label: "Stage", value: w.currentStageLabel, sub: w.nextStage ? `next: ${w.nextStageLabel}` : null }]),
        table("Department by department", [{ key: "label", label: "Department" }, { key: "done", label: "Done", align: "right" }, { key: "remaining", label: "Remaining", align: "right" }, { key: "pct", label: "%", align: "right" }, { key: "lastAt", label: "Last activity", type: "datetime" }], d.departments.filter((p) => p.applicable)),
        links([{ label: `Open ${w.number}`, href: woHref(w.id) }, d.order ? { label: `Open ${d.order.moNumber}`, href: orderHref(d.order.moId) } : null]),
        report("Generate the work order report", "workOrder", { woId: w.id })],
      followUps: d.order ? [`What is the status of ${d.order.moNumber}?`] : [],
    };
  },

  async unit_status(companyId, e) {
    const { hits } = await orders.search(companyId, e.barcode);
    const hit = hits.find((h) => h.type === "barcode");
    if (!hit) return { title: "Barcode not found", text: `${e.barcode} does not belong to any work order of this company.`, blocks: [], followUps: [] };
    const d = await orders.workOrderDetail(companyId, hit.woId);
    const unit = hit.unit;
    const rows = d.activity.filter((a) => a.unit === unit).sort((a, b) => new Date(a.at) - new Date(b.at));
    return { title: `${e.barcode} — unit ${unit} of ${d.workOrder.number}`, text: rows.length ? `Recorded at ${rows.map((r) => `${r.label} (${fmtAt(r.at)})`).join(", ")}.` : "No department has recorded this unit yet.", blocks: [facts([{ label: "Work order", value: d.workOrder.number, sub: `${d.workOrder.product} · ${d.workOrder.variant}` }, { label: "Order", value: d.order?.moNumber || "—", sub: d.order?.customerName }, { label: "Unit", value: String(unit), sub: `of ${d.workOrder.quantity}` }]), table("Journey", [{ key: "label", label: "Department" }, { key: "at", label: "When", type: "datetime" }, { key: "person", label: "By" }], rows), links([{ label: `Open ${d.workOrder.number}`, href: woHref(d.workOrder.id) }])], followUps: [`What is the status of ${d.workOrder.number}?`] };
  },

  async target_status(companyId, e) {
    const date = e.date || e.to;
    if (e.po || e.mo || e.moSuffix) {
      const { order } = await resolveOrder(companyId, e);
      if (order) {
        const a = await reports.achievement(companyId, { from: date, to: date, moId: order.moId });
        return targetAnswer(`Targets on ${order.label} — ${fmtDay(date)}`, a, date);
      }
    }
    const a = await reports.achievement(companyId, { from: date, to: date, department: e.department || undefined });
    return targetAnswer(`${e.department ? `${label(e.department)} target` : "Targets"} — ${fmtDay(date)}`, a, date);
  },

  async target_missed(companyId, e) {
    const date = e.date || shift.shiftDayKey(orders.todayKey(), -1);
    const a = await reports.achievement(companyId, { from: date, to: date, department: e.department || undefined });
    const missed = a.targets.filter((t) => t.target > 0 && t.actual < t.target);
    return { title: `Targets missed on ${fmtDay(date)}`, text: !a.targets.length ? "No target applied on that day." : missed.length ? `${missed.length} of ${a.targets.length} target${a.targets.length === 1 ? "" : "s"} missed: ${missed.map((t) => `${t.label} on ${t.moNumber} (${n(t.actual)} of ${n(t.target)})`).join("; ")}.` : `Every target that applied on ${fmtDay(date)} was met.`, blocks: [table("Targets that day", [{ key: "label", label: "Department" }, { key: "moNumber", label: "Order" }, { key: "customerName", label: "Customer" }, { key: "target", label: "Target", align: "right" }, { key: "actual", label: "Actual", align: "right" }, { key: "difference", label: "Difference", align: "right", type: "delta" }, { key: "achievementPct", label: "Achieved", align: "right", type: "pct" }], a.targets.map((t) => ({ ...t, href: orderHref(t.moId) }))), report("Generate the target achievement report", "achievement", { from: date, to: date })], followUps: ["Which departments are behind target?", "Give target achievement report"] };
  },

  async report_summary(companyId, e) {
    const from = e.from || e.date, to = e.to || e.date;
    const dept = e.department || undefined;
    if (from === to) {
      const r = await reports.range(companyId, { from, to, department: dept });
      const d = await reports.daily(companyId, { from, to, department: dept });
      const day = d.days[0];
      return { title: `${dept ? `${label(dept)} — ` : ""}Day report for ${fmtDay(from)}`, text: `${n(r.totals.pieces)} pieces recorded across ${r.totals.orders} order${r.totals.orders === 1 ? "" : "s"} and ${r.totals.workOrders} work order${r.totals.workOrders === 1 ? "" : "s"}${day?.target ? `; sewing ${n(day.actual)} of ${n(day.target)} target (${pctS(day.achievementPct)})` : ""}. ${day?.ordersCompleted?.length ? `${day.ordersCompleted.length} order${day.ordersCompleted.length === 1 ? "" : "s"} finished sewing.` : ""}`, blocks: [table("By department", [{ key: "label", label: "Department" }, { key: "target", label: "Target", align: "right" }, { key: "actual", label: "Actual", align: "right" }, { key: "achievementPct", label: "Achieved", align: "right", type: "pct" }, { key: "orders", label: "Orders", align: "right" }, { key: "workOrders", label: "WOs", align: "right" }, { key: "people", label: "People", align: "right" }], (day?.departments || []).filter((x) => x.actual || x.target).map((x) => ({ ...x, href: deptHref(x.department, from) }))), table("By order", [{ key: "moNumber", label: "Order" }, { key: "poNumber", label: "PO" }, { key: "customerName", label: "Customer" }, { key: "pieces", label: "Pieces", align: "right" }], r.orders.slice(0, 15).map((x) => ({ ...x, href: orderHref(x.moId) }))), report("Generate the daily report", "daily", { date: from }), links([{ label: "Open Reports", href: `/ppc/reports?type=daily&date=${from}` }])], followUps: ["Compare yesterday vs today", "Give me hour-wise sewing production today"] };
    }
    const d = await reports.daily(companyId, { from, to, department: dept });
    return { title: `${dept ? `${label(dept)} — ` : ""}${fmtDay(from)} to ${fmtDay(to)}`, text: `${n(d.totals.actual)} pieces ${dept ? DEPARTMENT_META[dept].done : "sewn"}${d.totals.target ? ` against ${n(d.totals.target)} target (${pctS(d.totals.achievementPct)})` : ""} over ${d.totals.activeDays} active day${d.totals.activeDays === 1 ? "" : "s"} (${n(d.totals.avgPerActiveDay)} a day${d.totals.bestDay ? `, best ${fmtDay(d.totals.bestDay)}` : ""}).`, blocks: [table("Day by day", [{ key: "date", label: "Date", type: "date" }, { key: "target", label: "Target", align: "right" }, { key: "actual", label: "Actual", align: "right" }, { key: "achievementPct", label: "Achieved", align: "right", type: "pct" }, { key: "cumulativeActual", label: "Cumulative", align: "right" }, { key: "activeOrders", label: "Orders", align: "right" }], d.days), table("By department", [{ key: "label", label: "Department" }, { key: "target", label: "Target", align: "right" }, { key: "actual", label: "Actual", align: "right" }, { key: "achievementPct", label: "Achieved", align: "right", type: "pct" }], d.totals.departments.filter((x) => x.actual || x.target)), report("Generate the department report", dept ? "department" : "range", dept ? { department: dept, from, to } : { from, to }), links([{ label: "Day by day", href: `/ppc/monitor?view=daily&from=${from}&to=${to}` }])], followUps: ["Give target achievement report", "Which orders are delayed?"] };
  },

  async product_progress(companyId, e) {
    const { order } = await resolveOrder(companyId, e);
    const q = { product: e.product || undefined, variant: e.variant || (e.size ? e.size : undefined) };
    const pv = await reports.productVariant(companyId, q);
    let products = pv.products;
    if (order) products = products.map((p) => ({ ...p, variants: p.variants.map((v) => ({ ...v, workOrders: v.workOrders.filter((w) => w.moId === order.moId) })).filter((v) => v.workOrders.length) })).filter((p) => p.variants.length).map((p) => { const variants = p.variants.map((v) => ({ ...v, quantity: v.workOrders.reduce((s, w) => s + w.quantity, 0), produced: v.workOrders.reduce((s, w) => s + w.produced, 0) })).map((v) => ({ ...v, remaining: Math.max(0, v.quantity - v.produced), pct: v.quantity ? Math.round((v.produced / v.quantity) * 1000) / 10 : 0 })); const quantity = variants.reduce((s, v) => s + v.quantity, 0), produced = variants.reduce((s, v) => s + v.produced, 0); return { ...p, variants, quantity, produced, remaining: Math.max(0, quantity - produced), pct: quantity ? Math.round((produced / quantity) * 1000) / 10 : 0 }; });
    if (e.size) products = products.map((p) => ({ ...p, variants: p.variants.filter((v) => String(v.size || v.variant).toUpperCase() === e.size || v.variant.toUpperCase().split(" · ").includes(e.size)) })).filter((p) => p.variants.length);
    const totalQ = products.reduce((s, p) => s + (e.size ? p.variants.reduce((a, v) => a + v.quantity, 0) : p.quantity), 0), totalP = products.reduce((s, p) => s + (e.size ? p.variants.reduce((a, v) => a + v.produced, 0) : p.produced), 0);
    const what = [e.product ? `product "${e.product}"` : null, e.size ? `size ${e.size}` : null, e.variant ? `variant "${e.variant}"` : null, order ? `on ${order.label}` : null].filter(Boolean).join(", ") || "every product";
    return { title: `Progress for ${what}`, text: products.length ? `${n(totalP)} of ${n(totalQ)} sewn (${totalQ ? Math.round((totalP / totalQ) * 100) : 0}%) across ${products.length} product${products.length === 1 ? "" : "s"}.` : `Nothing matches ${what}.`, blocks: [table("Products and variants", [{ key: "product", label: "Product" }, { key: "variant", label: "Variant" }, { key: "quantity", label: "Qty", align: "right" }, { key: "produced", label: "Sewn", align: "right" }, { key: "remaining", label: "Remaining", align: "right" }, { key: "pct", label: "%", align: "right", type: "pct" }, { key: "orders", label: "Orders", align: "right" }], products.flatMap((p) => p.variants.map((v) => ({ product: p.product, variant: v.variant, quantity: v.quantity, produced: v.produced, remaining: v.remaining, pct: v.pct, orders: v.orders })))), report("Generate the product / variant report", "productVariant", q)], followUps: ["Show production of size M", "Give me today's production summary"] };
  },

  async person_wise(companyId, e) {
    const { order } = await resolveOrder(companyId, e);
    if (!order && !e.person) {
      const l = await orders.personWiseOrders(companyId, { limit: 50 });
      return { title: "Person-wise orders", text: l.rows.length ? `${l.rows.length} measurement order${l.rows.length === 1 ? "" : "s"}. Name one (by MO or PO) or a person to see their units.` : "There are no person-wise orders.", blocks: [table("Measurement orders", [{ key: "moNumber", label: "Order" }, { key: "poNumber", label: "PO" }, { key: "customerName", label: "Customer" }, { key: "persons", label: "People", align: "right" }, { key: "quantity", label: "Qty", align: "right" }, { key: "produced", label: "Sewn", align: "right" }, { key: "progressPct", label: "%", align: "right", type: "pct" }, { key: "currentStageLabel", label: "Stage" }], l.rows.map((r) => ({ ...r, href: `${orderHref(r.moId)}?tab=persons` })))], followUps: l.rows.slice(0, 2).map((r) => `Show person-wise production for ${r.moNumber}`) };
    }
    let moIds = order ? [order.moId] : (await orders.personWiseOrders(companyId, { limit: 100 })).rows.map((r) => r.moId);
    const rows = [];
    let header = null;
    for (const moId of moIds.slice(0, 20)) {
      const pw = await orders.personWise(companyId, moId);
      if (!pw) continue;
      header = header || pw;
      for (const p of pw.persons) if (!e.person || p.name.toLowerCase().includes(e.person.toLowerCase()) || p.uin.toLowerCase() === e.person.toLowerCase()) rows.push({ ...p, moId, moNumber: pw.order.moNumber, poNumber: pw.order.poNumber });
    }
    const title = order ? `Person-wise — ${order.label}${e.person ? ` · ${e.person}` : ""}` : `Person-wise — ${e.person}`;
    return { title, text: rows.length ? `${rows.length} ${rows.length === 1 ? "person" : "people"}, ${n(rows.reduce((s, r) => s + r.totalUnits, 0))} units: ${n(rows.reduce((s, r) => s + r.produced, 0))} sewn, ${n(rows.reduce((s, r) => s + r.dispatched, 0))} dispatched, ${rows.filter((r) => r.status === "completed").length} complete.` : e.person ? `No person named "${e.person}" is on ${order ? order.label : "any person-wise order"}.` : "No people are recorded on this order.", blocks: [table("People", [{ key: "name", label: "Person" }, { key: "uin", label: "UIN" }, { key: "moNumber", label: "Order" }, { key: "totalUnits", label: "Units", align: "right" }, { key: "produced", label: "Sewn", align: "right" }, { key: "dispatched", label: "Dispatched", align: "right" }, { key: "completionPct", label: "%", align: "right", type: "pct" }, { key: "currentStageLabel", label: "Stage" }, { key: "status", label: "Status", type: "status" }], rows.map((r) => ({ ...r, status: r.status === "completed" ? "Complete" : r.status === "in_production" ? "In production" : "Not started", statusTone: r.status === "completed" ? "positive" : "neutral", href: `${orderHref(r.moId)}?tab=persons` }))), order ? report("Generate the person-wise report", "personWise", { moId: order.moId }) : null].filter(Boolean), followUps: order ? [`What is the status of ${order.label}?`] : [] };
  },
};

function targetAnswer(title, a, date) {
  const t = a.totals;
  return { title, text: !a.targets.length ? "No PPC target applies here on this day." : `${a.targets.length} target${a.targets.length === 1 ? "" : "s"}: ${n(t.actual)} of ${n(t.target)} (${t.target ? pctS(Math.round((t.actual / t.target) * 100)) : "—"}); ${t.behind} behind, ${t.onTrack} on track, ${t.achieved} achieved.`, blocks: [table("Targets", [{ key: "label", label: "Department" }, { key: "moNumber", label: "Order" }, { key: "customerName", label: "Customer" }, { key: "description", label: "Target" }, { key: "target", label: "Expected", align: "right" }, { key: "actual", label: "Actual", align: "right" }, { key: "difference", label: "Difference", align: "right", type: "delta" }, { key: "achievementPct", label: "Achieved", align: "right", type: "pct" }, { key: "requiredPace", label: "Needed/day", align: "right" }, { key: "status", label: "Status", type: "status" }], a.targets.map((x) => ({ ...x, status: STATUS_WORD[x.status], statusTone: STATUS_TONE[x.status], href: `/ppc/targets?mo=${x.moId}&dept=${x.department}` }))), ...a.targets.filter((x) => x.advice).slice(0, 3).map((x) => note(x.status === "behind" ? "overdue" : "neutral", `${x.label} on ${x.moNumber}: ${x.advice}`)), report("Generate the target achievement report", "achievement", { from: date, to: date }), links([{ label: "Target vs achievement", href: `/ppc/achievement?from=${date}&to=${date}` }])], followUps: ["What pace is required for the remaining hours?", "Which departments are behind target?"] };
}

const SUGGESTIONS = [
  { group: "Today", text: "Give me today's production summary" },
  { group: "Today", text: "Which departments are behind target?" },
  { group: "Today", text: "Which department is performing best today?" },
  { group: "Department", text: "Give me today's embroidery update" },
  { group: "Department", text: "Show sewing production today" },
  { group: "Department", text: "How many pieces were packed today?" },
  { group: "Hourly", text: "Give me hour-wise sewing production today" },
  { group: "Hourly", text: "What was sewing production between 11 AM and 2 PM?" },
  { group: "Hourly", text: "Which hour had the highest production?" },
  { group: "Orders", text: "Which orders are delayed?" },
  { group: "Orders", text: "Which orders are close to completion?" },
  { group: "Orders", text: "What is the status of MO-REQ-2026-0003?" },
  { group: "Targets", text: "What is today's target for sewing?" },
  { group: "Targets", text: "Which departments missed target yesterday?" },
  { group: "Targets", text: "What pace is required for the remaining hours?" },
  { group: "Reports", text: "Give me today's day-end production summary" },
  { group: "Reports", text: "Show this week's production" },
  { group: "Reports", text: "Compare yesterday vs today" },
  { group: "Products", text: "Show production of size M" },
  { group: "People", text: "Show person-wise orders" },
  { group: "Delay", text: "Which department is causing the delay?" },
  { group: "Delay", text: "What quantity is pending?" },
];

function suggestions() { return { suggestions: SUGGESTIONS, intents: Object.entries(intents.INTENTS).map(([key, l]) => ({ key, label: l })) }; }

module.exports = { answer, suggestions, SUGGESTIONS, handlers };
