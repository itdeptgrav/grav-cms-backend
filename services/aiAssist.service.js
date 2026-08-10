/**
 * services/aiAssist.service.js
 *
 * The Gemini side of the workspace AI assistant — Docs, Sheets and Mindmaps,
 * one model, one call shape.
 *
 * ── What this owns, and what it deliberately does not ──────────────────────
 *
 * This module talks to Gemini and returns a validated action. It never
 * touches Firestore, MongoDB, or any document/sheet content beyond what the
 * caller hands it. The frontend applies every action through the real editor
 * APIs (Tiptap commands, `SheetCommand` dispatch) — this file does not know
 * those APIs exist, and that is the point: a model that could write straight
 * into storage is a model that bypasses every validation and confirmation
 * step the product promises.
 *
 * ── One model, always ───────────────────────────────────────────────────
 *
 * `gemini-2.5-flash-lite`, fixed. No fallback list, no "try a bigger model on
 * failure" — the cost/safety brief for this feature is explicit that a silent
 * upgrade is not acceptable, so a model failure is reported as a failure, not
 * absorbed by spending more per call. `askAI.routes.js` tries four models in
 * sequence for a different feature (meeting audio Q&A); that pattern is not
 * repeated here on purpose.
 *
 * ── Controlled tool calls, not freeform JSON ────────────────────────────
 *
 * Every capability — insert_text, set_formula, create_chart, and so on — is
 * declared to Gemini as a function. Gemini either calls exactly one of them
 * with arguments, or replies with plain text (a question, an explanation, a
 * refusal). There is no "returns JSON that might not parse" path: the SDK's
 * function-calling machinery is the schema enforcement, and this module
 * re-validates the returned arguments against the same shape before handing
 * anything back to the route.
 */

const { GoogleGenerativeAI, SchemaType } = require("@google/generative-ai");

/**
 * `gemini-flash-lite-latest`, not `gemini-2.5-flash-lite`.
 *
 * The dated name is listed by `models.list` for this key and 404s on
 * `generateContent` anyway: "This model is no longer available to new
 * users." Confirmed live against this project's key before writing this
 * comment — the listing is not a grant, the same trap the frontend's
 * `lib/help/gemini.ts` already documents for `gemini-2.5-flash`. The
 * `-latest` alias is what Google keeps pointed at whatever Flash-Lite
 * generation a key with no special access can actually reach, so this
 * tracks forward instead of aging into the same wall.
 */
const MODEL = "gemini-flash-lite-latest";

/** Public flag — safe to expose in a health check, it is not the key itself. */
function isConfigured() {
  return typeof process.env.GEMINI_API_KEY === "string" && process.env.GEMINI_API_KEY.length > 0;
}

// ── Docs tool declarations ───────────────────────────────────────────────

const DOCS_TOOLS = [
  {
    /**
     * The whole-document tool, and the reason it exists.
     *
     * Every other tool here writes ONE element. Combined with the
     * one-tool-call-per-reply rule below, that made "write a full letter" /
     * "draft an SOP" / "write meeting notes" literally unrepresentable: the
     * model would correctly pick the single most useful step — a heading —
     * and stop, and the user got a three-word title where they asked for a
     * page. Observed, not theorised. This tool is the fix: an arbitrarily
     * long, structured body in a single call, so the safety rule and the
     * feature stop being in conflict.
     */
    name: "insert_blocks",
    description:
      "Write a complete multi-part document body at the cursor: headings, paragraphs, lists and tables together, in order. USE THIS whenever the request is for a whole document, letter, report, SOP, email, meeting notes, or any answer that needs more than one paragraph or more than one element. Prefer it over calling create_heading/create_paragraph separately.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        blocks: {
          type: SchemaType.ARRAY,
          description: "The document body, in reading order.",
          items: {
            type: SchemaType.OBJECT,
            properties: {
              type: {
                type: SchemaType.STRING,
                enum: ["heading", "paragraph", "bullets", "numbered", "table", "quote", "divider"],
                description: "What this block is. 'divider' is a horizontal rule and needs no other field.",
              },
              text: {
                type: SchemaType.STRING,
                description:
                  "For heading, paragraph and quote blocks. Supports inline emphasis: **bold**, *italic*, __underline__.",
              },
              align: {
                type: SchemaType.STRING,
                enum: ["left", "center", "right", "justify"],
                description: "Text alignment for this block. Omit for normal left-aligned body text.",
              },
              color: {
                type: SchemaType.STRING,
                description: "Hex colour for this block's text, e.g. #1a3d6d. Omit to use the document's default ink.",
              },
              size: {
                type: SchemaType.INTEGER,
                description: "Font size in points for this block. Omit to use the document's default.",
              },
              level: {
                type: SchemaType.INTEGER,
                description: "Heading level, 1 to 4. Only for heading blocks.",
              },
              items: {
                type: SchemaType.ARRAY,
                items: { type: SchemaType.STRING },
                description: "For bullets and numbered blocks.",
              },
              headers: {
                type: SchemaType.ARRAY,
                items: { type: SchemaType.STRING },
                description: "For table blocks.",
              },
              rows: {
                type: SchemaType.ARRAY,
                items: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
                description: "For table blocks. Each row must match the header count.",
              },
            },
            required: ["type"],
          },
        },
      },
      required: ["blocks"],
    },
  },
  {
    name: "insert_text",
    description: "Insert new text at the cursor position. Use for continuing writing, drafting new content, or adding a translation/summary as new text rather than replacing anything.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        text: { type: SchemaType.STRING, description: "Plain text or simple inline formatting markers (**bold**, *italic*) to insert." },
      },
      required: ["text"],
    },
  },
  {
    name: "replace_selection",
    description: "Replace the currently selected text with new text. Use for rewrite, grammar/clarity fixes, shorten, expand, change tone, and translate — anything that improves or transforms text the user selected.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        text: { type: SchemaType.STRING, description: "The replacement text." },
      },
      required: ["text"],
    },
  },
  {
    name: "create_heading",
    description: "Insert a heading at the cursor. Use when generating a title, a section heading, or building a document outline (call this once per heading).",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        text: { type: SchemaType.STRING },
        level: { type: SchemaType.INTEGER, description: "1 to 4." },
      },
      required: ["text", "level"],
    },
  },
  {
    name: "create_paragraph",
    description: "Insert a new paragraph of body text at the cursor.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: { text: { type: SchemaType.STRING } },
      required: ["text"],
    },
  },
  {
    name: "create_bullet_list",
    description: "Convert the selection, or insert at the cursor, as a bulleted list. Use for extracted action items or any unordered list.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        items: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
      },
      required: ["items"],
    },
  },
  {
    name: "create_numbered_list",
    description: "Convert the selection, or insert at the cursor, as a numbered list.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        items: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
      },
      required: ["items"],
    },
  },
  {
    name: "create_table",
    description: "Insert a table at the cursor — e.g. a structured report table, an SOP step table, or a meeting-notes table.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        headers: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
        rows: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
        },
      },
      required: ["headers", "rows"],
    },
  },
  {
    name: "format_text",
    description: "Apply inline formatting (bold, italic, underline) to the current selection without changing its wording.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        bold: { type: SchemaType.BOOLEAN },
        italic: { type: SchemaType.BOOLEAN },
        underline: { type: SchemaType.BOOLEAN },
      },
    },
  },
  {
    name: "add_comment",
    description: "Not yet supported — the document editor has no comment layer. Call this only to report that a comment was requested; it will always be refused.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: { note: { type: SchemaType.STRING } },
      required: ["note"],
    },
  },
  {
    name: "insert_page_break",
    description: "Insert a page break at the cursor.",
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
];

// ── Sheets tool declarations ─────────────────────────────────────────────

const CELL_STYLE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    bold: { type: SchemaType.BOOLEAN },
    italic: { type: SchemaType.BOOLEAN },
    underline: { type: SchemaType.BOOLEAN },
    align: { type: SchemaType.STRING, enum: ["left", "center", "right"] },
    color: { type: SchemaType.STRING, description: "CSS color for text." },
    bg: { type: SchemaType.STRING, description: "CSS color for cell fill." },
    format: { type: SchemaType.STRING, enum: ["currency", "percent", "comma", "plain"] },
  },
};

const SHEETS_TOOLS = [
  {
    name: "set_cells",
    description: "Write values or formulas into specific cells — e.g. to build a structured table from a natural-language instruction, or to clean/classify selected data.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        cells: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              ref: { type: SchemaType.STRING, description: "e.g. B4" },
              value: { type: SchemaType.STRING, description: "Literal value, or a formula starting with =." },
            },
            required: ["ref", "value"],
          },
        },
      },
      required: ["cells"],
    },
  },
  {
    name: "insert_rows",
    description: "Insert blank rows above a given row.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        beforeRow: { type: SchemaType.INTEGER, description: "1-based row number to insert before." },
        count: { type: SchemaType.INTEGER },
      },
      required: ["beforeRow", "count"],
    },
  },
  {
    name: "delete_rows",
    description: "Delete a run of rows.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        startRow: { type: SchemaType.INTEGER },
        count: { type: SchemaType.INTEGER },
      },
      required: ["startRow", "count"],
    },
  },
  {
    name: "insert_columns",
    description: "Insert blank columns before a given column.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        beforeColumn: { type: SchemaType.STRING, description: "Column letter, e.g. C." },
        count: { type: SchemaType.INTEGER },
      },
      required: ["beforeColumn", "count"],
    },
  },
  {
    name: "delete_columns",
    description: "Delete a run of columns.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        startColumn: { type: SchemaType.STRING },
        count: { type: SchemaType.INTEGER },
      },
      required: ["startColumn", "count"],
    },
  },
  {
    name: "create_table",
    description: "Write a structured table (headers + rows) starting at a given cell — the natural-language-to-table capability.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        anchor: { type: SchemaType.STRING, description: "Top-left cell, e.g. A1." },
        headers: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
        rows: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
        },
      },
      required: ["anchor", "headers", "rows"],
    },
  },
  {
    name: "set_formula",
    description: "Write one formula into one cell — for generating, explaining or fixing a formula. Always start `value` with =.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        ref: { type: SchemaType.STRING },
        formula: { type: SchemaType.STRING },
        explanation: { type: SchemaType.STRING, description: "Plain-language explanation shown to the user before they apply it." },
      },
      required: ["ref", "formula", "explanation"],
    },
  },
  {
    name: "format_range",
    description: "Apply cell formatting (bold, colors, number format, etc.) across a range.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        range: { type: SchemaType.STRING, description: "e.g. A1:D10" },
        style: CELL_STYLE_SCHEMA,
      },
      required: ["range", "style"],
    },
  },
  {
    name: "sort_range",
    description: "Sort a range by one column.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        range: { type: SchemaType.STRING },
        byColumn: { type: SchemaType.STRING, description: "Column letter within the range to sort by." },
        direction: { type: SchemaType.STRING, enum: ["asc", "desc"] },
        hasHeaderRow: { type: SchemaType.BOOLEAN },
      },
      required: ["range", "byColumn", "direction"],
    },
  },
  {
    name: "filter_range",
    description: "Hide rows in a range that do not match a condition, keeping the header row visible.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        range: { type: SchemaType.STRING },
        byColumn: { type: SchemaType.STRING },
        condition: { type: SchemaType.STRING, enum: ["equals", "contains", "notEmpty", "empty"] },
        value: { type: SchemaType.STRING },
        hasHeaderRow: { type: SchemaType.BOOLEAN },
      },
      required: ["range", "byColumn", "condition", "hasHeaderRow"],
    },
  },
  {
    name: "apply_conditional_format",
    description: "Add a conditional-formatting rule over a range (highlight duplicates, color scale, above/below average, etc.).",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        range: { type: SchemaType.STRING },
        kind: {
          type: SchemaType.STRING,
          enum: ["greater", "less", "equal", "between", "textContains", "blank", "notBlank", "duplicate", "unique", "top", "bottom", "aboveAvg", "belowAvg", "colorScale"],
        },
        value: { type: SchemaType.NUMBER },
        value2: { type: SchemaType.NUMBER },
        text: { type: SchemaType.STRING },
        color: { type: SchemaType.STRING },
      },
      required: ["range", "kind"],
    },
  },
  {
    name: "create_chart",
    description: "Embed a chart on the sheet canvas, built from a data range.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        range: { type: SchemaType.STRING },
        chartType: { type: SchemaType.STRING, enum: ["column", "bar", "line", "area", "pie", "doughnut", "scatter", "combo"] },
        title: { type: SchemaType.STRING },
      },
      required: ["range", "chartType", "title"],
    },
  },
  {
    name: "rename_sheet",
    description: "Rename this sheet (its document title).",
    parameters: {
      type: SchemaType.OBJECT,
      properties: { title: { type: SchemaType.STRING } },
      required: ["title"],
    },
  },
  {
    name: "flag_outliers",
    description:
      "Highlight specific cells as outliers/anomalies within a range, each with a short reason — a reviewable, undoable markup rather than a plain-text answer. Prefer this over replying in text whenever the request is to find anomalies, outliers, or unusual values in a range.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        range: { type: SchemaType.STRING, description: "The range that was analysed, e.g. A1:D20." },
        flags: {
          type: SchemaType.ARRAY,
          description: "The cells being flagged, each inside `range`.",
          items: {
            type: SchemaType.OBJECT,
            properties: {
              ref: { type: SchemaType.STRING, description: "e.g. B4" },
              reason: { type: SchemaType.STRING, description: "One short sentence: why this cell stands out." },
            },
            required: ["ref", "reason"],
          },
        },
      },
      required: ["range", "flags"],
    },
  },
];

// ── Mindmap tool declarations ────────────────────────────────────────────

/** Kept in step with the frontend's own re-enforcement in `lib/rules/mindmap/aiTools.ts` — the system instruction below is a request, not the enforcement. */
const MAX_REORGANIZE_MOVES = 20;

const MINDMAP_TOOLS = [
  {
    name: "add_child_nodes",
    description:
      "Expand one existing card into several new child cards underneath it. Use this whenever the request is to expand, brainstorm, break down, or add ideas under a card.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        parentId: {
          type: SchemaType.STRING,
          description: "The id of the existing card the new cards attach under. Must be an id shown in the context below — never invented.",
        },
        children: {
          type: SchemaType.ARRAY,
          description: "The new cards, in the order they should appear.",
          items: {
            type: SchemaType.OBJECT,
            properties: {
              title: { type: SchemaType.STRING, description: "Short card title — a few words, not a sentence." },
              description: { type: SchemaType.STRING, description: "Optional longer note for the card." },
            },
            required: ["title"],
          },
        },
      },
      required: ["parentId", "children"],
    },
  },
  {
    name: "reorganize_nodes",
    description:
      "Move one or more existing cards to a different parent card — for clustering related ideas together or fixing a card that landed under the wrong parent. Every id must already exist in the map.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        moves: {
          type: SchemaType.ARRAY,
          description: `Which cards move where. At most ${MAX_REORGANIZE_MOVES} moves in one call.`,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              nodeId: { type: SchemaType.STRING, description: "The card being moved. Must be an id shown in the context below." },
              newParentId: { type: SchemaType.STRING, description: "The card it moves under. Must be an id shown in the context below." },
            },
            required: ["nodeId", "newParentId"],
          },
        },
      },
      required: ["moves"],
    },
  },
];

/**
 * The rules Gemini answers under, common to all surfaces plus a per-surface
 * addendum. The negative instructions matter more than the positive ones —
 * see `lib/help/gemini.ts` in the frontend repo for the same principle
 * applied to a different assistant.
 */
function systemInstruction(surface, contextSummary) {
  const surfaceNoun = surface === "docs" ? "document" : surface === "sheets" ? "spreadsheet" : "mindmap";
  const shared = `You are the writing/spreadsheet/mindmap assistant embedded in Cowork's ${surfaceNoun} editor.

Hard rules:
- Call AT MOST ONE tool per reply. If the request needs more than one step, do the single most useful step and say what else could follow — never chain several tool calls in one turn.
${surface === "docs"
    ? `- When the request is for a whole document, letter, report, SOP, email, meeting notes, or anything needing more than one paragraph or element, use insert_blocks and put the ENTIRE body in that one call. Write the real, finished content at a natural length for the request — do not write a title and stop, and do not leave placeholders like [Your Name] unless the user gave you nothing to put there.
- LAY THE DOCUMENT OUT, do not return a wall of paragraphs. Give it a centred title, section headings, and a divider where a section genuinely ends. Use **bold** for names, dates, figures and key terms inside sentences, and *italic* sparingly for emphasis or an aside. Use a quote block for anything genuinely quoted. Use a table whenever the content is really rows and columns — schedules, deliverables, comparisons.
- Style with restraint, the way a professional document is styled: at most one accent colour, used only on the title or section headings, and only when the request suggests something branded or formal. Body text carries no colour and no size override. Never colour a whole paragraph. If in doubt, leave the styling off — clean and unstyled beats decorated.`
    : surface === "sheets"
      ? `- When the request is to build a table or fill a block of cells, use create_table or set_cells and include every row in that one call.
- When the request is to find anomalies, outliers, or unusual/unexpected values or trends in a range, prefer flag_outliers over a plain-text answer — it gives the user something to review and apply, not just a description.`
      : `- When the request is to expand, brainstorm, or break down a card, use add_child_nodes with 3 to 7 children unless the user asked for a specific count.
- Every id you use (parentId, nodeId, newParentId) MUST be one of the ids shown in the context below — never invent one.
- Never propose more than ${MAX_REORGANIZE_MOVES} moves in a single reorganize_nodes call. If more than that would genuinely help, do the most useful ${MAX_REORGANIZE_MOVES} and say what else could follow.
- The context below names which card, if any, is currently selected. When the user's instruction doesn't name a card explicitly (e.g. "add some children" or "expand this"), operate on the selected card as the implicit parent/target. If nothing is selected and none was named, ask which card they mean instead of guessing.`}
- Only use the tools you were given. Never invent a tool name or an argument that is not in its schema.
- If the request is ambiguous, destructive-sounding, or you are not confident, reply with plain text asking a clarifying question instead of calling a tool.
- Work only from the context you were given below. Do not assume content that was not shown to you.
- Keep any generated prose professional and concise unless the user's instruction asks for a specific different tone.
- Never claim an action has been applied — you are proposing it. The application decides whether and how to apply it.

Context you were given:
${contextSummary}`;

  return shared;
}

/**
 * One call, one outcome. Never throws for an ordinary provider failure —
 * callers get a typed result and decide what the user sees.
 */
async function assist({ surface, instruction, contextSummary, history }) {
  if (!isConfigured()) {
    return { ok: false, reason: "not_configured", message: "The assistant is not configured." };
  }

  const tools = surface === "docs" ? DOCS_TOOLS : surface === "sheets" ? SHEETS_TOOLS : MINDMAP_TOOLS;

  try {
    const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = client.getGenerativeModel({
      model: MODEL,
      systemInstruction: systemInstruction(surface, contextSummary),
      tools: [{ functionDeclarations: tools }],
      generationConfig: {
        temperature: 0.3,
        /**
         * Still bounded, but a full page of prose does not fit in 1024.
         *
         * An A4 page is roughly 500 words ≈ 700 tokens BEFORE the JSON
         * scaffolding of an `insert_blocks` call, so the old ceiling
         * truncated exactly the requests this tool exists to serve. 4096 is
         * about six pages — generous for any single request here, and still
         * a hard cap rather than an open tap.
         */
        maxOutputTokens: 4096,
      },
    });

    const chat = model.startChat({
      history: (history || []).slice(-6).map((turn) => ({
        role: turn.role === "assistant" ? "model" : "user",
        parts: [{ text: turn.text }],
      })),
    });

    const result = await withOneRetry(() => chat.sendMessage(instruction));
    const response = result.response;
    const call = response.functionCalls()?.[0];

    if (call) {
      const known = tools.some((t) => t.name === call.name);
      if (!known) {
        return { ok: false, reason: "invalid_tool", message: `Gemini proposed an unknown action (${call.name}).` };
      }
      return {
        ok: true,
        kind: "tool_call",
        tool: call.name,
        args: call.args || {},
        model: MODEL,
      };
    }

    const text = response.text().trim();
    if (!text) {
      return { ok: false, reason: "empty", message: "The assistant had nothing to say." };
    }
    return { ok: true, kind: "message", text, model: MODEL };
  } catch (e) {
    /* A 429 gets its own reason so the panel can say "try again shortly"
       rather than the generic connection-failure message — the two call for
       different user reactions, and conflating them teaches people to retry
       a quota wall immediately, which just spends the next request on the
       same wall. */
    const quota = /429|quota|rate.?limit/i.test(e.message || "");
    return {
      ok: false,
      reason: quota ? "quota" : "failed",
      message: quota
        ? "The assistant has hit its rate limit. Try again in a moment."
        : "The assistant could not reach Gemini.",
    };
  }
}

/** One retry on a transient failure, same model — not a fallback ladder. */
async function withOneRetry(fn) {
  try {
    return await fn();
  } catch (e) {
    await new Promise((r) => setTimeout(r, 600));
    return fn();
  }
}

module.exports = { assist, isConfigured, DOCS_TOOLS, SHEETS_TOOLS, MINDMAP_TOOLS, MODEL };
