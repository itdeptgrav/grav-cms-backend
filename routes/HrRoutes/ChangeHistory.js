// routes/HrRoutes/ChangeHistory.js
//
// HR's change history. The endpoints, the query and the shapes all live in
// routes/Access/changeHistoryRouter.js — see the note there on why this is a
// factory rather than a file per department.
//
// Mounted at /api/hr/change-history, ABOVE the bare "/api/hr" profile router:
// that one is mounted at the prefix, so a router added after it only ever sees
// requests it declined.

"use strict";

const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");
const { createChangeHistoryRouter } = require("../Access/changeHistoryRouter");

module.exports = createChangeHistoryRouter({
  department: "hr",
  auth: EmployeeAuthMiddleware,
  mount: "/api/hr/change-history",
});
