"use strict";
// services/pdfRender.service.js
//
// HTML → PDF, server side, using a headless Chromium kept warm between
// requests.
//
// ── Why the server renders this at all ────────────────────────────────────
// The payslip has three consumers — Android, iOS and the browser — and until
// now each produced the PDF itself. That gave three different results from one
// template: Android and iOS through expo-print, the browser through its own
// print dialog (which the user has to click through, and which stamps the page
// with the date and the URL unless the page fights it off). And on the web
// there was no way to produce a real file at all: expo-print's web build of
// printToFileAsync is literally `window.print()`.
//
// One renderer here fixes all of that at once. Every client gets the same
// bytes, downloads with one tap, and nothing is left to the browser's UI.
//
// ── Why Chromium and not pdfkit ───────────────────────────────────────────
// pdfkit is already a dependency and could draw this layout. It would also be
// a SECOND implementation of a document that took real effort to make
// identical across two repos — the exact drift this codebase has been pulling
// out. Chromium renders the one HTML template we already have, so the PDF is
// the template by construction rather than by resemblance.
//
// The cost is real and worth stating: a Chromium process. It is launched once
// and reused, so only the first payslip of a server's life pays the ~1s
// startup. Set PUPPETEER_EXECUTABLE_PATH to use a system Chrome instead of the
// bundled one — smaller deploys, and what you want in a container that already
// has Chrome.

const puppeteer = require("puppeteer");

let browserPromise = null;

/**
 * The shared browser.
 *
 * Held as the PROMISE, not the resolved browser, so that concurrent first
 * requests await the same launch instead of each starting their own Chromium —
 * which on a small box is how you turn one payslip into an out-of-memory kill.
 */
/**
 * Thrown when Chromium itself cannot run.
 *
 * Distinct from "the template broke" or "the data was wrong", because the
 * caller can do something about this one and nothing about the others: the
 * clients all carry the same template and can render it themselves. Without a
 * distinguishable error every cause collapsed into one 500, the app treated it
 * as a genuine failure, and an employee simply could not get their payslip.
 */
class RendererUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "RendererUnavailableError";
    this.rendererUnavailable = true;
  }
}

function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({
        headless: "new",
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        // --no-sandbox is required to run as root inside a container, which is
        // how this deploys. --disable-dev-shm-usage because the default /dev/shm
        // in Docker is 64MB and Chromium crashes on it under load.
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
        ],
      })
      .catch((err) => {
        // Do not cache a failed launch — the next request should try again
        // rather than inherit a rejected promise forever.
        browserPromise = null;
        /* A launch failure is an environment fact, not a bug in this request:
           Chromium is missing, or its shared libraries are, or the box is out
           of memory. Named as such so the route can answer usefully instead of
           returning an unexplained 500. */
        throw new RendererUnavailableError(
          `Headless Chromium could not start: ${err.message}`,
        );
      });
  }
  return browserPromise;
}

/** Drop the cached browser if Chromium died under us. */
async function resetBrowser() {
  const p = browserPromise;
  browserPromise = null;
  try {
    const b = await p;
    await b.close();
  } catch {}
}

/**
 * Render a complete HTML document to a PDF buffer.
 *
 * @param {string} html          A full HTML document.
 * @param {object} [opts]
 * @param {string} [opts.format] Paper size. Default A4.
 * @returns {Promise<Buffer>}
 */
async function htmlToPdf(html, opts = {}) {
  const attempt = async () => {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      // `domcontentloaded` rather than `networkidle0`: the template embeds its
      // logo as a data URI and pulls only a webfont, so there is no network to
      // go idle, and networkidle0 would just sit out its timeout.
      await page.setContent(html, {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });

      // The document is set in Montserrat. Rendering before the face arrives
      // silently typesets the PDF in the fallback — the kind of difference
      // nobody notices until two payslips are held side by side. Capped, so a
      // blocked font CDN costs three seconds rather than the request.
      await page
        .evaluate(
          () =>
            new Promise((resolve) => {
              const done = () => resolve();
              if (document.fonts && document.fonts.ready) {
                document.fonts.ready.then(done);
              } else {
                done();
              }
              setTimeout(done, 3000);
            }),
        )
        .catch(() => {});

      return await page.pdf({
        format: opts.format || "A4",
        printBackground: true,
        // Zero, deliberately. The template owns its own margin as padding so
        // that @page can be margin:0 — which is what stops a browser printing
        // its header and footer. Applying a margin here as well would inset it
        // twice.
        margin: { top: "0", right: "0", bottom: "0", left: "0" },
        preferCSSPageSize: true,
      });
    } finally {
      await page.close().catch(() => {});
    }
  };

  try {
    return await attempt();
  } catch (err) {
    // A browser that has been killed (OOM, a container restart) surfaces as a
    // protocol or connection error. Relaunch once and retry — the alternative
    // is every payslip failing until someone restarts the server.
    if (/Protocol error|Target closed|Connection closed|Session closed/i.test(err.message)) {
      await resetBrowser();
      return attempt();
    }
    throw err;
  }
}

/** Close the shared browser. Called on shutdown so Chromium is not orphaned. */
async function shutdown() {
  if (browserPromise) await resetBrowser();
}

module.exports = { htmlToPdf, RendererUnavailableError, shutdown };
