// routes/Accountant_Routes/Acc_setuAA.js
//
// Setu AA endpoints — used by the Bank Transactions page to:
//   1. GET  /status                           — credentials check + connector list
//   2. POST /init-consent                     — start consent for a bank account
//   3. GET  /consent/:id                      — poll consent status
//   4. POST /sync/:bankAccount                — fetch transactions
//   5. POST /revoke/:id                       — revoke a consent
//   6. POST /webhook (PUBLIC, no auth)        — receives Setu notifications
//
// Single router export — auth bypass for /webhook is done via route ordering:
// /webhook is registered BEFORE `router.use(accountantAuth)`, so the auth
// middleware doesn't apply to it. Everything below that line is protected.
//
// Connector state lives in the Acc_SetuConsent collection (one doc per bank
// account) — we don't try to stuff it into Acc_Settings, which has
// a stricter schema and was silently dropping the field.

const express = require("express");
const crypto = require("crypto");
const AccountantAuthMiddleware = require("../../Middlewear/AccountantAuthMiddleware");
const {
  Acc_BankTransaction,
} = require("../../models/Accountant_model/Acc_OperationalModels");
const Acc_SetuConsent = require("../../models/Accountant_model/Acc_SetuConsent");
const setuAA = require("../../services/setuAA.service");

const router = express.Router();

// ─── PUBLIC ROUTES (no auth) ───────────────────────────────────────────────
// Must be defined BEFORE router.use(accountantAuth) below.

router.post("/webhook", async (req, res) => {
  try {
    // Verify signature so only real Setu callbacks are accepted
    const signature =
      req.get("x-setu-signature") || req.get("X-Setu-Signature");
    const secret = process.env.SETU_AA_NOTIFICATION_SECRET;
    const rawBody = JSON.stringify(req.body);

    if (!setuAA.verifyWebhookSignature(rawBody, signature, secret)) {
      console.warn("[Setu AA webhook] Invalid signature; rejecting");
      return res
        .status(401)
        .json({ success: false, message: "Invalid webhook signature" });
    }

    const { type, payload } = req.body || {};
    console.log(`[Setu AA webhook] Received: ${type}`);

    if (type === "CONSENT_STATUS_UPDATE") {
      const { consentStatus, consentId } = payload || {};
      await Acc_SetuConsent.findOneAndUpdate(
        { consentId },
        {
          status:
            consentStatus === "ACTIVE"
              ? "active"
              : String(consentStatus || "").toLowerCase(),
          lastSyncAt: new Date(),
        },
      );
    } else if (type === "FI_DATA_READY") {
      const { sessionId, consentId } = payload || {};
      await Acc_SetuConsent.findOneAndUpdate(
        { consentId },
        { lastReadyAt: new Date(), pendingSessionId: sessionId },
      );
    }

    res.json({ success: true, ack: true });
  } catch (e) {
    console.error("[Setu AA webhook] Error:", e);
    res.json({ success: false, message: "Internal error processing webhook" });
  }
});

// ─── PROTECTED ROUTES ──────────────────────────────────────────────────────
router.use(AccountantAuthMiddleware.accountantAuth);

router.get("/status", async (req, res) => {
  try {
    const configured = setuAA.isConfigured();
    const consents = await Acc_SetuConsent.find().lean();
    res.json({
      success: true,
      configured,
      hasCredentials: configured,
      sandboxMode:
        (process.env.SETU_AA_BASE_URL || "").includes("sandbox") ||
        (process.env.SETU_AA_BASE_URL || "").includes("uat"),
      connectors: consents.map((c) => ({
        bankAccount: c.bankAccount,
        consentId: c.consentId,
        consentUrl: c.consentUrl,
        status: c.status,
        lastSyncAt: c.lastSyncAt,
        lastReadyAt: c.lastReadyAt,
      })),
    });
  } catch (e) {
    console.error("[Setu AA] /status error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post("/init-consent", async (req, res) => {
  try {
    if (!setuAA.isConfigured()) {
      return res.status(400).json({
        success: false,
        code: "SETU_NOT_CONFIGURED",
        message:
          "Setu AA credentials are not in your backend .env. See bridge.setu.co.",
      });
    }

    const { bankAccount, customerMobile, fiFromMonths = 12 } = req.body;
    if (!bankAccount)
      return res
        .status(400)
        .json({ success: false, message: "bankAccount is required" });
    if (!customerMobile)
      return res.status(400).json({
        success: false,
        message: "customerMobile is required (10-digit account holder mobile)",
      });

    const fiTo = new Date();
    const fiFrom = new Date();
    fiFrom.setMonth(fiFrom.getMonth() - Number(fiFromMonths));

    const consent = await setuAA.createConsent({
      customerMobile,
      fiFrom,
      fiTo,
      fiTypes: ["DEPOSIT"],
    });

    // Tolerate multiple Setu response shapes
    const consentId =
      consent?.id ||
      consent?.consentId ||
      consent?.data?.id ||
      consent?.Consent?.id;
    const consentUrl =
      consent?.url ||
      consent?.consentUrl ||
      consent?.data?.url ||
      consent?.Consent?.url;
    const consentStatus =
      consent?.status || consent?.consentStatus || "PENDING";

    if (!consentId || !consentUrl) {
      console.error(
        "[Setu AA] init-consent unexpected shape:",
        JSON.stringify(consent).slice(0, 500),
      );
      return res.status(502).json({
        success: false,
        message:
          "Setu created the consent but returned an unexpected response shape. Check backend logs.",
        rawResponse: consent,
      });
    }

    // Upsert into Acc_SetuConsent collection — one doc per bank account
    const saved = await Acc_SetuConsent.findOneAndUpdate(
      { bankAccount },
      {
        bankAccount,
        consentId,
        consentUrl,
        customerMobile,
        status: "consent_pending",
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    console.log(
      `[Setu AA] Consent saved: bankAccount=${bankAccount} consentId=${consentId} _id=${saved._id}`,
    );

    res.json({
      success: true,
      consentId,
      consentUrl,
      status: consentStatus,
    });
  } catch (e) {
    console.error("[Setu AA] init-consent error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

router.get("/consent/:id", async (req, res) => {
  try {
    if (!setuAA.isConfigured()) {
      return res
        .status(400)
        .json({ success: false, code: "SETU_NOT_CONFIGURED" });
    }
    const data = await setuAA.getConsentStatus(req.params.id);
    res.json({ success: true, consent: data });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post("/revoke/:id", async (req, res) => {
  try {
    if (!setuAA.isConfigured()) {
      return res
        .status(400)
        .json({ success: false, code: "SETU_NOT_CONFIGURED" });
    }
    await setuAA.revokeConsent(req.params.id);
    await Acc_SetuConsent.findOneAndUpdate(
      { consentId: req.params.id },
      { status: "revoked" },
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post("/sync/:bankAccount", async (req, res) => {
  try {
    if (!setuAA.isConfigured()) {
      return res
        .status(400)
        .json({ success: false, code: "SETU_NOT_CONFIGURED" });
    }
    const { bankAccount } = req.params;
    const { fiFromMonths = 1, consentId: bodyConsentId } = req.body;

    // Prefer lookup by bankAccount; fall back to consentId from request body
    let consent = await Acc_SetuConsent.findOne({ bankAccount });
    if (!consent && bodyConsentId) {
      consent = await Acc_SetuConsent.findOne({ consentId: bodyConsentId });
    }

    if (!consent || !consent.consentId) {
      const all = await Acc_SetuConsent.find().lean();
      console.warn(
        `[Setu AA] Sync requested for bankAccount="${bankAccount}" but no consent record found.`,
      );
      console.warn(
        `[Setu AA] Existing consents:`,
        JSON.stringify(
          all.map((c) => ({
            bankAccount: c.bankAccount,
            consentId: c.consentId,
            status: c.status,
          })),
          null,
          2,
        ),
      );
      return res.status(404).json({
        success: false,
        message:
          "No Setu AA consent found for this bank account. Initiate consent first.",
        debug: {
          requestedBankAccount: bankAccount,
          requestedConsentId: bodyConsentId,
          existingCount: all.length,
        },
      });
    }

    console.log(
      `[Setu AA] Sync starting: bankAccount=${bankAccount} consentId=${consent.consentId}`,
    );

    // Poll consent — must be ACTIVE before fetching
    const status = await setuAA.getConsentStatus(consent.consentId);
    const statusValue =
      status?.status || status?.consentStatus || status?.data?.status;
    if (statusValue !== "ACTIVE") {
      return res.status(400).json({
        success: false,
        message: `Consent is not yet active (current status: ${statusValue || "unknown"}). User must approve via the Setu screen first.`,
        consentUrl: consent.consentUrl,
        rawStatus: status,
      });
    }

    // Use the dataRange Setu approved on the consent itself, not a fresh
    // window. Setu rejects /v2/sessions if our range falls outside the
    // consent's FIDataRange. The consent response carries either
    // `detail.FIDataRange` or `detail.dataRange` depending on Setu version;
    // fall back to a 1-month window aligned with consentStart if neither
    // is present.
    const detail = status?.detail || status?.Detail || {};
    let fiFrom, fiTo;
    const range = detail.FIDataRange || detail.fiDataRange || detail.dataRange;
    if (range?.from && range?.to) {
      fiFrom = new Date(range.from);
      fiTo = new Date(range.to);
    } else {
      // Last-resort fallback — one month ending at consentStart
      const consentStart = detail.consentStart
        ? new Date(detail.consentStart)
        : new Date();
      fiTo = consentStart;
      fiFrom = new Date(consentStart);
      fiFrom.setMonth(fiFrom.getMonth() - 1);
    }
    console.log(
      `[Setu AA] Session dataRange: ${fiFrom.toISOString()} → ${fiTo.toISOString()}`,
    );

    // Create or reuse data session
    let session;
    if (consent.pendingSessionId) {
      session = { id: consent.pendingSessionId };
    } else {
      session = await setuAA.createDataSession(consent.consentId, fiFrom, fiTo);
    }
    const sessionId = session?.id || session?.sessionId || session?.data?.id;

    if (!sessionId) {
      console.error(
        "[Setu AA] sync: no session id returned:",
        JSON.stringify(session).slice(0, 500),
      );
      return res.status(502).json({
        success: false,
        message: "Setu returned an unexpected data-session response",
        rawResponse: session,
      });
    }

    // Poll the session until at least one account is READY. The session
    // response itself contains all the FI data — we don't need a separate
    // /fi endpoint call. (Setu's session response has accounts[].FIstatus
    // per account, with data populated when READY.)
    let attempts = 0;
    let sessionData = null;
    while (attempts < 8) {
      sessionData = await setuAA.getDataSession(sessionId);
      const fips = sessionData?.fips || [];
      const allAccounts = fips.flatMap((f) => f.accounts || []);
      const readyCount = allAccounts.filter(
        (a) => a.FIstatus === "READY" || a.FIstatus === "DELIVERED",
      ).length;
      const failCount = allAccounts.filter(
        (a) => a.FIstatus === "FAILED",
      ).length;
      const pendCount = allAccounts.filter(
        (a) => a.FIstatus === "PENDING" || !a.FIstatus,
      ).length;
      console.log(
        `[Setu AA] Session poll #${attempts + 1}: READY=${readyCount} PENDING=${pendCount} FAILED=${failCount} of ${allAccounts.length}`,
      );

      if (readyCount > 0 && pendCount === 0) break; // all done
      if (readyCount > 0 && attempts >= 4) break; // partial OK after 4 polls
      if (allAccounts.length > 0 && pendCount === 0) break; // no more pending — done

      await new Promise((r) => setTimeout(r, 2000));
      attempts++;
    }

    console.log(
      `[Setu AA] Session response root keys: ${Object.keys(sessionData || {}).join(",")}`,
    );
    const transactions = setuAA.normalizeSetuFIData(sessionData, bankAccount);
    console.log(
      `[Setu AA] Normalized ${transactions.length} transactions from Setu response`,
    );

    // Idempotent insert via SHA-256 externalId — same hash as bankTransactions.js
    const hash = (t) =>
      crypto
        .createHash("sha256")
        .update(
          `${t.bankAccount}|${new Date(t.transactionDate).toISOString().slice(0, 10)}|${Number(t.amount).toFixed(2)}|${(t.referenceNumber || t.description || "").slice(0, 60)}`,
        )
        .digest("hex")
        .slice(0, 24);

    const prepared = transactions.map((t) => ({
      ...t,
      externalId: hash(t),
      createdBy: req.user.id,
    }));
    const existingIds = new Set(
      (
        await Acc_BankTransaction.find({
          externalId: { $in: prepared.map((t) => t.externalId) },
        })
          .select("externalId")
          .lean()
      ).map((d) => d.externalId),
    );
    const fresh = prepared.filter((t) => !existingIds.has(t.externalId));

    let inserted = 0;
    if (fresh.length > 0) {
      try {
        const result = await Acc_BankTransaction.insertMany(fresh, {
          ordered: false,
        });
        inserted = result.length;
      } catch (e) {
        inserted = e.insertedDocs?.length || 0;
      }
    }

    // Update consent status
    consent.status = "active";
    consent.lastSyncAt = new Date();
    consent.pendingSessionId = undefined;
    await consent.save();

    res.json({
      success: true,
      inserted,
      skipped: prepared.length - inserted,
      total: prepared.length,
    });
  } catch (e) {
    console.error("[Setu AA] sync error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
