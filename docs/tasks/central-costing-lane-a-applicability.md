# CENTRAL COSTING LANE A — "DOES NOT APPLY", RELOCATED (8 Sep 2026)

## The product rule this implements

> Central Costing does not decide whether a business fact applies. Each
> department records the applicability of the fact it owns, and Central Costing
> consumes that decision read-only. Missing information is never equivalent to
> "not applicable", and a family that is inherently required has no escape.

## The audit, family by family

| Family | Can it genuinely be inapplicable? | Who owns that decision | Source record & screen | Did an explicit source decision already exist? | Did Costing override or duplicate it? | What changed |
|---|---|---|---|---|---|---|
| **Materials** | **No.** A garment is made of something; a blank BOM is unfinished work. There is no registered-product costing context in this repository — `ENQUIRY_STYLE` and `ADHOC` are the only two — so no legitimate workflow reaches costing without a technical record. | nobody | `SampleStyle.materials.rawItems` → approved `techSheet.technical.materials` (R&D) | n/a | **Duplicated as an escape.** `CoverageDecisions` offered "Mark not applicable" on it. | Escape removed. No owner in the table; a decision naming it is refused at the payload and dropped by `assess`. |
| **Packaging** | **Yes** — the customer supplies it, or the goods ship loose. | **Merchandising** (they choose the components) | `materials.packagingSelections` → Merchandising · Style · Packaging components | **No.** Only an empty list, and row-level `included`/`excludedReason`. | **Owned it.** Answerable only by a Costing acknowledgement. | New `materials.packagingDecision`; `PUT /:id/packaging-decision`; control on the Merchandising style page. |
| **Operations** | **No.** A blank Route & SAM is missing Production work. Fully-outsourced manufacture would need a Production-owned manufacturing-method decision **and** the matching external service requirement; the repository records neither, and this task does not invent them. | nobody | `techSheet.technical.operations` (Production, via `styleRoute.service`) | n/a | **Duplicated as an escape.** | Escape removed. |
| **Outside services** | **Yes** — cut, made and finished in-house. | **Production** (the only door to the `OUTSIDE_PROCESS` rows) | `sample.serviceRequirements[purpose=OUTSIDE_PROCESS]` → Production · Style · Outside processes | **No — and the hypothesis was wrong here.** `sourceAppRequirements` returned `NOT_APPLICABLE` on an *empty list*, which is inference, not a decision. | **Owned it,** and inferred it elsewhere. | New `sample.outsideProcessDecision`; `PUT /styles/:id/outside-processes/decision`; control on `StyleRoutePanel`. The empty-list inference is retired — it now reports `AWAITING_OTHER_DEPARTMENT` naming Production. |
| **Freight** | **Yes, and it already is** — but as a *line*, not a family escape. | **Sales** | `Enquiry` delivery terms → `freight.service` | **Yes.** `ex_works`/`to_pay` produce a `RECORDED_ZERO` line with the arrangement on it. | **Duplicated it,** with a special-case guard refusing the acknowledgement on a delivered order. | No family owner at all. The guard is gone because the thing it guarded against cannot be sent. |
| **Customs duty & non-recoverable tax** | **Partly.** Store's `DOMESTIC` evidence answers *customs*. GST is a separate question. | **Store / Purchase** (customs) + the Board's GST policy | `SupplierOffer.sourcing.type` per material → Store · Supplier quotations | **Yes — `sourcingEvidence.rollUp` → `NOT_APPLICABLE`. Built, and read by nobody in Costing.** | **Owned it entirely.** Duty was `AWAITING_SOURCE`; every fixture in the repository answered it with a typed acknowledgement. | Now read. Resolves `NOT_APPLICABLE` only when **both** Store says all-domestic **and** an input-GST treatment is in force — one decision must not erase two tax questions. No duty-rate table was built. |
| **Financing** | **Yes, and it already is** — as a nil line with Sales' reason on it. | **Sales** | `Enquiry.paymentTerms.notApplicable` + reason → `financing.service` | **Yes,** with a compulsory reason. | **Duplicated it.** | No family owner. A 100% advance or zero credit days remains a *recorded zero*, not "not applicable". |
| **Development / tooling** | **Yes** — a repeat style whose pattern and screens exist. | **Merchandising** (`styleDevelopment.service` is the door) | `sample.serviceRequirements[purpose=DEVELOPMENT_TOOLING]` → Merchandising · Style · Development | **No.** Only an empty list; row-level exclusions exist and are a narrower fact. | **Owned it.** | New `sample.developmentDecision`; `PUT /merchandising/styles/:id/development/decision`; control on the Merchandising style page. Row-level exclusions preserved. |
| **Overhead** | **No.** The Board's rate, including an approved zero. | Board (Lane B) | `BoardPolicy` OVERHEAD | n/a | **Duplicated as an escape.** | Escape removed. Lane B's files untouched. |
| **Labour** | **No.** Production supplies the operations, the Board the methodology. | Production + Board (Lane B) | operations + `BoardPolicy` LABOUR_METHODOLOGY | n/a | Folded into `operations`. | No Costing-level escape. |

### Corrections to the starting hypothesis

* **Outside services** — "Production already states whether anything is sent
  outside" was not true. What existed was an empty-list inference in the
  readiness projection, which is precisely the "missing = not applicable"
  defect. An explicit state was added, and the inference removed.
* **Duty** — "Store's explicit domestic/import decision answers customs
  applicability" was true, and the decision was *already recorded and already
  correct*. Nothing in Costing read it.
* **Freight and financing** need no family-level decision at all: both already
  produce an answer as a LINE, which is a stronger record than an exclusion.

## What was removed from Costing

| Removed | Where it lived |
|---|---|
| `technicalAcknowledgements` parsing | `calculationInput.parseAcknowledgements` → `refuseAcknowledgements` |
| `assemble`/`assembleLines` acknowledgement parameter | `assembly.service` |
| the freight `ACKNOWLEDGEMENT_REFUSED` guard | `assembly.applyFreight` — unreachable once nothing can send one |
| `freezeAcknowledgements` | `versionCreation` → `freezeApplicabilityDecisions` |
| `technicalSource.UNRESOLVED` + `resolveUnresolved` | the second checklist over three families that now have records, plus `embellishment`, which had no record, no department and no family |
| `CompleteTechnical` and `CoverageDecisions` panels | `CostingWorkspace` |
| `groupStates`, `acknowledge`, `unacknowledge`, `acknowledgementsToWire`, `GROUP_FORM`, `usableLine` | `technicalImport.js` |

## The tamper-refusal contract

```
POST /api/costings/:id/versions   { technicalAcknowledgements: [...] }
→ 400 COSTING_APPLICABILITY_DECISION_MOVED
  details: {
    field: "technicalAcknowledgements",
    reason: "APPLICABILITY_DECISION_MOVED_TO_SOURCE",
    keys: [...],
    owners: {
      packaging: { department: "Merchandising", recordedIn: "Style · Packaging components" },
      materials: { department: null, recordedIn: null, inherentlyRequired: true },
    },
  }
```

An empty list is refused too. Nothing is silently stripped: dropping it would
calculate from whatever the departments had decided while the person who
pressed Calculate believed they had excluded something else — a version that is
right and unexplainable.

## Historical behaviour

Versions frozen while Costing owned the decision keep their `MANUAL_ENTRY`
`not-applicable:<group>` source references, their `NOT_APPLICABLE` family
states, and the actor, timestamp and reason on each. Nothing is recalculated or
reinterpreted on read. `GROUP_STATE.NOT_APPLICABLE` and its label survive for
exactly that reason. A new decision freezes as `DEPARTMENT_DECISION` instead,
with the department and the record named — and dated when the *department*
decided, not when somebody pressed Calculate.

## Every interactive action left inside Costing

1. Choose which technical record (style) a costing is for, where a product has
   several.
2. Set the run-size scenarios, their units, and a proposed selling price per
   scenario.
3. Add a note.
4. Calculate a new version.
5. Submit for review, and approve or reject with a reason.
6. Import a historical Sales costing sheet (migration route, own capability).

No figure, no rate, no quantity, no supplier and no applicability decision.

## Next smallest Lane A task

**A Production-owned manufacturing-method decision**, if — and only if — fully
outsourced garment manufacture is a business case the company actually has. It
is the one family in the table above whose "no escape" answer rests on the
repository recording nothing, rather than on the fact being inherently
required. It needs a product decision before any code.
