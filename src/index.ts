import { bot, sendMessage } from "./bot";
import { startScheduler } from "./scheduler";
import { connectDatabase } from "./database";
import { startHealthCheckServer } from "./health";
import { startKeepAlive } from "./keepalive";
import { autoRegisterMiddleware } from "./middleware/autoRegister";
import { handleStart, handleHelp, handleMe, handleUpdate, handleBalance, handleSubscribe, handleUsage } from "./handlers/commands";
import { handleCallbackQuery } from "./handlers/callbacks";
import { handleTextMessage } from "./handlers/textMessages";
import { startBotWithRetry } from "./utils/botLauncher";

// Apply middleware
bot.use(autoRegisterMiddleware);

// Global error handler for bot errors
bot.catch(async (err: any, ctx: any) => {
    console.error("❌ Bot error:", err);
    try {
        await sendMessage(
            `🚨 <b>Bot Error</b>\n\n` +
            `<b>Error:</b> ${err.message}\n` +
            `<b>User:</b> ${ctx.from?.id || 'Unknown'}\n` +
            `<b>Update:</b> ${ctx.updateType}`,
            932626321 // Your admin chat ID
        );
    } catch (notifyError) {
        console.error("Failed to send error notification:", notifyError);
    }
});

// Register command handlers
bot.command("start", handleStart);
bot.command("help", handleHelp);
bot.command("me", handleMe);
bot.command("update", handleUpdate);
bot.command("balance", handleBalance);
bot.command("usage", handleUsage);
bot.command("subscribe", handleSubscribe);

// Register event handlers
bot.on("callback_query", handleCallbackQuery);
bot.on("text", handleTextMessage);

(async () => {
    try {
        // Check environment
        const environment = process.env.NODE_ENV || 'development';
        console.log(`🚀 Starting bot in ${environment} mode...`);

        // Warn if potentially running duplicate instances
        if (environment === 'development') {
            console.log('⚠️  Running in DEVELOPMENT mode');
            console.log('⚠️  Make sure production instance is STOPPED to avoid conflicts!');
            console.log('⚠️  If you see 409 errors, another instance is already running!');
        }

        // Check if bot is already running by trying to get bot info
        try {
            const botInfo = await bot.telegram.getMe();
            console.log(`✅ Bot authenticated as: @${botInfo.username}`);
        } catch (authError: any) {
            console.error('❌ Failed to authenticate bot:', authError.message);
            throw new Error('Bot token invalid or network issue');
        }

        // Start health check server (required for Render)
        console.log("Starting health check server...");
        startHealthCheckServer();

        // Start keep-alive mechanism (prevents Render from sleeping)
        console.log("Starting keep-alive mechanism...");
        startKeepAlive();

        console.log("Connecting to database...");
        await connectDatabase();

        console.log("Launching the TG bot with retry logic...");
        await startBotWithRetry(bot);
        await sendMessage("<i>Bot started successfully in " + environment + " mode.</i>");
        startScheduler();

        console.log(`✅ Bot is running and ready to serve multiple users!`);

        process.once("SIGINT", async () => {
            console.log("🛑 Shutting down gracefully...");
            await sendMessage("⏸️ <i>Bot shutting down...</i>", 932626321);
            bot.stop("SIGINT");
            process.exit(0);
        });
        process.once("SIGTERM", async () => {
            console.log("🛑 Shutting down gracefully...");
            await sendMessage("⏸️ <i>Bot shutting down...</i>", 932626321);
            bot.stop("SIGTERM");
            process.exit(0);
        });
    } catch (error: any) {
        console.error("❌ Failed to start bot:", error);

        // Try to send error notification to admin
        try {
            // Create a temporary bot instance just for sending the error
            const { Telegraf } = require("telegraf");
            const errorBot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || "");

            await errorBot.telegram.sendMessage(
                932626321,
                `🚨 <b>Bot Startup Failed</b>\n\n` +
                `<b>Error:</b> ${error.message}\n` +
                `<b>Stack:</b> <code>${error.stack?.substring(0, 500)}</code>\n` +
                `<b>Time:</b> ${new Date().toISOString()}`,
                { parse_mode: "HTML" }
            );
        } catch (notifyError) {
            console.error("❌ Failed to send startup error notification:", notifyError);
        }

        process.exit(1);
    }
})();

// Handle uncaught exceptions
process.on('uncaughtException', async (error) => {
    console.error('❌ Uncaught Exception:', error);

    try {
        await sendMessage(
            `🚨 <b>Uncaught Exception</b>\n\n` +
            `<b>Error:</b> ${error.message}\n` +
            `<b>Stack:</b> <code>${error.stack?.substring(0, 500)}</code>`,
            932626321
        );
    } catch (err) {
        console.error("Failed to send exception notification");
    }

    process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', async (reason: any) => {
    console.error('❌ Unhandled Rejection:', reason);

    try {
        await sendMessage(
            `🚨 <b>Unhandled Promise Rejection</b>\n\n` +
            `<b>Reason:</b> ${reason?.message || reason}\n` +
            `<b>Stack:</b> <code>${reason?.stack?.substring(0, 500) || 'No stack trace'}</code>`,
            932626321
        );
    } catch (err) {
        console.error("Failed to send rejection notification");
    }
});
