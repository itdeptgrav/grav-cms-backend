// services/marketing/contentInventory.service.js
//
// A READ-ONLY CATALOGUE OF WHAT EXISTS IN MAUTIC.
//
// ── WHO OWNS WHAT, STATED ONCE ─────────────────────────────────────────────
// Mautic owns content: storage, editing, publishing and sending. GRAV owns a
// read-only inventory of it, and later the intelligence built on top. Marketing
// owns branded one-to-many material; Sales owns personal replies, requirements,
// pricing and negotiation. Nothing in this file writes to Mautic, and nothing in
// it can — the client methods it calls are GET-only by construction and the
// endpoint table they use is closed.
//
// ── AND WHAT A PUBLISHED FLAG DOES NOT MEAN ────────────────────────────────
// `published: true` means Mautic reported the asset as published. It does not
// mean the asset was sent, delivered, opened or seen by anybody. Those are
// different questions with different evidence, and this slice has none of it —
// which is why no count of any kind appears in a row.
//
// ── UNKNOWN IS NULL, NEVER A DEFAULT ───────────────────────────────────────
// The provider read uses `minimal=true`, which is the security boundary (see the
// client) and which genuinely does not return publish windows. So they are
// `null`. A `null` here means GRAV does not know; it never means zero, never
// means false, and never means unpublished. The difference matters because a
// screen that renders an unknown publish window as "not scheduled" is a screen
// that gets a campaign wrong.
"use strict";

const { MauticClient } = require("./mauticClient");
const { fail } = require("../storePurchase/errors");
const providerPrivacy = require("./providerPrivacy");
const {
  CONTENT_KIND_CODES, CONTENT_KINDS, CONTENT_PUBLICATION_STATES,
} = require("../../constants/marketing");

const str = (v) => String(v ?? "").trim();

const MAX_PAGE = 50;
const DEFAULT_PAGE = 25;

/* ── THE COMPANY GATE ───────────────────────────────────────────────────────
   One Mautic instance serves one GRAV organisation (ADR-004), and which one is
   DEPLOYMENT CONFIGURATION. A second company on the same GRAV installation has
   no claim on that instance's content, so it is refused rather than shown a
   filtered view of somebody else's estate — there is nothing to filter by,
   because Mautic holds no GRAV company on its assets.

   The company always arrives from the authenticated actor's membership. Nothing
   here reads a company from a query string or a body. */
function configuredCompanyId(env = process.env) {
  return str(env.MARKETING_COMPANY_ID);
}

function assertCompanyMayRead({ companyId, env = process.env }) {
  if (!companyId) {
    throw fail("TENANT_MEMBERSHIP_UNPROVEN",
      "Marketing content cannot be read without a company.");
  }
  const configured = configuredCompanyId(env);
  if (!configured) {
    throw fail("MARKETING_COMPANY_NOT_CONFIGURED",
      "Marketing is not configured for this company, so there is no content library to show.");
  }
  if (String(companyId) !== configured) {
    throw fail("MARKETING_COMPANY_NOT_CONFIGURED",
      "This company has no marketing content library.");
  }
  return String(companyId);
}

/* ═══ THE SAFE ROW ═════════════════════════════════════════════════════════

   One shape for all three kinds, built by NAMING each field. Never by copying
   the provider row and deleting what must not travel: a field Mautic adds in
   7.3 would then arrive on this payload because nobody thought to exclude it,
   and the fields at risk here are an email's recipient segments and its HTML
   body. */

/** A provider timestamp, or null. Never coerced to an epoch. */
function when(v) {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/**
 * The published flag, and only when it is genuinely measurable.
 *
 * Mautic sends `isPublished` as a boolean. Anything else — absent, null, a
 * string — is reported as unknown rather than guessed, because the wrong guess
 * here ("unpublished") is the one a reader would act on.
 */
function publication(raw) {
  if (raw === true) return { published: true, state: "published" };
  if (raw === false) return { published: false, state: "unpublished" };
  return { published: null, state: "unknown" };
}

/** A category label, when Mautic sent one. Its id is of no use to a reader. */
function categoryLabel(category) {
  if (!category || typeof category !== "object") return null;
  const label = str(category.title) || str(category.name) || str(category.alias);
  return label || null;
}

/**
 * One Mautic asset, as GRAV reports it.
 *
 * @param {string} kind  email | form | landing_page
 * @param {object} row   a `minimal=true` provider row
 */
function safeRow(kind, row) {
  /* ── AN OPAQUE GRAV IDENTIFIER ─────────────────────────────────────────
     The engine's own id, carried as a STRING and published under a GRAV name.
     A client uses it to ask GRAV about this item again; it is not labelled as a
     provider id, and no client should parse it. Keeping it as the engine's
     value is a server-side mapping detail, not a contract — a future engine can
     mint different ones without any caller noticing. */
  const contentId = row?.id === 0 || row?.id ? String(row.id) : null;
  if (!contentId) {
    throw fail("MAUTIC_MALFORMED_RESPONSE",
      `The marketing engine returned a ${kind} with no identifier, so GRAV cannot list it.`, { kind });
  }

  const pub = publication(row.isPublished);

  return {
    kind,
    /* Stable for this company's content library, and the key a GRAV route uses
       to ask about this item again. */
    contentId,
    /* The engine stores a name for two of these kinds and a title for the
       third. One field here, because a reader does not care. */
    name: str(row.name) || str(row.title) || null,
    /* Forms and landing pages carry an alias; marketing emails do not, and
       `null` says so rather than an empty string pretending to be a value. */
    alias: str(row.alias) || null,

    published: pub.published,
    publicationState: pub.state,

    /* ── ABSENT IN minimal MODE, AND REPORTED AS UNKNOWN ──────────────────
       Not a gap in the contract: the read deliberately does not ask for the
       full record, because the full record carries an email's HTML and its
       recipient segments. */
    publishUp: when(row.publishUp),
    publishDown: when(row.publishDown),

    createdAt: when(row.dateAdded),
    modifiedAt: when(row.dateModified),

    language: str(row.language) || null,
    category: categoryLabel(row.category),

    /* ── KIND-SPECIFIC, AND ONLY WHAT WAS VERIFIED ────────────────────────
       An email's subject is the one extra field `minimal=true` genuinely
       returns, and it is the field a marketer recognises an email by. Forms and
       pages have no verified extra in minimal mode, so they carry an empty
       object rather than invented keys. */
    details: kind === "email" && str(row.subject) ? { subject: str(row.subject) } : {},
  };
}

/* ═══ PAGINATION ═══════════════════════════════════════════════════════════

   Mautic pages by offset; GRAV's contract is a cursor. The cursor therefore
   carries the offset AND the kind, so a cursor from one list cannot be replayed
   against another and silently page through the wrong collection.

   Opaque to a client on purpose: an offset a caller can edit is an offset a
   caller will edit. */
function encodeCursor(kind, start) {
  return Buffer.from(`${kind}:${start}`, "utf8").toString("base64url");
}

function decodeCursor(raw, kind) {
  const value = str(raw);
  if (!value) return 0;

  let decoded = "";
  try {
    decoded = Buffer.from(value, "base64url").toString("utf8");
  } catch {
    throw fail("VALIDATION", "That is not a valid page cursor.", { field: "cursor" });
  }
  const match = /^([a-z_]+):(\d+)$/.exec(decoded);
  if (!match) {
    throw fail("VALIDATION", "That is not a valid page cursor.", { field: "cursor" });
  }
  if (match[1] !== kind) {
    throw fail("VALIDATION",
      `That page cursor belongs to the ${match[1]} list, not the ${kind} list.`,
      { field: "cursor" });
  }
  const start = Number(match[2]);
  if (!Number.isSafeInteger(start) || start < 0) {
    throw fail("VALIDATION", "That is not a valid page cursor.", { field: "cursor" });
  }
  return start;
}

/**
 * A supplied page size, or a refusal.
 *
 * ── WHY AN INVALID LIMIT IS REFUSED RATHER THAN CLAMPED ────────────────────
 * A caller that asked for 500 and silently received 100 is a caller paging by
 * an offset it believes it chose, and it will skip four hundred rows without
 * ever seeing an error. Zero is the same mistake in the other direction. An
 * omitted limit takes the documented default; a supplied one is in range or it
 * is refused, and the refusal names the range.
 *
 * Query strings arrive as strings, so a string of digits is accepted and
 * anything else is not — `"25"` is a caller obeying HTTP, `"twenty"` is not.
 */
function assertLimit(limit) {
  if (limit === undefined || limit === null || limit === "") return DEFAULT_PAGE;

  let numeric;
  if (typeof limit === "number") {
    numeric = limit;
  } else if (typeof limit === "string" && /^\d+$/.test(limit.trim())) {
    numeric = Number(limit.trim());
  } else {
    const received = Array.isArray(limit) ? "an array" : `a ${typeof limit}`;
    throw fail("VALIDATION",
      `limit must be a whole number between 1 and ${MAX_PAGE}.`,
      { field: "limit", min: 1, max: MAX_PAGE, received });
  }

  if (!Number.isInteger(numeric) || numeric < 1 || numeric > MAX_PAGE) {
    throw fail("VALIDATION",
      `limit must be a whole number between 1 and ${MAX_PAGE}.`,
      { field: "limit", min: 1, max: MAX_PAGE, received: numeric });
  }
  return numeric;
}

/**
 * The client that reads the catalogue.
 *
 * Refuses to fall back to the operational credential. That identity writes
 * contacts and segment membership, and borrowing it to read content would put
 * the write credential on a code path that only needs to read — which is the
 * arrangement the separate lanes exist to end.
 */
function contentClient(env) {
  const client = new MauticClient({ env, lane: "content" });
  if (!client.config.contentCredentialConfigured) {
    throw fail("MAUTIC_NOT_CONFIGURED",
      "The marketing engine is not fully configured for reading the content library. It needs a technical operator.");
  }
  return client;
}

function assertKind(kind) {
  const wanted = str(kind);
  if (!wanted) {
    throw fail("VALIDATION",
      "Say which kind of content to list. GRAV does not merge marketing emails, forms and landing pages into one list — they are three separately paged libraries and a combined page would have no stable order.",
      { field: "kind", accepted: CONTENT_KIND_CODES });
  }
  if (!CONTENT_KIND_CODES.includes(wanted)) {
    throw fail("VALIDATION", `"${wanted}" is not a kind of marketing content GRAV reads.`, {
      field: "kind", accepted: CONTENT_KIND_CODES,
    });
  }
  return wanted;
}

/* ═══ THE LIST ═════════════════════════════════════════════════════════════ */

/**
 * One page of one content kind.
 *
 * @returns {Promise<object>} rows, the requested kind, the page size, a cursor,
 *   whether more exist, the provider total when trustworthy, and when it was
 *   measured.
 */
async function list({
  companyId, kind, cursor = null, limit = DEFAULT_PAGE,
  client = null, env = process.env, now = new Date(),
} = {}) {
  assertCompanyMayRead({ companyId, env });
  const wantedKind = assertKind(kind);
  const start = decodeCursor(cursor, wantedKind);
  const pageSize = assertLimit(limit);

  const mautic = client || contentClient(env);

  /* One more than asked for, so `hasMore` is observed rather than inferred from
     a full-looking page. Mautic has no "has next" flag and its total is not
     filter-aware, so this is the only honest way to answer it. */
  const page = await mautic.listContent(wantedKind, { start, limit: pageSize + 1 });
  const hasMore = page.rows.length > pageSize;
  const rows = (hasMore ? page.rows.slice(0, pageSize) : page.rows).map((r) => safeRow(wantedKind, r));

  return {
    kind: wantedKind,
    rows,
    page: { size: rows.length, maxSize: MAX_PAGE, requested: pageSize },
    nextCursor: hasMore ? encodeCursor(wantedKind, start + pageSize) : null,
    hasMore,
    /* ── THE PROVIDER'S TOTAL, AND WHY IT IS TRUSTWORTHY HERE ─────────────
       Mautic's `total` counts the whole collection and is NOT filter-aware —
       `search=x` returns the unfiltered total beside a filtered page. This read
       sends no filter, so the count and the collection are the same thing. It is
       reported as `providerTotal`, never as a count of this page. */
    /* The engine's own count of the library, or null. Named for what it
       measures rather than for who supplied it. */
    libraryTotal: page.total,
    libraryTotalAvailable: page.total !== null,
    measuredAt: now.toISOString(),
  };
}

/* ═══ THE SUMMARY ══════════════════════════════════════════════════════════ */

/**
 * How much of each kind exists.
 *
 * ── EACH KIND IS READ INDEPENDENTLY, AND A FAILURE STAYS A FAILURE ────────
 * Three separate provider calls, and one of them failing must not turn that kind
 * into zero. A zero is the most dangerous possible answer here: it looks like
 * information, it looks like good news, and it is indistinguishable from "we
 * have no landing pages" — which somebody might then act on by building some.
 *
 * So each kind reports its own state, a failed kind carries `count: null` with a
 * safe reason, and the whole result is marked `partial` when any kind failed.
 */
async function summary({ companyId, client = null, env = process.env, now = new Date() } = {}) {
  assertCompanyMayRead({ companyId, env });
  const mautic = client || contentClient(env);

  const kinds = {};
  for (const kind of CONTENT_KIND_CODES) {
    try {
      /* `limit: 1` — the count comes from the provider's total, and fetching a
         page of rows to count them would be both slower and wrong, since a page
         length is not a total. */
      const page = await mautic.listContent(kind, { start: 0, limit: 1 });
      kinds[kind] = page.total === null
        ? {
          state: "unreadable",
          count: null,
          reason: "The marketing engine did not report a usable count for this content type.",
        }
        : { state: "ok", count: page.total, reason: "" };
    } catch (err) {
      /* ── REPORTED INSIDE A 200, SO IT SANITISES ITSELF ──────────────────
         The route-level privacy boundary translates REFUSALS. This is a failure
         carried inside a successful response, so it never passes through that
         door and has to go through the same translation here — otherwise the
         engine's name and its error vocabulary ride out on a 200. */
      const safe = providerPrivacy.publicFailure({
        reasonCode: str(err?.code) || "UNKNOWN",
        reason: str(err?.message).slice(0, 300),
      });
      providerPrivacy.logProviderFailure(err, { operation: "content summary", kind });
      kinds[kind] = {
        state: "failed",
        /* NULL. Not zero. */
        count: null,
        reasonCode: safe.reasonCode,
        reason: safe.reason,
      };
    }
  }

  const failed = CONTENT_KIND_CODES.filter((k) => kinds[k].state !== "ok");

  return {
    kinds,
    /* True when any kind could not be read. A client must not add these counts
       up and present the result as an estate size. */
    partial: failed.length > 0,
    unreadableKinds: failed,
    /* Present only when every kind was readable — a total that silently omitted
       a failed kind would understate the estate. */
    totalAcrossKinds: failed.length
      ? null
      : CONTENT_KIND_CODES.reduce((sum, k) => sum + kinds[k].count, 0),
    measuredAt: now.toISOString(),
  };
}

/** The vocabularies, served with the data so a client never hard-codes them. */
const vocabulary = Object.freeze({
  kinds: CONTENT_KINDS,
  publicationStates: CONTENT_PUBLICATION_STATES,
  ownership: Object.freeze({
    /* GRAV-owned words. A client must never learn which product runs the
       engine, because a client that learns it will special-case it. */
    contentStorage: "marketing_engine",
    contentEditing: "marketing_engine",
    publishing: "marketing_engine",
    sending: "marketing_engine",
    inventory: "grav_marketing",
    brandedOneToMany: "grav_marketing",
    personalConversation: "grav_sales",
    /* Said in the payload, not only in a comment: a client rendering a
       published badge needs to know what it may not claim. */
    publishedMeans: "The marketing engine reports this item as published. That does not prove it was sent, delivered or seen.",
  }),
});

module.exports = {
  list,
  summary,
  safeRow,
  publication,
  encodeCursor,
  decodeCursor,
  assertKind,
  assertLimit,
  assertCompanyMayRead,
  vocabulary,
  MAX_PAGE,
  DEFAULT_PAGE,
};
