/**
 * services/storeFulfilment.service.js
 *
 * CAN WE GIVE THEM THIS, OR DO WE HAVE TO BUY IT?
 *
 * ── THE RULE THIS ENFORCES ──────────────────────────────────────────────────
 * A department's request reaches finance because MONEY HAS TO BE SPENT — not
 * because the request exists. Between the TL agreeing the department needs the
 * thing and finance agreeing to pay for it, somebody has to look at the shelf,
 * and that somebody is Store.
 *
 *   issue_from_stock     we have it → stock moves, nothing is bought, no
 *                        budget is touched, finance never hears about it
 *   partial_buy_balance  we have some → issue what we have, price only the
 *                        shortfall and send that on
 *   buy_or_service       we have none, or it was never stock → price it whole
 *
 * ── WHY THE ARITHMETIC LIVES HERE AND NOT IN THE ROUTE ──────────────────────
 * Three of these numbers decide how much money leaves the company: what is
 * still owed on a line, how much of that is being bought, and what the tax
 * makes the total. A route can be tested only through HTTP with a database
 * behind it; these can be tested as arithmetic, which is what they are. The
 * route keeps the parts that genuinely need a database — stock levels, the
 * budget head, writing the documents.
 *
 * ── AND WHY IT NEVER TOUCHES A BUDGET ───────────────────────────────────────
 * Nothing here commits, reserves or consumes budget. A commitment is made when
 * FINANCE approves the priced request that comes out of this — see
 * budgetCommitment.service — and issuing stock the company already owns makes
 * no commitment at all, because it spends nothing.
 */

"use strict";

/** The three answers Store can give. */
const ISSUE_FROM_STOCK = "issue_from_stock";
const PARTIAL_BUY_BALANCE = "partial_buy_balance";
const BUY_OR_SERVICE = "buy_or_service";

const DECISIONS = [ISSUE_FROM_STOCK, PARTIAL_BUY_BALANCE, BUY_OR_SERVICE];

/** What each is called on the screen the store person is looking at. */
const DECISION_LABEL = {
  [ISSUE_FROM_STOCK]: "Issue from stock",
  [PARTIAL_BUY_BALANCE]: "Partly issue, buy the balance",
  [BUY_OR_SERVICE]: "Buy or arrange a service",
};

/** Does this answer end with something being bought? */
const needsPurchase = (decision) =>
  decision === PARTIAL_BUY_BALANCE || decision === BUY_OR_SERVICE;

const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

const qty = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * What is still owed on a line.
 *
 * A line that has been rejected or written off owes nothing — it is not short,
 * it is closed, and treating it as a shortfall would put it on a purchase
 * order somebody deliberately declined to raise.
 */
function remainingOn(item) {
  if (!item) return 0;
  if (["REJECTED", "UNFULFILLED"].includes(item.itemStatus)) return 0;
  return Math.max(0, (Number(item.requestedQty) || 0) - (Number(item.issuedQty) || 0));
}

/**
 * Check one decision against the lines it is being made about.
 *
 * @param {string} decision      one of DECISIONS
 * @param {object[]} items       the MRF's lines, as plain objects
 * @param {object[]} plan        `[{ itemId, issueQty, buyQty, rate }]` — what
 *                               the store person filled in
 * @param {Map<string, number|null>} availableByItem  live stock per line id,
 *                               in the REQUESTER's unit. `null` means the line
 *                               has no catalogue item, so stock is unknowable
 *                               rather than zero.
 * @returns {{ok: boolean, reason: string|null, lines: object[]}}
 *
 * `lines` comes back resolved: every line with the quantity to issue and the
 * quantity to buy already decided, so the route writes what it was given
 * rather than re-deriving it a second way.
 */
function planFor({ decision, items = [], plan = [], availableByItem = new Map() } = {}) {
  const no = (reason) => ({ ok: false, reason, lines: [] });
  if (!DECISIONS.includes(decision)) {
    return no("Choose how this request is being fulfilled.");
  }

  const byId = new Map((plan || []).map((p) => [String(p.itemId), p]));
  const lines = [];
  let totalIssue = 0;
  let totalBuy = 0;

  for (const item of items) {
    const id = String(item._id);
    const owed = remainingOn(item);
    if (owed <= 0) continue;

    const p = byId.get(id) || {};
    const available = availableByItem.has(id) ? availableByItem.get(id) : null;

    let issueQty = 0;
    let buyQty = 0;

    if (decision === ISSUE_FROM_STOCK) {
      /* The whole outstanding quantity comes off the shelf, or this is the
         wrong decision. A store person who can only cover part of it is
         making the PARTIAL decision, and letting this one through would
         silently drop the rest of the request on the floor. */
      issueQty = owed;
      if (available !== null && available + 0.001 < owed) {
        return no(
          `"${item.rawItemName}" is short — ${available} ${item.unit} in stock against ${owed} ${item.unit} owed. ` +
            `Use "${DECISION_LABEL[PARTIAL_BUY_BALANCE]}" to issue what you have and buy the rest.`,
        );
      }
      if (available === null) {
        return no(
          `"${item.rawItemName}" is not matched to a catalogue item, so there is no stock figure for it. ` +
            `Match or register it first, or buy it instead.`,
        );
      }
    } else if (decision === BUY_OR_SERVICE) {
      /* None of it comes off the shelf. */
      buyQty = owed;
    } else {
      /* PARTIAL — the store person says how much of each line they can cover
         and the rest is bought. Both halves are checked: issuing more than is
         on the shelf is a stock error, and issuing more than is owed is an
         arithmetic one. */
      issueQty = qty(p.issueQty);
      buyQty = qty(p.buyQty);

      if (issueQty > owed + 0.001) {
        return no(
          `Cannot issue ${issueQty} ${item.unit} of "${item.rawItemName}" — only ${owed} ${item.unit} is owed.`,
        );
      }
      if (available !== null && issueQty > available + 0.001) {
        return no(
          `Cannot issue ${issueQty} ${item.unit} of "${item.rawItemName}" — only ${available} ${item.unit} is in stock.`,
        );
      }
      if (issueQty + buyQty > owed + 0.001) {
        return no(
          `"${item.rawItemName}": issuing ${issueQty} and buying ${buyQty} comes to more than the ${owed} ${item.unit} owed.`,
        );
      }
      /* Leaving a gap is allowed and is not the same as a mistake: a store
         person may issue two of five and buy two, leaving one the requester
         no longer needs. It is recorded as what it is — still owed — rather
         than silently rounded into the purchase. */
    }

    totalIssue += issueQty;
    totalBuy += buyQty;
    lines.push({
      itemId: id,
      name: item.rawItemName,
      unit: item.unit,
      owed,
      issueQty: money(issueQty),
      buyQty: money(buyQty),
      rate: money(p.rate),
      note: item.description || "",
    });
  }

  if (!lines.length) {
    return no("Nothing is outstanding on this request — there is nothing to decide.");
  }
  if (decision === PARTIAL_BUY_BALANCE && totalBuy <= 0) {
    return no(
      `Nothing is being bought. If the shelf covers all of it, use "${DECISION_LABEL[ISSUE_FROM_STOCK]}".`,
    );
  }
  if (decision === PARTIAL_BUY_BALANCE && totalIssue <= 0) {
    return no(
      `Nothing is being issued. If none of it is on the shelf, use "${DECISION_LABEL[BUY_OR_SERVICE]}".`,
    );
  }

  return { ok: true, reason: null, lines };
}

/**
 * What finance is being asked to agree to.
 *
 * ── TAX PER LINE, WHERE THE LINE KNOWS ITS OWN ──────────────────────────────
 * This used to put one rate on top of the whole quote, on the reasoning that
 * Store had one quote from one vendor. That reasoning was wrong for anything
 * with more than one line on it: a request for a laptop and a service contract
 * is two vendors at two rates, and averaging them produced a figure that
 * matched neither invoice.
 *
 * So a line may carry its own `gstPercent`, and the shared one is the fallback
 * for every caller that has only ever had one — the material door still passes
 * a single rate and still gets exactly what it got before.
 *
 * `gstPercent` in the RESULT is the blended rate the whole quote works out to,
 * kept because the request document has always had that field and reports read
 * it. It is a summary of the lines, never the thing the arithmetic was done
 * with.
 */
function priceFor({ lines = [], gstPercent = 0 } = {}) {
  const fallback = Math.min(100, Math.max(0, Number(gstPercent) || 0));

  let subtotal = 0;
  let taxAmount = 0;
  for (const l of lines) {
    const net = money(l.buyQty) * money(l.rate);
    const pct =
      l.gstPercent === null || l.gstPercent === undefined
        ? fallback
        : Math.min(100, Math.max(0, Number(l.gstPercent) || 0));
    subtotal += net;
    taxAmount += (net * pct) / 100;
  }
  subtotal = money(subtotal);
  taxAmount = money(taxAmount);

  return {
    subtotal,
    /* The blended rate, to one decimal — a summary for the document field, and
       exactly `fallback` whenever every line shares it, so nothing that passed
       one rate sees a different number than it used to. */
    gstPercent: subtotal > 0 ? Math.round((taxAmount / subtotal) * 1000) / 10 : fallback,
    taxAmount,
    grandTotal: money(subtotal + taxAmount),
  };
}

/**
 * Is this priced enough for finance to answer?
 *
 * The gate, stated once. Finance approves MONEY — so a request whose lines
 * carry no rate is a request nobody has costed, and approving one would be
 * agreeing to a figure that does not exist yet. Checked on the document rather
 * than on the request body, so it holds however the row was written.
 */
function pricingGate(request) {
  const lines = request?.items || [];
  if (!lines.length) return { ok: false, reason: "This request has no lines to price." };

  const unpriced = lines.filter((l) => !(money(l.rate) > 0));
  if (unpriced.length) {
    return {
      ok: false,
      reason:
        `This request has not been priced yet — ${unpriced.length} line${unpriced.length === 1 ? "" : "s"} ` +
        `carr${unpriced.length === 1 ? "ies" : "y"} no rate. Store adds the commercial details before finance can approve it.`,
    };
  }
  if (!(money(request.totalAmount) > 0)) {
    return {
      ok: false,
      reason: "This request has not been priced yet — its total is zero.",
    };
  }
  return { ok: true, reason: null };
}

module.exports = {
  ISSUE_FROM_STOCK,
  PARTIAL_BUY_BALANCE,
  BUY_OR_SERVICE,
  DECISIONS,
  DECISION_LABEL,
  needsPurchase,
  remainingOn,
  planFor,
  priceFor,
  pricingGate,
};
