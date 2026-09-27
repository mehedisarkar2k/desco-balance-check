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
    "2.1.0": {
        title: "Clearer balance, recharge help, and replies in your language",
        notes: [
            "👋 <b>Haven't set up yet?</b> Send /start. It's just one number now, your account or meter number, and the bot checks it with DESCO for you.",
            "🔔 <b>Want a daily update?</b> Type <i>\"reminder 9 tay dao\"</i> and your balance comes every morning.",
            "💰 <b>Balance with advice.</b> Type <i>\"balance\"</i> or <i>\"balance koto\"</i> and you get a clear card. It ends with one line on what to do: recharge soon, recharge before a date, or nothing to do for now.",
            "🗣 <b>Your language.</b> If you chat in Bangla or Banglish, the daily update and the low-balance alert now come in Bangla too.",
            "🔌 <b>How much to recharge.</b> Ask <i>\"10 tarikh porjonto koto recharge lagbe?\"</i> or <i>\"500 dile koto din cholbe?\"</i>. You get the amount, a safe amount and the date it runs out. Ask for the <i>\"hiseb\"</i> to see the slab-by-slab calculation.",
            "✈️ <b>Going away?</b> Tell it your dates, like <i>\"10 tarikh gram e jabo, 8 nov e ashbo\"</i>, and it plans the recharge around the trip, even with a fridge left on.",
            "🧾 <b>Fixed charges shown.</b> Each month's demand charge is taken from your next recharge. The balance card now shows what is waiting, so a smaller-than-usual recharge makes sense.",
            "⏰ <b>Change reminders by chat.</b> <i>\"sokal 8 tay reminder dao\"</i> or <i>\"200 taka hole janaw\"</i>. Setting a time also turns reminders on.",
            "🆘 <b>If power runs out,</b> the low-balance alert explains the meter's emergency button.",
            "🙋 /support reaches the admin. /leave deletes your details.",
        ],
    },
    "2.0.0": {
        title: "See exactly what you pay per unit",
        notes: [
            "📊 <b>New Tariff column</b> in /usage — every day now shows what you paid <i>per unit</i>, not just the total. Watch the rate climb through the month and drop back on the 1st:",
            "   <code>31 Aug  10.02 kWh  91.18 BDT  9.10</code>",
            "   <code> 1 Sept  7.44 kWh  34.45 BDT  4.63</code>",
            "⚡ <b>Far more reliable.</b> /usage and /recharges used to fail completely whenever DESCO was slow, even when the data they needed was fine. Each part now loads on its own and retries, so you get whatever DESCO could give instead of an error.",
            "⏳ <b>Days-left is labelled as a forecast</b> — it prices your recent usage against the slab rates, including the reset on the 1st, but it is an estimate and will move if your usage does.",
            "💬 Ask <i>\"slab breakdown dao\"</i> to see which band you are in and the dates your rate changed.",
        ],
    },
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
