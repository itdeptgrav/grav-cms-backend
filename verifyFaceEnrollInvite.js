// verifyFaceEnrollInvite.js
//
// End-to-end check of the self-service face-enrolment link, against the dev
// database and — when the API is up on :5000 — its public HTTP surface.
//
// Run:  node -r dotenv/config verifyFaceEnrollInvite.js
//
// WRITES AND THEN DELETES its own rows in `face_enroll_invites`. Every row it
// creates carries createdByName "verify-harness", and the cleanup deletes
// exactly that. It READS one employee to borrow a real biometricId and never
// writes to the employee collection, or to any face gallery: the upload path
// is deliberately NOT exercised, because doing so would put harness photos
// into a real person's registration folder.
//
// The point of this harness is the gate, not the camera. What it pins:
//   · the raw token is never stored, and only its sha256 matches
//   · a live invite resolves; a revoked, expired or completed one does not
//   · the HTTP session route leaks nothing beyond a first name
//   · the HR half refuses an unauthenticated caller

"use strict";

const mongoose = require("mongoose");
const crypto = require("crypto");

const Employee = require("./models/Employee");
const FaceEnrollInvite = require("./models/HR_Models/FaceEnrollInvite");
const { hashToken, generateToken } = FaceEnrollInvite;

const MARKER = "verify-harness";
const API = process.env.SELF_API_URL || "http://localhost:5000";

let pass = 0;
let fail = 0;
let skip = 0;

function check(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`  ok    ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function skipped(name, why) {
  skip += 1;
  console.log(`  skip  ${name} — ${why}`);
}

/** GET/POST against the running API, or null if it is not up. */
async function http(method, path, body) {
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  } catch {
    return null;
  }
}

async function main() {
  await mongoose.connect(
    process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing",
  );
  console.log(`\nconnected to ${mongoose.connection.name}\n`);

  /* Borrowed read-only, purely so the invite points at a biometricId that
     really exists. Nothing about this employee is modified. */
  const employee = await Employee.findOne({
    biometricId: { $exists: true, $nin: [null, ""] },
  })
    .select("_id firstName biometricId")
    .lean();

  if (!employee) {
    console.log("  no employee with a biometricId in this database — cannot run.\n");
    process.exit(1);
  }
  console.log(`using employee ${employee.biometricId} (read-only)\n`);

  const raw = generateToken();

  console.log("token storage");
  const invite = await FaceEnrollInvite.create({
    employee: employee._id,
    biometricId: String(employee.biometricId),
    tokenHash: hashToken(raw),
    createdByName: MARKER,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  const rowRaw = JSON.stringify(invite.toObject());
  check("raw token is not stored anywhere on the row", !rowRaw.includes(raw));
  check(
    "row is found by the hash of the raw token",
    Boolean(await FaceEnrollInvite.findOne({ tokenHash: hashToken(raw) })),
  );
  check(
    "a different token does not match",
    !(await FaceEnrollInvite.findOne({ tokenHash: hashToken(generateToken()) })),
  );
  check(
    "hash is a sha256 hex digest",
    /^[0-9a-f]{64}$/.test(invite.tokenHash),
  );

  console.log("\nliveness");
  check("a fresh invite is active", invite.isActive());
  check("and gives no inactive reason", invite.inactiveReason() === null);

  const expired = new FaceEnrollInvite({
    employee: employee._id,
    biometricId: String(employee.biometricId),
    tokenHash: crypto.randomBytes(32).toString("hex"),
    createdByName: MARKER,
    expiresAt: new Date(Date.now() - 1000),
  });
  check("an expired invite is not active", !expired.isActive());
  check("and says so", expired.inactiveReason() === "expired");

  const revoked = new FaceEnrollInvite({
    employee: employee._id,
    biometricId: String(employee.biometricId),
    tokenHash: crypto.randomBytes(32).toString("hex"),
    createdByName: MARKER,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    revokedAt: new Date(),
  });
  check("a revoked invite is not active", !revoked.isActive());
  check("and says so", revoked.inactiveReason() === "revoked");

  const completed = new FaceEnrollInvite({
    employee: employee._id,
    biometricId: String(employee.biometricId),
    tokenHash: crypto.randomBytes(32).toString("hex"),
    createdByName: MARKER,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    completedAt: new Date(),
  });
  check("a completed invite is not active", !completed.isActive());
  check("and says so", completed.inactiveReason() === "completed");

  console.log("\nwhat the status object exposes");
  const status = invite.toStatus();
  const statusJson = JSON.stringify(status);
  check("status carries no raw token", !statusJson.includes(raw));
  check("status carries no token hash", !statusJson.includes(invite.tokenHash));
  check("status reports active", status.active === true);

  console.log("\npublic HTTP surface");
  const live = await http("GET", `/hr/face-enroll/session/${raw}`);
  if (!live) {
    skipped("session route", `API not reachable at ${API}`);
  } else {
    check("a live token resolves", live.status === 200, `got ${live.status}`);
    check(
      "and returns the first name",
      live.json?.firstName === (employee.firstName || "there"),
    );
    const body = JSON.stringify(live.json || {});
    check(
      "and does not leak the biometric id",
      !body.includes(String(employee.biometricId)),
    );
    check("and does not echo the token", !body.includes(raw));

    const bogus = await http(
      "GET",
      `/hr/face-enroll/session/${generateToken()}`,
    );
    check("an unknown token 404s", bogus?.status === 404, `got ${bogus?.status}`);

    const short = await http("GET", "/hr/face-enroll/session/abc");
    check("a too-short token 404s", short?.status === 404, `got ${short?.status}`);

    /* Revoke through the model, then confirm the route agrees. Two copies of
       "is this link alive" is exactly the bug this checks for. */
    invite.revokedAt = new Date();
    await invite.save();
    const afterRevoke = await http("GET", `/hr/face-enroll/session/${raw}`);
    check(
      "a revoked token is refused with 410",
      afterRevoke?.status === 410,
      `got ${afterRevoke?.status}`,
    );
    check(
      "and names revoked as the reason",
      afterRevoke?.json?.reason === "revoked",
    );

    const upload = await http("POST", `/hr/face-enroll/session/${raw}/upload`, {
      files: [{ filename: "x.jpg", data: "data:image/jpeg;base64,AAAA" }],
    });
    check(
      "a revoked token cannot upload",
      upload?.status === 410,
      `got ${upload?.status}`,
    );

    console.log("\nHR half is authenticated");
    const mint = await http(
      "POST",
      `/hr/face-enroll/invite/${employee._id}`,
      {},
    );
    check(
      "minting without a session is refused",
      mint?.status === 401,
      `got ${mint?.status}`,
    );
    const list = await http("GET", `/hr/face-enroll/invite/${employee._id}`);
    check(
      "reading invite status without a session is refused",
      list?.status === 401,
      `got ${list?.status}`,
    );
  }

  console.log("\nengine key plumbing");
  /* The bug this pins: an engine fetch written without headers. Once the
     engine required a key such a call gets a 401 — which is valid JSON, so
     nothing throws — and a perfectly healthy engine reports itself
     unavailable. The source check is the important half: a behavioural test
     only catches it when the engine happens to be running. */
  const faceConfig = require("./config/faceBiometric");
  const fs = require("fs");
  const pathMod = require("path");

  if (faceConfig.FACE_ENGINE_KEY) {
    const h = faceConfig.engineHeaders();
    check(
      "engineHeaders() carries the key",
      h["X-Face-Key"] === faceConfig.FACE_ENGINE_KEY,
    );
    check(
      "engineHeaders() still sets Content-Type",
      h["Content-Type"] === "application/json",
    );
  } else {
    skipped("engineHeaders()", "FACE_ENGINE_KEY not set in this environment");
  }

  /* Every route that talks to the engine. routes/auth/faceSignin.js was on
     this list until face sign-in was removed; the check reads these files off
     disk, so a stale entry here fails with ENOENT rather than a useful
     message. */
  const ENGINE_CALLERS = [
    "routes/HrRoutes/FaceRegistration_section.js",
    "routes/HrRoutes/FaceEnrollInvite_section.js",
  ];
  const FETCH_MARKER = "fetch(`${FACE_SERVICE_URL}";
  for (const rel of ENGINE_CALLERS) {
    const src = fs.readFileSync(pathMod.join(__dirname, rel), "utf8");
    const calls = src.split(FETCH_MARKER).slice(1);
    // The options object follows the URL closely; 400 chars covers it with
    // room to spare and stops well before the next call.
    const keyless = calls.filter((tail) => !tail.slice(0, 400).includes("engineHeaders("));
    check(
      `${rel}: every engine fetch sends the key`,
      calls.length > 0 && keyless.length === 0,
      calls.length === 0
        ? "no engine fetch found — did the marker change?"
        : `${keyless.length} of ${calls.length} without engineHeaders()`,
    );
  }

  const engineStatus = await fetch(`${faceConfig.FACE_BIOMETRIC_SERVICE_URL}/health`, {
    headers: faceConfig.engineHeaders(),
  }).then((r) => r.status, () => 0);

  if (!engineStatus) {
    skipped("engine auth", "engine not running");
  } else {
    check("the engine accepts our key", engineStatus === 200, `got ${engineStatus}`);
    if (faceConfig.FACE_ENGINE_KEY) {
      const bare = await fetch(`${faceConfig.FACE_BIOMETRIC_SERVICE_URL}/health`)
        .then((r) => r.status, () => 0);
      check("the engine refuses a keyless caller", bare === 401, `got ${bare}`);
      const wrong = await fetch(`${faceConfig.FACE_BIOMETRIC_SERVICE_URL}/health`, {
        headers: { "X-Face-Key": "not-the-key" },
      }).then((r) => r.status, () => 0);
      check("the engine refuses a wrong key", wrong === 401, `got ${wrong}`);
    }
  }
  console.log("\ncleanup");
  const del = await FaceEnrollInvite.deleteMany({ createdByName: MARKER });
  console.log(`  removed ${del.deletedCount} harness invite row(s)`);

  const leftover = await FaceEnrollInvite.countDocuments({
    createdByName: MARKER,
  });
  check("no harness rows left behind", leftover === 0);

  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped\n`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => {
  console.error("\nharness error:", err);
  try {
    const del = await FaceEnrollInvite.deleteMany({ createdByName: MARKER });
    console.error(`cleaned up ${del.deletedCount} harness row(s) after the error`);
    await mongoose.disconnect();
  } catch {
    /* already disconnected */
  }
  process.exit(1);
});
