// // scripts/syncIdentityIdWithBiometricId.js
// // One-off: set identityId = biometricId for every employee that has a biometricId.
// // Uses bulkWrite so pre-save hooks (salary recalc, etc.) are bypassed by design.
// const dns = require("dns").setServers(["8.8.8.8", "8.8.4.4"]);
// require("dotenv").config();
// const mongoose = require("mongoose");
// const Employee = require("./models/Employee"); // <-- adjust path if different

// const DRY_RUN = process.argv.includes("--dry-run");

// async function run() {
//     const uri = "mongodb+srv://grav_whole_database:cms_grav_2025_database@gravcms.xgafkkg.mongodb.net/";
//     if (!uri) {
//         console.error("❌ MONGODB_URI not set in env");
//         process.exit(1);
//     }

//     await mongoose.connect(uri);
//     console.log(`✅ Connected to MongoDB  ${DRY_RUN ? "(DRY RUN)" : ""}`);

//     try {
//         // Pull only what we need
//         const employees = await Employee.find(
//             { biometricId: { $exists: true, $nin: [null, ""] } },
//             { biometricId: 1, identityId: 1, firstName: 1, lastName: 1 }
//         ).lean();

//         console.log(`Found ${employees.length} employees with a biometricId`);

//         const ops = [];
//         let alreadySynced = 0;
//         const toUpdatePreview = [];

//         for (const e of employees) {
//             if (e.identityId === e.biometricId) {
//                 alreadySynced++;
//                 continue;
//             }
//             toUpdatePreview.push(
//                 `  ${e.biometricId.padEnd(8)}  ${e.firstName || ""} ${e.lastName || ""}`.trim() +
//                 `   (was: ${e.identityId ?? "—"})`
//             );
//             ops.push({
//                 updateOne: {
//                     filter: { _id: e._id },
//                     update: {
//                         $set: { identityId: e.biometricId, updatedAt: new Date() },
//                     },
//                 },
//             });
//         }

//         console.log(`Already in sync : ${alreadySynced}`);
//         console.log(`Needs update    : ${ops.length}`);

//         if (toUpdatePreview.length) {
//             console.log("\n-- Changes --");
//             console.log(toUpdatePreview.slice(0, 20).join("\n"));
//             if (toUpdatePreview.length > 20) {
//                 console.log(`  ...and ${toUpdatePreview.length - 20} more`);
//             }
//         }

//         if (ops.length === 0) {
//             console.log("\n👍 Nothing to do.");
//             return;
//         }

//         if (DRY_RUN) {
//             console.log("\n(DRY RUN) No changes written.");
//             return;
//         }

//         const result = await Employee.bulkWrite(ops, { ordered: false });
//         console.log("\n✅ Bulk write done");
//         console.log(`   matched : ${result.matchedCount}`);
//         console.log(`   modified: ${result.modifiedCount}`);

//         // Heads-up on the ones we skipped
//         const noBioCount = await Employee.countDocuments({
//             $or: [
//                 { biometricId: { $exists: false } },
//                 { biometricId: null },
//                 { biometricId: "" },
//             ],
//         });
//         if (noBioCount > 0) {
//             console.log(
//                 `\n⚠️  ${noBioCount} employees have no biometricId and were skipped.`
//             );
//         }
//     } catch (err) {
//         console.error("❌ Error:", err);
//         process.exitCode = 1;
//     } finally {
//         await mongoose.disconnect();
//         console.log("Disconnected.");
//     }
// }

// run();