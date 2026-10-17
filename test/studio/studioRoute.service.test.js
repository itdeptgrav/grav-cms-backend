// From GRAV Studio's stitches to the route and the thread
// (services/techpack/studioRoute.service.js): plain data in, plain data out.

"use strict";

const { proposeRoute, threadPerPiece, machineFamily } = require("../../services/techpack/studioRoute.service");

let n = 0;
const op = (operationCode, name, machineType, totalSam) => ({ _id: String(++n).padStart(24, "0"), operationCode, name, machineType, totalSam });

/* A slice of a real register: the shirt series, and the same jobs named in
   other product lines' series. */
const masters = [
  op("S010", "Shoulder joint", "5T-O/L", 0.46),
  op("S011", "Shoulder T/S", "SNLS", 0.54),
  op("S012", "Sleeve Attach", "5T-O/L", 0.48),
  op("S013", "Armhole T/s", "SNLS", 0.66),
  op("S014", "SideTacking", "SNLS", 0.42),
  op("S015", "Side Seam Join", "5T-O/L", 0.54),
  op("S017", "Collar Attach", "SNLS", 0.68),
  op("S018", "Collar Finishing & LABEL ATTACH", "SNLS", 0.88),
  op("S030", "Sleeve Hemming", "SNLS", 0.54),
  op("S033", "Cuff Run Stitch", "SNLS", 0.49),
  op("S041", "Cuff Attach with plit making", "SNLS", 0.78),
  op("S042", "Cuff Finishing", "SNLS", 0.68),
  op("S060", "Collar T/S", "SNLS", 0.42),
  op("S071", "PLACKET ATTACH", "SNLS", 0.83),
  op("S073", "PLACKET FINISHING", "SNLS", 2.12),
  op("S028", "Full Pressing &Folding", "IRON TABLE", 0.66),
  op("TS013", "COLLAR NECK TAB ATTACH", "SNLS", 0.46),
  op("TS005", "PLACKET FINISHING", "SNLS", 1.2),
  op("KUT001", "Shoulder joint", "4T-O/L", 0.4),
  op("P024", "SIDE SEEM JOINT", "4THO/L", 0.6),
  op("MJ005", "BODY & LINNING BUTTOM HEM", "SNLS", 0.9),
];

const stitch = (name, sideA, sideB, lengthAmm, operations) => ({
  seamId: name, name, sideA, sideB, lengthAmm, status: "ready", seamClass: "SS", allowanceMm: 10, operations,
});
const o = (code, purpose, extra = {}) => ({ code, purpose, spi: 12, ...extra });
const joinTop = [o("516", "join", { needles: 2 }), o("301", "topstitch")];

const shirt = [
  stitch("Front shoulder (L)", "Front_L", "Back", 150, joinTop),
  stitch("Front shoulder (R)", "Front_R", "Back", 150, joinTop),
  stitch("Side seam (L)", "Front_L", "Back", 520, [o("516", "join")]),
  stitch("Side seam (R)", "Front_R", "Back", 520, [o("516", "join")]),
  stitch("Armhole front (R)", "Front_R", "Sleeves_3", 220, joinTop),
  stitch("Armhole back (R)", "Back", "Sleeves_3", 250, joinTop),
  stitch("Sleeve seam (R)", "Sleeves_3", "Sleeves_3", 450, [o("516", "join")]),
  stitch("Back neck to collar", "Back", "Collar", 170, [o("301", "join"), o("301", "topstitch")]),
  stitch("Front neck (L) to collar", "Front_L", "Collar", 110, [o("301", "join"), o("301", "topstitch")]),
  stitch("Cuff (R)", "Sleeves_3", "Cuff", 240, [o("301", "join")]),
  stitch("Placket (L)", "Front_L", "Placket", 700, [o("301", "join"), o("301", "topstitch")]),
  { seamId: "s9", name: "Hem", status: "needs construction", operations: [] },
];

describe("proposeRoute", () => {
  const out = proposeRoute(shirt, masters);
  const codes = out.operations.map((r) => r.operationCode);

  test("each job gets the shop-floor operation, one row per operation, in the order the stitches need it", () => {
    expect(codes).toEqual(["S010", "S011", "S015", "S012", "S013", "S017", "S060", "S041", "S071", "S073"]);
    expect(out.unmatched).toEqual([]);
    expect(out.series).toBe("S");
  });

  test("the left and right stitch, and the sleeve's underarm seam, share their operation", () => {
    const side = out.operations.find((r) => r.operationCode === "S015");
    expect(side.stitches).toEqual(["Side seam (L)", "Side seam (R)", "Sleeve seam (R)"]);
    expect(side.notes).toBe("GRAV Studio: Side seam (L), Side seam (R), Sleeve seam (R)");
  });

  test("a machine that cannot sew the stitch class is never proposed", () => {
    /* KUT001 "Shoulder joint" is a 4-thread overlock; the shoulder is 516. */
    expect(codes).not.toContain("KUT001");
    expect(out.operations.every((r) => r.operationCode !== "S028")).toBe(true);
  });

  test("the purpose decides before the words: a topstitch is not an attach", () => {
    const collar = out.operations.filter((r) => r.stitches.includes("Back neck to collar")).map((r) => r.operationCode);
    expect(collar).toEqual(["S017", "S060"]);
  });

  test("the time is the register's SAM as minutes and seconds", () => {
    const placket = out.operations.find((r) => r.operationCode === "S073");
    expect([placket.minutes, placket.seconds]).toEqual([2, 7]);
  });

  test("a stitch nothing in the register fits is reported, not guessed", () => {
    const r = proposeRoute([stitch("Pocket bag", "Pocket", "Facing", 100, [o("301", "join")])], masters);
    expect(r.operations).toEqual([]);
    expect(r.unmatched).toEqual([{ stitch: "Pocket bag", stitchClass: "301", purpose: "join" }]);
  });

  test("no construction, no proposal", () => {
    expect(proposeRoute(undefined, masters)).toEqual({ operations: [], unmatched: [], series: "" });
  });
});

describe("threadPerPiece", () => {
  test("length times the class's factor; a twin-needle lockstitch counts twice, an overlock's needles do not", () => {
    const sheet = [
      stitch("A", "x", "y", 1000, [o("516", "join", { needles: 2 }), o("301", "topstitch", { needles: 2 })]),
      stitch("B", "x", "y", 500, [o("301", "join")]),
    ];
    // 1 m × 19.5 + 1 m × 2.5 × 2 + 0.5 m × 2.5
    expect(threadPerPiece(sheet)).toEqual({ metres: 25.75, unknown: [] });
  });

  test("a stitch whose class has no factor is named", () => {
    expect(threadPerPiece([stitch("Odd", "x", "y", 100, [o("", "join")])])).toEqual({ metres: 0, unknown: ["Odd"] });
  });
});

test("machine families read the register's spellings", () => {
  expect(["4TH O/L", "4THO/L", "4T-O/L"].map(machineFamily)).toEqual(["overlock4", "overlock4", "overlock4"]);
  expect(["5THO/L", "5T-O/L", "SNLS", "SNEC", "IRON", "Helper"].map(machineFamily))
    .toEqual(["overlock5", "overlock5", "lockstitch", "lockstitch", "", ""]);
});
