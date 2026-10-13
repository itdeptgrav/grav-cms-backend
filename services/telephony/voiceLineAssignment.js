"use strict";

const crypto = require("crypto");
const { SalesPerson } = require("../../models/CMS_Models/Sales/SalesPerson");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const { LiveKitBrowserCall } = require("./livekitBrowserCall");

function e164(value) {
  const raw = String(value || "").trim().replace(/[\s()-]/g, "");
  if (/^\d{10}$/.test(raw)) return `+91${raw}`;
  if (/^91\d{10}$/.test(raw)) return `+${raw}`;
  if (/^\+[1-9]\d{7,14}$/.test(raw)) return raw;
  return null;
}

function safeRoomName(value) {
  const clean = String(value || "").trim();
  return /^[a-zA-Z0-9_-]{8,120}$/.test(clean) ? clean : null;
}

function actorSelector(user = {}) {
  const choices = [];
  if (user.id) choices.push({ employeeRef: user.id });
  if (user.employeeId) choices.push({ employeeCode: String(user.employeeId) });
  if (user.email) choices.push({ email: String(user.email).trim().toLowerCase() });
  return choices.length ? { active: true, $or: choices } : null;
}

function membershipSelector(user = {}) {
  const choices = [];
  if (user.id && /^[a-f\d]{24}$/i.test(String(user.id))) choices.push({ employeeRef: user.id });
  if (user.email) choices.push({ email: String(user.email).trim().toLowerCase() });
  return choices.length ? { isActive: true, $or: choices } : null;
}

async function assignedVoiceLine(user, {
  SalesPersonModel = SalesPerson,
  MembershipModel = SpCompanyMembership,
  env = process.env,
} = {}) {
  const memberSelector = membershipSelector(user);
  const member = memberSelector
    ? await MembershipModel.findOne({ ...memberSelector, voiceEnabled: true, voiceNumber: { $type: "string" } }).lean()
    : null;
  const selector = actorSelector(user);
  if (!selector) return { assigned: false, configured: false, inboundConfigured: false, reason: "No Voice line is assigned to your account." };
  const salesOwner = member ? null : await SalesPersonModel.findOne(selector).lean();
  const owner = member || salesOwner;
  const number = e164(owner?.voiceNumber);
  if (!owner || owner.voiceEnabled !== true || !number) {
    return { assigned: false, configured: false, inboundConfigured: false, owner: owner || null, reason: "No Voice line is assigned to your account." };
  }
  const outboundTrunkId = String(owner.voiceOutboundTrunkId || env.GRAV_VOICE_SIP_OUTBOUND_TRUNK_ID || env.LIVEKIT_PLIVO_SIP_OUTBOUND_TRUNK_ID || "").trim();
  const inboundTrunkId = String(owner.voiceInboundTrunkId || "").trim();
  const roomName = safeRoomName(owner.voiceInboundRoomName)
    || `grav-voice-in-${crypto.createHash("sha256").update(String(owner._id)).digest("hex").slice(0, 24)}`;
  const line = new LiveKitBrowserCall({
    provider: env.GRAV_VOICE_CARRIER || "plivo",
    // Voice can live in a dedicated LiveKit project without migrating Cowork,
    // screen sharing, or any other feature that uses the legacy global keys.
    url: env.GRAV_VOICE_LIVEKIT_URL || env.LIVEKIT_URL,
    apiKey: env.GRAV_VOICE_LIVEKIT_API_KEY || env.LIVEKIT_API_KEY,
    apiSecret: env.GRAV_VOICE_LIVEKIT_API_SECRET || env.LIVEKIT_API_SECRET,
    outboundTrunkId,
    businessNumber: number,
    recordingBucket: env.LIVEKIT_EGRESS_GCP_BUCKET || env.FIREBASE_STORAGE_BUCKET,
    recordingCredentials: env.LIVEKIT_EGRESS_GCP_CREDENTIALS || env.FIREBASE_SERVICE_ACCOUNT,
  });
  return {
    assigned: true,
    configured: line.configured(),
    inboundConfigured: Boolean(line.url && line.apiKey && line.apiSecret && inboundTrunkId && roomName),
    number,
    outboundTrunkId,
    inboundTrunkId,
    roomName,
    owner,
    ownerKind: member ? "company_membership" : "sales_person",
    salesPersonOwnerId: member ? null : owner._id,
    line,
    reason: line.configured() ? null : "Your Voice number has not been connected to an outbound trunk yet.",
  };
}

async function voiceOwnerByNumber(value, {
  SalesPersonModel = SalesPerson,
  MembershipModel = SpCompanyMembership,
} = {}) {
  const number = e164(value);
  if (!number) return null;
  const selector = { voiceEnabled: true, voiceNumber: { $in: [number, number.slice(1)] } };
  const member = await MembershipModel.findOne({ isActive: true, ...selector }).lean();
  if (member) return { number, owner: member, ownerKind: "company_membership" };
  const salesOwner = await SalesPersonModel.findOne({ active: true, ...selector }).lean();
  return salesOwner ? { number, owner: salesOwner, ownerKind: "sales_person" } : null;
}

module.exports = { actorSelector, assignedVoiceLine, e164, membershipSelector, safeRoomName, voiceOwnerByNumber };
