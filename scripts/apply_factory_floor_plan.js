// Add the ground floor (drawing A-101 rev A) to the factory twin's saved layout.
//
//   node scripts/apply_factory_floor_plan.js            dry run: validate and print
//   node scripts/apply_factory_floor_plan.js --save     write a new layout version
//
// The Conference Room (calibrated camera NVR1:11) is not on this drawing and is
// left exactly as it is; the floor is placed beside it, offset by
// --origin-x (default 6.05 m). Rooms from an earlier run are replaced by id.
// Every room's furniture goes through the same validation as the layout editor;
// the write is a compare-and-set on the config version.
"use strict";
require("dotenv").config({ quiet: true });
const mongoose = require("mongoose");
const SystemSetting = require("../models/DevOps/SystemSetting");
const { normalizedFurniture } = require("../services/cctv/factoryTwinConfig.service");
const { groundFloorRooms } = require("../services/cctv/factoryFloorPlan");

const KEY = "cctv.factory_twin.primary";
const save = process.argv.includes("--save");
const originArg = process.argv.find((a) => a.startsWith("--origin-x="));
const originX = originArg ? Number(originArg.split("=")[1]) : 6.05;

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const row = await SystemSetting.findOne({ key: KEY }).lean();
  if (!row?.value?.layout) throw new Error("No factory twin configuration saved yet.");
  const current = row.value;
  const floor = groundFloorRooms({ originM: { x: originX, z: 0 } });
  const ids = new Set(floor.map((r) => r.id));
  const kept = current.layout.rooms.filter((r) => !ids.has(r.id));
  for (const room of floor) room.furniture = normalizedFurniture(room.furniture, room);
  const next = {
    ...current,
    layout: { ...current.layout, rooms: [...kept, ...floor] },
    version: Number(current.version || 0) + 1,
    updatedBy: current.updatedBy,
  };
  console.log(`config v${current.version} -> v${next.version}: kept ${kept.map((r) => r.id).join(", ")}; floor plan ${floor.length} rooms, ${floor.reduce((n, r) => n + r.furniture.length, 0)} doors, ${floor.reduce((n, r) => n + r.openings.length, 0)} openings`);
  if (!save) { await mongoose.disconnect(); return; }
  const saved = await SystemSetting.findOneAndUpdate(
    { key: KEY, "value.version": current.version },
    { $set: { value: next, updatedByEmail: next.updatedBy, updatedByName: "Floor plan A-101 rev A" } },
    { new: true },
  ).lean();
  if (!saved) throw new Error("The configuration changed while this ran; nothing was written. Run it again.");
  console.log(`saved v${saved.value.version}: ${saved.value.layout.rooms.length} rooms`);
  await mongoose.disconnect();
})().catch(async (error) => { console.error(error.message); await mongoose.disconnect().catch(() => {}); process.exit(1); });
