"use strict";

const MAX_LINKS = 12;
const MAX_LABEL_LENGTH = 120;

const STORE_RECORD_ROUTES = Object.freeze({
  unit: (id) => `/store/dashboard/configurations/units-packaging/add-edit-unit/${id}`,
  warehouse: (id) => `/store/dashboard/configurations/warehouse/add-edit-warehouse/${id}`,
  machine: (id) => `/store/dashboard/configurations/devices-machines/add-edit-machine/${id}`,
  material_request: (id) => `/store/dashboard/order-requests/mrf/${id}`,
  purchase_order: (id) => `/store/dashboard/operations/purchase-order/${id}`,
  service_order: (id) => `/store/dashboard/operations/service-orders/${id}`,
  inventory_item_master: (id) => `/store/dashboard/raw-items/raw-items-view/${id}`,
  supplier_master: (id) => `/store/dashboard/vendors-buyer/vendors/view/${id}`,
  supplier_offer: (id) => `/store/dashboard/supplier-offers/${id}`,
  service_supplier_offer: (id) => `/store/dashboard/supplier-offers/services/${id}`,
  customer_material_expectation: (id) => `/store/dashboard/operations/customer-materials/${id}`,
  customer_material_lot: (id) => `/store/dashboard/operations/customer-materials/${id}`,
  goods_receipt: (id) => `/store/dashboard/operations/goods-receipts/${id}`,
  intake_request: (id) => `/store/dashboard/order-requests/intake/${id}`,
  spend_request: (id) => `/store/dashboard/order-requests/quote/${id}`,
});

function safeId(value) {
  const id = String(value || "").trim();
  return /^[a-zA-Z0-9_-]{1,100}$/.test(id) ? encodeURIComponent(id) : null;
}

function storeRecordHref(entity, recordId) {
  const id = safeId(recordId);
  const builder = STORE_RECORD_ROUTES[entity];
  return id && builder ? builder(id) : null;
}

function sanitizeAssistantLink(value) {
  if (!value || typeof value !== "object") return null;
  const href = String(value.href || "").trim();
  const label = String(value.label || "Open record").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH);
  // Assistant navigation is deliberately same-origin. This rejects schemes,
  // protocol-relative URLs, fragments and any model-supplied external target.
  if (!label || !href.startsWith("/") || href.startsWith("//") || /[\r\n\\]/.test(href)) return null;
  let parsed;
  try {
    parsed = new URL(href, "http://grav.local");
  } catch {
    return null;
  }
  if (parsed.origin !== "http://grav.local" || !parsed.pathname.startsWith("/")) return null;
  return Object.freeze({ label, href: `${parsed.pathname}${parsed.search}${parsed.hash}`, kind: "record" });
}

function sanitizeAssistantLinks(values) {
  const seen = new Set();
  const links = [];
  for (const value of Array.isArray(values) ? values : []) {
    const link = sanitizeAssistantLink(value);
    if (!link || seen.has(link.href)) continue;
    seen.add(link.href);
    links.push(link);
    if (links.length >= MAX_LINKS) break;
  }
  return links;
}

function recordLink(entity, recordId, label) {
  const href = storeRecordHref(entity, recordId);
  return href ? sanitizeAssistantLink({ href, label: `Open ${label || "record"}` }) : null;
}

module.exports = {
  MAX_LINKS,
  STORE_RECORD_ROUTES,
  sanitizeAssistantLink,
  sanitizeAssistantLinks,
  storeRecordHref,
  recordLink,
};
