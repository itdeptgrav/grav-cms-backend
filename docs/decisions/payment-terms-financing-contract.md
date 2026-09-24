# Payment terms and the financing calculation

**Status:** in force. Confirmed by inspection and by
`test/sales/payment-terms-financing-contract.test.js` (16 tests), 24 Sep 2026.

This records a contract that already holds in the code. Nothing in the
calculation chain was changed to write it; the correction was in the Sales UI,
which had grown a second, unusable payment model beside it.

## The calculation

Central Costing works the cost of money on an order as

```
financing = basis × financed share × annual rate × credit days ÷ day-count basis
```

`services/centralCosting/financing.service.js` computes the effective percent
(`rate × share × days ÷ dayCount`) and the engine multiplies it by the basis as
an ordinary `PERCENT_OF_BASIS` line. The string
`"basis x financed share x annual rate x credit days / day-count basis"` is
stored on every computed version, so a figure can be checked by hand a year
later without reading this file.

Who owns each input:

| Input | Owner | Where it comes from |
|---|---|---|
| `basis` | Board | `BoardPolicy.financing.basis` |
| `annual rate` | Board | `BoardPolicy.financing.annualRatePercent` |
| `day-count basis` | Board | `BoardPolicy.financing.dayCountBasis` (365 or 360) |
| advance treatment | Board | `BoardPolicy.financing.advanceTreatment` |
| `advancePercent` | Sales | the **confirmed Enquiry** payment terms |
| `creditDays` | Sales | the **confirmed Enquiry** payment terms |

The policy is resolved **as of the costing's date**, not as of now.

`financed share` is `(100 − advancePercent) / 100` when the Board's methodology
says an advance reduces the financed amount, and `1` when it says the advance is
ignored. Sales never enters a rate.

## What costing may read

**Only the confirmed Enquiry snapshot.** `paymentTermsResolution.projectionFor`
returns figures only when the terms are `CONFIRMED`, and
`financing.compute` refuses to calculate otherwise. There is no account
fallback: an unconfirmed enquiry is *unanswered*, and an unanswered question is
reported as missing — never as an order that costs nothing to finance.

**Never free text.** `paymentTermsCode` ("NET30") and `negotiatedTerms` are
prose a person wrote. They are carried for people to read and are never parsed
into a duration. A figure somebody is charged for is never inferred from a
sentence.

**Never a payment schedule.** See below.

## The Account is a default, and it is copied

1. The Account holds what the customer *usually* agrees:
   `paymentTermsShape`, `advancePercent`, `creditDays`, `creditDaysFrom`,
   `negotiatedTerms`.
2. An Enquiry is **offered** those terms (`GET /enquiries/:id/commercial-defaults`).
   Reading the offer writes nothing.
3. Sales may accept them or agree something different for this one order.
4. Confirming **copies the figures onto the Enquiry** and stamps `source`
   (`ACCOUNT` or `ENQUIRY`), `confirmedAt`, `confirmedBy`, and
   `accountDefaultAtConfirmation` — a by-value snapshot of what the Account said
   at that moment, so an override stays auditable as a *difference* after the
   Account moves again.
5. Costing reads that snapshot and nothing else.

A customer renegotiating in November therefore cannot silently restate what an
order quoted in March was costed on. Editing confirmed terms re-opens them:
the old confirmation is not kept against new numbers.

## Agreed terms are not money received

`advancePercent` is **"advance required"** — what the customer undertook to pay.
Whether it arrived is Finance's record, kept elsewhere. No field on the Account
or the Enquiry is labelled received, collected or paid, and no screen in this
chain may imply it.

## The payment schedule is presentation, not financing

`Customer.paymentTerms.schedule` is a list of `{name, percentage}` rows —
"Advance Payment 60% / Final Payment 40%". It carries **no timing**, so it can
never produce a credit period: "Final Payment 40%" is 40% due before dispatch,
or on delivery, or 30 days after the invoice, and those are three different
agreements costing three different amounts to finance.

It is **retained**, because it is load-bearing for documents: it seeds a new
proforma's milestone rows (`QuotationPopup`), and those rows print on the
customer's PDF and in two customer emails. Deleting it would put every customer
back on a hardcoded 60/40 split on documents that leave the building.

It is **not** a financing input, is labelled as presentation in the UI, and no
row label is ever translated into a financing figure.

`Customer.paymentTerms.notes` is a genuinely dead contract: nothing reads it,
and the screen's claim that it printed on the PI was never true (the PI seeds
its terms from a hardcoded literal). It has been removed from the Sales UI.

## Multiple timed instalments

Supporting "20% with the order, 30% on fabric approval, balance 30 days after
invoice" properly requires each tranche to carry its own percentage, due
milestone and offset days, and a weighted financing duration across them. That
is a separate model and a separate piece of work. The label-and-percentage rows
are **not** a cheap version of it and must not be read as one.
