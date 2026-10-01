/* Find calls to identifiers that are never bound in their own file.
 *
 * This is the shape of the bug that broke every voucher save for a week:
 * `applyDefaultNarration(voucher)` survived a merge but its `require` did not,
 * so the call threw ReferenceError the moment the line was reached — at request
 * time, which is why nothing caught it until a user tried to post an invoice.
 *
 * It is a heuristic, not a type checker: no scope analysis, no parser. It looks
 * for BARE calls `name(` (never `obj.name(`), then asks whether that name is
 * bound anywhere in the same file — declared, imported, destructured, assigned,
 * or taken as a parameter. Anything left is a candidate to read by hand.
 *
 * Usage:  node scratchpad/undefined_calls.js routes services
 */
"use strict";
const fs = require("fs");
const path = require("path");

const KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "typeof", "function", "new",
  "await", "else", "do", "throw", "delete", "void", "in", "of", "instanceof",
  "case", "yield", "import", "export", "class", "extends", "super", "this",
  "try", "finally", "const", "let", "var", "default", "break", "continue",
  "async", "static", "get", "set", "from", "as",
]);

/* Node and JS globals a route file legitimately calls without importing. */
const GLOBALS = new Set([
  "require", "console", "process", "Buffer", "setTimeout", "setInterval",
  "clearTimeout", "clearInterval", "setImmediate", "queueMicrotask", "fetch",
  "Number", "String", "Boolean", "Object", "Array", "JSON", "Math", "Date",
  "Promise", "Map", "Set", "WeakMap", "WeakSet", "RegExp", "Error", "TypeError",
  "RangeError", "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent",
  "decodeURIComponent", "encodeURI", "decodeURI", "Symbol", "Proxy", "Reflect",
  "BigInt", "structuredClone", "AbortController", "URL", "URLSearchParams",
  "TextEncoder", "TextDecoder", "Intl", "globalThis", "escape", "unescape",
]);

const files = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      walk(p);
    } else if (e.name.endsWith(".js") && !e.name.endsWith(".test.js")) {
      files.push(p);
    }
  }
}
for (const root of process.argv.slice(2)) {
  if (fs.existsSync(root)) walk(root);
}

/** Strip comments and string/template literals so their contents never count. */
function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1 ")
    .replace(/`(?:\\.|[^`\\])*`/g, "``")
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

/** Is `name` bound anywhere in this file? Deliberately generous. */
function isBound(code, name) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    `\\bfunction\\s*\\*?\\s+${n}\\b`,          // function foo()
    `\\b(?:const|let|var)\\s+${n}\\b`,          // const foo =
    `\\bclass\\s+${n}\\b`,                      // class Foo
    `\\b${n}\\s*[:,=]`,                         // destructured { foo, …} / { foo: bar } / foo =
    `\\b${n}\\s*\\}`,                           // last name in a destructure
    `\\(([^()]*,)?\\s*${n}\\s*[,)]`,            // function parameter
    `=>\\s*${n}\\b`,                            // arrow single param
  ];
  return patterns.some((p) => new RegExp(p).test(code));
}

const findings = [];
for (const file of files) {
  const raw = fs.readFileSync(file, "utf8");
  const code = strip(raw);
  const seen = new Set();
  const callRe = /(^|[^.\w$'"`])([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = callRe.exec(code))) {
    const name = m[2];
    if (seen.has(name) || KEYWORDS.has(name) || GLOBALS.has(name)) continue;
    seen.add(name);
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    /* Used as a METHOD somewhere in the file (`obj.name(`) — then the bare
       `name(` is almost certainly a property shorthand or a false read, not a
       call to a free function. */
    if (new RegExp("\\." + esc + "\\s*\\(").test(code)) continue;
    if (!isBound(code, name)) {
      // Line number of the first real call, from the original source.
      const at = raw.search(new RegExp("(^|[^.\\w$])" + esc + "\\s*\\(", "m"));
      const lineNo = at < 0 ? 0 : (raw.slice(0, at).match(/\n/g) || []).length + 1;
      findings.push({ file: path.relative(process.cwd(), file), name, line: lineNo });
    }
  }
}

if (!findings.length) {
  console.log("No calls to unbound identifiers found.");
} else {
  console.log(`${findings.length} candidate(s) — each needs reading by hand:\n`);
  for (const f of findings) console.log(`  ${f.file}:${f.line}  ${f.name}(`);
}
