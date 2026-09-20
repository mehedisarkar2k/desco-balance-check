import { Telegraf } from "telegraf";
import { User } from "../models/User";
import { Announcement } from "../models/Announcement";

/**
 * Telegram allows roughly 30 messages a second to distinct chats before it
 * starts returning 429. Sending a little under that leaves headroom for the
 * bot's ordinary replies, which share the same budget.
 */
const MESSAGES_PER_SECOND = 20;
const SEND_GAP_MS = Math.ceil(1000 / MESSAGES_PER_SECOND);

export interface BroadcastResult {
    sent: number;
    blocked: number;
    failed: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A user who has blocked the bot, deleted their account, or never opened a
 * chat. Telegram will keep rejecting these, so they are marked rather than
 * retried on every future broadcast.
 */
function isPermanentDeliveryFailure(error: any): boolean {
    const code = error?.response?.error_code ?? error?.code;
    const description: string = error?.response?.description ?? error?.message ?? "";

    if (code === 403) return true;
    if (code === 400 && /chat not found|user is deactivated/i.test(description)) return true;

    return false;
}

/** Seconds Telegram asked us to wait, when it returns 429. */
function retryAfterSeconds(error: any): number | null {
    const code = error?.response?.error_code ?? error?.code;
    if (code !== 429) return null;

    const after = error?.response?.parameters?.retry_after;
    return typeof after === "number" ? after : 1;
}

/**
 * Sends one message to every user, paced to stay inside Telegram's limits.
 *
 * Delivery failures never abort the run: one blocked user must not stop the
 * rest of the broadcast.
 */
export async function broadcast(bot: Telegraf, message: string): Promise<BroadcastResult> {
    const users = await User.find({ blockedAt: { $exists: false } }).select("telegramId");
    const result: BroadcastResult = { sent: 0, blocked: 0, failed: 0 };

    for (const user of users) {
        try {
            await bot.telegram.sendMessage(user.telegramId, message, {
                parse_mode: "HTML",
                link_preview_options: { is_disabled: true },
            });
            result.sent += 1;
        } catch (error: any) {
            const retryAfter = retryAfterSeconds(error);

            if (retryAfter !== null) {
                // Rate limited: wait out the cooldown and give this user one retry.
                await sleep((retryAfter + 1) * 1000);
                try {
                    await bot.telegram.sendMessage(user.telegramId, message, {
                        parse_mode: "HTML",
                        link_preview_options: { is_disabled: true },
                    });
                    result.sent += 1;
                    continue;
                } catch (retryError: any) {
                    error = retryError;
                }
            }

            if (isPermanentDeliveryFailure(error)) {
                await User.updateOne({ telegramId: user.telegramId }, { blockedAt: new Date() });
                result.blocked += 1;
                console.warn(`Broadcast: ${user.telegramId} unreachable, marked blocked`);
            } else {
                result.failed += 1;
                console.error(`Broadcast: failed for ${user.telegramId}:`, error.message);
            }
        }

        await sleep(SEND_GAP_MS);
    }

    return result;
}

/**
 * Claims a version for announcement, returning false if it was already taken.
 *
 * The claim is made before any message is sent, so a crash midway through a
 * broadcast leaves some users un-notified rather than notifying everyone twice
 * on the next restart. Missing an announcement is the lesser failure, and the
 * admin can resend deliberately.
 */
export async function claimAnnouncement(version: string): Promise<boolean> {
    try {
        await Announcement.create({ version });
        return true;
    } catch (error: any) {
        // Duplicate key: this version has already been announced.
        if (error?.code === 11000) return false;
        throw error;
    }
}

export async function recordAnnouncementResult(version: string, result: BroadcastResult) {
    await Announcement.updateOne(
        { version },
        {
            sentCount: result.sent,
            blockedCount: result.blocked,
            failedCount: result.failed,
            announcedAt: new Date(),
        }
    );
}

export async function hasAnnounced(version: string): Promise<boolean> {
    return (await Announcement.countDocuments({ version })) > 0;
}

/** Users a broadcast would currently reach. */
export async function reachableUserCount(): Promise<number> {
    return await User.countDocuments({ blockedAt: { $exists: false } });
}
