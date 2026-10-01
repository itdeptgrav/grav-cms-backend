// services/reporting/chartRegistry.js
//
// THE ONE PLACE THAT KNOWS WHICH HIDDEN QUESTION IS WHOSE.
//
// A thin repository over `reporting.report_chart`. It exists as its own module
// so that the answer to "what could possibly leak a Metabase question id into
// a response?" is a list of the callers of this file — which is one service —
// rather than a search of every route that serialises a document.
//
// It speaks over the reporting mart's ADMIN connection: this is the mart's own
// bookkeeping rather than anybody's accounting data, `reporting_sync` is for
// the sync and `metabase_reader` is deliberately not granted the table at all.

"use strict";

const pg = require("./pgClient");

/** Postgres' unique-violation code, which the create/reuse race relies on. */
const UNIQUE_VIOLATION = "23505";

const one = (rows) => (rows.length ? row(rows[0]) : null);

/** camelCase, because everything above this file is JavaScript. */
function row(r) {
  return r && {
    id: Number(r.id),
    organizationId: r.organization_id,
    kind: r.kind,
    reportId: r.report_id,
    userId: r.user_id,
    layoutHash: r.layout_hash,
    cardId: Number(r.card_id),
    collectionId: r.collection_id === null ? null : Number(r.collection_id),
    display: r.display,
    archivedAt: r.archived_at,
    lastUsedAt: r.last_used_at,
  };
}

const q = (sql, params) => pg.query("admin", sql, params);

const COLUMNS = `id, organization_id, kind, report_id, user_id, layout_hash,
                 card_id, collection_id, display, archived_at, last_used_at`;

async function findByHash({ organizationId, kind, layoutHash }) {
  const { rows } = await q(
    `SELECT ${COLUMNS} FROM reporting.report_chart
      WHERE organization_id = $1 AND kind = $2 AND layout_hash = $3 AND archived_at IS NULL`,
    [String(organizationId), kind, layoutHash],
  );
  return one(rows);
}

async function findByReport({ organizationId, reportId }) {
  const { rows } = await q(
    `SELECT ${COLUMNS} FROM reporting.report_chart
      WHERE organization_id = $1 AND kind = 'saved' AND report_id = $2 AND archived_at IS NULL`,
    [String(organizationId), String(reportId)],
  );
  return one(rows);
}

/**
 * Remember a question.
 *
 * Throws with `.unique === true` when another request got there first, which
 * is how the caller knows to re-read rather than to give up.
 */
async function insert({
  organizationId, kind, reportId = null, userId = null, layoutHash, cardId,
  collectionId = null, display = "table",
}) {
  try {
    const { rows } = await q(
      `INSERT INTO reporting.report_chart
         (organization_id, kind, report_id, user_id, layout_hash, card_id, collection_id, display)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${COLUMNS}`,
      [String(organizationId), kind, reportId === null ? null : String(reportId),
       userId === null ? null : String(userId), layoutHash, Number(cardId),
       collectionId === null ? null : Number(collectionId), display],
    );
    return one(rows);
  } catch (err) {
    if (err && err.code === UNIQUE_VIOLATION) {
      const clash = new Error("That chart is already registered.");
      clash.unique = true;
      throw clash;
    }
    throw err;
  }
}

/** A heartbeat, which is the only thing keeping a draft out of the cleanup. */
async function touch(id) {
  await q(
    "UPDATE reporting.report_chart SET last_used_at = now(), updated_at = now() WHERE id = $1",
    [id],
  );
}

/** The same question, now drawing a different layout. */
async function rewrite(id, { layoutHash, display }) {
  await q(
    `UPDATE reporting.report_chart
        SET layout_hash = $2, display = $3, last_used_at = now(), updated_at = now()
      WHERE id = $1`,
    [id, layoutHash, display],
  );
}

/** A saved report whose question had gone, pointed at a new one. */
async function reassign(id, { cardId, layoutHash, display, collectionId = null }) {
  await q(
    `UPDATE reporting.report_chart
        SET card_id = $2, layout_hash = $3, display = $4, collection_id = COALESCE($5, collection_id),
            archived_at = NULL, last_used_at = now(), updated_at = now()
      WHERE id = $1`,
    [id, Number(cardId), layoutHash, display, collectionId === null ? null : Number(collectionId)],
  );
}

async function remove(id) {
  await q("DELETE FROM reporting.report_chart WHERE id = $1", [id]);
}

async function markArchived(id) {
  await q("UPDATE reporting.report_chart SET archived_at = now(), updated_at = now() WHERE id = $1", [id]);
}

/**
 * Drafts nobody has opened lately.
 *
 * `kind = 'draft'` AND `report_id IS NULL`, though the table's own constraint
 * already makes the second follow from the first. Both are written because
 * this is the query that decides what gets thrown away, and a filter that is
 * merely implied is one schema change from not being true.
 */
async function staleDrafts({ cutoff, limit = 200 }) {
  const { rows } = await q(
    `SELECT ${COLUMNS} FROM reporting.report_chart
      WHERE kind = 'draft' AND report_id IS NULL AND archived_at IS NULL AND last_used_at < $1
      ORDER BY last_used_at ASC
      LIMIT $2`,
    [cutoff, limit],
  );
  return rows.map(row);
}

async function counts() {
  const { rows } = await q(
    `SELECT kind, count(*) FILTER (WHERE archived_at IS NULL) AS live,
            count(*) AS total
       FROM reporting.report_chart GROUP BY kind`,
  );
  const out = { draft: { live: 0, total: 0 }, saved: { live: 0, total: 0 } };
  for (const r of rows) out[r.kind] = { live: Number(r.live), total: Number(r.total) };
  return out;
}

module.exports = {
  UNIQUE_VIOLATION,
  counts,
  findByHash,
  findByReport,
  insert,
  markArchived,
  reassign,
  remove,
  rewrite,
  staleDrafts,
  touch,
};
