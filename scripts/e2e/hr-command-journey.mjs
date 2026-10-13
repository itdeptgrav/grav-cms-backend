#!/usr/bin/env node
/**
 * scripts/e2e/hr-command-journey.mjs — HR's Cmd/Ctrl K, signed in, in a real
 * browser, on the SHARED palette.
 *
 * Same throwaway backend as the Store and books journeys
 * (scripts/e2e/store-command-server.js seeds HR too: two people called Ravi,
 * somebody who has left, and every private value planted). Two HR people sign
 * in through the real CMS login form: an editor and a viewer, so the role
 * gate is proven where it matters — in what the palette offers and answers.
 *
 *   node scripts/e2e/store-command-server.js --port 5099
 *   NEXT_DIST_DIR=.next-e2e NEXT_PUBLIC_API_URL=http://localhost:5099 npx next dev -p 3005   # in grav-cms
 *   node scripts/e2e/hr-command-journey.mjs
 */

import { chromium, request as http } from "/Users/risheeray/grav-cms/node_modules/playwright-core/index.mjs";

const WEB = process.env.E2E_WEB || "http://localhost:3005";
const API = process.env.E2E_API || "http://localhost:5099";
const PASSWORD = "E2e-Store-Pass!7731";
/* Values planted on the seeded records that must never reach a screen. */
const SECRETS = ["9876501234", "ravi.home@example.com", "999988887777", "123412341234", "ABCDE1234F",
  "fever, doctor note", "planted private note", "41000 planted", "12,34,567"];

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  process.stdout.write(`   ${ok ? "ok    " : "FAILED"}  ${name}${ok ? "" : `\n             ${detail}`}\n`);
};

const READ = `(() => ({
  rows: [...document.querySelectorAll('[role=option]')].map((li) => ({
    kind: li.getAttribute('data-command-kind'),
    text: li.innerText.replace(/\\s+/g, ' ').trim(),
    card: Boolean(li.querySelector('[data-command-card]')),
  })),
  empty: (document.querySelector('[data-command-empty]') || {}).innerText || null,
}))()`;
const says = (out, text) => JSON.stringify(out).includes(text);
const leaks = (out) => SECRETS.filter((s) => says(out, s));

async function signIn(page, email) {
  await page.goto(`${WEB}/login`, { waitUntil: "domcontentloaded" });
  await page.fill("input[type=email]", email);
  await page.fill("input[type=password]", PASSWORD);
  await Promise.all([page.waitForLoadState("networkidle").catch(() => {}), page.click("button[type=submit]")]);
  await page.waitForTimeout(2500);
  return page.url();
}

async function openHr(page) {
  await page.goto(`${WEB}/hr/dashboard`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-command-trigger]", { timeout: 30000 });
}

async function ask(page, query, { wait = 1800 } = {}) {
  if (!(await page.$("input[role=combobox]"))) {
    await page.click("[data-command-trigger]");
    await page.waitForSelector("input[role=combobox]", { timeout: 10000 });
  }
  await page.fill("input[role=combobox]", query);
  await page.waitForTimeout(wait);
  return page.evaluate(READ);
}

async function main() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const seen = [];
  try {
    process.stdout.write("\nHR Cmd/Ctrl K — authenticated journey, real browser, shared palette\n\n");

    /* ── 1 · AN HR EDITOR ─────────────────────────────────────────────────── */
    const context = await browser.newContext();
    const page = await context.newPage();
    const misses = [];
    page.on("request", (req) => { if (/hr\/command-search\/miss/.test(req.url())) misses.push(req.postData()); });
    const landed = await signIn(page, "hronly@e2e.test");
    check("signs in through the real CMS login form", !landed.endsWith("/login"), landed);
    await openHr(page);
    check("HR renders on the shared shell, with the shared search trigger", true);

    const code = await ask(page, "GR0067");
    seen.push(code);
    check("an employee code answers with that person's card", code.rows[0]?.card && says(code, "Ravi Kumar") && says(code, "Cutting") && says(code, "Tailor"), JSON.stringify(code));
    const ravi = await ask(page, "Ravi");
    seen.push(ravi);
    check("a first name offers both Ravis", says(ravi, "Ravi Kumar") && says(ravi, "Ravi Sharma"), JSON.stringify(ravi));

    const pending = await ask(page, "pending leave requests");
    seen.push(pending);
    check("pending leave requests: awaiting the manager or HR, not the approved one",
      says(pending, "Ravi Kumar — sick leave") && says(pending, "Ravi Sharma — privilege leave") && !says(pending, "Asha"), JSON.stringify(pending));
    const day = await ask(page, "was Ravi Kumar present on 3 Oct 2026");
    seen.push(day);
    check("one person's day, with their punches", says(day, "Ravi Kumar was present on 3 Oct 2026 (in 9:28 am"), JSON.stringify(day));
    const absent = await ask(page, "absent on 8 Oct 2026");
    seen.push(absent);
    check("who was absent — HR's correction of a day wins", says(absent, "Ravi Kumar") && !says(absent, "Asha"), JSON.stringify(absent));
    const balance = await ask(page, "leave balance of Ravi Kumar");
    seen.push(balance);
    check("a leave balance", says(balance, "CL 3 of 7 left"), JSON.stringify(balance));
    const jobs = await ask(page, "open jobs");
    seen.push(jobs);
    check("open jobs, and not the closed one", says(jobs, "Senior Tailor") && !says(jobs, "Accountant"), JSON.stringify(jobs));
    const payroll = await ask(page, "payroll September 2026");
    seen.push(payroll);
    check("a payroll run by status — never an amount", says(payroll, "September 2026 payroll") && says(payroll, "Approved"), JSON.stringify(payroll));
    const nobody = await ask(page, "leaves of Nobody Atall");
    seen.push(nobody);
    check("a person nobody is called answers nothing — never every leave",
      nobody.rows.filter((r) => r.kind !== "route" && r.kind !== "action").length === 0 && !says(nobody, "Ravi Kumar —"), JSON.stringify(nobody));

    const muster = await ask(page, "muster");
    check("a page by another name", says(muster, "Muster Roll"), JSON.stringify(muster));
    const create = await ask(page, "new employee");
    check("an editor is offered the new-employee form", says(create, "New employee"), JSON.stringify(create));

    await ask(page, "GR0067");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2500);
    check("Enter opens that person's own page", /\/hr\/dashboard\/employees\/[a-f\d]{24}$/.test(new URL(page.url()).pathname), page.url());

    await openHr(page);
    await ask(page, "appraisal cycle xyz");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1200);
    const note = misses.map((b) => { try { return JSON.parse(b); } catch { return null; } }).find(Boolean);
    check("an unanswered search sends only the words", note && note.query === "appraisal cycle xyz" && Object.keys(note).join(",") === "query", JSON.stringify(misses));

    const leaked = seen.flatMap(leaks);
    check("no private or protected value appeared in any answer", leaked.length === 0, leaked.join(", "));
    await context.close();

    /* ── 2 · AN HR VIEWER ─────────────────────────────────────────────────── */
    const viewerContext = await browser.newContext();
    const viewer = await viewerContext.newPage();
    await signIn(viewer, "hrviewer@e2e.test");
    await openHr(viewer);
    const viewerCreate = await ask(viewer, "new employee");
    check("a viewer is not offered a create form", !says(viewerCreate, "New employee"), JSON.stringify(viewerCreate));
    const viewerPay = await ask(viewer, "payroll September 2026");
    check("a viewer's role does not include payroll runs — and the palette says so",
      !says(viewerPay, "September 2026 payroll") && says(viewerPay, "does not include"), JSON.stringify(viewerPay));
    const viewerLeave = await ask(viewer, "pending leave requests");
    check("a viewer still reads leave", says(viewerLeave, "Ravi Kumar — sick leave"), JSON.stringify(viewerLeave));
    await viewerContext.close();

    /* ── 3 · THE DOOR ITSELF ──────────────────────────────────────────────── */
    const stranger = await http.newContext();
    const anonymous = await stranger.get(`${API}/api/hr/command-search?q=GR0067`);
    check("no session, no answer", [401, 403].includes(anonymous.status()) && !(await anonymous.text()).includes("Ravi"), String(anonymous.status()));
    const storeLogin = await stranger.post(`${API}/api/auth/login`, { data: { email: "store@e2e.test", password: PASSWORD } });
    const storeToken = (await storeLogin.json()).token;
    const storeOnly = await stranger.get(`${API}/api/hr/command-search?q=GR0067`, { headers: { Authorization: `Bearer ${storeToken}` } });
    check("a signed-in Store person without HR is refused by HR's own guard",
      storeOnly.status() === 403 && !(await storeOnly.text()).includes("Ravi"), `${storeOnly.status()}`);
    await stranger.dispose();
  } finally {
    await browser.close();
  }

  const failed = results.filter((row) => !row.ok);
  process.stdout.write(`\n   ${results.length - failed.length} of ${results.length} steps passed.\n\n`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
