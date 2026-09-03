// routes/Accountant_Routes/Acc_changeHistory.js
//
// The accountant module's change history.
//
// WHY THIS EXISTS BESIDE THE ACTIVITY LOG AND THE APPROVAL QUEUE
// -------------------------------------------------------------
// Both of those already exist and both stay. They answer different questions:
//
//   activity log     — a document was posted, by whom, when
//   approval queue   — who let an editor's submission through
//   THIS             — who changed this figure, from what, to what
//
// The gap that made this necessary is the OWNER. An owner posts directly and
// never enters the approval queue, so nothing anywhere recorded an owner's
// edits — which is exactly what was noticed. A history that is silent about the
// one role that can change anything without asking is not a history.
//
// READS ARE OPEN TO VIEWERS. `accountantReadOnlyAuth` rather than
// `accountantAuth`: reading the history is a read, and a viewer is the person
// most likely to need it, since they cannot change anything and "who changed
// this" is the only question they have.

"use strict";

const {
  accountantReadOnlyAuth,
} = require("../../Middlewear/AccountantAuthMiddleware");
const { createChangeHistoryRouter } = require("../Access/changeHistoryRouter");

module.exports = createChangeHistoryRouter({
  department: "accounting",
  auth: accountantReadOnlyAuth,
  mount: "/api/accountant/change-history",
});
