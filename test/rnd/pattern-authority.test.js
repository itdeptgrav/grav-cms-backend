// test/rnd/pattern-authority.test.js
//
// THE PATTERN IS THE GARMENT. THE 3D IS A PICTURE OF IT.
//
// ── WHAT THESE TESTS ARE REALLY PROTECTING ──────────────────────────────────
// An inversion is only real if it cannot be undone by accident. Four claims
// carry the whole architecture, and each of them is one careless function away
// from being false:
//
//   · an approved revision is never written to — something was cut to it;
//   · every edit, however small, produces a new revision with a parent;
//   · a preview names the exact revision it is of, for ever;
//   · nothing in the 3D half can reach a pattern.
//
// The last is the one worth the most. A measurement or a marker that could
// change a pattern would make the 2D record a consequence of the 3D one, which
// is the arrangement this whole slice exists to reverse.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const mongoose = require("mongoose");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Account = require("../../models/CMS_Models/Sales/Account");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const { PatternRevision, RenderJob, REVISION_STATE, RENDER_STATUS } =
  require("../../models/CMS_Models/RnD/PatternRevision");
const { GarmentModelPublication } = require("../../models/CMS_Models/RnD/GarmentModel");

const patterns = require("../../services/rnd/patternRevision.service");
const renders = require("../../services/rnd/garmentRender.service");
const simulation = require("../../services/rnd/simulationAdapter.service");

let seq = 0;

/** A style, and the two people a maker-checker rule needs. */
async function world() {
  const n = ++seq;
  const co = await Acc_Company.create({ companyName: `Pattern Co ${n}`, booksFromDate: new Date("2026-04-01") });
  const account = await Account.create({ companyName: `Buyer ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-PR-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-PR-${n}`, styleCode: `SC-PR-${n}`, productName: "Shirt",
    journeyId: journey._id, accountId: account._id, stage: "rnd", techSheet: { status: "pending" },
  });
  return {
    co, style,
    ctx: { companyId: co._id },
    drafter: { id: `d${n}`, name: "A Patternmaker", email: `draft${n}@grav.test` },
    checker: { id: `c${n}`, name: "A Checker", email: `check${n}@grav.test` },
  };
}

/* ── THE PATTERN THESE TESTS USE ──────────────────────────────────────────
   Shared with every other R&D suite rather than declared here. The version that
   lived in this file was two squares and a seam pairing that named no edges at
   all, which made it a fixture that declared a pattern renderable when a drape
   could not have sewn it. */
const tee = require("./fixtures/renderableTee");

/** A plain rectangle, for the edit tests that only need some geometry to move. */
const square = (x, y, w, h) => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
];

const patternSet = (over = {}) => tee.patternSet(over);
const READY_INPUTS = tee.simulationInputs();

async function imported(w, over = {}) {
  const out = await patterns.importRevision(w.ctx, {
    styleId: w.style._id,
    patternSet: patternSet(over.patternSet || {}),
    sourceDxf: { driveFileId: "drv-1", name: "shirt.dxf", sha256: "a".repeat(64), bytes: 4096 },
    name: "Imported from CAD",
    actor: w.drafter,
  });
  return out.revision;
}

/** Give a revision everything a drape needs, so a render can be requested. */
async function madeRenderable(w, revision) {
  const out = await patterns.setSimulationInputs(w.ctx, {
    revisionId: revision.id, inputs: READY_INPUTS, actor: w.drafter,
  });
  return out.revision;
}

const refuses = async (fn, code) => {
  try { await fn(); } catch (err) { expect(err.code).toBe(code); return err; }
  throw new Error(`expected a ${code} refusal and nothing was refused`);
};

/* ═══ 1 · IMPORT ══════════════════════════════════════════════════════════ */

describe("importing a pattern starts the record", () => {
  test("a DXF parse becomes revision 1, as a draft", async () => {
    const w = await world();
    const r = await imported(w);
    expect(r.revisionNumber).toBe(1);
    expect(r.state).toBe(REVISION_STATE.DRAFT);
    expect(r.origin).toEqual({ kind: "dxf-import", parentRevisionRef: "" });
    expect(r.pieceCount).toBe(4);
    expect(r.unit).toBe("mm");
  });

  test("the file the pattern room sent is kept, and says which revision imported it", () => {
    /* The parse is this system's reading; the file is what was sent. When they
       disagree the file wins, and the only way to settle it is to still have it. */
    return world().then(async (w) => {
      const r = await imported(w);
      expect(r.sourceDxf.name).toBe("shirt.dxf");
      expect(r.sourceDxf.sha256).toHaveLength(64);
      expect(r.sourceDxf.importedInRevisionRef).toBe(r.revisionRef);
      /* Never a storage id — the file is reached through a signed link. */
      expect(JSON.stringify(r.sourceDxf)).not.toContain("drv-1");
      expect(r.sourceDxf.held).toBe(true);
    });
  });

  test("a file with no pieces is refused rather than stored as an empty pattern", async () => {
    const w = await world();
    await refuses(() => patterns.importRevision(w.ctx, {
      styleId: w.style._id, patternSet: patternSet({ pieces: [] }), actor: w.drafter,
    }), "PATTERN_UNREADABLE");
  });

  test("another company's style cannot be imported into", async () => {
    const mine = await world();
    const theirs = await world();
    await refuses(() => patterns.importRevision(mine.ctx, {
      styleId: theirs.style._id, patternSet: patternSet(), actor: mine.drafter,
    }), "NOT_FOUND");
  });
});

/* ═══ 2 · EVERY EDIT IS A REVISION ════════════════════════════════════════ */

describe("an edit never changes the thing it was made from", () => {
  test("a rename produces revision 2 and leaves revision 1 exactly as it was", async () => {
    const w = await world();
    const first = await imported(w);
    const out = await patterns.editRevision(w.ctx, {
      revisionId: first.id,
      operations: [{ kind: "rename", pieceRef: "PC-FRONT", name: "Front panel" }],
      actor: w.drafter,
    });
    const second = out.revision;

    expect(second.revisionNumber).toBe(2);
    expect(second.origin).toEqual({ kind: "edit", parentRevisionRef: first.revisionRef });
    expect(second.patternSet.pieces[0].name).toBe("Front panel");

    const reread = await patterns.readRevision(w.ctx, { revisionId: first.id });
    expect(reread.revision.patternSet.pieces[0].name).toBe("Front");
    expect(reread.revision.revisionNumber).toBe(1);
  });

  test("the edit is described in words a reviewer can read", async () => {
    const w = await world();
    const first = await imported(w);
    const out = await patterns.editRevision(w.ctx, {
      revisionId: first.id,
      operations: [{ kind: "seam-allowance", pieceRef: "PC-BACK", seamAllowance: 12 }],
      actor: w.drafter,
    });
    const [edit] = out.revision.edits;
    expect(edit.kind).toBe("seam-allowance");
    expect(edit.pieceName).toBe("Back");
    expect(edit.summary).toMatch(/Seam allowance on "Back" set to 12 mm/);
    expect(edit.by).toBe("A Patternmaker");
  });

  test("a reshape records how far anything actually moved", async () => {
    /* "Edited" tells a reviewer nothing. A nudge and a redraw are different
       things and the summary has to separate them. */
    const w = await world();
    const first = await imported(w);
    /* The fixture's own front panel, with one point nudged 5mm. Rebuilding it as
       a plain square here would be measuring a reshape of the whole piece. */
    const moved = tee.bodyOutline(0, tee.BODY_W, tee.BODY_H);
    moved[2] = { x: moved[2].x + 3, y: moved[2].y + 4 };
    const out = await patterns.editRevision(w.ctx, {
      revisionId: first.id,
      operations: [{ kind: "outline", pieceRef: "PC-FRONT", outline: moved }],
      actor: w.drafter,
    });
    expect(out.revision.edits[0].summary).toMatch(/largest move 5\.00/);
    expect(out.revision.edits[0].after.points).toBe(8);
  });

  test("every kind of edit the brief names is supported", async () => {
    const w = await world();
    let current = await imported(w);
    const ops = [
      { kind: "rename", pieceRef: "PC-FRONT", name: "Front panel" },
      { kind: "metadata", pieceRef: "PC-FRONT", quantity: 4, material: "Poplin" },
      { kind: "seam-allowance", pieceRef: "PC-FRONT", seamAllowance: 15 },
      { kind: "notches", pieceRef: "PC-FRONT", notches: [{ at: { x: 0, y: 200 } }, { at: { x: 0, y: 600 } }] },
      { kind: "internal-lines", pieceRef: "PC-FRONT", internalLines: [{ points: [{ x: 50, y: 50 }, { x: 550, y: 50 }] }] },
      { kind: "grading", pieceRef: "PC-FRONT", gradePoints: [{ x: 0, y: 0 }] },
      { kind: "outline", pieceRef: "PC-BACK", outline: square(700, 0, 640, 800) },
    ];
    for (const op of ops) {
      const out = await patterns.editRevision(w.ctx, {
        revisionId: current.id, operations: [op], actor: w.drafter,
      });
      current = out.revision;
    }
    expect(current.revisionNumber).toBe(1 + ops.length);
    const front = current.patternSet.pieces.find((p) => p.pieceRef === "PC-FRONT");
    expect(front.name).toBe("Front panel");
    expect(front.quantity).toBe(4);
    expect(front.seamAllowance.value).toBe(15);
    expect(front.notches).toHaveLength(2);
    expect(front.internalLines).toHaveLength(1);
    expect(front.gradePoints).toHaveLength(1);
  });

  test("a rename makes the name a person's choice, not the exporter's", async () => {
    const w = await world();
    const first = await imported(w, { patternSet: { pieces: [{
      pieceRef: "PC-X", index: 0, name: "Pattern_636968", generatedName: true,
      outline: square(0, 0, 100, 100), outlineClosed: true,
      notches: [], internalLines: [], gradePoints: [],
    }] } });
    const out = await patterns.editRevision(w.ctx, {
      revisionId: first.id,
      operations: [{ kind: "rename", pieceRef: "PC-X", name: "Left front" }],
      actor: w.drafter,
    });
    expect(out.revision.patternSet.pieces[0].generatedName).toBe(false);
  });

  test("an edit naming a piece that is not there is refused", async () => {
    const w = await world();
    const first = await imported(w);
    await refuses(() => patterns.editRevision(w.ctx, {
      revisionId: first.id,
      operations: [{ kind: "rename", pieceRef: "PC-NOPE", name: "x" }],
      actor: w.drafter,
    }), "NOT_FOUND");
  });

  test("an edit from a stale screen is refused rather than branching the line", async () => {
    const w = await world();
    const first = await imported(w);
    await refuses(() => patterns.editRevision(w.ctx, {
      revisionId: first.id, expectedRevision: 99,
      operations: [{ kind: "rename", pieceRef: "PC-FRONT", name: "x" }],
      actor: w.drafter,
    }), "REVISION_CONFLICT");
  });
});

/* ═══ 3 · AN APPROVED REVISION IS EVIDENCE ════════════════════════════════ */

describe("an approved revision is never written to", () => {
  test("approving freezes it and supersedes whatever was current", async () => {
    const w = await world();
    const first = await imported(w);
    const second = (await patterns.editRevision(w.ctx, {
      revisionId: first.id, operations: [{ kind: "rename", pieceRef: "PC-FRONT", name: "F" }],
      actor: w.drafter,
    })).revision;

    const a = await patterns.approveRevision(w.ctx, { revisionId: first.id, actor: w.checker });
    expect(a.revision.state).toBe(REVISION_STATE.APPROVED);
    expect(a.revision.approvedBy).toBe("A Checker");

    const b = await patterns.approveRevision(w.ctx, { revisionId: second.id, actor: w.checker });
    expect(b.supersededRef).toBe(first.revisionRef);

    const old = await patterns.readRevision(w.ctx, { revisionId: first.id });
    expect(old.revision.state).toBe(REVISION_STATE.SUPERSEDED);
    expect(old.revision.supersededByRef).toBe(second.revisionRef);
  });

  test("editing an approved revision produces the NEXT one and leaves it untouched", async () => {
    /* The whole immutability rule in one test: the edit is allowed, and the
       approved revision is exactly as it was approved. */
    const w = await world();
    const first = await imported(w);
    await patterns.approveRevision(w.ctx, { revisionId: first.id, actor: w.checker });

    const out = await patterns.editRevision(w.ctx, {
      revisionId: first.id,
      operations: [{ kind: "seam-allowance", pieceRef: "PC-FRONT", seamAllowance: 20 }],
      actor: w.drafter,
    });
    expect(out.revision.revisionNumber).toBe(2);
    expect(out.revision.state).toBe(REVISION_STATE.DRAFT);
    expect(out.revision.origin.parentRevisionRef).toBe(first.revisionRef);

    const frozen = await patterns.readRevision(w.ctx, { revisionId: first.id });
    expect(frozen.revision.state).toBe(REVISION_STATE.APPROVED);
    expect(frozen.revision.patternSet.pieces[0].seamAllowance.value).toBe(10);
    expect(frozen.revision.edits).toEqual([]);
  });

  test("an approved revision's simulation settings cannot be changed either", async () => {
    const w = await world();
    const first = await imported(w);
    await patterns.approveRevision(w.ctx, { revisionId: first.id, actor: w.checker });
    await refuses(() => patterns.setSimulationInputs(w.ctx, {
      revisionId: first.id, inputs: READY_INPUTS, actor: w.drafter,
    }), "PATTERN_REVISION_FROZEN");
  });

  test("nobody approves their own pattern", async () => {
    const w = await world();
    const first = await imported(w);
    await refuses(() => patterns.approveRevision(w.ctx, {
      revisionId: first.id, actor: w.drafter,
    }), "MODEL_SELF_APPROVAL");
  });

  test("a superseded revision cannot be approved again", async () => {
    const w = await world();
    const first = await imported(w);
    const second = (await patterns.editRevision(w.ctx, {
      revisionId: first.id, operations: [{ kind: "rename", pieceRef: "PC-FRONT", name: "F" }],
      actor: w.drafter,
    })).revision;
    await patterns.approveRevision(w.ctx, { revisionId: first.id, actor: w.checker });
    await patterns.approveRevision(w.ctx, { revisionId: second.id, actor: w.checker });
    await refuses(() => patterns.approveRevision(w.ctx, {
      revisionId: first.id, actor: w.checker,
    }), "INVALID_TRANSITION");
  });
});

/* ═══ 4 · ASKING FOR A PREVIEW ════════════════════════════════════════════ */

describe("a render is requested from a revision, or refused with the reason", () => {
  test("a pattern with no simulation inputs says which ones are missing", async () => {
    const w = await world();
    const first = await imported(w);
    const err = await refuses(() => renders.requestRender(w.ctx, {
      revisionId: first.id, actor: w.drafter,
    }), "SIMULATION_INPUTS_MISSING");
    /* Named, so somebody can go and add them. */
    /* The refusal quotes the FIRST failure's own sentence rather than listing
       step names: "seam mapping is missing" sends somebody hunting. */
    expect(err.message).toMatch(/garment category/i);
    expect(err.message).toMatch(/other things still needed/i);
    expect(err.details.missing.map((m) => m.key).sort()).toEqual(
      ["body", "boundary", "fabric", "roles", "seams", "size", "template"],
    );
  });

  test("the readiness list is on the revision, before anybody presses anything", async () => {
    const w = await world();
    const first = await imported(w);
    expect(first.readiness.ready).toBe(false);
    /* Nothing has been set up, so the only steps that are done are the ones a
       parsed pattern satisfies on its own. */
    expect(first.readiness.ready).toBe(false);
    expect(first.readiness.outcome).toBe("refused");
    expect(first.readiness.steps.map((st) => st.key)).toEqual([
      "template", "size", "body", "fabric", "roles", "grain", "sewingLine", "seams", "boundary",
    ]);
    /* Each missing input says WHY it is needed, in a sentence. */
    for (const m of first.readiness.missing) expect(m.why.length).toBeGreaterThan(20);
  });

  test("with every input present, a job is created against that exact revision", async () => {
    const w = await world();
    const ready = await madeRenderable(w, await imported(w));
    const out = await renders.requestRender(w.ctx, { revisionId: ready.id, actor: w.drafter });

    expect(out.render.patternRevisionRef).toBe(ready.revisionRef);
    expect(out.render.patternRevisionNumber).toBe(1);
    expect(out.render.derivedFrom).toBe("Derived from 2D pattern revision 1.");
    expect(out.render.readOnly).toBe(true);
    /* The settings are COPIED onto the job, not referenced. */
    expect(out.render.inputs.fabrics[0].name).toBe("Cotton jersey 180");
  });

  test("with no simulation engine connected, the job fails at once and says so", async () => {
    /* Not queued for ever, and not quietly replaced by something invented
       locally: a plausible garment nothing simulated is the most dangerous
       output this system could produce. */
    const w = await world();
    const ready = await madeRenderable(w, await imported(w));
    const out = await renders.requestRender(w.ctx, { revisionId: ready.id, actor: w.drafter });
    expect(out.render.status).toBe(RENDER_STATUS.FAILED);
    expect(out.render.failure.code).toBe("SIMULATION_ENGINE_NOT_CONNECTED");
    expect(out.render.failure.message).toMatch(/No simulation engine is connected/i);
    /* And the pattern is untouched. */
    const after = await patterns.readRevision(w.ctx, { revisionId: ready.id });
    expect(after.revision.revisionNumber).toBe(1);
    expect(after.revision.state).toBe(REVISION_STATE.DRAFT);
  });

  test("with an engine connected, the job goes to simulating and names it", async () => {
    const w = await world();
    const ready = await madeRenderable(w, await imported(w));
    simulation.registerAdapter("test-solver", {
      version: "9.1",
      submit: async () => ({ externalJobId: "ext-42", version: "9.1" }),
    });
    process.env.RND_SIMULATION_ADAPTER = "test-solver";
    try {
      const out = await renders.requestRender(w.ctx, { revisionId: ready.id, actor: w.drafter });
      expect(out.render.status).toBe(RENDER_STATUS.SIMULATING);
      expect(out.render.engine).toMatchObject({ adapter: "test-solver", version: "9.1", externalJobId: "ext-42" });
    } finally {
      delete process.env.RND_SIMULATION_ADAPTER;
      simulation.__adapters.delete("test-solver");
    }
  });

  test("two renders of one revision cannot run at once", async () => {
    const w = await world();
    const ready = await madeRenderable(w, await imported(w));
    simulation.registerAdapter("slow", { version: "1", submit: async () => ({ externalJobId: "x" }) });
    process.env.RND_SIMULATION_ADAPTER = "slow";
    try {
      await renders.requestRender(w.ctx, { revisionId: ready.id, actor: w.drafter });
      await refuses(() => renders.requestRender(w.ctx, {
        revisionId: ready.id, actor: w.drafter,
      }), "RENDER_ALREADY_RUNNING");
    } finally {
      delete process.env.RND_SIMULATION_ADAPTER;
      simulation.__adapters.delete("slow");
    }
  });
});

/* ═══ 5 · WHAT THE ENGINE REPORTS BACK ════════════════════════════════════ */

describe("a render finishes, once", () => {
  async function running(w) {
    const ready = await madeRenderable(w, await imported(w));
    simulation.registerAdapter("t", { version: "1", submit: async () => ({ externalJobId: "e1" }) });
    process.env.RND_SIMULATION_ADAPTER = "t";
    const out = await renders.requestRender(w.ctx, { revisionId: ready.id, actor: w.drafter });
    delete process.env.RND_SIMULATION_ADAPTER;
    simulation.__adapters.delete("t");
    return { ready, job: out.render };
  }

  test("a completed render names the publication it produced", async () => {
    const w = await world();
    const { job } = await running(w);
    const pubId = new mongoose.Types.ObjectId();
    const out = await renders.recordRenderOutcome(w.ctx, {
      jobRef: job.jobRef, status: "completed",
      publicationId: pubId, publicationRef: "GM-ABC", actor: w.drafter,
    });
    expect(out.render.status).toBe(RENDER_STATUS.COMPLETED);
    expect(out.render.resultPublicationRef).toBe("GM-ABC");
    expect(out.render.finishedAt).toBeTruthy();
  });

  test("a completed render that names no publication is refused", async () => {
    const w = await world();
    const { job } = await running(w);
    await refuses(() => renders.recordRenderOutcome(w.ctx, {
      jobRef: job.jobRef, status: "completed", actor: w.drafter,
    }), "VALIDATION");
  });

  test("a failure is recorded with a code and a sentence", async () => {
    const w = await world();
    const { job } = await running(w);
    const out = await renders.recordRenderOutcome(w.ctx, {
      jobRef: job.jobRef, status: "failed",
      failure: { code: "SOLVER_DIVERGED", message: "The solver did not reach equilibrium in 400 steps." },
      actor: w.drafter,
    });
    expect(out.render.status).toBe(RENDER_STATUS.FAILED);
    expect(out.render.failure).toEqual({
      code: "SOLVER_DIVERGED",
      message: "The solver did not reach equilibrium in 400 steps.",
    });
  });

  test("a late message cannot rewrite what a finished render produced", async () => {
    const w = await world();
    const { job } = await running(w);
    await renders.recordRenderOutcome(w.ctx, {
      jobRef: job.jobRef, status: "completed",
      publicationId: new mongoose.Types.ObjectId(), publicationRef: "GM-FIRST", actor: w.drafter,
    });
    await refuses(() => renders.recordRenderOutcome(w.ctx, {
      jobRef: job.jobRef, status: "failed", failure: { code: "X", message: "y" }, actor: w.drafter,
    }), "INVALID_TRANSITION");
  });
});

/* ═══ 6 · OUT OF DATE, NOT WRONG ══════════════════════════════════════════ */

describe("a preview goes stale when the pattern moves on", () => {
  async function completedRender(w) {
    const ready = await madeRenderable(w, await imported(w));
    simulation.registerAdapter("t", { version: "1", submit: async () => ({ externalJobId: "e" }) });
    process.env.RND_SIMULATION_ADAPTER = "t";
    const job = (await renders.requestRender(w.ctx, { revisionId: ready.id, actor: w.drafter })).render;
    delete process.env.RND_SIMULATION_ADAPTER;
    simulation.__adapters.delete("t");
    await renders.recordRenderOutcome(w.ctx, {
      jobRef: job.jobRef, status: "completed",
      publicationId: new mongoose.Types.ObjectId(), publicationRef: "GM-1", actor: w.drafter,
    });
    return ready;
  }

  test("while it is the newest revision, the preview is current", async () => {
    const w = await world();
    await completedRender(w);
    const list = await renders.listRenders(w.ctx, { styleId: w.style._id });
    expect(list.current.stale).toBe(false);
    expect(list.outOfDate).toBe(false);
  });

  test("a new revision makes it out of date, and says which is which", async () => {
    const w = await world();
    const rendered = await completedRender(w);
    await patterns.editRevision(w.ctx, {
      revisionId: rendered.id,
      operations: [{ kind: "seam-allowance", pieceRef: "PC-FRONT", seamAllowance: 14 }],
      actor: w.drafter,
    });
    const list = await renders.listRenders(w.ctx, { styleId: w.style._id });
    expect(list.outOfDate).toBe(true);
    expect(list.current.stale).toBe(true);
    expect(list.current.staleReason)
      .toBe("This preview was made from pattern revision 1. The current pattern is revision 2.");
  });

  test("the old preview is kept rather than replaced, with what it was made from", async () => {
    /* Comparing this week's drape with last week's is the main reason anybody
       looks at two, and a system that overwrote would make it impossible. */
    const w = await world();
    const rendered = await completedRender(w);
    const next = (await patterns.editRevision(w.ctx, {
      revisionId: rendered.id,
      operations: [{ kind: "rename", pieceRef: "PC-FRONT", name: "F2" }],
      actor: w.drafter,
    })).revision;
    await madeRenderable(w, next);
    simulation.registerAdapter("t", { version: "1", submit: async () => ({ externalJobId: "e2" }) });
    process.env.RND_SIMULATION_ADAPTER = "t";
    await renders.requestRender(w.ctx, { revisionId: next.id, actor: w.drafter });
    delete process.env.RND_SIMULATION_ADAPTER;
    simulation.__adapters.delete("t");

    const list = await renders.listRenders(w.ctx, { styleId: w.style._id });
    expect(list.renders).toHaveLength(2);
    expect(list.renders.map((r) => r.patternRevisionNumber).sort()).toEqual([1, 2]);
    /* Each still says exactly what it is of. */
    for (const r of list.renders) expect(r.derivedFrom).toMatch(/^Derived from 2D pattern revision \d\.$/);
  });
});

/* ═══ 7 · THE ARROW POINTS ONE WAY ═══════════════════════════════════════ */

describe("nothing in 3D can change the pattern", () => {
  test("a derived publication refuses markers and measurements, and says why", async () => {
    const w = await world();
    const pub = await GarmentModelPublication.create({
      companyId: w.co._id, styleId: w.style._id,
      publicationRef: "GM-DERIVED", modelNumber: 1,
      derivedFromPatternRevisionRef: "PR-ABC",
      derivedFromPatternRevisionNumber: 3,
      derivedFromRenderJobRef: "RJ-1",
    });
    const err = await refuses(
      () => renders.assertNotDerived(pub, "Adding a note"),
      "DERIVED_PREVIEW_READ_ONLY",
    );
    expect(err.message).toMatch(/preview derived from 2D pattern revision 3/);
    /* And it says what to do instead. */
    expect(err.message).toMatch(/Edit the pattern instead/);
  });

  test("an ordinary uploaded model is not affected by the rule", async () => {
    const w = await world();
    const pub = await GarmentModelPublication.create({
      companyId: w.co._id, styleId: w.style._id, publicationRef: "GM-UPLOADED", modelNumber: 2,
    });
    expect(() => renders.assertNotDerived(pub, "Adding a note")).not.toThrow();
  });

  test("the pattern service exposes no function a 3D record could edit through", () => {
    /* The rule as a property of the module rather than of a call site: every
       write here takes a revision id and an actor, and there is no entry point
       by which a marker, a measurement or an annotation reaches a pattern. */
    const writes = ["importRevision", "editRevision", "setSimulationInputs", "approveRevision"];
    for (const name of writes) expect(typeof patterns[name]).toBe("function");
    const names = Object.keys(patterns);
    expect(names.some((n) => /marker|measurement|annotation/i.test(n))).toBe(false);

    /* ── THE ONE FUNCTION THAT NAMES A PUBLICATION, AND WHY IT IS NOT A HOLE ──
       `reconcileFromPublications` reads a parse that is stranded inside a
       garment bundle and makes the pattern revision that should always have
       existed. The arrow runs publication → revision, which is the direction
       that was MISSING, not the forbidden one: a style could carry a correct
       five-piece pattern and report that none had been imported.

       It is not a way for 3D to edit a pattern, and the suite proves that
       rather than trusting the name — it takes a style, never a publication id;
       it only ever CREATES, never touching an existing revision; and it is
       idempotent, so running it cannot change what a previous run decided. */
    expect(names.filter((n) => /publication/i.test(n))).toEqual(["reconcileFromPublications"]);
    expect(patterns.reconcileFromPublications.length).toBeLessThanOrEqual(2);
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "..", "..", "services", "rnd", "patternRevision.service.js"),
      "utf8",
    );
    const body = src.slice(src.indexOf("async function reconcileFromPublications"));
    const fn = body.slice(0, body.indexOf("\n}\n") + 2);
    /* It reads publications and writes only the back-reference, and only on one
       that is not approved. No other field of a publication is assigned. */
    expect(fn).toMatch(/state !== PUBLICATION_STATE\.APPROVED/);
    expect(fn.match(/row\.[a-zA-Z]+\s*=/g) || []).toEqual(["row.patternRevisionRef ="]);
  });

  test("a render records nothing on the revision it was made from", async () => {
    const w = await world();
    const ready = await madeRenderable(w, await imported(w));
    const before = await PatternRevision.findById(ready.id).lean();
    await renders.requestRender(w.ctx, { revisionId: ready.id, actor: w.drafter });
    const after = await PatternRevision.findById(ready.id).lean();
    expect(after.revision).toBe(before.revision);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after.events).toHaveLength(before.events.length);
  });
});

/* ═══ 8 · TENANCY ════════════════════════════════════════════════════════ */

describe("another company's pattern does not exist", () => {
  test("every read and write answers not-found", async () => {
    const mine = await world();
    const theirs = await world();
    const theirRevision = await madeRenderable(theirs, await imported(theirs));

    await refuses(() => patterns.readRevision(mine.ctx, { revisionId: theirRevision.id }), "NOT_FOUND");
    await refuses(() => patterns.editRevision(mine.ctx, {
      revisionId: theirRevision.id,
      operations: [{ kind: "rename", pieceRef: "PC-FRONT", name: "x" }], actor: mine.drafter,
    }), "NOT_FOUND");
    await refuses(() => patterns.approveRevision(mine.ctx, {
      revisionId: theirRevision.id, actor: mine.checker,
    }), "NOT_FOUND");
    await refuses(() => renders.requestRender(mine.ctx, {
      revisionId: theirRevision.id, actor: mine.drafter,
    }), "NOT_FOUND");
    await refuses(() => renders.listRenders(mine.ctx, { styleId: theirs.style._id }), "NOT_FOUND");
  });
});
