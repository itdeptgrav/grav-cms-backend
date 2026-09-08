// services/mrfChat.service.js
//
// One chat thread per request — both material requests (MRF) and new-product
// requests (RawItemAddRequest). Shared by the cowork side (requester / TL) and
// the CMS store side; both route files call these functions so the two entry
// points can never diverge in what they store or who they notify.
//
// ── EVERY FUNCTION TAKES THE PARENT DOCUMENT, NOT AN ID ─────────────────────
// The chat routes used to pass `req.params.id` straight through, so a guessed
// id from another company listed, posted to and marked read that company's
// conversation. The subject is now always the loaded, tenant-scoped parent,
// and the company on it — never a payload — is what scopes the messages. A
// caller cannot reach these functions without having already proved it may
// see the request the thread belongs to.
//
// Live delivery: Socket.IO room `mrf_<subjectId>`, joined via `join_mrf`. The
// room name is keyed on the subject id, which is unique across both
// collections, so one room convention covers both kinds of request.

const MrfChatMessage = require("../models/CMS_Models/Inventory/Operations/MrfChatMessage");
const socket = require("../config/socketInstance");
const mrfNotify = require("./mrfNotify.service");
const { fail } = require("./storePurchase/errors");

const roomOf = (subjectId) => `mrf_${subjectId}`;

/**
 * The company this thread belongs to, taken from the parent and checked
 * against the caller's resolved context.
 *
 * A company-owned parent with no context, or with a context for a different
 * company, is a programming error rather than a user error: the routes resolve
 * tenancy before they load the parent, so reaching here without it means a
 * call site skipped the boundary. It throws rather than quietly reading
 * everything.
 */
function ownershipOf(subject, ctx) {
  if (!subject || !subject._id) {
    throw fail("VALIDATION", "A chat thread needs the request it belongs to.");
  }
  const owner = subject.companyId ? String(subject.companyId) : null;

  if (owner) {
    const actorCompany = ctx?.companyId ? String(ctx.companyId) : null;
    if (!actorCompany) {
      throw fail(
        "TENANT_MEMBERSHIP_UNPROVEN",
        "This conversation belongs to a company, and the caller has no company context.",
      );
    }
    if (actorCompany !== owner) {
      throw fail("TENANT_MISMATCH", "That conversation belongs to another company.");
    }
    return { companyId: subject.companyId, siteId: subject.siteId || null, legacy: false };
  }

  /* A parent written before the boundary. Its messages are legacy-global and
     stay that way — reading them must not stamp them with whoever looked. */
  return { companyId: null, siteId: null, legacy: true };
}

/**
 * Messages for a subject. MRF threads also match the legacy `mrf` field, so
 * conversations written before product-request chat existed still resolve.
 *
 * The company clause is part of the filter, not an afterthought: a message
 * whose parent is company-owned is only ever read under that company.
 */
function subjectFilter(subject, subjectType, ownership) {
  const subjectId = subject._id;
  const base =
    subjectType === "MRF"
      ? { $or: [{ subject: subjectId }, { mrf: subjectId }] }
      : { subject: subjectId, subjectType };

  /* A legacy thread's messages carry no company. Matching `null` explicitly
     stops an owned message from being read through a legacy parent. */
  return { ...base, companyId: ownership.legacy ? null : ownership.companyId };
}

/** Chronological page of the thread. `before` pages backwards. */
async function listMessages(subject, { ctx, subjectType = "MRF", limit = 100, before = null } = {}) {
  const ownership = ownershipOf(subject, ctx);
  const filter = subjectFilter(subject, subjectType, ownership);
  if (before) filter.createdAt = { $lt: new Date(before) };

  // Fetch newest-first so `limit` takes the most recent page, then flip.
  const docs = await MrfChatMessage.find(filter)
    .sort({ createdAt: -1 })
    .limit(Math.min(parseInt(limit, 10) || 100, 300))
    .lean();

  return docs.reverse();
}

async function unreadCount(subject, { ctx, readerId, subjectType = "MRF" } = {}) {
  if (!readerId) return 0;
  const ownership = ownershipOf(subject, ctx);
  return MrfChatMessage.countDocuments({
    ...subjectFilter(subject, subjectType, ownership),
    isSystem: false,
    readBy: { $ne: String(readerId) },
  });
}

async function markRead(subject, { ctx, readerId, subjectType = "MRF" } = {}) {
  if (!readerId) return { modified: 0 };
  const ownership = ownershipOf(subject, ctx);
  const r = await MrfChatMessage.updateMany(
    {
      ...subjectFilter(subject, subjectType, ownership),
      readBy: { $ne: String(readerId) },
    },
    { $addToSet: { readBy: String(readerId) } },
  );
  return { modified: r.modifiedCount || 0 };
}

/**
 * Normalise either kind of request into the fields the chat layer needs, so
 * postMessage and the notification below don't care which collection they got.
 */
function describeSubject(doc, subjectType) {
  if (subjectType === "PRODUCT_REQUEST") {
    const names = (doc.products || []).map(p => p.itemName).filter(Boolean);
    return {
      label: names.length
        ? (names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`)
        : "Product request",
      requesterIds: [doc.requesterCoworkId].filter(Boolean),
      tlIds: [doc.approverBiometricId, ...(doc.approverAltIds || [])].filter(Boolean),
      url: "/coworking/mrf",
    };
  }
  return {
    label: doc.mrfNumber,
    requesterIds: [doc.requesterCoworkId, doc.requestedForId].filter(Boolean),
    tlIds: [doc.approverBiometricId, ...(doc.approverAltIds || [])].filter(Boolean),
    url: "/coworking/mrf",
  };
}

/** Is this the unique index that makes posting at-most-once? */
const isDuplicateKey = (e) => e?.code === 11000;

/**
 * Post a message and fan it out — at most once per idempotency key.
 *
 * ── WHY CREATION IS THE EFFECT MARKER ───────────────────────────────────────
 * The message is the irreversible thing here: once it exists, everyone on the
 * thread has seen it, and no later failure can take it back. So creation
 * itself is what a retry must collide with. The unique index over
 * (companyId, subject, idempotencyKey) does that in one atomic step — no
 * window exists between "decided to post" and "marked as posted", because
 * they are the same write.
 *
 * Everything after creation is repairable and therefore safe to redo on a
 * retry: the counters are RECOMPUTED rather than incremented, so running them
 * twice cannot drift, and delivery is keyed off whether this call actually
 * created the message.
 *
 * @param {object} doc          a live (non-lean) MRF or RawItemAddRequest —
 *                              its chat counters are updated and saved here
 * @param {string} subjectType  "MRF" | "PRODUCT_REQUEST"
 * @param {string} idempotencyKey  when given, at most one message ever exists
 *                              for this (company, subject, key)
 * @returns {{message: object, created: boolean}}
 */
async function postMessage(doc, {
  ctx, body = "", attachments = [], isSystem = false, subjectType = "MRF",
  idempotencyKey = null, ...sender
}) {
  const text = String(body || "").trim();
  if (!text && !(attachments || []).length && !isSystem) {
    const err = new Error("Message cannot be empty");
    err.status = 400;
    throw err;
  }

  const ownership = ownershipOf(doc, ctx);
  const info = describeSubject(doc, subjectType);
  const key = idempotencyKey ? String(idempotencyKey) : null;

  const fields = {
    subjectType,
    subject: doc._id,
    // Legacy field — only meaningful for MRF threads.
    mrf: subjectType === "MRF" ? doc._id : null,
    mrfNumber: info.label || "",
    companyId: ownership.companyId,
    siteId: ownership.siteId,
    idempotencyKey: key,
    senderRef: sender.senderRef || null,
    senderBiometricId: sender.senderBiometricId || "",
    senderName: sender.senderName || (isSystem ? "System" : ""),
    senderRole: isSystem ? "system" : (sender.senderRole || "employee"),
    body: text,
    attachments: attachments || [],
    isSystem: !!isSystem,
    // The sender has, by definition, read their own message.
    readBy: sender.senderBiometricId || sender.senderRef
      ? [String(sender.senderBiometricId || sender.senderRef)]
      : [],
  };

  /* The index has to exist before it can refuse anything. On a fresh
     deployment it is still building when the first messages arrive, and every
     "duplicate" would be accepted. */
  if (key) await MrfChatMessage.init();

  let message;
  let created = true;
  try {
    message = await MrfChatMessage.create(fields);
  } catch (e) {
    if (!key || !isDuplicateKey(e)) throw e;
    /* A retry of a post that already landed. Recover the message that exists
       rather than writing a second one. */
    message = await MrfChatMessage.findOne({
      companyId: ownership.companyId, subject: doc._id, idempotencyKey: key,
    });
    if (!message) throw e;      // a different unique index; not ours to absorb
    created = false;
  }

  /* Counters live on the request so list views can badge without a join.
     Recomputed, not incremented: a retry that reaches here after the message
     already existed must leave the same number behind, and a count that has
     drifted for any other reason is repaired in passing. */
  doc.chatMessageCount = await MrfChatMessage.countDocuments(
    subjectFilter(doc, subjectType, ownership),
  );
  doc.chatLastMessageAt = message.createdAt;
  doc.chatLastMessageBy = message.senderName || "System";
  await doc.save();

  /* Delivery only for a message this call actually created — a replay must not
     ring everybody's phone a second time for something they already saw. */
  if (created) {
    try {
      const io = socket.get();
      if (io) io.to(roomOf(doc._id)).emit("mrf_chat_message", { mrfId: String(doc._id), message });
    } catch (e) { console.error("[mrfChat] socket emit failed:", e.message); }

    // System messages record something the user was already notified about by
    // the action itself — pushing again would double up.
    if (!isSystem) {
      mrfNotify.subjectChatMessage(info, message).catch(e =>
        console.error("[mrfChat] notify failed:", e.message));
    }
  }

  return { message, created };
}

/**
 * Record a status change in the thread so it reads as a full history.
 *
 * Returns a promise the caller is expected to await. It used to swallow its
 * own failure so the action that caused it could not fail — which meant a
 * thread could silently lose the entry explaining why a request changed state.
 * The caller now decides: await it inside the unit of work, or reconcile.
 */
async function systemMessage(doc, text, actorName = "", { ctx, subjectType = "MRF", idempotencyKey = null } = {}) {
  const { message } = await postMessage(doc, {
    ctx,
    body: text,
    isSystem: true,
    subjectType,
    idempotencyKey,
    senderName: actorName || "System",
  });
  return message;
}

module.exports = {
  listMessages, postMessage, systemMessage, markRead, unreadCount, roomOf,
  describeSubject, ownershipOf,
};
