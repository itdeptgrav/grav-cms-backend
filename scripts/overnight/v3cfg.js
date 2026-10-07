require("dotenv").config();
const mongoose = require("mongoose");
const PatternGradingConfig = require("../../models/CMS_Models/Manufacturing/PatternGrading/PatternGradingConfig");
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const c = await PatternGradingConfig.findOne({ stockItemId: "69bee6b1aa8f71eb7fb2a5c0" }).lean();
  console.log(JSON.stringify(c.v3Config || c.v3 || null, null, 1));
  console.log("top-level keys:", Object.keys(c).join(", "));
  await mongoose.disconnect();
})();
