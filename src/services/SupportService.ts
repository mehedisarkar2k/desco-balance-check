import { randomInt } from "crypto";
import { Context } from "telegraf";
import { User, IUser } from "../models/User";
import { ADMIN_CHAT_ID, sendMessage } from "../bot";
import { resetSession } from "../ai/session";
import { escapeHtml } from "../utils/html";

/** A support code has to be used this soon after the user asked for it. */
const CODE_TTL_MS = 15 * 60 * 1000;

/** Acting for a user ends on its own after this long. */
export const ACTING_TTL_MS = 60 * 60 * 1000;

interface Acting {
    userId: number;
    until: number;
    timer: NodeJS.Timeout;
}

/**
 * Whom the admin is acting for. Kept in memory on purpose: a restart ends it,
 * so the admin can never be left acting for someone without knowing it.
 */
let acting: Acting | null = null;

/**
 * The account a message acts on. The sender's own, except for the admin
 * while acting for someone, when it is that person's. The admin is recognised
 * by chat id, which nothing in a message can change.
 */
export function userIdOf(ctx: Context): number | undefined {
    const senderId = ctx.from?.id;
    if (senderId === ADMIN_CHAT_ID && acting) return acting.userId;
    return senderId;
}

export function actingFor(): { userId: number; until: Date } | null {
    return acting ? { userId: acting.userId, until: new Date(acting.until) } : null;
}

export function describeUser(user: Pick<IUser, "telegramId" | "firstName" | "lastName" | "username">): string {
    const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || "No name";
    const handle = user.username ? ` (@${user.username})` : "";
    return `${escapeHtml(name + handle)}, ID <code>${user.telegramId}</code>`;
}

/**
 * A new 6-digit code for the user, replacing any earlier one. Codes are
 * short enough to read out; they are safe because only the admin can redeem
 * one, only once, and only within CODE_TTL_MS.
 */
export async function issueSupportCode(telegramId: number): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
        const inUse = await User.exists({ supportCode: code, supportCodeExpiresAt: { $gt: new Date() } });
        if (inUse) continue;

        await User.updateOne(
            { telegramId },
            { supportCode: code, supportCodeExpiresAt: new Date(Date.now() + CODE_TTL_MS) }
        );
        return code;
    }
    throw new Error("Could not find a free support code");
}

/**
 * Starts acting for the user the code belongs to. The code is cleared in the
 * same update that finds it, so it works once. Returns null for a wrong or
 * expired code.
 */
export async function startActing(code: string): Promise<IUser | null> {
    const user = await User.findOneAndUpdate(
        { supportCode: code, supportCodeExpiresAt: { $gt: new Date() } },
        { $unset: { supportCode: 1, supportCodeExpiresAt: 1 } }
    );
    if (!user) return null;

    if (acting) await stopActing("switched");

    const timer = setTimeout(() => {
        stopActing("expired").catch((error) => console.error("Failed to end acting session:", error));
    }, ACTING_TTL_MS);
    timer.unref();
    acting = { userId: user.telegramId, until: Date.now() + ACTING_TTL_MS, timer };

    // The admin's chat so far was about their own account.
    resetSession(ADMIN_CHAT_ID);
    console.log(`Admin started acting for ${user.telegramId}`);

    await sendMessage(
        "🛠 <b>The admin is now helping with your account</b>, using the support code you shared.\n\n" +
        "They can see and change your bot settings until they finish, for at most 1 hour. " +
        "You'll get a message when they are done.",
        user.telegramId
    );
    return user;
}

export type StopReason = "done" | "expired" | "switched" | "removed";

/** Ends acting for someone, telling both sides. Does nothing if not acting. */
export async function stopActing(reason: StopReason): Promise<void> {
    if (!acting) return;

    const { userId, timer } = acting;
    clearTimeout(timer);
    acting = null;
    resetSession(ADMIN_CHAT_ID);
    console.log(`Admin stopped acting for ${userId} (${reason})`);

    const userMessage = reason === "removed"
        ? "👋 The admin has removed your account from this bot, as you asked. Your saved details are deleted " +
          "and you won't get any more messages.\n\nSend /start any time to come back."
        : "✅ The admin has finished helping with your account and can no longer access it.";
    await sendMessage(userMessage, userId);

    if (reason === "expired") {
        await sendMessage(`⌛ Acting for ID <code>${userId}</code> ended after 1 hour. You're back on your own account.`, ADMIN_CHAT_ID);
    }
}
