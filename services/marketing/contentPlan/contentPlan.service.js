// services/marketing/contentPlan/contentPlan.service.js
//
// THE MARKETING CONTENT PLANNER.
//
// ── IT PLANS; IT DOES NOT PUBLISH ──────────────────────────────────────────
// Nothing here contacts an advertising network, sends an email, schedules a
// post or publishes a page. The only external read is the content library's
// own read-only list, used to confirm that a linked asset exists and to report
// what the library says about it.
//
// ── EVERY WRITE IS ONE FENCED, SINGLE-DOCUMENT OPERATION ───────────────────
// `findOneAndUpdate({ companyId, _id, revision: expected })` sets the change,
// increments the revision and appends the history entry together. A stale edit
// matches nothing and is refused as a conflict; it can never overwrite.
//
// ── NOTHING INTERNAL LEAVES ────────────────────────────────────────────────
// Items are addressed by a random `itemRef`; owners by a signed `ownerRef`; a
// campaign plan by the public identifier the plans screen already uses. No
// database id, membership id, email address or provider name is published.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const { fail } = require("../../storePurchase/errors");
const { MarketingContentPlanItem } = require("../../../models/CMS_Models/Marketing/MarketingContentPlanItem");
const { MarketingCampaignDraft } = require("../../../models/CMS_Models/Marketing/MarketingCampaignDraft");
const SpCompanyMembership = require("../../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const draftIdentity = require("../campaignDrafts/draftIdentity");
const secrets = require("../channels/channelSecrets");
const { assertCalendarDate } = require("../channels/channelDates");
const zoned = require("./zonedTime");
const assets = require("./contentAssets");
const creative = require("./creative");
const C = require("../../../constants/marketingContentPlan");
const { CONTENT_KIND_CODES } = require("../../../constants/marketing");

const str = (v) => String(v ?? "").trim();
const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
const typeName = (v) => (v === null ? "null" : Array.isArray(v) ? "a list" : typeof v);

/* ═══════════════════════════════════════════════════════════════════════════
   WHO
   ═══════════════════════════════════════════════════════════════════════════ */

/* The same people who decide on campaign plans. */
const isApprover = (user) => Boolean(user?.isAdmin) || ["admin", "ceo"].includes(str(user?.role));
const isMarketing = (user) => isApprover(user) || str(user?.role) === "marketing";

function actorFrom(user) {
  const raw = str(user?.id);
  if (!mongoose.Types.ObjectId.isValid(raw)) {
    throw fail("CONTENT_PLAN_ACTOR_UNVERIFIED",
      "GRAV records who changed a content plan, so this needs a signed-in identity it can attribute the change to.");
  }
  if (!isMarketing(user)) {
    throw fail("FORBIDDEN", "The content planner is Marketing's.");
  }
  return { id: new mongoose.Types.ObjectId(raw), name: str(user?.name), role: str(user?.role) };
}

function assertCompany(companyId) {
  const id = str(companyId);
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw fail("TENANT_MEMBERSHIP_UNPROVEN", "A content plan needs a proven company.");
  }
  return new mongoose.Types.ObjectId(id);
}

/* ═══════════════════════════════════════════════════════════════════════════
   OWNERS — COMPANY MEMBERS, BY A SIGNED REFERENCE
   ═══════════════════════════════════════════════════════════════════════════
   A fourth purpose from the same deployment secret the plan identifiers use,
   so a value minted for one contract never verifies under another. The
   reference is an HMAC of the company and membership: it carries no id and
   cannot be forged or moved between companies. */
const OWNER_PURPOSE = "grav.marketing.content-plan.owner.v1";

function ownerKey(env) {
  const secret = secrets.campaignIdSecret(env);
  if (!secret) return null;
  return crypto.createHmac("sha256", secret).update(OWNER_PURPOSE).digest();
}

function ownerRefFor(key, companyId, membershipId) {
  const mac = crypto.createHmac("sha256", key).update(`${companyId}.${membershipId}`).digest();
  return `own_${mac.subarray(0, 18).toString("base64url")}`;
}

async function companyMembers(company) {
  return SpCompanyMembership.find({ companyId: company, isActive: true })
    .select("personName email employeeRef")
    .sort({ personName: 1, _id: 1 })
    .lean();
}

const isYou = (owner, user) => {
  if (!owner || !user) return false;
  const email = str(user.email).toLowerCase();
  if (email && str(owner.email) === email) return true;
  return Boolean(owner.employeeRef) && String(owner.employeeRef) === str(user.id);
};

const ownerFromMembership = (m) => ({
  membershipId: m._id,
  name: str(m.personName) || str(m.email).split("@")[0] || "",
  email: str(m.email).toLowerCase(),
  employeeRef: m.employeeRef || null,
});

/** The owner a write names, or null to clear it. */
async function resolveOwner(company, raw, user, env) {
  if (raw === null) return null;
  const ref = str(raw);
  if (!ref) {
    throw fail("VALIDATION", "ownerRef must be \"self\", an owner reference from the owners list, or null.", { field: "ownerRef" });
  }
  const members = await companyMembers(company);

  if (ref === "self") {
    const me = members.find((m) => isYou(ownerFromMembership(m), user));
    if (!me) {
      throw fail("CONTENT_PLAN_LINK_NOT_FOUND",
        "GRAV cannot find you among this company's members, so it cannot make you the owner. Choose somebody from the owners list.",
        { field: "ownerRef" });
    }
    return ownerFromMembership(me);
  }

  const key = ownerKey(env);
  const match = key ? members.find((m) => ownerRefFor(key, String(company), String(m._id)) === ref) : null;
  if (!match) {
    throw fail("CONTENT_PLAN_LINK_NOT_FOUND", "That owner is not a member of this company.", { field: "ownerRef" });
  }
  return ownerFromMembership(match);
}

/** GET /content-plan/owners — who an item can be assigned to. */
async function owners({ companyId, user, env = process.env } = {}) {
  const company = assertCompany(companyId);
  const members = await companyMembers(company);
  const key = ownerKey(env);
  return {
    /* Assigning somebody else needs a reference this deployment can sign.
       "self" works regardless. */
    assignable: Boolean(key),
    owners: key
      ? members.map((m) => {
        const o = ownerFromMembership(m);
        return { ownerRef: ownerRefFor(key, String(company), String(m._id)), name: o.name, isYou: isYou(o, user) };
      })
      : [],
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   INPUT
   ═══════════════════════════════════════════════════════════════════════════ */

function assertText(value, field, max, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw fail("VALIDATION", `${field} is required.`, { field });
    return "";
  }
  if (typeof value !== "string") {
    throw fail("VALIDATION", `${field} must be text, not ${typeName(value)}.`, { field });
  }
  const v = value.trim();
  if (required && !v) throw fail("VALIDATION", `${field} cannot be empty.`, { field });
  if (v.length > max) throw fail("VALIDATION", `${field} may be at most ${max} characters.`, { field, max });
  /* Plain text. Markup belongs in the content library, not in a plan. */
  if (/<\s*\/?\s*[a-z!][^>]*>/i.test(v)) {
    throw fail("VALIDATION", `${field} is plain text. Markup belongs in the content itself.`, { field });
  }
  return v;
}

function assertEnum(value, allowed, field) {
  const v = typeof value === "string" ? value.trim() : value;
  if (typeof v !== "string" || !allowed.includes(v)) {
    throw fail("VALIDATION", `${field} must be one of: ${allowed.join(", ")}.`, { field, allowed });
  }
  return v;
}

function assertPlanned(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw fail("VALIDATION", "planned must be an object with date, timeZone and an optional time, or null.", { field: "planned" });
  }
  const extra = Object.keys(value).filter((k) => !["date", "time", "timeZone"].includes(k));
  if (extra.length) {
    throw fail("VALIDATION", `planned accepts date, time and timeZone. ${extra.join(", ")} is not part of it.`,
      { field: "planned", unknown: extra });
  }
  const date = assertCalendarDate(value.date, "planned.date");
  const year = Number(date.slice(0, 4));
  if (year < C.LIMITS.YEAR_MIN || year > C.LIMITS.YEAR_MAX) {
    throw fail("VALIDATION", `planned.date must fall between ${C.LIMITS.YEAR_MIN} and ${C.LIMITS.YEAR_MAX}.`, { field: "planned.date" });
  }
  const timeZone = zoned.assertTimeZone(value.timeZone, "planned.timeZone");
  const allDay = value.time === undefined || value.time === null || value.time === "";
  const time = allDay ? null : zoned.assertTime(value.time, "planned.time");
  const startsAt = allDay ? zoned.startOfDay(date, timeZone) : zoned.toInstant(date, time, timeZone);
  return { date, time, timeZone, allDay, startsAt };
}

function assertAssetInput(value, contentType) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw fail("VALIDATION", "assetLink must be an object with a kind and a contentId, or null.", { field: "assetLink" });
  }
  const extra = Object.keys(value).filter((k) => !["kind", "contentId"].includes(k));
  if (extra.length) {
    throw fail("VALIDATION", `assetLink accepts kind and contentId. ${extra.join(", ")} is not part of it.`,
      { field: "assetLink", unknown: extra });
  }
  const kind = assertEnum(value.kind, CONTENT_KIND_CODES, "assetLink.kind");
  const contentId = typeof value.contentId === "string" ? value.contentId.trim() : "";
  if (!C.LIMITS.CONTENT_ID_PATTERN.test(contentId)) {
    throw fail("VALIDATION", "assetLink.contentId is the identifier the content library lists. It is not a URL or a path.",
      { field: "assetLink.contentId" });
  }
  const type = C.CONTENT_TYPES.find((t) => t.code === contentType);
  if (type?.libraryKind && type.libraryKind !== kind) {
    throw fail("VALIDATION", `A ${type.label.toLowerCase()} can only be linked to a ${type.label.toLowerCase()} in the content library.`,
      { field: "assetLink.kind" });
  }
  return { kind, contentId };
}

/** The linked asset, confirmed against the library — or a refusal. */
async function confirmAsset(company, link, { contentClient, env }) {
  const view = await assets.resolve({ companyId: company, refs: [link], client: contentClient, env });
  const hit = view.lookup(link.kind, link.contentId);
  if (hit.status === "found") {
    return {
      kind: link.kind,
      contentId: link.contentId,
      capturedName: str(hit.row.name).slice(0, C.LIMITS.CAPTURED_NAME_MAX),
      confirmedAt: new Date(),
    };
  }
  if (hit.status === "missing") {
    throw fail("CONTENT_PLAN_LINK_NOT_FOUND", "That content is not in the content library.", { field: "assetLink" });
  }
  throw fail("CONTENT_PLAN_LINK_UNCONFIRMED",
    hit.status === "not_configured"
      ? "This company has no content library to link to. Save the item without a linked asset."
      : "The content library cannot be read right now, so GRAV cannot confirm that content exists. Nothing was saved. Try again, or save without the link.",
    { field: "assetLink" });
}

const LINKABLE_PLAN_STATES = ["draft", "awaiting_approval", "returned", "approved"];

/** The linked campaign plan, from its public identifier — or a refusal. */
async function resolveCampaign(company, raw, env) {
  if (raw === null) return null;
  const token = typeof raw === "string" ? raw.trim() : "";
  const refuse = () => fail("CONTENT_PLAN_LINK_NOT_FOUND", "That campaign plan is not one GRAV can find for this company.",
    { field: "campaignDraftId" });
  if (!token) throw refuse();
  let draftId;
  try {
    ({ draftId } = draftIdentity.decodeDraftId(token, { companyId: String(company) }, env));
  } catch (_) {
    throw refuse();
  }
  const plan = await MarketingCampaignDraft.findOne({ _id: draftId, companyId: company })
    .select("draftRef name state").lean();
  if (!plan) throw refuse();
  if (!LINKABLE_PLAN_STATES.includes(plan.state)) {
    throw fail("CONTENT_PLAN_LINK_NOT_FOUND", "That campaign plan was cancelled or rejected, so content cannot be planned under it.",
      { field: "campaignDraftId" });
  }
  return { draftId: plan._id, draftRef: plan.draftRef, capturedName: str(plan.name) };
}

/* The fields a write may carry, and how each is read. */
const WRITABLE = ["title", "contentType", "channel", "brief", "notes", "campaignDraftId", "ownerRef", "planned", "assetLink", "creative"];

function assertKeys(payload, allowed, what) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw fail("VALIDATION", `${what} must be a JSON object.`);
  }
  const unknown = Object.keys(payload).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    throw fail("VALIDATION", `${what} accepts ${allowed.join(", ")}. ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not part of it.`,
      { unknown });
  }
}

function assertExpectedRevision(payload) {
  if (!has(payload, "expectedRevision")) {
    throw fail("VALIDATION", "Say which version you are changing (expectedRevision), so GRAV can refuse a change built on one somebody has replaced.",
      { field: "expectedRevision" });
  }
  const raw = payload.expectedRevision;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw fail("VALIDATION", `expectedRevision must be a whole number, not ${typeName(raw)}.`, { field: "expectedRevision" });
  }
  return raw;
}

const conflict = (current, sent) => fail("CONTENT_PLAN_REVISION_CONFLICT",
  "Somebody changed this item since you opened it. Reload it and re-apply your change.",
  { field: "expectedRevision", currentRevision: current, sentRevision: sent });

/* ═══════════════════════════════════════════════════════════════════════════
   READ MODEL
   ═══════════════════════════════════════════════════════════════════════════ */

const label = (list, code) => {
  const hit = list.find((x) => x.code === code);
  return hit ? { code: hit.code, label: hit.label } : { code, label: code };
};

async function campaignsFor(company, items, env) {
  const ids = [...new Set(items.filter((i) => i.campaign).map((i) => String(i.campaign.draftId)))];
  const rows = ids.length
    ? await MarketingCampaignDraft.find({ companyId: company, _id: { $in: ids } }).select("draftRef name state").lean()
    : [];
  const byId = new Map(rows.map((r) => [String(r._id), r]));
  return (item) => {
    if (!item.campaign) return null;
    const plan = byId.get(String(item.campaign.draftId));
    if (!plan) {
      return {
        link: "campaign_missing", campaignDraftId: null,
        reference: item.campaign.draftRef, name: item.campaign.capturedName, state: null,
      };
    }
    let signed = null;
    try {
      signed = draftIdentity.encodeDraftId({ companyId: String(company), draftId: String(plan._id) }, env);
    } catch (_) {
      signed = null;
    }
    return { link: "linked", campaignDraftId: signed, reference: plan.draftRef, name: str(plan.name), state: plan.state };
  };
}

function publicationOf(item, library, now) {
  const none = { scheduledAt: null, publishedAt: null, source: null, checkedAt: null };
  if (!item.asset) return { publication: "no_linked_asset", actual: none };
  const hit = library.lookup(item.asset.kind, item.asset.contentId);
  if (hit.status === "missing") return { publication: "asset_missing", actual: none };
  if (hit.status !== "found") return { publication: "unavailable", actual: none };

  const row = hit.row;
  const up = row.publishUp ? new Date(row.publishUp) : null;
  const down = row.publishDown ? new Date(row.publishDown) : null;
  /* The library's flag alone is not "published": a flagged asset whose
     publish-from date is still ahead has not appeared, and one whose
     publish-until date has passed has stopped appearing. */
  let publication = row.publicationState === "published" ? "published"
    : row.publicationState === "unpublished" ? "not_published" : "unknown";
  if (publication === "published" && up && up > now) publication = "scheduled";
  if (publication === "published" && down && down <= now) publication = "not_published";
  return {
    publication,
    actual: {
      /* The library's own publish-from date, when it reports one. Planned dates
         never appear here. */
      scheduledAt: publication === "scheduled" ? up.toISOString() : null,
      publishedAt: publication === "published" && up && up <= now ? up.toISOString() : null,
      source: "content_library",
      checkedAt: library.measuredAt,
    },
  };
}

const PUBLICATION_BY_CODE = Object.fromEntries(C.PUBLICATION.map((p) => [p.code, p]));

function viewerActionsFor(item, user, { unavailable = null } = {}) {
  const out = {};
  const editable = C.EDITABLE[item.state];
  out.edit = {
    allowed: editable !== "none" && isMarketing(user),
    fields: editable === "all" ? [...WRITABLE] : editable === "notes" ? ["notes"] : [],
    reason: editable === "none" ? "not_in_this_state" : null,
  };
  for (const a of C.ACTIONS) {
    let reason = null;
    if (!a.from.includes(item.state)) reason = "not_in_this_state";
    else if (a.actor === "approver" && !isApprover(user)) reason = "approver_only";
    else if (a.actor === "marketing" && !isMarketing(user)) reason = "marketing_only";
    else if (a.code === "approve" && selfApproval(item, user)) reason = "own_submission";
    else if (a.code === "submit" && missingForSubmission(item).length) reason = "incomplete";
    /* Known only where file states were read (detail and write responses).
       The command checks it regardless. */
    else if ((a.code === "submit" || a.code === "approve") && unavailable && unavailable.length) reason = "media_unavailable";
    out[a.code] = { allowed: reason === null, reason, reasonRequired: a.reason === "required" };
  }
  return out;
}

function missingForSubmission(item) {
  const missing = [];
  if (!str(item.brief)) missing.push("brief");
  if (!item.owner) missing.push("owner");
  if (!item.planned) missing.push("planned");
  if (C.CREATIVE_TYPES.includes(item.contentType) && creative.incomplete(item.creative)) missing.push("creative");
  return missing;
}

function selfApproval(item, user) {
  const by = item.submittedBy;
  if (!by || !by.id) return "SUBMITTER_UNKNOWN";
  return String(by.id) === str(user?.id) ? "SELF_APPROVAL" : null;
}

function plannedView(p, viewerTz) {
  if (!p) return null;
  const local = viewerTz && !p.allDay ? zoned.localOf(new Date(p.startsAt).getTime(), viewerTz) : null;
  return {
    date: p.date,
    time: p.time,
    timeZone: p.timeZone,
    allDay: p.allDay,
    startsAt: new Date(p.startsAt).toISOString(),
    /* Where it falls for the person looking, in their zone. An all-day item
       keeps its own date: a day is a day wherever it is read. */
    ...(viewerTz ? {
      display: p.allDay
        ? { date: p.date, time: null, timeZone: viewerTz }
        : { date: local.date, time: local.time, timeZone: viewerTz },
    } : {}),
  };
}

const NO_STATES = Object.freeze({ images: new Map(), media: { found: new Map(), latestBy: new Map() } });

/* ── THE ONE DECISION ABOUT WHETHER AN APPROVAL STILL STANDS ───────────────
   Used by the calendar, the list and the detail read alike, so no two screens
   can disagree. It never changes the item's recorded state: `approved` stays
   the fact that somebody approved it; this says whether what they approved is
   still what exists. */
const APPROVAL_STATUS_BY_CODE = Object.fromEntries(C.APPROVAL_STATUS.map((a) => [a.code, a]));
const APPROVAL_REASON_BY_CODE = Object.fromEntries(C.APPROVAL_INVALID_REASONS.map((a) => [a.code, a]));

function approvalDecision(item, states) {
  const unavailable = creative.unavailableMedia(item.creative, states || NO_STATES);
  if (!item.approvedRevision) return { code: "not_approved", unavailable, reasons: [], matches: null };
  const matches = (item.approvedCreativeFingerprint || "") === creative.fingerprint(item.creative);
  const any = (status) => unavailable.some((u) => u.status === status);
  const reasons = [
    ...(matches ? [] : ["creative_changed"]),
    ...(any("withdrawn") ? ["media_withdrawn"] : []),
    ...(any("missing") ? ["media_missing"] : []),
    ...(any("changed") ? ["media_changed"] : []),
  ];
  return { code: reasons.length ? "invalid" : "valid", unavailable, reasons, matches };
}

/* Safe for any row: codes and words, no file names, references or hashes. */
function approvalStatusView(decision) {
  const spec = APPROVAL_STATUS_BY_CODE[decision.code];
  return {
    code: spec.code,
    label: spec.label,
    means: spec.means,
    invalidBecause: decision.reasons.map((r) => ({ code: r, label: APPROVAL_REASON_BY_CODE[r].label })),
  };
}

/** One item as a screen may show it. */

function present(item, { user, campaignOf, library, now, viewerTz = null, full = false, company = null, referenceStates = null, env = process.env }) {
  const { publication, actual } = publicationOf(item, library, now);
  const decision = approvalDecision(item, referenceStates);
  const pub = PUBLICATION_BY_CODE[publication];
  const assetView = item.asset
    ? { kind: label(C.CONTENT_TYPES, item.asset.kind), name: item.asset.capturedName, nameIsSnapshot: true }
    : null;
  const view = {
    itemRef: item.itemRef,
    revision: item.revision,
    title: item.title,
    contentType: label(C.CONTENT_TYPES, item.contentType),
    channel: label(C.CHANNELS, item.channel),
    state: { ...label(C.STATES, item.state), means: C.STATE_BY_CODE[item.state]?.means || "" },
    planned: plannedView(item.planned, viewerTz),
    owner: item.owner ? { name: item.owner.name, isYou: isYou(item.owner, user) } : null,
    campaign: campaignOf(item),
    asset: assetView,
    creative: creative.summary(item.creative),
    /* `state` is what was recorded; this is whether an approval still
       stands. An approved item whose file was withdrawn is both. */
    approvalStatus: approvalStatusView(decision),
    unavailableMediaCount: decision.unavailable.length,
    publication: { code: pub.code, label: pub.label, means: pub.means },
    actual,
    viewerActions: viewerActionsFor(item, user, { unavailable: decision.unavailable }),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
  if (!full) return view;
  const states = referenceStates || NO_STATES;
  const unavailable = decision.unavailable;
  return {
    ...view,
    brief: item.brief,
    notes: item.notes,
    creative: creative.present(item.creative, { company, states, env }),
    /* Files the creative names that can no longer be shown. */
    unavailableMedia: unavailable,
    submission: {
      missing: missingForSubmission(item),
      submittedAt: item.submittedAt || null,
      submittedBy: item.submittedBy ? item.submittedBy.name : null,
      approvedAt: item.approvedAt || null,
      approvedBy: item.approvedBy ? item.approvedBy.name : null,
    },
    /* Exactly what was approved: the revision the approver was looking at and
       the fingerprint of the creative at that revision. */
    approval: item.approvedRevision
      ? {
        revision: item.approvedRevision,
        creativeFingerprint: item.approvedCreativeFingerprint || "",
        matchesCurrentCreative: decision.matches,
        /* An approval is of what the approver could see. If a file it
           included has since been withdrawn, has gone or has changed in
           storage, that is no longer what anybody sees, and the approval no
           longer stands. The same decision the list and calendar publish. */
        mediaIntact: unavailable.length === 0,
        valid: decision.code === "valid",
        invalidBecause: decision.reasons,
      }
      : null,
    history: (item.history || []).map((h) => ({
      revision: h.revision,
      action: h.action,
      fromState: h.fromState,
      toState: h.toState,
      changedFields: h.changedFields,
      reason: h.reason,
      by: h.actor?.name || "",
      at: h.at,
      creativeFingerprint: h.creativeFingerprint || "",
    })),
  };
}

async function readContext(company, items, { contentClient, env, now }) {
  const [campaignOf, library, referenceStates] = await Promise.all([
    campaignsFor(company, items, env),
    assets.resolve({
      companyId: company, refs: items.filter((i) => i.asset).map((i) => i.asset), client: contentClient, env, now,
    }),
    /* One batch for the whole page, so every row carries the same approval
       decision the detail read makes. */
    creative.referenceStates(company, items.map((i) => i.creative)),
  ]);
  return { campaignOf, library, referenceStates };
}

const libraryView = (library) => {
  const spec = C.CONTENT_LIBRARY.find((c) => c.code === library.library);
  return { code: spec.code, label: spec.label, means: spec.means, checkedAt: library.measuredAt };
};

function permissionsFor(user) {
  return {
    canCreate: isMarketing(user),
    canApprove: isApprover(user),
    approvalRule: "Administrators and the CEO approve content plan items. Nobody approves an item they submitted.",
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   WRITES
   ═══════════════════════════════════════════════════════════════════════════ */

const itemRefNew = () => `MCI-${crypto.randomBytes(9).toString("hex")}`;

const fingerprint = (payload) => crypto.createHash("sha256")
  .update(JSON.stringify(Object.keys(payload).sort().map((k) => [k, payload[k]])))
  .digest("hex");

async function loadItem(company, itemRef) {
  const ref = str(itemRef);
  if (!/^MCI-[0-9a-f]{18}$/.test(ref)) throw fail("CONTENT_PLAN_ITEM_NOT_FOUND", "That content plan item is not one GRAV can show you.");
  const item = await MarketingContentPlanItem.findOne({ companyId: company, itemRef: ref }).lean();
  if (!item) throw fail("CONTENT_PLAN_ITEM_NOT_FOUND", "That content plan item is not one GRAV can show you.");
  return item;
}

/** Read every writable field in `payload` into stored values. */
async function readFields(company, payload, { user, contentType, env, contentClient, existingCreative = null }) {
  const set = {};
  if (has(payload, "title")) set.title = assertText(payload.title, "title", C.LIMITS.TITLE_MAX, { required: true });
  if (has(payload, "contentType")) set.contentType = assertEnum(payload.contentType, C.CONTENT_TYPE_CODES, "contentType");
  if (has(payload, "channel")) set.channel = assertEnum(payload.channel, C.CHANNEL_CODES, "channel");
  if (has(payload, "brief")) set.brief = assertText(payload.brief, "brief", C.LIMITS.BRIEF_MAX);
  if (has(payload, "notes")) set.notes = assertText(payload.notes, "notes", C.LIMITS.NOTES_MAX);
  if (has(payload, "planned")) set.planned = assertPlanned(payload.planned);
  const effectiveType = set.contentType || contentType;
  let assetInput;
  if (has(payload, "assetLink")) assetInput = assertAssetInput(payload.assetLink, effectiveType);
  /* Every local check passes before anything is looked up. */
  if (has(payload, "campaignDraftId")) set.campaign = await resolveCampaign(company, payload.campaignDraftId, env);
  if (has(payload, "ownerRef")) set.owner = await resolveOwner(company, payload.ownerRef, user, env);
  if (assetInput !== undefined) set.asset = assetInput ? await confirmAsset(company, assetInput, { contentClient, env }) : null;
  if (has(payload, "creative")) set.creative = await creative.read(company, payload.creative, { existing: existingCreative, env });
  return set;
}

/**
 * Create one item, as an idea.
 */
async function create({ companyId, user, payload = {}, contentClient = null, env = process.env, now = new Date() } = {}) {
  const company = assertCompany(companyId);
  const actor = actorFrom(user);
  assertKeys(payload, ["idempotencyKey", ...WRITABLE], "A new content plan item");

  const key = typeof payload.idempotencyKey === "string" ? payload.idempotencyKey.trim() : "";
  if (!C.LIMITS.IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw fail("VALIDATION", "idempotencyKey is required: 8 to 120 letters, digits or . _ : -, generated once per new item.",
      { field: "idempotencyKey" });
  }
  for (const f of ["title", "contentType", "channel"]) {
    if (!has(payload, f)) throw fail("VALIDATION", `${f} is required.`, { field: f });
  }
  const print = fingerprint(Object.fromEntries(WRITABLE.filter((f) => has(payload, f)).map((f) => [f, payload[f]])));

  const replay = async () => {
    const prior = await MarketingContentPlanItem.findOne({ companyId: company, idempotencyKey: key }).lean();
    if (!prior) return null;
    if (prior.createFingerprint !== print) {
      throw fail("CONTENT_PLAN_KEY_REUSED",
        "That idempotencyKey was already used for a different item. Generate a new key for a new item.",
        { field: "idempotencyKey" });
    }
    return prior;
  };

  const existing = await replay();
  if (existing) return { item: existing, duplicate: true };

  const set = await readFields(company, payload, { user, contentType: null, env, contentClient });
  const changedFields = WRITABLE.filter((f) => has(payload, f));

  try {
    const doc = await MarketingContentPlanItem.create({
      companyId: company,
      itemRef: itemRefNew(),
      idempotencyKey: key,
      createFingerprint: print,
      revision: 1,
      state: "idea",
      title: set.title,
      contentType: set.contentType,
      channel: set.channel,
      brief: set.brief || "",
      notes: set.notes || "",
      planned: set.planned || null,
      owner: set.owner || null,
      campaign: set.campaign || null,
      asset: set.asset || null,
      creative: set.creative || null,
      createdBy: actor,
      history: [{
        revision: 1, action: "created", fromState: null, toState: "idea", changedFields, reason: "", actor, at: now,
        creativeFingerprint: creative.fingerprint(set.creative || null),
      }],
    });
    return { item: doc.toObject(), duplicate: false };
  } catch (err) {
    /* Two creates racing on one key: the loser returns the winner's item. */
    if (err?.code === 11000) {
      const prior = await replay();
      if (prior) return { item: prior, duplicate: true };
    }
    throw err;
  }
}

/** The fields whose stored value would actually change. */
function diff(item, set) {
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const normal = (field, v) => {
    if (v && field === "planned") return { ...v, startsAt: new Date(v.startsAt).toISOString() };
    if (v && field === "asset") return { kind: v.kind, contentId: v.contentId };
    if (v && field === "owner") return String(v.membershipId);
    if (v && field === "campaign") return String(v.draftId);
    if (field === "creative") return creative.fingerprint(v || null);
    return v;
  };
  return Object.keys(set).filter((f) => !same(normal(f, item[f]), normal(f, set[f])));
}

const PUBLIC_FIELD = { campaign: "campaignDraftId", owner: "ownerRef", asset: "assetLink" };

async function fencedWrite(company, item, expected, { set, entry }) {
  const updated = await MarketingContentPlanItem.findOneAndUpdate(
    { companyId: company, _id: item._id, revision: expected },
    { $set: set, $inc: { revision: 1 }, $push: { history: entry } },
    { new: true, runValidators: true },
  ).lean();
  if (!updated) {
    const current = await MarketingContentPlanItem.findOne({ companyId: company, _id: item._id }).select("revision").lean();
    throw conflict(current?.revision ?? null, expected);
  }
  return updated;
}

/**
 * Edit an item. Only the fields sent are touched; `null` clears an optional one.
 */
async function update({ companyId, user, itemRef, payload = {}, contentClient = null, env = process.env, now = new Date() } = {}) {
  const company = assertCompany(companyId);
  const actor = actorFrom(user);
  assertKeys(payload, ["expectedRevision", ...WRITABLE], "An edit");
  const expected = assertExpectedRevision(payload);
  const fields = WRITABLE.filter((f) => has(payload, f));
  if (!fields.length) throw fail("VALIDATION", "Send at least one field to change.", { accepted: WRITABLE });

  const item = await loadItem(company, itemRef);
  if (item.revision !== expected) throw conflict(item.revision, expected);

  const editable = C.EDITABLE[item.state];
  const blocked = editable === "all" ? [] : editable === "notes" ? fields.filter((f) => f !== "notes") : fields;
  if (blocked.length) {
    throw fail("CONTENT_PLAN_STATE_CONFLICT",
      editable === "notes"
        ? `A ${C.STATE_BY_CODE[item.state].label.toLowerCase()} item is frozen except for its notes. ${item.state === "approved" ? "Reopen it" : "Withdraw it or have it returned"} to change anything else.`
        : "A cancelled item cannot be changed.",
      { state: item.state, blockedFields: blocked });
  }
  if (C.LIMITS.HISTORY_MAX <= (item.history || []).length) {
    throw fail("CONTENT_PLAN_STATE_CONFLICT", "This item has reached the limit of recorded changes.", { state: item.state });
  }

  const set = await readFields(company, payload, {
    user, contentType: item.contentType, env, contentClient, existingCreative: item.creative,
  });

  /* Changing the type can break an existing asset link it no longer matches. */
  const type = C.CONTENT_TYPES.find((t) => t.code === (set.contentType || item.contentType));
  const asset = has(set, "asset") ? set.asset : item.asset;
  if (asset && type?.libraryKind && type.libraryKind !== asset.kind) {
    throw fail("VALIDATION", `A ${type.label.toLowerCase()} can only be linked to a ${type.label.toLowerCase()} in the content library. Change or clear the linked asset too.`,
      { field: "assetLink.kind" });
  }

  const changed = diff(item, set);
  if (!changed.length) return { item, unchanged: true };

  const $set = Object.fromEntries(changed.map((f) => [f, set[f]]));
  const updated = await fencedWrite(company, item, expected, {
    set: $set,
    entry: {
      revision: expected + 1, action: "edited", fromState: item.state, toState: item.state,
      changedFields: changed.map((f) => PUBLIC_FIELD[f] || f), reason: "", actor, at: now,
      creativeFingerprint: creative.fingerprint(has($set, "creative") ? $set.creative : item.creative),
    },
  });
  return { item: updated, unchanged: false };
}

/**
 * Move an item through its workflow.
 */
async function act({ companyId, user, itemRef, payload = {}, now = new Date() } = {}) {
  const company = assertCompany(companyId);
  const actor = actorFrom(user);
  assertKeys(payload, ["expectedRevision", "action", "reason", "creativeFingerprint"], "A workflow action");
  const expected = assertExpectedRevision(payload);
  const code = assertEnum(payload.action, C.ACTION_CODES, "action");
  const rule = C.ACTION_BY_CODE[code];
  const reason = assertText(payload.reason, "reason", C.LIMITS.REASON_MAX);

  const item = await loadItem(company, itemRef);

  /* ── THE SAME REQUEST, AGAIN ─────────────────────────────────────────────
     A retried click after a lost response finds its own action already applied
     at exactly the next revision, by the same person. Reported, not refused. */
  const last = (item.history || [])[item.history.length - 1];
  if (item.revision === expected + 1 && last && last.action === code && String(last.actor?.id) === String(actor.id)) {
    return { item, duplicate: true };
  }
  if (item.revision !== expected) throw conflict(item.revision, expected);

  if (!rule.from.includes(item.state)) {
    const available = C.ACTIONS.filter((a) => a.from.includes(item.state)).map((a) => a.code);
    throw fail("CONTENT_PLAN_STATE_CONFLICT",
      available.length
        ? `A ${C.STATE_BY_CODE[item.state].label.toLowerCase()} item cannot be acted on with "${code}". What it can be: ${available.join(", ")}.`
        : "This item is cancelled and nothing further can be done to it.",
      { state: item.state, attempted: code, availableActions: available });
  }
  if (rule.actor === "approver" && !isApprover(user)) {
    throw fail("CONTENT_PLAN_DECISION_FORBIDDEN",
      "Approving, returning or cancelling approved content is for an administrator or the CEO. Marketing drafts and submits.",
      { attempted: code });
  }
  if (rule.reason === "required" && !reason) {
    throw fail("VALIDATION", `Say why. "${rule.label}" needs a reason, and it is the only record of the decision.`, { field: "reason" });
  }
  if (code === "submit") {
    const missing = missingForSubmission(item);
    if (missing.length) {
      throw fail("CONTENT_PLAN_STATE_CONFLICT", `This item is not ready for approval. It needs: ${missing.join(", ")}.`,
        { state: item.state, attempted: code, missing });
    }
  }
  const currentFingerprint = creative.fingerprint(item.creative);
  if (has(payload, "creativeFingerprint")) {
    if (code !== "approve") {
      throw fail("VALIDATION", "creativeFingerprint is only sent with an approval.", { field: "creativeFingerprint" });
    }
    /* The approver says which creative they read. If it is not the one on the
       item, they read something else — refused, whatever the revision says. */
    if (typeof payload.creativeFingerprint !== "string" || payload.creativeFingerprint !== currentFingerprint) {
      throw fail("CONTENT_PLAN_REVISION_CONFLICT",
        "The creative you reviewed is not the one on this item now. Reload it and review again.",
        { field: "creativeFingerprint", currentRevision: item.revision, sentRevision: expected });
    }
  }
  /* ── NOBODY SUBMITS OR APPROVES A CREATIVE THAT CANNOT BE SEEN ────────── */
  if (code === "submit" || code === "approve") {
    const states = await creative.referenceStates(company, [item.creative]);
    const unavailable = creative.unavailableMedia(item.creative, states);
    if (unavailable.length) {
      throw fail("CONTENT_PLAN_STATE_CONFLICT",
        "This creative names a file that has been withdrawn or is gone, so nobody can see what would be approved. Replace it with an available file first.",
        { state: item.state, attempted: code, unavailableMedia: unavailable });
    }
  }
  if (code === "approve") {
    const problem = selfApproval(item, user);
    if (problem) {
      throw fail("CONTENT_PLAN_DECISION_FORBIDDEN",
        problem === "SELF_APPROVAL"
          ? "You submitted this item, so approving it needs somebody else. You can still return it."
          : "GRAV cannot confirm who submitted this item, so it cannot confirm somebody else is approving it. It can still be returned.",
        { attempted: code });
    }
  }

  const set = { state: rule.to };
  if (code === "submit") Object.assign(set, { submittedBy: actor, submittedAt: now });
  if (code === "approve") {
    Object.assign(set, {
      approvedBy: actor, approvedAt: now,
      approvedRevision: expected, approvedCreativeFingerprint: currentFingerprint,
    });
  }
  if (code === "reopen" || code === "cancel_approved") {
    Object.assign(set, { approvedBy: null, approvedAt: null, approvedRevision: null, approvedCreativeFingerprint: "" });
  }

  const updated = await fencedWrite(company, item, expected, {
    set,
    entry: {
      revision: expected + 1, action: code, fromState: item.state, toState: rule.to,
      changedFields: ["state"], reason, actor, at: now, creativeFingerprint: currentFingerprint,
    },
  });
  return { item: updated, duplicate: false };
}

/* ═══════════════════════════════════════════════════════════════════════════
   READS
   ═══════════════════════════════════════════════════════════════════════════ */

const LIST_PARAMS = ["page", "limit", "state", "channel", "contentType", "campaign", "owner", "dated"];
const CALENDAR_PARAMS = ["from", "to", "timeZone", "state", "channel", "contentType", "campaign", "owner"];

function refuseUnknown(query, allowed, what) {
  const unknown = Object.keys(query || {}).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    throw fail("VALIDATION", `${what} accepts ${allowed.join(", ")}.`, { unknown });
  }
}

function optionalEnum(value, allowed, field) {
  const v = str(value);
  if (!v) return null;
  return assertEnum(v, allowed, field);
}

async function commonFilter(company, query, user) {
  const match = { companyId: company };
  const state = optionalEnum(query.state, C.STATE_CODES, "state");
  if (state) match.state = state;
  const channel = optionalEnum(query.channel, C.CHANNEL_CODES, "channel");
  if (channel) match.channel = channel;
  const contentType = optionalEnum(query.contentType, C.CONTENT_TYPE_CODES, "contentType");
  if (contentType) match.contentType = contentType;
  const campaign = str(query.campaign);
  if (campaign) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(campaign)) {
      throw fail("VALIDATION", "campaign must be a campaign plan reference.", { field: "campaign" });
    }
    match["campaign.draftRef"] = campaign;
  }
  const owner = optionalEnum(query.owner, ["mine", "unassigned"], "owner");
  if (owner === "unassigned") match.owner = null;
  if (owner === "mine") {
    const email = str(user?.email).toLowerCase();
    const or = [];
    if (email) or.push({ "owner.email": email });
    if (mongoose.Types.ObjectId.isValid(str(user?.id))) or.push({ "owner.employeeRef": new mongoose.Types.ObjectId(str(user.id)) });
    match.$or = or.length ? or : [{ _id: null }];
  }
  return { match, filters: { state, channel, contentType, campaign: campaign || null, owner } };
}

function pageNumber(raw, field, max, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = /^\d+$/.test(str(raw)) ? Number(str(raw)) : NaN;
  if (!Number.isInteger(n) || n < 1 || (max && n > max)) {
    throw fail("VALIDATION", max ? `${field} must be a whole number between 1 and ${max}.` : `${field} must be a whole number of 1 or more.`, { field });
  }
  return n;
}

/** GET /content-plan/items — every item, dated or not, one page at a time. */
async function list({ companyId, user, query = {}, contentClient = null, env = process.env, now = new Date() } = {}) {
  const company = assertCompany(companyId);
  refuseUnknown(query, LIST_PARAMS, "The content plan list");
  const page = pageNumber(query.page, "page", null, 1);
  const limit = pageNumber(query.limit, "limit", C.LIMITS.PAGE_MAX, C.LIMITS.PAGE_DEFAULT);
  const { match, filters } = await commonFilter(company, query, user);
  const dated = optionalEnum(query.dated, ["planned", "unplanned"], "dated");
  if (dated === "planned") match.planned = { $ne: null };
  if (dated === "unplanned") match.planned = null;

  const [out] = await MarketingContentPlanItem.aggregate([
    { $match: match },
    { $project: { history: 0 } },
    { $addFields: { __undated: { $cond: [{ $eq: [{ $ifNull: ["$planned", null] }, null] }, 1, 0] } } },
    { $sort: { __undated: 1, "planned.startsAt": 1, createdAt: 1, _id: 1 } },
    { $facet: { rows: [{ $skip: (page - 1) * limit }, { $limit: limit }], total: [{ $count: "n" }] } },
  ]);
  const rows = out?.rows || [];
  const total = out?.total?.[0]?.n || 0;
  const ctx = await readContext(company, rows, { contentClient, env, now });

  return {
    items: rows.map((i) => present(i, { user, ...ctx, now })),
    page: { number: page, size: limit, total, pages: Math.ceil(total / limit) },
    filters: { ...filters, dated },
    contentLibrary: libraryView(ctx.library),
    permissions: permissionsFor(user),
  };
}

/** GET /content-plan/items/:itemRef — one item, with its brief, notes and history. */
async function detail({ companyId, user, itemRef, contentClient = null, env = process.env, now = new Date() } = {}) {
  const company = assertCompany(companyId);
  const item = await loadItem(company, itemRef);
  const ctx = await readContext(company, [item], { contentClient, env, now });
  return {
    item: present(item, { user, ...ctx, now, full: true, company, env }),
    contentLibrary: libraryView(ctx.library),
    permissions: permissionsFor(user),
  };
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const CALENDAR_CAP = 500;

/**
 * GET /content-plan/calendar — every planned item falling in a date range,
 * placed on the day it falls in the viewer's time zone.
 */
async function calendar({ companyId, user, query = {}, contentClient = null, env = process.env, now = new Date() } = {}) {
  const company = assertCompany(companyId);
  refuseUnknown(query, CALENDAR_PARAMS, "The content calendar");

  const from = assertCalendarDate(query.from, "from");
  const to = assertCalendarDate(query.to, "to");
  if (from > to) throw fail("VALIDATION", "from is after to.", { field: "from" });
  const dates = [];
  for (let d = from; d <= to; d = zoned.nextDate(d)) {
    dates.push(d);
    if (dates.length > C.LIMITS.CALENDAR_MAX_DAYS) {
      throw fail("VALIDATION", `A calendar may cover at most ${C.LIMITS.CALENDAR_MAX_DAYS} days.`,
        { field: "to", max: C.LIMITS.CALENDAR_MAX_DAYS });
    }
  }
  const timeZone = str(query.timeZone) ? zoned.assertTimeZone(query.timeZone) : C.DEFAULT_TIME_ZONE;

  const { match, filters } = await commonFilter(company, query, user);
  if (!filters.state) match.state = { $ne: "cancelled" };
  const rangeStart = zoned.startOfDay(from, timeZone);
  const rangeEnd = zoned.startOfDay(zoned.nextDate(to), timeZone);
  const inRange = {
    $or: [
      { "planned.allDay": false, "planned.startsAt": { $gte: rangeStart, $lt: rangeEnd } },
      { "planned.allDay": true, "planned.date": { $gte: from, $lte: to } },
    ],
  };
  const selector = match.$or ? { $and: [match, inRange] } : { ...match, ...inRange };

  const rows = await MarketingContentPlanItem.find(selector)
    .select("-history")
    .sort({ "planned.startsAt": 1, _id: 1 })
    .limit(CALENDAR_CAP + 1)
    .lean();
  const truncated = rows.length > CALENDAR_CAP;
  const items = truncated ? rows.slice(0, CALENDAR_CAP) : rows;

  const ctx = await readContext(company, items, { contentClient, env, now });
  const views = items.map((i) => present(i, { user, ...ctx, now, viewerTz: timeZone }));

  /* Same day, same minute: an overlap a planner wants to see. */
  const slotCount = new Map();
  for (const v of views) {
    if (v.planned.allDay) continue;
    const slot = `${v.planned.display.date} ${v.planned.display.time}`;
    slotCount.set(slot, (slotCount.get(slot) || 0) + 1);
  }
  for (const v of views) {
    const n = v.planned.allDay ? 0 : slotCount.get(`${v.planned.display.date} ${v.planned.display.time}`);
    v.overlapsWith = n > 1 ? n - 1 : 0;
  }

  const byDay = new Map(dates.map((d) => [d, []]));
  for (const v of views) byDay.get(v.planned.display.date)?.push(v);

  const order = (a, b) => (Number(b.planned.allDay) - Number(a.planned.allDay))
    || str(a.planned.display.time).localeCompare(str(b.planned.display.time))
    || a.title.localeCompare(b.title)
    || a.itemRef.localeCompare(b.itemRef);

  return {
    range: { from, to, timeZone, days: dates.length },
    days: dates.map((date) => {
      const [y, m, d] = date.split("-").map(Number);
      return {
        date,
        weekday: WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()],
        items: (byDay.get(date) || []).sort(order).map((v) => v.itemRef),
      };
    }),
    items: views.sort(order),
    empty: views.length === 0,
    truncated,
    filters,
    contentLibrary: libraryView(ctx.library),
    permissions: permissionsFor(user),
  };
}

/* ── VOCABULARY ─────────────────────────────────────────────────────────── */

const vocab = (list) => list.map((x) => ({ code: x.code, label: x.label, ...(x.means ? { means: x.means } : {}) }));

const vocabulary = Object.freeze({
  contentTypes: C.CONTENT_TYPES.map((t) => ({ code: t.code, label: t.label, linksToLibrary: Boolean(t.libraryKind) })),
  channels: vocab(C.CHANNELS),
  states: vocab(C.STATES),
  actions: C.ACTIONS.map((a) => ({
    code: a.code, label: a.label, from: [...a.from], to: a.to,
    who: a.actor === "approver" ? "approver" : "marketing", reasonRequired: a.reason === "required",
  })),
  submissionRequires: vocab(C.SUBMISSION_REQUIRES),
  approvalStatus: vocab(C.APPROVAL_STATUS),
  approvalInvalidReasons: vocab(C.APPROVAL_INVALID_REASONS),
  publication: vocab(C.PUBLICATION),
  campaignLink: vocab(C.CAMPAIGN_LINK),
  contentLibrary: vocab(C.CONTENT_LIBRARY),
  actionRefusals: [
    { code: "not_in_this_state", label: "Not available in this state" },
    { code: "approver_only", label: "Only an administrator or the CEO can do this" },
    { code: "marketing_only", label: "Needs the Editor role or higher in Marketing" },
    { code: "own_submission", label: "You submitted this, so somebody else must approve it" },
    { code: "media_unavailable", label: "A file in the creative was withdrawn or is gone; replace it first" },
    { code: "incomplete", label: "Needs a brief, an owner, a planned date and (for posts, adverts and videos) a creative draft first" },
  ],
  limits: {
    titleMax: C.LIMITS.TITLE_MAX, briefMax: C.LIMITS.BRIEF_MAX, notesMax: C.LIMITS.NOTES_MAX,
    reasonMax: C.LIMITS.REASON_MAX, calendarMaxDays: C.LIMITS.CALENDAR_MAX_DAYS,
    pageDefault: C.LIMITS.PAGE_DEFAULT, pageMax: C.LIMITS.PAGE_MAX,
  },
  defaultTimeZone: C.DEFAULT_TIME_ZONE,
  creative: {
    requiredFor: [...C.CREATIVE_TYPES],
    platforms: vocab(C.PLATFORMS),
    formats: vocab(C.FORMATS),
    callsToAction: vocab(C.CALLS_TO_ACTION),
    referenceKinds: vocab(C.REFERENCE_KINDS),
    referenceStatus: vocab(C.REFERENCE_STATUS),
    referenceStatusByKind: Object.fromEntries(Object.entries(C.REFERENCE_STATUS_BY_KIND).map(([k, list]) => [k, vocab(list)])),
    mediaStore: { images: C.MEDIA_STORE.images, formats: [...C.MEDIA_STORE.formats], otherMedia: C.MEDIA_STORE.otherMedia, gap: C.MEDIA_STORE.gap },
    variantsMean: "Each version is how the one planned item should look on a platform. Versions share the item's date, approval and publication; none is a separate post.",
    limits: {
      conceptMax: C.LIMITS.CONCEPT_MAX, captionMax: C.LIMITS.CAPTION_MAX, ctaTextMax: C.LIMITS.CTA_TEXT_MAX,
      variantsMax: C.LIMITS.VARIANTS_MAX, referencesMax: C.LIMITS.REFERENCES_MAX, referenceNoteMax: C.LIMITS.REFERENCE_NOTE_MAX,
    },
  },
  plannedMeans: "The date and time somebody intends this for. It is not a schedule, and nothing is scheduled or published by the planner.",
  actualMeans: "What the content library reports about the linked asset, when it reports it. Never typed by anybody.",
});

module.exports = {
  create,
  update,
  act,
  list,
  detail,
  calendar,
  owners,
  present,
  vocabulary,
  __internals: { isApprover, isMarketing, ownerRefFor, missingForSubmission },
};
