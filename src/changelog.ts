/**
 * Release notes announced to users when the deployed version changes.
 *
 * Only versions listed here are announced. Bumping the package version
 * without adding an entry deploys silently, which is the right default for
 * fixes users would not notice.
 */
export interface Release {
    title: string;
    notes: string[];
}

export const CHANGELOG: Record<string, Release> = {
    "1.2.0": {
        title: "Chat that works, and your tariff explained",
        notes: [
            "🤖 <b>Chat is working now.</b> Last update announced it, but it was broken for every message — sorry about that. Just type a question in Bangla, Banglish or English:",
            "   <i>\"koto din cholbe?\"</i> · <i>\"last 7 diner usage koto?\"</i> · <i>\"august e koto kharoch holo?\"</i>",
            "📊 <b>Slab breakdown</b> — ask <i>\"slab breakdown dao\"</i> to see which tariff band you're in, what you're paying per unit right now, and the dates it changed.",
            "⚡ <b>Why your bill climbs mid-month:</b> DESCO prices each month in bands that reset on the 1st, so the same unit costs noticeably more later in the month than at the start. The bot works your own rates out from your readings and shows where you stand.",
            "💡 <b>Worth knowing:</b> crossing 50 units in a month loses the cheapest rate for the <i>whole</i> month, not just the units above it.",
        ],
    },
    "1.1.0": {
        title: "Usage insights & smarter alerts",
        notes: [
            "📊 <b>/usage</b> — day-by-day breakdown for any period, with totals, daily averages and your busiest day",
            "💳 <b>/recharges</b> — see what each recharge actually credited after demand charge and VAT",
            "⏳ <b>Days-left estimates</b> now follow DESCO's banded tariff, which resets on the 1st, so the figure is no longer pessimistic at month end",
            "⚠️ <b>Low balance alerts</b> can now trigger on days remaining, not just a BDT amount — far more notice to recharge",
            "🔔 <b>Scheduled reminders</b> now fire reliably (they were silently never starting)",
            "🤖 <b>Just ask</b> — type a question like \"last 7 diner usage koto?\" or \"koto din cholbe?\" instead of remembering commands",
        ],
    },
};

export function releaseFor(version: string): Release | null {
    return CHANGELOG[version] ?? null;
}

export function formatRelease(version: string, release: Release): string {
    return [
        `<b>🎉 DESCO Bot updated — v${version}</b>`,
        `<i>${release.title}</i>`,
        "",
        ...release.notes.map((note) =>
            // A note starting with whitespace continues the previous line, so
            // it must not get a bullet of its own.
            /^\s/.test(note) ? note.trimEnd() : `• ${note}`
        ),
        "",
        "<i>Use /help to see all commands.</i>",
    ].join("\n");
}
