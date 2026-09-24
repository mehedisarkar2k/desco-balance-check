import { RechargeRecord } from "../desco";
import { DaySpend } from "./runway";

/**
 * How a recharge turns into energy credit, recovered from the customer's own
 * recharge history rather than assumed.
 *
 * Every DESCO recharge seen follows one rule: a fixed share of the amount
 * becomes credit (the rest is VAT, less a rebate), and the first recharge of
 * each month also pays that month's fixed demand charge. On the account this
 * was built against the share was 0.95712 on every recharge and the monthly
 * charge 175.53 BDT in each of twelve months. The charge depends on the
 * connection's sanctioned load, so it is read per account, never hardcoded.
 */
export interface RechargeTerms {
    /** Share of each taka paid that becomes energy credit. */
    energyShare: number;
    /** Fixed monthly charge taken from a month's first recharge; null if never observed. */
    monthlyChargeBDT: number | null;
    /** Months (YYYY-MM) that already have a recharge, so their charge is paid. */
    monthsWithRecharge: Set<string>;
    /** True when energyShare came from this account's history rather than the default. */
    derived: boolean;
}

/**
 * 5% VAT less a 0.5% prepaid rebate, which is what the observed share works
 * out to. Used only when an account has no recharge without a monthly charge
 * to measure it from.
 */
const DEFAULT_ENERGY_SHARE = 1 / 1.045;

/** A recharge whose charges are VAT alone runs at about 4.3%; anything well above carries the monthly charge. */
const VAT_ONLY_MAX_SHARE = 0.06;

function median(values: number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function deriveRechargeTerms(recharges: RechargeRecord[]): RechargeTerms {
    const usable = recharges.filter((r) => r.totalAmount > 0 && r.energyAmount > 0);

    // Orders DESCO reports as "Not Returnd" are counted as applied: in this
    // history the month after one such order recharged again without paying
    // the monthly charge, so it had been taken.
    const monthsWithRecharge = new Set(usable.map((r) => r.rechargeDate.slice(0, 7)));

    const vatOnly = usable.filter((r) => r.chargeAmount / r.totalAmount <= VAT_ONLY_MAX_SHARE);
    const share = median(vatOnly.map((r) => r.energyAmount / r.totalAmount));
    const energyShare = share ?? DEFAULT_ENERGY_SHARE;

    const withCharge = usable
        .filter((r) => r.chargeAmount / r.totalAmount > VAT_ONLY_MAX_SHARE)
        .map((r) => r.totalAmount - r.energyAmount / energyShare)
        .filter((charge) => charge > 20);

    return {
        energyShare,
        monthlyChargeBDT: median(withCharge),
        monthsWithRecharge,
        derived: share !== null,
    };
}

/** Whether a recharge made in `month` would also pay that month's fixed charge. */
export function paysMonthlyCharge(terms: RechargeTerms, month: string): boolean {
    return !terms.monthsWithRecharge.has(month);
}

/** Energy credit a recharge of `amountBDT` made in `month` would add. */
export function creditFor(terms: RechargeTerms, amountBDT: number, month: string): number {
    const charge = paysMonthlyCharge(terms, month) ? terms.monthlyChargeBDT ?? 0 : 0;
    return Math.max(0, (amountBDT - charge) * terms.energyShare);
}

/** Amount to pay in `month` so that the recharge adds `creditBDT` of energy. */
export function amountFor(terms: RechargeTerms, creditBDT: number, month: string): number {
    const charge = paysMonthlyCharge(terms, month) ? terms.monthlyChargeBDT ?? 0 : 0;
    return creditBDT / terms.energyShare + charge;
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
        if (runsOut === null && total >= balance) runsOut = day.date;

        // The balance is spent first, in date order.
        const fromBalance = Math.min(remaining, day.cost);
        remaining -= fromBalance;

        const entry = byMonth.get(day.month) ?? {
            month: day.month, days: 0, kwh: 0, costBDT: 0, paidByBalanceBDT: 0, leftForRechargeBDT: 0,
        };
        entry.days += 1;
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

/** The day a balance is used up, reading as many days as it takes. */
export function runsOutOn(days: Iterable<DaySpend>, balance: number, maxDays = 400): string | null {
    let remaining = balance;
    let count = 0;
    for (const day of days) {
        remaining -= day.cost;
        count += 1;
        if (remaining <= 0) return day.date;
        if (count >= maxDays) return null;
    }
    return null;
}
