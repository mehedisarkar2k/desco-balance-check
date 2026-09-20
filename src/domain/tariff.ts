import { DailyConsumption } from "../desco";

/**
 * DESCO prices a month's consumption in bands, and the rate is not constant
 * through the month:
 *
 *   - Under a lifeline allowance the whole month bills at one low rate.
 *   - Past it the bands apply progressively, so the marginal rate climbs.
 *   - The counter resets on the 1st, which is why the same kWh costs far less
 *     early in the month than late in it.
 *
 * The band rates are not hardcoded. They changed partway through 2026, and
 * they differ by customer category, so they are instead recovered from the
 * customer's own readings: `consumedTaka` is the month's running cost and
 * `consumedUnit` is a lifetime meter reading, so the pair gives a cumulative
 * cost curve that already encodes whatever tariff is in force.
 */

export interface CurvePoint {
    /** Month-to-date consumption in kWh. */
    units: number;
    /** Month-to-date cost in BDT. */
    taka: number;
}

export interface MonthCurve {
    /** "YYYY-MM". */
    month: string;
    /** Cumulative points, ascending, anchored at the origin. */
    points: CurvePoint[];
}

/**
 * Cumulative cost curves, one per month, newest last.
 *
 * A month is only usable when the series includes a reading from the previous
 * month, because month-to-date units are the difference against that baseline.
 * Months without one are skipped rather than guessed at.
 */
export function buildMonthCurves(rows: DailyConsumption[]): MonthCurve[] {
    const sorted = [...rows]
        .filter((row) => row.date && Number.isFinite(row.consumedUnit) && Number.isFinite(row.consumedTaka))
        .sort((a, b) => a.date.localeCompare(b.date));

    const curves = new Map<string, MonthCurve>();
    const baselines = new Map<string, number>();

    sorted.forEach((row, i) => {
        const month = row.date.slice(0, 7);

        if (!baselines.has(month)) {
            const prev = sorted[i - 1];
            // Without a reading from the previous month there is no baseline,
            // so month-to-date units cannot be derived for this month.
            if (!prev || prev.date.slice(0, 7) === month) return;

            baselines.set(month, prev.consumedUnit);
            curves.set(month, { month, points: [{ units: 0, taka: 0 }] });
        }

        const baseline = baselines.get(month);
        if (baseline === undefined) return;

        const units = row.consumedUnit - baseline;
        if (units <= 0) return;

        curves.get(month)!.points.push({ units, taka: row.consumedTaka });
    });

    return [...curves.values()]
        .filter((curve) => curve.points.length >= 2)
        .sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * Cost of the first `units` kWh of a month, read off the curve.
 *
 * Between observed points this interpolates; past the last one it continues at
 * the final observed marginal rate, which is the best available guess at the
 * band the customer is currently in.
 */
export function costUpTo(curve: MonthCurve, units: number): number {
    const points = curve.points;
    if (units <= 0) return 0;

    for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1];
        const cur = points[i];
        if (units > cur.units) continue;

        const span = cur.units - prev.units;
        if (span <= 0) return cur.taka;

        const rate = (cur.taka - prev.taka) / span;
        return prev.taka + (units - prev.units) * rate;
    }

    // Beyond the observed range: extend at the last marginal rate.
    const last = points[points.length - 1];
    const prev = points[points.length - 2];
    const span = last.units - prev.units;
    const rate = span > 0 ? (last.taka - prev.taka) / span : 0;

    return last.taka + (units - last.units) * rate;
}

/** Cost of consuming from `fromUnits` to `toUnits` within one month. */
export function costBetween(curve: MonthCurve, fromUnits: number, toUnits: number): number {
    return Math.max(0, costUpTo(curve, toUnits) - costUpTo(curve, fromUnits));
}

/**
 * The curve to price a *future* month with.
 *
 * The current month only reveals the bands reached so far, so a completed
 * month is preferred: it covers the higher bands a future month will also
 * cross. Falls back to the newest curve available.
 */
export function referenceCurve(curves: MonthCurve[], currentMonth: string): MonthCurve | null {
    if (curves.length === 0) return null;

    const completed = curves.filter((curve) => curve.month !== currentMonth);
    if (completed.length === 0) return curves[curves.length - 1];

    // The one reaching furthest, so extrapolation starts as late as possible.
    return completed.reduce((best, curve) =>
        curve.points[curve.points.length - 1].units > best.points[best.points.length - 1].units ? curve : best
    );
}
