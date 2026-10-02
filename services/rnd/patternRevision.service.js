// services/rnd/patternRevision.service.js
//
// THE PATTERN IS THE DESIGN. EVERY CHANGE TO IT IS A NEW REVISION.
//
// ── THE TWO RULES THE WHOLE FILE IS BUILT ON ────────────────────────────────
//
//   1. AN APPROVED REVISION IS NEVER WRITTEN TO. Something was cut to it. It
//      is the answer to "what was this sample made from", and a record that
//      can be edited afterwards cannot answer that. An edit of an approved
//      revision produces the NEXT revision, with a parent pointer.
//
//   2. NOTHING IN 3D REACHES THIS FILE. There is no function here that a
//      measurement, an annotation or a render could call to change a pattern.
//      The arrow points one way: pattern → preview, and a preview that
//      disagrees with the pattern is the preview that is wrong.
//
// ── WHY EVERY EDIT MINTS A REVISION, EVEN A RENAME ──────────────────────────
// Because the expensive mistakes here are not dramatic. Nobody reshapes an
// armhole by accident; people rename a piece, change a seam allowance by two
// millimetres, and nudge one grade point — and three weeks later nobody can
// say when it happened or who did it. A revision per edit makes that question
// answerable at the cost of a row.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const {
  PatternRevision, REVISION_STATE, EDIT_KIND,
  ANCHOR_KIND, SYMMETRY, PIECE_LAYER, SEAM_ALIGNMENT, FABRIC_BEHAVIOUR, FABRIC_GRADE,
} = require("../../models/CMS_Models/RnD/PatternRevision");
const templates = require("./fitTemplates");
const { styleForCompany } = require("../companyContext/rndScope.service");
const { checkInputs, adapterStatus } = require("./simulationAdapter.service");
const { fail } = require("../storePurchase/errors");

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const clean = (v, max) => str(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max);
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));
const mintRef = (prefix) => `${prefix}-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
const actorOf = (a) => ({ id: str(a?.id), name: str(a?.name), email: str(a?.email).toLowerCase() });

function assertContext(ctx) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
}

/* ═══ READING ═════════════════════════════════════════════════════════════ */

const byCompany = (ctx, extra = {}) => ({ companyId: ctx.companyId, ...extra });

async function revisionForCompany(ctx, revisionId, { lean = false } = {}) {
  if (!isId(revisionId)) throw fail("NOT_FOUND", "That pattern revision was not found.");
  const query = PatternRevision.findOne(byCompany(ctx, { _id: revisionId }));
  const row = await (lean ? query.lean() : query).catch(() => null);
  if (!row) throw fail("NOT_FOUND", "That pattern revision was not found.");
  return row;
}

/**
 * What a revision looks like to a screen.
 *
 * The pattern set is big — hundreds of points per piece — so the list view
 * omits it and the single read includes it. A list that carried every outline
 * would be megabytes to answer "how many revisions are there".
 */
function revisionView(row, { geometry = false } = {}) {
  const view = {
    id: String(row._id),
    revisionRef: row.revisionRef,
    revisionNumber: row.revisionNumber,
    name: str(row.name),
    state: row.state,
    origin: {
      kind: row.origin?.kind,
      parentRevisionRef: str(row.origin?.parentRevisionRef),
    },
    sourceDxf: {
      name: str(row.sourceDxf?.name),
      sha256: str(row.sourceDxf?.sha256),
      bytes: row.sourceDxf?.bytes || 0,
      importedInRevisionRef: str(row.sourceDxf?.importedInRevisionRef),
      /* Never a storage id. The file is reached through a signed link the way
         every other asset here is. */
      held: Boolean(row.sourceDxf?.driveFileId),
    },
    stats: row.patternSet?.stats || null,
    unit: str(row.patternSet?.unit),
    pieceCount: (row.patternSet?.pieces || []).length,
    edits: (row.edits || []).map((e) => ({
      kind: e.kind, pieceRef: e.pieceRef, pieceName: e.pieceName,
      summary: e.summary,
      /* The sentence is for the revision list; these are for the reviewer who
         wants to know whether "reshaped" was a nudge or a redraw. */
      before: e.before ?? null,
      after: e.after ?? null,
      by: str(e.by?.name), at: e.at,
    })),
    simulationInputs: row.simulationInputs || {},
    /* What a render would still need, computed from this revision rather than
       asserted by a screen. */
    /* ── THE ONE READINESS RESULT ──────────────────────────────────────
       The same object the render service refuses on, so the screen and the
       refusal cannot describe different work. The frontend renders this; it
       derives nothing of its own. */
    readiness: checkInputs(row.patternSet, row.simulationInputs, {
      revisionRef: row.revisionRef,
      mappingConfirmedAgainstRef: row.mappingConfirmedAgainstRef,
    }),
    mappingConfirmedAgainstRef: str(row.mappingConfirmedAgainstRef),
    /* ── THE WORDS THE SCREEN MAY OFFER ────────────────────────────────
       Sent with the revision rather than hard-coded in the page, because a role
       list that exists in two places drifts, and the half that drifts is the one
       readiness does not use: a screen offering "front" while the template
       declares "body.front" produces a refusal nobody can act on. */
    vocabulary: {
      templates: templates.TEMPLATE_IDS.map((id) => {
        const t = templates.TEMPLATES[id];
        return {
          id: t.id,
          label: t.label,
          typicalBehaviour: t.typicalBehaviour,
          roles: t.roles,
          required: t.required,
          optional: t.optional || [],
          requiredCutQuantity: t.requiredCutQuantity || {},
        };
      }),
      runRoles: templates.RUN_ROLES,
      neckFinishRoles: templates.NECK_FINISH_ROLES,
      anchorKinds: Object.values(ANCHOR_KIND),
      symmetries: Object.values(SYMMETRY),
      pieceLayers: Object.values(PIECE_LAYER),
      seamAlignments: Object.values(SEAM_ALIGNMENT),
      fabricBehaviours: Object.values(FABRIC_BEHAVIOUR),
      fabricGrades: Object.values(FABRIC_GRADE),
    },
    author: str(row.author?.name),
    approvedBy: str(row.approvedBy?.name),
    approvedAt: row.approvedAt || null,
    supersededByRef: str(row.supersededByRef),
    events: (row.events || []).map((e) => ({
      kind: e.kind, note: str(e.note), by: str(e.by?.name), at: e.at,
    })),
    revision: row.revision ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (geometry) view.patternSet = row.patternSet || null;
  return view;
}

/**
 * Every revision of one style's pattern, newest first.
 *
 * `current` is the one a reader should be looking at: the approved revision if
 * there is one, otherwise the newest draft. Said here so three screens cannot
 * each decide it differently.
 */
async function listRevisions(ctx, { styleId } = {}) {
  assertContext(ctx);
  const style = await styleForCompany(ctx.companyId, styleId);
  const rows = await PatternRevision
    .find(byCompany(ctx, { styleId: style._id }))
    .sort({ revisionNumber: -1 })
    .lean();

  const approved = rows.find((r) => r.state === REVISION_STATE.APPROVED) || null;
  const newest = rows[0] || null;
  const current = approved || newest;

  return {
    style: {
      id: String(style._id),
      styleCode: str(style.styleCode),
      productName: str(style.productName),
    },
    revisions: rows.map((r) => revisionView(r)),
    currentRevisionRef: current ? current.revisionRef : "",
    approvedRevisionRef: approved ? approved.revisionRef : "",
    /* Said once, here, so the workspace does not have to ask separately. */
    simulation: adapterStatus(),
  };
}

async function readRevision(ctx, { revisionId } = {}) {
  assertContext(ctx);
  const row = await revisionForCompany(ctx, revisionId, { lean: true });
  return { revision: revisionView(row, { geometry: true }) };
}

/* ═══ IMPORTING ═══════════════════════════════════════════════════════════ */

/**
 * The first revision of a style's pattern, from the file the pattern room sent.
 *
 * The parse is done by the caller — `utils/dxfInspect.js` already reads AAMA
 * and ASTM layers and this service has no business owning a second reading of
 * the format. What this owns is that the FILE is kept and that the parse
 * becomes revision 1 rather than becoming the pattern.
 */
async function importRevision(ctx, {
  styleId, patternSet, sourceDxf, name, actor = null,
} = {}) {
  assertContext(ctx);
  const style = await styleForCompany(ctx.companyId, styleId);
  if (!patternSet || !(patternSet.pieces || []).length) {
    throw fail("PATTERN_UNREADABLE",
      "That file produced no pattern pieces, so there is nothing to import as a revision.");
  }

  const last = await PatternRevision
    .findOne(byCompany(ctx, { styleId: style._id }))
    .sort({ revisionNumber: -1 }).select("revisionNumber").lean();

  const who = actorOf(actor);
  const revisionRef = mintRef("PR");
  const created = await PatternRevision.create({
    companyId: ctx.companyId,
    styleId: style._id,
    revisionRef,
    revisionNumber: (last?.revisionNumber || 0) + 1,
    name: clean(name, 200) || str(patternSet.manifest?.styleName),
    state: REVISION_STATE.DRAFT,
    origin: { kind: "dxf-import", parentRevisionRef: "" },
    sourceDxf: {
      driveFileId: str(sourceDxf?.driveFileId),
      name: str(sourceDxf?.name),
      sha256: str(sourceDxf?.sha256),
      bytes: sourceDxf?.bytes || 0,
      /* This revision imported it; every descendant will say the same. */
      importedInRevisionRef: revisionRef,
    },
    patternSet,
    author: who,
    events: [{ kind: "imported", note: str(sourceDxf?.name), by: who, at: new Date() }],
  });
  return { revision: revisionView(created, { geometry: true }) };
}

/* ═══ EDITING ═════════════════════════════════════════════════════════════ */

const point = (p) => ({ x: Number(p?.x), y: Number(p?.y) });
const finite = (p) => Number.isFinite(p.x) && Number.isFinite(p.y);

/**
 * One change to one piece, applied to a COPY of the parent's pattern.
 *
 * Each returns the words the revision list will show. A change that cannot be
 * described is a change nobody can review, so the summary is produced here
 * beside the edit rather than typed by a caller.
 */
const EDITORS = {
  [EDIT_KIND.RENAME]: (piece, op) => {
    const next = clean(op.name, 160);
    if (!next) throw fail("VALIDATION", "A piece needs a name.", { field: "name" });
    const before = piece.name;
    piece.name = next;
    /* It was a person's choice from here on, whatever the exporter counted. */
    piece.generatedName = false;
    return { summary: `Renamed "${before || "(unnamed)"}" to "${next}"`, before, after: next };
  },

  [EDIT_KIND.METADATA]: (piece, op) => {
    const changes = [];
    const before = {};
    const after = {};
    for (const [field, max] of [["material", 120], ["description", 500], ["size", 40]]) {
      if (op[field] === undefined) continue;
      before[field] = piece[field]; after[field] = clean(op[field], max);
      piece[field] = after[field];
      changes.push(field);
    }
    if (op.quantity !== undefined) {
      const n = Number(op.quantity);
      if (!Number.isFinite(n) || n < 0) throw fail("VALIDATION", "A piece quantity is a whole number.", { field: "quantity" });
      before.quantity = piece.quantity; after.quantity = Math.round(n);
      piece.quantity = after.quantity; changes.push("quantity");
    }
    if (op.componentClass !== undefined) {
      const allowed = ["shell", "lining", "interlining", "rib", "trim", "pocketing", ""];
      const c = str(op.componentClass);
      if (!allowed.includes(c)) throw fail("VALIDATION", "That is not a component class.", { field: "componentClass", allowed });
      before.componentClass = piece.componentClass; after.componentClass = c;
      piece.componentClass = c; changes.push("component class");
    }
    if (!changes.length) throw fail("VALIDATION", "That edit changed nothing.", { field: "metadata" });
    return { summary: `Changed ${changes.join(", ")} on "${piece.name || piece.pieceRef}"`, before, after };
  },

  /* ── IN DRAWING UNITS, NOT MILLIMETRES ───────────────────────────────
     `seamAllowanceSchema.value` is in the pattern's own unit, which the set
     states and which may be inches. An earlier draft of this took a
     `seamAllowanceMm` and wrote it into that field, which would have put 10
     into a pattern drawn in inches and called it a centimetre. The unit comes
     from the pattern and the number is in it. */
  [EDIT_KIND.SEAM_ALLOWANCE]: (piece, op, { unit }) => {
    const raw = op.seamAllowance ?? op.value;
    const value = raw === null || raw === "" || raw === undefined ? null : Number(raw);
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      throw fail("VALIDATION", "A seam allowance is a distance, or nothing at all.", { field: "seamAllowance" });
    }
    const before = piece.seamAllowance?.value ?? null;
    piece.seamAllowance = value === null ? null : {
      ...(piece.seamAllowance || {}),
      value,
      uniform: op.uniform === undefined ? true : Boolean(op.uniform),
      source: "edited",
    };
    const said = `${value}${unit ? ` ${unit}` : ""}`;
    return {
      summary: value === null
        ? `Cleared the seam allowance on "${piece.name || piece.pieceRef}"`
        : `Seam allowance on "${piece.name || piece.pieceRef}" set to ${said}`,
      before, after: value,
    };
  },

  /* ── MOVING AND RESHAPING ────────────────────────────────────────────
     The whole outline is replaced rather than one point patched, because a
     reshape is a sequence of moves and storing each would make the revision
     list unreadable. What is kept is the before and after point COUNT and the
     largest distance any point moved — enough for a reviewer to see whether
     this was a nudge or a redraw. */
  [EDIT_KIND.OUTLINE]: (piece, op) => {
    const next = (Array.isArray(op.outline) ? op.outline : []).map(point);
    if (next.length < 3 || !next.every(finite)) {
      throw fail("VALIDATION", "An outline needs at least three real points.", { field: "outline" });
    }
    const before = piece.outline || [];
    let moved = 0;
    for (let i = 0; i < Math.min(before.length, next.length); i += 1) {
      moved = Math.max(moved, Math.hypot(next[i].x - before[i].x, next[i].y - before[i].y));
    }
    piece.outline = next;
    if (op.outlineClosed !== undefined) piece.outlineClosed = Boolean(op.outlineClosed);
    return {
      summary: `Reshaped "${piece.name || piece.pieceRef}" — `
        + `${before.length} points to ${next.length}, largest move ${moved.toFixed(2)}`,
      before: { points: before.length },
      after: { points: next.length, largestMove: Number(moved.toFixed(4)) },
    };
  },

  /* A notch is `{ at, form, depth }` — the position is nested, because a slit
     notch has a run of points and a point notch does not. */
  [EDIT_KIND.NOTCHES]: (piece, op) => {
    const forms = ["point", "slit", "v"];
    const next = (Array.isArray(op.notches) ? op.notches : []).map((n) => ({
      at: point(n.at || n),
      form: forms.includes(str(n.form)) ? str(n.form) : "point",
      points: (n.points || []).map(point),
      depth: Number.isFinite(Number(n.depth)) ? Number(n.depth) : null,
    }));
    if (!next.every((n) => finite(n.at))) throw fail("VALIDATION", "A notch needs a position.", { field: "notches" });
    const before = (piece.notches || []).length;
    piece.notches = next;
    return {
      summary: `Notches on "${piece.name || piece.pieceRef}": ${before} to ${next.length}`,
      before, after: next.length,
    };
  },

  [EDIT_KIND.INTERNAL_LINES]: (piece, op) => {
    const next = (Array.isArray(op.internalLines) ? op.internalLines : []).map((l) => ({
      points: (l.points || []).map(point),
      closed: Boolean(l.closed),
      length: null,
    }));
    if (next.some((l) => l.points.length < 2 || !l.points.every(finite))) {
      throw fail("VALIDATION", "An internal line needs at least two real points.", { field: "internalLines" });
    }
    const before = (piece.internalLines || []).length;
    piece.internalLines = next;
    return {
      summary: `Internal lines on "${piece.name || piece.pieceRef}": ${before} to ${next.length}`,
      before, after: next.length,
    };
  },

  /* Grading is per piece and per size; the offsets replace whatever was
     parsed, and `source: "edited"` is what lets a reader see that a grade
     came from this building rather than from the CAD file. */
  [EDIT_KIND.GRADING]: (piece, op) => {
    const next = (Array.isArray(op.gradePoints) ? op.gradePoints : []).map(point);
    if (!next.every(finite)) throw fail("VALIDATION", "A grade point needs a position.", { field: "gradePoints" });
    const before = (piece.gradePoints || []).length;
    piece.gradePoints = next;
    return {
      summary: `Grading on "${piece.name || piece.pieceRef}": ${before} points to ${next.length}`,
      before, after: next.length,
    };
  },
};

/**
 * EDIT THE PATTERN — WHICH ALWAYS MEANS MAKING THE NEXT REVISION.
 *
 * There is no path through this function that writes to the revision it was
 * given. It reads the parent, applies the operations to a copy, and stores the
 * copy as a new revision. That is true whether the parent was approved or a
 * draft, so "can this be edited" is never a question anybody has to ask.
 *
 * A draft parent is left alone too, deliberately. Two people editing the same
 * draft would otherwise overwrite each other silently, and a revision each is
 * both cheap and reviewable.
 */
async function editRevision(ctx, { revisionId, operations = [], name, expectedRevision, actor = null } = {}) {
  assertContext(ctx);
  const parent = await revisionForCompany(ctx, revisionId, { lean: true });
  if (expectedRevision !== undefined && Number(expectedRevision) !== parent.revision) {
    throw fail("REVISION_CONFLICT",
      "This pattern changed while you were working on it. Reload and make the change again.",
      { expectedRevision: Number(expectedRevision), currentRevision: parent.revision });
  }
  const ops = Array.isArray(operations) ? operations : [];
  if (!ops.length) throw fail("VALIDATION", "An edit needs at least one change.", { field: "operations" });

  /* A deep copy, so nothing below can reach the parent's stored document. */
  const patternSet = JSON.parse(JSON.stringify(parent.patternSet || {}));
  const pieces = patternSet.pieces || [];
  const who = actorOf(actor);
  const at = new Date();
  const edits = [];

  for (const op of ops) {
    const editor = EDITORS[str(op.kind)];
    if (!editor) {
      throw fail("VALIDATION", "That is not a kind of pattern edit.",
        { field: "kind", accepted: Object.keys(EDITORS) });
    }
    const piece = pieces.find((p) => p.pieceRef === str(op.pieceRef));
    if (!piece) {
      throw fail("NOT_FOUND", "That pattern piece is not in this revision.", { pieceRef: str(op.pieceRef) });
    }
    const outcome = editor(piece, op, { unit: str(patternSet.unit) });
    edits.push({
      kind: op.kind,
      pieceRef: piece.pieceRef,
      pieceName: str(piece.name),
      summary: outcome.summary,
      before: outcome.before ?? null,
      after: outcome.after ?? null,
      by: who,
      at,
    });
  }

  const last = await PatternRevision
    .findOne(byCompany(ctx, { styleId: parent.styleId }))
    .sort({ revisionNumber: -1 }).select("revisionNumber").lean();

  const created = await PatternRevision.create({
    companyId: ctx.companyId,
    styleId: parent.styleId,
    revisionRef: mintRef("PR"),
    revisionNumber: (last?.revisionNumber || 0) + 1,
    name: clean(name, 200) || parent.name,
    state: REVISION_STATE.DRAFT,
    origin: { kind: "edit", parentRevisionRef: parent.revisionRef },
    /* The file travels with the line. Revision 7's DXF is revision 1's DXF,
       and it says so. */
    sourceDxf: parent.sourceDxf,
    patternSet,
    edits,
    /* The simulation inputs carry forward: they describe the garment, not the
       geometry, and losing them on every edit would make a pattern
       un-renderable the moment anybody corrected a name. */
    simulationInputs: parent.simulationInputs,
    /* ── THE MAPPING CAME FROM THE PARENT, AND SAYS SO ────────────────────
       The setup is carried onto the new revision because re-entering a body, a
       fabric and six seam mappings after every pattern edit would be unusable.
       But a seam mapping names outline POINT INDICES, and an edit moves them —
       so what is carried is a mapping confirmed against the PARENT, and this is
       what lets readiness say "re-check this" (R11) instead of silently sewing
       the new geometry with the old anchors. Carrying the inputs and dropping
       this stamp is the dangerous half of the pair. */
    mappingConfirmedAgainstRef: parent.mappingConfirmedAgainstRef || "",
    author: who,
    events: [{ kind: "edited", note: `${edits.length} change(s) from ${parent.revisionRef}`, by: who, at }],
  });
  return { revision: revisionView(created, { geometry: true }) };
}

/** The simulation inputs, which are settings rather than geometry. */
async function setSimulationInputs(ctx, { revisionId, inputs = {}, expectedRevision, actor = null } = {}) {
  assertContext(ctx);
  const row = await revisionForCompany(ctx, revisionId);
  if (expectedRevision !== undefined && Number(expectedRevision) !== row.revision) {
    throw fail("REVISION_CONFLICT", "This pattern changed while you were working on it. Reload and try again.",
      { expectedRevision: Number(expectedRevision), currentRevision: row.revision });
  }
  /* ── SETTINGS ARE NOT GEOMETRY, SO THEY DO NOT MINT A REVISION ───────
     Seam pairings and fabric choices describe how to DRAPE the pattern, not
     what the pattern is. A new revision for every fabric tweak would bury the
     changes that matter. They are still frozen onto each render job, so what a
     given preview was made with is never in doubt. */
  if (row.state === REVISION_STATE.APPROVED) {
    throw fail("PATTERN_REVISION_FROZEN",
      "This revision is approved, so its simulation settings cannot be changed. "
      + "Edit the pattern to make the next revision, or change the settings there.",
      { state: row.state });
  }
  const who = actorOf(actor);
  const held = row.simulationInputs || {};
  const at = new Date();

  /* ── A CONFIRMATION IS STAMPED HERE, NOT TRUSTED FROM THE CLIENT ──────
     `alignmentConfirmed`, `roleConfirmed`, `grainConfirmed` and
     `boundaryConfirmed` all carry an identity and a time, and a confirmation
     nobody is attributable for is a guess. So the actor and the clock come from
     the server: a client that posted somebody else's name, or a time, would be
     posting the evidence rather than the statement.

     What the client says is only WHETHER it is confirmed. */
  const stamp = (incoming, existing) => {
    if (!incoming) return existing?.at ? existing : null;
    /* Already confirmed by this same decision — keep the original identity and
       time rather than refreshing them on every unrelated save. */
    if (existing?.at && incoming.keep !== false) return existing;
    return { by: who, at };
  };

  const pieces = Array.isArray(inputs.pieces)
    ? inputs.pieces.map((piece) => {
      const before = (held.pieces || []).find((p) => str(p.pieceRef) === str(piece.pieceRef));
      return {
        ...piece,
        pieceRef: str(piece.pieceRef),
        roleConfirmed: stamp(piece.roleConfirmed, before?.roleConfirmed),
        grainConfirmed: stamp(piece.grainConfirmed, before?.grainConfirmed),
        boundaryConfirmed: stamp(piece.boundaryConfirmed, before?.boundaryConfirmed),
      };
    })
    : (held.pieces || []);

  const seams = Array.isArray(inputs.seams)
    ? inputs.seams.map((seam) => {
      const before = (held.seams || []).find((s2) => str(s2.seamId) === str(seam.seamId));
      /* ── RE-CONFIRMATION WHEN THE ALIGNMENT ITSELF CHANGES ──────────
         Keeping the old stamp against a NEW alignment would attribute to
         somebody a statement they did not make. So the confirmation is dropped
         whenever the alignment value moves. */
      const alignmentChanged = before && str(before.alignment) !== str(seam.alignment);
      return {
        ...seam,
        seamId: str(seam.seamId),
        alignmentConfirmed: alignmentChanged
          ? stamp(seam.alignmentConfirmed, null)
          : stamp(seam.alignmentConfirmed, before?.alignmentConfirmed),
      };
    })
    : (held.seams || []);

  row.simulationInputs = {
    template: inputs.template !== undefined ? clean(inputs.template, 40) : str(held.template),
    renderSize: inputs.renderSize !== undefined
      ? clean(inputs.renderSize, 40) : str(held.renderSize),
    avatar: inputs.avatar || held.avatar || {},
    pieces,
    seams,
    fabrics: Array.isArray(inputs.fabrics) ? inputs.fabrics : (held.fabrics || []),
    seamAllowanceMm: inputs.seamAllowanceMm !== undefined
      ? (Number.isFinite(Number(inputs.seamAllowanceMm)) ? Number(inputs.seamAllowanceMm) : null)
      : (held.seamAllowanceMm ?? null),
    settings: inputs.settings || held.settings || {},
  };

  /* ── WHICH REVISION THE MAPPING WAS CONFIRMED AGAINST (R11) ───────────
     Stamped on the revision whose geometry it was confirmed against, so a later
     revision inheriting a copy of these inputs can be told the mapping needs
     re-checking rather than silently re-pointed. */
  row.mappingConfirmedAgainstRef = row.revisionRef;
  row.events.push({ kind: "simulation-inputs", note: "", by: who, at });
  row.revision += 1;
  await row.save();
  return { revision: revisionView(row, { geometry: false }) };
}

/* ═══ APPROVING ═══════════════════════════════════════════════════════════ */

/**
 * Approve a revision, and freeze it.
 *
 * Approving supersedes whatever was approved before — one current pattern per
 * style, always, because "which revision is the garment" cannot have two
 * answers. The superseded one keeps everything it had; it simply stops being
 * current.
 */
async function approveRevision(ctx, { revisionId, note, expectedRevision, actor = null } = {}) {
  assertContext(ctx);
  const row = await revisionForCompany(ctx, revisionId);
  if (expectedRevision !== undefined && Number(expectedRevision) !== row.revision) {
    throw fail("REVISION_CONFLICT", "This pattern changed while you were working on it. Reload and decide again.",
      { expectedRevision: Number(expectedRevision), currentRevision: row.revision });
  }
  if (row.state === REVISION_STATE.APPROVED) {
    throw fail("PATTERN_REVISION_FROZEN", "This revision is already approved.", { state: row.state });
  }
  if (row.state === REVISION_STATE.SUPERSEDED) {
    throw fail("INVALID_TRANSITION",
      "A superseded revision cannot be approved again. Edit it to make a new revision.", { state: row.state });
  }

  /* Approving somebody else's work is a judgement; approving your own is not.
     The same rule the model lifecycle runs on. */
  if (str(row.author?.email) && str(actor?.email)
    && row.author.email === str(actor.email).toLowerCase()) {
    throw fail("MODEL_SELF_APPROVAL",
      "A pattern revision is approved by somebody other than the person who drew it.");
  }

  const who = actorOf(actor);
  const at = new Date();
  const previous = await PatternRevision.findOne(
    byCompany(ctx, { styleId: row.styleId, state: REVISION_STATE.APPROVED }),
  );
  if (previous) {
    previous.state = REVISION_STATE.SUPERSEDED;
    previous.supersededByRef = row.revisionRef;
    previous.events.push({ kind: "superseded", note: row.revisionRef, by: who, at });
    previous.revision += 1;
    await previous.save();
  }

  row.state = REVISION_STATE.APPROVED;
  row.approvedBy = who;
  row.approvedAt = at;
  row.events.push({ kind: "approved", note: clean(note, 2000), by: who, at });
  row.revision += 1;
  await row.save();
  return {
    revision: revisionView(row),
    supersededRef: previous ? previous.revisionRef : "",
  };
}

module.exports = {
  REVISION_STATE, EDIT_KIND, EDITORS,
  listRevisions, readRevision, importRevision, editRevision,
  setSimulationInputs, approveRevision, revisionView, revisionForCompany,
};
