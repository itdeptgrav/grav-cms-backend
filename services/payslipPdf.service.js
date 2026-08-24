"use strict";
// services/payslipPdf.service.js
//
// The payslip, as a PDF, from the one template.
//
// lib/payslipTemplate.mjs is byte-identical to App/src/lib/payslipTemplate.js
// and grav-cms/lib/payslipTemplate.js — only the extension differs, because
// this package is CommonJS and .mjs is what lets `import()` load it as the ES
// module it is. The employee app's drift check (App/scripts/check-payslip-
// template.js) compares content across all three, so the extension does not
// let them diverge.

const { htmlToPdf } = require("./pdfRender.service");

// The template is an ES module in a CommonJS package, so it can only be
// reached through dynamic import — which is async, and which we do not want to
// repeat per request. Cached as the promise so concurrent first requests share
// one load.
let templatePromise = null;
function loadTemplate() {
  if (!templatePromise) {
    templatePromise = import("../lib/payslipTemplate.mjs").catch((err) => {
      templatePromise = null;
      throw err;
    });
  }
  return templatePromise;
}

/**
 * A filename an employee will recognise in their Downloads folder.
 *
 * "Payslip-GR0067-July-2026.pdf" rather than a UUID or "document.pdf": these
 * accumulate, and a year later the difference is whether they can find last
 * March's without opening six files.
 */
function payslipFileName(payload) {
  const emp = payload?.employee || {};
  const who = String(emp.empNo || emp.name || "payslip")
    .replace(/[^\w-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const when = String(payload?.period?.label || "")
    .replace(/[^\w]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ["Payslip", who, when].filter(Boolean).join("-") + ".pdf";
}

/** Render a payslip payload to PDF bytes. */
async function renderPayslipPdf(payload) {
  const { renderPayslipHtml } = await loadTemplate();
  return htmlToPdf(renderPayslipHtml(payload));
}

/**
 * Render and send, with the headers that make a browser save rather than
 * display it.
 *
 * Content-Disposition: attachment is the whole point of this endpoint — it is
 * what turns "open a print dialog and click through it" into "a file appears
 * in Downloads", on every platform at once, with no client-side PDF library
 * and no print UI to fight.
 */
async function sendPayslipPdf(res, payload) {
  const pdf = await renderPayslipPdf(payload);
  const name = payslipFileName(payload);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    // The plain filename for old clients, filename* for anything with a
    // non-ASCII character in a name — which, with Indian employee names, is
    // not hypothetical.
    `attachment; filename="${name.replace(/[^\x20-\x7E]/g, "_")}"; ` +
      `filename*=UTF-8''${encodeURIComponent(name)}`,
  );
  res.setHeader("Content-Length", pdf.length);
  // A payslip is personal and final once payroll is run, but it is also not
  // something a shared cache should ever hold.
  res.setHeader("Cache-Control", "private, no-store");
  res.end(pdf);
}

module.exports = { renderPayslipPdf, sendPayslipPdf, payslipFileName };
