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
    forecastNote,
    USAGE_WINDOW_DAYS,
    TARIFF_WINDOW_DAYS,
} from "./usage";

/** Bounds for the period the user may ask about. */
export const MIN_OVERVIEW_DAYS = 1;
export const MAX_OVERVIEW_DAYS = 90;

/** Recharges listed in the overview, newest first. */
const MAX_RECHARGES_SHOWN = 5;

/**
 * Rows in the day-by-day table. DESCO only serves about 45 days of readings,
 * so this is a guard against an unexpectedly long response rather than a limit
 * users will normally meet.
 */
const MAX_DAILY_ROWS = 45;

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
    /** Per-day usage, oldest first, for the day-by-day table. */
    entries: DailyDelta[];
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

    // Ranked by kWh, not cost. DESCO's tariff is banded, so the rate per unit
    // climbs through the month and resets on the 1st; ranking by taka would
    // report where the month's total had reached rather than the busiest day.
    const byUsage = [...singleDays].sort((a, b) => a.kwh - b.kwh);

    return {
        fromDate: deltas[0].date,
        toDate: deltas[deltas.length - 1].date,
        days,
        totalTaka,
        totalKwh,
        takaPerDay: totalTaka / days,
        kwhPerDay: totalKwh / days,
        highest: byUsage.length > 0 ? byUsage[byUsage.length - 1] : null,
        lowest: byUsage.length > 0 ? byUsage[0] : null,
        entries: deltas,
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
    // Always reach back far enough for the tariff curve, even for a short report.
    const { dateFrom, dateTo } = consumptionRange(
        readingTime,
        Math.max(requestedDays + 1, TARIFF_WINDOW_DAYS)
    );
    const periodStart = consumptionRange(readingTime, requestedDays + 1).dateFrom;

    let period: PeriodSummary | null = null;
    let usage: UsageSummary | null = null;
    let recharges: RechargeRecord[] | null = null;

    try {
        const rows = await fetchDailyConsumption(params, dateFrom, dateTo, result.prefix);
        if (rows) {
            // The report covers the requested period; the curve uses everything.
            const periodRows = rows.filter((row) => row.date >= periodStart);
            period = summarizePeriod(dailyDeltas(periodRows.length >= 2 ? periodRows : rows));

            // The runway always uses the standard window, so a 30-day overview
            // does not report a different "days left" than /balance does.
            const windowStart = consumptionRange(readingTime, USAGE_WINDOW_DAYS + 1).dateFrom;
            const recent = rows.filter((row) => row.date >= windowStart);
            usage = summarizeUsage(
                recent.length >= 2 ? recent : rows,
                result.data.balance,
                readingTime,
                rows
            );
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

/**
 * Day-by-day table inside a <pre> block so the columns align in Telegram.
 * A step covering a gap is marked, since its figure is the total for several
 * days rather than for the one date shown.
 */
function formatDailyTable(entries: DailyDelta[]): string[] {
    if (entries.length === 0) return [];

    const rows = entries.slice(-MAX_DAILY_ROWS);
    const hasGap = rows.some((row) => row.spanDays > 1);

    const body = rows.map((row) => {
        const label = formatDayMonth(new Date(Date.parse(row.date)))
            + (row.spanDays > 1 ? ` *${row.spanDays}d` : "");
        return `${label.padEnd(11)}${row.kwh.toFixed(2).padStart(6)}${row.taka.toFixed(2).padStart(9)}`;
    });

    const lines = [
        "",
        "📅 <b>Day by day:</b>",
        `<pre>${["Date          kWh      BDT", ...body].join("\n")}</pre>`,
    ];

    if (entries.length > rows.length) {
        lines.push(`<i>Showing the most recent ${rows.length} of ${entries.length} days.</i>`);
    }
    if (hasGap) {
        lines.push("<i>* DESCO skipped a reading; that row covers several days.</i>");
    }

    return lines;
}

/**
 * Recharges for a period on their own, with the split between energy credit
 * and charges spelled out. The first recharge of a month carries that month's
 * demand charge, so two equal payments can credit very different amounts.
 */
export async function getRecharges(
    params: FetchBalanceParams,
    requestedDays: number
): Promise<{ success: boolean; recharges?: RechargeRecord[]; error?: string }> {
    const result = await fetchBalance(params);

    if (!result.success || !result.data) {
        return { success: false, error: result.error };
    }

    const { dateFrom, dateTo } = consumptionRange(result.data.readingTime, requestedDays);
    const recharges = await fetchRechargeHistory(params, dateFrom, dateTo, result.prefix);

    if (recharges === null) {
        return { success: false, error: "Could not load recharge history from DESCO" };
    }

    return { success: true, recharges };
}

export function formatRechargeHistoryMessage(
    recharges: RechargeRecord[],
    requestedDays: number
): string {
    const lines = [`<b>💳 Recharge History — Last ${requestedDays} days</b>`];

    if (recharges.length === 0) {
        lines.push("", "<i>No recharges found in this period.</i>");
        return lines.join("\n");
    }

    const total = recharges.reduce((sum, r) => sum + r.totalAmount, 0);
    const energy = recharges.reduce((sum, r) => sum + r.energyAmount, 0);
    const charges = recharges.reduce((sum, r) => sum + r.chargeAmount, 0);

    lines.push(
        "",
        `<b>Paid:</b> <code>${total.toFixed(2)} BDT</code> across ${recharges.length} recharge${recharges.length === 1 ? "" : "s"}`,
        `⚡ <b>Became energy:</b> <code>${energy.toFixed(2)} BDT</code>`,
        `🧾 <b>Charges &amp; VAT:</b> <code>${charges.toFixed(2)} BDT</code> (${((charges / total) * 100).toFixed(1)}%)`,
        ""
    );

    for (const r of recharges) {
        const date = formatDayMonth(new Date(Date.parse(r.rechargeDate.slice(0, 10))));
        const ok = /success/i.test(r.orderStatus);

        lines.push(
            `${ok ? "•" : "⚠️"} <b>${date}</b> — <code>${r.totalAmount.toFixed(2)} BDT</code>`,
            `   energy <code>${r.energyAmount.toFixed(2)}</code> · charges <code>${r.chargeAmount.toFixed(2)}</code>`,
            `   via ${r.rechargeOperator}${ok ? "" : ` · <b>${r.orderStatus}</b>`}`
        );
    }

    return lines.join("\n");
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
                `🔺 <b>Busiest:</b> <code>${period.highest.kwh.toFixed(2)} kWh</code> on ${formatDayMonth(new Date(Date.parse(period.highest.date)))}`,
                `🔻 <b>Quietest:</b> <code>${period.lowest.kwh.toFixed(2)} kWh</code> on ${formatDayMonth(new Date(Date.parse(period.lowest.date)))}`
            );
        }

        lines.push(...formatDailyTable(period.entries));
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

    if (usage) {
        lines.push("", forecastNote(usage));
    }

    return lines.join("\n");
}
