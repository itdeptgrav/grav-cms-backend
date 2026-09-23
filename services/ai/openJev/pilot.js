"use strict";
/**
 * services/ai/openJev/pilot.js — the ONE entry point gravAssistant calls.
 *
 * Returns `null` to mean "carry on exactly as before" — the existing Ollama
 * tool-selection round and regex fallback. It returns null when:
 *   • the pilot flag is off (the default — nothing else is loaded or run);
 *   • the user is not authorised for anything the pilot could route to;
 *   • Open-Jev is unreachable, times out, returns an invalid body, chooses
 *     other/unclear/leave, or is below the pre-registered thresholds;
 *   • GRAV's own reading of the question sends it back (another day, a group,
 *     the user themselves, leave, no person named);
 *   • anything throws.
 *
 * Order of authority, which the tests pin:
 *   1. GRAV decides what the user may be offered (authorizeHr, before the model).
 *   2. Open-Jev suggests an intent among those offers.
 *   3. GRAV re-authorises (after the model, independently of it), resolves the
 *      person, reads the attendance record and writes the answer.
 * The model's probability is recorded for evaluation and never shown to the
 * user, never used as a fact and never used to grant access.
 */

const { openJevConfig } = require("./config");

// HR capabilities the pilot's read needs: see the person in the directory AND
// read their attendance. The same pair the mounted attendance routes demand.
function pilotCapabilities() {
  const { CAPABILITIES } = require("../../access/hrCapabilities");
  return [CAPABILITIES.PEOPLE_READ_DIRECTORY, CAPABILITIES.ATTENDANCE_READ];
}

async function mayReadAttendance(user) {
  const { authorizeHr } = require("../../access/hrAuthorization");
  if (!user || !user.hrActor) return false;
  const d = await authorizeHr({ user, capabilities: pilotCapabilities(), scope: "hr", actor: user.hrActor });
  return d.allowed === true;
}

function mayReadLeave(user) {
  const { getTool } = require("../toolRegistry");
  const t = getTool("hr_leave");
  try {
    return Boolean(t && t.permission(user) === true);
  } catch {
    return false;
  }
}

function logRoute(route, extra = {}) {
  // Never the message, never a name, never the evidence packet.
  console.info(
    "[AI] open-jev route",
    JSON.stringify({
      status: route.status,
      reason: route.reason || null,
      accepted: route.accepted === true,
      intent: route.intent || null,
      probability: typeof route.probability === "number" ? Number(route.probability.toFixed(4)) : null,
      margin: typeof route.margin === "number" ? Number(route.margin.toFixed(4)) : null,
      routeLatencyMs: route.latencyMs,
      model: route.provenance ? route.provenance.model : null,
      checkpoint: route.provenance ? route.provenance.checkpointSha256 : null,
      ...extra,
    }),
  );
}

/** What GRAV will offer the router for this user — decided before any model. */
async function offerFor(user) {
  return { attendanceToday: await mayReadAttendance(user), leaveToday: mayReadLeave(user) };
}

/**
 * GRAV's step AFTER a router has suggested an intent. Shared by the live pilot
 * and the offline evaluation so both exercise the same code. Only
 * `attendance_today` has an executor; every other intent defers.
 */
async function executeRoutedIntent({ user, message, intent, ports, now, staleMinutes }) {
  const { answerAttendanceToday, OUTCOME } = require("./attendanceToday");
  if (intent !== "attendance_today") return { outcome: OUTCOME.DEFER, reason: "intent_not_executable" };
  // Re-authorise independently of anything the router returned.
  if (!(await mayReadAttendance(user))) return { outcome: OUTCOME.DEFER, reason: "reauthorisation_denied" };
  return answerAttendanceToday({ message, ports, now, staleMinutes });
}

/**
 * @param {object} input
 * @param {object} input.user
 * @param {string} input.message
 * @param {(user:object)=>Promise<void>} input.ensureAccess   gravAssistant's
 * @param {object} [deps]   test/evaluation seams: { config, fetchImpl, ports, now, log }
 * @returns {Promise<null | {reply:string, model:string, toolsUsed:string[], pilot:object}>}
 */
async function tryOpenJevPilot({ user, message, ensureAccess }, deps = {}) {
  const cfg = deps.config || openJevConfig();
  if (!cfg.enabled) return null;
  const log = deps.log || logRoute;
  try {
    if (typeof ensureAccess === "function") await ensureAccess(user);

    const offer = await offerFor(user);
    const { routeIntent } = require("./intentRouter");
    const route = await routeIntent({ message, offer }, cfg, deps.fetchImpl);
    if (!route.accepted) {
      log(route);
      return null;
    }

    const { OUTCOME } = require("./attendanceToday");
    const ports = deps.ports || require("./mongoPorts").mongoPorts();
    const started = Date.now();
    const r = await executeRoutedIntent({
      user,
      message,
      intent: route.intent,
      ports,
      now: deps.now ? deps.now() : new Date(),
      staleMinutes: cfg.staleMinutes,
    });
    log(route, { grav: r.outcome, gravReason: r.reason || null, gravLatencyMs: Date.now() - started });
    if (r.outcome === OUTCOME.DEFER || !r.reply) return null;

    return {
      reply: r.reply,
      model: "grav-attendance-evidence",
      toolsUsed: ["hr_attendance_today"],
      pilot: {
        router: "open-jev",
        intent: route.intent,
        outcome: r.outcome,
        evidenceSchema: r.evidence ? r.evidence.schema : null,
        provenance: route.provenance || null,
      },
    };
  } catch (err) {
    console.warn("[AI] open-jev pilot fell back:", err && err.name ? err.name : "error");
    return null;
  }
}

module.exports = { tryOpenJevPilot, executeRoutedIntent, offerFor, mayReadAttendance };
