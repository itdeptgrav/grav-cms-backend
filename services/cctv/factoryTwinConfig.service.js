"use strict";

const {
  layout: defaultLayout, spatialForCamera: defaultSpatialForCamera, defaultConferenceFurniture, FT_TO_M,
} = require("./factoryTwinLayout");
const {
  calibrateCamera, transformPoint, SpatialContractError, MAX_REPROJECTION_ERROR_PX, MAX_FLOOR_ERROR_M,
} = require("./factoryTwinSpatial.service");

const CAMERA_KEY = /^nvr[0-9]{1,2}:[0-9]{1,3}$/;
const SETTING_KEY = "cctv.factory_twin.primary";

class TwinConfigurationError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "TwinConfigurationError";
    this.code = code;
    this.status = status;
  }
}

const clone = (value) => JSON.parse(JSON.stringify(value));
const CONFERENCE_ROOM_ID = "conference-room";
const MAX_FURNITURE_PER_ROOM = 200;
const FURNITURE_ID = /^[a-z0-9][a-z0-9-_]{0,47}$/i;
const FURNITURE_TYPES = new Set([
  "CHAIR", "TABLE", "DESK", "WORKSTATION", "CABINET", "SHELF", "SOFA", "DOOR", "SEWING_STATION",
  "CUTTING_TABLE", "GARMENT_RACK", "MACHINE", "SCREEN", "WHITEBOARD", "PLANT", "BIN", "PILLAR",
  // Desk items. On the current low-resolution feeds the detectors cannot see
  // these reliably, so an administrator places them like furniture.
  "LAPTOP", "KEYBOARD", "MOUSE", "MONITOR",
]);
const FURNITURE_PROVENANCES = new Set(["SURVEYED", "APPROXIMATE"]);
const round3 = (value) => Math.round(Number(value) * 1000) / 1000;

// A stored Conference Room saved before furniture moved into the layout has no
// `furniture` key: give it the table and chairs the UI used to hard-code so
// nothing disappears on upgrade. An empty array is a deliberate admin choice
// and is left alone.
function withDefaultFurniture(layout) {
  if (!layout || !Array.isArray(layout.rooms)) return layout;
  return {
    ...layout,
    rooms: layout.rooms.map((room) => (room?.id === CONFERENCE_ROOM_ID && room && !Object.prototype.hasOwnProperty.call(room, "furniture")
      ? { ...room, furniture: defaultConferenceFurniture(room.widthM, room.depthM) }
      : room)),
  };
}

function draftFromDefaults() {
  return {
    layout: clone(defaultLayout),
    cameras: { "nvr1:11": clone(defaultSpatialForCamera("nvr1:11")) },
    version: 1,
    updatedAt: null,
  };
}

async function readFactoryTwinConfig() {
  // Atlas currently has reached its collection quota. Factory-twin geometry is
  // configuration, so keep it as one namespaced row in the existing
  // system_settings collection rather than creating another collection.
  const SystemSetting = require("../../models/DevOps/SystemSetting");
  const stored = await SystemSetting.findOne({ key: SETTING_KEY }).lean();
  if (!stored) return draftFromDefaults();
  const value = stored.value || {};
  return {
    layout: value.layout ? withDefaultFurniture(value.layout) : clone(defaultLayout),
    cameras: value.cameras || {},
    version: value.version || 1,
    updatedAt: stored.updatedAt || null,
  };
}

function spatialFrom(config, key) {
  return clone(config?.cameras?.[String(key || "").toLowerCase()] || defaultSpatialForCamera(key));
}

function positive(value, name, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new TwinConfigurationError("INVALID_TWIN_SETTING", `${name} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function signed(value, name, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new TwinConfigurationError("INVALID_TWIN_SETTING", `${name} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function normalizedPairs(raw, widthM, depthM) {
  if (raw == null || (Array.isArray(raw) && raw.length === 0)) return [];
  if (!Array.isArray(raw) || raw.length > 12) {
    throw new TwinConfigurationError("CONTROL_POINTS_REQUIRED", "Use no more than 12 paired floor points.");
  }
  return raw.map((entry, index) => {
    const imageX = Number(entry?.image?.x); const imageY = Number(entry?.image?.y);
    const floorXFt = Number(entry?.floorFt?.x); const floorYFt = Number(entry?.floorFt?.y);
    if (![imageX, imageY, floorXFt, floorYFt].every(Number.isFinite)) {
      throw new TwinConfigurationError("INVALID_CONTROL_POINT", `Point ${index + 1} needs image and floor coordinates.`);
    }
    if (imageX < 0 || imageY < 0 || floorXFt < 0 || floorYFt < 0
      || floorXFt * FT_TO_M > widthM || floorYFt * FT_TO_M > depthM) {
      throw new TwinConfigurationError("CONTROL_POINT_OUT_OF_RANGE", `Point ${index + 1} is outside the image or room.`);
    }
    return { image: { x: imageX, y: imageY }, floorM: { x: floorXFt * FT_TO_M, y: floorYFt * FT_TO_M } };
  });
}

function assertCalibrationQuality(calibration) {
  const pixels = Number(calibration?.reprojectionErrorPx);
  const metres = Number(calibration?.worldErrorM);
  if (pixels <= MAX_REPROJECTION_ERROR_PX && metres <= MAX_FLOOR_ERROR_M) return;
  const residuals = Array.isArray(calibration?.floorResidualsM) ? calibration.floorResidualsM : [];
  let worst = 0;
  residuals.forEach((value, index) => { if (value > residuals[worst]) worst = index; });
  const worstText = residuals.length
    ? ` Re-check pair ${worst + 1} first: it disagrees most (${residuals[worst].toFixed(2)} m off on the floor), though one wrong pair can pull the others off too.`
    : "";
  throw new TwinConfigurationError(
    "CALIBRATION_ERROR_HIGH",
    `The floor points do not agree closely enough to activate mapping: they disagree by ${pixels.toFixed(1)} px in the camera image `
      + `(limit ${MAX_REPROJECTION_ERROR_PX} px) and ${metres.toFixed(2)} m on the floor (limit ${MAX_FLOOR_ERROR_M} m).${worstText} `
      + "Make sure each image point and its floor measurement are the same physical spot, or add more well-spread floor points.",
  );
}

function buildConfiguration(current, input, actor) {
  const cameraKey = String(input?.cameraKey || "").trim().toLowerCase();
  if (!CAMERA_KEY.test(cameraKey)) throw new TwinConfigurationError("INVALID_CAMERA", "Choose a valid camera.");
  const widthFt = positive(input?.room?.widthFt, "Room width", 3, 500);
  const depthFt = positive(input?.room?.depthFt, "Room depth", 3, 500);
  const heightFt = positive(input?.room?.heightFt, "Room height", 5, 50);
  const widthM = widthFt * FT_TO_M; const depthM = depthFt * FT_TO_M;
  const cameraXFt = signed(input?.camera?.xFt, "Camera X", 0, widthFt);
  const cameraZFt = signed(input?.camera?.zFt, "Camera Y", 0, depthFt);
  const cameraHeightFt = positive(input?.camera?.heightFt, "Camera height", 1, heightFt);
  const yawDeg = signed(input?.camera?.yawDeg, "Camera direction", -180, 180);
  const pitchDeg = signed(input?.camera?.pitchDeg, "Camera tilt", -89, 20);
  const horizontalFovDeg = positive(input?.camera?.horizontalFovDeg, "Horizontal field of view", 20, 170);
  const rollDeg = input?.camera?.rollDeg == null ? 0 : signed(input.camera.rollDeg, "Camera roll", -45, 45);
  // ROOM_ALIGNMENT: the operator lined the measured room up with the live
  // frame and the pairs were generated from that camera. FLOOR_POINTS: pairs
  // clicked by hand. Alignment is only "verified" once a measured floor mark
  // agrees with it; until then positions are published as estimates.
  const method = input?.method === "ROOM_ALIGNMENT" ? "ROOM_ALIGNMENT" : "FLOOR_POINTS";
  if (Array.isArray(input?.checkPoints) && input.checkPoints.length > 8) {
    throw new TwinConfigurationError("CHECK_POINTS_LIMIT", "Use no more than 8 check marks.");
  }
  const checks = normalizedPairs(input?.checkPoints || [], widthM, depthM);
  const imageWidth = input?.imageSize?.width == null ? null : positive(input.imageSize.width, "Image width", 32, 16384);
  const imageHeight = input?.imageSize?.height == null ? null : positive(input.imageSize.height, "Image height", 32, 16384);
  const pairs = normalizedPairs(input?.controlPoints, widthM, depthM);
  if (pairs.length && (!imageWidth || !imageHeight)) {
    throw new TwinConfigurationError("IMAGE_SIZE_REQUIRED", "The reference-frame size is required with floor points.");
  }

  const nextVersion = Number(current?.version || 0) + 1;
  let calibration = null;
  if (pairs.length >= 4 && input?.activateCalibration === true) {
    try {
      calibration = calibrateCamera({
        cameraRef: cameraKey,
        siteRef: "grav-factory",
        modelVersion: `factory-layout-v${nextVersion}`,
        configVersion: `${cameraKey.replace(":", "-")}-v${nextVersion}`,
        imageSize: { width: imageWidth, height: imageHeight },
        floorPlane: { elevationM: 0 },
        imageControlPoints: pairs.map((pair) => pair.image),
        worldControlPointsM: pairs.map((pair) => pair.floorM),
      });
    } catch (error) {
      if (error instanceof SpatialContractError) throw new TwinConfigurationError(error.code, error.message);
      throw error;
    }
    assertCalibrationQuality(calibration);
    const checkErrorsM = checks.map((check) => {
      const floor = transformPoint(calibration.homography, check.image);
      return Math.hypot(floor.x - check.floorM.x, floor.y - check.floorM.y);
    });
    const worst = checkErrorsM.reduce((best, error, index) => (error > (checkErrorsM[best] ?? -1) ? index : best), -1);
    if (worst >= 0 && checkErrorsM[worst] > MAX_FLOOR_ERROR_M) {
      throw new TwinConfigurationError("CHECK_POINT_DISAGREES",
        `Check mark ${worst + 1} is ${Math.round(checkErrorsM[worst] * 100)} cm from where the mapping puts it. Re-check its measurement, or line the room up again.`);
    }
    calibration = {
      ...calibration,
      method,
      checkPoints: checks.map((check) => ({ image: check.image, floorM: check.floorM })),
      checkErrorsM: checkErrorsM.map((value) => Math.round(value * 1000) / 1000),
      verified: method !== "ROOM_ALIGNMENT" || checks.length > 0,
    };
  }

  const roomId = CONFERENCE_ROOM_ID;
  const currentRooms = Array.isArray(current?.layout?.rooms) ? current.layout.rooms : [];
  const currentRoom = currentRooms.find((item) => item?.id === roomId);
  // Re-saving measurements or calibration must not wipe the surveyed layout.
  // If the room shrank, items are kept as they are; the UI flags any that now
  // fall outside rather than the server silently dropping them.
  const furniture = currentRoom && Array.isArray(currentRoom.furniture)
    ? clone(currentRoom.furniture)
    : defaultConferenceFurniture(widthM, depthM);
  const room = {
    id: roomId,
    name: String(input?.room?.name || "Conference Room").trim().slice(0, 120) || "Conference Room",
    originM: { x: 0, y: 0, z: 0 }, widthM, depthM, heightM: heightFt * FT_TO_M,
    source: "OWNER_CONFIGURED", assumptions: [],
    furniture,
  };
  const cameras = { ...(current?.cameras || {}) };
  cameras[cameraKey] = {
    status: calibration ? "CALIBRATED" : "PROVISIONAL",
    roomId,
    worldPositionM: { x: cameraXFt * FT_TO_M, y: cameraHeightFt * FT_TO_M, z: cameraZFt * FT_TO_M },
    rotationDeg: { x: pitchDeg, y: yawDeg, z: rollDeg }, horizontalFovDeg,
    source: "OWNER_CONFIGURED", assumptions: calibration ? [] : ["Floor-point calibration is not complete."], calibration,
    draftCalibration: calibration ? null : {
      imageSize: imageWidth && imageHeight ? { width: imageWidth, height: imageHeight } : null,
      imageControlPoints: pairs.map((pair) => pair.image),
      worldControlPointsM: pairs.map((pair) => pair.floorM),
    },
  };
  return {
    layout: {
      id: "grav-factory-twin-v1",
      units: "m",
      rooms: [room, ...currentRooms.filter((item) => item && item.id !== roomId).map(clone)],
    },
    cameras,
    version: nextVersion,
    updatedBy: String(actor?.email || actor?.id || ""),
  };
}

const typeLabel = (type) => type.charAt(0) + type.slice(1).toLowerCase().replace(/_/g, " ");

function furnitureNumber(value, name, itemLabel, min, max) {
  const parsed = typeof value === "number" ? value : (typeof value === "string" && value.trim() ? Number(value) : NaN);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new TwinConfigurationError("INVALID_FURNITURE", `${itemLabel}: ${name} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function normalizeRotation(value) {
  let degrees = ((value % 360) + 360) % 360;
  if (degrees > 180) degrees -= 360;
  return degrees;
}

function normalizedFurniture(raw, room) {
  if (!Array.isArray(raw)) throw new TwinConfigurationError("INVALID_FURNITURE", "furniture must be a list of layout items.");
  if (raw.length > MAX_FURNITURE_PER_ROOM) {
    throw new TwinConfigurationError("FURNITURE_LIMIT", `A room can hold at most ${MAX_FURNITURE_PER_ROOM} layout items.`);
  }
  const widthM = Number(room.widthM); const depthM = Number(room.depthM);
  const seen = new Set();
  return raw.map((entry, index) => {
    const position = `Item ${index + 1}`;
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!FURNITURE_ID.test(id)) {
      throw new TwinConfigurationError("INVALID_FURNITURE", `${position}: id must be 1-48 letters, digits, "-" or "_", starting with a letter or digit.`);
    }
    const key = id.toLowerCase();
    if (seen.has(key)) throw new TwinConfigurationError("INVALID_FURNITURE", `${position}: id "${id}" is used more than once.`);
    seen.add(key);
    const type = typeof entry?.type === "string" ? entry.type.trim().toUpperCase() : "";
    if (!FURNITURE_TYPES.has(type)) {
      throw new TwinConfigurationError("INVALID_FURNITURE", `${position} (${id}): "${entry?.type}" is not a supported layout item type.`);
    }
    const rawLabel = entry?.label == null ? "" : String(entry.label).trim();
    if (rawLabel.length > 60) throw new TwinConfigurationError("INVALID_FURNITURE", `${position} (${id}): label must be 60 characters or fewer.`);
    const label = rawLabel || typeLabel(type);
    const itemLabel = `${label} (${id})`;
    const provenance = typeof entry?.provenance === "string" ? entry.provenance.trim().toUpperCase() : "";
    if (provenance === "DETECTED") {
      throw new TwinConfigurationError(
        "FURNITURE_PROVENANCE_INVALID",
        `${itemLabel}: detector objects cannot be saved as surveyed layout. Place the item yourself and mark it surveyed or approximate.`,
      );
    }
    if (!FURNITURE_PROVENANCES.has(provenance)) {
      throw new TwinConfigurationError("FURNITURE_PROVENANCE_INVALID", `${itemLabel}: provenance must be SURVEYED or APPROXIMATE.`);
    }
    const xM = furnitureNumber(entry?.xM, "x position", itemLabel, -Infinity, Infinity);
    const zM = furnitureNumber(entry?.zM, "y position", itemLabel, -Infinity, Infinity);
    if (xM < 0 || xM > widthM || zM < 0 || zM > depthM) {
      throw new TwinConfigurationError(
        "FURNITURE_OUT_OF_ROOM",
        `${itemLabel}: its centre (${xM.toFixed(2)} m, ${zM.toFixed(2)} m) is outside the ${widthM.toFixed(2)} x ${depthM.toFixed(2)} m room.`,
      );
    }
    const rotationDeg = furnitureNumber(entry?.rotationDeg, "rotation", itemLabel, -Infinity, Infinity);
    return {
      id, type, label,
      xM: round3(xM), zM: round3(zM),
      rotationDeg: round3(normalizeRotation(rotationDeg)),
      widthM: round3(furnitureNumber(entry?.widthM, "width", itemLabel, 0.05, 20)),
      depthM: round3(furnitureNumber(entry?.depthM, "depth", itemLabel, 0.05, 20)),
      heightM: round3(furnitureNumber(entry?.heightM, "height", itemLabel, 0.02, 6)),
      // How high the item's base sits — a tabletop for desk items; 0 = floor.
      ...(entry?.elevationM == null || entry.elevationM === 0 ? {} : { elevationM: round3(furnitureNumber(entry.elevationM, "elevation", itemLabel, 0, 3)) }),
      provenance,
    };
  });
}

/** Pure: replace one room's furniture in `current` and bump the version. */
function buildLayoutConfiguration(current, input, actor) {
  const roomId = typeof input?.roomId === "string" ? input.roomId.trim() : "";
  const rooms = Array.isArray(current?.layout?.rooms) ? current.layout.rooms : [];
  const room = rooms.find((item) => item?.id === roomId);
  if (!roomId || !room) throw new TwinConfigurationError("ROOM_NOT_FOUND", "Choose a room that exists in the factory layout.");
  const currentVersion = Number(current?.version || 1);
  if (input?.baseVersion == null || Number(input.baseVersion) !== currentVersion) {
    throw new TwinConfigurationError(
      "TWIN_CONFIG_CONFLICT",
      `The factory layout was changed elsewhere (now version ${currentVersion}). Reload it and apply your edits again.`,
      409,
    );
  }
  const furniture = normalizedFurniture(input?.furniture, room);
  return {
    layout: {
      ...clone(current.layout),
      rooms: rooms.map((item) => (item?.id === roomId ? { ...clone(item), furniture } : clone(item))),
    },
    cameras: clone(current?.cameras || {}),
    version: currentVersion + 1,
    updatedBy: String(actor?.email || actor?.id || ""),
  };
}

async function saveFactoryTwinLayout(input, actor) {
  const SystemSetting = require("../../models/DevOps/SystemSetting");
  const current = await readFactoryTwinConfig();
  const next = buildLayoutConfiguration(current, input, actor);
  // Compare-and-set on the stored version so two administrators saving at the
  // same moment cannot both win; the loser gets the same 409 as a stale base.
  const filter = { key: SETTING_KEY };
  const stored = await SystemSetting.findOne(filter).select({ "value.version": 1 }).lean();
  if (stored && stored.value?.version != null) filter["value.version"] = current.version;
  let saved;
  try {
    saved = await SystemSetting.findOneAndUpdate(
      filter,
      { $set: { value: next, updatedByEmail: next.updatedBy, updatedByName: actor?.name || "" } },
      { upsert: !stored, new: true, setDefaultsOnInsert: true },
    ).lean();
  } catch (error) {
    if (error?.code === 11000) saved = null;
    else throw error;
  }
  if (!saved) {
    throw new TwinConfigurationError("TWIN_CONFIG_CONFLICT", "The factory layout was changed elsewhere. Reload it and apply your edits again.", 409);
  }
  return {
    layout: saved.value.layout,
    cameras: saved.value.cameras || {},
    version: saved.value.version,
    updatedAt: saved.updatedAt,
  };
}

async function saveFactoryTwinConfig(input, actor) {
  const SystemSetting = require("../../models/DevOps/SystemSetting");
  const current = await readFactoryTwinConfig();
  const next = buildConfiguration(current, input, actor);
  const saved = await SystemSetting.findOneAndUpdate(
    { key: SETTING_KEY },
    { $set: { value: next, updatedByEmail: next.updatedBy, updatedByName: actor?.name || "" } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  return {
    layout: saved.value.layout,
    cameras: saved.value.cameras || {},
    version: saved.value.version,
    updatedAt: saved.updatedAt,
  };
}

module.exports = {
  TwinConfigurationError,
  FURNITURE_TYPES,
  draftFromDefaults,
  defaultConferenceFurniture,
  withDefaultFurniture,
  readFactoryTwinConfig,
  spatialFrom,
  buildConfiguration,
  buildLayoutConfiguration,
  saveFactoryTwinConfig,
  saveFactoryTwinLayout,
  normalizedFurniture,
};
