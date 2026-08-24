// models/Planner/PlannerGoal.js
//
// One rung of the personal goal ladder: a Vision, a Mission, or a Project.
//
// WHY ONE COLLECTION AND NOT THREE
// --------------------------------
// The three levels are the same record at three distances — a title, a reason,
// a horizon, a status, a parent. Three collections would have meant three
// near-identical schemas, three sets of CRUD routes, and a reparent operation
// that had to move a document between collections. `level` costs one indexed
// string and buys a single tree.
//
// THE LADDER CANNOT BEND, SO THERE IS NO CYCLE TO GUARD
// -----------------------------------------------------
// A vision has no parent; a mission's parent must be a vision; a project's
// parent must be a mission. That is enforced below in pre-validate against
// PLANNER_PARENT_LEVEL, which makes the tree exactly three deep by
// construction. Depth is bounded, so ancestor-walking always terminates and
// none of the cycle machinery the CRM's account hierarchy needs
// (services/crmHierarchy.js) applies here. If a fourth level is ever wanted,
// it goes in constants/planner.js and this file does not change.
//
// PROGRESS IS NEVER STORED
// ------------------------
// There is no `percentComplete` field, on purpose. A project's progress is its
// tasks, a mission's is its projects, a vision's is its missions — all derived
// in services/plannerRollup.js at read time. A stored number is a number that
// goes stale the first time a task is ticked from somewhere that forgot to
// update it, and a planner whose percentages lie is worse than one with none.
//
// PRIVACY IS THE INDEX
// --------------------
// `ownerId` is on every compound index and every query in routes/Planner. This
// is one person's own intent, not a business record: there is no team view, no
// manager rollup and no sharing, and the absence of those is a feature rather
// than an unbuilt phase.

const mongoose = require("mongoose");
const {
  PLANNER_LEVEL_CODES,
  PLANNER_GOAL_STATUS_CODES,
  PLANNER_PARENT_LEVEL,
} = require("../../constants/planner");

const plannerGoalSchema = new mongoose.Schema(
  {
    // The signed-in employee's Mongo id, from the JWT. The one field that must
    // never be client-supplied — every route takes it from req.user.
    ownerId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    // Carried alongside for legibility when reading the collection by hand
    // (GR0067 means something; an ObjectId does not). Never used for lookup —
    // ownerId is the key, so a biometric-id reissue cannot orphan anyone.
    ownerEmployeeId: { type: String, trim: true },

    level: { type: String, enum: PLANNER_LEVEL_CODES, required: true, index: true },

    // Null for a vision. Validated against the ladder below, so this can only
    // ever point at the level directly above.
    parentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PlannerGoal",
      index: true,
      default: null,
    },

    title: { type: String, trim: true, required: true, maxlength: 200 },

    /**
     * The reason this exists, in the owner's own words.
     *
     * Named `why` rather than `description` because that is the question it is
     * asking. A vision without one is a slogan, and the field being called
     * "description" is what turns it into one.
     */
    why: { type: String, trim: true, maxlength: 2000 },

    /**
     * When this should be true by. Optional at every level and deliberately
     * unused for visions in the UI — a vision with a deadline is a mission.
     */
    targetDate: { type: Date },

    status: {
      type: String,
      enum: PLANNER_GOAL_STATUS_CODES,
      default: "active",
      index: true,
    },
    /** Why it was paused or dropped. The part worth reading a year later. */
    statusNote: { type: String, trim: true, maxlength: 1000 },
    statusAt: { type: Date },

    /**
     * Manual sort within a parent. A float, not an integer, so inserting
     * between two neighbours is one write to the moved row rather than a
     * renumber of everything after it.
     */
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// Every read is "this person's goals, at this level" or "this person's
// children of X" — both covered here, both owner-first so no query can
// accidentally straddle two people.
plannerGoalSchema.index({ ownerId: 1, level: 1, status: 1 });
plannerGoalSchema.index({ ownerId: 1, parentId: 1, order: 1 });

/**
 * The ladder invariant. A vision must be rootless; everything else must hang
 * off exactly the level above it.
 *
 * Enforced here rather than only in the route so that a script, a backfill or
 * a future second caller cannot quietly create a project under a vision and
 * leave the tree with a rung missing.
 */
plannerGoalSchema.pre("validate", function (next) {
  const expectedParent = PLANNER_PARENT_LEVEL[this.level] || null;

  if (!expectedParent) {
    // A vision. Anything else with no parent level is a bug in the constants.
    if (this.parentId) {
      return next(new Error(`A ${this.level} cannot have a parent.`));
    }
    return next();
  }

  if (!this.parentId) {
    return next(new Error(`A ${this.level} must belong to a ${expectedParent}.`));
  }

  next();
});

module.exports =
  mongoose.models.PlannerGoal || mongoose.model("PlannerGoal", plannerGoalSchema);
