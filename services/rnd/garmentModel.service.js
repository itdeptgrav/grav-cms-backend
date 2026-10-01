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
} = require("../../models/CMS_Models/RnD/GarmentModel");
const drive = require("../companyDrive.service");
const { inspectGlb, GlbError } = require("../../utils/glbInspect");
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
    },
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

function assertSourceFile(file) {
  if (!file) return;
  const name = str(file.originalname).toLowerCase();
  if (!SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext))) {
    throw fail("MODEL_SOURCE_UNSUPPORTED",
      `The CLO source must be a ${SOURCE_EXTENSIONS.join(" or ")} file. `
      + "It is kept as evidence and is never rendered in the browser.",
      { accepted: SOURCE_EXTENSIONS });
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
  let read;
  try {
    read = inspectGlb(file.buffer);
  } catch (err) {
    if (err instanceof GlbError) throw fail("MODEL_UNREADABLE", err.message, { reason: err.code });
    throw err;
  }
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

  const read = readWebModel(webFile);
  assertSourceFile(sourceFile);
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
  await upload(sourceFile, ASSET_KIND.SOURCE, "source");
  await upload(previewFile, ASSET_KIND.PREVIEW, "preview");

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
      sourceFileName: str(sourceFile?.originalname),
      note: clean(body.note, 2000),
      /* …and read from the file where the file already knows. */
      generator: read.manifest.generator,
      gltfVersion: read.manifest.gltfVersion,
      extensionsUsed: read.manifest.extensionsUsed,
      extensionsRequired: read.manifest.extensionsRequired,
    },
    structure: read.structure,
    stats: { ...read.stats, namedPieces: read.namedPieces },
    hasAvatar: read.hasAvatar,
    avatarNodeRefs: read.avatarNodeRefs,
    technicalRevisionRef: str(technicalPack?.technicalRevisionRef),
    /* Stored, not just returned. The person who publishes a model is rarely
       the person who later wonders why the fabric looks grey. */
    warnings: warningsFor(read, { sourceFile }),
    createdBy: actorOf(actor),
  });

  return {
    publication: publicationView(row, { subject: str(actor?.id) }),
    /* Not refusals, and not hidden either. A publication nobody can anchor a
       named construction marker to is still worth looking at; what it cannot
       do is carry a full technical record, and the publisher is told now
       rather than finding out from a marker that names nothing. */
    warnings: warningsFor(read, { sourceFile }),
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

  const same = (who) => Boolean(
    (str(actor?.email) && str(who?.email).toLowerCase() === str(actor?.email).toLowerCase())
    || (str(actor?.id) && str(who?.id) === str(actor?.id)),
  );
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
  if (kind === ASSET_KIND.SOURCE && !mayDownloadSource) {
    throw fail("FORBIDDEN", "Downloading the CLO source needs an R&D role that allows it.");
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
      : (asset.mimeType || meta?.mimeType || "application/octet-stream"),
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
  events: (a.events || []).map((e) => ({ kind: e.kind, note: e.note, by: e.by, at: e.at })),
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

module.exports = {
  workspaceContext,
  LIMITS, TOKEN_SCOPE, SOURCE_EXTENSIONS, PREVIEW_MIME, VIEWER_EXTENSIONS, PRIORITIES,
  listPublications, createDraft, readPublication, openAsset,
  submitForReview, decide,
  listAnnotations, createAnnotation, updateAnnotation, replyToAnnotation, timeline,
  publicationView, annotationView, verifyAssetToken, assetLink,
};
