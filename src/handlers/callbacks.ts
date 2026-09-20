import { Context } from "telegraf";
import { UserService } from "../services/UserService";
import { userSessions } from "./commands";
import { performBalanceCheck, performOverview, performRechargeHistory } from "../utils/balanceChecker";
import { refreshSchedules } from "../scheduler";
import { MAX_OVERVIEW_DAYS } from "../utils/overview";
import { ADMIN_CHAT_ID, bot } from "../bot";
import {
    ANNOUNCE_CONFIRM,
    ANNOUNCE_DISMISS,
    sendPendingAnnouncement,
    dismissPendingAnnouncement,
} from "../utils/announcer";

export async function handleCallbackQuery(ctx: Context) {
    const data = ctx.callbackQuery && "data" in ctx.callbackQuery ? ctx.callbackQuery.data : null;
    const userId = ctx.from?.id;

    if (!userId || !data) return;

    await ctx.answerCbQuery();

    if (data === ANNOUNCE_CONFIRM || data === ANNOUNCE_DISMISS) {
        // Broadcasting reaches every user, so it stays with the admin alone.
        if (userId !== ADMIN_CHAT_ID) {
            await ctx.reply("❌ Not available.");
            return;
        }

        if (data === ANNOUNCE_DISMISS) {
            await ctx.reply(dismissPendingAnnouncement());
            return;
        }

        await ctx.reply("📢 Sending announcement...");
        await ctx.reply(await sendPendingAnnouncement(bot), { parse_mode: "HTML" });
        return;
    }

    if (data === "cancel") {
        userSessions.delete(userId);
        await ctx.reply("❌ Operation cancelled.");
        return;
    }

    if (data === "use_saved") {
        const user = await UserService.getUser(userId);
        if (!user || (!user.accountNo && !user.meterNo)) {
            await ctx.reply("❌ No saved account details found. Please use /start to set up.");
            return;
        }

        console.log(`User ${userId} requesting balance with accountNo: ${user.accountNo}, meterNo: ${user.meterNo}`);

        await ctx.reply("Fetching balance using your saved account... ⏳");
        await performBalanceCheck(ctx, {
            accountNo: user.accountNo,
            meterNo: user.meterNo
        });
    } else if (data.startsWith("usage_")) {
        const choice = data.slice("usage_".length);

        if (choice === "custom") {
            userSessions.set(userId, { step: "usage_custom_days" });
            await ctx.reply(
                `How many days would you like to see? (1–${MAX_OVERVIEW_DAYS})`
            );
            return;
        }

        const user = await UserService.getUser(userId);
        if (!user || (!user.accountNo && !user.meterNo)) {
            await ctx.reply("❌ No saved account details found. Please use /start to set up.");
            return;
        }

        await ctx.reply(`Building your ${choice}-day overview... ⏳`);
        await performOverview(
            ctx,
            { accountNo: user.accountNo, meterNo: user.meterNo },
            Number(choice)
        );
    } else if (data.startsWith("recharges_")) {
        const days = Number(data.slice("recharges_".length));

        const user = await UserService.getUser(userId);
        if (!user || (!user.accountNo && !user.meterNo)) {
            await ctx.reply("❌ No saved account details found. Please use /start to set up.");
            return;
        }

        await ctx.reply("Loading your recharge history... ⏳");
        await performRechargeHistory(
            ctx,
            { accountNo: user.accountNo, meterNo: user.meterNo },
            days
        );
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
    } else if (data === "update_threshold_days") {
        userSessions.set(userId, { step: "update_threshold_days" });
        await ctx.reply(
            "⏳ <b>Days-Left Warning</b>\n\n" +
            "Your balance is compared against how fast you actually use power, " +
            "so you get warned with enough time to recharge.\n\n" +
            "How many days of power left should trigger a warning?\n\n" +
            "<i>Example: 5 (warn when about 5 days of power remain)</i>\n" +
            "<i>Type '0' to disable and use only the BDT threshold</i>",
            { parse_mode: "HTML" }
        );
    } else if (data === "update_hourly") {
        userSessions.set(userId, { step: "update_hourly_threshold" });
        await ctx.reply(
            "⏰ <b>Low Balance Alerts</b>\n\n" +
            "When your balance falls below a certain amount, your account is re-checked hourly. " +
            "DESCO publishes one reading per day, so you'll get one alert per new reading.\n\n" +
            "Please enter the minimum balance threshold (in BDT):\n\n" +
            "<i>Example: 50 (you'll be alerted when balance ≤ 50 BDT)</i>\n" +
            "<i>Type '0' to disable these alerts</i>",
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
