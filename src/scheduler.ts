import * as cron from "node-cron";
import { fetchBalance } from "./desco";
import { sendMessage } from "./bot";
import { UserService } from "./services/UserService";
import { bot } from "./bot";

const threshold = Number(process.env.THRESHOLD) || 100;

let hourlyTask: cron.ScheduledTask | null = null;
const scheduledTasks: Map<string, cron.ScheduledTask> = new Map();

function formatMsg(balance: number, consumption: number, readingTime: string, prefix = "") {
    const head = prefix ? `<b>${prefix}</b>\n` : "";
    return `${head}<b>💰 DESCO Balance:</b> <code>${balance.toFixed(2)} BDT</code>\n` +
        `⚡ <b>Consumption:</b> <code>${consumption.toFixed(3)} kWh</code>\n` +
        `📅 <b>Reading:</b> <code>${readingTime}</code>`;
}

async function checkAndNotifyUser(userId: number, accountNo?: string, meterNo?: string, userThreshold?: number, isHourlyCheck = false) {
    try {
        const result = await fetchBalance({
            accountNo,
            meterNo,
            useDefaults: !accountNo && !meterNo
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

async function checkAndNotify(prefix = "") {
    try {
        const result = await fetchBalance({ useDefaults: true });

        if (!result.success || !result.data) {
            await sendMessage(`<b>❌ Error checking DESCO:</b> ${result.error || "Unknown error"}`);
            return;
        }

        const { balance, currentMonthConsumption, readingTime } = result.data;
        await sendMessage(formatMsg(balance, currentMonthConsumption, readingTime, prefix));

        if (balance <= threshold) {
            await sendMessage(`<b>⚠️ Low balance (≤ ${threshold})</b> — hourly alerts ON`);
            enableHourlyAlerts();
        } else {
            disableHourlyAlerts();
        }
    } catch (err: any) {
        await sendMessage(`<b>❌ Error checking DESCO:</b> ${err.message}`);
    }
}

function enableHourlyAlerts() {
    if (hourlyTask) return;
    hourlyTask = cron.schedule("0 * * * *", () => checkAndNotify("Hourly check"), {
        timezone: process.env.TZ || "Asia/Dhaka"
    });
    hourlyTask.start();
}

function disableHourlyAlerts() {
    if (hourlyTask) {
        hourlyTask.stop();
        hourlyTask = null;
    }
}

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

// Daily scheduled checks for admin (8AM & 4PM)
export async function startScheduler() {
    // Admin notifications
    cron.schedule("0 8,16 * * *", () => checkAndNotify("Scheduled"), {
        timezone: process.env.TZ || "Asia/Dhaka",
    });

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

    // Initial admin check
    checkAndNotify("Startup");

    console.log("✅ Scheduler started successfully");
}

// Export function to refresh schedules when user updates subscription
export async function refreshSchedules() {
    await setupUserNotifications();
}