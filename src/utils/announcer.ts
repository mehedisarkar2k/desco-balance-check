import { Telegraf, Markup } from "telegraf";
import { ADMIN_CHAT_ID } from "../bot";
import { releaseFor, formatRelease } from "../changelog";
import {
    broadcast,
    claimAnnouncement,
    hasAnnounced,
    recordAnnouncementResult,
    reachableUserCount,
} from "../services/BroadcastService";
import { stripTelegramHtml } from "../ai/telegramHtml";

export const ANNOUNCE_CONFIRM = "announce_send";
export const ANNOUNCE_DISMISS = "announce_dismiss";
export const ANNOUNCE_EDIT = "announce_edit";

/** The version being offered for announcement, set when the admin is prompted. */
let pendingVersion: string | null = null;
let pendingText: string | null = null;

export function getPendingVersion(): string | null {
    return pendingVersion;
}

export function getPendingText(): string | null {
    return pendingText;
}

export function setPendingText(text: string): void {
    pendingText = text;
}

export function currentVersion(): string {
    return require("../../package.json").version;
}

export async function sendAnnouncementPreview(bot: Telegraf): Promise<void> {
    const text = pendingText;
    if (!text) return;

    const recipients = await reachableUserCount();
    const message =
        `<b>📢 New version ready to announce</b>\n\n` +
        `This would reach <b>${recipients}</b> user${recipients === 1 ? "" : "s"}. Preview:\n\n` +
        `━━━━━━━━━━━━━━\n${text}\n━━━━━━━━━━━━━━`;
    const buttons = Markup.inlineKeyboard([
        [Markup.button.callback(`📢 Send to ${recipients} users`, ANNOUNCE_CONFIRM)],
        [Markup.button.callback("✏️ Change", ANNOUNCE_EDIT)],
        [Markup.button.callback("🔕 Don't announce", ANNOUNCE_DISMISS)],
    ]);

    try {
        await bot.telegram.sendMessage(ADMIN_CHAT_ID, message, {
            parse_mode: "HTML",
            ...buttons,
        });
    } catch (error: any) {
        if (!/parse entities|can't parse/i.test(error?.message ?? "")) throw error;
        // What the admin approves is what goes out: markup Telegram rejected
        // here would fail for every user, and the version cannot be resent.
        pendingText = stripTelegramHtml(text);
        await bot.telegram.sendMessage(ADMIN_CHAT_ID, stripTelegramHtml(message), buttons);
    }
}

/**
 * Offers the current version's release notes to the admin for approval.
 *
 * Deliberately does not broadcast by itself. A deploy would otherwise message
 * every user the moment it booted, with no chance to read the notes first or
 * to hold them back, and a bad announcement cannot be recalled.
 */
export async function offerVersionAnnouncement(bot: Telegraf) {
    const version = currentVersion();
    const release = releaseFor(version);

    if (!release) return; // Nothing worth announcing for this version.
    if (await hasAnnounced(version)) return;

    pendingVersion = version;
    pendingText = formatRelease(version, release);

    await sendAnnouncementPreview(bot);
}

/** Runs the broadcast the admin approved. */
export async function sendPendingAnnouncement(bot: Telegraf): Promise<string> {
    const version = pendingVersion;
    const text = pendingText;
    if (!version || !text) return "⚠️ No announcement is pending.";

    // Claiming first means a crash mid-broadcast cannot re-send to everyone.
    if (!(await claimAnnouncement(version))) {
        pendingVersion = null;
        pendingText = null;
        return `⚠️ v${version} was already announced.`;
    }

    pendingVersion = null;
    pendingText = null;
    const result = await broadcast(bot, text);
    await recordAnnouncementResult(version, result);

    return `✅ <b>v${version} announced</b>\n\n` +
        `Sent: <b>${result.sent}</b>\n` +
        `Unreachable (blocked bot): <b>${result.blocked}</b>\n` +
        `Failed: <b>${result.failed}</b>`;
}

export function dismissPendingAnnouncement(): string {
    const version = pendingVersion;
    pendingVersion = null;
    pendingText = null;
    return version
        ? `🔕 v${version} will not be announced. It will be offered again on next restart.`
        : "🔕 Nothing pending.";
}
