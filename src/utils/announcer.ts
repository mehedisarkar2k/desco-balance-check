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

export const ANNOUNCE_CONFIRM = "announce_send";
export const ANNOUNCE_DISMISS = "announce_dismiss";

/** The version being offered for announcement, set when the admin is prompted. */
let pendingVersion: string | null = null;

export function getPendingVersion(): string | null {
    return pendingVersion;
}

export function currentVersion(): string {
    return require("../../package.json").version;
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
    const recipients = await reachableUserCount();

    await bot.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `<b>📢 New version ready to announce</b>\n\n` +
        `This would reach <b>${recipients}</b> user${recipients === 1 ? "" : "s"}. Preview:\n\n` +
        `━━━━━━━━━━━━━━\n${formatRelease(version, release)}\n━━━━━━━━━━━━━━`,
        {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
                [Markup.button.callback(`📢 Send to ${recipients} users`, ANNOUNCE_CONFIRM)],
                [Markup.button.callback("🔕 Don't announce", ANNOUNCE_DISMISS)],
            ]),
        }
    );
}

/** Runs the broadcast the admin approved. */
export async function sendPendingAnnouncement(bot: Telegraf): Promise<string> {
    const version = pendingVersion;
    if (!version) return "⚠️ No announcement is pending.";

    const release = releaseFor(version);
    if (!release) return "⚠️ No release notes found for this version.";

    // Claiming first means a crash mid-broadcast cannot re-send to everyone.
    if (!(await claimAnnouncement(version))) {
        pendingVersion = null;
        return `⚠️ v${version} was already announced.`;
    }

    pendingVersion = null;
    const result = await broadcast(bot, formatRelease(version, release));
    await recordAnnouncementResult(version, result);

    return `✅ <b>v${version} announced</b>\n\n` +
        `Sent: <b>${result.sent}</b>\n` +
        `Unreachable (blocked bot): <b>${result.blocked}</b>\n` +
        `Failed: <b>${result.failed}</b>`;
}

export function dismissPendingAnnouncement(): string {
    const version = pendingVersion;
    pendingVersion = null;
    return version
        ? `🔕 v${version} will not be announced. It will be offered again on next restart.`
        : "🔕 Nothing pending.";
}
