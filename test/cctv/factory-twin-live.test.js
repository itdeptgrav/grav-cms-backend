"use strict";

process.env.TEST_WITHOUT_MONGO = "1";

jest.mock("../../services/cctv/factoryTwinConfig.service", () => ({
  readFactoryTwinConfig: jest.fn(),
}));

const { readFactoryTwinConfig } = require("../../services/cctv/factoryTwinConfig.service");
const { calibrateCamera } = require("../../services/cctv/factoryTwinSpatial.service");
const {
  DEFAULT_TTL_MS, ingestFactoryTwinTracks, readFactoryTwinTracks, readFactoryTwinObjects, readFactoryTwinFeed,
  visibleFactoryTwinSnapshot, worldYawFromRelative, clearFactoryTwinTracks,
} = require("../../services/cctv/factoryTwinLive.service");

const calibration = calibrateCamera({
  cameraRef: "nvr1:11", siteRef: "grav-factory", modelVersion: "layout-v1", configVersion: "camera-v1",
  imageSize: { width: 1000, height: 800 },
  imageControlPoints: [{ x: 100, y: 100 }, { x: 900, y: 100 }, { x: 100, y: 700 }, { x: 900, y: 700 }],
  worldControlPointsM: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 0, y: 4 }, { x: 3, y: 4 }],
});

// A perspective view of the same 3 x 4 m floor: the far edge is narrower and
// higher in the image, and the horizon sits at image y = 100.
const perspective = calibrateCamera({
  cameraRef: "nvr1:12", siteRef: "grav-factory", modelVersion: "layout-v1", configVersion: "camera12-v1",
  imageSize: { width: 1000, height: 800 },
  imageControlPoints: [{ x: 100, y: 700 }, { x: 900, y: 700 }, { x: 600, y: 250 }, { x: 400, y: 250 }],
  worldControlPointsM: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 4 }, { x: 0, y: 4 }],
});

// Same view as nvr1:11, but mapped only over the middle of the room (like a
// room alignment whose points stop short of the frame edges).
const inner = calibrateCamera({
  cameraRef: "nvr1:14", siteRef: "grav-factory", modelVersion: "layout-v1", configVersion: "camera14-v1",
  imageSize: { width: 1000, height: 800 },
  imageControlPoints: [{ x: 100 + 800 * 0.5 / 3, y: 100 + 600 * 0.5 / 4 }, { x: 100 + 800 * 2.5 / 3, y: 100 + 600 * 0.5 / 4 },
    { x: 100 + 800 * 0.5 / 3, y: 100 + 600 * 3.5 / 4 }, { x: 100 + 800 * 2.5 / 3, y: 100 + 600 * 3.5 / 4 }],
  worldControlPointsM: [{ x: 0.5, y: 0.5 }, { x: 2.5, y: 0.5 }, { x: 0.5, y: 3.5 }, { x: 2.5, y: 3.5 }],
});

beforeEach(() => {
  clearFactoryTwinTracks();
  readFactoryTwinConfig.mockResolvedValue({
    layout: { rooms: [{ id: "conference-room", widthM: 3, depthM: 4 }] },
    cameras: {
      "nvr1:11": { status: "CALIBRATED", roomId: "conference-room", calibration, worldPositionM: { x: 1.5, y: 2.7, z: -3 } },
      "nvr1:12": { status: "CALIBRATED", roomId: "conference-room", calibration: perspective, worldPositionM: { x: 1.5, y: 2.7, z: -1 } },
      "nvr1:14": { status: "CALIBRATED", roomId: "conference-room", calibration: inner, worldPositionM: { x: 1.5, y: 2.7, z: -3 } },
    },
  });
});

const NOW = new Date("2026-10-14T10:00:00.000Z");
const at = (offsetMs) => new Date(NOW.getTime() + offsetMs);
const frame = (track, extra = {}, now = NOW) => ingestFactoryTwinTracks({
  cameraRef: "nvr1:11", observedAt: now.toISOString(), frameSize: { width: 1000, height: 800 },
  tracks: [{ sourceTrackId: "p1", footPointPx: { x: 500, y: 400 }, trackingConfidence: 0.9, ...track }],
  ...extra,
}, { now });

test("projects anonymous foot points and expires stale tracks", async () => {
  const now = new Date("2026-10-14T10:00:00.000Z");
  const result = await ingestFactoryTwinTracks({
    cameraRef: "NVR1:11", observedAt: now.toISOString(), sessionRef: "worker-1",
    frameSize: { width: 500, height: 400 },
    tracks: [{ sourceTrackId: 5, footPointPx: { x: 250, y: 200 }, trackingConfidence: 0.91 }],
  }, { now });
  expect(result.accepted).toHaveLength(1);
  expect(result.accepted[0].sourceTrackId).toBe("5");
  expect(result.accepted[0].worldPositionM.x).toBeCloseTo(1.5);
  expect(result.accepted[0].worldPositionM.z).toBeCloseTo(2);
  expect(readFactoryTwinTracks("nvr1:11", { nowMs: now.getTime() + 1000 })).toHaveLength(1);
  expect(readFactoryTwinTracks("nvr1:11", { nowMs: now.getTime() + 5000 })).toHaveLength(0);
});

test("feet seen beyond the room's edge are refused, not pulled in", async () => {
  const now = new Date("2026-10-14T10:00:00.000Z");
  const result = await ingestFactoryTwinTracks({
    cameraRef: "nvr1:11", observedAt: now.toISOString(),
    tracks: [{ sourceTrackId: "outside", footPointPx: { x: 20, y: 20 }, trackingConfidence: 0.8 }],
  }, { now });
  expect(result.accepted).toHaveLength(0);
  expect(result.rejected[0].reasonCode).toBe("OUTSIDE_ROOM");
  // The same pixel as a hidden-feet guess may be up to 0.75 m out: kept, clamped.
  const guess = await ingestFactoryTwinTracks({
    cameraRef: "nvr1:11", observedAt: now.toISOString(),
    tracks: [{ sourceTrackId: "guess", footPointPx: { x: 20, y: 20 }, trackingConfidence: 0.8, anchorMode: "OCCUPANCY_PROXY" }],
  }, { now });
  expect(guess.accepted[0].projection).toMatchObject({ quality: "DEGRADED", method: "FLOOR_ESTIMATE", clamped: true });
});

test("marks an explicitly requested seated-person proxy as degraded", async () => {
  const now = new Date("2026-10-14T10:00:00.000Z");
  const result = await ingestFactoryTwinTracks({
    cameraRef: "nvr1:11", observedAt: now.toISOString(), frameSize: { width: 1000, height: 800 },
    tracks: [{ sourceTrackId: "seated", footPointPx: { x: 980, y: 780 }, trackingConfidence: 0.8, anchorMode: "OCCUPANCY_PROXY" }],
  }, { now });
  expect(result.accepted).toHaveLength(1);
  expect(result.accepted[0].projection).toMatchObject({
    quality: "DEGRADED", method: "FLOOR_ESTIMATE", anchorMode: "OCCUPANCY_PROXY", clamped: true,
  });
  expect(result.accepted[0].worldPositionM).toMatchObject({ x: 3, z: 4 });
  expect(result.accepted[0].projection.confidence).toBeLessThanOrEqual(0.35);
});

test("publishes common room objects separately from people", async () => {
  const now = new Date("2026-10-14T10:00:00.000Z");
  const result = await ingestFactoryTwinTracks({
    cameraRef: "nvr1:11", observedAt: now.toISOString(), frameSize: { width: 1000, height: 800 },
    tracks: [],
    objects: [{ sourceObjectId: "laptop-7", objectType: "LAPTOP", anchorPointPx: { x: 500, y: 420 }, confidence: 0.84, confirmations: 3 }],
  }, { now });
  expect(result.accepted).toHaveLength(0);
  expect(result.acceptedObjects).toHaveLength(1);
  expect(readFactoryTwinObjects("nvr1:11", { nowMs: now.getTime() + 1000 })[0])
    .toMatchObject({ sourceObjectId: "laptop-7", objectType: "LAPTOP" });
});

test("a bag carries the colour the camera sees, and only a colour", async () => {
  const now = new Date("2026-10-14T10:00:00.000Z");
  const result = await ingestFactoryTwinTracks({
    cameraRef: "nvr1:11", observedAt: now.toISOString(), frameSize: { width: 1000, height: 800 }, tracks: [],
    objects: [
      { sourceObjectId: "bag-1", objectType: "BACKPACK", anchorPointPx: { x: 500, y: 420 }, confidence: 0.7, confirmations: 3, colour: "#2E6F9A" },
      { sourceObjectId: "bag-2", objectType: "BACKPACK", anchorPointPx: { x: 520, y: 420 }, confidence: 0.7, confirmations: 3, colour: "url(x)" },
    ],
  }, { now });
  expect(result.acceptedObjects[0].appearance).toEqual({ colour: "#2e6f9a" });
  expect(result.acceptedObjects[1].appearance).toBeUndefined();
});

test("a chair is placed from its backrest as well as its base; from the backrest alone when its base reads outside", async () => {
  // Fixture camera: x 1.5, 2.7 m up, z -3; floor z = (y - 100) / 150. A point
  // 0.95 m up seen at floor z F lies at -3 + (F + 3) * (1.75 / 2.7).
  const now = new Date("2026-10-14T10:00:00.000Z");
  const chair = (id, y1, y2) => ({ sourceObjectId: id, objectType: "CHAIR", anchorPointPx: { x: 500, y: y2 }, imageBoxPx: { x1: 450, y1, x2: 550, y2 }, confidence: 0.8, confirmations: 3 });
  const result = await ingestFactoryTwinTracks({
    cameraRef: "nvr1:11", observedAt: now.toISOString(), frameSize: { width: 1000, height: 800 }, tracks: [],
    objects: [chair("both", 450, 500), chair("hidden-base", 600, 750)],
  }, { now });
  const byId = Object.fromEntries(result.acceptedObjects.map((o) => [o.sourceObjectId, o]));
  const back = (y) => -3 + ((y - 100) / 150 + 3) * (1.75 / 2.7);
  expect(byId.both.projection.method).toBe("CHAIR_BASE_AND_BACKREST");
  expect(byId.both.worldPositionM.z).toBeCloseTo((2.667 + back(450)) / 2, 2);
  expect(byId["hidden-base"].projection).toMatchObject({ method: "CHAIR_BACKREST", clamped: false });
  expect(byId["hidden-base"].worldPositionM.z).toBeCloseTo(back(600), 2);
});

test("rejects an uncalibrated camera", async () => {
  readFactoryTwinConfig.mockResolvedValue({ cameras: { "nvr1:11": { status: "PROVISIONAL" } } });
  await expect(ingestFactoryTwinTracks({ cameraRef: "nvr1:11", tracks: [] }))
    .rejects.toMatchObject({ code: "CAMERA_NOT_CALIBRATED", status: 409 });
});

describe("posture is evidence, not room-type metadata", () => {
  test("the old worker's hard-coded SEATED is still accepted but published as UNKNOWN", async () => {
    const result = await frame({ posture: "SEATED", anchorMode: "OCCUPANCY_PROXY" });
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].visual).toMatchObject({ posture: "UNKNOWN", postureSource: "NONE", postureConfidence: 0 });
  });

  test("confident pose evidence publishes the posture", async () => {
    const result = await frame({ posture: "SEATED", postureSource: "POSE", postureConfidence: 0.8, keypointVisibility: 0.7 });
    expect(result.accepted[0].visual).toMatchObject({
      posture: "SEATED", postureSource: "POSE", postureConfidence: 0.8, keypointVisibility: 0.7,
    });
  });

  test("weak pose evidence stays UNKNOWN", async () => {
    const result = await frame({ posture: "STANDING", postureSource: "POSE", postureConfidence: 0.3 });
    expect(result.accepted[0].visual).toMatchObject({ posture: "UNKNOWN", postureSource: "POSE", postureConfidence: 0.3 });
  });

  test("an unknown posture string stays UNKNOWN", async () => {
    const result = await frame({ posture: "LYING", postureSource: "POSE", postureConfidence: 0.95 });
    expect(result.accepted[0].visual.posture).toBe("UNKNOWN");
    expect(result.accepted[0].visual.keypointVisibility).toBeNull();
  });
});

describe("orientation", () => {
  test("camera-relative yaw becomes a world yaw", () => {
    const camera = { x: 0, y: 0, z: 0 }; const person = { x: 0, y: 0, z: 5 };
    expect(worldYawFromRelative(0, camera, person)).toBe(180);
    expect(worldYawFromRelative(90, camera, person)).toBe(-90);
    expect(worldYawFromRelative(180, camera, person)).toBeCloseTo(0, 6);
    expect(worldYawFromRelative(10, camera, { x: 0, y: 0, z: 0 })).toBeNull();
  });

  test("world yaw is published only above the confidence gate", async () => {
    // Camera nvr1:11 sits at (1.5, -3); the person maps to (1.5, 2): straight ahead.
    const confident = await frame({ orientation: { relativeYawDeg: 0, confidence: 0.6 } });
    expect(confident.accepted[0].visual).toMatchObject({ orientationDeg: 180, orientationConfidence: 0.6 });
    const weak = await frame({ orientation: { relativeYawDeg: 0, confidence: 0.3 } });
    expect(weak.accepted[0].visual).toMatchObject({ orientationDeg: null, orientationConfidence: 0 });
  });
});

describe("anchor modes decide position quality", () => {
  test("a hip estimate inside the calibrated polygon is capped at DEGRADED", async () => {
    const result = await frame({ anchorMode: "POSE_HIP_ESTIMATE" });
    expect(result.accepted[0].projection).toMatchObject({
      quality: "DEGRADED", method: "FLOOR_HOMOGRAPHY", anchorMode: "POSE_HIP_ESTIMATE", clamped: false,
    });
    expect(result.accepted[0].projection.confidence).toBeLessThanOrEqual(0.5);
  });

  test("ankles inside the polygon keep GOOD quality; outside it but in the room become a bounded estimate", async () => {
    const inside = await frame({ anchorMode: "POSE_ANKLES" });
    expect(inside.accepted[0].projection).toMatchObject({ quality: "GOOD", method: "FLOOR_HOMOGRAPHY", anchorMode: "POSE_ANKLES" });
    // Feet at floor (0.2, 2.0): inside the room, outside nvr1:14's mapping polygon.
    const edge = await ingestFactoryTwinTracks({ cameraRef: "nvr1:14", observedAt: NOW.toISOString(), frameSize: { width: 1000, height: 800 },
      tracks: [{ sourceTrackId: "edge", footPointPx: { x: 100 + 800 * 0.2 / 3, y: 100 + 600 * 2.0 / 4 }, trackingConfidence: 0.9, anchorMode: "POSE_ANKLES" }] }, { now: NOW });
    const found = edge.accepted[0].projection;
    expect(found).toMatchObject({ quality: "DEGRADED", method: "FLOOR_ESTIMATE", anchorMode: "POSE_ANKLES", clamped: false });
    expect(found.confidence).toBeLessThanOrEqual(0.35);
    expect(edge.accepted[0].worldPositionM.x).toBeCloseTo(0.2, 3);
    const farAway = await frame({ anchorMode: "POSE_ANKLES", footPointPx: { x: 5000, y: 400 } });
    expect(farAway.accepted).toHaveLength(0);
  });

  test("a head estimate is placed from the camera's height, never better than DEGRADED", async () => {
    const result = await frame({ anchorMode: "POSE_HEAD_ESTIMATE", posture: "SEATED", footPointPx: { x: 500, y: 300 } });
    expect(result.rejected).toHaveLength(0);
    expect(result.accepted[0].projection).toMatchObject({ quality: "DEGRADED", method: "HEAD_HEIGHT_ESTIMATE", anchorMode: "POSE_HEAD_ESTIMATE" });
    expect(result.accepted[0].projection.confidence).toBeLessThanOrEqual(0.35);
  });

  test("hips seen with legs hidden are placed from the camera's height at seated hip height", async () => {
    const result = await frame({ anchorMode: "POSE_HIP_HEIGHT", footPointPx: { x: 500, y: 300 } });
    expect(result.accepted[0].projection).toMatchObject({ quality: "DEGRADED", method: "HIP_HEIGHT_ESTIMATE", anchorMode: "POSE_HIP_HEIGHT" });
    const floor = await frame({ anchorMode: "OCCUPANCY_PROXY", footPointPx: { x: 500, y: 300 } });
    // The same pixel read as hips 0.5 m up lies nearer the camera than read as a floor point.
    const toCamera = (p) => Math.hypot(p.x - 1.5, p.z + 3);
    expect(toCamera(result.accepted[0].worldPositionM)).toBeLessThan(toCamera(floor.accepted[0].worldPositionM) - 0.2);
  });

  test("someone cut off by the frame bottom is placed from the top of their box at crown height", async () => {
    const crown = await frame({ anchorMode: "BOX_TOP_HEIGHT", footPointPx: { x: 500, y: 600 } });
    expect(crown.accepted[0].projection).toMatchObject({ quality: "DEGRADED", method: "CROWN_HEIGHT_ESTIMATE", anchorMode: "BOX_TOP_HEIGHT" });
    const shoulders = await frame({ anchorMode: "POSE_SHOULDER_HEIGHT", footPointPx: { x: 500, y: 600 } });
    // Read as a crown 1.3 m up, the same pixel lies nearer the camera than as shoulders 1.0 m up.
    const toCamera = (p) => Math.hypot(p.x - 1.5, p.z + 3);
    expect(toCamera(crown.accepted[0].worldPositionM)).toBeLessThan(toCamera(shoulders.accepted[0].worldPositionM));
  });

  test("a posture hint passes through only while the posture is unknown", async () => {
    const lean = await frame({ postureHint: { posture: "STANDING", confidence: 0.65 } });
    expect(lean.accepted[0].visual.postureHint).toEqual({ posture: "STANDING", confidence: 0.65 });
    const weak = await frame({ postureHint: { posture: "STANDING", confidence: 0.2 } });
    expect(weak.accepted[0].visual.postureHint).toBeNull();
    const confirmed = await frame({ posture: "SEATED", postureConfidence: 0.9, postureSource: "POSE", postureHint: { posture: "STANDING", confidence: 0.7 } });
    expect(confirmed.accepted[0].visual).toMatchObject({ posture: "SEATED", postureHint: null });
  });

  test("the raw detector output rides along for the dev view, scores below the evidence floor included", async () => {
    const raw = await frame({
      imageBoxPx: { x1: 400, y1: 200, x2: 520, y2: 580 }, trackingConfidence: 0.71, posture: "SEATED", postureConfidence: 0.42,
      postureSource: "POSE", interactions: [{ kind: "PHONE_IN_HAND", confidence: 0.44 }, { kind: "SECRET", confidence: 0.9 }],
    });
    const d = raw.accepted[0].visual.detector;
    expect(d).toMatchObject({ trackingConfidence: 0.71, posture: "SEATED", postureConfidence: 0.42, scores: [{ kind: "PHONE_IN_HAND", confidence: 0.44 }] });
    expect(d.boxPx.x2).toBeGreaterThan(d.boxPx.x1);
    expect(raw.accepted[0].visual.interactions).toEqual([]);
    const bad = await frame({ imageBoxPx: { x1: 500, y1: 200, x2: 400, y2: 580 } });
    expect(bad.accepted[0].visual.detector.boxPx).toBeNull();
  });

  test("feet that put a standing person's hips too low are a guess: the hips place them", async () => {
    // Fixture camera: x 1.5, 2.7 m up, z -3; image y = 100 + 150 z on the floor.
    const hipsAt = (y) => Array.from({ length: 17 }, (_, i) => (i === 11 || i === 12 ? [500, y, 0.9] : [0, 0, 0]));
    const standing = { anchorMode: "POSE_ANKLES", footPointPx: { x: 500, y: 600 }, posture: "STANDING", postureConfidence: 0.9, postureSource: "POSE" };
    // Hips 0.6 m over the reported feet (z 3.33): impossible standing.
    const guessed = await frame({ ...standing, pose2d: { keypoints: hipsAt(871) } });
    expect(guessed.accepted[0].projection).toMatchObject({ anchorMode: "POSE_HIP_HEIGHT", method: "HIP_HEIGHT_ESTIMATE" });
    expect(guessed.accepted[0].worldPositionM.z).toBeCloseTo(-3 + 8.14 * (1.75 / 2.7), 1);
    // Hips 0.95 m over them: the feet stand.
    const real = await frame({ ...standing, pose2d: { keypoints: hipsAt(1115.7) } });
    expect(real.accepted[0].projection.anchorMode).toBe("POSE_ANKLES");
    expect(real.accepted[0].worldPositionM.z).toBeCloseTo(3.333, 2);
    // Same low hips, but seated: left alone (a seated person's hips are low).
    const seated = await frame({ ...standing, posture: "SEATED", pose2d: { keypoints: hipsAt(871) } });
    expect(seated.accepted[0].projection.anchorMode).toBe("POSE_ANKLES");
  });

  test("clothing colour is kept as a colour only; anything else is dropped", async () => {
    const ok = await frame({ appearance: { shirt: "#DC2828", trousers: "#1e325a", crop: "data:image/jpeg;base64,AAAA" } });
    expect(ok.accepted[0].visual.appearance).toEqual({ shirt: "#dc2828", trousers: "#1e325a" });
    const bad = await frame({ appearance: { shirt: "red" } });
    expect(bad.accepted[0].visual.appearance).toBeNull();
  });

  test("an estimate far outside the room is refused", async () => {
    const result = await frame({ anchorMode: "OCCUPANCY_PROXY", footPointPx: { x: 5000, y: 400 } });
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reasonCode).toBe("OUTSIDE_ROOM");
  });

  test("an estimate beyond the horizon is refused", async () => {
    const result = await ingestFactoryTwinTracks({
      cameraRef: "nvr1:12", observedAt: NOW.toISOString(), frameSize: { width: 1000, height: 800 },
      tracks: [{ sourceTrackId: "sky", footPointPx: { x: 500, y: 50 }, anchorMode: "OCCUPANCY_PROXY" }],
    }, { now: NOW });
    expect(result.rejected[0].reasonCode).toBe("BEYOND_HORIZON");
  });
});

describe("one feed per camera", () => {
  test("a second session is refused while the holder is live, and may take over after the TTL", async () => {
    await frame({}, { sessionRef: "worker-a" }, at(0));
    await expect(frame({}, { sessionRef: "worker-b" }, at(1_000)))
      .rejects.toMatchObject({ code: "FEED_SESSION_CONFLICT", status: 409 });
    expect(readFactoryTwinTracks("nvr1:11", { nowMs: at(1_000).getTime() })[0].sessionRef).toBe("worker-a");
    const takeover = await frame({}, { sessionRef: "worker-b" }, at(DEFAULT_TTL_MS + 500));
    expect(takeover.accepted).toHaveLength(1);
    await expect(frame({}, { sessionRef: "worker-a" }, at(DEFAULT_TTL_MS + 1_000)))
      .rejects.toMatchObject({ code: "FEED_SESSION_CONFLICT" });
  });

  test("a final frame releases the lease and clears the camera; a non-holder's final is refused", async () => {
    await frame({}, { sessionRef: "worker-a", pipeline: { fps: 1 } }, at(0));
    await expect(ingestFactoryTwinTracks({ cameraRef: "nvr1:11", sessionRef: "worker-b", tracks: [], final: true }, { now: at(500) }))
      .rejects.toMatchObject({ code: "FEED_SESSION_CONFLICT" });
    const released = await ingestFactoryTwinTracks({ cameraRef: "nvr1:11", sessionRef: "worker-a", tracks: [], final: true }, { now: at(1_000) });
    expect(released.released).toBe(true);
    expect(readFactoryTwinTracks("nvr1:11", { nowMs: at(1_000).getTime() })).toHaveLength(0);
    expect(readFactoryTwinFeed("nvr1:11", { nowMs: at(1_000).getTime() })).toBeNull();
    const next = await frame({}, { sessionRef: "worker-b" }, at(1_500));
    expect(next.accepted).toHaveLength(1);
  });

  test("pipeline health is whitelisted and returned with the frame age", async () => {
    await frame({}, {
      sessionRef: "worker-a",
      pipeline: {
        personModel: "yolov8m.pt", poseModel: 7, worldModel: "x".repeat(200), tracker: "cctv_twin_botsort.yaml",
        identityModel: "buffalo_l", poseEnabled: true, peopleOnly: "no", identityEnabled: true,
        detectMs: 41.27, poseMs: -3, identityMs: 82.44, fps: 1.26, apiKey: "secret", nested: { a: 1 },
      },
    }, at(0));
    const feed = readFactoryTwinFeed("NVR1:11", { nowMs: at(1_500).getTime() });
    expect(feed).toMatchObject({
      sessionRef: "worker-a", ageMs: 1_500, live: true, frameSize: { width: 1000, height: 800 },
      lastFrameAt: NOW.toISOString(),
    });
    expect(feed.pipeline).toEqual({
      personModel: "yolov8m.pt", worldModel: "x".repeat(80), tracker: "cctv_twin_botsort.yaml",
      identityModel: "buffalo_l", poseEnabled: true, identityEnabled: true,
      detectMs: 41.3, identityMs: 82.4, fps: 1.3,
    });
    expect(readFactoryTwinFeed("nvr1:11", { nowMs: at(DEFAULT_TTL_MS + 1).getTime() }).live).toBe(false);
    expect(readFactoryTwinFeed("nvr9:1")).toBeNull();
  });
});

test("objects are degraded floor estimates and carry their source", async () => {
  const result = await ingestFactoryTwinTracks({
    cameraRef: "nvr1:11", observedAt: NOW.toISOString(), frameSize: { width: 1000, height: 800 }, tracks: [],
    objects: [
      { sourceObjectId: "cup-1", objectType: "CUP", anchorPointPx: { x: 500, y: 400 }, confidence: 0.5, source: "YOLO_WORLD", confirmations: 3 },
      { sourceObjectId: "far", objectType: "CUP", anchorPointPx: { x: 5000, y: 400 }, confirmations: 3 },
      { sourceObjectId: "gun", objectType: "WEAPON", anchorPointPx: { x: 500, y: 400 } },
    ],
  }, { now: NOW });
  expect(result.acceptedObjects).toHaveLength(1);
  expect(result.acceptedObjects[0]).toMatchObject({
    source: "YOLO_WORLD", projection: { quality: "DEGRADED", method: "FLOOR_ESTIMATE" },
  });
});

test("a snapshot without cameraRef shows a non-administrator only granted cameras", async () => {
  await frame({}, { sessionRef: "worker-11" });
  await ingestFactoryTwinTracks({
    cameraRef: "nvr1:12", sessionRef: "worker-12", observedAt: NOW.toISOString(), frameSize: { width: 1000, height: 800 },
    tracks: [{ sourceTrackId: "q1", footPointPx: { x: 500, y: 500 }, anchorMode: "BOX_BOTTOM" }],
  }, { now: NOW });
  const nowMs = at(500).getTime();
  const everyone = visibleFactoryTwinSnapshot({ nowMs });
  expect(everyone.observations.map((item) => item.cameraRef).sort()).toEqual(["nvr1:11", "nvr1:12"]);
  expect(Object.keys(everyone.feeds).sort()).toEqual(["nvr1:11", "nvr1:12"]);
  expect(everyone.feed).toBeNull();
  const granted = visibleFactoryTwinSnapshot({ allowedCameraKeys: ["NVR1:11"], nowMs });
  expect(granted.observations.map((item) => item.cameraRef)).toEqual(["nvr1:11"]);
  expect(Object.keys(granted.feeds)).toEqual(["nvr1:11"]);
  const none = visibleFactoryTwinSnapshot({ allowedCameraKeys: [], nowMs });
  expect(none).toEqual({ observations: [], objects: [], unpositioned: [], feed: null, feeds: {} });
  const one = visibleFactoryTwinSnapshot({ cameraRef: "nvr1:12", nowMs });
  expect(one.feed).toMatchObject({ sessionRef: "worker-12", live: true });
  expect(one.observations).toHaveLength(1);
});

test("positions from an unverified room alignment are published as estimates", async () => {
  readFactoryTwinConfig.mockResolvedValue({
    layout: { rooms: [{ id: "conference-room", widthM: 3, depthM: 4 }] },
    cameras: { "nvr1:11": { status: "CALIBRATED", roomId: "conference-room", calibration: { ...calibration, method: "ROOM_ALIGNMENT", verified: false } } },
  });
  const now = new Date("2026-10-14T10:00:00.000Z");
  const result = await ingestFactoryTwinTracks({
    cameraRef: "nvr1:11", sessionRef: "unverified", observedAt: now.toISOString(), frameSize: { width: 1000, height: 800 },
    tracks: [{ sourceTrackId: "1", footPointPx: { x: 500, y: 400 }, anchorMode: "POSE_ANKLES", trackingConfidence: 0.9 }],
  }, { now });
  expect(result.accepted[0].projection).toMatchObject({ quality: "DEGRADED", unverified: true });
  expect(result.accepted[0].projection.confidence).toBeLessThanOrEqual(0.5);
});

describe("face-confirmed identity boundary", () => {
  const identity = {
    status: "CONFIRMED_FACE", displayName: "Ramesh", confidence: 0.83,
    source: "PHONE_DETC_GALLERY", matchedAt: NOW.toISOString(),
  };

  test("stores a valid direct-face identity but redacts it by default", async () => {
    const result = await frame({ identity });
    expect(result.accepted[0].identity).toEqual(identity);
    expect(readFactoryTwinTracks("nvr1:11", { nowMs: at(500).getTime() })[0].identity).toBeUndefined();
    expect(readFactoryTwinTracks("nvr1:11", { nowMs: at(500).getTime(), includeIdentity: true })[0].identity).toEqual(identity);
  });

  test("snapshot exposes names only when the authenticated caller opts in", async () => {
    await frame({ identity });
    expect(visibleFactoryTwinSnapshot({ nowMs: at(500).getTime() }).observations[0].identity).toBeUndefined();
    expect(visibleFactoryTwinSnapshot({ nowMs: at(500).getTime(), includeIdentity: true }).observations[0].identity.displayName).toBe("Ramesh");
  });

  test("rejects body-only or malformed identity claims", async () => {
    const bodyOnly = await frame({ identity: { ...identity, source: "BODY_REID" } });
    expect(bodyOnly.accepted[0].identity).toBeUndefined();
    const weak = await frame({ identity: { ...identity, confidence: "0.9" } });
    expect(weak.accepted[0].identity).toBeUndefined();
  });
});


describe("rig, gesture and object evidence", () => {
  const now = new Date("2026-10-15T09:00:00.000Z");
  const base = { cameraRef: "nvr1:11", sessionRef: "evidence", observedAt: now.toISOString(), frameSize: { width: 500, height: 400 } };
  const keypoints = Array.from({ length: 17 }, (_, i) => [100 + i, 50 + i, 0.8]);

  test("body points are scaled to calibration pixels; gestures and interactions are whitelisted", async () => {
    const result = await ingestFactoryTwinTracks({ ...base, tracks: [{
      sourceTrackId: "1", footPointPx: { x: 250, y: 200 }, trackingConfidence: 0.9,
      pose2d: { keypoints },
      gestures: [{ kind: "HAND_AT_HEAD", confidence: 0.8 }, { kind: "ON_A_CALL", confidence: 0.99 }, { kind: "HAND_RAISED", confidence: 0.2 }],
      interactions: [{ kind: "PHONE_IN_HAND", confidence: 0.7 }, { kind: "TYPING", confidence: 0.9 }],
    }] }, { now });
    const visual = result.accepted[0].visual;
    expect(visual.pose2d.keypoints[0]).toEqual([200, 100, 0.8]);
    expect(visual.gestures).toEqual([{ kind: "HAND_AT_HEAD", confidence: 0.8 }]);
    expect(visual.interactions).toEqual([{ kind: "PHONE_IN_HAND", confidence: 0.7 }]);
    expect(result.accepted[0].activity.label).toBe("UNCERTAIN");
  });

  test("malformed body points are dropped, not guessed", async () => {
    const result = await ingestFactoryTwinTracks({ ...base, sessionRef: "evidence-2", tracks: [{
      sourceTrackId: "1", footPointPx: { x: 250, y: 200 }, trackingConfidence: 0.9, pose2d: { keypoints: keypoints.slice(0, 5) },
    }] }, { now });
    expect(result.accepted[0].visual.pose2d).toBeNull();
  });

  test("objects need repeated confirmation; chairs are kept (to move layout chairs), tables never", async () => {
    const result = await ingestFactoryTwinTracks({ ...base, sessionRef: "evidence-3", tracks: [], objects: [
      { sourceObjectId: "a", objectType: "LAPTOP", anchorPointPx: { x: 250, y: 210 }, confidence: 0.9 },
      { sourceObjectId: "b", objectType: "LAPTOP", anchorPointPx: { x: 250, y: 210 }, confidence: 0.6, confirmations: 2 },
      { sourceObjectId: "c", objectType: "CHAIR", anchorPointPx: { x: 250, y: 210 }, confidence: 0.9, confirmations: 5 },
      { sourceObjectId: "e", objectType: "TABLE", anchorPointPx: { x: 250, y: 210 }, confidence: 0.9, confirmations: 5 },
      { sourceObjectId: "d", objectType: "TV", anchorPointPx: { x: 250, y: 210 }, confidence: 0.6, confirmations: 4,
        imageBoxPx: { x1: 200, y1: 150, x2: 300, y2: 210 } },
    ] }, { now });
    expect(result.acceptedObjects.map((o) => [o.sourceObjectId, o.objectType])).toEqual([["c", "CHAIR"], ["d", "MONITOR"]]);
    expect(result.acceptedObjects[1].imageBoxPx).toEqual({ x1: 400, y1: 300, x2: 600, y2: 420 });
    expect(result.acceptedObjects[1].detection.confirmations).toBe(4);
  });
});
