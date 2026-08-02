// services/mrfNotify.service.js
//
// Every MRF notification goes through here. One place means one set of
// wording, one dedupe window, and no event that reaches one audience but not
// another.
//
// Three delivery channels, because the three audiences live in different
// systems:
//   • requester + TL  → cowork_notifications (Firestore, real-time via
//                       useCoworkNotifications) + Socket.IO + FCM push
//   • Store Person    → web-push to the store_manager / admin / store roles
//                       (CMS users have no cowork Firestore identity)
//   • everyone        → the MRF's own chat thread gets a system message for
//                       status changes, so the thread reads as full history
//
// Notification bodies always name the MRF, per the spec.

const { db, admin } = require("../config/firebaseAdmin");
const { v4: uuidv4 } = require("uuid");
const socket = require("../config/socketInstance");
const NotificationService = require("./NotificationService");
const { fmtQty } = require("./mrfContext.service");

const STORE_ROLES = ["store_manager", "admin", "store"];

// ── Dedupe ────────────────────────────────────────────────────────────────
// Guards the "duplicate notifications" edge case: a double-clicked approve, a
// retried request, or two store people acting at once must not fan out the
// same line twice. Keyed on recipient + tag, 15s window.
const _recent = new Map();
const DEDUPE_MS = 15_000;

function _isDuplicate(key) {
  const now = Date.now();
  // Opportunistic sweep — the map only ever holds a few seconds of traffic.
  if (_recent.size > 500) {
    for (const [k, exp] of _recent) if (exp < now) _recent.delete(k);
  }
  const exp = _recent.get(key);
  if (exp && exp > now) return true;
  _recent.set(key, now + DEDUPE_MS);
  return false;
}

// ── Cowork side (requester / TL) ──────────────────────────────────────────
/**
 * @param {string[]} recipientIds biometric ids (cowork employeeId)
 */
async function notifyCowork({ recipientIds, type, title, body, data = {}, tag = "" }) {
  // Call sites pass a mix of single ids and per-person id lists — flatten so
  // neither shape can turn into a stringified array as a recipient.
  const ids = [...new Set([recipientIds].flat(2).filter(Boolean).map(String))];
  const fresh = ids.filter(id => !_isDuplicate(`${id}|${tag || title}`));
  if (!fresh.length) return { sent: 0 };

  try {
    const batch = db.batch();
    fresh.forEach(id => {
      batch.set(db.collection("cowork_notifications").doc(uuidv4()), {
        recipientEmployeeId: id,
        type, title, body,
        data: data || {},
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
    await batch.commit();
  } catch (e) {
    console.error("[mrfNotify] firestore write failed:", e.message);
  }

  try {
    socket.emitToMany(fresh, "new_notification", { type, title, body, data });
  } catch (e) { console.error("[mrfNotify] socket emit failed:", e.message); }

  // FCM is best-effort and must never delay the request that triggered it.
  setImmediate(() => {
    try {
      const { sendPushToEmployees } = require("./fcmPush.service");
      sendPushToEmployees(fresh, title, body, { type, ...(data || {}) })
        .catch(e => console.error("[mrfNotify FCM]", e.message));
    } catch (e) { console.error("[mrfNotify FCM init]", e.message); }
  });

  return { sent: fresh.length };
}

// ── Store side ────────────────────────────────────────────────────────────
function notifyStore({ title, body, mrf, tag }) {
  const key = `store|${tag || title}`;
  if (_isDuplicate(key)) return Promise.resolve({ sent: 0 });
  return NotificationService.sendToRole(STORE_ROLES, {
    title, body,
    type: "request",
    url: mrf ? `/store/dashboard/order-requests/mrf/${mrf._id}` : "/store/dashboard/order-requests",
    tag: tag || `mrf-${mrf?._id}`,
  }).catch(() => ({ sent: 0 }));
}

// ── Helpers ───────────────────────────────────────────────────────────────
// An employee's HR record can carry both a biometricId and an identityId, and
// their cowork session presents whichever one their cowork_employees doc uses.
// Addressing only one of them silently drops the notification, so every known
// id is targeted — notifyCowork de-duplicates, and an id nobody is listening
// on simply goes unread.
const requesterId = (mrf) =>
  [mrf.requesterCoworkId, mrf.requestedForId].filter(Boolean);
const tlId = (mrf) =>
  [mrf.approverBiometricId, ...(mrf.approverAltIds || [])].filter(Boolean);
const linkData = (mrf) => ({ mrfId: String(mrf._id), mrfNumber: mrf.mrfNumber, url: "/coworking/mrf" });
// Approvals are a tab on the Material Requests page, not a separate route.
const tlLinkData = (mrf) => ({ mrfId: String(mrf._id), mrfNumber: mrf.mrfNumber, url: "/coworking/mrf?tab=approvals" });

// Every notification body leads with the MRF number, per the spec.
const N = (mrf, rest) => `${mrf.mrfNumber}: ${rest}`;

// ═══════════════════════════════════════════════════════════════════════════
// Events
// ═══════════════════════════════════════════════════════════════════════════

/** Employee submitted — confirm to them, queue it for the TL. */
async function submitted(mrf) {
  const itemCount = (mrf.items || []).length;

  await notifyCowork({
    recipientIds: [requesterId(mrf)],
    type: "request",
    tag: `mrf-submitted-${mrf._id}`,
    title: "Material request submitted",
    body: N(mrf, `submitted with ${itemCount} item(s). Waiting for approval from ${mrf.approverName || "your Primary Manager/TL"}.`),
    data: linkData(mrf),
  });

  if (tlId(mrf).length) {
    await notifyCowork({
      recipientIds: [tlId(mrf)],
      type: "request",
      tag: `mrf-needs-approval-${mrf._id}`,
      title: "MRF needs your approval",
      body: N(mrf, `${mrf.requestedForName || "An employee"} requested ${itemCount} item(s) and needs your approval.`),
      data: tlLinkData(mrf),
    });
  }
}

/** No TL could be resolved — it went straight to the store. */
async function autoForwarded(mrf) {
  await notifyCowork({
    recipientIds: [requesterId(mrf)],
    type: "request",
    tag: `mrf-autofwd-${mrf._id}`,
    title: "Request sent directly to the Store",
    body: N(mrf, mrf.autoForwardReason || "No Primary Manager/TL could be identified, so it was sent directly to the Store. Please ask HR to update your reporting manager."),
    data: linkData(mrf),
  });

  await notifyStore({
    mrf,
    tag: `mrf-store-${mrf._id}`,
    title: "New Material Request (no TL)",
    body: N(mrf, `raised by ${mrf.requestedForName} — no Primary Manager/TL could be resolved, so it needs Store action directly.`),
  });
}

/** TL approved → straight to the Store. */
async function tlApproved(mrf) {
  const by = mrf.tlApprovedByName || mrf.approverName || "your Primary Manager/TL";

  await notifyCowork({
    recipientIds: [requesterId(mrf)],
    type: "request",
    tag: `mrf-approved-${mrf._id}`,
    title: "Material request approved",
    body: N(mrf, `approved by ${by} and forwarded to the Store.`),
    data: linkData(mrf),
  });

  if (tlId(mrf).length) {
    await notifyCowork({
      recipientIds: [tlId(mrf)],
      type: "request",
      tag: `mrf-approved-ack-${mrf._id}`,
      title: "You approved a material request",
      body: N(mrf, `approved and sent to the Store for ${mrf.requestedForName}.`),
      data: tlLinkData(mrf),
    });
  }

  await notifyStore({
    mrf,
    tag: `mrf-store-${mrf._id}`,
    title: "MRF approved by TL",
    body: N(mrf, `approved by ${by} and is now available for Store processing. Requested for ${mrf.requestedForName}.`),
  });
}

/** TL rejected — dead end, requester needs the reason. */
async function tlRejected(mrf) {
  const by = mrf.tlRejectedByName || mrf.approverName || "your Primary Manager/TL";
  const note = mrf.tlRejectionNote || "";

  await notifyCowork({
    recipientIds: [requesterId(mrf)],
    type: "request",
    tag: `mrf-rejected-${mrf._id}`,
    title: "Material request rejected",
    body: N(mrf, `rejected by ${by}.${note ? ` Reason: ${note}` : ""}`),
    data: linkData(mrf),
  });

  if (tlId(mrf).length) {
    await notifyCowork({
      recipientIds: [tlId(mrf)],
      type: "request",
      tag: `mrf-rejected-ack-${mrf._id}`,
      title: "You rejected a material request",
      body: N(mrf, `rejected for ${mrf.requestedForName}.${note ? ` Reason: ${note}` : ""}`),
      data: tlLinkData(mrf),
    });
  }
}

/**
 * Store recorded availability. `summary` is the per-line report so the body can
 * be specific ("Requested: 20, Available: 13") rather than generic.
 */
async function availabilityUpdated(mrf, summary = []) {
  if (!summary.length) return;

  const notAvail = summary.filter(s => s.availability === "NOT_AVAILABLE");
  const partial = summary.filter(s => s.availability === "PARTIAL");
  const alt = summary.filter(s => s.availability === "ALTERNATIVE");

  let title, body;
  if (partial.length) {
    const l = partial[0];
    title = "Product partially available";
    body = N(mrf, `The requested product is partially available. Requested: ${fmtQty(l.requested, l.unit)}, Available: ${fmtQty(l.available, l.unit)}.`);
  } else if (notAvail.length) {
    title = "Product not available";
    body = N(mrf, `The Store has reported "${notAvail[0].name}" as not available.${notAvail[0].note ? ` Note: ${notAvail[0].note}` : " Check the MRF chat for an alternative."}`);
  } else if (alt.length) {
    title = "Alternative product offered";
    body = N(mrf, `The Store has suggested an alternative${alt[0].alternativeName ? `: ${alt[0].alternativeName}` : ""}. Confirm it in the MRF chat.`);
  } else {
    title = "Product available";
    body = N(mrf, "The requested product is available. The Store is processing the requested quantity.");
  }

  await notifyCowork({
    recipientIds: [requesterId(mrf), tlId(mrf)],
    type: "request",
    tag: `mrf-avail-${mrf._id}-${title}`,
    title, body,
    data: linkData(mrf),
  });
}

/** Store issued material — full or partial. `lines` are the lines just issued. */
async function issued(mrf, lines = []) {
  if (!lines.length) return;

  const stillPending = (mrf.items || [])
    .filter(i => !["REJECTED", "UNFULFILLED"].includes(i.itemStatus))
    .reduce((s, i) => s + Math.max(0, (i.requestedQty || 0) - (i.issuedQty || 0)), 0);

  const issuedText = lines
    .map(l => `${fmtQty(l.issuedQty, l.unit)} of ${l.name}`)
    .join(", ");

  const partial = stillPending > 0.001;
  const remainingText = partial
    ? ` Remaining quantity: ${lines.filter(l => l.remaining > 0).map(l => `${fmtQty(l.remaining, l.unit)} of ${l.name}`).join(", ") || "pending on other items"}.`
    : "";

  await notifyCowork({
    recipientIds: [requesterId(mrf)],
    type: "request",
    tag: `mrf-issued-${mrf._id}-${Date.now()}`,
    title: partial ? "Material partially issued" : "Material issued",
    body: N(mrf, `${issuedText} ${lines.length === 1 ? "has" : "have"} been issued by the Store.${remainingText}`),
    data: linkData(mrf),
  });

  if (tlId(mrf).length) {
    await notifyCowork({
      recipientIds: [tlId(mrf)],
      type: "request",
      tag: `mrf-issued-tl-${mrf._id}-${Date.now()}`,
      title: partial ? "MRF partially issued" : "MRF issued",
      body: N(mrf, `${issuedText} issued to ${mrf.requestedForName}.${remainingText}`),
      data: tlLinkData(mrf),
    });
  }
}

/**
 * Material came back to the store. Previously silent — the requester was never
 * told their return had been recorded, which matters because it is what clears
 * what they still owe.
 */
async function returned(mrf, line) {
  const returnedText = `${fmtQty(line.returnedQty, line.unit)} of ${line.name}`;
  const stillOut = line.outstanding > 0.001
    ? ` ${fmtQty(line.outstanding, line.unit)} still with you.`
    : " Nothing further outstanding on this item.";

  await notifyCowork({
    recipientIds: [requesterId(mrf)],
    type: "request",
    tag: `mrf-returned-${mrf._id}-${Date.now()}`,
    title: line.complete ? "Return completed" : "Return recorded",
    body: N(mrf, `the Store recorded your return of ${returnedText}.${stillOut}`),
    data: linkData(mrf),
  });

  if (tlId(mrf).length) {
    await notifyCowork({
      recipientIds: [tlId(mrf)],
      type: "request",
      tag: `mrf-returned-tl-${mrf._id}-${Date.now()}`,
      title: line.complete ? "Material fully returned" : "Material returned",
      body: N(mrf, `${mrf.requestedForName} returned ${returnedText}.`),
      data: tlLinkData(mrf),
    });
  }
}

/** Store closed it as impossible to supply. */
async function unfulfilled(mrf) {
  await notifyCowork({
    recipientIds: [requesterId(mrf), tlId(mrf)],
    type: "request",
    tag: `mrf-unfulfilled-${mrf._id}`,
    title: "Request cannot be fulfilled",
    body: N(mrf, `the Store cannot supply this material.${mrf.unfulfilledReason ? ` Reason: ${mrf.unfulfilledReason}` : ""} Check the MRF chat for alternatives.`),
    data: linkData(mrf),
  });
}

/** Requester cancelled — tell whoever was holding it. */
async function cancelled(mrf) {
  const wasWithStore = ["APPROVED", "PARTIALLY_ISSUED"].includes(mrf.status) || mrf.tlApproved;

  if (tlId(mrf).length) {
    await notifyCowork({
      recipientIds: [tlId(mrf)],
      type: "request",
      tag: `mrf-cancelled-${mrf._id}`,
      title: "Material request cancelled",
      body: N(mrf, `cancelled by ${mrf.requestedForName}.${mrf.cancellationNote ? ` Note: ${mrf.cancellationNote}` : ""}`),
      data: tlLinkData(mrf),
    });
  }
  if (wasWithStore) {
    await notifyStore({
      mrf,
      tag: `mrf-cancelled-store-${mrf._id}`,
      title: "MRF cancelled",
      body: N(mrf, `cancelled by ${mrf.requestedForName} — stop processing.${mrf.cancellationNote ? ` Note: ${mrf.cancellationNote}` : ""}`),
    });
  }
}

/**
 * A chat message was posted on a request. Everyone on the thread except the
 * sender hears about it, on whichever channel reaches them.
 *
 * Takes the normalised shape from mrfChat.describeSubject so it works for both
 * material requests and new-product requests without caring which it got.
 */
async function subjectChatMessage(info, message) {
  const preview = (message.body || "").slice(0, 120) || "(attachment)";
  const from = message.senderName || "Someone";
  const label = info.label || "your request";

  const coworkTargets = [info.requesterIds, info.tlIds]
    .flat(2)
    .filter(Boolean)
    .filter(id => String(id) !== String(message.senderBiometricId));

  if (coworkTargets.length) {
    await notifyCowork({
      recipientIds: coworkTargets,
      type: "request",
      tag: `chat-${message._id}`,
      title: `${from} · ${label}`,
      body: preview,
      data: {
        subjectId: String(message.subject || message.mrf || ""),
        subjectType: message.subjectType || "MRF",
        url: info.url || "/coworking/mrf",
        openChat: true,
      },
    });
  }

  // The store only needs pinging when the message came from the cowork side.
  if (message.senderRole !== "store") {
    await notifyStore({
      mrf: message.subjectType === "MRF" ? { _id: message.subject || message.mrf } : null,
      tag: `chat-store-${message._id}`,
      title: `New message on ${label}`,
      body: `${from}: ${preview}`,
    });
  }
}

/** Back-compat wrapper for MRF-only callers. */
async function chatMessage(mrf, message) {
  return subjectChatMessage(
    {
      label: mrf.mrfNumber,
      requesterIds: requesterId(mrf),
      tlIds: tlId(mrf),
      url: "/coworking/mrf",
    },
    message
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Product registration requests (items not in the catalogue yet)
//
// Same route as an MRF: the requester's Primary Manager/TL approves first, and
// only then does the Store see it to match or register.
// ═══════════════════════════════════════════════════════════════════════════

const prIds = (doc) => [doc.requesterCoworkId, doc.requestedByBiometricId].filter(Boolean);
const prTlIds = (doc) => [doc.approverBiometricId, ...(doc.approverAltIds || [])].filter(Boolean);
const prLabel = (doc) => {
  const names = (doc.products || []).map(p => p.itemName).filter(Boolean);
  if (!names.length) return "a new product";
  return names.length === 1 ? `"${names[0]}"` : `"${names[0]}" and ${names.length - 1} more`;
};

/**
 * A message on a product-request thread.
 *
 * The mirror of `chatMessage` for MRFs. Kept here rather than assembled at the
 * route so the recipient sets and the label come from the same three helpers
 * every other product-request notification uses — a route building its own
 * would drift the moment `approverAltIds` changed meaning.
 */
async function productRequestChatMessage(doc, message) {
  return subjectChatMessage(
    {
      label: prLabel(doc),
      requesterIds: prIds(doc),
      tlIds: prTlIds(doc),
      url: "/coworking/mrf",
    },
    message
  );
}

async function productRequestSubmitted(doc) {
  await notifyCowork({
    recipientIds: [prIds(doc)],
    type: "request",
    tag: `pr-submitted-${doc._id}`,
    title: "Product request submitted",
    body: `Your request to add ${prLabel(doc)} to inventory is waiting for approval from ${doc.approverName || "your Primary Manager/TL"}.`,
    data: { productRequestId: String(doc._id), url: "/coworking/mrf" },
  });

  if (prTlIds(doc).length) {
    await notifyCowork({
      recipientIds: [prTlIds(doc)],
      type: "request",
      tag: `pr-needs-approval-${doc._id}`,
      title: "Product request needs your approval",
      body: `${doc.requestedByName || "An employee"} wants ${prLabel(doc)} added to inventory and needs your approval.`,
      data: { productRequestId: String(doc._id), url: "/coworking/mrf?tab=approvals" },
    });
  }
}

async function productRequestAutoForwarded(doc) {
  await notifyCowork({
    recipientIds: [prIds(doc)],
    type: "request",
    tag: `pr-autofwd-${doc._id}`,
    title: "Product request sent to the Store",
    body: doc.autoForwardReason || `No Primary Manager/TL could be identified, so your request for ${prLabel(doc)} went straight to the Store.`,
    data: { productRequestId: String(doc._id), url: "/coworking/mrf" },
  });
  await notifyStore({
    tag: `pr-store-${doc._id}`,
    title: "New Product Registration Request",
    body: `${doc.requestedByName} asked for ${prLabel(doc)} to be added to inventory (no TL could be resolved).`,
    mrf: null,
  });
}

async function productRequestTlApproved(doc) {
  const by = doc.tlApprovedByName || doc.approverName || "your Primary Manager/TL";

  await notifyCowork({
    recipientIds: [prIds(doc)],
    type: "request",
    tag: `pr-approved-${doc._id}`,
    title: "Product request approved",
    body: `${by} approved your request for ${prLabel(doc)}. It is now with the Store to match or register.`,
    data: { productRequestId: String(doc._id), url: "/coworking/mrf" },
  });

  await notifyStore({
    tag: `pr-store-${doc._id}`,
    title: "Product request approved by TL",
    body: `${doc.requestedByName} requested ${prLabel(doc)} — approved by ${by}. Match it to an existing item or register it.`,
    mrf: null,
  });
}

async function productRequestTlRejected(doc) {
  const by = doc.tlRejectedByName || doc.approverName || "your Primary Manager/TL";
  await notifyCowork({
    recipientIds: [prIds(doc)],
    type: "request",
    tag: `pr-rejected-${doc._id}`,
    title: "Product request rejected",
    body: `${by} rejected your request for ${prLabel(doc)}.${doc.tlRejectionNote ? ` Reason: ${doc.tlRejectionNote}` : ""}`,
    data: { productRequestId: String(doc._id), url: "/coworking/mrf" },
  });
}

module.exports = {
  notifyCowork, notifyStore,
  submitted, autoForwarded, tlApproved, tlRejected,
  availabilityUpdated, issued, returned, unfulfilled, cancelled,
  chatMessage, subjectChatMessage,
  productRequestSubmitted, productRequestAutoForwarded,
  productRequestTlApproved, productRequestTlRejected,
  productRequestChatMessage,
};
