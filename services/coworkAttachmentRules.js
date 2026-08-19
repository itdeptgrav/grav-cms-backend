/**
 * GRAV-CMS-BACKEND/services/coworkAttachmentRules.js
 *
 * The validation half of Cowork attachments, with NO dependencies.
 *
 * Split out from `coworkAttachment.service.js` because these are the security
 * decisions — what a file really is, what may be stored, how big, and what a
 * filename is allowed to contain — and they should be testable without a
 * Firebase credential or a Drive client. A rule that can only be exercised by
 * standing up the whole service tends not to be exercised.
 */

const COWORK_FOLDER_NAME = "Cowork Attachments";
const COLLECTION = "cowork_attachments";

/**
 * No size cap on a Cowork attachment — removed on the owner's instruction.
 *
 * It was 50 MB, matching the voucher service's multer cap. Nothing about the
 * STORAGE required it: these go to Google Drive through a service account, and
 * Drive takes files far larger than this ever allowed. The cap was a policy
 * choice and the owner has withdrawn it.
 *
 * `null` rather than `Infinity` or a very large number, so a caller that
 * forgets to handle "no cap" fails loudly on a null comparison instead of
 * silently enforcing a limit nobody chose.
 *
 * **What still bounds an upload, and is not this file's to change:** the route
 * uses `multer.memoryStorage()`, so the whole file is held in the Node
 * process's RAM while it is being forwarded to Drive. That is a property of
 * the transport, not a rule — see the note in `coworkAttachments.js`.
 */
const MAX_BYTES = null;

/**
 * What may be stored, keyed by the type read from the FILE'S OWN BYTES.
 *
 * The client's `mimetype` and filename are both attacker-controlled and are
 * used for nothing here except the display name. A `.pdf` that is actually an
 * HTML document would otherwise be stored and later served as a PDF.
 */
/**
 * **No type is refused any more** — withdrawn on the owner's instruction.
 *
 * `ALLOWED` was the upload gate: anything not in it was rejected. It is now the
 * list of types that may be shown INLINE in the browser, which is a different
 * job and the only one that still needs a list.
 *
 * Why the list did not simply get deleted: the download route serves an
 * attachment with its own `Content-Type` and `Content-Disposition: inline`, so
 * that images and PDFs can be previewed. With the upload gate gone, an
 * uploaded HTML file would be served as `text/html`, inline, from this origin —
 * the uploader's JavaScript running inside whoever opened it, with their
 * session. Allowing every type to be STORED is the owner's decision; serving
 * every type inline was never part of it, and is not required by it.
 *
 * So anything outside this list downloads instead of rendering. A `.zip`, an
 * `.mp4`, a `.psd` all upload and all come back intact — they just arrive as a
 * file rather than as a page.
 */
const INLINE_SAFE = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

/** Whether this type may be rendered in the browser rather than downloaded. */
function mayRenderInline(mimeType) {
  return INLINE_SAFE.has(String(mimeType || "").toLowerCase());
}

const startsWith = (buf, bytes) =>
  buf.length >= bytes.length && bytes.every((b, i) => buf[i] === b);

/**
 * The file's real type, from its leading bytes.
 *
 * Returns null when nothing recognisable is found, which is a refusal rather
 * than a fallback — "unknown" must never become `application/octet-stream` and
 * slip past the allow-list.
 *
 * The Office formats are all ZIP containers and share `PK\x03\x04`, so a
 * declared subtype is consulted ONLY to choose between them, and only after the
 * container itself has been proven a ZIP. That is the one place a client's
 * claim is honoured, and it cannot widen the allow-list: a ZIP claiming to be a
 * PDF still resolves as a ZIP and is refused.
 */
function sniffMimeType(buffer, declaredType) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;

  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46])) return "application/pdf";
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (
    startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) &&
    buffer.length >= 12 &&
    buffer.slice(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  // Legacy Office (.doc/.xls/.ppt) — OLE2 compound file.
  if (startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0])) {
    const ole = {
      "application/vnd.ms-excel": "application/vnd.ms-excel",
      "application/vnd.ms-powerpoint": "application/vnd.ms-powerpoint",
    };
    return ole[declaredType] || "application/msword";
  }

  // OOXML (.docx/.xlsx/.pptx) — a ZIP container.
  if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04])) {
    const ooxml = new Set([
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ]);
    return ooxml.has(declaredType) ? declaredType : null;
  }

  // Text has no magic number. Accepted only when the bytes really are text and
  // the client said so — a binary claiming text/plain fails the scan below.
  if (declaredType === "text/plain" || declaredType === "text/csv") {
    const head = buffer.slice(0, 512);
    for (const byte of head) {
      const printable =
        byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte < 0x7f);
      if (!printable) return null;
    }
    return declaredType;
  }

  return null;
}

/** A filename safe to store and to put in a Content-Disposition header. */
function safeName(name) {
  const base = typeof name === "string" ? name : "";
  const cleaned = base
    /* Header-injection first: this string ends up inside a quoted
       Content-Disposition value, where a quote or a newline would let the
       client write headers of its own. */
    .replace(/[\r\n"\\]/g, "")
    .replace(/[/\\]/g, "-")
    /* Then path traversal. The name is used as a Drive title and a download
       filename, neither of which is a filesystem path — but a browser may
       write it to disk, and "safe" should not depend on knowing every
       consumer. */
    .replace(/\.{2,}/g, ".")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(0, 180);
  return cleaned || "attachment";
}


module.exports = {
  sniffMimeType,
  safeName,
  /* Was `ALLOWED`, the upload gate. Now the inline-render list — see above. */
  INLINE_SAFE,
  mayRenderInline,
  MAX_BYTES,
  COLLECTION,
  COWORK_FOLDER_NAME,
};
