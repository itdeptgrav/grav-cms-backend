// services/plannerAttention.js
//
// "This goal needs a decision."
//
// The same failure the sales side just fixed, one floor down. A planner gives
// you words for stopping — paused, dropped — and then makes stopping the only
// action that costs anything. Leaving a dead project marked active is free;
// admitting it is over takes a click and a sentence. So the rational move is
// always to do nothing, and within two months the ladder is full of missions
// nobody has touched since spring and nobody will call finished either.
//
// This inverts it, exactly as services/journeyAttention.js does for a deal: a
// goal that has gone quiet stops being quiet. It surfaces on Review, and there
// are three ways to clear it — do something, pause it, or drop it. Silence
// becomes the noisy option.
//
// SIX TRIGGERS, all from data that already exists:
//
//   overdue        an active goal whose target date has passed. The only one
//                  the owner explicitly asked for by setting a date.
//   empty          an active project with no tasks in it. A project is a
//                  promise to break something down; an empty one never was.
//   barren         an active vision or mission with nothing beneath it. Same
//                  problem, one rung up — an intention with no plan attached.
//   stale          an active project with tasks where nothing has been created
//                  or finished in STALE_DAYS. The classic drifting project.
//   pausedLong     paused, and left paused past PAUSED_REVIEW_DAYS. "Not now"
//                  has an expiry; without one it is just "no" with better
//                  manners.
//   nearlyDone     an active project at 80%+ with a short tail left. Not a
//                  problem — an OPPORTUNITY, and the only positive item here.
//                  Review that only ever nags is a review people stop opening.
//
// DELIBERATELY NOT HERE: a health score out of 100 (actionable is "needs a
// decision or not"; a percentage is not), automatic pausing or dropping (a
// system that decides your goal is dead will be wrong, and once it is wrong
// twice you stop trusting every state it sets), and email or push (nagging
// before the threshold is proven is how a feature gets switched off).
//
// Pure and dependency-free: handed a tree, it returns items. Nothing is fetched
// and nothing is written.

"use strict";

/** Long enough that a fortnight's holiday does not indict every project. */
const STALE_DAYS = 21;

/** A pause worth revisiting. One quarter, roughly. */
const PAUSED_REVIEW_DAYS = 90;

/** The tail end, where a nudge is worth more than a warning. */
const NEARLY_DONE_PERCENT = 80;

const DAY = 86400000;

const at = (v) => (v ? new Date(v).getTime() : null);
const daysBetween = (a, b) => Math.floor((a - b) / DAY);

/**
 * The most recent sign of life on a project: a task created, edited or
 * finished. `updatedAt` covers all three, which is why it is the field read
 * rather than doneAt — renaming a task is still touching the project.
 */
function lastTouched(goal) {
  const stamps = [at(goal.updatedAt)];
  for (const t of goal.tasks || []) stamps.push(at(t.updatedAt), at(t.doneAt));
  return Math.max(...stamps.filter((n) => typeof n === "number" && !Number.isNaN(n)));
}

/**
 * Assess one goal. Returns null when it is fine — the common case, and the one
 * worth keeping cheap.
 *
 * ONE REASON PER GOAL, most decision-worthy first. A list that tells you a
 * project is empty AND stale AND overdue has told you nothing you can act on;
 * it has just made one problem look like three.
 */
function assessGoal(goal, now) {
  const nowMs = now.getTime();

  if (goal.status === "dropped" || goal.status === "achieved") return null;

  if (goal.status === "paused") {
    const since = at(goal.statusAt) || at(goal.updatedAt);
    const days = since ? daysBetween(nowMs, since) : 0;
    if (days >= PAUSED_REVIEW_DAYS) {
      return { reason: "pausedLong", days, detail: `Paused ${days} days ago.` };
    }
    // A recent pause is the system working. Nothing else applies to a goal the
    // owner has already explicitly set down.
    return null;
  }

  const target = at(goal.targetDate);
  if (target && target < nowMs) {
    const days = daysBetween(nowMs, target);
    return {
      reason: "overdue",
      days,
      detail: days === 0 ? "Target date is today." : `Target date passed ${days} days ago.`,
    };
  }

  if (goal.level === "project") {
    if (!goal.tasks?.length) {
      return { reason: "empty", days: 0, detail: "No tasks in it yet." };
    }
    if (goal.progress?.percent >= NEARLY_DONE_PERCENT && goal.progress.percent < 100) {
      const left = (goal.progress.total || 0) - (goal.progress.done || 0);
      return {
        reason: "nearlyDone",
        days: 0,
        detail: `${left} task${left === 1 ? "" : "s"} from done.`,
        positive: true,
      };
    }
    const touched = lastTouched(goal);
    const days = touched ? daysBetween(nowMs, touched) : 0;
    if (days >= STALE_DAYS) {
      return { reason: "stale", days, detail: `Nothing has moved in ${days} days.` };
    }
    return null;
  }

  // A vision or a mission. Its job is to have something beneath it.
  const live = (goal.children || []).filter((c) => c.status !== "dropped");
  if (!live.length) {
    const what = goal.level === "vision" ? "missions" : "projects";
    return { reason: "barren", days: 0, detail: `No ${what} under it yet.` };
  }

  return null;
}

/**
 * Walk a tree from services/plannerRollup.js and return everything asking for a
 * decision, most urgent first.
 *
 * Ordering is by REASON first and age second, not by age alone: an empty
 * project created yesterday is a more answerable question than a mission that
 * has been quietly overdue for a year, and a review list sorted purely by age
 * puts the oldest, most demoralising item at the top every single week.
 */
const REASON_RANK = {
  overdue: 0,
  stale: 1,
  empty: 2,
  barren: 3,
  pausedLong: 4,
  nearlyDone: 5,
};

function plannerAttention(tree, now = new Date()) {
  const items = [];

  const visit = (goal, ancestors) => {
    const verdict = assessGoal(goal, now);
    if (verdict) {
      items.push({
        goalId: goal.id,
        level: goal.level,
        title: goal.title,
        status: goal.status,
        path: ancestors.map((a) => a.title),
        percent: goal.progress?.percent ?? 0,
        ...verdict,
      });
    }
    for (const child of goal.children || []) visit(child, [...ancestors, goal]);
  };

  for (const vision of tree.visions || []) visit(vision, []);
  for (const orphan of tree.orphans || []) visit(orphan, []);

  items.sort((a, b) => {
    const r = (REASON_RANK[a.reason] ?? 9) - (REASON_RANK[b.reason] ?? 9);
    return r !== 0 ? r : (b.days || 0) - (a.days || 0);
  });

  // Counted, not listed as attention items. An inbox is a normal working state,
  // not a fault — it earns a number on the Review screen and nothing louder.
  const unfiled = (tree.inbox || []).filter((t) => t.status !== "done").length;

  return {
    items,
    needsDecision: items.filter((i) => !i.positive).length,
    unfiled,
    thresholds: { STALE_DAYS, PAUSED_REVIEW_DAYS, NEARLY_DONE_PERCENT },
  };
}

module.exports = {
  plannerAttention,
  assessGoal,
  STALE_DAYS,
  PAUSED_REVIEW_DAYS,
  NEARLY_DONE_PERCENT,
};
