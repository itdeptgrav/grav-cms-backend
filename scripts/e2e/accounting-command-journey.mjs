#!/usr/bin/env node
/**
 * scripts/e2e/accounting-command-journey.mjs — the books' Cmd/Ctrl K, signed
 * in, in a real browser, on the SHARED palette.
 *
 * Same throwaway backend as the Store journey (scripts/e2e/store-command-server.js
 * seeds the books too: two organisations, each owning one company with
 * deliberately alike data). The person signs in through the real CMS login
 * form as an Accounts-department user whose accounting role is an Acc_User
 * (viewer) — the everyday "one person, one login" path, upgraded by the books
 * themselves into an organisation session.
 *
 *   node scripts/e2e/store-command-server.js --port 5099
 *   NEXT_DIST_DIR=.next-e2e NEXT_PUBLIC_API_URL=http://localhost:5099 npx next dev -p 3005   # in grav-cms
 *   E2E_OTHER_COMPANY=<books.companyB from the server's ready line> node scripts/e2e/accounting-command-journey.mjs
 */

import { chromium, request as http } from "/Users/risheeray/grav-cms/node_modules/playwright-core/index.mjs";

const WEB = process.env.E2E_WEB || "http://localhost:3005";
const API = process.env.E2E_API || "http://localhost:5099";
const PASSWORD = "E2e-Store-Pass!7731";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  process.stdout.write(`   ${ok ? "ok    " : "FAILED"}  ${name}${ok ? "" : `\n             ${detail}`}\n`);
};

/* What the palette shows, read from the shared markup every application uses. */
const READ = `(() => ({
  rows: [...document.querySelectorAll('[role=option]')].map((li) => ({
    kind: li.getAttribute('data-command-kind'),
    text: li.innerText.replace(/\\s+/g, ' ').trim(),
    card: Boolean(li.querySelector('[data-command-card]')),
  })),
  empty: (document.querySelector('[data-command-empty]') || {}).innerText || null,
  query: (document.querySelector('input[role=combobox]') || {}).value || null,
}))()`;
const says = (out, text) => JSON.stringify(out).includes(text);

async function signIn(page, email) {
  await page.goto(`${WEB}/login`, { waitUntil: "domcontentloaded" });
  await page.fill("input[type=email]", email);
  await page.fill("input[type=password]", PASSWORD);
  await Promise.all([
    page.waitForLoadState("networkidle").catch(() => {}),
    page.click("button[type=submit]"),
  ]);
  await page.waitForTimeout(2500);
  return page.url();
}

async function openBooks(page) {
  await page.goto(`${WEB}/accountant`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-command-trigger]", { timeout: 30000 });
  /* The books pick their company once their session is upgraded. */
  await page.waitForFunction(() => /GRAV Books A/.test(document.body.innerText), null, { timeout: 30000 });
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
  const context = await browser.newContext();
  const page = await context.newPage();
  const misses = [];
  page.on("request", (req) => { if (/command-search\/miss/.test(req.url())) misses.push(req.postData()); });

  try {
    process.stdout.write("\nAccounting Cmd/Ctrl K — authenticated journey, real browser, shared palette\n\n");

    /* ── 1 · SIGNING IN, AND THE ONE PALETTE ─────────────────────────────── */
    const landed = await signIn(page, "accounts@e2e.test");
    check("signs in through the real CMS login form", !landed.endsWith("/login"), landed);
    await openBooks(page);
    check("the books render on the shared shell, company selected, with the shared search trigger", true);
    const oldPill = await page.$("button[aria-keyshortcuts='Control+K Meta+K']");
    check("the books' old search pill is gone", !oldPill);

    /* ── 2 · A RECORD BY ITS NUMBER, THIS COMPANY'S ───────────────────────── */
    const inv = await ask(page, "INV/0012");
    check("an invoice number answers with that invoice's card",
      inv.rows[0]?.card && says(inv, "₹1,200") && says(inv, "Gaurav Enterprises"), JSON.stringify(inv));
    check("the other organisation's invoice with the same number is never shown", !says(inv, "9,999"), JSON.stringify(inv));

    /* ── 3 · QUESTIONS ─────────────────────────────────────────────────────── */
    const balance = await ask(page, "balance of Gaurav Enterprises");
    check("a balance, from posted vouchers only", says(balance, "₹700 Dr"), JSON.stringify(balance));
    const drafts = await ask(page, "draft sales vouchers");
    check("a status filter excludes what it must", says(drafts, "INV/0013") && !says(drafts, "INV/0012"), JSON.stringify(drafts));
    const total = await ask(page, "total sales in June 2026");
    check("a total counts posted vouchers and says so", says(total, "posted") && says(total, "₹1,200"), JSON.stringify(total));
    const nobody = await ask(page, "receipts from Nobody Traders");
    check("a party nobody has answers nothing — never every receipt",
      nobody.rows.filter((r) => r.kind !== "route").length === 0 && !says(nobody, "RCT/0001"), JSON.stringify(nobody));
    const fy = await ask(page, "how many sales vouchers this FY");
    check("periods accountants say are understood", says(fy, "dated this FY"), JSON.stringify(fy));

    /* ── 4 · PAGES, GATED ───────────────────────────────────────────────────── */
    const pl = await ask(page, "net profit");
    check("a report is found by another name", says(pl, "Profit & Loss"), JSON.stringify(pl));
    const create = await ask(page, "new receipt");
    check("a create form is not offered to a viewer", !says(create, "New receipt"), JSON.stringify(create));
    const team = await ask(page, "team");
    check("a page the person may not open is not offered (the old dialog leaked it)", !team.rows.some((r) => /^Team\b/.test(r.text)), JSON.stringify(team));

    /* ── 5 · OPENING A RECORD ──────────────────────────────────────────────── */
    await ask(page, "INV/0012");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2500);
    check("Enter opens that invoice's own page",
      /\/accountant\/invoices\/[a-f\d]{24}$/.test(new URL(page.url()).pathname), page.url());

    /* ── 6 · A SEARCH THAT FOUND NOTHING IS NOTED — THE WORDS ONLY ────────── */
    await openBooks(page);
    await ask(page, "stuff lying around");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1200);
    const note = misses.map((body) => { try { return JSON.parse(body); } catch { return null; } }).find(Boolean);
    check("an unanswered search sends only the words and the company",
      note && note.query === "stuff lying around" && Object.keys(note).sort().join(",") === "companyId,query", JSON.stringify(misses));

    /* ── 7 · THE DOOR ITSELF ──────────────────────────────────────────────── */
    const token = await page.evaluate(() => localStorage.getItem("acc_token"));
    const seed = await (await context.request.get(`${API}/api/accountant/tally/companies`, { headers: { Authorization: `Bearer ${token}` } })).json().catch(() => ({}));
    const companies = JSON.stringify(seed);
    check("the company list holds only this organisation's books", companies.includes("GRAV Books A") && !companies.includes("Other Books B"), companies.slice(0, 200));
    /* Company B is REAL — it exists and holds an INV/0012 — but belongs to
       another organisation. Its id comes from the server's ready line. */
    const otherCompany = process.env.E2E_OTHER_COMPANY;
    check("the other organisation's company id was supplied (E2E_OTHER_COMPANY)", /^[a-f\d]{24}$/.test(otherCompany || ""), String(otherCompany));
    const other = await context.request.get(`${API}/api/accountant/command-search?q=INV%2F0012&companyId=${otherCompany}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const otherBody = await other.text();
    check("another organisation's real company is refused by the endpoint",
      other.status() === 403 && !otherBody.includes("9,999"), `${other.status()} ${otherBody.slice(0, 160)}`);
    /* A fresh client: no cookies, no token, nothing carried from the browser. */
    const stranger = await http.newContext();
    const anonymous = await stranger.get(`${API}/api/accountant/command-search?q=INV%2F0012&companyId=${otherCompany}`);
    check("no session, no answer", anonymous.status() === 401, String(anonymous.status()));
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
