"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const voice = require("./mrfVoiceApproval.service");

test("feature is disabled by default and names missing dependencies", () => {
  assert.deepEqual(voice.readiness({}), {
    enabled: false, ready: false,
    missing: ["LiveKit URL", "LiveKit API key", "LiveKit API secret", "voice workflow worker name"],
    languages: ["en"],
  });
});

test("readiness requires the named worker as well as LiveKit", () => {
  const base = { MRF_VOICE_APPROVAL_ENABLED: "true", LIVEKIT_URL: "wss://example", LIVEKIT_API_KEY: "k", LIVEKIT_API_SECRET: "s" };
  assert.equal(voice.readiness(base).ready, false);
  assert.deepEqual(voice.readiness({ ...base, MRF_VOICE_AGENT_NAME: "mrf-approval" }), {
    enabled: true, ready: true, missing: [], languages: ["en"],
  });
});

test("only English is offered by default and configured installed languages are deduplicated", () => {
  assert.deepEqual(voice.config({}).languages, ["en"]);
  assert.deepEqual(voice.config({ MRF_VOICE_LANGUAGES: "en,hi,en,or,unsupported" }).languages, ["en", "hi", "or"]);
});

test("voice lab creates an isolated synthetic session and cancels an older active test", async () => {
  const writes = [];
  const SessionModel = {
    async updateMany(filter, update) { writes.push({ filter, update }); },
    async create(input) { return { _id: "507f1f77bcf86cd799439011", ...input, transcript: [] }; },
  };
  const env = {
    MRF_VOICE_APPROVAL_ENABLED: "true",
    LIVEKIT_URL: "wss://example",
    LIVEKIT_API_KEY: "key",
    LIVEKIT_API_SECRET: "secret",
    MRF_VOICE_AGENT_NAME: "mrf-approval",
    MRF_VOICE_LANGUAGES: "en",
  };
  const row = await voice.createTest({
    companyId: "507f1f77bcf86cd799439012",
    biometricId: "CEO001",
    actorName: "Voice Tester",
    language: "en",
    requestedForName: "Ravi Kumar",
    requestedForDept: "Finishing",
    itemSummary: "Blue thread — 8 cones",
    qwenLabInstruction: "Keep replies under twelve words.",
  }, { SessionModel, env });
  assert.equal(row.isTest, true);
  assert.match(row.mrfNumber, /^MRF-TEST-\d{14}$/);
  assert.equal(row.requestedForName, "Ravi Kumar");
  assert.equal(row.requestedForDept, "Finishing");
  assert.equal(row.itemSummary, "Blue thread — 8 cones");
  assert.equal(row.qwenLabInstruction, "Keep replies under twelve words.");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].filter.isTest, true);
  assert.deepEqual(writes[0].filter.status, { $in: voice.ACTIVE });
  assert.equal(writes[0].update.$set.status, "CANCELLED");
});

test("worker no-answer ends only an active call and never creates a decision", async () => {
  let captured;
  const row = {
    _id: "507f1f77bcf86cd799439011",
    mrf: "507f1f77bcf86cd799439012",
    status: "NO_ANSWER",
  };
  const SessionModel = {
    findOneAndUpdate(filter, update, options) {
      captured = { filter, update, options };
      return row;
    },
  };
  const result = await voice.workerNoAnswer({ id: row._id }, { SessionModel });
  assert.equal(result.status, "NO_ANSWER");
  assert.deepEqual(captured.filter.status, { $in: voice.ACTIVE });
  assert.equal(captured.update.$set.status, "NO_ANSWER");
  assert.equal("pendingIntent" in captured.update.$set, false);
  assert.equal(captured.options.new, true);
});

test("Voice Lab records the exact agent text sent to TTS", async () => {
  const row = {
    _id: "507f1f77bcf86cd799439011",
    isTest: true,
    transcript: [],
    async save() {},
  };
  const SessionModel = {
    async findOne(filter) {
      assert.equal(filter.isTest, true);
      return row;
    },
  };
  const result = await voice.workerSpeech({ id: row._id, text: "Hello, can you hear me?" }, { SessionModel });
  assert.deepEqual(row.transcript, [{ speaker: "WORKFLOW", text: "Hello, can you hear me?", intent: "TTS" }]);
  assert.equal(result.transcript[0].text, "Hello, can you hear me?");
});

test("Voice Lab records Qwen input and output separately from final TTS", async () => {
  const row = {
    _id: "507f1f77bcf86cd799439011",
    isTest: true,
    transcript: [],
    async save() {},
  };
  const SessionModel = { async findOne(filter) { assert.equal(filter.isTest, true); return row; } };
  await voice.workerDialog({
    id: row._id,
    direction: "INPUT",
    text: '{"callerText":"not sure about this"}',
  }, { SessionModel });
  const result = await voice.workerDialog({
    id: row._id,
    direction: "OUTPUT",
    text: '{"reply":"Would you like more time?","candidateIntent":"DEFER"}',
    intent: "DEFER",
    confidence: 0.91,
  }, { SessionModel });
  assert.equal(row.transcript[0].speaker, "QWEN");
  assert.equal(row.transcript[0].intent, "QWEN_INPUT");
  assert.equal(row.transcript[1].intent, "QWEN_OUTPUT:DEFER");
  assert.equal(row.transcript[1].confidence, 0.91);
  assert.equal(result.transcript.length, 2);
});

test("normal incoming-call polling never surfaces IT Voice Lab sessions", async () => {
  let filter;
  const query = {
    sort() { return null; },
  };
  const SessionModel = {
    findOne(value) { filter = value; return query; },
  };
  const result = await voice.incoming({ companyId: "company", biometricId: "CEO001" }, { SessionModel });
  assert.equal(result, null);
  assert.deepEqual(filter.isTest, { $ne: true });
});

test("voice lab can recover its active ringing test after a page reload", async () => {
  const now = new Date("2026-10-14T04:20:00.000Z");
  let staleFilter;
  let activeFilter;
  const row = {
    _id: "507f1f77bcf86cd799439011",
    isTest: true,
    status: "RINGING",
    expiresAt: new Date("2026-10-14T05:00:00.000Z"),
  };
  const SessionModel = {
    async updateMany(filter) { staleFilter = filter; },
    findOne(filter) {
      activeFilter = filter;
      return { sort: async () => row };
    },
  };
  const result = await voice.activeTest({ companyId: "company", biometricId: "CEO001" }, { SessionModel, now });
  assert.equal(result.id, row._id);
  assert.deepEqual(staleFilter.expiresAt, { $lte: now });
  assert.deepEqual(activeFilter.expiresAt, { $gt: now });
  assert.equal(activeFilter.isTest, true);
});

test("enqueue sends one short-lived call push to the assigned approver", async () => {
  const pushes = [];
  const row = {
    _id: "507f1f77bcf86cd799439099",
    status: "QUEUED",
  };
  const SessionModel = {
    async findOne() { return null; },
    async create() { return row; },
  };
  const mrf = {
    _id: "507f1f77bcf86cd799439012",
    companyId: "507f1f77bcf86cd799439013",
    mrfNumber: "MRF-1042",
    approverEmployee: "507f1f77bcf86cd799439014",
    approverBiometricId: "CEO001",
    requestedForName: "Anita Das",
    status: "PENDING",
    items: [{ rawItemName: "Needles", requestedQty: 4, unit: "boxes", approvalStatus: "PENDING" }],
  };
  const result = await voice.enqueue(mrf, {
    SessionModel,
    env: { MRF_VOICE_APPROVAL_ENABLED: "true" },
    async notifyEmployeeDevices(employee, payload) { pushes.push({ employee, payload }); },
  });
  assert.equal(result, row);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].employee, mrf.approverEmployee);
  assert.equal(pushes[0].payload.type, "mrf_voice_call");
  assert.equal(pushes[0].payload.ttlSeconds, 120);
  assert.equal(pushes[0].payload.tag, `mrf-call-${row._id}`);
  assert.match(pushes[0].payload.url, new RegExp(`mrfVoiceCall=${row._id}$`));
  assert.equal(pushes[0].payload.data.mrfNumber, "MRF-1042");
});

test("a user-confirmed Qwen candidate advances through the deterministic workflow", async () => {
  const row = {
    _id: "507f1f77bcf86cd799439011",
    mrf: "507f1f77bcf86cd799439012",
    mrfNumber: "VOICE-LAB-TEST",
    status: "AWAITING_INTENT",
    pendingIntent: "",
    rejectionReason: "",
    transcript: [],
    async save() {},
  };
  const SessionModel = { async findOne() { return row; } };
  const result = await voice.workerTurn({
    id: row._id,
    text: "Yes, that is what I meant",
    phase: "SEMANTIC_CONFIRMATION",
    semanticIntent: "REJECT",
    confidence: 0.87,
  }, { SessionModel });
  assert.equal(result.action, "ASK_REJECTION_REASON");
  assert.equal(row.pendingIntent, "REJECT");
  assert.equal(row.status, "AWAITING_INTENT");
  assert.equal(row.transcript[0].text, "Yes, that is what I meant");
  assert.equal(row.transcript[0].intent, "REJECT");
  assert.equal(row.transcript[0].confidence, 0.87);
});

test("morning brief turns remain read-only and can complete naturally", async () => {
  const row = {
    _id: "507f1f77bcf86cd799439011",
    workflowKey: "morning_brief",
    subjectLabel: "Morning brief · 2026-10-13",
    workflowTitle: "Your GRAV morning brief",
    workflowSummary: "You have two meetings and one approval waiting.",
    status: "AWAITING_INTENT",
    transcript: [],
    async save() {},
  };
  const SessionModel = { async findOne() { return row; } };
  const result = await voice.workerTurn({
    id: row._id,
    text: "Thanks, that's all for now",
  }, { SessionModel });
  assert.equal(result.action, "END_BRIEF");
  assert.equal(row.status, "COMPLETED");
  assert.equal(row.transcript[0].intent, "COMPLETE");
  assert.equal(row.pendingIntent, undefined);
});
