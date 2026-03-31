const { initializeApp } = require("firebase/app");
const { getAuth, createUserWithEmailAndPassword } = require("firebase/auth");
const { getDatabase, ref, set } = require("firebase/database");
require('dotenv').config();

const firebaseConfig = {
    apiKey: "AIzaSyDpswQ3pSlbxtmc-yWDgJD2GQWjfpK3ZXs",
    authDomain: "grav-cms-38f45.firebaseapp.com",
    projectId: "grav-cms-38f45",
    storageBucket: "grav-cms-38f45.firebasestorage.app",
    messagingSenderId: "51268280312",
    appId: "1:51268280312:web:1667f085583f9fe4b6c00d",
    databaseURL: "https://grav-cms-38f45-default-rtdb.firebaseio.com"
};

console.log("🚀 Creating CEO account...");

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const database = getDatabase(app);

async function createCEO() {
    try {
        // Use a simple, strong password
        const CEO_EMAIL = "ceo@coworking.com";
        const CEO_PASSWORD = "CEO@123456"; // Change this if you want

        console.log(`📧 Email: ${CEO_EMAIL}`);
        console.log(`🔑 Password: ${CEO_PASSWORD}`);

        // Create the user
        const userCredential = await createUserWithEmailAndPassword(auth, CEO_EMAIL, CEO_PASSWORD);
        const user = userCredential.user;

        console.log("✅ CEO account created successfully!");
        console.log("🆔 UID:", user.uid);

        // Store in Realtime Database
        const employeeRef = ref(database, `employees/${user.uid}`);
        await set(employeeRef, {
            uid: user.uid,
            email: CEO_EMAIL,
            name: "CEO",
            role: "ceo",
            displayId: "CEO001",
            createdAt: new Date().toISOString(),
            createdBy: "system"
        });

        console.log("✅ CEO info stored in database");
        console.log("\n📋 LOGIN CREDENTIALS (SAVE THESE):");
        console.log("Email:", CEO_EMAIL);
        console.log("Password:", CEO_PASSWORD);
        console.log("UID:", user.uid);

    } catch (error) {
        console.error("❌ Error:", error.code, error.message);

        if (error.code === 'auth/email-already-in-use') {
            console.log("\n⚠️ Email already exists! Try signing in with the correct password.");
            console.log("If you forgot the password, you can:");
            console.log("1. Go to Firebase Console → Authentication");
            console.log("2. Find this user and click 'Reset Password'");
            console.log("3. Or delete the user and run this script again");
        }
    }
}

createCEO();