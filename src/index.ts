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
        await sendMessage("<i>Bot started successfully.</i>");
        startScheduler();

        process.once("SIGINT", async () => {
            bot.stop("SIGINT");
            process.exit(0);
        });
        process.once("SIGTERM", async () => {
            bot.stop("SIGTERM");
            process.exit(0);
        });
    } catch (error) {
        console.error("Failed to start bot:", error);
        process.exit(1);
    }
})();
