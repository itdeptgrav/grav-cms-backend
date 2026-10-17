"use strict";

const FT_TO_M = 0.3048;

const round3 = (value) => Math.round(value * 1000) / 1000;

// The table and six chairs the Conference Room view used to hard-code in the
// React component, now layout data marked APPROXIMATE (not surveyed). Positions
// are room-local metres, item centres. rotationDeg is the yaw a seated person
// faces: facing (sin, cos) in x/z, so a chair at the table's -z side with
// rotationDeg 0 faces +z, toward the table.
function defaultConferenceFurniture(widthM, depthM) {
  const width = Number(widthM); const depth = Number(depthM);
  if (!(width > 0 && depth > 0)) return [];
  const cx = width / 2; const cz = depth / 2;
  const tableW = width * 0.52; const tableD = depth * 0.58;
  const chair = (index, xM, zM, rotationDeg, label) => ({
    id: `chair-${index}`, type: "CHAIR", label, xM: round3(xM), zM: round3(zM), rotationDeg,
    widthM: 0.5, depthM: 0.5, heightM: 0.9, provenance: "APPROXIMATE",
  });
  return [
    {
      id: "table-1", type: "TABLE", label: "Conference table", xM: round3(cx), zM: round3(cz), rotationDeg: 0,
      widthM: round3(tableW), depthM: round3(tableD), heightM: 0.76, provenance: "APPROXIMATE",
    },
    chair(1, cx - tableW * 0.31, cz - tableD * 0.62, 0, "Chair 1"),
    chair(2, cx + tableW * 0.31, cz - tableD * 0.62, 0, "Chair 2"),
    chair(3, cx - tableW * 0.31, cz + tableD * 0.62, 180, "Chair 3"),
    chair(4, cx + tableW * 0.31, cz + tableD * 0.62, 180, "Chair 4"),
    // The old component rotated these two by -90/+90 about three.js +Y, which
    // under its own backrest-at-local-z convention turned them away from the
    // table. Under the contract's facing convention they face the table.
    chair(5, cx - tableW * 0.68, cz, 90, "Chair 5"),
    chair(6, cx + tableW * 0.68, cz, -90, "Chair 6"),
  ];
}

// First measured pilot supplied by the product owner on 14 Oct 2026.
// The room dimensions are authoritative under the stated feet assumption. The
// camera mount is a frame-derived draft only: it is useful for the layout trial
// but MUST NOT be used to publish person coordinates until control-point
// calibration has been completed and its error accepted.
const layout = Object.freeze({
  id: "grav-factory-twin-v1",
  units: "m",
  rooms: [
    {
      id: "conference-room",
      name: "Conference Room",
      originM: { x: 0, y: 0, z: 0 },
      widthM: 10 * FT_TO_M,
      depthM: 12 * FT_TO_M,
      heightM: 2.75,
      source: "OWNER_MEASURED",
      assumptions: ["The supplied 10 x 12 dimensions are feet."],
      furniture: defaultConferenceFurniture(10 * FT_TO_M, 12 * FT_TO_M),
    },
  ],
});

const cameraSpatial = Object.freeze({
  "nvr1:11": {
    status: "PROVISIONAL",
    roomId: "conference-room",
    worldPositionM: { x: 2.95, y: 2.7, z: 0.15 },
    rotationDeg: { x: -24, y: -40, z: 0 },
    horizontalFovDeg: 82,
    source: "OWNER_FRAME_REVIEW",
    assumptions: [
      "Camera is mounted high in the near-right corner when facing into the room.",
      "Mounting height is provisionally 2.70 m.",
    ],
    calibration: null,
  },
});

function spatialForCamera(key) {
  return cameraSpatial[String(key || "").toLowerCase()] || {
    status: "UNCALIBRATED",
    roomId: null,
    worldPositionM: null,
    rotationDeg: null,
    horizontalFovDeg: null,
    source: null,
    assumptions: [],
    calibration: null,
  };
}

module.exports = { layout, spatialForCamera, defaultConferenceFurniture, FT_TO_M };
