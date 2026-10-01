"use strict";

/**
 * One general, read-only accounting query capability for the assistant.
 *
 * Qwen may choose only semantic field ids from the public reporting catalogue.
 * GRAV rebuilds and validates the layout, injects the signed-in user's
 * organisation/company scope, and executes through the existing MBQL-only
 * reporting engine. No model output can name a database column, table, tenant,
 * company, SQL fragment, Metabase id or credential.
 */

const catalogue = require("../reporting/fieldCatalogue");
const { validateLayout, LayoutError } = require("../reporting/reportLayout.validate");
const budget = require("../reporting/previewBudget");
const mongoose = require("mongoose");

const FIELD_IDS = Object.freeze(catalogue.fieldIds());
const CALCULATIONS = Object.freeze([...catalogue.CALCULATIONS]);
const FILTER_OPERATIONS = Object.freeze(
  [...new Set(Object.values(catalogue.OPERATIONS_BY_TYPE).flat())].sort(),
);

const parameters = Object.freeze({
  type: "object",
  properties: {
    rowFields: {
      type: "array",
      items: { type: "string", enum: [...FIELD_IDS] },
      maxItems: 5,
      description: "Fields to display (detail mode) or group by (summary mode).",
    },
    measures: {
      type: "array",
      items: {
        type: "object",
        properties: {
          field: { type: "string", enum: [...FIELD_IDS] },
          calculation: { type: "string", enum: [...CALCULATIONS] },
        },
        required: ["field", "calculation"],
        additionalProperties: false,
      },
      maxItems: 8,
      description: "Calculated values. Leave empty for a detail list.",
    },
    filters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          field: { type: "string", enum: [...FIELD_IDS] },
          operation: { type: "string", enum: [...FILTER_OPERATIONS] },
          value: {
            type: "array",
            items: { type: "string", maxLength: 200 },
            minItems: 1,
            maxItems: 50,
            description: "One string for a single-value filter; two for between; one or more for in.",
          },
        },
        required: ["field", "operation", "value"],
        additionalProperties: false,
      },
      maxItems: 20,
    },
    sort: {
      type: "array",
      items: {
        type: "object",
        properties: {
          field: { type: "string", enum: [...FIELD_IDS] },
          direction: { type: "string", enum: ["asc", "desc"] },
        },
        required: ["field", "direction"],
        additionalProperties: false,
      },
      maxItems: 3,
    },
    limit: { type: "integer", minimum: 1, maximum: 15 },
  },
  required: ["rowFields", "measures", "filters", "sort", "limit"],
  additionalProperties: false,
});

function cleanQuery(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rowFields = Array.isArray(raw.rowFields) ? raw.rowFields : null;
  const measures = Array.isArray(raw.measures) ? raw.measures : null;
  const filters = Array.isArray(raw.filters) ? raw.filters : null;
  const sort = Array.isArray(raw.sort) ? raw.sort : null;
  if (!rowFields || !measures || !filters || !sort) return null;
  if (rowFields.length > 5 || measures.length > 8 || filters.length > 20 || sort.length > 3) return null;
  if (!Number.isInteger(raw.limit) || raw.limit < 1 || raw.limit > 15) return null;

  const fieldOk = (id) => typeof id === "string" && FIELD_IDS.includes(id);
  if (!rowFields.every(fieldOk)) return null;
  if (!measures.every((m) => m && fieldOk(m.field) && CALCULATIONS.includes(m.calculation))) return null;
  if (!filters.every((f) => f && fieldOk(f.field) && FILTER_OPERATIONS.includes(f.operation)
    && Object.prototype.hasOwnProperty.call(f, "value"))) return null;
  if (!sort.every((s) => s && fieldOk(s.field) && ["asc", "desc"].includes(s.direction))) return null;

  const normalizedFilters = filters.map((f) => {
    const def = catalogue.fieldOf(f.field);
    let operation = f.operation;
    // Structured-output schemas cannot express an enum conditional on another
    // property. Canonicalise the universal equality synonym by field type,
    // then still require the server descriptor to authorise the operation.
    if (["text", "choice", "boolean"].includes(def.type) && operation === "equals") operation = "is";
    if (["date", "datetime"].includes(def.type) && ["equals", "is"].includes(operation)) operation = "on";
    if (["money", "number", "integer"].includes(def.type) && operation === "is") operation = "equals";
    if (!def.filterOperations.includes(operation)) return null;
    const values = Array.isArray(f.value) ? f.value : [f.value];
    if (values.length === 0 || values.length > 50) return null;
    const multi = ["between", "in"].includes(operation);
    if (operation === "between" && values.length !== 2) return null;
    if (!multi && values.length !== 1) return null;
    return {
      field: f.field,
      operation,
      value: multi ? values : values[0],
    };
  });
  if (normalizedFilters.some((f) => f === null)) return null;

  return {
    rowFields: [...rowFields],
    measures: measures.map((m) => ({ field: m.field, calculation: m.calculation })),
    filters: normalizedFilters,
    sort: sort.map((s) => ({ field: s.field, direction: s.direction })),
    limit: raw.limit,
  };
}

function rawLayout(query, companyIds) {
  return {
    name: "Assistant accounting query",
    companyIds,
    rows: query.rowFields.map((field) => ({ field })),
    columns: [],
    values: query.measures.map(({ field, calculation }) => ({ field, calculation })),
    filters: query.filters,
    comparisons: [],
    sort: query.sort,
    showRowTotals: true,
    showColumnTotals: true,
    showGrandTotal: true,
    limit: query.limit,
  };
}

function formatValue(cell, type) {
  if (!cell || cell.value === null || cell.value === undefined) return "—";
  if (cell.text) return String(cell.text);
  if (type === "money" || cell.semanticType === "currency" || cell.semanticType === "currency_signed") {
    const n = Number(cell.value);
    return Number.isFinite(n)
      ? new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(n)
      : String(cell.value);
  }
  return String(cell.value);
}

function formatMatrix(matrix) {
  const leaves = Array.isArray(matrix && matrix.leafColumns) ? matrix.leafColumns : [];
  const rows = Array.isArray(matrix && matrix.rows)
    ? matrix.rows.filter((row) => row && row.kind === "data")
    : [];
  if (rows.length === 0) return "No matching accounting records were found.";

  const lines = rows.map((row, index) => {
    const labels = Array.isArray(row.labels)
      ? row.labels.map((label) => label === null || label === undefined || label === "" ? "(none)" : String(label))
      : [];
    const cells = (row.cells || []).map((cell, i) => {
      const heading = leaves[i] && leaves[i].heading ? leaves[i].heading : `Value ${i + 1}`;
      return `${heading}: ${formatValue(cell, leaves[i] && leaves[i].type)}`;
    });
    const body = [...labels, ...cells].join(" — ");
    return `${index + 1}. ${body}`;
  });
  const suffix = matrix.truncated
    ? ` Showing ${matrix.previewRowCount} of ${matrix.totalRowCount} matching rows.`
    : "";
  return `${lines.join("\n")}${suffix}`;
}

/**
 * Verify the result shape before a number reaches chat. This is intentionally
 * independent of the model: it checks the deterministic executor honoured the
 * validated dimensions, bounded row count and requested ordering. A malformed
 * or unresolved result is an error, never a plausible-looking answer.
 */
function verifyPreview(layout, matrix) {
  if (!matrix || !Array.isArray(matrix.rows) || !Array.isArray(matrix.leafColumns)) {
    return { ok: false, reason: "report_result_invalid" };
  }
  const rows = matrix.rows.filter((row) => row && row.kind === "data");
  if (rows.length > layout.limit) return { ok: false, reason: "report_limit_not_enforced" };
  const expectedCells = layout.mode === "detail" ? layout.rows.length : layout.values.length;
  const requiredLabels = layout.mode === "summary" ? layout.rows.length : 0;
  const requiresResolvedLedgerDimension = layout.mode === "summary" && layout.rows.some((row) =>
    ["ledger.name", "ledger.group"].includes(row.field.id));

  for (const row of rows) {
    if (!Array.isArray(row.cells) || row.cells.length !== expectedCells) {
      return { ok: false, reason: "report_result_shape_mismatch" };
    }
    if (layout.mode === "summary") {
      if (!Array.isArray(row.labels) || row.labels.length !== requiredLabels) {
        return { ok: false, reason: "report_result_shape_mismatch" };
      }
      if (requiresResolvedLedgerDimension && row.labels.some((label, index) => {
        const id = layout.rows[index] && layout.rows[index].field.id;
        return ["ledger.name", "ledger.group"].includes(id)
          && (label === null || label === undefined || String(label).trim() === "");
      })) return { ok: false, reason: "report_unresolved_ledger_dimension" };
    }
    for (let index = 0; index < row.cells.length; index += 1) {
      const def = layout.mode === "detail" ? layout.rows[index].field : layout.values[index].field;
      if (["money", "number", "integer"].includes(def.type)
          && !Number.isFinite(Number(row.cells[index].value))) {
        return { ok: false, reason: "report_non_numeric_measure" };
      }
    }
  }

  for (const order of layout.sort) {
    const rowIndex = layout.rows.findIndex((row) => row.field.id === order.field.id);
    const valueIndex = layout.values.findIndex((value) => value.field.id === order.field.id);
    if (rowIndex < 0 && valueIndex < 0) continue;
    const values = rows.map((row) => rowIndex >= 0 ? row.labels[rowIndex] : row.cells[valueIndex].value);
    for (let index = 1; index < values.length; index += 1) {
      const previous = values[index - 1];
      const current = values[index];
      const comparison = typeof previous === "number" && typeof current === "number"
        ? previous - current
        : String(previous).localeCompare(String(current));
      if ((order.direction === "desc" && comparison < 0) || (order.direction === "asc" && comparison > 0)) {
        return { ok: false, reason: "report_sort_not_enforced" };
      }
    }
  }
  return { ok: true };
}

// Financial year is derived from the accounting date instead of trusting the
// optional denormalised `financialYear` string on an imported voucher. Imports
// created before that field existed (and corrected voucher dates) otherwise
// disappear from an FY report even though their accounting date is valid.
const INDIAN_FINANCIAL_YEAR = Object.freeze({
  $let: {
    vars: {
      calendarYear: { $year: { date: "$voucherDate", timezone: "Asia/Kolkata" } },
      calendarMonth: { $month: { date: "$voucherDate", timezone: "Asia/Kolkata" } },
    },
    in: {
      $let: {
        vars: {
          startYear: {
            $cond: [
              { $gte: ["$$calendarMonth", 4] },
              "$$calendarYear",
              { $subtract: ["$$calendarYear", 1] },
            ],
          },
        },
        in: {
          $concat: [
            { $toString: "$$startYear" },
            "-",
            {
              $substrBytes: [
                { $toString: { $add: ["$$startYear", 1] } },
                2,
                2,
              ],
            },
          ],
        },
      },
    },
  },
});

const MASTER_NAME = {
  $let: {
    vars: { value: { $ifNull: ["$ledgerMaster.name", ""] } },
    in: {
      $cond: [
        { $gt: [{ $strLenCP: "$$value" }, 0] },
        "$$value",
        "$ledgerEntries.ledgerName",
      ],
    },
  },
};

const MASTER_GROUP = {
  $let: {
    vars: { value: { $ifNull: ["$ledgerMaster.groupName", ""] } },
    in: {
      $cond: [
        { $gt: [{ $strLenCP: "$$value" }, 0] },
        "$$value",
        "$ledgerEntries.groupName",
      ],
    },
  },
};

const PROJECT = Object.freeze({
  "company.name": { $ifNull: [{ $arrayElemAt: ["$company.name", 0] }, ""] },
  "date.voucher": "$voucherDate",
  "date.month": { $dateToString: { format: "%Y-%m-01", date: "$voucherDate", timezone: "Asia/Kolkata" } },
  "date.financial_year": INDIAN_FINANCIAL_YEAR,
  "voucher.number": "$voucherNumber",
  "voucher.type": "$voucherType",
  "voucher.narration": { $ifNull: ["$ledgerEntries.narration", "$narration"] },
  // Ledger names/groups are master data. Voucher-line copies are retained only
  // as a fallback for a deleted legacy ledger; stale/null copies must not create
  // a fake `(none)` group or split one ledger across old names.
  "ledger.name": MASTER_NAME,
  "ledger.group": MASTER_GROUP,
  "party.name": "$partyLedgerName",
  "amount.debit": { $cond: [{ $eq: ["$ledgerEntries.type", "Dr"] }, "$ledgerEntries.amount", 0] },
  "amount.credit": { $cond: [{ $eq: ["$ledgerEntries.type", "Cr"] }, "$ledgerEntries.amount", 0] },
  "amount.signed": {
    $ifNull: [
      "$ledgerEntries.signedAmount",
      { $cond: [{ $eq: ["$ledgerEntries.type", "Dr"] }, "$ledgerEntries.amount", { $multiply: [-1, "$ledgerEntries.amount"] }] },
    ],
  },
  "tax.classification": "$ledgerEntries.gstClassification",
});

const mongoAlias = (index) => `f${index}`;
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function filterExpression(alias, def, operation, value) {
  if (["date", "datetime"].includes(def.type)) {
    const date = (v, end = false) => new Date(`${v}T${end ? "23:59:59.999" : "00:00:00.000"}Z`);
    if (operation === "on") return { [alias]: { $gte: date(value), $lte: date(value, true) } };
    if (operation === "before") return { [alias]: { $lt: date(value) } };
    if (operation === "after") return { [alias]: { $gt: date(value, true) } };
    if (operation === "between") return { [alias]: { $gte: date(value[0]), $lte: date(value[1], true) } };
  }
  if (["money", "number", "integer"].includes(def.type)) {
    if (operation === "equals") return { [alias]: Number(value) };
    if (operation === "greater_than") return { [alias]: { $gt: Number(value) } };
    if (operation === "less_than") return { [alias]: { $lt: Number(value) } };
    if (operation === "between") return { [alias]: { $gte: Number(value[0]), $lte: Number(value[1]) } };
  }
  if (operation === "is") return { [alias]: new RegExp(`^${escapeRegExp(value)}$`, "i") };
  if (operation === "in") return { [alias]: { $in: value.map((v) => new RegExp(`^${escapeRegExp(v)}$`, "i")) } };
  if (operation === "contains") return { [alias]: new RegExp(escapeRegExp(value), "i") };
  if (operation === "starts_with") return { [alias]: new RegExp(`^${escapeRegExp(value)}`, "i") };
  return null;
}

function accumulator(calculation, path) {
  if (calculation === "total") return { $sum: path };
  if (calculation === "average") return { $avg: path };
  if (calculation === "minimum") return { $min: path };
  if (calculation === "maximum") return { $max: path };
  return { $sum: { $cond: [{ $ne: [path, null] }, 1, 0] } };
}

/** Native, company-scoped execution for chat. The custom-report UI may still
 * use Metabase, but the assistant does not depend on that optional process. */
async function runNativePreview({ layout, companyIds }) {
  if (!mongoose.connection.db) throw new Error("accounting_database_unavailable");
  const ids = companyIds.map((id) => new mongoose.Types.ObjectId(id));
  const fields = [];
  const addField = (def) => {
    let index = fields.findIndex((f) => f.id === def.id);
    if (index === -1) { index = fields.length; fields.push(def); }
    return mongoAlias(index);
  };
  [...layout.rows, ...layout.values, ...layout.filters, ...layout.sort].forEach((entry) => addField(entry.field));
  const project = { _id: 0 };
  fields.forEach((def, index) => { project[mongoAlias(index)] = PROJECT[def.id]; });
  const pipeline = [
    { $match: { companyId: { $in: ids }, status: "posted" } },
    { $lookup: { from: "acc_companies", localField: "companyId", foreignField: "_id", as: "company" } },
    { $unwind: "$ledgerEntries" },
    { $lookup: { from: "acc_ledgers", localField: "ledgerEntries.ledgerId", foreignField: "_id", as: "ledgerMasterRows" } },
    { $set: { ledgerMaster: { $arrayElemAt: ["$ledgerMasterRows", 0] } } },
    { $project: project },
  ];
  const match = {};
  for (const f of layout.filters) {
    const expression = filterExpression(addField(f.field), f.field, f.operation, f.value);
    if (!expression) throw new Error("unsupported_filter");
    Object.assign(match, expression);
  }
  if (Object.keys(match).length) pipeline.push({ $match: match });

  const leafColumns = layout.mode === "detail"
    ? layout.rows.map((r) => ({ heading: r.heading, type: r.field.type, semanticType: r.field.semanticType }))
    : layout.values.map((v) => ({ heading: v.heading, type: v.field.type, semanticType: v.field.semanticType }));

  if (layout.mode === "detail") {
    const sort = {};
    for (const s of layout.sort) sort[addField(s.field)] = s.direction === "desc" ? -1 : 1;
    const base = [...pipeline];
    const countRows = await mongoose.connection.db.collection("acc_vouchers")
      .aggregate([...base, { $count: "count" }]).toArray();
    if (Object.keys(sort).length) pipeline.push({ $sort: sort });
    pipeline.push({ $limit: layout.limit });
    const docs = await mongoose.connection.db.collection("acc_vouchers").aggregate(pipeline).toArray();
    const total = countRows[0] ? countRows[0].count : 0;
    return {
      mode: "detail", leafColumns,
      rows: docs.map((doc) => ({
        kind: "data", labels: [],
        cells: layout.rows.map((r) => ({ value: doc[addField(r.field)], semanticType: r.field.semanticType })),
      })),
      previewRowCount: docs.length, totalRowCount: total, truncated: total > docs.length,
    };
  }

  const groupId = {};
  layout.rows.forEach((r, index) => { groupId[`r${index}`] = `$${addField(r.field)}`; });
  const group = { _id: groupId };
  layout.values.forEach((v, index) => { group[`m${index}`] = accumulator(v.calculation, `$${addField(v.field)}`); });
  pipeline.push({ $group: group });
  const sort = {};
  for (const s of layout.sort) {
    const rowIndex = layout.rows.findIndex((r) => r.field.id === s.field.id);
    const valueIndex = layout.values.findIndex((v) => v.field.id === s.field.id);
    if (rowIndex >= 0) sort[`_id.r${rowIndex}`] = s.direction === "desc" ? -1 : 1;
    else if (valueIndex >= 0) sort[`m${valueIndex}`] = s.direction === "desc" ? -1 : 1;
  }
  const countPipeline = [...pipeline, { $count: "count" }];
  const countRows = await mongoose.connection.db.collection("acc_vouchers").aggregate(countPipeline).toArray();
  if (Object.keys(sort).length) pipeline.push({ $sort: sort });
  pipeline.push({ $limit: layout.limit });
  const docs = await mongoose.connection.db.collection("acc_vouchers").aggregate(pipeline).toArray();
  const total = countRows[0] ? countRows[0].count : 0;
  return {
    mode: "summary", leafColumns,
    rows: docs.map((doc) => ({
      kind: "data",
      labels: layout.rows.map((_, index) => doc._id[`r${index}`]),
      cells: layout.values.map((v, index) => ({ value: doc[`m${index}`], semanticType: v.field.semanticType })),
    })),
    previewRowCount: docs.length, totalRowCount: total, truncated: total > docs.length,
  };
}

async function runAccountingReport({ user, query, runPreview }) {
  const cleaned = cleanQuery(query);
  if (!cleaned) return { ok: false, reason: "invalid_report_query" };
  const access = user && user.accountingAccess;
  const organizationId = access && access.organizationId;
  const companyIds = access && Array.isArray(access.companyIds) ? access.companyIds.filter(Boolean) : [];
  if (!organizationId || companyIds.length === 0) return { ok: false, reason: "accounting_scope_unavailable" };

  let layout;
  try {
    layout = validateLayout(rawLayout(cleaned, companyIds), { approvedCompanyIds: companyIds, mode: "preview" });
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof LayoutError ? "invalid_report_layout" : "report_validation_failed",
    };
  }
  const cost = budget.estimate(layout, { organizationId });
  if (!cost.allowed) return { ok: false, reason: "report_too_complex" };

  try {
    const preview = runPreview
      ? await runPreview({ layout, organizationId, companyIds })
      : await runNativePreview({ layout, organizationId, companyIds });
    const verified = verifyPreview(layout, preview);
    if (!verified.ok) return { ok: false, reason: verified.reason };
    return { ok: true, reply: formatMatrix(preview), preview };
  } catch {
    return { ok: false, reason: "report_execution_failed" };
  }
}

module.exports = {
  FIELD_IDS,
  CALCULATIONS,
  FILTER_OPERATIONS,
  parameters,
  cleanQuery,
  rawLayout,
  formatMatrix,
  runNativePreview,
  runAccountingReport,
  verifyPreview,
  // Exported for contract tests; these are server-owned expressions, never
  // accepted from a model or caller.
  INDIAN_FINANCIAL_YEAR,
  PROJECT,
};
