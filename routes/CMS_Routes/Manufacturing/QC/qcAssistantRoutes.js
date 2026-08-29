// routes/CMS_Routes/Manufacturing/QC/qcAssistantRoutes.js
//
// THE QC ASSISTANT — ask the department's own data a question in English.
//
// Explicit request, 29 Aug 2026: "add an chatbot in the overview page so that
// if someone needs custom answer, then he can also get the answer properly via
// the chat... connect with gemini api key... also if he ask for give me the
// report then also the chatbot can give the excel sheet report... means an
// complete ai assistant... behave completely like human."
//
// THE ONE RULE THIS FILE IS BUILT AROUND: THE MODEL NEVER INVENTS A NUMBER.
//
// A QC dashboard exists to be trusted. An assistant that hallucinates "DHU was
// 4.2% last week" is worse than no assistant at all, because a plausible wrong
// figure gets acted on. So the model is never asked to compute or recall
// anything — every figure it can say is handed to it, already computed, in a
// snapshot built here from the same Mongo reads the dashboard itself uses. The
// model's whole job is to READ that snapshot and explain it in English. If the
// snapshot does not contain the answer, it is instructed to say so and name
// what it would need, rather than guess.
//
// The same rule governs reports. The model does not write a spreadsheet; it
// chooses a report TYPE and a date window, and `buildReport` fills it from
// Mongo. That way the chat's prose and the downloaded .xlsx are the same
// numbers from the same source, and neither can drift from the dashboard.
//
// Scope: owner-only, like the rest of the department-wide QC reads. An
// inspector asking "what is our DHU this month" is asking about other people's
// work, which is the thing qcViewer exists to prevent.

"use strict";

const express = require("express");
const router = express.Router();

const QCInspection = require("../../../../models/CMS_Models/Manufacturing/QC/DefectRecord");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");
const qcViewer = require("../../../../services/qcViewer");

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
// Same ladder askAI.routes.js walks, and for the same reason: the newest model
// has the best free quota but is a preview, so a hard failure falls back rather
// than taking the feature down.
const MODELS_TO_TRY = [
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
];

const istDateString = (d = new Date()) => {
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
};
const addDaysISO = (iso, n) => {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + n);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
};
const pct = (n, d) => (d ? +((n / d) * 100).toFixed(1) : 0);

async function requireOwner(req, res) {
  const viewer = await qcViewer.resolveViewer(req);
  if (!viewer.canSeeEveryone) {
    res.status(403).json({ success: false, message: "Only the QC owner can use the assistant." });
    return null;
  }
  return viewer;
}

/* ── The snapshot ─────────────────────────────────────────────────────────── */

/**
 * Everything the assistant is allowed to know, computed from Mongo.
 *
 * Deliberately capped in size — this is stuffed into a prompt, and a snapshot
 * that grows with the collection would eventually blow the context window and
 * start silently truncating (which reads to the user as the assistant
 * "forgetting" recent days). Rollups only; no raw scan lists.
 */
async function buildSnapshot({ days = 30 } = {}) {
  const today = istDateString();
  const since = addDaysISO(today, -(days - 1));

  const scans = await QCInspection.find({ date: { $gte: since, $lte: today } })
    .select("barcodeId date status defects defectTypes stageName inspectedByQCName workOrderShortId")
    .lean();

  // Garment-level truth, the same definition every other QC surface uses.
  const garments = new Map();
  for (const s of scans) {
    if (!garments.has(s.barcodeId)) garments.set(s.barcodeId, { failed: false, rejected: false, date: s.date });
    const g = garments.get(s.barcodeId);
    if (s.status === "rejected") { g.rejected = true; g.failed = true; }
    else if (s.status === "defective") g.failed = true;
  }
  const inspected = garments.size;
  const failed = [...garments.values()].filter((g) => g.failed).length;
  const rejected = [...garments.values()].filter((g) => g.rejected).length;

  const typeCount = new Map(), opCount = new Map(), stageCount = new Map(), inspectorCount = new Map();
  let defects = 0;
  const bump = (m, k, label) => {
    if (!k) return;
    if (!m.has(k)) m.set(k, { key: k, label: label || k, count: 0 });
    m.get(k).count++;
  };
  for (const s of scans) {
    for (const d of (s.defects || [])) {
      bump(opCount, (d.operationCode || "").trim() || "—", d.operationName);
      if ((d.types || []).length) {
        for (const t of d.types) { defects++; bump(typeCount, String(t.code || t.name || "").toUpperCase(), t.name || t.code); }
      } else defects++;
    }
    for (const t of (s.defectTypes || [])) { defects++; bump(typeCount, String(t.code || t.name || "").toUpperCase(), t.name || t.code); }
    bump(stageCount, s.stageName || "No checkpoint", s.stageName || "No checkpoint");
    bump(inspectorCount, s.inspectedByQCName || "—", s.inspectedByQCName || "—");
  }

  // Per-day DHU, product-wise (mutually exclusive pass/fail per garment) — the
  // same definition the overview's trend chart draws.
  const dayMap = new Map();
  for (const [, g] of garments) {
    if (!dayMap.has(g.date)) dayMap.set(g.date, { date: g.date, inspected: 0, failed: 0 });
    const row = dayMap.get(g.date);
    row.inspected++;
    if (g.failed) row.failed++;
  }
  const daily = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({ ...d, dhu: pct(d.failed, d.inspected) }));

  const top = (m, n = 8) => [...m.values()].sort((a, b) => b.count - a.count).slice(0, n)
    .map((r) => ({ ...r, share: pct(r.count, defects || 1) }));

  // Order-level coverage, so "which order is behind" is answerable.
  const workOrders = await WorkOrder.find({ status: { $ne: "cancelled" } })
    .select("_id quantity customerRequestId stockItemName customerName").lean();
  const seenByShortId = new Map();
  for (const s of scans) {
    if (!seenByShortId.has(s.workOrderShortId)) seenByShortId.set(s.workOrderShortId, new Set());
    seenByShortId.get(s.workOrderShortId).add(s.barcodeId);
  }
  const moRoll = new Map();
  for (const wo of workOrders) {
    const key = wo.customerRequestId ? String(wo.customerRequestId) : "unassigned";
    if (!moRoll.has(key)) moRoll.set(key, { ordered: 0, seen: 0, customerName: wo.customerName || "—", wos: 0 });
    const r = moRoll.get(key);
    r.ordered += wo.quantity || 0;
    r.wos++;
    r.seen += (seenByShortId.get(wo._id.toString().slice(-8))?.size) || 0;
  }
  const mos = await CustomerRequest.find({ _id: { $in: [...moRoll.keys()].filter((k) => k !== "unassigned") } })
    .select("requestId customerInfo").lean();
  const moName = new Map(mos.map((m) => [String(m._id), m.requestId]));
  const orders = [...moRoll.entries()].map(([k, r]) => ({
    order: moName.get(k) || (k === "unassigned" ? "Unassigned" : k),
    customer: r.customerName, workOrders: r.wos,
    ordered: r.ordered, inspected: r.seen, coverage: pct(r.seen, r.ordered),
  })).sort((a, b) => b.ordered - a.ordered).slice(0, 25);

  return {
    generatedAt: new Date().toISOString(),
    window: { from: since, to: today, days },
    totals: {
      garmentsInspected: inspected,
      scansRecorded: scans.length,
      defectsRecorded: defects,
      garmentsFailed: failed,
      garmentsRejected: rejected,
      garmentsPassed: inspected - failed,
      dhuPercent: pct(defects, inspected),
      defectRatePercent: pct(failed, inspected),
      rftPercent: pct(inspected - failed, inspected),
      rejectRatePercent: pct(rejected, inspected),
    },
    definitions: {
      dhuPercent: "Defects per Hundred Units: total defects ÷ garments inspected × 100. Counts defects, so it can exceed 100%.",
      defectRatePercent: "Garments that failed at least once ÷ garments inspected × 100. Counts garments, so it cannot exceed 100%.",
      rftPercent: "Right First Time: garments that never failed ÷ garments inspected × 100.",
      rejectRatePercent: "Garments scrapped ÷ garments inspected × 100.",
    },
    dailyDhu: daily,
    topDefectTypes: top(typeCount),
    topOperations: top(opCount),
    byCheckpoint: top(stageCount, 10),
    byInspector: top(inspectorCount, 10),
    orders,
  };
}

/* ── Gemini ───────────────────────────────────────────────────────────────── */

const SYSTEM_PROMPT = `You are the QC assistant for GRAV Clothing, a garment manufacturer. You help the Quality Control owner understand their inspection data.

HOW YOU MUST BEHAVE:
- Talk like a knowledgeable colleague, not a chatbot. Warm, direct, plain English. No bullet-point walls unless the user asks for a list. No emoji. Never open with "Certainly!" or "Great question!".
- Be concise. Two or three short paragraphs is usually right. Give the answer first, then the reasoning.
- Always ground every number in the DATA SNAPSHOT provided. Quote figures exactly as given.
- NEVER invent, estimate, extrapolate or recall a number that is not in the snapshot. If the snapshot cannot answer the question, say plainly what is missing and what you would need — do not guess.
- When you quote DHU and defect rate together, remember they legitimately differ: DHU counts individual defects (can exceed 100%), defect rate counts garments (cannot). Explain that if it would otherwise look like a contradiction.
- If the numbers are bad, say so plainly and point at the specific operation, checkpoint or defect type driving it. If they are fine, say that too — do not manufacture concern.
- If the snapshot shows zero inspections, say the window is empty rather than reporting 0% as if it were a result.

REPORTS:
If the user asks for a report, spreadsheet, Excel, export or download, end your reply with a single line exactly of this form and nothing after it:
[[REPORT:<type>:<from>:<to>]]
where <type> is one of: summary, defects, operations, inspectors, checkpoints, orders, daily, raw
and <from>/<to> are YYYY-MM-DD dates (use the snapshot window if the user did not name a period).
Say in your prose that the file is ready to download. Do not describe the columns.
Only emit that line when a file is genuinely wanted.`;

async function askGemini(question, snapshot, history) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured on the server.");

  const contents = [];
  for (const turn of (history || []).slice(-8)) {
    if (!turn?.text) continue;
    contents.push({ role: turn.role === "assistant" ? "model" : "user", parts: [{ text: String(turn.text).slice(0, 4000) }] });
  }
  contents.push({
    role: "user",
    parts: [{
      text: `DATA SNAPSHOT (the only facts you may use — all figures already computed):\n${JSON.stringify(snapshot)}\n\nTODAY IS ${istDateString()} (IST).\n\nQUESTION: ${question}`,
    }],
  });

  let lastErr = null;
  let authFailed = false;
  for (const model of MODELS_TO_TRY) {
    try {
      const r = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
        method: "POST",
        // Header rather than ?key= — the query-string form leaks the key into
        // access logs and proxy history, and both are accepted.
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents,
          generationConfig: { temperature: 0.3, maxOutputTokens: 1400 },
        }),
      });
      if (!r.ok) {
        // 401/403 is the key, not the model — trying the next three models
        // wastes three more round-trips to reach the same answer.
        if (r.status === 401 || r.status === 403) { authFailed = true; break; }
        lastErr = new Error(`${model}: ${r.status} ${(await r.text()).slice(0, 300)}`);
        continue;
      }
      const j = await r.json();
      const text = j?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("").trim();
      if (text) return { text, model };
      lastErr = new Error(`${model}: empty response`);
    } catch (e) { lastErr = e; }
  }

  // A configuration problem should read as one. "Cannot read properties of
  // undefined" in a chat bubble sends somebody debugging the wrong thing.
  if (authFailed) {
    const err = new Error(
      "The assistant is not connected yet: Google rejected the configured GEMINI_API_KEY. " +
      "It needs a Gemini API key from https://aistudio.google.com/apikey (these start with \"AIza\"). " +
      "Everything else on this dashboard works without it.",
    );
    err.code = "GEMINI_AUTH";
    throw err;
  }
  throw lastErr || new Error("Every Gemini model failed.");
}

/* ── Routes ───────────────────────────────────────────────────────────────── */

// The buttons the overview shows so the common questions need no typing.
const SUGGESTIONS = [
  { id: "today", label: "How are we doing today?", question: "How is quality doing today compared with the rest of this month?" },
  { id: "worst", label: "What fails most?", question: "What defect type and which operation are causing the most failures right now, and how bad is it?" },
  { id: "trend", label: "Is DHU getting better?", question: "Is our DHU trending up or down over this window? Point at the days that moved it." },
  { id: "orders", label: "Which order is behind?", question: "Which orders has QC covered the least of, and which ones should we worry about?" },
  { id: "checkpoints", label: "How do checkpoints compare?", question: "Compare the checkpoints — which one catches the most, and does that suggest a problem upstream of it?" },
  { id: "report", label: "Give me a report", question: "Give me an Excel report summarising this month's quality performance." },
];

router.get("/assistant/suggestions", async (req, res) => {
  if (!(await requireOwner(req, res))) return;
  res.json({ success: true, suggestions: SUGGESTIONS });
});

router.post("/assistant", async (req, res) => {
  try {
    if (!(await requireOwner(req, res))) return;

    const question = String(req.body?.question || "").trim();
    if (!question) return res.status(400).json({ success: false, message: "Ask me something." });
    if (question.length > 2000) return res.status(400).json({ success: false, message: "That question is too long." });

    const days = Math.min(Math.max(parseInt(req.body?.days, 10) || 30, 1), 180);
    const snapshot = await buildSnapshot({ days });
    const { text, model } = await askGemini(question, snapshot, req.body?.history);

    // Pull the report directive out of the prose so the UI can show a button
    // rather than a raw token.
    const m = text.match(/\[\[REPORT:([a-z]+):(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})\]\]/i);
    const answer = text.replace(/\[\[REPORT:[^\]]*\]\]/gi, "").trim();

    res.json({
      success: true,
      answer,
      model,
      report: m ? { type: m[1].toLowerCase(), from: m[2], to: m[3] } : null,
      window: snapshot.window,
    });
  } catch (err) {
    console.error("[QC assistant] error:", err.message);
    // 503, not 500: the dashboard is fine, the model is unreachable. The UI
    // shows `message` verbatim, so it has to be a sentence a person can act on.
    res.status(err.code === "GEMINI_AUTH" ? 503 : 500)
      .json({ success: false, message: err.message, code: err.code || null });
  }
});

/**
 * The .xlsx the chat offers. Built from Mongo, never from the model's prose —
 * see this file's header for why that separation is not negotiable.
 */
router.get("/assistant/report", async (req, res) => {
  try {
    if (!(await requireOwner(req, res))) return;

    const type = String(req.query.type || "summary").toLowerCase();
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || "") ? req.query.to : istDateString();
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || "") ? req.query.from : addDaysISO(to, -29);

    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    wb.creator = "GRAV Clothing — QC Assistant";
    wb.created = new Date();

    await writeReportSheets(wb, type, from, to);

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="qc-${type}-${from}_to_${to}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("[QC assistant report] error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * ONE ORDER'S QC REPORT (explicit request, 29 Aug 2026: "report download and
 * all are also needed to keep as per the order wise").
 *
 * Deliberately lives here beside the assistant's exporter rather than in
 * qcRoutes: it is the same workbook machinery, the same column conventions and
 * the same "every sheet carries a note saying what its numbers mean" rule. Two
 * copies of that would drift, and a report that explains itself differently
 * depending on which button produced it is worse than one that does not
 * explain itself at all.
 */
router.get("/orders/:moId/report", async (req, res) => {
  try {
    if (!(await requireOwner(req, res))) return;

    const { moId } = req.params;
    const isUnassigned = moId === "unassigned";
    if (!isUnassigned && !/^[0-9a-fA-F]{24}$/.test(moId)) {
      return res.status(400).json({ success: false, message: "That is not a valid order id." });
    }

    const workOrders = await WorkOrder.find(isUnassigned
      ? { status: { $ne: "cancelled" }, $or: [{ customerRequestId: null }, { customerRequestId: { $exists: false } }] }
      : { status: { $ne: "cancelled" }, customerRequestId: moId })
      .select("_id workOrderNumber quantity stockItemName customerName status assignedDeadline").lean();

    const mo = isUnassigned ? null
      : await CustomerRequest.findById(moId).select("requestId customerInfo deliveryDeadline finalOrderPrice").lean();
    const orderLabel = mo?.requestId || "Unassigned";

    const shortIdOf = (id) => id.toString().slice(-8);
    const shortIds = workOrders.map((wo) => shortIdOf(wo._id));
    const scans = shortIds.length
      ? await QCInspection.find({ workOrderShortId: { $in: shortIds } })
        .select("barcodeId workOrderShortId date status defects defectTypes stageName inspectedByQCName inspectedAt reworkRound")
        .sort({ inspectedAt: 1 }).lean()
      : [];

    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    wb.creator = "GRAV Clothing — Quality Control";
    wb.created = new Date();

    // ── Garment-level truth, the same definitions every QC surface uses. ──
    const garments = new Map();
    for (const s of scans) {
      if (!garments.has(s.barcodeId)) garments.set(s.barcodeId, { failed: false, rejected: false, shortId: s.workOrderShortId });
      const g = garments.get(s.barcodeId);
      if (s.status === "rejected") { g.rejected = true; g.failed = true; }
      else if (s.status === "defective") g.failed = true;
    }
    const ordered = workOrders.reduce((n, wo) => n + (wo.quantity || 0), 0);
    const inspected = garments.size;
    const failed = [...garments.values()].filter((g) => g.failed).length;
    const rejected = [...garments.values()].filter((g) => g.rejected).length;
    let defects = 0;
    const typeCount = new Map(), opCount = new Map();
    for (const s of scans) {
      for (const d of (s.defects || [])) {
        const ok = (d.operationCode || "—").trim();
        if (!opCount.has(ok)) opCount.set(ok, { label: d.operationName || ok, key: ok, count: 0 });
        opCount.get(ok).count++;
        if ((d.types || []).length) for (const t of d.types) {
          defects++;
          const tk = String(t.code || t.name || "").toUpperCase();
          if (!typeCount.has(tk)) typeCount.set(tk, { label: t.name || t.code, key: tk, count: 0 });
          typeCount.get(tk).count++;
        } else defects++;
      }
      for (const t of (s.defectTypes || [])) {
        defects++;
        const tk = String(t.code || t.name || "").toUpperCase();
        if (!typeCount.has(tk)) typeCount.set(tk, { label: t.name || t.code, key: tk, count: 0 });
        typeCount.get(tk).count++;
      }
    }
    const share = (n) => pct(n, defects || 1);

    addSheet(wb, "ORDER SUMMARY", [
      { key: "figure", header: "FIGURE", width: 30 }, { key: "value", header: "VALUE", width: 16 }, { key: "meaning", header: "WHAT IT MEANS", width: 92 },
    ], [
      { figure: "Order", value: orderLabel, meaning: "The manufacturing order this report covers." },
      { figure: "Customer", value: mo?.customerInfo?.name || "—", meaning: "" },
      { figure: "Work orders", value: workOrders.length, meaning: "Work orders under this order that are not cancelled." },
      { figure: "Garments ordered", value: ordered, meaning: "Sum of the ordered quantity across those work orders." },
      { figure: "Garments inspected", value: inspected, meaning: "Distinct garments QC has looked at at least once." },
      { figure: "QC coverage %", value: pct(inspected, ordered), meaning: "Garments inspected ÷ garments ordered × 100. How much of the order QC has seen — not how much passed." },
      { figure: "Inspections recorded", value: scans.length, meaning: "Scan events. One garment inspected three times is three of these." },
      { figure: "Defects recorded", value: defects, meaning: "Individual faults. One garment with three faults contributes three." },
      { figure: "Garments passed", value: inspected - failed, meaning: "Never failed at any checkpoint." },
      { figure: "Garments failed", value: failed, meaning: "Failed at least once. Counted once however many times." },
      { figure: "Garments rejected", value: rejected, meaning: "Scrapped outright — will not ship." },
      { figure: "DHU %", value: pct(defects, inspected), meaning: "Defects ÷ garments inspected × 100. Counts DEFECTS, so it can exceed 100%." },
      { figure: "Defect rate %", value: pct(failed, inspected), meaning: "Garments failed ÷ garments inspected × 100. Counts GARMENTS, so it cannot exceed 100%." },
      { figure: "Rework rate %", value: pct(failed - rejected, inspected), meaning: "Garments sent back to be fixed ÷ garments inspected × 100." },
      { figure: "RFT %", value: pct(inspected - failed, inspected), meaning: "Right First Time — passed with no failure on record ÷ garments inspected × 100." },
      { figure: "Reject rate %", value: pct(rejected, inspected), meaning: "Garments scrapped ÷ garments inspected × 100." },
    ], `QC REPORT — ${orderLabel}. Generated ${istDateString()}. Every figure is computed from inspection records, never estimated. DHU counts DEFECTS and can exceed 100%; defect rate counts GARMENTS and cannot — they are supposed to differ.`);

    addSheet(wb, "WORK ORDERS", [
      { key: "wo", header: "WORK ORDER", width: 20 }, { key: "product", header: "PRODUCT", width: 34 },
      { key: "ordered", header: "ORDERED", width: 12 }, { key: "inspected", header: "INSPECTED", width: 12 },
      { key: "failed", header: "FAILED", width: 10 }, { key: "rejected", header: "REJECTED", width: 12 },
      { key: "coverage", header: "COVERAGE %", width: 14 }, { key: "defectRate", header: "DEFECT RATE %", width: 16 },
      { key: "status", header: "STATUS", width: 16 },
    ], workOrders.map((wo) => {
      const sid = shortIdOf(wo._id);
      const mine = [...garments.values()].filter((g) => g.shortId === sid);
      const f = mine.filter((g) => g.failed).length;
      return {
        wo: wo.workOrderNumber || `WO-${sid}`, product: wo.stockItemName || "—",
        ordered: wo.quantity || 0, inspected: mine.length, failed: f,
        rejected: mine.filter((g) => g.rejected).length,
        coverage: pct(mine.length, wo.quantity || 0), defectRate: pct(f, mine.length),
        status: (wo.status || "").replace(/_/g, " "),
      };
    }), "One row per work order. COVERAGE is inspected ÷ ordered; DEFECT RATE is failed ÷ inspected, both counted in distinct garments.");

    addSheet(wb, "DEFECT TYPES", [
      { key: "label", header: "DEFECT", width: 36 }, { key: "key", header: "CODE", width: 12 },
      { key: "count", header: "TIMES RECORDED", width: 18 }, { key: "share", header: "SHARE %", width: 12 },
    ], [...typeCount.values()].sort((a, b) => b.count - a.count).map((r) => ({ ...r, share: share(r.count) })),
      "What went wrong, most frequent first. SHARE is this defect ÷ all defects recorded on this order.");

    addSheet(wb, "OPERATIONS", [
      { key: "label", header: "OPERATION", width: 40 }, { key: "key", header: "CODE", width: 14 },
      { key: "count", header: "DEFECTS ATTRIBUTED", width: 20 }, { key: "share", header: "SHARE %", width: 12 },
    ], [...opCount.values()].sort((a, b) => b.count - a.count).map((r) => ({ ...r, share: share(r.count) })),
      "Where in the line the faults were made. An operation names the step, which is what makes operator attribution possible.");

    addSheet(wb, "INSPECTIONS", [
      { key: "date", header: "DATE", width: 12 }, { key: "barcodeId", header: "BARCODE", width: 24 },
      { key: "status", header: "RESULT", width: 12 }, { key: "stageName", header: "CHECKPOINT", width: 26 },
      { key: "by", header: "INSPECTOR", width: 22 }, { key: "round", header: "RE-CHECK #", width: 12 },
      { key: "defectsText", header: "DEFECTS", width: 70 },
    ], scans.map((s) => ({
      date: s.date, barcodeId: s.barcodeId, status: s.status, stageName: s.stageName || "",
      by: s.inspectedByQCName || "", round: s.reworkRound || 0,
      defectsText: [
        ...(s.defects || []).map((d) => `${d.operationCode} ${d.operationName}${(d.types || []).length ? ` [${d.types.map((t) => `${t.code} ${t.name}`).join("; ")}]` : ""}`),
        ...(s.defectTypes || []).map((t) => `${t.code} ${t.name}`),
      ].join(" | "),
    })), "Every inspection recorded against this order, oldest first. One row per scan event — a garment inspected three times appears three times.");

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="qc-order-${orderLabel.replace(/[^\w.-]+/g, "_")}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("[QC order report] error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

const HEAD_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9D9D9" } };

function addSheet(wb, name, columns, rows, note) {
  const ws = wb.addWorksheet(name.slice(0, 31), { pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  if (note) {
    ws.addRow([note]);
    ws.mergeCells(1, 1, 1, Math.max(columns.length, 1));
    const c = ws.getCell(1, 1);
    c.font = { italic: true, size: 9, color: { argb: "FF666666" } };
    c.alignment = { wrapText: true, vertical: "middle" };
    ws.getRow(1).height = 26;
    ws.addRow([]);
  }
  ws.columns = columns.map((col) => ({ width: col.width || 18 }));
  const head = ws.addRow(columns.map((c) => c.header));
  head.eachCell((cell) => {
    cell.font = { bold: true, size: 10 };
    cell.fill = HEAD_FILL;
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  });
  for (const r of rows) ws.addRow(columns.map((c) => r[c.key]));
  ws.views = [{ state: "frozen", ySplit: head.number }];
  return ws;
}

async function writeReportSheets(wb, type, from, to) {
  const snap = await buildSnapshotForRange(from, to);

  const sheets = {
    summary: () => {
      addSheet(wb, "SUMMARY", [
        { header: "FIGURE", width: 30 }, { header: "VALUE", width: 14 }, { header: "WHAT IT MEANS", width: 90 },
      ].map((c, i) => ({ ...c, key: ["figure", "value", "meaning"][i] })), [
        { figure: "Period", value: `${from} → ${to}`, meaning: "The date window this report covers, in IST." },
        { figure: "Garments inspected", value: snap.totals.garmentsInspected, meaning: "Distinct garments QC looked at at least once in the period." },
        { figure: "Inspections recorded", value: snap.totals.scansRecorded, meaning: "Individual scan events. One garment re-inspected three times is three of these." },
        { figure: "Defects recorded", value: snap.totals.defectsRecorded, meaning: "Individual faults. One garment with three faults contributes three." },
        { figure: "Garments passed", value: snap.totals.garmentsPassed, meaning: "Never failed at any checkpoint in this period." },
        { figure: "Garments failed", value: snap.totals.garmentsFailed, meaning: "Failed at least once. Counted once however many times they failed." },
        { figure: "Garments rejected", value: snap.totals.garmentsRejected, meaning: "Scrapped outright — cannot be reworked, will not ship." },
        { figure: "DHU %", value: snap.totals.dhuPercent, meaning: snap.definitions.dhuPercent },
        { figure: "Defect rate %", value: snap.totals.defectRatePercent, meaning: snap.definitions.defectRatePercent },
        { figure: "RFT %", value: snap.totals.rftPercent, meaning: snap.definitions.rftPercent },
        { figure: "Reject rate %", value: snap.totals.rejectRatePercent, meaning: snap.definitions.rejectRatePercent },
      ], `QC SUMMARY — ${from} to ${to}. Every figure below is computed from inspection records, not estimated. DHU counts DEFECTS and can exceed 100%; defect rate counts GARMENTS and cannot.`);
    },
    defects: () => addSheet(wb, "DEFECT TYPES", [
      { key: "label", header: "DEFECT", width: 34 }, { key: "key", header: "CODE", width: 12 },
      { key: "count", header: "TIMES RECORDED", width: 18 }, { key: "share", header: "SHARE OF ALL DEFECTS %", width: 22 },
    ], snap.topDefectTypes, `Which faults occur most, ${from} to ${to}. SHARE is this defect ÷ all defects recorded in the period.`),
    operations: () => addSheet(wb, "OPERATIONS", [
      { key: "label", header: "OPERATION", width: 40 }, { key: "key", header: "CODE", width: 14 },
      { key: "count", header: "DEFECTS ATTRIBUTED", width: 20 }, { key: "share", header: "SHARE %", width: 12 },
    ], snap.topOperations, `Where in the line defects come from, ${from} to ${to}. An operation is where a fault was made, which is what makes operator attribution possible.`),
    inspectors: () => addSheet(wb, "INSPECTORS", [
      { key: "label", header: "INSPECTOR", width: 30 }, { key: "count", header: "SCANS RECORDED", width: 18 },
    ], snap.byInspector, `Inspection volume per person, ${from} to ${to}. This is workload, not performance — a high count is not a good or bad thing on its own.`),
    checkpoints: () => addSheet(wb, "CHECKPOINTS", [
      { key: "label", header: "CHECKPOINT", width: 34 }, { key: "count", header: "SCANS RECORDED", width: 18 },
    ], snap.byCheckpoint, `Volume per checking point, ${from} to ${to}.`),
    orders: () => addSheet(wb, "ORDERS", [
      { key: "order", header: "ORDER", width: 20 }, { key: "customer", header: "CUSTOMER", width: 34 },
      { key: "workOrders", header: "WORK ORDERS", width: 14 }, { key: "ordered", header: "GARMENTS ORDERED", width: 20 },
      { key: "inspected", header: "INSPECTED", width: 14 }, { key: "coverage", header: "QC COVERAGE %", width: 16 },
    ], snap.orders, `QC coverage per order. COVERAGE is garments inspected ÷ garments ordered — how much of the order QC has seen, not how much passed.`),
    daily: () => addSheet(wb, "DAILY", [
      { key: "date", header: "DATE", width: 14 }, { key: "inspected", header: "GARMENTS INSPECTED", width: 20 },
      { key: "failed", header: "GARMENTS FAILED", width: 18 }, { key: "dhu", header: "DEFECT RATE %", width: 16 },
    ], snap.dailyDhu, `Day by day, ${from} to ${to}. DEFECT RATE here is garments failed ÷ garments inspected — the product-wise figure the dashboard's trend chart draws.`),
  };

  if (type === "raw") {
    const rows = await QCInspection.find({ date: { $gte: from, $lte: to } })
      .select("date barcodeId status stageName inspectedByQCName inspectedAt defects defectTypes")
      .sort({ inspectedAt: 1 }).limit(20000).lean();
    addSheet(wb, "RAW INSPECTIONS", [
      { key: "date", header: "DATE", width: 12 }, { key: "barcodeId", header: "BARCODE", width: 24 },
      { key: "status", header: "RESULT", width: 12 }, { key: "stageName", header: "CHECKPOINT", width: 26 },
      { key: "by", header: "INSPECTOR", width: 22 }, { key: "defects", header: "DEFECTS", width: 70 },
    ], rows.map((r) => ({
      date: r.date, barcodeId: r.barcodeId, status: r.status, stageName: r.stageName || "",
      by: r.inspectedByQCName || "",
      defects: [
        ...(r.defects || []).map((d) => `${d.operationCode} ${d.operationName}${(d.types || []).length ? ` [${d.types.map((t) => `${t.code} ${t.name}`).join("; ")}]` : ""}`),
        ...(r.defectTypes || []).map((t) => `${t.code} ${t.name}`),
      ].join(" | "),
    })), `Every inspection recorded ${from} to ${to}, one row per scan event (capped at 20,000 rows). A garment inspected three times appears three times.`);
    // The summary rides along so the raw export is still readable on its own.
    sheets.summary();
    return;
  }

  (sheets[type] || sheets.summary)();
  if (type !== "summary") sheets.summary();
}

/** The snapshot, for an explicit date range rather than a trailing window. */
async function buildSnapshotForRange(from, to) {
  const days = Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000) + 1);
  const snap = await buildSnapshot({ days });
  // buildSnapshot anchors on today; when the requested window ends today (the
  // overwhelmingly common case) it already matches. Otherwise recompute the
  // rollups over the exact range.
  if (snap.window.from === from && snap.window.to === to) return snap;
  return buildSnapshotExact(from, to);
}

async function buildSnapshotExact(from, to) {
  const saved = istDateString;
  void saved;
  // Reuse buildSnapshot's shape by temporarily reading the exact range.
  const scans = await QCInspection.find({ date: { $gte: from, $lte: to } })
    .select("barcodeId date status defects defectTypes stageName inspectedByQCName workOrderShortId").lean();
  const base = await buildSnapshot({ days: 1 }); // definitions + orders shape
  const garments = new Map();
  for (const s of scans) {
    if (!garments.has(s.barcodeId)) garments.set(s.barcodeId, { failed: false, rejected: false, date: s.date });
    const g = garments.get(s.barcodeId);
    if (s.status === "rejected") { g.rejected = true; g.failed = true; }
    else if (s.status === "defective") g.failed = true;
  }
  const inspected = garments.size;
  const failed = [...garments.values()].filter((g) => g.failed).length;
  const rejected = [...garments.values()].filter((g) => g.rejected).length;
  const typeCount = new Map(), opCount = new Map(), stageCount = new Map(), inspectorCount = new Map();
  let defects = 0;
  const bump = (m, k, label) => { if (!k) return; if (!m.has(k)) m.set(k, { key: k, label: label || k, count: 0 }); m.get(k).count++; };
  for (const s of scans) {
    for (const d of (s.defects || [])) {
      bump(opCount, (d.operationCode || "").trim() || "—", d.operationName);
      if ((d.types || []).length) for (const t of d.types) { defects++; bump(typeCount, String(t.code || t.name || "").toUpperCase(), t.name || t.code); }
      else defects++;
    }
    for (const t of (s.defectTypes || [])) { defects++; bump(typeCount, String(t.code || t.name || "").toUpperCase(), t.name || t.code); }
    bump(stageCount, s.stageName || "No checkpoint", s.stageName || "No checkpoint");
    bump(inspectorCount, s.inspectedByQCName || "—", s.inspectedByQCName || "—");
  }
  const dayMap = new Map();
  for (const [, g] of garments) {
    if (!dayMap.has(g.date)) dayMap.set(g.date, { date: g.date, inspected: 0, failed: 0 });
    const r = dayMap.get(g.date); r.inspected++; if (g.failed) r.failed++;
  }
  const top = (m, n = 8) => [...m.values()].sort((a, b) => b.count - a.count).slice(0, n).map((r) => ({ ...r, share: pct(r.count, defects || 1) }));
  return {
    ...base,
    window: { from, to, days: null },
    totals: {
      garmentsInspected: inspected, scansRecorded: scans.length, defectsRecorded: defects,
      garmentsFailed: failed, garmentsRejected: rejected, garmentsPassed: inspected - failed,
      dhuPercent: pct(defects, inspected), defectRatePercent: pct(failed, inspected),
      rftPercent: pct(inspected - failed, inspected), rejectRatePercent: pct(rejected, inspected),
    },
    dailyDhu: [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date)).map((d) => ({ ...d, dhu: pct(d.failed, d.inspected) })),
    topDefectTypes: top(typeCount), topOperations: top(opCount),
    byCheckpoint: top(stageCount, 10), byInspector: top(inspectorCount, 10),
  };
}

module.exports = router;
