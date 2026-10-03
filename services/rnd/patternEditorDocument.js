// services/rnd/patternEditorDocument.js
//
// THE 2D EDITOR'S DOCUMENT, AS A STORED, VALIDATED, VERSIONED RECORD.
//
// ── WHY THIS EXISTS BESIDE `patternSet` RATHER THAN INSIDE IT ───────────────
// `patternSet` is the PARSE: what a DXF said, in the shape every other consumer
// already reads — readiness, the render service, the IE projection, the costing
// roll-up. Changing its shape to carry point ids, edge classes and seam pairings
// would mean changing all of them at once, and the half that was missed would
// read a field it did not expect.
//
// So the editor's semantics live in their own named field on the same document.
// `patternSet` keeps being written on every save, from the same geometry, so
// nothing downstream notices anything has changed. The duplication is real and
// it is the price of not rewriting four consumers to add a notch id.
//
// ── NO NEW COLLECTION ───────────────────────────────────────────────────────
// This is one field on `rnd_pattern_revisions`. The cluster has been at its
// collection ceiling before and a second collection for something that is
// one-to-one with a revision would be the wrong answer even if there were room.
//
// ── THE VERSION IS A BOUNDARY, NOT A LABEL ──────────────────────────────────
// Every stored document carries `schemaVersion`. A revision saved before this
// field existed has none, and is NORMALISED from `patternSet` on read — point
// ids minted in order, every point classified from the file's own `turnPoints`
// and `curvePoints`, every edge left explicitly unstated. That is a migration
// with a name, and `provenance.geometry = "imported"` records that nobody
// authored any of it. Nothing is silently reinterpreted: an old revision that
// cannot be normalised is refused rather than guessed at.
"use strict";

const EDITOR_SCHEMA_VERSION = 1;

/* ── VOCABULARIES ─────────────────────────────────────────────────────────
   Each is a closed set, because a screen that can write "sewn " with a trailing
   space creates a class that nothing matches and nothing reports. */

const EDGE_CLASS = Object.freeze({
  SEW: "sew",
  FINISHED: "finished",
  FOLD: "fold",
  INTERNAL: "internal",
  UNSET: "",
});

const POINT_KIND = Object.freeze({ CORNER: "corner", CURVE: "curve" });

const PROVENANCE = Object.freeze({
  /* Read from the file. Nobody chose it, and a reader should weigh it as the
     parse's opinion rather than a person's statement. */
  IMPORTED: "imported",
  /* A person put it there in the editor. */
  AUTHORED: "authored",
  /* Computed from something else — an allowance line, a sewing line. */
  DERIVED: "derived",
});

const MEASURE_KIND = Object.freeze({
  STRAIGHT: "straight", PATH: "path", PERIMETER: "perimeter", AREA: "area",
});

const SEAM_ALIGNMENT = Object.freeze({
  START_TO_START: "start-to-start",
  START_TO_END: "start-to-end",
  UNSET: "",
});

/* A pairing nothing can vouch for is marked, never assumed. */
const SEAM_CONFIDENCE = Object.freeze({
  PROPOSED: "proposed",
  NEEDS_CHECKING: "needs-checking",
  CONFIRMED: "confirmed",
});

const str = (v) => (typeof v === "string" ? v.trim() : "");
const num = (v) => (Number.isFinite(v) ? v : null);
const list = (v) => (Array.isArray(v) ? v : []);
const bool = (v) => Boolean(v);

/* Four decimals of a millimetre: a tenth of a micron, far below anything a
   cutting room holds and far above where float noise would accumulate. */
const round4 = (n) => Math.round(n * 1e4) / 1e4;

/* ── VALIDATION ───────────────────────────────────────────────────────────
   Returns sentences, not codes. They are shown to the person who pressed Save,
   and "piece 3: two points share the id p17" is actionable where "E_DUP_ID" is
   not. */

function documentProblems(doc) {
  const out = [];
  if (!doc || typeof doc !== "object") return ["there is no editor document"];

  if (doc.schemaVersion !== EDITOR_SCHEMA_VERSION) {
    out.push(`this document is editor schema v${doc.schemaVersion}, and this server `
      + `writes v${EDITOR_SCHEMA_VERSION}`);
  }
  if (str(doc.unit) !== "mm") {
    out.push(`the editor document is stored in millimetres, and this one says "${doc.unit}"`);
  }

  const pieces = list(doc.pieces);
  if (!pieces.length) out.push("an editor document with no pieces describes nothing");

  const pieceIds = new Set();
  const allPointIds = new Set();

  pieces.forEach((p, i) => {
    const where = str(p.name) || str(p.pieceRef) || `piece ${i + 1}`;
    const id = str(p.pieceId);
    if (!id) out.push(`${where}: no piece id`);
    else if (pieceIds.has(id)) out.push(`${where}: two pieces share the id ${id}`);
    else pieceIds.add(id);

    const points = list(p.points);
    if (points.length < 2) {
      out.push(`${where}: a piece needs at least two points`);
      return;
    }
    const seen = new Set();
    points.forEach((pt, j) => {
      const pid = str(pt.pointId);
      if (!pid) out.push(`${where}: point ${j + 1} has no id`);
      else if (seen.has(pid)) out.push(`${where}: two points share the id ${pid}`);
      else { seen.add(pid); allPointIds.add(`${id}:${pid}`); }

      if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
        out.push(`${where}: point ${j + 1} has no position`);
      }
      if (![POINT_KIND.CORNER, POINT_KIND.CURVE].includes(str(pt.kind))) {
        out.push(`${where}: point ${j + 1} is neither a corner nor a curve point`);
      }
      if (pt.edge !== undefined && !Object.values(EDGE_CLASS).includes(str(pt.edge))) {
        out.push(`${where}: point ${j + 1} leaves an edge classed "${pt.edge}", which is not `
          + `one of ${Object.values(EDGE_CLASS).filter(Boolean).join(", ")}`);
      }
      if (pt.allowanceMm !== undefined && pt.allowanceMm !== null
        && !(Number.isFinite(pt.allowanceMm) && pt.allowanceMm >= 0)) {
        out.push(`${where}: point ${j + 1} carries an allowance that is not a length`);
      }
    });

    for (const n of list(p.notches)) {
      if (!str(n.notchId)) out.push(`${where}: a notch has no id`);
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) out.push(`${where}: a notch has no position`);
      if (n.afterPointId && !seen.has(str(n.afterPointId))) {
        out.push(`${where}: a notch is anchored to point ${n.afterPointId}, which is not on this piece`);
      }
    }
    if (p.grainline && !(Number.isFinite(p.grainline.fromX) && Number.isFinite(p.grainline.toX))) {
      out.push(`${where}: the grainline has no direction`);
    }
    if (p.provenance && !Object.values(PROVENANCE).includes(str(p.provenance.geometry))) {
      out.push(`${where}: "${p.provenance.geometry}" is not a provenance`);
    }
  });

  /* ── SEAMS ──────────────────────────────────────────────────────────── */
  const usedEdges = new Map();          /* "pieceId:pointId" → seamId */
  for (const seam of list(doc.seams)) {
    const name = str(seam.name) || str(seam.seamId) || "a seam";
    if (!str(seam.seamId)) out.push(`${name}: no seam id`);
    if (!Object.values(SEAM_ALIGNMENT).includes(str(seam.alignment))) {
      out.push(`${name}: "${seam.alignment}" is not an alignment`);
    }
    if (!Object.values(SEAM_CONFIDENCE).includes(str(seam.confidence))) {
      out.push(`${name}: "${seam.confidence}" is not a confidence`);
    }
    if (seam.unsupported) continue;          /* carried, not editable, not re-confirmed */
    for (const [side, run] of [["A", seam.a], ["B", seam.b]]) {
      const problems = runProblems(run, doc, `${name} side ${side}`);
      out.push(...problems);
      if (problems.length) continue;
      /* ── ONE STRETCH OF CLOTH IS SEWN TO ONE OTHER ──────────────────
         An edge in two seams is a panel sewn to two things along the same
         inch. It is always a mistake and it is invisible on the screen. */
      for (const pointId of list(run.edgePointIds)) {
        const key = `${str(run.pieceId)}:${str(pointId)}`;
        if (usedEdges.has(key) && usedEdges.get(key) !== str(seam.seamId)) {
          out.push(`${name}: an edge is already sewn into ${usedEdges.get(key)}`);
          break;
        }
        usedEdges.set(key, str(seam.seamId));
      }
    }
  }

  /* ── MEASUREMENTS ───────────────────────────────────────────────────── */
  for (const m of list(doc.measurements)) {
    const name = str(m.name) || str(m.measurementId) || "a measurement";
    if (!str(m.measurementId)) out.push(`${name}: no measurement id`);
    if (!Object.values(MEASURE_KIND).includes(str(m.kind))) {
      out.push(`${name}: "${m.kind}" is not a kind of measurement`);
    }
    if (!pieceIds.has(str(m.pieceId))) {
      out.push(`${name}: it is taken on a piece that is not in this document`);
    }
  }

  return out;
}

/** A seam run: a continuous span of edges on one piece, in travel order. */
function runProblems(run, doc, where) {
  const out = [];
  if (!run || typeof run !== "object") return [`${where}: there is no run`];
  const piece = list(doc.pieces).find((p) => str(p.pieceId) === str(run.pieceId));
  if (!piece) return [`${where}: it names a piece that is not in this document`];

  const ids = list(run.edgePointIds).map(str).filter(Boolean);
  if (!ids.length) return [`${where}: a run with no edges is not a run`];

  const order = list(piece.points).map((p) => str(p.pointId));
  const index = new Map(order.map((id, i) => [id, i]));
  if (ids.some((id) => !index.has(id))) {
    return [`${where}: it names an edge that is not on that piece`];
  }
  if (new Set(ids).size !== ids.length) out.push(`${where}: the same edge appears twice`);

  /* ── CONTINUITY ─────────────────────────────────────────────────────
     Each edge must start where the one before it ended, going round the
     boundary. A run with a hole in it is two runs, and sewing it as one
     attaches cloth to a gap. */
  const n = order.length;
  for (let i = 1; i < ids.length; i += 1) {
    const expected = (index.get(ids[i - 1]) + 1) % n;
    if (index.get(ids[i]) !== expected) {
      out.push(`${where}: the run is not continuous — it jumps after edge ${i}`);
      break;
    }
  }
  if (!piece.closed && index.get(ids[ids.length - 1]) === n - 1) {
    out.push(`${where}: the run runs off the end of an open outline`);
  }
  return out;
}

/* ── NORMALISING AN OLD REVISION ──────────────────────────────────────────
   The migration boundary. A revision stored before this field existed is read
   through here and nothing about its geometry is reinterpreted: the points are
   the points, the corner/curve split is the file's own, and every edge is
   explicitly unstated rather than guessed. */

function normaliseFromPatternSet(patternSet, { seed = "i", simulationInputs = null, confirmedAgainst = "", revisionRef = "" } = {}) {
  const mmPerUnit = Number.isFinite(patternSet?.unitInMm) && patternSet.unitInMm > 0
    ? patternSet.unitInMm
    : null;
  if (!mmPerUnit) {
    return {
      document: null,
      problems: ["this pattern does not say what unit it was drawn in, and a pattern read as "
        + "millimetres when it was drawn in inches is out by a factor of 25.4 with nothing on "
        + "screen to show it"],
    };
  }

  let seq = 0;
  const mint = (prefix) => { seq += 1; return `${seed}${prefix}${seq}`; };
  const key = (p) => `${Math.round(p.x * 1000)}:${Math.round(p.y * 1000)}`;

  const pieces = list(patternSet.pieces).map((piece) => {
    const curved = new Set(list(piece.curvePoints).map(key));
    return {
      pieceId: mint("p"),
      pieceRef: str(piece.pieceRef),
      name: str(piece.name),
      closed: bool(piece.outlineClosed),
      points: list(piece.outline).map((p) => ({
        pointId: mint("v"),
        x: round4(p.x * mmPerUnit),
        y: round4(p.y * mmPerUnit),
        /* Anything the file did not call a curve point is a CORNER. The safe
           direction: a corner drawn as a corner is at worst slightly angular; a
           corner smoothed into a curve rounds off an armhole point. */
        kind: curved.has(key(p)) ? POINT_KIND.CURVE : POINT_KIND.CORNER,
        edge: EDGE_CLASS.UNSET,
        allowanceMm: null,
      })),
      grainline: piece.grainline?.from && piece.grainline?.to
        ? {
          fromX: round4(piece.grainline.from.x * mmPerUnit),
          fromY: round4(piece.grainline.from.y * mmPerUnit),
          toX: round4(piece.grainline.to.x * mmPerUnit),
          toY: round4(piece.grainline.to.y * mmPerUnit),
          provenance: PROVENANCE.IMPORTED,
        }
        : null,
      notches: list(piece.notches).map((nt) => ({
        notchId: mint("n"),
        x: round4(nt.at.x * mmPerUnit),
        y: round4(nt.at.y * mmPerUnit),
        form: str(nt.form) || "point",
        depthMm: Number.isFinite(nt.depth) ? round4(nt.depth * mmPerUnit) : null,
        afterPointId: "",
        offsetMm: null,
        provenance: PROVENANCE.IMPORTED,
      })),
      internalLines: list(piece.internalLines).map((l) => ({
        lineId: mint("i"),
        points: list(l.points).map((p) => ({ x: round4(p.x * mmPerUnit), y: round4(p.y * mmPerUnit) })),
        closed: bool(l.closed),
        provenance: PROVENANCE.IMPORTED,
      })),
      sewingLine: list(piece.sewLine).length
        ? {
          points: list(piece.sewLine).map((p) => ({ x: round4(p.x * mmPerUnit), y: round4(p.y * mmPerUnit) })),
          provenance: PROVENANCE.IMPORTED,
        }
        : null,
      allowance: piece.seamAllowance?.value != null
        ? {
          widthMm: round4(piece.seamAllowance.value * mmPerUnit),
          source: str(piece.seamAllowance.source) || "imported",
          provenance: PROVENANCE.IMPORTED,
        }
        : null,
      provenance: { geometry: PROVENANCE.IMPORTED, note: "" },
    };
  });

  return {
    document: {
      schemaVersion: EDITOR_SCHEMA_VERSION,
      unit: "mm",
      normalisedFrom: "patternSet",
      sourceUnit: str(patternSet.unit),
      sourceUnitInMm: mmPerUnit,
      pieces,
      /* ── A MAPPING MADE IN THE OLD SETUP PANEL IS NOT LOST ────────────
         `simulationInputs` carries seams as runs anchored by point INDEX. The
         editor works in point ids, so they are translated here — once, on the
         way in — and come back out on the way to a save. Without this, opening a
         mapped revision in the editor and saving it would silently drop the
         mapping, and the pattern would become un-renderable for no reason
         anybody could see. */
      seams: seamsFromSimulationInputs(simulationInputs, pieces, {
        confirmed: Boolean(confirmedAgainst && revisionRef && confirmedAgainst === revisionRef),
      }),
      measurements: [],
    },
    problems: [],
  };
}

/**
 * Stored seam runs, as editor runs.
 *
 * `confirmed` only when the stored mapping was confirmed against THIS revision.
 * Otherwise `needs-checking`, which is the truth: the mapping names indices on
 * geometry that may have moved, and the editor is not entitled to promote it.
 */
function seamsFromSimulationInputs(inputs, pieces, { confirmed = false } = {}) {
  const seams = list(inputs?.seams);
  if (!seams.length) return [];

  const byRef = new Map(pieces.map((p) => [str(p.pieceRef), p]));
  const runsByPiece = new Map();
  for (const p of list(inputs?.pieces)) {
    for (const r of list(p.runs)) runsByPiece.set(`${str(p.pieceRef)}:${str(r.runId)}`, { piece: str(p.pieceRef), run: r });
  }

  /* ── A SIDE MADE OF SEVERAL RUNS IS NOT TRANSLATED ────────────────────
     `sideA`/`sideB` are arrays because a set-in sleeve is one cap run sewn to
     two or three body runs IN ORDER, and a neck band goes round a neckline made
     of a front and a back. The editor's run is one continuous stretch on one
     piece, which cannot express that.

     Taking the first run and ignoring the rest looks like it works and is the
     worst available answer: it produced a 12 cm armhole paired with a 27 cm one
     and 119% of ease that is nowhere in the pattern. So a multi-run side is
     refused here, the seam is carried as `needs-checking` with a reason, and
     readiness goes on refusing in Lane A's own words. */
  const asEditorRun = (side) => {
    const runs = list(side);
    if (runs.length > 1) return { multiRun: true, count: runs.length };
    const first = runs[0];
    if (!first) return null;
    const found = runsByPiece.get(`${str(first.pieceRef)}:${str(first.runId)}`);
    const piece = byRef.get(str(first.pieceRef));
    if (!found || !piece) return null;
    const n = piece.points.length;
    const from = Number(found.run.startAnchor?.pointIndex);
    const to = Number(found.run.endAnchor?.pointIndex);
    if (!Number.isInteger(from) || !Number.isInteger(to) || !n) return null;

    /* ── WHICH OF THE TWO STRETCHES BETWEEN THE ANCHORS ──────────────
       Two points on a closed boundary divide it into two, and `theLongWay` on
       the stored run is which one was meant. Walking forward and taking it is
       wrong half the time: the archive's own front-body armhole walks forward
       across sixty-odd edges and is a six-edge run the other way round. That
       mistake turns one armhole into a run that claims most of the panel and
       collides with every other seam on it. */
    const forward = [];
    for (let k = from; k !== to; k = (k + 1) % n) {
      forward.push(str(piece.points[k].pointId));
      if (forward.length > n) break;
    }
    if (!forward.length) return null;
    const all = piece.points.map((v) => str(v.pointId));
    const inForward = new Set(forward);
    const complement = all.filter((id) => !inForward.has(id));
    /* ── BY LENGTH, NOT BY EDGE COUNT ────────────────────────────────
       `theLongWay` is about arc length, and the two are not the same thing: the
       archive's front-body armhole is twenty-nine short segments of a curve and
       the stretch the other way round is four long ones. Counting edges picks
       the curve as "the long way" and hands the solver a 27 cm run to sew to a
       12 cm one, which readiness then refuses for 119% ease that is not in the
       pattern. */
    const lengthOf = (ids) => {
      const at = new Map(all.map((id, i) => [id, piece.points[i]]));
      let total = 0;
      for (const id of ids) {
        const i = all.indexOf(id);
        const a = piece.points[i];
        const b = piece.points[(i + 1) % n];
        total += Math.hypot(b.x - a.x, b.y - a.y);
      }
      return total;
    };
    const wantLong = Boolean(found.run.theLongWay);
    const longer = lengthOf(forward) >= lengthOf(complement) ? forward : complement;
    const shorter = longer === forward ? complement : forward;
    const ids = (wantLong ? longer : shorter);
    if (!ids.length) return null;
    return {
      pieceId: str(piece.pieceId),
      edgePointIds: ids,
      reversed: str(found.run.direction) === "reverse",
      lengthMm: Number.isFinite(found.run.lengthMm) ? found.run.lengthMm : null,
      role: str(found.run.role),
    };
  };

  const out = [];
  for (const s of seams) {
    const a = asEditorRun(s.sideA);
    const b = asEditorRun(s.sideB);
    if (!a || !b) continue;
    if (a.multiRun || b.multiRun) {
      out.push({
        seamId: str(s.seamId),
        name: str(s.name),
        a: a.multiRun ? { pieceId: "", edgePointIds: [], reversed: false, role: "" } : a,
        b: b.multiRun ? { pieceId: "", edgePointIds: [], reversed: false, role: "" } : b,
        alignment: str(s.alignment),
        confidence: SEAM_CONFIDENCE.NEEDS_CHECKING,
        easeMm: null,
        easePercent: null,
        note: `One side of this seam is ${(a.multiRun ? a : b).count} runs sewn in order — a `
          + "set-in sleeve or a neck band. The 2D editor pairs one continuous run to one "
          + "other, so this mapping is shown but not editable here, and it is not re-confirmed "
          + "by a save.",
        unsupported: true,
      });
      continue;
    }
    out.push({
      seamId: str(s.seamId),
      name: str(s.name),
      a,
      b,
      alignment: str(s.alignment),
      confidence: confirmed && str(s.alignment) ? SEAM_CONFIDENCE.CONFIRMED : SEAM_CONFIDENCE.NEEDS_CHECKING,
      easeMm: null,
      easePercent: Number.isFinite(s.easePercent) ? s.easePercent : null,
      note: "",
    });
  }
  return out;
}

/**
 * The editor document for a revision: the stored one, or one normalised from
 * the parse.
 *
 * `origin` says which, because "no seams mapped" means something different on a
 * revision somebody edited and on one nobody has opened yet.
 */
function editorDocumentFor(revision) {
  const stored = revision?.editorDocument;
  if (stored && Number(stored.schemaVersion) === EDITOR_SCHEMA_VERSION) {
    return { document: stored, origin: "stored", problems: [] };
  }
  if (stored && stored.schemaVersion) {
    return {
      document: null,
      origin: "stored",
      problems: [`this revision was saved by editor schema v${stored.schemaVersion} and this `
        + `server reads v${EDITOR_SCHEMA_VERSION}. It is not reinterpreted, because a document `
        + "read under the wrong version is a pattern that looks right and is not."],
    };
  }
  const { document, problems } = normaliseFromPatternSet(revision?.patternSet || {}, {
    simulationInputs: revision?.simulationInputs || null,
    confirmedAgainst: str(revision?.mappingConfirmedAgainstRef),
    revisionRef: str(revision?.revisionRef),
  });
  return { document, origin: "normalised", problems };
}

module.exports = {
  EDITOR_SCHEMA_VERSION,
  seamsFromSimulationInputs,
  EDGE_CLASS, POINT_KIND, PROVENANCE, MEASURE_KIND, SEAM_ALIGNMENT, SEAM_CONFIDENCE,
  documentProblems, runProblems, normaliseFromPatternSet, editorDocumentFor,
  round4,
};
