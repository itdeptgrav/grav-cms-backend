// scripts/checkGstPortal.js
//
// Is the GST portal lookup wired up, and does it actually answer?
//
//   node scripts/checkGstPortal.js                    → config only, no call
//   node scripts/checkGstPortal.js 21AAMCG0739M1ZH    → one real lookup
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// The alternative is debugging a paid third-party integration through a modal
// in the accountant app, where "nothing happened" could be a missing key, a
// wrong provider name, a rejected token, a network block, or a UI bug — five
// causes and one symptom. This separates them: it prints what the server
// thinks is configured, then makes exactly one call and shows what came back.
//
// WITHOUT A GSTIN ARGUMENT IT MAKES NO CALL. That is deliberate: every lookup
// is billed, and a script that quietly spent money because somebody ran it to
// see what it did would be a bad script.
require("dotenv").config();

const gstPortal = require("../services/gstPortal.service");
const { validateGstin } = require("../services/taxIdentity.service");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const OFF = "\x1b[0m";

function show(label, value, good) {
  const mark = good === undefined ? " " : good ? `${GREEN}✓${OFF}` : `${RED}✗${OFF}`;
  console.log(`  ${mark} ${label.padEnd(24)} ${value}`);
}

async function main() {
  const gstin = (process.argv[2] || "").trim().toUpperCase();

  console.log("\nGST portal lookup — configuration\n");

  const provider = gstPortal.providerName();
  const key = process.env.GST_PORTAL_API_KEY || process.env.GSTIN_LOOKUP_API_KEY || "";
  const configured = gstPortal.isConfigured();

  show("Provider", provider || `${DIM}(none set)${OFF}`, !!provider);
  /* Never print the key. Printing a live credential into a terminal puts it
     in scrollback, in screen shares and in support tickets. */
  show(
    "API key",
    key ? `${DIM}set, ${key.length} characters${OFF}` : `${DIM}(none set)${OFF}`,
    !!key,
  );
  if (provider === "masters-india") {
    show(
      "Client id",
      process.env.GST_PORTAL_CLIENT_ID
        ? `${DIM}set${OFF}`
        : `${RED}missing — Masters India needs GST_PORTAL_CLIENT_ID${OFF}`,
      !!process.env.GST_PORTAL_CLIENT_ID,
    );
  }
  show("Timeout", `${process.env.GST_PORTAL_TIMEOUT_MS || 8000} ms`);
  show(
    "Cache",
    `${Math.round(Number(process.env.GST_PORTAL_CACHE_MS || 86400000) / 3600000)} hours`,
  );

  console.log("");
  if (!configured) {
    console.log(`${RED}Not configured.${OFF}`);
    console.log(`${DIM}${gstPortal.configHint()}${OFF}\n`);
    process.exit(1);
  }
  console.log(`${GREEN}Configured.${OFF}`);

  if (!gstin) {
    console.log(
      `${DIM}\nPass a GSTIN to make one real lookup, e.g.\n  node scripts/checkGstPortal.js 21AAMCG0739M1ZH\nThat call is billed by your provider.${OFF}\n`,
    );
    return;
  }

  /* Refuse to spend a call on a number that cannot exist. The check digit
     already knows. */
  const offline = validateGstin(gstin);
  if (offline.status !== "ok") {
    console.log(`\n${RED}${gstin} fails the offline check:${OFF} ${offline.message}`);
    console.log(`${DIM}Not looking it up — a malformed GSTIN cannot be in the register.${OFF}\n`);
    process.exit(1);
  }

  console.log(`\nLooking up ${gstin} ${DIM}(one billed call)${OFF}…\n`);
  const started = Date.now();
  const r = await gstPortal.lookupGstin(gstin, { force: true });
  const ms = Date.now() - started;

  if (!r.ok && r.reason === "mismatched-response") {
    console.log(`${RED}The provider answered about a DIFFERENT GSTIN.${OFF}\n`);
    show("Asked about", r.asked, false);
    show("Answered about", r.answered, false);
    if (r.sandbox) {
      console.log(
        `\n${RED}This is sandbox data.${OFF} Free/trial credits on this provider return a` +
          `\nfixed demo record for every GSTIN. Buy paid credits before relying on it.`,
      );
    }
    if (r.providerMessage) console.log(`\n${DIM}Provider says: ${r.providerMessage}${OFF}`);
    console.log(
      `\n${DIM}The app treats this as "not checked" rather than as a result, so no` +
        `\ncompany can be verified against somebody else's registration.${OFF}\n`,
    );
    process.exit(1);
  }

  if (!r.ok) {
    console.log(`${RED}The lookup did not complete.${OFF}`);
    show("Reason", r.reason, false);
    if (r.status) show("HTTP status", r.status);
    if (r.message) show("Message", r.message);
    console.log(
      `${DIM}\n  auth          → the provider rejected the key\n` +
        `  rate-limited  → too many calls; wait and retry\n` +
        `  timeout       → provider slow, or the network blocks it\n` +
        `  network       → cannot reach the provider at all${OFF}\n`,
    );
    process.exit(1);
  }

  if (!r.found) {
    console.log(`${RED}The register has no registration with this GSTIN.${OFF}`);
    console.log(`${DIM}The number is well-formed, so this is not a typo.${OFF}\n`);
    return;
  }

  const d = r.data;
  console.log(`${GREEN}The register answered in ${ms} ms.${OFF}\n`);
  show("Legal name", d.legalName || `${DIM}—${OFF}`);
  show("Trade name", d.tradeName || `${DIM}—${OFF}`);
  show("Status", d.status || `${DIM}—${OFF}`, !/CANCELL?ED|SUSPEND/i.test(d.status || ""));
  show("Registered", d.registrationDate || `${DIM}—${OFF}`);
  show("Type", d.taxpayerType || `${DIM}—${OFF}`);
  show("State code", d.stateCode || `${DIM}—${OFF}`);
  show("Address", d.address || `${DIM}—${OFF}`);

  /* If every field came back empty the provider answered with a shape this
     service does not recognise — worth saying, because the form would show a
     blank card and look broken. */
  if (!d.legalName && !d.tradeName && !d.status) {
    console.log(
      `\n${RED}The provider answered, but none of the expected fields were found.${OFF}`,
    );
    console.log(
      `${DIM}Add their field names to FIELD_ALIASES in services/gstPortal.service.js.${OFF}`,
    );
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
