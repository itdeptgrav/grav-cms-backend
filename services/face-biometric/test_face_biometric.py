"""
test_face_biometric.py — a punch-in row is an event, not a frame rate.

Somebody standing at the machine is recognised many times a second. What
turns that stream of recognitions into ONE attendance row is three rules,
and these tests are about those rules rather than about face matching:

    only a registered, verified name may reach the file;
    a name may not repeat inside its cooldown;
    releasing the screen does not forgive the cooldown;
    and neither does restarting the process.

The last two are the ones worth having tests for. Freeing the machine so the
next person can use it, and permitting another row for the person still
standing there, look like the same thing and are not. And a cooldown held
only in memory is not a cooldown — it is a cooldown until the next crash,
which is exactly when somebody would relaunch and punch in again.

No camera and no face model: a fake source and fake faces drive the real
frame loop, so the sequencing is exercised without needing either.

    python test_face_biometric.py
"""

import csv, os, shutil, sys, tempfile

# Source files are read for the structural checks below. Resolved against
# THIS file, not the working directory: the suite is now run from the
# backend root, where a bare "face_biometric.py" does not exist.
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def src_path(name):
    return os.path.join(HERE, name)

import numpy as np
import face_biometric as F

FAILED = []


def check(label, got, want):
    ok = got == want
    print(f"   {'PASS' if ok else 'FAIL'}  {label:56s} got={got!r}")
    if not ok:
        FAILED.append(f"{label}: got {got!r} want {want!r}")


def unit(v):
    v = np.asarray(v, float)
    return v / np.linalg.norm(v)


# Two employees on orthogonal axes: a flat 1.0 apart, so every match below
# is decided by the probe, never by the pair being hard to tell apart.
E_A = unit(np.concatenate([[1.0, 0.0, 0.0], np.zeros(509)]))
E_B = unit(np.concatenate([[0.0, 0.0, 1.0], np.zeros(509)]))
GALLERY = {"Ana": [E_A], "Bo": [E_B]}
STRANGER = unit(np.concatenate([[0.0, 1.0, 0.0], np.zeros(509)]))


class FakeFace:
    """Whatever the frame loop reads off an InsightFace detection."""

    def __init__(self, emb, size=200, det=0.9, yaw=0.0):
        self.bbox = np.array([100.0, 100.0, 100.0 + size, 100.0 + size])
        self.det_score = det
        self.pose = np.array([0.0, yaw, 0.0])
        self.normed_embedding = None if emb is None else unit(emb)


class FakeApp:
    """A scripted stream of detections, one entry per frame."""

    def __init__(self, script):
        self.script = list(script)
        self.i = 0

    def get(self, frame):
        faces = self.script[min(self.i, len(self.script) - 1)]
        self.i += 1
        return list(faces)


class FakeCap:
    def __init__(self, n):
        self.n, self.i = n, 0
        self.released = False

    def isOpened(self):
        return True

    def read(self):
        self.i += 1
        if self.i > self.n:
            return False, None
        return True, np.zeros((480, 640, 3), np.uint8)

    def release(self):
        self.released = True


# drive() swaps open_source out for a fake; the real one is kept so the
# tests that are ABOUT open_source can put it back.
REAL_OPEN_SOURCE = F.open_source


def drive(script, frames=None, **kw):
    """Run the real frame loop over a scripted source."""
    app = FakeApp(script)
    cap = FakeCap(frames if frames is not None else len(script))
    F.open_source = lambda spec, *a, **k: cap
    kw.setdefault("show_window", False)
    rc = F.run_live(app, GALLERY, kw.pop("source", "fake://cam"), **kw)
    return rc, cap


def rows(path):
    if not os.path.isfile(path):
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.reader(f))


def sandbox():
    d = tempfile.mkdtemp()
    return d, os.path.join(d, "ATTENDANCE", "attendance.csv")


FACE_A = [FakeFace(E_A)]
FACE_B = [FakeFace(E_B)]
NO_FACE = []
STRANGER_FACE = [FakeFace(STRANGER)]
# A face too far to accept and too near to reject: the honest "neither".
BETWEEN = [FakeFace(unit(np.concatenate([[np.cos(0.95), np.sin(0.95), 0.0],
                                         np.zeros(509)])))]
TURNED = [FakeFace(E_A, yaw=80)]          # a face, not a measurable one

print("=" * 80)
print("  FACE BIOMETRIC — PUNCH-IN ATTENDANCE")
print("=" * 80)

# -----------------------------------------------------------------
print("\n1. a verified match writes exactly one row")
sb, path = sandbox()
log = F.AttendanceLog(path, cooldown=30, registered=GALLERY)
drive([FACE_A] * 8, log=log, auto_reset=999)
r = rows(path)
check("header + one row", len(r), 2)
check("header is the agreed shape", r[0], F.ATTENDANCE_HEADER)
check("the employee is named", r[1][3], "Ana")
check("one row, not one per frame", log.rows_written, 1)
shutil.rmtree(sb, ignore_errors=True)

# -----------------------------------------------------------------
print("\n2. the same employee inside the cooldown does not repeat")
sb, path = sandbox()
log = F.AttendanceLog(path, cooldown=30, registered=GALLERY)
# Released after every 3rd frame, so she re-verifies repeatedly. The
# cooldown, not the screen, is what stops the second row.
drive([FACE_A] * 40, log=log, auto_reset=0.0)
check("still one row", len(rows(path)) - 1, 1)
check("and the loop kept refusing, not writing", log.rows_written, 1)
shutil.rmtree(sb, ignore_errors=True)

# -----------------------------------------------------------------
print("\n3. the same employee after the cooldown writes again")
sb, path = sandbox()
log = F.AttendanceLog(path, cooldown=0.0, registered=GALLERY)
drive([FACE_A] * 40, log=log, auto_reset=0.0)
check("more than one row once the cooldown is zero",
      log.rows_written > 1, True)
check("every row is the same employee",
      sorted({r[3] for r in rows(path)[1:]}), ["Ana"])
shutil.rmtree(sb, ignore_errors=True)

# -----------------------------------------------------------------
print("\n4. another employee can punch in after the reset")
sb, path = sandbox()
log = F.AttendanceLog(path, cooldown=30, registered=GALLERY)
# Ana verifies and is filed; the screen frees; Bo walks up.
drive([FACE_A] * 6 + [NO_FACE] * 2 + [FACE_B] * 8, log=log, auto_reset=0.0)
r = rows(path)[1:]
check("two rows", len(r), 2)
check("one each, in order", [x[3] for x in r], ["Ana", "Bo"])
check("Ana was not filed twice despite still being seen",
      sum(1 for x in r if x[3] == "Ana"), 1)
shutil.rmtree(sb, ignore_errors=True)

# -----------------------------------------------------------------
print("\n5. --no-log verifies and writes nothing")
sb, path = sandbox()
log = F.AttendanceLog(path, cooldown=30, enabled=False, registered=GALLERY)
drive([FACE_A] * 8, log=log, auto_reset=999)
check("no file created at all", os.path.exists(path), False)
check("no rows counted", log.rows_written, 0)
check("but the person was still recognised",
      sorted(log.last_punch), ["Ana"])
check("and this run claims no rows", log.punched_this_run, [])
shutil.rmtree(sb, ignore_errors=True)

# -----------------------------------------------------------------
print("\n6. --once exits after the first successful punch")
sb, path = sandbox()
log = F.AttendanceLog(path, cooldown=0.0, registered=GALLERY)
rc, cap = drive([FACE_A] * 200, log=log, auto_reset=0.0, once=True)
check("clean exit", rc, 0)
check("exactly one row", log.rows_written, 1)
check("it stopped early rather than reading every frame",
      cap.i < 200, True)
check("the source was released", cap.released, True)
shutil.rmtree(sb, ignore_errors=True)

print("\n6b. --once does NOT exit on a cooldown refusal")
sb, path = sandbox()
log = F.AttendanceLog(path, cooldown=999, registered=GALLERY)
log.last_punch["Ana"] = __import__("time").time()      # punched a moment ago
rc, cap = drive([FACE_A] * 30, log=log, auto_reset=0.0, once=True)
check("nothing written", log.rows_written, 0)
check("and it ran to the end of the stream", cap.i > 30, True)
shutil.rmtree(sb, ignore_errors=True)

# -----------------------------------------------------------------
print("\n7. nothing but a verified registered name may write")
for label, script in (("a stranger", [STRANGER_FACE] * 20),
                      ("a face between the bars", [BETWEEN] * 20),
                      ("an empty frame", [NO_FACE] * 20),
                      ("a face turned away", [TURNED] * 20),
                      ("two frames, short of the streak",
                       [FACE_A] * 2 + [NO_FACE] * 18)):
    sb, path = sandbox()
    log = F.AttendanceLog(path, cooldown=0.0, registered=GALLERY)
    drive(script, log=log, auto_reset=0.0)
    check(f"{label} writes nothing", (log.rows_written,
                                      os.path.exists(path)), (0, False))
    shutil.rmtree(sb, ignore_errors=True)

print("\n7b. the write itself refuses an unregistered name")
sb, path = sandbox()
log = F.AttendanceLog(path, cooldown=0.0, registered=GALLERY)
check("refused at the file, not upstream",
      log.punch("Somebody", 0.1, "fake://cam")[0], "not_registered")
check("nothing was created", os.path.exists(path), False)
shutil.rmtree(sb, ignore_errors=True)

# -----------------------------------------------------------------
print("\n8. the header is written once, however many runs append")
sb, path = sandbox()
log = F.AttendanceLog(path, cooldown=0.0, registered=GALLERY)
drive([FACE_A] * 8, log=log, auto_reset=0.0)
first = len(rows(path))
log2 = F.AttendanceLog(path, cooldown=0.0, registered=GALLERY)
drive([FACE_B] * 8, log=log2, auto_reset=0.0)
r = rows(path)
check("only one header line",
      sum(1 for x in r if x == F.ATTENDANCE_HEADER), 1)
check("it is the first line", r[0], F.ATTENDANCE_HEADER)
check("the second run appended", len(r) > first, True)
check("both employees are present",
      sorted({x[3] for x in r[1:]}), ["Ana", "Bo"])
shutil.rmtree(sb, ignore_errors=True)

# -----------------------------------------------------------------
print("\n9. every column is populated")
sb, path = sandbox()
log = F.AttendanceLog(path, cooldown=30, registered=GALLERY)
drive([FACE_A] * 8, log=log, auto_reset=999, source="rtsp://gate-1/stream")
r = rows(path)[1]
row = dict(zip(F.ATTENDANCE_HEADER, r))
check("no empty field", [k for k, v in row.items() if v == ""], [])
check("source is the one that was read", row["source"],
      "rtsp://gate-1/stream")
check("employee", row["employee"], "Ana")
check("distance is a real number", float(row["distance"]) < 0.05, True)
check("date and time agree with the timestamp",
      row["timestamp_iso"].startswith(row["date"])
      and row["timestamp_iso"].endswith(row["time"]), True)
shutil.rmtree(sb, ignore_errors=True)

# -----------------------------------------------------------------
print("\n10. release frees the screen without forgiving the cooldown")
g = F.VerificationGate()
for t in (100.0, 100.1, 100.2):
    g.update("MATCH", "Ana", 0.2, t)
check("verified", (g.verified, g.verified_at), ("Ana", 100.2))
g.release()
check("the machine is free", (g.verified, g.name, g.stamps),
      (None, None, []))
sb, path = sandbox()
log = F.AttendanceLog(path, cooldown=30, registered=GALLERY)
log.last_punch["Ana"] = 500.0
check("5s after her punch, the log still refuses",
      log.punch("Ana", 0.2, "x", 505.0)[0], "cooldown")
check("29s: still refused", log.punch("Ana", 0.2, "x", 529.0)[0], "cooldown")
check("31s: the cooldown has expired",
      log.punch("Ana", 0.2, "x", 531.0)[0], "written")
check("and that produced exactly one row", len(rows(path)) - 1, 1)
shutil.rmtree(sb, ignore_errors=True)

# -----------------------------------------------------------------
print("\n11. nothing outside ATTENDANCE/ is touched")
import re
src = open(src_path("face_biometric.py"), encoding="utf-8", newline=None).read()
check("no tracker import",
      bool(re.search(r"^\s*(import|from)\s+cctv_face_tracker", src,
                     re.M)), False)
check("no FACE_TRACKER path", "FACE_TRACKER" in src.split('"""')[2], False)
check("no pickle writes", "pickle" in src, False)
check("no body/ReID/pose/clothing logic",
      [w for w in ("osnet", "torchreid", "ultralytics", "YOLO")
       if w in src], [])

# -----------------------------------------------------------------
print("\n12. startup recovers the cooldown from the log")
sb, path = sandbox()
log = F.AttendanceLog(path, cooldown=30, registered=GALLERY)
drive([FACE_A] * 8, log=log, auto_reset=999)
check("one row filed", log.rows_written, 1)
# A new process, same file. Nothing is shared but the CSV.
restarted = F.AttendanceLog(path, cooldown=30, registered=GALLERY)
check("the employee came back from disk", sorted(restarted.last_punch),
      ["Ana"])
check("counted as seeded", restarted.seeded_from_log, 1)
check("and the recovered time is the row's time",
      abs(restarted.last_punch["Ana"] - log.last_punch["Ana"]) < 1.5, True)
shutil.rmtree(sb, ignore_errors=True)

# -----------------------------------------------------------------
print("\n13. a restart inside the cooldown blocks the duplicate")
sb, path = sandbox()
first = F.AttendanceLog(path, cooldown=999, registered=GALLERY)
drive([FACE_A] * 8, log=first, auto_reset=999)
check("first run filed one row", len(rows(path)) - 1, 1)
second = F.AttendanceLog(path, cooldown=999, registered=GALLERY)
drive([FACE_A] * 8, log=second, auto_reset=999)
check("the second run wrote nothing", second.rows_written, 0)
check("and does not claim a punch it did not make",
      second.punched_this_run, [])
check("while the first run does", first.punched_this_run, ["Ana"])
check("the file is unchanged", len(rows(path)) - 1, 1)
check("and it refused for the right reason",
      second.punch("Ana", 0.1, "x")[0], "cooldown")
shutil.rmtree(sb, ignore_errors=True)

# -----------------------------------------------------------------
print("\n14. a restart after the cooldown allows a new punch")
sb, path = sandbox()
first = F.AttendanceLog(path, cooldown=0.0, registered=GALLERY)
drive([FACE_A] * 8, log=first, auto_reset=999)
second = F.AttendanceLog(path, cooldown=0.0, registered=GALLERY)
drive([FACE_A] * 8, log=second, auto_reset=999)
r = rows(path)[1:]
check("two rows now", len(r), 2)
check("both the same employee", sorted({x[3] for x in r}), ["Ana"])
check("the second run did the writing", second.rows_written, 1)
shutil.rmtree(sb, ignore_errors=True)

# -----------------------------------------------------------------
print("\n15. a damaged log is skipped row by row, never fatal")
sb, path = sandbox()
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(F.ATTENDANCE_HEADER)
    w.writerow(["2026-01-01T09:00:00", "2026-01-01", "09:00:00", "Ana",
                "0.10", "cam"])
    w.writerow(["not-a-timestamp", "x", "y", "Bo", "0.10", "cam"])
    w.writerow(["2026-01-01T09:05:00"])                     # truncated
    w.writerow([])                                          # blank
    w.writerow(["2026-01-01T09:06:00", "d", "t", "", "0.1", "cam"])
    w.writerow(["2026-01-01T10:00:00", "2026-01-01", "10:00:00", "Ana",
                "0.10", "cam"])
last, skipped, n = F.read_attendance_history(path)
check("the good rows survived", sorted(last), ["Ana"])
check("latest wins, not first",
      __import__("datetime").datetime.fromtimestamp(
          last["Ana"]).strftime("%H:%M"), "10:00")
check("three rows skipped", len(skipped), 3)
check("each names its own fault",
      sorted({r["why"] for r in skipped}),
      ["bad_timestamp", "no_employee", "short_row"])
check("a blank line is not counted as damage",
      [r for r in skipped if r["why"] == "blank"], [])
lg = F.AttendanceLog(path, cooldown=30, registered=GALLERY)
check("and startup still works", lg.seeded_from_log, 1)
shutil.rmtree(sb, ignore_errors=True)

print("\n15b. an unreadable file is reported, not raised")
sb, _ = sandbox()
d = os.path.join(sb, "ATTENDANCE")
os.makedirs(d, exist_ok=True)
last, skipped, n = F.read_attendance_history(d)      # a directory, not a file
check("treated as absent", (last, n), ({}, 0))
shutil.rmtree(sb, ignore_errors=True)

# -----------------------------------------------------------------
print("\n16. no log at all behaves as a fresh start")
sb, path = sandbox()
lg = F.AttendanceLog(path, cooldown=999, registered=GALLERY)
check("nothing recovered", lg.last_punch, {})
check("nothing skipped", lg.skipped_rows, [])
check("it says so plainly", lg.describe_seed(),
      "no previous log — starting fresh")
check("and the first punch is allowed",
      lg.punch("Ana", 0.1, "x")[0], "written")
shutil.rmtree(sb, ignore_errors=True)

# -----------------------------------------------------------------
print("\n17. a custom log path is used for reading AND writing")
sb, _ = sandbox()
custom = os.path.join(sb, "elsewhere", "gate2.csv")
a = F.AttendanceLog(custom, cooldown=999, registered=GALLERY)
drive([FACE_A] * 8, log=a, auto_reset=999)
check("written where it was told", os.path.isfile(custom), True)
check("and nowhere else",
      os.path.exists(os.path.join(sb, "ATTENDANCE")), False)
b = F.AttendanceLog(custom, cooldown=999, registered=GALLERY)
check("read back from the same place", sorted(b.last_punch), ["Ana"])
check("so the cooldown follows the file",
      b.punch("Ana", 0.1, "x")[0], "cooldown")
shutil.rmtree(sb, ignore_errors=True)

# -----------------------------------------------------------------
print("\n18. --no-log reads the log and honours it, writes nothing")
sb, path = sandbox()
real = F.AttendanceLog(path, cooldown=999, registered=GALLERY)
drive([FACE_A] * 8, log=real, auto_reset=999)
before = rows(path)
dry = F.AttendanceLog(path, cooldown=999, enabled=False, registered=GALLERY)
check("the dry run still recovered her", sorted(dry.last_punch), ["Ana"])
check("and refuses on the cooldown, not on being disabled",
      dry.punch("Ana", 0.1, "x")[0], "cooldown")
drive([FACE_A] * 8, log=dry, auto_reset=999)
check("nothing written", dry.rows_written, 0)
check("the file is byte-for-byte what it was", rows(path), before)
shutil.rmtree(sb, ignore_errors=True)

# -----------------------------------------------------------------
print("\n19. --attendance-status summarises and exits")
sb, path = sandbox()
lg = F.AttendanceLog(path, cooldown=999, registered=GALLERY)
drive([FACE_A] * 8, log=lg, auto_reset=999)
import io as _io, contextlib
buf = _io.StringIO()
with contextlib.redirect_stdout(buf):
    rc = F.print_attendance_status(path, cooldown=999)
out = buf.getvalue()
check("clean exit", rc, 0)
for want in ("ATTENDANCE STATUS", path, "Ana", "left"):
    check(f"reports {want[:24]!r}", want in out, True)
check("no camera or model was needed", "buffalo" in out.lower(), False)

buf = _io.StringIO()
with contextlib.redirect_stdout(buf):
    rc = F.print_attendance_status(os.path.join(sb, "nope.csv"), 30)
check("a missing log is stated, not an error",
      (rc, "starts fresh" in buf.getvalue()), (0, True))
shutil.rmtree(sb, ignore_errors=True)

# -----------------------------------------------------------------
print("\n20. seeding never adds a second header")
sb, path = sandbox()
for i in range(3):
    lg = F.AttendanceLog(path, cooldown=0.0, registered=GALLERY)
    drive([FACE_A] * 8, log=lg, auto_reset=999)
r = rows(path)
check("three runs, three rows", len(r) - 1, 3)
check("one header", sum(1 for x in r if x == F.ATTENDANCE_HEADER), 1)
check("and it is still first", r[0], F.ATTENDANCE_HEADER)
check("every row still parses back",
      len(F.read_attendance_history(path)[1]), 0)
shutil.rmtree(sb, ignore_errors=True)

# -----------------------------------------------------------------
print("\n21. the kiosk says something a person can act on")
for label, want in (
        ("READY", "READY"),
        ("NO_FACE", "READY"),
        ("NO_FACE (small(20x20))", "READY"),
        ("", "READY"),
        # A face IS there and cannot be used. Every cause — turned away,
        # too far, too dim — is fixed by the same instruction.
        ("NO_USABLE_FACE (yaw=-72)", "LOOK AT CAMERA"),
        ("UNCERTAIN", "LOOK AT CAMERA"),
        ("UNKNOWN", "UNKNOWN"),
        ("REFUSED", "NOT REGISTERED"),
        ("MATCHING Ana 1/3", "MATCHING Ana 1/3"),
        ("MATCHING Ana 2/3", "MATCHING Ana 2/3"),
        ("VERIFIED Ana", "VERIFIED Ana"),
        ("PUNCHED IN Ana", "PUNCHED IN Ana"),
        ("COOLDOWN Ana", "COOLDOWN Ana")):
    check(f"{label!r:32s} ->", F.kiosk_status(label), want)
check("no diagnostic word survives the translation",
      [w for w in ("UNCERTAIN", "NO_FACE", "NO_USABLE_FACE", "REFUSED")
       if w in {F.kiosk_status(x) for x in
                ("UNCERTAIN", "NO_FACE", "NO_USABLE_FACE (yaw=1)",
                 "REFUSED")}], [])
check("every state has its own colour",
      len({F.kiosk_colour(F.kiosk_status(x)) for x in
           ("READY", "UNCERTAIN", "UNKNOWN", "MATCHING Ana 1/3",
            "VERIFIED Ana", "COOLDOWN Ana")}) >= 5, True)

# -----------------------------------------------------------------
print("\n22. the preview mirrors a camera and not a recording")
check("camera 0 mirrors", F.resolve_mirror(None, 0), True)
check("camera '0' mirrors", F.resolve_mirror(None, "0"), True)
check("camera 1 mirrors", F.resolve_mirror(None, "1"), True)
check("a video file does not", F.resolve_mirror(None, "clip.avi"), False)
check("an RTSP stream does not",
      F.resolve_mirror(None, "rtsp://gate/stream"), False)
check("--mirror overrides a file",
      F.resolve_mirror(True, "clip.avi"), True)
check("--no-mirror overrides a camera", F.resolve_mirror(False, 0), False)
check("and the source test agrees",
      [F.is_camera_source(x) for x in (0, "0", "12", "clip.avi",
                                       "rtsp://x")],
      [True, True, True, False, False])

print("\n22b. mirroring moves the box, not the measurement")
b = F.mirror_box([100.0, 40.0, 300.0, 260.0], 1280)
check("flipped about the centre line", b, [980.0, 40.0, 1180.0, 260.0])
check("width preserved", b[2] - b[0], 200.0)
check("vertical untouched", (b[1], b[3]), (40.0, 260.0))
check("flipping twice is the identity",
      F.mirror_box(b, 1280), [100.0, 40.0, 300.0, 260.0])
src = open(src_path("face_biometric.py"), encoding="utf-8", newline=None).read()
loop = src[src.index("def run_live"):]
check("the frame that is MEASURED is never flipped",
      "faces = face_app.get(frame)" in loop, True)
check("only the shown copy is",
      "shown = cv2.flip(frame, 1)" in loop, True)

# -----------------------------------------------------------------
print("\n23. camera size is requested of cameras, never of files")
class SizedCap(FakeCap):
    def __init__(self, n):
        FakeCap.__init__(self, n)
        self.props = {}

    def set(self, prop, val):
        self.props[prop] = val
        return True

made = {}
real_vc = F.cv2.VideoCapture


def fake_vc(spec):
    c = SizedCap(3)
    made[str(spec)] = c
    return c


F.cv2.VideoCapture = fake_vc
F.open_source = REAL_OPEN_SOURCE
cap = F.open_source(0, 1280, 720)
check("width asked for", cap.props.get(F.cv2.CAP_PROP_FRAME_WIDTH), 1280)
check("height asked for", cap.props.get(F.cv2.CAP_PROP_FRAME_HEIGHT), 720)
cap = F.open_source(0, 640, 480)
check("a custom size is passed through",
      (cap.props.get(F.cv2.CAP_PROP_FRAME_WIDTH),
       cap.props.get(F.cv2.CAP_PROP_FRAME_HEIGHT)), (640, 480))
cap = F.open_source("clip.avi", 1280, 720)
check("a file is never rescaled", cap.props, {})
cap = F.open_source("rtsp://gate/stream", 1280, 720)
check("nor is a stream", cap.props, {})
F.cv2.VideoCapture = real_vc
check("the defaults are the agreed ones",
      (F.CAMERA_WIDTH, F.CAMERA_HEIGHT), (1280, 720))

# -----------------------------------------------------------------
print("\n24. --show-distance decides whether numbers reach the screen")
DET = " best=Ana:0.120 second=0.980 margin=0.860"


def kiosk_detail(show, detail):
    """The rule the frame loop applies, stated once."""
    return detail.strip() if (show and "best=" in detail) else None


check("hidden by default", kiosk_detail(False, DET), None)
check("shown when asked", kiosk_detail(True, DET), DET.strip())
check("nothing to show is still nothing", kiosk_detail(True, ""), None)
check("the loop uses exactly this rule",
      'if show_distance and "best=" in detail:' in loop, True)
# The frame the person sees must not carry numbers unless asked.
f1 = F.draw_kiosk(np.zeros((480, 640, 3), np.uint8), [10, 10, 100, 100],
                  "VERIFIED Ana", None)
f2 = F.draw_kiosk(np.zeros((480, 640, 3), np.uint8), [10, 10, 100, 100],
                  "VERIFIED Ana", DET.strip())
check("the two frames genuinely differ",
      bool((f1 != f2).any()), True)
# With no box drawn, the top strip holds the detail line and nothing else,
# so it is empty exactly when the numbers are withheld.
blank = F.draw_kiosk(np.zeros((480, 640, 3), np.uint8), None,
                     "VERIFIED Ana", None)
withnum = F.draw_kiosk(np.zeros((480, 640, 3), np.uint8), None,
                       "VERIFIED Ana", DET.strip())
check("no numbers on screen unless asked", int(blank[0:40, :].sum()), 0)
check("and they are there when asked", int(withnum[0:40, :].sum()) > 0, True)

# -----------------------------------------------------------------
print("\n25. r resets the screen and never the record")
sb, path = sandbox()
log = F.AttendanceLog(path, cooldown=999, registered=GALLERY)
g = F.VerificationGate()
for t in (10.0, 10.1, 10.2):
    g.update("MATCH", "Ana", 0.2, t)
check("verified", g.verified, "Ana")
check("and filed", log.punch("Ana", 0.2, "cam", 10.2)[0], "written")
g.release()                       # what the r key does
check("the screen is clear", (g.verified, g.name, g.stamps),
      (None, None, []))
check("the record is not", sorted(log.last_punch), ["Ana"])
check("so she still cannot punch in again",
      log.punch("Ana", 0.2, "cam", 12.0)[0], "cooldown")
check("and no second row exists", len(rows(path)) - 1, 1)
check("r is wired to release, not to the log",
      'gate.release()' in loop and 'log.last_punch.clear' not in loop, True)
shutil.rmtree(sb, ignore_errors=True)

# -----------------------------------------------------------------
print("\n26. the keys are the three that were promised")
for key, what in (("q", "quit"), ("r", "reset"), ("s", "status")):
    check(f"{key} is handled", f'key == ord("{key}")' in loop, True)
check("s prints the attendance status",
      "print_attendance_status(log.path, log.cooldown)" in loop, True)
check("q leaves the loop", 'print("quit")' in loop, True)

print("\n26b. q exits cleanly and releases the camera")


class QuitCap(FakeCap):
    pass


F.cv2.waitKey = lambda ms: ord("q")
F.cv2.imshow = lambda *a: None
F.cv2.namedWindow = lambda *a: None
F.cv2.setWindowProperty = lambda *a: None
F.cv2.destroyAllWindows = lambda: None
sb, path = sandbox()
log = F.AttendanceLog(path, cooldown=999, registered=GALLERY)
rc, cap = drive([NO_FACE] * 50, log=log, show_window=True, kiosk=True)
check("clean exit", rc, 0)
check("it stopped on the first frame", cap.i, 1)
check("camera released", cap.released, True)
check("nothing written", log.rows_written, 0)
shutil.rmtree(sb, ignore_errors=True)

# -----------------------------------------------------------------
print("\n27. kiosk keeps the console quiet; --debug does not")
F.cv2.waitKey = lambda ms: 255            # no key pressed
import io as _io2, contextlib as _cl

def console(**kw):
    sb, path = sandbox()
    log = F.AttendanceLog(path, cooldown=999, registered=GALLERY)
    buf = _io2.StringIO()
    with _cl.redirect_stdout(buf):
        drive([BETWEEN] * 4 + [FACE_A] * 6, log=log, auto_reset=999, **kw)
    shutil.rmtree(sb, ignore_errors=True)
    return buf.getvalue()

quiet = console(kiosk=True, show_window=False)
loud = console(kiosk=True, debug=True, show_window=False)
plain = console(show_window=False)
check("kiosk hides the working", "UNCERTAIN" in quiet, False)
check("kiosk hides the streak", "MATCHING" in quiet, False)
check("but never the outcome",
      ("VERIFIED:" in quiet, "PUNCH_IN:" in quiet), (True, True))
check("nor claims nobody was verified when somebody was",
      "nobody verified" in quiet, False)
check("--debug brings the working back",
      ("UNCERTAIN" in loud, "MATCHING" in loud), (True, True))
check("non-kiosk is unchanged from before",
      ("UNCERTAIN" in plain, "MATCHING" in plain), (True, True))

# -----------------------------------------------------------------
print("\n28. thresholds are exactly what they were")
check("FACE_ACCEPT_DIST", F.FACE_ACCEPT_DIST, 0.38)
check("FACE_REJECT_DIST", F.FACE_REJECT_DIST, 0.55)
check("FACE_MARGIN", F.FACE_MARGIN, 0.06)
check("VERIFY_HITS", F.VERIFY_HITS, 3)
check("VERIFY_WINDOW_SEC", F.VERIFY_WINDOW_SEC, 2.0)
check("no kiosk option reaches identify()",
      [w for w in ("kiosk", "mirror", "show_distance")
       if w in src[src.index("def identify"):src.index("class Verification")]],
      [])

print("\n" + "=" * 80)
if FAILED:
    print(f"  {len(FAILED)} FAILED")
    for f in FAILED:
        print("   -", f)
    sys.exit(1)
print("  ALL PASS — one row per punch-in, and only for a verified employee")
sys.exit(0)
