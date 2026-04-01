require("dotenv").config();
const mongoose = require("mongoose");
const admin = require("./config/firebaseAdmin");
const CoworkEmployee = require("./models/Workspace_Models/CoworkEmployee");
const CoworkCounter = require("./models/Workspace_Models/CoworkCounter");

//ceo id  and pw
const CEO_EMAIL = "ceo@grav.com";
const CEO_PASSWORD = "CEO@Sgrav2024!";
const CEO_NAME = "Admin CEO";

async function seed() {
  try {
    // Use MONGODB_URI instead of MONGO_URI
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
      throw new Error("MONGODB_URI is not defined in .env file");
    }

    console.log("Connecting to MongoDB...");
    await mongoose.connect(mongoUri, {
      dbName: "grav-cms" // Specify database name since your URI doesn't include it
    });
    console.log("✅ MongoDB connected successfully");

    // Check if CEO already exists in Firebase
    let userRecord;
    try {
      userRecord = await admin.auth().createUser({
        email: CEO_EMAIL,
        password: CEO_PASSWORD,
        displayName: CEO_NAME
      });
      console.log("✅ Firebase Auth CEO created:", userRecord.uid);
    } catch (err) {
      if (err.code === "auth/email-already-exists") {
        userRecord = await admin.auth().getUserByEmail(CEO_EMAIL);
        console.log("✅ CEO already exists in Firebase:", userRecord.uid);
      } else {
        throw err;
      }
    }

    // Set custom claim for CEO role
    await admin.auth().setCustomUserClaims(userRecord.uid, { role: "ceo" });
    console.log("✅ Custom claim 'role: ceo' set");

    // Initialize counters
    await CoworkCounter.findOneAndUpdate(
      { _id: "cowork_counters" },
      {
        $setOnInsert: {
          employeeSeq: 0,
          groupSeq: 0,
          taskSeq: 0,
          meetSeq: 0,
          convSeq: 0
        }
      },
      { upsert: true, new: true }
    );
    console.log("✅ Counter initialized");

    // Check if employee exists in MongoDB
    const existing = await CoworkEmployee.findOne({ authUid: userRecord.uid });

    if (!existing) {
      await CoworkEmployee.create({
        employeeId: "E000",
        authUid: userRecord.uid,
        name: CEO_NAME,
        email: CEO_EMAIL,
        mobile: "+91 9000000000",
        city: "Bhubaneswar",
        department: "Management",
        role: "ceo",
        isTemporaryPassword: false,
        active: true
      });
      console.log("✅ CEO employee document created in MongoDB (E000)");
    } else {
      console.log("✅ CEO already exists in MongoDB");

      // Update existing record to ensure it has active flag
      await CoworkEmployee.findOneAndUpdate(
        { authUid: userRecord.uid },
        {
          active: true,
          role: "ceo",
          updatedAt: new Date()
        }
      );
      console.log("✅ Updated existing CEO record");
    }

    console.log("\n🎉 Seed completed successfully!");
    console.log("=================================");
    console.log("📧 Email:", CEO_EMAIL);
    console.log("🔑 Password:", CEO_PASSWORD);
    console.log("🆔 Firebase UID:", userRecord.uid);
    console.log("=================================");

    await mongoose.disconnect();
    console.log("✅ MongoDB disconnected");
    process.exit(0);

  } catch (err) {
    console.error("❌ Seed failed:", err);
    process.exit(1);
  }
}

seed();