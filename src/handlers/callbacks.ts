import { Context } from "telegraf";
import { UserService } from "../services/UserService";
import { userSessions } from "./commands";
import { performBalanceCheck } from "../utils/balanceChecker";
import { refreshSchedules } from "../scheduler";

export async function handleCallbackQuery(ctx: Context) {
    const data = ctx.callbackQuery && "data" in ctx.callbackQuery ? ctx.callbackQuery.data : null;
    const userId = ctx.from?.id;

    if (!userId || !data) return;

    await ctx.answerCbQuery();

    if (data === "cancel") {
        userSessions.delete(userId);
        await ctx.reply("❌ Operation cancelled.");
        return;
    }

    if (data === "use_default") {
        await ctx.reply("Fetching balance using default account... ⏳");
        await performBalanceCheck(ctx, { useDefaults: true });
    } else if (data === "use_saved") {
        const user = await UserService.getUser(userId);
        if (!user || (!user.accountNo && !user.meterNo)) {
            await ctx.reply("❌ No saved account details found. Please use /start to set up.");
            return;
        }
        await ctx.reply("Fetching balance using your saved account... ⏳");
        await performBalanceCheck(ctx, {
            accountNo: user.accountNo,
            meterNo: user.meterNo
        });
    } else if (data === "enter_custom") {
        userSessions.set(userId, { step: "waiting_for_account" });
        await ctx.reply("Please enter your Account Number (or type 'skip' to omit):");
    } else if (data === "update_account") {
        userSessions.set(userId, { step: "update_account_no" });
        await ctx.reply("Please enter your new Account Number (or type 'skip' to keep current):");
    } else if (data === "update_times") {
        userSessions.set(userId, { step: "update_notification_times" });
        await ctx.reply(
            "⏰ Enter notification times in 24-hour format, separated by commas.\n\n" +
            "Example: 08:00, 16:00, 20:00\n\n" +
            "Please enter your preferred times:"
        );
    } else if (data === "update_threshold") {
        userSessions.set(userId, { step: "update_threshold" });
        await ctx.reply("Please enter your new low balance threshold (in BDT):");
    } else if (data === "update_hourly") {
        userSessions.set(userId, { step: "update_hourly_threshold" });
        await ctx.reply(
            "⏰ <b>Hourly Low Balance Alerts</b>\n\n" +
            "When your balance falls below a certain amount, you can receive alerts every hour.\n\n" +
            "Please enter the minimum balance threshold for hourly notifications (in BDT):\n\n" +
            "<i>Example: 50 (you'll get hourly alerts when balance ≤ 50 BDT)</i>\n" +
            "<i>Type '0' to disable hourly alerts</i>",
            { parse_mode: "HTML" }
        );
    } else if (data === "toggle_subscription") {
        const user = await UserService.getUser(userId);
        if (!user) return;

        const newStatus = !user.isSubscribed;
        await UserService.updateSubscription(userId, newStatus);

        // Refresh notification schedules
        await refreshSchedules();

        const statusText = newStatus ? "✅ ON" : "❌ OFF";
        const message = newStatus
            ? `✅ Notifications enabled!\n\nYou'll receive balance updates at: ${user.notificationTimes.join(", ")}`
            : "❌ Notifications disabled.";

        await ctx.reply(message);
    }
}
