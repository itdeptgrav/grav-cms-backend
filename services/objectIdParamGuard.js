// services/objectIdParamGuard.js
//
// A MALFORMED ID IS "NOT FOUND", NOT "SERVER ERROR".
//
// Every detail route in the accounting module ends in `findById(req.params.id)`.
// Handed something that is not a 24-hex ObjectId, Mongoose throws a CastError,
// the route's own `catch` turns it into a 500, and the client is shown the raw
// internal message:
//
//     Cast to ObjectId failed for value "list" (type string) at path "_id"
//     for model "SpendRequest"
//
// Three things wrong with that: a mistyped or stale URL is a 404, not a server
// fault; the model name is internal and does not belong in a response; and a
// 500 in the logs says something broke when nothing did. It is also how a
// missing route is misdiagnosed — `/spend-approvals/list` has no `/list`
// handler, so it fell through to `/:id` and reported a cast failure rather than
// "no such endpoint".
//
// `router.param()` only fires for a parameter a route on THAT router actually
// declares, so attaching this is inert on routers that never use the name.
//
// Deliberately NOT applied globally: plenty of routes take a `:id` that is a
// slug, a department code, a financial year or a month, and those are perfectly
// valid non-ObjectId values. It is applied per router, by name, where the id
// genuinely is an ObjectId.
"use strict";

const mongoose = require("mongoose");

/**
 * Refuse non-ObjectId values for the named route params with a plain 404.
 *
 * @param {import("express").Router} router
 * @param {string[]} names  param names that are ObjectIds on this router
 * @returns the same router, so it can be wrapped inline at the mount
 */
function guardObjectIdParams(router, names = ["id"]) {
  for (const name of names) {
    router.param(name, (req, res, next, value) => {
      if (mongoose.Types.ObjectId.isValid(String(value))) return next();
      /* Same shape every accounting route uses for a refusal, so clients that
         already read `message` need no special case. */
      return res.status(404).json({
        success: false,
        code: "NOT_FOUND",
        message: "No such record — the address is not a valid id.",
      });
    });
  }
  return router;
}

module.exports = { guardObjectIdParams };
