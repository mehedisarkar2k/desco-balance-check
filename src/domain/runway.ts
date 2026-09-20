import { DailyConsumption } from "../desco";
import {
    MonthCurve,
    buildMonthCurves,
    costBetween,
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

/**
 * How long the balance lasts, priced against the tariff rather than at a flat
 * rate.
 *
 * A flat average is misleading here: the marginal rate climbs through a month
 * and resets on the 1st, so an estimate made late in the month assumes the
 * expensive band continues and reports a shorter runway than the customer
 * actually has. This walks forward a day at a time, charging each day at the
 * rate for that month's running total and starting the total again at each
 * month boundary.
 */
export function projectRunway(
    rows: DailyConsumption[],
    balance: number,
    readingTime: string,
    kwhPerDay: number,
    monthToDateUnits: number
): Runway | null {
    if (!(kwhPerDay > 0) || !Number.isFinite(balance)) return null;

    const start = new Date(Date.parse(readingTime));
    if (Number.isNaN(start.getTime())) return null;

    const curves = buildMonthCurves(rows);
    const currentMonth = readingTime.slice(0, 7);
    const current = curves.find((curve) => curve.month === currentMonth) ?? null;
    const reference = referenceCurve(curves, currentMonth);

    if (!current && !reference) {
        return null;
    }

    let remaining = balance;
    let cursor = new Date(start.getTime());
    let units = monthToDateUnits;
    let month = monthKey(cursor);
    let curve: MonthCurve = current ?? reference!;
    let days = 0;

    const takaPerDayNow = costBetween(curve, units, units + kwhPerDay);

    while (remaining > 0 && days < MAX_PROJECTION_DAYS) {
        cursor = new Date(cursor.getTime() + DAY_MS);

        // A new month restarts the tariff, so the running total resets and
        // pricing moves to a curve that covers a whole month.
        if (monthKey(cursor) !== month) {
            month = monthKey(cursor);
            units = 0;
            curve = reference ?? curve;
        }

        const cost = costBetween(curve, units, units + kwhPerDay);
        if (!(cost > 0)) return null;

        remaining -= cost;
        units += kwhPerDay;
        days += 1;
    }

    if (days >= MAX_PROJECTION_DAYS) return null;

    return {
        days,
        runoutDate: cursor,
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
    if (baselineIndex <= 0) return null;

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
