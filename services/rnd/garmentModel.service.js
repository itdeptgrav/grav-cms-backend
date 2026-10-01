// services/rnd/garmentModel.service.js
//
// THE 3D GARMENT WORKSPACE, SERVER SIDE.
//
// ── WHAT IS PUBLISHED, AND WHAT IS MERELY DISPLAYED ─────────────────────────
// A publication is three files and a manifest. The `.zprj`/`.zpac` CLO built
// the garment in is the SOURCE, kept byte-for-byte and never rendered — it is
// the only artifact that can reproduce the garment and nothing downstream may
// alter it. The `.glb` is what a browser can draw, and is the only thing the
// viewer ever loads. The preview still is what the workspace shows while the
// canvas is warming up.
//
// The browser is never asked to open a `.zprj`. Nothing here converts one
// either: CLO exports the GLB, and a "Publish to GRAV CMS" plugin that drives
// that export is a later phase with its own contract.
//
// ── HOW A MARKER STAYS WHERE IT WAS PUT ─────────────────────────────────────
// By naming a node in the published scene graph and a point in THAT NODE'S own
// coordinate frame. Both are read back out of the file at upload time, so a
// marker can only be placed on a node the publication actually contains — an
// anchor naming something the file does not hold is refused rather than stored
// and discovered later as a pin floating in space.
//
// A publication whose exporter counted its nodes out — `Object_12`, `Mesh_3` —
// carries no pattern-piece identity, and that is reported at upload. The
// anchor is still stable, because a node index is stable; what is missing is
// a NAME a person can act on, and saying so at publish time is the difference
// between a limitation and a surprise.
//
// ── AND WHY NO URL HERE IS A PUBLIC ONE ─────────────────────────────────────
// An unreleased garment is a commercial secret. A provider URL is a permanent,
// un-revocable grant to anyone who ever sees it, so none is ever returned: the
// reader is handed a short-lived link back into this service, and the stream
// route re-reads the session, the company and the row before a byte moves.
// That is the same shape `routes/Access/files.js` already uses, with its own
// scope so an asset link cannot open a drive document or the reverse.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const {
  GarmentModelPublication, GarmentModelAnnotation,
  PUBLICATION_STATE, MARKER_CATEGORY, MARKER_STATUS, ASSET_KIND,
  MEASUREMENT_KIND, MEASUREMENT_STATUS, MEASUREMENT_CATEGORY, SCALE_STATE,
  SURFACE_KINDS, MEASUREMENT_HANDOVER_STATES,
  PATTERN_CLASSIFICATION, MAPPING_METHOD, MAPPING_STATE,
} = require("../../models/CMS_Models/RnD/GarmentModel");
const drive = require("../companyDrive.service");
const { inspectGlb, GlbError } = require("../../utils/glbInspect");
const { auditSurfaces } = require("../../utils/glbSurfaceAudit");
const {
  classifyBundleFile, routeDroppedFiles, BUNDLE_KIND, ClassifyError,
} = require("../../utils/bundleFileTypes");
const bundle = require("./patternBundle.service");
const pieceMapping = require("./patternMapping.service");
const { mintLetterToken, verifyLetterToken } = require("../../utils/letterDownloadToken");
const { styleForCompany } = require("../companyContext/rndScope.service");
const publication = require("./technicalPublication.service");
const { fail } = require("../storePurchase/errors");

/* ═══ LIMITS ═══════════════════════════════════════════════════════════════
 * Stated once, enforced server-side, and reported to the screen so a publisher
 * is told the ceiling before a 60MB upload fails at the end of it.
 *
 * The triangle ceiling is not a storage limit — it is an HONESTY limit. A
 * two-million-triangle garment will load on a workstation and will lock up a
 * sampling-room laptop for a minute before it does, and a workspace that
 * accepts one is promising something it cannot deliver on the hardware the
 * people who need it actually have.
 */
const LIMITS = Object.freeze({
  WEB_MODEL_BYTES: 60 * 1024 * 1024,
  SOURCE_BYTES: 120 * 1024 * 1024,
  PREVIEW_BYTES: 8 * 1024 * 1024,
  TRIANGLES: 1_500_000,
  NODES: 5000,
  /* Above this the workspace warns and still loads: it is slow, not wrong. */
  TRIANGLES_WARN: 600_000,
  /* ── THE PATTERN'S TWO CEILINGS ───────────────────────────────────────
     The byte limit is about abuse. The vertex limit is not: the parsed set is
     embedded on the publication, so it has to fit inside MongoDB's document
     ceiling with room to spare. See `patternBundle.service.js` for why dropping
     geometry silently would be the worse failure. */
  PATTERN_BYTES: bundle.LIMITS.PATTERN_BYTES,
  PATTERN_VERTICES: bundle.LIMITS.STORED_VERTICES,
  PATTERN_PIECES: bundle.LIMITS.PIECES,
});

const SOURCE_EXTENSIONS = Object.freeze([".zprj", ".zpac"]);

/**
 * The glTF extensions the browser's loader can actually honour.
 *
 * ── WHY THIS LIST EXISTS ────────────────────────────────────────────────────
 * A glTF may declare extensions as REQUIRED, and the specification says a
 * reader that cannot support one should refuse the file. Three.js is more
 * forgiving than that: it loads the geometry and quietly ignores the material
 * extension it does not know, so the garment appears — in the wrong finish.
 *
 * That is the worst of the three possible outcomes. A refusal is honest and a
 * correct render is correct; a garment drawn in a finish nobody chose is a
 * shade somebody will judge, and a Sketchfab or legacy export carrying
 * `KHR_materials_pbrSpecularGlossiness` does exactly that — the extension was
 * removed from three.js, so the material falls back to metallic-roughness and
 * the fabric reads flatter and greyer than it was authored.
 *
 * So the publication is accepted, because the shape and the anchors are still
 * true, and it is LABELLED: the viewer says the finish is not as exported, and
 * the fix — re-export with metallic-roughness materials — is named.
 */
const VIEWER_EXTENSIONS = Object.freeze([
  "KHR_materials_unlit", "KHR_materials_emissive_strength", "KHR_materials_ior",
  "KHR_materials_specular", "KHR_materials_clearcoat", "KHR_materials_sheen",
  "KHR_materials_transmission", "KHR_materials_volume", "KHR_materials_iridescence",
  "KHR_materials_anisotropy", "KHR_materials_dispersion", "KHR_materials_variants",
  "KHR_texture_transform", "KHR_texture_basisu", "KHR_draco_mesh_compression",
  "KHR_mesh_quantization", "KHR_lights_punctual", "EXT_meshopt_compression",
  "EXT_texture_webp",
]);

/** Required extensions this viewer cannot honour, by name. */
const unsupportedRequired = (manifest) =>
  (manifest.extensionsRequired || []).filter((e) => !VIEWER_EXTENSIONS.includes(str(e)));
const PREVIEW_MIME = Object.freeze(["image/png", "image/jpeg", "image/webp"]);

/** The token scope. A model asset link opens nothing else, by construction. */
const TOKEN_SCOPE = "rnd-garment-model";
const TOKEN_TTL_MS = 10 * 60 * 1000;

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));
const num = (v) => {
  if (v === null || v === undefined || str(v) === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Text from a browser, made safe to store and to render.
 *
 * Control characters are stripped because they are invisible in every review
 * screen and survive into a PDF, a CSV and an IE export; a marker title
 * carrying a line terminator breaks all three and nobody can see why.
 */
const clean = (v, max) => str(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max);

function assertContext(ctx) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
}

const actorOf = (a) => ({
  id: str(a?.id), name: str(a?.name), email: str(a?.email).toLowerCase(),
});

/**
 * The same person, by whichever identity the session happened to carry.
 *
 * Email first because it survives somebody moving between an Employee record
 * and a department account; the id as well because an account may have no
 * address. Used everywhere a decision must not be the author's own — a model
 * being accepted, and now a measurement — so the rule is one function rather
 * than two that drift.
 */
const sameActor = (who, actor) => Boolean(
  (str(actor?.email) && str(who?.email).toLowerCase() === str(actor?.email).toLowerCase())
  || (str(actor?.id) && str(who?.id) === str(actor?.id)),
);

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const mintRef = (prefix) => `${prefix}-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;

/* ═══ READING ONE PUBLICATION, PROVED ══════════════════════════════════════ */

/**
 * One publication, proved to belong to the acting company.
 *
 * Missing and another company's are ONE answer. A refusal that told them apart
 * would be a way to ask whether a competitor's style exists, one id at a time.
 */
async function publicationForCompany(ctx, publicationId, { lean = false } = {}) {
  if (!isId(publicationId)) throw fail("NOT_FOUND", "That model publication was not found.");
  const query = GarmentModelPublication.findOne({
    _id: publicationId, companyId: ctx.companyId,
  });
  const row = await (lean ? query.lean() : query).catch(() => null);
  if (!row) throw fail("NOT_FOUND", "That model publication was not found.");
  return row;
}

/** Refuse a write whose screen was looking at an older copy of the record. */
function assertFresh(row, expectedRevision) {
  const expected = num(expectedRevision);
  if (expected === null) return;
  if (expected !== row.revision) {
    throw fail("REVISION_CONFLICT",
      "This model changed while you were working on it. Reload and decide again.",
      { expectedRevision: expected, currentRevision: row.revision });
  }
}

/* ═══ SIGNED, SHORT-LIVED ASSET LINKS ══════════════════════════════════════ */

/**
 * A link to one asset, good for ten minutes and for one reader.
 *
 * The token is NOT the authorisation. The stream route re-reads the session,
 * the company and the publication on every request, so withdrawing somebody's
 * R&D grant takes effect on their next frame rather than when a link expires.
 * What the token proves is only that the link was issued by us, recently, for
 * this asset and this reader — which is what stops a copied URL from being a
 * bearer grant and what keeps the credential out of the asset's own path.
 */
function assetLink({ publicationRef, publicationId, kind, subject }) {
  const token = mintLetterToken({
    docId: `${publicationId}:${kind}`, scope: TOKEN_SCOPE, subject, ttlMs: TOKEN_TTL_MS,
  });
  return {
    kind,
    /* Relative on purpose: the browser resolves it against the API origin it
       is already authenticated to, and no host this service guesses can be
       wrong in a proxied deployment. */
    url: `/api/cms/rnd/garment-models/${publicationId}/asset/${kind}?t=${encodeURIComponent(token)}`,
    expiresInMs: TOKEN_TTL_MS,
    publicationRef,
  };
}

function verifyAssetToken(token, publicationId, kind) {
  const payload = verifyLetterToken(token);
  if (!payload) return null;
  if (payload.s !== TOKEN_SCOPE) return null;
  if (String(payload.d) !== `${publicationId}:${kind}`) return null;
  return payload;
}

/* ═══ WHAT A READER IS GIVEN ═══════════════════════════════════════════════ */

const assetMeta = (row, kind) => {
  const a = (row.assets || []).find((x) => x.kind === kind);
  return a ? { kind, name: a.name, mimeType: a.mimeType, bytes: a.bytes, sha256: a.sha256 } : null;
};

/**
 * One publication as the workspace reads it.
 *
 * `canDownloadSource` is answered rather than assumed: the CLO source is the
 * garment itself, and reading the workspace is not the same permission as
 * taking the file away.
 */
function publicationView(row, { subject = "", links = false, mayDownloadSource = false, summary = false } = {}) {
  const id = String(row._id);
  const view = {
    id,
    publicationRef: row.publicationRef,
    /* The business name, never the storage object and never the filename. */
    modelNumber: row.modelNumber,
    modelName: `3D model ${row.modelNumber}`,
    title: str(row.title),
    state: row.state,
    styleId: String(row.styleId),
    technicalRevisionRef: str(row.technicalRevisionRef),
    manifest: {
      cloVersion: str(row.manifest?.cloVersion),
      generator: str(row.manifest?.generator),
      gltfVersion: str(row.manifest?.gltfVersion),
      exportedAt: row.manifest?.exportedAt || null,
      unit: str(row.manifest?.unit),
      unitScale: row.manifest?.unitScale ?? null,
      upAxis: str(row.manifest?.upAxis),
      handedness: str(row.manifest?.handedness),
      sourceFileName: str(row.manifest?.sourceFileName),
      extensionsUsed: row.manifest?.extensionsUsed || [],
      extensionsRequired: row.manifest?.extensionsRequired || [],
      note: str(row.manifest?.note),
    },
    stats: {
      nodes: row.stats?.nodes ?? 0,
      meshes: row.stats?.meshes ?? 0,
      materials: row.stats?.materials ?? 0,
      triangles: row.stats?.triangles ?? 0,
      bytes: row.stats?.bytes ?? 0,
      animations: row.stats?.animations ?? 0,
      namedPieces: row.stats?.namedPieces ?? 0,
    },
    /* Said out loud, because it changes what the workspace can promise. */
    heavy: (row.stats?.triangles ?? 0) > LIMITS.TRIANGLES_WARN,
    warnings: row.warnings || [],
    /* The appearance audit travels with the publication so the workspace can
       name the responsible material when somebody clicks a black patch. */
    surfaceAudit: row.surfaceAudit || null,
    anchorable: (row.stats?.namedPieces ?? 0) > 0,
    hasAvatar: Boolean(row.hasAvatar),
    avatarNodeRefs: row.avatarNodeRefs || [],
    /* ── THE LIST DOES NOT CARRY THE SCENE GRAPH ──────────────────────
       A garment publishes hundreds of pattern pieces, and a style with six
       models would send thousands of rows to draw a tab strip. The structure
       belongs to the model a reader actually opened, and the detail route is
       where it comes from. */
    ...(summary ? {} : {
      structure: (row.structure || []).map((n) => ({
        nodeRef: n.nodeRef, parentRef: n.parentRef, name: n.name, kind: n.kind,
        meshName: n.meshName, materialNames: n.materialNames || [],
        triangles: n.triangles, generatedName: n.generatedName, depth: n.depth,
      })),
    }),
    files: {
      webModel: assetMeta(row, ASSET_KIND.WEB_MODEL),
      source: assetMeta(row, ASSET_KIND.SOURCE),
      preview: assetMeta(row, ASSET_KIND.PREVIEW),
      pattern: assetMeta(row, ASSET_KIND.PATTERN),
    },

    /* ── THE BUNDLE'S OWN FACTS ─────────────────────────────────────────
       Which variant, which stated revisions, and what the three files say that
       contradicts each other. Carried on every view including the summary,
       because a tab strip showing "3D model 2" beside a blocking revision
       mismatch is the one place somebody will notice it. */
    bundle: {
      bundleRevision: row.modelNumber,
      bundleName: `Technical bundle ${row.modelNumber}`,
      colourway: str(row.colourway),
      sizeRange: str(row.sizeRange),
      modelSize: str(row.modelSize),
      declaredModelRevision: str(row.declaredModelRevision),
      declaredPatternRevision: str(row.declaredPatternRevision),
      hasPattern: Boolean(row.patternSet),
      hasSource: Boolean(assetMeta(row, ASSET_KIND.SOURCE)),
      /* Which of the three a reader will actually find in this bundle, so the
         version list can label a draft by what it contains rather than by what
         it is called. */
      contains: [
        assetMeta(row, ASSET_KIND.WEB_MODEL) ? "model" : null,
        row.patternSet ? "pattern" : null,
        assetMeta(row, ASSET_KIND.SOURCE) ? "source" : null,
      ].filter(Boolean),
      carriedModelFromRef: str(row.carriedModelFromRef),
      patternSetRef: str(row.patternSet?.patternSetRef),
      patternClassification: str(row.patternSet?.classification),
      patternPieces: row.patternSet?.stats?.pieces ?? 0,
      patternUnit: str(row.patternSet?.unit),
      patternSizes: row.patternSet?.grading?.sizes || [],
      mappingRevision: row.mappingRevision ?? 0,
      confirmedMappings: (row.pieceMappings || [])
        .filter((m) => m.state === MAPPING_STATE.CONFIRMED).length,
      /* A proposal is outstanding work, and the number belongs where the
         bundle is named rather than only inside the mapping screen. */
      unconfirmedMappings: (row.pieceMappings || [])
        .filter((m) => m.state === MAPPING_STATE.UNCONFIRMED).length,
    },
    bundleWarnings: row.bundleWarnings || [],
    /* One answer to "may this be accepted", computed from the severities and
       never from a reviewer's reading of a list. */
    blockingCount: (row.bundleWarnings || []).filter((w) => w.severity === "blocking").length,
    createdBy: row.createdBy || null,
    createdAt: row.createdAt || null,
    submittedAt: row.submittedAt || null,
    submittedBy: row.submittedBy || null,
    decidedAt: row.decidedAt || null,
    decidedBy: row.decidedBy || null,
    decisionNote: str(row.decisionNote),
    supersededByRef: str(row.supersededByRef),
    revision: row.revision ?? 0,
    limits: LIMITS,
  };

  if (links) {
    view.assetUrls = {
      webModel: assetMeta(row, ASSET_KIND.WEB_MODEL)
        ? assetLink({ publicationRef: row.publicationRef, publicationId: id, kind: ASSET_KIND.WEB_MODEL, subject }) : null,
      preview: assetMeta(row, ASSET_KIND.PREVIEW)
        ? assetLink({ publicationRef: row.publicationRef, publicationId: id, kind: ASSET_KIND.PREVIEW, subject }) : null,
      /* The CLO source is offered only to a reader entitled to take it. */
      source: mayDownloadSource && assetMeta(row, ASSET_KIND.SOURCE)
        ? assetLink({ publicationRef: row.publicationRef, publicationId: id, kind: ASSET_KIND.SOURCE, subject }) : null,
      /* ── AND THE PATTERN IS THE SAME KIND OF SECRET AS THE SOURCE ──────
         A DXF is the garment's geometry: whoever holds it can cut the style
         anywhere. So it is offered on the same permission the CLO project is,
         and never as a public URL — the stream route re-reads the session and
         the row before a byte moves, exactly as it does for the model. */
      pattern: mayDownloadSource && assetMeta(row, ASSET_KIND.PATTERN)
        ? assetLink({ publicationRef: row.publicationRef, publicationId: id, kind: ASSET_KIND.PATTERN, subject }) : null,
    };
  }
  return view;
}

/**
 * The acting company, named rather than numbered.
 *
 * Read lazily and failure-tolerantly: a workspace that could not render
 * because the company's display name was unavailable would be refusing to
 * work over a label.
 */
async function companyLabel(companyId) {
  if (!companyId) return null;
  try {
    const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
    const row = await Acc_Company.findById(companyId).select("companyName").lean();
    return { id: String(companyId), name: str(row?.companyName) };
  } catch {
    return { id: String(companyId), name: "" };
  }
}

/* ═══ THE LIST ═════════════════════════════════════════════════════════════ */

/**
 * Every publication on one style, newest model first.
 *
 * The style is proved first, through the same tenancy rule every other R&D
 * read uses, so a style id from a browser reaches nothing.
 */
async function listPublications(ctx, { styleId } = {}) {
  assertContext(ctx);
  const style = await styleForCompany(ctx.companyId, styleId);
  const rows = await GarmentModelPublication
    .find({ companyId: ctx.companyId, styleId: style._id })
    .sort({ modelNumber: -1 }).lean();

  const counts = await GarmentModelAnnotation.aggregate([
    { $match: { companyId: new mongoose.Types.ObjectId(String(ctx.companyId)), styleId: style._id } },
    { $group: { _id: { p: "$publicationId", s: "$status" }, n: { $sum: 1 } } },
  ]).catch(() => []);
  const byPublication = new Map();
  for (const c of counts) {
    const key = String(c._id.p);
    const held = byPublication.get(key) || { open: 0, resolved: 0, in_approved_pack: 0, total: 0 };
    held[c._id.s] = c.n;
    held.total += c.n;
    byPublication.set(key, held);
  }

  const approved = rows.find((r) => r.state === PUBLICATION_STATE.APPROVED) || null;
  return {
    /* Which books this answer is about. The workspace shows it beside the
       style, and an access-denied panel shows it too — "you cannot open this"
       is a different sentence from "you cannot open this FOR THIS COMPANY",
       and only the second one tells somebody what to do next. */
    company: await companyLabel(ctx.companyId),
    style: {
      id: String(style._id),
      sampleStyleId: str(style.sampleStyleId),
      styleCode: str(style.styleCode),
      productName: str(style.productName),
    },
    /* The language the workspace speaks, resolved once here so no screen has
       to work out which row is "the current approved model". */
    currentApprovedRef: approved ? approved.publicationRef : "",
    publications: rows.map((r) => ({
      ...publicationView(r, { summary: true }),
      markers: byPublication.get(String(r._id)) || { open: 0, resolved: 0, in_approved_pack: 0, total: 0 },
    })),
    /* The R&D technical pack this style has approved, so the workspace can
       name it beside the model rather than inventing a second vocabulary. */
    technicalPack: await publication.approvedTechnicalPublicationFor(style).catch(() => null),
  };
}

/* ═══ PUBLISHING A DRAFT ═══════════════════════════════════════════════════ */

/**
 * The CLO source, checked from its CONTENTS and not only its name.
 *
 * ── WHAT CHANGED HERE, AND WHY IT MATTERED ──────────────────────────────────
 * This used to accept any file whose name ended `.zprj`. That made the source
 * slot — the one artifact in the bundle that is kept as evidence and can
 * reproduce the garment — the only one admitted on the uploader's word. A GLB,
 * a DXF, a PDF or somebody's notes renamed `.zprj` all passed, and nobody would
 * find out until the day the project had to be opened from it.
 *
 * The extension still has to be right, because it is how the screen routes the
 * file. What is new is that the bytes have to agree: see `readSource` in
 * `bundleFileTypes.js` for exactly how far that check can honestly go for a
 * format with no published specification.
 */
function assertSourceFile(file) {
  if (!file) return;
  const name = str(file.originalname).toLowerCase();
  if (!SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext))) {
    throw fail("MODEL_SOURCE_UNSUPPORTED",
      `The CLO source must be a ${SOURCE_EXTENSIONS.join(" or ")} file. `
      + "It is kept as evidence and is never rendered in the browser.",
      { accepted: SOURCE_EXTENSIONS });
  }
  try {
    classifyBundleFile(file.buffer, file.originalname, BUNDLE_KIND.SOURCE);
  } catch (err) {
    if (err instanceof ClassifyError) throw fail(err.code, err.message, err.details);
    throw err;
  }
  if (file.size > LIMITS.SOURCE_BYTES) {
    throw fail("MODEL_FILE_TOO_LARGE",
      `That CLO source is over ${Math.round(LIMITS.SOURCE_BYTES / 1024 / 1024)}MB.`,
      { limitBytes: LIMITS.SOURCE_BYTES, bytes: file.size });
  }
}

function assertPreviewFile(file) {
  if (!file) return;
  if (!PREVIEW_MIME.includes(str(file.mimetype).toLowerCase())) {
    throw fail("MODEL_PREVIEW_UNSUPPORTED", "The preview must be a PNG, JPEG or WebP image.",
      { accepted: PREVIEW_MIME });
  }
  if (file.size > LIMITS.PREVIEW_BYTES) {
    throw fail("MODEL_FILE_TOO_LARGE",
      `That preview is over ${Math.round(LIMITS.PREVIEW_BYTES / 1024 / 1024)}MB.`,
      { limitBytes: LIMITS.PREVIEW_BYTES, bytes: file.size });
  }
}

/**
 * Read the web model, refusing anything a browser could not draw.
 *
 * Validated from its own BYTES rather than from its filename or the MIME type
 * the browser guessed, because both of those are the uploader's claim and
 * neither survives being renamed.
 */
function readWebModel(file) {
  if (!file) {
    throw fail("MODEL_WEB_FILE_REQUIRED",
      "A publication needs the web-viewable model. Export it from CLO as GLB.");
  }
  if (file.size > LIMITS.WEB_MODEL_BYTES) {
    throw fail("MODEL_FILE_TOO_LARGE",
      `That model is over ${Math.round(LIMITS.WEB_MODEL_BYTES / 1024 / 1024)}MB. `
      + "Reduce the mesh or the textures in CLO before exporting.",
      { limitBytes: LIMITS.WEB_MODEL_BYTES, bytes: file.size });
  }
  /* ── GLB OR A SELF-CONTAINED GLTF, DECIDED FROM THE BYTES ──────────────
     `classifyBundleFile` reads the container itself and refuses a `.gltf` whose
     geometry or textures live in files beside it — that one would store
     cleanly and render as an empty viewport. See its own header. */
  let classified;
  try {
    classified = classifyBundleFile(file.buffer, file.originalname, BUNDLE_KIND.WEB_MODEL);
  } catch (err) {
    if (err instanceof ClassifyError) throw fail(err.code, err.message, err.details);
    throw err;
  }
  const read = classified.read;
  if (!read) {
    throw fail("MODEL_UNREADABLE", "That file could not be read as a garment model.");
  }
  /* ── WHY THE GARMENT MAY NOT LOOK LIKE IT DID IN CLO ──────────────────
     Read here, where the bytes are still in hand, and recorded rather than
     acted on. Nothing below rewrites a material or drops a mesh: the value of
     a published model is that it is what CLO produced, and a viewer that
     quietly corrects a garment's colour is one nobody can approve a sample
     against. See utils/glbSurfaceAudit.js. */
  read.surfaceAudit = auditSurfaces(file.buffer);
  if (read.stats.triangles > LIMITS.TRIANGLES) {
    throw fail("MODEL_TOO_COMPLEX",
      `This model has ${read.stats.triangles.toLocaleString()} triangles and the workspace accepts `
      + `${LIMITS.TRIANGLES.toLocaleString()}. Decimate it in CLO before exporting — above this it will not `
      + "open on the machines the sampling room uses.",
      { triangles: read.stats.triangles, limit: LIMITS.TRIANGLES });
  }
  if (read.stats.nodes > LIMITS.NODES) {
    throw fail("MODEL_TOO_COMPLEX",
      `This model has ${read.stats.nodes} nodes and the workspace accepts ${LIMITS.NODES}.`,
      { nodes: read.stats.nodes, limit: LIMITS.NODES });
  }
  return read;
}

/** Everything worth saying about a publication that was still accepted. */
function warningsFor(read, { sourceFile }) {
  const out = [];
  /* One merged mesh is the more specific complaint and says everything the
     general one would, so only one of the two is ever raised. */
  if (!read.anchorable && read.stats.meshes === 1) {
    out.push({
      code: "SINGLE_MESH",
      message: "This export contains one unlabelled mesh. Markers will stay in position, but garment-part "
        + "names are unavailable, and there are no separate pieces to isolate. Export the pattern pieces "
        + "separately from CLO, with their names switched on.",
    });
  } else if (!read.anchorable) {
    out.push({
      code: "NO_NAMED_PIECES",
      message: "This export contains unlabelled meshes. Markers will stay in position, but garment-part "
        + "names are unavailable. Re-export from CLO with pattern-piece names switched on.",
    });
  }
  const unsupported = unsupportedRequired(read.manifest);
  if (unsupported.length) {
    out.push({
      code: "MATERIALS_NOT_AS_EXPORTED",
      message: "The export uses an older material extension. Use the technical pack or approved sample "
        + `when judging colour. (${unsupported.join(", ")} — the viewer cannot honour it, so the garment `
        + "draws correctly in a finish it was not authored in.)",
      extensions: unsupported,
    });
  }
  /* ── THE GARMENT DRAWS DIFFERENTLY HERE THAN IT DID IN CLO ──────────
     Named per material and per mesh, with the export change that fixes it,
     because "materials look wrong" tells an exporter nothing. The wording is
     deliberately about the DIFFERENCE rather than about blame: a conforming
     viewer and CLO can both be right about the same file. */
  for (const finding of read.surfaceAudit?.findings || []) {
    out.push({
      code: `SURFACE_${finding.kind}`,
      message: "This area renders differently from the source application. Check the material or "
        + "texture export before using this model for approval."
        + (finding.material ? ` (${finding.material}` : " (")
        + `${(finding.meshes || []).length ? ` on ${finding.meshes.slice(0, 3).join(", ")}`
          + `${finding.meshes.length > 3 ? ` and ${finding.meshes.length - 3} more` : ""}` : ""})`,
      detail: finding.detail,
      exportFix: finding.exportFix,
      material: finding.material || "",
      meshes: finding.meshes || [],
      share: finding.share ?? null,
    });
  }
  if (read.stats.triangles > LIMITS.TRIANGLES_WARN) {
    out.push({
      code: "HEAVY_MODEL",
      message: `${read.stats.triangles.toLocaleString()} triangles will be slow to open on a laptop.`,
    });
  }
  if (read.stats.bytes > 25 * 1024 * 1024) {
    out.push({
      code: "LARGE_DOWNLOAD",
      message: `${(read.stats.bytes / 1024 / 1024).toFixed(0)} MB has to cross the network before the `
        + "first frame. Most of that is usually texture resolution nobody needs at this size.",
    });
  }
  if (!sourceFile) {
    out.push({
      code: "NO_CLO_SOURCE",
      message: "No CLO project file was attached, so this publication cannot be reproduced from source.",
    });
  }
  return out;
}

/**
 * The warnings a carried-forward model keeps.
 *
 * Everything the earlier parse recorded about the FILE still holds — it is the
 * same file. What changes is the bundle around it, so the source warning is
 * recomputed against this bundle's own source and a line is added saying the
 * model was not re-exported, because a reader looking at a draft is entitled to
 * know which half of it is new.
 */
function carriedWarnings(carried, { sourceFile }) {
  const kept = (carried.previous.warnings || []).filter((w) => w.code !== "NO_CLO_SOURCE");
  if (!sourceFile && !(carried.previous.assets || []).some((a) => a.kind === ASSET_KIND.SOURCE)) {
    kept.push({
      code: "NO_CLO_SOURCE",
      message: "No CLO project file was attached, so this publication cannot be reproduced from source.",
    });
  }
  kept.push({
    code: "MODEL_CARRIED_FORWARD",
    message: `The 3D model in this draft is the one accepted as ${carried.previous.publicationRef} `
      + `(3D model ${carried.previous.modelNumber}), not a new export. It is the same file, byte for `
      + "byte. Import a 3D garment if the model itself has changed.",
  });
  return kept;
}

/**
 * CREATE A DRAFT PUBLICATION.
 *
 * Idempotent in the only sense that matters here: the model number is taken
 * from the database, under a unique index, so two simultaneous uploads become
 * model 2 and model 3 rather than two model 2s or one lost upload.
 */
async function createDraft(ctx, { styleId, files = {}, body = {}, actor = null } = {}) {
  assertContext(ctx);
  const style = await styleForCompany(ctx.companyId, styleId);

  const webFile = files.webModel?.[0] || null;
  const sourceFile = files.source?.[0] || null;
  const previewFile = files.preview?.[0] || null;
  const patternFile = files.patterns?.[0] || files.pattern?.[0] || null;

  /* ── A DRAFT THAT CARRIES THE LAST ACCEPTED MODEL FORWARD ──────────────
     The import flow has to be able to say "save this as a draft" for a PATTERN
     too, and a bundle cannot exist without a model. When every bundle on the
     style is already accepted there is no draft to attach to, and the honest
     options are to refuse — telling somebody to re-upload a 40MB model they
     have already published, to add a 66KB pattern — or to open a new draft
     around the model that is already on record.
     This is the second. The same stored object is referenced, so the bytes are
     not duplicated and the hash is unchanged, which is what makes "is this the
     model that was approved" still answerable. It is recorded as carried
     forward rather than uploaded, because those are different acts. */
  const carryFrom = str(body.carryModelFrom);
  let carried = null;
  if (!webFile && carryFrom) {
    const previous = await publicationForCompany(ctx, carryFrom, { lean: true });
    const previousModel = (previous.assets || []).find((a) => a.kind === ASSET_KIND.WEB_MODEL);
    if (!previousModel) {
      throw fail("MODEL_WEB_FILE_REQUIRED",
        "That bundle has no 3D model to carry forward. Import a 3D garment instead.");
    }
    carried = { previous, asset: previousModel };
  }

  const read = carried ? null : readWebModel(webFile);
  assertSourceFile(sourceFile);
  if (!read && !carried) {
    throw fail("MODEL_WEB_FILE_REQUIRED",
      "A publication needs the web-viewable model. Export it from CLO as GLB.");
  }
  /* Parsed BEFORE anything is stored, so a pattern that cannot be read refuses
     the publication rather than leaving a bundle with an unreadable file in
     it. The same discipline the web model has had since Phase 1. */
  const patternRead = patternFile ? readPatternFile(patternFile) : null;
  assertPreviewFile(previewFile);

  /* ── THE SOURCE IS NOT OPTIONAL FOREVER, AND IS OPTIONAL NOW ──────────
     Phase 1 accepts a publication without the CLO project so a team already
     holding GLB exports can start, and the record says which publications
     lack their source rather than pretending every one is reproducible. */
  const stored = [];
  const upload = async (file, kind, folder) => {
    if (!file) return;
    const up = await drive.uploadCompanyFile(file.buffer, {
      fileName: `${mintRef("GMA")}-${str(file.originalname) || kind}`,
      mimeType: str(file.mimetype) || "application/octet-stream",
      folderPath: ["rnd", "garment-models", String(style._id), folder],
    });
    /* ── THE FIELD THE STORE ACTUALLY RETURNS ───────────────────────────
       `uploadCompanyFile` answers `{ driveFileId, mimeType, bytes }`. An
       earlier version of this guessed at `id` with a chain of fallbacks that
       ended in the object itself, so every publication stored the literal
       string "[object Object]" as its file handle and every asset request
       answered 500 — a failure the tests could not see, because the Drive was
       mocked with a shape the Drive does not return.

       One field, named, and no fallback: a handle this code cannot read is a
       publication that will never open, and it is better refused at upload
       than discovered by a reader staring at an empty viewport. */
    const driveFileId = str(up?.driveFileId);
    if (!driveFileId) {
      throw fail("MODEL_UNREADABLE",
        "The file store did not return a handle for that upload, so the model could not be kept. "
        + "Nothing was published; try again.",
        { reason: "NO_STORAGE_HANDLE", kind });
    }
    stored.push({
      kind,
      driveFileId,
      name: str(file.originalname),
      mimeType: str(file.mimetype),
      bytes: file.size,
      sha256: sha256(file.buffer),
    });
  };

  await upload(webFile, ASSET_KIND.WEB_MODEL, "web");
  /* ── A CARRIED MODEL IS REFERENCED, NOT RE-UPLOADED ────────────────────
     The same stored object, the same bytes, the same hash — so "is this the
     model that was approved" has the same answer on both bundles, which is the
     whole point of carrying it rather than asking for it again. Its own upload
     time travels with it, because the model did not arrive now and the
     out-of-step check must not think it did. */
  if (carried) {
    stored.push({
      kind: ASSET_KIND.WEB_MODEL,
      driveFileId: carried.asset.driveFileId,
      name: carried.asset.name,
      mimeType: carried.asset.mimeType,
      bytes: carried.asset.bytes,
      sha256: carried.asset.sha256,
      uploadedAt: carried.asset.uploadedAt || carried.previous.createdAt || new Date(),
    });
  }
  await upload(sourceFile, ASSET_KIND.SOURCE, "source");
  await upload(previewFile, ASSET_KIND.PREVIEW, "preview");
  await upload(patternFile, ASSET_KIND.PATTERN, "pattern");

  const last = await GarmentModelPublication
    .findOne({ companyId: ctx.companyId, styleId: style._id })
    .sort({ modelNumber: -1 }).select("modelNumber").lean();
  const modelNumber = (last?.modelNumber || 0) + 1;

  const technicalPack = await publication.approvedTechnicalPublicationFor(style).catch(() => null);

  const row = await GarmentModelPublication.create({
    companyId: ctx.companyId,
    styleId: style._id,
    publicationRef: mintRef("GM"),
    modelNumber,
    title: clean(body.title, 160) || `${str(style.productName) || "Garment"} — 3D model ${modelNumber}`,
    state: PUBLICATION_STATE.DRAFT,
    assets: stored,
    manifest: {
      /* Stated by the publisher where only a person knows it… */
      cloVersion: clean(body.cloVersion, 60),
      exportedAt: body.exportedAt ? new Date(body.exportedAt) : null,
      unit: ["mm", "cm", "m", "in"].includes(str(body.unit)) ? str(body.unit) : "",
      unitScale: num(body.unitScale),
      upAxis: ["Y", "Z"].includes(str(body.upAxis)) ? str(body.upAxis) : "",
      handedness: ["right", "left"].includes(str(body.handedness)) ? str(body.handedness) : "",
      sourceFileName: str(sourceFile?.originalname) || str(carried?.previous.manifest?.sourceFileName),
      note: clean(body.note, 2000),
      /* …and read from the file where the file already knows — or taken from
         the bundle this model was carried out of, which parsed it already. */
      generator: read ? read.manifest.generator : str(carried.previous.manifest?.generator),
      gltfVersion: read ? read.manifest.gltfVersion : str(carried.previous.manifest?.gltfVersion),
      extensionsUsed: read ? read.manifest.extensionsUsed : (carried.previous.manifest?.extensionsUsed || []),
      extensionsRequired: read
        ? read.manifest.extensionsRequired : (carried.previous.manifest?.extensionsRequired || []),
    },
    structure: read ? read.structure : (carried.previous.structure || []),
    stats: read
      ? { ...read.stats, namedPieces: read.namedPieces }
      : { ...(carried.previous.stats || {}) },
    /* The appearance audit, kept beside the model it describes: the person
       who publishes is rarely the person who later asks why a panel is black. */
    surfaceAudit: read
      ? (read.surfaceAudit || null)
      : (carried.previous.surfaceAudit || null),
    hasAvatar: read ? read.hasAvatar : Boolean(carried.previous.hasAvatar),
    avatarNodeRefs: read ? read.avatarNodeRefs : (carried.previous.avatarNodeRefs || []),
    technicalRevisionRef: str(technicalPack?.technicalRevisionRef),
    /* Stored, not just returned. The person who publishes a model is rarely
       the person who later wonders why the fabric looks grey. */
    warnings: read
      ? warningsFor(read, { sourceFile })
      : carriedWarnings(carried, { sourceFile }),
    /* Which bundle this model came out of, so a reader can see that the 3D
       half of this draft was not re-exported — it is the accepted one. */
    carriedModelFromRef: carried ? carried.previous.publicationRef : "",

    /* ── THE BUNDLE'S OTHER TWO HALVES ──────────────────────────────────── */
    patternSet: patternRead
      ? bundle.ingestPatternSet(patternRead, { file: patternFile, actor, parseRevision: 1 })
      : null,
    colourway: clean(body.colourway, 120),
    sizeRange: clean(body.sizeRange, 120),
    modelSize: clean(body.modelSize, 40),
    declaredModelRevision: clean(body.declaredModelRevision, 60),
    declaredPatternRevision: clean(body.declaredPatternRevision, 60),

    createdBy: actorOf(actor),
  });

  /* ── MATCHED IMMEDIATELY, CONFIRMED BY NOBODY ─────────────────────────
     Proposing the mappings at publish time means the workspace opens with the
     work already laid out; storing them as unconfirmed means not one of them
     counts as a mapping until a person says so. Both halves matter. */
  if (row.patternSet) await rematch(row, { actor });
  await refreshBundleWarnings(row);
  await row.save();

  return {
    publication: publicationView(row, { subject: str(actor?.id) }),
    /* Not refusals, and not hidden either. A publication nobody can anchor a
       named construction marker to is still worth looking at; what it cannot
       do is carry a full technical record, and the publisher is told now
       rather than finding out from a marker that names nothing.
       Read back off the row rather than recomputed: a carried-forward model
       has no fresh parse to compute them from, and the row already holds the
       answer that was stored. */
    warnings: row.warnings || [],
    patternWarnings: patternRead?.warnings || [],
    bundleWarnings: row.bundleWarnings || [],
    /* What the file turned out to be, echoed back so the screen can state the
       classification it is publishing rather than re-deriving it. */
    classification: patternRead
      ? (patternRead.apparel ? PATTERN_CLASSIFICATION.APPAREL : PATTERN_CLASSIFICATION.GENERIC)
      : null,
  };
}

/* ═══ THE FLAT PATTERN ═════════════════════════════════════════════════════
 *
 * ── WHY THE PATTERN IS A SEPARATE ROUTE AS WELL AS A PUBLISH FIELD ──────────
 * Because the order of work is not the order of the form. A style's 3D model
 * routinely exists weeks before anybody drafts the pattern, and a workspace that
 * could only accept the two together would force R&D either to wait or to
 * publish a throwaway model. So a draft bundle accepts a pattern later, and
 * accepts a replacement for one that was wrong.
 *
 * What it does NOT accept is a change to an approved bundle. That is the whole
 * value of an approved bundle and it is enforced in one place, below.
 */

/** Read and classify a pattern upload, refusing what cannot be a pattern. */
function readPatternFile(file) {
  if (!file) {
    throw fail("PATTERN_FILE_REQUIRED", "Attach the pattern export to read it.");
  }
  if (file.size > LIMITS.PATTERN_BYTES) {
    throw fail("PATTERN_TOO_LARGE",
      `That pattern file is over ${Math.round(LIMITS.PATTERN_BYTES / 1024 / 1024)}MB. `
      + "Export one size range at a time.",
      { limitBytes: LIMITS.PATTERN_BYTES, bytes: file.size });
  }
  let classified;
  try {
    classified = classifyBundleFile(file.buffer, file.originalname, BUNDLE_KIND.PATTERN);
  } catch (err) {
    if (err instanceof ClassifyError) throw fail(err.code, err.message, err.details);
    throw err;
  }
  if (!classified.pattern) {
    throw fail("PATTERN_UNREADABLE", "That file could not be read as a pattern.");
  }
  return classified.pattern;
}

/**
 * CLASSIFY FILES WITHOUT STORING ANY OF THEM.
 *
 * ── WHY THIS EXISTS AS ITS OWN ENDPOINT ─────────────────────────────────────
 * The brief's rule is that nothing may be published until each file's
 * classification is visible. That cannot be satisfied by a server that
 * classifies during the publish — by then the decision is made. So the screen
 * asks first, shows what came back, and publishes second, and this is the call
 * it asks with. It writes nothing, mints nothing and touches no publication.
 *
 * It is also what makes a multi-file drop routable: each file is identified with
 * no declared kind, which is exactly the situation a drop creates.
 */
async function classifyUploads(ctx, { files = [], styleId = "", actor = null, geometry = false } = {}) {
  assertContext(ctx);
  const flat = Array.isArray(files) ? files : Object.values(files || {}).flat();
  if (!flat.length) throw fail("VALIDATION", "No files were attached to classify.");

  const routed = routeDroppedFiles(flat);

  /* ── HAS THIS EXACT FILE BEEN PUBLISHED HERE ALREADY? ──────────────────
     Answered by CONTENT, not by filename: `tshirt_final_v2.glb` and
     `tshirt_FINAL.glb` are the same upload if their bytes hash the same, and
     a filename comparison would miss it every time somebody re-downloads
     their own export. Reported rather than refused — re-importing a file
     deliberately is legitimate (a draft was returned, a bundle needs rebuilding
     around it) and only the person knows which case they are in. */
  const seen = styleId ? await publishedHashes(ctx, styleId) : new Map();

  return {
    files: routed.routed.map((entry) => ({
      fileName: entry.fileName,
      extension: entry.extension,
      bytes: entry.bytes,
      classification: entry.classification,
      kind: entry.kind,
      label: entry.label,
      detail: entry.detail,
      warnings: entry.warnings || [],
      sha256: entry.sha256 || "",
      duplicateOf: seen.get(entry.sha256) || null,
      /* The facts a person checks before publishing, and nothing else. */
      /* ── THE PREVIEW'S GEOMETRY, ON REQUEST ──────────────────────────
         Originally withheld: sending a megabyte of outlines for a file that
         may never be published made the preflight cost more than the publish.
         The import flow changed that calculus — a person confirming a pattern
         has to SEE the pieces, their grainlines and their notches before
         committing, and a preview drawn from anything other than the server's
         own parse would be a different pattern from the one that gets stored.
         So it is returned when asked for, and only when asked for. */
      preview: (geometry && entry.pattern) ? patternPreview(entry.pattern) : null,
      summary: entry.pattern ? {
        apparel: entry.pattern.apparel,
        pieces: entry.pattern.stats.pieces,
        namedPieces: entry.pattern.stats.namedPieces,
        sizes: entry.pattern.grading.sizes,
        graded: entry.pattern.grading.graded,
        unit: entry.pattern.unit,
        unitSource: entry.pattern.unitSource,
        unitDeclared: entry.pattern.unitDeclared,
        notches: entry.pattern.stats.notches,
        drillPoints: entry.pattern.stats.drillPoints,
        grainlines: entry.pattern.stats.grainlines,
        internalLines: entry.pattern.stats.internalLines,
        conventions: entry.pattern.conventions,
        styleName: entry.pattern.manifest.styleName,
        product: entry.pattern.manifest.product,
        author: entry.pattern.manifest.author,
        sampleSize: entry.pattern.manifest.sampleSize,
        pieceNames: entry.pattern.pieces.map((piece) => ({
          name: piece.name, size: piece.size, quantity: piece.quantity,
          generatedName: piece.generatedName,
        })),
      } : (entry.read ? {
        meshes: entry.read.stats.meshes,
        nodes: entry.read.stats.nodes,
        triangles: entry.read.stats.triangles,
        materials: entry.read.stats.materials,
        animations: entry.read.stats.animations,
        namedPieces: entry.read.namedPieces,
        anchorable: entry.read.anchorable,
        hasAvatar: entry.read.hasAvatar,
        generator: entry.read.manifest.generator,
        gltfVersion: entry.read.manifest.gltfVersion,
        extensionsRequired: entry.read.manifest.extensionsRequired || [],
        /* ── UNITS AND AXIS, SAID AS THE FORMAT ACTUALLY SAYS THEM ──────
           glTF 2.0 SPECIFIES a right-handed, Y-up coordinate system and
           metres as the unit of distance. Neither is written in the file, so
           reporting "Y-up, metres" as though this export had declared it
           would be presenting a specification as a measurement.
           It matters because garment exporters frequently do not honour the
           metre: a CLO export is routinely in centimetres with the glTF still
           claiming nothing. So the format's guarantee and the file's silence
           are reported as the two different things they are, and the bundle
           records what the PUBLISHER states separately. */
        axis: "Y-up, right-handed",
        axisSource: "glTF 2.0 specification — not stated in the file",
        unit: "",
        unitNote: "glTF declares no unit. The format assumes metres and garment "
          + "exporters frequently do not honour that, so state the export's real unit below.",
      } : (entry.source ? {
        container: entry.source.container,
        /* Said plainly: a `.zprj` is identified by exclusion, because its
           layout is not published. Overstating that would be the kind of quiet
           claim this whole record exists to avoid. */
        signatureVerified: entry.source.signatureVerified,
      } : null)),
    })),
    rejected: routed.rejected,
    conflicts: routed.conflicts,
    confirmationRequired: routed.confirmationRequired,
    actorId: str(actor?.id),
  };
}

/**
 * Every file content-hash already published on one style, and where it came from.
 *
 * Keyed by hash so a lookup is one map read per uploaded file rather than a
 * scan per file. Scoped to the style, because the same block of fabric geometry
 * legitimately appears on two different styles and that is not a duplicate —
 * what is worth reporting is the same file imported twice into the same garment.
 */
async function publishedHashes(ctx, styleId) {
  const found = new Map();
  if (!isId(styleId)) return found;
  const style = await styleForCompany(ctx.companyId, styleId).catch(() => null);
  if (!style) return found;

  const rows = await GarmentModelPublication
    .find({ companyId: ctx.companyId, styleId: style._id })
    .select("publicationRef modelNumber state assets.kind assets.sha256 assets.name assets.uploadedAt")
    .sort({ modelNumber: -1 })
    .lean()
    .catch(() => []);

  for (const row of rows) {
    for (const asset of (row.assets || [])) {
      const hash = str(asset.sha256);
      if (!hash || found.has(hash)) continue;
      found.set(hash, {
        publicationRef: row.publicationRef,
        modelNumber: row.modelNumber,
        bundleName: `Technical bundle ${row.modelNumber}`,
        state: row.state,
        kind: asset.kind,
        fileName: str(asset.name),
        uploadedAt: asset.uploadedAt || null,
      });
    }
  }
  return found;
}

/**
 * The parsed pattern, cut down to what a confirmation preview draws.
 *
 * ── WHY A SEPARATE SHAPE AND NOT THE STORED ONE ─────────────────────────────
 * The stored piece carries every field the inspector, the mapping and the IE
 * projection need. A preview needs the OUTLINES and the marks a person checks
 * before committing — the pieces are there, the grain runs the right way, the
 * notches landed. Sending the rest would double the payload of a call that may
 * be thrown away, and the person is not being asked to confirm the rest yet.
 *
 * Capped, and the cap is reported. A preview that silently dropped the last
 * fifteen pieces of a graded range would be the one thing worse than no preview.
 */
function patternPreview(read) {
  const pieces = read.pieces || [];
  const LIMIT = 80;
  const shown = pieces.slice(0, LIMIT);
  return {
    unit: read.unit,
    scaleVerified: Boolean(read.unit && read.unitInMm),
    unitInMm: read.unitInMm ?? null,
    bounds: read.bounds,
    pieceCount: pieces.length,
    shownCount: shown.length,
    truncated: pieces.length > LIMIT,
    pieces: shown.map((piece, index) => ({
      /* A preview ref, NOT the stored one: nothing has been ingested yet, and
         handing out an identifier that does not exist in any record is how a
         screen comes to reference a piece nobody can look up. */
      pieceRef: `preview-${index}`,
      name: str(piece.name),
      generatedName: Boolean(piece.generatedName),
      size: str(piece.size),
      quantity: piece.quantity ?? null,
      width: piece.width ?? null,
      height: piece.height ?? null,
      area: piece.area ?? null,
      bounds: piece.bounds || null,
      outline: piece.outline || [],
      outlineClosed: Boolean(piece.outlineClosed),
      internalLines: piece.internalLines || [],
      notches: piece.notches || [],
      drillPoints: piece.drillPoints || [],
      grainline: piece.grainline || null,
      mirrorLine: piece.mirrorLine || null,
      sewLine: piece.sewLine || null,
      /* Present so the preview's own piece list reads like the real one. */
      notchCount: (piece.notches || []).length,
      drillPointCount: (piece.drillPoints || []).length,
      internalLineCount: (piece.internalLines || []).length,
      material: str(piece.material),
      componentClass: str(piece.componentClass),
    })),
  };
}

/** An approved bundle is a record, not a workspace. One place says so. */
function assertBundleEditable(row, what) {
  if ([PUBLICATION_STATE.APPROVED, PUBLICATION_STATE.SUPERSEDED].includes(row.state)) {
    throw fail("MODEL_STATE_CONFLICT",
      `This technical bundle has been accepted, so ${what} cannot be changed. Publish a new bundle `
      + "to record a revision.",
      { state: row.state });
  }
}

/**
 * ATTACH OR REPLACE THE PATTERN ON A DRAFT BUNDLE.
 *
 * A replacement re-parses, re-matches and bumps the parse revision — and
 * deliberately KEEPS mappings a person confirmed, because the alternative is
 * throwing away the only evidence in the system with a name on it every time
 * somebody fixes a notch. `proposeMappings` carries them over and the mapping
 * revision records which parse they were confirmed against, so a stale
 * confirmation is visible rather than silently trusted.
 */
async function attachPatternSet(ctx, { publicationId, file, body = {}, expectedRevision, actor = null } = {}) {
  assertContext(ctx);
  const row = await publicationForCompany(ctx, publicationId);
  assertFresh(row, expectedRevision);
  assertBundleEditable(row, "its pattern");

  const read = readPatternFile(file);
  const replacing = Boolean(row.patternSet);
  const parseRevision = (row.patternSet?.parseRevision || 0) + 1;

  const up = await drive.uploadCompanyFile(file.buffer, {
    fileName: `${mintRef("GMA")}-${str(file.originalname) || "pattern.dxf"}`,
    mimeType: str(file.mimetype) || "application/dxf",
    folderPath: ["rnd", "garment-models", String(row.styleId), "pattern"],
  });
  const driveFileId = str(up?.driveFileId);
  if (!driveFileId) {
    throw fail("PATTERN_UNREADABLE",
      "The file store did not return a handle for that upload, so the pattern could not be kept. "
      + "Nothing was changed; try again.",
      { reason: "NO_STORAGE_HANDLE" });
  }

  row.assets = (row.assets || []).filter((a) => a.kind !== ASSET_KIND.PATTERN);
  row.assets.push({
    kind: ASSET_KIND.PATTERN,
    driveFileId,
    name: str(file.originalname),
    mimeType: str(file.mimetype),
    bytes: file.size,
    sha256: sha256(file.buffer),
    uploadedAt: new Date(),
  });
  row.patternSet = bundle.ingestPatternSet(read, { file, actor, parseRevision });
  if (str(body.declaredPatternRevision)) {
    row.declaredPatternRevision = clean(body.declaredPatternRevision, 60);
  }
  if (str(body.sizeRange)) row.sizeRange = clean(body.sizeRange, 120);
  appendNote(row, body.note, replacing ? "Pattern replaced" : "Pattern attached");

  await rematch(row, { actor });
  await refreshBundleWarnings(row);
  row.revision += 1;
  await row.save();

  return {
    publication: publicationView(row, { subject: str(actor?.id) }),
    patternSet: patternSetView(row, { full: false }),
    replaced: replacing,
    classification: row.patternSet.classification,
    patternWarnings: read.warnings || [],
    bundleWarnings: row.bundleWarnings || [],
  };
}

/**
 * Record what somebody said about a change to a bundle.
 *
 * ── APPENDED, NEVER REPLACED ────────────────────────────────────────────────
 * A bundle accumulates changes — a pattern replaced, a source attached — and
 * each one may carry its own "what changed, and why". Overwriting the note each
 * time would mean the only surviving explanation is the most recent, which is
 * exactly backwards: the earlier ones are the history.
 *
 * Empty input changes nothing, so an import with no note does not blank the one
 * already there.
 */
function appendNote(row, text, what) {
  const addition = clean(text, 2000);
  if (!addition) return;
  const existing = str(row.manifest?.note);
  const line = `${what}: ${addition}`;
  row.manifest.note = existing ? `${existing}\n${line}`.slice(0, 2000) : line.slice(0, 2000);
}

/**
 * ATTACH OR REPLACE THE CLO SOURCE ON A DRAFT BUNDLE.
 *
 * ── WHY THIS IS NOT PARSED, AND SAYS SO ─────────────────────────────────────
 * A `.zprj` is CLO's own container and its layout is not a published format.
 * Nothing in this service opens one, nothing claims to read one, and no screen
 * presents a field as having come out of it. What is stored is the bytes, their
 * hash, their size and what the person said about them — which is the whole of
 * what can honestly be known, and is enough for the one job the file has: being
 * the evidence that can reproduce the garment.
 *
 * It is validated by EXCLUSION (see `readSource`): it must not be a format this
 * server can positively identify as something else, and must not be text. That
 * catches every renamed GLB, DXF, PDF and set of notes, which is the failure
 * that actually happens.
 */
async function attachSource(ctx, { publicationId, file, body = {}, expectedRevision, actor = null } = {}) {
  assertContext(ctx);
  const row = await publicationForCompany(ctx, publicationId);
  assertFresh(row, expectedRevision);
  assertBundleEditable(row, "its CLO source");

  if (!file) throw fail("VALIDATION", "Attach the CLO project file.");
  assertSourceFile(file);

  const up = await drive.uploadCompanyFile(file.buffer, {
    fileName: `${mintRef("GMA")}-${str(file.originalname) || "source.zprj"}`,
    mimeType: str(file.mimetype) || "application/octet-stream",
    folderPath: ["rnd", "garment-models", String(row.styleId), "source"],
  });
  const driveFileId = str(up?.driveFileId);
  if (!driveFileId) {
    throw fail("MODEL_SOURCE_UNSUPPORTED",
      "The file store did not return a handle for that upload, so the source could not be kept. "
      + "Nothing was changed; try again.", { reason: "NO_STORAGE_HANDLE" });
  }

  const replacing = Boolean((row.assets || []).find((a) => a.kind === ASSET_KIND.SOURCE));
  row.assets = (row.assets || []).filter((a) => a.kind !== ASSET_KIND.SOURCE);
  row.assets.push({
    kind: ASSET_KIND.SOURCE,
    driveFileId,
    name: str(file.originalname),
    mimeType: str(file.mimetype),
    bytes: file.size,
    sha256: sha256(file.buffer),
    uploadedAt: new Date(),
  });
  row.manifest.sourceFileName = str(file.originalname);
  if (str(body.cloVersion)) row.manifest.cloVersion = clean(body.cloVersion, 60);
  appendNote(row, body.note, replacing ? "CLO source replaced" : "CLO source attached");

  /* The "no source" warning is a statement about the bundle, so it stops being
     true the moment one arrives. A stale warning is as corrosive as a missing
     one — see `refreshBundleWarnings`. */
  row.warnings = (row.warnings || []).filter((w) => w.code !== "NO_CLO_SOURCE");
  await refreshBundleWarnings(row);
  row.revision += 1;
  await row.save();

  return {
    publication: publicationView(row, { subject: str(actor?.id) }),
    replaced: replacing,
    bundleWarnings: row.bundleWarnings || [],
  };
}

/* ═══ MAPPING ══════════════════════════════════════════════════════════════ */

/** Re-run the matcher over the current pattern and structure, in place. */
async function rematch(row, { actor = null } = {}) {
  if (!row.patternSet) {
    row.pieceMappings = [];
    row.mappingRevision = 0;
    return null;
  }
  const revision = (row.mappingRevision || 0) + 1;
  const result = pieceMapping.proposeMappings(
    row.patternSet, row.structure || [], row.pieceMappings || [], revision,
  );
  row.pieceMappings = result.mappings;
  row.mappingRevision = revision;
  return result;
}

/** The current mapping picture, recomputed for reading rather than stored. */
function mappingState(row) {
  if (!row.patternSet) return null;
  return pieceMapping.proposeMappings(
    row.patternSet, row.structure || [], row.pieceMappings || [], row.mappingRevision || 1,
  );
}

/** Recompute and store what the bundle's files say that contradicts itself. */
async function refreshBundleWarnings(row) {
  row.bundleWarnings = bundle.bundleCoherence(row);
  return row.bundleWarnings;
}

/**
 * CONFIRM, REJECT OR SET A MAPPING BY HAND.
 *
 * ── THE ONE RULE THIS ENDPOINT ENFORCES ─────────────────────────────────────
 * Confirming is an act with an author. There is no body shape here that sets
 * `state: "confirmed"` without recording who did it and when, because a
 * confirmation nobody is attributable for is indistinguishable from the guess
 * it was meant to settle.
 */
async function setPieceMapping(ctx, { publicationId, body = {}, expectedRevision, actor = null } = {}) {
  assertContext(ctx);
  const row = await publicationForCompany(ctx, publicationId);
  assertFresh(row, expectedRevision);
  assertBundleEditable(row, "its pattern mapping");
  if (!row.patternSet) {
    throw fail("PATTERN_NOT_PUBLISHED",
      "This bundle has no flat pattern, so there are no pieces to map.");
  }

  const pieceRef = str(body.pieceRef);
  const piece = (row.patternSet.pieces || []).find((p) => p.pieceRef === pieceRef);
  if (!piece) throw fail("NOT_FOUND", "That pattern piece is not in this bundle.");

  const action = str(body.action) || "confirm";
  const existingIndex = (row.pieceMappings || []).findIndex((m) => m.pieceRef === pieceRef);

  if (action === "clear") {
    if (existingIndex >= 0) row.pieceMappings.splice(existingIndex, 1);
    row.revision += 1;
    await row.save();
    return mappingResult(row, actor);
  }

  if (action === "reject") {
    const current = existingIndex >= 0 ? row.pieceMappings[existingIndex] : null;
    const rejected = {
      pieceRef,
      pieceName: str(piece.name),
      /* A rejection has to name what was rejected, or re-running the matcher
         cannot tell which proposal a person turned down. */
      nodeRef: str(body.nodeRef) || str(current?.nodeRef) || "-",
      nodeName: str(body.nodeName) || str(current?.nodeName),
      method: current?.method || MAPPING_METHOD.MANUAL,
      confidence: current?.confidence ?? 0,
      basis: str(current?.basis),
      state: MAPPING_STATE.REJECTED,
      confirmedBy: actorOf(actor),
      confirmedAt: new Date(),
      note: clean(body.note, 1000),
      mappingRevision: row.mappingRevision || 1,
    };
    /* `.set()` rather than index assignment: a DocumentArray casts through
       `set` and does not reliably cast a plain object written straight to an
       index, which is how a mapping ends up stored with none of its fields. */
    if (existingIndex >= 0) row.pieceMappings.set(existingIndex, rejected);
    else row.pieceMappings.push(rejected);
    row.revision += 1;
    await row.save();
    return mappingResult(row, actor);
  }

  /* ── CONFIRM, OR SET ONE OUTRIGHT ───────────────────────────────────────
     A node named in the body is a MANUAL mapping whatever the matcher thought,
     and it is recorded as `manual` rather than inheriting the proposal's
     method: a person overriding a 70% name match has not made a 70% name
     match, they have made a decision. */
  const nodeRef = str(body.nodeRef);
  const current = existingIndex >= 0 ? row.pieceMappings[existingIndex] : null;
  const target = nodeRef || str(current?.nodeRef);
  if (!target) {
    throw fail("VALIDATION",
      "Name the 3D component this piece maps to. There is no proposal to confirm.");
  }
  const node = (row.structure || []).find((n) => n.nodeRef === target);
  if (!node) {
    throw fail("MODEL_ANCHOR_UNKNOWN",
      "That 3D component is not in this publication's model.", { nodeRef: target });
  }

  const manual = Boolean(nodeRef) && nodeRef !== str(current?.nodeRef);
  const confirmed = {
    pieceRef,
    pieceName: str(piece.name),
    nodeRef: node.nodeRef,
    nodeName: str(node.name),
    method: manual ? MAPPING_METHOD.MANUAL : (current?.method || MAPPING_METHOD.MANUAL),
    confidence: manual
      ? pieceMapping.CONFIDENCE[MAPPING_METHOD.MANUAL]
      : (current?.confidence ?? pieceMapping.CONFIDENCE[MAPPING_METHOD.MANUAL]),
    basis: manual
      ? `${str(actor?.name) || "A reviewer"} matched this piece to "${str(node.name)}".`
      : str(current?.basis),
    state: MAPPING_STATE.CONFIRMED,
    confirmedBy: actorOf(actor),
    confirmedAt: new Date(),
    /* ── ONE PIECE, A REPEATED LEFT/RIGHT COMPONENT ───────────────────────
       Only ever from an explicit flag on the request. A matcher is never
       allowed to decide that a piece is cut twice. */
    repeatedComponent: body.repeatedComponent === true || body.repeatedComponent === "true",
    note: clean(body.note, 1000),
    mappingRevision: row.mappingRevision || 1,
  };
  if (existingIndex >= 0) row.pieceMappings.set(existingIndex, confirmed);
  else row.pieceMappings.push(confirmed);

  row.revision += 1;
  await row.save();
  return mappingResult(row, actor);
}

/** Re-run the matcher on request — after a model or pattern replacement. */
async function rematchMappings(ctx, { publicationId, expectedRevision, actor = null } = {}) {
  assertContext(ctx);
  const row = await publicationForCompany(ctx, publicationId);
  assertFresh(row, expectedRevision);
  assertBundleEditable(row, "its pattern mapping");
  if (!row.patternSet) {
    throw fail("PATTERN_NOT_PUBLISHED", "This bundle has no flat pattern, so there is nothing to match.");
  }
  await rematch(row, { actor });
  row.revision += 1;
  await row.save();
  return mappingResult(row, actor);
}

function mappingResult(row, actor) {
  const state = mappingState(row);
  return {
    mapping: mappingView(row, state),
    publication: publicationView(row, { subject: str(actor?.id) }),
    checks: bundle.derivedChecks(row, state, row.bundleWarnings || []),
  };
}

function mappingView(row, state = null) {
  const computed = state || mappingState(row);
  if (!computed) return null;
  return {
    mappingRevision: row.mappingRevision || 0,
    /* What the model can and cannot do, said before any list of failures. A
       reader seeing five unmapped pieces needs to know first whether the model
       could ever have matched them. */
    availability: computed.availability,
    mappings: (computed.mappings || []).map((m) => ({
      pieceRef: m.pieceRef,
      pieceName: str(m.pieceName),
      nodeRef: m.nodeRef,
      nodeName: str(m.nodeName),
      method: m.method,
      confidence: m.confidence,
      basis: str(m.basis),
      state: m.state,
      confirmedBy: str(m.confirmedBy?.name),
      confirmedAt: m.confirmedAt || null,
      repeatedComponent: Boolean(m.repeatedComponent),
      note: str(m.note),
      mappingRevision: m.mappingRevision ?? 1,
      /* ── SAID, NOT INFERRED BY THE SCREEN ─────────────────────────────
         Whether this mapping may be relied on downstream is one rule and it
         lives on the server. A screen computing it from `state` would be a
         second copy of the rule, and the two would eventually disagree. */
      usable: m.state === MAPPING_STATE.CONFIRMED,
    })),
    unmapped: (computed.unmapped || []).map((u) => ({
      pieceRef: u.pieceRef,
      pieceName: str(u.pieceName),
      reason: u.reason,
      suggestions: u.suggestions || [],
    })),
    unmatchedComponents: computed.unmatchedComponents || [],
    awaitingConfirmation: computed.awaitingConfirmation || 0,
    confirmed: (computed.mappings || []).filter((m) => m.state === MAPPING_STATE.CONFIRMED).length,
  };
}

/**
 * The parsed pattern, as the 2D viewer reads it.
 *
 * `full` decides whether the point arrays travel. The piece list, the filters
 * and the inspector need every field EXCEPT the geometry; the viewer needs the
 * geometry. Sending outlines to a screen drawing a tab strip is how a list
 * costs four megabytes.
 */
function patternSetView(row, { full = true } = {}) {
  const set = row.patternSet;
  if (!set) return null;
  const mappings = new Map((row.pieceMappings || []).map((m) => [m.pieceRef, m]));

  return {
    patternSetRef: set.patternSetRef,
    classification: set.classification,
    /* The one sentence that decides how everything below may be read. */
    isApparelPattern: set.classification === PATTERN_CLASSIFICATION.APPAREL,
    manifest: set.manifest || {},
    unit: str(set.unit),
    unitSource: str(set.unitSource),
    unitDeclared: str(set.unitDeclared),
    unitInMm: set.unitInMm ?? null,
    scaleVerified: Boolean(set.unit && set.unitInMm),
    grading: set.grading || {},
    stats: set.stats || {},
    bounds: set.bounds || null,
    conventions: set.conventions || [],
    layersSeen: set.layersSeen || [],
    warnings: set.warnings || [],
    fileName: str(set.fileName),
    sha256: str(set.sha256),
    publishedBy: str(set.publishedBy?.name),
    publishedAt: set.publishedAt || null,
    parseRevision: set.parseRevision ?? 1,

    pieces: (set.pieces || []).map((piece) => {
      const mapped = mappings.get(piece.pieceRef) || null;
      const base = {
        pieceRef: piece.pieceRef,
        publishedId: str(piece.publishedId),
        name: str(piece.name),
        blockName: str(piece.blockName),
        /* So a screen can say "unnamed pattern piece" and show the identifier
           beside it as the technical reference it is — the same honesty the 3D
           structure panel already uses for `Object_2`. */
        generatedName: Boolean(piece.generatedName),
        index: piece.index,
        size: str(piece.size),
        quantity: piece.quantity ?? null,
        material: str(piece.material),
        componentClass: str(piece.componentClass),
        description: str(piece.description),
        width: piece.width ?? null,
        height: piece.height ?? null,
        area: piece.area ?? null,
        perimeter: piece.perimeter ?? null,
        bounds: piece.bounds || null,
        insert: piece.insert || null,
        grainline: piece.grainline || null,
        notchCount: (piece.notches || []).length,
        drillPointCount: (piece.drillPoints || []).length,
        internalLineCount: (piece.internalLines || []).length,
        seamAllowance: piece.seamAllowance || null,
        cutOnFold: piece.cutOnFold ?? null,
        mirrored: piece.mirrored ?? null,
        insertCount: piece.insertCount ?? null,
        approximated: str(piece.approximated) || null,
        layersUsed: piece.layersUsed || [],
        /* The mapped component, carried on the piece so the inspector does not
           have to join two lists to answer its most-asked question. */
        mappedNodeRef: mapped && mapped.state === MAPPING_STATE.CONFIRMED ? mapped.nodeRef : "",
        mappedNodeName: mapped && mapped.state === MAPPING_STATE.CONFIRMED ? str(mapped.nodeName) : "",
        mappingState: mapped ? mapped.state : "unmapped",
        mappingMethod: mapped ? mapped.method : "",
        mappingConfidence: mapped ? mapped.confidence : null,
      };
      if (!full) return base;
      return {
        ...base,
        outline: piece.outline || [],
        outlineClosed: Boolean(piece.outlineClosed),
        extraBoundaries: piece.extraBoundaries || [],
        sewLine: piece.sewLine || null,
        internalLines: piece.internalLines || [],
        cutouts: piece.cutouts || [],
        notches: piece.notches || [],
        drillPoints: piece.drillPoints || [],
        turnPoints: piece.turnPoints || [],
        gradePoints: piece.gradePoints || [],
        mirrorLine: piece.mirrorLine || null,
      };
    }),
  };
}

/** The pattern, its mapping and everything derived from both. */
async function readPatternSet(ctx, { publicationId, actor = null } = {}) {
  assertContext(ctx);
  const row = await publicationForCompany(ctx, publicationId, { lean: true });
  if (!row.patternSet) {
    return {
      patternSet: null,
      mapping: null,
      checks: bundle.derivedChecks(row, null, row.bundleWarnings || []),
      measurements: null,
      bundleWarnings: row.bundleWarnings || [],
      state: row.state,
      /* ── `editable` BELONGS ON THIS BRANCH TOO ─────────────────────────
         It was omitted here, and the consequence was precise: the workspace
         reads `editable` to decide whether to offer "Attach the flat pattern",
         so a DRAFT bundle with no pattern — the exact case that needs the
         control most, and the normal way a pattern arrives — never showed it.
         A bundle could only ever receive a pattern at the moment it was first
         published, which is not the order the work happens in.
         Found by opening the thing, which is what a live pass is for. */
      editable: ![PUBLICATION_STATE.APPROVED, PUBLICATION_STATE.SUPERSEDED].includes(row.state),
      /* Not an error. A bundle without a pattern yet is an ordinary state. */
      reason: "This technical bundle has no flat pattern attached.",
    };
  }
  const state = mappingState(row);
  return {
    patternSet: patternSetView(row, { full: true }),
    mapping: mappingView(row, state),
    checks: bundle.derivedChecks(row, state, row.bundleWarnings || []),
    measurements: bundle.patternMeasurements(row.patternSet),
    bundleWarnings: row.bundleWarnings || [],
    state: row.state,
    /* An approved bundle is read-only, and the server says so rather than the
       screen deciding from a state string. */
    editable: ![PUBLICATION_STATE.APPROVED, PUBLICATION_STATE.SUPERSEDED].includes(row.state),
  };
}

/* ═══ THE LIFECYCLE ════════════════════════════════════════════════════════ */

/** DRAFT or RETURNED → IN_REVIEW. R&D says it is ready to be looked at. */
async function submitForReview(ctx, { publicationId, expectedRevision, actor = null } = {}) {
  assertContext(ctx);
  const row = await publicationForCompany(ctx, publicationId);
  assertFresh(row, expectedRevision);

  if (![PUBLICATION_STATE.DRAFT, PUBLICATION_STATE.RETURNED].includes(row.state)) {
    throw fail("MODEL_STATE_CONFLICT",
      `This model is ${row.state.toLowerCase().replace("_", " ")} and cannot be submitted from there.`,
      { state: row.state });
  }
  row.state = PUBLICATION_STATE.IN_REVIEW;
  row.submittedAt = new Date();
  row.submittedBy = actorOf(actor);
  row.revision += 1;
  await row.save();
  return { publication: publicationView(row, { subject: str(actor?.id) }) };
}

/**
 * THE DECISION, AND IT IS NOT THE PUBLISHER'S.
 *
 * ── MAKER AND CHECKER ───────────────────────────────────────────────────────
 * The person who uploaded a model may not be the person who accepts it. An
 * approved publication is what IE will map operations against and what Costing
 * will read a construction note from; one desk doing both halves is the
 * weakness every other approval in this codebase already refuses.
 *
 * Approving supersedes the previous approved model, so "the current approved
 * model" has exactly one answer. The superseded one keeps its markers and
 * stays readable — a costing that quoted it has to be able to read what it
 * quoted.
 */
async function decide(ctx, { publicationId, outcome, note = "", expectedRevision, actor = null } = {}) {
  assertContext(ctx);
  const row = await publicationForCompany(ctx, publicationId);
  assertFresh(row, expectedRevision);

  if (row.state !== PUBLICATION_STATE.IN_REVIEW) {
    throw fail("MODEL_STATE_CONFLICT",
      `This model is ${row.state.toLowerCase().replace("_", " ")}; there is nothing in review to decide.`,
      { state: row.state });
  }

  /* ── A CONTRADICTION IS NOT APPROVABLE ─────────────────────────────────
     Recomputed at the moment of decision rather than read from what was stored
     at upload: a mismatch resolved by replacing the pattern must not still
     block, and one introduced since must. Only BLOCKING findings refuse —
     absent optional metadata never does, which is the brief's own rule and also
     the only way the workspace can hold a sample-size pattern at all. */
  if (outcome === "approve") {
    await refreshBundleWarnings(row);
    const checks = bundle.derivedChecks(row, mappingState(row), row.bundleWarnings || []);
    if (!checks.approvable) {
      throw fail("BUNDLE_NOT_APPROVABLE",
        `This technical bundle cannot be accepted while ${checks.blocking.length} blocking `
        + `${checks.blocking.length === 1 ? "finding stands" : "findings stand"}: `
        + `${checks.blocking.map((f) => f.message).join(" ")}`,
        { blocking: checks.blocking });
    }
  }

  const same = (who) => sameActor(who, actor);
  if (outcome === "approve" && (same(row.createdBy) || same(row.submittedBy))) {
    throw fail("MODEL_SELF_APPROVAL",
      "A model is accepted by somebody other than the person who published it. "
      + "IE and Costing both read it, so it is not one person's decision alone.",
      { publicationRef: row.publicationRef });
  }

  const at = new Date();
  row.decidedAt = at;
  row.decidedBy = actorOf(actor);
  row.decisionNote = clean(note, 2000);
  row.revision += 1;

  if (outcome === "approve") {
    const previous = await GarmentModelPublication.findOne({
      companyId: ctx.companyId, styleId: row.styleId, state: PUBLICATION_STATE.APPROVED,
    });
    if (previous) {
      previous.state = PUBLICATION_STATE.SUPERSEDED;
      previous.supersededByRef = row.publicationRef;
      previous.revision += 1;
      await previous.save();
    }
    row.state = PUBLICATION_STATE.APPROVED;
  } else {
    row.state = PUBLICATION_STATE.RETURNED;
  }
  await row.save();
  return { publication: publicationView(row, { subject: str(actor?.id) }) };
}

/* ═══ READING ONE MODEL ════════════════════════════════════════════════════ */

async function readPublication(ctx, { publicationId, actor = null, mayDownloadSource = false } = {}) {
  assertContext(ctx);
  const row = await publicationForCompany(ctx, publicationId, { lean: true });
  return {
    publication: publicationView(row, {
      subject: str(actor?.id), links: true, mayDownloadSource,
    }),
  };
}

/** The bytes. Token AND session, every time — see the header. */
async function openAsset(ctx, { publicationId, kind, token, actor = null, mayDownloadSource = false } = {}) {
  assertContext(ctx);
  if (!Object.values(ASSET_KIND).includes(str(kind))) throw fail("NOT_FOUND", "No such asset.");
  if (!verifyAssetToken(token, str(publicationId), str(kind))) {
    throw fail("NOT_FOUND", "That asset link has expired. Reopen the workspace.");
  }
  const row = await publicationForCompany(ctx, publicationId, { lean: true });
  /* ── THE TWO FILES THAT ARE THE GARMENT ITSELF ──────────────────────────
     The CLO project can reproduce the style; the DXF can cut it. Neither is
     folded into "can see the workspace", and both need the stronger grant —
     which is the existing one, deliberately reused rather than a second
     permission nobody can see in Access Control. */
  if ([ASSET_KIND.SOURCE, ASSET_KIND.PATTERN].includes(kind) && !mayDownloadSource) {
    throw fail("FORBIDDEN",
      kind === ASSET_KIND.PATTERN
        ? "Downloading the flat pattern needs an R&D role that allows it. The pattern is the garment's "
          + "geometry — whoever holds it can cut the style."
        : "Downloading the CLO source needs an R&D role that allows it.");
  }
  const asset = (row.assets || []).find((a) => a.kind === kind);
  if (!asset) throw fail("NOT_FOUND", "This publication has no such asset.");

  const { stream, meta } = await drive.streamCompanyFile(asset.driveFileId);
  return {
    stream,
    name: asset.name,
    /* The stored type, never the provider's guess: a GLB uploaded as
       `application/octet-stream` has to arrive as something the loader will
       accept, and nothing here should be sniffable into markup. */
    mimeType: kind === ASSET_KIND.WEB_MODEL
      ? "model/gltf-binary"
      /* A DXF is text, and text served with its own type is sniffable into
         markup on this origin with this session's cookie. `nosniff` is set on
         the response and the type is deliberately the inert one — nothing
         renders a DXF in a browser, so there is nothing to lose. */
      : (kind === ASSET_KIND.PATTERN
        ? "application/octet-stream"
        : (asset.mimeType || meta?.mimeType || "application/octet-stream")),
    bytes: asset.bytes || meta?.size || 0,
    /* Only an image is ever drawn in place; everything else downloads. */
    inline: kind === ASSET_KIND.PREVIEW,
  };
}

/* ═══ MARKERS ══════════════════════════════════════════════════════════════ */

const annotationView = (a) => ({
  id: String(a._id),
  markerRef: a.markerRef,
  seq: a.seq,
  publicationRef: a.publicationRef,
  modelNumber: a.modelNumber,
  anchor: {
    nodeRef: a.anchor?.nodeRef, nodeName: str(a.anchor?.nodeName), meshName: str(a.anchor?.meshName),
    primitiveIndex: a.anchor?.primitiveIndex ?? null, triangleIndex: a.anchor?.triangleIndex ?? null,
    local: a.anchor?.local, normal: a.anchor?.normal,
  },
  camera: a.camera || null,
  category: a.category,
  title: a.title,
  note: str(a.note),
  construction: a.construction || {},
  status: a.status,
  priority: str(a.priority),
  departmentRelevance: a.departmentRelevance || [],
  linkedTechnicalItem: a.linkedTechnicalItem || null,
  attachments: (a.attachments || []).map((x) => ({ name: x.name, mimeType: x.mimeType, bytes: x.bytes })),
  author: a.author || null,
  replies: (a.replies || []).map((r) => ({ body: r.body, author: r.author, at: r.at })),
  /* ── A NAME, NOT THE ACTOR RECORD ──────────────────────────────────────
     `by` is stored as `{ id, name, email }` and used to be returned whole.
     That put every author's EMAIL ADDRESS into a list whose only job is to
     say who did something — and a screen rendering it got an object where it
     expected a person, which is a crash rather than a wrong name. One field,
     which is the one a reader needs. */
  events: (a.events || []).map((e) => ({
    kind: e.kind, note: str(e.note), by: str(e.by?.name), at: e.at,
  })),
  createdAt: a.createdAt, updatedAt: a.updatedAt,
  revision: a.revision ?? 0,
});

/**
 * EVERY MARKER ON ONE PUBLICATION, AND ONLY THAT ONE.
 *
 * The publication id is in the query rather than filtered afterwards. A marker
 * placed on model 1 must never appear on model 2: the surface it names may
 * have moved, been renamed or been removed between exports, and a pin that
 * silently followed would be a measurement nobody took.
 */
async function listAnnotations(ctx, { publicationId } = {}) {
  assertContext(ctx);
  const row = await publicationForCompany(ctx, publicationId, { lean: true });
  const rows = await GarmentModelAnnotation
    .find({ companyId: ctx.companyId, publicationId: row._id })
    .sort({ seq: 1 }).lean();
  return { publicationRef: row.publicationRef, annotations: rows.map(annotationView) };
}

function readAnchor(publicationRow, anchor = {}) {
  const nodeRef = str(anchor.nodeRef);
  const node = (publicationRow.structure || []).find((n) => n.nodeRef === nodeRef);
  if (!node) {
    /* The whole stability argument, enforced: a marker may only name a node
       this publication actually published. */
    throw fail("MODEL_ANCHOR_UNKNOWN",
      "That marker names a part this model does not contain. Reopen the model and place it again.",
      { nodeRef });
  }
  const point = anchor.local || {};
  const normal = anchor.normal || {};
  const finite = (v) => Number.isFinite(Number(v));
  if (!["x", "y", "z"].every((k) => finite(point[k]))) {
    throw fail("MODEL_ANCHOR_INVALID", "That marker has no position on the garment.");
  }
  return {
    nodeRef,
    nodeName: node.name,
    meshName: node.meshName,
    primitiveIndex: num(anchor.primitiveIndex),
    triangleIndex: num(anchor.triangleIndex),
    local: { x: Number(point.x), y: Number(point.y), z: Number(point.z) },
    normal: ["x", "y", "z"].every((k) => finite(normal[k]))
      ? { x: Number(normal.x), y: Number(normal.y), z: Number(normal.z) }
      : { x: 0, y: 1, z: 0 },
  };
}

function readCamera(camera) {
  const ok = (v) => v && ["x", "y", "z"].every((k) => Number.isFinite(Number(v[k])));
  if (!ok(camera?.position) || !ok(camera?.target)) return null;
  const pick = (v) => ({ x: Number(v.x), y: Number(v.y), z: Number(v.z) });
  return { position: pick(camera.position), target: pick(camera.target) };
}

const PRIORITIES = Object.freeze(["blocker", "high", "normal", "low"]);

/** A department slug R&D says should see this. Never an assignment. */
const readRelevance = (v) => (Array.isArray(v) ? v : [])
  .map((x) => clean(x, 40).toLowerCase())
  .filter(Boolean)
  .slice(0, 6);

const readPriority = (v) => (PRIORITIES.includes(str(v)) ? str(v) : "");

const readConstruction = (c = {}) => ({
  seam: clean(c.seam, 160),
  stitchClass: clean(c.stitchClass, 40),
  spi: num(c.spi),
  seamAllowanceMm: num(c.seamAllowanceMm),
  measurementPoint: clean(c.measurementPoint, 160),
  toleranceMm: num(c.toleranceMm),
  componentRelationship: clean(c.componentRelationship, 240),
  trimPlacement: clean(c.trimPlacement, 240),
  qualityCritical: c.qualityCritical === true || c.qualityCritical === "true",
  approvedSampleDifference: clean(c.approvedSampleDifference, 1000),
});

/** An approved publication is a record, not a workspace. */
function assertAnnotatable(row) {
  if ([PUBLICATION_STATE.APPROVED, PUBLICATION_STATE.SUPERSEDED].includes(row.state)) {
    throw fail("MODEL_STATE_CONFLICT",
      "This model has been accepted. Publish a new model to record further construction on it.",
      { state: row.state });
  }
}

async function createAnnotation(ctx, { publicationId, body = {}, actor = null } = {}) {
  assertContext(ctx);
  const row = await publicationForCompany(ctx, publicationId, { lean: true });
  assertAnnotatable(row);

  const category = str(body.category);
  if (!Object.values(MARKER_CATEGORY).includes(category)) {
    throw fail("VALIDATION", "That marker does not name a kind of construction note.",
      { field: "category", accepted: Object.values(MARKER_CATEGORY) });
  }
  const title = clean(body.title, 200);
  if (!title) throw fail("VALIDATION", "A marker needs a title somebody will recognise.", { field: "title" });

  const anchor = readAnchor(row, body.anchor);
  const last = await GarmentModelAnnotation
    .findOne({ companyId: ctx.companyId, publicationId: row._id })
    .sort({ seq: -1 }).select("seq").lean();

  const who = actorOf(actor);
  const created = await GarmentModelAnnotation.create({
    companyId: ctx.companyId,
    styleId: row.styleId,
    publicationId: row._id,
    publicationRef: row.publicationRef,
    modelNumber: row.modelNumber,
    markerRef: mintRef("MK"),
    seq: (last?.seq || 0) + 1,
    anchor,
    camera: readCamera(body.camera),
    category,
    title,
    note: clean(body.note, 4000),
    construction: readConstruction(body.construction),
    priority: readPriority(body.priority),
    departmentRelevance: readRelevance(body.departmentRelevance),
    status: MARKER_STATUS.OPEN,
    linkedTechnicalItem: {
      kind: clean(body.linkedTechnicalItem?.kind, 40),
      ref: clean(body.linkedTechnicalItem?.ref, 80),
      label: clean(body.linkedTechnicalItem?.label, 200),
    },
    author: who,
    events: [{ kind: "created", note: title, by: who, at: new Date() }],
  });
  return { annotation: annotationView(created) };
}

async function annotationForCompany(ctx, annotationId) {
  if (!isId(annotationId)) throw fail("NOT_FOUND", "That marker was not found.");
  const row = await GarmentModelAnnotation
    .findOne({ _id: annotationId, companyId: ctx.companyId }).catch(() => null);
  if (!row) throw fail("NOT_FOUND", "That marker was not found.");
  return row;
}

async function updateAnnotation(ctx, { annotationId, body = {}, expectedRevision, actor = null } = {}) {
  assertContext(ctx);
  const row = await annotationForCompany(ctx, annotationId);
  assertFresh(row, expectedRevision);
  const parent = await publicationForCompany(ctx, row.publicationId, { lean: true });

  const who = actorOf(actor);
  const at = new Date();

  if (body.status !== undefined) {
    const status = str(body.status);
    if (!Object.values(MARKER_STATUS).includes(status)) {
      throw fail("VALIDATION", "That is not a marker status.", { field: "status" });
    }
    if (status === MARKER_STATUS.IN_APPROVED_PACK && parent.state !== PUBLICATION_STATE.APPROVED) {
      throw fail("MODEL_STATE_CONFLICT",
        "A marker joins the approved pack when the model it is on is accepted.", { state: parent.state });
    }
    if (status !== row.status) {
      row.events.push({ kind: `status:${status}`, note: clean(body.statusNote, 2000), by: who, at });
      row.status = status;
    }
  }

  /* The content of a marker is only editable while the model is still being
     worked on. After acceptance the record is what was accepted. */
  const CONTENT = ["title", "note", "category", "construction", "linkedTechnicalItem",
    "camera", "priority", "departmentRelevance"];
  if (CONTENT.some((k) => body[k] !== undefined)) {
    assertAnnotatable(parent);
    if (body.title !== undefined) row.title = clean(body.title, 200) || row.title;
    if (body.note !== undefined) row.note = clean(body.note, 4000);
    if (body.category !== undefined && Object.values(MARKER_CATEGORY).includes(str(body.category))) {
      row.category = str(body.category);
    }
    if (body.construction !== undefined) row.construction = readConstruction(body.construction);
    if (body.linkedTechnicalItem !== undefined) {
      row.linkedTechnicalItem = {
        kind: clean(body.linkedTechnicalItem?.kind, 40),
        ref: clean(body.linkedTechnicalItem?.ref, 80),
        label: clean(body.linkedTechnicalItem?.label, 200),
      };
    }
    if (body.camera !== undefined) row.camera = readCamera(body.camera);
    if (body.priority !== undefined) row.priority = readPriority(body.priority);
    if (body.departmentRelevance !== undefined) {
      row.departmentRelevance = readRelevance(body.departmentRelevance);
    }
    row.events.push({ kind: "edited", note: "", by: who, at });
  }

  row.revision += 1;
  await row.save();
  return { annotation: annotationView(row) };
}

async function replyToAnnotation(ctx, { annotationId, body = {}, actor = null } = {}) {
  assertContext(ctx);
  const row = await annotationForCompany(ctx, annotationId);
  const text = clean(body.body, 4000);
  if (!text) throw fail("VALIDATION", "A reply needs something in it.", { field: "body" });
  const who = actorOf(actor);
  const at = new Date();
  row.replies.push({ body: text, author: who, at });
  row.events.push({ kind: "replied", note: text.slice(0, 200), by: who, at });
  row.revision += 1;
  await row.save();
  return { annotation: annotationView(row) };
}

/* ═══ THE TIMELINE ═════════════════════════════════════════════════════════ */

/**
 * What happened to this model, in order.
 *
 * Publication events and marker events in ONE sequence, because that is how
 * the work actually went: a model was published, three markers were raised, a
 * merchandiser replied, two were resolved, it went for review. Each row
 * carries enough to restore what the viewer was looking at — the marker, and
 * through it the saved camera — so a reader can go to a moment rather than
 * read about one.
 */
async function timeline(ctx, { publicationId } = {}) {
  assertContext(ctx);
  const row = await publicationForCompany(ctx, publicationId, { lean: true });
  const annotations = await GarmentModelAnnotation
    .find({ companyId: ctx.companyId, publicationId: row._id })
    .sort({ seq: 1 }).lean();

  const events = [];
  const push = (e) => { if (e.at) events.push(e); };

  push({
    kind: "model:published", at: row.createdAt, by: row.createdBy,
    label: `3D model ${row.modelNumber} published`, note: str(row.title),
    annotationId: "", markerRef: "",
  });
  push({
    kind: "model:submitted", at: row.submittedAt, by: row.submittedBy,
    label: "Submitted for review", note: "", annotationId: "", markerRef: "",
  });
  if (row.decidedAt) {
    push({
      kind: row.state === PUBLICATION_STATE.APPROVED ? "model:approved" : "model:returned",
      at: row.decidedAt, by: row.decidedBy,
      label: row.state === PUBLICATION_STATE.APPROVED ? "Model accepted" : "Returned for correction",
      note: str(row.decisionNote), annotationId: "", markerRef: "",
    });
  }

  for (const a of annotations) {
    for (const e of a.events || []) {
      push({
        kind: `marker:${e.kind}`, at: e.at, by: e.by,
        label: `${a.markerRef} · ${a.title}`, note: str(e.note),
        annotationId: String(a._id), markerRef: a.markerRef,
        category: a.category, seq: a.seq,
      });
    }
  }

  events.sort((a, b) => new Date(a.at) - new Date(b.at));
  return { publicationRef: row.publicationRef, events };
}

/**
 * WHO THIS PERSON IS HERE, ANSWERED WITHOUT NEEDING R&D ACCESS.
 *
 * ── WHY THIS IS NOT BEHIND THE CAPABILITY ───────────────────────────────────
 * It is the question the access-denied screen has to answer, and a screen that
 * could only explain a refusal to somebody who had not been refused would be
 * useless. So this needs the SESSION and the COMPANY and nothing else, and it
 * returns only facts about the caller themselves: which company they are
 * acting for and what they may do. It names no style, no model and no
 * capability key — a refusal must never become a way to ask what exists.
 */
async function workspaceContext(ctx, { role = null } = {}) {
  assertContext(ctx);
  const { ROLE_CAPABILITIES, CAPABILITY } = require("./access.service");
  const held = role ? ROLE_CAPABILITIES[role] : null;
  return {
    company: await companyLabel(ctx.companyId),
    /* Plain answers, not capability names. A screen decides what to render
       from these; nothing about the internal vocabulary leaves the server. */
    access: {
      role: str(role),
      canOpen: Boolean(held?.has(CAPABILITY.MODEL_READ)),
      canAnnotate: Boolean(held?.has(CAPABILITY.MODEL_ANNOTATE)),
      canPublish: Boolean(held?.has(CAPABILITY.MODEL_PUBLISH)),
      canApprove: Boolean(held?.has(CAPABILITY.MODEL_APPROVE)),
    },
  };
}

/* ═══ MEASUREMENTS ═════════════════════════════════════════════════════════
 *
 * ── WHAT THIS CAN HONESTLY CLAIM ────────────────────────────────────────────
 * A distance here is the straight line between two picked points. A path is
 * the sum of the straight segments between the points somebody placed along a
 * seam — a POLYLINE, not a geodesic. It under-reads a curve exactly as a tape
 * pulled taut between pins does, it gets closer the more points are placed,
 * and nothing in this file or on the screen calls it a surface length.
 *
 * Writing a real geodesic would mean walking the triangle mesh between two
 * points, and the current reference export is one merged 7,424-triangle shell
 * with no seam topology to walk along. An approximation presented as a
 * surface measurement is worse than a polyline presented as a polyline.
 *
 * ── WHY THE SERVER DOES THE ARITHMETIC ──────────────────────────────────────
 * The browser picks the points; this computes the number from them. Not
 * because the browser would lie, but because a stored value that nothing can
 * recompute is a claim rather than a measurement — and because two viewers
 * disagreeing about a length is a bug nobody could find if each shipped its
 * own formula.
 */

const MEASUREMENT_POINTS = Object.freeze({
  [MEASUREMENT_KIND.DISTANCE]: { min: 2, max: 2, says: "A straight distance is measured between two points." },
  [MEASUREMENT_KIND.SURFACE]: { min: 2, max: 2, says: "A surface distance is measured between two points on the garment." },
  [MEASUREMENT_KIND.ANGLE]: { min: 3, max: 3, says: "An angle is measured from three points, and is the angle at the middle one." },
  [MEASUREMENT_KIND.PATH]: { min: 2, max: 60, says: "A guided path needs at least two points, and at most 60." },
});

const isSurfaceKind = (kind) => SURFACE_KINDS.includes(kind);

/** Units, and what one of them is worth in the next one up. Used only to turn
 *  a calibration the person entered into the factor stored beside it. */
const UNIT_IN_MM = Object.freeze({ mm: 1, cm: 10, m: 1000, in: 25.4 });

const isVec = (v) => v && ["x", "y", "z"].every((k) => Number.isFinite(Number(v[k])));
const vec = (v) => ({ x: Number(v.x), y: Number(v.y), z: Number(v.z) });
const span = (a, b) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);

/**
 * One picked point, validated against what this publication actually contains.
 *
 * The same rule markers live by: a point may only name a node the file
 * published. A measurement across a part that is not in the model is not a
 * measurement of this garment.
 */
function readPoint(publicationRow, point = {}, index) {
  const nodeRef = str(point.nodeRef);
  const node = (publicationRow.structure || []).find((n) => n.nodeRef === nodeRef);
  if (!node) {
    throw fail("MODEL_ANCHOR_UNKNOWN",
      "One of those points is on a part this model does not contain. Reopen the model and place it again.",
      { nodeRef, point: index + 1 });
  }
  if (!isVec(point.local) || !isVec(point.world)) {
    throw fail("MODEL_ANCHOR_INVALID",
      "One of those points has no position on the garment.", { point: index + 1 });
  }
  return {
    nodeRef,
    nodeName: node.name,
    meshName: node.meshName,
    triangleIndex: num(point.triangleIndex),
    local: vec(point.local),
    world: vec(point.world),
  };
}

/**
 * The number, computed here from the points.
 *
 * Distance and path are lengths in MODEL UNITS. An angle is in DEGREES and is
 * the one result that needs no scale at all — a ratio of two lengths cancels
 * whatever they were measured in, so an angle off an uncalibrated export is
 * exactly as good as one off a calibrated one.
 */
function computeMeasurement(kind, points) {
  if (kind === MEASUREMENT_KIND.ANGLE) {
    const [a, b, c] = points.map((p) => p.world);
    const u = { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
    const v = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };
    const lu = Math.hypot(u.x, u.y, u.z);
    const lv = Math.hypot(v.x, v.y, v.z);
    if (!lu || !lv) {
      throw fail("MODEL_MEASUREMENT_INVALID",
        "Two of those points are in the same place, so there is no angle between them.");
    }
    const cos = Math.min(1, Math.max(-1, (u.x * v.x + u.y * v.y + u.z * v.z) / (lu * lv)));
    return (Math.acos(cos) * 180) / Math.PI;
  }
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += span(points[i - 1].world, points[i].world);
  if (!(total > 0)) {
    throw fail("MODEL_MEASUREMENT_INVALID",
      "Those points are all in the same place, so there is nothing to measure.");
  }
  return total;
}

/**
 * WHAT IS KNOWN ABOUT TURNING MODEL UNITS INTO A REAL LENGTH, RIGHT NOW.
 *
 * Three answers and no fourth. The order is deliberate: somebody's own
 * calibration of THIS publication beats what the exporter claimed, and what
 * the exporter claimed beats nothing — but "nothing" is an answer that gets
 * returned rather than quietly replaced with a guess of 1 cm per unit.
 *
 * The result is FROZEN onto each measurement as it is taken. Calibrating
 * afterwards must not reach back and relabel a number somebody already wrote
 * down as verified; it changes what the NEXT measurement will say.
 */
function scaleBasisOf(publicationRow) {
  const cal = publicationRow.scaleCalibration;
  if (cal && Number.isFinite(cal.factor) && cal.factor > 0) {
    return {
      state: SCALE_STATE.VERIFIED,
      source: "calibration",
      factor: cal.factor,
      unit: cal.unit,
      calibrationRef: str(cal.calibrationRef),
      calibratedBy: str(cal.by?.name),
      calibratedAt: cal.at || null,
    };
  }
  const unit = str(publicationRow.manifest?.unit);
  if (unit && UNIT_IN_MM[unit]) {
    /* The exporter said the file is drawn in this unit, so one model unit is
       one of them. Nobody has checked that, and the label says so. */
    return { state: SCALE_STATE.DECLARED, source: "export-manifest", factor: 1, unit };
  }
  return { state: SCALE_STATE.UNVERIFIED, source: "none", factor: 1, unit: "model units" };
}

/**
 * What a reader is shown, with the number and its trustworthiness inseparable.
 *
 * `displayValue` exists only where there is something to display it in. Where
 * the scale is unverified it is null and `rawValue` is all there is — the
 * screen shows the raw figure and says plainly that it is a visual reference.
 */
function measurementView(row, parent = {}) {
  const isAngle = row.kind === MEASUREMENT_KIND.ANGLE;
  const scale = row.scale || {};
  const scaled = !isAngle && scale.state !== SCALE_STATE.UNVERIFIED;
  return {
    id: String(row._id),
    measurementRef: row.measurementRef,
    seq: row.seq,
    kind: row.kind,
    publicationRef: str(parent.publicationRef),
    modelNumber: parent.modelNumber ?? null,
    points: (row.points || []).map((p) => ({
      nodeRef: p.nodeRef,
      nodeName: p.nodeName,
      local: { x: p.local.x, y: p.local.y, z: p.local.z },
      world: { x: p.world.x, y: p.world.y, z: p.world.z },
    })),
    rawValue: row.rawValue,
    /* The route over the cloth, for a reader to draw without re-deriving it.
       Empty on a straight distance, where the points ARE the line. */
    surfacePath: (row.surfacePath || []).map((p) => ({
      nodeRef: p.nodeRef,
      local: { x: p.local.x, y: p.local.y, z: p.local.z },
    })),
    followsSurface: SURFACE_KINDS.includes(row.kind),
    /* Degrees for an angle; otherwise the file's own units, named as such. */
    rawUnit: isAngle ? "°" : "model units",
    displayValue: isAngle ? row.rawValue : (scaled ? row.rawValue * scale.factor : null),
    displayUnit: isAngle ? "°" : (scaled ? scale.unit : ""),
    scale: {
      state: scale.state,
      source: scale.source,
      factor: scale.factor,
      unit: scale.unit,
      calibratedBy: str(scale.calibratedBy),
      calibratedAt: scale.calibratedAt || null,
    },
    /* An angle carries no units, so no scale warning belongs on it. Stated as
       a fact about this measurement rather than left for each screen to
       re-derive and get wrong once. */
    scaleIndependent: isAngle,
    name: row.name || row.label || "",
    /* Kept so a screen written against the older shape still reads. */
    label: row.name || row.label || "",
    category: row.category || "general",
    note: row.note || "",
    linkedTechnicalItem: row.linkedTechnicalItem || null,
    intendedSize: str(row.intendedSize),
    toleranceMm: row.toleranceMm ?? null,
    status: row.status,
    reviewedBy: str(row.reviewedBy?.name),
    reviewedAt: row.reviewedAt || null,
    duplicatedFromRef: str(row.duplicatedFromRef),
    camera: row.camera || null,
    author: row.author ? { name: str(row.author.name), at: row.createdAt } : null,
    events: (row.events || []).map((e) => ({
      kind: e.kind, note: e.note || "", by: str(e.by?.name), at: e.at,
    })),
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function listMeasurements(ctx, { publicationId } = {}) {
  assertContext(ctx);
  const row = await publicationForCompany(ctx, publicationId, { lean: true });
  const rows = [...(row.measurements || [])].sort((a, b) => a.seq - b.seq);
  return {
    publicationRef: row.publicationRef,
    /* The CURRENT basis, which is what a new measurement would be taken with
       — not the basis any stored one carries. */
    scale: scaleBasisOf(row),
    calibration: calibrationView(row),
    measurements: rows.map((m) => measurementView(m, row)),
  };
}

/**
 * WHAT THE NUMBER IS, FOR EACH KIND.
 *
 * A straight distance and an angle are computed from the placed points. A
 * surface or guided measurement is computed from its ROUTE — the polyline
 * the viewer walked across the triangles — because that route IS what was
 * measured, and summing the two endpoints instead would quietly hand back the
 * chord under a surface measurement's name.
 */
function measurementValue(kind, points, route) {
  if (!isSurfaceKind(kind)) return computeMeasurement(kind, points);
  if (route.length < 2) {
    throw fail("MODEL_MEASUREMENT_INVALID",
      "That measurement has no route across the garment, so there is nothing to measure along. "
      + "Place it again from the workspace.",
      { field: "surfacePath" });
  }
  let total = 0;
  for (let i = 1; i < route.length; i += 1) total += span(route[i - 1].world, route[i].world);
  if (!(total > 0)) {
    throw fail("MODEL_MEASUREMENT_INVALID",
      "Those points are all in the same place, so there is nothing to measure.");
  }
  return total;
}

/** A name somebody chose, and the one default the save panel must not keep. */
function readName(value, seq) {
  const name = clean(value, 200);
  if (!name) {
    throw fail("MODEL_MEASUREMENT_INVALID",
      "Give the measurement a name somebody will recognise.", { field: "name" });
  }
  /* The suggested default, refused on purpose. A rail of "Measurement 1..9"
     is a rail nobody can read, and the suggestion exists to be replaced. */
  if (name.replace(/\s+/g, " ").trim().toLowerCase() === `measurement ${seq}`) {
    throw fail("MODEL_MEASUREMENT_INVALID",
      "Replace the suggested name with what this measures — a neckline, a placket, a pocket placement.",
      { field: "name" });
  }
  return name;
}

const readCategory = (value) => {
  const c = str(value);
  return Object.values(MEASUREMENT_CATEGORY).includes(c) ? c : MEASUREMENT_CATEGORY.GENERAL;
};

const readLink = (value) => ({
  kind: clean(value?.kind, 40),
  ref: clean(value?.ref, 80),
  label: clean(value?.label, 200),
});

const readTolerance = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

async function createMeasurement(ctx, { publicationId, body = {}, actor = null } = {}) {
  assertContext(ctx);
  const row = await publicationForCompany(ctx, publicationId, { lean: true });
  /* An accepted model is a record, not a workspace — the same rule markers
     live by, and for the same reason. */
  assertAnnotatable(row);

  const kind = str(body.kind);
  const rule = MEASUREMENT_POINTS[kind];
  if (!rule) {
    throw fail("VALIDATION", "That is not a kind of measurement.",
      { field: "kind", accepted: Object.values(MEASUREMENT_KIND) });
  }
  const raw = Array.isArray(body.points) ? body.points : [];
  if (raw.length < rule.min || raw.length > rule.max) {
    throw fail("MODEL_MEASUREMENT_INVALID", rule.says, { field: "points", given: raw.length });
  }
  const points = raw.map((p, i) => readPoint(row, p, i));

  /* The route, validated against this publication's own node list exactly as
     the placed points are — a route naming a part the model does not contain
     is not a route over this garment. */
  const route = (Array.isArray(body.surfacePath) ? body.surfacePath : [])
    .map((p, i) => readPoint(row, p, i));
  const rawValue = measurementValue(kind, points, route);

  /* Written against the document rather than through a lean copy, so the
     sequence number is taken from what is actually stored. */
  const parent = await publicationForCompany(ctx, publicationId);
  const seq = (parent.measurements || []).reduce((n, m) => Math.max(n, m.seq), 0) + 1;
  const name = readName(body.name ?? body.label, seq);

  const who = actorOf(actor);
  parent.measurements.push({
    measurementRef: mintRef("MS"),
    seq,
    kind,
    points,
    surfacePath: isSurfaceKind(kind) ? route : [],
    rawValue,
    scale: scaleBasisOf(parent),
    name,
    category: readCategory(body.category),
    note: clean(body.note, 4000),
    linkedTechnicalItem: readLink(body.linkedTechnicalItem),
    intendedSize: clean(body.intendedSize, 40),
    toleranceMm: readTolerance(body.toleranceMm),
    camera: readCamera(body.camera),
    status: MEASUREMENT_STATUS.DRAFT,
    author: who,
    events: [{ kind: "created", note: name, by: who, at: new Date() }],
  });
  await parent.save();
  const created = parent.measurements[parent.measurements.length - 1];
  return { measurement: measurementView(created, parent) };
}

/**
 * The same measurement again, as a fresh draft.
 *
 * Used for the row of points of measure that differ only by where they are —
 * three pocket placements, four button positions. It copies what was measured
 * and deliberately does NOT copy the review: a duplicate is nobody's accepted
 * fact until somebody looks at it.
 */
async function duplicateMeasurement(ctx, { measurementId, name, actor = null } = {}) {
  assertContext(ctx);
  const { row, parent } = await measurementForCompany(ctx, measurementId);
  assertAnnotatable(parent);

  const seq = (parent.measurements || []).reduce((n, m) => Math.max(n, m.seq), 0) + 1;
  const who = actorOf(actor);
  const copyName = clean(name, 200) || `${row.name} (copy)`;

  parent.measurements.push({
    measurementRef: mintRef("MS"),
    seq,
    kind: row.kind,
    points: row.points.map((p) => ({ ...(p.toObject ? p.toObject() : p) })),
    surfacePath: (row.surfacePath || []).map((p) => ({ ...(p.toObject ? p.toObject() : p) })),
    rawValue: row.rawValue,
    /* The scale basis in force NOW, not the original's. A copy taken after a
       calibration is a calibrated measurement; carrying the old basis over
       would label it with a confidence nobody has since re-earned. */
    scale: scaleBasisOf(parent),
    name: copyName,
    category: row.category,
    note: row.note,
    linkedTechnicalItem: row.linkedTechnicalItem,
    intendedSize: row.intendedSize,
    toleranceMm: row.toleranceMm,
    camera: row.camera,
    status: MEASUREMENT_STATUS.DRAFT,
    duplicatedFromRef: row.measurementRef,
    author: who,
    events: [{ kind: "duplicated", note: `from ${row.measurementRef}`, by: who, at: new Date() }],
  });
  await parent.save();
  const created = parent.measurements[parent.measurements.length - 1];
  return { measurement: measurementView(created, parent) };
}

/**
 * The measurement, and the publication that holds it.
 *
 * Scoped by company in the query itself, so another company's measurement is
 * NOT FOUND rather than forbidden — the same non-disclosing answer every other
 * read on this mount gives.
 */
async function measurementForCompany(ctx, measurementId) {
  if (!isId(measurementId)) throw fail("NOT_FOUND", "That measurement was not found.");
  const parent = await GarmentModelPublication
    .findOne({ companyId: ctx.companyId, "measurements._id": measurementId })
    .catch(() => null);
  const row = parent?.measurements?.id(measurementId);
  if (!row) throw fail("NOT_FOUND", "That measurement was not found.");
  return { row, parent };
}

/**
 * Label, note and state. The POINTS are immutable by schema and that is the
 * whole design: moving a point changes what was measured, and the honest
 * record of that is a new measurement beside the old one, not a quiet edit.
 */
/**
 * WHEN A MEASUREMENT MAY STILL BE CHANGED, AND WHEN IT IS EVIDENCE.
 *
 * A draft is somebody's working figure: the name, the note and even the
 * points may still be corrected, because dragging a point onto the seam you
 * meant is an ordinary part of taking a measurement. The moment a second
 * person reviews or accepts it, what was measured is frozen — otherwise the
 * thing they signed off is not the thing that is stored.
 */
function assertDraft(row, what) {
  if (row.status !== MEASUREMENT_STATUS.DRAFT) {
    throw fail("MODEL_STATE_CONFLICT",
      `This measurement has been ${row.status}, so ${what} would change something somebody already signed off. `
      + "Reopen it as a draft, or duplicate it and change the copy.",
      { status: row.status });
  }
}

/* draft ⇄ reviewed ⇄ accepted, and anything may be withdrawn. Returning to a
   draft is allowed and is recorded, because a measurement found to be wrong
   after review has to be fixable by somebody. */
const MEASUREMENT_TRANSITIONS = Object.freeze({
  [MEASUREMENT_STATUS.DRAFT]: [MEASUREMENT_STATUS.REVIEWED, MEASUREMENT_STATUS.WITHDRAWN],
  [MEASUREMENT_STATUS.REVIEWED]: [
    MEASUREMENT_STATUS.ACCEPTED, MEASUREMENT_STATUS.DRAFT, MEASUREMENT_STATUS.WITHDRAWN,
  ],
  [MEASUREMENT_STATUS.ACCEPTED]: [MEASUREMENT_STATUS.DRAFT, MEASUREMENT_STATUS.WITHDRAWN],
  [MEASUREMENT_STATUS.WITHDRAWN]: [MEASUREMENT_STATUS.DRAFT],
});

async function updateMeasurement(ctx, { measurementId, body = {}, expectedRevision, actor = null } = {}) {
  assertContext(ctx);
  const { row, parent } = await measurementForCompany(ctx, measurementId);
  assertFresh(row, expectedRevision);
  const who = actorOf(actor);
  const at = new Date();

  if (body.status !== undefined) {
    const status = str(body.status);
    if (!Object.values(MEASUREMENT_STATUS).includes(status)) {
      throw fail("VALIDATION", "That is not a measurement state.", { field: "status" });
    }
    if (status !== row.status) {
      const allowed = MEASUREMENT_TRANSITIONS[row.status] || [];
      if (!allowed.includes(status)) {
        throw fail("INVALID_TRANSITION",
          `A ${row.status} measurement cannot go straight to ${status}.`,
          { from: row.status, to: status, allowed });
      }
      /* Reviewing and accepting are judgements about somebody's work, so they
         are somebody else's to make — the rule the model lifecycle runs on. */
      if ([MEASUREMENT_STATUS.REVIEWED, MEASUREMENT_STATUS.ACCEPTED].includes(status)
        && sameActor(row.author, actor)) {
        throw fail("MODEL_SELF_APPROVAL",
          "A measurement is reviewed by somebody other than the person who took it.");
      }
      row.events.push({ kind: `status:${status}`, note: clean(body.statusNote, 2000), by: who, at });
      row.status = status;
      if ([MEASUREMENT_STATUS.REVIEWED, MEASUREMENT_STATUS.ACCEPTED].includes(status)) {
        row.reviewedBy = who;
        row.reviewedAt = at;
      }
    }
  }

  /* ── REPOSITIONING, WHILE IT IS STILL A DRAFT ─────────────────────────
     The points and the route move together or not at all: a route that no
     longer starts where the measurement says it does is worse than either. */
  if (body.points !== undefined) {
    assertDraft(row, "moving its points");
    const rule = MEASUREMENT_POINTS[row.kind];
    const raw = Array.isArray(body.points) ? body.points : [];
    if (raw.length < rule.min || raw.length > rule.max) {
      throw fail("MODEL_MEASUREMENT_INVALID", rule.says, { field: "points", given: raw.length });
    }
    const points = raw.map((p, i) => readPoint(parent, p, i));
    const route = (Array.isArray(body.surfacePath) ? body.surfacePath : [])
      .map((p, i) => readPoint(parent, p, i));
    row.rawValue = measurementValue(row.kind, points, route);
    row.points = points;
    row.surfacePath = isSurfaceKind(row.kind) ? route : [];
    row.events.push({ kind: "repositioned", note: "", by: who, at });
  }

  const renamed = body.name !== undefined || body.label !== undefined;
  if (renamed) {
    assertDraft(row, "renaming it");
    const name = clean(body.name ?? body.label, 200);
    if (!name) {
      throw fail("MODEL_MEASUREMENT_INVALID",
        "Give the measurement a name somebody will recognise.", { field: "name" });
    }
    row.name = name;
  }
  if (body.note !== undefined) row.note = clean(body.note, 4000);
  if (body.category !== undefined) row.category = readCategory(body.category);
  if (body.linkedTechnicalItem !== undefined) row.linkedTechnicalItem = readLink(body.linkedTechnicalItem);
  if (body.intendedSize !== undefined) row.intendedSize = clean(body.intendedSize, 40);
  if (body.toleranceMm !== undefined) row.toleranceMm = readTolerance(body.toleranceMm);

  if (renamed || body.note !== undefined || body.category !== undefined
    || body.linkedTechnicalItem !== undefined || body.intendedSize !== undefined
    || body.toleranceMm !== undefined) {
    row.events.push({ kind: "edited", note: row.name, by: who, at });
  }

  row.revision += 1;
  await parent.save();
  return { measurement: measurementView(row, parent) };
}

/* ═══ CALIBRATION ══════════════════════════════════════════════════════════
 *
 * Somebody measures something whose real size they already know — a placket
 * off the approved spec, a printed scale bar in the export — and says what it
 * really is. That is the only way this workspace can claim a millimetre.
 *
 * The factor belongs to ONE publication. A successor export may be drawn at a
 * different scale, and a factor that followed it across would silently relabel
 * a wrong number as verified; so a new publication starts uncalibrated, every
 * time, and there is no code path that copies one.
 */

function calibrationView(publicationRow) {
  const cal = publicationRow.scaleCalibration;
  if (!cal) return null;
  return {
    calibrationRef: str(cal.calibrationRef),
    rawValue: cal.rawValue,
    knownValue: cal.knownValue,
    unit: cal.unit,
    factor: cal.factor,
    note: str(cal.note),
    by: str(cal.by?.name),
    at: cal.at || null,
  };
}

async function calibrateScale(ctx, { publicationId, body = {}, expectedRevision, actor = null } = {}) {
  assertContext(ctx);
  const row = await publicationForCompany(ctx, publicationId);
  assertFresh(row, expectedRevision);
  /* Calibration changes what every number on this model reads as, so it is a
     change to the model's record — refused on an accepted one, like any other. */
  assertAnnotatable(row);

  const unit = str(body.unit);
  if (!UNIT_IN_MM[unit]) {
    throw fail("MODEL_MEASUREMENT_INVALID", "Say which unit that distance is in.",
      { field: "unit", accepted: Object.keys(UNIT_IN_MM) });
  }
  const knownValue = Number(body.knownValue);
  if (!Number.isFinite(knownValue) || knownValue <= 0) {
    throw fail("MODEL_MEASUREMENT_INVALID",
      "Enter the real distance between those two points.", { field: "knownValue" });
  }
  const raw = Array.isArray(body.points) ? body.points : [];
  if (raw.length !== 2) {
    throw fail("MODEL_MEASUREMENT_INVALID",
      "Calibration is set from two points whose real distance you know.", { field: "points" });
  }
  const points = raw.map((p, i) => readPoint(row, p, i));
  const rawValue = computeMeasurement(MEASUREMENT_KIND.DISTANCE, points);

  const who = actorOf(actor);
  row.scaleCalibration = {
    calibrationRef: mintRef("CB"),
    rawValue,
    knownValue,
    unit,
    factor: knownValue / rawValue,
    points,
    note: clean(body.note, 1000),
    by: who,
    at: new Date(),
  };
  row.revision += 1;
  await row.save();
  return { calibration: calibrationView(row), scale: scaleBasisOf(row), revision: row.revision };
}

async function clearCalibration(ctx, { publicationId, expectedRevision } = {}) {
  assertContext(ctx);
  const row = await publicationForCompany(ctx, publicationId);
  assertFresh(row, expectedRevision);
  assertAnnotatable(row);
  row.scaleCalibration = null;
  row.revision += 1;
  await row.save();
  return { calibration: null, scale: scaleBasisOf(row), revision: row.revision };
}

/* ═══ THE HANDOVER TO INDUSTRIAL ENGINEERING ═══════════════════════════════
 *
 * ── WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ───────────────────────────
 * A READ-ONLY projection of what R&D has accepted about a garment's
 * measurements, shaped for the one consumer that needs it. There is no write
 * anywhere in it and there is no route that would let IE change an R&D
 * measurement: the arrow points one way, IE consumes what R&D signed off, and
 * IE's own engineering observations live in IE's own records.
 *
 * ── THE THREE RULES THAT DECIDE WHAT APPEARS ────────────────────────────────
 *
 *   · DRAFTS STAY IN R&D. A number somebody is still taking is not a fact
 *     anybody downstream should plan against, and a draft that reached IE
 *     would be planned against — that is what a handover is for.
 *   · WITHDRAWN IS NOT CURRENT. It stays in R&D's own record as evidence of
 *     what was once believed, and it is absent here, because a handover is a
 *     statement about what is true now.
 *   · A NEW MODEL VERSION INHERITS NOTHING. Measurements belong to the
 *     publication they were taken on. The projection says which publication
 *     each came from and reports a superseded one as previous-version rather
 *     than carrying its numbers forward onto a model nobody measured.
 *
 * It also carries the POINTS and the surface ROUTE, so IE can draw the
 * measurement on the same model read-only without being given any way to
 * move it.
 */

function handoverMeasurementView(m, parent) {
  const isAngle = m.kind === MEASUREMENT_KIND.ANGLE;
  const scale = m.scale || {};
  const scaled = !isAngle && scale.state !== SCALE_STATE.UNVERIFIED;
  return {
    measurementRef: m.measurementRef,
    name: m.name || m.label || "",
    kind: m.kind,
    followsSurface: SURFACE_KINDS.includes(m.kind),
    category: m.category || "general",

    rawValue: m.rawValue,
    rawUnit: isAngle ? "°" : "model units",
    value: isAngle ? m.rawValue : (scaled ? m.rawValue * scale.factor : null),
    unit: isAngle ? "°" : (scaled ? scale.unit : ""),
    /* The confidence travels WITH the number. A handover that passed on a
       figure without saying it came off an unverified export would be handing
       IE a millimetre nobody measured. */
    scale: {
      state: scale.state,
      basis: scale.source,
      calibratedBy: str(scale.calibratedBy),
      calibratedAt: scale.calibratedAt || null,
    },
    scaleIndependent: isAngle,

    intendedSize: str(m.intendedSize),
    toleranceMm: m.toleranceMm ?? null,
    linkedTechnicalItem: m.linkedTechnicalItem || null,
    note: str(m.note),

    /* Enough to draw it, and nothing that could change it. */
    points: (m.points || []).map((p) => ({
      nodeRef: p.nodeRef, nodeName: str(p.nodeName),
      local: { x: p.local.x, y: p.local.y, z: p.local.z },
    })),
    surfacePath: (m.surfacePath || []).map((p) => ({
      nodeRef: p.nodeRef, local: { x: p.local.x, y: p.local.y, z: p.local.z },
    })),

    status: m.status,
    reviewedBy: str(m.reviewedBy?.name),
    reviewedAt: m.reviewedAt || null,

    modelPublicationRef: parent.publicationRef,
    modelNumber: parent.modelNumber,
  };
}

/**
 * Every measurement R&D stands behind, for one style.
 *
 * @param {object} ctx     company context
 * @param {string} styleId the style, scoped to the company exactly as every
 *                         other read on this mount is
 */
async function measurementHandover(ctx, { styleId } = {}) {
  assertContext(ctx);
  const style = await styleForCompany(ctx.companyId, styleId);

  const rows = await GarmentModelPublication
    .find({ companyId: ctx.companyId, styleId: style._id })
    .sort({ modelNumber: -1 })
    .lean();

  const current = rows.find((r) => r.state === PUBLICATION_STATE.APPROVED) || null;

  const collect = (parent) => (parent?.measurements || [])
    .filter((m) => MEASUREMENT_HANDOVER_STATES.includes(m.status))
    .sort((a, b) => a.seq - b.seq)
    .map((m) => handoverMeasurementView(m, parent));

  /* Measurements on EARLIER approved models, reported as what they are. A new
     export may be cut differently, so the old numbers are history until
     somebody deliberately re-takes or maps them — never silently inherited. */
  const previous = rows
    .filter((r) => r !== current && r.state === PUBLICATION_STATE.SUPERSEDED)
    .flatMap((parent) => collect(parent));

  return {
    style: {
      id: String(style._id),
      sampleStyleId: str(style.sampleStyleId),
      styleCode: str(style.styleCode),
      productName: str(style.productName),
    },
    approvedModel: current ? {
      publicationRef: current.publicationRef,
      modelNumber: current.modelNumber,
      modelName: `3D model ${current.modelNumber}`,
      approvedAt: current.decidedAt || null,
      approvedBy: str(current.decidedBy?.name),
      technicalRevisionRef: str(current.technicalRevisionRef),
    } : null,
    /* Empty with no approved model, rather than reaching into a draft. */
    measurements: current ? collect(current) : [],
    previousVersionMeasurements: previous,
    /* Said in the payload so a consumer cannot mistake what it has. */
    readOnly: true,
    authority: "The approved measurement specification remains the manufacturing authority. "
      + "These are R&D's reviewed 3D measurements, as supporting evidence.",
  };
}

/* ═══ THE TECHNICAL-BUNDLE HANDOVER TO INDUSTRIAL ENGINEERING ══════════════
 *
 * ── WHAT IE GETS, AND WHAT IT CANNOT DO WITH IT ─────────────────────────────
 * A READ-ONLY projection of the approved bundle: which revision, which model,
 * which pattern, the pieces and their verified dimensions, the components they
 * were confirmed against, the warnings nobody resolved, and the R&D annotations
 * and measurements already accepted. There is no write anywhere in it, and
 * there is no route on this mount that would let IE change an R&D piece, a
 * mapping or a file.
 *
 * ── THE FOUR RULES THAT DECIDE WHAT APPEARS ─────────────────────────────────
 *
 *   · ONLY AN APPROVED BUNDLE. A draft is R&D's working surface. The brief is
 *     explicit and it is also the only safe answer: a pattern somebody is still
 *     drafting would be planned against the moment it reached IE.
 *   · ONLY CONFIRMED MAPPINGS. A proposed match is this server's inference, and
 *     handing one over as a component name would let a line plan be built around
 *     a 70% name similarity. Unconfirmed pieces appear WITH their piece data and
 *     WITHOUT a component, which is the truthful shape.
 *   · UNRESOLVED WARNINGS TRAVEL. A bundle approved with four needs-review
 *     findings is a bundle IE should see the findings of. Hiding them at the
 *     boundary is how a missing seam allowance becomes somebody else's surprise.
 *   · AND NOTHING IS DERIVED THAT IE OWNS. No operations, no machines, no SAM,
 *     no sewing sequence, no line plan, and no marker nesting. Pattern geometry
 *     makes all five LOOK derivable and none of them is: an operation bulletin
 *     depends on the machinery a factory has and the method it uses, neither of
 *     which is in a DXF. They are IE's to author, from this as evidence.
 */

/**
 * The approved technical bundle for one style, for IE to read.
 *
 * @param {object} ctx     company context
 * @param {string} styleId the style, scoped to the company as every read is
 */
async function technicalBundleHandover(ctx, { styleId } = {}) {
  assertContext(ctx);
  const style = await styleForCompany(ctx.companyId, styleId);

  const rows = await GarmentModelPublication
    .find({ companyId: ctx.companyId, styleId: style._id })
    .sort({ modelNumber: -1 })
    .lean();

  const current = rows.find((r) => r.state === PUBLICATION_STATE.APPROVED) || null;

  /* ── A DRAFT BUNDLE IS NOT REPORTED AS AN EMPTY APPROVED ONE ───────────
     The difference matters to the reader: "nothing is approved yet" is a
     schedule fact IE acts on, and an empty piece list with no explanation looks
     like a parse failure. */
  if (!current) {
    const pending = rows.filter((r) => r.state !== PUBLICATION_STATE.RETURNED).length;
    return {
      style: {
        id: String(style._id),
        sampleStyleId: str(style.sampleStyleId),
        styleCode: str(style.styleCode),
        productName: str(style.productName),
      },
      bundle: null,
      pieces: [],
      readOnly: true,
      available: false,
      reason: pending
        ? `R&D has ${pending} technical ${pending === 1 ? "bundle" : "bundles"} for this style and none `
          + "has been accepted yet. An unapproved bundle stays inside R&D."
        : "R&D has not published a technical bundle for this style.",
    };
  }

  const set = current.patternSet || null;
  const measurements = set ? bundle.patternMeasurements(set) : null;
  const state = mappingState(current);
  const checks = bundle.derivedChecks(current, state, current.bundleWarnings || []);

  const confirmed = new Map((current.pieceMappings || [])
    .filter((m) => m.state === MAPPING_STATE.CONFIRMED)
    .map((m) => [m.pieceRef, m]));

  const byRef = new Map((measurements?.pieces || []).map((p) => [p.pieceRef, p]));

  /* R&D's accepted annotations on this bundle's model, as references. IE reads
     the construction R&D established; it does not get a way to edit one. */
  const annotations = await GarmentModelAnnotation
    .find({
      companyId: ctx.companyId,
      publicationId: current._id,
      status: { $in: [MARKER_STATUS.RESOLVED, MARKER_STATUS.IN_APPROVED_PACK] },
    })
    .sort({ seq: 1 })
    .lean()
    .catch(() => []);

  return {
    style: {
      id: String(style._id),
      sampleStyleId: str(style.sampleStyleId),
      styleCode: str(style.styleCode),
      productName: str(style.productName),
    },

    bundle: {
      /* ── THE THREE IDENTITIES, EACH WITH ITS OWN HASH ────────────────────
         So "is this the pattern that was approved" is answerable downstream
         without trusting a filename, exactly as it is inside R&D. */
      bundleRevision: current.modelNumber,
      bundleName: `Technical bundle ${current.modelNumber}`,
      publicationRef: current.publicationRef,
      technicalRevisionRef: str(current.technicalRevisionRef),
      approvedAt: current.decidedAt || null,
      approvedBy: str(current.decidedBy?.name),
      publishedBy: str(current.createdBy?.name),

      model: {
        modelNumber: current.modelNumber,
        modelName: `3D model ${current.modelNumber}`,
        generator: str(current.manifest?.generator),
        cloVersion: str(current.manifest?.cloVersion),
        unit: str(current.manifest?.unit),
        modelSize: str(current.modelSize),
        declaredRevision: str(current.declaredModelRevision),
        sha256: str((current.assets || []).find((a) => a.kind === ASSET_KIND.WEB_MODEL)?.sha256),
        meshes: current.stats?.meshes ?? 0,
        triangles: current.stats?.triangles ?? 0,
      },

      pattern: set ? {
        patternSetRef: set.patternSetRef,
        classification: set.classification,
        isApparelPattern: set.classification === PATTERN_CLASSIFICATION.APPAREL,
        declaredRevision: str(current.declaredPatternRevision),
        sha256: str(set.sha256),
        styleName: str(set.manifest?.styleName),
        product: str(set.manifest?.product),
        sampleSize: str(set.manifest?.sampleSize),
        unit: str(set.unit),
        unitSource: str(set.unitSource),
        /* Whether a length off this pattern may be treated as a real length.
           Travels WITH the numbers rather than being left for IE to infer. */
        scaleVerified: Boolean(set.unit && set.unitInMm),
        sizes: set.grading?.sizes || [],
        graded: Boolean(set.grading?.graded),
        pieces: set.stats?.pieces ?? 0,
        conventions: set.conventions || [],
      } : null,

      colourway: str(current.colourway),
      sizeRange: str(current.sizeRange),

      /* ── WHETHER THE SOURCE EXISTS, NEVER A LINK TO IT ─────────────────
         IE is told the CLO project is on record and is given no way to fetch
         it. The source download keeps the stronger R&D permission it already
         had, and this projection is not a second door to it. */
      cloSourceOnRecord: Boolean((current.assets || []).find((a) => a.kind === ASSET_KIND.SOURCE)),
      cloSourceAvailableHere: false,
    },

    /* ── THE PIECE LIST ─────────────────────────────────────────────────── */
    pieces: (set?.pieces || []).map((piece) => {
      const mapped = confirmed.get(piece.pieceRef) || null;
      const measured = byRef.get(piece.pieceRef) || null;
      return {
        pieceRef: piece.pieceRef,
        name: str(piece.name),
        /* So IE can see that a piece has no chosen name rather than reading an
           exporter's counter as one. */
        generatedName: Boolean(piece.generatedName),
        publishedId: str(piece.publishedId),
        size: str(piece.size),
        quantity: piece.quantity ?? null,
        material: str(piece.material),
        componentClass: str(piece.componentClass),

        /* Verified dimensions, with the millimetre figures present only where
           the pattern stated a unit. */
        width: piece.width ?? null,
        height: piece.height ?? null,
        area: piece.area ?? null,
        perimeter: piece.perimeter ?? null,
        widthMm: measured?.widthMm ?? null,
        heightMm: measured?.heightMm ?? null,
        perimeterMm: measured?.perimeterMm ?? null,
        areaMm2: measured?.areaMm2 ?? null,

        grainDirection: str(piece.grainline?.direction),
        grainOffVerticalDegrees: piece.grainline?.offVerticalDegrees ?? null,
        seamAllowance: piece.seamAllowance || null,
        cutOnFold: piece.cutOnFold ?? null,
        mirrored: piece.mirrored ?? null,
        notches: (piece.notches || []).length,
        drillPoints: (piece.drillPoints || []).length,
        notchSpacing: measured?.notchSpacing || [],

        /* ── THE MAPPED COMPONENT, OR NOTHING ───────────────────────────
           A confirmed mapping yields a name. An unconfirmed one yields
           `mappedComponent: null` and a stated reason, never a guess. */
        mappedComponent: mapped ? {
          nodeRef: mapped.nodeRef,
          nodeName: str(mapped.nodeName),
          method: mapped.method,
          confirmedBy: str(mapped.confirmedBy?.name),
          confirmedAt: mapped.confirmedAt || null,
          repeatedComponent: Boolean(mapped.repeatedComponent),
        } : null,
        mappingState: mapped ? MAPPING_STATE.CONFIRMED : "unmapped",
      };
    }),

    /* ── MEASUREMENT TOTALS, AND THE ONE THING THEY ARE NOT ─────────────── */
    patternMeasurements: measurements ? {
      unit: measurements.unit,
      scaleVerified: measurements.scaleVerified,
      totalNetArea: measurements.totalNetArea,
      totalNetAreaMm2: measurements.totalNetAreaMm2,
      totalNetAreaByQuantity: measurements.totalNetAreaByQuantity,
      quantityPublishedForEveryPiece: measurements.quantityPublishedForEveryPiece,
      byMaterial: measurements.byMaterial,
      byComponentClass: measurements.byComponentClass,
      grading: measurements.grading,
      netAreaIsNotConsumption: measurements.netAreaIsNotConsumption,
    } : null,

    /* ── WHAT THE 3D MODEL CAN AND CANNOT IDENTIFY ─────────────────────── */
    componentAvailability: state?.availability || null,

    /* R&D's own accepted facts, as references into R&D's records. */
    annotations: annotations.map((a) => ({
      markerRef: a.markerRef,
      seq: a.seq,
      category: a.category,
      title: str(a.title),
      note: str(a.note),
      construction: a.construction || {},
      status: a.status,
      priority: str(a.priority),
      anchorNodeRef: str(a.anchor?.nodeRef),
      anchorNodeName: str(a.anchor?.nodeName),
      author: str(a.author?.name),
    })),
    measurements: (current.measurements || [])
      .filter((m) => MEASUREMENT_HANDOVER_STATES.includes(m.status))
      .sort((a, b) => a.seq - b.seq)
      .map((m) => handoverMeasurementView(m, current)),

    /* ── EVERY WARNING NOBODY RESOLVED ──────────────────────────────────
       Carried whole. A bundle can be approved with needs-review findings — that
       is a decision an R&D approver is entitled to make — and IE is the next
       person who has to know what was decided past. */
    unresolvedWarnings: {
      blocking: checks.blocking,
      needsReview: checks.needsReview,
      informational: checks.informational,
      counts: checks.counts,
    },
    modelWarnings: current.warnings || [],
    patternWarnings: set?.warnings || [],

    /* ── SAID IN THE PAYLOAD, NOT ONLY IN A COMMENT ─────────────────────
       A consumer must not be able to mistake this for something it may write
       to, nor for a licence to derive IE's own records from pattern geometry. */
    readOnly: true,
    available: true,
    authority: "This is R&D's approved technical bundle, read-only. R&D owns the files, the parsed "
      + "geometry and the confirmed mappings; Industrial Engineering keeps its own engineering records "
      + "separately and cannot change anything here.",
    notDerivedHere: "Operations, machine allocation, SAM, sewing sequence, line plans and marker nesting "
      + "are not derived from this pattern. Geometry alone cannot state them — they depend on the "
      + "machinery and method a factory uses — and they remain Industrial Engineering's to author.",
  };
}

module.exports = {
  workspaceContext,
  LIMITS, TOKEN_SCOPE, SOURCE_EXTENSIONS, PREVIEW_MIME, VIEWER_EXTENSIONS, PRIORITIES,
  listPublications, createDraft, readPublication, openAsset,
  submitForReview, decide,
  listAnnotations, createAnnotation, updateAnnotation, replyToAnnotation, timeline,
  publicationView, annotationView, verifyAssetToken, assetLink,

  MEASUREMENT_KIND, MEASUREMENT_STATUS, SCALE_STATE,
  listMeasurements, createMeasurement, updateMeasurement, duplicateMeasurement,
  measurementView, calibrateScale, clearCalibration, scaleBasisOf,
  measurementHandover, handoverMeasurementView,

  /* ── THE FLAT PATTERN, THE MAPPING AND THE BUNDLE ──────────────────── */
  PATTERN_CLASSIFICATION, MAPPING_METHOD, MAPPING_STATE,
  classifyUploads, attachPatternSet, attachSource, readPatternSet,
  setPieceMapping, rematchMappings,
  patternSetView, mappingView, mappingState, readPatternFile,
  technicalBundleHandover,
};
