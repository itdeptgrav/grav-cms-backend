"use strict";
// services/integration/developmentChargeCatalog.service.js
//
// THE DEVELOPMENT-CHARGE CATALOGUE, AS MERCHANDISING IS ALLOWED TO SEE IT.
//
// Costing owns what a development charge IS — its key, its label, how it is
// calculated, what unit it is counted in — and owns what it costs. A
// merchandiser choosing "screen making" for a style needs the first four and
// must never be shown the fifth: a Merchandising screen reading
// "Screen making — ₹2,000 each" publishes the company's cost book to a desk
// that does not own it, and to whoever they forward the page to.
//
// Costing already enforces that: `catalogueForMerchandising` is its own
// allowlist, and no amount crosses it.
//
// ── WHAT THIS MODULE IS FOR, THEN ───────────────────────────────────────────
// The projection was right and the IMPORT was backwards. Merchandising
// `require`d a Central Costing policy service directly, which put a costing
// policy, a calculation engine and a decimal library into the load graph of a
// service that has no business knowing costing exists. Merchandising and Sales
// publish identities for Costing to consume; the arrow points one way, and a
// static import pointing back is the arrow bent round.
//
// So the seam lives here, in the integration layer, and it does two things a
// direct import could not:
//
//   · it resolves Costing LAZILY, at call time rather than at load time, so
//     nothing above it compiles a costing module to start up; and
//   · it FAILS SOFT. A deployment without the Central Costing application
//     answers "no charges configured", which is the truth, instead of failing
//     to boot. Merchandising's own work does not stop because another
//     application is absent.
//
// The shape it returns is Costing's own, unchanged: a Map keyed by charge key.
// Nothing here reformats it, and nothing here adds to it — a second projection
// would be a second allowlist to keep in step, and the one that matters is the
// one beside the policy.

/** The empty answer. A company with no policy has no charges, which is a fact. */
const NONE = () => new Map();

/**
 * Costing's policy service, or null when it is not deployed.
 *
 * `require` inside the function on purpose. At module scope it would be the
 * very dependency this file exists to remove.
 */
function costingPolicy() {
  try {
    return require("../centralCosting/developmentChargePolicy.service");
  } catch {
    /* Not deployed, or mid-migration. Not an error: see the header. */
    return null;
  }
}

/**
 * The charges a merchandiser may choose from, for one company.
 *
 * @returns {Promise<Map<string, {key, label, description, calculation, unit}>>}
 *   Never null, and never carrying an amount.
 */
async function catalogueFor(companyId) {
  const policy = costingPolicy();
  if (!policy?.resolveFor || !policy?.catalogueForMerchandising) return NONE();

  const resolved = await policy.resolveFor({ companyId }).catch(() => null);
  const catalogue = policy.catalogueForMerchandising(resolved);
  return catalogue instanceof Map ? catalogue : NONE();
}

/** Whether Costing is present at all — for a screen that wants to say so. */
const costingAvailable = () => Boolean(costingPolicy());

module.exports = { catalogueFor, costingAvailable };
