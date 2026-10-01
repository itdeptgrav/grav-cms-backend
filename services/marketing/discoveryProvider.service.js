// services/marketing/discoveryProvider.service.js
//
// THE PROVIDER-NEUTRAL BOUNDARY EVERY EXTERNAL DISCOVERY LOOKUP PASSES THROUGH.
//
// ── THE ARRANGEMENT THIS EXISTS TO PREVENT ─────────────────────────────────
// Zintlr connected directly to Mautic. It is the obvious integration and it is
// the wrong one, for three separate reasons:
//
//   · it puts purchased personal data into the marketing engine's contact
//     store, where it becomes indistinguishable from data the person gave us,
//     and where nothing records that a provider supplied it;
//   · it makes Mautic the place enrichment happens, so GRAV — which owns
//     consent and identity — never sees the lookup and cannot refuse it; and
//   · it welds one commercial provider into the automation platform, so
//     changing provider means changing Mautic.
//
// So no discovery provider is ever wired to Mautic. A provider is registered
// HERE, GRAV calls it, GRAV records what came back and from whom, and the
// result reaches a handover as attributed provenance. Mautic receives none of
// it.
//
// ── WHAT A PROVIDER MAY AND MAY NOT DO ─────────────────────────────────────
// An adapter answers one question — "what do you know about this
// organisation or work email" — and returns a flat, named result. It may not
// write to any GRAV collection, may not call Mautic, and may not return a
// consent state: permission is a GRAV business record captured from the
// person, never a field bought from a third party.
//
// ── THE DEFAULT IS NOTHING, NOT A GUESS ────────────────────────────────────
// With no provider configured, `enrich` returns an empty result and says so.
// It never invents a company size, an industry or a phone number, and a caller
// must never read an absent enrichment as a negative finding.
"use strict";

const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();

/* ── THE REGISTRY ───────────────────────────────────────────────────────────
   Adapters are registered by name at start-up (or by a test). Deliberately a
   registry and not a `require` of a provider module: a hard require is how one
   provider's name ends up spelled through the rest of the application. */
const providers = new Map();

/** The shape every adapter must satisfy — checked at registration, so a
 *  malformed adapter fails when it is wired up rather than mid-lookup. */
function registerProvider(name, adapter) {
  const key = str(name).toLowerCase();
  if (!key) throw fail("VALIDATION", "A discovery provider needs a name.");
  if (typeof adapter?.lookup !== "function") {
    throw fail("VALIDATION", `Discovery provider "${key}" has no lookup().`);
  }
  providers.set(key, adapter);
  return key;
}

/** Test and operator seam. */
function unregisterProvider(name) {
  return providers.delete(str(name).toLowerCase());
}

function registeredProviders() {
  return [...providers.keys()];
}

/* The fields an adapter is permitted to return. Anything else is dropped —
   silently accepting an unknown field is how a provider starts defining GRAV's
   schema. Deliberately excludes every consent and permission field. */
const ALLOWED_FIELDS = Object.freeze([
  "companyName",
  "website",
  "country",
  "sizeBand",
  "industry",
  "jobTitle",
  "workPhone",
  "linkedinUrl",
]);

const REFUSED_FIELDS = Object.freeze([
  "emailConsent", "phoneConsent", "consent", "optIn", "suppressed", "marketingConsent",
]);

/**
 * Ask the configured provider about an organisation or a work email.
 *
 * Never throws for an unavailable provider. A discovery lookup is an
 * enrichment: failing one must not stop a person who genuinely asked for a
 * callback from reaching Sales. The result says whether the provider answered,
 * so an empty enrichment is never mistaken for a provider that said "nothing".
 *
 * @param {{provider?:string, domain?:string, workEmail?:string, companyName?:string}} query
 * @returns {Promise<{available:boolean, provider:string, fields:object,
 *                    provenance:null|{provider,providerRecordId,retrievedAt,fields,lookupReference},
 *                    error:string}>}
 */
async function enrich(query = {}) {
  const name = str(query.provider || process.env.MARKETING_DISCOVERY_PROVIDER).toLowerCase();
  const empty = { available: false, provider: name, fields: {}, provenance: null, error: "" };

  if (!name) return { ...empty, error: "No discovery provider is configured." };
  const adapter = providers.get(name);
  if (!adapter) return { ...empty, error: `Discovery provider "${name}" is not registered.` };

  let raw;
  try {
    raw = await adapter.lookup({
      domain: str(query.domain).toLowerCase(),
      workEmail: str(query.workEmail).toLowerCase(),
      companyName: str(query.companyName),
    });
  } catch (err) {
    /* Logged without the query: a domain and a work email together identify a
       person, and an enrichment failure is not a reason to put one in a log
       file that a wider group can read. */
    console.error(`[marketing] discovery provider "${name}" failed:`, str(err?.message));
    return { ...empty, error: "The discovery provider could not be reached." };
  }

  if (!raw || typeof raw !== "object") {
    return { ...empty, available: true, error: "" };
  }

  /* A provider that tries to state a consent is refused outright rather than
     filtered quietly — it means somebody believes permission can be bought,
     and that belief needs to surface. */
  for (const banned of REFUSED_FIELDS) {
    if (raw[banned] !== undefined) {
      throw fail(
        "VALIDATION",
        `Discovery provider "${name}" returned "${banned}". Marketing permission is recorded from the person, never from a data provider.`,
        { provider: name, field: banned },
      );
    }
  }

  const fields = {};
  for (const key of ALLOWED_FIELDS) {
    const value = str(raw[key]);
    if (value) fields[key] = value;
  }

  const returned = Object.keys(fields);
  return {
    available: true,
    provider: name,
    fields,
    provenance: returned.length
      ? {
        provider: name,
        providerRecordId: str(raw.providerRecordId),
        retrievedAt: new Date(),
        fields: returned,
        lookupReference: str(raw.lookupReference),
      }
      : null,
    error: "",
  };
}

module.exports = {
  registerProvider,
  unregisterProvider,
  registeredProviders,
  enrich,
  ALLOWED_FIELDS,
  REFUSED_FIELDS,
};
