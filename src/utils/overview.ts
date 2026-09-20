import {
    DescoResponse,
    FetchBalanceParams,
    RechargeRecord,
    fetchBalance,
    fetchDailyConsumption,
    fetchRechargeHistory,
} from "../desco";
import {
    DailyDelta,
    UsageSummary,
    consumptionRange,
    dailyDeltas,
    summarizeUsage,
    formatDayMonth,
    USAGE_WINDOW_DAYS,
} from "./usage";

/** Bounds for the period the user may ask about. */
export const MIN_OVERVIEW_DAYS = 1;
export const MAX_OVERVIEW_DAYS = 90;

/** Recharges listed in the overview, newest first. */
const MAX_RECHARGES_SHOWN = 5;

export interface PeriodSummary {
    fromDate: string;
    toDate: string;
    /** Days actually covered, which may be short if DESCO has gaps. */
    days: number;
    totalTaka: number;
    totalKwh: number;
    takaPerDay: number;
    kwhPerDay: number;
    /** Busiest and quietest single day; null if every step spans a gap. */
    highest: DailyDelta | null;
    lowest: DailyDelta | null;
}

export interface Overview {
    requestedDays: number;
    balance: DescoResponse;
    usage: UsageSummary | null;
    period: PeriodSummary | null;
    /** Null when the lookup failed, empty when there were simply no recharges. */
    recharges: RechargeRecord[] | null;
}

export function summarizePeriod(deltas: DailyDelta[]): PeriodSummary | null {
    if (deltas.length === 0) return null;

    const totalTaka = deltas.reduce((sum, d) => sum + d.taka, 0);
    const totalKwh = deltas.reduce((sum, d) => sum + d.kwh, 0);
    const days = deltas.reduce((sum, d) => sum + d.spanDays, 0);

    if (days <= 0) return null;

    // A step covering several days would look like a spike next to single days,
    // so only true one-day steps are eligible for the high/low reading.
    const singleDays = deltas.filter((d) => d.spanDays === 1);
    const byTaka = [...singleDays].sort((a, b) => a.taka - b.taka);

    return {
        fromDate: deltas[0].date,
        toDate: deltas[deltas.length - 1].date,
        days,
        totalTaka,
        totalKwh,
        takaPerDay: totalTaka / days,
        kwhPerDay: totalKwh / days,
        highest: byTaka.length > 0 ? byTaka[byTaka.length - 1] : null,
        lowest: byTaka.length > 0 ? byTaka[0] : null,
    };
}

/**
 * Balance, usage over the requested window, and recharges in the same window.
 * Only the balance is required; the rest degrade to null on failure.
 */
export async function getOverview(
    params: FetchBalanceParams,
    requestedDays: number
): Promise<{ success: boolean; overview?: Overview; error?: string; attemptedUrls?: string[] }> {
    const result = await fetchBalance(params);

    if (!result.success || !result.data) {
        return { success: false, error: result.error, attemptedUrls: result.attemptedUrls };
    }

    const readingTime = result.data.readingTime;
    // One extra day of history, since N daily figures need N+1 cumulative readings.
    const { dateFrom, dateTo } = consumptionRange(readingTime, requestedDays + 1);

    let period: PeriodSummary | null = null;
    let usage: UsageSummary | null = null;
    let recharges: RechargeRecord[] | null = null;

    try {
        const rows = await fetchDailyConsumption(params, dateFrom, dateTo, result.prefix);
        if (rows) {
            period = summarizePeriod(dailyDeltas(rows));

            // The runway always uses the standard window, so a 30-day overview
            // does not report a different "days left" than /balance does.
            const windowStart = consumptionRange(readingTime, USAGE_WINDOW_DAYS + 1).dateFrom;
            const recent = rows.filter((row) => row.date >= windowStart);
            usage = summarizeUsage(recent.length >= 2 ? recent : rows, result.data.balance, readingTime);
        }
    } catch (error: any) {
        console.error("Overview: failed to load daily consumption:", error.message);
    }

    try {
        recharges = await fetchRechargeHistory(params, dateFrom, dateTo, result.prefix);
    } catch (error: any) {
        console.error("Overview: failed to load recharge history:", error.message);
    }

    return {
        success: true,
        overview: { requestedDays, balance: result.data, usage, period, recharges },
    };
}

function formatRechargeLine(recharge: RechargeRecord): string {
    // rechargeDate is "YYYY-MM-DD HH:mm:ss.S"; only the date is worth showing.
    const date = formatDayMonth(new Date(Date.parse(recharge.rechargeDate.slice(0, 10))));
    const failed = !/success/i.test(recharge.orderStatus);

    return `  • ${date} — <code>${recharge.totalAmount.toFixed(0)} BDT</code> ` +
        `(energy <code>${recharge.energyAmount.toFixed(2)}</code>)` +
        (failed ? ` ⚠️ ${recharge.orderStatus}` : "");
}

export function formatOverviewMessage(overview: Overview): string {
    const { requestedDays, balance, usage, period, recharges } = overview;
    const lines: string[] = [];

    lines.push(`<b>📊 Usage Overview — Last ${requestedDays} day${requestedDays === 1 ? "" : "s"}</b>`);

    if (period) {
        const from = formatDayMonth(new Date(Date.parse(period.fromDate)));
        const to = formatDayMonth(new Date(Date.parse(period.toDate)));
        lines.push(`<i>${from} – ${to}</i>`, "");

        if (period.days < requestedDays) {
            lines.push(`<i>⚠️ DESCO only has ${period.days} day(s) of readings for this range.</i>`, "");
        }

        lines.push(
            `⚡ <b>Used:</b> <code>${period.totalKwh.toFixed(2)} kWh</code> · <code>${period.totalTaka.toFixed(2)} BDT</code>`,
            `📉 <b>Daily avg:</b> <code>${period.kwhPerDay.toFixed(2)} kWh</code> · <code>${period.takaPerDay.toFixed(2)} BDT</code>`
        );

        if (period.highest && period.lowest && period.highest.date !== period.lowest.date) {
            lines.push(
                `🔺 <b>Highest:</b> <code>${period.highest.taka.toFixed(2)} BDT</code> on ${formatDayMonth(new Date(Date.parse(period.highest.date)))}`,
                `🔻 <b>Lowest:</b> <code>${period.lowest.taka.toFixed(2)} BDT</code> on ${formatDayMonth(new Date(Date.parse(period.lowest.date)))}`
            );
        }
    } else {
        lines.push("", "<i>No consumption readings available for this range.</i>");
    }

    lines.push("", `💰 <b>Balance:</b> <code>${balance.balance.toFixed(2)} BDT</code>`);

    if (usage) {
        const days = Math.floor(usage.daysRemaining);
        lines.push(
            `⏳ <b>Runs out:</b> <code>~${days} ${days === 1 ? "day" : "days"}</code> (around ${formatDayMonth(usage.runoutDate)})`
        );
    }

    lines.push(`⚡ <b>This month:</b> <code>${balance.currentMonthTaka.toFixed(2)} BDT</code>`);

    if (recharges === null) {
        lines.push("", "<i>Recharge history unavailable right now.</i>");
    } else if (recharges.length === 0) {
        lines.push("", `💳 <b>Recharges (last ${requestedDays}d):</b> none`);
    } else {
        // Labelled with the requested window, because recharge history reaches
        // further back than the daily readings do.
        const total = recharges.reduce((sum, r) => sum + r.totalAmount, 0);
        lines.push(
            "",
            `💳 <b>Recharges (last ${requestedDays}d):</b> ${recharges.length} · <code>${total.toFixed(0)} BDT</code> total`
        );
        lines.push(...recharges.slice(0, MAX_RECHARGES_SHOWN).map(formatRechargeLine));

        if (recharges.length > MAX_RECHARGES_SHOWN) {
            lines.push(`  <i>…and ${recharges.length - MAX_RECHARGES_SHOWN} more</i>`);
        }
    }

    lines.push("", `📅 <b>Reading:</b> <code>${balance.readingTime}</code>`);

    return lines.join("\n");
}
