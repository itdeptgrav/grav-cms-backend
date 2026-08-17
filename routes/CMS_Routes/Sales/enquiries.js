// routes/CMS_Routes/Sales/enquiries.js
//
// Enquiry / RFQ — the FIRST real writer for a post-Account lifecycle stage.
//
// SCOPE (Chunk 1): get-or-create the one Enquiry that belongs to a Journey, and
// edit its header (dates, source, status, title, summary). Products, indicative
// pricing and qualification are additive fields landing in later chunks; this
// file grows with them.
//
// The enquiry is created LAZILY on first GET — the moment a salesperson opens
// the Enquiry stage of a journey, its ENQ reference is minted and the record is
// seeded from what we already know (the Account is the customer, its primary
// contact is the contact, the Journey owner is the salesperson, and the
// converting Lead — found via lead.conversion.journeyId — supplies the source).
// Nothing is invented; empty fields stay empty for the user to fill.

"use strict";

const mongoose = require("mongoose");
const Enquiry = require("../../../models/CMS_Models/Sales/Enquiry");
const SalesJourney = require("../../../models/CMS_Models/Sales/SalesJourney");
const Account = require("../../../models/CMS_Models/Sales/Account");
const Contact = require("../../../models/CMS_Models/Sales/Contact");
const Lead = require("../../../models/CMS_Models/Sales/Lead");
const Employee = require("../../../models/Employee");
const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");
const { createWithRef } = require("../../../services/enquiryRef");
const NotificationService = require("../../../services/NotificationService");
const { SHARE_ROLES } = require("../../../services/coworkSheets.service");
const { isSalesManager } = require("../../../services/salesAccess");
const { costingTotals } = require("../../../services/costingTotals");

// The margin policy. Hardcoded for now and deliberately server-side: the floor
// price is computed here and only the RESULT is sent, so cost never has to be
// on the wire for a salesperson to know what they may not go below. When the
// rate card lands this becomes a per-style-family setting.
const MARGIN_FLOOR_PERCENT = 22;

/**
 * WHO MAY SEE WHAT OF A COSTING. Three tiers, enforced here rather than in the
 * UI, because hiding columns in React while this endpoint serves the workbook
 * leaves the vendor prices one network-tab click away.
 *
 *   sheet    the workbook itself — vendor names with their prices, SAM, cost per
 *            minute. Only for someone who OWNS or EDITS that CoWork document:
 *            the merchandiser, the industrial engineer, the salesperson who
 *            raised it. No Sales capability grants this on its own.
 *   cost     cost per piece and its materials/operations split. Sales managers
 *            and the deal owner, who need it to negotiate.
 *   floor    the lowest sellable price. Everyone else. One number, no structure
 *            behind it — you cannot work back to a vendor from it.
 */
async function costingTier(req, enquiry, myRoleOnAnySheet) {
  if (myRoleOnAnySheet === "owner" || myRoleOnAnySheet === "editor") return "sheet";
  const owns = enquiry.ownerId && String(enquiry.ownerId) === String(req.user?.id);
  if (owns) return "cost";
  if (await isSalesManager(req.user)) return "cost";
  return "floor";
}

const { ENQUIRY_STATUS_CODES, ENQUIRY_STATUS_TRANSITIONS, ENQUIRY_SOURCE_CODES, ENQUIRY_LOST_REASON_CODES, ENQUIRY_PRIORITY_CODES, CUSTOMER_SERIOUSNESS_CODES, ENQUIRY_REFERENCE_TYPE_CODES } = require("../../../constants/crm");

const express = require("express");
const router = express.Router();

const actor = (req) => ({ id: req.user?.id, name: req.user?.name || "" });
const isObjectId = (v) => mongoose.Types.ObjectId.isValid(v);

// Map a Lead's `source` (how a prospect was found) onto an Enquiry source (how
// this enquiry came in). Most conversions are "converted lead"; a few carry
// through cleanly.
function enquirySourceFromLead(lead) {
  if (!lead) return undefined;
  const s = lead.source;
  if (s === "referral") return "referral";
  if (s === "trade_show") return "exhibition";
  if (s === "website") return "website";
  if (s === "existing_customer") return "repeat_customer";
  return "existing_lead";
}

// Seed enquiry products from the lead's structured requirement. `requirementItems`
// is the [{ product, quantity }] captured at lead stage; `productInterest` is the
// flat name list — fall back to it when items weren't structured.
function productsFromLead(lead) {
  if (!lead) return [];
  const items = Array.isArray(lead.requirementItems) ? lead.requirementItems : [];
  if (items.length) {
    return items
      .filter((it) => it && String(it.product || "").trim())
      .map((it) => ({ product: String(it.product).trim(), quantity: it.quantity != null ? Number(it.quantity) : undefined }));
  }
  const names = Array.isArray(lead.productInterest) ? lead.productInterest : [];
  return names.filter((n) => String(n || "").trim()).map((n) => ({ product: String(n).trim() }));
}

// Free-text spec fields carried through verbatim (trimmed). Kept in one list so
// adding a spec field to the model means adding it here only.
const PRODUCT_TEXT_FIELDS = [
  "note", "colour", "fabricPreference", "fabricComposition", "gsm", "fit",
  "sizeRange", "brandingPlacement", "trims", "specialConstruction", "existingUniform",
];
const GARMENT_GENDER_CODES = ["male", "female", "unisex"];

// A client-supplied products array, cleaned to what the schema accepts: drop
// blank rows, coerce quantity to a non-negative number, validate the gender
// enum, and carry the garment-spec fields through trimmed.
function sanitizeProducts(input) {
  if (!Array.isArray(input)) return undefined;
  return input
    .filter((p) => p && String(p.product || "").trim())
    .map((p) => {
      const qty = p.quantity === "" || p.quantity == null ? undefined : Number(p.quantity);
      const out = {
        product: String(p.product).trim(),
        quantity: Number.isFinite(qty) && qty >= 0 ? qty : undefined,
        gender: GARMENT_GENDER_CODES.includes(p.gender) ? p.gender : undefined,
        logo: Boolean(p.logo),
        embroidery: Boolean(p.embroidery),
        printing: Boolean(p.printing),
      };
      for (const f of PRODUCT_TEXT_FIELDS) {
        const v = p[f];
        if (v != null && String(v).trim()) out[f] = String(v).trim();
      }
      // Reference images (Drive) — keep up to 8, dropping entries with neither a
      // fileId nor a URL. Trusted shape: { fileId, name, url }.
      if (Array.isArray(p.images)) {
        const imgs = p.images
          .filter((im) => im && (String(im.fileId || "").trim() || String(im.url || "").trim()))
          .slice(0, 8)
          .map((im) => ({
            fileId: String(im.fileId || "").trim() || undefined,
            name: String(im.name || "").trim() || undefined,
            url: String(im.url || "").trim() || undefined,
          }));
        if (imgs.length) out.images = imgs;
      }
      return out;
    });
}

// A client-supplied references array, cleaned: drop rows that are entirely
// empty (no label/url/note), validate the type enum (default "other"), trim.
function sanitizeReferences(input) {
  if (!Array.isArray(input)) return undefined;
  return input
    .filter((r) => r && (String(r.label || "").trim() || String(r.url || "").trim() || String(r.note || "").trim()))
    .map((r) => ({
      label: r.label ? String(r.label).trim() : undefined,
      type: ENQUIRY_REFERENCE_TYPE_CODES.includes(r.type) ? r.type : "other",
      url: r.url ? String(r.url).trim() : undefined,
      note: r.note ? String(r.note).trim() : undefined,
    }));
}

/**
 * Resolve the Journey by its human reference (SJ-YYYY-NNNN) or Mongo id, and
 * return the loaded document. Throws a 404-shaped error object if absent.
 */
async function loadJourney(journeyRef) {
  const query = isObjectId(journeyRef)
    ? { $or: [{ _id: journeyRef }, { journeyId: journeyRef }] }
    : { journeyId: journeyRef };
  const journey = await SalesJourney.findOne({ ...query, isActive: true });
  return journey;
}

/** Populate the display names a client needs, without duplicating them in the DB. */
async function decorate(enquiry) {
  const obj = enquiry.toObject ? enquiry.toObject() : enquiry;
  const [account, contact, journey] = await Promise.all([
    obj.accountId ? Account.findById(obj.accountId).select("accountId companyName displayName").lean() : null,
    obj.primaryContactId ? Contact.findById(obj.primaryContactId).select("firstName lastName jobTitle email mobile whatsapp").lean() : null,
    obj.journeyId ? SalesJourney.findById(obj.journeyId).select("journeyId name").lean() : null,
  ]);
  return {
    ...obj,
    customerName: account ? account.displayName || account.companyName : null,
    customerCode: account?.accountId || null,
    contact: contact
      ? { name: `${contact.firstName || ""} ${contact.lastName || ""}`.trim(), jobTitle: contact.jobTitle, email: contact.email, mobile: contact.mobile, whatsapp: contact.whatsapp }
      : null,
    journeyRef: journey?.journeyId || null,
    journeyName: journey?.name || null,
  };
}

// GET /api/cms/crm/enquiries/by-journey/:journeyRef
// Get-or-create the enquiry for a journey, seeded from account/contact/lead.
router.get("/by-journey/:journeyRef", salesAuth, async (req, res) => {
  try {
    const journey = await loadJourney(req.params.journeyRef);
    if (!journey) return res.status(404).json({ success: false, message: "Journey not found." });

    let enquiry = await Enquiry.findOne({ journeyId: journey._id, isActive: true });

    if (!enquiry) {
      // Seed from the source Lead (the one whose conversion points at this
      // journey), if any — it carries the source, the summary and the
      // product-wise requirement captured at lead stage.
      const lead = await Lead.findOne({ "conversion.journeyId": journey._id })
        .select("source company firstName lastName requirements requirementItems productInterest estimatedUnitPrice")
        .lean();
      const primaryContact = journey.primaryContactId
        ? journey.primaryContactId
        : (await Contact.findOne({ accountId: journey.accountId, isActive: true, isPrimary: true }).select("_id").lean())?._id
          || (await Contact.findOne({ accountId: journey.accountId, isActive: true }).select("_id").lean())?._id;

      enquiry = await createWithRef(Enquiry, {
        journeyId: journey._id,
        accountId: journey.accountId,
        primaryContactId: primaryContact || undefined,
        ownerId: journey.ownerId,
        ownerName: journey.ownerName,
        sourceLeadId: lead?._id || undefined,
        title: journey.name,
        source: enquirySourceFromLead(lead),
        summary: lead?.requirements || undefined,
        products: productsFromLead(lead),
        // Seed our indicative estimate from the lead's researched unit price —
        // a starting point the salesperson refines. The customer's target is
        // left blank for them to capture.
        estimatedPriceMin: lead?.estimatedUnitPrice || undefined,
        estimatedPriceMax: lead?.estimatedUnitPrice || undefined,
        // Smart start: an enquiry converted FROM a lead has already been
        // contacted and had its requirement gathered (that's what let the lead
        // convert), so it opens at "qualified" rather than re-walking the funnel.
        // A direct RFQ (no lead) starts at "new" and runs the full funnel.
        status: lead ? "qualified" : "new",
        createdBy: actor(req),
        updatedBy: actor(req),
      });
    }

    return res.json({ success: true, enquiry: await decorate(enquiry) });
  } catch (err) {
    console.error("[enquiries] GET /by-journey", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Fields a client may set on the header (Chunk 1). Everything else is derived
// or server-owned (enquiryId, accountId, ownerId, references).
const EDITABLE = [
  "title", "enquiryDate", "source", "expectedClosingDate", "requirementDeadline", "summary",
  "status", "lostReason", "lostReasonNote",
  // Pricing + qualification (Chunk 4)
  "pricingCurrency", "targetPrice", "estimatedPriceMin", "estimatedPriceMax", "pricingNote",
  "opportunitySize", "winProbability", "priority", "seriousness", "expectedOrderDate",
];

// PATCH /api/cms/crm/enquiries/:id — update header fields.
router.patch("/:id", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne({ _id: req.params.id, isActive: true });
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    const body = req.body || {};

    // Enforce the status machine: a status change must be a legal transition.
    // A no-op (same status, e.g. saving other fields) always passes.
    if (typeof body.status === "string" && ENQUIRY_STATUS_CODES.includes(body.status) && body.status !== enquiry.status) {
      const allowed = ENQUIRY_STATUS_TRANSITIONS[enquiry.status] || [];
      if (!allowed.includes(body.status)) {
        return res.status(400).json({ success: false, message: `Can't move an enquiry from "${enquiry.status}" to "${body.status}".` });
      }
    }

    for (const key of EDITABLE) {
      if (!(key in body)) continue;
      if (key === "source" && body.source && !ENQUIRY_SOURCE_CODES.includes(body.source)) continue;
      if (key === "status" && body.status && !ENQUIRY_STATUS_CODES.includes(body.status)) continue;
      if (key === "lostReason" && body.lostReason && !ENQUIRY_LOST_REASON_CODES.includes(body.lostReason)) continue;
      if (key === "priority" && body.priority && !ENQUIRY_PRIORITY_CODES.includes(body.priority)) continue;
      if (key === "seriousness" && body.seriousness && !CUSTOMER_SERIOUSNESS_CODES.includes(body.seriousness)) continue;
      enquiry[key] = body[key] === "" ? undefined : body[key];
    }
    // Products is an array — sanitize rather than trust the raw body.
    if ("products" in body) {
      enquiry.products = sanitizeProducts(body.products) || [];

      // costingSheets is keyed by product NAME (see its own schema comment —
      // sanitizeProducts above discards every product's _id on every save,
      // so name was the one thing that survives a routine edit... except a
      // rename of the product itself, which is exactly a name changing.
      // Without this, renaming "Blazer" to "Blazer V2" left the costing
      // sheet keyed to the now-nonexistent "Blazer" — still alive in Mongo
      // and CoWork, just unreachable from this enquiry's product list, so
      // it silently vanished from the UI. `renames` (optional; sent by the
      // Requirement panel when it detects a same-position name change) lets
      // the sheet follow the rename instead. Only applied when `to` is
      // actually a product on the new list — never rename onto nothing.
      const renames = Array.isArray(body.renames) ? body.renames : [];
      if (renames.length && enquiry.costingSheets?.length) {
        const newNames = new Set(enquiry.products.map((p) => p.product));
        for (const { from, to } of renames) {
          if (!from || !to || from === to || !newNames.has(to)) continue;
          const sheet = enquiry.costingSheets.find((s) => s.productName === from);
          if (sheet) sheet.productName = to;
        }
      }
    }
    // References likewise.
    if ("references" in body) {
      enquiry.references = sanitizeReferences(body.references) || [];
    }

    // Losing an enquiry needs a reason — that's the whole point of recording it.
    if (enquiry.status === "lost" && !enquiry.lostReason) {
      return res.status(400).json({ success: false, message: "A lost enquiry needs a reason." });
    }
    // Clear the lost reason if the enquiry is no longer lost.
    if (enquiry.status !== "lost") {
      enquiry.lostReason = undefined;
      enquiry.lostReasonNote = undefined;
    }

    enquiry.updatedBy = actor(req);
    await enquiry.save();

    // Stage-progressive deal value: the enquiry's opportunity size is the
    // INDICATIVE value at this stage, so mirror it onto the journey's
    // expectedValue with confirmed=false (the header/board reads one number,
    // labelled "estimated"). A firmer number from Cost & Quote later sets
    // confirmed=true and outranks this — so we never overwrite a confirmed value.
    if ("opportunitySize" in body) {
      const journey = await SalesJourney.findById(enquiry.journeyId).select("expectedValue");
      if (journey && !journey.expectedValue?.confirmed) {
        journey.expectedValue = {
          amount: enquiry.opportunitySize,
          currency: (enquiry.pricingCurrency || "INR").toUpperCase(),
          confirmed: false,
        };
        await journey.save();
      }
    }

    return res.json({ success: true, enquiry: await decorate(enquiry) });
  } catch (err) {
    console.error("[enquiries] PATCH /:id", err);
    return res.status(400).json({ success: false, message: err.message });
  }
});

// GET /api/cms/crm/enquiries/cowork-employees
// The "assign to" candidate list for a new costing sheet — every CoWork
// employee, so the picker can suggest people the same way CoWork's own
// ShareMenu does (Cowork/lib/legacy/employees.ts listMembers(), unrestricted
// to CEO/TL). Queried directly against Firestore rather than proxying that
// route: it requires a Firebase ID token, which a CMS session does not
// carry, and grav-backend already holds the Admin SDK credential for this
// same project — see services/coworkSheets.service.js's own header for why
// that's the established pattern here, not a workaround.
router.get("/cowork-employees", salesAuth, async (req, res) => {
  try {
    const { db } = require("../../../config/firebaseAdmin");
    const snap = await db.collection("cowork_employees").get();
    const employees = snap.docs
      .map((d) => {
        const x = d.data();
        return { employeeId: d.id, name: x.name || d.id, email: x.email || "", role: x.role || "employee" };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return res.json({ success: true, employees });
  } catch (err) {
    console.error("[enquiries] GET /cowork-employees", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Costing sheets ──────────────────────────────────────────────────────────
//
// ONE SHEET PER CONTRIBUTOR (17 Aug 2026). A costing used to be one CoWork
// document with two tabs, shared with the merchandiser and the industrial
// engineer together. CoWork's roles are whole-document — owner|editor|viewer,
// there is no per-tab or per-range permission — so that arrangement could not
// express who owns what, and either contributor could overwrite the other's
// work with nothing to stop them.
//
// A costing is now two documents:
//
//   part "raw"         raw materials      merchandiser        = editor
//   part "operations"  operations / CMP   industrial engineer = editor
//
// The other contributor is a viewer on each (an IE reading the fabric costs is
// normal; an IE editing them is not), and the salesperson who raised it owns
// both. Total FOB is not on either sheet — a formula cannot reach into another
// document — so the CMS composes the two and totals them.
//
// Rows written before the split have no `part` and default to "combined"; those
// documents are still live in CoWork, so every route here handles them.
const {
  createSheet,
  setMembers,
  getSheet,
  getSheetBody,
  updateSheetBody,
} = require("../../../services/coworkSheets.service");
const {
  buildRawMaterialsWorkbook,
  buildOperationsWorkbook,
} = require("../../../services/sheetTemplates");

const PART_LABEL = { raw: "Raw materials", operations: "Operations", combined: "Costing" };
const PART_ROLE = { raw: "merchandiser", operations: "industrialEngineer" };

// Telling the assignee they have work.
//
// Assignment used to write `costingTeam` and set the CoWork permissions and stop
// there — so the merchandiser or the IE only discovered a sheet was theirs if a
// salesperson messaged them. Web push is what this codebase already has
// (services/NotificationService.js); it no-ops when VAPID is unconfigured, so
// this is best-effort by design and must never fail the assignment.
async function notifyAssignee(assignee, { enquiry, productName, part }) {
  if (!assignee?.employeeId) return;
  const role = ROLE_LABEL[PART_ROLE[part]] || "contributor";
  try {
    await NotificationService.sendToUser(assignee.employeeId, {
      title: `Costing sheet assigned — ${productName}`,
      body: `You are the ${role} on ${enquiry.enquiryId}. Open the sheet to fill it in.`,
      data: { kind: "costing_sheet_assigned", enquiryId: enquiry.enquiryId, productName, part },
    });
  } catch (err) {
    console.error("[enquiries] notifyAssignee", err.message);
  }
}
const ROLE_LABEL = { merchandiser: "merchandiser", industrialEngineer: "industrial engineer" };

/** `{employeeId, name}` or null — anything without an employeeId is nothing. */
/**
 * The costing pair used most recently, anywhere.
 *
 * "Remember who the merchandiser and the IE are" without inventing a settings
 * model or a migration: the answer is already in the data — the last enquiry
 * that had a pair chosen. A fresh enquiry pre-fills from it, so the pair is
 * picked once for the company rather than once per enquiry, and the per-enquiry
 * assign route still overrides it whenever this order needs different people.
 *
 * Deliberately not scoped to the caller: the merchandiser and the IE are the
 * same two people whoever is raising the costing, and scoping it per salesperson
 * would mean the second salesperson picks from scratch for no reason.
 */
async function lastUsedCostingTeam(excludeEnquiryId) {
  const q = {
    isActive: true,
    "costingTeam.merchandiser.employeeId": { $exists: true, $ne: "" },
  };
  if (excludeEnquiryId) q._id = { $ne: excludeEnquiryId };
  const prev = await Enquiry.findOne(q).sort({ updatedAt: -1 }).select("costingTeam").lean();
  return prev?.costingTeam || null;
}

function normaliseAssignee(input) {
  const employeeId = String(input?.employeeId || "").trim();
  if (!employeeId) return null;
  return { employeeId, name: String(input?.name || "").trim() };
}

/**
 * The caller's CoWork identity, or null. Every write to a sheet needs one:
 * without it there is no way to say WHO edited, and no way to check whether
 * they were allowed to.
 */
async function coworkIdentity(req) {
  if (!req.user?.id) return null;
  const me = await Employee.findById(req.user.id).select("coworkEmployeeId name email").lean();
  return me?.coworkEmployeeId ? me : null;
}

const NO_COWORK_ACCOUNT = {
  success: false,
  code: "NO_COWORK_ACCOUNT",
  message: "Your account isn't linked to a CoWork identity yet. Ask an administrator to link it on the Access Control page.",
};

/** What this person may do with this document, read from CoWork itself. */
async function roleOn(documentId, coworkEmployeeId) {
  const doc = await getSheet(documentId);
  if (!doc) return { doc: null, role: null };
  const mine = (doc.members || []).find((m) => m.employeeId === coworkEmployeeId);
  return { doc, role: mine?.role || null };
}

const canWrite = (role) => role === "owner" || role === "editor";

// POST /api/cms/crm/enquiries/:id/costing-sheet
// Raise the costing for one product: creates BOTH sheets and hands each to the
// person responsible for it. Creating again for the same product REPLACES the
// costingSheets entries (fresh CoWork documents) rather than editing the old
// ones in place — the old sheets are not deleted from CoWork, just unlinked
// here, since somebody may still have them open.
router.post("/:id/costing-sheet", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne({ _id: req.params.id, isActive: true });
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    const productName = String(req.body?.productName || "").trim();
    if (!productName) return res.status(400).json({ success: false, message: "productName is required." });
    const product = (enquiry.products || []).find((p) => p.product === productName);
    if (!product) return res.status(404).json({ success: false, message: "No product with that name on this enquiry." });

    // The creator must be a real employee with a CoWork account already
    // linked — the same link Access Control's "CoWork account" control
    // establishes (Employee.coworkEmployeeId). Without it there is no
    // CoWork identity to make the sheets' owner, and minting one here would
    // bypass the admin-driven linking flow entirely.
    const me = await coworkIdentity(req);
    if (!me) return res.status(409).json(NO_COWORK_ACCOUNT);

    // Who fills which sheet. Explicit on the request wins; otherwise the team
    // already chosen for this enquiry, so raising the costing for the second
    // and third product does not mean picking the same two people again.
    // Explicit on the request wins; then the pair already on this enquiry; then
    // the pair used most recently on any enquiry. The last step is what makes
    // this "chosen once" instead of "chosen every time" — before it, every new
    // enquiry started blank even though the answer had not changed in months.
    const remembered = await lastUsedCostingTeam(enquiry._id);
    const team = {
      merchandiser:
        normaliseAssignee(req.body?.merchandiser)
        || normaliseAssignee(enquiry.costingTeam?.merchandiser)
        || normaliseAssignee(remembered?.merchandiser),
      industrialEngineer:
        normaliseAssignee(req.body?.industrialEngineer)
        || normaliseAssignee(enquiry.costingTeam?.industrialEngineer)
        || normaliseAssignee(remembered?.industrialEngineer),
    };
    if (team.merchandiser && team.merchandiser.employeeId === team.industrialEngineer?.employeeId) {
      return res.status(400).json({
        success: false,
        message: "The merchandiser and the industrial engineer have to be two different people — one person cannot hold both sheets.",
      });
    }

    const context = {
      enquiry: { enquiryId: enquiry.enquiryId, customerName: (await decorate(enquiry)).customerName, enquiryDate: enquiry.enquiryDate },
      product,
    };

    const plan = [
      { part: "raw", workbook: buildRawMaterialsWorkbook(context), assignee: team.merchandiser, other: team.industrialEngineer },
      { part: "operations", workbook: buildOperationsWorkbook(context), assignee: team.industrialEngineer, other: team.merchandiser },
    ];

    const created = [];
    for (const step of plan) {
      // The person responsible edits; the other contributor reads. Sharing the
      // counterpart as a viewer is deliberate — costing decisions reference each
      // other constantly, and making people ask for access to LOOK is how a
      // costing ends up copy-pasted into a chat message.
      const shareWith = [];
      if (step.assignee && step.assignee.employeeId !== me.coworkEmployeeId) {
        shareWith.push({ employeeId: step.assignee.employeeId, name: step.assignee.name, role: "editor" });
      }
      if (step.other && step.other.employeeId !== me.coworkEmployeeId
          && step.other.employeeId !== step.assignee?.employeeId) {
        shareWith.push({ employeeId: step.other.employeeId, name: step.other.name, role: "viewer" });
      }

      const title = `${PART_LABEL[step.part]} — ${productName}`;
      const { documentId } = await createSheet({
        title,
        creatorEmployeeId: me.coworkEmployeeId,
        shareWith,
        workbook: step.workbook,
      });

      created.push({
        productName,
        part: step.part,
        documentId,
        title,
        assignee: step.assignee || undefined,
        createdAt: new Date(),
        createdBy: actor(req),
        members: [
          { employeeId: me.coworkEmployeeId, name: me.name || "", role: "owner" },
          ...shareWith,
        ],
      });
    }

    enquiry.costingSheets = [
      ...(enquiry.costingSheets || []).filter((s) => s.productName !== productName),
      ...created,
    ];
    if (team.merchandiser || team.industrialEngineer) {
      enquiry.costingTeam = {
        merchandiser: team.merchandiser || enquiry.costingTeam?.merchandiser,
        industrialEngineer: team.industrialEngineer || enquiry.costingTeam?.industrialEngineer,
      };
    }
    enquiry.updatedBy = actor(req);
    await enquiry.save();

    // Best-effort, after the write has landed: whoever now holds a sheet gets
    // told. Not awaited into the response path beyond this point.
    for (const step of plan) {
      await notifyAssignee(step.assignee, { enquiry, productName: product?.product || "", part: step.part });
    }

    return res.status(201).json({ success: true, costingSheets: created, enquiry: await decorate(enquiry) });
  } catch (err) {
    console.error("[enquiries] POST /:id/costing-sheet", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/cms/crm/enquiries/:id/costing-sheet/assign
// Change who holds a sheet — the "who is the merchandiser, who is the IE"
// control, after the fact. Makes the new person that sheet's editor, records
// them as its assignee, and remembers the pair on the enquiry.
//
// The previous holder is NOT removed. Demoting someone who has been working in
// a sheet, silently, from a screen they cannot see is worse than one extra
// person retaining access; if they should be off it, that is a deliberate act
// through the members route.
router.patch("/:id/costing-sheet/assign", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne({ _id: req.params.id, isActive: true });
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    const productName = String(req.body?.productName || "").trim();
    if (!productName) return res.status(400).json({ success: false, message: "productName is required." });

    const wanted = {
      merchandiser: normaliseAssignee(req.body?.merchandiser),
      industrialEngineer: normaliseAssignee(req.body?.industrialEngineer),
    };
    if (!wanted.merchandiser && !wanted.industrialEngineer) {
      return res.status(400).json({ success: false, message: "Name a merchandiser, an industrial engineer, or both." });
    }
    if (wanted.merchandiser && wanted.industrialEngineer
        && wanted.merchandiser.employeeId === wanted.industrialEngineer.employeeId) {
      return res.status(400).json({
        success: false,
        message: "The merchandiser and the industrial engineer have to be two different people — one person cannot hold both sheets.",
      });
    }

    const sheets = (enquiry.costingSheets || []).filter((s) => s.productName === productName);
    if (!sheets.length) return res.status(404).json({ success: false, message: "No costing sheet exists yet for that product." });

    const changed = [];
    for (const sheet of sheets) {
      const part = sheet.part || "combined";
      const role = PART_ROLE[part];
      const person = role ? wanted[role] : null;
      if (!person) continue;

      await setMembers(sheet.documentId, [{ employeeId: person.employeeId, role: "editor" }]);
      changed.push({ part, assignee: person });
    }
    if (!changed.length) {
      return res.status(400).json({
        success: false,
        message: "This product's costing is a single pre-split sheet, so there is no separate merchandiser and IE sheet to reassign. Raise the costing again to split it.",
      });
    }

    const byPart = new Map(changed.map((c) => [c.part, c.assignee]));
    enquiry.costingSheets = (enquiry.costingSheets || []).map((s) => {
      const plain = s.toObject ? s.toObject() : s;
      if (plain.productName !== productName) return plain;
      const next = byPart.get(plain.part || "combined");
      if (!next) return plain;
      const others = (plain.members || []).filter((m) => m.employeeId !== next.employeeId);
      return {
        ...plain,
        assignee: next,
        members: [...others, { employeeId: next.employeeId, name: next.name, role: "editor" }],
      };
    });
    enquiry.costingTeam = {
      merchandiser: wanted.merchandiser || enquiry.costingTeam?.merchandiser,
      industrialEngineer: wanted.industrialEngineer || enquiry.costingTeam?.industrialEngineer,
    };
    enquiry.updatedBy = actor(req);
    await enquiry.save();

    // Reassignment is the other moment a sheet changes hands. Same best-effort
    // notice, so the new holder is not left to be told by hand.
    for (const c of changed) {
      await notifyAssignee(c.assignee, { enquiry, productName, part: c.part });
    }

    return res.json({ success: true, changed, enquiry: await decorate(enquiry) });
  } catch (err) {
    console.error("[enquiries] PATCH /:id/costing-sheet/assign", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/cms/crm/enquiries/:id/costing-sheet/members
// Add (or change the role of) one OR MORE people on an ALREADY-CREATED
// costing sheet, in one request — the multi-person case: a sales person
// assigning a whole team to a sheet at once, not just at creation time.
// Accepts either `{members:[{employeeId,name,role}, ...]}` or a single
// `{employeeId,name,role}` for convenience. Writes the CoWork document's
// real member list (services/coworkSheets.service.js's setMembers) and
// mirrors the same change into this enquiry's denormalised snapshot in one
// request, so the two never disagree.
//
// `part` picks one of the product's sheets; omitting it applies the change to
// every sheet of that product, which is what "give my manager access to this
// costing" actually means.
router.patch("/:id/costing-sheet/members", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne({ _id: req.params.id, isActive: true });
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    const productName = String(req.body?.productName || "").trim();
    if (!productName) return res.status(400).json({ success: false, message: "productName is required." });
    const part = String(req.body?.part || "").trim();

    const raw = Array.isArray(req.body?.members)
      ? req.body.members
      : req.body?.employeeId
        ? [{ employeeId: req.body.employeeId, name: req.body.name, role: req.body.role }]
        : [];
    if (!raw.length) return res.status(400).json({ success: false, message: "At least one member is required." });

    const additions = raw.map((m) => ({
      employeeId: String(m?.employeeId || "").trim(),
      name: m?.name || "",
      role: m?.role,
    }));
    for (const m of additions) {
      if (!m.employeeId) return res.status(400).json({ success: false, message: "Every member needs an employeeId." });
      if (!SHARE_ROLES.has(m.role)) return res.status(400).json({ success: false, message: `Unknown share role: ${m.role}` });
    }

    const targets = (enquiry.costingSheets || []).filter(
      (s) => s.productName === productName && (!part || (s.part || "combined") === part),
    );
    if (!targets.length) {
      return res.status(404).json({
        success: false,
        message: part
          ? `No ${PART_LABEL[part] || part} sheet exists yet for that product.`
          : "No costing sheet exists yet for that product.",
      });
    }

    for (const sheet of targets) await setMembers(sheet.documentId, additions);

    // Mirror into the denormalised snapshot: replace an existing entry for
    // each added employee, or append.
    const addedIds = new Set(additions.map((m) => m.employeeId));
    const touched = new Set(targets.map((s) => s.documentId));
    enquiry.costingSheets = (enquiry.costingSheets || []).map((s) => {
      const plain = s.toObject ? s.toObject() : s;
      if (!touched.has(plain.documentId)) return plain;
      return { ...plain, members: [...(plain.members || []).filter((m) => !addedIds.has(m.employeeId)), ...additions] };
    });
    enquiry.updatedBy = actor(req);
    await enquiry.save();

    return res.json({ success: true, enquiry: await decorate(enquiry) });
  } catch (err) {
    console.error("[enquiries] PATCH /:id/costing-sheet/members", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/cms/crm/enquiries/:id/costing-sheet/:productName/data
// The actual cell content of a product's costing — every part of it — so the
// CMS can render it as a real table on the journey page instead of sending the
// sales person over to CoWork. The DATA still only ever comes from CoWork
// (whoever holds each sheet fills it in over there); this route just reads what
// they wrote. Reading server-side via the Admin SDK doesn't require the
// viewer's own CoWork identity, so anyone who can see this enquiry can READ its
// costing — writing is a different question, answered by `canEdit` per part and
// enforced on the PATCH below.
router.get("/:id/costing-sheet/:productName/data", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne({ _id: req.params.id, isActive: true })
      .select("costingSheets ownerId").lean();
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    const productName = decodeURIComponent(req.params.productName);
    const sheets = (enquiry.costingSheets || []).filter((s) => s.productName === productName);
    if (!sheets.length) return res.status(404).json({ success: false, message: "No costing sheet exists yet for that product." });

    const me = await coworkIdentity(req);

    const parts = await Promise.all(sheets.map(async (sheet) => {
      const [body, doc] = await Promise.all([
        getSheetBody(sheet.documentId),
        getSheet(sheet.documentId),
      ]);
      const mine = me ? (doc?.members || []).find((m) => m.employeeId === me.coworkEmployeeId) : null;
      // "Who did what" the sheet's own record actually carries — CoWork has no
      // cell-level change log to show, only who created it and who most
      // recently touched it. Real, not invented: employeeIds only, resolved to
      // names on the client against the members list it already has.
      return {
        part: sheet.part || "combined",
        documentId: sheet.documentId,
        title: sheet.title || "",
        assignee: sheet.assignee || null,
        members: sheet.members || [],
        workbook: body?.workbook || null,
        updatedAt: body?.updatedAt || null,
        createdById: doc?.createdById || null,
        lastEditedById: doc?.lastEditedById || null,
        missing: !body,
        myRole: mine?.role || null,
        canEdit: canWrite(mine?.role),
      };
    }));

    // ── Reduce to what this caller is allowed (see costingTier) ────────────
    const bestRole = parts.reduce(
      (best, p) => (p.myRole === "owner" ? "owner" : p.myRole === "editor" && best !== "owner" ? "editor" : best),
      null,
    );
    const tier = await costingTier(req, enquiry, bestRole);
    const totals = costingTotals(parts.map((p) => p.workbook), MARGIN_FLOOR_PERCENT);

    if (tier !== "sheet") {
      // The workbook never leaves the server for these callers. What they get is
      // the answer, not the working: a floor price, plus cost per piece if they
      // are the deal owner or a manager.
      return res.json({
        success: true,
        tier,
        linked: Boolean(me),
        summary: tier === "cost"
          ? totals
          : { costed: totals.costed, floorPrice: totals.floorPrice, floorPercent: totals.floorPercent },
        parts: parts.map((p) => ({
          part: p.part,
          title: p.title,
          assignee: p.assignee,
          updatedAt: p.updatedAt,
          missing: p.missing,
          myRole: p.myRole,
          canEdit: false,
        })),
      });
    }

    const legacy = parts.find((p) => p.part === "combined");
    return res.json({
      success: true,
      tier,
      summary: totals,
      parts,
      linked: Boolean(me),
      // Pre-split shape, for a costing that is still one two-tab document.
      workbook: legacy?.workbook ?? null,
      updatedAt: legacy?.updatedAt ?? null,
      createdById: legacy?.createdById ?? null,
      lastEditedById: legacy?.lastEditedById ?? null,
    });
  } catch (err) {
    console.error("[enquiries] GET /:id/costing-sheet/:productName/data", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/cms/crm/enquiries/:id/costing-sheet/:productName/data
// Save an edit made on the CMS's own costing form back into the CoWork sheet
// (11 Aug 2026, explicit request — this used to be read-only by design; see
// services/coworkSheets.service.js's updateSheetBody for why that changed and,
// importantly, what it still can't fully protect against: this is NOT a safe
// concurrent editor. CoWork's live collaboration (Yjs) is not replicated here,
// so a save from here can still collide with someone editing the same sheet in
// CoWork at the same moment. `expectedUpdatedAt` (send back whatever GET
// .../data last returned) catches the ordinary case — two edits minutes apart —
// as a real 409, not a silent overwrite.
//
// THE SHEET'S OWN PERMISSIONS DECIDE (17 Aug 2026). Until now this route let
// any salesperson overwrite any costing workbook, which made the per-sheet
// roles decorative: the split would have separated the documents while leaving
// the CMS a way around them. The caller's role on THAT document is read from
// CoWork and must be owner or editor.
router.patch("/:id/costing-sheet/:productName/data", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne({ _id: req.params.id, isActive: true }).select("costingSheets").lean();
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    const productName = decodeURIComponent(req.params.productName);
    const part = String(req.body?.part || "combined").trim();
    const sheet = (enquiry.costingSheets || []).find(
      (s) => s.productName === productName && (s.part || "combined") === part,
    );
    if (!sheet) {
      return res.status(404).json({
        success: false,
        message: `No ${PART_LABEL[part] || part} sheet exists yet for that product.`,
      });
    }

    const workbook = req.body?.workbook;
    if (!workbook || !Array.isArray(workbook.sheets)) {
      return res.status(400).json({ success: false, message: "A valid workbook (with a sheets array) is required." });
    }

    const me = await coworkIdentity(req);
    if (!me) return res.status(409).json(NO_COWORK_ACCOUNT);

    const { doc, role } = await roleOn(sheet.documentId, me.coworkEmployeeId);
    if (!doc) return res.status(404).json({ success: false, message: "The costing sheet could not be found in CoWork." });
    if (!canWrite(role)) {
      const holder = sheet.assignee?.name;
      const who = PART_ROLE[part] ? ROLE_LABEL[PART_ROLE[part]] : "person";
      return res.status(403).json({
        success: false,
        code: "NOT_AN_EDITOR",
        message: holder
          ? `This is ${holder}'s sheet — you can read it, but only its ${who} can change it.`
          : `You can read this sheet, but you are not an editor on it, so you cannot change it.`,
      });
    }

    try {
      const { updatedAt } = await updateSheetBody(sheet.documentId, workbook, me.coworkEmployeeId, req.body?.expectedUpdatedAt);
      return res.json({ success: true, updatedAt });
    } catch (err) {
      if (err.code === "CONFLICT") return res.status(409).json({ success: false, code: "CONFLICT", message: err.message });
      throw err;
    }
  } catch (err) {
    console.error("[enquiries] PATCH /:id/costing-sheet/:productName/data", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});


// ─── Production ──────────────────────────────────────────────────────────────
//
// The journey's own production picture, counted from the work orders rather
// than reported by anybody. See services/productionView.js for what each number
// is made of and, importantly, for the one thing it refuses to draw.
const { buildProductionView } = require("../../../services/productionView");
const WorkOrder = require("../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = require("../../../models/Customer_Models/CustomerRequest");
const PortalCustomer = require("../../../models/Customer_Models/Customer");

/**
 * The CustomerRequest this enquiry's production hangs off.
 *
 * Prefers the stored link. Falls back to matching the portal customer by name —
 * the same guess the PI panel makes — and PERSISTS the result, so the guess
 * happens at most once and every later read is exact.
 */
async function resolveRequestId(enquiry, customerName) {
  if (enquiry.customerRequestId) return { id: enquiry.customerRequestId, resolved: "stored" };
  const name = String(customerName || "").trim();
  if (!name) return { id: null, resolved: "none" };

  const customers = await PortalCustomer.find({
    $or: [{ name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") },
          { "profile.companyName": new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") }],
  }).select("_id").limit(2).lean();
  // Two matches is not a match. Guessing between them would attach a journey to
  // another customer's production, which is worse than showing nothing.
  if (customers.length !== 1) return { id: null, resolved: customers.length ? "ambiguous" : "none" };

  const req = await CustomerRequest.findOne({ customerId: customers[0]._id })
    .sort({ createdAt: -1 }).select("_id").lean();
  if (!req) return { id: null, resolved: "no-request" };

  await Enquiry.updateOne({ _id: enquiry._id }, { $set: { customerRequestId: req._id } });
  return { id: req._id, resolved: "matched" };
}

// PATCH /api/cms/crm/enquiries/:id/link-request
// Record which CustomerRequest this enquiry's quotation lives on. Called the
// first time the quotation engine opens, so production never has to guess.
router.patch("/:id/link-request", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const requestId = String(req.body?.requestId || "").trim();
    if (!isObjectId(requestId)) return res.status(400).json({ success: false, message: "A valid requestId is required." });
    const exists = await CustomerRequest.exists({ _id: requestId });
    if (!exists) return res.status(404).json({ success: false, message: "No such customer request." });

    const enquiry = await Enquiry.findOneAndUpdate(
      { _id: req.params.id, isActive: true },
      { $set: { customerRequestId: requestId, updatedBy: actor(req) } },
      { new: true },
    );
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });
    return res.json({ success: true, enquiry: await decorate(enquiry) });
  } catch (err) {
    console.error("[enquiries] PATCH /:id/link-request", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/cms/crm/enquiries/:id/production
// Every work order for this enquiry, reduced to the production view model.
// `linked:false` with a `reason` is a real answer — it means this journey has
// no production to show yet, which is different from production going badly.
router.get("/:id/production", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne({ _id: req.params.id, isActive: true });
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    const decorated = await decorate(enquiry);
    const { id: requestId, resolved } = await resolveRequestId(enquiry, decorated.customerName);
    if (!requestId) {
      return res.json({
        success: true,
        linked: false,
        reason: resolved === "ambiguous"
          ? `More than one portal customer matches “${decorated.customerName}”, so this journey cannot be tied to a specific order.`
          : resolved === "no-request"
            ? "This customer has no order in the portal yet, so nothing has been released to production."
            : "This enquiry is not linked to a customer order yet — production starts from one.",
      });
    }

    const workOrders = await WorkOrder.find({ customerRequestId: requestId })
      .select("workOrderNumber stockItemName stockItemReference variantAttributes quantity status "
            + "assignedDeadline productionCompletion customerName")
      .lean();

    if (!workOrders.length) {
      return res.json({
        success: true, linked: true, requestId: String(requestId), workOrders: 0,
        reason: "The order exists but no work order has been raised against it yet.",
      });
    }

    return res.json({
      success: true,
      linked: true,
      requestId: String(requestId),
      view: buildProductionView(workOrders),
    });
  } catch (err) {
    console.error("[enquiries] GET /:id/production", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});


// ─── Shipment ────────────────────────────────────────────────────────────────
//
// Production's last column, continued: a piece through the final operation is
// packed, and a packed piece that has not been dispatched is ready to ship. See
// services/shipmentView.js for what each figure is made of and for the two
// things it refuses to show (a "received" state and anything about freight).
const { buildShipmentView } = require("../../../services/shipmentView");
const DispatchChallan = require("../../../models/CMS_Models/Manufacturing/Dispatch/DispatchChallan");

// GET /api/cms/crm/enquiries/:id/shipment
router.get("/:id/shipment", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne({ _id: req.params.id, isActive: true });
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    const decorated = await decorate(enquiry);
    const { id: requestId, resolved } = await resolveRequestId(enquiry, decorated.customerName);
    if (!requestId) {
      return res.json({
        success: true, linked: false,
        reason: resolved === "ambiguous"
          ? `More than one portal customer matches “${decorated.customerName}”, so this journey cannot be tied to a specific order.`
          : "This enquiry is not linked to a customer order yet — nothing can be dispatched against it.",
      });
    }

    const [workOrders, challans] = await Promise.all([
      WorkOrder.find({ customerRequestId: requestId })
        .select("workOrderNumber stockItemName stockItemReference variantAttributes quantity status "
              + "assignedDeadline dispatchedQuantity productionCompletion.operationCompletion")
        .lean(),
      DispatchChallan.find({ manufacturingOrderId: requestId })
        .select("challanNumber dispatchType totalUnits totalPersons persons.employeeName persons.employeeUIN "
              + "persons.department persons.designation persons.totalUnits dispatchedBy notes createdAt")
        .lean(),
    ]);

    if (!workOrders.length) {
      return res.json({
        success: true, linked: true, requestId: String(requestId), workOrders: 0,
        reason: "No work order has been raised against this order yet, so nothing has been packed.",
      });
    }

    return res.json({
      success: true,
      linked: true,
      requestId: String(requestId),
      view: buildShipmentView(workOrders, challans, enquiry.earlyDispatchRequests || []),
    });
  } catch (err) {
    console.error("[enquiries] GET /:id/shipment", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/enquiries/:id/early-dispatch
// Ask dispatch to send some of the order ahead of the schedule.
//
// This is the ONE write Sales has on the shipment stage, and it is deliberately
// a request rather than a dispatch: the dispatch team owns the schedule and the
// challan. What Sales owns is the customer's reason for breaking it.
router.post("/:id/early-dispatch", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne({ _id: req.params.id, isActive: true });
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    const pieces = Number(req.body?.pieces);
    const reason = String(req.body?.reason || "").trim();
    if (!Number.isFinite(pieces) || pieces < 1) {
      return res.status(400).json({ success: false, message: "How many pieces are needed early?" });
    }
    // Never pre-coded: dispatch has to read why the schedule is being broken.
    if (reason.length < 8) {
      return res.status(400).json({ success: false, message: "Give dispatch the reason in your own words — one line is enough." });
    }

    // Cannot ask for more than is actually packed and still here.
    const decorated = await decorate(enquiry);
    const { id: requestId } = await resolveRequestId(enquiry, decorated.customerName);
    if (requestId) {
      const workOrders = await WorkOrder.find({ customerRequestId: requestId })
        .select("quantity dispatchedQuantity productionCompletion.operationCompletion").lean();
      const view = buildShipmentView(workOrders, [], []);
      if (pieces > view.totals.ready) {
        return res.status(400).json({
          success: false,
          message: `Only ${view.totals.ready} piece${view.totals.ready === 1 ? " is" : "s are"} packed and still here. `
                 + `Ask for that many or fewer.`,
        });
      }
    }

    const neededBy = req.body?.neededBy ? new Date(req.body.neededBy) : null;
    enquiry.earlyDispatchRequests = [
      ...(enquiry.earlyDispatchRequests || []),
      {
        pieces,
        reason,
        neededBy: neededBy && !Number.isNaN(neededBy.valueOf()) ? neededBy : null,
        status: "requested",
        requestedAt: new Date(),
        requestedBy: actor(req),
      },
    ];
    enquiry.updatedBy = actor(req);
    await enquiry.save();

    return res.status(201).json({ success: true, enquiry: await decorate(enquiry) });
  } catch (err) {
    console.error("[enquiries] POST /:id/early-dispatch", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});


// ─── Order Closing Report ─────────────────────────────────────────────────────
//
// The journey's last act: what was ordered against what was delivered, what it
// was meant to cost against what it did, and whether the money is in. See
// services/closingReport.js for what each figure is made of — and for the one
// half (the costing-sheet estimate) the client joins, because the reader for a
// CoWork workbook already lives there.
const { buildClosingReport } = require("../../../services/closingReport");
const CustomerRequestModel = require("../../../models/Customer_Models/CustomerRequest");

// GET /api/cms/crm/enquiries/:id/closing-report
router.get("/:id/closing-report", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne({ _id: req.params.id, isActive: true });
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    const decorated = await decorate(enquiry);
    const { id: requestId } = await resolveRequestId(enquiry, decorated.customerName);
    if (!requestId) {
      return res.json({
        success: true, linked: false,
        reason: "This enquiry is not linked to a customer order, so there is nothing to close.",
      });
    }

    const [workOrders, challans, request] = await Promise.all([
      WorkOrder.find({ customerRequestId: requestId })
        .select("workOrderNumber stockItemName stockItemReference variantAttributes quantity assignedDeadline "
              + "dispatchedQuantity estimatedCost actualCost rawMaterials.quantityIssued rawMaterials.unitCost "
              + "productionCompletion.operationCompletion productionCompletion.timeMetrics "
              + "productionCompletion.invalidScansCount")
        .lean(),
      DispatchChallan.find({ manufacturingOrderId: requestId })
        .select("challanNumber dispatchType totalUnits totalPersons createdAt "
              + "persons.employeeName persons.department persons.totalUnits")
        .lean(),
      CustomerRequestModel.findById(requestId)
        .select("requestId grandTotal paymentSchedule quotations.grandTotal").lean(),
    ]);

    if (!workOrders.length) {
      return res.json({
        success: true, linked: true, requestId: String(requestId), workOrders: 0,
        reason: "No work order was ever raised against this order, so there is nothing to report on.",
      });
    }

    const report = buildClosingReport({ workOrders, challans, request, enquiry: enquiry.toObject() });

    // ── The same rule as the costing sheet, applied to the closing report ────
    //
    // Aggregate cost goes to the deal owner and sales managers; nobody else in
    // Sales gets it. And MARGIN COUNTS AS COST: profit = revenue − cost, so
    // showing a margin percentage to someone who can see the invoice total
    // hands them the cost by subtraction. Gating one and not the other would be
    // arithmetic theatre, so they move together.
    //
    // What every viewer keeps is what they can act on: what was delivered, when,
    // whether it is paid, what the customer now owns, and the closing checks.
    const tier = await costingTier(req, enquiry, null);
    if (tier === "floor") {
      const { costing, ...rest } = report;
      return res.json({
        success: true,
        linked: true,
        tier,
        requestId: String(requestId),
        customerName: decorated.customerName,
        report: {
          ...rest,
          costing: null,
          // Per-line cost comes off the lines too — it is the same figure one
          // level down, and leaving it would undo the paragraph above.
          lines: rest.lines.map(({ cost, ...line }) => line),
        },
      });
    }

    return res.json({
      success: true,
      linked: true,
      tier,
      requestId: String(requestId),
      customerName: decorated.customerName,
      report,
    });
  } catch (err) {
    console.error("[enquiries] GET /:id/closing-report", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
