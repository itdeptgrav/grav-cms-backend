// services/personRoster.js
//
// WHO a measurement order's line is for.
//
// ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────────────
// Converting a drive collapses per-person garments into product totals, so a
// line reads "F&B Service Shirt · Size 30 · qty 12 · ₹10,873.80". That is the
// right commercial shape — nobody wants a 300-line invoice — but it is where
// person identity died. The PO, the quotation and all 143 work orders carry
// product, variant and quantity, and not one carries an employee. So
// "did we make, or bill, Ramesh's uniform?" could only be answered by opening
// the drive and guessing by size, which stops working the moment two people
// share a size. Somebody had already hit this and built a CSV export
// (`po-persons-export`) to work around it.
//
// ── THE SHAPE ───────────────────────────────────────────────────────────────
// AGGREGATE FOR PRICE, ITEMISE FOR TRACEABILITY. The line keeps its single
// quantity and its single price; a roster of the people that quantity is made
// of rides alongside it. Same money, same invoice, but the question becomes a
// query instead of an excavation.
//
// Pure: callers pass the already-loaded employee measurements. No database, so
// the aggregation is testable on its own — which matters, because a roster that
// silently disagrees with the quantity beside it is worse than no roster.

const idOf = (v) => (v && v._id ? String(v._id) : v ? String(v) : "");

/**
 * Build the person roster for one variant line.
 *
 * @param {Array} entries  [{ employee, quantity }] contributing to this line
 * @returns {Array} [{ employeeId, employeeUIN, employeeName, department, designation, quantity }]
 */
function rosterFor(entries = []) {
  const byPerson = new Map();
  for (const { employee, quantity } of entries) {
    if (!employee) continue;
    const key = idOf(employee.employeeId) || employee.employeeUIN || employee.employeeName;
    if (!key) continue;
    // One row per person even when they take two of the same garment — the
    // quantity accumulates rather than the person appearing twice, so
    // roster.length is always "how many people", which is what it looks like.
    if (!byPerson.has(key)) {
      byPerson.set(key, {
        employeeId: idOf(employee.employeeId) || null,
        employeeUIN: employee.employeeUIN || "",
        employeeName: employee.employeeName || "",
        department: employee.department || "",
        designation: employee.designation || "",
        quantity: 0,
      });
    }
    byPerson.get(key).quantity += Number(quantity) || 0;
  }
  // Stable order so a re-conversion produces an identical document and diffs
  // stay readable: by UIN, which is the customer's own identifier for a person.
  return [...byPerson.values()].sort((a, b) =>
    String(a.employeeUIN).localeCompare(String(b.employeeUIN), undefined, { numeric: true }),
  );
}

/**
 * Does a roster agree with the line it is attached to?
 *
 * Called before the order is written. A roster whose quantities do not add up
 * to the line's quantity is a silent billing discrepancy — the invoice says 12
 * and the people say 11 — and is far more dangerous than having no roster at
 * all, because it looks authoritative.
 */
function rosterAgrees(roster = [], lineQuantity) {
  const summed = roster.reduce((n, r) => n + (Number(r.quantity) || 0), 0);
  return summed === Number(lineQuantity);
}

/**
 * Everyone on an order, across all its lines — the answer to "is Ramesh on
 * this order at all, and for what".
 */
function personsOnOrder(items = []) {
  const byPerson = new Map();
  for (const item of items || []) {
    for (const variant of item.variants || []) {
      for (const p of variant.persons || []) {
        const key = p.employeeUIN || p.employeeId || p.employeeName;
        if (!key) continue;
        if (!byPerson.has(key)) {
          byPerson.set(key, {
            employeeId: p.employeeId || null,
            employeeUIN: p.employeeUIN || "",
            employeeName: p.employeeName || "",
            department: p.department || "",
            garments: [],
            totalQuantity: 0,
          });
        }
        const row = byPerson.get(key);
        row.garments.push({
          stockItemId: idOf(item.stockItemId),
          stockItemName: item.stockItemName || "",
          variantId: variant.variantId || null,
          attributes: variant.attributes || [],
          quantity: p.quantity,
        });
        row.totalQuantity += Number(p.quantity) || 0;
      }
    }
  }
  return [...byPerson.values()].sort((a, b) =>
    String(a.employeeUIN).localeCompare(String(b.employeeUIN), undefined, { numeric: true }),
  );
}

module.exports = { rosterFor, rosterAgrees, personsOnOrder };
