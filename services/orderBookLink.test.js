const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { originHeads } = require("./orderBookLink");

/* The route behaviour — PO linking, the chooser, company proof — is covered
   against a real database in test/crm/order-link.route.test.js. These pin the
   pure rule and the things the service must never do again. */

const r = (id, over = {}) => ({ _id: id, status: "pending", ...over });

test("the head of a supersession chain is the current order", () => {
  const heads = originHeads([
    r("a"),
    r("b", { salesOrigin: { supersedesRequestId: "a" } }),
    r("c", { salesOrigin: { supersedesRequestId: "b" } }),
  ]);
  assert.deepEqual(heads.map((h) => h._id), ["c"]);
});

test("a cancelled order is never a head", () => {
  assert.deepEqual(originHeads([r("a", { status: "cancelled" })]), []);
});

test("two unrelated orders from one enquiry are both heads — ambiguity is reported, not resolved", () => {
  assert.equal(originHeads([r("a"), r("b")]).length, 2);
});

const src = fs.readFileSync(path.join(__dirname, "orderBookLink.js"), "utf8")
  .replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

test("it never creates a CustomerRequest or a portal customer", () => {
  assert.ok(!/CustomerRequest\.create|new CustomerRequest\(|Customer\.create|new Customer\(/.test(src));
});

test("it never picks the newest order for a customer", () => {
  assert.ok(!/findOne\(\s*\{\s*customerId/.test(src), "a single order looked up by customer is a guess");
  assert.ok(!/\.findById\(\s*journey\.accountId/.test(src), "the account must be read under the caller's company");
});

test("there is one link writer, it claims the order first and is conditional on the link it expects", () => {
  const writes = src.match(/Enquiry\.(updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate)\(/g) || [];
  assert.equal(writes.length, 1, "every link write goes through writeLink");
  const writer = src.slice(src.indexOf("async function writeLink"), src.indexOf("/* ══ CANDIDATES"));
  assert.ok(writer.indexOf("claimOrder(") < writer.indexOf("Enquiry.findOneAndUpdate("), "claim before link");
  assert.match(writer, /customerRequestId: current \}/, "conditional on the link the caller saw");
  assert.ok(!/enquiry\.save\(/.test(src), "an unconditional save could overwrite a concurrent correction");
});

test("the enquiry routes no longer carry a name-match order guess", () => {
  const routes = fs.readFileSync(path.join(__dirname, "../routes/CMS_Routes/Sales/enquiries.js"), "utf8")
    .replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/async function resolveRequestId/.test(routes));
  assert.ok(!/PortalCustomer\.find/.test(routes), "a portal customer found by name is a guess");
});
