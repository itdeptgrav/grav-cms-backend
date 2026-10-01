"use strict";
/**
 * services/ai/openJev/diagnosticsVisibility.js — who may see the pilot's
 * routing diagnostics.
 *
 * The panel shows which candidates were offered, which Jev chose, its
 * probability and margin, and three latencies. None of that is accounting data
 * — the whole design keeps records away from the model — but it is the internal
 * shape of a permission system, and a list of the tools a user was offered is a
 * map of what else exists to ask for. So it is not sent to ordinary users.
 *
 * Two ways in, both deliberate:
 *   • outside production, because this is a development-and-evaluation mode and
 *     the developer running it is the audience;
 *   • a platform admin, because someone has to be able to look at a real
 *     deployment without redeploying it in development mode.
 *
 * Neither is a substitute for the pilot being off by default: with
 * `GRAV_OPEN_JEV_MODE` unset there are no diagnostics to show anybody.
 */

function maySeePilotDiagnostics(user, env = process.env) {
  if (String(env.NODE_ENV || "").trim().toLowerCase() !== "production") return true;
  return Boolean(user && user.isAdmin === true);
}

module.exports = { maySeePilotDiagnostics };
