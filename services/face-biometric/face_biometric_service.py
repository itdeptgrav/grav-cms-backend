#!/usr/bin/env python3
"""
face_biometric_service.py — the bridge between a face and an HR employee.

face_biometric.py knows how to tell one registered FOLDER from another. It
does not, and should not, know who those folders belong to: a folder name is
a filing convention, and an attendance row is a claim about a person. This
module is the one place those two things are joined, and it exists so that
joining them is an explicit, inspectable, reversible act rather than a
coincidence of naming.

The HR system this feeds already has an identity key, and it is not a name.
`Employee.biometricId` is what its attendance records are keyed and uniquely
indexed on (biometricId + dateString), and `Employee.employeeId` is a virtual
that simply returns it. So a face folder is linked to a biometricId, and a
face punch produces the same identity an eTimeOffice device would — which is
why it can flow into the existing Attendance model rather than beside it.

Two rules are structural rather than advisory:

    a folder with no HR link cannot punch anybody in;
    a folder whose registration is not READY cannot either.

Both are refusals to GUESS. An unlinked folder has no employee to credit, and
a gallery that failed its own quality gate cannot be trusted to tell one
employee from another — filing attendance from either would be inventing a
record, which is worse than filing none.

Importing this module opens no camera, starts no loop and writes no file.
Loading the face model is deferred until something actually needs it.

    from face_biometric_service import (load_registered_gallery,
                                        verify_face_image,
                                        registration_status)
"""

import json
import os
from collections import OrderedDict
from datetime import datetime

import face_biometric as FB

SCRIPT_DIR = FB.SCRIPT_DIR
# State, not source — see FACE_BIOMETRIC_DATA_DIR in face_biometric.py.
DATA_DIR = FB.DATA_DIR
HR_MAP_PATH = (os.environ.get("FACE_BIOMETRIC_PEOPLE_MAP")
               or os.path.join(DATA_DIR, "biometric_people.json"))
HR_MAP_VERSION = 1

# Why a folder cannot be used to punch anybody in.
BLOCK_NO_MAPPING = "no_hr_mapping"
BLOCK_NOT_READY = "registration_not_ready"
BLOCK_DISABLED = "link_disabled"
WARN_DUPLICATE_ID = "duplicate_employee_id"


# ── the mapping file ─────────────────────────────────────────────
def empty_hr_map():
    return {"version": HR_MAP_VERSION,
            "note": ("Maps a REGISTERED_PEOPLE folder to an HR employee. "
                     "employee_id is the HR Employee.biometricId — the key "
                     "the Attendance model is uniquely indexed on."),
            "people": {}}


def load_hr_map(path=HR_MAP_PATH):
    """The folder -> employee mapping. Never raises.

    A missing file is a valid state — it means nobody is linked yet — and is
    reported as such rather than created, because writing a file as a side
    effect of reading one hides when the link was actually made.
    """
    if not os.path.isfile(path):
        return empty_hr_map(), None
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        return empty_hr_map(), f"{type(e).__name__}: {e}"
    if not isinstance(data, dict) or not isinstance(data.get("people"), dict):
        return empty_hr_map(), "not a mapping file"
    data.setdefault("version", HR_MAP_VERSION)
    return data, None


def save_hr_map(mapping, path=HR_MAP_PATH):
    """Write the mapping atomically, so a crash cannot truncate it."""
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(mapping, f, indent=2, ensure_ascii=False, sort_keys=True)
        f.write("\n")
    os.replace(tmp, path)
    return path


def link_employee(folder, employee_id, employee_name=None, path=HR_MAP_PATH,
                  mongo_id=None, enabled=True, registered_dir=None):
    """Link one registration folder to one HR employee.

    Returns (ok, message, mapping). Refuses to invent a folder: linking a
    name that has no photos would produce an employee who can never punch in
    and no error to say why.
    """
    folder = (folder or "").strip()
    employee_id = (str(employee_id) if employee_id is not None else "").strip()
    if not folder:
        return False, "no folder given", None
    if not employee_id:
        return False, "no employee id given", None

    reg = registered_dir or FB.REGISTERED_PEOPLE_DIR
    if not os.path.isdir(os.path.join(reg, folder)):
        have = sorted(d for d in os.listdir(reg)
                      if os.path.isdir(os.path.join(reg, d))
                      and not d.startswith(".")) if os.path.isdir(reg) else []
        return (False,
                f"no registration folder named {folder!r} in {reg}"
                + (f" (have: {', '.join(have)})" if have else ""), None)

    mapping, err = load_hr_map(path)
    if err:
        return False, f"existing mapping unreadable ({err}) — not overwriting", None

    prev = mapping["people"].get(folder)
    entry = {"employee_id": employee_id,
             "employee_name": (employee_name or "").strip() or folder,
             "enabled": bool(enabled),
             "linked_at": datetime.now().isoformat(timespec="seconds")}
    if mongo_id:
        entry["mongo_id"] = str(mongo_id).strip()
    if prev:
        entry["previously"] = {k: prev.get(k) for k in
                               ("employee_id", "employee_name")}
    mapping["people"][folder] = entry
    save_hr_map(mapping, path)

    msg = (f"linked {folder} -> employee_id={employee_id} "
           f"({entry['employee_name']})")
    if prev and prev.get("employee_id") != employee_id:
        msg += (f"   [was employee_id={prev.get('employee_id')} "
                f"({prev.get('employee_name')})]")
    return True, msg, mapping


def unlink_employee(folder, path=HR_MAP_PATH):
    mapping, err = load_hr_map(path)
    if err:
        return False, f"mapping unreadable ({err})", None
    if folder not in mapping["people"]:
        return False, f"{folder!r} was not linked", mapping
    removed = mapping["people"].pop(folder)
    save_hr_map(mapping, path)
    return True, (f"unlinked {folder} (was employee_id="
                  f"{removed.get('employee_id')})"), mapping


def duplicate_employee_ids(mapping):
    """Employee ids claimed by more than one folder, and by which."""
    seen = {}
    for folder, e in (mapping.get("people") or {}).items():
        eid = str(e.get("employee_id") or "").strip()
        if eid:
            seen.setdefault(eid, []).append(folder)
    return {eid: sorted(f) for eid, f in seen.items() if len(f) > 1}


# ── the model, loaded only when something needs it ───────────────
_FACE_APP = None


def face_app(verbose=False):
    """The InsightFace model, built once, on first use.

    Deferred so that importing this module — which a web process or a CLI
    doing nothing but reading the mapping will do — costs nothing.
    """
    global _FACE_APP
    if _FACE_APP is None:
        _FACE_APP = FB.build_face_app(verbose=verbose)
    return _FACE_APP


# ── gallery + status ─────────────────────────────────────────────
def load_registered_gallery(registered_dir=None, hr_map_path=HR_MAP_PATH,
                            verbose=False, app=None):
    """Every registered folder, its embeddings, and who it belongs to.

    Returns (gallery, report) where gallery is {folder: [embedding, ...]}
    for the folders that MAY punch somebody in, and report explains every
    folder including the ones that may not.
    """
    app = app or face_app(verbose)
    raw_gallery, reg_report = FB.load_registered_employees(
        app, registered_dir, verbose=verbose)
    mapping, map_err = load_hr_map(hr_map_path)
    people = mapping.get("people") or {}
    dupes = duplicate_employee_ids(mapping)

    pairs = FB.pairwise_separation(raw_gallery)
    # Two folders belonging to the SAME employee are not two identities that
    # must be told apart — they are one person photographed twice, and they
    # will measure ~0 from each other by construction. Counting that as a
    # separation failure marked a correct pair of galleries WEAK and blocked
    # the person from punching in with either.
    #
    # Only pairs whose employee ids are BOTH known and equal are excused. An
    # unlinked folder could be anybody, so it still has to be separable.
    def _eid(f):
        e = people.get(f) or {}
        return str(e.get("employee_id") or "") or None

    pairs = [(a, b, d) for (a, b, d) in pairs
             if not (_eid(a) and _eid(b) and _eid(a) == _eid(b))]
    report = OrderedDict()
    punchable = OrderedDict()

    for folder, r in reg_report.items():
        near_name, near_d = FB.nearest_other(pairs, folder)
        state, problems = FB.readiness(r, near_d)
        link = people.get(folder)
        blocks, warns = [], list(problems)

        if link is None:
            blocks.append(BLOCK_NO_MAPPING)
        elif not link.get("enabled", True):
            blocks.append(BLOCK_DISABLED)
        if state != "READY":
            blocks.append(BLOCK_NOT_READY)
        if link and str(link.get("employee_id")) in dupes:
            warns.append(f"{WARN_DUPLICATE_ID}: "
                         f"{', '.join(dupes[str(link['employee_id'])])}")

        report[folder] = {
            "folder": folder,
            "employee_id": (link or {}).get("employee_id"),
            "employee_name": (link or {}).get("employee_name"),
            "mongo_id": (link or {}).get("mongo_id"),
            "linked": link is not None,
            "linked_at": (link or {}).get("linked_at"),
            "readiness": state,
            "images": r["total"],
            "accepted": r["accepted"],
            "rejected": r["rejected"],
            "core_anchors": r["core_anchors"],
            "embeddings": len(r["embeddings"]),
            "spread": r["spread"],
            "nearest_other": near_name,
            "nearest_other_dist": near_d,
            "punchable": not blocks,
            "blocked_by": blocks,
            "warnings": warns,
        }
        if not blocks:
            punchable[folder] = r["embeddings"]

    return punchable, {"people": report, "map_path": hr_map_path,
                       "map_error": map_err, "duplicates": dupes,
                       "linked": sum(1 for r in report.values()
                                     if r["linked"]),
                       "punchable": len(punchable),
                       "total": len(report)}


def registration_status(registered_dir=None, hr_map_path=HR_MAP_PATH,
                        app=None):
    """The whole picture, as data. No printing, no side effects."""
    gallery, report = load_registered_gallery(registered_dir, hr_map_path,
                                              verbose=False, app=app)
    return {"gallery_size": {k: len(v) for k, v in gallery.items()},
            **report}


def merge_gallery_by_employee(gallery, hr_map_path=HR_MAP_PATH):
    """Re-key a folder gallery by EMPLOYEE, merging folders of one person.

    Identification asks "who is this, and is that clear?". The second half is
    a margin: the winner must beat the runner-up. That only means anything if
    the runner-up is somebody ELSE.

    One employee with two folders — a legacy name-keyed gallery and a new
    id-keyed one — is their own runner-up. The margin collapses to ~0, every
    frame lands in the gap between accept and reject, and the person is never
    recognised however good the photograph is. Measured on this install:
    best 0.365 against a 0.38 bar, and margin 0.0000 against 0.06.

    So folders are merged into one candidate per employee_id before anything
    is compared. Returns (merged, id_to_folders).
    """
    mapping, _err = load_hr_map(hr_map_path)
    people = mapping.get("people") or {}
    merged, id_to_folders = OrderedDict(), OrderedDict()
    for folder, embs in gallery.items():
        link = people.get(folder) or {}
        eid = str(link.get("employee_id") or "").strip()
        # A folder with no employee cannot be identified AS anybody, and is
        # excluded upstream; keyed by folder here only so this stays total.
        key = eid or f"folder:{folder}"
        merged.setdefault(key, []).extend(embs)
        id_to_folders.setdefault(key, []).append(folder)
    return merged, id_to_folders


def employee_for_id(employee_id, hr_map_path=HR_MAP_PATH):
    """The mapping entry for an employee id, from any folder that carries it."""
    mapping, _err = load_hr_map(hr_map_path)
    for folder, e in (mapping.get("people") or {}).items():
        if str(e.get("employee_id")) == str(employee_id):
            return dict(e, folder=folder)
    return None


# ── verification ─────────────────────────────────────────────────
def verify_face_image(image, gallery=None, app=None, hr_map_path=HR_MAP_PATH,
                      registered_dir=None):
    """Who is in this image, as an HR identity rather than a folder name.

    `image` is a BGR array or a path. Returns a result dict that always
    carries `state` and `punchable`; employee_id is present only when the
    face was matched to a folder that is allowed to punch somebody in.

    The gallery passed in should be the PUNCHABLE one — the identification
    is deliberately never given folders it is not permitted to conclude,
    so an unlinked or unready person cannot be matched and then refused
    afterwards by a caller who forgets to check.
    """
    import cv2

    result = {"state": "NO_FACE", "folder": None, "employee_id": None,
              "employee_name": None, "distance": None, "second": None,
              "margin": None, "punchable": False, "reason": None,
              "faces_detected": 0}

    if isinstance(image, str):
        img = cv2.imread(image)
        if img is None:
            result["reason"] = "unreadable_image"
            return result
    else:
        img = image
    if img is None or getattr(img, "size", 0) == 0:
        result["reason"] = "empty_image"
        return result

    app = app or face_app()
    if gallery is None:
        gallery, _rep = load_registered_gallery(registered_dir, hr_map_path,
                                                app=app)
    if not gallery:
        result["reason"] = "no_punchable_employees"
        return result

    try:
        faces = app.get(img)
    except Exception as e:
        result["reason"] = f"detect_error:{type(e).__name__}"
        return result
    result["faces_detected"] = len(faces)
    if not faces:
        result["reason"] = "no_face_in_image"
        return result

    best_face = max(faces, key=lambda f: ((f.bbox[2] - f.bbox[0])
                                          * (f.bbox[3] - f.bbox[1])))
    good, why = FB.is_live_quality_face(best_face)
    if not good:
        result["state"] = "NO_USABLE_FACE"
        result["reason"] = why
        return result

    emb = getattr(best_face, "normed_embedding", None)
    if emb is None:
        emb = getattr(best_face, "embedding", None)
    if emb is None:
        result["reason"] = "no_embedding"
        return result

    state, folder, best, second, margin = FB.identify(
        FB.l2_normalise(emb), gallery)
    result.update({"state": state, "folder": folder, "distance": best,
                   "second": second, "margin": margin,
                   "bbox": [float(v) for v in best_face.bbox]})

    if state != "MATCH":
        result["reason"] = state.lower()
        return result

    mapping, _err = load_hr_map(hr_map_path)
    link = (mapping.get("people") or {}).get(folder)
    if not link:
        # Unreachable when the caller passes the punchable gallery, and
        # kept because this is the last point before an attendance row.
        result["reason"] = BLOCK_NO_MAPPING
        return result
    result["employee_id"] = link.get("employee_id")
    result["employee_name"] = link.get("employee_name") or folder
    result["mongo_id"] = link.get("mongo_id")
    result["punchable"] = True
    result["reason"] = "verified"
    return result


# ── registration intake ──────────────────────────────────────────
# HR uploads photos; this is the only code that writes into
# REGISTERED_PEOPLE. Every path it produces is built from a sanitised name
# and then checked to be inside that directory, because a folder name that
# arrives over HTTP is untrusted input however friendly the UI looks.

ALLOWED_UPLOAD_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
MAX_UPLOAD_BYTES = 12 * 1024 * 1024     # one phone photo, generously
MAX_UPLOAD_PIXELS = 60_000_000
ARCHIVE_DIRNAME = "_archive"


def safe_folder_name(*candidates):
    """A directory name derived from an employee, safe to join to a path.

    Built from what HR already has — an id, a username, a name — and reduced
    to characters that cannot mean anything to a filesystem. Nothing here is
    per-employee: the same rule produces the folder for anybody.
    """
    for c in candidates:
        if not c:
            continue
        raw = str(c).strip()
        out = []
        for ch in raw:
            if ch.isalnum():
                out.append(ch)
            elif ch in " -_.":
                out.append("_")
            # everything else is dropped, including separators and dots that
            # could climb out of the directory
        name = "".join(out).strip("_.")
        while "__" in name:
            name = name.replace("__", "_")
        # A name that is only dots or separators reduces to nothing, and a
        # reserved traversal token must never survive.
        if name and name not in (".", "..") and not name.startswith("."):
            return name[:64]
    return None


def _inside(root, path):
    """True only if `path` really resolves inside `root`."""
    try:
        root_r = os.path.realpath(root)
        path_r = os.path.realpath(path)
    except OSError:
        return False
    return path_r == root_r or path_r.startswith(root_r + os.sep)


def safe_image_name(filename, index=0):
    """A stored filename that cannot escape its folder or shadow another."""
    base = os.path.basename(str(filename or ""))
    stem, ext = os.path.splitext(base)
    ext = ext.lower()
    if ext not in ALLOWED_UPLOAD_EXTS:
        return None, f"extension {ext or '(none)'} not allowed"
    stem = safe_folder_name(stem) or "photo"
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return f"{stamp}_{index:02d}_{stem[:40]}{ext}", None


def _decode_upload(blob):
    """base64 or data URL -> raw bytes, with the size rules applied."""
    import base64
    import binascii
    s = blob or ""
    if s.startswith("data:"):
        head, _, tail = s.partition(",")
        if "base64" not in head:
            return None, "not_base64"
        s = tail
    try:
        raw = base64.b64decode(s, validate=True)
    except (binascii.Error, ValueError):
        return None, "bad_base64"
    if len(raw) > MAX_UPLOAD_BYTES:
        return None, "file_too_large"
    if len(raw) < 512:
        return None, "file_too_small"
    return raw, None


def folder_for_employee(employee_id, employee_name=None, username=None,
                        hr_map_path=HR_MAP_PATH):
    """Which folder is this employee's, and may we use it?

    Returns (folder, created_hint, refusal). An employee already linked keeps
    their folder; a new one gets a name derived from what HR has. A folder
    that exists and belongs to somebody ELSE is a refusal, never a merge —
    two people's photos in one folder is the one outcome no threshold can
    recover from.
    """
    mapping, err = load_hr_map(hr_map_path)
    if err:
        return None, None, f"mapping_unreadable: {err}"
    eid = str(employee_id or "").strip()
    if not eid:
        return None, None, "no_employee_id"

    existing = [f for f, e in (mapping.get("people") or {}).items()
                if str(e.get("employee_id")) == eid]
    if len(existing) > 1:
        # Ambiguous by construction. Picking one would silently decide which
        # of two galleries this employee's new photos belong to.
        return None, None, ("duplicate_folders: " + ", ".join(sorted(existing)))
    if existing:
        return existing[0], False, None

    # The folder key is the STABLE HR id, not the display name. A person can
    # be renamed, marry, or be entered as "Rishee" once and "Rishee Ray" the
    # next time; their biometricId does not change, and it is what the
    # attendance record is keyed on. Deriving the folder from a display name
    # meant a rename orphaned somebody's whole gallery.
    folder = safe_folder_name(eid, username, employee_name)
    if not folder:
        return None, None, "cannot_derive_folder_name"
    owner = (mapping.get("people") or {}).get(folder)
    if owner and str(owner.get("employee_id")) != eid:
        return None, None, (f"folder_taken: {folder} already belongs to "
                            f"employee_id={owner.get('employee_id')}")
    return folder, True, None


def save_registration_photos(employee_id, files, employee_name=None,
                             username=None, registered_dir=None,
                             hr_map_path=HR_MAP_PATH):
    """Write HR's uploaded photos into this employee's folder.

    `files` is [{"filename": ..., "data": <base64 or data URL>}, ...].
    Returns (result, refusal). Nothing existing is touched: every file is
    written under a fresh timestamped name, so an upload can add to a
    gallery but never replace or overwrite one.
    """
    import cv2
    import numpy as np

    reg_root = registered_dir or FB.REGISTERED_PEOPLE_DIR
    folder, created, refusal = folder_for_employee(
        employee_id, employee_name, username, hr_map_path)
    if refusal:
        return None, refusal
    if not files:
        return None, "no_files"

    dest = os.path.join(reg_root, folder)
    if not _inside(reg_root, dest):
        # Unreachable given safe_folder_name, and checked anyway: this is
        # the boundary that keeps an upload inside REGISTERED_PEOPLE.
        return None, "path_escapes_registered_people"
    os.makedirs(dest, exist_ok=True)

    saved, rejected = [], []
    for i, f in enumerate(files):
        name, why = safe_image_name((f or {}).get("filename"), i)
        if not name:
            rejected.append({"filename": (f or {}).get("filename"),
                             "reason": why})
            continue
        raw, why = _decode_upload((f or {}).get("data"))
        if raw is None:
            rejected.append({"filename": name, "reason": why})
            continue
        # Decoded before it is trusted: an "image" that no decoder accepts
        # is not one, whatever its extension says.
        img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            rejected.append({"filename": name, "reason": "undecodable_image"})
            continue
        h, w = img.shape[:2]
        if h * w > MAX_UPLOAD_PIXELS:
            rejected.append({"filename": name,
                             "reason": "image_dimensions_too_large"})
            continue
        path = os.path.join(dest, name)
        if not _inside(reg_root, path):
            rejected.append({"filename": name, "reason": "path_escape"})
            continue
        with open(path, "wb") as fh:
            fh.write(raw)
        saved.append({"filename": name, "width": w, "height": h,
                      "bytes": len(raw)})

    linked = False
    if saved:
        # Only link once a photo actually landed. Minting a mapping for an
        # upload that failed would leave an employee pointing at an empty
        # folder and reporting NOT_READY with no explanation.
        #
        # Re-linked on every upload, not just the first, so a display name
        # that changed in HR follows. The folder key does not move — it is
        # the stable id — only the name shown beside it.
        mapping, _err = load_hr_map(hr_map_path)
        prev = (mapping.get("people") or {}).get(folder) or {}
        name = employee_name or prev.get("employee_name")
        if created or (name and name != prev.get("employee_name")):
            ok, _msg, _m = link_employee(folder, employee_id, name,
                                         path=hr_map_path,
                                         registered_dir=reg_root)
            linked = ok
        else:
            linked = bool(prev)

    return {"folder": folder, "folder_created": bool(created),
            "mapping_linked": linked, "saved": saved,
            "rejected": rejected}, None


def archive_registration_photo(folder, filename, registered_dir=None,
                               reason=None):
    """Move one photo out of a gallery. Never deletes.

    A registration photo is evidence about who somebody is. Removing one
    should stop it being used, not destroy it — if a gallery gets worse
    afterwards, the way back has to still exist.
    """
    reg_root = registered_dir or FB.REGISTERED_PEOPLE_DIR
    folder_s = safe_folder_name(folder)
    name_s = os.path.basename(str(filename or ""))
    if not folder_s or not name_s or name_s.startswith("."):
        return None, "bad_folder_or_filename"
    if os.path.splitext(name_s)[1].lower() not in ALLOWED_UPLOAD_EXTS:
        return None, "not_an_image"

    src = os.path.join(reg_root, folder_s, name_s)
    if not _inside(reg_root, src):
        return None, "path_escapes_registered_people"
    if not os.path.isfile(src):
        return None, "file_not_found"

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest_dir = os.path.join(reg_root, ARCHIVE_DIRNAME, folder_s, stamp)
    if not _inside(reg_root, dest_dir):
        return None, "path_escapes_registered_people"
    os.makedirs(dest_dir, exist_ok=True)
    dest = os.path.join(dest_dir, name_s)
    i = 1
    while os.path.exists(dest):
        stem, ext = os.path.splitext(name_s)
        dest = os.path.join(dest_dir, f"{stem}_{i}{ext}")
        i += 1
    os.replace(src, dest)
    return {"folder": folder_s, "filename": name_s,
            "archived_to": os.path.relpath(dest, reg_root),
            "reason": reason or "archived_by_hr",
            "at": datetime.now().isoformat(timespec="seconds")}, None


def list_registration_photos(folder, registered_dir=None):
    """The photo filenames in one gallery, for the UI to offer."""
    reg_root = registered_dir or FB.REGISTERED_PEOPLE_DIR
    folder_s = safe_folder_name(folder)
    if not folder_s:
        return []
    d = os.path.join(reg_root, folder_s)
    if not _inside(reg_root, d) or not os.path.isdir(d):
        return []
    return sorted(f for f in os.listdir(d)
                  if not f.startswith(".")
                  and os.path.splitext(f)[1].lower() in ALLOWED_UPLOAD_EXTS)


def read_registration_photo(folder, filename, registered_dir=None,
                            max_side=320):
    """One gallery photo, shrunk, as a data URL for the HR page.

    Downscaled here rather than in the browser: a registration photo is a
    full-size camera image, and sending a dozen of them at full size to
    draw thumbnails would be slower than the page is worth.
    """
    import base64
    import cv2

    reg_root = registered_dir or FB.REGISTERED_PEOPLE_DIR
    folder_s = safe_folder_name(folder)
    name_s = os.path.basename(str(filename or ""))
    if not folder_s or not name_s or name_s.startswith("."):
        return None, "bad_folder_or_filename"
    if os.path.splitext(name_s)[1].lower() not in ALLOWED_UPLOAD_EXTS:
        return None, "not_an_image"
    path = os.path.join(reg_root, folder_s, name_s)
    if not _inside(reg_root, path):
        return None, "path_escapes_registered_people"
    if not os.path.isfile(path):
        return None, "file_not_found"
    img = cv2.imread(path)
    if img is None:
        return None, "undecodable_image"
    h, w = img.shape[:2]
    scale = min(1.0, float(max_side) / max(h, w))
    if scale < 1.0:
        img = cv2.resize(img, (max(1, int(w * scale)), max(1, int(h * scale))),
                         interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 78])
    if not ok:
        return None, "encode_failed"
    return ("data:image/jpeg;base64,"
            + base64.b64encode(buf.tobytes()).decode()), None


def employee_registration_report(folder, registered_dir=None,
                                 hr_map_path=HR_MAP_PATH, app=None):
    """One employee's readiness, re-checked from disk after an upload."""
    snap = status_snapshot(registered_dir, hr_map_path, app=app)
    for p in snap["people"]:
        if p["folder"] == folder:
            p = dict(p)
            p["photos"] = list_registration_photos(folder, registered_dir)
            p["generated_at"] = snap["generated_at"]
            p["duplicate_employee_ids"] = snap["duplicate_employee_ids"]
            return p
    return None


# ── snapshot for the HR backend ──────────────────────────────────
STATUS_SNAPSHOT = (os.environ.get("FACE_BIOMETRIC_STATUS_FILE")
                   or os.path.join(DATA_DIR, "biometric_status.json"))

# The three words the HR page shows. READY and NOT_READY come straight from
# the registration gate; WEAK sits between them — a gallery good enough to
# exist and not good enough to be trusted with attendance — so an operator
# can tell "retake a couple of photos" from "start again".
READY, WEAK, NOT_READY = "READY", "WEAK", "NOT_READY"


def readiness_band(rec):
    """READY / WEAK / NOT_READY, with the retake reason spelled out."""
    if rec["readiness"] == "READY":
        return READY
    # Something usable exists but it is short of the bar. Nothing here is
    # per-employee: it is the same count of core anchors the gate uses.
    if rec["embeddings"] > 0 and rec["core_anchors"] > 0:
        return WEAK
    return NOT_READY


def status_snapshot(registered_dir=None, hr_map_path=HR_MAP_PATH, app=None):
    """Everything the HR page needs, as plain JSON-able data.

    Written to a file rather than served live on purpose: the face model
    takes seconds to load and the HR backend is a Node process that has no
    business importing it. A snapshot with its own timestamp is honest
    about being a snapshot — a page can say how old it is.
    """
    st = registration_status(registered_dir, hr_map_path, app=app)
    people = []
    for folder, r in st["people"].items():
        band = readiness_band(r)
        retake = []
        if band != READY:
            need_core = max(0, FB.REG_MIN_CORE_ANCHORS - r["core_anchors"])
            need_tot = max(0, FB.REG_MIN_TOTAL_EMBEDS - r["embeddings"])
            if need_core:
                retake.append(f"{need_core} more straight-on, sharp photo(s) "
                              f"— has {r['core_anchors']} of "
                              f"{FB.REG_MIN_CORE_ANCHORS} core anchors")
            if need_tot:
                retake.append(f"{need_tot} more accepted photo(s) — has "
                              f"{r['embeddings']} of "
                              f"{FB.REG_MIN_TOTAL_EMBEDS}")
            if (r["nearest_other_dist"] is not None
                    and r["nearest_other_dist"] < FB.REG_MIN_SEPARATION):
                retake.append(f"too close to {r['nearest_other']} "
                              f"({r['nearest_other_dist']:.3f}) — the two "
                              f"galleries cannot be told apart")
        people.append({
            "folder": folder,
            "employee_id": r["employee_id"],
            "employee_name": r["employee_name"],
            "mongo_id": r["mongo_id"],
            "linked": r["linked"],
            "linked_at": r["linked_at"],
            "images_found": r["images"],
            "images_accepted": r["accepted"],
            "images_rejected": r["rejected"],
            "core_anchors": r["core_anchors"],
            "embeddings": r["embeddings"],
            "readiness": band,
            "punchable": r["punchable"],
            "blocked_by": r["blocked_by"],
            "warnings": r["warnings"],
            "retake_reasons": retake,
            "nearest_other": r["nearest_other"],
            "nearest_other_dist": r["nearest_other_dist"],
        })
    return {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "registered_dir": registered_dir or FB.REGISTERED_PEOPLE_DIR,
        "map_path": st["map_path"],
        "map_error": st["map_error"],
        "totals": {"folders": st["total"], "linked": st["linked"],
                   "punchable": st["punchable"],
                   "unlinked": st["total"] - st["linked"]},
        "duplicate_employee_ids": st["duplicates"],
        # Folders with photos and nobody to credit. Listed separately
        # because they are an HR task, not an employee's problem.
        "unlinked_folders": [p["folder"] for p in people if not p["linked"]],
        "people": people,
    }


def write_status_snapshot(path=STATUS_SNAPSHOT, registered_dir=None,
                          hr_map_path=HR_MAP_PATH):
    snap = status_snapshot(registered_dir, hr_map_path)
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(snap, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)
    return path, snap


# ── report ───────────────────────────────────────────────────────
def print_hr_map_status(registered_dir=None, hr_map_path=HR_MAP_PATH):
    """What is linked, what is usable, and exactly why anything is not."""
    print(f"Loading {FB.FACE_MODEL_NAME} ...")
    gallery, rep = load_registered_gallery(registered_dir, hr_map_path,
                                           verbose=False)
    people = rep["people"]
    print()
    print("=" * 84)
    print("  HR BIOMETRIC MAPPING")
    print("=" * 84)
    print(f"  mapping file : {rep['map_path']}"
          f"{'' if os.path.isfile(rep['map_path']) else '   (does not exist yet)'}")
    if rep["map_error"]:
        print(f"  ⚠ mapping unreadable: {rep['map_error']}")
    print(f"  folders      : {rep['total']}   "
          f"linked: {rep['linked']}   "
          f"usable for punch-in: {rep['punchable']}")
    if not people:
        print("\n  no registration folders found")
        return 0

    print(f"\n  {'folder':<14s} {'employee_id':<14s} {'name':<16s} "
          f"{'ready':<10s} {'emb':>4s}  punch-in")
    for f, r in people.items():
        eid = r["employee_id"] or "-"
        nm = r["employee_name"] or "-"
        mark = "YES" if r["punchable"] else "NO"
        print(f"  {f:<14s} {str(eid):<14s} {str(nm)[:16]:<16s} "
              f"{r['readiness']:<10s} {r['embeddings']:>4d}  {mark}")

    blocked = [(f, r) for f, r in people.items() if not r["punchable"]]
    if blocked:
        print(f"\n  NOT USABLE FOR PUNCH-IN ({len(blocked)}):")
        for f, r in blocked:
            for b in r["blocked_by"]:
                if b == BLOCK_NO_MAPPING:
                    print(f"     {f:<14s} no HR link — nobody to credit an "
                          f"attendance row to")
                elif b == BLOCK_NOT_READY:
                    print(f"     {f:<14s} registration is {r['readiness']}"
                          f" — {r['core_anchors']} core anchor(s), "
                          f"{r['embeddings']} embedding(s)")
                elif b == BLOCK_DISABLED:
                    print(f"     {f:<14s} link is disabled in the mapping")

    warned = [(f, r) for f, r in people.items() if r["warnings"]]
    if warned:
        print(f"\n  WARNINGS:")
        for f, r in warned:
            for w in r["warnings"]:
                print(f"     {f:<14s} {w}")
    if rep["duplicates"]:
        print(f"\n  ⚠ EMPLOYEE IDS CLAIMED BY MORE THAN ONE FOLDER:")
        for eid, folders in rep["duplicates"].items():
            print(f"     employee_id={eid}: {', '.join(folders)}")
        print("     Two folders of the same person is harmless; two "
              "PEOPLE sharing an id would file one person's attendance")
        print("     under the other. Check these before relying on them.")

    unlinked = [f for f, r in people.items() if not r["linked"]]
    if unlinked:
        print(f"\n  TO LINK THE REMAINING FOLDER(S):")
        for f in unlinked:
            print(f"     python face_biometric.py --link-employee {f} "
                  f"--employee-id <HR biometricId> --employee-name \"{f}\"")
    return 0
