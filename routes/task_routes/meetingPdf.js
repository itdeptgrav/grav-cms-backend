"use strict";
// routes/task_routes/meetingPdf.js
//
// The meeting summary and transcript as PDF.
//
// ── Why HTML and Chromium, not pdfkit ────────────────────────────────────────
// `generateSummaryDocx.js` and `renderTranscriptDocx` already lay these two
// documents out for Word, and doing it a second time in pdfkit drawing
// commands would be two implementations of one document — the drift this
// codebase keeps pulling out. Neither can produce the other's format, so
// SOMETHING has to be written twice; HTML is the cheaper of the two to keep
// honest, because the layout is legible as a document rather than as
// coordinates, and `services/pdfRender.service.js` already keeps a warm
// Chromium for exactly this.
//
// The section order, the headings and the numbering deliberately match the
// .docx. Somebody who downloads both should get the same document twice, and
// the one thing worse than having no PDF is having a PDF that says something
// different.
//
// ── What is NOT here ─────────────────────────────────────────────────────────
// No fonts are fetched. A PDF that typesets in a fallback because a CDN was
// slow is worse than one that was always going to use system faces, and this
// is a document people read rather than a piece of brand.

/** HTML-escape. Every value below is somebody's speech or a model's output. */
function esc(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/** Seconds as M:SS, or H:MM:SS past an hour — the same clock the panel shows. */
function mmss(totalSecs) {
    const s = Math.max(0, Math.round(Number(totalSecs) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const two = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

/**
 * One stylesheet for both documents.
 *
 * `@page` carries the margins so Chromium does not also apply its own, and the
 * running header/footer are off: a URL and a timestamp stamped across somebody's
 * meeting notes is exactly what rendering server-side exists to avoid.
 */
const CSS = `
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: Arial, "Helvetica Neue", Helvetica, sans-serif;
    font-size: 10.5pt;
    line-height: 1.5;
    color: #202124;
  }
  h1 { font-size: 19pt; color: #0D47A1; margin: 0 0 2pt; }
  .sub { color: #5F6368; font-size: 9.5pt; margin: 0 0 1pt; }
  h2 {
    font-size: 12.5pt; margin: 20pt 0 7pt; padding-bottom: 3pt;
    border-bottom: 1.5pt solid #0D47A1; color: #0D47A1;
  }
  h2.needs { border-bottom-color: #F29900; color: #F29900; }
  h2.green { border-bottom-color: #0F9D58; color: #0F9D58; }
  h2.orange { border-bottom-color: #F29900; color: #F29900; }
  h2.teal { border-bottom-color: #00ACC1; color: #00ACC1; }
  .overview { background: #F8FAFF; padding: 8pt 10pt; }
  .who { font-weight: bold; margin: 9pt 0 2pt; }
  ul { margin: 0 0 4pt; padding-left: 16pt; }
  li { margin: 0 0 3pt; }
  .due { color: #F29900; font-weight: bold; white-space: nowrap; }
  .assigned { color: #F29900; font-weight: bold; margin: 10pt 0 0; }
  .muted { color: #5F6368; }
  .empty { color: #9AA0A6; font-style: italic; }
  table { width: 100%; border-collapse: collapse; margin-top: 4pt; }
  th {
    background: #1A73E8; color: #fff; font-size: 9pt; text-align: left;
    padding: 5pt 6pt;
  }
  td { padding: 5pt 6pt; vertical-align: top; font-size: 10pt; }
  tr:nth-child(even) td { background: #F6F8FC; }
  /* A row is one utterance; splitting one across two pages is unreadable. */
  tr { page-break-inside: avoid; }
  thead { display: table-header-group; }
  .t-time { width: 52pt; color: #5F6368; font-size: 9pt; white-space: nowrap; }
  .t-who { width: 96pt; font-weight: bold; color: #0D47A1; }
  .unclear { color: #C5221F; }
  table.tasks th { background: #F29900; }
  table.tasks tr:nth-child(even) td { background: #FFF8EC; }
  .k-who { font-weight: bold; color: #0D47A1; white-space: nowrap; }
  .k-due { font-weight: bold; color: #F29900; white-space: nowrap; }
  /* An em dash where no date was given, so the column is never ambiguous. */
  .k-none { color: #9AA0A6; }
`;

function page(title, bodyHtml) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(
        title,
    )}</title><style>${CSS}</style></head><body>${bodyHtml}</body></html>`;
}

function list(items, emptyText) {
    const rows = (items || []).filter((x) => String(x || "").trim());
    if (rows.length === 0) return `<p class="empty">${esc(emptyText)}</p>`;
    return `<ul>${rows
        .map((x) => `<li>${esc(String(x).replace(/^\s*[-*•]\s*/, ""))}</li>`)
        .join("")}</ul>`;
}

/**
 * The summary, with Needs Action at the front.
 *
 * `needsActionGroups` is passed in rather than imported so this file does not
 * reach into the docx builder for it — the caller owns which reading of those
 * three lists is in force, and both documents get the same one.
 */
function summaryHtml(summary, meetId, needsActionGroups) {
    const title = summary.meetTitle || meetId;
    const when = summary.meetDateTime
        ? new Date(summary.meetDateTime).toLocaleString("en-IN", {
              timeZone: "Asia/Kolkata",
              dateStyle: "medium",
              timeStyle: "short",
          })
        : "";

    const groups = needsActionGroups || [];
    const needs =
        groups.length === 0
            ? ""
            : `<h2 class="needs">Needs Action</h2>${groups
                  .map(
                      (g) => `<p class="who">${esc(g.owner || "Everyone")}</p><ul>${g.items
                          .map(
                              (i) =>
                                  `<li>${esc(i.what)}${
                                      i.due
                                          ? ` <span class="due">${esc(i.due)}</span>`
                                          : ""
                                  }</li>`,
                          )
                          .join("")}</ul>`,
                  )
                  .join("")}`;

    const flow = (summary.conversationFlow || []).filter((l) =>
        String(l || "").trim(),
    );

    return page(
        `Meeting Summary — ${title}`,
        [
            `<h1>CoWork Meeting Summary</h1>`,
            `<p class="sub">${esc(title)}</p>`,
            when ? `<p class="sub">${esc(when)}</p>` : "",
            `<p class="sub">Participants: ${esc(
                (summary.participants || []).join(", ") || "—",
            )}</p>`,
            needs,
            `<h2>1.&nbsp;&nbsp;Meeting Overview</h2>`,
            `<div class="overview">${
                summary.summary
                    ? esc(summary.summary)
                    : '<span class="empty">No summary available.</span>'
            }</div>`,
            `<h2>2.&nbsp;&nbsp;Conversation Flow</h2>`,
            flow.length
                ? `<ul>${flow.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`
                : '<p class="empty">No conversation data available.</p>',
            `<h2 class="green">3.&nbsp;&nbsp;Tasks Assigned</h2>`,
            list(summary.tasksAssigned, "No tasks were assigned."),
            `<h2 class="orange">4.&nbsp;&nbsp;Deadlines Mentioned</h2>`,
            list(summary.deadlines, "No specific deadlines were mentioned."),
            `<h2 class="teal">5.&nbsp;&nbsp;Action Items</h2>`,
            list(summary.actionItems, "No action items were recorded."),
        ].join(""),
    );
}

/**
 * The transcript, one row per utterance — the same table the .docx draws.
 *
 * **With a Summary box in front of it.** Asked for 21 September 2026: the
 * document opened straight onto four hundred rows of dialogue, so anybody
 * handed the file had to read the whole meeting to find out what it was about.
 * A transcript is a record; the summary is the briefing that makes it usable.
 *
 * `summary` and `needsActionGroups` are passed in rather than read here — the
 * caller owns both, so the box cannot disagree with the summary document or
 * with the panel.
 */
function transcriptHtml(record, result, mode, meetId, summary, needsActionGroups) {
    const utterances = result?.utterances || [];
    const unclear = utterances.filter((u) => u && u.needsReview).length;
    const heading =
        mode === "translate"
            ? "Translated to English — translated lines are marked"
            : "Verbatim — the exact words, in the language they were spoken";

    const rows = utterances
        .map(
            (u) =>
                `<tr><td class="t-time">${esc(mmss(u?.start))}</td><td class="t-who">${esc(
                    u?.speaker ?? "Unknown",
                )}</td><td${u?.needsReview ? ' class="unclear"' : ""}>${esc(
                    u?.text ?? "",
                )}${
                    mode === "translate" && u?.translated
                        ? ' <span class="muted">(translated)</span>'
                        : ""
                }</td></tr>`,
        )
        .join("");

    return page(
        `Meeting Transcript — ${meetId}`,
        [
            `<h1>CoWork Meeting Transcript</h1>`,
            `<p class="sub">${esc(heading)}</p>`,
            `<p class="sub">Meeting ${esc(meetId)} &nbsp;·&nbsp; ${
                utterances.length
            } line(s)${unclear ? ` &nbsp;·&nbsp; ${unclear} marked unclear` : ""}</p>`,
            `<p class="sub">Participants: ${esc(
                (record?.participantNames || []).join(", ") || "—",
            )}</p>`,
            /* ── Meeting Summary, then the tasks, then the transcript ──
             *
             * The order asked for on 21 September 2026: somebody handed this
             * file should be able to close it after the first page knowing
             * what happened, who owes what and by when.
             */
            `<h2>Meeting Summary</h2>`,
            summary && String(summary.summary || "").trim()
                ? `<div class="overview">${String(summary.summary)
                      .split(/\n+/)
                      .map((l) => l.trim())
                      .filter(Boolean)
                      /* A paragraph per line the model wrote — it was asked for
                         10–15 and collapsing them loses that shape. */
                      .map((l) => `<p>${esc(l)}</p>`)
                      .join("")}</div>`
                : '<p class="empty">A summary is written whenever a transcript is generated. This transcript predates that, so generating it again will produce one.</p>',

            `<h2 class="orange">Tasks &amp; Action Items</h2>`,
            (needsActionGroups || []).length === 0
                ? '<p class="empty">Nothing was assigned in this meeting.</p>'
                : `<table class="tasks"><thead><tr><th>Task</th><th>Assigned To</th><th>Deadline</th></tr></thead><tbody>${(
                      needsActionGroups || []
                  )
                      .flatMap((g) =>
                          g.items.map(
                              (i) =>
                                  `<tr><td>${esc(i.what)}</td><td class="k-who">${esc(
                                      g.owner || "Everyone",
                                  )}</td><td class="${
                                      i.due ? "k-due" : "k-none"
                                  }">${esc(i.due || "—")}</td></tr>`,
                          ),
                      )
                      .join("")}</tbody></table>`,

            /* ── The transcript itself ───────────────────────────────── */
            `<h2>Transcript</h2>`,
            utterances.length
                ? `<table><thead><tr><th>Time</th><th>Speaker</th><th>What was said</th></tr></thead><tbody>${rows}</tbody></table>`
                : '<p class="empty">No transcript lines.</p>',
        ].join(""),
    );
}

module.exports = { summaryHtml, transcriptHtml, mmss, esc };
