const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const BarcodeDevice = require('../../models/Barcode_Scanner_Device/BarcodeDevice');
const Firmware = require('../../models/Barcode_Scanner_Device/Firmware');
const Machine = require('../../models/CMS_Models/Inventory/Configurations/Machine');

// ─── Multer (memory storage → written to disk after validation) ───────────────
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (file.originalname.endsWith('.bin') || file.mimetype === 'application/octet-stream') {
      cb(null, true);
    } else {
      cb(new Error('Only .bin files are allowed'));
    }
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Validate 8-char hex device ID (generated from ESP32 MAC). */
const isValidDeviceId = (id) => /^[0-9a-fA-F]{8}$/.test(id);

/**
 * Look up Machine.name by its _id.
 * Returns the name string on success, or '' if not found / invalid id.
 * Never throws — callers can treat '' as "name unavailable".
 */
const getMachineNameById = async (machineId) => {
  if (!machineId || !mongoose.Types.ObjectId.isValid(machineId)) return '';
  try {
    const machine = await Machine.findById(machineId).select('name').lean();
    return machine?.name ?? '';
  } catch (err) {
    console.error('getMachineNameById error:', err.message);
    return '';
  }
};

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/barcode-devices/name?machineId=<mongoId>
 *
 * Called by the ESP32 firmware once after WiFi connects (and only when
 * the machine name is not already cached in device flash).
 *
 * Query param: machineId — the MongoDB _id of the Machine document.
 * Response:    { machineName: "Cutting Machine 1" }
 *
 * On invalid / unknown machineId the response is still 200 with an
 * empty machineName so the device doesn't get stuck retrying forever.
 */
router.get('/name', async (req, res) => {
  const { machineId } = req.query;

  if (!machineId) {
    return res.status(400).json({
      success: false,
      message: 'machineId query param is required'
    });
  }

  const machineName = await getMachineNameById(machineId);

  if (!machineName) {
    // Return 200 with empty name rather than 404 so the device can
    // display "Not Found" gracefully without treating it as a hard error.
    console.warn(`Machine name not found for machineId: ${machineId}`);
    return res.json({ success: true, machineName: '' });
  }

  console.log(`Machine name resolved: ${machineId} → "${machineName}"`);
  return res.json({ success: true, machineName });
});

/**
 * The scheme a DEVICE must use to reach us, not the one we wish it would.
 *
 * This was hardcoded `https://`. The backend only ever ran behind Render's TLS,
 * so it was always right — until it moved onto the factory PC and started
 * serving plain HTTP on the LAN. A scanner handed an https:// URL for an HTTP
 * server fails in the TLS handshake and HTTPClient reports -1, which the screen
 * renders as "Update Failed / HTTP -1" with a perfectly green server tick.
 * Observed on device 8C40C86C, 12 Sep 2026.
 *
 * `trust proxy` is not enabled on this app, so req.protocol alone reports the
 * raw connection and would answer "http" even behind the hosted TLS proxy —
 * which would break api.grav.in in the opposite direction. x-forwarded-proto is
 * what the proxy sets, so it wins when present.
 */
/* WHAT A REAL SCANNER IMAGE LOOKS LIKE.
 *
 * The scanner refuses anything under MIN_FIRMWARE_BYTES (200000) and shows
 * "Wrong file". That guard works, but it fires at the machine, hours later,
 * on a device that has already given up on the version. The same test costs
 * nothing at upload time, where whoever uploaded it is still sitting there and
 * can pick the right file.
 *
 * Two checks, both cheap:
 *   size   - boot_app0.bin (8KB), partitions.bin (3KB) and bootloader.bin
 *            (25KB) all sit in the same build folder and are easy to pick by
 *            mistake. A real application image is over a megabyte.
 *   byte 0 - every ESP application image starts 0xE9. merged.bin, the 4MB
 *            full-flash image, starts 0xFF - it is the right size and still
 *            completely wrong, so size alone does not catch it.
 */
const MIN_FIRMWARE_BYTES = 200000;
const ESP_IMAGE_MAGIC = 0xe9;

/** null when the buffer looks like a scanner image, otherwise why it does not. */
function firmwareImageProblem(buf) {
  if (!buf || buf.length === 0) return 'the file is empty (0 bytes)';
  if (buf.length < MIN_FIRMWARE_BYTES) {
    return `only ${buf.length.toLocaleString()} bytes - that is not the application ` +
      `image. Upload GRAV_Scanner_v5_5_0.ino.bin, not bootloader.bin, ` +
      `partitions.bin or boot_app0.bin.`;
  }
  if (buf[0] !== ESP_IMAGE_MAGIC) {
    return `starts with 0x${buf[0].toString(16).padStart(2, '0').toUpperCase()}, ` +
      `not 0xE9 - this is not an ESP application image. merged.bin is the ` +
      `full-flash image and cannot be installed over the air.`;
  }
  return null;
}

/** Where a given version's binary lives on this server's disk. */
function firmwarePathFor(version) {
  return path.join(__dirname, '../../firmware', `firmware_v${version}.bin`);
}

function deviceBaseUrl(req) {
  const fwd = (req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const proto = fwd || req.protocol || 'http';
  return `${proto}://${req.get('host')}`;
}

/* WHERE THE BINARY IS FETCHED FROM - WHICH NEED NOT BE WHERE THE DEVICE ASKED.
 *
 * deviceBaseUrl() echoes back the host the scanner just talked to, which is
 * almost always right. It is wrong in one specific deployment: when the API
 * sits behind a proxy or tunnel that re-streams large responses as
 * `Transfer-Encoding: chunked`, dropping Content-Length on the way.
 *
 * Chunked is harmless for every OTHER call the scanner makes - heartbeats,
 * scan uploads and the update check are read with HTTPClient::getString(),
 * which de-chunks correctly and never needs the size in advance. It is fatal
 * for exactly this one, because the OTA path needs the length UP FRONT to size
 * the flash write, and then reads the raw socket - which on a chunked response
 * still carries the chunk framing. The scanner's own guard catches it and
 * reports "Wrong file / No size sent"; correct, but it means no device behind
 * that proxy can ever update.
 *
 * So the DOWNLOAD alone can be pointed somewhere unproxied - typically the
 * server's own LAN address, where the file already is, since this is the
 * process that wrote it - while everything else carries on through the public
 * hostname with whatever protection sits in front of it.
 *
 * Unset, this changes nothing: every caller gets exactly today's behaviour.
 * Example: OTA_DOWNLOAD_BASE_URL=http://192.168.1.80:5000
 */
/* THE DOWNLOAD URL, BUILT TO SURVIVE A TUNNEL.
 *
 * api.grav.in is a Cloudflare Tunnel. cloudflared re-streams a response on
 * its way to the edge, and a re-streamed response loses its Content-Length
 * and arrives chunked. The scanner needs that length UP FRONT to size the
 * flash write, so every OTA through the tunnel fails with "No size sent".
 *
 * A CACHED response does not have that problem: once Cloudflare holds the
 * object it knows the size and serves it with a real Content-Length, without
 * going near the tunnel at all. So the job is to make this response
 * cacheable, which takes three things:
 *
 *   1. a .bin path, so it looks like a static file rather than an API call
 *   2. Cache-Control that permits caching (it said no-cache before, which is
 *      exactly what forced cf-cache-status: DYNAMIC)
 *   3. a URL that CHANGES whenever the bytes change
 *
 * (3) is what makes (2) safe. Version numbers get reused here - the same
 * 5.6.4 has been uploaded more than once - so caching on version alone would
 * hand scanners a stale binary for as long as the TTL lasted. The fingerprint
 * is taken from the file's own size and mtime, so re-uploading anything at
 * all produces a different URL, a different cache key, and a guaranteed miss.
 * The old object simply ages out, unreachable.
 */
function firmwareFingerprint(filePath) {
  try {
    const st = fs.statSync(filePath);
    return `${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}`;
  } catch {
    return '';
  }
}

/** The full URL a scanner should fetch a given version from. */
function firmwareDownloadUrl(req, version) {
  const fp = firmwareFingerprint(firmwarePathFor(version));
  const base = `${otaDownloadBase(req)}/api/barcode-devices/firmware/download/` +
    `${encodeURIComponent(version)}.bin`;
  return fp ? `${base}?v=${fp}` : base;
}

/* PULL THE NEW BINARY THROUGH CLOUDFLARE ONCE, SO NO SCANNER IS THE FIRST.
 *
 * Caching only helps on a HIT. On a MISS Cloudflare goes to the tunnel, and
 * the tunnel is exactly what loses the Content-Length - so whichever device
 * asked first would still fail, and worse, it would mark that version failed
 * and not retry until it was power-cycled.
 *
 * So the server fetches its own public URL once, immediately after the
 * upload, and wears that miss itself. By the time any scanner checks in, the
 * object is in the edge cache with a known length.
 *
 * Deliberately fire-and-forget: the upload has already succeeded and been
 * recorded by this point, and whether a CDN warmed up is not something the
 * person uploading should wait on or see fail. It logs either way.
 */
function warmFirmwareCache(url) {
  if (!url || !/^https:\/\//i.test(url)) return; // only meaningful via the CDN
  setImmediate(async () => {
    try {
      const r = await fetch(url);
      // Read it fully - a partial read may not populate the cache.
      const buf = await r.arrayBuffer();
      console.log(
        `Firmware cache warm: HTTP ${r.status} ` +
        `cf-cache-status=${r.headers.get('cf-cache-status') || 'n/a'} ` +
        `content-length=${r.headers.get('content-length') || 'ABSENT'} ` +
        `${buf.byteLength} bytes  ${url}`
      );
    } catch (err) {
      console.warn('Firmware cache warm failed (harmless):', err.message);
    }
  });
}

function otaDownloadBase(req) {
  const override = String(process.env.OTA_DOWNLOAD_BASE_URL || '')
    .trim()
    .replace(/\/+$/, '');
  return override || deviceBaseUrl(req);
}

/**
 * POST /api/barcode-devices/check-update
 *
 * Called by the device on every WiFi connect and periodically thereafter.
 * Also serves as the device heartbeat / registration endpoint.
 *
 * Body: { deviceId, machineId, currentVersion, ipAddress, wifiSSID }
 */
router.post('/check-update', async (req, res) => {
  try {
    const { deviceId, machineId, currentVersion, ipAddress, wifiSSID } = req.body;

    if (!deviceId || !isValidDeviceId(deviceId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid device ID format'
      });
    }

    // Resolve machine name for this check-update (used to keep the
    // BarcodeDevice record in sync — does NOT change what the firmware
    // caches; that is handled by the /name endpoint above).
    const machineName = await getMachineNameById(machineId);

    // ── Upsert device record ──────────────────────────────────────────
    let device = await BarcodeDevice.findOne({ deviceId });

    if (!device) {
      device = new BarcodeDevice({
        deviceId,
        machineId:   machineId   || '',
        machineName: machineName || '',
        currentFirmwareVersion: currentVersion || '1.0.0',
        lastIpAddress: ipAddress,
        wifiSSID,
        status: 'online',
        firstSeen: new Date()
      });
    } else {
      device.lastSeen   = new Date();
      device.lastIpAddress = ipAddress;
      device.wifiSSID   = wifiSSID;
      device.status     = 'online';

      // Keep machineId / machineName current in case the user
      // reconfigured the device with a new machine assignment.
      if (machineId)   device.machineId   = machineId;
      if (machineName) device.machineName = machineName;

      if (currentVersion) device.currentFirmwareVersion = currentVersion;
    }

    await device.save();

    // ── Firmware update check ─────────────────────────────────────────
    const latestFirmware = await Firmware.findOne({ isActive: true })
      .sort({ releasedAt: -1 });

    let updateAvailable = false;
    let firmwareInfo    = null;

    if (latestFirmware) {
      const shouldUpdate =
        latestFirmware.targetDevices.includes('all') ||
        latestFirmware.targetDevices.includes(deviceId);

      if (shouldUpdate && latestFirmware.version !== device.currentFirmwareVersion) {
        updateAvailable = true;
        firmwareInfo    = {
          version:     latestFirmware.version,
          url:         firmwareDownloadUrl(req, latestFirmware.version),
          fileSize:    latestFirmware.fileSize,
          description: latestFirmware.description
        };
        console.log(`Update available for device ${deviceId}: v${latestFirmware.version}`);
      } else {
        console.log(
          `No update needed for ${deviceId}. ` +
          `Current: ${device.currentFirmwareVersion}, Latest: ${latestFirmware.version}`
        );
      }
    }

    return res.json({
      success: true,
      updateAvailable,
      currentVersion:  device.currentFirmwareVersion,
      machineName,                                       // convenience — device already has this
      ...(firmwareInfo && { firmware: firmwareInfo })
    });

  } catch (error) {
    console.error('Error in check-update:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

/**
 * GET /api/barcode-devices/firmware/download/:version
 * Stream the .bin firmware file to the device.
 */
router.get('/firmware/download/:version', (req, res) => {
  try {
    /* The URL now ends in .bin so Cloudflare treats it as a static file.
       Stripped here, so both the new `5.6.5.bin` form and the bare `5.6.5`
       every already-deployed scanner still has keep working. */
    const version        = String(req.params.version).replace(/\.bin$/i, '');
    const firmwarePath   = firmwarePathFor(version);

    console.log('Firmware download requested:', firmwarePath);

    if (!fs.existsSync(firmwarePath)) {
      console.error('Firmware file not found:', firmwarePath);
      return res.status(404).json({ success: false, message: 'Firmware not found' });
    }

    const stats = fs.statSync(firmwarePath);

    /* A 0-BYTE FILE MUST NOT BE SERVED AS A 200.
       Content-Length comes from this stat, so a zero-length file on disk sends
       `Content-Length: 0` with a 200, and the scanner reports "Wrong file / No
       size sent" - which reads like a bad upload when it is really a bad file
       on THIS disk. A 500 says plainly that the server is at fault, and the
       reason lands in the log next to it. */
    if (stats.size < MIN_FIRMWARE_BYTES) {
      console.error(
        `Firmware file is unusable: ${firmwarePath} is ${stats.size} bytes ` +
        `(expected at least ${MIN_FIRMWARE_BYTES}). Re-upload the .bin on THIS server.`
      );
      return res.status(500).json({
        success: false,
        message: `The stored file for ${version} is ${stats.size} bytes and cannot be installed. Re-upload it on this server.`,
      });
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename=firmware_v${version}.bin`);
    res.setHeader('Content-Length', stats.size);
    /* CACHEABLE, AND THAT IS THE WHOLE FIX.
       `no-cache` is what pinned this at cf-cache-status: DYNAMIC, which means
       Cloudflare streamed it straight from the tunnel and the Content-Length
       never survived. Cached, Cloudflare knows the object's size and sends it.
       Safe to cache hard because the URL carries a fingerprint of the bytes:
       different bytes, different URL. A request without one is treated as
       uncacheable, so an old scanner asking the bare URL cannot be pinned to a
       stale copy either. */
    res.setHeader(
      'Cache-Control',
      req.query.v
        ? 'public, max-age=31536000, immutable'
        : 'no-cache'
    );
    res.setHeader('Access-Control-Allow-Origin', '*');

    const fileStream = fs.createReadStream(firmwarePath);
    fileStream.pipe(res);
    fileStream.on('error', (err) => {
      console.error('Error streaming firmware:', err);
      // Headers already sent — can't send JSON; just destroy the connection.
      res.destroy();
    });

  } catch (error) {
    console.error('Error in firmware download:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * GET /api/barcode-devices
 * List all registered devices (admin dashboard).
 */
router.get('/', async (_req, res) => {
  try {
    const devices = await BarcodeDevice.find({})
      .sort({ lastSeen: -1 })
      .select('deviceId machineId machineName currentFirmwareVersion lastSeen status wifiSSID firstSeen');

    return res.json({ success: true, devices });
  } catch (error) {
    console.error('Error fetching devices:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * GET /api/barcode-devices/:deviceId
 * Get a single device record.
 */
router.get('/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;

    if (!isValidDeviceId(deviceId)) {
      return res.status(400).json({ success: false, message: 'Invalid device ID format' });
    }

    const device = await BarcodeDevice.findOne({ deviceId });
    if (!device) {
      return res.status(404).json({ success: false, message: 'Device not found' });
    }

    return res.json({ success: true, device });
  } catch (error) {
    console.error('Error fetching device:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * POST /api/barcode-devices/firmware
 * Upload a new firmware .bin file.
 */
router.post('/firmware', upload.single('firmware'), async (req, res) => {
  try {
    const { version, description, targetDevices } = req.body;
    const file = req.file;

    console.log('Firmware upload — version:', version, '| file:', file?.originalname ?? 'none');

    if (!version) {
      return res.status(400).json({ success: false, message: 'Version is required' });
    }
    if (!file) {
      return res.status(400).json({ success: false, message: 'Firmware file is required' });
    }

    /* REFUSE IT HERE, RATHER THAN STORING IT AND LETTING FIFTY SCANNERS FIND OUT.
       Writing a truncated or wrong file to disk creates a record that looks
       perfect in the build list and fails at every machine that tries it - and
       each device marks the version failed, so it will not retry even once the
       file is fixed. Cheaper to say no now. */
    const problem = firmwareImageProblem(file.buffer);
    if (problem) {
      console.error('Firmware upload REJECTED - ' + problem);
      return res.status(400).json({
        success: false,
        message: `That file was not accepted: ${problem}`,
      });
    }

    // Persist .bin to disk
    const firmwareDir = path.join(__dirname, '../../firmware');
    if (!fs.existsSync(firmwareDir)) fs.mkdirSync(firmwareDir, { recursive: true });

    const filename  = `firmware_v${version}.bin`;
    const filePath  = path.join(firmwareDir, filename);
    fs.writeFileSync(filePath, file.buffer);
    console.log('Firmware saved to:', filePath);

    const firmwareUrl = firmwareDownloadUrl(req, version);

    // Take the cache miss here, on the server, rather than leaving it for
    // whichever scanner happens to check in first.
    warmFirmwareCache(firmwareUrl);

    // Deactivate any existing record with the same version
    /* Restored with the upsert below: the original computed this immediately
       before building the document, and replacing that block dropped it. */
    let targetDevicesArray = ['all'];
    if (targetDevices) {
      try {
        targetDevicesArray = JSON.parse(targetDevices);
      } catch {
        targetDevicesArray = [targetDevices];
      }
    }
    if (!Array.isArray(targetDevicesArray) || targetDevicesArray.length === 0) {
      targetDevicesArray = ['all'];
    }

    /* UPSERT, not deactivate-then-insert.
     *
     * The previous sequence deactivated every record with this version and THEN
     * inserted a new one. `version` carries a UNIQUE index, so re-uploading a
     * version already present failed on the insert — AFTER the deactivate had
     * already committed. The build was left switched OFF, check-update stopped
     * offering it, devices silently fell back to the previous version, and the
     * page showed only "Server error".
     *
     * Re-uploading the same version is the ordinary thing to do when a build is
     * corrected without bumping the number, so it has to be safe. One atomic
     * replace makes it so.
     */
    const firmware = await Firmware.findOneAndUpdate(
      { version },
      {
        $set: {
          version,
          cloudinaryUrl: firmwareUrl,
          fileSize:      file.size,
          description,
          isActive:      true,
          targetDevices: targetDevicesArray,
          releasedAt:    new Date()
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.json({
      success: true,
      message: 'Firmware uploaded successfully',
      firmware: { version, url: firmwareUrl, fileSize: file.size, description }
    });

  } catch (error) {
    console.error('Error uploading firmware:', error);
    return res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
});

/**
 * GET /api/barcode-devices/firmware/list
 * Return full firmware history for the admin dashboard.
 */
router.get('/firmware/list', async (_req, res) => {
  try {
    const firmwareList = await Firmware.find({})
      .sort({ releasedAt: -1 })
      .select('version cloudinaryUrl fileSize description releasedAt isActive targetDevices');

    return res.json({ success: true, firmwareList });
  } catch (error) {
    console.error('Error fetching firmware list:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;