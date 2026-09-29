// services/marketing/contentPlan/contentAssets.js
//
// WHAT THE CONTENT LIBRARY SAYS ABOUT THE ASSETS A PLAN LINKS TO.
//
// ── THROUGH THE EXISTING READ-ONLY INVENTORY, AND NOTHING ELSE ─────────────
// Assets are found by paging the content library's own list — the same GET,
// the same minimal rows, the same company gate and the same safe row the
// Content screen uses. No new endpoint, no single-item read that would fetch an
// email's body, and no write of any kind.
//
// ── MISSING IS A CLAIM, SO IT NEEDS THE WHOLE LIBRARY ──────────────────────
// An asset is `missing` only when every page of its kind was read and it was
// on none of them. A library too large to read within the bound, or one that
// failed half-way, makes the asset `unavailable`: not finding something in part
// of a list proves nothing.
"use strict";

const contentInventory = require("../contentInventory.service");
const C = require("../../../constants/marketingContentPlan");

const str = (v) => String(v ?? "").trim();

const NOT_CONFIGURED = new Set(["MARKETING_COMPANY_NOT_CONFIGURED", "MAUTIC_NOT_CONFIGURED", "MARKETING_ENGINE_NOT_CONFIGURED"]);

const keyOf = (kind, contentId) => `${kind}:${contentId}`;

/**
 * @param {object} args
 * @param {ObjectId} args.companyId
 * @param {Array<{kind:string, contentId:string}>} args.refs
 * @param {object} [args.client]  a content client (tests); default is the inventory's own
 * @returns {Promise<{library:string, measuredAt:string|null, lookup:(kind,id)=>object}>}
 */
async function resolve({ companyId, refs = [], client = null, env = process.env, now = new Date() } = {}) {
  const wanted = new Map();
  for (const r of refs) {
    if (!r || !r.kind || !r.contentId) continue;
    if (!wanted.has(r.kind)) wanted.set(r.kind, new Set());
    wanted.get(r.kind).add(str(r.contentId));
  }

  if (!wanted.size) {
    return { library: "not_needed", measuredAt: null, lookup: () => ({ status: "not_linked" }) };
  }

  const found = new Map();
  const complete = new Set();
  let library = "available";

  for (const [kind, ids] of wanted) {
    const remaining = new Set(ids);
    let cursor = null;
    try {
      for (let page = 0; page < C.LIMITS.LIBRARY_PAGES_PER_KIND; page += 1) {
        const view = await contentInventory.list({
          companyId, kind, cursor, limit: contentInventory.MAX_PAGE, client, env, now,
        });
        for (const row of view.rows) {
          if (remaining.has(row.contentId)) {
            found.set(keyOf(kind, row.contentId), row);
            remaining.delete(row.contentId);
          }
        }
        if (!remaining.size) break;
        if (!view.hasMore) {
          complete.add(kind);
          break;
        }
        cursor = view.nextCursor;
      }
    } catch (err) {
      library = NOT_CONFIGURED.has(str(err?.code)) ? "not_configured" : "unavailable";
      break;
    }
  }

  return {
    library,
    measuredAt: now.toISOString(),
    lookup(kind, contentId) {
      const row = found.get(keyOf(kind, str(contentId)));
      if (row) return { status: "found", row };
      if (library === "available" && complete.has(kind)) return { status: "missing" };
      return { status: library === "not_configured" ? "not_configured" : "unavailable" };
    },
  };
}

module.exports = { resolve };
