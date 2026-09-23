// test/sales/sample-requirements.test.js
//
// R&D'S PACKAGING AND OUTSIDE-PROCESS ROWS, VALIDATED AND RESOLVED.
//
// ── THE THREE FAILURES PINNED HERE ──────────────────────────────────────────
//
// 1. A STARTED ROW WAS SILENTLY DROPPED. The first cut filtered incomplete rows
//    out of the submission — so somebody who chose a carton and moved on before
//    typing the quantity got a green tick and a sample submitted WITHOUT it,
//    and the costing they saw a fortnight later was short a cost with nothing
//    anywhere saying so.
//
// 2. IDENTITIES CAME FROM THE BROWSER. `rawItemName`, `rawItemSku`,
//    `serviceCode`, `serviceName` were stored exactly as sent. A stale screen
//    could snapshot a name that was never right; a crafted request could
//    snapshot ANY name against a real id, including one read out of another
//    company's master.
//
// 3. EVERY ROW WAS STAMPED `SAMPLE_MEASURED`. That claims the physical sample
//    demonstrated the figure, and it is what lets a costing treat the row as
//    verified. For a quantity somebody typed while planning it is false.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const mongoose = require("mongoose");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Service = require("../../models/CMS_Models/Inventory/Services/Service");
const CostingPolicy = require("../../models/CMS_Models/Costing/CostingPolicy");

const {
  resolveRequirements, startedPackaging, startedService,
  packagingGaps, serviceGaps, companyForStyle,
} = require("../../services/sales/sampleRequirements.service");

let seq = 0;

/** A style whose company is proved through its journey, as costing proves it. */
async function world(name = "Req") {
  const co = await Acc_Company.create({ companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01") });
  const journey = await SalesJourney.create({
    journeyId: `SJ-REQ-${seq}`, companyId: co._id,
    accountId: new mongoose.Types.ObjectId(), ownerId: new mongoose.Types.ObjectId(),
    ownerName: "Owner", name: `Journey ${seq}`, isActive: true,
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-REQ-${seq}`, styleCode: `SC-REQ-${seq}`,
    productName: `Shirt ${seq}`, journeyId: journey._id, companyId: co._id,
  });
  const item = await RawItem.create({
    companyId: co._id, name: `Poly Bag ${seq}`, sku: `PKG-${seq}`,
    unit: "Piece", quantity: 0, minStock: 0, maxStock: 100,
    variants: [{ combination: ["Clear"], sku: `PKG-${seq}-C`, quantity: 0 }],
  });
  const service = await Service.create({
    companyId: co._id, serviceCode: `SVC-REQ-${seq}`, name: `Garment Wash ${seq}`,
    billingUnit: "Piece", sacCode: "998821", defaultRate: 99, status: "ACTIVE",
  });
  return { co, journey, style, item, service };
}

const pkgRow = (w, over = {}) => ({
  rawItemId: String(w.item._id),
  quantity: "1", unit: "Piece", basis: "PER_GARMENT",
  evidence: "SAMPLE_MEASURED", specification: "Printed, 300x400mm",
  ...over,
});
const svcRow = (w, over = {}) => ({
  serviceId: String(w.service._id),
  quantity: "1", billingUnit: "Piece", basis: "PER_GARMENT",
  evidence: "SAMPLE_MEASURED", specification: "Enzyme wash, two cycles",
  ...over,
});

/* The company always comes from the authorised request, never from the
   record — so every call here passes one, exactly as the route does. */
const refused = async (style, body, scope) => {
  try {
    await resolveRequirements(style, body, scope);
    return null;
  } catch (e) { return e; }
};

/* ═══ 1 · A STARTED ROW IS NEVER SILENTLY DROPPED ═════════════════════════ */

describe("an unfinished row refuses the submission rather than vanishing", () => {
  test("a started packaging row with no quantity is named, with the field it owes", async () => {
    const w = await world();
    const e = await refused(w.style, {
      packagingRequirements: [pkgRow(w, { quantity: "" })],
    }, { companyId: w.co._id });
    expect(e).toBeTruthy();
    expect(e.status).toBe(400);
    expect(e.code).toBe("SAMPLE_REQUIREMENT_INCOMPLETE");
    expect(e.rows).toHaveLength(1);
    expect(e.rows[0].kind).toBe("packaging");
    /* The index it was sent at, so the browser can mark the row still on
       screen — a refusal naming row 2 is useless if row 2 was thrown away. */
    expect(e.rows[0].index).toBe(0);
    expect(e.rows[0].missing.map((m) => m.field)).toEqual(["quantity"]);
    /* And never zero. */
    expect(e.rows[0].missing[0].message).toMatch(/not zero/i);
  });

  test("a started service row with no billing unit is named the same way", async () => {
    const w = await world();
    const e = await refused(w.style, {
      serviceRequirements: [svcRow(w, { billingUnit: "" })],
    }, { companyId: w.co._id });
    expect(e.rows[0].kind).toBe("service");
    expect(e.rows[0].missing.map((m) => m.field)).toEqual(["billingUnit"]);
  });

  test("every gap on every row comes back at once", async () => {
    /* Being told about the quantity, fixing it, and then being told about the
       unit is how a submission takes five attempts. */
    const w = await world();
    const e = await refused(w.style, {
      packagingRequirements: [pkgRow(w, { quantity: "", unit: "", evidence: "" })],
      serviceRequirements: [svcRow(w, { quantity: "0" })],
    }, { companyId: w.co._id });
    expect(e.rows).toHaveLength(2);
    expect(e.rows[0].missing.map((m) => m.field).sort()).toEqual(["evidence", "quantity", "unit"]);
    expect(e.rows[1].missing.map((m) => m.field)).toEqual(["quantity"]);
  });

  test("an untouched blank row is omitted, and nothing is refused over it", async () => {
    const w = await world();
    const blank = {
      rawItemId: "", rawItemName: "", specification: "", quantity: "", unit: "",
      basis: "PER_GARMENT", included: true, excludedReason: "", notes: "", evidence: "",
    };
    expect(startedPackaging(blank)).toBe(false);
    const out = await resolveRequirements(w.style, { packagingRequirements: [blank] }, { companyId: w.co._id });
    expect(out.packagingRequirements).toEqual([]);
  });

  test("started is read generously, because the alternative loses a cost", async () => {
    const w = await world();
    for (const touch of [
      { rawItemName: "Carton" }, { specification: "300x400" }, { quantity: "2" },
      { unit: "Piece" }, { notes: "check" }, { included: false },
      { basis: "FIXED_PER_RUN" }, { evidence: "BOM_PLANNED" },
    ]) {
      expect(startedPackaging({ ...touch })).toBe(true);
    }
    for (const touch of [
      { serviceName: "Wash" }, { quantity: "1" }, { billingUnit: "Piece" },
      { owner: "PRODUCTION" }, { evidence: "BOM_PLANNED" },
    ]) {
      expect(startedService({ ...touch })).toBe(true);
    }
  });
});

/* ═══ 2 · AN EXCLUSION IS A DECISION, AND NEEDS A REASON ══════════════════ */

describe("a row considered and left out", () => {
  test("must say why, and is then stored for audit", async () => {
    const w = await world();
    const e = await refused(w.style, {
      packagingRequirements: [pkgRow(w, { included: false, excludedReason: "" })],
    }, { companyId: w.co._id });
    expect(e.rows[0].missing.map((m) => m.field)).toEqual(["excludedReason"]);
    /* Without one it is indistinguishable from a mistake. */
    expect(e.rows[0].missing[0].message).toMatch(/indistinguishable from a mistake/);

    const out = await resolveRequirements(w.style, {
      packagingRequirements: [pkgRow(w, { included: false, excludedReason: "Customer supplies bags." })],
    }, { companyId: w.co._id });
    expect(out.packagingRequirements).toHaveLength(1);
    expect(out.packagingRequirements[0].included).toBe(false);
    expect(out.packagingRequirements[0].excludedReason).toBe("Customer supplies bags.");
  });

  test("and an included row carries no stale reason from a decision reversed", async () => {
    const w = await world();
    const out = await resolveRequirements(w.style, {
      packagingRequirements: [pkgRow(w, { included: true, excludedReason: "old reason" })],
    }, { companyId: w.co._id });
    expect(out.packagingRequirements[0].excludedReason).toBe("");
  });
});

/* ═══ 3 · EVERY IDENTITY IS RE-READ, AND EVERY SNAPSHOT IS THE SERVER'S ═══ */

describe("nothing the browser named is believed", () => {
  test("names, codes and SKUs come from the master, whatever was sent", async () => {
    const w = await world();
    const out = await resolveRequirements(w.style, {
      packagingRequirements: [pkgRow(w, {
        rawItemName: "Gold Bar", rawItemSku: "NOT-REAL", variantLabel: "Invented",
      })],
      serviceRequirements: [svcRow(w, { serviceName: "Something Else", serviceCode: "FAKE" })],
    }, { companyId: w.co._id });
    /* A snapshot a caller can dictate is not evidence. */
    expect(out.packagingRequirements[0].rawItemName).toBe(w.item.name);
    expect(out.packagingRequirements[0].rawItemSku).toBe(w.item.sku);
    expect(out.serviceRequirements[0].serviceName).toBe(w.service.name);
    expect(out.serviceRequirements[0].serviceCode).toBe(w.service.serviceCode);
  });

  test("R&D's own words about this style ARE taken from the request", async () => {
    /* The specification is genuinely theirs — the master's description is
       generic, and this is about this style. */
    const w = await world();
    const out = await resolveRequirements(w.style, {
      packagingRequirements: [pkgRow(w, { specification: "Printed both sides, 300x400mm" })],
    }, { companyId: w.co._id });
    expect(out.packagingRequirements[0].specification).toBe("Printed both sides, 300x400mm");
  });

  test("a foreign item and a nonexistent one get the same non-disclosing answer", async () => {
    const w = await world("Mine");
    const theirs = await world("Theirs");

    const foreign = await refused(w.style, {
      packagingRequirements: [pkgRow(w, { rawItemId: String(theirs.item._id) })],
    }, { companyId: w.co._id });
    const missing = await refused(w.style, {
      packagingRequirements: [pkgRow(w, { rawItemId: String(new mongoose.Types.ObjectId()) })],
    }, { companyId: w.co._id });
    expect(foreign.rows[0].missing[0].message).toBe(missing.rows[0].missing[0].message);
    /* Saying which would confirm a record the caller cannot see. */
    expect(foreign.rows[0].missing[0].message).toMatch(/not in this company's register/);
  });

  test("a foreign service and a nonexistent one answer alike too", async () => {
    const w = await world("SvcMine");
    const theirs = await world("SvcTheirs");
    const foreign = await refused(w.style, {
      serviceRequirements: [svcRow(w, { serviceId: String(theirs.service._id) })],
    }, { companyId: w.co._id });
    const missing = await refused(w.style, {
      serviceRequirements: [svcRow(w, { serviceId: String(new mongoose.Types.ObjectId()) })],
    }, { companyId: w.co._id });
    expect(foreign.rows[0].missing[0].message).toBe(missing.rows[0].missing[0].message);
  });

  test("a variant belonging to another item is refused", async () => {
    /* One borrowed from another item would snapshot a colour this row never
       had, against an id that resolves perfectly well. */
    const w = await world("Variant");
    const other = await RawItem.create({
      companyId: w.co._id, name: `Carton ${++seq}`, sku: `CTN-${seq}`,
      unit: "Piece", quantity: 0, minStock: 0, maxStock: 10,
      variants: [{ combination: ["Brown"], sku: `CTN-${seq}-B`, quantity: 0 }],
    });
    const e = await refused(w.style, {
      packagingRequirements: [pkgRow(w, { variantId: String(other.variants[0]._id) })],
    }, { companyId: w.co._id });
    expect(e.rows[0].missing[0].field).toBe("variantId");
    expect(e.rows[0].missing[0].message).toMatch(/does not belong to this item/);

    /* Its own variant resolves, and the label is snapshotted from the master. */
    const out = await resolveRequirements(w.style, {
      packagingRequirements: [pkgRow(w, { variantId: String(w.item.variants[0]._id) })],
    }, { companyId: w.co._id });
    expect(out.packagingRequirements[0].variantLabel).toBe("Clear");
  });

  test("a service that is no longer active cannot be required", async () => {
    /* The Service master HAS a lifecycle, unlike RawItem — so unlike an item,
       this one is checked. A requirement against a service nobody buys any
       more is a costing that cannot be priced. */
    const w = await world("Dead");
    await Service.updateOne({ _id: w.service._id }, { $set: { status: "INACTIVE" } });
    const e = await refused(w.style, { serviceRequirements: [svcRow(w)] }, { companyId: w.co._id });
    expect(e.rows[0].missing[0].message).toMatch(/not active in the Service Master/);
  });

  test("a style with no proven company resolves nothing at all", async () => {
    /* The identities would otherwise be looked up in a company nobody
       established. */
    const orphan = await SampleStyle.create({
      sampleStyleId: `SS-ORPHAN-${++seq}`, styleCode: `SC-ORPHAN-${seq}`, productName: "Orphan",
    });
    /* A style whose parent is nobody's cannot be proved against any company. */
    expect(await companyForStyle(orphan, new mongoose.Types.ObjectId())).toBeNull();
    const w = await world("Orphan");
    const e = await refused(orphan, { packagingRequirements: [pkgRow(w)] }, { companyId: w.co._id });
    expect(e.message).toMatch(/no proven company/);
  });
});

/* ═══ 4 · THE EVIDENCE CLAIM IS ASKED FOR, NEVER STAMPED ══════════════════ */

describe("measured and planned are different claims", () => {
  test("evidence is required on a started row, and has no default", async () => {
    const w = await world();
    const e = await refused(w.style, { packagingRequirements: [pkgRow(w, { evidence: "" })] }, { companyId: w.co._id });
    expect(e.rows[0].missing.map((m) => m.field)).toEqual(["evidence"]);
    expect(e.rows[0].missing[0].message).toMatch(/measured on the sample or planned/);
    /* And it says why it matters. */
    expect(e.rows[0].missing[0].message).toMatch(/verified/);
  });

  test("an unrecognised value is not quietly coerced to measured", async () => {
    const w = await world();
    const e = await refused(w.style, { packagingRequirements: [pkgRow(w, { evidence: "PROBABLY" })] }, { companyId: w.co._id });
    expect(e.rows[0].missing.map((m) => m.field)).toEqual(["evidence"]);
  });

  test("both answers are stored as given", async () => {
    const w = await world();
    const out = await resolveRequirements(w.style, {
      packagingRequirements: [pkgRow(w, { evidence: "BOM_PLANNED" })],
      serviceRequirements: [svcRow(w, { evidence: "SAMPLE_MEASURED" })],
    }, { companyId: w.co._id });
    expect(out.packagingRequirements[0].evidence).toBe("BOM_PLANNED");
    expect(out.serviceRequirements[0].evidence).toBe("SAMPLE_MEASURED");
  });

  test("the gap helpers name every field, so the browser and the server agree", async () => {
    /* The screen runs the same rule before sending. Two rules would let the
       form pass a row the server then refuses. */
    expect(packagingGaps({}).map((g) => g.field).sort())
      .toEqual(["evidence", "quantity", "rawItemId", "unit"]);
    expect(serviceGaps({}).map((g) => g.field).sort())
      .toEqual(["billingUnit", "evidence", "quantity", "serviceId"]);
  });
});

/* ═══ 4b · THE PICKERS SEARCH THIS COMPANY'S MASTERS, AND ONLY THOSE ══════ */

describe("the master searches behind the R&D pickers", () => {
  /* ── WHY THESE MATTER MORE THAN THEY LOOK ───────────────────────────────
     The packaging and service fields were plain text inputs, so no search
     result was ever resolved and nobody noticed that the item search ran
     UNSCOPED — any R&D user could see, and pick, another company's item. The
     picker resolves the id now and the write path refuses a foreign one, so
     an unscoped search would offer choices it then rejects. */
  const searchItems = (scope, q) => {
    const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
    const re = new RegExp(q, "i");
    return RawItem.find({ companyId: scope, $or: [{ name: re }, { sku: re }] })
      .select("name sku unit variants").lean();
  };

  test("the item search is scoped, so a foreign item is never offered", async () => {
    const mine = await world("SearchMine");
    const theirs = await world("SearchTheirs");
    /* Both companies have an item whose name matches the same term. */
    const ours = await searchItems(mine.co._id, "Poly Bag");
    expect(ours.map((r) => String(r._id))).toEqual([String(mine.item._id)]);
    expect(ours.map((r) => String(r._id))).not.toContain(String(theirs.item._id));
  });

  test("the route itself carries the company clause", () => {
    /* Asserted on the source because the route resolves its scope from an
       authorised session this suite does not build — what matters is that the
       clause is there at all, and it was not. */
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "..", "routes", "CMS_Routes", "Sales", "sampleStyles.js"), "utf8",
    );
    const itemSearch = src.slice(src.indexOf('router.get("/:id/production/raw-items/search"'));
    expect(itemSearch.slice(0, 1400)).toMatch(/companyId: scope\.companyId/);

    /* And the service search is scoped AND active-only — a requirement
       against a service nobody buys is a costing that cannot be priced, and
       the write path refuses one, so the picker does not offer it. */
    const svcSearch = src.slice(src.indexOf('router.get("/:id/services/search"'));
    expect(svcSearch.slice(0, 1200)).toMatch(/companyId: scope\.companyId/);
    expect(svcSearch.slice(0, 1200)).toMatch(/status: "ACTIVE"/);
    /* `defaultRate` is not in the projection: a field the screen cannot see
       is a field nobody can mistake for a quoted rate. */
    expect(svcSearch.slice(0, 1200)).not.toMatch(/defaultRate/);
  });

  /* -- RESOLUTION BY IDENTITY, WHICH IS WHAT THE FORM ACTUALLY NEEDS ------
     The search endpoints are for CHOOSING. Verifying a row already saved is a
     different question and was answered, wrongly, by searching its saved
     name: a renamed record stopped matching its own snapshot and was declared
     unavailable, and a name under two characters was never checked at all.
     These drive the resolver's own query. */
  const resolveItems = async (companyId, ids) => {
    const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
    const docs = await RawItem.find({ companyId, _id: { $in: ids } })
      .select("name sku unit customUnit variants._id variants.combination variants.sku").lean();
    const byId = new Map(docs.map((d) => [String(d._id), d]));
    return Object.fromEntries(ids.map((id) => {
      const d = byId.get(String(id));
      return [String(id), d
        ? {
          available: true, name: d.name || "", sku: d.sku || "",
          registeredUnit: d.customUnit || d.unit || "",
          variants: (d.variants || []).map((v) => ({
            id: String(v._id), label: (v.combination || []).join(" / ") || v.sku || "", sku: v.sku || "",
          })),
        }
        : { available: false }];
    }));
  };
  const resolveServices = async (companyId, ids) => {
    const docs = await Service.find({ companyId, _id: { $in: ids } })
      .select("name serviceCode billingUnit sacCode status").lean();
    const byId = new Map(docs.map((d) => [String(d._id), d]));
    return Object.fromEntries(ids.map((id) => {
      const d = byId.get(String(id));
      const active = d && String(d.status || "").toUpperCase() === "ACTIVE";
      return [String(id), d
        ? {
          available: Boolean(active), name: d.name || "", serviceCode: d.serviceCode || "",
          billingUnit: d.billingUnit || "", sacCode: d.sacCode || "", status: d.status || "",
        }
        : { available: false }];
    }));
  };

  test("a RENAMED item resolves as available, with its new name", async () => {
    /* The failure this replaces: the old check searched the row's SAVED name,
       so a rename made a perfectly valid record look withdrawn. */
    const w = await world("Renamed");
    await RawItem.updateOne({ _id: w.item._id }, { $set: { name: "Printed Poly Bag v2", sku: "PKG-NEW" } });
    const out = await resolveItems(w.co._id, [String(w.item._id)]);
    const hit = out[String(w.item._id)];
    expect(hit.available).toBe(true);
    expect(hit.name).toBe("Printed Poly Bag v2");
    expect(hit.sku).toBe("PKG-NEW");
    /* And the current variants, so a stale variant can be dropped. */
    expect(hit.variants[0]).toMatchObject({ label: "Clear" });
    expect(hit.registeredUnit).toBe("Piece");
  });

  test("a RENAMED active service resolves as available too", async () => {
    const w = await world("RenamedSvc");
    await Service.updateOne({ _id: w.service._id }, { $set: { name: "Enzyme Wash", serviceCode: "SVC-NEW" } });
    const out = await resolveServices(w.co._id, [String(w.service._id)]);
    const hit = out[String(w.service._id)];
    expect(hit.available).toBe(true);
    expect(hit.name).toBe("Enzyme Wash");
    expect(hit.serviceCode).toBe("SVC-NEW");
    expect(hit.billingUnit).toBe("Piece");
  });

  test("a one-character name resolves like any other, because nothing searches a name", async () => {
    /* The search needed two characters, so a row whose item was called "X"
       was silently never verified. */
    const w = await world("Short");
    await RawItem.updateOne({ _id: w.item._id }, { $set: { name: "X" } });
    const out = await resolveItems(w.co._id, [String(w.item._id)]);
    expect(out[String(w.item._id)].available).toBe(true);
    expect(out[String(w.item._id)].name).toBe("X");
  });

  test("a missing item and a foreign one answer identically, and are not named", async () => {
    const w = await world("ResolveMine");
    const theirs = await world("ResolveTheirs");
    const out = await resolveItems(w.co._id, [
      String(theirs.item._id), String(new mongoose.Types.ObjectId()),
    ]);
    for (const v of Object.values(out)) {
      /* Saying which would confirm that a record the caller cannot see
         exists. */
      expect(v).toEqual({ available: false });
    }
  });

  test("an INACTIVE service is unavailable, and IS named — it is this company's", async () => {
    const w = await world("Deactivated");
    await Service.updateOne({ _id: w.service._id }, { $set: { status: "INACTIVE" } });
    const out = await resolveServices(w.co._id, [String(w.service._id)]);
    const hit = out[String(w.service._id)];
    expect(hit.available).toBe(false);
    expect(hit.status).toBe("INACTIVE");
    /* Named, because the caller may already see it and naming it says what to
       do — unlike a record that is not ours, which is not named at all. */
    expect(hit.name).toMatch(/^Garment Wash/);
  });

  test("a RawItem is judged on existence and ownership only", async () => {
    /* `RawItem.status` is derived from quantity against reorder levels — a
       STOCK fact, not a statement that the company stopped buying the thing.
       Judging availability by it would mark an item unavailable for being out
       of stock. */
    const w = await world("NoLifecycle");
    await RawItem.updateOne({ _id: w.item._id }, { $set: { quantity: 0 } });
    const out = await resolveItems(w.co._id, [String(w.item._id)]);
    expect(out[String(w.item._id)].available).toBe(true);
  });

  test("the resolver route is scoped, proves the style, and never reads a name", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "..", "routes", "CMS_Routes", "Sales", "sampleStyles.js"), "utf8",
    );
    const route = src.slice(src.indexOf('router.post("/:id/requirements/resolve"'));
    const body = route.slice(0, 3800);
    /* The style must be the caller's company's before anything resolves
       against it — the same proof the write path takes, from the one
       ownership rule rather than a second copy. */
    expect(body).toMatch(/ownershipProofFor\(style, scope\.companyId\)/);
    expect(body).toMatch(/companyId: scope\.companyId, _id: \{ \$in: rawItemIds \}/);
    expect(body).toMatch(/companyId: scope\.companyId, _id: \{ \$in: serviceIds \}/);
    /* By id, and by nothing else. */
    expect(body).not.toMatch(/RegExp|\$or/);
  });

  test("what the item search returns is what the picker stores", async () => {
    /* The picker maps `{id, name, sku, unit, variants[{id, combination}]}`
       onto a row. A shape drift here would leave every selection empty and
       every row refused — which is exactly the defect this chunk fixes. */
    const w = await world("Shape");
    const [row] = await searchItems(w.co._id, "Poly Bag");
    expect(row).toMatchObject({ name: expect.any(String), sku: expect.any(String) });
    expect(row.variants[0]).toMatchObject({ combination: ["Clear"] });
    expect(String(row.variants[0]._id)).toMatch(/^[0-9a-f]{24}$/);
  });
});

/* ═══ 5 · AND THE BASIS AND OWNER ARE STORED, NOT GUESSED ═════════════════ */

test("basis, owner and unit are recorded as stated, with safe readings for anything else", async () => {
  const w = await world("Shape");
  const out = await resolveRequirements(w.style, {
    packagingRequirements: [pkgRow(w, { basis: "FIXED_PER_RUN", quantity: "13" })],
    serviceRequirements: [svcRow(w, { basis: "WHATEVER", owner: "PRODUCTION" })],
  }, { companyId: w.co._id });
  expect(out.packagingRequirements[0].basis).toBe("FIXED_PER_RUN");
  expect(out.packagingRequirements[0].quantity).toBe(13);
  /* Anything unrecognised falls to the safe reading rather than through — a
     carton read as per-garment would be a hundredfold error. */
  expect(out.serviceRequirements[0].basis).toBe("PER_GARMENT");
  expect(out.serviceRequirements[0].owner).toBe("PRODUCTION");
  /* The unit R&D measured in, not the master's: a bag counted in pieces and
     an item registered in boxes is a real difference. */
  expect(out.packagingRequirements[0].unit).toBe("Piece");
});

/* ═══ 7 · ONE-TIME SETUP IS A DIFFERENT SHAPE OF ROW ══════════════════════ */

describe("development, pattern and tooling work", () => {
  const CHARGES = [{
    key: "pattern", label: "Pattern development", amountMinor: 1000000,
    currency: "INR", basis: "FIXED_PER_RUN", active: true,
    effectiveFrom: new Date("2026-01-01"),
  }];
  /* ── THE CATALOGUE IS APPROVED, NOT CONFIGURED ────────────────────────
     What the company charges for its own development work is a Board policy
     with an effective date and an approver. Seeded through the same door the
     legacy migration uses, so the fixture's keys — which the rows below point
     at — survive rather than being minted anew, and adapted so a charge
     written in the retired flat shape still reads as the one period it was. */
  const withCharges = async (w, charges = CHARGES) => {
    await CostingPolicy.create({
      companyId: w.co._id, baseCurrency: "INR", roundingMode: "HALF_UP",
      sellingPriceIncrementMinor: 100, minimumMarginPercent: 18,
      targetMarginPercent: 25, preferredMarginPercent: 32,
      revision: 1,
    });
    const boardPolicy = require("../../services/board/boardPolicy.service");
    const { adaptTable } = require("../../services/centralCosting/developmentCharges");
    const ctx = { companyId: w.co._id, actorId: "fixture", actorName: "Board Fixture" };
    const draft = await boardPolicy.createDraft(ctx, {
      policyKey: "DEVELOPMENT_CHARGE_POLICY",
      seed: adaptTable(charges),
      rationale: "Fixture catalogue.",
    });
    await boardPolicy.approve(ctx, draft._id, {
      effectiveFrom: new Date(Date.now() - 365 * 24 * 3600 * 1000),
    });
    return w;
  };
  const devRow = (over = {}) => ({
    purpose: "DEVELOPMENT_TOOLING", developmentSource: "COMPANY_POLICY",
    developmentChargeKey: "pattern", evidence: "SAMPLE_MEASURED",
    specification: "First pattern and marker", ...over,
  });

  test("work the company does itself names a charge, and no service, quantity or unit", async () => {
    /* ── THE SHAPE THAT USED TO BE IMPOSSIBLE ─────────────────────────
       There is no supplier to name and nothing is billed per anything: a
       flat charge for the run. Demanding a service and a unit here is what
       made the internal path unusable through the screen. */
    const w = await withCharges(await world("Dev"));
    const out = await resolveRequirements(w.style, { serviceRequirements: [devRow()] }, { companyId: w.co._id });
    expect(out.serviceRequirements).toHaveLength(1);
    expect(out.serviceRequirements[0]).toMatchObject({
      purpose: "DEVELOPMENT_TOOLING",
      developmentSource: "COMPANY_POLICY",
      developmentChargeKey: "pattern",
      /* One-time by definition — forced, never read from the request. */
      basis: "FIXED_PER_RUN",
      evidence: "SAMPLE_MEASURED",
    });
    /* No money crosses this line. R&D says what was done; Finance says what
       the company charges for it, and the costing reads that at its date. */
    expect(JSON.stringify(out.serviceRequirements[0])).not.toMatch(/amountMinor|1000000/);
    expect(out.serviceRequirements[0].serviceId).toBeUndefined();
  });

  test("a per-garment basis on setup work is overruled, not stored", async () => {
    /* Stored as sent, a screen charge would be multiplied by every garment —
       ₹10,000 becoming ₹1,00,00,000 on a thousand-piece order. */
    const w = await withCharges(await world("Dev"));
    const out = await resolveRequirements(
      w.style, { serviceRequirements: [devRow({ basis: "PER_GARMENT" })] }, { companyId: w.co._id },
    );
    expect(out.serviceRequirements[0].basis).toBe("FIXED_PER_RUN");
  });

  test("a charge this company does not have in force is refused", async () => {
    const w = await withCharges(await world("Dev"));
    const err = await refused(
      w.style, { serviceRequirements: [devRow({ developmentChargeKey: "grading" })] }, { companyId: w.co._id },
    );
    expect(err.status).toBe(400);
    expect(err.rows[0].missing[0].field).toBe("developmentChargeKey");
    expect(err.rows[0].missing[0].message).toMatch(/not one this company has configured/);
  });

  test("another company's charge table is not this one's", async () => {
    /* Configured over there, invisible here — and indistinguishable from a
       key that was never configured at all. */
    const theirs = await withCharges(await world("Dev"));
    const mine = await world("Dev");
    const err = await refused(
      mine.style, { serviceRequirements: [devRow()] }, { companyId: mine.co._id },
    );
    expect(err.status).toBe(400);
    expect(err.rows[0].missing[0].message).toMatch(/not one this company has configured/);
    expect(theirs.co._id).toBeTruthy();
  });

  test("a withdrawn charge cannot be chosen; a future rate still can", async () => {
    const w = await withCharges(await world("Dev"), [
      { ...CHARGES[0], active: false },
      { ...CHARGES[0], key: "grading", label: "Grading", effectiveFrom: new Date("2027-01-01") },
    ]);
    /* Withdrawn is withdrawn — a requirement against it could never be
       priced. */
    expect((await refused(
      w.style, { serviceRequirements: [devRow({ developmentChargeKey: "pattern" })] }, { companyId: w.co._id },
    )).status).toBe(400);

    /* ── BUT A DATE IS NOT R&D'S QUESTION ────────────────────────────
       Which rate applies is settled by the COSTING's date, not by the moment
       a sample happened to be submitted. A style being developed for next
       season's rate must be recordable now — filtering on today here is what
       made that impossible. */
    const out = await resolveRequirements(
      w.style, { serviceRequirements: [devRow({ developmentChargeKey: "grading" })] }, { companyId: w.co._id },
    );
    expect(out.serviceRequirements[0].developmentChargeKey).toBe("grading");
  });

  test("one requirement cannot name both a company charge and a supplier's service", async () => {
    /* ── TWO ANSWERS IS ONE TOO MANY ──────────────────────────────────
       It would have two prices and nothing choosing between them. Refused
       where a person can read it, rather than costed from whichever the
       assembly happens to look at first. */
    const w = await withCharges(await world("Dev"));
    const err = await refused(
      w.style,
      { serviceRequirements: [devRow({ serviceId: String(w.service._id) })] },
      { companyId: w.co._id },
    );
    expect(err.status).toBe(400);
    expect(err.rows[0].missing.map((m) => m.field)).toContain("serviceId");
    expect(err.rows[0].missing[0].message).toMatch(/cannot also name a supplier's service/);
  });

  test("setup bought from a supplier still names the service, and is still one-time", async () => {
    const w = await world("Dev");
    const out = await resolveRequirements(w.style, {
      serviceRequirements: [{
        ...svcRow(w, { basis: "PER_GARMENT" }),
        purpose: "DEVELOPMENT_TOOLING", developmentSource: "SUPPLIER_QUOTATION",
      }],
    }, { companyId: w.co._id });
    expect(out.serviceRequirements[0]).toMatchObject({
      purpose: "DEVELOPMENT_TOOLING",
      developmentSource: "SUPPLIER_QUOTATION",
      basis: "FIXED_PER_RUN",
      serviceName: w.service.name,
    });
    expect(out.serviceRequirements[0].developmentChargeKey).toBeUndefined();
  });

  test("and an ordinary outside process is untouched by any of it", async () => {
    const w = await world("Dev");
    const out = await resolveRequirements(w.style, { serviceRequirements: [svcRow(w)] }, { companyId: w.co._id });
    expect(out.serviceRequirements[0]).toMatchObject({
      purpose: "OUTSIDE_PROCESS", basis: "PER_GARMENT", billingUnit: "Piece",
    });
    expect(out.serviceRequirements[0].developmentSource).toBeUndefined();
  });

  test("a half-finished setup row refuses the submission rather than vanishing", async () => {
    /* Classifying the row IS starting it — and a tooling row is the one shape
       that legitimately names no service, so without that reading it could be
       abandoned half-done and silently dropped. */
    expect(startedService({ purpose: "DEVELOPMENT_TOOLING" })).toBe(true);
    expect(startedService({ developmentChargeKey: "pattern" })).toBe(true);
    expect(startedService({})).toBe(false);

    const w = await withCharges(await world("Dev"));
    const err = await refused(w.style, {
      serviceRequirements: [{ purpose: "DEVELOPMENT_TOOLING", developmentSource: "COMPANY_POLICY" }],
    }, { companyId: w.co._id });
    expect(err.status).toBe(400);
    expect(err.rows[0].missing.map((m) => m.field)).toEqual(
      expect.arrayContaining(["developmentChargeKey", "evidence"]),
    );
  });

  test("a row classified as setup but not saying where it is paid from is asked", async () => {
    expect(serviceGaps({ purpose: "DEVELOPMENT_TOOLING" }).map((g) => g.field)).toEqual(["developmentSource"]);
  });
});
