// services/reporting/martFreshness.service.js
//
// "DATA AS OF" — AND WHERE IT IS NOT ALLOWED TO COME FROM.
//
// The frontend contract is explicit: `dataAsOf` is the only source of the
// freshness line, the UI never reads a clock to fill it in, and `null` means
// genuinely unknown.
//
// So this reads the LATEST SUCCESSFUL `mart_sync_run` for the company and
// returns that instant, or null. It does not fall back to `now()`, to the
// newest `synced_at` on a row, or to the last time anything was attempted. Each
// of those would produce a plausible timestamp that is not the answer to
// "when was this data last refreshed", and a wrong freshness is worse than an
// absent one: it is the line that tells an accountant the figures are current.
//
// A FAILED run does not move it. That is the whole point of the reconciliation
// gate — a company whose sync failed keeps its previous data, so it keeps its
// previous freshness, and the staleness is visible rather than papered over.

"use strict";

const pg = require("./pgClient");

/**
 * When this company's mart data was last successfully refreshed.
 *
 * @param {string} companyId
 * @returns {Promise<string|null>} an ISO timestamp, or null when unknown
 */
async function dataAsOf(companyId) {
  if (!companyId) return null;
  if (!pg.isConfigured("sync")) return null;

  try {
    const { rows } = await pg.query(
      "sync",
      `SELECT finished_at
         FROM reporting.mart_sync_run
        WHERE company_id = $1 AND status = 'succeeded' AND finished_at IS NOT NULL
        ORDER BY finished_at DESC
        LIMIT 1`,
      [String(companyId)],
    );
    const at = rows[0]?.finished_at;
    return at ? new Date(at).toISOString() : null;
  } catch (err) {
    /* The mart being unreachable does not mean the data is old — it means we
       cannot say. Null is the honest answer and the UI shows no claim. */
    console.error("[reporting/freshness]", err.message);
    return null;
  }
}

module.exports = { dataAsOf };
