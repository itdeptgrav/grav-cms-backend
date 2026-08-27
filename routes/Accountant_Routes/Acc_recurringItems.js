// routes/Accountant_Routes/Acc_recurringItems.js
//
// C0-E — the recurring-items register's HTTP surface.
//
// Four endpoints, one write target:
//   GET    /            — list, company-scoped
//   POST   /            — create
//   PATCH  /:id         — update (pause/resume/end are ordinary updates)
//   DELETE /:id         — SOFT delete: sets status "ended"
//
// Every decision about whether a value is allowed lives in the pure service
// (services/recurringItems.service.js). This file is transport plus scope:
// parse the request, check permission, resolve the company, call the service,
// hand the result to Mongo.
//
// ── WHAT THIS FILE NEVER DOES ───────────────────────────────────────────────
//   - Never writes `Acc_Voucher`. It does not require that model.
//   - Never writes `Acc_BillTerms`. Same.
//   - Never posts, schedules a posting, or generates a forecast row. A
//     recurring item is a statement of intent that Chunk 1's forecast engine
//     (deliberately not started) will later READ.
//   - Never spreads `req.body`. Both write paths go through the service's
//     explicit field whitelists.
//
// ── COMPANY SCOPING — FAIL CLOSED ───────────────────────────────────────────
// Every read and every write requires a valid `companyId` and filters by it.
// A missing or malformed one refuses rather than falling through to an
// unscoped query — the rule `openItems.service.js`,
// `voucherDueDateDefault.service.js` and
// `billTermsBackfillOrchestrator.service.js` were each hardened to. Writes
// match on `{ _id, companyId }` TOGETHER, never `_id` alone, so an id
// belonging to another company resolves to nothing rather than being
// updated.

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");
const recurring = require("../../services/recurringItems.service");
const Acc_RecurringItem = require("../../models/Accountant_model/Acc_RecurringItem");
// Read-only, and only ever to VERIFY a supplied `ledgerId` belongs to the
// requesting company. This router never writes a ledger.
const { Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");

router.use(accountantAuth);

/** Cast to ObjectId, or null. Never throws. Mirrors the C0 house helper. */
function castId(v) {
  if (!v) return null;
  if (v instanceof mongoose.Types.ObjectId) return v;
  const s = String(v);
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
}

/**
 * The company this request is scoped to, from body or query.
 *
 * Body takes precedence when both are present, matching the convention
 * `Acc_parties.js`'s credit-terms route already set. Returns null on missing
 * OR malformed — the caller turns that into a refusal, never a wider query.
 */
function scopeCompanyId(req) {
  return castId(req.body?.companyId || req.query?.companyId);
}

/**
 * Resolve the optional ledger link for a write.
 *
 * ── WHY THIS IS A LOOKUP AND NOT A CAST ─────────────────────────────────────
 * The first version of this route did `ledgerId = castId(ledgerId)`, which
 * turned any unparseable value into `null` — so a typo'd or hostile id was
 * silently accepted as "no ledger linked" and the caller was told the write
 * succeeded. Worse, a WELL-FORMED id belonging to a DIFFERENT company was
 * stored verbatim, quietly creating a cross-company reference in a
 * company-scoped collection. Neither failure was visible to anyone.
 *
 * Now: a supplied id must be well-formed AND must resolve to a ledger in THIS
 * company, or the whole write is refused. Nothing is coerced away.
 *
 * ── WHY THE NAME COMES FROM THE LEDGER, NOT THE BODY ────────────────────────
 * `ledgerName` is a denormalised display snapshot. When an id is supplied, the
 * body's name is IGNORED and the matched ledger's real name is stored, so a
 * client cannot label a link to "Freight & Forwarding" as "Director's Loan".
 * A free-text `ledgerName` with NO id remains allowed — that is a plain label
 * for an item whose posting account nobody has decided yet, and it cannot
 * misrepresent a link that does not exist.
 *
 * @returns {{ok: true, ledgerId: (ObjectId|null), ledgerName: (string|null)}}
 *        | {ok: false, status: number, error: string, code: string}
 */
async function resolveLedgerLink(rawLedgerId, companyId) {
  // An explicit empty value UNLINKS — a real thing to want, and the only case
  // where a null ledgerId is a correct outcome rather than a swallowed error.
  if (rawLedgerId === null || rawLedgerId === undefined || rawLedgerId === "") {
    return { ok: true, ledgerId: null, ledgerName: null };
  }

  const id = castId(rawLedgerId);
  if (!id) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_LEDGER_ID",
      error: "ledgerId is not a valid id.",
    };
  }

  // Scoped by `{_id, companyId}` TOGETHER — a ledger from another company
  // resolves to nothing here, exactly as it would anywhere else in C0.
  const ledger = await Acc_Ledger.findOne({ _id: id, companyId })
    .select("_id name")
    .lean();

  if (!ledger) {
    // 400, not 404: the record being addressed is the recurring item, and a
    // 404 here would read as "the item is missing". This is a bad value in a
    // field of an otherwise-addressable request.
    return {
      ok: false,
      status: 400,
      code: "LEDGER_NOT_IN_COMPANY",
      error: "ledgerId does not match a ledger in this company.",
    };
  }

  return { ok: true, ledgerId: ledger._id, ledgerName: ledger.name };
}

/** Only the fields a client should see. Provenance is included; ids are not re-shaped. */
function present(doc) {
  return {
    _id: doc._id,
    name: doc.name,
    type: doc.type,
    direction: doc.direction,
    ledgerId: doc.ledgerId || null,
    ledgerName: doc.ledgerName || null,
    amount: doc.amount,
    frequency: doc.frequency,
    dayOfMonth: doc.dayOfMonth ?? null,
    dayOfWeek: doc.dayOfWeek ?? null,
    nextDueDate: doc.nextDueDate,
    startDate: doc.startDate,
    endDate: doc.endDate || null,
    status: doc.status,
    source: doc.source,
    notes: doc.notes || "",
    createdByName: doc.createdByName || null,
    updatedByName: doc.updatedByName || null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** Turn a service-thrown validation error into a 400; re-throw anything else. */
function asValidationError(e, res) {
  if (e instanceof recurring.RecurringItemError) {
    res.status(400).json({ error: e.message, code: e.code });
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* GET /                                                    READ ONLY  */
/* ------------------------------------------------------------------ */
router.get("/", async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    if (!companyId) {
      return res.status(400).json({ error: "companyId required." });
    }

    const filter = { companyId };

    // Optional narrowing. Both are validated against the enums rather than
    // passed through — an unrecognised value refuses instead of quietly
    // matching nothing, which would look identical to "you have no items".
    if (req.query.status) {
      if (!recurring.STATUS.includes(req.query.status)) {
        return res.status(400).json({
          error: `status must be one of: ${recurring.STATUS.join(", ")}.`,
          code: "INVALID_ENUM",
        });
      }
      filter.status = req.query.status;
    }
    if (req.query.type) {
      if (!recurring.TYPE.includes(req.query.type)) {
        return res.status(400).json({
          error: `type must be one of: ${recurring.TYPE.join(", ")}.`,
          code: "INVALID_ENUM",
        });
      }
      filter.type = req.query.type;
    }

    const items = await Acc_RecurringItem.find(filter)
      .sort({ status: 1, nextDueDate: 1, name: 1 })
      .lean();

    // A count the readiness screen can show without re-fetching the list.
    const activeCount = items.filter((i) => i.status === "active").length;

    res.json({
      ok: true,
      items: items.map(present),
      count: items.length,
      activeCount,
    });
  } catch (e) {
    console.error("[recurring-items GET]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* POST /                                                              */
/* ------------------------------------------------------------------ */
router.post("/", async (req, res) => {
  try {
    if (!recurring.canEdit(req.user)) {
      return res.status(403).json({
        error: "Your accounting role is read-only, so this change was not saved.",
      });
    }

    const companyId = scopeCompanyId(req);
    if (!companyId) {
      return res.status(400).json({ error: "companyId required." });
    }

    let doc;
    try {
      doc = recurring.buildCreate(req.body, {
        id: req.user?.id,
        name: req.user?.name || req.user?.email,
      });
    } catch (e) {
      if (asValidationError(e, res)) return;
      throw e;
    }

    // The service passes `companyId` through as given; the CAST one is what
    // is stored, so scope is decided here and only here.
    doc.companyId = companyId;

    // The ledger link is verified against this company before anything is
    // written — a bad or foreign id refuses the whole create rather than
    // being quietly dropped.
    const link = await resolveLedgerLink(doc.ledgerId, companyId);
    if (!link.ok) {
      return res.status(link.status).json({ error: link.error, code: link.code });
    }
    doc.ledgerId = link.ledgerId;
    // Only override the caller's label when an id was actually supplied;
    // otherwise a free-text label stands on its own.
    if (link.ledgerId) doc.ledgerName = link.ledgerName;

    const created = await Acc_RecurringItem.create(doc);
    res.status(201).json({ ok: true, item: present(created.toObject()) });
  } catch (e) {
    console.error("[recurring-items POST]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* PATCH /:id                                                          */
/* ------------------------------------------------------------------ */
router.patch("/:id", async (req, res) => {
  try {
    if (!recurring.canEdit(req.user)) {
      return res.status(403).json({
        error: "Your accounting role is read-only, so this change was not saved.",
      });
    }

    const id = castId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid item id." });

    const companyId = scopeCompanyId(req);
    if (!companyId) {
      return res.status(400).json({ error: "companyId required." });
    }

    // `companyId` scopes WHERE this write lands; it is not itself editable.
    // Stripped before the body reaches the service, whose whitelist would
    // (correctly) refuse it as unsupported.
    const { companyId: _scopeOnly, ...patch } = req.body || {};

    // Read scoped by BOTH ids. An item belonging to another company resolves
    // to nothing here and 404s, rather than being found by a bare `_id` and
    // then needing a second check to catch.
    const existing = await Acc_RecurringItem.findOne({ _id: id, companyId }).lean();
    if (!existing) return res.status(404).json({ error: "Recurring item not found." });

    let $set;
    try {
      $set = recurring.buildUpdate(patch, existing, {
        id: req.user?.id,
        name: req.user?.name || req.user?.email,
      });
    } catch (e) {
      if (asValidationError(e, res)) return;
      throw e;
    }

    // ── The ledger link, verified against the MERGED result ─────────────────
    // Resolved from the body's id when it names one, otherwise from the id
    // already stored. That second case is what stops a name-only PATCH from
    // spoofing the label of an existing link: if the item ends up with ANY
    // ledgerId, its `ledgerName` is re-derived from that ledger rather than
    // taken from the body.
    const touchesLink =
      Object.prototype.hasOwnProperty.call($set, "ledgerId") ||
      Object.prototype.hasOwnProperty.call($set, "ledgerName");

    if (touchesLink) {
      const rawId = Object.prototype.hasOwnProperty.call($set, "ledgerId")
        ? $set.ledgerId
        : existing.ledgerId;

      const link = await resolveLedgerLink(rawId, companyId);
      if (!link.ok) {
        return res.status(link.status).json({ error: link.error, code: link.code });
      }

      if (Object.prototype.hasOwnProperty.call($set, "ledgerId")) {
        $set.ledgerId = link.ledgerId;
        // Unlinking clears the snapshot too — a name left behind would point
        // at a ledger this item is no longer linked to.
        $set.ledgerName = link.ledgerId ? link.ledgerName : null;
      } else if (link.ledgerId) {
        // Name-only PATCH on a still-linked item: the link wins.
        $set.ledgerName = link.ledgerName;
      }
    }

    // Re-stating companyId in the update filter (rather than trusting the id
    // alone now that `findOne` has confirmed it) means a race — the row being
    // re-tenanted between the read and the write — still cannot produce a
    // cross-company write; the update simply matches nothing.
    const saved = await Acc_RecurringItem.findOneAndUpdate(
      { _id: id, companyId },
      { $set },
      { new: true, runValidators: true },
    ).lean();

    if (!saved) return res.status(404).json({ error: "Recurring item not found." });
    res.json({ ok: true, item: present(saved) });
  } catch (e) {
    console.error("[recurring-items PATCH]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* DELETE /:id                                    SOFT — sets "ended"  */
/* ------------------------------------------------------------------ */
//
// ── WHY SOFT, NOT HARD ──────────────────────────────────────────────────────
// A register whose rows a forecast reads should not be able to lose an input
// silently. "We stopped paying that rent in March" is information a later
// projection wants — an `ended` row with its dates intact still explains the
// shape of the past, where a deleted one leaves an unexplained gap. The list
// endpoint takes `?status=`, so a UI that wants only live items can ask for
// them without the data being destroyed to achieve it.
router.delete("/:id", async (req, res) => {
  try {
    if (!recurring.canEdit(req.user)) {
      return res.status(403).json({
        error: "Your accounting role is read-only, so this change was not saved.",
      });
    }

    const id = castId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid item id." });

    const companyId = scopeCompanyId(req);
    if (!companyId) {
      return res.status(400).json({ error: "companyId required." });
    }

    const saved = await Acc_RecurringItem.findOneAndUpdate(
      { _id: id, companyId },
      {
        $set: {
          status: "ended",
          updatedBy: req.user?.id || null,
          updatedByName: req.user?.name || req.user?.email || null,
        },
      },
      { new: true, runValidators: true },
    ).lean();

    if (!saved) return res.status(404).json({ error: "Recurring item not found." });
    res.json({ ok: true, item: present(saved), softDeleted: true });
  } catch (e) {
    console.error("[recurring-items DELETE]", e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
