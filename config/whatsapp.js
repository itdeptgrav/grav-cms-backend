// config/whatsapp.js
//
// WhatsApp Cloud API configuration — ALL values come from environment variables
// (never hard-coded; the access token in particular is a secret and must stay
// server-side). Set these in the backend `.env`:
//
//   WHATSAPP_VERIFY_TOKEN     — a string YOU invent; also typed into Meta's
//                               webhook "Verify token" field. The GET webhook
//                               echoes Meta's challenge only when it matches.
//   WHATSAPP_ACCESS_TOKEN     — the permanent access token (System User token).
//   WHATSAPP_PHONE_NUMBER_ID  — the Phone Number ID (NOT the phone number).
//   WHATSAPP_WABA_ID          — the WhatsApp Business Account ID.
//   WHATSAPP_APP_SECRET       — (optional) the Meta app secret, used to verify
//                               the X-Hub-Signature-256 on incoming webhooks.
//   WHATSAPP_API_VERSION      — (optional) Graph API version, default "v21.0".
//
// Nothing here reaches out to Meta — it only reads config and builds URLs.

const crypto = require("crypto");

// `.trim()` every value — a stray leading/trailing space in .env (e.g.
// `WHATSAPP_PHONE_NUMBER_ID= 1199...`) would otherwise corrupt the Graph URL
// and silently break sending.
const clean = (v, fallback = "") => String(v ?? "").trim() || fallback;
const cfg = {
  verifyToken: clean(process.env.WHATSAPP_VERIFY_TOKEN),
  accessToken: clean(process.env.WHATSAPP_ACCESS_TOKEN),
  phoneNumberId: clean(process.env.WHATSAPP_PHONE_NUMBER_ID),
  wabaId: clean(process.env.WHATSAPP_WABA_ID),
  appSecret: clean(process.env.WHATSAPP_APP_SECRET),
  apiVersion: clean(process.env.WHATSAPP_API_VERSION, "v21.0"),
};

// Can we RECEIVE webhooks? (only the verify token is strictly required for the
// subscription handshake).
const canReceive = () => Boolean(cfg.verifyToken);
// Can we SEND messages? (needs a token + the phone number id).
const canSend = () => Boolean(cfg.accessToken && cfg.phoneNumberId);

const graphBase = () => `https://graph.facebook.com/${cfg.apiVersion}`;
const messagesUrl = () => `${graphBase()}/${cfg.phoneNumberId}/messages`;
const mediaUrl = (mediaId) => `${graphBase()}/${mediaId}`;

// Validate Meta's webhook signature. Returns true when no app secret is
// configured (verification simply skipped) OR the HMAC matches. `rawBody` must
// be the exact bytes Meta sent (captured via express.json's `verify`, see
// server.js).
function verifySignature(rawBody, signatureHeader) {
  if (!cfg.appSecret) return true; // not enforcing — nothing to check against
  if (!signatureHeader || !rawBody) return false;
  const expected =
    "sha256=" + crypto.createHmac("sha256", cfg.appSecret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
  } catch {
    return false; // length mismatch → not equal
  }
}

module.exports = { cfg, canReceive, canSend, graphBase, messagesUrl, mediaUrl, verifySignature };
