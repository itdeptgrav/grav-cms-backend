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
 * The inputs a drape cannot proceed without, each with the words the screen
 * uses. Declared here rather than in the UI so the list that BLOCKS a render
 * and the list a person reads are necessarily the same list.
 */
const REQUIRED_INPUTS = Object.freeze([
  {
    key: "pieces",
    label: "Pattern pieces with outlines",
    why: "There is nothing to sew without closed piece outlines.",
  },
  {
    key: "unit",
    label: "A known unit",
    why: "A pattern read as millimetres when it was drawn in inches is out by 25.4, "
      + "and nothing about the shape on screen reveals it.",
  },
  {
    key: "seamPairings",
    label: "Seam pairings",
    why: "The pattern says where the pieces are. Only a person says which edge is sewn to which, "
      + "and a simulator cannot guess it.",
  },
  {
    key: "fabrics",
    label: "Fabric settings",
    why: "How cloth hangs depends on its weight, thickness and stretch. Without them a drape is "
      + "a shape, not a garment.",
  },
  {
    key: "avatar",
    label: "Avatar or body measurements",
    why: "A garment is draped on a body. Which body changes the result.",
  },
  {
    key: "renderSize",
    label: "The size to drape",
    why: "A graded pattern holds several sizes and a drape is of exactly one.",
  },
]);

/**
 * WHICH OF THEM ARE THERE, AND WHICH ARE NOT.
 *
 * Returns the missing ones in full rather than a boolean, because the screen's
 * job is to say what is still needed — "cannot render" on its own sends
 * somebody hunting.
 */
function checkInputs(patternSet, inputs = {}) {
  const missing = [];
  const present = [];
  const has = (key, ok) => (ok ? present : missing).push(
    REQUIRED_INPUTS.find((r) => r.key === key),
  );

  const pieces = (patternSet?.pieces || []).filter((p) => (p.outline || []).length >= 3);
  has("pieces", pieces.length > 0);
  has("unit", Boolean(patternSet?.unit));
  has("seamPairings", (inputs.seamPairings || []).length > 0);
  has("fabrics", (inputs.fabrics || []).length > 0);
  has("avatar", Boolean(inputs.avatar?.name) || Object.keys(inputs.avatar?.measurements || {}).length > 0);
  has("renderSize", Boolean(inputs.renderSize));

  return {
    ready: missing.length === 0,
    missing: missing.filter(Boolean),
    present: present.filter(Boolean),
    /* Counted here so three screens cannot each count it differently. */
    pieceCount: pieces.length,
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
    message: `3D previews are simulated by ${name}.`,
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

module.exports = {
  REQUIRED_INPUTS, checkInputs,
  registerAdapter, activeAdapter, adapterStatus, submit,
  /* For tests, which need to put the registry back the way they found it. */
  __adapters: adapters,
};
