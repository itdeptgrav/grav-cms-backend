// services/merchandising/fileDemandRelease.service.js
//
// THE EXECUTION FILE'S OWN DOOR ONTO PROCUREMENT DEMAND RELEASE.
//
// ── THE PROBLEM THIS SOLVES, AND NOTHING ELSE ───────────────────────────────
// `orderDemandRelease` is the authority, and it asks for three identities: the
// CustomerRequest, the order line's permanent reference, and the exact
// approved costing version the quotation was priced from. Those are correct
// things to demand — a release that guessed any of them would commit money
// against a record nobody chose.
//
// But the Merchandising Execution File screen holds none of them. It has a
// file id, a handover reference, a handover line reference and a Sales version.
// The only ways a browser could produce the other three would be to guess, to
// search, or to have somebody type an internal identity in — and each of those
// is a way to release demand against the wrong order.
//
// So the resolution happens HERE, on the server, from records the file already
// points at:
//
//   ExecutionFile.currentHandoverVersionId
//     → SalesHandoverVersion.sourceRecord.recordId   the CustomerRequest
//   ExecutionFile.handoverLineRef                    the order line
//     → that line's sampleStyleId
//     → the quotation line joined on it
//     → its frozen costingSource.costingVersionId
//
// ── WHAT THIS FILE IS NOT ───────────────────────────────────────────────────
// It holds NO business rule. Eligibility, provenance verification, ownership of
// the order, active-release recovery, idempotency, concurrency and the release
// itself all stay in `orderDemandRelease.service.js`. Duplicating any of them
// here would create a second answer to a question that must have one — and the
// second answer is the one that would drift.
//
// It also chooses nothing. Not "the latest version", not "a nearby line", not
// "a similar scenario". Every identity is the one the records state, or the
// answer is a typed blocker saying which link is missing.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const { fail } = require("../storePurchase/errors");
const execution = require("./execution.service");
const orderDemandRelease = require("./orderDemandRelease.service");
const handover = require("../sales/merchandisingHandover.service");

const str = (v) => String(v ?? "").trim();
const model = (name, path) => (mongoose.models[name] || require(path));
const SalesHandoverVersion = () => model(
  "SalesHandoverVersion", "../../models/CMS_Models/Sales/SalesHandoverVersion",
);

const CODES = Object.freeze({
  NOT_FOUND: "NOT_FOUND",
  NOT_RESOLVABLE: "DEMAND_RELEASE_FILE_NOT_RESOLVABLE",
  VERSION_REQUIRED: "DEMAND_RELEASE_EXPECTED_VERSION_REQUIRED",
  VERSION_CHANGED: "DEMAND_RELEASE_VERSION_CHANGED",
});

/**
 * Why a file cannot be turned into a release command.
 *
 * Each names the exact link that is missing, because "this file cannot release"
 * is not something a merchandiser can act on and "the order line this file was
 * opened for is no longer on the order" is.
 */
const UNRESOLVED = Object.freeze({
  HANDOVER_SOURCE_MISSING: "HANDOVER_SOURCE_MISSING",
  ORDER_NOT_READABLE: "ORDER_NOT_READABLE",
  ORDER_LINE_NOT_FOUND: "ORDER_LINE_NOT_FOUND",
  LINE_HAS_NO_STYLE: "LINE_HAS_NO_STYLE",
  NO_APPROVED_COSTING_SOURCE: "NO_APPROVED_COSTING_SOURCE",
});

const unresolved = (reason, message) => ({ ok: false, blocked: { reason, message } });

/**
 * THE OPAQUE HANDLE THE COMMAND MUST ECHO.
 *
 * ── WHY NOT JUST SEND THE VERSION ID ────────────────────────────────────────
 * Because the whole point of this contract is that the browser never handles
 * an internal identity. A hash over the five facts proves the caller read the
 * same resolution the server is about to act on, without telling them what any
 * of it is — and it cannot be reversed into a costing version, an order or a
 * company.
 *
 * It covers the COMPANY as well as the file, so a token minted in one tenant
 * cannot be replayed in another even if the same file id somehow appeared.
 */
const versionTokenFor = ({ companyId, fileId, orderId, lineRef, costingVersionId }) => crypto
  .createHash("sha256")
  .update(JSON.stringify([
    String(companyId), String(fileId), String(orderId), str(lineRef), String(costingVersionId),
  ]))
  .digest("hex")
  .slice(0, 32);

/**
 * THE STABLE HALF: which order, and which line.
 *
 * Ownership first, by the file loader, so a foreign file answers NOT_FOUND
 * before any of this runs and never reaches a blocker that would confirm the
 * file exists.
 *
 * ── AND NOTHING COMMERCIAL IS READ HERE ─────────────────────────────────────
 * No quotation, no costing version, no provenance. These two identities are
 * the ones that do not move: the order the file was opened from, and the
 * line's permanent reference. They are enough to ask the authority whether a
 * command has already been started on this line — which has to be answerable
 * even when today's provenance no longer verifies.
 */
async function resolveIdentityFor(ctx, fileId) {
  /* Throws NOT_FOUND for malformed, missing and foreign alike. */
  const file = await execution.loadOwnedFile(ctx, fileId);

  /* `handoverRef` and `orderRef` are Sales' DISPLAY reference for the order —
     a human string, not an identity. The version's `sourceRecord.recordId` is
     the CustomerRequest itself, and it is scoped to this company. */
  const version = await SalesHandoverVersion().findOne({
    _id: file.currentHandoverVersionId, companyId: ctx.companyId,
  }).lean();
  if (!version?.sourceRecord?.recordId) {
    return unresolved(
      UNRESOLVED.HANDOVER_SOURCE_MISSING,
      "The Sales version this file was opened from cannot be read, so the order behind it is unknown.",
    );
  }
  const orderId = String(version.sourceRecord.recordId);

  /* `loadOwnedRequest` is the same proof the release authority uses. Asking it
     here as well is not a duplicated rule — it is the same function — and it
     keeps the resolution honest if the file and the order ever disagree. */
  let order;
  try {
    ({ request: order } = await handover.loadOwnedRequest({ companyId: ctx.companyId }, orderId));
  } catch (err) {
    if (!err?.code) throw err;
    return unresolved(
      UNRESOLVED.ORDER_NOT_READABLE,
      "The order this file was opened from can no longer be read.",
    );
  }

  /* `handoverLineRef` is immutable on the file and was stamped from the
     CustomerRequest item's own `lineRef`. Nothing here looks for a "nearby"
     line: if that reference is not on the order any more, that is the answer. */
  const lineRef = str(file.handoverLineRef);
  const line = (order.items || []).find((i) => str(i.lineRef) === lineRef) || null;
  if (!line) {
    return unresolved(
      UNRESOLVED.ORDER_LINE_NOT_FOUND,
      "The order line this file was opened for is no longer on the order.",
    );
  }

  return { ok: true, fileId: String(file._id), order, line, orderId, lineRef };
}

/**
 * THE MOVING HALF: which approved costing the line is priced from TODAY.
 *
 * Only ever asked for a NEW attempt. An exact retry of a command that has
 * already been claimed does not come through here at all — its version was
 * frozen when the claim was written, and re-deriving it is precisely how a
 * started command gets stranded.
 */
function resolveQuotationFor(identity) {
  const styleId = str(identity.line.sampleStyleId);
  if (!styleId) {
    return unresolved(
      UNRESOLVED.LINE_HAS_NO_STYLE,
      "This order line has no selected style, so no approved price can be joined to it.",
    );
  }

  /* `pricedLineFor` is the release authority's own joiner: quotation line by
     style, and only where the provenance says APPROVED_COSTING. Reusing it
     means there is one join, not a second one that could pick differently. */
  const { line: priced } = orderDemandRelease.pricedLineFor(identity.order, styleId);
  const costingVersionId = str(priced?.costingSource?.costingVersionId);
  if (!costingVersionId) {
    return unresolved(
      UNRESOLVED.NO_APPROVED_COSTING_SOURCE,
      "This line was not priced from an approved costing, so there is no approved requirement to release.",
    );
  }
  return { ok: true, costingVersionId };
}

/** Identity, plus the version today's quotation names. The new-attempt path. */
async function resolveCommandFor(ctx, fileId) {
  const identity = await resolveIdentityFor(ctx, fileId);
  if (!identity.ok) return identity;

  const priced = resolveQuotationFor(identity);
  if (!priced.ok) return priced;

  return commandOf(ctx, identity, priced.costingVersionId);
}

/** One resolved command, with the handle that names it. */
const commandOf = (ctx, identity, costingVersionId) => ({
  ok: true,
  fileId: identity.fileId,
  orderId: identity.orderId,
  lineRef: identity.lineRef,
  costingVersionId,
  expectedVersion: versionTokenFor({
    companyId: ctx.companyId,
    fileId: identity.fileId,
    orderId: identity.orderId,
    lineRef: identity.lineRef,
    costingVersionId,
  }),
});

/**
 * The narrow presentation contract.
 *
 * ── AN ALLOWLIST, NOT A SPREAD ──────────────────────────────────────────────
 * Every field is named. A future field added upstream — a cost, a markup, a
 * supplier — cannot arrive here by being carried along, which is exactly how
 * confidential values escape into screens that were never meant to show them.
 */
function present(state, resolved, { ctx = null, recoverable = null } = {}) {
  const s = state.subject;
  return {
    eligible: Boolean(state.eligible),
    blocked: state.blocked
      ? {
        code: str(state.blocked.code),
        reason: state.blocked.reason || null,
        message: str(state.blocked.message),
      }
      : null,
    /* Identities and quantities. No money of any kind. */
    subject: s
      ? {
        orderRef: str(s.orderNumber),
        lineRef: str(s.lineRef),
        styleRef: str(s.styleCode),
        productName: str(s.productName),
        orderedQuantity: s.orderedQuantity,
        requirementRevision: str(s.requirementRevision),
        costingVersionNumber: s.costingVersionNumber ?? null,
      }
      : null,
    current: (state.releases || []).find((r) => r.state === "RELEASED") || null,
    releases: (state.releases || []).map((r) => ({
      releaseId: str(r.releaseId),
      state: str(r.state),
      orderedQuantity: r.orderedQuantity,
      costingVersionNumber: r.costingVersionNumber ?? null,
      requirementRevision: str(r.requirementRevision),
      releasedAt: r.releasedAt || null,
      releasedByName: str(r.releasedByName),
      demandRequestCount: r.demand?.requirementCount || 0,
      supersedesReleaseId: r.supersedesReleaseId || null,
      supersededByReleaseId: r.supersededByReleaseId || null,
    })),
    /* ── A STARTED COMMAND IS STILL OFFERABLE ─────────────────────────
       `stateFor` says a line may be released when today's sources verify and
       nothing is current. Neither is true of a line whose claim is PENDING
       and whose quotation has since moved — and yet finishing that claim is
       exactly what has to happen next, and only somebody holding the grant
       may do it. So the recovery is offered on its own terms. */
    recoverable: recoverable
      ? { releaseId: recoverable.releaseId, state: recoverable.state }
      : null,
    permitted: {
      release: Boolean(state.permitted?.release)
        || Boolean(recoverable && ctx && orderDemandRelease.holdsRelease(ctx)),
    },
    /* The handle the command echoes. Opaque, and the only identity the browser
       ever holds beyond the file id it already had. */
    expectedVersion: resolved.expectedVersion,
  };
}

/**
 * What the screen may show, and whether this person may act.
 *
 * ── THE DURABLE CLAIM IS CONSULTED BEFORE THE QUOTATION ─────────────────────
 * If a command has already been started on this line, the handle this read
 * hands back is the one that names THAT command — not the one today's
 * quotation would produce. Otherwise a reprice between the claim and the retry
 * would leave the screen showing a handle that cannot finish the work, with no
 * way for anybody to offer the retry that would.
 */
async function stateForFile(ctx, { fileId } = {}) {
  const identity = await resolveIdentityFor(ctx, fileId);
  if (!identity.ok) return blockedContract(identity);

  const active = await orderDemandRelease.activeReleaseFor(ctx, {
    orderId: identity.orderId, lineRef: identity.lineRef,
  });

  /* ── PENDING IS DOMINANT; RELEASED IS NOT ──────────────────────────────
     A started command names its own version, and nothing may take the line
     while it is unfinished — so a PENDING claim decides the handle outright
     and today's quotation is not read at all.

     A RELEASED one is different. It is history, not a claim in progress. If
     the price has since moved to another approved version there is a
     legitimate successor to offer, and publishing the released version's
     handle for ever would mean the screen could never ask for it — the button
     would answer "already released" and the successor flow the authority
     already implements would be unreachable.

     So RELEASED yields to today's quotation, and stays in the history and the
     current-demand presentation regardless. */
  let resolved;
  if (active?.state === "PENDING") {
    resolved = commandOf(ctx, identity, active.costingVersionId);
  } else {
    const priced = resolveQuotationFor(identity);
    if (priced.ok) {
      resolved = commandOf(ctx, identity, priced.costingVersionId);
    } else if (active) {
      /* The quotation can no longer be joined, but something WAS released
         here. Report that rather than blanking a line with real demand
         against it. */
      resolved = commandOf(ctx, identity, active.costingVersionId);
    } else {
      return blockedContract(priced);
    }
  }

  const state = await orderDemandRelease.stateFor(ctx, {
    orderId: resolved.orderId,
    lineRef: resolved.lineRef,
    costingVersionId: resolved.costingVersionId,
  });
  return present(state, resolved, {
    ctx,
    recoverable: active && active.state === "PENDING" ? active : null,
  });
}

/** The shape a file that cannot be turned into a command answers with. */
const blockedContract = (unresolvedResult) => ({
  eligible: false,
  blocked: { code: CODES.NOT_RESOLVABLE, ...unresolvedResult.blocked },
  subject: null,
  current: null,
  releases: [],
  recoverable: null,
  permitted: { release: false },
  expectedVersion: null,
});

/**
 * RELEASE, FROM THE FILE.
 *
 * ── THE DURABLE COMMAND OUTRANKS TODAY'S QUOTATION ──────────────────────────
 * The authority finds a committed claim before it reads any live source,
 * because once a command has started, requests may exist under its idempotency
 * key and only that claim can finish them. This wrapper used to defeat that: it
 * joined today's quotation first, and a line repriced after the claim produced
 * a different handle, so the exact retry was refused as stale and the started
 * command was never reached at all.
 *
 * So the durable claim is consulted first here too. When the echoed handle
 * names it, the frozen version goes straight to the authority and today's
 * provenance is never read.
 *
 * ── AND THE STALE CHECK STILL EXISTS, WHERE IT BELONGS ──────────────────────
 * For a NEW attempt — no claim in force, or a handle that names something else
 * — today's quotation is resolved and the handle must match it. A handle that
 * names neither the claim nor the current price is a reader acting on a screen
 * the world has moved past.
 *
 * Nothing here decides whether a different version may take over a line that
 * already has a claim. That is the authority's rule, and it refuses.
 */
async function releaseFromFile(ctx, { fileId, expectedVersion, actor = {} } = {}) {
  const echoed = str(expectedVersion);
  if (!echoed) {
    throw fail(
      CODES.VERSION_REQUIRED,
      "Send the version identity you read, so a repriced line is a conflict rather than a silent substitution.",
      { field: "expectedVersion" },
    );
  }

  /* Ownership first, and only the identities that do not move. */
  const identity = await resolveIdentityFor(ctx, fileId);
  if (!identity.ok) {
    throw fail(CODES.NOT_RESOLVABLE, identity.blocked.message, { reason: identity.blocked.reason });
  }

  const active = await orderDemandRelease.activeReleaseFor(ctx, {
    orderId: identity.orderId, lineRef: identity.lineRef,
  });

  /* ── AN EXACT RETRY OF A STARTED COMMAND ────────────────────────────────
     The handle names the durable claim. Delegate on its frozen version, and
     do not look at the quotation at all: PENDING recovers, RELEASED reports
     itself, and neither depends on today's provenance still verifying. */
  if (active) {
    const durable = commandOf(ctx, identity, active.costingVersionId);
    if (durable.expectedVersion === echoed) return deliver(ctx, durable, actor);
  }

  /* ── OTHERWISE IT IS A NEW ATTEMPT, VERIFIED IN FULL ────────────────────
     Today's quotation answers, the handle must match it, and every
     provenance, quantity, approval and costing-source check the authority
     makes runs. Where a claim is in force for another version, the authority
     refuses it rather than letting it take the line. */
  const priced = resolveQuotationFor(identity);
  if (!priced.ok) {
    throw fail(CODES.NOT_RESOLVABLE, priced.blocked.message, { reason: priced.blocked.reason });
  }
  const current = commandOf(ctx, identity, priced.costingVersionId);

  if (current.expectedVersion !== echoed) {
    throw fail(
      CODES.VERSION_CHANGED,
      "The approved costing behind this order line changed since you read it. Re-read the file and decide again.",
      {
        reason: "VERSION_CHANGED",
        /* The handle that would work now — the started command's if one is in
           force, otherwise the current price's. */
        expectedVersion: active
          ? commandOf(ctx, identity, active.costingVersionId).expectedVersion
          : current.expectedVersion,
      },
    );
  }

  return deliver(ctx, current, actor);
}

/**
 * Hand the resolved command to the authority and shape what comes back.
 *
 * Everything from here is the authority's. Nothing about eligibility,
 * provenance, recovery, idempotency or concurrency is decided in this file.
 */
async function deliver(ctx, resolved, actor) {
  const out = await orderDemandRelease.release(ctx, {
    orderId: resolved.orderId,
    lineRef: resolved.lineRef,
    costingVersionId: resolved.costingVersionId,
    actor,
  });

  return {
    outcome: str(out.outcome),
    releaseId: str(out.releaseId),
    supersededReleaseId: out.supersededReleaseId || null,
    ...present(out, resolved, { ctx }),
  };
}

module.exports = {
  CODES, UNRESOLVED,
  versionTokenFor, resolveIdentityFor, resolveCommandFor, stateForFile, releaseFromFile,
};
