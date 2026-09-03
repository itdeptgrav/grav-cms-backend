const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");

/**
 * The resumable private-attachment path, guarded at its security properties.
 *
 * The behaviour was verified end-to-end against real Drive — session → PUT →
 * finalize, with the file confirmed PRIVATE, a wrong-uploader finalize refused,
 * and a retry idempotent. What a source test protects is that those properties
 * cannot be quietly undone: the file must never be made public, the finalize
 * must keep its ownership guard, and both routes must stay authenticated.
 */
const SERVICE = readFileSync("services/coworkAttachment.service.js", "utf8");
const ROUTES = readFileSync("routes/task_routes/coworkAttachments.js", "utf8");

function bodyOf(src, fnName) {
  const at = src.indexOf(`async function ${fnName}`);
  if (at === -1) return "";
  const next = src.indexOf("\nasync function ", at + 1);
  const alt = src.indexOf("\nfunction ", at + 1);
  const end = Math.min(next === -1 ? Infinity : next, alt === -1 ? Infinity : alt);
  return src.slice(at, end === Infinity ? src.length : end);
}

/* ── The file stays PRIVATE ────────────────────────────────────────────────── */

test("neither resumable function ever grants public access", () => {
  /* The whole reason submissions have their own path: a work product must not
     become downloadable by anyone with the link. `permissions.create` with
     `type: anyone` is exactly what the chat path does and this must not. */
  const session = bodyOf(SERVICE, "createPrivateResumableSession");
  const finalize = bodyOf(SERVICE, "finalizePrivateUpload");
  assert.ok(session.length > 0 && finalize.length > 0, "functions not found");
  for (const [name, body] of [["session", session], ["finalize", finalize]]) {
    assert.equal(/permissions\.create/.test(body), false, `${name} grants a permission`);
    assert.equal(/type:\s*["']anyone["']/.test(body), false, `${name} makes the file public`);
  }
});

/* ── Finalize cannot record someone else's file ───────────────────────────── */

test("finalize verifies the session marker — uploader, entity, and pending", () => {
  const finalize = bodyOf(SERVICE, "finalizePrivateUpload");
  assert.match(finalize, /props\.coworkUploader !== String\(uploadedBy\)/);
  assert.match(finalize, /props\.coworkEntityType !== String\(entityType\)/);
  assert.match(finalize, /props\.coworkEntityId !== String\(entityId\)/);
  assert.match(finalize, /props\.coworkPending !== "1"/);
  assert.match(finalize, /FORBIDDEN/);
});

test("an already-recorded file is only returned to its own uploader", () => {
  /* Idempotent for a legit retry; a mismatch is somebody else's file → refused,
     even though the fileId already has a record. */
  const finalize = bodyOf(SERVICE, "finalizePrivateUpload");
  assert.match(finalize, /r\.uploadedBy !== String\(uploadedBy\)/);
  assert.match(finalize, /return \{ id: d\.id/);
});

test("the mime is sniffed from the file's bytes, not the client's label", () => {
  /* The security sniff the multipart path did — kept, from a small range read
     rather than by pulling the whole file back through the process. */
  const finalize = bodyOf(SERVICE, "finalizePrivateUpload");
  assert.match(finalize, /Range: "bytes=0-511"/);
  assert.match(finalize, /sniffMimeType\(Buffer\.from\(head\.data\), null\)/);
});

test("the session records the marker, not a permission", () => {
  const session = bodyOf(SERVICE, "createPrivateResumableSession");
  assert.match(session, /coworkUploader: String\(uploadedBy\)/);
  assert.match(session, /coworkPending: "1"/);
});

/* ── Both routes are authenticated and permission-checked ─────────────────── */

test("the resumable routes are guarded exactly like the multipart upload", () => {
  for (const path of ["/attachments/resumable-session", "/attachments/finalize"]) {
    const at = ROUTES.indexOf(`"${path}"`);
    assert.ok(at !== -1, `route ${path} missing`);
    const block = ROUTES.slice(at, at + 900);
    assert.match(block, /verifyCoworkToken/, `${path} not authenticated`);
    assert.match(block, /verifyEmployeeToken/, `${path} not authenticated`);
    assert.match(block, /mayViewTask\(taskId, req\.coworkUser\)/, `${path} skips the task check`);
    /* The uploader is the verified caller, never the body. */
    assert.match(block, /uploadedBy: req\.coworkUser\.employeeId/);
  }
});

test("the old multipart route is kept as a fallback, not removed", () => {
  /* Additive: the switch is on the client, and the proven path stays. */
  assert.match(ROUTES, /upload\.single\("file"\)/);
  assert.match(ROUTES, /svc\.uploadAttachment\(/);
});
