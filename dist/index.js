import { bot } from "./bot";
import { startScheduler } from "./scheduler";
import { fetchBalance } from "./desco";
import { sendMessage } from "./bot";
bot.use(async (ctx, next) => {
    console.log("📨 Update received:", ctx.updateType, ctx.message);
    await next();
});
bot.command("start", async (ctx) => {
    await ctx.reply("DESCO bot ready. Use /balance anytime.");
});
bot.command("balance", async (ctx) => {
    try {
        const res = await fetchBalance();
        const message = `
<b>DESCO Balance:</b> <code>${res.balance.toFixed(2)}</code>
<b>Consumption:</b> <code>${res.currentMonthConsumption.toFixed(2)}</code>
<b>Reading:</b> <code>${res.readingTime}</code>
`;
        await ctx.reply(message, { parse_mode: "HTML" });
    }
    catch (e) {
        await ctx.reply(`Error: ${e.message}`);
    }
});
(async () => {
    console.log("Launching the TG bot");
    await bot.launch();
    await sendMessage("<i>Bot started successfully.</i>");
    startScheduler();
    process.once("SIGINT", () => bot.stop("SIGINT"));
    process.once("SIGTERM", () => bot.stop("SIGTERM"));
})();
