import mongoose, { Schema } from "mongoose";

export interface TicketMessage {
    role: "user" | "bot" | "admin";
    text: string;
}

export interface ISupportTicket {
    telegramId: number;
    status: "open" | "resolved";
    raisedAt: Date;
    resolvedAt?: Date;
    issue: string;
    messages: TicketMessage[];
    legacy: boolean;
    stage?: "awaiting_details" | "ai" | "awaiting_feedback" | "admin";
    activeUntil?: Date;
    aiAttempts?: number;
    summary?: string;
    escalationReason?: string;
    escalatedAt?: Date;
    adminNotifiedAt?: Date;
    adminMessageIds?: number[];
    lastUserMessageId?: number;
    lastAdminMessageId?: number;
}

/** One current ticket per user; repeated /support updates or reopens it. */
const SupportTicketSchema = new Schema<ISupportTicket>({
    telegramId: { type: Number, required: true, unique: true },
    status: { type: String, enum: ["open", "resolved"], default: "open", required: true },
    raisedAt: { type: Date, required: true },
    resolvedAt: Date,
    issue: { type: String, default: "", maxlength: 1000 },
    messages: [{
        _id: false,
        role: { type: String, enum: ["user", "bot", "admin"], required: true },
        text: { type: String, required: true, maxlength: 3500 },
    }],
    legacy: { type: Boolean, default: false },
    stage: { type: String, enum: ["awaiting_details", "ai", "awaiting_feedback", "admin"] },
    activeUntil: Date,
    aiAttempts: { type: Number, default: 0 },
    summary: String,
    escalationReason: String,
    escalatedAt: Date,
    adminNotifiedAt: Date,
    adminMessageIds: [Number],
    lastUserMessageId: Number,
    lastAdminMessageId: Number,
});
SupportTicketSchema.index({ status: 1, raisedAt: -1 });

export const SupportTicket = mongoose.model<ISupportTicket>("SupportTicket", SupportTicketSchema);
