import { DailyConsumption } from "../desco";
import {
    MonthPricing,
    buildMonthCurves,
    pricingFor,
    referenceCurve,
} from "./tariff";

const DAY_MS = 86_400_000;

/** Give up rather than loop forever on an implausibly small burn rate. */
const MAX_PROJECTION_DAYS = 400;

export interface Runway {
    /** Whole days of power left. */
    days: number;
    /** The date the balance is expected to reach zero. */
    runoutDate: Date;
    /** Average consumption used for the projection. */
    kwhPerDay: number;
    /** Cost per day at the customer's current position in the tariff. */
    takaPerDayNow: number;
    /**
     * True when the projection priced future months from the tariff curve
     * rather than assuming today's rate holds.
     */
    tariffAware: boolean;
}

function monthKey(date: Date): string {
    return date.toISOString().slice(0, 7);
}

function daysInMonth(date: Date): number {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
}

/** One projected day of consumption and what it will cost. */
export interface DaySpend {
    /** YYYY-MM-DD. */
    date: string;
    /** YYYY-MM. */
    month: string;
    kwh: number;
    cost: number;
}

/**
 * Future days of consumption, each priced against the tariff, starting the
 * day after `readingTime` and running for as long as the caller reads.
 *
 * A flat average is misleading here: the marginal rate climbs through a month
 * and resets on the 1st, so an estimate made late in the month assumes the
 * expensive band continues. Each day is charged at the rate for that month's
 * running total, and the total starts again at each month boundary.
 *
 * The runway and the recharge planner both read this one sequence, so the
 * date a balance runs out and the amount needed to reach a date can never
 * disagree. Returns null when no tariff curve can be built.
 *
 * `kwhOn` overrides the use on particular days, for time away: nothing when
 * the house is shut, or a little when a fridge stays on. Those days add only
 * that much to the month's running total, so the days after a return are
 * priced at the lower slab they really fall in.
 */
export function spendDays(
    rows: DailyConsumption[],
    readingTime: string,
    kwhPerDay: number,
    monthToDateUnits: number,
    kwhOn?: (date: string) => number | undefined
): Generator<DaySpend> | null {
    if (!(kwhPerDay > 0)) return null;

    const start = new Date(Date.parse(readingTime));
    if (Number.isNaN(start.getTime())) return null;

    const curves = buildMonthCurves(rows);
    const currentMonth = readingTime.slice(0, 7);
    const current = curves.find((curve) => curve.month === currentMonth) ?? null;
    const reference = referenceCurve(curves, currentMonth);

    if (!current && !reference) return null;

    const thisMonth = pricingFor(current, reference)!;
    const laterMonths = pricingFor(null, reference ?? current)!;

    return (function* () {
        let cursor = new Date(start.getTime());
        let units = monthToDateUnits;
        let month = monthKey(cursor);
        let price: MonthPricing = thisMonth;

        while (true) {
            cursor = new Date(cursor.getTime() + DAY_MS);

            // A new month restarts the tariff, so the running total resets and
            // pricing moves to a curve that covers a whole month.
            if (monthKey(cursor) !== month) {
                month = monthKey(cursor);
                units = 0;
                price = laterMonths;
            }

            const date = cursor.toISOString().slice(0, 10);
            const kwh = kwhOn?.(date) ?? kwhPerDay;
            if (!(kwh > 0)) {
                yield { date, month, kwh: 0, cost: 0 };
                continue;
            }

            const cost = price(units, units + kwh);
            // A curve that prices a day at nothing cannot project anything.
            if (!(cost > 0)) return;

            units += kwh;
            yield { date, month, kwh, cost };
        }
    })();
}

/** How long the balance lasts, priced against the tariff rather than at a flat rate. */
export function projectRunway(
    rows: DailyConsumption[],
    balance: number,
    readingTime: string,
    kwhPerDay: number,
    monthToDateUnits: number
): Runway | null {
    if (!Number.isFinite(balance)) return null;

    const days = spendDays(rows, readingTime, kwhPerDay, monthToDateUnits);
    if (!days) return null;

    const curves = buildMonthCurves(rows);
    const currentMonth = readingTime.slice(0, 7);
    const pricing = pricingFor(
        curves.find((c) => c.month === currentMonth) ?? null,
        referenceCurve(curves, currentMonth)
    )!;
    const takaPerDayNow = pricing(monthToDateUnits, monthToDateUnits + kwhPerDay);

    let remaining = balance;
    let count = 0;
    let last: DaySpend | null = null;

    if (remaining > 0) {
        for (const day of days) {
            remaining -= day.cost;
            count += 1;
            last = day;
            if (remaining <= 0 || count >= MAX_PROJECTION_DAYS) break;
        }
    }

    // Still money left: the projection ran past its horizon or could not price a day.
    if (remaining > 0) return null;

    return {
        days: count,
        runoutDate: last ? new Date(Date.parse(last.date)) : new Date(Date.parse(readingTime)),
        kwhPerDay,
        takaPerDayNow,
        tariffAware: true,
    };
}

/**
 * Month-to-date consumption in kWh as of the latest reading, needed to know
 * where in the tariff the customer currently sits.
 */
export function monthToDateUnits(rows: DailyConsumption[], readingTime: string): number | null {
    const month = readingTime.slice(0, 7);
    const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));

    const baselineIndex = sorted.findIndex((row) => row.date.slice(0, 7) === month);

    // No reading for this month yet: the 1st, before DESCO has published one.
    // Nothing has been used in the month as far as the readings show, so it
    // starts at zero. Giving up here made the forecast fall back to a flat
    // rate at last month's expensive price, on exactly the day the reset
    // matters most.
    if (baselineIndex === -1) {
        const latest = sorted[sorted.length - 1];
        return latest && latest.date < `${month}-01` ? 0 : null;
    }
    if (baselineIndex === 0) return null;

    const baseline = sorted[baselineIndex - 1];
    if (baseline.date.slice(0, 7) === month) return null;

    const latest = sorted[sorted.length - 1];
    const units = latest.consumedUnit - baseline.consumedUnit;

    return units >= 0 ? units : null;
}

/** Days in the current month still ahead of the reading date. */
export function daysLeftInMonth(readingTime: string): number {
    const date = new Date(Date.parse(readingTime));
    return daysInMonth(date) - date.getUTCDate();
}
