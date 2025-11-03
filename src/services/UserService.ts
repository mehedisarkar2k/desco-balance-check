import { User, IUser } from "../models/User";

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
     * Update user account details
     */
    static async updateAccountDetails(
        telegramId: number,
        accountNo?: string,
        meterNo?: string
    ): Promise<IUser | null> {
        const user = await User.findOne({ telegramId });
        if (!user) return null;

        if (accountNo !== undefined) user.accountNo = accountNo;
        if (meterNo !== undefined) user.meterNo = meterNo;

        await user.save();
        return user;
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
        return await User.find({ isSubscribed: true });
    }

    /**
     * Get users with specific notification time
     */
    static async getUsersByNotificationTime(time: string): Promise<IUser[]> {
        return await User.find({
            isSubscribed: true,
            notificationTimes: time,
        });
    }

    /**
     * Get users with hourly notifications enabled
     */
    static async getUsersWithHourlyNotifications(): Promise<IUser[]> {
        return await User.find({
            isSubscribed: true,
            hourlyNotificationEnabled: true,
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
