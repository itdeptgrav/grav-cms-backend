// services/accounting/proformaDispatch.js
//
// WHAT HAS BEEN DISPATCHED AGAINST A PROFORMA INVOICE, PRICED.
//
// The accounts department does not need the packing floor's view of a
// dispatch — it does not care which carton a piece travelled in or who it was
// made for. It needs the billable facts: which product, which variant, how
// many left, at what rate, and which challans say so.
//
// So this rolls a challan's own structure UP. A challan holds either
// `bulkProducts[]` or `persons[].products[]` (person-wise orders), and
// separately `cartons[].lines[]` for the boxes. The products are the
// authoritative quantity — a manual challan has no cartons at all — so the
// roll-up reads those and uses the cartons only to count boxes.
//
// ── THE CHALLAN CARRIES NO PRICE ───────────────────────────────────────────
// Nothing in DispatchChallan knows what anything costs; a challan is a
// delivery document. The rate therefore comes from the PROFORMA's own line
// for the same product, which is the whole reason this is keyed to a PI and
// not to an order. A dispatched product the proforma does not price is
// reported with `rate: null` and counted in `unpriced` rather than being
// given a zero — a zero would quietly bill somebody nothing.
//
// ── IT IS PURE ─────────────────────────────────────────────────────────────
// Every function takes plain documents and returns plain data, so the whole
// shaping is tested without a database (proformaDispatch.test.js). The route
// does the reading; this does the thinking.

"use strict";

/**
 * A product name reduced for comparison. Names are typed in both systems.
 *
 * Everything that is not a letter or a digit is REMOVED rather than turned
 * into a space, because both spellings of the same product occur: an initialism
 * loses its dots ("G.R.A.V." and "GRAV"), and a compound loses its hyphen
 * ("T-Shirt" and "T Shirt"). Replacing with a space fixes the second and
 * breaks the first; removing fixes both, and two products that differ only in
 * where a space falls are not a real pair.
 */
function normaliseProduct(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** "Size: M · Colour: Red" from the challan's [{name, value}] attributes. */
function variantLabel(attributes) {
  if (!Array.isArray(attributes)) return "";
  return attributes
    .map((a) => {
      const name = String(a?.name || "").trim();
      const value = String(a?.value || "").trim();
      if (!value) return "";
      return name ? `${name}: ${value}` : value;
    })
    .filter(Boolean)
    .join(" · ");
}

/** The key a product + variant rolls up under. */
const lineKey = (productName, variant) =>
  `${normaliseProduct(productName)}::${normaliseProduct(variant)}`;

/**
 * Every product line on one challan, flattened.
 *
 * Person-wise and bulk are the same billable fact — a quantity of a product —
 * so they flatten to one shape. Who it was made for is kept only as a count,
 * because the invoice bills the customer, not the wearer.
 */
function challanProductLines(challan) {
  const out = [];
  const push = (p, person) => {
    const quantity = Number(p?.quantity) || 0;
    if (!p?.productName || quantity <= 0) return;
    out.push({
      productName: p.productName,
      productRef: p.productRef || "",
      productImage: p.productImage || "",
      variant: variantLabel(p.variantAttributes),
      quantity,
      person: person || "",
    });
  };
  for (const p of challan?.bulkProducts || []) push(p, "");
  for (const person of challan?.persons || []) {
    for (const p of person?.products || []) push(p, person.employeeName || "");
  }
  return out;
}

/** One challan, as the accounts screen lists it. */
function challanSummary(challan) {
  const lines = challanProductLines(challan);
  return {
    _id: challan?._id ? String(challan._id) : null,
    challanNumber: challan?.challanNumber || "",
    /* Resolved by the route from the invoices that reference this challan —
       the one place the fact lives. Null means it has not been billed. */
    invoice: challan?.invoice || null,
    customerName: challan?.customerName || "",
    dispatchDate: challan?.dispatchDate || challan?.createdAt || null,
    dispatchType: challan?.dispatchType || "bulk",
    cartonCount: Number(challan?.cartonCount) || (challan?.cartons || []).length,
    totalUnits: lines.reduce((n, l) => n + l.quantity, 0),
    productCount: new Set(lines.map((l) => lineKey(l.productName, l.variant))).size,
    peopleCount: (challan?.persons || []).length,
    transport: {
      vehicleNumber: challan?.transport?.vehicleNumber || "",
      driverName: challan?.transport?.driverName || "",
      transporter: challan?.transport?.transporter || "",
      lrNumber: challan?.transport?.lrNumber || "",
    },
  };
}

/**
 * The proforma's lines, indexed for lookup by product (and by product+variant
 * when the proforma names one).
 *
 * A proforma line's variant is usually written into the name
 * ("Blazer — Size: M"), so both the whole string and the part before the dash
 * are indexed; the exact product+variant key is tried first.
 */
function indexProformaItems(items) {
  const byPair = new Map();
  const byName = new Map();
  for (const it of items || []) {
    const full = it?.stockItemName || it?.name || "";
    if (!full) continue;
    const [head, ...rest] = String(full).split(/\s+[—–-]\s+/);
    const tail = rest.join(" - ");
    const entry = {
      rate: Number(it.rate) || 0,
      unit: it.unit || "Nos",
      hsnCode: it.hsnCode || "",
      taxRate: Number(it.taxRate) || 0,
      discountPercent: Number(it.discountPercent) || 0,
      name: full,
    };
    if (tail) byPair.set(lineKey(head, tail), entry);
    if (!byName.has(normaliseProduct(head))) byName.set(normaliseProduct(head), entry);
    if (!byName.has(normaliseProduct(full))) byName.set(normaliseProduct(full), entry);
  }
  return { byPair, byName };
}

/**
 * Roll every challan up into billable lines, priced from the proforma.
 *
 * @param {Array} challans  DispatchChallan documents for the order
 * @param {Array} piItems   the proforma invoice's own line items
 */
function dispatchRollup(challans, piItems, opts = {}) {
  const all = Array.isArray(challans) ? challans : [];
  /* `only` narrows the roll-up to the challans the user ticked, so the
     figures under a selection are the figures that will be invoiced. Absent,
     every challan counts — which is what the panel shows before anything is
     ticked. */
  const only = opts.only ? new Set([...opts.only].map(String)) : null;
  const list = only
    ? all.filter((c) => c?._id && only.has(String(c._id)))
    : all;
  const index = indexProformaItems(piItems);

  const byKey = new Map();
  for (const challan of list) {
    for (const line of challanProductLines(challan)) {
      const key = lineKey(line.productName, line.variant);
      const row = byKey.get(key) || {
        productName: line.productName,
        productRef: line.productRef,
        productImage: line.productImage,
        variant: line.variant,
        quantity: 0,
        challanNumbers: [],
        people: new Set(),
      };
      row.quantity += line.quantity;
      if (challan?.challanNumber && !row.challanNumbers.includes(challan.challanNumber)) {
        row.challanNumbers.push(challan.challanNumber);
      }
      if (line.person) row.people.add(line.person);
      if (!row.productImage && line.productImage) row.productImage = line.productImage;
      byKey.set(key, row);
    }
  }

  const lines = [...byKey.entries()].map(([key, row]) => {
    const priced =
      index.byPair.get(key) ||
      index.byName.get(normaliseProduct(`${row.productName} - ${row.variant}`)) ||
      index.byName.get(normaliseProduct(row.productName)) ||
      null;
    /* No price is NOT a zero price. A zero would bill the customer nothing
       and look deliberate; null is reported and counted. */
    const rate = priced ? priced.rate : null;
    return {
      productName: row.productName,
      productRef: row.productRef,
      productImage: row.productImage,
      variant: row.variant,
      quantity: row.quantity,
      unit: priced?.unit || "Nos",
      hsnCode: priced?.hsnCode || "",
      taxRate: priced?.taxRate ?? null,
      discountPercent: priced?.discountPercent || 0,
      rate,
      amount: rate === null ? null : Number((rate * row.quantity).toFixed(2)),
      pricedFrom: priced ? priced.name : null,
      challanNumbers: row.challanNumbers,
      peopleCount: row.people.size,
    };
  });

  lines.sort((a, b) =>
    a.productName.localeCompare(b.productName) || a.variant.localeCompare(b.variant));

  const unpriced = lines.filter((l) => l.rate === null).length;
  return {
    challans: list.map(challanSummary),
    lines,
    totals: {
      challanCount: list.length,
      cartonCount: list.reduce(
        (n, c) => n + (Number(c?.cartonCount) || (c?.cartons || []).length), 0),
      units: lines.reduce((n, l) => n + l.quantity, 0),
      /* Only what is priced is summed — a total that silently treated the
         unpriced lines as free would be the figure somebody invoices on. */
      value: Number(lines.reduce((n, l) => n + (l.amount || 0), 0).toFixed(2)),
      productCount: lines.length,
      unpriced,
    },
  };
}

/**
 * Which customer a challan was dispatched for, normalised for comparison.
 *
 * The order is the real identity (a customer's NAME is typed and drifts), so
 * it is preferred; the name is the fallback for a challan whose order is
 * missing.
 */
function challanParty(challan) {
  const orderId = challan?.manufacturingOrderId;
  return {
    orderId: orderId ? String(orderId?._id ?? orderId) : "",
    customerName: challan?.customerName || "",
    key: orderId
      ? `order:${String(orderId?._id ?? orderId)}`
      : `name:${normaliseProduct(challan?.customerName)}`,
  };
}

/**
 * May these challans go on ONE invoice?
 *
 * An invoice names a single buyer, so challans for two customers cannot share
 * one — and unlike a wrong rate, that is not something anybody can correct on
 * the invoice afterwards. A challan already billed is refused for the same
 * reason in reverse: billing it twice is the fault this link exists to stop.
 *
 * @param {Array} challans  the challans the user ticked
 * @returns {{ ok: boolean, reason: string|null, customers: string[],
 *             alreadyInvoiced: string[] }}
 */
function selectionGuard(challans) {
  const list = (Array.isArray(challans) ? challans : []).filter(Boolean);
  if (!list.length) {
    return { ok: false, reason: "Choose at least one challan to invoice.", customers: [], alreadyInvoiced: [] };
  }

  const alreadyInvoiced = list
    .filter((c) => c.invoice && c.invoice.voucherNumber)
    .map((c) => `${c.challanNumber} (${c.invoice.voucherNumber})`);
  if (alreadyInvoiced.length) {
    return {
      ok: false,
      reason:
        `Already invoiced: ${alreadyInvoiced.join(", ")}. ` +
        "A dispatch is billed once.",
      customers: [],
      alreadyInvoiced,
    };
  }

  const keys = new Map();
  for (const c of list) {
    const p = challanParty(c);
    if (!keys.has(p.key)) keys.set(p.key, p.customerName || p.orderId || "unknown");
  }
  if (keys.size > 1) {
    return {
      ok: false,
      reason:
        `These challans belong to ${keys.size} different customers ` +
        `(${[...keys.values()].join(", ")}). One invoice bills one customer.`,
      customers: [...keys.values()],
      alreadyInvoiced: [],
    };
  }

  return { ok: true, reason: null, customers: [...keys.values()], alreadyInvoiced: [] };
}

module.exports = {
  normaliseProduct,
  variantLabel,
  lineKey,
  challanProductLines,
  challanSummary,
  challanParty,
  selectionGuard,
  indexProformaItems,
  dispatchRollup,
};
