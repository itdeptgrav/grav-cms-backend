// models/CMS_Models/Costing/CostingPolicy.js
//
// Central Costing — Chunk 2. THE COMPANY'S OWN COSTING AND MARGIN RULES.
//
// ── WHY THIS IS NOT IN SALES ────────────────────────────────────────────────
// Roadmap decision 2, and it is a governance decision rather than a filing
// one: "Company costing and margin settings live in central CMS
// administration. Sales consumes approved outputs; it does not maintain
// costing policy." A minimum margin kept inside the Sales app is a minimum
// margin the people negotiating against it can change, which is not a floor.
//
// So: one row per company, editable only with `costing.policy.manage`, read
// through the same visibility rules as everything else in this domain, and
// COPIED into every version it is used to calculate — see `policySnapshot` on
// CostingVersion. Raising the target margin changes what the next costing
// recommends; it never rewrites what an earlier one said.
//
// ── WHY THE POLICY IS MUTABLE WHEN VERSIONS ARE NOT ─────────────────────────
// A policy is a standing instruction, not a record of an event. It is supposed
// to change. What must not change is any calculation already made under it,
// and that is guaranteed by the snapshot, not by freezing the policy — freezing
// it would mean a company could never revise its own margins.
// `revision` increments on every change so a snapshot can always be traced
// back to the exact rule set it copied.
"use strict";

const mongoose = require("mongoose");

const { SUPPORTED_CURRENCIES, DEFAULT_CURRENCY } = require("../../../services/centralCosting/money");
const { ROUNDING_MODE_KEYS } = require("../../../services/centralCosting/decimal");
const { BASIS_KEYS } = require("../../../services/centralCosting/engine");
const { decimalString } = require("./costingCalculation");

const costingPolicySchema = new mongoose.Schema(
  {
    /* Required, always from the resolved company context, never from a body. */
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Company",
      required: true,
    },

    /* ── MONEY CONVENTIONS ────────────────────────────────────────────────
       The currency every costing in this company is calculated in, and how
       its fractions are resolved. A version freezes both, so a company that
       switches currency produces new versions in the new one rather than
       restating history. */
    baseCurrency: {
      type: String, required: true, uppercase: true, trim: true,
      enum: SUPPORTED_CURRENCIES, default: DEFAULT_CURRENCY,
    },
    roundingMode: {
      type: String, required: true, enum: ROUNDING_MODE_KEYS, default: "HALF_UP",
    },
    /* The saleable step a price is rounded UP to — 100 paise means "whole
       rupees". Upward only: rounding a price down to a tidy number puts it
       below the margin floor the company just set, which turns a display
       convenience into a policy breach. */
    sellingPriceIncrementMinor: { type: Number, required: true, min: 1, default: 1 },

    /* ── OVERHEAD ─────────────────────────────────────────────────────────
       Optional, and absent is not zero: a company that has not decided its
       overhead basis has no overhead applied and its costings say so, rather
       than quietly costing at 0% and looking complete. */
    overheadBasis: { type: String, enum: BASIS_KEYS, default: undefined },
    overheadRatePercent: decimalString({ default: undefined }),

    /* ── IS INPUT GST RECOVERABLE FOR THIS COMPANY? ───────────────────────
       A quotation states its GST rate; it cannot state whether this company
       gets that GST back. That depends on the company's registration and what
       it is buying for, and it is the same answer on every material line — so
       it is a company setting rather than a decision retyped on each row.

       It is the difference between the tax being garment cost and not being
       garment cost, so there is no default. Until it is set, an assembled
       material line reports it as a missing decision owned by Finance rather
       than guessing either way: assuming recoverable under-costs every
       non-recoverable purchase, assuming the reverse over-costs the rest. */
    inputGstTreatment: {
      type: String,
      enum: ["RECOVERABLE", "NON_RECOVERABLE"],
      default: undefined,
    },

    /* ── WHAT AN OPERATION RATE ACTUALLY RESTS ON ─────────────────────────
       `services/operationCosting.js` turns a SAM into rupees as
       `average net salary / 12,480 minutes x SAM`. That 12,480 is 26 days x
       8 hours, and it is doing three unstated jobs at once:

         · it assumes every paid minute is a PRODUCTIVE minute — no line
           balancing loss, no changeover, no absence. Real efficiency is
           rarely above 70%, so an unadjusted rate under-costs labour by
           roughly a third;
         · it uses NET salary, so PF, ESI, gratuity, bonus and the rest of the
           employer's burden are missing entirely;
         · it says nothing about machine cost, so whether depreciation, power
           and maintenance are carried elsewhere or not at all is unknown.

       None of those can be guessed. A company that runs at 55% efficiency and
       one that runs at 85% have labour costs a third apart, and picking a
       "reasonable" default would put that difference into every quotation
       silently. So they are company settings, absent until somebody sets
       them — and while they are absent the operation rate is reported as
       PROVISIONAL rather than presented as a verified cost. */
    productiveMinutesPerMonth: {
      type: Number,
      /* The denominator the rate is actually divided by. Absent means the
         company has not stated how much of the paid month is productive. */
      validate: {
        validator: (v) => v === undefined || v === null || (Number.isFinite(v) && v > 0),
        message: "Productive minutes per month is a positive number.",
      },
    },
    /* Or, if the company thinks in efficiency rather than minutes. Either
       answers the question; neither is defaulted. */
    labourEfficiencyPercent: decimalString({ default: undefined }),
    /* PF, ESI, gratuity, bonus — as a percentage on top of net salary. */
    employerBurdenPercent: decimalString({ default: undefined }),
    /* Whether machine depreciation, power and maintenance are inside the
       operation rate, charged as overhead, or not costed at all. Three real
       answers; no default, because each produces a different garment cost. */
    machineBurdenTreatment: {
      type: String,
      enum: ["IN_OPERATION_RATE", "IN_OVERHEAD", "NOT_COSTED"],
      default: undefined,
    },

    /* ── FINANCING ────────────────────────────────────────────────────────
       The cost of money tied up in an order. A COMPANY-level rule, like
       overhead: the borrowing rate does not vary by garment, so putting it on
       individual costing rows would mean retyping one number on every one and
       having them disagree.

       Optional, and absent is not zero. A company that has not set a
       financing rate has no financing applied and its costings say so — a
       default of 0% would read as "this company borrows for nothing", which
       is a claim nobody made. */
    financingRatePercent: decimalString({ default: undefined }),
    /* Which subtotal it is charged on. No default for the same reason the
       overhead basis has none: a rate without a basis is not a rule. */
    financingBasis: { type: String, enum: BASIS_KEYS, default: undefined },

    /* ── CONTINGENCY ──────────────────────────────────────────────────────
       A deliberate allowance for what a pre-production estimate cannot know.
       Optional and absent-is-absent, for the same reason as the two above —
       and deliberately NOT defaulted to a "safe" few per cent, which would
       quietly pad every quotation the company issues. */
    contingencyRatePercent: decimalString({ default: undefined }),
    contingencyBasis: { type: String, enum: BASIS_KEYS, default: undefined },

    /* ── WHAT THE COMPANY CHARGES FOR ITS OWN DEVELOPMENT WORK ───────────
       Pattern development, marker development, sample development, screen or
       plate setup. Real one-time costs with no supplier behind them, because
       the company does the work itself — so there is no quotation to read and
       nothing else in this repository records them.

       ── WHY A TABLE AND NOT A RATE ──────────────────────────────────────
       Every other policy rule here is a PERCENTAGE of a subtotal. A pattern
       charge is a flat amount for a named piece of work, and there may be
       several with different amounts. One rate cannot express that.

       ── AND WHY EFFECTIVE-DATED ─────────────────────────────────────────
       A costing frozen in March must go on saying what the March charge was.
       Overhead gets that from the policy REVISION snapshotted onto the
       version; a charge that changes mid-year needs its own dates, because
       Finance publishing next quarter's pattern charge must not silently
       re-price a costing already approved against this quarter's.

       Empty by default and never seeded: a company that has configured none
       has none, and a costing that needs one is BLOCKED and names Finance.
       An invented "typical" amount would put money nobody agreed into every
       quotation the company issues. */
    developmentCharges: {
      type: [new mongoose.Schema({
        /* A stable key R&D's requirement points at. The LABEL may be edited;
           the key is what a stored requirement holds, so renaming a charge
           does not orphan every row that asked for it. */
        key: { type: String, required: true, trim: true, maxlength: 60 },
        label: { type: String, required: true, trim: true, maxlength: 200 },
        description: { type: String, trim: true, default: "", maxlength: 1000 },
        /* ── FIXED IS NOT THE SAME AS FLAT ────────────────────────────
           Both are one-time costs, added whole to the run and diluted across
           it — neither is ever multiplied by the garment quantity. What
           differs is whether the charge scales with something R&D counted.
           Pattern development is ₹10,000 for the run. Screen making is
           ₹2,000 A SCREEN, and a garment needing four is ₹8,000 — once.

           Without this, Finance had to publish a "four screens" charge (a
           rate that lies about what it is) or somebody had to type ₹8,000
           into the costing, which is what this family exists to stop. */
        calculation: {
          type: String,
          enum: ["FLAT_PER_RUN", "PER_REQUIREMENT_UNIT"],
          default: "FLAT_PER_RUN",
        },
        /* What one of it IS — Screen, Plate, Pattern. Only a per-unit charge
           has one; on a flat charge it would name a quantity nobody enters. */
        unit: { type: String, trim: true, maxlength: 60, default: undefined },

        /* ── THE RATE, OVER TIME ──────────────────────────────────────
           A charge KEY is permanent and its amount is not. This held one
           amount per key, so publishing October's rate REPLACED September's —
           and a September costing could no longer be recalculated at the
           figure it was actually costed at. An effective-dated table that
           cannot hold two periods is a table with one date on it.

           Periods are half-open, `[effectiveFrom, effectiveTo)`: a period
           ending on the 1st and one beginning on the 1st must not both apply
           to a costing dated the 1st. Validated as non-overlapping, with only
           the last left open-ended — see policy.service. */
        rates: {
          type: [new mongoose.Schema({
            /* Integer minor units. No floating-point money, for the reason
               the supplier registers give. */
            amountMinor: {
              type: Number,
              required: true,
              validate: {
                validator: (v) => Number.isSafeInteger(v) && v >= 0,
                message: "A development charge is a whole number of minor units, not negative.",
              },
            },
            /* The company's base currency, always: nothing here holds an
               exchange rate on a date, so another currency could only be
               converted by guessing. Refused on the way in. */
            currency: { type: String, trim: true, default: "INR" },
            effectiveFrom: { type: Date, required: true },
            effectiveTo: { type: Date, default: undefined },
          }, { _id: false })],
          default: undefined,
        },

        /* ── THE FLAT SHAPE, STILL READABLE ───────────────────────────
           What a charge written before rate periods existed carries. Kept on
           the schema rather than dropped, because dropping it would make
           every already-configured company's table vanish on read. It is
           adapted into a single rate period by `developmentCharges.adapt` —
           the same amount and the same window, in the shape the resolver can
           answer. Nothing writes these fields any more. */
        amountMinor: {
          type: Number,
          validate: {
            validator: (v) => v === undefined || v === null || (Number.isSafeInteger(v) && v >= 0),
            message: "A development charge is a whole number of minor units, not negative.",
          },
        },
        currency: { type: String, trim: true, default: undefined },
        basis: {
          type: String,
          enum: ["FIXED_PER_RUN"],
          default: undefined,
        },
        effectiveFrom: { type: Date },
        effectiveTo: { type: Date },
        /* Inactivation replaces deletion: a charge named on last quarter's
           costing must stay readable for ever. */
        active: { type: Boolean, default: true },
      }, { _id: false })],
      default: undefined,
    },

    /* ── THE MARGIN BAND ──────────────────────────────────────────────────
       MARGIN, not markup — price = cost / (1 - m). The three are a band, not
       three independent settings, and the ordering below is enforced in the
       service because a schema validator cannot see sibling fields reliably
       on a partial update. */
    /* ── RETAINED, AND NO LONGER REQUIRED ────────────────────────────────
       These were `required: true, default: "0"` — which is precisely how a
       company that had never opened the costing screen came to hold a band the
       ENGINE ACCEPTS. Every other retired field defaulted to absent and left a
       named gap; this one defaulted to a number and would have priced every
       garment at cost with nobody's name against the decision.

       The band is a Board policy now (`MARGIN_POLICY`). What is left here is
       history: kept so a version frozen under it stays explicable and so the
       Board has something to copy into a first draft. History is not required,
       and a company clearing what it no longer wants to display must be able
       to — so the requirement and the default both go. Nothing reads these
       into a calculation any more. */
    minimumMarginPercent: decimalString({ default: undefined }),
    targetMarginPercent: decimalString({ default: undefined }),
    preferredMarginPercent: decimalString({ default: undefined }),

    /* ── THE ESTIMATED EFFECTIVE INCOME-TAX RATE (Chunk 4B) ───────────────
       An ESTIMATE the company sets, used to show what a proposed price might
       leave after income tax. Optional, and absent is not zero: a company
       that has not set one gets "after-tax profit unavailable", never an
       after-tax figure equal to the pre-tax one — which would read as a
       tax-free business.

       It is NOT a statutory rate and NOT part of product cost. Income tax is
       charged on the company's profit for a period, across every product,
       other income, carried-forward losses and adjustments; putting it in
       cost would make a shirt cost more because an unrelated order lost
       money, and would then feed the margin policy. It is applied after the
       profit line and only to a positive one. */
    estimatedIncomeTaxRatePercent: decimalString({ default: undefined }),

    /* Declared and unused, honestly. Chunk 6 decides what crossing it
       requires; storing it now means an approval added later can be judged
       against the policy in force when the costing was made. */
    approvalThresholdMarginPercent: decimalString({ default: undefined }),

    /* Bumped on every change, so a version's snapshot can be traced to the
       exact rule set it copied. */
    revision: { type: Number, default: 1, min: 1 },

    updatedByActorId: { type: String, trim: true, default: "" },
    updatedByActorName: { type: String, trim: true, default: "" },
  },
  { timestamps: true, collection: "costing_policies" },
);

/* One policy per company. Scoped, never global: two companies both having a
   policy is the normal case, and a global unique index would make the second
   company's row a duplicate-key error. */
costingPolicySchema.index({ companyId: 1 }, { unique: true });

module.exports =
  mongoose.models.CostingPolicy || mongoose.model("CostingPolicy", costingPolicySchema);
