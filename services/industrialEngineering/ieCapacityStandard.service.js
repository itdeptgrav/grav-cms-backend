// services/industrialEngineering/ieCapacityStandard.service.js
//
// IE CHUNK 7A — DRAFT CAPACITY STANDARDS AND DETERMINISTIC TARGETS.
//
// A capacity standard says what a balanced line is a standard FOR: so many
// pieces an hour, a shift and a day, from a garment SAM this server derived and
// working-time assumptions somebody stated on the record. It is created against
// ONE exact line layout revision and freezes every source fact it used.
//
// ── EVERY SOURCE FACT IS SERVER-DERIVED ─────────────────────────────────────
// The acting company's layout is resolved from proved membership, and the
// garment SAM, the layout revision, the source fingerprint, the bulletin
// revision and the approval and requirement digests are all read off that
// layout. A client sends planning INPUTS and nothing else. Every derived field
// is refused by name on the way in, so a caller learns the record does not take
// it rather than believing it saved something it did not.
//
// ── THE CALENDAR LINKAGE IS UNKNOWN, AND SAYS SO ────────────────────────────
// The source audit found no safe company-scoped factory working-time source, so
// this chunk cannot cite one. It does not invent one either: the working time is
// an `IE_PLANNING_ASSUMPTION`, `calendarLinkage.state` is `UNKNOWN`, and the
// readiness is `PROVISIONAL` — never `READY` — with a typed gap naming the
// missing upstream contract. That limitation travels with the record.
//
// ── AND A SOURCE THAT MOVES FREEZES THE RECORD, IT DOES NOT REBASE IT ───────
// When the layout's bulletin revision or approved standard moves, this record
// stops being editable and recalculable and reports a typed source-changed
// refusal. Nothing is silently recomputed. A new standard is created against the
// new exact source, and the old one stays as the evidence of what was planned.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const IeCapacityStandard = require("../../models/CMS_Models/IndustrialEngineering/IeCapacityStandard");
const IeLineLayout = require("../../models/CMS_Models/IndustrialEngineering/IeLineLayout");
const IeStyleFile = require("../../models/CMS_Models/IndustrialEngineering/IeStyleFile");
const { fail } = require("../storePurchase/errors");
const { encodeCursor, decodeCursor, pageSize } = require("./ieRead.service");
const layouts = require("./ieLineLayout.service");
const ramps = require("./ieRampProfile.service");
const { calculateCapacity, garmentSamFor } = require("./capacityCalculation");

const { LIMITS, WORKING_TIME_SOURCE } = IeCapacityStandard;

/* ═══ THE ACCEPTED SURFACE ══════════════════════════════════════════════════
 *
 * Planning inputs only. `layoutId` comes from the path on create, so it is not
 * a body field even there.
 */
const INPUT_FIELDS = Object.freeze([
  "availableShiftMinutes", "breakMinutes", "shiftsPerDay",
  "plannedOperatorCount", "plannedHelperCount",
  "targetEfficiencyPercent",
  "effectiveFrom", "effectiveTo",
  "workingTimeSourceKind", "workingTimeNote",
  "note",
  /* Chunk 7B: WHICH ramp stage this standard is planned for, chosen explicitly.
     Both are ids the server resolves and then FREEZES; neither is a percentage
     or a calculated figure, and a caller cannot send the stage's efficiency. */
  "rampProfileId", "rampStageId",
]);
const CREATE_FIELDS = Object.freeze([...INPUT_FIELDS]);
const PATCH_FIELDS = Object.freeze(["expectedRevision", ...INPUT_FIELDS]);

/* Fields somebody will reasonably try to send, refused BY NAME with where the
   fact actually lives. Every derived figure, every frozen source fact and every
   concept the Chunk 7A boundary excludes is here. */
const REFUSED_FIELDS = Object.freeze({
  companyId: "the company — that comes from your own membership, never a body",
  capacityStandardId: "its own id",
  status: "its own status",
  revision: "its own revision — send `expectedRevision` to say which one you read",
  history: "its own audit trail",
  lineLayoutId: "which layout it is for — that is in the address, and it never changes",
  layoutId: "which layout it is for — that is in the address, and it never changes",
  ieStyleFileId: "which engineering file it belongs to, which the server reads from the layout",
  styleFileId: "which engineering file it belongs to, which the server reads from the layout",
  /* ── THE FROZEN SOURCE FACTS ── */
  garmentSamMinutes: "a garment SAM — the server sums the layout's frozen approved standard times",
  samMinutes: "a garment SAM — the server sums the layout's frozen approved standard times",
  standardTimeMinutes: "a standard time — that comes from the approved method study",
  lineLayoutRevision: "a layout revision, which the server freezes at creation",
  layoutRevision: "a layout revision, which the server freezes at creation",
  bulletinRevision: "a bulletin revision, which the server freezes at creation",
  sourceFingerprint: "a layout's source fingerprint, which only the server computes",
  layoutFingerprint: "a layout's source fingerprint, which only the server computes",
  approvalDigest: "an approval digest, which only the server computes",
  requirementDigest: "a requirement digest, which only the server computes",
  sourceRows: "a layout's bound source rows",
  /* ── THE CALCULATED OUTPUT ── */
  netMinutesPerShift: "a calculated figure",
  availableOperatorMinutesPerShift: "a calculated figure",
  targetPiecesPerHour: "a calculated target — the server computes it from the stated inputs",
  theoreticalPiecesPerShift: "a calculated target — the server computes it from the stated inputs",
  theoreticalPiecesPerDay: "a calculated target — the server computes it from the stated inputs",
  wholePieceShiftTarget: "a calculated target — the server computes it from the stated inputs",
  wholePieceDailyTarget: "a calculated target — the server computes it from the stated inputs",
  targetOutput: "a calculated target — the server computes it from the stated inputs",
  capacity: "a calculated figure",
  readiness: "a readiness verdict — the server decides it",
  balanceEfficiencyPercent: "a calculated figure the layout publishes",
  /* ── MACHINES AND ASSETS ── */
  machineId: "a specific machine. A capacity standard plans work content, not a floor allocation",
  machineIds: "specific machines. A capacity standard plans work content, not a floor allocation",
  serialNumber: "a machine serial number, which is an asset record",
  assetId: "an asset id, which is an asset record",
  machineCapacity: "a machine throughput, which nothing here proves",
  machineThroughput: "a machine throughput, which nothing here proves",
  availability: "an availability, which Maintenance and Production own",
  maintenanceStatus: "a maintenance status, which Maintenance owns",
  /* ── PEOPLE ── */
  employeeId: "an employee. This record plans OPERATOR COUNTS, never people",
  employeeName: "an employee. This record plans OPERATOR COUNTS, never people",
  employeeIds: "employees. This record plans OPERATOR COUNTS, never people",
  operatorId: "an operator. This record plans OPERATOR COUNTS, never people",
  operatorIdentityId: "an operator session, which Production owns",
  operators: "named operators. Send `plannedOperatorCount`, which is a count",
  attendance: "attendance, which HR owns",
  attendanceId: "attendance, which HR owns",
  shiftName: "a named shift, which HR's attendance settings own",
  shiftId: "a named shift, which HR's attendance settings own",
  /* ── PRODUCTION ── */
  barcodeId: "a barcode — a printed piece is Production's record",
  scanId: "a scan — Production owns scanning",
  workOrderId: "a work order. Chunk 7A calculates a standard; it books no order",
  productionScheduleId: "a Production schedule — this record books no capacity",
  allocation: "an allocation. Chunk 7A calculates a standard; it allocates nothing",
  booking: "a booking. Chunk 7A calculates a standard; it books nothing",
  bookedQuantity: "a booked quantity. Chunk 7A calculates a standard; it books nothing",
  committedQuantity: "a committed quantity. Chunk 7A promises no delivery",
  deliveryDate: "a delivery date. Chunk 7A calculates a standard; it promises no date",
  /* ── APPROVAL AND RELEASE ── */
  approvedAt: "an approval. Nothing here approves or releases anything",
  approvedBy: "an approval. Nothing here approves or releases anything",
  releasedAt: "a release. Nothing here approves or releases anything",
  releasedBy: "a release. Nothing here approves or releases anything",
  acknowledgedAt: "an acknowledgement, which is a later chunk",
  /* ── THE RAMP'S OWN DERIVED VALUES (Chunk 7B) ── */
  rampProfileRevision: "a ramp profile revision, which the server freezes when the stage is applied",
  rampTargetEfficiencyPercent: "a ramp stage's efficiency — the server reads it from the proved stage",
  rampEfficiencyPercent: "a ramp stage's efficiency — the server reads it from the proved stage",
  rampCalculation: "a calculated ramp target — the server computes it from the frozen stage",
  ramp: "a frozen ramp block, which the server writes. Send `rampProfileId` and `rampStageId`",
  actualEfficiencyPercent: "an achieved efficiency. This record plans; it observes nothing",
  productionDay: "a day of an actual run. A stage is CHOSEN, never inferred from progress",

  /* ── AND THE CALENDAR SHAPE NOTHING PROVES YET ── */
  calendarId: "a working-calendar reference. No authoritative company working-time calendar exists yet, "
    + "so one cannot be cited — state an IE planning assumption instead",
  calendarVersionNo: "a working-calendar version. No authoritative company working-time calendar exists yet",
});

/* ═══ HELPERS ══════════════════════════════════════════════════════════════ */

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v ?? ""));
const oid = (v) => new mongoose.Types.ObjectId(String(v));

const mintEventId = () => `ics_${crypto.randomBytes(9).toString("hex")}`;
const actorName = (actor) => str(actor?.name || actor?.email);
const actorId = (actor) => (isId(actor?.id) ? oid(actor.id) : null);

function assertContext(ctx) {
  if (!ctx?.companyId) {
    throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  }
}

/** One indistinguishable refusal for absent, foreign and malformed alike. */
const standardNotFound = () => fail("IE_CAPACITY_STANDARD_NOT_FOUND", "That capacity standard was not found.");
const layoutNotFound = () => fail("IE_LINE_LAYOUT_NOT_FOUND", "That line layout was not found.");

const gap = (code, action, message, extra = {}) => ({
  code, owner: "INDUSTRIAL_ENGINEERING", action, message, ...extra,
});

const event = (type, { actor, standardRevision, changed = [], summary = "" }) => ({
  eventId: mintEventId(),
  type,
  at: new Date(),
  actorId: actorId(actor),
  actorName: actorName(actor),
  standardRevision,
  changed: [...changed],
  summary: summary.slice(0, LIMITS.SUMMARY),
});

/** Anything not on the allowlist is refused by name, never quietly dropped. */
function refuseUnknown(body, allowed, what) {
  if (body === null || body === undefined) return;
  if (typeof body !== "object" || Array.isArray(body)) {
    throw fail("VALIDATION", `${what} is an object.`, { field: "body" });
  }
  for (const key of Object.keys(body)) {
    if (allowed.includes(key)) continue;
    const refused = REFUSED_FIELDS[key];
    throw fail("FIELD_NOT_ACCEPTED",
      refused ? `A capacity standard cannot carry ${refused}.` : `"${key}" is not part of ${what}.`,
      {
        field: key,
        fieldErrors: [{
          field: key, code: "NOT_ACCEPTED",
          message: refused
            ? `This record does not accept "${key}".`
            : `"${key}" is not part of ${what}.`,
        }],
      });
  }
}

function readExpectedRevision(value) {
  if (value === undefined || value === null || value === "") {
    throw fail("VALIDATION", "Say which revision of this capacity standard you read.", {
      field: "expectedRevision",
      fieldErrors: [{ field: "expectedRevision", code: "REQUIRED", message: "Say which revision of this capacity standard you read." }],
    });
  }
  const expected = Number(value);
  if (!Number.isInteger(expected) || expected < 1) {
    throw fail("VALIDATION", "A revision is a whole number.", {
      field: "expectedRevision",
      fieldErrors: [{ field: "expectedRevision", code: "NOT_AN_INTEGER", message: "A revision is a whole number." }],
    });
  }
  return expected;
}

/* ═══ NUMERIC AND DATE VALIDATION ══════════════════════════════════════════
 *
 * Every refusal a FORM can fix carries `details.fieldErrors` with a `field`, a
 * machine `code` and a sentence — the shape every IE chunk since 2A has used.
 * A missing number is REQUIRED, never defaulted to zero: a shift of zero
 * minutes is a statement, and nobody made it.
 */

const NUMBER_CODES = Object.freeze({
  REQUIRED: "REQUIRED",
  NOT_A_NUMBER: "NOT_A_NUMBER",
  NOT_FINITE: "NOT_FINITE",
  NOT_AN_INTEGER: "NOT_AN_INTEGER",
  TOO_SMALL: "TOO_SMALL",
  TOO_LARGE: "TOO_LARGE",
});

/**
 * One number, or a field error saying exactly what is wrong with it.
 *
 * `Infinity`, `NaN` and `"12abc"` are each refused with their own code rather
 * than being coerced: `Number("12abc")` is NaN and `Number(null)` is 0, and a
 * capacity target computed from a silently-zeroed input is worse than no target.
 */
function readNumber(raw, field, { min, max, integer = false, required = true, errs }) {
  if (raw === undefined || raw === null || raw === "") {
    if (required) {
      errs.push({ field, code: NUMBER_CODES.REQUIRED, message: `${field} is required.` });
    }
    return null;
  }
  if (typeof raw === "boolean" || Array.isArray(raw) || (typeof raw === "object")) {
    errs.push({ field, code: NUMBER_CODES.NOT_A_NUMBER, message: `${field} is a number.` });
    return null;
  }
  const n = Number(raw);
  if (Number.isNaN(n)) {
    errs.push({ field, code: NUMBER_CODES.NOT_A_NUMBER, message: `${field} is a number.` });
    return null;
  }
  if (!Number.isFinite(n)) {
    errs.push({ field, code: NUMBER_CODES.NOT_FINITE, message: `${field} is a finite number.` });
    return null;
  }
  if (integer && !Number.isInteger(n)) {
    errs.push({ field, code: NUMBER_CODES.NOT_AN_INTEGER, message: `${field} is a whole number.` });
    return null;
  }
  if (min !== undefined && n < min) {
    errs.push({ field, code: NUMBER_CODES.TOO_SMALL, message: `${field} is at least ${min}.` });
    return null;
  }
  if (max !== undefined && n > max) {
    errs.push({ field, code: NUMBER_CODES.TOO_LARGE, message: `${field} is at most ${max}.` });
    return null;
  }
  return n;
}

/* An effective date is a CALENDAR DATE: exactly ten characters, `YYYY-MM-DD`. */
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A calendar date, with no time and no zone. `null` is a real answer.
 *
 * ── WHY `new Date(raw)` IS NOT ENOUGH ──────────────────────────────────────
 * It is far too willing. `new Date("2026-02-30")` does not fail: it rolls over
 * to the second of March and returns a perfectly valid Date, so a typo silently
 * becomes a different date and the record shows a day nobody typed.
 * `new Date("2026-10-01T10:30:00Z")` succeeds too, quietly accepting a
 * timestamp — a zone-bearing instant — where a calendar fact was asked for, and
 * near midnight the two disagree about which day it is. Locale strings like
 * "01/10/2026" are worse still: the month and the day are ambiguous, and the
 * engine picks one without saying which.
 *
 * So the shape is fixed first, and then the parse is ROUND-TRIPPED: the three
 * numbers that came out of `Date.UTC` must be the three that went in. February
 * the thirtieth cannot survive that, and neither can month thirteen.
 */
function readDate(raw, field, errs) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") {
    errs.push({ field, code: "NOT_A_DATE", message: `${field} is a calendar date as YYYY-MM-DD.` });
    return null;
  }
  const parts = CALENDAR_DATE.exec(raw);
  if (!parts) {
    /* Timestamps, locale dates and whitespace-decorated alternatives all land
       here. Nothing is trimmed or reinterpreted on the way: a date this record
       did not ask for is refused, not guessed at. */
    errs.push({ field, code: "NOT_A_DATE", message: `${field} is a calendar date as YYYY-MM-DD.` });
    return null;
  }

  const [, y, m, d] = parts;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  const at = new Date(Date.UTC(year, month - 1, day));

  /* The round trip. A rolled-over date comes back as a DIFFERENT day, which is
     precisely how it is caught — 2026-02-30 returns the 2nd of March, and
     2026-04-31 the 1st of May. A leap day that genuinely exists round-trips
     unchanged, so 2028-02-29 passes and 2026-02-29 does not. */
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) {
    errs.push({
      field, code: "IMPOSSIBLE_DATE",
      message: `${field} is not a date that exists — ${raw} is not on the calendar.`,
    });
    return null;
  }
  return at;
}

const text = (raw, field, max, errs) => {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") {
    errs.push({ field, code: "NOT_TEXT", message: `${field} is text.` });
    return "";
  }
  const value = raw.replace(/\s+/g, " ").trim();
  if (value.length > max) {
    errs.push({ field, code: "TOO_LONG", message: `${field} is at most ${max} characters.` });
    return "";
  }
  return value;
};

const badInputs = (errs) => fail("IE_CAPACITY_STANDARD_INPUT_INVALID",
  errs.length === 1 ? errs[0].message : `${errs.length} planning inputs are not usable.`,
  { field: errs[0].field, fieldErrors: errs });

/**
 * Read and normalise the whole planning-input set.
 *
 * On PATCH the CURRENT values are the defaults, so an edit that sends one field
 * keeps the rest — and the no-op comparison below then sees the complete
 * normalised set on both sides rather than a partial body.
 */
function readInputs(body, current = null) {
  const errs = [];
  const at = (field, fallback) => (body[field] === undefined ? fallback : body[field]);

  const availableShiftMinutes = readNumber(
    at("availableShiftMinutes", current?.workingTime?.availableShiftMinutes),
    "availableShiftMinutes", { min: 1, max: LIMITS.SHIFT_MINUTES, errs },
  );
  const breakMinutes = readNumber(
    at("breakMinutes", current?.workingTime?.breakMinutes ?? 0),
    "breakMinutes", { min: 0, max: LIMITS.SHIFT_MINUTES, required: false, errs },
  ) ?? 0;
  const shiftsPerDay = readNumber(
    at("shiftsPerDay", current?.workingTime?.shiftsPerDay ?? 1),
    "shiftsPerDay", { min: 1, max: LIMITS.SHIFTS_PER_DAY, integer: true, required: false, errs },
  ) ?? 1;
  const plannedOperatorCount = readNumber(
    at("plannedOperatorCount", current?.manpower?.plannedOperatorCount),
    "plannedOperatorCount", { min: 1, max: LIMITS.OPERATORS, integer: true, errs },
  );
  const plannedHelperCount = readNumber(
    at("plannedHelperCount", current?.manpower?.plannedHelperCount ?? 0),
    "plannedHelperCount", { min: 0, max: LIMITS.HELPERS, integer: true, required: false, errs },
  ) ?? 0;

  /* ── EFFICIENCY, AS A PERCENTAGE, UNAMBIGUOUSLY ─────────────────────────
     Greater than zero and at most 100. A line planned at 0% has no target, and
     a line planned above 100% would be planned to earn more standard minutes
     than it is attended for. `> 0` is checked separately from `min` so the
     message says which boundary was crossed. */
  const targetEfficiencyPercent = readNumber(
    at("targetEfficiencyPercent", current?.targetEfficiencyPercent),
    "targetEfficiencyPercent", { min: 0, max: 100, errs },
  );
  if (targetEfficiencyPercent === 0) {
    errs.push({
      field: "targetEfficiencyPercent", code: NUMBER_CODES.TOO_SMALL,
      message: "targetEfficiencyPercent is greater than 0 and at most 100.",
    });
  }

  const effectiveFrom = body.effectiveFrom === undefined
    ? (current?.effectiveFrom ?? null)
    : readDate(body.effectiveFrom, "effectiveFrom", errs);
  const effectiveTo = body.effectiveTo === undefined
    ? (current?.effectiveTo ?? null)
    : readDate(body.effectiveTo, "effectiveTo", errs);

  /* ── THE EXPLICIT SOURCE CLASSIFICATION ────────────────────────────────
     Stated, never inferred. `PROVED_CALENDAR_VERSION` is refused for as long as
     nothing can prove one: accepting it would let a record claim an
     authoritative calendar that does not exist, which is the exact fabrication
     this chunk was told not to make. */
  const rawKind = body.workingTimeSourceKind === undefined
    ? (current?.workingTime?.source?.kind ?? WORKING_TIME_SOURCE[0])
    : str(body.workingTimeSourceKind).toUpperCase();
  if (!WORKING_TIME_SOURCE.includes(rawKind)) {
    errs.push({
      field: "workingTimeSourceKind", code: "INVALID",
      message: `workingTimeSourceKind is one of ${WORKING_TIME_SOURCE.join(", ")}.`,
    });
  } else if (rawKind === "PROVED_CALENDAR_VERSION") {
    errs.push({
      field: "workingTimeSourceKind", code: "NO_AUTHORITATIVE_CALENDAR",
      message: "No company-scoped, versioned factory working-time calendar exists to cite yet. "
        + "State IE_PLANNING_ASSUMPTION and explain it in `workingTimeNote`.",
    });
  }

  const workingTimeNote = body.workingTimeNote === undefined
    ? str(current?.workingTime?.source?.note)
    : text(body.workingTimeNote, "workingTimeNote", LIMITS.NOTE, errs);
  const note = body.note === undefined
    ? str(current?.note)
    : text(body.note, "note", LIMITS.NOTE, errs);

  /* ── CONTRADICTIONS, CHECKED ONLY ONCE THE PARTS ARE VALID ─────────────
     Reporting "breaks exceed the shift" alongside "the shift is not a number"
     would be noise. */
  if (!errs.length) {
    if (breakMinutes >= availableShiftMinutes) {
      errs.push({
        field: "breakMinutes", code: "CONTRADICTS_SHIFT",
        message: `Break minutes (${breakMinutes}) leave no productive time in a ${availableShiftMinutes}-minute shift.`,
      });
    }
    if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) {
      errs.push({
        field: "effectiveTo", code: "BEFORE_EFFECTIVE_FROM",
        message: "effectiveTo is on or after effectiveFrom.",
      });
    }
  }

  if (errs.length) throw badInputs(errs);

  return {
    workingTime: {
      availableShiftMinutes, breakMinutes, shiftsPerDay,
      source: {
        kind: rawKind,
        calendarId: null, calendarVersionNo: null, calendarRef: "",
        note: workingTimeNote,
      },
    },
    manpower: { plannedOperatorCount, plannedHelperCount },
    targetEfficiencyPercent,
    effectiveFrom, effectiveTo, note,
  };
}

/* ═══ THE SOURCE, RESOLVED SERVER-SIDE ═════════════════════════════════════ */

/**
 * The acting company's layout, its file and the file's CURRENT source.
 *
 * The file is bound under the same company, so a layout whose file somehow left
 * this company reads as not found rather than as current.
 */
async function loadOwnedLayout(ctx, layoutId) {
  assertContext(ctx);
  if (!isId(layoutId)) throw layoutNotFound();
  const layout = await IeLineLayout.findOne({ _id: oid(layoutId), companyId: ctx.companyId }).lean();
  if (!layout) throw layoutNotFound();
  const file = await IeStyleFile.findOne({ _id: layout.ieStyleFileId, companyId: ctx.companyId })
    .select("_id revision bulletin.rows").lean();
  if (!file) throw layoutNotFound();
  /* ── THE LAYOUT'S OWN SOURCE, NOT THE FILE'S (Chunk 7C2) ────────────────
     A version-backed layout is a balance of its immutable approved bulletin
     version; only a pre-7C1 layout is judged against the file's mutable
     bulletin. Asking the file for both would re-judge a version-backed layout
     against a successor draft it was never balanced against. */
  const current = await layouts.sourceForLayout(ctx, layout, file);
  const { state, reasons } = layouts.sourceStateOf(layout, current);
  return { layout, file, current, sourceState: state, sourceReasons: reasons };
}

/* ═══ WHAT A STANDARD'S FROZEN SOURCE IS NOW ═══════════════════════════════
 *
 * Three states, and the third exists because two of them are not enough.
 *
 *   CURRENT             the exact line configuration this standard froze is
 *                       still the current one, in BOTH senses below.
 *   SOURCE_CHANGED      something moved. The standard is evidence of what was
 *                       planned, not a current standard.
 *   SOURCE_UNAVAILABLE  the source cannot be resolved at all. Not proof that
 *                       nothing moved — proof that nobody can say.
 *
 * ── AND UNKNOWN FAILS CLOSED ───────────────────────────────────────────────
 * `SOURCE_UNAVAILABLE` is never treated as `CURRENT`. Only an explicit
 * `CURRENT` makes a standard editable or lets it read as usable, because a
 * standard whose evidence nobody can find is the LEAST safe one to plan a
 * shipment against, and defaulting it to current would present exactly that as
 * a clean provisional record.
 */
const SOURCE_STATE = Object.freeze({
  CURRENT: "CURRENT",
  SOURCE_CHANGED: "SOURCE_CHANGED",
  SOURCE_UNAVAILABLE: "SOURCE_UNAVAILABLE",
});

/**
 * Why a frozen source is no longer the current one.
 *
 * The first three are the layout's own vocabulary, carried through unchanged.
 * The fourth is this chunk's, and it is the one Chunk 7A needs that the layout
 * does not: a capacity standard is tied to one exact LINE CONFIGURATION, not
 * merely to the bulletin behind it. Rearranging stations, changing a planned
 * machine type, moving an assignment or relabelling a station all move the
 * layout's revision while its bulletin and approved evidence stay put — and
 * every one of them changes the line the target was calculated for.
 */
const SOURCE_REASON = Object.freeze({
  LAYOUT_REVISION: "LINE_LAYOUT_REVISION_CHANGED",
  LAYOUT_UNAVAILABLE: "LINE_LAYOUT_UNAVAILABLE",
  FILE_UNAVAILABLE: "ENGINEERING_FILE_UNAVAILABLE",
});

const sourceChanged = (doc, { layout, reasons, current, currentLineLayoutRevision }) => fail(
  "IE_CAPACITY_STANDARD_SOURCE_CHANGED",
  reasons.includes(SOURCE_REASON.LAYOUT_UNAVAILABLE) || reasons.includes(SOURCE_REASON.FILE_UNAVAILABLE)
    ? "The line layout behind this capacity standard cannot be resolved, so there is nothing to prove "
      + "the target against. The standard stays as evidence of what was planned."
    : "The exact line configuration behind this capacity standard has since changed. The standard stays "
      + "as evidence of what was planned — open a layout for the current source and create a new "
      + "capacity standard there.",
  {
    reasons,
    lineLayoutId: String(doc.lineLayoutId ?? layout?._id ?? ""),
    /* Which layout revision the standard froze, and which one is current — the
       two numbers a person needs to see that the line moved under them. */
    boundLineLayoutRevision: doc.source?.lineLayoutRevision ?? null,
    currentLineLayoutRevision: currentLineLayoutRevision ?? null,
    boundBulletinRevision: doc.source?.bulletinRevision ?? layout?.bulletinRevision ?? null,
    currentBulletinRevision: current?.bulletinRevision ?? null,
    resolution: reasons.includes(SOURCE_REASON.LAYOUT_UNAVAILABLE)
      || reasons.includes(SOURCE_REASON.FILE_UNAVAILABLE)
      ? "RESOLVE_SOURCE_LINE_LAYOUT"
      : "CREATE_NEW_STANDARD_FROM_CURRENT_SOURCE",
  });

/** Freeze the source facts. Server-derived on every path, without exception. */
function freezeSource(layout, current) {
  const sam = garmentSamFor(layout.sourceRows || []);
  const published = layouts.publishLayout(layout, { current });
  return {
    lineLayoutRevision: layout.revision,
    layoutFingerprint: str(layout.sourceFingerprint),
    bulletinRevision: layout.bulletinRevision,
    approvalDigest: str(layout.sourceApprovalDigest),
    requirementDigest: str(layout.sourceRequirementDigest),
    garmentSamMinutes: sam.garmentSamMinutes,
    samDerivation: sam.samDerivation,
    samRowCount: sam.samRowCount,
    /* What the layout's own readiness said on the day, by code. The layout
       remains the authority on its own gaps — including every machine
       compatibility gap, which stays visible here rather than being restated. */
    layoutReady: Boolean(published.readiness?.ready),
    layoutGapCodes: (published.readiness?.gaps || []).map((g) => g.code),
    capturedAt: new Date(),
  };
}

/**
 * RE-DERIVE THE FROZEN SOURCE FROM THE LAYOUT, AND SAY WHAT DISAGREES.
 *
 * `freezeSource` above produces these facts once, at creation. This produces
 * them again, from the same layout by the same helpers, and names every field
 * that no longer matches. The two are deliberately the same derivation: a second
 * way of computing a garment SAM would eventually disagree with the first, and a
 * mismatch would then mean nothing.
 *
 * ── WHY A POSITIVE TARGET IS NOT EVIDENCE ─────────────────────────────────
 * A tampered SAM, a swapped fingerprint or a rewritten row count all still
 * produce a perfectly plausible number of pieces per shift. The calculation
 * cannot tell anybody whether it was calculated from this layout, and that is
 * the whole question an approval has to answer.
 *
 * ── AND `capturedAt` IS NOT COMPARED WITH NOW ─────────────────────────────
 * It is evidence of WHEN the copy was taken, not a fact about the layout, so
 * there is nothing on the layout to compare it against. Re-deriving it would
 * make it differ every time it was checked. It is validated as a stored date
 * instead: present, real, and not in the future — a record that claims to have
 * been captured tomorrow has been written by something other than this service.
 */
function frozenSourceMismatches(standard, layout, current) {
  const frozen = standard.source || {};
  const derived = freezeSource(layout, current);
  const reasons = [];

  const note = (field, code, was, now) => reasons.push({
    field, code, frozen: was ?? null, derived: now ?? null,
  });

  /* Scalars, compared as the types they are stored as. */
  if (Number(frozen.lineLayoutRevision) !== Number(derived.lineLayoutRevision)) {
    note("source.lineLayoutRevision", "LINE_LAYOUT_REVISION_CHANGED",
      frozen.lineLayoutRevision, derived.lineLayoutRevision);
  }
  if (str(frozen.layoutFingerprint) !== str(derived.layoutFingerprint)) {
    note("source.layoutFingerprint", "LAYOUT_FINGERPRINT_CHANGED",
      frozen.layoutFingerprint, derived.layoutFingerprint);
  }
  if (Number(frozen.bulletinRevision) !== Number(derived.bulletinRevision)) {
    note("source.bulletinRevision", "BULLETIN_REVISION_CHANGED",
      frozen.bulletinRevision, derived.bulletinRevision);
  }
  if (str(frozen.approvalDigest) !== str(derived.approvalDigest)) {
    note("source.approvalDigest", "APPROVED_STANDARD_CHANGED",
      frozen.approvalDigest, derived.approvalDigest);
  }
  if (str(frozen.requirementDigest) !== str(derived.requirementDigest)) {
    note("source.requirementDigest", "REQUIREMENT_EVIDENCE_CHANGED",
      frozen.requirementDigest, derived.requirementDigest);
  }
  if (Number(frozen.garmentSamMinutes) !== Number(derived.garmentSamMinutes)) {
    note("source.garmentSamMinutes", "GARMENT_SAM_CHANGED",
      frozen.garmentSamMinutes, derived.garmentSamMinutes);
  }
  if (str(frozen.samDerivation) !== str(derived.samDerivation)) {
    note("source.samDerivation", "SAM_DERIVATION_CHANGED",
      frozen.samDerivation, derived.samDerivation);
  }
  if (Number(frozen.samRowCount) !== Number(derived.samRowCount)) {
    note("source.samRowCount", "SAM_ROW_COUNT_CHANGED",
      frozen.samRowCount, derived.samRowCount);
  }

  /* The layout's readiness AS CAPTURED, against what the layout says now. */
  if (Boolean(frozen.layoutReady) !== Boolean(derived.layoutReady)) {
    note("source.layoutReady", "LAYOUT_READINESS_CHANGED",
      Boolean(frozen.layoutReady), Boolean(derived.layoutReady));
  }
  const codes = (list) => [...(list || [])].map(String).sort().join(",");
  if (codes(frozen.layoutGapCodes) !== codes(derived.layoutGapCodes)) {
    note("source.layoutGapCodes", "LAYOUT_GAPS_CHANGED",
      [...(frozen.layoutGapCodes || [])], [...(derived.layoutGapCodes || [])]);
  }

  /* And the capture evidence itself — validated, never re-derived. */
  const capturedAt = frozen.capturedAt ? new Date(frozen.capturedAt) : null;
  if (!capturedAt || Number.isNaN(capturedAt.getTime())) {
    note("source.capturedAt", "CAPTURE_EVIDENCE_MISSING", frozen.capturedAt, null);
  } else if (capturedAt.getTime() > Date.now() + 60000) {
    /* A minute of tolerance for clock skew between application hosts; a record
       claiming to have been captured tomorrow was not written by this service. */
    note("source.capturedAt", "CAPTURE_EVIDENCE_IMPOSSIBLE", capturedAt.toISOString(), null);
  }

  return reasons;
}

/* ═══ READINESS ════════════════════════════════════════════════════════════
 *
 * Three states, and each means one thing:
 *
 *   READY        the layout source is current, the garment SAM is positive and
 *                proved, every required assumption is present, the calculation
 *                produced figures, and no line-layout readiness blocker
 *                invalidates it.
 *   PROVISIONAL  everything above holds EXCEPT that the working time rests on
 *                an explicit IE planning assumption rather than an
 *                authoritative calendar. Today that is every record.
 *   BLOCKED      something required is missing, invalid or contradictory, so
 *                there is no trustworthy target at all.
 *
 * A gap is never a zero. "Nobody has approved a standard time" is reported as a
 * gap with a null target, not as a target of nought.
 */
const READINESS = Object.freeze({
  READY: "READY", PROVISIONAL: "PROVISIONAL", BLOCKED: "BLOCKED",
});

/* Layout gaps that make a capacity target untrustworthy rather than merely
   incomplete. An unplaced operation still contributes its approved minutes to
   the garment SAM, so it does not invalidate the arithmetic — but a layout whose
   source has moved, or which can prove no work content at all, does. */
const BLOCKING_LAYOUT_GAPS = Object.freeze(new Set([
  "IE_LAYOUT_SOURCE_CHANGED",
  "IE_LAYOUT_METRICS_UNAVAILABLE",
  "IE_LAYOUT_NO_STATIONS",
]));

function readinessFor(doc, { sourceState, sourceReasons = [], calculation, currentLineLayoutRevision }) {
  const gaps = [];
  const source = doc.source || {};

  /* ── BLOCKERS ──
     Anything that is not an explicit CURRENT blocks. An unknown source is the
     LEAST safe standard to plan against, so it can never fall through to the
     provisional verdict a resolvable one gets. */
  if (sourceState === SOURCE_STATE.SOURCE_UNAVAILABLE) {
    gaps.push(gap("IE_CAPACITY_SOURCE_UNAVAILABLE", "RESOLVE_SOURCE_LINE_LAYOUT",
      "The line layout this standard was calculated from cannot be resolved, so nothing can prove "
      + "whether the target still describes the line. The figures below are frozen historical "
      + "evidence and are not a current standard.",
      {
        reasons: sourceReasons,
        boundLineLayoutRevision: source.lineLayoutRevision ?? null,
        boundBulletinRevision: source.bulletinRevision ?? null,
      }));
  } else if (sourceState && sourceState !== SOURCE_STATE.CURRENT) {
    gaps.push(gap("IE_CAPACITY_SOURCE_CHANGED", "CREATE_NEW_STANDARD_FROM_CURRENT_SOURCE",
      sourceReasons.includes(SOURCE_REASON.LAYOUT_REVISION)
        ? "The exact line configuration this standard was calculated for has since changed, so the "
          + "target is evidence of what was planned and not a current standard."
        : "The line layout this standard was calculated from is no longer a balance of the current source, "
          + "so the target is evidence of what was planned and not a current standard.",
      {
        reasons: sourceReasons,
        boundLineLayoutRevision: source.lineLayoutRevision ?? null,
        currentLineLayoutRevision: currentLineLayoutRevision ?? null,
        boundBulletinRevision: source.bulletinRevision ?? null,
      }));
  }
  if (!(Number(source.garmentSamMinutes) > 0)) {
    gaps.push(gap("IE_CAPACITY_NO_GARMENT_SAM", "APPROVE_STANDARD_TIMES",
      "This layout's frozen rows carry no approved standard time, so the garment SAM cannot be proved. "
      + "The target is unknown, not zero.",
      { samRowCount: source.samRowCount ?? 0 }));
  }
  for (const code of source.layoutGapCodes || []) {
    if (!BLOCKING_LAYOUT_GAPS.has(code)) continue;
    gaps.push(gap("IE_CAPACITY_LAYOUT_NOT_READY", "RESOLVE_LAYOUT_READINESS",
      "The line layout had a readiness blocker when this standard was calculated, "
      + "so the calculation cannot be relied on.",
      { layoutGapCode: code }));
  }
  if (calculation && !calculation.available) {
    gaps.push(gap("IE_CAPACITY_CALCULATION_UNAVAILABLE", "COMPLETE_PLANNING_INPUTS",
      "The target could not be calculated from the inputs on this record.",
      { reasons: calculation.unavailableReasons }));
  }

  const blocked = gaps.length > 0;

  /* ── THE PROVISIONAL GAP, WHICH IS NOT A BLOCKER ────────────────────────
     It is the honest statement of this chunk's one known limitation, and it
     travels with every record until an authoritative source exists. */
  const assumed = (doc.workingTime?.source?.kind || WORKING_TIME_SOURCE[0]) === "IE_PLANNING_ASSUMPTION";
  if (assumed) {
    gaps.push(gap("IE_CAPACITY_WORKING_TIME_ASSUMED", "STATE_OR_SUPPLY_WORKING_TIME_CALENDAR",
      "The shift minutes, breaks and shifts per day behind this target are an explicit IE planning "
      + "assumption. No company-scoped, versioned factory working-time calendar exists to cite, so the "
      + "calendar linkage is UNKNOWN and this standard is provisional.",
      {
        workingTimeSourceKind: doc.workingTime?.source?.kind || WORKING_TIME_SOURCE[0],
        assumptionNote: str(doc.workingTime?.source?.note),
        requiredUpstreamContract: "COMPANY_SCOPED_VERSIONED_WORKING_TIME_CALENDAR",
      }));
  }

  /* ── AND THE LAYOUT'S OWN NON-BLOCKING GAPS STAY VISIBLE ────────────────
     Machine compatibility above all: a line planned against stations that do
     not plan the machine types their operations require is a real risk to the
     target, and Chunk 7A neither re-decides it nor hides it. Nothing here
     invents a machine throughput or a physical availability to go with it. */
  const carried = (source.layoutGapCodes || []).filter((c) => !BLOCKING_LAYOUT_GAPS.has(c));
  if (carried.length) {
    gaps.push(gap("IE_CAPACITY_LAYOUT_GAPS_CARRIED", "REVIEW_LINE_LAYOUT",
      `The line layout reported ${carried.length} readiness gap${carried.length === 1 ? "" : "s"} when this `
      + "standard was calculated. They remain visible on the layout and are not restated here.",
      { layoutGapCodes: carried, lineLayoutId: String(doc.lineLayoutId) }));
  }

  return {
    state: blocked ? READINESS.BLOCKED : (assumed ? READINESS.PROVISIONAL : READINESS.READY),
    ready: !blocked && !assumed,
    gaps,
  };
}

/* ═══ PUBLISHING ═══════════════════════════════════════════════════════════ */

const publishEvent = (e) => ({
  eventId: e.eventId,
  type: e.type,
  at: e.at ? new Date(e.at).toISOString() : null,
  actorName: e.actorName || "",
  standardRevision: e.standardRevision,
  changed: Array.isArray(e.changed) ? [...e.changed] : [],
  summary: e.summary || "",
});

const dateOnly = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

function publishStandard(doc, {
  sourceState, sourceReasons = [], current, currentLineLayoutRevision,
  /* ── THE RESOLVED LAYOUT'S STATUS (Chunk 7C3) ────────────────────────────
     Threaded in rather than looked up, because `withSourceState` has already
     resolved the layout on every path that publishes. `null` where no layout
     could be resolved, which is an absence and not a status. */
  lineLayoutStatus = null,
  withHistory = false,
} = {}) {
  const source = doc.source || {};
  const shared = {
    availableShiftMinutes: doc.workingTime?.availableShiftMinutes,
    breakMinutes: doc.workingTime?.breakMinutes,
    shiftsPerDay: doc.workingTime?.shiftsPerDay,
    plannedOperatorCount: doc.manpower?.plannedOperatorCount,
    garmentSamMinutes: source.garmentSamMinutes,
  };
  const calculation = calculateCapacity({
    ...shared, targetEfficiencyPercent: doc.targetEfficiencyPercent,
  });

  /* ── THE RAMP STAGE'S OWN TARGET (Chunk 7B) ──────────────────────────────
     The SAME calculator, the same rounding and the same floor — only the
     efficiency differs, and it is the one frozen on this record rather than one
     read back from a profile. There is deliberately no second calculator: two
     capacity formulas in one lane is how two screens come to disagree.

     Null when no ramp was applied, which is an absence and not a target of
     nought. */
  const rampCalculation = doc.ramp
    ? calculateCapacity({ ...shared, targetEfficiencyPercent: doc.ramp.targetEfficiencyPercent })
    : null;

  return {
    capacityStandardId: String(doc._id),
    companyId: String(doc.companyId),
    status: doc.status,
    /* Named `styleFileId` on the wire, as every IE read surface names it. */
    styleFileId: String(doc.ieStyleFileId),
    lineLayoutId: String(doc.lineLayoutId),
    status: doc.status,
    revision: doc.revision,

    /* ── WHAT THIS IS A CALCULATION OF ──────────────────────────────────
       Frozen at creation, never re-read. `state` compares it with the source
       as it is NOW, without changing a stored byte. */
    source: {
      lineLayoutRevision: source.lineLayoutRevision,
      /* The layout's revision NOW, beside the one this standard froze. Null
         when the layout cannot be resolved — an absence, never a zero. */
      currentLineLayoutRevision: currentLineLayoutRevision ?? null,
      layoutFingerprint: source.layoutFingerprint,
      bulletinRevision: source.bulletinRevision,
      currentBulletinRevision: current?.bulletinRevision ?? null,
      currentFingerprint: current?.fingerprint ?? null,
      approvalDigest: source.approvalDigest || null,
      requirementDigest: source.requirementDigest || null,
      /* Never null: an unresolved source has its own state, and a reader who
         branches on this field must not be handed an absence to interpret. */
      state: sourceState || SOURCE_STATE.SOURCE_UNAVAILABLE,
      changeReasons: sourceReasons,
      /* The server-derived SAM and how it was derived. */
      garmentSamMinutes: source.garmentSamMinutes,
      samDerivation: source.samDerivation,
      samRowCount: source.samRowCount,
      layoutReadyAtCapture: Boolean(source.layoutReady),
      layoutGapCodesAtCapture: [...(source.layoutGapCodes || [])],
      capturedAt: source.capturedAt ? new Date(source.capturedAt).toISOString() : null,
    },

    /* ── THE STATED INPUTS ──────────────────────────────────────────────── */
    inputs: {
      availableShiftMinutes: doc.workingTime?.availableShiftMinutes ?? null,
      breakMinutes: doc.workingTime?.breakMinutes ?? null,
      shiftsPerDay: doc.workingTime?.shiftsPerDay ?? null,
      plannedOperatorCount: doc.manpower?.plannedOperatorCount ?? null,
      /* Recorded as a requirement and deliberately absent from the formula. */
      plannedHelperCount: doc.manpower?.plannedHelperCount ?? null,
      helperUsage: "INFORMATIONAL_ONLY",
      targetEfficiencyPercent: doc.targetEfficiencyPercent ?? null,
      efficiencyUnit: "PERCENT",
      effectiveFrom: dateOnly(doc.effectiveFrom),
      effectiveTo: dateOnly(doc.effectiveTo),
      note: doc.note || "",
    },

    /* ── HOW THE WORKING TIME IS KNOWN ──────────────────────────────────── */
    workingTimeSource: {
      kind: doc.workingTime?.source?.kind || WORKING_TIME_SOURCE[0],
      calendarId: doc.workingTime?.source?.calendarId
        ? String(doc.workingTime.source.calendarId) : null,
      calendarVersionNo: doc.workingTime?.source?.calendarVersionNo ?? null,
      calendarRef: doc.workingTime?.source?.calendarRef || "",
      note: doc.workingTime?.source?.note || "",
    },

    /* ── THE CALENDAR LINKAGE, PUBLISHED AS UNKNOWN ──────────────────────
       The Chunk 7A audit found no safe source, so the connection is stated as
       unknown and the reason is named. A zero-day calendar or a borrowed
       Merchandising deadline calendar would both be worse than this. */
    calendarLinkage: {
      state: "UNKNOWN",
      reason: "NO_COMPANY_SCOPED_WORKING_TIME_CALENDAR",
      message: "No company-scoped, versioned factory working-time calendar exists. Merchandising's "
        + "working calendar is versioned but models delivery working DAYS with no shift length or "
        + "breaks; ProductionSchedule holds shift minutes and breaks but has no company scope, no "
        + "version and is Production's own booking record; HR attendance is per-employee actuals. "
        + "This standard therefore rests on an explicitly labelled IE planning assumption.",
      rejectedSources: [
        "MERCHANDISING_WORKING_CALENDAR_VERSION",
        "PRODUCTION_SCHEDULE",
        "HR_ATTENDANCE_SHIFT_SNAPSHOT",
      ],
      requiredUpstreamContract: "COMPANY_SCOPED_VERSIONED_WORKING_TIME_CALENDAR",
    },

    calculation,

    /* ── WHAT RAMP THIS STANDARD FROZE, AND WHAT IT PRODUCES ──────────────
       Every field is a copy taken when the stage was applied. Nothing here is
       read back from the profile, so correcting or retiring that profile leaves
       this block and this target exactly as they are. */
    ramp: doc.ramp ? {
      rampProfileId: String(doc.ramp.rampProfileId),
      rampProfileRevision: doc.ramp.rampProfileRevision,
      /* The name AS IT WAS. A person reads the name; a reader resolves by the id. */
      rampProfileName: doc.ramp.rampProfileName || "",
      stageId: doc.ramp.stageId,
      stageSequence: doc.ramp.stageSequence,
      stageLabel: doc.ramp.stageLabel || "",
      fromProductionDay: doc.ramp.fromProductionDay,
      toProductionDay: doc.ramp.toProductionDay ?? null,
      targetEfficiencyPercent: doc.ramp.targetEfficiencyPercent,
      efficiencyUnit: "PERCENT",
      capturedAt: doc.ramp.capturedAt ? new Date(doc.ramp.capturedAt).toISOString() : null,
      /* Said plainly, because a ramp is the field most likely to be mistaken
         for an observation of how a run actually went. */
      basis: "STATED_IE_ASSUMPTION",
      describesActuals: false,
    } : null,
    rampCalculation,

    readiness: readinessFor(doc, {
      sourceState, sourceReasons, calculation, currentLineLayoutRevision,
    }),

    /* ── WHETHER SOMEBODY ACCEPTED THIS TARGET ──────────────────────────
       `null` on a draft, because an unapproved target has no approver and a
       stated null would say somebody considered it. */
    approval: doc.status === "APPROVED" ? {
      approvedByName: doc.approvedByName || "",
      approvedAt: doc.approvedAt ? new Date(doc.approvedAt).toISOString() : null,
      approvedRevision: doc.approvedRevision ?? null,
    } : null,

    /* ── EDITABLE ONLY ON AN EXPLICIT CURRENT, AND ONLY WHILE A DRAFT ────
       Written as an equality against CURRENT rather than as the absence of a
       change, and with no fallback: a missing state is not evidence that
       nothing moved, and treating it as one would make the single least
       trustworthy record on the page look like the cleanest. An approved
       standard is evidence and is never editable, whatever its source says. */
    editable: sourceState === SOURCE_STATE.CURRENT && doc.status === "DRAFT",

    /* ── WHETHER APPROVAL IS EVEN THE RIGHT QUESTION FOR THIS RECORD ─────
       A DRAFT, whose source is current, bound to a line somebody has APPROVED.
       All three, because the third is a mandatory prerequisite and a `true` that
       the endpoint then refuses is worse than no answer — a screen offers a
       control that cannot work, and the person who presses it learns the system
       does not know its own rules.

       It still does NOT mean the readiness gates would pass: `readiness`
       answers that, and it is a different question with a different fix. This
       says only whether approval is the relevant next action. */
    canApprove: doc.status === "DRAFT"
      && sourceState === SOURCE_STATE.CURRENT
      && lineLayoutStatus === "APPROVED",
    /* Published beside it so a reader knows WHY, without inferring. */
    lineLayoutStatus,

    ...(withHistory ? { history: [...(doc.history || [])].reverse().map(publishEvent) } : {}),
    createdByName: doc.createdByName || "",
    updatedByName: doc.updatedByName || "",
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,

    /* Chunk 7C3 approves a capacity standard and nothing else. It releases
       nothing, acknowledges nothing, books nothing and promises no date. */
    canRelease: false,
    booksCapacity: false,
    promisesDelivery: false,
  };
}

/* ═══ THE RAMP SELECTION (Chunk 7B) ════════════════════════════════════════
 *
 * Which stage of which ramp profile this standard is planned for — CHOSEN, never
 * inferred. Both ids travel together: a profile without a stage does not say
 * which efficiency to use, and a stage without a profile does not say whose.
 *
 * Sending both as null clears the ramp, which is a real decision and not the
 * same as leaving them out. Leaving them out on an edit keeps whatever is
 * already frozen, untouched.
 */
function readRampSelection(body, current) {
  const sentProfile = Object.prototype.hasOwnProperty.call(body, "rampProfileId");
  const sentStage = Object.prototype.hasOwnProperty.call(body, "rampStageId");
  if (!sentProfile && !sentStage) return { action: "KEEP" };

  const profileId = body.rampProfileId;
  const stageId = body.rampStageId;
  const blankProfile = profileId === null || profileId === "" || profileId === undefined;
  const blankStage = stageId === null || stageId === "" || stageId === undefined;

  /* Both cleared: drop the ramp and plan on the steady-state target alone. */
  if (blankProfile && blankStage) {
    return { action: current?.ramp ? "CLEAR" : "KEEP" };
  }

  const errs = [];
  if (blankProfile) {
    errs.push({
      field: "rampProfileId", code: "REQUIRED",
      message: "Name the ramp profile the stage belongs to.",
    });
  } else if (!isId(profileId)) {
    errs.push({ field: "rampProfileId", code: "NOT_AN_ID", message: "That is not a ramp profile id." });
  }
  if (blankStage) {
    errs.push({
      field: "rampStageId", code: "REQUIRED",
      message: "Choose which stage of the ramp this standard is planned for.",
    });
  }
  if (errs.length) {
    throw fail("IE_CAPACITY_STANDARD_INPUT_INVALID",
      errs.length === 1 ? errs[0].message : "A ramp needs both a profile and a stage.",
      { field: errs[0].field, fieldErrors: errs });
  }
  return { action: "APPLY", rampProfileId: str(profileId), rampStageId: str(stageId) };
}

/** Two frozen ramp blocks are the same only if every frozen fact matches. */
const sameRamp = (a, b) => {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return String(a.rampProfileId) === String(b.rampProfileId)
    && Number(a.rampProfileRevision) === Number(b.rampProfileRevision)
    && str(a.stageId) === str(b.stageId)
    && Number(a.targetEfficiencyPercent) === Number(b.targetEfficiencyPercent);
};

/* ═══ CREATE ═══════════════════════════════════════════════════════════════ */

async function createStandard(ctx, { layoutId, body = {}, actor } = {}) {
  const { layout, current, sourceState, sourceReasons } = await loadOwnedLayout(ctx, layoutId);
  refuseUnknown(body, CREATE_FIELDS, "a new capacity standard");

  /* A standard is never opened against a superseded balance: it would freeze
     evidence of a line nobody can edit any more, and read as current. */
  if (sourceState !== layouts.SOURCE_STATE.CURRENT) {
    /* Nothing is frozen yet, so there is no bound layout revision to name. */
    throw sourceChanged({ lineLayoutId: layout._id, source: null }, {
      layout, reasons: sourceReasons, current, currentLineLayoutRevision: layout.revision,
    });
  }

  const inputs = readInputs(body, null);
  const source = freezeSource(layout, current);

  /* Resolved against THIS company's register and frozen, so a later edit or
     retirement of the profile cannot restate this standard's ramp target. */
  const selection = readRampSelection(body, null);
  const ramp = selection.action === "APPLY"
    ? await ramps.resolveStageForCapture(ctx, selection)
    : null;

  const created = await IeCapacityStandard.create({
    companyId: ctx.companyId,
    ieStyleFileId: layout.ieStyleFileId,
    lineLayoutId: layout._id,
    source,
    ...inputs,
    ramp,
    status: "DRAFT",
    revision: 1,
    history: [event("CAPACITY_STANDARD_CREATED", {
      actor, standardRevision: 1,
      changed: ["workingTime", "manpower", "efficiency", "sourceClassification",
        ...(ramp ? ["ramp"] : [])],
      summary: `Capacity standard opened for line layout revision ${layout.revision} — `
        + `garment SAM ${source.garmentSamMinutes} minutes over ${source.samRowCount} rows, `
        + `${inputs.manpower.plannedOperatorCount} operators at ${inputs.targetEfficiencyPercent}%`,
    })],
    createdBy: actorId(actor), createdByName: actorName(actor),
    updatedBy: actorId(actor), updatedByName: actorName(actor),
  });

  return {
    created: true,
    standard: publishStandard(created.toObject(), {
      sourceState, sourceReasons, current,
      currentLineLayoutRevision: layout.revision,
      lineLayoutStatus: layout.status ?? null, withHistory: true,
    }),
  };
}

/* ═══ READ AND LIST ════════════════════════════════════════════════════════ */

async function loadOwnedStandard(ctx, capacityStandardId) {
  assertContext(ctx);
  if (!isId(capacityStandardId)) throw standardNotFound();
  const doc = await IeCapacityStandard.findOne({
    _id: oid(capacityStandardId), companyId: ctx.companyId,
  }).lean();
  if (!doc) throw standardNotFound();
  return doc;
}

/** The standard, and how its frozen source compares with the source today. */
async function withSourceState(ctx, doc) {
  /* ── AN EXPECTED ABSENCE IS AN ANSWER, NOT AN ERROR ─────────────────────
     A layout or file this company cannot see — deleted, or never theirs — is a
     condition this contract has a state for. It is returned, not thrown, so the
     standard stays readable as the frozen evidence it is. Both queries are
     company-scoped, so an outsider's layout resolves to exactly the same
     unavailable answer as a deleted one and nothing is disclosed either way.

     Anything else — a database or service failure inside `currentSourceFor` —
     is NOT caught here or anywhere on this path. An infrastructure failure is
     not a fact about the source, and swallowing it into a normal answer would
     publish a guess as a finding. */
  const layout = await IeLineLayout.findOne({ _id: doc.lineLayoutId, companyId: ctx.companyId }).lean();
  if (!layout) {
    return {
      layout: null, current: null, currentLineLayoutRevision: null, lineLayoutStatus: null,
      sourceState: SOURCE_STATE.SOURCE_UNAVAILABLE,
      sourceReasons: [SOURCE_REASON.LAYOUT_UNAVAILABLE],
    };
  }
  const file = await IeStyleFile.findOne({ _id: layout.ieStyleFileId, companyId: ctx.companyId })
    .select("_id revision bulletin.rows").lean();
  if (!file) {
    return {
      layout, current: null, currentLineLayoutRevision: layout.revision,
      lineLayoutStatus: layout.status ?? null,
      sourceState: SOURCE_STATE.SOURCE_UNAVAILABLE,
      sourceReasons: [SOURCE_REASON.FILE_UNAVAILABLE],
    };
  }

  /* ── THE LAYOUT'S OWN SOURCE, NOT THE FILE'S (Chunk 7C2) ────────────────
     A version-backed layout is a balance of its immutable approved bulletin
     version; only a pre-7C1 layout is judged against the file's mutable
     bulletin. Asking the file for both would re-judge a version-backed layout
     against a successor draft it was never balanced against. */
  const current = await layouts.sourceForLayout(ctx, layout, file);
  const { state, reasons } = layouts.sourceStateOf(layout, current);

  /* ── THE SECOND COMPARISON, WHICH THE LAYOUT CANNOT MAKE ────────────────
     The layout answers "am I still a balance of the current bulletin". Only the
     capacity standard can answer "is the line still arranged the way I costed
     it", because only it froze a layout revision. A station rearrangement, a
     changed planned machine type, a moved assignment or a relabelled station
     each move that revision while leaving the bulletin and the approved times
     exactly where they were — and each one changes the line the target was
     calculated for. */
  const bound = Number(doc.source?.lineLayoutRevision);
  const moved = Number.isFinite(bound) && Number(layout.revision) !== bound;
  const allReasons = moved ? [...reasons, SOURCE_REASON.LAYOUT_REVISION] : reasons;

  return {
    layout,
    current,
    currentLineLayoutRevision: layout.revision,
    lineLayoutStatus: layout.status ?? null,
    sourceState: moved || state !== layouts.SOURCE_STATE.CURRENT
      ? SOURCE_STATE.SOURCE_CHANGED
      : SOURCE_STATE.CURRENT,
    sourceReasons: allReasons,
  };
}

async function readStandard(ctx, { capacityStandardId } = {}) {
  const doc = await loadOwnedStandard(ctx, capacityStandardId);
  const {
    current, sourceState, sourceReasons, currentLineLayoutRevision, lineLayoutStatus,
  } = await withSourceState(ctx, doc);
  return {
    standard: publishStandard(doc, {
      sourceState, sourceReasons, current, currentLineLayoutRevision, lineLayoutStatus,
      withHistory: true,
    }),
  };
}

/**
 * The company's capacity standards, newest first.
 *
 * Optionally narrowed to one layout or one engineering file — enough for the
 * future Capacity page, and no more. Company scope is the first clause on every
 * query, so another company's standard cannot appear in a page or be counted in
 * one.
 */
async function listStandards(ctx, { layoutId, styleFileId, limit, cursor } = {}) {
  assertContext(ctx);
  const size = pageSize(limit);
  const after = decodeCursor(cursor, "time");

  const and = [{ companyId: ctx.companyId }];
  if (layoutId !== undefined && layoutId !== null && layoutId !== "") {
    /* A malformed or foreign id is a truthful empty page, not an error and not
       everybody else's standards. */
    if (!isId(layoutId)) return emptyPage(size, { layoutId: str(layoutId) });
    and.push({ lineLayoutId: oid(layoutId) });
  }
  if (styleFileId !== undefined && styleFileId !== null && styleFileId !== "") {
    if (!isId(styleFileId)) return emptyPage(size, { styleFileId: str(styleFileId) });
    and.push({ ieStyleFileId: oid(styleFileId) });
  }
  if (after) {
    and.push({
      $or: [
        { createdAt: { $lt: new Date(after.t) } },
        { createdAt: new Date(after.t), _id: { $lt: oid(after.i) } },
      ],
    });
  }

  const found = await IeCapacityStandard.find({ $and: and })
    .sort({ createdAt: -1, _id: -1 }).limit(size + 1).lean();
  const page = found.slice(0, size);

  /* Each row's source state, resolved once per distinct LAYOUT AND FROZEN
     REVISION: a page of ten standards for one layout must not read the same
     bulletin ten times, but two standards that froze different revisions of the
     same layout are genuinely in different states and must not share an answer.

     There is no `try` here. An expected missing source already comes back as
     `SOURCE_UNAVAILABLE`, and an unexpected database or service failure
     propagates through the normal error path rather than being converted into a
     provisional row nobody can tell from a real one. */
  const resolved = new Map();
  for (const row of page) {
    const key = `${String(row.lineLayoutId)}@${row.source?.lineLayoutRevision ?? "?"}`;
    if (resolved.has(key)) continue;
    resolved.set(key, await withSourceState(ctx, row));
  }

  const last = page[page.length - 1];
  return {
    standards: page.map((row) => {
      const s = resolved.get(`${String(row.lineLayoutId)}@${row.source?.lineLayoutRevision ?? "?"}`);
      return publishStandard(row, {
        sourceState: s.sourceState, sourceReasons: s.sourceReasons, current: s.current,
        currentLineLayoutRevision: s.currentLineLayoutRevision,
        lineLayoutStatus: s.lineLayoutStatus ?? null,
      });
    }),
    limit: size,
    hasMore: found.length > size,
    nextCursor: found.length > size
      ? encodeCursor({ t: new Date(last.createdAt).getTime(), i: String(last._id) })
      : null,
    sort: "createdAt:desc,_id:desc",
  };
}

const emptyPage = (size, filter = {}) => ({
  standards: [], limit: size, hasMore: false, nextCursor: null,
  sort: "createdAt:desc,_id:desc", filter,
});

/**
 * An approved standard refuses every write, and says which one it refused.
 *
 * Shared by the edit path and the approval path, so the two cannot drift into
 * describing the same record differently.
 */
const standardImmutable = (standard, verb) => fail("IE_CAPACITY_STANDARD_IMMUTABLE",
  "This capacity standard was approved and is permanent evidence of the target somebody accepted. "
  + `It cannot be ${verb} — create a new draft standard for the current approved layout.`,
  {
    capacityStandardId: String(standard._id),
    status: standard.status,
    approvedRevision: standard.approvedRevision ?? null,
    approvedByName: standard.approvedByName || "",
    resolution: "CREATE_NEW_DRAFT_STANDARD",
  });

/* ═══ EDIT ═════════════════════════════════════════════════════════════════
 *
 * Planning inputs only, under optimistic concurrency, through ONE conditional
 * write whose filter carries the company, the id and the revision the caller
 * says they read. Two simultaneous edits therefore produce exactly one winner
 * without a transaction, and the loser is told what the revision actually is.
 */

/** Which INPUT GROUPS moved. Never a field-by-field diff. */
function changedGroups(before, after) {
  const changed = [];
  const w = (a, b) => a?.availableShiftMinutes !== b?.availableShiftMinutes
    || a?.breakMinutes !== b?.breakMinutes
    || a?.shiftsPerDay !== b?.shiftsPerDay;
  if (w(before.workingTime, after.workingTime)) changed.push("workingTime");
  if (before.manpower?.plannedOperatorCount !== after.manpower?.plannedOperatorCount
    || before.manpower?.plannedHelperCount !== after.manpower?.plannedHelperCount) {
    changed.push("manpower");
  }
  if (Number(before.targetEfficiencyPercent) !== Number(after.targetEfficiencyPercent)) {
    changed.push("efficiency");
  }
  const day = (d) => (d ? new Date(d).getTime() : null);
  if (day(before.effectiveFrom) !== day(after.effectiveFrom)
    || day(before.effectiveTo) !== day(after.effectiveTo)) {
    changed.push("effectivePeriod");
  }
  if (str(before.workingTime?.source?.kind) !== str(after.workingTime?.source?.kind)
    || str(before.workingTime?.source?.note) !== str(after.workingTime?.source?.note)) {
    changed.push("sourceClassification");
  }
  if (str(before.note) !== str(after.note)) changed.push("note");
  if (!sameRamp(before.ramp || null, after.ramp || null)) changed.push("ramp");
  return changed;
}

async function updateStandard(ctx, { capacityStandardId, body = {}, actor } = {}) {
  const current = await loadOwnedStandard(ctx, capacityStandardId);
  refuseUnknown(body, PATCH_FIELDS, "a capacity standard edit");
  const expected = readExpectedRevision(body.expectedRevision);

  /* ── AN APPROVED STANDARD IS EVIDENCE, AND IS ASKED ABOUT FIRST ────────
     Before the source and before the revision. Both of those answers tell
     somebody to re-read and decide again, and no amount of re-reading will make
     an approved standard editable — the way to change a target is a new draft.
     Asked before `withSourceState` too, so a record whose layout has since
     vanished still answers "this was approved" rather than "your source moved",
     which would be the wrong reason and the wrong resolution. */
  if (current.status === "APPROVED") throw standardImmutable(current, "edited");

  const {
    layout, current: source, sourceState, sourceReasons, currentLineLayoutRevision, lineLayoutStatus,
  } = await withSourceState(ctx, current);

  /* ── A MOVED OR UNRESOLVABLE SOURCE FREEZES THIS RECORD ────────────────
     Checked BEFORE the revision comparison and before the no-op branch: the
     record is not editable at all, and answering "no change" or "conflict"
     would both be the wrong answer to "why can I not save this".

     The test is for an explicit CURRENT, not for the absence of a change: an
     unresolvable source fails closed here exactly as a moved one does. */
  if (sourceState !== SOURCE_STATE.CURRENT) {
    throw sourceChanged(current, {
      layout, reasons: sourceReasons, current: source, currentLineLayoutRevision,
    });
  }

  /* ── THEN THE REVISION, BEFORE THE NO-OP BRANCH ────────────────────────
     A stale request is a conflict even when its outcome would have been a
     no-op: the caller decided from a state that no longer exists, and telling
     them "nothing changed" would hide that. */
  if (current.revision !== expected) {
    throw fail("IE_CAPACITY_STANDARD_REVISION_CONFLICT",
      "Somebody changed this capacity standard while you were reading it. Re-read it and decide again.",
      { expected, actual: current.revision, capacityStandardId: String(current._id) });
  }

  const inputs = readInputs(body, current);

  /* ── THE RAMP, RESOLVED FRESH OR LEFT EXACTLY WHERE IT IS ──────────────
     A re-application re-freezes, so re-applying the same stage after the
     profile has been corrected DOES move this standard — deliberately, because
     somebody asked for it. What never happens is the reverse: the stored block
     is not re-read against the profile, so editing a profile changes no
     standard on its own. */
  const selection = readRampSelection(body, current);
  const ramp = selection.action === "APPLY"
    ? await ramps.resolveStageForCapture(ctx, selection)
    : (selection.action === "CLEAR" ? null : (current.ramp || null));

  const changed = changedGroups(current, { ...inputs, ramp });

  if (!changed.length) {
    /* An honest no-op: nothing is written, no revision moves, no timestamp
       moves and no audit entry is invented. */
    return {
      updated: false,
      standard: publishStandard(current, {
        sourceState, sourceReasons, current: source, currentLineLayoutRevision, lineLayoutStatus,
        withHistory: true,
      }),
      events: [],
    };
  }

  const nextRevision = expected + 1;
  const audit = event("CAPACITY_STANDARD_EDITED", {
    actor, standardRevision: nextRevision, changed,
    summary: `Changed ${changed.join(", ")}`,
  });

  const updated = await IeCapacityStandard.findOneAndUpdate(
    { _id: current._id, companyId: ctx.companyId, revision: expected, status: "DRAFT" },
    {
      $set: {
        workingTime: inputs.workingTime,
        manpower: inputs.manpower,
        targetEfficiencyPercent: inputs.targetEfficiencyPercent,
        effectiveFrom: inputs.effectiveFrom,
        effectiveTo: inputs.effectiveTo,
        note: inputs.note,
        ramp,
        updatedBy: actorId(actor), updatedByName: actorName(actor),
      },
      $inc: { revision: 1 },
      $push: { history: { $each: [audit], $slice: -LIMITS.HISTORY } },
    },
    { new: true },
  ).lean();

  if (!updated) {
    /* One company-scoped re-read classifies the miss. */
    const now = await IeCapacityStandard.findOne({ _id: current._id, companyId: ctx.companyId })
      .select("_id revision status").lean();
    if (!now) throw standardNotFound();
    throw fail("IE_CAPACITY_STANDARD_REVISION_CONFLICT",
      "Somebody changed this capacity standard while you were reading it. Re-read it and decide again.",
      { expected, actual: now.revision, capacityStandardId: String(now._id) });
  }

  return {
    updated: true,
    standard: publishStandard(updated, {
      sourceState, sourceReasons, current: source, currentLineLayoutRevision, lineLayoutStatus,
      withHistory: true,
    }),
    events: [publishEvent(audit)],
  };
}

/* ═══ APPROVE (Chunk 7C3) ══════════════════════════════════════════════════
 *
 * A second person accepts the stated assumptions and the target they produce.
 *
 * ── WHAT APPROVAL DOES NOT MEAN ───────────────────────────────────────────
 * It does not prove the factory's working time. Every figure here still rests
 * on shift minutes, breaks and shifts per day somebody typed in and labelled as
 * an IE planning assumption, because no company-scoped versioned working-time
 * calendar exists to cite. Approving a PROVISIONAL standard is therefore
 * permitted and is the ordinary case — refusing would block IE indefinitely on
 * a record no department owns — and approval changes NOTHING about that
 * limitation: the calendar linkage stays UNKNOWN, the working-time source stays
 * an assumption, the readiness stays PROVISIONAL and the assumed-working-time
 * gap travels with the approved record for ever. What must never happen is a
 * release presenting assumed working time as calendar-proved, and the way to
 * make that impossible is for the record never to stop saying which it is.
 *
 * ── AND IT APPROVES A TARGET FOR ONE EXACT APPROVED LINE ──────────────────
 * The layout must be APPROVED, and this standard's frozen `lineLayoutRevision`
 * must be the revision that layout is at NOW. A standard created while the
 * layout was still a draft froze the draft's revision, and approving the layout
 * moves it — so such a standard is a target for a line nobody signed off, and
 * it does not become approvable merely because the line was approved later. The
 * answer is a new standard against the approved layout.
 */

const APPROVE_FIELDS = Object.freeze(["expectedRevision"]);

/* Server-owned facts somebody will reasonably try to send, refused by name. */
const APPROVE_REFUSED = Object.freeze({
  companyId: "the company — that comes from your own membership, never a body",
  capacityStandardId: "its own id, which is in the address",
  status: "its own status — approval is its own action",
  revision: "its own revision — send `expectedRevision` to say which one you read",
  approvedBy: "who approved it, which comes from your session",
  approvedByName: "who approved it, which comes from your session",
  approvedAt: "when it was approved, which the server stamps",
  approvedRevision: "which revision was approved, which the server records",
  history: "its own audit trail",
  readiness: "a readiness verdict — the server decides it",
  calendarLinkage: "a calendar linkage. Approving a standard proves no calendar",
  workingTimeSourceKind: "how the working time is known. Approving it does not change that",
  lineLayoutId: "which layout it is for, which was settled when it was created",
  reason: "a reason. An approval is a decision, not an explanation",
});

function assertApproveShape(body) {
  if (body === null || body === undefined) return;
  if (typeof body !== "object" || Array.isArray(body)) {
    throw fail("VALIDATION", "An approval is an object.", { field: "body" });
  }
  for (const key of Object.keys(body)) {
    if (APPROVE_FIELDS.includes(key)) continue;
    const refused = APPROVE_REFUSED[key] || REFUSED_FIELDS[key];
    throw fail("FIELD_NOT_ACCEPTED",
      refused ? `Approving a capacity standard cannot carry ${refused}.`
        : `"${key}" is not part of approving a capacity standard.`,
      {
        field: key,
        fieldErrors: [{
          field: key, code: "NOT_ACCEPTED",
          message: refused ? `This action does not accept "${key}".`
            : `"${key}" is not part of approving a capacity standard.`,
        }],
      });
  }
}

/**
 * WHO LAST AUTHORED THIS STANDARD — the person an approver must not be.
 *
 * Fails closed when nothing stored says. Treating an unknown author as "not the
 * approver" would turn every unattributable record into one anybody may wave
 * through, which is the record where a second pair of eyes matters most.
 */
function authorOf(standard) {
  const author = standard.updatedBy || standard.createdBy || null;
  if (!author) {
    throw fail("IE_CAPACITY_STANDARD_MAKER_CHECKER",
      "Nothing stored says who authored this capacity standard, so it cannot be approved by "
      + "somebody other than its author.",
      { capacityStandardId: String(standard._id) });
  }
  return String(author);
}

async function approveStandard(ctx, { capacityStandardId, body = {}, actor } = {}) {
  const current = await loadOwnedStandard(ctx, capacityStandardId);
  assertApproveShape(body);
  const expected = readExpectedRevision(body.expectedRevision);

  /* ── ALREADY APPROVED IS NOT A NO-OP ────────────────────────────────────
     Answering "nothing changed" would report a second approval as a success and
     leave two people believing they each took the decision. */
  if (current.status === "APPROVED") throw standardImmutable(current, "approved again");

  /* ── MAKER-CHECKER FIRST, AND BY ACTOR ID ───────────────────────────────
     Not a missing role — the wrong PERSON. An owner and a platform
     administrator are refused on identical terms, and the comparison is of
     stable ids: two people share a display name far more often than they share
     an id, and a name is editable by the person it belongs to.

     Asked before the gates so somebody who may not decide is not handed a
     detailed account of what remains to be fixed. */
  const approver = actorId(actor);
  if (!approver) {
    throw fail("IE_CAPACITY_STANDARD_MAKER_CHECKER",
      "Approving a capacity standard has to be attributable to a person.");
  }
  if (authorOf(current) === String(approver)) {
    throw fail("IE_CAPACITY_STANDARD_MAKER_CHECKER",
      "A capacity standard has to be approved by somebody other than the person who last worked on it.",
      {
        capacityStandardId: String(current._id),
        authoredByName: current.updatedByName || current.createdByName || "",
      });
  }

  /* ── THE SOURCE IT FROZE MUST STILL BE THE SOURCE ───────────────────────
     A moved or unresolvable source is refused with the code that already means
     exactly that, rather than a second way of saying it. */
  const {
    layout, current: source, sourceState, sourceReasons, currentLineLayoutRevision, lineLayoutStatus,
  } = await withSourceState(ctx, current);
  if (sourceState !== SOURCE_STATE.CURRENT) {
    throw sourceChanged(current, {
      layout, reasons: sourceReasons, current: source, currentLineLayoutRevision,
    });
  }

  /* ── AND THE LINE IT IS A TARGET FOR MUST BE AN APPROVED ONE ────────────
     Both halves, and the second is the one that matters most: a standard built
     while the layout was a draft froze that draft's revision, and approving the
     layout moved it. Such a record is a target for a line nobody signed off and
     must not become approvable by somebody else's later decision. */
  if (!layout || layout.status !== "APPROVED") {
    throw fail("IE_CAPACITY_STANDARD_LAYOUT_NOT_APPROVED",
      "The line layout this capacity standard is a target for has not been approved, so there is no "
      + "accepted line to plan against.",
      {
        capacityStandardId: String(current._id),
        lineLayoutId: String(current.lineLayoutId),
        lineLayoutStatus: layout?.status ?? null,
        boundLineLayoutRevision: current.source?.lineLayoutRevision ?? null,
      });
  }
  /* ── AND AT THAT LAYOUT'S EXACT REVISION ────────────────────────────────
     Enforced by the source-state comparison above, not by a second check here.
     `withSourceState` already compares this standard's frozen
     `source.lineLayoutRevision` with the layout's current revision and reports
     `LINE_LAYOUT_REVISION_CHANGED` when they differ — which is exactly what a
     standard built while the layout was still a draft looks like, because
     approving a layout moves its revision in the same write.

     So such a record is refused by `IE_CAPACITY_STANDARD_SOURCE_CHANGED`
     carrying that reason, the bound and current revisions and the resolution,
     and it never becomes approvable because somebody approved the layout later.
     Adding a second refusal here would be a second way of saying one thing, and
     a reader hitting one would not know the other existed. */

  /* ── AND ITS FROZEN SOURCE MUST STILL BE THAT LAYOUT'S ──────────────────
     Re-derived from the approved layout by the same helpers that froze it, field
     by field. A positive target is no evidence of anything: a tampered SAM, a
     swapped fingerprint or a rewritten row count all still produce a plausible
     number of pieces a shift, and the calculation cannot say whether it was
     calculated from this layout. */
  const mismatches = frozenSourceMismatches(current, layout, source);
  if (mismatches.length) {
    throw fail("IE_CAPACITY_STANDARD_SOURCE_CHANGED",
      `This capacity standard's frozen source no longer matches the line layout it names: `
      + `${mismatches.length} fact${mismatches.length === 1 ? "" : "s"} disagree`
      + `${mismatches.length === 1 ? "s" : ""}. The target stays as evidence of what was planned — `
      + "create a new standard from the current approved layout.",
      {
        capacityStandardId: String(current._id),
        lineLayoutId: String(current.lineLayoutId),
        reasons: [...new Set(mismatches.map((m) => m.code))],
        mismatches,
        boundLineLayoutRevision: current.source?.lineLayoutRevision ?? null,
        currentLineLayoutRevision,
        resolution: "CREATE_NEW_STANDARD_FROM_CURRENT_SOURCE",
      });
  }

  /* ── AND THE RECORD ITSELF MUST NOT BE BLOCKED ──────────────────────────
     PROVISIONAL is approvable; BLOCKED is not, and it is refused with its
     complete gap list rather than the first failure. The assumed-working-time
     gap is deliberately NOT a blocker: it is this lane's stated limitation, and
     a second person accepting the assumption is precisely what approval is. */
  const published = publishStandard(current, {
    sourceState, sourceReasons, current: source, currentLineLayoutRevision, lineLayoutStatus,
  });
  if (published.readiness.state === READINESS.BLOCKED) {
    const blocking = published.readiness.gaps.filter(
      (g) => g.code !== "IE_CAPACITY_WORKING_TIME_ASSUMED",
    );
    throw fail("IE_CAPACITY_STANDARD_NOT_APPROVABLE",
      `This capacity standard cannot be approved: ${blocking.length} thing`
      + `${blocking.length === 1 ? "" : "s"} need${blocking.length === 1 ? "s" : ""} attention.`,
      {
        capacityStandardId: String(current._id),
        readiness: published.readiness.state,
        gaps: blocking,
        gapCodes: blocking.map((g) => g.code),
      });
  }

  /* ── ONE CONDITIONAL WRITE ──────────────────────────────────────────────
     `status: "DRAFT"` and `revision: expected` together, so two simultaneous
     approvals produce exactly one winner and the loser is told which
     precondition failed. Nothing about the layout or the bulletin version is
     touched: this write cannot rebase, restate or re-approve either. */
  const nextRevision = expected + 1;
  const audit = event("CAPACITY_STANDARD_APPROVED", {
    actor,
    standardRevision: nextRevision,
    changed: ["status"],
    summary: `Approved revision ${expected} against line layout revision ${layout.revision} — `
      + `${published.calculation.available
        ? `${published.calculation.wholePieceShiftTarget} pieces a shift`
        : "no calculable target"}`
      + `, on stated working-time assumptions`,
  });

  const updated = await IeCapacityStandard.findOneAndUpdate(
    { _id: current._id, companyId: ctx.companyId, revision: expected, status: "DRAFT" },
    {
      $set: {
        status: "APPROVED",
        approvedBy: approver,
        approvedByName: actorName(actor),
        approvedAt: new Date(),
        approvedRevision: expected,
        updatedBy: actorId(actor),
        updatedByName: actorName(actor),
      },
      $inc: { revision: 1 },
      $push: { history: { $each: [audit], $slice: -LIMITS.HISTORY } },
    },
    { new: true },
  ).lean();

  if (!updated) {
    /* One company-scoped re-read to say WHICH precondition failed. */
    const now = await IeCapacityStandard.findOne({ _id: current._id, companyId: ctx.companyId })
      .select("_id revision status approvedRevision approvedByName").lean();
    if (!now) throw standardNotFound();
    if (now.status === "APPROVED") throw standardImmutable(now, "approved again");
    throw fail("IE_CAPACITY_STANDARD_REVISION_CONFLICT",
      "Somebody changed this capacity standard while you were reading it. Re-read it and decide again.",
      { expected, actual: now.revision, capacityStandardId: String(now._id) });
  }

  return {
    updated: true,
    standard: publishStandard(updated, {
      sourceState, sourceReasons, current: source, currentLineLayoutRevision, lineLayoutStatus,
      withHistory: true,
    }),
    events: [publishEvent(audit)],
  };
}

module.exports = {
  READINESS, SOURCE_STATE, SOURCE_REASON, WORKING_TIME_SOURCE, LIMITS,
  readRampSelection, sameRamp,
  CREATE_FIELDS, PATCH_FIELDS, INPUT_FIELDS, REFUSED_FIELDS,
  BLOCKING_LAYOUT_GAPS,
  publishStandard, publishEvent, readinessFor, changedGroups, readInputs, freezeSource,
  frozenSourceMismatches,
  createStandard, readStandard, listStandards, updateStandard, approveStandard,
  standardImmutable, authorOf, APPROVE_FIELDS, APPROVE_REFUSED,
};
