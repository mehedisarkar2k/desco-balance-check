import mongoose, { Schema, Document } from "mongoose";

export interface IUser extends Document {
    telegramId: number;
    username?: string;
    firstName?: string;
    lastName?: string;
    accountNo?: string;
    meterNo?: string;
    isSubscribed: boolean;
    notificationTimes: string[]; // e.g., ["08:00", "16:00"]
    threshold?: number;
    hourlyNotificationEnabled: boolean; // Enable hourly notifications when below threshold
    createdAt: Date;
    updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
    {
        telegramId: {
            type: Number,
            required: true,
            unique: true,
            index: true,
        },
        username: String,
        firstName: String,
        lastName: String,
        accountNo: String,
        meterNo: String,
        isSubscribed: {
            type: Boolean,
            default: false,
        },
        notificationTimes: {
            type: [String],
            default: ["08:00", "16:00"], // Default times: 8 AM and 4 PM
        },
        threshold: {
            type: Number,
            default: 100,
        },
        hourlyNotificationEnabled: {
            type: Boolean,
            default: false,
        },
    },
    {
        timestamps: true,
    }
);

export const User = mongoose.model<IUser>("User", UserSchema);
