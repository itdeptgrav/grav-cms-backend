// verifyEpfCeiling.js
//
// The EPF wage ceiling is one number, and every surface that quotes an EPF
// figure reads it.
//
// Run:  node verifyEpfCeiling.js        (no database, no network, no writes)
//
// WHY THIS EXISTS
// The ceiling was not a setting. EPF was `ROUND(MIN(basic x 12%, 1800))` — a
// cap on the money, with the ₹15,000 wage ceiling living only in the fact that
// 12% of 15,000 is 1,800. Moving the company to a ₹25,000 ceiling meant editing
// that arithmetic in five places:
//
//     services/salaryFormula.js          the employee's stored salary
//     routes/HrRoutes/Payroll_section.js three times — run, bulk, recalculate
//     routes/HrRoutes/employeeImportExport.js  the formula written into the XLSX
//     app/.../EmployeeForm.js            the preview HR watches as they type
//
// Four of those are now one function. The fifth cannot be — it runs in the
// browser before anything is saved, and there is no shared package between the
// two repos — so it stays a mirror and verifySalaryParity.js checks it.
//
// This file asks the question the change was made for: move the ceiling, and
// does every surface move with it?

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { computeSalary, employeePf } = require("./services/salaryFormula");

let pass = 0;
let fail = 0;
const check = (n, ok, d = "") => {
  if (ok) {
    pass += 1;
    console.log(`  ok    ${n}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${n}${d ? ` -- ${d}` : ""}`);
  }
};
const head = (t) => console.log(`\n${t}`);

/* The statutory settings, and the same settings with the ceiling moved to
   ₹25,000. The cap moves with it — that is what the settings screen does when
   the two are in step, and leaving it at 1,800 would hold every payslip
   exactly where it was. */
const AT_15K = { epfWageCeiling: 15000, epfCapAmount: 1800, eepfPct: 12 };
const AT_25K = { epfWageCeiling: 25000, epfCapAmount: 3000, eepfPct: 12 };

/* Basics either side of both ceilings. 12,000 is below both, 20,000 sits
   between them — that is the one that tells the two configurations apart —
   and 40,000 is above both. */
const BASICS = [12000, 20000, 40000];

const expected = (basic, cfg) =>
  Math.min(
    Math.round(Math.min(basic, cfg.epfWageCeiling) * (cfg.eepfPct / 100)),
    cfg.epfCapAmount,
  );

// ── 1. the engine ───────────────────────────────────────────────────────────
head("the ceiling is a setting, not a constant");
check(
  "at ₹15,000 a ₹20,000 Basic still pays ₹1,800",
  employeePf(20000, AT_15K) === 1800,
  String(employeePf(20000, AT_15K)),
);
check(
  "at ₹25,000 the same Basic pays ₹2,400",
  employeePf(20000, AT_25K) === 2400,
  String(employeePf(20000, AT_25K)),
);
check(
  "and a ₹40,000 Basic goes ₹1,800 → ₹3,000",
  employeePf(40000, AT_15K) === 1800 && employeePf(40000, AT_25K) === 3000,
  `${employeePf(40000, AT_15K)} / ${employeePf(40000, AT_25K)}`,
);
check(
  "a Basic below both ceilings is untouched by the change",
  employeePf(12000, AT_15K) === 1440 && employeePf(12000, AT_25K) === 1440,
  `${employeePf(12000, AT_15K)} / ${employeePf(12000, AT_25K)}`,
);
check(
  "the rupee cap still binds when it is set below the ceiling",
  employeePf(40000, { epfWageCeiling: 25000, epfCapAmount: 1800, eepfPct: 12 }) === 1800,
);

// ── 2. the stored salary ────────────────────────────────────────────────────
head("the employee's stored salary uses it");
for (const cfg of [AT_15K, AT_25K]) {
  const label = `₹${cfg.epfWageCeiling / 1000}k ceiling`;
  const ok = BASICS.every((basic) => {
    // basicPct defaults to 50, so gross = basic x 2 puts Basic exactly there.
    const r = computeSalary({ gross: basic * 2 }, cfg);
    return r.basic === basic && r.epf === expected(basic, cfg);
  });
  check(`computeSalary agrees at every Basic (${label})`, ok);
}
check(
  "an EPF override is still never recalculated",
  computeSalary({ gross: 80000, epf: 999, epfOverride: true }, AT_25K).epf === 999,
);

// ── 3. payroll ──────────────────────────────────────────────────────────────
head("payroll reads the same function, not its own copy");
const PAYROLL = path.join(__dirname, "routes", "HrRoutes", "Payroll_section.js");
const payrollSrc = fs.readFileSync(PAYROLL, "utf8");
check(
  "payroll imports employeePf",
  /employeePf[\s\S]{0,60}require\("\.\.\/\.\.\/services\/salaryFormula"\)/.test(payrollSrc),
);
const copies = payrollSrc.match(/Math\.min\(\s*basicEarned\s*\*\s*eepfPct/g) || [];
check(
  "and has no EPF arithmetic of its own left",
  copies.length === 0,
  `${copies.length} copy/copies still spelled out`,
);
const callSites = payrollSrc.match(/employeePf\(basicEarned, salaryCfg\)/g) || [];
check(
  "all three payroll paths call it (run, bulk, recalculate)",
  callSites.length === 3,
  `${callSites.length} call site(s)`,
);
check(
  "no stale 1800 fallback is left in payroll",
  !/epfCapAmount \?\? 1800/.test(payrollSrc),
);

// ── 4. the XLSX the sheet is built from ─────────────────────────────────────
head("the Excel template writes the same rule into the cell");
const XLSX_SRC = fs.readFileSync(
  path.join(__dirname, "routes", "HrRoutes", "employeeImportExport.js"),
  "utf8",
);

/* Lift the knob block and the formula table out of the route and run them
   against a cfg, the way verifySalaryParity.js lifts calcSalary out of the
   form. Evaluating what the sheet will actually contain is the only way to
   know the sheet agrees; reading the source and nodding is not. */
const kStart = XLSX_SRC.indexOf("    const basicPct = (cfg.basicPct ?? 50) / 100;");
const fEnd = XLSX_SRC.indexOf("    });", XLSX_SRC.indexOf("const formulasFor = (R) =>"));
check("the formula table was found in the export route", kStart !== -1 && fEnd !== -1);

if (kStart !== -1 && fEnd !== -1) {
  const block = XLSX_SRC.slice(kStart, fEnd + "    });".length);
  const L = { gross: "C", basic: "D", hra: "E", epfEE: "F", esicEE: "G", totDed: "H",
    net: "I", epfER: "J", esicER: "K", edli: "M", admin: "N", food: "O", ctc: "P",
    otherDed: "Q" };

  /* `IF(<ref>="","",<expr>)` guards a blank row. With a real number in the
     cell the guard is false, so the sheet evaluates <expr>; strip it and
     evaluate that. */
  const unguard = (f) => {
    const m = f.match(/^IF\([A-Z]+\d+="","",([\s\S]*)\)$/);
    return m ? m[1] : f;
  };
  const evalExcel = (expr, basic) => {
    const js = expr
      .replace(new RegExp(`${L.basic}5`, "g"), String(basic))
      .replace(/\bMIN\(/g, "Math.min(")
      .replace(/\bMAX\(/g, "Math.max(")
      .replace(/\bROUND\(([^()]*(?:\([^()]*\)[^()]*)*),0\)/g, "Math.round($1)");
    return Function(`"use strict";return (${js});`)();
  };

  for (const cfg of [AT_15K, AT_25K]) {
    const sandbox = { cfg, L, formulasFor: null };
    vm.createContext(sandbox);
    vm.runInContext(`${block}; this.formulasFor = formulasFor;`, sandbox);
    const epfFormula = unguard(sandbox.formulasFor("5")[L.epfEE]);

    const label = `₹${cfg.epfWageCeiling / 1000}k ceiling`;
    const mismatches = BASICS.filter(
      (b) => evalExcel(epfFormula, b) !== expected(b, cfg),
    );
    check(
      `the sheet's EPF cell equals the server at every Basic (${label})`,
      mismatches.length === 0,
      mismatches
        .map((b) => `basic ${b}: sheet ${evalExcel(epfFormula, b)} vs server ${expected(b, cfg)}`)
        .join("; "),
    );
    if (cfg === AT_25K) {
      check(
        "and the ceiling reached the formula text itself",
        epfFormula.includes("25000"),
        epfFormula,
      );
    }
  }
}

// ── 5. the form HR watches ──────────────────────────────────────────────────
head("the employee form's preview uses it too");
const FORM = path.join(
  __dirname, "..", "grav-cms",
  "app", "hr", "dashboard", "employees", "new-employee", "components", "EmployeeForm.js",
);
if (!fs.existsSync(FORM)) {
  check("the employee form is where this expects it", false, FORM);
} else {
  const formSrc = fs.readFileSync(FORM, "utf8");
  check(
    "the form reads epfWageCeiling from the config",
    /epfWageCeiling = cfg\.epfWageCeiling \?\? 15000/.test(formSrc),
  );
  check(
    "and applies it before the rupee cap",
    /Math\.min\(\s*Math\.round\(Math\.min\(basic, epfWageCeiling\) \* eepfPct\),\s*epfCapAmount,?\s*\)/.test(
      formSrc,
    ),
  );
  check(
    "no bare `basic * eepfPct` against the cap is left",
    !/Math\.min\(basic \* eepfPct, epfCapAmount\)/.test(formSrc),
  );
}

// ── 6. the settings screen can actually save it ─────────────────────────────
head("the settings screen can reach it");
const EMP_ROUTE = fs.readFileSync(
  path.join(__dirname, "routes", "HrRoutes", "Employee-Section.js"), "utf8",
);
check(
  "epfWageCeiling is on the save allowlist",
  /"epfWageCeiling"/.test(EMP_ROUTE),
  "without this the field is dropped silently on save",
);
const MODEL = fs.readFileSync(
  path.join(__dirname, "models", "Accountant_model", "..", "Salaryconfig.js"), "utf8",
);
check("and the model has a field to store it", /epfWageCeiling:\s*\{/.test(MODEL));

const SETTINGS = path.join(
  __dirname, "..", "grav-cms",
  "app", "hr", "dashboard", "settings", "salary-config", "page.js",
);
if (!fs.existsSync(SETTINGS)) {
  check("the settings page is where this expects it", false, SETTINGS);
} else {
  const set = fs.readFileSync(SETTINGS, "utf8");
  check("the page offers an EPF Wage Ceiling row", /epfWageCeiling:\s*\{/.test(set));
  /* Lift the setState updater out of handleChange and run it, rather than
     matching the source and hoping. This is the rule that decides whether
     editing the ceiling does anything at all: leave the cap at ₹1,800 while
     the ceiling goes to ₹25,000 and the cap binds first, so the screen
     accepts the edit and every payslip carries on paying ₹1,800. */
  const anchor = set.indexOf("setConfig(prev => {", set.indexOf("const handleChange"));
  const braceStart = set.indexOf("{", anchor);
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < set.length; i += 1) {
    if (set[i] === "{") depth += 1;
    else if (set[i] === "}") {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  check("handleChange's updater was found on the settings page", anchor !== -1 && end !== -1);

  if (anchor !== -1 && end !== -1) {
    const body = set.slice(braceStart, end);
    const updater = Function("key", "val", "prev", `return ((prev) => ${body})(prev);`);
    const inStep = { epfWageCeiling: 15000, epfCapAmount: 1800, eepfPct: 12 };

    check(
      "raising the ceiling to ₹25,000 takes the cap to ₹3,000 with it",
      updater("epfWageCeiling", 25000, inStep).epfCapAmount === 3000,
      String(updater("epfWageCeiling", 25000, inStep).epfCapAmount),
    );
    check(
      "changing the percentage moves the cap too",
      updater("eepfPct", 10, inStep).epfCapAmount === 1500,
      String(updater("eepfPct", 10, inStep).epfCapAmount),
    );
    const custom = { epfWageCeiling: 15000, epfCapAmount: 1500, eepfPct: 12 };
    check(
      "but a cap somebody set deliberately is left alone",
      updater("epfWageCeiling", 25000, custom).epfCapAmount === 1500,
      String(updater("epfWageCeiling", 25000, custom).epfCapAmount),
    );
    check(
      "and an unrelated field does not touch it",
      updater("foodAllowance", 2000, inStep).epfCapAmount === 1800,
      String(updater("foodAllowance", 2000, inStep).epfCapAmount),
    );
  }
}

// \u2500\u2500 7. the appointment letter \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
head("the appointment letter states the company's ceiling, not the statute's");
const TPL = path.join(
  __dirname, "..", "grav-cms",
  "app", "hr", "dashboard", "documents", "appointmentTemplate.js",
);
if (!fs.existsSync(TPL)) {
  check("the appointment template is where this expects it", false, TPL);
} else {
  /* The module has no imports, so stripping `export` makes it evaluable as
     plain script. Annexure I and the PF sentence are then real output, not a
     regex's opinion of the source. */
  const tplSrc = fs.readFileSync(TPL, "utf8").replace(/^export /gm, "");
  const box = {};
  vm.createContext(box);
  vm.runInContext(
    `${tplSrc}; this.salaryBreakdown = salaryBreakdown; this.buildAppointmentLetter = buildAppointmentLetter;`,
    box,
  );

  const AT_25K_FULL = { epfWageCeiling: 25000, epfCapAmount: 3000, eepfPct: 12 };
  const bd = (rules) => box.salaryBreakdown(60000, { rules }); // Basic 30,000

  check(
    "with no rules supplied it still behaves exactly as before (\u20b91,800)",
    bd(undefined).epf === 1800,
    String(bd(undefined).epf),
  );
  check(
    "Annexure I follows the settings to \u20b93,000",
    bd(AT_25K_FULL).epf === 3000,
    String(bd(AT_25K_FULL).epf),
  );
  check(
    "and it agrees with the server for the same Basic",
    bd(AT_25K_FULL).epf === employeePf(30000, AT_25K_FULL) &&
      bd(undefined).epf === employeePf(30000, AT_15K),
  );

  const sentence = (rules) => {
    const { blocks } = box.buildAppointmentLetter(undefined, {
      grossSalary: 60000, fullName: "Harness", storedSalary: null, salaryRules: rules,
    });
    const flat = JSON.stringify(blocks);
    const i = flat.indexOf("Provident Fund will be calculated");
    return i === -1 ? "" : flat.slice(i, i + 120);
  };
  check(
    "the PF sentence in the letter body quotes \u20b915,000 by default",
    sentence(undefined).includes("INR 15,000/- at a rate of 12%"),
    sentence(undefined),
  );
  check(
    "and \u20b925,000 once the settings say so",
    sentence(AT_25K_FULL).includes("INR 25,000/- at a rate of 12%"),
    sentence(AT_25K_FULL),
  );
  check(
    "a changed percentage reaches the sentence too",
    sentence({ epfWageCeiling: 25000, eepfPct: 10 }).includes("at a rate of 10%"),
    sentence({ epfWageCeiling: 25000, eepfPct: 10 }),
  );

  /* The screen and the PDF must not diverge: both go through the same two
     functions, and both must be handed the same rules. */
  const KIT = fs.readFileSync(
    path.join(__dirname, "..", "grav-cms", "app", "hr", "dashboard", "documents", "documentKit.js"),
    "utf8",
  );
  check(
    "the documents screen fetches the salary rules",
    /useSalaryRules/.test(KIT) && /employees\/config\/salary/.test(KIT),
  );
  check(
    "and hands them to the preview and the PDF alike",
    /const v = appointmentView\(prefill \|\| \{\}, letterMeta\)/.test(KIT) &&
      /meta: letterMeta/.test(KIT),
  );
  check(
    "the preview re-renders when the rules arrive",
    /\}, \[kind, prefill, letterMeta\]\)/.test(KIT),
    "depending on `meta` would leave the preview on the statutory fallback",
  );
}

// ── 8. the payslip, and everybody already on the books ──────────────────────
head("the payslip and the existing employees follow");
const PAYLOAD = fs.readFileSync(
  path.join(__dirname, "services", "payslipPayload.service.js"), "utf8",
);
/* The payslip is a renderer. It reads the figure payroll stored and does no
   arithmetic of its own, which is why "the CMS shows one number and the
   payslip shows another" cannot happen through this path — and why it must
   stay that way. */
check(
  "the payslip prints the stored payroll figure, it does not recompute",
  /label: "Provident Fund", amount: d\.providentFund/.test(PAYLOAD) &&
    !/eepfPct|epfCapAmount|epfWageCeiling/.test(PAYLOAD),
  "the payslip has grown its own EPF arithmetic",
);

const RESYNC = fs.readFileSync(
  path.join(__dirname, "services", "salaryResync.js"), "utf8",
);
/* Changing the ceiling has to reach the people already on the books, not just
   the next person hired. Saving the settings runs this over everybody, and it
   goes through computeSalary — so it picks the new ceiling up for free. */
check(
  "the resync that runs on save goes through computeSalary",
  /require\("\.\/salaryFormula"\)/.test(RESYNC) && /computeSalary\(before, cfg/.test(RESYNC),
);
check(
  "and the settings route runs it unless explicitly told not to",
  /resyncAllSalaries/.test(EMP_ROUTE) && /req\.body\.resync !== false/.test(EMP_ROUTE),
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
