// services/reporting/metabaseCharts.service.js
//
// THE CHART BRIDGE: A HIDDEN QUESTION AND A TWO-MINUTE TICKET TO LOOK AT IT.
//
// GRAV keeps the designer and the spreadsheet. Metabase does the drawing. The
// browser is given one thing — a signed token — and with it can render one
// chart and nothing else: no query builder, no collections, no navigation, no
// other question, and no credential of any kind.
//
//   validated layout ──▶ the SAME MBQL the sheet runs ──▶ hidden question
//                                                              │
//                                        short-lived signed token (2 minutes)
//                                                              │
//                                                    /embed/question/<token>
//
// ── THE THREE CREDENTIALS, AND WHY THERE ARE THREE ──────────────────────────
//  1. The QUERY key (`METABASE_REPORTING_API_KEY`) — a query-builder-only
//     group, denied native SQL. It creates, updates, reads and archives the
//     questions. Everything at runtime is done with this one.
//  2. The EMBEDDING SECRET (`METABASE_EMBEDDING_SECRET`) — signs the token.
//     It is NOT the Accounting JWT secret: a token that opens a chart and a
//     token that proves who you are must not be forgeable from one another.
//  3. The ADMIN key (`METABASE_EMBED_ADMIN_API_KEY`) — used for EXACTLY ONE
//     call, `PUT /api/card/:id {enable_embedding:true}`, on a question that
//     has just been created.
//
// The third one is not a choice. Metabase 1.63.1 gates `enable_embedding`
// behind superuser: the query key gets 403, verified against the running
// instance. Two things keep it small: the flag PERSISTS across later updates
// (also verified), so the admin key is touched once per question and never
// again — not for queries, not for reads, not for cleanup; and `assertKeyUse`
// below refuses to let it be used for anything else. An Enterprise token with
// the `embedding` feature would remove the need for it entirely.
//
// ── WHERE THE POINTERS LIVE ─────────────────────────────────────────────────
// In the reporting mart's own Postgres (`reporting.report_chart`), not in
// Mongo. Partly because the shared development cluster is at its 500-collection
// limit and cannot take another one — and mostly because a question id must
// never reach a browser, and the surest way to keep it out of a response is for
// it to live where no route can serialise it by accident. There is no model for
// it, no `presentReport` that could spread it, and one repository
// (`chartRegistry.js`) whose callers are this file.
//
// ── WHAT THE BROWSER CAN AND CANNOT DO WITH THE TOKEN ───────────────────────
// Verified against the running instance, not assumed:
//   · `/embed/question/<token>` renders, with no API key           → 200
//   · `/api/embed/card/<token>/query` returns the rows             → 202
//   · a token for another question                                 → 400
//   · a forged signature                                           → 400
//   · a token more than a minute past its expiry                   → 400
//   · `?company_id=…` on the embed URL                             → 400
//     ("Unknown parameter") — the question declares no parameters, so the
//     tenant filters in its MBQL are not addressable from outside at all
//   · `/api/card/:id` or `/api/dataset` without a key               → 401
//   · native SQL with the query key                                 → 403
//
// One thing it CAN do, and the caller should know: the embedded page fetches
// its own card definition, so a determined person with devtools can read the
// MBQL — field and table ids of the reporting mart — for a chart they are
// already allowed to see. No credential and no other tenant's data is exposed.
// GRAV's own responses carry none of it.

"use strict";

const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const { CODES, ReportingError } = require("./metabaseEngine");
const { compileChartQuery } = require("./mbqlCompiler");
const registry = require("./chartRegistry");

/** Two minutes, and Metabase adds up to a minute of clock-skew leeway. */
const TOKEN_TTL_SECONDS = 120;

/** A draft nobody has opened for this long is rubbish. */
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

const COLLECTION_NAME = "GRAV Embedded Report Charts";

/**
 * @param {object} config
 * @param {string} config.siteUrl
 * @param {string} config.apiKey          query-builder key: everything at runtime
 * @param {string} config.adminApiKey     ONLY ever used to flip enable_embedding
 * @param {string} config.embeddingSecret signs the embed tokens
 * @param {number} [config.parentCollectionId]
 */
function createChartBridge(config = {}) {
  const siteUrl = String(config.siteUrl || "").replace(/\/+$/, "");
  const apiKey = config.apiKey || "";
  const adminApiKey = config.adminApiKey || "";
  const embeddingSecret = config.embeddingSecret || "";
  const parentCollectionId = config.parentCollectionId ?? null;
  const fetchImpl = config.fetchImpl || globalThis.fetch;
  const tokenTtl = config.tokenTtlSeconds || TOKEN_TTL_SECONDS;

  let collectionId = config.collectionId ?? null;

  const configured = () => Boolean(siteUrl && apiKey && embeddingSecret);

  /**
   * One HTTP call to Metabase.
   *
   * `admin: true` is the single exception described at the top of this file,
   * and it is checked here rather than trusted: the admin key may authenticate
   * exactly one path and one method, whatever a future caller asks for.
   */
  async function call(path, { method = "GET", body, admin = false } = {}) {
    if (!configured()) {
      throw new ReportingError(CODES.UNAVAILABLE, "Charts are not configured on this server.", {
        status: 503,
      });
    }
    if (admin) assertKeyUse(path, method);

    let res;
    try {
      res = await fetchImpl(`${siteUrl}${path}`, {
        method,
        headers: {
          "x-api-key": admin ? adminApiKey : apiKey,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new ReportingError(CODES.UNAVAILABLE, "The reporting engine is unreachable.", {
        status: 503, cause: err,
      });
    }

    const text = await res.text();
    if (!res.ok) {
      /* The body is kept for the log and never for the response: a Metabase
         error quotes the query it could not run. */
      throw new ReportingError(
        CODES.UNAVAILABLE,
        "The reporting engine could not prepare this chart.",
        { status: res.status === 403 ? 503 : 502, cause: new Error(`metabase ${res.status}: ${text.slice(0, 300)}`) },
      );
    }
    try {
      return text ? JSON.parse(text) : null;
    } catch (err) {
      throw new ReportingError(CODES.UNAVAILABLE, "The reporting engine returned an unreadable response.", {
        status: 502, cause: err,
      });
    }
  }

  /** The admin credential's whole permitted surface, in one place. */
  function assertKeyUse(path, method) {
    if (!adminApiKey) {
      throw new ReportingError(
        CODES.UNAVAILABLE,
        "Charts need an administrator credential for this reporting engine, which is not configured.",
        { status: 503 },
      );
    }
    if (method !== "PUT" || !/^\/api\/card\/\d+$/.test(path)) {
      // Not a runtime condition — a mistake in this file, caught here rather
      // than discovered as a privileged call in a log.
      throw new ReportingError(CODES.UNAVAILABLE, "Charts are not configured on this server.", {
        status: 500,
        cause: new Error(`admin credential refused for ${method} ${path}`),
      });
    }
  }

  /* ── The private collection ───────────────────────────────────────────── */

  /**
   * Find or create the collection the hidden questions live in.
   *
   * It is created under the reporting service account's own parent collection,
   * which is the only place its key may write. Nothing else files anything
   * there, and a person browsing Metabase sees a collection of machine-made
   * questions rather than questions loose among their own work.
   */
  async function ensureCollection() {
    if (collectionId) return collectionId;

    const existing = await call("/api/collection");
    /* Metabase answers with a bare array today and has answered with
       `{data: [...]}` on other endpoints; neither is worth a crash. */
    const list = Array.isArray(existing) ? existing : (existing?.data || []);
    const found = list.find((c) => c.name === COLLECTION_NAME && !c.archived);
    if (found) {
      collectionId = found.id;
      return collectionId;
    }

    const made = await call("/api/collection", {
      method: "POST",
      body: {
        name: COLLECTION_NAME,
        description:
          "Questions GRAV creates to draw charts inside Accounting. Managed by the server; " +
          "do not edit or move them.",
        ...(parentCollectionId ? { parent_id: parentCollectionId } : {}),
      },
    });
    collectionId = made.id;
    return collectionId;
  }

  /* ── The hidden question ──────────────────────────────────────────────── */

  /**
   * A digest of everything that decides what the chart shows.
   *
   * The COMPILED query rather than the layout: two layouts that compile to the
   * same query are the same question, and a layout change that does not reach
   * the query (a renamed heading) should not strand the old one. The
   * organisation and the companies are in it because a question is scoped by
   * its own filters — a hash collision across tenants would be a leak, so they
   * are part of what is hashed rather than trusted to differ.
   */
  function chartHash({ organizationId, companyIds, query, display, settings }) {
    return crypto
      .createHash("sha256")
      .update(JSON.stringify({
        organizationId: String(organizationId),
        companyIds: [...companyIds].map(String).sort(),
        query,
        display,
        settings,
      }))
      .digest("hex")
      .slice(0, 40);
  }

  /**
   * The question for this layout: reused if we have made it, created if not.
   *
   * ── WHY THE POINTER IS WRITTEN BEFORE THE CARD IS USED ──────────────────
   * The unique index on (organisation, kind, hash) is the lock. Two requests
   * for the same chart race; one inserts, the other's insert fails and it
   * re-reads the winner. Without that, a burst of requests leaves a burst of
   * questions and only one of them is ever remembered.
   */
  async function ensureCard({
    organizationId, userId, companyIds, layout, resolved, visualization, kind = "draft",
    reportId = null, name,
  }) {
    const query = compileChartQuery({ layout, resolved, organizationId, companyIds });
    const hash = chartHash({
      organizationId, companyIds, query,
      display: visualization.type, settings: visualization.settings,
    });

    const existing = await registry.findByHash({ organizationId, kind, layoutHash: hash });

    if (existing && await stillUsable(existing.cardId)) {
      /* A saved report's chart may exist under a hash that no longer matches
         its report — the layout changed. `syncSavedReport` reconciles that;
         here the question already matches, so only its heartbeat moves. */
      await registry.touch(existing.id);
      return { cardId: existing.cardId, hash, created: false };
    }
    if (existing) {
      /* The pointer outlived the question: the cleanup job archived it, or a
         person did. Handing out a ticket to it would render an empty chart
         with nothing on screen to explain why, so the pointer is retired and a
         new question made. Self-healing beats a support ticket. */
      await registry.markArchived(existing.id);
    }

    const collection = await ensureCollection();
    const card = await call("/api/card", {
      method: "POST",
      body: {
        name: name || defaultCardName({ layout, kind }),
        description:
          "Created by GRAV Accounting. The filters in this question are the organisation and " +
          "company scope of the person who asked for it; do not edit them.",
        display: visualization.type,
        dataset_query: query,
        visualization_settings: visualization.settings,
        collection_id: collection,
      },
    });

    // THE ONE ADMIN CALL. Nothing else in this file may use that credential.
    await call(`/api/card/${card.id}`, { method: "PUT", admin: true, body: { enable_embedding: true } });

    try {
      await registry.insert({
        organizationId, kind, reportId, userId,
        layoutHash: hash, cardId: card.id, collectionId: collection,
        display: visualization.type,
      });
    } catch (err) {
      if (err && err.unique) {
        /* Somebody else registered this chart between the look-up and the
           insert. Whose question wins does not matter — that they agree does. */
        const winner = await registry.findByHash({ organizationId, kind, layoutHash: hash });
        if (winner && await stillUsable(winner.cardId)) {
          await archiveCard(card.id).catch(() => {});
          return { cardId: winner.cardId, hash, created: false };
        }
        /* The row that won points at a question that no longer renders — a
           cleanup run, or a failed run before this one. Retire it and keep the
           question we have just made, rather than handing out a dead ticket
           because a stale row got there first. */
        if (winner) {
          await registry.markArchived(winner.id);
          await registry.insert({
            organizationId, kind, reportId, userId,
            layoutHash: hash, cardId: card.id, collectionId: collection,
            display: visualization.type,
          });
          return { cardId: card.id, hash, created: true };
        }
        await archiveCard(card.id).catch(() => {});
      }
      /* The question exists and we could not remember it. Archiving it is the
         only way to avoid an orphan nothing will ever clean up. */
      await archiveCard(card.id).catch(() => {});
      throw err;
    }

    return { cardId: card.id, hash, created: true };
  }

  /**
   * A saved report's chart, kept in step with the report.
   *
   * Idempotent: the same report and the same layout produce the same hash and
   * the same question. When the layout HAS changed, the existing question is
   * rewritten rather than replaced, because rewriting keeps `enable_embedding`
   * (and therefore costs no admin call) and keeps any link someone has open
   * pointing at the right figures.
   */
  async function syncSavedReport({
    organizationId, userId, reportId, companyIds, layout, resolved, visualization, name,
  }) {
    const query = compileChartQuery({ layout, resolved, organizationId, companyIds });
    const hash = chartHash({
      organizationId, companyIds, query,
      display: visualization.type, settings: visualization.settings,
    });

    const existing = await registry.findByReport({ organizationId, reportId });

    if (existing) {
      if (existing.layoutHash === hash) {
        await registry.touch(existing.id);
        return { cardId: existing.cardId, hash, created: false, updated: false };
      }
      await call(`/api/card/${existing.cardId}`, {
        method: "PUT",
        body: {
          name: name || defaultCardName({ layout, kind: "saved" }),
          display: visualization.type,
          dataset_query: query,
          visualization_settings: visualization.settings,
        },
      });
      await registry.rewrite(existing.id, { layoutHash: hash, display: visualization.type });
      return { cardId: existing.cardId, hash, created: false, updated: true };
    }

    const made = await ensureCard({
      organizationId, userId, companyIds, layout, resolved, visualization,
      kind: "saved", reportId, name,
    });
    if (existing) {
      await registry.reassign(existing.id, {
        cardId: made.cardId, layoutHash: made.hash, display: visualization.type,
      });
    }
    return { ...made, updated: false };
  }

  /** The chart of a report that has just been deleted. */
  async function forgetSavedReport({ organizationId, reportId }) {
    const row = await registry.findByReport({ organizationId, reportId });
    if (!row) return { archived: false };
    /* The pointer goes first. If Metabase is unreachable the GRAV report is
       still deleted and the question is left for the cleanup job — a question
       nobody points at is rubbish; a report pointing at a question that is not
       there is a broken screen. */
    await registry.remove(row.id);
    try {
      await archiveCard(row.cardId);
      return { archived: true, cardId: row.cardId };
    } catch (err) {
      return { archived: false, cardId: row.cardId, error: err.message };
    }
  }

  /**
   * Is the question we remember still a question a token can open?
   *
   * One small GET. It exists because the pointer and the question live in
   * different systems and only one of them is ours: a cleanup run, a tidy-up
   * by a person, or a restored backup can archive a card without telling us,
   * and a token for an archived card renders nothing at all.
   */
  async function stillUsable(cardId) {
    try {
      const card = await call(`/api/card/${cardId}`);
      return Boolean(card && !card.archived && card.enable_embedding);
    } catch {
      return false;
    }
  }

  async function archiveCard(cardId) {
    await call(`/api/card/${cardId}`, { method: "PUT", body: { archived: true } });
  }

  /* ── The ticket ───────────────────────────────────────────────────────── */

  /**
   * A token that opens ONE question, for two minutes.
   *
   * `resource.question` is the whole of its authority: Metabase checks the
   * signature, checks that question has embedding enabled, and runs the query
   * the question holds. There is no field in it a caller could use to name
   * another question, another company or another filter — the tenant clauses
   * are inside the question's own MBQL, where a token cannot reach them.
   *
   * `params: {}` is deliberate and load-bearing: a question with no declared
   * parameters refuses every parameter, which is why `?company_id=…` on the
   * embed URL answers "Unknown parameter" rather than filtering anything.
   */
  function signEmbedToken(cardId) {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign(
      { resource: { question: Number(cardId) }, params: {}, iat: now, exp: now + tokenTtl },
      embeddingSecret,
      { algorithm: "HS256" },
    );
  }

  /* ── Cleanup ──────────────────────────────────────────────────────────── */

  /**
   * Archive draft questions nobody has looked at lately.
   *
   * `kind: "draft"` is in the filter and not merely implied by the absence of
   * a `reportId`: a saved report's question must never be caught by a cleanup
   * job, and "it has no reportId" is one bad write away from being wrong about
   * that. Archived rather than deleted, so a question that turns out to have
   * mattered is recoverable from Metabase's own trash.
   */
  async function cleanupDrafts({ olderThanMs = DRAFT_TTL_MS, apply = false, limit = 200 } = {}) {
    const cutoff = new Date(Date.now() - olderThanMs);
    const stale = await registry.staleDrafts({ cutoff, limit });

    const out = { considered: stale.length, archived: 0, failed: [], apply };
    if (!apply) return out;

    for (const row of stale) {
      try {
        await archiveCard(row.cardId);
        await registry.markArchived(row.id);
        out.archived += 1;
      } catch (err) {
        out.failed.push({ cardId: row.cardId, error: err.message });
      }
    }
    return out;
  }

  return {
    COLLECTION_NAME,
    DRAFT_TTL_MS,
    TOKEN_TTL_SECONDS: tokenTtl,
    isConfigured: configured,
    archiveCard,
    chartHash,
    cleanupDrafts,
    ensureCard,
    ensureCollection,
    forgetSavedReport,
    signEmbedToken,
    syncSavedReport,
  };
}

/** What a hidden question is called in Metabase's own list. */
function defaultCardName({ layout, kind }) {
  const what = layout.name && layout.name !== "Untitled report" ? layout.name : "Untitled report";
  return `GRAV ${kind === "saved" ? "report" : "draft"} — ${what}`.slice(0, 100);
}

module.exports = {
  COLLECTION_NAME,
  DRAFT_TTL_MS,
  TOKEN_TTL_SECONDS,
  createChartBridge,
  defaultCardName,
};
