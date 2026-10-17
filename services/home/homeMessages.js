// services/home/homeMessages.js
//
// The home's Messages section — unread Chat and Mail, first on /onboarding
// because a message is somebody waiting on you (owner, 13 Oct 2026: "need to
// prioritise showing chat and mail messages … as they are important").
//
// ── WHAT IS READ ────────────────────────────────────────────────────────────
//   Chat (internal)  InternalMailThread, purpose "chat"
//   Mail (internal)  InternalMailThread, purpose "mail" (or none — the
//                    collection's older rows)
//   Mail (Gmail)     the person's own connected Gmail, if they connected one
// The same store and the same per-person `unreadFor` the Chat and Mail apps
// keep, keyed on the same actor (mailIdentity.resolveMailActor) — so the home
// says exactly what those apps would, and opening a thread there clears it here.
//
// Only for an app the person may open: each half asks appAccess first, the
// same check the Chat and Mail routers make.
//
// ── COST ────────────────────────────────────────────────────────────────────
// Internal: per app one indexed find (participantKeys + purpose) of at most
// ITEM_LIMIT threads, one bounded count, and one read of their last messages
// for the sender's name. Gmail: one labels.get for the count and ITEM_LIMIT
// metadata-only message reads — never the full-body list the Mail app uses —
// memoised per mailbox for GMAIL_CACHE_MS, longer than the home's own 30 s,
// because Google is the slow, metered part. A mailbox that is not connected
// is `{status:"none"}`, not an error.

"use strict";

const InternalMailThread = require("../../models/Mail/InternalMailThread");
const InternalMailMessage = require("../../models/Mail/InternalMailMessage");
/* Loaded when first used, not at the top: mailIdentity.service itself reads
   resolveEmployee from employeeHome.service, which loads this file — a
   top-level require here would hand mailIdentity a half-built module. */
const mailIdentity = () => require("../mail/mailIdentity.service");
const { resolveAppAccess } = require("../access/appAccess.service");
const googleMail = require("../mail/googleMail.service");

const ITEM_LIMIT = 4;
const COUNT_CAP = 99;
const GMAIL_CACHE_MS = Number(process.env.HOME_GMAIL_CACHE_MS || 120000);

function purposeClause(purpose) {
  return purpose === "chat"
    ? { purpose: "chat" }
    : { $or: [{ purpose: "mail" }, { purpose: { $exists: false } }] };
}

/** "Arpita Sen", "Arpita Sen, Rohit +2" — everyone in the thread but me. */
function othersIn(thread, actorKey) {
  const names = (thread.participants || []).filter((p) => p.actorKey !== actorKey).map((p) => p.name).filter(Boolean);
  if (!names.length) return "";
  return names.length <= 2 ? names.join(", ") : `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

async function unreadInternal(actorKey, purpose) {
  const query = {
    ...purposeClause(purpose),
    participantKeys: actorKey,
    unreadFor: actorKey,
    deletedFor: { $ne: actorKey },
    archivedFor: { $ne: actorKey },
  };
  const [rows, unread] = await Promise.all([
    InternalMailThread.find(query).sort({ lastMessageAt: -1 }).limit(ITEM_LIMIT)
      .select("subject participants lastMessageAt lastMessagePreview").lean(),
    InternalMailThread.countDocuments(query).limit(COUNT_CAP + 1),
  ]);
  /* Who wrote last: the newest message of each thread, in one read. */
  const ids = rows.map((r) => r._id);
  const lastBy = new Map();
  if (ids.length) {
    const recent = await InternalMailMessage.find({ threadId: { $in: ids } })
      .sort({ createdAt: -1 }).limit(ids.length * 4)
      .select("threadId senderName senderKey").lean();
    for (const m of recent) if (!lastBy.has(String(m.threadId))) lastBy.set(String(m.threadId), m);
  }
  const items = rows.map((t) => {
    const last = lastBy.get(String(t._id));
    const who = last && last.senderKey !== actorKey ? last.senderName : othersIn(t, actorKey);
    return {
      id: String(t._id),
      channel: "internal",
      from: who || "A colleague",
      with: othersIn(t, actorKey),
      subject: purpose === "chat" ? "" : t.subject || "",
      preview: t.lastMessagePreview || "",
      at: t.lastMessageAt || null,
      href: purpose === "chat"
        ? `/chat?lane=internal&c=${encodeURIComponent(String(t._id))}`
        : `/mail/inbox?open=internal:${encodeURIComponent(String(t._id))}`,
    };
  });
  return { unread: Math.min(unread, COUNT_CAP), more: unread > COUNT_CAP, items };
}

const gmailCache = new Map();
async function unreadGmail(principalKey) {
  const hit = gmailCache.get(principalKey);
  if (hit && Date.now() - hit.at < GMAIL_CACHE_MS) return hit.value;
  let value;
  try {
    value = { status: "ok", ...(await googleMail.unreadSummary(principalKey, { limit: ITEM_LIMIT })) };
  } catch (err) {
    if (err?.code === "MAIL_GMAIL_NOT_CONNECTED") value = { status: "none" };
    else {
      console.warn("[home] gmail:", err?.message || err);
      value = { status: "unavailable" };
    }
  }
  gmailCache.set(principalKey, { at: Date.now(), value });
  if (gmailCache.size > 2000) gmailCache.delete(gmailCache.keys().next().value);
  return value;
}

async function messagesSection(user) {
  const [chatAccess, mailAccess] = await Promise.all([
    resolveAppAccess(user, "chat"),
    resolveAppAccess(user, "mail"),
  ]);
  if (!chatAccess.allowed && !mailAccess.allowed) return { status: "none" };

  let actor = null;
  try {
    actor = await mailIdentity().resolveMailActor(user);
  } catch {
    /* no employee ID: internal Chat and Mail are not open to this account */
  }

  const chat = !chatAccess.allowed ? { status: "none" }
    : !actor ? { status: "none", reason: "employee-id" }
      : { status: "ok", ...(await unreadInternal(actor.actorKey, "chat")) };

  let mail = { status: "none" };
  if (mailAccess.allowed) {
    const [internal, gmail] = await Promise.all([
      actor ? unreadInternal(actor.actorKey, "mail") : Promise.resolve(null),
      mailIdentity().resolveMailPrincipal(user).then((p) => unreadGmail(p.actorKey)).catch(() => ({ status: "unavailable" })),
    ]);
    const items = [
      ...(internal?.items || []),
      ...(gmail.status === "ok" ? gmail.items : []),
    ].sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0)).slice(0, ITEM_LIMIT);
    mail = {
      status: "ok",
      unread: (internal?.unread || 0) + (gmail.status === "ok" ? gmail.unread : 0),
      items,
      gmail: gmail.status,
    };
  }

  return { status: "ok", chat, mail };
}

module.exports = { messagesSection, othersIn, ITEM_LIMIT };
