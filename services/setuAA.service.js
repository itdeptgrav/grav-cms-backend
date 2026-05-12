// services/setuAA.service.js
//
// Setu Account Aggregator (AA) integration.
//
// Setu is an FIU-enabler — they hold the actual FIU registration with RBI
// and let businesses like GRAV piggyback on their licence. This service
// wraps Setu's AA APIs into a clean Node interface.
//
// Setup (must be done by the user before any of this works):
//   1. Sign up at https://bridge.setu.co
//   2. Create an AA-Data product, get sandbox credentials
//   3. Set these env vars in your backend:
//        SETU_AA_BASE_URL          — sandbox: https://fiu-sandbox.setu.co
//                                    production: https://fiu.setu.co
//                                    (provided by Setu after go-live)
//        SETU_AA_CLIENT_ID         — from Bridge → Step 5
//        SETU_AA_CLIENT_SECRET     — from Bridge → Step 5
//        SETU_AA_PRODUCT_ID        — your product instance id
//        SETU_AA_REDIRECT_URL      — where users return after consent
//                                    (e.g. https://your-cms.com/accountant/bank-transactions/consent-callback)
//        SETU_AA_NOTIFICATION_SECRET — shared secret for webhook signatures
//        SETU_AA_PURPOSE_CODE       — e.g. "101" for "Wealth management service"
//                                    or "105" for "Customer spending patterns,
//                                    budget or other reportings". Pick from
//                                    https://docs.setu.co/data/account-aggregator/consent-object
//
// The service auto-detects whether credentials are present. If not, every
// method throws a clear "credentials not configured" error rather than
// silently failing — so the UI can prompt the user to set up Setu first.

const crypto = require("crypto");

const REQUIRED_ENV = [
  "SETU_AA_BASE_URL",
  "SETU_AA_CLIENT_ID",
  "SETU_AA_CLIENT_SECRET",
  "SETU_AA_PRODUCT_ID",
];

function isConfigured() {
  return REQUIRED_ENV.every((k) => !!process.env[k]);
}

function assertConfigured() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    const err = new Error(
      "Setu AA is not configured. Missing environment variables: " +
        missing.join(", ") +
        ". Sign up at https://bridge.setu.co, create an AA-Data product, then add the credentials to your backend .env file.",
    );
    err.code = "SETU_NOT_CONFIGURED";
    throw err;
  }
}

function authHeaders() {
  return {
    "Content-Type": "application/json",
    "x-client-id": process.env.SETU_AA_CLIENT_ID,
    "x-client-secret": process.env.SETU_AA_CLIENT_SECRET,
    "x-product-instance-id": process.env.SETU_AA_PRODUCT_ID,
  };
}

// Generic fetch wrapper with retry on transient errors
async function setuFetch(path, opts = {}, attempt = 1) {
  assertConfigured();
  const url = `${process.env.SETU_AA_BASE_URL.replace(/\/$/, "")}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: { ...authHeaders(), ...(opts.headers || {}) },
  });

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  // Debug: log raw response so we can see Setu's actual shape
  console.log(
    `[Setu AA] ${opts.method || "GET"} ${path} → ${res.status}:`,
    JSON.stringify(body).slice(0, 500),
  );

  if (res.status >= 500 && attempt < 3) {
    // Brief backoff then retry — Setu sometimes flaps
    await new Promise((r) => setTimeout(r, 500 * attempt));
    return setuFetch(path, opts, attempt + 1);
  }

  if (!res.ok) {
    const err = new Error(
      `Setu AA ${opts.method || "GET"} ${path} failed (${res.status}): ` +
        (body?.error?.message || body?.message || text),
    );
    err.status = res.status;
    err.body = body;
    throw err;
  }

  return body;
}

// ─── Consent flow ────────────────────────────────────────────────────────

/**
 * Create a consent request.
 *
 * @param {Object} opts
 * @param {String} opts.customerMobile       — 10-digit mobile (the bank
 *                                              account holder's mobile, used
 *                                              to discover their AA handle)
 * @param {String[]} opts.fiTypes            — e.g. ["DEPOSIT"] for bank
 * @param {Date} opts.fiFrom                 — earliest date to fetch
 * @param {Date} opts.fiTo                   — latest date to fetch
 * @param {Number} opts.consentExpiryDays    — how long the consent stays valid (default 365)
 * @param {String} opts.consentMode          — "STORE" | "VIEW" (default STORE)
 * @param {String} opts.fetchType            — "ONETIME" | "PERIODIC"
 * @param {String} opts.purposeCode          — Setu purpose code, default from env
 * @param {String} opts.redirectUrl          — where to send user after consent
 *
 * @returns { id, url, status } — `url` is what you redirect the customer to
 */
async function createConsent({
  customerMobile,
  fiTypes = ["DEPOSIT"],
  fiFrom,
  fiTo,
  consentDurationMonths = 12,
  purposeCode,
  redirectUrl,
} = {}) {
  if (!customerMobile) throw new Error("customerMobile is required");
  if (!fiFrom || !fiTo) throw new Error("fiFrom and fiTo are required");

  // v2 flat-shape body per https://docs.setu.co/data/account-aggregator/api-integration/consent-flow
  //
  // Note: Purpose, fiTypes, fetchType, consentMode, dataLife, frequency,
  // and consentTypes are all configured per-product on Bridge (Step 1 of
  // product setup) and applied automatically by Setu. We only override
  // them via API if needed — for the simple bank-statement use case, the
  // Bridge defaults are correct, so we send a minimal body.
  const body = {
    consentDuration: {
      unit: "MONTH",
      value: String(consentDurationMonths),
    },
    // VUA = "Virtual User Address" — Setu auto-discovers AA handle from
    // mobile if no @handle suffix given. Just send the bare mobile.
    vua: customerMobile,
    dataRange: {
      from: fiFrom.toISOString(),
      to: fiTo.toISOString(),
    },
    context: [],
    redirectUrl: redirectUrl || process.env.SETU_AA_REDIRECT_URL,
  };

  return setuFetch("/v2/consents", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function getConsentStatus(consentId) {
  if (!consentId) throw new Error("consentId is required");
  return setuFetch(`/v2/consents/${consentId}`);
}

async function revokeConsent(consentId) {
  if (!consentId) throw new Error("consentId is required");
  return setuFetch(`/v2/consents/${consentId}/revoke`, { method: "POST" });
}

// ─── Data session flow ───────────────────────────────────────────────────
// After a consent is ACTIVE, you create a "data session" to fetch the
// actual financial information. The session is async — it goes through
// PENDING → READY → DELIVERED (or FAILED). FI notifications signal when
// it's ready to fetch.

async function createDataSession(consentId, fiFrom, fiTo) {
  if (!consentId) throw new Error("consentId is required");
  if (!fiFrom || !fiTo) throw new Error("fiFrom and fiTo are required");
  return setuFetch("/v2/sessions", {
    method: "POST",
    body: JSON.stringify({
      consentId,
      dataRange: {
        from: fiFrom.toISOString(),
        to: fiTo.toISOString(),
      },
      format: "json",
    }),
  });
}

async function getDataSession(sessionId) {
  if (!sessionId) throw new Error("sessionId is required");
  return setuFetch(`/v2/sessions/${sessionId}`);
}

async function fetchFIData(sessionId) {
  if (!sessionId) throw new Error("sessionId is required");
  // Setu returns the fi data array on this endpoint once session is ready
  return setuFetch(`/v2/sessions/${sessionId}/fi`);
}

// ─── Webhook signature verification ───────────────────────────────────────
// Setu signs notification payloads with a shared secret. Verify before
// trusting any payload. The signature header is named differently across
// Setu products — for AA notifications, look for `x-setu-signature`.

function verifyWebhookSignature(payload, signature, secret) {
  if (!secret) {
    // If user hasn't configured a secret, we can't verify. Refuse rather
    // than allow unsigned webhooks through — this protects the data path.
    return false;
  }
  const computed = crypto
    .createHmac("sha256", secret)
    .update(typeof payload === "string" ? payload : JSON.stringify(payload))
    .digest("hex");
  // Constant-time comparison
  try {
    return crypto.timingSafeEqual(
      Buffer.from(computed, "hex"),
      Buffer.from(signature || "", "hex"),
    );
  } catch {
    return false;
  }
}

// ─── FI Data → BankTransaction normalization ─────────────────────────────
// Setu's actual FI data response (confirmed from sandbox):
//   {
//     id: "<sessionId>",
//     consentId: "...",
//     fips: [{
//       fipID: "setu-fip" | "setu-fip-2" | ...,
//       accounts: [{
//         linkRefNumber: "...",
//         maskedAccNumber: "XXXXXXXX1234",
//         FIstatus: "READY" | "PENDING" | "FAILED",
//         data: {
//           account: {
//             linkedAccRef: "...",
//             maskedAccNumber: "...",
//             type: "deposit",
//             version: "2.0.0",
//             transactions: {
//               startDate: "2026-04-09",
//               endDate:   "2026-05-09",
//               transaction: [{
//                 type: "CREDIT" | "DEBIT",
//                 mode: "UPI" | "NEFT" | "RTGS" | "IMPS" | "CASH" | ...,
//                 amount: "100.00",
//                 currentBalance: "5000.00",
//                 transactionTimestamp: "2026-04-01T10:30:00Z",
//                 valueDate: "2026-04-01",
//                 txnId: "...",
//                 narration: "...",
//                 reference: "...",
//               }]
//             }
//           }
//         }
//       }]
//     }]
//   }
//
// Also tolerates the older capitalized ReBIT shape (Account.Transactions.Transaction)
// in case Setu returns it for some FIPs.
//
// Skips accounts where:
//   • FIstatus is not READY (still PENDING, or FAILED)
//   • maskedAccNumber starts with "FAILURE" (sandbox failure stubs)
//   • data.account is missing entirely

function normalizeSetuFIData(fiData, bankAccountIdentifier) {
  const out = [];

  // Walk every plausible root: fiData.fips, fiData.fi, fiData.data, fiData itself
  const fips =
    fiData?.fips ||
    fiData?.fi ||
    (Array.isArray(fiData?.data) ? fiData.data : null) ||
    (Array.isArray(fiData) ? fiData : []);
  if (!Array.isArray(fips)) return out;

  for (const fip of fips) {
    const fipId = fip?.fipID || fip?.fipId || "unknown";
    // Setu's actual shape: fip.accounts[].data.account.transactions.transaction
    // Also accept the older nested shape: fip.data[].Account.Transactions.Transaction
    const accountList = Array.isArray(fip?.accounts)
      ? fip.accounts
      : Array.isArray(fip?.data)
        ? fip.data
        : [];

    for (const acct of accountList) {
      // Skip non-ready / failed accounts
      const fiStatus = acct?.FIstatus || acct?.fiStatus;
      if (fiStatus && fiStatus !== "READY" && fiStatus !== "DELIVERED")
        continue;
      const masked =
        acct?.maskedAccNumber || acct?.data?.account?.maskedAccNumber;
      if (masked && masked.startsWith("FAILURE")) continue;

      // Find the transaction array — try modern lowercase shape first
      const acctData = acct?.data?.account || acct?.Account || {};
      const txnContainer =
        acctData?.transactions || acctData?.Transactions || {};
      const txns = txnContainer?.transaction || txnContainer?.Transaction || [];

      if (!Array.isArray(txns) || txns.length === 0) continue;

      for (const t of txns) {
        const isCredit =
          String(t.type || t.txnType || "").toUpperCase() === "CREDIT";
        const ts =
          t.transactionTimestamp || t.txnTimestamp || t.valueDate || t.valueDt;
        out.push({
          bankAccount: bankAccountIdentifier,
          transactionDate: ts ? new Date(ts) : new Date(),
          type: isCredit ? "credit" : "debit",
          amount: parseFloat(t.amount) || 0,
          runningBalance:
            t.currentBalance != null ? parseFloat(t.currentBalance) : null,
          description:
            t.narration ||
            `${t.mode || ""} ${isCredit ? "credit" : "debit"}`.trim(),
          referenceNumber: t.reference || t.refNo || t.txnId || "",
          transactionId: t.txnId || "",
          source: `setu_aa:${fipId}`,
          mode: t.mode,
          fipId,
          maskedAccount: masked,
          bankName: "Indian Bank", // can be enriched from settings
        });
      }
    }
  }
  return out;
}

module.exports = {
  isConfigured,
  assertConfigured,
  createConsent,
  getConsentStatus,
  revokeConsent,
  createDataSession,
  getDataSession,
  fetchFIData,
  verifyWebhookSignature,
  normalizeSetuFIData,
};
