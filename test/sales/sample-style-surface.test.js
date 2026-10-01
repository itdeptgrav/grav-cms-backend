// test/sales/sample-style-surface.test.js
//
// SALES' OWN STYLE SURFACE, ASSERTED WHERE ITS SUBJECT LIVES.
//
// Three claims — R&D's raw-item search, stage routing, and the legacy material
// routes — about the SALES style router. They were written inside the
// Merchandising suite because, at the time, Merchandising's endpoints were
// registered on that same router and the two surfaces shared one file.
//
// Those endpoints have moved to routes/CMS_Routes/Merchandising/styleRoute.js.
// The assertions about Sales' own surface stayed behind and came here, so a
// Merchandising release no longer mounts 4,500 lines of the Sales router to
// prove something about R&D's picker, and whoever changes that router next
// finds the tests guarding it in the obvious place.
//
// Not one claim changed. What changed is which suite owns it.

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/SalesAuthMiddlewear", () => {
  const jwtLib = require("jsonwebtoken");
  const mw = (req, res, next) => {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, message: "Authentication required." });
    }
    try {
      req.user = jwtLib.verify(header.slice(7), process.env.JWT_SECRET || "grav_clothing_secret_key");
      next();
    } catch {
      res.status(401).json({ success: false, message: "Invalid token." });
    }
  };
  mw.withRoles = () => mw;
  mw.RND_ROLES = [];
  return mw;
});

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const Account = require("../../models/CMS_Models/Sales/Account");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");

const access = require("../../services/merchandising/access.service");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/merchandising", require("../../routes/CMS_Routes/Merchandising/merchandisingWorkRoute"));
  /* The Merchandising style doors moved off the Sales router into
     routes/CMS_Routes/Merchandising/styleRoute.js. Same handlers, same
     services, same live grant — a file of their own, so this suite no longer
     mounts 4,500 lines of another lane's in-flight rewrite to reach eleven
     endpoints. */
  app.use("/api/cms/crm/sample-styles", require("../../routes/CMS_Routes/Sales/sampleStyles"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const M = "/api/cms/merchandising";
const S = "/api/cms/crm/sample-styles";

const call = (path, { token, company, method = "GET", body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

async function actor({ companies = [], grants = {}, isAdmin = false } = {}) {
  const n = ++seq;
  const email = `mb${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "M", lastName: `B${n}`, email, biometricId: `MB${n}`,
    isActive: true, gender: "Other", department: "Merch",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "M" });
  }
  const rows = {};
  for (const [departmentSlug, role] of Object.entries(grants)) {
    rows[departmentSlug] = await DepartmentRole.create({
      departmentSlug, email, name: "User", role, isActive: true,
      departmentId: new mongoose.Types.ObjectId(),
    });
  }
  return {
    email, grantRows: rows,
    token: jwt.sign(
      { id: String(emp._id), email, name: "M", role: "sales", employeeId: emp.biometricId, isAdmin },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

async function world(label = "B") {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `${label} ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const account = await Account.create({ companyId: co._id, companyName: `Buyer ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-${label}-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-${label}-${n}`, journeyId: journey._id, accountId: account._id,
    companyId: co._id, title: `Enquiry ${n}`, isActive: true,
    products: [{ product: "Tee", quantity: 500 }],
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-${label}-${n}`, styleCode: `SC-${label}-${n}`,
    productName: `${label} tee`, journeyId: journey._id, enquiryId: enquiry._id,
    stage: "materials", materials: { status: "pending", rawItems: [] },
  });
  /* One packaging component, with everything the R&D search would publish
     about it: stock on hand, a variant, and a vendor price on that variant. */
  const item = await RawItem.create({
    companyId: co._id, name: `${label} poly bag`, sku: `PB-${label}-${n}`,
    unit: "Piece", category: "Packing", createdBy: new mongoose.Types.ObjectId(),
    quantity: 4200,
    variants: [{
      sku: `PBV-${label}-${n}`, combination: ["Clear"], quantity: 4200,
      vendorNicknames: [{
        vendor: new mongoose.Types.ObjectId(), nickname: "Acme Packaging", price: 3.75,
      }],
    }],
  });
  return { co, style, item, label };
}

/* ══ B — ONE IMPLEMENTATION ═══════════════════════════════════════════════ */

describe("R&D's own raw-item search is untouched", () => {
  test("a Sales session still reaches it, with the fields its caller needs", async () => {
    /* Merchandising stopped borrowing it, so it is back to one audience. No
       Merchandising grant is required and none is checked — requiring one
       would refuse the R&D picker it was written for. */
    const w = await world("Rnd");
    const who = await actor({ companies: [w.co], grants: { rnd: "editor" } });

    const res = await call(`${S}/${w.style._id}/production/raw-items/search?q=poly`, {
      token: who.token,
    });
    expect(res.status).toBe(200);
    expect(res.body.rawItems).toHaveLength(1);
    /* The shape R&D's consumption picker consumes, unchanged. */
    expect(res.body.rawItems[0]).toHaveProperty("quantity");
    expect(res.body.rawItems[0]).toHaveProperty("variants");
    expect(res.body.rawItems[0].variants[0]).toHaveProperty("price");
  });

  test("it is still scoped to the caller's own company", async () => {
    const mine = await world("RndMine");
    await world("RndTheirs");
    const who = await actor({ companies: [mine.co], grants: { rnd: "editor" } });
    const res = await call(`${S}/${mine.style._id}/production/raw-items/search?q=poly`, {
      token: who.token,
    });
    expect(res.body.rawItems.map((r) => r.name)).toEqual(["RndMine poly bag"]);
  });
});

describe("stage routing is Sales' and stays Sales'", () => {
  test("a Sales caller with NO Merchandising grant may still route a style", async () => {
    /* The result hands work to Merchandising. That does not make it a
       Merchandising mutation, and requiring a Merchandising grant here would
       break the Sales screen that owns the action. */
    const w = await world("Stage");
    const sales = await actor({ companies: [w.co], grants: { sales: "owner" } });

    const res = await call(`${S}/${w.style._id}/stage`, {
      token: sales.token, method: "PATCH", body: { stage: "brief", reason: "Sent back." },
    });
    expect(res.status).toBe(200);
    const after = await SampleStyle.findById(w.style._id).lean();
    expect(after.stage).toBe("brief");
  });

  test("but it cannot route another company's style", async () => {
    const mine = await world("StageMine");
    const theirs = await world("StageTheirs");
    const sales = await actor({ companies: [mine.co], grants: { sales: "owner" } });

    const res = await call(`${S}/${theirs.style._id}/stage`, {
      token: sales.token, method: "PATCH", body: { stage: "brief", reason: "x" },
    });
    expect(res.status).toBe(404);
    const after = await SampleStyle.findById(theirs.style._id).lean();
    expect(after.stage).toBe("materials");
  });
});

describe("the legacy material routes are Sales-authorised, and scoped", () => {
  test("a Sales caller may still set materials in their own company", async () => {
    const w = await world("Mat");
    const sales = await actor({ companies: [w.co], grants: { sales: "owner" } });
    const res = await call(`${S}/${w.style._id}/materials`, {
      token: sales.token, method: "PATCH", body: { items: ["Cotton"] },
    });
    /* 200 for a direct apply, 202 when staged for a Sales decision — either
       way the route answered, which is what "unchanged" means here. */
    expect([200, 202]).toContain(res.status);
  });

  test("and cannot in another company's", async () => {
    const mine = await world("MatMine");
    const theirs = await world("MatTheirs");
    const sales = await actor({ companies: [mine.co], grants: { sales: "owner" } });

    const set = await call(`${S}/${theirs.style._id}/materials`, {
      token: sales.token, method: "PATCH", body: { items: ["Cotton"] },
    });
    expect(set.status).toBe(404);

    const decide = await call(
      `${S}/${theirs.style._id}/materials/change/${new mongoose.Types.ObjectId()}/decide`,
      { token: sales.token, method: "POST", body: { decision: "approve" } },
    );
    /* 404 for the STYLE, before the change id is even looked at — which is
       what proves the company was checked first. */
    expect(decide.status).toBe(404);
    expect(decide.body.message).toBe("Style not found.");

    const after = await SampleStyle.findById(theirs.style._id).lean();
    expect(after.materials.items || []).toHaveLength(0);
    expect(after.materialsChangeLog || []).toHaveLength(0);
  });

  test("they are not described or gated as Merchandising endpoints", () => {
    /* The correction is as much about the DESCRIPTION as the code: M0.1 called
       these "Merchandising-facing facts", which reads as though the Sales
       authority over them had been dealt with. It has not, and the comment now
       says so. What must not appear is a Merchandising grant check, which
       would break the Sales screen that owns them. */
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "../../routes/CMS_Routes/Sales/sampleStyles.js"), "utf8",
    );
    const block = (marker) => {
      const i = src.indexOf(marker);
      return src.slice(i, src.indexOf("\nrouter.", i + 10));
    };
    for (const marker of [
      'router.patch("/:id/materials", salesAuth',
      'router.patch("/:id/stage", salesAuth',
      'router.post("/:id/materials/change/:changeId/decide"',
    ]) {
      const b = block(marker);
      expect(b).toMatch(/salesScopeFor\(req\)/);
      expect(b).toMatch(/ownershipProofFor/);
      expect(b).not.toMatch(/requireMerchandising/);
      expect(b).not.toMatch(/merchandisingScopeFor/);
    }
    /* And the legacy Sales authority is recorded rather than claimed closed. */
    expect(block('router.patch("/:id/materials", salesAuth'))
      .toMatch(/LEGACY SALES COMPATIBILITY, NOT A MERCHANDISING DOOR/);
  });
});
