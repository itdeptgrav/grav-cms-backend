// routes/CMS_Routes/Sales/salesDepartmentRules.js
//
// Sales-side "Department" tab on a customer's profile: define a
// department + designation, pick products (gender-tagged), then either
// save it as a draft or "Save & Assign" — which fans the gender-appropriate
// products out to every EmployeeMpc row under this customer whose
// department+designation match, replacing that employee's product list.
//
// Mounted at /api/cms/sales/customers/:customerId/department-rules in
// server.js, behind the same EmployeeAuthForMpc + customerId-param gate
// used for the sibling employees (MPC) mount.

const express = require("express");
const router = express.Router({ mergeParams: true });
const mongoose = require("mongoose");

const DepartmentProductRule = require("../../../models/Customer_Models/DepartmentProductRule");
const EmployeeMpc = require("../../../models/Customer_Models/Employee_Mpc");
const Customer = require("../../../models/Customer_Models/Customer");
const StockItem = require("../../../models/CMS_Models/Inventory/Products/StockItem");

// Products selectable here must stay inside the customer's assigned catalog —
// same whitelist rule the MPC product picker uses.
async function getAssignedStockItemIds(customerId) {
  const customer = await Customer.findById(customerId)
    .select("assignedStockItems.stockItemId")
    .lean();
  if (!customer) return null;
  return (customer.assignedStockItems || [])
    .map((a) => a.stockItemId)
    .filter(Boolean);
}

function genderMatchesProduct(employeeGender, productGenderCategory) {
  const gc = (productGenderCategory || "").toLowerCase();
  if (gc === "unisex" || gc === "") return true;
  return gc === employeeGender.toLowerCase();
}

// Department/designation are free-typed on both the rule and every employee
// record independently, so "IT" vs "it", "IT " with a trailing space, or
// "IT  Department" with doubled internal spacing must all still count as the
// same value — any of those silently breaks the rule<->employee match with
// no visible sign why. `.collation()` alone only buys case-insensitivity, not
// whitespace tolerance, so every query that matches on these two fields goes
// through this regex builder instead: case-insensitive, and every run of
// whitespace in the trimmed text becomes `\s+` (matches 1-or-more spaces of
// any kind), anchored so "IT" doesn't accidentally match "ITemp".
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function looseTextMatch(value) {
  const trimmed = (value || "").trim();
  const pattern = trimmed
    .split(/\s+/)
    .map(escapeRegExp)
    .join("\\s+");
  // `\s*` on both ends, not just `^`/`$`: the STORED (employee-side) value is
  // the one actually being tested against this regex, and it may carry its
  // own stray leading/trailing whitespace that trimming the rule's own text
  // does nothing to catch.
  return { $regex: `^\\s*${pattern}\\s*$`, $options: "i" };
}

// ─── GET / — list rules for this customer ──────────────────────────────
router.get("/", async (req, res) => {
  try {
    const rules = await DepartmentProductRule.find({
      customerId: req.customerId,
    })
      .sort({ department: 1, designation: 1 })
      .lean();
    res.status(200).json({ success: true, rules });
  } catch (error) {
    console.error("List department rules error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── GET /lookup — resolve the rule for a dept+designation(+gender) ────
// Used by the MPC add/edit form to auto-populate an employee's products
// once gender, department and designation are all selected.
router.get("/lookup", async (req, res) => {
  try {
    const { department = "", designation = "", gender = "" } = req.query;
    if (!department.trim() || !designation.trim()) {
      return res.status(200).json({ success: true, rule: null, products: [] });
    }
    const rule = await DepartmentProductRule.findOne({
      customerId: req.customerId,
      department: looseTextMatch(department),
      designation: looseTextMatch(designation),
    }).lean();

    if (!rule) {
      return res
        .status(200)
        .json({ success: true, rule: null, products: [], totalProducts: 0 });
    }

    const products = gender
      ? rule.products.filter((p) => genderMatchesProduct(gender, p.genderCategory))
      : rule.products;

    // `totalProducts` lets the caller tell "no rule at all" apart from "rule
    // exists but none of its products are tagged for this gender" — those
    // read identically as an empty `products` array otherwise, and they mean
    // very different things to whoever is staring at the form.
    res.status(200).json({
      success: true,
      rule,
      products,
      totalProducts: rule.products.length,
    });
  } catch (error) {
    console.error("Lookup department rule error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── GET /:ruleId ────────────────────────────────────────────────────────
router.get("/:ruleId", async (req, res) => {
  try {
    const rule = await DepartmentProductRule.findOne({
      _id: req.params.ruleId,
      customerId: req.customerId,
    }).lean();
    if (!rule) {
      return res.status(404).json({ success: false, message: "Rule not found" });
    }
    res.status(200).json({ success: true, rule });
  } catch (error) {
    console.error("Get department rule error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── Core upsert: one (department, designation) pair ────────────────────
// Shared by the single-designation routes below AND the /bulk route, which
// is what the "one department, many designations" editor actually calls —
// a department is set up once, in one save, across all of its designations.
async function upsertOneDesignation({
  customerId,
  actor,
  department,
  designation,
  products,
  assign,
  assignedIdSet,
}) {
  if (!department?.trim() || !designation?.trim()) {
    return { error: "Department and designation are required" };
  }
  if (!Array.isArray(products) || products.length === 0) {
    return { error: `Select at least one product for "${designation}"` };
  }

  const requestedIds = products
    .map((p) => p.productId)
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .filter((id) => assignedIdSet.has(String(id)));

  if (!requestedIds.length) {
    return {
      error: `None of the selected products for "${designation}" are in this customer's catalog`,
    };
  }

  const stockItems = await StockItem.find({ _id: { $in: requestedIds } })
    .select("name genderCategory")
    .lean();
  const stockItemMap = new Map(stockItems.map((s) => [s._id.toString(), s]));

  const ruleProducts = requestedIds
    .map((id) => {
      const item = stockItemMap.get(String(id));
      if (!item) return null;
      return {
        productId: item._id,
        productName: item.name,
        genderCategory: item.genderCategory || "",
      };
    })
    .filter(Boolean);

  const deptTrim = department.trim();
  const desigTrim = designation.trim();

  const update = {
    department: deptTrim,
    designation: desigTrim,
    products: ruleProducts,
    status: assign ? "assigned" : "draft",
    updatedBy: actor?.id,
  };

  let rule = await DepartmentProductRule.findOne({
    customerId,
    department: looseTextMatch(deptTrim),
    designation: looseTextMatch(desigTrim),
  });

  if (rule) {
    Object.assign(rule, update);
  } else {
    rule = new DepartmentProductRule({
      ...update,
      customerId,
      createdBy: actor?.id,
      createdByName: actor?.name || "",
    });
  }

  let assignedCount = 0;
  if (assign) {
    const employees = await EmployeeMpc.find({
      customerId,
      department: looseTextMatch(deptTrim),
      designation: looseTextMatch(desigTrim),
    });

    await Promise.all(
      employees.map((emp) => {
        const genderProducts = ruleProducts.filter((p) =>
          genderMatchesProduct(emp.gender, p.genderCategory),
        );
        emp.products = genderProducts.map((p) => ({
          productId: p.productId,
          quantity: 1,
          productName: p.productName,
        }));
        emp.updatedBy = actor?.id;
        return emp.save();
      }),
    );
    assignedCount = employees.length;
    rule.lastAssignedAt = new Date();
    rule.lastAssignedCount = assignedCount;
  }

  await rule.save();
  return { rule, assignedCount };
}

// ─── POST /bulk — one department, many designations, one save ──────────
// Body: { department, designations: [{ designation, products: [{productId}] }], assign }
// Sales sets a department up completely — every designation it has, each
// with its own product list — in a single Save as Draft / Save & Assign,
// instead of repeating the whole flow per designation.
router.post("/bulk", async (req, res) => {
  try {
    const { department, designations, assign } = req.body;

    if (!department?.trim()) {
      return res.status(400).json({ success: false, message: "Department is required" });
    }
    if (!Array.isArray(designations) || designations.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Add at least one designation",
      });
    }

    const assignedIds = await getAssignedStockItemIds(req.customerId);
    if (assignedIds === null) {
      return res.status(404).json({ success: false, message: "Customer not found" });
    }
    const assignedIdSet = new Set(assignedIds.map(String));

    const results = [];
    const errors = [];
    for (const d of designations) {
      const { rule, assignedCount, error } = await upsertOneDesignation({
        customerId: req.customerId,
        actor: req.onBehalfActor,
        department,
        designation: d.designation,
        products: d.products,
        assign: !!assign,
        assignedIdSet,
      });
      if (error) errors.push(error);
      else results.push({ rule, assignedCount });
    }

    if (!results.length) {
      return res.status(400).json({ success: false, message: errors.join("; ") });
    }

    const totalAssigned = results.reduce((sum, r) => sum + (r.assignedCount || 0), 0);
    res.status(200).json({
      success: true,
      rules: results.map((r) => r.rule),
      assignedCount: totalAssigned,
      errors,
      message: assign
        ? `Saved ${results.length} designation(s) and assigned to ${totalAssigned} employee(s).`
        : `Saved ${results.length} designation(s) as draft.`,
    });
  } catch (error) {
    console.error("Bulk save department rules error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── Shared save handler: create/update a single (department, designation) ─
async function saveRule(req, res, { assign }) {
  try {
    const { department, designation, products } = req.body;
    const assignedIds = await getAssignedStockItemIds(req.customerId);
    if (assignedIds === null) {
      return res.status(404).json({ success: false, message: "Customer not found" });
    }
    const assignedIdSet = new Set(assignedIds.map(String));

    const { rule, assignedCount, error } = await upsertOneDesignation({
      customerId: req.customerId,
      actor: req.onBehalfActor,
      department,
      designation,
      products,
      assign,
      assignedIdSet,
    });

    if (error) {
      return res.status(400).json({ success: false, message: error });
    }

    res.status(200).json({
      success: true,
      rule,
      assignedCount,
      message: assign
        ? `Saved and assigned to ${assignedCount} employee(s).`
        : "Saved as draft.",
    });
  } catch (error) {
    console.error("Save department rule error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─── POST / — save a single designation as draft ────────────────────────
router.post("/", (req, res) => saveRule(req, res, { assign: false }));

// ─── POST /assign — save a single designation and assign ───────────────
router.post("/assign", (req, res) => saveRule(req, res, { assign: true }));

// ─── POST /:ruleId/assign — re-run assignment for an existing rule ─────
router.post("/:ruleId/assign", async (req, res) => {
  try {
    const rule = await DepartmentProductRule.findOne({
      _id: req.params.ruleId,
      customerId: req.customerId,
    });
    if (!rule) {
      return res.status(404).json({ success: false, message: "Rule not found" });
    }

    const employees = await EmployeeMpc.find({
      customerId: req.customerId,
      department: looseTextMatch(rule.department),
      designation: looseTextMatch(rule.designation),
    });

    await Promise.all(
      employees.map((emp) => {
        const genderProducts = rule.products.filter((p) =>
          genderMatchesProduct(emp.gender, p.genderCategory),
        );
        emp.products = genderProducts.map((p) => ({
          productId: p.productId,
          quantity: 1,
          productName: p.productName,
        }));
        emp.updatedBy = req.onBehalfActor?.id;
        return emp.save();
      }),
    );

    rule.status = "assigned";
    rule.lastAssignedAt = new Date();
    rule.lastAssignedCount = employees.length;
    await rule.save();

    res.status(200).json({
      success: true,
      rule,
      assignedCount: employees.length,
      message: `Assigned to ${employees.length} employee(s).`,
    });
  } catch (error) {
    console.error("Assign department rule error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── DELETE /:ruleId ─────────────────────────────────────────────────────
router.delete("/:ruleId", async (req, res) => {
  try {
    const rule = await DepartmentProductRule.findOneAndDelete({
      _id: req.params.ruleId,
      customerId: req.customerId,
    });
    if (!rule) {
      return res.status(404).json({ success: false, message: "Rule not found" });
    }
    res.status(200).json({ success: true, message: "Rule deleted" });
  } catch (error) {
    console.error("Delete department rule error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
