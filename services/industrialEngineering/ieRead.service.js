// services/industrialEngineering/ieRead.service.js
//
// INDUSTRIAL ENGINEERING — THE READ BOUNDARY, AND NOTHING ELSE.
//
// ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
// Chunk 0 established that GRAV has no IE application and several writable
// answers to "what operations does this style use and how long do they take?".
// The first safe application change is a read boundary: a company-scoped,
// allowlisted projection an IE person can look at, over records nobody has
// migrated yet.
//
// So this file READS. There is no save, no update, no findOneAndUpdate, no
// bulkWrite and no backfill anywhere in it, and the router above it exposes no
// verb that could reach one. That is the contract of the chunk, and it is
// asserted at the wire in test/industrial-engineering.
//
// ── WHAT IE MAY BE TOLD ─────────────────────────────────────────────────────
// Every shape that leaves here is built field by field. A spread of a
// `SampleStyle`, a `StockItem` or an `Operation` would publish the Journey,
// the enquiry, the customer, the operator salary and the operation's salary
// basis the first time somebody stopped reading the function — so no shape is
// ever spread, and the allowlist is the code rather than a comment.
//
// Company ownership IS proved through the Sales parents, because that is where
// a SampleStyle's company actually lives. Neither parent appears in a
// response.
//
// ── AND IT DOES NOT CHOOSE BETWEEN THE TWO ROUTES ───────────────────────────
// `SampleStyle.techSheet.technical.operations[]` and the connected
// `StockItem.operations[]` are two arrays that can disagree. This chunk
// publishes both, separately labelled, and states whether they agree — see
// routeComparison.js. Picking one as authoritative is Chunk 3's job and needs
// a version model that does not exist yet; doing it here would freeze today's
// ambiguity into an API.
"use strict";

const mongoose = require("mongoose");

const { fail } = require("../storePurchase/errors");
const technicalRecord = require("../centralCosting/technicalRecord.service");
const { ownershipProofFor } = require("../centralCosting/technicalSource.service");
/* ── THE SAME COMPANY FILTER MERCHANDISING USES, NOT A SECOND ONE ─────────
   A `SampleStyle` has no `companyId`; ownership is proved through its Sales
   parents. That rule already exists as a bounded filter, and a second
   implementation of it is a second answer waiting to disagree with the first
   — which is how one company's styles appear in another's queue. The file is
   named for the chunk that had to invent it; what it holds is the CMS
   style-ownership clause, and it is read here as exactly that. */
const { styleOwnershipClause } = require("../companyContext/merchandisingScope.service");
const routeComparison = require("./routeComparison");

const str = (v) => String(v ?? "").trim();
const present = (v) => v !== null && v !== undefined && String(v).trim() !== "";
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

const model = (name, path) => (mongoose.models[name] || require(path));
const SampleStyle = () => model("SampleStyle", "../../models/CMS_Models/Sales/SampleStyle");
const StockItem = () => model("StockItem", "../../models/CMS_Models/Inventory/Products/StockItem");
const Operation = () => model("Operation", "../../models/CMS_Models/Inventory/Configurations/Operation");

const CODES = Object.freeze({
  NOT_FOUND: "NOT_FOUND",
  VALIDATION: "VALIDATION",
  COMPANY_CONTEXT_UNAVAILABLE: "COMPANY_CONTEXT_UNAVAILABLE",
});

/* ── PAGES ARE BOUNDED, AND THE BOUND IS PUBLISHED ─────────────────────────
   A list that silently caps at 50 and says nothing reads as "that is all of
   them", which is how a planner concludes a factory has fifty styles. Every
   list here returns the limit it applied, whether more exist, and the marker
   that continues it. */
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** The two stored arrays this chunk reads, named so a response can say which. */
const ROUTE_SOURCE = Object.freeze({
  TECHNICAL: "SAMPLE_STYLE_TECHNICAL_ROUTE",
  PRODUCT: "STOCK_ITEM_PRODUCT_ROUTE",
});

/** How well the style's product — and therefore its product route — is known. */
const PRODUCT_LINK = Object.freeze({
  /* The style names exactly one product and that product exists. */
  PROVEN: "PROVEN",
  /* The style names no product at all. There is no product route to compare. */
  NONE: "NONE",
  /* The style names two different products. Nothing is chosen between them. */
  AMBIGUOUS: "AMBIGUOUS",
  /* The style names a product that does not exist. A dangling reference is
     not the same fact as "no product route", and is not reported as one. */
  UNRESOLVED: "UNRESOLVED",
});

/** Which desk can close a gap. IE's own, and R&D's — no other is named here. */
const GAP_OWNER = Object.freeze({
  IE: "INDUSTRIAL_ENGINEERING",
  RND: "RESEARCH_DEVELOPMENT",
});

/* ═══ CONTEXT ══════════════════════════════════════════════════════════════ */

function assertContext(ctx) {
  if (!ctx?.companyId) {
    throw fail(CODES.COMPANY_CONTEXT_UNAVAILABLE, "Your company could not be resolved.");
  }
}

/** One indistinguishable refusal for absent, foreign and unprovable alike. */
const styleNotFound = () => fail(CODES.NOT_FOUND, "That style was not found.");

/* ═══ PAGING ═══════════════════════════════════════════════════════════════ */

/**
 * An opaque marker for a position in one list's deterministic sort.
 *
 * Opaque because it is a POSITION, not a filter a caller may compose: it holds
 * the last row of the previous page and nothing else. It is not signed and
 * does not need to be — it names a row inside a list whose company bound is
 * re-proved on the next request anyway, so a forged marker moves somebody
 * within their own list and reaches nothing else.
 */
function encodeCursor(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** A malformed marker is refused by name. Ignoring it would silently restart
 *  the list at page one, which reads as duplicated work rather than an error. */
function decodeCursor(raw, shape) {
  const value = str(raw);
  if (!value) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    parsed = null;
  }
  const bad = () => fail(CODES.VALIDATION, "That page marker is not one this list issued.", { field: "cursor" });
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw bad();
  if (!isId(parsed.i)) throw bad();
  if (shape === "time" && !Number.isFinite(Number(parsed.t))) throw bad();
  if (shape === "name" && typeof parsed.n !== "string") throw bad();
  return parsed;
}

/** The page size actually applied — asked for, then bounded. */
function pageSize(limit) {
  const asked = limit === undefined || limit === null || limit === "" ? DEFAULT_LIMIT : Number(limit);
  if (!Number.isFinite(asked) || asked < 1 || Math.floor(asked) !== asked) {
    throw fail(CODES.VALIDATION, "Ask for a whole number of rows.", { field: "limit" });
  }
  return Math.min(asked, MAX_LIMIT);
}

/**
 * A caller's search text, as a LITERAL.
 *
 * Escaped before it becomes a regular expression: an unescaped `(` is a syntax
 * error the caller can trigger from the address bar, and an unescaped `.*` is
 * a collection scan somebody else pays for.
 */
function literalRegex(term) {
  return new RegExp(str(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

/* ═══ ROUTE ROWS ═══════════════════════════════════════════════════════════
 *
 * Two stored shapes, two narrow projections, one SAM formula.
 *
 * `technicalRecord.samMinutesOf` is the formula the technical record, the
 * Production route door and Central Costing already share. IE uses the same
 * one rather than a fourth, so nobody has to ask whether ninety seconds is a
 * minute and a half on this screen. It returns `null` where no time was
 * recorded, and that null is carried through every total below rather than
 * being read as zero.
 */

/** One row of `SampleStyle.techSheet.technical.operations[]`, as IE reads it. */
function technicalRow(op, index) {
  return {
    sequence: index + 1,
    /* Present where the row was written through the register. Absent on a row
       inserted by an older driver path, which is published as it stands. */
    operationId: op?.operationId ? str(op.operationId) : null,
    operationCode: str(op?.operationCode),
    name: str(op?.name),
    machineType: str(op?.machineType),
    ...rowTime(technicalRecord.samMinutesOf(op || {}), rowSeconds(op)),
    /* The ambiguity indicator. A row naming no registered operation cannot be
       reconciled against the master, and is flagged rather than filtered out
       or quietly re-identified. */
    legacy: !op?.operationId,
  };
}

/**
 * One row of the connected `StockItem.operations[]`, as IE reads it.
 *
 * The stored shape is a different one: the operation's name is `type`, there
 * is no link to the register at all, and the row also carries `operatorSalary`,
 * `operatorCost`, `salaryDept` and `salaryDesig`. None of those four is read
 * here, and none is selected from the database — a labour rate is HR and
 * Finance policy, and IE owning one is precisely what the boundary refuses.
 */
function productRow(op, index) {
  const normalised = productRowTime(op);
  return {
    sequence: index + 1,
    /* The product route holds no register link. Stated as null rather than
       omitted, so the two sources read as the same contract. */
    operationId: null,
    operationCode: str(op?.operationCode),
    name: str(op?.type),
    machineType: str(op?.machineType) || str(op?.machine),
    ...rowTime(technicalRecord.samMinutesOf(normalised.parts), normalised.seconds),
    /* A product row with no code cannot be matched to the technical route at
       all — the ambiguity is the row's, and it is named on the row. */
    legacy: !str(op?.operationCode),
  };
}

/**
 * ── A TIME NOBODY RECORDED, AND WHY IT IS NOT A ZERO ───────────────────────
 *
 * Both stored shapes DEFAULT `minutes` and `seconds` to 0, so a row nobody
 * timed and a row somebody timed at nothing are the same bytes on disk. There
 * is no field that distinguishes them and this chunk does not invent one.
 *
 * `technicalRecord.samMinutesOf` — the formula the technical record, the
 * Production route door and Central Costing already share — reads both as "no
 * standard time" and returns null. This follows it rather than giving IE a
 * second answer, and it is the safer of the two readings: a zero published as
 * a standard time would let a reader treat an unengineered operation as an
 * instant one, where a null makes them ask.
 *
 * The two fields are therefore kept in step — `timeSeconds` is null exactly
 * when `samMinutes` is — so no caller can find a time on a row the totals
 * counted as untimed.
 */
function rowTime(samMinutes, seconds) {
  return samMinutes === null
    ? { timeSeconds: null, samMinutes: null }
    : { timeSeconds: seconds, samMinutes };
}

/** The seconds a technical row records, or null where neither part is set. */
function rowSeconds(op) {
  if (!present(op?.minutes) && !present(op?.seconds)) return null;
  const m = Number(op?.minutes);
  const s = Number(op?.seconds);
  return (Number.isFinite(m) ? m : 0) * 60 + (Number.isFinite(s) ? s : 0);
}

/**
 * The same question for a product row, which has a third field.
 *
 * `totalSeconds` is a stored convenience on this model. It is read only when
 * neither `minutes` nor `seconds` was recorded, so a row that holds both never
 * has its own parts overruled by a stale total.
 */
function productRowTime(op) {
  if (present(op?.minutes) || present(op?.seconds)) {
    const seconds = rowSeconds(op);
    return { seconds, parts: { minutes: op?.minutes, seconds: op?.seconds } };
  }
  if (present(op?.totalSeconds)) {
    const total = Number(op.totalSeconds);
    if (Number.isFinite(total)) return { seconds: total, parts: { minutes: 0, seconds: total } };
  }
  return { seconds: null, parts: {} };
}

/**
 * The route's standard time, summed once from the rows' own times.
 *
 * Deterministic: the seconds are summed as integers in stored order and
 * converted once, so the same route always yields the same number and no two
 * screens can disagree about the rounding.
 *
 * A route with no rows, or one whose every row is untimed, returns `null`. It
 * does NOT return zero — "nobody has timed this" is the fact, and publishing
 * 0 would let a downstream reader treat an unengineered style as a free one.
 */
function totalSam(rows) {
  const timed = rows.filter((r) => r.samMinutes !== null && r.samMinutes !== undefined);
  if (!timed.length) return null;
  const seconds = timed.reduce((sum, r) => sum + Number(r.timeSeconds || 0), 0);
  return Number((seconds / 60).toFixed(6));
}

/** One source's whole picture, ready to publish. */
function routeSourceView(source, rows, extra = {}) {
  const missingTime = rows.filter((r) => r.samMinutes === null).length;
  return {
    source,
    present: rows.length > 0,
    operationCount: rows.length,
    totalSamMinutes: totalSam(rows),
    /* Stated rather than inferred from a null total: a route with four timed
       rows and one untimed one has a total AND an incompleteness, and a reader
       that saw only the number would quote it as the style's SAM. */
    samComplete: rows.length > 0 && missingTime === 0,
    rowsMissingTime: missingTime,
    ...extra,
  };
}

/* ═══ THE PRODUCT SOURCE ═══════════════════════════════════════════════════ */

/**
 * Which product this style's route would live on, if it has one.
 *
 * A style reaches a finished good by either field: `production.stockItemId`
 * once it is in production, `sourceStockItemId` when it was raised from an
 * existing product. Where both are set and DISAGREE, nothing is chosen — two
 * candidate products is an ambiguity somebody must resolve, and picking one
 * would silently attribute another product's method to this style.
 */
function productLinkOf(style) {
  const ids = [...new Set([
    str(style?.production?.stockItemId),
    str(style?.sourceStockItemId),
  ].filter(Boolean))];
  if (!ids.length) return { state: PRODUCT_LINK.NONE, stockItemId: null };
  if (ids.length > 1) return { state: PRODUCT_LINK.AMBIGUOUS, stockItemId: null };
  return { state: PRODUCT_LINK.PROVEN, stockItemId: ids[0] };
}

/**
 * The product routes for a page of styles, in ONE query.
 *
 * ── AND THE PRODUCT MASTER IS NOT THE BOUNDARY ─────────────────────────────
 * `StockItem` carries no `companyId`. It is not filtered by one here, and the
 * empty result of such a filter is not presented as isolation. The boundary is
 * the STYLE, already proved company-owned before this is called; the product is
 * reached only from a style that passed that proof, which is the same reasoning
 * the Production style-route service records.
 */
async function productRoutesFor(styles) {
  const links = new Map();
  const wanted = new Set();
  for (const style of styles) {
    const link = productLinkOf(style);
    links.set(str(style._id), link);
    if (link.stockItemId && isId(link.stockItemId)) wanted.add(link.stockItemId);
  }

  let products = [];
  if (wanted.size) {
    products = await StockItem()
      .find({ _id: { $in: [...wanted] } })
      /* The operations array and nothing else. Not the costs, not the
         variants, not the sales price. */
      .select("_id operations")
      .lean();
  }
  const byId = new Map(products.map((p) => [str(p._id), p]));

  const out = new Map();
  for (const [styleId, link] of links.entries()) {
    if (link.state !== PRODUCT_LINK.PROVEN) {
      out.set(styleId, { linkState: link.state, rows: [] });
      continue;
    }
    const product = byId.get(link.stockItemId);
    if (!product) {
      /* Named a product that is not there. Reported as its own state — a
         dangling reference is not evidence that no product route exists. */
      out.set(styleId, { linkState: PRODUCT_LINK.UNRESOLVED, rows: [] });
      continue;
    }
    out.set(styleId, {
      linkState: PRODUCT_LINK.PROVEN,
      rows: (Array.isArray(product.operations) ? product.operations : []).map(productRow),
    });
  }
  return out;
}

/* ═══ GAPS ═════════════════════════════════════════════════════════════════ */

const gap = (code, owner, action, message, details = {}) =>
  ({ code, owner, action, message, ...(Object.keys(details).length ? { details } : {}) });

/**
 * WHAT IS MISSING, WHO OWNS IT, AND WHAT THEY MUST DO.
 *
 * Typed, because "route incomplete" is not something anybody can act on.
 * Nothing here treats an absence as a completion: a style with no route is not
 * a style with a zero-minute route, and a technical record that has not been
 * approved is not reported as approved-with-caveats.
 */
function gapsFor({ technicalStatus, technical, product, comparison }) {
  const gaps = [];
  const S = routeComparison.STATE;

  if (comparison.state === S.NO_ROUTE) {
    gaps.push(gap("NO_ROUTE_RECORDED", GAP_OWNER.IE, "RECORD_OPERATION_BULLETIN",
      "No operation route is recorded for this style in either source."));
  }
  if (comparison.state === S.ONLY_PRODUCT_ROUTE) {
    gaps.push(gap("TECHNICAL_ROUTE_MISSING", GAP_OWNER.IE, "RECORD_OPERATION_BULLETIN",
      "This style's route exists only on the product record. The style's own technical route is empty."));
  }
  if (comparison.state === S.ONLY_TECHNICAL_ROUTE) {
    gaps.push(gap("PRODUCT_ROUTE_MISSING", GAP_OWNER.IE, "REVIEW_PRODUCT_ROUTE",
      "This style's route exists only on the technical record. Work orders raised from the product would carry no operations."));
  }
  if ([S.DIFFERENT_OPERATIONS, S.DIFFERENT_SEQUENCE, S.DIFFERENT_TIME].includes(comparison.state)) {
    gaps.push(gap("ROUTE_SOURCES_DISAGREE", GAP_OWNER.IE, "RECONCILE_ROUTE_SOURCES",
      "The technical route and the product route do not describe the same method.",
      { comparisonState: comparison.state, reason: comparison.reason }));
  }
  if (comparison.state === S.AMBIGUOUS) {
    /* Three facts reach AMBIGUOUS and they are fixed on three different
       screens — the style's product link, the routes themselves, and the
       operation register. Each is named and sent to its own, because
       "ambiguous" on its own tells nobody where to go. */
    const AMBIGUITY_MESSAGE = {
      PRODUCT_SOURCE_NOT_IDENTIFIABLE:
        "This style's product route could not be identified, so the two sources cannot be compared.",
      ROWS_CANNOT_BE_MATCHED:
        "Rows in these routes carry no operation code, so the two sources cannot be matched.",
      OPERATION_CODE_NOT_UNIQUE:
        "An operation code these routes use is held by more than one registered operation, so two "
        + "rows sharing that code cannot be shown to be the same operation — even where they agree. "
        + "Reconcile the duplicate in the operation register.",
    };
    gaps.push(gap(
      comparison.reason === "OPERATION_CODE_NOT_UNIQUE"
        /* Its own code: the fix is the register, not the routes, and a screen
           filtering for route work should not be sent this one. */
        ? "OPERATION_CODE_NOT_UNIQUE"
        : "ROUTE_COMPARISON_AMBIGUOUS",
      GAP_OWNER.IE,
      comparison.reason === "OPERATION_CODE_NOT_UNIQUE"
        ? "RECONCILE_OPERATION_REGISTER"
        : "RECONCILE_ROUTE_SOURCES",
      AMBIGUITY_MESSAGE[comparison.reason]
        || "These two routes cannot be compared.",
      { comparisonState: comparison.state, reason: comparison.reason, ...comparison.details }));
  }

  const untimed = technical.rowsMissingTime + product.rowsMissingTime;
  if (untimed) {
    gaps.push(gap("STANDARD_TIME_MISSING", GAP_OWNER.IE, "RECORD_STANDARD_TIME",
      "Some operations on this style carry no standard time. The recorded total covers only the timed rows.",
      { technicalRows: technical.rowsMissingTime, productRows: product.rowsMissingTime }));
  }

  if (technical.rowsNotIdentified) {
    gaps.push(gap("OPERATION_NOT_IDENTIFIED", GAP_OWNER.IE, "LINK_OPERATION_MASTER",
      "Some technical-route rows name no registered operation and cannot be reconciled against the operation master.",
      { technicalRows: technical.rowsNotIdentified }));
  }
  if (product.rowsNotIdentified) {
    gaps.push(gap("PRODUCT_OPERATION_CODE_MISSING", GAP_OWNER.IE, "LINK_OPERATION_MASTER",
      "Some product-route rows carry no operation code and cannot be matched to the operation master.",
      { productRows: product.rowsNotIdentified }));
  }

  if (technicalStatus !== technicalRecord.STATUS.APPROVED) {
    gaps.push(gap("TECHNICAL_RECORD_NOT_APPROVED", GAP_OWNER.RND, "COMPLETE_TECHNICAL_RECORD",
      "R&D's technical record for this style is not approved, so the route it carries is not a signed-off standard.",
      { technicalStatus }));
  }

  return gaps;
}

/* ═══ THE WORKLIST ROW ═════════════════════════════════════════════════════ */

/**
 * WHAT AN IE WORKLIST ROW MAY CONTAIN.
 *
 * Built field by field, deliberately. `reference` is the style's own code —
 * never a customer's name, never a buyer's, never an enquiry number. The
 * Journey and the enquiry proved the company and stop at that proof.
 */
function styleListRow(style, { technical, product, comparison, gaps }) {
  return {
    styleId: str(style._id),
    reference: str(style.styleCode) || str(style.sampleStyleId),
    productName: str(style.productName),
    variantLabel: str(style.variantLabel),
    technicalStatus: str(style.techSheet?.technical?.status) || technicalRecord.STATUS.NOT_STARTED,
    routeSources: { technical, product },
    /* The operation count IE works from is the style's own technical route —
       the array Production's door writes. The product route's count is on its
       own source block rather than folded into this one. */
    operationCount: technical.operationCount,
    samMinutes: technical.totalSamMinutes,
    samComplete: technical.samComplete,
    comparisonState: comparison.state,
    gaps,
  };
}

/** Everything both reads derive from one style plus its product route. */
function projectRoutes(style, productRoute) {
  return {
    technicalRows: (style.techSheet?.technical?.operations || []).map(technicalRow),
    productRows: productRoute?.rows || [],
    linkState: productRoute?.linkState || PRODUCT_LINK.NONE,
  };
}

/**
 * Every operation code a style's two routes name, in the register's normal
 * form.
 *
 * Projected ONCE and read from the projected rows, not from the stored
 * documents a second time: the comparison keys on `routeComparison.rowKey`, so
 * the codes looked up in the master have to be the very same strings or the
 * duplicate check would be asking about codes the comparison never uses.
 */
function codesUsedBy({ technicalRows, productRows }) {
  const codes = new Set();
  for (const row of [...technicalRows, ...productRows]) {
    const key = routeComparison.rowKey(row);
    if (key) codes.add(key);
  }
  return codes;
}

/**
 * The duplicated codes THIS style is affected by.
 *
 * The map handed in may cover a whole page of styles. Narrowing it here means
 * the ambiguity a style reports is always traceable to a code that style's own
 * routes name — the requirement that an unrelated duplicate elsewhere in the
 * register leaves this style alone is enforced by construction rather than by
 * remembering to check it at each call site.
 */
function ownDuplicates(projected, duplicated) {
  const own = new Set();
  for (const code of codesUsedBy(projected)) {
    if (duplicated.has(code)) own.add(code);
  }
  return own;
}

function assemble(style, projected, duplicatedMasterCodes = null) {
  const { technicalRows, productRows, linkState } = projected;

  const technical = routeSourceView(ROUTE_SOURCE.TECHNICAL, technicalRows, {
    rowsNotIdentified: technicalRows.filter((r) => r.legacy).length,
  });
  const product = routeSourceView(ROUTE_SOURCE.PRODUCT, productRows, {
    linkState,
    rowsNotIdentified: productRows.filter((r) => r.legacy).length,
  });

  const comparison = routeComparison.compareRoutes({
    technicalRows,
    productRows,
    /* A product that could not be resolved has proved nothing either way. */
    productSourceIdentifiable: linkState === PRODUCT_LINK.PROVEN || linkState === PRODUCT_LINK.NONE,
    /* ── THE CODE IS THE KEY, AND THE MASTER DOES NOT GUARANTEE IT ────────
       Two registered operations can share one code — the audit found live
       duplicates and this chunk reconciles none of them. So two routes can
       agree on code, order and time and still name different work, and the
       comparison is told which of THIS style's codes are in that state so it
       can refuse rather than report a match it cannot support. */
    duplicatedMasterCodes,
  });

  const technicalStatus = str(style.techSheet?.technical?.status) || technicalRecord.STATUS.NOT_STARTED;
  const gaps = gapsFor({ technicalStatus, technical, product, comparison });

  return { technicalRows, productRows, technical, product, comparison, gaps, technicalStatus };
}

/* ═══ THE THREE READS ══════════════════════════════════════════════════════ */

/** Only the fields the projections above read. Not `journeyId`, not
 *  `enquiryId`, not the sample, not the materials, not the costing. */
const STYLE_PROJECTION = [
  "_id sampleStyleId styleCode productName variantLabel updatedAt",
  "sourceStockItemId production.stockItemId",
  "techSheet.technical.status techSheet.technical.operations",
].join(" ");

/* ── THE PROOF NEEDS THE PARENTS; THE RESPONSE NEVER SEES THEM ────────────
   Opening ONE style proves its company through `ownershipProofFor`, which
   reads the style's own `journeyId`/`enquiryId` — so the detail read has to
   select them. They are selected and used, and then they stop: every field
   that leaves `readStyle` is written out by hand below, and neither reference
   is among them. The LIST does not need this projection at all, because it is
   bounded by the ownership clause before Mongo looks at a style. */
const STYLE_DETAIL_PROJECTION = `${STYLE_PROJECTION} journeyId enquiryId`;

/**
 * THE IE STYLE WORKLIST.
 *
 * Only styles whose company ownership is PROVABLE for this actor's company. A
 * style whose parentage cannot be attributed is not listed as unavailable — it
 * is not listed, which is the same answer another company's style gets.
 */
async function listStyles(ctx, { limit, cursor } = {}) {
  assertContext(ctx);
  const size = pageSize(limit);
  const after = decodeCursor(cursor, "time");

  const bound = await styleOwnershipClause(ctx.companyId);
  /* A company that owns no Sales parent owns no style. A truthful empty page,
     not an error and not everybody else's styles. */
  if (!bound) {
    return { rows: [], limit: size, hasMore: false, nextCursor: null, sort: "updatedAt:desc,_id:desc" };
  }

  const filter = { ...bound, $and: [] };
  if (after) {
    const at = new Date(Number(after.t));
    filter.$and.push({
      $or: [
        { updatedAt: { $lt: at } },
        { updatedAt: at, _id: { $lt: new mongoose.Types.ObjectId(after.i) } },
      ],
    });
  }
  if (!filter.$and.length) delete filter.$and;

  /* One row more than asked for, so "is there another page" is answered by the
     database rather than guessed from a full page. */
  const found = await SampleStyle().find(filter)
    .select(STYLE_PROJECTION)
    .sort({ updatedAt: -1, _id: -1 })
    .limit(size + 1)
    .lean();

  const page = found.slice(0, size);
  const productRoutes = await productRoutesFor(page);

  /* Project every style's rows first, then ask the register ONCE about the
     codes this page actually names — one aggregation per request rather than
     one per style, and bounded by the page's own codes rather than by the size
     of the register. Each style is then told only about ITS own codes, so a
     duplicate one style names cannot make its neighbour ambiguous. */
  const projected = new Map(page.map((style) =>
    [str(style._id), projectRoutes(style, productRoutes.get(str(style._id)))]));
  const pageCodes = new Set();
  for (const parts of projected.values()) {
    for (const code of codesUsedBy(parts)) pageCodes.add(code);
  }
  const duplicated = await duplicateCodes(pageCodes);

  const rows = page.map((style) => {
    const own = projected.get(str(style._id));
    const parts = assemble(style, own, ownDuplicates(own, duplicated));
    return styleListRow(style, parts);
  });

  const last = page[page.length - 1];
  return {
    rows,
    limit: size,
    hasMore: found.length > size,
    nextCursor: found.length > size
      ? encodeCursor({ t: last?.updatedAt ? new Date(last.updatedAt).getTime() : 0, i: str(last?._id) })
      : null,
    /* Published so a caller can rely on the order rather than observe it. */
    sort: "updatedAt:desc,_id:desc",
  };
}

/**
 * ONE STYLE, AND ITS TWO ROUTES — SEPARATELY.
 *
 * Absent, another company's, and unprovable all return the same refusal. A
 * refusal that varies with the answer is an oracle for which style ids are
 * real, and for which of them belong to somebody else.
 */
async function readStyle(ctx, { styleId } = {}) {
  assertContext(ctx);
  if (!isId(styleId)) throw styleNotFound();

  const style = await SampleStyle().findById(styleId).select(STYLE_DETAIL_PROJECTION).lean();
  if (!style) throw styleNotFound();
  /* Proved one style at a time, through the Sales parent that carries the
     company. Neither parent is published below. */
  if (!(await ownershipProofFor(style, ctx.companyId))) throw styleNotFound();

  const productRoutes = await productRoutesFor([style]);
  const projected = projectRoutes(style, productRoutes.get(str(style._id)));
  /* Only the codes this style's own two routes name. */
  const duplicated = await duplicateCodes(codesUsedBy(projected));
  const parts = assemble(style, projected, ownDuplicates(projected, duplicated));

  return {
    style: {
      styleId: str(style._id),
      reference: str(style.styleCode) || str(style.sampleStyleId),
      productName: str(style.productName),
      variantLabel: str(style.variantLabel),
      technicalStatus: parts.technicalStatus,
    },
    /* TWO SOURCES, NOT ONE MERGED LIST. Neither is labelled authoritative,
       and no row of one appears inside the other. */
    routes: {
      technical: { ...parts.technical, rows: parts.technicalRows },
      product: { ...parts.product, rows: parts.productRows },
    },
    comparison: {
      state: parts.comparison.state,
      reason: parts.comparison.reason,
      details: parts.comparison.details,
      /* The rule order that decided it, published so a reader can see WHY
         this state won when more than one difference was true. */
      precedence: routeComparison.PRECEDENCE.map((rule) => rule.reason),
      states: routeComparison.STATES,
    },
    gaps: parts.gaps,
    /* Chunk 1A is a read boundary. Stated in the payload so no shell renders
       a Save affordance against it by assumption. */
    readOnly: true,
  };
}

/* ═══ THE OPERATION LIBRARY ════════════════════════════════════════════════ */

/**
 * THE COMPATIBILITY LIMITATION, PUBLISHED RATHER THAN PAPERED OVER.
 *
 * `Operation` has no `companyId` and no active flag. Adding a filter on a
 * field the model does not have would match nothing, and an empty list
 * presented as a company's register is a false statement of isolation — the
 * Chunk 0 audit names it as a migration gate for exactly that reason.
 *
 * So the register is read as what it is — global, and every row of it live —
 * and the response says so in a field a client can branch on rather than in
 * prose nobody parses.
 */
const OPERATION_SCOPE = Object.freeze({
  companyScoped: false,
  limitation: "OPERATION_MASTER_NOT_COMPANY_SCOPED",
  message: "The operation master is a single global register today: it carries no company and no "
    + "retirement state, so every registered operation is listed and every one is treated as active. "
    + "This list is therefore not isolated to your company.",
});

/**
 * Codes held by more than one registered operation, across the WHOLE register.
 *
 * Computed over the collection rather than over the page, because a duplicate
 * whose twin sits on page four is still a duplicate on page one — detecting it
 * per page would report the same code as unique or ambiguous depending on how
 * the caller happened to page.
 *
 * Nothing is merged, deleted or ranked. Two records sharing one code may be two
 * real operations somebody must reconcile, and choosing between them is not a
 * read's decision — least of all "whichever the database returned last".
 */
async function duplicateCodes(onlyCodes = null) {
  /* An empty ASK is not the same as no ask. `null` means "every code in the
     register" (the library's question); an empty set means "these zero codes"
     (a style whose routes name none), and answering that with the whole
     register would make an uncoded style inherit somebody else's ambiguity. */
  if (onlyCodes && onlyCodes.size === 0) return new Map();

  const rows = await Operation().aggregate([
    { $project: { code: { $toUpper: { $trim: { input: { $ifNull: ["$operationCode", ""] } } } } } },
    /* The SAME normal form the row key uses — upper-cased and trimmed — so a
       route's `ts008` and a master's ` TS008 ` are one code here, on both
       sides of the comparison. */
    { $match: onlyCodes ? { code: { $in: [...onlyCodes] } } : { code: { $ne: "" } } },
    { $group: { _id: "$code", count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $sort: { _id: 1 } },
  ]);
  return new Map(rows.map((r) => [r._id, r.count]));
}

/** How trustworthy one row's code is as an identity. */
const CODE_STATE = Object.freeze({
  UNIQUE: "UNIQUE",
  AMBIGUOUS: "AMBIGUOUS",
  NOT_CODED: "NOT_CODED",
});

/**
 * One registered operation, as IE reads it.
 *
 * `salaryDept` and `salaryDesig` are on this model and are neither selected
 * nor projected. A labour grade may one day belong to IE; a salary basis never
 * will, and the register's own headcount and salary lookups stay behind the
 * configuration router they already live on.
 */
function operationRow(op, duplicates) {
  const code = str(op?.operationCode);
  const upper = code.toUpperCase();
  const duplicateCount = upper ? duplicates.get(upper) || 0 : 0;
  return {
    operationId: str(op?._id),
    code,
    name: str(op?.name),
    samMinutes: present(op?.totalSam) && Number.isFinite(Number(op.totalSam)) ? Number(op.totalSam) : null,
    durationSeconds: present(op?.durationSeconds) && Number.isFinite(Number(op.durationSeconds))
      ? Number(op.durationSeconds) : null,
    machineType: str(op?.machineType),
    /* Named on the row, so a caller that renders one operation still learns
       its code cannot identify it. */
    codeState: !upper ? CODE_STATE.NOT_CODED
      : duplicateCount > 1 ? CODE_STATE.AMBIGUOUS : CODE_STATE.UNIQUE,
    ambiguous: duplicateCount > 1,
    duplicateCodeCount: duplicateCount > 1 ? duplicateCount : 0,
  };
}

/**
 * THE READ-ONLY OPERATION LIBRARY.
 *
 * Bounded, ordered by name then id so the order is total, and searchable by a
 * literal term the caller cannot turn into a pattern.
 */
async function listOperations(ctx, { q = "", limit, cursor } = {}) {
  assertContext(ctx);
  const size = pageSize(limit);
  const after = decodeCursor(cursor, "name");

  const filter = { $and: [] };
  const term = str(q);
  if (term) {
    const rx = literalRegex(term);
    filter.$and.push({ $or: [{ name: rx }, { operationCode: rx }] });
  }
  if (after) {
    filter.$and.push({
      $or: [
        { name: { $gt: after.n } },
        { name: after.n, _id: { $gt: new mongoose.Types.ObjectId(after.i) } },
      ],
    });
  }
  const query = filter.$and.length ? filter : {};

  const [found, duplicates] = await Promise.all([
    Operation().find(query)
      .select("_id name operationCode totalSam durationSeconds machineType")
      .sort({ name: 1, _id: 1 })
      .limit(size + 1)
      .lean(),
    duplicateCodes(),
  ]);

  const page = found.slice(0, size);
  const last = page[page.length - 1];
  return {
    scope: OPERATION_SCOPE,
    rows: page.map((op) => operationRow(op, duplicates)),
    limit: size,
    hasMore: found.length > size,
    nextCursor: found.length > size ? encodeCursor({ n: str(last?.name), i: str(last?._id) }) : null,
    sort: "name:asc,_id:asc",
    /* The register's own ambiguity, summarised once so a screen can warn
       without re-deriving it from the page it happens to be showing. */
    ambiguity: {
      duplicateCodeCount: duplicates.size,
      duplicateCodes: [...duplicates.keys()],
    },
    readOnly: true,
  };
}

module.exports = {
  CODES, DEFAULT_LIMIT, MAX_LIMIT, ROUTE_SOURCE, PRODUCT_LINK, GAP_OWNER,
  CODE_STATE, OPERATION_SCOPE, STYLE_PROJECTION, STYLE_DETAIL_PROJECTION,
  technicalRow, productRow, rowTime, totalSam, productLinkOf, gapsFor,
  projectRoutes, codesUsedBy, ownDuplicates, duplicateCodes,
  /* Reused by the order boundary (Chunk 1B) so a style reads the same inside
     an order as it does on its own. Exported rather than reimplemented: a
     second route comparison would be a second answer to the one question this
     department exists to settle. */
  productRoutesFor, assemble, styleListRow, routeSourceView,
  literalRegex, encodeCursor, decodeCursor, pageSize,
  listStyles, readStyle, listOperations,
};
