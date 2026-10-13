"use strict";

const crypto = require("crypto");
const express = require("express");

const employeeAuth = require("../../../Middlewear/EmployeeAuthMiddlewear");
const CallEvent = require("../../../models/CallEvent");
const VoiceContact = require("../../../models/VoiceContact");
const { scopeFor } = require("../../../services/companyContext/salesScope.service");
const { dialFailureState } = require("../../../services/telephony/livekitBrowserCall");
const { dialStatusUrl, dialXml, validPlivoRequest } = require("../../../services/telephony/plivoInboundBridge");
const { assignedVoiceLine, voiceOwnerByNumber } = require("../../../services/telephony/voiceLineAssignment");

const router = express.Router();
const VOICE_ROLES = new Set(["sales", "ceo", "project_manager", "merchandiser"]);

function voiceAuth(req, res, next) {
  employeeAuth(req, res, () => {
    if (req.user?.isAdmin || VOICE_ROLES.has(req.user?.role)) return next();
    return res.status(403).json({ success: false, message: "GRAV Voice access is not assigned to this account." });
  });
}

function cleanE164(value) {
  const raw = String(value || "").trim().replace(/[\s()-]/g, "");
  if (/^\d{10}$/.test(raw)) return `+91${raw}`;
  if (/^91\d{10}$/.test(raw)) return `+${raw}`;
  if (/^\+[1-9]\d{7,14}$/.test(raw)) return raw;
  const error = new Error("Enter a valid phone number, for example +919876543210.");
  error.code = "INVALID_PHONE_NUMBER";
  throw error;
}

// Public Plivo Voice Application answer URL. This is an alternate carrier
// ingress path for numbers whose Zentrunk route is not reaching LiveKit. Plivo
// executes the returned Dial XML and sends the original PSTN caller to the
// LiveKit SIP trunk; the existing LiveKit dispatch rule then selects the
// per-user room. Signature validation becomes mandatory when PLIVO_AUTH_TOKEN
// is present, and can be enforced at startup with the require-signature flag.
router.all("/plivo/inbound", async (req, res) => {
  try {
    if (!validPlivoRequest(req)) return res.status(401).type("text/plain").send("Invalid Plivo signature");
    const assignment = await voiceOwnerByNumber(req.body?.To || req.query?.To);
    const xml = assignment ? dialXml({ number: assignment.number, actionUrl: dialStatusUrl(req) }) : null;
    if (!xml) return res.status(404).type("text/plain").send("No inbound Voice route is assigned to this number.");
    return res.status(200).type("text/xml").send(xml);
  } catch (error) {
    console.error("[GRAV Voice Plivo inbound]", error?.message || error);
    return res.status(500).type("text/plain").send("Inbound Voice route failed.");
  }
});

// Plivo invokes the Dial action after the SIP leg ends. Keep this endpoint
// deliberately side-effect free: the fields make the next carrier-to-LiveKit
// failure diagnosable without exposing the rest of the local application.
router.all("/plivo/inbound/status", (req, res) => {
  if (!validPlivoRequest(req)) return res.status(401).type("text/plain").send("Invalid Plivo signature");
  const source = req.method === "POST" ? req.body : req.query;
  console.info("[GRAV Voice Plivo dial status]", {
    dialStatus: source?.DialStatus || null,
    ringStatus: source?.DialRingStatus || null,
    hangupCause: source?.DialHangupCause || null,
    aLegUuid: source?.DialALegUUID || null,
    bLegUuid: source?.DialBLegUUID || null,
  });
  return res.status(200).type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
});

// What the calling app needs and nothing else: no provider identities, no
// storage keys, no carrier names.
function publicCall(row) {
  const conferenceParticipants = (row.conferenceParticipants || []).map((participant) => ({
    id: String(participant._id || participant.participantIdentity),
    phoneNumber: participant.phoneNumber,
    contactId: participant.contactId ? String(participant.contactId) : null,
    contactName: participant.contactName || null,
    status: participant.status,
    connectedAt: participant.connectedAt || null,
    endedAt: participant.endedAt || null,
  }));
  return {
    id: String(row._id),
    direction: row.providerDirection === "inbound" ? "inbound" : "outbound",
    status: row.providerStatus,
    customerPhone: row.phoneNumber,
    startedAt: row.providerOccurredAt || row.createdAt,
    connectedAt: row.connectedAt || null,
    endedAt: row.endTime || null,
    durationSec: row.durationSec || 0,
    recordingAvailable: Boolean(row.recordingStorageKey && row.recordingSync?.status === "imported"),
    recordingStatus: row.recordingSync?.status || null,
    conferenceParticipants,
    participantCount: 1 + conferenceParticipants.filter((participant) => participant.status === "IN_PROGRESS").length,
  };
}

function participantIdentities(row) {
  return [
    row.livekitParticipantIdentity,
    ...(row.conferenceParticipants || []).map((participant) => participant.participantIdentity),
  ].filter(Boolean);
}

function canCall(assignment) {
  return Boolean(assignment?.assigned && assignment?.configured && process.env.GRAV_VOICE_ALLOW_TEST_DIALLER === "1");
}

function callBlockedReason(assignment) {
  if (!assignment?.assigned) return assignment?.reason || "No Voice line is assigned to your account.";
  if (!assignment?.configured) return assignment?.reason || "Your Voice line is not fully connected yet.";
  if (!canCall(assignment)) return "Calling isn't enabled for your account yet. Ask your administrator to turn it on.";
  return null;
}

function ownedByActor(req, assignment) {
  return {
    $or: [
      assignment?.salesPersonOwnerId ? { salesPersonId: assignment.salesPersonOwnerId } : null,
      req.user?.id ? { "initiatedBy.userId": String(req.user.id) } : null,
      req.user?.employeeId ? { "initiatedBy.employeeId": String(req.user.employeeId) } : null,
      req.user?.email ? { "initiatedBy.email": String(req.user.email).trim().toLowerCase() } : null,
      req.user?.id ? { "assignedTo.userId": String(req.user.id) } : null,
      req.user?.employeeId ? { "assignedTo.employeeId": String(req.user.employeeId) } : null,
      req.user?.email ? { "assignedTo.email": String(req.user.email).trim().toLowerCase() } : null,
    ].filter(Boolean),
  };
}

const DIAL_FAILURE_MESSAGES = Object.freeze({
  CUSTOMER_BUSY: "The number is busy.",
  CUSTOMER_NO_ANSWER: "No answer.",
  FAILED: "The call couldn't be connected.",
});

function sendError(res, error) {
  const status = error?.status === 401 ? 502
    : error?.status === 403 ? 403
      : error?.code === "CALL_ENDED_BEFORE_RECORDING" ? 409
        : ["INVALID_PHONE_NUMBER", "BROWSER_CALL_NOT_CONFIGURED", "BROWSER_RECORDING_NOT_CONFIGURED"].includes(error?.code) ? 400
        : error?.statusCode || 500;
  return res.status(status).json({
    success: false,
    code: error?.code || "VOICE_CALL_FAILED",
    message: error?.message || "The call could not be started.",
  });
}

function applyRecordingResult(row, result) {
  if (!result) return;
  if (result.egressId) row.livekitEgressId = result.egressId;
  if (result.storageKey) row.recordingStorageKey = result.storageKey;
  if (result.size) row.driveSize = result.size;
  row.recordingMimeType = "audio/mpeg";
  row.recordingSync.lastAttemptAt = new Date();
  if (result.complete && row.recordingStorageKey) {
    row.recordingSync.status = "imported";
    row.recordingSync.failureCode = null;
    row.recordingUploadStatus = "UPLOADED";
    row.recordingError = null;
    row.audioFileName = row.recordingStorageKey.split("/").pop();
  } else if (result.failed) {
    row.recordingSync.status = "failed";
    row.recordingSync.failureCode = "LIVEKIT_EGRESS_FAILED";
    row.recordingUploadStatus = "FAILED";
    row.recordingError = result.error || "LiveKit could not save this recording.";
    row.recordingErrorAt = new Date();
  } else {
    row.recordingSync.status = "importing";
  }
}

async function reconcileBrowserCall(row, line) {
  const current = await line.status({
    roomName: row.livekitRoomName,
    participantIdentity: row.livekitParticipantIdentity,
  });
  if (current.status) row.providerStatus = current.status;
  if (current.sipCallId && row.providerCallId?.startsWith("livekit:")) row.providerCallId = current.sipCallId;
  if (current.status === "IN_PROGRESS") row.received = true;

  const conferenceStates = await line.participantStatuses({
    roomName: row.livekitRoomName,
    participantIdentities: (row.conferenceParticipants || []).map((participant) => participant.participantIdentity),
  });
  const conferenceByIdentity = new Map(conferenceStates.map((participant) => [participant.participantIdentity, participant]));
  for (const participant of row.conferenceParticipants || []) {
    const live = conferenceByIdentity.get(participant.participantIdentity);
    if (live) {
      participant.status = live.status || participant.status;
      if (participant.status === "IN_PROGRESS" && !participant.connectedAt) participant.connectedAt = new Date();
      if (live.sipCallId) participant.sipCallId = live.sipCallId;
    } else if (participant.status === "IN_PROGRESS") {
      participant.status = "COMPLETED";
      participant.endedAt = participant.endedAt || new Date();
    }
  }
  const conferencePresent = conferenceStates.some((participant) => participant.present);

  // Do not use absence while QUEUED/RINGING: the dial request can be between
  // creating the row and adding the SIP participant. Once the call was
  // connected, however, a room with no PSTN participant means the conversation
  // has ended. One conference member leaving never disconnects the others.
  if (!current.present && !conferencePresent && (row.received || row.providerStatus === "IN_PROGRESS") && !row.endTime) {
    if (row.livekitEgressId) {
      const stopped = await line.stopRecording({
        egressId: row.livekitEgressId,
        storageKey: row.recordingStorageKey,
      });
      applyRecordingResult(row, stopped);
    }
    row.providerStatus = "COMPLETED";
    row.endTime = Date.now();
    if (row.connectedAt) row.durationSec = Math.max(0, Math.round((row.endTime - row.connectedAt) / 1000));
  }

  if (row.livekitEgressId) {
    const recording = await line.recordingStatus({
      egressId: row.livekitEgressId,
      storageKey: row.recordingStorageKey,
    });
    applyRecordingResult(row, recording);
  }
  await row.save();
  return row;
}

async function reconcileInboundCall(row, line) {
  const caller = await line.incomingCaller({ roomName: row.livekitRoomName });
  if (!caller && !row.endTime) {
    if (row.livekitEgressId) {
      const stopped = await line.stopRecording({ egressId: row.livekitEgressId, storageKey: row.recordingStorageKey });
      applyRecordingResult(row, stopped);
    }
    if (row.received || row.providerStatus === "IN_PROGRESS") {
      row.providerStatus = "COMPLETED";
      row.callType = "INCOMING";
    } else {
      row.providerStatus = "AGENT_NO_ANSWER";
      row.callType = "MISSED";
      row.recordingSync.status = "not_expected";
      row.recordingSync.failureCode = "AGENT_NO_ANSWER";
    }
    row.endTime = Date.now();
    if (row.connectedAt) row.durationSec = Math.max(0, Math.round((row.endTime - row.connectedAt) / 1000));
  } else if (row.livekitEgressId) {
    const recording = await line.recordingStatus({ egressId: row.livekitEgressId, storageKey: row.recordingStorageKey });
    applyRecordingResult(row, recording);
  }
  await row.save();
  return row;
}

router.get("/access", voiceAuth, (_req, res) => {
  res.json({ success: true, hasAccess: true });
});

router.get("/contacts", voiceAuth, async (req, res) => {
  try {
    const scope = await scopeFor(req, { domainLabel: "GRAV Voice" });
    const search = String(req.query.search || "").trim().slice(0, 80);
    const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 100);
    const selector = { companyId: scope.companyId, isActive: true };
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(escaped, "i");
      selector.$or = [{ name: re }, { company: re }, { phoneNumber: re }];
    }
    const contacts = await VoiceContact.find(selector)
      .select("name company phoneNumber")
      .sort({ name: 1 })
      .limit(limit)
      .lean();
    res.json({
      success: true,
      contacts: contacts.map((contact) => ({
        id: String(contact._id),
        name: contact.name,
        company: contact.company || "",
        phoneNumber: contact.phoneNumber,
      })),
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/contacts", voiceAuth, async (req, res) => {
  try {
    const scope = await scopeFor(req, { domainLabel: "GRAV Voice" });
    const name = String(req.body?.name || "").trim().slice(0, 120);
    if (!name) return res.status(400).json({ success: false, message: "Contact name is required." });
    const phoneNumber = cleanE164(req.body?.phoneNumber);
    const contact = await VoiceContact.create({
      companyId: scope.companyId,
      name,
      company: String(req.body?.company || "").trim().slice(0, 120),
      phoneNumber,
      createdBy: {
        userId: req.user?.id ? String(req.user.id) : null,
        employeeId: req.user?.employeeId ? String(req.user.employeeId) : null,
      },
    });
    return res.status(201).json({
      success: true,
      contact: { id: String(contact._id), name: contact.name, company: contact.company || "", phoneNumber: contact.phoneNumber },
    });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ success: false, message: "That phone number is already in GRAV Voice contacts." });
    return sendError(res, error);
  }
});

router.patch("/contacts/:id", voiceAuth, async (req, res) => {
  try {
    const scope = await scopeFor(req, { domainLabel: "GRAV Voice" });
    const update = {};
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "name")) {
      update.name = String(req.body.name || "").trim().slice(0, 120);
      if (!update.name) return res.status(400).json({ success: false, message: "Contact name is required." });
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "company")) update.company = String(req.body.company || "").trim().slice(0, 120);
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "phoneNumber")) update.phoneNumber = cleanE164(req.body.phoneNumber);
    const contact = await VoiceContact.findOneAndUpdate(
      { _id: req.params.id, companyId: scope.companyId, isActive: true },
      { $set: update },
      { new: true, runValidators: true },
    );
    if (!contact) return res.status(404).json({ success: false, message: "Voice contact not found." });
    return res.json({ success: true, contact: { id: String(contact._id), name: contact.name, company: contact.company || "", phoneNumber: contact.phoneNumber } });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ success: false, message: "That phone number is already in GRAV Voice contacts." });
    return sendError(res, error);
  }
});

router.delete("/contacts/:id", voiceAuth, async (req, res) => {
  try {
    const scope = await scopeFor(req, { domainLabel: "GRAV Voice" });
    const contact = await VoiceContact.findOneAndUpdate(
      { _id: req.params.id, companyId: scope.companyId, isActive: true },
      { $set: { isActive: false } },
      { new: true },
    );
    if (!contact) return res.status(404).json({ success: false, message: "Voice contact not found." });
    return res.json({ success: true });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/status", voiceAuth, async (req, res) => {
  try {
    const scope = await scopeFor(req, { domainLabel: "GRAV Voice" });
    const assignment = await assignedVoiceLine(req.user);
    // Recents are the caller's own calls, like the phone in their pocket.
    const mine = [
      req.user?.id ? { "initiatedBy.userId": String(req.user.id) } : null,
      req.user?.employeeId ? { "initiatedBy.employeeId": String(req.user.employeeId) } : null,
      req.user?.email ? { "initiatedBy.email": String(req.user.email).trim().toLowerCase() } : null,
      req.user?.id ? { "assignedTo.userId": String(req.user.id) } : null,
      req.user?.employeeId ? { "assignedTo.employeeId": String(req.user.employeeId) } : null,
      req.user?.email ? { "assignedTo.email": String(req.user.email).trim().toLowerCase() } : null,
    ].filter(Boolean);
    if (assignment.salesPersonOwnerId) mine.push({ salesPersonId: assignment.salesPersonOwnerId });
    const rows = mine.length ? await CallEvent.find({
      companyId: scope.companyId,
      providerDirection: { $in: ["outbound_browser", "inbound"] },
      $or: mine,
    }).sort({ createdAt: -1 }).limit(40) : [];
    // Repair an active row even after a reload or browser sleep. This also
    // fixes a customer-side hang-up that happened before this deployment.
    await Promise.all(rows
      .filter((row) => ["AGENT_RINGING", "IN_PROGRESS"].includes(row.providerStatus) && assignment.line)
      .map((row) => (row.providerDirection === "inbound"
        ? reconcileInboundCall(row, assignment.line)
        : reconcileBrowserCall(row, assignment.line)).catch((error) => {
        console.error("[GRAV Voice status refresh]", error?.message || error);
        return row;
      })));
    const described = assignment.line?.describe() || { configured: false, callerId: assignment.number || null };
    res.json({
      success: true,
      line: {
        configured: described.configured,
        callerId: described.callerId,
        assigned: assignment.assigned,
        inboundConfigured: assignment.inboundConfigured,
      },
      canCall: canCall(assignment),
      blockedReason: callBlockedReason(assignment),
      calls: rows.map(publicCall),
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/incoming", voiceAuth, async (req, res) => {
  try {
    const scope = await scopeFor(req, { domainLabel: "GRAV Voice" });
    const assignment = await assignedVoiceLine(req.user);
    if (!assignment.inboundConfigured || !assignment.line) {
      return res.json({
        success: true,
        ringingConfigured: false,
        incoming: null,
        reason: assignment.assigned
          ? "Incoming calling has not been connected to this Voice number yet."
          : "No Voice line is assigned to your account.",
      });
    }

    const caller = await assignment.line.incomingCaller({ roomName: assignment.roomName });
    const owner = ownedByActor(req, assignment);
    const waiting = await CallEvent.findOne({
      companyId: scope.companyId,
      providerDirection: "inbound",
      providerStatus: { $in: ["AGENT_RINGING", "IN_PROGRESS"] },
      endTime: null,
      ...owner,
    }).sort({ createdAt: -1 });

    if (!caller) {
      if (waiting) await reconcileInboundCall(waiting, assignment.line);
      return res.json({ success: true, ringingConfigured: true, incoming: null });
    }

    let row = await CallEvent.findOne({
      companyId: scope.companyId,
      provider: assignment.line.provider,
      providerCallId: caller.callId,
    });
    if (!row) {
      row = await CallEvent.create({
        companyId: scope.companyId,
        provider: assignment.line.provider,
        providerCallId: caller.callId,
        providerStatus: "AGENT_RINGING",
        providerDirection: "inbound",
        businessNumber: assignment.number,
        providerOccurredAt: new Date(),
        startTime: Date.now(),
        phoneNumber: caller.callerPhone || null,
        direction: "INCOMING",
        callType: "INCOMING",
        kind: "call",
        source: "grav_voice_browser",
        recordingMethod: "livekit_egress",
        recordingSync: { status: null },
        livekitRoomName: assignment.roomName,
        livekitParticipantIdentity: caller.participantIdentity,
        salesPersonId: assignment.salesPersonOwnerId,
        assignedTo: {
          userId: req.user.id ? String(req.user.id) : null,
          employeeId: req.user.employeeId ? String(req.user.employeeId) : null,
          email: req.user.email || null,
        },
      });
    }
    return res.json({ success: true, ringingConfigured: true, incoming: publicCall(row) });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/incoming/:id/accept", voiceAuth, async (req, res) => {
  try {
    const scope = await scopeFor(req, { domainLabel: "GRAV Voice" });
    const assignment = await assignedVoiceLine(req.user);
    if (!assignment.inboundConfigured || !assignment.line) {
      return res.status(409).json({ success: false, message: "Incoming calling is not configured for your Voice number." });
    }
    const row = await CallEvent.findOne({
      _id: req.params.id,
      companyId: scope.companyId,
      providerDirection: "inbound",
      providerStatus: "AGENT_RINGING",
      endTime: null,
      ...ownedByActor(req, assignment),
    });
    if (!row) return res.status(409).json({ success: false, message: "This incoming call is no longer ringing." });
    const caller = await assignment.line.incomingCaller({ roomName: assignment.roomName });
    if (!caller || caller.callId !== row.providerCallId) {
      row.providerStatus = "AGENT_NO_ANSWER";
      row.callType = "MISSED";
      row.endTime = Date.now();
      row.recordingSync.status = "not_expected";
      await row.save();
      return res.status(409).json({ success: false, message: "The caller has already hung up." });
    }
    const identity = `employee-${req.user?.employeeId || req.user?.id || crypto.randomBytes(6).toString("hex")}`;
    const session = await assignment.line.createSession({
      roomName: assignment.roomName,
      identity,
      displayName: req.user?.name || req.user?.email || "GRAV employee",
    });
    return res.json({ success: true, call: publicCall(row), session });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/incoming/:id/answered", voiceAuth, async (req, res) => {
  let row = null;
  try {
    const scope = await scopeFor(req, { domainLabel: "GRAV Voice" });
    const assignment = await assignedVoiceLine(req.user);
    if (!assignment.inboundConfigured || !assignment.line) {
      return res.status(409).json({ success: false, message: "Incoming calling is not configured for your Voice number." });
    }
    row = await CallEvent.findOne({
      _id: req.params.id,
      companyId: scope.companyId,
      providerDirection: "inbound",
      providerStatus: "AGENT_RINGING",
      endTime: null,
      ...ownedByActor(req, assignment),
    });
    if (!row) return res.status(409).json({ success: false, message: "This incoming call is no longer ringing." });
    const caller = await assignment.line.incomingCaller({ roomName: assignment.roomName });
    if (!caller || caller.callId !== row.providerCallId) {
      return res.status(409).json({ success: false, message: "The caller has already hung up." });
    }
    row.providerStatus = "IN_PROGRESS";
    row.received = true;
    row.connectedAt = Date.now();
    await row.save();
    const storageKey = `grav-voice/${scope.companyId}/${row._id}.mp3`;
    const recording = await assignment.line.startRecording({ roomName: row.livekitRoomName, storageKey });
    applyRecordingResult(row, recording);
    await row.save();
    return res.json({ success: true, call: publicCall(row) });
  } catch (error) {
    if (row) {
      row.providerStatus = "FAILED";
      row.endTime = Date.now();
      row.recordingSync.status = "failed";
      row.recordingSync.failureCode = error?.code || "INBOUND_RECORDING_FAILED";
      await row.save().catch(() => null);
    }
    return sendError(res, error);
  }
});

router.delete("/incoming/:id", voiceAuth, async (req, res) => {
  try {
    const scope = await scopeFor(req, { domainLabel: "GRAV Voice" });
    const assignment = await assignedVoiceLine(req.user);
    const row = await CallEvent.findOne({
      _id: req.params.id,
      companyId: scope.companyId,
      providerDirection: "inbound",
      endTime: null,
      ...ownedByActor(req, assignment),
    });
    if (!row) return res.status(404).json({ success: false, message: "Incoming call not found." });
    if (assignment.line) {
      await assignment.line.hangup({ roomName: row.livekitRoomName, participantIdentity: row.livekitParticipantIdentity }).catch(() => null);
      if (row.livekitEgressId) {
        const recording = await assignment.line.stopRecording({ egressId: row.livekitEgressId, storageKey: row.recordingStorageKey });
        applyRecordingResult(row, recording);
      }
    }
    row.providerStatus = row.received ? "COMPLETED" : "CANCELLED";
    row.callType = row.received ? "INCOMING" : "REJECTED";
    row.rejected = !row.received;
    row.endTime = Date.now();
    if (!row.received) row.recordingSync.status = "not_expected";
    if (row.connectedAt) row.durationSec = Math.max(0, Math.round((row.endTime - row.connectedAt) / 1000));
    await row.save();
    return res.json({ success: true, call: publicCall(row) });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/browser-calls/session", voiceAuth, async (req, res) => {
  let row = null;
  try {
    const assignment = await assignedVoiceLine(req.user);
    const line = assignment.line;
    if (!line?.configured()) {
      const error = new Error(callBlockedReason(assignment));
      error.code = "BROWSER_CALL_NOT_CONFIGURED";
      throw error;
    }
    if (!canCall(assignment)) {
      return res.status(403).json({ success: false, code: "CALLING_NOT_ENABLED", message: callBlockedReason(assignment) });
    }
    const scope = await scopeFor(req, { domainLabel: "GRAV Voice" });
    const requestId = String(req.body?.requestId || "").trim();
    if (!/^[a-zA-Z0-9_-]{12,100}$/.test(requestId)) {
      return res.status(400).json({ success: false, message: "A valid requestId is required." });
    }
    const existing = await CallEvent.findOne({ companyId: scope.companyId, providerRequestId: requestId });
    if (existing) return res.json({ success: true, duplicate: true, call: publicCall(existing) });

    const customerPhone = cleanE164(req.body?.customerPhone);
    const suffix = crypto.randomBytes(8).toString("hex");
    const roomName = `grav-voice-${suffix}`;
    const employeeIdentity = `employee-${req.user?.employeeId || req.user?.id || suffix}`;
    const customerIdentity = `customer-${suffix}`;
    row = await CallEvent.create({
      companyId: scope.companyId,
      provider: line.provider,
      providerRequestId: requestId,
      providerCallId: `pending:${requestId}`,
      providerStatus: "QUEUED",
      providerDirection: "outbound_browser",
      businessNumber: line.businessNumber,
      providerOccurredAt: new Date(),
      startTime: Date.now(),
      phoneNumber: customerPhone,
      direction: "OUTGOING",
      callType: "OUTGOING",
      kind: "call",
      source: "grav_voice_browser",
      recordingMethod: "livekit_egress",
      // A recording is not expected until the SIP leg is answered.
      recordingSync: { status: null },
      livekitRoomName: roomName,
      livekitParticipantIdentity: customerIdentity,
      initiatedBy: {
        userId: req.user.id ? String(req.user.id) : null,
        employeeId: req.user.employeeId ? String(req.user.employeeId) : null,
        email: req.user.email || null,
      },
      salesPersonId: assignment.salesPersonOwnerId,
      assignedTo: {
        userId: req.user.id ? String(req.user.id) : null,
        employeeId: req.user.employeeId ? String(req.user.employeeId) : null,
        email: req.user.email || null,
      },
    });
    const session = await line.createSession({
      roomName,
      identity: employeeIdentity,
      displayName: req.user?.name || req.user?.email || "GRAV employee",
    });
    return res.status(201).json({ success: true, call: publicCall(row), session });
  } catch (error) {
    if (row) {
      row.providerStatus = "FAILED";
      row.recordingError = error?.message || "The call session could not be created.";
      await row.save().catch(() => null);
    }
    return sendError(res, error);
  }
});

router.post("/browser-calls/:id/dial", voiceAuth, async (req, res) => {
  let row = null;
  let line = null;
  let connected = false;
  let recordingStarted = false;
  try {
    const scope = await scopeFor(req, { domainLabel: "GRAV Voice" });
    const assignment = await assignedVoiceLine(req.user);
    line = assignment.line;
    if (!line?.configured()) return res.status(403).json({ success: false, message: callBlockedReason(assignment) });
    row = await CallEvent.findOne({ _id: req.params.id, companyId: scope.companyId, providerDirection: "outbound_browser", ...ownedByActor(req, assignment) });
    if (!row) return res.status(404).json({ success: false, message: "Browser call not found." });
    if (!row.providerCallId?.startsWith("pending:")) {
      return res.json({ success: true, duplicate: true, call: publicCall(row) });
    }
    // Claim the request before dialing. A retry while this request is waiting
    // for the customer to answer must not create a second PSTN leg.
    const pendingProviderCallId = row.providerCallId;
    row = await CallEvent.findOneAndUpdate(
      { _id: row._id, companyId: scope.companyId, providerCallId: pendingProviderCallId },
      { $set: { providerCallId: `dialing:${row.providerRequestId}`, providerStatus: "CUSTOMER_RINGING" } },
      { new: true },
    );
    if (!row) {
      const duplicate = await CallEvent.findOne({ _id: req.params.id, companyId: scope.companyId });
      return res.json({ success: true, duplicate: true, call: publicCall(duplicate) });
    }

    // LiveKit now waits until the SIP participant is answered. Egress starts
    // only after this returns, so ringing and ringback are never recorded.
    const started = await line.dial({
      roomName: row.livekitRoomName,
      customerPhone: row.phoneNumber,
      participantIdentity: row.livekitParticipantIdentity,
    });
    connected = true;

    // The user can press End while the dial request is waiting. Re-read the
    // authoritative row before starting Egress to close that race.
    row = await CallEvent.findOne({ _id: row._id, companyId: scope.companyId });
    if (!row || ["CANCELLED", "FAILED"].includes(row.providerStatus)) {
      await line.hangup({
        roomName: row?.livekitRoomName,
        participantIdentity: row?.livekitParticipantIdentity,
      }).catch(() => null);
      const error = new Error("The call ended before recording could start.");
      error.code = "CALL_ENDED_BEFORE_RECORDING";
      throw error;
    }

    row.providerCallId = started.sipCallId || `livekit:${started.participantIdentity}`;
    row.providerStatus = "IN_PROGRESS";
    row.received = true;
    row.connectedAt = Date.now();
    await row.save();

    const storageKey = `grav-voice/${scope.companyId}/${row._id}.mp3`;
    const recording = await line.startRecording({ roomName: row.livekitRoomName, storageKey });
    applyRecordingResult(row, recording);
    recordingStarted = true;
    await row.save();

    // If End raced with Egress startup, DELETE either sees the persisted
    // egress ID and stops it, or this terminal-state check does. There is no
    // path that leaves a post-hang-up recorder running.
    const afterRecordingStart = await CallEvent.findOne({ _id: row._id, companyId: scope.companyId });
    if (afterRecordingStart && ["CANCELLED", "COMPLETED"].includes(afterRecordingStart.providerStatus)) {
      const stopped = await line.stopRecording({
        egressId: row.livekitEgressId,
        storageKey: row.recordingStorageKey,
      }).catch(() => null);
      applyRecordingResult(afterRecordingStart, stopped || recording);
      await afterRecordingStart.save();
      return res.json({ success: true, ended: true, call: publicCall(afterRecordingStart) });
    }
    return res.status(201).json({ success: true, call: publicCall(row) });
  } catch (error) {
    if (row) {
      if (recordingStarted && row.livekitEgressId) {
        const stopped = await line.stopRecording({
          egressId: row.livekitEgressId,
          storageKey: row.recordingStorageKey,
        }).catch(() => null);
        applyRecordingResult(row, stopped);
      }
      const latest = await CallEvent.findOne({ _id: row._id }).catch(() => null);
      if (latest && !["CANCELLED", "COMPLETED"].includes(latest.providerStatus)) {
        row = latest;
        if (connected) {
          await line.hangup({
            roomName: row.livekitRoomName,
            participantIdentity: row.livekitParticipantIdentity,
          }).catch(() => null);
        }
        // An unanswered dial is an ordinary outcome (busy, no answer), not a
        // server fault, and the recents list says which one it was.
        row.providerStatus = connected ? "FAILED" : dialFailureState(error);
        row.endTime = Date.now();
        row.recordingSync.status = connected ? "failed" : "not_expected";
        row.recordingSync.failureCode = error?.code || "BROWSER_DIAL_FAILED";
        row.recordingError = connected
          ? error?.message || "The connected call was ended because recording could not start."
          : null;
        row.recordingErrorAt = connected ? new Date() : null;
        await row.save().catch(() => null);
        if (!connected) {
          console.error("[GRAV Voice dial]", row.providerStatus, error?.message || error);
          return res.status(409).json({
            success: false,
            code: row.providerStatus,
            message: DIAL_FAILURE_MESSAGES[row.providerStatus] || DIAL_FAILURE_MESSAGES.FAILED,
            call: publicCall(row),
          });
        }
      } else if (latest) {
        return res.json({ success: true, ended: true, call: publicCall(latest) });
      }
    }
    return sendError(res, error);
  }
});

router.post("/browser-calls/:id/participants", voiceAuth, async (req, res) => {
  let row = null;
  let participantIdentity = null;
  try {
    const scope = await scopeFor(req, { domainLabel: "GRAV Voice" });
    const assignment = await assignedVoiceLine(req.user);
    const line = assignment.line;
    if (!line?.configured()) return res.status(403).json({ success: false, message: callBlockedReason(assignment) });
    row = await CallEvent.findOne({
      _id: req.params.id,
      companyId: scope.companyId,
      providerDirection: "outbound_browser",
      providerStatus: "IN_PROGRESS",
      endTime: null,
      ...ownedByActor(req, assignment),
    });
    if (!row) return res.status(409).json({ success: false, message: "This call is no longer active." });

    let contact = null;
    if (req.body?.contactId) {
      contact = await VoiceContact.findOne({
        _id: req.body.contactId,
        companyId: scope.companyId,
        isActive: true,
      }).lean();
      if (!contact) return res.status(404).json({ success: false, message: "Voice contact not found." });
    }

    const phoneNumber = cleanE164(req.body?.phoneNumber || contact?.phoneNumber);
    const existing = (row.conferenceParticipants || []).find((participant) =>
      participant.phoneNumber === phoneNumber && ["CUSTOMER_RINGING", "IN_PROGRESS"].includes(participant.status));
    if (existing) return res.json({ success: true, duplicate: true, call: publicCall(row) });

    const contactName = contact
      ? contact.name
      : String(req.body?.contactName || "").trim().slice(0, 120) || null;
    participantIdentity = `conference-${crypto.randomBytes(8).toString("hex")}`;
    row.conferenceParticipants.push({
      participantIdentity,
      phoneNumber,
      contactId: contact?._id || null,
      contactName,
      status: "CUSTOMER_RINGING",
      invitedAt: new Date(),
    });
    await row.save();

    const started = await line.dial({
      roomName: row.livekitRoomName,
      customerPhone: phoneNumber,
      participantIdentity,
      participantName: contactName || "Conference guest",
    });
    row = await CallEvent.findOne({ _id: row._id, companyId: scope.companyId });
    const participant = row?.conferenceParticipants?.find((item) => item.participantIdentity === participantIdentity);
    if (!row || row.endTime || row.providerStatus !== "IN_PROGRESS") {
      await line.hangup({ roomName: row?.livekitRoomName, participantIdentity }).catch(() => null);
      return res.status(409).json({ success: false, message: "The call ended before the person joined." });
    }
    participant.status = "IN_PROGRESS";
    participant.sipCallId = started.sipCallId || null;
    participant.connectedAt = new Date();
    await row.save();
    return res.status(201).json({ success: true, call: publicCall(row) });
  } catch (error) {
    if (row && participantIdentity) {
      const latest = await CallEvent.findOne({ _id: row._id }).catch(() => null);
      const participant = latest?.conferenceParticipants?.find((item) => item.participantIdentity === participantIdentity);
      if (participant && participant.status === "CUSTOMER_RINGING") {
        participant.status = dialFailureState(error);
        participant.endedAt = new Date();
        await latest.save().catch(() => null);
        return res.status(409).json({
          success: false,
          code: participant.status,
          message: DIAL_FAILURE_MESSAGES[participant.status] || "That person couldn't be added.",
          call: publicCall(latest),
        });
      }
    }
    return sendError(res, error);
  }
});

router.delete("/browser-calls/:id", voiceAuth, async (req, res) => {
  try {
    const scope = await scopeFor(req, { domainLabel: "GRAV Voice" });
    const assignment = await assignedVoiceLine(req.user);
    const line = assignment.line;
    if (!line) return res.status(403).json({ success: false, message: callBlockedReason(assignment) });
    const row = await CallEvent.findOne({ _id: req.params.id, companyId: scope.companyId, providerDirection: "outbound_browser", ...ownedByActor(req, assignment) });
    if (!row) return res.status(404).json({ success: false, message: "Browser call not found." });
    // A dial that already ended (busy, no answer, failed) keeps its outcome;
    // pressing End afterwards must not relabel it as cancelled.
    const alreadyEnded = ["COMPLETED", "CANCELLED", "FAILED", "CUSTOMER_BUSY", "CUSTOMER_NO_ANSWER"].includes(row.providerStatus);
    if (alreadyEnded && row.endTime) return res.json({ success: true, call: publicCall(row) });
    await line.hangupMany({ roomName: row.livekitRoomName, participantIdentities: participantIdentities(row) });
    if (row.livekitEgressId) {
      const recording = await line.stopRecording({
        egressId: row.livekitEgressId,
        storageKey: row.recordingStorageKey,
      });
      applyRecordingResult(row, recording);
    }
    row.providerStatus = row.received ? "COMPLETED" : "CANCELLED";
    if (!row.received && !row.livekitEgressId) {
      row.recordingSync.status = "not_expected";
      row.recordingSync.failureCode = "CUSTOMER_NOT_CONNECTED";
    }
    row.endTime = Date.now();
    if (row.connectedAt) row.durationSec = Math.max(0, Math.round((row.endTime - row.connectedAt) / 1000));
    await row.save();
    return res.json({ success: true, call: publicCall(row) });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/calls/:id/refresh", voiceAuth, async (req, res) => {
  try {
    const scope = await scopeFor(req, { domainLabel: "GRAV Voice" });
    const assignment = await assignedVoiceLine(req.user);
    const row = await CallEvent.findOne({ _id: req.params.id, companyId: scope.companyId, ...ownedByActor(req, assignment) });
    if (!row) return res.status(404).json({ success: false, message: "Call not found." });
    // Historical calls remain readable even after an administrator disables or
    // reassigns the employee's line. Live reconciliation needs an active line,
    // so return the last persisted state when there is no longer one available.
    if (!assignment.line) return res.json({ success: true, call: publicCall(row) });
    if (row.providerDirection === "inbound") await reconcileInboundCall(row, assignment.line);
    else if (row.providerDirection === "outbound_browser") await reconcileBrowserCall(row, assignment.line);
    return res.json({ success: true, call: publicCall(row) });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/calls/:id/recording", voiceAuth, async (req, res) => {
  try {
    const scope = await scopeFor(req, { domainLabel: "GRAV Voice" });
    const assignment = await assignedVoiceLine(req.user);
    const row = await CallEvent.findOne({ _id: req.params.id, companyId: scope.companyId, ...ownedByActor(req, assignment) });
    if (!row) return res.status(404).json({ success: false, message: "Call not found." });
    if (!["outbound_browser", "inbound"].includes(row.providerDirection)) {
      return res.status(409).json({ success: false, message: "Recording is not available." });
    }
    if (!row.recordingStorageKey || row.recordingSync?.status !== "imported") {
      return res.status(409).json({ success: false, message: "This recording is still processing or was not saved." });
    }
    const { admin } = require("../../../config/firebaseAdmin");
    const bucketName = String(process.env.LIVEKIT_EGRESS_GCP_BUCKET || process.env.FIREBASE_STORAGE_BUCKET || "").trim();
    if (!bucketName) return res.status(503).json({ success: false, message: "Recording storage is not configured." });
    const file = admin.storage().bucket(bucketName).file(row.recordingStorageKey);
    const [metadata] = await file.getMetadata();
    const size = Number(metadata.size || 0);
    const range = String(req.headers.range || "").match(/^bytes=(\d+)-(\d*)$/);
    let start = 0;
    let end = size > 0 ? size - 1 : undefined;
    if (range && size > 0) {
      start = Number(range[1]);
      end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        res.setHeader("Content-Range", `bytes */${size}`);
        return res.status(416).end();
      }
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    }
    res.setHeader("Content-Type", row.recordingMimeType || metadata.contentType || "audio/mpeg");
    res.setHeader("Content-Disposition", `inline; filename="grav-call-${row._id}.mp3"`);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, no-store");
    if (size > 0) res.setHeader("Content-Length", String((end ?? size - 1) - start + 1));
    return file.createReadStream({ start, end }).on("error", (error) => {
      console.error("[GRAV Voice recording stream]", error?.message || error);
      if (!res.headersSent) res.status(502).end();
      else res.destroy(error);
    }).pipe(res);
  } catch (error) {
    return sendError(res, error);
  }
});

module.exports = router;
