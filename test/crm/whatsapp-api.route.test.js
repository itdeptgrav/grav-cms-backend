// test/crm/whatsapp-api.route.test.js
//
// The authenticated CRM WhatsApp API: config, start-a-chat, list, thread, read,
// and send (with `fetch` to Meta mocked, and the 24-hour window enforced).
"use strict";

process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "PNID";
process.env.WHATSAPP_API_VERSION = "v21.0";

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/SalesAuthMiddlewear", () => (req, res, next) => {
  const raw = req.headers["x-test-user"];
  if (!raw) return res.status(401).json({ success: false, message: "Auth required." });
  req.user = JSON.parse(raw);
  next();
});

const WhatsAppConversation = require("../../models/CMS_Models/Sales/WhatsAppConversation");
const { WhatsAppMessage } = require("../../models/CMS_Models/Sales/WhatsAppMessage");

const USER = { id: new mongoose.Types.ObjectId().toString(), name: "Anita Rao", role: "sales" };

let server, base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/crm/whatsapp", require("../../routes/CMS_Routes/Sales/whatsapp"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/crm/whatsapp`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
beforeEach(() => { global.fetch = jest.fn(); });

async function call(path, { method = "GET", body, user = USER } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(user ? { "x-test-user": JSON.stringify(user) } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}
// NOTE: `call` uses the real fetch; the mock is only for the ROUTE's outbound
// call to Meta. Restore the real one for the test's own HTTP calls.
const realFetch = global.fetch;

describe("WhatsApp CRM API", () => {
  test("GET /config reports it can send", async () => {
    global.fetch = realFetch;
    const { status, body } = await call("/config");
    expect(status).toBe(200);
    expect(body.canSend).toBe(true);
  });

  test("POST /start finds-or-creates a conversation for a phone, then GET /conversations lists it", async () => {
    global.fetch = realFetch;
    const start = await call("/start", { method: "POST", body: { phone: "+91 98765 43210", name: "ABC Hotels" } });
    expect(start.status).toBe(200);
    expect(start.body.conversation.waId).toBe("919876543210");
    // Idempotent — same number returns the same conversation.
    const again = await call("/start", { method: "POST", body: { phone: "9876543210" } });
    expect(again.body.conversation._id).toBe(start.body.conversation._id);

    const list = await call("/conversations");
    expect(list.body.conversations.some((c) => c.waId === "919876543210")).toBe(true);
    expect(await WhatsAppConversation.countDocuments({ waId: "919876543210" })).toBe(1);
  });

  test("send outside the 24-hour window is refused with 409", async () => {
    global.fetch = realFetch;
    const { body: { conversation } } = await call("/start", { method: "POST", body: { phone: "919000001111" } });
    const send = await call(`/conversations/${conversation._id}/send`, { method: "POST", body: { text: "Hi" } });
    expect(send.status).toBe(409);
    expect(send.body.code).toBe("window_closed");
  });

  test("send inside the window posts to Meta and stores the outbound message", async () => {
    const conv = await WhatsAppConversation.create({ waId: "919000002222", phone: "+919000002222", windowExpiresAt: new Date(Date.now() + 3600e3) });

    // Mock Meta's send response for the ROUTE's outbound call.
    const metaMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ messages: [{ id: "wamid.SENT1" }] }) });

    // Swap in the mock only for the duration of the CRM call. `call` restores
    // real fetch first (for its own HTTP), then we let the route use the mock.
    global.fetch = realFetch;
    const doSend = () =>
      new Promise(async (resolve) => {
        // Temporarily route the ROUTE's fetch (same global) — but our own HTTP
        // call also uses it, so we count invocations and treat the graph.facebook
        // one specially.
        resolve(await call(`/conversations/${conv._id}/send`, { method: "POST", body: { text: "Your quotation is ready." } }));
      });

    // Replace global.fetch with a router that mocks graph.facebook.com and
    // proxies everything else to the real fetch.
    global.fetch = (url, opts) => {
      if (String(url).includes("graph.facebook.com")) return metaMock(url, opts);
      return realFetch(url, opts);
    };

    const send = await doSend();
    expect(send.status).toBe(201);
    expect(metaMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOpts] = metaMock.mock.calls[0];
    expect(String(calledUrl)).toContain("/PNID/messages");
    expect(JSON.parse(calledOpts.body).to).toBe("919000002222");

    const stored = await WhatsAppMessage.findOne({ waMessageId: "wamid.SENT1" }).lean();
    expect(stored.direction).toBe("outgoing");
    expect(stored.text).toBe("Your quotation is ready.");
    const after = await WhatsAppConversation.findById(conv._id).lean();
    expect(after.lastDirection).toBe("outgoing");

    global.fetch = realFetch;
  });

  test("GET /messages returns the thread and /read clears unread", async () => {
    global.fetch = realFetch;
    const conv = await WhatsAppConversation.create({ waId: "919000003333", phone: "+919000003333", unreadCount: 2 });
    await WhatsAppMessage.create({ conversationId: conv._id, waId: conv.waId, direction: "incoming", type: "text", text: "Hello", timestamp: new Date() });

    const thread = await call(`/conversations/${conv._id}/messages`);
    expect(thread.body.messages).toHaveLength(1);

    await call(`/conversations/${conv._id}/read`, { method: "POST" });
    expect((await WhatsAppConversation.findById(conv._id).lean()).unreadCount).toBe(0);
  });
});
