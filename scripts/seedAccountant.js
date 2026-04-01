// scripts/seedAccountant.js
// Run this once to create a default accountant user in your database
// Usage: node scripts/seedAccountant.js
// Or just paste the createDefaultAccountant() function into your server.js boot sequence

require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const MONGO_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing";

// Schema (mirrors your existing AccountantDepartment model)
const accountantSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    name: { type: String, required: true },
    employeeId: { type: String, required: true, unique: true },
    phone: { type: String, required: true },
    department: { type: String, default: "Accounting" },
    role: { type: String, default: "accountant" },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

accountantSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

const AccountantDepartment = mongoose.model("AccountantDepartment", accountantSchema);

async function seedAccountant() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("✅ Connected to MongoDB");

    // Check if accountant already exists
    const existing = await AccountantDepartment.findOne({ email: "accountant@grav.in" });
    if (existing) {
      console.log("✅ Accountant user already exists:");
      console.log(`   Email: accountant@grav.in`);
      console.log(`   Name: ${existing.name}`);
      console.log(`   EmployeeId: ${existing.employeeId}`);
      console.log("\n   Password is already hashed. If you forgot it, run this script with --reset flag.");

      if (process.argv.includes("--reset")) {
        existing.password = "Account@12345";
        await existing.save();
        console.log("\n🔑 Password RESET to: Account@12345");
      }
    } else {
      const accountant = new AccountantDepartment({
        name: "Accountant Admin",
        email: "accountant@grav.in",
        password: "Account@12345", // will be hashed by pre-save hook
        employeeId: "ACC001",
        phone: "9999999999",
        department: "Accounting",
        role: "accountant",
        isActive: true,
      });

      await accountant.save();

      console.log("✅ Default Accountant created successfully!");
      console.log("╔══════════════════════════════════════╗");
      console.log("║  ACCOUNTANT LOGIN CREDENTIALS        ║");
      console.log("╠══════════════════════════════════════╣");
      console.log("║  Email:    accountant@grav.in        ║");
      console.log("║  Password: Account@12345             ║");
      console.log("╚══════════════════════════════════════╝");
    }

    await mongoose.disconnect();
    console.log("\n✅ Done. MongoDB disconnected.");
    process.exit(0);
  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  }
}

seedAccountant();
