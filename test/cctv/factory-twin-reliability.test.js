"use strict";

process.env.TEST_WITHOUT_MONGO = "1";

jest.mock("../../services/cctv/factoryTwinConfig.service", () => ({ readFactoryTwinConfig: jest.fn() }));

const { readFactoryTwinConfig } = require("../../services/cctv/factoryTwinConfig.service");
const { calibrateCamera, calibrationReliability, generalPosition } = require("../../services/cctv/factoryTwinSpatial.service");
const { ingestFactoryTwinTracks, visibleFactoryTwinSnapshot, clearFactoryTwinTracks } = require("../../services/cctv/factoryTwinLive.service");
const { firstJpeg, relayStream } = require("../../services/cctv/cctvStill.service");

// The Conference Room's saved v5 pairs: three marks along the left wall and one far corner.
const WALL_LINE = {
  image: [{ x: 1319, y: 528 }, { x: 488, y: 1441 }, { x: 2647, y: 700 }, { x: 894, y: 939 }],
  world: [{ x: 0.054864, y: 0 }, { x: 0.012192, y: 2.871216 }, { x: 2.980944, y: 0.027432 }, { x: 0.039624, y: 1.130808 }],
};
const scope = { cameraRef: "nvr1:11", siteRef: "s", modelVersion: "m", configVersion: "c", imageSize: { width: 2940, height: 1656 } };

test("three points along one wall are refused, naming them", () => {
  expect(generalPosition(WALL_LINE.world)).toMatchObject({ ok: false, weakTriple: [1, 2, 4] });
  expect(() => calibrateCamera({ ...scope, imageControlPoints: WALL_LINE.image, worldControlPointsM: WALL_LINE.world }))
    .toThrow(expect.objectContaining({ code: "DEGENERATE_CALIBRATION", message: expect.stringMatching(/Points 1, 2 and 4 lie almost on one line on the floor/) }));
});

test("a well-spread set passes, and extra points may be collinear", () => {
  const square = [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 0, y: 4 }, { x: 3, y: 4 }];
  expect(generalPosition(square).ok).toBe(true);
  expect(generalPosition([...square, { x: 1, y: 0 }, { x: 2, y: 0 }]).ok).toBe(true);
});

describe("live ingest with an unreliable saved calibration", () => {
  // Saved before the gate existed: build it by hand the way v5 was stored.
  const bad = { ...calibrateCamera({ ...scope, imageControlPoints: [{ x: 100, y: 100 }, { x: 900, y: 100 }, { x: 100, y: 700 }, { x: 900, y: 700 }],
    worldControlPointsM: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 0, y: 3.6 }, { x: 3, y: 3.6 }] }),
  imageControlPoints: WALL_LINE.image, worldControlPointsM: WALL_LINE.world };

  beforeEach(() => {
    clearFactoryTwinTracks();
    readFactoryTwinConfig.mockResolvedValue({
      layout: { rooms: [{ id: "conference-room", widthM: 3.048, depthM: 3.6576 }] },
      cameras: { "nvr1:11": { status: "CALIBRATED", roomId: "conference-room", worldPositionM: { x: 3, y: 2.7, z: 3.6 }, calibration: bad } },
    });
  });

  test("places nobody but still reports who is in view", async () => {
    expect(calibrationReliability(bad).ok).toBe(false);
    const now = new Date("2026-10-14T14:20:00.000Z");
    const result = await ingestFactoryTwinTracks({
      cameraRef: "nvr1:11", sessionRef: "w", observedAt: now.toISOString(), frameSize: { width: 640, height: 360 },
      tracks: [{ sourceTrackId: "3", footPointPx: { x: 500, y: 280 }, anchorMode: "OCCUPANCY_PROXY", posture: "SEATED", postureSource: "POSE", postureConfidence: 0.9, trackingConfidence: 0.8 }],
    }, { now });
    expect(result.accepted).toHaveLength(0);
    expect(result.unpositioned).toEqual([expect.objectContaining({ sourceTrackId: "3", reasonCode: "CALIBRATION_UNRELIABLE" })]);
    expect(result.unpositioned[0].visual.posture).toBe("SEATED");
    expect(result.unpositioned[0].worldPositionM).toBeUndefined();
    const snap = visibleFactoryTwinSnapshot({ nowMs: now.getTime() + 500 });
    expect(snap.unpositioned).toHaveLength(1);
    expect(snap.feeds["nvr1:11"].calibrationReliable).toBe(false);
    expect(visibleFactoryTwinSnapshot({ nowMs: now.getTime() + 500, allowedCameraKeys: ["nvr2:1"] }).unpositioned).toHaveLength(0);
    expect(visibleFactoryTwinSnapshot({ nowMs: now.getTime() + 6000 }).unpositioned).toHaveLength(0);
  });
});

test("a still is cut from the first complete JPEG in an MJPEG stream", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const stream = Buffer.concat([Buffer.from("--frame\r\nContent-Type: image/jpeg\r\n\r\n"), jpeg, Buffer.from("\r\n--frame")]);
  expect(firstJpeg(stream).equals(jpeg)).toBe(true);
  expect(firstJpeg(Buffer.from([0xff, 0xd8, 0xff, 1, 2]))).toBeNull();
});

test("the dev view stream relays whole frames, throttled, and stops when the viewer leaves", async () => {
  const frame = (n) => Buffer.concat([Buffer.from("--frame\r\nContent-Type: image/jpeg\r\n\r\n"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, n, 0xff, 0xd9]), Buffer.from("\r\n")]);
  // 20 frames arrive at once, split mid-frame: whole frames only, and at 5 fps only the first gets through.
  const bytes = Buffer.concat(Array.from({ length: 20 }, (_, i) => frame(i)));
  const chunks = [bytes.subarray(0, 50), bytes.subarray(50)];
  const saved = { fetch: global.fetch, key: process.env.CCTV_KEY, url: process.env.CCTV_APP_URL };
  process.env.CCTV_KEY = "test-key-123"; process.env.CCTV_APP_URL = "http://cctv.local";
  let asked = "";
  global.fetch = async (url, { signal }) => {
    asked = url;
    let i = 0;
    return { ok: true, body: { getReader: () => ({ read: () => (signal.aborted ? Promise.reject(new Error("aborted")) : Promise.resolve(i < chunks.length ? { value: chunks[i++] } : { done: true })) }) } };
  };
  try {
    const got = [];
    await relayStream(3, { maxFps: 5, onFrame: (jpeg) => got.push(jpeg) });
    expect(asked).toBe("http://cctv.local/stream/3?key=test-key-123");
    expect(got).toHaveLength(1);
    expect(got[0].equals(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0xff, 0xd9]))).toBe(true);
    const all = [];
    await relayStream(3, { maxFps: Infinity, onFrame: (jpeg) => all.push(jpeg[4]) });
    expect(all).toEqual(Array.from({ length: 20 }, (_, i) => i));
    const left = new AbortController(); left.abort();
    const none = [];
    await relayStream(3, { signal: left.signal, onFrame: (jpeg) => none.push(jpeg) });
    expect(none).toEqual([]);
  } finally {
    global.fetch = saved.fetch;
    if (saved.key === undefined) delete process.env.CCTV_KEY; else process.env.CCTV_KEY = saved.key;
    if (saved.url === undefined) delete process.env.CCTV_APP_URL; else process.env.CCTV_APP_URL = saved.url;
  }
});
