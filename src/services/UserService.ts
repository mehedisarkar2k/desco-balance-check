import { User, IUser } from "../models/User";
import type { ReplyLanguage } from "../ai/language";
import type { NumberKind } from "../utils/onboardingText";

export class UserService {
    /**
     * Find or create a user
     */
    static async findOrCreate(telegramId: number, userData?: {
        username?: string;
        firstName?: string;
        lastName?: string;
    }): Promise<IUser> {
        let user = await User.findOne({ telegramId });

        if (!user) {
            user = await User.create({
                telegramId,
                username: userData?.username,
                firstName: userData?.firstName,
                lastName: userData?.lastName,
            });
        } else if (userData) {
            // Update user info if provided
            // Writing to the bot means they are reachable again, so reminders
            // and announcements resume. blockedAt was never cleared before.
            if (user.blockedAt) user.set("blockedAt", undefined);
            user.username = userData.username || user.username;
            user.firstName = userData.firstName || user.firstName;
            user.lastName = userData.lastName || user.lastName;
            await user.save();
        }

        return user;
    }

    /**
     * Get user by telegram ID
     */
    static async getUser(telegramId: number): Promise<IUser | null> {
        return await User.findOne({ telegramId });
    }

    /**
     * Save one DESCO number. The other kind is cleared: the bot works out
     * which kind a number is, so keeping an old number of the other kind
     * could leave two numbers that belong to different accounts.
     */
    static async setDescoNumber(
        telegramId: number,
        kind: NumberKind,
        number: string
    ): Promise<IUser | null> {
        const update =
            kind === "account"
                ? { accountNo: number, $unset: { meterNo: "" } }
                : { meterNo: number, $unset: { accountNo: "" } };

        return await User.findOneAndUpdate({ telegramId }, update, { new: true });
    }

    /** Reminders and low-balance alerts as a new user gets them by default. */
    static async enableDefaultAlerts(telegramId: number): Promise<IUser | null> {
        return await User.findOneAndUpdate(
            { telegramId },
            {
                isSubscribed: true,
                notificationTimes: ["09:00"],
                hourlyNotificationEnabled: true,
            },
            { new: true }
        );
    }

    /** Remember the language the user writes in, so replies match. */
    static async updateLanguage(
        telegramId: number,
        language: ReplyLanguage
    ): Promise<IUser | null> {
        return await User.findOneAndUpdate(
            { telegramId },
            { language },
            { new: true }
        );
    }

    /**
     * Subscribe/Unsubscribe user
     */
    static async updateSubscription(
        telegramId: number,
        isSubscribed: boolean
    ): Promise<IUser | null> {
        return await User.findOneAndUpdate(
            { telegramId },
            { isSubscribed },
            { new: true }
        );
    }

    /**
     * Update notification times
     */
    static async updateNotificationTimes(
        telegramId: number,
        times: string[]
    ): Promise<IUser | null> {
        return await User.findOneAndUpdate(
            { telegramId },
            { notificationTimes: times },
            { new: true }
        );
    }

    /**
     * Update threshold
     */
    static async updateThreshold(
        telegramId: number,
        threshold: number
    ): Promise<IUser | null> {
        return await User.findOneAndUpdate(
            { telegramId },
            { threshold },
            { new: true }
        );
    }

    /**
     * Update the days-remaining warning threshold
     */
    static async updateThresholdDays(
        telegramId: number,
        thresholdDays: number
    ): Promise<IUser | null> {
        return await User.findOneAndUpdate(
            { telegramId },
            { thresholdDays },
            { new: true }
        );
    }

    /**
     * Claims the low-balance alert for a reading, returning true only for the
     * caller that should send it.
     *
     * The claim and the check are one atomic update. Checking in memory and
     * writing after sending let two overlapping runs (a slow hour, or old and
     * new instances during a deploy) both send the same alert.
     */
    static async claimLowAlert(telegramId: number, readingDate: string): Promise<boolean> {
        const result = await User.updateOne(
            { telegramId, lastLowAlertReadingDate: { $ne: readingDate } },
            { lastLowAlertReadingDate: readingDate }
        );
        return result.modifiedCount === 1;
    }

    /** Telegram reported the user unreachable: they blocked the bot or left. */
    static async markBlocked(telegramId: number): Promise<void> {
        await User.updateOne({ telegramId }, { blockedAt: new Date() });
    }

    /**
     * Record which DESCO reading a low-balance alert was sent for, so repeat
     * checks against the same reading stay silent. Pass null once the balance
     * recovers, so the next dip alerts again.
     */
    static async setLastLowAlertReadingDate(
        telegramId: number,
        readingDate: string | null
    ): Promise<void> {
        await User.updateOne(
            { telegramId },
            readingDate
                ? { lastLowAlertReadingDate: readingDate }
                : { $unset: { lastLowAlertReadingDate: "" } }
        );
    }

    /**
     * Update hourly notification setting
     */
    static async updateHourlyNotification(
        telegramId: number,
        enabled: boolean
    ): Promise<IUser | null> {
        return await User.findOneAndUpdate(
            { telegramId },
            { hourlyNotificationEnabled: enabled },
            { new: true }
        );
    }

    /**
     * Get all subscribed users
     */
    static async getSubscribedUsers(): Promise<IUser[]> {
        return await User.find({ isSubscribed: true, blockedAt: { $exists: false } });
    }

    /**
     * Get users with specific notification time
     */
    static async getUsersByNotificationTime(time: string): Promise<IUser[]> {
        return await User.find({
            isSubscribed: true,
            notificationTimes: time,
            blockedAt: { $exists: false },
        });
    }

    /**
     * Get users with hourly notifications enabled
     */
    static async getUsersWithHourlyNotifications(): Promise<IUser[]> {
        // Not tied to isSubscribed. Low-balance alerts are their own setting:
        // requiring daily reminders too meant a user who switched on alerts,
        // and was told they were on, never received one.
        return await User.find({
            hourlyNotificationEnabled: true,
            blockedAt: { $exists: false },
        });
    }

    /**
     * Delete user
     */
    static async deleteUser(telegramId: number): Promise<boolean> {
        const result = await User.deleteOne({ telegramId });
        return result.deletedCount > 0;
    }
}
