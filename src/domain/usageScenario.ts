import type { DailyConsumption } from "../desco";
import { shiftDate } from "../utils/dates";

export interface UsageOptions {
    dailyKwh?: number;
    usageWindowDays?: number;
    usageIncreasePercent?: number;
}

export interface UsageScenario {
    kwhPerDay: number;
    baseKwhPerDay: number;
    /** Null for a user-specified daily rate. */
    usageWindowDays: number | null;
    sampleDays: number | null;
    usageIncreasePercent: number;
}

export function parseUsageOptions(args: UsageOptions): UsageOptions | { error: string } {
    const { dailyKwh, usageWindowDays, usageIncreasePercent } = args;
    if (dailyKwh !== undefined && (!Number.isFinite(dailyKwh) || dailyKwh <= 0 || dailyKwh > 1000)) {
        return { error: "dailyKwh must be a number greater than 0 and at most 1000." };
    }
    if (usageWindowDays !== undefined && (!Number.isInteger(usageWindowDays) || usageWindowDays < 1 || usageWindowDays > 90)) {
        return { error: "usageWindowDays must be a whole number from 1 to 90." };
    }
    if (usageIncreasePercent !== undefined && (!Number.isFinite(usageIncreasePercent) || usageIncreasePercent < 0 || usageIncreasePercent > 1000)) {
        return { error: "usageIncreasePercent must be a number from 0 to 1000." };
    }
    if (dailyKwh !== undefined && usageWindowDays !== undefined) {
        return { error: "Choose dailyKwh or usageWindowDays as the baseline, not both." };
    }
    return { dailyKwh, usageWindowDays, usageIncreasePercent };
}

/** A custom window ends at the newest reading. Missing days are weighted by their span. */
export function resolveUsageScenario(
    rows: DailyConsumption[],
    defaultUsage: { kwhPerDay: number; sampleDays: number } | null,
    options: UsageOptions,
    defaultWindowDays: number
): UsageScenario | { error: string } {
    let base = options.dailyKwh ?? defaultUsage?.kwhPerDay;
    const windowDays = options.dailyKwh !== undefined ? null : options.usageWindowDays ?? defaultWindowDays;
    let sampleDays: number | null = options.dailyKwh !== undefined ? null : defaultUsage?.sampleDays ?? 0;

    if (options.usageWindowDays !== undefined) {
        const sorted = rows.filter((r) => Number.isFinite(r.consumedUnit)).sort((a, b) => a.date.localeCompare(b.date));
        if (sorted.length < 2) return { error: "Not enough daily readings for that usage window." };
        const start = shiftDate(sorted[sorted.length - 1].date, -options.usageWindowDays);
        let units = 0;
        sampleDays = 0;
        for (let i = 1; i < sorted.length; i++) {
            const prev = sorted[i - 1];
            const cur = sorted[i];
            const span = (Date.parse(cur.date) - Date.parse(prev.date)) / 86_400_000;
            const overlap = (Date.parse(cur.date) - Date.parse(prev.date > start ? prev.date : start)) / 86_400_000;
            const delta = cur.consumedUnit - prev.consumedUnit;
            if (span <= 0 || overlap <= 0 || delta < 0) continue;
            units += delta * overlap / span;
            sampleDays += overlap;
        }
        base = sampleDays > 0 ? units / sampleDays : undefined;
    }

    if (base === undefined || !Number.isFinite(base) || base <= 0) {
        return { error: "Not enough positive usage readings to project; ask for an assumed daily kWh rate." };
    }
    const increase = options.usageIncreasePercent ?? 0;
    return {
        kwhPerDay: base * (1 + increase / 100),
        baseKwhPerDay: base,
        usageWindowDays: windowDays,
        sampleDays,
        usageIncreasePercent: increase,
    };
}
