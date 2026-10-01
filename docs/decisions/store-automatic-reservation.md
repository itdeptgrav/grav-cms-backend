# Automatic stock reservation on approval

**Status:** implemented, uncommitted · **Lane A** · 28 Sep 2026

## The decision

Approving a material request now **attempts to hold the stock for it**. The
store no longer opens a drawer and types quantities the server could compute.

Picking and issuing stay manual, and always will: they are claims about the
physical world — somebody walked to the rack, somebody handed the material over
— and the server cannot witness either.

## Why

"Ready to reserve" was the largest group in the fulfilment queue, and it was a
queue of arithmetic. Every approved request sat there waiting for a person to
choose the locations the server would have chosen, and a request nobody had got
to was indistinguishable from one with no stock behind it. Those are opposite
facts and they looked the same.

## The trigger

One service — `services/storePurchase/autoReservation.service.js` — and every
approval path calls it. Nothing allocates stock anywhere else.

| Door | Where | Trigger |
|---|---|---|
| TL/PM approval | `coworkMrfRoutes` `PATCH /:id/tl-approve` | `TL_APPROVED` |
| Auto-forwarded creation (AUTO_STORE route) | `coworkMrfRoutes` `POST /` | `AUTO_FORWARDED` |
| Auto-forwarded creation (store side) | `mrfRoutes` `POST /` | `AUTO_FORWARDED` |
| Store raises on behalf | `mrfRoutes` `POST /bypass` | `STORE_ON_BEHALF` |
| Requests desk classifies to stock | `intakeRequests` `spawnMrf` (both branches) | `INTAKE_CLASSIFIED` |
| A line is matched or registered after approval | `mrfRoutes` `PATCH /:id/items/:itemId/match` and `/register` | `LINE_MATCHED` |
| The store asks again | `mrfRoutes` `POST /:id/auto-reserve` | `MANUAL_RETRY` |

Called **after** the approval's own commit, never inside it. An approval that
succeeded is a decision a person made; failing to hold stock for it is a store
problem to show and retry, not a reason to un-approve. `attemptForRequest`
resolves on every path and never throws into a caller.

`auto-reservation.coverage.test.js` enumerates the files that construct an MRF
and asserts the set is exactly these three, so a fourth approval path added
later fails the build rather than silently reserving nothing.

## Eligibility

A line is a candidate only when it is approved, matched to a catalogue item,
still owed, not a service/buy line, and carries a usable quantity and unit.

Stock is eligible only at an **active `USABLE_STOCK` location in an active
warehouse of this company**. Receiving, inspection, quarantine, returns, scrap,
inactive locations and the unassigned sentinel are never reserved from — that
rule is `reservation.service.usableLocationsOf`, reused, not restated.

## Ownership fails closed

`RawItem.ownership` is a property of a **movement**, not of a location balance,
so a location's on-hand carries no ownership of its own. Customer-owned stock is
attributed through `CustomerMaterialLot.locationId`, and
`customerOwnedReserve.heldFor()` is the one authority for how much of a shelf is
not ours.

Two rules follow, and both are asserted:

1. **The customer's share is subtracted at reservation time.** That guard
   already existed at *issue*, in the shared stock-out helper — which fires when
   the material is picked and somebody is at the counter. Automatic reservation
   would otherwise hold a customer's fabric hours earlier and be refused at the
   last step.
2. **A customer lot with stock available and no `locationId` stops the line.**
   The material is somewhere and nothing says where. Subtracting it from no
   location lets an automatic hold take it; subtracting it from every location
   refuses holds that are fine. Neither is honest, so the line becomes
   `ATTENTION` with the reason `OWNERSHIP_UNPROVEN`.

## Allocation

The candidate order is `reservation.service.orderedCandidates`, unchanged: the
requested warehouse first, then every usable location by warehouse short name
and location code — so a store user checking the server's work sees their own
list in their own order.

A line that names a warehouse allocates **only** within it. Ranking alone would
let an alphabetically-earlier warehouse win once the named one ran out, which
silently overrides a requester who said where the material must come from.

> `MRF.items.warehouseId` did not exist before this change, although the
> availability read and the manual reserve drawer had both been passing
> `line.warehouseId` as their preferred warehouse since reservations were built.
> Mongoose dropped it on every write, so the preference was always null. The
> field is now declared, which makes that existing code mean what it says.

Never more than the line still needs. The remainder, not the shelf.

## The five outcomes

| Outcome | Means | Queue stage |
|---|---|---|
| `RESERVED` | the whole quantity is held | Ready to pick |
| `PARTIAL` | some held, an exact remainder short | Partly reserved |
| `SHORT` | looked, and nothing eligible | Short |
| `SKIPPED` | not a line automatic reservation is for | not in the queue |
| `ATTENTION` | unsafe or ambiguous | Needs attention |

**`SHORT` and `ATTENTION` are never merged.** "The shelf is empty" is a
purchasing instruction; "we could not safely tell" is a data problem. Showing
the second as the first raises purchases nobody asked for.

**A line with no attempt record is `NEEDS_ATTENTION`, not `SHORT`.** Requests
approved before this existed have `autoReserve.attemptedAt === null`, and the
shelf behind them may be full. They carry a *Try automatic reservation* action.

## Reservation is not a movement

On-hand, `LocationBalance`, `LocationMovement` and the stock ledger are
untouched by every path here. A hold is a live record. `auto-reservation.test.js`
asserts this by counting movements before and after.

## Ownership of the shortfall

Automatic reservation raises **no purchase document of any kind** and commits no
budget. A short quantity stays a figure on the approved request and continues
through the existing chain: approved MRF → approved purchase request → sourcing
→ PO. The MRF remains the source of the need, the department, the required date,
the budget ownership and the shortfall.

## Where the work lives

The fulfilment queue moved to **Requests**
(`/store/dashboard/order-requests`) — the same people approve, match, pick and
issue, and they should not change page between those acts.
`/store/dashboard/operations/reservations` still works and is a thin wrapper
over the same component (`components/store/reservations/FulfilmentQueue`), not a
second copy.

Manual allocation is **not deleted**. `nextAction` returns it only where trying
again cannot help — an unplaceable customer lot, a missing conversion, a
warehouse that cannot answer — and it is gated on the approver role, because
choosing stock by hand overrides a refusal the server made on purpose.

## Audit

Every attempt is recorded on the line in `MRF.items.autoReserve`: when, which
trigger, which actor, the outcome, the machine-readable reason, the quantity
held and the quantity short, and how many attempts there have been. The chosen
locations and quantities are on the `StockReservation` the attempt created,
which stays the one authority for what is held — they are not duplicated.

An automatic hold with no human behind it is recorded against the `system` actor
type the action-history schema already defines, rather than borrowing a person's
id to satisfy a validator.
