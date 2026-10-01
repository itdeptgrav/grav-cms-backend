// services/rnd/adapters/inAppSolver.adapter.js
//
// THE SOLVER THIS REPOSITORY HAS, AS AN ADAPTER LIKE ANY OTHER.
//
// ── WHAT IS DIFFERENT ABOUT IT ──────────────────────────────────────────────
// Every other adapter the boundary was designed for hands the job to something
// else — CLO on a workstation, a render farm, a vendor's API — and the arithmetic
// happens over there. This one hands it to the browser that asked for it. The
// cloth solver lives in `grav-cms/components/rnd/fit/`, runs in a Worker on the
// reader's own machine, and reports back through the ordinary outcome route.
//
// So `submit` has almost nothing to do: there is nothing to upload and nothing
// to poll. It accepts the job, names itself and its solver version, and the
// page takes it from there.
//
// ── WHY THAT IS STILL AN ADAPTER AND NOT A SHORTCUT ─────────────────────────
// Because the thing that matters about the boundary is not where the solving
// happens. It is that the JOB is a server-side record: minted here, moved to
// `simulating` here, and only ever finished by a reported outcome. A tab that is
// closed mid-drape leaves a job that never reported — visible, and clearable —
// rather than a preview that silently never existed. And the day a real engine
// is connected, this adapter is deselected by changing one environment variable;
// nothing about the render service, the routes or the screens changes.
//
// ── AND WHY IT DOES NOT PRETEND TO BE CLO ───────────────────────────────────
// It is a fast approximate cloth solve on a capsule body built from
// measurements, in a browser. It is good enough to read a PATTERN from — does
// this seam close, is this panel on the grain, is there ease where ease was
// intended — and it is not a production-accurate drape, and the version string
// it reports is what ties a given picture to the arithmetic that made it.
"use strict";

/** Bumped whenever the browser solver changes in a way that moves vertices. */
const SOLVER_VERSION = "fit-1.0";

const inAppSolver = {
  version: SOLVER_VERSION,
  /* Said in the adapter so one sentence covers every screen that mentions it. */
  label: "In-app cloth solver",
  description:
    "Drapes the pattern in this browser. Good enough to read the pattern from — whether the seams "
    + "close, where the cloth is under tension, how much ease there is — and not a replacement for "
    + "a production drape in CLO.",
  /* The page is what does the work, so the server must not wait for it. */
  runsInBrowser: true,

  async submit(request) {
    if (!request?.jobRef) throw new Error("a job reference is required");
    const pieces = (request.patternSet?.pieces || []).filter((p) => (p.outline || []).length >= 3);
    if (!pieces.length) throw new Error("the pattern has no piece outlines to sew");
    if (!(request.inputs?.seamPairings || []).length) {
      throw new Error("no seam has been mapped, so there is nothing to sew");
    }
    /* Its own id IS the job ref: there is no second system holding a second id,
       and inventing one would imply there were. */
    return { externalJobId: request.jobRef, version: SOLVER_VERSION };
  },
};

module.exports = { inAppSolver, SOLVER_VERSION };
