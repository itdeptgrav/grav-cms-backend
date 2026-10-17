"use strict";
// services/ppc/cutPlan.js
//
// THE CUT ORDER PLAN — what PPC hands the cutting room with a cutting target.
//
// A cutting room is not asked for "560 garments". It is handed a cut order
// plan: how many of each size in each colour it must cut (the order's
// breakdown plus an allowance for rejects), the MARKERS to cut from (which
// sizes each marker carries, in what ratio, and how long it is), and the
// LAYS — how many plies of which colour on which marker — bounded by the
// height the straight knife can cut. From that follow the two figures the
// cutting master and the store both need: the size balance after the lays
// (short or over, size by size) and the fabric the lays will consume.
//
//   requirement   colour × size, from the target's work orders, + allowance %
//   marker        a ratio of sizes (S1 M2 L2 XL1 → 6 garments a ply), a length
//   lay           a marker × a colour × plies (≤ the knife's maximum height)
//   planned       plies × ratio, summed over the lays, per colour × size
//   balance       planned − requirement (negative = short, positive = over)
//   fabric        plies × (marker length + end allowance), per lay and in all
//
// Industry practice this follows: size-wise cut quantity = order breakdown
// plus a 2–5% excess; fewest lays and plies for the order; a lay's height is
// capped by the knife; fabric per lay is marker length × plies plus end bits.
//
// Pure: no database, no clock. It validates and derives; it stores nothing.
// `cutPlan.test.js` is the contract.

const LIMITS = Object.freeze({ maxMarkers: 20, maxLays: 200, maxRatio: 20, maxPliesCap: 400, maxAllowancePct: 15 });

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const clean = (s) => String(s == null ? "" : s).trim();
const keyOf = (colour, size) => `${clean(colour).toLowerCase()}|${clean(size).toLowerCase()}`;

/**
 * The size-wise requirement, from the work orders the target asks for.
 * @param rows `[{ colour, size, quantity }]` — one per work order (a variant)
 * @param allowancePct the excess cut for rejects and shade bands, 0–15
 */
function requirementOf(rows, allowancePct = 0) {
  const pct = Math.max(0, Math.min(LIMITS.maxAllowancePct, num(allowancePct)));
  const by = new Map();
  for (const r of rows || []) {
    const q = Math.max(0, Math.round(num(r?.quantity)));
    if (!q) continue;
    const k = keyOf(r.colour, r.size);
    const cur = by.get(k) || { colour: clean(r.colour), size: clean(r.size), quantity: 0 };
    cur.quantity += q;
    by.set(k, cur);
  }
  return [...by.values()].map((x) => ({ ...x, withAllowance: Math.ceil(x.quantity * (1 + pct / 100)) }));
}

/** Clean a plan the form sent. Unknown fields are dropped; numbers are bounded. */
function normalise(input = {}) {
  const markers = (Array.isArray(input.markers) ? input.markers : []).slice(0, LIMITS.maxMarkers).map((m, i) => ({
    key: clean(m?.key) || `M${i + 1}`,
    name: clean(m?.name) || `Marker ${i + 1}`,
    ratio: (Array.isArray(m?.ratio) ? m.ratio : [])
      .map((r) => ({ size: clean(r?.size), count: Math.max(0, Math.min(LIMITS.maxRatio, Math.round(num(r?.count)))) }))
      .filter((r) => r.size && r.count > 0),
    lengthM: Math.max(0, Math.round(num(m?.lengthM) * 100) / 100),
    widthCm: Math.max(0, Math.round(num(m?.widthCm))),
    efficiencyPct: Math.max(0, Math.min(100, Math.round(num(m?.efficiencyPct)))),
  }));
  const lays = (Array.isArray(input.lays) ? input.lays : []).slice(0, LIMITS.maxLays).map((l, i) => ({
    no: Math.max(1, Math.round(num(l?.no, i + 1))),
    markerKey: clean(l?.markerKey),
    colour: clean(l?.colour),
    plies: Math.max(0, Math.round(num(l?.plies))),
    date: /^\d{4}-\d{2}-\d{2}$/.test(clean(l?.date)) ? clean(l.date) : "",
    time: /^\d{2}:\d{2}$/.test(clean(l?.time)) ? clean(l.time) : "",
    table: clean(l?.table).slice(0, 40),
  }));
  return {
    allowancePct: Math.max(0, Math.min(LIMITS.maxAllowancePct, num(input.allowancePct, 3))),
    maxPlies: Math.max(1, Math.min(LIMITS.maxPliesCap, Math.round(num(input.maxPlies, 60)))),
    endAllowanceCm: Math.max(0, Math.min(50, num(input.endAllowanceCm, 3))),
    markers,
    lays,
  };
}

/**
 * Everything the cutting room reads off the plan, and every problem with it.
 * @param plan    a normalised plan
 * @param rows    the requirement rows (`[{ colour, size, quantity }]`)
 */
function evaluate(plan, rows) {
  const p = normalise(plan);
  const requirement = requirementOf(rows, p.allowancePct);
  const markers = new Map(p.markers.map((m) => [m.key, m]));
  const planned = new Map();
  /* The colour and size as the lay and marker wrote them, so a size nobody
     ordered is reported as "XL", not as the lower-cased key. */
  const shown = new Map();
  const problems = [];

  const lays = p.lays.map((l) => {
    const m = markers.get(l.markerKey);
    const perPly = m ? m.ratio.reduce((n, r) => n + r.count, 0) : 0;
    const pieces = m ? m.ratio.map((r) => ({ size: r.size, pieces: r.count * l.plies })) : [];
    for (const x of pieces) {
      const k = keyOf(l.colour, x.size);
      planned.set(k, (planned.get(k) || 0) + x.pieces);
      if (!shown.has(k)) shown.set(k, { colour: l.colour, size: x.size });
    }
    const fabricM = m ? Math.round(l.plies * (m.lengthM + p.endAllowanceCm / 100) * 100) / 100 : 0;
    if (!m) problems.push({ level: "error", text: `Lay ${l.no} refers to a marker that is not defined.` });
    if (l.plies > p.maxPlies) problems.push({ level: "error", text: `Lay ${l.no} has ${l.plies} plies; the maximum lay height is ${p.maxPlies}.` });
    if (!l.plies) problems.push({ level: "error", text: `Lay ${l.no} has no plies.` });
    if (l.colour && !requirement.some((r) => r.colour.toLowerCase() === l.colour.toLowerCase())) {
      problems.push({ level: "warning", text: `Lay ${l.no} is in ${l.colour}, which none of the selected work orders require.` });
    }
    return { ...l, markerName: m?.name || "", perPly, pieces, total: perPly * l.plies, fabricM };
  });

  for (const m of p.markers) {
    if (!m.ratio.length) problems.push({ level: "error", text: `${m.name} has no sizes in its ratio.` });
    if (!m.lengthM) problems.push({ level: "warning", text: `${m.name} has no length, so its fabric cannot be estimated.` });
  }

  const balance = requirement.map((r) => {
    const got = planned.get(keyOf(r.colour, r.size)) || 0;
    return { colour: r.colour, size: r.size, required: r.quantity, withAllowance: r.withAllowance, planned: got, balance: got - r.withAllowance };
  });
  /* A size planned that no work order needs is cut for nobody. */
  for (const [k, got] of planned) {
    if (!requirement.some((r) => keyOf(r.colour, r.size) === k)) {
      const { colour, size } = shown.get(k) || { colour: "", size: "" };
      balance.push({ colour, size, required: 0, withAllowance: 0, planned: got, balance: got, unrequired: true });
      problems.push({ level: "warning", text: `The lays cut ${got} of size ${size}${colour ? ` in ${colour}` : ""}, which no selected work order requires.` });
    }
  }
  const short = balance.filter((b) => b.balance < 0);
  if (lays.length && short.length) {
    problems.push({ level: "warning", text: `${short.length} size${short.length === 1 ? " is" : "s are"} short of the requirement after these lays.` });
  }

  return {
    plan: p,
    requirement,
    lays,
    balance,
    totals: {
      required: requirement.reduce((n, r) => n + r.quantity, 0),
      withAllowance: requirement.reduce((n, r) => n + r.withAllowance, 0),
      planned: lays.reduce((n, l) => n + l.total, 0),
      lays: lays.length,
      plies: lays.reduce((n, l) => n + l.plies, 0),
      fabricM: Math.round(lays.reduce((n, l) => n + l.fabricM, 0) * 100) / 100,
      shortSizes: short.length,
    },
    problems,
    ok: !problems.some((x) => x.level === "error"),
  };
}

/**
 * Lays that cover one colour's requirement with one marker: the plies the
 * tightest size needs, split into lays no higher than the knife allows.
 * The cutting master can change any of it; this is a starting point, the
 * calculation a planner otherwise does on paper.
 */
function suggestLays({ colour, marker, requirement, maxPlies, startNo = 1, date = "" }) {
  const need = (requirement || []).filter((r) => r.colour.toLowerCase() === clean(colour).toLowerCase());
  const ratio = (marker?.ratio || []).filter((r) => r.count > 0);
  if (!need.length || !ratio.length) return [];
  let plies = 0;
  for (const r of ratio) {
    const req = need.find((x) => x.size.toLowerCase() === r.size.toLowerCase());
    if (req) plies = Math.max(plies, Math.ceil(req.withAllowance / r.count));
  }
  if (!plies) return [];
  const cap = Math.max(1, Math.round(num(maxPlies, 60)));
  const count = Math.ceil(plies / cap);
  const even = Math.ceil(plies / count);
  const out = [];
  let left = plies;
  for (let i = 0; i < count; i++) {
    const here = Math.min(even, left);
    out.push({ no: startNo + i, markerKey: marker.key, colour: clean(colour), plies: here, date, table: "" });
    left -= here;
  }
  return out;
}

module.exports = { LIMITS, requirementOf, normalise, evaluate, suggestLays, keyOf };
