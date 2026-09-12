// routes/CMS_Routes/Production/Assistant/productionAssistantRoutes.js
//
// THE PRODUCTION ASSISTANT — ask the factory floor a question in English.
//
// POST /api/cms/production/assistant/query
// Body: { message: string, history?: [{ role:"user"|"assistant", text:string }], date?: "YYYY-MM-DD" }
// GET  /api/cms/production/assistant/suggestions
//
// THE ONE RULE THIS FILE IS BUILT AROUND: THE MODEL NEVER PRODUCES A NUMBER.
//
// A supervisor acts on what this says. "Line 2 did 340 pieces" is a production
// decision, and a plausible wrong figure is worse than no answer at all,
// because it gets acted on and nobody checks. So the model is never asked to
// count, compute, recall or estimate anything. Every figure it is allowed to
// say is computed HERE, by fixed parameterised queries against the same read
// models the supervisor dashboard renders, and handed to it as a FACTS block.
// The model's whole job is to read that block and phrase it in English. If the
// block does not contain the answer, it is instructed to say so and name what
// is missing — which is a real outcome on this floor, because several things a
// supervisor will ask about genuinely are not recorded (see NOT MEASURED).
//
// The same rule governs the UI actions. The model does not choose them and it
// cannot name one: `actions` is built by buildActions() from entities THIS FILE
// resolved out of the message against real documents, then run through
// sanitiseActions() which drops anything outside a fixed whitelist. Nothing the
// model writes reaches the frontend as an instruction. That is deliberately
// stricter than the QC assistant, which parses a [[REPORT:...]] directive out
// of the prose — a report download is harmless, "focus machine X" moving a
// supervisor's floor view is not.
//
// The model also never touches the database. There is no tool-calling, no
// function-calling, no query string it can influence. It receives JSON and
// returns prose.
//
// PIECES ARE DISTINCT GARMENTS, NOT SCANS. A re-scan is the same garment. The
// piece key is `barcodeId|sortedActiveOps` — defined in
// services/barcodeScanner/rollupStats.js:42-49, which is NOT exported, so it is
// restated in pieceKey() below with that file named as the authority. Anything
// derived from raw events here uses it. Scan counts are carried alongside,
// separately named, and the prompt forbids presenting them as output.

"use strict";

const express = require("express");
const router = express.Router();

const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");

const B = "../../../../models/CMS_Models/Manufacturing/Production/Barcode";
const ProductionEvent = require(`${B}/ProductionEvent`);
const MachineDayStats = require(`${B}/MachineDayStats`);
const OperatorDayStats = require(`${B}/OperatorDayStats`);
const DeviceHeartbeat = require(`${B}/DeviceHeartbeat`);
const Machine = require("../../../../models/CMS_Models/Inventory/Configurations/Machine");

const masterData = require("../../../../services/barcodeScanner/masterData");
const productLookup = require("../../../../services/barcodeScanner/productLookup");
const {
  SHIFT_TZ_OFFSET_MIN,
  shiftDateFor,
  currentShiftDate,
  parseBarcode,
} = require("../../../../services/barcodeScanner/shift");

// Authentication for the whole router, stated here rather than inherited from
// the mount — the same reason supervisorFloorRoutes gives. These answers name
// who is on the floor, what they are producing and how fast. Authentication
// only, not a department gate: the supervisor and the project manager both read
// the production surfaces and hold different roles.
router.use(EmployeeAuthMiddleware);

/* ── Gemini configuration ─────────────────────────────────────────────────── */

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

// Same env-overridable ladder as inventoryChatbot.routes.js and
// askAI.routes.js. Deliberately NOT qcAssistantRoutes' hardcoded four-model
// list — three of those names are documented in its sibling files as retired
// and 404 against this project's key.
const MODELS_TO_TRY = (
  process.env.GEMINI_MODELS || "gemini-3.6-flash,gemini-3-flash-preview"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Neither existing assistant passes an abort signal, so a hung upstream holds
// the request open indefinitely — once per model in the ladder. A supervisor
// asking a question on the floor will not wait, and an open socket per
// impatient retry is how a wall-mounted dashboard takes the box down.
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 20000);

// The client sends the conversation back on every turn and nothing upstream
// bounds it: express.json() accepts 50mb, and carryForward() walks the WHOLE
// array three times per request, running the operator resolver — which loops
// every employee in the register — once per entry. A 20k-turn history is then
// synchronous string work proportional to turns x employees, on the one thread
// this Express process has. So the array is cut to what the answer can actually
// use BEFORE anything reads it. 12 is deliberately above callGemini's own
// .slice(-8), so the model's context is unchanged; only the tail that no longer
// influences an answer is dropped.
const MAX_HISTORY_TURNS = Number(process.env.ASSISTANT_MAX_HISTORY_TURNS || 12);

// Matches the per-turn truncation callGemini already applies, so capping here
// changes nothing the model sees — it only stops a single enormous string from
// being regex-scanned by the entity resolvers first.
const MAX_HISTORY_TEXT_CHARS = 4000;

// The FACTS block is stringified into the prompt. QC learned this the hard way:
// a context that grows with the collection eventually blows the window and
// truncates silently, which reads to the user as the assistant forgetting
// things. Every list below is capped; this is the backstop.
const FACTS_CHAR_CAP = Number(process.env.ASSISTANT_FACTS_CHAR_CAP || 60000);

/* ── Small helpers ────────────────────────────────────────────────────────── */

const MINUTE_MS = 60 * 1000;

/** IST-style YYYY-MM-DD for a shift bucket, using the SAME offset shift.js
 *  buckets with — so the key handed to the UI cannot name a different day than
 *  the data behind it. Never toISOString(): that is UTC and disagrees between
 *  00:00 and 05:30 IST. */
function shiftDateKey(shiftDate) {
  const d = new Date(new Date(shiftDate).getTime() + SHIFT_TZ_OFFSET_MIN * MINUTE_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")}`;
}

const round1 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10) / 10);
const isoOrNull = (d) => (d ? new Date(d).toISOString() : null);

/**
 * THE piece key. Verbatim from services/barcodeScanner/rollupStats.js:42-49,
 * which owns the definition but does not export it. A scan with no ticket
 * cannot identify a garment, so it is skipped rather than counted as one.
 */
function pieceKey(ev) {
  if (!ev.barcodeId) return null;
  return `${ev.barcodeId}|${[...(ev.activeOps || [])].sort().join(",")}`;
}

/** Trim a list to n entries and say how many were dropped, rather than
 *  silently truncating — a model handed a cut list will describe it as the
 *  whole floor. */
function capped(rows, n) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length <= n) return { rows: list, shown: list.length, total: list.length, truncated: false };
  return { rows: list.slice(0, n), shown: n, total: list.length, truncated: true };
}

/* ── Garment-industry vocabulary ──────────────────────────────────────────────
 *
 * Two jobs. The regex tables below teach INTENT DETECTION the words a
 * supervisor actually uses, and GLOSSARY travels inside the FACTS block so the
 * model explains a figure from the definition it was given instead of deriving
 * one from the name. QC ships its `definitions` the same way and for the same
 * reason. */

const GLOSSARY = {
  piece:
    "One physical garment at one unit of work. Counted as barcodeId + the sorted set of operations active when it was scanned, so a re-scan of the same ticket is the SAME piece, while the same garment legitimately counts again at a different operation or machine.",
  scan:
    "One barcode-read event. Diagnostic only. A device double-firing raises scans and not production. NEVER present a scan count as output.",
  SAM:
    "Standard Allowed Minutes — the standard time one operation should take on one garment. Held per operation in the Operation registry as durationSeconds, falling back to totalSam minutes. SMV (Standard Minute Value) is the same thing; the floor uses both words.",
  efficiencyPercent:
    "Standard seconds ÷ actual average seconds per piece × 100. Above 100% is FASTER than the standard; below 100% is slower, i.e. the operator is exceeding the allowed time. Null means the operation has no standard in the registry — that is 'not measurable', never 0%.",
  exceedingSAM:
    "Taking longer than the standard allows: efficiencyPercent below 100. The opposite reading (beating the standard) is efficiencyPercent above 100.",
  cycleTimeSeconds:
    "Average measured seconds between consecutive scans of the same operation by the same operator. Gaps longer than the idle threshold (default 180s) are excluded as a stopped machine and counted as idle instead. It is a scan-to-scan gap, not measured work content.",
  productiveMinutes:
    "Minutes inside measured scan-to-scan gaps. Per operator only — there is no machine equivalent on this floor.",
  idleMinutes:
    "Logged-in minutes not accounted for by productive work or a recorded break, plus gaps longer than the idle threshold. Per operator only.",
  breakMinutes: "Minutes inside recorded break_start/break_end events.",
  machineStatus:
    "producing = a scan within the producing window with an operator signed in; idle = operator signed in but no recent scan; on_break = device reports a break or a break is open; no_operator = nobody signed in; device_offline = the scanner has not sent a heartbeat within the stale window.",
  deviceOnlineUnknown:
    "A machine that has NEVER sent a heartbeat is 'unknown', not offline. Do not report it as offline.",
  workOrder:
    "A production order for a quantity of one product. Its barcodes read WO-<8 hex short id>-<unit number>; the short id is the last 8 characters of the work order's id.",
  section:
    "This floor has no section/line entity in the database. The nearest real groupings are the machine's TYPE (e.g. single needle lockstitch) and its LOCATION text on the machine record. Anything labelled section/line below is one of those two and is named as such.",
};

// Intent keywords. Synonyms matter more than precision here — a supervisor
// types "who's on the floor", not "list active operators".
const RX = {
  today: /\b(today|today'?s|so far|this shift|shift total|total production|how (?:much|many).*(?:made|produced|done)|output|production today)\b/i,
  thisHour: /\b(this hour|last hour|past hour|hourly|current hour|in the last 60|per hour)\b/i,
  whoActive:
    /\b(who(?:'?s| is| are)?\s*(?:active|working|on(?: the)? floor|signed in|logged in|running|there)|active operators?|working operators?|current operators?|operators? (?:active|online|working)|manpower|attendance)\b/i,
  fastest:
    /\b(fastest|quickest|best operator|top operator|highest (?:output|producer)|most pieces|leader ?board|ranking|best performer|most productive)\b/i,
  sam: /\b(sam|smv|standard (?:allowed )?(?:minute|time)|exceed(?:ing|ed|s)? (?:the )?(?:sam|smv|standard|target)|over (?:sam|smv|standard|target)|below (?:target|standard)|behind target|efficiency|under ?perform|slow(?:est)? operators?|missing target)\b/i,
  machines:
    /\b(machines?|equipment|stations?|inactive|idle machines?|active machines?|offline|down|not running|stopped|which machines?|device)\b/i,
  inactive:
    /\b(inactive|idle|offline|down|not running|stopped|no operator|unmanned|dead|silent)\b/i,
  section:
    /\b(section|line|department|area|zone|best (?:line|section|area)|which (?:line|section|area)|cutting|stitching|sewing|finishing|\bqc\b|quality|packing|by (?:type|location))\b/i,
  bottleneck:
    /\b(bottle ?neck|blocked|hold(?:ing|up| up)|constraint|slow(?:ing|est)? (?:point|step|stage|down)|where.*(?:stuck|problem|issue|behind)|what'?s wrong|choke|backlog|queue|pile ?d? up|delay)\b/i,
  downtime:
    /\b(down ?time|idle time|break|stoppage|not producing|lost time|waiting|stand ?ing idle)\b/i,
  // "where is" is deliberately NOT a bare alternative here: it made "where is
  // the bottleneck?" read as a piece lookup and the answer came back asking
  // the supervisor for a ticket number.
  piece:
    /\b(piece|garment|barcode|ticket|find piece|trace|journey|history of|track|where is (?:the )?(?:piece|garment|barcode|ticket|unit))\b/i,
  workOrders:
    /\b(work ?orders?|\bwo\b|\bmo\b|manufacturing order|orders?|styles?|products?|customers?)\b/i,
  operatorNamed: /\b(show|find|about|detail|report on|how (?:is|did)|tell me about|open)\b/i,
};

// Follow-up resolution, same mechanism as inventoryChatbot's
// WANTS_MORE_DETAIL_RX: a message with no entity of its own that is clearly
// about the previous one carries the previous entity forward.
const WANTS_MORE_DETAIL_RX =
  /\b(that|this|it|those|them|him|his|her|hers|they|their|theirs|more detail|in detail|full detail|more info|expand|elaborate|explain more|why|details?|again)\b/i;

/* ── Entity extraction ────────────────────────────────────────────────────── */

// WO-359e717d-011, and the looser WO-4471-1 the older labels carry. Matches
// shift.parseBarcode's shape (WO / short id / unit) rather than inventing a
// second barcode grammar.
const BARCODE_RX = /\bWO-[0-9A-Za-z]{3,12}-\d{1,5}\b/gi;

// Case is PRESERVED. The short id is the last 8 characters of the work order's
// _id and is stored lowercase hex on every event (ProductionEvent.workOrderKey
// = "359e7172"), and productLookup matches it with $substrCP on the stringified
// _id, which is lowercase too. Upper-casing the ticket the supervisor typed
// made every piece trace come back empty. De-duplication is case-insensitive so
// "WO-359E7172-1" and "wo-359e7172-1" are not looked up twice.
function extractBarcodes(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text || "").match(BARCODE_RX) || []) {
    const k = raw.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(raw);
  }
  return out;
}

const NAME_STOPWORDS = new Set([
  "show", "find", "about", "detail", "details", "operator", "operators", "machine", "machines",
  "the", "for", "and", "with", "how", "what", "who", "which", "was", "were", "did", "does",
  "today", "now", "this", "that", "give", "tell", "open", "report", "please", "production",
  "pieces", "piece", "output", "made", "doing", "performance", "efficiency", "status", "all",
  "list", "his", "her", "their", "from", "many", "much", "best", "worst", "top", "line",
]);

/** Candidate name tokens: words worth trying against real operator/machine
 *  records. Short tokens are dropped — "is" matching "ISHA" is worse than
 *  missing a match, because the answer then confidently describes the wrong
 *  person. */
function nameTokens(message) {
  return [
    ...new Set(
      (String(message).toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) || []).filter(
        (w) => !NAME_STOPWORDS.has(w)
      )
    ),
  ].slice(0, 8);
}

/**
 * Resolve a person named in the message against REAL records — today's
 * OperatorDayStats first (they are on the floor), then the Employee register
 * via masterData so "show me Rakesh" still resolves for somebody who has not
 * scanned yet. Badge ids are matched too, in both identityId and biometricId
 * form, because the floor's badges carry either (services/barcodeScanner/
 * operators.js documents the GR045 / GR0045 case).
 */
function resolveOperators(message, operatorStats, master) {
  const lower = String(message).toLowerCase();
  const tokens = nameTokens(message);
  const strong = new Map();
  const weak = new Map();

  const consider = (operatorId, operatorName, source) => {
    if (!operatorId) return;
    const name = String(operatorName || "").trim();
    const idL = String(operatorId).toLowerCase();
    const nameL = name.toLowerCase();
    const parts = nameL.split(/\s+/).filter((p) => p.length >= 3);
    const row = { operatorId: String(operatorId), operatorName: name || String(operatorId), source };

    // A badge id spelled out in the message is an exact identification.
    if (idL.length >= 3 && lower.includes(idL)) {
      strong.set(row.operatorId, { ...row, matchedOn: "badge id" });
      return;
    }
    if (!parts.length) return;

    // The whole name, or the FIRST name. RAKESH BISWAL and PRAMOD BISWAL share
    // a surname, and matching on any single part returned both for "show me
    // RAKESH BISWAL" — which then produced focus actions for the wrong person.
    if (nameL.length >= 3 && lower.includes(nameL)) {
      strong.set(row.operatorId, { ...row, matchedOn: "full name" });
      return;
    }
    if (tokens.includes(parts[0])) {
      strong.set(row.operatorId, { ...row, matchedOn: "first name" });
      return;
    }
    // A surname on its own is a genuine ambiguity, not a match. Kept only as a
    // fallback so "show me Biswal" lists the candidates instead of silently
    // answering about one of them.
    if (parts.slice(1).some((p) => tokens.includes(p))) {
      weak.set(row.operatorId, { ...row, matchedOn: "surname only", ambiguous: true });
    }
  };

  for (const o of operatorStats || []) consider(o.operatorId, o.operatorName, "onFloorToday");
  for (const e of master.operators || []) {
    const name = `${e.firstName || ""} ${e.lastName || ""}`.trim();
    consider(e.identityId, name, "employeeRegister");
    consider(e.biometricId, name, "employeeRegister");
  }

  if (strong.size) return [...strong.values()].slice(0, 5);
  return [...weak.values()].slice(0, 5);
}

/** Resolve a machine named in the message against the Machine register —
 *  name, serial number or type. */
function resolveMachines(message, machines) {
  const lower = String(message).toLowerCase();
  const tokens = nameTokens(message);
  const hits = new Map();

  for (const m of machines || []) {
    const name = String(m.name || "").toLowerCase();
    const serial = String(m.serialNumber || "").toLowerCase();
    const hit =
      (name.length >= 3 && (lower.includes(name) || tokens.some((t) => name.split(/[\s-]+/).includes(t)))) ||
      (serial.length >= 3 && lower.includes(serial));
    if (hit) hits.set(String(m._id), { machineId: String(m._id), machineName: m.name || "", type: m.type || "", location: m.location || "" });
  }
  return [...hits.values()].slice(0, 5);
}

/**
 * The client's `history` reduced to the only thing this file may act on: the
 * last MAX_HISTORY_TURNS turns, role and text, each text truncated. Everything
 * downstream — carryForward's entity resolution and the Gemini contents array —
 * reads THIS array, never req.body.history, so an oversized or malformed
 * history costs a slice instead of a blocked event loop. Unknown keys are
 * dropped rather than passed through: nothing else on a turn is used.
 */
function sanitiseHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .slice(-MAX_HISTORY_TURNS)
    .filter((t) => t && typeof t === "object")
    .map((t) => ({
      role: t.role === "assistant" ? "assistant" : "user",
      text: String(t.text || "").slice(0, MAX_HISTORY_TEXT_CHARS),
    }))
    .filter((t) => t.text);
}

/**
 * Carry the last-mentioned entity forward when the current message has none of
 * its own and is plainly a follow-up ("and his efficiency?"). Walks the history
 * backwards and takes the first turn that named something, exactly like
 * inventoryChatbot.resolveIdsFromHistory.
 *
 * The MAX_HISTORY_TURNS bound is re-applied here rather than trusted from the
 * caller: `extract` is the whole-employee-register resolver, and this is the
 * one loop where an unbounded history turns into unbounded synchronous work.
 */
function carryForward(current, message, history, extract) {
  if (current.length) return current;
  if (!WANTS_MORE_DETAIL_RX.test(message) || !Array.isArray(history) || !history.length) return current;
  const recent = history.slice(-MAX_HISTORY_TURNS);
  for (let i = recent.length - 1; i >= 0; i--) {
    const found = extract(String(recent[i]?.text || "").slice(0, MAX_HISTORY_TEXT_CHARS));
    if (found.length) return found;
  }
  return current;
}

/* ── Loaders — the ONLY queries that run. Fixed shape, parameterised by the
 *    shift date and by entities resolved above. Nothing the model writes
 *    reaches any of these. ──────────────────────────────────────────────── */

/**
 * The floor as the rollup last wrote it: four indexed reads, the same set
 * /supervisor/overview makes. The machine list is driven by the Machine
 * collection with day stats LEFT-JOINED on, so a machine that produced nothing
 * today — exactly what "which machines are inactive" is asking about — is
 * still in the answer.
 */
async function loadFloorDay(shiftDate) {
  const HEARTBEAT_STALE_MS = Number(process.env.HEARTBEAT_STALE_SEC || 180) * 1000;

  const [machines, machineStats, operatorStats, heartbeats, master] = await Promise.all([
    Machine.find({}, { name: 1, serialNumber: 1, type: 1, location: 1, status: 1 })
      .sort({ name: 1 })
      .lean(),
    MachineDayStats.find({ shiftDate }).lean(),
    OperatorDayStats.find({ shiftDate }).sort({ totalPieces: -1 }).lean(),
    DeviceHeartbeat.find({}).lean(),
    masterData.getMasterData(),
  ]);

  const statsByMachine = new Map(machineStats.map((s) => [String(s.machineId), s]));
  const hbByMachine = new Map(heartbeats.filter((h) => h.machineId).map((h) => [String(h.machineId), h]));
  const now = Date.now();

  const rows = machines.map((m) => {
    const key = String(m._id);
    const stats = statsByMachine.get(key) || null;
    const hb = hbByMachine.get(key) || null;
    const age = hb?.lastHeartbeatAt ? now - new Date(hb.lastHeartbeatAt).getTime() : null;

    return {
      machineId: key,
      machineName: m.name || "",
      type: m.type || "",
      location: m.location || "",
      assetStatus: m.status || "",
      status: stats?.status || (age == null ? "no_operator" : age > HEARTBEAT_STALE_MS ? "device_offline" : "no_operator"),
      currentOperatorId: stats?.currentOperatorId || null,
      currentOperatorName: stats?.currentOperatorName || null,
      currentOps: stats?.currentOps || [],
      piecesToday: stats?.totalPieces ?? 0,
      piecesThisHourRollup: stats?.piecesThisHour ?? 0,
      lastScanAt: isoOrNull(stats?.lastScanAt),
      // withEfficiencyCaveat: these rows reach the model through namedMachines,
      // and a machine row inflates for exactly the same reason an operator row
      // does — the machine is where the multi-operation crediting happens.
      byOperation: (stats?.byOperation || []).map((o) =>
        withEfficiencyCaveat({
          operationCode: o.operationCode,
          garmentsAtOperation: o.pieces, // see FACT_NOTES.byOperationGarments
          avgSecondsPerPiece: o.avgSecondsPerPiece,
          samSeconds: o.smvSeconds,
          efficiencyPercent: o.efficiencyPercent,
        })
      ),
      // null = never heard from ("unknown"), not offline. The tri-state is
      // load-bearing; supervisorFloorRoutes:112-119 explains why.
      deviceOnline: age == null ? null : age <= HEARTBEAT_STALE_MS,
      deviceQueueDepth: hb?.queueDepth ?? 0,
      deviceLastSeenAt: isoOrNull(hb?.lastHeartbeatAt),
      hasDayStats: Boolean(stats),
    };
  });

  return { machineRows: rows, machineStats, operatorStats, master, machines };
}

/**
 * Raw scan events for the day. Pulled only when an intent needs sub-rollup
 * precision (this hour, bottleneck, section split) — the rollup regenerates
 * every 60s, so a floor question asked at :59 would otherwise be a minute
 * stale. Projected to the five fields the counting needs.
 */
async function loadDayScans(shiftDate) {
  return ProductionEvent.find(
    { shiftDate, type: "scan" },
    { barcodeId: 1, activeOps: 1, machineId: 1, operatorId: 1, scanTime: 1, workOrderKey: 1, unitNumber: 1, _id: 0 }
  )
    .sort({ scanTime: 1 })
    .lean();
}

/**
 * One piece's route. Queried on {workOrderKey, unitNumber} — the index
 * ProductionEvent already carries and nothing else uses. This reads the EVENT
 * stream rather than the rollup output that /dashboard/find-piece walks, so it
 * is current to the second rather than to the last rollup cycle.
 */
async function loadPieceRoute(barcode, machineNameById, resolveOperatorName) {
  const { workOrderKey, unitNumber } = parseBarcode(barcode);
  if (!workOrderKey || unitNumber == null) {
    return { barcode, recognised: false, reason: "Barcode is not in the WO-<short id>-<unit> form the scanners write." };
  }

  // $in over the case variants rather than a case-insensitive regex: a regex
  // on workOrderKey cannot use the {workOrderKey, unitNumber} index, and that
  // index is the whole reason this trace is cheap enough to run interactively.
  const keyVariants = [...new Set([workOrderKey, workOrderKey.toLowerCase(), workOrderKey.toUpperCase()])];

  const events = await ProductionEvent.find(
    { workOrderKey: { $in: keyVariants }, unitNumber, type: "scan" },
    { machineId: 1, operatorId: 1, operatorName: 1, activeOps: 1, scanTime: 1, shiftDate: 1, barcodeId: 1, _id: 0 }
  )
    .sort({ scanTime: 1 })
    .limit(500)
    .lean();

  // productLookup keys off the lowercase short id specifically.
  const shortId = workOrderKey.toLowerCase();
  const product = await productLookup.resolve([shortId]).catch(() => new Map());
  const wo = product.get(shortId) || null;

  // Collapse by machine at FIRST-VISIT order. The raw list is per scan, so a
  // piece re-scanned on one machine yields two rows for one station — numbering
  // those as separate route steps puts two step badges on one machine.
  const byMachine = new Map();
  for (const ev of events) {
    const key = String(ev.machineId);
    if (!byMachine.has(key)) {
      byMachine.set(key, {
        step: byMachine.size + 1,
        machineId: key,
        machineName: machineNameById.get(key) || "Unknown or deleted machine",
        firstScanAt: isoOrNull(ev.scanTime),
        lastScanAt: isoOrNull(ev.scanTime),
        scansHere: 0,
        operators: new Set(),
        operations: new Set(),
      });
    }
    const row = byMachine.get(key);
    row.lastScanAt = isoOrNull(ev.scanTime);
    row.scansHere++;
    // Resolved from Employee, not taken from the event: ProductionEvent
    // .operatorName is a device HINT and is routinely empty, which is how a
    // badge code ends up on screen where a person's name belongs. The resolver
    // is keyed by identityId AND biometricId — a badge carries either.
    if (ev.operatorId) row.operators.add(resolveOperatorName(ev.operatorId) || ev.operatorName || ev.operatorId);
    for (const op of ev.activeOps || []) row.operations.add(op);
  }

  const route = [...byMachine.values()].map((r) => ({
    ...r,
    operators: [...r.operators],
    operations: [...r.operations],
  }));

  return {
    barcode,
    recognised: true,
    workOrderShortId: shortId,
    unitNumber,
    productName: wo?.productName || null,
    customerName: wo?.customerName || null,
    orderQuantity: wo?.orderQuantity ?? null,
    workOrderStatus: wo?.workOrderStatus || null,
    routeSteps: route,
    stationsVisited: route.length,
    scanEventsRecorded: events.length,
    firstSeenAt: isoOrNull(events[0]?.scanTime),
    lastSeenAt: isoOrNull(events[events.length - 1]?.scanTime),
    note:
      "routeSteps are STATIONS this garment passed through, collapsed by machine at first visit. scanEventsRecorded counts barcode reads and is not production output.",
  };
}

/* ── Derivations. Every one of these is arithmetic over documents already
 *    fetched — no figure below originates anywhere but a query. ─────────── */

function summariseFloor(machineRows, operatorStats) {
  const byStatus = {};
  for (const r of machineRows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;

  const piecesAtStations = machineRows.reduce((n, r) => n + (r.piecesToday || 0), 0);
  const activeOperatorIds = new Set(machineRows.filter((r) => r.currentOperatorId).map((r) => r.currentOperatorId));

  return {
    machinesRegistered: machineRows.length,
    machinesByStatus: byStatus,
    machinesProducing: byStatus.producing || 0,
    machinesIdle: byStatus.idle || 0,
    machinesOnBreak: byStatus.on_break || 0,
    machinesWithNoOperator: byStatus.no_operator || 0,
    machinesDeviceOffline: byStatus.device_offline || 0,
    machinesWithNoActivityToday: machineRows.filter((r) => !r.piecesToday).length,
    piecesAtStationsToday: piecesAtStations,
    operatorsWithRecordedWorkToday: operatorStats.length,
    operatorsSignedInRightNow: activeOperatorIds.size,
    piecesByOperatorTotal: operatorStats.reduce((n, o) => n + (o.totalPieces || 0), 0),
    piecesStuckOnDevices: machineRows.reduce((n, r) => n + (r.deviceQueueDepth || 0), 0),
  };
}

/** Distinct-garment truth from the raw events, using the rollup's own key. */
function countFromScans(scans) {
  const garments = new Set();
  const pieceKeys = new Set();
  for (const ev of scans) {
    if (ev.barcodeId) garments.add(ev.barcodeId);
    const k = pieceKey(ev);
    if (k) pieceKeys.add(k);
  }
  return {
    distinctGarmentsTouched: garments.size,
    pieceOperationsCompleted: pieceKeys.size,
    scanEventsRecorded: scans.length,
  };
}

function hourlyBreakdown(scans) {
  const buckets = new Map();
  for (const ev of scans) {
    const k = pieceKey(ev);
    if (!k) continue;
    const hour = new Date(new Date(ev.scanTime).getTime() + SHIFT_TZ_OFFSET_MIN * MINUTE_MS).getUTCHours();
    if (!buckets.has(hour)) buckets.set(hour, new Set());
    buckets.get(hour).add(k);
  }
  return [...buckets.entries()]
    .map(([hour, set]) => ({ hourIST: hour, pieces: set.size }))
    .sort((a, b) => a.hourIST - b.hourIST);
}

/** Group the floor by the two real groupings a machine record actually has. */
function sectionSplit(machineRows, scans) {
  const piecesByMachine = new Map();
  for (const ev of scans) {
    const k = pieceKey(ev);
    if (!k) continue;
    const id = String(ev.machineId);
    if (!piecesByMachine.has(id)) piecesByMachine.set(id, new Set());
    piecesByMachine.get(id).add(k);
  }

  const group = (field, label) => {
    const g = new Map();
    for (const r of machineRows) {
      const key = String(r[field] || "").trim() || "(not set on the machine record)";
      if (!g.has(key)) g.set(key, { group: key, groupedBy: label, machines: 0, producing: 0, inactive: 0, pieces: 0 });
      const row = g.get(key);
      row.machines++;
      if (r.status === "producing") row.producing++;
      if (r.status === "no_operator" || r.status === "device_offline" || r.status === "idle") row.inactive++;
      row.pieces += piecesByMachine.get(r.machineId)?.size || r.piecesToday || 0;
    }
    return [...g.values()].sort((a, b) => b.pieces - a.pieces);
  };

  return { byMachineType: group("type", "machine type"), byLocation: group("location", "machine location text") };
}

/** Operator league table. Two orderings, because "fastest" and "most output"
 *  are different questions and answering one with the other is how a good
 *  operator gets called slow. */
function operatorTables(operatorStats) {
  // The caveat is attached before the sort, so the row that lands at the top of
  // topByPace — the one most likely to be quoted as "the fastest" — carries the
  // reason it may not be.
  const rows = operatorStats.map((o) => withEfficiencyCaveat({
    operatorId: o.operatorId,
    operatorName: o.operatorName || o.operatorId,
    unresolvedBadge: Boolean(o.unknownOperator),
    piecesToday: o.totalPieces || 0,
    minutesLoggedIn: o.minutesLoggedIn ?? null,
    productiveMinutes: o.productiveMinutes ?? null,
    idleMinutes: o.idleMinutes ?? null,
    breakMinutes: o.breakMinutes ?? null,
    efficiencyPercent: o.overallEfficiencyPercent ?? null,
    piecesPerLoggedInHour:
      o.minutesLoggedIn > 0 ? round1((o.totalPieces || 0) / (o.minutesLoggedIn / 60)) : null,
    machinesWorked: (o.machinesWorked || []).map((m) => ({ machineName: m.machineName, pieces: m.pieces })),
    firstSignIn: isoOrNull(o.firstSignIn),
    lastSignOut: isoOrNull(o.lastSignOut),
    stillSignedIn: !o.lastSignOut,
  }));

  const measurable = rows.filter((r) => r.efficiencyPercent != null);

  return {
    byOutput: [...rows].sort((a, b) => b.piecesToday - a.piecesToday),
    byPace: [...measurable].sort((a, b) => b.efficiencyPercent - a.efficiencyPercent),
    withoutMeasurablePace: rows.length - measurable.length,
  };
}

/** Operators running slower than the standard, per operation. "Exceeding SAM"
 *  on this floor means taking longer than allowed — efficiency below 100. */
function samBreaches(operatorStats) {
  const under = [];
  const over = [];
  let opsWithoutStandard = 0;

  for (const o of operatorStats) {
    for (const op of o.byOperation || []) {
      if (op.smvSeconds == null || op.efficiencyPercent == null) {
        opsWithoutStandard++;
        continue;
      }
      // fasterThanStandard is sorted by efficiency DESCENDING, so the rows an
      // inflated figure produces are the first ones the model reads. The caveat
      // has to be on the row itself, not only in the warning list.
      const row = withEfficiencyCaveat({
        operatorId: o.operatorId,
        operatorName: o.operatorName || o.operatorId,
        operationCode: op.operationCode,
        samSeconds: op.smvSeconds,
        actualAvgSecondsPerPiece: op.avgSecondsPerPiece,
        efficiencyPercent: op.efficiencyPercent,
        secondsOverStandard:
          op.avgSecondsPerPiece != null ? round1(op.avgSecondsPerPiece - op.smvSeconds) : null,
        garmentsAtOperation: op.pieces,
      });
      if (op.efficiencyPercent < 100) under.push(row);
      else over.push(row);
    }
  }

  under.sort((a, b) => a.efficiencyPercent - b.efficiencyPercent);
  over.sort((a, b) => b.efficiencyPercent - a.efficiencyPercent);
  return { slowerThanStandard: under, fasterThanStandard: over, operationRowsWithNoStandardSet: opsWithoutStandard };
}

/**
 * Bottleneck SIGNALS — never a verdict.
 *
 * Nothing on this floor records why a machine stopped (ProductionEvent carries
 * breakReason but no read surface exposes it, and there is no machine downtime
 * model at all). So this ranks observable facts and says what each one is. The
 * prompt forbids the model from turning a signal into a cause.
 */
function bottleneckSignals(machineRows, operatorStats, sam) {
  const signals = [];

  const manned = machineRows.filter((r) => r.status === "idle" && r.currentOperatorId);
  if (manned.length) {
    signals.push({
      signal: "Machines with an operator signed in but no recent scan",
      meaning: "Somebody is at the station and nothing has been booked within the producing window. Starved, blocked or stopped — the data does not say which.",
      count: manned.length,
      machines: capped(manned.map((r) => ({ machineName: r.machineName, machineId: r.machineId, operator: r.currentOperatorName, lastScanAt: r.lastScanAt, piecesToday: r.piecesToday })), 8).rows,
    });
  }

  const offline = machineRows.filter((r) => r.status === "device_offline");
  if (offline.length) {
    signals.push({
      signal: "Scanners offline",
      meaning: "The device has stopped sending heartbeats. Work at these stations may be happening and not being recorded.",
      count: offline.length,
      machines: capped(offline.map((r) => ({ machineName: r.machineName, machineId: r.machineId, lastSeenAt: r.deviceLastSeenAt, queuedOnDevice: r.deviceQueueDepth })), 8).rows,
    });
  }

  const queued = machineRows.filter((r) => (r.deviceQueueDepth || 0) > 0);
  if (queued.length) {
    signals.push({
      signal: "Pieces recorded on a device but not yet delivered to the database",
      meaning: "Real production already scanned that today's totals do not include yet.",
      count: queued.reduce((n, r) => n + r.deviceQueueDepth, 0),
      machines: capped(queued.map((r) => ({ machineName: r.machineName, machineId: r.machineId, queued: r.deviceQueueDepth })), 8).rows,
    });
  }

  // Slowest operations weighted by how much work went through them: one
  // operator 20% off standard on 200 pieces moves the floor, one on 3 does not.
  const byOp = new Map();
  for (const row of sam.slowerThanStandard) {
    if (!byOp.has(row.operationCode)) {
      byOp.set(row.operationCode, { operationCode: row.operationCode, samSeconds: row.samSeconds, garmentsAtOperation: 0, weightedEff: 0, operators: 0 });
    }
    const agg = byOp.get(row.operationCode);
    agg.garmentsAtOperation += row.garmentsAtOperation || 0;
    agg.weightedEff += (row.efficiencyPercent || 0) * (row.garmentsAtOperation || 0);
    agg.operators++;
  }
  const slowOps = [...byOp.values()]
    .map((a) =>
      withEfficiencyCaveat(
        { ...a, weightedEfficiencyPercent: a.garmentsAtOperation ? round1(a.weightedEff / a.garmentsAtOperation) : null, weightedEff: undefined },
        "weightedEfficiencyPercent"
      )
    )
    .filter((a) => a.weightedEfficiencyPercent != null)
    .sort((a, b) => a.weightedEfficiencyPercent - b.weightedEfficiencyPercent)
    .slice(0, 6);

  if (slowOps.length) {
    signals.push({
      signal: "Operations running below their standard time",
      meaning: "Measured scan-to-scan pace is slower than the SAM held in the operation registry, weighted by how much work went through each.",
      count: slowOps.length,
      operations: slowOps,
    });
  }

  const idleOps = operatorStats
    .filter((o) => (o.idleMinutes || 0) >= 30)
    .map((o) => ({ operatorName: o.operatorName || o.operatorId, operatorId: o.operatorId, idleMinutes: o.idleMinutes, productiveMinutes: o.productiveMinutes, breakMinutes: o.breakMinutes, piecesToday: o.totalPieces }))
    .sort((a, b) => b.idleMinutes - a.idleMinutes)
    .slice(0, 8);

  if (idleOps.length) {
    signals.push({
      signal: "Operators with 30+ idle minutes",
      meaning: "Logged-in time not covered by measured work or a recorded break. Includes waiting for work, so it is not automatically the operator's doing.",
      count: idleOps.length,
      operators: idleOps,
    });
  }

  return {
    signals,
    note:
      "These are observations ranked by size, not a diagnosis. No downtime REASON is recorded anywhere on this floor, so nothing here can say WHY a station stopped.",
  };
}

/**
 * Figures that are real but not trustworthy, found by checking the numbers
 * against each other. Computed HERE so the model has a fact to repeat rather
 * than a judgement to make.
 *
 * Both checks fire on live data today:
 *
 * - Efficiency above 150%. The rollup credits every scan to EVERY operation
 *   running on the machine (rollupStats.js:337-341), so an operator on a
 *   two-operation machine books both standards for one pass and the figure
 *   roughly doubles. 150 is the threshold the operator drawer already marks as
 *   implausible (OperatorDetail.js:41), reused here so the assistant and the
 *   drawer cannot disagree about the same person.
 * - Idle minutes exceeding logged-in minutes, which is arithmetically
 *   impossible and means the session spans and the gap totals disagree.
 */
const IMPLAUSIBLE_EFFICIENCY_PERCENT = 150;

/* The old reason — "each scan is credited to every operation, which multiplies
   the figure" — described a defect that has been fixed. Efficiency is now
   earned minutes over on-standard attended minutes, the garment-industry
   definition, so a high figure is no longer an artefact of the formula and must
   not be dismissed as one. It can still be genuinely high (beating the standard
   time) or it can point at a wrong SAM, and those need different responses, so
   the caveat now says what to actually check rather than asserting a cause. */
const EFFICIENCY_INFLATION_REASON =
  "Efficiency is earned minutes (garments x SAM) divided by attended time less breaks, so above 100% means the standard time was genuinely beaten. Sustained figures this high more often mean the operation's SAM in the registry is too generous, or that attendance was under-recorded, than that the work was really that fast.";

/**
 * Bind the implausibility caveat to the OBJECT THAT CARRIES THE FIGURE.
 *
 * dataQualityWarnings sits at the top of FACTS and only covers an operator's
 * OVERALL efficiency. Every PER-OPERATION efficiency travels separately — in
 * standardTime.fasterThanStandard (which is sorted descending, so the inflated
 * rows are the first ones the model reads), in namedOperators[].byOperation and
 * in namedMachines[].byOperation — and a model reading a 698% row ten screens
 * away from a warning list has no reason to connect the two. The operator
 * drawer flags all three of those places (OperatorDetail.js:131-133, 178, 228);
 * the assistant flagged one, so the two could disagree about the same person.
 *
 * So the caveat rides in the same object as the number: there is no way to read
 * the figure without reading why it does not hold up. Plausible figures are
 * returned untouched — a normal row stays a plain row, which keeps the flag
 * meaningful.
 */
function withEfficiencyCaveat(row, field = "efficiencyPercent") {
  const value = row ? row[field] : null;
  if (value == null || !Number.isFinite(value) || value <= IMPLAUSIBLE_EFFICIENCY_PERCENT) return row;
  return {
    ...row,
    [`${field}Unreliable`]: true,
    [`${field}Caveat`]:
      `${value}% is above the ${IMPLAUSIBLE_EFFICIENCY_PERCENT}% plausibility threshold. ${EFFICIENCY_INFLATION_REASON} ` +
      "State that caveat in the same sentence as the figure, and do not rank, praise or criticise anyone on it.",
  };
}

function dataQualityWarnings(operatorStats) {
  const out = [];
  for (const o of operatorStats) {
    const who = o.operatorName || o.operatorId;

    // Per-operation rows are the ones that actually reach the model in
    // standardTime.fasterThanStandard. Aggregated to one entry per operator so
    // a machine running four operations cannot flood the capped warning list
    // and push the idle-minutes warnings out of it.
    const flaggedOps = (o.byOperation || []).filter(
      (op) => op.efficiencyPercent != null && op.efficiencyPercent > IMPLAUSIBLE_EFFICIENCY_PERCENT
    );
    if (flaggedOps.length) {
      out.push({
        about: "efficiencyPercent",
        scope: "per operation",
        operatorName: who,
        operatorId: o.operatorId,
        // Flagged here too. The invariant is worth keeping absolute: there is
        // no efficiency figure anywhere in FACTS, this list included, that is
        // over the threshold and not marked as such. The entry's own `warning`
        // is the caveat for all of them, so it is not repeated per row.
        operations: flaggedOps.map((op) => ({
          operationCode: op.operationCode,
          efficiencyPercent: op.efficiencyPercent,
          efficiencyPercentUnreliable: true,
        })),
        warning:
          `These per-operation efficiency figures for ${who} are above the ${IMPLAUSIBLE_EFFICIENCY_PERCENT}% plausibility threshold. ${EFFICIENCY_INFLATION_REASON} Quote them only with that caveat, and never as evidence that this person is fast.`,
      });
    }

    if (o.overallEfficiencyPercent != null && o.overallEfficiencyPercent > IMPLAUSIBLE_EFFICIENCY_PERCENT) {
      out.push({
        about: "efficiencyPercent",
        scope: "overall",
        operatorName: who,
        operatorId: o.operatorId,
        value: o.overallEfficiencyPercent,
        warning:
          `Efficiency of ${o.overallEfficiencyPercent}% is above the ${IMPLAUSIBLE_EFFICIENCY_PERCENT}% plausibility threshold. ${EFFICIENCY_INFLATION_REASON} Quote it only with that caveat; do not call this person the fastest on the strength of it.`,
        operationsCredited: (o.byOperation || []).length,
      });
    }
    if (o.idleMinutes != null && o.minutesLoggedIn != null && o.idleMinutes > o.minutesLoggedIn) {
      out.push({
        about: "idleMinutes",
        operatorName: who,
        operatorId: o.operatorId,
        value: o.idleMinutes,
        warning: `Idle minutes (${o.idleMinutes}) exceed minutes logged in (${o.minutesLoggedIn}), which cannot be true. Report it as unreliable rather than as a downtime figure.`,
      });
    }
  }
  return out;
}

/* ── The FACTS block ──────────────────────────────────────────────────────── */

const FACT_NOTES = {
  piecesAtStationsToday:
    "Sum of each machine's distinct-piece total. A garment legitimately counts once at every station it passes, so this is units of work completed across the floor, not the number of garments that exist.",
  distinctGarmentsTouched:
    "Distinct barcode tickets seen today — how many individual garments the floor handled at least once.",
  pieceOperationsCompleted:
    "Distinct barcode + operation-set combinations — the same definition the rollup counts production with.",
  scanEventsRecorded: "Raw barcode reads. Diagnostic only. Never production output.",
  byOperationGarments:
    "Per-operation rows count DISTINCT GARMENTS that received that operation, deduplicated by barcode across the whole shift. A garment that passed a machine carrying two operations is counted once under EACH of them, because one pass really did complete both. So these are real garment counts, but they are per-operation and MUST NOT be added together into a production total — that double-counts. The machine's and operator's totalPieces are the production figures.",
  piecesThisHourRollup:
    "PER MACHINE ONLY: the rollup's own trailing-hour distinct-piece count for that one machine, refreshed every 60 seconds. It is counted within the machine, so a garment worked on two machines inside the hour counts once on each. Never add these together — the sum is not a floor total and will not agree with lastSixtyMinutes, which counts distinct pieces once across the whole floor.",
  efficiencyPercentUnreliable:
    "A figure flagged with <field>Unreliable: true has the reason beside it — a <field>Caveat sentence on the same object, or the `warning` on its dataQualityWarnings entry. It is a real recorded number that does not hold up. Never state it without that reason, and never rank, praise or criticise anybody on it.",
  hourlyForShiftDate:
    "Pieces per IST hour for the shift date in FACTS.shiftDate, which is not necessarily today.",
};

async function gatherContext(message, history, shiftDate) {
  const lower = String(message).toLowerCase();
  const key = shiftDateKey(shiftDate);

  const { machineRows, operatorStats, master, machines } = await loadFloorDay(shiftDate);
  const machineNameById = new Map(machines.map((m) => [String(m._id), m.name || ""]));

  // Entities, resolved against real documents and carried forward on follow-ups.
  const barcodes = carryForward(extractBarcodes(message), message, history, extractBarcodes);
  const operatorHits = carryForward(
    resolveOperators(message, operatorStats, master),
    message,
    history,
    (t) => resolveOperators(t, operatorStats, master)
  );
  const machineHits = carryForward(
    resolveMachines(message, machines),
    message,
    history,
    (t) => resolveMachines(t, machines)
  );

  const want = {
    today: RX.today.test(lower),
    thisHour: RX.thisHour.test(lower),
    whoActive: RX.whoActive.test(lower),
    fastest: RX.fastest.test(lower),
    sam: RX.sam.test(lower),
    machines: RX.machines.test(lower),
    inactive: RX.inactive.test(lower),
    section: RX.section.test(lower),
    bottleneck: RX.bottleneck.test(lower),
    downtime: RX.downtime.test(lower),
    piece: barcodes.length > 0 || RX.piece.test(lower),
    operator: operatorHits.length > 0,
    machineNamed: machineHits.length > 0,
  };

  // Raw events cost a full-day read, so they are pulled only for the intents
  // that genuinely need sub-rollup precision. A greeting pays for the four
  // indexed read-model finds and nothing else.
  const needsScans = want.today || want.thisHour || want.section;

  const facts = {
    generatedAt: new Date().toISOString(),
    shiftDate: key,
    isToday: key === shiftDateKey(currentShiftDate()),
    masterDataSource: master.source,
    glossary: GLOSSARY,
    fieldNotes: FACT_NOTES,
    floor: summariseFloor(machineRows, operatorStats),
  };

  // Machine status and every "right now" count in floor come from a rollup that
  // stopped changing when the shift ended. On a past date they describe that
  // day's last recorded state, not the floor at this moment, and nothing in the
  // figures themselves says so.
  if (!facts.isToday) {
    facts.floor.stateNote =
      `This is the finished shift of ${key}, not the floor right now. Machine statuses, "producing" and "signed in right now" counts are that shift's last recorded state — report them in the past tense and never as what is happening at this moment.`;
  }

  const warnings = dataQualityWarnings(operatorStats);
  if (warnings.length) facts.dataQualityWarnings = capped(warnings, 10);

  let scans = null;
  if (needsScans) {
    scans = await loadDayScans(shiftDate);
    facts.productionToday = {
      ...countFromScans(scans),
      piecesAtStationsToday: facts.floor.piecesAtStationsToday,
      firstScanAt: isoOrNull(scans[0]?.scanTime),
      lastScanAt: isoOrNull(scans[scans.length - 1]?.scanTime),
    };
  }

  if (want.thisHour && scans) {
    // A trailing-hour window only exists for the day in progress. Computed from
    // wall-clock now against a PAST shift's events it filters everything out
    // and reports 0 pieces for an hour that is not part of the queried day at
    // all — and a zero next to a real date reads as "the floor made nothing".
    // So for a finished shift the window is omitted and named as absent, and
    // the hour-by-hour breakdown of that shift answers the question instead.
    if (facts.isToday) {
      const since = Date.now() - 60 * MINUTE_MS;
      const recent = scans.filter((ev) => new Date(ev.scanTime).getTime() >= since);
      facts.lastSixtyMinutes = {
        window: { fromISO: new Date(since).toISOString(), toISO: new Date().toISOString() },
        // Floor-wide distinct counts: one Set across every machine, so a
        // garment worked at two stations inside the hour counts once.
        ...countFromScans(recent),
        // The rollup's per-machine trailing-hour figures used to be SUMMED here
        // and placed beside pieceOperationsCompleted. They are distinct counts
        // taken WITHIN each machine (rollupStats.js:460), so the sum
        // double-counts any garment that passed two machines in the hour — two
        // numbers on two different counting bases, under similar names, with a
        // note that blamed the gap on refresh lag. The weaker one is gone;
        // byMachine below is the same breakdown on this block's own basis.
        countingBasis:
          "Distinct pieces counted once across the whole floor for this window, from raw scan events. byMachine splits the SAME window per machine, so a garment worked at two stations appears under both and the rows add up to more than the floor figure.",
        byMachine: capped(
          [...recent.reduce((map, ev) => {
            const id = String(ev.machineId);
            if (!map.has(id)) map.set(id, new Set());
            const k = pieceKey(ev);
            if (k) map.get(id).add(k);
            return map;
          }, new Map())]
            .map(([id, set]) => ({ machineId: id, machineName: machineNameById.get(id) || "", pieces: set.size }))
            .sort((a, b) => b.pieces - a.pieces),
          10
        ),
      };
    } else {
      facts.lastSixtyMinutesNote =
        `There is no "last 60 minutes" for ${key}: that shift is over, and the last hour of the clock belongs to a different day. ` +
        "Say that the question is about a finished shift and answer from the hour-by-hour breakdown instead. Do not report a zero for the last hour.";
    }
    facts.hourlyForShiftDate = hourlyBreakdown(scans);
  }

  if (want.whoActive || want.fastest || want.today) {
    const tables = operatorTables(operatorStats);
    facts.operators = {
      signedInRightNow: capped(
        machineRows
          .filter((r) => r.currentOperatorId)
          .map((r) => ({
            operatorId: r.currentOperatorId,
            operatorName: r.currentOperatorName || r.currentOperatorId,
            machineName: r.machineName,
            machineId: r.machineId,
            machineStatus: r.status,
            runningOperations: r.currentOps,
            lastScanAt: r.lastScanAt,
          })),
        20
      ),
      topByOutput: capped(tables.byOutput, 10),
      topByPace: capped(tables.byPace, 10),
      operatorsWithNoMeasurablePace: tables.withoutMeasurablePace,
      paceNote:
        "topByOutput ranks by distinct garments produced. topByPace ranks by efficiency against the operation standard. They answer different questions and will not agree.",
    };
  }

  if (want.sam || want.fastest || want.bottleneck) {
    const sam = samBreaches(operatorStats);
    facts.standardTime = {
      slowerThanStandard: capped(sam.slowerThanStandard, 15),
      fasterThanStandard: capped(sam.fasterThanStandard, 10),
      operationRowsWithNoStandardSet: sam.operationRowsWithNoStandardSet,
      note:
        "Efficiency is standard ÷ actual × 100. Below 100 means the operation is taking longer than its SAM allows. Rows where the operation has no standard in the registry are excluded, not scored as zero.",
    };
  }

  if (want.machines || want.inactive || want.machineNamed || want.bottleneck) {
    const inactive = machineRows.filter(
      (r) => r.status === "no_operator" || r.status === "device_offline" || r.status === "idle"
    );
    facts.machines = {
      producing: capped(
        machineRows
          .filter((r) => r.status === "producing")
          .map((r) => ({ machineId: r.machineId, machineName: r.machineName, type: r.type, location: r.location, operator: r.currentOperatorName, piecesToday: r.piecesToday, runningOperations: r.currentOps, lastScanAt: r.lastScanAt })),
        15
      ),
      inactive: capped(
        inactive.map((r) => ({ machineId: r.machineId, machineName: r.machineName, type: r.type, location: r.location, status: r.status, piecesToday: r.piecesToday, lastScanAt: r.lastScanAt, deviceOnline: r.deviceOnline, deviceLastSeenAt: r.deviceLastSeenAt })),
        20
      ),
      neverReportedADevice: machineRows.filter((r) => r.deviceOnline === null).length,
      statusNote: GLOSSARY.machineStatus,
    };
  }

  if (want.machineNamed) {
    facts.namedMachines = machineHits
      .map((h) => machineRows.find((r) => r.machineId === h.machineId))
      .filter(Boolean)
      .slice(0, 5);
  }

  if (want.operator) {
    const hitById = new Map(operatorHits.map((h) => [String(h.operatorId), h]));
    const detail = operatorStats
      .filter((o) => hitById.has(String(o.operatorId)))
      .map((o) => withEfficiencyCaveat({
        operatorId: o.operatorId,
        operatorName: o.operatorName || o.operatorId,
        matchedOn: hitById.get(String(o.operatorId))?.matchedOn || null,
        ambiguous: Boolean(hitById.get(String(o.operatorId))?.ambiguous),
        unresolvedBadge: Boolean(o.unknownOperator),
        piecesToday: o.totalPieces || 0,
        minutesLoggedIn: o.minutesLoggedIn,
        productiveMinutes: o.productiveMinutes,
        idleMinutes: o.idleMinutes,
        breakMinutes: o.breakMinutes,
        efficiencyPercent: o.overallEfficiencyPercent,
        firstSignIn: isoOrNull(o.firstSignIn),
        lastSignOut: isoOrNull(o.lastSignOut),
        stillSignedIn: !o.lastSignOut,
        machinesWorked: (o.machinesWorked || []).map((m) => ({ machineName: m.machineName, pieces: m.pieces })),
        byOperation: (o.byOperation || []).map((op) =>
          withEfficiencyCaveat({
            operationCode: op.operationCode,
            garmentsAtOperation: op.pieces,
            avgSecondsPerPiece: op.avgSecondsPerPiece,
            samSeconds: op.smvSeconds,
            efficiencyPercent: op.efficiencyPercent,
          })
        ),
      }));

    facts.namedOperators = {
      matched: detail,
      // Somebody named in the message who has no record today is a real answer
      // ("he has not scanned anything"), not a failed lookup.
      matchedButNoRecordToday: operatorHits
        .filter((h) => !detail.some((d) => String(d.operatorId) === String(h.operatorId)))
        .map((h) => ({ operatorId: h.operatorId, operatorName: h.operatorName, source: h.source })),
      // Surnames repeat on this floor. When the name given could be more than
      // one person, list them and ask which — never answer about one of them.
      ambiguousName: operatorHits.some((h) => h.ambiguous) && operatorHits.length > 1,
      note:
        "matchedOn says how the name was resolved. If ambiguousName is true the supervisor gave a name that fits more than one person — list the candidates and ask which they meant instead of reporting on one.",
    };
  }

  if (want.section && scans) {
    const split = sectionSplit(machineRows, scans);
    facts.groupings = {
      byMachineType: capped(split.byMachineType, 12),
      byLocation: capped(split.byLocation, 12),
      note: GLOSSARY.section,
    };
  }

  if (want.bottleneck) {
    facts.bottleneck = bottleneckSignals(machineRows, operatorStats, samBreaches(operatorStats));
  }

  if (want.downtime) {
    // The ONLY stated reason a station stopped that exists anywhere on this
    // floor. The devices send breakReason on break_start and it is stored, but
    // no endpoint has ever returned it — /overview-summary reads only
    // breakDurationSec and the operator timeline omits it entirely. So a
    // supervisor asking "why did the line stop" has had no answer until now.
    // Still not machine downtime: it is an operator break with a reason on it.
    const breaks = await ProductionEvent.find(
      { shiftDate, type: "break_start" },
      { operatorId: 1, operatorName: 1, machineId: 1, breakReason: 1, breakDurationSec: 1, scanTime: 1, _id: 0 }
    )
      .sort({ scanTime: 1 })
      .limit(200)
      .lean();

    const resolveName = masterData.operatorNameResolver(master);
    const byReason = new Map();
    for (const b of breaks) {
      const reason = (b.breakReason || "").trim() || "(no reason given by the device)";
      if (!byReason.has(reason)) byReason.set(reason, { reason, times: 0, totalSeconds: 0 });
      const row = byReason.get(reason);
      row.times++;
      row.totalSeconds += b.breakDurationSec || 0;
    }

    facts.recordedBreaks = {
      totalBreaksStarted: breaks.length,
      byReason: [...byReason.values()].sort((a, b) => b.times - a.times).slice(0, 10),
      recent: capped(
        breaks
          .slice(-10)
          .reverse()
          .map((b) => ({
            operatorName: resolveName(b.operatorId) || b.operatorName || b.operatorId,
            machineName: machineNameById.get(String(b.machineId)) || "",
            reason: (b.breakReason || "").trim() || null,
            durationSeconds: b.breakDurationSec ?? null,
            startedAt: isoOrNull(b.scanTime),
          })),
        10
      ),
      note:
        "Operator breaks with the reason the device recorded. This is the only stated stop reason on this floor; it does not cover a machine that stopped without anyone starting a break.",
    };

    facts.timeUse = {
      perOperator: capped(
        operatorStats
          .map((o) => ({
            operatorId: o.operatorId,
            operatorName: o.operatorName || o.operatorId,
            minutesLoggedIn: o.minutesLoggedIn,
            productiveMinutes: o.productiveMinutes,
            idleMinutes: o.idleMinutes,
            breakMinutes: o.breakMinutes,
          }))
          .sort((a, b) => (b.idleMinutes || 0) - (a.idleMinutes || 0)),
        15
      ),
      machineDowntime: null,
      note:
        "Idle/productive/break minutes exist PER OPERATOR only. There is no machine downtime figure on this floor — say so rather than deriving one from operator time. Stated stop reasons, where a device recorded one, are in recordedBreaks.",
    };
  }

  if (barcodes.length) {
    const resolveOperatorName = masterData.operatorNameResolver(master);
    facts.pieces = [];
    for (const bc of barcodes.slice(0, 3)) {
      facts.pieces.push(await loadPieceRoute(bc, machineNameById, resolveOperatorName));
    }
  } else if (
    want.piece &&
    // Only when tracing a garment is what was actually asked. A question that
    // also asks about the floor gets the floor answer, not a request for a
    // ticket number it never mentioned.
    !(want.today || want.thisHour || want.whoActive || want.fastest || want.sam || want.bottleneck || want.section)
  ) {
    facts.pieceLookupNote =
      "The question is about a specific garment but no barcode of the form WO-<short id>-<unit> was given. Ask for the ticket number.";
  }

  return { facts, want, entities: { barcodes, operatorHits, machineHits }, machineRows, operatorStats, shiftKey: key };
}

/* ── Actions — a fixed whitelist, built here, never by the model ──────────── */

const ACTION_TYPES = new Set([
  "focusOperator",
  "focusMachine",
  "highlightPiece",
  "showBottleneck",
  "showInactiveMachines",
  "openOperatorDetail",
]);

// Exactly which keys each action may carry. Anything else is dropped, so a
// future change here cannot widen what reaches the frontend by accident.
const ACTION_FIELDS = {
  focusOperator: ["operatorId", "operatorName"],
  focusMachine: ["machineId", "machineName"],
  highlightPiece: ["barcode", "machineIds"],
  showBottleneck: ["operationCode", "machineIds"],
  showInactiveMachines: ["machineIds"],
  openOperatorDetail: ["operatorId", "operatorName", "date"],
};

function sanitiseActions(raw) {
  const out = [];
  const seen = new Set();
  for (const a of raw || []) {
    if (!a || !ACTION_TYPES.has(a.type)) continue;
    const action = { type: a.type, label: String(a.label || "").slice(0, 80) };
    for (const f of ACTION_FIELDS[a.type]) {
      if (a[f] === undefined || a[f] === null) continue;
      action[f] = Array.isArray(a[f]) ? a[f].map((v) => String(v)).slice(0, 50) : String(a[f]).slice(0, 120);
    }
    const dedupe = JSON.stringify(action);
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push(action);
    if (out.length >= 6) break;
  }
  return out;
}

function buildActions(ctx) {
  const { facts, want, entities, machineRows, shiftKey } = ctx;
  const actions = [];

  // An ambiguous name must not produce a chip that picks one of the
  // candidates for the supervisor — the answer asks them which they meant.
  if (!facts.namedOperators?.ambiguousName) {
    for (const op of (facts.namedOperators?.matched || []).slice(0, 2)) {
      actions.push({ type: "focusOperator", label: `Show ${op.operatorName} on the floor`, operatorId: op.operatorId, operatorName: op.operatorName });
      actions.push({ type: "openOperatorDetail", label: `${op.operatorName}'s full shift`, operatorId: op.operatorId, operatorName: op.operatorName, date: shiftKey });
    }
  }

  for (const m of (facts.namedMachines || []).slice(0, 2)) {
    actions.push({ type: "focusMachine", label: `Go to ${m.machineName}`, machineId: m.machineId, machineName: m.machineName });
  }

  for (const p of (facts.pieces || []).slice(0, 2)) {
    if (!p.recognised) continue;
    actions.push({
      type: "highlightPiece",
      label: `Trace ${p.barcode} on the floor`,
      barcode: p.barcode,
      machineIds: (p.routeSteps || []).map((s) => s.machineId),
    });
  }

  if (want.bottleneck && facts.bottleneck?.signals?.length) {
    const machineSignal = facts.bottleneck.signals.find((s) => Array.isArray(s.machines) && s.machines.length);
    const opSignal = facts.bottleneck.signals.find((s) => Array.isArray(s.operations) && s.operations.length);
    actions.push({
      type: "showBottleneck",
      label: "Show the slow points on the floor",
      operationCode: opSignal?.operations?.[0]?.operationCode,
      machineIds: (machineSignal?.machines || []).map((m) => m.machineId).filter(Boolean),
    });
  }

  if (want.inactive || want.machines) {
    const ids = machineRows
      .filter((r) => r.status === "no_operator" || r.status === "device_offline" || r.status === "idle")
      .map((r) => r.machineId);
    if (ids.length) {
      actions.push({ type: "showInactiveMachines", label: `Highlight ${ids.length} machines not producing`, machineIds: ids });
    }
  }

  // A single top performer is worth one focus chip; a league table is not.
  if (want.fastest && !entities.operatorHits.length) {
    const best = facts.operators?.topByOutput?.rows?.[0];
    if (best) {
      actions.push({ type: "focusOperator", label: `Show ${best.operatorName} on the floor`, operatorId: best.operatorId, operatorName: best.operatorName });
    }
  }

  return sanitiseActions(actions);
}

/* ── Follow-up chips, built only from what actually matched ───────────────────
 *
 * ONE SHAPE, both endpoints: { id, label, question }, the same objects
 * GET /suggestions serves. The drawer draws `label` on the button and asks
 * `question`, keyed by `id` — so follow-ups returned as bare strings drew a row
 * of blank buttons after the first answer, while the openers rendered fine.
 * Anything added here must keep all three keys. */

function buildSuggestions(ctx) {
  const { facts, want } = ctx;
  const chips = [];
  const push = (id, label, question) => chips.push({ id, label, question });

  for (const op of (facts.namedOperators?.matched || []).slice(0, 2)) {
    push(`op:${op.operatorId}`, `${op.operatorName} vs SAM`, `How is ${op.operatorName} doing against SAM?`);
  }
  for (const m of (facts.namedMachines || []).slice(0, 2)) {
    push(`machine:${m.machineId}`, `${m.machineName} today`, `What has ${m.machineName} produced today?`);
  }
  for (const p of (facts.pieces || []).slice(0, 1)) {
    if (p.recognised) push(`piece:${p.barcode}`, `Trace ${p.barcode}`, `Which machines did ${p.barcode} pass through?`);
  }
  // Only offered on the day in progress: a finished shift has no "last hour",
  // and a chip that leads to "I cannot answer that" is worse than no chip.
  if (want.today && !want.thisHour && facts.isToday) {
    push("hour", "This hour", "How much did we make in the last hour?");
  }
  if (facts.machines?.inactive?.total) {
    push("inactive", "Not producing", "Which machines are not producing right now?");
  }
  if (facts.standardTime?.slowerThanStandard?.total) {
    push("sam", "Behind standard", "Who is running behind standard time?");
  }

  // Top up rather than only falling back: one lonely chip under an answer reads
  // as a broken row. Topped up from the SAME openers GET /suggestions serves,
  // so the two endpoints cannot drift into different wording or different ids.
  for (const s of STATIC_SUGGESTIONS) {
    if (TOP_UP_SUGGESTION_IDS.includes(s.id)) chips.push(s);
  }

  // Dedupe on both id and question: the drawer keys chips by id, and two chips
  // asking the same thing in different words is a wasted row.
  const seen = new Set();
  const out = [];
  for (const c of chips) {
    const q = String(c.question).trim().toLowerCase();
    if (!q || seen.has(q) || seen.has(c.id)) continue;
    seen.add(q);
    seen.add(c.id);
    out.push({ id: c.id, label: c.label, question: c.question });
    if (out.length >= 4) break;
  }
  return out;
}

const STATIC_SUGGESTIONS = [
  { id: "today", label: "Production today", question: "How much have we produced today, and how does the floor look right now?" },
  { id: "hour", label: "This hour", question: "How many pieces have we made in the last hour, and which machines made them?" },
  { id: "active", label: "Who is working", question: "Who is signed in on the floor right now and on which machines?" },
  { id: "fastest", label: "Fastest operator", question: "Who is the fastest operator today and who produced the most pieces?" },
  { id: "sam", label: "Behind on SAM", question: "Which operators are exceeding their SAM and by how much?" },
  { id: "inactive", label: "Inactive machines", question: "Which machines are inactive or offline right now?" },
  { id: "section", label: "Best section", question: "Which machine type and which area of the floor produced the most today?" },
  { id: "bottleneck", label: "Bottleneck", question: "Where is the bottleneck on the floor right now?" },
];

// The four openers that are answerable from any normal shift's records, used to
// top up a short follow-up row. Named here so buildSuggestions cannot re-word
// them into a second, subtly different set of chips.
const TOP_UP_SUGGESTION_IDS = ["today", "active", "inactive", "bottleneck"];

/* ── Prompt ───────────────────────────────────────────────────────────────── */

const SYSTEM_PROMPT = `You are the production assistant for GRAV Clothing, a garment manufacturer. You help a production supervisor read what is happening on their sewing floor right now.

HOW YOU MUST BEHAVE:
- Talk like an experienced floor colleague, not a chatbot. Warm, direct, plain English. No emoji. Never open with "Certainly!" or "Great question!".
- Be short. Two or three tight paragraphs is usually right. Answer first, then the reasoning. Use "- " bullets only for genuine lists.
- You may use light markdown: **bold** for labels and "- " for list lines.
- NEVER present a bare number with no label. "Pieces today: 412", not "412".

THE ABSOLUTE RULE — YOU DO NOT PRODUCE NUMBERS:
- Every figure you are allowed to state is already computed for you in the FACTS block. Copy figures from it exactly.
- NEVER invent, estimate, extrapolate, project, recall or arithmetically derive a number that is not in FACTS. Do not add, average, convert units or work out a percentage yourself. If a figure is not in FACTS, it does not exist for this answer.
- If FACTS cannot answer the question, say plainly what is missing and what would be needed to answer it. That is a correct answer, not a failure. Several things a supervisor asks about genuinely are not recorded on this floor and FACTS will tell you which.
- A null value means "not measurable", never zero and never "none". Say it is not measured.
- If a figure is 0 because nothing happened, say the floor was quiet — do not report 0% as if it were a performance result.
- FACTS.dataQualityWarnings lists figures that are real but do not hold up. If you quote a figure that appears there you MUST say in the same breath that it is not reliable and give the reason from the warning. Never rank, praise or criticise anyone on a figure that is flagged there.
- The same applies WHEREVER a figure sits next to a flag ending in "Unreliable": true and a matching "Caveat" sentence — for example efficiencyPercentUnreliable and efficiencyPercentCaveat on the same row. That figure may never be stated bare. Give the caveat in your own words in the same sentence, and do not call anyone fast, best or top on the strength of it, even when it is the highest figure you were handed.
- FACTS.isToday says whether the day being reported is still running. When it is false the shift is finished: everything you have is a record of that day, so use the past tense and never describe a stored machine status or a "right now" count as the floor at this moment. A trailing-hour window does not exist for a finished shift — FACTS will say so instead of giving you one, and you answer from the hour-by-hour breakdown rather than reporting nothing was made.

GARMENT-FLOOR VOCABULARY:
- FACTS.glossary defines every term and every metric. Explain a figure from that definition rather than from what its name sounds like.
- PIECES ARE DISTINCT GARMENTS. A re-scan is the same garment. Scan counts appear in FACTS under names containing "scan" and must NEVER be described as production, output or pieces made.
- Per-operation rows carry "garmentsAtOperation": distinct garments that received that operation. A garment passing a two-operation machine is counted under both, so these are genuine garment counts but MUST NOT be summed into a production total. Use totalPieces for production.
- "Exceeding SAM" means taking LONGER than the standard allows: efficiency below 100%.
- This floor has no line or section entity. If asked about a line, section or department, answer using the machine-type and machine-location groupings in FACTS and say which one you used.

BOTTLENECKS AND CAUSES:
- FACTS.bottleneck holds observed SIGNALS ranked by size, not causes. Report what is observed and say what it could mean, never assert why a station stopped. No downtime reason is recorded anywhere on this floor.

Never mention FACTS, JSON, prompts or the fact that you were given data. Just answer.`;

function buildPrompt(message, facts, shiftKey) {
  let payload = JSON.stringify(facts);
  if (payload.length > FACTS_CHAR_CAP) {
    // Better a named omission than a silent truncation mid-object, which would
    // hand the model a broken figure and a confident sentence to put it in.
    const trimmed = { ...facts };
    delete trimmed.hourlyForShiftDate;
    delete trimmed.timeUse;
    trimmed.truncationNotice =
      "Some detail sections were omitted because the answer set was too large. Say so if the question needed them.";
    payload = JSON.stringify(trimmed);
  }

  return `FACTS (the only figures you may state — every one already computed from the production records):
${payload}

The production day being reported is ${shiftKey} (IST shift bucket).

SUPERVISOR'S QUESTION: ${message}`;
}

/* ── Gemini call ──────────────────────────────────────────────────────────── */

async function callGemini(apiKey, message, facts, history, shiftKey) {
  const contents = [];
  for (const turn of (history || []).slice(-8)) {
    if (!turn?.text) continue;
    contents.push({
      role: turn.role === "assistant" ? "model" : "user",
      parts: [{ text: String(turn.text).slice(0, 4000) }],
    });
  }
  contents.push({ role: "user", parts: [{ text: buildPrompt(message, facts, shiftKey) }] });

  let lastError = null;
  let authFailed = false;

  for (const model of MODELS_TO_TRY) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
    try {
      const r = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
        method: "POST",
        // Header, not ?key= — the query-string form leaks the key into access
        // logs and proxy history, and both forms are accepted.
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents,
          generationConfig: { temperature: 0.25, maxOutputTokens: 1400 },
        }),
        signal: controller.signal,
      });

      if (!r.ok) {
        // 401/403 is the key, not the model. Walking the rest of the ladder
        // spends more round-trips to reach the identical answer.
        if (r.status === 401 || r.status === 403) {
          authFailed = true;
          break;
        }
        lastError = new Error(`${model}: ${r.status} ${(await r.text()).slice(0, 300)}`);
        continue;
      }

      const j = await r.json();
      const text = j?.candidates?.[0]?.content?.parts
        ?.map((p) => p.text)
        .filter(Boolean)
        .join("")
        .trim();
      if (text) return { text, model };
      lastError = new Error(`${model}: empty response`);
    } catch (e) {
      lastError = e.name === "AbortError" ? new Error(`${model}: timed out after ${GEMINI_TIMEOUT_MS}ms`) : e;
    } finally {
      clearTimeout(timer);
    }
  }

  // A configuration problem should read as one. "Cannot read properties of
  // undefined" in a chat bubble sends somebody debugging the wrong thing.
  if (authFailed) {
    const err = new Error(
      "The production assistant is not connected yet: Google rejected the configured GEMINI_API_KEY. " +
        'It needs a Gemini API key from https://aistudio.google.com/apikey (these start with "AIza"). ' +
        "Everything else on the tracker works without it."
    );
    err.code = "GEMINI_AUTH";
    throw err;
  }
  throw lastError || new Error("Every Gemini model failed.");
}

/* ── Routes ───────────────────────────────────────────────────────────────── */

router.get("/suggestions", (req, res) => {
  res.json({ success: true, suggestions: STATIC_SUGGESTIONS });
});

router.post("/query", async (req, res) => {
  try {
    const { message, history, date } = req.body || {};

    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ success: false, message: "Ask me something about the floor." });
    }
    if (message.trim().length > 400) {
      return res.status(400).json({ success: false, message: "Keep questions under 400 characters." });
    }

    // Bucketed through shift.js, never new Date(x).setHours(0,0,0,0) — the
    // process timezone would silently shift the day by 5h30m off an IST host.
    let shiftDate = currentShiftDate();
    if (date) {
      const parsed = new Date(date);
      if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ success: false, message: "Invalid date." });
      }
      shiftDate = shiftDateFor(parsed);
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(503).json({
        success: false,
        code: "GEMINI_AUTH",
        message: "GEMINI_API_KEY is not set in .env on the server, so the assistant cannot answer yet.",
      });
    }

    // Capped and normalised HERE, once: everything downstream reads this array
    // and never req.body.history, so an oversized history cannot turn into
    // unbounded synchronous work in the entity resolvers.
    const safeHistory = sanitiseHistory(history);
    const ctx = await gatherContext(message.trim(), safeHistory, shiftDate);

    const { text, model } = await callGemini(apiKey, message.trim(), ctx.facts, safeHistory, ctx.shiftKey);

    res.json({
      success: true,
      reply: text,
      suggestions: buildSuggestions(ctx),
      // Built from entities this file resolved against real documents and run
      // through a fixed whitelist. Nothing the model wrote reaches here.
      actions: buildActions(ctx),
      shiftDate: ctx.shiftKey,
      model,
    });
  } catch (error) {
    console.error("[Production Assistant] Error:", error.message);
    // 503, not 500: the floor data is fine, the model is unreachable. The UI
    // shows `message` verbatim, so it has to be a sentence a person can act on.
    res
      .status(error.code === "GEMINI_AUTH" ? 503 : 500)
      .json({ success: false, message: error.message || "Server error while answering the question.", code: error.code || null });
  }
});

module.exports = router;
// Exported for reuse/inspection; the router is the module's default export.
module.exports.ACTION_TYPES = [...ACTION_TYPES];
