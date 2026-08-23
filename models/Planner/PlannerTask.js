// models/Planner/PlannerTask.js
//
// The doing layer. One thing to actually do, on a day.
//
// WHY IT IS NOT A FOURTH LEVEL OF PlannerGoal
// -------------------------------------------
// A goal is something you aim at; a task is something you finish and never
// look at again. They churn at completely different rates — a vision is edited
// twice a year, a task list is rewritten every morning — and they are read by
// completely different screens. Folding tasks into the goal tree would mean
// every tree query dragged along thousands of ticked-off rows to render three
// visions.
//
// A TASK MAY HAVE NO GOAL. THIS IS THE MOST IMPORTANT DECISION IN THE FILE.
// ------------------------------------------------------------------------
// `goalId` is nullable, and a task without one is the Inbox.
//
// The tempting rule is that every task must ladder up to a vision — it sounds
// rigorous and it is how the diagram looks. In practice it is the thing that
// kills a personal planner: something occurs to you at 11pm, the app demands
// you first decide which of your three missions it serves, and you write it on
// paper instead. Capture has to be free. Filing it under a project is a second,
// optional step that can happen later, or never.
//
// So the ladder is an ASPIRATION the app helps you honour, not a gate it makes
// you pass. The review surface can show how many open tasks are unfiled; that
// is a far more useful nudge than a required dropdown.
//
// DELIBERATELY NOT HERE (chunk 1)
// -------------------------------
// Recurrence, subtasks, reminders, priority, time estimates, tags. Each is a
// real feature and each is a field the owner has to maintain forever. They earn
// their way in by being missed, not by being on a list of what planners have.

const mongoose = require("mongoose");
const { PLANNER_TASK_STATUS_CODES } = require("../../constants/planner");

const plannerTaskSchema = new mongoose.Schema(
  {
    ownerId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    ownerEmployeeId: { type: String, trim: true },

    /**
     * The goal this serves — normally a project, but any level is allowed.
     *
     * Null is the Inbox (see the header). Not restricted to `level: "project"`
     * because a one-off task can genuinely belong straight to a mission
     * without a project being invented to hold it, and forcing that invention
     * produces projects-of-one that clutter the tree.
     */
    goalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PlannerGoal",
      index: true,
      default: null,
    },

    title: { type: String, trim: true, required: true, maxlength: 300 },
    notes: { type: String, trim: true, maxlength: 2000 },

    status: {
      type: String,
      enum: PLANNER_TASK_STATUS_CODES,
      default: "todo",
      index: true,
    },

    /**
     * The day this is due — a CALENDAR DAY, not a moment.
     *
     * Stored as midnight UTC of the intended day and always compared as a day,
     * never as an instant. The rest of this backend works in IST by computing
     * `Date.now() + 5.5h` and then reading with `getUTC*` (see the SOP and
     * attendance services); the routes here follow that same pattern rather
     * than introducing a timezone library, so "due today" means the same thing
     * at 9am and at 11pm.
     */
    dueOn: { type: Date, index: true, sparse: true },

    /**
     * Set when status becomes "done", cleared when it leaves. Maintained in the
     * pre-save hook below so it can never disagree with `status` — a done task
     * with no completion date is the kind of row that quietly breaks every
     * "what did I finish this week" question later.
     */
    doneAt: { type: Date },

    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// "My open tasks, soonest first" and "this goal's tasks" — the only two reads
// the app makes, both owner-scoped.
plannerTaskSchema.index({ ownerId: 1, status: 1, dueOn: 1 });
plannerTaskSchema.index({ ownerId: 1, goalId: 1, order: 1 });

plannerTaskSchema.pre("save", function (next) {
  if (this.isModified("status")) {
    if (this.status === "done") {
      // Preserve an existing timestamp — re-saving a done task must not move
      // the day it was finished.
      if (!this.doneAt) this.doneAt = new Date();
    } else {
      this.doneAt = undefined;
    }
  }
  next();
});

module.exports =
  mongoose.models.PlannerTask || mongoose.model("PlannerTask", plannerTaskSchema);
