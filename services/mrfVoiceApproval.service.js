"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");
/* livekit-server-sdk is required where it is used: loading it at the top made every server start pay for it. */
const Session = require("../models/MrfVoiceApprovalSession");
const itemApproval = require("./mrfItemApproval.service");
const intent = require("./mrfVoiceIntent.service");
const { notifyEmployeeDevices } = require("./notifyDevices.service");

const ACTIVE = ["QUEUED", "RINGING", "CONNECTED", "AWAITING_INTENT", "AWAITING_CONFIRMATION"];
const asHttp = (url) => String(url || "").trim().replace(/^wss:/, "https:").replace(/^ws:/, "http:").replace(/\/+$/, "");
const flag = (value) => ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());

function config(env = process.env) {
  const languages = String(env.MRF_VOICE_LANGUAGES || "en")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => ["en", "hi", "or"].includes(value));
  return {
    enabled: flag(env.MRF_VOICE_APPROVAL_ENABLED),
    url: String(env.GRAV_VOICE_LIVEKIT_URL || env.LIVEKIT_URL || "").trim(),
    apiKey: String(env.GRAV_VOICE_LIVEKIT_API_KEY || env.LIVEKIT_API_KEY || "").trim(),
    apiSecret: String(env.GRAV_VOICE_LIVEKIT_API_SECRET || env.LIVEKIT_API_SECRET || "").trim(),
    agentName: String(env.MRF_VOICE_AGENT_NAME || "").trim(),
    languages: [...new Set(languages.length ? languages : ["en"])],
  };
}

function readiness(env = process.env) {
  const cfg = config(env);
  const missing = [];
  if (!cfg.url) missing.push("LiveKit URL");
  if (!cfg.apiKey) missing.push("LiveKit API key");
  if (!cfg.apiSecret) missing.push("LiveKit API secret");
  if (!cfg.agentName) missing.push("voice workflow worker name");
  return { enabled: cfg.enabled, ready: cfg.enabled && missing.length === 0, missing, languages: cfg.languages };
}

function publicView(row) {
  if (!row) return null;
  return {
    id: String(row._id),
    workflowKey: row.workflowKey || "mrf_approval",
    mrfId: row.mrf ? String(row.mrf) : null,
    mrfNumber: row.mrfNumber || "",
    subjectLabel: row.subjectLabel || "",
    workflowTitle: row.workflowTitle || "",
    workflowSummary: row.workflowSummary || "",
    requestedForName: row.requestedForName, approverName: row.approverName,
    requestedForDept: row.requestedForDept || "", itemSummary: row.itemSummary || "",
    language: row.language, supportedLanguages: config().languages,
    isTest: Boolean(row.isTest),
    status: row.status, createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    ...(row.isTest ? {
      qwenLabInstruction: row.qwenLabInstruction || "",
      transcript: (row.transcript || []).map((entry) => ({
        at: entry.at, speaker: entry.speaker, text: entry.text,
        intent: entry.intent || "", confidence: entry.confidence,
      })),
    } : {}),
    ...(row.status === "DECISION_READY" ? {
      confirmedDecision: row.pendingIntent,
      rejectionReason: row.pendingIntent === "REJECT" ? row.rejectionReason : "",
    } : {}),
  };
}

async function createTest({
  companyId, biometricId, actorName, language = "en", requestedForName,
  requestedForDept, itemSummary, qwenLabInstruction,
}, { SessionModel = Session, env = process.env } = {}) {
  const state = readiness(env);
  if (!state.ready) {
    const error = new Error(`MRF voice approval is not ready: ${state.missing.join(", ")}.`);
    error.code = "MRF_VOICE_NOT_READY";
    throw error;
  }
  const selected = String(language || "en").toLowerCase();
  if (!config(env).languages.includes(selected)) {
    const error = new Error("That voice language is not currently installed.");
    error.code = "MRF_VOICE_LANGUAGE_UNAVAILABLE";
    throw error;
  }
  const approverBiometricId = String(biometricId || "").trim();
  if (!companyId || !approverBiometricId) {
    const error = new Error("Your employee record needs a company and biometric ID before the voice lab can call you.");
    error.code = "MRF_VOICE_TEST_IDENTITY_MISSING";
    throw error;
  }
  await SessionModel.updateMany(
    { companyId, approverBiometricId, isTest: true, status: { $in: ACTIVE } },
    { $set: { status: "CANCELLED", completedAt: new Date() } },
  );
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return SessionModel.create({
    companyId,
    // Deliberately not an MRF document. Test completion changes this session
    // only; the IT route never calls the material-request approval command.
    mrf: new mongoose.Types.ObjectId(),
    mrfNumber: `MRF-TEST-${stamp}`,
    approverBiometricId,
    approverName: actorName || "IT voice tester",
    requestedForName: String(requestedForName || "Anita Das").trim().slice(0, 160),
    requestedForDept: String(requestedForDept || "Production").trim().slice(0, 160),
    itemSummary: String(itemSummary || "Industrial sewing needles — 4 boxes; packing tape — 12 rolls; machine oil — 2 cans").trim().slice(0, 500),
    qwenLabInstruction: String(qwenLabInstruction || "").trim().slice(0, 1200),
    isTest: true,
    language: selected,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
}

async function cancelTest({ id, companyId, biometricId }, { SessionModel = Session } = {}) {
  return publicView(await SessionModel.findOneAndUpdate(
    {
      _id: id, companyId, approverBiometricId: String(biometricId || ""),
      isTest: true, status: { $in: ACTIVE },
    },
    { $set: { status: "CANCELLED", completedAt: new Date() } },
    { new: true },
  ));
}

async function activeTest({ companyId, biometricId }, { SessionModel = Session, now = new Date() } = {}) {
  const identity = String(biometricId || "");
  await SessionModel.updateMany(
    {
      companyId, approverBiometricId: identity, isTest: true,
      status: { $in: ACTIVE }, expiresAt: { $lte: now },
    },
    { $set: { status: "STALE", completedAt: now } },
  );
  return publicView(await SessionModel.findOne({
    companyId, approverBiometricId: identity, isTest: true,
    status: { $in: ACTIVE }, expiresAt: { $gt: now },
  }).sort({ createdAt: -1 }));
}

async function enqueue(
  mrf,
  { SessionModel = Session, env = process.env, notifyEmployeeDevices: notify = notifyEmployeeDevices } = {},
) {
  if (!config(env).enabled || !mrf?.companyId || !mrf?.approverBiometricId) return null;
  if (itemApproval.approvalSummary(mrf).awaiting < 1) return null;
  const filter = {
    companyId: mrf.companyId, mrf: mrf._id,
    approverBiometricId: String(mrf.approverBiometricId), status: { $in: ACTIVE },
  };
  const existing = await SessionModel.findOne(filter);
  if (existing) return existing;
  const waitingItems = (mrf.items || []).filter((line) => itemApproval.isAwaitingApproval(line, mrf));
  const itemSummary = waitingItems.slice(0, 4).map((line) => {
    const name = String(line.rawItemName || line.description || "Material").trim();
    const quantity = Number(line.requestedQty);
    const amount = Number.isFinite(quantity) ? ` — ${quantity} ${line.unit || "units"}` : "";
    return `${name}${amount}`;
  }).join("; ") + (waitingItems.length > 4 ? `; plus ${waitingItems.length - 4} more` : "");
  try {
    const row = await SessionModel.create({
      companyId: mrf.companyId, mrf: mrf._id, mrfNumber: mrf.mrfNumber,
      approverEmployee: mrf.approverEmployee || null,
      approverBiometricId: String(mrf.approverBiometricId),
      approverName: mrf.approverName || "",
      requestedForName: mrf.requestedForName || "",
      requestedForDept: mrf.requestedForDept || "",
      itemSummary,
      language: "en",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    if (mrf.approverEmployee) {
      await notify(mrf.approverEmployee, {
        type: "mrf_voice_call",
        title: "Incoming MRF approval call",
        body: `${mrf.requestedForName || "A colleague"} sent ${mrf.mrfNumber || "a material request"} for your approval.`,
        url: `/requests?mrfVoiceCall=${encodeURIComponent(String(row._id))}`,
        tag: `mrf-call-${String(row._id)}`,
        ttlSeconds: 120,
        data: {
          sessionId: String(row._id),
          mrfId: String(mrf._id),
          mrfNumber: String(mrf.mrfNumber || ""),
        },
      });
    }
    return row;
  } catch (error) {
    if (error?.code === 11000) return SessionModel.findOne(filter);
    throw error;
  }
}

async function incoming({ companyId, biometricId }, { SessionModel = Session, now = new Date() } = {}) {
  const row = await SessionModel.findOne({
    companyId, approverBiometricId: String(biometricId || ""),
    /* MRF Voice Lab sessions never reach the global surface. Morning briefs
       use actual personal Home data and are safe/read-only, so manual calls
       are ordinary workflow occurrences rather than test MRFs. */
    isTest: { $ne: true },
    status: { $in: ["QUEUED", "RINGING"] }, expiresAt: { $gt: now },
  }).sort({ createdAt: 1 });
  if (!row) return null;
  if (row.status === "QUEUED") {
    row.status = "RINGING";
    row.ringingAt = now;
    await row.save();
  }
  return publicView(row);
}

async function assigned({ id, companyId, biometricId }, { SessionModel = Session } = {}) {
  return publicView(await SessionModel.findOne({
    _id: id, companyId, approverBiometricId: String(biometricId || ""),
  }));
}

async function workerContext({ id }, { SessionModel = Session } = {}) {
  return publicView(await SessionModel.findOne({ _id: id, status: { $in: ACTIVE } }));
}

async function accept({ id, companyId, biometricId, actorName }, deps = {}) {
  const SessionModel = deps.SessionModel || Session;
  const env = deps.env || process.env;
  const cfg = config(env);
  const state = readiness(env);
  if (!state.ready) {
    const error = new Error(`MRF voice approval is not ready: ${state.missing.join(", ")}.`);
    error.code = "MRF_VOICE_NOT_READY";
    throw error;
  }
  const row = await SessionModel.findOne({
    _id: id, companyId, approverBiometricId: String(biometricId || ""),
    status: { $in: ["QUEUED", "RINGING"] }, expiresAt: { $gt: new Date() },
  });
  if (!row) {
    const error = new Error("This approval call is no longer available.");
    error.code = "MRF_VOICE_STALE";
    throw error;
  }
  const workflowKey = row.workflowKey || "mrf_approval";
  const roomName = `${workflowKey.replaceAll("_", "-")}-${crypto.randomUUID()}`;
  const host = asHttp(cfg.url);
  const { AccessToken, AgentDispatchClient, RoomServiceClient } = require("livekit-server-sdk");
  const rooms = deps.rooms || new RoomServiceClient(host, cfg.apiKey, cfg.apiSecret);
  const dispatches = deps.dispatches || new AgentDispatchClient(host, cfg.apiKey, cfg.apiSecret);
  await rooms.createRoom({ name: roomName, emptyTimeout: 90, maxParticipants: 2 });
  const token = new AccessToken(cfg.apiKey, cfg.apiSecret, {
    identity: `voice-recipient:${biometricId}`, name: actorName || row.approverName || "GRAV colleague", ttl: "20m",
  });
  token.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
  const dispatch = await dispatches.createDispatch(roomName, cfg.agentName, {
    metadata: JSON.stringify({
      // Keep the deployed MRF worker backward compatible while the generic
      // workflow worker rolls out. A morning brief must never be mistaken for
      // an approval call by an older worker.
      kind: workflowKey === "mrf_approval" ? "mrf_voice_approval" : "grav_voice_workflow",
      workflowKey,
      sessionId: String(row._id),
    }),
  });
  row.status = "CONNECTED";
  row.roomName = roomName;
  row.dispatchId = dispatch?.id || "";
  row.answeredAt = new Date();
  await row.save();
  return { call: publicView(row), session: { url: cfg.url, token: await token.toJwt(), roomName } };
}

async function defer({ id, companyId, biometricId }, { SessionModel = Session } = {}) {
  const row = await SessionModel.findOneAndUpdate(
    { _id: id, companyId, approverBiometricId: String(biometricId || ""), status: { $in: ACTIVE } },
    { $set: { status: "DEFERRED", completedAt: new Date() } },
    { new: true },
  );
  return publicView(row);
}

async function setLanguage({ id, companyId, biometricId, language }, { SessionModel = Session, env = process.env } = {}) {
  const selected = String(language || "").toLowerCase();
  if (!config(env).languages.includes(selected)) return null;
  const row = await SessionModel.findOneAndUpdate(
    { _id: id, companyId, approverBiometricId: String(biometricId || ""), status: { $in: ["QUEUED", "RINGING"] } },
    { $set: { language: selected } },
    { new: true },
  );
  return publicView(row);
}

async function workerNoAnswer({ id }, { SessionModel = Session } = {}) {
  return publicView(await SessionModel.findOneAndUpdate(
    { _id: id, status: { $in: ACTIVE } },
    { $set: { status: "NO_ANSWER", completedAt: new Date() } },
    { new: true },
  ));
}

async function workerSpeech({ id, text }, { SessionModel = Session } = {}) {
  const words = String(text || "").trim().slice(0, 2000);
  if (!words) return null;
  // Agent wording is diagnostic evidence only for synthetic Voice Lab calls.
  // Production calls deliberately do not persist their spoken content here.
  const row = await SessionModel.findOne({ _id: id, isTest: true });
  if (!row) return null;
  row.transcript.push({ speaker: "WORKFLOW", text: words, intent: "TTS" });
  if (row.transcript.length > 24) row.transcript = row.transcript.slice(-24);
  await row.save();
  return publicView(row);
}

async function workerDialog({ id, direction, text, intent: candidate = "", confidence = null }, { SessionModel = Session } = {}) {
  const words = String(text || "").trim().slice(0, 2000);
  const kind = String(direction || "").toUpperCase();
  if (!words || !["INPUT", "OUTPUT"].includes(kind)) return null;
  const row = await SessionModel.findOne({ _id: id, isTest: true });
  if (!row) return null;
  row.transcript.push({
    speaker: "QWEN",
    text: words,
    intent: `QWEN_${kind}${candidate ? `:${String(candidate).toUpperCase().slice(0, 20)}` : ""}`,
    confidence: Number.isFinite(Number(confidence)) ? Math.max(0, Math.min(1, Number(confidence))) : null,
  });
  if (row.transcript.length > 36) row.transcript = row.transcript.slice(-36);
  await row.save();
  return publicView(row);
}

async function workerTurn({ id, text, phase, confidence = null, semanticIntent = "" }, { SessionModel = Session } = {}) {
  const row = await SessionModel.findOne({ _id: id, status: { $in: ACTIVE } });
  if (!row) return null;
  const words = String(text || "").trim().slice(0, 2000);
  if (!words) return { call: publicView(row), action: "RETRY" };
  const event = { speaker: "APPROVER", text: words, confidence };

  if ((row.workflowKey || "mrf_approval") === "morning_brief") {
    const normalized = words.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();
    if (/\b(repeat|again|say that again|from the start|once more)\b/.test(normalized)) {
      event.intent = "REPEAT";
      row.transcript.push(event);
      if (row.transcript.length > 24) row.transcript = row.transcript.slice(-24);
      row.status = "AWAITING_INTENT";
      await row.save();
      return { call: publicView(row), action: "REPEAT_BRIEF" };
    }
    if (/\b(open|show|take me to|home|dashboard)\b/.test(normalized)) {
      event.intent = "OPEN_HOME";
      row.transcript.push(event);
      if (row.transcript.length > 24) row.transcript = row.transcript.slice(-24);
      row.status = "AWAITING_INTENT";
      await row.save();
      return { call: publicView(row), action: "OPEN_HOME" };
    }
    if (/\b(done|finish|finished|stop|end|that's all|that is all|thank you|thanks|bye)\b/.test(normalized)) {
      event.intent = "COMPLETE";
      row.transcript.push(event);
      if (row.transcript.length > 24) row.transcript = row.transcript.slice(-24);
      row.status = "COMPLETED";
      row.completedAt = new Date();
      await row.save();
      return { call: publicView(row), action: "END_BRIEF" };
    }
    event.intent = "UNKNOWN";
    row.transcript.push(event);
    if (row.transcript.length > 24) row.transcript = row.transcript.slice(-24);
    row.status = "AWAITING_INTENT";
    await row.save();
    return { call: publicView(row), action: "BRIEF_HELP" };
  }

  if (phase === "CONFIRMATION" && row.status === "AWAITING_CONFIRMATION") {
    const found = intent.classifyConfirmation(words);
    event.intent = found.intent;
    row.transcript.push(event);
    if (row.transcript.length > 24) row.transcript = row.transcript.slice(-24);
    if (found.intent === "CONFIRM") {
      row.status = "DECISION_READY";
      await row.save();
      return { call: publicView(row), action: "COMMIT", intent: row.pendingIntent, rejectionReason: row.rejectionReason };
    }
    if (found.intent === "CANCEL") {
      row.pendingIntent = "";
      row.rejectionReason = "";
      row.status = "AWAITING_INTENT";
      await row.save();
      return { call: publicView(row), action: "ASK_INTENT" };
    }
    await row.save();
    return { call: publicView(row), action: "RETRY_CONFIRMATION", intent: row.pendingIntent };
  }

  if (phase === "REJECTION_REASON" && row.pendingIntent === "REJECT") {
    event.intent = "REJECTION_REASON";
    row.transcript.push(event);
    if (row.transcript.length > 24) row.transcript = row.transcript.slice(-24);
    row.rejectionReason = words.slice(0, 500);
    row.status = "AWAITING_CONFIRMATION";
    await row.save();
    return { call: publicView(row), action: "ASK_CONFIRMATION", intent: "REJECT", rejectionReason: row.rejectionReason };
  }

  const suggested = phase === "SEMANTIC_CONFIRMATION"
    && ["APPROVE", "REJECT", "DEFER"].includes(String(semanticIntent || "").toUpperCase())
    ? String(semanticIntent).toUpperCase()
    : "";
  const found = suggested
    ? { intent: suggested, confidence: Math.max(0, Math.min(1, Number(confidence) || 0.65)) }
    : intent.classifyIntent(words);
  event.intent = found.intent;
  row.transcript.push(event);
  if (row.transcript.length > 24) row.transcript = row.transcript.slice(-24);
  if (found.intent === "DEFER") {
    row.status = "DEFERRED";
    row.completedAt = new Date();
    await row.save();
    return { call: publicView(row), action: "END_DEFERRED" };
  }
  if (["REPEAT", "OPEN_REQUEST"].includes(found.intent)) {
    await row.save();
    return { call: publicView(row), action: found.intent };
  }
  if (found.intent === "REJECT") {
    row.pendingIntent = "REJECT";
    row.status = "AWAITING_INTENT";
    await row.save();
    return { call: publicView(row), action: "ASK_REJECTION_REASON" };
  }
  if (found.intent === "APPROVE") {
    row.pendingIntent = "APPROVE";
    row.status = "AWAITING_CONFIRMATION";
    await row.save();
    return { call: publicView(row), action: "ASK_CONFIRMATION", intent: "APPROVE" };
  }
  row.status = "AWAITING_INTENT";
  await row.save();
  return { call: publicView(row), action: "RETRY" };
}

async function complete({ id, companyId, biometricId, outcome }, { SessionModel = Session } = {}) {
  const wanted = String(outcome || "").toUpperCase();
  if (!["APPROVED", "REJECTED"].includes(wanted)) return null;
  const row = await SessionModel.findOne({
    _id: id, companyId, approverBiometricId: String(biometricId || ""), status: "DECISION_READY",
    pendingIntent: wanted === "APPROVED" ? "APPROVE" : "REJECT",
  });
  if (!row) return null;
  row.status = wanted;
  row.completedAt = new Date();
  await row.save();
  return publicView(row);
}

module.exports = { ACTIVE, accept, activeTest, assigned, cancelTest, complete, config, createTest, defer, enqueue, incoming, publicView, readiness, setLanguage, workerContext, workerDialog, workerNoAnswer, workerSpeech, workerTurn };
