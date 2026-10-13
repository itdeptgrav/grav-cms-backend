"use strict";

const mongoose = require("mongoose");
const CallEvent = require("../models/CallEvent");
const WhatsAppConversation = require("../models/CMS_Models/Sales/WhatsAppConversation");
const { cfg } = require("../config/whatsappProvider");

const TERMINAL_STATES = new Set(["ENDED", "REJECTED", "NOT_ANSWERED", "FAILED"]);
const INCOMING_STATES = new Set(["INCOMING_RING"]);
const OUTGOING_STATES = new Set(["OUTGOING_RING", "OUTGOING_CALLING"]);

const digits = (value) => String(value || "").replace(/\D/g, "");
const peerNumber = (value) => digits(String(value || "").split("@")[0]);

const eventTime = (body) => {
  const raw = Number(body?.timestamp || Date.now());
  return Number.isFinite(raw) && raw > 0 ? (raw < 1e12 ? raw * 1000 : raw) : Date.now();
};

const offerTime = (call, fallback) => {
  const raw = Number(call?.offerTime);
  return Number.isFinite(raw) && raw > 0 ? (raw < 1e12 ? raw * 1000 : raw) : fallback;
};

function parseOpenWaCall(body) {
  const event = String(body?.event || body?.eventName || "").toLowerCase();
  if (event && !["call.state", "call.state.changed", "oncallstate", "call"].includes(event)) return null;
  const call = body?.payload?.call || body?.data?.call || body?.data || body?.call;
  if (!call || typeof call !== "object") return null;

  const id = String(call.id || "").trim();
  const state = String(call.State || call.state || "").trim().toUpperCase();
  const phoneNumber = peerNumber(call.peerJid || call.peerId || call.from || call.to);
  if (!id || !state || !phoneNumber) return null;

  const at = eventTime(body);
  return {
    id,
    state,
    phoneNumber,
    at,
    startTime: offerTime(call, at),
    outgoing: call.outgoing === true || OUTGOING_STATES.has(state),
    sessionId: String(body?.sessionId || cfg.openwaSessionId || "sales"),
    ownerPhone: digits(call.ownerPhone),
    isVideo: call.isVideo === true,
    isGroup: call.isGroup === true,
  };
}

async function contactNameFor(phoneNumber) {
  const tail = digits(phoneNumber).slice(-10);
  if (!tail) return null;
  const row = await WhatsAppConversation.findOne({ waId: { $regex: `${tail}$` } }).select("displayName").lean();
  return row?.displayName || null;
}

function companyIdForCalls() {
  const value = String(cfg.openwaCompanyId || "").trim();
  if (!mongoose.isValidObjectId(value)) {
    const error = new Error("OPENWA_COMPANY_ID must identify the company that owns the linked Sales WhatsApp number.");
    error.code = "openwa_company_not_configured";
    throw error;
  }
  return new mongoose.Types.ObjectId(value);
}

async function ingestOpenWaCallWebhook(body) {
  const call = parseOpenWaCall(body);
  if (!call) return { calls: 0, ignored: 1 };

  const companyId = companyIdForCalls();
  const direction = call.outgoing ? "OUTGOING" : "INCOMING";
  const contactName = await contactNameFor(call.phoneNumber);
  const base = {
    companyId,
    provider: "openwa",
    providerCallId: call.id,
    providerDirection: call.outgoing ? "outbound_browser" : "inbound",
    source: "openwa",
    kind: "call",
    phoneNumber: `+${call.phoneNumber}`,
    direction,
    callType: direction,
    received: false,
    rejected: false,
    durationSec: 0,
    startTime: call.startTime,
    recordingSync: { status: "not_expected" },
    ...(contactName ? { contactName } : {}),
    ...(call.ownerPhone ? { ownerPhone: `+${call.ownerPhone}` } : {}),
  };

  let row;
  try {
    row = await CallEvent.findOneAndUpdate(
      { companyId, provider: "openwa", providerCallId: call.id },
      {
        $setOnInsert: base,
        $set: {
          providerEventState: call.state,
          providerSessionId: call.sessionId,
          isVideoCall: call.isVideo,
          isGroupCall: call.isGroup,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } catch (error) {
    // Two identical first events can race. The unique provider identity is the
    // authority; retry as an ordinary update instead of creating two calls.
    if (error?.code !== 11000) throw error;
    row = await CallEvent.findOne({ companyId, provider: "openwa", providerCallId: call.id });
  }

  if (!row) return { calls: 0, ignored: 1 };

  if (INCOMING_STATES.has(call.state)) {
    row.direction = "INCOMING";
    if (!row.received && !row.rejected) row.callType = "INCOMING";
  } else if (OUTGOING_STATES.has(call.state)) {
    row.direction = "OUTGOING";
    if (!row.received && !row.rejected) row.callType = "OUTGOING";
  } else if (call.state === "ACTIVE") {
    row.received = true;
    row.rejected = false;
    row.connectedAt = row.connectedAt || call.at;
    row.callType = row.direction === "OUTGOING" ? "OUTGOING" : "INCOMING";
  } else if (call.state === "HANDLED_REMOTELY") {
    row.received = true;
    row.rejected = false;
    row.connectedAt = row.connectedAt || call.at;
    row.callType = "ANSWERED_EXTERNALLY";
  } else if (call.state === "REJECTED") {
    if (!row.received) {
      row.rejected = true;
      row.callType = "REJECTED";
    }
  } else if (call.state === "NOT_ANSWERED") {
    if (!row.received) row.callType = "MISSED";
  } else if (call.state === "FAILED") {
    if (!row.received) row.callType = "UNKNOWN";
  }

  if (TERMINAL_STATES.has(call.state)) {
    row.endTime = Math.max(Number(row.endTime || 0), call.at);
    row.durationSec = row.connectedAt
      ? Math.max(0, Math.round((row.endTime - Number(row.connectedAt)) / 1000))
      : 0;
  }

  row.providerEventState = call.state;
  await row.save();
  return { calls: 1, ignored: 0, callId: String(row._id), state: call.state };
}

module.exports = { ingestOpenWaCallWebhook, parseOpenWaCall, companyIdForCalls };
