const want = /(image|photo|artwork|file|attachment|url|sketch|document|reference)/i;
const dump = (label, schema) => {
  const seen = [];
  const walk = (s, prefix) => s.eachPath((p, type) => {
    const full = prefix ? `${prefix}.${p}` : p;
    if (want.test(full)) seen.push(full);
    if (type.schema) walk(type.schema, full);
  });
  walk(schema, "");
  console.log(`\n##### ${label}`);
  console.log([...new Set(seen)].sort().join("\n") || "(none)");
};
const DR = require("../models/CMS_Models/Sales/DevelopmentRequest");
const req = DR.SalesDevelopmentRequest;
dump("Sales DevelopmentRequest", req.schema);
dump("StockItem", require("../models/CMS_Models/Inventory/Products/StockItem").schema);
