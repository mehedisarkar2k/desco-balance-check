import { Context } from "telegraf";
import { UserService } from "../services/UserService";
import { userSessions } from "./commands";
import { performOverview } from "../utils/balanceChecker";
import { refreshSchedules } from "../scheduler";
import { MIN_OVERVIEW_DAYS, MAX_OVERVIEW_DAYS } from "../utils/overview";
import { handleAiMessage } from "../ai";
import { handleNumberStep, isNumberStep } from "./onboarding";
import { parseTimes } from "../utils/times";
import { userIdOf } from "../services/SupportService";
import { ADMIN_CHAT_ID, bot } from "../bot";
import { getPendingText, sendAnnouncementPreview, setPendingText } from "../utils/announcer";
import { rewriteAnnouncement } from "../ai/announcementEditor";

export async function handleTextMessage(ctx: Context) {
    const userId = userIdOf(ctx);
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

    // Setup, update and one-off balance: one number is asked for and checked
    // with DESCO by the onboarding flow.
    if (isNumberStep(session.step)) {
        await handleNumberStep(ctx, session.step, text);
        return;
    }

    if (session.step === "announce_edit") {
        if (ctx.from?.id !== ADMIN_CHAT_ID) {
            userSessions.delete(userId);
            return;
        }
        const current = getPendingText();
        userSessions.delete(userId);
        if (!current) {
            await ctx.reply("⚠️ No announcement is pending.");
            return;
        }
        await ctx.reply("✏️ Rewriting… ⏳");
        try {
            const rewritten = await rewriteAnnouncement(current, text);
            setPendingText(rewritten);
            await sendAnnouncementPreview(bot);
        } catch (error: any) {
            await ctx.reply(`❌ Rewrite failed: ${String(error?.message || error).split("\n")[0]}`);
        }
        return;
    }

    // Usage overview flow
    if (session.step === "usage_custom_days") {
        const days = parseInt(text);

        if (isNaN(days) || days < MIN_OVERVIEW_DAYS || days > MAX_OVERVIEW_DAYS) {
            await ctx.reply(
                `❌ Please enter a number of days between ${MIN_OVERVIEW_DAYS} and ${MAX_OVERVIEW_DAYS} (e.g., 10), or /cancel to stop.`
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
    else if (session.step === "update_notification_times") {
        // Validated in full rather than filtered: the old filter silently
        // dropped some entries and let "08:60" through to the scheduler.
        const times = parseTimes(text.split(","));

        if (!times) {
            await ctx.reply("❌ Please use 24-hour HH:MM times from 00:00 to 23:59, e.g. 08:00, 16:00 (or /cancel to stop).");
            return;
        }

        await UserService.updateNotificationTimes(userId, times);
        await refreshSchedules(); // Refresh schedules with new times
        userSessions.delete(userId);

        await ctx.reply(`✅ Notification times updated!\n\nYou'll receive updates at: ${times.join(", ")}`);
    } else if (session.step === "update_threshold") {
        const threshold = parseInt(text);

        if (isNaN(threshold) || threshold < 0) {
            await ctx.reply("❌ Please enter a valid number (e.g., 100), or /cancel to stop.");
            return;
        }

        await UserService.updateThreshold(userId, threshold);
        userSessions.delete(userId);

        await ctx.reply(`✅ Low balance threshold updated to ${threshold} BDT`);
    } else if (session.step === "update_threshold_days") {
        const days = parseInt(text);

        if (isNaN(days) || days < 0 || days > 60) {
            await ctx.reply("❌ Please enter a number of days between 0 and 60 (e.g., 5), or /cancel to stop.");
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
            await ctx.reply("❌ Please enter a valid number (e.g., 50), 0 to disable, or /cancel to stop.");
            return;
        }

        const enabled = threshold > 0;
        // "0" switches these alerts off. It used to also be saved as the BDT
        // threshold, silently removing the low-balance warning in the daily
        // update as well, which the user never asked for.
        if (enabled) {
            await UserService.updateThreshold(userId, threshold);
        }
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
