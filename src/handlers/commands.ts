import { Context } from "telegraf";
import { UserService } from "../services/UserService";
import { ADMIN_USERNAME } from "../bot";
import { Markup } from "telegraf";
import { formatCommandList } from "../botCommands";

export const userSessions = new Map<number, {
    step: string;
    accountNo?: string;
    meterNo?: string;
    notificationTimes?: string[];
}>();

export async function handleStart(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;

    const user = await UserService.getUser(userId);

    if (!user || (!user.accountNo && !user.meterNo)) {
        // New user or user without account details
        await ctx.reply(
            "👋 Welcome to DESCO Balance Check Bot!\n\n" +
            "Let's set up your account. I'll need either your Account Number or Meter Number (or both).\n\n" +
            "Please enter your Account Number (or type 'skip' to omit):"
        );
        userSessions.set(userId, { step: "setup_account" });
    } else {
        // Existing user
        await ctx.reply(
            "👋 Welcome back to DESCO Balance Check Bot! 🔋\n\n" +
            "Available commands:\n" +
            formatCommandList(["start"])
        );
    }
}

export async function handleHelp(ctx: Context) {
    const helpText = `
📚 <b>DESCO Balance Check Bot - Help</b>

<b>Available Commands:</b>

${formatCommandList()}

<b>About Subscriptions:</b>
When subscribed, you'll receive automatic balance notifications at your chosen times. You can also set a low balance threshold for alerts.

Need assistance? Contact @${ADMIN_USERNAME}
`;
    await ctx.reply(helpText, { parse_mode: "HTML" });
}

export async function handleMe(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;

    const user = await UserService.getUser(userId);
    if (!user) {
        await ctx.reply("❌ User not found. Please use /start to set up your account.");
        return;
    }

    const subscriptionStatus = user.isSubscribed ? "✅ Active" : "❌ Inactive";
    const notificationTimes = user.notificationTimes.length > 0
        ? user.notificationTimes.join(", ")
        : "Not set";
    const hourlyStatus = user.hourlyNotificationEnabled ? "✅ Enabled" : "❌ Disabled";
    const daysWarning = user.thresholdDays && user.thresholdDays > 0
        ? `${user.thresholdDays} day(s) left`
        : "Disabled";

    const infoText = `
👤 <b>Your Account Information</b>

<b>Name:</b> ${user.firstName || "N/A"} ${user.lastName || ""}
<b>Username:</b> @${user.username || "N/A"}
<b>Telegram ID:</b> <code>${user.telegramId}</code>

📊 <b>DESCO Details:</b>
<b>Account No:</b> <code>${user.accountNo || "Not set"}</code>
<b>Meter No:</b> <code>${user.meterNo || "Not set"}</code>

🔔 <b>Subscription:</b> ${subscriptionStatus}
<b>Notification Times:</b> ${notificationTimes}
<b>Low Balance Threshold:</b> ${user.threshold} BDT
<b>Days-Left Warning:</b> ${daysWarning}
<b>Alerts When Low:</b> ${hourlyStatus}

<i>Use /update to modify your details</i>
<i>Use /subscribe to manage notifications</i>
`;
    await ctx.reply(infoText, { parse_mode: "HTML" });
}

export async function handleUpdate(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;

    await ctx.reply(
        "What would you like to update?",
        Markup.inlineKeyboard([
            [Markup.button.callback("📝 Account/Meter Number", "update_account")],
            [Markup.button.callback("⚙️ Notification Times", "update_times")],
            [Markup.button.callback("⚠️ Low Balance Threshold (BDT)", "update_threshold")],
            [Markup.button.callback("⏳ Days-Left Warning", "update_threshold_days")],
            [Markup.button.callback("🔔 Low Balance Alerts", "update_hourly")],
            [Markup.button.callback("❌ Cancel", "cancel")]
        ])
    );
}

export async function handleBalance(ctx: Context) {
    const username = ctx.from?.username;
    const userId = ctx.from?.id;

    if (!userId) {
        await ctx.reply("Unable to identify user.");
        return;
    }

    const user = await UserService.getUser(userId);

    // All users follow the same flow - no admin special treatment
    if (user && (user.accountNo || user.meterNo)) {
        // User has saved account details
        await ctx.reply(
            "Choose an option:",
            Markup.inlineKeyboard([
                [Markup.button.callback("Use My Saved Account", "use_saved")],
                [Markup.button.callback("Enter Different Details", "enter_custom")]
            ])
        );
    } else {
        // For users without saved details
        userSessions.set(userId, { step: "waiting_for_account" });
        await ctx.reply("Please enter your Account Number (or type 'skip' to omit):");
    }
}

export async function handleUsage(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;

    const user = await UserService.getUser(userId);

    if (!user || (!user.accountNo && !user.meterNo)) {
        await ctx.reply("❌ Please set up your account using /start first.");
        return;
    }

    await ctx.reply(
        "📊 <b>Usage Overview</b>\n\nHow many days would you like to see?",
        {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
                [
                    Markup.button.callback("7 days", "usage_7"),
                    Markup.button.callback("15 days", "usage_15"),
                    Markup.button.callback("30 days", "usage_30"),
                ],
                [Markup.button.callback("✏️ Custom", "usage_custom")],
                [Markup.button.callback("❌ Cancel", "cancel")],
            ]),
        }
    );
}

export async function handleSubscribe(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;

    const user = await UserService.getUser(userId);
    if (!user) {
        await ctx.reply("❌ Please use /start to set up your account first.");
        return;
    }

    if (!user.accountNo && !user.meterNo) {
        await ctx.reply("❌ Please set up your account details using /start before subscribing.");
        return;
    }

    const status = user.isSubscribed ? "ON" : "OFF";
    const toggleText = user.isSubscribed ? "Turn OFF" : "Turn ON";

    await ctx.reply(
        `🔔 <b>Notification Subscription</b>\n\n` +
        `Current Status: <b>${status}</b>\n\n` +
        `When subscribed, you'll receive balance updates at your set times.\n` +
        `Current notification times: ${user.notificationTimes.join(", ")}`,
        {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
                [Markup.button.callback(`${toggleText} Notifications`, "toggle_subscription")],
                [Markup.button.callback("⚙️ Change Notification Times", "update_times")],
                [Markup.button.callback("❌ Cancel", "cancel")]
            ])
        }
    );
}
