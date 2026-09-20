import mongoose, { Schema, Document } from "mongoose";

/**
 * A record that a version's release notes were sent, so a restart or a repeat
 * deploy of the same version does not message everyone again.
 */
export interface IAnnouncement extends Document {
    version: string;
    announcedAt: Date;
    sentCount: number;
    failedCount: number;
    blockedCount: number;
}

const AnnouncementSchema = new Schema<IAnnouncement>({
    version: {
        type: String,
        required: true,
        unique: true,
        index: true,
    },
    announcedAt: {
        type: Date,
        default: Date.now,
    },
    sentCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    blockedCount: { type: Number, default: 0 },
});

export const Announcement = mongoose.model<IAnnouncement>("Announcement", AnnouncementSchema);
