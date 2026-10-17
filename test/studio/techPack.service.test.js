// The printed tech pack's assembly (services/techpack/techPack.service.js):
// plain data in, plain data out — no database.

"use strict";

const { buildTechPack, applyEdit, constructionRows, letterFor } = require("../../services/techpack/techPack.service");

const id = (n) => n.padStart(24, "0");

const fabricItem = {
  _id: id("a1"),
  name: "Shirting Fabric",
  category: "Fabric",
  description: "65/35 poly-cotton, 120 GSM",
  attributes: [{ name: "Vendor", values: [] }, { name: "Colour", values: [] }],
  primaryVendor: id("f1"),
  variants: [{ _id: id("b1"), combination: ["Mahalaxmi Textile Mills", "Black"], image: "https://img/fabric.jpg", vendorNicknames: [{ vendor: id("f2") }] }],
};
const labelItem = { _id: id("a2"), name: "Shirt Size Label", category: "Label", attributes: [{ name: "Size" }], variants: [{ _id: id("b2"), combination: ["S"] }] };
const tagItem = { _id: id("a3"), name: "Hang Tag Printed", category: "Trim", variants: [{ _id: id("b3"), combination: ["Default"] }] };
const bagItem = { _id: id("a4"), name: "Poly bag 16x20", category: "Packing", variants: [{ _id: id("b4"), combination: [] }] };

const vendors = [{ _id: id("f1"), companyName: "Fallback Mills" }, { _id: id("f2"), companyName: "Mahalaxmi Textile Mills" }];

const bomRows = [
  { rowRef: "R1", category: "FABRIC", rawItemId: id("a1"), rawItemName: "Shirting Fabric", rawItemSku: "RAW-FAB-1", variantId: id("b1"), variantCombination: ["Mahalaxmi Textile Mills", "Black"], appliesTo: "Body, sleeves", consumptionPerPiece: 1.6, consumptionUnit: "m" },
  { rowRef: "R2", category: "LABEL", rawItemId: id("a2"), rawItemName: "Shirt Size Label", rawItemSku: "RAW-LAB-2", variantId: id("b2") },
  { rawItemId: id("a3"), rawItemName: "Hang Tag Printed", rawItemSku: "RAW-TRM-3", variantId: id("b3") },
];

const manifest = {
  construction: [
    { seamId: "s1", name: "Side seam", status: "ready", seamClass: "SS", seamClassName: "Superimposed", allowanceMm: 10, operations: [{ code: "516", stitch: "516 safety stitch", purpose: "join", spi: 12, needles: 2, gaugeMm: 5 }] },
    { seamId: "s2", name: "Sleeve seam", status: "ready", seamClass: "SS", seamClassName: "Superimposed", allowanceMm: 10, operations: [{ code: "516", stitch: "516 safety stitch", purpose: "join", spi: 12, needles: 2, gaugeMm: 5 }] },
    { seamId: "s3", name: "Hem", status: "ready", seamClass: "EF", seamClassName: "Edge finishing", allowanceMm: 20, operations: [{ code: "301", stitch: "301 lockstitch", purpose: "hem", spi: 10 }] },
    { seamId: "s4", name: "Collar join", status: "needs construction", operations: [] },
  ],
};

const style = {
  _id: id("c1"),
  productName: "Mens mandarin collar shirt",
  styleCode: "SC-01",
  sampleType: "customer",
  brief: { gender: "male", fit: "Regular", sizeRange: "XS–XXXL", images: [{ fileId: "ref1", name: "ref.jpg" }] },
  techSheet: { technical: { startedBy: { name: "R&D person" }, materials: [{ rawItemId: id("a2"), variantId: id("b2"), consumptionPerPiece: 1, unit: "pc" }] } },
  materials: { packagingSelections: [{ rowId: "P1", rawItemId: id("a4"), rawItemName: "Poly bag 16x20", variantId: id("b4"), status: "approved", specification: "Printed, 400x500mm" }] },
  studio: {
    designer: { name: "Designer" },
    versions: [
      { version: 1, outcome: "superseded", flats: [], manifest: {} },
      { version: 2, outcome: "pending", sentAt: new Date("2026-10-15"), manifest, flats: [{ kind: "front", fileId: "fs", mimeType: "image/svg+xml" }, { kind: "front", fileId: "fp", mimeType: "image/png" }, { kind: "back", fileId: "bp", mimeType: "image/png" }] },
    ],
  },
  techPack: { season: "AW26", sampleSize: "M", specs: [{ rowKey: "R2", dimensions: "40 x 20 mm", construction: "Woven, hot cut" }] },
};

const build = (over = {}) => buildTechPack({ style, customerName: "TEST – delete later", bomRows, rawItems: [fabricItem, labelItem, tagItem, bagItem], vendors, ...over });

describe("tech pack assembly", () => {
  test("letters run A…Z then AA", () => {
    expect([0, 25, 26, 27].map(letterFor)).toEqual(["A", "Z", "AA", "AB"]);
  });

  test("the header reads each owner", () => {
    const { header } = build();
    expect(header).toMatchObject({
      brand: "TEST – delete later",
      designer: "Designer",
      description: "Men's · Regular fit",
      season: "AW26",
      mainFabric: "Shirting Fabric — Black",
      styleName: "Mens mandarin collar shirt",
      styleNumber: "SC-01",
      sizeRange: "XS–XXXL [M]",
    });
  });

  test("a house sample is the company's own brand", () => {
    const { header } = buildTechPack({ style: { ...style, sampleType: "house" }, customerName: "", companyName: "GRAV Clothing", bomRows, rawItems: [], vendors: [] });
    expect(header.brand).toBe("GRAV Clothing");
  });

  test("BOM rows: lettered, supplier from the variant, colour from the combination, packaging selections appended", () => {
    const { bom, fabricSwatch } = build();
    expect(bom.map((r) => r.letter)).toEqual(["A", "B", "C", "D"]);
    expect(bom[0]).toMatchObject({ item: "Body, sleeves", name: "Shirting Fabric", colour: "Black", code: "RAW-FAB-1", supplier: "Mahalaxmi Textile Mills", image: "https://img/fabric.jpg", qty: { value: 1.6, unit: "m", assumed: true } });
    expect(bom[0].description).toContain("120 GSM");
    // R&D's engineered figure wins over the assumption
    expect(bom[1].qty).toEqual({ value: 1, unit: "pc", assumed: false });
    // no category on the row: read from the item master
    expect(bom[2].category).toBe("TRIM");
    expect(bom[3]).toMatchObject({ category: "SAMPLE_PACKAGING", rowKey: "P1", note: "Printed, 400x500mm" });
    expect(fabricSwatch).toBe("https://img/fabric.jpg");
  });

  test("labels, hang tags and packaging pages split the BOM, with their specs", () => {
    const p = build();
    expect(p.labels.map((r) => r.letter)).toEqual(["B"]);
    expect(p.labels[0].spec).toMatchObject({ dimensions: "40 x 20 mm", construction: "Woven, hot cut", colour: "" });
    expect(p.hangTags.map((r) => r.name)).toEqual(["Hang Tag Printed"]);
    expect(p.packaging.map((r) => r.letter)).toEqual(["D"]);
  });

  test("the sketch is the version under review, SVG preferred", () => {
    const { sketch } = build();
    expect(sketch).toMatchObject({ version: 2, front: { svg: "fs", png: "fp" }, back: { svg: "", png: "bp" } });
  });

  test("construction: identical stitches share a lettered row, unset ones are listed", () => {
    const c = constructionRows(manifest);
    expect(c.rows).toHaveLength(2);
    expect(c.rows[0]).toMatchObject({ letter: "A", seams: ["Side seam", "Sleeve seam"], seamClass: "SS", allowanceMm: 10 });
    expect(c.rows[0].stitches[0]).toMatchObject({ code: "516", needles: 2, gaugeMm: 5, spi: 12 });
    expect(c.rows[1]).toMatchObject({ letter: "B", seams: ["Hem"], purposes: ["hem"] });
    expect(c.pending).toEqual(["Collar join"]);
    expect(constructionRows(undefined)).toEqual({ rows: [], pending: [], stitchCount: 0 });
  });
});

describe("tech pack marks and samples", () => {
  const bare = {
    _id: id("c2"),
    productName: "Shirt",
    brief: { gender: "male", sizeRange: "S–XL" },
    techPack: {
      preview: {
        header: { garmentType: "Shirt" },
        brief: { gsm: "120" },
        rows: { R1: { qty: { value: 1.5, unit: "m" }, image: "data:image/svg+xml,x" } },
        flats: { front: "<svg xmlns='http://www.w3.org/2000/svg'/>" },
        construction: [{ name: "Hem", status: "ready", seamClass: "EF", operations: [{ code: "301", spi: 14, spiTolerance: 1 }] }],
        footer: { disclaimer: "Confidential" },
      },
    },
  };
  const rows = [{ rowRef: "R1", category: "FABRIC", rawItemId: id("a1"), rawItemName: "Fabric", rawItemSku: "F-1", colourOrShade: "Black" }];
  const p = buildTechPack({ style: bare, bomRows: rows });

  test("a real value is unmarked; a sample is yellow; empty is blue", () => {
    expect(p.marks["bom.R1.colour"]).toBeUndefined();
    expect(p.bom[0].qty).toEqual({ value: 1.5, unit: "m", assumed: false });
    expect(p.marks["bom.R1.qty"]).toBe("yellow");
    expect(p.marks["bom.R1.image"]).toBe("yellow");
    expect(p.marks["bom.R1.supplier"]).toBe("blue");
    expect(p.marks["header.season"]).toBe("blue");
    expect(p.bom[0].description).toContain("120 GSM");
    expect(p.marks["bom.R1.description"]).toBe("yellow");
  });

  test("what no record holds is red", () => {
    expect(p.header.description).toBe("Men's · Shirt");
    expect(p.marks["header.description"]).toBe("red");
    expect(p.marks["construction.spiTolerance"]).toBe("red");
    expect(p.marks["footer.disclaimer"]).toBe("red");
    expect(p.footer.disclaimer).toBe("Confidential");
  });

  test("sample flats and construction stand in only where Studio sent none", () => {
    expect(p.sketch.front.dataUri).toMatch(/^data:image\/svg\+xml/);
    expect(p.marks["sketch.front"]).toBe("yellow");
    expect(p.marks["sketch.back"]).toBe("blue");
    expect(p.construction).toMatchObject({ sample: true, rows: [{ seams: ["Hem"] }] });
    expect(p.marks.construction).toBe("yellow");
    // the real version wins
    const real = buildTechPack({ style: { ...bare, studio: style.studio }, bomRows: rows });
    expect(real.construction.sample).toBeUndefined();
    expect(real.marks.construction).toBeUndefined();
    expect(real.sketch.front).toEqual({ svg: "fs", png: "fp" });
  });

  test("the sample block is stored whole, and only as an object", () => {
    const s = { techPack: {} };
    applyEdit(s, { preview: { header: { garmentType: "Shirt" } } }, { rowKeys: new Set() }, {});
    expect(s.techPack.preview).toEqual({ header: { garmentType: "Shirt" } });
    applyEdit(s, { preview: null }, { rowKeys: new Set() }, {});
    expect(s.techPack.preview).toBeUndefined();
    expect(() => applyEdit(s, { preview: [1] }, { rowKeys: new Set() }, {})).toThrow("object");
  });
});

describe("tech pack edits", () => {
  const fresh = () => ({ techPack: { season: "AW26", specs: [{ rowKey: "R2", dimensions: "40 x 20 mm" }] } });
  const keys = { rowKeys: new Set(["R1", "R2"]) };

  test("fields and specs merge; a blank spec is removed", () => {
    const s = fresh();
    applyEdit(s, { sampleSize: " M ", specs: [{ rowKey: "R1", colour: "Black" }, { rowKey: "R2", dimensions: "" }] }, keys, { id: "u1", name: "Umung" });
    expect(s.techPack).toMatchObject({ season: "AW26", sampleSize: "M", updatedBy: { id: "u1", name: "Umung" } });
    expect(s.techPack.specs).toEqual([{ rowKey: "R1", colour: "Black" }]);
  });

  test("a material that is not on the pack is refused", () => {
    expect(() => applyEdit(fresh(), { specs: [{ rowKey: "ZZ", notes: "x" }] }, keys, {})).toThrow("not on this tech pack");
  });

  test("overlong values are refused", () => {
    expect(() => applyEdit(fresh(), { season: "x".repeat(81) }, keys, {})).toThrow("too long");
  });
});

describe("zips from GRAV Studio", () => {
  const zip = { seamId: "s9", stitch: "Fly done up (left front's fly edge to the right front's)", text: "#5 metal zip, closed end, 18.0 cm, tape match fabric", chain: "metal", gauge: 5, ends: "closed", lengthMm: 180, tape: "match fabric", puller: "autolock", note: "" };
  const withZip = (rows) => {
    const versions = style.studio.versions.map((v) => (v.version === 2 ? { ...v, manifest: { ...manifest, zips: [zip] } } : v));
    return buildTechPack({ style: { ...style, studio: { ...style.studio, versions } }, bomRows: rows, rawItems: [fabricItem, labelItem, tagItem, bagItem], vendors });
  };

  test("a zip the BOM has no row for gets its own row, marked red", () => {
    const pack = withZip(bomRows);
    const row = pack.bom[pack.bom.length - 1];
    expect(row).toMatchObject({ letter: letterFor(pack.bom.length - 1), item: "Zip — Fly done up", description: zip.text, colour: "match fabric", studio: zip.text });
    expect(pack.marks[`bom.${row.rowKey}.code`]).toBe("red");
    expect(pack.zips).toHaveLength(1);
    expect(pack.zips[0]).toMatchObject({ stitch: "Fly done up", lengthMm: 180, gauge: 5 });
  });

  test("a zip the BOM already has carries Studio's spec on that row", () => {
    const rows = [...bomRows, { rowRef: "Z1", category: "TRIM", rawItemId: id("a3"), rawItemName: "Metal zipper #5", variantId: id("b3") }];
    const pack = withZip(rows);
    expect(pack.bom).toHaveLength(withZip(bomRows).bom.length);
    expect(pack.bom.find((r) => r.rowKey === "Z1").studio).toBe(zip.text);
  });
});
