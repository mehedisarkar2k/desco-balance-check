import {
    DailyConsumption,
    DescoResponse,
    FetchBalanceParams,
    RechargeRecord,
    fetchBalance,
    fetchDailyConsumption,
    fetchRechargeHistory,
} from "../desco";
import { projectRunway, monthToDateUnits } from "../domain/runway";
import { PendingCharges, RechargeTerms, deriveRechargeTerms, pendingCharges } from "../domain/recharge";
import { staleAsOf } from "../descoStore";
import type { ReplyLanguage } from "../ai/language";
import { shiftDate, todayInBillingZone } from "./dates";

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
    /** The most recent day DESCO has a reading for. */
    latestDay?: DailyDelta;
    /**
     * True when yesterday's reading was checked for and DESCO has not
     * published it yet, as opposed to it being missing from a saved copy.
     */
    yesterdayUnpublished?: boolean;
}

const DAY_MS = 86_400_000;

function daysBetween(from: string, to: string): number {
    return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

function toDateString(date: Date): string {
    return date.toISOString().slice(0, 10);
}

export { todayInBillingZone };

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
    /**
     * The slab changed during this day, so its cost per unit mixes two rates
     * and is not a tariff DESCO charges. Crossing the 50-unit lifeline also
     * re-prices every earlier unit of the month, which is how one day in
     * September came out at "8.92 BDT/kWh" when no such rate exists.
     */
    slabChange?: boolean;
    /** On a slab-change day, the rate on the neighbouring days before and after it. */
    rateBefore?: number;
    rateAfter?: number;
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
        .filter((row) => row.date && Number.isFinite(row.consumedTaka) && Number.isFinite(row.consumedUnit))
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

    markSlabChanges(deltas);
    return deltas;
}

/**
 * Flags days whose cost per unit matches neither neighbouring day in the same
 * month. Within a slab consecutive days share a rate, so a day unlike both of
 * its neighbours is one where the slab changed. Neighbours in another month do
 * not count, since the rate resets on the 1st.
 */
function markSlabChanges(deltas: DailyDelta[]) {
    const rate = (day: DailyDelta) => (day.kwh > 0 ? day.taka / day.kwh : NaN);
    const same = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.05, 0.02 * Math.abs(b));

    deltas.forEach((day, i) => {
        const own = rate(day);
        if (!Number.isFinite(own)) return;

        const month = day.date.slice(0, 7);
        const inMonth = (n: DailyDelta | undefined): n is DailyDelta => Boolean(n) && n!.date.slice(0, 7) === month;
        const before = inMonth(deltas[i - 1]) ? rate(deltas[i - 1]) : NaN;
        const after = inMonth(deltas[i + 1]) ? rate(deltas[i + 1]) : NaN;
        const neighbours = [before, after].filter(Number.isFinite);

        if (neighbours.length > 0 && neighbours.every((other) => !same(own, other))) {
            day.slabChange = true;
            if (Number.isFinite(before)) day.rateBefore = Math.round(before * 100) / 100;
            if (Number.isFinite(after)) day.rateAfter = Math.round(after * 100) / 100;
        }
    });
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
    /** The daily readings behind `usage`, so any further projection uses the same inputs. */
    rows: DailyConsumption[] | null;
    /** The last year's recharges; null when DESCO could not supply them. */
    recharges: RechargeRecord[] | null;
    /** How a recharge converts to energy, measured from `recharges`. */
    terms: RechargeTerms;
    /** Fixed charges the next recharge will take first; null when none are owed or unknown. */
    pending: PendingCharges | null;
}

/** Recharges looked at: enough to measure the charges and find the last payment. */
const RECHARGE_WINDOW_DAYS = 365;

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
    const today = todayInBillingZone();

    // Asked for alongside the daily series, not after it. Without them the
    // balance is still reported, just without the charges a recharge will pay.
    const rechargesPromise = fetchRechargeHistory(params, shiftDate(today, -RECHARGE_WINDOW_DAYS), today, result.prefix)
        .catch((error: any) => {
            console.error("Failed to load recharge history:", error.message);
            return null;
        });

    let usage: UsageSummary | null = null;
    let rows: DailyConsumption[] | null = null;
    try {
        rows = await fetchDailyConsumption(params, dateFrom, dateTo, result.prefix);
        if (rows) {
            const rateStart = consumptionRange(result.data.readingTime, USAGE_WINDOW_DAYS + 1).dateFrom;
            const rateRows = rows.filter((row) => row.date >= rateStart);
            usage = summarizeUsage(
                rateRows.length >= 2 ? rateRows : rows,
                result.data.balance,
                result.data.readingTime,
                rows
            );

            if (usage) {
                const deltas = dailyDeltas(rows);
                const latestDay = deltas[deltas.length - 1];
                const yesterday = shiftDate(todayInBillingZone(), -1);

                usage.latestDay = latestDay;
                usage.yesterdayUnpublished = Boolean(latestDay && latestDay.date < yesterday && !staleAsOf(rows));
            }
        }
    } catch (error: any) {
        console.error("Failed to derive usage summary:", error.message);
    }

    const recharges = await rechargesPromise;
    const terms = deriveRechargeTerms(recharges ?? []);
    const pending = recharges ? pendingCharges(terms, today.slice(0, 7)) : null;

    return { success: true, report: { data: result.data, usage, rows, recharges, terms, pending } };
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
 * States that the runway is a projection, not a promise: an estimate from
 * recent use and the slab rates, so a hotter week or guests staying will
 * shorten it.
 */
export function forecastNote(language: ReplyLanguage): string {
    return language === "bn"
        ? "<i>ℹ️ কত দিন চলবে তা সাম্প্রতিক ব্যবহার ও স্ল্যাব রেট থেকে অনুমান।</i>"
        : "<i>ℹ️ Days left is an estimate from your recent use and the slab rates.</i>";
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
