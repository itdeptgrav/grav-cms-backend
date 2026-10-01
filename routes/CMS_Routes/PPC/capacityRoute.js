// routes/CMS_Routes/PPC/capacityRoute.js
//
// PPC CAPACITY — CONFIGURATION, PREVIEW AND BOOKING.
//
//   GET   /capacity/calendars                          viewer
//   POST  /capacity/calendars                          owner
//   GET   /capacity/calendars/:calendarId              viewer
//   POST  /capacity/calendars/:calendarId/versions     owner   (a DRAFT)
//   PATCH /capacity/calendar-versions/:versionId       owner   (drafts only)
//   POST  /capacity/calendar-versions/:versionId/publish  owner, idempotent
//   GET   /capacity/lines                              viewer
//   POST  /capacity/lines                              owner
//   PATCH /capacity/lines/:lineId                      owner
//   GET   /capacity/lines/:lineId/load?from&to         viewer
//   POST  /capacity/preview                            viewer  — WRITES NOTHING
//   POST  /capacity/bookings                           approver, idempotent
//   GET   /capacity/bookings                           viewer
//   GET   /capacity/bookings/:bookingId                viewer
//   POST  /capacity/bookings/:bookingId/release        approver, idempotent
//   POST  /capacity/bookings/:bookingId/replan         approver, idempotent
//
// ── THE PREVIEW IS A POST, AND IT STILL WRITES NOTHING ──────────────────────
// A POST because its input is a structured request, not because it changes
// anything. It is gated on READ, it creates no booking, no counter and no
// ledger row, and its answer says `booksCapacity: false`. A test snapshots
// every capacity collection around it.
//
// ── THE BOOKING TAKES NO ALLOCATIONS ────────────────────────────────────────
// A caller names a plan, a line, a window and the versions it previewed. The
// days and minutes are recomputed by the server inside the command; a body
// that tries to supply them is refused, because an allocation a client chose
// is an allocation nobody proved.
//
// ── AND THERE IS NO PRODUCTION VERB ─────────────────────────────────────────
// No work order, no release to Production, no line allocation into Production's
// records. Booking reserves PPC's own view of a line's time.
"use strict";

const express = require("express");

const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const { handle } = require("../../../services/storePurchase/errors");
const { ppcCapability, CAPABILITY } = require("../../../services/ppc/access.service");
const {
  merchandisingCompanyMiddleware,
} = require("../../../services/companyContext/merchandisingScope.service");
const config = require("../../../services/ppc/capacityConfig.service");
const planning = require("../../../services/ppc/capacityPlanning.service");

const router = express.Router();
router.use(EmployeeAuthMiddleware);

const requireCompany = merchandisingCompanyMiddleware({ domainLabel: "PPC" });
const canRead = ppcCapability(CAPABILITY.CAPACITY_READ);
const canBook = ppcCapability(CAPABILITY.CAPACITY_BOOK);
const canConfigure = ppcCapability(CAPABILITY.CAPACITY_CONFIGURE);

const actor = (req) => (req.user?.id
  ? { id: req.user.id, name: req.user.name || "", email: req.user.email || "" } : null);
const key = (req) => String(req.get("Idempotency-Key") || "").trim();
const ok = (res, out, status = 200) => res.status(status).json({ success: true, ...out });

/* ══ CALENDARS ════════════════════════════════════════════════════════════ */

router.get("/capacity/calendars", requireCompany, canRead, handle(async (req, res) =>
  ok(res, await config.listCalendars(req.merchandising))));

router.post("/capacity/calendars", requireCompany, canConfigure, handle(async (req, res) =>
  ok(res, await config.createCalendar(req.merchandising, { body: req.body || {}, actor: actor(req) }), 201)));

router.get("/capacity/calendars/:calendarId", requireCompany, canRead, handle(async (req, res) =>
  ok(res, await config.getCalendar(req.merchandising, req.params.calendarId))));

router.post("/capacity/calendars/:calendarId/versions", requireCompany, canConfigure, handle(async (req, res) =>
  ok(res, await config.createDraftVersion(req.merchandising, {
    calendarId: req.params.calendarId, body: req.body || {}, actor: actor(req),
  }), 201)));

router.patch("/capacity/calendar-versions/:versionId", requireCompany, canConfigure, handle(async (req, res) =>
  ok(res, await config.updateDraftVersion(req.merchandising, {
    versionId: req.params.versionId, body: req.body || {}, actor: actor(req),
  }))));

router.post("/capacity/calendar-versions/:versionId/publish", requireCompany, canConfigure,
  handle(async (req, res) => ok(res, await config.publishVersion(req.merchandising, {
    versionId: req.params.versionId, body: req.body || {}, actor: actor(req), idempotencyKey: key(req),
  }))));

/* ══ LINES ════════════════════════════════════════════════════════════════ */

router.get("/capacity/lines", requireCompany, canRead, handle(async (req, res) =>
  ok(res, await config.listLines(req.merchandising, { includeRetired: req.query.includeRetired === "1" }))));

router.post("/capacity/lines", requireCompany, canConfigure, handle(async (req, res) =>
  ok(res, await config.createLine(req.merchandising, { body: req.body || {}, actor: actor(req) }), 201)));

router.patch("/capacity/lines/:lineId", requireCompany, canConfigure, handle(async (req, res) =>
  ok(res, await config.updateLine(req.merchandising, {
    lineId: req.params.lineId, body: req.body || {}, actor: actor(req),
  }))));

router.get("/capacity/lines/:lineId/load", requireCompany, canRead, handle(async (req, res) =>
  ok(res, await planning.lineLoad(req.merchandising, {
    lineId: req.params.lineId, from: req.query.from, to: req.query.to,
  }))));

/* ══ PREVIEW — READ-ONLY ══════════════════════════════════════════════════ */

router.post("/capacity/preview", requireCompany, canRead, handle(async (req, res) => {
  const b = req.body || {};
  return ok(res, await planning.preview(req.merchandising, {
    planningFileId: b.planningFileId, lineId: b.lineId,
    windowStart: b.windowStart, windowEnd: b.windowEnd,
    excludeBookingId: b.replanBookingId || null,
  }));
}));

/* ══ BOOKINGS ═════════════════════════════════════════════════════════════ */

router.post("/capacity/bookings", requireCompany, canBook, handle(async (req, res) => {
  const out = await planning.book(req.merchandising, {
    body: req.body || {}, actor: actor(req), idempotencyKey: key(req),
  });
  return ok(res, out, out.replayed ? 200 : 201);
}));

router.get("/capacity/bookings", requireCompany, canRead, handle(async (req, res) =>
  ok(res, await planning.listBookings(req.merchandising, {
    state: req.query.state, planningFileId: req.query.planningFileId,
    lineId: req.query.lineId, limit: req.query.limit,
  }))));

router.get("/capacity/bookings/:bookingId", requireCompany, canRead, handle(async (req, res) =>
  ok(res, await planning.getBooking(req.merchandising, req.params.bookingId))));

router.post("/capacity/bookings/:bookingId/release", requireCompany, canBook, handle(async (req, res) =>
  ok(res, await planning.release(req.merchandising, {
    bookingId: req.params.bookingId, body: req.body || {}, actor: actor(req), idempotencyKey: key(req),
  }))));

router.post("/capacity/bookings/:bookingId/replan", requireCompany, canBook, handle(async (req, res) => {
  const out = await planning.replan(req.merchandising, {
    bookingId: req.params.bookingId, body: req.body || {}, actor: actor(req), idempotencyKey: key(req),
  });
  return ok(res, out, out.replayed ? 200 : 201);
}));

module.exports = router;
