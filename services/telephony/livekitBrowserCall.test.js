"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  LiveKitBrowserCall, dialFailureState, outboundNumber, participantAlreadyGone, sipState,
} = require("./livekitBrowserCall");

test("SIP call states map onto the GRAV lifecycle", () => {
  assert.equal(sipState("dialing"), "CUSTOMER_RINGING");
  assert.equal(sipState("active"), "IN_PROGRESS");
  assert.equal(sipState("hangup"), "COMPLETED");
  assert.equal(sipState("unknown"), null);
});

test("an Indian 0-prefixed business number is sent to SIP as E.164", () => {
  assert.equal(outboundNumber("08047093656"), "+918047093656");
});

test("browser call waits for the customer to answer before returning", async () => {
  let dial;
  const service = new LiveKitBrowserCall({
    url: "wss://example.livekit.cloud",
    apiKey: "key",
    apiSecret: "secret",
    outboundTrunkId: "ST_test",
    businessNumber: "+918047093656",
    roomClientFactory: () => ({ createRoom: async () => {}, listParticipants: async () => [] }),
    sipClientFactory: () => ({
      createSipParticipant: async (...args) => {
        dial = args;
        return { participantIdentity: "customer-call", sipCallId: "sip-call-1" };
      },
    }),
  });

  const result = await service.dial({
    roomName: "grav-voice-test",
    customerPhone: "+919123456789",
    participantIdentity: "customer-call",
  });

  assert.deepEqual(dial.slice(0, 3), ["ST_test", "+919123456789", "grav-voice-test"]);
  assert.equal(dial[3].fromNumber, "+918047093656");
  assert.equal(dial[3].waitUntilAnswered, true);
  assert.equal(dial[3].timeout, 50);
  assert.equal(result.sipCallId, "sip-call-1");
});

test("conference members join the existing room with their display name", async () => {
  let dial;
  const service = new LiveKitBrowserCall({
    url: "wss://example.livekit.cloud",
    apiKey: "key",
    apiSecret: "secret",
    outboundTrunkId: "ST_test",
    businessNumber: "+918047093656",
    roomClientFactory: () => ({}),
    sipClientFactory: () => ({
      createSipParticipant: async (...args) => {
        dial = args;
        return { participantIdentity: "conference-one", sipCallId: "sip-conference-1" };
      },
    }),
  });

  await service.dial({
    roomName: "grav-voice-test",
    customerPhone: "+919999999999",
    participantIdentity: "conference-one",
    participantName: "Riya Singh",
  });

  assert.equal(dial[2], "grav-voice-test");
  assert.equal(dial[3].participantName, "Riya Singh");
  assert.equal(dial[3].waitUntilAnswered, true);
});

test("calling stays visibly unavailable without an outbound trunk", () => {
  const service = LiveKitBrowserCall.fromEnv({
    LIVEKIT_URL: "wss://example.livekit.cloud",
    LIVEKIT_API_KEY: "key",
    LIVEKIT_API_SECRET: "secret",
    PLIVO_CALLER_ID: "+918065395337",
  });
  assert.equal(service.configured(), false);
  assert.match(service.setupMessage(), /isn't set up/i);
  // The message is shown to employees, so it never names server variables.
  assert.doesNotMatch(service.setupMessage(), /[A-Z]{3,}_[A-Z_]+/);
});

test("generic line settings remain compatible with the legacy Plivo variable names", () => {
  const legacy = LiveKitBrowserCall.fromEnv({
    LIVEKIT_URL: "wss://example.livekit.cloud",
    LIVEKIT_API_KEY: "key",
    LIVEKIT_API_SECRET: "secret",
    LIVEKIT_PLIVO_SIP_OUTBOUND_TRUNK_ID: "ST_plivo",
    PLIVO_CALLER_ID: "+918065395337",
  });
  assert.equal(legacy.configured(), true);
  assert.equal(legacy.provider, "plivo");
  assert.equal(legacy.outboundTrunkId, "ST_plivo");
  assert.equal(legacy.businessNumber, "+918065395337");
  assert.deepEqual(Object.keys(legacy.describe()).sort(), ["callerId", "configured", "message", "recordingConfigured"]);

  const generic = LiveKitBrowserCall.fromEnv({
    LIVEKIT_URL: "wss://example.livekit.cloud",
    LIVEKIT_API_KEY: "key",
    LIVEKIT_API_SECRET: "secret",
    LIVEKIT_PLIVO_SIP_OUTBOUND_TRUNK_ID: "ST_plivo",
    PLIVO_CALLER_ID: "+918065395337",
    GRAV_VOICE_SIP_OUTBOUND_TRUNK_ID: "ST_grav",
    GRAV_VOICE_CALLER_ID: "08047093656",
  });
  assert.equal(generic.outboundTrunkId, "ST_grav");
  assert.equal(generic.businessNumber, "+918047093656");
});

test("voice settings can move independently to the GRAV Realtime endpoint", () => {
  const service = LiveKitBrowserCall.fromEnv({
    LIVEKIT_URL: "wss://legacy.livekit.cloud",
    LIVEKIT_API_KEY: "legacy-key",
    LIVEKIT_API_SECRET: "legacy-secret",
    GRAV_VOICE_LIVEKIT_URL: "wss://rtc.grav.in",
    GRAV_VOICE_LIVEKIT_API_KEY: "voice-key",
    GRAV_VOICE_LIVEKIT_API_SECRET: "voice-secret",
    GRAV_VOICE_SIP_OUTBOUND_TRUNK_ID: "ST_grav-realtime",
    GRAV_VOICE_CALLER_ID: "+918065395337",
  });

  assert.equal(service.url, "wss://rtc.grav.in");
  assert.equal(service.apiKey, "voice-key");
  assert.equal(service.apiSecret, "voice-secret");
  assert.equal(service.outboundTrunkId, "ST_grav-realtime");
  assert.equal(service.configured(), true);
});

test("a failed dial is classified as busy, no answer, or failed", () => {
  assert.equal(dialFailureState({ metadata: { sip_status_code: "486" } }), "CUSTOMER_BUSY");
  assert.equal(dialFailureState({ metadata: { sip_status_code: "603" } }), "CUSTOMER_BUSY");
  assert.equal(dialFailureState({ metadata: { sip_status_code: "480" } }), "CUSTOMER_NO_ANSWER");
  assert.equal(dialFailureState({ message: "twirp error: call timed out" }), "CUSTOMER_NO_ANSWER");
  assert.equal(dialFailureState({ message: "trunk rejected the request" }), "FAILED");
  assert.equal(dialFailureState(null), "FAILED");
});

test("customer-side hang-up makes participant cleanup idempotent", async () => {
  let removes = 0;
  const service = new LiveKitBrowserCall({
    url: "wss://example.livekit.cloud",
    apiKey: "key",
    apiSecret: "secret",
    outboundTrunkId: "ST_test",
    businessNumber: "+918065395337",
    roomClientFactory: () => ({
      listParticipants: async () => [],
      removeParticipant: async () => { removes += 1; },
    }),
    sipClientFactory: () => ({}),
  });

  assert.deepEqual(await service.hangup({ roomName: "room", participantIdentity: "customer" }), { alreadyEnded: true });
  assert.equal(removes, 0);
  assert.equal(participantAlreadyGone({ code: "NOT_FOUND" }), true);
  assert.equal(participantAlreadyGone({ message: "participant does not exist" }), true);
  assert.equal(participantAlreadyGone({ message: "permission denied" }), false);
});

test("an inbound SIP participant is reduced to the safe ringing envelope", async () => {
  const service = new LiveKitBrowserCall({
    url: "wss://example.livekit.cloud",
    apiKey: "key",
    apiSecret: "secret",
    outboundTrunkId: "ST_test",
    businessNumber: "+918065395337",
    roomClientFactory: () => ({
      listParticipants: async () => [{
        identity: "sip-caller",
        kind: 3,
        name: "+919876543210",
        attributes: {
          "sip.callID": "call-in-1",
          "sip.phoneNumber": "+919876543210",
          "sip.trunkPhoneNumber": "+918065395337",
          "sip.callStatus": "active",
          "private.provider.secret": "must-not-leak",
        },
      }],
    }),
    sipClientFactory: () => ({}),
  });
  assert.deepEqual(await service.incomingCaller({ roomName: "grav-voice-in-user" }), {
    callId: "sip-caller",
    participantIdentity: "sip-caller",
    callerPhone: "+919876543210",
    calledNumber: "+918065395337",
    status: "IN_PROGRESS",
  });
});

test("an inbound SIP participant rings before its asynchronous attributes arrive", async () => {
  const service = new LiveKitBrowserCall({
    url: "wss://example.livekit.cloud",
    apiKey: "key",
    apiSecret: "secret",
    outboundTrunkId: "ST_test",
    businessNumber: "+918065395337",
    roomClientFactory: () => ({
      listParticipants: async () => [{
        identity: "sip-early-caller",
        kind: 3,
        name: "+919876543210",
        attributes: {},
      }],
    }),
    sipClientFactory: () => ({}),
  });

  assert.deepEqual(await service.incomingCaller({ roomName: "grav-voice-in-user" }), {
    callId: "sip-early-caller",
    participantIdentity: "sip-early-caller",
    callerPhone: "+919876543210",
    calledNumber: "+918065395337",
    status: "AGENT_RINGING",
  });
});

test("browser recording captures mixed room audio into GRAV-owned GCP storage", async () => {
  let startArgs;
  const service = new LiveKitBrowserCall({
    url: "wss://example.livekit.cloud",
    apiKey: "key",
    apiSecret: "secret",
    outboundTrunkId: "ST_plivo",
    businessNumber: "+918065395337",
    recordingBucket: "grav-recordings",
    recordingCredentials: "{\"type\":\"service_account\"}",
    roomClientFactory: () => ({}),
    sipClientFactory: () => ({}),
    egressClientFactory: () => ({
      startRoomCompositeEgress: async (...args) => {
        startArgs = args;
        return { egressId: "EG_test", status: 1, fileResults: [] };
      },
    }),
  });

  const result = await service.startRecording({
    roomName: "grav-voice-test",
    storageKey: "grav-voice/company/call.mp3",
  });

  assert.equal(service.recordingConfigured(), true);
  assert.equal(startArgs[0], "grav-voice-test");
  assert.equal(startArgs[1].filepath, "grav-voice/company/call.mp3");
  assert.equal(startArgs[1].fileType, 3);
  assert.equal(startArgs[1].output.case, "gcp");
  assert.equal(startArgs[1].output.value.bucket, "grav-recordings");
  assert.deepEqual(startArgs[2], { audioOnly: true });
  assert.equal(result.egressId, "EG_test");
  assert.equal(result.complete, false);
});

test("completed LiveKit recording exposes only its controlled storage key", async () => {
  const service = new LiveKitBrowserCall({
    url: "wss://example.livekit.cloud",
    apiKey: "key",
    apiSecret: "secret",
    outboundTrunkId: "ST_plivo",
    businessNumber: "+918065395337",
    recordingBucket: "grav-recordings",
    recordingCredentials: "{}",
    roomClientFactory: () => ({}),
    sipClientFactory: () => ({}),
    egressClientFactory: () => ({
      listEgress: async () => [{
        egressId: "EG_done",
        status: 3,
        fileResults: [{ filename: "grav-voice/company/call.mp3", size: 1234n }],
      }],
    }),
  });

  const result = await service.recordingStatus({ egressId: "EG_done" });
  assert.deepEqual(result, {
    egressId: "EG_done",
    status: 3,
    complete: true,
    failed: false,
    storageKey: "grav-voice/company/call.mp3",
    size: 1234,
    error: null,
  });
});
