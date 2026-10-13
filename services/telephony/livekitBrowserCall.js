"use strict";

const {
  AccessToken,
  EgressClient,
  EgressStatus,
  EncodedFileOutput,
  EncodedFileType,
  GCPUpload,
  RoomServiceClient,
  SipClient,
} = require("livekit-server-sdk");
const { ParticipantInfo_Kind } = require("@livekit/protocol");

function required(value, name) {
  const clean = String(value || "").trim();
  if (!clean) {
    const error = new Error(`${name} is required for browser calling.`);
    error.code = "BROWSER_CALL_NOT_CONFIGURED";
    throw error;
  }
  return clean;
}

function httpLiveKitUrl(value) {
  return required(value, "LIVEKIT_URL").replace(/^wss:/, "https:").replace(/^ws:/, "http:");
}

function sipState(value) {
  switch (String(value || "").trim().toLowerCase()) {
    case "dialing": return "CUSTOMER_RINGING";
    case "active": return "IN_PROGRESS";
    case "hangup": return "COMPLETED";
    default: return null;
  }
}

function outboundNumber(value) {
  const clean = String(value || "").trim().replace(/[\s()-]/g, "");
  if (/^0\d{10}$/.test(clean)) return `+91${clean.slice(1)}`;
  if (/^91\d{10}$/.test(clean)) return `+${clean}`;
  return clean;
}

function participantAlreadyGone(error) {
  const code = String(error?.code || error?.status || error?.metadata?.code || "").toLowerCase();
  const text = `${error?.message || ""} ${error?.details || ""}`.toLowerCase();
  return code === "not_found" || code === "404" || /not[ _-]?found|does not exist|participant.*gone/.test(text);
}

// The SIP status a failed dial carries, read defensively: the server SDK puts
// it in the Twirp error metadata, older builds only in the message text.
function dialFailureState(error) {
  const meta = error?.metadata || {};
  const code = Number(meta.sip_status_code || meta.sipStatusCode || 0);
  const text = `${meta.sip_status || ""} ${error?.message || ""}`.toLowerCase();
  if (code === 486 || code === 600 || code === 603 || /busy|declin/.test(text)) return "CUSTOMER_BUSY";
  if ([408, 480, 487].includes(code) || /no answer|not answered|timeout|timed out|unavailable/.test(text)) {
    return "CUSTOMER_NO_ANSWER";
  }
  return "FAILED";
}

/**
 * The one GRAV calling line: the employee's browser joins a private LiveKit
 * room and the customer is dialled into it as a SIP participant through the
 * company's outbound trunk. There is deliberately no provider switch — the
 * carrier behind the trunk is configuration, not a choice made per call.
 */
class LiveKitBrowserCall {
  constructor(config = {}) {
    // Recorded on each CallEvent as the carrier that actually placed the call.
    this.provider = String(config.provider || "plivo").trim().toLowerCase();
    this.url = String(config.url || "").trim();
    this.apiKey = String(config.apiKey || "").trim();
    this.apiSecret = String(config.apiSecret || "").trim();
    this.outboundTrunkId = String(config.outboundTrunkId || "").trim();
    this.businessNumber = outboundNumber(config.businessNumber);
    this.recordingBucket = String(config.recordingBucket || "").trim();
    this.recordingCredentials = String(config.recordingCredentials || "").trim();
    this.roomClientFactory = config.roomClientFactory || ((url, key, secret) => new RoomServiceClient(url, key, secret));
    this.sipClientFactory = config.sipClientFactory || ((url, key, secret) => new SipClient(url, key, secret));
    this.egressClientFactory = config.egressClientFactory || ((url, key, secret) => new EgressClient(url, key, secret));
  }

  static fromEnv(env = process.env) {
    return new LiveKitBrowserCall({
      provider: env.GRAV_VOICE_CARRIER || "plivo",
      url: env.LIVEKIT_URL,
      apiKey: env.LIVEKIT_API_KEY,
      apiSecret: env.LIVEKIT_API_SECRET,
      outboundTrunkId: env.GRAV_VOICE_SIP_OUTBOUND_TRUNK_ID || env.LIVEKIT_PLIVO_SIP_OUTBOUND_TRUNK_ID,
      businessNumber: env.GRAV_VOICE_CALLER_ID || env.PLIVO_CALLER_ID,
      recordingBucket: env.LIVEKIT_EGRESS_GCP_BUCKET || env.FIREBASE_STORAGE_BUCKET,
      recordingCredentials: env.LIVEKIT_EGRESS_GCP_CREDENTIALS || env.FIREBASE_SERVICE_ACCOUNT,
    });
  }

  configured() {
    return Boolean(this.url && this.apiKey && this.apiSecret && this.outboundTrunkId && this.businessNumber);
  }

  recordingConfigured() {
    return Boolean(this.url && this.apiKey && this.apiSecret && this.recordingBucket && this.recordingCredentials);
  }

  // Shown to the person trying to call, so it says what is wrong in their
  // words. The missing variable names belong in the server log, not the UI.
  setupMessage() {
    return this.configured() ? null : "Calling isn't set up for GRAV yet. Ask your administrator to connect the business line.";
  }

  describe() {
    return {
      configured: this.configured(),
      callerId: this.businessNumber || null,
      recordingConfigured: this.recordingConfigured(),
      message: this.setupMessage(),
    };
  }

  clients() {
    const url = httpLiveKitUrl(this.url);
    const key = required(this.apiKey, "LIVEKIT_API_KEY");
    const secret = required(this.apiSecret, "LIVEKIT_API_SECRET");
    return {
      rooms: this.roomClientFactory(url, key, secret),
      sip: this.sipClientFactory(url, key, secret),
      egress: this.egressClientFactory(url, key, secret),
    };
  }

  async startRecording({ roomName, storageKey }) {
    if (!this.recordingConfigured()) {
      const error = new Error("LiveKit recording storage is not configured.");
      error.code = "BROWSER_RECORDING_NOT_CONFIGURED";
      throw error;
    }
    const { egress } = this.clients();
    const output = new EncodedFileOutput({
      fileType: EncodedFileType.MP3,
      filepath: required(storageKey, "recording storage key"),
      output: {
        case: "gcp",
        value: new GCPUpload({
          credentials: this.recordingCredentials,
          bucket: this.recordingBucket,
        }),
      },
    });
    const info = await egress.startRoomCompositeEgress(roomName, output, { audioOnly: true });
    return this.recordingResult(info, storageKey);
  }

  recordingResult(info, storageKey = null) {
    if (!info) return null;
    const file = info.fileResults?.[0] || (info.result?.case === "file" ? info.result.value : null);
    const status = Number(info.status);
    return {
      egressId: info.egressId || null,
      status,
      complete: status === EgressStatus.EGRESS_COMPLETE,
      failed: [EgressStatus.EGRESS_FAILED, EgressStatus.EGRESS_ABORTED, EgressStatus.EGRESS_LIMIT_REACHED].includes(status),
      storageKey: file?.filename || storageKey || null,
      size: file?.size == null ? 0 : Number(file.size),
      error: info.error || info.details || null,
    };
  }

  async recordingStatus({ egressId, storageKey }) {
    if (!egressId) return null;
    const { egress } = this.clients();
    const rows = await egress.listEgress({ egressId });
    return this.recordingResult(rows?.[0], storageKey);
  }

  async stopRecording({ egressId, storageKey }) {
    if (!egressId) return null;
    const { egress } = this.clients();
    try {
      const info = await egress.stopEgress(egressId);
      return this.recordingResult(info, storageKey);
    } catch (error) {
      const current = await this.recordingStatus({ egressId, storageKey }).catch(() => null);
      if (current) return current;
      throw error;
    }
  }

  async createSession({ roomName, identity, displayName }) {
    const { rooms } = this.clients();
    // Employee + the original customer + invited conference members.
    await rooms.createRoom({ name: roomName, emptyTimeout: 120, maxParticipants: 12 });
    const token = new AccessToken(this.apiKey, this.apiSecret, {
      identity,
      name: displayName || "GRAV employee",
      ttl: "1h",
    });
    token.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
    return { roomName, url: this.url, token: await token.toJwt() };
  }

  async dial({ roomName, customerPhone, participantIdentity, participantName = "Customer" }) {
    const { sip } = this.clients();
    const participant = await sip.createSipParticipant(
      required(this.outboundTrunkId, "GRAV_VOICE_SIP_OUTBOUND_TRUNK_ID"),
      customerPhone,
      roomName,
      {
        fromNumber: this.businessNumber,
        participantIdentity,
        participantName,
        playDialtone: true,
        ringingTimeout: 45,
        maxCallDuration: 3600,
        // This promise is the connection boundary for connected-only
        // recording. Ringback must not be captured by Egress.
        waitUntilAnswered: true,
        timeout: 50,
      },
    );
    return {
      participantIdentity: participant.participantIdentity || participantIdentity,
      sipCallId: participant.sipCallId || null,
    };
  }

  async status({ roomName, participantIdentity }) {
    const { rooms } = this.clients();
    const participants = await rooms.listParticipants(roomName).catch((error) => {
      if (/not found/i.test(String(error?.message))) return [];
      throw error;
    });
    const participant = participants.find((item) => item.identity === participantIdentity);
    if (!participant) return { present: false, status: null, sipCallId: null };
    const attributes = participant.attributes || {};
    return {
      present: true,
      status: sipState(attributes["sip.callStatus"]) || "CUSTOMER_RINGING",
      sipCallId: attributes["sip.callID"] || null,
    };
  }

  async participantStatuses({ roomName, participantIdentities = [] }) {
    const { rooms } = this.clients();
    const participants = await rooms.listParticipants(roomName).catch((error) => {
      if (/not found/i.test(String(error?.message))) return [];
      throw error;
    });
    const wanted = new Set(participantIdentities.filter(Boolean));
    return participants
      .filter((item) => wanted.has(item.identity))
      .map((participant) => ({
        participantIdentity: participant.identity,
        present: true,
        status: sipState(participant.attributes?.["sip.callStatus"]) || "CUSTOMER_RINGING",
        sipCallId: participant.attributes?.["sip.callID"] || null,
      }));
  }

  /**
   * Read the one inbound SIP caller waiting in an employee's dedicated room.
   * The dispatch rule, not caller-controlled metadata, decides which employee
   * room receives the call. Only provider attributes needed for correlation
   * leave this boundary.
   */
  async incomingCaller({ roomName }) {
    const { rooms } = this.clients();
    const participants = await rooms.listParticipants(required(roomName, "inbound room name")).catch((error) => {
      if (/not found/i.test(String(error?.message))) return [];
      throw error;
    });
    const participant = participants.find((item) => {
      const attributes = item.attributes || {};
      // LiveKit marks the participant kind synchronously, while SIP
      // attributes can arrive a little later. Detecting inbound calls only by
      // attributes therefore misses the exact interval in which the browser
      // needs to start ringing.
      return item.kind === ParticipantInfo_Kind.SIP
        || Boolean(attributes["sip.callID"] || attributes["sip.phoneNumber"] || attributes["sip.trunkPhoneNumber"]);
    });
    if (!participant) return null;
    const attributes = participant.attributes || {};
    // Participant identity is stable for the whole room visit. sip.callID is
    // populated asynchronously, so using it as the database key could change
    // a ringing call's identity halfway through polling and create a duplicate.
    const callId = String(participant.identity || attributes["sip.callID"] || "").trim();
    if (!callId) return null;
    return {
      callId,
      participantIdentity: participant.identity,
      callerPhone: outboundNumber(attributes["sip.phoneNumber"] || participant.name || ""),
      calledNumber: outboundNumber(attributes["sip.trunkPhoneNumber"] || this.businessNumber),
      status: sipState(attributes["sip.callStatus"]) || "AGENT_RINGING",
    };
  }

  async hangup({ roomName, participantIdentity }) {
    const { rooms } = this.clients();
    // A customer-side hang-up removes the SIP participant before the browser
    // asks us to finish the call. Removing an already-gone participant is a
    // successful, idempotent hang-up—not a reason to leave the database row
    // stuck IN_PROGRESS.
    const current = await this.status({ roomName, participantIdentity });
    if (!current.present) return { alreadyEnded: true };
    await rooms.removeParticipant(roomName, participantIdentity).catch((error) => {
      if (!participantAlreadyGone(error)) throw error;
    });
    return { alreadyEnded: false };
  }


  async hangupMany({ roomName, participantIdentities = [] }) {
    const results = await Promise.all(participantIdentities.filter(Boolean).map((participantIdentity) =>
      this.hangup({ roomName, participantIdentity })));
    return { removed: results.filter((result) => !result.alreadyEnded).length };
  }
}

module.exports = { LiveKitBrowserCall, dialFailureState, outboundNumber, participantAlreadyGone, sipState };
