"use strict";

const ORDER_FULFILMENT_MODELS = Object.freeze(["FULL_PACKAGE", "JOB_WORK"]);
const DEFAULT_ORDER_FULFILMENT_MODEL = "FULL_PACKAGE";

function resolveOrderFulfilmentModel(value) {
  const model = String(value || "").trim().toUpperCase();
  return ORDER_FULFILMENT_MODELS.includes(model)
    ? model
    : DEFAULT_ORDER_FULFILMENT_MODEL;
}

function isJobWorkOrder(value) {
  return resolveOrderFulfilmentModel(value) === "JOB_WORK";
}

module.exports = {
  ORDER_FULFILMENT_MODELS,
  DEFAULT_ORDER_FULFILMENT_MODEL,
  resolveOrderFulfilmentModel,
  isJobWorkOrder,
};
