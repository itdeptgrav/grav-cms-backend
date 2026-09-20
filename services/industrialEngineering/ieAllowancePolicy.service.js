// services/industrialEngineering/ieAllowancePolicy.service.js
//
// THE COMPANY ALLOWANCE POLICY (Chunk 4B).
//
// Six things happen here: list, read, create a draft, edit a draft, publish it,
// and resolve which published policy applies to a date. Nothing edits a
// published policy, nothing retires one and nothing deletes one — a frozen
// method-study submission points at these figures, and a policy that can be
// changed afterwards is a standard time that can be restated without anybody's
// signature.
//
// ── MAKER-CHECKER IS THE POINT OF THE PUBLISH STEP ──────────────────────────
// An allowance policy raises or lowers every standard time in the factory, so
// the person who publishes it must not be the person who wrote it. The check
// compares stable actor IDS — never display names, because two people share a
// name and a rename would hand somebody the right to approve their own work.
// Neither an IE owner nor a platform administrator is exempt: their grant says
// what they may DO, and maker-checker is about who they ARE.
//
// ── EFFECTIVE-DATED, AND NOT "THE NEWEST ONE" ───────────────────────────────
// The applicable policy for a date is the published policy with the latest
// `effectiveFrom` that is not after it. A study timed in September is
// calculated on September's allowances even if it is submitted in December.
// When no policy covers the date the answer is a typed refusal, never a
// fallback to the newest — silently applying next year's rules to last year's
// work is the failure this whole record exists to prevent.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const IeAllowancePolicy = require("../../models/CMS_Models/IndustrialEngineering/IeAllowancePolicy");
const { fail } = require("../storePurchase/errors");
const { totalAllowancePercentOf, round4 } = require("./standardTimeCalculation");
const { encodeCursor, decodeCursor, pageSize } = require("./ieRead.service");

const { LIMITS } = IeAllowancePolicy;

const STATUS = Object.freeze({ DRAFT: "DRAFT", PUBLISHED: "PUBLISHED" });

/* The writable surface. `expectedRevision` is the concurrency token on a PATCH
   and on a publish; it is never stored. */
const POLICY_FIELDS = Object.freeze(["name", "effectiveFrom", "categories"]);
const PATCH_FIELDS = Object.freeze([...POLICY_FIELDS, "expectedRevision"]);
const CATEGORY_FIELDS = Object.freeze(["categoryId", "code", "name", "percent", "note"]);

const REFUSED_FIELDS = Object.freeze({
  companyId: "the company — that comes from your own membership, never a body",
  status: "its own status — publishing is its own action, by a different person",
  revision: "its own revision — send `expectedRevision` to say which one you read",
  totalAllowancePercent: "the total, which the server sums from the categories",
  publishedBy: "who published it",
  publishedAt: "when it was published",
  history: "its own audit trail",
  wageRate: "a wage. IE owns the time; payroll owns the money",
  costingAllowance: "a costing allowance, which is another department's number",
  materialAllowance: "a material allowance, which is a consumption figure and not a time",
});

const CATEGORY_REFUSED = Object.freeze({
  sequence: "its own position — the order of `categories` is the sequence",
  totalAllowancePercent: "the policy total, which the server sums",
});

/* ═══ HELPERS ══════════════════════════════════════════════════════════════ */

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v ?? ""));
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

function assertContext(ctx) {
  if (!ctx?.companyId) {
    throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  }
}

/** One indistinguishable refusal for absent, foreign and malformed alike. */
const policyNotFound = () => fail("IE_ALLOWANCE_POLICY_NOT_FOUND", "That allowance policy was not found.");

const mintCategoryId = () => `cat_${crypto.randomBytes(9).toString("hex")}`;
const mintEventId = () => `ape_${crypto.randomBytes(9).toString("hex")}`;

const actorName = (actor) => str(actor?.name || actor?.email);
const actorId = (actor) => (isId(actor?.id) ? oid(actor.id) : null);

const event = (type, { actor, policyRevision, changed = [], summary = "" }) => ({
  eventId: mintEventId(),
  type,
  at: new Date(),
  actorId: actorId(actor),
  actorName: actorName(actor),
  policyRevision,
  changed,
  summary: summary.slice(0, LIMITS.SUMMARY),
});

/**
 * An effective date, normalised to midnight UTC.
 *
 * A policy applies to a DAY, not to an instant. Keeping the typed time of day
 * would make "effective 1 September" mean 14:32 on the 1st for one company and
 * 09:05 for another, and the uniqueness rule for published dates would stop
 * being about dates at all.
 */
function readEffectiveFrom(value, { required = true } = {}) {
  if (value === null || value === undefined || value === "") {
    if (!required) return null;
    throw fail("VALIDATION", "Say from which date this policy applies.", {
      field: "effectiveFrom",
      fieldErrors: [{ field: "effectiveFrom", code: "REQUIRED", message: "Say from which date this policy applies." }],
    });
  }
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) {
    throw fail("VALIDATION", "That effective date is not a date.", {
      field: "effectiveFrom",
      fieldErrors: [{ field: "effectiveFrom", code: "INVALID", message: "That effective date is not a date." }],
    });
  }
  return new Date(Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), when.getUTCDate()));
}

function readExpectedRevision(value) {
  if (value === undefined || value === null || value === "") {
    throw fail("VALIDATION", "Say which revision of this policy you read.", {
      field: "expectedRevision",
      fieldErrors: [{ field: "expectedRevision", code: "REQUIRED", message: "Say which revision of this policy you read." }],
    });
  }
  const expected = Number(value);
  if (!Number.isInteger(expected) || expected < 1) {
    throw fail("VALIDATION", "A revision is a whole number.", {
      field: "expectedRevision",
      fieldErrors: [{ field: "expectedRevision", code: "NOT_AN_INTEGER", message: "A revision is a whole number." }],
    });
  }
  return expected;
}

function assertShape(body, allowed, label) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw fail("VALIDATION", `That is not ${label}.`);
  }
  for (const key of Object.keys(body)) {
    const refused = REFUSED_FIELDS[key];
    if (refused) {
      throw fail("FIELD_NOT_ACCEPTED", `An allowance policy cannot carry ${refused}.`,
        { field: key, fieldErrors: [{ field: key, code: "NOT_ACCEPTED", message: `This record does not accept "${key}".` }] });
    }
    if (!allowed.includes(key)) {
      throw fail("FIELD_NOT_ACCEPTED", `"${key}" is not part of ${label}.`,
        { field: key, fieldErrors: [{ field: key, code: "NOT_ACCEPTED", message: `"${key}" is not part of ${label}.` }] });
    }
  }
}

function readName(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw fail("VALIDATION", "Give this policy a name.", {
      field: "name",
      fieldErrors: [{ field: "name", code: "REQUIRED", message: "Give this policy a name." }],
    });
  }
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length > LIMITS.NAME) {
    throw fail("VALIDATION", `A name is at most ${LIMITS.NAME} characters.`, {
      field: "name",
      fieldErrors: [{ field: "name", code: "TOO_LONG", message: `A name is at most ${LIMITS.NAME} characters.` }],
    });
  }
  return name;
}

/**
 * The categories, validated whole before anything is written.
 *
 * An id the policy already holds keeps that category's identity; one it does
 * not hold is refused rather than quietly minted, because a client sending an
 * unknown id is out of step with the record. New categories arrive without an
 * id and are given one.
 */
function shapeCategories(list, existingById) {
  /* ── OMITTED IS NOT THE SAME CLAIM AS EMPTY ─────────────────────────────
     `[]` is a company saying "no allowances apply" — a decision somebody made,
     and a perfectly valid 0% policy. A MISSING `categories` is a client that
     did not send them, and treating the two alike would let a request that lost
     its payload become a published 0% policy that quietly shortens every
     standard time in the factory. So absence is refused here, and the only
     caller that may omit the field is a PATCH, which means "leave the stored
     categories alone" and never reaches this function. */
  if (!Array.isArray(list)) {
    throw fail("IE_ALLOWANCE_CATEGORY_INVALID", "Categories are a list.", {
      field: "categories",
      fieldErrors: [{ field: "categories", code: "NOT_A_LIST", message: "Categories are a list." }],
    });
  }
  if (list.length > LIMITS.CATEGORIES) {
    throw fail("IE_ALLOWANCE_CATEGORY_INVALID", `A policy holds at most ${LIMITS.CATEGORIES} categories.`, {
      field: "categories",
      fieldErrors: [{ field: "categories", code: "TOO_MANY", message: `A policy holds at most ${LIMITS.CATEGORIES} categories.` }],
    });
  }

  const errs = [];
  const seenIds = new Set();
  const byCode = new Map();
  const shaped = [];

  for (let i = 0; i < list.length; i += 1) {
    const raw = list[i];
    const at = (f) => `categories.${i}.${f}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errs.push({ field: `categories.${i}`, code: "INVALID", message: "Every category is an object." });
      continue;
    }
    for (const key of Object.keys(raw)) {
      const refused = CATEGORY_REFUSED[key];
      if (refused) {
        throw fail("FIELD_NOT_ACCEPTED", `A category cannot carry ${refused}.`,
          { field: at(key), fieldErrors: [{ field: at(key), code: "NOT_ACCEPTED", message: `A category cannot carry "${key}".` }] });
      }
      if (!CATEGORY_FIELDS.includes(key)) {
        throw fail("FIELD_NOT_ACCEPTED", `"${key}" is not part of an allowance category.`,
          { field: at(key), fieldErrors: [{ field: at(key), code: "NOT_ACCEPTED", message: `"${key}" is not part of an allowance category.` }] });
      }
    }

    let categoryId = str(raw.categoryId);
    if (categoryId) {
      if (!existingById.has(categoryId)) {
        errs.push({ field: at("categoryId"), code: "INVALID", message: "That category is not part of this policy.", categoryId });
      } else if (seenIds.has(categoryId)) {
        errs.push({ field: at("categoryId"), code: "DUPLICATE", message: "The same category appears twice.", categoryId });
      }
      seenIds.add(categoryId);
    } else {
      categoryId = mintCategoryId();
    }

    const code = str(raw.code).toUpperCase();
    if (!code) {
      errs.push({ field: at("code"), code: "REQUIRED", message: "Give this category a code.", categoryId });
    } else if (code.length > LIMITS.CODE) {
      errs.push({ field: at("code"), code: "TOO_LONG", message: `A code is at most ${LIMITS.CODE} characters.`, categoryId });
    } else if (!/^[A-Z0-9][A-Z0-9 ._/-]*$/.test(code)) {
      errs.push({ field: at("code"), code: "INVALID", message: "A code uses letters, digits and . _ / - and starts with a letter or digit.", categoryId });
    } else if (byCode.has(code)) {
      /* Its own typed refusal: two categories sharing a code make the policy
         unreadable in a frozen snapshot, where the code is how a reviewer
         recognises which allowance is which. */
      throw fail("IE_ALLOWANCE_CATEGORY_CODE_DUPLICATE",
        `${code} is used by more than one category in this policy.`,
        {
          field: at("code"), code,
          fieldErrors: [{ field: at("code"), code: "DUPLICATE_CODE", message: `${code} is used more than once.`, categoryId }],
        });
    } else {
      byCode.set(code, i);
    }

    const name = str(raw.name);
    if (!name) errs.push({ field: at("name"), code: "REQUIRED", message: "Give this category a name.", categoryId });
    else if (name.length > LIMITS.NAME) errs.push({ field: at("name"), code: "TOO_LONG", message: `A name is at most ${LIMITS.NAME} characters.`, categoryId });

    if (!isFiniteNumber(raw.percent)) {
      errs.push({ field: at("percent"), code: "REQUIRED", message: "Say what percentage this allowance is.", categoryId });
    } else if (raw.percent < 0 || raw.percent > LIMITS.PERCENT) {
      errs.push({ field: at("percent"), code: "OUT_OF_RANGE", message: `A category percentage is between 0 and ${LIMITS.PERCENT}.`, categoryId });
    }

    const note = str(raw.note);
    if (note.length > LIMITS.NOTE) {
      errs.push({ field: at("note"), code: "TOO_LONG", message: `A note is at most ${LIMITS.NOTE} characters.`, categoryId });
    }

    shaped.push({
      categoryId,
      sequence: shaped.length + 1,
      code,
      name,
      percent: isFiniteNumber(raw.percent) ? round4(raw.percent) : null,
      note,
    });
  }

  if (errs.length) {
    throw fail("IE_ALLOWANCE_CATEGORY_INVALID", "Some of these categories need fixing.",
      { fieldErrors: errs, field: errs[0].field });
  }

  const total = totalAllowancePercentOf(shaped);
  if (total === null || total > LIMITS.TOTAL_PERCENT) {
    throw fail("IE_ALLOWANCE_TOTAL_OUT_OF_RANGE",
      `The allowances add up to ${total}%. A policy's total is at most ${LIMITS.TOTAL_PERCENT}%.`,
      {
        field: "categories", totalAllowancePercent: total,
        fieldErrors: [{ field: "categories", code: "TOTAL_OUT_OF_RANGE", message: `The total is at most ${LIMITS.TOTAL_PERCENT}%.` }],
      });
  }
  return { categories: shaped, totalAllowancePercent: total };
}

/* ═══ PUBLISHED SHAPE ══════════════════════════════════════════════════════ */

const publishCategory = (c) => ({
  categoryId: c.categoryId,
  sequence: c.sequence,
  code: c.code,
  name: c.name,
  percent: c.percent,
  note: c.note || "",
});

const publishEvent = (e) => ({
  eventId: e.eventId,
  type: e.type,
  at: e.at ? new Date(e.at).toISOString() : null,
  actorName: e.actorName || "",
  policyRevision: e.policyRevision,
  changed: Array.isArray(e.changed) ? [...e.changed] : [],
  summary: e.summary || "",
});

/** An ISO date with no time of day — an effective date is a day. */
const asDay = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

function publishPolicy(doc, { withHistory = false } = {}) {
  return {
    policyId: String(doc._id),
    companyId: String(doc.companyId),
    name: doc.name,
    effectiveFrom: asDay(doc.effectiveFrom),
    categories: (doc.categories || []).map(publishCategory),
    categoryCount: (doc.categories || []).length,
    totalAllowancePercent: doc.totalAllowancePercent ?? 0,
    status: doc.status,
    revision: doc.revision,
    /* Said rather than inferred from the status: a published policy is frozen
       for ever, and this is the field a screen should disable its form on. */
    editable: doc.status === STATUS.DRAFT,
    createdByName: doc.createdByName || "",
    updatedByName: doc.updatedByName || "",
    publishedByName: doc.publishedByName || "",
    publishedAt: doc.publishedAt ? new Date(doc.publishedAt).toISOString() : null,
    ...(withHistory ? { history: [...(doc.history || [])].reverse().map(publishEvent) } : {}),
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
  };
}

/** The frozen copy a method-study submission keeps. Enough to re-derive the
 *  standard time without this collection existing. */
const snapshotOf = (doc) => ({
  policyId: String(doc._id),
  policyRevision: doc.revision,
  name: doc.name,
  effectiveFrom: doc.effectiveFrom,
  categories: (doc.categories || []).map(publishCategory),
  totalAllowancePercent: doc.totalAllowancePercent ?? 0,
});

/* ═══ READING ══════════════════════════════════════════════════════════════ */

/**
 * The company's policies, newest effective date first.
 *
 * Drafts included and labelled: a company has at most one, and hiding it would
 * leave an editor unable to find the thing they were writing.
 */
async function listPolicies(ctx, { status = "", limit, cursor } = {}) {
  assertContext(ctx);
  const size = pageSize(limit);
  const after = decodeCursor(cursor, "time");

  const wanted = str(status).toUpperCase();
  if (wanted && !Object.values(STATUS).includes(wanted)) {
    throw fail("VALIDATION", "A status filter is DRAFT or PUBLISHED.", {
      field: "status",
      fieldErrors: [{ field: "status", code: "INVALID", message: "A status filter is DRAFT or PUBLISHED." }],
    });
  }

  const and = [{ companyId: ctx.companyId }];
  if (wanted) and.push({ status: wanted });
  if (after) {
    and.push({
      $or: [
        { effectiveFrom: { $lt: new Date(after.t) } },
        { effectiveFrom: new Date(after.t), _id: { $lt: oid(after.i) } },
      ],
    });
  }

  const found = await IeAllowancePolicy.find({ $and: and })
    .sort({ effectiveFrom: -1, _id: -1 })
    .limit(size + 1)
    .lean();

  const page = found.slice(0, size);
  const last = page[page.length - 1];
  return {
    policies: page.map((p) => publishPolicy(p)),
    limit: size,
    hasMore: found.length > size,
    nextCursor: found.length > size
      ? encodeCursor({ t: new Date(last.effectiveFrom).getTime(), i: String(last._id) })
      : null,
    sort: "effectiveFrom:desc,_id:desc",
    statusFilter: wanted || null,
  };
}

async function loadOwnedPolicy(ctx, policyId) {
  assertContext(ctx);
  if (!isId(policyId)) throw policyNotFound();
  const doc = await IeAllowancePolicy.findOne({ _id: oid(policyId), companyId: ctx.companyId }).lean();
  if (!doc) throw policyNotFound();
  return doc;
}

async function readPolicy(ctx, { policyId } = {}) {
  const doc = await loadOwnedPolicy(ctx, policyId);
  return { policy: publishPolicy(doc, { withHistory: true }) };
}

/**
 * THE POLICY THAT APPLIES TO A DATE.
 *
 * Published only — a draft is somebody's unfinished thinking and must never
 * decide a standard time. Latest `effectiveFrom` not after the date, and a
 * typed refusal when there is none.
 */
async function effectivePolicyDoc(ctx, at) {
  assertContext(ctx);
  const when = readEffectiveFrom(at, { required: true });
  const doc = await IeAllowancePolicy.findOne({
    companyId: ctx.companyId,
    status: STATUS.PUBLISHED,
    effectiveFrom: { $lte: when },
  }).sort({ effectiveFrom: -1, _id: -1 }).lean();

  if (!doc) {
    /* Never "the newest policy instead". A study timed before any policy was
       published cannot be given a standard time, and saying so is the whole
       reason this endpoint exists. */
    throw fail("IE_ALLOWANCE_POLICY_NOT_EFFECTIVE",
      `No allowance policy is published as effective on ${asDay(when)}. `
      + "Industrial Engineering has to publish one before a standard time can be calculated for that date.",
      { requestedDate: asDay(when) });
  }
  return { doc, when };
}

async function readEffectivePolicy(ctx, { at } = {}) {
  const { doc, when } = await effectivePolicyDoc(ctx, at);
  return { requestedDate: asDay(when), policy: publishPolicy(doc) };
}

/* ═══ WRITING ══════════════════════════════════════════════════════════════ */

/** CREATE the company's draft policy. */
async function createPolicy(ctx, { body = {}, actor = null } = {}) {
  assertContext(ctx);
  assertShape(body, POLICY_FIELDS, "an allowance policy");

  const name = readName(body.name);
  const effectiveFrom = readEffectiveFrom(body.effectiveFrom);
  if (!("categories" in body)) {
    /* Said explicitly rather than defaulted: a new policy has to state its
       allowances, and stating none is `categories: []`. */
    throw fail("IE_ALLOWANCE_CATEGORY_INVALID",
      "Say which allowance categories this policy has. Send an empty list for a deliberate 0% policy.",
      {
        field: "categories",
        fieldErrors: [{ field: "categories", code: "REQUIRED", message: "Send the allowance categories, or an empty list for a deliberate 0% policy." }],
      });
  }
  const { categories, totalAllowancePercent } = shapeCategories(body.categories, new Map());

  const doc = {
    companyId: ctx.companyId,
    name,
    effectiveFrom,
    categories,
    totalAllowancePercent,
    status: STATUS.DRAFT,
    revision: 1,
    createdBy: actorId(actor),
    createdByName: actorName(actor),
    updatedBy: actorId(actor),
    updatedByName: actorName(actor),
    history: [event("ALLOWANCE_POLICY_CREATED", {
      actor,
      policyRevision: 1,
      summary: `Drafted "${name}", effective ${asDay(effectiveFrom)}, ${totalAllowancePercent}% total`,
    })],
  };

  try {
    const created = await IeAllowancePolicy.create(doc);
    return { policy: publishPolicy(created.toObject(), { withHistory: true }), created: true };
  } catch (err) {
    if (err?.code !== 11000 && !/E11000|duplicate key/i.test(str(err?.message))) throw err;
    /* The DRAFT index refused it — a company edits its one draft rather than
       accumulating half-written policies. Says which one to open. */
    const existing = await IeAllowancePolicy.findOne({ companyId: ctx.companyId, status: STATUS.DRAFT })
      .select("_id name").lean();
    throw fail("IE_ALLOWANCE_POLICY_DRAFT_EXISTS",
      "Your company already has a draft allowance policy. Edit or publish that one.",
      existing ? { policyId: String(existing._id), name: existing.name } : {});
  }
}

/**
 * EDIT the draft.
 *
 * One conditional update carrying the revision AND the DRAFT status, so a
 * published policy can never be reached through this path — not by a race, not
 * by a stale client, and not by a caller who guessed the id.
 */
async function updatePolicy(ctx, { policyId, body = {}, actor = null } = {}) {
  const current = await loadOwnedPolicy(ctx, policyId);
  assertShape(body, PATCH_FIELDS, "an allowance policy");
  const expected = readExpectedRevision(body.expectedRevision);

  if (current.status === STATUS.PUBLISHED) {
    throw fail("IE_ALLOWANCE_POLICY_ALREADY_PUBLISHED",
      "This allowance policy is published and cannot be changed. Draft a new policy with a later effective date.",
      { policyId: String(current._id), effectiveFrom: asDay(current.effectiveFrom) });
  }
  if (current.revision !== expected) {
    throw fail("IE_ALLOWANCE_POLICY_REVISION_CONFLICT",
      "Somebody changed this policy while you were editing it. Re-read it and decide again.",
      { expected, actual: current.revision, policyId: String(current._id) });
  }

  const existingById = new Map((current.categories || []).map((c) => [c.categoryId, c]));
  const next = {
    name: "name" in body ? readName(body.name) : current.name,
    effectiveFrom: "effectiveFrom" in body ? readEffectiveFrom(body.effectiveFrom) : current.effectiveFrom,
  };
  const shaped = "categories" in body
    ? shapeCategories(body.categories, existingById)
    : { categories: (current.categories || []).map((c) => ({ ...c })), totalAllowancePercent: current.totalAllowancePercent };
  next.categories = shaped.categories;
  next.totalAllowancePercent = shaped.totalAllowancePercent;

  const changed = [];
  if (next.name !== current.name) changed.push("name");
  if (new Date(next.effectiveFrom).getTime() !== new Date(current.effectiveFrom).getTime()) changed.push("effectiveFrom");
  if (!sameCategories(current.categories || [], next.categories)) changed.push("categories");

  if (!changed.length) {
    /* A save that changes nothing changes nothing: no write, no revision, no
       history. An editor re-sending on blur would otherwise walk the revision
       up and refuse a colleague's real edit. */
    return { policy: publishPolicy(current, { withHistory: true }), updated: false, events: [] };
  }

  const nextRevision = expected + 1;
  const audit = event("ALLOWANCE_POLICY_EDITED", {
    actor,
    policyRevision: nextRevision,
    changed,
    summary: `Changed ${changed.join(", ")} — ${next.totalAllowancePercent}% total`,
  });

  const updated = await IeAllowancePolicy.findOneAndUpdate(
    { _id: current._id, companyId: ctx.companyId, revision: expected, status: STATUS.DRAFT },
    {
      $set: {
        name: next.name,
        effectiveFrom: next.effectiveFrom,
        categories: next.categories,
        totalAllowancePercent: next.totalAllowancePercent,
        updatedBy: actorId(actor),
        updatedByName: actorName(actor),
      },
      $inc: { revision: 1 },
      $push: { history: { $each: [audit], $slice: -LIMITS.HISTORY } },
    },
    { new: true },
  ).lean();

  if (!updated) {
    const now = await IeAllowancePolicy.findOne({ _id: current._id, companyId: ctx.companyId })
      .select("_id revision status").lean();
    if (!now) throw policyNotFound();
    if (now.status === STATUS.PUBLISHED) {
      throw fail("IE_ALLOWANCE_POLICY_ALREADY_PUBLISHED",
        "This allowance policy was published while you were editing it, and published policies cannot be changed.",
        { policyId: String(now._id) });
    }
    throw fail("IE_ALLOWANCE_POLICY_REVISION_CONFLICT",
      "Somebody changed this policy while you were editing it. Re-read it and decide again.",
      { expected, actual: now.revision, policyId: String(now._id) });
  }

  return { policy: publishPolicy(updated, { withHistory: true }), updated: true, events: [publishEvent(audit)] };
}

/** Categories, compared as they are persisted. */
function sameCategories(a = [], b = []) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    for (const f of ["categoryId", "sequence", "code", "name"]) {
      if ((a[i][f] ?? "") !== (b[i][f] ?? "")) return false;
    }
    if ((a[i].percent ?? null) !== (b[i].percent ?? null)) return false;
    if ((a[i].note || "") !== (b[i].note || "")) return false;
  }
  return true;
}

/**
 * PUBLISH the draft — the maker-checker step.
 *
 * The publisher must be neither the creator nor the last editor, compared on
 * actor ids. An anonymous actor cannot publish at all: without an identity
 * there is nobody for the rule to be about, and a null id would compare
 * "different" from everybody and quietly disable the check.
 */
async function publishPolicyDraft(ctx, { policyId, body = {}, actor = null } = {}) {
  const current = await loadOwnedPolicy(ctx, policyId);
  assertShape(body, ["expectedRevision"], "a publish");
  const expected = readExpectedRevision(body.expectedRevision);

  if (current.status === STATUS.PUBLISHED) {
    throw fail("IE_ALLOWANCE_POLICY_ALREADY_PUBLISHED", "This allowance policy is already published.",
      { policyId: String(current._id), effectiveFrom: asDay(current.effectiveFrom) });
  }
  if (current.revision !== expected) {
    throw fail("IE_ALLOWANCE_POLICY_REVISION_CONFLICT",
      "Somebody changed this policy while you were reviewing it. Re-read it and decide again.",
      { expected, actual: current.revision, policyId: String(current._id) });
  }

  const publisher = actorId(actor);
  if (!publisher) {
    throw fail("IE_ALLOWANCE_POLICY_MAKER_CHECKER",
      "Publishing an allowance policy has to be attributable to a person.", { policyId: String(current._id) });
  }
  const wrote = [current.createdBy, current.updatedBy].filter(Boolean).map(String);
  if (wrote.includes(String(publisher))) {
    /* Not a missing role — the wrong PERSON. An owner and a platform
       administrator are refused here on exactly the same terms: their grant
       says what they may do, and this rule is about who they are. */
    throw fail("IE_ALLOWANCE_POLICY_MAKER_CHECKER",
      "An allowance policy has to be published by somebody other than the person who wrote it.",
      {
        policyId: String(current._id),
        reason: String(publisher) === String(current.createdBy) ? "PUBLISHER_IS_CREATOR" : "PUBLISHER_IS_LAST_EDITOR",
      });
  }

  const nextRevision = expected + 1;
  const audit = event("ALLOWANCE_POLICY_PUBLISHED", {
    actor,
    policyRevision: nextRevision,
    changed: ["status"],
    summary: `Published, effective ${asDay(current.effectiveFrom)}, ${current.totalAllowancePercent ?? 0}% total`,
  });

  let updated;
  try {
    updated = await IeAllowancePolicy.findOneAndUpdate(
      { _id: current._id, companyId: ctx.companyId, revision: expected, status: STATUS.DRAFT },
      {
        $set: {
          status: STATUS.PUBLISHED,
          publishedBy: publisher,
          publishedByName: actorName(actor),
          publishedAt: new Date(),
        },
        $inc: { revision: 1 },
        $push: { history: { $each: [audit], $slice: -LIMITS.HISTORY } },
      },
      { new: true },
    ).lean();
  } catch (err) {
    if (err?.code !== 11000 && !/E11000|duplicate key/i.test(str(err?.message))) throw err;
    /* The published-effective-date index refused it. Two policies effective the
       same day would make "which rules applied" unanswerable. */
    throw fail("IE_ALLOWANCE_POLICY_EFFECTIVE_DATE_TAKEN",
      `A published allowance policy is already effective from ${asDay(current.effectiveFrom)}. `
      + "Give this one a different effective date.",
      { policyId: String(current._id), effectiveFrom: asDay(current.effectiveFrom), field: "effectiveFrom" });
  }

  if (!updated) {
    const now = await IeAllowancePolicy.findOne({ _id: current._id, companyId: ctx.companyId })
      .select("_id revision status").lean();
    if (!now) throw policyNotFound();
    if (now.status === STATUS.PUBLISHED) {
      throw fail("IE_ALLOWANCE_POLICY_ALREADY_PUBLISHED", "This allowance policy is already published.",
        { policyId: String(now._id) });
    }
    throw fail("IE_ALLOWANCE_POLICY_REVISION_CONFLICT",
      "Somebody changed this policy while you were reviewing it. Re-read it and decide again.",
      { expected, actual: now.revision, policyId: String(now._id) });
  }

  return { policy: publishPolicy(updated, { withHistory: true }), published: true, events: [publishEvent(audit)] };
}

module.exports = {
  STATUS, POLICY_FIELDS, PATCH_FIELDS, CATEGORY_FIELDS, REFUSED_FIELDS,
  publishPolicy, snapshotOf, sameCategories, shapeCategories, readEffectiveFrom, asDay,
  listPolicies, readPolicy, readEffectivePolicy, effectivePolicyDoc,
  createPolicy, updatePolicy, publishPolicyDraft,
};
