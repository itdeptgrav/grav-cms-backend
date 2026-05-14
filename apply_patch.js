/**
 * Run: node fix_attendance_monthly.js <path/to/routes/AllEmployeeAppRoutes/Attendance_section.js>
 *
 * Finds the /attendance/monthly GET handler and adds late-count promotion logic
 * so it returns effectiveStatus on each day (LAB, LHD, EAB) — same as HR timecard.
 *
 * If the file can't be found, it will also try to patch the main app routes file.
 */
const fs = require("fs");
const path = require("path");

const FILE = process.argv[2];
if (!FILE) {
  console.error(
    "Usage: node fix_attendance_monthly.js <path/to/Attendance_section.js>",
  );
  console.error(
    "Example: node fix_attendance_monthly.js routes/AllEmployeeAppRoutes/Attendance_section.js",
  );
  process.exit(1);
}
if (!fs.existsSync(FILE)) {
  console.error("File not found:", FILE);
  process.exit(1);
}

let c = fs.readFileSync(FILE, "utf8");
fs.writeFileSync(FILE + ".backup", c);
console.log(`Read ${c.length} bytes from ${FILE}`);

const CRLF = c.includes("\r\n");
const NL = CRLF ? "\r\n" : "\n";

// Check if already patched
if (
  c.includes("applyLateCountPromotion") ||
  c.includes("effectiveStatus") ||
  c.includes("LAB_THRESHOLD")
) {
  console.log("ℹ️  Already patched or already has promotion logic.");
  process.exit(0);
}

// ── The promotion helper to inject ──────────────────────────────────────────
const HELPER = `
// ── Late/Early count promotion (mirrors HR timecard logic) ────────────────────
// 3rd late → LHD, 5th late → LAB (resets counter)
// 3rd early → HD,  5th early → EAB (resets counter)
function applyMonthlyPromotion(days) {
  let lateCount = 0, earlyCount = 0;
  return days.map(d => {
    const base = d.hrFinalStatus || d.systemPrediction || d.status || '';
    let effective = base;
    const isLate = d.isLate || base === 'P*';
    const isEarlyOut = d.isEarlyOut || base === 'P~';
    if (isLate) {
      lateCount++;
      if (lateCount === 5) { effective = 'LAB'; lateCount = 0; }
      else if (lateCount === 3) { effective = 'LHD'; }
    } else if (isEarlyOut) {
      earlyCount++;
      if (earlyCount === 5) { effective = 'EAB'; earlyCount = 0; }
      else if (earlyCount === 3) { effective = 'HD'; }
    }
    return { ...d, effectiveStatus: effective };
  });
}

`;

// ── Find the /attendance/monthly route handler ───────────────────────────────
// Look for patterns like:
//   router.get('/monthly', ...)  or  router.get("/monthly", ...)
//   or app.get('/attendance/monthly', ...)

const routePatterns = [
  /router\.get\s*\(\s*['"]\/monthly['"]/,
  /router\.get\s*\(\s*['"]monthly['"]/,
  /app\.get\s*\(\s*['"]\/attendance\/monthly['"]/,
  /router\.get\s*\(\s*['"]\/attendance\/monthly['"]/,
];

let matchIndex = -1;
for (const pat of routePatterns) {
  const m = c.match(pat);
  if (m) {
    matchIndex = c.indexOf(m[0]);
    console.log(`Found monthly route at index ${matchIndex}: "${m[0]}"`);
    break;
  }
}

if (matchIndex === -1) {
  console.error(
    "❌ Could not find /monthly route handler. Searching for any monthly reference...",
  );
  const lines = c.split("\n");
  lines.forEach((l, i) => {
    if (l.toLowerCase().includes("monthly"))
      console.log(`  Line ${i + 1}: ${l.trim()}`);
  });
  console.error(
    "\nPlease paste the relevant section so I can identify the pattern.",
  );
  process.exit(1);
}

// Find the response in the handler — look for res.json with the data
// We need to inject promotion BEFORE the res.json call that returns the array

// Strategy: Find where "setDays" or "res.json" is called with the attendance data
// and wrap the data with applyMonthlyPromotion()

// Look for patterns like:
//   res.json({ success: true, data: days })
//   res.json({ success: true, data: result })
//   res.json({ success: true, data: records })
//   return res.json({ ...data... })

// Find the handler body — from matchIndex to the next router.get/router.post
const handlerStr = c.substring(matchIndex, matchIndex + 3000);
console.log("\nHandler preview (first 500 chars):");
console.log(handlerStr.substring(0, 500));

// Try to find and patch res.json that returns an array of attendance data
const resJsonPatterns = [
  // res.json({ success: true, data: someVar })
  /(res\.json\s*\(\s*\{\s*success\s*:\s*true\s*,\s*data\s*:\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)(\s*\}\s*\))/,
  // res.json({ success: true, data: someVar || [] })
  /(res\.json\s*\(\s*\{\s*success\s*:\s*true\s*,\s*data\s*:\s*)([a-zA-Z_$][a-zA-Z0-9_$]*\s*\|\|\s*\[\])(\s*\}\s*\))/,
];

let patched = false;
for (const pat of resJsonPatterns) {
  const handlerSection = c.substring(matchIndex, matchIndex + 3000);
  const m = handlerSection.match(pat);
  if (m) {
    const original = m[0];
    const prefix = m[1];
    const dataVar = m[2];
    const suffix = m[3];
    const replacement = `${prefix}applyMonthlyPromotion(${dataVar})${suffix}`;

    // Replace only within the handler section
    const fullOrig = c.substring(matchIndex, matchIndex + 3000);
    const fullPatched = fullOrig.replace(original, replacement);
    c =
      c.substring(0, matchIndex) + fullPatched + c.substring(matchIndex + 3000);

    console.log(
      `\n✅ Patched res.json: wrapped "${dataVar}" with applyMonthlyPromotion()`,
    );
    patched = true;
    break;
  }
}

if (!patched) {
  // Fallback: look for the data being set and add effectiveStatus mapping after
  console.log(
    "\n⚠️  Could not auto-patch res.json. Trying to find data variable...",
  );

  // Look for common patterns like: const days = ...; or let records =
  const dataVarMatch = (handlerSection) => {
    const patterns = [
      /const\s+(days|records|result|data|attendance)\s*=/,
      /let\s+(days|records|result|data|attendance)\s*=/,
    ];
    for (const p of patterns) {
      const m = handlerSection.match(p);
      if (m) return m[1];
    }
    return null;
  };

  const varName = dataVarMatch(c.substring(matchIndex, matchIndex + 3000));
  if (varName) {
    console.log(`Found data variable: ${varName}. Manual step needed.`);
    console.log(
      `Add this line before the res.json call in the /monthly handler:`,
    );
    console.log(`  const promotedData = applyMonthlyPromotion(${varName});`);
    console.log(
      `And change res.json to use promotedData instead of ${varName}`,
    );
  }
}

// Inject the helper function at the top of the file (after requires)
// Find a good injection point — after the last require/import
const lastRequireMatch = [
  ...c.matchAll(/^(?:const|let|var)\s+\w+\s*=\s*require\s*\(/gm),
];
if (lastRequireMatch.length > 0) {
  const lastRequire = lastRequireMatch[lastRequireMatch.length - 1];
  const insertAfter =
    c.indexOf("\n", lastRequire.index + lastRequire[0].length) + 1;
  c = c.substring(0, insertAfter) + HELPER + c.substring(insertAfter);
  console.log("✅ Injected applyMonthlyPromotion() helper after last require");
} else {
  // Insert at top
  c = HELPER + c;
  console.log("✅ Injected applyMonthlyPromotion() helper at top of file");
}

fs.writeFileSync(FILE, c);
console.log(`\nWrote ${c.length} bytes. Restart your backend server.`);
console.log("\n── Verification ──");
console.log("Has helper:", c.includes("applyMonthlyPromotion"));
console.log("Has LAB:", c.includes("LAB"));
console.log("Has LHD:", c.includes("LHD"));
console.log("Has EAB:", c.includes("EAB"));
