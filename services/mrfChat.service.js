// services/mrfChat.service.js
//
// One chat thread per request — both material requests (MRF) and new-product
// requests (RawItemAddRequest). Shared by the cowork side (requester / TL) and
// the CMS store side; both route files call these functions so the two entry
// points can never diverge in what they store or who they notify.
//
// Live delivery: Socket.IO room `mrf_<subjectId>`, joined via `join_mrf`. The
// room name is keyed on the subject id, which is unique across both
// collections, so one room convention covers both kinds of request.

const MrfChatMessage = require("../models/CMS_Models/Inventory/Operations/MrfChatMessage");
const socket = require("../config/socketInstance");
const mrfNotify = require("./mrfNotify.service");

const roomOf = (subjectId) => `mrf_${subjectId}`;

/**
 * Messages for a subject. MRF threads also match the legacy `mrf` field, so
 * conversations written before product-request chat existed still resolve.
 */
function subjectFilter(subjectId, subjectType = "MRF") {
  return subjectType === "MRF"
    ? { $or: [{ subject: subjectId }, { mrf: subjectId }] }
    : { subject: subjectId, subjectType };
}

/** Chronological page of the thread. `before` pages backwards. */
async function listMessages(subjectId, { subjectType = "MRF", limit = 100, before = null } = {}) {
  const filter = subjectFilter(subjectId, subjectType);
  if (before) filter.createdAt = { $lt: new Date(before) };

  // Fetch newest-first so `limit` takes the most recent page, then flip.
  const docs = await MrfChatMessage.find(filter)
    .sort({ createdAt: -1 })
    .limit(Math.min(parseInt(limit, 10) || 100, 300))
    .lean();

  return docs.reverse();
}

async function unreadCount(subjectId, readerId, subjectType = "MRF") {
  if (!readerId) return 0;
  return MrfChatMessage.countDocuments({
    ...subjectFilter(subjectId, subjectType),
    isSystem: false,
    readBy: { $ne: String(readerId) },
  });
}

async function markRead(subjectId, readerId, subjectType = "MRF") {
  if (!readerId) return { modified: 0 };
  const r = await MrfChatMessage.updateMany(
    { ...subjectFilter(subjectId, subjectType), readBy: { $ne: String(readerId) } },
    { $addToSet: { readBy: String(readerId) } }
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

/**
 * Post a message and fan it out.
 *
 * @param {object} doc          a live (non-lean) MRF or RawItemAddRequest —
 *                              its chat counters are updated and saved here
 * @param {string} subjectType  "MRF" | "PRODUCT_REQUEST"
 */
async function postMessage(doc, { body = "", attachments = [], isSystem = false, subjectType = "MRF", ...sender }) {
  const text = String(body || "").trim();
  if (!text && !(attachments || []).length && !isSystem) {
    const err = new Error("Message cannot be empty");
    err.status = 400;
    throw err;
  }

  const info = describeSubject(doc, subjectType);

  const message = await MrfChatMessage.create({
    subjectType,
    subject: doc._id,
    // Legacy field — only meaningful for MRF threads.
    mrf: subjectType === "MRF" ? doc._id : null,
    mrfNumber: info.label || "",
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
  });

  // Counters live on the request so list views can badge without a join.
  doc.chatMessageCount = (doc.chatMessageCount || 0) + 1;
  doc.chatLastMessageAt = message.createdAt;
  doc.chatLastMessageBy = message.senderName || "System";
  await doc.save();

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

  return message;
}

/** Record a status change in the thread so it reads as a full history. */
function systemMessage(doc, text, actorName = "", subjectType = "MRF") {
  return postMessage(doc, {
    body: text,
    isSystem: true,
    subjectType,
    senderName: actorName || "System",
  }).catch(e => {
    // A failed system message must never fail the action that caused it.
    console.error("[mrfChat] system message failed:", e.message);
    return null;
  });
}

module.exports = {
  listMessages, postMessage, systemMessage, markRead, unreadCount, roomOf, describeSubject,
};
