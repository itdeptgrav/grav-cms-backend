// test/industrial-engineering/ie-manufacturing-inputs.route.test.js
//
// WHAT IE WAS GIVEN TO ENGINEER FROM — the manufacturing-inputs contract.
//
// The development detail endpoint grew a third top-level block carrying the
// facts a factory engineer needs: the garment brief, the decoration asked for,
// the materials at their engineered consumption, the technical pack, the
// outside processes, the development tooling, what the sample proved, how it is
// packed, and the route somebody has already written down.
//
// The claims worth holding, and each is a way this could be wrong rather than
// a restatement of the code:
//
//   · it publishes the APPROVED frozen revision when there is one, and names a
//     draft as a draft when there is not — never the draft in silence;
//   · an empty list is not an answer: only a signed decision may say
//     NOT_REQUIRED, and everything else is UNKNOWN with the desk that owes the
//     answer named;
//   · no money, no buyer, no supplier and no payroll figure crosses, including
//     the operator salary that sits on the very sample rows it publishes;
//   · another company's style is indistinguishable from an absent one;
//   · and reading writes nothing.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const { DevelopmentFile } = require("../../models/CMS_Models/Merchandising/Development");

const manufacturing = require("../../services/industrialEngineering/ieDevelopmentManufacturing");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/ie", require("../../routes/CMS_Routes/IndustrialEngineering/ieRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/ie`;
});

afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (path, { token, company } = {}) =>
  fetch(`${base}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
    },
  }).then(async (r) => {
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text || "null"); } catch { parsed = { nonJson: true }; }
    return { status: r.status, body: parsed };
  });

async function actor({ companies = [], grants = {} } = {}) {
  const n = ++seq;
  const email = `iemi${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "I", lastName: `M${n}`, email, biometricId: `IEMI${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "I" });
  }
  for (const [departmentSlug, role] of Object.entries(grants)) {
    await DepartmentRole.create({
      departmentSlug, email, name: "User", role, isActive: true,
      departmentId: new mongoose.Types.ObjectId(),
    });
  }
  return {
    email,
    token: jwt.sign(
      { id: String(emp._id), email, name: "IE Actor", role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

async function company(name) {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `${name} ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const accountId = new mongoose.Types.ObjectId();
  const journey = await SalesJourney.create({
    journeyId: `SJ-${name}-${n}`, companyId: co._id, accountId,
    ownerId: new mongoose.Types.ObjectId(), ownerName: "Owner",
    name: `Journey ${name}`, isActive: true,
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-${name}-${n}`, journeyId: journey._id, accountId,
    companyId: co._id, title: `Enquiry ${name}`, isActive: true,
    products: [{ product: "Polo", quantity: 500 }],
  });
  return { co, journey, enquiry };
}

const ieViewer = (co) => actor({ companies: [co], grants: { ie: "viewer" } });

/* ══ FIXTURES — a populated polo, and a bare style ════════════════════════
 *
 * The populated one carries every group: a brief, an embroidery requirement
 * with its artwork, an approved frozen revision with engineered consumption
 * and a route, an outside process with a signed decision, tooling, packing,
 * and a sample with photographs — and, deliberately, the payroll figures that
 * sit on the sample's own operation rows, so the leak test has something real
 * to catch. */
const APPROVED_SNAPSHOT = {
  revision: 2,
  materials: [
    {
      rawItemId: new mongoose.Types.ObjectId(), rawItemName: "220 GSM cotton-rich pique",
      rawItemSku: "FAB-PIQUE-220", specification: "Bio-washed, navy 19-3921 TCX",
      consumptionPerPiece: 1.35, unit: "m", allowancePercent: 7,
      appliesToAllVariants: true, appliesToVariantLabels: [],
      returnedToMaterials: null,
    },
    {
      rawItemId: new mongoose.Types.ObjectId(), rawItemName: "Matt navy button 18L",
      rawItemSku: "BTN-NVY-18L", specification: "Two-hole, tone on tone",
      /* Allowance NOT stated — null must survive as null, never become 0. */
      consumptionPerPiece: 3, unit: "pc", allowancePercent: null,
      appliesToAllVariants: false, appliesToVariantLabels: ["Navy"],
      returnedToMaterials: { reason: "Shade band not attached", at: new Date("2026-09-02") },
    },
  ],
  operations: [
    { operationId: new mongoose.Types.ObjectId(), operationCode: "OP-10", name: "Run collar",
      machineType: "SNLS", minutes: 1, seconds: 12, samMinutes: 1.2, notes: "" },
    { operationId: new mongoose.Types.ObjectId(), operationCode: "OP-20", name: "Attach placket",
      machineType: "SNLS", minutes: 0, seconds: 48, samMinutes: 0.8, notes: "Guide folder" },
  ],
  requirements: [],
  file: { name: "NW-POLO-26 technical pack.pdf", url: "https://files.test/techpack.pdf", uploadedAt: new Date("2026-09-10") },
};

async function populatedStyle(world, over = {}) {
  const n = ++seq;
  return SampleStyle.create({
    sampleStyleId: `SS-MI-${n}`,
    productName: `Pique polo ${n}`, styleCode: `NW-POLO-${n}`,
    variantLabel: "Navy", variantKey: `v${n}`,
    journeyId: world.journey._id, enquiryId: world.enquiry._id,
    stage: "rnd",
    brief: {
      note: "Navy cotton-rich pique polo for Northwind Workwear.",
      quantity: 500,
      colour: "Navy", fabricPreference: "Cotton-rich pique, bio-washed",
      fabricComposition: "60% cotton / 40% polyester", gsm: "220",
      fit: "Regular", sizeRange: "S-XXL", gender: "unisex",
      trims: "Matt navy buttons; soft-edge woven main label",
      specialConstruction: "Two-piece rib collar; reinforced shoulder tape",
      existingUniform: "Current Northwind polo, 2024 issue",
      embroidery: true,
      customSpecs: [{ label: "Collar recovery", value: "Checked on fit sample" }],
      images: [{ name: "front.png", url: "https://files.test/front.png", publicId: "demo/front" }],
      brandingRequirements: [{
        ref: "NW-EMB-01", type: "Embroidery", placement: "Left chest",
        width: 68, height: 54, unit: "mm", colourNotes: "Ivory and rust",
        notes: "Buyer crest", artworkState: "Buyer reference received",
        artwork: [{ name: "crest.png", url: "https://files.test/crest.png", publicId: "demo/crest" }],
        legacy: false,
      }],
      /* The schema's default, stated: nothing in `artwork` is production art. */
      artworkIsCustomerReference: true,
    },
    materials: {
      status: "selected",
      packagingSelections: [{
        rowId: "pkg-1", rawItemId: new mongoose.Types.ObjectId(),
        rawItemName: "Clear polybag", rawItemSku: "PKG-01",
        specification: "Printed poly bag 300x400mm", status: "approved",
      }],
      packingConfiguration: { revision: 2, garmentsPerCarton: 40, notes: "" },
      packagingDecision: {
        required: true, reason: "", decidedBy: { id: new mongoose.Types.ObjectId(), name: "M Rao" },
        decidedAt: new Date("2026-09-11"),
      },
    },
    sample: {
      status: "approved",
      rounds: [
        { roundNo: 1, type: "proto", outcome: "rejected", feedback: "Collar roll", madeAt: new Date("2026-08-20"), images: [] },
        { roundNo: 2, type: "fit", outcome: "accepted", feedback: "Approved", madeAt: new Date("2026-09-01"),
          images: [{ name: "r2.png", url: "https://files.test/r2.png" }] },
      ],
      photos: [{ name: "sample.png", url: "https://files.test/sample.png", publicId: "demo/sample" }],
      consumptionRawItems: [{ rawItemName: "220 GSM pique", quantity: 1.4, unit: "m", allowancePercent: 0 }],
      /* Payroll rides on these rows upstream. None of it may cross. */
      operations: [{
        type: "Embroider crest", operationCode: "EMB-01", machineType: "EMB",
        minutes: 4, seconds: 30, totalSeconds: 270,
        salaryDept: "Production", salaryDesig: "Operator A",
        operatorSalary: 21000, operatorCost: 13.4,
      }],
      serviceRequirements: [
        { rowId: "svc-1", serviceId: new mongoose.Types.ObjectId(), serviceCode: "SVC-EMB",
          serviceName: "Embroidery — flat", purpose: "OUTSIDE_PROCESS",
          specification: "68mm crest, ivory and rust", quantity: 1, billingUnit: "piece",
          basis: "PER_GARMENT", owner: "PRODUCTION", included: true, excludedReason: "", notes: "" },
        { rowId: "svc-2", serviceId: new mongoose.Types.ObjectId(), serviceCode: "SVC-WASH",
          serviceName: "Garment wash", purpose: "OUTSIDE_PROCESS",
          specification: "", quantity: null, billingUnit: "", basis: "PER_GARMENT",
          owner: "PRODUCTION", included: false, excludedReason: "Not required on pique", notes: "" },
        { rowId: "tool-1", developmentSource: "COMPANY_POLICY", developmentChargeKey: "PATTERN_SET",
          serviceName: "Pattern development", purpose: "DEVELOPMENT_TOOLING",
          specification: "Full size set", quantity: 1, billingUnit: "set",
          basis: "FIXED_PER_RUN", owner: "RND", included: true, excludedReason: "", notes: "" },
      ],
      packagingRequirements: [{
        rowId: "pr-1", sourceSelectionRowId: "pkg-1", rawItemName: "Clear polybag",
        specification: "One per garment", quantity: 1, unit: "pc",
        basis: "PER_GARMENT", evidence: "SAMPLE_MEASURED", included: true,
      }],
      outsideProcessDecision: {
        required: true, reason: "", decidedBy: { id: new mongoose.Types.ObjectId(), name: "P Kumar" },
        decidedAt: new Date("2026-09-12"),
      },
      developmentDecision: {
        required: true, reason: "", decidedBy: { id: new mongoose.Types.ObjectId(), name: "M Rao" },
        decidedAt: new Date("2026-09-12"),
      },
    },
    techSheet: {
      status: "approved",
      file: { name: "draft pack.pdf", url: "https://files.test/draft.pdf", uploadedAt: new Date("2026-09-01") },
      technical: {
        status: "approved", revision: 2,
        materials: [{ rawItemId: new mongoose.Types.ObjectId(), rawItemName: "DRAFT ROW ONLY", consumptionPerPiece: 9.99, unit: "m" }],
        operations: [{ operationId: new mongoose.Types.ObjectId(), operationCode: "DRAFT-OP", name: "Draft only", minutes: 9, seconds: 0 }],
      },
      technicalRevisions: [{
        revision: 2, submittedAt: new Date("2026-09-05"), decidedAt: new Date("2026-09-10"),
        outcome: "approved", snapshot: APPROVED_SNAPSHOT,
        file: APPROVED_SNAPSHOT.file,
      }],
    },
    ...over,
  });
}

/** A style nobody upstream has filled in. */
async function bareStyle(world) {
  const n = ++seq;
  return SampleStyle.create({
    sampleStyleId: `SS-BARE-${n}`, productName: `Bare tee ${n}`, styleCode: `BARE-${n}`,
    variantLabel: "White", variantKey: `b${n}`,
    journeyId: world.journey._id, enquiryId: world.enquiry._id,
    stage: "brief",
    techSheet: { technical: { status: "not_started" } },
  });
}

const detail = (styleDoc, who, world) =>
  call(`/development/${styleDoc._id}`, { token: who.token, company: world.co._id });

/* ══ 1. THE FACTS CROSS ═══════════════════════════════════════════════════ */

describe("the manufacturing inputs reach IE", () => {
  let world; let viewer; let styleDoc; let inputs;

  beforeAll(async () => {
    world = await company("MIFacts");
    viewer = await ieViewer(world.co);
    styleDoc = await populatedStyle(world);
    await DevelopmentFile.create({
      developmentNumber: `DEV-MI-${++seq}`, companyId: world.co._id,
      journeyId: world.journey._id, productLineRef: `PL-MI-${seq}`,
      sampleStyleId: styleDoc._id, lifecycleStatus: "RELEASED_TO_RND",
      currentBomRevisionNo: 4, releasedBomRevisionNo: 3,
    });
    const res = await detail(styleDoc, viewer, world);
    expect(res.status).toBe(200);
    inputs = res.body.manufacturingInputs;
  });

  /* Every collection is wiped after each test, so a test that READS the
     server again builds its own world; the rest assert the payload captured
     once above. */
  test("it is a sibling of row and evidence, not a member of either", async () => {
    const own = await company("MISibling");
    const whoever = await ieViewer(own.co);
    const theStyle = await populatedStyle(own);
    const res = await detail(theStyle, whoever, own);
    expect(res.status).toBe(200);
    expect(res.body.manufacturingInputs).toBeTruthy();
    expect(res.body.row.manufacturingInputs).toBeUndefined();
    expect(res.body.evidence.manufacturingInputs).toBeUndefined();
  });

  test("the garment brief carries fit, size range, fabric and construction", () => {
    expect(inputs.garment).toMatchObject({
      owner: "SALES",
      fit: "Regular", sizeRange: "S-XXL", colour: "Navy", gsm: "220",
      fabricComposition: "60% cotton / 40% polyester",
      specialConstruction: "Two-piece rib collar; reinforced shoulder tape",
      existingUniform: "Current Northwind polo, 2024 issue",
    });
    expect(inputs.garment.statedSpecs).toEqual([{ label: "Collar recovery", value: "Checked on fit sample" }]);
    expect(inputs.garment.references[0]).toMatchObject({ name: "front.png", url: "https://files.test/front.png" });
    /* The media store's own handles stay behind — the endpoint's existing rule. */
    expect(JSON.stringify(inputs)).not.toContain("publicId");
    expect(JSON.stringify(inputs)).not.toContain("demo/front");
  });

  test("decoration carries placement, size, colour notes and its artwork", () => {
    const [row] = inputs.decoration.rows;
    expect(row).toMatchObject({
      kind: "Embroidery", placement: "Left chest",
      width: 68, height: 54, unit: "mm",
      colourNotes: "Ivory and rust", artworkState: "Buyer reference received",
    });
    expect(row.artwork[0]).toMatchObject({ name: "crest.png", url: "https://files.test/crest.png" });
  });

  test("a customer's artwork is never presented as a production instruction", () => {
    expect(inputs.decoration.artworkApproved).toBe(false);
    expect(inputs.decoration.artworkOrigin).toBe("CUSTOMER_REFERENCE");
    /* And the strip says so in its own word, rather than calling it ready. */
    const deco = inputs.received.find((r) => r.key === "decoration");
    expect(deco.state).toBe("NEEDS_CLARIFICATION");
  });

  test("materials carry engineered consumption, unit, allowance and a return reason", () => {
    expect(inputs.materials.basis).toBe("APPROVED_TECHNICAL_PACK");
    expect(inputs.materials.revision).toBe(2);
    const [fabric, button] = inputs.materials.rows;
    expect(fabric).toMatchObject({
      name: "220 GSM cotton-rich pique", consumptionPerPiece: 1.35, unit: "m", allowancePercent: 7,
    });
    /* Not stated stays not stated. A 0 here would invent an allowance. */
    expect(button.allowancePercent).toBeNull();
    expect(button.appliesToVariantLabels).toEqual(["Navy"]);
    expect(button.returnedForCorrection).toMatchObject({ reason: "Shade band not attached" });
    expect(inputs.materials.returnedCount).toBe(1);
  });

  test("it pins to the materials pack that was RELEASED, not the one in progress", () => {
    expect(inputs.materials.releasedMaterialsPack).toBe(3);
    expect(inputs.materials.materialsPackInProgress).toBe(4);
  });

  test("outside processes carry the decision, the included row and the excluded one with its reason", () => {
    expect(inputs.processes.applicability).toMatchObject({ state: "REQUIRED", owner: "PRODUCTION" });
    const included = inputs.processes.rows.find((r) => r.included);
    expect(included).toMatchObject({
      name: "Embroidery — flat", specification: "68mm crest, ivory and rust",
      quantity: 1, unit: "piece", basis: "PER_GARMENT",
    });
    const excluded = inputs.processes.rows.find((r) => !r.included);
    expect(excluded).toMatchObject({ name: "Garment wash", excludedReason: "Not required on pique" });
    /* A blank quantity is not zero. */
    expect(excluded.quantity).toBeNull();
  });

  test("tooling is its own family, with its own owner and decision", () => {
    expect(inputs.tooling.applicability).toMatchObject({ state: "REQUIRED", owner: "MERCHANDISING" });
    expect(inputs.tooling.rows).toHaveLength(1);
    expect(inputs.tooling.rows[0]).toMatchObject({ name: "Pattern development", basis: "FIXED_PER_RUN" });
    /* Sales' branding ask and Production's process requirement are different
       facts and are never merged: embroidery appears in both, separately. */
    expect(inputs.processes.rows.some((r) => /Embroidery/.test(r.name))).toBe(true);
    expect(inputs.tooling.rows.some((r) => /Embroidery/.test(r.name))).toBe(false);
  });

  test("packaging carries the basis, the garments per carton and the component", () => {
    expect(inputs.packaging.applicability.state).toBe("REQUIRED");
    expect(inputs.packaging.garmentsPerCarton).toBe(40);
    expect(inputs.packaging.packConfigurationRevision).toBe(2);
    expect(inputs.packaging.rows[0]).toMatchObject({ basis: "PER_GARMENT", quantity: 1, unit: "pc" });
    expect(inputs.packaging.components[0]).toMatchObject({ name: "Clear polybag", status: "approved" });
  });

  test("the sample is published as evidence, with its accepted round", () => {
    expect(inputs.sample.status).toBe("approved");
    expect(inputs.sample.acceptedRounds).toEqual([2]);
    expect(inputs.sample.photographs).toBe(1);
    expect(inputs.sample.consumed[0]).toMatchObject({ quantity: 1.4, unit: "m" });
    expect(inputs.sample.observedOperations[0]).toMatchObject({
      description: "Embroider crest", machineType: "EMB", minutes: 4, seconds: 30,
    });
  });

  test("the route is Production's, with codes and machine types preserved exactly", () => {
    expect(inputs.route.owner).toBe("PRODUCTION");
    expect(inputs.route.rows.map((r) => r.operationCode)).toEqual(["OP-10", "OP-20"]);
    expect(inputs.route.rows.map((r) => r.sequence)).toEqual([1, 2]);
    expect(inputs.route.rows[0]).toMatchObject({ name: "Run collar", machineType: "SNLS", standardMinutes: 1.2 });
    expect(inputs.route.totalStandardMinutes).toBeCloseTo(2, 5);
  });

  test("the technical pack is the approved one, and no measurement chart is claimed", () => {
    expect(inputs.construction.basis).toBe("APPROVED_TECHNICAL_PACK");
    expect(inputs.construction.pack).toMatchObject({ name: "NW-POLO-26 technical pack.pdf" });
    expect(inputs.construction.notStored.map((n) => n.kind).sort())
      .toEqual(["CONSTRUCTION_DRAWING", "MEASUREMENT_CHART"]);
    for (const absent of inputs.construction.notStored) expect(absent.owner).toBe("RESEARCH_DEVELOPMENT");
  });

  test("the received strip says one word per input, and agrees with the groups", () => {
    const states = Object.fromEntries(inputs.received.map((r) => [r.key, r.state]));
    expect(states).toMatchObject({
      garment: "READY", construction: "READY", processes: "READY", sample: "READY",
      /* A material R&D sent back to Merchandising is not "received": the row
         is on the pack and its correction is outstanding. */
      materials: "NEEDS_CLARIFICATION",
      /* Artwork that is the customer's reference is not a production
         instruction, whatever else is ready. */
      decoration: "NEEDS_CLARIFICATION",
    });
    for (const item of inputs.received) expect(item.owner).toBeTruthy();
  });
});

/* ══ 2. APPROVED VERSUS DRAFT ═════════════════════════════════════════════ */

describe("an approved revision is preferred, and a draft is never silent", () => {
  test("the approved snapshot is published, not the mutable draft beside it", async () => {
    const world = await company("MIApproved");
    const viewer = await ieViewer(world.co);
    const styleDoc = await populatedStyle(world);
    const { body } = await detail(styleDoc, viewer, world);
    const inputs = body.manufacturingInputs;
    /* The draft rows carry deliberately absurd values; none may appear. */
    expect(JSON.stringify(inputs)).not.toMatch(/DRAFT ROW ONLY|DRAFT-OP|9\.99/);
    expect(inputs.materials.rows.map((r) => r.name)).not.toContain("DRAFT ROW ONLY");
    expect(inputs.approvedTechnicalPack).toBe(2);
  });

  test("with nothing approved the draft is published AS a draft, and says which", async () => {
    const world = await company("MIDraft");
    const viewer = await ieViewer(world.co);
    const styleDoc = await populatedStyle(world, {
      techSheet: {
        status: "in_progress",
        technical: {
          status: "draft", revision: 1,
          materials: [{ rawItemId: new mongoose.Types.ObjectId(), rawItemName: "Draft fabric", consumptionPerPiece: 1.1, unit: "m" }],
          operations: [{ operationId: new mongoose.Types.ObjectId(), operationCode: "D-10", name: "Draft op", minutes: 1, seconds: 0 }],
        },
        technicalRevisions: [],
      },
    });
    const { body } = await detail(styleDoc, viewer, world);
    const inputs = body.manufacturingInputs;
    expect(inputs.approvedTechnicalPack).toBeNull();
    expect(inputs.materials.basis).toBe("DRAFT_TECHNICAL_RECORD");
    expect(inputs.materials.rows[0].name).toBe("Draft fabric");
    expect(inputs.route.basis).toBe("DRAFT_TECHNICAL_RECORD");
    /* And the strip refuses to call an unapproved pack received. */
    const states = Object.fromEntries(inputs.received.map((r) => [r.key, r.state]));
    expect(states.materials).toBe("MISSING");
    expect(states.construction).toBe("MISSING");
  });

  test("a submitted-but-undecided revision is not read as approved", async () => {
    const world = await company("MISubmitted");
    const viewer = await ieViewer(world.co);
    const styleDoc = await populatedStyle(world, {
      techSheet: {
        status: "submitted",
        technical: { status: "submitted", revision: 2, materials: [], operations: [] },
        technicalRevisions: [{ revision: 2, submittedAt: new Date("2026-09-05"), outcome: "submitted", snapshot: APPROVED_SNAPSHOT }],
      },
    });
    const { body } = await detail(styleDoc, viewer, world);
    expect(body.manufacturingInputs.approvedTechnicalPack).toBeNull();
    expect(body.manufacturingInputs.materials.basis).not.toBe("APPROVED_TECHNICAL_PACK");
  });
});

/* ══ 3. UNKNOWN IS NOT "NOT REQUIRED" ═════════════════════════════════════ */

describe("an empty list is never an answer", () => {
  let world; let viewer; let inputs;

  beforeAll(async () => {
    world = await company("MIBare");
    viewer = await ieViewer(world.co);
    const styleDoc = await bareStyle(world);
    const { body } = await detail(styleDoc, viewer, world);
    inputs = body.manufacturingInputs;
  });

  test("every family with nothing recorded reads UNKNOWN, not NOT_REQUIRED", () => {
    for (const key of ["garment", "decoration", "materials", "processes", "tooling", "packaging", "route"]) {
      expect([key, inputs[key].applicability.state]).toEqual([key, "UNKNOWN"]);
    }
  });

  test("each unknown names the desk that owes the answer", () => {
    expect(inputs.decoration.applicability.owner).toBe("SALES");
    expect(inputs.materials.applicability.owner).toBe("MERCHANDISING");
    expect(inputs.processes.applicability.owner).toBe("PRODUCTION");
    expect(inputs.tooling.applicability.owner).toBe("MERCHANDISING");
    expect(inputs.packaging.applicability.owner).toBe("MERCHANDISING");
  });

  test("a signed NOT_REQUIRED is the only thing that says a process is not needed", async () => {
    const own = await company("MIDecided");
    const whoever = await ieViewer(own.co);
    const styleDoc = await bareStyle(own);
    await SampleStyle.updateOne({ _id: styleDoc._id }, {
      $set: {
        "sample.outsideProcessDecision": {
          required: false, reason: "Nothing leaves the factory for this style",
          decidedBy: { id: new mongoose.Types.ObjectId(), name: "P Kumar" },
          decidedAt: new Date("2026-09-20"),
        },
      },
    });
    const res = await detail(styleDoc, whoever, own);
    expect(res.status).toBe(200);
    const body = res.body;
    const processes = body.manufacturingInputs.processes;
    expect(processes.applicability).toMatchObject({
      state: "NOT_REQUIRED",
      reason: "Nothing leaves the factory for this style",
      decidedByName: "P Kumar",
      owner: "PRODUCTION",
    });
    expect(body.manufacturingInputs.received.find((r) => r.key === "processes").state)
      .toBe("NOT_REQUIRED");
    /* Decoration has no decision in the schema at all, so it stays unknown
       even when a sibling family has been answered. */
    expect(body.manufacturingInputs.decoration.applicability.state).toBe("UNKNOWN");
  });

  test("the bare style still publishes the two absences rather than empty panels", () => {
    expect(inputs.construction.pack).toBeNull();
    expect(inputs.construction.notStored).toHaveLength(2);
  });
});

/* ══ 4. THE BOUNDARY ══════════════════════════════════════════════════════ */

describe("nothing commercial and nothing foreign crosses", () => {
  test("no key path and no value carries money, a buyer, a supplier or payroll", async () => {
    const world = await company("MILeak");
    const viewer = await ieViewer(world.co);
    const styleDoc = await populatedStyle(world);
    const { body } = await detail(styleDoc, viewer, world);
    const wire = JSON.stringify(body.manufacturingInputs);

    /* The payroll figures sit on the very sample rows this block publishes, so
       this is a real catch rather than a check of something never loaded. */
    for (const forbidden of ["operatorSalary", "operatorCost", "salaryDept", "salaryDesig", "21000", "13.4"]) {
      expect(wire).not.toContain(forbidden);
    }
    /* The service register's buying side, and the charge key that resolves to
       money at costing time. */
    for (const forbidden of ["serviceId", "serviceCode", "SVC-EMB", "developmentChargeKey", "PATTERN_SET", "developmentSource"]) {
      expect(wire).not.toContain(forbidden);
    }
    /* The order's commercial facts, including the asked quantity. */
    expect(wire).not.toContain("journeyId");
    expect(wire).not.toContain("enquiryId");
    expect(wire).not.toContain(String(world.journey._id));
    expect(wire).not.toContain(String(world.enquiry._id));

    const keys = [];
    const walk = (v) => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); }
      return undefined;
    };
    walk(body.manufacturingInputs);
    const banned = /journey|enquiry|buyer|customer|account|price|margin|quotation|supplier|vendor|rate|salary|cost|operator|employee|barcode|machineId/i;
    expect(keys.filter((k) => banned.test(k))).toEqual([]);
  });

  test("another company's style is indistinguishable from one that does not exist", async () => {
    const mine = await company("MIMine");
    const theirs = await company("MITheirs");
    const outsider = await ieViewer(theirs.co);
    const styleDoc = await populatedStyle(mine);

    const foreign = await call(`/development/${styleDoc._id}`, { token: outsider.token, company: theirs.co._id });
    const invented = await call(`/development/${new mongoose.Types.ObjectId()}`, { token: outsider.token, company: theirs.co._id });
    const malformed = await call("/development/not-an-id", { token: outsider.token, company: theirs.co._id });

    expect(foreign.status).toBe(404);
    expect(new Set([foreign, invented, malformed].map((r) => `${r.status}:${JSON.stringify(r.body)}`)).size).toBe(1);
  });

  test("reading the manufacturing inputs writes nothing", async () => {
    const world = await company("MIReadOnly");
    const viewer = await ieViewer(world.co);
    const styleDoc = await populatedStyle(world);
    const spies = [
      jest.spyOn(mongoose.Model.prototype, "save"),
      jest.spyOn(mongoose.Model, "updateOne"),
      jest.spyOn(mongoose.Model, "findOneAndUpdate"),
      jest.spyOn(mongoose.Model, "create"),
      jest.spyOn(mongoose.Model, "deleteOne"),
    ];
    try {
      const res = await detail(styleDoc, viewer, world);
      expect(res.status).toBe(200);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

/* ══ 5. THE PURE BUILDER ══════════════════════════════════════════════════ */

describe("the projection is pure and explicit", () => {
  test("it issues no query and survives a style with nothing on it", () => {
    const out = manufacturing.manufacturingInputsFor({ style: {}, development: null });
    expect(out.garment.applicability.state).toBe("UNKNOWN");
    expect(out.route.rows).toEqual([]);
    expect(out.received).toHaveLength(6);
    expect(out.approvedTechnicalPack).toBeNull();
  });

  test("it never spreads an upstream document into the payload", () => {
    const style = {
      productName: "Polo", secretField: "MUST NOT CROSS",
      brief: { colour: "Navy", quantity: 500, hiddenBriefField: "NOR THIS" },
      sample: { serviceRequirements: [{ purpose: "OUTSIDE_PROCESS", serviceName: "Wash", smuggled: "NO" }] },
    };
    const wire = JSON.stringify(manufacturing.manufacturingInputsFor({ style }));
    expect(wire).not.toContain("MUST NOT CROSS");
    expect(wire).not.toContain("NOR THIS");
    expect(wire).not.toContain("smuggled");
    /* The asked quantity is a commercial fact and is not an input to making
       one garment. */
    expect(wire).not.toContain("500");
    expect(wire).toContain("Navy");
  });
});
