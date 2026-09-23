// services/centralCosting/legacyImport.service.js
//
// Central Costing — Chunk 2. ADOPTING WHAT SALES ALREADY COSTED.
//
// ── WHAT THIS DOES NOT DO, AND WHY THAT IS THE POINT ────────────────────────
// It does not modify `Enquiry.costingSheets`. It does not delete them. It does
// not dual-write, so there is never a moment where two records claim to be the
// costing and disagree. The legacy sheets remain exactly what they are — the
// Sales screens keep reading and writing them, unchanged — and this READS them
// once, converts them, and freezes the result into a canonical version.
//
// That is deliberate and it is the roadmap's instruction: "adapt the existing
// Sales enquiry costing data into a frozen CostingVersion without deleting or
// rewriting legacy data". A migration that rewrote the source would make the
// import irreversible and would break every Sales screen that reads it.
//
// ── AND THE IMPORTED NUMBERS ARE PROVISIONAL, ALWAYS ────────────────────────
// A legacy row carries a price somebody typed. No quotation reference, no
// validity, no effective date, no supplier record — nothing in it can be
// verified from the record itself. Chunk 3 replaces those rates with real
// supplier offers; until then they are labelled honestly.
"use strict";

const Costing = require("../../models/CMS_Models/Costing/Costing");
const { fail } = require("../storePurchase/errors");
const { resolveEnquiryStyle } = require("./contextResolver.service");
const adapter = require("./legacyEnquiryCostingAdapter");
const policyService = require("./policy.service");
const versionCreation = require("./versionCreation.service");

/**
 * Read one enquiry product's legacy sheets and freeze them into a new version.
 *
 * @param {object} ctx     the resolved costing context
 * @param {object} costing the parent costing — ENQUIRY_STYLE, already loaded
 *                         under the company scope
 * @param {object} meta    scenarios to cost at, plus request provenance
 * @returns {Promise<{version, report, recovered}>}
 */
async function importLegacySheets(ctx, costing, { scenarios, meta = {} }) {
  if (costing.context?.type !== "ENQUIRY_STYLE") {
    throw fail("VALIDATION", "Only a costing raised against an enquiry product can import legacy sheets.", {
      reason: "CONTEXT_NOT_ENQUIRY", contextType: costing.context?.type || null,
    });
  }

  /* ── THE SAME SCOPING RULES AS EVERY OTHER ENQUIRY READ ────────────────
     Company first, enquiry second, and the enquiry never contributes to which
     company the actor belongs to. Reusing the resolver rather than writing a
     second lookup is what keeps the two from ever disagreeing. */
  const { enquiry } = await resolveEnquiryStyle(ctx, costing.context, { withSheets: true });

  const productName = costing.context.externalKey;
  const sheets = (enquiry.costingSheets || []).filter(
    (s) => String(s?.productName || "").trim() === productName,
  );
  if (!sheets.length) {
    throw fail("NOT_FOUND", "That enquiry has no costing sheet for this product yet.", {
      reason: "NO_LEGACY_SHEET", productName,
    });
  }

  const policyBundle = await policyService.getPolicy(ctx);
  /* Same rule as a manual calculation: an import produces a PRICED frozen
     version, and a company that has never set its margin band has not decided
     what that price should be. Refused before the sheets are even read, so
     nothing is written and no idempotency action is consumed. */
  policyService.assertConfigured(policyBundle);
  const currency = policyBundle.policy.baseCurrency;

  const { lines, unmapped, ambiguities } = adapter.linesFromCostingSheets(sheets, currency);

  if (!lines.length) {
    /* Every row was unreadable. Importing nothing and calling it a costing
       would be worse than refusing — the version would show a total of zero
       for a garment that plainly costs something. */
    throw fail("VALIDATION", "None of the legacy rows for this product could be read as cost lines.", {
      reason: "LEGACY_SHEET_UNREADABLE", unmapped,
    });
  }

  const importKey = adapter.legacyImportKey({
    enquiryId: enquiry._id, productName, lines, unmapped,
  });

  /* ── THE SAME SHEET, IN THE SAME STATE, IS IMPORTED ONCE ───────────────
     Checked before writing as well as defended by the unique index, so the
     ordinary repeat is answered rather than raced. A CHANGED sheet has a
     different key and legitimately becomes a new version — which is what a
     new version is for. */
  /* ── THE DURABLE CLAIM, CHECKED BEFORE ANYTHING IS WRITTEN ──────────────
   * Two different deduplications live here and they answer different
   * questions, so both are kept:
   *
   *   the CLAIM   "has this user action already been performed?" — survives
   *               forever, on the version, and is what makes a retry safe once
   *               the 30-day idempotency row has gone.
   *   the CONTENT "has this sheet, in this exact state, already been frozen?"
   *               — which is why an EDITED sheet legitimately becomes a new
   *               version while an unchanged one never duplicates.
   *
   * The claim goes first: a key spent on another costing must be refused
   * before this one is touched at all. */
  const report = { lines, unmapped, ambiguities, importKey };

  /** One refusal, however the reuse is discovered. */
  const refuseReuse = (reason) => fail(
    "IDEMPOTENCY_KEY_REUSED",
    "This request key was already used for a different request. Start the action again.",
    { operation: "COSTING_LEGACY_IMPORT", reason },
  );

  /**
   * Hand back an existing version under this key, recording the key against it.
   *
   * ── WHY THE RECEIPT IS WRITTEN HERE AND NOT ONLY ON CREATE ────────────────
   * This is the path the durable binding used to lapse on. A second key
   * importing an unchanged sheet is answered from the content hash, so it
   * never touches the version's own `provenance` — it cannot, the version is
   * frozen and belongs to the first key. Without a receipt its only trace was
   * the temporary idempotency row, and once that expired the key was free to
   * be spent again on a different costing.
   */
  const recoverWith = async (version, resolution, { mandatory }) => {
    /* An import that already happened may have inserted its version and then
       failed to move the parent pointer. Repair it before handing the version
       back, or the costing reads one way here and another way through
       `GET /api/costings/:id`. Forward-only. */
    await versionCreation.repairPointer(ctx, costing, version);
    if (meta.claim?.claimId) {
      /* ── FOR AN ALIAS THIS THROWS, AND THAT IS THE POINT ──────────────
         An aliasing key's ONLY binding is this receipt — the version is frozen
         and belongs to the key that made it. Returning success with the write
         failed would complete the temporary idempotency row, which expires in
         thirty days and leaves the key loose again. So the failure propagates,
         the route's error path abandons the row rather than completing it, and
         the caller is told to send the same request again. The retry does not
         repeat the import: it finds the same version by content and finishes
         the record that failed. */
      await versionCreation.recordClaimReceipt(ctx, {
        claim: meta.claim, operation: "COSTING_LEGACY_IMPORT", costing, version, resolution,
        mandatory,
      });
    }
    return { version, recovered: true, report };
  };

  if (meta.claim?.claimId) {
    /* Receipt first, then the version-embedded claim — see `resolveClaim`. */
    const spent = await versionCreation.resolveClaim(ctx, meta.claim.claimId);
    if (spent) {
      const mismatch = versionCreation.claimMismatch(spent, costing, meta.claim);
      if (mismatch) throw refuseReuse(mismatch);
      /* The binding already exists — that is how this branch was reached — so
         the re-record is redundant and must not be able to fail the request. */
      return recoverWith(spent.version, "CONTENT_DEDUPLICATED", { mandatory: false });
    }
  }

  const already = await versionCreation.findByLegacyImportKey(ctx, importKey);
  if (already) return recoverWith(already, "CONTENT_DEDUPLICATED", { mandatory: true });

  const sourceReferences = sheets.map((sheet) => adapter.sourceReferenceForSheet({
    enquiryId: enquiry._id, productName, part: sheet.part, capturedAt: sheet.updatedAt,
  }));

  let created;
  try {
    created = await versionCreation.createNextVersion(ctx, costing, { lines, scenarios, note: meta.note || "" }, {
      ...meta,
      origin: adapter.LEGACY_ORIGIN,
      legacyImportKey: importKey,
      sourceReferences,
    });
  } catch (err) {
    /* Lost a race on the CLAIM index rather than the content one: another
       attempt at the same user action got there first. Recovered, or refused —
       never a 500, which is what an unhandled duplicate-key would surface as. */
    if (err?.name === "CostingVersionClaimAlreadyUsed") {
      const spent = await versionCreation.resolveClaim(ctx, meta.claim?.claimId);
      if (spent) {
        const mismatch = versionCreation.claimMismatch(spent, costing, meta.claim);
        if (mismatch) throw refuseReuse(mismatch);
        return recoverWith(spent.version, "CREATED", { mandatory: false });
      }
    }
    if (err?.name === "CostingVersionLegacyAlreadyImported") {
      /* ── TWO KEYS, ONE SHEET, AT THE SAME MOMENT ──────────────────────
         Both computed the same content hash; one won the index and created
         the version, and this one is the loser. It is a real success for THIS
         key too, so it gets its own receipt pointing at the same version —
         which is the whole reason receipts are a separate collection rather
         than a field on a frozen document. */
      const late = await versionCreation.findByLegacyImportKey(ctx, importKey);
      /* A race loser is an alias like any other: this key created nothing, so
         the receipt is the only thing that will ever bind it. */
      if (late) return recoverWith(late, "CONTENT_DEDUPLICATED", { mandatory: true });
    }
    throw err;
  }

  if (meta.claim?.claimId) {
    /* The version already carries this claim in its own provenance, written in
       the same insert. The receipt is the uniform record, so every spent key —
       creating or aliasing — can be found in one place. */
    /* Not mandatory: this key is already bound by the version's own
       provenance, written in the same insert. The receipt only makes the
       lookup uniform, so a failure here costs nothing a retry cannot find. */
    await versionCreation.recordClaimReceipt(ctx, {
      claim: meta.claim, operation: "COSTING_LEGACY_IMPORT",
      costing, version: created.version, resolution: "CREATED", mandatory: false,
    });
  }

  return {
    version: created.version,
    recovered: false,
    report: { ...report, sheetCount: sheets.length },
  };
}

/** Is there a costing sheet to import, and for which products? */
async function describeLegacySource(ctx, costing) {
  if (costing.context?.type !== "ENQUIRY_STYLE") return { available: false, reason: "CONTEXT_NOT_ENQUIRY" };
  const { enquiry } = await resolveEnquiryStyle(ctx, costing.context, { withSheets: true });
  const productName = costing.context.externalKey;
  const sheets = (enquiry.costingSheets || []).filter(
    (s) => String(s?.productName || "").trim() === productName,
  );
  return {
    available: sheets.length > 0,
    productName,
    parts: sheets.map((s) => s.part || "combined"),
    rowCounts: sheets.reduce((acc, s) => ({
      materials: acc.materials + (s.materials || []).length,
      operations: acc.operations + (s.operations || []).length,
      miscellaneous: acc.miscellaneous + (s.miscellaneous || []).length,
    }), { materials: 0, operations: 0, miscellaneous: 0 }),
  };
}

/** Kept beside the import so a caller can check the parent is what it thinks. */
const loadCosting = (ctx, id) => Costing.findOne({ companyId: ctx.companyId, _id: id });

module.exports = { importLegacySheets, describeLegacySource, loadCosting };
