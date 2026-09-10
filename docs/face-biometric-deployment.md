# Hosting the face engine on GravServer

Written against `GRAVSERVER_INFRASTRUCTURE_HANDOFF.md` (snapshot 2026-09-10,
host `RISHALIENWARE`). Every value in that snapshot — ports, PM2 process names,
free memory, LAN address — is described there as stale-able. **Inspect before
relying on any of it, including anything quoted below.**

## The short version

The face engine is a Python process that must run **on the same machine as the
API**, reachable only over loopback. It is not a web app, it gets no hostname,
and it must never be put behind a Cloudflare tunnel.

```
   cms.grav.in ──► Cloudflare ──► RISHALIENWARE
                                    │
                                    ├── grav-cms (Next.js, PM2)      :3001
                                    ├── grav-cms-backend (PM2)       :5000
                                    │        │
                                    │        │ 127.0.0.1 only, never routed
                                    │        ▼
                                    └── grav-face-engine (PM2)       :5001
                                             │
                                             ▼
                                    C:\GravServer\data\face-biometric
                                    (photos — OUTSIDE any app directory)
```

Because the API and the engine share a host, `FACE_BIOMETRIC_SERVICE_URL` stays
`http://127.0.0.1:5001` and **no tunnel, hostname or DNS record is involved**.

An earlier draft of this document assumed the API was hosted elsewhere and
described a Cloudflare tunnel for the engine. On GravServer that would publish a
service whose entire security model is that it is not reachable.

## The one thing that will lose the photos

**`FACE_BIOMETRIC_ROOT` must point outside every application directory.**

The deployment watcher replaces the app working tree on each promotion. Photos
under `C:\GravServer\apps\<backend>\...` would be untracked files inside a
directory that deployment automation manages, and the handoff warns specifically
against `git clean` behaviour that removes untracked files. Registrations are
not re-creatable: every employee would have to sit for their photographs again.

Put them where deployment never looks:

```
C:\GravServer\data\face-biometric\
    REGISTERED_PEOPLE\        one folder per employee, named by biometricId
    biometric_people.json     folder -> employee mapping
    biometric_status.json     exported snapshot (fallback only)
```

There is a private Drive backup and the embeddings are in MongoDB, so a loss is
*recoverable* — but recovery is manual, and the local folder is what the engine
actually reads.

## Step 1 — Inspect (do not skip)

```powershell
hostname
pm2 status
Get-NetTCPConnection -State Listen | Sort-Object LocalPort |
  Select-Object LocalAddress,LocalPort,OwningProcess
Get-Service cloudflared, MongoDB
Get-CimInstance Win32_OperatingSystem |
  Select-Object TotalVisibleMemorySize,FreePhysicalMemory
```

Three things to establish:

1. **Is 5001 free?** The handoff lists 3000/3001/3002/3300/4500/5000 as *not
   exhaustive*. If 5001 is taken, pick another and set `FACE_BIOMETRIC_PORT` —
   nothing hardcodes it.
2. **Does a `grav-face-engine` process already exist?** PM2 names must be unique.
3. **Free memory.** The engine holds one InsightFace model; budget roughly 700MB
   resident. On 32GB that is nothing, but check rather than assume.

## Step 2 — Python

The engine is Python; everything else on GravServer is Node. This is the one
place that differs, and it does **not** mean Docker or WSL — a native Windows
Python is what is wanted, which is what the handoff asks for.

```powershell
python -m venv C:\GravServer\venvs\face
C:\GravServer\venvs\face\Scripts\python.exe -m pip install --upgrade pip
C:\GravServer\venvs\face\Scripts\python.exe -m pip install numpy opencv-python-headless onnxruntime insightface
```

`opencv-python-headless`, not `opencv-python`: the server has no display, and
the headless build drops the GUI dependencies.

**The model downloads on first run** — buffalo_l, about 280MB, into
`%USERPROFILE%\.insightface`. That lands in the home directory of **whichever
Windows account PM2 runs as**, which is not necessarily the account you are
typing in. Start the engine once by hand as that account, watch it print
`buffalo_l ready`, and only then hand it to PM2. A first boot under PM2 with no
model cached looks exactly like a hang.

## Step 3 — The data directory

```powershell
New-Item -ItemType Directory -Force C:\GravServer\data\face-biometric\REGISTERED_PEOPLE
```

Confirm the PM2 account can write there.

## Step 4 — Environment

These go in the **backend's** `.env`. Back it up before editing, per the
handoff's rules, and keep its contents out of deployment logs.

```bash
# Where the photos live — OUTSIDE any app directory. See above.
FACE_BIOMETRIC_ROOT=C:/GravServer/data/face-biometric

# The interpreter that has insightface.
FACE_PYTHON=C:/GravServer/venvs/face/Scripts/python.exe

# Loopback. No tunnel, no hostname. Change only if 5001 was taken.
FACE_BIOMETRIC_SERVICE_URL=http://127.0.0.1:5001
FACE_BIOMETRIC_PORT=5001

# What enrolment links are built from. Without it the backend falls back to the
# request Origin — usually right, still a guess.
FRONTEND_URL=https://cms.grav.in

# Optional on loopback, recommended on a shared host: without it, any process on
# this machine can POST a face into any employee's gallery. Same value on both
# sides. The engine refuses to start non-loopback without one.
FACE_ENGINE_KEY=<openssl rand -base64 32>
```

Forward slashes work through both Node and Python on Windows and avoid the
backslash-escaping problem in `.env` files.

Set `FACE_BIOMETRIC_ROOT` and `FACE_PYTHON` **only** on the host that runs the
engine. The API never touches those paths.

## Step 5 — Prove it by hand before PM2

```powershell
cd C:\GravServer\apps\<backend>
npm run face:service
```

Expect:

```
   buffalo_l ready (CPU, det_size=(640, 640))
gallery: N employee(s) usable for sign-in — ...
face service on http://127.0.0.1:5001   auth=key
```

`auth=loopback-only` there means `FACE_ENGINE_KEY` did not reach the process.

Then from another shell:

```powershell
curl.exe -s -H "X-Face-Key: <the key>" http://127.0.0.1:5001/health
```

Do not continue until this works by hand. A PM2 process that fails at startup is
much harder to read than a terminal printing the reason.

## Step 6 — PM2

The entry point is `services/face-biometric/run.js` — a **Node** script that
reads the `FACE_*` keys from `.env`, resolves the interpreter and data paths,
fixes the console encoding, and spawns Python. Giving PM2 the Node wrapper
rather than `python.exe` directly means the engine is managed exactly like every
other GravServer process, and one file decides those paths.

```powershell
cd C:\GravServer\apps\<backend>
pm2 start services/face-biometric/run.js --name grav-face-engine -- service
pm2 status
pm2 logs grav-face-engine --lines 50
pm2 save
```

Verify restart behaviour and that the environment survives it. The handoff is
explicit that boot persistence is not to be claimed without testing it in a
maintenance window.

## Step 7 — Restart the API, then verify

The backend reads `FACE_BIOMETRIC_SERVICE_URL` and `FACE_ENGINE_KEY` at boot.

```powershell
pm2 restart <backend-process-name>
curl.exe -s http://127.0.0.1:5000/hr/face-registration/health
```

Expect `"running": true` and a model name. The three failure signatures are
deliberately distinct, because they need different actions:

| Symptom | Cause |
|---|---|
| `face_service_unreachable` | engine not running, or the URL/port disagree |
| `face_engine_unauthorised` | the two `FACE_ENGINE_KEY` values differ |
| `face_service_timeout` | engine running but busy — **not** a restart signal |

Then in the CMS: open any employee's **Biometric** tab — it should show
readiness rather than "the face service is not running". Generate a
self-registration link and open it on a phone: it must greet by first name with
**Start enabled**. Start disabled means the page correctly detected an
unreachable engine.

## Step 8 — The deployment gotcha

The engine's code lives inside the backend repo (`services/face-biometric/`), so
a backend deployment updates the Python files — **but restarts only the backend
process.** The engine keeps running the code it loaded at start.

After any deployment that touches `services/face-biometric/*.py`:

```powershell
pm2 restart grav-face-engine
```

Until that is wired into the deploy step, treat it as a manual follow-up. It is
the most likely way for this to go quietly wrong: everything looks deployed, and
the engine is running last week's rules.

Restarting the engine drops its in-memory gallery and rebuilds it from disk — a
few seconds during which registration reports the service as busy. Harmless, but
not something to do mid-enrolment.

## Step 9 — Record it

Per the handoff's new-project standard:

```text
Project name:       grav-face-engine
Repository:         grav-cms-backend (services/face-biometric)
Production branch:  main
Server path:        C:\GravServer\apps\<backend>\services\face-biometric
Runtime:            Python 3.x via C:\GravServer\venvs\face
Build command:      (none — pip install once)
Start command:      pm2 start services/face-biometric/run.js --name grav-face-engine -- service
PM2 process name:   grav-face-engine
Local port:         5001 (loopback only — NOT routed)
Public hostname:    (none, deliberately)
Health endpoint:    http://127.0.0.1:5001/health   (requires X-Face-Key)
Database:           none directly; the API writes face_photos to MongoDB
Environment file:   the backend's .env (FACE_* keys)
Log location:       PM2 logs, grav-face-engine
Deployment method:  ships with the backend repo; needs a manual pm2 restart
Rollback method:    pm2 stop grav-face-engine — the API degrades gracefully
Data directory:     C:\GravServer\data\face-biometric   (NOT in an app dir)
```

## What happens if you deploy without any of this

Nothing breaks. Verified against a backend pointed at a dead engine:

- everything unrelated to faces is unaffected;
- **sign-in is unaffected** — face login was removed, so nothing in the login
  path touches the engine;
- the HR Biometric tab answers `HTTP 200` with "the face service is not
  running", not a 500;
- HR **can** still generate a registration link (that only needs the database);
- the employee opens it, is greeted by name, and sees "registration service is
  offline" with **Start disabled** — so nobody takes photos that would be
  refused.

Face registration is simply inert until the engine is up. That is a safe state
to deploy into, which means the engine can be set up after the code ships rather
than as a precondition.

## What this does not solve

**There is no liveness check.** A printed photograph held to a camera passes the
quality gate as readily as a person does. Face SIGN-IN has been removed, so this
is not an authentication weakness today — but anything built on these
registrations later (a gate, a kiosk, another system reading the stored
embeddings) has to decide for itself whether it needs liveness. It does not get
it from here.

**The engine is single-instance.** It holds its gallery in memory and rebuilds
from disk. Two engines against one data directory is not a configuration anyone
has tested.

**One engine, one site.** A second factory needs a second engine, its own data
directory, and a routing decision the code does not currently make.
