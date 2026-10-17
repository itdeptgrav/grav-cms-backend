"use strict";
process.env.TEST_WITHOUT_MONGO = "1";

const {
  SpatialContractError,
  calibrateCamera,
  projectFootPoint,
  projectFloorEstimate,
  transformPoint,
  MAX_REPROJECTION_ERROR_PX,
  MAX_FLOOR_ERROR_M,
  validateSpatialObservation,
} = require("../../services/cctv/factoryTwinSpatial.service");
const { layout, spatialForCamera } = require("../../services/cctv/factoryTwinLayout");
const { buildConfiguration, draftFromDefaults } = require("../../services/cctv/factoryTwinConfig.service");

const rectangle = () => calibrateCamera({
  cameraRef: "camera-20", siteRef: "factory-a", modelVersion: "layout-v1", configVersion: "cam20-v1",
  imageSize: { width: 1000, height: 500 }, floorPlane: { elevationM: 0 },
  imageControlPoints: [{ x: 100, y: 100 }, { x: 900, y: 100 }, { x: 900, y: 450 }, { x: 100, y: 450 }],
  worldControlPointsM: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }],
});

test("four control points create a deterministic image-to-floor calibration", () => {
  const calibration = rectangle();
  expect(calibration.calibrationStatus).toBe("VALID");
  expect(calibration.reprojectionErrorPx).toBeLessThan(1e-6);
  const middle = transformPoint(calibration.homography, { x: 500, y: 275 });
  expect(middle.x).toBeCloseTo(10, 6);
  expect(middle.y).toBeCloseTo(5, 6);
});

test("collinear control points fail rather than manufacturing a transform", () => {
  expect(() => calibrateCamera({
    cameraRef: "camera-20", siteRef: "factory-a", modelVersion: "layout-v1", configVersion: "cam20-v1",
    imageSize: { width: 1000, height: 500 },
    imageControlPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }],
    worldControlPointsM: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
  })).toThrow(SpatialContractError);
});

test("projection accepts only the calibrated image area", () => {
  const calibration = rectangle();
  const inside = projectFootPoint(calibration, { x: 500, y: 275 });
  expect(inside.quality).toBe("GOOD");
  expect(inside.worldPositionM).toEqual({ x: expect.closeTo(10, 6), y: 0, z: expect.closeTo(5, 6) });
  const outside = projectFootPoint(calibration, { x: 20, y: 20 });
  expect(outside).toMatchObject({ quality: "UNRESOLVABLE", reasonCode: "OUTSIDE_CALIBRATED_AREA", worldPositionM: null });
});

test("typed observations reject invented business labels and invalid probabilities", () => {
  const observation = {
    schemaVersion: "factory-twin-observation-v1", eventId: "event-1", companyRef: "company-a", siteRef: "factory-a",
    cameraRef: "camera-20", sessionRef: "replay-1", sourceTrackId: "5", observedAt: "2026-10-14T10:00:00Z",
    worldPositionM: { x: 10, y: 0, z: 5 },
    projection: { quality: "GOOD", confidence: 0.9, calibrationVersion: "cam20-v1" },
    tracking: { confidence: 0.85 }, activity: { label: "PHONE_HELD", confidence: 0.7 },
  };
  expect(validateSpatialObservation(observation)).toEqual({ ok: true, errors: [] });
  expect(validateSpatialObservation({ ...observation, activity: { label: "LAZY", confidence: 2 } }).errors)
    .toEqual(["activity.label", "activity.confidence"]);
});

test("the Conference Room pilot keeps measured geometry separate from draft camera placement", () => {
  const room = layout.rooms.find((item) => item.id === "conference-room");
  expect(room).toMatchObject({ name: "Conference Room", source: "OWNER_MEASURED" });
  expect(room.widthM).toBeCloseTo(3.048, 6);
  expect(room.depthM).toBeCloseTo(3.6576, 6);
  expect(spatialForCamera("NVR1:11")).toMatchObject({
    status: "PROVISIONAL",
    roomId: "conference-room",
    calibration: null,
  });
});

test("an unplaced camera receives no invented world coordinate", () => {
  expect(spatialForCamera("nvr2:1")).toMatchObject({
    status: "UNCALIBRATED",
    worldPositionM: null,
    rotationDeg: null,
  });
});

const configuredRoom = (controlPoints = [], activateCalibration = false) => buildConfiguration(draftFromDefaults(), {
  cameraKey: "nvr1:11",
  room: { name: "Conference Room", widthFt: 10, depthFt: 12, heightFt: 9 },
  camera: { xFt: 9.7, zFt: 0.5, heightFt: 8.8, yawDeg: -40, pitchDeg: -24, horizontalFovDeg: 82 },
  imageSize: { width: 1000, height: 500 },
  controlPoints,
  activateCalibration,
}, { email: "owner@example.test" });

test("in-app room settings save incomplete points as a draft without activating projection", () => {
  const result = configuredRoom([
    { image: { x: 100, y: 100 }, floorFt: { x: 0, y: 0 } },
    { image: { x: 900, y: 100 }, floorFt: { x: 10, y: 0 } },
  ]);
  expect(result.layout.rooms[0]).toMatchObject({ widthM: expect.closeTo(3.048), depthM: expect.closeTo(3.6576) });
  expect(result.cameras["nvr1:11"]).toMatchObject({ status: "PROVISIONAL", calibration: null });
  expect(result.cameras["nvr1:11"].draftCalibration.imageControlPoints).toHaveLength(2);
});

test("four valid in-app point pairs activate a versioned calibration", () => {
  const result = configuredRoom([
    { image: { x: 100, y: 100 }, floorFt: { x: 0, y: 0 } },
    { image: { x: 900, y: 100 }, floorFt: { x: 10, y: 0 } },
    { image: { x: 900, y: 450 }, floorFt: { x: 10, y: 12 } },
    { image: { x: 100, y: 450 }, floorFt: { x: 0, y: 12 } },
  ], true);
  expect(result.cameras["nvr1:11"].status).toBe("CALIBRATED");
  expect(result.cameras["nvr1:11"].calibration).toMatchObject({ calibrationStatus: "VALID", cameraRef: "nvr1:11" });
  expect(result.cameras["nvr1:11"].draftCalibration).toBeNull();
});

test("four unconfirmed point pairs remain a draft", () => {
  const result = configuredRoom([
    { image: { x: 100, y: 100 }, floorFt: { x: 0, y: 0 } },
    { image: { x: 900, y: 100 }, floorFt: { x: 10, y: 0 } },
    { image: { x: 900, y: 450 }, floorFt: { x: 10, y: 12 } },
    { image: { x: 100, y: 450 }, floorFt: { x: 0, y: 12 } },
  ]);
  expect(result.cameras["nvr1:11"]).toMatchObject({ status: "PROVISIONAL", calibration: null });
  expect(result.cameras["nvr1:11"].draftCalibration.imageControlPoints).toHaveLength(4);
});


test("calibration carries per-pair floor residuals and the calibrated floor polygon", () => {
  const calibration = rectangle();
  expect(calibration.floorResidualsM).toHaveLength(4);
  calibration.floorResidualsM.forEach((value) => expect(value).toBeLessThan(1e-6));
  expect(calibration.calibratedFloorPolygonM).toEqual(expect.arrayContaining([
    { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 },
  ]));
  expect([MAX_REPROJECTION_ERROR_PX, MAX_FLOOR_ERROR_M]).toEqual([12, 0.35]);

  const inconsistent = calibrateCamera({
    cameraRef: "camera-20", siteRef: "factory-a", modelVersion: "layout-v1", configVersion: "cam20-v2",
    imageSize: { width: 1000, height: 500 },
    imageControlPoints: [{ x: 100, y: 100 }, { x: 900, y: 100 }, { x: 900, y: 450 }, { x: 100, y: 450 }, { x: 500, y: 275 }],
    worldControlPointsM: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }, { x: 14, y: 8 }],
  });
  expect(inconsistent.floorResidualsM).toHaveLength(5);
  expect(Math.max(...inconsistent.floorResidualsM)).toBeGreaterThan(MAX_FLOOR_ERROR_M);
});

test("floor estimates project outside the polygon but never beyond the horizon or far outside the room", () => {
  const calibration = rectangle();
  const room = { roomWidthM: 20, roomDepthM: 10 };
  const inside = projectFloorEstimate(calibration, { x: 500, y: 275 }, room);
  expect(inside).toMatchObject({ quality: "DEGRADED", insideCalibratedArea: true, clamped: false, reasonCode: null });
  expect(inside.confidence).toBeLessThanOrEqual(0.5);
  // 100 px left of the surveyed edge = 2.5 m outside: refused.
  expect(projectFloorEstimate(calibration, { x: 0, y: 275 }, room).reasonCode).toBe("OUTSIDE_ROOM");
  // 20 px = 0.5 m outside: clamped onto the wall.
  const nearWall = projectFloorEstimate(calibration, { x: 80, y: 275 }, room);
  expect(nearWall).toMatchObject({ quality: "DEGRADED", insideCalibratedArea: false, clamped: true });
  expect(nearWall.worldPositionM.x).toBe(0);
  expect(nearWall.confidence).toBeLessThanOrEqual(0.35);
  expect(projectFloorEstimate(calibration, { x: 500, y: 275 }, {}).reasonCode).toBe("ROOM_BOUNDS_REQUIRED");

  const perspective = calibrateCamera({
    cameraRef: "camera-21", siteRef: "factory-a", modelVersion: "layout-v1", configVersion: "cam21-v1",
    imageSize: { width: 1000, height: 800 },
    imageControlPoints: [{ x: 100, y: 700 }, { x: 900, y: 700 }, { x: 600, y: 250 }, { x: 400, y: 250 }],
    worldControlPointsM: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 4 }, { x: 0, y: 4 }],
  });
  const small = { roomWidthM: 3, roomDepthM: 4 };
  expect(projectFloorEstimate(perspective, { x: 500, y: 100 }, small).reasonCode).toBe("BEYOND_HORIZON");
  expect(projectFloorEstimate(perspective, { x: 500, y: 40 }, small).reasonCode).toBe("BEYOND_HORIZON");
  expect(projectFloorEstimate(perspective, { x: 500, y: 150 }, small).reasonCode).toBe("OUTSIDE_ROOM");
});

describe("head-height estimate for someone cut off by the frame", () => {
  const { projectHeadEstimate } = require("../../services/cctv/factoryTwinSpatial.service");
  // A camera 3 m up looking straight down at (2, 2): pixel = 500 + 100 * (floor - 2) * 3 / depth.
  const f = 100; const H = 3; const C = { x: 2, y: H, z: 2 };
  const pixel = (x, y, z) => ({ x: 500 + (f * (x - C.x) * H) / (H - y), y: 250 + (f * (z - C.z) * H) / (H - y) });
  const down = () => calibrateCamera({
    cameraRef: "cam-down", siteRef: "factory-a", modelVersion: "layout-v1", configVersion: "down-v1",
    imageSize: { width: 1000, height: 500 }, floorPlane: { elevationM: 0 },
    imageControlPoints: [pixel(0.5, 0, 0.5), pixel(3.5, 0, 0.5), pixel(3.5, 0, 3.5), pixel(0.5, 0, 3.5)],
    worldControlPointsM: [{ x: 0.5, y: 0.5 }, { x: 3.5, y: 0.5 }, { x: 3.5, y: 3.5 }, { x: 0.5, y: 3.5 }],
  });
  const room = { roomWidthM: 4, roomDepthM: 4 };

  test("a seated head's pixel leads back to the floor below it, not to where its ray lands", () => {
    const head = pixel(3, 1.2, 1.5);
    const result = projectHeadEstimate(down(), head, { cameraM: C, headHeightM: 1.2, ...room });
    expect(result).toMatchObject({ quality: "DEGRADED", reasonCode: null });
    expect(result.worldPositionM.x).toBeCloseTo(3, 6);
    expect(result.worldPositionM.z).toBeCloseTo(1.5, 6);
    expect(result.confidence).toBeLessThanOrEqual(0.35);
  });

  test("without the camera's position or with an impossible height it refuses", () => {
    expect(projectHeadEstimate(down(), pixel(3, 1.2, 1.5), { cameraM: null, headHeightM: 1.2, ...room }).reasonCode)
      .toBe("CAMERA_POSITION_REQUIRED");
    expect(projectHeadEstimate(down(), pixel(3, 1.2, 1.5), { cameraM: C, headHeightM: 2.9, ...room }).reasonCode)
      .toBe("CAMERA_POSITION_REQUIRED");
  });
});
