// test/rnd/fit-readiness.test.js
//
// THE VALIDATION MATRIX, AS TESTS.
//
// `docs/product/rnd-fit/validation-matrix.md` states twenty product cases: six
// that must produce a fitting, eight that must refuse, five that must run and
// hold findings back, and one — VM-11 — that is in the pack to be written down
// rather than passed, because nothing in the specification detects it.
//
// These are the ones that can be decided from readiness alone, which is most of
// them: a refusal is a readiness answer, and so is which findings a drape may not
// report. The ones that need a draped garment live in the frontend suites.
//
// ── WHY THEY ARE HERE AND NOT ONLY IN THE FRONTEND ──────────────────────────
// Because the server is what refuses. A screen that decided readiness for itself
// could enable a button the server would reject, which is exactly what happened:
// "Drape this revision" was enabled because one seam was mapped while the server
// would have refused for four other reasons. There is one implementation and this
// suite is pointed at it.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const readiness = require("../../services/rnd/fitReadiness.service");
const simulation = require("../../services/rnd/simulationAdapter.service");
const templates = require("../../services/rnd/fitTemplates");
const tee = require("./fixtures/renderableTee");

const REV = { revisionRef: "PR-1", mappingConfirmedAgainstRef: "PR-1" };
const clone = (x) => JSON.parse(JSON.stringify(x));

const assess = (patternSet, inputs, opts = REV) => readiness.assess(patternSet, inputs, opts);
const codes = (result) => [...new Set(result.failures.map((f) => f.code))].sort();
const withheldFindings = (result) => result.withheld.map((w) => w.finding);

/* ═══ THE ONE IMPLEMENTATION ══════════════════════════════════════════════ */

describe("readiness is computed once and used by everything", () => {
  test("the adapter's checkInputs IS the readiness assessment, not a second opinion", () => {
    /* The parity requirement. These two were separate once, and a reader pressing
       an enabled button and being refused learns to distrust the screen rather
       than the pattern. */
    const direct = assess(tee.patternSet(), tee.simulationInputs());
    const viaAdapter = simulation.checkInputs(tee.patternSet(), tee.simulationInputs(), REV);

    expect(viaAdapter.ready).toBe(direct.ready);
    expect(viaAdapter.outcome).toBe(direct.outcome);
    expect(codes(viaAdapter)).toEqual(codes(direct));
    expect(withheldFindings(viaAdapter)).toEqual(withheldFindings(direct));
    expect(viaAdapter.sewingLine).toEqual(direct.sewingLine);
    expect(viaAdapter.steps.map((s) => s.key)).toEqual(direct.steps.map((s) => s.key));
  });

  test("every step the setup flow shows is a step readiness decides", () => {
    const result = assess(tee.patternSet(), tee.simulationInputs());
    expect(result.steps.map((s) => s.key)).toEqual([
      "template", "size", "body", "fabric", "roles", "grain", "sewingLine", "seams", "boundary",
    ]);
    /* Each one says what it is for, in the words the screen shows. */
    for (const step of result.steps) {
      expect(step.label.length).toBeGreaterThan(8);
      expect(typeof step.done).toBe("boolean");
    }
  });

  test("a step is done only when nothing in it fails", () => {
    const inputs = clone(tee.simulationInputs());
    inputs.template = "";
    const result = assess(tee.patternSet(), inputs);
    const step = result.steps.find((s) => s.key === "template");
    expect(step.done).toBe(false);
    expect(step.failures.length).toBeGreaterThan(0);
    expect(result.ready).toBe(false);
  });

  test("ONE MAPPED SEAM IS NOT READINESS", () => {
    /* The specific defect this replaces: the screen enabled "Drape this
       revision" because a seam existed, and the server would then refuse for
       four other reasons. A seam count is not a readiness answer. */
    const result = assess(tee.patternSet(), {
      seams: [tee.simulationInputs().seams[0]],
    });
    expect(result.ready).toBe(false);
    expect(codes(result)).toEqual(expect.arrayContaining(["R3", "R5", "R9"]));
    /* And the step that IS satisfied does not carry the others. */
    expect(result.steps.filter((s) => !s.done).length).toBeGreaterThan(4);
  });
});

/* ═══ GROUP A — MUST PRODUCE A FITTING ════════════════════════════════════ */

describe("Group A · patterns that must be draped", () => {
  test("VM-04-shaped · a fully mapped tee with a neck band is a fitting", () => {
    const result = assess(
      tee.patternSet({ withNeckBand: true }),
      tee.simulationInputs({ withNeckBand: true }),
    );
    expect(result.failures).toEqual([]);
    expect(result.ready).toBe(true);
    expect(result.outcome).toBe("fitting");
    expect(result.withheld).toEqual([]);
    expect(result.sewingLine.source).toBe("derived");
    expect(result.fabric.grade).toBe("measured");
  });

  test("VM-02 · the two sleeves are confirmed independently and the evidence says so", () => {
    const result = assess(
      tee.patternSet({ withNeckBand: true }),
      tee.simulationInputs({ withNeckBand: true }),
    );
    const armholes = result.seams.filter((s) => /armhole/i.test(s.name));
    expect(armholes).toHaveLength(2);
    /* Neither inherited the other's confirmation. */
    expect(result.warnings.filter((w) => w.code === "W9")).toEqual([]);
  });

  test("VM-03 · a propagated confirmation runs, and is marked weaker (W9)", () => {
    const inputs = clone(tee.simulationInputs({ withNeckBand: true }));
    const left = inputs.seams.find((s) => s.seamId === "S-ARM-L");
    left.propagatedFrom = { seamId: "S-ARM-R", side: "sideA" };
    const result = assess(tee.patternSet({ withNeckBand: true }), inputs);
    expect(result.ready).toBe(true);
    const w9 = result.warnings.find((w) => w.code === "W9");
    expect(w9).toBeDefined();
    expect(w9.message).toMatch(/S-ARM-R/);
    expect(w9.message).toMatch(/rather than being confirmed independently/);
  });

  test("the compound armhole is accepted: one cap run onto two body runs in order", () => {
    const inputs = tee.simulationInputs({ withNeckBand: true });
    const armhole = inputs.seams.find((s) => s.seamId === "S-ARM-R");
    expect(armhole.sideA).toHaveLength(1);
    expect(armhole.sideB).toHaveLength(2);
    expect(armhole.sideB.map((e) => e.pieceRef)).toEqual(["PC-FRONT", "PC-BACK"]);
    const result = assess(tee.patternSet({ withNeckBand: true }), inputs);
    expect(codes(result)).not.toContain("R6");
    const reviewed = result.seams.find((s) => s.seamId === "S-ARM-R");
    /* A 580 cap onto 2 x 288.8 of armhole — inside the 5% the template allows. */
    expect(reviewed.easePercent).toBeLessThan(1);
    expect(reviewed.allowedPercent).toBe(5);
  });
});

/* ═══ GROUP B — MUST REFUSE ═══════════════════════════════════════════════ */

describe("Group B · patterns that must be refused", () => {
  test("VM-07 · no unit · R2, and millimetres are not assumed", () => {
    const patternSet = tee.patternSet();
    patternSet.unit = "";
    patternSet.unitInMm = null;
    const result = assess(patternSet, tee.simulationInputs());
    expect(codes(result)).toContain("R2");
    const r2 = result.failures.find((f) => f.code === "R2");
    expect(r2.message).toMatch(/25\.4/);
    expect(r2.message).toMatch(/not assumed/);
  });

  test("VM-08 · a required role unassigned · R3, naming the pieces", () => {
    const inputs = clone(tee.simulationInputs());
    inputs.pieces = inputs.pieces.filter((p) => !p.pieceRef.startsWith("PC-SLV"));
    const result = assess(tee.patternSet(), inputs);
    expect(codes(result)).toContain("R3");
    const r3 = result.failures.find((f) => f.code === "R3" && /no role yet/.test(f.message));
    expect(r3.pieceRefs).toEqual(expect.arrayContaining(["PC-SLV-L", "PC-SLV-R"]));
  });

  test("VM-09 · a seam with no confirmed alignment · R4, naming that seam", () => {
    const inputs = clone(tee.simulationInputs());
    const armhole = inputs.seams.find((s) => s.seamId === "S-ARM-L");
    armhole.alignmentConfirmed = null;
    const result = assess(tee.patternSet(), inputs);
    expect(codes(result)).toContain("R4");
    const r4 = result.failures.find((f) => f.code === "R4");
    expect(r4.message).toMatch(/Left armhole/);
    expect(r4.message).toMatch(/nobody has confirmed/);
    expect(r4.seamId).toBe("S-ARM-L");
  });

  test("an alignment stated but never confirmed is not an alignment", () => {
    const inputs = clone(tee.simulationInputs());
    const seam = inputs.seams[0];
    seam.alignment = "";
    seam.alignmentConfirmed = null;
    const result = assess(tee.patternSet(), inputs);
    const r4 = result.failures.find((f) => f.code === "R4" && f.seamId === seam.seamId);
    expect(r4.message).toMatch(/which end meets which/);
    /* The sentence a reader needs: this is the one nothing downstream catches. */
    expect(r4.message).toMatch(/nothing afterwards flags it/);
  });

  test("VM-10 · a compound side with a gap in it · R6, and nothing is re-ordered", () => {
    const inputs = clone(tee.simulationInputs());
    const armhole = inputs.seams.find((s) => s.seamId === "S-ARM-R");
    /* Two runs on the same piece that do not meet. */
    armhole.sideB = [
      { pieceRef: "PC-FRONT", runId: "armhole-r" },
      { pieceRef: "PC-FRONT", runId: "side-l" },
    ];
    const result = assess(tee.patternSet(), inputs);
    expect(codes(result)).toContain("R6");
    const r6 = result.failures.find((f) => f.code === "R6");
    expect(r6.message).toMatch(/gap/);
    expect(r6.message).toMatch(/not re-ordered/);
  });

  test("VM-10 · a compound side that changes direction part-way · R6", () => {
    const inputs = clone(tee.simulationInputs());
    const back = inputs.pieces.find((p) => p.pieceRef === "PC-BACK");
    back.runs.find((r) => r.runId === "armhole-l").direction = "reverse";
    const result = assess(tee.patternSet(), inputs);
    const r6 = result.failures.find((f) => f.code === "R6");
    expect(r6).toBeDefined();
    expect(r6.message).toMatch(/changes direction/);
  });

  test("a compound side cannot cross a join that does not exist · R6", () => {
    /* An armhole running from the front onto the back when the two are not sewn
       to each other anywhere. */
    const inputs = clone(tee.simulationInputs());
    inputs.seams = inputs.seams.filter((s) => s.seamId.startsWith("S-ARM"));
    const result = assess(tee.patternSet(), inputs);
    const r6 = result.failures.find((f) => f.code === "R6");
    expect(r6).toBeDefined();
    expect(r6.message).toMatch(/not sewn to each other anywhere/);
  });

  test("VM-12 · ease beyond the template's allowance · R7, with both lengths", () => {
    const inputs = clone(tee.simulationInputs());
    const sleeve = inputs.pieces.find((p) => p.pieceRef === "PC-SLV-R");
    sleeve.runs.find((r) => r.runId === "cap").lengthMm = tee.ARMHOLE_LEN * 2 * 1.18;
    const result = assess(tee.patternSet(), inputs);
    const r7 = result.failures.find((f) => f.code === "R7");
    expect(r7).toBeDefined();
    expect(r7.message).toMatch(/cm and/);
    expect(r7.message).toMatch(/allows 5%/);
    expect(r7.message).toMatch(/do not fit each other/);
    /* Raised on DECLARED lengths, before any mesh exists. */
    expect(r7.aLengthMm).toBeGreaterThan(0);
    expect(r7.bLengthMm).toBeGreaterThan(0);
  });

  test("a neck band 15% shorter than its opening is NOT a mismatch — it is stretched on", () => {
    /* The reason ease allowances are per seam role. A single global tolerance
       would refuse every neck band or accept a sleeve cap on the wrong armhole. */
    const inputs = clone(tee.simulationInputs({ withNeckBand: true }));
    const band = inputs.pieces.find((p) => p.pieceRef === "PC-BAND");
    band.runs.find((r) => r.runId === "join").lengthMm = tee.NECK_LEN * 2 * 0.85;
    const result = assess(tee.patternSet({ withNeckBand: true }), inputs);
    expect(codes(result)).not.toContain("R7");
    expect(result.ready).toBe(true);
  });

  test("VM-13 · uncovered perimeter never confirmed · R5, showing the portions", () => {
    const inputs = clone(tee.simulationInputs());
    for (const piece of inputs.pieces) piece.boundaryConfirmed = null;
    const result = assess(tee.patternSet(), inputs);
    const r5 = result.failures.find((f) => f.code === "R5");
    expect(r5).toBeDefined();
    /* Shown on the piece, so somebody agrees to something they can see. */
    expect(r5.pieces.length).toBe(4);
    for (const piece of r5.pieces) {
      expect(piece.uncoveredMm).toBeGreaterThan(0);
      expect(piece.name.length).toBeGreaterThan(0);
    }
    /* One confirmation per piece, not one per edge. */
    expect(r5.message).toMatch(/once per piece rather than edge by edge/);
  });

  test("R7 DOES NOT REFUSE A SEAM FOR FLOATING-POINT NOISE, AND STILL REFUSES A REAL GAP", () => {
    /* A side seam allows 0% ease, which is the right rule and was being applied
       to lengths summed in floating point. The genuine tee's two side seams are
       400.2140 mm each and differ in the last bits of a double, so the garment was
       refused for being "0.0% apart where this seam allows 0%". */
    const patternSet = tee.patternSet();
    const inputs = clone(tee.simulationInputs());
    const side = inputs.seams.find((seam) => {
      const entry = seam.sideA?.[0];
      const plan = inputs.pieces.find((p) => p.pieceRef === entry?.pieceRef);
      return (plan?.runs || []).find((r) => r.runId === entry?.runId)?.role === "side";
    });
    expect(side).toBeDefined();
    const runFor = (entry) => inputs.pieces.find((p) => p.pieceRef === entry.pieceRef)
      .runs.find((r) => r.runId === entry.runId);
    const a = runFor(side.sideA[0]);
    const b = runFor(side.sideB[0]);

    /* The same length, as a double reaches it by two different additions. */
    a.lengthMm = 400.214;
    b.lengthMm = 400.21400000000006;
    expect(codes(assess(patternSet, inputs))).not.toContain("R7");

    /* Half a percent out is a pattern fault and still refuses — the floor is a
       millimetre, not a licence. */
    b.lengthMm = 400.214 + 2.1;
    const refused = assess(patternSet, inputs).failures.find((f) => f.code === "R7");
    expect(refused).toBeDefined();
    expect(refused.differenceMm).toBeCloseTo(2.1, 5);
    /* And the sentence says how far apart in centimetres, so it never reads as
       "0.0% apart, where this seam allows 0%". */
    expect(refused.message).toMatch(/cm apart/);
  });

  test("R5 COUNTS COVERAGE IN ONE UNIT · an inch pattern is not covered by one seam", () => {
    /* The defect this pins. A piece's perimeter is read off the parsed outline, so
       it is in the unit the FILE declared; a run's lengthMm is millimetres. R5
       divided one by the other, so on the genuine CLO export — which declares
       INCHES — a single mapped shoulder seam made `sewn / perimeter` about 25
       times too large, the share passed 0.999, and a panel whose hem and armholes
       were not sewn at all was reported as fully sewn. R5 then stopped asking. */
    const patternSet = clone(tee.patternSet());
    patternSet.unit = "in";
    patternSet.unitInMm = 25.4;
    /* The same pattern, redrawn in inches: every coordinate and every derived
       length divided by 25.4, so the garment is physically identical and only the
       unit it is written in has changed. */
    const shrink = (v) => v / 25.4;
    for (const piece of patternSet.pieces) {
      piece.outline = piece.outline.map((p) => (Array.isArray(p)
        ? [shrink(p[0]), shrink(p[1])]
        : { ...p, x: shrink(p.x), y: shrink(p.y) }));
      if (piece.perimeter) piece.perimeter = shrink(piece.perimeter);
      if (piece.turnPoints) {
        piece.turnPoints = piece.turnPoints.map((p) => ({ ...p, x: shrink(p.x), y: shrink(p.y) }));
      }
    }

    const inputs = clone(tee.simulationInputs());
    for (const piece of inputs.pieces) piece.boundaryConfirmed = null;
    const result = assess(patternSet, inputs);
    const r5 = result.failures.find((f) => f.code === "R5");
    expect(r5).toBeDefined();
    /* Every piece still has unsewn perimeter, exactly as it does in millimetres. */
    expect(r5.pieces.length).toBe(4);
    for (const piece of r5.pieces) {
      expect(piece.sewnShare).toBeLessThan(0.999);
      /* And the figure shown to a person is millimetres, not inches labelled mm:
         a 60 cm hem does not read as 2.4. */
      expect(piece.uncoveredMm).toBeGreaterThan(100);
    }
  });

  test("VM-14 · A ZEROED FABRIC PROFILE IS REFUSED", () => {
    /* The case the old presence-only check accepted. Zero gravity and zero
       stiffness give cloth that looks like cloth and behaves like nothing. */
    const inputs = clone(tee.simulationInputs());
    inputs.fabrics = [{
      name: "Zeroed", appliesTo: [], behaviour: "knit", grade: "stated",
      weightGsm: 0, thicknessMm: 0, collisionOffsetMm: 0,
      stretchWarpPercent: 0, stretchWeftPercent: 0,
      shearStiffness: 0, bendingRigidity: 0, damping: 0,
    }];
    const result = assess(tee.patternSet(), inputs);
    expect(result.ready).toBe(false);
    expect(codes(result)).toContain("R9");
    const weight = result.failures.find((f) => /weight/i.test(f.message));
    expect(weight).toBeDefined();
    expect(weight.message).toMatch(/no defensible default/);
  });

  test("a profile with no array at all is refused too, and says which pieces", () => {
    const inputs = clone(tee.simulationInputs());
    inputs.fabrics = [];
    const result = assess(tee.patternSet(), inputs);
    const r9 = result.failures.find((f) => f.code === "R9");
    expect(r9.pieceRefs).toHaveLength(4);
    expect(r9.message).toMatch(/nobody specified/);
  });

  test("a knit with no stretch is refused: on a knit the stretch IS the evidence", () => {
    const inputs = clone(tee.simulationInputs());
    inputs.fabrics[0].stretchWarpPercent = null;
    inputs.fabrics[0].stretchWeftPercent = null;
    const result = assess(tee.patternSet(), inputs);
    expect(codes(result)).toContain("R9");
    expect(result.failures.some((f) => /held on by it/.test(f.message))).toBe(true);
  });

  test("a WOVEN with no stretch only warns — near-inextensible is nearly true", () => {
    const inputs = clone(tee.simulationInputs({ withNeckBand: true }));
    inputs.fabrics[0].behaviour = "woven";
    inputs.fabrics[0].stretchWarpPercent = null;
    inputs.fabrics[0].stretchWeftPercent = null;
    const result = assess(tee.patternSet({ withNeckBand: true }), inputs);
    expect(result.ready).toBe(true);
  });

  test("VM-20 · a neck finish that exists but is not mapped · R12", () => {
    const inputs = clone(tee.simulationInputs({ withNeckBand: true }));
    inputs.seams = inputs.seams.filter((s) => s.seamId !== "S-NECK");
    const result = assess(tee.patternSet({ withNeckBand: true }), inputs);
    expect(result.ready).toBe(false);
    expect(codes(result)).toContain("R12");
    const r12 = result.failures.find((f) => f.code === "R12");
    expect(r12.message).toMatch(/not joined to anything/);
    expect(r12.message).toMatch(/not the same as one that is absent/);
    expect(r12.pieceRef).toBe("PC-BAND");
  });

  test("VM-20 · a neck finish mapped with its alignment unconfirmed · R12", () => {
    const inputs = clone(tee.simulationInputs({ withNeckBand: true }));
    inputs.seams.find((s) => s.seamId === "S-NECK").alignmentConfirmed = null;
    const result = assess(tee.patternSet({ withNeckBand: true }), inputs);
    expect(codes(result)).toEqual(expect.arrayContaining(["R12"]));
  });

  test("VM-18 / R11 · a mapping confirmed against another revision", () => {
    const result = assess(tee.patternSet(), tee.simulationInputs(), {
      revisionRef: "PR-2", mappingConfirmedAgainstRef: "PR-1",
    });
    expect(codes(result)).toContain("R11");
    const r11 = result.failures.find((f) => f.code === "R11");
    expect(r11.message).toMatch(/re-checked rather than re-pointed/);
    expect(r11.message).toMatch(/expires with it/);
  });

  test("R8 · an open outline cannot be made into cloth", () => {
    const patternSet = tee.patternSet();
    patternSet.pieces[0].outlineClosed = false;
    const result = assess(patternSet, tee.simulationInputs());
    expect(codes(result)).toContain("R8");
  });

  test("R1 · nothing to sew", () => {
    const result = assess(tee.patternSet({ pieces: [] }), tee.simulationInputs());
    expect(codes(result)).toContain("R1");
  });

  test("R10 · an anisotropic cloth on a piece with no grain vector", () => {
    const inputs = clone(tee.simulationInputs({ withNeckBand: true }));
    const patternSet = tee.patternSet({ withNeckBand: true });
    /* Take away both the stated vector and the published grainline. */
    for (const piece of inputs.pieces) { piece.grainVector = []; piece.grainSource = ""; }
    for (const piece of patternSet.pieces) piece.grainline = null;
    const result = assess(patternSet, inputs);
    expect(codes(result)).toContain("R10");
    const r10 = result.failures.find((f) => f.code === "R10");
    expect(r10.message).toMatch(/differently along and across/);
  });

  test("a role that is not in the template's vocabulary is refused", () => {
    const inputs = clone(tee.simulationInputs());
    inputs.pieces[0].role = "body.frontish";
    const result = assess(tee.patternSet(), inputs);
    expect(result.failures.some((f) => /not a role/.test(f.message))).toBe(true);
  });

  test("cut quantity is the count in the finished garment, not the outline count", () => {
    const inputs = clone(tee.simulationInputs());
    /* One sleeve outline, left as `single`, is one sleeve in the garment. */
    inputs.pieces = inputs.pieces.filter((p) => p.pieceRef !== "PC-SLV-R");
    const result = assess(tee.patternSet(), inputs);
    const quantity = result.failures.find((f) => /needs 2/.test(f.message));
    expect(quantity).toBeDefined();
    expect(quantity.message).toMatch(/after unfolding and mirroring/);
  });

  test("Form A · one sleeve outline cut twice satisfies the quantity", () => {
    const inputs = clone(tee.simulationInputs());
    inputs.pieces = inputs.pieces.filter((p) => p.pieceRef !== "PC-SLV-R");
    const sleeve = inputs.pieces.find((p) => p.pieceRef === "PC-SLV-L");
    sleeve.cutQuantity = 2;
    sleeve.symmetry = "mirrored-pair";
    const result = assess(tee.patternSet(), inputs);
    expect(result.failures.filter((f) => /needs 2/.test(f.message))).toEqual([]);
  });
});

/* ═══ GROUP C — MUST RUN AND HOLD BACK ════════════════════════════════════ */

describe("Group C · drapes that run with findings withheld", () => {
  test("VM-19 · NO NECK FINISH AT ALL IS A PARTIAL, NOT A REFUSAL", () => {
    /* The 2 Oct decision. Refusing threw away every finding about the body and
       the sleeves to protect one finding about a collar that is not there. */
    const result = assess(tee.patternSet(), tee.simulationInputs());
    expect(result.failures).toEqual([]);
    expect(result.ready).toBe(true);
    expect(result.outcome).toBe("partial");
    expect(withheldFindings(result)).toEqual(
      expect.arrayContaining(["collar", "neckClearance", "collarRoll"]),
    );
    /* Shown prominently on the fitting, not in a details panel. */
    const note = result.notes.find((n) => n.prominent);
    expect(note).toBeDefined();
    expect(note.message).toMatch(/no neck finish/i);
    expect(note.message).toMatch(/nothing is invented/i);
  });

  test("VM-19 · and no neck circumference is reported from the raw opening", () => {
    const result = assess(tee.patternSet(), tee.simulationInputs());
    const collar = result.withheld.find((w) => w.finding === "collar");
    expect(collar.why).toMatch(/no neck band, collar or facing/);
  });

  test("VM-15 · cut boundary only · a Partial with every dimension withheld", () => {
    const inputs = clone(tee.simulationInputs({ withNeckBand: true }));
    inputs.seamAllowanceMm = null;
    for (const piece of inputs.pieces) piece.seamAllowanceMm = null;
    const result = assess(tee.patternSet({ withNeckBand: true }), inputs);

    expect(result.ready).toBe(true);
    expect(result.outcome).toBe("partial");
    expect(result.sewingLine.source).toBe("cut-boundary");
    expect(result.sewingLine.authoritative).toBe(false);
    expect(withheldFindings(result)).toEqual(expect.arrayContaining(
      ["chest", "waist", "hem", "bicep", "collar"],
    ));
    const w2 = result.warnings.find((w) => w.code === "W2");
    expect(w2).toBeDefined();
    /* Never described as slight, and the magnitude is stated. */
    expect(w2.message).not.toMatch(/slight/i);
    expect(w2.message).toMatch(/40 mm/);
    expect(w2.message).toMatch(/where the pieces meet/);
  });

  test("VM-16 · an unclassifiable fabric · chest, waist and hem withheld", () => {
    const inputs = clone(tee.simulationInputs({ withNeckBand: true }));
    inputs.fabrics[0].behaviour = "";
    const result = assess(tee.patternSet({ withNeckBand: true }), inputs);
    expect(result.ready).toBe(true);
    expect(result.outcome).toBe("partial");
    expect(withheldFindings(result)).toEqual(expect.arrayContaining(["chest", "waist", "hem"]));
    /* And it does not default to woven: defaulting reverses which number is
       primary and would report a knit's draped conformance as a good fit. */
    const why = result.withheld.find((w) => w.finding === "chest").why;
    expect(why).toMatch(/woven or knit/);
  });

  test("a published sewing line is used directly and withholds nothing", () => {
    const patternSet = tee.patternSet({ withNeckBand: true });
    for (const piece of patternSet.pieces) piece.sewLine = piece.outline.map((p) => ({ ...p }));
    const result = assess(patternSet, tee.simulationInputs({ withNeckBand: true }));
    expect(result.sewingLine.source).toBe("published");
    expect(result.outcome).toBe("fitting");
    expect(result.warnings.some((w) => w.code === "W1")).toBe(false);
  });

  test("a derived sewing line warns W1 and marks the findings derived", () => {
    const result = assess(
      tee.patternSet({ withNeckBand: true }),
      tee.simulationInputs({ withNeckBand: true }),
    );
    expect(result.sewingLine.source).toBe("derived");
    const w1 = result.warnings.find((w) => w.code === "W1");
    expect(w1.message).toMatch(/derived from a stated seam allowance/);
  });

  test("the fitting's grade is the LOWEST among its pieces", () => {
    const inputs = clone(tee.simulationInputs({ withNeckBand: true }));
    inputs.fabrics.push({
      ...inputs.fabrics[0],
      profileId: "FP-RIB", name: "Rib", appliesTo: ["PC-BAND"], grade: "preset",
    });
    const result = assess(tee.patternSet({ withNeckBand: true }), inputs);
    expect(result.fabric.grade).toBe("preset");
    expect(result.warnings.some((w) => /never a conclusion/.test(w.message))).toBe(true);
  });

  test("W7 · arc-length anchors will need re-checking after any pattern edit", () => {
    const inputs = clone(tee.simulationInputs({ withNeckBand: true }));
    const front = inputs.pieces.find((p) => p.pieceRef === "PC-FRONT");
    front.runs.find((r) => r.runId === "side-r").startAnchor = { kind: "fraction", fraction: 0.1 };
    const result = assess(tee.patternSet({ withNeckBand: true }), inputs);
    const w7 = result.warnings.find((w) => w.code === "W7");
    expect(w7.message).toMatch(/re-checking after any pattern edit/);
  });

  test("W8 · what is not modelled travels with the fitting", () => {
    const result = assess(
      tee.patternSet({ withNeckBand: true }),
      tee.simulationInputs({ withNeckBand: true }),
    );
    const w8 = result.warnings.filter((w) => w.code === "W8");
    expect(w8.some((w) => /single layer/.test(w.message))).toBe(true);
  });

  test("the alignment caveat is on every result, in the contract's own words", () => {
    const result = assess(
      tee.patternSet({ withNeckBand: true }),
      tee.simulationInputs({ withNeckBand: true }),
    );
    expect(result.alignmentCaveat).toMatch(/joined the way it was confirmed/);
    expect(result.alignmentCaveat).toMatch(/nothing afterwards will flag it/);
  });
});

/* ═══ VM-11 — THE BLIND SPOT, WRITTEN DOWN ════════════════════════════════ */

describe("VM-11 · the blind spot", () => {
  test("A REVERSED SEAM CONFIRMED THE WRONG WAY ROUND IS NOT DETECTED", () => {
    /* This test exists to record the limit, not to pass a check. A sleeve cap
       sewn front-to-back has the same perimeter, the same seam length and the
       same scale as one sewn correctly, so readiness cannot tell. */
    const inputs = clone(tee.simulationInputs({ withNeckBand: true }));
    const armhole = inputs.seams.find((s) => s.seamId === "S-ARM-L");
    armhole.alignment = "start-to-end";   /* confirmed, and wrong */
    const result = assess(tee.patternSet({ withNeckBand: true }), inputs);

    expect(result.ready).toBe(true);
    expect(codes(result)).toEqual([]);
    /* Nothing claims it was caught. The product's only defence is the
       confirmation step and its visual orientation preview. */
    expect(result.alignmentCaveat).toMatch(/will still produce a believable garment/);
  });

  test("and the lengths are identical either way round, which is why", () => {
    const base = assess(
      tee.patternSet({ withNeckBand: true }),
      tee.simulationInputs({ withNeckBand: true }),
    );
    const inputs = clone(tee.simulationInputs({ withNeckBand: true }));
    inputs.seams.find((s) => s.seamId === "S-ARM-L").alignment = "start-to-end";
    const reversed = assess(tee.patternSet({ withNeckBand: true }), inputs);
    expect(reversed.seams).toEqual(base.seams);
  });
});

/* ═══ THE TEMPLATES ══════════════════════════════════════════════════════ */

describe("templates declare their own vocabulary and nothing reads a name", () => {
  test("the required list is short on purpose", () => {
    for (const id of templates.TEMPLATE_IDS) {
      const template = templates.templateFor(id);
      expect(template.required).toEqual(["body.front", "body.back", "sleeve", "neckFinish"]);
    }
  });

  test("a short-sleeved band-collar shirt with no yoke passes", () => {
    /* VM-04's point: the first draft's required list would have refused this
       entirely ordinary garment. */
    const inputs = clone(tee.simulationInputs({ withNeckBand: true }));
    inputs.template = "woven-shirt";
    inputs.pieces.find((p) => p.pieceRef === "PC-BAND").role = "collar.stand";
    inputs.fabrics[0].behaviour = "woven";
    const result = assess(tee.patternSet({ withNeckBand: true }), inputs);
    expect(result.ready).toBe(true);
    /* No cuff, no yoke, no fall — each noted rather than demanded. */
    expect(result.warnings.filter((w) => w.code === "W4").length).toBeGreaterThan(0);
  });

  test("a collar fall with no stand to sit on is refused", () => {
    const inputs = clone(tee.simulationInputs({ withNeckBand: true }));
    inputs.template = "woven-shirt";
    inputs.fabrics[0].behaviour = "woven";
    inputs.pieces.find((p) => p.pieceRef === "PC-BAND").role = "collar.fall";
    const result = assess(tee.patternSet({ withNeckBand: true }), inputs);
    expect(result.failures.some((f) => /nothing to sit on/.test(f.message))).toBe(true);
  });

  test("ease allowances are the template's, per seam role, and never global", () => {
    expect(templates.easeAllowanceFor("side")).toBe(0);
    expect(templates.easeAllowanceFor("shoulder")).toBe(0.02);
    expect(templates.easeAllowanceFor("armhole.front")).toBe(0.05);
    expect(templates.easeAllowanceFor("neck.band")).toBe(0.25);
    /* A seam whose role nobody stated gets the tight default, because it is a
       seam nobody has reviewed. */
    expect(templates.easeAllowanceFor("")).toBe(0.05);
  });

  test("labels, tape and interlining are not simulated", () => {
    expect(templates.simulates({ role: "body.front" })).toBe(true);
    expect(templates.simulates({ role: "label.care" })).toBe(false);
    expect(templates.simulates({ role: "reinforcement.shoulder" })).toBe(false);
    expect(templates.simulates({ role: "interlining.collar" })).toBe(false);
    expect(templates.simulates({ role: "collar.flat", layer: "interlining" })).toBe(false);
  });
});
