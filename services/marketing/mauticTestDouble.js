// services/marketing/mauticTestDouble.js
//
// A SYNTHETIC MAUTIC THAT HONOURS THE RECORDED CONTRACT.
//
// ── WHY THIS EXISTS AND WHAT IT IS FOR ─────────────────────────────────────
// The roadmap's Chunk 0 says the adapter is "proved against a local synthetic
// Mautic contract" when a live instance is not available. This is that
// contract, written as a transport the real client
// (services/marketing/mauticClient.js) can be constructed with. The client
// under test is the production client — not a mock of it — so what the tests
// prove is the real request shapes, the real status handling, the real retry
// rule and the real error mapping.
//
// ── IT IMITATES MAUTIC'S AWKWARDNESS ON PURPOSE ────────────────────────────
// A double that returns the shape the caller wishes for proves nothing. The
// three details below are the ones that actually break integrations, and each
// is reproduced from Mautic 7.2.0's own source rather than from memory:
//
//   1. `contacts` and `lists` come back as an OBJECT KEYED BY ID, not an
//      array. Code that does `data.contacts.map(...)` throws, and code that
//      spreads it gets an empty array and reads it as "no match" — which then
//      creates a second contact for a person Mautic already holds.
//   2. Creating a contact answers 200 with `{contact:{...}}`, not 201.
//   3. Adding a contact already in a segment answers `{success:true}` — the
//      same answer as adding a new one. Enrolment is idempotent at the source.
//
// ── WHAT IT IS NOT ─────────────────────────────────────────────────────────
// It is NOT evidence that a live Mautic works. Every difference this double is
// known to have from a real instance is written down in
// `docs/handoff/mautic-chunk-0-contract.md` under "Known differences", and the
// live round trip (scripts/marketing/mautic-round-trip.js) is what closes
// them. Nothing here may be reported as a live integration.
"use strict";

const str = (v) => String(v ?? "").trim();

/**
 * Build a transport with the same surface `axios.create()` gives the client:
 * one `request({method,url,params,data,headers})` returning `{status,data}`.
 *
 * @param {object} opts.failWith        force every call to fail this way:
 *   {status} for an HTTP status, {code} for a transport error (ECONNREFUSED…)
 * @param {boolean} opts.rejectAuth     answer 401 to the token endpoint
 * @param {Array}   opts.segments       segments this instance holds
 */
function createMauticDouble({ failWith = null, rejectAuth = false, segments = [] } = {}) {
  const state = {
    contacts: new Map(),          // id → contact
    byEmail: new Map(),           // email → id
    segments: new Map(),          // id → {id, name, alias}
    membership: new Map(),        // contactId → Set(segmentId)
    calls: [],                    // every request, for assertions
    nextContactId: 1,
    tokensIssued: 0,
  };

  for (const s of segments.length ? segments : [{ id: 7, name: "GRAV integration test", alias: "grav-integration-test" }]) {
    state.segments.set(String(s.id), { ...s, id: Number(s.id) });
  }

  /** Mautic's own shape: an object keyed by id. */
  const keyed = (rows, key = "id") =>
    Object.fromEntries(rows.map((r) => [String(r[key]), r]));

  async function request({ method, url, params = {}, data = undefined }) {
    state.calls.push({ method, url, params, data });

    /* ── FORCED FAILURE ────────────────────────────────────────────────── */
    if (failWith?.code) {
      const err = new Error(`simulated ${failWith.code}`);
      err.code = failWith.code;
      throw err;
    }
    if (failWith?.status && !url.includes("/oauth/")) {
      return { status: failWith.status, data: { errors: [{ message: "simulated" }] } };
    }

    /* ── TOKEN ─────────────────────────────────────────────────────────── */
    if (url === "/oauth/v2/token") {
      if (rejectAuth) {
        return { status: 401, data: { error: "invalid_client", error_description: "simulated" } };
      }
      state.tokensIssued += 1;
      return { status: 200, data: { access_token: `synthetic-token-${state.tokensIssued}`, expires_in: 3600 } };
    }

    /* ── CONTACT LOOKUP ────────────────────────────────────────────────── */
    if (method === "GET" && url === "/api/contacts") {
      /* Only the exact-email filter is implemented, deliberately: it is the
         only lookup the identity rule permits, and a double that also answered
         a fuzzy `search=` would let a caller drift onto one unnoticed. */
      const col = str(params["where[0][col]"]);
      const expr = str(params["where[0][expr]"]);
      const val = str(params["where[0][val]"]).toLowerCase();
      if (col !== "email" || expr !== "eq") {
        return { status: 400, data: { errors: [{ message: "This double only implements an exact email filter." }] } };
      }
      const id = state.byEmail.get(val);
      const rows = id ? [state.contacts.get(id)] : [];
      return { status: 200, data: { total: rows.length, contacts: keyed(rows) } };
    }

    /* ── CREATE ────────────────────────────────────────────────────────── */
    if (method === "POST" && url === "/api/contacts/new") {
      const email = str(data?.email).toLowerCase();
      if (!email) {
        return { status: 400, data: { errors: [{ code: 400, message: "email: This value should not be blank." }] } };
      }
      /* Mautic does NOT deduplicate on email by itself at this endpoint — a
         second POST creates a second contact. That is precisely why the sync
         service looks first, and the double reproduces the hazard rather than
         hiding it. */
      const id = String(state.nextContactId++);
      const contact = {
        id: Number(id),
        dateAdded: new Date().toISOString(),
        dateModified: null,
        fields: { all: { ...data, id: Number(id) } },
        ...data,
      };
      state.contacts.set(id, contact);
      state.byEmail.set(email, id);
      return { status: 200, data: { contact } };  // 200, not 201
    }

    /* ── UPDATE ────────────────────────────────────────────────────────── */
    const editMatch = url.match(/^\/api\/contacts\/([^/]+)\/edit$/);
    if (editMatch && (method === "PATCH" || method === "PUT")) {
      const id = decodeURIComponent(editMatch[1]);
      const existing = state.contacts.get(id);
      if (!existing) return { status: 404, data: { errors: [{ code: 404, message: "Item was not found." }] } };
      const merged = method === "PATCH"
        ? { ...existing, ...data, fields: { all: { ...existing.fields.all, ...data } } }
        /* PUT really is a full replacement in Mautic. Reproduced so a test can
           show what choosing it would cost. */
        : { id: existing.id, ...data, fields: { all: { id: existing.id, ...data } } };
      merged.dateModified = new Date().toISOString();
      state.contacts.set(id, merged);
      if (str(data?.email)) state.byEmail.set(str(data.email).toLowerCase(), id);
      return { status: 200, data: { contact: merged } };
    }

    /* ── SEGMENTS ──────────────────────────────────────────────────────── */
    if (method === "GET" && url === "/api/segments") {
      const rows = [...state.segments.values()];
      return { status: 200, data: { total: rows.length, lists: keyed(rows) } };
    }

    const addMatch = url.match(/^\/api\/segments\/([^/]+)\/contact\/([^/]+)\/add$/);
    if (addMatch && method === "POST") {
      const segmentId = decodeURIComponent(addMatch[1]);
      const contactId = decodeURIComponent(addMatch[2]);
      if (!state.segments.has(segmentId)) return { status: 404, data: { errors: [{ message: "Segment not found." }] } };
      if (!state.contacts.has(contactId)) return { status: 404, data: { errors: [{ message: "Contact not found." }] } };
      if (!state.membership.has(contactId)) state.membership.set(contactId, new Set());
      /* Already a member answers exactly the same. Idempotent at the source. */
      state.membership.get(contactId).add(segmentId);
      return { status: 200, data: { success: true } };
    }

    const segsMatch = url.match(/^\/api\/contacts\/([^/]+)\/segments$/);
    if (segsMatch && method === "GET") {
      const contactId = decodeURIComponent(segsMatch[1]);
      const ids = [...(state.membership.get(contactId) || new Set())];
      const rows = ids.map((id) => state.segments.get(id)).filter(Boolean);
      return { status: 200, data: { total: rows.length, lists: keyed(rows) } };
    }

    return { status: 404, data: { errors: [{ code: 404, message: `This double does not implement ${method} ${url}.` }] } };
  }

  return { request, state };
}

module.exports = { createMauticDouble };
