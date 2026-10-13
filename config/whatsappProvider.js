// Active WhatsApp transport selection.
//
// OpenWA is intentionally the default for the Sales inbox. The official Meta
// Cloud API remains available as a dormant adapter and can only be re-enabled
// by explicitly setting WHATSAPP_PROVIDER=meta. There is deliberately no
// automatic fallback: a broken OpenWA session must never cause the CMS to send
// through a paid/official account unexpectedly.

const clean = (value, fallback = "") => String(value ?? "").trim() || fallback;
const normaliseProvider = (value) => {
  const provider = clean(value, "openwa").toLowerCase();
  return ["openwa", "meta", "disabled"].includes(provider) ? provider : "disabled";
};

const cfg = {
  provider: normaliseProvider(process.env.WHATSAPP_PROVIDER),
  openwaBaseUrl: clean(process.env.OPENWA_BASE_URL, "http://127.0.0.1:8080").replace(/\/+$/, ""),
  openwaApiKey: clean(process.env.OPENWA_API_KEY),
  openwaWebhookSecret: clean(process.env.OPENWA_WEBHOOK_SECRET),
  openwaSessionId: clean(process.env.OPENWA_SESSION_ID, "sales"),
  // A webhook has no signed-in browser user from which to derive company
  // scope. The linked Sales number therefore has one explicit owner. Keep the
  // MARKETING_COMPANY_ID fallback only for the existing single-company dev
  // deployment; production should set OPENWA_COMPANY_ID directly.
  openwaCompanyId: clean(process.env.OPENWA_COMPANY_ID, process.env.MARKETING_COMPANY_ID),
  // GRAV's locally-entered mobile numbers are normally Indian 10-digit
  // numbers. WhatsApp chat IDs always require the international country code.
  openwaDefaultCountryCode: clean(process.env.OPENWA_DEFAULT_COUNTRY_CODE, "91").replace(/\D/g, ""),
  requestTimeoutMs: Math.max(1000, Number(process.env.OPENWA_REQUEST_TIMEOUT_MS) || 15000),
};

const isOpenWaActive = () => cfg.provider === "openwa";
const isMetaActive = () => cfg.provider === "meta";

module.exports = { cfg, isOpenWaActive, isMetaActive, normaliseProvider };
