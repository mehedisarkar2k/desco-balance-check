import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

const DB_URL = process.env.DB_URL;
const DB_NAME = "desco-balance-check";

export async function connectDatabase() {
    try {
        if (!DB_URL) {
            throw new Error("DB_URL is not defined in environment variables");
        }

        await mongoose.connect(DB_URL, {
            dbName: DB_NAME,
        });

        console.log("✅ Connected to MongoDB");
    } catch (error) {
        console.error("❌ MongoDB connection error:", error);
        throw error;
    }
}

export async function disconnectDatabase() {
    try {
        await mongoose.disconnect();
        console.log("✅ Disconnected from MongoDB");
    } catch (error) {
        console.error("❌ MongoDB disconnection error:", error);
    }
}
