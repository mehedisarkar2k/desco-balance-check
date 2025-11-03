import { bot, sendMessage } from "./bot";
import { startScheduler } from "./scheduler";
import { connectDatabase } from "./database";
import { startHealthCheckServer } from "./health";
import { startKeepAlive } from "./keepalive";
import { autoRegisterMiddleware } from "./middleware/autoRegister";
import { handleStart, handleHelp, handleMe, handleUpdate, handleBalance, handleSubscribe } from "./handlers/commands";
import { handleCallbackQuery } from "./handlers/callbacks";
import { handleTextMessage } from "./handlers/textMessages";
import { startBotWithRetry } from "./utils/botLauncher";

// Apply middleware
bot.use(autoRegisterMiddleware);

// Register command handlers
bot.command("start", handleStart);
bot.command("help", handleHelp);
bot.command("me", handleMe);
bot.command("update", handleUpdate);
bot.command("balance", handleBalance);
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
            bot.stop("SIGINT");
            process.exit(0);
        });
        process.once("SIGTERM", async () => {
            console.log("🛑 Shutting down gracefully...");
            bot.stop("SIGTERM");
            process.exit(0);
        });
    } catch (error) {
        console.error("Failed to start bot:", error);
        process.exit(1);
    }
})();
