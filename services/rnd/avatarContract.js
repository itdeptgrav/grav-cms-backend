// services/rnd/avatarContract.js
//
// AN AVATAR RECORD, CHECKED BY THE SERVER RATHER THAN BELIEVED.
//
// The browser generates the body (OxiHuman runs in a Web Worker, next to the
// renderer) and sends the server a contract: what was asked for, which engine
// made it, the parameters, what GRAV's tape measured on the result, and the
// hashes of the geometry. The server cannot re-run the engine, but it does not
// have to trust the arithmetic either:
//
//   · the content hash is recomputed from the canonical JSON — same algorithm
//     as `grav-cms/components/rnd/avatar/hash.js`, sorted keys at every depth;
//   · every Pass / Review / Fail is re-derived from the stored requested and
//     generated numbers with the fixed rule (≤5 mm, ≤10 mm, beyond), and so is
//     the verdict — a client that posts "fit-verified" over a 12 mm miss is
//     refused, not corrected;
//   · the engine, its version and both binary hashes must be the pinned ones;
//   · units, axes and the collision body's presence are checked, because a
//     record that cannot be draped against is not an avatar.
//
// Pure: no database, no request. `avatar.service.js` stores what passes here.
"use strict";

const crypto = require("crypto");

const SCHEMA = "grav.avatar/1";

/** The engines this server will record avatars from. Mirrors `pinned.js`. */
const PINNED_ENGINES = Object.freeze({
  oxihuman: Object.freeze({
    "0.2.1": Object.freeze({
      wasmSha256: "5213bfc577d30b2ebae057777b1586ed6e5ca613e09fff0e5daf52b6d112ba31",
      packSha256: "09c4bb1f849fe5d2bc21db6dd8a8bf7c753ee58db185bc46ab4c6b8e0dc0f6f7",
      packId: "oxihuman-core-v1",
    }),
  }),
});

const TOLERANCE_MM = Object.freeze({ pass: 5, review: 10 });
const VERIFIED = Object.freeze([
  ["height", "heightMm"], ["chest", "chestMm"], ["waist", "waistMm"], ["hip", "hipMm"],
]);
const FRAME = Object.freeze({ units: "mm", up: "+Y", forward: "+Z", handedness: "right" });
const POSES = Object.freeze(["a-pose", "standing-neutral"]);
const MAX_CONTRACT_BYTES = 96 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;

class AvatarContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.status = 422;
    this.details = details;
  }
}
const refuse = (code, message, details) => { throw new AvatarContractError(code, message, details); };

function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("A non-finite number cannot be hashed.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

const sha256Json = (value) => crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");

function statusFor(differenceMm) {
  const d = Math.abs(differenceMm);
  if (!Number.isFinite(d)) return "fail";
  if (d <= TOLERANCE_MM.pass) return "pass";
  if (d <= TOLERANCE_MM.review) return "review";
  return "fail";
}

function verdictFor(statuses) {
  if (statuses.includes("fail")) return "failed";
  if (statuses.includes("review")) return "review";
  return "fit-verified";
}

const finite = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * Check a contract posted by the browser. Returns the summary the record keeps
 * beside the full content; throws an `AvatarContractError` naming the first
 * thing that is wrong.
 */
function verifyContract(contract) {
  if (!contract || typeof contract !== "object") refuse("INVALID_RECORD", "No avatar record was sent.");
  if (contract.schema !== SCHEMA) {
    refuse("INVALID_RECORD", `This server reads avatar records of schema ${SCHEMA}.`, { schema: contract.schema ?? null });
  }
  const c = contract.content;
  if (!c || typeof c !== "object") refuse("INVALID_RECORD", "The avatar record has no content.");
  let bytes;
  try { bytes = Buffer.byteLength(canonicalJson(c), "utf8"); } catch (err) {
    refuse("INVALID_RECORD", "The avatar record contains a value that cannot be stored.", { cause: err.message });
  }
  if (bytes > MAX_CONTRACT_BYTES) {
    refuse("INVALID_RECORD", "The avatar record is larger than an avatar record can be. Geometry is not stored here.",
      { bytes, limit: MAX_CONTRACT_BYTES });
  }
  const computed = sha256Json(c);
  if (computed !== contract.contentSha256) {
    refuse("CONTENT_HASH_MISMATCH", "The avatar record does not match its own content hash.",
      { claimed: contract.contentSha256 ?? null, computed });
  }

  /* ── THE ENGINE ── */
  const e = c.engine || {};
  const pinned = PINNED_ENGINES[e.name]?.[e.version];
  if (!pinned) {
    refuse("ENGINE_VERSION_MISMATCH", `This server records avatars from pinned engines only; ${e.name || "?"} `
      + `${e.version || "?"} is not one of them.`, { engine: e.name ?? null, version: e.version ?? null });
  }
  if (e.wasmSha256 !== pinned.wasmSha256 || e.packSha256 !== pinned.packSha256 || e.packId !== pinned.packId) {
    refuse("ENGINE_VERSION_MISMATCH", "The avatar was made with an engine binary or asset pack that is not the pinned one.",
      { wasmSha256: e.wasmSha256 ?? null, packSha256: e.packSha256 ?? null });
  }

  /* ── UNITS AND FRAME ── */
  for (const [k, v] of Object.entries(FRAME)) {
    if (c.frame?.[k] !== v) {
      refuse(k === "units" ? "UNIT_MISMATCH" : "COORDINATE_MISMATCH",
        `The avatar's ${k} is "${c.frame?.[k] ?? ""}", not "${v}".`, { field: k });
    }
  }
  const req = c.request || {};
  if (req.unit !== "mm") refuse("UNIT_MISMATCH", "Avatar measurements are stored in millimetres.");
  if (!["masculine", "feminine"].includes(req.profile)) refuse("INVALID_RECORD", "The avatar has no body profile.");
  const requested = {};
  for (const [, input] of VERIFIED) {
    const v = req.measurements?.[input];
    if (!finite(v) || v < 300 || v > 2600) {
      refuse("UNIT_MISMATCH", `The requested ${input} is not a body measurement in millimetres.`, { [input]: v ?? null });
    }
    requested[input] = v;
  }

  /* ── THE VERIFICATION, RE-DERIVED ── */
  const tol = c.tolerance || {};
  if (tol.passMm !== TOLERANCE_MM.pass || tol.reviewMm !== TOLERANCE_MM.review) {
    refuse("TOLERANCE_MISMATCH", "Avatar tolerances are fixed at ±5 mm (pass) and ±10 mm (review).", { tolerance: tol });
  }
  const rows = c.measurements?.verified;
  if (!Array.isArray(rows) || rows.length !== VERIFIED.length) {
    refuse("INVALID_RECORD", "The avatar must report height, chest, waist and hip as measured.");
  }
  const generated = {};
  const statuses = [];
  for (const [key, input] of VERIFIED) {
    const row = rows.find((r) => r?.key === key);
    if (!row || !finite(row.generatedMm) || !finite(row.differenceMm)) {
      refuse("INVALID_RECORD", `The avatar does not report a measured ${key}.`, { key });
    }
    if (row.requestedMm !== requested[input]) {
      refuse("VERIFICATION_MISMATCH", `The ${key} the avatar was checked against is not the ${key} it was asked for.`,
        { key, requested: requested[input], checkedAgainst: row.requestedMm });
    }
    const diff = Math.round((row.generatedMm - row.requestedMm) * 10) / 10;
    if (Math.abs(diff - row.differenceMm) > 0.051) {
      refuse("VERIFICATION_MISMATCH", `The ${key} difference does not follow from the numbers beside it.`,
        { key, claimed: row.differenceMm, computed: diff });
    }
    const status = statusFor(row.differenceMm);
    if (status !== row.status) {
      refuse("VERIFICATION_MISMATCH", `${key} is ${row.differenceMm} mm from its request, which is "${status}", `
        + `not "${row.status}".`, { key, claimed: row.status, computed: status });
    }
    generated[key] = row.generatedMm;
    statuses.push(status);
  }
  const verdict = verdictFor(statuses);
  if (c.verification?.verdict !== verdict || c.verification?.fitVerified !== (verdict === "fit-verified")) {
    refuse("VERIFICATION_MISMATCH", `The measurements make this avatar "${verdict}", which is not what it claims.`,
      { claimed: c.verification?.verdict ?? null, computed: verdict });
  }

  /* ── GEOMETRY REFERENCES AND THE COLLISION BODY ── */
  const rm = c.renderMesh || {};
  if (rm.kind !== "deterministic-regeneration" || !HEX64.test(rm.restPositionsSha256 || "")
    || !HEX64.test(rm.indicesSha256 || "")
    || !POSES.every((p) => HEX64.test(rm.posedPositionsSha256?.[p] || ""))) {
    refuse("INVALID_RECORD", "The avatar's render-mesh reference is incomplete.");
  }
  const cb = c.collisionBody || {};
  if (cb.kind !== "capsules" || !HEX64.test(cb.sha256 || "")) {
    refuse("COLLISION_BODY_FAILED", "The avatar has no collision body.");
  }
  for (const p of POSES) {
    const body = cb.bodies?.[p];
    if (!body || body.kind !== "capsules" || !Array.isArray(body.capsules) || body.capsules.length < 7
      || body.capsules.some((cap) => !cap?.a || !cap?.b || !finite(cap.r))) {
      refuse("COLLISION_BODY_FAILED", `The avatar's ${p} collision body is missing or malformed.`, { pose: p });
    }
  }
  if (sha256Json(cb.bodies) !== cb.sha256) {
    refuse("CONTENT_HASH_MISMATCH", "The collision body does not match its own hash.");
  }
  if (!POSES.includes(c.pose?.default)) refuse("INVALID_RECORD", "The avatar has no default pose.");

  return {
    engine: { name: e.name, version: e.version, packId: e.packId, packSha256: e.packSha256, wasmSha256: e.wasmSha256 },
    profile: req.profile,
    presetId: typeof req.presetId === "string" ? req.presetId : null,
    requestedMm: requested,
    generatedMm: generated,
    verdict,
    rows: VERIFIED.map(([key]) => {
      const r = rows.find((x) => x.key === key);
      return { key, requestedMm: r.requestedMm, generatedMm: r.generatedMm, differenceMm: r.differenceMm, status: r.status };
    }),
    defaultPose: c.pose.default,
    renderMesh: {
      kind: rm.kind, vertices: rm.vertices, triangles: rm.triangles,
      restPositionsSha256: rm.restPositionsSha256, indicesSha256: rm.indicesSha256,
      posedPositionsSha256: rm.posedPositionsSha256,
    },
    collisionBody: { kind: cb.kind, contract: cb.contract, sha256: cb.sha256 },
    bytes,
  };
}

module.exports = {
  SCHEMA, PINNED_ENGINES, TOLERANCE_MM, MAX_CONTRACT_BYTES,
  AvatarContractError, canonicalJson, sha256Json, statusFor, verdictFor, verifyContract,
};
