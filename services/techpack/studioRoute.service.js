// services/techpack/studioRoute.service.js
//
// FROM GRAV STUDIO'S STITCHES TO THE TECH SHEET (15 Oct 2026).
//
// GRAV Studio sends, with every version, the construction of every stitch the
// designer marked: its name, the pieces on each side, the length, and how it
// is sewn — ISO 4915 stitch class, purpose (join, neaten, topstitch…), SPI,
// needle. This turns that sheet into the two things the tech sheet needs and
// a person would otherwise type:
//
//   · the ROUTE — operations from the registered Operation master, matched
//     on what the stitch is (its words and its pieces), what it does (the
//     purpose) and what sews it (the machine family the stitch class runs
//     on). A proposal only: Production reviews it and saves it through its
//     own door, which re-reads every operation from the master.
//   · the THREAD — metres per finished piece, from each stitch's length and
//     its stitch class's thread factor.
//
// Plain data in, plain data out — no database here; the callers read.
"use strict";

const text = (v) => String(v ?? "").trim();

/* ── WHICH MACHINE SEWS WHICH STITCH CLASS ──────────────────────────────────
   The master's machine types are free text ("4TH O/L", "4THO/L", "4T-O/L");
   each is reduced to a family, and each ISO class names the families that
   can sew it. A machine type with no family (an iron, a table, a helper) is
   not a sewing step and is never proposed for a stitch. */
function machineFamily(machineType) {
  const m = text(machineType).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!m) return "";
  if (/^(SNLS|SNEC|DNLS|LS)/.test(m)) return "lockstitch";
  if (/^5T/.test(m)) return "overlock5";
  if (/^4T/.test(m)) return "overlock4";
  if (/^3T/.test(m)) return "overlock3";
  if (/^FL$|^FLATLOCK|^CS$|^COVER/.test(m)) return "flatlock";
  if (/^(KANSAI|MULTI)/.test(m)) return "multineedle";
  if (/^(FOA|FEEDOFARM)/.test(m)) return "chain";
  if (/^(BH|KEYHOLE|EYELET)/.test(m)) return "buttonhole";
  if (/^BA$/.test(m)) return "buttonattach";
  if (/^BT|^BARTACK/.test(m)) return "bartack";
  return "";
}

const CLASS_FAMILIES = Object.freeze({
  101: ["buttonattach", "chain"],
  301: ["lockstitch"],
  304: ["buttonhole", "bartack", "lockstitch"],
  401: ["chain", "multineedle"],
  406: ["flatlock", "multineedle"],
  407: ["flatlock", "multineedle"],
  503: ["overlock3"],
  504: ["overlock3"],
  512: ["overlock4"],
  514: ["overlock4"],
  516: ["overlock5"],
  602: ["flatlock"],
  605: ["flatlock"],
  607: ["flatlock"],
});

/* ── THREAD PER METRE OF SEAM ────────────────────────────────────────────────
   The usual industry factors (metres of thread per metre of seam, all of a
   stitch's threads together, at a medium SPI), before any wastage — the
   wastage allowance is the technical record's own field and is not folded in
   here. */
const THREAD_FACTOR = Object.freeze({
  101: 4, 301: 2.5, 304: 7, 401: 5.5, 406: 18, 407: 22,
  503: 12, 504: 14, 512: 18, 514: 20, 516: 19.5, 602: 25, 605: 28, 607: 32,
});

/* ── WHAT A PURPOSE IS CALLED ON A SHOP FLOOR ───────────────────────────────
   Studio's purposes, and the words an operation's name uses for them. A name
   that uses ANOTHER purpose's words is doing something else to the seam. */
const PURPOSE_WORDS = Object.freeze({
  join: ["join", "joint", "joining", "attach", "attaching", "seam", "close", "closing", "closeing", "assemble"],
  neaten: ["serging", "sergeing", "serge", "overlock", "neaten"],
  topstitch: ["ts", "topstitch", "top", "finishing", "finising", "finish"],
  edgestitch: ["edgestitch", "edge", "finishing", "finish"],
  bartack: ["bartack", "tack", "tacking"],
  hem: ["hem", "hemming", "heming"],
});

/* Shop-floor shorthand, so "Slv" and "Sleeve", "Pkt" and "Pocket" meet. */
const ALIASES = Object.freeze({
  slv: "sleeve", sleeves: "sleeve", pkt: "pocket", pockets: "pocket", btn: "button", buttons: "button",
  plkt: "placket", palcket: "placket", plackets: "placket", cuffs: "cuff", collars: "collar",
  shoulders: "shoulder", sides: "side", seams: "seam", fronts: "front", backs: "back", yokes: "yoke",
  armholes: "armhole", necks: "neck", hems: "hem", bottom: "hem", buttom: "hem",
});

/* Words that say where, not what: a left and a right shoulder are sewn by the
   same operation, and so are the front and back halves of an armhole. */
const STOP = new Set(["l", "r", "left", "right", "front", "back", "to", "and", "with", "the", "of", "a", "x", "s", "m", "c", "piece", "pc", "pcs"]);

function words(s) {
  return text(s)
    .toLowerCase()
    .replace(/t\s*\/\s*s/g, " ts ")
    .replace(/o\s*\/\s*l/g, " overlock ")
    .replace(/[^a-z]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => ALIASES[w] || w)
    .filter((w) => !STOP.has(w));
}

const isoOf = (op) => {
  const m = text(op?.code).match(/^\d{3}$/);
  return m ? Number(m[0]) : null;
};

function purposeKey(op) {
  const p = text(op?.purpose).toLowerCase();
  if (PURPOSE_WORDS[p]) return p;
  for (const [k, ws] of Object.entries(PURPOSE_WORDS)) if (ws.some((w) => p.includes(w))) return k;
  return "";
}

/** Every purpose word, so a master name's purpose can be read off it. */
const ALL_PURPOSE_WORDS = new Map();
for (const [k, ws] of Object.entries(PURPOSE_WORDS)) for (const w of ws) {
  if (!ALL_PURPOSE_WORDS.has(w)) ALL_PURPOSE_WORDS.set(w, new Set());
  ALL_PURPOSE_WORDS.get(w).add(k);
}

const seriesOf = (code) => text(code).replace(/\d+$/, "").toUpperCase();

/**
 * The jobs a construction sheet asks for: one per operation of every stitch
 * that has its construction.
 */
function jobsOf(construction) {
  const sheet = Array.isArray(construction) ? construction : [];
  const jobs = [];
  for (const s of sheet) {
    if (s?.status !== "ready") continue;
    const ops = Array.isArray(s.operations) ? s.operations : [];
    const own = words(s.name);
    const pieces = words(`${text(s.sideA)} ${text(s.sideB)}`);
    ops.forEach((op, i) => {
      jobs.push({
        stitch: text(s.name) || text(s.seamId),
        seamId: text(s.seamId),
        index: i,
        iso: isoOf(op),
        purpose: purposeKey(op),
        purposeWords: text(op.purpose),
        own: [...new Set(own)],
        pieces: [...new Set(pieces.filter((w) => !own.includes(w)))],
        lengthMm: Number(s.lengthAmm) || 0,
        needles: Number(op.needles) || 1,
      });
    });
  }
  return jobs;
}

/** How rare each word is across the master's names: a rare word says more. */
function rarity(masters) {
  const df = new Map();
  for (const m of masters) for (const w of new Set(words(m.name))) df.set(w, (df.get(w) || 0) + 1);
  const n = Math.max(1, masters.length);
  return (w) => Math.log((n + 1) / ((df.get(w) || 0) + 1)) + 0.25;
}

/**
 * One master operation against one job. Null when it cannot be the job:
 * a machine that cannot sew the stitch class, or nothing in common.
 */
function scoreOf(job, master, weight) {
  const family = machineFamily(master.machineType);
  if (!family) return null;
  const families = job.iso ? CLASS_FAMILIES[job.iso] : null;
  if (families && !families.includes(family)) return null;

  const name = words(master.name);
  const set = new Set(name);
  let subject = 0;
  let matched = 0;
  for (const w of job.own) if (set.has(w)) { subject += weight(w) * 1.5; matched += 1; }
  for (const w of job.pieces) if (set.has(w)) { subject += weight(w); matched += 1; }
  if (!matched) return null;

  /* What the operation does to the seam, read off its name: 2 says this
     stitch's purpose, 1 says none, 0 says another purpose only. */
  let tier = 1;
  const mine = new Set(PURPOSE_WORDS[job.purpose] || []);
  for (const w of set) {
    if (mine.has(w)) tier = 2;
    else if (ALL_PURPOSE_WORDS.has(w) && tier === 1) tier = 0;
  }

  /* Words the operation names that the stitch does not: a longer name is a
     more particular job ("Cuff Attach with plit making"), so it gives way to
     a plain one when both fit. */
  const used = new Set([...job.own, ...job.pieces, ...mine]);
  const extra = name.filter((w) => !used.has(w) && !ALL_PURPOSE_WORDS.has(w)).reduce((t, w) => t + weight(w), 0);
  return { tier, score: subject - 0.25 * extra };
}

/* Purpose first — an operation that does something else to the seam is not
   this job however well its words fit; then the factory's own series for
   this product; then the words. */
const byRank = (a, b) => (b.tier - a.tier) || ((b.home || 0) - (a.home || 0)) || (b.score - a.score);

const samTime = (sam) => {
  const total = Math.round((Number(sam) || 0) * 60);
  return { minutes: Math.floor(total / 60), seconds: total % 60 };
};

/**
 * The route GRAV Studio's stitches ask for.
 *
 * @param {object[]} construction  the version manifest's `construction`
 * @param {object[]} masters       the Operation master: {_id|id, name, operationCode, machineType, totalSam}
 * @returns {{ operations, unmatched, series }}
 *   operations: one row per distinct master operation, in the order the
 *   stitches first need it, with the stitches it covers and close
 *   alternatives; unmatched: the jobs nothing in the master fits.
 */
function proposeRoute(construction, masters) {
  const list = (Array.isArray(masters) ? masters : [])
    .map((m) => ({
      id: text(m._id ?? m.id),
      name: text(m.name),
      operationCode: text(m.operationCode),
      machineType: text(m.machineType),
      totalSam: Number(m.totalSam) || 0,
    }))
    .filter((m) => m.id && m.name);
  const weight = rarity(list);
  const jobs = jobsOf(construction);

  const ranked = jobs.map((job) => list
    .map((m) => ({ m, ...(scoreOf(job, m, weight) || { tier: -1 }) }))
    .filter((x) => x.tier >= 0)
    .sort(byRank));

  /* One factory names its operations in one series ("S010…" for shirts); the
     same name in another series is another product line's. The series most
     first choices fall in breaks the ties. */
  const votes = new Map();
  for (const r of ranked) if (r[0]) {
    const s = seriesOf(r[0].m.operationCode);
    votes.set(s, (votes.get(s) || 0) + 1);
  }
  const series = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  for (const r of ranked) {
    for (const x of r) x.home = series && seriesOf(x.m.operationCode) === series ? 1 : 0;
    r.sort(byRank);
  }

  const byId = new Map();
  const unmatched = [];
  jobs.forEach((job, i) => {
    const best = ranked[i][0];
    if (!best) {
      unmatched.push({ stitch: job.stitch, stitchClass: job.iso ? String(job.iso) : "", purpose: job.purposeWords });
      return;
    }
    if (!byId.has(best.m.id)) {
      byId.set(best.m.id, {
        operationId: best.m.id,
        operationCode: best.m.operationCode,
        name: best.m.name,
        machineType: best.m.machineType,
        totalSam: best.m.totalSam,
        ...samTime(best.m.totalSam),
        stitchClass: job.iso ? String(job.iso) : "",
        purpose: job.purposeWords,
        stitches: [],
        alternatives: ranked[i].slice(1, 4)
          .filter((x) => x.m.id !== best.m.id)
          .map((x) => ({ operationId: x.m.id, operationCode: x.m.operationCode, name: x.m.name, machineType: x.m.machineType })),
      });
    }
    const row = byId.get(best.m.id);
    if (!row.stitches.includes(job.stitch)) row.stitches.push(job.stitch);
  });

  const operations = [...byId.values()].map((r) => ({
    ...r,
    notes: `GRAV Studio: ${r.stitches.join(", ")}`.slice(0, 1000),
  }));
  return { operations, unmatched, series };
}

/**
 * Thread for one finished piece, in metres, before wastage: each stitch's
 * length times its class's factor.
 */
function threadPerPiece(construction) {
  let metres = 0;
  const unknown = [];
  for (const job of jobsOf(construction)) {
    const f = job.iso ? THREAD_FACTOR[job.iso] : null;
    if (!f) { unknown.push(job.stitch); continue; }
    /* A twin-needle lockstitch is two rows of 301; an overlock's needles are
       already inside its class's factor. */
    const rows = [101, 301, 401].includes(job.iso) ? Math.max(1, job.needles) : 1;
    metres += (job.lengthMm / 1000) * f * rows;
  }
  return { metres: Math.round(metres * 100) / 100, unknown: [...new Set(unknown)] };
}

module.exports = { proposeRoute, threadPerPiece, machineFamily, words, THREAD_FACTOR, CLASS_FAMILIES };
