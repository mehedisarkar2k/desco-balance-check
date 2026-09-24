import { RechargeRecord } from "../desco";
import { DaySpend } from "./runway";

/**
 * How a recharge turns into energy credit, and which fixed charges it pays.
 *
 * The rules, from BERC's 2026 retail tariff order and the Power Division's
 * statement on prepaid meters, and confirmed against this account's receipts:
 *
 *   - The amount paid includes 5% VAT.
 *   - A 0.5% rebate on the amount before VAT is added back as energy.
 *   - A fixed monthly demand charge (42 BDT per kW of sanctioned load) is
 *     collected by recharges, never deducted from the balance on the meter.
 *   - A month with no recharge still owes its charge. It builds up and the next
 *     recharge collects every unpaid month at once. There is no late fee on
 *     prepaid arrears; the 5% surcharge is a postpaid rule.
 *
 * So a recharge of T that pays k months' charges credits T x share - k x D,
 * where D is the monthly demand charge. The share is measured from the
 * account's own history (0.957119 on the account this was built against),
 * and D is read per account because it depends on the sanctioned load.
 */
export interface RechargeTerms {
    /** Share of each taka paid that becomes energy credit. */
    energyShare: number;
    /**
     * One month's fixed charge expressed as recharge money: the amount that
     * has to be paid to cover it. Null if it could not be measured.
     */
    monthlyChargeBDT: number | null;
    /** The latest month (YYYY-MM) with a recharge; its charge and all earlier ones are paid. */
    lastRechargeMonth: string | null;
    /** True when energyShare came from this account's history rather than the default. */
    derived: boolean;
}

/**
 * 5% VAT included in the amount, plus a 0.5% rebate on the amount before VAT,
 * as the tariff order writes it: (1 / 1.05) x (1 + 0.005 / 1.005) = 0.957119.
 * Used only when an account has no recharge to measure the share from.
 */
const DEFAULT_ENERGY_SHARE = (1 / 1.05) * (1 + 0.005 / 1.005);

/** A recharge whose charges are VAT alone runs at about 4.3%; well above that it paid fixed charges. */
const VAT_ONLY_MAX_SHARE = 0.06;

/** No recharge collects more than a year of unpaid charges in these calculations. */
const MAX_MONTHS_OWED = 12;

function median(values: number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function nextMonth(month: string): string {
    const [year, m] = month.split("-").map(Number);
    return new Date(Date.UTC(year, m, 1)).toISOString().slice(0, 7);
}

/** Months strictly after `after`, up to and including `through`, oldest first. */
export function monthsAfter(after: string, through: string): string[] {
    const months: string[] = [];
    for (let m = nextMonth(after); m <= through && months.length < MAX_MONTHS_OWED; m = nextMonth(m)) {
        months.push(m);
    }
    return months;
}

export function deriveRechargeTerms(recharges: RechargeRecord[]): RechargeTerms {
    // Orders DESCO reports as "Not Returnd" are counted as applied: in this
    // history the next recharge in the same month did not pay the fixed charge
    // again, so it had been taken.
    const usable = recharges
        .filter((r) => r.totalAmount > 0 && r.energyAmount > 0)
        .sort((a, b) => a.rechargeDate.localeCompare(b.rechargeDate));

    const vatOnly = usable.filter((r) => r.chargeAmount / r.totalAmount <= VAT_ONLY_MAX_SHARE);
    const share = median(vatOnly.map((r) => r.energyAmount / r.totalAmount));
    const energyShare = share ?? DEFAULT_ENERGY_SHARE;

    // Each recharge that paid fixed charges paid one per month since the
    // previous recharge. Dividing by that count keeps a recharge that followed
    // a skipped month from doubling the estimate of one month's charge.
    const perMonth: number[] = [];
    usable.forEach((r, i) => {
        // DESCO's own charge lines are exact when present; otherwise the
        // charge is what the amount lost beyond VAT and rebate.
        const paid = r.chargeItems?.length
            ? r.chargeItems.reduce((sum, item) => sum + item.amount, 0) / energyShare
            : r.totalAmount - r.energyAmount / energyShare;
        if (paid <= 20) return;

        const previous = usable[i - 1];
        const months = previous
            ? monthsAfter(previous.rechargeDate.slice(0, 7), r.rechargeDate.slice(0, 7)).length
            : 1;
        if (months > 0) perMonth.push(paid / months);
    });

    const last = usable[usable.length - 1];

    return {
        energyShare,
        monthlyChargeBDT: median(perMonth),
        lastRechargeMonth: last ? last.rechargeDate.slice(0, 7) : null,
        derived: share !== null,
    };
}

/**
 * The months whose fixed charge a recharge made in `month` would collect:
 * every month after the last recharge, up to and including `month`.
 */
export function monthsOwed(terms: RechargeTerms, month: string): string[] {
    // With no history the last payment is unknown, so only the recharge's own
    // month is assumed.
    if (!terms.lastRechargeMonth) return [month];
    return monthsAfter(terms.lastRechargeMonth, month);
}

/** Fixed charges, in recharge money, that a recharge made in `month` would pay before any energy. */
export function chargesFor(terms: RechargeTerms, month: string): number {
    return monthsOwed(terms, month).length * (terms.monthlyChargeBDT ?? 0);
}

/** Energy credit a recharge of `amountBDT` made in `month` would add. */
export function creditFor(terms: RechargeTerms, amountBDT: number, month: string): number {
    return Math.max(0, (amountBDT - chargesFor(terms, month)) * terms.energyShare);
}

/** Amount to pay in `month` so that the recharge adds `creditBDT` of energy. */
export function amountFor(terms: RechargeTerms, creditBDT: number, month: string): number {
    return creditBDT / terms.energyShare + chargesFor(terms, month);
}

export interface PendingCharges {
    /** Months (YYYY-MM) whose fixed charge is unpaid and will come out of the next recharge. */
    months: string[];
    /** Their total, in recharge money. A recharge below this buys no power. */
    amountBDT: number;
}

/**
 * Fixed charges the next recharge will collect, from the months without a
 * recharge so far, including the current one. Null when nothing is owed or
 * the charge could not be measured.
 */
export function pendingCharges(terms: RechargeTerms, currentMonth: string): PendingCharges | null {
    if (terms.monthlyChargeBDT === null || !terms.lastRechargeMonth) return null;

    const months = monthsOwed(terms, currentMonth);
    if (months.length === 0) return null;

    return { months, amountBDT: months.length * terms.monthlyChargeBDT };
}

export interface MonthForecast {
    month: string;
    days: number;
    kwh: number;
    costBDT: number;
    /**
     * How much of the month the current balance pays for, and how much is
     * left for a recharge. Stated rather than left to the model: asked how the
     * balance fitted in, it described October's full cost as "the early part
     * of October" that the balance would cover.
     */
    paidByBalanceBDT: number;
    leftForRechargeBDT: number;
}

export interface SpendForecast {
    months: MonthForecast[];
    totalBDT: number;
    /** The day the balance given is used up, or null if it lasts past the end. */
    balanceRunsOutOn: string | null;
}

/** Projected spend from tomorrow through `until`, by month, against a starting balance. */
export function forecastThrough(days: Iterable<DaySpend>, until: string, balance: number): SpendForecast | null {
    const byMonth = new Map<string, MonthForecast>();
    let total = 0;
    let runsOut: string | null = null;
    let reached = false;
    let remaining = Math.max(0, balance);

    for (const day of days) {
        if (day.date > until) {
            reached = true;
            break;
        }
        total += day.cost;
        if (runsOut === null && day.cost > 0 && total >= balance) runsOut = day.date;

        // The balance is spent first, in date order.
        const fromBalance = Math.min(remaining, day.cost);
        remaining -= fromBalance;

        const entry = byMonth.get(day.month) ?? {
            month: day.month, days: 0, kwh: 0, costBDT: 0, paidByBalanceBDT: 0, leftForRechargeBDT: 0,
        };
        if (day.kwh > 0) entry.days += 1;
        entry.kwh += day.kwh;
        entry.costBDT += day.cost;
        entry.paidByBalanceBDT += fromBalance;
        entry.leftForRechargeBDT += day.cost - fromBalance;
        byMonth.set(day.month, entry);
    }

    // The sequence stopped before the date: the tariff could not price a day.
    if (!reached) return null;

    return { months: [...byMonth.values()], totalBDT: total, balanceRunsOutOn: runsOut };
}

/** A stretch of days at one slab within one month, for showing how a balance is spent. */
export interface SpendPhase {
    from: string;
    to: string;
    kwh: number;
    costBDT: number;
    /** Balance left after the phase; zero or less means it ran out in it. */
    balanceAfter: number;
}

export interface RechargeTimeline {
    phases: SpendPhase[];
    /** The balance just before the recharge is added. */
    balanceBeforeRecharge: number;
    /** The day the phases reach when the recharge is added, i.e. the first day it pays for. */
    rechargeBefore: string | null;
    /** The day the balance, recharge included, is used up; null if it lasts past the horizon. */
    runsOutOn: string | null;
    /** The day the balance alone would have been used up, if before the recharge. */
    runsOutBeforeRecharge: string | null;
}

/**
 * Day by day from tomorrow: the balance is spent, the recharge's energy
 * credit is added on `rechargeOn`, and the days are grouped into phases that
 * break at a month, at the recharge, and where the month crosses a slab. The
 * lifeline boundary (50) is not a break: crossing it re-prices the month's
 * earlier units, so the days either side of it are not at two clean rates.
 */
export function rechargeTimeline(
    days: Iterable<DaySpend>,
    balance: number,
    credit: number,
    rechargeOn: string,
    thresholds: number[],
    maxDays = 400
): RechargeTimeline {
    const breaks = thresholds.filter((t) => t > 50);
    const slabOf = (units: number) => breaks.filter((t) => units > t).length;

    let remaining = balance;
    let applied = false;
    let balanceBeforeRecharge = balance;
    let rechargeBefore: string | null = null;
    let runsOutOn: string | null = null;
    let runsOutBeforeRecharge: string | null = null;
    const phases: SpendPhase[] = [];
    let current: SpendPhase | null = null;
    let currentKey = "";
    let count = 0;

    for (const day of days) {
        if (!applied && day.date >= rechargeOn) {
            applied = true;
            balanceBeforeRecharge = remaining;
            rechargeBefore = day.date;
            remaining += credit;
        }

        const key = `${day.month}|${applied}|${slabOf(day.units)}`;
        if (!current || key !== currentKey) {
            current = { from: day.date, to: day.date, kwh: 0, costBDT: 0, balanceAfter: remaining };
            currentKey = key;
            phases.push(current);
        }

        remaining -= day.cost;
        current.to = day.date;
        current.kwh += day.kwh;
        current.costBDT += day.cost;
        current.balanceAfter = remaining;

        if (day.cost > 0 && remaining <= 0) {
            if (applied) {
                runsOutOn = day.date;
                break;
            }
            if (!runsOutBeforeRecharge) runsOutBeforeRecharge = day.date;
        }
        if (++count >= maxDays) break;
    }

    return { phases, balanceBeforeRecharge, rechargeBefore, runsOutOn, runsOutBeforeRecharge };
}

/** The day a balance is used up, reading as many days as it takes. */
export function runsOutOn(days: Iterable<DaySpend>, balance: number, maxDays = 400): string | null {
    let remaining = balance;
    let count = 0;
    for (const day of days) {
        remaining -= day.cost;
        count += 1;
        if (day.cost > 0 && remaining <= 0) return day.date;
        if (count >= maxDays) return null;
    }
    return null;
}
