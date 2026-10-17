// routes/cctvSso.js
//
// The CMS side of CCTV (the camera site itself is grav-cctv at cctv.grav.in).
// Mounted at /api/cctv.
//
//   GET  /api/cctv/access           the CMS home/twin asks whether this user may enter
//   POST /api/cctv/sso              the CMS /cctv page asks for a sign-in URL
//   GET  /api/cctv/sso              the same for a plain link (302 to it)
//   GET  /api/cctv/internal/access  the CCTV site asks what a person may do
//
// Preferred hand-off: a 90-second token names WHO the person is, and the CCTV
// site asks /internal/access WHAT they may do — per camera: live video, sound,
// recorded playback (services/cctv/cctvAccess.service.js). The currently
// deployed CCTV app still has a backend-only CCTV_KEY compatibility mode;
// cctvLink selects JWT automatically as soon as CCTV_SSO_SECRET is configured.
"use strict";

const express = require("express");
const { authenticateCmsSession } = require("../services/cmsSession");
const { resolveCctvAccess } = require("../services/cctv/cctvAccess.service");
const { mintSsoUrl, requireCctvService, fetchCameras, CctvLinkError } = require("../services/cctv/cctvLink");
const { grabStill, relayStream } = require("../services/cctv/cctvStill.service");
const {
  TwinConfigurationError, readFactoryTwinConfig, spatialFrom, saveFactoryTwinConfig, saveFactoryTwinLayout,
} = require("../services/cctv/factoryTwinConfig.service");
const {
  TwinObservationError, ingestFactoryTwinTracks, visibleFactoryTwinSnapshot,
} = require("../services/cctv/factoryTwinLive.service");

const router = express.Router();

function identityFrom(req) {
  return { id: req.user.id, subject: req.user.subject, tv: req.user.tv, email: req.user.email, name: req.user.name };
}

function configuredCameraRegistry(twinConfig) {
  const rooms = new Map((twinConfig?.layout?.rooms || []).map((room) => [room.id, room]));
  return Object.entries(twinConfig?.cameras || {})
    .filter(([, spatial]) => spatial?.worldPositionM || spatial?.calibration || spatial?.draftCalibration)
    .map(([key, spatial], index) => {
      const [nvr, rawChannel] = String(key).toLowerCase().split(":");
      const channel = Number(rawChannel);
      const room = rooms.get(spatial?.roomId);
      return {
        key,
        index,
        displayName: room?.name || `${nvr.toUpperCase()} channel ${channel}`,
        technicalName: `${nvr.toUpperCase()} Cam ${channel}`,
        nvr,
        channel,
        displayOrder: index,
        audio: "unknown",
      };
    });
}

async function accessFor(req) {
  const who = identityFrom(req);
  const access = await resolveCctvAccess(who);
  return { who, access };
}

/** Decide, and mint the hand-off URL for somebody allowed. */
async function signIn(req) {
  const { who, access } = await accessFor(req);
  if (!access.allowed) {
    const status = access.denialCode === "ACCESS_CHECK_UNAVAILABLE" ? 503 : 403;
    return { status, body: { success: false, code: access.denialCode, message: access.message } };
  }
  try {
    const url = mintSsoUrl({ ...who, email: access.person?.email || who.email, name: access.person?.name || who.name });
    return { status: 200, body: { success: true, url, admin: access.admin, cameras: access.admin ? null : access.cameras.length } };
  } catch (err) {
    if (err instanceof CctvLinkError) return { status: err.status, body: { success: false, code: err.code, message: err.message } };
    throw err;
  }
}

// GET /api/cctv/access -> the CMS and the digital twin use the same
// authoritative access decision without minting or exposing a camera-app URL.
router.get("/access", authenticateCmsSession, async (req, res) => {
  try {
    const { access } = await accessFor(req);
    if (!access.allowed) {
      const status = access.denialCode === "ACCESS_CHECK_UNAVAILABLE" ? 503 : 403;
      return res.status(status).json({ success: false, code: access.denialCode, message: access.message });
    }
    res.set("Cache-Control", "no-store");
    return res.json({
      success: true,
      allowed: true,
      admin: access.admin === true,
      cameras: access.admin ? null : access.cameras.length,
      person: { name: access.person?.name || req.user.name || "", email: access.person?.email || req.user.email || "" },
    });
  } catch (err) {
    console.error("[cctv] access check failed:", err?.message || err);
    return res.status(503).json({ success: false, code: "ACCESS_CHECK_UNAVAILABLE", message: "CCTV access could not be checked. Try again in a moment." });
  }
});

// GET /api/cctv/twin/cameras -> real camera registry, filtered by the same
// per-person grants as the hosted viewer. Spatial coordinates remain null until
// a surveyed placement is saved; the client must never invent factory points.
router.get("/twin/cameras", authenticateCmsSession, async (req, res) => {
  try {
    const { access } = await accessFor(req);
    if (!access.allowed) {
      const status = access.denialCode === "ACCESS_CHECK_UNAVAILABLE" ? 503 : 403;
      return res.status(status).json({ success: false, code: access.denialCode, message: access.message });
    }
    const twinConfig = await readFactoryTwinConfig();
    let registry;
    let registrySource = "hosted-cctv";
    let registryWarning = "";
    try {
      registry = await fetchCameras();
    } catch (error) {
      const cameras = configuredCameraRegistry(twinConfig);
      if (!cameras.length) throw error;
      registry = { cameras, stale: true, fetchedAt: null };
      registrySource = "saved-twin-configuration";
      registryWarning = "The hosted CCTV registry is temporarily unavailable. Showing cameras already saved in the factory twin.";
    }
    const permissions = new Map((access.cameras || []).map((camera) => [camera.key, camera]));
    const visible = access.admin ? registry.cameras : registry.cameras.filter((camera) => permissions.has(camera.key));
    const cameras = visible.map((camera) => ({
      key: camera.key,
      index: camera.index,
      displayName: camera.displayName,
      technicalName: camera.technicalName,
      nvr: camera.nvr,
      channel: camera.channel,
      displayOrder: camera.displayOrder,
      audio: camera.audio,
      permissions: access.admin
        ? { live: true, audio: true, playback: true }
        : permissions.get(camera.key),
      spatial: spatialFrom(twinConfig, camera.key),
    }));
    const positioned = cameras.filter((camera) => camera.spatial.worldPositionM).length;
    const calibrated = cameras.filter((camera) => camera.spatial.status === "CALIBRATED").length;
    res.set("Cache-Control", "no-store");
    return res.json({
      success: true,
      source: registrySource,
      stale: registry.stale === true,
      warning: registryWarning,
      fetchedAt: registry.fetchedAt,
      total: cameras.length,
      positioned,
      calibrated,
      canConfigure: access.admin === true,
      configVersion: twinConfig.version,
      layout: twinConfig.layout,
      cameras,
    });
  } catch (err) {
    const status = err instanceof CctvLinkError ? err.status : 503;
    console.error("[cctv] twin camera registry failed:", err?.message || err);
    return res.status(status).json({
      success: false,
      code: err?.code || "CCTV_UNREACHABLE",
      message: err instanceof CctvLinkError ? err.message : "The live camera registry could not be loaded.",
    });
  }
});

// PUT /api/cctv/twin/configuration -> administrators survey one room/camera
// from the twin itself. The server owns units, bounds and homography validation.
router.put("/twin/configuration", authenticateCmsSession, async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ success: false, code: "CCTV_CONFIGURATION_FORBIDDEN", message: "Only an administrator can configure the factory twin." });
  }
  try {
    const config = await saveFactoryTwinConfig(req.body || {}, req.user);
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, configVersion: config.version, layout: config.layout, spatial: spatialFrom(config, req.body?.cameraKey) });
  } catch (error) {
    if (error instanceof TwinConfigurationError) {
      return res.status(error.status).json({ success: false, code: error.code, message: error.message });
    }
    console.error("[cctv] twin configuration failed:", error?.message || error);
    return res.status(503).json({ success: false, code: "TWIN_CONFIGURATION_UNAVAILABLE", message: "The twin configuration could not be saved." });
  }
});

// PUT /api/cctv/twin/layout -> administrators replace one room's surveyed or
// approximate furniture: { roomId, furniture, baseVersion }. Detector objects
// can never be saved through here (provenance DETECTED is refused).
router.put("/twin/layout", authenticateCmsSession, async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ success: false, code: "CCTV_CONFIGURATION_FORBIDDEN", message: "Only an administrator can configure the factory twin." });
  }
  try {
    const config = await saveFactoryTwinLayout(req.body || {}, req.user);
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, configVersion: config.version, layout: config.layout });
  } catch (error) {
    if (error instanceof TwinConfigurationError) {
      return res.status(error.status).json({ success: false, code: error.code, message: error.message });
    }
    console.error("[cctv] twin layout save failed:", error?.message || error);
    return res.status(503).json({ success: false, code: "TWIN_CONFIGURATION_UNAVAILABLE", message: "The room layout could not be saved." });
  }
});

// GET /api/cctv/twin/still?cameraRef= -> one current JPEG frame for mapping.
// Administrators only (mapping is admin-only). The frame is fetched from the
// same stream the person worker reads, so calibration pixels match the
// detector's exactly; it is not stored anywhere.
router.get("/twin/still", authenticateCmsSession, async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ success: false, code: "CCTV_CONFIGURATION_FORBIDDEN", message: "Only an administrator can capture a mapping frame." });
  }
  try {
    const cameraRef = String(req.query?.cameraRef || "").trim().toLowerCase();
    const { cameras } = await fetchCameras();
    const camera = cameras.find((item) => item.key === cameraRef);
    if (!camera) return res.status(404).json({ success: false, code: "CAMERA_NOT_FOUND", message: "That camera is not in the CCTV registry." });
    const jpeg = await grabStill(camera.index);
    res.set("Cache-Control", "no-store");
    res.type("image/jpeg");
    return res.send(jpeg);
  } catch (err) {
    const status = err instanceof CctvLinkError ? err.status : 503;
    console.error("[cctv] twin still failed:", err?.message || err);
    return res.status(status).json({ success: false, code: err?.code || "CCTV_STILL_UNAVAILABLE", message: err instanceof CctvLinkError ? err.message : "A camera frame could not be captured." });
  }
});

// GET /api/cctv/twin/stream?cameraRef= -> the camera's live picture as MJPEG
// (multipart/x-mixed-replace), for the twin's dev view: the detector's boxes
// are drawn over the stream they came from. Administrators only, like the
// still; relayed through this server so the CCTV key never reaches a browser,
// at most 5 frames a second, for at most 10 minutes (the viewer reconnects),
// and never stored.
router.get("/twin/stream", authenticateCmsSession, async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ success: false, code: "CCTV_CONFIGURATION_FORBIDDEN", message: "Only an administrator can open the dev view stream." });
  }
  const ctrl = new AbortController();
  req.on("close", () => ctrl.abort());
  let started = false;
  try {
    const cameraRef = String(req.query?.cameraRef || "").trim().toLowerCase();
    const { cameras } = await fetchCameras();
    const camera = cameras.find((item) => item.key === cameraRef);
    if (!camera) return res.status(404).json({ success: false, code: "CAMERA_NOT_FOUND", message: "That camera is not in the CCTV registry." });
    await relayStream(camera.index, {
      signal: ctrl.signal,
      onFrame: (jpeg) => {
        if (!started) {
          res.writeHead(200, { "Content-Type": "multipart/x-mixed-replace; boundary=frame", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
          started = true;
        }
        res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
        res.write(jpeg);
        res.write("\r\n");
      },
    });
    if (!started && !ctrl.signal.aborted) return res.status(502).json({ success: false, code: "CCTV_NO_FRAME", message: "The camera stream did not deliver a frame." });
    return res.end();
  } catch (err) {
    if (started) return res.end();
    const status = err instanceof CctvLinkError ? err.status : 503;
    console.error("[cctv] twin stream failed:", err?.message || err);
    return res.status(status).json({ success: false, code: err?.code || "CCTV_STREAM_UNAVAILABLE", message: err instanceof CctvLinkError ? err.message : "The camera stream could not be opened." });
  }
});

// POST /api/cctv/twin/internal/observations -> one authoritative detector
// frame. Production workers authenticate with CCTV_SERVICE_KEY. For a local
// pilot, loopback is allowed when no service key is configured so a secret is
// never put into browser code or command history.
router.post("/twin/internal/observations", (req, res, next) => {
  if (process.env.CCTV_SERVICE_KEY) return requireCctvService(req, res, next);
  const remote = String(req.socket?.remoteAddress || "");
  if (["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) return next();
  return res.status(401).json({ success: false, code: "CCTV_SERVICE_KEY_REQUIRED", message: "Not authorised." });
}, async (req, res) => {
  try {
    const result = await ingestFactoryTwinTracks(req.body || {});
    return res.json({
      success: true,
      accepted: result.accepted.length,
      acceptedObjects: result.acceptedObjects.length,
      unpositioned: (result.unpositioned || []).length,
      rejected: result.rejected,
      observedAt: result.observedAt,
    });
  } catch (error) {
    if (error instanceof TwinObservationError) {
      return res.status(error.status).json({ success: false, code: error.code, message: error.message });
    }
    console.error("[cctv] twin observation ingest failed:", error?.message || error);
    return res.status(503).json({ success: false, code: "TWIN_OBSERVATION_UNAVAILABLE", message: "The observation could not be accepted." });
  }
});

// GET /api/cctv/twin/observations -> short-lived person positions. Confirmed
// names are included only for re-verified platform administrators.
// Nothing is persisted: if the detector stops, the room empties within 4 s.
router.get("/twin/observations", authenticateCmsSession, async (req, res) => {
  try {
    const requested = String(req.query?.cameraRef || "").trim().toLowerCase();
    // authenticateCmsSession has already re-verified platform-admin status
    // against the database. Do not perform the heavier CCTV access resolution
    // on every 750 ms live-position poll for those administrators: doing so can
    // starve detector uploads and make a populated room appear empty.
    let allowedCameraKeys = null;
    if (!req.user.isAdmin) {
      const { access } = await accessFor(req);
      if (!access.allowed) return res.status(403).json({ success: false, code: access.denialCode, message: access.message });
      allowedCameraKeys = (access.cameras || []).map((camera) => String(camera.key || "").toLowerCase());
      if (requested && !allowedCameraKeys.includes(requested)) {
        return res.status(403).json({ success: false, code: "CAMERA_ACCESS_DENIED", message: "You do not have access to this camera." });
      }
    }
    // Without cameraRef a non-administrator still sees only granted cameras.
    const { observations, objects, unpositioned, feed, feeds } = visibleFactoryTwinSnapshot({
      cameraRef: requested,
      allowedCameraKeys,
      includeIdentity: req.user.isAdmin === true,
    });
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, observedAt: new Date().toISOString(), observations, objects, unpositioned, feed, feeds });
  } catch (error) {
    console.error("[cctv] twin observations failed:", error?.message || error);
    return res.status(503).json({ success: false, code: "TWIN_OBSERVATION_UNAVAILABLE", message: "Live person positions are unavailable." });
  }
});

// POST /api/cctv/sso → { url } (the page then navigates there)
router.post("/sso", authenticateCmsSession, async (req, res) => {
  try {
    const out = await signIn(req);
    res.status(out.status).json(out.body);
  } catch (err) {
    console.error("[cctv] sign-in failed:", err?.message || err);
    res.status(503).json({ success: false, code: "ACCESS_CHECK_UNAVAILABLE", message: "CCTV sign-in failed. Try again in a moment." });
  }
});

// GET /api/cctv/sso → 302 to the CCTV site (older links; top-level navigation carries the cookie)
router.get("/sso", authenticateCmsSession, async (req, res) => {
  try {
    const out = await signIn(req);
    if (out.status === 200) return res.redirect(302, out.body.url);
    res.status(out.status).json(out.body);
  } catch (err) {
    console.error("[cctv] sign-in failed:", err?.message || err);
    res.status(503).json({ success: false, code: "ACCESS_CHECK_UNAVAILABLE", message: "CCTV sign-in failed. Try again in a moment." });
  }
});

/**
 * GET /api/cctv/internal/access?id=&subject=&tv=&email=
 * Only the CCTV site (X-CCTV-Service-Key). The identifiers come from the
 * CCTV session it created from a sign-in token; the answer is re-read here.
 * Always 200 with the decision, 503 only when it could not be made.
 */
router.get("/internal/access", requireCctvService, async (req, res) => {
  const q = req.query || {};
  const access = await resolveCctvAccess({
    id: String(q.id || ""), subject: String(q.subject || ""), tv: Number(q.tv || 0), email: String(q.email || ""),
  });
  if (access.denialCode === "ACCESS_CHECK_UNAVAILABLE") return res.status(503).json({ success: false, ...access });
  res.set("Cache-Control", "no-store");
  res.json({ success: true, ...access, checkedAt: new Date().toISOString() });
});

module.exports = router;
