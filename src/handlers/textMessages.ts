import { Context } from "telegraf";
import { UserService } from "../services/UserService";
import { userSessions } from "./commands";
import { performBalanceCheck, performOverview } from "../utils/balanceChecker";
import { refreshSchedules } from "../scheduler";
import { MIN_OVERVIEW_DAYS, MAX_OVERVIEW_DAYS } from "../utils/overview";
import { handleAiMessage } from "../ai";

export async function handleTextMessage(ctx: Context) {
    const userId = ctx.from?.id;
    const text = ctx.message && "text" in ctx.message ? ctx.message.text : null;

    if (!userId || !text) return;

    const session = userSessions.get(userId);

    // No guided flow in progress, so treat it as a question for the assistant.
    // Setup and update flows keep priority: a bare number mid-flow is an answer
    // to the question just asked, not a new request.
    if (!session) {
        await handleAiMessage(ctx, text);
        return;
    }

    // Setup flow (for /start)
    if (session.step === "setup_account") {
        if (text.toLowerCase() === "skip") {
            session.step = "setup_meter";
            await ctx.reply("Please enter your Meter Number:");
        } else {
            session.accountNo = text.trim();
            session.step = "setup_meter";
            await ctx.reply("Great! Now please enter your Meter Number (or type 'skip'):");
        }
        userSessions.set(userId, session);
    } else if (session.step === "setup_meter") {
        const meterNo = text.toLowerCase() === "skip" ? undefined : text.trim();
        const accountNo = session.accountNo;

        if (!accountNo && !meterNo) {
            await ctx.reply("❌ You must provide at least Account Number or Meter Number. Let's try again.\n\nPlease enter your Account Number (or type 'skip'):");
            session.step = "setup_account";
            userSessions.set(userId, session);
            return;
        }

        // Save to database
        await UserService.updateAccountDetails(userId, accountNo, meterNo);
        userSessions.delete(userId);

        await ctx.reply(
            "✅ Account details saved!\n\n" +
            `Account No: ${accountNo || "Not set"}\n` +
            `Meter No: ${meterNo || "Not set"}\n\n` +
            "You can now use /balance to check your balance.\n" +
            "Use /subscribe to enable automatic notifications!"
        );
    }
    // Balance check flow
    else if (session.step === "waiting_for_account") {
        if (text.toLowerCase() === "skip") {
            session.step = "waiting_for_meter";
            await ctx.reply("Please enter your Meter Number:");
        } else {
            session.accountNo = text.trim();
            session.step = "waiting_for_meter";
            await ctx.reply("Please enter your Meter Number:");
        }
        userSessions.set(userId, session);
    } else if (session.step === "waiting_for_meter") {
        session.meterNo = text.trim();
        await ctx.reply("Fetching balance... ⏳");
        await performBalanceCheck(ctx, {
            accountNo: session.accountNo,
            meterNo: session.meterNo
        });
        userSessions.delete(userId);
    }
    // Usage overview flow
    else if (session.step === "usage_custom_days") {
        const days = parseInt(text);

        if (isNaN(days) || days < MIN_OVERVIEW_DAYS || days > MAX_OVERVIEW_DAYS) {
            await ctx.reply(
                `❌ Please enter a number of days between ${MIN_OVERVIEW_DAYS} and ${MAX_OVERVIEW_DAYS} (e.g., 10)`
            );
            return;
        }

        const user = await UserService.getUser(userId);
        if (!user || (!user.accountNo && !user.meterNo)) {
            await ctx.reply("❌ Please set up your account using /start first.");
            userSessions.delete(userId);
            return;
        }

        userSessions.delete(userId);
        await ctx.reply(`Building your ${days}-day overview... ⏳`);
        await performOverview(ctx, { accountNo: user.accountNo, meterNo: user.meterNo }, days);
    }
    // Update flows
    else if (session.step === "update_account_no") {
        const accountNo = text.toLowerCase() === "skip" ? undefined : text.trim();
        session.accountNo = accountNo;
        session.step = "update_meter_no";
        await ctx.reply("Please enter your new Meter Number (or type 'skip' to keep current):");
        userSessions.set(userId, session);
    } else if (session.step === "update_meter_no") {
        const meterNo = text.toLowerCase() === "skip" ? undefined : text.trim();

        await UserService.updateAccountDetails(userId, session.accountNo, meterNo);
        userSessions.delete(userId);

        await ctx.reply("✅ Account details updated successfully!\n\nUse /me to view your updated information.");
    } else if (session.step === "update_notification_times") {
        const times = text.split(",").map(t => t.trim()).filter(t => /^\d{2}:\d{2}$/.test(t));

        if (times.length === 0) {
            await ctx.reply("❌ Invalid format. Please use HH:MM format (e.g., 08:00, 16:00)");
            return;
        }

        await UserService.updateNotificationTimes(userId, times);
        await refreshSchedules(); // Refresh schedules with new times
        userSessions.delete(userId);

        await ctx.reply(`✅ Notification times updated!\n\nYou'll receive updates at: ${times.join(", ")}`);
    } else if (session.step === "update_threshold") {
        const threshold = parseInt(text);

        if (isNaN(threshold) || threshold < 0) {
            await ctx.reply("❌ Please enter a valid number (e.g., 100)");
            return;
        }

        await UserService.updateThreshold(userId, threshold);
        userSessions.delete(userId);

        await ctx.reply(`✅ Low balance threshold updated to ${threshold} BDT`);
    } else if (session.step === "update_threshold_days") {
        const days = parseInt(text);

        if (isNaN(days) || days < 0 || days > 60) {
            await ctx.reply("❌ Please enter a number of days between 0 and 60 (e.g., 5)");
            return;
        }

        await UserService.updateThresholdDays(userId, days);
        userSessions.delete(userId);

        await ctx.reply(
            days > 0
                ? `✅ You'll be warned when your balance has about ${days} day(s) of power left.`
                : "✅ Days-left warnings disabled. Only the BDT threshold will trigger alerts."
        );
    } else if (session.step === "update_hourly_threshold") {
        const threshold = parseInt(text);

        if (isNaN(threshold) || threshold < 0) {
            await ctx.reply("❌ Please enter a valid number (e.g., 50) or 0 to disable");
            return;
        }

        const enabled = threshold > 0;
        await UserService.updateThreshold(userId, threshold);
        await UserService.updateHourlyNotification(userId, enabled);
        await refreshSchedules();
        userSessions.delete(userId);

        if (enabled) {
            await ctx.reply(
                `✅ Low balance alerts enabled!\n\n` +
                `Your balance will be checked hourly when it's ≤ ${threshold} BDT. ` +
                `DESCO publishes one reading per day, so you'll get one alert per reading — not one every hour.`
            );
        } else {
            await ctx.reply(`✅ Low balance alerts disabled.`);
        }
    }
}
