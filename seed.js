require("dotenv").config();
const { auth, db, admin } = require("./config/firebaseAdmin"); // ← Add db and admin

// CEO credentials
const CEO_EMAIL = "ceo@grav.com";
const CEO_PASSWORD = "CEO@Sgrav2024!";
const CEO_NAME = "Admin CEO";

async function seed() {
  try {
    console.log("\n🚀 Pushing CEO to Firebase Auth & Firestore...\n");

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

    // Create CEO employee document in Firestore
    const employeeData = {
      employeeId: "E000",
      authUid: userRecord.uid,
      name: CEO_NAME,
      email: CEO_EMAIL,
      mobile: "",  // Add mobile if you have it
      city: "",    // Add city if you have it
      department: "Management",
      role: "ceo",
      profilePicUrl: null,
      fcmTokens: [],
      passwordChanged: true,  // CEO doesn't need to change password
      tempPassword: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection("cowork_employees").doc("E000").set(employeeData, { merge: true });
    console.log("✅ CEO employee document created in Firestore");

    // Create counters document (THIS IS WHAT YOU WERE MISSING)
    const countersRef = db.collection("cowork_meta").doc("counters");
    const countersDoc = await countersRef.get();

    if (!countersDoc.exists) {
      await countersRef.set({
        employeeSeq: 0,  // Start at 0 so next employee gets E001
        groupSeq: 0,
        taskSeq: 0,
        meetSeq: 0
      });
      console.log("✅ Counters document created in Firestore");
    } else {
      console.log("✅ Counters document already exists");
    }

    console.log("\n🎉 Seed completed successfully!");
    console.log("=================================");
    console.log("📧 Email:", CEO_EMAIL);
    console.log("🔑 Password:", CEO_PASSWORD);
    console.log("🆔 Firebase UID:", userRecord.uid);
    console.log("📁 Firestore: cowork_employees/E000 created");
    console.log("📁 Firestore: cowork_meta/counters created");
    console.log("=================================\n");

    process.exit(0);

  } catch (err) {
    console.error("❌ Seed failed:", err);
    process.exit(1);
  }
}

seed();