const CoworkCounter = require("../models/Workspace_Models/CoworkCounter");

async function generateCoworkId(type) {
  const fieldMap = {
    employee: { field: "employeeSeq", prefix: "E" },
    group:    { field: "groupSeq",    prefix: "G" },
    task:     { field: "taskSeq",     prefix: "T" },
    meet:     { field: "meetSeq",     prefix: "M" },
    conv:     { field: "convSeq",     prefix: "C" },
  };
  const { field, prefix } = fieldMap[type];
  const updated = await CoworkCounter.findOneAndUpdate(
    { _id: "cowork_counters" },
    { $inc: { [field]: 1 } },
    { new: true, upsert: true }
  );
  return `${prefix}${String(updated[field]).padStart(3, "0")}`;
}

module.exports = { generateCoworkId };
