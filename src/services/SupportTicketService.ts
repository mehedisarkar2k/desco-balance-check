import { SupportTicket } from "../models/SupportTicket";
import { User } from "../models/User";
import { supportTranscript } from "../ai/session";
import { CODE_TTL_MS } from "./SupportService";

export const SUPPORT_THREAD_MS = 24 * 60 * 60 * 1000;

export async function raiseSupportTicket(telegramId: number, issue: string) {
    return SupportTicket.findOneAndUpdate(
        { telegramId },
        {
            $set: {
                status: "open", raisedAt: new Date(), issue: issue.slice(0, 1000),
                messages: supportTranscript(telegramId), legacy: false,
                stage: "awaiting_details", activeUntil: new Date(Date.now() + SUPPORT_THREAD_MS),
                aiAttempts: 0, adminMessageIds: [],
            },
            $unset: { resolvedAt: 1, escalatedAt: 1, adminNotifiedAt: 1, summary: 1, escalationReason: 1, lastUserMessageId: 1, lastAdminMessageId: 1 },
        },
        { upsert: true, new: true, runValidators: true }
    );
}

/** Old alerts left only the code expiry behind. Recover those without exposing the code. */
export async function recoverLegacyTickets() {
    const users = await User.find({ supportCodeExpiresAt: { $type: "date" } })
        .select("telegramId supportCodeExpiresAt").lean();
    if (users.length === 0) return;
    await SupportTicket.bulkWrite(users.map((user) => ({
        updateOne: {
            filter: { telegramId: user.telegramId },
            update: { $setOnInsert: {
                telegramId: user.telegramId,
                status: "open",
                raisedAt: new Date(user.supportCodeExpiresAt!.getTime() - CODE_TTL_MS),
                issue: "Earlier support alert; no issue text or conversation was stored.",
                messages: [],
                legacy: true,
            } },
            upsert: true,
        },
    })));
}
