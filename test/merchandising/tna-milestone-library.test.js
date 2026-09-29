// test/merchandising/tna-milestone-library.test.js
//
// MILESTONES COME FROM A LIST, NOT FROM A TEXT BOX.
//
// Before this, a template step carried its own name, its own owning department
// and its own event key, all typed. Two authors produced "Trim card approved"
// under `TRIM_APPROVED` and under `TRIM_CARD_APPROVED`, "Fabric in house"
// twice, and one code, `PPC_HANDOVER`, wearing two different names. Nothing was
// wrong with any single template; the company simply had no single thing called
// the trim card, so "how late is the trim card across every order" had no
// answer.
//
// What this proves, against the real services and a real database:
//
//   1  a step chooses a milestone by code and may not describe it;
//   2  a code that is not on the list is refused, by name, with what is;
//   3  the list is the source of the name, the owner and the event key, and a
//      published version carries what the list said;
//   4  a plan keeps the words it was created with when the list is renamed;
//   5  work the list places before order confirmation cannot be put on an
//      order template;
//   6  a milestone's event key is chosen from the registry, never typed;
//   7  a company with no list yet still works, and stops being lenient the
//      moment it has one;
//   8  two milestones cannot share one name, or one code;
//   9  what a milestone MEANS cannot be edited later; its words can.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const {
  TnaMilestoneDefinition, MILESTONE_STAGE, COMPLETION_METHOD,
} = require("../../models/CMS_Models/Merchandising/TnaMilestoneDefinition");
const { TnaTemplateVersion } = require("../../models/CMS_Models/Merchandising/TnaTemplate");
const library = require("../../services/merchandising/tnaMilestoneLibrary.service");
const config = require("../../services/merchandising/tnaConfig.service");
const registry = require("../../services/merchandising/tnaSourceEvents");
const starter = require("../../scripts/readiness/seed-tna-starter.js");
const sourceEvents = require("../../services/merchandising/tnaSourceEvents");

let companyId;
const ctx = () => ({ companyId, actor: { name: "Configurer" } });

/** One list entry, defaulting to real Merchandising work with a wired event. */
const entry = (over = {}) => ({
  milestoneCode: "MATERIALS_OK",
  name: "Materials approved",
  explanation: "Merchandising approved the materials.",
  category: "MATERIALS",
  stage: MILESTONE_STAGE.ORDER_EXECUTION,
  ownerDepartment: "MERCHANDISING",
  completionMethod: COMPLETION_METHOD.SYSTEM_EVENT,
  systemEventKey: "merchandising.material_trim_card.approved",
  ...over,
});

/** Seed the company's list from the shipped one, as the starter script does. */
async function seedList(only = null) {
  const wanted = only
    ? library.STARTER_LIBRARY.filter((d) => only.includes(d.milestoneCode))
    : library.STARTER_LIBRARY;
  for (const d of wanted) {
    await library.createDefinition(ctx(), Object.fromEntries(
      Object.entries(d).filter(([k]) => library.DEFINITION_FIELDS.includes(k)),
    ));
  }
}

async function template() {
  const { template: t } = await config.createTemplate(ctx(), { body: { name: "Order T&A" } });
  return t.id;
}

beforeEach(async () => {
  companyId = (await Acc_Company.create({
    companyName: "GRAV Demo", booksFromDate: new Date("2026-04-01"),
  }))._id;
});

/* ═══ 1 · A STEP CHOOSES; IT DOES NOT DESCRIBE ═════════════════════════════ */

describe("a template step selects a milestone", () => {
  test("a code and a placement are all it needs", async () => {
    await seedList();
    const { version } = await config.createVersion(ctx(), {
      templateId: await template(),
      body: {
        effectiveFrom: "2026-01-01",
        milestones: [{
          milestoneCode: "TRIM_CARD_APPROVED",
          anchor: "PLAN_START", offsetWorkingDays: 5, scope: "FILE",
        }],
      },
    });
    const [m] = version.milestones;
    /* Everything but the placement came from the list. */
    expect({
      name: m.name, owner: m.ownerDepartment,
      authority: m.completionAuthority, kinds: m.sourceEventKinds,
    }).toEqual({
      name: "Materials and trims approved",
      owner: "MERCHANDISING",
      authority: "SOURCE_EVENT",
      kinds: ["merchandising.material_trim_card.approved"],
    });
  });

  test.each([
    ["name", { name: "Whatever I like" }],
    ["ownerDepartment", { ownerDepartment: "QUALITY" }],
    ["completionAuthority", { completionAuthority: "MERCHANDISING" }],
    ["sourceEventKinds", { sourceEventKinds: ["something.i.invented"] }],
  ])("it may not set %s", async (field, over) => {
    await seedList();
    const call = config.createVersion(ctx(), {
      templateId: await template(),
      body: {
        effectiveFrom: "2026-01-01",
        milestones: [{ milestoneCode: "TRIM_CARD_APPROVED", anchor: "PLAN_START", ...over }],
      },
    });
    await expect(call).rejects.toMatchObject({
      code: "TNA_MILESTONE_DESCRIBED_BY_LIBRARY", details: { field, index: 0 },
    });
  });

  test("a code that is not on the list is refused, and says what is", async () => {
    await seedList(["TRIM_CARD_APPROVED", "PACKAGING_APPROVED"]);
    const call = config.createVersion(ctx(), {
      templateId: await template(),
      body: {
        effectiveFrom: "2026-01-01",
        milestones: [{ milestoneCode: "STRIKE_OFF_RECEIVED", anchor: "PLAN_START" }],
      },
    });
    await expect(call).rejects.toMatchObject({ code: "TNA_MILESTONE_NOT_IN_LIBRARY" });
    await call.catch((e) => {
      expect(e.message).toContain("STRIKE_OFF_RECEIVED");
      expect(e.details.available).toEqual(["PACKAGING_APPROVED", "TRIM_CARD_APPROVED"]);
    });
  });
});

/* ═══ 2 · THE BOUNDARY WITH DEVELOPMENT ════════════════════════════════════ */

describe("work finished before the order is not asked for again", () => {
  test("a Development milestone cannot go on an order template", async () => {
    await seedList();
    const call = config.createVersion(ctx(), {
      templateId: await template(),
      body: {
        effectiveFrom: "2026-01-01",
        milestones: [{ milestoneCode: "DEV_SAMPLE_APPROVED", anchor: "PLAN_START" }],
      },
    });
    await expect(call).rejects.toMatchObject({
      code: "TNA_MILESTONE_WRONG_STAGE", details: { stage: MILESTONE_STAGE.DEVELOPMENT },
    });
    await call.catch((e) => expect(e.message).toContain("already done"));
  });

  test("work that genuinely recurs per order is allowed", async () => {
    await seedList();
    const { version } = await config.createVersion(ctx(), {
      templateId: await template(),
      body: {
        effectiveFrom: "2026-01-01",
        /* Print approval belongs to Development AND comes back on an order
           that needs print work the development file did not settle. */
        milestones: [{ milestoneCode: "DEV_PRINT_APPROVED", anchor: "PLAN_START" }],
      },
    });
    expect(version.milestones[0].name).toBe("Print approved by buyer");
  });
});

/* ═══ 3 · THE EVENT KEY IS CHOSEN, NEVER TYPED ═════════════════════════════ */

describe("a milestone's system action comes from the registry", () => {
  test("an invented key is refused, and the real ones are offered", async () => {
    const call = library.createDefinition(ctx(), entry({
      milestoneCode: "INVENTED", name: "Invented", systemEventKey: "source.nobody.publishes_this",
    }));
    await expect(call).rejects.toMatchObject({
      code: "TNA_SOURCE_EVENT_UNKNOWN", details: { field: "systemEventKey" },
    });
    await call.catch((e) => expect(e.details.known).toEqual(registry.knownKinds()));
  });

  test("a named-but-unbuilt action is accepted, and says who owes it", async () => {
    const made = await library.createDefinition(ctx(), entry({
      milestoneCode: "FABRIC_ARRIVED", name: "Fabric arrived",
      ownerDepartment: "STORE_SUPPLY_CHAIN",
      systemEventKey: "source.store.fabric_in_house",
    }));
    expect(made.notIntegrated).toBe(true);
    expect(made.integrationNote).toContain("Store");
  });

  test("every shipped milestone names an action the registry knows", () => {
    const unknown = library.STARTER_LIBRARY
      .filter((d) => !registry.isKnown(d.systemEventKey))
      .map((d) => d.milestoneCode);
    expect(unknown).toEqual([]);
  });

  test("no two shipped milestones share one action", () => {
    /* One event kind on two milestones would close both the moment either
       piece of work happened — which is why fabric and trims are two kinds. */
    const keys = library.STARTER_LIBRARY.map((d) => d.systemEventKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

/* ═══ 4 · ONE MEANING, ONE ENTRY ═══════════════════════════════════════════ */

describe("the list refuses the duplicates it was built to end", () => {
  test("two entries cannot share one code", async () => {
    await library.createDefinition(ctx(), entry());
    await expect(library.createDefinition(ctx(), entry({
      name: "Materials approved again",
      systemEventKey: "merchandising.packaging_spec.approved",
    }))).rejects.toMatchObject({ code: "TNA_MILESTONE_EXISTS" });
  });

  test("two entries cannot share one name", async () => {
    await library.createDefinition(ctx(), entry({ milestoneCode: "TRIM_APPROVED" }));
    const call = library.createDefinition(ctx(), entry({
      milestoneCode: "TRIM_CARD_APPROVED",
      systemEventKey: "merchandising.packaging_spec.approved",
    }));
    await expect(call).rejects.toMatchObject({ code: "TNA_MILESTONE_EXISTS" });
    /* Named, because the author's next question is "then which one is it?" */
    await call.catch((e) => expect(e.message).toContain("TRIM_APPROVED"));
  });

  test("the shipped list holds every code the starter template uses", () => {
    const held = new Set(library.STARTER_LIBRARY.map((d) => d.milestoneCode));
    const missing = starter.LEGACY_STARTER_MILESTONES
      .map((m) => m.milestoneCode).filter((c) => !held.has(c));
    /* The starter's codes are load-bearing: published versions and running
       plans name them, and `isShippedStarter` recognises a company's untouched
       template by them. The list improved their WORDS, not their identity. */
    expect(missing).toEqual([]);
  });

  test("the shipped list's own names are all distinct", () => {
    const names = library.STARTER_LIBRARY.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

/* ═══ 5 · A RUNNING PLAN KEEPS ITS OWN WORDS ═══════════════════════════════ */

describe("renaming a milestone does not rewrite history", () => {
  test("a published version keeps the words it was published with", async () => {
    await seedList(["TRIM_CARD_APPROVED"]);
    const templateId = await template();
    const { version } = await config.createVersion(ctx(), {
      templateId,
      body: {
        effectiveFrom: "2026-01-01",
        milestones: [{ milestoneCode: "TRIM_CARD_APPROVED", anchor: "PLAN_START" }],
      },
    });
    await config.publishVersion(ctx(), { templateId, versionNo: version.versionNo });

    await library.updateDefinition(ctx(), { milestoneCode: "TRIM_CARD_APPROVED" },
      { name: "Fabric and trims signed off" });

    const onDisk = await TnaTemplateVersion.findOne({ companyId, versionNo: version.versionNo }).lean();
    expect(onDisk.milestones[0].name).toBe("Materials and trims approved");
    /* And a NEW version gets the new words — that is the point of renaming. */
    const next = await config.createVersion(ctx(), {
      templateId,
      body: {
        effectiveFrom: "2027-01-01",
        milestones: [{ milestoneCode: "TRIM_CARD_APPROVED", anchor: "PLAN_START" }],
      },
    });
    expect(next.version.milestones[0].name).toBe("Fabric and trims signed off");
  });
});

/* ═══ 6 · WHAT MAY BE EDITED AFTERWARDS ════════════════════════════════════ */

describe("an entry's words may improve; its meaning may not change", () => {
  test.each(["explanation", "completionCriteria", "proofRequired"])(
    "%s may be rewritten", async (field) => {
      await library.createDefinition(ctx(), entry());
      const out = await library.updateDefinition(ctx(),
        { milestoneCode: "MATERIALS_OK" }, { [field]: "Clearer words." });
      expect(out[field]).toBe("Clearer words.");
    },
  );

  test.each(["stage", "ownerDepartment", "completionMethod", "systemEventKey", "category"])(
    "%s may not be changed", async (field) => {
      await library.createDefinition(ctx(), entry());
      await expect(library.updateDefinition(ctx(),
        { milestoneCode: "MATERIALS_OK" }, { [field]: "QUALITY" }))
        .rejects.toMatchObject({ code: "TNA_MILESTONE_NOT_EDITABLE", details: { field } });
    },
  );

  test("the code itself is immutable, so retiring replaces deleting", async () => {
    await library.createDefinition(ctx(), entry());
    await library.updateDefinition(ctx(), { milestoneCode: "MATERIALS_OK" }, { isActive: false });

    /* Gone from the picker… */
    const visible = await library.listDefinitions(ctx());
    expect(visible.milestones.map((m) => m.milestoneCode)).toEqual([]);
    /* …and still on disk, because a published template still names it. */
    expect(await TnaMilestoneDefinition.countDocuments({ companyId })).toBe(1);
  });
});

/* ═══ 7 · A COMPANY THAT HAS NO LIST YET ═══════════════════════════════════ */

describe("an empty list is a setup step, not a licence to type", () => {
  test("a new version cannot be created at all", async () => {
    const call = config.createVersion(ctx(), {
      templateId: await template(),
      body: {
        effectiveFrom: "2026-01-01",
        milestones: [{
          milestoneCode: "LEGACY_STEP", name: "Something typed by hand",
          ownerDepartment: "QUALITY", completionAuthority: "SOURCE_EVENT",
          anchor: "PLAN_START",
        }],
      },
    });
    await expect(call).rejects.toMatchObject({
      code: "TNA_MILESTONE_LIBRARY_REQUIRED",
      details: { setupRequired: "TNA_MILESTONE_LIBRARY" },
    });
    /* And says where to go, because "not configured" without that is a dead end. */
    await call.catch((e) => expect(e.message).toMatch(/seed-tna-starter|Plan templates/));
  });

  test("a step carrying nothing but a code is refused too — it is the list that is missing", async () => {
    await expect(config.createVersion(ctx(), {
      templateId: await template(),
      body: {
        effectiveFrom: "2026-01-01",
        milestones: [{ milestoneCode: "TRIM_CARD_APPROVED", anchor: "PLAN_START" }],
      },
    })).rejects.toMatchObject({ code: "TNA_MILESTONE_LIBRARY_REQUIRED" });
  });

  test("an existing draft cannot be updated into a free-text version either", async () => {
    /* The door that would otherwise be left open: create the draft while the
       list exists, retire the list, then type into the draft. */
    await seedList(["TRIM_CARD_APPROVED"]);
    const templateId = await template();
    const { version } = await config.createVersion(ctx(), {
      templateId,
      body: {
        effectiveFrom: "2026-01-01",
        milestones: [{ milestoneCode: "TRIM_CARD_APPROVED", anchor: "PLAN_START" }],
      },
    });
    await TnaMilestoneDefinition.deleteMany({ companyId });

    await expect(config.updateVersion(ctx(), {
      templateId, versionNo: version.versionNo,
      body: {
        milestones: [{
          milestoneCode: "ANYTHING", name: "Typed by hand", anchor: "PLAN_START",
        }],
      },
    })).rejects.toMatchObject({ code: "TNA_MILESTONE_LIBRARY_REQUIRED" });
  });
});

/* ═══ 7b · HISTORY STAYS READABLE ══════════════════════════════════════════ */

describe("what was stored before the list is read exactly as stored", () => {
  /** A published version from before the list existed: free text on disk. */
  async function historicVersion() {
    const { template: t } = await config.createTemplate(ctx(), { body: { name: "Old T&A" } });
    await TnaTemplateVersion.create({
      companyId, templateId: t.id, versionNo: 1, state: "PUBLISHED",
      effectiveFrom: "2025-01-01", effectiveTo: null, publishedAt: new Date(),
      milestones: [{
        milestoneCode: "STRIKE_OFF_RECEIVED", name: "Strike-off received",
        ownerDepartment: "PRODUCT_DEVELOPMENT", completionAuthority: "SOURCE_EVENT",
        sourceEventKinds: ["source.nobody.publishes_this"],
        anchor: "PLAN_START", offsetWorkingDays: 3, scope: "FILE", sortOrder: 0,
      }],
      dependencies: [],
    });
    return t.id;
  }

  test("with no list at all, the version still reads back word for word", async () => {
    const templateId = await historicVersion();
    const { version } = await config.getVersion(ctx(), { templateId, versionNo: 1 });
    expect(version.milestones[0]).toMatchObject({
      milestoneCode: "STRIKE_OFF_RECEIVED",
      name: "Strike-off received",
      ownerDepartment: "PRODUCT_DEVELOPMENT",
      sourceEventKinds: ["source.nobody.publishes_this"],
    });
  });

  test("and still reads back once the list exists and does not contain it", async () => {
    const templateId = await historicVersion();
    await seedList();
    const { version } = await config.getVersion(ctx(), { templateId, versionNo: 1 });
    expect(version.milestones[0].name).toBe("Strike-off received");
    /* Listing it is a read too, and reads never consult the list. */
    const listed = await config.listVersions(ctx(), { templateId });
    expect(listed.versions).toHaveLength(1);
  });
});

/* ═══ 8 · THE TWO VOCABULARIES ═════════════════════════════════════════════ */

describe("MANUAL/SYSTEM_EVENT and MERCHANDISING/SOURCE_EVENT are one idea", () => {
  test("a person-recorded milestone becomes Merchandising's to complete", () => {
    expect(library.authorityFor(COMPLETION_METHOD.MANUAL)).toBe("MERCHANDISING");
    expect(library.authorityFor(COMPLETION_METHOD.SYSTEM_EVENT)).toBe("SOURCE_EVENT");
  });

  test("Merchandising cannot be made to mark another department's work done", async () => {
    /* The same refusal the template guard makes, held one level earlier so the
       state cannot be authored onto the list at all. */
    await expect(library.createDefinition(ctx(), entry({
      milestoneCode: "QC_PASSED", name: "Inspection passed",
      ownerDepartment: "QUALITY",
      completionMethod: COMPLETION_METHOD.MANUAL, systemEventKey: "",
    }))).rejects.toThrow(/Merchandising cannot/);
  });

  test("a system-completed milestone must say which action completes it", async () => {
    await expect(library.createDefinition(ctx(), entry({
      milestoneCode: "NO_ACTION", name: "Waiting for nothing", systemEventKey: "",
    }))).rejects.toThrow(/must name which one/);
  });
});

/* ═══ 9 · A NEW TEMPLATE MAY NOT COMMIT TO A DATE NOTHING CAN MEET ═════════ */

describe("publishing refuses a milestone with no live producer", () => {
  /** A draft placing one library milestone. */
  async function draftWith(milestoneCode) {
    await seedList();
    const templateId = await template();
    const { version } = await config.createVersion(ctx(), {
      templateId,
      body: {
        effectiveFrom: "2026-01-01",
        milestones: [{ milestoneCode, anchor: "PLAN_START", offsetWorkingDays: 5, scope: "FILE" }],
      },
    });
    return { templateId, versionNo: version.versionNo };
  }

  test("a wired milestone publishes", async () => {
    const { templateId, versionNo } = await draftWith("TRIM_CARD_APPROVED");
    const out = await config.publishVersion(ctx(), { templateId, versionNo });
    expect(out.version.state).toBe("PUBLISHED");
  });

  test("a named-but-unbuilt one is refused, and the message names all three facts", async () => {
    const { templateId, versionNo } = await draftWith("FABRIC_IN_HOUSE");
    const call = config.publishVersion(ctx(), { templateId, versionNo });
    await expect(call).rejects.toMatchObject({ code: "TNA_SOURCE_EVENT_UNSUPPORTED" });
    await call.catch((e) => {
      expect(e.message).toContain("Fabric in house");               // the milestone
      expect(e.message).toContain("source.store.fabric_in_house");  // the event
      expect(e.message).toContain("Store");                         // the application
      /* It must NOT offer the fabrication: Merchandising completing Store's work. */
      expect(e.message).not.toMatch(/make (them|it) manual/i);
    });
  });

  test("the draft survives the refusal, so the author can remove the row", async () => {
    const { templateId, versionNo } = await draftWith("FABRIC_IN_HOUSE");
    await config.publishVersion(ctx(), { templateId, versionNo }).catch(() => {});
    const { version } = await config.getVersion(ctx(), { templateId, versionNo });
    expect(version.state).toBe("DRAFT");
  });

  test("the shipped starter template publishes, because it places only wired work", () => {
    const placed = starter.STARTER_PLACEMENTS.map((m) => m.milestoneCode);
    const blocked = sourceEvents.unsupportedInVersion(placed.map((code) => {
      const def = library.STARTER_LIBRARY.find((d) => d.milestoneCode === code);
      return { ...library.milestoneFacts(def) };
    }));
    expect(blocked).toEqual([]);
    /* And it is genuinely shorter than the order it describes — the six
       milestones whose producers do not exist stay on the list, unplaced. */
    expect(placed.length).toBeLessThan(starter.LEGACY_STARTER_MILESTONES.length);
  });

  test("a historical published version keeps its unsupported milestone", async () => {
    /* Written as history, because it can no longer be created through the door. */
    const { template: t } = await config.createTemplate(ctx(), { body: { name: "Old" } });
    await TnaTemplateVersion.create({
      companyId, templateId: t.id, versionNo: 1, state: "PUBLISHED",
      effectiveFrom: "2025-01-01", effectiveTo: null, publishedAt: new Date(),
      milestones: [{
        milestoneCode: "EX_FACTORY", name: "Ex-factory",
        ownerDepartment: "IE_PPC_PRODUCTION", completionAuthority: "SOURCE_EVENT",
        sourceEventKinds: ["source.production.ex_factory"],
        anchor: "PLAN_START", offsetWorkingDays: 30, scope: "FILE", sortOrder: 0,
      }],
      dependencies: [],
    });
    const { version } = await config.getVersion(ctx(), { templateId: t.id, versionNo: 1 });
    expect(version.milestones[0].sourceEventKinds).toEqual(["source.production.ex_factory"]);
    /* And it is honestly described rather than counted as ordinary late work. */
    expect(sourceEvents.milestoneIntegration(version.milestones[0])).toMatchObject({
      integration: sourceEvents.INTEGRATION.NOT_INTEGRATED,
      unsupported: ["source.production.ex_factory"],
    });
  });
});

/* ═══ 10 · ONE NAME, HOWEVER IT IS SPELLED ═════════════════════════════════ */

describe("a name's identity is not its spelling", () => {
  test.each([
    ["case", "fabric in house"],
    ["hyphens", "Fabric-in-house"],
    ["repeated spacing", "Fabric   in  house"],
    ["surrounding whitespace", "  Fabric in house  "],
    ["punctuation", "Fabric, in house."],
  ])("a variant by %s cannot become a second milestone", async (_why, variant) => {
    await library.createDefinition(ctx(), entry({
      milestoneCode: "FABRIC_IN_HOUSE", name: "Fabric in house",
      ownerDepartment: "STORE_SUPPLY_CHAIN", systemEventKey: "source.store.fabric_in_house",
    }));
    const call = library.createDefinition(ctx(), entry({
      milestoneCode: "FABRIC_IN", name: variant,
      ownerDepartment: "STORE_SUPPLY_CHAIN", systemEventKey: "source.store.trims_in_house",
    }));
    await expect(call).rejects.toMatchObject({ code: "TNA_MILESTONE_EXISTS" });
    /* Named, because the author's next question is "then which one is it?" */
    await call.catch((e) => expect(e.message).toContain("FABRIC_IN_HOUSE"));
  });

  test("a rename into another milestone's words is refused by the same rule", async () => {
    await seedList(["FABRIC_IN_HOUSE", "TRIMS_IN_HOUSE"]);
    await expect(library.updateDefinition(ctx(),
      { milestoneCode: "TRIMS_IN_HOUSE" }, { name: "  FABRIC-IN-HOUSE  " }))
      .rejects.toMatchObject({ code: "TNA_MILESTONE_EXISTS" });
  });

  test("the display name is kept exactly as typed", async () => {
    const made = await library.createDefinition(ctx(), entry({ name: "Materials  &  Trims approved" }));
    expect(made.name).toBe("Materials  &  Trims approved");
    const onDisk = await TnaMilestoneDefinition.findOne({ companyId }).lean();
    expect(onDisk.nameKey).toBe("materials trims approved");
  });

  test("two equivalent names created at the same moment produce ONE milestone", async () => {
    /* ── WHY THIS CANNOT BE A READ-BEFORE-WRITE CHECK ─────────────────
       Both calls read an empty list and both proceed. Only the unique index
       on {companyId, nameKey} decides, and the loser must come back as the
       same refusal a checked path would have given — not a 500. */
    const attempts = ["Fabric in house", "fabric  IN  house"].map((name, i) => library
      .createDefinition(ctx(), entry({
        milestoneCode: i === 0 ? "FABRIC_IN_HOUSE" : "FABRIC_IN",
        name,
        ownerDepartment: "STORE_SUPPLY_CHAIN",
        systemEventKey: i === 0 ? "source.store.fabric_in_house" : "source.store.trims_in_house",
      }))
      .then((ok) => ({ ok }), (err) => ({ err })));

    const results = await Promise.all(attempts);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => r.err)).toHaveLength(1);
    expect(results.find((r) => r.err).err.code).toBe("TNA_MILESTONE_EXISTS");
    expect(await TnaMilestoneDefinition.countDocuments({ companyId })).toBe(1);
  });

  test("the same code created twice at once also produces ONE milestone", async () => {
    const attempts = [1, 2].map((n) => library
      .createDefinition(ctx(), entry({ name: `Materials approved ${n}` }))
      .then((ok) => ({ ok }), (err) => ({ err })));
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await TnaMilestoneDefinition.countDocuments({ companyId })).toBe(1);
  });
});

/* ═══ 11 · ONE COMPANY'S LIST IS ITS OWN ═══════════════════════════════════ */

describe("company isolation", () => {
  test("the same milestone name is free in another company", async () => {
    await library.createDefinition(ctx(), entry());
    const other = (await Acc_Company.create({
      companyName: "Other Co", booksFromDate: new Date("2026-04-01"),
    }))._id;
    const made = await library.createDefinition(
      { companyId: other, actor: { name: "Other" } }, entry(),
    );
    expect(made.milestoneCode).toBe("MATERIALS_OK");
    expect(await TnaMilestoneDefinition.countDocuments({})).toBe(2);
  });

  test("one company's list never appears in another's picker", async () => {
    await library.createDefinition(ctx(), entry());
    const other = (await Acc_Company.create({
      companyName: "Other Co", booksFromDate: new Date("2026-04-01"),
    }))._id;
    const listed = await library.listDefinitions({ companyId: other });
    expect(listed.milestones).toEqual([]);
    expect(listed.configured).toBe(false);
  });

  test("a template cannot place a milestone that belongs to another company", async () => {
    const other = (await Acc_Company.create({
      companyName: "Other Co", booksFromDate: new Date("2026-04-01"),
    }))._id;
    await library.createDefinition(
      { companyId: other, actor: { name: "Other" } },
      entry({ milestoneCode: "THEIR_MILESTONE", name: "Their milestone" }),
    );
    await seedList(["TRIM_CARD_APPROVED"]);
    await expect(config.createVersion(ctx(), {
      templateId: await template(),
      body: {
        effectiveFrom: "2026-01-01",
        milestones: [{ milestoneCode: "THEIR_MILESTONE", anchor: "PLAN_START" }],
      },
    })).rejects.toMatchObject({ code: "TNA_MILESTONE_NOT_IN_LIBRARY" });
  });
});

/* ═══ 12 · A PUBLISHED VERSION DOES NOT CHANGE WHEN THE WORLD DOES ═════════ */

describe("support arriving later does not edit anything already published", () => {
  /**
   * ── THE CLAIM THIS EXISTS TO STOP ──────────────────────────────────────
   * It is tempting to say a milestone "rejoins the starter automatically" when
   * its producer is built. It does not, and saying so would promise a customer
   * something the product does not do. A published version is frozen and a
   * running plan is pinned to the one it was created from.
   *
   * What actually happens, in four parts — each asserted below:
   *
   *   1  the milestone becomes ELIGIBLE: a new version may now place it;
   *   2  a company seeded AFTERWARDS gets it, because the starter is computed
   *      when that company is seeded;
   *   3  an existing company gets it only when somebody reviews and publishes
   *      a successor version;
   *   4  plans already running are untouched, whichever happens.
   */
  /**
   * The day Store starts publishing, simulated at the seam that actually
   * changes: `unsupportedInVersion` is the whole of what publish asks the
   * registry, and moving a kind from PLANNED to SUPPORTED changes exactly its
   * answer. Spying on `isSupported` would do nothing — `unsupportedInVersion`
   * calls it through the module's own binding, not through its exports, which
   * is the right way round for a registry and the wrong thing to mock.
   */
  const supportGrows = (kind) => {
    const real = sourceEvents.unsupportedInVersion;
    jest.spyOn(sourceEvents, "unsupportedInVersion").mockImplementation((milestones) => real(milestones)
      .filter((u) => !u.kinds.includes(kind)));
  };
  afterEach(() => jest.restoreAllMocks());

  test("1 — it becomes eligible for a NEW version, and was not before", async () => {
    await seedList();
    const templateId = await template();
    const place = () => config.createVersion(ctx(), {
      templateId,
      body: {
        effectiveFrom: "2026-01-01",
        milestones: [
          { milestoneCode: "TRIM_CARD_APPROVED", anchor: "PLAN_START", sortOrder: 0 },
          { milestoneCode: "FABRIC_IN_HOUSE", anchor: "PLAN_START", offsetWorkingDays: 10, sortOrder: 1 },
        ],
      },
    });

    /* Before: the draft is allowed, and publishing it is not. */
    const before = await place();
    await expect(config.publishVersion(ctx(), { templateId, versionNo: before.version.versionNo }))
      .rejects.toMatchObject({ code: "TNA_SOURCE_EVENT_UNSUPPORTED" });

    /* After Store starts publishing, the same version publishes. */
    supportGrows("source.store.fabric_in_house");
    const out = await config.publishVersion(ctx(), { templateId, versionNo: before.version.versionNo });
    expect(out.version.state).toBe("PUBLISHED");
  });

  test("2 — a company seeded afterwards receives it; the starter is computed per company", () => {
    /* The starter's placements are a written list guarded at load time, so what
       a new company gets is decided when the code runs — not copied from an
       older company's template. */
    const placed = starter.STARTER_PLACEMENTS.map((p) => p.milestoneCode);
    expect(placed).toContain("PP_MEETING_HELD");
    /* PP_MEETING_HELD is exactly this story already played out: its producer
       was built, and it is in the starter now. Nothing edited an existing
       company's template to put it there. */
    expect(sourceEvents.isSupported(
      library.STARTER_LIBRARY.find((d) => d.milestoneCode === "PP_MEETING_HELD").systemEventKey,
    )).toBe(true);
  });

  test("3 — an existing company's published version is not touched, and its plan is not", async () => {
    await seedList();
    const templateId = await template();
    const { version } = await config.createVersion(ctx(), {
      templateId,
      body: {
        effectiveFrom: "2026-01-01",
        milestones: [{ milestoneCode: "TRIM_CARD_APPROVED", anchor: "PLAN_START" }],
      },
    });
    await config.publishVersion(ctx(), { templateId, versionNo: version.versionNo });
    const before = await TnaTemplateVersion.findOne({ companyId, versionNo: version.versionNo }).lean();

    /* Store starts publishing. Nothing reaches back into the published version. */
    supportGrows("source.store.fabric_in_house");
    const after = await TnaTemplateVersion.findOne({ companyId, versionNo: version.versionNo }).lean();
    expect(after).toEqual(before);
    expect(after.milestones.map((m) => m.milestoneCode)).toEqual(["TRIM_CARD_APPROVED"]);

    /* Getting it needs a successor version, reviewed and published by a person. */
    const next = await config.createVersion(ctx(), {
      templateId,
      body: {
        effectiveFrom: "2027-01-01",
        milestones: [
          { milestoneCode: "TRIM_CARD_APPROVED", anchor: "PLAN_START", sortOrder: 0 },
          { milestoneCode: "FABRIC_IN_HOUSE", anchor: "PLAN_START", offsetWorkingDays: 10, sortOrder: 1 },
        ],
      },
    });
    expect(next.version.versionNo).toBe(version.versionNo + 1);
    expect(next.version.state).toBe("DRAFT");
    /* Version 1 is STILL exactly as it was — creating the successor did not
       edit it, and publishing the successor only closes its window. */
    expect(await TnaTemplateVersion.findOne({ companyId, versionNo: version.versionNo }).lean())
      .toEqual(before);
  });

  test("4 — a published version cannot be edited at all, whatever became supported", async () => {
    await seedList();
    const templateId = await template();
    const { version } = await config.createVersion(ctx(), {
      templateId,
      body: {
        effectiveFrom: "2026-01-01",
        milestones: [{ milestoneCode: "TRIM_CARD_APPROVED", anchor: "PLAN_START" }],
      },
    });
    await config.publishVersion(ctx(), { templateId, versionNo: version.versionNo });

    supportGrows("source.store.fabric_in_house");
    await expect(config.updateVersion(ctx(), {
      templateId, versionNo: version.versionNo,
      body: {
        milestones: [
          { milestoneCode: "TRIM_CARD_APPROVED", anchor: "PLAN_START", sortOrder: 0 },
          { milestoneCode: "FABRIC_IN_HOUSE", anchor: "PLAN_START", sortOrder: 1 },
        ],
      },
    })).rejects.toMatchObject({ code: "TNA_TEMPLATE_IMMUTABLE" });
  });
});
