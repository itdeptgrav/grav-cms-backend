// services/merchandising/tnaMilestoneLibrary.service.js
//
// THE ONE READER AND WRITER OF THE COMPANY'S MILESTONE LIBRARY.
//
// A template author picks from this list. They do not describe a milestone,
// because a described milestone is a new milestone, and two of those wearing
// the same words is how "how late is the trim card across every order" became
// unanswerable. See the model's header for the duplicates this replaced.
"use strict";

const {
  TnaMilestoneDefinition, MILESTONE_STAGE, MILESTONE_CATEGORY, COMPLETION_METHOD,
  nameIdentity,
} = require("../../models/CMS_Models/Merchandising/TnaMilestoneDefinition");
const { OWNER_DEPARTMENT, COMPLETION_AUTHORITY } = require("../../models/CMS_Models/Merchandising/TnaTemplate");
const sourceEvents = require("./tnaSourceEvents");

const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();

/**
 * ── TWO NAMES FOR THE CODE, AND WHERE EACH BELONGS ────────────────────────
 * Everything a person or a caller sees says `milestoneCode`, because that is
 * what it is to a reader of a template. On disk it is `code`, the shared
 * configuration collection's identity field — which is how the collection's
 * existing unique index `{companyId, code, kind}` gives company-scoped
 * milestone-code uniqueness without a new index on a live cluster.
 *
 * This reads either shape, so the shipped library (authored with
 * `milestoneCode`) and a document from the database can be handed to the same
 * function. It is the ONLY place the two spellings meet.
 */
const codeOf = (d) => str(d?.code || d?.milestoneCode).toUpperCase();

/* ── THE TWO VOCABULARIES, JOINED IN ONE PLACE ──────────────────────────────
   The library says MANUAL / SYSTEM_EVENT, which is how a process owner talks.
   A plan says MERCHANDISING / SOURCE_EVENT, which is who may write the date.
   This is the only conversion, so neither list has to know about the other. */
function authorityFor(completionMethod) {
  return completionMethod === COMPLETION_METHOD.MANUAL
    ? COMPLETION_AUTHORITY.MERCHANDISING
    : COMPLETION_AUTHORITY.SOURCE_EVENT;
}

const DEFINITION_FIELDS = Object.freeze([
  "milestoneCode", "name", "explanation", "category", "stage", "ownerDepartment",
  "completionMethod", "systemEventKey", "completionCriteria", "proofRequired", "isActive",
]);

/* ═══ THE SHIPPED LIBRARY ═══════════════════════════════════════════════════
   Normalised from the ~19 distinct milestone names found across the starter
   template, the demo seeds and the tests. Every name here is what a
   merchandiser reads: ordinary words, no jargon. The `replaces` field records
   the codes this entry absorbed, which is what makes the duplicate report and
   any later reconciliation possible without guessing.

   `stage` is the boundary that stops Development work being asked for twice.
   DEVELOPMENT entries are here so the library is the whole company's list —
   an Order Execution template cannot select them (`assertSelectable`). */
const STARTER_LIBRARY = Object.freeze([
  /* ── THE TEN THE STARTER TEMPLATE ALREADY USES ──────────────────────────
     Their codes are UNCHANGED. Published template versions and live plans
     reference them, `seed-tna-starter.isShippedStarter` recognises a company's
     untouched starter by them, and a code is the one thing in a milestone that
     may never move. What changes is the `name` — the words on screen — because
     that is what the complaint was about, and a plan keeps its own copy of the
     words it was agreed in, so no running order is re-labelled underneath
     anybody.

     Every one now points at a NAMED system action. Six of them carried an
     empty event list before, under the documented convention "no application
     publishes this yet". That convention said the right thing badly: a screen
     could say a milestone was not connected, but not what it was waiting for
     or who owed it. The registry now names all six, so the same milestones say
     "waiting on Store's goods receipt" instead of "waiting on nothing". None
     of them completes today — a PLANNED kind has no producer — so this changes
     what a person is told, not what the system does. */
  {
    milestoneCode: "TRIM_CARD_APPROVED",
    name: "Materials and trims approved",
    explanation: "Merchandising has approved the materials and trims this order will use.",
    category: MILESTONE_CATEGORY.MATERIALS, stage: MILESTONE_STAGE.ORDER_EXECUTION,
    ownerDepartment: OWNER_DEPARTMENT.MERCHANDISING,
    completionMethod: COMPLETION_METHOD.SYSTEM_EVENT,
    systemEventKey: "merchandising.material_trim_card.approved",
    completionCriteria: "An approved materials and trims revision on this order.",
    proofRequired: "The approved revision number.",
    replaces: ["TRIM_APPROVED", "MATERIALS_APPROVED"],
    nameNote: 'Was "Trim card approved", which named the document rather than '
      + "the decision and left fabric sounding out of scope. `TRIM_APPROVED` "
      + "carried the identical words under a second code.",
  },
  {
    milestoneCode: "PACKAGING_APPROVED",
    name: "Packaging approved",
    explanation: "Merchandising has approved how this order will be packed.",
    category: MILESTONE_CATEGORY.PACKAGING, stage: MILESTONE_STAGE.ORDER_EXECUTION,
    ownerDepartment: OWNER_DEPARTMENT.MERCHANDISING,
    completionMethod: COMPLETION_METHOD.SYSTEM_EVENT,
    systemEventKey: "merchandising.packaging_spec.approved",
    completionCriteria: "An approved packaging revision on this order.",
    proofRequired: "The approved revision number.",
    nameNote: 'Was "Packaging specification approved".',
  },
  {
    milestoneCode: "DEVELOPMENT_APPROVED",
    name: "Development work list approved",
    explanation: "Merchandising has approved the development work this order still needs.",
    category: MILESTONE_CATEGORY.ORDER, stage: MILESTONE_STAGE.ORDER_EXECUTION,
    ownerDepartment: OWNER_DEPARTMENT.MERCHANDISING,
    completionMethod: COMPLETION_METHOD.SYSTEM_EVENT,
    systemEventKey: "merchandising.development_requirements.approved",
    completionCriteria: "An approved development requirements revision on this order.",
    proofRequired: "The approved revision number.",
    nameNote: 'Was "Development requirements approved", which read as though '
      + "the development work itself were finished. It is the list that is agreed.",
  },
  {
    milestoneCode: "SAMPLE_APPROVED",
    name: "Pre-production sample approved",
    explanation: "The buyer has accepted the sample made from this order's own materials.",
    category: MILESTONE_CATEGORY.SAMPLING, stage: MILESTONE_STAGE.BOTH_CONDITIONAL,
    ownerDepartment: OWNER_DEPARTMENT.PRODUCT_DEVELOPMENT,
    completionMethod: COMPLETION_METHOD.SYSTEM_EVENT,
    systemEventKey: "source.pp_sample.approved",
    completionCriteria: "A buyer decision recorded against this order's pre-production sample.",
    proofRequired: "The buyer's written acceptance.",
    ambiguous: 'Was "Buyer approves the sample", which named neither sample. '
      + "Two different approvals wore those words: the DEVELOPMENT sample, "
      + "signed off before the order exists, and this one, made from the "
      + "order's own materials. They are now two entries and this is the "
      + "per-order one. A company that meant the development sample should "
      + "move its template step to DEV_SAMPLE_APPROVED — that is a decision "
      + "about their process, so nothing moves it for them.",
  },
  {
    milestoneCode: "FABRIC_IN_HOUSE",
    name: "Fabric in house",
    explanation: "The fabric for this order has been received and taken into store.",
    category: MILESTONE_CATEGORY.MATERIALS, stage: MILESTONE_STAGE.ORDER_EXECUTION,
    ownerDepartment: OWNER_DEPARTMENT.STORE_SUPPLY_CHAIN,
    completionMethod: COMPLETION_METHOD.SYSTEM_EVENT,
    systemEventKey: "source.store.fabric_in_house",
    completionCriteria: "A goods receipt for this order's fabric.",
    proofRequired: "The goods receipt number.",
    replaces: ["FABRIC_IN"],
    nameNote: "`FABRIC_IN` carried the identical words under a second code.",
  },
  {
    milestoneCode: "TRIMS_IN_HOUSE",
    name: "Trims in house",
    explanation: "The trims for this order have been received and taken into store.",
    category: MILESTONE_CATEGORY.MATERIALS, stage: MILESTONE_STAGE.ORDER_EXECUTION,
    ownerDepartment: OWNER_DEPARTMENT.STORE_SUPPLY_CHAIN,
    completionMethod: COMPLETION_METHOD.SYSTEM_EVENT,
    systemEventKey: "source.store.trims_in_house",
    completionCriteria: "A goods receipt for this order's trims.",
    proofRequired: "The goods receipt number.",
    replaces: ["TRIMS_IN"],
  },
  {
    milestoneCode: "PPC_HANDOVER",
    name: "Order pack sent to production planning",
    explanation: "Everything production planning needs for this order has been submitted to them.",
    category: MILESTONE_CATEGORY.HANDOVER, stage: MILESTONE_STAGE.ORDER_EXECUTION,
    ownerDepartment: OWNER_DEPARTMENT.MERCHANDISING,
    completionMethod: COMPLETION_METHOD.SYSTEM_EVENT,
    systemEventKey: "merchandising.execution_pack.submitted",
    completionCriteria: "A submitted execution pack version for this order.",
    proofRequired: "The submitted pack version.",
    nameNote: 'One code, two names: "Execution pack handed to PPC" in the '
      + 'starter and "File handed to PPC" in a demo. Neither says what it is '
      + 'to somebody outside the department — "pack", "file" and "PPC" are '
      + "all internal words.",
  },
  {
    milestoneCode: "PRODUCTION_START",
    name: "Sewing started",
    explanation: "Sewing has begun on this order.",
    category: MILESTONE_CATEGORY.PRODUCTION, stage: MILESTONE_STAGE.ORDER_EXECUTION,
    ownerDepartment: OWNER_DEPARTMENT.IE_PPC_PRODUCTION,
    completionMethod: COMPLETION_METHOD.SYSTEM_EVENT,
    systemEventKey: "source.production.sewing_started",
    completionCriteria: "A sewing record against this order.",
    proofRequired: "The production record.",
    replaces: ["SEWING_START"],
    nameNote: 'Was "Production starts", which named no particular operation and '
      + "overlapped cutting — two people could reasonably mark it on different "
      + "days. Sewing is the operation the date was always about.",
  },
  {
    milestoneCode: "FINAL_INSPECTION",
    name: "Final inspection passed",
    explanation: "Quality has passed the final inspection for this order.",
    category: MILESTONE_CATEGORY.INSPECTION, stage: MILESTONE_STAGE.ORDER_EXECUTION,
    ownerDepartment: OWNER_DEPARTMENT.QUALITY,
    completionMethod: COMPLETION_METHOD.SYSTEM_EVENT,
    systemEventKey: "source.quality.inspection_passed",
    completionCriteria: "A passed final inspection for this order.",
    proofRequired: "The inspection report.",
  },
  {
    milestoneCode: "EX_FACTORY",
    name: "Goods dispatched",
    explanation: "The finished goods for this order have left the factory.",
    category: MILESTONE_CATEGORY.DISPATCH, stage: MILESTONE_STAGE.ORDER_EXECUTION,
    /* ── LEFT WHERE IT IS, ON PURPOSE ─────────────────────────────────
       Dispatch arguably belongs to Logistics, and LOGISTICS exists in the
       vocabulary. But the owning department decides who may complete a
       milestone, so moving it moves authority, and that is the owner's
       call, not a normalisation script's. Reported, not changed. */
    ownerDepartment: OWNER_DEPARTMENT.IE_PPC_PRODUCTION,
    completionMethod: COMPLETION_METHOD.SYSTEM_EVENT,
    systemEventKey: "source.production.ex_factory",
    completionCriteria: "A dispatch record for this order.",
    proofRequired: "The dispatch challan number.",
    nameNote: '"Ex-factory" is trade jargon. The event key keeps the old word '
      + "because renaming a key would orphan the producer that will publish it.",
  },

  /* ── TWO REAL MOMENTS THE STARTER NEVER HAD A MILESTONE FOR ───────────── */
  {
    milestoneCode: "PP_MEETING_HELD",
    name: "Production readiness meeting held",
    explanation: "The meeting that settles how this order will be made has been held and its minutes issued.",
    category: MILESTONE_CATEGORY.HANDOVER, stage: MILESTONE_STAGE.ORDER_EXECUTION,
    ownerDepartment: OWNER_DEPARTMENT.MERCHANDISING,
    completionMethod: COMPLETION_METHOD.SYSTEM_EVENT,
    systemEventKey: "merchandising.pre_production_meeting.issued",
    completionCriteria: "Issued minutes for this order.",
    proofRequired: "The issued minutes reference.",
  },
  {
    milestoneCode: "CUTTING_START",
    name: "Cutting started",
    explanation: "Cutting has begun on this order.",
    category: MILESTONE_CATEGORY.PRODUCTION, stage: MILESTONE_STAGE.ORDER_EXECUTION,
    ownerDepartment: OWNER_DEPARTMENT.IE_PPC_PRODUCTION,
    completionMethod: COMPLETION_METHOD.SYSTEM_EVENT,
    systemEventKey: "source.production.cutting_started",
    completionCriteria: "A cutting record against this order.",
    proofRequired: "The cutting record.",
  },

  /* ── DEVELOPMENT: WORK THAT HAPPENS BEFORE AN ORDER EXISTS ─────────────
     Here so the list is the whole company's list, and so the boundary can be
     ENFORCED rather than remembered: `assertSelectable` refuses a DEVELOPMENT
     entry on an order template, which is what stops a schedule asking Product
     Development to re-approve a sample the buyer signed off months earlier.

     The three process approvals are BOTH_CONDITIONAL. They belong to
     Development, and they come back on an order only when that order needs
     print, embroidery or wash work the development file did not settle —
     a new placement, a new colour. Which orders those are is Step 2's
     question; this entry only makes it askable. */
  {
    milestoneCode: "DEV_SAMPLE_APPROVED",
    name: "Development sample approved by buyer",
    explanation: "The buyer accepted the development sample of this style, before any order was confirmed.",
    category: MILESTONE_CATEGORY.SAMPLING, stage: MILESTONE_STAGE.DEVELOPMENT,
    ownerDepartment: OWNER_DEPARTMENT.PRODUCT_DEVELOPMENT,
    completionMethod: COMPLETION_METHOD.SYSTEM_EVENT,
    systemEventKey: "source.buyer.approval_received",
    completionCriteria: "A buyer decision recorded against the development sample.",
    proofRequired: "The buyer's written acceptance.",
  },
  {
    milestoneCode: "DEV_PRINT_APPROVED",
    name: "Print approved by buyer",
    explanation: "The buyer has accepted the printed sample for this style.",
    category: MILESTONE_CATEGORY.PRINTING, stage: MILESTONE_STAGE.BOTH_CONDITIONAL,
    ownerDepartment: OWNER_DEPARTMENT.PRODUCT_DEVELOPMENT,
    completionMethod: COMPLETION_METHOD.SYSTEM_EVENT,
    systemEventKey: "source.product_development.print_approved",
    completionCriteria: "A buyer decision recorded against the printed sample.",
    proofRequired: "The approved printed swatch, signed and dated.",
  },
  {
    milestoneCode: "DEV_EMBROIDERY_APPROVED",
    name: "Embroidery approved by buyer",
    explanation: "The buyer has accepted the embroidery sample for this style.",
    category: MILESTONE_CATEGORY.EMBROIDERY, stage: MILESTONE_STAGE.BOTH_CONDITIONAL,
    ownerDepartment: OWNER_DEPARTMENT.PRODUCT_DEVELOPMENT,
    completionMethod: COMPLETION_METHOD.SYSTEM_EVENT,
    systemEventKey: "source.product_development.embroidery_approved",
    completionCriteria: "A buyer decision recorded against the embroidery sample.",
    proofRequired: "The approved embroidered swatch, signed and dated.",
  },
  {
    milestoneCode: "DEV_WASH_APPROVED",
    name: "Wash approved by buyer",
    explanation: "The buyer has accepted the wash standard for this style.",
    category: MILESTONE_CATEGORY.WASHING, stage: MILESTONE_STAGE.BOTH_CONDITIONAL,
    ownerDepartment: OWNER_DEPARTMENT.PRODUCT_DEVELOPMENT,
    completionMethod: COMPLETION_METHOD.SYSTEM_EVENT,
    systemEventKey: "source.product_development.wash_approved",
    completionCriteria: "A buyer decision recorded against the washed sample.",
    proofRequired: "The approved washed garment, signed and dated.",
  },
]);

/* ── WHAT A TEMPLATE FOR THIS STAGE MAY SELECT ──────────────────────────── */
function assertSelectable(def, stage) {
  if (def.stage === MILESTONE_STAGE.BOTH_CONDITIONAL || def.stage === stage) return;
  throw fail("TNA_MILESTONE_WRONG_STAGE",
    `"${def.name}" belongs to ${def.stage === MILESTONE_STAGE.DEVELOPMENT
      ? "Development, which happens before an order is confirmed"
      : "Order Execution"}. `
    + "Putting it on this template would ask for work that is already done.",
    { milestoneCode: codeOf(def), stage: def.stage, templateStage: stage });
}

/* ── VALIDATION OF ONE LIBRARY ENTRY ────────────────────────────────────── */
function shapeDefinition(raw) {
  for (const key of Object.keys(raw || {})) {
    if (!DEFINITION_FIELDS.includes(key)) {
      throw fail("FIELD_NOT_ACCEPTED", `"${key}" is not part of a milestone.`, { field: key });
    }
  }
  const milestoneCode = str(raw.milestoneCode).toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{2,39}$/.test(milestoneCode)) {
    throw fail("VALIDATION", "A milestone code is A–Z, 0–9 and underscores, three characters or more.",
      { field: "milestoneCode" });
  }
  const name = str(raw.name);
  if (!name) throw fail("VALIDATION", `${milestoneCode} needs a name people will read.`, { field: "name" });

  const pick = (field, vocab) => {
    const v = str(raw[field]).toUpperCase();
    if (!Object.values(vocab).includes(v)) {
      throw fail("VALIDATION",
        `${milestoneCode} needs a ${field} of: ${Object.values(vocab).join(", ")}.`, { field });
    }
    return v;
  };
  const completionMethod = pick("completionMethod", COMPLETION_METHOD);
  const systemEventKey = str(raw.systemEventKey);

  /* ── THE KEY IS CHOSEN, NEVER TYPED ─────────────────────────────────
     A key the registry has never heard of is a milestone waiting for a
     message nobody will send. The registry's PLANNED half is accepted on
     purpose: that is the "Not integrated" path, which shows honestly. */
  if (systemEventKey && !sourceEvents.isKnown(systemEventKey)) {
    throw fail("TNA_SOURCE_EVENT_UNKNOWN",
      `${milestoneCode} names a system action this product does not have: "${systemEventKey}". `
      + "Choose one from the list of system actions.",
      { field: "systemEventKey", systemEventKey, known: sourceEvents.knownKinds() });
  }

  return {
    /* `code` on the way to the database; `milestoneCode` everywhere a person
       reads it. See `codeOf`. */
    code: milestoneCode, name,
    explanation: str(raw.explanation),
    category: pick("category", MILESTONE_CATEGORY),
    stage: pick("stage", MILESTONE_STAGE),
    ownerDepartment: pick("ownerDepartment", OWNER_DEPARTMENT),
    completionMethod, systemEventKey,
    completionCriteria: str(raw.completionCriteria),
    proofRequired: str(raw.proofRequired),
    isActive: raw.isActive !== false,
  };
}

/* ── WHAT A TEMPLATE STEP AND A PLAN ROW GET FROM AN ENTRY ──────────────── */
function milestoneFacts(def) {
  return {
    milestoneCode: codeOf(def),
    name: def.name,
    ownerDepartment: def.ownerDepartment,
    completionAuthority: authorityFor(def.completionMethod),
    sourceEventKinds: def.systemEventKey ? [def.systemEventKey] : [],
  };
}

function definitionView(def) {
  const wired = def.systemEventKey ? sourceEvents.stateOf(def.systemEventKey) : null;
  return {
    id: String(def._id || ""),
    milestoneCode: codeOf(def),
    name: def.name,
    explanation: def.explanation || "",
    category: def.category,
    stage: def.stage,
    ownerDepartment: def.ownerDepartment,
    completionMethod: def.completionMethod,
    completedBy: def.completionMethod === COMPLETION_METHOD.MANUAL
      ? "Recorded by a person"
      : "Recorded automatically when the work is done",
    systemEventKey: def.systemEventKey || "",
    systemAction: wired ? wired.label : "",
    integration: wired ? wired.integration : sourceEvents.INTEGRATION.MANUAL,
    notIntegrated: Boolean(wired) && wired.integration !== sourceEvents.INTEGRATION.INTEGRATED,
    integrationNote: wired ? wired.sentence : "",
    completionCriteria: def.completionCriteria || "",
    proofRequired: def.proofRequired || "",
    isActive: def.isActive !== false,
  };
}

/* ── READS ──────────────────────────────────────────────────────────────── */

async function listDefinitions(ctx, { stage, includeInactive = false } = {}) {
  const q = { companyId: ctx.companyId };
  if (stage) q.stage = { $in: [str(stage).toUpperCase(), MILESTONE_STAGE.BOTH_CONDITIONAL] };
  if (!includeInactive) q.isActive = true;
  const rows = await TnaMilestoneDefinition.find(q).sort({ stage: 1, category: 1, name: 1 }).lean();
  return {
    milestones: rows.map(definitionView),
    stages: Object.values(MILESTONE_STAGE),
    categories: Object.values(MILESTONE_CATEGORY),
    /* An empty library is a real state a screen must be able to say out loud. */
    configured: rows.length > 0,
  };
}

/**
 * The map a template version is shaped against.
 *
 * ── THERE IS NO COMPATIBILITY MODE ────────────────────────────────────────
 * An earlier pass let a company with no list keep typing milestone names, so
 * nothing broke on the day this deployed. That was the wrong trade: it made the
 * controlled list optional, and a rule that can be avoided by having no data is
 * not a rule. It also kept producing exactly the records it was built to stop.
 *
 * Reading history and creating new data are different permissions. Every
 * template version already stored, and every plan built from one, is read
 * exactly as stored — nothing here touches a read. What is refused is the
 * creation of another free-text version, and a company with no list is told to
 * set one up rather than quietly allowed to carry on without.
 */
async function libraryFor(companyId) {
  const rows = await TnaMilestoneDefinition
    .find({ companyId, isActive: true })
    .select("code name ownerDepartment completionMethod systemEventKey stage")
    .lean();

  if (!rows.length) {
    throw fail("TNA_MILESTONE_LIBRARY_REQUIRED",
      "This company has no milestone list yet, so a plan template cannot be created or changed. "
      + "A milestone is added to the list once — its name, the department that owns it and the "
      + "system action that completes it — and every template then places the same one. "
      + "Set it up under Management → Plan templates, or seed the standard list with "
      + "`node scripts/readiness/seed-tna-starter.js --apply`.",
      { setupRequired: "TNA_MILESTONE_LIBRARY" });
  }

  const byCode = new Map(rows.map((r) => [r.code, r]));
  return {
    has: (code) => byCode.has(str(code).toUpperCase()),
    get: (code) => byCode.get(str(code).toUpperCase()) || null,
    factsFor: (code) => {
      const def = byCode.get(str(code).toUpperCase());
      return def ? milestoneFacts(def) : null;
    },
    codes: () => [...byCode.keys()].sort(),
    assertSelectable,
  };
}

/* ── WRITES ─────────────────────────────────────────────────────────────── */

/**
 * ── WHY THE LOOK-UP IS NOT THE GUARANTEE ──────────────────────────────────
 * The read below exists to produce a good message — "that name is already
 * FABRIC_IN_HOUSE's" is worth far more than a duplicate-key error. It is NOT
 * what prevents the duplicate: two people saving "Fabric in house" and
 * "fabric in house" in the same second both read nothing and both insert. The
 * unique index on `{companyId, nameKey}` refuses the second, whichever order
 * they arrive in, and that refusal is caught here and given the same words.
 */
async function createDefinition(ctx, body) {
  const shaped = shapeDefinition(body);
  const nameKey = nameIdentity(shaped.name);

  const existing = async () => TnaMilestoneDefinition.findOne({
    companyId: ctx.companyId,
    $or: [{ code: shaped.code }, { nameKey }],
  }).lean();

  const refuse = (clash) => fail("TNA_MILESTONE_EXISTS",
    clash && clash.code === shaped.code
      ? `${shaped.code} is already in the list, as "${clash.name}".`
      : `"${shaped.name}" is already in the list, as ${clash?.code || "another milestone"}`
        + `${clash ? ` ("${clash.name}")` : ""}. Two milestones cannot share one name, `
        + "however it is spelled — that is what makes a report unreadable.",
    { milestoneCode: clash?.code || "", name: clash?.name || "", nameKey });

  const clash = await existing();
  if (clash) throw refuse(clash);

  try {
    const doc = await TnaMilestoneDefinition.create({
      ...shaped, companyId: ctx.companyId, createdBy: ctx.actor, updatedBy: ctx.actor,
    });
    return definitionView(doc.toObject());
  } catch (err) {
    /* The index won the race. Re-read so the message can still name the
       winner, and answer exactly as the checked path would have. */
    if (err?.code === 11000) throw refuse(await existing());
    throw err;
  }
}

/**
 * ── WHAT MAY BE CHANGED LATER, AND WHAT MAY NOT ───────────────────────────
 * The words and the guidance may always be improved. The code may not change,
 * and neither may the stage or the completion method: a running plan carries
 * its own copy of the words, but a template that selected this entry because
 * it was Order Execution work completed by a system action would silently
 * start meaning something else.
 */
const EDITABLE = Object.freeze(["name", "explanation", "completionCriteria", "proofRequired", "isActive"]);

async function updateDefinition(ctx, { milestoneCode } = {}, body = {}) {
  const def = await TnaMilestoneDefinition.findOne({
    companyId: ctx.companyId, code: str(milestoneCode).toUpperCase(),
  });
  if (!def) throw fail("NOT_FOUND", "That milestone is not in the list.");

  for (const key of Object.keys(body)) {
    if (EDITABLE.includes(key)) continue;
    if (DEFINITION_FIELDS.includes(key)) {
      throw fail("TNA_MILESTONE_NOT_EDITABLE",
        `${def.code}'s ${key} cannot be changed. A milestone that means something `
        + "different is a different milestone — add it, and retire this one.",
        { field: key });
    }
    throw fail("FIELD_NOT_ACCEPTED", `"${key}" is not part of a milestone.`, { field: key });
  }
  if (body.name !== undefined) {
    const name = str(body.name);
    if (!name) throw fail("VALIDATION", "A milestone needs a name people will read.", { field: "name" });
    const nameKey = nameIdentity(name);
    if (!nameKey) {
      throw fail("VALIDATION",
        "A milestone's name must contain at least one letter or digit.", { field: "name" });
    }
    /* Same rule as creation, on the same derived identity: a rename into
       another milestone's words is the duplicate arriving by a second door. */
    const clash = await TnaMilestoneDefinition.findOne({
      companyId: ctx.companyId, nameKey, code: { $ne: def.code },
    }).lean();
    if (clash) {
      throw fail("TNA_MILESTONE_EXISTS",
        `"${name}" is already ${clash.code}'s name ("${clash.name}").`,
        { milestoneCode: clash.code, nameKey });
    }
    def.name = name;
    /* `nameKey` is derived by the model's own hook on save, so it cannot be
       left behind by a rename. */
  }
  for (const key of ["explanation", "completionCriteria", "proofRequired"]) {
    if (body[key] !== undefined) def[key] = str(body[key]);
  }
  if (body.isActive !== undefined) def.isActive = body.isActive !== false;

  def.updatedBy = ctx.actor;
  def.revision = (def.revision || 0) + 1;
  try {
    await def.save();
  } catch (err) {
    if (err?.code === 11000) {
      const clash = await TnaMilestoneDefinition.findOne({
        companyId: ctx.companyId, nameKey: nameIdentity(def.name),
        code: { $ne: def.code },
      }).lean();
      throw fail("TNA_MILESTONE_EXISTS",
        `"${def.name}" is already ${clash?.code || "another milestone"}'s name.`,
        { milestoneCode: clash?.code || "" });
    }
    throw err;
  }
  return definitionView(def.toObject());
}

module.exports = {
  MILESTONE_STAGE, MILESTONE_CATEGORY, COMPLETION_METHOD,
  STARTER_LIBRARY, DEFINITION_FIELDS, EDITABLE,
  authorityFor, shapeDefinition, milestoneFacts, definitionView, assertSelectable,
  codeOf,
  nameIdentity,
  listDefinitions, libraryFor, createDefinition, updateDefinition,
};
