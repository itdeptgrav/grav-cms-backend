// services/whatsappTemplates.js
//
// The WABA's approved templates, cached — and the one place that knows how to
// turn a stored `[template: name]` placeholder back into the sentence the
// customer actually received.
//
// ── Why (6 Sep 2026, explicit request) ────────────────────────────────────
//
// "why it is showing template approval or like thing, don't showcase ok...
// like a normal message showcase it ok."
//
// Two rows in the live database — `[template: test_]` and `[template: hello]`
// — were written before whatsappSend.js learned to store a template's real
// body, and the chat rendered them as a grey "Template · test_" chip over
// "Sent the "Test" template." That is a description OF a message, not the
// message. The customer received the template's body text; the salesperson
// reading the log should see the same words.
//
// Nothing rewrites the stored rows: history stays exactly as it was written.
// Instead every reader (the thread, the conversation list preview, the
// lead-workspace view) runs its text through `renderStoredText()`, and the
// send path calls `resolveBody()` so a caller that forgot to pass `bodyText`
// can no longer create a new placeholder row in the first place.
//
// The template list is fetched from Meta at most once every TTL, shared by
// every caller, and a fetch failure returns the last good list rather than
// nothing — a chat page must not go blank because Meta had a slow minute.
"use strict";

const { cfg, graphBase } = require("../config/whatsapp");

const TTL_MS = 5 * 60 * 1000;
const PLACEHOLDER = /^\s*\[template:\s*([^\]]+)\]\s*$/i;

let cache = { at: 0, byName: new Map(), list: [] };
let inflight = null;

function normaliseName(name) {
  return String(name || "").trim().toLowerCase();
}

/** Fetch every APPROVED template from Meta and index the body text by name. */
async function fetchTemplates() {
  if (!cfg.wabaId || !cfg.accessToken) return [];
  const url = `${graphBase()}/${cfg.wabaId}/message_templates?fields=name,language,status,category,components&limit=200&access_token=${cfg.accessToken}`;
  const r = await fetch(url);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `Could not load templates (HTTP ${r.status}).`);
  return (d.data || [])
    .filter((t) => t.status === "APPROVED")
    .map((t) => {
      const body = (t.components || []).find((c) => c.type === "BODY");
      const bodyText = body?.text || "";
      return {
        name: t.name,
        language: t.language,
        category: t.category,
        bodyText,
        varCount: new Set(bodyText.match(/\{\{\d+\}\}/g) || []).size,
      };
    });
}

/**
 * The approved templates, from cache when fresh. Concurrent callers share one
 * fetch; a failed refresh keeps serving the previous list (and rethrows only
 * when there is no previous list to fall back on).
 */
async function getApprovedTemplates() {
  if (Date.now() - cache.at < TTL_MS && cache.list.length) return cache.list;
  if (!inflight) {
    inflight = fetchTemplates()
      .then((list) => {
        cache = { at: Date.now(), list, byName: new Map(list.map((t) => [normaliseName(t.name), t])) };
        return list;
      })
      .catch((e) => {
        if (cache.list.length) return cache.list; // stale beats blank
        throw e;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** The body text of one template by name, or "" when unknown. Never throws. */
async function resolveBody(name) {
  try {
    await getApprovedTemplates();
  } catch {
    /* fall through to whatever the cache holds */
  }
  return cache.byName.get(normaliseName(name))?.bodyText || "";
}

/** `[template: name]` → name, else null. */
function placeholderName(text) {
  const m = PLACEHOLDER.exec(String(text || ""));
  return m ? m[1].trim() : null;
}

/**
 * The words a customer saw, for a stored message text.
 *
 * A row that already holds real text passes through untouched. A placeholder
 * row becomes the template's body; body variables whose values were never
 * stored (the old rows carried none) are shown as an ellipsis rather than as
 * `{{1}}`, which reads as a bug. When the template is no longer on the WABA at
 * all, the name is shown title-cased — a plain sentence, still no bracket
 * syntax and still no "Template ·" chip.
 */
function renderStoredText(text) {
  const name = placeholderName(text);
  if (!name) return text;
  const body = cache.byName.get(normaliseName(name))?.bodyText;
  if (body) return body.replace(/\{\{\d+\}\}/g, "…");
  return name.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/**
 * Warm the cache, then map a list of message rows (lean objects) so every
 * `text` is readable. Used by the thread and lead-view routes.
 */
async function withReadableText(rows) {
  if (!rows.some((r) => placeholderName(r?.text))) return rows;
  try {
    await getApprovedTemplates();
  } catch {
    /* renderStoredText degrades to the title-cased name */
  }
  return rows.map((r) => (placeholderName(r?.text) ? { ...r, text: renderStoredText(r.text) } : r));
}

module.exports = { getApprovedTemplates, resolveBody, placeholderName, renderStoredText, withReadableText };
