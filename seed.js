require("dotenv").config();
const { auth } = require("./config/firebaseAdmin"); // ← Import auth directly

// CEO credentials
const CEO_EMAIL = "ceo@grav.com";
const CEO_PASSWORD = "CEO@Sgrav2024!";
const CEO_NAME = "Admin CEO";

async function seed() {
  try {
    console.log("\n🚀 Pushing CEO to Firebase Auth...\n");

    // Check if CEO already exists in Firebase
    let userRecord;
    try {
      userRecord = await auth.createUser({
        email: CEO_EMAIL,
        password: CEO_PASSWORD,
        displayName: CEO_NAME
      });
      console.log("✅ Firebase Auth CEO created:", userRecord.uid);
    } catch (err) {
      if (err.code === "auth/email-already-exists") {
        userRecord = await auth.getUserByEmail(CEO_EMAIL);
        console.log("✅ CEO already exists in Firebase:", userRecord.uid);
      } else {
        throw err;
      }
    }

    // Set custom claim for CEO role
    await auth.setCustomUserClaims(userRecord.uid, { role: "ceo" });
    console.log("✅ Custom claim 'role: ceo' set");

    console.log("\n🎉 Seed completed successfully!");
    console.log("=================================");
    console.log("📧 Email:", CEO_EMAIL);
    console.log("🔑 Password:", CEO_PASSWORD);
    console.log("🆔 Firebase UID:", userRecord.uid);
    console.log("=================================\n");

    process.exit(0);

  } catch (err) {
    console.error("❌ Seed failed:", err);
    process.exit(1);
  }
}

seed();