// services/marketing/assets/imageBytes.js
//
// WHAT THE BYTES ACTUALLY ARE, READ FROM THE BYTES.
//
// ── WHY NOTHING THE CALLER SAYS IS BELIEVED ────────────────────────────────
// A filename is a string somebody typed. A multipart `Content-Type` is a string
// somebody's browser guessed, and a script can set it to anything. Neither has
// ever been evidence about the contents of a file.
//
// This matters more for advertising than for most uploads. The bytes end up in
// a paid advertisement that GRAV pays for and a third party publishes, and an
// account that serves the wrong kind of file gets restricted. So the format is
// determined by reading the file's own signature, the dimensions are parsed out
// of its own headers, and the hash is taken over exactly what arrived.
//
// ── AND WHY THERE IS NO IMAGE LIBRARY HERE ─────────────────────────────────
// This deployment has no `sharp` and no `jimp`. Adding one for two header reads
// would pull in a native binary, a build step and a decoder — and a decoder is
// an attack surface pointed at untrusted bytes, which is the one thing this
// file exists to avoid trusting.
//
// PNG and JPEG both state their dimensions in a fixed, documented header that
// can be read without decoding a single pixel. That is what happens below:
// bounded reads, no allocation proportional to the input, no interpretation of
// image data. It is not a general image parser and must not become one — it can
// answer "how big is this JPEG" and nothing else.
"use strict";

const crypto = require("crypto");

/* ── THE TWO FORMATS THE ADVERTISING CHANNEL ACCEPTS ────────────────────────
   Deliberately narrow. Each one here is a format whose header this file can
   read completely; a third would need its own parser and its own tests, and
   "we also allow WebP" is not worth a header reader nobody has exercised. */
const SUPPORTED = Object.freeze({
  "image/jpeg": Object.freeze({ label: "JPEG", extensions: Object.freeze([".jpg", ".jpeg"]) }),
  "image/png": Object.freeze({ label: "PNG", extensions: Object.freeze([".png"]) }),
});

/* ── FORMATS REFUSED BY NAME, AND WHY EACH ONE ─────────────────────────────
   Refused by SIGNATURE, so renaming a file changes nothing. Named individually
   because "unsupported format" tells somebody nothing about why the file they
   are certain is fine has been rejected. */
const REFUSED = Object.freeze([
  Object.freeze({
    code: "svg",
    label: "SVG",
    why: "An SVG is a document that can carry scripts and can fetch other things when it is rendered. It is not a picture in the sense an advertising channel means, and neither GRAV nor the channel should be executing an uploaded document.",
    /* SVG has no binary magic — it is XML — so it is detected by its opening
       text, after whitespace and an optional byte-order mark. */
    detect: (buf) => {
      const head = buf.subarray(0, 512).toString("utf8").replace(/^﻿/, "").trimStart().toLowerCase();
      return head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"));
    },
  }),
  Object.freeze({
    code: "html",
    label: "HTML",
    why: "A web page is not an image.",
    detect: (buf) => {
      const head = buf.subarray(0, 512).toString("utf8").replace(/^﻿/, "").trimStart().toLowerCase();
      return head.startsWith("<!doctype html") || head.startsWith("<html");
    },
  }),
  Object.freeze({
    code: "pdf",
    label: "PDF",
    why: "A PDF is a document. An advertising channel will not show one as an image.",
    detect: (buf) => buf.subarray(0, 5).toString("latin1") === "%PDF-",
  }),
  Object.freeze({
    code: "gif",
    label: "GIF",
    why: "A GIF may be animated, which the single-image campaign shape GRAV supports does not cover.",
    detect: (buf) => {
      const head = buf.subarray(0, 6).toString("latin1");
      return head === "GIF87a" || head === "GIF89a";
    },
  }),
  Object.freeze({
    code: "webp",
    label: "WebP",
    why: "GRAV cannot read this format's dimensions without a decoder, so it cannot check the image is large enough before spending money on it.",
    detect: (buf) => buf.subarray(0, 4).toString("latin1") === "RIFF"
      && buf.subarray(8, 12).toString("latin1") === "WEBP",
  }),
  Object.freeze({
    code: "video",
    label: "Video",
    why: "The campaign shape GRAV supports is a single image.",
    detect: (buf) => {
      /* ISO base media (MP4, MOV) declares `ftyp` at offset 4. */
      if (buf.length > 12 && buf.subarray(4, 8).toString("latin1") === "ftyp") return true;
      /* Matroska / WebM. */
      return buf.length > 4 && buf.readUInt32BE(0) === 0x1a45dfa3;
    },
  }),
]);

/* ── PNG ────────────────────────────────────────────────────────────────────
   Eight signature bytes, then the IHDR chunk: a 4-byte length, the four
   characters `IHDR`, then width and height as big-endian 32-bit integers. The
   standard requires IHDR to be first, so the offsets are fixed and no chunk
   walking is needed. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPng(buf) {
  if (buf.length < 24) return null;
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buf.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  return { mimeType: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/* ── JPEG ───────────────────────────────────────────────────────────────────
   A JPEG is a chain of segments. Each begins with 0xFF, a marker byte, then a
   two-byte length covering the length field itself. Walking it means finding
   the "start of frame" marker, whose payload holds the dimensions: one byte of
   precision, then height, then width, both big-endian 16-bit.

   Three things below matter more than they look:

     The frame markers are an enumerated SET, not a range. 0xC4, 0xC8 and 0xCC
     sit inside the C0–CF block and are NOT frames — they are Huffman tables and
     arithmetic-coding conditioning. Treating the block as a range reads two
     bytes of a Huffman table as an image height.

     The walk is bounded by the buffer and by a segment count. A malformed file
     can otherwise describe a segment that points backwards or nowhere, and the
     loop never ends.

     A zero dimension is refused rather than returned. It is a corrupt file, and
     downstream everything divides by it. */
const JPEG_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
/* Standalone markers carry no length field, so the walk must skip them by two
   bytes rather than reading a length that is not there. */
const JPEG_STANDALONE = new Set([0xd8, 0xd9, 0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);

function readJpeg(buf) {
  if (buf.length < 4) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;

  let offset = 2;
  /* A JPEG with more segments than this is not a JPEG anybody made. The bound
     is what guarantees termination regardless of what the bytes claim. */
  for (let segments = 0; segments < 2048; segments += 1) {
    /* Fill bytes (0xFF) may pad before a marker. */
    while (offset < buf.length && buf[offset] === 0xff && buf[offset + 1] === 0xff) offset += 1;
    if (offset + 1 >= buf.length) return null;
    if (buf[offset] !== 0xff) return null;

    const marker = buf[offset + 1];
    offset += 2;

    if (JPEG_STANDALONE.has(marker)) continue;
    /* Start of scan: compressed data follows and there is no frame header after
       it worth walking to. */
    if (marker === 0xda) return null;

    if (offset + 1 >= buf.length) return null;
    const length = buf.readUInt16BE(offset);
    /* A length below 2 cannot include its own two bytes, so it is malformed and
       would move the cursor backwards. */
    if (length < 2 || offset + length > buf.length) return null;

    if (JPEG_FRAME_MARKERS.has(marker)) {
      /* precision(1) + height(2) + width(2) = 5 bytes after the length. */
      if (length < 7) return null;
      const height = buf.readUInt16BE(offset + 3);
      const width = buf.readUInt16BE(offset + 5);
      if (!width || !height) return null;
      return { mimeType: "image/jpeg", width, height };
    }

    offset += length;
  }
  return null;
}

/**
 * What these bytes are, read from the bytes.
 *
 * @param {Buffer} buffer
 * @returns {{ok:true, mimeType:string, width:number, height:number, byteSize:number, sha256:string}
 *          |{ok:false, code:string, label?:string, why:string}}
 */
function inspect(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, code: "empty", why: "The upload contained no file." };
  }

  /* ── REFUSED FORMATS ARE IDENTIFIED FIRST ──────────────────────────────
     So an SVG is refused AS an SVG — with the reason that applies to SVGs —
     rather than falling through to a generic "not a JPEG or PNG". Somebody who
     uploaded a logo they are certain is fine deserves to know why. */
  for (const refused of REFUSED) {
    if (refused.detect(buffer)) {
      return { ok: false, code: refused.code, label: refused.label, why: refused.why };
    }
  }

  const read = readPng(buffer) || readJpeg(buffer);
  if (!read) {
    return {
      ok: false,
      code: "unreadable",
      why: "GRAV could not read this file as a JPEG or a PNG. A file renamed to end in .jpg is not a JPEG — the advertising channel reads the contents, and so does GRAV.",
    };
  }
  if (!read.width || !read.height) {
    return { ok: false, code: "no_dimensions", why: "GRAV could not read this image's size from the file itself." };
  }

  return {
    ok: true,
    mimeType: read.mimeType,
    formatLabel: SUPPORTED[read.mimeType].label,
    width: read.width,
    height: read.height,
    byteSize: buffer.length,
    /* ── OVER EXACTLY WHAT ARRIVED ────────────────────────────────────────
       Not over a re-encoded, normalised or resized copy. This hash is what
       makes a stored version immutable in fact rather than by convention: the
       same bytes hash the same for ever, and a different file cannot claim to
       be the one that was approved. */
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
  };
}

/**
 * Does the claimed filename agree with what the bytes turned out to be?
 *
 * Reported, not enforced — the bytes have already decided the format, and a
 * .png that is really a JPEG is a usable JPEG. But the disagreement is worth
 * surfacing: it is usually somebody's export settings, and occasionally it is
 * somebody trying to slip a file past a check that reads names.
 */
function extensionAgrees(fileName, mimeType) {
  const name = String(fileName ?? "").toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot < 0) return { hasExtension: false, agrees: false };
  const ext = name.slice(dot);
  const spec = SUPPORTED[mimeType];
  return { hasExtension: true, extension: ext, agrees: Boolean(spec && spec.extensions.includes(ext)) };
}

module.exports = { inspect, extensionAgrees, SUPPORTED, REFUSED, readPng, readJpeg };
