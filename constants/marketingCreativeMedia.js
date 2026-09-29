// constants/marketingCreativeMedia.js
//
// THE CREATIVE MEDIA LIBRARY: FILES FOR PLANNED SOCIAL CONTENT.
//
// ── NOT THE ADVERTISING IMAGE LIBRARY, AND NOT ITS APPROVAL ────────────────
// The advertising image library asks one question — may the company pay to
// publish this exact picture — and answers it with a review. This library asks
// none: it holds the files a creative draft refers to. Whether a post is good
// to go is the Content Planner's approval, of the whole creative, and nothing
// here says anything about it. "Approved for advertising" does not appear in
// this library and cannot be inherited by it.
//
// ── IMAGES TODAY; VIDEO BLOCKED, AND WHY ───────────────────────────────────
// Stated as data so every response carries it and nobody mistakes the gap for
// an oversight or a note for an upload.
"use strict";

const freeze = Object.freeze;
const pair = (code, label, extra = {}) => freeze({ code, label, ...extra });
const codes = (list) => freeze(list.map((x) => x.code));

const KINDS = [
  pair("image", "Image", { supported: true }),
  pair("video", "Video", { supported: false }),
];

/* What a version can be. There is no "approved": approval belongs to the
   planned item that uses the file, not to the file. */
const STATES = [
  pair("available", "Available", { means: "The file is stored and can be shown and used in creative drafts." }),
  pair("withdrawn", "Withdrawn", {
    means: "Somebody withdrew this file. It is kept for the record and identifiable wherever it was used, but it is never shown and cannot be used in anything new.",
  }),
];
const STATE_CODES = codes(STATES);

const LIMITS = freeze({
  /* Checked while the bytes arrive (the route) and again before storage (the
     service). A social image larger than this is a source file somebody meant
     to export first. */
  IMAGE_MAX_BYTES: 10 * 1024 * 1024,
  IMAGE_MIN_WIDTH: 320,
  IMAGE_MIN_HEIGHT: 320,
  IMAGE_MAX_WIDTH: 8000,
  IMAGE_MAX_HEIGHT: 8000,
  FILE_NAME_MAX: 200,
  NOTE_MAX: 500,
  REASON_MAX: 300,
  PAGE_DEFAULT: 25,
  PAGE_MAX: 100,
  VERSIONS_MAX: 50,
});

const IMAGE_FORMATS = freeze([
  freeze({ mimeType: "image/jpeg", label: "JPEG" }),
  freeze({ mimeType: "image/png", label: "PNG" }),
]);

/* ── WHY VIDEO IS NOT ACCEPTED ──────────────────────────────────────────────
   Each item is a property of the storage GRAV has today, found by reading it,
   not a guess. All four have to be fixed before a video can be stored and
   shown safely. */
const VIDEO_BLOCKERS = freeze([
  pair("upload_buffers_whole_file", "Uploads are held whole in memory", {
    means: "The company file store accepts a file only as one in-memory block. A social video is tens to hundreds of megabytes; several at once would exhaust the server. Streaming uploads to storage do not exist yet.",
  }),
  pair("no_range_streaming", "Previews cannot seek", {
    means: "GRAV's authenticated preview reads a file from start to end. A video player seeks with partial requests, which that path does not support.",
  }),
  pair("integrity_check_reads_everything", "The integrity check reads the whole file", {
    means: "Before showing a file GRAV re-reads and re-hashes all of it, so the preview can never show bytes other than the recorded version. For a video that means downloading it in full on every view and every seek.",
  }),
  pair("no_video_inspection_in_production", "Video contents cannot be verified", {
    means: "GRAV verifies a file by reading its contents, not its name. For video that needs an inspection tool the production server does not have, so GRAV could not tell a real, playable video from a renamed file.",
  }),
]);

const VIDEO = freeze({
  supported: false,
  means: "Video cannot be uploaded yet. Describe a video in a written reference in the creative draft; it will be labelled as not a stored file.",
  blockers: VIDEO_BLOCKERS,
});

module.exports = freeze({
  KINDS,
  STATES,
  STATE_CODES,
  LIMITS,
  IMAGE_FORMATS,
  VIDEO,
  VIDEO_BLOCKERS,
});
