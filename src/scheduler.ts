import * as cron from "node-cron";
import { fetchBalance } from "./desco";
import { sendMessage } from "./bot";
import { UserService } from "./services/UserService";
import { bot } from "./bot";

const threshold = Number(process.env.THRESHOLD) || 100;

const scheduledTasks: Map<string, cron.ScheduledTask> = new Map();

function formatMsg(balance: number, consumption: number, readingTime: string, prefix = "") {
    const head = prefix ? `<b>${prefix}</b>\n` : "";
    const consumptionDisplay = consumption > 0
        ? `<code>${consumption.toFixed(3)} kWh</code>`
        : `<code>N/A</code>`;

    return `${head}<b>💰 DESCO Balance:</b> <code>${balance.toFixed(2)} BDT</code>\n` +
        `⚡ <b>Consumption:</b> ${consumptionDisplay}\n` +
        `📅 <b>Reading:</b> <code>${readingTime}</code>`;
}

async function checkAndNotifyUser(userId: number, accountNo?: string, meterNo?: string, userThreshold?: number, isHourlyCheck = false) {
    try {
        // Skip if user doesn't have account details
        if (!accountNo && !meterNo) {
            console.warn(`User ${userId} has no account details, skipping notification`);
            return null;
        }

        const result = await fetchBalance({
            accountNo,
            meterNo
        });

        if (!result.success || !result.data) {
            await bot.telegram.sendMessage(
                userId,
                `<b>❌ Error checking DESCO:</b> ${result.error || "Unknown error"}`,
                { parse_mode: "HTML" }
            );
            return null;
        }

        const { balance, currentMonthConsumption, readingTime } = result.data;

        // For hourly checks, only send if balance is low
        const thresholdValue = userThreshold || threshold;
        if (isHourlyCheck && balance > thresholdValue) {
            return balance; // Don't send notification if balance is above threshold
        }

        const prefix = isHourlyCheck ? "⏰ Hourly Low Balance Alert" : "🔔 Scheduled Update";
        const message = formatMsg(balance, currentMonthConsumption, readingTime, prefix);

        await bot.telegram.sendMessage(userId, message, { parse_mode: "HTML" });

        // Check threshold for regular notifications
        if (!isHourlyCheck && balance <= thresholdValue) {
            await bot.telegram.sendMessage(
                userId,
                `<b>⚠️ Low Balance Alert!</b>\n\nYour balance (${balance.toFixed(2)} BDT) is below the threshold (${thresholdValue} BDT).`,
                { parse_mode: "HTML" }
            );
        }

        return balance;
    } catch (err: any) {
        console.error(`Error notifying user ${userId}:`, err.message);
        return null;
    }
}

// Removed admin default balance check function and hourly alerts - all users must have their own accounts

// Setup user-specific notifications
async function setupUserNotifications() {
    // Clear existing tasks
    scheduledTasks.forEach(task => task.stop());
    scheduledTasks.clear();

    // Get all unique notification times
    const users = await UserService.getSubscribedUsers();
    const timeUserMap = new Map<string, number[]>();

    users.forEach(user => {
        user.notificationTimes.forEach(time => {
            if (!timeUserMap.has(time)) {
                timeUserMap.set(time, []);
            }
            timeUserMap.get(time)!.push(user.telegramId);
        });
    });

    // Create cron jobs for each unique time
    timeUserMap.forEach((userIds, time) => {
        const [hour, minute] = time.split(":");
        const cronExpression = `${minute} ${hour} * * *`;

        const task = cron.schedule(
            cronExpression,
            async () => {
                console.log(`Running scheduled notifications for ${time}`);
                const subscribedUsers = await UserService.getUsersByNotificationTime(time);

                for (const user of subscribedUsers) {
                    await checkAndNotifyUser(
                        user.telegramId,
                        user.accountNo,
                        user.meterNo,
                        user.threshold
                    );
                    // Add delay to avoid rate limiting
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            },
            {
                timezone: process.env.TZ || "Asia/Dhaka",
            }
        );

        scheduledTasks.set(time, task);
        console.log(`✅ Scheduled notifications for ${time} (${userIds.length} users)`);
    });
}

// Refresh schedules every hour to pick up new subscriptions
function scheduleRefresh() {
    cron.schedule("0 * * * *", async () => {
        console.log("Refreshing notification schedules...");
        await setupUserNotifications();
    }, {
        timezone: process.env.TZ || "Asia/Dhaka"
    });
}

// Hourly check for users with low balance alerts enabled
async function checkHourlyLowBalance() {
    const users = await UserService.getUsersWithHourlyNotifications();

    for (const user of users) {
        await checkAndNotifyUser(
            user.telegramId,
            user.accountNo,
            user.meterNo,
            user.threshold,
            true // isHourlyCheck
        );
        // Add delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

// Daily scheduled checks and alerts
export async function startScheduler() {
    // Hourly checks for low balance alerts
    cron.schedule("0 * * * *", async () => {
        console.log("Running hourly low balance checks...");
        await checkHourlyLowBalance();
    }, {
        timezone: process.env.TZ || "Asia/Dhaka"
    });

    // Setup user notifications
    await setupUserNotifications();

    // Schedule periodic refresh
    scheduleRefresh();

    console.log("✅ Scheduler started successfully");
}

// Export function to refresh schedules when user updates subscription
export async function refreshSchedules() {
    await setupUserNotifications();
}