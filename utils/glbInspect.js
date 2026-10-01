// utils/glbInspect.js
//
// WHAT A PUBLISHED GARMENT MODEL ACTUALLY CONTAINS, READ FROM ITS OWN BYTES.
//
// ── WHY THE SERVER READS THE MODEL AT ALL ───────────────────────────────────
// R&D anchors a construction marker to a PATTERN PIECE — "the under-collar
// seam", "the left front placket" — and an anchor is only as stable as the
// identity it names. A marker pinned to a screen position is worthless the
// moment the camera moves; a marker pinned to a node NAME survives rotation,
// a reload, a different monitor and a different reader.
//
// So the names have to be real, and the only way to know they are real is to
// read them out of the file before anything is stored. A CLO export that
// published `Object_12` and `Object_13` cannot carry a construction record,
// and the publisher is told that at upload time rather than discovering it
// when the first marker lands in the wrong place.
//
// ── AND WHY IT PARSES RATHER THAN LOADS ─────────────────────────────────────
// Nothing here needs geometry, so nothing here decodes any. A GLB's first
// chunk is a JSON document describing the whole scene graph; reading it costs
// a buffer slice and a `JSON.parse`, and it cannot execute anything. Pulling
// in a full glTF loader on the server to learn a list of names would be a
// large dependency and a much larger attack surface for the same answer.
//
// ── WHAT IT REFUSES ─────────────────────────────────────────────────────────
// A file whose magic is not `glTF`, a version other than 2, a chunk table that
// runs past the end of the buffer, a JSON chunk that is not an object, and a
// declared length that disagrees with the bytes received. Each of those is a
// file that a browser's loader would also refuse, and refusing here means the
// refusal arrives with a sentence rather than as a blank viewport.
"use strict";

const MAGIC = 0x46546c67; /* 'glTF', little-endian */
const CHUNK_JSON = 0x4e4f534a; /* 'JSON' */
const CHUNK_BIN = 0x004e4942; /* 'BIN\0' */

/** A node name a human wrote, as opposed to one an exporter counted out. */
const GENERIC_NAME = /^(object|node|mesh|group|primitive|untitled|unnamed)[\s._-]*\d*$/i;

/**
 * Names that identify an avatar, and ONLY used to answer "is there one".
 *
 * Deliberately not used to label anything: calling a node "the avatar" because
 * it matched a word is a guess, and a guess presented as a published identity
 * is exactly what the structure panel must never contain. All this decides is
 * whether a show/hide control is offered at all — a control that does nothing
 * is worse than an absent one.
 */
const AVATAR_NAME = /\b(avatar|mannequin|dress\s*form|body|figure)\b/i;

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());

class GlbError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GlbError";
    this.code = code;
  }
}

const refuse = (code, message) => { throw new GlbError(code, message); };

/**
 * The JSON chunk of a GLB, as an object.
 *
 * @param {Buffer} buffer the whole uploaded file
 */
function readContainer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 20) {
    refuse("GLB_TOO_SMALL", "That file is too small to be a GLB model.");
  }
  if (buffer.readUInt32LE(0) !== MAGIC) {
    refuse("GLB_NOT_BINARY_GLTF",
      "That file is not a binary glTF (.glb). Export the web model from CLO as GLB — "
      + "a .zprj or .gltf+bin pair cannot be displayed in the browser.");
  }
  const version = buffer.readUInt32LE(4);
  if (version !== 2) {
    refuse("GLB_VERSION_UNSUPPORTED", `This model declares glTF version ${version}; only version 2 can be displayed.`);
  }
  const declared = buffer.readUInt32LE(8);
  if (declared !== buffer.length) {
    refuse("GLB_TRUNCATED",
      `This model says it is ${declared} bytes and ${buffer.length} arrived. The upload is incomplete or corrupt.`);
  }

  let offset = 12;
  let json = null;
  let binBytes = 0;
  while (offset + 8 <= buffer.length) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + chunkLength;
    if (end > buffer.length) {
      refuse("GLB_TRUNCATED", "This model's chunk table runs past the end of the file.");
    }
    if (chunkType === CHUNK_JSON && json === null) {
      try {
        json = JSON.parse(buffer.subarray(start, end).toString("utf8"));
      } catch {
        refuse("GLB_JSON_UNREADABLE", "This model's scene description could not be read.");
      }
    } else if (chunkType === CHUNK_BIN) {
      binBytes += chunkLength;
    }
    /* Chunks are 4-byte aligned; the padding is not part of the length. */
    offset = end + ((4 - (chunkLength % 4)) % 4);
  }

  if (!json || typeof json !== "object" || Array.isArray(json)) {
    refuse("GLB_JSON_MISSING", "This model has no readable scene description.");
  }
  return { json, binBytes };
}

/** Triangles behind one mesh, from its accessors rather than its geometry. */
function trianglesOf(mesh, accessors) {
  let total = 0;
  for (const prim of mesh?.primitives || []) {
    /* glTF mode 4 is TRIANGLES and is the default; 5 and 6 are strips and
       fans, where n vertices make n-2 triangles. Anything else draws no
       triangles at all. */
    const mode = prim.mode === undefined ? 4 : prim.mode;
    const accessorIndex = prim.indices !== undefined ? prim.indices : prim.attributes?.POSITION;
    const count = Number(accessors?.[accessorIndex]?.count) || 0;
    if (mode === 4) total += Math.floor(count / 3);
    else if (mode === 5 || mode === 6) total += Math.max(0, count - 2);
  }
  return total;
}

/**
 * The published structure, as a flat list carrying its own parentage.
 *
 * Flat rather than nested because it is stored, queried and compared: an
 * annotation names ONE node and has to find it again without walking a tree,
 * and a successor publication is compared to this one node by node.
 *
 * `nodeRef` is the node's index in the file's own node array, prefixed so it
 * can never be mistaken for an array position in some other list. It is the
 * only identity the file itself guarantees to be unique; names are not, and
 * two pattern pieces called "Panel" are common.
 */
function structureOf(json) {
  const nodes = Array.isArray(json.nodes) ? json.nodes : [];
  const meshes = Array.isArray(json.meshes) ? json.meshes : [];
  const materials = Array.isArray(json.materials) ? json.materials : [];
  const accessors = Array.isArray(json.accessors) ? json.accessors : [];

  const parentOf = new Map();
  nodes.forEach((node, index) => {
    for (const child of node.children || []) parentOf.set(child, index);
  });

  const rows = nodes.map((node, index) => {
    const mesh = node.mesh !== undefined ? meshes[node.mesh] : null;
    const triangles = mesh ? trianglesOf(mesh, accessors) : 0;
    const materialNames = mesh
      ? [...new Set((mesh.primitives || [])
        .map((p) => (p.material !== undefined ? str(materials[p.material]?.name) : ""))
        .filter(Boolean))]
      : [];
    const name = str(node.name) || str(mesh?.name);
    return {
      nodeRef: `n${index}`,
      parentRef: parentOf.has(index) ? `n${parentOf.get(index)}` : "",
      /* Exactly what the file says, never a tidied or inferred version. */
      name,
      kind: mesh ? "mesh" : "group",
      meshName: str(mesh?.name),
      materialNames,
      triangles,
      /* True when the exporter counted this node out rather than somebody
         naming it. Reported so the screen can say the publication carries no
         usable pattern-piece identity instead of showing `Object_12` as
         though it meant something. */
      generatedName: !name || GENERIC_NAME.test(name),
      depth: 0,
    };
  });

  /* Depth, for a tree that renders by indent rather than by recursion. */
  const byRef = new Map(rows.map((r) => [r.nodeRef, r]));
  for (const row of rows) {
    let depth = 0;
    let cursor = row.parentRef;
    while (cursor && depth < 64) { depth += 1; cursor = byRef.get(cursor)?.parentRef || ""; }
    row.depth = depth;
  }
  return rows;
}

/**
 * Read one uploaded GLB.
 *
 * @param {Buffer} buffer
 * @returns {{
 *   structure: object[], stats: object, manifest: object,
 *   hasAvatar: boolean, avatarNodeRefs: string[], namedPieces: number,
 * }}
 */
function inspectGlb(buffer) {
  const { json, binBytes } = readContainer(buffer);
  const structure = structureOf(json);

  const meshRows = structure.filter((r) => r.kind === "mesh");
  const named = meshRows.filter((r) => !r.generatedName);

  /* Only a SEPARATELY identifiable avatar counts: a root-level node, named as
     one, that is not the garment itself. A mesh buried inside a pattern piece
     and called "body" is a panel, and offering a "hide avatar" control for it
     would hide part of the garment. */
  const avatarRows = structure.filter((r) => !r.parentRef && AVATAR_NAME.test(r.name));
  const hasAvatar = avatarRows.length > 0 && avatarRows.length < structure.filter((r) => !r.parentRef).length;

  return {
    structure,
    stats: {
      nodes: structure.length,
      meshes: meshRows.length,
      materials: (json.materials || []).length,
      triangles: structure.reduce((n, r) => n + r.triangles, 0),
      bytes: buffer.length,
      binBytes,
      animations: (json.animations || []).length,
    },
    manifest: {
      /* The exporter's own words. CLO writes its version in here, which is
         how a publication can state the tool that made it without asking the
         publisher to retype something the file already knows. */
      generator: str(json.asset?.generator),
      gltfVersion: str(json.asset?.version),
      copyright: str(json.asset?.copyright),
      extensionsUsed: (json.extensionsUsed || []).map(str),
      extensionsRequired: (json.extensionsRequired || []).map(str),
    },
    hasAvatar,
    avatarNodeRefs: hasAvatar ? avatarRows.map((r) => r.nodeRef) : [],
    namedPieces: named.length,
    /* The question the publisher has to be able to answer before a single
       marker is placed. */
    anchorable: named.length > 0,
  };
}

module.exports = { inspectGlb, readContainer, structureOf, GlbError, GENERIC_NAME, AVATAR_NAME };
