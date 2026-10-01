// test/rnd/in-app-drape.test.js
//
// THE DRAPE THAT THIS REPOSITORY COMPUTES ITSELF.
//
// The cloth solver runs in the reader's browser (`grav-cms/components/rnd/fit/`)
// and is tested there. What is tested HERE is the half the server owns, and the
// server owns the part that has to survive a closed tab:
//
//   · the job is minted, moved to `simulating` and only ever finished by a
//     reported outcome, so an abandoned drape is a job that never reported —
//     visible and clearable — rather than a preview that silently never was;
//   · a drape is NOT a publication, and cannot be filed as one;
//   · a drape whose geometry does not match its own piece table is refused,
//     because the piece names are the whole value of it;
//   · reporting a drape needs the privilege to ask for one, and no more. A model
//     publication is a file a sample gets approved against; a drape is a derived,
//     read-only reading of a pattern, and requiring publish rights to report one
//     would restrict the wrong act.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const mongoose = require("mongoose");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Account = require("../../models/CMS_Models/Sales/Account");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const { RenderJob, RENDER_STATUS } = require("../../models/CMS_Models/RnD/PatternRevision");

const patterns = require("../../services/rnd/patternRevision.service");
const renders = require("../../services/rnd/garmentRender.service");
const simulation = require("../../services/rnd/simulationAdapter.service");

let seq = 0;

async function world() {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `Drape Co ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const account = await Account.create({ companyName: `Buyer ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-DR-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-DR-${n}`, styleCode: `SC-DR-${n}`, productName: "Tunic",
    journeyId: journey._id, accountId: account._id, stage: "rnd",
    techSheet: { status: "pending" },
  });
  return {
    co, style, ctx: { companyId: co._id },
    actor: { id: `d${n}`, name: "A Patternmaker", email: `draft${n}@grav.test` },
  };
}

/* Two panels with eight corners each, so a seam can name part of an edge. */
const panel = (x, w, h) => [
  { x, y: 0 }, { x: x + w, y: 0 }, { x: x + w, y: h * 0.62 }, { x: x + w, y: h },
  { x: x + w * 0.7, y: h }, { x: x + w * 0.3, y: h }, { x, y: h }, { x, y: h * 0.62 },
];

const piece = (ref, name, x) => ({
  pieceRef: ref, index: 0, name, generatedName: false, quantity: 1, componentClass: "shell",
  outline: panel(x, 560, 760), outlineClosed: true,
  notches: [], internalLines: [], gradePoints: [], seamAllowance: { value: 10, source: "parsed" },
});

const patternSet = () => ({
  patternSetRef: "PS-DRAPE", classification: "apparel_pattern_set",
  manifest: { styleName: "Tunic", sampleSize: "M" },
  unit: "mm", unitSource: "header", unitInMm: 1,
  pieces: [piece("PC-FRONT", "Front Panel", 0), piece("PC-BACK", "Back Panel", 700)],
  grading: { graded: false, sizes: [], sizeCount: 0, gradePointsPublished: false, pieces: [] },
  stats: { pieces: 2, namedPieces: 2, piecesWithOutline: 2 },
});

const INPUTS = {
  seamPairings: [
    {
      name: "Right side seam",
      fromPieceRef: "PC-FRONT", fromPoints: { from: 1, to: 2 },
      toPieceRef: "PC-BACK", toPoints: { from: 0, to: 7 },
    },
    {
      name: "Right shoulder",
      fromPieceRef: "PC-FRONT", fromPoints: { from: 3, to: 4 },
      toPieceRef: "PC-BACK", toPoints: { from: 6, to: 5 },
    },
  ],
  fabrics: [{ name: "Cotton poplin", weightGsm: 120, thicknessMm: 0.32 }],
  avatar: { name: "Male M", size: "M", measurements: { chestMm: 1000, heightMm: 1750 } },
  settings: { quality: "normal", fabric: "poplin" },
  renderSize: "M",
};

async function renderable(w) {
  const imported = (await patterns.importRevision(w.ctx, {
    styleId: w.style._id,
    patternSet: patternSet(),
    sourceDxf: { driveFileId: "drv-1", name: "tunic.dxf", sha256: "a".repeat(64), bytes: 2048 },
    name: "Imported from CAD",
    actor: w.actor,
  })).revision;
  return (await patterns.setSimulationInputs(w.ctx, {
    revisionId: imported.id, inputs: INPUTS, actor: w.actor,
  })).revision;
}

/** A plausible drape, as the browser sends it: positions as base64 Float32. */
function drapeFor({ vertexCount = 12, pieces = null } = {}) {
  const positions = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i += 1) {
    positions[i * 3] = i * 10;
    positions[i * 3 + 1] = 1200 + i;
    positions[i * 3 + 2] = 40;
  }
  return {
    solverVersion: "fit-1.0",
    quality: "normal",
    fabric: { id: "poplin", label: "Cotton poplin (shirting)", version: "1" },
    unit: "mm",
    vertexCount,
    triangleCount: 6,
    pieces: pieces || [
      { pieceRef: "PC-FRONT", name: "Front Panel", role: "front", base: 0, vertexCount: vertexCount / 2 },
      { pieceRef: "PC-BACK", name: "Back Panel", role: "back", base: vertexCount / 2, vertexCount: vertexCount / 2 },
    ],
    positions: Buffer.from(positions.buffer).toString("base64"),
    seamClosure: [
      { name: "Right side seam", worstGapMm: 8.4, meanGapMm: 1.2, sourceLengthMm: 471.2, stations: 27 },
    ],
    strain: { maxPercent: 11.0, meanPercent: 0.4 },
    fidelity: { ok: true, worstBoundaryMm: 0, worstSeamMm: 0 },
    tightestClearanceMm: 1.9,
    template: { id: "shirt", label: "Shirt / T-shirt / polo", confidence: 1 },
    body: { kind: "capsules", estimated: true },
    frames: 534,
    finalMoveMm: 0.42,
    msElapsed: 10240,
  };
}

const withAdapter = async (fn) => {
  process.env.RND_SIMULATION_ADAPTER = "in-app";
  try { return await fn(); } finally { delete process.env.RND_SIMULATION_ADAPTER; }
};

const refuses = async (fn, code) => {
  try { await fn(); } catch (err) { expect(err.code).toBe(code); return err; }
  throw new Error(`expected a ${code} refusal and nothing was refused`);
};

/* ═══ 1 · THE ADAPTER ═════════════════════════════════════════════════════ */

describe("the in-app solver is an adapter like any other", () => {
  test("it is registered, and selected by the same environment variable", () => {
    expect(simulation.__adapters.has("in-app")).toBe(true);
    const off = simulation.adapterStatus();
    expect(off.configured).toBe(false);
    return withAdapter(async () => {
      const on = simulation.adapterStatus();
      expect(on.configured).toBe(true);
      expect(on.name).toBe("in-app");
      expect(on.runsInBrowser).toBe(true);
      /* And it says what it is NOT, in the sentence a screen shows. */
      expect(on.message).toMatch(/in this browser/);
      expect(on.message).toMatch(/not a replacement for a production drape in CLO/);
    });
  });

  test("with no engine configured, a render still fails with a sentence", async () => {
    const w = await world();
    const ready = await renderable(w);
    const out = await renders.requestRender(w.ctx, { revisionId: ready.id, actor: w.actor });
    expect(out.render.status).toBe(RENDER_STATUS.FAILED);
    expect(out.render.failure.code).toBe("SIMULATION_ENGINE_NOT_CONNECTED");
    expect(out.render.engine.runsInBrowser).toBe(false);
  });

  test("it refuses a job whose pattern has no mapped seam", async () => {
    await expect(simulation.submit({
      jobRef: "RJ-1", patternSet: patternSet(), inputs: { seamPairings: [] },
    })).resolves.toMatchObject({ status: "unavailable" });
    return withAdapter(async () => {
      const out = await simulation.submit({
        jobRef: "RJ-1", patternSet: patternSet(), inputs: { seamPairings: [] },
      });
      expect(out.status).toBe("failed");
      expect(out.message).toMatch(/no seam has been mapped/);
    });
  });
});

/* ═══ 2 · READINESS NAMES WHAT IS STILL MISSING ═══════════════════════════ */

describe("readiness says how far the seam map has got", () => {
  test("a pairing that names two pieces but not two edges does not count", () => {
    const check = simulation.checkInputs(patternSet(), {
      ...INPUTS,
      seamPairings: [{ name: "Side", fromPieceRef: "PC-FRONT", toPieceRef: "PC-BACK" }],
    });
    expect(check.ready).toBe(false);
    expect(check.seamMapping.total).toBe(1);
    expect(check.seamMapping.usable).toBe(0);
    expect(check.seamMapping.unusable[0].why).toMatch(/which edge/);
    expect(check.missing.map((m) => m.key)).toContain("seamPairings");
  });

  test("a pairing naming a piece that is not in the pattern says which piece", () => {
    const check = simulation.checkInputs(patternSet(), {
      ...INPUTS,
      seamPairings: [{
        name: "Collar join", fromPieceRef: "PC-FRONT", fromPoints: { from: 3, to: 4 },
        toPieceRef: "PC-COLLAR", toPoints: { from: 0, to: 1 },
      }],
    });
    expect(check.seamMapping.usable).toBe(0);
    expect(check.seamMapping.unusable[0].why).toMatch(/PC-COLLAR/);
  });

  test("a piece joined to nothing is reported, not refused — a loose belt is legal", () => {
    const check = simulation.checkInputs(patternSet(), {
      ...INPUTS,
      seamPairings: [INPUTS.seamPairings[0]],
    });
    expect(check.ready).toBe(true);
    expect(check.seamMapping.usable).toBe(1);
    expect(check.seamMapping.unjoinedPieces).toEqual([]);
  });

  test("a fully mapped pattern is ready, and says so with nothing missing", () => {
    const check = simulation.checkInputs(patternSet(), INPUTS);
    expect(check.ready).toBe(true);
    expect(check.missing).toEqual([]);
    expect(check.seamMapping.usable).toBe(2);
    expect(check.pieceCount).toBe(2);
  });
});

/* ═══ 3 · THE JOB THE SERVER OWNS ════════════════════════════════════════ */

describe("the job is the server's, whoever does the arithmetic", () => {
  async function simulating(w) {
    const ready = await renderable(w);
    return withAdapter(async () => {
      const out = await renders.requestRender(w.ctx, { revisionId: ready.id, actor: w.actor });
      return { ready, job: out.render };
    });
  }

  test("requesting a render accepts the job and tells the page it owns the drape", async () => {
    const w = await world();
    const { job } = await simulating(w);
    expect(job.status).toBe(RENDER_STATUS.SIMULATING);
    expect(job.engine.adapter).toBe("in-app");
    expect(job.engine.version).toBe("fit-1.0");
    /* Its own id IS the job ref: there is no second system holding a second id. */
    expect(job.engine.externalJobId).toBe(job.jobRef);
    expect(job.engine.runsInBrowser).toBe(true);
    expect(job.drape).toEqual({ present: false });
    /* And the inputs were copied, so editing the revision cannot change what
       this garment was draped with. */
    expect(job.inputs.seamPairings).toHaveLength(2);
  });

  test("a drape completes the job and is stored with what it found", async () => {
    const w = await world();
    const { job } = await simulating(w);
    const out = await renders.recordRenderOutcome(w.ctx, {
      jobRef: job.jobRef, status: "completed", drape: drapeFor(), actor: w.actor,
    });
    expect(out.render.status).toBe(RENDER_STATUS.COMPLETED);
    expect(out.render.drape.present).toBe(true);
    expect(out.render.drape.vertexCount).toBe(12);
    expect(out.render.drape.quality).toBe("normal");
    expect(out.render.drape.solverVersion).toBe("fit-1.0");
    expect(out.render.drape.unit).toBe("mm");
    expect(out.render.drape.seamClosure[0].worstGapMm).toBeCloseTo(8.4, 5);
    expect(out.render.drape.strain.maxPercent).toBeCloseTo(11.0, 5);
    /* The sentence that stops it being approved against. */
    expect(out.render.drape.caveat).toMatch(/should not be approved against it/);
    expect(out.render.readOnly).toBe(true);
    expect(out.render.derivedFrom).toBe("Derived from 2D pattern revision 1.");
    /* A DRAPE IS NOT A PUBLICATION. */
    expect(out.render.resultPublicationRef).toBe("");
    expect(out.render.resultPublicationId).toBe("");
  });

  test("the job list does not carry the geometry; reading the drape does", async () => {
    const w = await world();
    const { job } = await simulating(w);
    await renders.recordRenderOutcome(w.ctx, {
      jobRef: job.jobRef, status: "completed", drape: drapeFor({ vertexCount: 12 }), actor: w.actor,
    });
    const list = await renders.listRenders(w.ctx, { styleId: w.style._id });
    expect(list.current.drape.present).toBe(true);
    expect(list.current.drape.positions).toBeUndefined();
    expect(list.current.drape.positionsBase64).toBeUndefined();

    const read = await renders.readDrape(w.ctx, { jobRef: job.jobRef });
    expect(read.vertexCount).toBe(12);
    expect(read.unit).toBe("mm");
    expect(read.patternRevisionNumber).toBe(1);
    expect(read.pieces.map((p) => p.pieceRef)).toEqual(["PC-FRONT", "PC-BACK"]);
    const bytes = Buffer.from(read.positionsBase64, "base64");
    expect(bytes.length).toBe(12 * 3 * 4);
    const positions = new Float32Array(bytes.buffer, bytes.byteOffset, 36);
    expect(positions[0]).toBeCloseTo(0, 5);
    expect(positions[4]).toBeCloseTo(1201, 5);
  });

  test("a drape whose positions do not match its vertex count is refused", async () => {
    /* The labels are the whole value: a reader looking at a strained area has to
       be told which PATTERN PIECE it is on. */
    const w = await world();
    const { job } = await simulating(w);
    const bad = drapeFor({ vertexCount: 12 });
    bad.vertexCount = 20;
    const err = await refuses(() => renders.recordRenderOutcome(w.ctx, {
      jobRef: job.jobRef, status: "completed", drape: bad, actor: w.actor,
    }), "VALIDATION");
    expect(err.message).toMatch(/cannot say which panel/);
    /* And the job is untouched, still waiting. */
    const still = await RenderJob.findOne({ jobRef: job.jobRef }).lean();
    expect(still.status).toBe(RENDER_STATUS.SIMULATING);
  });

  test("a drape whose pieces do not account for every point is refused", async () => {
    const w = await world();
    const { job } = await simulating(w);
    const bad = drapeFor({
      vertexCount: 12,
      pieces: [{ pieceRef: "PC-FRONT", name: "Front Panel", base: 0, vertexCount: 6 }],
    });
    const err = await refuses(() => renders.recordRenderOutcome(w.ctx, {
      jobRef: job.jobRef, status: "completed", drape: bad, actor: w.actor,
    }), "VALIDATION");
    expect(err.message).toMatch(/account for 6 of its 12/);
  });

  test("a completed render that names neither a publication nor a drape is refused", async () => {
    const w = await world();
    const { job } = await simulating(w);
    await refuses(() => renders.recordRenderOutcome(w.ctx, {
      jobRef: job.jobRef, status: "completed", actor: w.actor,
    }), "VALIDATION");
  });

  test("a drape that could not finish is recorded as a failure with its reason", async () => {
    const w = await world();
    const { job } = await simulating(w);
    const out = await renders.recordRenderOutcome(w.ctx, {
      jobRef: job.jobRef, status: "failed",
      failure: {
        code: "GEOMETRY_FIDELITY_FAILED",
        message: "This simulation was stopped because the mesh does not match the pattern.",
      },
      actor: w.actor,
    });
    expect(out.render.status).toBe(RENDER_STATUS.FAILED);
    expect(out.render.failure.code).toBe("GEOMETRY_FIDELITY_FAILED");
    expect(out.render.drape).toEqual({ present: false });
  });

  test("a closed tab leaves a job that never reported, not a phantom preview", async () => {
    /* The reason the record is the server's. Nothing finishes this job but a
       reported outcome, so it stays visibly `simulating` instead of becoming a
       preview that does not exist. */
    const w = await world();
    const { job } = await simulating(w);
    const list = await renders.listRenders(w.ctx, { styleId: w.style._id });
    /* `current` is the latest COMPLETED render, so there is still none — the 3D
       side has nothing to show, which is the truth. The job is there, visible,
       and stuck at `simulating` until something reports. */
    expect(list.current).toBeNull();
    expect(list.renders[0].jobRef).toBe(job.jobRef);
    expect(list.renders[0].status).toBe(RENDER_STATUS.SIMULATING);
    expect(list.renders[0].drape.present).toBe(false);
  });

  test("a late drape cannot rewrite a render that has already finished", async () => {
    const w = await world();
    const { job } = await simulating(w);
    await renders.recordRenderOutcome(w.ctx, {
      jobRef: job.jobRef, status: "completed", drape: drapeFor(), actor: w.actor,
    });
    await refuses(() => renders.recordRenderOutcome(w.ctx, {
      jobRef: job.jobRef, status: "completed", drape: drapeFor({ vertexCount: 24 }), actor: w.actor,
    }), "INVALID_TRANSITION");
  });

  test("reading a drape from a render that has none says which it is", async () => {
    const w = await world();
    const { job } = await simulating(w);
    const err = await refuses(() => renders.readDrape(w.ctx, { jobRef: job.jobRef }), "NO_DRAPE");
    expect(err.message).toMatch(/simulating/);
  });

  test("one drape at a time per revision", async () => {
    const w = await world();
    const { ready } = await simulating(w);
    await withAdapter(() => refuses(
      () => renders.requestRender(w.ctx, { revisionId: ready.id, actor: w.actor }),
      "RENDER_ALREADY_RUNNING",
    ));
  });

  test("another company cannot read or finish this drape", async () => {
    const w = await world();
    const other = await world();
    const { job } = await simulating(w);
    await refuses(() => renders.readDrape(other.ctx, { jobRef: job.jobRef }), "NOT_FOUND");
    await refuses(() => renders.recordRenderOutcome(other.ctx, {
      jobRef: job.jobRef, status: "completed", drape: drapeFor(), actor: other.actor,
    }), "NOT_FOUND");
  });
});

/* ═══ 4 · AND THE PATTERN IS STILL THE PATTERN ═══════════════════════════ */

describe("a drape changes nothing about the pattern it was made from", () => {
  test("the revision is byte-identical after a drape is recorded", async () => {
    const w = await world();
    const ready = await renderable(w);
    const before = await patterns.readRevision(w.ctx, { revisionId: ready.id });
    const job = (await withAdapter(
      () => renders.requestRender(w.ctx, { revisionId: ready.id, actor: w.actor }),
    )).render;
    await renders.recordRenderOutcome(w.ctx, {
      jobRef: job.jobRef, status: "completed", drape: drapeFor(), actor: w.actor,
    });
    const after = await patterns.readRevision(w.ctx, { revisionId: ready.id });
    expect(JSON.stringify(after.revision.patternSet))
      .toBe(JSON.stringify(before.revision.patternSet));
    expect(after.revision.revisionNumber).toBe(before.revision.revisionNumber);
    expect(after.revision.state).toBe(before.revision.state);
  });

  test("a drape goes out of date when the pattern moves on, and is not deleted", async () => {
    const w = await world();
    const ready = await renderable(w);
    const job = (await withAdapter(
      () => renders.requestRender(w.ctx, { revisionId: ready.id, actor: w.actor }),
    )).render;
    await renders.recordRenderOutcome(w.ctx, {
      jobRef: job.jobRef, status: "completed", drape: drapeFor(), actor: w.actor,
    });
    await patterns.editRevision(w.ctx, {
      revisionId: ready.id,
      operations: [{ kind: "seam-allowance", pieceRef: "PC-FRONT", seamAllowance: 14 }],
      actor: w.actor,
    });
    const list = await renders.listRenders(w.ctx, { styleId: w.style._id });
    expect(list.outOfDate).toBe(true);
    expect(list.current.stale).toBe(true);
    /* Still there, still readable, still labelled with the revision it is of. */
    expect(list.current.drape.present).toBe(true);
    const read = await renders.readDrape(w.ctx, { jobRef: job.jobRef });
    expect(read.patternRevisionNumber).toBe(1);
  });
});
