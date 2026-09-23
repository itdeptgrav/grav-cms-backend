# HR endpoint / capability matrix

> **Generated.** `node scripts/hrRouteInventory.js --markdown > docs/audits/hr-endpoint-capability-matrix.md`
>
> Source of truth: `services/access/hrRouteContract.js` (declarations)
> and `services/access/hrMountRegistry.js` (mounted routers).

322 mounted routes across 38 mount prefixes, 322 declarations, 0 undeclared.

Columns: **Protected** marks a response that can carry private, compensation,
statutory-identifier, medical or case data. **Scope** is `hr` (inside the HR
application — global today, see the Chunk 2 note), `self`, `manager` or
`public`.

## `/api/ceo/hr`

Router: `./routes/CEO_Routes/hr`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| GET | `/api/ceo/hr/attendance/daily` | `hr.access`<br>`attendance.read` | hr |  | management |
| GET | `/api/ceo/hr/attendance/departments` | `hr.access`<br>`attendance.read` | hr |  | management |
| GET | `/api/ceo/hr/attendance/export` | `hr.access`<br>`attendance.read`<br>`analytics.workforce` | hr |  | management |
| GET | `/api/ceo/hr/attendance/muster-roll` | `hr.access`<br>`attendance.read` | hr |  | management |
| GET | `/api/ceo/hr/attendance/summary` | `hr.access`<br>`attendance.read` | hr |  | management |
| POST | `/api/ceo/hr/attendance/sync` | `hr.access`<br>`attendance.close` | hr |  | attendance approver — NOT management |
| GET | `/api/ceo/hr/departments` | `hr.access`<br>`people.read.directory` | hr |  | management |
| GET | `/api/ceo/hr/employees` | `hr.access`<br>`people.read.directory` | hr |  | management |
| GET | `/api/ceo/hr/employees/:id` | `hr.access`<br>`people.read.directory` | hr |  | management |
| GET | `/api/ceo/hr/employees/:id/sop-points` | `hr.access`<br>`skills.read` | hr | yes | management |

Notes:

- `POST /api/ceo/hr/attendance/sync` — The only non-GET under /api/ceo/hr. It is declared with the attendance CLOSE capability, which the CEO projection template does not hold, so the projection stays read-only. Nothing breaks: the handler proxies to `/hr/attendance/sync`, a path that does not exist (the real one is /sync-period), so it has been answering the proxy's 404 since it shipped.

## `/api/employee`

Router: `./routes/Employee_Routes/employeeAuth`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| GET | `/api/employee/basic-info` | — | self |  | employee |
| PUT | `/api/employee/change-password` | — | self |  | employee |
| GET | `/api/employee/dashboard` | — | self |  | employee |
| GET | `/api/employee/profile` | — | self |  | employee |
| PUT | `/api/employee/profile` | — | self |  | employee |
| GET | `/api/employee/profile/edit` | — | self |  | employee |
| POST | `/api/employee/push-token` | — | self |  | employee app |
| DELETE | `/api/employee/push-token` | — | self |  | employee app |
| GET | `/api/employee/push-token/debug` | — | self |  | employee app |
| GET | `/api/employee/salary` | — | self | yes | employee |
| POST | `/api/employee/test-web-push` | — | self |  | employee app |

Notes:

- `PUT /api/employee/change-password` — Own credentials. Never HR's approval queue.
- `GET /api/employee/salary` — The employee's OWN pay. Self-scope is the whole authority; no compensation capability is involved because it is their own figure.

## `/api/employee/absence-calendar`

Router: `./routes/Employee_Routes/absenceCalendar`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| GET | `/api/employee/absence-calendar` | — | self |  | employee |
| GET | `/api/employee/absence-calendar/day` | — | self |  | employee |

## `/api/employee/attendance`

Router: `./routes/Employee_Routes/employeeAttendance`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| GET | `/api/employee/attendance/monthly` | — | self |  | employee |
| POST | `/api/employee/attendance/sync-today` | — | self |  | employee |
| GET | `/api/employee/attendance/today` | — | self |  | employee |

## `/api/employee/auth`

Router: `./routes/Employee_Routes/login`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| POST | `/api/employee/auth/change-password` | — | public |  | employee app |
| POST | `/api/employee/auth/login` | — | public |  | employee app |
| POST | `/api/employee/auth/logout` | — | public |  | employee app |
| GET | `/api/employee/auth/profile` | — | public |  | employee app |
| GET | `/api/employee/auth/verify` | — | public |  | employee app |

Notes:

- `POST /api/employee/auth/change-password` — Router-authenticated; the employee's own credentials.
- `GET /api/employee/auth/profile` — Router-authenticated: it reads the app token itself and returns the caller's own record.
- `GET /api/employee/auth/verify` — Verifies the app's own token and answers about the caller only.

## `/api/employee/documents`

Router: `./routes/Employee_Routes/documents`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| GET | `/api/employee/documents` | — | self |  | employee |
| GET | `/api/employee/documents/:id` | — | self | yes | employee |
| PATCH | `/api/employee/documents/:id/cancel` | — | self |  | employee |
| GET | `/api/employee/documents/:id/download` | — | public |  | employee, via a short-lived signed link |
| GET | `/api/employee/documents/:id/file` | — | self | yes | employee |
| POST | `/api/employee/documents/requests` | — | self |  | employee |
| GET | `/api/employee/documents/types` | — | self |  | employee |

Notes:

- `GET /api/employee/documents/:id/download` — COMPATIBILITY: the download carries its own signed token instead of a session, so the browser can follow the link. The router verifies it and never projects an unreleased row.

## `/api/employee/leaderboard`

Router: `./routes/Employee_Routes/leaderboard`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| GET | `/api/employee/leaderboard` | — | self |  | employee |

Notes:

- `GET /api/employee/leaderboard` — Ranks on positive signal only; never a colleague's absence or SOP record.

## `/api/employee/leave-applications`

Router: `./routes/Employee_Routes/leaveRoutes`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| GET | `/api/employee/leave-applications` | — | self |  | employee |
| POST | `/api/employee/leave-applications` | — | self |  | employee |
| GET | `/api/employee/leave-applications/:id` | — | self | yes | employee |
| PUT | `/api/employee/leave-applications/:id` | — | self |  | employee |
| DELETE | `/api/employee/leave-applications/:id` | — | self |  | employee |
| PATCH | `/api/employee/leave-applications/:id/cancel` | — | self |  | employee |
| PATCH | `/api/employee/leave-applications/:id/cancel-withdraw` | — | self |  | employee |
| POST | `/api/employee/leave-applications/:id/upload-document` | — | self | yes | employee |
| GET | `/api/employee/leave-applications/balance` | — | self |  | employee |
| GET | `/api/employee/leave-applications/calendar` | — | self |  | employee |
| GET | `/api/employee/leave-applications/config` | — | self |  | employee |
| GET | `/api/employee/leave-applications/holidays` | — | self |  | employee |
| PATCH | `/api/employee/leave-applications/manager/:id/approve` | — | manager |  | manager |
| PATCH | `/api/employee/leave-applications/manager/:id/approve-withdraw` | — | manager |  | manager |
| PUT | `/api/employee/leave-applications/manager/:id/edit` | — | manager |  | manager |
| PATCH | `/api/employee/leave-applications/manager/:id/reject` | — | manager |  | manager |
| PATCH | `/api/employee/leave-applications/manager/:id/reject-withdraw` | — | manager |  | manager |
| POST | `/api/employee/leave-applications/manager/add-on-behalf` | — | manager |  | manager |
| GET | `/api/employee/leave-applications/manager/history` | — | manager |  | manager |
| GET | `/api/employee/leave-applications/manager/my-team` | — | manager |  | manager |
| GET | `/api/employee/leave-applications/manager/pending` | — | manager |  | manager |
| GET | `/api/employee/leave-applications/manager/withdraw-pending` | — | manager |  | manager |
| POST | `/api/employee/leave-applications/quick-apply` | — | self |  | employee |
| PATCH | `/api/employee/leave-applications/quick-apply/:id/resolve` | — | manager |  | manager |

Notes:

- `POST /api/employee/leave-applications/manager/add-on-behalf` — Takes an employeeId in the body and proves the reporting relationship against the stored primaryManager/secondaryManager before writing. That proof is the authority — the id in the body is not.

## `/api/employee/notification-settings`

Router: `./routes/Employee_Routes/notificationSettings`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| GET | `/api/employee/notification-settings` | — | self |  | employee app |
| PUT | `/api/employee/notification-settings/:deviceId` | — | self |  | employee app |
| DELETE | `/api/employee/notification-settings/:deviceId` | — | self |  | employee app |
| POST | `/api/employee/notification-settings/register` | — | self |  | employee app |

Notes:

- `PUT /api/employee/notification-settings/:deviceId` — The handler deletes/updates by an owner filter built from the token, so a device id belonging to somebody else answers 404 rather than being edited.

## `/api/employee/overtime`

Router: `./routes/Employee_Routes/Overtimeroutes`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| GET | `/api/employee/overtime/check` | — | self |  | employee |
| PATCH | `/api/employee/overtime/manager/:id/approve` | — | manager |  | manager |
| PATCH | `/api/employee/overtime/manager/:id/reject` | — | manager |  | manager |
| GET | `/api/employee/overtime/manager/pending` | — | manager |  | manager |
| GET | `/api/employee/overtime/my` | — | self |  | employee |
| POST | `/api/employee/overtime/submit` | — | self |  | employee |

## `/api/employee/payslip`

Router: `./routes/Employee_Routes/Payslip`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| GET | `/api/employee/payslip/:employeeId` | — | self | yes | employee |
| GET | `/api/employee/payslip/:employeeId/history` | — | self | yes | employee |
| GET | `/api/employee/payslip/:employeeId/pdf` | — | self | yes | employee |
| GET | `/api/employee/payslip/employees` | — | self |  | employee |

## `/api/employee/performance`

Router: `./routes/Employee_Routes/performance`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| GET | `/api/employee/performance` | — | self |  | employee |

## `/api/employee/regularizations`

Router: `./routes/Employee_Routes/regularization`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| GET | `/api/employee/regularizations` | — | self |  | employee |
| POST | `/api/employee/regularizations` | — | self |  | employee |
| PATCH | `/api/employee/regularizations/:id/cancel` | — | self |  | employee |
| PATCH | `/api/employee/regularizations/manager/:id/approve` | — | manager |  | manager |
| PATCH | `/api/employee/regularizations/manager/:id/reject` | — | manager |  | manager |
| GET | `/api/employee/regularizations/manager/history` | — | manager |  | manager |
| GET | `/api/employee/regularizations/manager/pending` | — | manager |  | manager |

## `/api/employee/tasks`

Router: `./routes/Employee_Routes/TasksEmployee`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| POST | `/api/employee/tasks/:taskId/feedback` | — | self |  | employee app |
| GET | `/api/employee/tasks/debug/all-tasks` | — | self |  | employee app |
| GET | `/api/employee/tasks/debug/user-info` | — | self |  | employee app |
| GET | `/api/employee/tasks/my-tasks` | — | self |  | employee app |
| GET | `/api/employee/tasks/task/:taskId` | — | self |  | employee app |
| PATCH | `/api/employee/tasks/task/:taskId/status` | — | self |  | employee app |

## `/api/employees`

Router: `./routes/HrRoutes/Employee-Section`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| POST | `/api/employees` | `hr.access`<br>`people.write` | hr | yes | HR editor |
| PUT | `/api/employees/:id` | `hr.access`<br>`people.write` | hr | yes | HR editor |
| GET | `/api/employees/:id` | `hr.access`<br>`people.read.private` | hr | yes | HR operations |
| DELETE | `/api/employees/:id` | `hr.access`<br>`people.write`<br>`employment.change` | hr | yes | HR editor |
| GET | `/api/employees/:id/details` | `hr.access`<br>`people.read.private` | hr | yes | HR operations |
| PATCH | `/api/employees/:id/documents` | `hr.access`<br>`people.write`<br>`people.read.identifiers` | hr | yes | HR editor |
| PATCH | `/api/employees/:id/profile-photo` | `hr.access`<br>`people.write` | hr |  | HR editor |
| GET | `/api/employees/all` | `hr.access`<br>`people.read.directory` | hr |  | any HR user |
| PATCH | `/api/employees/bulk-update` | `hr.access`<br>`people.write` | hr | yes | HR editor |
| GET | `/api/employees/config/form-visibility` | `hr.access`<br>`people.read.directory` | hr |  | HR operations |
| GET | `/api/employees/config/salary` | `hr.access`<br>`compensation.read` | hr | yes | payroll preparer / approver |
| PUT | `/api/employees/config/salary` | `hr.access`<br>`compensation.write` | hr | yes | HR owner |
| POST | `/api/employees/config/salary/preview` | `hr.access`<br>`compensation.read` | hr | yes | payroll preparer |
| GET | `/api/employees/department/employees` | `hr.access`<br>`people.read.directory` | hr |  | any HR user |
| GET | `/api/employees/history` | `hr.access`<br>`audit.read` | hr | yes | HR operations |
| GET | `/api/employees/team-structure` | `hr.access`<br>`people.read.directory` | hr |  | any HR user |

Notes:

- `GET /api/employees/:id` — The full employee record. Compensation, banking, statutory identifiers and medical fields are added back one at a time by the field projection, each behind its own capability.
- `PATCH /api/employees/:id/documents` — Writes the `documents` sub-document, which holds the government identifiers as well as the uploaded files — so it needs the identifier capability, not only people.write.
- `PATCH /api/employees/:id/profile-photo` — HR changing SOMEBODY ELSE'S photo. Deliberately not a self-service write — see the exemption note in server.js.
- `GET /api/employees/all` — The roster every HR screen opens with. Directory class only — the projection strips compensation, banking, statutory identifiers and medical fields even though the underlying query has historically selected the whole document.
- `GET /api/employees/config/salary` — The salary RULES, not one person's pay — but the rules disclose the company's pay structure, so they ride the compensation capability.

## `/api/employees/import-export`

Router: `./routes/HrRoutes/employeeImportExport`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| GET | `/api/employees/import-export/export` | `hr.access`<br>`people.read.private`<br>`people.read.identifiers`<br>`compensation.read` | hr | yes | HR approver / owner |
| POST | `/api/employees/import-export/import/confirm` | `hr.access`<br>`people.write`<br>`employment.change`<br>`compensation.write` | hr | yes | HR owner |
| POST | `/api/employees/import-export/import/preview` | `hr.access`<br>`people.write` | hr | yes | HR editor |
| GET | `/api/employees/import-export/template` | `hr.access`<br>`people.write` | hr |  | HR editor |

Notes:

- `GET /api/employees/import-export/export` — A full workforce export carries pay and statutory identifiers in a file that leaves the building. It needs every capability the fields inside it need, not just people.read.
- `POST /api/employees/import-export/import/confirm` — The importer writes salary columns, so it needs compensation.write as well as people.write. Exempt from the approval queue because a spreadsheet exceeds what a held request can store — which is precisely why the capability bar is higher.

## `/api/hr`

Router: `./routes/HrRoutes/HrProfile-Section`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| PUT | `/api/hr/change-password` | — | self |  | any signed-in account |
| GET | `/api/hr/profile` | — | self |  | any signed-in account |
| PUT | `/api/hr/profile` | — | self |  | any signed-in account |

Notes:

- `PUT /api/hr/change-password` — Changing YOUR OWN password. No HR capability, no approval queue — required behaviour, and the reason server.js exempts this exact path from the write guard.

## `/api/hr/app`

Router: `./routes/HrRoutes/Appversionroutes`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| GET | `/api/hr/app/download/:id` | — | public |  | the employee mobile app |
| GET | `/api/hr/app/latest` | — | public |  | the employee mobile app |
| POST | `/api/hr/app/upload` | `hr.access`<br>`hr.configuration.manage` | hr |  | HR owner |
| GET | `/api/hr/app/versions` | `hr.access`<br>`hr.configuration.manage` | hr |  | HR owner |
| DELETE | `/api/hr/app/versions/:id` | `hr.access`<br>`hr.configuration.manage` | hr |  | HR owner |
| PATCH | `/api/hr/app/versions/:id/set-latest` | `hr.access`<br>`hr.configuration.manage` | hr |  | HR owner |

Notes:

- `GET /api/hr/app/latest` — The app's own update check, called before anybody signs in.

## `/api/hr/candidates`

Router: `./routes/HrRoutes/Candidates_section`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| GET | `/api/hr/candidates/:jobId` | `hr.access`<br>`recruitment.read` | hr | yes | recruiter |
| POST | `/api/hr/candidates/:jobId/candidates` | `hr.access`<br>`recruitment.manage` | hr | yes | recruiter |
| DELETE | `/api/hr/candidates/:jobId/candidates/:candidateId` | `hr.access`<br>`recruitment.manage` | hr | yes | recruiter |
| GET | `/api/hr/candidates/:jobId/candidates/:candidateId` | `hr.access`<br>`recruitment.read` | hr | yes | recruiter |
| PUT | `/api/hr/candidates/:jobId/candidates/:candidateId` | `hr.access`<br>`recruitment.manage` | hr | yes | recruiter |
| PATCH | `/api/hr/candidates/:jobId/candidates/:candidateId/archive` | `hr.access`<br>`recruitment.manage` | hr |  | recruiter |
| GET | `/api/hr/candidates/:jobId/candidates/:candidateId/details` | `hr.access`<br>`recruitment.read` | hr | yes | recruiter |
| PATCH | `/api/hr/candidates/:jobId/candidates/:candidateId/questions` | `hr.access`<br>`recruitment.manage` | hr |  | recruiter |
| GET | `/api/hr/candidates/:jobPostingId/candidates/:candidateId/interviews` | `hr.access`<br>`recruitment.read` | hr | yes | recruiter |
| PATCH | `/api/hr/candidates/:jobPostingId/candidates/:candidateId/stage` | `hr.access`<br>`recruitment.manage` | hr |  | recruiter |

## `/api/hr/change-history`

Router: `./routes/HrRoutes/ChangeHistory`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| GET | `/api/hr/change-history` | `hr.access`<br>`audit.read` | hr | yes | HR operations |
| GET | `/api/hr/change-history/actors` | `hr.access`<br>`audit.read` | hr |  | HR operations |
| GET | `/api/hr/change-history/export` | `hr.access`<br>`audit.export` | hr | yes | HR approver |
| GET | `/api/hr/change-history/record/:entity/:entityId` | `hr.access`<br>`audit.read` | hr | yes | HR operations |
| GET | `/api/hr/change-history/sections` | `hr.access`<br>`audit.read` | hr |  | HR operations |
| GET | `/api/hr/change-history/stamps` | `hr.access`<br>`audit.read` | hr |  | HR operations |
| GET | `/api/hr/change-history/summary` | `hr.access`<br>`audit.read` | hr |  | HR operations |

Notes:

- `GET /api/hr/change-history/export` — Exporting the audit trail is its own authority — the file leaves the building and carries before/after values.

## `/api/hr/departments`

Router: `./routes/HrRoutes/Departments`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| POST | `/api/hr/departments` | `hr.access`<br>`hr.configuration.manage` | hr |  | HR owner |
| GET | `/api/hr/departments` | `hr.access`<br>`people.read.directory` | hr |  | any HR user |
| PUT | `/api/hr/departments/:id` | `hr.access`<br>`hr.configuration.manage` | hr |  | HR owner |
| GET | `/api/hr/departments/:id` | `hr.access`<br>`people.read.directory` | hr |  | any HR user |
| DELETE | `/api/hr/departments/:id` | `hr.access`<br>`hr.configuration.manage` | hr |  | HR owner |
| GET | `/api/hr/departments/:id/designations-list` | `hr.access`<br>`people.read.directory` | hr |  | any HR user |
| GET | `/api/hr/departments/:id/manager-candidates` | `hr.access`<br>`people.read.directory` | hr |  | HR operations |
| PUT | `/api/hr/departments/:id/managers` | `hr.access`<br>`employment.change` | hr |  | HR editor |
| GET | `/api/hr/departments/:id/with-employees` | `hr.access`<br>`people.read.directory` | hr |  | any HR user |
| GET | `/api/hr/departments/suggestions` | `hr.access`<br>`people.read.directory` | hr |  | any HR user |
| GET | `/api/hr/departments/with-designations` | `hr.access`<br>`people.read.directory` | hr |  | any HR user |

Notes:

- `POST /api/hr/departments` — An HR ORGANISATION department. Creating one grants nobody any application access — that is AccessDepartment, managed from CEO -> Access Control, and the two are separate on purpose.

## `/api/hr/documents`

Router: `./routes/HrRoutes/EmployeeDocuments_section`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| GET | `/api/hr/documents` | `hr.access`<br>`documents.read` | hr |  | HR operations |
| POST | `/api/hr/documents` | `hr.access`<br>`documents.issue` | hr | yes | HR editor |
| DELETE | `/api/hr/documents/:id` | `hr.access`<br>`documents.issue` | hr |  | HR editor |
| GET | `/api/hr/documents/:id` | `hr.access`<br>`documents.read` | hr | yes | HR operations |
| PATCH | `/api/hr/documents/:id/decline` | `hr.access`<br>`documents.issue` | hr |  | HR editor |
| GET | `/api/hr/documents/:id/download` | `hr.access`<br>`documents.read` | hr | yes | HR operations |
| POST | `/api/hr/documents/:id/file` | `hr.access`<br>`documents.issue` | hr | yes | HR editor |
| GET | `/api/hr/documents/:id/link` | `hr.access`<br>`documents.read` | hr | yes | HR operations |
| PATCH | `/api/hr/documents/:id/release` | `hr.access`<br>`documents.release` | hr |  | HR approver |
| PATCH | `/api/hr/documents/:id/revoke` | `hr.access`<br>`documents.release` | hr |  | HR approver |
| GET | `/api/hr/documents/prefill/:employeeId` | `hr.access`<br>`documents.issue`<br>`people.read.private` | hr | yes | HR editor |
| GET | `/api/hr/documents/requests` | `hr.access`<br>`documents.read` | hr |  | HR operations |
| GET | `/api/hr/documents/types` | `hr.access`<br>`documents.read` | hr |  | HR operations |

Notes:

- `PATCH /api/hr/documents/:id/release` — RELEASE is what makes a document visible to the employee. Separate from issue, pinned by test — generating a warning letter and publishing it are different decisions.

## `/api/hr/job-postings`

Router: `./routes/HrRoutes/JobPosting_Section`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| POST | `/api/hr/job-postings` | `hr.access`<br>`recruitment.manage` | hr |  | recruiter |
| GET | `/api/hr/job-postings/:id` | `hr.access`<br>`recruitment.read` | hr |  | recruiter |
| PUT | `/api/hr/job-postings/:id` | `hr.access`<br>`recruitment.manage` | hr |  | recruiter |
| DELETE | `/api/hr/job-postings/:id` | `hr.access`<br>`recruitment.manage` | hr |  | recruiter |
| PATCH | `/api/hr/job-postings/:id/status` | `hr.access`<br>`recruitment.manage` | hr |  | recruiter |
| GET | `/api/hr/job-postings/dashboard/jobs` | `hr.access`<br>`recruitment.read` | hr |  | recruiter |
| GET | `/api/hr/job-postings/dashboard/stats` | `hr.access`<br>`recruitment.read` | hr |  | recruiter |

## `/api/hr/leaves`

Router: `./routes/HrRoutes/Leave_section`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| GET | `/api/hr/leaves` | `hr.access`<br>`leave.read` | hr |  | HR operations |
| GET | `/api/hr/leaves/:id` | `hr.access`<br>`leave.read` | hr | yes | HR operations |
| PATCH | `/api/hr/leaves/:id/approve` | `hr.access`<br>`leave.decide.hr` | hr |  | HR editor |
| PATCH | `/api/hr/leaves/:id/cancel` | `hr.access`<br>`leave.decide.hr` | hr |  | HR editor |
| PATCH | `/api/hr/leaves/:id/reject` | `hr.access`<br>`leave.decide.hr` | hr |  | HR editor |
| POST | `/api/hr/leaves/:id/upload-document` | `hr.access`<br>`leave.decide.hr` | hr | yes | HR editor |
| POST | `/api/hr/leaves/add-on-behalf` | `hr.access`<br>`leave.decide.hr` | hr |  | HR editor |
| GET | `/api/hr/leaves/all-balances` | `hr.access`<br>`leave.read` | hr |  | HR operations |
| POST | `/api/hr/leaves/backfill-attendance` | `hr.access`<br>`attendance.close`<br>`leave.configure` | hr |  | HR approver |
| GET | `/api/hr/leaves/balance/:employeeId` | `hr.access`<br>`leave.read` | hr |  | HR operations |
| PATCH | `/api/hr/leaves/balance/:employeeId/adjust` | `hr.access`<br>`leave.configure` | hr |  | HR approver |
| POST | `/api/hr/leaves/balance/grant-pl` | `hr.access`<br>`leave.configure` | hr |  | HR approver |
| POST | `/api/hr/leaves/balance/init-year` | `hr.access`<br>`leave.configure` | hr |  | HR approver |
| PATCH | `/api/hr/leaves/bulk-approve` | `hr.access`<br>`leave.decide.hr` | hr |  | HR editor |
| GET | `/api/hr/leaves/calendar` | `hr.access`<br>`leave.read` | hr |  | HR operations |
| GET | `/api/hr/leaves/config` | `hr.access`<br>`leave.read` | hr |  | any HR user |
| PUT | `/api/hr/leaves/config` | `hr.access`<br>`leave.configure` | hr |  | HR approver |
| GET | `/api/hr/leaves/debug-attendance/:id` | `hr.access`<br>`attendance.read`<br>`leave.read` | hr |  | HR operations |
| GET | `/api/hr/leaves/employee-balance/:employeeId` | `hr.access`<br>`leave.read` | hr |  | HR operations |
| GET | `/api/hr/leaves/holidays` | `hr.access`<br>`leave.read` | hr |  | any HR user |
| POST | `/api/hr/leaves/holidays` | `hr.access`<br>`leave.configure` | hr |  | HR approver |
| DELETE | `/api/hr/leaves/holidays/:id` | `hr.access`<br>`leave.configure` | hr |  | HR approver |
| PATCH | `/api/hr/leaves/holidays/sunday-override` | `hr.access`<br>`leave.configure` | hr |  | HR approver |
| GET | `/api/hr/leaves/stats` | `hr.access`<br>`leave.read`<br>`analytics.workforce` | hr |  | HR operations |
| POST | `/api/hr/leaves/sync-pl-eligibility` | `hr.access`<br>`leave.configure` | hr |  | HR approver |

Notes:

- `PATCH /api/hr/leaves/balance/:employeeId/adjust` — Adjusting a balance is not deciding a request. Kept on leave.configure so an editor who may approve leave still cannot silently mint entitlement.

## `/api/hr/overview`

Router: `./routes/HrRoutes/Overview-Section`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| GET | `/api/hr/overview/attendance-summary` | `hr.access`<br>`analytics.workforce` | hr |  | HR user / management |
| GET | `/api/hr/overview/dashboard` | `hr.access`<br>`analytics.workforce` | hr |  | HR user, and the CEO command centre |
| GET | `/api/hr/overview/department-breakdown` | `hr.access`<br>`analytics.workforce` | hr |  | HR user / management |
| GET | `/api/hr/overview/leave-summary` | `hr.access`<br>`analytics.workforce` | hr |  | HR user / management |
| GET | `/api/hr/overview/quick-stats` | `hr.access`<br>`analytics.workforce` | hr |  | HR user / management |
| GET | `/api/hr/overview/recent-activities` | `hr.access`<br>`analytics.workforce`<br>`audit.read` | hr |  | HR user |

Notes:

- `GET /api/hr/overview/dashboard` — Read by /ceo/dashboard command centre as well as HR. analytics.workforce is in the CEO projection template, which is what keeps that page working.

## `/api/hr/password-management`

Router: `./routes/HrRoutes/Passwordmanagement`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| POST | `/api/hr/password-management/bulk-reset` | `hr.access`<br>`security.credentials.manage` | hr | yes | HR owner |
| PATCH | `/api/hr/password-management/change-password/:userType/:id` | `hr.access`<br>`security.credentials.manage` | hr | yes | HR owner |
| POST | `/api/hr/password-management/reset-password/:userType/:id` | `hr.access`<br>`security.credentials.manage` | hr | yes | HR owner |
| GET | `/api/hr/password-management/sync-dept-logins` | `hr.access`<br>`security.credentials.manage` | hr | yes | HR owner |
| POST | `/api/hr/password-management/sync-dept-logins` | `hr.access`<br>`security.credentials.manage` | hr | yes | HR owner |
| GET | `/api/hr/password-management/user/:userType/:id` | `hr.access`<br>`security.credentials.manage` | hr | yes | HR owner |
| GET | `/api/hr/password-management/users` | `hr.access`<br>`security.credentials.manage` | hr | yes | HR owner |

Notes:

- `POST /api/hr/password-management/bulk-reset` — Deliberately NOT credentialDelivery. It reset every selected account to the same derived default and returned the plaintext for each one — a bulk credential dump. It returns identifiers and per-row status only; the passwords are set, not shown.
- `PATCH /api/hr/password-management/change-password/:userType/:id` — HR resetting SOMEBODY ELSE'S password — the opposite of the self-service case at /api/hr/change-password, and held by the approval queue as well.
- `POST /api/hr/password-management/reset-password/:userType/:id` — Generates a one-time password and returns it once. The only declaration in the contract with credentialDelivery.

## `/api/hr/payroll`

Router: `./routes/HrRoutes/Payroll_section`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| GET | `/api/hr/payroll/export` | `hr.access`<br>`payroll.read`<br>`compensation.read`<br>`analytics.workforce` | hr | yes | payroll approver |
| GET | `/api/hr/payroll/item/:id` | `hr.access`<br>`payroll.read`<br>`compensation.read` | hr | yes | payroll preparer |
| PUT | `/api/hr/payroll/item/:id` | `hr.access`<br>`payroll.prepare` | hr | yes | payroll preparer |
| DELETE | `/api/hr/payroll/item/:id` | `hr.access`<br>`payroll.prepare` | hr | yes | payroll preparer |
| PATCH | `/api/hr/payroll/item/:id/override` | `hr.access`<br>`payroll.prepare` | hr | yes | payroll preparer |
| PATCH | `/api/hr/payroll/item/:id/recalculate` | `hr.access`<br>`payroll.prepare` | hr | yes | payroll preparer |
| GET | `/api/hr/payroll/items` | `hr.access`<br>`payroll.read`<br>`compensation.read` | hr | yes | payroll preparer |
| PATCH | `/api/hr/payroll/items/bulk-override` | `hr.access`<br>`payroll.prepare` | hr | yes | payroll preparer |
| PATCH | `/api/hr/payroll/mark-paid` | `hr.access`<br>`payroll.approve` | hr | yes | payroll approver |
| GET | `/api/hr/payroll/preview` | `hr.access`<br>`payroll.read`<br>`compensation.read` | hr | yes | payroll preparer |
| POST | `/api/hr/payroll/run` | `hr.access`<br>`payroll.prepare` | hr | yes | payroll preparer |
| DELETE | `/api/hr/payroll/run` | `hr.access`<br>`payroll.reopen` | hr | yes | HR owner |
| PATCH | `/api/hr/payroll/run/revert-to-draft` | `hr.access`<br>`payroll.reopen` | hr | yes | HR owner |
| POST | `/api/hr/payroll/run/save-draft` | `hr.access`<br>`payroll.prepare` | hr | yes | payroll preparer |
| GET | `/api/hr/payroll/runs` | `hr.access`<br>`payroll.read` | hr |  | payroll preparer |
| GET | `/api/hr/payroll/settings` | `hr.access`<br>`payroll.read` | hr |  | payroll preparer |
| PUT | `/api/hr/payroll/settings` | `hr.access`<br>`hr.configuration.manage` | hr |  | HR owner |

Notes:

- `PATCH /api/hr/payroll/mark-paid` — The one payroll write an approver makes that a preparer must not. Distinct capability, pinned by test.
- `PATCH /api/hr/payroll/run/revert-to-draft` — Reopening a run. Separate from approve, and separate again from prepare.

## `/api/hr/payslip`

Router: `./routes/HrRoutes/Payslip_section`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| GET | `/api/hr/payslip/:employeeId` | `hr.access`<br>`compensation.read` | hr | yes | payroll preparer |
| GET | `/api/hr/payslip/:employeeId/history` | `hr.access`<br>`compensation.read` | hr | yes | payroll preparer |
| GET | `/api/hr/payslip/:employeeId/pdf` | `hr.access`<br>`compensation.read` | hr | yes | payroll preparer |
| GET | `/api/hr/payslip/employees` | `hr.access`<br>`payroll.read` | hr |  | payroll preparer |

## `/api/hr/policy`

Router: `./routes/HrRoutes/policyRoutes`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| GET | `/api/hr/policy` | `hr.access`<br>`compliance.read` | hr |  | any HR user |
| POST | `/api/hr/policy` | `hr.access`<br>`compliance.manage` | hr |  | HR approver |
| PATCH | `/api/hr/policy/:id` | `hr.access`<br>`compliance.manage` | hr |  | HR approver |
| DELETE | `/api/hr/policy/:id` | `hr.access`<br>`compliance.manage` | hr |  | HR approver |
| POST | `/api/hr/policy/apply` | `hr.access`<br>`compliance.manage` | hr |  | HR approver |
| GET | `/api/hr/policy/c4-config` | `hr.access`<br>`compliance.read` | hr |  | HR operations |
| PUT | `/api/hr/policy/c4-config` | `hr.access`<br>`compliance.manage` | hr |  | HR approver |
| * | `/api/hr/policy/c4-presence-cron` | — | public |  | an external scheduler, not a person |
| POST | `/api/hr/policy/c4-presence-run` | `hr.access`<br>`compliance.manage` | hr |  | HR approver |
| GET | `/api/hr/policy/departments` | `hr.access`<br>`compliance.read` | hr |  | HR operations |
| GET | `/api/hr/policy/employee-history/:biometricId` | `hr.access`<br>`compliance.read` | hr | yes | HR operations |
| GET | `/api/hr/policy/employees` | `hr.access`<br>`compliance.read` | hr |  | HR operations |
| GET | `/api/hr/policy/external-rules` | `hr.access`<br>`compliance.read` | hr |  | HR operations |
| GET | `/api/hr/policy/points-summary` | `hr.access`<br>`compliance.read` | hr |  | HR operations |
| GET | `/api/hr/policy/suggestions` | `hr.access`<br>`compliance.read` | hr |  | HR operations |

Notes:

- `* /api/hr/policy/c4-presence-cron` — Declared `public` because it carries no session: an external scheduler cannot sign in, so the handler authenticates the CALLER with the C4_CRON_KEY shared secret and refuses outright when that variable is unset. Session-shaped authorisation is the wrong tool here; the declaration records that the route has its own and is deliberately outside the capability model.

## `/api/hr/sop`

Router: `./routes/HrRoutes/hrSopRoutes`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| GET | `/api/hr/sop` | `hr.access`<br>`compliance.read` | hr |  | any HR user |
| POST | `/api/hr/sop` | `hr.access`<br>`compliance.manage` | hr |  | HR approver |
| PATCH | `/api/hr/sop/:id` | `hr.access`<br>`compliance.manage` | hr |  | HR approver |
| DELETE | `/api/hr/sop/:id` | `hr.access`<br>`compliance.manage` | hr |  | HR approver |
| POST | `/api/hr/sop/bleach` | `hr.access`<br>`compliance.manage` | hr | yes | HR approver |
| GET | `/api/hr/sop/bleach/:employeeId` | `hr.access`<br>`compliance.read`<br>`skills.read` | hr | yes | HR operations |
| GET | `/api/hr/sop/employees` | `hr.access`<br>`compliance.read` | hr |  | HR operations |
| GET | `/api/hr/sop/folders` | `hr.access`<br>`compliance.read` | hr |  | any HR user |
| POST | `/api/hr/sop/folders` | `hr.access`<br>`compliance.manage` | hr |  | HR approver |
| DELETE | `/api/hr/sop/folders/:id` | `hr.access`<br>`compliance.manage` | hr |  | HR approver |

## `/api/hr/tasks`

Router: `./routes/HrRoutes/EmployeeTasks_section`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| POST | `/api/hr/tasks` | `hr.access`<br>`recruitment.manage` | hr |  | recruiter |
| PUT | `/api/hr/tasks/:taskId` | `hr.access`<br>`recruitment.manage` | hr |  | recruiter |
| DELETE | `/api/hr/tasks/:taskId` | `hr.access`<br>`recruitment.manage` | hr |  | recruiter |
| PATCH | `/api/hr/tasks/:taskId/complete` | `hr.access`<br>`recruitment.manage` | hr |  | recruiter |
| PATCH | `/api/hr/tasks/:taskId/status` | `hr.access`<br>`recruitment.manage` | hr |  | recruiter |
| GET | `/api/hr/tasks/candidate/:candidateId` | `hr.access`<br>`recruitment.read` | hr |  | recruiter |
| GET | `/api/hr/tasks/manager/:managerId` | `hr.access`<br>`recruitment.read` | hr |  | recruiter / hiring manager |
| GET | `/api/hr/tasks/upcoming/tasks` | `hr.access`<br>`recruitment.read` | hr |  | recruiter |

## `/api/hr/vendors`

Router: `./routes/Vendor_Routes/vendorRoutes`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| GET | `/api/hr/vendors` | `hr.access` | hr |  | supply chain (mounted under HR) |
| POST | `/api/hr/vendors` | `hr.access`<br>`hr.configuration.manage` | hr |  | supply chain (mounted under HR) |
| GET | `/api/hr/vendors/:id` | `hr.access` | hr |  | supply chain (mounted under HR) |
| PUT | `/api/hr/vendors/:id` | `hr.access`<br>`hr.configuration.manage` | hr |  | supply chain (mounted under HR) |
| DELETE | `/api/hr/vendors/:id` | `hr.access`<br>`hr.configuration.manage` | hr |  | supply chain (mounted under HR) |
| GET | `/api/hr/vendors/dashboard/stats` | `hr.access` | hr |  | supply chain (mounted under HR) |
| POST | `/api/hr/vendors/quick-add` | `hr.access`<br>`hr.configuration.manage` | hr |  | supply chain (mounted under HR) |

## `/employee`

Router: `./routes/Employee_Routes/publicProfileAPI`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| GET | `/employee/public/:identityId` | — | public |  | anyone holding the ID card |

Notes:

- `GET /employee/public/:identityId` — Deliberately unauthenticated and deliberately directory-class only. Listed here so the matrix is complete and the field test has something to assert against.

## `/hr/attendance`

Router: `./routes/HrRoutes/Attendance_section`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| POST | `/hr/attendance/backfill-hr-leaves` | `hr.access`<br>`attendance.close`<br>`leave.configure` | hr |  | attendance approver |
| PUT | `/hr/attendance/bulk-day-override` | `hr.access`<br>`attendance.correct` | hr |  | time office |
| GET | `/hr/attendance/calendar` | `hr.access`<br>`attendance.read` | hr |  | time office |
| GET | `/hr/attendance/daily` | `hr.access`<br>`attendance.read` | hr |  | time office |
| PUT | `/hr/attendance/day-override` | `hr.access`<br>`attendance.correct` | hr |  | time office |
| GET | `/hr/attendance/day-range` | `hr.access`<br>`attendance.read` | hr |  | time office |
| GET | `/hr/attendance/departments` | `hr.access`<br>`attendance.read` | hr |  | time office |
| GET | `/hr/attendance/departments-with-designations` | `hr.access`<br>`attendance.read` | hr |  | time office |
| GET | `/hr/attendance/employee-detail` | `hr.access`<br>`attendance.read` | hr |  | time office |
| GET | `/hr/attendance/employee/:empId` | `hr.access`<br>`attendance.read` | hr |  | time office |
| GET | `/hr/attendance/employees-list` | `hr.access`<br>`attendance.read` | hr |  | time office |
| GET | `/hr/attendance/export-daily` | `hr.access`<br>`attendance.read`<br>`analytics.workforce` | hr |  | time office |
| GET | `/hr/attendance/export-muster-roll` | `hr.access`<br>`attendance.read`<br>`analytics.workforce` | hr |  | time office |
| GET | `/hr/attendance/holidays` | `hr.access`<br>`attendance.read` | hr |  | any HR user |
| POST | `/hr/attendance/holidays` | `hr.access`<br>`leave.configure` | hr |  | HR approver |
| DELETE | `/hr/attendance/holidays/:id` | `hr.access`<br>`leave.configure` | hr |  | HR approver |
| GET | `/hr/attendance/leave-balance-check` | `hr.access`<br>`attendance.read`<br>`leave.read` | hr |  | time office |
| GET | `/hr/attendance/missed-punches` | `hr.access`<br>`attendance.read` | hr |  | time office |
| GET | `/hr/attendance/muster-roll` | `hr.access`<br>`attendance.read` | hr |  | time office |
| GET | `/hr/attendance/notification-settings` | `hr.access`<br>`attendance.read` | hr |  | time office |
| PUT | `/hr/attendance/notification-settings` | `hr.access`<br>`hr.configuration.manage` | hr |  | HR owner |
| POST | `/hr/attendance/notification-subscribe` | `hr.access`<br>`attendance.read` | hr |  | time office |
| POST | `/hr/attendance/notification-test` | `hr.access`<br>`hr.configuration.manage` | hr |  | HR owner |
| POST | `/hr/attendance/punch-correction` | `hr.access`<br>`attendance.correct` | hr |  | time office |
| GET | `/hr/attendance/regularizations` | `hr.access`<br>`attendance.read` | hr |  | time office |
| POST | `/hr/attendance/regularizations` | `hr.access`<br>`attendance.correct` | hr |  | time office |
| GET | `/hr/attendance/regularizations/:id` | `hr.access`<br>`attendance.read` | hr |  | time office |
| PATCH | `/hr/attendance/regularizations/:id/cancel` | `hr.access`<br>`attendance.correct` | hr |  | time office |
| PATCH | `/hr/attendance/regularizations/:id/hr-approve` | `hr.access`<br>`attendance.correct` | hr |  | time office |
| PATCH | `/hr/attendance/regularizations/:id/hr-reject` | `hr.access`<br>`attendance.correct` | hr |  | time office |
| DELETE | `/hr/attendance/remove-from-month` | `hr.access`<br>`attendance.close` | hr |  | attendance approver |
| GET | `/hr/attendance/settings` | `hr.access`<br>`attendance.read` | hr |  | time office |
| PUT | `/hr/attendance/settings` | `hr.access`<br>`hr.configuration.manage` | hr |  | HR owner |
| GET | `/hr/attendance/summary` | `hr.access`<br>`attendance.read` | hr |  | time office |
| POST | `/hr/attendance/sync-period` | `hr.access`<br>`attendance.close` | hr |  | attendance approver |
| GET | `/hr/attendance/sync-period/:jobId` | `hr.access`<br>`attendance.read` | hr |  | time office |
| GET | `/hr/attendance/test-connection` | `hr.access`<br>`hr.configuration.manage` | hr |  | HR owner |
| GET | `/hr/attendance/timecard` | `hr.access`<br>`attendance.read` | hr |  | time office |

Notes:

- `DELETE /hr/attendance/remove-from-month` — Removes a person from a whole month of attendance. Period-shaped, so it takes the CLOSE capability rather than the correction one — the separation tests pin this.
- `POST /hr/attendance/sync-period` — Re-derives a whole period from the biometric source. Exempt from the approval queue as a machine operation (server.js), which is exactly why it needs the higher capability here.
- `GET /hr/attendance/test-connection` — Probes the biometric device credentials. A diagnostic that proves reachability of an integration is configuration, not attendance.

## `/hr/face-registration`

Router: `./routes/HrRoutes/FaceRegistration_section`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| POST | `/hr/face-registration/archive/:employeeId` | `hr.access`<br>`people.write` | hr | yes | HR editor |
| GET | `/hr/face-registration/health` | — | public |  | punch-in machine |
| POST | `/hr/face-registration/photo/:employeeId` | `hr.access`<br>`people.write` | hr | yes | HR editor |
| POST | `/hr/face-registration/recheck` | `hr.access`<br>`people.read.directory` | hr |  | HR operations |
| GET | `/hr/face-registration/status` | `hr.access`<br>`people.read.directory` | hr |  | HR operations |
| GET | `/hr/face-registration/status/:employeeId` | `hr.access`<br>`people.read.directory` | hr |  | HR operations |
| POST | `/hr/face-registration/upload/:employeeId` | `hr.access`<br>`people.write` | hr | yes | HR editor |

Notes:

- `GET /hr/face-registration/health` — Liveness of the face engine. No data, no identity; deliberately open so the device can be monitored without a session.

## `/hr/performance`

Router: `./routes/HrRoutes/Performance_section`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| GET | `/hr/performance/:employeeId` | `hr.access`<br>`skills.read` | hr | yes | HR operations |
| GET | `/hr/performance/overview` | `hr.access`<br>`skills.read`<br>`analytics.workforce` | hr |  | HR operations |

Notes:

- `GET /hr/performance/:employeeId` — Takes an ARBITRARY employee id and is therefore HR-only. The employee's own copy is /api/employee/performance, which is scoped to the token.

## `/hr/reports`

Router: `./routes/HrRoutes/Reports_section`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| GET | `/hr/reports/filters` | `hr.access`<br>`analytics.workforce` | hr |  | HR operations |
| POST | `/hr/reports/generate/:reportKey` | `hr.access`<br>`analytics.workforce` | hr | yes | HR operations |
| POST | `/hr/reports/month-performance` | `hr.access`<br>`analytics.workforce`<br>`skills.read` | hr | yes | HR operations |
| GET | `/hr/reports/types` | `hr.access`<br>`analytics.workforce` | hr |  | HR operations |

Notes:

- `POST /hr/reports/generate/:reportKey` — POST because the filter set does not fit in a query string; read-shaped, and the write guard treats it as such. A report that includes pay is additionally gated by the field projection.

## `/hr/shift-swaps`

Router: `./routes/HrRoutes/ShiftSwap_section`

| Method | Path | Capabilities | Scope | Protected | Persona |
|---|---|---|---|---|---|
| GET | `/hr/shift-swaps/employees` | `hr.access`<br>`attendance.read` | hr |  | time office |
| POST | `/hr/shift-swaps/exchange` | `hr.access`<br>`attendance.correct` | hr |  | time office |
| GET | `/hr/shift-swaps/recent` | `hr.access`<br>`attendance.read` | hr |  | time office |
