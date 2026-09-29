// constants/marketingAdvertisingAssets.js
//
// THE ADVERTISING IMAGE LIBRARY'S VOCABULARY.
//
// ── UPLOADING IS NOT APPROVING ─────────────────────────────────────────────
// The single most important thing in this file. A file arriving in GRAV means
// somebody had it on their laptop. It does not mean the company owns it, that
// anybody has looked at it, or that it may appear in a paid advertisement with
// the company's name beside it.
//
// So an asset has two independent facts — the bytes, and a person's decision
// about them — and the second is a deliberate act by somebody other than the
// uploader, against an exact immutable version.
"use strict";

const freeze = Object.freeze;
const pair = (code, label, extra = {}) => freeze({ code, label, ...extra });
const codes = (list) => freeze(list.map((x) => x.code));

/* ── WHAT A VERSION MAY BE ──────────────────────────────────────────────────
   Only `approved` can be deployed, and only while it is also current. */
const ASSET_STATES = [
  pair("awaiting_review", "Waiting for review", {
    means: "The file is stored and nobody has confirmed the company may advertise with it.",
    deployable: false,
  }),
  pair("approved", "Approved for advertising", {
    means: "Somebody confirmed the company is authorised to use this exact image in paid advertising.",
    deployable: true,
  }),
  pair("returned", "Sent back", {
    means: "A reviewer looked at it and sent it back. It can be reviewed again.",
    deployable: false,
  }),
  pair("revoked", "Withdrawn", {
    means: "Somebody withdrew this image. It cannot be used in anything new.",
    deployable: false,
  }),
  pair("superseded", "Replaced by a newer version", {
    means: "A different file was uploaded for this asset. This version is kept because campaigns may reference it.",
    deployable: false,
  }),
];
const ASSET_STATE_CODES = codes(ASSET_STATES);
const DEPLOYABLE_STATES = freeze(ASSET_STATES.filter((s) => s.deployable).map((s) => s.code));

/* ── THE TRANSITIONS, AND NOTHING ELSE ──────────────────────────────────────
   No path back to `awaiting_review` from `approved`: an approval is a decision
   about bytes, and the bytes never change. A changed file is a new version with
   its own identity and its own review. */
const ASSET_TRANSITIONS = freeze({
  awaiting_review: freeze(["approved", "returned", "revoked"]),
  returned: freeze(["approved", "revoked"]),
  approved: freeze(["revoked", "superseded"]),
  revoked: freeze([]),
  superseded: freeze([]),
});

/* ── WHAT A REVIEWER IS ACTUALLY CONFIRMING ────────────────────────────────
   Three separate statements, each required, because a single "approve" button
   lets somebody approve without having decided anything. The third is the one
   people forget: an approval belongs to an exact set of bytes, and a reviewer
   who looked at a different version has approved nothing.

   These are recorded on the history row, so an audit shows what was asserted
   rather than that a button was pressed. */
const APPROVAL_ASSERTIONS = [
  pair("authorisedToUse", "The company is authorised to use this image", {
    means: "GRAV has permission to publish it — it is the company's own, or licensed for advertising.",
  }),
  pair("approvedForAdvertising", "It is suitable for a paid advertisement", {
    means: "A campaign is a public, paid use with the company's name beside it.",
  }),
  pair("reviewedThisVersion", "This exact file was reviewed", {
    means: "Not a similar one, not an earlier draft. The version identifier shown is the one that was looked at.",
  }),
];
const APPROVAL_ASSERTION_CODES = codes(APPROVAL_ASSERTIONS);

/* ── LIMITS, AND WHERE EACH COMES FROM ──────────────────────────────────────
   The byte ceiling is enforced BEFORE storage — an upload is refused while it
   is still arriving, not after it has been written somewhere and measured. */
const ASSET_LIMITS = freeze({
  /* Meta's own limit is 30MB. GRAV's is lower: an advertising image that needs
     eight megabytes is a source file somebody meant to export first, and every
     megabyte is Drive storage and upload time for a picture that will be
     recompressed anyway. */
  MAX_BYTES: 8 * 1024 * 1024,
  /* Below this the advertising channel either refuses the image or shows it
     badly. Checked from the real dimensions, never from a claim. */
  MIN_WIDTH: 600,
  MIN_HEIGHT: 600,
  MAX_WIDTH: 10000,
  MAX_HEIGHT: 10000,
  FILE_NAME_MAX: 200,
  NOTE_MAX: 500,
  REASON_MAX: 300,
});

/* ── WHAT MAY NOT BE SENT ───────────────────────────────────────────────────
   An allow-list governs the fields; these are named separately so a refusal can
   say what the actual problem is. Every one is somebody trying to give GRAV a
   POINTER instead of bytes, and a pointer is not an asset: GRAV cannot hash it,
   cannot size it, cannot prove it will still resolve tomorrow, and cannot prove
   the company may advertise with whatever is on the other end. */
const REFUSED_SOURCES = [
  pair("remote_url", "A web address", {
    why: "GRAV would be storing a promise that somebody else's server keeps answering. Upload the file itself.",
  }),
  pair("drive_identifier", "A storage identifier", {
    why: "A storage identifier names a file GRAV has never inspected and may not belong to this company. The library stores bytes it has read.",
  }),
  pair("email_attachment_url", "A link to an email attachment", {
    why: "An address the marketing engine may rewrite or expire. Upload the file itself.",
  }),
  pair("provider_image_hash", "An advertising channel's own image identifier", {
    why: "The channel issues that after GRAV uploads the bytes. A caller-supplied one would make GRAV claim it had uploaded a picture it has never seen.",
  }),
];
const REFUSED_SOURCE_CODES = codes(REFUSED_SOURCES);

/* Field names that mean somebody is offering a pointer. Checked over the
   caller's own keys, so an extra one is refused rather than ignored. */
const REFUSED_FIELD_HINTS = freeze([
  "url", "href", "link", "src", "driveid", "drivefileid", "fileid",
  "imagehash", "hash", "storageref", "storagereference", "attachment",
  "contentid", "remote", "path",
]);

/* Everything a caller may send with an upload. Bytes arrive as the file part. */
const UPLOAD_FIELDS = freeze(["fileName", "note"]);
const APPROVAL_FIELDS = freeze([...APPROVAL_ASSERTION_CODES, "note", "expectedSha256", "expectedRevision"]);

const ASSET_CODES = freeze({
  NO_FILE: "NO_FILE",
  TOO_LARGE: "TOO_LARGE",
  UNSUPPORTED_FORMAT: "UNSUPPORTED_FORMAT",
  SIGNATURE_MISMATCH: "SIGNATURE_MISMATCH",
  TOO_SMALL: "TOO_SMALL",
  TOO_LARGE_DIMENSIONS: "TOO_LARGE_DIMENSIONS",
  POINTER_NOT_BYTES: "POINTER_NOT_BYTES",
  STATE_CONFLICT: "STATE_CONFLICT",
  SELF_APPROVAL: "SELF_APPROVAL",
  ASSERTIONS_INCOMPLETE: "ASSERTIONS_INCOMPLETE",
  VERSION_MISMATCH: "VERSION_MISMATCH",
  NOT_DEPLOYABLE: "NOT_DEPLOYABLE",
});

module.exports = freeze({
  ASSET_STATES,
  ASSET_STATE_CODES,
  DEPLOYABLE_STATES,
  ASSET_TRANSITIONS,
  APPROVAL_ASSERTIONS,
  APPROVAL_ASSERTION_CODES,
  ASSET_LIMITS,
  REFUSED_SOURCES,
  REFUSED_SOURCE_CODES,
  REFUSED_FIELD_HINTS,
  UPLOAD_FIELDS,
  APPROVAL_FIELDS,
  ASSET_CODES,
});
