#!/usr/bin/env node
// scripts/cowork/bootstrap-ceo.js
//
// ONE-TIME COWORK CEO BOOTSTRAP — a local command, never an HTTP route.
//
// SEC-0 (25 Sep 2026) removed `POST /cowork/setup/seed-ceo`, which let any
// anonymous caller create a Firebase account, give it the `ceo` custom claim
// and overwrite the E000 CEO record. This script is the only remaining way to
// make somebody the CoWork CEO outside the CEO's own in-app controls, and it
// is deliberately narrow:
//
//   · It is not mounted by Express. It runs only from a shell that already
//     holds FIREBASE_SERVICE_ACCOUNT.
//   · It never creates an account and never sees a password. The person must
//     already have a Firebase login (they set their own password through the
//     normal reset flow); this only promotes that existing account.
//   · It ALWAYS refuses while any CEO already exists — by the E000 record or
//     by any cowork_employees row with role "ceo". There is no override flag
//     and no override environment variable (SEC-1 removed the recovery mode:
//     it promoted a new account without demoting the old CEO's Firebase claim
//     or revoking the old CEO's sessions, leaving two working CEOs).
//
//     REPLACING A CEO IS NOT AUTOMATED HERE. It needs a separately reviewed,
//     audited recovery procedure that first identifies the current CEO
//     account(s), removes their `ceo` custom claim, revokes their refresh
//     tokens and records that, and only then promotes the replacement.
//   · It writes an audit record (cowork_security_audit) and prints a result
//     line containing no password, token or full email address.
//
// Usage:
//   COWORK_BOOTSTRAP_CEO_EMAIL=ceo@example.com \
//   COWORK_BOOTSTRAP_CEO_NAME="Full Name" \
//   COWORK_BOOTSTRAP_CONFIRM=ceo@example.com \
//   node -r dotenv/config scripts/cowork/bootstrap-ceo.js

"use strict";

const CEO_DOC = "E000";

const maskEmail = (email) => {
  const [user, domain] = String(email || "").split("@");
  if (!user || !domain) return "(invalid)";
  return `${user.slice(0, 1)}***@${domain}`;
};

/**
 * Decide what to do, with no side effects. Exported for tests.
 *
 * @param {object} input
 * @param {object} input.env        process.env-like (no variable can override a refusal)
 * @param {string[]} input.argv     command-line arguments (ignored for authority)
 * @param {boolean} input.ceoExists a CEO record or claim already exists
 * @param {boolean} input.accountExists the target Firebase account exists
 * @returns {{ ok: boolean, action?: string, reason?: string }}
 */
function planBootstrap({ env = {}, argv = [], ceoExists, accountExists }) {
  const email = String(env.COWORK_BOOTSTRAP_CEO_EMAIL || "").trim().toLowerCase();
  const name = String(env.COWORK_BOOTSTRAP_CEO_NAME || "").trim();
  const confirm = String(env.COWORK_BOOTSTRAP_CONFIRM || "").trim().toLowerCase();

  if (!email || !email.includes("@")) return { ok: false, reason: "COWORK_BOOTSTRAP_CEO_EMAIL is required" };
  if (!name) return { ok: false, reason: "COWORK_BOOTSTRAP_CEO_NAME is required" };
  if (confirm !== email) {
    return { ok: false, reason: "COWORK_BOOTSTRAP_CONFIRM must repeat COWORK_BOOTSTRAP_CEO_EMAIL exactly" };
  }

  // No flag or variable changes this. See the header: CEO replacement is a
  // separately reviewed procedure, not something this script does.
  if (ceoExists !== false) {
    return {
      ok: false,
      reason: "A CoWork CEO already exists (or could not be ruled out). This script never replaces a CEO; use the separately reviewed recovery procedure.",
    };
  }
  if (!accountExists) {
    return {
      ok: false,
      reason: "No Firebase account exists for that email. Create it through the normal sign-up / password-reset flow first; this script never creates accounts or handles passwords.",
    };
  }
  return { ok: true, action: "bootstrap-ceo" };
}

/** Does any CEO already exist, by Firestore record or by E000? */
async function ceoAlreadyExists(db) {
  const e000 = await db.collection("cowork_employees").doc(CEO_DOC).get();
  if (e000.exists && e000.data()?.authUid) return true;
  const any = await db.collection("cowork_employees").where("role", "==", "ceo").limit(1).get();
  return !any.empty;
}

/**
 * Execute the bootstrap with injected Firebase handles. Exported for tests.
 * Returns the safe result object that is printed.
 */
async function runBootstrap({ env, argv, auth, db, serverTimestamp, now = () => new Date() }) {
  const email = String(env.COWORK_BOOTSTRAP_CEO_EMAIL || "").trim().toLowerCase();

  let account = null;
  if (email) {
    try {
      account = await auth.getUserByEmail(email);
    } catch (err) {
      if (err?.code !== "auth/user-not-found") throw err;
    }
  }
  const ceoExists = await ceoAlreadyExists(db);
  const plan = planBootstrap({ env, argv, ceoExists, accountExists: Boolean(account) });

  const result = {
    ok: plan.ok,
    action: plan.action || "refused",
    reason: plan.reason || null,
    target: email ? maskEmail(email) : null,
    at: now().toISOString(),
  };

  if (plan.ok) {
    await auth.setCustomUserClaims(account.uid, { role: "ceo" });
    await db.collection("cowork_employees").doc(CEO_DOC).set({
      employeeId: CEO_DOC,
      authUid: account.uid,
      name: String(env.COWORK_BOOTSTRAP_CEO_NAME).trim(),
      email,
      role: "ceo",
      department: "Management",
      updatedAt: serverTimestamp(),
    }, { merge: true });
    // The promoted account's existing sessions restart so they pick up the new
    // claim. (No other account is touched: there was no CEO to replace.)
    await auth.revokeRefreshTokens(account.uid);
  }

  // Audit every attempt, refused ones included. No password or token exists
  // anywhere in this script to record.
  await db.collection("cowork_security_audit").add({
    kind: "cowork-ceo-bootstrap",
    ...result,
    targetUid: plan.ok ? account.uid : null,
    ranBy: String(env.USER || env.USERNAME || "unknown"),
    recordedAt: serverTimestamp(),
  });

  return result;
}

module.exports = { planBootstrap, runBootstrap, maskEmail };

if (require.main === module) {
  (async () => {
    const { auth, db, admin } = require("../../config/firebaseAdmin");
    const result = await runBootstrap({
      env: process.env,
      argv: process.argv.slice(2),
      auth,
      db,
      serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(JSON.stringify(result));
    process.exit(result.ok ? 0 : 1);
  })().catch((err) => {
    console.error(JSON.stringify({ ok: false, action: "error", reason: err?.message || String(err) }));
    process.exit(2);
  });
}
