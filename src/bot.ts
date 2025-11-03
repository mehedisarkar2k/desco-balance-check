import { Telegraf } from "telegraf";
import dotenv from "dotenv";

dotenv.config();

const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    throw new Error("Missing Telegram bot credentials in .env");
}

export const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const chatId = TELEGRAM_CHAT_ID;

// Admin user (mehedisarkar2k)
export const ADMIN_USERNAME = "MehediSarkar2k";
export const ADMIN_CHAT_ID = 932626321;

export async function sendMessage(text: string, targetChatId?: number | string) {
    try {
        await bot.telegram.sendMessage(targetChatId || chatId, text, { parse_mode: "HTML" });
    } catch (err: any) {
        console.error("Failed to send Telegram message:", err.message);
    }
}
