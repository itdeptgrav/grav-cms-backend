// services/salaryFormula.js
//
// The one place a salary is calculated.
//
// ── WHY IT MOVED HERE ───────────────────────────────────────────────────────
// This arithmetic existed twice, character for character: once in
// routes/HrRoutes/Employee-Section.js (because findByIdAndUpdate does not fire
// the model hook) and once in the Employee pre-save hook. Two copies of a
// formula is two formulas, and the settings screen makes that concrete — a
// rule the company edits has to reach every path that computes a salary, and
// it cannot do that while there are two of them. Both callers now call this.
//
// ── EDLI AND ADMIN CHARGES ARE CAPPED ON THE WAGE, NOT ON THE RESULT ────────
// The old code read `Math.min(basic * 0.5%, edliCapAmount)` with
// edliCapAmount = 15000. That compares a ~₹200 contribution against ₹15,000,
// so the cap never bound and a basic of ₹40,000 produced ₹200 of EDLI. The
// ₹15,000 was never a cap on the money — the field's own comment called it a
// wage ceiling — so it is applied to the wage now:
//
//     EDLI  = round(min(basic, 15,000) x 0.5%)  =  ₹75 at and above ₹15,000
//     Admin = round(min(basic, 15,000) x 0.5%)  =  ₹75 at and above ₹15,000
//
// Admin charges had no ceiling at all before, so they grew without limit.
//
// A hard rupee maximum sits on top of the ceiling and is configurable too
// (`edliMaxAmount` / `adminMaxAmount`, both ₹75). Belt and braces on purpose:
// the ceiling is the statutory mechanism, the maximum is what the company
// actually said it wants, and if someone edits the percentage the maximum
// still holds the line where they put it.
//
// ── CTC INCLUDES THEM ───────────────────────────────────────────────────────
// EDLI and admin charges are money the EMPLOYER pays on top of gross. They
// were computed, shown, and then left out of employerCost, so every CTC the
// company quoted was short by exactly those two amounts.
//
// ── OVERRIDES WIN ───────────────────────────────────────────────────────────
// An HR override on EPF, EDLI or admin charges is a deliberate statement about
// one person and is never recalculated — which is also what makes the settings
// resync safe to run over everybody.

"use strict";

/** Every knob, with the statutory default it falls back to. */
function knobs(cfg = {}) {
  return {
    basicPct: (cfg.basicPct ?? 50) / 100,
    hraPct: (cfg.hraPct ?? 50) / 100,
    eepfPct: (cfg.eepfPct ?? 12) / 100,
    epfCapAmount: cfg.epfCapAmount ?? 1800,
    edliPct: (cfg.edliPct ?? 0.5) / 100,
    /* The wage the percentage is charged on stops here. Historically stored as
       `edliCapAmount`; the name is kept so no existing document has to be
       migrated, and it is used the way its comment always described. */
    edliWageCeiling: cfg.edliCapAmount ?? 15000,
    edliMaxAmount: cfg.edliMaxAmount ?? 75,
    adminChargesPct: (cfg.adminChargesPct ?? 0.5) / 100,
    adminWageCeiling: cfg.adminWageCeiling ?? cfg.edliCapAmount ?? 15000,
    adminMaxAmount: cfg.adminMaxAmount ?? 75,
    esiWageLimit: cfg.esiWageLimit ?? 21000,
    eeEsicPct: (cfg.eeEsicPct ?? 0.75) / 100,
    erEsicPct: (cfg.erEsicPct ?? 3.25) / 100,
    foodAllowance: cfg.foodAllowance ?? 1600,
  };
}

/**
 * A salary object from a gross (or a stipend, for an intern).
 *
 * @param {object} s               the employee's salary input
 * @param {object} cfg             the SalaryConfig document, plain
 * @param {string} employmentType  "intern" takes the stipend branch
 * @returns {object} plain numbers — the caller encrypts before saving
 */
function computeSalary(s = {}, cfg = {}, employmentType = "") {
  /* An intern is paid a stipend and nothing else. Kept identical to the branch
     it replaces: an intern must never acquire an EPF deduction because HR
     edited them through a path that recalculated. */
  if (employmentType === "intern") {
    const stipend = Number(s.stipend) || 0;
    return {
      stipend,
      gross: 0, basic: 0, hra: 0, specialAllowance: 0,
      epf: 0, edli: 0, adminCharges: 0,
      epfOverride: false, edliOverride: false, adminOverride: false,
      eeesic: 0, erEsic: 0, foodAllowance: 0,
      employerCost: stipend,
      totalDeduction: 0,
      netSalary: stipend,
      allowances: 0, deductions: 0,
      otherDeduction: Number(s.otherDeduction) || 0,
    };
  }

  const k = knobs(cfg);

  const gross = Number(s.gross) || 0;
  const basic = Math.round(gross * k.basicPct);
  const hra = Math.round(gross * k.hraPct);

  /* EPF's cap IS on the money (₹1,800 = 12% of the ₹15,000 ceiling), which is
     why it reads differently from the two below. */
  const epf = s.epfOverride
    ? Number(s.epf) || 0
    : Math.round(Math.min(basic * k.eepfPct, k.epfCapAmount));

  const edli = s.edliOverride
    ? Number(s.edli) || 0
    : Math.min(Math.round(Math.min(basic, k.edliWageCeiling) * k.edliPct), k.edliMaxAmount);

  const adminCharges = s.adminOverride
    ? Number(s.adminCharges) || 0
    : Math.min(
        Math.round(Math.min(basic, k.adminWageCeiling) * k.adminChargesPct),
        k.adminMaxAmount,
      );

  // ESI is charged on Basic and applies while Basic is within the wage limit.
  const esiApplicable = basic <= k.esiWageLimit;
  const eeesic = esiApplicable ? Math.ceil(basic * k.eeEsicPct) : 0;
  const erEsic = esiApplicable ? Math.ceil(basic * k.erEsicPct) : 0;

  /* THE FOOD ALLOWANCE IS NET OF THE STANDING DEDUCTION.
     ------------------------------------------------------------------
     What HR enters as the monthly "other deduction" is what this employee has
     already taken against their allowance, so the company is only out the
     remainder. Enter 764 against a 1,600 allowance and the company funds 836 —
     and the CTC, which is what the company pays, has to say 836.

     BOTH figures are kept. `foodAllowanceFull` is the entitlement from the
     salary rules and never moves; `foodAllowance` is what it comes to for this
     employee. Payroll prorates the FULL figure by attendance and subtracts the
     deduction it actually charged that month — reading the net figure there
     would subtract the same 764 twice.

     Floored at zero: a deduction larger than the allowance leaves nothing, and
     a negative would make the employee look cheaper than they are. */
  const otherDeduction = Number(s.otherDeduction) || 0;
  const foodAllowanceFull = k.foodAllowance;
  const foodAllowance = Math.max(0, foodAllowanceFull - otherDeduction);

  /* CTC = everything the employer pays: gross, both PF-side employer costs,
     employer ESI, and what is left of the food allowance. */
  const employerCost = gross + epf + edli + adminCharges + erEsic + foodAllowance;

  // What comes off the employee: their own PF and their own ESI.
  const totalDeduction = epf + eeesic;
  const netSalary = Math.max(gross - totalDeduction, 0);

  return {
    gross,
    basic,
    hra,
    epf,
    edli,
    adminCharges,
    epfOverride: s.epfOverride || false,
    edliOverride: s.edliOverride || false,
    adminOverride: s.adminOverride || false,
    eeesic,
    erEsic,
    foodAllowance,
    foodAllowanceFull,
    employerCost,
    totalDeduction,
    netSalary,
    allowances: hra,
    deductions: totalDeduction,
    /* Zeroed rather than omitted: the caller replaces the whole salary object,
       so an intern promoted to staff would otherwise keep a stipend beside
       their new gross. */
    stipend: 0,
    // HR's input, and it survives a change of employment type.
    otherDeduction: Number(s.otherDeduction) || 0,
  };
}

/**
 * EDLI and admin charges for a given Basic.
 *
 * Both are EMPLOYER costs on the PF side, charged on min(basic, ceiling) and
 * then held at a hard rupee maximum. Payroll needs the same two numbers the
 * employee record carries, and computing them from the same place is what
 * stops a payroll run disagreeing with the contract it is paying against.
 *
 * Interns have neither, so pass basic = 0 and both come back 0.
 */
function employerPfCosts(basic, cfg = {}) {
  const k = knobs(cfg);
  const b = Number(basic) || 0;
  return {
    edli: Math.min(Math.round(Math.min(b, k.edliWageCeiling) * k.edliPct), k.edliMaxAmount),
    adminCharges: Math.min(
      Math.round(Math.min(b, k.adminWageCeiling) * k.adminChargesPct),
      k.adminMaxAmount,
    ),
  };
}

module.exports = { computeSalary, knobs, employerPfCosts };
