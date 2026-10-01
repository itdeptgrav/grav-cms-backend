#!/usr/bin/env node
//
// scripts/marketing/mautic-provision-dev.js
//
// PROVISION THE DEVELOPMENT MAUTIC, REPEATABLY.
//
//   node scripts/marketing/mautic-provision-dev.js
//
// ── WHY THIS IS A SCRIPT AND NOT A LIST OF CLICKS ──────────────────────────
// `deploy/mautic/README.md` originally described these as steps to perform in
// Mautic's own UI, because that is how Mautic documents them. They are all
// reachable through the supported API, and a script beats a checklist for the
// same reason the compose file beats "install PHP": a development instance that
// has to be rebuilt gets rebuilt identically, and what was configured is
// readable instead of remembered.
//
// It provisions, in order:
//   1. the least-privilege GRAV integration ROLE   (contacts + segments + API)
//   2. the integration USER holding it
//   3. the `grav_person_key` custom contact FIELD
//   3b. the `grav_acquisition_hold` custom contact FIELD (the Sales-owned
//       exclusion flag written when Sales accepts a Prospect)
//   4. one test SEGMENT
//   5. one WEBHOOK pointed at GRAV, with its shared secret
//   6. one harmless test EMAIL
//   7. one CAMPAIGN that sends it to the test segment
//   8. and it ends by telling you to run the ACQUISITION REGISTRATION step,
//      which is the only thing entitled to call an acquisition scope ready
//
// ── IDEMPOTENT ─────────────────────────────────────────────────────────────
// Every step looks first and reports `exists` rather than failing or creating a
// second copy. Re-running it is how you check that an instance is still
// correctly configured.
//
// ── IT AUTHENTICATES AS THE ADMIN, ONCE, AND THEN NEVER AGAIN ──────────────
// Creating a role needs permissions the integration user must not have. So the
// admin credential is used here, at provisioning time only. GRAV itself
// authenticates as the least-privilege user this script creates, and §4 of the
// README is the contract for that.
"use strict";

const fs = require("fs");
const { ACQUISITION_HOLD_FIELD } = require("../../constants/marketing");
const path = require("path");

/* ── READING deploy/mautic/.env ─────────────────────────────────────────────
   With a compose-style parser, deliberately NOT by sourcing it in a shell.
   A value containing * ? [ ] ( ) { } or ! is glob-expanded by POSIX `source`,
   and an unterminated bracket pattern swallows the rest of the file into the
   variable — which is exactly how this stack was first installed with a
   205-character multi-line admin password that could not be reproduced. */
function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    out[t.slice(0, i).trim()] = t.slice(i + 1);
  }
  return out;
}

const ENV_FILE = path.join(__dirname, "..", "..", "deploy", "mautic", ".env");
const env = { ...readEnvFile(ENV_FILE), ...process.env };

const BASE = (env.MAUTIC_BASE_URL || "http://localhost:8088").replace(/\/+$/, "");
const ADMIN = `${env.MAUTIC_ADMIN_USERNAME}:${env.MAUTIC_ADMIN_PASSWORD}`;
const SEGMENT_ALIAS = env.MAUTIC_TEST_SEGMENT || "grav-integration-test";
/* Where Mautic must POST to reach GRAV. `localhost` is refused outright by
   Mautic's PrivateAddressChecker (it special-cases the literal string), so the
   container's host alias is used and allowlisted instead. */
const GRAV_WEBHOOK_URL = env.GRAV_WEBHOOK_URL
  || "http://host.docker.internal:5055/api/cms/marketing/events";
const WEBHOOK_SECRET = env.MAUTIC_WEBHOOK_SECRET;

const results = [];
const say = (step, state, detail = "") => {
  results.push({ step, state, detail });
  console.log(`  [${state.padEnd(7)}] ${step}${detail ? ` — ${detail}` : ""}`);
};

async function api(method, route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(ADMIN).toString("base64")}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 300) }; }
  return { status: res.status, data };
}

/** Mautic returns collections as an object keyed by id, never an array. */
const rows = (collection) => Object.values(collection || {});

function assertOk({ status, data }, what) {
  if (status !== 200 && status !== 201) {
    throw new Error(`${what} failed (${status}): ${JSON.stringify(data).slice(0, 400)}`);
  }
  return data;
}

async function main() {
  console.log(`\nProvisioning development Mautic at ${BASE}\n`);

  if (!env.MAUTIC_ADMIN_USERNAME || !env.MAUTIC_ADMIN_PASSWORD) {
    throw new Error(`No admin credentials. Expected them in ${ENV_FILE}.`);
  }
  if (!WEBHOOK_SECRET) {
    /* Refused rather than defaulted. A webhook provisioned without a secret is
       an unsigned webhook, and GRAV rejects every unsigned delivery — so the
       failure would surface later, as 401s nobody can explain. */
    throw new Error("MAUTIC_WEBHOOK_SECRET is not set. GRAV rejects unsigned webhooks, so provisioning one without a secret would be pointless.");
  }

  assertOk(await api("GET", "/api/users?limit=1"), "admin authentication");
  say("admin authentication", "OK");

  /* ── 1. ROLE ──────────────────────────────────────────────────────────── */
  const wantedPermissions = {
    "lead:leads": ["viewown", "viewother", "editown", "editother", "create"],
    "lead:lists": ["viewown", "viewother", "editown", "editother"],
    /* ── WHY CAMPAIGNS ARE HERE, AND WHY ONLY VIEW AND EDIT ────────────────
       Chunk 3B stops acquisition for ONE person by removing their campaign
       membership, and it proves the stop by reading their memberships back.

       Without this permission Mautic does something worse than refusing: the
       per-contact read `GET /api/contacts/{id}/campaigns` answers 200 with an
       EMPTY LIST, while the removal still succeeds. Verified on the live
       7.2.0 instance. GRAV therefore saw no memberships, removed nothing, read
       back nothing remaining, and would have reported a confirmed stop for a
       person still in a running campaign.

       No `create` and no `publish`: GRAV never authors or activates a campaign,
       and must never be able to stop one for everybody. */
    "campaign:campaigns": ["viewown", "viewother", "editown", "editother"],

    /* ── NO CONTENT PERMISSIONS ON THIS ROLE ───────────────────────────────
       They were granted here once and revoked. Mautic 7.2.0 authorises
       `POST /api/emails/{id}/send` with the same `view` grant that authorises
       `GET /api/emails`, and a form's submissions the same way, so granting
       content view to the identity that already writes contacts would have made
       one stolen credential able to read the contact estate AND mail it.

       The content read lives on its own credential (below), behind the gateway
       policy that supplies the rule Mautic cannot express. */

    "api:access": ["full"],
  };
  const roleName = "GRAV Integration";
  let role = rows(assertOk(await api("GET", "/api/roles?limit=200"), "role list").roles)
    .find((r) => r.name === roleName);
  if (role) {
    /* ── RECONCILED, NOT MERELY REPORTED ────────────────────────────────────
       This branch used to say "exists" and move on, which meant an instance
       provisioned before a permission was added kept the old grant for ever and
       the script's "OK" was about the role's NAME rather than its powers. */
    const have = role.rawPermissions || {};
    const missing = Object.entries(wantedPermissions)
      .filter(([k, v]) => !Array.isArray(have[k]) || v.some((x) => !have[k].includes(x)))
      .map(([k]) => k);
    if (missing.length) {
      role = assertOk(await api("PATCH", `/api/roles/${role.id}/edit`, {
        rawPermissions: wantedPermissions,
      }), "role permission update").role;
      say("role", "updated", `id ${role.id}, granted ${missing.join(", ")}`);
    } else {
      say("role", "exists", `id ${role.id}, permissions already correct`);
    }
  } else {
    role = assertOk(await api("POST", "/api/roles/new", {
      name: roleName,
      description: "Least-privilege identity for the GRAV Marketing adapter: contacts and segments only, plus API access. No send, no configuration, no users.",
      isAdmin: 0,
      rawPermissions: wantedPermissions,
    }), "role create").role;
    say("role", "created", `id ${role.id}`);
  }

  /* ── 2. USER ──────────────────────────────────────────────────────────── */
  const username = env.MAUTIC_GRAV_USERNAME || "grav-integration";
  const password = env.MAUTIC_GRAV_PASSWORD;
  if (!password) throw new Error("MAUTIC_GRAV_PASSWORD is not set.");

  let user = rows(assertOk(await api("GET", "/api/users?limit=200"), "user list").users)
    .find((u) => u.username === username);
  if (user) {
    /* The password is reset on every run, so the .env value is always the live
       one. A provisioning script that leaves a stale credential behind is a
       script whose output cannot be trusted. */
    assertOk(await api("PATCH", `/api/users/${user.id}/edit`, {
      plainPassword: { password, confirm: password }, role: role.id,
    }), "user password reset");
    say("integration user", "exists", `id ${user.id}, password reset to the .env value`);
  } else {
    user = assertOk(await api("POST", "/api/users/new", {
      username,
      firstName: "GRAV",
      lastName: "Integration",
      email: `${username}@grav-integration-test.invalid`,
      plainPassword: { password, confirm: password },
      role: role.id,
      isPublished: true,
    }), "user create").user;
    say("integration user", "created", `id ${user.id}`);
  }

  /* ── 2b. THE CONTENT READER: A SECOND, SEPARATE IDENTITY ─────────────────
     Its own role and its own user, deliberately not the operational one.

     Mautic 7.2.0 cannot express "may list emails, may not send them": its API
     authorises `POST /api/emails/{id}/send` through the same `view` grant, and a
     form's submissions — real contact identities — the same way. So this
     credential IS capable of sending mail as far as Mautic is concerned, and the
     containment is the gateway in front of it: no route through the gateway
     lets this credential POST anything.

     Separating it from the operational identity is what makes that containment
     worth having. One credential that both wrote contacts and read content would
     have needed both policies, and a policy that is the union of two policies is
     not a restriction. */
  const contentRoleName = "GRAV Content Reader";
  const contentPermissions = {
    /* View only. No create, edit, delete or publish on any of the three. */
    "email:emails": ["viewown", "viewother"],
    "form:forms": ["viewown", "viewother"],
    "page:pages": ["viewown", "viewother"],
    "api:access": ["full"],
  };
  let contentRole = rows(assertOk(await api("GET", "/api/roles?limit=200"), "role list").roles)
    .find((r) => r.name === contentRoleName);
  if (contentRole) {
    const have = contentRole.rawPermissions || {};
    const missing = Object.entries(contentPermissions)
      .filter(([k, v]) => !Array.isArray(have[k]) || v.some((x) => !have[k].includes(x)))
      .map(([k]) => k);
    if (missing.length) {
      contentRole = assertOk(await api("PATCH", `/api/roles/${contentRole.id}/edit`, {
        rawPermissions: contentPermissions,
      }), "content role permission update").role;
      say("content role", "updated", `id ${contentRole.id}, granted ${missing.join(", ")}`);
    } else {
      say("content role", "exists", `id ${contentRole.id}, permissions already correct`);
    }
  } else {
    contentRole = assertOk(await api("POST", "/api/roles/new", {
      name: contentRoleName,
      description: "Read-only content inventory for GRAV Marketing: list emails, forms and landing pages. Contained by the GRAV gateway, which refuses every non-GET and every path outside those three collections for this credential.",
      isAdmin: 0,
      rawPermissions: contentPermissions,
    }), "content role create").role;
    say("content role", "created", `id ${contentRole.id}`);
  }

  const contentUsername = env.MAUTIC_CONTENT_USERNAME || "grav-content-reader";
  const contentPassword = env.MAUTIC_CONTENT_PASSWORD;
  if (!contentPassword) {
    throw new Error("MAUTIC_CONTENT_PASSWORD is not set. The content inventory uses its own credential, separate from the operational one.");
  }
  let contentUser = rows(assertOk(await api("GET", "/api/users?limit=200"), "user list").users)
    .find((u) => u.username === contentUsername);
  if (contentUser) {
    assertOk(await api("PATCH", `/api/users/${contentUser.id}/edit`, {
      plainPassword: { password: contentPassword, confirm: contentPassword }, role: contentRole.id,
    }), "content user password reset");
    say("content user", "exists", `id ${contentUser.id}, password reset to the .env value`);
  } else {
    contentUser = assertOk(await api("POST", "/api/users/new", {
      username: contentUsername,
      firstName: "GRAV",
      lastName: "Content Reader",
      email: `${contentUsername}@grav-integration-test.invalid`,
      plainPassword: { password: contentPassword, confirm: contentPassword },
      role: contentRole.id,
      isPublished: true,
    }), "content user create").user;
    say("content user", "created", `id ${contentUser.id}`);
  }

  /* ── 3. THE grav_person_key CUSTOM FIELD ──────────────────────────────────
     GRAV's opaque person key, carried onto the Mautic contact so the identity
     mapping can be rebuilt from Mautic's side after a restore. Without the
     field, Mautic silently DROPS the key from a contact write and the mapping
     exists only in MongoDB. */
  const fieldAlias = "grav_person_key";
  let field = rows(assertOk(await api("GET", "/api/fields/contact?limit=500"), "field list").fields)
    .find((f) => f.alias === fieldAlias);
  if (field) {
    say("grav_person_key field", "exists", `id ${field.id}`);
  } else {
    field = assertOk(await api("POST", "/api/fields/contact/new", {
      label: "GRAV person key",
      alias: fieldAlias,
      type: "text",
      object: "lead",
      isPublished: true,
      isUniqueIdentifer: false,
    }), "field create").field;
    say("grav_person_key field", "created", `id ${field.id}`);
  }

  /* ── 3b. THE grav_acquisition_hold CUSTOM FIELD ───────────────────────────
     The Sales-owned exclusion flag. Set on a contact when Sales accepts the
     Prospect, so that a segment filter can keep them out of acquisition
     automation that does not exist yet — a membership removal only stops the
     campaigns they are in TODAY.

     Boolean rather than a date or a status: it answers exactly one question a
     segment filter can ask. And emphatically NOT Mautic's do-not-contact flag,
     which is an unsubscribe and would record Sales ownership as the person
     having withdrawn permission. */
  const holdAlias = ACQUISITION_HOLD_FIELD;
  let holdField = rows(assertOk(await api("GET", "/api/fields/contact?limit=500"), "field list").fields)
    .find((f) => f.alias === holdAlias);
  if (holdField) {
    say("grav_acquisition_hold field", "exists", `id ${holdField.id}`);
  } else {
    holdField = assertOk(await api("POST", "/api/fields/contact/new", {
      label: "GRAV acquisition hold",
      alias: holdAlias,
      type: "boolean",
      object: "lead",
      isPublished: true,
      properties: { yes: "Yes", no: "No" },
    }), "acquisition hold field create").field;
    say("grav_acquisition_hold field", "created", `id ${holdField.id}`);
  }

  /* ── 4. SEGMENT ───────────────────────────────────────────────────────── */
  let segment = rows(assertOk(await api("GET", "/api/segments?limit=200"), "segment list").lists)
    .find((s) => s.alias === SEGMENT_ALIAS);
  if (segment) {
    say("test segment", "exists", `id ${segment.id}, alias ${segment.alias}`);
  } else {
    segment = assertOk(await api("POST", "/api/segments/new", {
      name: "GRAV integration test",
      alias: SEGMENT_ALIAS,
      description: "Synthetic contacts used by the GRAV Chunk 0 round trip. Never a real audience.",
      isPublished: true,
      isGlobal: true,
    }), "segment create").list;
    say("test segment", "created", `id ${segment.id}`);
  }

  /* ── 5. WEBHOOK ───────────────────────────────────────────────────────── */
  const hookName = "GRAV Marketing intake";
  let hook = rows(assertOk(await api("GET", "/api/hooks?limit=200"), "hook list").hooks)
    .find((h) => h.name === hookName);
  const hookBody = {
    name: hookName,
    description: "Delivers form submissions, page hits and email opens to GRAV's Marketing event ledger.",
    webhookUrl: GRAV_WEBHOOK_URL,
    secret: WEBHOOK_SECRET,
    isPublished: true,
    /* The types services/marketing/mauticWebhookContract.js translates.
       `lead_channel_subscription_changed` is how Mautic 7.2.0 reports BOTH an
       unsubscribe and a bounce — it has no dedicated trigger for either, which
       `GET /api/hooks/triggers` on the live instance confirms — so it is the one
       that carries every withdrawal. Anything else GRAV reports as ignored by
       name rather than dropping. */
    triggers: [
      "mautic.form_on_submit",
      "mautic.page_on_hit",
      "mautic.email_on_open",
      "mautic.email_on_send",
      "mautic.lead_channel_subscription_changed",
    ],
  };
  if (hook) {
    assertOk(await api("PATCH", `/api/hooks/${hook.id}/edit`, hookBody), "hook update");
    say("webhook", "exists", `id ${hook.id} → ${GRAV_WEBHOOK_URL}`);
  } else {
    hook = assertOk(await api("POST", "/api/hooks/new", hookBody), "hook create").hook;
    say("webhook", "created", `id ${hook.id} → ${GRAV_WEBHOOK_URL}`);
  }

  /* ── 6. A HARMLESS TEST EMAIL ──────────────────────────────────────────
     Addressed to nobody; the campaign decides the audience. Its content says
     what it is, so a message found in the sink is never mistaken for real
     marketing. */
  const emailName = "GRAV Chunk 0 probe";
  let email = rows(assertOk(await api("GET", "/api/emails?limit=200"), "email list").emails)
    .find((e) => e.name === emailName);
  const emailBody = {
    name: emailName,
    subject: "GRAV integration probe — not a real campaign",
    fromAddress: "marketing@grav-integration-test.invalid",
    fromName: "GRAV Marketing Dev",
    customHtml: "<p>This message exists only to prove that GRAV's development Mautic delivers into a local mail sink. It is sent to synthetic contacts on a reserved .invalid domain and must never reach a real recipient.</p>",
    emailType: "list",
    isPublished: true,
    lists: [segment.id],
  };
  if (email) {
    say("test email", "exists", `id ${email.id}`);
  } else {
    email = assertOk(await api("POST", "/api/emails/new", emailBody), "email create").email;
    say("test email", "created", `id ${email.id}`);
  }

  console.log("");
  say("summary", "DONE", `role ${role.id}, user ${user.id}, field ${field.id}, segment ${segment.id}, hook ${hook.id}, email ${email.id}`);

  /* ── 8. ACQUISITION REGISTRATION ──────────────────────────────────────────
     Not done here, and deliberately named rather than silently skipped.
     Registration resolves the configured scope, installs and verifies the
     `grav_acquisition_hold != 1` exclusion on every acquisition segment, checks
     the campaigns draw only from registered segments, and reconciles existing
     holds. It needs GRAV's own database for that last step, which this script
     does not touch — so it is a separate supported operation, and editing the
     two environment variables is not a substitute for it. */
  const declaredSegments = (env.MAUTIC_ACQUISITION_SEGMENTS || "").split(",").filter((x) => x.trim());
  const declaredCampaigns = (env.MAUTIC_ACQUISITION_CAMPAIGNS || "").split(",").filter((x) => x.trim());
  if (declaredSegments.length || declaredCampaigns.length) {
    say("acquisition scope", "declared",
      `${declaredSegments.length} segment(s), ${declaredCampaigns.length} campaign(s) — NOT YET REGISTERED`);
  } else {
    say("acquisition scope", "absent", "no acquisition automation declared yet");
  }
  console.log(`
  ── REGISTER THE ACQUISITION SCOPE ───────────────────────────────────────
  Declaring MAUTIC_ACQUISITION_SEGMENTS / MAUTIC_ACQUISITION_CAMPAIGNS changes
  nothing in Mautic. Until the registration operation has run, the scope is
  configured and UNENFORCED, and Marketing's health check reports it as not
  ready. Run:

    node -r dotenv/config scripts/marketing/mautic-register-acquisition.js

  and read its final line. Only READY means registered. Passing --check
  inspects without changing anything.
`);

  console.log(`
  GRAV's .env needs:
    MAUTIC_BASE_URL=${BASE}
    MAUTIC_AUTH_MODE=basic
    MAUTIC_BASIC_USERNAME=${username}
    MAUTIC_BASIC_PASSWORD=<MAUTIC_GRAV_PASSWORD from deploy/mautic/.env>
    MAUTIC_WEBHOOK_SECRET=<the same secret this hook was given>
    MAUTIC_TEST_SEGMENT=${SEGMENT_ALIAS}
`);
  return { role, user, field, segment, hook, email };
}

main().catch((err) => {
  console.error("\n  ABORTED:", err?.message || err);
  process.exit(1);
});
