// test/rnd/real-dxf-chain.test.js
//
// THE GENUINE CLO EXPORT, ALL THE WAY TO A REOPENABLE DRAPE.
//
// ── WHY THIS SUITE EXISTS SEPARATELY ────────────────────────────────────────
// Every other R&D suite runs on a hand-built fixture whose corner indices were
// chosen so that seams line up. That is the right way to test a rule and it proves
// nothing about a real file: `clo-tshirt-aama.dxf` is a CLO 7.1.178 export with
// five pieces, declared in INCHES, publishing AAMA layers 1, 2, 3, 7 and 8 and no
// notch layer, no mirror line and no sewing line. Its pieces are called
// `Pattern_636968`.
//
// So this walks one real file through the whole record: import, describe, save,
// read back, ask for a drape, report one, reopen it against its own revision,
// edit the pattern, and watch the old drape go out of date without changing.
//
// ── WHAT IT DOES NOT COVER ──────────────────────────────────────────────────
// The browser. The solver itself runs in the page, and whether a Draft drape of
// this file settles is proved in `grav-cms/components/rnd/fit/*.test.mjs` against
// the same file. This suite is the record half.
"use strict";

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Account = require("../../models/CMS_Models/Sales/Account");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const { RenderJob, RENDER_STATUS } = require("../../models/CMS_Models/RnD/PatternRevision");

const { inspectDxf } = require("../../utils/dxfInspect");
const mapping = require("../../services/rnd/patternMapping.service");
const patterns = require("../../services/rnd/patternRevision.service");
const renders = require("../../services/rnd/garmentRender.service");
const simulation = require("../../services/rnd/simulationAdapter.service");

const DXF = path.join(__dirname, "..", "fixtures", "rnd", "clo-tshirt-aama.dxf");

let seq = 0;
async function world() {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `Real DXF Co ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const account = await Account.create({ companyName: `Buyer ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-RD-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-RD-${n}`, styleCode: `SC-RD-${n}`, productName: "Short-sleeve tee",
    journeyId: journey._id, accountId: account._id, stage: "rnd",
    techSheet: { status: "pending" },
  });
  return {
    style, ctx: { companyId: co._id },
    actor: { id: `rd${n}`, name: "A Patternmaker", email: `rd${n}@grav.test` },
  };
}

const withAdapter = async (fn) => {
  process.env.RND_SIMULATION_ADAPTER = "in-app";
  try { return await fn(); } finally { delete process.env.RND_SIMULATION_ADAPTER; }
};

const confirmed = () => ({ confirmed: true });

/** The parsed file, with pieceRefs minted exactly as a real import mints them. */
function parsedPatternSet() {
  const parsed = inspectDxf(fs.readFileSync(DXF));
  return {
    parsed,
    patternSet: {
      patternSetRef: "PS-REAL-1",
      classification: "apparel_pattern_set",
      manifest: { styleName: "Short-sleeve tee", sampleSize: "M" },
      unit: parsed.unit,
      unitSource: parsed.unitSource,
      unitInMm: parsed.unitInMm,
      pieces: parsed.pieces.map((p, i) => ({ ...p, pieceRef: mapping.mintPieceRef(p, i) })),
      grading: parsed.grading
        || { graded: false, sizes: [], sizeCount: 0, gradePointsPublished: false, pieces: [] },
      stats: parsed.stats || {},
    },
  };
}

/**
 * Describe the real file the way a person would on the screen.
 *
 * Roles are ASSIGNED — nothing is read from `Pattern_636968`. Runs are derived
 * from the piece's own consecutive corners, which is what the mapping screen
 * offers. Both sleeves are separate outlines at quantity 1, which is Form B.
 */
function describeIt(patternSet) {
  const byArea = [...patternSet.pieces].sort((a, b) => (b.area || 0) - (a.area || 0));
  const bodies = byArea.slice(0, 2);
  const sleeves = byArea.slice(2, 4);
  const band = byArea[4];

  /* ── RUNS BETWEEN PUBLISHED TURN POINTS ───────────────────────────────
     Mirrors `grav-cms/components/rnd/fit/seamMapping.js` runsFor. One run per
     consecutive pair of outline POINTS would give 125 runs a few millimetres long
     on this file — 112 of its 125 points are curve points — and a seam built from
     one of them joins two edges of nearly zero length. Turn points give the edges
     a person would actually name. */
  const nearestIndex = (outline, mark) => {
    let best = -1;
    let bestD = Infinity;
    outline.forEach((p, i) => {
      const d = Math.hypot(p.x - mark.x, p.y - mark.y);
      if (d < bestD) { bestD = d; best = i; }
    });
    return bestD < 1 ? best : -1;
  };
  const runsOf = (piece) => {
    const outline = piece.outline || [];
    const n = outline.length;
    const marks = [...new Set((piece.turnPoints || [])
      .map((m) => nearestIndex(outline, m))
      .filter((i) => i >= 0))].sort((a, b) => a - b);
    const starts = marks.length >= 3 ? marks : outline.map((_, i) => i);
    const runs = [];
    for (let k = 0; k < starts.length; k += 1) {
      const from = starts[k];
      const to = starts[(k + 1) % starts.length];
      if (from === to) continue;
      runs.push({
        runId: `t${from}-${to}`,
        startAnchor: { kind: "turn-point", pointIndex: from },
        endAnchor: { kind: "turn-point", pointIndex: to },
        direction: "forward",
        role: "",
      });
    }
    return runs;
  };

  const plan = (piece, role) => ({
    pieceRef: piece.pieceRef,
    role,
    roleConfirmed: confirmed(),
    cutQuantity: 1,
    /* Both sleeves are SEPARATE outlines at quantity 1 — Form B — which is what
       this export actually produces. Nothing is merged or deleted. */
    symmetry: "single",
    layer: role === "neck.band" ? "rib" : "shell",
    /* Layer 7 is published on every piece of this export, so the vector is
       DERIVED. It is read in the piece's own frame, never off the marker: every
       piece on a marker carries a grainline parallel to the selvedge. */
    grainVector: [0, 1],
    grainSource: "marker-grainline",
    runs: runsOf(piece),
    /* One confirmation for the whole remaining perimeter, not one per edge. */
    boundaryConfirmed: confirmed(),
  });

  const seam = (seamId, name, a, b, role) => ({
    seamId, name, sideA: a, sideB: b, runRole: role,
    alignment: "start-to-start",
    alignmentConfirmed: confirmed(),
    confidence: "confirmed",
    seamType: "overlocked",
  });
  /* ── PICKING EDGES THAT ARE ACTUALLY THE SAME LENGTH ──────────────────
     Not inference, and not what the product does — a person names these on the
     screen. Here the test picks them by length so that it is exercising the
     record and not accidentally asserting a seam mismatch. */
  const plans = {
    front: plan(bodies[0], "body.front"),
    back: plan(bodies[1], "body.back"),
    sleeveL: plan(sleeves[0], "sleeve"),
    sleeveR: plan(sleeves[1], "sleeve"),
    band: plan(band, "neck.band"),
  };
  const mmOf = (piece, run) => {
    const o = piece.outline;
    let total = 0;
    let i = run.startAnchor.pointIndex;
    while (i !== run.endAnchor.pointIndex) {
      const j = (i + 1) % o.length;
      total += Math.hypot(o[j].x - o[i].x, o[j].y - o[i].y);
      i = j;
    }
    return total * (patternSet.unitInMm || 1);
  };
  const pick = (piece, plan_, want) => {
    let best = plan_.runs[0];
    let bestD = Infinity;
    for (const run of plan_.runs) {
      const d = Math.abs(mmOf(piece, run) - want);
      if (d < bestD) { bestD = d; best = run; }
    }
    return { pieceRef: plan_.pieceRef, runId: best.runId, run: best };
  };
  /* A 400 mm run exists on both bodies — the shoulder/armhole edge. */
  const a = pick(bodies[0], plans.front, 400);
  const b = pick(bodies[1], plans.back, 400);
  /* The band's long edge against the back's longest, inside the 25% a band join
     allows: a neck band is SHORTER than the opening and is stretched on. */
  const bandEdge = pick(band, plans.band, 534);
  const neckEdge = pick(bodies[1], plans.back, 608);
  const matched = { a, b, band: bandEdge, neck: neckEdge };
  /* The seam's role is carried on the RUNS it names, which is where the ease
     allowance is looked up from. */
  for (const [entry, role] of [[a, "shoulder"], [b, "shoulder"],
    [bandEdge, "join"], [neckEdge, "join"]]) {
    entry.run.role = role;
  }

  return {
    template: "tshirt",
    renderSize: "M",
    avatar: {
      name: "Male M",
      size: "M",
      measurements: { chestMm: 1000, heightMm: 1750, bicepMm: 320, neckMm: 400 },
      scaleVerifiedAgainst: "measured sample, chest 100 cm",
    },
    pieces: [plans.front, plans.back, plans.sleeveL, plans.sleeveR, plans.band],
    /* ── TWO SEAMS, AND THE SECOND ONE IS REQUIRED ────────────────────────
       A shoulder, and the neck band's join. The band is in this pattern, so
       leaving it unmapped is a readiness FAILURE (R12) rather than the partial a
       missing band would be: a piece that exists and is half-joined is an
       unfinished mapping, and draping around it would silently exclude cloth the
       pattern-maker drew. */
    seams: [
      seam("S-SH-R", "Right shoulder",
        [{ pieceRef: matched.a.pieceRef, runId: matched.a.runId }],
        [{ pieceRef: matched.b.pieceRef, runId: matched.b.runId }], "shoulder"),
      seam("S-NECK", "Neck band join",
        [{ pieceRef: matched.band.pieceRef, runId: matched.band.runId }],
        [{ pieceRef: matched.neck.pieceRef, runId: matched.neck.runId }], "join"),
    ],
    fabrics: [{
      profileId: "FP-JERSEY-REAL",
      name: "Cotton jersey 180",
      appliesTo: [],
      behaviour: "knit",
      behaviourConfirmed: confirmed(),
      grade: "measured",
      source: "lab test",
      weightGsm: 180,
      thicknessMm: 0.62,
      collisionOffsetMm: 1.5,
      stretchWarpPercent: 60,
      stretchWeftPercent: 95,
      stretchLoadN: 5,
      shearStiffness: 0.2,
      bendingRigidity: 0.4,
      damping: 0.9,
      frictionBody: 0.5,
      frictionSelf: 0.45,
    }],
    seamAllowanceMm: 10,
  };
}

const drapeFrom = (patternSet, inputs) => {
  const refs = inputs.pieces.map((p) => p.pieceRef);
  const per = 4;
  const vertexCount = refs.length * per;
  const positions = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i += 1) {
    positions[i * 3] = i * 10;
    positions[i * 3 + 1] = 1200 + i;
    positions[i * 3 + 2] = 40;
  }
  return {
    solverVersion: "fit-1.0",
    quality: "draft",
    sewingLineSource: "derived",
    authoritative: true,
    seamAllowanceMm: 10,
    withheld: [],
    geometryIdentity: "real-dxf-5-piece-draft-fit-1.0",
    fabric: { id: "FP-JERSEY-REAL", label: "Cotton jersey 180", version: "FP-JERSEY-REAL" },
    unit: "mm",
    vertexCount,
    triangleCount: 10,
    pieces: refs.map((pieceRef, i) => ({
      pieceRef, name: pieceRef, role: "", base: i * per, vertexCount: per,
    })),
    positions: Buffer.from(positions.buffer).toString("base64"),
    seamClosure: [{ name: "Right shoulder", worstGapMm: 3.1, meanGapMm: 0.8, sourceLengthMm: 180, stations: 11 }],
    strain: { maxPercent: 9.4, meanPercent: 0.6 },
    fidelity: { ok: true, worstBoundaryMm: 0, worstSeamMm: 0 },
    tightestClearanceMm: 2.2,
    template: { id: "tshirt", label: "Basic T-shirt", confidence: 1 },
    body: { kind: "capsules", estimated: true },
    frames: 267,
    finalMoveMm: 1.16,
    msElapsed: 4100,
  };
};

/* ═══════════════════════════════════════════════════════════════════════════ */

describe("the genuine CLO export, from file to reopenable drape", () => {
  test("the file is what this house actually exports", () => {
    const { parsed } = parsedPatternSet();
    /* Five pieces, declared in INCHES — the unit is read, never assumed, and
       assuming millimetres here would be a 25.4x error no shape reveals. */
    expect(parsed.pieces).toHaveLength(5);
    expect(parsed.unit).toBe("in");
    expect(parsed.unitInMm).toBeCloseTo(25.4, 5);
    /* Names carry no garment meaning, which is why roles are assigned. */
    expect(parsed.pieces.every((p) => /^Pattern_\d+$/.test(p.name))).toBe(true);
    /* No notches and no mirror line are published, so anchors fall back to turn
       points and cut-on-fold has to be stated by a person. */
    expect(parsed.pieces.every((p) => (p.notches || []).length === 0)).toBe(true);
    /* A grainline IS published on every piece, so the vector is derived. */
    expect(parsed.pieces.every((p) => p.grainline && p.grainline.from && p.grainline.to)).toBe(true);
  });

  test("ONE: it imports, and readiness names exactly what a person must still say", async () => {
    const w = await world();
    const { patternSet } = parsedPatternSet();
    const imported = (await patterns.importRevision(w.ctx, {
      styleId: w.style._id,
      patternSet,
      sourceDxf: { driveFileId: "live-1", name: "clo-tshirt-aama.dxf", sha256: "b".repeat(64), bytes: 4096 },
      name: "Imported from CLO",
      actor: w.actor,
    })).revision;

    expect(imported.state).toBe("draft");
    /* Nothing is guessed: straight off the file the drape is refused, and the
       steps still needed are the ones only a person can supply. */
    expect(imported.readiness.ready).toBe(false);
    const steps = imported.readiness.missing.map((m) => m.key);
    expect(steps).toEqual(expect.arrayContaining(["template", "size", "body", "roles", "seams"]));
    /* And the vocabulary the screen offers comes from the server, so a screen
       cannot offer a role the template does not declare. */
    expect(imported.vocabulary.templates.map((t) => t.id)).toContain("tshirt");
    expect(imported.vocabulary.seamAlignments).toContain("start-to-start");
  });

  test("TWO: described, saved and READ BACK — the setup survives a reload", async () => {
    const w = await world();
    const { patternSet } = parsedPatternSet();
    const imported = (await patterns.importRevision(w.ctx, {
      styleId: w.style._id, patternSet, name: "Imported from CLO", actor: w.actor,
      sourceDxf: { driveFileId: "live-1", name: "clo.dxf", sha256: "b".repeat(64), bytes: 4096 },
    })).revision;

    const described = describeIt(patternSet);
    await patterns.setSimulationInputs(w.ctx, {
      revisionId: imported.id, inputs: described, actor: w.actor,
    });

    /* The reload. A response is not evidence: Mongoose strips undeclared paths
       silently, which is how a seam map came to be "saved" and not stored. */
    const fresh = await patterns.readRevision(w.ctx, { revisionId: imported.id });
    const held = fresh.revision.simulationInputs;

    expect(held.template).toBe("tshirt");
    expect(held.renderSize).toBe("M");
    expect(held.avatar.measurements.chestMm).toBe(1000);
    expect(held.pieces).toHaveLength(5);
    expect(held.pieces.map((p) => p.role).sort())
      .toEqual(["body.back", "body.front", "neck.band", "sleeve", "sleeve"]);
    for (const plan of held.pieces) {
      expect(plan.roleConfirmed?.at).toBeTruthy();
      expect(plan.boundaryConfirmed?.at).toBeTruthy();
      expect(plan.grainVector).toEqual([0, 1]);
      expect(plan.runs.length).toBeGreaterThan(2);
    }
    /* Two: a shoulder and the band join. The band is IN this pattern, so
       leaving it unmapped would be a refusal (R12), not a partial. */
    expect(held.seams).toHaveLength(2);
    expect(held.seams[0].alignment).toBe("start-to-start");
    expect(held.seams[0].alignmentConfirmed?.at).toBeTruthy();
    expect(held.fabrics[0].grade).toBe("measured");
    expect(held.seamAllowanceMm).toBe(10);
    expect(held.seamPairings).toBeUndefined();

    /* And it is now ready — a PARTIAL, because this export has a neck band but
       the pack still withholds what the band cannot settle. */
    expect(fresh.revision.readiness.ready)
      .toBe(true, JSON.stringify(fresh.revision.readiness.failures, null, 1));
    expect(fresh.revision.readiness.sewingLine.source).toBe("derived");
  });

  test("THREE: a drape is asked for, reported, and reopened against ITS OWN revision", async () => {
    const w = await world();
    const { patternSet } = parsedPatternSet();
    const imported = (await patterns.importRevision(w.ctx, {
      styleId: w.style._id, patternSet, name: "Imported from CLO", actor: w.actor,
      sourceDxf: { driveFileId: "live-1", name: "clo.dxf", sha256: "b".repeat(64), bytes: 4096 },
    })).revision;
    const described = describeIt(patternSet);
    const ready = (await patterns.setSimulationInputs(w.ctx, {
      revisionId: imported.id, inputs: described, actor: w.actor,
    })).revision;

    const job = (await withAdapter(() => renders.requestRender(w.ctx, {
      revisionId: ready.id, actor: w.actor,
    }))).render;
    expect(job.status).toBe(RENDER_STATUS.SIMULATING);
    /* The page owns the drape and holds a lease on it. */
    expect(job.engine.runsInBrowser).toBe(true);

    /* It beats while it solves, with the LEASE's run id. */
    const beat = await renders.heartbeat(w.ctx, {
      jobRef: job.jobRef, runId: "lease-live-1", actor: w.actor,
    });
    expect(beat.holding).toBe(true);
    expect(beat.heartbeatMs).toBeGreaterThan(0);

    await renders.recordRenderOutcome(w.ctx, {
      jobRef: job.jobRef,
      status: "completed",
      drape: drapeFrom(patternSet, described),
      actor: w.actor,
    });

    const read = await renders.readDrape(w.ctx, { jobRef: job.jobRef });
    /* The drape names its own revision and hands back that revision's pattern and
       the job's FROZEN setup — so a page rebuilding it never uses whichever
       revision happens to be selected. */
    expect(read.patternRevisionRef).toBe(ready.revisionRef);
    expect(read.patternSet.pieces).toHaveLength(5);
    expect(read.inputs.seams).toHaveLength(2);
    expect(read.geometryIdentity).toBe("real-dxf-5-piece-draft-fit-1.0");
    expect(read.sewingLineSource).toBe("derived");
    expect(read.vertexCount).toBe(20);
  });

  test("FOUR: editing the pattern makes the next revision and the drape goes OUT OF DATE", async () => {
    const w = await world();
    const { patternSet } = parsedPatternSet();
    const imported = (await patterns.importRevision(w.ctx, {
      styleId: w.style._id, patternSet, name: "Imported from CLO", actor: w.actor,
      sourceDxf: { driveFileId: "live-1", name: "clo.dxf", sha256: "b".repeat(64), bytes: 4096 },
    })).revision;
    const described = describeIt(patternSet);
    const ready = (await patterns.setSimulationInputs(w.ctx, {
      revisionId: imported.id, inputs: described, actor: w.actor,
    })).revision;
    const job = (await withAdapter(() => renders.requestRender(w.ctx, {
      revisionId: ready.id, actor: w.actor,
    }))).render;
    await renders.recordRenderOutcome(w.ctx, {
      jobRef: job.jobRef, status: "completed",
      drape: drapeFrom(patternSet, described), actor: w.actor,
    });

    const before = await RenderJob.findOne({ jobRef: job.jobRef }).lean();
    const geometryBefore = JSON.stringify(before.drape.pieces);
    const positionsBefore = before.drape.positions.toString("base64");

    /* An edit does not change a revision — it makes the next one. */
    const next = (await patterns.editRevision(w.ctx, {
      revisionId: ready.id,
      operations: [{
        kind: "rename",
        pieceRef: patternSet.pieces[0].pieceRef,
        name: "Front body (named by the pattern room)",
      }],
      actor: w.actor,
    })).revision;
    expect(next.revisionNumber).toBe(ready.revisionNumber + 1);

    /* The old drape is OUT OF DATE and is not re-pointed at the new revision. */
    const list = await renders.listRenders(w.ctx, { styleId: w.style._id });
    const mine = list.renders.find((r) => r.jobRef === job.jobRef);
    expect(mine.stale).toBe(true);
    expect(mine.patternRevisionNumber).toBe(ready.revisionNumber);

    /* And it is UNCHANGED: a fitting is a statement about one revision and
       expires with it rather than being quietly updated. */
    const after = await RenderJob.findOne({ jobRef: job.jobRef }).lean();
    expect(after.patternRevisionRef).toBe(before.patternRevisionRef);
    expect(JSON.stringify(after.drape.pieces)).toBe(geometryBefore);
    expect(after.drape.positions.toString("base64")).toBe(positionsBefore);
    expect(after.drape.geometryIdentity).toBe(before.drape.geometryIdentity);
  });

  test("FIVE: the pattern itself is byte-identical through all of it", async () => {
    const w = await world();
    const { patternSet } = parsedPatternSet();
    const imported = (await patterns.importRevision(w.ctx, {
      styleId: w.style._id, patternSet, name: "Imported from CLO", actor: w.actor,
      sourceDxf: { driveFileId: "live-1", name: "clo.dxf", sha256: "b".repeat(64), bytes: 4096 },
    })).revision;
    const described = describeIt(patternSet);
    const ready = (await patterns.setSimulationInputs(w.ctx, {
      revisionId: imported.id, inputs: described, actor: w.actor,
    })).revision;

    const read = await patterns.readRevision(w.ctx, { revisionId: ready.id, geometry: true });
    const frozen = JSON.stringify(read.revision.patternSet);

    const job = (await withAdapter(() => renders.requestRender(w.ctx, {
      revisionId: ready.id, actor: w.actor,
    }))).render;
    await renders.heartbeat(w.ctx, { jobRef: job.jobRef, runId: "lease-x", actor: w.actor });
    await renders.recordRenderOutcome(w.ctx, {
      jobRef: job.jobRef, status: "completed",
      drape: drapeFrom(patternSet, described), actor: w.actor,
    });
    await renders.readDrape(w.ctx, { jobRef: job.jobRef });

    const after = await patterns.readRevision(w.ctx, { revisionId: ready.id, geometry: true });
    expect(JSON.stringify(after.revision.patternSet)).toBe(frozen);
  });

  test("SIX: a stopped run and an abandoned run end differently, and both free the revision", async () => {
    const w = await world();
    const { patternSet } = parsedPatternSet();
    const imported = (await patterns.importRevision(w.ctx, {
      styleId: w.style._id, patternSet, name: "Imported from CLO", actor: w.actor,
      sourceDxf: { driveFileId: "live-1", name: "clo.dxf", sha256: "b".repeat(64), bytes: 4096 },
    })).revision;
    const described = describeIt(patternSet);
    const ready = (await patterns.setSimulationInputs(w.ctx, {
      revisionId: imported.id, inputs: described, actor: w.actor,
    })).revision;

    /* STOPPED: the reader pressed Stop, and the page says so. */
    const first = (await withAdapter(() => renders.requestRender(w.ctx, {
      revisionId: ready.id, actor: w.actor,
    }))).render;
    await renders.recordRenderOutcome(w.ctx, {
      jobRef: first.jobRef, status: "cancelled",
      failure: { code: "DRAPE_CANCELLED", message: "This preview was stopped." },
      actor: w.actor,
    });
    const stopped = await RenderJob.findOne({ jobRef: first.jobRef }).lean();
    expect(stopped.failure.code).toBe("DRAPE_CANCELLED");
    expect(stopped.recovery?.recoveredAt).toBeFalsy();

    /* ABANDONED: the tab closed. A different sentence, and recoverable. */
    const second = (await withAdapter(() => renders.requestRender(w.ctx, {
      revisionId: ready.id, actor: w.actor,
    }))).render;
    await renders.heartbeat(w.ctx, { jobRef: second.jobRef, runId: "lease-dead", actor: w.actor });
    await RenderJob.updateOne({ jobRef: second.jobRef },
      { $set: { "lease.expiresAt": new Date(Date.now() - 1000) } });

    const stuck = (await renders.listAbandoned(w.ctx, { styleId: w.style._id })).abandoned;
    expect(stuck.map((j) => j.jobRef)).toEqual([second.jobRef]);

    await renders.recoverAbandoned(w.ctx, { jobRef: second.jobRef, actor: w.actor });
    const cleared = await RenderJob.findOne({ jobRef: second.jobRef }).lean();
    expect(cleared.failure.code).toBe("DRAPE_ABANDONED");
    expect(cleared.recovery.recoveredAt).toBeTruthy();

    /* Either way the revision is free, which is the point of the lease. */
    const third = await withAdapter(() => renders.requestRender(w.ctx, {
      revisionId: ready.id, actor: w.actor,
    }));
    expect(third.render.jobRef).not.toBe(second.jobRef);
  });
});
