// services/industrialEngineering/orderStyleLink.js
//
// IE — WHICH STYLE IS THIS ORDER FOR, AND WHOSE ORDER IS IT?
//
// ── WHY ONE MODULE, USED BY BOTH ────────────────────────────────────────────
// Two callers ask this question: the Orders endpoint, which has to decide what
// a company may see, and the Chunk 1C audit, which has to count how much of the
// real data the endpoint can show. When those two disagreed the audit was
// worthless — it reported a coverage the endpoint would refuse, and a conflict
// the endpoint would have leaked. So the decision is made HERE, once, and both
// callers read the answer rather than forming their own.
//
// Nothing in this file touches a database. It is handed a work order, its
// customer request, every style that names the order, and a company lookup, and
// it returns a decision. That is what makes the two callers provably identical
// rather than approximately similar.
//
// ── AND WHY THE DIRECT REFERENCE IS NOT A SHORTCUT ──────────────────────────
// An earlier version admitted a work order to a company as soon as one of that
// company's styles named it, BEFORE looking at what the request line said. A
// direct reference is order-specific, so that felt safe. It was not: an order
// directly named by company A's style and line-resolved to company B's style
// was admitted to A on the strength of the direct reference and to B on the
// strength of the line, and the same order appeared in two companies' lists.
//
// The two references are therefore resolved TOGETHER, and every style either of
// them reaches has to belong to one company before anybody sees the order.
"use strict";

const str = (v) => String(v ?? "").trim();
const sortedUnique = (ids) => [...new Set((ids || []).map(str).filter(Boolean))].sort();

/** What the customer request could prove about ONE work order. */
const LINE_RESOLUTION = Object.freeze({
  RESOLVED: "RESOLVED",
  AMBIGUOUS: "AMBIGUOUS",
  UNRESOLVED: "UNRESOLVED",
});

/** How a style came to be attached, published so a reader can see the proof. */
const STYLE_LINK = Object.freeze({
  /* IE Chunk 1D — the canonical field, written on the work order at creation
     from the exact request line or source order. The strongest proof there is:
     one value, order-specific, recorded by the writer that knew the answer. */
  CANONICAL: "WORK_ORDER_SAMPLE_STYLE_ID",
  /* Legacy, style-side and appended after the fact. */
  WORK_ORDER_REFERENCE: "STYLE_WORK_ORDER_REFERENCE",
  /* Legacy, resolved from the exact customer-request line. */
  ORDER_LINE_REFERENCE: "ORDER_LINE_STYLE_REFERENCE",
});

/** What the reference paths say about this order, together. */
const STYLE_LINK_STATUS = Object.freeze({
  /* The canonical field alone, or the canonical field agreeing with a legacy
     one. Reported distinctly so the audit can count how much of the register
     has moved onto the Chunk 1D contract. */
  CANONICAL_WORK_ORDER_REFERENCE: "CANONICAL_WORK_ORDER_REFERENCE",
  DIRECT_WORK_ORDER_REFERENCE: "DIRECT_WORK_ORDER_REFERENCE",
  UNIQUE_ORDER_LINE_REFERENCE: "UNIQUE_ORDER_LINE_REFERENCE",
  BOTH_REFERENCES_AGREE: "BOTH_REFERENCES_AGREE",
  /* Both paths name styles, and they are not the same styles. Nothing stored
     says which is right, so neither is attached. */
  REFERENCES_CONFLICT: "REFERENCES_CONFLICT",
  AMBIGUOUS_ORDER_LINES: "AMBIGUOUS_ORDER_LINES",
  UNRESOLVED_ORDER_LINE: "UNRESOLVED_ORDER_LINE",
  NO_STYLE_REFERENCE: "NO_STYLE_REFERENCE",
});

/** How well the order can be attributed to a company. */
const COMPANY_ATTRIBUTION = Object.freeze({
  ONE_COMPANY: "ONE_COMPANY",
  MULTIPLE_COMPANIES: "MULTIPLE_COMPANIES",
  NO_COMPANY_PROOF: "NO_COMPANY_PROOF",
});

/**
 * Resolve what ONE customer request proves about ONE work order.
 *
 * ── WHY A REQUEST IS NOT A LINK ────────────────────────────────────────────
 * A customer request holds several product lines, and the work-order generator
 * emits one work order per line per variant. Sharing a request proves the
 * records were raised together and nothing more.
 *
 * ── AND WHAT IS AVAILABLE TO NARROW IT ─────────────────────────────────────
 *   · the request line has NO stable id — `requestItemSchema` is `{_id:false}`;
 *   · `WorkOrder.variantId` holds the STOCK ITEM variant's `_id`, common to
 *     every line naming that product, and a `variants[0]` fallback in the
 *     generator can give two orders the same value;
 *   · `variantAttributes` falls back to the product's — free text, same fault;
 *   · name and reference are text, which this boundary refuses everywhere.
 *
 * That leaves `stockItemId`, which identifies the line when the request names a
 * product once and NOTHING when two lines name it — the case this reports
 * rather than resolves.
 */
function resolveOrderLine(order, request) {
  if (!request) return { state: LINE_RESOLUTION.UNRESOLVED, styleIds: [] };

  const items = Array.isArray(request.items) ? request.items : [];
  const wanted = str(order?.stockItemId);
  const candidates = wanted ? items.filter((item) => str(item?.stockItemId) === wanted) : [];

  if (!candidates.length) {
    /* The request-level style is the last thing left, and it is usable only
       when there is no other line for it to be confused with. */
    const requestStyle = str(request.sampleStyleId);
    if (requestStyle && items.length <= 1) {
      return { state: LINE_RESOLUTION.RESOLVED, styleIds: [requestStyle] };
    }
    return { state: LINE_RESOLUTION.UNRESOLVED, styleIds: [] };
  }

  const fallback = items.length <= 1 ? str(request.sampleStyleId) : "";
  const named = candidates.map((item) => str(item?.sampleStyleId) || fallback);

  if (named.some((id) => !id)) {
    /* Exactly one candidate and it is silent — nothing says, so UNRESOLVED.
       Several, one silent — the others do not get to answer for it. */
    return {
      state: candidates.length > 1 ? LINE_RESOLUTION.AMBIGUOUS : LINE_RESOLUTION.UNRESOLVED,
      styleIds: [],
    };
  }
  const distinct = sortedUnique(named);
  return {
    state: distinct.length === 1 ? LINE_RESOLUTION.RESOLVED : LINE_RESOLUTION.AMBIGUOUS,
    styleIds: distinct,
  };
}

/**
 * THE WHOLE DECISION FOR ONE WORK ORDER.
 *
 * @param {object} input
 * @param {object} input.order            the work order (lean)
 * @param {object|null} input.request     its customer request, or null
 * @param {string[]} input.directStyleIds EVERY style naming this order through
 *   the legacy `production.workOrderIds[]`, from ANY company. Passing only the
 *   caller's own styles is what let a conflict split across two companies go
 *   unseen by both.
 * @param {string|null} [input.canonicalStyleId]  `WorkOrder.sampleStyleId` —
 *   the Chunk 1D field. Absent on every record created before it existed, and
 *   no backfill is approved, so absence simply means "use the legacy paths".
 * @param {(styleId: string) => (string|null)} input.ownerOf  the company that
 *   provably owns a style under the accepted eligibility rule, or `null` when
 *   the style is absent, ineligible, or its ownership cannot be proved.
 *
 * @returns {{
 *   linkStatus, lineResolution, attribution, companyId,
 *   directStyleIds, lineStyleIds, attachedStyleIds, disputed, unprovableStyleIds
 * }}
 */
function resolveOrderStyleLink({
  order, request = null, directStyleIds = [], canonicalStyleId = null, ownerOf = () => null,
} = {}) {
  const direct = sortedUnique(directStyleIds);
  const resolution = resolveOrderLine(order, request);
  const lineStyles = resolution.state === LINE_RESOLUTION.RESOLVED
    ? sortedUnique(resolution.styleIds)
    : [];
  /* The canonical field, if the order carries one. Read from the order itself
     when the caller did not pass it, so no call site can forget it. */
  const canonical = sortedUnique([
    canonicalStyleId !== null && canonicalStyleId !== undefined
      ? canonicalStyleId : order?.sampleStyleId,
  ]);

  /* ── WHAT THE PATHS SAY, TOGETHER ──────────────────────────────────────
     Three stored sources now, and they are compared pairwise as ONE set: a
     disagreement between ANY two is a conflict, whichever pair it is. The
     canonical field does not get to overrule a legacy one — that would be
     choosing between two stored references on no evidence, which is the thing
     this boundary exists to refuse. It is stronger PROVENANCE, not a
     tie-breaker. */
  const present = [canonical, direct, lineStyles].filter((set) => set.length);
  const allAgree = present.length <= 1
    || present.every((set) => set.length === present[0].length
      && set.every((id, i) => id === present[0][i]));

  /* ── CANONICAL IS COMPARED AGAINST AMBIGUOUS CANDIDATES TOO ──────────────
     An ambiguous request line resolves to NO style, so its candidates used to
     be left out of the comparison entirely — and a canonical reference was
     then attached while the very lines it should agree with named something
     else. Canonical provenance must never silently overrule contradictory
     stored evidence; that is the whole reason the field is trustworthy.

     Two shapes, and they need different answers:
       · the lines name several styles — canonical can equal at most one of
         them, so it CONTRADICTS the rest. That is a conflict.
       · a matching line names nothing at all — there is nothing to contradict
         and nothing to confirm, so the honest answer is the ambiguity itself.
     Both attach no style. */
  const ambiguousNamed = resolution.state === LINE_RESOLUTION.AMBIGUOUS
    ? sortedUnique(resolution.styleIds) : [];
  const canonicalContradictsAmbiguous = canonical.length > 0 && ambiguousNamed.length > 0
    && ambiguousNamed.some((id) => !canonical.includes(id));
  const canonicalUnconfirmable = canonical.length > 0
    && resolution.state === LINE_RESOLUTION.AMBIGUOUS && ambiguousNamed.length === 0;

  let linkStatus;
  let disputed = false;
  if ((present.length > 1 && !allAgree) || canonicalContradictsAmbiguous) {
    linkStatus = STYLE_LINK_STATUS.REFERENCES_CONFLICT;
    disputed = true;
  } else if (canonicalUnconfirmable) {
    /* Ambiguity stands, and nothing is attached — see above. */
    linkStatus = STYLE_LINK_STATUS.AMBIGUOUS_ORDER_LINES;
    disputed = true;
  } else if (canonical.length) {
    /* Canonical alone, or canonical agreeing with a legacy reference. */
    linkStatus = STYLE_LINK_STATUS.CANONICAL_WORK_ORDER_REFERENCE;
  } else if (direct.length && lineStyles.length) {
    linkStatus = STYLE_LINK_STATUS.BOTH_REFERENCES_AGREE;
  } else if (resolution.state === LINE_RESOLUTION.AMBIGUOUS) {
    /* Reported ahead of a lone direct reference, because "the request lines
       cannot say which style this order is for" stays true whether or not a
       style also names the order. The direct reference is still order-specific
       proof and is still attached below — what it cannot do is make the
       request's ambiguity disappear from the report. */
    linkStatus = STYLE_LINK_STATUS.AMBIGUOUS_ORDER_LINES;
  } else if (direct.length) {
    linkStatus = STYLE_LINK_STATUS.DIRECT_WORK_ORDER_REFERENCE;
  } else if (lineStyles.length) {
    linkStatus = STYLE_LINK_STATUS.UNIQUE_ORDER_LINE_REFERENCE;
  } else if (request) {
    linkStatus = STYLE_LINK_STATUS.UNRESOLVED_ORDER_LINE;
  } else {
    linkStatus = STYLE_LINK_STATUS.NO_STYLE_REFERENCE;
  }

  /* ── EVERY STYLE THE DECISION DEPENDS ON ───────────────────────────────────
     Both paths, plus the candidates an ambiguous line is ambiguous BETWEEN —
     because an order admitted while one of those candidates belongs to another
     company would be an order two companies could each claim. */
  const decisionStyles = sortedUnique([
    ...canonical,
    ...direct,
    ...lineStyles,
    ...(resolution.state === LINE_RESOLUTION.AMBIGUOUS ? resolution.styleIds : []),
  ]);

  const companies = new Set();
  const unprovable = [];
  for (const styleId of decisionStyles) {
    const company = str(ownerOf(styleId));
    if (company) companies.add(company);
    else unprovable.push(styleId);
  }

  /* ── ATTRIBUTION, AND IT FAILS CLOSED ──────────────────────────────────────
     One company only when EVERY style the decision touches is provably that
     company's. A single unprovable style is enough to refuse: it could belong
     to anybody, including somebody who would then have an equal claim. */
  let attribution;
  if (companies.size > 1) attribution = COMPANY_ATTRIBUTION.MULTIPLE_COMPANIES;
  else if (companies.size === 1 && !unprovable.length) attribution = COMPANY_ATTRIBUTION.ONE_COMPANY;
  else attribution = COMPANY_ATTRIBUTION.NO_COMPANY_PROOF;

  const companyId = attribution === COMPANY_ATTRIBUTION.ONE_COMPANY ? [...companies][0] : null;

  /* ── AND WHAT MAY BE ATTACHED ─────────────────────────────────────────────
     Nothing, where the two references DISAGREE. The order may still be
     VISIBLE — its company is proved either way — but publishing a disputed
     style would be choosing between two stored references on no evidence,
     which is the one thing this boundary must not do.

     An ambiguous request line does NOT suppress a direct reference: a style
     naming the order is order-specific proof on its own, and it is what the
     accepted Chunk 1B contract attaches. The ambiguity is reported beside it
     rather than used to withhold it. Where there is no direct reference the
     ambiguity leaves nothing to attach, which is the same outcome. */
  const attachedStyleIds = (!companyId || disputed)
    ? []
    : sortedUnique([...canonical, ...direct, ...lineStyles]);

  return {
    linkStatus,
    lineResolution: resolution.state,
    attribution,
    companyId,
    /* Every company the decision reached, sorted. One entry on a clean order,
       two or more on the cross-company case the audit has to be able to count.
       It is a count of COMPANIES, never a way to name somebody else's — the
       endpoint reads only `companyId`, which is null unless it is one. */
    companyIds: [...companies].sort(),
    canonicalStyleIds: canonical,
    directStyleIds: direct,
    lineStyleIds: lineStyles,
    attachedStyleIds,
    /* How each attached style was proved, for the response's `linkedVia`. */
    /* Strongest provenance first: a style proved by the canonical field says
       so, even when a legacy reference agrees with it. */
    linkVia: Object.fromEntries(attachedStyleIds.map((id) => [
      id,
      canonical.includes(id) ? STYLE_LINK.CANONICAL
        : direct.includes(id) ? STYLE_LINK.WORK_ORDER_REFERENCE
          : STYLE_LINK.ORDER_LINE_REFERENCE,
    ])),
    disputed,
    unprovableStyleIds: unprovable,
    decisionStyleIds: decisionStyles,
  };
}

module.exports = {
  LINE_RESOLUTION, STYLE_LINK, STYLE_LINK_STATUS, COMPANY_ATTRIBUTION,
  resolveOrderLine, resolveOrderStyleLink,
};
