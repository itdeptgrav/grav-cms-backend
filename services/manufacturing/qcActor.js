// services/manufacturing/qcActor.js
//
// WHO IS ASKING, AND WHAT THEY MAY INSPECT — resolved once per request.
//
// ── WHY THIS MOVED OUT OF qcRawItemRoutes.js ───────────────────────────────
// It was that router's private `whoAmI`, which was right while raw-material
// checking was the only thing that needed it. The unified Inspect screen needs
// the same answer for the OTHER book too: `POST /identify-barcode` has to say
// whether the person scanning may open the branch the barcode resolves to, and
// it cannot do that with a capability model that lives inside a router it is
// not part of.
//
// So one resolver, one set of three capabilities, and `qcRawItemRoutes.whoAmI`
// delegates here. Nothing about the rules changed — this file is that function,
// moved, with its reasoning kept.
//
// ── THE THREE CAPABILITIES ─────────────────────────────────────────────────
//   owner         the QC owner, or a platform administrator. Sets up reasons
//                 and checkers, reads everything.
//   productCheck  may inspect garment pieces. Everyone in QC may, EXCEPT a raw
//                 item checker the owner deliberately kept off the station
//                 (29 Sep 2026) — and the owner always may.
//   rawCheck      may inspect raw material. An active roster row, matched by
//                 email — and the owner always may.
//
// A person may hold both, either, or neither. Neither is a real state: a QC
// viewer with no checker row inspects garments and not raw material, which is
// the commonest case in the department.
//
// THIS IS THE SECURITY BOUNDARY, not the navigation. The frontend hides what a
// person cannot use so they are not offered dead ends; every route that acts on
// a capability re-checks it here.
"use strict";

const { getRole } = require("../departmentRoles");
const QCRawItemSetting = require("../../models/CMS_Models/Manufacturing/QC/QCRawItemSetting");
const Employee = require("../../models/Employee");

const SLUG = "qc";

/**
 * Resolve the caller's QC identity and capabilities.
 *
 * Cached on `req.qcWho` for the life of the request — every route on a QC
 * router asks, and the three reads behind it (the role, the roster row, the
 * employee record) are not free.
 *
 * `req.qcUser` must already be set by the router's own auth middleware:
 * `{ email, name, isAdmin }` at minimum.
 */
async function resolveQcActor(req) {
  if (req.qcWho) return req.qcWho;

  const u = req.qcUser || {};
  const email = String(u.email || "").toLowerCase();

  const now = new Date();
  /* The three reads do not depend on one another, so they go out together
     (8 Oct 2026): one round trip's worth of waiting on every QC request
     instead of three in a row.
     The roster row: an active one, in force right now. The window is inclusive
     at both ends and open-ended when either bound is absent, which is how the
     owner rosters somebody "from now until I say otherwise". */
  const [role, checkerRow, emp] = await Promise.all([
    u.isAdmin ? "owner" : getRole(SLUG, email),
    email
      ? QCRawItemSetting.findOne({
          kind: "checker", email, isActive: true,
          $or: [{ validFrom: null }, { validFrom: { $lte: now } }],
          $and: [{ $or: [{ validTo: null }, { validTo: { $gte: now } }] }],
        }).lean()
      : null,
    email
      ? Employee.findOne({ email }).select("firstName middleName lastName biometricId").lean()
      : null,
  ]);
  const owner = Boolean(u.isAdmin) || role === "owner";
  const name = emp
    ? [emp.firstName, emp.middleName, emp.lastName].filter(Boolean).join(" ").trim() || u.name
    : u.name;

  /* A raw item checker may be kept OFF the product piece station (29 Sep 2026);
     everyone else in QC, and the owner, keep it as before. */
  const productCheck = owner || !checkerRow || checkerRow.productCheck !== false;

  req.qcWho = {
    email,
    name: name || email,
    biometricId: emp?.biometricId || checkerRow?.biometricId || "",
    role: role || null,
    owner,
    /* `checker` is the historical name for this and is kept because the config
       endpoint publishes it under that key and the frontend reads it. */
    checker: Boolean(checkerRow) || owner,
    rawCheck: Boolean(checkerRow) || owner,
    productCheck,
    checkerRow,
  };
  return req.qcWho;
}

/**
 * May this actor open the branch a barcode resolved to?
 *
 * Returns `{ permitted, code, message }`. The MESSAGE is the one the station
 * shows, so it says what to do about it and who can do it — a refusal that only
 * says "not permitted" sends the person to find somebody to ask what it meant.
 *
 * `unknown` is permitted: there is no branch to open, and the screen's own
 * "not recognised" message is the right answer rather than an access refusal on
 * top of it.
 */
function mayInspect(actor, type) {
  if (type === "garment_piece") {
    if (actor.productCheck) return { permitted: true, code: null, message: null };
    return {
      permitted: false,
      code: "NOT_A_PRODUCT_CHECKER",
      message: "Your QC access is for raw materials, not garment pieces. The QC owner can turn garment checking on for you under Setup › Raw-material QC.",
    };
  }
  if (type === "raw_material") {
    if (actor.rawCheck) return { permitted: true, code: null, message: null };
    return {
      permitted: false,
      code: "NOT_A_RAW_ITEM_CHECKER",
      message: "You are not assigned as a raw-material checker. Ask the QC owner to add you under Setup › Raw-material QC. Garment inspection is unaffected.",
    };
  }
  return { permitted: true, code: null, message: null };
}

module.exports = { resolveQcActor, mayInspect, SLUG };
