// services/cctv/factoryTwinSpatial.service.js
//
// Pure, replayable spatial maths for the factory digital twin. Camera pixels
// become factory-floor metres only through a versioned calibration. No model,
// route or UI is allowed to invent coordinates when this layer cannot resolve
// them.
"use strict";

const CALIBRATION_VERSION = "factory-camera-calibration-v1";
const OBSERVATION_VERSION = "factory-twin-observation-v1";
// Activation gate (contract §5). A calibration whose inverse reprojection RMS or
// forward floor RMS exceeds these limits is refused rather than activated.
const MAX_REPROJECTION_ERROR_PX = 12;
const MAX_FLOOR_ERROR_M = 0.35;
const CALIBRATION_GATE = Object.freeze({ MAX_REPROJECTION_ERROR_PX, MAX_FLOOR_ERROR_M });
const QUALITIES = new Set(["GOOD", "DEGRADED", "UNRESOLVABLE"]);
const ACTIVITIES = new Set([
  "NO_PHONE", "PHONE_VISIBLE", "PHONE_HELD", "NOT_ACTIVE_UNSPECIFIED",
  "ACTIVE_VIEW_OR_TYPE", "ACTIVE_CALL", "ACTIVE_USE_UNSPECIFIED", "UNCERTAIN",
]);

class SpatialContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SpatialContractError";
    this.code = code;
  }
}

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const probability = (value) => finite(value) && value >= 0 && value <= 1;
const text = (value) => typeof value === "string" && value.trim().length > 0;

function point(value, path) {
  if (!value || !finite(value.x) || !finite(value.y)) {
    throw new SpatialContractError("INVALID_POINT", `${path} must contain finite x and y coordinates.`);
  }
  return { x: Number(value.x), y: Number(value.y) };
}

function assertSpread(points, path) {
  let maxDoubleArea = 0;
  for (let i = 0; i < points.length - 2; i += 1) {
    for (let j = i + 1; j < points.length - 1; j += 1) {
      for (let k = j + 1; k < points.length; k += 1) {
        const a = points[i]; const b = points[j]; const c = points[k];
        maxDoubleArea = Math.max(maxDoubleArea, Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)));
      }
    }
  }
  if (maxDoubleArea < 1e-7) throw new SpatialContractError("DEGENERATE_CALIBRATION", `${path} points are collinear.`);
}

function solveLinear(matrix, vector) {
  const n = vector.length;
  const rows = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1)
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    if (Math.abs(rows[pivot][column]) < 1e-10)
      throw new SpatialContractError("DEGENERATE_CALIBRATION", "Control points do not define a stable homography.");
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let c = column; c <= n; c += 1) rows[column][c] /= divisor;
    for (let row = 0; row < n; row += 1) {
      if (row === column) continue;
      const factor = rows[row][column];
      for (let c = column; c <= n; c += 1) rows[row][c] -= factor * rows[column][c];
    }
  }
  return rows.map((row) => row[n]);
}

function leastSquares(rows, values) {
  const columns = rows[0].length;
  const ata = Array.from({ length: columns }, () => Array(columns).fill(0));
  const atb = Array(columns).fill(0);
  for (let r = 0; r < rows.length; r += 1) {
    for (let i = 0; i < columns; i += 1) {
      atb[i] += rows[r][i] * values[r];
      for (let j = 0; j < columns; j += 1) ata[i][j] += rows[r][i] * rows[r][j];
    }
  }
  return solveLinear(ata, atb);
}

/** Return an eight-value homography whose implicit final element is 1. */
function fitHomography(fromPoints, toPoints) {
  if (!Array.isArray(fromPoints) || !Array.isArray(toPoints) || fromPoints.length !== toPoints.length || fromPoints.length < 4)
    throw new SpatialContractError("CONTROL_POINTS_REQUIRED", "At least four paired control points are required.");
  const source = fromPoints.map((value, index) => point(value, `fromPoints[${index}]`));
  const target = toPoints.map((value, index) => point(value, `toPoints[${index}]`));
  assertSpread(source, "Image");
  assertSpread(target, "World");
  const rows = [];
  const values = [];
  for (let i = 0; i < source.length; i += 1) {
    const { x, y } = source[i]; const X = target[i].x; const Y = target[i].y;
    rows.push([x, y, 1, 0, 0, 0, -X * x, -X * y]); values.push(X);
    rows.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]); values.push(Y);
  }
  return leastSquares(rows, values);
}

function transformPoint(h, rawPoint) {
  if (!Array.isArray(h) || h.length !== 8 || !h.every(finite))
    throw new SpatialContractError("INVALID_HOMOGRAPHY", "Homography must contain eight finite values.");
  const p = point(rawPoint, "point");
  const denominator = h[6] * p.x + h[7] * p.y + 1;
  if (Math.abs(denominator) < 1e-10)
    throw new SpatialContractError("UNRESOLVABLE_POINT", "Point projects at infinity.");
  return {
    x: (h[0] * p.x + h[1] * p.y + h[2]) / denominator,
    y: (h[3] * p.x + h[4] * p.y + h[5]) / denominator,
  };
}

function rmsError(h, fromPoints, toPoints) {
  let squared = 0;
  for (let i = 0; i < fromPoints.length; i += 1) {
    const projected = transformPoint(h, fromPoints[i]);
    squared += (projected.x - toPoints[i].x) ** 2 + (projected.y - toPoints[i].y) ** 2;
  }
  return Math.sqrt(squared / fromPoints.length);
}

function pointInPolygon(p, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]; const b = polygon[j];
    const crosses = ((a.y > p.y) !== (b.y > p.y))
      && (p.x < ((b.x - a.x) * (p.y - a.y)) / ((b.y - a.y) || Number.EPSILON) + a.x);
    if (crosses) inside = !inside;
  }
  return inside;
}

// Calibration points are paired by survey meaning, not by clockwise click
// order. Build their convex boundary before containment checks; treating the
// raw array as a polygon can create a self-crossing bow-tie and reject points
// that are visibly in the middle of a valid calibrated floor area.
function convexHull(rawPoints) {
  const points = rawPoints.map((value, index) => point(value, `polygon[${index}]`))
    .sort((a, b) => a.x - b.x || a.y - b.y);
  if (points.length <= 3) return points;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of points) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (const p of [...points].reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

// A homography is only pinned down by four points with no three of them on
// one line, on BOTH the image and the floor. A set like "three marks along one
// wall plus one far corner" fits exactly and still sends every other pixel to
// that wall: the fit is exact because it is degenerate. Measure the best
// four-point subset by its smallest triangle relative to the whole spread.
const MIN_GENERAL_POSITION_RATIO = 0.05;

function triangleArea(a, b, c) {
  return Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
}

function hullArea(points) {
  const hull = convexHull(points);
  let sum = 0;
  for (let i = 0; i < hull.length; i += 1) {
    const a = hull[i]; const b = hull[(i + 1) % hull.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/**
 * { ok, ratio, weakTriple } for one point set. `weakTriple` (1-based indices)
 * is the most nearly collinear triple of the best four-point subset.
 */
function generalPosition(rawPoints) {
  const points = (rawPoints || []).map((p, i) => point(p, `points[${i}]`));
  if (points.length < 4) return { ok: false, ratio: 0, weakTriple: null };
  const spread = hullArea(points);
  if (!(spread > 1e-12)) return { ok: false, ratio: 0, weakTriple: [1, 2, 3] };
  let best = { ratio: -1, weakTriple: null };
  const n = points.length;
  for (let a = 0; a < n - 3; a += 1) for (let b = a + 1; b < n - 2; b += 1)
    for (let c = b + 1; c < n - 1; c += 1) for (let d = c + 1; d < n; d += 1) {
      const quad = [a, b, c, d];
      let worst = { area: Infinity, triple: null };
      for (const [i, j, k] of [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]]) {
        const area = triangleArea(points[quad[i]], points[quad[j]], points[quad[k]]);
        if (area < worst.area) worst = { area, triple: [quad[i] + 1, quad[j] + 1, quad[k] + 1] };
      }
      const ratio = worst.area / spread;
      if (ratio > best.ratio) best = { ratio, weakTriple: worst.triple };
    }
  return { ok: best.ratio >= MIN_GENERAL_POSITION_RATIO, ratio: best.ratio, weakTriple: best.weakTriple };
}

/** Whether a saved calibration can be trusted to map points at all. */
function calibrationReliability(calibration) {
  try {
    const image = generalPosition(calibration?.imageControlPoints || []);
    const world = generalPosition(calibration?.worldControlPointsM || []);
    const weak = !world.ok ? world : !image.ok ? image : null;
    return { ok: image.ok && world.ok, weakTriple: weak?.weakTriple || null, where: !world.ok ? "floor" : !image.ok ? "image" : null };
  } catch {
    return { ok: false, weakTriple: null, where: null };
  }
}

function calibrateCamera(input) {
  if (!input || !text(input.cameraRef) || !text(input.siteRef) || !text(input.modelVersion) || !text(input.configVersion))
    throw new SpatialContractError("CALIBRATION_SCOPE_REQUIRED", "cameraRef, siteRef, modelVersion and configVersion are required.");
  if (!finite(input.imageSize?.width) || !finite(input.imageSize?.height) || input.imageSize.width <= 0 || input.imageSize.height <= 0)
    throw new SpatialContractError("IMAGE_SIZE_REQUIRED", "A positive camera image size is required.");
  const imagePoints = (input.imageControlPoints || []).map((p, i) => point(p, `imageControlPoints[${i}]`));
  const worldPoints = (input.worldControlPointsM || []).map((p, i) => point(p, `worldControlPointsM[${i}]`));
  if (imagePoints.length >= 4 && worldPoints.length === imagePoints.length) {
    for (const [where, set] of [["on the floor", worldPoints], ["in the camera image", imagePoints]]) {
      const check = generalPosition(set);
      if (!check.ok) {
        const which = check.weakTriple ? `Points ${check.weakTriple.join(", ").replace(/, (\d+)$/, " and $1")}` : "The points";
        throw new SpatialContractError("DEGENERATE_CALIBRATION",
          `${which} lie almost on one line ${where}, so the mapping cannot be solved — every other spot would be pushed onto that line. Use at least four points spread across the floor, such as near each corner of the visible floor, with no three in a row.`);
      }
    }
  }
  const homography = fitHomography(imagePoints, worldPoints);
  const inverseHomography = fitHomography(worldPoints, imagePoints);
  const reprojectionErrorPx = rmsError(inverseHomography, worldPoints, imagePoints);
  const worldErrorM = rmsError(homography, imagePoints, worldPoints);
  // Per-pair forward residual in floor metres: which surveyed pair disagrees
  // with the fitted plane. With exactly four pairs the fit is exact and these
  // are ~0, which says nothing about survey quality.
  const floorResidualsM = imagePoints.map((imagePoint, index) => {
    const projected = transformPoint(homography, imagePoint);
    return Math.hypot(projected.x - worldPoints[index].x, projected.y - worldPoints[index].y);
  });
  return {
    schemaVersion: CALIBRATION_VERSION,
    cameraRef: input.cameraRef.trim(), siteRef: input.siteRef.trim(), modelVersion: input.modelVersion.trim(),
    configVersion: input.configVersion.trim(), imageSize: { width: input.imageSize.width, height: input.imageSize.height },
    floorElevationM: finite(input.floorPlane?.elevationM) ? input.floorPlane.elevationM : 0,
    imageControlPoints: imagePoints, worldControlPointsM: worldPoints,
    calibratedImagePolygon: convexHull(imagePoints),
    homography, inverseHomography, reprojectionErrorPx, worldErrorM,
    floorResidualsM,
    // Floor area (x = room width axis, y = room depth axis) where precise
    // homography mapping is supported by surveyed points.
    calibratedFloorPolygonM: convexHull(worldPoints),
    calibrationStatus: "VALID",
  };
}

function projectFootPoint(calibration, imagePoint, { boundaryTolerancePx = 0 } = {}) {
  if (calibration?.schemaVersion !== CALIBRATION_VERSION || calibration?.calibrationStatus !== "VALID")
    return { quality: "UNRESOLVABLE", confidence: 0, insideCalibratedArea: false, worldPositionM: null, reasonCode: "CALIBRATION_NOT_VALID" };
  const p = point(imagePoint, "imagePoint");
  const boundary = convexHull(calibration.imageControlPoints || calibration.calibratedImagePolygon || []);
  const center = boundary.reduce((sum, item) => ({ x: sum.x + item.x / boundary.length, y: sum.y + item.y / boundary.length }), { x: 0, y: 0 });
  const radius = Math.max(1, ...boundary.map((item) => Math.hypot(item.x - center.x, item.y - center.y)));
  const scale = 1 + Math.max(0, Number(boundaryTolerancePx) || 0) / radius;
  const toleratedBoundary = scale > 1
    ? boundary.map((item) => ({ x: center.x + (item.x - center.x) * scale, y: center.y + (item.y - center.y) * scale }))
    : boundary;
  const inside = toleratedBoundary.length >= 3 && pointInPolygon(p, toleratedBoundary);
  if (!inside) return { quality: "UNRESOLVABLE", confidence: 0, insideCalibratedArea: false, worldPositionM: null, reasonCode: "OUTSIDE_CALIBRATED_AREA" };
  const world = transformPoint(calibration.homography, p);
  const error = Number(calibration.reprojectionErrorPx || 0);
  const strictlyInside = boundary.length >= 3 && pointInPolygon(p, boundary);
  const quality = !strictlyInside ? "DEGRADED" : error <= 4 ? "GOOD" : error <= 12 ? "DEGRADED" : "UNRESOLVABLE";
  if (quality === "UNRESOLVABLE") return { quality, confidence: 0, insideCalibratedArea: true, worldPositionM: null, reasonCode: "REPROJECTION_ERROR_HIGH" };
  return {
    quality,
    confidence: Math.max(0.05, Math.min(strictlyInside ? 1 : 0.55, 1 - error / 16)),
    insideCalibratedArea: true,
    worldPositionM: { x: world.x, y: calibration.floorElevationM, z: world.y },
    reasonCode: null,
  };
}

const unresolved = (reasonCode, insideCalibratedArea = false) => ({
  quality: "UNRESOLVABLE", confidence: 0, insideCalibratedArea, worldPositionM: null, clamped: false, reasonCode,
});

/**
 * Floor estimate for the estimate anchor modes (POSE_HIP_ESTIMATE,
 * OCCUPANCY_PROXY). The homography describes the whole floor plane below the
 * horizon, so a point outside the surveyed polygon is still projected through
 * it; the result is never better than DEGRADED, is rejected beyond the horizon
 * or well outside the room, and is otherwise clamped into the room.
 */
function projectFloorEstimate(calibration, imagePoint, { roomWidthM, roomDepthM, toleranceM = 0.75 } = {}) {
  if (calibration?.schemaVersion !== CALIBRATION_VERSION || calibration?.calibrationStatus !== "VALID")
    return unresolved("CALIBRATION_NOT_VALID");
  const width = Number(roomWidthM); const depth = Number(roomDepthM);
  if (!(Number.isFinite(width) && width > 0 && Number.isFinite(depth) && depth > 0))
    return unresolved("ROOM_BOUNDS_REQUIRED");
  const h = calibration.homography;
  if (!Array.isArray(h) || h.length !== 8 || !h.every(finite)) return unresolved("CALIBRATION_NOT_VALID");
  const p = point(imagePoint, "imagePoint");
  const controls = (calibration.imageControlPoints || []).map((value, index) => point(value, `imageControlPoints[${index}]`));
  if (controls.length < 4) return unresolved("CALIBRATION_NOT_VALID");
  const boundary = convexHull(controls);
  const insideCalibratedArea = boundary.length >= 3 && pointInPolygon(p, boundary);

  // The projective denominator changes sign at the image of the horizon line.
  // Every surveyed floor point lies on the floor side; a point whose
  // denominator has the opposite sign (or ~0) is on or above the horizon and
  // has no floor position at all.
  const denominatorOf = (q) => h[6] * q.x + h[7] * q.y + 1;
  const reference = controls.reduce((sum, q) => sum + Math.sign(denominatorOf(q)), 0);
  const denominator = denominatorOf(p);
  if (reference === 0 || Math.abs(denominator) < 1e-9 || Math.sign(denominator) !== Math.sign(reference))
    return unresolved("BEYOND_HORIZON", insideCalibratedArea);

  const x = (h[0] * p.x + h[1] * p.y + h[2]) / denominator;
  const z = (h[3] * p.x + h[4] * p.y + h[5]) / denominator;
  const tolerance = Math.max(0, Number(toleranceM) || 0);
  if (!finite(x) || !finite(z) || x < -tolerance || x > width + tolerance || z < -tolerance || z > depth + tolerance)
    return unresolved("OUTSIDE_ROOM", insideCalibratedArea);
  const clampedX = Math.max(0, Math.min(width, x));
  const clampedZ = Math.max(0, Math.min(depth, z));
  const error = Number(calibration.reprojectionErrorPx || 0);
  const cap = insideCalibratedArea ? 0.5 : 0.35;
  return {
    quality: "DEGRADED",
    confidence: Math.max(0.05, Math.min(cap, 1 - error / 16)),
    insideCalibratedArea,
    worldPositionM: { x: clampedX, y: finite(calibration.floorElevationM) ? calibration.floorElevationM : 0, z: clampedZ },
    // Ignore float noise on the room edge; report a real move into the room.
    clamped: Math.abs(clampedX - x) > 1e-6 || Math.abs(clampedZ - z) > 1e-6,
    reasonCode: null,
  };
}

/**
 * Floor position of someone whose lower body is out of the picture or hidden,
 * from where their head is. The camera ray through the head pixel meets the
 * floor (through the same homography) at F, beyond the person; the head is on
 * that ray at `headHeightM` above the floor, so the person stands or sits at
 * C0 + (F - C0) * (H - h) / H, where C0 is the point on the floor below the
 * camera and H its height. Needs the camera's position in room coordinates.
 * Always DEGRADED (the head height is assumed from posture), refused beyond the
 * horizon or well outside the room, otherwise clamped into it.
 */
function projectHeadEstimate(calibration, imagePoint, { cameraM, headHeightM, roomWidthM, roomDepthM, toleranceM = 0.75 } = {}) {
  if (calibration?.schemaVersion !== CALIBRATION_VERSION || calibration?.calibrationStatus !== "VALID")
    return unresolved("CALIBRATION_NOT_VALID");
  const width = Number(roomWidthM); const depth = Number(roomDepthM);
  if (!(Number.isFinite(width) && width > 0 && Number.isFinite(depth) && depth > 0))
    return unresolved("ROOM_BOUNDS_REQUIRED");
  const H = Number(cameraM?.y); const h = Number(headHeightM);
  if (!finite(cameraM?.x) || !finite(cameraM?.z) || !Number.isFinite(H) || !Number.isFinite(h) || !(H > h + 0.3))
    return unresolved("CAMERA_POSITION_REQUIRED");
  const hm = calibration.homography;
  if (!Array.isArray(hm) || hm.length !== 8 || !hm.every(finite)) return unresolved("CALIBRATION_NOT_VALID");
  const p = point(imagePoint, "imagePoint");
  const controls = (calibration.imageControlPoints || []).map((value, index) => point(value, `imageControlPoints[${index}]`));
  if (controls.length < 4) return unresolved("CALIBRATION_NOT_VALID");
  const denominatorOf = (q) => hm[6] * q.x + hm[7] * q.y + 1;
  const reference = controls.reduce((sum, q) => sum + Math.sign(denominatorOf(q)), 0);
  const denominator = denominatorOf(p);
  if (reference === 0 || Math.abs(denominator) < 1e-9 || Math.sign(denominator) !== Math.sign(reference))
    return unresolved("BEYOND_HORIZON");
  const fx = (hm[0] * p.x + hm[1] * p.y + hm[2]) / denominator;
  const fz = (hm[3] * p.x + hm[4] * p.y + hm[5]) / denominator;
  const k = (H - h) / H;
  const x = cameraM.x + (fx - cameraM.x) * k;
  const z = cameraM.z + (fz - cameraM.z) * k;
  const tolerance = Math.max(0, Number(toleranceM) || 0);
  if (!finite(x) || !finite(z) || x < -tolerance || x > width + tolerance || z < -tolerance || z > depth + tolerance)
    return unresolved("OUTSIDE_ROOM");
  const clampedX = Math.max(0, Math.min(width, x));
  const clampedZ = Math.max(0, Math.min(depth, z));
  return {
    quality: "DEGRADED",
    confidence: 0.35,
    insideCalibratedArea: false,
    worldPositionM: { x: clampedX, y: finite(calibration.floorElevationM) ? calibration.floorElevationM : 0, z: clampedZ },
    clamped: Math.abs(clampedX - x) > 1e-6 || Math.abs(clampedZ - z) > 1e-6,
    reasonCode: null,
  };
}

/**
 * Height above the floor of the body point seen at `imagePoint`, for a person
 * standing at floor point `pointM` (room metres): the camera ray through the
 * pixel, read where it passes over that floor point. Null when the camera or
 * the pixel cannot be used. Used to test feet against hips: a standing
 * person's hips are ~0.9 m up, so feet that put them at 0.6 m are a guess.
 */
function heightAbovePoint(calibration, imagePoint, { cameraM, pointM } = {}) {
  const hm = calibration?.homography;
  const H = Number(cameraM?.y);
  if (!Array.isArray(hm) || hm.length !== 8 || !hm.every(finite) || !Number.isFinite(H)
    || !finite(cameraM?.x) || !finite(cameraM?.z) || !finite(pointM?.x) || !finite(pointM?.z)) return null;
  const p = point(imagePoint, "imagePoint");
  const denominator = hm[6] * p.x + hm[7] * p.y + 1;
  if (Math.abs(denominator) < 1e-9) return null;
  const fx = (hm[0] * p.x + hm[1] * p.y + hm[2]) / denominator - cameraM.x;
  const fz = (hm[3] * p.x + hm[4] * p.y + hm[5]) / denominator - cameraM.z;
  const length2 = fx * fx + fz * fz;
  if (!(length2 > 1e-9)) return null;
  const s = ((pointM.x - cameraM.x) * fx + (pointM.z - cameraM.z) * fz) / length2;
  return H * (1 - s);
}

function validateSpatialObservation(value) {
  const errors = [];
  if (value?.schemaVersion !== OBSERVATION_VERSION) errors.push("schemaVersion");
  for (const key of ["eventId", "companyRef", "siteRef", "cameraRef", "sessionRef", "sourceTrackId"])
    if (!text(value?.[key])) errors.push(key);
  if (!Number.isFinite(Date.parse(value?.observedAt || ""))) errors.push("observedAt");
  if (![value?.worldPositionM?.x, value?.worldPositionM?.y, value?.worldPositionM?.z].every(finite)) errors.push("worldPositionM");
  if (!QUALITIES.has(value?.projection?.quality)) errors.push("projection.quality");
  if (!probability(value?.projection?.confidence)) errors.push("projection.confidence");
  if (!text(value?.projection?.calibrationVersion)) errors.push("projection.calibrationVersion");
  if (!probability(value?.tracking?.confidence)) errors.push("tracking.confidence");
  if (!ACTIVITIES.has(value?.activity?.label)) errors.push("activity.label");
  if (!probability(value?.activity?.confidence)) errors.push("activity.confidence");
  return { ok: errors.length === 0, errors };
}

module.exports = {
  CALIBRATION_VERSION,
  OBSERVATION_VERSION,
  MAX_REPROJECTION_ERROR_PX,
  MAX_FLOOR_ERROR_M,
  CALIBRATION_GATE,
  ACTIVITIES,
  SpatialContractError,
  fitHomography,
  transformPoint,
  calibrateCamera,
  calibrationReliability,
  generalPosition,
  projectFootPoint,
  projectFloorEstimate,
  projectHeadEstimate,
  heightAbovePoint,
  validateSpatialObservation,
};

