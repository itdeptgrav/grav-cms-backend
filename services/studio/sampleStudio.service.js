// services/studio/sampleStudio.service.js
//
// A SAMPLE'S GRAV STUDIO FILE, AS RULES (14 Oct 2026) — what the CMS routes
// (routes/CMS_Routes/Sales/sampleStudio.js) and GRAV Studio's own API
// (routes/Studio/studioApi.js) both do to a style's `studio` block, in one
// place, as plain functions on the document so they test without a database.
// The block itself is described in models/CMS_Models/Sales/sampleStudioSchema.js.

"use strict";

const crypto = require("crypto");
const { STUDIO_RENDER_KINDS, STUDIO_FLAT_KINDS } = require("../../models/CMS_Models/Sales/sampleStudioSchema");

function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const person = (p) => ({
  id: String(p?.id || p?.employeeId || ""),
  name: String(p?.name || ""),
  email: String(p?.email || "").toLowerCase(),
});

const text = (v) => (v === null || v === undefined ? "" : String(v).trim());

/** The style is with R&D — the only place a Studio file can be made or sent. */
function assertWithDesign(style) {
  if (!style || style.isActive === false) throw fail(404, "Style not found.");
  if (style.stage !== "rnd") throw fail(409, "This style is not with Design (R&D) yet.");
  if (style.status && style.status !== "active") throw fail(409, "This style is closed.");
}

function pushHistory(style, kind, note, by) {
  style.history = style.history || [];
  style.history.push({ kind, note, by: { name: by?.name || "" }, at: new Date() });
}

/** "Create": link a Studio file to the style. Idempotent — a linked style keeps its file. */
function linkFile(style, actor) {
  assertWithDesign(style);
  if (style.studio?.fileId) return { created: false };
  style.studio = {
    ...(style.studio?.toObject ? style.studio.toObject() : style.studio || {}),
    status: "linked",
    fileId: crypto.randomUUID(),
    linkedAt: new Date(),
    linkedBy: person(actor),
  };
  pushHistory(style, "studio_linked", "GRAV Studio file created", actor);
  return { created: true };
}

/** GRAV Studio made (or reopened) the file: the designer is recorded the first time. */
function markOpened(style, designer) {
  assertWithDesign(style);
  if (!style.studio?.fileId) linkFile(style, designer);
  if (!style.studio.openedAt) {
    style.studio.openedAt = new Date();
    style.studio.designer = person(designer);
    if (style.studio.status === "linked") style.studio.status = "in_progress";
    pushHistory(style, "studio_opened", "Opened in GRAV Studio", designer);
    return { first: true };
  }
  return { first: false };
}

const kindOf = (k, allowed, fallback) => (allowed.includes(k) ? k : fallback);

/**
 * File › Send for review: a new version. `files` are already stored:
 * `{ project, renders: [{…, kind}], flats: [{…, kind}] }`, each `{ fileId, name, mimeType, size }`.
 * The previous version, if nobody ruled on it, is superseded.
 */
function addVersion(style, { files, note, manifest, appVersion }, designer) {
  assertWithDesign(style);
  if (!files?.project?.fileId) throw fail(400, "The project file is missing.");
  if (!files.renders?.length) throw fail(400, "Send at least one render.");
  if (!style.studio?.fileId) markOpened(style, designer);
  const versions = style.studio.versions || [];
  for (const v of versions) if (v.outcome === "pending") v.outcome = "superseded";
  const version = versions.reduce((m, v) => Math.max(m, v.version || 0), 0) + 1;
  versions.push({
    version,
    sentAt: new Date(),
    sentBy: person(designer),
    note: text(note).slice(0, 2000),
    appVersion: text(appVersion).slice(0, 40),
    project: { ...files.project, kind: "project" },
    renders: files.renders.map((r) => ({ ...r, kind: kindOf(r.kind, STUDIO_RENDER_KINDS, "other") })),
    flats: (files.flats || []).map((f) => ({ ...f, kind: kindOf(f.kind, STUDIO_FLAT_KINDS, "front") })),
    artwork: (files.artwork || []).map((f) => ({ ...f, kind: "artwork" })),
    manifest: manifest && typeof manifest === "object" ? manifest : {},
    outcome: "pending",
  });
  style.studio.versions = versions;
  style.studio.status = "in_review";
  if (!style.studio.designer?.email) style.studio.designer = person(designer);
  pushHistory(style, "studio_sent", `GRAV Studio version ${version} sent for review`, designer);
  return { version };
}

/** The reviewer's answer on one version (Sales): "approved", or "changes" with a note. */
function decide(style, versionNo, { outcome, feedback }, actor) {
  if (!style?.studio?.versions?.length) throw fail(404, "Nothing has been sent for review.");
  if (!["approved", "changes"].includes(outcome)) throw fail(400, "Approve, or ask for changes.");
  const note = text(feedback).slice(0, 2000);
  if (outcome === "changes" && !note) throw fail(400, "Say what should change.");
  const v = style.studio.versions.find((x) => x.version === Number(versionNo));
  if (!v) throw fail(404, "No such version.");
  const latest = style.studio.versions.reduce((m, x) => Math.max(m, x.version || 0), 0);
  if (v.version !== latest) throw fail(409, `Version ${latest} is the one under review now.`);
  if (v.outcome !== "pending") throw fail(409, `Version ${v.version} was already ${v.outcome === "approved" ? "approved" : "answered"}.`);
  v.outcome = outcome;
  v.feedback = note;
  v.decidedAt = new Date();
  v.decidedBy = person(actor);
  style.studio.status = outcome;
  pushHistory(
    style,
    outcome === "approved" ? "studio_approved" : "studio_changes",
    outcome === "approved" ? `GRAV Studio version ${v.version} approved` : `Changes asked on version ${v.version}: ${note}`,
    actor,
  );
  return { version: v.version, outcome };
}

/** Every stored file id of the style's Studio versions, and of its brief images. */
function knownFileIds(style) {
  const ids = new Set();
  for (const v of style?.studio?.versions || []) {
    for (const f of [v.project, ...(v.renders || []), ...(v.flats || []), ...(v.artwork || [])]) {
      if (f?.fileId) ids.add(f.fileId);
    }
  }
  for (const i of style?.brief?.images || []) if (i?.fileId) ids.add(i.fileId);
  return ids;
}

/* ── WHAT THE CARD AND THE APP SHOW ──────────────────────────────────────── */

const BRIEF_FIELDS = [
  ["gender", "Gender"],
  ["fit", "Fit"],
  ["sizeRange", "Sizes"],
  ["colour", "Colour"],
  ["fabricPreference", "Fabric"],
  ["fabricComposition", "Composition"],
  ["gsm", "GSM"],
  ["branding", "Branding"],
  ["brandingPlacement", "Branding placement"],
  ["trims", "Trims"],
  ["specialConstruction", "Construction"],
  ["quantity", "Quantity"],
];

/** The brief as labelled rows, blanks dropped, in a fixed order. */
function specRows(brief) {
  const b = brief || {};
  const rows = BRIEF_FIELDS.map(([k, label]) => [label, text(b[k])]).filter(([, v]) => v);
  for (const c of b.customSpecs || []) if (text(c?.label) && text(c?.value)) rows.push([text(c.label), text(c.value)]);
  return rows.map(([label, value]) => ({ label, value }));
}

function imageOf(i) {
  return { fileId: i?.fileId || "", publicId: i?.publicId || "", name: i?.name || "", url: i?.url || "" };
}

function versionView(v) {
  const file = (f) => (f ? { fileId: f.fileId, name: f.name || "", mimeType: f.mimeType || "", size: f.size || 0, kind: f.kind || "" } : null);
  return {
    version: v.version,
    sentAt: v.sentAt,
    sentBy: v.sentBy?.name || "",
    note: v.note || "",
    appVersion: v.appVersion || "",
    project: file(v.project),
    renders: (v.renders || []).map(file),
    flats: (v.flats || []).map(file),
    artwork: (v.artwork || []).map(file),
    outcome: v.outcome,
    feedback: v.feedback || "",
    decidedAt: v.decidedAt,
    decidedBy: v.decidedBy?.name || "",
  };
}

/** The Studio state of a style, for the card, the review page and the app. */
function studioView(style) {
  const s = style?.studio || {};
  const versions = (s.versions || []).map(versionView).sort((a, b) => b.version - a.version);
  return {
    status: s.status || "none",
    fileId: s.fileId || "",
    linkedAt: s.linkedAt || null,
    linkedBy: s.linkedBy?.name || "",
    openedAt: s.openedAt || null,
    designer: s.designer?.name || s.designer?.email || "",
    latest: versions[0] || null,
    versions,
  };
}

/** One sample as the card and Studio's start screen describe it. */
function sampleCard(style, { customerName = "" } = {}) {
  const b = style?.brief || {};
  return {
    id: String(style._id),
    sampleStyleId: style.sampleStyleId || "",
    styleCode: style.styleCode || "",
    productName: style.productName || "",
    customerName: customerName || "",
    sampleType: style.sampleType || "",
    note: text(b.note),
    specs: specRows(b),
    images: (b.images || []).map(imageOf),
    dueDate: style.sample?.dueDate || style.techSheet?.dueDate || null,
    updatedAt: style.updatedAt || null,
    studio: studioView(style),
  };
}

module.exports = {
  linkFile,
  markOpened,
  addVersion,
  decide,
  knownFileIds,
  specRows,
  studioView,
  sampleCard,
  assertWithDesign,
};
