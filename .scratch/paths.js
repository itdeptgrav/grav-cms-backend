const mongoose = require("mongoose");
const S = require("../models/CMS_Models/Sales/SampleStyle");
const want = /(image|photo|artwork|file|attachment|url|sketch|document)/i;
const seen = [];
S.schema.eachPath((p) => { if (want.test(p)) seen.push(p); });
// walk arrays of subdocs
const walk = (schema, prefix) => {
  schema.eachPath((p, type) => {
    const full = prefix ? `${prefix}.${p}` : p;
    if (want.test(full)) seen.push(full);
    if (type.schema) walk(type.schema, full);
  });
};
walk(S.schema, "");
console.log([...new Set(seen)].sort().join("\n"));
