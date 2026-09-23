"use strict";
/*
 * scripts/ie/ieDemoScenario.js
 *
 * THE DEMO SCENARIO, BUILT THROUGH THE APPLICATION'S OWN CONTRACTS.
 *
 * ── THE ONE RULE ────────────────────────────────────────────────────────────
 * Every Industrial Engineering record is created by the SERVICE the routes
 * call. Not one lifecycle state is manufactured by writing a document with the
 * status field already set to APPROVED. If a state cannot be reached through
 * `createFile → updateBulletin → submitVersion → approveVersion → createLayout
 * → approveLayout → createStandard → approveStandard → issueRelease`, then it
 * is not a state the application can produce and it has no business in a demo
 * that exists to show the application working.
 *
 * A seeder that inserted approved documents directly would be a seeder that
 * demonstrates the seeder.
 *
 * ── WHAT IS INSERTED DIRECTLY, AND WHY EACH ONE HAS TO BE ───────────────────
 * Industrial Engineering READS orders; it creates none. `ieOrders.service.js`
 * says so in its own header — "There is no save, update, findOneAndUpdate,
 * bulkWrite or backfill in this file". An order reaches IE from Production and
 * proves its company through Sales:
 *
 *     WorkOrder.sampleStyleId → SampleStyle → (journeyId | enquiryId) → companyId
 *
 * None of those four collections has an IE creation service, so each is
 * inserted directly and named here:
 *
 *   · Acc_Company   — the tenant itself. Created by Accounting's own onboarding
 *                     in real life; there is no callable service for it here.
 *   · SalesJourney  — Sales' spine. `styleOwnershipClause`'s FIRST branch is
 *                     "the style names a journey that names this company",
 *                     which is the ordinary path a real style takes. (The
 *                     house-sample branch was tried first and is not usable
 *                     here: `Enquiry.journeyId` is required by its own schema,
 *                     so a journey has to exist either way.)
 *   · Enquiry       — Sales' record, naming the company and the journey.
 *   · SampleStyle   — Merchandising's record, with the approved tech sheet an
 *                     engineering file is opened against.
 *   · StockItem /
 *     WorkOrder     — Production's records. The work order is what IE lists as
 *                     "an order".
 *
 * Identities are NOT in that list. `DeptUser.setPassword()`,
 * `departmentRoles.setRole()` and `SpCompanyMembership` are the real APIs and
 * are used as such — there is no auth bypass anywhere in this file.
 *
 * ── AND EVERYTHING IS TAGGED ────────────────────────────────────────────────
 * Every directly-inserted record carries the demo tag in a field the schema
 * already has (a name, a reference, an id string). Records created through IE
 * services cannot be tagged — the services own their fields — so their ids are
 * recorded in the manifest instead, which is what `--purge` deletes by.
 *
 * This file is new and development-only. It changes no application behaviour.
 */

const mongoose = require("mongoose");

const { DEMO_TAG } = require("./ieDemoGuards");

/* ── The application's own services. Nothing is re-implemented. ───────────── */
const styleFiles = require("../../services/industrialEngineering/ieStyleFile.service");
const operations = require("../../services/industrialEngineering/ieOperationLibrary.service");
const policies = require("../../services/industrialEngineering/ieAllowancePolicy.service");
const versions = require("../../services/industrialEngineering/ieBulletinVersion.service");
const layouts = require("../../services/industrialEngineering/ieLineLayout.service");
const capacity = require("../../services/industrialEngineering/ieCapacityStandard.service");
const ramps = require("../../services/industrialEngineering/ieRampProfile.service");
const releases = require("../../services/industrialEngineering/ieRelease.service");
const departmentRoles = require("../../services/departmentRoles");

/* ── The legacy source models, for the four records named above. ──────────── */
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const Employee = require("../../models/Employee");
const DeptUser = require("../../models/Access/DeptUser");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");

const oid = (v) => new mongoose.Types.ObjectId(String(v));

/* ══ THE SIX DEVELOPMENT IDENTITIES ═══════════════════════════════════════
 *
 * Roles are the application's own (`viewer`/`editor`/`approver`/`owner` from
 * `DepartmentRole`), never invented. Memberships are the minimum each identity
 * needs, so isolation can be tested honestly: only the multi-company approver
 * holds both companies, and a viewer who could see two companies would prove
 * nothing about the selector.
 */
const IDENTITIES = Object.freeze([
  { key: "ieViewer", email: "ie.viewer.demo@grav.demo", name: "IE Viewer (demo)", dept: "ie", role: "viewer", companies: ["primary"] },
  { key: "ieEditor", email: "ie.editor.demo@grav.demo", name: "IE Editor (demo)", dept: "ie", role: "editor", companies: ["primary"] },
  { key: "ieApprover", email: "ie.approver.demo@grav.demo", name: "IE Approver (demo)", dept: "ie", role: "approver", companies: ["primary"] },
  { key: "ieMulti", email: "ie.multicompany.demo@grav.demo", name: "IE Approver, two companies (demo)", dept: "ie", role: "approver", companies: ["primary", "secondary"] },
  { key: "ppcViewer", email: "ppc.viewer.demo@grav.demo", name: "PPC Viewer (demo)", dept: "ppc", role: "viewer", companies: ["primary"] },
  { key: "ppcApprover", email: "ppc.approver.demo@grav.demo", name: "PPC Approver (demo)", dept: "ppc", role: "approver", companies: ["primary"] },
]);

/**
 * One identity, through the real models.
 *
 * `setPassword` is `DeptUser`'s own method — the only supported way to set one
 * — so the demo accounts sign in through `/api/auth/login` exactly as a real
 * account does. There is no bypass, no pre-hashed constant and no shortcut.
 */
async function upsertIdentity(spec, { password, departmentId, companies, manifest }) {
  const email = spec.email.toLowerCase();

  let employee = await Employee.findOne({ email });
  if (!employee) {
    employee = await Employee.create({
      firstName: spec.name.split(" ")[0],
      lastName: "Demo",
      email,
      /* Tagged: the biometric id is a free string the schema already has. */
      biometricId: `${DEMO_TAG}-${spec.key}`,
      isActive: true, gender: "Other", department: "Tech",
    });
  }
  manifest.employeeIds.push(String(employee._id));

  let user = await DeptUser.findOne({ email });
  if (!user) {
    user = new DeptUser({
      name: spec.name, email, departmentId, employeeRef: employee._id,
      isAdmin: false, isActive: true,
      /* Tagged in a field the schema already carries. */
      legacyModel: DEMO_TAG,
    });
  }
  user.name = spec.name;
  user.employeeRef = employee._id;
  user.departmentId = departmentId;
  user.isActive = true;
  user.legacyModel = DEMO_TAG;
  /* Re-applied on every run, so a changed IE_DEMO_PASSWORD takes effect and a
     second run stays idempotent rather than leaving a stale password. */
  await user.setPassword(password);
  await user.save();
  manifest.deptUserIds.push(String(user._id));

  for (const slot of spec.companies) {
    const company = companies[slot];
    if (!company) continue;
    const existing = await SpCompanyMembership.findOne({ companyId: company._id, email });
    if (!existing) {
      const m = await SpCompanyMembership.create({
        companyId: company._id, email, employeeRef: employee._id,
        personName: spec.name, isActive: true, note: DEMO_TAG,
      });
      manifest.membershipIds.push(String(m._id));
    } else {
      manifest.membershipIds.push(String(existing._id));
    }
  }

  /* The real grant API. `setRole` is what the Access Control screen calls. */
  await departmentRoles.setRole({
    departmentSlug: spec.dept, email, name: spec.name, role: spec.role,
  });
  manifest.grants.push({ email, department: spec.dept, role: spec.role, companies: spec.companies });

  return { email, employee, user };
}

/* ══ THE LEGACY SOURCE CHAIN ══════════════════════════════════════════════ */

/**
 * One company, and the Sales + Production records that let IE see an order in
 * it. Every one of these is a direct insert for the reason given in the header.
 */
async function upsertCompanyWorld(slotName, companyName, { orders, manifest }) {
  let company = await Acc_Company.findOne({ companyName });
  if (!company) {
    company = await Acc_Company.create({
      companyName,
      booksFromDate: new Date("2026-04-01"),
    });
  }
  manifest.companyIds.push(String(company._id));

  const accountId = oid(new mongoose.Types.ObjectId());
  const built = [];

  for (const order of orders) {
    const ref = `${DEMO_TAG}-${slotName}-${order.key}`;

    /* The spine branch of `styleOwnershipClause`: a journey that names the
       company, an enquiry under it, and a style that names the journey. */
    let journey = await SalesJourney.findOne({ journeyId: ref });
    if (!journey) {
      journey = await SalesJourney.create({
        journeyId: ref, companyId: company._id, accountId,
        ownerId: oid(new mongoose.Types.ObjectId()), ownerName: "IE Demo Owner",
        name: `${order.product} (demo)`, isActive: true,
      });
    }
    manifest.journeyIds.push(String(journey._id));

    let enquiry = await Enquiry.findOne({ enquiryId: ref });
    if (!enquiry) {
      enquiry = await Enquiry.create({
        enquiryId: ref, journeyId: journey._id, companyId: company._id, accountId,
        title: `${order.product} (demo)`, isActive: true,
        products: [{ product: order.product, quantity: order.quantity }],
      });
    }
    manifest.enquiryIds.push(String(enquiry._id));

    let item = await StockItem.findOne({ reference: ref });
    if (!item) {
      item = await StockItem.create({
        name: `${order.product} (demo)`, sku: ref, reference: ref,
        category: "Garment", createdBy: oid(new mongoose.Types.ObjectId()),
        quantityOnHand: 0, minStock: 0, maxStock: 10,
        variants: [{ sku: `${ref}-V`, cost: 0, salesPrice: 0 }],
      });
    }
    manifest.stockItemIds.push(String(item._id));

    /* ── THE STYLE FIRST, THEN THE ORDER THAT NAMES IT ──────────────────
       `ieOrders.service` proves an order's company through the style, and the
       CANONICAL link is the ORDER'S OWN `sampleStyleId` — the field a newly
       released order carries. `SampleStyle.production.workOrderIds` is the
       reverse list, so a style can find its runs.

       An order holding only the reverse reference would exercise the
       service's LEGACY recovery path rather than the contract new orders
       actually use, so both stored directions are seeded: the style is made
       first, the work order is made WITH its style id, and the style's list is
       then pointed back at it. */
    let style = await SampleStyle.findOne({ sampleStyleId: ref });
    if (!style) {
      style = await SampleStyle.create({
        sampleStyleId: ref, productName: `${order.product} (demo)`,
        styleCode: order.styleCode, variantLabel: order.colour,
        journeyId: journey._id, enquiryId: enquiry._id, sourceStockItemId: item._id,
        materials: { status: "pending", rawItems: [] },
        techSheet: {
          technical: { status: "approved", revision: 3 },
          technicalRevisions: [{
            revision: 3,
            submittedAt: new Date("2026-08-01"),
            outcome: "approved",
            decidedAt: new Date("2026-08-05"),
            snapshot: { revision: 3, materials: [], requirements: [], operations: [] },
          }],
        },
        production: { workOrderIds: [] },
      });
    }
    manifest.styleIds.push(String(style._id));

    let wo = await WorkOrder.findOne({ workOrderNumber: ref });
    if (!wo) {
      wo = await WorkOrder.create({
        workOrderNumber: ref, stockItemId: item._id, stockItemName: item.name,
        stockItemReference: item.reference,
        /* THE CANONICAL LINK — the order's own field. */
        sampleStyleId: style._id,
        quantity: order.quantity, originalQuantity: order.quantity,
        status: order.status,
        timeline: {
          plannedStartDate: new Date("2026-10-01"),
          plannedEndDate: new Date("2026-11-15"),
        },
        customerId: oid(new mongoose.Types.ObjectId()),
        customerName: order.customer,
      });
    } else if (String(wo.sampleStyleId || "") !== String(style._id)) {
      /* An order seeded before this correction carries no style id. Repaired
         in place rather than duplicated. */
      wo.sampleStyleId = style._id;
      await wo.save();
    }
    manifest.workOrderIds.push(String(wo._id));

    /* And the reverse list. */
    const linked = (style.production?.workOrderIds || []).map(String);
    if (!linked.includes(String(wo._id))) {
      await SampleStyle.updateOne(
        { _id: style._id },
        { $addToSet: { "production.workOrderIds": wo._id } },
      );
      style = await SampleStyle.findById(style._id);
    }

    built.push({ ...order, ref, company, enquiry, item, wo, style });
  }

  return { company, orders: built };
}

module.exports = { IDENTITIES, upsertIdentity, upsertCompanyWorld, oid };
