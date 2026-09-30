// services/requests/budgetGate.js
//
// IS BUDGET PART OF RAISING A REQUEST?  (30 Sep 2026)
//
// One switch, read here and nowhere else, so the Requests desk and the Store
// agree. The owner asked for the budget concept to leave the Store side
// entirely — "remove this budget restriction and interface / messages and all"
// — and the request form reached from the Store's service master is where it
// showed up next: a required "Budget head" and "Planned item", "No approved
// budget heads for this department", "Choose the budget head this comes out
// of", and a "Proposed budget head" line on the prefill.
//
// It is the SAME variable the material setup verdict already honours
// (`services/inventory/materialSetup.service.js`): `STORE_BUDGET_SETUP=1`
// brings the whole thing back — the chooser, the approver's head panel, the
// classification gate, the purchase door's head requirement and the
// over-budget exception — without touching a document. Unset, a request is
// raised, approved, classified and turned into a spend request with no head;
// the spend request is recorded exactly as an unbudgeted one already was
// (`spendRequestCreate.matchBudget` with no ledger → status none), so finance
// still sees and approves it, and nothing is charged to a head nobody chose.
//
// Requests raised while budget was ON keep their head and are read as before.

function budgetEnabled() {
  return process.env.STORE_BUDGET_SETUP === "1";
}

module.exports = { budgetEnabled };
