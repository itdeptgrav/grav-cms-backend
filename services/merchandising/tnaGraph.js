// services/merchandising/tnaGraph.js
//
// THE DEPENDENCY GRAPH, AND THE FORECAST IT PRODUCES. PURE.
//
// Two jobs, both arithmetic and neither touching a database:
//
//   · rank the milestones so a cycle is impossible and one ordered pass
//     settles the whole plan;
//   · compute, for a set of milestones, what each is now expected to land on.
//
// ── WHY A CYCLE IS NAMED, NOT JUST REFUSED ──────────────────────────────────
// "Invalid graph" tells a configurer nothing they can act on. A forty-milestone
// template with one accidental back-edge is not something anybody finds by
// reading. So the validator runs Kahn's algorithm, and when nodes remain
// unranked it walks the remainder to name the actual loop: `A → B → C → A`.
// The refusal is the diagnosis.
//
// ── WHY AN ACTUAL BEATS A FORECAST ──────────────────────────────────────────
// Propagation feeds `actualDate ?? forecastDate` into successors. Once
// something has happened, the date it happened is the input — not what anybody
// expected. A plan that kept forecasting from an optimistic estimate after the
// event would understate every downstream date, which is precisely the lie a
// T&A system exists to prevent.
//
// ── AND WHY ONE PASS IS ENOUGH ──────────────────────────────────────────────
// Milestones are walked in topological rank order, so every predecessor is
// settled before its successors are read. No recursion, no revisit, no
// convergence loop that could fail to converge.
"use strict";

const { fail } = require("../storePurchase/errors");
const cal = require("./tnaCalendar");

const str = (v) => String(v ?? "").trim();

/* ═══ VALIDATION AND RANKING ═══════════════════════════════════════════════ */

/**
 * Check the edges name real milestones, and nothing names itself twice.
 *
 * Run before ranking so a malformed edge is reported as what it is rather than
 * surfacing later as a mysterious unreachable node.
 */
function validateEdges(milestoneCodes, dependencies) {
  const known = new Set(milestoneCodes);
  const seen = new Set();

  for (const dep of dependencies || []) {
    const from = str(dep.predecessorCode);
    const to = str(dep.successorCode);

    if (!known.has(from)) {
      throw fail("TNA_DEPENDENCY_UNKNOWN_CODE",
        `A dependency names "${from}", which is not a milestone in this version.`,
        { predecessorCode: from });
    }
    if (!known.has(to)) {
      throw fail("TNA_DEPENDENCY_UNKNOWN_CODE",
        `A dependency names "${to}", which is not a milestone in this version.`,
        { successorCode: to });
    }
    if (from === to) {
      throw fail("TNA_DEPENDENCY_CYCLE",
        `"${from}" cannot depend on itself.`, { cycle: [from, from] });
    }
    const pair = `${from}→${to}`;
    if (seen.has(pair)) {
      throw fail("VALIDATION",
        `The dependency ${from} → ${to} is stated twice.`, { field: "dependencies", pair });
    }
    seen.add(pair);

    const lag = Number(dep.lagWorkingDays ?? 0);
    if (!Number.isInteger(lag) || lag < 0) {
      throw fail("VALIDATION",
        `The lag on ${from} → ${to} must be a whole number of working days, not negative.`,
        { field: "lagWorkingDays", pair });
    }
  }
  return true;
}

/**
 * Topologically rank the milestones, or name the cycle that prevents it.
 *
 * Kahn's algorithm: repeatedly take every node with no unsatisfied
 * predecessor. Whatever is left when that stops is, by definition, inside a
 * cycle — and `findCycle` walks it to say which one.
 */
function rank(milestoneCodes, dependencies) {
  validateEdges(milestoneCodes, dependencies);

  const successors = new Map(milestoneCodes.map((c) => [c, []]));
  const indegree = new Map(milestoneCodes.map((c) => [c, 0]));
  for (const dep of dependencies || []) {
    successors.get(str(dep.predecessorCode)).push(str(dep.successorCode));
    indegree.set(str(dep.successorCode), indegree.get(str(dep.successorCode)) + 1);
  }

  /* Sorted, so the rank a template produces is the same on every machine —
     a baseline has to be reproducible. */
  const queue = milestoneCodes.filter((c) => indegree.get(c) === 0).sort();
  const ranks = new Map();
  let position = 0;

  while (queue.length) {
    const code = queue.shift();
    ranks.set(code, position);
    position += 1;
    const next = [];
    for (const successor of successors.get(code) || []) {
      indegree.set(successor, indegree.get(successor) - 1);
      if (indegree.get(successor) === 0) next.push(successor);
    }
    /* Kept deterministic the same way. */
    queue.push(...next.sort());
    queue.sort((a, b) => (ranks.has(a) ? 1 : 0) - (ranks.has(b) ? 1 : 0));
  }

  if (ranks.size !== milestoneCodes.length) {
    const stuck = milestoneCodes.filter((c) => !ranks.has(c));
    const cycle = findCycle(stuck, dependencies);
    throw fail("TNA_DEPENDENCY_CYCLE",
      `These milestones depend on each other in a loop: ${cycle.join(" → ")}. `
      + "A plan cannot be scheduled until the loop is broken.",
      { cycle, unranked: stuck });
  }
  return ranks;
}

/** Walk the unranked remainder to name one actual loop. */
function findCycle(stuck, dependencies) {
  const inStuck = new Set(stuck);
  const next = new Map(stuck.map((c) => [c, []]));
  for (const dep of dependencies || []) {
    const from = str(dep.predecessorCode);
    const to = str(dep.successorCode);
    if (inStuck.has(from) && inStuck.has(to)) next.get(from).push(to);
  }

  const start = [...stuck].sort()[0];
  const seenAt = new Map();
  let node = start;
  let step = 0;
  while (node !== undefined && !seenAt.has(node)) {
    seenAt.set(node, step);
    step += 1;
    node = (next.get(node) || []).sort()[0];
  }
  if (node === undefined) return stuck;

  /* Trim the tail that led into the loop, so what is reported IS the loop. */
  const path = [...seenAt.entries()].sort((a, b) => a[1] - b[1]).map(([c]) => c);
  return [...path.slice(seenAt.get(node)), node];
}

/* ═══ FORECAST ═════════════════════════════════════════════════════════════ */

/**
 * Where a milestone starts from before its predecessors are considered.
 *
 * `PLAN_START` counts forward from the plan's own start; `DELIVERY` and
 * `EX_FACTORY` count back from a committed date — which is how every date
 * before a shipment is actually expressed, and why the offset is signed.
 *
 * A milestone anchored to a date the file does not have (no ex-factory date,
 * because Sales did not state one) returns null: the plan says it cannot place
 * that milestone rather than inventing an anchor.
 */
function anchorDate(milestone, { planStartDate, deliveryDate, exFactoryDate }, calendarVersion) {
  /* ── A PRE-RESOLVED ANCHOR ────────────────────────────────────────────
     A per-delivery or per-unit milestone anchors to ITS OWN drop's committed
     date, which this pure function cannot know — the caller resolves it and
     hands it in. It has to arrive here, inside the ranked pass, rather than
     be merged over the result afterwards: a floor applied after the fact
     never reaches the milestone's successors, so an anchored milestone would
     hold its date while everything downstream of it computed from nothing. */
  if (Object.prototype.hasOwnProperty.call(milestone, "__anchor")) return milestone.__anchor || null;

  const offset = Number(milestone.offsetWorkingDays ?? 0);
  let base = null;
  if (milestone.anchor === "DELIVERY") base = deliveryDate || null;
  else if (milestone.anchor === "EX_FACTORY") base = exFactoryDate || null;
  else if (milestone.anchor === "PREDECESSOR") return null;
  else base = planStartDate || null;

  if (!base) return null;
  return cal.addWorkingDays(base, offset, calendarVersion);
}

/**
 * Compute every milestone's forecast, in rank order, in one pass.
 *
 *   forecast(m) = max( anchor(m),
 *                      max over predecessors p of addWorkingDays(effective(p), lag + 1) )
 *
 * `+1` because FINISH_TO_START means the successor starts the working day
 * AFTER the predecessor finishes; a zero lag is "the next day", not "the same
 * day".
 *
 * @param milestones  in any order; each `{milestoneRef, milestoneCode, anchor,
 *                    offsetWorkingDays, actualDate, forecastDate}`
 * @returns Map milestoneRef → forecast date string (or null)
 */
function computeForecasts(milestones, dependencies, context, calendarVersion) {
  const byCode = new Map();
  for (const m of milestones) {
    if (!byCode.has(m.milestoneCode)) byCode.set(m.milestoneCode, []);
    byCode.get(m.milestoneCode).push(m);
  }

  const predecessors = new Map();
  for (const dep of dependencies || []) {
    const to = str(dep.successorCode);
    if (!predecessors.has(to)) predecessors.set(to, []);
    predecessors.get(to).push({
      code: str(dep.predecessorCode),
      lag: Number(dep.lagWorkingDays ?? 0),
    });
  }

  const ordered = [...milestones].sort((a, b) => (a.sequenceRank ?? 0) - (b.sequenceRank ?? 0));
  const out = new Map();

  /* What a milestone contributes downstream: what happened, else what is
     expected. An actual always wins — see the header. */
  const effective = (m) => m.actualDate || out.get(m.milestoneRef) || m.forecastDate || null;

  for (const m of ordered) {
    /* A completed milestone's forecast is the day it happened. Anything else
       would leave the register showing a date that has already been overtaken
       by events. */
    if (m.actualDate) {
      out.set(m.milestoneRef, m.actualDate);
      continue;
    }

    let best = anchorDate(m, context, calendarVersion);

    for (const pred of predecessors.get(m.milestoneCode) || []) {
      for (const p of byCode.get(pred.code) || []) {
        /* A per-delivery successor only follows the predecessor of its own
           delivery, where both are scoped that way. Otherwise every drop
           would wait for every other drop's fabric. */
        if (m.scopeKind === "DELIVERY" && p.scopeKind === "DELIVERY"
          && str(m.dropRef) !== str(p.dropRef)) continue;
        if (m.scopeKind === "UNIT" && p.scopeKind === "UNIT"
          && str(m.unitDiscriminator) !== str(p.unitDiscriminator)) continue;

        const from = effective(p);
        if (!from) continue;
        const earliest = cal.addWorkingDays(from, pred.lag + 1, calendarVersion);
        if (!best || earliest > best) best = earliest;
      }
    }
    out.set(m.milestoneRef, best);
  }
  return out;
}

/**
 * The longest chain of dependencies ending at a milestone — the critical path.
 *
 * Answers "what is holding this up" rather than "what does the schedule look
 * like". Walks predecessors from the target, always taking the one whose
 * effective date is latest, because that is the one actually setting the date.
 */
function criticalPath(milestones, dependencies, targetRef) {
  const byRef = new Map(milestones.map((m) => [m.milestoneRef, m]));
  const byCode = new Map();
  for (const m of milestones) {
    if (!byCode.has(m.milestoneCode)) byCode.set(m.milestoneCode, []);
    byCode.get(m.milestoneCode).push(m);
  }
  const predecessors = new Map();
  for (const dep of dependencies || []) {
    const to = str(dep.successorCode);
    if (!predecessors.has(to)) predecessors.set(to, []);
    predecessors.get(to).push(str(dep.predecessorCode));
  }

  const chain = [];
  const guard = new Set();
  let current = byRef.get(targetRef);
  while (current && !guard.has(current.milestoneRef)) {
    guard.add(current.milestoneRef);
    chain.unshift(current);

    let latest = null;
    for (const code of predecessors.get(current.milestoneCode) || []) {
      for (const p of byCode.get(code) || []) {
        if (current.scopeKind === "DELIVERY" && p.scopeKind === "DELIVERY"
          && str(current.dropRef) !== str(p.dropRef)) continue;
        const at = p.actualDate || p.forecastDate;
        const bestAt = latest ? (latest.actualDate || latest.forecastDate) : null;
        if (at && (!bestAt || at > bestAt)) latest = p;
      }
    }
    current = latest;
  }
  return chain;
}

module.exports = { validateEdges, rank, findCycle, anchorDate, computeForecasts, criticalPath };
