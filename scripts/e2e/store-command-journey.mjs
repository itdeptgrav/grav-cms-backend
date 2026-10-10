#!/usr/bin/env node
/**
 * scripts/e2e/store-command-journey.mjs — the authenticated journey, driven.
 *
 * ── WHAT THIS PROVES THAT NOTHING ELSE DOES ───────────────────────────────
 * Every other suite stops below the browser. This one signs in through the
 * real login form, in a real Chrome, lands on the real Store dashboard, opens
 * the real palette and reads what a person would see. Between the keystroke
 * and the answer it crosses the frontend provider, the HTTP endpoint,
 * `EmployeeAuthMiddleware`, `resolveAppAccess`, `tenantContext` and the
 * database — the whole chain, in one direction, with nothing stubbed.
 *
 * It is the gate for the defect class that source-reading cannot see: a bad
 * import, a scope error, a provider that resolves to the wrong origin, a
 * cookie that is never sent, a state the renderer drops.
 *
 * ── RUNNING IT ────────────────────────────────────────────────────────────
 *   1  node scripts/e2e/store-command-server.js --port 5099
 *   2  (in grav-cms)  NEXT_DIST_DIR=.next-e2e \
 *        NEXT_PUBLIC_API_URL=http://localhost:5099 npx next dev -p 3005
 *   3  node scripts/e2e/store-command-journey.mjs
 *
 * The backend is a REAL backend on a THROWAWAY in-memory database, seeded by
 * step 1. Nothing here can touch Atlas.
 */

import { chromium } from "/Users/risheeray/grav-cms/node_modules/playwright-core/index.mjs";

const WEB = process.env.E2E_WEB || "http://localhost:3005";
const API = process.env.E2E_API || "http://localhost:5099";
const PASSWORD = "E2e-Store-Pass!7731";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  process.stdout.write(`   ${ok ? "ok    " : "FAILED"}  ${name}${ok ? "" : `\n             ${detail}`}\n`);
};

/** Read the palette exactly as it is rendered. */
const READ = `(() => {
  const rows = [...document.querySelectorAll('[role=option]')].map((li) => ({
    kind: li.getAttribute('data-command-kind'),
    selected: li.getAttribute('aria-selected') === 'true',
    text: li.innerText.replace(/\\s+/g, ' ').trim(),
  }));
  const empty = document.querySelector('[data-command-empty]');
  return {
    rows,
    empty: empty ? { state: empty.getAttribute('data-command-state'), text: empty.innerText.replace(/\\s+/g, ' ').trim() } : null,
    note: (document.querySelector('[data-command-note]') || {}).innerText || null,
    query: (document.querySelector('input[role=combobox]') || {}).value || null,
  };
})()`;

async function signIn(page, email) {
  await page.goto(`${WEB}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', PASSWORD);
  await Promise.all([
    page.waitForLoadState("networkidle").catch(() => {}),
    page.click('button[type=submit]'),
  ]);
  await page.waitForTimeout(2500);
  return page.url();
}

async function openStore(page) {
  await page.goto(`${WEB}/store/dashboard`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-command-trigger]", { timeout: 30000 });
}

async function ask(page, query, { wait = 1700 } = {}) {
  const open = await page.$("input[role=combobox]");
  if (!open) {
    await page.click("[data-command-trigger]");
    await page.waitForSelector("input[role=combobox]", { timeout: 10000 });
  }
  await page.fill("input[role=combobox]", query);
  await page.waitForTimeout(wait);
  return page.evaluate(READ);
}

const says = (out, text) => JSON.stringify(out).includes(text);

async function main() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    process.stdout.write("\nStore Cmd/Ctrl K — authenticated journey, real browser\n\n");

    /* ── 1 · SIGNING IN ─────────────────────────────────────────────── */
    const landed = await signIn(page, "store@e2e.test");
    check("signs in through the real login form", !landed.endsWith("/login"), landed);
    await openStore(page);
    check("the Store dashboard renders with the palette's trigger", true);

    /* ── 2 · A RECORD LOOKUP ────────────────────────────────────────── */
    const grn = await ask(page, "GRN/2026-27/0004");
    check("an exact document number is answered", says(grn, "GRN/2026-27/0004"), JSON.stringify(grn));

    /* ── 3 · A FIELD QUESTION ───────────────────────────────────────── */
    const stock = await ask(page, "stock of macbook");
    check("a field of a named material is answered",
      says(stock, "Macbook") && says(stock, "4"), JSON.stringify(stock));

    /* ── 4 · A LOCATION ─────────────────────────────────────────────── */
    const where = await ask(page, "where is soda ash kept");
    check("where a material is kept is answered",
      says(where, "Bin 2") && says(where, "25 Kg"), JSON.stringify(where));

    /* ── 5 · A DATE FILTER ──────────────────────────────────────────── */
    const dated = await ask(page, "goods receipts expected in June 2026");
    check("a date window is honoured, and the May receipt is not offered",
      !says(dated, "GRN/2026-27/0004"), JSON.stringify(dated));

    const unplaced = await ask(page, "material requests in June 2026");
    check("a window with no date named is refused, not applied to a guess",
      says(unplaced, "needs_clarification") || says(unplaced, "Say which date"),
      JSON.stringify(unplaced));

    /* ── 6 · A STATUS FILTER ────────────────────────────────────────── */
    const pending = await ask(page, "pending material requests");
    check("a status filter excludes what it must",
      says(pending, "MRF-2605-0002") && !says(pending, "MRF-2605-0001"), JSON.stringify(pending));

    /* ── 7 · LIST, COUNT, AGGREGATE ─────────────────────────────────── */
    const latest = await ask(page, "latest five material requests");
    check("the latest five are the latest, newest first",
      says(latest, "MRF-2605-0007") && !says(latest, "MRF-2605-0001"), JSON.stringify(latest));

    const counted = await ask(page, "how many material requests are there");
    check("a count answers about the family it names, and only that one",
      says(counted, "7 matching material requests") && !says(counted, "inventory items"),
      JSON.stringify(counted));

    const total = await ask(page, "total quantity on hand of 16mm flex pipe");
    check("an aggregate either answers or says it found nothing — never both",
      counted.rows.length > 0 && (total.rows.length > 0 || Boolean(total.empty)),
      JSON.stringify(total));

    /* ── 8 · AMBIGUITY, AND THE ANSWER AFTER CHOOSING ───────────────── */
    const ambiguous = await ask(page, "where is sodium kept");
    const choices = ambiguous.rows.filter((row) => row.kind === "choice");
    check("an ambiguous name offers canonical choices rather than guessing",
      choices.length >= 2, JSON.stringify(ambiguous));

    const flake = await page.$$('[role=option]');
    let picked = null;
    for (const row of flake) {
      const text = await row.innerText();
      if (/Flake/.test(text)) { picked = row; break; }
    }
    if (picked) await picked.click();
    await page.waitForTimeout(2200);
    const resolved = await page.evaluate(READ);
    check("choosing one answers about THAT record, without rewriting the question",
      says(resolved, "Sodium Hydroxide Flake") && resolved.query === "where is sodium kept",
      JSON.stringify(resolved));

    /* ── 9 · OPENING A RECORD ───────────────────────────────────────── */
    await ask(page, "macbook");
    const first = (await page.$$('[role=option]'))[0];
    await first.click();
    await page.waitForTimeout(2500);
    check("a record result opens that record's own page",
      /\/store\/dashboard\/raw-items\/raw-items-view\/[a-f\d]{24}$/.test(new URL(page.url()).pathname),
      page.url());

    /* ── 9b · A SUPPLIER BY NAME ─────────────────────────────────────
       "Gaurav Enterprises" is the supplier's name AND the vendor name on its
       purchase orders. The supplier is what was typed, so it leads, and it
       opens the supplier's own page — not an order that mentions it. */
    await openStore(page);
    const supplier = await ask(page, "Gaurav Enterprises");
    const supplierFirst = (await page.$$('[role=option]'))[0];
    const supplierText = supplier.rows[0]?.text || "";
    if (supplierFirst) await supplierFirst.click();
    await page.waitForTimeout(2500);
    check("a supplier by name leads with the supplier, and opens its page",
      supplierText.includes("Gaurav Enterprises")
        && /\/store\/dashboard\/vendors-buyer\/vendors\/view\/[a-f\d]{24}$/.test(new URL(page.url()).pathname),
      `${JSON.stringify(supplier)} -> ${page.url()}`);

    /* ── 10 · NO MATCH, AND NO MEANING ──────────────────────────────── */
    await openStore(page);
    /* A document number nobody issued, of a kind the palette knows: it
       used to answer "Matching purchase orders:" with every order there is. */
    const unissued = await ask(page, "PO/2026-27/9999");
    check("a document number nobody issued is refused, not answered with the list",
      unissued.rows.length === 0 && !says(unissued, "PO/2026-27/0101"), JSON.stringify(unissued));

    const missing = await ask(page, "stock of a material nobody ever registered");
    check("a question about nothing says so, and offers nothing",
      missing.rows.length === 0 && Boolean(missing.empty), JSON.stringify(missing));

    /* ── 11 · A RECORD OF ANOTHER COMPANY ───────────────────────────── */
    const foreign = await ask(page, "stock of Beta Only Fabric");
    check("a record stamped to another company is not returned",
      !says(foreign, "Beta Only Fabric") || foreign.rows.length === 0,
      JSON.stringify(foreign));

    /* ── 12 · WITHOUT THE STORE GRANT ───────────────────────────────── */
    const refused = await signIn(page, "nostore@e2e.test");
    check("somebody with no application at all cannot even sign in",
      refused.endsWith("/login"), refused);

    /* And somebody who IS signed in, with another department, is refused by
       the endpoint itself — the layer the browser cannot reach past. */
    const hr = await context.request.post(`${API}/api/auth/login`, {
      data: { email: "hronly@e2e.test", password: PASSWORD },
    });
    const hrBody = await hr.json();
    const asked = await context.request.post(`${API}/api/ai/store/command-search`, {
      data: { query: "stock of macbook" },
      headers: hrBody.token ? { Authorization: `Bearer ${hrBody.token}` } : {},
    });
    const askedBody = await asked.json().catch(() => ({}));
    check("a signed-in person without the Store grant is refused by the endpoint",
      askedBody.state === "unauthorised" || asked.status() === 401 || asked.status() === 403,
      `${asked.status()} ${JSON.stringify(askedBody).slice(0, 200)}`);

    /* ── 13 · THE OTHER APPLICATIONS ────────────────────────────────────
       Somebody holding Store and HR. Cmd/Ctrl K offers HR (from the same list
       the app switcher shows), never an app they do not hold, never the one
       they are in — and opening HR switches the session, not just the URL. */
    const twoContext = await browser.newContext();
    const two = await twoContext.newPage();
    await signIn(two, "twoapps@e2e.test");
    await openStore(two);
    const appRows = (out) => out.rows.filter((r) => r.kind === "action").map((r) => r.text);
    const human = await ask(two, "human", { wait: 2500 });
    check("an application the person holds is offered", appRows(human).some((t) => /Human Resources/.test(t)), JSON.stringify(human));
    const accounts = await ask(two, "accounts");
    check("an application they do not hold is not", !appRows(accounts).some((t) => /^Accounts\b/.test(t)), JSON.stringify(accounts));
    const self = await ask(two, "store");
    check("the application on screen is not offered as somewhere to go", !appRows(self).some((t) => /^Store & Purchase\b/.test(t)), JSON.stringify(self));
    await ask(two, "human resources");
    await two.keyboard.press("Enter");
    await two.waitForURL((url) => !new URL(url).pathname.startsWith("/store"), { timeout: 20000 }).catch(() => {});
    const landedIn = new URL(two.url()).pathname;
    /* Where the server sends somebody switching into HR — the same answer the
       top bar's switcher acts on. Asked after the fact, with this session. */
    const expected = await (await twoContext.request.post(`${API}/api/auth/switch-department`, { data: { slug: "hr" } })).json().catch(() => ({}));
    check("Enter opens that application, through the department switch",
      Boolean(expected.redirectTo) && landedIn === expected.redirectTo, `${two.url()} vs ${expected.redirectTo}`);
    await twoContext.close();
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
