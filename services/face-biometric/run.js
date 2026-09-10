#!/usr/bin/env node
"use strict";

/**
 * run.js — the one entry point for every face-engine command.
 *
 * WHY THIS IS NODE AND NOT THE SHELL SCRIPT IT REPLACES: `npm run face:service`
 * used to be `bash run.sh`, and on Windows `bash` is whichever bash is first on
 * PATH — which in PowerShell is **WSL**. run.sh then executed inside Linux,
 * where `C:/Users/.../python.exe` is not a path that exists, and the only
 * symptom was "FACE_PYTHON is not an executable interpreter" naming a file that
 * plainly was there. Git Bash worked; PowerShell did not; nothing said why.
 *
 * npm already guarantees a Node, so using it removes the guess. run.sh is kept
 * as a thin shim that calls this, so there is still exactly one place that
 * decides the interpreter and the data paths.
 *
 *     node services/face-biometric/run.js service
 *     node services/face-biometric/run.js status
 *
 * Extra arguments are passed straight through:
 *
 *     npm run face:service -- --host 0.0.0.0
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const HERE = __dirname;
const ROOT = path.resolve(HERE, "..", "..");

/**
 * Read FACE_* keys out of .env.
 *
 * Read, not sourced: a .env is a key/value file, not a shell script, and a real
 * value in this backend's .env contains a space. The real environment wins, so
 * a one-off override on the command line still works.
 */
function loadFaceEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^(FACE_[A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, key, rawValue] = m;
    if (process.env[key]) continue;
    process.env[key] = rawValue.replace(/^(["'])(.*)\1$/, "$2");
  }
}

loadFaceEnv();

/* Same defaults the config module uses. Kept in step deliberately: the engine
   and the API must agree on where the photos are, or one of them is looking at
   an empty folder. */
const isWindows = process.platform === "win32";

const FACE_PYTHON =
  process.env.FACE_PYTHON ||
  path.join(
    os.homedir(),
    "phone_detc_venv",
    isWindows ? "Scripts" : "bin",
    isWindows ? "python.exe" : "python",
  );

const FACE_BIOMETRIC_ROOT =
  process.env.FACE_BIOMETRIC_ROOT ||
  (isWindows
    ? path.join(os.homedir(), "GRAV_BIOMETRIC")
    : "/Volumes/ESD-USB/GRAV_BIOMETRIC");

const REGISTERED_DIR =
  process.env.FACE_BIOMETRIC_REGISTERED_DIR ||
  path.join(FACE_BIOMETRIC_ROOT, "REGISTERED_PEOPLE");
const PEOPLE_MAP =
  process.env.FACE_BIOMETRIC_PEOPLE_MAP ||
  path.join(FACE_BIOMETRIC_ROOT, "biometric_people.json");
const STATUS_FILE =
  process.env.FACE_BIOMETRIC_STATUS_FILE ||
  path.join(FACE_BIOMETRIC_ROOT, "biometric_status.json");

const PORT = process.env.FACE_BIOMETRIC_PORT || "5001";

/* onnxruntime decides its CPU thread pool at session creation and, left alone,
   does not use the machine it is on. Measured here on 12 logical cores:
   recognition 435ms at the default, 296ms with the pool told the truth. Set
   rather than overridden, so an operator who has tuned it keeps their value. */
const cpuThreads = String(os.cpus?.().length || 4);

const childEnv = {
  ...process.env,
  OMP_NUM_THREADS: process.env.OMP_NUM_THREADS || cpuThreads,
  FACE_BIOMETRIC_ROOT,
  FACE_BIOMETRIC_REGISTERED_DIR: REGISTERED_DIR,
  FACE_BIOMETRIC_PEOPLE_MAP: PEOPLE_MAP,
  FACE_BIOMETRIC_STATUS_FILE: STATUS_FILE,
  /* The engine prints non-ASCII status characters. A Windows console defaults
     to cp1252, which turns that into a crash on a purely informational line. */
  PYTHONIOENCODING: process.env.PYTHONIOENCODING || "utf-8",
};

function die(lines) {
  for (const l of lines) console.error(l);
  process.exit(1);
}

if (!fs.existsSync(FACE_PYTHON)) {
  die([
    `FACE_PYTHON does not exist: ${FACE_PYTHON}`,
    "",
    `Set FACE_PYTHON in ${path.join(ROOT, ".env")} to a Python that has`,
    "insightface installed. To build one:",
    "",
    isWindows
      ? "  python -m venv %USERPROFILE%\\phone_detc_venv"
      : "  python3 -m venv ~/phone_detc_venv",
    isWindows
      ? "  %USERPROFILE%\\phone_detc_venv\\Scripts\\python.exe -m pip install numpy opencv-python-headless onnxruntime insightface"
      : "  ~/phone_detc_venv/bin/python -m pip install numpy opencv-python-headless onnxruntime insightface",
    "",
    isWindows
      ? "  FACE_PYTHON=C:/Users/<you>/phone_detc_venv/Scripts/python.exe"
      : "  FACE_PYTHON=$HOME/phone_detc_venv/bin/python",
  ]);
}

if (!fs.existsSync(REGISTERED_DIR)) {
  console.error(`warning: no registration directory at ${REGISTERED_DIR}`);
  console.error(
    `         set FACE_BIOMETRIC_ROOT (or _REGISTERED_DIR) in ${path.join(ROOT, ".env")}`,
  );
}

const [, , rawCmd, ...rest] = process.argv;
const cmd = rawCmd || "service";

const COMMANDS = {
  service: ["face_biometric_server.py", "--port", String(PORT)],
  status: ["face_biometric.py", "--hr-map-status"],
  check: ["face_biometric.py", "--check-registered"],
  test: ["test_face_biometric.py"],
  link: ["face_biometric.py"],
};

if (!COMMANDS[cmd]) {
  die([`usage: run.js {${Object.keys(COMMANDS).join("|")}} [args...]`]);
}

const [script, ...fixedArgs] = COMMANDS[cmd];
const args = [path.join(HERE, script), ...fixedArgs, ...rest];

const child = spawn(FACE_PYTHON, args, {
  stdio: "inherit",
  env: childEnv,
  cwd: HERE,
});

child.on("error", (err) => {
  die([`could not start ${FACE_PYTHON}`, String(err.message)]);
});
/* Signal or code, whichever ended it — an engine killed by Ctrl-C should not
   look like a clean exit to whatever called this. */
child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
