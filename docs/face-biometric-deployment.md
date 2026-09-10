# Running the face engine in production

## The thing that confuses everyone first

**You do not open a port on `grav.in`.** The hosted API and the face engine are
not the same machine and never will be, so "which port on the domain" is the
wrong question. The right one is *"what URL does the API call to reach the
engine"* — and the answer is an ordinary `https://` hostname on port 443, with
no port in it at all.

```
  browser                    hosted API                  punch-in machine
  (cms.grav.in)              (Render)                    (factory floor)
      │                          │                              │
      │  POST /hr/face-enroll/session/<token>/upload             │
      ├─────────────────────────►│                              │
      │                          │  POST /register/upload       │
      │                          │  X-Face-Key: <secret>        │
      │                          ├─────────────────────────────►│
      │                          │   https://face.grav.in:443   │  Python
      │                          │◄─────────────────────────────┤  InsightFace
      │◄─────────────────────────┤        {"readiness":"READY"} │  + the photos
```

The engine has to run where the photos are. `REGISTERED_PEOPLE`, the gallery
and the model live on the punch-in machine's disk. Render's filesystem is
ephemeral and has no camera attached, so the engine cannot move there.

### Why the default fails in production, silently

`FACE_BIOMETRIC_SERVICE_URL` defaults to `http://127.0.0.1:5001`. On a laptop
that is correct. On Render, `127.0.0.1` is *Render's own loopback*, where
nothing is listening — so every face call answers
`face_service_unreachable` and the UI says the service is offline. Nothing is
broken; it is pointing at the wrong machine.

## Setting it up

### 1. A hostname for the engine

The punch-in machine is behind a home/office router with no static IP, so the
engine must dial **out**. `cloudflared` is already vendored in this repo.

```bash
cloudflared tunnel login
cloudflared tunnel create grav-face
cloudflared tunnel route dns grav-face face.grav.in
cloudflared tunnel run --url http://127.0.0.1:5001 grav-face
```

No port forwarding, no firewall rule, no static IP. Cloudflare terminates TLS
and you get `https://face.grav.in` on 443.

Run it as a service so it survives reboots (`cloudflared service install` on
Windows, a `launchd` plist on macOS).

### 2. A shared secret — not optional

The engine has no user accounts. Before this was added it simply trusted its
caller, which was safe only because it was bound to loopback. **A tunnel makes
it reachable by anyone who learns the hostname**, and unauthenticated it would:

- accept `/register/upload` — enrol a stranger's face against an employee ID,
  which puts a stranger's face on file as an employee;
- answer `/health` with `gallery: [...]`, i.e. **every enrolled biometric ID**;
- answer `/verify` for anybody's photo.

So generate one secret and set it on **both** sides:

```bash
openssl rand -base64 32
```

| Where | Variable |
|---|---|
| punch-in machine (engine) | `FACE_ENGINE_KEY` |
| hosted API (Render env) | `FACE_ENGINE_KEY` — the same value |

The API sends it as `X-Face-Key` on every engine call; the engine compares it
with `hmac.compare_digest` and answers `401 unauthorised` otherwise.

**The engine refuses to start** bound to anything but loopback without a key.
That interlock is deliberate: forgetting an environment variable should cost
you a failed start, not a silent open endpoint.

### 3. Environment

On the **punch-in machine**:

```bash
FACE_PYTHON=/path/to/venv/bin/python        # Windows: .../Scripts/python.exe
FACE_BIOMETRIC_ROOT=/Volumes/ESD-USB/GRAV_BIOMETRIC
FACE_ENGINE_KEY=<the secret>
FACE_BIOMETRIC_PORT=5001                    # local only; not the public port
```

Start it:

```bash
npm run face:service
```

**On Windows, run that from PowerShell, not from a WSL/Git-Bash prompt.** The
runner is `services/face-biometric/run.js` (Node) precisely because `bash` on
Windows resolves to WSL, where the Windows venv path in `FACE_PYTHON` does not
exist — and the old shell entry point failed with "not an executable
interpreter" naming a file that was plainly there. `run.sh` is now a shim that
detects WSL and says so.

On the **hosted API** (Render environment):

```bash
FACE_BIOMETRIC_SERVICE_URL=https://face.grav.in
FACE_ENGINE_KEY=<the same secret>
FRONTEND_URL=https://cms.grav.in
```

`FRONTEND_URL` is what the self-registration link is built from. Without it the
backend falls back to the request `Origin`, which is usually right but is a
guess; set it and the link is always `https://cms.grav.in/face-enroll/<token>`.

Note `FACE_BIOMETRIC_ROOT` and friends are **not** set on Render. The API never
touches those paths — only the engine does. Setting them there is harmless but
misleading.

### 4. Check it

From the hosted API's shell:

```bash
curl -s -H "X-Face-Key: $FACE_ENGINE_KEY" https://face.grav.in/health
```

Expect JSON with `gallery_size`. Then, in the CMS, an HR user opening any
employee's **Biometric** tab should see readiness rather than "the face service
is not running".

Two failure signatures worth knowing:

| Symptom | Cause |
|---|---|
| `face_service_unreachable` | tunnel down, or `FACE_BIOMETRIC_SERVICE_URL` still loopback |
| every call `401 unauthorised` | the two `FACE_ENGINE_KEY` values differ |

## Hardening beyond the shared secret

The secret is the floor, not the ceiling. On the same tunnel you can add:

- **Cloudflare Access** with a service token, so unauthenticated requests are
  dropped at Cloudflare and never reach the machine.
- **A WAF rule** limiting the hostname to Render's egress IPs.

Both are configuration, not code, and neither replaces the key — if either is
ever misconfigured, the key is what still holds.

## What is still not solved

**There is no liveness check, and registration is the only consumer.** Face
SIGN-IN was removed — nothing is mounted at `/api/auth/face` any more, and a
face no longer opens a session. What remains registers faces and reports
whether a gallery is good enough to be used.

That matters for anything built on this later: a printed photograph held to a
camera passes the quality gate as readily as a person does. Whatever eventually
consumes these registrations — a gate, a kiosk, another system reading the
stored embeddings — has to decide for itself whether it needs liveness. It does
not get it from here.

**One engine, one site.** A second factory needs a second engine, a second
hostname and a routing decision the code does not currently make.
