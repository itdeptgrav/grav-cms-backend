// test/production/s0-security-containment.test.js
//
// PRODUCTION S0 — SECURITY CONTAINMENT.
//
// What this suite holds:
//
//   · S0a — the manual cleanup HTTP trigger is unreachable. It used to run
//     `productionSyncService.manualCleanup()`, which deletes ProductionTracking
//     scan evidence for completed work orders, with no auth guard. It is removed,
//     not guarded, and the scheduled 02:00 purge stays disabled.
//
//   · The floor-device routes keep their current behaviour and stay reachable
//     WITHOUT credentials. They must not acquire browser-session auth before an
//     accepted device-identity contract exists — doing so would stop every
//     scanner. These tests pin that, so a later firmware-admin guard cannot
//     break the devices by accident.
//
//   · S0b / S0c are NOT implemented. They are recorded below as `todo`s with the
//     exact tests they must satisfy. They stopped because enforcing them today
//     would lock out every current user: there are no `production-supervisor`
//     department grants, the firmware admin page sends no credentials at all, and
//     the manual-sync call from the PM dashboard swallows failures silently.
//
// ── WHY S0a IS PROVED AGAINST SOURCE ────────────────────────────────────────
// The trigger lived inline in `server.js`, and `server.js` cannot be booted in a
// unit test: it starts Firebase, sockets, schedulers and seeding. So the proof
// is a static reading of its EXECUTABLE route table (comments stripped), plus
// every router mounted on a prefix that could reach the path. Extracting the
// inline Production routes into a mountable router is S0d, and is what will
// make these routes testable behaviourally.
"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");
const mongoose = require("mongoose");

const BarcodeDevice = require("../../models/Barcode_Scanner_Device/BarcodeDevice");
const Firmware = require("../../models/Barcode_Scanner_Device/Firmware");
const Machine = require("../../models/CMS_Models/Inventory/Configurations/Machine");

const ROOT = path.join(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** Source with block and line comments removed, so prose cannot pass or fail a check. */
const executable = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const CLEANUP_PATH = "/api/cms/production/cleanup/manual";

/* ══ S0a ═══════════════════════════════════════════════════════════════════ */

describe("S0a — the manual cleanup trigger is unreachable", () => {
  const server = executable(read("server.js"));

  test("server.js registers no route for the cleanup path, under any method", () => {
    const registrations = [...server.matchAll(
      /app\.(get|post|put|patch|delete|all|use)\(\s*["'`]([^"'`]+)["'`]/g,
    )].map((m) => ({ method: m[1], path: m[2] }));
    expect(registrations.length).toBeGreaterThan(50);  // the table was actually read

    const hits = registrations.filter((r) => r.path === CLEANUP_PATH
      || r.path.startsWith("/api/cms/production/cleanup"));
    expect(hits).toEqual([]);
  });

  test("no router mounted on a prefix that could reach the path defines a cleanup route", () => {
    /* Resolve `const X = require("./routes/…")` so a mount by variable is
       followed to its file, as well as `app.use(prefix, require(…))`. */
    const requires = new Map(
      [...server.matchAll(/const\s+(\w+)\s*=\s*require\(\s*["'`](\.\/routes\/[^"'`]+)["'`]\s*\)/g)]
        .map((m) => [m[1], m[2]]),
    );
    const mounts = [...server.matchAll(/app\.use\(\s*["'`]([^"'`]+)["'`]\s*,([^;]*?)\)\s*;/gs)];

    const reaching = [];
    for (const [, prefix, rest] of mounts) {
      if (!CLEANUP_PATH.startsWith(prefix.replace(/\/$/, ""))) continue;
      const inline = rest.match(/require\(\s*["'`](\.\/routes\/[^"'`]+)["'`]\s*\)/);
      const named = [...rest.matchAll(/\b(\w+)\b/g)].map((m) => requires.get(m[1])).find(Boolean);
      const file = inline?.[1] || named;
      if (!file) continue;
      const resolved = require.resolve(path.join(ROOT, file));
      reaching.push({ prefix, file: path.relative(ROOT, resolved) });
    }

    const offenders = reaching.filter(({ prefix, file }) => {
      const src = executable(fs.readFileSync(path.join(ROOT, file), "utf8"));
      const remainder = CLEANUP_PATH.slice(prefix.replace(/\/$/, "").length) || "/";
      return /cleanup/i.test(remainder)
        && new RegExp(`router\\.(get|post|put|patch|delete|all)\\(\\s*["'\`]${remainder.replace(/\//g, "\\/")}["'\`]`).test(src);
    });
    expect(offenders).toEqual([]);
  });

  test("nothing reachable over HTTP calls the deleting function", () => {
    const callers = [];
    const scan = (dir) => {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) { scan(rel); continue; }
        if (!entry.name.endsWith(".js")) continue;
        const src = executable(read(rel));
        if (/\bmanualCleanup\s*\(|\bcleanupOldTrackingData\s*\(/.test(src)) callers.push(rel);
      }
    };
    scan("routes");
    const inServer = /\bmanualCleanup\s*\(|\bcleanupOldTrackingData\s*\(/.test(server);
    expect({ routes: callers, server: inServer }).toEqual({ routes: [], server: false });
  });

  test("inside the service, the deletion is reachable only from manualCleanup and the disabled cron", () => {
    const svc = executable(read("services/productionSyncService.js"));
    const callSites = [...svc.matchAll(/\bcleanupOldTrackingData\s*\(/g)].length;
    const definition = /async\s+cleanupOldTrackingData\s*\(/.test(svc) ? 1 : 0;
    /* One definition, one call from `manualCleanup`, one from the cron inside
       `initialize()` — and no other caller could have been added quietly. */
    expect(callSites - definition).toBe(2);
    expect(svc).toMatch(/manualCleanup\s*\(\s*\)\s*\{\s*await this\.cleanupOldTrackingData\(\)/);
    expect(svc).toMatch(/cron\.schedule\(\s*"0 2 \* \* \*"[\s\S]{0,120}cleanupOldTrackingData\(\)/);
  });

  test("the scheduled purge stays disabled: nothing calls initialize()", () => {
    const serverCalls = /productionSyncService\.initialize\s*\(\s*\)/.test(server);
    expect(serverCalls).toBe(false);
    /* The disabled line is still visible in the raw source, so re-enabling it
       is a deliberate edit rather than an accident. */
    expect(read("server.js")).toMatch(/\/\/\s*productionSyncService\.initialize\(\);/);
  });
});

/* ══ THE DEVICE ROUTES KEEP THEIR BEHAVIOUR ════════════════════════════════ */

describe("floor-device routes stay open and behave exactly as before", () => {
  let server, base;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/barcode-devices", require("../../routes/Barcode_Scanner_Device/barcode-scanner-hardware-routes"));
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}/api/barcode-devices`;
    await BarcodeDevice.syncIndexes();
    await Firmware.syncIndexes();
  });

  afterAll(async () => { await new Promise((r) => server.close(r)); });

  /* No Authorization header and no cookie — exactly what a scanner sends. */
  const device = (p, { method = "GET", body } = {}) => fetch(`${base}${p}`, {
    method,
    headers: { "Content-Type": "application/json", "User-Agent": "ESP32HTTPClient" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

  test("check-update offers the active firmware to a device on an older version", async () => {
    await Firmware.create({
      version: "2.4.0", cloudinaryUrl: "https://example.invalid/fw.bin",
      fileSize: 1024, description: "Scanner build", isActive: true, targetDevices: ["all"],
    });
    const res = await device("/check-update", {
      method: "POST",
      body: { deviceId: "a1b2c3d4", currentVersion: "2.3.0", ipAddress: "10.0.0.5", wifiSSID: "floor" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true, updateAvailable: true, currentVersion: "2.3.0", machineName: "",
      firmware: { version: "2.4.0", fileSize: 1024, description: "Scanner build" },
    });
    expect(res.body.firmware.url).toMatch(/\/api\/barcode-devices\/firmware\/download\/2\.4\.0$/);
    /* The device record is created as it always was. */
    const stored = await BarcodeDevice.findOne({ deviceId: "a1b2c3d4" }).lean();
    expect(stored).toMatchObject({ currentFirmwareVersion: "2.3.0", status: "online" });
  });

  test("check-update reports no update to a device already on the active version", async () => {
    await Firmware.deleteMany({});
    await Firmware.create({
      version: "3.0.0", cloudinaryUrl: "https://example.invalid/fw3.bin",
      isActive: true, targetDevices: ["all"],
    });
    const res = await device("/check-update", {
      method: "POST", body: { deviceId: "0a0b0c0d", currentVersion: "3.0.0" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, updateAvailable: false, currentVersion: "3.0.0" });
    expect(res.body.firmware).toBeUndefined();
  });

  test("check-update still validates the device id", async () => {
    const res = await device("/check-update", { method: "POST", body: { deviceId: "not-hex!" } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, message: "Invalid device ID format" });
  });

  test("firmware download answers without credentials, and 404s an unknown build", async () => {
    const res = await device("/firmware/download/9.9.9-not-a-build");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, message: "Firmware not found" });
  });

  test("the device-name route answers without credentials", async () => {
    expect((await device("/name")).status).toBe(400);
    const machine = await Machine.create({
      name: "Line 4 SNLS", type: "SNLS", model: "DDL-8700", serialNumber: `SN-${Date.now()}`,
      powerConsumption: "250W", location: "Floor 1",
      createdBy: new mongoose.Types.ObjectId(),
      lastMaintenance: new Date("2026-08-01"), nextMaintenance: new Date("2026-11-01"),
    });
    const named = await device(`/name?machineId=${machine._id}`);
    expect(named.status).toBe(200);
    expect(named.body).toEqual({ success: true, machineName: "Line 4 SNLS" });
    const unknown = await device(`/name?machineId=${new mongoose.Types.ObjectId()}`);
    expect(unknown.body).toEqual({ success: true, machineName: "" });
  });

  test("the device routes carry no session guard in source", () => {
    /* A router-wide `router.use(auth)` would silently put browser-session auth
       on check-update, download and name. It must not appear until a device
       identity contract is accepted. */
    const src = executable(read("routes/Barcode_Scanner_Device/barcode-scanner-hardware-routes.js"));
    expect(src).not.toMatch(/router\.use\(/);
    for (const route of ["'/check-update'", "'/firmware/download/:version'", "'/name'"]) {
      const line = src.split("\n").find((l) => l.includes(route) && /router\.(get|post)\(/.test(l));
      expect(line).toBeDefined();
      /* The handler is the second argument: nothing sits between path and handler. */
      expect(line).toMatch(new RegExp(`router\\.(get|post)\\(\\s*${route.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\s*,\\s*(async\\s*)?\\(`));
    }
  });
});

/* ══ S0b / S0c — STOPPED, AWAITING APPROVAL ════════════════════════════════ */

describe("S0b / S0c — not enforced; these are the tests they must satisfy", () => {
  test.todo("S0b: anonymous POST /api/barcode-devices/firmware writes no file and no Firmware record");
  test.todo("S0b: an authenticated user without a live production-supervisor OWNER grant is refused, before multer buffers the upload");
  test.todo("S0b: isAdmin, the legacy production_supervisor login and departmentWrites grant nothing");
  test.todo("S0b: GET /api/barcode-devices, /:deviceId and /firmware/list are refused anonymously");
  test.todo("S0b: check-update, firmware download and name are unchanged (the tests above keep passing)");
  test.todo("S0c: anonymous POST /api/cms/production/sync/manual changes no work order");
  test.todo("S0c: anonymous POST /api/cms/production/employee-sync/manual changes no progress record");
  test.todo("S0c: a user without a live production-supervisor APPROVER grant is refused on both");
});
