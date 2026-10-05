// services/rnd/simulationAdapter.service.js
//
// THE LINE BETWEEN "WE HAVE A PATTERN" AND "WE HAVE A GARMENT".
//
// ── WHAT A BROWSER CANNOT DO, SAID ONCE AND PROPERLY ────────────────────────
// Turning a flat pattern into a sewn, draped garment is cloth simulation: a
// seam graph, a body to drape on, fabric mechanics, collision, and a solver
// run to equilibrium. CLO does it. A browser does not, and nothing in this
// repository does either. Any code here that produced a "3D preview" from raw
// DXF would be producing a shape with no relationship to the garment, and a
// shape that LOOKS like a garment is far more dangerous than no shape at all —
// somebody would approve a sample against it.
//
// So this module is a BOUNDARY and not an implementation. It states exactly
// what a simulation engine is handed and exactly what it must return, refuses
// clearly when none is configured, and leaves the implementation to whoever
// connects CLO, Browzwear, or an in-house solver later.
//
// ── WHY REFUSING IS THE DEFAULT AND NOT AN ERROR ────────────────────────────
// A render requested with no engine configured is not a bug and not an outage.
// It is a deployment that has not been connected to one yet, and the honest
// answer is a job that fails immediately with a sentence saying so, rather
// than a job that sits queued for ever or a preview invented locally.
"use strict";

const readiness = require("./fitReadiness.service");

/**
 * WHAT AN ENGINE IS HANDED.
 *
 * Deliberately a plain object and deliberately complete: an adapter must be
 * implementable by somebody who has never read the rest of this codebase.
 *
 * @typedef {object} SimulationRequest
 * @property {string} jobRef            this system's id for the run
 * @property {string} patternRevisionRef the exact 2D revision being draped
 * @property {object} patternSet        pieces, outlines, notches, grading, unit
 * @property {object} inputs            seam pairings, fabrics, avatar, settings
 * @property {string} renderSize        which graded size to drape
 * @property {{ buffer: Buffer, name: string }|null} sourceDxf
 *           the original file, for an engine that would rather read it than
 *           this system's parse of it — which is a legitimate preference and
 *           one a good adapter should be allowed to have
 */

/**
 * WHAT AN ENGINE MUST RETURN.
 *
 * @typedef {object} SimulationResult
 * @property {"accepted"} status  the engine has taken the job
 * @property {string} externalJobId  its own id, for polling and support
 * @property {string} engine      the adapter's name
 * @property {string} version     the solver version — a garment draped by two
 *                                versions of a solver is two garments
 */

/**
 * WHAT A DRAPE NEEDS, AND WHETHER IT IS THERE.
 *
 * ── WHY THIS DELEGATES RATHER THAN CHECKS ───────────────────────────────────
 * It used to hold its own list of six presence checks, one of which was
 * `(inputs.fabrics || []).length > 0` — a profile with every number at zero
 * passed it. Worse, the SCREEN had its own idea of readiness, so a reader could
 * be shown an enabled "Drape this revision" and then refused, which teaches
 * somebody to distrust the screen rather than the pattern.
 *
 * There is now one implementation, in `fitReadiness.service.js`, built against
 * the product contracts in `docs/product/rnd-fit/`. This function is the shape
 * the render service and the routes already expect, computed from it — and the
 * frontend renders the same object rather than deriving anything of its own.
 *
 * @param {object} patternSet the parse
 * @param {object} inputs     `simulationInputs`
 * @param {object} opts       { revisionRef, mappingConfirmedAgainstRef }
 */
function checkInputs(patternSet, inputs = {}, opts = {}) {
  const result = readiness.assess(patternSet, inputs, opts);

  /* `missing` is kept because `requestRender` composes a sentence from it, and
     because a caller that only wants "what is left" should not have to walk
     failures. One entry per step that is not done, in the step's own words. */
  const missing = result.steps
    .filter((step) => !step.done)
    .map((step) => ({
      key: step.key,
      label: step.label,
      why: step.failures[0]?.message || "",
      codes: [...new Set(step.failures.map((f) => f.code))],
    }));

  return {
    ...result,
    missing,
    present: result.steps.filter((step) => step.done).map((step) => ({
      key: step.key, label: step.label, detail: step.detail,
    })),
    /* Counted here so three screens cannot each count it differently. */
    pieceCount: result.pieceCount,
  };
}

/* ═══ THE ADAPTER REGISTRY ════════════════════════════════════════════════
 *
 * One named adapter at a time, chosen by `RND_SIMULATION_ADAPTER`. Registered
 * rather than imported so connecting an engine is one call in one place and
 * needs no change to the render service.
 */
const adapters = new Map();

/**
 * @param {string} name
 * @param {{ version: string, submit: (req: SimulationRequest) => Promise<SimulationResult>,
 *           poll?: (externalJobId: string) => Promise<object> }} adapter
 */
function registerAdapter(name, adapter) {
  if (!name || typeof adapter?.submit !== "function") {
    throw new Error("A simulation adapter needs a name and a submit function.");
  }
  adapters.set(name, adapter);
}

const configuredName = () => String(process.env.RND_SIMULATION_ADAPTER || "").trim();

/**
 * The engine this deployment is connected to, or null.
 *
 * Null is a normal answer. The caller turns it into a job that fails with a
 * sentence, which is the truthful outcome — not a queue that never drains.
 */
function activeAdapter() {
  const name = configuredName();
  if (!name) return null;
  return adapters.get(name) || null;
}

/** What the screen says about rendering, before anybody presses anything. */
function adapterStatus() {
  const name = configuredName();
  if (!name) {
    return {
      configured: false,
      name: "",
      message: "No simulation engine is connected to this deployment, so a 3D preview cannot be "
        + "generated here yet. The pattern is unaffected: it is the design, and it is complete "
        + "without a preview.",
    };
  }
  const adapter = adapters.get(name);
  if (!adapter) {
    return {
      configured: false,
      name,
      message: `This deployment names "${name}" as its simulation engine, but no adapter by that `
        + "name is registered. A 3D preview cannot be generated until it is.",
    };
  }
  return {
    configured: true,
    name,
    version: adapter.version || "",
    runsInBrowser: Boolean(adapter.runsInBrowser),
    message: adapter.runsInBrowser
      ? `3D previews are draped by the ${adapter.label || name} in this browser. `
        + (adapter.description || "")
      : `3D previews are simulated by ${name}.`,
  };
}

/**
 * Hand a job to the engine.
 *
 * Throws nothing of its own: every outcome, including "there is no engine", is
 * returned as a result the render service records on the job. A render failing
 * is ordinary and belongs in the job's history, not in a stack trace.
 */
async function submit(request) {
  const adapter = activeAdapter();
  if (!adapter) {
    const status = adapterStatus();
    return {
      status: "unavailable",
      code: "SIMULATION_ENGINE_NOT_CONNECTED",
      message: status.message,
    };
  }
  try {
    const out = await adapter.submit(request);
    return {
      status: "accepted",
      externalJobId: String(out?.externalJobId || ""),
      engine: configuredName(),
      version: String(out?.version || adapter.version || ""),
    };
  } catch (err) {
    return {
      status: "failed",
      code: "SIMULATION_ENGINE_REFUSED",
      message: `The simulation engine refused this job: ${err?.message || "no reason given"}`,
    };
  }
}

/* ═══ THE ONE THAT SHIPS ══════════════════════════════════════════════════
 *
 * Registered here rather than in server.js so that it is present wherever this
 * service is — including in tests, which otherwise test a registry the running
 * application does not have. It is still only USED when
 * `RND_SIMULATION_ADAPTER=in-app`, so a deployment that has not chosen an engine
 * still refuses renders with a sentence, exactly as before.
 */
const { inAppSolver } = require("./adapters/inAppSolver.adapter");

registerAdapter("in-app", inAppSolver);

/** Adapters whose solving happens in the requesting browser. */
const runsInBrowser = () => Boolean(activeAdapter()?.runsInBrowser);

module.exports = {
  checkInputs,
  /* Re-exported so a caller that has a readiness result does not need to know
     which module produced it. */
  assess: readiness.assess, STEP_KEYS: readiness.STEP_KEYS,
  registerAdapter, activeAdapter, adapterStatus, submit, runsInBrowser,
  /* For tests, which need to put the registry back the way they found it. */
  __adapters: adapters,
};
