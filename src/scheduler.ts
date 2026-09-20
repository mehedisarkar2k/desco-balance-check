import * as cron from "node-cron";
import { sendMessage } from "./bot";
import { UserService } from "./services/UserService";
import { bot } from "./bot";
import { IUser } from "./models/User";
import {
    getBalanceReport,
    formatBalanceMessage,
    formatLowBalanceAlert,
    isLowBalance,
} from "./utils/usage";

const threshold = Number(process.env.THRESHOLD) || 100;
const DEFAULT_THRESHOLD_DAYS = 3;

const scheduledTasks: Map<string, cron.ScheduledTask> = new Map();

async function checkAndNotifyUser(user: IUser, isHourlyCheck = false) {
    const userId = user.telegramId;

    try {
        // Skip if user doesn't have account details
        if (!user.accountNo && !user.meterNo) {
            console.warn(`User ${userId} has no account details, skipping notification`);
            return null;
        }

        const result = await getBalanceReport({
            accountNo: user.accountNo,
            meterNo: user.meterNo,
        });

        if (!result.success || !result.report) {
            // Hourly checks run unattended; only the scheduled update reports failures,
            // otherwise a DESCO outage means 24 error messages a day.
            if (!isHourlyCheck) {
                await bot.telegram.sendMessage(
                    userId,
                    `<b>❌ Error checking DESCO:</b> ${result.error || "Unknown error"}`,
                    { parse_mode: "HTML" }
                );
            }
            return null;
        }

        const { data, usage } = result.report;
        const thresholdValue = user.threshold || threshold;
        const thresholdDays = user.thresholdDays ?? DEFAULT_THRESHOLD_DAYS;
        const low = isLowBalance(data.balance, usage, thresholdValue, thresholdDays);

        if (isHourlyCheck) {
            if (!low) {
                // Recovered, so let the next dip alert again.
                if (user.lastLowAlertReadingDate) {
                    await UserService.setLastLowAlertReadingDate(userId, null);
                }
                return data.balance;
            }

            // DESCO publishes one reading per day, so re-alerting on a reading
            // already sent would repeat the same message every hour.
            if (user.lastLowAlertReadingDate === data.readingTime) {
                return data.balance;
            }

            await bot.telegram.sendMessage(
                userId,
                formatLowBalanceAlert(data.balance, usage, thresholdValue),
                { parse_mode: "HTML" }
            );
            await UserService.setLastLowAlertReadingDate(userId, data.readingTime);
            return data.balance;
        }

        await bot.telegram.sendMessage(
            userId,
            formatBalanceMessage(data, usage, "🔔 Scheduled Update"),
            { parse_mode: "HTML" }
        );

        if (low) {
            await bot.telegram.sendMessage(
                userId,
                formatLowBalanceAlert(data.balance, usage, thresholdValue),
                { parse_mode: "HTML" }
            );
        }

        return data.balance;
    } catch (err: any) {
        console.error(`Error notifying user ${userId}:`, err.message);
        return null;
    }
}

// Removed admin default balance check function and hourly alerts - all users must have their own accounts

// Setup user-specific notifications
async function setupUserNotifications() {
    // Read first, then swap. Tearing the tasks down before this await would
    // leave a window with no schedule at all while the query is in flight.
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

    // Only the difference is applied. Stopping and recreating every task on
    // each refresh risks destroying a reminder in the moment it comes due, and
    // each task looks its own users up when it fires, so a task whose time is
    // unchanged needs no work even when its users changed.
    for (const [time, task] of scheduledTasks) {
        if (!timeUserMap.has(time)) {
            task.stop();
            scheduledTasks.delete(time);
            console.log(`🗑️ Unscheduled notifications for ${time}`);
        }
    }

    timeUserMap.forEach((userIds, time) => {
        if (scheduledTasks.has(time)) return;

        const [hour, minute] = time.split(":");
        const cronExpression = `${minute} ${hour} * * *`;

        const task = cron.schedule(
            cronExpression,
            async () => {
                console.log(`Running scheduled notifications for ${time}`);
                const subscribedUsers = await UserService.getUsersByNotificationTime(time);

                for (const user of subscribedUsers) {
                    await checkAndNotifyUser(user);
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
    // Deliberately at half past, not on the hour. A rebuild stops and recreates
    // every task, and notification times are whole minutes that default to :00,
    // so refreshing at minute 0 could tear down a reminder as it came due.
    cron.schedule("30 * * * *", async () => {
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
        await checkAndNotifyUser(user, true /* isHourlyCheck */);
        // Add delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

// Daily scheduled checks and alerts
export async function startScheduler() {
    // Hourly checks for low balance alerts, offset from the hour so they don't
    // hit DESCO at the same instant as the scheduled updates.
    cron.schedule("15 * * * *", async () => {
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