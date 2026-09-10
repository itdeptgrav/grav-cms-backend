// verifyNoUndefinedRefs.js
//
// Does every identifier these routes use actually exist?
//
// Run:  node verifyNoUndefinedRefs.js
//
// WHY THIS EXISTS
// Acc_vouchers.js used `billMatching` in eleven places and never required it.
// Nothing caught that: the file parses, the server boots, every other route in
// it works. "billMatching is not defined" is thrown only when one of the four
// /match routes is actually called — so it shipped, and it failed for a user
// rather than for us.
//
// A missing import is invisible to `node --check` and to a syntax-only review.
// It is not invisible to a scope walk. This resolves every identifier
// reference against the scopes that enclose it — module scope, function
// scopes, parameters, catch bindings, classes, loop heads — and reports the
// ones that resolve to nothing and are not a JavaScript or Node global.
//
// PURE. Reads source files. No database, no network, no writes.

"use strict";

const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");

let pass = 0;
let fail = 0;
const check = (n, ok, d = "") => {
  if (ok) {
    pass += 1;
    console.log(`  ok    ${n}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ""}`);
  }
};

/* Things that exist without being declared. Anything genuinely global to a
   CommonJS module in Node belongs here; anything else must be declared or
   required in the file that uses it. */
const GLOBALS = new Set([
  ...Object.getOwnPropertyNames(globalThis),
  "require", "module", "exports", "__dirname", "__filename",
  "process", "console", "Buffer", "global", "globalThis",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "setImmediate", "clearImmediate", "queueMicrotask", "structuredClone",
  "fetch", "Headers", "Request", "Response", "FormData", "Blob", "File",
  "URL", "URLSearchParams", "TextEncoder", "TextDecoder", "AbortController",
  "AbortSignal", "Event", "EventTarget", "MessageChannel", "performance",
  "arguments", "undefined", "NaN", "Infinity",
]);

/* Puppeteer methods whose function argument is executed in the page, not
   here. Their bodies are legitimately written against browser globals. */
const BROWSER_EVAL = new Set([
  "evaluate", "evaluateHandle", "$eval", "$$eval",
  "evaluateOnNewDocument", "waitForFunction", "exposeFunction",
]);
const BROWSER_GLOBALS = [
  "document", "window", "navigator", "location", "history", "screen",
  "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
  "localStorage", "sessionStorage", "customElements", "matchMedia",
  "Node", "Element", "HTMLElement", "NodeFilter", "MutationObserver",
  "IntersectionObserver", "ResizeObserver", "DOMParser", "XMLSerializer",
  "getSelection", "alert", "confirm", "prompt", "scrollTo", "scrollBy",
];

/* ── scope model ──────────────────────────────────────────────────────────
   A scope is a set of names plus a parent. `var` and function declarations
   hoist to the nearest function scope; let/const/class stay in the block. */
function makeScope(parent, isFn) {
  return { names: new Set(), parent, isFn: !!isFn };
}
function declare(scope, name, kind) {
  if (!name) return;
  let target = scope;
  if (kind === "var" || kind === "function") {
    while (target.parent && !target.isFn) target = target.parent;
  }
  target.names.add(name);
}
function resolves(scope, name) {
  for (let s = scope; s; s = s.parent) if (s.names.has(name)) return true;
  return false;
}

/* Every name a binding pattern introduces: destructuring, defaults, rest. */
function patternNames(node, out = []) {
  if (!node) return out;
  switch (node.type) {
    case "Identifier":
      out.push(node.name);
      break;
    case "ObjectPattern":
      for (const p of node.properties) {
        if (p.type === "RestElement") patternNames(p.argument, out);
        else patternNames(p.value, out);
      }
      break;
    case "ArrayPattern":
      for (const e of node.elements) if (e) patternNames(e, out);
      break;
    case "AssignmentPattern":
      patternNames(node.left, out);
      break;
    case "RestElement":
      patternNames(node.argument, out);
      break;
  }
  return out;
}

const CHILD_KEYS = (n) =>
  Object.keys(n).filter(
    (k) =>
      k !== "loc" &&
      k !== "leadingComments" &&
      k !== "trailingComments" &&
      k !== "innerComments" &&
      k !== "extra",
  );

function analyze(ast) {
  const problems = [];
  const root = makeScope(null, true);

  /* Hoist first: a function may legally call something declared below it. */
  function hoist(node, scope) {
    if (!node || typeof node.type !== "string") return;
    switch (node.type) {
      case "VariableDeclaration":
        for (const d of node.declarations)
          for (const nm of patternNames(d.id)) declare(scope, nm, node.kind);
        break;
      case "FunctionDeclaration":
        if (node.id) declare(scope, node.id.name, "function");
        return; // its body is a new scope, walked later
      case "ClassDeclaration":
        if (node.id) declare(scope, node.id.name, "let");
        return;
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        return; // nested scope; hoisted when we walk into it
    }
    for (const k of CHILD_KEYS(node)) {
      const c = node[k];
      if (Array.isArray(c)) c.forEach((x) => x && hoist(x, scope));
      else if (c && typeof c.type === "string") hoist(c, scope);
    }
  }

  function walkDefaults(p, s) {
    if (p && p.type === "AssignmentPattern") walk(p.right, s);
  }

  function walk(node, scope) {
    if (!node || typeof node.type !== "string") return;

    switch (node.type) {
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression": {
        const s = makeScope(scope, true);
        if (node.type === "FunctionExpression" && node.id)
          declare(s, node.id.name, "let");
        for (const p of node.params)
          for (const nm of patternNames(p)) declare(s, nm, "let");
        hoist(node.body, s);
        for (const p of node.params) walkDefaults(p, s);
        walk(node.body, s);
        return;
      }
      case "CatchClause": {
        const s = makeScope(scope, false);
        if (node.param)
          for (const nm of patternNames(node.param)) declare(s, nm, "let");
        hoist(node.body, s);
        walk(node.body, s);
        return;
      }
      case "BlockStatement": {
        const s = makeScope(scope, false);
        for (const st of node.body) {
          if (st.type === "VariableDeclaration" && st.kind !== "var")
            for (const d of st.declarations)
              for (const nm of patternNames(d.id)) declare(s, nm, st.kind);
          if (st.type === "FunctionDeclaration" && st.id)
            declare(s, st.id.name, "function");
          if (st.type === "ClassDeclaration" && st.id)
            declare(s, st.id.name, "let");
        }
        for (const st of node.body) walk(st, s);
        return;
      }
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement": {
        const s = makeScope(scope, false);
        const head = node.init || node.left;
        if (head && head.type === "VariableDeclaration")
          for (const d of head.declarations)
            for (const nm of patternNames(d.id)) declare(s, nm, head.kind);
        for (const k of ["init", "test", "update", "left", "right", "body"])
          if (node[k]) walk(node[k], s);
        return;
      }
      case "ClassDeclaration":
      case "ClassExpression": {
        const s = makeScope(scope, false);
        if (node.id) declare(s, node.id.name, "let");
        if (node.superClass) walk(node.superClass, s);
        walk(node.body, s);
        return;
      }
      /* Property keys, member properties and labels are not references. */
      case "MemberExpression":
      case "OptionalMemberExpression":
        walk(node.object, scope);
        if (node.computed) walk(node.property, scope);
        return;
      case "ObjectProperty":
      case "Property":
        if (node.computed) walk(node.key, scope);
        walk(node.value, scope);
        return;
      case "ObjectMethod":
      case "ClassMethod":
      case "ClassPrivateMethod": {
        if (node.computed) walk(node.key, scope);
        const s = makeScope(scope, true);
        for (const p of node.params)
          for (const nm of patternNames(p)) declare(s, nm, "let");
        hoist(node.body, s);
        walk(node.body, s);
        return;
      }
      /* A function handed to page.evaluate / evaluateHandle / $eval is
         serialised and run inside the BROWSER, where `document`, `window`
         and friends are real. Judging its body against Node's globals would
         report a false crash in code that works — so its scope starts with
         the browser's names in it. */
      case "CallExpression":
      case "OptionalCallExpression": {
        const callee = node.callee;
        const method =
          callee &&
          (callee.type === "MemberExpression" ||
            callee.type === "OptionalMemberExpression") &&
          !callee.computed &&
          callee.property?.name;
        walk(callee, scope);
        const browserCtx = BROWSER_EVAL.has(method);
        for (const a of node.arguments) {
          if (
            browserCtx &&
            (a.type === "ArrowFunctionExpression" ||
              a.type === "FunctionExpression")
          ) {
            const s = makeScope(scope, true);
            for (const g of BROWSER_GLOBALS) s.names.add(g);
            walk(a, s);
          } else walk(a, scope);
        }
        return;
      }
      case "LabeledStatement":
        walk(node.body, scope);
        return;
      case "BreakStatement":
      case "ContinueStatement":
        return;
      case "Identifier":
        if (!resolves(scope, node.name) && !GLOBALS.has(node.name)) {
          problems.push({ name: node.name, line: node.loc?.start.line });
        }
        return;
    }

    for (const k of CHILD_KEYS(node)) {
      const c = node[k];
      if (Array.isArray(c)) c.forEach((x) => x && walk(x, scope));
      else if (c && typeof c.type === "string") walk(c, scope);
    }
  }

  hoist(ast.program, root);
  for (const st of ast.program.body) walk(st, root);
  return problems;
}

function scan(file) {
  const src = fs.readFileSync(file, "utf8");
  let ast;
  try {
    ast = parser.parse(src, {
      sourceType: "unambiguous",
      allowReturnOutsideFunction: true,
    });
  } catch (e) {
    return [{ name: `(parse error) ${e.message.split("\n")[0]}`, line: 0 }];
  }
  const seen = new Map();
  for (const p of analyze(ast)) if (!seen.has(p.name)) seen.set(p.name, p.line);
  return [...seen].map(([name, line]) => ({ name, line }));
}

function filesUnder(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(full));
    else if (e.name.endsWith(".js") && !e.name.endsWith(".test.js")) out.push(full);
  }
  return out;
}

(() => {
  console.log("\nthe bug this was written for");
  const vouchers = "routes/Accountant_Routes/Acc_vouchers.js";
  const vp = scan(vouchers);
  check(
    "Acc_vouchers.js resolves every identifier it uses",
    vp.length === 0,
    vp.map((p) => `${p.name} (line ${p.line})`).join(", "),
  );
  check(
    "and billMatching in particular is imported",
    /require\("\.\.\/\.\.\/services\/billMatching\.service"\)/.test(
      fs.readFileSync(vouchers, "utf8"),
    ),
  );

  console.log("\nevery accountant route and every service");
  const targets = [
    ...filesUnder("routes/Accountant_Routes"),
    ...filesUnder("services"),
  ];
  const broken = [];
  for (const f of targets) {
    const p = scan(f);
    if (p.length)
      broken.push(
        `${f}\n          ${p.map((x) => `${x.name} (line ${x.line})`).join(", ")}`,
      );
  }
  check(
    `no undefined identifier in ${targets.length} files`,
    broken.length === 0,
    broken.join("\n        "),
  );

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
