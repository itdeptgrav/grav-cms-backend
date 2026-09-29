// test/accountant/zipReader.js
//
// A ZIP reader, for asserting that an export really is one.
//
// ── WHY NOT A LIBRARY ───────────────────────────────────────────────────────
// The repo declares no zip-READING dependency. Reaching for one that happens
// to be installed transitively is exactly the fragility that put `archiver`
// into package.json in the first place: the day a parent drops it, a test
// suite fails for a reason that has nothing to do with the code it covers.
//
// So this parses the container itself — end-of-central-directory, then the
// central directory, then each local header — and inflates with node's own
// zlib. That also makes the assertion stronger than a library call would:
// a response only passes if its bytes are a well-formed archive, not merely
// something a tolerant reader could open.
//
// Deliberately minimal. Handles what `archiver` writes for these packs: store
// (method 0) and deflate (method 8), no encryption, no zip64, no multi-disk.

"use strict";

const zlib = require("zlib");

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** The End of Central Directory record, found by scanning back from the end. */
function findEocd(buf) {
  // The record is 22 bytes plus a comment of up to 65,535 — no further back.
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error("Not a ZIP: no end-of-central-directory record");
}

/**
 * Every entry: `{ name, method, compressedSize, size, data }`.
 *
 * @param {Buffer} buf the whole archive
 */
function readZip(buf) {
  if (buf.length < 22) throw new Error("Not a ZIP: too short");
  if (buf.readUInt32LE(0) !== LOCAL_SIG) {
    throw new Error("Not a ZIP: missing local file header signature");
  }

  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== CD_SIG) {
      throw new Error(`Corrupt ZIP: central directory entry ${i} has no signature`);
    }
    const method = buf.readUInt16LE(p + 10);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");

    /* Sizes are read from the LOCAL header only when they are there. Streamed
     * entries — which is every PDF in these packs, appended before it is
     * finished — carry zeros and a trailing data descriptor instead, so the
     * central directory is the authority. */
    if (buf.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new Error(`Corrupt ZIP: "${name}" has no local file header`);
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;

    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const raw = buf.slice(start, start + compressedSize);

    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`Unsupported ZIP compression method ${method} for "${name}"`);

    if (data.length !== size) {
      throw new Error(
        `Corrupt ZIP: "${name}" inflated to ${data.length} bytes, directory says ${size}`,
      );
    }

    entries.push({ name, method, compressedSize, size, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Entries as a `{ name: Buffer }` map, for looking one up by name. */
function zipMap(buf) {
  return Object.fromEntries(readZip(buf).map((e) => [e.name, e.data]));
}

/** A CSV as rows of cells, honouring the doubled-quote escaping we write. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

module.exports = { readZip, zipMap, parseCsv };
