"use strict";

const crypto = require("crypto");
const { readFactoryTwinConfig } = require("./factoryTwinConfig.service");
const {
  OBSERVATION_VERSION,
  projectFootPoint,
  projectFloorEstimate,
  projectHeadEstimate, heightAbovePoint,
  calibrationReliability,
  validateSpatialObservation,
} = require("./factoryTwinSpatial.service");

const DEFAULT_TTL_MS = 4_000;
const CONFIG_CACHE_MS = 30_000;
const MAX_TRACKS_PER_CAMERA = 100;
const POSTURE_MIN_CONFIDENCE = 0.5;
const ORIENTATION_MIN_CONFIDENCE = 0.4;
const ESTIMATE_TOLERANCE_M = 0.75;
const SEEN_FEET_TOLERANCE_M = 0.15;
const POSTURES = new Set(["STANDING", "SEATED", "CROUCHED"]);
const ANCHOR_MODES = new Set(["POSE_ANKLES", "BOX_BOTTOM", "POSE_HIP_ESTIMATE", "POSE_HEAD_ESTIMATE", "POSE_HIP_HEIGHT", "POSE_SHOULDER_HEIGHT", "BOX_TOP_HEIGHT", "OCCUPANCY_PROXY"]);
const ESTIMATE_ANCHORS = new Set(["POSE_HIP_ESTIMATE", "OCCUPANCY_PROXY"]);
const tracksByCamera = new Map();
const objectsByCamera = new Map();
// People the detector saw but the twin could not place on the floor. They are
// shown as "in view, position unknown" — never at a coordinate — so a person
// in the camera is never silently missing from the twin.
const unpositionedByCamera = new Map();
// One feed per camera (contract §3): the last accepted sessionRef holds the
// lease until it stops posting for DEFAULT_TTL_MS or sends `final: true`.
const leasesByCamera = new Map();
const feedsByCamera = new Map();
let cachedConfig = null;
let cachedConfigAt = 0;

class TwinObservationError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "TwinObservationError";
    this.code = code;
    this.status = status;
  }
}

const cameraKey = (value) => String(value || "").trim().toLowerCase();
const finite = (value) => Number.isFinite(Number(value));
const strictFinite = (value) => typeof value === "number" && Number.isFinite(value);
const unit = (value) => Math.max(0, Math.min(1, Number(value)));
const round = (value, places) => Math.round(value * 10 ** places) / 10 ** places;

function fresh(observation, nowMs = Date.now(), ttlMs = DEFAULT_TTL_MS) {
  const observedMs = Date.parse(observation?.observedAt || "");
  return Number.isFinite(observedMs) && observedMs <= nowMs + 2_000 && nowMs - observedMs <= ttlMs;
}

function prune(nowMs = Date.now(), ttlMs = DEFAULT_TTL_MS) {
  for (const [cameraRef, tracks] of tracksByCamera) {
    for (const [trackId, observation] of tracks) {
      if (!fresh(observation, nowMs, ttlMs)) tracks.delete(trackId);
    }
    if (!tracks.size) tracksByCamera.delete(cameraRef);
  }
  for (const [cameraRef, objects] of objectsByCamera) {
    for (const [objectId, observation] of objects) {
      if (!fresh(observation, nowMs, ttlMs)) objects.delete(objectId);
    }
    if (!objects.size) objectsByCamera.delete(cameraRef);
  }
  for (const [cameraRef, people] of unpositionedByCamera) {
    const kept = people.filter((item) => fresh(item, nowMs, ttlMs));
    if (kept.length) unpositionedByCamera.set(cameraRef, kept); else unpositionedByCamera.delete(cameraRef);
  }
}

// Reasons a seen person could not be placed, in the operator's words.
const UNPOSITIONED_REASONS = {
  CALIBRATION_UNRELIABLE: "The floor mapping for this camera is unreliable, so no position is shown.",
  OUTSIDE_CALIBRATED_AREA: "Outside the surveyed floor area.",
  BEYOND_HORIZON: "The point is above the floor's horizon in this mapping.",
  OUTSIDE_ROOM: "The mapping places this point outside the room.",
  REPROJECTION_ERROR_HIGH: "The mapping is too inaccurate here.",
};

function activityFrom(raw) {
  const allowed = new Set([
    "NO_PHONE", "PHONE_VISIBLE", "PHONE_HELD", "NOT_ACTIVE_UNSPECIFIED",
    "ACTIVE_VIEW_OR_TYPE", "ACTIVE_CALL", "ACTIVE_USE_UNSPECIFIED", "UNCERTAIN",
  ]);
  const label = allowed.has(raw?.label) ? raw.label : "UNCERTAIN";
  const confidence = finite(raw?.confidence)
    ? Math.max(0, Math.min(1, Number(raw.confidence)))
    : 0;
  return { label, confidence };
}

// A name is accepted only from the worker's direct, margin-checked face path.
// Tracker appearance is deliberately not an identity source.
function identityFrom(raw) {
  if (!raw || raw.status !== "CONFIRMED_FACE" || raw.source !== "PHONE_DETC_GALLERY") return null;
  const displayName = typeof raw.displayName === "string" ? raw.displayName.trim().slice(0, 80) : "";
  if (!displayName || !strictFinite(raw.confidence)) return null;
  const matchedMs = Date.parse(raw.matchedAt || "");
  return {
    status: "CONFIRMED_FACE",
    displayName,
    confidence: unit(raw.confidence),
    source: "PHONE_DETC_GALLERY",
    matchedAt: Number.isFinite(matchedMs) ? new Date(matchedMs).toISOString() : null,
  };
}

function normalizeYaw(degrees) {
  let value = ((degrees % 360) + 360) % 360;
  if (value > 180) value -= 360;
  return value;
}

/**
 * Convert a camera-relative body yaw (0 = facing the camera, +90 = facing
 * image-right, ±180 = facing away) into a world yaw with the camera-yaw
 * convention: facing (sin yaw, cos yaw) in x/z. Returns null when the geometry
 * cannot support a direction.
 */
function worldYawFromRelative(relativeYawDeg, cameraPositionM, personPositionM) {
  if (!strictFinite(relativeYawDeg)) return null;
  if (![cameraPositionM?.x, cameraPositionM?.z, personPositionM?.x, personPositionM?.z].every(strictFinite)) return null;
  const vx = personPositionM.x - cameraPositionM.x;
  const vz = personPositionM.z - cameraPositionM.z;
  const length = Math.hypot(vx, vz);
  if (length < 1e-6) return null;
  // Facing the camera means facing back along the camera->person ray.
  const fx = -vx / length; const fz = -vz / length;
  const a = (relativeYawDeg * Math.PI) / 180;
  const x = fx * Math.cos(a) + fz * Math.sin(a);
  const z = -fx * Math.sin(a) + fz * Math.cos(a);
  return round(normalizeYaw((Math.atan2(x, z) * 180) / Math.PI), 1);
}

/** Typed posture/orientation evidence; nothing is asserted without pose. */
const GESTURES = new Set(["HAND_AT_HEAD", "HANDS_FORWARD", "HAND_RAISED"]);
const INTERACTIONS = new Set(["PHONE_IN_HAND"]);
const EVIDENCE_MIN_CONFIDENCE = 0.5;
// Live objects are portable things. Chairs and tables belong to the surveyed
// layout; a detector "chair" must not add a second one on top of it.
// CHAIR is not drawn as an object: the twin moves the layout chairs to it.
const LIVE_OBJECT_TYPES = new Set(["BOTTLE", "CUP", "MONITOR", "LAPTOP", "KEYBOARD", "MOUSE", "PHONE", "BACKPACK", "HANDBAG", "NOTEBOOK", "CHAIR"]);
const MIN_OBJECT_CONFIRMATIONS = 3;

/** The 17 COCO body points in calibration-image pixels, or null. */
function pose2dFrom(raw, scale) {
  const points = raw?.pose2d?.keypoints;
  if (!Array.isArray(points) || points.length !== 17) return null;
  const out = [];
  for (const point of points) {
    if (!Array.isArray(point) || point.length !== 3 || !point.every(strictFinite)) return null;
    out.push([round(point[0] * scale.x, 1), round(point[1] * scale.y, 1), round(unit(point[2]), 2)]);
  }
  return { keypoints: out };
}

/** Typed evidence labels above the confidence floor; anything unknown is dropped. */
function evidenceFrom(list, allowed) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((item) => allowed.has(item?.kind) && strictFinite(item?.confidence) && item.confidence >= EVIDENCE_MIN_CONFIDENCE)
    .slice(0, 4)
    .map((item) => ({ kind: item.kind, confidence: round(unit(item.confidence), 3) }));
}

function visualFrom(raw, cameraPositionM, personPositionM, scale = { x: 1, y: 1 }) {
  const postureSource = raw?.postureSource === "POSE" ? "POSE" : "NONE";
  const postureConfidence = postureSource === "POSE" && strictFinite(raw?.postureConfidence)
    ? unit(raw.postureConfidence) : 0;
  const posture = postureSource === "POSE" && POSTURES.has(raw?.posture) && postureConfidence >= POSTURE_MIN_CONFIDENCE
    ? raw.posture : "UNKNOWN";
  const relativeYawDeg = raw?.orientation?.relativeYawDeg;
  const orientationConfidence = strictFinite(relativeYawDeg) && strictFinite(raw?.orientation?.confidence)
    ? unit(raw.orientation.confidence) : 0;
  const orientationDeg = orientationConfidence >= ORIENTATION_MIN_CONFIDENCE
    ? worldYawFromRelative(relativeYawDeg, cameraPositionM, personPositionM) : null;
  // Which way the pose evidence leans while the worker's posture is still
  // dwelling (never set alongside a confirmed posture). The twin uses it only
  // to avoid guessing "probably seated" for someone the evidence says stands.
  const hint = raw?.postureHint;
  const postureHint = posture === "UNKNOWN" && POSTURES.has(hint?.posture) && hint.posture !== "UNKNOWN"
    && strictFinite(hint?.confidence) && hint.confidence >= 0.4
    ? { posture: hint.posture, confidence: round(unit(hint.confidence), 3) } : null;
  return {
    posture,
    postureConfidence,
    postureSource,
    postureHint,
    orientationDeg,
    orientationConfidence: orientationDeg == null ? 0 : orientationConfidence,
    keypointVisibility: strictFinite(raw?.keypointVisibility) ? unit(raw.keypointVisibility) : null,
    // Body points drive the twin's rig. Gestures describe what the arms are
    // doing; interactions need a confirmed object at the wrist. Neither is an
    // activity claim — `activity` stays a separate, stricter field.
    pose2d: pose2dFrom(raw, scale),
    gestures: evidenceFrom(raw?.gestures, GESTURES),
    interactions: evidenceFrom(raw?.interactions, INTERACTIONS),
    appearance: appearanceFrom(raw?.appearance),
    detector: detectorFrom(raw, scale),
  };
}

/**
 * What the models said before any of the rules above: the person box, the
 * worker's own posture call and anchor, and every typed hand score (not only
 * those over the evidence floor). For the twin's dev view; numbers only.
 */
function detectorFrom(raw, scale) {
  const b = raw?.imageBoxPx;
  const boxPx = [b?.x1, b?.y1, b?.x2, b?.y2].every(strictFinite) && b.x2 > b.x1 && b.y2 > b.y1
    ? { x1: round(b.x1 * scale.x, 1), y1: round(b.y1 * scale.y, 1), x2: round(b.x2 * scale.x, 1), y2: round(b.y2 * scale.y, 1) } : null;
  return {
    boxPx,
    trackingConfidence: strictFinite(raw?.trackingConfidence) ? round(unit(raw.trackingConfidence), 3) : null,
    posture: POSTURES.has(raw?.posture) ? raw.posture : "UNKNOWN",
    postureConfidence: strictFinite(raw?.postureConfidence) ? round(unit(raw.postureConfidence), 3) : 0,
    anchorMode: typeof raw?.anchorMode === "string" ? raw.anchorMode.slice(0, 40) : null,
    scores: [...(Array.isArray(raw?.interactions) ? raw.interactions : []), ...(Array.isArray(raw?.gestures) ? raw.gestures : [])]
      .filter((item) => (INTERACTIONS.has(item?.kind) || GESTURES.has(item?.kind)) && strictFinite(item?.confidence))
      .slice(0, 6).map((item) => ({ kind: item.kind, confidence: round(unit(item.confidence), 3) })),
  };
}

// Clothing colours only (#rrggbb), so a figure can wear the shirt the camera
// sees; never an image or a crop.
const HEX = /^#[0-9a-f]{6}$/i;
function appearanceFrom(raw) {
  if (!raw || typeof raw !== "object" || !HEX.test(String(raw.shirt || ""))) return null;
  return { shirt: String(raw.shirt).toLowerCase(), trousers: HEX.test(String(raw.trousers || "")) ? String(raw.trousers).toLowerCase() : null };
}

// An alignment nobody has checked against a measured floor mark may be right,
// but it is not evidence of a precise position: cap it like an estimate.
function capUnverified(calibration, projection) {
  if (calibration?.verified !== false || !projection?.worldPositionM) return projection;
  return { ...projection, quality: "DEGRADED", confidence: Math.min(Number(projection.confidence) || 0, 0.5), unverified: true };
}

function projectTrack(calibration, imagePoint, anchorMode, room, head = null) {
  if (HEIGHT_ANCHORS[anchorMode]) {
    // The point is the head, or the hips of someone whose legs are hidden
    // behind a table; the floor position follows from the camera's height.
    const estimate = projectHeadEstimate(calibration, imagePoint, {
      cameraM: head?.cameraM, headHeightM: head?.heights?.[anchorMode],
      roomWidthM: room?.widthM, roomDepthM: room?.depthM, toleranceM: ESTIMATE_TOLERANCE_M,
    });
    return capUnverified(calibration, { ...estimate, method: HEIGHT_ANCHORS[anchorMode].method });
  }
  return capUnverified(calibration, projectTrackRaw(calibration, imagePoint, anchorMode, room));
}

// Head heights above the floor by posture (adults, nose level), used only by
// POSE_HEAD_ESTIMATE when the worker does not send its own.
const HEAD_HEIGHT_M = { STANDING: 1.6, SEATED: 1.2, CROUCHED: 0.9, UNKNOWN: 1.4 };
// Hip-joint heights for POSE_HIP_HEIGHT (legs hidden with hips seen is nearly
// always someone seated at a table, so UNKNOWN sits).
const HIP_HEIGHT_M = { STANDING: 0.95, SEATED: 0.5, CROUCHED: 0.45, UNKNOWN: 0.5 };
const SHOULDER_HEIGHT_M = { STANDING: 1.45, SEATED: 1.0, CROUCHED: 0.85, UNKNOWN: 1.0 };
// Crown (top of the head) heights for BOX_TOP_HEIGHT: someone cut off by the
// bottom of the frame, right under the camera, is placed by the top of the box.
const CROWN_HEIGHT_M = { STANDING: 1.75, SEATED: 1.3, CROUCHED: 1.0, UNKNOWN: 1.3 };
// Anchors that are a body point at a known height: [default heights by posture, accepted range, method].
const HEIGHT_ANCHORS = {
  POSE_HEAD_ESTIMATE: { table: HEAD_HEIGHT_M, min: 0.5, max: 2.2, method: "HEAD_HEIGHT_ESTIMATE" },
  POSE_SHOULDER_HEIGHT: { table: SHOULDER_HEIGHT_M, min: 0.6, max: 1.7, method: "SHOULDER_HEIGHT_ESTIMATE" },
  POSE_HIP_HEIGHT: { table: HIP_HEIGHT_M, min: 0.3, max: 1.2, method: "HIP_HEIGHT_ESTIMATE" },
  BOX_TOP_HEIGHT: { table: CROWN_HEIGHT_M, min: 0.8, max: 2.0, method: "CROWN_HEIGHT_ESTIMATE" },
};

// Feet the pose model reports for someone standing must put their hips at a
// standing height. Live: a man standing bent over the table, his feet hidden
// behind someone at the frame edge, got "ankles" (0.5 confidence) that put
// his hips 0.66 m up — 0.25 m toward the wall. When the hips sit lower than
// this over the reported feet, the feet are a guess and the hips place him.
const STANDING_HIPS_MIN_M = 0.75;
// Height of a chair's backrest top, for placing a chair by its box top.
const CHAIR_BACK_HEIGHT_M = 0.95;
function feetCheckedAgainstHips(calibration, raw, anchorMode, projection, room, cameraM, heights, scale) {
  if (anchorMode !== "POSE_ANKLES" || !projection?.worldPositionM || !cameraM) return null;
  const standing = raw?.posture === "STANDING" || raw?.postureHint?.posture === "STANDING";
  const points = raw?.pose2d?.keypoints;
  if (!standing || !Array.isArray(points) || points.length !== 17) return null;
  const hips = [points[11], points[12]].filter((p) => Array.isArray(p) && p.every(strictFinite) && p[2] >= 0.4);
  if (hips.length !== 2) return null;
  const hipPx = { x: (hips[0][0] + hips[1][0]) / 2 * scale.x, y: (hips[0][1] + hips[1][1]) / 2 * scale.y };
  const height = heightAbovePoint(calibration, hipPx, { cameraM, pointM: projection.worldPositionM });
  if (!Number.isFinite(height) || height >= STANDING_HIPS_MIN_M) return null;
  const hipHeights = { ...heights, POSE_HIP_HEIGHT: HIP_HEIGHT_M.STANDING };
  const fromHips = projectTrack(calibration, hipPx, "POSE_HIP_HEIGHT", room, { cameraM, heights: hipHeights });
  return fromHips?.worldPositionM ? { projection: fromHips, anchorMode: "POSE_HIP_HEIGHT" } : null;
}

function projectTrackRaw(calibration, imagePoint, anchorMode, room) {
  const tolerancePx = Math.max(calibration.imageSize.width, calibration.imageSize.height) * 0.02;
  const homography = projectFootPoint(calibration, imagePoint, { boundaryTolerancePx: tolerancePx });
  // A seen floor contact outside the polygon of mapping points gets the same
  // bounded estimate a hidden-feet anchor does, never a refusal: refusing it
  // made people at the frame edges flicker between placed and absent as their
  // anchor switched between feet and hips. Inside the polygon it is precise.
  const outsidePolygon = homography.reasonCode === "OUTSIDE_CALIBRATED_AREA";
  if (!ESTIMATE_ANCHORS.has(anchorMode) && !outsidePolygon) return { ...homography, method: "FLOOR_HOMOGRAPHY", clamped: false };
  if (homography.insideCalibratedArea) {
    if (!homography.worldPositionM) return { ...homography, method: "FLOOR_HOMOGRAPHY", clamped: false };
    // An estimated floor point is never better than DEGRADED, however good
    // the calibration is where it lands.
    return {
      ...homography,
      quality: "DEGRADED",
      confidence: Math.min(homography.confidence, 0.5),
      method: "FLOOR_HOMOGRAPHY",
      clamped: false,
    };
  }
  // Seen feet are where the person really is: beyond a wall (someone in the
  // corridor seen through the glass door) they are outside, not pulled in.
  // Estimated anchors keep a wider tolerance for their own error.
  const estimate = projectFloorEstimate(calibration, imagePoint, {
    roomWidthM: room?.widthM, roomDepthM: room?.depthM,
    toleranceM: ESTIMATE_ANCHORS.has(anchorMode) ? ESTIMATE_TOLERANCE_M : SEEN_FEET_TOLERANCE_M,
  });
  return { ...estimate, method: "FLOOR_ESTIMATE" };
}

function pipelineFrom(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const pipeline = {};
  for (const key of ["personModel", "poseModel", "worldModel", "tracker", "identityModel"]) {
    if (typeof raw[key] === "string" && raw[key].trim()) pipeline[key] = raw[key].trim().slice(0, 80);
  }
  for (const key of ["poseEnabled", "peopleOnly", "worldEnabled", "objectsEnabled", "identityEnabled"]) {
    if (typeof raw[key] === "boolean") pipeline[key] = raw[key];
  }
  for (const key of ["detectMs", "poseMs", "worldMs", "objectMs", "identityMs", "fps"]) {
    if (strictFinite(raw[key]) && raw[key] >= 0) pipeline[key] = round(raw[key], 1);
  }
  return Object.keys(pipeline).length ? pipeline : null;
}

function frameSizeFrom(raw) {
  const width = Number(raw?.width); const height = Number(raw?.height);
  return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
    ? { width: Math.round(width), height: Math.round(height) } : null;
}

function clearCamera(cameraRef) {
  tracksByCamera.delete(cameraRef);
  unpositionedByCamera.delete(cameraRef);
  objectsByCamera.delete(cameraRef);
  feedsByCamera.delete(cameraRef);
  leasesByCamera.delete(cameraRef);
}

async function liveConfig(nowMs = Date.now()) {
  if (cachedConfig && nowMs - cachedConfigAt < CONFIG_CACHE_MS) return cachedConfig;
  cachedConfig = await readFactoryTwinConfig();
  cachedConfigAt = nowMs;
  return cachedConfig;
}

async function ingestFactoryTwinTracks(payload, { companyRef = "grav", now = new Date() } = {}) {
  const cameraRef = cameraKey(payload?.cameraRef);
  if (!cameraRef) throw new TwinObservationError("CAMERA_REQUIRED", "cameraRef is required.");
  const sourceTracks = Array.isArray(payload?.tracks) ? payload.tracks : [];
  if (sourceTracks.length > MAX_TRACKS_PER_CAMERA) {
    throw new TwinObservationError("TOO_MANY_TRACKS", `At most ${MAX_TRACKS_PER_CAMERA} tracks may be published at once.`);
  }
  const nowMs = now.getTime();
  const sessionRef = String(payload?.sessionRef || `live:${cameraRef}`).trim().slice(0, 160);

  // Session lease: while the holder is live, any other session is refused so
  // two workers (or a stale one) cannot make the snapshot flicker.
  const lease = leasesByCamera.get(cameraRef);
  const leaseLive = lease && nowMs - lease.lastMs <= DEFAULT_TTL_MS;
  if (leaseLive && lease.sessionRef !== sessionRef) {
    throw new TwinObservationError(
      "FEED_SESSION_CONFLICT",
      `Another worker session is already publishing camera ${cameraRef}. Stop it, or wait for its feed to expire.`,
      409,
    );
  }
  if (payload?.final === true) {
    // Shutdown frame: release the lease and empty the camera immediately.
    clearCamera(cameraRef);
    return { accepted: [], acceptedObjects: [], rejected: [], observedAt: now.toISOString(), released: true };
  }

  // Detector frames arrive continuously. Geometry changes rarely, so avoid a
  // database query per frame; that can block uploads long enough for the 4 s
  // live TTL to empty an occupied room. The next refresh picks up edits within
  // 30 seconds (and every server restart starts cold).
  const config = await liveConfig(nowMs);
  const spatial = config?.cameras?.[cameraRef];
  if (spatial?.status !== "CALIBRATED" || !spatial?.calibration) {
    throw new TwinObservationError("CAMERA_NOT_CALIBRATED", "This camera does not have a valid floor calibration.", 409);
  }

  const observedAt = new Date(payload?.observedAt || now).toISOString();
  if (Math.abs(nowMs - Date.parse(observedAt)) > 30_000) {
    throw new TwinObservationError("OBSERVATION_TIME_INVALID", "observedAt must be within 30 seconds of the server clock.");
  }
  const room = (config?.layout?.rooms || []).find((item) => item.id === spatial.roomId);
  const frameSize = frameSizeFrom(payload?.frameSize);
  const sourceWidth = frameSize ? Number(payload.frameSize.width) : spatial.calibration.imageSize.width;
  const sourceHeight = frameSize ? Number(payload.frameSize.height) : spatial.calibration.imageSize.height;
  const scaleX = spatial.calibration.imageSize.width / sourceWidth;
  const scaleY = spatial.calibration.imageSize.height / sourceHeight;
  const accepted = [];
  const acceptedObjects = [];
  const rejected = [];
  const unpositioned = [];
  // A degenerate saved calibration (e.g. three of four points along one wall)
  // fits "exactly" yet maps everything onto a line. Place nobody with it.
  const reliability = calibrationReliability(spatial.calibration);
  const seen = (sourceTrackId, raw, reasonCode) => unpositioned.push({
    schemaVersion: OBSERVATION_VERSION, cameraRef, sessionRef, sourceTrackId, observedAt,
    reasonCode, reason: UNPOSITIONED_REASONS[reasonCode] || "No floor position could be resolved.",
    tracking: { confidence: finite(raw?.trackingConfidence) ? unit(raw.trackingConfidence) : 0 },
    visual: visualFrom(raw, null, null, { x: scaleX, y: scaleY }),
    ...(identityFrom(raw?.identity) ? { identity: identityFrom(raw.identity) } : {}),
  });

  for (const raw of sourceTracks) {
    const sourceTrackId = String(raw?.sourceTrackId ?? "").trim().slice(0, 120);
    if (!sourceTrackId || !finite(raw?.footPointPx?.x) || !finite(raw?.footPointPx?.y)) {
      rejected.push({ sourceTrackId: sourceTrackId || null, reasonCode: "TRACK_POINT_INVALID" });
      continue;
    }
    if (!reliability.ok) {
      rejected.push({ sourceTrackId, reasonCode: "CALIBRATION_UNRELIABLE" });
      seen(sourceTrackId, raw, "CALIBRATION_UNRELIABLE");
      continue;
    }
    // A missing or unknown anchor is treated as the strictest mode.
    let anchorMode = ANCHOR_MODES.has(raw?.anchorMode) ? raw.anchorMode : "BOX_BOTTOM";
    let projection;
    try {
      const origin = room?.originM || { x: 0, z: 0 };
      const cameraM = spatial.worldPositionM && {
        x: Number(spatial.worldPositionM.x) - Number(origin.x || 0),
        y: Number(spatial.worldPositionM.y),
        z: Number(spatial.worldPositionM.z) - Number(origin.z || 0),
      };
      const sentHeight = Number(raw?.anchorHeightM);
      const heights = Object.fromEntries(Object.entries(HEIGHT_ANCHORS).map(([mode, spec]) => [mode,
        Number.isFinite(sentHeight) && sentHeight >= spec.min && sentHeight <= spec.max
          ? sentHeight : spec.table[raw?.posture] ?? spec.table.UNKNOWN]));
      projection = projectTrack(spatial.calibration, {
        x: Number(raw.footPointPx.x) * scaleX,
        y: Number(raw.footPointPx.y) * scaleY,
      }, anchorMode, room, { cameraM, heights });
      const corrected = feetCheckedAgainstHips(spatial.calibration, raw, anchorMode, projection, room, cameraM, heights, { x: scaleX, y: scaleY });
      if (corrected) ({ projection, anchorMode } = corrected);
    } catch {
      projection = { quality: "UNRESOLVABLE", reasonCode: "TRACK_POINT_INVALID" };
    }
    if (!projection.worldPositionM) {
      rejected.push({ sourceTrackId, reasonCode: projection.reasonCode || "POSITION_UNRESOLVABLE" });
      seen(sourceTrackId, raw, projection.reasonCode || "POSITION_UNRESOLVABLE");
      continue;
    }
    const trackingConfidence = finite(raw?.trackingConfidence)
      ? Math.max(0, Math.min(1, Number(raw.trackingConfidence))) : 0;
    const observation = {
      schemaVersion: OBSERVATION_VERSION,
      eventId: crypto.randomUUID(),
      companyRef: String(companyRef || "grav"),
      siteRef: spatial.calibration.siteRef,
      cameraRef,
      sessionRef,
      sourceTrackId,
      observedAt,
      worldPositionM: projection.worldPositionM,
      projection: {
        quality: projection.quality,
        confidence: projection.confidence,
        calibrationVersion: spatial.calibration.configVersion,
        method: projection.method,
        anchorMode,
        clamped: projection.clamped === true,
        ...(projection.unverified ? { unverified: true } : {}),
      },
      tracking: { confidence: trackingConfidence },
      activity: activityFrom(raw?.activity),
      visual: visualFrom(raw, spatial.worldPositionM, projection.worldPositionM, { x: scaleX, y: scaleY }),
      ...(identityFrom(raw?.identity) ? { identity: identityFrom(raw.identity) } : {}),
    };
    const validation = validateSpatialObservation(observation);
    if (!validation.ok) {
      rejected.push({ sourceTrackId, reasonCode: "OBSERVATION_INVALID", fields: validation.errors });
      continue;
    }
    accepted.push(observation);
  }

  for (const raw of Array.isArray(payload?.objects) ? payload.objects : []) {
    const sourceObjectId = String(raw?.sourceObjectId ?? "").trim().slice(0, 120);
    const objectType = String(raw?.objectType || "").trim().toUpperCase().replace(/^TV$/, "MONITOR");
    if (!sourceObjectId || !LIVE_OBJECT_TYPES.has(objectType)
      || !finite(raw?.anchorPointPx?.x) || !finite(raw?.anchorPointPx?.y)) continue;
    // One detection is not evidence on this kind of feed: only objects the
    // worker confirmed across repeated scans are published.
    if (!(Number(raw?.confirmations) >= MIN_OBJECT_CONFIRMATIONS)) continue;
    const box = raw?.imageBoxPx;
    const imageBoxPx = [box?.x1, box?.y1, box?.x2, box?.y2].every(finite) && Number(box.x2) > Number(box.x1) && Number(box.y2) > Number(box.y1)
      ? { x1: round(box.x1 * scaleX, 1), y1: round(box.y1 * scaleY, 1), x2: round(box.x2 * scaleX, 1), y2: round(box.y2 * scaleY, 1) }
      : null;
    if (!reliability.ok) continue;
    let estimate;
    try {
      estimate = projectFloorEstimate(spatial.calibration, {
        x: Number(raw.anchorPointPx.x) * scaleX,
        y: Number(raw.anchorPointPx.y) * scaleY,
      }, { roomWidthM: room?.widthM, roomDepthM: room?.depthM, toleranceM: ESTIMATE_TOLERANCE_M });
    } catch {
      continue;
    }
    // A chair's box bottom is its nearest wheel when seen, or the table edge
    // when its base is hidden; its box top is the backrest, ~0.95 m up, seen
    // nearly always. Placed from both (their mean), or from the backrest alone
    // when the base reads outside the room (live: a chair behind the table read
    // behind the far wall from its base, right behind the table from its back).
    let chairMethod = null;
    if (objectType === "CHAIR" && imageBoxPx) {
      try {
        const origin = room?.originM || { x: 0, z: 0 };
        const cameraM = spatial.worldPositionM && {
          x: Number(spatial.worldPositionM.x) - Number(origin.x || 0),
          y: Number(spatial.worldPositionM.y),
          z: Number(spatial.worldPositionM.z) - Number(origin.z || 0),
        };
        const back = cameraM ? projectHeadEstimate(spatial.calibration, { x: (imageBoxPx.x1 + imageBoxPx.x2) / 2, y: imageBoxPx.y1 }, {
          cameraM, headHeightM: CHAIR_BACK_HEIGHT_M, roomWidthM: room?.widthM, roomDepthM: room?.depthM, toleranceM: ESTIMATE_TOLERANCE_M,
        }) : null;
        if (back?.worldPositionM) {
          if (!estimate.worldPositionM || estimate.clamped) {
            estimate = { ...back, clamped: back.clamped === true };
            chairMethod = "CHAIR_BACKREST";
          } else {
            estimate = { ...estimate, worldPositionM: {
              ...estimate.worldPositionM,
              x: (estimate.worldPositionM.x + back.worldPositionM.x) / 2,
              z: (estimate.worldPositionM.z + back.worldPositionM.z) / 2,
            } };
            chairMethod = "CHAIR_BASE_AND_BACKREST";
          }
        }
      } catch {
        // keep the floor estimate
      }
    }
    if (!estimate.worldPositionM) continue;
    const source = typeof raw?.source === "string" && raw.source.trim() && raw.source.trim().length <= 40
      ? raw.source.trim() : "DETECTOR";
    acceptedObjects.push({
      schemaVersion: OBSERVATION_VERSION,
      eventId: crypto.randomUUID(), companyRef: String(companyRef || "grav"),
      siteRef: spatial.calibration.siteRef, cameraRef, sessionRef,
      sourceObjectId, objectType, observedAt, source,
      worldPositionM: estimate.worldPositionM,
      detection: {
        confidence: finite(raw?.confidence) ? Math.max(0, Math.min(1, Number(raw.confidence))) : 0,
        confirmations: Math.min(99, Math.round(Number(raw.confirmations))),
      },
      // Pixels in calibration-image space, so the twin can rest a desk item on
      // a surveyed tabletop instead of the floor estimate below it.
      imageAnchorPx: { x: round(Number(raw.anchorPointPx.x) * scaleX, 1), y: round(Number(raw.anchorPointPx.y) * scaleY, 1) },
      ...(imageBoxPx ? { imageBoxPx } : {}),
      // A bag's colour as the camera sees it (#rrggbb only), for drawing it.
      ...(HEX.test(String(raw?.colour || "")) ? { appearance: { colour: String(raw.colour).toLowerCase() } } : {}),
      projection: {
        quality: "DEGRADED",
        confidence: estimate.confidence,
        calibrationVersion: spatial.calibration.configVersion,
        method: chairMethod || "FLOOR_ESTIMATE",
        clamped: estimate.clamped === true,
      },
    });
  }

  // A detector frame is authoritative for that camera: tracks absent from the
  // latest frame disappear immediately, while a stopped worker is covered by
  // the TTL. This avoids leaving ghost people in the room.
  tracksByCamera.set(cameraRef, new Map(accepted.map((item) => [item.sourceTrackId, item])));
  objectsByCamera.set(cameraRef, new Map(acceptedObjects.map((item) => [item.sourceObjectId, item])));
  if (unpositioned.length) unpositionedByCamera.set(cameraRef, unpositioned); else unpositionedByCamera.delete(cameraRef);
  leasesByCamera.set(cameraRef, { sessionRef, lastMs: nowMs });
  feedsByCamera.set(cameraRef, {
    sessionRef,
    lastFrameMs: nowMs,
    pipeline: pipelineFrom(payload?.pipeline),
    frameSize,
    calibrationReliable: reliability.ok,
  });
  prune(nowMs);
  return { accepted, acceptedObjects, rejected, unpositioned, observedAt };
}

const identityView = (item, includeIdentity) => {
  if (includeIdentity || !item?.identity) return { ...item };
  const { identity, ...anonymous } = item;
  return anonymous;
};

function readFactoryTwinTracks(cameraRef, { nowMs = Date.now(), ttlMs = DEFAULT_TTL_MS, includeIdentity = false } = {}) {
  prune(nowMs, ttlMs);
  const key = cameraKey(cameraRef);
  const observations = key
    ? Array.from(tracksByCamera.get(key)?.values() || [])
    : Array.from(tracksByCamera.values()).flatMap((tracks) => Array.from(tracks.values()));
  return observations.filter((item) => fresh(item, nowMs, ttlMs)).map((item) => identityView(item, includeIdentity));
}

function readFactoryTwinObjects(cameraRef, { nowMs = Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  prune(nowMs, ttlMs);
  const key = cameraKey(cameraRef);
  const objects = key
    ? Array.from(objectsByCamera.get(key)?.values() || [])
    : Array.from(objectsByCamera.values()).flatMap((items) => Array.from(items.values()));
  return objects.filter((item) => fresh(item, nowMs, ttlMs));
}

/** Feed health for one camera, or null when no worker has posted since boot/final. */
function readFactoryTwinFeed(cameraRef, { nowMs = Date.now() } = {}) {
  const feed = feedsByCamera.get(cameraKey(cameraRef));
  if (!feed) return null;
  const ageMs = Math.max(0, nowMs - feed.lastFrameMs);
  return {
    sessionRef: feed.sessionRef,
    lastFrameAt: new Date(feed.lastFrameMs).toISOString(),
    ageMs,
    live: ageMs <= DEFAULT_TTL_MS,
    pipeline: feed.pipeline ? { ...feed.pipeline } : null,
    frameSize: feed.frameSize ? { ...feed.frameSize } : null,
    calibrationReliable: feed.calibrationReliable !== false,
  };
}

function readFactoryTwinUnpositioned(cameraRef, { nowMs = Date.now(), ttlMs = DEFAULT_TTL_MS, includeIdentity = false } = {}) {
  prune(nowMs, ttlMs);
  const key = cameraKey(cameraRef);
  const people = key ? unpositionedByCamera.get(key) || [] : Array.from(unpositionedByCamera.values()).flat();
  return people.filter((item) => fresh(item, nowMs, ttlMs)).map((item) => identityView(item, includeIdentity));
}

function listFactoryTwinFeedCameras() {
  return Array.from(feedsByCamera.keys());
}

/**
 * The snapshot one caller may see. `allowedCameraKeys` null means every camera
 * (platform administrators); otherwise only the listed keys, so a request
 * without cameraRef can never return cameras outside the caller's grants.
 */
function visibleFactoryTwinSnapshot({ cameraRef = "", allowedCameraKeys = null, includeIdentity = false, nowMs = Date.now() } = {}) {
  const requested = cameraKey(cameraRef);
  const allowed = allowedCameraKeys == null ? null : new Set(Array.from(allowedCameraKeys, cameraKey));
  const visible = (key) => allowed == null || allowed.has(key);
  if (requested) {
    if (!visible(requested)) return { observations: [], objects: [], unpositioned: [], feed: null, feeds: {} };
    const feed = readFactoryTwinFeed(requested, { nowMs });
    return {
      observations: readFactoryTwinTracks(requested, { nowMs, includeIdentity }),
      objects: readFactoryTwinObjects(requested, { nowMs }),
      unpositioned: readFactoryTwinUnpositioned(requested, { nowMs, includeIdentity }),
      feed,
      feeds: feed ? { [requested]: feed } : {},
    };
  }
  const feeds = {};
  for (const key of listFactoryTwinFeedCameras()) {
    if (visible(key)) feeds[key] = readFactoryTwinFeed(key, { nowMs });
  }
  return {
    observations: readFactoryTwinTracks("", { nowMs, includeIdentity }).filter((item) => visible(item.cameraRef)),
    objects: readFactoryTwinObjects("", { nowMs }).filter((item) => visible(item.cameraRef)),
    unpositioned: readFactoryTwinUnpositioned("", { nowMs, includeIdentity }).filter((item) => visible(item.cameraRef)),
    feed: null,
    feeds,
  };
}

function clearFactoryTwinTracks() {
  tracksByCamera.clear();
  objectsByCamera.clear();
  unpositionedByCamera.clear();
  leasesByCamera.clear();
  feedsByCamera.clear();
  cachedConfig = null;
  cachedConfigAt = 0;
}

module.exports = {
  DEFAULT_TTL_MS,
  TwinObservationError,
  ingestFactoryTwinTracks,
  readFactoryTwinTracks,
  readFactoryTwinObjects,
  readFactoryTwinFeed,
  readFactoryTwinUnpositioned,
  listFactoryTwinFeedCameras,
  visibleFactoryTwinSnapshot,
  worldYawFromRelative,
  clearFactoryTwinTracks,
};
