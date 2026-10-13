"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { actorSelector, assignedVoiceLine, e164, membershipSelector, safeRoomName, voiceOwnerByNumber } = require("./voiceLineAssignment");

const noMembership = { findOne: () => ({ lean: async () => null }) };

test("voice numbers are normalized and room names are bounded", () => {
  assert.equal(e164("98765 43210"), "+919876543210");
  assert.equal(e164("+1 415 555 2671"), "+14155552671");
  assert.equal(e164("not-a-phone"), null);
  assert.equal(safeRoomName("grav-voice-user-1"), "grav-voice-user-1");
  assert.equal(safeRoomName("bad room"), null);
});

test("the actor lookup never becomes an unscoped roster query", () => {
  assert.equal(actorSelector({}), null);
  assert.deepEqual(actorSelector({ id: "abc", employeeId: "GR1", email: " User@Example.com " }), {
    active: true,
    $or: [{ employeeRef: "abc" }, { employeeCode: "GR1" }, { email: "user@example.com" }],
  });
  assert.equal(membershipSelector({}), null);
  assert.deepEqual(membershipSelector({ email: " CEO@GRAV.IN " }), {
    isActive: true,
    $or: [{ email: "ceo@grav.in" }],
  });
});

test("each actor receives only the DID stored on their own roster row", async () => {
  const rows = {
    one: { _id: "one", active: true, voiceEnabled: true, voiceNumber: "+919111111111", voiceOutboundTrunkId: "ST_one" },
    two: { _id: "two", active: true, voiceEnabled: true, voiceNumber: "+919222222222", voiceOutboundTrunkId: "ST_two" },
  };
  const SalesPersonModel = {
    findOne(selector) {
      const id = selector.$or.find((item) => item.employeeRef)?.employeeRef;
      return { lean: async () => rows[id] || null };
    },
  };
  const env = { LIVEKIT_URL: "wss://voice.example", LIVEKIT_API_KEY: "key", LIVEKIT_API_SECRET: "secret" };
  const first = await assignedVoiceLine({ id: "one" }, { SalesPersonModel, MembershipModel: noMembership, env });
  const second = await assignedVoiceLine({ id: "two" }, { SalesPersonModel, MembershipModel: noMembership, env });
  assert.equal(first.number, "+919111111111");
  assert.equal(first.line.businessNumber, "+919111111111");
  assert.equal(first.line.outboundTrunkId, "ST_one");
  assert.equal(second.number, "+919222222222");
  assert.equal(second.line.businessNumber, "+919222222222");
  assert.notEqual(first.number, second.number);
});

test("Voice-specific LiveKit credentials do not migrate unrelated LiveKit features", async () => {
  const owner = {
    _id: "507f1f77bcf86cd799439011",
    active: true,
    voiceEnabled: true,
    voiceNumber: "+918065395337",
    voiceOutboundTrunkId: "ST_outbound",
    voiceInboundTrunkId: "ST_inbound",
    voiceInboundRoomName: "grav-voice-in-ceo12345",
  };
  const result = await assignedVoiceLine({ email: "ceo@grav.in" }, {
    SalesPersonModel: { findOne: () => ({ lean: async () => owner }) },
    MembershipModel: { findOne: () => ({ lean: async () => null }) },
    env: {
      LIVEKIT_URL: "wss://legacy.livekit.cloud",
      LIVEKIT_API_KEY: "legacy-key",
      LIVEKIT_API_SECRET: "legacy-secret",
      GRAV_VOICE_LIVEKIT_URL: "wss://voice.livekit.cloud",
      GRAV_VOICE_LIVEKIT_API_KEY: "voice-key",
      GRAV_VOICE_LIVEKIT_API_SECRET: "voice-secret",
    },
  });
  assert.equal(result.line.url, "wss://voice.livekit.cloud");
  assert.equal(result.line.apiKey, "voice-key");
  assert.equal(result.line.apiSecret, "voice-secret");
});

test("an unassigned user cannot inherit the old shared caller ID", async () => {
  const SalesPersonModel = { findOne: () => ({ lean: async () => null }) };
  const result = await assignedVoiceLine({ id: "missing" }, {
    SalesPersonModel,
    MembershipModel: noMembership,
    env: { PLIVO_CALLER_ID: "+918065395337", LIVEKIT_PLIVO_SIP_OUTBOUND_TRUNK_ID: "ST_shared" },
  });
  assert.equal(result.assigned, false);
  assert.equal(result.configured, false);
  assert.equal(result.line, undefined);
});

test("a company member without an Employee row can own a Voice line", async () => {
  const MembershipModel = {
    findOne(selector) {
      assert.equal(selector.$or[0].email, "ceo@grav.in");
      return { lean: async () => ({
        _id: "membership",
        email: "ceo@grav.in",
        isActive: true,
        voiceEnabled: true,
        voiceNumber: "+918065395337",
        voiceOutboundTrunkId: "ST_out",
        voiceInboundTrunkId: "ST_in",
        voiceInboundRoomName: "grav-voice-in-ceo0001",
      }) };
    },
  };
  const SalesPersonModel = { findOne: () => { throw new Error("membership assignment must win"); } };
  const result = await assignedVoiceLine({ email: "ceo@grav.in" }, {
    MembershipModel,
    SalesPersonModel,
    env: { LIVEKIT_URL: "wss://voice.example", LIVEKIT_API_KEY: "key", LIVEKIT_API_SECRET: "secret" },
  });
  assert.equal(result.assigned, true);
  assert.equal(result.ownerKind, "company_membership");
  assert.equal(result.salesPersonOwnerId, null);
  assert.equal(result.number, "+918065395337");
  assert.equal(result.inboundConfigured, true);
});

test("an inbound DID resolves to its active company member", async () => {
  const MembershipModel = {
    findOne(selector) {
      assert.deepEqual(selector.voiceNumber.$in, ["+918065395337", "918065395337"]);
      return { lean: async () => ({ _id: "ceo", email: "ceo@grav.in", voiceEnabled: true }) };
    },
  };
  const SalesPersonModel = { findOne: () => { throw new Error("membership assignment must win"); } };
  const result = await voiceOwnerByNumber("918065395337", { MembershipModel, SalesPersonModel });
  assert.equal(result.number, "+918065395337");
  assert.equal(result.ownerKind, "company_membership");
  assert.equal(result.owner.email, "ceo@grav.in");
});

test("an invalid inbound DID never performs a roster lookup", async () => {
  const forbidden = { findOne: () => { throw new Error("must not query"); } };
  assert.equal(await voiceOwnerByNumber("invalid", { MembershipModel: forbidden, SalesPersonModel: forbidden }), null);
});
