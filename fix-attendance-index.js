const dns = require("dns").setServers(["8.8.8.8", "8.8.4.4"]);
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");

const http = require("http");
const { Server } = require("socket.io");

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI || "mongodb://localhost:27017/test";

async function run() {
    await mongoose.connect(MONGODB_URI);
    console.log("Connected to MongoDB:", MONGODB_URI.replace(/\/\/.*@/, "//***@"));

    const db = mongoose.connection.db;
    const col = db.collection("attendances");

    // List all existing indexes
    const indexes = await col.indexes();
    console.log("Current indexes:", indexes.map(i => ({ name: i.name, key: i.key })));

    // Drop the old compound unique index on employeeId + dateString if it exists
    const badIndex = indexes.find(i => i.key?.employeeId !== undefined && i.key?.dateString !== undefined && i.unique);
    if (badIndex) {
        console.log(`Dropping bad index: ${badIndex.name}`);
        await col.dropIndex(badIndex.name);
        console.log("Dropped.");
    } else {
        console.log("Old index not found — skipping drop.");
    }

    // Create the correct unique index on biometricId + dateString
    const hasCorrectIndex = indexes.find(i => i.key?.biometricId !== undefined && i.key?.dateString !== undefined && i.unique);
    if (!hasCorrectIndex) {
        console.log("Creating correct index: { biometricId: 1, dateString: 1 } unique...");
        await col.createIndex({ biometricId: 1, dateString: 1 }, { unique: true, sparse: true, name: "biometricId_1_dateString_1" });
        console.log("Created.");
    } else {
        console.log("Correct index already exists — skipping create.");
    }

    // Verify
    const newIndexes = await col.indexes();
    console.log("Final indexes:", newIndexes.map(i => ({ name: i.name, key: i.key, unique: i.unique })));

    await mongoose.disconnect();
    console.log("Done! You can now run the biometric sync without E11000 errors.");
}

run().catch(err => {
    console.error("Migration failed:", err);
    process.exit(1);
});