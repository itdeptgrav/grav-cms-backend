"use strict";
process.env.TEST_WITHOUT_MONGO = "1";

const {
  TwinConfigurationError, draftFromDefaults, defaultConferenceFurniture, withDefaultFurniture,
  buildConfiguration, buildLayoutConfiguration,
} = require("../../services/cctv/factoryTwinConfig.service");

const actor = { email: "owner@example.test" };
const corners = [
  { image: { x: 100, y: 100 }, floorFt: { x: 0, y: 0 } },
  { image: { x: 900, y: 100 }, floorFt: { x: 10, y: 0 } },
  { image: { x: 900, y: 450 }, floorFt: { x: 10, y: 12 } },
  { image: { x: 100, y: 450 }, floorFt: { x: 0, y: 12 } },
];
const measurements = (controlPoints = corners, activateCalibration = true, widthFt = 10) => ({
  cameraKey: "nvr1:11",
  room: { name: "Conference Room", widthFt, depthFt: 12, heightFt: 9 },
  camera: { xFt: Math.min(9.7, widthFt), zFt: 0.5, heightFt: 8.8, yawDeg: -40, pitchDeg: -24, horizontalFovDeg: 82 },
  imageSize: { width: 1000, height: 500 },
  controlPoints,
  activateCalibration,
});
const calibrated = () => buildConfiguration(draftFromDefaults(), measurements(), actor);
const chair = (overrides = {}) => ({
  id: "chair-9", type: "CHAIR", label: "Chair", xM: 1.2, zM: 0.6, rotationDeg: 0,
  widthM: 0.5, depthM: 0.5, heightM: 0.9, provenance: "SURVEYED", ...overrides,
});
const expectConfigError = (fn, code, status = 400) => {
  let caught;
  try { fn(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(TwinConfigurationError);
  expect(caught).toMatchObject({ code, status });
  return caught;
};

describe("default Conference Room furniture", () => {
  test("is the previous table and six chairs, approximate, every chair facing the table", () => {
    const furniture = draftFromDefaults().layout.rooms[0].furniture;
    expect(furniture.map((item) => item.id)).toEqual(["table-1", "chair-1", "chair-2", "chair-3", "chair-4", "chair-5", "chair-6"]);
    expect(furniture.every((item) => item.provenance === "APPROXIMATE")).toBe(true);
    const table = furniture[0];
    expect(table).toMatchObject({ type: "TABLE", xM: 1.524, zM: 1.829, heightM: 0.76 });
    for (const item of furniture.slice(1)) {
      expect(item).toMatchObject({ type: "CHAIR", widthM: 0.5, depthM: 0.5, heightM: 0.9 });
      const yaw = (item.rotationDeg * Math.PI) / 180;
      const towardTable = (table.xM - item.xM) * Math.sin(yaw) + (table.zM - item.zM) * Math.cos(yaw);
      expect(towardTable).toBeGreaterThan(0);
    }
    expect(furniture.find((item) => item.id === "chair-1").rotationDeg).toBe(0);
    expect(furniture.find((item) => item.id === "chair-3").rotationDeg).toBe(180);
  });

  test("is added to a stored Conference Room without a furniture key, never to a deliberate empty list", () => {
    const legacy = withDefaultFurniture({ rooms: [{ id: "conference-room", widthM: 3, depthM: 4 }] });
    expect(legacy.rooms[0].furniture).toEqual(defaultConferenceFurniture(3, 4));
    const emptied = withDefaultFurniture({ rooms: [{ id: "conference-room", widthM: 3, depthM: 4, furniture: [] }] });
    expect(emptied.rooms[0].furniture).toEqual([]);
    const other = withDefaultFurniture({ rooms: [{ id: "cutting-floor", widthM: 9, depthM: 9 }] });
    expect(other.rooms[0]).not.toHaveProperty("furniture");
  });
});

describe("saving measurements and calibration", () => {
  test("preserves the room's furniture, even when the room shrinks", () => {
    const current = draftFromDefaults();
    current.layout.rooms[0].furniture = [chair({ xM: 2.9 })];
    const next = buildConfiguration(current, measurements([], false, 8), actor);
    expect(next.layout.rooms[0].widthM).toBeCloseTo(8 * 0.3048);
    expect(next.layout.rooms[0].furniture).toEqual([chair({ xM: 2.9 })]);
  });

  test("refuses to activate a deliberately inconsistent five-point calibration", () => {
    const error = expectConfigError(() => buildConfiguration(draftFromDefaults(), measurements([
      ...corners,
      { image: { x: 500, y: 275 }, floorFt: { x: 9, y: 11 } },
    ]), actor), "CALIBRATION_ERROR_HIGH");
    expect(error.message).toMatch(/limit 12 px/);
    expect(error.message).toMatch(/limit 0\.35 m/);
    expect(error.message).toMatch(/Re-check pair \d/);
    expect(error.message).toMatch(/well-spread floor points/);
  });

  test("activates a consistent five-point calibration with residuals and floor polygon", () => {
    const next = buildConfiguration(draftFromDefaults(), measurements([
      ...corners,
      { image: { x: 500, y: 275 }, floorFt: { x: 5, y: 6 } },
    ]), actor);
    const { calibration } = next.cameras["nvr1:11"];
    expect(calibration.floorResidualsM).toHaveLength(5);
    expect(calibration.calibratedFloorPolygonM).toHaveLength(4);
  });
});

describe("saving the surveyed layout", () => {
  test("replaces one room's furniture, increments the version and preserves calibration", () => {
    const current = calibrated();
    const next = buildLayoutConfiguration(current, {
      roomId: "conference-room", baseVersion: current.version,
      furniture: [chair({ rotationDeg: 270, xM: 1.23456, extra: "dropped" }), chair({ id: "desk-1", type: "desk", label: "", provenance: "approximate" })],
    }, actor);
    expect(next.version).toBe(current.version + 1);
    expect(next.updatedBy).toBe("owner@example.test");
    expect(next.cameras).toEqual(current.cameras);
    expect(next.cameras["nvr1:11"].status).toBe("CALIBRATED");
    expect(next.layout.rooms[0].widthM).toBe(current.layout.rooms[0].widthM);
    expect(next.layout.rooms[0].furniture).toEqual([
      chair({ rotationDeg: -90, xM: 1.235 }),
      chair({ id: "desk-1", type: "DESK", label: "Desk", provenance: "APPROXIMATE" }),
    ]);
  });

  test("refuses detector objects as saved furniture", () => {
    const current = calibrated();
    const error = expectConfigError(() => buildLayoutConfiguration(current, {
      roomId: "conference-room", baseVersion: current.version, furniture: [chair({ provenance: "DETECTED" })],
    }, actor), "FURNITURE_PROVENANCE_INVALID");
    expect(error.message).toMatch(/detector objects cannot be saved as surveyed layout/);
  });

  test("refuses an item whose centre is outside the room", () => {
    const current = calibrated();
    expectConfigError(() => buildLayoutConfiguration(current, {
      roomId: "conference-room", baseVersion: current.version, furniture: [chair({ xM: 3.2 })],
    }, actor), "FURNITURE_OUT_OF_ROOM");
  });

  test("refuses a stale base version with 409", () => {
    const current = calibrated();
    expectConfigError(() => buildLayoutConfiguration(current, {
      roomId: "conference-room", baseVersion: current.version - 1, furniture: [],
    }, actor), "TWIN_CONFIG_CONFLICT", 409);
  });

  test("refuses unknown rooms, types, duplicate ids, bad sizes and long labels", () => {
    const current = calibrated();
    const save = (furniture, roomId = "conference-room") => () => buildLayoutConfiguration(current, { roomId, baseVersion: current.version, furniture }, actor);
    expectConfigError(save([], "warehouse"), "ROOM_NOT_FOUND");
    expectConfigError(save([chair({ type: "SPACESHIP" })]), "INVALID_FURNITURE");
    expectConfigError(save([chair(), chair()]), "INVALID_FURNITURE");
    expectConfigError(save([chair({ id: "-bad" })]), "INVALID_FURNITURE");
    expectConfigError(save([chair({ widthM: 0.01 })]), "INVALID_FURNITURE");
    expectConfigError(save([chair({ heightM: 7 })]), "INVALID_FURNITURE");
    expectConfigError(save([chair({ label: "x".repeat(61) })]), "INVALID_FURNITURE");
    expectConfigError(save([chair({ provenance: undefined })]), "FURNITURE_PROVENANCE_INVALID");
    expectConfigError(save(Array.from({ length: 201 }, (_, index) => chair({ id: `c-${index}` }))), "FURNITURE_LIMIT");
    expect(save([])().layout.rooms[0].furniture).toEqual([]);
  });
});

describe("room alignment saves", () => {
  const { buildConfiguration } = require("../../services/cctv/factoryTwinConfig.service");
  const base = {
    cameraKey: "nvr1:11", room: { name: "Conference Room", widthFt: 10, depthFt: 12, heightFt: 9 },
    camera: { xFt: 0.3, zFt: 0.3, heightFt: 8.86, yawDeg: 40, pitchDeg: -50, horizontalFovDeg: 82, rollDeg: 2.5 },
    imageSize: { width: 640, height: 360 }, activateCalibration: true, method: "ROOM_ALIGNMENT",
    // A planar mapping: image (u, v) ↔ floor ft (u / 64, v / 30), well spread.
    controlPoints: [[64, 30], [576, 30], [64, 330], [576, 330], [320, 180]].map(([x, y]) => ({ image: { x, y }, floorFt: { x: x / 64, y: y / 30 } })),
  };

  test("an unchecked alignment saves as unverified and keeps the roll", () => {
    const next = buildConfiguration({ version: 3, cameras: {}, layout: { rooms: [] } }, base, { email: "a@b" });
    const camera = next.cameras["nvr1:11"];
    expect(camera.status).toBe("CALIBRATED");
    expect(camera.rotationDeg.z).toBe(2.5);
    expect(camera.calibration).toMatchObject({ method: "ROOM_ALIGNMENT", verified: false, checkPoints: [] });
  });

  test("a check mark that agrees verifies it; one that disagrees is refused", () => {
    const ok = buildConfiguration({ version: 3, cameras: {}, layout: { rooms: [] } },
      { ...base, checkPoints: [{ image: { x: 256, y: 150 }, floorFt: { x: 4.1, y: 5 } }] }, {});
    expect(ok.cameras["nvr1:11"].calibration.verified).toBe(true);
    expect(ok.cameras["nvr1:11"].calibration.checkErrorsM[0]).toBeLessThan(0.05);
    expect(() => buildConfiguration({ version: 3, cameras: {}, layout: { rooms: [] } },
      { ...base, checkPoints: [{ image: { x: 256, y: 150 }, floorFt: { x: 7, y: 5 } }] }, {}))
      .toThrow(expect.objectContaining({ code: "CHECK_POINT_DISAGREES" }));
  });
});

test("desk items can be placed on a tabletop", () => {
  const { buildLayoutConfiguration } = require("../../services/cctv/factoryTwinConfig.service");
  const current = { version: 4, cameras: {}, layout: { rooms: [{ id: "conference-room", widthM: 3.048, depthM: 3.6576, furniture: [] }] } };
  const next = buildLayoutConfiguration(current, { roomId: "conference-room", baseVersion: 4, furniture: [
    { id: "laptop-1", type: "LAPTOP", xM: 1.5, zM: 1.8, rotationDeg: 0, widthM: 0.33, depthM: 0.23, heightM: 0.22, elevationM: 0.76, provenance: "APPROXIMATE" },
    { id: "keyboard-1", type: "KEYBOARD", xM: 1.2, zM: 2.6, rotationDeg: 10, widthM: 0.44, depthM: 0.14, heightM: 0.03, elevationM: 0.76, provenance: "SURVEYED" },
  ] }, {});
  const items = next.layout.rooms[0].furniture;
  expect(items.map((i) => [i.type, i.elevationM])).toEqual([["LAPTOP", 0.76], ["KEYBOARD", 0.76]]);
  expect(() => buildLayoutConfiguration(current, { roomId: "conference-room", baseVersion: 4, furniture: [
    { id: "laptop-1", type: "LAPTOP", xM: 1.5, zM: 1.8, rotationDeg: 0, widthM: 0.33, depthM: 0.23, heightM: 0.22, elevationM: 9, provenance: "APPROXIMATE" },
  ] }, {})).toThrow();
});
