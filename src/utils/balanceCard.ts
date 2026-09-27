import type { ReplyLanguage } from "../ai/language";
import { MONTHS, MONTHS_BN_OF } from "../ai/rechargeCard";
import { DescoResponse } from "../desco";
import { PendingCharges } from "../domain/recharge";
import { shiftDate, todayInBillingZone } from "./dates";
import { DailyDelta, UsageSummary, forecastNote, formatDayMonth, isLowBalance, staleNote } from "./usage";

/**
 * The balance card and the low-balance alert, in the user's language. Like
 * the recharge card, written in code rather than by the model so the figures,
 * labels and advice stay together and the wording does not drift between the
 * scheduled reminder and the same card asked for in chat.
 */

export interface BalanceCardOptions {
    language: ReplyLanguage;
    thresholdTaka: number;
    thresholdDays: number;
}

/** "25 অক্টোবর" / "25 Oct" from a Date DESCO parses as UTC midnight. */
function dateLabel(date: Date, language: ReplyLanguage): string {
    if (language === "en") return formatDayMonth(date);
    const iso = date.toISOString().slice(0, 10);
    return `${Number(iso.slice(8, 10))} ${MONTHS.bn[Number(iso.slice(5, 7)) - 1]}`;
}

/** "25 অক্টোবরের", for "before 25 October". The ending follows the name's last sound. */
function dateOfBn(date: Date): string {
    const iso = date.toISOString().slice(0, 10);
    return `${Number(iso.slice(8, 10))} ${MONTHS_BN_OF[Number(iso.slice(5, 7)) - 1]}`;
}

function daysWord(days: number): string {
    return `${days} ${days === 1 ? "day" : "days"}`;
}

/**
 * The balance block shared by on-demand checks and scheduled notifications.
 * The usage lines are dropped when the daily series is unavailable.
 */
export function formatBalanceMessage(
    data: DescoResponse,
    usage: UsageSummary | null,
    options: BalanceCardOptions,
    heading?: string,
    pending?: PendingCharges | null
): string {
    const bn = options.language === "bn";
    const taka = bn ? "টাকা" : "BDT";
    const lines: string[] = [];

    if (heading) lines.push(`<b>${heading}</b>`, "");

    lines.push(`💰 <b>${bn ? "ব্যালেন্স" : "Balance"}:</b> <code>${data.balance.toFixed(2)} ${taka}</code>`);

    if (usage?.latestDay) {
        lines.push(...latestDayLines(usage.latestDay, Boolean(usage.yesterdayUnpublished), options.language));
    }

    if (usage) {
        const days = Math.floor(usage.daysRemaining);
        const left = bn ? `~${days} দিন` : `~${daysWord(days)}`;
        const around = bn ? `প্রায় ${dateLabel(usage.runoutDate, "bn")}` : `around ${formatDayMonth(usage.runoutDate)}`;
        lines.push(
            `⏳ <b>${bn ? "শেষ হবে" : "Runs out"}:</b> <code>${left}</code> (${around})`,
            `📉 <b>${bn ? "গড় খরচ" : "Avg use"}:</b> <code>${usage.takaPerDay.toFixed(2)} ${bn ? "টাকা/দিন" : "BDT/day"}</code> · <code>${usage.kwhPerDay.toFixed(2)} kWh</code>`
        );
    }

    // "Balance date", not "Reading": a reading date next to usage that ran
    // only to the day before left people asking which day it referred to.
    lines.push(
        `⚡ <b>${bn ? "এই মাসে" : "This month"}:</b> <code>${data.currentMonthTaka.toFixed(2)} ${taka}</code>`,
        `📅 <b>${bn ? "ব্যালেন্সের তারিখ" : "Balance date"}:</b> <code>${dateLabel(new Date(Date.parse(data.readingTime)), options.language)}</code>`
    );

    if (pending) {
        lines.push(...pendingChargeLines(pending, options.language));
    }

    if (usage) {
        lines.push("", ...adviceLines(data, usage, options), forecastNote(options.language));
    }

    const stale = staleNote(data);
    if (stale) {
        lines.push("", stale);
    }

    return lines.join("\n");
}

/**
 * The most recent day's usage, labelled with its real date: "Yesterday" only
 * when it is yesterday. Before DESCO publishes the morning's reading the
 * newest day is the one before, and labelling that as yesterday is exactly
 * the mistake users caught the assistant making.
 */
function latestDayLines(day: DailyDelta, yesterdayUnpublished: boolean, language: ReplyLanguage): string[] {
    const bn = language === "bn";
    const yesterday = shiftDate(todayInBillingZone(), -1);
    const label = day.date === yesterday ? (bn ? "গতকাল" : "Yesterday") : (bn ? "সর্বশেষ দিন" : "Latest day");
    const date = dateLabel(new Date(Date.parse(day.date)), language);
    const rate = day.kwh > 0 ? ` · <code>${(day.taka / day.kwh).toFixed(2)}/kWh</code>` : "";
    const span = day.spanDays > 1 ? ` <i>(${bn ? `${day.spanDays} দিনের মিলে` : `covers ${day.spanDays} days`})</i>` : "";

    const lines = [
        `🔌 <b>${label} (${date}):</b> <code>${day.kwh.toFixed(2)} kWh</code> · <code>${day.taka.toFixed(2)} ${bn ? "টাকা" : "BDT"}</code>${rate}${span}`,
    ];
    if (yesterdayUnpublished) {
        const when = dateLabel(new Date(Date.parse(yesterday)), language);
        lines.push(bn ? `<i>DESCO এখনো ${when} প্রকাশ করেনি।</i>` : `<i>DESCO has not published ${when} yet.</i>`);
    }
    return lines;
}

/** "Sep" for "2026-09". */
function monthLabel(month: string, language: ReplyLanguage): string {
    if (language === "bn") return MONTHS.bn[Number(month.slice(5, 7)) - 1];
    return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
}

/**
 * The fixed charges waiting for the next recharge.
 *
 * DESCO takes each month's demand charge from the first recharge made in or
 * after that month, never from the balance on the meter. A household that
 * skipped a month (away, or the balance lasted) found its next recharge buying
 * far less power than usual with nothing explaining why.
 */
function pendingChargeLines(pending: PendingCharges, language: ReplyLanguage): string[] {
    const bn = language === "bn";
    const months = pending.months.map((m) => monthLabel(m, language)).join(", ");
    // Whole taka per month times the months, the same figures chat gives, so
    // the two never differ by a paisa of rounding.
    const perMonth = Math.round(pending.amountBDT / pending.months.length);
    const amount = `<code>${perMonth * pending.months.length} ${bn ? "টাকা" : "BDT"}</code>`;
    const first = bn
        ? `🧾 <b>ফিক্সড চার্জ বাকি:</b> ${amount} (${months}), পরের রিচার্জ থেকে আগে কাটবে`
        : `🧾 <b>Fixed charge${pending.months.length > 1 ? "s" : ""} due:</b> ${amount} (${months}), taken from your next recharge first`;

    if (pending.months.length === 1) return [first];

    return [
        first,
        bn
            ? "<i>রিচার্জ না করা প্রতি মাসে আরেকটা চার্জ যোগ হয়। লেট ফি নেই, তবে এর চেয়ে বেশি রিচার্জ করলে তবেই বিদ্যুৎ যোগ হয়।</i>"
            : "<i>Each month without a recharge adds one more. There is no late fee, but a recharge " +
              "has to be larger than this to add any power.</i>",
    ];
}

/** The last day of the month "YYYY-MM", as YYYY-MM-DD. */
function lastDayOfMonth(month: string): string {
    const [year, m] = month.split("-").map(Number);
    return new Date(Date.UTC(year, m, 0)).toISOString().slice(0, 10);
}

/** A newest day at least this much above the daily average counts as unusually heavy. */
const SPIKE_RATIO = 1.3;

/**
 * Closer than this, a run-out date gets a "recharge before then" line even
 * when it falls next month: 5 days left on the 27th is not "nothing to do".
 */
const SOON_DAYS = 7;

/**
 * The advice line, in this order: low balance, running out within the month,
 * an unusually heavy latest day, or all clear.
 */
function adviceText(data: DescoResponse, usage: UsageSummary, options: BalanceCardOptions): string {
    const bn = options.language === "bn";

    if (isLowBalance(data.balance, usage, options.thresholdTaka, options.thresholdDays)) {
        const days = Math.floor(usage.daysRemaining);
        const date = bn ? dateOfBn(usage.runoutDate) : formatDayMonth(usage.runoutDate);
        return bn ? `⚠️ ব্যালেন্স কম: আর ~${days} দিন চলবে, ${date} আগেই রিচার্জ করুন।` : `⚠️ Balance is low: about ${daysWord(days)} left, recharge before ${date}.`;
    }

    const runout = usage.runoutDate.toISOString().slice(0, 10);
    if (runout < lastDayOfMonth(todayInBillingZone().slice(0, 7)) || usage.daysRemaining < SOON_DAYS) {
        const date = dateLabel(usage.runoutDate, options.language);
        return bn ? `💡 এই গতিতে ব্যালেন্স ~${date} শেষ হবে। তার আগেই রিচার্জ করুন।` : `💡 At this rate it runs out around ${date}. Recharge before then.`;
    }

    const latest = usage.latestDay;
    if (latest && usage.kwhPerDay > 0 && latest.kwh >= SPIKE_RATIO * usage.kwhPerDay) {
        const date = dateLabel(new Date(Date.parse(latest.date)), options.language);
        const pct = Math.round((latest.kwh / usage.kwhPerDay - 1) * 100);
        return bn ? `📈 ${date} আপনি সাধারণ দিনের চেয়ে প্রায় ${pct}% বেশি ব্যবহার করেছেন।` : `📈 ${date} you used about ${pct}% more than your usual day.`;
    }

    const days = Math.floor(usage.daysRemaining);
    return bn ? `✅ আর ~${days} দিন চলবে। এখন কিছু করতে হবে না।` : `✅ Enough for about ${daysWord(days)}. Nothing to do for now.`;
}

/**
 * The advice line followed by a hint for asking how much to recharge.
 * Without usage data only the BDT-threshold low case is shown, and no hint.
 */
function adviceLines(data: DescoResponse, usage: UsageSummary | null, options: BalanceCardOptions): string[] {
    if (!usage) {
        if (data.balance > options.thresholdTaka) return [];
        const bn = options.language === "bn";
        return [
            bn
                ? `⚠️ ব্যালেন্স কম (${options.thresholdTaka} টাকার নিচে)। শেষ হওয়ার আগেই রিচার্জ করুন।`
                : `⚠️ Balance is low (${options.thresholdTaka} BDT or less). Recharge before it runs out.`,
        ];
    }

    const hint = options.language === "bn"
        ? `<i>কত রিচার্জ করবেন জানতে লিখুন "কত রিচার্জ করব?"</i>`
        : `<i>Ask me "how much should I recharge?" for an amount.</i>`;
    return [adviceText(data, usage, options), hint];
}

export function formatLowBalanceAlert(
    balance: number,
    usage: UsageSummary | null,
    options: { language: ReplyLanguage; thresholdTaka: number },
    pending?: PendingCharges | null
): string {
    const bn = options.language === "bn";
    // The runway line, or in the no-usage case the limit that fired, so the
    // alert always says why it was sent.
    const days = usage ? Math.floor(usage.daysRemaining) : 0;
    const runway = usage
        ? bn ? ` — আর ~<b>${days} দিন</b> চলবে (দিনে ${usage.takaPerDay.toFixed(2)} টাকা)` : ` — about <b>${daysWord(days)}</b> left at ${usage.takaPerDay.toFixed(2)} BDT/day`
        : bn ? ` (সীমা: ${options.thresholdTaka} টাকা)` : ` (threshold: ${options.thresholdTaka} BDT)`;

    const lines = [
        `<b>⚠️ ${bn ? "ব্যালেন্স কম!" : "Low Balance Alert!"}</b>`,
        "",
        bn ? `আপনার ব্যালেন্স <code>${balance.toFixed(2)} টাকা</code>${runway}।` : `Your balance is <code>${balance.toFixed(2)} BDT</code>${runway}.`,
        "",
        bn ? "ডিসকানেক্ট এড়াতে শীঘ্রই রিচার্জ করুন।" : "Recharge soon to avoid disconnection.",
    ];

    if (pending) {
        lines.push("", ...pendingChargeLines(pending, options.language));
    }

    // What to do if it does run out, since that is when people need it and
    // are least likely to have it to hand.
    lines.push(
        "",
        bn
            ? "<i>🆘 বিদ্যুৎ শেষ হয়ে গেলে: মিটারের ইমার্জেন্সি বাটন চাপলে ইমার্জেন্সি ব্যালেন্স পাওয়া যায়। DESCO বিকাল " +
              "4টা থেকে সকাল 10টা, শুক্রবার ও শনিবার এবং সরকারি ছুটির দিনে বিদ্যুৎ বিচ্ছিন্ন করে না। ইমার্জেন্সি " +
              "টাকা পরের রিচার্জ থেকে কাটবে, কোনো সুদ নেই।</i>"
            : "<i>🆘 If it runs out: press the meter's emergency button for emergency balance. DESCO does not " +
              "cut power between 4 pm and 10 am, on Fridays and Saturdays, or on government holidays. The " +
              "emergency amount comes back out of your next recharge, with no interest.</i>"
    );

    return lines.join("\n");
}
