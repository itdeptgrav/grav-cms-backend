// services/sales/costingPreparation.service.js
//
// SALES ASKS FOR AN ESTIMATE. THIS PREPARES IT, INVISIBLY.
//
// ── WHAT THIS REPLACED ──────────────────────────────────────────────────────
// A "Calculate new version" button in the Central Costing workspace, and a
// "New costing" button on its list. Between them they meant somebody had to
// open a calculation engine — an app with no customer in front of it — and
// press a button, in order for Sales to learn what a garment costs.
//
// Central Costing is an engine: it assembles departmental facts, applies Store
// quotations and sourcing decisions, applies effective Board policies,
// calculates, versions, and reports readiness. None of that is a screen
// anybody outside it should have to visit.
//
// ── AND THE BROWSER BUILDS NO PAYLOAD ───────────────────────────────────────
// Sales sends an enquiry, a product and an action key. Everything else — the
// style, the quantities, the unit, the policy date, the sources — is resolved
// HERE from records. A browser that could compose a calculation could compose
// one from figures nobody recorded.
//
// ── IT IS NOT A SECOND COSTING ENGINE ───────────────────────────────────────
// Nothing here calculates. It resolves, it decides WHETHER to write, and it
// delegates to the same `costingCreation` and `versionCreation` services the
// retired route used — with the same creation claims and the same idempotency
// guarantees, because those are the protections and reimplementing them is how
// a duplicate gets made.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const { fail } = require("../storePurchase/errors");
const { CAPABILITIES } = require("../centralCosting/capabilities");
const costingBrief = require("./costingBrief.service");
const salesBrief = require("../centralCosting/salesBrief.service");
const sourceFingerprint = require("../centralCosting/sourceFingerprint.service");
const assembly = require("../centralCosting/assembly.service");
const policyService = require("../centralCosting/policy.service");
const costingCreation = require("../centralCosting/costingCreation.service");
const versionCreation = require("../centralCosting/versionCreation.service");
const { parseScenarios } = require("../centralCosting/calculationInput");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

const model = (name, path) => (mongoose.models[name] || require(path));
const Costing = () => model("Costing", "../../models/CMS_Models/Costing/Costing");
const CostingVersion = () => model("CostingVersion", "../../models/CMS_Models/Costing/CostingVersion");
const Enquiry = () => model("Enquiry", "../../models/CMS_Models/Sales/Enquiry");

/** What Sales is told, in Sales' words. */
const STATE = Object.freeze({
  /* Sales has not confirmed a brief, or a department owes an input. */
  AWAITING_INPUTS: "AWAITING_INPUTS",
  /* An estimate exists and its sources have not moved since. */
  ESTIMATE_READY: "ESTIMATE_READY",
  /* An estimate exists and something it was calculated from has changed. */
  INPUTS_CHANGED: "INPUTS_CHANGED",
  /* Nothing has been prepared yet, and everything needed is present. */
  READY_TO_PREPARE: "READY_TO_PREPARE",
});

/** Where a blocker is answered. Sales is told the desk, never the value. */
const OWNER_APP = Object.freeze({
  Sales: "sales",
  Merchandising: "merchandising",
  "R&D": "rnd",
  Production: "production",
  "Store / Purchase": "store",
  Board: "board",
});

/**
 * The durable creation claim, derived the way the middleware derives it.
 *
 * ── WHY NOT A NEW SCHEME ────────────────────────────────────────────────────
 * `{company, actor, operation, key}` hashed, so there is one way of claiming
 * one action rather than two — the unique index protects whichever one anybody
 * thought about only if there IS only one.
 *
 * ── AND WHY THE SUBJECT IS IN THE KEY ───────────────────────────────────────
 * The HTTP middleware leaves the target out of the hash and stores it beside
 * the claim, so the same key aimed at a second costing COLLIDES and is refused
 * — `IDEMPOTENCY_KEY_REUSED`, a client bug reported as one.
 *
 * That refusal needs a record to compare against and a caller who can act on
 * it. Here there is neither: nothing stores a target on the costing's creation
 * claim, so a collision would not be caught — it would be RECOVERED, and
 * preparing an estimate for the second enquiry would hand back the first
 * enquiry's costing. The wrong garment, silently, under a claim that says the
 * action already succeeded.
 *
 * So the subject is part of what is claimed. One key pressed on two enquiries
 * is two actions and produces two estimates, which is what the person meant;
 * the same key pressed twice on ONE enquiry is still one action and still
 * recovers, which is what the claim is for.
 */
function claimFor(ctx, operation, key, subject = "") {
  if (!str(key)) return null;
  return {
    claimId: crypto.createHash("sha256").update(JSON.stringify([
      String(ctx.companyId), String(ctx.actorId || ""), operation, str(key), str(subject),
    ])).digest("hex"),
    requestHash: "",
    target: str(subject),
  };
}

/* ══ RESOLVING, WITHOUT WRITING ════════════════════════════════════════════ */

/**
 * Does this enquiry carry exactly one row with that product name?
 *
 * The question `findCosting` needs before adopting a costing filed under a bare
 * name: unambiguous means the historical record is this line's, and ambiguous
 * means it belongs to neither colourway in particular.
 */
async function nameIsUniqueOn(ctx, enquiryId, product) {
  const enquiry = await Enquiry().findOne({
    _id: enquiryId, companyId: ctx.companyId, isActive: true,
  }).select("products").lean();
  return (enquiry?.products || []).filter((p) => str(p.product) === str(product)).length <= 1;
}

/**
 * The costing for one enquiry LINE, if one has been raised.
 *
 * ── THE STYLE IS ON `context.secondaryId`, NOT IN THE KEY ───────────────────
 * `externalKey` is the product NAME, and nine other readers across Central
 * Costing treat it as exactly that — the technical-style binding, the approved
 * output lookup, the legacy sheet import and the enquiry lookup among them.
 * Encoding a style into it to tell two colourways apart broke every one of
 * them, which is how that idea was discovered to be wrong.
 *
 * The context already carries an optional `secondaryId`. A costing raised for a
 * known style records it there, so the name stays the name and the style is a
 * field of its own. Readers that do not know about it are unaffected.
 *
 * ── AND WHY THE FALLBACK IS CONDITIONAL ─────────────────────────────────────
 * A costing raised before this carries no `secondaryId`. Adopting it is right
 * where the enquiry has exactly one row with that name — it is unambiguously
 * this line's. Where it has two, that record predates the distinction and
 * belongs to neither in particular, so it is NOT adopted: handing it to
 * whichever colourway asked first is the collision this exists to close.
 */
async function findCosting(ctx, { enquiryId, product, sampleStyleId = "", nameIsUnique = true }) {
  const base = {
    companyId: ctx.companyId,
    "context.type": "ENQUIRY_STYLE",
    "context.primaryId": enquiryId,
    "context.externalKey": str(product),
  };
  if (str(sampleStyleId)) {
    const forStyle = await Costing().findOne({ ...base, "context.secondaryId": sampleStyleId });
    if (forStyle) return forStyle;
    if (!nameIsUnique) return null;
    /* One row with this name: an unqualified costing is this line's. */
    return Costing().findOne({ ...base, "context.secondaryId": { $in: [null, undefined] } })
      || Costing().findOne(base);
  }
  return Costing().findOne(base);
}

/** Its newest version, and its newest APPROVED one. They are different facts. */
async function versionsOf(ctx, costingId) {
  if (!costingId) return { latest: null, approved: null };
  const [latest, approved] = await Promise.all([
    CostingVersion().findOne({ companyId: ctx.companyId, costingId })
      .sort({ versionNumber: -1 }).lean(),
    CostingVersion().findOne({ companyId: ctx.companyId, costingId, status: "APPROVED" })
      .sort({ versionNumber: -1 }).lean(),
  ]);
  return { latest: latest || null, approved: approved || null };
}

/**
 * EVERYTHING NEEDED TO ANSWER "CAN THIS BE COSTED, AND IS IT CURRENT?"
 *
 * Read-only. Called on every page load, so it must write nothing — a screen
 * that created a version by being looked at would fill the history with
 * versions nobody asked for.
 */
async function resolve(ctx, { enquiryId, product, productLineRef = "", sampleStyleId = "" } = {}) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  if (!isId(enquiryId)) throw fail("NOT_FOUND", "That enquiry was not found.");

  /* Company first, then the record — never the reverse. */
  const enquiry = await Enquiry().findOne({
    _id: enquiryId, companyId: ctx.companyId, isActive: true,
  }).select("enquiryId costingBriefs products commercialLines").lean();
  if (!enquiry) throw fail("NOT_FOUND", "That enquiry was not found.");

  const wanted = str(product);
  const ref = str(productLineRef);
  const styleId = str(sampleStyleId);

  /* ── THE LINE IS VERIFIED, NOT TRUSTED ───────────────────────────────
     A caller that names a line must name one this enquiry actually has, on
     the style it actually has. Anything else is refused rather than quietly
     answered with the costing a NAME happens to find — which is how a
     browser would be handed a nearby colourway's figures. */
  if (ref) {
    const row = (enquiry.products || []).find((p) => str(p.productLineRef) === ref) || null;
    if (!row) {
      throw fail("NOT_FOUND", "That product line is not on this enquiry.",
        { reason: "LINE_NOT_FOUND", productLineRef: ref });
    }
    if (wanted && str(row.product) !== wanted) {
      throw fail("VALIDATION", "That product line is for a different product.",
        { reason: "LINE_PRODUCT_MISMATCH" });
    }
    if (styleId) {
      const line = (enquiry.commercialLines || []).find((l) => str(l.productLineRef) === ref
        && String(l.sampleStyleId || "") === styleId) || null;
      /* Absent is not a refusal: a line may legitimately have no confirmed
         quantity yet, and this read is how a screen learns that. What IS
         refused is a pair that contradicts itself. */
      const otherStyle = (enquiry.commercialLines || []).some((l) => str(l.productLineRef) === ref
        && String(l.sampleStyleId || "") !== styleId);
      if (!line && otherStyle) {
        throw fail("VALIDATION", "That product line is confirmed against a different style.",
          { reason: "LINE_STYLE_MISMATCH" });
      }
    }
  }

  /* Whether the bare name is still a safe key for a historical costing. */
  const nameIsUnique = (enquiry.products || [])
    .filter((p) => str(p.product) === wanted).length <= 1;

  let brief = null;
  let briefBlocker = null;
  try {
    brief = costingBrief.confirmedBriefOn(enquiry, wanted, { sampleStyleId: styleId });
  } catch (err) {
    /* Two confirmed briefs for one product. Reported, never ranked. */
    briefBlocker = { code: err.code || "VALIDATION", message: err.message, details: err.details || {} };
  }

  const costing = await findCosting(ctx, {
    enquiryId, product: wanted, sampleStyleId: styleId, nameIsUnique,
  });
  const { latest, approved } = await versionsOf(ctx, costing?._id);

  if (!brief) {
    return {
      state: STATE.AWAITING_INPUTS,
      enquiryRef: str(enquiry.enquiryId),
      product: wanted,
      brief: null,
      blockers: [briefBlocker
        ? { key: "brief:ambiguous", owner: "Sales", ownerApp: "sales", message: briefBlocker.message, blocking: true }
        : {
          key: "brief:missing",
          owner: "Sales",
          ownerApp: "sales",
          message: "Confirm a costing brief before an estimate can be prepared.",
          action: { id: "SALES_COSTING_BRIEF", label: "Open the costing brief", section: "costing-brief" },
          blocking: true,
        }],
      costingId: costing ? String(costing._id) : null,
      latestVersion: null,
      approvedVersion: null,
      fingerprint: null,
      freshness: { comparable: false, stale: false, changed: [] },
    };
  }

  /* ── ASSEMBLE, TO LEARN WHAT IS MISSING ──────────────────────────────
     The same assembly a calculation runs. It reads and reports; only
     `prepare` below turns its result into a version.

     ── AND IT RUNS BEFORE THE COSTING EXISTS ─────────────────────────
     Assembling only where a costing had already been raised was a hole: the
     FIRST ask had nothing to assemble, so it reported no blockers and
     prepared over whatever was missing — and the SECOND ask, now that a
     costing existed, blocked on gaps the first had already priced over.

     A costing is a record, not a precondition for reading one's sources. So
     a transient stand-in carries the context, and the read is identical. */
  const subject = costing || {
    _id: null,
    context: { type: "ENQUIRY_STYLE", primaryId: enquiryId, externalKey: wanted },
  };
  const assembled = await assembleFor(ctx, subject, brief);
  const policyBundle = await policyService.getPolicy(ctx).catch(() => null);
  /* ── AND THE BOARD'S DECISIONS, RESOLVED SEPARATELY ─────────────────────
     The company costing policy does not carry them: each family's service
     resolves its own at calculation time. Read here, generically over the
     Board's own keys, so approving a new policy — or backdating one — reads
     as "inputs changed" rather than as nothing at all. */
  const asOf = new Date();
  const boardPolicies = await sourceFingerprint
    .boardPoliciesFor(ctx.companyId, asOf).catch(() => ({}));

  const fingerprint = assembled
    ? sourceFingerprint.fingerprintFor({
      brief,
      preview: assembled.technical,
      assembled,
      policy: policyBundle?.policy || {},
      boardPolicies,
      asOf,
    })
    : null;

  const freshness = latest && fingerprint
    ? sourceFingerprint.compare(latest.provenance || {}, fingerprint)
    : { comparable: false, stale: false, changed: [] };

  const blockers = blockersFrom(assembled);

  return {
    state: stateOf({ blockers, latest, freshness }),
    enquiryRef: str(enquiry.enquiryId),
    product: wanted,
    brief,
    blockers,
    costingId: costing ? String(costing._id) : null,
    latestVersion: latest,
    approvedVersion: approved,
    fingerprint,
    freshness,
  };
}

/** The assembly, from the brief. Never from anything a caller supplied. */
async function assembleFor(ctx, costing, brief) {
  const policyBundle = await policyService.getPolicy(ctx);
  const fromBrief = salesBrief.toCalculationInput(brief);
  return assembly.assembleLines(ctx, costing, {
    styleId: fromBrief.technicalStyleId,
    policy: policyBundle.policy,
    scenarios: parseScenarios(fromBrief.scenarios),
  }).catch((err) => {
    /* An assembly that cannot run at all is itself a blocker, and a named
       one — never an exception surfaced to Sales as a stack trace. */
    if (err?.code) return { state: "BLOCKED", missing: [{ key: err.code, message: err.message, owner: err.details?.owner || null, blocking: true }] };
    throw err;
  });
}

/**
 * WHAT A COSTING INPUT IS DOING, IN ONE WORD.
 *
 * Two states, because the assembly makes two distinctions and no more: a
 * required source nobody has recorded, and a source that exists but has not
 * been accepted. "Ready" is not among them by design — a resolved input does
 * not appear in `missing` at all, so a reader that saw one here would be
 * reading a contradiction.
 */
const INPUT_STATUS = Object.freeze({
  PENDING: "PENDING",
  UNDER_VERIFICATION: "UNDER_VERIFICATION",
});

/**
 * Every gap, grouped by the desk that answers it.
 *
 * The assembly already names an owner on each. This adds the app that owner
 * works in, so a screen can offer a destination instead of a department name
 * somebody then has to go and find.
 */
function blockersFrom(assembled) {
  /* ── AND NOT THE COVERAGE FAMILIES ───────────────────────────────────
     Folding `coverage.families` in here looked right and was wrong. The
     coverage assessment is made against a CALCULATED scenario; before the
     engine runs there are no subtotals, so every family reads NEEDS_INPUT
     and a fully sourced costing reported eight blockers.

     `missing` is the assembly's own list — a material with no applicable
     quotation, a lane nobody has priced, a requirement R&D left unfinished —
     and it is the one that means "somebody owes an input" before anything is
     costed. The coverage assessment answers a different question, AFTER the
     calculation, and is frozen on the version for that. */
  return (assembled?.missing || []).map((m) => {
    const owner = str(m.owner?.department) || str(m.owner) || null;
    return {
      key: str(m.key),
      owner,
      ownerApp: owner ? OWNER_APP[owner] || null : null,
      recordedIn: str(m.owner?.system) || null,
      message: str(m.message),
      blocking: m.blocking === true,
      /* ── THE SAME FACT, NAMED ─────────────────────────────────────────
         `blocking` already says which of two things this is: a required
         source nobody has recorded, or one that exists but is not yet
         accepted. What it does not do is say so in a word a screen can
         print, so every reader invented its own mapping — and a second
         mapping is how one screen came to show "Not started" beside a
         costing that had already been calculated and approved.

         This adds no rule. It is the existing verdict, named once, here,
         where the verdict is made. */
      status: m.blocking === true ? INPUT_STATUS.PENDING : INPUT_STATUS.UNDER_VERIFICATION,
    };
  });
}

function stateOf({ blockers, latest, freshness }) {
  if (blockers.some((b) => b.blocking)) return STATE.AWAITING_INPUTS;
  if (!latest || latest.status === "DRAFT" && !latest.scenarios?.length) return STATE.READY_TO_PREPARE;
  if (freshness.stale) return STATE.INPUTS_CHANGED;
  return STATE.ESTIMATE_READY;
}

/**
 * MAY THIS ACTOR ASK FOR AN ESTIMATE AT ALL?
 *
 * ── DEFENCE IN DEPTH, NOT THE ONLY DEFENCE ─────────────────────────────────
 * The Sales route checks this before it calls in, and should: refusing at the
 * door is cheaper and gives the screen something to render. This is the second
 * check, and it exists because the first one is a property of ONE route.
 *
 * This service is a plain module. Anything in the process can require it and
 * call `prepare` — a future route, a job, a script written in a hurry. Every
 * one of those would inherit the company proof from the ctx it was handed and
 * NONE of them would inherit the authorisation, because the authorisation
 * currently lives in a file none of them import. That is how a hole gets
 * reintroduced by somebody who never knew it had been closed.
 *
 * So the write path asks for itself, from the capability set the shared
 * resolver put on the ctx — re-read from the database on every request, which
 * is what makes a revoked grant take effect on the next call rather than when
 * a token expires.
 *
 * `resolve` deliberately does NOT call this. Reading where an estimate stands
 * is not preparing one, it writes nothing, and a Sales viewer is entitled to
 * the commercial output their grant already carries.
 */
function assertMayPrepare(ctx) {
  if (ctx?.capabilitySet?.has?.(CAPABILITIES.PREPARE)) return;
  throw fail(
    "COSTING_PREPARE_FORBIDDEN",
    "You do not have permission to prepare an estimate for this enquiry.",
    {
      reason: "PREPARE_NOT_GRANTED",
      /* The capability by name, for a client to reason about — never a list
         of who does hold it, which would be a directory of the company's
         approvers handed to somebody who just failed a permission check. */
      required: CAPABILITIES.PREPARE,
      owner: { department: "Sales", recordedIn: "Department roles" },
    },
  );
}

/* ══ PREPARING ════════════════════════════════════════════════════════════ */

/**
 * PREPARE OR REFRESH THE ESTIMATE.
 *
 * ── THE FOUR OUTCOMES, AND WHY NONE OF THEM IS "ALWAYS WRITE" ───────────────
 *   · blocked        — a department owes an input. Nothing is written, and
 *                      every blocker is returned. A version calculated over a
 *                      missing source is a confident number answering a
 *                      smaller question than it appears to.
 *   · created        — no costing existed. The costing and its version 1 are
 *                      created together, under the same creation claim the
 *                      retired route used.
 *   · revised        — the fingerprint moved. A new draft version.
 *   · unchanged      — the fingerprint is identical. The EXISTING version is
 *                      returned. Sales refreshing a page, or pressing the
 *                      button twice, must not fill the history with versions
 *                      that say the same thing.
 *
 * An APPROVED version is never touched by any of them. A refresh over an
 * approved costing creates a new DRAFT beside it and leaves the approved one
 * exactly as it was.
 */
async function prepare(ctx, {
  enquiryId, product, productLineRef = "", sampleStyleId = "", actionKey = "", actor = null,
} = {}) {
  /* ── BEFORE ANYTHING IS READ, RESOLVED OR WRITTEN ──────────────────────
     First statement in the function on purpose. A refusal that arrives after
     the brief is resolved and the sources are assembled has already spent the
     work, and a refusal that arrives after `createCostingWithFirstVersion`
     has not refused anything at all. Nothing below this line runs for a
     caller without the grant: no costing, no version, no creation claim, no
     idempotency record. */
  assertMayPrepare(ctx);
  const resolved = await resolve(ctx, { enquiryId, product, productLineRef, sampleStyleId });

  if (!resolved.brief) {
    throw fail("COSTING_BRIEF_REQUIRED",
      "Confirm a costing brief before preparing an estimate.",
      { reason: "NO_CONFIRMED_BRIEF", owner: { department: "Sales", recordedIn: "Enquiry · Costing brief" } });
  }
  if (resolved.blockers.some((b) => b.blocking)) {
    /* ── RETURNED, NOT THROWN AS A SINGLE MESSAGE ────────────────────
       Somebody chasing six departments needs all six, once — not the first
       one, six times. */
    return { outcome: "BLOCKED", ...resolved };
  }

  const wanted = str(product);
  let costing = resolved.costingId
    ? await Costing().findById(resolved.costingId)
    : null;

  /* ── 1. THE COSTING ITSELF, WHERE NONE EXISTS ─────────────────────────
     Through `costingCreation`, so the pair is atomic where the deployment
     supports it and compensated where it does not — and so the creation
     claim is written in the same insert as the costing. */
  if (!costing) {
    const created = await costingCreation.createCostingWithFirstVersion(
      ctx,
      {
        /* The name stays the name — every other reader depends on that —
           and the STYLE goes on `secondaryId`, so two colourways of one
           garment do not share a costing, its versions or its approval. */
        context: {
          type: "ENQUIRY_STYLE",
          primaryId: str(enquiryId),
          externalKey: wanted,
          ...(resolved.brief?.sampleStyleId || sampleStyleId
            ? { secondaryId: str(resolved.brief?.sampleStyleId || sampleStyleId) }
            : {}),
        },
        contextSnapshot: contextSnapshotFor(resolved),
        baseCurrency: str(resolved.brief.currency) || "INR",
        sourceReferences: [],
        note: str(resolved.brief.note).slice(0, 500),
      },
      {
        requestId: "",
        idempotencyKey: `${actionKey}:create`,
        claim: claimFor(ctx, "COSTING_CREATE", `${actionKey}:create`,
          `enquiry:${str(enquiryId)}:${wanted}:${str(resolved.brief?.sampleStyleId || sampleStyleId)}`),
      },
    );
    costing = created.costing;
  }

  /* ── 2. AND A VERSION, ONLY IF THE SOURCES MOVED ──────────────────────
     The fingerprint decides. Identical sources produce no version at all —
     which is what makes the button safe to press twice, and safe to leave on
     a page somebody reloads. */
  const { latest } = await versionsOf(ctx, costing._id);
  const priced = latest && (latest.scenarios || []).length;
  const fingerprint = resolved.fingerprint;

  if (priced && fingerprint && str(latest.provenance?.sourceFingerprint) === str(fingerprint.hash)) {
    return {
      outcome: "UNCHANGED",
      ...(await resolve(ctx, { enquiryId, product })),
      costingId: String(costing._id),
    };
  }

  const fromBrief = salesBrief.toCalculationInput(resolved.brief);
  await versionCreation.createNextVersion(
    ctx,
    costing,
    {
      lines: [],
      scenarios: parseScenarios(fromBrief.scenarios),
      note: fromBrief.note,
      technicalStyleId: fromBrief.technicalStyleId,
    },
    {
      requestId: "",
      idempotencyKey: actionKey,
      claim: claimFor(ctx, "COSTING_VERSION_CREATE", actionKey, `costing:${String(costing._id)}`),
      origin: "SALES_PREPARATION",
      sourceReferences: [salesBrief.briefProvenance(resolved.brief)],
      /* Frozen with the version, so "have the inputs changed since?" has
         something to compare against for ever. */
      sourceFingerprint: fingerprint,
      asOf: new Date(),
      onCommitted: null,
    },
  );

  const after = await resolve(ctx, { enquiryId, product });
  return { outcome: priced ? "REVISED" : "PREPARED", ...after, costingId: String(costing._id) };
}

/** The display copy, built from records — never from a caller's label. */
function contextSnapshotFor(resolved) {
  return {
    label: `${resolved.product} — ${resolved.enquiryRef}`,
    facts: [
      { key: "enquiryId", value: resolved.enquiryRef },
      { key: "product", value: resolved.product },
      { key: "costingBriefId", value: str(resolved.brief?.briefId) },
    ].filter((f) => f.value),
    capturedAt: new Date(),
  };
}

module.exports = {
  nameIsUniqueOn, STATE, OWNER_APP, INPUT_STATUS, resolve, prepare, findCosting, versionsOf, blockersFrom, stateOf };
