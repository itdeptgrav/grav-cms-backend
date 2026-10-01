"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ORDER_FULFILMENT_MODELS,
  resolveOrderFulfilmentModel,
  isJobWorkOrder,
} = require("../constants/orderFulfilment");
const Enquiry = require("../models/CMS_Models/Sales/Enquiry");
const CustomerRequest = require("../models/Customer_Models/CustomerRequest");
const moListProjection = require("./manufacturing/moListProjection");

test("fulfilment vocabulary has a safe legacy default", () => {
  assert.deepEqual(ORDER_FULFILMENT_MODELS, ["FULL_PACKAGE", "JOB_WORK"]);
  assert.equal(resolveOrderFulfilmentModel(), "FULL_PACKAGE");
  assert.equal(resolveOrderFulfilmentModel("unknown"), "FULL_PACKAGE");
  assert.equal(resolveOrderFulfilmentModel("job_work"), "JOB_WORK");
  assert.equal(isJobWorkOrder("JOB_WORK"), true);
  assert.equal(isJobWorkOrder("FULL_PACKAGE"), false);
});

test("enquiry products and confirmed order lines persist the same classification", () => {
  const enquiryPath = Enquiry.schema.path("products").schema.path("fulfilmentModel");
  const orderPath = CustomerRequest.schema.path("items").schema.path("fulfilmentModel");

  assert.deepEqual(enquiryPath.enumValues, ORDER_FULFILMENT_MODELS);
  assert.deepEqual(orderPath.enumValues, ORDER_FULFILMENT_MODELS);
});

test("manufacturing list projection exposes a product-wise Job Work count", () => {
  assert.equal(moListProjection.projectRow({ _id: "order-1", jobWorkProductCount: 2 }).jobWorkProductCount, 2);
  assert.equal(moListProjection.projectRow({ _id: "legacy-order" }).jobWorkProductCount, 0);
});
