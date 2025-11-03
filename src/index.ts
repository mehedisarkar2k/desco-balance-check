import { bot, sendMessage, ADMIN_USERNAME, ADMIN_CHAT_ID } from "./bot";
import { startScheduler, refreshSchedules } from "./scheduler";
import { fetchBalance } from "./desco";
import { Markup } from "telegraf";
import { connectDatabase } from "./database";
import { UserService } from "./services/UserService";

// Store user sessions for multi-step conversations
const userSessions = new Map<number, {
    step: string;
    accountNo?: string;
    meterNo?: string;
    notificationTimes?: string[];
}>();

bot.use(async (ctx, next) => {
    console.log("📨 Update received:", ctx.updateType, ctx.message);

    // Auto-register user on any interaction
    if (ctx.from) {
        await UserService.findOrCreate(ctx.from.id, {
            username: ctx.from.username,
            firstName: ctx.from.first_name,
            lastName: ctx.from.last_name,
        });
    }

    await next();
});

bot.command("start", async (ctx) => {
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
            "/balance - Check your electricity balance\n" +
            "/me - View your account information\n" +
            "/update - Update your account details\n" +
            "/subscribe - Enable/disable notifications\n" +
            "/help - Show all commands"
        );
    }
});

bot.command("help", async (ctx) => {
    const helpText = `
📚 <b>DESCO Balance Check Bot - Help</b>

<b>Available Commands:</b>

/start - Set up your account (first time users)
/balance - Check your current DESCO balance
/me - View your account and subscription info
/update - Update your account details
/subscribe - Manage notification subscriptions
/help - Show this help message

<b>About Subscriptions:</b>
When subscribed, you'll receive automatic balance notifications at your chosen times. You can also set a low balance threshold for alerts.

Need assistance? Contact @${ADMIN_USERNAME}
`;
    await ctx.reply(helpText, { parse_mode: "HTML" });
});

bot.command("me", async (ctx) => {
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
<b>Hourly Alerts (when low):</b> ${hourlyStatus}

<i>Use /update to modify your details</i>
<i>Use /subscribe to manage notifications</i>
`;
    await ctx.reply(infoText, { parse_mode: "HTML" });
}); bot.command("update", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    await ctx.reply(
        "What would you like to update?",
        Markup.inlineKeyboard([
            [Markup.button.callback("📝 Account/Meter Number", "update_account")],
            [Markup.button.callback("⚙️ Notification Times", "update_times")],
            [Markup.button.callback("⚠️ Low Balance Threshold", "update_threshold")],
            [Markup.button.callback("🔔 Hourly Alerts Setting", "update_hourly")],
            [Markup.button.callback("❌ Cancel", "cancel")]
        ])
    );
});

bot.command("balance", async (ctx) => {
    const username = ctx.from?.username;
    const userId = ctx.from?.id;

    if (!userId) {
        await ctx.reply("Unable to identify user.");
        return;
    }

    const user = await UserService.getUser(userId);

    // Check if user is admin
    if (username === ADMIN_USERNAME) {
        await ctx.reply(
            "Choose an option:",
            Markup.inlineKeyboard([
                [Markup.button.callback("Use Default Account", "use_default")],
                [Markup.button.callback("Use My Saved Account", "use_saved")],
                [Markup.button.callback("Enter Custom Details", "enter_custom")]
            ])
        );
    } else if (user && (user.accountNo || user.meterNo)) {
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
});

bot.command("subscribe", async (ctx) => {
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
});

// Handle callback queries (button clicks)
bot.on("callback_query", async (ctx) => {
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
});

// Handle text messages
bot.on("text", async (ctx) => {
    const userId = ctx.from?.id;
    const text = ctx.message.text;

    if (!userId) return;

    const session = userSessions.get(userId);
    if (!session) return;

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
                `✅ Hourly alerts enabled!\n\n` +
                `You'll receive notifications every hour when your balance is ≤ ${threshold} BDT.`
            );
        } else {
            await ctx.reply(`✅ Hourly alerts disabled.`);
        }
    }
});

async function performBalanceCheck(ctx: any, params: { accountNo?: string; meterNo?: string; useDefaults?: boolean }) {
    // Validate that at least one parameter is provided when not using defaults
    if (!params.useDefaults && !params.accountNo && !params.meterNo) {
        await ctx.reply("❌ Please provide either Account Number or Meter Number.");
        return;
    }

    const result = await fetchBalance({
        accountNo: params.accountNo,
        meterNo: params.meterNo,
        useDefaults: params.useDefaults
    });

    if (result.success && result.data) {
        const { balance, currentMonthConsumption, readingTime } = result.data;
        const message = `
✅ <b>DESCO Balance</b>

💰 <b>Balance:</b> <code>${balance.toFixed(2)} BDT</code>
⚡ <b>Consumption:</b> <code>${currentMonthConsumption.toFixed(2)} kWh</code>
📅 <b>Reading Time:</b> <code>${readingTime}</code>
`;
        await ctx.reply(message, { parse_mode: "HTML" });
    } else {
        // Error occurred
        await ctx.reply(
            "❌ Something went wrong while fetching your balance.\n\n" +
            "This issue has been reported to support. Please wait while we investigate."
        );

        // Send error details to admin
        if (result.attemptedUrls && result.attemptedUrls.length > 0) {
            const errorMessage = `
🚨 <b>Balance Fetch Failed</b>

<b>User:</b> ${ctx.from?.first_name || "Unknown"} (@${ctx.from?.username || "no username"})
<b>User ID:</b> ${ctx.from?.id}
<b>Error:</b> ${result.error}

<b>Attempted URLs:</b>
${result.attemptedUrls.map((url, i) => `${i + 1}. <code>${url}</code>`).join('\n')}
`;
            await sendMessage(errorMessage, ADMIN_CHAT_ID);
        }
    }
}

(async () => {
    try {
        console.log("Connecting to database...");
        await connectDatabase();

        console.log("Launching the TG bot");
        await bot.launch();
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
