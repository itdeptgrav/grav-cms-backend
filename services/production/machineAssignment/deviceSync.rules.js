// services/production/machineAssignment/deviceSync.rules.js
//
// DEVICE SYNCHRONISATION — bringing a scanner to the database assignment
// without ever guessing what it is running. Pure: no database, no clock.
//
// ── THE CONTRACT REUSED, EXACTLY (firmware 5.6.x, GRAV_Scanner_v5_5_0.ino) ──
//   `ops:CODE`            toggleOperation(CODE): if an active op equals CODE
//                         (equalsIgnoreCase) it is REMOVED, otherwise ADDED —
//                         unless the device already holds MAX_ACTIVE_OPS (8),
//                         in which case the add silently fails.
//   `opsgp:A,B,C`         toggleGroupOps: each comma-separated, trimmed code is
//                         toggled IN ORDER, at most 8 per barcode (extra ones
//                         are ignored by extractGroupOps).
//   The scanned string is only trimmed; the `ops:`/`opsgp:` prefix is matched
//   case-sensitively, the codes case-insensitively. There is no revision, id
//   or checksum in the format, and the firmware must not change.
//
// ── WHY A BARCODE IS NEVER BUILT FROM THE ASSIGNMENT ALONE ──────────────────
// Every scan TOGGLES. Scanning the desired code on a device that already has
// it switches it OFF. So a payload is built only from a FRESH observation of
// the device's current codes (a heartbeat causally newer than the
// assignment's commit and within the freshness threshold), as the symmetric difference
// between observed and desired — removals first, so the 8-op ceiling can
// never swallow an add — and nothing is issued when the observation is
// missing, stale, not causally post-commit, ambiguous (two scanners on one
// machine disagreeing) or holds a code this machine was never assigned.
//
// ── CAUSAL EVIDENCE, NOT TIMESTAMPS ─────────────────────────────────────────
// Every accepted heartbeat atomically increments its document's server-owned
// `evidenceRevision` (the ingest route; never sent by the device). After an
// assignment revision's commit is KNOWN, the service captures every heartbeat
// document then associated with the machine and its revision — the
// `evidenceBaseline`. A heartbeat is evidence of the scanner's post-commit
// state only if its revision is STRICTLY GREATER than its device's baseline
// (0 for a device not in the baseline; a historical document without the field
// is 0 too, so it needs one more heartbeat). Such a heartbeat was ingested
// after the capture, and so after the commit. Timestamps are used only for
// freshness and display: clocks cannot prove that ordering. No baseline, or
// no qualifying heartbeat → nothing observed: no barcode, never `applied`.
//
// ── HEARTBEATS ARE EVIDENCE, NEVER AUTHORITY ────────────────────────────────
// Nothing here chooses or changes an assignment. A heartbeat only answers
// "what is this scanner running now?", and only `applied` — a qualifying
// heartbeat (newer evidence revision than the baseline, and than any
// instruction) that exactly matches — claims the device is in step.
"use strict";

const crypto = require("crypto");
const { SYNC_STATUS, ASSIGNMENT_LIMITS } = require("../../../models/CMS_Models/Inventory/Configurations/machineProductionAssignment.schema");

const MAX_CODES_PER_BARCODE = 8; // extractGroupOps(maxOps = MAX_ACTIVE_OPS)
const DEVICE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,31}$/; // no comma, space or colon: they would split or corrupt a payload

const normCode = (c) => String(c ?? "").trim().toLowerCase();
const timeOf = (v) => (v == null ? NaN : new Date(v).getTime());

function validDeviceCode(code) {
  return DEVICE_CODE_PATTERN.test(String(code ?? "").trim());
}

/** Two code lists are the same device state (case-insensitive sets, no duplicates). */
function sameCodes(a, b) {
  const A = (a || []).map(normCode);
  const B = (b || []).map(normCode);
  if (new Set(A).size !== A.length || new Set(B).size !== B.length) return false;
  if (A.length !== B.length) return false;
  const setB = new Set(B);
  return A.every((c) => setB.has(c));
}

const revisionOf = (h) => (Number.isInteger(h?.evidenceRevision) && h.evidenceRevision >= 0 ? h.evidenceRevision : 0);

/** A baseline as a lookup: deviceId → revision captured after the commit. */
function baselineMap(baseline) {
  if (!baseline || !Array.isArray(baseline.devices)) return null;
  const m = new Map();
  for (const d of baseline.devices) m.set(String(d.deviceId), Number(d.evidenceRevision) || 0);
  return m;
}

/**
 * What ONE machine's scanner is running, from heartbeats that are causally
 * newer than the post-commit baseline — or why that cannot be known.
 */
function observeDevice(heartbeats, { machineId, baseline, now, staleMs }) {
  const base = baselineMap(baseline);
  if (!base) return { ok: false, reason: "evidence_baseline_not_established" };
  const nowMs = timeOf(now);
  const mine = (heartbeats || []).filter((h) => h?.machineId && String(h.machineId) === String(machineId) && Number.isFinite(timeOf(h.lastHeartbeatAt)));
  if (!mine.length) return { ok: false, reason: "no_heartbeat" };
  const qualifying = mine.filter((h) => revisionOf(h) > (base.get(String(h.deviceId || "")) ?? 0));
  if (!qualifying.length) return { ok: false, reason: "no_heartbeat_since_assignment_commit" };
  // Freshness is still a clock question: is the device reporting NOW?
  const fresh = qualifying.filter((h) => nowMs - timeOf(h.lastHeartbeatAt) <= staleMs);
  if (!fresh.length) return { ok: false, reason: "heartbeat_stale" };
  const parsed = fresh.map((h) => ({
    deviceId: String(h.deviceId || ""),
    heartbeatAt: new Date(h.lastHeartbeatAt),
    evidenceRevision: revisionOf(h),
    codes: (Array.isArray(h.activeOps) ? h.activeOps : String(h.activeOps || "").split(",")).map((c) => String(c).trim()).filter(Boolean),
  }));
  if (parsed.some((p) => p.codes.some((c) => !validDeviceCode(c)) || new Set(p.codes.map(normCode)).size !== p.codes.length)) {
    return { ok: false, reason: "heartbeat_codes_unparseable" };
  }
  // Two live scanners on one machine that disagree: which one is "the device"?
  if (parsed.length > 1 && !parsed.every((p) => sameCodes(p.codes, parsed[0].codes))) {
    return { ok: false, reason: "multiple_devices_disagree" };
  }
  const newest = parsed.sort((a, b) => b.heartbeatAt - a.heartbeatAt || b.evidenceRevision - a.evidenceRevision)[0];
  return { ok: true, ...newest };
}

/**
 * The toggles that take `observed` to `desired`, or why that would be unsafe.
 * `knownCodes`: every code this machine was ever assigned (current and prior);
 * an observed code outside it is UNMAPPED — somebody set it outside the
 * system, and switching it off could stop real work, so nothing is issued.
 */
function computeDelta(observed, desired, knownCodes = []) {
  const obs = observed.map((c) => String(c).trim());
  const des = desired.map((c) => String(c).trim());
  const desSet = new Set(des.map(normCode));
  const obsSet = new Set(obs.map(normCode));
  const known = new Set([...knownCodes, ...des].map(normCode));
  const remove = obs.filter((c) => !desSet.has(normCode(c)));
  const add = des.filter((c) => !obsSet.has(normCode(c)));
  const unmapped = remove.filter((c) => !known.has(normCode(c)));
  if (unmapped.length) return { safe: false, reason: "unmapped_observed_codes", unmapped, remove, add };
  if (des.length > ASSIGNMENT_LIMITS.DEVICE_CODES) return { safe: false, reason: "desired_exceeds_device_capacity", remove, add };
  const toggles = [...remove.map((code) => ({ code, action: "remove" })), ...add.map((code) => ({ code, action: "add" }))];
  return { safe: true, toggles, remove, add };
}

/**
 * Barcode texts in the EXISTING format, preserving order: a single toggle is
 * `ops:CODE`, several are `opsgp:A,B`, at most 8 per barcode. When more than
 * one barcode is needed they must be scanned in the order given.
 */
function payloadsFor(toggles) {
  const out = [];
  for (let i = 0; i < toggles.length; i += MAX_CODES_PER_BARCODE) {
    const chunk = toggles.slice(i, i + MAX_CODES_PER_BARCODE).map((t) => t.code);
    out.push(chunk.length === 1 ? `ops:${chunk[0]}` : `opsgp:${chunk.join(",")}`);
  }
  return out;
}

/** Deterministic: the same revision, device observation and toggles → the same instruction. */
function instructionIdOf({ machineId, revision, deviceId, evidenceRevision, toggles }) {
  const basis = [machineId, revision, deviceId, evidenceRevision, toggles.map((t) => `${t.action}:${normCode(t.code)}`).join("|")].join("#");
  return `SYNC-${crypto.createHash("sha256").update(basis).digest("hex").slice(0, 20)}`;
}

/**
 * The next synchronisation state for the CURRENT assignment revision.
 *
 * @param sync        stored productionDeviceSync (must be for `revision`)
 * @param options     { machineId, revision, heartbeats, knownCodes, now, staleMs, reissue }
 *                    `reissue`: an explicit request for a fresh instruction —
 *                    the only way out of `drift` other than a matching heartbeat.
 */
function evaluateSync(sync, { machineId, revision, heartbeats, knownCodes, now, staleMs, reissue = false }) {
  if (!sync || sync.forRevision !== revision) throw new Error("device sync state is not for the current assignment revision");
  const at = new Date(now);
  const base = { ...sync, lastEvaluatedAt: at, lastError: "" };
  const obs = observeDevice(heartbeats, { machineId, baseline: sync.evidenceBaseline, now, staleMs });
  const instruction = sync.instruction || null;
  const acked = Boolean(instruction?.acknowledgedAt);

  if (!obs.ok) {
    if (acked) return { ...base, status: SYNC_STATUS.AWAITING_CONFIRMATION, reasons: [obs.reason] };
    // An unacknowledged instruction built on an observation we can no longer
    // vouch for is withdrawn: nothing destructive is left on screen.
    return { ...base, status: SYNC_STATUS.PENDING_DEVICE_STATE, reasons: [obs.reason], instruction: undefined };
  }

  const observed = { deviceId: obs.deviceId, heartbeatAt: obs.heartbeatAt, evidenceRevision: obs.evidenceRevision, codes: obs.codes };
  if (sameCodes(obs.codes, sync.desiredCodes)) {
    return { ...base, observed, status: SYNC_STATUS.APPLIED, reasons: [], instruction: undefined,
      appliedRevision: revision, appliedAt: obs.heartbeatAt };
  }

  // "Newer" is causal: a later evidence revision of the device, or another device.
  const newerThanInstruction = instruction && (obs.deviceId !== instruction.deviceId
    || obs.evidenceRevision > Number(instruction.observedEvidenceRevision));
  const wasSettled = sync.status === SYNC_STATUS.APPLIED || sync.status === SYNC_STATUS.DRIFT;

  if (acked && !newerThanInstruction) {
    return { ...base, observed, status: SYNC_STATUS.AWAITING_CONFIRMATION, reasons: ["waiting_for_newer_heartbeat"] };
  }
  if ((acked && newerThanInstruction) || (wasSettled && !reissue)) {
    // A newer heartbeat that does not match: the scan did not land as planned,
    // or the device was changed afterwards. Report; do not auto-issue.
    return { ...base, observed, status: SYNC_STATUS.DRIFT, reasons: ["observed_codes_differ_from_desired"], instruction: undefined,
      appliedRevision: null, appliedAt: null };
  }
  if (instruction && !newerThanInstruction) {
    return { ...base, observed, status: SYNC_STATUS.READY_TO_SYNC, reasons: [] }; // idempotent: same instruction
  }

  const delta = computeDelta(obs.codes, sync.desiredCodes, knownCodes);
  if (!delta.safe) {
    return { ...base, observed, status: SYNC_STATUS.DRIFT, reasons: [delta.reason, ...(delta.unmapped || []).map((c) => `unmapped:${c}`)],
      instruction: undefined, appliedRevision: null, appliedAt: null };
  }
  const next = {
    instructionId: instructionIdOf({ machineId, revision, deviceId: obs.deviceId, evidenceRevision: obs.evidenceRevision, toggles: delta.toggles }),
    forRevision: revision,
    deviceId: obs.deviceId,
    observedHeartbeatAt: obs.heartbeatAt,
    observedEvidenceRevision: obs.evidenceRevision,
    toggles: delta.toggles,
    payloads: payloadsFor(delta.toggles),
    issuedAt: at,
    acknowledgedAt: null,
  };
  return { ...base, observed, status: SYNC_STATUS.READY_TO_SYNC, reasons: [], instruction: next, appliedRevision: null, appliedAt: null };
}

/**
 * The sync state written INSIDE the assignment transaction. It has no evidence
 * baseline yet — that is captured only after the commit is known.
 */
function initialSync({ revision, desiredCodes, productionAssigned, transitionAt }) {
  return {
    forRevision: revision,
    desiredCodes,
    productionAssigned,
    transitionAt,
    evidenceBaseline: null,
    confirmationBoundaryAt: null,
    status: SYNC_STATUS.PENDING_DEVICE_STATE,
    reasons: ["evidence_baseline_not_established"],
    appliedRevision: null,
    appliedAt: null,
    lastEvaluatedAt: null,
    lastError: "",
  };
}

module.exports = {
  MAX_CODES_PER_BARCODE,
  DEVICE_CODE_PATTERN,
  normCode,
  validDeviceCode,
  sameCodes,
  observeDevice,
  baselineMap,
  computeDelta,
  payloadsFor,
  instructionIdOf,
  evaluateSync,
  initialSync,
};
