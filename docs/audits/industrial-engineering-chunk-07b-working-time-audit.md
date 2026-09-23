# IE Chunk 7B — working-time authority source audit

**Date:** 10 September 2026. **Verdict: no safe authoritative working-time
contract exists.** Calendar integration stays blocked on a missing upstream
contract. The configured ramp assumption is independently safe and IE-owned, and
is the only thing Chunk 7B implements.

This audit was re-run against current code rather than inherited from Chunk 7A.
Nothing has been added by another lane since: `WorkingCalendar.js` was last
changed on 9 September in commit `442513c` and still carries no shift, break or
minute vocabulary; `ProductionSchedule` still has zero occurrences of
`companyId`; `Attendance` and `Dailyattendance` likewise. One candidate the 7A
audit had not named individually — `HR_Models/Attendancesettings.js` — was found
and assessed here for the first time.

## Field-by-field ownership

| Fact | Candidate source | Company scope | Lifecycle / version | Freezable reproducibly | Verdict | Reason |
|---|---|---|---|---|---|---|
| Acting company ownership | Merchandising `WorkingCalendar` | Yes — `companyId`, unique with `calendarRef` | Yes — `WorkingCalendarVersion` with `versionNo`, DRAFT/published, frozen on publish | Yes — id + `versionNo` | **Usable** | The one candidate with real tenancy and real versioning. |
| | `ProductionSchedule` | **No** — no `companyId` at all; `date` is globally unique | No | No | **Unsafe** | One document per calendar date for the whole platform. Two companies cannot both have a Tuesday. |
| | HR `AttendanceSettings` | **No** — `_id: "singleton"`, one document platform-wide | No | No | **Unsafe** | A hard-coded singleton cannot express one company's working time. |
| | HR `Attendance` / `Dailyattendance` | **No** | No | No | **Unsafe** | Per-employee rows, no tenancy. |
| Working date / calendar version | `WorkingCalendarVersion` | Yes | Yes — published versions are frozen by a `pre("save")` guard, and `horizonTo` refuses to answer past its horizon | Yes | **Usable** | Cite-able as `calendarId` + `versionNo`. |
| Shift duration | `ProductionSchedule.workHours.totalMinutes` | No | No | No | **Unsafe** | Right fact, wrong record: unscoped, unversioned, mutable in place, and part of Production's own booking document alongside `scheduledWorkOrders` and `isOverCapacity`. |
| | HR `AttendanceSettings.shifts.{operator,executive}.start/end` | No | No | No | **Unsafe** | A singleton attendance-grading policy — late grace, half-day thresholds, overtime grace. Read through a 15-second memo and back-filled with defaults on read. It grades attendance; it does not state a capacity standard. |
| | `WorkingCalendar` | Yes | Yes | Yes | **Unsafe for this fact** | Does not model it. Zero occurrences of shift, break or minutes in the schema. |
| Break duration | `ProductionSchedule.defaultBreaks[] / breaks[]` | No | No | No | **Unsafe** | Same record as above. |
| | Everything else | — | — | — | **Absent** | No other model holds a break duration as a standard. HR `Attendance` holds `breakMinutes` as an observed per-employee actual. |
| Shifts per day | — | — | — | — | **Absent** | No source models it anywhere. `ProductionSchedule` assumes exactly one day-shift per date. |
| Working days per week / dated pattern | `WorkingCalendarVersion.weekPattern` + `exceptions[]` | Yes | Yes | Yes | **Usable** | Seven booleans Monday-first, plus dated exceptions working in both directions. |
| Effective dates | `WorkingCalendarVersion.effectiveFrom` / `effectiveTo` / `horizonTo` | Yes | Yes | Yes | **Usable** | |
| Immutable / versioned provenance | `WorkingCalendarVersion` | Yes | Yes | Yes | **Usable** | A published version is frozen except `state`, `effectiveTo` and `retiredAt`. |
| | `ProductionSchedule`, `AttendanceSettings`, `Attendance` | No | No | No | **Unsafe** | None carries a revision, a version or an immutability guard. |
| Configured ramp / learning-curve stages | — | — | — | — | **Absent, and IE's to own** | Nothing in the repository models a ramp. The product plan places "learning-curve/ramp assumptions where configured" inside §5.6 Capacity Standard, which is IE's own record, and §Chunk 7 asks IE to "support target efficiency and configured ramp assumptions". A ramp is a stated engineering assumption with no dependency on another department. |

## Why the calendar is still not integrated

`WorkingCalendarVersion` is the only safe, versioned, company-scoped candidate,
and it is **partial**: it proves working days, effective dates and provenance,
and proves none of shift duration, break duration or shifts per day. Those three
are precisely the facts Chunk 7A's formula consumes. Working days per week enter
no Chunk 7A figure at all — the calculation is per shift and per day, never per
week or per period.

Integrating it would therefore add a cross-department dependency that supplies
nothing the calculation uses, while creating the impression that the working
time behind a target is calendar-proved when its three load-bearing numbers
would still be typed in by hand. It is also a Merchandising **deadline**
calendar, built to answer "twelve working days before delivery"; the accepted
Chunk 7A review already rejected reusing it on those grounds. Partial provenance
presented as provenance is worse than none, so `calendarLinkage.state` stays
`UNKNOWN`.

## The exact missing upstream contract

A company-scoped, versioned, publish-frozen **factory working-time standard**,
owned by whoever owns the factory calendar, exposing per effective period:

- `companyId`, a stable `workingTimeStandardId` and an immutable `versionNo`;
- gross shift duration in minutes, per shift;
- non-productive break minutes, per shift;
- shifts per day;
- optionally the working-day pattern, or a reference to a
  `WorkingCalendarVersion` that already proves it;
- `effectiveFrom` / `effectiveTo`, and a horizon past which it refuses to answer;
- a published version frozen against edits, so a later change cannot rewrite a
  capacity standard already calculated against it.

Until such a record exists and is owned by an accountable department, IE states
its working time as an explicitly labelled `IE_PLANNING_ASSUMPTION` and reports
the calendar linkage as unknown.
