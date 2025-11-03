import { Telegraf } from "telegraf";

/**
 * Start bot with retry logic for network resilience
 */
export async function startBotWithRetry(bot: Telegraf, maxRetries = 5) {
    let retries = 0;
    const baseDelay = 10000; // 10 seconds (increased from 5s)

    // First, try to delete any existing webhook to ensure we can use polling
    try {
        console.log("🔄 Removing any existing webhook...");
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        console.log("✅ Webhook removed (if any existed)");

        // Wait a bit after webhook deletion to ensure cleanup
        console.log("⏳ Waiting 3 seconds for cleanup...");
        await new Promise(resolve => setTimeout(resolve, 3000));
    } catch (webhookError: any) {
        console.warn("⚠️ Could not delete webhook (might not exist):", webhookError.message);
    }

    while (retries < maxRetries) {
        try {
            console.log(`Launching bot... (Attempt ${retries + 1}/${maxRetries})`);
            await bot.launch({
                dropPendingUpdates: true, // Ignore old updates
                allowedUpdates: [], // First launch with no updates
            });
            console.log("✅ Bot launched successfully");
            return; // Success!
        } catch (error: any) {
            retries++;
            console.error(`❌ Bot launch failed (Attempt ${retries}/${maxRetries}):`, error.message);

            // Send notification on first failure
            if (retries === 1) {
                try {
                    await bot.telegram.sendMessage(
                        932626321,
                        `⚠️ <b>Bot Launch Issue</b>\n\n` +
                        `<b>Error:</b> ${error.message}\n` +
                        `<b>Retrying...</b> (${maxRetries} attempts total)`,
                        { parse_mode: "HTML" }
                    );
                } catch (notifyErr) {
                    console.error("Failed to send retry notification");
                }
            }

            if (retries >= maxRetries) {
                console.error("🚨 Max retries reached. Exiting...");

                // Send final failure notification
                try {
                    await bot.telegram.sendMessage(
                        932626321,
                        `🚨 <b>Bot Launch Failed</b>\n\n` +
                        `<b>Error:</b> ${error.message}\n` +
                        `<b>Attempts:</b> ${maxRetries}\n` +
                        `<b>Action Required:</b> Check logs and fix the issue`,
                        { parse_mode: "HTML" }
                    );
                } catch (notifyErr) {
                    console.error("Failed to send failure notification");
                }

                throw error;
            }

            // Exponential backoff: 5s, 7.5s, 11.25s, 16.875s, 25.3125s
            const delay = baseDelay * Math.pow(1.5, retries - 1);
            console.log(`⏳ Retrying in ${delay / 1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}
