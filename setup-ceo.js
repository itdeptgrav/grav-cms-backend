const { initializeApp } = require("firebase/app");
const { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, fetchSignInMethodsForEmail } = require("firebase/auth");
const { getDatabase, ref, set } = require("firebase/database");
require('dotenv').config();

// Firebase configuration
const firebaseConfig = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || "AIzaSyDpswQ3pSlbxtmc-yWDgJD2GQWjfpK3ZXs",
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || "grav-cms-38f45.firebaseapp.com",
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "grav-cms-38f45",
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || "grav-cms-38f45.firebasestorage.app",
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || "51268280312",
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || "1:51268280312:web:1667f085583f9fe4b6c00d",
    databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL || "https://grav-cms-38f45-default-rtdb.firebaseio.com"
};

console.log("Initializing Firebase with config:", {
    ...firebaseConfig,
    apiKey: firebaseConfig.apiKey.substring(0, 10) + "..."
});

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const database = getDatabase(app);

async function setupCEO() {
    try {
        // CEO credentials - CHANGE THESE TO YOUR PREFERRED VALUES
        const CEO_EMAIL = "ceo@coworking.com";
        const CEO_PASSWORD = "Test@123456"; // Make sure this is strong

        console.log(`\n🔍 Checking if CEO exists with email: ${CEO_EMAIL}`);

        try {
            // First, check if the user exists by trying to fetch sign-in methods
            const signInMethods = await fetchSignInMethodsForEmail(auth, CEO_EMAIL);

            if (signInMethods.length > 0) {
                console.log("✅ CEO email is registered. Attempting to sign in...");

                try {
                    // Try to sign in
                    const userCredential = await signInWithEmailAndPassword(auth, CEO_EMAIL, CEO_PASSWORD);
                    console.log("✅ Successfully signed in as CEO!");
                    console.log("📧 Email:", CEO_EMAIL);
                    console.log("🆔 UID:", userCredential.user.uid);

                    // Update or create employee record
                    const employeeRef = ref(database, `employees/${userCredential.user.uid}`);
                    await set(employeeRef, {
                        uid: userCredential.user.uid,
                        email: CEO_EMAIL,
                        name: "CEO",
                        role: "ceo",
                        displayId: "CEO001",
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                        createdBy: "system"
                    });

                    console.log("✅ CEO record updated in database");
                    console.log("\n⚠️ IMPORTANT: Make sure to set the custom claim 'role: ceo' using Firebase Admin SDK");

                } catch (signInError) {
                    console.error("❌ Sign in failed:", signInError.message);
                    console.log("\n💡 This might mean the password is incorrect.");
                    console.log("Try resetting the password in Firebase Console or use a different email.");
                }
            } else {
                console.log("👤 CEO not found. Creating new CEO account...");

                try {
                    // Create new user
                    const userCredential = await createUserWithEmailAndPassword(auth, CEO_EMAIL, CEO_PASSWORD);
                    console.log("✅ CEO account created successfully!");
                    console.log("📧 Email:", CEO_EMAIL);
                    console.log("🔑 Password:", CEO_PASSWORD);
                    console.log("🆔 UID:", userCredential.user.uid);

                    // Store in Realtime Database
                    const employeeRef = ref(database, `employees/${userCredential.user.uid}`);
                    await set(employeeRef, {
                        uid: userCredential.user.uid,
                        email: CEO_EMAIL,
                        name: "CEO",
                        role: "ceo",
                        displayId: "CEO001",
                        createdAt: new Date().toISOString(),
                        createdBy: "system"
                    });

                    console.log("✅ CEO info stored in Realtime Database");
                    console.log("\n📋 Save these credentials:");
                    console.log("Email:", CEO_EMAIL);
                    console.log("Password:", CEO_PASSWORD);
                    console.log("UID:", userCredential.user.uid);

                    console.log("\n⚠️ IMPORTANT: You still need to set the custom claim 'role: ceo'");
                    console.log("Create a file 'set-ceo-claim.js' with Firebase Admin SDK to set the role.");

                } catch (createError) {
                    console.error("❌ Failed to create CEO:", createError.message);

                    if (createError.code === 'auth/email-already-in-use') {
                        console.log("\n💡 Email already exists but we couldn't sign in.");
                        console.log("This might mean the password is different.");
                        console.log("Try resetting the password in Firebase Console:");
                        console.log("1. Go to Firebase Console → Authentication");
                        console.log("2. Find this user and click 'Reset Password'");
                    }
                }
            }

        } catch (checkError) {
            console.error("❌ Error checking user existence:", checkError.message);
        }

    } catch (error) {
        console.error("❌ Setup failed:", error.message);
    }
}

// Run the setup
setupCEO();