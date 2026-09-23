// services/prospectWorkState.js
//
// WHERE A PROSPECT HAS ACTUALLY GOT TO — derived, never stored.
//
// ── WHY THIS IS NOT A FIELD ─────────────────────────────────────────────────
// The obvious implementation is a `prospectStatus` on the Lead that somebody
// drags between columns. That produces a board which is accurate for about a
// week: statuses are moved when a person remembers, not when work happens, and
// the day they stop being moved the board reports a pipeline that does not
// exist. Worse, it can be advanced without doing anything — the appearance of
// progress is the cheapest thing on the screen to manufacture.
//
// So the state is a FUNCTION of what is already true: the Prospect's own
// fields, whether anybody has actually rung or written to them, and the
// existing conversion readiness. There is nothing to keep in step because
// there is nothing stored, and nothing to move by hand because the only way to
// advance is to do the work.
//
// ── THE FOUR STATES ─────────────────────────────────────────────────────────
//   New              nobody has tried to reach them yet.
//   Contacting       an attempt exists, but nobody has got through.
//   Follow-up        somebody got through; the record is not ready to convert.
//   Ready to convert readiness says the form is complete — see leadReadiness.
//
// Evaluated in reverse: the strongest true statement wins, so a Prospect that
// is ready to convert is not also reported as "Contacting" because an old call
// exists.
//
// ── TWO THINGS THAT DELIBERATELY DO NOT COUNT ───────────────────────────────
// A NOTE is not contact. Writing "they seem keen" to yourself moves nothing,
// and letting it advance the state would make the queue advanceable by typing.
//
// A PLANNED follow-up is not a completed interaction. An intention to ring
// somebody is not evidence that anybody rang them; counting it would put a
// Prospect in Follow-up before the first call had been made.
//
// ── AND WHY THERE IS NO "INTERESTED" ────────────────────────────────────────
// Confirming interest happens in the conversion dialog and turns the Prospect
// into a Lead in the same act. A persisted "Interested" state would be a queue
// of records waiting to be promoted for no reason — a step that exists only to
// be cleared.
"use strict";

/* ── THE CRM ALREADY HAD THIS VOCABULARY ─────────────────────────────────
   An earlier pass invented its own list here and got it wrong twice: it
   omitted `site_visit`, and — worse — it treated any COMPLETED outreach as a
   successful interaction. A call that rang out is completed. It is an attempt,
   not a conversation, and counting it as one let a Prospect nobody had ever
   spoken to reach Follow-up and satisfy conversion readiness.

   `constants/crm.js` draws exactly the distinction that was missing, and the
   qualification gate has always used it. Imported rather than restated so
   there is one definition of "we reached them" in the codebase. */
const {
  OUTREACH_ATTEMPT_ACTIVITY_TYPES,
  SUCCESSFUL_CONTACT_OUTCOMES,
} = require("../constants/crm");

/** Kept as an export under its old name for callers; now the canonical list. */
const OUTREACH_TYPES = OUTREACH_ATTEMPT_ACTIVITY_TYPES;

const STATES = {
  NEW: "new",
  CONTACTING: "contacting",
  FOLLOW_UP: "follow_up",
  READY: "ready_to_convert",
};

const LABEL = {
  [STATES.NEW]: "New",
  [STATES.CONTACTING]: "Contacting",
  [STATES.FOLLOW_UP]: "Follow-up",
  [STATES.READY]: "Ready to convert",
};

/** What the card's one button should say in each state. */
const ACTION_LABEL = {
  [STATES.NEW]: "Start outreach",
  [STATES.CONTACTING]: "Continue outreach",
  [STATES.FOLLOW_UP]: "Follow up",
  [STATES.READY]: "Review & convert",
};

/**
 * @param {object} facts
 * @param {boolean} facts.hasOutreachAttempt      a COMPLETED call/email/message/
 *        meeting/site visit exists — somebody actually tried, whatever came of it.
 * @param {boolean} facts.hasSuccessfulInteraction one of those attempts carries a
 *        SUCCESSFUL outcome — the customer actually engaged.
 * @param {boolean} facts.readyToConfirm          from computeSubmissionReadiness
 * @returns {{code:string,label:string,actionLabel:string}}
 */
function workStateFrom(facts = {}) {
  /* Strongest first. Precedence is the whole point: a ready Prospect that also
     has an old logged call is READY, not Contacting. */
  const code = facts.readyToConfirm
    ? STATES.READY
    : facts.hasSuccessfulInteraction
      ? STATES.FOLLOW_UP
      : facts.hasOutreachAttempt
        ? STATES.CONTACTING
        : STATES.NEW;

  return { code, label: LABEL[code], actionLabel: ACTION_LABEL[code] };
}

/**
 * The activity facts for many Prospects at once.
 *
 * ── ONE QUERY, NOT ONE PER CARD ─────────────────────────────────────────────
 * A list of forty Prospects asking "has anybody rung this one" forty times is
 * forty round trips to render one screen, and it degrades exactly as the team
 * gets busier. This groups by lead in a single aggregate and returns a Map, so
 * the cost is one query whatever the page size.
 *
 * @param {object} Activity  the model (injected, so this file stays pure of
 *                           requires and is trivially testable)
 * @param {Array} leadIds
 * @returns {Promise<Map<string,{hasOutreachAttempt:boolean,hasSuccessfulInteraction:boolean,lastContactAt:Date|null}>>}
 */
async function outreachFactsFor(Activity, leadIds = []) {
  const out = new Map();
  if (!leadIds.length) return out;

  const SUCCESS = [...SUCCESSFUL_CONTACT_OUTCOMES];

  const rows = await Activity.aggregate([
    {
      $match: {
        leadId: { $in: leadIds },
        isActive: true,
        activityType: { $in: OUTREACH_ATTEMPT_ACTIVITY_TYPES },
        /* Completed only, at the match. A PLANNED call is scheduled work — it
           says somebody intends to ring, which is not a fact about the
           customer and must not move the Prospect anywhere. */
        status: "completed",
      },
    },
    {
      $group: {
        _id: "$leadId",
        /* Somebody tried. Whether it connected is the next line's business. */
        attempts: { $sum: 1 },
        /* And somebody got through. A call with outcome "no_answer" is
           completed and is NOT this. */
        successes: {
          $sum: { $cond: [{ $in: ["$outcome", SUCCESS] }, 1, 0] },
        },
        /* "Last contact" means the last time the customer actually engaged.
           Taking the latest ATTEMPT would report a string of unanswered calls
           as recent contact, which is the opposite of what it is. */
        lastContactAt: {
          $max: {
            $cond: [
              { $in: ["$outcome", SUCCESS] },
              { $ifNull: ["$completedAt", "$activityDate"] },
              null,
            ],
          },
        },
      },
    },
  ]);

  for (const r of rows) {
    out.set(String(r._id), {
      hasOutreachAttempt: (r.attempts || 0) > 0,
      hasSuccessfulInteraction: (r.successes || 0) > 0,
      lastContactAt: r.lastContactAt || null,
    });
  }
  return out;
}

/** The empty answer, so a Prospect with no activity needs no special case. */
const NO_FACTS = { hasOutreachAttempt: false, hasSuccessfulInteraction: false, lastContactAt: null };

module.exports = {
  STATES,
  LABEL,
  ACTION_LABEL,
  OUTREACH_TYPES,
  workStateFrom,
  outreachFactsFor,
  NO_FACTS,
};
