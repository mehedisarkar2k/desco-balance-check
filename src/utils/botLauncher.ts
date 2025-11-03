import { Telegraf } from "telegraf";

/**
 * Start bot with retry logic for network resilience
 */
export async function startBotWithRetry(bot: Telegraf, maxRetries = 5) {
    let retries = 0;
    const baseDelay = 5000; // 5 seconds

    while (retries < maxRetries) {
        try {
            console.log(`Launching bot... (Attempt ${retries + 1}/${maxRetries})`);
            await bot.launch({
                dropPendingUpdates: true, // Ignore old updates
            });
            console.log("✅ Bot launched successfully");
            return; // Success!
        } catch (error: any) {
            retries++;
            console.error(`❌ Bot launch failed (Attempt ${retries}/${maxRetries}):`, error.message);

            if (retries >= maxRetries) {
                console.error("🚨 Max retries reached. Exiting...");
                throw error;
            }

            // Exponential backoff: 5s, 7.5s, 11.25s, 16.875s, 25.3125s
            const delay = baseDelay * Math.pow(1.5, retries - 1);
            console.log(`⏳ Retrying in ${delay / 1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}
