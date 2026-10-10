"use strict";

const receive = require("./storePurchase/receiveWorkspace.service");

const OPERATIONS = Object.freeze(["exists", "count", "list"]);
const STAGES = Object.freeze(["all", "expected", "action_required", "completed", "recorded"]);
const SOURCES = Object.freeze(["all", "purchased", "customer_owned"]);
const DATE_BASES = Object.freeze(["none", "expected_date", "receipt_date"]);

const stageMap = Object.freeze({
  action_required: receive.STAGE.ACTION,
  completed: receive.STAGE.COMPLETED,
});

function normalize(args = {}) {
  const operation = OPERATIONS.includes(args.operation) ? args.operation : "list";
  const stage = STAGES.includes(args.stage) ? args.stage : "all";
  const source = SOURCES.includes(args.source) ? args.source : "all";
  const dateBasis = DATE_BASES.includes(args.dateBasis) ? args.dateBasis : "none";
  const from = receive.validDate(args.from);
  const to = receive.validDate(args.to);
  const query = typeof args.query === "string" ? args.query.trim().slice(0, 200) : "";
  const limit = Math.min(20, Math.max(1, Number.isInteger(args.limit) ? args.limit : 10));
  return { operation, stage, source, dateBasis, from, to, query, limit };
}

function reconcileReceiveArgs(message, rawArgs = {}) {
  const args = { ...rawArgs };
  const words = String(message || "").toLowerCase();
  const namesCustomer = /\b(customer|customer-owned|customer owned)\b/.test(words);
  const namesPurchased = /\b(purchase|purchased|supplier|vendor|\bpo\b)\b/.test(words);
  if (!namesCustomer && !namesPurchased) args.source = "all";
  else if (namesCustomer && !namesPurchased) args.source = "customer_owned";
  else if (namesPurchased && !namesCustomer) args.source = "purchased";
  if (/\b(any|whether|do we have|is there|are there)\b/.test(words)) args.operation = "exists";
  else if (/\b(how many|count|number of)\b/.test(words)) args.operation = "count";
  return args;
}

function dateError(input, normalized) {
  if ((input.from && !normalized.from) || (input.to && !normalized.to)) {
    return "The requested date range contains an invalid calendar date.";
  }
  if (receive.dateBoundaries(normalized.from, normalized.to).invalid) {
    return "The requested From date is after the To date.";
  }
  if ((normalized.from || normalized.to) && normalized.dateBasis === "none") {
    return "A date range was supplied without saying whether it applies to expected or recorded dates.";
  }
  if (normalized.stage === "expected" && normalized.dateBasis === "receipt_date") {
    return "An expected arrival has no receipt date yet; use its expected date.";
  }
  if (["recorded", "action_required", "completed"].includes(normalized.stage)
      && normalized.dateBasis === "expected_date") {
    return "Recorded receipts are filtered by their receipt date, not an expected date.";
  }
  return null;
}

function wantedSource(source, expected) {
  if (source === "all") return true;
  return expected === "purchased" ? source === "purchased" : source === "customer_owned";
}

async function queryReceiveWorkspace({ user, args, message } = {}) {
  const input = reconcileReceiveArgs(message, args || {});
  const filters = normalize(input);
  const invalid = dateError(input, filters);
  if (invalid) return { ok: false, reason: invalid, filters, rows: [], coverage: [] };

  const tenant = user?.storePurchaseAccess;
  if (!tenant?.companyId) {
    return { ok: false, reason: "Store & Purchase company access could not be verified.", filters, rows: [], coverage: [] };
  }
  const ctx = { companyId: tenant.companyId, actorId: tenant.actorId, tenant };
  const coverage = [];
  const unavailable = [];
  let rows = [];

  const attempt = async (source, fn) => {
    try {
      const out = await fn();
      coverage.push({ source, ...(out.coverage || {}) });
      return out.rows || [];
    } catch (error) {
      unavailable.push({ source, reason: error?.message || "Source could not be read." });
      return [];
    }
  };

  const wantsExpected = filters.stage === "all" || filters.stage === "expected";
  // When an otherwise broad question explicitly chooses an expected-date
  // basis, recorded receipts are outside that temporal meaning. Likewise an
  // explicit receipt-date basis applies only to records that already exist.
  const wantsRecorded = filters.stage !== "expected" && filters.dateBasis !== "expected_date";
  if (wantsExpected) {
    const expectedDates = filters.dateBasis === "expected_date"
      ? { dateFrom: filters.from, dateTo: filters.to }
      : {};
    // A receipt-date question cannot constrain records that do not exist yet.
    if (filters.dateBasis !== "receipt_date") {
      if (wantedSource(filters.source, "purchased")) {
        rows = rows.concat(await attempt("expectedPurchased", () => receive.readExpectedPurchased(
          tenant, { search: filters.query, ...expectedDates },
        )));
      }
      if (wantedSource(filters.source, "customer_owned")) {
        rows = rows.concat(await attempt("expectedCustomer", () => receive.readExpectedCustomer(
          ctx, { search: filters.query, ...expectedDates },
        )));
      }
    }
  }

  if (wantsRecorded) {
    const recordedDates = filters.dateBasis === "receipt_date"
      ? { dateFrom: filters.from, dateTo: filters.to }
      : {};
    const source = filters.source === "customer_owned"
      ? receive.SOURCE.CUSTOMER
      : filters.source === "purchased" ? receive.SOURCE.PURCHASED : receive.SOURCE.ALL;
    let recorded = await attempt("recordedReceipts", () => receive.readRecordedReceipts(
      tenant, { source, search: filters.query, ...recordedDates },
    ));
    if (stageMap[filters.stage]) recorded = recorded.filter((row) => row.stage === stageMap[filters.stage]);
    rows = rows.concat(recorded);
  }

  rows.sort((a, b) => {
    const av = new Date(a.expectedDate || a.recordedDate || 0).getTime();
    const bv = new Date(b.expectedDate || b.recordedDate || 0).getTime();
    return av - bv || String(a.reference || "").localeCompare(String(b.reference || ""));
  });
  const truncated = coverage.some((item) => item.truncated);
  return {
    ok: true,
    filters,
    rows: rows.slice(0, filters.limit),
    matchingCount: rows.length,
    truncated,
    coverage,
    unavailable,
  };
}

function rowText(row) {
  const date = row.expectedDate || row.recordedDate;
  const dateText = date && !Number.isNaN(new Date(date).getTime())
    ? new Date(date).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })
    : "date not recorded";
  const party = row.partyLabel ? ` — ${row.partyLabel}` : "";
  return `${row.reference || row.orderReference || "Unnumbered arrival"}${party} (${dateText}, ${row.stage})`;
}

function renderReceiveQuery({ data } = {}) {
  if (!data?.ok) return data?.reason || "I couldn't verify that receiving query.";
  if (data.unavailable?.length) {
    const sources = data.unavailable.map((item) => item.source).join(", ");
    if (!data.rows.length) return `I couldn't verify the receiving answer because ${sources} could not be read.`;
  }
  const noun = data.filters.stage === "expected" ? "expected arrival" : "receiving record";
  const suffix = data.truncated ? " The result is from a bounded inspected set, so additional matches may exist." : "";
  if (data.filters.operation === "exists") {
    return data.matchingCount
      ? `Yes. I found ${data.matchingCount}${data.truncated ? " or more" : ""} matching ${noun}${data.matchingCount === 1 ? "" : "s"}.${suffix}`
      : `No matching ${noun}s were found in the verified sources.${suffix}`;
  }
  if (data.filters.operation === "count") {
    return `There ${data.matchingCount === 1 ? "is" : "are"} ${data.matchingCount}${data.truncated ? " or more" : ""} matching ${noun}${data.matchingCount === 1 ? "" : "s"}.${suffix}`;
  }
  if (!data.rows.length) return `No matching ${noun}s were found in the verified sources.${suffix}`;
  return `${data.matchingCount}${data.truncated ? " or more" : ""} matching ${noun}${data.matchingCount === 1 ? "" : "s"}: ${data.rows.map(rowText).join("; ")}.${suffix}`;
}

module.exports = {
  queryReceiveWorkspace, renderReceiveQuery, normalize, dateError, rowText,
  reconcileReceiveArgs, OPERATIONS, STAGES, SOURCES, DATE_BASES,
};
