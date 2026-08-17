// test/crm/whatsapp-webhook.route.test.js
//
// The public WhatsApp webhook: the GET verification handshake, and that a POST
// stores inbound messages idempotently + applies delivery statuses. Storage is
// asserted by calling the store directly (the route answers 200 before it
// finishes processing, by design — Meta only wants a fast ack).
"use strict";

process.env.WHATSAPP_VERIFY_TOKEN = "test-verify-token";
delete process.env.WHATSAPP_APP_SECRET; // skip signature checks in the route test

const express = require("express");
const { cfg, verifySignature } = require("../../config/whatsapp");
const { ingestWebhook } = require("../../services/whatsappStore");
const WhatsAppConversation = require("../../models/CMS_Models/Sales/WhatsAppConversation");
const { WhatsAppMessage } = require("../../models/CMS_Models/Sales/WhatsAppMessage");

let server, base;
beforeAll(async () => {
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use("/api/whatsapp/webhook", require("../../routes/CMS_Routes/Sales/whatsappWebhook"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/whatsapp/webhook`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const inboundText = (waId, body, msgId) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "WABA", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp",
    metadata: { display_phone_number: "15550000000", phone_number_id: "PNID" },
    contacts: [{ profile: { name: "Test Customer" }, wa_id: waId }],
    messages: [{ from: waId, id: msgId, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } }],
  } }] }],
});

describe("GET /webhook — subscription verification", () => {
  test("echoes the challenge when the verify token matches", async () => {
    const res = await fetch(`${base}?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=CHALLENGE_123`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("CHALLENGE_123");
  });
  test("403s when the verify token is wrong", async () => {
    const res = await fetch(`${base}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=X`);
    expect(res.status).toBe(403);
  });
});

describe("POST /webhook — returns 200 fast", () => {
  test("always acknowledges with 200", async () => {
    const res = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(inboundText("919000000001", "Hi", "wamid.A1")) });
    expect(res.status).toBe(200);
  });
});

describe("ingestWebhook — storage", () => {
  test("an inbound text creates the conversation + message, sets the window and unread", async () => {
    await ingestWebhook(inboundText("919000000010", "I want 50 shirts", "wamid.B1"));
    const conv = await WhatsAppConversation.findOne({ waId: "919000000010" }).lean();
    expect(conv).toBeTruthy();
    expect(conv.displayName).toBe("Test Customer");
    expect(conv.lastMessagePreview).toBe("I want 50 shirts");
    expect(conv.lastDirection).toBe("incoming");
    expect(conv.unreadCount).toBe(1);
    expect(new Date(conv.windowExpiresAt).getTime()).toBeGreaterThan(Date.now());
    const msgs = await WhatsAppMessage.find({ conversationId: conv._id }).lean();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].direction).toBe("incoming");
    expect(msgs[0].text).toBe("I want 50 shirts");
  });

  test("a retried webhook (same message id) does NOT duplicate", async () => {
    await ingestWebhook(inboundText("919000000020", "First", "wamid.C1"));
    await ingestWebhook(inboundText("919000000020", "First", "wamid.C1")); // retry
    const conv = await WhatsAppConversation.findOne({ waId: "919000000020" }).lean();
    expect(await WhatsAppMessage.countDocuments({ conversationId: conv._id })).toBe(1);
  });

  test("a status update flips an outbound message's status", async () => {
    const conv = await WhatsAppConversation.create({ waId: "919000000030", phone: "+919000000030" });
    await WhatsAppMessage.create({ conversationId: conv._id, waId: "919000000030", waMessageId: "wamid.OUT1", direction: "outgoing", type: "text", text: "Quotation ready", status: "sent" });
    await ingestWebhook({
      object: "whatsapp_business_account",
      entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: {}, statuses: [{ id: "wamid.OUT1", status: "delivered", timestamp: "1", recipient_id: "919000000030" }] } }] }],
    });
    const msg = await WhatsAppMessage.findOne({ waMessageId: "wamid.OUT1" }).lean();
    expect(msg.status).toBe("delivered");
  });
});

describe("verifySignature", () => {
  test("skips when no app secret is set", () => {
    cfg.appSecret = "";
    expect(verifySignature(Buffer.from("{}"), null)).toBe(true);
  });
  test("validates a correct HMAC and rejects a wrong one", () => {
    const crypto = require("crypto");
    cfg.appSecret = "shhh";
    const body = Buffer.from(JSON.stringify({ a: 1 }));
    const good = "sha256=" + crypto.createHmac("sha256", "shhh").update(body).digest("hex");
    expect(verifySignature(body, good)).toBe(true);
    expect(verifySignature(body, "sha256=deadbeef")).toBe(false);
    cfg.appSecret = "";
  });
});
