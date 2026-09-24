import * as cron from "node-cron";
import { sendMessage } from "./bot";
import { UserService } from "./services/UserService";
import { bot } from "./bot";
import { IUser } from "./models/User";
import { pruneSessions } from "./ai/session";
import { escapeHtml } from "./utils/html";
import { hourInBillingZone, parseTimes } from "./utils/times";
import {
    getBalanceReport,
    formatBalanceMessage,
    formatLowBalanceAlert,
    isLowBalance,
} from "./utils/usage";

const threshold = Number(process.env.THRESHOLD) || 100;
const DEFAULT_THRESHOLD_DAYS = 3;
const TIMEZONE = process.env.TZ || "Asia/Dhaka";

/**
 * Hours in which the hourly low-balance check may message people. DESCO rolls
 * the balance date over at midnight, which counts as a new reading, so without
 * this a low balance woke users at about 00:15 every night. An alert held back
 * overnight is sent by the first check after 08:00.
 */
const ALERT_HOURS = { from: 8, until: 22 };

/**
 * Sends a message, recording users Telegram reports as unreachable so they
 * stop being polled. Returns false when the message did not go out.
 */
async function sendTo(userId: number, text: string): Promise<boolean> {
    try {
        await bot.telegram.sendMessage(userId, text, { parse_mode: "HTML" });
        return true;
    } catch (error: any) {
        const code = error?.response?.error_code;
        const description = String(error?.response?.description ?? error?.message ?? "");
        if (code === 403 || /chat not found|user is deactivated/i.test(description)) {
            await UserService.markBlocked(userId);
            console.warn(`User ${userId} is unreachable; marked blocked`);
        } else {
            console.error(`Failed to message ${userId}:`, description);
        }
        return false;
    }
}

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
                await sendTo(userId, `<b>❌ Error checking DESCO:</b> ${escapeHtml(result.error || "Unknown error")}`);
            }
            return null;
        }

        const { data, usage } = result.report;
        // ?? rather than ||: a threshold the user set to 0 is 0, not the default.
        const thresholdValue = user.threshold ?? threshold;
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

            const hour = hourInBillingZone();
            if (hour < ALERT_HOURS.from || hour >= ALERT_HOURS.until) {
                return data.balance;
            }

            // One alert per DESCO reading, claimed atomically so overlapping
            // runs cannot both send it.
            if (!(await UserService.claimLowAlert(userId, data.readingTime))) {
                return data.balance;
            }

            const sent = await sendTo(userId, formatLowBalanceAlert(data.balance, usage, thresholdValue));
            if (!sent) {
                // Not delivered, so give the claim back and let a later check retry.
                await UserService.setLastLowAlertReadingDate(userId, user.lastLowAlertReadingDate ?? null);
            }
            return data.balance;
        }

        const delivered = await sendTo(userId, formatBalanceMessage(data, usage, "🔔 Scheduled Update"));

        if (delivered && low) {
            await sendTo(userId, formatLowBalanceAlert(data.balance, usage, thresholdValue));
        }

        return data.balance;
    } catch (err: any) {
        console.error(`Error notifying user ${userId}:`, err.message);
        return null;
    }
}

// Removed admin default balance check function and hourly alerts - all users must have their own accounts

async function runReminders(time: string) {
    console.log(`Running scheduled notifications for ${time}`);
    const subscribedUsers = await UserService.getUsersByNotificationTime(time);

    for (const user of subscribedUsers) {
        await checkAndNotifyUser(user);
        // Add delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

// Setup user-specific notifications
async function setupUserNotifications() {
    // Read first, then swap. Tearing the tasks down before this await would
    // leave a window with no schedule at all while the query is in flight.
    const users = await UserService.getSubscribedUsers();
    const timeUserMap = new Map<string, number[]>();

    users.forEach(user => {
        user.notificationTimes.forEach(raw => {
            // A malformed stored time is skipped, not scheduled. node-cron
            // throws on "08:60", and one such value rejected the whole
            // scheduler start-up, which exits the process: every restart then
            // crashed the same way, for every user.
            const time = parseTimes([raw])?.[0];
            if (!time) {
                console.warn(`Skipping invalid reminder time "${raw}" for user ${user.telegramId}`);
                return;
            }
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

        try {
            const task = cron.schedule(cronExpression, () => runReminders(time), {
                timezone: TIMEZONE,
                noOverlap: true,
            });

            // node-cron skips a run whose timer fires even a second late, and
            // only logs it. For a once-a-day reminder that means no reminder
            // that day, so a missed run is run straight away instead.
            task.on("execution:missed", () => {
                console.warn(`Reminder for ${time} fired late; running it now`);
                runReminders(time).catch((error) => console.error(`Late reminder for ${time} failed:`, error));
            });

            scheduledTasks.set(time, task);
            console.log(`✅ Scheduled notifications for ${time} (${userIds.length} users)`);
        } catch (error: any) {
            console.error(`Could not schedule reminders for ${time}:`, error.message);
        }
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
        timezone: TIMEZONE,
        noOverlap: true,
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
    // noOverlap: when DESCO is slow a run can outlast the hour, and a second
    // run starting on top of it would check (and message) the same users.
    cron.schedule("15 * * * *", async () => {
        console.log("Running hourly low balance checks...");
        await checkHourlyLowBalance();
    }, {
        timezone: TIMEZONE,
        noOverlap: true,
    });

    // Idle chat sessions would otherwise accumulate for every user who ever
    // chatted, since this process runs for weeks at a time.
    cron.schedule("45 * * * *", () => {
        const removed = pruneSessions();
        if (removed > 0) console.log(`Pruned ${removed} idle chat session(s)`);
    }, {
        timezone: TIMEZONE,
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