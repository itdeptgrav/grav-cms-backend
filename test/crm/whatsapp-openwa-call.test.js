"use strict";

const mongoose = require("mongoose");
const CallEvent = require("../../models/CallEvent");
const WhatsAppConversation = require("../../models/CMS_Models/Sales/WhatsAppConversation");
const { cfg } = require("../../config/whatsappProvider");
const { ingestOpenWaCallWebhook, parseOpenWaCall } = require("../../services/openwaCallStore");

const COMPANY_ID = new mongoose.Types.ObjectId();

const event = ({ state, at, id = "call-1", outgoing = false, offerTime = 1791808000, peerJid = "919876543210@c.us", isVideo = false }) => ({
  event: "call.state",
  sessionId: "sales",
  timestamp: at,
  payload: { call: { id, peerJid, offerTime, outgoing, isVideo, isGroup: false, State: state, ownerPhone: "919111111111" } },
});

beforeEach(() => { cfg.openwaCompanyId = String(COMPANY_ID); });

test("normalises the stable-v4 OpenWA call shape", () => {
  const parsed = parseOpenWaCall({
    event: "onCallState",
    timestamp: 1791808005000,
    data: { id: "abc", peerJid: "919000000001@c.us", offerTime: 1791808000, outgoing: false, State: "INCOMING_RING" },
  });
  expect(parsed).toMatchObject({ id: "abc", state: "INCOMING_RING", phoneNumber: "919000000001", startTime: 1791808000000, outgoing: false });
});

test("one answered call keeps one row and calculates connected duration only", async () => {
  await WhatsAppConversation.create({ waId: "919876543210", phone: "+919876543210", displayName: "Ramesh" });
  await ingestOpenWaCallWebhook(event({ state: "INCOMING_RING", at: 1791808000000 }));
  await ingestOpenWaCallWebhook(event({ state: "ACTIVE", at: 1791808005000 }));
  await ingestOpenWaCallWebhook(event({ state: "ENDED", at: 1791808035500 }));
  // A retried terminal event updates the same provider identity.
  await ingestOpenWaCallWebhook(event({ state: "ENDED", at: 1791808035500 }));

  const rows = await CallEvent.find({ provider: "openwa", providerCallId: "call-1" }).lean();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    contactName: "Ramesh",
    direction: "INCOMING",
    callType: "INCOMING",
    received: true,
    rejected: false,
    connectedAt: 1791808005000,
    endTime: 1791808035500,
    durationSec: 31,
    providerEventState: "ENDED",
    ownerPhone: "+919111111111",
  });
});

test("a rejected call is not counted as received or talk time", async () => {
  await ingestOpenWaCallWebhook(event({ id: "call-rejected", state: "INCOMING_RING", at: 1791809000000 }));
  await ingestOpenWaCallWebhook(event({ id: "call-rejected", state: "REJECTED", at: 1791809004000 }));
  const row = await CallEvent.findOne({ providerCallId: "call-rejected" }).lean();
  expect(row).toMatchObject({ callType: "REJECTED", received: false, rejected: true, durationSec: 0, endTime: 1791809004000 });
});

test("an unanswered outgoing video call is retained as missed", async () => {
  await ingestOpenWaCallWebhook(event({ id: "call-missed", state: "OUTGOING_CALLING", at: 1791810000000, outgoing: true, isVideo: true }));
  await ingestOpenWaCallWebhook(event({ id: "call-missed", state: "NOT_ANSWERED", at: 1791810010000, outgoing: true, isVideo: true }));
  const row = await CallEvent.findOne({ providerCallId: "call-missed" }).lean();
  expect(row).toMatchObject({ direction: "OUTGOING", callType: "MISSED", received: false, rejected: false, durationSec: 0, isVideoCall: true });
});
