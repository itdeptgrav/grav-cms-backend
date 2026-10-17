"use strict";

const mongoose = require("mongoose");
const InternalMailThread = require("../../models/Mail/InternalMailThread");
const InternalMailMessage = require("../../models/Mail/InternalMailMessage");
const { findRecipientByEmployeeId } = require("./mailIdentity.service");

const cleanText = (value, max) => String(value || "").trim().slice(0, max);
const preview = (body) => cleanText(body, 240).replace(/\s+/g, " ");

function publicParticipant(p) {
  return { employeeId: p.employeeId, name: p.name, email: p.email || "" };
}

function serializeThread(row, actorKey) {
  return {
    id: String(row._id),
    channel: "internal",
    purpose: row.purpose || "mail",
    subject: row.subject,
    participants: (row.participants || []).map(publicParticipant),
    preview: row.lastMessagePreview || "",
    timestamp: row.lastMessageAt,
    unread: (row.unreadFor || []).includes(actorKey),
    archived: (row.archivedFor || []).includes(actorKey),
  };
}

function purposeClause(purpose) {
  return purpose === "chat"
    ? { purpose: "chat" }
    : { $or: [{ purpose: "mail" }, { purpose: { $exists: false } }] };
}

async function recipientsFor(values) {
  const ids = [...new Set((Array.isArray(values) ? values : []).map((v) => String(v || "").trim()).filter(Boolean))];
  if (!ids.length) {
    const err = new Error("At least one employee ID is required");
    err.status = 400;
    throw err;
  }
  if (ids.length > 20) {
    const err = new Error("Internal mail supports up to 20 recipients");
    err.status = 400;
    throw err;
  }
  const rows = await Promise.all(ids.map(async (id) => ({ id, person: await findRecipientByEmployeeId(id) })));
  const missing = rows.filter((row) => !row.person).map((row) => row.id);
  if (missing.length) {
    const err = new Error(`Employee ID${missing.length > 1 ? "s" : ""} not found: ${missing.join(", ")}`);
    err.status = 404;
    err.code = "MAIL_RECIPIENT_NOT_FOUND";
    err.details = { employeeIds: missing };
    throw err;
  }
  return rows.map((row) => row.person);
}

async function createMessage(sender, input, { purpose = "mail" } = {}) {
  const body = cleanText(input?.body, 100000);
  if (!body) {
    const err = new Error(purpose === "chat" ? "Message is required" : "Subject and message are required");
    err.status = 400;
    throw err;
  }
  const recipients = await recipientsFor(input?.toEmployeeIds);
  const subject = cleanText(input?.subject, 180)
    || (purpose === "chat" ? `Chat with ${recipients.map((person) => person.name).join(", ")}` : "");
  if (!subject) {
    const err = new Error("Subject and message are required");
    err.status = 400;
    throw err;
  }
  const people = new Map([[sender.actorKey, sender], ...recipients.map((p) => [p.actorKey, p])]);
  const participants = [...people.values()].map(({ actorKey, employeeId, name, email }) => ({
    actorKey, employeeId, name, email,
  }));
  const now = new Date();
  const threadId = new mongoose.Types.ObjectId();
  const thread = await InternalMailThread.create({
    _id: threadId,
    purpose,
    subject,
    participants,
    participantKeys: participants.map((p) => p.actorKey),
    lastMessageAt: now,
    lastMessagePreview: preview(body),
    unreadFor: participants.map((p) => p.actorKey).filter((key) => key !== sender.actorKey),
  });
  try {
    await InternalMailMessage.create({
      threadId,
      senderKey: sender.actorKey,
      senderEmployeeId: sender.employeeId,
      senderName: sender.name,
      body,
      createdAt: now,
    });
  } catch (error) {
    await InternalMailThread.deleteOne({ _id: threadId }).catch(() => {});
    throw error;
  }
  return serializeThread(thread.toObject(), sender.actorKey);
}

async function listThreads(actor, { archived = false, limit = 50, purpose = "mail" } = {}) {
  const query = {
    ...purposeClause(purpose),
    participantKeys: actor.actorKey,
    deletedFor: { $ne: actor.actorKey },
    archivedFor: archived ? actor.actorKey : { $ne: actor.actorKey },
  };
  const rows = await InternalMailThread.find(query)
    .sort({ lastMessageAt: -1 })
    .limit(Math.min(Math.max(Number(limit) || 50, 1), 100))
    .lean();
  return rows.map((row) => serializeThread(row, actor.actorKey));
}

async function threadFor(actor, id, { purpose = "mail" } = {}) {
  if (!mongoose.Types.ObjectId.isValid(String(id || ""))) return null;
  const thread = await InternalMailThread.findOne({
    _id: id,
    ...purposeClause(purpose),
    participantKeys: actor.actorKey,
    deletedFor: { $ne: actor.actorKey },
  }).lean();
  if (!thread) return null;
  const messages = await InternalMailMessage.find({ threadId: thread._id })
    .sort({ createdAt: 1 })
    .limit(500)
    .lean();
  return {
    ...serializeThread(thread, actor.actorKey),
    messages: messages.map((message) => ({
      id: String(message._id),
      senderEmployeeId: message.senderEmployeeId,
      senderName: message.senderName,
      mine: message.senderKey === actor.actorKey,
      body: message.body,
      timestamp: message.createdAt,
    })),
  };
}

async function reply(actor, id, input, { purpose = "mail" } = {}) {
  if (!mongoose.Types.ObjectId.isValid(String(id || ""))) {
    const err = new Error("Invalid conversation ID");
    err.status = 400;
    throw err;
  }
  const body = cleanText(input?.body, 100000);
  if (!body) {
    const err = new Error("Message is required");
    err.status = 400;
    throw err;
  }
  const thread = await InternalMailThread.findOne({
    _id: id,
    participantKeys: actor.actorKey,
    ...purposeClause(purpose),
  });
  if (!thread) return null;
  const now = new Date();
  await InternalMailMessage.create({
    threadId: thread._id,
    senderKey: actor.actorKey,
    senderEmployeeId: actor.employeeId,
    senderName: actor.name,
    body,
    createdAt: now,
  });
  thread.lastMessageAt = now;
  thread.lastMessagePreview = preview(body);
  thread.unreadFor = thread.participantKeys.filter((key) => key !== actor.actorKey);
  thread.archivedFor = [];
  thread.deletedFor = [];
  await thread.save();
  return serializeThread(thread.toObject(), actor.actorKey);
}

async function setThreadState(actor, id, state, { purpose = "mail" } = {}) {
  if (!mongoose.Types.ObjectId.isValid(String(id || ""))) {
    const err = new Error("Invalid conversation ID");
    err.status = 400;
    throw err;
  }
  const operation = {};
  if (typeof state?.read === "boolean") {
    operation[state.read ? "$pull" : "$addToSet"] = { unreadFor: actor.actorKey };
  }
  if (typeof state?.archived === "boolean") {
    const op = state.archived ? "$addToSet" : "$pull";
    operation[op] = { ...(operation[op] || {}), archivedFor: actor.actorKey };
  }
  if (state?.deleted === true) {
    operation.$addToSet = { ...(operation.$addToSet || {}), deletedFor: actor.actorKey };
  }
  if (!Object.keys(operation).length) {
    const err = new Error("No supported state change was supplied");
    err.status = 400;
    throw err;
  }
  return InternalMailThread.findOneAndUpdate(
    { _id: id, participantKeys: actor.actorKey, ...purposeClause(purpose) },
    operation,
    { new: true },
  ).lean();
}

module.exports = { createMessage, listThreads, threadFor, reply, setThreadState, purposeClause };
