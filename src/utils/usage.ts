import {
    DailyConsumption,
    DescoResponse,
    FetchBalanceParams,
    fetchBalance,
    fetchDailyConsumption,
} from "../desco";
import { projectRunway, monthToDateUnits } from "../domain/runway";
import { staleAsOf } from "../descoStore";

/**
 * Days of history used for the burn-rate average. Fixed, so the runway shown by
 * /balance and by any /usage period agree with each other.
 */
export const USAGE_WINDOW_DAYS = 14;

/**
 * History fetched to build the tariff curve. Wide enough to always include a
 * reading from the previous month, which is the baseline month-to-date
 * consumption is measured against.
 */
export const TARIFF_WINDOW_DAYS = 40;

export interface UsageSummary {
    takaPerDay: number;
    kwhPerDay: number;
    daysRemaining: number;
    runoutDate: Date;
    /** Days actually covered by the sample, which may be less than requested. */
    sampleDays: number;
    /** True when the runway was priced against the tariff, not a flat average. */
    tariffAware: boolean;
}

const DAY_MS = 86_400_000;

function daysBetween(from: string, to: string): number {
    return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

function toDateString(date: Date): string {
    return date.toISOString().slice(0, 10);
}

/**
 * Today in the billing timezone, as YYYY-MM-DD.
 *
 * A date anchor that does not require calling DESCO first, so a lookup needing
 * only a date range is not taken down by an unrelated endpoint being slow.
 */
export function todayInBillingZone(): string {
    return new Date().toLocaleDateString("en-CA", {
        timeZone: process.env.TZ || "Asia/Dhaka",
    });
}

/** Date range ending the day before `readingTime`, covering `days` days. */
export function consumptionRange(readingTime: string, days: number): { dateFrom: string; dateTo: string } {
    const end = Date.parse(readingTime);
    return {
        dateFrom: toDateString(new Date(end - days * DAY_MS)),
        dateTo: toDateString(new Date(end)),
    };
}

export interface DailyDelta {
    /** The day usage is attributed to, i.e. the later of the two readings. */
    date: string;
    taka: number;
    kwh: number;
    /** Days this step covers. Above 1 means readings were missing in between. */
    spanDays: number;
}

/**
 * Per-step usage from DESCO's cumulative counters.
 *
 * Both counters need care: `consumedTaka` is month-to-date and resets on the
 * 1st, and days go missing from the series entirely, so each step records the
 * number of days it actually spans rather than assuming one.
 */
export function dailyDeltas(rows: DailyConsumption[]): DailyDelta[] {
    const sorted = rows
        .filter((row) => row.date && Number.isFinite(row.consumedTaka))
        .sort((a, b) => a.date.localeCompare(b.date));

    const deltas: DailyDelta[] = [];

    for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const cur = sorted[i];

        const spanDays = daysBetween(prev.date, cur.date);
        if (spanDays <= 0) continue;

        deltas.push({
            date: cur.date,
            // A drop in consumedTaka means a new month began, so the current
            // value is already that period's usage rather than a running total.
            taka: cur.consumedTaka >= prev.consumedTaka
                ? cur.consumedTaka - prev.consumedTaka
                : cur.consumedTaka,
            // consumedUnit only goes backwards if the meter was replaced.
            kwh: cur.consumedUnit >= prev.consumedUnit
                ? cur.consumedUnit - prev.consumedUnit
                : 0,
            spanDays,
        });
    }

    return deltas;
}

/**
 * Average burn rate and runway from the daily series.
 *
 * `rateRows` sets the averaging window; `allRows` may reach further back so the
 * tariff curve can find a previous-month baseline. When that curve is
 * available the runway is projected against the tariff, which matters because
 * a flat average taken late in a month assumes the expensive band continues
 * past the 1st and reports a shorter runway than the customer really has.
 */
export function summarizeUsage(
    rateRows: DailyConsumption[],
    balance: number,
    readingTime: string,
    allRows: DailyConsumption[] = rateRows
): UsageSummary | null {
    const deltas = dailyDeltas(rateRows);
    if (deltas.length === 0) return null;

    const taka = deltas.reduce((sum, d) => sum + d.taka, 0);
    const kwh = deltas.reduce((sum, d) => sum + d.kwh, 0);
    const days = deltas.reduce((sum, d) => sum + d.spanDays, 0);

    if (days <= 0 || taka <= 0) return null;

    const takaPerDay = taka / days;
    const kwhPerDay = kwh / days;

    const monthUnits = monthToDateUnits(allRows, readingTime);
    const runway = monthUnits === null
        ? null
        : projectRunway(allRows, balance, readingTime, kwhPerDay, monthUnits);

    if (runway) {
        return {
            takaPerDay,
            kwhPerDay,
            daysRemaining: runway.days,
            runoutDate: runway.runoutDate,
            sampleDays: days,
            tariffAware: true,
        };
    }

    // No usable tariff curve: fall back to a flat average.
    const daysRemaining = Math.max(0, balance / takaPerDay);
    return {
        takaPerDay,
        kwhPerDay,
        daysRemaining,
        runoutDate: new Date(Date.parse(readingTime) + daysRemaining * DAY_MS),
        sampleDays: days,
        tariffAware: false,
    };
}

export interface BalanceReport {
    data: DescoResponse;
    /** Null when the daily series is unavailable; the balance is still usable. */
    usage: UsageSummary | null;
}

/**
 * Fetches the balance and, when possible, the recent daily series to derive a
 * burn rate. A failure to get the series is not fatal.
 */
export async function getBalanceReport(params: FetchBalanceParams): Promise<{
    success: boolean;
    report?: BalanceReport;
    error?: string;
    attemptedUrls?: string[];
}> {
    const result = await fetchBalance(params);

    if (!result.success || !result.data) {
        return {
            success: false,
            error: result.error,
            attemptedUrls: result.attemptedUrls,
        };
    }

    const { dateFrom, dateTo } = consumptionRange(result.data.readingTime, TARIFF_WINDOW_DAYS);

    let usage: UsageSummary | null = null;
    try {
        const rows = await fetchDailyConsumption(params, dateFrom, dateTo, result.prefix);
        if (rows) {
            const rateStart = consumptionRange(result.data.readingTime, USAGE_WINDOW_DAYS + 1).dateFrom;
            const rateRows = rows.filter((row) => row.date >= rateStart);
            usage = summarizeUsage(
                rateRows.length >= 2 ? rateRows : rows,
                result.data.balance,
                result.data.readingTime,
                rows
            );
        }
    } catch (error: any) {
        console.error("Failed to derive usage summary:", error.message);
    }

    return { success: true, report: { data: result.data, usage } };
}

/** Short "8 Oct" style date. Dates from DESCO are parsed as UTC midnight. */
export function formatDayMonth(date: Date): string {
    return date.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        timeZone: "UTC",
    });
}

/**
 * The balance block shared by on-demand checks and scheduled notifications.
 * The usage lines are dropped when the daily series is unavailable.
 */
export function formatBalanceMessage(
    data: DescoResponse,
    usage: UsageSummary | null,
    heading?: string
): string {
    const lines: string[] = [];

    if (heading) {
        lines.push(`<b>${heading}</b>`, "");
    }

    lines.push(`💰 <b>Balance:</b> <code>${data.balance.toFixed(2)} BDT</code>`);

    if (usage) {
        const days = Math.floor(usage.daysRemaining);
        lines.push(
            `⏳ <b>Runs out:</b> <code>~${days} ${days === 1 ? "day" : "days"}</code> (around ${formatDayMonth(usage.runoutDate)})`,
            `📉 <b>Avg use:</b> <code>${usage.takaPerDay.toFixed(2)} BDT/day</code> · <code>${usage.kwhPerDay.toFixed(2)} kWh</code>`
        );
    }

    lines.push(
        `⚡ <b>This month:</b> <code>${data.currentMonthTaka.toFixed(2)} BDT</code>`,
        `📅 <b>Reading:</b> <code>${data.readingTime}</code>`
    );

    if (usage) {
        lines.push("", forecastNote(usage));
    }

    const stale = staleNote(data);
    if (stale) {
        lines.push("", stale);
    }

    return lines.join("\n");
}

/**
 * A line telling the user they are looking at a saved copy, or null when the
 * data is live. Showing saved figures without saying so would pass off an old
 * balance as the current one.
 */
export function staleNote(...sources: unknown[]): string | null {
    const times = sources.map(staleAsOf).filter((t): t is Date => Boolean(t));
    if (times.length === 0) return null;

    const oldest = new Date(Math.min(...times.map((t) => new Date(t).getTime())));
    const when = oldest.toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: process.env.TZ || "Asia/Dhaka",
    });

    return `<i>⚠️ DESCO is not responding right now, so this is the saved data from ${when}. ` +
        `It will refresh by itself once DESCO is back.</i>`;
}

/**
 * States that the runway is a projection, not a promise.
 *
 * It assumes consumption carries on at the recent average, so a hotter week or
 * guests staying will shorten it. Presented as a bare number it reads like a
 * fact about the account, which invites people to leave recharging until the
 * day before it says they will run out.
 */
export function forecastNote(usage: UsageSummary): string {
    return usage.tariffAware
        ? `<i>ℹ️ Days left is a forecast: your recent usage priced against DESCO's ` +
          `slab rates, including the reset on the 1st. Use more and it will be shorter.</i>`
        : `<i>ℹ️ Days left is a rough forecast at your recent average rate. There aren't ` +
          `enough readings yet to apply DESCO's slab rates, so expect it to be off.</i>`;
}

/** Whether the account should be treated as low: by runway if known, else by balance. */
export function isLowBalance(
    balance: number,
    usage: UsageSummary | null,
    thresholdTaka: number,
    thresholdDays: number
): boolean {
    if (balance <= thresholdTaka) return true;
    return usage !== null && usage.daysRemaining <= thresholdDays;
}

export function formatLowBalanceAlert(
    balance: number,
    usage: UsageSummary | null,
    thresholdTaka: number
): string {
    const runway = usage
        ? ` — about <b>${Math.floor(usage.daysRemaining)} days</b> left at ${usage.takaPerDay.toFixed(2)} BDT/day`
        : ` (threshold: ${thresholdTaka} BDT)`;

    return `<b>⚠️ Low Balance Alert!</b>\n\n` +
        `Your balance is <code>${balance.toFixed(2)} BDT</code>${runway}.\n\n` +
        `Recharge soon to avoid disconnection.`;
}
