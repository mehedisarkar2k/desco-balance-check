import { Telegraf } from "telegraf";
import dotenv from "dotenv";
dotenv.config();
const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    throw new Error("Missing Telegram bot credentials in .env");
}
export const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const chatId = TELEGRAM_CHAT_ID;
export async function sendMessage(text) {
    try {
        await bot.telegram.sendMessage(chatId, text, { parse_mode: "HTML" });
    }
    catch (err) {
        console.error("Failed to send Telegram message:", err.message);
    }
}
