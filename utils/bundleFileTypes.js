// utils/bundleFileTypes.js
//
// WHAT AN UPLOADED FILE IS, DECIDED FROM ITS BYTES.
//
// ── WHY A FILENAME IS NOT AN ANSWER ─────────────────────────────────────────
// Three facts arrive with every upload and all three are the uploader's claim:
// the extension, the browser's MIME guess, and which upload card it was dropped
// on. None of them is evidence. A `.dxf` can be a renamed JPEG, a `.glb` can be
// a text file, and the browser will cheerfully label a ZIP as
// `application/octet-stream` either way.
//
// That matters more here than in most upload paths, because this bundle is
// EVIDENCE. An approved technical bundle is what IE plans against and what a
// cutting room eventually works from, and a file admitted on the strength of
// its name is a file nobody has actually read. So every file is identified from
// its own leading bytes and its own structure, and a file whose contents do not
// match the card it arrived on is refused with a sentence that says which is
// which.
//
// ── THE THREE ANSWERS, AND THE FOURTH ───────────────────────────────────────
// A classification is one of: a 3D garment model, a flat pattern set, an
// editable CLO source — or a refusal. There is deliberately no "probably"
// branch. A file this module cannot positively identify is not stored, because
// a bundle holding one unidentified file is a bundle nobody can describe.
//
// ── WHERE THIS MODULE STOPS ─────────────────────────────────────────────────
// It classifies and it validates structure. It does not store anything, does
// not reach a database, and does not know what a publication is — so the upload
// screen can ask it what a file is BEFORE anything is committed, which is what
// makes "the classification is visible before publishing" possible rather than
// a label the server applies after the fact.
"use strict";

const { inspectGlb, GlbError } = require("./glbInspect");
const { inspectDxf, DxfError } = require("./dxfInspect");

/* ═══ THE KINDS ════════════════════════════════════════════════════════════
 * What a classified file IS, in the language the screen uses. These are the
 * upload cards, and there are exactly three.
 */
const BUNDLE_KIND = Object.freeze({
  WEB_MODEL: "web_model",   /* .glb / .gltf — the browser draws this */
  PATTERN: "pattern",       /* .dxf — the pieces, graded, notched, grained */
  SOURCE: "source",         /* .zprj / .zpac — evidence, never rendered */
});

/**
 * The classification a reader is shown, per kind and per quality.
 *
 * `GENERIC_DXF` is its own label and not a worse `APPAREL_PATTERN`: calling a
 * collection of CAD lines a pattern set is the single most expensive thing this
 * module could get wrong, because every downstream consumer — the piece list,
 * the mapping, the IE projection — would then be reading a drawing as though
 * it carried cut instructions it does not have.
 */
const CLASSIFICATION = Object.freeze({
  GLB_MODEL: {
    code: "GLB_MODEL", kind: BUNDLE_KIND.WEB_MODEL,
    label: "3D garment model",
    detail: "Binary glTF. Interactive assembled garment, surface annotations and measurements.",
  },
  GLTF_MODEL: {
    code: "GLTF_MODEL", kind: BUNDLE_KIND.WEB_MODEL,
    label: "3D garment model",
    detail: "glTF JSON. Interactive assembled garment, surface annotations and measurements.",
  },
  APPAREL_PATTERN: {
    code: "APPAREL_PATTERN", kind: BUNDLE_KIND.PATTERN,
    label: "Apparel flat pattern set",
    detail: "AAMA/ASTM pattern export. Cut pieces, notches, grainlines and grading.",
  },
  GENERIC_DXF: {
    code: "GENERIC_DXF", kind: BUNDLE_KIND.PATTERN,
    label: "Generic 2D DXF — limited pattern data",
    detail: "Readable CAD geometry with none of the apparel conventions. Piece names, sizes, "
      + "quantities, grain and notches are absent, and this is not a pattern set.",
  },
  CLO_SOURCE: {
    code: "CLO_SOURCE", kind: BUNDLE_KIND.SOURCE,
    label: "Editable CLO source",
    detail: "Kept privately as source evidence. Never rendered in the browser.",
  },
});

/* ═══ SIGNATURES ═══════════════════════════════════════════════════════════
 * Leading bytes that identify a format positively. Used two ways: to say what
 * a file IS, and — more importantly — to say what it is NOT when it arrives
 * claiming to be something else.
 */
const SIGNATURES = Object.freeze([
  { name: "GLB", bytes: [0x67, 0x6c, 0x54, 0x46], label: "a binary glTF model" },
  { name: "ZIP", bytes: [0x50, 0x4b, 0x03, 0x04], label: "a ZIP archive" },
  { name: "ZIP_EMPTY", bytes: [0x50, 0x4b, 0x05, 0x06], label: "an empty ZIP archive" },
  { name: "ZIP_SPANNED", bytes: [0x50, 0x4b, 0x07, 0x08], label: "a spanned ZIP archive" },
  { name: "PNG", bytes: [0x89, 0x50, 0x4e, 0x47], label: "a PNG image" },
  { name: "JPEG", bytes: [0xff, 0xd8, 0xff], label: "a JPEG image" },
  { name: "GIF", bytes: [0x47, 0x49, 0x46, 0x38], label: "a GIF image" },
  { name: "WEBP_RIFF", bytes: [0x52, 0x49, 0x46, 0x46], label: "a RIFF container (WebP, WAV or AVI)" },
  { name: "PDF", bytes: [0x25, 0x50, 0x44, 0x46], label: "a PDF document" },
  { name: "GZIP", bytes: [0x1f, 0x8b], label: "a gzip archive" },
  { name: "RAR", bytes: [0x52, 0x61, 0x72, 0x21], label: "a RAR archive" },
  { name: "SEVEN_ZIP", bytes: [0x37, 0x7a, 0xbc, 0xaf], label: "a 7-Zip archive" },
  { name: "BZIP2", bytes: [0x42, 0x5a, 0x68], label: "a bzip2 archive" },
  { name: "DWG", bytes: [0x41, 0x43, 0x31, 0x30], label: "a DWG drawing" },
  { name: "ELF", bytes: [0x7f, 0x45, 0x4c, 0x46], label: "an executable" },
  { name: "MACHO", bytes: [0xcf, 0xfa, 0xed, 0xfe], label: "an executable" },
  { name: "MSDOS", bytes: [0x4d, 0x5a], label: "a Windows executable" },
]);

/** The first signature this buffer matches, or null. */
function signatureOf(buffer) {
  for (const signature of SIGNATURES) {
    if (buffer.length < signature.bytes.length) continue;
    let matched = true;
    for (let i = 0; i < signature.bytes.length; i++) {
      if (buffer[i] !== signature.bytes[i]) { matched = false; break; }
    }
    if (matched) return signature;
  }
  return null;
}

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());

const extensionOf = (name) => {
  const clean = str(name).toLowerCase();
  const at = clean.lastIndexOf(".");
  return at >= 0 ? clean.slice(at) : "";
};

class ClassifyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ClassifyError";
    this.code = code;
    this.details = details;
  }
}

const refuse = (code, message, details) => { throw new ClassifyError(code, message, details); };

/* ═══ GLTF ═════════════════════════════════════════════════════════════════ */

/**
 * A `.gltf` is JSON, and the JSON is only half the model.
 *
 * ── WHY THIS IS STRICTER THAN GLB ───────────────────────────────────────────
 * A GLB is one self-contained file. A `.gltf` is a scene description that
 * POINTS AT its geometry and textures — `buffers[].uri` and `images[].uri` — and
 * those can be relative paths to files sitting next to it on somebody's disk.
 * Accept one with external references through a single-file upload and the
 * result is a publication that parses perfectly, stores cleanly, and renders as
 * nothing at all, because the bytes it needs were never uploaded.
 *
 * The brief's own condition is "only when every required asset is safely
 * packaged and available", and for a single-file upload that means every URI
 * must be an embedded data URI. A relative path is refused, and the refusal
 * names GLB as the fix — which is what a CLO export produces anyway.
 *
 * An absolute or protocol URI is refused more firmly: a model that fetches a
 * texture from a third-party host at render time is a privacy leak on an
 * unreleased garment, and `file://` is a request for the server's disk.
 */
function readGltfJson(buffer) {
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch {
    refuse("MODEL_UNREADABLE",
      "That file is named .gltf but its contents are not readable JSON, so there is no scene in it.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    refuse("MODEL_UNREADABLE", "That .gltf does not contain a glTF document.");
  }
  const version = str(parsed.asset?.version);
  if (!version) {
    refuse("MODEL_UNREADABLE",
      "That .gltf states no asset version, so it is not a glTF document this workspace can read.");
  }
  if (!version.startsWith("2")) {
    refuse("MODEL_UNREADABLE",
      `That .gltf declares glTF version ${version}; only version 2 can be displayed. Re-export as glTF 2.0, `
      + "or better as GLB.");
  }

  const meshes = Array.isArray(parsed.meshes) ? parsed.meshes : [];
  if (!meshes.length) {
    refuse("MODEL_UNREADABLE",
      "That .gltf contains no meshes, so there is no garment in it to draw.");
  }
  if (!Array.isArray(parsed.scenes) || !parsed.scenes.length
      || !Array.isArray(parsed.nodes) || !parsed.nodes.length) {
    refuse("MODEL_UNREADABLE",
      "That .gltf has no scene or node structure, so nothing in it can be positioned or anchored to.");
  }

  const external = [];
  for (const group of ["buffers", "images"]) {
    for (const entry of (Array.isArray(parsed[group]) ? parsed[group] : [])) {
      const uri = str(entry?.uri);
      if (!uri) continue;                        /* a GLB-style embedded chunk */
      if (uri.startsWith("data:")) continue;     /* packaged, and acceptable */
      external.push(uri.slice(0, 120));
    }
  }
  if (external.length) {
    refuse("MODEL_ASSETS_MISSING",
      `That .gltf needs ${external.length} file${external.length === 1 ? "" : "s"} that are not in it `
      + `(${external.slice(0, 3).join(", ")}${external.length > 3 ? ", …" : ""}), so it would load as an `
      + "empty viewport. Export as GLB, which packages the geometry and textures in one file.",
      { missing: external.slice(0, 10) });
  }

  return parsed;
}

/**
 * The same shape `inspectGlb` returns, for a packaged `.gltf`.
 *
 * Built by re-serialising the document into a GLB container rather than by
 * duplicating the structure walk. One reader, one set of node names, one
 * definition of "anchorable" — two would eventually disagree, and the one they
 * would disagree about is whether a marker's anchor is valid.
 */
function inspectGltfJson(buffer) {
  readGltfJson(buffer);
  const json = buffer.toString("utf8");
  const jsonBytes = Buffer.from(json, "utf8");
  const padding = (4 - (jsonBytes.length % 4)) % 4;
  const chunk = Buffer.concat([jsonBytes, Buffer.alloc(padding, 0x20)]);

  const container = Buffer.alloc(12 + 8 + chunk.length);
  container.writeUInt32LE(0x46546c67, 0);               /* 'glTF' */
  container.writeUInt32LE(2, 4);
  container.writeUInt32LE(container.length, 8);
  container.writeUInt32LE(chunk.length, 12);
  container.writeUInt32LE(0x4e4f534a, 16);              /* 'JSON' */
  chunk.copy(container, 20);

  const read = inspectGlb(container);
  /* The bytes a reader downloads are the .gltf's, not the container's. */
  read.stats.bytes = buffer.length;
  return read;
}

/* ═══ CLO SOURCE ═══════════════════════════════════════════════════════════ */

/**
 * A CLO project file, validated as far as its format honestly allows.
 *
 * ── WHAT IS CHECKED, AND WHAT IS NOT CLAIMED ────────────────────────────────
 * `.zpac` is a ZIP package and its signature is checked as one. `.zprj` is
 * CLO's own container, and its layout is not a published specification — no
 * open parser for it exists, which is exactly why the brief says to store it
 * privately rather than render it.
 *
 * So the check is the one that can actually be made rather than one that sounds
 * thorough: a source file must NOT be a format this server can positively
 * identify as something else, and must not be text. That catches every case
 * that matters — a GLB, a DXF, an image, a PDF or an archive of the wrong type
 * renamed to `.zprj` is refused by name — while not pretending to verify an
 * internal structure nobody has documented.
 *
 * The provenance of that decision travels with the file in `signatureVerified`,
 * so a reader can see that a stored `.zprj` was identified by exclusion rather
 * than by a confirmed magic number. Claiming otherwise would be the kind of
 * quiet overstatement this record exists to prevent.
 */
function readSource(buffer, extension) {
  const signature = signatureOf(buffer);

  if (signature && ["ZIP", "ZIP_EMPTY", "ZIP_SPANNED"].includes(signature.name)) {
    return { container: "zip", signatureVerified: true };
  }

  if (signature) {
    refuse("MODEL_SOURCE_UNSUPPORTED",
      `This file is named ${extension || "a CLO source"}, but its contents are ${signature.label}. `
      + "Attach the CLO project the garment was built in.",
      { detected: signature.name });
  }

  /* ── TEXT IS NOT A CLO PROJECT ───────────────────────────────────────────
     A project file is binary. A buffer whose first kilobyte is entirely
     printable is a DXF, an OBJ, a JSON or somebody's notes, and admitting one
     as source evidence would put a file nobody can open into an approved
     bundle. */
  const probe = buffer.subarray(0, Math.min(1024, buffer.length));
  let printable = 0;
  for (const byte of probe) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e)) printable++;
  }
  if (probe.length && printable === probe.length) {
    refuse("MODEL_SOURCE_UNSUPPORTED",
      `This file is named ${extension || "a CLO source"}, but its contents are plain text rather than a `
      + "CLO project. Attach the .zprj the garment was built in.",
      { detected: "TEXT" });
  }

  return { container: "clo-proprietary", signatureVerified: false };
}

/* ═══ THE CLASSIFICATION ═══════════════════════════════════════════════════ */

/**
 * WHAT IS THIS FILE?
 *
 * @param  {Buffer} buffer       the whole uploaded file
 * @param  {string} fileName     what it was called, used only to disambiguate
 *                               GLB-vs-GLTF and to word a refusal
 * @param  {string} [declared]   the upload card it arrived on, where the screen
 *                               knows. A mismatch with the contents is refused.
 * @returns {{classification, kind, read, source, warnings}}
 * @throws  {ClassifyError}
 */
function classifyBundleFile(buffer, fileName, declared = "") {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    refuse("VALIDATION", "That file is empty.");
  }
  const extension = extensionOf(fileName);
  const signature = signatureOf(buffer);

  /* ── 1. A GLB ANNOUNCES ITSELF ──────────────────────────────────────────
     Magic first, extension never. A GLB named `.dxf` is still a GLB, and the
     honest response is to say so and route it to the model card rather than to
     refuse a perfectly good model over its name. */
  if (signature?.name === "GLB") {
    const read = inspectGlbSafely(buffer);
    return result(CLASSIFICATION.GLB_MODEL, { read }, declared, extension, fileName);
  }

  /* ── 2. A DXF OR A GLTF, BOTH OF WHICH ARE TEXT ─────────────────────────
     Distinguished by structure, not by extension: a DXF begins with a numeric
     group code, a glTF with a JSON object. Both are checked, in the order that
     makes a wrong extension harmless. */
  const looksJson = firstNonSpace(buffer) === 0x7b;              /* '{' */
  if (looksJson) {
    const read = inspectGltfJson(buffer);
    return result(CLASSIFICATION.GLTF_MODEL, { read }, declared, extension, fileName);
  }

  if (looksLikeDxf(buffer)) {
    let read;
    try {
      read = inspectDxf(buffer);
    } catch (err) {
      if (err instanceof DxfError) {
        refuse("PATTERN_UNREADABLE", err.message, { reason: err.code });
      }
      throw err;
    }
    const classification = read.apparel ? CLASSIFICATION.APPAREL_PATTERN : CLASSIFICATION.GENERIC_DXF;
    return result(classification, { pattern: read }, declared, extension, fileName);
  }

  /* ── 3. A SOURCE, WHICH IS WHAT IS LEFT ─────────────────────────────────
     Only when the card or the extension says so. An unidentified binary is not
     quietly filed as a CLO project just because nothing else matched — that
     would make "source" the bucket every unrecognised upload fell into. */
  const saysSource = declared === BUNDLE_KIND.SOURCE || [".zprj", ".zpac"].includes(extension);
  if (saysSource) {
    const source = readSource(buffer, extension);
    return result(CLASSIFICATION.CLO_SOURCE, { source }, declared, extension, fileName);
  }

  /* ── 4a. A FILE THAT CLAIMED TO BE THE MODEL AND IS NOT ─────────────────
     Worded against the claim, and naming the fix. A GLB is what CLO's web
     export produces, so "export the web model from CLO as GLB" is an
     instruction the person can act on — where "unrecognised file" leaves them
     to work out which of three cards was wrong. */
  if (declared === BUNDLE_KIND.WEB_MODEL || [".glb", ".gltf"].includes(extension)) {
    refuse("MODEL_UNREADABLE",
      `This file is named ${extension || ".glb"}, but its contents are not a readable glTF model`
      + `${signature ? ` — they are ${signature.label}` : ""}. Export the web model from CLO as GLB — `
      + "a .zprj or a .gltf+bin pair cannot be displayed in the browser.",
      { detected: signature?.name || "UNKNOWN", extension });
  }

  /* ── 4b. A FILE THAT CLAIMED TO BE A PATTERN AND IS NOT ─────────────────
     Worded against the claim rather than against the bytes, because the claim
     is what the person made and is the thing they need to revisit. A `.dxf`
     that reaches here held neither group codes nor any other format this
     server knows, so the specific sentence is the true one. */
  if (declared === BUNDLE_KIND.PATTERN || extension === ".dxf") {
    refuse("PATTERN_UNREADABLE",
      `This file is named ${extension || ".dxf"}, but its contents are not a readable DXF pattern file`
      + `${signature ? ` — they are ${signature.label}` : ""}. Export the pattern from CAD as `
      + "AAMA/ASTM DXF.",
      { detected: signature?.name || "UNKNOWN", extension });
  }

  /* ── 4c. AND OTHERWISE IT IS REFUSED, BY NAME ───────────────────────────
     Naming what the file actually is turns "upload failed" into something the
     person can act on without guessing. */
  refuse("BUNDLE_FILE_UNRECOGNISED",
    signature
      ? `That file is ${signature.label}, which is not part of an R&D technical bundle. A bundle carries `
        + "a GLB or glTF garment model, an AAMA/ASTM DXF pattern set, and a CLO .zprj source."
      : "That file is not a GLB or glTF model, a DXF pattern or a CLO source, and its contents match no "
        + "format this workspace reads.",
    { detected: signature?.name || "UNKNOWN", extension });
}

/** `inspectGlb`'s refusals, re-worded as this module's. */
function inspectGlbSafely(buffer) {
  try {
    return inspectGlb(buffer);
  } catch (err) {
    if (err instanceof GlbError) refuse("MODEL_UNREADABLE", err.message, { reason: err.code });
    throw err;
  }
}

const firstNonSpace = (buffer) => {
  for (let i = 0; i < Math.min(buffer.length, 256); i++) {
    const byte = buffer[i];
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0xef
        && byte !== 0xbb && byte !== 0xbf) {
      return byte;
    }
  }
  return 0;
};

/**
 * Does this look like a DXF before the full parse?
 *
 * A cheap structural probe rather than a trust decision: the parser refuses
 * properly and with a better sentence, and this only decides whether to call
 * it. A DXF's first pair is a numeric group code — almost always `0` followed
 * by `SECTION`, but a file beginning with a comment pair (`999`) is legal too.
 */
function looksLikeDxf(buffer) {
  const head = buffer.subarray(0, Math.min(2048, buffer.length)).toString("latin1");
  const lines = head.split(/\r\n|\r|\n/);
  if (!/^\s*-?\d+\s*$/.test(lines[0] || "")) return false;
  /* And somewhere near the top it says it has sections, which a list of
     numbers that happens to start with a digit will not. */
  return /\bSECTION\b/.test(head) || /\$ACADVER/.test(head) || /\bENTITIES\b/.test(head);
}

/**
 * Assemble the answer, and refuse a file that contradicts the card it came on.
 *
 * ── THE REFUSAL THE BRIEF ASKS FOR, WORDED AS IT ASKS ───────────────────────
 * "This file is named .dxf, but its contents are not a readable DXF pattern
 * file." The shape of that sentence matters: it names the claim, names what was
 * actually found, and implies the fix. A bare "invalid file type" leaves the
 * person to guess which of the three cards was wrong.
 */
function result(classification, payload, declared, extension, fileName) {
  if (declared && declared !== classification.kind) {
    refuse("BUNDLE_FILE_MISMATCH",
      `This file is named ${extension || "without a known extension"} and was uploaded as `
      + `the ${cardLabel(declared)}, but its contents are ${articleFor(classification.label)}. `
      + `Put it on the ${cardLabel(classification.kind)} card, or upload the right file.`,
      {
        declared, detected: classification.code,
        detectedKind: classification.kind, detectedLabel: classification.label,
      });
  }

  return {
    classification: classification.code,
    kind: classification.kind,
    label: classification.label,
    detail: classification.detail,
    fileName: str(fileName),
    extension,
    bytes: payload.read?.stats?.bytes ?? payload.pattern?.stats?.bytes ?? null,
    /* Exactly one of these three is present, and which one is the kind. */
    read: payload.read || null,
    pattern: payload.pattern || null,
    source: payload.source || null,
    /* The parse's own warnings, carried up so the upload screen shows them
       beside the classification rather than after the publish. */
    warnings: payload.pattern?.warnings || [],
  };
}

/* No article of its own: every caller supplies the one its sentence needs. */
const cardLabel = (kind) => ({
  [BUNDLE_KIND.WEB_MODEL]: "3D garment model",
  [BUNDLE_KIND.PATTERN]: "flat pattern set",
  [BUNDLE_KIND.SOURCE]: "CLO source",
}[kind] || "unknown kind");

/**
 * "a 3D garment model", "an apparel flat pattern set".
 *
 * Only the first letter is lowered, and only when the first word is not an
 * acronym or number-led: blanket lowercasing turns "3D" into "3d" and
 * "AAMA/ASTM" into noise, in the one sentence a person reads to find out what
 * they actually uploaded.
 */
const articleFor = (label) => {
  const first = label.split(/\s/)[0] || "";
  const keep = /^[0-9]/.test(first) || first === first.toUpperCase();
  const body = keep ? label : label[0].toLowerCase() + label.slice(1);
  return `${/^[aeiou]/i.test(body) ? "an" : "a"} ${body}`;
};

/**
 * ROUTE A SET OF DROPPED FILES TO THEIR CARDS.
 *
 * ── WHY THIS IS SEPARATE FROM CLASSIFYING ONE FILE ──────────────────────────
 * Dropping four files at once raises a question one file never does: what
 * happens when two of them are the same kind. Silently keeping the last is how
 * somebody publishes the wrong pattern, so a collision is reported as one and
 * the screen asks. Nothing here decides; it reports what each file is and where
 * the conflicts are, and the person confirms before anything is published.
 *
 * Each file is classified with NO declared kind, because the whole point of a
 * multi-file drop is that the person did not say.
 */
function routeDroppedFiles(files = []) {
  const routed = [];
  const rejected = [];

  for (const file of files) {
    const name = str(file?.originalname || file?.name);
    try {
      const read = classifyBundleFile(file.buffer, name);
      routed.push({ ...read, bytes: file.buffer.length, confident: true });
    } catch (err) {
      rejected.push({
        fileName: name,
        bytes: file?.buffer?.length ?? 0,
        code: err.code || "BUNDLE_FILE_UNRECOGNISED",
        message: err.message,
        details: err.details || {},
      });
    }
  }

  const byKind = {};
  for (const entry of routed) {
    byKind[entry.kind] = byKind[entry.kind] || [];
    byKind[entry.kind].push(entry);
  }
  const conflicts = Object.entries(byKind)
    .filter(([, entries]) => entries.length > 1)
    .map(([kind, entries]) => ({
      kind,
      card: cardLabel(kind),
      fileNames: entries.map((e) => e.fileName),
      message: `${entries.length} files in this drop are the ${cardLabel(kind)}. A bundle carries one of each, `
        + "so choose which to publish.",
    }));

  return {
    routed,
    rejected,
    conflicts,
    /* The screen must show every classification and must not publish until it
       has. Said in the payload so the rule lives on the server too. */
    confirmationRequired: routed.length > 0,
  };
}

module.exports = {
  classifyBundleFile, routeDroppedFiles,
  BUNDLE_KIND, CLASSIFICATION, SIGNATURES,
  ClassifyError, signatureOf, looksLikeDxf, inspectGltfJson, readSource,
};
