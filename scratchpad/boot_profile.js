/* Measures where `npm run dev` spends its startup, without listening or
   connecting: hooks Module._load and totals SELF time per top-level require. */
const Module = require("module");
const path = require("path");
const t0 = Date.now();
const orig = Module._load;
const stack = [];
const self = new Map();
const ROOT = process.cwd();

Module._load = function (request, parent, isMain) {
  const start = process.hrtime.bigint();
  stack.push({ request, child: 0n });
  let out;
  try { out = orig.apply(this, arguments); }
  finally {
    const frame = stack.pop();
    const total = process.hrtime.bigint() - start;
    const selfNs = total - frame.child;
    if (stack.length) stack[stack.length - 1].child += total;
    let key;
    if (request.startsWith(".") || path.isAbsolute(request)) {
      try { key = path.relative(ROOT, Module._resolveFilename(request, parent)); }
      catch { key = request; }
    } else key = "node_modules: " + request.split("/")[0];
    self.set(key, (self.get(key) || 0n) + selfNs);
  }
  return out;
};

process.env.SKIP_LISTEN = "1";
try { require(path.join(ROOT, "server.js")); } catch (e) { console.log("(server.js threw: " + e.message + ")"); }

const ms = (n) => Number(n / 1000000n);
const rows = [...self.entries()].map(([k, v]) => [k, ms(v)]).filter(([, v]) => v >= 40).sort((a, b) => b[1] - a[1]);
console.log(`\n=== total require wall time: ${Date.now() - t0} ms ===`);
console.log("top self-time (ms):");
rows.slice(0, 30).forEach(([k, v]) => console.log(String(v).padStart(6), k));
process.exit(0);
