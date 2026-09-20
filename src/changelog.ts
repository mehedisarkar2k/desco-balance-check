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
        ...release.notes.map((note) => `• ${note}`),
        "",
        "<i>Use /help to see all commands.</i>",
    ].join("\n");
}
