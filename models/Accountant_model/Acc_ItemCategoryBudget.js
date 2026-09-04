// models/Accountant_model/Acc_ItemCategoryBudget.js
//
// WHICH BUDGET AN ITEM COMES OUT OF.
//
// A requester knows they need cotton fabric. They do not know, and should not
// have to know, that fabric is budgeted under Raw Materials while the thread
// beside it on the same request might not be. Asking them to pick a head per
// line is asking the wrong person a question the item already answers.
//
// So the answer is stored once per CATEGORY, not per item. There are 15
// categories and 259 items, and the number of items only grows — mapping
// categories is a meeting, mapping items is a project that is never finished.
// An item may still override its category where it genuinely differs.
//
// ── THIS IS NOT TALLY'S ACCOUNTING ALLOCATION ───────────────────────────────
// Tally lets a stock item name the ledger a voucher POSTS to. This does not,
// deliberately: posting is bookkeeping and stays exactly as it is. This names
// the budget head the spend is COUNTED AGAINST, which is a control question,
// not an accounting one. The two are the same for stationery and different for
// fabric — fabric posts to stock and is budgeted as purchase — and conflating
// them is how a budget layer starts quietly rewriting the books.

const mongoose = require("mongoose");

const itemCategoryBudgetSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Company",
      required: true,
      index: true,
    },

    /* The spelling as finance typed it. DISPLAY ONLY — never matched on.
       Kept because "Fabric" is what belongs on a screen and "fabric" is not. */
    category: { type: String, required: true, trim: true },

    /* ── THE IDENTITY ─────────────────────────────────────────────────────
       What this row is actually keyed by. Produced only by
       `itemBudgetHead.service.categoryKeyOf` — lower-cased, trimmed, internal
       whitespace collapsed.

       Without it "Fabric", "fabric" and "Fabric " were three rows, and a
       mapping set on one spelling silently failed to apply to items carrying
       another: a budget head that existed, was configured, and did nothing. */
    categoryKey: { type: String, required: true, trim: true, index: true },

    /* The head this category's spend counts against. Nullable on purpose: a
       row that exists with no head is finance saying "seen it, not decided",
       which is different from a category nobody has looked at yet. */
    budgetLedgerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Ledger",
      default: null,
    },
    /* A snapshot for display. Never read as the authority — a head renamed
       next year must not silently restate what was mapped. */
    budgetLedgerName: { type: String, trim: true, default: "" },

    note: { type: String, trim: true, default: "" },

    setBy: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_User" },
    setByName: { type: String, trim: true, default: "" },
    setAt: { type: Date },
  },
  { timestamps: true },
);

/* One mapping per category per company — enforced on the NORMALISED key, so
   the database refuses the duplicate rather than relying on every write path
   remembering to check. The old index was on `category`, which let three
   spellings of one category coexist.

   `category` itself is deliberately NOT unique: two rows can never share a
   key, so they can never share a meaningful spelling either, and constraining
   the display label as well would refuse a legitimate re-spelling. */
itemCategoryBudgetSchema.index({ companyId: 1, categoryKey: 1 }, { unique: true });

module.exports =
  mongoose.models.Acc_ItemCategoryBudget ||
  mongoose.model("Acc_ItemCategoryBudget", itemCategoryBudgetSchema);
