/**
 * generateSummaryDocx.js
 * Generates a professional .docx meeting summary document.
 * Returns a Buffer — caller writes or sends as response.
 *
 * Layout:
 *   [Header]  GRAV  |  CoWork Meeting Summary
 *   [Info box] Meeting title, description, date, time, ID, participants
 *   [Separator line]
 *   1. Meeting Overview (summary paragraph)
 *   2. Conversation (Speaker | Dialogue table)
 *   3. Tasks Assigned (Person | Task | Deadline table)
 *   4. Deadlines Mentioned (bullet list)
 *   5. Action Items (numbered list)
 *   [Footer] CoWork AI  ·  Generated date  ·  Page N
 */

const {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
    Header, Footer, AlignmentType, LevelFormat, BorderStyle,
    WidthType, ShadingType, VerticalAlign, PageNumber, TabStopType,
    TabStopPosition, HeadingLevel,
} = require("docx");

// ── Page dimensions (A4 portrait, 1" margins) ─────────────────────────────────
const PAGE_W = 11906;  // A4 width  in DXA
const PAGE_H = 16838;  // A4 height in DXA
const MARGIN = 1080;   // 0.75 inch margins
const CONTENT_W = PAGE_W - MARGIN * 2; // 9746 DXA

// ── Brand colours ─────────────────────────────────────────────────────────────
const C = {
    BRAND: "1A73E8",   // Google blue  (main accent)
    BRAND_DARK: "0D47A1",   // Darker blue  (headings)
    BRAND_BG: "EBF3FE",   // Light blue   (info box bg)
    GREEN: "0F9D58",   // Section 3 accent
    GREEN_BG: "E8F5E9",
    ORANGE: "F29900",   // Section 4 accent
    ORANGE_BG: "FFF3E0",
    TEAL: "00ACC1",   // Section 5 accent
    TEAL_BG: "E0F7FA",
    GREY: "5F6368",   // Body text
    LIGHT_GREY: "9AA0A6",   // Labels
    RULE: "DADCE0",   // Divider lines
    WHITE: "FFFFFF",
    BLACK: "202124",
};

// ── Reusable border preset ────────────────────────────────────────────────────
function cellBorder(color = C.RULE) {
    const b = { style: BorderStyle.SINGLE, size: 4, color };
    return { top: b, bottom: b, left: b, right: b };
}
function noBorder() {
    const b = { style: BorderStyle.NIL };
    return { top: b, bottom: b, left: b, right: b };
}

// ── Helper: section heading paragraph ─────────────────────────────────────────
function sectionHeading(text, accentColor = C.BRAND_DARK) {
    return new Paragraph({
        spacing: { before: 320, after: 120 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: accentColor, space: 4 } },
        children: [
            new TextRun({ text, bold: true, size: 26, color: accentColor, font: "Arial" }),
        ],
    });
}

// ── Helper: normal body paragraph ────────────────────────────────────────────
function bodyPara(text, opts = {}) {
    return new Paragraph({
        spacing: { before: 40, after: 80 },
        children: [new TextRun({ text, size: 22, color: C.GREY, font: "Arial", ...opts })],
    });
}

// ── Helper: spacer paragraph ─────────────────────────────────────────────────
function spacer(size = 160) {
    return new Paragraph({ spacing: { before: 0, after: size }, children: [] });
}

// ── Helper: label + value inline ─────────────────────────────────────────────
function labelValue(label, value) {
    return new Paragraph({
        spacing: { before: 60, after: 60 },
        children: [
            new TextRun({ text: `${label}  `, bold: true, size: 20, color: C.BRAND_DARK, font: "Arial" }),
            new TextRun({ text: value || "—", size: 20, color: C.GREY, font: "Arial" }),
        ],
    });
}

// ── Helper: parse speaker colour index (simple hash) ─────────────────────────
const SPEAKER_COLORS = ["1a73e8", "0f9d58", "d93025", "f29900", "7b1fa2", "00acc1", "e64a19"];
const speakerMap = {};
let sidx = 0;
function spkColor(name) {
    if (!speakerMap[name]) speakerMap[name] = SPEAKER_COLORS[sidx++ % SPEAKER_COLORS.length];
    return speakerMap[name];
}

// ═══════════════════════════════════════════════════════════════════════════════
async function generateSummaryDocx(summary, meetId) {
    // Reset speaker colour map per call
    Object.keys(speakerMap).forEach(k => delete speakerMap[k]);
    sidx = 0;

    const {
        summary: summaryText = "",
        dialogue: dlg = [],
        conversationFlow: flow = [],
        tasksAssigned: tasks = [],
        deadlines: deadlines = [],
        actionItems: actions = [],
        participants: participants = [],
        audioFilesCount: fileCount = 0,
        createdAtMs,
    } = summary;

    const genDate = createdAtMs
        ? new Date(createdAtMs).toLocaleString("en-IN", { dateStyle: "long", timeStyle: "short" })
        : new Date().toLocaleString("en-IN", { dateStyle: "long", timeStyle: "short" });

    const meetTitle = summary.meetTitle || summary.title || `Meeting ${meetId}`;
    const meetDescription = summary.meetDescription || summary.description || "";
    const meetDateTime = summary.meetDateTime || summary.dateTime || "";

    // Format date nicely if ISO string
    let meetDateStr = meetDateTime;
    if (meetDateTime) {
        try {
            meetDateStr = new Date(meetDateTime).toLocaleString("en-IN", {
                dateStyle: "long", timeStyle: "short",
            });
        } catch (_) { meetDateStr = meetDateTime; }
    }

    // ── Build dialogue rows ────────────────────────────────────────────────────
    const rows = dlg.length > 0
        ? dlg
        : flow.map(l => {
            const i = l.indexOf(":");
            return i > 0
                ? { speaker: l.slice(0, i).trim(), text: l.slice(i + 1).trim().replace(/^"|"$/g, "") }
                : { speaker: "—", text: l };
        });

    // ── Content children array ────────────────────────────────────────────────
    const children = [];

    // ── 1. GRAV Branding header block ─────────────────────────────────────────
    children.push(
        new Paragraph({
            spacing: { before: 0, after: 60 },
            children: [
                new TextRun({ text: "GRAV ", bold: true, size: 44, color: C.BRAND, font: "Arial" }),
                new TextRun({ text: "CoWork", bold: false, size: 44, color: C.BRAND_DARK, font: "Arial" }),
            ],
        }),
        new Paragraph({
            spacing: { before: 0, after: 240 },
            border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: C.BRAND, space: 4 } },
            children: [
                new TextRun({ text: "MEETING SUMMARY REPORT", size: 20, color: C.LIGHT_GREY, font: "Arial", allCaps: true, characterSpacing: 80 }),
            ],
        }),
        spacer(100),
    );

    // ── 2. Meeting info box (shaded table) ────────────────────────────────────
    const infoRows = [
        ["Meeting Title", meetTitle],
        ["Description", meetDescription || "—"],
        ["Date & Time", meetDateStr || "—"],
        ["Meeting ID", meetId],
        ["Participants", participants.join(", ") || "—"],
        ["Audio Files", `${fileCount} recording${fileCount !== 1 ? "s" : ""} analyzed`],
        ["Generated On", genDate],
    ];

    children.push(
        new Table({
            width: { size: CONTENT_W, type: WidthType.DXA },
            columnWidths: [2000, CONTENT_W - 2000],
            rows: infoRows.map(([label, value], i) =>
                new TableRow({
                    children: [
                        new TableCell({
                            borders: cellBorder("BDD5F8"),
                            width: { size: 2000, type: WidthType.DXA },
                            margins: { top: 80, bottom: 80, left: 140, right: 100 },
                            shading: { fill: C.BRAND_BG, type: ShadingType.CLEAR },
                            children: [new Paragraph({
                                children: [new TextRun({ text: label, bold: true, size: 19, color: C.BRAND_DARK, font: "Arial" })],
                            })],
                        }),
                        new TableCell({
                            borders: cellBorder("BDD5F8"),
                            width: { size: CONTENT_W - 2000, type: WidthType.DXA },
                            margins: { top: 80, bottom: 80, left: 140, right: 100 },
                            shading: { fill: i % 2 === 0 ? "FAFCFF" : C.WHITE, type: ShadingType.CLEAR },
                            children: [new Paragraph({
                                children: [new TextRun({ text: value || "—", size: 19, color: C.GREY, font: "Arial" })],
                            })],
                        }),
                    ],
                })
            ),
        }),
        spacer(240),
    );

    // ── 3. MEETING OVERVIEW ───────────────────────────────────────────────────
    children.push(sectionHeading("1.  Meeting Overview", C.BRAND_DARK));
    children.push(
        new Paragraph({
            spacing: { before: 80, after: 80 },
            shading: { fill: "F8FAFF", type: ShadingType.CLEAR },
            children: [new TextRun({ text: summaryText || "No summary available.", size: 22, color: C.BLACK, font: "Arial", italics: !summaryText })],
        }),
        spacer(160),
    );

    // ── 4. CONVERSATION TABLE ─────────────────────────────────────────────────
    children.push(sectionHeading("2.  Conversation Flow", C.BRAND_DARK));

    if (rows.length === 0) {
        children.push(bodyPara("No conversation data available.", { italics: true }));
    } else {
        // Header row
        const convRows = [
            new TableRow({
                tableHeader: true,
                children: [
                    new TableCell({
                        borders: cellBorder(C.BRAND),
                        width: { size: 2200, type: WidthType.DXA },
                        margins: { top: 100, bottom: 100, left: 140, right: 100 },
                        shading: { fill: C.BRAND_DARK, type: ShadingType.CLEAR },
                        children: [new Paragraph({ children: [new TextRun({ text: "Speaker", bold: true, size: 20, color: C.WHITE, font: "Arial" })] })],
                    }),
                    new TableCell({
                        borders: cellBorder(C.BRAND),
                        width: { size: CONTENT_W - 2200, type: WidthType.DXA },
                        margins: { top: 100, bottom: 100, left: 140, right: 100 },
                        shading: { fill: C.BRAND_DARK, type: ShadingType.CLEAR },
                        children: [new Paragraph({ children: [new TextRun({ text: "Dialogue", bold: true, size: 20, color: C.WHITE, font: "Arial" })] })],
                    }),
                ],
            }),
            ...rows.map((row, i) =>
                new TableRow({
                    children: [
                        new TableCell({
                            borders: cellBorder(C.RULE),
                            width: { size: 2200, type: WidthType.DXA },
                            margins: { top: 80, bottom: 80, left: 140, right: 100 },
                            shading: { fill: i % 2 === 0 ? "F0F6FF" : C.WHITE, type: ShadingType.CLEAR },
                            children: [new Paragraph({
                                children: [new TextRun({ text: row.speaker, bold: true, size: 20, color: spkColor(row.speaker), font: "Arial" })],
                            })],
                        }),
                        new TableCell({
                            borders: cellBorder(C.RULE),
                            width: { size: CONTENT_W - 2200, type: WidthType.DXA },
                            margins: { top: 80, bottom: 80, left: 140, right: 100 },
                            shading: { fill: i % 2 === 0 ? "F0F6FF" : C.WHITE, type: ShadingType.CLEAR },
                            children: [new Paragraph({
                                children: [new TextRun({ text: `"${row.text}"`, size: 20, color: C.GREY, font: "Arial" })],
                            })],
                        }),
                    ],
                })
            ),
        ];
        children.push(new Table({ width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: [2200, CONTENT_W - 2200], rows: convRows }));
    }
    children.push(spacer(200));

    // ── 5. TASKS ASSIGNED TABLE ───────────────────────────────────────────────
    children.push(sectionHeading("3.  Tasks Assigned", C.GREEN));

    if (tasks.length === 0) {
        children.push(bodyPara("No tasks were assigned in this meeting.", { italics: true }));
    } else {
        const taskRows = [
            new TableRow({
                tableHeader: true,
                children: ["Person", "Task", "Deadline"].map((h, ci) => {
                    const w = [1800, CONTENT_W - 1800 - 2000, 2000][ci];
                    return new TableCell({
                        borders: cellBorder(C.GREEN),
                        width: { size: w, type: WidthType.DXA },
                        margins: { top: 100, bottom: 100, left: 140, right: 100 },
                        shading: { fill: "0F9D58", type: ShadingType.CLEAR },
                        children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, size: 20, color: C.WHITE, font: "Arial" })] })],
                    });
                }),
            }),
            ...tasks.map((t, i) => {
                const ci = t.indexOf(":");
                const hasName = ci > 0 && ci < 30;
                const person = hasName ? t.slice(0, ci).trim() : "—";
                const rest = hasName ? t.slice(ci + 1).trim() : t;
                // Extract deadline from "[Deadline: ...]"
                const dlMatch = rest.match(/\[deadline:\s*([^\]]+)\]/i);
                const task = rest.replace(/\[deadline:[^\]]*\]/i, "").trim();
                const dl = dlMatch ? dlMatch[1].trim() : "Not specified";
                const bg = i % 2 === 0 ? C.GREEN_BG : C.WHITE;
                return new TableRow({
                    children: [
                        new TableCell({ borders: cellBorder(C.RULE), width: { size: 1800, type: WidthType.DXA }, margins: { top: 80, bottom: 80, left: 140, right: 100 }, shading: { fill: bg, type: ShadingType.CLEAR }, children: [new Paragraph({ children: [new TextRun({ text: person, bold: true, size: 20, color: C.GREEN, font: "Arial" })] })] }),
                        new TableCell({ borders: cellBorder(C.RULE), width: { size: CONTENT_W - 1800 - 2000, type: WidthType.DXA }, margins: { top: 80, bottom: 80, left: 140, right: 100 }, shading: { fill: bg, type: ShadingType.CLEAR }, children: [new Paragraph({ children: [new TextRun({ text: task, size: 20, color: C.GREY, font: "Arial" })] })] }),
                        new TableCell({ borders: cellBorder(C.RULE), width: { size: 2000, type: WidthType.DXA }, margins: { top: 80, bottom: 80, left: 140, right: 100 }, shading: { fill: bg, type: ShadingType.CLEAR }, children: [new Paragraph({ children: [new TextRun({ text: dl, size: 20, color: dl === "Not specified" ? C.LIGHT_GREY : C.ORANGE, font: "Arial", bold: dl !== "Not specified" })] })] }),
                    ],
                });
            }),
        ];
        children.push(new Table({ width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: [1800, CONTENT_W - 1800 - 2000, 2000], rows: taskRows }));
    }
    children.push(spacer(200));

    // ── 6. DEADLINES ──────────────────────────────────────────────────────────
    children.push(sectionHeading("4.  Deadlines Mentioned", C.ORANGE));
    if (deadlines.length === 0) {
        children.push(bodyPara("No specific deadlines were mentioned.", { italics: true }));
    } else {
        deadlines.forEach(d => children.push(
            new Paragraph({
                spacing: { before: 60, after: 60 },
                numbering: { reference: "bullets", level: 0 },
                children: [new TextRun({ text: d, size: 22, color: C.GREY, font: "Arial" })],
            })
        ));
    }
    children.push(spacer(200));

    // ── 7. ACTION ITEMS ───────────────────────────────────────────────────────
    children.push(sectionHeading("5.  Action Items", C.TEAL));
    if (actions.length === 0) {
        children.push(bodyPara("No action items were recorded.", { italics: true }));
    } else {
        actions.forEach(a => children.push(
            new Paragraph({
                spacing: { before: 60, after: 60 },
                numbering: { reference: "numbers", level: 0 },
                children: [new TextRun({ text: a, size: 22, color: C.GREY, font: "Arial" })],
            })
        ));
    }
    children.push(spacer(120));

    // ── Build document ────────────────────────────────────────────────────────
    const doc = new Document({
        numbering: {
            config: [
                {
                    reference: "bullets",
                    levels: [{
                        level: 0, format: LevelFormat.BULLET, text: "\u25CF",
                        alignment: AlignmentType.LEFT,
                        style: { paragraph: { indent: { left: 540, hanging: 360 } }, run: { font: "Arial", size: 22, color: C.BRAND } },
                    }],
                },
                {
                    reference: "numbers",
                    levels: [{
                        level: 0, format: LevelFormat.DECIMAL, text: "%1.",
                        alignment: AlignmentType.LEFT,
                        style: { paragraph: { indent: { left: 540, hanging: 360 } }, run: { font: "Arial", size: 22, bold: true, color: C.TEAL } },
                    }],
                },
            ],
        },
        styles: {
            default: { document: { run: { font: "Arial", size: 22, color: C.GREY } } },
        },
        sections: [{
            properties: {
                page: {
                    size: { width: PAGE_W, height: PAGE_H },
                    margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN },
                },
            },
            headers: {
                default: new Header({
                    children: [
                        new Paragraph({
                            border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: C.BRAND, space: 6 } },
                            spacing: { after: 0 },
                            tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_W }],
                            children: [
                                new TextRun({ text: "GRAV CoWork ", bold: true, size: 18, color: C.BRAND, font: "Arial" }),
                                new TextRun({ text: "\t", size: 18 }),
                                new TextRun({ text: "Meeting Summary Report", size: 18, color: C.LIGHT_GREY, font: "Arial" }),
                            ],
                        }),
                    ],
                }),
            },
            footers: {
                default: new Footer({
                    children: [
                        new Paragraph({
                            border: { top: { style: BorderStyle.SINGLE, size: 4, color: C.RULE, space: 6 } },
                            spacing: { before: 0 },
                            tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_W }],
                            children: [
                                new TextRun({ text: `Generated by CoWork AI  ·  ${new Date().toLocaleDateString("en-IN", { dateStyle: "medium" })}`, size: 17, color: C.LIGHT_GREY, font: "Arial" }),
                                new TextRun({ text: "\tPage ", size: 17, color: C.LIGHT_GREY, font: "Arial" }),
                                new TextRun({ children: [PageNumber.CURRENT], size: 17, color: C.LIGHT_GREY, font: "Arial" }),
                                new TextRun({ text: " of ", size: 17, color: C.LIGHT_GREY, font: "Arial" }),
                                new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 17, color: C.LIGHT_GREY, font: "Arial" }),
                            ],
                        }),
                    ],
                }),
            },
            children,
        }],
    });

    return Packer.toBuffer(doc);
}

module.exports = { generateSummaryDocx };