// services/sampleReadiness.js
//
// One question, asked from three places: is this style's SAMPLE settled, so
// the customer can now be asked to approve it?
//
// There are TWO ways a sample is settled, and only one of them used to count:
//
//   1. `approved`      — R&D made a physical sample and Sales signed it off.
//   2. `notApplicable` — the style was raised from a product the customer
//                        picked off the register. Nothing is going to be
//                        sampled, so waiting for an approval that will never
//                        come is waiting forever.
//
// Both mean "there is nothing further to do about the sample". Checking
// `status === "approved"` literally — which the customer-approval route, the
// WhatsApp send route, and the inbound-reply matcher all did — meant a waived
// style could never reach customer approval at all: the waiver marked it
// `notApplicable`, and every downstream gate then read that as "not ready" and
// refused (26 Aug 2026, explicit request: a style raised from an existing
// product should run "all the steps upto the customer approval", with "no need
// to sent to the r&d team and all"). The waiver existed; the gates just never
// learned about it.
//
// Kept in its own module rather than inlined so the three call sites cannot
// drift apart again, and so neither the route file nor the WhatsApp service
// has to require the other.
"use strict";

/** Sample statuses that mean "settled — nothing further is coming". */
const SETTLED_SAMPLE_STATUSES = Object.freeze(["approved", "notApplicable"]);

/**
 * Is the sample settled, so the customer can be asked to approve the style?
 *
 * @param {object} style A SampleStyle document or lean object.
 * @returns {boolean}
 */
function isSampleSettled(style) {
  return SETTLED_SAMPLE_STATUSES.includes(style?.sample?.status);
}

/**
 * Was this style waived rather than actually sampled? Used for wording — a
 * waived style should not be described to anyone as "approved", because
 * nobody approved anything.
 *
 * @param {object} style A SampleStyle document or lean object.
 * @returns {boolean}
 */
function isSampleWaived(style) {
  return style?.sample?.status === "notApplicable";
}

module.exports = { isSampleSettled, isSampleWaived, SETTLED_SAMPLE_STATUSES };
